/**
 * From a selected task to an isolated workspace it can be implemented in.
 *
 * This is the V1-03 runtime boundary. It answers one question —
 *
 *     can this task be given a safe isolated workspace, and if so, what exact
 *     branch, worktree and base commit belong to it?
 *
 * — and it answers it by *doing* the smallest possible thing: one `git worktree
 * add`. It writes no state file, starts no agent, loads no context, runs no
 * verification and opens nothing on a forge. V1-04 persists and reconciles the
 * receipt produced here; everything after that is later still.
 *
 * ── The order of the checks is the design ──────────────────────────────────
 *
 * Every refusal below happens *before* anything is created, and each one names
 * a different way the world is not what a workspace needs it to be. That
 * ordering is what makes a refusal safe to act on: the repository is left
 * exactly as it was found, so "refused" always means "nothing happened", and
 * never "something happened, then failed".
 *
 * The one exception is post-create verification, which by definition runs after
 * the worktree exists. If it fails, the worktree this call created is removed
 * again — and if *that* removal does not succeed, the outcome says so with its
 * own code rather than reporting a clean refusal over a half-built workspace.
 *
 * ── Why the base commit is pinned, and pinned early ────────────────────────
 *
 * The base branch is read once, resolved to a full object name, and the
 * worktree is then created *at that object name* rather than at the branch. The
 * two are not the same thing. Between the read and the create, a concurrent
 * fetch, merge or reset can move the branch; a worktree created "at the branch"
 * would silently start from wherever it had got to, and the receipt would name
 * a commit the work is not actually based on. Creating at the captured OID
 * makes the receipt true by construction: post-create verification then
 * confirms `HEAD` is exactly that OID, so a branch that moved mid-flight
 * produces a refusal, never a workspace with a wrong base.
 *
 * ── What it does not decide ────────────────────────────────────────────────
 *
 * Whether the task *should* be worked on is V1-02's decision, and it is not
 * re-litigated here: this module never inspects `status`, `dependsOn` or
 * priority. Two places that both judge eligibility are two places that can
 * disagree, and the planner is the one that publishes its reasoning.
 */

import { lstatSync, mkdirSync, realpathSync } from 'node:fs';

import type { TaskDefinition } from '../plan/task-definition.js';
import { localBranchRef } from '../repo/branch-name.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { runGitCommand, type GitRunner } from './git-command.js';
import {
  deriveTaskWorkspaceIdentity,
  WORKSPACE_IDENTITY_FAILURE_CODES,
  type TaskWorkspaceIdentity,
} from './workspace-identity.js';
import { findByBranchRef, findByPath, listWorktrees, samePath } from './worktree-registry.js';

/**
 * A full Git object name.
 *
 * Deliberately a second copy of the pattern in
 * `core/internal/task-state-object-schema.ts` rather than an import: that
 * module is internal, and `tests/public-state-api.test.ts` exists to keep it
 * that way. The copies are held together by a test that compares them, so the
 * duplication cannot drift into two different notions of "a commit id".
 */
export const GIT_OBJECT_NAME_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Every way preparation can fail. A closed set, and total. */
export const WORKSPACE_PREPARATION_FAILURE_CODES = [
  ...WORKSPACE_IDENTITY_FAILURE_CODES,
  /** A Git command could not be run at all, or its argument was refused. */
  'GIT_UNAVAILABLE',
  /** The resolved root is not what Git considers this working tree's root. */
  'REPOSITORY_ROOT_MISMATCH',
  /** The repository is not on its declared default branch (or is detached). */
  'SOURCE_BRANCH_UNEXPECTED',
  /** The repository has uncommitted or untracked changes. */
  'SOURCE_WORKTREE_DIRTY',
  /** The declared default branch does not exist locally. */
  'BASE_BRANCH_NOT_FOUND',
  /** The base branch resolved to something that is not a full object name. */
  'BASE_COMMIT_UNRESOLVED',
  /** A branch with the derived name already exists. */
  'TASK_BRANCH_EXISTS',
  /** Something already exists at the derived worktree path. */
  'WORKTREE_PATH_OCCUPIED',
  /** Git already has a worktree registered at that path or for that branch. */
  'WORKTREE_ALREADY_REGISTERED',
  /** The directory that must hold the workspace could not be created. */
  'WORKTREE_PARENT_UNUSABLE',
  /** `git worktree add` refused or failed. Nothing was created. */
  'WORKTREE_CREATE_FAILED',
  /** The created worktree is not what was asked for; it was removed again. */
  'WORKTREE_VERIFICATION_FAILED',
  /** Verification failed *and* the created worktree could not be removed. */
  'WORKTREE_ROLLBACK_INCOMPLETE',
] as const;

