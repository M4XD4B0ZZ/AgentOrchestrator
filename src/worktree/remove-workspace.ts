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
import { runGitCommand, type GitRunner } from './git-command.js';
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
 * The protocol this relies on, stated explicitly because it is the one place in
 * this slice that reads an exit code:
 *
 *   - **0** — `candidateRef` is an ancestor of `baseRef`;
 *   - **1** — it is not. A real answer, and the only non-zero one that is;
 *   - **anything else** (128 in practice) — Git could not evaluate the
 *     question: a ref that does not resolve, a broken repository, a bad
 *     invocation. Never an answer.
 *
 * On that third branch, and only there, one extra command distinguishes the
 * common, actionable cause — the base branch no longer exists — from everything
 * else. The happy path stays a single Git call.
 */
async function classifyAncestry(
  git: GitRunner,
  root: string,
  candidateRef: string,
  baseRef: string,
): Promise<AncestryVerdict> {
  const probe = await git(root, [
    'merge-base',
    '--is-ancestor',
    '--end-of-options',
    candidateRef,
    baseRef,
  ]);
  if (probe.outcome === 'OK') return 'ANCESTOR';
  if (probe.outcome === 'NONZERO_EXIT' && probe.exitCode === 1) return 'NOT_ANCESTOR';

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
  const status = await git(identity.worktreePath, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (status.outcome !== 'OK') return removalFailure('GIT_UNAVAILABLE');
  if (status.stdout.length > 0) return removalFailure('WORKTREE_DIRTY');

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
