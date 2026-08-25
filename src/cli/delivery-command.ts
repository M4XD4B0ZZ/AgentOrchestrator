/**
 * `agent-loop delivery` — the delivery surface (V4 slices 2 to 7).
 *
 * ── Why a command of its own, and why the network is a flag on it ──────────
 *
 * `run` is read-only by default and executes only when `--attended` says so.
 * This command copies that shape one level down: it is **local** by default and
 * contacts a forge only when a flag says so. It stopped being a read-only
 * surface at V4 slice 5, and the sentences on it were corrected then rather
 * than left to be discovered — which had to happen again at slice 6. Every
 * "the only" that survives on this surface is one somebody has to re-read when
 * a flag is added; a review found one that had not been, and it was wrong for a
 * second reason as well. The two properties that matter are structural rather
 * than documented:
 *
 *  - `agent-loop run` gained nothing. It resolves a delivery target — that is
 *    slice 1, and it is local Git — and it has no path to this module at all.
 *    No existing command became a networking command;
 *  - with none of the contacting flags this command builds a subject and stops.
 *    There is no branch on which a client is constructed, so "nothing was
 *    contacted" is a fact about the code rather than a promise in help text.
 *
 * ── The three acts, and why they are three ─────────────────────────────────
 *
 * `--publish-head` creates one branch on the delivery remote. `--create-pr`
 * opens one pull request from that branch. `--merge-pr` merges that pull
 * request. Each requires `--attended`, each takes its own authority, and **none
 * implies another**: a published head is not permission to open a pull request,
 * the pull-request authority cannot push, and neither of them can merge. The
 * three authorities are three separate opaque types, and substituting one for
 * another is a compile error rather than a runtime refusal.
 *
 * They are run in that order when more than one is asked for, and that is
 * necessary without being sufficient. **On a first delivery they do not compose
 * in one invocation**, and the reason is the same each time: the observation
 * runs before any of the acts, so the decision they gate on describes the world
 * as it was before this invocation changed it.
 *
 * Measured for the first pair: `--observe` runs before the publication, the
 * forge has never seen the commit, `commits/{sha}/pulls` answers `422 "No commit
 * found for SHA"`, and the decision is `OBSERVATION_UNSETTLED` — so the creation
 * is refused after the branch has been created. `L-V4-06-10` records it.
 *
 * The same shape closes the second pair, and more tightly: `--merge-pr` admits
 * only `PULL_REQUEST_MATCHED_CHECKS_SUCCESS`, which asserts a pull request
 * already matched this commit, so it cannot be true in the invocation that opens
 * one. The merge is refused before anything is contacted. `L-V4-07-1` records
 * it. Publish, then create, then merge — three invocations.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * It writes no task state, takes no execution lease, prepares no workspace and
 * starts no agent. It never updates, closes, reopens, marks ready or draft,
 * comments on, labels or reviews a pull request, never enables an auto-merge and
 * never enters a merge queue, and there is no flag that would. `READY_FOR_PR` is
 * still terminal, and delivering a task at that state — including merging its
 * pull request — changes nothing about the task. After a merge this build still
 * reports `READY_FOR_PR` while GitHub reports the pull request as merged; that
 * mismatch is deliberate and is the next slice's subject.
 *
 * It also does not answer "may this be merged", and `--merge-pr` does not change
 * that. It reports facts about one commit and stops there: reviews, branch
 * protection and repository rules are not observed at all, and — measured —
 * their surfaces cannot be told apart from "you may not read them". What
 * authorises a merge is an operator saying so for one invocation; what enforces
 * it is GitHub. Opening a pull request is still not that decision, and neither
 * is this build's willingness to send the request.
 */

import type { Command } from 'commander';

