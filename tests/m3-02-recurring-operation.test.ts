/**
 * M3 slice 2 — recurring operation, in process.
 *
 * ── What "recurring" is, and what it is not ────────────────────────────────
 *
 * One number: `--idle-poll-ms`. When a pass leaves nothing recorded to wait for,
 * the loop sleeps that long and plans again instead of ending. Everything else
 * about the loop is M3 slice 1's and is unchanged — the same pass, the same
 * lease-release gate, the same re-establishment after a sleep, the same
 * `--max-cycles` bound.
 *
 * The load-bearing negative is the first case in this file: **without** the
 * interval, the ending is `NO_FUTURE_WAKE` before the cycle budget is even
 * consulted, exactly as before. Every other case is worth nothing if that one
 * does not hold, because then "it kept going" would be the new default rather
 * than something an operator asked for.
 *
 * The clock and the sleep are injected. A test that really polled for an hour is
 * not a test; that a *different process* keeps running is
 * `tests/dist-artifact/recurring-operation-dist-artifact.mjs`.
 */

import { rmSync } from 'node:fs';

import { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';

import { registerRepositoriesCommand } from '../src/cli/repositories-command.js';
import { SCHEDULER_DISPOSITION_SENTENCES } from '../src/cli/render-schedule.js';
import { exitCodeForScheduler } from '../src/cli/run-exit-codes.js';
import type { AuthPreflightEvidence } from '../src/core/auth-preflight-evidence.js';
import type { RegisteredRepository } from '../src/registry/repository-registry.js';
import type { CrossRepositoryRunResult } from '../src/run/repository-coordinator.js';
import type { WakeScan } from '../src/schedule/durable-wake.js';
import {
  driveScheduler,
  isUsableIdlePollBound,
  MAX_SCHEDULER_CYCLES,
  MIN_IDLE_POLL_MS,
  SCHEDULER_DISPOSITIONS,
  type PassObservation,
  type SchedulerDependencies,
  type SchedulerRegistryRead,
  type SchedulerRequest,
} from '../src/schedule/scheduler.js';
import { MAX_WAIT_MS_CEILING } from '../src/run/unattended-resume.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';

const created: string[] = [];

afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked file on Windows must not fail an otherwise passing suite.
    }
  }
});

const NOW_MS = Date.parse('2026-09-02T12:00:00.000Z');

/** A coordinator result with only the fields this file reads. */
function runResult(): CrossRepositoryRunResult {
  return Object.freeze({
    outcome: 'NOTHING_ADMITTED',
    planCode: 'ALL_TASKS_COMPLETE',
    admissions: Object.freeze([]),
    passes: 1,
    maxObservedConcurrency: 0,
    capacity: 1,
    reasonCodes: Object.freeze([]),
  }) as unknown as CrossRepositoryRunResult;
}

/** A wake horizon with nothing in it. The idle path's precondition. */
const EMPTY_SCAN: WakeScan = Object.freeze({
  earliest: null,
  future: Object.freeze([]),
  matured: Object.freeze([]),
  statesRead: 0,
  notes: Object.freeze([]),
});

/** A registered repository with only the fields the loop and observer read. */
function repository(id: string): RegisteredRepository {
  const root = makeCanonicalTempDir(`ao-m3s2-${id}-`);
  created.push(root);
  return Object.freeze({
    declaredPath: root,
    repository: Object.freeze({ id, root }),
  }) as unknown as RegisteredRepository;
}

interface Harness {
  readonly deps: SchedulerDependencies;
  readonly sleeps: number[];
  readonly cycles: number[];
  readonly observed: PassObservation[];
  /** Every pass, observation and sleep, in the order they happened. */
  readonly events: string[];
  readonly registryReads: () => number;
}

/**
 * A scheduler harness whose wake scan is controllable and whose clock advances
 * by whatever the sleep was asked for.
 *
 * The clock advancing is what makes a multi-cycle case behave like real time
 * without taking it: the loop's own termination argument is exercised rather
 * than assumed.
 */
