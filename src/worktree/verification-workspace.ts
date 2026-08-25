/**
 * A disposable, detached checkout at one exact commit — the place a
 * post-merge verification runs.
 *
 * ── Why this is not `prepare-workspace.ts` ─────────────────────────────────
 *
 * A task workspace and a verification workspace answer different questions, and
 * three properties of the first make it unusable for the second rather than
 * merely inconvenient:
 *
 *  - **it is on a branch.** `prepare-workspace.ts` builds `ao/task/<taskId>`
 *    and `verifyWorkspaceMatches` requires `symbolic-ref --short HEAD` to equal
 *    it, so a detached HEAD is `BRANCH_MISMATCH` *by design*. The subject here
 *    is a commit object, not a line of development, and putting a branch on it
 *    would invent a name for something the receipt deliberately identifies by
 *    object name alone;
 *  - **it is the task's own, and the task already has it.** Both point at
 *    `<root>.worktrees/<taskId>` and `ao/task/<taskId>`. A task at
 *    `READY_FOR_PR` — the only kind that can have a merge receipt — is
 *    precisely the task whose workspace is already there, so borrowing the
 *    identity means colliding with it;
 *  - **it is built from the default branch and must survive.** Preparation
 *    requires the source checkout to be on the profile default branch and
 *    clean, and the workspace it produces is where a writing agent works. This
 *    one exists for the length of one gate and is then destroyed.
 *
 * So this module derives its own identity, in its own reserved directory, and
 * proves its own ownership. It shares the parts that are genuinely the same:
 * the containment and shell-inertness rules on the derived path, the
 * `--git-common-dir` test for "a worktree of *this* Git", and the rule that
 * cleanup may only ever remove a path it re-derived.
 *
 * ── Ownership, for a worktree that has no branch ───────────────────────────
 *
 * `remove-workspace.ts` proves ownership from the branch: the registration at
 * the derived path must hold the derived branch, in the reserved namespace.
 * That statement is unavailable here — there is no branch — and its absence is
 * *load-bearing rather than a weakening*, so the proof is restated in three
 * parts, all of which must hold before anything is deleted:
 *
 *  1. the path is **re-derived** from the repository root and the task id, and
 *     sits under the reserved {@link VERIFICATION_DIRECTORY_SUFFIX} directory;
 *  2. Git's own registry lists **that exact path** as a worktree of this
 *     repository — a directory that merely looks like a checkout is not one;
 *  3. that registration is **detached**. A worktree at this path holding a
 *     branch is not one this module made, and is refused rather than removed.
 *
 * Part 3 is the replacement for the branch test, not a relaxation of it: it
 * fails closed in the same direction. Anything at the derived path that this
 * module would not have produced is left exactly where it is.
 *
 * ── Never reused ───────────────────────────────────────────────────────────
 *
 * Creation refuses if anything at all occupies the derived path. A workspace
 * that already exists is not adopted, not cleaned and not re-pointed, because
 * every one of those would mean running a verification in a tree whose contents
 * this call did not establish. A stale workspace is an operator's decision, and
 * it is reported as `WORKSPACE_PATH_OCCUPIED` rather than resolved.
 */

import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import { isShellInertArgument } from '../doctor/exec.js';
import { isValidTaskId } from '../plan/task-id.js';
import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import {
  snapshotRepositoryRecord,
  verifyExecutionLeaseHeldFor,
  type LeaseRepository,
} from '../lease/execution-lease.js';
import { GIT_OBJECT_NAME_PATTERN } from './prepare-workspace.js';
import type { GitRunner } from './git-command.js';
import { findByPath, listWorktrees, samePath } from './worktree-registry.js';

/**
 * The reserved directory that holds every verification workspace.
 *
 * Its job is ownership, not decoration — the same job
 * {@link TASK_BRANCH_PREFIX} does for branches. A sibling of the repository
 * and *not* `WORKTREE_DIRECTORY_SUFFIX`: sharing that directory would put two
 * kinds of workspace with two different lifetimes and two different ownership
 * proofs under one name, and the first cleanup to confuse them would delete a
 * task's work.
 */
