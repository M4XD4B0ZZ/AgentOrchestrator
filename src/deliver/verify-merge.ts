/**
 * Running the repository's canonical verification against the exact merge
 * commit a task's merge receipt names.
 *
 * ── The subject, and how it is chosen ──────────────────────────────────────
 *
 * **M = receipt.mergeCommit**, and there is no other route to it. Not a
 * command-line argument, not the tip of the base branch, not `origin/main`, not
 * the task's own `currentCommit`. The chain is:
 *
 *     task.currentCommit  ==  receipt.subjectCommit           (H, proved here)
 *     receipt.mergeCommit ==  workspace HEAD                  (M, proved in Git)
 *     workspace HEAD      ==  the tree the gate ran in        (one directory)
 *
 * Each link is checked, and the middle one twice: once by this ladder before
 * the gate starts, and once inside the mint, which cannot produce a proof at
 * all unless the proved HEAD equals the commit being attested. So a run against
 * another commit does not produce a weaker record — it produces **no record**.
 *
 * ── Why not "verify main" ──────────────────────────────────────────────────
 *
 * Because the base moves, and a verdict about wherever it has got to says
 * nothing about the commit this task's delivery produced. After the receipt
 * records M, the base can advance to X and then Y, or be force-pushed away
 * from M entirely; `main` passing is a fact about `main`. This slice is pinned
 * to an immutable object name for exactly as long as that object exists.
 *
 * ── Why the pull request's own CI is not this ──────────────────────────────
 *
 * Measured on this repository, on the pull request that delivered the slice
 * before this one. The workflow's checkout step carries no `ref:`, and the
 * runner's log for the run associated with head H reads:
 *
 *     git checkout --progress --force refs/remotes/pull/63/merge
 *     HEAD is now at c51d442 Merge 735eab7… into 309e5e6…
 *
 * while the check-run the API attaches to that job reports `head_sha` =
 * `735eab7…`. Three distinct objects: the head H the API names, the synthetic
 * merge commit S the runner actually built, and the squash commit M the merge
 * produced — `e203143…`, which no CI run had ever seen. After the merge,
 * `refs/pull/63/merge` no longer resolves at all, so S is not even retrievable.
 *
 * The general statement, which is what the code depends on: **`head_sha` is
 * what the forge attached to a run, and nothing AO reads reports what the
 * runner checked out.** Association is self-declared. So no workflow result is
 * accepted here as evidence about M, and there is no code path that could —
 * this module reads no check state, and runs the gate itself.
 *
 * ── What a result is, and is not ───────────────────────────────────────────
 *
 * A pass means: *at time T, commit M completed profile P successfully.* It does
 * not mean M is on the base branch now, that it is reachable from it, that the
 * merge is unreverted, or that the task is complete. See
 * `post-merge-verification.ts`, which states the four in full.
 *
 * ── What this never does ───────────────────────────────────────────────────
 *
 * No task state is written, no block-ledger entry is touched, no agent is
 * started, and nothing at all is sent to a forge — this module has no forge
 * seam. A failing verification triggers no revert, no branch, no issue and no
 * follow-up task; it is reported, and what to do about it is a decision this
 * slice deliberately does not make.
 */

import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import { snapshotRepositoryRecord, type LeaseRepository } from '../lease/execution-lease.js';
import type { ResolvedVerificationPolicy } from '../repo/resolve-repository.js';
import { runVerification, type VerificationReport } from '../verify/run-verification.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import { verificationProfileDigest } from '../verify/verification-profile.js';
import { commitObjectPresent } from '../worktree/commit-probes.js';
import type { GitRunner } from '../worktree/git-command.js';
import {
  createVerificationWorkspace,
  proveVerificationWorkspaceAt,
  deriveVerificationWorkspaceIdentity,
  removeVerificationWorkspace,
  workspaceIsGone,
  type VerificationWorkspaceCreationCode,
  type VerificationWorkspaceRemovalCode,
} from '../worktree/verification-workspace.js';
import { loadMergeReconciliation } from './merge-reconciliation-store.js';
import type { MergeReconciliationSubject } from './merge-reconciliation.js';
import { mintPostMergeVerification } from './internal/post-merge-verification-proof.js';
import type { PostMergeVerificationProof } from './post-merge-verification-proof.js';
import { hasPassFor, loadPostMergeVerification } from './post-merge-verification-store.js';