function harness(options: {
  readonly scan?: (sequence: number) => WakeScan;
  readonly stopAfterSleeps?: number;
  readonly observe?: (observation: PassObservation) => Promise<void>;
  readonly registry?: () => Promise<SchedulerRegistryRead>;
} = {}): Harness {
  let clock = NOW_MS;
  const sleeps: number[] = [];
  const cycles: number[] = [];
  const observed: PassObservation[] = [];
  const events: string[] = [];
  let registryReads = 0;
  let stopped = false;
  let settleCancel: () => void = () => {};
  const cancel = new Promise<void>((resolve) => {
    settleCancel = resolve;
  });

  const deps: SchedulerDependencies = {
    now: () => new Date(clock).toISOString(),
    git: runGitCommand,
    authPreflight: () => async (): Promise<AuthPreflightEvidence | null> => provenAuthEvidence(),
    resolveRegistry:
      options.registry ??
      (async (): Promise<SchedulerRegistryRead> => {
        registryReads += 1;
        return { ok: true, repositories: [repository('after-wait')], maxConcurrentRepositories: 1 };
      }),
    driveRepositories: async () => {
      cycles.push(cycles.length + 1);
      events.push(`pass:${String(cycles.length)}`);
      return runResult();
    },
    scanDurableWakes: () => (options.scan ?? (() => EMPTY_SCAN))(cycles.length),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      events.push(`sleep:${String(ms)}`);
      clock += ms;
      if (options.stopAfterSleeps !== undefined && sleeps.length >= options.stopAfterSleeps) {
        stopped = true;
        settleCancel();
      }
    },
    shutdown: { stopped: () => stopped, cancel },
    ...(options.observe === undefined
      ? {
          observePass: async (observation: PassObservation): Promise<void> => {
            observed.push(observation);
            events.push(`observe:${String(observation.sequence)}`);
          },
        }
      : { observePass: options.observe }),
  };

  return {
    deps,
    sleeps,
    cycles,
    observed,
    events,
    registryReads: () => registryReads,
  };
}

function request(overrides: Partial<SchedulerRequest> = {}): SchedulerRequest {
  return Object.freeze({
    repositories: [repository('a')],
    maxConcurrentRepositories: 1,
    maxSteps: 1,
    maxInvocations: 1,
    wait: { wait: true, maxWaitMs: 60_000, maxCycles: 4, idlePollMs: null },
    ...overrides,
  });
}

/* ═════════════════ 1. the ending an operator did not ask to change ═════════ */

describe('M3 slice 2 — without an idle interval, nothing changed', () => {
  it('ends on NO_FUTURE_WAKE after one pass, before the cycle budget is consulted', async () => {
    const test = harness();
    const result = await driveScheduler(request(), test.deps);

    // The control for this whole file. `--max-cycles 4` is unspent and the loop
    // stopped anyway, which is what "the ending is reported before the budget is
    // consulted" means and is exactly the pre-slice behaviour.
    expect(result.ending).toBe('NO_FUTURE_WAKE');
    expect(result.cycles).toHaveLength(1);
    expect(test.sleeps).toHaveLength(0);
    expect(test.cycles).toEqual([1]);
  });
});

/* ══════════════════════ 2. the idle interval ═══════════════════════════════ */

