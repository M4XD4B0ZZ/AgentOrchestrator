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
 * So {@link classifyOwnedCommand} is a total function over everything it is
 * told — the boundary's ending, the reason this side terminated, and the three
 * facts only the run loop knows: whether ownership was established, whether the
 * caller cancelled before it was, and whether this call's own deadline expired.
 * It has exactly one path to `COMPLETED`: the boundary observed the child exit,
 * no policy here terminated it, and nothing said ownership was never
 * established — neither `ownershipEstablished: false` nor a cancellation raised
 * before ownership. Every other combination — including ones unreachable by
 * construction — lands on a non-success, and
 * `tests/v3-02-owned-command.test.ts` enumerates that whole product rather than
 * sampling it. It is enumerated across all of those inputs because the first
 * version crossed only two of them, and a `COMPLETED` hid in the rest for a
 * round.
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
 *
 * One correction to that ADR paragraph, since this module's design rests on
 * it. It says the caller observes an early close "only because the helper exits
 * and its own pipe breaks in turn". The shipped helper does not do that:
 * `PumpStdin` in `native/ao-launch/AoLaunch.cs` records `BROKEN_PIPE`, closes
 * the child's end and returns from its thread — the helper stays alive and goes
 * on to report the child's exit. The dist-artifact case "a child that exits
 * without reading is never DELIVERED" measures exactly that: the run completes
 * with the child's own exit code *and* a broken-pipe report, which the ADR's
 * mechanism could not produce.
 */

import {
  DEFAULT_ESTABLISH_TIMEOUT_MS,
  startOwnedProcess,
  type OwnedProcess,
  type OwnedProcessRequest,
  type OwnedProcessStart,
} from './start-owned-process.js';
import {
  InvalidBoundaryRequestError,
  type BoundaryEnding,
  type BoundaryLaunchMode,
  type BoundaryFailureCode,
  type BoundaryLostReason,
  type BoundaryStatus,
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

/**
 * The largest delay node accepts. A larger one is silently turned into 1 ms,
 * which would make an absurd budget fire at once instead of effectively never.
 */
const MAX_TIMER_MS = 2_147_483_647;

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
   * Reported as a lost boundary, because "we do not know what happened to the
   * tree" is exactly what it means. Six producers, and only the first is
   * unreachable:
   *
   *   - a `TERMINATED_BY_CALLER` ending with no policy here having asked — only
   *     this module sets the flag the boundary reads, so the two cannot really
   *     disagree;
   *   - an ending that proves ownership (`CHILD_EXITED`,
   *     `TERMINATED_BY_CALLER`) beside a caller that says ownership was never
   *     established, or was cancelled before it was;
   *   - a refusal beside a caller that watched ownership *be* established.
   *     Reachable: node emits `error` on a child process when a kill fails, not
   *     only when a spawn does, and `startOwnedProcess` reports that as a
   *     refused launch;
   *   - a refusal this side nevertheless terminated. Reachable *after*
   *     establishment: a status that turns foreign under a shared working
   *     directory, or a `boundary=FAILED` written after the `boundary=OK` this
   *     run was established on;
   *   - a child exit code no process could have exited with, which is why the
   *     launch nonce exists — a status file is not beyond a third party's
   *     reach;
   *   - a termination reason this build does not declare.
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

const KNOWN_TERMINATIONS: ReadonlySet<string> = new Set(OWNED_TERMINATIONS);

/**
 * The four endings the boundary contract declares.
 *
 * Checked for the same reason `OWNED_TERMINATIONS` is: this module argues that
 * untyped callers are a real input class, and an ending naming a fifth state
 * was accepted with a local termination reason and reported as an ordinary
 * `TIMED_OUT`. No route to `COMPLETED`, so it was an asymmetry rather than a
 * hole — but an asymmetry in the one function whose job is to fail closed.
 */
const KNOWN_ENDINGS: ReadonlySet<string> = new Set([
  'CHILD_EXITED',
  'TERMINATED_BY_CALLER',
  'BOUNDARY_LOST',
  'BOUNDARY_REFUSED',
]);

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
  /**
   * Whether the caller cancelled before ownership was ever established.
   *
   * Distinct from `termination: 'CALLER'`, which means this side terminated a
   * boundary it held. Here there was nothing to terminate yet — so the pairing
   * is not contradictory, and it is the caller's own act that should name the
   * outcome rather than the refusal that happened to race it.
   */
  readonly cancelledBeforeOwnership?: boolean;
  /**
   * Whether this call's own wall-clock budget had expired by then.
   *
   * Consulted only alongside a refusal, where it decides whether "ownership was
   * not established in time" is this caller's timeout or the boundary's own.
   * On its own it says nothing about ownership, and nothing else is decided
   * from it.
   */
  readonly deadlineExpired?: boolean;
  /**
   * Whether verified ownership was established at all.
   *
   * Stated, rather than inferred from the ending, because it is what makes
   * several pairs *contradictory* instead of merely unusual — and a
   * contradiction is the module's cue to fail closed. A caller that omits it
   * says nothing, and nothing is then decided from it.
   */
  readonly ownershipEstablished?: boolean;
}