/**
 * The repository facts a verification reads.
 *
 * Narrowed to exactly these rather than taking `ResolvedRepository`, for the
 * reason `workspace-identity.ts` gives about its own input: a function that
 * accepted the whole resolved repository could quietly start depending on the
 * scope policy or the delivery target, and this one would stop being a
 * statement about the verification contract alone.
 */
export type VerificationRepository = LeaseRepository & {
  readonly verification: ResolvedVerificationPolicy;
};

/**
 * Everything one verification is about, from the task and the repository's own
 * delivery target. Never from a stored record and never from an argument.
 */
export interface VerificationSubject {
  readonly taskId: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /**
   * The task's implementation result — `TaskState.currentCommit`, **H**.
   *
   * Not the thing verified. It is what the receipt must agree with before its
   * merge commit is allowed to become the subject: a receipt whose
   * `subjectCommit` is some other commit is a receipt about some other
   * delivery, however well-formed it is.
   */
  readonly deliveryCommit: string;
}

export interface VerificationSeams {
  /**
   * The Git seam. **Must be lease-fenced in production** — `leasedGit` — for
   * the reason `loop/leased-spawns.ts` gives: `git worktree add` and
   * `git worktree remove` are productive spawns.
   */
  readonly git: GitRunner;
  /**
   * The verification seam. **Must be lease-fenced in production** —
   * `leasedVerify`. It is also the only way to obtain a production verification
   * runner at all: a static test makes `loop/leased-spawns.ts` the single value
   * importer of `verify/verify-command.js`, so an unfenced spawn here is not a
   * thing that can be written by accident.
   */
  readonly verify: VerificationRunner;
  /** The lease, re-proved inside every workspace effect. */
  readonly lease: ExecutionLeaseEvidence;
  /** The clock, for the instant the attempt started. */
  readonly now: () => Date;
}

/**
 * The closed vocabulary. Ordered as the ladder decides, weakest claim first.
 *
 * Every member says what could not be established and why it is not the member
 * beside it.
 */
