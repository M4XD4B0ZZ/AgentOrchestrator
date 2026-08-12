/**
 * V1-03: the states a real repository cannot be held in on demand.
 *
 * Everything here still runs against a real Git repository — the seam is used
 * to *interleave* a real change at an exact moment, or to make one specific
 * command answer differently, and every assertion afterwards is checked against
 * what Git actually ended up holding. That is the difference between testing a
 * race and testing a mock: the competitor below really does create the branch,
 * and real `git worktree add` really is the thing that refuses.
 *
 * Two properties are under test throughout:
 *
 *  - a lost race is **refused**, never half-completed;
 *  - a pinned base is **pinned** — a branch that moves after the pin does not
 *    change what the workspace was built from.
 */

import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { prepareTaskWorkspace } from '../src/worktree/prepare-workspace.js';
import { removeTaskWorkspace } from '../src/worktree/remove-workspace.js';
import { deriveTaskWorkspaceIdentity } from '../src/worktree/workspace-identity.js';
import { runGitCommand, type GitCommandResult, type GitRunner } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import {
  createRepoFixture,
  FIXTURE_A_PROFILE,
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

async function freshRepository(): Promise<ResolvedRepository> {
  const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return repository;
}

function identityFor(repository: ResolvedRepository, taskId: string) {
  const derived = deriveTaskWorkspaceIdentity(repository, taskId);
  if (!derived.ok) throw new Error(`expected an identity, got ${derived.code}`);
  return derived.identity;
}

/** `true` when a git argument vector starts with `prefix`. */
function startsWith(args: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((token, index) => args[index] === token);
}

/**
 * A runner that delegates to the real one, but lets a test act — or answer —
 * at a chosen command.
 *
 * The hook returns `null` to let the real command through, having possibly done
 * something to the repository first; that is how a competing process is
 * injected at an exact point in the sequence.
 */
function intercepting(
  hook: (cwd: string, args: readonly string[]) => GitCommandResult | null,
): GitRunner {
  return async (cwd, args) => hook(cwd, args) ?? (await runGitCommand(cwd, args));
}

const OK = (stdout = ''): GitCommandResult =>
  Object.freeze({ outcome: 'OK' as const, stdout, exitCode: 0 });
const UNAVAILABLE: GitCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
  exitCode: null,
});
/** A non-zero exit, with the code Git would have produced for that condition. */
const NONZERO = (exitCode = 1): GitCommandResult =>
  Object.freeze({ outcome: 'NONZERO_EXIT' as const, stdout: '', exitCode });

// ── Lost races ──────────────────────────────────────────────────────────────

describe('a race lost between the check and the create', () => {
  it('is refused when a competitor creates the branch first', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    let injected = false;

    const runner = intercepting((_cwd, args) => {
      if (!injected && startsWith(args, ['worktree', 'add'])) {
        // The collision check has already passed. A competing process now
        // creates exactly the branch this call is about to ask for.
        injected = true;
        git(repository.root, ['branch', identity.workBranch]);
      }
      return null;
    });

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WORKTREE_CREATE_FAILED');
      expect(result.residue).toBe(false);
    }
    // Git refused, so nothing was created — and the competitor's branch is
    // still exactly where it put it.
    expect(existsSync(identity.worktreePath)).toBe(false);
    expect(git(repository.root, ['branch', '--list', identity.workBranch]).trim()).not.toBe('');
  });

  it('is refused when a competitor occupies the target path first', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    let injected = false;

    const runner = intercepting((_cwd, args) => {
      if (!injected && startsWith(args, ['worktree', 'add'])) {
        injected = true;
        const competitor = join(identity.worktreeParent, 'V1-03');
        git(repository.root, ['worktree', 'add', '--quiet', '-b', 'competitor', competitor]);
      }
      return null;
    });

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WORKTREE_CREATE_FAILED');
    // The competitor's worktree is untouched, still on its own branch.
    expect(git(identity.worktreePath, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe(
      'competitor',
    );
  });
});

// ── The pin is a pin ────────────────────────────────────────────────────────

