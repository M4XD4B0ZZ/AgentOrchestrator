/**
 * The delivery command's step ladders: one act each, and the only place the
 * three delivery authorities are minted.
 *
 * ── Why this is a module of its own ────────────────────────────────────────
 *
 * These ladders were the body of `cli/delivery-command.ts` until V4 slice 11,
 * which needed a second caller for them: `delivery-driver.ts` derives which
 * acts a delivery still needs and invokes exactly those. Copying the ladders
 * would have been copying the mints with them, and the mints are the whole of
 * the authority — `tests/v4-05-delivery-head-publication.test.ts` proves by a
 * tree walk that exactly one module in `src/` *calls* each of the three. So
 * they moved here instead, unchanged, and both callers come through them.
 *
 * The two structural properties that moved with the code, and did not change:
 *
 *  - **this file is the only minter.** `mintHeadPublicationGrant`,
 *    `mintPullRequestCreationGrant` and `mintMergeGrant` are called here and
 *    nowhere else in `src/`, which is what makes "the only way to obtain the
 *    authority is to come through the ladder" a fact about the tree rather than
 *    a convention;
 *  - **this file is the only lease acquirer on the delivery surface**, once,
 *    released in a `finally`, for the one act that starts a process from the
 *    repository under test. Nothing under `src/deliver/` acquires one at all.
 *
 * Both are measured — see 'imports the mint in exactly one module of the whole
 * source tree' in `tests/v4-05-delivery-head-publication.test.ts` and 'takes the
 * execution lease in exactly one place, for exactly one act' in
 * `tests/v4-09-post-merge-verification.test.ts`.
 *
 * ── What did not move ──────────────────────────────────────────────────────
 *
 * `performRecording` stayed in the command. It is slice 3's audit path, it is
 * reached by `--record` alone, and no driver consults it: a historical
 * observation is evidence for a person and is never an input to an authority.
 */

import {
  attestDeliveryObservation,
  concludeObservation,
  observeDelivery,
  resolveObservationSubject,
  type DeliveryObservation,
  type SubjectResolution,
} from '../deliver/observe-delivery.js';
import { loadDeliveryEvidence, type IgnoreVerdict } from '../deliver/delivery-evidence-store.js';
import {
  concludeDeliveryDecision, isPositiveDeliveryDecision, revalidateSubject, type DeliveryDecision, type LocalSubject, type SubjectRevalidation } from '../deliver/delivery-decision.js';
import type { DeliveryObservationProof } from '../deliver/delivery-observation-proof.js';
import { PUBLISHABLE_REF, mintHeadPublicationGrant, type HeadPublicationSubject } from '../deliver/internal/head-publication-grant.js';
import {
  loadDeliveryAutomation,
  permitsUnattendedHeadPublication,
  type DeliveryAutomationOutcome,
} from '../deliver/delivery-automation.js';
import {
  newHeadPublicationAuditEventId,
  recordHeadPublicationAuthorisation,
} from '../deliver/head-publication-authorisation-store.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { publishDeliveryHead, type PublicationResult } from '../deliver/publish-delivery-head.js';
import type { GitPublicationRunner } from '../deliver/git-head-publisher.js';
import type { HeadPublication } from '../deliver/head-publication.js';
import { isSendableBranchName, mintPullRequestCreationGrant, type PullRequestCreationSubject } from '../deliver/internal/pull-request-creation-grant.js';
import { createPullRequest, type CreationResult } from '../deliver/create-pull-request.js';
import type { PullRequestCreation } from '../deliver/pull-request-creation.js';
import { AO_PULL_REQUEST_DRAFT, composePullRequestContent } from '../deliver/pull-request-content.js';
import { createForgeMutationRunner, type ForgeMutationRunner } from '../deliver/github-pull-request-creator.js';
import { DELIVERY_MERGE_METHOD, mintMergeGrant, type MergeSubject } from '../deliver/internal/merge-grant.js';
import { mergePullRequest, type MergeResult } from '../deliver/merge-pull-request.js';
import { observeMergeForDelivery, refuseMergeObservation, type MergeObservationResult } from '../deliver/reconcile-merge.js';
import { recordMergeReconciliation } from '../deliver/merge-reconciliation-store.js';
import { loadMergeReconciliation } from '../deliver/merge-reconciliation-store.js';
import { verifyMergeForDelivery, refuseMergeVerification, refuseMergeVerificationUnleased, type MergeVerificationResult } from '../deliver/verify-merge.js';
import { recordPostMergeVerification, type PostMergeVerificationRecordResult } from '../deliver/post-merge-verification-store.js';
import { concludeDeliveryForTask, refuseDeliveryConclusion, type DeliveryConclusionResult } from '../deliver/conclude-delivery.js';
import { recordDeliveryConclusion } from '../deliver/delivery-conclusion-store.js';
import { acquireRepositoryExecutionLease, releaseRepositoryExecutionLease, type LeaseReleaseResult } from '../lease/execution-lease.js';
import { leasedGit, leasedVerify } from '../loop/leased-spawns.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import { createForgeMergeRunner, type ForgeMergeRunner } from '../deliver/github-pull-request-merger.js';
import type { MergeOutcome } from '../deliver/pull-request-merge.js';
import { deliveryObservationFactsOf } from '../deliver/delivery-observation-proof.js';
import { runGitCommand, type GitRunner } from '../worktree/git-command.js';
import { askRuntimeIgnored } from '../state/runtime-ignored.js';
import { createForgeCommandRunner, type ForgeCommandRunner } from '../deliver/github-observer.js';
import { resolveRepository, type ResolvedRepository } from '../repo/resolve-repository.js';
import { loadTaskState } from '../state/state-store.js';
import type { DeliveryConclusionView, ReconciliationView, VerificationView } from './render-delivery-observation.js';

export interface DeliveryOptions {
  readonly repository: string;
  readonly task: string;
  readonly observe?: boolean;
  readonly record?: boolean;
  readonly decide?: boolean;
  readonly publishHead?: boolean;
  readonly createPr?: boolean;
  readonly mergePr?: boolean;
  readonly reconcileMerge?: boolean;
  readonly verifyMerge?: boolean;
  readonly concludeDelivery?: boolean;
  readonly drive?: boolean;
  readonly attended?: boolean;
  /**
   * The other grant for the publication act: nobody is present for it.
   *
   * A field of its own rather than the absence of {@link attended}, because
   * absence is not authority. `delivery-command.ts` refuses the two together
   * before a repository is resolved, so the pair is never both true here.
   */
  readonly automaticPublishHeadOnly?: boolean;
}

/**
 * Injection points, in the same shape `run` uses.
 *
 * `runner` exists so the whole surface can be exercised without a network and
 * without a GitHub login — the canonical suite must stay deterministic on a
 * machine that has never run `gh auth login`, and CI has no credentials at all.
 */
export interface DeliveryCommandSeams {
  readonly resolveRepository?: typeof resolveRepository;
  readonly loadTaskState?: typeof loadTaskState;
  readonly runner?: ForgeCommandRunner;
  readonly envSource?: NodeJS.ProcessEnv;
  /**
   * The clock the record's instants come from.
   *
   * Injectable because `observedAt` is the one field a test has to be able to
   * pin, and because the assertion that matters about it — that a recent one
   * establishes nothing — is only checkable if a test can choose it.
   */
  readonly now?: () => Date;
  /** Asks Git whether one repository-relative path is ignored. */
  readonly checkIgnored?: (relativePath: string) => Promise<IgnoreVerdict>;
  /**
   * The runner the two publication vectors go through.
   *
   * Separate from {@link DeliveryCommandSeams.runner}, which is the forge client
   * seam, because these are Git and that one is the GitHub CLI. Keeping them
   * apart means a test that stubs reading cannot accidentally stub writing, and
   * a build that stubbed one would still have to say so about the other.
   */
  readonly publicationRunner?: GitPublicationRunner;
  /**
   * The runner the one pull-request creation vector goes through.
   *
   * A third seam, and not a widening of either of the other two. `runner` reads
   * a forge, `publicationRunner` writes a Git ref, and this one writes to a
   * forge. Each of the three is a different thing to be allowed to do, so a
   * test that stubs one cannot silently stand in for another — the argument
   * slice 5 made when it refused to reuse the observation seam for its push.
   */
  readonly creationRunner?: ForgeMutationRunner;
  /**
   * The runner the one merge vector goes through.
   *
   * A fourth seam, for the reason the third one exists. `runner` reads a forge,
   * `publicationRunner` writes a Git ref, `creationRunner` opens a pull request
   * and this one merges one. Four acts, four seams: a fixture that stubs
   * opening a pull request must not be able to stand in for one that merges it,
   * and after this slice that difference is the difference between a request
   * and the base branch.
   */
  readonly mergeRunner?: ForgeMergeRunner;
  /**
   * The runner the one verification vector goes through.
   *
   * A fifth seam, and the first that is not about a forge or a ref at all: it
   * starts the repository's own declared commands. Kept separate for the reason
   * the other four are — a fixture that stubs reading github.com must not be
   * able to stand in for one that runs a build, and after this slice that
   * difference is the difference between a question and a process.
   *
   * Production never supplies one. Absent, the verification path builds its
   * runner from `leasedVerify` against the lease it has just taken.
   */
  readonly verify?: VerificationRunner;
  /** The Git runner the default ignore probe uses. */
  readonly git?: GitRunner;
  /**
   * Where the OS says this user's profile directory is.
   *
   * The one seam on the unattended-publication declaration, and it is the
   * *directory* rather than the declaration: a test that could hand in a
   * permission would be a test of nothing, because handing in a permission is
   * exactly what this build refuses to let anything do. A test points this at a
   * scratch directory and writes a real file into it, so the reader, the size
   * ceiling, the YAML boundary and the contract are all really exercised.
   *
   * Production never supplies one. Absent, the loader asks `os.userInfo()`.
   */
  readonly pathProvider?: PathProvider;
}

