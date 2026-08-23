/**
 * Giving a task's workspace back — but only one this slice can prove it owns.
 *
 * Removal is the dangerous half of a lifecycle: preparation that goes wrong
 * costs a directory that should not be there, while removal that goes wrong
 * costs work that cannot be recovered. Everything below is shaped by that
 * asymmetry.
 *
 * ── Three proofs before anything is deleted ────────────────────────────────
 *
 *  1. **The name is re-derived, never accepted.** The caller passes a
 *     repository and a task, exactly as it did to prepare the workspace; the
 *     branch and path are computed again by the same pure function. There is no
 *     parameter for "the path to delete", so no caller can point this at a
 *     directory of its own choosing.
 *  2. **Git must agree the worktree is ours.** The path has to appear in `git
 *     worktree list` for *this* repository, with the derived task branch
 *     checked out in it. A directory that merely sits at the right path, and a
 *     registered worktree holding some other branch, are both refused — they
 *     are somebody else's, whatever their location.
 *  3. **Nothing unsaved may be destroyed.** The worktree must be clean, and the
 *     task branch must be an ancestor of the base branch — that is, contain no
 *     commit the base does not already have. Either check failing refuses the
 *     *whole* operation with the workspace still standing.
 *
 *     That promise is not kept here alone, and a review was right to say so.
 *     Content a `.gitignore` hides is closed one layer up, by
 *     `run/release-workspace.ts`, which runs its own ignored-content proof
 *     *before* calling this — and this module's cleanliness reading does not see
 *     it. Today that is sound because `releaseTaskWorkspace` is the only
 *     production caller (`grep -rn "removeTaskWorkspace" src/`). A **second**
 *     caller would reopen the route, so adding one means bringing the proof with
 *     it or moving it in here.
 *
 * ── Never forced ───────────────────────────────────────────────────────────
 *
 * `git worktree remove` without `--force` and `git branch -d` without `-D`.
 * The safe forms refuse exactly when something would be lost, which makes Git's
 * own refusal a fourth line of defence behind the three above rather than an
 * obstacle to route around. There is deliberately no option to force: a caller
 * that needs to discard real work should do it deliberately, with Git, not
 * through an orchestrator primitive.
 */

import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import {
  snapshotRepositoryRecord,
  verifyExecutionLeaseHeldFor,
} from '../lease/execution-lease.js';
import type { TaskDefinition } from '../plan/task-definition.js';
import { localBranchRef, LOCAL_BRANCH_REF_PREFIX } from '../repo/branch-name.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { classifyAncestry as classifyCommitAncestry } from './commit-probes.js';
import { runGitCommand, type GitRunner } from './git-command.js';
import { observeWorktreeCleanliness } from './worktree-cleanliness.js';
import {
  deriveTaskWorkspaceIdentity,
  isOwnedTaskBranch,
  WORKSPACE_IDENTITY_FAILURE_CODES,
} from './workspace-identity.js';
import { findByPath, listWorktrees } from './worktree-registry.js';

/** Every way removal can fail or be refused. A closed set. */
export const WORKSPACE_REMOVAL_FAILURE_CODES = [
  ...WORKSPACE_IDENTITY_FAILURE_CODES,
  /** A Git command could not be run at all, or its argument was refused. */
  'GIT_UNAVAILABLE',
  /**
   * Whether the worktree is clean could not be established.
   *
   * Added because a removal refused for a reason that was not a Git failure —
   * a directory that could not be listed, or `git submodule status` and the
   * index disagreeing about a path — was telling an operator "a required Git
   * command could not be completed" while every Git command had exited 0. The
   * operator then looks for a broken Git.
   *
   * **It does not mean "and Git ran fine".** A first version of this comment
   * claimed that distinction and a review measured it false: cleanliness is also
   * "not established" when the `status` call itself fails, which happens for a
   * worktree holding a malformed `.git` inside a gitlink. Two of the four ways
   * to reach `null` *are* Git failing. What this code separates is the
   * **question** that could not be answered, not the reason it could not be —
   * and the reason belongs in the probe, not in a removal outcome.
   *
   * All of it is a refusal and all of it is fail-closed. Only the sentence an
   * operator reads differs, and a false sentence about why AO stopped is a
   * defect here.
   */
  'WORKTREE_CLEANLINESS_UNKNOWN',
  /**
   * The caller does not hold this repository's execution lease *now*.
   *
   * Re-proved at each destructive command rather than inherited from the
   * caller: this is the boundary where a worktree and a branch are deleted, and
   * authority is a property of the moment the deletion happens.
   */
  'EXECUTION_LEASE_NOT_HELD',
  /**
   * Git does not register a worktree at the derived path for this repository,
   * or registers one holding a different branch. Nothing was touched.
   */
  'WORKTREE_NOT_OWNED',
  /** The worktree has uncommitted or untracked changes. Nothing was touched. */
  'WORKTREE_DIRTY',
  /**
   * The task branch holds commits the base branch does not — established, not
   * assumed. Nothing was touched.
   */
  'TASK_BRANCH_HAS_UNMERGED_WORK',
  /**
   * The base branch no longer resolves, so whether the task branch holds
   * unmerged work cannot be decided at all. Nothing was touched.
   */
  'BASE_BRANCH_NOT_FOUND',
  /** Git refused to remove the worktree. Nothing was removed. */
  'WORKTREE_REMOVE_FAILED',
] as const;

