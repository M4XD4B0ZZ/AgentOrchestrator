/**
 * DASHBOARD-001 slice 1 — the read model, pinned.
 *
 * Every case here exists because the cheap implementation of it is wrong in a
 * way that looks right on a phone. An unreadable directory rendered as "no
 * tasks", a quota block rendered as "needs you", a recorded commit rendered as
 * an observation, a missing lease rendered as "AO is not running" — each of
 * those is a calm, confident, false dashboard, and each is one line away.
 *
 * `node:child_process` is mocked to throw for the whole file. That is the
 * subprocess pin and it is not decorative: the readers this composes are safe,
 * but `resolveRepository` is five `git` children away in the import graph and a
 * later contributor reaching for it would otherwise only be caught in
 * production, by a machine under load.
 */

import { mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync, fsyncSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { readDashboardSnapshot, type ReadModelSeams } from '../src/dashboard/read-model.js';
import type { RepositoryRegistryOutcome } from '../src/registry/repository-registry.js';
import {
  FIXTURE_A_PROFILE,
  createRepoFixture,
  removeRepoFixtures,
} from './helpers/repo-fixtures.js';

afterAll(() => {
  removeRepoFixtures();
});

const FIXED_NOW = new Date('2026-09-15T18:00:00.000Z');

function taskFile(id: string, status = 'OPEN'): string {
  return [
    '---',
    `id: ${id}`,
    `title: Task ${id}`,
    `status: ${status}`,
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: false',
    'dependsOn: []',
    '---',
    '',
    'Human-readable description.',
    '',
  ].join('\n');
}

/** A repository fixture, with its canonical root — the key the model uses. */
function repository(files: Readonly<Record<string, string>>): string {
  const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE, files });
  return realpathSync.native(root);
}

interface StateOverrides {
  readonly state?: string;
  readonly currentCommit?: string | null;
  readonly reportedResetAt?: string | null;
  readonly blockedAgent?: string | null;
  readonly resumeFrom?: { phase: string; round: number } | null;
  readonly reviewRound?: number;
}

