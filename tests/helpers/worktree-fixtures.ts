/**
 * Shared scaffolding for the V1-03 worktree-lifecycle tests.
 *
 * Two things the repository fixtures cannot provide on their own:
 *
 *  - a *resolved* repository, because V1-03's entry points take the V1-01 value
 *    rather than a path, and building one by hand would let a test pass against
 *    a shape the resolver never produces;
 *  - cleanup of the workspaces V1-03 creates, which live *beside* the fixture
 *    repository (`<root>.worktrees/…`) and are therefore not covered by
 *    `removeRepoFixtures`.
 */

import { rmSync } from 'node:fs';

import { parseTaskDefinition, type TaskDefinition } from '../../src/plan/task-definition.js';
import {
  resolveRepository,
  type ResolvedRepository,
} from '../../src/repo/resolve-repository.js';
import { deriveTaskWorkspaceIdentity } from '../../src/worktree/workspace-identity.js';

/** Resolves a fixture repository, failing loudly rather than silently. */
export async function resolveFixture(root: string): Promise<ResolvedRepository> {
  const result = await resolveRepository({ repositoryPath: root });
  if (!result.ok) {
    throw new Error(`fixture did not resolve: ${result.code} — ${result.detail}`);
  }
  return result.repository;
}

/** A minimal, valid task definition with the given id. */
export function taskWithId(id: string, overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return parseTaskDefinition({
    id,
    title: `task ${id}`,
    status: 'OPEN',
    kind: 'NORMAL',
    priority: 'NORMAL',
    currentFocus: false,
    dependsOn: [],
    ...overrides,
  });
}

const worktreeParents = new Set<string>();

/**
 * Registers the workspace directory of `repository` for removal.
 *
 * Derived through the production function rather than rebuilt here, so a test
 * cannot clean a directory the implementation would not have used.
 */
export function trackWorkspacesOf(repository: ResolvedRepository): void {
  const derived = deriveTaskWorkspaceIdentity(repository, 'placeholder');
  if (derived.ok) worktreeParents.add(derived.identity.worktreeParent);
}

/** Removes every tracked workspace directory. Safe from `afterAll`. */
export function removeTrackedWorkspaces(): void {
  for (const parent of worktreeParents) {
    try {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked Git file on Windows must not fail an otherwise passing suite.
    }
  }
  worktreeParents.clear();
}