export const MERGE_VERIFICATIONS = [
  /**
   * No subject was established, so there is nothing this could be about.
   *
   * The delivery target did not resolve, the task state could not be read, or
   * the task has no current commit. Produced by the caller's own refusal path,
   * the same arrangement slices 7 and 8 use.
   */
  'SUBJECT_NOT_ESTABLISHED',
  /** The task is not at the state a delivery is verified from. */
  'TASK_NOT_READY',
  /**
   * No merge receipt. **Not** a claim that the delivery was not merged — only
   * that AO has not reconciled one, which is `--reconcile-merge`'s job.
   */
  'RECEIPT_ABSENT',
  /**
   * A receipt is on disk and this build cannot read it as one: malformed, a
   * contract version it does not have, or bound to another task.
   */
  'RECEIPT_UNREADABLE',
  /**
   * A readable receipt that is not about this task's current delivery — its
   * `subjectCommit` is not the task's `currentCommit`, or it names a different
   * repository from the one the profile declares.
   *
   * Refused rather than followed. A receipt naming a real merge of a commit
   * this task no longer stands on would send the gate at somebody else's work.
   */
  'RECEIPT_NOT_THIS_DELIVERY',
  /**
   * A successful attempt for exactly this commit under exactly this profile is
   * already on disk, so the gate was not run again.
   *
   * It means **a historical successful verification exists**, never "M is
   * verified now" and never "M is currently good". A different profile is a
   * different question and is run.
   */
  'ALREADY_VERIFIED',
  /**
   * This repository could not confirm it holds the merge commit, so there is
   * nothing to check out.
   *
   * Deliberately **not** spelled "the object is absent". `commitObjectPresent`
   * answers `null` both for an object Git says is gone and for a question Git
   * refused to evaluate — an unreadable repository, or an object whose type it
   * would not name — and its own header says neither of those is "it is gone".
   * This member covers all of them, because the only thing that follows for
   * this ladder is the same in every case: no checkout can be made. An earlier
   * operator sentence here asserted absence, and a review measured it as saying
   * more than the probe establishes.
   *
   * This build does **not** go and get it. A network fetch is a new egress
   * surface with its own authority question, and the smallest honest answer
   * here is to stop and say the object could not be confirmed rather than to
   * reach for it. `git fetch` in the repository, then run this again.
   *
   * The previous sentence said "the smallest honest answer here is to say the
   * object is absent" — eight lines below the paragraph explaining that this
   * build deliberately does not say that. A review found the two halves of one
   * docblock contradicting each other, which is what a correction applied to
   * one half looks like.
   */
  'MERGE_COMMIT_UNAVAILABLE',
  /**
   * An isolated checkout at exactly M could not be established, so no gate was
   * started. Nothing was learned about the commit.
   */
  'WORKSPACE_NOT_ESTABLISHED',
  /**
   * The gate ran and this build declined to attest to the result.
   *
   * Reached when the mint declines what the gate produced. It is not claimed
   * to be unreachable, and an earlier version of this comment did claim that on
   * two grounds a review measured false: the HEAD proof is not "one line
   * before" — the whole declared gate runs between them, which on this
   * repository is minutes — and `runVerification` **can** produce a shape the
   * mint refuses, because an empty phase list yields `UNAVAILABLE` with
   * `stoppedAt: null`, which the mint reads as a non-pass that stopped nowhere.
   *
   * That shape is unrepresentable through `VerificationPolicySchema`, so it is
   * not expected in practice. This member is what an operator is told if it
   * arrives anyway: the gate ran, and this build declined to attest to it.
   */
  'VERIFICATION_NOT_ATTESTED',
  /**
   * The gate ran against exactly M and this build attests to how it ended.
   *
   * **Not** a claim that it passed. The proof carries the outcome, which is one
   * of `VERIFIED_PASS`, `VERIFIED_FAIL` or `VERIFICATION_NOT_ESTABLISHED`, and
   * this member is reached for all three: whether the repository said yes, said
   * no, or could not be asked is a property of the run, not of whether a run
   * happened.
   */
  'VERIFICATION_ATTEMPTED',
] as const;

export type MergeVerificationOutcome = (typeof MERGE_VERIFICATIONS)[number];

export const MERGE_VERIFICATION_DETAIL: Readonly<Record<MergeVerificationOutcome, string>> =
  Object.freeze({
    SUBJECT_NOT_ESTABLISHED: 'No delivery subject could be established for this task.',
    TASK_NOT_READY: 'The task is not at the state a delivery is verified from.',
    RECEIPT_ABSENT: 'No merge receipt has been recorded for this task.',
    RECEIPT_UNREADABLE: 'A merge receipt is present and this build cannot read it.',
    RECEIPT_NOT_THIS_DELIVERY:
      "The merge receipt is not about this task's current delivery.",
    ALREADY_VERIFIED:
      'A successful verification of this exact commit under this exact profile is already recorded.',
    MERGE_COMMIT_UNAVAILABLE:
      "This repository could not confirm it has the merge commit.",
    WORKSPACE_NOT_ESTABLISHED:
      'An isolated checkout at the exact merge commit could not be established.',
    VERIFICATION_NOT_ATTESTED:
      'The verification ran and this build declined to attest to the result.',
    VERIFICATION_ATTEMPTED: 'The canonical verification ran against the exact merge commit.',
  });