export type WorkspaceRemovalFailureCode = (typeof WORKSPACE_REMOVAL_FAILURE_CODES)[number];

const REMOVAL_DETAIL: Readonly<Record<WorkspaceRemovalFailureCode, string>> = Object.freeze({
  EXECUTION_LEASE_NOT_HELD:
    'This invocation does not hold the repository execution lease, so nothing was removed.',
  TASK_ID_INVALID: 'The task id is not a legal task identifier.',
  REPOSITORY_ROOT_UNSUITABLE:
    'The repository root is not an absolute path with a directory name of its own.',
  BASE_BRANCH_INVALID: 'The repository’s declared default branch is not a legal Git branch name.',
  TASK_BRANCH_NAME_INVALID:
    'The branch name derived from this task id is not a legal Git branch name.',
  WORKTREE_PATH_UNSAFE:
    'The derived worktree path cannot be passed to Git as an argument, or is not outside the repository.',
  GIT_UNAVAILABLE: 'A required Git command could not be completed.',
  WORKTREE_CLEANLINESS_UNKNOWN:
    'Whether the worktree holds uncommitted work could not be established, so nothing was removed.',
  WORKTREE_NOT_OWNED:
    'No worktree owned by this task is registered at the derived path, so nothing was removed.',
  WORKTREE_DIRTY: 'The worktree has uncommitted or untracked changes, so nothing was removed.',
  TASK_BRANCH_HAS_UNMERGED_WORK:
    'The task branch holds commits the base branch does not, so nothing was removed.',
  BASE_BRANCH_NOT_FOUND:
    'The declared base branch does not exist, so the task branch could not be shown to be safe to remove.',
  WORKTREE_REMOVE_FAILED: 'Git refused to remove the worktree.',
});

export interface WorkspaceRemovalSuccess {
  readonly ok: true;
  /**
   * `WORKSPACE_REMOVED` when both the worktree and the owned branch are gone.
   * `WORKSPACE_PARTIALLY_REMOVED` when the worktree went and the branch did
   * not — reported as its own outcome rather than as success, so a leftover
   * branch is never invisible.
   */
  readonly code: 'WORKSPACE_REMOVED' | 'WORKSPACE_PARTIALLY_REMOVED' | 'WORKSPACE_REMOVAL_LOST_LEASE';
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
}

export interface WorkspaceRemovalFailure {
  readonly ok: false;
  readonly code: WorkspaceRemovalFailureCode;
  /** A static sentence. Carries no host path, task text or Git output. */
  readonly detail: string;
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
}

export type WorkspaceRemovalResult = WorkspaceRemovalSuccess | WorkspaceRemovalFailure;

export interface WorkspaceRemovalOptions {
  /** The Git seam. Defaults to the real one. */
  readonly git?: GitRunner;
  /**
   * The execution lease, re-proved here at each destructive command.
   *
   * **Required**, and not defaulted. A caller that has proved the lease and then
   * spent several Git subprocesses reaching this function has proved it about a
   * moment that has passed — measured at 260 ms and three subprocesses for
   * `releaseTaskWorkspace`, with a successor legitimately acquiring inside the
   * gap and losing its worktree and branch anyway.
   */
  readonly lease: ExecutionLeaseEvidence;
}

function removalFailure(
  code: WorkspaceRemovalFailureCode,
  worktreeRemoved = false,
): WorkspaceRemovalFailure {
  return Object.freeze({
    ok: false as const,
    code,
    detail: REMOVAL_DETAIL[code],
    worktreeRemoved,
    branchRemoved: false,
  });
}

