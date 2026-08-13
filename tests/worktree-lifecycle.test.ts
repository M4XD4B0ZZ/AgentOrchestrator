/**
 * V1-03: preparing and releasing a task's isolated workspace, against real
 * repositories.
 *
 * Every repository here is a fresh `git init` in the OS temp directory and
 * every worktree is a real `git worktree`. Nothing is mocked: the point of this
 * slice is what Git actually does when asked to make a second checkout, and a
 * simulated Git would only prove that the simulation matches the implementation.
 * The seam is exercised separately, in `worktree-races.test.ts`, for the
 * handful of states a real repository cannot be held in on demand.
 *
 * The refusals carry the weight. A workspace that is created when it should not
 * have been is recoverable; a *cleanup* that removes the wrong thing is not. So
 * each refusal below asserts two things — the typed code, and that the world it
 * refused to act on is still exactly as it was.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { prepareTaskWorkspace, type TaskWorkspace } from '../src/worktree/prepare-workspace.js';
import { removeTaskWorkspace } from '../src/worktree/remove-workspace.js';
import { deriveTaskWorkspaceIdentity } from '../src/worktree/workspace-identity.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { listWorktrees, findByPath } from '../src/worktree/worktree-registry.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import {
  createRepoFixture,
  FIXTURE_A_PROFILE,
  FIXTURE_B_PROFILE,
  git,
  removeRepoFixtures,
} from './helpers/repo-fixtures.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  taskWithId,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';

afterAll(() => {
  releaseTestLeases();
  removeTrackedWorkspaces();
  removeRepoFixtures();
});

/** A resolved fixture repository whose workspaces will be cleaned up. */
async function freshRepository(
  profile: string = FIXTURE_A_PROFILE,
  defaultBranch = 'main',
): Promise<ResolvedRepository> {
  // Fixture B declares CodeGraph as REQUIRED and would not resolve without one.
  const root = createRepoFixture({
    defaultBranch,
    profile,
    codegraphIndex: profile === FIXTURE_B_PROFILE,
  });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return repository;
}

function identityFor(repository: ResolvedRepository, taskId: string) {
  const derived = deriveTaskWorkspaceIdentity(repository, taskId);
  if (!derived.ok) throw new Error(`expected an identity, got ${derived.code}`);
  return derived.identity;
}

/** Unwraps a preparation that is expected to have succeeded. */
async function prepared(repository: ResolvedRepository, taskId: string): Promise<TaskWorkspace> {
  const result = await prepareTaskWorkspace(repository, taskWithId(taskId), { lease: leaseFor(repository) });
  if (!result.ok) throw new Error(`expected WORKTREE_READY, got ${result.code}: ${result.detail}`);
  return result.workspace;
}

// ── A. The happy path ───────────────────────────────────────────────────────