import {
  attestDeliveryObservation,
  concludeObservation,
  observeDelivery,
  resolveObservationSubject,
  type DeliveryObservation,
  type SubjectResolution,
} from '../deliver/observe-delivery.js';
import {
  loadDeliveryEvidence,
  recordDeliveryEvidence,
  type DeliveryEvidenceRecordCode,
  type IgnoreVerdict,
} from '../deliver/delivery-evidence-store.js';
import {
  concludeDeliveryDecision,
  isPositiveDeliveryDecision,
  revalidateSubject,
  type DeliveryDecision,
  type LocalSubject,
  type SubjectRevalidation,
} from '../deliver/delivery-decision.js';
import type { DeliveryObservationProof } from '../deliver/delivery-observation-proof.js';
import {
  PUBLISHABLE_REF,
  mintHeadPublicationGrant,
  type HeadPublicationSubject,
} from '../deliver/internal/head-publication-grant.js';
import { publishDeliveryHead, type PublicationResult } from '../deliver/publish-delivery-head.js';
import type { GitPublicationRunner } from '../deliver/git-head-publisher.js';
import type { HeadPublication } from '../deliver/head-publication.js';
import {
  isSendableBranchName,
  mintPullRequestCreationGrant,
  type PullRequestCreationSubject,
} from '../deliver/internal/pull-request-creation-grant.js';
import { createPullRequest, type CreationResult } from '../deliver/create-pull-request.js';
import type { PullRequestCreation } from '../deliver/pull-request-creation.js';
import {
  AO_PULL_REQUEST_DRAFT,
  composePullRequestContent,
} from '../deliver/pull-request-content.js';
import {
  createForgeMutationRunner,
  type ForgeMutationRunner,
} from '../deliver/github-pull-request-creator.js';
import {
  DELIVERY_MERGE_METHOD,
  mintMergeGrant,
  type MergeSubject,
} from '../deliver/internal/merge-grant.js';
import { mergePullRequest, type MergeResult } from '../deliver/merge-pull-request.js';
import {
  observeMergeForDelivery,
  refuseMergeObservation,
  type MergeObservationResult,
} from '../deliver/reconcile-merge.js';
import { recordMergeReconciliation } from '../deliver/merge-reconciliation-store.js';
import {
  createForgeMergeRunner,
  type ForgeMergeRunner,
} from '../deliver/github-pull-request-merger.js';
import type { MergeOutcome } from '../deliver/pull-request-merge.js';
import { deliveryObservationFactsOf } from '../deliver/delivery-observation-proof.js';
import { runGitCommand, type GitRunner } from '../worktree/git-command.js';
import { askRuntimeIgnored } from '../state/runtime-ignored.js';
import {
  createForgeCommandRunner,
  type ForgeCommandRunner,
} from '../deliver/github-observer.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { loadTaskState } from '../state/state-store.js';
import {
  renderDeliveryObservation,
  type ReconciliationView,
} from './render-delivery-observation.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
} from './run-exit-codes.js';

interface DeliveryOptions {
  readonly repository: string;
  readonly task: string;
  readonly observe?: boolean;
  readonly record?: boolean;
  readonly decide?: boolean;
  readonly publishHead?: boolean;
  readonly createPr?: boolean;
  readonly mergePr?: boolean;
  readonly reconcileMerge?: boolean;
  readonly attended?: boolean;
}

/**
 * Every way `--record` can end, beside the store's own codes.
 *
 * These are the refusals decided *by the command*, before the store is reached.
 * They exist as their own vocabulary because "you did not ask for an
 * observation" and "the observation did not settle" send an operator to
 * different places, and neither is a failure of the store.
 */
export const RECORD_REFUSALS = [
  /** `--record` without `--observe`. Nothing was contacted and nothing was written. */
  'RECORD_REQUIRES_OBSERVATION',
  /** No subject could be established, so there was nothing to observe or record. */
  'RECORD_WITHOUT_SUBJECT',
  /** The observation did not settle both questions. Nothing is established to record. */
  'RECORD_WITHOUT_SETTLED_OBSERVATION',
  /** The task's durable record could not be re-read to bind the evidence to. */
  'RECORD_WITHOUT_TASK_BINDING',
] as const;

export type RecordRefusal = (typeof RECORD_REFUSALS)[number];

export const RECORD_REFUSAL_DETAIL: Readonly<Record<RecordRefusal, string>> = Object.freeze({
  RECORD_REQUIRES_OBSERVATION:
    'Recording stores an observation, so one has to be made. Pass --observe as well.',
  RECORD_WITHOUT_SUBJECT: 'There was no subject to ask about, so there is nothing to record.',
  RECORD_WITHOUT_SETTLED_OBSERVATION:
    'At least one question was not answered, so no observation was established to record.',
  RECORD_WITHOUT_TASK_BINDING:
    'The task record could not be read, so evidence could not be bound to it.',
});

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
  /** The Git runner the default ignore probe uses. */
  readonly git?: GitRunner;
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
function createRuntimeIgnoreProbe(
  repositoryRoot: string,
  git: GitRunner = runGitCommand,
): (relativePath: string) => Promise<IgnoreVerdict> {
  return (relativePath) => askRuntimeIgnored(git, repositoryRoot, relativePath);
}

/**
 * The flag's own sentence, exported so it can be pinned by literal.
 *
 * It used to end "it asks about one commit and nothing else" — the identical
 * over-claim that was withdrawn from `CONTACTED_TRAILER`, left standing on the
 * surface an operator reads *before* running the command, and pinned by
 * nothing. Two strings made the same promise and only one was corrected.
 *
 * It happened a second time, and the literal pin did not stop it. Slice 5 made
 * "this is the only way this build contacts a forge" and "without this flag
 * nothing leaves this machine" both false, and a test asserting the exact
 * string went on passing — because a literal proves what a sentence says, never
 * that it is true. The lesson is not that the pin is wrong; it is that a
 * sentence naming *the* way to do something has to be re-read by any slice that
 * adds a second way.
 */
