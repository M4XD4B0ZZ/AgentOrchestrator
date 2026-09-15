/**
 * DASHBOARD-001 slice 1 — a snapshot starts nothing and calls nobody.
 *
 * ── Why this is a separate file ────────────────────────────────────────────
 *
 * `node:child_process` is mocked to throw for the whole module, which is the
 * only honest way to pin "no subprocess": a spy on one function catches the
 * reach a contributor makes today, a module that refuses to spawn at all
 * catches the one they make next year. But the mock is indiscriminate, and the
 * repository fixture helper runs `git init` — so the fixtures here are built by
 * hand instead, with no Git at all.
 *
 * That is not a weakening. Nothing the normal snapshot path reads requires a
 * Git repository: the profile, the task files and the runtime records are
 * ordinary files in ordinary directories. A plain directory is therefore a
 * *stricter* fixture than a real checkout, because a reader that quietly needed
 * Git would fail here rather than succeed by accident.
 *
 * ── Why it matters ────────────────────────────────────────────────────────
 *
 * Every reader this composes is subprocess-free today. The hazard is the
 * neighbourhood: `resolveRepository` is five `git` children away and is the
 * obvious thing to reach for when someone wants a canonical root or a
 * `gitCommonDir`, and `observeRuntime` runs `git status` inside a worktree a
 * writer may be using. Neither would be caught by a unit test that only checked
 * the answer — both would be caught here.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { readDashboardSnapshot } from '../src/dashboard/read-model.js';
import type { RepositoryRegistryOutcome } from '../src/registry/repository-registry.js';

/** THE PIN. Any spawn, by anything, from anywhere in the import graph. */
vi.mock('node:child_process', () => {
  const refuse = (): never => {
    throw new Error('a dashboard snapshot started a subprocess');
  };
  return {
    default: {},
    spawn: refuse,
    spawnSync: refuse,
    exec: refuse,
    execSync: refuse,
    execFile: refuse,
    execFileSync: refuse,
    fork: refuse,
  };
});

/** THE OTHER PIN. Nothing may leave this machine. */
vi.stubGlobal('fetch', (): never => {
  throw new Error('a dashboard snapshot made a network call');
});

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A leftover scratch directory is not worth failing a suite over.
    }
  }
  vi.unstubAllGlobals();
});

const PROFILE = [
  'schemaVersion: 1',
  'repository:',
  '  id: no-subprocess',
  '  defaultBranch: main',
  'taskSource:',
  '  kind: MARKDOWN_DIRECTORY',
  '  path: tasks',
  'context:',
  '  canonicalSources:',
  '    - README.md',
  // OPTIONAL deliberately: a REQUIRED capability would make AO probe it before
  // a run, and this fixture must need nothing beyond the filesystem.
  'capabilities:',
  '  codegraph: OPTIONAL',
  'verification:',
  '  phases:',
  '    - phase: VERIFY',
  '      command: [npm, run, verify]',
  'scope:',
  '  allowedPaths:',
  '    - src',
  '  protectedPaths: []',
  'completion:',
  '  maxReviewRounds: 2',
  'remote:',
  '  required: false',
  '',
].join('\n');

