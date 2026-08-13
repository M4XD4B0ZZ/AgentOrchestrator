/**
 * V1-03: the deterministic identity of a task's workspace.
 *
 * The derivation is a pure function, so these tests are about *shape* and
 * *refusal*: the same inputs must always produce the same branch and directory,
 * and every input that cannot produce a legal one must be refused with a typed
 * code rather than repaired into something that would no longer re-derive.
 *
 * The multi-repository cases are the evidence that nothing here is written for
 * this project: two real repositories, with different roots, different ids and
 * different default branches, declaring the *same* task id, must get two
 * independent workspaces without either repository being known to the code.
 */

import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { GIT_SHA_PATTERN } from '../src/core/internal/task-state-object-schema.js';
import { GIT_OBJECT_NAME_PATTERN } from '../src/worktree/prepare-workspace.js';
import {
  deriveTaskWorkspaceIdentity,
  isOwnedTaskBranch,
  TASK_BRANCH_PREFIX,
  WORKTREE_DIRECTORY_SUFFIX,
  type TaskWorkspaceIdentity,
} from '../src/worktree/workspace-identity.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import {
  createRepoFixture,
  FIXTURE_A_PROFILE,
  FIXTURE_B_PROFILE,
  removeRepoFixtures,
} from './helpers/repo-fixtures.js';
import { resolveFixture } from './helpers/worktree-fixtures.js';

afterAll(removeRepoFixtures);

/**
 * A synthetic resolved repository.
 *
 * Used only for the pure-derivation edge cases — a root under a path with a
 * space, an illegal declared default branch — that a real fixture either cannot
 * express or could only express by breaking the resolver first. Every
 * lifecycle test uses a real repository instead.
 */
function repositoryAt(
  root: string,
  id = 'fixture-alpha',
  defaultBranch = 'main',
): ResolvedRepository {
  return Object.freeze({
    root,
    id,
    // Never read by workspace identity, which takes only three fields — carried
    // so the literal still satisfies the resolved shape.
    gitCommonDir: join(root, '.git'),
    defaultBranch,
    profilePath: join(root, '.agent-orchestrator', 'repo-profile.yaml'),
    schemaVersion: 1,
    taskSource: { kind: 'MARKDOWN_DIRECTORY' as const, path: 'tasks' },
    context: { canonicalSources: ['README.md'] },
    capabilities: {
      codegraph: {
        capability: 'codegraph' as const,
        requirement: 'OPTIONAL' as const,
        status: 'UNAVAILABLE' as const,
        satisfied: true,
      },
    },
    verification: { phases: [{ phase: 'VERIFY' as const, command: ['npm', 'run', 'verify'] }] },
    scope: { allowedPaths: ['src'], protectedPaths: ['dist'] },
    completion: { maxReviewRounds: 3 },
    remote: { required: false, present: false },
  });
}

function identityOf(repository: ResolvedRepository, taskId: string): TaskWorkspaceIdentity {
  const derived = deriveTaskWorkspaceIdentity(repository, taskId);
  if (!derived.ok) throw new Error(`expected an identity, got ${derived.code}`);
  return derived.identity;
}

describe('derived workspace identity', () => {
  const repository = repositoryAt(join('D:', 'projects', 'alpha'));

  it('is a pure function of the repository and the task id', () => {
    const first = identityOf(repository, 'V1-03');
    const second = identityOf(repository, 'V1-03');
    expect(second).toEqual(first);
  });

  it('names the branch in the reserved namespace', () => {
    const identity = identityOf(repository, 'V1-03');
    expect(identity.workBranch).toBe(`${TASK_BRANCH_PREFIX}V1-03`);
    expect(isOwnedTaskBranch(identity, identity.workBranch)).toBe(true);
  });

  it('places the workspace beside the repository, never inside it', () => {
    const identity = identityOf(repository, 'V1-03');
    expect(identity.worktreeParent).toBe(
      join(dirname(repository.root), `${basename(repository.root)}${WORKTREE_DIRECTORY_SUFFIX}`),
    );
    expect(identity.worktreePath).toBe(join(identity.worktreeParent, 'V1-03'));

    // Outside the repository root, by the platform's own path rules.
    const rel = relative(repository.root, identity.worktreePath);
    expect(rel.startsWith('..') || isAbsolute(rel)).toBe(true);
  });

  it('carries the base branch and repository identity through unchanged', () => {
    const identity = identityOf(repository, 'V1-03');
    expect(identity.baseBranch).toBe('main');
    expect(identity.repositoryId).toBe('fixture-alpha');
    expect(identity.repositoryRoot).toBe(repository.root);
    expect(identity.taskId).toBe('V1-03');
  });
});