export const OBSERVE_OPTION_DESCRIPTION =
  'Ask github.com about the commit named above, read-only. It asks about no commit but ' +
  'that one. The GitHub CLI additionally makes calls of its own (telemetry, update check) ' +
  'that this build does not suppress. This flag only reads, and it is not the only flag here ' +
  'that reads: every flag that can change something on a forge reads as well, because each ' +
  'establishes what it is about before and after it acts, and --reconcile-merge reads without ' +
  'changing anything there. Contacting a forge is never implicit — with no flag that says it ' +
  'contacts github.com, nothing leaves this machine, though a flag that stores something still ' +
  'writes a record beside the task, here.';

/**
 * The record flag's own sentence, exported so it can be pinned by literal.
 *
 * Every clause is load-bearing. "A record of one past moment" is the whole
 * semantic contract of the slice, and it is stated on the surface an operator
 * reads *before* running the command rather than only in the report afterwards.
 * "Grants nothing" is there because a durable green check state is exactly the
 * artefact somebody will later be tempted to treat as permission.
 */
export const RECORD_OPTION_DESCRIPTION =
  'Store the observation as a durable record for this task, beside its task state. Requires ' +
  '--observe, and stores nothing unless both questions were answered. What is stored is a ' +
  'record of one past moment: it does not stay true, it is never re-read as the forge\'s ' +
  'current state, and it grants nothing — no merge, no pull request, no task state change. ' +
  'Replaces any previous record for this task.';

/**
 * The decide flag's own sentence, exported so it can be pinned by literal.
 *
 * "From this invocation's own answers" is the whole freshness contract, stated
 * on the surface an operator reads before running the command. "Does not
 * establish merge eligibility" is there because a one-word verdict is exactly
 * the artefact somebody will later be tempted to read as permission — and
 * because, measured, this build cannot establish it: the branch-rule endpoints
 * answer the same way for "there are none" as for "you may not read them".
 */
export const DECIDE_OPTION_DESCRIPTION =
  'Classify this invocation\'s own answers into one delivery decision. Requires --observe: a ' +
  'stored record can never produce a decision, so once a subject exists and nothing was ' +
  'contacted the answer is NOT_DECIDED. The local subject is re-read after the answers come ' +
  'back and the decision is refused if it moved. This does not establish merge eligibility — ' +
  'draft state, mergeability, reviews and branch rules are not observed, and their absence is ' +
  'not provable from what GitHub returns. Writes nothing.';

/**
 * The flag that names the act, and the only one in this build that can change
 * something on a forge.
 *
 * Spelled after what it does. It is not `--push`, because what is published is
 * one ref at one object name and never the local branch's current tip; and it
 * is not `--publish`, because a bare verb would grow to mean whatever the next
 * slice wants published.
 */
export const PUBLISH_HEAD_OPTION_DESCRIPTION =
  'Create the task\'s work branch on the delivery remote, at exactly its pinned commit. ' +
  'Requires --attended and a task at READY_FOR_PR. Create-only: the ref is written under a ' +
  'compare-and-swap that refuses an existing ref, so a branch already there is never moved, ' +
  'rewritten or deleted — whatever it holds. Idempotent by observation: the remote is read ' +
  'before and after, a ref already at this commit is reported and not pushed to, and an ' +
  'attempt whose result was lost is never repeated blindly. This opens no pull request and ' +
  'grants no authority to open or merge one. It writes no task state.';

/**
 * The flag that names the second act this build can perform on a forge.
 *
 * Spelled after what it does, and narrowly. It is not `--pr`, which would grow
 * to mean whatever the next slice wants done to one, and it is not `--deliver`,
 * which would name an outcome rather than an act. Creating is the whole of it:
 * there is no flag here that updates, closes, reopens, marks ready, comments,
 * labels, requests review or merges, and none of those exists anywhere in this
 * build.
 */
export const CREATE_PR_OPTION_DESCRIPTION =
  'Open one pull request on github.com for this task, from its work branch to its base ' +
  'branch. Requires --attended, --observe and --decide, and a task at READY_FOR_PR whose own ' +
  'fresh decision says this commit was observed and no check on it failed — a stored record ' +
  'can never stand in for that. Only PULL_REQUEST_REQUIRED means one is needed; the other ' +
  'admitted decisions mean one existed a moment ago, and a request is sent only when the ' +
  'reading this flag takes immediately before finds none. The work branch ' +
  'must already exist on the delivery remote at exactly this commit: this flag never pushes, ' +
  'and answers HEAD_NOT_PUBLISHED for a ref that is not there, HEAD_SHA_MISMATCH for one ' +
  'holding another commit. Idempotent by observation: the forge is read before and after, an ' +
  'intended pull request that already exists is reported and not sent for again, and an ' +
  'attempt whose result was lost is never repeated blindly. It updates, closes, reviews and ' +
  'merges nothing, and writes no task state.';

