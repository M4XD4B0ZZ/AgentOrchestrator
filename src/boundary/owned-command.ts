/**
 * The owned-command adapter — V3 slice 2.
 *
 * `./start-owned-process.ts` starts a process the kernel owns and reports how
 * the boundary ended. It deliberately owns nothing else: no timeout, no byte
 * budget, no stdin vocabulary, no result classification. This module is the
 * other half the ADR keeps in TypeScript — the policy, and the translation of
 * a {@link BoundaryEnding} into a result an AO runner could consume.
 *
 * ── What this module is not ────────────────────────────────────────────────
 *
 * It is not wired into anything. `runCommand`, the Claude writer and the
 * verification runner are untouched by this slice, exactly as by slice 1, and
 * the reachability pin in `tests/v2-07l-execution-lease.test.ts` states that
 * as an assertion rather than as an intention. Slice 3 is what moves a runner
 * onto this path, and it is the slice that has to answer "what fences it".
 *
 * ── The one guarantee ──────────────────────────────────────────────────────
 *
 * Spike 2 measured a helper killed mid-run and got a run that looked exactly
 * like a clean completion: ownership had been reported, the pipes closed, and
 * no child exit code ever arrived. `BOUNDARY_LOST` exists for that state — and
 * an adapter is where it would be lost again, because an adapter is where an
 * unknown ending meets a local reason and the two get combined into one word.
 *
 * So {@link classifyOwnedCommand} is a total function over
 * (ending × termination reason) with exactly one path to `COMPLETED`: the
 * boundary observed the child exit, *and* no policy here terminated it. Every
 * other pairing — including ones unreachable by construction — lands on a
 * non-success. `tests/v3-02-owned-command.test.ts` enumerates the product
 * rather than sampling it.
 *
 * ── Termination goes through the boundary, and only through it ─────────────
 *
 * A timeout and a byte budget both end a run by killing the *helper*, which
 * holds the only handle to a `KILL_ON_JOB_CLOSE` job. There is no `taskkill`
 * here, no descendant walk and no list of pids: the kernel takes the tree.
 * That is the whole point of the boundary, and an adapter that added a second
 * termination mechanism "just in case" would be asserting that it does not
 * believe the first one.
 *
 * ── stdin is read from the boundary, never inferred ────────────────────────
 *
 * With a helper in the middle, this process writes into the *helper's* stdin,
 * not the child's. A child that closes its read end early therefore does not
 * break this process's pipe — the direct and owned paths agreed in every case
 * the spike measured, and the ADR records that as a coincidence a production
 * adapter may not rely on. {@link classifyStdinDelivery} takes the boundary's
 * reported forwarding state as the evidence, and treats this side's own write
 * only as the other necessary half: a local write that failed halfway makes
 * the helper see EOF early and report a complete forward of an incomplete
 * payload, so `DELIVERED` requires both.
 */

import {
  DEFAULT_ESTABLISH_TIMEOUT_MS,
  startOwnedProcess,
  type OwnedProcessRequest,
  type OwnedProcessStart,
} from './start-owned-process.js';
import type {
  BoundaryEnding,
  BoundaryLaunchMode,
  BoundaryFailureCode,
  BoundaryLostReason,
  BoundaryStatus,
} from './launch-boundary.js';
/**
 * Type-only, and that is the point: the stdin vocabulary AO already has is
 * *reused*, not re-declared. A second copy of these four words would be free
 * to drift from the runner's, and the drift would show up as a translation
 * table in slice 3 rather than as a failure here. Erased at build time, so
 * this creates no runtime dependency on the diagnostics module.
 */
import type { StdinDelivery } from '../doctor/exec.js';

export type { StdinDelivery };

/** Default wall-clock budget for one owned command, establishment included. */
export const DEFAULT_OWNED_TIMEOUT_MS = 20_000;

/** Default per-stream byte budget. The same number `runCommand` defaults to. */
export const DEFAULT_OWNED_MAX_OUTPUT_BYTES = 1_048_576;

/** How long the boundary is given to end after it has been asked to. */
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;

