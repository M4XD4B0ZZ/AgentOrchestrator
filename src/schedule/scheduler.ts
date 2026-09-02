/**
 * The persistent scheduler: drive, read the durable wake horizon, sleep, repeat
 * (M3-01).
 *
 * ── What this module is, in one sentence ───────────────────────────────────
 *
 * A loop **above** `driveRepositories` that, between coordinator passes, reads
 * the enlisted repositories' durable task states, finds the earliest instant at
 * which a recorded quota pause ends, sleeps until it holding nothing, and plans
 * again — so that a machine-understandable wait recorded on disk is honoured by
 * whichever process happens to be running when it matures.
 *
 * ── The product sentence this exists to make true ──────────────────────────
 *
 * "If AgentOrchestrator stops while a task is waiting for a machine-
 * understandable future condition, a later AgentOrchestrator process can
 * reconstruct that wait from durable state and resume the task when the
 * condition is satisfied, without requiring a human to manually rediscover or
 * re-enter the wait."
 *
 * Every clause of that is a property of this loop's *inputs*, not of its memory.
 * The wake horizon is recomputed from disk at the top of every wait, so a
 * process that dies mid-sleep loses nothing a successor cannot read back, and
 * the successor needs no argument naming a task or an instant — it is handed
 * the same registry and finds the same wait.
 *
 * ── Why it is above `driveRepositories`, and not inside it ─────────────────
 *
 * The hard invariant is the one V3-08 established for the single-task wait and
 * this slice inherits unchanged: **no execution lease may be held across a
 * sleep.** A reset can be hours away; the lease is a repository's single writer
 * slot; a process asleep while holding one refuses every other invocation and
 * refuses stale recovery too, because a sleeping owner really is alive.
 *
 * `driveRepositories` returns only after every admission it made has settled,
 * and a settled admission has released — `driveLifecycle` releases through
 * `finish` on every controlled path and through its own `catch` on the rest. So
 * the layering makes the invariant structural rather than asserted:
 *
 *     cycle 1: driveRepositories → admissions → each acquires, drives, releases
 *     here   : scan durable state, holding nothing, and sleep holding nothing
 *     cycle 2: driveRepositories → acquires again, ordinarily
 *
 * This module never takes a lease, never writes task state, and never reaches
 * inside a lifecycle.
 *
 * ── Nothing before a sleep is authority after it ───────────────────────────
 *
 * Three things are re-established at every cycle boundary, and each is a rule
 * rather than an optimisation:
 *
 *  1. **the registry**, because a repository can be unenlisted, moved or broken
 *     during a five-hour wait, and a set resolved before the sleep would have
 *     the scheduler driving a repository its operator has withdrawn;
 *  2. **the auth preflight**, through a factory that is called once per cycle so
 *     the memo is fresh — a login proven before a six-hour sleep may not
 *     authorise the work after it, which is exactly the hole `unattended-resume`
 *     closed for its own two epochs;
 *  3. **the wake horizon**, which is read after the pass rather than before, so
 *     it describes the world the pass left behind.
 *
 * The one thing carried across a sleep is the operator's bounds, and they are
 * spent rather than renewed.
 *
 * ── Why the loop terminates ────────────────────────────────────────────────
 *
 * A cycle sleeps only for a wake that `scanDurableWakes` reported as **strictly
 * future**, so every sleep is positive and every wake moves the clock past at
 * least one recorded instant. An instant that has passed is never reported
 * again, so a cycle cannot repeat the previous cycle's wait. A new future
 * instant can appear — that is a task that ran and met the quota again — and it
 * cost a real agent invocation to produce, so it is progress rather than a spin.
 * Above all of that sits `--max-cycles`, which is the operator's own bound and
 * has no default.
 *
 * ── What this module deliberately is not ───────────────────────────────────
 *
 * Not a daemon, not a service, not a cron, not a job queue and not a timer
 * wheel. It has no notion of a recurring job, no user-authored schedule, no
 * event subscription and no persistence of its own. The only condition it can
 * wait for is the one the durable contract already expresses — a reported quota
 * reset — and the only thing it does when the wait matures is plan again.
 */