describe('M3 slice 2 — with an idle interval, the loop keeps going', () => {
  it('sleeps the interval and plans again, until the cycle budget is spent', async () => {
    const test = harness();
    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 3, idlePollMs: 5_000 } }),
      test.deps,
    );

    expect(result.ending).toBe('CYCLE_BUDGET_SPENT');
    expect(result.cycles.map((cycle) => cycle.disposition)).toEqual([
      'IDLE_POLLED',
      'IDLE_POLLED',
      'CYCLE_BUDGET_SPENT',
    ]);
    // Three passes really ran, so this is "it kept going" and not "it reported
    // that it would have".
    expect(test.cycles).toEqual([1, 2, 3]);
    expect(test.sleeps).toEqual([5_000, 5_000]);
  });

  it('sleeps the interval, not the wait bound', async () => {
    // The two numbers mean different things and reusing one for the other would
    // let a short `--max-wait-ms` silently truncate an interval an operator
    // typed. `maxWaitMs` here is smaller than the interval on purpose.
    const test = harness();
    await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 1_000, maxCycles: 2, idlePollMs: 30_000 } }),
      test.deps,
    );
    expect(test.sleeps).toEqual([30_000]);
  });

  it('re-reads the registry after every idle sleep', async () => {
    // The rule M3 slice 1 established and this path inherits: nothing before a
    // sleep is authority after it. A repository withdrawn while the process was
    // idle must not be driven by the next pass.
    const test = harness();
    await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 3, idlePollMs: 5_000 } }),
      test.deps,
    );
    expect(test.registryReads()).toBe(2);
    // …and the pass after the sleep drove what the re-read returned.
    expect(test.observed.at(-1)?.repositories.map((entry) => entry.repository.id)).toEqual([
      'after-wait',
    ]);
  });

  it('ends on a shutdown asked for during an idle sleep', async () => {
    const test = harness({ stopAfterSleeps: 1 });
    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 8, idlePollMs: 5_000 } }),
      test.deps,
    );

    // An interrupt ends the loop rather than buying another pass across every
    // enlisted repository. The budget is nowhere near spent, so the shutdown is
    // the only thing that can explain the ending.
    expect(result.ending).toBe('SHUTDOWN_REQUESTED');
    expect(test.cycles).toEqual([1]);
  });

  it('waits for a recorded reset in preference to the interval', async () => {
    // A future wake is a *known* instant and the interval is a guess. The loop
    // holds both and must take the one the durable state named.
    const wake = Object.freeze({
      repositoryRoot: 'C:\\repo',
      taskId: 'T-1',
      resetAt: '2026-09-02T12:00:10.000Z',
      resetAtMs: NOW_MS + 10_000,
    });
    const test = harness({
      scan: (sequence) =>
        sequence === 1
          ? Object.freeze({ ...EMPTY_SCAN, earliest: wake, future: Object.freeze([wake]) })
          : EMPTY_SCAN,
    });

    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 4, idlePollMs: 5_000 } }),
      test.deps,
    );

    expect(result.cycles[0]?.disposition).toBe('WAITED');
    // `+ 1`: the resume policy refuses while `now <= reportedResetAt`.
    expect(test.sleeps[0]).toBe(10_001);
    expect(result.cycles[1]?.disposition).toBe('IDLE_POLLED');
  });

  it('plans again at once for a reset that matured inside the pass, without sleeping', async () => {
    const matured = Object.freeze({
      repositoryRoot: 'C:\\repo',
      taskId: 'T-1',
      resetAt: '2026-09-02T11:59:59.000Z',
      resetAtMs: NOW_MS - 1_000,
    });
    const test = harness({
      scan: (sequence) =>
        sequence === 1
          ? Object.freeze({ ...EMPTY_SCAN, matured: Object.freeze([matured]) })
          : EMPTY_SCAN,
    });

    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 4, idlePollMs: 5_000 } }),
      test.deps,
    );

    // Work that is resumable *now* beats both the interval and a future instant:
    // the first cycle plans again at once, having slept nothing. The idle
    // interval takes over afterwards, when nothing is left to look at again.
    expect(result.cycles[0]?.disposition).toBe('MATURED_DURING_PASS');
    expect(result.cycles[0]?.waitedMs).toBeNull();
    expect(result.cycles[1]?.disposition).toBe('IDLE_POLLED');
    expect(test.sleeps[0]).toBe(5_000);
  });

  it('falls back to the interval when a recorded wake is further away than the bound', async () => {
    // `--max-wait-ms 10min --idle-poll-ms 1min` says two things: do not block
    // more than ten minutes on a recorded wait, and look again every minute.
    // Ending on the first would be reading half of what the operator typed —
    // and it would stop driving every OTHER repository over one distant reset in
    // one of them, which is the case the interval exists for.
    const distant = Object.freeze({
      repositoryRoot: 'C:\\repo',
      taskId: 'T-1',
      resetAt: '2026-09-02T17:00:00.000Z',
      resetAtMs: NOW_MS + 5 * 3_600_000,
    });
    const test = harness({
      scan: () => Object.freeze({ ...EMPTY_SCAN, earliest: distant, future: Object.freeze([distant]) }),
    });

    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 600_000, maxCycles: 3, idlePollMs: 60_000 } }),
      test.deps,
    );

    expect(result.cycles.map((cycle) => cycle.disposition)).toEqual([
      'IDLE_POLLED',
      'IDLE_POLLED',
      'CYCLE_BUDGET_SPENT',
    ]);
    expect(test.sleeps).toEqual([60_000, 60_000]);
    // The wake is still reported, so the operator can see what was out of reach.
    expect(result.cycles[0]?.wake?.taskId).toBe('T-1');
  });

  it('still ends on the bound when no interval was given', async () => {
    // The control for the case above: the same fixture, differing only in the
    // interval, must end exactly as it did before this slice.
    const distant = Object.freeze({
      repositoryRoot: 'C:\\repo',
      taskId: 'T-1',
      resetAt: '2026-09-02T17:00:00.000Z',
      resetAtMs: NOW_MS + 5 * 3_600_000,
    });
    const test = harness({
      scan: () => Object.freeze({ ...EMPTY_SCAN, earliest: distant, future: Object.freeze([distant]) }),
    });
    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 600_000, maxCycles: 3, idlePollMs: null } }),
      test.deps,
    );
    expect(result.ending).toBe('BOUND_EXCEEDED');
    expect(test.sleeps).toHaveLength(0);
  });

  it('measures the idle interval from the moment it sleeps, not from before the scan', async () => {
    // `nowIso` is read BEFORE the durable-wake scan, which on a large registry
    // enumerates and parses hundreds of state files. A deadline anchored there
    // would make the effective interval the operator's number MINUS the scan —
    // zero for a scan that costs more than the interval, which is
    // `MIN_IDLE_POLL_MS`'s own floor being unenforceable by the code documenting
    // it. Here the scan advances the clock by more than the interval.
    const test = harness();
    let scanned = 0;
    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 2, idlePollMs: 5_000 } }),
      {
        ...test.deps,
        scanDurableWakes: () => {
          scanned += 1;
          test.deps.now();
          return EMPTY_SCAN;
        },
      },
    );
    expect(scanned).toBeGreaterThan(0);
    expect(result.cycles[0]?.disposition).toBe('IDLE_POLLED');
    // The full interval, not a truncated one.
    expect(test.sleeps).toEqual([5_000]);
  });

  it('does not sleep at all when the pass could not prove it released', async () => {
    // The M3 slice 1 gate, on the new path. A sleeper that cannot say it gave
    // every repository back may still be one of their writers, and an idle poll
    // is a sleep like any other.
    const test = harness();
    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 4, idlePollMs: 5_000 } }),
      {
        ...test.deps,
        driveRepositories: async () =>
          Object.freeze({
            ...runResult(),
            admissions: Object.freeze([Object.freeze({ threw: true, lifecycle: null })]),
          }) as unknown as CrossRepositoryRunResult,
      },
    );

    expect(result.ending).toBe('LEASE_RELEASE_UNPROVEN');
    expect(test.sleeps).toHaveLength(0);
  });
});