/**
 * The flag that names the third act this build can perform on a forge, and the
 * only one that writes to a branch nobody asked it to touch.
 *
 * Spelled after what it does and after what it does it to. It is not `--merge`,
 * which would be a verb with no object and would grow to mean whatever the next
 * slice wants merged; and it is not `--land` or `--integrate`, which would name
 * an outcome while hiding the act — a flag whose name hides the act is exactly
 * the failure the naming rule exists for.
 *
 * The rule banning `force`, `unattended`, `adopt`, `takeover` and `steal` in a
 * registered option name is unchanged. `merge` was in that list too, put there
 * by slice 6 to say this build could not merge. This slice makes that false, so
 * the word leaves the list and the option set is pinned by exact enumeration
 * instead, so a new mutation flag cannot arrive unnamed whatever it is called.
 * An earlier draft said "a sixth", which counts nothing: the command registers
 * ten options, three of which are forge mutations. (Nine until V4 slice 8
 * added `--reconcile-merge`, which is not a fourth mutation — it reads
 * github.com and writes one local file — so the second count is unchanged and
 * the first is not. A review caught this sentence still saying nine.)
 */
export const MERGE_PR_OPTION_DESCRIPTION =
  'Merge this task\'s pull request on github.com, by squash, into its base branch. Requires ' +
  '--attended, --observe and --decide, and a task at READY_FOR_PR whose own fresh decision is ' +
  'PULL_REQUEST_MATCHED_CHECKS_SUCCESS: exactly one open pull request at this commit, no check ' +
  'on it failed or is still running, and this commit carries at least one check record — so a ' +
  'repository that runs no checks at all is refused, under CHECKS_ABSENT. It does NOT mean a ' +
  'check succeeded: a commit whose only check was skipped reaches this decision with nothing ' +
  'having succeeded, and would be merged. A stored record can never stand in for it. This ' +
  'is not merge eligibility — reviews, branch protection and repository rules are not observed, ' +
  'and GitHub is what enforces them; what authorises the act is you. The pull request is the ' +
  'one this invocation observed, never one you name. The request carries the exact head commit ' +
  'observed, and while the pull request is open GitHub refuses it if the head has moved ' +
  'since. Read before and after: an ' +
  'already-merged pull request is reported and nothing is sent, and one that is closed, a ' +
  'draft, at another commit or targeting another base is refused. At most one request per ' +
  'invocation, and an attempt whose result was lost is never repeated blindly. It opens, ' +
  'updates, closes, reviews and reverts nothing, it pushes no branch and deletes none itself — ' +
  'though a repository with delete_branch_on_merge set will have GitHub remove the head branch ' +
  'as a consequence — there is no auto-merge, and it writes no task state — so after a merge this task is still READY_FOR_PR.';

/**
 * The reconciliation flag's own sentence, exported so it can be pinned by
 * literal.
 *
 * Two clauses are load-bearing and both are about what the flag is *not*.
 *
 * The opening one — "reading github.com to establish it and changing nothing
 * there" — separates it from `--merge-pr`, which is the act; this is the
 * bookkeeping afterwards. And the closing one is the distinction the whole
 * slice turns on: a receipt is an event, not a claim about the base branch now.
 *
 * This docblock previously quoted a phrase, "Records what GitHub already did",
 * that appears nowhere in the string below. A review found it, and it is worth
 * recording why a quotation in a comment is worse than a paraphrase: it reads
 * as a pin and is not one.
 *
 * It deliberately does not say "requires --attended", because it does not.
 * `--attended` is this build's marker that a person is present for an
 * irreversible effect *outside this machine*, and this flag has none: it reads
 * github.com and writes one local file. Requiring it would make the marker mean
 * two different things.
 */
export const RECONCILE_MERGE_OPTION_DESCRIPTION =
  'Record, beside the task state, that this task\'s delivery was merged — reading github.com ' +
  'to establish it and changing nothing there. It finds the pull request by asking which ones ' +
  'carry this task\'s commit as their head, never from a stored number and never from one you ' +
  'name, then reads that pull request and requires it to be merged, at exactly this commit, ' +
  'into exactly this task\'s base branch. Requires a task at READY_FOR_PR: before that its current commit is not a delivery head. ' +
  'It works for a merge performed by anyone — this ' +
  'build, another invocation, or a person — and it never claims AO did it. Writing needs this ' +
  'flag: without it nothing is stored. A receipt already there for the same merge is left ' +
  'alone and nothing is written; one naming a different merge refuses rather than being ' +
  'overwritten. What is stored is one past event — that this pull request was merged and ' +
  'produced that commit. It is not a claim that the commit is on the base branch now, that it ' +
  'has not been reverted, or that anything was verified against it, and it changes no task ' +
  'state: the task is still READY_FOR_PR afterwards. The exit code reports the observation, ' +
  'not the reconciliation — read the Receipt line, because a refusal to write exits zero.';