export interface MergeVerificationResult {
  readonly outcome: MergeVerificationOutcome;
  /**
   * The commit that was, or would have been, verified.
   *
   * Non-null from the line that reads a usable receipt onwards, and `null`
   * before it. Nothing else decides it.
   */
  readonly mergeCommit: string | null;
  /**
   * Which contract was, or would have been, run.
   *
   * Non-null from the same line, because the digest is computed from the
   * resolved repository and does not depend on the receipt — it is carried from
   * that point so a report can say what a refusal was measured against.
   */
  readonly profileDigest: string | null;
  /**
   * The report the gate produced, on `VERIFICATION_ATTEMPTED` and
   * `VERIFICATION_NOT_ATTESTED`, and `null` everywhere else.
   *
   * Diagnostics are deliberately **not** carried onward from here into
   * anything durable. See `post-merge-verification.ts`.
   */
  readonly report: VerificationReport | null;
  /**
   * The minted proof, on `VERIFICATION_ATTEMPTED` and on nothing else.
   *
   * The store refuses anything that is not one of these, so this field is the
   * only route from a run to a durable record.
   */
  readonly proof: PostMergeVerificationProof | null;
  /**
   * How the temporary workspace was disposed of, or `null` when none was made.
   *
   * Carried rather than swallowed: a workspace that could not be removed is
   * residue on the operator's disk, and a run that reported only its verdict
   * would leave them to find it.
   */
  readonly workspaceRemoval: VerificationWorkspaceRemovalCode | null;
  /**
   * Why an isolated workspace could not be established, or `null`.
   *
   * Carried because the operator documentation says it is. README and the ADR
   * both tell a reader that something already at the derived path "is reported
   * as `WORKSPACE_PATH_OCCUPIED` and left alone", and a review measured that
   * this result had no field for it: every creation failure collapsed into one
   * ladder member and the code was discarded. "Could not make a workspace" and
   * "something of yours is already there" send an operator to different places.
   */
  readonly workspaceFailure: VerificationWorkspaceCreationCode | null;
}

function outcome(
  code: MergeVerificationOutcome,
  mergeCommit: string | null = null,
  profileDigest: string | null = null,
  report: VerificationReport | null = null,
  proof: PostMergeVerificationProof | null = null,
  workspaceRemoval: VerificationWorkspaceRemovalCode | null = null,
  workspaceFailure: VerificationWorkspaceCreationCode | null = null,
): MergeVerificationResult {
  return Object.freeze({
    outcome: code,
    mergeCommit,
    profileDigest,
    report,
    proof,
    workspaceRemoval,
    workspaceFailure,
  });
}

/**
 * The refusal shape for the two members the caller owns.
 *
 * Exported so the two members the ladder cannot produce for itself have one
 * spelling, and so this module is the only place a `MergeVerificationResult` is
 * built at all. Two places that construct one type is two places that can
 * disagree about which fields a refusal carries — which is exactly what
 * happened: the command grew its own literal for a lease it could not take, and
 * then did not gain the field this result grew afterwards.
 * {@link refuseMergeVerificationUnleased} is that one, moved here.
 */
export function refuseMergeVerification(
  code: Extract<MergeVerificationOutcome, 'SUBJECT_NOT_ESTABLISHED' | 'TASK_NOT_READY'>,
): MergeVerificationResult {
  return outcome(code);
}

/**
 * The refusal for a run that never became this repository's writer.
 *
 * Built here rather than in the command, so that every `MergeVerificationResult`
 * with a `WORKSPACE_NOT_ESTABLISHED` outcome comes from one place and cannot
 * disagree with another about which fields a refusal carries. A review found
 * the command constructing this shape by hand while this module's own docblock
 * claimed it did not.
 */
export function refuseMergeVerificationUnleased(): MergeVerificationResult {
  return outcome('WORKSPACE_NOT_ESTABLISHED');
}

/**
 * Runs the canonical gate against the exact merge commit this task's receipt
 * names, and proves what was run against what.
 *
 * Never throws for an expected condition. The workspace it creates is removed
 * on every path that created one, including the failing ones.
 */