describe('A — a selected task is given an isolated workspace', () => {
  it('creates the derived branch and worktree at the pinned base commit', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    const headBefore = git(repository.root, ['rev-parse', 'HEAD']).trim();

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe('WORKTREE_READY');

    const workspace = result.workspace;
    expect(workspace.workBranch).toBe(identity.workBranch);
    expect(workspace.baseBranch).toBe('main');
    expect(workspace.basePinnedCommit).toBe(headBefore);
    expect(workspace.repositoryId).toBe(repository.id);
    expect(workspace.taskId).toBe('V1-03');
    expect(workspace.worktreeClean).toBe(true);

    // The receipt describes something that actually exists, and Git agrees.
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(git(workspace.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(workspace.worktreePath, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe(
      identity.workBranch,
    );

    const registry = await listWorktrees(runGitCommand, repository.root);
    expect(registry.ok).toBe(true);
    if (registry.ok) {
      const entry = findByPath(registry.entries, identity.worktreePath);
      expect(entry?.branchRef).toBe(`refs/heads/${identity.workBranch}`);
    }
  });

  it('leaves the source repository untouched — same branch, same head, clean', async () => {
    const repository = await freshRepository();
    const headBefore = git(repository.root, ['rev-parse', 'HEAD']).trim();

    await prepared(repository, 'V1-03');

    expect(git(repository.root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(repository.root, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('main');
    expect(git(repository.root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });
});

// ── B. More than one task in one repository ─────────────────────────────────

describe('B — a second task gets its own workspace beside the first', () => {
  it('creates two independent worktrees from the same base', async () => {
    const repository = await freshRepository();

    const first = await prepared(repository, 'V1-03');
    const second = await prepared(repository, 'V1-04');

    expect(second.worktreePath).not.toBe(first.worktreePath);
    expect(second.workBranch).not.toBe(first.workBranch);
    expect(second.basePinnedCommit).toBe(first.basePinnedCommit);
    expect(existsSync(first.worktreePath)).toBe(true);
    expect(existsSync(second.worktreePath)).toBe(true);
  });
});

// ── C. A dirty source repository ────────────────────────────────────────────

describe('C — a dirty source repository is refused', () => {
  it.each([
    [
      'an uncommitted modification',
      (root: string) => writeFileSync(join(root, 'README.md'), 'changed\n', 'utf8'),
    ],
    [
      'an untracked file',
      (root: string) => writeFileSync(join(root, 'scratch.txt'), 'untracked\n', 'utf8'),
    ],
  ])('refuses on %s, and creates nothing', async (_label, dirty) => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    dirty(repository.root);

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SOURCE_WORKTREE_DIRTY');
    expect(result.residue).toBe(false);
    expect(existsSync(identity.worktreePath)).toBe(false);
    expect(git(repository.root, ['branch', '--list', identity.workBranch]).trim()).toBe('');
  });
});

// ── D. A source repository on the wrong branch ──────────────────────────────

describe('D — a source repository not on its declared base is refused', () => {
  it('refuses when another branch is checked out', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    git(repository.root, ['switch', '--quiet', '-c', 'somewhere-else']);

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SOURCE_BRANCH_UNEXPECTED');
    expect(existsSync(identity.worktreePath)).toBe(false);
  });

  it('refuses a detached HEAD for the same reason', async () => {
    const repository = await freshRepository();
    const head = git(repository.root, ['rev-parse', 'HEAD']).trim();
    git(repository.root, ['checkout', '--quiet', '--detach', head]);

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SOURCE_BRANCH_UNEXPECTED');
  });
});

// ── E. The task branch already exists ───────────────────────────────────────

describe('E — an existing task branch is refused and left untouched', () => {
  it('does not move, delete or check out the existing branch', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');

    // A branch already sitting at the derived name, pointing somewhere of its
    // own: a previous run, or a human who guessed the convention.
    writeFileSync(join(repository.root, 'extra.txt'), 'work\n', 'utf8');
    git(repository.root, ['add', '--all']);
    git(repository.root, ['commit', '--quiet', '-m', 'second']);
    const otherCommit = git(repository.root, ['rev-parse', 'HEAD']).trim();
    git(repository.root, ['branch', identity.workBranch, otherCommit]);
    git(repository.root, ['reset', '--quiet', '--hard', 'HEAD~1']);

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TASK_BRANCH_EXISTS');
      expect(result.residue).toBe(false);
    }
    // Untouched: still there, still pointing where it did.
    expect(git(repository.root, ['rev-parse', identity.workBranch]).trim()).toBe(otherCommit);
    expect(existsSync(identity.worktreePath)).toBe(false);
  });
});

// ── F. Something already occupies the target path ───────────────────────────

describe('F — an occupied target path is refused with its contents intact', () => {
  it('does not delete, overwrite or adopt what is already there', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');

    mkdirSync(identity.worktreePath, { recursive: true });
    const bystander = join(identity.worktreePath, 'important.txt');
    writeFileSync(bystander, 'do not delete me\n', 'utf8');

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WORKTREE_PATH_OCCUPIED');
      expect(result.residue).toBe(false);
    }
    expect(readFileSync(bystander, 'utf8')).toBe('do not delete me\n');
    expect(git(repository.root, ['branch', '--list', identity.workBranch]).trim()).toBe('');
  });
});

// ── G. Git already registers a worktree for that branch ─────────────────────

describe('G — a worktree registration collision is refused', () => {
  it('refuses when the derived branch is already checked out in another worktree', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');

    // The branch is checked out somewhere else entirely, so the *path* is free
    // while the branch is not. Git would refuse too; this refuses first, and
    // says which of the two collided.
    const elsewhere = join(identity.worktreeParent, 'manual-checkout');
    mkdirSync(identity.worktreeParent, { recursive: true });
    git(repository.root, ['worktree', 'add', '--quiet', '-b', identity.workBranch, elsewhere]);

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Pinned to the one code the ordering actually produces, not to a set of
      // acceptable ones: the branch is checked before the registry, so this is
      // `TASK_BRANCH_EXISTS` and nothing else. Accepting either would hide the
      // day that ordering changes — the same weakness V1-01's RR-F3 removed
      // from the branch-name tests.
      expect(result.code).toBe('TASK_BRANCH_EXISTS');
      expect(result.residue).toBe(false);
    }
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(identity.worktreePath)).toBe(false);
  });

  it('refuses a stale registration whose directory somebody deleted by hand', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');

    // A worktree registered at exactly the derived path, on somebody else's
    // branch, whose directory has since been removed without `git worktree
    // prune`. The path is now free on disk while Git still owns the name — the
    // one case where the filesystem and the registry disagree, and the case
    // where trusting the filesystem alone would let two worktrees claim one
    // location.
    mkdirSync(identity.worktreeParent, { recursive: true });
    git(repository.root, [
      'worktree',
      'add',
      '--quiet',
      '-b',
      'stale-branch',
      identity.worktreePath,
    ]);
    rmSync(identity.worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    expect(existsSync(identity.worktreePath)).toBe(false);

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WORKTREE_ALREADY_REGISTERED');
      expect(result.residue).toBe(false);
    }
    // The stale registration is left for a human to prune; nothing was adopted.
    expect(git(repository.root, ['branch', '--list', 'stale-branch']).trim()).not.toBe('');
    expect(git(repository.root, ['branch', '--list', identity.workBranch]).trim()).toBe('');
  });
});