import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import type { RegisteredRepository } from '../registry/repository-registry.js';
import { MAX_CONCURRENT_REPOSITORIES } from '../registry/repository-registry.js';
import {
  driveRepositories as driveRepositoriesProduction,
  type CrossRepositoryRunResult,
} from '../run/repository-coordinator.js';
import { MAX_WAIT_MS_CEILING } from '../run/unattended-resume.js';
import type { AgentRunner } from '../agent/agent-command.js';
import type { GitRunner } from '../worktree/git-command.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import {
  realCancellableSleep,
  sleepUntilInstant,
  type BoundedSleepResult,
} from './bounded-sleep.js';
import { scanDurableWakes, type DurableWake, type WakeScan } from './durable-wake.js';

/**
 * The most cycles one invocation may run, whatever the operator asked for.
 *
 * A runaway floor of the same kind as `MAX_COORDINATOR_ADMISSIONS`, and for the
 * same reason: a bound an operator typed is still a number, and a scheduler is
 * the one place in this build where a mistyped number could keep a machine busy
 * for a week. It is far above any real use — a day of quota windows is a handful
 * of cycles — so it constrains nothing anybody meant.
 */
export const MAX_SCHEDULER_CYCLES = 4096;

/**
 * `true` for a cycle bound this build will schedule on. Total, and fail-closed.
 *
 * At least **two**, and that is not a stylistic minimum. The first cycle is the
 * coordinator pass that meets the block; a bound of one leaves no cycle to spend
 * after a wait, so `--max-cycles 1 --wait-for-reset` would describe a wait that
 * could never be followed by anything. Refused, rather than accepted and then
 * silently equivalent to not waiting at all — the same rule
 * `unattended-resume.ts` applies to `--max-invocations`.
 */
export function isUsableCycleBound(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 2 && value <= MAX_SCHEDULER_CYCLES;
}

/**
 * Whether this invocation may wait between coordinator passes, and under what
 * bounds.
 *
 * A discriminated union rather than three optional fields, so that "wait with no
 * bound" and "wait with no cycle budget" are not values anybody can construct.
 * There is no default duration and no default cycle count anywhere in this
 * module: a multi-hour sleep invented by a default is a multi-hour sleep nobody
 * asked for.
 */
export type SchedulerWaitPolicy =
  | { readonly wait: false }
  | { readonly wait: true; readonly maxWaitMs: number; readonly maxCycles: number };

/**
 * What the scheduler did at the end of a cycle, and — when it did not sleep —
 * why.
 *
 * A closed and deliberately wide vocabulary, for the reason `RUN_OUTCOMES` is
 * wide: "you never asked to wait", "there is nothing recorded to wait for",
 * "the wait is longer than you allowed" and "your cycle budget is spent" are
 * four different things to be told, and an operator reading one of them has to
 * know which.
 *
 * **None of these is persisted.** The durable truth while a scheduler sleeps is
 * exactly what it was before — each waiting task at `BLOCKED_USAGE_LIMIT` with
 * its own `reportedResetAt` — and a process that dies mid-sleep leaves correctly
 * parked tasks behind.
 */
export const SCHEDULER_DISPOSITIONS = [
  /** `--wait-for-reset` was not given. Waiting is opt-in and never implied. */
  'NOT_REQUESTED',
  /**
   * No enlisted repository's durable state names an instant still ahead.
   *
   * The ordinary ending, and it covers three shapes an operator should not have
   * to distinguish here: nothing is blocked at all, every block records no reset
   * time, and every recorded reset has already passed. The scan's own notes say
   * which, when it matters.
   */
  'NO_FUTURE_WAKE',
  /** The earliest wake is further away than `--max-wait-ms` permitted. */
  'BOUND_EXCEEDED',
  /** `--max-cycles` was spent with a wake still ahead. */
  'CYCLE_BUDGET_SPENT',
  /** A shutdown was requested. Nothing further was planned or waited for. */
  'SHUTDOWN_REQUESTED',
  /** The clock produced something that is not a timestamp. */
  'CURRENT_TIME_UNPARSEABLE',
  /**
   * The wall clock moved backwards far enough that the wait outlived the chunk
   * budget. Nothing was held and nothing was written; invoking again re-reads
   * the same durable state.
   */
  'SLEEP_BUDGET_SPENT',
  /** Slept, woke, and could not read the registry again. Nothing further ran. */
  'REGISTRY_UNUSABLE_AFTER_WAIT',
  /** Slept and ran another coordinator pass. Never an ending. */
  'WAITED',
] as const;

export type SchedulerDisposition = (typeof SCHEDULER_DISPOSITIONS)[number];