/** Writes a durable task-state file the real loader will accept. */
function writeRuntimeState(root: string, taskId: string, overrides: StateOverrides = {}): void {
  const directory = join(root, '.agent-orchestrator', 'runtime');
  mkdirSync(directory, { recursive: true });
  const state = {
    schemaVersion: 1,
    taskId,
    repositoryId: 'fixture-alpha',
    repositoryRoot: root,
    worktreePath: join(`${root}.worktrees`, taskId),
    state: overrides.state ?? 'IMPLEMENTING',
    stateEnteredAt: '2026-09-15T17:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: 'a'.repeat(40),
    scopeAuthorityCommit: null,
    workBranch: `ao/task/${taskId}`,
    currentCommit: overrides.currentCommit === undefined ? 'b'.repeat(40) : overrides.currentCommit,
    reviewRound: overrides.reviewRound ?? 0,
    maxReviewRounds: 3,
    blockedAgent: overrides.blockedAgent ?? null,
    resumeFrom: overrides.resumeFrom ?? null,
    reportedResetAt: overrides.reportedResetAt ?? null,
    worktreeCleanAtCheckpoint: true,
    findingHistory: [],
  };
  writeFileSync(join(directory, `${taskId}.json`), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** A registry outcome naming exactly these roots. Avoids needing a real home. */
function registryOf(...roots: readonly string[]): RepositoryRegistryOutcome {
  return {
    state: 'REGISTERED',
    registryDigest: 'd'.repeat(64),
    entries: roots.map((path) => ({ path })),
    maxConcurrentRepositories: 1,
  } as RepositoryRegistryOutcome;
}

function snapshotOf(roots: readonly string[], extra: ReadModelSeams = {}) {
  return readDashboardSnapshot({
    now: () => FIXED_NOW,
    loadRegistry: () => registryOf(...roots),
    ...extra,
  });
}

/* ═══════ identity ═══════════════════════════════════════════════════════ */

describe('repository identity is the canonical root, never the declared id', () => {
  it('keeps two clones that declare the same repositoryId as two rows', () => {
    // PIN 1. Both fixtures use FIXTURE_A_PROFILE, so both declare `fixture-alpha`.
    // Keying on that id would merge two independent execution domains into one
    // row and show one repository's work under the other's name.
    const first = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    const second = repository({ 'tasks/D1-02.md': taskFile('D1-02') });

    const snapshot = snapshotOf([first, second]);

    expect(snapshot.repositories).toHaveLength(2);
    const ids = snapshot.repositories.map((r) =>
      r.profile.reading === 'DECLARED' ? r.profile.repositoryId : null,
    );
    expect(ids).toEqual(['fixture-alpha', 'fixture-alpha']);
    const roots = snapshot.repositories.map((r) => r.canonicalRoot);
    expect(new Set(roots).size).toBe(2);
    // AO's own ordering: ascending code units on the canonical root.
    expect([...roots]).toEqual([...roots].sort());
  });
});

/* ═══════ declared vs runtime ════════════════════════════════════════════ */

describe('declared and runtime are independent facts', () => {
  it('shows a declared task with no durable record, and never calls it QUEUED', () => {
    // PIN 2.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    const snapshot = snapshotOf([root]);
    const [task] = snapshot.repositories[0]?.tasks ?? [];

    expect(task?.taskId).toBe('D1-01');
    expect(task?.declared).toBe('DECLARED');
    expect(task?.runtime.reading).toBe('NONE');

    // AO has no QUEUED, so neither may this. The serialized snapshot must not
    // contain the word anywhere — a UI reading it would print it.
    expect(JSON.stringify(snapshot)).not.toContain('QUEUED');
  });

  it('keeps a runtime task whose declaration is absent, rather than dropping it', () => {
    // PIN 3. A record on disk is evidence that work happened; a missing
    // declaration is not permission to hide it.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-99');

    const snapshot = snapshotOf([root]);
    const tasks = snapshot.repositories[0]?.tasks ?? [];
    const orphan = tasks.find((t) => t.taskId === 'D1-99');

    expect(orphan).toBeDefined();
    expect(orphan?.declared).toBe('NOT_DECLARED');
    expect(orphan?.runtime.reading).toBe('LOADED');
  });

  it('says UNDETERMINED, not NOT_DECLARED, when discovery could not be read', () => {
    // The defect this pin exists for: discovery is all-or-nothing, so one bad
    // task file refuses the whole source. Falling back to an empty list of
    // declared ids would make every runtime task in the repository read as
    // "has no declaration" — a specific claim, asserted from no evidence, for
    // every row at once. The third answer is the only honest one.
    const root = repository({
      'tasks/D1-01.md': taskFile('D1-01'),
      'tasks/D1-02.md': '---\nnot: a task\n---\n',
    });
    writeRuntimeState(root, 'D1-01');

    const snapshot = snapshotOf([root]);
    const repo = snapshot.repositories[0];
    expect(repo?.declaredTasks.reading).toBe('REFUSED');

    const task = repo?.tasks.find((t) => t.taskId === 'D1-01');
    expect(task).toBeDefined();
    expect(task?.declared).toBe('UNDETERMINED');
    expect(task?.declared).not.toBe('NOT_DECLARED');
    // It is still listed: the durable record is evidence that work happened.
    expect(task?.runtime.reading).toBe('LOADED');
  });

  it('does not read progress from the declaration’s status field', () => {
    // PIN 18b. `status` is the dependency contract. A file may say OPEN while
    // the durable record says READY_FOR_PR, because the flip lands in the
    // delivery pull request.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01', 'OPEN') });
    writeRuntimeState(root, 'D1-01', { state: 'READY_FOR_PR', reviewRound: 1 });

    const snapshot = snapshotOf([root]);
    const [task] = snapshot.repositories[0]?.tasks ?? [];
    expect(task?.declared).toBe('DECLARED');
    if (task?.runtime.reading !== 'LOADED') throw new Error('expected a loaded record');
    expect(task.runtime.facts.state).toBe('READY_FOR_PR');
  });
});

/* ═══════ discovery refusals are not empty lists ═════════════════════════ */

describe('a discovery refusal is a condition, never an empty task list', () => {
  it('reports a malformed task declaration as a refusal with its code', () => {
    // PIN 4. discoverTasks is all-or-nothing: one bad file yields NO tasks.
    // Rendering that as "no tasks" would blank a 40-task board.
    const root = repository({
      'tasks/D1-01.md': taskFile('D1-01'),
      'tasks/D1-02.md': '---\nnot: a task\n---\n',
    });

    const snapshot = snapshotOf([root]);
    const repo = snapshot.repositories[0];
    expect(repo?.declaredTasks.reading).toBe('REFUSED');
    if (repo?.declaredTasks.reading !== 'REFUSED') return;
    expect(repo.declaredTasks.code.length).toBeGreaterThan(0);
    expect(snapshot.notes.some((n) => n.code === 'TASK_DISCOVERY_REFUSED')).toBe(true);
  });

  it('reports an empty task source as its own refusal, not as finished work', () => {
    // PIN 5. AO refuses an empty source deliberately so that "nothing found"
    // can never be read as "everything complete".
    // The directory must EXIST and hold no task file: an absent directory is a
    // different refusal (TASK_SOURCE_NOT_FOUND), and conflating the two would
    // hide a misconfigured profile behind "this wave is finished".
    const root = repository({ 'tasks/.keep': 'not a task file' });
    const snapshot = snapshotOf([root]);
    const repo = snapshot.repositories[0];

    expect(repo?.declaredTasks.reading).toBe('REFUSED');
    if (repo?.declaredTasks.reading !== 'REFUSED') return;
    expect(repo.declaredTasks.code).toBe('TASK_SOURCE_EMPTY');
    expect(repo.tasks).toHaveLength(0);
    // The distinction that matters: the refusal is on the record, so a caller
    // cannot mistake the empty array for a completed project.
    expect(snapshot.notes.some((n) => n.code === 'TASK_DISCOVERY_REFUSED')).toBe(true);
  });
});

/* ═══════ runtime scan ═══════════════════════════════════════════════════ */

describe('the runtime scan keeps absent, unreadable and empty apart', () => {
  it('reports an unreadable runtime directory rather than zero healthy tasks', () => {
    // PIN 6.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    const snapshot = snapshotOf([root], {
      readDirectory: (path: string) => {
        if (path.includes('runtime')) {
          const error: NodeJS.ErrnoException = new Error('refused');
          error.code = 'EACCES';
          throw error;
        }
        return [];
      },
    });

    const repo = snapshot.repositories[0];
    expect(repo?.runtimeScan.reading).toBe('DIRECTORY_UNREADABLE');
    expect(snapshot.notes.some((n) => n.code === 'RUNTIME_DIRECTORY_UNREADABLE')).toBe(true);
  });

  it('reports an absent runtime directory as ordinary, distinct from unreadable', () => {
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    const snapshot = snapshotOf([root]);
    expect(snapshot.repositories[0]?.runtimeScan.reading).toBe('DIRECTORY_ABSENT');
    expect(snapshot.notes.some((n) => n.code === 'RUNTIME_DIRECTORY_UNREADABLE')).toBe(false);
  });

  it('ignores a crashed writer’s staging file using the canonical predicate', () => {
    // PIN 7. `<id>.json.tmp-<suffix>` is excluded structurally by
    // isStateFileName, not because it is unlikely to be seen.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-01');
    const runtime = join(root, '.agent-orchestrator', 'runtime');
    writeFileSync(join(runtime, 'D1-01.json.tmp-crashed'), '{"half":', 'utf8');

    const snapshot = snapshotOf([root]);
    const repo = snapshot.repositories[0];
    expect(repo?.runtimeScan.reading).toBe('READ');
    if (repo?.runtimeScan.reading !== 'READ') return;
    expect(repo.runtimeScan.stateFileCount).toBe(1);
    expect(repo.tasks.map((t) => t.taskId)).toEqual(['D1-01']);
    expect(JSON.stringify(snapshot)).not.toContain('.tmp-');
  });

  it('keeps a task whose record will not load visible, as a load failure', () => {
    // PIN 8. Dropping it would make a corrupt record indistinguishable from a
    // task that never started.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-01');
    writeFileSync(
      join(root, '.agent-orchestrator', 'runtime', 'D1-01.json'),
      'not json at all',
      'utf8',
    );

    const snapshot = snapshotOf([root]);
    const [task] = snapshot.repositories[0]?.tasks ?? [];
    expect(task?.taskId).toBe('D1-01');
    expect(task?.runtime.reading).toBe('UNREADABLE');
    expect(snapshot.notes.some((n) => n.code === 'TASK_STATE_UNREADABLE')).toBe(true);
  });
});