describe('a base branch that moves after it was pinned', () => {
  it('does not change what the workspace was built from', async () => {
    const repository = await freshRepository();
    const pinned = git(repository.root, ['rev-parse', 'HEAD']).trim();
    let moved = false;

    const runner = intercepting((_cwd, args) => {
      if (!moved && startsWith(args, ['worktree', 'add'])) {
        // The base has been read and pinned. `main` now moves on underneath.
        moved = true;
        writeFileSync(join(repository.root, 'later.txt'), 'moved on\n', 'utf8');
        git(repository.root, ['add', '--all']);
        git(repository.root, ['commit', '--quiet', '-m', 'moved on']);
      }
      return null;
    });

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(moved).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const moved_to = git(repository.root, ['rev-parse', 'HEAD']).trim();
    expect(moved_to).not.toBe(pinned);

    // The receipt names the commit the work is really based on …
    expect(result.workspace.basePinnedCommit).toBe(pinned);
    // … and the worktree is really at it, not at the branch's new tip.
    expect(git(result.workspace.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(pinned);
  });
});

// ── Post-create verification and rollback ───────────────────────────────────

describe('a worktree that is not what was asked for', () => {
  it('is removed again, and the failure is reported', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');

    const runner = intercepting((cwd, args) => {
      // Verification asks the new worktree for its HEAD. Answer with a
      // different, well-formed object name — the shape a moved base or a
      // confused checkout would produce.
      if (cwd === identity.worktreePath && startsWith(args, ['rev-parse', '--verify'])) {
        if (args[args.length - 1] === 'HEAD') return OK('0'.repeat(40));
      }
      return null;
    });

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WORKTREE_VERIFICATION_FAILED');
      expect(result.residue).toBe(false);
    }
    // Rolled back for real: no directory, no branch, no registration.
    expect(existsSync(identity.worktreePath)).toBe(false);
    expect(git(repository.root, ['branch', '--list', identity.workBranch]).trim()).toBe('');
    expect(git(repository.root, ['worktree', 'list', '--porcelain'])).not.toContain('V1-03');
  });

  it('reports residue when the rollback itself cannot complete', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');

    const runner = intercepting((cwd, args) => {
      if (cwd === identity.worktreePath && startsWith(args, ['rev-parse', '--verify'])) {
        if (args[args.length - 1] === 'HEAD') return OK('0'.repeat(40));
      }
      // …and the removal that would undo it does not work either.
      if (startsWith(args, ['worktree', 'remove'])) return NONZERO();
      return null;
    });

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WORKTREE_ROLLBACK_INCOMPLETE');
      // The one case that admits to leaving something behind, rather than
      // reporting a clean refusal over a half-built workspace.
      expect(result.residue).toBe(true);
    }
    expect(existsSync(identity.worktreePath)).toBe(true);
  });
});

// ── The ancestry probe's exit status is its answer ──────────────────────────

describe('classifying `merge-base --is-ancestor`', () => {
  /** Intercepts only the ancestry probe, leaving every other command real. */
  function ancestryAnswering(result: GitCommandResult): GitRunner {
    return intercepting((_cwd, args) =>
      startsWith(args, ['merge-base', '--is-ancestor']) ? result : null,
    );
  }

  it.each([
    [
      'exit 1 — a real answer of "not an ancestor"',
      NONZERO(1),
      'TASK_BRANCH_HAS_UNMERGED_WORK',
    ],
    [
      'exit 128 — Git could not evaluate the question at all',
      NONZERO(128),
      'GIT_UNAVAILABLE',
    ],
    ['a Git that could not be run', UNAVAILABLE, 'GIT_UNAVAILABLE'],
  ])('reads %s', async (_label, answer, expected) => {
    const repository = await freshRepository();
    const prepared = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });
    expect(prepared.ok).toBe(true);
    const identity = identityFor(repository, 'V1-03');

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { git: ancestryAnswering(answer), lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe(expected);
      expect(removal.worktreeRemoved).toBe(false);
      expect(removal.branchRemoved).toBe(false);
    }
    // Every one of these is a refusal, so the workspace is still standing.
    expect(existsSync(identity.worktreePath)).toBe(true);
  });

  it('never blames the task branch when the probe merely failed', async () => {
    // The regression this classification exists for: a non-zero exit that is
    // not 1 is Git declining to answer, and must not be reported as "your
    // branch holds unmerged work" — a reason that would simply be false.
    const repository = await freshRepository();
    const prepared = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });
    expect(prepared.ok).toBe(true);

    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { git: ancestryAnswering(NONZERO(128)), lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) expect(removal.code).not.toBe('TASK_BRANCH_HAS_UNMERGED_WORK');
  });
});

// ── Git itself failing ──────────────────────────────────────────────────────