export const VERIFICATION_DIRECTORY_SUFFIX = '.verification';

/** Every way a verification workspace identity can fail to exist. Closed. */
export const VERIFICATION_WORKSPACE_IDENTITY_CODES = [
  'TASK_ID_INVALID',
  'REPOSITORY_ROOT_UNSUITABLE',
  'WORKSPACE_PATH_UNSAFE',
] as const;

export type VerificationWorkspaceIdentityCode =
  (typeof VERIFICATION_WORKSPACE_IDENTITY_CODES)[number];

/** The one directory that belongs to one task's verification. */
export interface VerificationWorkspaceIdentity {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** Directory holding every verification workspace of this repository. */
  readonly workspaceParent: string;
  /** Absolute path of this task's verification workspace. */
  readonly workspacePath: string;
}

export interface VerificationWorkspaceIdentitySuccess {
  readonly ok: true;
  readonly identity: VerificationWorkspaceIdentity;
}

export interface VerificationWorkspaceIdentityFailure {
  readonly ok: false;
  readonly code: VerificationWorkspaceIdentityCode;
}

export type VerificationWorkspaceIdentityResult =
  | VerificationWorkspaceIdentitySuccess
  | VerificationWorkspaceIdentityFailure;

/** `true` when `candidate` is `root` itself or lies beneath it. */
function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Derives where one task's verification workspace belongs.
 *
 * Pure: no file is read, no process started, no clock consulted. A failure
 * means the identity *cannot exist* — never that it does not exist yet.
 *
 * Deliberately not keyed on the commit. The subject commit is verified against
 * the checkout after it is made ({@link proveVerificationWorkspaceAt}); putting
 * it in the *path* would make the derived location depend on a value read out
 * of a receipt, and cleanup could then only remove the workspace it happened to
 * be told about — leaving a workspace at a path nothing re-derives, which is
 * the definition of an unowned one.
 */
export function deriveVerificationWorkspaceIdentity(
  repositoryRoot: string,
  taskId: string,
): VerificationWorkspaceIdentityResult {
  if (!isValidTaskId(taskId)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_INVALID' as const });
  }
  if (!isAbsolute(repositoryRoot) || basename(repositoryRoot).length === 0) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }

  const workspaceParent = join(
    dirname(repositoryRoot),
    `${basename(repositoryRoot)}${VERIFICATION_DIRECTORY_SUFFIX}`,
  );
  const workspacePath = join(workspaceParent, taskId);

  // Outside the repository, and expressible as a Git argument. Both are
  // structural conditions on the derived value. The first is what keeps a
  // second checkout out of the tree whose own verification commands are about
  // to expand globs over it.
  if (isContained(repositoryRoot, workspacePath)) {
    return Object.freeze({ ok: false as const, code: 'WORKSPACE_PATH_UNSAFE' as const });
  }
  if (!isShellInertArgument(workspacePath) || !isShellInertArgument(workspaceParent)) {
    return Object.freeze({ ok: false as const, code: 'WORKSPACE_PATH_UNSAFE' as const });
  }

  return Object.freeze({
    ok: true as const,
    identity: Object.freeze({
      repositoryRoot,
      taskId,
      workspaceParent,
      workspacePath,
    }),
  });
}

/* ────────────────────────────── creation ────────────────────────────────── */

/** Every way creating a verification workspace can end. A closed set. */
export const VERIFICATION_WORKSPACE_CREATION_CODES = [
  /** The workspace exists, is detached, sits at the exact commit and is clean. */
  'WORKSPACE_READY',
  /** No identity could be derived. */
  'IDENTITY_UNDERIVABLE',
  /** The subject is not a full Git object name. Nothing was asked of Git. */
  'COMMIT_NOT_OBJECT_NAME',
  /** The execution lease is not held by this process at the effect. */
  'EXECUTION_LEASE_NOT_HELD',
  /** Something already occupies the derived path. Never adopted, never cleaned. */
  'WORKSPACE_PATH_OCCUPIED',
  /** The parent directory could not be created. */
  'WORKSPACE_PARENT_UNUSABLE',
  /** `git worktree add` did not succeed. Git leaves nothing behind when it refuses. */
  'WORKSPACE_CREATE_FAILED',
  /**
   * The workspace was created and is not what was asked for. Includes a HEAD
   * that is not the subject commit.
   */
  'WORKSPACE_NOT_AS_REQUESTED',
] as const;