function taskFile(id: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: Task ${id}`,
    'status: OPEN',
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: false',
    'dependsOn: []',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
}

/** A repository-shaped directory built with no Git whatsoever. */
function gitFreeRepository(taskIds: readonly string[]): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-dash-nosub-')));
  roots.push(root);
  mkdirSync(join(root, '.agent-orchestrator'), { recursive: true });
  writeFileSync(join(root, '.agent-orchestrator', 'repo-profile.yaml'), PROFILE, 'utf8');
  mkdirSync(join(root, 'tasks'), { recursive: true });
  for (const id of taskIds) {
    writeFileSync(join(root, 'tasks', `${id}.md`), taskFile(id), 'utf8');
  }
  return root;
}

/** One durable record, written by hand. */
function writeRuntimeState(root: string, taskId: string): void {
  const directory = join(root, '.agent-orchestrator', 'runtime');
  mkdirSync(directory, { recursive: true });
  const state = {
    schemaVersion: 1,
    taskId,
    repositoryId: 'no-subprocess',
    repositoryRoot: root,
    worktreePath: join(`${root}.worktrees`, taskId),
    state: 'IMPLEMENTING',
    stateEnteredAt: '2026-09-15T17:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: 'a'.repeat(40),
    scopeAuthorityCommit: null,
    workBranch: `ao/task/${taskId}`,
    currentCommit: 'b'.repeat(40),
    reviewRound: 0,
    maxReviewRounds: 2,
    blockedAgent: null,
    resumeFrom: null,
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: true,
    findingHistory: [],
  };
  writeFileSync(join(directory, `${taskId}.json`), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function registryOf(...paths: readonly string[]): RepositoryRegistryOutcome {
  return {
    state: 'REGISTERED',
    registryDigest: 'e'.repeat(64),
    entries: paths.map((path) => ({ path })),
    maxConcurrentRepositories: 1,
  } as RepositoryRegistryOutcome;
}

describe('the mock is live, so the pin means something', () => {
  it('refuses a spawn from the test itself', () => {
    expect(() => execFileSync('git', ['--version'])).toThrow(/started a subprocess/);
    expect(() => spawnSync('git', ['--version'])).toThrow(/started a subprocess/);
  });

  it('refuses a network call from the test itself', () => {
    expect(() => (globalThis.fetch as unknown as () => never)()).toThrow(/network call/);
  });
});

describe('a normal snapshot starts nothing and calls nobody', () => {
  it('reads a repository with no Git present at all', () => {
    const root = gitFreeRepository(['N1-01', 'N1-02']);
    writeRuntimeState(root, 'N1-01');

    const snapshot = readDashboardSnapshot({
      now: () => new Date('2026-09-15T18:00:00.000Z'),
      loadRegistry: () => registryOf(root),
    });

    // Reaching here at all is the evidence: every reader on the path ran, and
    // none of them spawned or dialled anything.
    expect(snapshot.repositories).toHaveLength(1);
    const repo = snapshot.repositories[0];
    expect(repo?.canonicalRoot).toBe(root);
    expect(repo?.profile.reading).toBe('DECLARED');
    expect(repo?.declaredTasks.reading).toBe('DISCOVERED');
    expect(repo?.tasks.map((t) => t.taskId)).toEqual(['N1-01', 'N1-02']);

    // The declared task with a record, and the one without, told apart.
    const started = repo?.tasks.find((t) => t.taskId === 'N1-01');
    const notStarted = repo?.tasks.find((t) => t.taskId === 'N1-02');
    expect(started?.runtime.reading).toBe('LOADED');
    expect(notStarted?.runtime.reading).toBe('NONE');
    expect(notStarted?.declared).toBe('DECLARED');
  });

  it('refuses to guess a lease location rather than reaching for Git', () => {
    // There is no `.git` here. The honest answer is that the Git directory
    // could not be named — NOT that the repository has no lease, and certainly
    // not that AgentOrchestrator is not running.
    const root = gitFreeRepository(['N1-01']);

    const snapshot = readDashboardSnapshot({
      now: () => new Date('2026-09-15T18:00:00.000Z'),
      loadRegistry: () => registryOf(root),
    });

    const repo = snapshot.repositories[0];
    expect(repo?.lease.reading).toBe('NOT_OBSERVED');
    if (repo?.lease.reading !== 'NOT_OBSERVED') return;
    expect(repo.lease.why).toBe('GIT_DIRECTORY_UNDETERMINED');
    expect(snapshot.notes.some((n) => n.code === 'LEASE_LOCATION_UNDETERMINED')).toBe(true);

    // And the absence is never escalated into a claim about the orchestrator.
    expect(JSON.stringify(snapshot)).not.toContain('NOT_RUNNING');
  });

  it('survives a registry that names nothing, without inventing a repository', () => {
    const snapshot = readDashboardSnapshot({
      now: () => new Date('2026-09-15T18:00:00.000Z'),
      loadRegistry: () => ({ state: 'NOT_REGISTERED' }) as RepositoryRegistryOutcome,
    });

    expect(snapshot.registry.reading).toBe('NOT_REGISTERED');
    expect(snapshot.repositories).toHaveLength(0);
    // "No registry" and "a registry declaring nothing" are different facts, and
    // neither of them is "everything is finished".
    expect(JSON.stringify(snapshot)).not.toContain('COMPLETE');
  });
});