/**
 * The production ignore probe: the shared `check-ignore` question, bound to one
 * repository.
 *
 * `state/runtime-ignored.ts` owns what "is this path ignored" means, and this
 * is a partial application of it rather than a second implementation. A second
 * one would be a second opinion about Git's own rules, which is exactly what
 * that module's header refuses.
 */
export function createRuntimeIgnoreProbe(
  repositoryRoot: string,
  git: GitRunner = runGitCommand,
): (relativePath: string) => Promise<IgnoreVerdict> {
  return (relativePath) => askRuntimeIgnored(git, repositoryRoot, relativePath);
}

/**
 * The authority answer: which of the two grants permitted this act, and — for
 * the one that read a file — which bytes said so.
 *
 * Three shapes rather than an answer with an optional half, and the difference
 * is load-bearing. `OPERATOR_DECLARATION` **carries** the digest, so an
 * authority graded from a declaration cannot be constructed without naming the
 * bytes it was graded from; the compiler refuses the shape that would let an
 * unattended publication proceed with nothing to record. That is what makes the
 * gate below a fact rather than a check somebody could remove.
 *
 * The digest is carried out of the grading rather than read again, because a
 * second read is a second file: it has to be of the exact bytes that produced
 * *this* permission, or the record would name a document that never authorised
 * anything.
 */
type PublicationAuthority =
  | { readonly outcome: 'AUTHORISED'; readonly grant: 'OPERATOR_PRESENT' }
  | {
      readonly outcome: 'AUTHORISED';
      readonly grant: 'OPERATOR_DECLARATION';
      /** SHA-256 of the exact declaration bytes this grading read. */
      readonly declarationDigest: string;
    }
  | { readonly outcome: HeadPublication };

/** The attended grant. Constant, and it reads nothing at all. */
const AUTHORISED_WITH_AN_OPERATOR: PublicationAuthority = Object.freeze({
  outcome: 'AUTHORISED' as const,
  grant: 'OPERATOR_PRESENT' as const,
});

const authorityRefused = (outcome: HeadPublication): PublicationAuthority =>
  Object.freeze({ outcome });

/**
 * The two grants that permit one head publication, and everything that is not
 * one of them.
 *
 * `'AUTHORISED'` or the member the ladder refuses with. A discriminated answer
 * rather than a boolean, because the four refusals send an operator to four
 * different places and a boolean would have thrown that away at the one gate
 * where it matters most.
 *
 * ── Why the attended arm answers first ────────────────────────────────────
 *
 * So that an attended publication never reads the declaration file at all. A
 * declaration that is missing, unreadable, malformed or says `ATTENDED_ONLY`
 * cannot refuse an operator who is standing there, and V4 slice 5's path is
 * therefore unchanged in every observable way — which is asserted rather than
 * assumed.
 *
 * ── Why absence of the automatic flag is `OPERATOR_ABSENT` ────────────────
 *
 * Because it is the pre-slice-13 meaning, unchanged: the operator asked for a
 * mutation and named no grant for it. The automatic grant has to be *named*.
 * There is no arm here that reads a permitting declaration and lets an
 * invocation that did not ask for automatic publication proceed, which is the
 * whole of "capability is not permission" in one function: the operator's
 * standing decision and this invocation's intent are conjoined, and neither can
 * stand in for the other.
 *
 * ── Why the declaration is read here and not passed in ────────────────────
 *
 * A caller that could hand in a permission would be a caller authorising
 * itself, which is the argument `scope/assess-scope.ts` makes about a scope
 * declaration and `pinned-scope.ts` about where to read one. What a caller may
 * supply is where the operating system's user profile is, and only through the
 * internal test seam.
 */
function resolvePublicationAuthority(
  options: DeliveryOptions,
  target: { readonly host: string; readonly owner: string; readonly name: string },
  seams: DeliveryCommandSeams,
): PublicationAuthority {
  if (options.attended === true) return AUTHORISED_WITH_AN_OPERATOR;
  if (options.automaticPublishHeadOnly !== true) return authorityRefused('OPERATOR_ABSENT');

  const declaration: DeliveryAutomationOutcome = loadDeliveryAutomation(
    seams.pathProvider ?? OS_PATH_PROVIDER,
  );
  // An exhaustive switch over the permission vocabulary, so a member added to
  // it is a compile error here rather than an arm that falls through to one of
  // the answers below — and the one it would fall through to is the one that
  // publishes.
  switch (permitsUnattendedHeadPublication(declaration, target)) {
    case 'ALLOWED':
      // `ALLOWED` is only ever produced from a `DECLARED` outcome — the grader
      // answers `UNREADABLE` for an unusable declaration and `NOT_DECLARED` for
      // every other shape — so this narrowing cannot fail. It is written as a
      // refusal rather than as an assertion because the one thing that must not
      // happen is an unattended publication whose record cannot name the bytes
      // it was permitted by.
      if (declaration.state !== 'DECLARED') return authorityRefused('PUBLICATION_POLICY_UNREADABLE');
      return Object.freeze({
        outcome: 'AUTHORISED' as const,
        grant: 'OPERATOR_DECLARATION' as const,
        declarationDigest: declaration.declarationDigest,
      });
    case 'NOT_DECLARED':
      return authorityRefused('AUTOMATIC_PUBLICATION_NOT_DECLARED');
    case 'DENIED':
      return authorityRefused('AUTOMATIC_PUBLICATION_DENIED');
    case 'UNREADABLE':
      return authorityRefused('PUBLICATION_POLICY_UNREADABLE');
  }
}

/**
 * Decides whether one delivery head may be published, and publishes it.
 *
 * The refusal ladder here is the one `HEAD_PUBLICATIONS` declares, in the same
 * order, and that is checked rather than asserted: the suite drives every arm
 * and pins which member comes out. The refusals divide into those about the
 * work and those about the invocation's authority, and the work is answered
 * first — an operator whose task is not finished is told that, rather than
 * being told to pass a flag that would not have helped. The count that used to
 * stand in this sentence went stale at V4 slice 13, which added three authority
 * members, so the rule is stated instead of the tally.
 *
 * Two grants reach the mint, and only two: an operator present for this
 * invocation, or this machine's operator having declared, outside every
 * repository, that this exact delivery target may be published with nobody
 * present. {@link resolvePublicationAuthority} is where that is decided and it
 * is decided once — and then again, against a freshly resolved identity, at the
 * last point this build reads anything of its own before the remote is
 * contacted. Not "immediately before": `publishDeliveryHead` asks Git for the
 * remote's two URLs and then reads the ref itself after that, and the second of
 * those is a network round trip. `L-V4-13-4`.
 *
 * The mint is called here and nowhere else. That is the reachability property
 * the whole authority rests on: a tree walk in the suite proves exactly one
 * module in `src/` *calls* `mintHeadPublicationGrant`, so "the only way to
 * obtain the authority is to come through this ladder" is a fact about the tree
 * rather than a convention. (The same walk pins which modules may *import* the
 * declaring one, and that number is three, not one. This sentence said "one
 * imports" until a review counted them — the test beside it always asserted
 * three.)
 *
 * V4 slice 14 adds one step to the automatic path and to no other: inside that
 * same `recheck`, strictly after the permission has been re-proved and strictly
 * before anything is contacted, the invocation writes and reads back a durable
 * record of what it was permitted by and what it was about to act on. A record
 * that cannot be established refuses the publication, through the closure's own
 * refusal channel, with nothing read from the remote. The attended path does not
 * reach it: the gate is which grant answered, and the attended one is a constant
 * that carries no declaration to record.
 *
 * Note what is *not* passed to the mint: nothing derived from the task's title,
 * brief, findings or any other repository-authored prose. The grant carries six
 * fields, all of them identities or object names, and the push vector can only
 * carry what the grant holds — so no repository-controlled text can reach the
 * network by this path, and no filtering step has to remember to run.
 */
