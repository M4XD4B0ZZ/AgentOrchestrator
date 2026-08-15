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

import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import {
  snapshotRepositoryRecord,
  verifyExecutionLeaseHeldFor,
} from '../lease/execution-lease.js';
import type { TaskDefinition } from '../plan/task-definition.js';
import { localBranchRef } from '../repo/branch-name.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { commitObjectPresent } from './commit-probes.js';
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
  /**
   * A caller pinned this start to a commit, and the commit is not in this
   * repository.
   *
   * Kept apart from {@link BASE_BRANCH_NOT_FOUND}: that one says the repository
   * is misconfigured, and this one says the *caller* named a commit nothing here
   * has. An operator whose chained predecessor's result was pruned needs to be
   * told the second, and would go looking at their profile if told the first.
   */
  'BASE_COMMIT_ABSENT',
  /** Git could not evaluate whether the pinned base exists. Never an answer. */
  'BASE_COMMIT_UNREADABLE',
  /** A branch with the derived name already exists. */
  'TASK_BRANCH_EXISTS',
  /** Something already exists at the derived worktree path. */
  'WORKTREE_PATH_OCCUPIED',
  /** Git already has a worktree registered at that path or for that branch. */
  'WORKTREE_ALREADY_REGISTERED',
  /** The directory that must hold the workspace could not be created. */
  'WORKTREE_PARENT_UNUSABLE',
  /**
   * The caller does not hold this repository's execution lease *now*.
   *
   * Proved at the effect rather than inherited: creating a branch and a worktree
   * is a repository mutation, and authority is a property of the moment it
   * happens rather than of the moment the caller last looked.
   */
  'EXECUTION_LEASE_NOT_HELD',
  /** `git worktree add` refused or failed. Nothing was created. */
  'WORKTREE_CREATE_FAILED',
  /** The created worktree is not what was asked for; it was removed again. */
  'WORKTREE_VERIFICATION_FAILED',
  /** Verification failed *and* the created worktree could not be removed. */
  'WORKTREE_ROLLBACK_INCOMPLETE',
  /**
   * Verification failed and the lease was gone before the undo could run, so
   * nothing was deleted.
   *
   * Kept apart from {@link WORKTREE_ROLLBACK_INCOMPLETE}, which they resemble on
   * disk and not at all in what they mean. That one is Git declining to remove
   * something this call still owns. This one is this call having stopped being
   * the repository's writer — so the branch and the worktree may already belong
   * to a successor that legitimately adopted them, and removing them would
   * destroy somebody else's workspace rather than clean up its own.
   */
  'WORKTREE_ROLLBACK_NOT_AUTHORISED',
] as const;

export type WorkspacePreparationFailureCode =
  (typeof WORKSPACE_PREPARATION_FAILURE_CODES)[number];