/* ═══════ failure containment ════════════════════════════════════════════ */

describe('one reader failing costs one fact, never the snapshot', () => {
  it('survives a state reader that throws, and still reports the repository', () => {
    // PIN 9, in the strongest form available: the seam that throws is the one
    // every task goes through.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-01');

    const snapshot = snapshotOf([root], {
      loadState: () => {
        throw new Error('reader exploded');
      },
    });

    // The snapshot exists, the repository is present, and the failure is named.
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.observedAt).toBe(FIXED_NOW.toISOString());
  });

  it('keeps other repositories when one cannot be canonicalised', () => {
    const good = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    const snapshot = snapshotOf([good, join(good, 'does-not-exist')]);

    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]?.canonicalRoot).toBe(good);
    expect(snapshot.notes.some((n) => n.code === 'REPOSITORY_ROOT_UNRESOLVABLE')).toBe(true);
  });
});

/* ═══════ quota: the distinction that keeps a phone useful ═══════════════ */

describe('a quota block the machine still owns is not operator attention', () => {
  it('reads a recorded future reset as an automatic wait', () => {
    // PIN 10. This is the difference between a dashboard an operator trusts and
    // one they learn to ignore.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-01', {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'codex',
      resumeFrom: { phase: 'REVIEW', round: 1 },
      reviewRound: 1,
      reportedResetAt: '2026-09-15T23:00:00.000Z', // after FIXED_NOW
    });

    const snapshot = snapshotOf([root]);
    const [task] = snapshot.repositories[0]?.tasks ?? [];
    expect(task?.attention.reading).toBe('AUTOMATIC_WAIT');
    if (task?.attention.reading !== 'AUTOMATIC_WAIT') return;
    expect(task.attention.until).toBe('2026-09-15T23:00:00.000Z');
  });

  it('reads a quota block with no recorded reset as needing a person', () => {
    // PIN 11. Nothing will wake it, so it is the operator's.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-01', {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'codex',
      resumeFrom: { phase: 'REVIEW', round: 1 },
      reviewRound: 1,
      reportedResetAt: null,
    });

    const snapshot = snapshotOf([root]);
    const [task] = snapshot.repositories[0]?.tasks ?? [];
    expect(task?.attention.reading).toBe('OPERATOR_REQUIRED');
    if (task?.attention.reading !== 'OPERATOR_REQUIRED') return;
    expect(task.attention.reason).toBe('QUOTA_CONTINUATION_REQUIRED');
    expect(task.attention.action.length).toBeGreaterThan(20);
  });
});