/**
 * A process exit code, as the rest of AO already reports it, or `null` for one
 * that cannot be a Windows exit code at all.
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
 *
 * The range check is not decoration either. `>>> 0` is a `ToUint32`: on its
 * own it maps 2**32 to 0 and 4294967297 to 1, so a value outside the range
 * would have become a plausible small exit code. The decoder guarantees only a
 * *safe* integer, and a status file is not beyond a third party's reach — that
 * is why the launch nonce exists. Out of range answers `null`, and a
 * completion whose exit code is `null` is refused rather than reported.
 */
function unsignedExitCode(code: number | null): number | null {
  if (code === null || !Number.isInteger(code)) return null;
  if (code < -2_147_483_648 || code > 4_294_967_295) return null;
  return code >>> 0;
}

/** The exit code a non-completing ending can still show, or `null`. */
function reportedExitCode(ending: BoundaryEnding): number | null {
  if (ending.ending === 'CHILD_EXITED') return unsignedExitCode(ending.childExitCode);
  return unsignedExitCode(ending.status?.childExitCode ?? null);
}

/**
 * Decides one run's outcome.
 *
 * Pure and total over all five of its inputs — the boundary's ending, the
 * reason this side terminated, and the three facts only the run loop knows.
 * Every combination lands on exactly one declared outcome, and the ones that
 * cannot be proven to be a completion are not one.
 *
 * Six combinations are contradictory rather than merely unusual, and all of
 * them fail closed rather than being rounded to the nearest plausible answer.
 * They are enumerated on {@link OwnedCommandFailureCode}'s
 * `ENDING_INCONSISTENT` member, next to which of them are reachable.
 */