/** One coordinator pass and whatever the scheduler decided after it. */
export interface SchedulerCycle {
  /** 1-based. The first cycle is the ordinary `repositories --attended` pass. */
  readonly sequence: number;
  readonly run: CrossRepositoryRunResult;
  /** The durable wake horizon read **after** the pass, from disk. */
  readonly scan: WakeScan;
  readonly disposition: SchedulerDisposition;
  /** The wake this cycle waited for, or would have. `null` when there was none. */
  readonly wake: DurableWake | null;
  /** What the clock says the sleep took, or `null` when nothing slept. */
  readonly waitedMs: number | null;
}

export interface SchedulerResult {
  /** Every cycle, in order. At least one — the first pass always runs. */
  readonly cycles: readonly SchedulerCycle[];
  /** The last cycle's disposition. Never `WAITED`. */
  readonly ending: SchedulerDisposition;
  /**
   * The registry refusal that stopped a later cycle, or `null`.
   *
   * Only ever set alongside `REGISTRY_UNUSABLE_AFTER_WAIT`: the **first** read
   * is the caller's, because the command reports the registry itself, and a
   * scheduler that could not start has nothing to say that the command has not
   * already said better.
   */
  readonly registryRefusal: string | null;
}

export interface SchedulerRequest {
  /**
   * The registry as the caller already read it, for the first cycle only.
   *
   * Taken rather than re-read so that one invocation does not resolve every
   * enlisted repository twice — resolution starts real `git` children per
   * repository — while every later cycle goes through
   * {@link SchedulerDependencies.resolveRegistry} and gets a fresh answer.
   */
  readonly repositories: readonly RegisteredRepository[];
  readonly maxConcurrentRepositories: number;
  /** The step budget handed to each admitted task, every cycle. */
  readonly maxSteps: number;
  /** The invocation budget handed to each admitted task, every cycle. */
  readonly maxInvocations: number;
  readonly wait: SchedulerWaitPolicy;
}

/** What a post-wait registry read answered. */
export type SchedulerRegistryRead =
  | {
      readonly ok: true;
      readonly repositories: readonly RegisteredRepository[];
      readonly maxConcurrentRepositories: number;
    }
  | { readonly ok: false; readonly code: string };

/** A shutdown request, as this module can observe one. */
export interface ShutdownSeam {
  /** `true` once a shutdown has been asked for. */
  readonly stopped: () => boolean;
  /** Settles when a shutdown is asked for. Never rejects. */
  readonly cancel: Promise<void>;
}

/**
 * The horizon of a cycle that never looked.
 *
 * Distinguishable from a scan that looked and found nothing: this one reports
 * zero states read *and* an empty note list, which no real scan of a repository
 * with a runtime directory can produce. A reader that wants "did it look?"
 * should read the cycle's disposition, which says `NOT_REQUESTED`.
 */
const NOT_SCANNED: WakeScan = Object.freeze({
  earliest: null,
  future: Object.freeze([]),
  statesRead: 0,
  notes: Object.freeze([]),
});

/** A shutdown that is never requested. The default, and the only one a library caller gets. */
const NEVER_STOPS: ShutdownSeam = Object.freeze({
  stopped: (): boolean => false,
  // Never settles, so the production sleep runs its timer to completion. One
  // registered continuation per chunk, discarded with the promise.
  cancel: new Promise<void>(() => {
    /* deliberately never settles */
  }),
});

export interface SchedulerDependencies {
  /** The clock. Read afresh at every decision, never frozen for the run. */
  readonly now: () => string;
  /** Git. Required and never defaulted, so a test never reaches a real repository. */
  readonly git: GitRunner;
  /**
   * A **factory** for the auth preflight, called once per cycle.
   *
   * Not the preflight itself. `onceOnlyPreflight` memoises, which is right
   * within one cycle — the subscription CLIs are expensive and several
   * repositories in one pass must not start them several times — and wrong
   * across a sleep, because the artefact carries no freshness and would let a
   * login proven before a six-hour wait authorise every repository driven after
   * it. Resetting the memo at the cycle boundary is the whole mechanism.
   */
  readonly authPreflight: () => () => Promise<AuthPreflightEvidence | null>;
  /**
   * Reads and resolves the registry again, after a wait.
   *
   * A seam rather than a direct call so that this module performs no path
   * handling and holds no opinion about where a registry lives: the command
   * already owns that question, and a second answer here would be a second
   * place for it to be wrong.
   */
  readonly resolveRegistry: () => Promise<SchedulerRegistryRead>;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
  readonly driveRepositories?: typeof driveRepositoriesProduction;
  readonly scanDurableWakes?: typeof scanDurableWakes;
  readonly sleep?: (ms: number, cancel: Promise<void>) => Promise<void>;
  readonly shutdown?: ShutdownSeam;
}

