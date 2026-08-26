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
 * fails closed in the same direction.
 *
 * What the three parts establish, stated exactly, because the obvious summary
 * overclaims and a review said so: they establish **shape and location**, not
 * **authorship**. A detached worktree that an operator registered at
 * `<root>.verification/<taskId>` themselves satisfies all three and would be
 * removed. That is accepted rather than closed: the directory is a reserved
 * namespace derived from the repository root and the task id, there is no path
 * parameter for a caller to aim, and nothing outside it is reachable — which is
 * the guarantee that actually matters. Establishing authorship would need a
 * marker written into the worktree, and a marker in a directory the removal is
 * about to delete is not authority.
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
import { basename, dirname, isAbsolute, join } from 'node:path';

import { isShellInertArgument } from '../doctor/exec.js';
import { isContained } from '../doctor/safe-write.js';
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

// The containment predicate is IMPORTED, not restated.
//
// An earlier version of this module carried its own four-line copy, and
// `tests/v2-02-remediation.test.ts` caught it: that file pins the safety chain
// as having exactly one implementation and lists the copies that already exist
// so a fifth cannot arrive quietly. Adding this module to that list would have
// been the wrong repair — the list is a record of debt, not a place to file
// more of it — and the two implementations were not equivalent.
//
// WHERE they differ was measured, because the obvious answer is wrong: an
// earlier version of this comment said the copy neither resolved its arguments
// nor compared case-insensitively, and `path.win32.relative` does both. The one
// divergence found is the copy's `rel.startsWith('..')` string test, which
// answers "not contained" for a genuine child whose first path segment begins
// with `..` — `C:/a` and `C:/a/..verification/T` being exactly that shape. The
// imported predicate answers `true` there, and `true` means refuse, so the swap
// is strictly the safer direction.

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
  /**
   * `git worktree add` did not succeed.
   *
   * Deliberately says nothing about what is left behind. Measured: Git can exit
   * non-zero **after** it has created, checked out and registered the worktree —
   * a failing `post-checkout` hook is enough — so "Git leaves nothing behind
   * when it refuses", which this comment used to say, is false. The arm undoes
   * itself and reports what that removal found, in `residue`.
   */
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
  /**
   * The object name **Git reported** for HEAD inside the workspace.
   *
   * Git's reading, never the value this call asked for. The two are equal on
   * every path that returns a workspace — that is what `AT_COMMIT` means — but
   * they are different *facts*, and a consumer that compares this against an
   * expectation is comparing a measurement rather than restating an argument.
   * An earlier version stored the requested commit here, which made exactly
   * that comparison vacuous downstream.
   */
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
   * Whether a checkout of **this call's** making is still on disk.
   *
   * `false` for every refusal that never reached `worktree add`. Past that
   * point it is derived from an attempted removal rather than from the exit
   * status or from the filesystem: every arm that got as far as spawning
   * `worktree add` undoes itself, and this is `true` only when that removal did
   * not clear a worktree Git had registered — the one case an operator has to
   * act on.
   *
   * It does not claim the debris is **this call's**. After the fact a killed
   * `worktree add`'s unregistered directory and a competitor's plain one are
   * indistinguishable, and both mean the same thing for the next run: the
   * occupied-path gate will refuse it. Saying more than that would be inventing
   * a distinction the code cannot make.
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

/** Whether this process is the repository's writer, right now. */
function leaseHeld(repository: LeaseRepository, lease: ExecutionLeaseEvidence): boolean {
  return verifyExecutionLeaseHeldFor(repository, lease).code === 'HELD';
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
  /**
   * The object name **Git reported** for HEAD inside the workspace, or `null`
   * when the probe was never reached.
   *
   * Carried rather than reduced to the boolean it was compared against, and the
   * reason is a defect two independent reviews measured. The value handed
   * downstream used to be the commit this process had *asked for*, so the
   * comparison that is supposed to be this slice's second, independent
   * guarantee — "the verdict is about the commit the tree was really at" —
   * compared a value with itself and could never fire on the production path.
   *
   * This field is Git's own answer. Anything that consumes it is comparing a
   * reading against an expectation rather than an expectation against itself.
   */
  readonly observedHead: string | null;
}