export function classifyOwnedCommand(
  observation: OwnedCommandObservation,
): OwnedCommandClassification {
  const { ending, termination } = observation;

  /**
   * The fail-closed answer for a pair whose two halves contradict each other.
   * A disagreement about how a process tree ended is a lost boundary: "we do
   * not know what happened to it" is exactly what it means.
   */
  const inconsistent = (): OwnedCommandClassification =>
    Object.freeze({
      outcome: 'BOUNDARY_LOST' as const,
      failureCode: 'ENDING_INCONSISTENT' as const,
      exitCode: null,
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'UNKNOWN' as const,
      sideEffectsPossible: true,
    });

  /**
   * The pairs whose two halves cannot both be true, decided before any of them
   * gets to name an outcome.
   *
   * Round 3 added the establishment-time facts and read them inside the
   * refusal branch only. Paired with any other ending they were ignored — and
   * "ownership was never established" beside "the boundary owned a child and
   * saw it exit" fell straight through to `COMPLETED`, on a result whose own
   * `established: false` and empty output contradicted it. Deciding them here
   * is what makes the enumeration in `tests/v3-02-owned-command.test.ts` a
   * statement about the whole product rather than about one row of it.
   */
  if (!KNOWN_ENDINGS.has(ending.ending)) return inconsistent();

  const provesOwnership = ending.ending === 'CHILD_EXITED' || ending.ending === 'TERMINATED_BY_CALLER';
  // `deadlineExpired` is deliberately *not* here. A clock running out says
  // nothing about whether ownership was established, and folding it in *would*
  // have classified every ordinary timeout on an established run as a lost
  // boundary with no exit code — the words reserved for "we do not know what
  // happened to the tree", over the one case where it is known exactly.
  //
  // Would have, not did: the run loop passes that fact only on the
  // not-established path, so no run this module could produce ever behaved that
  // way. It was a latent contradiction in an exported, documented function, and
  // a test had already pinned the wrong reading of it. It is consulted only
  // where it means something now: the refusal branch.
  const deniesOwnership =
    observation.ownershipEstablished === false || observation.cancelledBeforeOwnership === true;
  if (provesOwnership && deniesOwnership) return inconsistent();
  // And the mirror. A refusal means ownership was never established, so a
  // caller that watched it *be* established is describing something the
  // boundary cannot also be right about. Reachable: node emits `error` on a
  // child process when a kill fails, not only when a spawn does, and
  // `startOwnedProcess` reports that as a refused launch — for a run whose
  // ownership it had already published.
  if (ending.ending === 'BOUNDARY_REFUSED' && observation.ownershipEstablished === true) {
    return inconsistent();
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

  if (ending.ending === 'BOUNDARY_REFUSED') {
    // A refusal means no ownership was established; a local termination means
    // this side had something to terminate. Both cannot be true, and the
    // dangerous half is the refusal's `targetStarted: 'NO'` — the one value a
    // caller acts on to conclude a run needs no cleanup. The first version
    // returned the refusal unchanged here, discarding the caller's own reason
    // with it, and the enumeration test excluded exactly this row.
    if (termination !== 'NONE') return inconsistent();

    /**
     * What the boundary saw is not always what happened, and two things can be
     * true at the same moment as a refusal. Both rename the *outcome* only:
     * `boundaryFailureCode` and `targetStarted` still come from the refusal,
     * because they are what says whether anything may have run.
     *
     * This lives inside the classifier deliberately. An earlier version applied
     * it in the run loop, spread over the classification — which put it outside
     * the one total function this module's guarantees are stated about, and
     * promptly proved why: applied to *every* ending on that path, it reported
     * a `BOUNDARY_LOST` as a deliberate cancellation, complete with a
     * `boundaryLostReason` hanging off a `TERMINATED_BY_CALLER`.
     */
    const refused = {
      exitCode: null,
      boundaryFailureCode: ending.failureCode,
      boundaryLostReason: null,
      targetStarted: ending.targetStarted,
      sideEffectsPossible: ending.targetStarted !== 'NO',
    };
    // The caller's own act outranks the clock: a run someone cancelled is
    // cancelled, whatever else expired while it was being refused.
    if (observation.cancelledBeforeOwnership === true) {
      return Object.freeze({
        ...refused,
        outcome: 'TERMINATED_BY_CALLER' as const,
        failureCode: 'TERMINATED_BY_CALLER' as const,
      });
    }
    // And only for the refusal that *means* "the budget ran out". A permanent
    // installation defect discovered while a small budget happened to expire is
    // still that defect, not a retryable timeout.
    if (
      observation.deadlineExpired === true &&
      ending.failureCode === 'BOUNDARY_NOT_ESTABLISHED_IN_TIME'
    ) {
      return Object.freeze({
        ...refused,
        outcome: 'TIMED_OUT' as const,
        failureCode: 'TIMEOUT' as const,
      });
    }
    return Object.freeze({
      ...refused,
      outcome: 'LAUNCH_REFUSED' as const,
      failureCode: 'LAUNCH_REFUSED' as const,
    });
  }

  // Ownership held. Whatever this side decided is now the reason — including
  // for a child exit that arrived in the same tick as the kill, which is
  // `runCommand`'s behaviour and is kept: a termination once issued is not
  // revised by what turned up afterwards.
  if (termination !== 'NONE') {
    // A reason this build does not declare. Reachable from anything not type
    // checked against this build — the `.mjs` dist harness, a JS consumer,
    // slice 3 across a serialisation boundary — and indexing the two maps with
    // it produced a frozen result carrying `outcome: undefined`, which is
    // neither a completion nor a declared failure and threw nothing. That is
    // fail-*open* in the one function this module exists to make fail-closed.
    if (!KNOWN_TERMINATIONS.has(termination)) return inconsistent();
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
    const exitCode = unsignedExitCode(ending.childExitCode);
    // A completion is the one claim this module makes that a caller acts on as
    // success. A status whose exit code is not one a process could have exited
    // with does not support it.
    if (exitCode === null) return inconsistent();
    return Object.freeze({
      outcome: 'COMPLETED' as const,
      failureCode: null,
      exitCode,
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'YES' as const,
      sideEffectsPossible: true,
    });
  }

  // `TERMINATED_BY_CALLER` with no policy having asked. The boundary only ever
  // reports that because this module set the flag, so the two disagree.
  return inconsistent();
}


/**
 * How far this side's own handover of the payload got.
 *
 * `NO_CHANNEL` is the only one that is evidence on its own: there was no pipe
 * to write into, so nothing was handed over at all. `FAILED` is deliberately
 * *not* evidence about the payload — see {@link classifyStdinDelivery}.
 */
export type LocalStdinWrite = 'PENDING' | 'COMPLETED' | 'FAILED' | 'NO_CHANNEL';

/**
 * Every forwarding state `native/ao-launch/AoLaunch.cs` writes.
 *
 * Three, and the list is a completeness claim: anything else read out of a
 * status is a state this build does not know, which
 * {@link classifyStdinDelivery} answers `UNCONFIRMED`.
 */
const STDIN_FORWARD_EOF = 'EOF_FORWARDED';
const STDIN_FORWARD_BROKEN = 'BROKEN_PIPE';
/** The helper stopped reading the payload part-way and knows it did. */
const STDIN_FORWARD_SOURCE_FAILED = 'SOURCE_READ_FAILED';

export interface StdinDeliveryObservation {
  /** Whether a payload was configured at all. */
  readonly requested: boolean;
  /** Whether ownership was established; nothing is written if it was not. */
  readonly established: boolean;
  readonly localWrite: LocalStdinWrite;
  /** {@link BoundaryStatus.stdinForward}, verbatim, or `null`. */
  readonly forwarded: string | null;
  /**
   * Whether the boundary reported the child's own exit.
   *
   * Evidence about *the helper*, used here to decide what a failed local write
   * means. An ending carrying the child's exit code proves the helper lived
   * long enough to observe and publish it, so the pipe this side lost did not
   * break because the helper was gone.
   */
  readonly boundaryObservedChildExit?: boolean;
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
 *
 * A *failed* local write is not a verdict on its own, and that is the
 * correction the first review forced — with the exception the second one
 * added, above. The pipe this side writes into belongs
 * to the helper, not to the child: its breaking means the helper died — by
 * this side's hand, or by someone else's — and says nothing about what the
 * child received, since the last byte may have gone through microseconds
 * earlier. The first version reported a proven `FAILED` whenever the error
 * arrived before a local termination had been recorded, which made the verdict
 * depend on *who killed the helper* rather than on what was observed. Such a
 * write is `UNCONFIRMED` now, whoever caused it, unless the boundary itself
 * reported a broken pipe.
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
  // The helper's other proven non-delivery: it stopped reading the payload
  // part-way. Stronger evidence than `NO_CHANNEL` below, and it was falling
  // through to the weakest word the vocabulary has.
  if (observation.forwarded === STDIN_FORWARD_SOURCE_FAILED) return 'FAILED';
  // No pipe existed, so nothing was handed over. An observation, not an
  // absence of one.
  if (observation.localWrite === 'NO_CHANNEL') return 'FAILED';
  if (observation.forwarded === STDIN_FORWARD_EOF && observation.localWrite === 'COMPLETED') {
    return 'DELIVERED';
  }
  // A write that failed while the helper demonstrably lived on to report the
  // child's exit. The helper's death is then not the explanation, no
  // end-of-file was ever forwarded, and this side genuinely failed to hand the
  // payload over — which is what `runCommand` reports for the same physical
  // event, and slice 3 has to collapse the two.
  if (observation.localWrite === 'FAILED' && observation.boundaryObservedChildExit === true) {
    return 'FAILED';
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
   *
   * `0` is accepted and means exactly what it says — the boundary gets no time
   * at all — so every timeout, budget cut and cancellation will be reported as
   * `BOUNDARY_TERMINATION_UNCONFIRMED` and leave its working directory behind.
   * That is almost never what a caller wants; it is not silently corrected,
   * because a value quietly replaced by a different one is how the opposite
   * defect got in.
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

/**
 * Lets go of a helper this module has given up on.
 *
 * `unref()` alone does not do it, and the difference was measured rather than
 * reasoned about. `ChildProcess.unref()` unrefs the process handle; the three
 * piped stdio sockets keep their own libuv references, and removing a `data`
 * listener pauses nothing. Reproduced on the installed runtime with a child
 * that would not die: a parent that only detached its listeners and called
 * `unref()` was still alive after 3 seconds, and one that destroyed the streams
 * exited in 1 millisecond.
 *
 * It matters exactly where the fail-closed paths are: they exist for a helper
 * that ignored its own kill, and without this AO would hang on exit, held open
 * by the pipes of the process it had just declared unaccounted for.
 *
 * Three callers: the streams-unavailable branch, the unconfirmed-termination
 * branch, and a refused ending on a run whose ownership had been established.
 * Only the first reaches here before the run loop has attached its own stdin
 * error listener, which is why the listener below is attached before the
 * destroy rather than assumed to exist.
 */
function releaseHelper(owned: OwnedProcess): void {
  for (const stream of [owned.helper.stdout, owned.helper.stderr, owned.helper.stdin]) {
    if (stream === null || stream === undefined) continue;
    try {
      // Listened to before it is destroyed, and that ordering is the point. A
      // stream destroyed under an in-flight write reports it, and an `error`
      // with no listener is an uncaught exception in *this* process. One of the
      // two callers reaches here before the run loop has attached its own stdin
      // listener — and it is the path that exists for a boundary already known
      // not to be behaving as constructed.
      stream.on('error', () => {
        /* this process has stopped reading and writing this stream */
      });
      stream.destroy();
    } catch {
      /* a stream that cannot be destroyed is one this process no longer uses */
    }
  }
  owned.helper.unref?.();
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
  /**
   * A temporary directory this run created and did **not** remove, or `null`.
   *
   * It is a leftovers report, not a location: `null` is the normal answer, and
   * it means there is nothing here to reap. The first version of this field
   * reported the working directory of every run — including the ones it had
   * just deleted — so a caller doing the obvious thing with it would have aimed
   * a recursive delete at a freed `mkdtemp` name on every command.
   *
   * Non-null on exactly the three results that deliberately keep their
   * directory, because each of them may leave a helper still writing into it:
   * `BOUNDARY_STREAMS_UNAVAILABLE`, `BOUNDARY_TERMINATION_UNCONFIRMED`, and a
   * refusal reported after ownership had been established.
   *
   * A `workDir` the *caller* supplied is never reported, whatever happens to
   * it. The caller already knows that path, this module never removes it, and
   * saying "here is your own directory back" would put a caller-owned path into
   * a field whose whole purpose is "this is safe for you to delete".
   */
  readonly retainedWorkDir: string | null;
  /**
   * The boundary's own report, or `null` where there is none to give.
   *
   * `null` does **not** mean nothing was launched — read {@link established}
   * for that. It is also `null` on the two paths where a launch demonstrably
   * happened and this module then gave up on it without an ending:
   * `BOUNDARY_STREAMS_UNAVAILABLE` and `BOUNDARY_TERMINATION_UNCONFIRMED`,
   * which are the two most dangerous results this module can return.
   */
  readonly ending: BoundaryEnding | null;
}

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
  /**
   * A caller-supplied number, or the default for one this module cannot use.
   *
   * The type check is not redundant with the compiler. This module argues, at
   * {@link classifyOwnedCommand}'s termination guard, that untyped callers are
   * a real input class — the `.mjs` dist harness, a JS consumer, slice 3 across
   * a serialisation boundary — and the three validators here used to disagree
   * about that threat.
   *
   * Measured, replaying the predicate this replaced: a *numeric* string was
   * never the problem, because `Math.min` coerces it and `"20000"` arrived as
   * 20000. What did get through was a non-numeric string or an object — `NaN`
   * deadline, a one-millisecond timeout, the tree killed — and `null`, which
   * coerces to 0 and made every run an instant timeout. `null` is the one worth
   * naming: it is what a JSON round trip does to an absent value, which is
   * precisely how slice 3 will pass these.
   *
   * The cost of the check is that a numeric string is now refused rather than
   * coerced, so `maxStdoutBytes: "1000"` falls back to the default megabyte
   * instead of bounding at a kilobyte. That is the deliberate direction: a
   * caller that cannot express a number in a number has not stated a budget,
   * and this module's fallbacks are documented values rather than guesses at
   * what was meant.
   *
   * `NaN` is the shape a missing config value takes after `parseInt`, and on
   * `timeoutMs` it was the worst place for it: the deadline became `NaN`, the
   * establishment budget with it, and `startOwnedProcess` polled a helper that
   * neither establishes nor exits — forever, with the abort listener not yet
   * armed to rescue it. On a byte budget it was milder and still wrong: every
   * stream cut off at its first byte, so every run reported an output-limit
   * failure over empty output.
   *
   * `Infinity` is **not** in that class, and the first version of this check
   * treated it as if it were. On a byte budget it is a caller saying "no
   * bound" — a thing both this module and `runCommand` can do — and folding it
   * into the default did not merely cap the stream, it reported
   * `OUTPUT_LIMIT_EXCEEDED` and terminated the job for a limit the caller had
   * explicitly disabled.
   *
   * On a *timeout* the two paths differ, and the difference is recorded rather
   * than smoothed over: measured, `runCommand` with `timeoutMs: Infinity` fires
   * at 1ms — node turns an over-large delay into one, and nothing there clamps
   * it — while this module clamps to the largest expressible timer. This
   * module's behaviour is the intended one; the divergence is real, it is not
   * measured by the differential (which passes `Infinity` only for a byte
   * budget, because a case asserting agreement here would fail), and it is
   * slice 3's to resolve when it collapses the two runners.
   */
  const usable = (value: number | undefined, fallback: number): number =>
    typeof value !== 'number' || Number.isNaN(value) || value < 0 ? fallback : value;

  /**
   * The same, for a delay.
   *
   * Delays carry one extra bound that budgets must not: node turns a timeout
   * above the 32-bit maximum into 1ms, so an unbounded delay has to become the
   * largest one a timer can express. A byte budget has no such limit.
   *
   * No test distinguishes a byte budget clamped to `MAX_TIMER_MS` from an
   * unclamped one, and none can without producing two gigabytes of output. The
   * separation is here because a timer bound on a buffer is a category error,
   * not because something would go red.
   */
  const usableDelay = (value: number | undefined, fallback: number): number =>
    Math.min(usable(value, fallback), MAX_TIMER_MS);

  /**
   * And the same again for the one delay that may not be unbounded.
   *
   * The grace exists to bound a helper that ignored its own kill, so an
   * unbounded one is not a longer grace — it is the absence of the guarantee.
   * `Infinity` on `timeoutMs` clamps to the largest expressible timer and is a
   * caller saying "effectively never", which is a legitimate thing to want;
   * here the same value would mean the fail-closed report never arrives at all,
   * which is not. It falls back to the default instead.
   */
  const usableGrace = (value: number | undefined, fallback: number): number =>
    value === undefined || !Number.isFinite(value) || value < 0
      ? fallback
      : Math.min(value, MAX_TIMER_MS);

  const timeoutMs = usableDelay(options.timeoutMs, DEFAULT_OWNED_TIMEOUT_MS);
  // Node turns a delay above the 32-bit maximum into 1ms, so asking for a
  // *generous* grace produced the opposite of one: the grace expired before any
  // real boundary could close, and every timeout, budget cut and cancellation
  // came back as a lost boundary with its working directory leaked.
  const graceMs = usableGrace(options.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const deadline = startedAtMs + timeoutMs;
  const stdinRequested = options.stdin !== undefined;
  const signal = options.signal;

  const base = { display, file: options.file, args, startedAt };

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

  const nothingRan = (
    outcome: OwnedCommandOutcome,
    failureCode: OwnedCommandFailureCode,
    targetStarted: TargetStarted,
  ): OwnedCommandResult =>
    finish({
      established: false,
      outcome,
      failureCode,
      exitCode: null,
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted,
      sideEffectsPossible: targetStarted !== 'NO',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      stdinDelivery: stdinRequested ? 'FAILED' : 'NOT_REQUESTED',
      helperPid: null,
      childPid: null,
      retainedWorkDir: null,
      ending: null,
    });

  // Cancelled before anything was created. The one path on which this module
  // can say "nothing ran" without asking the boundary, because it never
  // reached it — so it is answered here rather than by starting a process in
  // order to kill it.
  if (signal?.aborted === true) {
    return nothingRan('TERMINATED_BY_CALLER', 'TERMINATED_BY_CALLER', 'NO');
  }

  /**
   * The abort is watched from *before* the launch, and that ordering is the
   * whole point of it.
   *
   * The first version of this module read `signal.aborted` once, before
   * establishment, and attached its listener once, after it. A listener added
   * to an already-aborted signal is never invoked, so an abort landing in
   * between — which is most of a launch's wall-clock, a helper spawn plus a
   * status poll — was dropped, and the run went on to report a completion for
   * a launch the caller had cancelled.
   *
   * `terminateOnAbort` is filled in once there is something to terminate; the
   * flag covers the window before that, and is re-read below.
   */
  let abortRequested = false;
  let terminateOnAbort: (() => void) | undefined;
  const onAbort = (): void => {
    abortRequested = true;
    terminateOnAbort?.();
  };
  signal?.addEventListener('abort', onAbort);

  let timer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  try {
    const establishBudget = Math.min(
      DEFAULT_ESTABLISH_TIMEOUT_MS,
      Math.max(1, deadline - Date.now()),
    );

    let launch: OwnedProcessStart;
    try {
      launch = await start({
        file: options.file,
        args,
        verbatim: options.verbatim ?? false,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.workDir === undefined ? {} : { workDir: options.workDir }),
        establishTimeoutMs: establishBudget,
      });
    } catch (error) {
      // Starting a launch writes files and spawns a process, and both fail for
      // environmental reasons — a full disk, a read-only TMP, a spawn that
      // throws synchronously rather than emitting. Those are runtime
      // conditions, and this module reports runtime conditions as data.
      //
      // `InvalidBoundaryRequestError` is the exception: a NUL in an argument
      // or an `=` in an environment name is a programming error in this
      // repository, exactly as an unsafe argument is on the diagnostics path,
      // and it keeps propagating.
      if (error instanceof InvalidBoundaryRequestError) throw error;
      // Conservative on purpose: a throw is not evidence that nothing was
      // created, and the message is not carried — it may contain untrusted
      // text.
      return nothingRan('LAUNCH_REFUSED', 'LAUNCH_REFUSED', 'UNKNOWN');
    }

    if (!launch.established) {
      // Two facts this loop knows and the boundary cannot: whether the caller
      // cancelled while the launch was still being established, and whether
      // this call's own wall-clock budget expired doing it. They are handed to
      // the classifier rather than applied to its answer — see the refusal
      // branch there for what happened when they were not.
      const classification = classifyOwnedCommand({
        ending: launch.ending,
        termination: 'NONE',
        ownershipEstablished: false,
        cancelledBeforeOwnership: abortRequested,
        deadlineExpired: Date.now() >= deadline,
      });
      return finish({
        ...classification,
        established: false,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        // Nothing was ever written into a helper that never established.
        stdinDelivery: classifyStdinDelivery({
          requested: stdinRequested,
          established: false,
          localWrite: 'PENDING',
          forwarded: null,
        }),
        helperPid: null,
        childPid: null,
        // Nothing to reap: `startOwnedProcess` removes a temporary directory
        // it created before it reports a refusal, and a directory the caller
        // supplied stays the caller's.
        retainedWorkDir: null,
        ending: launch.ending,
      });
    }

    const owned = launch.process;
    /**
     * The directory this run leaves behind, from the point of view of a caller
     * deciding what to clean up.
     *
     * Only a temporary directory *this* module caused to be created counts: one
     * the caller supplied is the caller's, is never removed here, and is not
     * this field's business.
     */
    const retained = (): string | null => (options.workDir === undefined ? owned.workDir : null);
    const stdout = new BoundedSink(usable(options.maxStdoutBytes, DEFAULT_OWNED_MAX_OUTPUT_BYTES));
    const stderr = new BoundedSink(usable(options.maxStderrBytes, DEFAULT_OWNED_MAX_OUTPUT_BYTES));

    /**
     * The grace window, armed by the termination that needs it.
     *
     * A promise that is never resolved unless a termination was actually
     * requested — so a run nobody terminated waits for its own ending, however
     * long the child legitimately takes, and holds no timer while it does.
     *
     * The first version polled a flag every 5 ms instead, in a loop with no
     * exit for a run that ends normally: every completed call left a timer
     * waking 200 times a second forever, retaining its output buffers and its
     * child process. Every timer in this module is unref'd, so nothing in the
     * suite could observe it.
     */
    const unconfirmed = Symbol('termination-unconfirmed');
    let expireGrace: (() => void) | undefined;
    const graceExpired = new Promise<typeof unconfirmed>((done) => {
      expireGrace = () => done(unconfirmed);
    });

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
      graceTimer = setTimeout(() => expireGrace?.(), graceMs);
      graceTimer.unref?.();
    };

    const outStream = owned.helper.stdout;
    const errStream = owned.helper.stderr;
    if (outStream === null || errStream === null) {
      // Unreachable through `startOwnedProcess`, which always asks for pipes.
      // Reported rather than assumed away: a stream that cannot be read is a
      // budget that cannot be enforced, and that is not a run to report on.
      //
      // Nothing is awaited here. The single situation this path exists for is
      // "the boundary is not behaving as constructed", and waiting for such a
      // boundary to confirm its own death is the one thing that cannot be
      // relied on. The working directory is left alone, because a helper that
      // may still be running still owns it.
      owned.terminate();
      releaseHelper(owned);
      void owned.ending.catch(() => undefined);
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
        // Decided by the classifier rather than by hand, and the answer is
        // the stronger word: this branch returns before the stdin writer below
        // exists, so it *knows* not one byte was handed over.
        stdinDelivery: classifyStdinDelivery({
          requested: stdinRequested,
          established: true,
          localWrite: 'NO_CHANNEL',
          forwarded: null,
        }),
        helperPid: owned.helperPid,
        childPid: owned.childPid,
        retainedWorkDir: retained(),
        ending: null,
      });
    }

    const onStdout = (chunk: Buffer): void => {
      if (stdout.append(chunk)) terminate('LIMIT_STDOUT');
    };
    const onStderr = (chunk: Buffer): void => {
      if (stderr.append(chunk)) terminate('LIMIT_STDERR');
    };
    outStream.on('data', onStdout);
    errStream.on('data', onStderr);

    /**
     * How far this side's own handover got.
     *
     * Only ever half the answer. The other half — whether the boundary
     * forwarded the whole stream and let the child see EOF — comes from the
     * status, and `DELIVERED` needs both. See {@link classifyStdinDelivery}.
     */
    let localWrite: LocalStdinWrite = 'PENDING';
    const input = owned.helper.stdin;
    if (input === null) {
      localWrite = 'NO_CHANNEL';
    } else {
      const fail = (): void => {
        if (localWrite === 'FAILED') return;
        localWrite = 'FAILED';
      };
      // Attached, and it must stay attached: without a listener an `EPIPE` on
      // this stream is an uncaught exception in *this* process. A failure once
      // seen is never revised.
      input.on('error', fail);
      const record = (error?: Error | null): void => {
        if (localWrite === 'FAILED') return;
        if (error === undefined || error === null) localWrite = 'COMPLETED';
        else fail();
      };
      // Closed either way, payload or not: the boundary forwards this EOF to
      // the child, and a child that reads to end-of-file waits forever without
      // it.
      if (options.stdin === undefined) input.end(record);
      else input.end(options.stdin, record);
    }

    // From here an abort has something to act on — and the flag is re-read,
    // because an abort that landed during establishment set it before this
    // function existed.
    terminateOnAbort = () => terminate('CALLER');
    if (abortRequested) terminate('CALLER');

    const remaining = deadline - Date.now();
    if (remaining <= 0) terminate('TIMEOUT');
    else {
      // Not clamped here: `usableDelay` already bounded `timeoutMs` by
      // `MAX_TIMER_MS`, and `remaining` is at most that. A second `Math.min`
      // would be a bound neither test nor mutant could distinguish from its
      // absence, which is how a check stops being one.
      timer = setTimeout(() => terminate('TIMEOUT'), remaining);
      timer.unref?.();
    }

    const settled = await Promise.race([owned.ending, graceExpired]);

    if (settled === unconfirmed) {
      // The tree may still be alive, and nothing here can prove otherwise.
      //
      // Three deliberate consequences. The output sinks are detached *and
      // destroyed*, so a chunk arriving later cannot re-terminate a run that
      // has already been reported and this process is not held open by the
      // pipes of a helper it has given up on — see {@link releaseHelper}, where
      // the difference between those two is measured. The working directory is
      // *not* removed, because a helper that is still running still owns it.
      //
      // And the outcome is not the policy that asked for the termination:
      // reporting `TIMED_OUT` here would claim a tree was taken down that
      // demonstrably was not.
      outStream.off('data', onStdout);
      errStream.off('data', onStderr);
      releaseHelper(owned);
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
          boundaryObservedChildExit: false,
        }),
        helperPid: owned.helperPid,
        childPid: owned.childPid,
        retainedWorkDir: retained(),
        ending: null,
      });
    }

    const ending = settled;
    const classification = classifyOwnedCommand({ ending, termination, ownershipEstablished: true });
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
        // The boundary's own report is the evidence. This side's pipe cannot
        // see a child that stopped reading, because it is not the child's pipe.
        forwarded: ending.status?.stdinForward ?? null,
        boundaryObservedChildExit: ending.ending === 'CHILD_EXITED',
      }),
      helperPid: owned.helperPid,
      childPid: owned.childPid,
      // Filled in below, once it is known whether this run disposed of it.
      retainedWorkDir: null,
      ending,
    });
    if (ending.ending === 'BOUNDARY_REFUSED') {
      // Contradictory, and already classified as such above — but it also
      // decides what happens to the helper and to the working directory.
      //
      // Two ways to get here, and they differ in exactly the thing that
      // matters. A status that turned foreign, or a `boundary=FAILED` written
      // after the `boundary=OK` this run was established on, arrive on the
      // helper's *close*: the helper is gone. A helper `error` event — node
      // emits one when a kill fails, not only when a spawn does — arrives with
      // the helper possibly still running and still writing into that
      // directory.
      //
      // Nothing here can tell the two apart, so the directory is left alone in
      // both, and reported on `retainedWorkDir` for a caller that can decide
      // later with more evidence than this module has.
      const abandoned = Object.freeze({ ...result, retainedWorkDir: retained() });
      // And the helper is asked to die first, exactly as the
      // streams-unavailable branch asks.
      // Both branches exist for a boundary that is not behaving as constructed,
      // and this one is reached when node reports a *failed kill* — so the
      // helper may still be alive, still holding the only handle to a
      // KILL_ON_JOB_CLOSE job containing the agent tree. Releasing it without
      // asking it to die once more leaves that tree running for the rest of the
      // machine's uptime. A termination request to a helper that is already
      // gone is a no-op, so there is no cost to the symmetry.
      owned.terminate();
      releaseHelper(owned);
      void owned.ending.catch(() => undefined);
      return abandoned;
    }
    // Only now: the ending has been read, and the status file it was read from
    // lives in the directory this removes.
    owned.dispose();
    return result;
  } finally {
    // Every exit, including a thrown one. A listener left on a signal that
    // outlives the run retains this run's buffers and child process, warns
    // past ten on a shared controller, and fires `terminate` on a launch that
    // finished long ago.
    signal?.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}