/* ═══════ liveness and freshness claims ══════════════════════════════════ */

describe('the snapshot never claims more than it observed', () => {
  it('makes no global running claim, even with no lease anywhere', () => {
    // PIN 17. AO writes no pidfile, no heartbeat and no daemon record, so
    // "no lease" cannot become "AgentOrchestrator is not running".
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    const snapshot = snapshotOf([root]);

    expect(snapshot).not.toHaveProperty('running');
    expect(snapshot).not.toHaveProperty('orchestrator');
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('NOT_RUNNING');
    expect(serialized).not.toContain('"idle"');
  });

  it('names a recorded commit as recorded, and exposes no observed HEAD', () => {
    // PIN 18. A stored pass plus a recorded commit is not "this worktree is
    // verified": proving that needs a fresh rev-parse, which a poll will not do.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-01');

    const snapshot = snapshotOf([root]);
    const [task] = snapshot.repositories[0]?.tasks ?? [];
    if (task?.runtime.reading !== 'LOADED') throw new Error('expected a loaded record');

    expect(task.runtime.facts).toHaveProperty('recordedCurrentCommit');
    expect(task.runtime.facts).not.toHaveProperty('currentCommit');
    expect(task.runtime.facts).not.toHaveProperty('observedCommit');
    expect(task.runtime.facts).not.toHaveProperty('headCommit');
    // The phase agent is recorded, not observed running.
    expect(task.runtime.facts).toHaveProperty('recordedPhaseAgent');
    expect(task.runtime.facts).not.toHaveProperty('runningAgent');
  });
});