describe('identities that cannot exist are refused, never repaired', () => {
  const repository = repositoryAt(join('D:', 'projects', 'alpha'));

  it.each([
    ['a task id that is not a legal identifier', 'not a task id', 'TASK_ID_INVALID'],
    ['a task id containing "..", legal as a filename', 'V1..03', 'TASK_BRANCH_NAME_INVALID'],
    ['a task id ending in ".lock", legal as a filename', 'spec.lock', 'TASK_BRANCH_NAME_INVALID'],
  ])('refuses %s', (_label, taskId, expected) => {
    const derived = deriveTaskWorkspaceIdentity(repository, taskId);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.code).toBe(expected);
  });

  it.each([
    ['a drive root, which has no directory name of its own', `D:${sep}`],
    ['a relative path', join('projects', 'alpha')],
  ])('refuses %s as a repository root', (_label, root) => {
    const derived = deriveTaskWorkspaceIdentity(repositoryAt(root), 'V1-03');
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.code).toBe('REPOSITORY_ROOT_UNSUITABLE');
  });

  it('refuses a declared default branch that Git would not accept', () => {
    const derived = deriveTaskWorkspaceIdentity(
      repositoryAt(join('D:', 'projects', 'alpha'), 'fixture-alpha', 'feature..x'),
      'V1-03',
    );
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.code).toBe('BASE_BRANCH_INVALID');
  });

  it('refuses a repository root that Git could not be given as an argument', () => {
    // A space is not in the shell-inert argument set `doctor/exec.ts` enforces,
    // so the derived path could never be passed to `git worktree add`. This is
    // the fail-closed answer instead of the UnsafeArgumentError that module
    // documents as a programming error.
    const derived = deriveTaskWorkspaceIdentity(
      repositoryAt(join('C:', 'Users', 'Ada Lovelace', 'alpha')),
      'V1-03',
    );
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.code).toBe('WORKTREE_PATH_UNSAFE');
  });

  it('states a reason without quoting the offending value back', () => {
    const derived = deriveTaskWorkspaceIdentity(
      repositoryAt(join('C:', 'Users', 'Ada Lovelace', 'alpha')),
      'V1-03',
    );
    expect(derived.ok).toBe(false);
    if (!derived.ok) {
      expect(derived.detail).not.toContain('Ada');
      expect(derived.detail).not.toContain('V1-03');
    }
  });
});

describe('branch ownership', () => {
  const identity = identityOf(repositoryAt(join('D:', 'projects', 'alpha')), 'V1-03');

  it.each([
    ['the derived branch', `${TASK_BRANCH_PREFIX}V1-03`, true],
    ['another task’s branch in the namespace', `${TASK_BRANCH_PREFIX}V1-04`, false],
    ['a human branch that merely looks similar', 'ao-task/V1-03', false],
    ['the base branch', 'main', false],
    ['a feature branch', 'feature/V1-03', false],
  ])('%s: %s → %s', (_label, branch, expected) => {
    expect(isOwnedTaskBranch(identity, branch)).toBe(expected);
  });
});

describe('two real repositories declaring the same task id', () => {
  it('get independent workspaces, with no knowledge of either project', async () => {
    const alphaRoot = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    // Fixture B declares CodeGraph as REQUIRED, so it must actually have one —
    // one more policy the two fixtures disagree on.
    const betaRoot = createRepoFixture({
      defaultBranch: 'develop',
      profile: FIXTURE_B_PROFILE,
      codegraphIndex: true,
    });

    const alpha = await resolveFixture(alphaRoot);
    const beta = await resolveFixture(betaRoot);

    // The two fixtures disagree on identity and on base branch …
    expect(alpha.id).not.toBe(beta.id);
    expect(alpha.defaultBranch).not.toBe(beta.defaultBranch);

    const sharedTaskId = 'SHARED-1';
    const alphaIdentity = identityOf(alpha, sharedTaskId);
    const betaIdentity = identityOf(beta, sharedTaskId);

    // … so the workspaces are distinct directories …
    expect(alphaIdentity.worktreePath).not.toBe(betaIdentity.worktreePath);
    expect(alphaIdentity.worktreeParent).not.toBe(betaIdentity.worktreeParent);

    // … each pinned to its own repository's declared base …
    expect(alphaIdentity.baseBranch).toBe('main');
    expect(betaIdentity.baseBranch).toBe('develop');

    // … while the branch *name* is deliberately the same, because a branch
    // lives inside one repository and cannot collide across two.
    expect(alphaIdentity.workBranch).toBe(betaIdentity.workBranch);
  });
});

describe('the commit-name pattern mirrors the state contract', () => {
  it('is the same pattern the persisted state will validate against', () => {
    // V1-04 persists `basePinnedCommit` into a `TaskState`, where
    // `GitShaSchema` judges it. If these two ever disagreed, V1-03 could hand
    // forward a value V1-04 must reject. The internal module is imported here,
    // in a test, precisely so the source module does not have to.
    expect(GIT_OBJECT_NAME_PATTERN.source).toBe(GIT_SHA_PATTERN.source);
    expect(GIT_OBJECT_NAME_PATTERN.flags).toBe(GIT_SHA_PATTERN.flags);
  });
});
