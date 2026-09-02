/**
 * M3 slice 1 — the persistent scheduler, in process.
 *
 * ── What this file measures, and what it deliberately leaves to the harness ─
 *
 * Everything here is decided by values: the wake horizon read from real state
 * files on disk, the arithmetic of the wait, the fail-closed ordering of the
 * refusals, and the CLI's argument boundary. Real Git repositories are built for
 * every case that reads durable state, because the subject *is* what is on disk;
 * the clock and the sleep are injected, because a test that really waited three
 * hours is not a test.
 *
 * What this file cannot measure, and does not pretend to:
 *
 *  - that a **different operating-system process** reconstructs the same wait.
 *    Calling `driveScheduler` twice in one process and calling the second call a
 *    restart would be exactly the substitution the slice brief forbids. That is
 *    `tests/dist-artifact/persistent-scheduler-dist-artifact.mjs`, which stops
 *    and restarts the shipped CLI for real;
 *  - that two schedulers racing for one repository cannot both execute it. That
 *    needs two real processes and a real lease, and is in the same harness.
 *
 * ── The one control that makes the negatives mean something ────────────────
 *
 * Several cases assert "the scheduler did not sleep". That is worth nothing if
 * the fixture could not have produced a sleep, so every such case is written
 * against a fixture that differs from a sleeping one in exactly the property
 * under test, and the sleeping case is asserted in the same `describe` from the
 * same builder.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';

import { registerRepositoriesCommand } from '../src/cli/repositories-command.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import type { AuthPreflightEvidence } from '../src/core/auth-preflight-evidence.js';
import { evaluateAutomaticResume } from '../src/core/automatic-resume.js';
import {
  loadRepositoryRegistry,
  repositoryRegistryPath,
  resolveRegisteredRepositories,
  type RegisteredRepository,
} from '../src/registry/repository-registry.js';
import { resolveRepository } from '../src/repo/resolve-repository.js';
import type { CrossRepositoryRunResult } from '../src/run/repository-coordinator.js';
import type { LifecycleResult } from '../src/run/lifecycle-driver.js';
import { MAX_WAIT_MS_CEILING } from '../src/run/unattended-resume.js';
import {
  BOUNDED_SLEEP_OUTCOMES,
  realCancellableSleep,
  SLEEP_CHUNK_MS,
  sleepUntilInstant,
} from '../src/schedule/bounded-sleep.js';
import {
  MAX_SCANNED_STATE_FILES_PER_REPOSITORY,
  scanDurableWakes,
  WAKE_SCAN_NOTES,
} from '../src/schedule/durable-wake.js';
import {
  driveScheduler,
  isUsableCycleBound,
  MAX_SCHEDULER_CYCLES,
  SCHEDULER_DISPOSITIONS,
  type SchedulerDependencies,
  type SchedulerRegistryRead,
  type SchedulerRequest,
} from '../src/schedule/scheduler.js';
import {
  SCHEDULER_DISPOSITION_SENTENCES,
  WAKE_SCAN_NOTE_SENTENCES,
} from '../src/cli/render-schedule.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';

const created: string[] = [];

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(root: string, relativePath: string, contents: string): void {
  const target = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function profileYaml(id: string): string {
  return `schemaVersion: 1
repository:
  id: ${id}
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: .agent-orchestrator/tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: VERIFY
      command: [node, --version]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: 1
remote:
  required: false
`;
}

function taskFile(id: string): string {
  return `---
id: ${id}
title: task ${id}
status: OPEN
kind: NORMAL
priority: NORMAL
currentFocus: false
dependsOn: []
---
body
`;
}

/** A real Git repository with a profile and the named tasks. */
function makeRepository(id: string, tasks: readonly string[]): string {
  const root = makeCanonicalTempDir('ao-m3s1-');
  created.push(root);
  git(root, ['init', '-b', 'main', '--quiet']);
  write(root, '.gitattributes', '* -text\n');
  write(root, '.gitignore', '.agent-orchestrator/runtime/\n');
  write(root, 'README.md', `# ${id}\n`);
  write(root, '.agent-orchestrator/repo-profile.yaml', profileYaml(id));
  for (const task of tasks) write(root, `.agent-orchestrator/tasks/${task}.md`, taskFile(task));
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

/**
 * A durable `BLOCKED_USAGE_LIMIT` state, written straight into the runtime
 * directory.
 *
 * Hand-written on purpose. The subject of this slice is what a **fresh process**
 * can read back from disk, so the record has to be the thing on disk rather than
 * something this process is holding — and a state produced by driving a real
 * agent would need a real agent. The document is validated on the way back in by
 * `loadTaskState`, which is the same gate any production reader passes, so a
 * fixture this schema would refuse cannot silently become a passing case.
 */
function writeBlockedState(
  root: string,
  taskId: string,
  reportedResetAt: string | null,
  overrides: Record<string, unknown> = {},
): string {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const parent = dirname(root);
  const base = root.slice(parent.length + 1);
  const worktreePath = join(parent, `${base}.worktrees`, taskId);
  const state = {
    schemaVersion: 1,
    taskId,
    repositoryId: `${base}`,
    repositoryRoot: root,
    worktreePath,
    state: 'BLOCKED_USAGE_LIMIT',
    stateEnteredAt: '2026-09-01T00:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: head,
    scopeAuthorityCommit: null,
    workBranch: `ao/task/${taskId}`,
    currentCommit: head,
    reviewRound: 0,
    maxReviewRounds: 1,
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    reportedResetAt,
    worktreeCleanAtCheckpoint: true,
    findingHistory: [],
    ...overrides,
  };
  const path = join(root, '.agent-orchestrator', 'runtime', `${taskId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return path;
}

async function registered(root: string): Promise<RegisteredRepository> {
  const resolution = await resolveRepository({ repositoryPath: root });
  if (!resolution.ok) throw new Error(`fixture did not resolve: ${resolution.code}`);
  return Object.freeze({ declaredPath: root, repository: resolution.repository });
}

afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked Git file on Windows must not fail an otherwise passing suite.
    }
  }
});

/* ─────────────────────────── instruments ────────────────────────────────── */

const NOW = '2026-09-02T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

/** A coordinator result with only the fields this file reads. */
function runResult(
  overrides: Partial<CrossRepositoryRunResult> = {},
): CrossRepositoryRunResult {
  return Object.freeze({
    outcome: 'NOTHING_ADMITTED',
    planCode: 'ALL_TASKS_COMPLETE',
    admissions: Object.freeze([]),
    passes: 1,
    maxObservedConcurrency: 0,
    capacity: 1,
    reasonCodes: Object.freeze([]),
    ...overrides,
  }) as unknown as CrossRepositoryRunResult;
}

/** A lifecycle result with only the fields the exit-code grader reads. */
function lifecycleResult(outcome: LifecycleResult['outcome']): LifecycleResult {
  return Object.freeze({
    outcome,
    taskId: 'unused',
    acquire: null,
    recovery: null,
    release: null,
    start: null,
    runs: Object.freeze([]),
    invocations: 0,
    steps: 0,
    reasonCodes: Object.freeze([]),
    permissionDenials: Object.freeze({ observed: false, denials: Object.freeze([]) }),
  }) as unknown as LifecycleResult;
}

/**
 * A scheduler harness: a controllable clock, a recorded sleep, and a
 * coordinator seam that answers without driving anything.
 *
 * The clock **advances by whatever the sleep was asked for**, which is what
 * makes a multi-cycle case behave like real time without taking real time: a
 * cycle that slept two hours sees a `now` two hours later, so a wake it has
 * passed stops being future and the loop's own termination argument is
 * exercised rather than assumed.
 */
function harness(options: {
  readonly nowMs?: number;
  readonly runs?: readonly CrossRepositoryRunResult[];
  readonly onCycle?: (sequence: number) => void;
  readonly registry?: () => Promise<SchedulerRegistryRead>;
  readonly stopAfterSleeps?: number;
} = {}): {
  readonly deps: SchedulerDependencies;
  readonly sleeps: number[];
  readonly cycles: number[];
  readonly preflights: number;
  readonly preflightFactories: () => number;
  nowMs: () => number;
} {
  let clock = options.nowMs ?? NOW_MS;
  const sleeps: number[] = [];
  const cycles: number[] = [];
  let factories = 0;
  let stopped = false;
  let settleCancel: () => void = () => {};
  const cancel = new Promise<void>((resolve) => {
    settleCancel = resolve;
  });

  const deps: SchedulerDependencies = {
    now: () => new Date(clock).toISOString(),
    git: runGitCommand,
    authPreflight: () => {
      factories += 1;
      return async (): Promise<AuthPreflightEvidence | null> => provenAuthEvidence();
    },
    resolveRegistry:
      options.registry ??
      (async (): Promise<SchedulerRegistryRead> => ({
        ok: false,
        code: 'NOT_REGISTERED',
      })),
    driveRepositories: async () => {
      const sequence = cycles.length + 1;
      cycles.push(sequence);
      options.onCycle?.(sequence);
      return options.runs?.[sequence - 1] ?? runResult();
    },
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
      if (options.stopAfterSleeps !== undefined && sleeps.length >= options.stopAfterSleeps) {
        stopped = true;
        settleCancel();
      }
    },
    shutdown: { stopped: () => stopped, cancel },
  };

  return {
    deps,
    sleeps,
    cycles,
    get preflights(): number {
      return factories;
    },
    preflightFactories: () => factories,
    nowMs: () => clock,
  };
}

function request(overrides: Partial<SchedulerRequest> = {}): SchedulerRequest {
  return {
    repositories: [],
    maxConcurrentRepositories: 1,
    maxSteps: 1,
    maxInvocations: 1,
    wait: { wait: false },
    ...overrides,
  };
}

/* ══════════════ 1. the durable wake horizon, read from disk ══════════════ */

describe('M3 slice 1 — the durable wake horizon', () => {
  it('reads a future reset out of a real state file, and reports it verbatim', async () => {
    const root = makeRepository('wake-future', ['T-1']);
    const resetAt = new Date(NOW_MS + 3 * 60 * 60 * 1000).toISOString();
    writeBlockedState(root, 'T-1', resetAt);

    const scan = scanDurableWakes([root], { now: NOW, since: NOW });

    expect(scan.earliest).not.toBeNull();
    expect(scan.earliest?.taskId).toBe('T-1');
    expect(scan.earliest?.repositoryRoot).toBe(root);
    // Verbatim: the bytes the record carries, not a reformatting of them.
    expect(scan.earliest?.resetAt).toBe(resetAt);
    expect(scan.earliest?.resetAtMs).toBe(Date.parse(resetAt));
    expect(scan.statesRead).toBe(1);
    expect(scan.notes).toEqual([]);
  });

  it('does NOT report a reset that has already passed', async () => {
    // The same repository and the same task as the case above; the ONLY
    // difference is which side of `now` the instant falls on. Without this the
    // scheduler would compute a sleep of zero, plan again, find the same
    // instant, and spin.
    const root = makeRepository('wake-past', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS - 1).toISOString());

    const scan = scanDurableWakes([root], { now: NOW, since: NOW });

    expect(scan.earliest).toBeNull();
    expect(scan.future).toEqual([]);
    // It was read: the absence is a judgement about the instant, not a failure
    // to look.
    expect(scan.statesRead).toBe(1);
  });

  it('does NOT report a reset exactly equal to now', () => {
    // The equality boundary, and it belongs on this side of the line: the
    // canonical gate denies while `now <= reportedResetAt`, so an instant equal
    // to now is not yet reachable and reporting it would schedule a wake into a
    // guaranteed refusal.
    const root = makeRepository('wake-equal', ['T-1']);
    writeBlockedState(root, 'T-1', NOW);

    expect(scanDurableWakes([root], { now: NOW, since: NOW }).earliest).toBeNull();
  });

  it('never reports a block that records no reset time', () => {
    const root = makeRepository('wake-null', ['T-1']);
    writeBlockedState(root, 'T-1', null);

    const scan = scanDurableWakes([root], { now: NOW, since: NOW });

    expect(scan.earliest).toBeNull();
    expect(scan.statesRead).toBe(1);
    // No note either: a block with no reset is an ordinary, correct record. It
    // is the operator's, and saying nothing about it here is the point.
    expect(scan.notes).toEqual([]);
  });

  it('ignores a task that is not blocked on a quota, whatever instant it carries', () => {
    const root = makeRepository('wake-other-state', ['T-1']);
    // `BLOCKED_AUTH` is not automatically resumable and its policy forbids a
    // reported reset, so the schema itself refuses the combination — which is
    // why this case uses a state the schema accepts and the scan must still
    // skip. `IMPLEMENTING` may carry neither, so the reset is null and the
    // subject is the state name.
    writeBlockedState(root, 'T-1', null, {
      state: 'IMPLEMENTING',
      blockedAgent: null,
      resumeFrom: null,
    });

    const scan = scanDurableWakes([root], { now: NOW, since: NOW });
    expect(scan.earliest).toBeNull();
    expect(scan.statesRead).toBe(1);
  });

  it('takes the earliest across repositories, and orders ties totally', () => {
    const early = makeRepository('wake-a', ['T-1']);
    const late = makeRepository('wake-b', ['T-2']);
    const soon = new Date(NOW_MS + 60_000).toISOString();
    const later = new Date(NOW_MS + 120_000).toISOString();
    writeBlockedState(late, 'T-2', later);
    writeBlockedState(early, 'T-1', soon);

    // Deliberately fed in the WRONG order — the later repository first — so the
    // answer cannot be produced by input order alone.
    const scan = scanDurableWakes([late, early], { now: NOW, since: NOW });

    expect(scan.earliest?.resetAt).toBe(soon);
    expect(scan.future.map((wake) => wake.resetAt)).toEqual([soon, later]);
  });

  it('breaks an identical instant by repository root, against both weaker answers', () => {
    const first = makeRepository('tie-a', ['T-1', 'T-2']);
    const second = makeRepository('tie-b', ['T-1', 'T-2']);
    const at = new Date(NOW_MS + 60_000).toISOString();
    const [low, high] = first < second ? [first, second] : [second, first];

    // The lower-sorting ROOT is given the higher-sorting TASK, so the root
    // comparison and the task comparison disagree about the answer. Without
    // that the case is masked: a fixture whose task ids happen to run the same
    // way as its roots passes with the root comparison deleted, which a
    // mutation campaign measured directly.
    writeBlockedState(low, 'T-2', at);
    writeBlockedState(high, 'T-1', at);

    // And fed HIGH first, so input order is the third wrong answer this rules
    // out.
    const scan = scanDurableWakes([high, low], { now: NOW, since: NOW });

    expect(scan.future.map((wake) => wake.repositoryRoot)).toEqual([low, high]);
    expect(scan.future.map((wake) => wake.taskId)).toEqual(['T-2', 'T-1']);
    expect(scan.earliest?.repositoryRoot).toBe(low);
  });

  it('breaks an identical instant and root by task id, where the file names disagree', () => {
    // `X` and `X-1` are both legal task ids, and their FILE names sort the other
    // way round: `-` (0x2D) precedes `.` (0x2E), so `X-1.json` comes before
    // `X.json` while the id `X` precedes `X-1`. The scan reads names in name
    // order, so this is the one input inside a single repository that reaches
    // the task-id comparison at all.
    //
    // Written after a mutation campaign measured the previous version of this
    // case passing on sort stability: it used `T-1`/`T-2`, whose file names
    // already sort the way their ids do, so dropping both tie-breaks survived.
    const root = makeRepository('tie-c', ['X', 'X-1']);
    const at = new Date(NOW_MS + 60_000).toISOString();
    writeBlockedState(root, 'X-1', at);
    writeBlockedState(root, 'X', at);

    // The premise, asserted rather than assumed: the names really do sort the
    // other way. If a future change made them agree, this case would go on
    // passing while measuring nothing, and this line is what turns red instead.
    expect(['X.json', 'X-1.json'].sort()).toEqual(['X-1.json', 'X.json']);

    const scan = scanDurableWakes([root], { now: NOW, since: NOW });
    expect(scan.future.map((wake) => wake.taskId)).toEqual(['X', 'X-1']);
    expect(scan.earliest?.taskId).toBe('X');
  });

  it('reports an absent runtime directory as ordinary, and an unreadable one as a note', () => {
    const bare = makeRepository('wake-bare', ['T-1']);
    const absent = scanDurableWakes([bare], { now: NOW, since: NOW });
    expect(absent.notes).toEqual(['RUNTIME_DIRECTORY_ABSENT']);
    expect(absent.earliest).toBeNull();

    const unreadable = scanDurableWakes([bare], { now: NOW, since: NOW }, {
      readDirectory: () => {
        const error: NodeJS.ErrnoException = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    });
    expect(unreadable.notes).toEqual(['RUNTIME_DIRECTORY_UNREADABLE']);
    expect(unreadable.earliest).toBeNull();
  });

  it('fails closed on a state file it cannot read', () => {
    const root = makeRepository('wake-broken', ['T-1']);
    const path = join(root, '.agent-orchestrator', 'runtime', 'T-1.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');

    const scan = scanDurableWakes([root], { now: NOW, since: NOW });
    expect(scan.notes).toEqual(['STATE_UNREADABLE']);
    expect(scan.earliest).toBeNull();
    expect(scan.statesRead).toBe(0);
  });

  it('fails closed on a clock that is not a timestamp, and reads nothing at all', () => {
    const root = makeRepository('wake-clock', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());

    let looked = false;
    const scan = scanDurableWakes([root], { now: 'not-a-timestamp', since: 'not-a-timestamp' }, {
      readDirectory: () => {
        looked = true;
        return [];
      },
    });

    expect(scan.notes).toEqual(['CURRENT_TIME_UNPARSEABLE']);
    expect(scan.earliest).toBeNull();
    // The refusal is before the I/O, not after it.
    expect(looked).toBe(false);
  });

  it('ignores files in the runtime directory that are not state files', () => {
    const root = makeRepository('wake-noise', ['T-1']);
    const at = new Date(NOW_MS + 60_000).toISOString();
    writeBlockedState(root, 'T-1', at);
    const dir = join(root, '.agent-orchestrator', 'runtime');
    writeFileSync(join(dir, 'notes.txt'), 'ignore me', 'utf8');
    writeFileSync(join(dir, 'T-1.json.bak'), '{}', 'utf8');

    const scan = scanDurableWakes([root], { now: NOW, since: NOW });
    expect(scan.statesRead).toBe(1);
    expect(scan.earliest?.resetAt).toBe(at);
    expect(scan.notes).toEqual([]);
  });

  it('bounds one repository’s scan and says when it did', () => {
    const root = makeRepository('wake-many', ['T-1']);
    const names = Array.from(
      { length: MAX_SCANNED_STATE_FILES_PER_REPOSITORY + 1 },
      (_unused, index) => `T-${String(index).padStart(6, '0')}.json`,
    );
    const scan = scanDurableWakes([root], { now: NOW, since: NOW }, {
      readDirectory: () => names,
      loadTaskState: () => ({ ok: false, code: 'NO_STATE' }) as never,
    });
    expect(scan.notes).toContain('SCAN_TRUNCATED');
  });

  it('reports a reset that matured DURING the pass as matured, not as nothing', () => {
    // The band a review found missing. `reportedResetAt` is the END of a
    // provider window, so a block met near the end of one records an instant
    // minutes away — and a coordinator pass drives real agents for many minutes.
    const root = makeRepository('wake-matured', ['T-1']);
    const resetAt = new Date(NOW_MS - 60_000).toISOString();
    writeBlockedState(root, 'T-1', resetAt);

    // The pass began two minutes ago; the reset fell one minute ago, inside it.
    const inside = scanDurableWakes([root], {
      now: NOW,
      since: new Date(NOW_MS - 120_000).toISOString(),
    });
    expect(inside.matured.map((wake) => wake.resetAt)).toEqual([resetAt]);
    expect(inside.earliest).toBeNull();

    // The same disk, one cycle later: the pass began after the instant, so the
    // caller HAS had its chance and the band is empty. This is what makes the
    // extra cycle exactly one.
    const after = scanDurableWakes([root], {
      now: NOW,
      since: new Date(NOW_MS - 30_000).toISOString(),
    });
    expect(after.matured).toEqual([]);
    expect(after.earliest).toBeNull();
  });

  it('a future reset is future, never matured', () => {
    const root = makeRepository('wake-band', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const scan = scanDurableWakes([root], {
      now: NOW,
      since: new Date(NOW_MS - 600_000).toISOString(),
    });
    expect(scan.future).toHaveLength(1);
    expect(scan.matured).toEqual([]);
  });

  it('every note has a sentence', () => {
    // The total map is `satisfies`-checked at compile time, which proves it is
    // complete and never that any entry says anything. This proves each one is
    // a non-empty sentence about that note.
    for (const note of WAKE_SCAN_NOTES) {
      expect(WAKE_SCAN_NOTE_SENTENCES[note].length).toBeGreaterThan(20);
    }
  });
});

/* ══════════ 2. the due condition agrees with the canonical authority ══════ */

describe('M3 slice 1 — the scheduler does not hold a second opinion about "due"', () => {
  /**
   * The scheduler computes a *time to look again*; `evaluateAutomaticResume`
   * decides whether anything may then happen. This pins that the scheduler's
   * wake instant is the earliest one at which that authority could possibly say
   * yes — no earlier, which would schedule a guaranteed refusal, and no later,
   * which would leave work parked past its own reset.
   */
  const evaluateAt = (nowIso: string, resetAt: string): readonly string[] => {
    const root = makeRepository('due', ['T-1']);
    writeBlockedState(root, 'T-1', resetAt);
    const state = JSON.parse(
      readFileSync(join(root, '.agent-orchestrator', 'runtime', 'T-1.json'), 'utf8'),
    ) as never;
    return evaluateAutomaticResume(state, {
      now: nowIso,
      authEvidence: provenAuthEvidence(),
      observedRepositoryId: 'ignored',
      observedRepositoryRoot: 'ignored',
      observedWorktreePath: 'ignored',
      worktreeExists: true,
      observedBasePinnedCommit: null,
      observedCurrentCommit: null,
      worktreeClean: true,
      divergenceDetected: false,
    }).reasonCodes;
  };

  it('the reported instant itself is still refused by the authority', () => {
    const at = new Date(NOW_MS + 60_000).toISOString();
    expect(evaluateAt(at, at)).toContain('RESET_TIME_NOT_REACHED');
  });

  it('one millisecond later is not, so the scheduler aims there', () => {
    const at = new Date(NOW_MS + 60_000).toISOString();
    const oneLater = new Date(NOW_MS + 60_001).toISOString();
    expect(evaluateAt(oneLater, at)).not.toContain('RESET_TIME_NOT_REACHED');
  });

  it('the scheduler sleeps to exactly reset + 1 ms', async () => {
    const root = makeRepository('due-sleep', ['T-1']);
    const resetAt = new Date(NOW_MS + 5 * 60_000).toISOString();
    writeBlockedState(root, 'T-1', resetAt);
    const entry = await registered(root);
    // The default registry seam refuses, so the loop ends after this one wait
    // and every millisecond in `sleeps` belongs to it.
    const test = harness();

    await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 4, idlePollMs: null },
      }),
      test.deps,
    );

    // The whole distance, across however many chunks it took: 5 minutes plus
    // the millisecond. The chunking is the sleep's business and is measured in
    // its own describe; what is pinned here is the total the scheduler aimed at.
    expect(test.sleeps.reduce((total, ms) => total + ms, 0)).toBe(5 * 60_000 + 1);
    expect(Math.max(...test.sleeps)).toBeLessThanOrEqual(SLEEP_CHUNK_MS);
  });
});

/* ═════════════════ 3. the scheduler loop, cycle by cycle ═════════════════ */

describe('M3 slice 1 — the scheduler loop', () => {
  it('makes exactly one pass, and scans nothing at all, when waiting was not requested', async () => {
    const root = makeRepository('loop-no-wait', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);
    const test = harness();

    let scanned = false;
    const result = await driveScheduler(request({ repositories: [entry] }), {
      ...test.deps,
      scanDurableWakes: () => {
        scanned = true;
        return { earliest: null, future: [], matured: [], statesRead: 0, notes: [] };
      },
    });

    expect(result.cycles).toHaveLength(1);
    expect(result.ending).toBe('NOT_REQUESTED');
    expect(test.sleeps).toEqual([]);
    // The promise `repositories --attended` keeps: an invocation that cannot
    // wait opens nothing extra. The fixture DOES carry a future wake, so a scan
    // would have found one — this is the property, not the fixture.
    expect(scanned).toBe(false);
  });

  it('stops when nothing is recorded to wait for', async () => {
    const root = makeRepository('loop-nothing', ['T-1']);
    const entry = await registered(root);
    const test = harness();

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: 60_000, maxCycles: 8, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.ending).toBe('NO_FUTURE_WAKE');
    expect(result.cycles).toHaveLength(1);
    expect(test.sleeps).toEqual([]);
  });

  it('waits, plans again, and stops once the reset it waited for has passed', async () => {
    const root = makeRepository('loop-wait', ['T-1']);
    const resetAt = new Date(NOW_MS + 90_000).toISOString();
    writeBlockedState(root, 'T-1', resetAt);
    const entry = await registered(root);

    // Cycle 2 sees the same state file — the reset is now in the past, so the
    // scan reports no future wake and the loop ends. That is the termination
    // argument, driven rather than asserted.
    const test = harness({
      registry: async () => ({
        ok: true,
        repositories: [entry],
        maxConcurrentRepositories: 1,
      }),
    });

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.cycles.map((cycle) => cycle.disposition)).toEqual(['WAITED', 'NO_FUTURE_WAKE']);
    expect(result.cycles[0]?.wake?.resetAt).toBe(resetAt);
    expect(result.cycles[0]?.waitedMs).toBe(90_001);
    expect(test.cycles).toEqual([1, 2]);
  });

  it('refuses to sleep past the operator’s bound, and consumes nothing', async () => {
    const root = makeRepository('loop-bound', ['T-1']);
    const statePath = writeBlockedState(root, 'T-1', new Date(NOW_MS + 3_600_000).toISOString());
    const before = readFileSync(statePath);
    const entry = await registered(root);
    const test = harness();

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: 60_000, maxCycles: 8, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.ending).toBe('BOUND_EXCEEDED');
    expect(test.sleeps).toEqual([]);
    // The wait is still on disk, unchanged, for the next invocation to find.
    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(result.cycles[0]?.wake).not.toBeNull();
  });

  it('stops on the cycle budget with a wake still ahead', async () => {
    // Two wakes, so that a second one is still ahead after the first has been
    // waited out — otherwise the loop would end on `NO_FUTURE_WAKE` and this
    // case would measure the fixture rather than the budget.
    const root = makeRepository('loop-cycles', ['T-1', 'T-2']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    writeBlockedState(root, 'T-2', new Date(NOW_MS + 3_600_000).toISOString());
    const entry = await registered(root);
    const test = harness({
      registry: async () => ({ ok: true, repositories: [entry], maxConcurrentRepositories: 1 }),
    });

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 2, idlePollMs: null },
      }),
      test.deps,
    );

    // Cycle 1 waits for the nearer wake; cycle 2 meets the budget with the
    // further one still on disk, and says so rather than sleeping again.
    expect(result.cycles.map((cycle) => cycle.disposition)).toEqual([
      'WAITED',
      'CYCLE_BUDGET_SPENT',
    ]);
    expect(result.ending).toBe('CYCLE_BUDGET_SPENT');
    expect(result.cycles[1]?.wake?.taskId).toBe('T-2');
  });

  it('proves auth again for every cycle', async () => {
    const root = makeRepository('loop-preflight', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);
    const test = harness({
      registry: async () => ({ ok: true, repositories: [entry], maxConcurrentRepositories: 1 }),
    });

    await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      test.deps,
    );

    // One factory call per cycle. A memo reused across the sleep would show up
    // here as one, and would let a login proven before the wait authorise the
    // work after it.
    expect(test.preflightFactories()).toBe(test.cycles.length);
    expect(test.cycles.length).toBeGreaterThan(1);
  });

  it('reads the registry again after a wait, and stops when it cannot', async () => {
    const root = makeRepository('loop-registry', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);
    const test = harness({
      registry: async () => ({ ok: false, code: 'REGISTRY_MALFORMED' }),
    });

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.ending).toBe('REGISTRY_UNUSABLE_AFTER_WAIT');
    expect(result.registryRefusal).toBe('REGISTRY_MALFORMED');
    // It slept first: the refusal is about the world after the wait.
    expect(test.sleeps.reduce((total, ms) => total + ms, 0)).toBe(60_001);
  });

  it('drives the repositories the post-wait registry names, not the ones it started with', async () => {
    const first = makeRepository('loop-swap-a', ['T-1']);
    const second = makeRepository('loop-swap-b', ['T-2']);
    writeBlockedState(first, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entryA = await registered(first);
    const entryB = await registered(second);

    const driven: string[][] = [];
    const test = harness({
      registry: async () => ({ ok: true, repositories: [entryB], maxConcurrentRepositories: 1 }),
    });

    await driveScheduler(
      request({
        repositories: [entryA],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      {
        ...test.deps,
        driveRepositories: async (req) => {
          driven.push(req.repositories.map((entry) => entry.repository.root));
          return runResult();
        },
      },
    );

    expect(driven).toEqual([[first], [second]]);
  });

  it('refuses a capacity the post-wait registry cannot supply', async () => {
    const root = makeRepository('loop-capacity', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);
    const test = harness({
      registry: async () => ({
        ok: true,
        repositories: [entry],
        maxConcurrentRepositories: 99,
      }),
    });

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.ending).toBe('REGISTRY_UNUSABLE_AFTER_WAIT');
    expect(result.registryRefusal).toBe('MAX_CONCURRENT_REPOSITORIES_INVALID');
  });

  it('stops when a shutdown is requested during the sleep', async () => {
    const root = makeRepository('loop-shutdown', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 10 * 60_000).toISOString());
    const entry = await registered(root);

    let stopped = false;
    let settle: () => void = () => {};
    const cancel = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let clock = NOW_MS;
    const sleeps: number[] = [];

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      {
        now: () => new Date(clock).toISOString(),
        git: runGitCommand,
        authPreflight: () => async () => provenAuthEvidence(),
        resolveRegistry: async () => ({ ok: false, code: 'unreachable' }),
        driveRepositories: async () => runResult(),
        sleep: async (ms: number): Promise<void> => {
          sleeps.push(ms);
          clock += ms;
          // Interrupt in the middle of a ten-minute wait.
          if (sleeps.length === 2) {
            stopped = true;
            settle();
          }
        },
        shutdown: { stopped: () => stopped, cancel },
      },
    );

    expect(result.ending).toBe('SHUTDOWN_REQUESTED');
    // It stopped between chunks rather than running the whole distance: a
    // ten-minute wait is ten chunks, and this took three.
    expect(sleeps).toHaveLength(2);
    expect(result.cycles).toHaveLength(1);
  });

  it('a quota block with no reset never produces a wait, however long it sits', async () => {
    const root = makeRepository('loop-null-reset', ['T-1']);
    const statePath = writeBlockedState(root, 'T-1', null);
    const before = readFileSync(statePath);
    const entry = await registered(root);
    const test = harness();

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 64, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.ending).toBe('NO_FUTURE_WAKE');
    expect(result.cycles).toHaveLength(1);
    expect(test.sleeps).toEqual([]);
    expect(readFileSync(statePath).equals(before)).toBe(true);
  });

  it('a wake that leads nowhere costs exactly one extra cycle, not a loop', async () => {
    // The shape M3 must not hot-loop on: a task whose reset passes and which
    // still cannot resume — here because the record's own checkpoint was
    // withdrawn, which no observation of the world can satisfy. The scheduler
    // wakes once for it, plans, and then finds no future wake because the
    // instant is now behind. One wasted pass, bounded.
    const root = makeRepository('loop-hopeless', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString(), {
      currentCommit: null,
      worktreeCleanAtCheckpoint: false,
    });
    const entry = await registered(root);
    const test = harness({
      registry: async () => ({ ok: true, repositories: [entry], maxConcurrentRepositories: 1 }),
    });

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 64, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.cycles.map((cycle) => cycle.disposition)).toEqual(['WAITED', 'NO_FUTURE_WAKE']);
    // One wait, and its whole distance. Two cycles, and no third.
    expect(test.sleeps.reduce((total, ms) => total + ms, 0)).toBe(60_001);
    expect(test.cycles).toEqual([1, 2]);
  });

  it('one waiting repository does not stop another making progress', async () => {
    const waiting = makeRepository('multi-waiting', ['T-1']);
    const runnable = makeRepository('multi-runnable', ['T-2']);
    writeBlockedState(waiting, 'T-1', new Date(NOW_MS + 3_600_000).toISOString());
    const entryA = await registered(waiting);
    const entryB = await registered(runnable);

    const seen: string[][] = [];
    const test = harness();

    const result = await driveScheduler(
      request({
        repositories: [entryA, entryB],
        maxConcurrentRepositories: 2,
        // Deliberately a bound the waiting repository exceeds, so the run ends
        // after one pass. What is measured is that the pass HAPPENED and saw
        // both repositories — the wait is decided after the work, never before.
        wait: { wait: true, maxWaitMs: 60_000, maxCycles: 8, idlePollMs: null },
      }),
      {
        ...test.deps,
        driveRepositories: async (req) => {
          seen.push(req.repositories.map((entry) => entry.repository.root));
          return runResult({ outcome: 'RUN_COMPLETE', planCode: 'TASK_SELECTED' });
        },
      },
    );

    expect(seen).toEqual([[waiting, runnable]]);
    expect(result.ending).toBe('BOUND_EXCEEDED');
    // And the wake it reported is the waiting repository's, named.
    expect(result.cycles[0]?.wake?.repositoryRoot).toBe(waiting);
  });

  it('plans again at once, without sleeping, for a reset that matured during the pass', async () => {
    // The whole failure this closes: a task resumable for eighteen minutes, nine
    // cycles left, and the scheduler stopping because nothing was *future*.
    const root = makeRepository('loop-matured', ['T-1']);
    const statePath = writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);

    let clock = NOW_MS;
    const passes: number[] = [];
    const sleeps: number[] = [];

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      {
        now: () => new Date(clock).toISOString(),
        git: runGitCommand,
        authPreflight: () => async () => provenAuthEvidence(),
        resolveRegistry: async () => ({
          ok: true,
          repositories: [entry],
          maxConcurrentRepositories: 1,
        }),
        driveRepositories: async () => {
          passes.push(passes.length + 1);
          // The pass takes ten minutes, and the reset falls inside it.
          clock += 600_000;
          return runResult();
        },
        sleep: async (ms: number): Promise<void> => {
          sleeps.push(ms);
          clock += ms;
        },
        shutdown: { stopped: () => false, cancel: new Promise<void>(() => {}) },
      },
    );

    // Two passes, and NOT a sleep between them: the instant is already behind,
    // so waiting for it would be waiting for nothing.
    expect(passes).toEqual([1, 2]);
    expect(sleeps).toEqual([]);
    expect(result.cycles.map((entry_) => entry_.disposition)).toEqual([
      'MATURED_DURING_PASS',
      'NO_FUTURE_WAKE',
    ]);
    expect(result.cycles[0]?.wake?.taskId).toBe('T-1');
    // And exactly two: cycle 2's pass began after the instant, so nothing
    // matures again and the loop stops rather than spinning to the budget.
    expect(readFileSync(statePath).length).toBeGreaterThan(0);
  });

  it('the cycle budget stops a matured re-plan too, not only a wait', async () => {
    // There are two budget checks — one on the matured path and one on the
    // waiting path — and a mutation campaign found only the second was covered:
    // flipping `>=` to `>` on the first survived the whole suite, because every
    // budget case reached the loop through a future wake. A gate nothing drives
    // is a gate nobody has measured.
    const root = makeRepository('loop-matured-budget', ['T-1', 'T-2']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 5 * 60_000).toISOString());
    writeBlockedState(root, 'T-2', new Date(NOW_MS + 15 * 60_000).toISOString());
    const entry = await registered(root);

    let clock = NOW_MS;
    const passes: number[] = [];
    const sleeps: number[] = [];

    const result = await driveScheduler(
      request({
        repositories: [entry],
        // Two cycles. Cycle 1 matures T-1 and re-plans; cycle 2 matures T-2 and
        // must stop rather than re-planning a third time.
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 2, idlePollMs: null },
      }),
      {
        now: () => new Date(clock).toISOString(),
        git: runGitCommand,
        authPreflight: () => async () => provenAuthEvidence(),
        resolveRegistry: async () => ({
          ok: true,
          repositories: [entry],
          maxConcurrentRepositories: 1,
        }),
        driveRepositories: async () => {
          passes.push(passes.length + 1);
          clock += 10 * 60_000;
          return runResult();
        },
        sleep: async (ms: number): Promise<void> => {
          sleeps.push(ms);
          clock += ms;
        },
        shutdown: { stopped: () => false, cancel: new Promise<void>(() => {}) },
      },
    );

    expect(passes).toEqual([1, 2]);
    expect(sleeps).toEqual([]);
    expect(result.cycles.map((entry_) => entry_.disposition)).toEqual([
      'MATURED_DURING_PASS',
      'CYCLE_BUDGET_SPENT',
    ]);
    expect(result.cycles[1]?.wake?.taskId).toBe('T-2');
  });

  it('a stop asked for while the registry is being re-read buys no further pass', async () => {
    // The window a review found: the sleep ends, `resolveRegistry` walks the
    // enlisted repositories one at a time starting real `git` children, and an
    // interrupt landing in there used to be seen only at the top of the NEXT
    // cycle's refusals — after that cycle's pass had already been driven, agents
    // included, at a moment when nothing was in flight and nothing was held.
    const root = makeRepository('loop-stop-registry', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);

    let stopped = false;
    let clock = NOW_MS;
    const passes: number[] = [];

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      {
        now: () => new Date(clock).toISOString(),
        git: runGitCommand,
        authPreflight: () => async () => provenAuthEvidence(),
        // The interrupt arrives here, in the window between the sleep ending and
        // the next pass being decided on.
        resolveRegistry: async () => {
          stopped = true;
          return { ok: true, repositories: [entry], maxConcurrentRepositories: 1 };
        },
        driveRepositories: async () => {
          passes.push(passes.length + 1);
          return runResult();
        },
        sleep: async (ms: number): Promise<void> => {
          clock += ms;
        },
        shutdown: { stopped: () => stopped, cancel: new Promise<void>(() => {}) },
      },
    );

    expect(passes).toEqual([1]);
    expect(result.ending).toBe('SHUTDOWN_REQUESTED');
  });

  it('a stop asked for during the last pass is not reported as a clean finish', async () => {
    // Nothing is left to wait for AND a stop was requested. Answering
    // `NO_FUTURE_WAKE` would grade the run `EXIT_RUN_OK` — "I stopped it and it
    // told me everything was fine" — so the shutdown is asked first.
    const root = makeRepository('loop-stop-last', ['T-1']);
    const entry = await registered(root);
    let stopped = false;

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      {
        now: () => NOW,
        git: runGitCommand,
        authPreflight: () => async () => provenAuthEvidence(),
        resolveRegistry: async () => ({ ok: false, code: 'unreachable' }),
        driveRepositories: async () => {
          stopped = true;
          return runResult();
        },
        sleep: async () => {
          throw new Error('must not sleep');
        },
        shutdown: { stopped: () => stopped, cancel: new Promise<void>(() => {}) },
      },
    );

    expect(result.ending).toBe('SHUTDOWN_REQUESTED');
    // And the fixture really has nothing to wait for, so the arm this displaces
    // is reachable: without the stop it answers NO_FUTURE_WAKE.
    expect(result.cycles[0]?.scan.earliest).toBeNull();
  });

  it('does not sleep when a pass could not be shown to have released', async () => {
    // `unattended-resume.ts`'s rule, lifted to a whole pass. Sleeping on an
    // unproven release makes this process a possible writer of that repository
    // for up to a day, with a LIVING pid in the lease document — which refuses
    // every other invocation and refuses stale recovery too. Before this loop
    // existed the process exited within the pass and the pid died.
    const root = makeRepository('loop-release', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);

    for (const admission of [
      { threw: false, lifecycle: lifecycleResult('LEASE_RELEASE_FAILED') },
      { threw: true, lifecycle: lifecycleResult('COMPLETED') },
      { threw: false, lifecycle: null },
    ]) {
      const test = harness({
        runs: [
          runResult({
            outcome: 'RUN_COMPLETE',
            planCode: 'TASK_SELECTED',
            admissions: [
              {
                sequence: 1,
                repositoryId: 'r',
                repositoryRoot: root,
                taskId: 'T-1',
                concurrencyAtAdmission: 1,
                ...admission,
              },
            ],
          } as never),
        ],
      });

      const result = await driveScheduler(
        request({
          repositories: [entry],
          wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
        }),
        test.deps,
      );

      expect(result.ending).toBe('LEASE_RELEASE_UNPROVEN');
      expect(test.sleeps).toEqual([]);
      // The wake was found — this is a refusal to sleep on it, not a failure to
      // see it.
      expect(result.cycles[0]?.wake).not.toBeNull();
    }
  });

  it('refuses on a release RECORD that is not RELEASED, whatever the outcome says', async () => {
    // Not a shape production can build today: `finish` maps every non-`RELEASED`
    // release code onto the `LEASE_RELEASE_FAILED` outcome, so the two readings
    // are one fact spelled twice, and a mutation campaign duly reported dropping
    // the record read as an equivalent mutant.
    //
    // It is pinned anyway, and this comment is what the pin means: the second
    // read exists so that a future `finish` which stops collapsing the two
    // cannot silently disarm the gate. `unattended-resume.ts` proves a release
    // from the record (`RELEASED` is the only proof there is), and citing that
    // module while reading only the summary is how two spellings drift apart.
    const root = makeRepository('loop-release-record', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);

    const test = harness({
      runs: [
        runResult({
          outcome: 'RUN_COMPLETE',
          planCode: 'TASK_SELECTED',
          admissions: [
            {
              sequence: 1,
              repositoryId: 'r',
              repositoryRoot: root,
              taskId: 'T-1',
              concurrencyAtAdmission: 1,
              threw: false,
              lifecycle: {
                ...lifecycleResult('COMPLETED'),
                release: { code: 'LEASE_REMOVE_FAILED' },
              },
            },
          ],
        } as never),
      ],
    });

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.ending).toBe('LEASE_RELEASE_UNPROVEN');
    expect(test.sleeps).toEqual([]);
  });

  it('does sleep when every admission released', async () => {
    // The control for the case above: the same shape, with the one field that
    // decides it flipped.
    const root = makeRepository('loop-release-ok', ['T-1']);
    writeBlockedState(root, 'T-1', new Date(NOW_MS + 60_000).toISOString());
    const entry = await registered(root);
    const released = runResult({
      outcome: 'RUN_COMPLETE',
      planCode: 'TASK_SELECTED',
      admissions: [
        {
          sequence: 1,
          repositoryId: 'r',
          repositoryRoot: root,
          taskId: 'T-1',
          concurrencyAtAdmission: 1,
          threw: false,
          lifecycle: lifecycleResult('BLOCKED_USAGE_LIMIT'),
        },
      ],
    } as never);
    const test = harness({
      runs: [released, released],
      registry: async () => ({ ok: true, repositories: [entry], maxConcurrentRepositories: 1 }),
    });

    const result = await driveScheduler(
      request({
        repositories: [entry],
        wait: { wait: true, maxWaitMs: MAX_WAIT_MS_CEILING, maxCycles: 8, idlePollMs: null },
      }),
      test.deps,
    );

    expect(result.cycles[0]?.disposition).toBe('WAITED');
    expect(test.sleeps.length).toBeGreaterThan(0);
  });

  it('every disposition has a sentence', () => {
    for (const disposition of SCHEDULER_DISPOSITIONS) {
      expect(SCHEDULER_DISPOSITION_SENTENCES[disposition].length).toBeGreaterThan(40);
    }
  });
});

/* ═════════════════════════ 4. the bounded sleep ══════════════════════════ */

describe('M3 slice 1 — the bounded sleep', () => {
  const clockAt = (
    start: number,
  ): { now: () => string; advance: (ms: number) => void; set: (ms: number) => void } => {
    let clock = start;
    return {
      now: () => new Date(clock).toISOString(),
      advance: (ms) => {
        clock += ms;
      },
      set: (ms) => {
        clock = ms;
      },
    };
  };

  it('never hands a timer more than one chunk, however far away the deadline', async () => {
    const clock = clockAt(NOW_MS);
    const asked: number[] = [];
    const outcome = await sleepUntilInstant(NOW_MS + MAX_WAIT_MS_CEILING, MAX_WAIT_MS_CEILING, {
      now: clock.now,
      sleep: async (ms) => {
        asked.push(ms);
        clock.advance(ms);
      },
      shouldStop: () => false,
      cancel: new Promise<void>(() => {}),
    });

    expect(outcome.outcome).toBe('DEADLINE_REACHED');
    expect(Math.max(...asked)).toBeLessThanOrEqual(SLEEP_CHUNK_MS);
    // 24 hours of chunks, and the last one is the remainder.
    expect(asked).toHaveLength(MAX_WAIT_MS_CEILING / SLEEP_CHUNK_MS);
  });

  it('re-reads the clock, so a forward jump costs at most one chunk', async () => {
    const clock = clockAt(NOW_MS);
    let slept = 0;
    const outcome = await sleepUntilInstant(NOW_MS + 3_600_000, 3_600_000, {
      now: clock.now,
      sleep: async (ms) => {
        slept += 1;
        // The clock steps two hours forward during the first chunk: an NTP
        // correction, or a virtual machine resumed from a snapshot.
        clock.advance(slept === 1 ? 7_200_000 : ms);
      },
      shouldStop: () => false,
      cancel: new Promise<void>(() => {}),
    });

    expect(outcome.outcome).toBe('DEADLINE_REACHED');
    // A single duration-timer would still have been counting for another 59
    // minutes. This noticed after one chunk.
    expect(slept).toBe(1);
  });

  it('ends on the chunk budget when the clock STOPS, not only when it steps back', async () => {
    // The title matters. An earlier version of this case was called "when the
    // clock runs backwards" while advancing the clock by zero, and three
    // comments plus the printed operator sentence claimed the ending was
    // reachable only by a backward step. A stopped clock reaches it too — a
    // stalled hypervisor time source is the ordinary way — so the case is named
    // for what it drives and the sentences now say what it shows.
    const clock = clockAt(NOW_MS);
    const outcome = await sleepUntilInstant(NOW_MS + 120_000, 120_000, {
      now: clock.now,
      sleep: async () => {
        /* the clock does not move: the deadline never arrives */
      },
      shouldStop: () => false,
      cancel: new Promise<void>(() => {}),
    });

    expect(outcome.outcome).toBe('CHUNK_BUDGET_SPENT');
    expect(outcome.chunks).toBe(Math.ceil(120_000 / SLEEP_CHUNK_MS) + 2);
  });

  it('ends on the chunk budget when the clock steps backwards', async () => {
    const clock = clockAt(NOW_MS);
    let chunks = 0;
    const outcome = await sleepUntilInstant(NOW_MS + 120_000, 120_000, {
      now: clock.now,
      sleep: async (ms) => {
        chunks += 1;
        // Two minutes of real sleeping, and a clock stepped back an hour during
        // the first chunk: the deadline recedes and the loop would never arrive.
        clock.advance(chunks === 1 ? -3_600_000 : ms);
      },
      shouldStop: () => false,
      cancel: new Promise<void>(() => {}),
    });

    expect(outcome.outcome).toBe('CHUNK_BUDGET_SPENT');
    // And the wall-clock difference it reports is negative, which is why the
    // report labels it wall clock rather than elapsed time.
    expect(outcome.elapsedMs).toBeLessThan(0);
  });

  it('a wait that arrives after a backward step reports a wall clock that hides it', async () => {
    // The other direction, and the one the comment used to get wrong: on the
    // SUCCESS path a backward step is not shown, it is subtracted. Pinned so the
    // sentence describing `elapsedMs` cannot drift back to "a clock step shows
    // up here".
    const clock = clockAt(NOW_MS);
    let chunks = 0;
    const outcome = await sleepUntilInstant(NOW_MS + 300_000, 3_600_000, {
      now: clock.now,
      sleep: async (ms) => {
        chunks += 1;
        // One chunk's worth of backward step — inside the budget's margin, so
        // the wait still arrives. A larger step trips the budget instead, which
        // is the guard doing its job and is pinned by the case above.
        clock.advance(chunks === 1 ? -60_000 : ms);
      },
      shouldStop: () => false,
      cancel: new Promise<void>(() => {}),
    });

    expect(outcome.outcome).toBe('DEADLINE_REACHED');
    // Seven chunks were really slept; the report says five minutes.
    expect(outcome.chunks).toBe(7);
    expect(outcome.elapsedMs).toBe(300_000);
  });

  it('the chunk budget is sized from the wait, not from the bound', async () => {
    // Sized from the bound alone, a five-minute wait under a 24-hour bound
    // carried 1 441 chunks of slack while a wait landing in the top minute of
    // its bound carried one — the margin depended on where in its bound the wait
    // happened to fall. It is now the same two chunks either way, whatever the
    // bound, which is what makes it a predictable guard rather than a lottery.
    const clock = clockAt(NOW_MS);
    const budgets: number[] = [];
    for (const bound of [300_000, 3_600_000, MAX_WAIT_MS_CEILING]) {
      clock.set(NOW_MS);
      // A one-off slew of 90 seconds — under two chunks — during a five-minute
      // wait. It must arrive under every bound, and take the same number of
      // chunks under every bound.
      let chunk = 0;
      const outcome = await sleepUntilInstant(NOW_MS + 300_000, bound, {
        now: clock.now,
        sleep: async (ms) => {
          chunk += 1;
          clock.advance(chunk === 1 ? ms - 90_000 : ms);
        },
        shouldStop: () => false,
        cancel: new Promise<void>(() => {}),
      });
      expect(outcome.outcome).toBe('DEADLINE_REACHED');
      budgets.push(outcome.chunks);
    }
    expect(budgets[0]).toBe(budgets[1]);
    expect(budgets[1]).toBe(budgets[2]);
  });

  it('returns at once when the deadline has already passed', async () => {
    const clock = clockAt(NOW_MS);
    let slept = false;
    const outcome = await sleepUntilInstant(NOW_MS - 1, 60_000, {
      now: clock.now,
      sleep: async () => {
        slept = true;
      },
      shouldStop: () => false,
      cancel: new Promise<void>(() => {}),
    });

    expect(outcome.outcome).toBe('DEADLINE_REACHED');
    expect(outcome.chunks).toBe(0);
    expect(slept).toBe(false);
  });

  it('checks for a stop before the first chunk, not only between them', async () => {
    const clock = clockAt(NOW_MS);
    let slept = false;
    const outcome = await sleepUntilInstant(NOW_MS + 3_600_000, 3_600_000, {
      now: clock.now,
      sleep: async () => {
        slept = true;
      },
      shouldStop: () => true,
      cancel: new Promise<void>(() => {}),
    });

    expect(outcome.outcome).toBe('STOP_REQUESTED');
    expect(slept).toBe(false);
  });

  it('refuses a clock that is not a timestamp', async () => {
    const outcome = await sleepUntilInstant(NOW_MS + 1000, 60_000, {
      now: () => 'not-a-timestamp',
      sleep: async () => {
        throw new Error('must not sleep');
      },
      shouldStop: () => false,
      cancel: new Promise<void>(() => {}),
    });
    expect(outcome.outcome).toBe('CURRENT_TIME_UNPARSEABLE');
    expect(outcome.elapsedMs).toBeNull();
  });

  it('the real sleep returns early when cancelled, and clears its timer', async () => {
    let settle: () => void = () => {};
    const cancel = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const started = Date.now();
    const waiting = realCancellableSleep(SLEEP_CHUNK_MS, cancel);
    settle();
    await waiting;
    // The point is not the elapsed time — it is that awaiting resolved at all
    // rather than in a minute. A leaked timer would also keep this worker alive
    // for a minute after the file finished.
    expect(Date.now() - started).toBeLessThan(SLEEP_CHUNK_MS / 2);
  });

  it('the outcome vocabulary is closed and total', () => {
    expect([...BOUNDED_SLEEP_OUTCOMES]).toEqual([
      'DEADLINE_REACHED',
      'STOP_REQUESTED',
      'CHUNK_BUDGET_SPENT',
      'CURRENT_TIME_UNPARSEABLE',
    ]);
  });
});

/* ══════════════════════ 5. the CLI argument boundary ═════════════════════ */

describe('M3 slice 1 — the CLI refuses before anything is resolved', () => {
  const drive = async (args: readonly string[]): Promise<{ code: number; text: string }> => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((text: string): boolean => {
      chunks.push(String(text));
      return true;
    }) as typeof process.stdout.write;
    const previous = process.exitCode;
    try {
      const program = new Command();
      program.exitOverride();
      registerRepositoriesCommand(program, {
        // If any of these is reached, the refusal did not happen first.
        loadRepositoryRegistry: () => {
          throw new Error('the registry must not be read');
        },
      });
      await program.parseAsync(['node', 'agent-loop', ...args]);
      const code = Number(process.exitCode ?? 0);
      return { code, text: chunks.join('') };
    } finally {
      process.stdout.write = original;
      process.exitCode = previous;
    }
  };

  it('refuses --wait-for-reset without --attended', async () => {
    const { code, text } = await drive(['repositories', '--wait-for-reset']);
    expect(code).toBe(2);
    expect(text).toContain('WAIT_WITHOUT_GRANT');
  });

  it('refuses a wait bound without --attended', async () => {
    const { code, text } = await drive(['repositories', '--max-wait-ms', '1000']);
    expect(code).toBe(2);
    expect(text).toContain('BOUND_WITHOUT_GRANT');
  });

  it('refuses a wait bound without --wait-for-reset', async () => {
    const { code, text } = await drive([
      'repositories',
      '--attended',
      '--max-wait-ms',
      '1000',
    ]);
    expect(code).toBe(2);
    expect(text).toContain('WAIT_BOUND_WITHOUT_WAIT');
  });

  it('refuses a wait with no --max-wait-ms', async () => {
    const { code, text } = await drive(['repositories', '--attended', '--wait-for-reset']);
    expect(code).toBe(2);
    expect(text).toContain('MAX_WAIT_MS_REQUIRED');
  });

  it('refuses a wait with no --max-cycles', async () => {
    const { code, text } = await drive([
      'repositories',
      '--attended',
      '--wait-for-reset',
      '--max-wait-ms',
      '1000',
    ]);
    expect(code).toBe(2);
    expect(text).toContain('MAX_CYCLES_REQUIRED');
  });

  it('refuses a wait bound above the ceiling', async () => {
    const { code, text } = await drive([
      'repositories',
      '--attended',
      '--wait-for-reset',
      '--max-wait-ms',
      String(MAX_WAIT_MS_CEILING + 1),
      '--max-cycles',
      '2',
    ]);
    expect(code).toBe(2);
    expect(text).toContain('MAX_WAIT_MS_INVALID');
  });

  it('refuses a cycle bound of one', async () => {
    const { code, text } = await drive([
      'repositories',
      '--attended',
      '--wait-for-reset',
      '--max-wait-ms',
      '1000',
      '--max-cycles',
      '1',
    ]);
    expect(code).toBe(2);
    expect(text).toContain('MAX_CYCLES_INVALID');
  });

  it('refuses a cycle bound above the ceiling', async () => {
    const { code, text } = await drive([
      'repositories',
      '--attended',
      '--wait-for-reset',
      '--max-wait-ms',
      '1000',
      '--max-cycles',
      String(MAX_SCHEDULER_CYCLES + 1),
    ]);
    expect(code).toBe(2);
    expect(text).toContain('MAX_CYCLES_INVALID');
  });

  it('the scheduler refuses an unusable bound itself, before any pass', async () => {
    // "Another module's reasoning says this cannot happen" is not a check, and
    // the cost of being wrong is a loop bounded by nothing: `sequence >= NaN` is
    // false forever. This is the same rule the loop applies to the registry's
    // capacity after a wait, applied to its own arguments.
    const root = makeRepository('bounds-entry', ['T-1']);
    const entry = await registered(root);

    for (const [wait, ending] of [
      [{ wait: true, maxWaitMs: Number.NaN, maxCycles: 4, idlePollMs: null }, 'WAIT_BOUND_UNUSABLE'],
      [{ wait: true, maxWaitMs: MAX_WAIT_MS_CEILING + 1, maxCycles: 4, idlePollMs: null }, 'WAIT_BOUND_UNUSABLE'],
      [{ wait: true, maxWaitMs: 1000, maxCycles: Number.NaN, idlePollMs: null }, 'CYCLE_BOUND_UNUSABLE'],
      [{ wait: true, maxWaitMs: 1000, maxCycles: 1, idlePollMs: null }, 'CYCLE_BOUND_UNUSABLE'],
      [
        { wait: true, maxWaitMs: 1000, maxCycles: MAX_SCHEDULER_CYCLES + 1, idlePollMs: null },
        'CYCLE_BOUND_UNUSABLE',
      ],
    ] as const) {
      let drove = false;
      const result = await driveScheduler(
        request({ repositories: [entry], wait }),
        {
          now: () => NOW,
          git: runGitCommand,
          authPreflight: () => async () => provenAuthEvidence(),
          resolveRegistry: async () => ({ ok: false, code: 'unreachable' }),
          driveRepositories: async () => {
            drove = true;
            return runResult();
          },
          sleep: async () => {
            throw new Error('must not sleep');
          },
        },
      );
      expect(result.ending).toBe(ending);
      expect(result.cycles).toEqual([]);
      // Before any effect: no pass, no lease, no `git` child.
      expect(drove).toBe(false);
    }
  });

  it('the cycle bound predicate is total and fail-closed', () => {
    expect(isUsableCycleBound(2)).toBe(true);
    expect(isUsableCycleBound(MAX_SCHEDULER_CYCLES)).toBe(true);
    expect(isUsableCycleBound(1)).toBe(false);
    expect(isUsableCycleBound(0)).toBe(false);
    expect(isUsableCycleBound(-1)).toBe(false);
    expect(isUsableCycleBound(2.5)).toBe(false);
    expect(isUsableCycleBound(Number.NaN)).toBe(false);
    expect(isUsableCycleBound(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isUsableCycleBound(MAX_SCHEDULER_CYCLES + 1)).toBe(false);
  });
});

/* ════════════ 6. the wait grant adds no authority to an admission ═════════ */

describe('M3 slice 1 — scope', () => {
  it('the scheduler forwards the coordinator’s own request and adds nothing', async () => {
    const root = makeRepository('scope-grant', ['T-1']);
    const entry = await registered(root);
    const seen: unknown[] = [];
    const test = harness();

    await driveScheduler(
      request({ repositories: [entry], maxSteps: 5, maxInvocations: 3 }),
      {
        ...test.deps,
        driveRepositories: async (req) => {
          seen.push({ ...req, repositories: req.repositories.length });
          return runResult();
        },
      },
    );

    expect(seen).toEqual([
      {
        repositories: 1,
        maxConcurrentRepositories: 1,
        maxSteps: 5,
        maxInvocations: 3,
      },
    ]);
  });

  it('the scheduler module names no grant, no notification and no cron', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'schedule', 'scheduler.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Structural, on the code with its prose removed: this loop may not reach
    // for a continuation grant, a notifier, a cron expression or a persisted
    // schedule of its own.
    for (const forbidden of [
      'continuationGrant',
      'recoverStaleLease',
      'notify',
      'Notification',
      'cron',
      'saveTaskState',
      'advanceTaskState',
      'acquireRepositoryExecutionLease',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('the wake scan writes nothing and takes no lease', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'schedule', 'durable-wake.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of [
      'writeFileSync',
      'saveTaskState',
      'advanceTaskState',
      'acquireRepositoryExecutionLease',
      'setTimeout',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('the registry document gained no scheduling field', () => {
    // The registry is `repositories` plus `maxConcurrentRepositories`, and this
    // slice added nothing to it: a due time, a queue or a schedule written into
    // the operator's file would be the second persisted authority the design
    // refuses.
    const home = makeCanonicalTempDir('ao-m3s1-home-');
    created.push(home);
    const root = makeRepository('registry-shape', ['T-1']);
    mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
    writeFileSync(
      join(home, '.agent-orchestrator', 'repositories.yaml'),
      `schemaVersion: 1\nrepositories:\n  - path: ${JSON.stringify(root)}\nwakeAt: "2026-01-01T00:00:00Z"\n`,
      'utf8',
    );
    const outcome = loadRepositoryRegistry(fixedPathProvider(home));
    expect(outcome.state).not.toBe('REGISTERED');
  });

  it('the registry path is unchanged', () => {
    const home = makeCanonicalTempDir('ao-m3s1-path-');
    created.push(home);
    expect(repositoryRegistryPath(fixedPathProvider(home))).toBe(
      join(home, '.agent-orchestrator', 'repositories.yaml'),
    );
  });
});

/* ═══════════════════════════ 7. the exit codes ═══════════════════════════ */

describe('M3 slice 1 — the exit code', () => {
  it('grades the worst of the ending and every cycle’s run', async () => {
    const { exitCodeForScheduler } = await import('../src/cli/run-exit-codes.js');

    const clean = exitCodeForScheduler({
      cycles: [
        {
          sequence: 1,
          run: runResult({ outcome: 'RUN_COMPLETE', planCode: 'TASK_SELECTED' }),
          scan: { earliest: null, future: [], matured: [], statesRead: 0, notes: [] },
          disposition: 'NO_FUTURE_WAKE',
          wake: null,
          waitedMs: null,
        },
      ],
      ending: 'NO_FUTURE_WAKE',
      registryRefusal: null,
    });
    expect(clean).toBe(0);

    // A repository that stopped needing an operator in cycle 1 still does after
    // cycle 2 waited perfectly for an unrelated one.
    const blocked = exitCodeForScheduler({
      cycles: [
        {
          sequence: 1,
          run: runResult({
            outcome: 'RUN_COMPLETE',
            planCode: 'TASK_SELECTED',
            admissions: [
              {
                sequence: 1,
                repositoryId: 'a',
                repositoryRoot: 'a',
                taskId: 'T-1',
                concurrencyAtAdmission: 1,
                threw: false,
                lifecycle: lifecycleResult('BLOCKED_AUTH'),
              },
            ],
          } as never),
          scan: { earliest: null, future: [], matured: [], statesRead: 0, notes: [] },
          disposition: 'WAITED',
          wake: null,
          waitedMs: 1,
        },
        {
          sequence: 2,
          run: runResult({ outcome: 'RUN_COMPLETE', planCode: 'TASK_SELECTED' }),
          scan: { earliest: null, future: [], matured: [], statesRead: 0, notes: [] },
          disposition: 'NO_FUTURE_WAKE',
          wake: null,
          waitedMs: null,
        },
      ],
      ending: 'NO_FUTURE_WAKE',
      registryRefusal: null,
    } as never);
    expect(blocked).toBe(3);
  });

  it('a run that did not ask to wait is graded exactly as it was before', async () => {
    // The M2 promise, held as an equality rather than as an argument: for every
    // coordinator ending, the scheduler's grader must answer what
    // `exitCodeForCrossRepositoryRun` answered on its own.
    const { exitCodeForCrossRepositoryRun, exitCodeForScheduler } = await import(
      '../src/cli/run-exit-codes.js'
    );
    const runs = [
      runResult({ outcome: 'RUN_COMPLETE', planCode: 'TASK_SELECTED' }),
      runResult({ outcome: 'NOTHING_ADMITTED', planCode: 'ALL_TASKS_COMPLETE' }),
      runResult({ outcome: 'NOTHING_ADMITTED', planCode: 'REPOSITORY_UNPLANNABLE' }),
      runResult({ outcome: 'CAPACITY_INVALID', planCode: null }),
      runResult({ outcome: 'PLANNING_REFUSED_MIDRUN', planCode: 'REPOSITORY_UNPLANNABLE' }),
      runResult({ outcome: 'ADMISSION_BUDGET_EXHAUSTED', planCode: 'TASK_SELECTED' }),
      runResult({
        outcome: 'RUN_COMPLETE',
        planCode: 'TASK_SELECTED',
        admissions: [
          {
            sequence: 1,
            repositoryId: 'a',
            repositoryRoot: 'a',
            taskId: 'T-1',
            concurrencyAtAdmission: 1,
            threw: false,
            lifecycle: lifecycleResult('BLOCKED_AUTH'),
          },
        ],
      } as never),
    ];

    for (const run of runs) {
      expect(
        exitCodeForScheduler({
          cycles: [
            {
              sequence: 1,
              run,
              scan: { earliest: null, future: [], matured: [], statesRead: 0, notes: [] },
              disposition: 'NOT_REQUESTED',
              wake: null,
              waitedMs: null,
            },
          ],
          ending: 'NOT_REQUESTED',
          registryRefusal: null,
        } as never),
      ).toBe(exitCodeForCrossRepositoryRun(run));
    }
  });

  it('an unproven release needs an operator, not another invocation', async () => {
    const { exitCodeForScheduler } = await import('../src/cli/run-exit-codes.js');
    expect(
      exitCodeForScheduler({
        cycles: [
          {
            sequence: 1,
            run: runResult({ outcome: 'RUN_COMPLETE', planCode: 'TASK_SELECTED' }),
            scan: { earliest: null, future: [], matured: [], statesRead: 0, notes: [] },
            disposition: 'LEASE_RELEASE_UNPROVEN',
            wake: null,
            waitedMs: null,
          },
        ],
        ending: 'LEASE_RELEASE_UNPROVEN',
        registryRefusal: null,
      } as never),
    ).toBe(3);
  });

  it('a durable wait that outlived a bound says "call again"', async () => {
    const { exitCodeForScheduler } = await import('../src/cli/run-exit-codes.js');
    for (const ending of ['BOUND_EXCEEDED', 'CYCLE_BUDGET_SPENT', 'SHUTDOWN_REQUESTED'] as const) {
      expect(
        exitCodeForScheduler({
          cycles: [
            {
              sequence: 1,
              run: runResult({ outcome: 'RUN_COMPLETE', planCode: 'TASK_SELECTED' }),
              scan: { earliest: null, future: [], matured: [], statesRead: 0, notes: [] },
              disposition: ending,
              wake: null,
              waitedMs: null,
            },
          ],
          ending,
          registryRefusal: null,
        } as never),
      ).toBe(5);
    }
  });
});