export type WorkspacePreparationFailureCode =
  (typeof WORKSPACE_PREPARATION_FAILURE_CODES)[number];

const PREPARATION_DETAIL: Readonly<Record<WorkspacePreparationFailureCode, string>> = Object.freeze(
  {
    TASK_ID_INVALID: 'The task id is not a legal task identifier.',
    REPOSITORY_ROOT_UNSUITABLE:
      'The repository root is not an absolute path with a directory name of its own.',
    BASE_BRANCH_INVALID: 'The repository’s declared default branch is not a legal Git branch name.',
    TASK_BRANCH_NAME_INVALID:
      'The branch name derived from this task id is not a legal Git branch name.',
    WORKTREE_PATH_UNSAFE:
      'The derived worktree path cannot be passed to Git as an argument, or is not outside the repository.',
    GIT_UNAVAILABLE: 'A required Git command could not be completed.',
    REPOSITORY_ROOT_MISMATCH: 'Git reports a different working-tree root for the repository path.',
    SOURCE_BRANCH_UNEXPECTED:
      'The repository is not checked out on the default branch its profile declares.',
    SOURCE_WORKTREE_DIRTY:
      'The repository has uncommitted or untracked changes, so no base state can be pinned.',
    BASE_BRANCH_NOT_FOUND: 'The declared default branch does not exist in this repository.',
    BASE_COMMIT_UNRESOLVED: 'The declared default branch did not resolve to a full commit name.',
    TASK_BRANCH_EXISTS: 'A branch with the name derived for this task already exists.',
    WORKTREE_PATH_OCCUPIED: 'A filesystem object already exists at the derived worktree path.',
    WORKTREE_ALREADY_REGISTERED:
      'Git already registers a worktree at that path or for that branch.',
    WORKTREE_PARENT_UNUSABLE: 'The directory that must contain the worktree could not be created.',
    WORKTREE_CREATE_FAILED: 'Git refused to create the worktree; nothing was created.',
    WORKTREE_VERIFICATION_FAILED:
      'The created worktree did not match the requested branch, base commit or location, and was removed again.',
    WORKTREE_ROLLBACK_INCOMPLETE:
      'The created worktree failed verification and could not be removed again.',
  },
);

/**
 * The `WORKTREE_READY` receipt.
 *
 * Every field is one a `TaskState` will carry, spelled the same way, so V1-04
 * persists this value rather than re-deriving it from a second source of truth.
 */
export interface TaskWorkspace {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly baseBranch: string;
  /** Full object name the workspace was created at, and verified to be at. */
  readonly basePinnedCommit: string;
  readonly workBranch: string;
  /** Canonical absolute path, as Git reports it from inside the worktree. */
  readonly worktreePath: string;
  /** Verified at creation. A fresh worktree has nothing in it to be dirty. */
  readonly worktreeClean: boolean;
}

export interface WorkspacePreparationSuccess {
  readonly ok: true;
  readonly code: 'WORKTREE_READY';
  readonly workspace: TaskWorkspace;
}

export interface WorkspacePreparationFailure {
  readonly ok: false;
  readonly code: WorkspacePreparationFailureCode;
  /** A static sentence. Carries no host path, task text or Git output. */
  readonly detail: string;
  /**
   * Whether anything was created before the failure. `false` for every refusal
   * — which is all of them except a failed rollback.
   */
  readonly residue: boolean;
}

export type WorkspacePreparationResult =
  | WorkspacePreparationSuccess
  | WorkspacePreparationFailure;

export interface WorkspacePreparationOptions {
  /** The Git seam. Defaults to the real one. */
  readonly git?: GitRunner;
}

function preparationFailure(
  code: WorkspacePreparationFailureCode,
  residue = false,
): WorkspacePreparationFailure {
  return Object.freeze({
    ok: false as const,
    code,
    detail: PREPARATION_DETAIL[code],
    residue,
  });
}

/**
 * `true` when a filesystem object exists at `path` — a link included.
 *
 * `lstat`, not `stat`: the question is whether this *name* is taken, and a
 * dangling symlink takes the name just as effectively as a directory. Following
 * it first would answer about its target and report the name as free.
 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepares the isolated workspace for one selected task.
 *
 * Never throws for an expected condition. On success the worktree exists, is
 * checked out on the derived branch, sits at the pinned base commit, and has
 * been verified to be all three.
 */