/* ══════════════════════ 3. the bound ═══════════════════════════════════════ */

describe('M3 slice 2 — the idle interval is bounded', () => {
  it('accepts exactly the intervals this build will sleep on', () => {
    expect(isUsableIdlePollBound(MIN_IDLE_POLL_MS)).toBe(true);
    expect(isUsableIdlePollBound(MAX_WAIT_MS_CEILING)).toBe(true);
    expect(isUsableIdlePollBound(MIN_IDLE_POLL_MS - 1)).toBe(false);
    expect(isUsableIdlePollBound(MAX_WAIT_MS_CEILING + 1)).toBe(false);
    expect(isUsableIdlePollBound(Number.NaN)).toBe(false);
    expect(isUsableIdlePollBound(1.5)).toBe(false);
    expect(isUsableIdlePollBound(0)).toBe(false);
    expect(isUsableIdlePollBound(-1)).toBe(false);
  });

  it('refuses an unusable interval before any pass runs', async () => {
    for (const idlePollMs of [0, -1, Number.NaN, MIN_IDLE_POLL_MS - 1, MAX_WAIT_MS_CEILING + 1]) {
      const test = harness();
      const result = await driveScheduler(
        request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 4, idlePollMs } }),
        test.deps,
      );
      expect(result.ending).toBe('IDLE_POLL_BOUND_UNUSABLE');
      expect(result.registryRefusal).toBe('IDLE_POLL_MS_INVALID');
      // Before a pass, before a lease, before a single `git` child.
      expect(test.cycles).toHaveLength(0);
    }
  });

  it('cannot exceed the runaway cycle floor however the interval is typed', async () => {
    // The interval is a floor under one sleep; what bounds an idle loop is
    // `--max-cycles`, capped where the loop reads it.
    const test = harness();
    const result = await driveScheduler(
      request({
        wait: {
          wait: true,
          maxWaitMs: 60_000,
          maxCycles: MAX_SCHEDULER_CYCLES + 1,
          idlePollMs: MIN_IDLE_POLL_MS,
        },
      }),
      test.deps,
    );
    expect(result.ending).toBe('CYCLE_BOUND_UNUSABLE');
    expect(test.cycles).toHaveLength(0);
  });
});