/** How often the run loop looks for a termination it has to start timing. */
const TERMINATION_POLL_INTERVAL_MS = 5;

/**
 * How a run ended, in the adapter's terms.
 *
 * The ADR names the runner's five: `COMPLETED`, `TIMED_OUT`,
 * `OUTPUT_LIMIT_EXCEEDED`, `SPAWN_FAILED`, `BOUNDARY_LOST`. Two differences,
 * both deliberate:
 *
 *   - `LAUNCH_REFUSED` is this layer's name for the runner's `SPAWN_FAILED`.
 *     Nothing was spawned by *this* process on the owned path — a launch was
 *     refused by the boundary — and the result carries the boundary's own
 *     failure code plus whether the target had begun executing, neither of
 *     which `SPAWN_FAILED` has a place for. Slice 3 maps it.
 *   - `TERMINATED_BY_CALLER` has no runner equivalent because `runCommand` has
 *     no cancellation today. It exists here because the boundary distinguishes
 *     it, and collapsing it into `BOUNDARY_LOST` would make every deliberate
 *     cancellation look like a defect.
 */
export const OWNED_COMMAND_OUTCOMES = [
  'COMPLETED',
  'TIMED_OUT',
  'OUTPUT_LIMIT_EXCEEDED',
  'TERMINATED_BY_CALLER',
  'BOUNDARY_LOST',
  'LAUNCH_REFUSED',
] as const;

export type OwnedCommandOutcome = (typeof OWNED_COMMAND_OUTCOMES)[number];

/**
 * Why this side ended the run, or `NONE` if it did not.
 *
 * One entry per policy that can terminate, and the first trigger wins: a
 * stdout budget landing in the same tick as the timeout may not restart the
 * termination, nor rename the reason it is reported under.
 */
export const OWNED_TERMINATIONS = [
  'NONE',
  'TIMEOUT',
  'LIMIT_STDOUT',
  'LIMIT_STDERR',
  'CALLER',
] as const;

export type OwnedTermination = (typeof OWNED_TERMINATIONS)[number];

/** Fixed failure codes. Never free text, exactly as on the diagnostics path. */
export type OwnedCommandFailureCode =
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT_STDOUT'
  | 'OUTPUT_LIMIT_STDERR'
  | 'TERMINATED_BY_CALLER'
  | 'BOUNDARY_LOST'
  | 'LAUNCH_REFUSED'
  /**
   * The boundary was asked to end and had not ended when its grace ran out.
   *
   * Fail-closed by construction: a helper still alive holds a job this process
   * can no longer account for, so the run is reported as a lost boundary
   * rather than under the policy that asked for the termination. Claiming
   * `TIMED_OUT` here would assert a tree was taken down that demonstrably was
   * not.
   */
  | 'BOUNDARY_TERMINATION_UNCONFIRMED'
  /**
   * The helper's stdio is not readable, so no byte budget can be enforced.
   *
   * Unreachable through `startOwnedProcess`, which always asks for pipes.
   */
  | 'BOUNDARY_STREAMS_UNAVAILABLE'
  /**
   * The boundary and this side disagree about what happened.
   *
   * Unreachable by construction — only this module sets the flag the boundary
   * reads to say "the caller asked" — which is why it is a code rather than an
   * assumption. An inconsistent pair is classified as a lost boundary, because
   * "we do not know what happened to the tree" is exactly what it means.
   */
  | 'ENDING_INCONSISTENT';

/** Whether the target could have had side effects before the run ended. */
export type TargetStarted = 'NO' | 'YES' | 'UNKNOWN';

export interface OwnedCommandClassification {
  readonly outcome: OwnedCommandOutcome;
  readonly failureCode: OwnedCommandFailureCode | null;
  /** The child's own exit code wherever the boundary proved one. */
  readonly exitCode: number | null;
  readonly boundaryFailureCode: BoundaryFailureCode | null;
  readonly boundaryLostReason: BoundaryLostReason | null;
  readonly targetStarted: TargetStarted;
  /**
   * `false` only where the boundary proved the target never executed.
   *
   * `UNKNOWN` counts as "it may have", which is the conservative direction and
   * the one the ADR requires: a caller deciding whether to clean up after a
   * run must not read an unknown launch as a launch that did not happen.
   */
  readonly sideEffectsPossible: boolean;
}

