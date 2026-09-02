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
 * and a settled admission has **attempted** its release — `driveLifecycle`
 * releases through `finish` on every controlled path and through its own `catch`
 * on the rest. So the layering makes the invariant structural:
 *
 *     cycle 1: driveRepositories → admissions → each acquires, drives, releases
 *     here   : scan durable state, holding nothing, and sleep holding nothing
 *     cycle 2: driveRepositories → acquires again, ordinarily
 *
 * The structural half is not the whole of it, and an earlier version of this
 * paragraph said "has released" and stopped there. A release can **fail** —
 * `LEASE_RELEASE_FAILED` is a modelled outcome precisely because it does — and
 * the lease file then stays on disk naming a live pid. Sleeping on that turns a
 * rare failure into a day-long lockout of that repository, with stale recovery
 * refused too, because a sleeping owner really is alive. So the sleep carries a
 * gate of its own: nothing sleeps until every admission has been **shown** to
 * have given its repository back. See `LEASE_RELEASE_UNPROVEN`.
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
 * A cycle sleeps only for a wake `scanDurableWakes` reported as **strictly
 * future**, so every sleep is positive and every wake moves the clock past at
 * least one recorded instant. An instant already behind when a pass began is
 * never offered at all, so a cycle cannot repeat the previous cycle's wait.
 *
 * The one cycle that does not sleep — a reset that matured *inside* the pass —
 * terminates for the same reason from the other side: the next pass begins after
 * that instant, so the instant leaves the matured band and cannot be offered
 * twice.
 *
 * A new future instant can appear, and that is a task that ran and met the quota
 * again: it cost a real agent invocation to produce, so it is progress rather
 * than a spin. Above all of that sits `--max-cycles`, the operator's own bound,
 * which has no default and is itself capped by `MAX_SCHEDULER_CYCLES` where the
 * loop reads it.
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
import { isUsableWaitBound, MAX_WAIT_MS_CEILING } from '../run/unattended-resume.js';
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
  /**
   * A pass could not be shown to have given every repository back, so nothing
   * slept.
   *
   * `unattended-resume.ts`'s own rule, lifted from one task to a whole pass: a
   * waiter that cannot prove it released may still be a repository's writer, and
   * a sleep would make that true for up to a day with a living pid in the lease
   * document — refusing every other invocation, and refusing stale recovery too.
   */
  'LEASE_RELEASE_UNPROVEN',
  /** Slept and ran another coordinator pass. Never an ending. */
  'WAITED',
  /**
   * A recorded reset matured *while the pass was running*, so another pass ran
   * at once without sleeping. Never an ending.
   *
   * Its own member rather than a silent `WAITED` with `waitedMs: 0`, because the
   * two are different facts about the same invocation: one waited for an instant
   * and one found an instant it had already passed through. An operator reading
   * a report full of `WAITED` rows that never slept would be reading a lie.
   */
  'MATURED_DURING_PASS',
  /** `--max-wait-ms` is not a bound this build will sleep on. Nothing ran. */
  'WAIT_BOUND_UNUSABLE',
  /** `--max-cycles` is not a bound this build will schedule on. Nothing ran. */
  'CYCLE_BOUND_UNUSABLE',
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
 * It is **not** distinguishable from a real scan by its own value, and an
 * earlier version of this comment claimed it was — "zero states read and an
 * empty note list, which no real scan of a repository with a runtime directory
 * can produce". A review produced one in a line: a repository whose runtime
 * directory exists and holds no state file yields exactly this shape, and a
 * crashed atomic write leaves a staging file that `isStateFileName` filters out,
 * reproducing it.
 *
 * Nothing needs the distinction. The question "did it look?" is answered by the
 * cycle's disposition, which says `NOT_REQUESTED`, and that is the only reader.
 */