/* ═══════ one clock ══════════════════════════════════════════════════════ */

describe('one observation uses one clock', () => {
  it('reads the clock exactly once for the whole snapshot', () => {
    // PIN 12. Two tasks on the same reset must not disagree about whether it
    // has passed because one was judged a millisecond later.
    const first = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    const second = repository({ 'tasks/D1-02.md': taskFile('D1-02') });
    writeRuntimeState(first, 'D1-01', {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'codex',
      resumeFrom: { phase: 'REVIEW', round: 1 },
      reviewRound: 1,
      reportedResetAt: '2026-09-15T23:00:00.000Z',
    });
    writeRuntimeState(second, 'D1-02', {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'codex',
      resumeFrom: { phase: 'REVIEW', round: 1 },
      reviewRound: 1,
      reportedResetAt: '2026-09-15T23:00:00.000Z',
    });

    let reads = 0;
    const snapshot = readDashboardSnapshot({
      now: () => {
        reads += 1;
        return FIXED_NOW;
      },
      loadRegistry: () => registryOf(first, second),
    });

    expect(reads).toBe(1);
    const readings = snapshot.repositories.flatMap((r) => r.tasks.map((t) => t.attention.reading));
    expect(new Set(readings)).toEqual(new Set(['AUTOMATIC_WAIT']));
  });
});

/* ═══════ the filesystem is untouched, and no handle survives ════════════ */

describe('observing changes nothing and holds nothing', () => {
  it('creates no file and changes no byte', () => {
    // PIN 15.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-01');
    const statePath = join(root, '.agent-orchestrator', 'runtime', 'D1-01.json');

    const before = readFileSync(statePath);
    const beforeStat = statSync(statePath);

    snapshotOf([root]);

    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(statSync(statePath).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(statSync(statePath).size).toBe(beforeStat.size);
  });

  it('leaves no handle behind, proven by AO’s own replacement succeeding', () => {
    // PIN 16, and the one that matters most. Slice 0 measured that a reader
    // holding a handle makes this exact rename fail with EPERM, 50 times out of
    // 50. So this is a real detector, not a formality: if any reader in the
    // snapshot path retains a handle, this rename fails.
    const root = repository({ 'tasks/D1-01.md': taskFile('D1-01') });
    writeRuntimeState(root, 'D1-01');
    const directory = join(root, '.agent-orchestrator', 'runtime');
    const target = join(directory, 'D1-01.json');

    snapshotOf([root]);

    // AO's durable write, replicated: temp in the same directory, fsync, close,
    // one rename. Issued immediately after the snapshot returns.
    const temp = join(directory, 'D1-01.json.tmp-pin16');
    const handle = openSync(temp, 'wx', 0o600);
    const bytes = Buffer.from(readFileSync(target));
    writeSync(handle, bytes, 0, bytes.length);
    fsyncSync(handle);
    closeSync(handle);

    expect(() => renameSync(temp, target)).not.toThrow();
    rmSync(temp, { force: true });
  });
});