const TERMINATION_OUTCOME: Readonly<
  Record<Exclude<OwnedTermination, 'NONE'>, OwnedCommandOutcome>
> = Object.freeze({
  TIMEOUT: 'TIMED_OUT',
  LIMIT_STDOUT: 'OUTPUT_LIMIT_EXCEEDED',
  LIMIT_STDERR: 'OUTPUT_LIMIT_EXCEEDED',
  CALLER: 'TERMINATED_BY_CALLER',
});

const TERMINATION_FAILURE: Readonly<
  Record<Exclude<OwnedTermination, 'NONE'>, OwnedCommandFailureCode>
> = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  LIMIT_STDOUT: 'OUTPUT_LIMIT_STDOUT',
  LIMIT_STDERR: 'OUTPUT_LIMIT_STDERR',
  CALLER: 'TERMINATED_BY_CALLER',
});

export interface OwnedCommandObservation {
  readonly ending: BoundaryEnding;
  readonly termination: OwnedTermination;
}

/**
 * A process exit code, as the rest of AO already reports it.
 *
 * A Windows exit code is a `DWORD`, and node reports it unsigned — a child
 * calling `process.exit(3221225477)` is observed as 3221225477 by
 * `child_process`, measured on the installed runtime. The helper writes the
 * same `DWORD` through `unchecked((int)exitCode)`, so its status carries
 * -1073741819 for that run. This is where the two agree again, and it belongs
 * here rather than in the boundary's decoder: the decoder's job is to report
 * what the helper wrote, and this layer's job is to report it in AO's terms.
 *
 * 0xC0000005 — an access violation — is not a hypothetical value. It is what a
 * crashed agent comes back with, and reporting it as a negative number would
 * make the owned path disagree with the diagnostics path about the same
 * process.
 */
function unsignedExitCode(code: number | null): number | null {
  return code === null ? null : code >>> 0;
}

/** The exit code a non-completing ending can still show, or `null`. */
function reportedExitCode(ending: BoundaryEnding): number | null {
  if (ending.ending === 'CHILD_EXITED') return unsignedExitCode(ending.childExitCode);
  return unsignedExitCode(ending.status?.childExitCode ?? null);
}

/**
 * Decides one run's outcome.
 *
 * Pure and total: every (ending × termination) pair lands on exactly one
 * declared outcome, and the ones that cannot be proven to be a completion are
 * not one. The order of the branches below is the guarantee — a refusal and a
 * lost boundary are decided *before* any local reason is consulted, so no
 * combination of local state can promote them.
 */
export function classifyOwnedCommand(
  observation: OwnedCommandObservation,
): OwnedCommandClassification {
  const { ending, termination } = observation;

  if (ending.ending === 'BOUNDARY_REFUSED') {
    return Object.freeze({
      outcome: 'LAUNCH_REFUSED' as const,
      failureCode: 'LAUNCH_REFUSED' as const,
      exitCode: null,
      boundaryFailureCode: ending.failureCode,
      boundaryLostReason: null,
      targetStarted: ending.targetStarted,
      sideEffectsPossible: ending.targetStarted !== 'NO',
    });
  }

  if (ending.ending === 'BOUNDARY_LOST') {
    return Object.freeze({
      outcome: 'BOUNDARY_LOST' as const,
      failureCode: 'BOUNDARY_LOST' as const,
      exitCode: reportedExitCode(ending),
      boundaryFailureCode: null,
      boundaryLostReason: ending.reason,
      // The boundary is gone, so whether the target ran is not decidable from
      // here. `UNKNOWN` is the honest value and the conservative one at once.
      targetStarted: 'UNKNOWN' as const,
      sideEffectsPossible: true,
    });
  }

  // Ownership held. Whatever this side decided is now the reason — including
  // for a child exit that arrived in the same tick as the kill, which is
  // `runCommand`'s behaviour and is kept: a termination once issued is not
  // revised by what turned up afterwards.
  if (termination !== 'NONE') {
    return Object.freeze({
      outcome: TERMINATION_OUTCOME[termination],
      failureCode: TERMINATION_FAILURE[termination],
      exitCode: reportedExitCode(ending),
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'YES' as const,
      sideEffectsPossible: true,
    });
  }

  if (ending.ending === 'CHILD_EXITED') {
    return Object.freeze({
      outcome: 'COMPLETED' as const,
      failureCode: null,
      exitCode: unsignedExitCode(ending.childExitCode),
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'YES' as const,
      sideEffectsPossible: true,
    });
  }

  // `TERMINATED_BY_CALLER` with no policy having asked. The boundary only ever
  // reports that because this module set the flag, so the two disagree — and a
  // disagreement about how a process tree ended is a lost boundary, not a
  // completion with a footnote.
  return Object.freeze({
    outcome: 'BOUNDARY_LOST' as const,
    failureCode: 'ENDING_INCONSISTENT' as const,
    exitCode: reportedExitCode(ending),
    boundaryFailureCode: null,
    boundaryLostReason: null,
    targetStarted: 'UNKNOWN' as const,
    sideEffectsPossible: true,
  });
}