/* ══════════════════════ 4. the observer seam ═══════════════════════════════ */

describe('M3 slice 2 — the per-pass observer', () => {
  it('sees every pass, including the one that ends the invocation', async () => {
    const test = harness();
    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 3, idlePollMs: 5_000 } }),
      test.deps,
    );

    // Three passes, three observations, numbered as the cycles are. An observer
    // that only saw continuing passes would never settle the outbox for the one
    // an operator actually reads about.
    expect(test.observed).toHaveLength(3);
    expect(test.observed.map((o) => o.sequence)).toEqual([1, 2, 3]);
    expect(result.cycles).toHaveLength(3);
  });

  /**
   * The counter-proof for the relocation, and the reason this seam is a *pass*
   * observation rather than a cycle one.
   *
   * Called where it first was — at the bottom of the iteration, beside
   * `cycles.push` — the observer inherited the cycle's whole sleep, so a
   * condition needing a person was written down and announced up to
   * `--max-wait-ms` after it was found. Three independent reviewers produced
   * that path. Ordering is the only thing that can measure it: every observation
   * must come before the sleep that follows its own pass.
   */
  it('runs before the sleep, never after it', async () => {
    const test = harness();
    await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 3, idlePollMs: 5_000 } }),
      test.deps,
    );

    expect(test.events).toEqual([
      'pass:1',
      'observe:1',
      'sleep:5000',
      'pass:2',
      'observe:2',
      'sleep:5000',
      'pass:3',
      'observe:3',
    ]);
  });

  it('runs before a wait for a recorded reset too', async () => {
    const wake = Object.freeze({
      repositoryRoot: 'C:\\repo',
      taskId: 'T-1',
      resetAt: '2026-09-02T12:00:10.000Z',
      resetAtMs: NOW_MS + 10_000,
    });
    const test = harness({
      scan: (sequence) =>
        sequence === 1
          ? Object.freeze({ ...EMPTY_SCAN, earliest: wake, future: Object.freeze([wake]) })
          : EMPTY_SCAN,
    });
    await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 86_400_000, maxCycles: 2, idlePollMs: null } }),
      test.deps,
    );

    // The sharp case: a ten-second wake here stands in for a six-hour one, and
    // the observation must precede it either way.
    expect(test.events).toEqual(['pass:1', 'observe:1', 'sleep:10001', 'pass:2', 'observe:2']);
  });

  it('is handed the repositories the pass drove, not the ones it started with', async () => {
    const test = harness();
    await driveScheduler(
      request({
        repositories: [repository('first')],
        wait: { wait: true, maxWaitMs: 60_000, maxCycles: 2, idlePollMs: 5_000 },
      }),
      test.deps,
    );
    expect(test.observed[0]?.repositories.map((entry) => entry.repository.id)).toEqual(['first']);
    expect(test.observed[1]?.repositories.map((entry) => entry.repository.id)).toEqual([
      'after-wait',
    ]);
  });

  it('is not installed when the caller supplies none, and the loop is unchanged', async () => {
    const test = harness();
    const { observePass: _dropped, ...withoutObserver } = test.deps;
    const result = await driveScheduler(request(), withoutObserver);
    expect(result.ending).toBe('NO_FUTURE_WAKE');
    expect(test.observed).toHaveLength(0);
  });

  it('lets no observer failure change what the scheduler decided', async () => {
    // The outbox must never rewrite the run's own answer about the
    // repositories. A rejection is swallowed and the disposition stands.
    const test = harness({
      observe: async () => {
        throw new Error('an observer this module knows nothing about');
      },
    });
    const result = await driveScheduler(
      request({ wait: { wait: true, maxWaitMs: 60_000, maxCycles: 3, idlePollMs: 5_000 } }),
      test.deps,
    );
    expect(result.ending).toBe('CYCLE_BUDGET_SPENT');
    expect(test.cycles).toEqual([1, 2, 3]);
  });
});