export type VerificationWorkspaceCreationCode =
  (typeof VERIFICATION_WORKSPACE_CREATION_CODES)[number];

/** A verification workspace this call created and proved. */
export interface VerificationWorkspace {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** Canonical absolute path, as the filesystem spells it. */
  readonly workspacePath: string;
  /** The object name HEAD was **proved** to be, inside the workspace. */
  readonly headCommit: string;
}

export interface VerificationWorkspaceCreationSuccess {
  readonly ok: true;
  readonly code: 'WORKSPACE_READY';
  readonly workspace: VerificationWorkspace;
}

export interface VerificationWorkspaceCreationFailure {
  readonly ok: false;
  readonly code: Exclude<VerificationWorkspaceCreationCode, 'WORKSPACE_READY'>;
  /**
   * Whether anything was created before the failure.
   *
   * `false` for every refusal that never reached `worktree add`, and for a
   * `worktree add` Git itself declined. `true` only when a workspace was made
   * and its removal did not complete — the one case an operator has to act on.
   */
  readonly residue: boolean;
}

export type VerificationWorkspaceCreationResult =
  | VerificationWorkspaceCreationSuccess
  | VerificationWorkspaceCreationFailure;

function creationFailure(
  code: Exclude<VerificationWorkspaceCreationCode, 'WORKSPACE_READY'>,
  residue = false,
): VerificationWorkspaceCreationFailure {
  return Object.freeze({ ok: false as const, code, residue });
}

/**
 * `true` when a filesystem object exists at `path` — a link included.
 *
 * `lstat`, not `stat`: the question is whether this *name* is taken, and a
 * dangling symlink takes the name just as effectively as a directory.
 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface VerificationWorkspaceOptions {
  /** The Git seam. Must be lease-fenced in production; see `leased-spawns.ts`. */
  readonly git: GitRunner;
  /** The execution lease, re-proved immediately before and after each effect. */
  readonly lease: ExecutionLeaseEvidence;
}

/**
 * What the workspace turned out to be, read from inside it.
 *
 * Separated from creation so the same proof can stand in front of the
 * verification run itself, rather than being something creation once observed.
 * A gate proved at creation and a process started afterwards are not the same
 * claim — this repository has measured that distance twice, in
 * `prepare-workspace.ts` and in `remove-workspace.ts`.
 */
export const VERIFICATION_WORKSPACE_PROOFS = [
  /** Detached, at the exact commit, nothing in it, a worktree of this Git. */
  'AT_COMMIT',
  /** Git reports a different working-tree root, or the path cannot be resolved. */
  'PATH_MISMATCH',
  /** The directory is a worktree of a *different* repository. */
  'FOREIGN_REPOSITORY',
  /** A branch is checked out. This module only ever produces a detached HEAD. */
  'NOT_DETACHED',
  /** HEAD is not the expected commit. The refusal this whole module exists for. */
  'HEAD_MISMATCH',
  /** Tracked files are modified, staged or deleted, or untracked files are present. */
  'NOT_CLEAN',
  /** A probe could not be run at all, so nothing was established. */
  'UNREADABLE',
] as const;

export type VerificationWorkspaceProof = (typeof VERIFICATION_WORKSPACE_PROOFS)[number];

export interface VerificationWorkspaceProofResult {
  readonly proof: VerificationWorkspaceProof;
  /** Canonical path as the filesystem spells it. Only on `AT_COMMIT`. */
  readonly canonicalWorkspacePath: string | null;
}

function proofResult(
  proof: VerificationWorkspaceProof,
  canonicalWorkspacePath: string | null = null,
): VerificationWorkspaceProofResult {
  return Object.freeze({ proof, canonicalWorkspacePath });
}