describe('Git that cannot answer', () => {
  it.each([
    ['the first preflight question', ['rev-parse', '--show-toplevel']],
    ['the status question', ['status', '--porcelain']],
    ['the worktree registry', ['worktree', 'list']],
  ])('fails closed with GIT_UNAVAILABLE at %s', async (_label, prefix) => {
    const repository = await freshRepository();
    const runner = intercepting((_cwd, args) => (startsWith(args, prefix) ? UNAVAILABLE : null));

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('GIT_UNAVAILABLE');
  });

  it('treats a refused unsafe argument as unavailability, never as an answer', async () => {
    const repository = await freshRepository();
    const runner = intercepting((_cwd, args) =>
      startsWith(args, ['rev-parse', '--show-toplevel'])
        ? Object.freeze({
            outcome: 'REFUSED_UNSAFE_ARGUMENT' as const,
            stdout: '',
            exitCode: null,
          })
        : null,
    );

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('GIT_UNAVAILABLE');
  });

  it.each([
    [
      'a root Git disagrees with',
      (id: ReturnType<typeof identityFor>) => (cwd: string, args: readonly string[]) =>
        cwd === id.repositoryRoot && startsWith(args, ['rev-parse', '--show-toplevel'])
          ? OK('C:/somewhere/else')
          : null,
      'REPOSITORY_ROOT_MISMATCH',
    ],
    [
      'a base branch that has vanished',
      (id: ReturnType<typeof identityFor>) => (cwd: string, args: readonly string[]) =>
        cwd === id.repositoryRoot && args[args.length - 1] === `refs/heads/${id.baseBranch}`
          ? NONZERO()
          : null,
      'BASE_BRANCH_NOT_FOUND',
    ],
    [
      'a base that does not resolve to an object name',
      (id: ReturnType<typeof identityFor>) => (cwd: string, args: readonly string[]) =>
        cwd === id.repositoryRoot && args[args.length - 1] === `refs/heads/${id.baseBranch}`
          ? OK('not-a-sha')
          : null,
      'BASE_COMMIT_UNRESOLVED',
    ],
  ])('fails closed on %s', async (_label, buildHook, expected) => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    const runner = intercepting(buildHook(identity));

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(expected);
      expect(result.residue).toBe(false);
    }
    expect(existsSync(identity.worktreePath)).toBe(false);
  });

  it('reports WORKTREE_PARENT_UNUSABLE when the workspace directory cannot exist', async () => {
    const repository = await freshRepository();
    const identity = identityFor(repository, 'V1-03');
    // A regular file sitting exactly where the workspace directory must go.
    writeFileSync(identity.worktreeParent, 'not a directory\n', 'utf8');

    const result = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WORKTREE_PARENT_UNUSABLE');
      expect(result.residue).toBe(false);
    }
  });

  it('reports WORKTREE_REMOVE_FAILED without deleting the branch', async () => {
    const repository = await freshRepository();
    const prepared = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });
    expect(prepared.ok).toBe(true);
    const identity = identityFor(repository, 'V1-03');

    const runner = intercepting((_cwd, args) =>
      startsWith(args, ['worktree', 'remove']) ? NONZERO() : null,
    );
    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe('WORKTREE_REMOVE_FAILED');
      expect(removal.branchRemoved).toBe(false);
    }
    // The branch is still there: a failed removal must not half-delete.
    expect(git(repository.root, ['branch', '--list', identity.workBranch]).trim()).not.toBe('');
    expect(existsSync(identity.worktreePath)).toBe(true);
  });

  it('reports a partial removal rather than calling a leftover branch success', async () => {
    const repository = await freshRepository();
    const prepared = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });
    expect(prepared.ok).toBe(true);

    const runner = intercepting((_cwd, args) =>
      startsWith(args, ['branch', '-d']) ? NONZERO() : null,
    );
    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(removal.ok).toBe(true);
    if (removal.ok) {
      expect(removal.code).toBe('WORKSPACE_PARTIALLY_REMOVED');
      expect(removal.worktreeRemoved).toBe(true);
      expect(removal.branchRemoved).toBe(false);
    }
  });

  it('never reads a non-zero exit as a successful answer during removal', async () => {
    const repository = await freshRepository();
    const workspace = await prepareTaskWorkspace(repository, taskWithId('V1-03'), { lease: leaseFor(repository) });
    expect(workspace.ok).toBe(true);

    const runner = intercepting((_cwd, args) =>
      startsWith(args, ['worktree', 'list']) ? UNAVAILABLE : null,
    );
    const removal = await removeTaskWorkspace(repository, taskWithId('V1-03'), { git: runner, lease: leaseFor(repository) });

    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.code).toBe('GIT_UNAVAILABLE');
      expect(removal.worktreeRemoved).toBe(false);
    }
    // Nothing was removed on the strength of an unanswered question.
    if (workspace.ok) expect(existsSync(workspace.workspace.worktreePath)).toBe(true);
  });
});