/**
 * How far this side's own handover of the payload got.
 *
 * `ABANDONED` is the one that is not obvious, and it is there because of a
 * measurement rather than a design preference: terminating the boundary
 * destroys the pipe this side is writing into, so a write still in flight
 * fails — with an error this side caused. Recording that as `FAILED` would
 * report a proven verdict about a payload whose fate nobody observed, since
 * the last byte may have gone through microseconds earlier.
 */
export type LocalStdinWrite = 'PENDING' | 'COMPLETED' | 'FAILED' | 'ABANDONED';

/** The forwarding states `native/ao-launch/AoLaunch.cs` writes. */
const STDIN_FORWARD_EOF = 'EOF_FORWARDED';
const STDIN_FORWARD_BROKEN = 'BROKEN_PIPE';

export interface StdinDeliveryObservation {
  /** Whether a payload was configured at all. */
  readonly requested: boolean;
  /** Whether ownership was established; nothing is written if it was not. */
  readonly established: boolean;
  readonly localWrite: LocalStdinWrite;
  /** {@link BoundaryStatus.stdinForward}, verbatim, or `null`. */
  readonly forwarded: string | null;
}

/**
 * Decides what became of the payload.
 *
 * `DELIVERED` needs both halves and is the only value that does. The boundary
 * says whether the whole stream it received was forwarded and EOF reached the
 * child; this side says whether the whole payload was handed to the boundary.
 * Either half alone can report success over a payload that was never complete:
 * a local write that failed at byte 100 makes the helper read EOF at byte 100
 * and report `EOF_FORWARDED` truthfully about the bytes it saw.
 *
 * Like `runCommand`'s, `DELIVERED` is a statement about handover, not about
 * reading: nothing observable here can prove the child consumed the bytes.
 */
export function classifyStdinDelivery(observation: StdinDeliveryObservation): StdinDelivery {
  if (!observation.requested) return 'NOT_REQUESTED';
  // A refused launch never had a helper to write into, so a configured payload
  // demonstrably did not reach anything. This is what the diagnostics runner
  // reports for a spawn that never happened.
  if (!observation.established) return 'FAILED';
  // The boundary's own evidence first, and it outranks everything below: the
  // child closed its read end and the helper said so. That stays true whatever
  // this side did afterwards, including ending the run.
  if (observation.forwarded === STDIN_FORWARD_BROKEN) return 'FAILED';
  // A write that failed on its own — nothing here asked for it to stop.
  if (observation.localWrite === 'FAILED') return 'FAILED';
  // A write this side abandoned by terminating the boundary. Never `FAILED`:
  // see {@link LocalStdinWrite}.
  if (observation.localWrite === 'ABANDONED') return 'UNCONFIRMED';
  if (observation.forwarded === STDIN_FORWARD_EOF && observation.localWrite === 'COMPLETED') {
    return 'DELIVERED';
  }
  // No report, or one this build does not know. Both are "it was not observed",
  // and reporting a delivery that was never confirmed is the defect this
  // vocabulary exists to prevent.
  return 'UNCONFIRMED';
}