const NOT_SCANNED: WakeScan = Object.freeze({
  earliest: null,
  future: Object.freeze([]),
  matured: Object.freeze([]),
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

function result(
  cycles: readonly SchedulerCycle[],
  registryRefusal: string | null,
  ending?: SchedulerDisposition,
): SchedulerResult {
  const last = cycles.at(-1);
  return Object.freeze({
    cycles: Object.freeze([...cycles]),
    // The explicit ending is for the two refusals that happen before any pass,
    // where there is no cycle to read one from. Otherwise the last cycle's
    // disposition is the ending; a run that got as far as a pass always has one,
    // so the final fallback is unreachable and is a report rather than a throw.
    ending: ending ?? last?.disposition ?? 'NOT_REQUESTED',
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

  // Refused before any effect: before a pass, before a lease, before a single
  // `git` child. Both bounds are re-checked here even though the CLI checks
  // them, and that is not belt and braces for its own sake — it is the rule this
  // module applies to the registry's capacity three screens down, applied to its
  // own arguments. "Another module's reasoning says this cannot happen" is not a
  // check, and the cost of being wrong is a loop bounded by nothing: `sequence
  // >= NaN` is false forever, and `maxChunks` computed from `NaN` never fires.
  if (request.wait.wait && !isUsableWaitBound(request.wait.maxWaitMs)) {
    return result([], 'MAX_WAIT_MS_INVALID', 'WAIT_BOUND_UNUSABLE');
  }
  if (request.wait.wait && !isUsableCycleBound(request.wait.maxCycles)) {
    return result([], 'MAX_CYCLES_INVALID', 'CYCLE_BOUND_UNUSABLE');
  }

  const cycles: SchedulerCycle[] = [];

  /**
   * The bound the loop actually stops on.
   *
   * `Math.min` rather than the operator's value alone, so that
   * `MAX_SCHEDULER_CYCLES` is enforced **where the loop is** — which is what
   * makes it the runaway floor its own comment calls it, and what a review
   * correctly pointed out it was not. The entry validation above already refuses
   * a larger value, so this changes nothing an operator can reach; it means the
   * floor holds for every producer of a `SchedulerWaitPolicy`, not only for the
   * one that happens to validate.
   */
  const cycleBudget = request.wait.wait
    ? Math.min(request.wait.maxCycles, MAX_SCHEDULER_CYCLES)
    : 0;

  let repositories = request.repositories;
  let capacity = request.maxConcurrentRepositories;

  for (let sequence = 1; ; sequence += 1) {
    // The moment this pass began, kept so the scan below can tell a reset that
    // matured *inside* the pass from one that was already behind when it
    // started. See `WakeWindow`.
    const passStartedAt = deps.now();

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
    const horizon = scan(repositories.map((entry) => entry.repository.root), {
      now: nowIso,
      since: passStartedAt,
    });

    const wake = horizon.earliest;
    const matured = horizon.matured[0] ?? null;

    // The shutdown **before** the wake question, and that order is a correction
    // rather than a preference. Asked afterwards, an interrupt that arrived
    // during the last pass of a run with nothing left to wait for was reported
    // as `NO_FUTURE_WAKE` and graded `EXIT_RUN_OK` — "I stopped it and it told
    // me everything was fine". An interrupted run did not finish on its own
    // terms, whatever else was true, and the report has to say so.
    if (shutdown.stopped()) {
      cycles.push(cycle({ sequence, run, scan: horizon, disposition: 'SHUTDOWN_REQUESTED', wake }));
      return result(cycles, null);
    }

    // The lease must be **provably** back before anything sleeps, and that is
    // `unattended-resume.ts`'s rule lifted from one task to a whole pass.
    //
    // A sleeper that cannot say it gave every repository back may still be one
    // of their writers, and it is about to be unreachable for up to a day — with
    // a *living* pid in the lease document, so every other invocation on the
    // machine is refused and stale recovery is refused too, because a sleeping
    // owner really is alive. Before this loop existed the process exited within
    // the pass and the pid died, making the lease recoverable in seconds; the
    // sleep is what turns a rare release failure into a day-long lockout, so the
    // sleep is what has to refuse.
    //
    // Fail-closed on absence as well as on failure: an admission that threw, or
    // that carries no lifecycle report, has not been *shown* to have given
    // anything back, and "no report" may not be read as "nothing to report".
    //
    // **Two readings of the release, and both must be clean.** The outcome is
    // the lifecycle's own summary; the release record is the instrument
    // `unattended-resume.ts` uses (`releaseProven`: `RELEASED` is the only proof
    // there is). They agree today only because `finish` maps every non-`RELEASED`
    // code onto `LEASE_RELEASE_FAILED` — one fact spelled twice — and a review
    // pointed out that citing that module while reading the other value is how
    // the two quietly stop meaning the same thing. So both are read. A `null`
    // record is not a failure: it is an admission that never took a lease, which
    // is exactly what a refused acquisition looks like.
    const unproven = run.admissions.find((admission) => {
      if (admission.threw || admission.lifecycle === null) return true;
      if (admission.lifecycle.outcome === 'LEASE_RELEASE_FAILED') return true;
      const release = admission.lifecycle.release;
      return release !== null && release.code !== 'RELEASED';
    });
    if (unproven !== undefined) {
      cycles.push(
        cycle({ sequence, run, scan: horizon, disposition: 'LEASE_RELEASE_UNPROVEN', wake }),
      );
      return result(cycles, null);
    }

    // ── A reset that matured inside the pass: plan again, at once ──────────
    //
    // Before the wake question, because a matured instant is work that is
    // resumable *now* and a future instant is work that is not. Sleeping past
    // the first to reach the second would be the scheduler choosing the later of
    // two answers it holds simultaneously.
    //
    // No sleep, and therefore no re-establishment: the registry is re-read after
    // a *sleep*, because a sleep is where the world gets time to change out from
    // under a resolved set. Nothing crossed here. The preflight is re-minted all
    // the same, because the factory is called once per cycle and being more
    // conservative about a login is never wrong.
    if (matured !== null) {
      if (sequence >= cycleBudget) {
        cycles.push(
          cycle({
            sequence,
            run,
            scan: horizon,
            disposition: 'CYCLE_BUDGET_SPENT',
            wake: wake ?? matured,
          }),
        );
        return result(cycles, null);
      }
      cycles.push(
        cycle({ sequence, run, scan: horizon, disposition: 'MATURED_DURING_PASS', wake: matured }),
      );
      continue;
    }

    if (wake === null) {
      cycles.push(cycle({ sequence, run, scan: horizon, disposition: 'NO_FUTURE_WAKE' }));
      return result(cycles, null);
    }

    if (sequence >= cycleBudget) {
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

    /**
     * A stop asked for after the wait, and before this cycle commits to another
     * pass. Checked twice, and neither is redundant.
     *
     * The first covers the window between the sleep returning and the registry
     * being re-read, which is not a moment: `resolveRegistry` walks the enlisted
     * repositories one at a time and starts real `git` children for each, so on
     * a large registry it is seconds. The second covers the window after it.
     *
     * Without them a review found the whole design's promise false. The
     * scheduler's own contract says an interrupt "sets `stopped`, so the loop
     * ends rather than planning again", and the only other place it was asked
     * was at the *top of the next cycle's* refusals — after the next pass had
     * already been driven. An interrupt landing in either window bought a full
     * coordinator pass across every enlisted repository, agents included, at a
     * moment when nothing was in flight and the scheduler was holding nothing:
     * exactly the state the design says an interrupt ends.
     */
    const stopAfterWait = (): SchedulerResult =>
      result(
        [
          ...cycles,
          cycle({
            sequence,
            run,
            scan: horizon,
            disposition: 'SHUTDOWN_REQUESTED',
            wake,
            waitedMs: slept.elapsedMs,
          }),
        ],
        null,
      );

    if (shutdown.stopped()) return stopAfterWait();

    const registry = await deps.resolveRegistry();

    if (shutdown.stopped()) return stopAfterWait();

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