/**
 * Operator presence, in the shape `release` established.
 *
 * A second, independent statement rather than a widening of the first: one flag
 * says which act, and this one says that a person is present for it. Neither
 * implies the other, and there is no unattended publication.
 */
export const ATTENDED_OPTION_DESCRIPTION =
  'States that an operator is present for this invocation. Required by every flag here that can ' +
  'change something outside this machine — today --publish-head, --create-pr and --merge-pr. ' +
  'Not a claim ' +
  'about credentials, and not needed by any read-only part of this command. There is no ' +
  'unattended publication, no unattended pull request and no unattended merge.';

export const DELIVERY_COMMAND_DESCRIPTION =
  'Report the delivery target and the exact commit a delivery observation would be about, ' +
  'and — only with --observe — ask github.com two read-only questions about that commit: ' +
  'is there exactly one open pull request whose head is this commit, and what is the check ' +
  'state of this commit. With --record it stores that ' +
  'observation as a historical record beside the task state; without it, nothing is written. ' +
  'With --decide it classifies this invocation\'s own answers into one delivery decision, which ' +
  'is not merge eligibility and grants nothing. With --publish-head and --attended it creates ' +
  'the work branch on the delivery remote at its pinned commit, create-only. With --create-pr ' +
  'and --attended, on top of --observe and --decide, it opens one pull request from that branch ' +
  'to the base branch. With --merge-pr and --attended, on the same footing plus a fresh ' +
  'decision of PULL_REQUEST_MATCHED_CHECKS_SUCCESS, it merges that pull request by squash. ' +
  'Those three are what it can change on a forge; they are separately requested and separately ' +
  'authorised, and none implies another. With --reconcile-merge it reads github.com to establish ' +
  'that this task\'s delivery was merged and stores that one event beside the task state, ' +
  'changing nothing on the forge. Contacting a forge is never implicit: with no flag that says ' +
  'it contacts github.com, nothing is read from a network. It writes no task state — the flags ' +
  'that write anything at all are --record and --reconcile-merge, and each writes a record ' +
  'beside the task, here — and it never updates, closes, reopens, reviews, comments on or ' +
  'labels a pull request, and never enables an auto-merge.';