export async function performPublication(
  options: DeliveryOptions,
  repositoryRoot: string,
  subject: ReturnType<typeof resolveObservationSubject>,
  taskLoad: ReturnType<typeof loadTaskState>,
  resolve: typeof resolveRepository,
  load: typeof loadTaskState,
  seams: DeliveryCommandSeams,
): Promise<PublicationResult> {
  const refused = (publication: HeadPublication): PublicationResult =>
    Object.freeze({
      publication,
      before: null,
      attempt: 'NOT_ATTEMPTED' as const,
      after: null,
    });

  if (!subject.ok || !taskLoad.ok) return refused('SUBJECT_NOT_ESTABLISHED');
  if (taskLoad.state.state !== 'READY_FOR_PR') return refused('TASK_NOT_READY');
  // The invocation fact, in the position the invocation fact has always had:
  // after both facts about the work, so an operator whose task is not finished
  // is told that rather than told to pass a flag that would not have helped.
  // What changed at V4 slice 13 is what this step asks, not where it sits.
  const authority = resolvePublicationAuthority(options, subject.subject, seams);
  if (authority.outcome !== 'AUTHORISED') return refused(authority.outcome);

  const intended = publishableRef(taskLoad.state.workBranch);
  if (intended === null) return refused('SUBJECT_NOT_ESTABLISHED');

  const now = seams.now ?? ((): Date => new Date());

  const grant = mintHeadPublicationGrant(subject.subject, subject.remoteName, intended);
  // The mint refuses a remote name, ref or object name it will not put in an
  // argument vector. Reported as an unestablished subject rather than as its
  // own member: from an operator's side there is no difference between "there
  // is no publishable subject" and "the subject there is, is not publishable",
  // and inventing a second word would imply this build could tell them how to
  // fix it, which it cannot without naming the value it refused.
  if (grant === null) return refused('SUBJECT_NOT_ESTABLISHED');

  // Why the closure below refused, when it did. Written there and read once,
  // after `publishDeliveryHead` has returned.
  //
  // One variable for two reasons, because they cannot both happen: the record is
  // written only after the re-proof answered `AUTHORISED`, and the withdrawal is
  // recorded only when it did not. Two variables would be two states this
  // function would then have to rank.
  let recheckRefusal: HeadPublication | null = null;

  const published = await publishDeliveryHead(grant, repositoryRoot, {
    runner: seams.publicationRunner,
    // A second, independent pass through the whole resolution — repository,
    // task record, subject, work branch — for the reason
    // `revalidateLocalSubject` gives: the point is to ask the world, because
    // what may have moved is the world. Unlike that one, this runs *before* the
    // effect, because afterwards there would be nothing useful to do with the
    // answer.
    recheck: async (): Promise<HeadPublicationSubject | null> => {
      const again = await resolve({ repositoryPath: options.repository });
      if (!again.ok) return null;
      const reloaded = load(again.repository.root, options.task);
      if (!reloaded.ok) return null;
      if (reloaded.state.state !== 'READY_FOR_PR') return null;
      const rebuilt = resolveObservationSubject(again.repository.delivery, reloaded);
      if (!rebuilt.ok) return null;
      const ref = publishableRef(reloaded.state.workBranch);
      if (ref === null) return null;
      // The authority again, against the identity *this* pass resolved rather
      // than the one the ladder resolved a moment ago. `recheck` is the last
      // point at which this build reads anything of its own — two `git remote
      // get-url` calls and one `ls-remote` follow it — so this is where a
      // permission that stopped standing is caught: an operator who edited the
      // declaration is answered here with nothing sent.
      //
      // It is a second reading and not a cached one. On the attended path it is
      // the same constant-time arm the ladder took and reads no file at all.
      const still = resolvePublicationAuthority(options, rebuilt.subject, seams);
      if (still.outcome !== 'AUTHORISED') {
        // …and the refusal is only *reported as* a withdrawal when this pass
        // resolved the same repository the ladder did. A task re-pinned onto
        // another delivery target also fails this grading — correctly, because
        // nobody declared anything about the repository now in front of it —
        // but the honest answer there is that the subject moved, which is what
        // `publishDeliveryHead` will say on its own. Reporting "this operator
        // declared nothing about this repository" for a run whose repository
        // changed underneath it would be a true sentence about the wrong event.
        if (
          rebuilt.subject.host === subject.subject.host &&
          rebuilt.subject.owner === subject.subject.owner &&
          rebuilt.subject.name === subject.subject.name
        ) {
          recheckRefusal = still.outcome;
        }
        return null;
      }

      // ── The accountability precondition, and the only place it is one ─────
      //
      // An unattended publication is the one act this build performs with
      // nobody watching, so before it contacts the delivery remote at all it
      // writes down what it was permitted by and what it was about to act on —
      // and reads that back off the disk. A record that could not be written is
      // a publication that does not happen.
      //
      // Here, and not earlier: this is strictly after the permission has been
      // re-proved against the identity *this* pass resolved, so the record names
      // the declaration the act really stands on rather than one the ladder read
      // a moment ago. And not later, because everything after this closure is
      // either a question put to Git or the effect itself.
      //
      // The gate is which grant answered, not the flag. `OPERATOR_DECLARATION`
      // is the arm that read a declaration, so the attended path cannot reach
      // this by any spelling — and the two cannot drift apart, because there is
      // only one place that decides which arm ran. The digest comes with the
      // answer rather than being looked up beside it, which is why there is no
      // shape here that could publish with nothing to write down.
      //
      // What this does NOT do is narrow `L-V4-13-4`. Two `git remote get-url`
      // calls and one `ls-remote` — a network round trip with a two-minute
      // ceiling — still run between this record and the push, and nothing is
      // consulted inside that window. The record's claim is bounded to match:
      // it says what was established before anything was contacted, and it does
      // not say that a publication was attempted.
      if (still.grant === 'OPERATOR_DECLARATION') {
        const at = now();
        const recorded = recordHeadPublicationAuthorisation({
          eventId: newHeadPublicationAuditEventId(at),
          taskId: options.task,
          // This pass's root, like every other fact here. A record filed under
          // the root the ladder resolved would name a repository this closure
          // did not look at.
          repositoryRoot: again.repository.root,
          host: rebuilt.subject.host,
          owner: rebuilt.subject.owner,
          name: rebuilt.subject.name,
          declaredRemote: rebuilt.remoteName,
          ref,
          commit: rebuilt.subject.commit,
          declarationDigest: still.declarationDigest,
          authorisedAt: at.toISOString(),
          ...(seams.pathProvider === undefined ? {} : { pathProvider: seams.pathProvider }),
        });
        if (recorded.code !== 'RECORDED') {
          recheckRefusal = 'PUBLICATION_AUDIT_UNWRITTEN';
          return null;
        }
      }

      return Object.freeze({
        host: rebuilt.subject.host,
        owner: rebuilt.subject.owner,
        name: rebuilt.subject.name,
        remoteName: rebuilt.remoteName,
        ref,
        commit: rebuilt.subject.commit,
      });
    },
  });

  // `publishDeliveryHead` is not taught what a declaration is, and is not
  // changed by this slice at all. It grades a `recheck` that answered `null` as
  // `SUBJECT_CHANGED` — true about the subject, and silent about why. Naming the
  // reason is this function's business because this function is where the
  // authority lives.
  //
  // The rename is guarded three ways and each is load-bearing: only on that
  // exact member, only when the closure above actually recorded a reason, and
  // only into a member that asserts the same thing `SUBJECT_CHANGED` does —
  // nothing read from the remote and nothing attempted. That last part is a
  // property of the ladder rather than a hope: `recheck` runs second, before the
  // URL agreement, before the pre-reading and before the push, so a result
  // carrying this member cannot describe an effect. A member that could describe
  // one would be renamed here into a refusal, which is the one direction that
  // must never happen.
  //
  // Two members arrive this way now. A permission that stopped standing between
  // the ladder's reading and the re-proof, and — V4 slice 14 — an accountability
  // record that could not be written before an unattended publication. Both
  // satisfy the guard's third condition for the same structural reason, and the
  // second one is why the guard is worth restating rather than trusting: a
  // record written *after* the remote had been contacted could not be renamed
  // into a refusal at all.
  const reason: HeadPublication | null = recheckRefusal;
  if (reason !== null && published.publication === 'SUBJECT_CHANGED') return refused(reason);
  return published;
}

