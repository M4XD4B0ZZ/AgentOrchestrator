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

import type { TaskDefinition } from '../plan/task-definition.js';
import { localBranchRef } from '../repo/branch-name.js';
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
   * Git does not register a worktree at the derived path for this repository,
   * or registers one holding a different branch. Nothing was touched.
   */
  'WORKTREE_NOT_OWNED',
  /** The worktree has uncommitted or untracked changes. Nothing was touched. */
  'WORKTREE_DIRTY',
  /** The task branch holds commits the base branch does not. Nothing was touched. */
  'TASK_BRANCH_HAS_UNMERGED_WORK',
  /** Git refused to remove the worktree. Nothing was removed. */
  'WORKTREE_REMOVE_FAILED',
] as const;

export type WorkspaceRemovalFailureCode = (typeof WORKSPACE_REMOVAL_FAILURE_CODES)[number];

const REMOVAL_DETAIL: Readonly<Record<WorkspaceRemovalFailureCode, string>> = Object.freeze({
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
  readonly code: 'WORKSPACE_REMOVED' | 'WORKSPACE_PARTIALLY_REMOVED';
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
 * Removes the workspace belonging to one task, if it provably belongs to it.
 *
 * Never throws for an expected condition. Every failure leaves the workspace
 * exactly as it was, except {@link WorkspaceRemovalFailure} codes that say
 * otherwise through `worktreeRemoved`.
 */
export async function removeTaskWorkspace(
  repository: ResolvedRepository,
  task: TaskDefinition,
  options: WorkspaceRemovalOptions = {},
): Promise<WorkspaceRemovalResult> {
  const git = options.git ?? runGitCommand;

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
  if (registration.branchRef !== workBranchRef) return removalFailure('WORKTREE_NOT_OWNED');
  if (!isOwnedTaskBranch(identity, identity.workBranch)) {
    // Unreachable while the derivation is what it is; kept as a floor so that
    // loosening the naming rule later cannot silently widen what may be deleted.
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
  const ancestor = await git(root, [
    'merge-base',
    '--is-ancestor',
    '--end-of-options',
    workBranchRef,
    localBranchRef(identity.baseBranch),
  ]);
  if (ancestor.outcome === 'UNAVAILABLE' || ancestor.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return removalFailure('GIT_UNAVAILABLE');
  }
  if (ancestor.outcome !== 'OK') return removalFailure('TASK_BRANCH_HAS_UNMERGED_WORK');

  // --- Remove, unforced ----------------------------------------------------
  const removed = await git(root, ['worktree', 'remove', identity.worktreePath]);
  if (removed.outcome !== 'OK') return removalFailure('WORKTREE_REMOVE_FAILED');

  const branchDeleted = await git(root, ['branch', '-d', '--', identity.workBranch]);
  const branchRemoved = branchDeleted.outcome === 'OK';

  return Object.freeze({
    ok: true as const,
    code: branchRemoved
      ? ('WORKSPACE_REMOVED' as const)
      : ('WORKSPACE_PARTIALLY_REMOVED' as const),
    worktreeRemoved: true,
    branchRemoved,
  });
}