export async function verifyMergeForDelivery(
  repository: VerificationRepository,
  subject: VerificationSubject,
  seams: VerificationSeams,
): Promise<MergeVerificationResult> {
  // ONE reading of the record, and everything below uses it.
  //
  // `VerificationRepository` is a bare structural type, so nothing says its
  // fields are values. A record whose `root` is an accessor answers about
  // repository A when the workspace is derived and B when the receipt is
  // loaded; a `verification` getter answers policy P when the digest is
  // computed and Q when the gate runs — and the durable record would then name
  // a contract other than the one that ran. That is LF-2, which
  // `lease/execution-lease.ts` records as reproduced against
  // `prepareTaskWorkspace`, `removeTaskWorkspace` and `advanceTaskState` with
  // nothing forged anywhere. A review found this function reading `root` six
  // times and `verification` twice without it.
  const repo = snapshotRepositoryRecord(repository);

  const receiptSubject: MergeReconciliationSubject = Object.freeze({
    taskId: subject.taskId,
    repositoryRoot: repo.root,
  });

  // ── 1. The receipt is the only authority for the subject ─────────────────
  const stored = loadMergeReconciliation(repo.root, subject.taskId, receiptSubject);
  if (stored.reading === 'ABSENT') return outcome('RECEIPT_ABSENT');
  // Two conditions, and the second is redundant **today**, which is stated
  // rather than left to be discovered. `loadMergeReconciliation` returns a
  // non-null `receipt` on `HISTORICAL_MERGE` and on no other reading, so
  // dropping the reading test changes nothing this build can observe — a
  // counter-proof measured exactly that mutant surviving the whole suite.
  //
  // It stays because the redundancy is one-directional and free: if that load
  // result ever started handing back facts from a record it had refused, this
  // is the line that would keep them out. Its honest status is "unreachable
  // today, load-bearing if the loader changes".
  if (stored.reading !== 'HISTORICAL_MERGE' || stored.receipt === null) {
    return outcome('RECEIPT_UNREADABLE');
  }
  const receipt = stored.receipt;

  // ── 2. The receipt must be about this task's current delivery ────────────
  //
  // `subjectCommit` is the receipt's own record of the task's `currentCommit`
  // at reconciliation. If the task has moved since, this receipt describes a
  // delivery of a commit the task no longer stands on, and its merge commit is
  // not this task's subject any more.
  if (receipt.subjectCommit !== subject.deliveryCommit) {
    return outcome('RECEIPT_NOT_THIS_DELIVERY');
  }
  // Two forks can share a commit object name exactly, so the target identity is
  // part of the question rather than something assumed to follow from it.
  if (
    receipt.host !== subject.host ||
    receipt.owner !== subject.owner ||
    receipt.name !== subject.name
  ) {
    return outcome('RECEIPT_NOT_THIS_DELIVERY');
  }

  const mergeCommit = receipt.mergeCommit;
  const profileDigest = verificationProfileDigest(repo.verification);

  // ── 3. A historical pass under this exact profile is not re-run ──────────
  //
  // Structural, never temporal. A pass under a *different* profile does not
  // answer this profile's question and is run again; a pass under this one is
  // not made truer or falser by the passage of time, so there is no TTL here
  // and no age at which a record is discarded.
  const history = loadPostMergeVerification(repo.root, subject.taskId, {
    taskId: subject.taskId,
    repositoryRoot: repo.root,
  });
  if (
    history.reading === 'VERIFICATION_HISTORY' &&
    history.record !== null &&
    history.record.mergeCommit === mergeCommit &&
    hasPassFor(history.record, profileDigest)
  ) {
    return outcome('ALREADY_VERIFIED', mergeCommit, profileDigest);
  }

  // ── 4. The object has to be here. This build does not go and get it ──────
  const present = await commitObjectPresent(seams.git, repo.root, mergeCommit);
  if (present !== true) return outcome('MERGE_COMMIT_UNAVAILABLE', mergeCommit, profileDigest);

  // ── 5. An isolated, detached checkout at exactly M ───────────────────────
  const created = await createVerificationWorkspace(
    repo,
    subject.taskId,
    mergeCommit,
    { git: seams.git, lease: seams.lease },
  );
  if (!created.ok) {
    // The residue is carried, not discarded. A creation that made a checkout,
    // failed to prove it and then failed to undo it leaves a full tree on the
    // operator's disk, and an earlier version of this line reported that as
    // `workspaceRemoval: null` — whose own documentation says "none was made".
    return outcome(
      'WORKSPACE_NOT_ESTABLISHED',
      mergeCommit,
      profileDigest,
      null,
      null,
      // Every arm past `worktree add` undoes itself now, so `residue` means a
      // removal was attempted and did not clear a worktree Git had registered.
      created.residue ? 'REMOVAL_FAILED' : null,
      created.code,
    );
  }

  const attemptedAt = seams.now().toISOString();

  // ── 6. Prove HEAD again, immediately before the gate starts ──────────────
  //
  // Not a repetition of step 5's proof. That one described the moment the
  // worktree was made; this one describes the moment before a process is
  // started in it, and the two are separated by however long the steps between
  // them take. The same reasoning `prepare-workspace.ts` and
  // `remove-workspace.ts` both record after a review moved an effect out from
  // under its gate.
  const identity = deriveVerificationWorkspaceIdentity(repo.root, subject.taskId);
  if (!identity.ok) {
    const removal = await removeVerificationWorkspace(repo, subject.taskId, {
      git: seams.git,
      lease: seams.lease,
    });
    return outcome('WORKSPACE_NOT_ESTABLISHED', mergeCommit, profileDigest, null, null, removal.code);
  }
  const atCommit = await proveVerificationWorkspaceAt(seams.git, identity.identity, mergeCommit);
  if (atCommit.proof !== 'AT_COMMIT') {
    const removal = await removeVerificationWorkspace(repo, subject.taskId, {
      git: seams.git,
      lease: seams.lease,
    });
    return outcome('WORKSPACE_NOT_ESTABLISHED', mergeCommit, profileDigest, null, null, removal.code);
  }

  // ── 7. The canonical gate, in that directory and no other ────────────────
  //
  // `runVerification` is the repository's declared phase list, run in order,
  // once, with no retry.
  //
  // The path is the canonical spelling from the **creation** proof, not from
  // step 6's — an earlier comment said "the proof above", which reads as the
  // one immediately preceding it. They denote the same directory: step 6 runs
  // Git *inside* the derived path and its first probe refuses unless Git's own
  // `--show-toplevel` agrees with it, so a directory that answered step 6 is
  // the directory this path names. What matters for the gate is that neither
  // spelling was assembled by this function.
  const report = await runVerification(
    { worktreePath: created.workspace.workspacePath, verification: repo.verification },
    { verify: seams.verify },
  );

  // ── 8. Attest, binding the verdict to what Git said the tree was at ──────
  //
  // `atCommit.observedHead` is **Git's own reading**, taken by the probe in
  // step 6 — not the commit this function asked for, and not a value derived
  // from `mergeCommit`. That distinction is the whole of the mint's refusal:
  // two independent reviews measured an earlier version handing the requested
  // commit in for both fields, which made the comparison compare a value with
  // itself and could never fire on the production path.
  //
  // Non-null on `AT_COMMIT` by construction; the guard keeps a future change to
  // the proof result from silently reintroducing the argument.
  const proof =
    atCommit.observedHead === null
      ? null
      : mintPostMergeVerification({
          mergeCommit,
          workspaceHeadCommit: atCommit.observedHead,
          profileDigest,
          report,
          attemptedAt,
        });

  // ── 9. The workspace goes, on every path that made one ───────────────────
  const removal = await removeVerificationWorkspace(repo, subject.taskId, {
    git: seams.git,
    lease: seams.lease,
  });

  if (proof === null) {
    return outcome(
      'VERIFICATION_NOT_ATTESTED',
      mergeCommit,
      profileDigest,
      report,
      null,
      removal.code,
    );
  }

  return outcome(
    'VERIFICATION_ATTEMPTED',
    mergeCommit,
    profileDigest,
    report,
    proof,
    removal.code,
  );
}

/** Whether a removal left something on disk an operator has to deal with. */
export function verificationWorkspaceResidue(
  code: VerificationWorkspaceRemovalCode | null,
): boolean {
  return code !== null && !workspaceIsGone(code);
}