/**
 * The decisions this invocation may take the creation ladder on, and the one of
 * them that can end in a request.
 *
 * ── Why this is a set and not the single member ───────────────────────────
 *
 * It was `decision === 'PULL_REQUEST_REQUIRED'`, and a review measured what
 * that produces: **`ALREADY_EXISTS` became unreachable from the command.**
 * `decideDelivery` answers `PULL_REQUEST_REQUIRED` only while *no* open pull
 * request has this head, so the moment one exists — the moment after a
 * successful creation — the second invocation decides `CHECKS_PENDING`,
 * `CHECKS_ABSENT` or `PULL_REQUEST_MATCHED_CHECKS_SUCCESS` and the ladder
 * refused `DECISION_NOT_ESTABLISHED`, whose sentence advises passing the two
 * flags the operator had just passed. Three operator-facing texts said the
 * opposite, including the registered help. `WRONG_BASE_CONFLICT`,
 * `DRAFT_STATE_CONFLICT` and the pre-attempt `PULL_REQUEST_AMBIGUOUS` were
 * unreachable for the same reason — the three conflict answers that matter
 * most.
 *
 * So the set admits every decision that means *this invocation freshly observed
 * this exact commit's pull-request situation and found no failing check*. Four
 * of the five say a pull request already claims this head, and on those the
 * ladder's own fresh reading normally answers and sends nothing.
 *
 * "Normally", not "always", and the difference is the point. The rule is that a
 * request fires **only** when the fresh reading says `NONE`; it is not that a
 * request never fires on those four. If the pull request the decision saw has
 * gone in the moment between, the reading is the newer fact and sending is
 * correct. A review found this paragraph asserting the unconditional version,
 * which the sentence below then contradicts by saying the decision is one
 * observation older.
 *
 * ── What is deliberately not in it ────────────────────────────────────────
 *
 * `CHECKS_FAILED`, which is `L-V4-06-4`: a red commit gets no pull request from
 * this build. And every decision that means no fresh, subject-matched
 * observation exists at all — `SUBJECT_NOT_ESTABLISHED`, `NOT_DECIDED`,
 * `OBSERVATION_UNSETTLED`, `SUBJECT_CHANGED`, `SUBJECT_REVALIDATION_FAILED`.
 * Those are the ones `DECISION_NOT_ESTABLISHED` is honestly about.
 *
 * Written as a set rather than as a chain of comparisons so there is one place
 * to read it from. What pins it is the suite's enumerated equality against
 * these five names — a sixth member added here fails that, and a member added
 * to `DELIVERY_DECISIONS` is simply not admitted, which is the fail-closed
 * direction. Two "partition" assertions were tried beside it and both were
 * tautologies of the form `filter(p) + filter(!p)`; they are gone, and this
 * sentence no longer cites them.
 */
export const ADMITS_CREATION_LADDER: ReadonlySet<DeliveryDecision> = Object.freeze(
  new Set<DeliveryDecision>([
    'PULL_REQUEST_REQUIRED',
    'PULL_REQUEST_AMBIGUOUS',
    'CHECKS_PENDING',
    'CHECKS_ABSENT',
    'PULL_REQUEST_MATCHED_CHECKS_SUCCESS',
  ]),
) as ReadonlySet<DeliveryDecision>;

/**
 * Decides whether one pull request may be created, and creates it.
 *
 * The refusal ladder here is the one `PULL_REQUEST_CREATIONS` declares, in the
 * same order, and that is checked rather than asserted: the suite drives every
 * arm and pins which member comes out. Two of the four refusals are about the
 * work and two are about the invocation, and the work is answered first — an
 * operator whose task is not finished is told that, rather than being told to
 * pass a flag that would not have helped.
 *
 * ── Why the decision is a gate here and not inside the creator ────────────
 *
 * A delivery decision is a *finding* about the forge, produced by `--decide`
 * from this invocation's own answers. It is checked in this module because this
 * is where the invocation's answers exist: the creator takes a grant and
 * re-derives everything else for itself, and handing it a decision to trust
 * would be handing it a fact it could not check.
 *
 * What the decision gates is the *mint*, and the mint gates the act — but the
 * gate is {@link ADMITS_CREATION_LADDER} rather than the single member
 * `PULL_REQUEST_REQUIRED`, for the measured reason set out there. Only that one
 * member means a pull request is *needed*; the other four mean one claimed this
 * head at the moment of the observation. The rule on all five is the same, and
 * wherever it appears it is this one: **a request is issued only when the
 * ladder's own fresh reading says `NONE`.** That is a stronger statement than any decision could
 * make, because the decision is one observation older — so on those four a
 * request normally is not sent, and if the pull request has gone in between,
 * sending is correct.
 *
 * The gate is deliberately strict about provenance rather than about wording.
 * `decision` here is `null` unless `--decide` was passed, and `--decide` is
 * itself refused without `--observe`, so a run that consults nothing cannot
 * reach the mint. A record read back from `loadDeliveryEvidence` has no path
 * into this function at all — slice 3's store is read for the report and is
 * never an input to any authority.
 *
 * The mint is called here and nowhere else, and that is the reachability
 * property the whole authority rests on. What the suite's tree walk proves is
 * the two halves separately: four modules in `src/` may *import*
 * `internal/pull-request-creation-grant.js` — this one, the facade, the creator
 * and the transport, three of them for the subject type — and exactly one of
 * them *calls* `mintPullRequestCreationGrant`. A review found this sentence
 * claiming the first number was one, which the test beside it disproves.
 *
 * Note what *is* passed to the mint that slice 5's never took: text. The title
 * and body are composed by `composePullRequestContent` from the task id, the
 * two branch names and the object name, and nothing else — no task title (the
 * state record has none), no brief, no findings, no diff, no log, no path. The
 * grant binds the exact bytes, and the request can carry only what the grant
 * holds, so the egress is bounded by the artefact rather than by a filter
 * somebody has to remember to run.
 */
export async function performCreation(
  options: DeliveryOptions,
  repositoryRoot: string,
  subject: ReturnType<typeof resolveObservationSubject>,
  taskLoad: ReturnType<typeof loadTaskState>,
  decision: DeliveryDecision | null,
  resolve: typeof resolveRepository,
  load: typeof loadTaskState,
  seams: DeliveryCommandSeams,
): Promise<{
  readonly result: CreationResult;
  readonly headRef: string | null;
  readonly baseRef: string | null;
  readonly draft: boolean | null;
}> {
  // Both are `null` unless a *subject* was established as well as a task
  // record, and that gate is not cosmetic: a review found the report printing
  // `Intended : refs/heads/x -> main` directly under the sentence "There is no
  // delivery target, exact commit, publishable head ref and base branch to be
  // about", because these were computed from `taskLoad` alone. The view's own
  // type documents them as null on a refusal that never got as far as having an
  // intended pull request, so the computation has to agree with it.
  const established = subject.ok && taskLoad.ok;
  // The same predicate the mint sends with, not the looser character class.
  // They were different for one commit and a review measured the cost: a task
  // with `baseBranch: 'a..b'` passed this arm, so a run without `--attended`
  // was answered `OPERATOR_ABSENT` — "Pass --attended to create." — for a
  // delivery the mint would refuse whatever the operator then passed. The
  // ladder's first arm has to refuse everything the last one will.
  const intendedHead =
    established && isSendableBranchName(taskLoad.state.workBranch)
      ? publishableRef(taskLoad.state.workBranch)
      : null;
  const intendedBase =
    established && isSendableBranchName(taskLoad.state.baseBranch)
      ? taskLoad.state.baseBranch
      : null;

  const refused = (creation: PullRequestCreation) =>
    Object.freeze({
      result: Object.freeze({
        creation,
        remoteHead: null,
        before: null,
        attempt: 'NOT_ATTEMPTED' as const,
        after: null,
      }),
      headRef: intendedHead,
      baseRef: intendedBase,
      draft: null,
    });

  // The two subject arms come first, together, and that is a correction. The
  // grammar half used to sit fifth, behind `--attended` and the decision, so a
  // task whose branch or base this build will not send was told "Pass
  // --attended to create." — advice that could not have helped, which is the
  // exact failure the ladder's own docstring claims the order avoids.
  if (!subject.ok || !taskLoad.ok) return refused('SUBJECT_NOT_ESTABLISHED');
  if (intendedHead === null || intendedBase === null) return refused('SUBJECT_NOT_ESTABLISHED');
  if (taskLoad.state.state !== 'READY_FOR_PR') return refused('TASK_NOT_READY');
  if (options.attended !== true) return refused('OPERATOR_ABSENT');
  if (decision === null || !ADMITS_CREATION_LADDER.has(decision)) {
    return refused('DECISION_NOT_ESTABLISHED');
  }

  const intent = buildCreationIntent(
    taskLoad.state.taskId,
    subject.remoteName,
    intendedHead,
    intendedBase,
    subject.subject.commit,
  );
  const grant = mintPullRequestCreationGrant(subject.subject, intent);
  // The mint refuses anything it will not send or will not put in a local Git
  // argument vector. Reported as an unestablished subject rather than as its
  // own member, for the reason `performPublication` gives: from an operator's
  // side there is no difference between "there is no pull request to be about"
  // and "the one there would be, is not one this build will ask for".
  //
  // And it carries NO intended pull request, which the shared `refused` helper
  // would. The mint refuses for conditions the two checks above do not cover —
  // a work branch equal to the base, a task id outside the grammar, a remote
  // name that is not bare — and on those the helper printed a concrete head and
  // base under the sentence saying there is none. A review found the first fix
  // for this closing two arms of three.
  if (grant === null) {
    return Object.freeze({
      result: Object.freeze({
        creation: 'SUBJECT_NOT_ESTABLISHED' as const,
        remoteHead: null,
        before: null,
        attempt: 'NOT_ATTEMPTED' as const,
        after: null,
      }),
      headRef: null,
      baseRef: null,
      draft: null,
    });
  }

  const result = await createPullRequest(grant, repositoryRoot, {
    reader: seams.runner ?? createForgeCommandRunner(),
    mutator: seams.creationRunner ?? createForgeMutationRunner(),
    envSource: seams.envSource ?? process.env,
    gitRunner: seams.publicationRunner,
    // A second, independent pass through the whole resolution — repository,
    // task record, subject, branches, content — for the reason
    // `revalidateLocalSubject` gives: the point is to ask the world, because
    // what may have moved is the world. It runs *before* the effect, because
    // afterwards there would be nothing useful to do with the answer.
    recheck: async (): Promise<PullRequestCreationSubject | null> => {
      const again = await resolve({ repositoryPath: options.repository });
      if (!again.ok) return null;
      const reloaded = load(again.repository.root, options.task);
      if (!reloaded.ok) return null;
      if (reloaded.state.state !== 'READY_FOR_PR') return null;
      const rebuilt = resolveObservationSubject(again.repository.delivery, reloaded);
      if (!rebuilt.ok) return null;
      // The strict grammar on both names here too. A divergent head would
      // reach `SUBJECT_CHANGED` a moment later through `sameSubject`, so this
      // is a floor — but a commit whose stated rule is "two arms, two names,
      // one rule" should not leave the third pair asymmetric.
      if (!isSendableBranchName(reloaded.state.workBranch)) return null;
      const head = publishableRef(reloaded.state.workBranch);
      if (head === null) return null;
      // **A floor, not a live gate, and labelled as one because a counter-proof
      // said so.** Removing it kills no test, and the argument is that it
      // cannot: the grant was minted from a base that passed this grammar, and
      // `sameSubject` compares the base by equality. A reloaded base that is
      // invalid is therefore also unequal, and reaches `SUBJECT_CHANGED` a
      // moment later by the comparison rather than by this line. It stays
      // because the premise is another function's — pinned by the
      // "the base branch changed" case — and a guarantee that depends on a
      // comparison staying where it is, is not one this closure can make.
      if (!isSendableBranchName(reloaded.state.baseBranch)) return null;
      return Object.freeze({
        host: rebuilt.subject.host,
        owner: rebuilt.subject.owner,
        name: rebuilt.subject.name,
        ...buildCreationIntent(
          reloaded.state.taskId,
          rebuilt.remoteName,
          head,
          reloaded.state.baseBranch,
          rebuilt.subject.commit,
        ),
        headCommit: rebuilt.subject.commit,
      });
    },
  });

  return Object.freeze({
    result,
    headRef: intendedHead,
    baseRef: intendedBase,
    draft: AO_PULL_REQUEST_DRAFT,
  });
}