function proofResult(
  proof: VerificationWorkspaceProof,
  canonicalWorkspacePath: string | null = null,
  observedHead: string | null = null,
): VerificationWorkspaceProofResult {
  return Object.freeze({ proof, canonicalWorkspacePath, observedHead });
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
  const observedHead = head.stdout;
  if (observedHead !== expectedCommit) return proofResult('HEAD_MISMATCH', null, observedHead);

  const status = await git(path, ['status', '--porcelain', '--untracked-files=all']);
  if (status.outcome !== 'OK') return proofResult('UNREADABLE', null, observedHead);
  if (status.stdout.split('\n').some((line) => line.trim().length > 0)) {
    return proofResult('NOT_CLEAN', null, observedHead);
  }

  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return proofResult('UNREADABLE', null, observedHead);
  }

  return proofResult('AT_COMMIT', canonical, observedHead);
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
    // A failed `worktree add` is **not** the same as one that left nothing
    // behind, and two earlier versions of this arm assumed it was.
    //
    // The first returned `residue: false` unconditionally, on the stated ground
    // that "Git leaves nothing behind when it refuses". The second read
    // `pathExists`, which is worse in the other direction: a competitor's plain
    // directory at the path makes it `true` although this call created nothing.
    //
    // Both were measured false. A review reproduced `git worktree add --detach`
    // exiting non-zero **after** it had created, checked out and REGISTERED the
    // worktree — a `post-checkout` hook that fails is enough — and neither
    // version cleaned it up. That registration then survives, and every later
    // run for this task dies at the `pathExists` gate above with
    // `WORKSPACE_PATH_OCCUPIED`, which this module declares terminal. One
    // partially-failed creation permanently disabled verification for a task.
    //
    // So this arm undoes itself, exactly as the `WORKSPACE_NOT_AS_REQUESTED`
    // arm below does, through the same owned removal with the same three-part
    // proof. `NOTHING_REGISTERED` is the answer when Git registered nothing —
    // whatever is at the path is not ours and is not this call's residue.
    const undone = await removeVerificationWorkspace(repository, taskId, options);
    // Residue is "something is at the derived path and this run did not clear
    // it", and it is read from BOTH the removal and the filesystem.
    //
    // Neither alone is right, and each was tried. `pathExists` alone reports a
    // competitor's directory as this call's leftovers. The removal alone loses
    // the case the first version of this comment named: Git creates the
    // directory before it writes the registration, so a `worktree add` killed
    // inside that window leaves an UNregistered directory — `NOTHING_REGISTERED`
    // — which would then be reported as nothing left, and the next run is
    // terminal at the occupied-path gate above.
    //
    // Together they answer the question an operator actually has. This
    // deliberately does not claim the debris is ours: after the fact the two are
    // indistinguishable, and both mean the same thing for the next run.
    const leaked = !workspaceIsGone(undone.code) && pathExists(identity.workspacePath);
    return creationFailure('WORKSPACE_CREATE_FAILED', leaked);
  }

  const proved = await proveVerificationWorkspaceAt(git, identity, commit);
  if (proved.proof !== 'AT_COMMIT' || proved.canonicalWorkspacePath === null) {
    // Created and wrong. Undone through the same owned removal an ordinary
    // teardown uses — never a bare `rm`, and never a path this function chose:
    // there is no path parameter, so the delete can only ever reach what
    // `deriveVerificationWorkspaceIdentity` names.
    //
    // It CAN escalate to `--force`, because that is what the teardown does when
    // the tree it is deleting has been dirtied. An earlier version of this
    // comment said "never `--force`" and a review measured it false against the
    // very case that reaches here most often: a workspace refused as `NOT_CLEAN`
    // is by definition one the plain removal will decline.
    const undone = await removeVerificationWorkspace(repository, taskId, options);
    return creationFailure('WORKSPACE_NOT_AS_REQUESTED', !workspaceIsGone(undone.code));
  }
  // `observedHead` is non-null on `AT_COMMIT` by construction — the probe that
  // produces that verdict is the one that reads it. The guard is here so a
  // future change to the proof result cannot make this line store the argument
  // again, which is the defect it was written to close.
  if (proved.observedHead === null) {
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
      // Git's answer, not the argument. See {@link VerificationWorkspace}.
      headCommit: proved.observedHead,
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
  identity: VerificationWorkspaceIdentity,
): Promise<VerificationWorkspaceRemovalCode | null> {
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
 * Removes what is registered, detached, at this task's derived path — and
 * nothing else.
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

  // The lease is read **twice**, and both readings earn their place.
  //
  // The second one is the gate: it sits immediately before the spawn, because a
  // proof taken before a `git worktree list` subprocess — tens to hundreds of
  // milliseconds on Windows — is a proof about a moment that has passed, which
  // is the distance this module argues against everywhere else. A round of
  // review moved it there, correctly.
  //
  // The first one is the *classification*, and a second round measured why it
  // has to come back. In production the seam is `leasedGit`, which proves the
  // lease per call: a run that has already lost it gets `GIT_NOT_AUTHORISED`
  // from `worktree list`, `listWorktrees` folds every non-OK outcome into
  // `{ok: false}`, and the operator is told `REGISTRY_UNREADABLE` — "the
  // registry could not be read" — for what is actually "this run is no longer
  // the writer". Asking first costs one file read and gives the true answer.
  if (!leaseHeld(repository, options.lease)) {
    return Object.freeze({ code: 'EXECUTION_LEASE_NOT_HELD' as const });
  }
  const refusal = await proveOwnedForRemoval(git, identity);
  if (refusal !== null) return Object.freeze({ code: refusal });
  if (!leaseHeld(repository, options.lease)) {
    return Object.freeze({ code: 'EXECUTION_LEASE_NOT_HELD' as const });
  }

  const removed = await git(identity.repositoryRoot, [
    'worktree',
    'remove',
    identity.workspacePath,
  ]);
  if (removed.outcome === 'OK') return Object.freeze({ code: 'REMOVED' as const });

  // Re-proved in full, not inherited: `worktree remove` was a subprocess, and
  // what is at the path now is a different question from what was there before
  // it ran.
  const stillOwned = await proveOwnedForRemoval(git, identity);
  if (stillOwned !== null) return Object.freeze({ code: stillOwned });
  if (!leaseHeld(repository, options.lease)) {
    return Object.freeze({ code: 'EXECUTION_LEASE_NOT_HELD' as const });
  }

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