/**
 * Proves the directory at `identity.workspacePath` is a detached checkout of
 * this repository, at exactly `expectedCommit`, with nothing in it.
 *
 * Five independent facts, every one read by running Git **inside that
 * directory** rather than by trusting what this process did a moment ago.
 *
 * The `--git-common-dir` test is not optional and is not a formality: without
 * it, every other probe here can be satisfied by a checkout of a *different*
 * repository parked at this path, which would answer `AT_COMMIT` for a commit
 * that is not ours and hand a verification run a tree nobody chose. Two
 * worktrees of one repository share the common directory; no two repositories
 * do.
 */
export async function proveVerificationWorkspaceAt(
  git: GitRunner,
  identity: VerificationWorkspaceIdentity,
  expectedCommit: string,
): Promise<VerificationWorkspaceProofResult> {
  const path = identity.workspacePath;

  const toplevel = await git(path, ['rev-parse', '--show-toplevel']);
  if (toplevel.outcome !== 'OK') return proofResult('UNREADABLE');
  if (!samePath(toplevel.stdout, path)) return proofResult('PATH_MISMATCH');

  const commonDir = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const sourceCommonDir = await git(identity.repositoryRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (commonDir.outcome !== 'OK' || sourceCommonDir.outcome !== 'OK') {
    return proofResult('UNREADABLE');
  }
  if (!samePath(commonDir.stdout, sourceCommonDir.stdout)) {
    return proofResult('FOREIGN_REPOSITORY');
  }

  // A detached HEAD exits non-zero under `--quiet` and prints nothing, which is
  // what this module requires. A *successful* answer means a branch is checked
  // out, and that is a workspace this module did not make.
  const branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.outcome === 'REFUSED_UNSAFE_ARGUMENT') return proofResult('UNREADABLE');
  if (branch.outcome === 'OK') return proofResult('NOT_DETACHED');

  const head = await git(path, ['rev-parse', '--verify', '--end-of-options', 'HEAD']);
  if (head.outcome !== 'OK') return proofResult('UNREADABLE');
  if (head.stdout !== expectedCommit) return proofResult('HEAD_MISMATCH');

  const status = await git(path, ['status', '--porcelain', '--untracked-files=all']);
  if (status.outcome !== 'OK') return proofResult('UNREADABLE');
  if (status.stdout.split('\n').some((line) => line.trim().length > 0)) {
    return proofResult('NOT_CLEAN');
  }

  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return proofResult('UNREADABLE');
  }

  return proofResult('AT_COMMIT', canonical);
}

/**
 * Creates a detached checkout of `commit`, and proves it is one.
 *
 * The lease is proved **here**, immediately before the effect, for the reason
 * `prepare-workspace.ts` states at length: a gate in a caller is a gate at
 * whatever distance the caller happens to have, and the distance between a
 * caller's proof and this subprocess is measured in Git invocations.
 */