function cycle(
  from: Omit<SchedulerCycle, 'wake' | 'waitedMs'> & Partial<Pick<SchedulerCycle, 'wake' | 'waitedMs'>>,
): SchedulerCycle {
  return Object.freeze({ wake: null, waitedMs: null, ...from });
}

function result(cycles: readonly SchedulerCycle[], registryRefusal: string | null): SchedulerResult {
  const last = cycles.at(-1);
  return Object.freeze({
    cycles: Object.freeze([...cycles]),
    // A run always has at least one cycle, so the fallback is unreachable. It is
    // `NOT_REQUESTED` rather than a throw because an ending is a report, and a
    // report that cannot be produced must not become an exception.
    ending: last?.disposition ?? 'NOT_REQUESTED',
    registryRefusal,
  });
}

/**
 * How the disposition of a sleep that ended early maps onto a cycle's ending.
 *
 * Total over the bounded-sleep vocabulary. `DEADLINE_REACHED` is absent from the
 * key type rather than merely omitted: it is the one outcome that **continues**,
 * to another cycle, and giving it an ending here would invite a caller to treat
 * arriving as stopping.
 */
const ENDING_FOR_INTERRUPTED_SLEEP = {
  STOP_REQUESTED: 'SHUTDOWN_REQUESTED',
  CHUNK_BUDGET_SPENT: 'SLEEP_BUDGET_SPENT',
  CURRENT_TIME_UNPARSEABLE: 'CURRENT_TIME_UNPARSEABLE',
} as const satisfies Record<
  Exclude<BoundedSleepResult['outcome'], 'DEADLINE_REACHED'>,
  SchedulerDisposition
>;

/**
 * Runs coordinator passes, waiting between them for durable quota resets.
 *
 * Never throws for an expected condition; every refusal arrives as data. The
 * grant handed to each admission is `driveRepositories`' own and is not widened
 * here: this module adds waiting to the cross-repository run and adds no
 * authority to it.
 */