/**
 * What an ancestry probe established — including that it established nothing.
 *
 * `NOT_ANCESTOR` is an *answer*: Git evaluated the question and said no.
 * `BASE_BRANCH_NOT_FOUND` and `INDETERMINATE` are refusals to answer, and are
 * kept apart from it because "the base branch is gone" must never be reported
 * as "your task branch holds unmerged work" — that reason would be false, and a
 * false reason is worse than none.
 */
type AncestryVerdict = 'ANCESTOR' | 'NOT_ANCESTOR' | 'BASE_BRANCH_NOT_FOUND' | 'INDETERMINATE';

/**
 * Classifies `git merge-base --is-ancestor`, whose exit status *is* its answer.
 *
 * The exit-status protocol itself is read in exactly one place —
 * {@link classifyCommitAncestry} in `commit-probes.ts` — because "what does exit
 * 128 mean" must have one answer in this build, and this module having its own
 * copy of it was how a second one existed.
 *
 * What is local here is the *refinement*, not the protocol: on the
 * indeterminate branch, and only there, one extra command distinguishes the
 * common, actionable cause — the base branch no longer exists — from everything
 * else. That is why this verdict has a fourth member the shared one does not,
 * and why the happy path is still a single Git call.
 */
async function classifyAncestry(
  git: GitRunner,
  root: string,
  candidateRef: string,
  baseRef: string,
): Promise<AncestryVerdict> {
  const verdict = await classifyCommitAncestry(git, root, candidateRef, baseRef);
  if (verdict !== 'INDETERMINATE') return verdict;

  const base = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', baseRef]);
  if (base.outcome === 'NONZERO_EXIT') return 'BASE_BRANCH_NOT_FOUND';
  return 'INDETERMINATE';
}

/**
 * Removes the workspace belonging to one task, if it provably belongs to it.
 *
 * Never throws for an expected condition. Every failure leaves the workspace
 * exactly as it was, except {@link WorkspaceRemovalFailure} codes that say
 * otherwise through `worktreeRemoved`.
 */