export function registerDeliveryCommand(program: Command, seams: DeliveryCommandSeams = {}): void {
  const resolve = seams.resolveRepository ?? resolveRepository;
  const load = seams.loadTaskState ?? loadTaskState;

  program
    .command('delivery')
    .description(DELIVERY_COMMAND_DESCRIPTION)
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .requiredOption(
      '--task <id>',
      'The task whose pinned commit is the subject. Required: an observation with no exact ' +
        'commit to be about is not an observation this build makes.',
    )
    .option(
      '--observe',
      OBSERVE_OPTION_DESCRIPTION,
    )
    .option(
      '--record',
      RECORD_OPTION_DESCRIPTION,
    )
    .option(
      '--decide',
      DECIDE_OPTION_DESCRIPTION,
    )
    .option(
      '--publish-head',
      PUBLISH_HEAD_OPTION_DESCRIPTION,
    )
    .option(
      '--create-pr',
      CREATE_PR_OPTION_DESCRIPTION,
    )
    .option(
      '--merge-pr',
      MERGE_PR_OPTION_DESCRIPTION,
    )
    .option(
      '--reconcile-merge',
      RECONCILE_MERGE_OPTION_DESCRIPTION,
    )
    .option(
      '--attended',
      ATTENDED_OPTION_DESCRIPTION,
    )
    .action(async (options: DeliveryOptions) => {
      const resolution = await resolve({ repositoryPath: options.repository });
      if (!resolution.ok) {
        process.stdout.write(
          `\nRepository   : could not be resolved\n` +
            `Failure      : ${resolution.code} — ${resolution.detail}\n\n`,
        );
        process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
        return;
      }

      const repository = resolution.repository;
      // Read once and keep it. The same load supplies the subject and the
      // revision the evidence is bound to, so the two cannot describe different
      // bytes — reading twice would open a window in which the task advanced
      // between them and the record claimed a revision it was not derived from.
      const taskLoad = load(repository.root, options.task);
      const subject = resolveObservationSubject(repository.delivery, taskLoad);

      // The egress branch, and the whole of it. A subject that could not be
      // established is never observed either: there would be nothing to ask
      // about, and asking anyway would mean guessing the subject.
      let observation: DeliveryObservation | null = null;
      if (options.observe === true && subject.ok) {
        observation = await observeDelivery(subject.subject, {
          runner: seams.runner ?? createForgeCommandRunner(),
          envSource: seams.envSource ?? process.env,
        });
      }

      const conclusion = concludeObservation(subject, observation);

      // One mint per invocation, and only for an invocation that asked for
      // something a proof is needed for.
      //
      // Hoisted out of the recording path because two callers now want one and
      // minting twice would stamp two `observedAt` instants on one observation
      // — a record and a decision that disagree about when the forge answered.
      // Still not minted on a plain `--observe`, which is the argument
      // `observe-delivery.ts` makes at its own mint call: an artefact made for
      // nobody is an artefact somebody will find a use for.
      const proof: DeliveryObservationProof | null =
        (options.record === true || options.decide === true) &&
        subject.ok &&
        observation !== null &&
        conclusion === 'OBSERVED'
          ? attestDeliveryObservation(
              subject.subject,
              observation,
              (seams.now ?? (() => new Date()))().toISOString(),
            )
          : null;

      // The second look at the local world, taken *after* the answers came
      // back and before anything is reported against them.
      //
      // Gated on the observation having **settled**, not merely on a request
      // having been attempted. The first version used `observation !== null`,
      // and a review drove a refusing forge through it: the report then said
      // "Local subject re-checked after the answers came back: UNCHANGED" on a
      // run where no answer came back at all. It also paid a full
      // `resolveRepository` — several Git children — to learn nothing. There is
      // no window to protect when nothing was established.
      const revalidation: SubjectRevalidation | null =
        options.decide === true && subject.ok && conclusion === 'OBSERVED'
          ? await revalidateLocalSubject(options, resolve, load, {
              subject: subject.subject,
              taskState: subject.taskState,
            })
          : null;

      const decision: DeliveryDecision | null =
        options.decide === true
          ? concludeDeliveryDecision({
              subjectEstablished: subject.ok,
              observed: observation !== null,
              proof,
              expected: subject.ok ? subject.subject : null,
              // Passed as it is, including `null`. There was a `?? 'UNAVAILABLE'`
              // here and a counter-proof retired it: substituting a verdict the
              // caller had not obtained was a value no test could reach, so
              // changing it to `'UNCHANGED'` broke nothing. The refusal lives
              // where it can be reached by name instead.
              revalidation,
            })
          : null;

      // Recording happens BEFORE the record is read back, and the order is the
      // contract rather than an accident.
      //
      // The first version of this read first, and a review reproduced what that
      // prints: on a successful `--observe --record` for a task with no prior
      // record, the report said "Recorded : ABSENT — No observation has been
      // recorded for this task" on the line directly above "Record : RECORDED".
      // A sentence false at the moment it is printed, contradicting the line
      // beneath it, and it suppressed the freshness sentence as a bonus. On a
      // second run it showed the record that had just been *superseded*.
      //
      // So the read is the last thing that happens, and what it reports is the
      // state of the store as the invocation leaves it.
      const recording =
        options.record === true
          ? await performRecording({
              options,
              repositoryRoot: repository.root,
              subject,
              taskLoad,
              observation,
              conclusion,
              proof,
              seams,
            })
          : null;

      // Whatever is on disk, judged against the task as it is now. Read on every
      // invocation, including one with no `--observe`, because "what does AO
      // already know about this task" is a local question and answering it needs
      // no network. It is reported as history and never as truth.
      const stored =
        subject.ok && taskLoad.ok
          ? loadDeliveryEvidence(
              repository.root,
              options.task,
              {
                taskId: options.task,
                repositoryRoot: repository.root,
                stateRevision: taskLoad.revision,
              },
              {
                subjectCommit: subject.subject.commit,
                host: subject.subject.host,
                owner: subject.subject.owner,
                name: subject.subject.name,
                declaredRemote: subject.remoteName,
              },
            )
          : null;

      // The mutation, and it is deliberately the last thing that happens.
      //
      // Everything above is a read, and every one of those reads is worth
      // having even on an invocation that goes on to be refused. Putting the
      // effect after them means a refusal costs nothing extra, and means the
      // report an operator sees describes the same world the attempt was made
      // against rather than one observed before it.
      // The ref and the remote are carried beside the result rather than read
      // back out of it: the authority that named them is spent by the time the
      // result exists, deliberately, because an artefact a report could read
      // twice is an artefact that could publish twice.
      const publication =
        options.publishHead === true
          ? {
              result: await performPublication(
                options,
                repository.root,
                subject,
                taskLoad,
                resolve,
                load,
                seams,
              ),
              ref: taskLoad.ok ? publishableRef(taskLoad.state.workBranch) : null,
              remoteName: subject.ok ? subject.remoteName : null,
            }
          : null;

      // The second mutation, and it is after the first on purpose. A pull
      // request is created from a branch that must already be on the remote, so
      // an invocation that was asked for both has to publish before it creates
      // — and one asked only for this finds the ref already there, or answers
      // `HEAD_NOT_PUBLISHED` and pushes nothing.
      const creation =
        options.createPr === true
          ? await performCreation(
              options,
              repository.root,
              subject,
              taskLoad,
              decision,
              resolve,
              load,
              seams,
            )
          : null;

      // The third mutation, and it is after the other two on purpose: a pull
      // request must exist on the forge before it can be merged, so an
      // invocation asked for all three publishes, creates and then merges. One
      // asked only for this finds the pull request the observation matched, or
      // refuses without sending anything.
      const merge =
        options.mergePr === true
          ? await performMerge(options, subject, taskLoad, decision, proof, resolve, load, seams)
          : null;

      // Last, and after the merge on purpose. An invocation asked for both
      // merges and then records what the merge did; one asked only for this
      // reconciles a merge somebody else performed. It is deliberately not a
      // forge mutation and takes no authority from the one above it: the merge
      // grant is spent, and this path could not use it if it were not.
      //
      // Reached on its own flag alone. It does not require `--observe`, because
      // it asks the forge its own two questions about its own subject rather
      // than reading the observation above — an observation looks for an *open*
      // pull request at this head, and after a merge there is none.
      const reconciliation =
        options.reconcileMerge === true
          ? await performReconciliation(options, repository.root, subject, taskLoad, {
              // A fresh object of exactly the five named seams, not `seams`
              // itself. See `ReconciliationCommandSeams`: a wider value is
              // assignable to a narrower parameter type, so passing `seams`
              // would leave the three forge-mutation runners on the value at
              // runtime and the "it cannot reach one" claim would be about the
              // type only.
              runner: seams.runner,
              envSource: seams.envSource,
              now: seams.now,
              checkIgnored: seams.checkIgnored,
              git: seams.git,
            })
          : null;

      process.stdout.write(
        renderDeliveryObservation({
          repositoryId: repository.id,
          repositoryRoot: repository.root,
          taskId: options.task,
          subject,
          observation,
          conclusion,
          stored,
          recording,
          decision: decision === null ? null : { decision, revalidation },
          publication,
          creation,
          merge,
          reconciliation,
        }),
      );

      // Unchanged by `--decide`, and that is the decision rather than an
      // omission. The exit code answers one question — was the observation
      // settled — and a caller that could read "deliver this" out of an exit
      // status would have been handed the machine-consumable merge signal this
      // slice exists to not give. The decision is in the report, where a person
      // reads the sentence that comes with it.
      process.exitCode = exitCodeFor(conclusion);
    });
}