export async function driveScheduler(
  request: SchedulerRequest,
  deps: SchedulerDependencies,
): Promise<SchedulerResult> {
  const drive = deps.driveRepositories ?? driveRepositoriesProduction;
  const scan = deps.scanDurableWakes ?? scanDurableWakes;
  const sleep = deps.sleep ?? realCancellableSleep;
  const shutdown = deps.shutdown ?? NEVER_STOPS;

  const cycles: SchedulerCycle[] = [];

  let repositories = request.repositories;
  let capacity = request.maxConcurrentRepositories;

  for (let sequence = 1; ; sequence += 1) {
    const run = await drive(
      {
        repositories,
        maxConcurrentRepositories: capacity,
        maxSteps: request.maxSteps,
        maxInvocations: request.maxInvocations,
      },
      {
        now: deps.now,
        git: deps.git,
        // A **new** once-only preflight for this cycle. The previous cycle's is
        // not reused, and this is the line that makes "post-wake auth is fresh"
        // true rather than intended.
        authPreflight: deps.authPreflight(),
        ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
        ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
      },
    );

    // ── The refusals, in fail-closed order ────────────────────────────────
    //
    // The operator's opt-in first, then whether anything is recorded to wait
    // for, then the shutdown, then the budgets, then the clock, then the bound.
    // Every arm before the sleep is a refusal, so a condition that is not
    // positively established cannot produce a wait.

    // Before the scan, and that ordering is a promise rather than a saving. An
    // invocation that did not ask to wait must behave exactly as
    // `repositories --attended` always has, down to what it opens: the scan
    // enumerates a runtime directory per repository and reads every task state
    // in it, and doing that for a caller who cannot act on the answer would be
    // this slice quietly changing a command it is supposed to leave alone.
    if (!request.wait.wait) {
      cycles.push(cycle({ sequence, run, scan: NOT_SCANNED, disposition: 'NOT_REQUESTED' }));
      return result(cycles, null);
    }

    // Read after the pass, so the horizon describes the world the pass left
    // behind: a task that just met the quota contributes its new reset here, and
    // a task the pass resumed contributes nothing.
    const nowIso = deps.now();
    const horizon = scan(
      repositories.map((entry) => entry.repository.root),
      nowIso,
    );

    const wake = horizon.earliest;
    if (wake === null) {
      cycles.push(cycle({ sequence, run, scan: horizon, disposition: 'NO_FUTURE_WAKE' }));
      return result(cycles, null);
    }

    if (shutdown.stopped()) {
      cycles.push(cycle({ sequence, run, scan: horizon, disposition: 'SHUTDOWN_REQUESTED', wake }));
      return result(cycles, null);
    }

    if (sequence >= request.wait.maxCycles) {
      cycles.push(cycle({ sequence, run, scan: horizon, disposition: 'CYCLE_BUDGET_SPENT', wake }));
      return result(cycles, null);
    }

    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) {
      // Unreachable while the scan reported a wake — it refuses an unparseable
      // clock before reading anything — and kept because "another module's
      // reasoning says this cannot happen" is not the same as a check, and the
      // cost of being wrong here is a sleep computed from `NaN`.
      cycles.push(
        cycle({ sequence, run, scan: horizon, disposition: 'CURRENT_TIME_UNPARSEABLE', wake }),
      );
      return result(cycles, null);
    }

    // The `+ 1` is not an assumption about the policy; it is a consequence of
    // it. `evaluateAutomaticResume` refuses while `now <= reportedResetAt`, so
    // waking *at* the reported instant is refused, and a schedule aimed exactly
    // there would reliably produce a second `RESET_TIME_NOT_REACHED` — and,
    // because that instant would then no longer be strictly future, no third
    // attempt. One millisecond later is the earliest moment the existing policy
    // can possibly allow, and it is still only *possibly*: the policy is re-run
    // after the wake and is the authority, whatever this arithmetic aimed at.
    const deadlineMs = wake.resetAtMs + 1;
    const requiredWaitMs = deadlineMs - nowMs;
    if (requiredWaitMs > request.wait.maxWaitMs) {
      cycles.push(cycle({ sequence, run, scan: horizon, disposition: 'BOUND_EXCEEDED', wake }));
      return result(cycles, null);
    }

    const slept = await sleepUntilInstant(deadlineMs, request.wait.maxWaitMs, {
      now: deps.now,
      sleep,
      shouldStop: shutdown.stopped,
      cancel: shutdown.cancel,
    });

    if (slept.outcome !== 'DEADLINE_REACHED') {
      cycles.push(
        cycle({
          sequence,
          run,
          scan: horizon,
          disposition: ENDING_FOR_INTERRUPTED_SLEEP[slept.outcome],
          wake,
          waitedMs: slept.elapsedMs,
        }),
      );
      return result(cycles, null);
    }

    // ── Everything from here is established again ─────────────────────────
    const registry = await deps.resolveRegistry();
    if (!registry.ok) {
      cycles.push(
        cycle({
          sequence,
          run,
          scan: horizon,
          disposition: 'REGISTRY_UNUSABLE_AFTER_WAIT',
          wake,
          waitedMs: slept.elapsedMs,
        }),
      );
      return result(cycles, registry.code);
    }

    // Bounded here as well as at the registry's own boundary. The value has
    // crossed a sleep and a second read of a file an operator may have edited
    // while this process was asleep, and `driveRepositories` refuses an
    // out-of-range capacity with `CAPACITY_INVALID` — which would end the next
    // cycle having admitted nothing, silently, for a reason this loop could have
    // named. Clamping would be worse than either: a capacity nobody wrote.
    if (
      !Number.isSafeInteger(registry.maxConcurrentRepositories) ||
      registry.maxConcurrentRepositories < 1 ||
      registry.maxConcurrentRepositories > MAX_CONCURRENT_REPOSITORIES
    ) {
      cycles.push(
        cycle({
          sequence,
          run,
          scan: horizon,
          disposition: 'REGISTRY_UNUSABLE_AFTER_WAIT',
          wake,
          waitedMs: slept.elapsedMs,
        }),
      );
      return result(cycles, 'MAX_CONCURRENT_REPOSITORIES_INVALID');
    }

    repositories = registry.repositories;
    capacity = registry.maxConcurrentRepositories;

    cycles.push(
      cycle({
        sequence,
        run,
        scan: horizon,
        disposition: 'WAITED',
        wake,
        waitedMs: slept.elapsedMs,
      }),
    );
  }
}

/** Re-exported so a caller bounding `--max-wait-ms` reads one constant, not two. */
export { MAX_WAIT_MS_CEILING };