export async function removeTaskWorkspace(
  given: ResolvedRepository,
  task: TaskDefinition,
  options: WorkspaceRemovalOptions,
): Promise<WorkspaceRemovalResult> {
  // The authority check lives *here*, at the destructive boundary, rather than
  // only in the caller.
  //
  // `releaseTaskWorkspace` proved the lease before calling this — and a review
  // measured three more Git subprocesses and 260 ms between that proof and the
  // `worktree remove` below, then lost the lease to a legitimate successor
  // inside the gap and watched its worktree and branch deleted anyway. A gate
  // in a caller is a gate at whatever distance the caller happens to have; a
  // gate here is a gate at the effect.
  const git = options.git ?? runGitCommand;

  // And one reading of the record, shared by that gate and the removal it
  // guards. A record whose `root` is an accessor answers B while the identity
  // below is derived — which is what `worktree remove` and `branch -d` are
  // aimed at — and A when the gate asks, so a review deleted a workspace in B
  // on a lease legitimately held over A. See `snapshotRepositoryRecord`.
  const repository = snapshotRepositoryRecord(given);

  const derived = deriveTaskWorkspaceIdentity(repository, task.id);
  if (!derived.ok) return removalFailure(derived.code);
  const identity = derived.identity;
  const root = identity.repositoryRoot;
  const workBranchRef = localBranchRef(identity.workBranch);

  // --- Proof 2: Git registers this exact path, holding our exact branch ----
  const registry = await listWorktrees(git, root);
  if (!registry.ok) return removalFailure('GIT_UNAVAILABLE');

  const registration = findByPath(registry.entries, identity.worktreePath);
  if (registration === null) return removalFailure('WORKTREE_NOT_OWNED');

  // Judged on the branch *Git reports*, not on a value derived here — a check
  // that compared the derived name with itself would always pass and prove
  // nothing. `isOwnedTaskBranch` requires both the reserved namespace and an
  // exact match, so a detached worktree (no branch at all) and one holding
  // somebody else's branch are refused by the same statement.
  const registeredBranch = registration.branchRef?.startsWith(LOCAL_BRANCH_REF_PREFIX)
    ? registration.branchRef.slice(LOCAL_BRANCH_REF_PREFIX.length)
    : null;
  if (registeredBranch === null || !isOwnedTaskBranch(identity, registeredBranch)) {
    return removalFailure('WORKTREE_NOT_OWNED');
  }

  // --- Proof 3a: nothing uncommitted in the worktree -----------------------
  //
  // Asked through {@link observeWorktreeCleanliness}, not through a bare
  // `status`, and that is a correction with a measured cost behind it.
  //
  // This gate stands in front of `git worktree remove`, which deletes the
  // checkout. A review measured that a writer can plant files inside an
  // **unpopulated** submodule directory where no `status` spelling looks, and
  // the remediation that found it hardened the two cleanliness *observers* and
  // left this one asking the blind question — on the reasoning that Git refuses
  // to remove a worktree containing a submodule anyway. That reasoning was taken
  // from one fixture and is **false** for the shape AO actually produces.
  //
  // Two attempts to say *why* were also wrong — "it is a property of population",
  // then "it turns on provenance and not population" — and both failed the same
  // way, by claiming an exclusive mechanism. So this is stated as sufficiency.
  // Measured, the unforced remove refuses when **either** holds:
  //
  //   a `<super>/.git/worktrees/<task>/modules` directory exists for this
  //     worktree, even an empty hand-made one  -> exit 128, and the gitlink may
  //                                               be unpopulated
  //   a gitlink path holds a real repository, with no `modules` directory
  //     anywhere                               -> exit 128
  //   neither                                  -> exit 0, worktree gone,
  //                                               planted files gone
  //
  // The last row is what `git worktree add` from a base commit leaves, which is
  // how every task worktree here is made. In it this gate is the only thing
  // standing, and that has been true under all three explanations.
  //
  // Reproduced end to end: the bare vector reported clean, `removeTaskWorkspace`
  // returned `WORKSPACE_REMOVED`, and two planted files were destroyed. So the
  // destructive path gets the probe, and "cannot establish" refuses rather than
  // proceeds — on this gate more than any other, because the cost of a wrong
  // clean reading here is deleted work rather than a withheld resume.
  //
  // `null` gets its own code: the *question* went unanswered. That covers a
  // directory that could not be listed and a listing the index contradicts —
  // both reachable with every Git call exiting 0 — and also a `status` that
  // failed outright, which is a Git failure. The code does not claim to tell
  // those apart; see its docstring.
  const clean = await observeWorktreeCleanliness(git, identity.worktreePath);
  if (clean === null) return removalFailure('WORKTREE_CLEANLINESS_UNKNOWN');
  if (!clean) return removalFailure('WORKTREE_DIRTY');

  // --- Proof 3b: nothing committed that the base does not already have -----
  // Checked *before* the worktree goes, not after: discovering unmerged work
  // once the checkout is gone would leave a branch whose commits no longer have
  // a working tree to be inspected in.
  const ancestry = await classifyAncestry(
    git,
    root,
    workBranchRef,
    localBranchRef(identity.baseBranch),
  );
  switch (ancestry) {
    case 'ANCESTOR':
      break;
    case 'NOT_ANCESTOR':
      return removalFailure('TASK_BRANCH_HAS_UNMERGED_WORK');
    case 'BASE_BRANCH_NOT_FOUND':
      return removalFailure('BASE_BRANCH_NOT_FOUND');
    case 'INDETERMINATE':
      return removalFailure('GIT_UNAVAILABLE');
  }

  // --- Remove, unforced ----------------------------------------------------
  const beforeRemoval = verifyExecutionLeaseHeldFor(repository, options.lease);
  if (beforeRemoval.code !== 'HELD') return removalFailure('EXECUTION_LEASE_NOT_HELD');

  const removed = await git(root, ['worktree', 'remove', identity.worktreePath]);
  if (removed.outcome !== 'OK') return removalFailure('WORKTREE_REMOVE_FAILED');

  // And again before the branch. One subprocess apart, and it is a second
  // destructive command: a lease lost between the two would otherwise still
  // delete the branch.
  const beforeBranch = verifyExecutionLeaseHeldFor(repository, options.lease);
  const branchDeleted =
    beforeBranch.code === 'HELD'
      ? await git(root, ['branch', '-d', '--', identity.workBranch])
      : null;
  const branchRemoved = branchDeleted !== null && branchDeleted.outcome === 'OK';

  return Object.freeze({
    ok: true as const,
    // Three endings, not two. A branch that survives because Git refused to
    // delete it and a branch that survives because *authority was lost midway*
    // are identical on disk and opposite in what they ask of an operator — and a
    // review found them sharing one code, one nominal outcome and exit 0, with
    // nothing anywhere naming the lease. Same collapse this slice fixed on the
    // start path, left open on the removal path.
    code: branchRemoved
      ? ('WORKSPACE_REMOVED' as const)
      : beforeBranch.code === 'HELD'
        ? ('WORKSPACE_PARTIALLY_REMOVED' as const)
        : ('WORKSPACE_REMOVAL_LOST_LEASE' as const),
    worktreeRemoved: true,
    branchRemoved,
  });
}