/**
 * Decides whether one delivery head may be published, and publishes it.
 *
 * The refusal ladder here is the one `HEAD_PUBLICATIONS` declares, in the same
 * order, and that is checked rather than asserted: the suite drives every arm
 * and pins which member comes out. Two of the three refusals are about the
 * work and one is about the invocation, and the work is answered first — an
 * operator whose task is not finished is told that, rather than being told to
 * pass a flag that would not have helped.
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
 * Note what is *not* passed to the mint: nothing derived from the task's title,
 * brief, findings or any other repository-authored prose. The grant carries six
 * fields, all of them identities or object names, and the push vector can only
 * carry what the grant holds — so no repository-controlled text can reach the
 * network by this path, and no filtering step has to remember to run.
 */
async function performPublication(
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
  if (options.attended !== true) return refused('OPERATOR_ABSENT');

  const intended = publishableRef(taskLoad.state.workBranch);
  if (intended === null) return refused('SUBJECT_NOT_ESTABLISHED');

  const grant = mintHeadPublicationGrant(subject.subject, subject.remoteName, intended);
  // The mint refuses a remote name, ref or object name it will not put in an
  // argument vector. Reported as an unestablished subject rather than as its
  // own member: from an operator's side there is no difference between "there
  // is no publishable subject" and "the subject there is, is not publishable",
  // and inventing a second word would imply this build could tell them how to
  // fix it, which it cannot without naming the value it refused.
  if (grant === null) return refused('SUBJECT_NOT_ESTABLISHED');

  return publishDeliveryHead(grant, repositoryRoot, {
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
async function performCreation(
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
async function performMerge(
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
interface ReconciliationCommandSeams {
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
async function performReconciliation(
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
 * The intended pull request, derived from the task and nothing else.
 *
 * One function, used by both the mint call and the re-check, so the two cannot
 * describe different pull requests. Written as a shared derivation rather than
 * as two spellings of the same rule for the reason a review gave when it found
 * `publishableRef` duplicated: two expressions that had to agree, and nothing
 * that made them.
 */
function buildCreationIntent(
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
function publishableRef(workBranch: string): string | null {
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
async function revalidateLocalSubject(
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
 * What one `--record` amounted to.
 *
 * A union of this command's own refusals and the store's, kept as one closed
 * string so the report has one place to print and a test has one place to pin.
 */
export type RecordOutcome = RecordRefusal | DeliveryEvidenceRecordCode;

export interface RecordingResult {
  readonly outcome: RecordOutcome;
  readonly recorded: boolean;
  /** The operator sentence for a refusal this command decided, else null. */
  readonly detail: string | null;
}

interface RecordingInputs {
  readonly options: DeliveryOptions;
  readonly repositoryRoot: string;
  readonly subject: SubjectResolution;
  readonly taskLoad: ReturnType<typeof loadTaskState>;
  readonly observation: DeliveryObservation | null;
  readonly conclusion: ReturnType<typeof concludeObservation>;
  /**
   * The invocation's one attestation, or `null` if none could be minted.
   *
   * Handed in rather than minted here, so that a run which both records and
   * decides binds both to the same observed instant. The refusal below is
   * unchanged: `null` still means the observation did not settle after all, and
   * it is still the mint — not this module — that decided so.
   */
  readonly proof: DeliveryObservationProof | null;
  readonly seams: DeliveryCommandSeams;
}

/**
 * The recording path, and every refusal on the way in.
 *
 * The order is the contract, and each step can only reach a *worse* answer than
 * the one after it. In particular the `--observe` requirement is judged before
 * anything else: `--record` alone must not merely fail to write, it must not
 * cause the command to behave differently from a plain local run in any way an
 * observer could detect. Nothing is contacted, nothing is created, and the
 * refusal is a sentence.
 */
async function performRecording(inputs: RecordingInputs): Promise<RecordingResult> {
  const refuse = (outcome: RecordRefusal): RecordingResult =>
    Object.freeze({ outcome, recorded: false as const, detail: RECORD_REFUSAL_DETAIL[outcome] });

  if (inputs.options.observe !== true) return refuse('RECORD_REQUIRES_OBSERVATION');
  if (!inputs.subject.ok) return refuse('RECORD_WITHOUT_SUBJECT');
  if (inputs.observation === null || inputs.conclusion !== 'OBSERVED') {
    return refuse('RECORD_WITHOUT_SETTLED_OBSERVATION');
  }
  if (!inputs.taskLoad.ok) return refuse('RECORD_WITHOUT_TASK_BINDING');

  // The mint's verdict. A `null` here means the observation did not settle
  // after all — the mint re-derives that for itself and does not believe the
  // conclusion computed above — and it reaches the same refusal, because from
  // the operator's side the two are one fact.
  const proof = inputs.proof;
  if (proof === null) return refuse('RECORD_WITHOUT_SETTLED_OBSERVATION');

  const result = await recordDeliveryEvidence({
    repositoryRoot: inputs.repositoryRoot,
    taskId: inputs.options.task,
    subject: {
      taskId: inputs.options.task,
      repositoryRoot: inputs.repositoryRoot,
      stateRevision: inputs.taskLoad.revision,
    },
    taskState: inputs.taskLoad.state.state,
    basePinnedCommit: inputs.taskLoad.state.basePinnedCommit,
    declaredRemote: inputs.subject.remoteName,
    expectedSubjectCommit: inputs.subject.subject.commit,
    expectedHost: inputs.subject.subject.host,
    expectedOwner: inputs.subject.subject.owner,
    expectedName: inputs.subject.subject.name,
    proof,
    recordedAt: (inputs.seams.now ?? (() => new Date()))().toISOString(),
    checkIgnored:
      inputs.seams.checkIgnored ??
      createRuntimeIgnoreProbe(inputs.repositoryRoot, inputs.seams.git ?? runGitCommand),
  });
  // The store's own codes carry no sentence here: they are already a closed
  // vocabulary an operator can look up, and inventing a second sentence for
  // each in this module would be a second place for them to drift.
  return Object.freeze({ outcome: result.code, recorded: result.recorded, detail: null });
}

/**
 * Four conclusions, three codes, and the distinction a scheduler needs.
 *
 * Three codes because two conclusions share one: a subject that was established
 * and not observed, and one that was observed and settled, are both "nothing to
 * go and fix".
 *
 * `OBSERVED` is zero even when the answer is "no pull request has this head" or
 * "the checks failed". Those are answers, and a command that exits non-zero on
 * a successfully obtained fact teaches a caller to retry a question that has
 * already been settled.
 */
export function exitCodeFor(conclusion: ReturnType<typeof concludeObservation>): number {
  if (conclusion === 'SUBJECT_NOT_ESTABLISHED') return EXIT_RUN_INPUT_UNUSABLE;
  if (conclusion === 'OBSERVATION_INCOMPLETE') return EXIT_RUN_REFUSED;
  // Exhaustive rather than a trailing `return`. A fifth conclusion would
  // otherwise inherit the success code silently, and this is the ladder that
  // decides what a caller reads as "settled" — the place a new member must not
  // be able to arrive at by falling off the end.
  if (conclusion === 'NOT_OBSERVED' || conclusion === 'OBSERVED') return EXIT_RUN_OK;
  const unreachable: never = conclusion;
  void unreachable;
  return EXIT_RUN_REFUSED;
}