/**
 * A stream, bounded by bytes, cut off the moment its budget is gone.
 *
 * A deliberate second implementation of `runCommand`'s private sink rather
 * than a shared one. Slice 2's scope is explicit that the diagnostics runner
 * is not modified, and extracting its sink would modify it; slice 3, which
 * moves that runner onto this path, is where the two collapse into one. Until
 * then the equivalence is asserted rather than assumed:
 * `tests/dist-artifact/owned-command-dist-artifact.mjs` runs the same
 * oversized output through both runners and requires the same cut, byte for
 * byte, and the same failure code.
 */
class BoundedSink {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private cutOff = false;

  constructor(private readonly limit: number) {}

  /** Appends a chunk; returns `true` the first time the limit is exceeded. */
  append(chunk: Buffer): boolean {
    if (this.cutOff) return false;

    const remaining = this.limit - this.size;
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return false;
    }

    if (remaining > 0) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.limit;
    }
    this.cutOff = true;
    return true;
  }

  get truncated(): boolean {
    return this.cutOff;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export interface OwnedCommandOptions {
  /** The canonical application path. This module resolves nothing. */
  readonly file: string;
  readonly args?: readonly string[];
  readonly verbatim?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly mode?: BoundaryLaunchMode;
  /**
   * Wall-clock budget for the whole call, establishment included.
   *
   * One deadline, taken at entry, so a slow establishment cannot be paid for
   * twice. Establishment additionally keeps the boundary's own, tighter bound:
   * a launch that has not reported ownership within
   * {@link DEFAULT_ESTABLISH_TIMEOUT_MS} is refused whatever this says.
   */
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  /**
   * How long the boundary is given to end after it has been asked to.
   *
   * A helper still alive after this window leaves a tree nothing here can
   * account for, which is reported as a lost boundary rather than as the
   * policy outcome that asked for the termination.
   */
  readonly terminationGraceMs?: number;
  /** Text handed to the child's standard input, which is then closed. */
  readonly stdin?: string;
  /**
   * Cancellation. Aborting terminates the boundary, and the tree with it.
   *
   * An abort raised while the launch is still being established is honoured
   * when establishment finishes: `startOwnedProcess` is not interruptible, and
   * pretending otherwise would leave a started, owned process with nobody
   * waiting for it. Establishment is bounded, so the delay is too.
   */
  readonly signal?: AbortSignal;
  /** Where request and status files live. A temporary directory by default. */
  readonly workDir?: string;
}

/** The one seam: how a launch is obtained. Substituted only by tests. */
export interface OwnedCommandDependencies {
  readonly start?: (request: OwnedProcessRequest) => Promise<OwnedProcessStart>;
}

export interface OwnedCommandResult extends OwnedCommandClassification {
  readonly display: string;
  readonly file: string;
  readonly args: readonly string[];
  /** Whether verified ownership was established at all. */
  readonly established: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdinDelivery: StdinDelivery;
  readonly helperPid: number | null;
  readonly childPid: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** The boundary's own report, or `null` where there was never a launch. */
  readonly ending: BoundaryEnding | null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms).unref?.();
  });

/**
 * Runs one command behind the launch boundary.
 *
 * Never throws for a failing command: a refused launch, a lost boundary, a
 * timeout and an exceeded budget are all data, exactly as on the diagnostics
 * path. Termination — for any reason — is a single kill of the helper, which
 * holds the only handle to the job; there is no second mechanism here.
 */
