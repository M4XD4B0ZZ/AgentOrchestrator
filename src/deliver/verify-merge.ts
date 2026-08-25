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
import type { LeaseRepository } from '../lease/execution-lease.js';
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
   * The merge commit is not in this repository's object database, so there is
   * nothing to check out.
   *
   * This build does **not** fetch it. See the module note in the command: a
   * network fetch is a new egress surface with its own authority question, and
   * the smallest honest answer here is to say the object is absent rather than
   * to reach for it. `git fetch` in the repository, then run this again.
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
   * Unreachable through this ladder — the workspace HEAD is proved equal to M
   * one line before the mint is asked, and the mint's other refusals are all
   * shapes `runVerification` cannot produce. It exists so that a future change
   * which broke that agreement would surface as a refusal rather than as a
   * record nobody minted.
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
      "The merge commit is not in this repository's object database.",
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
}

function outcome(
  code: MergeVerificationOutcome,
  mergeCommit: string | null = null,
  profileDigest: string | null = null,
  report: VerificationReport | null = null,
  proof: PostMergeVerificationProof | null = null,
  workspaceRemoval: VerificationWorkspaceRemovalCode | null = null,
): MergeVerificationResult {
  return Object.freeze({
    outcome: code,
    mergeCommit,
    profileDigest,
    report,
    proof,
    workspaceRemoval,
  });
}

/**
 * The refusal shape for the two members the caller owns.
 *
 * Exported so the command does not build a result object of its own: two places
 * that construct the same type is two places that can disagree about which
 * fields a refusal carries.
 */
export function refuseMergeVerification(
  code: Extract<MergeVerificationOutcome, 'SUBJECT_NOT_ESTABLISHED' | 'TASK_NOT_READY'>,
): MergeVerificationResult {
  return outcome(code);
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
  const receiptSubject: MergeReconciliationSubject = Object.freeze({
    taskId: subject.taskId,
    repositoryRoot: repository.root,
  });

  // ── 1. The receipt is the only authority for the subject ─────────────────
  const stored = loadMergeReconciliation(repository.root, subject.taskId, receiptSubject);
  if (stored.reading === 'ABSENT') return outcome('RECEIPT_ABSENT');
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
  const profileDigest = verificationProfileDigest(repository.verification);

  // ── 3. A historical pass under this exact profile is not re-run ──────────
  //
  // Structural, never temporal. A pass under a *different* profile does not
  // answer this profile's question and is run again; a pass under this one is
  // not made truer or falser by the passage of time, so there is no TTL here
  // and no age at which a record is discarded.
  const history = loadPostMergeVerification(repository.root, subject.taskId, {
    taskId: subject.taskId,
    repositoryRoot: repository.root,
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
  const present = await commitObjectPresent(seams.git, repository.root, mergeCommit);
  if (present !== true) return outcome('MERGE_COMMIT_UNAVAILABLE', mergeCommit, profileDigest);

  // ── 5. An isolated, detached checkout at exactly M ───────────────────────
  const created = await createVerificationWorkspace(
    repository,
    subject.taskId,
    mergeCommit,
    { git: seams.git, lease: seams.lease },
  );
  if (!created.ok) return outcome('WORKSPACE_NOT_ESTABLISHED', mergeCommit, profileDigest);

  const attemptedAt = seams.now().toISOString();

  // ── 6. Prove HEAD again, immediately before the gate starts ──────────────
  //
  // Not a repetition of step 5's proof. That one described the moment the
  // worktree was made; this one describes the moment before a process is
  // started in it, and the two are separated by however long the steps between
  // them take. The same reasoning `prepare-workspace.ts` and
  // `remove-workspace.ts` both record after a review moved an effect out from
  // under its gate.
  const identity = deriveVerificationWorkspaceIdentity(repository.root, subject.taskId);
  if (!identity.ok) {
    const removal = await removeVerificationWorkspace(repository, subject.taskId, {
      git: seams.git,
      lease: seams.lease,
    });
    return outcome('WORKSPACE_NOT_ESTABLISHED', mergeCommit, profileDigest, null, null, removal.code);
  }
  const atCommit = await proveVerificationWorkspaceAt(seams.git, identity.identity, mergeCommit);
  if (atCommit.proof !== 'AT_COMMIT') {
    const removal = await removeVerificationWorkspace(repository, subject.taskId, {
      git: seams.git,
      lease: seams.lease,
    });
    return outcome('WORKSPACE_NOT_ESTABLISHED', mergeCommit, profileDigest, null, null, removal.code);
  }

  // ── 7. The canonical gate, in that directory and no other ────────────────
  //
  // `runVerification` is the repository's declared phase list, run in order,
  // once, with no retry. The path it is given is the workspace's own canonical
  // spelling, taken from the proof above rather than from anything this
  // function assembled.
  const report = await runVerification(
    { worktreePath: created.workspace.workspacePath, verification: repository.verification },
    { verify: seams.verify },
  );

  // ── 8. Attest, binding the verdict to the commit that was proved ─────────
  const proof = mintPostMergeVerification({
    mergeCommit,
    // From the proof, not from the variable above. Handing the same value in
    // twice would make the mint's comparison compare a value with itself.
    workspaceHeadCommit: created.workspace.headCommit,
    profileDigest,
    report,
    attemptedAt,
  });

  // ── 9. The workspace goes, on every path that made one ───────────────────
  const removal = await removeVerificationWorkspace(repository, subject.taskId, {
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
