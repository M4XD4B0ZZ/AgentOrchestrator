/**
 * The deterministic identity of a task's isolated workspace.
 *
 * Given a resolved repository and a selected task id, exactly one branch name
 * and exactly one directory belong to that task — and they are a pure function
 * of those two inputs. No timestamp, no counter, no random suffix, no
 * `process.cwd()`, nothing read from the filesystem. Calling this twice for the
 * same task always answers the same thing, which is what lets a later step
 * (V1-04's reconciliation) *re-derive* a workspace rather than having to trust a
 * path someone wrote down.
 *
 * ── Derived, then validated — never assumed ────────────────────────────────
 *
 * A task id is repository-authored text. It has already passed V1-02's grammar,
 * but that grammar was written for a *filename*, and a filename is not a branch
 * name: `V1..03`, `spec.lock` and `release.` are all legal task ids and none of
 * them is a legal Git branch. So the branch name is derived and then put
 * through the same `isValidBranchName` the repository profile's default branch
 * must pass. Anything that fails is refused with a typed code — never repaired,
 * never slugified. A silent rewrite would break the one property this module
 * exists to provide: that the identity can be re-derived and will match.
 *
 * The same applies to the path. It is handed to `git` as an argument, so it
 * must satisfy the argument boundary of `doctor/exec.ts` — which forbids
 * spaces. A repository checked out under `C:\Users\Ada Lovelace\src` therefore
 * cannot be given a workspace by this slice, and says so, rather than provoking
 * the `UnsafeArgumentError` that module documents as a programming error.
 *
 * ── Where the workspace lives ──────────────────────────────────────────────
 *
 *     <parent of root>/<basename of root>.worktrees/<task id>
 *
 * A *sibling* of the repository, never a directory inside it. Inside would put
 * a second checkout in the working tree the orchestrator is about to write to,
 * where it would show up in `git status`, in every glob a verification command
 * expands, and in the scope rules the profile declares. The sibling location is
 * derived from the root alone, so two repositories that happen to declare the
 * same task id land in two different places without either of them being known
 * to this code.
 */

import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import { isShellInertArgument } from '../doctor/exec.js';
import { isValidBranchName } from '../repo/branch-name.js';
import { isValidTaskId } from '../plan/task-id.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';

/**
 * The reserved branch namespace of orchestrator-owned task branches.
 *
 * Its job is ownership, not decoration: cleanup may only ever delete a branch
 * whose name it re-derived *and* which sits under this prefix, so a branch a
 * human created can never match by coincidence.
 */
export const TASK_BRANCH_PREFIX = 'ao/task/';

/** Suffix appended to the repository directory name to hold its worktrees. */
export const WORKTREE_DIRECTORY_SUFFIX = '.worktrees';

/** Every way an identity can fail to exist. A closed set. */
export const WORKSPACE_IDENTITY_FAILURE_CODES = [
  'TASK_ID_INVALID',
  'REPOSITORY_ROOT_UNSUITABLE',
  'BASE_BRANCH_INVALID',
  'TASK_BRANCH_NAME_INVALID',
  'WORKTREE_PATH_UNSAFE',
] as const;

export type WorkspaceIdentityFailureCode = (typeof WORKSPACE_IDENTITY_FAILURE_CODES)[number];

/**
 * Static sentences. As everywhere else in this codebase, a failure detail
 * carries no host path, no task text and no Git output: a refusal must not
 * become a side channel for the value the caller was not allowed to learn.
 */
const IDENTITY_DETAIL: Readonly<Record<WorkspaceIdentityFailureCode, string>> = Object.freeze({
  TASK_ID_INVALID: 'The task id is not a legal task identifier.',
  REPOSITORY_ROOT_UNSUITABLE:
    'The repository root is not an absolute path with a directory name of its own.',
  BASE_BRANCH_INVALID: 'The repository’s declared default branch is not a legal Git branch name.',
  TASK_BRANCH_NAME_INVALID:
    'The branch name derived from this task id is not a legal Git branch name.',
  WORKTREE_PATH_UNSAFE:
    'The derived worktree path cannot be passed to Git as an argument, or is not outside the repository.',
});