const PREPARATION_DETAIL: Readonly<Record<WorkspacePreparationFailureCode, string>> = Object.freeze(
  {
    EXECUTION_LEASE_NOT_HELD:
      'This invocation does not hold the repository execution lease, so nothing was created.',
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
    BASE_COMMIT_ABSENT: 'The commit this task was to be built on is not in this repository.',
    BASE_COMMIT_UNREADABLE:
      'Git could not establish whether the commit this task was to be built on exists.',
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
    WORKTREE_ROLLBACK_NOT_AUTHORISED:
      'The created worktree failed verification and this invocation no longer holds the repository execution lease, so the undo stopped where it was. Whatever it had not already removed is still there.',
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

/**
 * Which commit a workspace is to be created at.
 *
 * ── Why this is told rather than read ──────────────────────────────────────
 *
 * For as long as every task started from the default branch, "the base" and
 * "the tip of the declared default branch" were the same sentence, and reading
 * the branch was the cheapest way to say it. A chained task breaks the identity:
 * it starts from its predecessor's result commit, which is on no branch anybody
 * declared. Folding that back into "read the branch" would make the workspace
 * receipt name a commit the work is not actually based on — and the receipt is
 * what the durable state, the scope delta and every later ancestry check are all
 * built from.
 *
 * So the base arrives as a value, and the two kinds are kept distinct rather
 * than collapsed into an optional commit: `DEFAULT_BRANCH_TIP` is a *question*
 * this module answers against the repository, and `PINNED_COMMIT` is an *answer*
 * the caller already has. An `undefined` standing for the first would make
 * "nobody said" and "the branch, please" the same input.
 */
export type WorkspaceBase =
  | { readonly kind: 'DEFAULT_BRANCH_TIP' }
  | { readonly kind: 'PINNED_COMMIT'; readonly commit: string };

export interface WorkspacePreparationOptions {
  /** The Git seam. Defaults to the real one. */
  readonly git?: GitRunner;
  /**
   * The commit to build on. **Required**, so every caller states its answer.
   *
   * Not defaulted to the default-branch tip: a caller that forgot to pass a
   * chained base would then silently get a workspace built on the wrong tree,
   * and the receipt would look exactly as convincing as a correct one.
   */
  readonly base: WorkspaceBase;
  /**
   * The execution lease, re-proved here immediately before the branch and the
   * worktree are created.
   *
   * **Required**, and for the reason `remove-workspace.ts` gives about its own
   * boundary: a gate in a caller is a gate at whatever distance the caller
   * happens to have. `startTask` proves the lease and then spends six Git
   * subprocesses — measured at 383 ms — reaching this function, and a review
   * released the lease inside that window and watched a branch and a worktree
   * land while a *successor* legitimately held the repository. The removal path
   * was given a gate at the effect and the creation path was not; this is that
   * asymmetry closed.
   */
  readonly lease: ExecutionLeaseEvidence;
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
  given: ResolvedRepository,
  task: TaskDefinition,
  options: WorkspacePreparationOptions,
): Promise<WorkspacePreparationResult> {
  const git = options.git ?? runGitCommand;

  // One reading of the record, and everything below uses it.
  //
  // The identity derived in step 1 is what every Git command here acts on, and
  // the gate in step 4 asks a *separate* question of the same record. A record
  // whose `root` is an accessor can answer B for the first and A for the second
  // — both truthfully, about two genuine repositories — and a review drove
  // exactly that: `git worktree add` created a branch and a worktree in B while
  // the gate proved a lease over A. See `snapshotRepositoryRecord`.
  const repository = snapshotRepositoryRecord(given);

  // --- 1. Identity, derived and validated before anything is touched -------
  // Every identity failure code is also a preparation failure code, by
  // construction of the closed set above — so the code passes through unmapped.
  const derived = deriveTaskWorkspaceIdentity(repository, task.id);
  if (!derived.ok) return preparationFailure(derived.code);
  const identity = derived.identity;

  // --- 2. Git preflight on the source repository ---------------------------
  const preflight = await proveSourcePreflight(git, identity, options.base);
  if (!preflight.ok) return preparationFailure(preflight.code);
  const basePinnedCommit = preflight.basePinnedCommit;

  // --- 3. Collisions -------------------------------------------------------
  const collision = await detectCollisions(git, identity);
  if (collision !== null) return preparationFailure(collision);

  // --- 4. Create -----------------------------------------------------------
  // Authority, at the effect. Everything above this line is a question; the
  // next statement is the first answer that changes the repository.
  const held = verifyExecutionLeaseHeldFor(repository, options.lease);
  if (held.code !== 'HELD') return preparationFailure('EXECUTION_LEASE_NOT_HELD');

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
  // Every way it can differ is the same refusal here: a worktree this call
  // created seconds ago and which is wrong in any respect is wrong. The finer
  // verdicts exist for `adopt-workspace.ts`, which asks about a worktree it did
  // not create.
  const verified = await verifyWorkspaceMatches(git, identity, basePinnedCommit);
  if (verified.verdict !== 'MATCHES' || verified.canonicalWorktreePath === null) {
    const rolledBack = await rollBack(git, identity, repository, options.lease);
    if (rolledBack === 'ROLLED_BACK') return preparationFailure('WORKTREE_VERIFICATION_FAILED');
    // Both remaining outcomes leave something behind, and both say so. What
    // separates them is whether removing it would still have been this call's to
    // do — which is the difference between "clean this up" and "do not touch it".
    return preparationFailure(
      rolledBack === 'NOT_AUTHORISED'
        ? 'WORKTREE_ROLLBACK_NOT_AUTHORISED'
        : 'WORKTREE_ROLLBACK_INCOMPLETE',
      true,
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

export type PreflightResult =
  | { readonly ok: true; readonly basePinnedCommit: string }
  | { readonly ok: false; readonly code: WorkspacePreparationFailureCode };

/**
 * The three checkout questions, and then the base itself.
 *
 * Ordered from "is this even the repository we think it is" outwards, so a
 * misconfigured root is never reported as a dirty tree.
 *
 * ── Two questions that used to be one ──────────────────────────────────────
 *
 * The checkout questions are about the *source repository* and are asked
 * whatever the base is: a dirty or wandering checkout is the wrong place to
 * create anything from, and that is true of a chained start exactly as it is of
 * a root one. The base is the separate question, and it is now **told** rather
 * than assumed — see {@link WorkspaceBase}.
 *
 * Exported because adoption needs the *same* answers and the same pinned commit
 * (V2-06A): a workspace may only be adopted if the source checkout still
 * satisfies every invariant a fresh start would have required of it, and the
 * commit an orphan must be sitting at is precisely the one a fresh start would
 * have pinned. Re-deriving that elsewhere would be a second opinion about what
 * "the base" is.
 */
export async function proveSourcePreflight(
  git: GitRunner,
  identity: TaskWorkspaceIdentity,
  base: WorkspaceBase,
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

  // A pinned base is not looked up in a branch, and it is not believed either:
  // the object must be a commit that this repository really holds, or the
  // `worktree add` below would fail with Git's own message instead of a typed
  // refusal an operator can act on.
  if (base.kind === 'PINNED_COMMIT') {
    const present = await commitObjectPresent(git, root, base.commit);
    if (present === null) return { ok: false, code: 'BASE_COMMIT_UNREADABLE' };
    if (!present) return { ok: false, code: 'BASE_COMMIT_ABSENT' };
    return { ok: true, basePinnedCommit: base.commit };
  }

  const resolved = await git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    localBranchRef(identity.baseBranch),
  ]);
  if (resolved.outcome === 'UNAVAILABLE' || resolved.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return { ok: false, code: 'GIT_UNAVAILABLE' };
  }
  if (resolved.outcome !== 'OK') return { ok: false, code: 'BASE_BRANCH_NOT_FOUND' };
  if (!GIT_OBJECT_NAME_PATTERN.test(resolved.stdout)) {
    return { ok: false, code: 'BASE_COMMIT_UNRESOLVED' };
  }

  return { ok: true, basePinnedCommit: resolved.stdout };
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

// ── Worktree verification ───────────────────────────────────────────────────

/**
 * Whether a worktree on disk is the one an identity describes, and if not, in
 * which respect it differs. A closed set.
 *
 * The members are finer-grained than *this* module needs — preparation treats
 * every one of them as the same refusal, because a worktree it created seconds
 * ago that is wrong in any respect is wrong. They are distinguished because
 * `adopt-workspace.ts` asks the same question of a worktree it did **not**
 * create, where "the branch is somebody else's", "somebody committed to it" and
 * "there is an untracked file in it" send an operator to three different places
 * (V2-06A).
 *
 * One implementation, two vocabularies. A second copy of these four probes
 * would be a second opinion about what "this workspace is ours and untouched"
 * means, and the two would drift.
 */
export const WORKSPACE_MATCH_VERDICTS = [
  /** Right place, right branch, right commit, nothing in it. */
  'MATCHES',
  /** Git reports a different working-tree root, or the path cannot be resolved. */
  'PATH_MISMATCH',
  /** A different branch is checked out, or HEAD is detached. */
  'BRANCH_MISMATCH',
  /** The branch is there and its tip is not the expected commit. */
  'HEAD_MISMATCH',
  /** Tracked files are modified, staged or deleted. */
  'DIRTY',
  /** Nothing tracked has changed, and there are untracked files present. */
  'UNTRACKED_CONTENT',
  /**
   * The directory is a worktree of a *different* repository.
   *
   * The one mismatch that cannot be seen from either side alone: the source's
   * registry and the worktree's own answers are consistent, and belong to two
   * different Gits. See {@link verifyWorkspaceMatches}.
   */
  'FOREIGN_REPOSITORY',
  /** A probe could not be run at all, so nothing was established. */
  'UNREADABLE',
] as const;

export type WorkspaceMatchVerdict = (typeof WORKSPACE_MATCH_VERDICTS)[number];

export interface WorkspaceMatchResult {
  readonly verdict: WorkspaceMatchVerdict;
  /** Canonical path as the filesystem spells it. Only on `MATCHES`. */
  readonly canonicalWorktreePath: string | null;
}

function matchResult(
  verdict: WorkspaceMatchVerdict,
  canonicalWorktreePath: string | null = null,
): WorkspaceMatchResult {
  return Object.freeze({ verdict, canonicalWorktreePath });
}

/**
 * A porcelain line is an untracked entry exactly when its status field is `??`.
 *
 * Split rather than counted, because "somebody edited a tracked file here" and
 * "somebody left a file lying about" are different facts about whose worktree
 * this is, and only the first can destroy work.
 */
function classifyStatus(porcelain: string): 'CLEAN' | 'DIRTY' | 'UNTRACKED_CONTENT' {
  const lines = porcelain.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return 'CLEAN';
  return lines.every((line) => line.startsWith('??')) ? 'UNTRACKED_CONTENT' : 'DIRTY';
}

/**
 * Confirms a worktree is the one `identity` describes, at `expectedCommit`.
 *
 * Four independent facts, all read from inside the worktree itself: it is where
 * it was supposed to be, it is on the derived branch, it is at the expected
 * commit, and nothing has been done in it. Nothing here trusts a path the
 * caller supplied — `identity` is re-derived by a pure function, and every
 * answer comes from Git run *in* that directory.
 */
export async function verifyWorkspaceMatches(
  git: GitRunner,
  identity: TaskWorkspaceIdentity,
  expectedCommit: string,
): Promise<WorkspaceMatchResult> {
  const path = identity.worktreePath;

  const toplevel = await git(path, ['rev-parse', '--show-toplevel']);
  if (toplevel.outcome !== 'OK') return matchResult('UNREADABLE');
  if (!samePath(toplevel.stdout, path)) return matchResult('PATH_MISMATCH');

  // Which Git is answering here?
  //
  // Every other probe below asks the repository *at this path* about itself,
  // and every one of them can be satisfied by a repository that is not ours.
  // The caller's registry check — "the source lists this path, holding this
  // branch" — reads the **source's** administrative files, which survive the
  // directory underneath being replaced. So the two halves of the ownership
  // proof can each pass while describing two different repositories: a worktree
  // of a clone, parked at the same path, on a branch of the same name, at the
  // same commit, answers every question correctly and is still not ours
  // (V2-06A review). Adopting it produces a state naming this repository while
  // every commit lands in the other one, and reconciliation re-reads the same
  // wrong place, so it never diverges.
  //
  // The common directory is what joins them: two worktrees of one repository
  // share it, and no two repositories do.
  const commonDir = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const sourceCommonDir = await git(identity.repositoryRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (commonDir.outcome !== 'OK' || sourceCommonDir.outcome !== 'OK') {
    return matchResult('UNREADABLE');
  }
  if (!samePath(commonDir.stdout, sourceCommonDir.stdout)) {
    return matchResult('FOREIGN_REPOSITORY');
  }

  const branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  // A detached HEAD exits non-zero under `--quiet`, which is a branch mismatch
  // rather than an unreadable repository: there is no branch, and this workspace
  // is required to be on one.
  if (branch.outcome === 'UNAVAILABLE' || branch.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return matchResult('UNREADABLE');
  }
  if (branch.outcome !== 'OK' || branch.stdout !== identity.workBranch) {
    return matchResult('BRANCH_MISMATCH');
  }

  const head = await git(path, ['rev-parse', '--verify', '--end-of-options', 'HEAD']);
  if (head.outcome !== 'OK') return matchResult('UNREADABLE');
  if (head.stdout !== expectedCommit) return matchResult('HEAD_MISMATCH');

  const status = await git(path, ['status', '--porcelain', '--untracked-files=all']);
  if (status.outcome !== 'OK') return matchResult('UNREADABLE');
  const cleanliness = classifyStatus(status.stdout);
  if (cleanliness !== 'CLEAN') return matchResult(cleanliness);

  // The canonical spelling of the path, resolved once the directory certainly
  // exists, so the receipt carries what every later comparison will observe.
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return matchResult('UNREADABLE');
  }

  return matchResult('MATCHES', canonical);
}

/** What an undo did. Never a boolean: "nothing removed" has two opposite causes. */
type RollBackOutcome = 'ROLLED_BACK' | 'INCOMPLETE' | 'NOT_AUTHORISED';

/**
 * Undoes a workspace this call created, after its verification failed.
 *
 * Never forced. A worktree created seconds ago has nothing in it worth
 * protecting, but a `--force` here would be a general-purpose delete reachable
 * from a code path that has just proven it does not understand the state of the
 * repository — exactly when force is least appropriate. If the plain removal
 * does not work, the caller reports residue instead of pretending.
 *
 * ── Why the lease is proved here, twice, and not by the caller ──────────────
 *
 * This is the second destructive site in the module and it had no gate at all.
 * The creation gate above was the nearest proof, and between it and these two
 * commands lie `git worktree add` — seconds on a cold checkout — and the six
 * probes of {@link verifyWorkspaceMatches}. That is a *wider* window than the
 * one that was judged unacceptable for creation, on the very two commands
 * `remove-workspace.ts` gates one at a time.
 *
 * A review drove it end to end: lose the lease after `worktree add`, let a
 * successor acquire the repository and adopt the pristine orphan, then fail
 * verification here. Both commands ran, and deleted a workspace and a branch the
 * successor legitimately owned. Nothing in the report named the lease.
 *
 * The failure it can still reach is a *lost* one, and the reachable trigger is
 * ordinary: any of the six probes answering `UNAVAILABLE`, or a fresh worktree
 * that reads dirty — which this repository's own fixtures record production Git
 * doing under a system-wide `core.autocrlf=true`.
 */
async function rollBack(
  git: GitRunner,
  identity: TaskWorkspaceIdentity,
  repository: ResolvedRepository,
  lease: ExecutionLeaseEvidence,
): Promise<RollBackOutcome> {
  const authorised = (): boolean =>
    verifyExecutionLeaseHeldFor(repository, lease).code === 'HELD';

  if (!authorised()) return 'NOT_AUTHORISED';
  const removed = await git(identity.repositoryRoot, [
    'worktree',
    'remove',
    identity.worktreePath,
  ]);
  if (removed.outcome !== 'OK') return 'INCOMPLETE';

  // Re-proved between the two, for the reason the whole slice re-proves things:
  // the first command is a subprocess, and authority is a property of the moment
  // an effect happens rather than of the moment before the previous one.
  if (!authorised()) return 'NOT_AUTHORISED';
  const branchDeleted = await git(identity.repositoryRoot, [
    'branch',
    '-d',
    '--',
    identity.workBranch,
  ]);
  return branchDeleted.outcome === 'OK' ? 'ROLLED_BACK' : 'INCOMPLETE';
}