// ── H. A derived identity that cannot be acted on ───────────────────────────

describe('H — an unsafe derived lifecycle condition is refused before any Git call', () => {
  it('refuses a task id that cannot become a legal branch', async () => {
    const repository = await freshRepository();

    const result = await prepareTaskWorkspace(repository, taskWithId('V1..03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TASK_BRANCH_NAME_INVALID');
      expect(result.residue).toBe(false);
    }
  });

  it('refuses a repository whose derived path could not be a Git argument', async () => {
    // A real repository, really resolved, under a directory containing a space
    // — which `doctor/exec.ts` will not accept as an argument. The pipeline must
    // answer with a typed refusal, not throw UnsafeArgumentError.
    const parent = join(process.env['TEMP'] ?? process.env['TMP'] ?? '.', `ao space ${Date.now()}`);
    mkdirSync(parent, { recursive: true });
    const root = join(parent, 'repo');
    mkdirSync(root, { recursive: true });
    git(root, ['init', '-b', 'main', '--quiet']);
    writeFileSync(join(root, 'README.md'), '# spaced\n', 'utf8');
    mkdirSync(join(root, '.agent-orchestrator'), { recursive: true });
    writeFileSync(join(root, '.agent-orchestrator', 'repo-profile.yaml'), FIXTURE_A_PROFILE, 'utf8');
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'fixture']);

    const repository = await resolveFixture(root);
    trackWorkspacesOf(repository);

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WORKTREE_PATH_UNSAFE');
      expect(result.residue).toBe(false);
    }
  });
});

// ── I. Safe cleanup ─────────────────────────────────────────────────────────