export async function runOwnedCommand(
  options: OwnedCommandOptions,
  dependencies: OwnedCommandDependencies = {},
): Promise<OwnedCommandResult> {
  const start = dependencies.start ?? startOwnedProcess;
  const args = options.args ?? [];
  const display = [options.file, ...args].join(' ');
  const timeoutMs = options.timeoutMs ?? DEFAULT_OWNED_TIMEOUT_MS;
  const graceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const deadline = startedAtMs + timeoutMs;
  const stdinRequested = options.stdin !== undefined;

  const finish = (
    extra: Omit<OwnedCommandResult, keyof typeof base | 'finishedAt' | 'durationMs'>,
  ): OwnedCommandResult => {
    const finishedAtMs = Date.now();
    return Object.freeze({
      ...base,
      ...extra,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
    });
  };
  const base = { display, file: options.file, args, startedAt };

  const nothingRan = (
    outcome: OwnedCommandOutcome,
    failureCode: OwnedCommandFailureCode,
  ): OwnedCommandResult =>
    finish({
      established: false,
      outcome,
      failureCode,
      exitCode: null,
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'NO',
      sideEffectsPossible: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      stdinDelivery: stdinRequested ? 'FAILED' : 'NOT_REQUESTED',
      helperPid: null,
      childPid: null,
      ending: null,
    });

  // Cancelled before anything was created. The one path on which this module
  // can say "nothing ran" without asking the boundary, because it never
  // reached it — so it is answered here rather than by starting a process in
  // order to kill it.
  if (options.signal?.aborted === true) {
    return nothingRan('TERMINATED_BY_CALLER', 'TERMINATED_BY_CALLER');
  }

  const establishBudget = Math.min(
    DEFAULT_ESTABLISH_TIMEOUT_MS,
    Math.max(1, deadline - Date.now()),
  );
  const launch = await start({
    file: options.file,
    args,
    verbatim: options.verbatim ?? false,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.workDir === undefined ? {} : { workDir: options.workDir }),
    establishTimeoutMs: establishBudget,
  });

  if (!launch.established) {
    const classification = classifyOwnedCommand({ ending: launch.ending, termination: 'NONE' });
    return finish({
      ...classification,
      established: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      // Nothing was ever written into a helper that never existed.
      stdinDelivery: classifyStdinDelivery({
        requested: stdinRequested,
        established: false,
        localWrite: 'PENDING',
        forwarded: null,
      }),
      helperPid: null,
      childPid: null,
      ending: launch.ending,
    });
  }

  const owned = launch.process;
  const stdout = new BoundedSink(options.maxStdoutBytes ?? DEFAULT_OWNED_MAX_OUTPUT_BYTES);
  const stderr = new BoundedSink(options.maxStderrBytes ?? DEFAULT_OWNED_MAX_OUTPUT_BYTES);

  /**
   * The first trigger wins, for both halves of what it decides: the boundary
   * is asked to die once, and the reason the run is reported under is frozen
   * with it. A stderr budget landing in the same tick as the stdout one, or a
   * timeout landing after either, changes neither.
   */
  let termination: OwnedTermination = 'NONE';
  const terminate = (reason: Exclude<OwnedTermination, 'NONE'>): void => {
    if (termination !== 'NONE') return;
    termination = reason;
    owned.terminate();
  };

  const outStream = owned.helper.stdout;
  const errStream = owned.helper.stderr;
  if (outStream === null || errStream === null) {
    // Unreachable through `startOwnedProcess`, which always asks for pipes.
    // Reported rather than assumed away: a stream that cannot be read is a
    // budget that cannot be enforced, and that is not a run to report on.
    terminate('CALLER');
    const ending = await owned.ending.catch(
      (): BoundaryEnding => ({ ending: 'BOUNDARY_LOST', reason: 'STATUS_UNREADABLE', status: null }),
    );
    owned.dispose();
    return finish({
      established: true,
      outcome: 'BOUNDARY_LOST',
      failureCode: 'BOUNDARY_STREAMS_UNAVAILABLE',
      exitCode: null,
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'YES',
      sideEffectsPossible: true,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      stdinDelivery: stdinRequested ? 'UNCONFIRMED' : 'NOT_REQUESTED',
      helperPid: owned.helperPid,
      childPid: owned.childPid,
      ending,
    });
  }

  outStream.on('data', (chunk: Buffer) => {
    if (stdout.append(chunk)) terminate('LIMIT_STDOUT');
  });
  errStream.on('data', (chunk: Buffer) => {
    if (stderr.append(chunk)) terminate('LIMIT_STDERR');
  });

  /**
   * How far this side's own handover got.
   *
   * Only ever half the answer. The other half — whether the boundary forwarded
   * the whole stream and let the child see EOF — comes from the status, and
   * `DELIVERED` needs both. See {@link classifyStdinDelivery}.
   */
  let localWrite: LocalStdinWrite = 'PENDING';
  const input = owned.helper.stdin;
  if (input === null) {
    localWrite = 'FAILED';
  } else {
    /**
     * A failed handover, attributed to whoever caused it.
     *
     * A termination this side asked for destroys the pipe underneath a write
     * in flight, so the two are told apart by *when* the failure arrived
     * rather than by the error it carries — the error is the same either way.
     */
    const fail = (): void => {
      if (localWrite === 'FAILED' || localWrite === 'ABANDONED') return;
      localWrite = termination === 'NONE' ? 'FAILED' : 'ABANDONED';
    };
    // Attached, and it must stay attached: without a listener an `EPIPE` on
    // this stream is an uncaught exception in *this* process. A failure once
    // seen is never revised, in either direction.
    input.on('error', fail);
    const record = (error?: Error | null): void => {
      if (localWrite === 'FAILED' || localWrite === 'ABANDONED') return;
      if (error === undefined || error === null) localWrite = 'COMPLETED';
      else fail();
    };
    // Closed either way, payload or not: the boundary forwards this EOF to the
    // child, and a child that reads to end-of-file waits forever without it.
    if (options.stdin === undefined) input.end(record);
    else input.end(options.stdin, record);
  }

  if (options.signal !== undefined) {
    options.signal.addEventListener('abort', () => terminate('CALLER'), { once: true });
  }

  const remaining = deadline - Date.now();
  let timer: NodeJS.Timeout | undefined;
  if (remaining <= 0) terminate('TIMEOUT');
  else {
    timer = setTimeout(() => terminate('TIMEOUT'), remaining);
    timer.unref?.();
  }

  // A boundary that will not end. Bounded, and only ever entered once a
  // termination has actually been asked for — a run nobody terminated waits
  // for its own ending, however long the child legitimately takes.
  const unconfirmed = Symbol('termination-unconfirmed');
  const settled = await Promise.race([
    owned.ending,
    (async (): Promise<typeof unconfirmed> => {
      // Polled rather than armed at termination time, because the termination
      // can be requested from three places and a timer per place is three
      // chances to forget one.
      for (;;) {
        if (termination !== 'NONE') break;
        await sleep(TERMINATION_POLL_INTERVAL_MS);
      }
      await sleep(graceMs);
      return unconfirmed;
    })(),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  if (settled === unconfirmed) {
    // The tree may still be alive, and nothing here can prove otherwise. The
    // working directory is deliberately *not* removed: a helper that is still
    // running still owns it. This is the fail-closed answer, and it is not the
    // policy outcome that asked for the termination — reporting `TIMED_OUT`
    // here would claim a tree was taken down that demonstrably was not.
    void owned.ending.catch(() => undefined);
    return finish({
      established: true,
      outcome: 'BOUNDARY_LOST',
      failureCode: 'BOUNDARY_TERMINATION_UNCONFIRMED',
      exitCode: null,
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'YES',
      sideEffectsPossible: true,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdinDelivery: classifyStdinDelivery({
        requested: stdinRequested,
        established: true,
        localWrite,
        forwarded: null,
      }),
      helperPid: owned.helperPid,
      childPid: owned.childPid,
      ending: null,
    });
  }

  const ending = settled;
  const classification = classifyOwnedCommand({ ending, termination });
  const result = finish({
    ...classification,
    established: true,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdinDelivery: classifyStdinDelivery({
      requested: stdinRequested,
      established: true,
      localWrite,
      // The boundary's own report is the evidence. This side's pipe cannot see
      // a child that stopped reading, because it is not the child's pipe.
      forwarded: ending.status?.stdinForward ?? null,
    }),
    helperPid: owned.helperPid,
    childPid: owned.childPid,
    ending,
  });
  // Only now: the ending has been read, and the status file it was read from
  // lives in the directory this removes.
  owned.dispose();
  return result;
}