/**
 * The merge ladder.
 *
 * Third and last of the three acts, and after the other two on purpose: a pull
 * request must exist before it can be merged, so an invocation asked for all
 * three has to publish, create and then merge in that order.
 *
 * It cannot in practice reach a merge in the same invocation that creates the
 * pull request, and that is a consequence rather than a check. The observation
 * runs before the creation, so on a first delivery the decision this ladder
 * requires — `PULL_REQUEST_MATCHED_CHECKS_SUCCESS`, which asserts a pull
 * request already matched this commit — cannot be true. The answer is
 * `DECISION_NOT_SUCCESS` and it costs no request. Recorded as `L-V4-07-1`.
 *
 * The gate is a single member, and not the five-member set the creation ladder
 * uses. That ladder admits five because four of them mean a pull request
 * already claims this head and its own fresh reading can then say something
 * useful about it. Nothing analogous applies here: a merge has one precondition
 * worth naming, and `isPositiveDeliveryDecision` is the predicate that owns it.
 * Slice 4 declared that predicate and recorded, accurately, that nothing in
 * `src/` asked it yet. This is the caller it was kept for.
 *
 * There is no `repositoryRoot` argument, and its absence is the point: unlike
 * both siblings this act asks no local Git question, so there is nowhere for Git
 * to be run and no remote name to bind.
 */
export async function performMerge(
  options: DeliveryOptions,
  subject: ReturnType<typeof resolveObservationSubject>,
  taskLoad: ReturnType<typeof loadTaskState>,
  decision: DeliveryDecision | null,
  proof: DeliveryObservationProof | null,
  resolve: typeof resolveRepository,
  load: typeof loadTaskState,
  seams: DeliveryCommandSeams,
): Promise<{
  readonly result: MergeResult;
  readonly pullRequestNumber: number | null;
  readonly baseRef: string | null;
}> {
  const established = subject.ok && taskLoad.ok;
  // The same predicate the mint compares with, not the looser character class.
  // Slice 6 measured what it costs when a ladder's first arm is laxer than its
  // last: a task the mint would refuse was told to pass a flag that could not
  // have helped.
  const intendedBase =
    established && isSendableBranchName(taskLoad.state.baseBranch)
      ? taskLoad.state.baseBranch
      : null;

  const refused = (outcome: MergeOutcome) =>
    Object.freeze({
      result: Object.freeze({
        outcome,
        before: null,
        attempt: 'NOT_ATTEMPTED' as const,
        after: null,
        mergeCommit: null,
      }),
      pullRequestNumber: null,
      baseRef: intendedBase,
    });

  if (!subject.ok || !taskLoad.ok) return refused('SUBJECT_NOT_ESTABLISHED');
  if (intendedBase === null) return refused('SUBJECT_NOT_ESTABLISHED');
  if (taskLoad.state.state !== 'READY_FOR_PR') return refused('TASK_NOT_READY');
  if (options.attended !== true) return refused('OPERATOR_ABSENT');
  if (decision === null || !isPositiveDeliveryDecision(decision)) {
    return refused('DECISION_NOT_SUCCESS');
  }

  // The pull-request number comes from THIS invocation's own proof and from
  // nowhere else. There is no flag that carries one, no field in the task state
  // that holds one, and `loadDeliveryEvidence` — slice 3's store — has no path
  // into this function at all. An operator cannot name a pull request to merge;
  // they can only authorise the one this invocation just looked at.
  const facts = proof === null ? null : deliveryObservationFactsOf(proof);
  if (facts === null || facts.pullRequestNumber === null) return refused('DECISION_NOT_SUCCESS');
  // **All three of the guards below are floors, and a counter-proof measured
  // each of them.** Removing any one kills no test, and this comment claimed
  // the opposite about one of them until the campaign was run.
  //
  // The first: `decideDelivery` answers the positive member only when the
  // outcome is `MATCHED`, the number is non-null and the head equals the
  // commit, so a decision that reached here has already established it.
  //
  // The second: the proof this reads is minted by `attestDeliveryObservation`
  // from `subject.subject` — the very value compared against — so within one
  // invocation the two cannot differ. The sentence here used to argue that
  // nothing upstream compared them, which was true of the *decision* and false
  // of the *mint*, and that is the kind of claim this repository keeps getting
  // wrong by reasoning instead of measuring.
  //
  // And the third, the `pullRequestNumber === null` arm above: the positive
  // decision is only answered when the number is non-null, so a proof reaching
  // here always carries one. Without the arm the run would still refuse — the
  // mint takes `null` and returns `null` — but under `SUBJECT_NOT_ESTABLISHED`
  // rather than under the member that says which precondition was missing.
  //
  // All three stay for the reason `performCreation`'s own floor stays: each
  // premise belongs to another function, and a guarantee that depends on
  // another function's wiring staying where it is, is not one this function can
  // make. An invocation that obtained a proof from anywhere else would reach a
  // live gate rather than a silent mismatch.
  if (facts.pullRequestHeadSha !== facts.commit) return refused('DECISION_NOT_SUCCESS');
  if (facts.commit !== subject.subject.commit) return refused('DECISION_NOT_SUCCESS');

  const pullRequestNumber = facts.pullRequestNumber;
  const grant = mintMergeGrant(subject.subject, {
    taskId: taskLoad.state.taskId,
    pullRequestNumber,
    baseRef: intendedBase,
    mergeMethod: DELIVERY_MERGE_METHOD,
  });
  // The mint refuses anything it will not send or will not put in a request
  // path. Reported as an unestablished subject rather than as its own member,
  // for the reason the other two ladders give: from an operator's side there is
  // no difference between "there is no delivery to be about" and "the one there
  // would be, is not one this build will ask for".
  if (grant === null) return refused('SUBJECT_NOT_ESTABLISHED');

  const result = await mergePullRequest(grant, {
    reader: seams.runner ?? createForgeCommandRunner(),
    merger: seams.mergeRunner ?? createForgeMergeRunner(),
    envSource: seams.envSource ?? process.env,
    // A second, independent pass through the whole local resolution —
    // repository, task record, subject, base — for the reason
    // `revalidateLocalSubject` gives: the point is to ask the world, because
    // what may have moved is the world. It runs *before* the effect, because
    // afterwards there would be nothing useful to do with the answer.
    //
    // The pull-request number is carried through rather than re-derived, so the
    // comparison `sameSubject` makes on that field is a floor and is said to be
    // one. Re-deriving it would need a second observation, and a number that
    // changed between the two is a *remote* fact — which is what the reading
    // inside the merger is for, and which that reading answers by refusing a
    // pull request that is no longer open at the authorised head. This closure
    // answers the local question only.
    recheck: async (): Promise<MergeSubject | null> => {
      const again = await resolve({ repositoryPath: options.repository });
      if (!again.ok) return null;
      const reloaded = load(again.repository.root, options.task);
      if (!reloaded.ok) return null;
      if (reloaded.state.state !== 'READY_FOR_PR') return null;
      const rebuilt = resolveObservationSubject(again.repository.delivery, reloaded);
      if (!rebuilt.ok) return null;
      if (!isSendableBranchName(reloaded.state.baseBranch)) return null;
      return Object.freeze({
        taskId: reloaded.state.taskId,
        host: rebuilt.subject.host,
        owner: rebuilt.subject.owner,
        name: rebuilt.subject.name,
        pullRequestNumber,
        expectedHeadCommit: rebuilt.subject.commit,
        baseRef: reloaded.state.baseBranch,
        mergeMethod: DELIVERY_MERGE_METHOD,
      });
    },
  });

  return Object.freeze({ result, pullRequestNumber, baseRef: intendedBase });
}