describe('I — a clean, owned workspace is released completely', () => {
  it('removes the worktree and the owned task branch', async () => {
    const repository = await freshRepository();
    const workspace = await prepared(repository, 'V1-03');
    const identity = identityFor(repository, 'V1-03');

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(true);
    if (removal.ok) {
      expect(removal.code).toBe('WORKSPACE_REMOVED');
      expect(removal.worktreeRemoved).toBe(true);
      expect(removal.branchRemoved).toBe(true);
    }
    expect(existsSync(workspace.worktreePath)).toBe(false);
    expect(git(repository.root, ['branch', '--list', identity.workBranch]).trim()).toBe('');

    const registry = await listWorktrees(runGitCommand, repository.root);
    expect(registry.ok).toBe(true);
    if (registry.ok) {
      expect(findByPath(registry.entries, identity.worktreePath)).toBeNull();
    }
  });

  it('is safe to prepare the same task again afterwards', async () => {
    const repository = await freshRepository();
    await prepared(repository, 'V1-03');
    await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    const again = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });
    expect(again.ok).toBe(true);
  });
});

// ── J. Cleanup of a workspace with unsaved work ─────────────────────────────

describe('J — a workspace holding work is never destroyed', () => {
  it('refuses a dirty worktree and leaves the files in place', async () => {
    const repository = await freshRepository();
    const workspace = await prepared(repository, 'V1-03');
    const inProgress = join(workspace.worktreePath, 'in-progress.txt');
    writeFileSync(inProgress, 'half-finished work\n', 'utf8');

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe('WORKTREE_DIRTY');
      expect(removal.worktreeRemoved).toBe(false);
      expect(removal.branchRemoved).toBe(false);
    }
    expect(readFileSync(inProgress, 'utf8')).toBe('half-finished work\n');
    expect(existsSync(workspace.worktreePath)).toBe(true);
  });

  it('refuses a clean worktree whose branch holds unmerged commits', async () => {
    const repository = await freshRepository();
    const workspace = await prepared(repository, 'V1-03');

    // Committed, so the worktree is clean — but the work exists only here.
    writeFileSync(join(workspace.worktreePath, 'done.txt'), 'real work\n', 'utf8');
    git(workspace.worktreePath, ['add', '--all']);
    git(workspace.worktreePath, ['commit', '--quiet', '-m', 'task work']);
    const commit = git(workspace.worktreePath, ['rev-parse', 'HEAD']).trim();

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe('TASK_BRANCH_HAS_UNMERGED_WORK');
      expect(removal.worktreeRemoved).toBe(false);
    }
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(git(repository.root, ['rev-parse', workspace.workBranch]).trim()).toBe(commit);
  });
});

describe('J2 — a base branch that no longer exists', () => {
  it('is reported as such, not as unmerged work on the task branch', async () => {
    const repository = await freshRepository();
    const workspace = await prepared(repository, 'V1-03');

    // The base really is gone: move the main checkout off it, then delete it.
    // `merge-base --is-ancestor` now exits 128 rather than 1 — it cannot
    // evaluate the question, which is a different thing from answering "no".
    git(repository.root, ['switch', '--quiet', '-c', 'parked']);
    git(repository.root, ['branch', '-D', 'main']);

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe('BASE_BRANCH_NOT_FOUND');
      expect(removal.code).not.toBe('TASK_BRANCH_HAS_UNMERGED_WORK');
      expect(removal.worktreeRemoved).toBe(false);
      expect(removal.branchRemoved).toBe(false);
    }
    // Refused means nothing happened, exactly as for every other refusal.
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(git(repository.root, ['branch', '--list', workspace.workBranch]).trim()).not.toBe('');
  });
});

// ── K. Anything not provably ours ───────────────────────────────────────────