/** The one branch and the one directory that belong to a task. */
export interface TaskWorkspaceIdentity {
  readonly repositoryId: string;
  /** Canonical repository root, exactly as the resolver produced it. */
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** The profile-declared default branch the work is based on. */
  readonly baseBranch: string;
  /** Always under {@link TASK_BRANCH_PREFIX}. */
  readonly workBranch: string;
  /** Directory holding every workspace of this repository. */
  readonly worktreeParent: string;
  /** Absolute path of this task's workspace. */
  readonly worktreePath: string;
}

export interface WorkspaceIdentitySuccess {
  readonly ok: true;
  readonly identity: TaskWorkspaceIdentity;
}

export interface WorkspaceIdentityFailure {
  readonly ok: false;
  readonly code: WorkspaceIdentityFailureCode;
  /** A static sentence. Carries no host or repository data. */
  readonly detail: string;
}

export type WorkspaceIdentityResult = WorkspaceIdentitySuccess | WorkspaceIdentityFailure;

function identityFailure(code: WorkspaceIdentityFailureCode): WorkspaceIdentityFailure {
  return Object.freeze({ ok: false as const, code, detail: IDENTITY_DETAIL[code] });
}

/** `true` when `candidate` is `root` itself or lies beneath it. */
function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Derives the workspace identity for one task in one repository.
 *
 * Pure: it reads no file, starts no process and consults no clock. A failure
 * means the identity *cannot exist*, not that it does not exist yet.
 */
export function deriveTaskWorkspaceIdentity(
  repository: ResolvedRepository,
  taskId: string,
): WorkspaceIdentityResult {
  if (!isValidTaskId(taskId)) return identityFailure('TASK_ID_INVALID');

  const root = repository.root;
  if (!isAbsolute(root) || basename(root).length === 0) {
    return identityFailure('REPOSITORY_ROOT_UNSUITABLE');
  }

  const baseBranch = repository.defaultBranch;
  if (!isValidBranchName(baseBranch)) return identityFailure('BASE_BRANCH_INVALID');

  // Derive, then judge. `V1..03` and `spec.lock` are legal task ids and illegal
  // branch names; both are refused here rather than rewritten into something
  // that would no longer re-derive.
  const workBranch = `${TASK_BRANCH_PREFIX}${taskId}`;
  if (!isValidBranchName(workBranch)) return identityFailure('TASK_BRANCH_NAME_INVALID');

  const worktreeParent = join(dirname(root), `${basename(root)}${WORKTREE_DIRECTORY_SUFFIX}`);
  const worktreePath = join(worktreeParent, taskId);

  // Outside the repository, and expressible as a Git argument. Both are
  // structural conditions on the derived value, so both belong here rather
  // than to the step that would otherwise discover them by failing.
  if (isContained(root, worktreePath)) return identityFailure('WORKTREE_PATH_UNSAFE');
  if (!isShellInertArgument(worktreePath)) return identityFailure('WORKTREE_PATH_UNSAFE');
  if (!isShellInertArgument(worktreeParent)) return identityFailure('WORKTREE_PATH_UNSAFE');

  return Object.freeze({
    ok: true as const,
    identity: Object.freeze({
      repositoryId: repository.id,
      repositoryRoot: root,
      taskId,
      baseBranch,
      workBranch,
      worktreeParent,
      worktreePath,
    }),
  });
}

/**
 * `true` when `branch` is a branch this slice is allowed to delete.
 *
 * Ownership is proven by re-derivation, never by pattern-matching alone: the
 * name must sit in the reserved namespace *and* be exactly what
 * {@link deriveTaskWorkspaceIdentity} produces for this repository and task.
 */
export function isOwnedTaskBranch(identity: TaskWorkspaceIdentity, branch: string): boolean {
  return branch.startsWith(TASK_BRANCH_PREFIX) && branch === identity.workBranch;
}