/**
 * Exactly the seams a reconciliation may reach, and deliberately not one more.
 *
 * A narrowed type rather than `DeliveryCommandSeams`, and the call site builds a
 * fresh object out of the named fields rather than passing the wider one along.
 * Both halves are needed for the guarantee to be real: the type stops the
 * function *naming* a mutation runner, and the fresh object stops one *arriving*
 * — a wider object is assignable to a narrower parameter type, so the type alone
 * would leave `mergeRunner` sitting on the value at runtime.
 *
 * This was written the lax way first, with a docblock claiming the absence was
 * "in the parameter list". It was not: the function took the whole seam object.
 * The claim is now true rather than softened, which is the direction this
 * repository has learned to take when a sentence and its code disagree.
 *
 * Five of `DeliveryCommandSeams`' fields are omitted, and three of those five
 * are the forge mutations this exists to exclude: `publicationRunner` pushes a
 * Git ref, `creationRunner` opens a pull request, `mergeRunner` merges one. A
 * fixture that stubs any of them cannot stand in for this, and this cannot
 * reach one however the command is wired. (The other two, `resolveRepository`
 * and `loadTaskState`, are omitted because this function is handed their
 * results rather than calling them. An earlier version of this sentence said
 * "the three omitted seams", which counted the interesting ones rather than
 * the omitted ones.)
 */
export interface ReconciliationCommandSeams {
  readonly runner?: ForgeCommandRunner | undefined;
  readonly envSource?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
  readonly checkIgnored?: ((relativePath: string) => Promise<IgnoreVerdict>) | undefined;
  readonly git?: GitRunner | undefined;
}

/**
 * Establishes the merge of this task's delivery, and records it.
 *
 * Two halves, and they are reported separately because they can disagree: the
 * forge may say the delivery is merged while the local write refuses — a
 * receipt already there for a different merge, a runtime path Git does not
 * ignore, a directory that cannot be made. Collapsing them into one word would
 * lose exactly the case an operator has to act on.
 *
 * What it cannot do is stated by {@link ReconciliationCommandSeams} rather than
 * here, because that is where it is enforced.
 *
 * It likewise takes no grant. See `deliver/reconcile-merge.ts` for why a
 * `MergeGrant` here would be wrong three times over, and why requiring one
 * would make the recovery case — a merge AO did not perform — impossible.
 */
export async function performReconciliation(
  options: DeliveryOptions,
  repositoryRoot: string,
  subject: ReturnType<typeof resolveObservationSubject>,
  taskLoad: ReturnType<typeof loadTaskState>,
  seams: ReconciliationCommandSeams,
): Promise<ReconciliationView> {
  const refused = (result: MergeObservationResult): ReconciliationView =>
    Object.freeze({ result, record: null });

  // The two members the ladder does not produce for itself. Their order is the
  // order the ladder declares: a subject that does not exist is ahead of a task
  // that is not ready, because a refusal about a subject that could not be
  // established would be describing nothing.
  if (!subject.ok || !taskLoad.ok) {
    return refused(refuseMergeObservation('SUBJECT_NOT_ESTABLISHED'));
  }
  // The same predicate the merge path compares with, not the looser character
  // class. A base this build would not compare by exact equality is a base it
  // cannot decide `BASE_NOT_INTENDED` against.
  if (!isSendableBranchName(taskLoad.state.baseBranch)) {
    return refused(refuseMergeObservation('SUBJECT_NOT_ESTABLISHED'));
  }
  if (taskLoad.state.state !== 'READY_FOR_PR') {
    return refused(refuseMergeObservation('TASK_NOT_READY'));
  }

  const now = seams.now ?? (() => new Date());
  const result = await observeMergeForDelivery(
    {
      taskId: options.task,
      host: subject.subject.host,
      owner: subject.subject.owner,
      name: subject.subject.name,
      // The subject's commit is the task's `currentCommit`, resolved once at the
      // top of the action. Taken from there rather than re-read, so the receipt
      // and the report cannot describe two different delivery heads.
      deliveryCommit: subject.subject.commit,
      baseRef: taskLoad.state.baseBranch,
    },
    {
      reader: seams.runner ?? createForgeCommandRunner(),
      envSource: seams.envSource ?? process.env,
      now,
    },
  );

  // No merge established, no receipt. There is deliberately no arm that writes
  // a weaker record — "the forge did not say it is merged" is not a merge with a
  // caveat, and a file recording it would be a durable statement about a
  // question that was never answered.
  if (result.outcome !== 'MERGE_OBSERVED' || result.proof === null) {
    return refused(result);
  }

  const record = await recordMergeReconciliation({
    repositoryRoot,
    taskId: options.task,
    // Every expectation comes from the task and the repository's own profile,
    // and none of it from the proof. The store compares the two; handing it the
    // proof's own facts as the expectation would make that comparison a
    // tautology.
    expectedSubjectCommit: subject.subject.commit,
    expectedHost: subject.subject.host,
    expectedOwner: subject.subject.owner,
    expectedName: subject.subject.name,
    expectedBaseRef: taskLoad.state.baseBranch,
    proof: result.proof,
    reconciledAt: now().toISOString(),
    checkIgnored:
      seams.checkIgnored ?? createRuntimeIgnoreProbe(repositoryRoot, seams.git ?? runGitCommand),
  });

  return Object.freeze({ result, record });
}

/**
 * What the verification path may reach.
 *
 * There is deliberately **no forge seam of any kind here** — not the reader,
 * not the three mutation runners. Post-merge verification asks github.com
 * nothing: its subject comes from a receipt already on disk and its verdict
 * from a process started here. A seam it does not hold is a capability the
 * whole path provably does not have, which is a stronger statement than a
 * comment saying it does not use one.
 */
export interface VerificationCommandSeams {
  readonly now?: (() => Date) | undefined;
  readonly checkIgnored?: ((relativePath: string) => Promise<IgnoreVerdict>) | undefined;
  readonly git?: GitRunner | undefined;
  /**
   * The verification runner, for tests only.
   *
   * Production never supplies one: the runner is built here from `leasedVerify`
   * against the lease this function has just taken, and it is the only way to
   * get a production verification runner at all — a static test makes
   * `loop/leased-spawns.ts` the single value importer of `verify-command.js`.
   */
  readonly verify?: VerificationRunner | undefined;
}

/**
 * Runs the canonical gate against this task's reconciled merge commit, and
 * records the attempt.
 *
 * ── Why this one takes the lease when no other delivery act does ───────────
 *
 * Every other flag on this command either reads, or writes one small file, or
 * sends one request to a forge. This one **starts the repository's own build
 * and test commands** and makes a Git worktree appear and disappear beside the
 * repository while it does. Both halves are already leased effects everywhere
 * else in this build: `loop/leased-spawns.ts` names `git worktree add` and
 * `git worktree remove` as productive spawns fenced immediately before the
 * effect, and it is the only module allowed to reach the raw verification
 * runner at all.
 *
 * So the lease is not a precaution chosen here. It is the existing contract for
 * what this path does, and running without one would mean amending a structural
 * pin rather than skipping a formality.
 *
 * It is taken for the whole attempt and given back once, in a `finally` that
 * covers every path out including a throw — never per step, which would leave
 * windows between them that a second writer fits into perfectly.
 */