describe('K — an unrelated worktree or branch is never removed', () => {
  it('refuses when the path holds a worktree on somebody else’s branch', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');

    // A worktree at exactly the path V1-03 would use, but on a human's branch.
    mkdirSync(identity.worktreeParent, { recursive: true });
    git(repository.root, [
      'worktree',
      'add',
      '--quiet',
      '-b',
      'someones-experiment',
      identity.worktreePath,
    ]);

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe('WORKTREE_NOT_OWNED');
      expect(removal.worktreeRemoved).toBe(false);
    }
    expect(existsSync(identity.worktreePath)).toBe(true);
    expect(git(repository.root, ['branch', '--list', 'someones-experiment']).trim()).not.toBe('');
  });

  it('refuses a registered worktree with no branch at all', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    const head = git(repository.root, ['rev-parse', 'HEAD']).trim();

    // A detached worktree sitting at the derived path. Ownership is judged on
    // the branch Git reports, and here Git reports none — so there is nothing
    // to match the derived task branch against, and it is not ours.
    mkdirSync(identity.worktreeParent, { recursive: true });
    git(repository.root, ['worktree', 'add', '--quiet', '--detach', identity.worktreePath, head]);

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe('WORKTREE_NOT_OWNED');
      expect(removal.worktreeRemoved).toBe(false);
    }
    expect(existsSync(identity.worktreePath)).toBe(true);
  });

  it('refuses a plain directory that was never a registered worktree', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    mkdirSync(identity.worktreePath, { recursive: true });
    const bystander = join(identity.worktreePath, 'not-a-worktree.txt');
    writeFileSync(bystander, 'keep\n', 'utf8');

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) expect(removal.code).toBe('WORKTREE_NOT_OWNED');
    expect(readFileSync(bystander, 'utf8')).toBe('keep\n');
  });

  it('refuses when nothing is there at all', async () => {
    const repository = await freshRepository();

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe('WORKTREE_NOT_OWNED');
      expect(removal.worktreeRemoved).toBe(false);
    }
  });

  it('removing one task’s workspace leaves another task’s alone', async () => {
    const repository = await freshRepository();
    const keep = await prepared(repository, 'V1-04');
    await prepared(repository, 'V1-03');

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(removal.ok).toBe(true);
    expect(existsSync(keep.worktreePath)).toBe(true);
    expect(git(repository.root, ['branch', '--list', keep.workBranch]).trim()).not.toBe('');
  });
});

// ── L. Two repositories, one task id ────────────────────────────────────────

describe('L — the same task id in two repositories stays independent', () => {
  it('prepares and releases each without touching the other', async () => {
    const alpha = await freshRepository(FIXTURE_A_PROFILE, 'main');
    const beta = await freshRepository(FIXTURE_B_PROFILE, 'develop');

    expect(alpha.id).not.toBe(beta.id);
    expect(alpha.defaultBranch).not.toBe(beta.defaultBranch);

    const alphaWorkspace = await prepared(alpha, 'SHARED-1');
    const betaWorkspace = await prepared(beta, 'SHARED-1');

    // Different directories, different base commits, different base branches …
    expect(alphaWorkspace.worktreePath).not.toBe(betaWorkspace.worktreePath);
    expect(alphaWorkspace.basePinnedCommit).not.toBe(betaWorkspace.basePinnedCommit);
    expect(alphaWorkspace.baseBranch).toBe('main');
    expect(betaWorkspace.baseBranch).toBe('develop');
    // … and each pinned to its own repository's head.
    expect(alphaWorkspace.basePinnedCommit).toBe(git(alpha.root, ['rev-parse', 'HEAD']).trim());
    expect(betaWorkspace.basePinnedCommit).toBe(git(beta.root, ['rev-parse', 'HEAD']).trim());

    // Releasing one leaves the other entirely alone.
    const removal = await removeTaskWorkspace(alpha, taskWithId('SHARED-1'), { lease: leaseFor(alpha) });
    expect(removal.ok).toBe(true);
    expect(existsSync(alphaWorkspace.worktreePath)).toBe(false);
    expect(existsSync(betaWorkspace.worktreePath)).toBe(true);
    expect(git(beta.root, ['branch', '--list', betaWorkspace.workBranch]).trim()).not.toBe('');
  });
});