export async function createVerificationWorkspace(
  given: LeaseRepository,
  taskId: string,
  commit: string,
  options: VerificationWorkspaceOptions,
): Promise<VerificationWorkspaceCreationResult> {
  // One reading of the record, shared by the lease gate and every path derived
  // from it. A record whose `root` is an accessor can answer B for one and A
  // for the other; see `snapshotRepositoryRecord`.
  const repository = snapshotRepositoryRecord(given);
  const git = options.git;

  const derived = deriveVerificationWorkspaceIdentity(repository.root, taskId);
  if (!derived.ok) return creationFailure('IDENTITY_UNDERIVABLE');
  const identity = derived.identity;

  // Judged before anything is asked of Git, so an abbreviated or non-object
  // name never reaches a command line — and so the refusal names the reason
  // rather than arriving as a generic `worktree add` failure.
  if (!GIT_OBJECT_NAME_PATTERN.test(commit)) return creationFailure('COMMIT_NOT_OBJECT_NAME');

  if (verifyExecutionLeaseHeldFor(repository, options.lease).code !== 'HELD') {
    return creationFailure('EXECUTION_LEASE_NOT_HELD');
  }

  // Never adopted, never cleaned, never re-pointed. See the module header.
  if (pathExists(identity.workspacePath)) return creationFailure('WORKSPACE_PATH_OCCUPIED');

  try {
    mkdirSync(identity.workspaceParent, { recursive: true });
  } catch {
    return creationFailure('WORKSPACE_PARENT_UNUSABLE');
  }

  const created = await git(identity.repositoryRoot, [
    'worktree',
    'add',
    '--quiet',
    '--detach',
    identity.workspacePath,
    commit,
  ]);
  if (created.outcome !== 'OK') {
    // Includes every lost race and every unavailable object: a competitor that
    // took the path between the check above and here makes Git refuse, and
    // Git's refusal leaves nothing behind.
    return creationFailure('WORKSPACE_CREATE_FAILED');
  }

  const proved = await proveVerificationWorkspaceAt(git, identity, commit);
  if (proved.proof !== 'AT_COMMIT' || proved.canonicalWorkspacePath === null) {
    // Created and wrong. Undo it through the same owned removal an ordinary
    // teardown uses — never a bare `rm`, and never `--force`.
    const undone = await removeVerificationWorkspace(repository, taskId, options);
    return creationFailure('WORKSPACE_NOT_AS_REQUESTED', !workspaceIsGone(undone.code));
  }

  return Object.freeze({
    ok: true as const,
    code: 'WORKSPACE_READY' as const,
    workspace: Object.freeze({
      repositoryRoot: identity.repositoryRoot,
      taskId,
      workspacePath: proved.canonicalWorkspacePath,
      headCommit: commit,
    }),
  });
}

/* ────────────────────────────── removal ─────────────────────────────────── */

/** Every way removing a verification workspace can end. A closed set. */
export const VERIFICATION_WORKSPACE_REMOVAL_CODES = [
  /** Git removed the registration and the directory, and the tree was clean. */
  'REMOVED',
  /**
   * The same, but the plain removal was refused first and `--force` was needed.
   *
   * Reported separately rather than folded into `REMOVED`, because the two say
   * different things about the *repository*: this one means the declared gate
   * modified a tracked file or left an untracked one behind. That is worth an
   * operator seeing, and hiding it inside a success would be the kind of silent
   * degradation this build reports rather than smooths over.
   */
  'REMOVED_FORCED',
  /** Git does not register the derived path. Nothing was removed. */
  'NOTHING_REGISTERED',
  /** No identity could be derived, so no path was ever a candidate. */
  'IDENTITY_UNDERIVABLE',
  /** The execution lease is not held by this process at the effect. */
  'EXECUTION_LEASE_NOT_HELD',
  /** The registry could not be read, so ownership could not be proved. */
  'REGISTRY_UNREADABLE',
  /**
   * Something is registered at the derived path that this module did not make
   * — it holds a branch. Left exactly where it is.
   */
  'WORKSPACE_NOT_OWNED',
  /** `git worktree remove` did not succeed. The workspace is still there. */
  'REMOVAL_FAILED',
] as const;

export type VerificationWorkspaceRemovalCode =
  (typeof VERIFICATION_WORKSPACE_REMOVAL_CODES)[number];

export interface VerificationWorkspaceRemovalResult {
  readonly code: VerificationWorkspaceRemovalCode;
}

/**
 * Whether a removal code means nothing is at the derived path any more.
 *
 * Stated once, so that a caller asking "is it gone" cannot drift from the set
 * of codes that mean it. `NOTHING_REGISTERED` is deliberately **not** here: Git
 * not registering the path says nothing about whether a directory is sitting
 * on it, and calling that "gone" is how residue gets reported as clean.
 */
export function workspaceIsGone(code: VerificationWorkspaceRemovalCode): boolean {
  return code === 'REMOVED' || code === 'REMOVED_FORCED';
}

/**
 * Proves this call may delete the derived path, and answers why not.
 *
 * The three-part proof of the module header, in one place so that the forced
 * attempt below re-runs **the whole of it** rather than a remembered part.
 */