export async function performVerification(
  options: DeliveryOptions,
  repository: ResolvedRepository,
  subject: ReturnType<typeof resolveObservationSubject>,
  taskLoad: ReturnType<typeof loadTaskState>,
  seams: VerificationCommandSeams,
): Promise<VerificationView> {
  // Captured by the `finally` below and read after it, so the report can say
  // whether the repository was handed back. `null` means no release outcome was
  // observed at all, which is not the same as a clean one.
  let leaseRelease: LeaseReleaseResult | null = null;
  // What the verification itself came to, kept apart from what the release came
  // to. The view is assembled **after** the `finally` has run, because a
  // `return` inside the `try` evaluates its expression before the `finally`
  // executes — so a view built there would report the release outcome the run
  // started with rather than the one it ended with, which is `null` every time.
  let settled: { result: MergeVerificationResult; record: PostMergeVerificationRecordResult | null } | null = null;
  const refused = (result: MergeVerificationResult): VerificationView =>
    Object.freeze({ result, record: null, leaseTaken: false, leaseRelease: null });

  // The two members the ladder does not produce for itself, in the order it
  // declares them: a subject that could not be established is ahead of a task
  // that is not ready, because a refusal about a subject that does not exist
  // would be describing nothing.
  if (!subject.ok || !taskLoad.ok) {
    return refused(refuseMergeVerification('SUBJECT_NOT_ESTABLISHED'));
  }
  if (taskLoad.state.state !== 'READY_FOR_PR') {
    return refused(refuseMergeVerification('TASK_NOT_READY'));
  }

  const now = seams.now ?? (() => new Date());

  const acquired = acquireRepositoryExecutionLease(
    repository,
    { runId: null, blockId: null },
    { now: () => now().toISOString() },
  );
  if (!acquired.ok) {
    // Reported as a workspace that could not be established, because that is
    // exactly what it is: without the lease no checkout is made, no process is
    // started and nothing is learned about the commit. It is emphatically not a
    // verification failure — see the ladder's own note on the difference.
    return refused(refuseMergeVerificationUnleased());
  }

  try {
    // The attempt is an inner function so that its three exits are ordinary
    // returns rather than assignments-and-fall-through, and so the view is
    // still assembled after the release below.
    settled = await (async (): Promise<{ result: MergeVerificationResult; record: PostMergeVerificationRecordResult | null }> => {
    const git = leasedGit({
      lease: { repository, evidence: acquired.evidence },
      ...(seams.git === undefined ? {} : { git: seams.git }),
    });
    const verify =
      seams.verify ?? leasedVerify({ lease: { repository, evidence: acquired.evidence } });

    const result = await verifyMergeForDelivery(
      repository,
      {
        taskId: options.task,
        host: subject.subject.host,
        owner: subject.subject.owner,
        name: subject.subject.name,
        // The task's `currentCommit`, resolved once at the top of the action.
        // Taken from there rather than re-read, so the receipt check and the
        // report cannot be about two different delivery heads.
        deliveryCommit: subject.subject.commit,
      },
      { git, verify, lease: acquired.evidence, now },
    );

    if (result.outcome !== 'VERIFICATION_ATTEMPTED' || result.proof === null) {
      return { result, record: null };
    }

    // Every expectation comes from the receipt the ladder read and from the
    // task, never from the proof. The store compares the two; handing it the
    // proof's own facts as the expectation would make that comparison a
    // tautology.
    const receiptSubject = { taskId: options.task, repositoryRoot: repository.root };
    const stored = loadMergeReconciliation(repository.root, options.task, receiptSubject);
    if (stored.reading !== 'HISTORICAL_MERGE' || stored.receipt === null) {
      // Unreachable through the ladder, which refuses long before a gate runs
      // if the receipt is not readable. It is here because the receipt is read
      // twice — once there and once here — and a build in which those two
      // readings could disagree must not write a record from the second.
      return { result, record: null };
    }

    const record = await recordPostMergeVerification({
      repositoryRoot: repository.root,
      taskId: options.task,
      proof: result.proof,
      expectedSubjectCommit: stored.receipt.subjectCommit,
      expectedMergeCommit: stored.receipt.mergeCommit,
      expectedHost: stored.receipt.host,
      expectedOwner: stored.receipt.owner,
      expectedName: stored.receipt.name,
      expectedPullRequestNumber: stored.receipt.pullRequestNumber,
      checkIgnored:
        seams.checkIgnored ??
        createRuntimeIgnoreProbe(repository.root, seams.git ?? runGitCommand),
    });

    return { result, record };
    })();
  } finally {
    // Given back on every path out, including a throw. Wrapped, because a
    // `finally` that throws **replaces** the exception that entered it — so an
    // exception here would hand the operator the release's failure in place of
    // the one that actually stopped the run.
    //
    // The RESULT is kept, and a review is why. This stood here as a bare
    // expression: the release can come back `NOT_OWNER`, `LEASE_REMOVE_FAILED`
    // or quarantined, and the command reported the verification's own verdict
    // and exited on it as though the repository had been handed back cleanly.
    // A lease that was not given back is the one thing here an operator has to
    // act on, so it is reported. It does not change the verification result —
    // the gate ran or it did not, and the release is a different fact.
    try {
      leaseRelease = releaseRepositoryExecutionLease(acquired.evidence);
    } catch {
      // `releaseRepositoryExecutionLease` refuses rather than throws for every
      // value that is not evidence, so this arm is not the ordinary path. It is
      // left null rather than reported as released: nothing is claimed about a
      // release whose outcome this process never saw.
    }
  }

  // Unreachable with `settled` null: every path through the `try` either
  // assigns it or throws, and a throw propagates past this line. The floor is
  // chosen rather than asserted — if an edit ever does make it reachable, a
  // refusal is the right thing for this command to volunteer about a path that
  // returned nothing.
  if (settled === null) {
    return Object.freeze({
      result: refuseMergeVerificationUnleased(),
      record: null,
      leaseTaken: true,
      leaseRelease,
    });
  }
  return Object.freeze({
    result: settled.result,
    record: settled.record,
    leaseTaken: true,
    leaseRelease,
  });
}

/**
 * What the conclusion path may reach.
 *
 * There is deliberately **no forge seam of any kind** and **no verification
 * runner**. Concluding a delivery asks github.com nothing and runs no gate: it
 * reads documents already on disk. The `git` seam here is not a way to
 * read history — it is the runtime-ignore probe every record writer on this
 * command uses before it writes, and `checkIgnored` is the injectable form of
 * exactly that question. A seam this path does not hold is a capability it
 * provably does not have.
 */
export interface ConclusionCommandSeams {
  readonly now?: (() => Date) | undefined;
  readonly checkIgnored?: ((relativePath: string) => Promise<IgnoreVerdict>) | undefined;
  readonly git?: GitRunner | undefined;
}

/**
 * Joins this task's merge receipt to its verification history, and records the
 * judgement.
 *
 * ── Why this one takes no lease when the verification beside it does ───────
 *
 * `--verify-merge` takes the execution lease because it starts the repository's
 * own build and test commands and makes a Git worktree appear and disappear
 * beside the repository. This starts nothing of the sort. It reads up to four
 * documents beside the task and asks Git twice whether a path is ignored — the
 * same probe `--record` and
 * `--reconcile-merge` run — and replaces one file atomically. Those two flags
 * write their records without a lease, and the rule they follow is the one that
 * applies here: the lease is the repository's *writer slot for productive
 * spawns*, and taking it to file a judgement would make bookkeeping contend
 * with runs of other tasks for no guarantee gained.
 *
 * ── The order of the two refusals this owns ────────────────────────────────
 *
 * A subject that could not be established is ahead of a task that is not ready,
 * because a refusal about a subject that does not exist would be describing
 * nothing. The same order the ladder declares them in, and the same order
 * slices 7, 8 and 9 use.
 */