export async function prepareTaskWorkspace(
  repository: ResolvedRepository,
  task: TaskDefinition,
  options: WorkspacePreparationOptions = {},
): Promise<WorkspacePreparationResult> {
  const git = options.git ?? runGitCommand;

  // --- 1. Identity, derived and validated before anything is touched -------
  // Every identity failure code is also a preparation failure code, by
  // construction of the closed set above — so the code passes through unmapped.
  const derived = deriveTaskWorkspaceIdentity(repository, task.id);
  if (!derived.ok) return preparationFailure(derived.code);
  const identity = derived.identity;

  // --- 2. Git preflight on the source repository ---------------------------
  const preflight = await runGitPreflight(git, identity);
  if (!preflight.ok) return preparationFailure(preflight.code);
  const basePinnedCommit = preflight.basePinnedCommit;

  // --- 3. Collisions -------------------------------------------------------
  const collision = await detectCollisions(git, identity);
  if (collision !== null) return preparationFailure(collision);

  // --- 4. Create -----------------------------------------------------------
  try {
    mkdirSync(identity.worktreeParent, { recursive: true });
  } catch {
    return preparationFailure('WORKTREE_PARENT_UNUSABLE');
  }

  const created = await git(identity.repositoryRoot, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    identity.workBranch,
    identity.worktreePath,
    basePinnedCommit,
  ]);
  if (created.outcome !== 'OK') {
    // Includes every lost race: a competitor that created the branch, the
    // directory or the registration between step 3 and here makes Git refuse,
    // and Git's refusal leaves nothing behind.
    return preparationFailure('WORKTREE_CREATE_FAILED');
  }

  // --- 5. Verify what was actually created ---------------------------------
  const verified = await verifyCreatedWorktree(git, identity, basePinnedCommit);
  if (!verified.ok) {
    const rolledBack = await rollBack(git, identity);
    return preparationFailure(
      rolledBack ? 'WORKTREE_VERIFICATION_FAILED' : 'WORKTREE_ROLLBACK_INCOMPLETE',
      !rolledBack,
    );
  }

  return Object.freeze({
    ok: true as const,
    code: 'WORKTREE_READY' as const,
    workspace: Object.freeze({
      repositoryId: identity.repositoryId,
      repositoryRoot: identity.repositoryRoot,
      taskId: identity.taskId,
      baseBranch: identity.baseBranch,
      basePinnedCommit,
      workBranch: identity.workBranch,
      worktreePath: verified.canonicalWorktreePath,
      worktreeClean: true,
    }),
  });
}

// ── Preflight ───────────────────────────────────────────────────────────────

type PreflightResult =
  | { readonly ok: true; readonly basePinnedCommit: string }
  | { readonly ok: false; readonly code: WorkspacePreparationFailureCode };

/**
 * The four questions that must all be answered before a base can be pinned.
 *
 * Ordered from "is this even the repository we think it is" outwards, so a
 * misconfigured root is never reported as a dirty tree.
 */
async function runGitPreflight(
  git: GitRunner,
  identity: TaskWorkspaceIdentity,
): Promise<PreflightResult> {
  const root = identity.repositoryRoot;

  const toplevel = await git(root, ['rev-parse', '--show-toplevel']);
  if (toplevel.outcome === 'UNAVAILABLE' || toplevel.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return { ok: false, code: 'GIT_UNAVAILABLE' };
  }
  if (toplevel.outcome !== 'OK' || !samePath(toplevel.stdout, root)) {
    return { ok: false, code: 'REPOSITORY_ROOT_MISMATCH' };
  }

  // `--quiet` turns a detached HEAD into a non-zero exit rather than an error
  // message, so "detached" and "on another branch" arrive as one condition:
  // neither is the declared base, and the difference does not change the answer.
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.outcome === 'UNAVAILABLE' || head.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return { ok: false, code: 'GIT_UNAVAILABLE' };
  }
  if (head.outcome !== 'OK' || head.stdout !== identity.baseBranch) {
    return { ok: false, code: 'SOURCE_BRANCH_UNEXPECTED' };
  }

  // Untracked files count. A file the orchestrator did not put there is a file
  // whose fate a later `git add --all` would decide silently.
  const status = await git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (status.outcome !== 'OK') return { ok: false, code: 'GIT_UNAVAILABLE' };
  if (status.stdout.length > 0) return { ok: false, code: 'SOURCE_WORKTREE_DIRTY' };

  const base = await git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    localBranchRef(identity.baseBranch),
  ]);
  if (base.outcome === 'UNAVAILABLE' || base.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return { ok: false, code: 'GIT_UNAVAILABLE' };
  }
  if (base.outcome !== 'OK') return { ok: false, code: 'BASE_BRANCH_NOT_FOUND' };
  if (!GIT_OBJECT_NAME_PATTERN.test(base.stdout)) {
    return { ok: false, code: 'BASE_COMMIT_UNRESOLVED' };
  }

  return { ok: true, basePinnedCommit: base.stdout };
}