async function proveOwnedForRemoval(
  git: GitRunner,
  repository: LeaseRepository,
  identity: VerificationWorkspaceIdentity,
  lease: ExecutionLeaseEvidence,
): Promise<VerificationWorkspaceRemovalCode | null> {
  if (verifyExecutionLeaseHeldFor(repository, lease).code !== 'HELD') {
    return 'EXECUTION_LEASE_NOT_HELD';
  }
  const registry = await listWorktrees(git, identity.repositoryRoot);
  if (!registry.ok) return 'REGISTRY_UNREADABLE';

  const registration = findByPath(registry.entries, identity.workspacePath);
  if (registration === null) return 'NOTHING_REGISTERED';

  // The replacement for `remove-workspace.ts`'s branch test, and it fails in
  // the same direction: a registration holding *any* branch is not one this
  // module produced, because this module only ever passes `--detach`.
  if (registration.branchRef !== null) return 'WORKSPACE_NOT_OWNED';

  return null;
}

/**
 * Removes a verification workspace this module made, and nothing else.
 *
 * ── Why `--force` is here, when `remove-workspace.ts` refuses it ───────────
 *
 * That module's refusal protects **an agent's uncommitted work**: a task
 * workspace is where a writer edits, so a forced delete there can destroy
 * something a human wanted. None of that is true of this directory, and the
 * difference was measured rather than reasoned about:
 *
 *  - a plain `git worktree remove` **succeeds** over ignored build output —
 *    `node_modules/`, `dist/` — so the ordinary case needs no force at all;
 *  - it is **refused** when a tracked file was modified or a non-ignored
 *    untracked file was left behind, with `use --force to delete it`.
 *
 * A repository's declared gate can do either, and AO does not get to say which:
 * `npm run verify` here regenerates into the tracked `schemas/` directory. So
 * the alternatives are a forced removal or a full checkout leaked on disk after
 * every run, and the second is the worse failure.
 *
 * What bounds the force is **not** its absence but the proof in front of it.
 * The path is re-derived from the repository root and the task id, must sit
 * under the reserved directory, must be registered by Git as a worktree of this
 * repository, and must be detached. A caller cannot name a path; there is no
 * path parameter. And the whole proof is re-run before the forced attempt,
 * because the plain attempt was a subprocess and authority is a property of the
 * moment an effect happens.
 *
 * The two endings are reported apart. `REMOVED_FORCED` is how an operator
 * learns their gate dirties the tree it runs in.
 */
export async function removeVerificationWorkspace(
  given: LeaseRepository,
  taskId: string,
  options: VerificationWorkspaceOptions,
): Promise<VerificationWorkspaceRemovalResult> {
  const repository = snapshotRepositoryRecord(given);
  const git = options.git;

  const derived = deriveVerificationWorkspaceIdentity(repository.root, taskId);
  if (!derived.ok) return Object.freeze({ code: 'IDENTITY_UNDERIVABLE' as const });
  const identity = derived.identity;

  const refusal = await proveOwnedForRemoval(git, repository, identity, options.lease);
  if (refusal !== null) return Object.freeze({ code: refusal });

  const removed = await git(identity.repositoryRoot, [
    'worktree',
    'remove',
    identity.workspacePath,
  ]);
  if (removed.outcome === 'OK') return Object.freeze({ code: 'REMOVED' as const });

  // Re-proved in full, not inherited: `worktree remove` was a subprocess, and
  // what is at the path now is a different question from what was there before
  // it ran.
  const stillOwned = await proveOwnedForRemoval(git, repository, identity, options.lease);
  if (stillOwned !== null) return Object.freeze({ code: stillOwned });

  const forced = await git(identity.repositoryRoot, [
    'worktree',
    'remove',
    '--force',
    identity.workspacePath,
  ]);
  return Object.freeze({
    code: forced.outcome === 'OK' ? ('REMOVED_FORCED' as const) : ('REMOVAL_FAILED' as const),
  });
}