export async function performConclusion(
  repository: ResolvedRepository,
  taskId: string,
  subject: ReturnType<typeof resolveObservationSubject>,
  taskLoad: ReturnType<typeof loadTaskState>,
  load: typeof loadTaskState,
  seams: ConclusionCommandSeams,
): Promise<DeliveryConclusionView> {
  const refused = (result: DeliveryConclusionResult): DeliveryConclusionView =>
    Object.freeze({ result, record: null });

  if (!subject.ok || !taskLoad.ok) {
    return refused(refuseDeliveryConclusion('SUBJECT_NOT_ESTABLISHED'));
  }
  if (taskLoad.state.state !== 'READY_FOR_PR') {
    return refused(refuseDeliveryConclusion('TASK_NOT_READY'));
  }

  const now = seams.now ?? (() => new Date());

  const result = concludeDeliveryForTask(
    { root: repository.root, verification: repository.verification },
    {
      taskId,
      host: subject.subject.host,
      owner: subject.subject.owner,
      name: subject.subject.name,
      // The task's `currentCommit`, resolved once at the top of the action.
      // Taken from there rather than re-read, so the receipt check and the
      // report cannot be about two different delivery heads.
      deliveryCommit: subject.subject.commit,
    },
    { now },
  );

  if (result.outcome !== 'DELIVERY_CONCLUDED' || result.proof === null) {
    return Object.freeze({ result, record: null });
  }

  // Every expectation comes from the receipt this command reads for itself and
  // from the task, never from the proof. The store compares the two; handing it
  // the proof's own facts as the expectation would make that comparison a
  // tautology — which is a defect this repository has already had reach
  // production once, in the mint the slice before this one shipped.
  const recordSubject = { taskId, repositoryRoot: repository.root };
  const stored = loadMergeReconciliation(repository.root, taskId, recordSubject);
  if (stored.reading !== 'HISTORICAL_MERGE' || stored.receipt === null) {
    // Unreachable through the ladder, which refuses long before a proof exists
    // if the receipt is not readable. It is here because the receipt is read
    // twice — once there and once here — and a build in which those two
    // readings could disagree must not write a record from the second.
    return Object.freeze({ result, record: null });
  }

  const record = await recordDeliveryConclusion({
    repositoryRoot: repository.root,
    taskId,
    proof: result.proof,
    expectedSubjectCommit: stored.receipt.subjectCommit,
    expectedMergeCommit: stored.receipt.mergeCommit,
    expectedHost: stored.receipt.host,
    expectedOwner: stored.receipt.owner,
    expectedName: stored.receipt.name,
    expectedPullRequestNumber: stored.receipt.pullRequestNumber,
    // The revision of the exact task-state bytes the subject was resolved from,
    // carried from the single load at the top of the action. Re-reading it here
    // would compare the write against a reading taken after the assessment,
    // which is the window the gate exists to close rather than to move.
    assessedStateRevision: taskLoad.revision,
    // …and the *other* side of that comparison, taken by the store at the last
    // moment before it writes. It lives here rather than in the store because
    // the delivery surface may not take a value import from the task-state
    // module, and this command is the one admitted exception. A fresh
    // `loadTaskState`, not a captured value: a closure over `taskLoad.revision`
    // would make the store compare a number with itself.
    readStateRevision: () => {
      const again = load(repository.root, taskId);
      return again.ok ? again.revision : null;
    },
    checkIgnored:
      seams.checkIgnored ?? createRuntimeIgnoreProbe(repository.root, seams.git ?? runGitCommand),
  });

  return Object.freeze({ result, record });
}

/**
 * The intended pull request, derived from the task and nothing else.
 *
 * One function, used by both the mint call and the re-check, so the two cannot
 * describe different pull requests. Written as a shared derivation rather than
 * as two spellings of the same rule for the reason a review gave when it found
 * `publishableRef` duplicated: two expressions that had to agree, and nothing
 * that made them.
 */
export function buildCreationIntent(
  taskId: string,
  remoteName: string,
  headRef: string,
  baseRef: string,
  headCommit: string,
) {
  const content = composePullRequestContent({ taskId, headRef, headCommit, baseRef });
  return {
    taskId,
    remoteName,
    headRef,
    baseRef,
    draft: AO_PULL_REQUEST_DRAFT,
    title: content.title,
    body: content.body,
  } as const;
}

/**
 * Turns a work branch into the full ref this build is willing to create.
 *
 * Full, never partial. A partial ref is resolved by Git against a search order,
 * so `refs/heads/` is prepended here and not left to the remote to guess. It
 * exists so a branch name that could not produce a ref is refused before an
 * authority is asked for rather than after.
 *
 * The grammar is the mint’s own, imported rather than restated. A second copy
 * was written here first and a review caught it: two regexes that had to agree,
 * and nothing that made them.
 */
export function publishableRef(workBranch: string): string | null {
  if (typeof workBranch !== 'string' || workBranch.length === 0) return null;
  const ref = `refs/heads/${workBranch}`;
  return PUBLISHABLE_REF.test(ref) ? ref : null;
}

/**
 * Re-establishes the local subject after the forge has answered.
 *
 * A second, independent pass through exactly the resolution the first one used:
 * resolve the repository again, read the task record again, build the subject
 * again. Not a cached comparison — the point is to ask the world, because what
 * may have moved is the world.
 *
 * What it protects is stated exactly, because the reassuring reading is wrong.
 * It closes the *local* window only: the task advancing to a new commit, being
 * aborted, or the profile's delivery target being repointed while the request
 * was in flight. It does **not** freeze GitHub, and `UNCHANGED` is not a claim
 * that the answers are still true — nothing can make that claim. See
 * `deliver/delivery-decision.ts`.
 */
export async function revalidateLocalSubject(
  options: DeliveryOptions,
  resolve: typeof resolveRepository,
  load: typeof loadTaskState,
  before: LocalSubject,
): Promise<SubjectRevalidation> {
  const again = await resolve({ repositoryPath: options.repository });
  if (!again.ok) return 'UNAVAILABLE';
  const subject = resolveObservationSubject(
    again.repository.delivery,
    load(again.repository.root, options.task),
  );
  if (!subject.ok) return 'UNAVAILABLE';
  return revalidateSubject(before, {
    subject: subject.subject,
    taskState: subject.taskState,
  });
}

/**
 * What one look at the forge amounted to: the answers, the attestation, the
 * second look at the local world, and the decision drawn from all three.
 *
 * One sequence with one spelling, because it has two callers. The command runs
 * it under `--observe`/`--record`/`--decide`; the driver runs it when it has
 * derived that the next question is about the forge. Written twice, the two
 * would eventually disagree about *when* the forge answered or about which
 * proof a decision was drawn from — the shape this repository has already paid
 * for elsewhere, where two expressions had to agree and nothing made them.
 *
 * The three `wants` are the caller's, not this function's. It decides nothing
 * about which of them is appropriate; it only refuses to do more than it was
 * asked, and refuses to do any of it without a subject.
 */
export interface ObservationWants {
  /** Contact the forge at all. Without it nothing leaves this machine. */
  readonly observe: boolean;
  /**
   * Mint the invocation's one attestation.
   *
   * One mint per invocation, and only for a caller that needs one: minting
   * twice would stamp two `observedAt` instants on one observation — a record
   * and a decision that disagree about when the forge answered.
   */
  readonly proof: boolean;
  /** Re-check the local subject and classify. */
  readonly decide: boolean;
}

export interface ObservationPass {
  readonly observation: DeliveryObservation | null;
  readonly conclusion: ReturnType<typeof concludeObservation>;
  readonly proof: DeliveryObservationProof | null;
  readonly revalidation: SubjectRevalidation | null;
  readonly decision: DeliveryDecision | null;
}

export async function performObservation(
  options: DeliveryOptions,
  wants: ObservationWants,
  subject: ReturnType<typeof resolveObservationSubject>,
  resolve: typeof resolveRepository,
  load: typeof loadTaskState,
  seams: DeliveryCommandSeams,
): Promise<ObservationPass> {
  // The egress branch, and the whole of it. A subject that could not be
  // established is never observed either: there would be nothing to ask
  // about, and asking anyway would mean guessing the subject.
  let observation: DeliveryObservation | null = null;
  if (wants.observe && subject.ok) {
    observation = await observeDelivery(subject.subject, {
      runner: seams.runner ?? createForgeCommandRunner(),
      envSource: seams.envSource ?? process.env,
    });
  }

  const conclusion = concludeObservation(subject, observation);

  const proof: DeliveryObservationProof | null =
    wants.proof && subject.ok && observation !== null && conclusion === 'OBSERVED'
      ? attestDeliveryObservation(
          subject.subject,
          observation,
          (seams.now ?? (() => new Date()))().toISOString(),
        )
      : null;

  // The second look at the local world, taken *after* the answers came back
  // and before anything is reported against them.
  //
  // Gated on the observation having **settled**, not merely on a request
  // having been attempted. A review drove a refusing forge through the earlier
  // `observation !== null` gate: the report then said "Local subject re-checked
  // after the answers came back: UNCHANGED" on a run where no answer came back
  // at all, and paid a full `resolveRepository` — several Git children — to
  // learn nothing. There is no window to protect when nothing was established.
  const revalidation: SubjectRevalidation | null =
    wants.decide && subject.ok && conclusion === 'OBSERVED'
      ? await revalidateLocalSubject(options, resolve, load, {
          subject: subject.subject,
          taskState: subject.taskState,
        })
      : null;

  const decision: DeliveryDecision | null = wants.decide
    ? concludeDeliveryDecision({
        subjectEstablished: subject.ok,
        observed: observation !== null,
        proof,
        expected: subject.ok ? subject.subject : null,
        // Passed as it is, including `null`. There was a `?? 'UNAVAILABLE'`
        // here and a counter-proof retired it: substituting a verdict the
        // caller had not obtained was a value no test could reach, so changing
        // it to `'UNCHANGED'` broke nothing. The refusal lives where it can be
        // reached by name instead.
        revalidation,
      })
    : null;

  return Object.freeze({ observation, conclusion, proof, revalidation, decision });
}