/* ══════════════════════ 5. the vocabulary and the exit codes ═══════════════ */

describe('M3 slice 2 — the new dispositions are graded', () => {
  it('has a sentence for every disposition', () => {
    for (const disposition of SCHEDULER_DISPOSITIONS) {
      expect(SCHEDULER_DISPOSITION_SENTENCES[disposition]).toBeTypeOf('string');
      expect(SCHEDULER_DISPOSITION_SENTENCES[disposition].length).toBeGreaterThan(0);
    }
  });

  it('grades an idle poll reported as an ending as a defect', () => {
    // `IDLE_POLLED` is a cycle that continued; it can never be an ending. Graded
    // as a defect rather than given a benign code, exactly as `WAITED` is.
    const scheduled = Object.freeze({
      cycles: Object.freeze([]),
      ending: 'IDLE_POLLED' as const,
      registryRefusal: null,
    });
    expect(exitCodeForScheduler(scheduled)).toBe(1);
  });

  it('grades an unusable interval as an input refusal', () => {
    const scheduled = Object.freeze({
      cycles: Object.freeze([]),
      ending: 'IDLE_POLL_BOUND_UNUSABLE' as const,
      registryRefusal: 'IDLE_POLL_MS_INVALID',
    });
    expect(exitCodeForScheduler(scheduled)).toBe(2);
  });
});

/* ══════════════════════ 6. the command's argument boundary ═════════════════ */

describe('M3 slice 2 — --idle-poll-ms at the CLI', () => {
  /**
   * Drives the real Commander action with a registry seam that **throws**.
   *
   * So a refusal that got past the argument gate is a thrown error rather than a
   * quiet pass: reaching the registry disproves the ordering these cases are
   * about.
   */
  async function drive(argv: readonly string[]): Promise<{ text: string; code: number }> {
    // Captured off `process.stdout` rather than through the command's `write`
    // seam, because an argument refusal is written before any seam is consulted
    // — which is the ordering these cases are about.
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string): boolean => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const previous = process.exitCode;
    try {
      const program = new Command();
      program.exitOverride();
      registerRepositoriesCommand(program, {
        // If this is reached, the refusal did not happen first.
        loadRepositoryRegistry: () => {
          throw new Error('the registry must not be read');
        },
      });
      await program.parseAsync(['node', 'agent-loop', 'repositories', ...argv]);
      return { text: chunks.join(''), code: Number(process.exitCode ?? 0) };
    } finally {
      process.stdout.write = original;
      process.exitCode = previous;
    }
  }

  const REFUSALS: readonly (readonly [string, readonly string[], string])[] = [
    [
      'without --attended, because there is no run to bound',
      ['--idle-poll-ms', '5000'],
      'BOUND_WITHOUT_GRANT',
    ],
    [
      'without --wait-for-reset, because there are no passes to sit between',
      ['--attended', '--idle-poll-ms', '5000'],
      'WAIT_BOUND_WITHOUT_WAIT',
    ],
    [
      'below the floor, because a pass costs more than that',
      [
        '--attended',
        '--wait-for-reset',
        '--max-wait-ms',
        '1000',
        '--max-cycles',
        '2',
        '--idle-poll-ms',
        '10',
      ],
      'IDLE_POLL_MS_INVALID',
    ],
    [
      'above the ceiling',
      [
        '--attended',
        '--wait-for-reset',
        '--max-wait-ms',
        '1000',
        '--max-cycles',
        '2',
        '--idle-poll-ms',
        String(MAX_WAIT_MS_CEILING + 1),
      ],
      'IDLE_POLL_MS_INVALID',
    ],
    [
      'when it is not a number at all',
      [
        '--attended',
        '--wait-for-reset',
        '--max-wait-ms',
        '1000',
        '--max-cycles',
        '2',
        '--idle-poll-ms',
        'soon',
      ],
      'IDLE_POLL_MS_INVALID',
    ],
  ];

  for (const [name, argv, code] of REFUSALS) {
    it(`refuses --idle-poll-ms ${name}`, async () => {
      const { text, code: exitCode } = await drive(argv);
      expect(text).toContain(code);
      expect(exitCode).toBe(2);
      // The refusal came before the registry was read: the seam throws, and
      // nothing threw.
      expect(text).not.toContain('the registry must not be read');
    });
  }
});