// ── Collisions ──────────────────────────────────────────────────────────────

/**
 * Reports the first collision, or `null` when the workspace can be created.
 *
 * All three are checked even though `git worktree add` would refuse anyway: a
 * refusal that names *which* of the three is in the way is the difference
 * between "re-run after deleting the stale branch" and "something went wrong".
 */
async function detectCollisions(
  git: GitRunner,
  identity: TaskWorkspaceIdentity,
): Promise<WorkspacePreparationFailureCode | null> {
  const root = identity.repositoryRoot;

  const branch = await git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    localBranchRef(identity.workBranch),
  ]);
  if (branch.outcome === 'UNAVAILABLE' || branch.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return 'GIT_UNAVAILABLE';
  }
  if (branch.outcome === 'OK') return 'TASK_BRANCH_EXISTS';

  if (pathExists(identity.worktreePath)) return 'WORKTREE_PATH_OCCUPIED';

  const registry = await listWorktrees(git, root);
  if (!registry.ok) return 'GIT_UNAVAILABLE';
  if (findByPath(registry.entries, identity.worktreePath) !== null) {
    return 'WORKTREE_ALREADY_REGISTERED';
  }
  if (findByBranchRef(registry.entries, localBranchRef(identity.workBranch)) !== null) {
    return 'WORKTREE_ALREADY_REGISTERED';
  }

  return null;
}

// ── Post-create verification ────────────────────────────────────────────────

type VerificationResult =
  | { readonly ok: true; readonly canonicalWorktreePath: string }
  | { readonly ok: false };

/**
 * Confirms the created worktree is the one that was asked for.
 *
 * Four independent facts, all read from inside the new worktree: it is where it
 * was supposed to be, it is on the derived branch, it is at the pinned commit,
 * and it is clean. Anything else — including a base branch that moved between
 * the pin and the create — fails here rather than becoming a receipt.
 */
async function verifyCreatedWorktree(
  git: GitRunner,
  identity: TaskWorkspaceIdentity,
  basePinnedCommit: string,
): Promise<VerificationResult> {
  const path = identity.worktreePath;

  const toplevel = await git(path, ['rev-parse', '--show-toplevel']);
  if (toplevel.outcome !== 'OK' || !samePath(toplevel.stdout, path)) return { ok: false };

  const branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.outcome !== 'OK' || branch.stdout !== identity.workBranch) return { ok: false };

  const head = await git(path, ['rev-parse', '--verify', '--end-of-options', 'HEAD']);
  if (head.outcome !== 'OK' || head.stdout !== basePinnedCommit) return { ok: false };

  const status = await git(path, ['status', '--porcelain', '--untracked-files=all']);
  if (status.outcome !== 'OK' || status.stdout.length > 0) return { ok: false };

  // The canonical spelling of the path, resolved once the directory certainly
  // exists, so the receipt carries what every later comparison will observe.
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return { ok: false };
  }

  return { ok: true, canonicalWorktreePath: canonical };
}

/**
 * Undoes a workspace this call created, after its verification failed.
 *
 * Never forced. A worktree created seconds ago has nothing in it worth
 * protecting, but a `--force` here would be a general-purpose delete reachable
 * from a code path that has just proven it does not understand the state of the
 * repository — exactly when force is least appropriate. If the plain removal
 * does not work, the caller reports residue instead of pretending.
 */
async function rollBack(git: GitRunner, identity: TaskWorkspaceIdentity): Promise<boolean> {
  const removed = await git(identity.repositoryRoot, [
    'worktree',
    'remove',
    identity.worktreePath,
  ]);
  if (removed.outcome !== 'OK') return false;

  const branchDeleted = await git(identity.repositoryRoot, [
    'branch',
    '-d',
    '--',
    identity.workBranch,
  ]);
  return branchDeleted.outcome === 'OK';
}
