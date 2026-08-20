/**
 * The owned-command adapter — V3 slice 2.
 *
 * `./start-owned-process.ts` starts a process the kernel owns and reports how
 * the boundary ended. It deliberately owns nothing else: no timeout, no byte
 * budget, no stdin vocabulary, no result classification. This module is the
 * other half the ADR keeps in TypeScript — the policy, and the translation of
 * a {@link BoundaryEnding} into a result an AO runner could consume.
 *
 * ── Who reaches this, and what fences it (V3 slice 3) ──────────────────────
 *
 * Exactly one module: `../doctor/exec.js`. Slice 2 shipped this adapter
 * reachable from nothing; slice 3 gave it one caller, and the reachability pin
 * in `tests/v2-07l-execution-lease.test.ts` states that as an assertion rather
 * than as an intention — a second importer fails it.
 *
 * The fence is unchanged by that, and deliberately so. This module carries
 * process **ownership** and no authority of its own: it contains whatever it is
 * asked to start, which is exactly why the thing allowed to ask must stay
 * behind the execution lease. No lease logic lives here or in the native
 * helper, and putting any there would move authority into the layer that has
 * none.
 *
 * `runCommand` is not a runner — it starts what it is given — and six modules
 * give it something. Three are fenced, and they are the three that *act*: the
 * agent and verification runners, reachable only through
 * `leasedAgent`/`leasedVerify`, and the Git seam, whose mutations are proved
 * against the lease immediately before the effect. The other three —
 * `repo/git-query.ts`, `doctor/capabilities.ts`, `auth/auth-preflight.ts` — are
 * read-only probes and are **not** fenced, exactly as they were not before this
 * slice. Naming them is the point: the boundary now contains them too, and a
 * reader who believes the seams cover every caller would look for the wrong
 * gate. Widening what any of them may do is a lease decision, not this
 * module's.
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
import { existsSync } from 'node:fs';

import type { ContainmentAttestation } from '../core/containment-attestation.js';
import { mintContainmentAttestation } from '../core/internal/containment-attestation.js';

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
 * table in the runner rather than as a failure here — and slice 3, which
 * wired the two together, needed no such table. Erased at build time, so
 * this creates no runtime dependency on the diagnostics module.
 */
import type { StdinDelivery } from '../doctor/exec.js';

export type { StdinDelivery };

/**
 * Re-exported so that `../doctor/exec.js` needs one window onto this boundary
 * and not two.
 *
 * It is the one exception `runOwnedCommand` lets out — a request the transport
 * cannot represent is a programming error here, exactly as an unsafe argument
 * is on the diagnostics path — and the runner has to catch it in order to keep
 * its own "the only thrown error is `UnsafeArgumentError`" contract true on
 * both platforms. Importing `./launch-boundary.js` there for one class would
 * put a third module on the boundary's contract, which the reachability pin in
 * `tests/v2-07l-execution-lease.test.ts` states there are exactly two of — and
 * that pin is worth more than the directness.
 */
export { InvalidBoundaryRequestError };

/** Default wall-clock budget for one owned command, establishment included. */
export const DEFAULT_OWNED_TIMEOUT_MS = 20_000;

/** Default per-stream byte budget. The same number `runCommand` defaults to. */
export const DEFAULT_OWNED_MAX_OUTPUT_BYTES = 1_048_576;

/** How long the boundary is given to end after it has been asked to. */
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;

/**
 * The largest delay node accepts. A larger one is silently turned into 1 ms,
 * which would make an absurd budget fire at once instead of effectively never.
 *
 * Exported since V3 slice 3, and for a reason worth stating: `runCommand` now
 * clamps its own timeout to exactly this value on **both** platforms, so that
 * an over-large delay means "effectively never" wherever it is passed rather
 * than meaning "effectively never" here and "one millisecond" there. One
 * constant, one contract — a second copy of the number would be free to drift
 * from this one, and the drift would present itself as a platform difference.
 */
export const MAX_TIMER_MS = 2_147_483_647;

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
 * Which outcomes an established run may attest containment for.
 *
 * Total over {@link OwnedCommandOutcome} by construction, so a sixth member
 * added to that union stops the build here rather than defaulting to `false` —
 * which would be safe, and would also be a decision nobody made. Completeness is
 * not correctness, though: a `satisfies` clause would accept `true` in every
 * row, so every entry is asserted by value in `tests/v3-04-lease-containment.test.ts`.
 *
 * The three `false` rows are the whole point of the table:
 *
 *  - `LAUNCH_REFUSED` — no ownership was ever established. There is nothing to
 *    attest to, and an attestation for it would be a claim about a process that
 *    may never have existed;
 *  - `BOUNDARY_LOST` — the boundary stopped being accountable for the tree. That
 *    is precisely the case where "the owner's death took the writer with it"
 *    stops being true, so it is the one an attestation must never survive;
 *  - `TERMINATED_BY_CALLER` — the run was cancelled, and `doctor/exec.ts` maps it
 *    to `BOUNDARY_LOST` on the way out because nothing in this build can cancel
 *    one. Attesting for an outcome the layer above reports as a lost boundary
 *    would make the two disagree about the same run.
 *
 * `TIMED_OUT` and `OUTPUT_LIMIT_EXCEEDED` are `true` because on an established
 * run they mean this side terminated the tree and the boundary *confirmed* it:
 * an unconfirmed termination never reaches the classifier at all, it returns
 * `BOUNDARY_LOST` / `BOUNDARY_TERMINATION_UNCONFIRMED` several branches earlier.
 */
const ATTESTABLE_OUTCOME: Readonly<Record<OwnedCommandOutcome, boolean>> = Object.freeze({
  COMPLETED: true,
  TIMED_OUT: true,
  OUTPUT_LIMIT_EXCEEDED: true,
  TERMINATED_BY_CALLER: false,
  BOUNDARY_LOST: false,
  LAUNCH_REFUSED: false,
});

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
   * tree" is exactly what it means. Ten producers, and only the first is
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
   *   - a termination reason this build does not declare;
   *   - an ending that is absent, or is not an object at all;
   *   - an ending naming a state this build does not declare;
   *   - an observation that is not an object at all;
   *   - an ending promise that rejected rather than resolving, which the run
   *     loop reports rather than letting escape.
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
 * Ten combinations are contradictory or unreadable rather than merely unusual,
 * and all of them fail closed rather than being rounded to the nearest plausible
 * answer.
 * They are enumerated on {@link OwnedCommandFailureCode}'s
 * `ENDING_INCONSISTENT` member, next to which of them are reachable.
 */
export function classifyOwnedCommand(
  observation: OwnedCommandObservation,
): OwnedCommandClassification {
  if (observation === null || typeof observation !== 'object') {
    // The same hole as `classifyStdinDelivery`'s, one level up: an earlier
    // round guarded the *ending* against being absent and left the observation
    // carrying it unguarded, so destructuring threw the `TypeError` that guard
    // was written to prevent.
    return Object.freeze({
      outcome: 'BOUNDARY_LOST' as const,
      failureCode: 'ENDING_INCONSISTENT' as const,
      exitCode: null,
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'UNKNOWN' as const,
      sideEffectsPossible: true,
    });
  }
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
  // Presence before value, and for the same stated reason. The value check
   // below was justified by "anything not type checked against this build" —
  // and an absent ending is exactly what a JSON round trip makes of a helper
  // that died before publishing one. Reading `.ending` off it threw a
  // `TypeError` out of the one function whose contract is to fail closed.
  if (ending === null || typeof ending !== 'object') return inconsistent();
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
    // checked against this build — the `.mjs` dist harness, a JS consumer, a
    // serialisation boundary — and indexing the two maps with
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
 * `NOT_HANDED_OVER` is the only one that is evidence on its own: this module
 * knows it wrote nothing at all. Two producers — there was no pipe to write
 * into, or the run was abandoned before the writer ran — and the earlier name,
 * `NO_CHANNEL`, was asserted on both, which made the second one claim an
 * absent pipe that was in fact open. `FAILED` is deliberately *not* evidence
 * about the payload — see {@link classifyStdinDelivery}.
 */
export type LocalStdinWrite = 'PENDING' | 'COMPLETED' | 'FAILED' | 'NOT_HANDED_OVER';

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
 * A *failed* local write is not a verdict on its own, and it has no exception.
 * An earlier round added one — a failure paired with an ending carrying the
 * child's exit code was read as proven, on the reasoning that the helper must
 * therefore have outlived the write — and the reasoning does not hold: the
 * helper publishes the exit and *then* exits, so a write can fail immediately
 * afterwards precisely because the helper is gone. The rule is withdrawn rather
 * than patched.
 *
 * One consequence is a real divergence from `runCommand`'s POSIX path, and V3
 * slice 3 settled it in this module's favour rather than by restoring the older
 * word: for a write that fails while the child exits cleanly, the POSIX runner
 * reports `FAILED` and this one reports `UNCONFIRMED`. That is the conservative
 * direction — a verdict nobody observed is not stated — and it is now the
 * documented contract on `StdinDelivery` rather than an open item. Every
 * consumer in this repository folds the two into the same conclusion: the
 * payload did not demonstrably arrive, so the run's output is not evidence
 * about the question that was asked. The pipe this side writes into belongs
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
  // The observation itself, before anything in it. An absent `requested` means
  // one thing — somebody built this observation without deciding — and
  // `undefined` survives no serialisation, so it is the shape a programmatic
  // caller produces rather than one a JSON round trip creates. (An earlier
  // version of this comment claimed the latter; `JSON.stringify` keeps `true`
  // and `false` alike, and only drops the key when the value was already
  // `undefined`.) Read as merely falsy it answered `NOT_REQUESTED`: *no payload
  // was ever configured*, which is the strongest false reassurance this
  // vocabulary can give, for a caller that had not said either way.
  //
  // `UNCONFIRMED` is the fail-closed answer here for the same reason it is
  // everywhere else in this function: it is what "nobody observed this" means.
  if (observation === null || typeof observation !== 'object') return 'UNCONFIRMED';
  if (observation.requested === false) return 'NOT_REQUESTED';
  if (observation.requested !== true) return 'UNCONFIRMED';
  // A refused launch never had a helper to write into, so a configured payload
  // demonstrably did not reach anything. This is what the diagnostics runner
  // reports for a spawn that never happened.
  if (observation.established !== true) return 'FAILED';
  // The boundary's own evidence first, and it outranks everything below: the
  // child closed its read end and the helper said so. That stays true whatever
  // this side did afterwards, including ending the run.
  if (observation.forwarded === STDIN_FORWARD_BROKEN) return 'FAILED';
  // The helper's other proven non-delivery: it stopped reading the payload
  // part-way. Stronger evidence than `NOT_HANDED_OVER` below, and it was
  // falling through to the weakest word the vocabulary has.
  if (observation.forwarded === STDIN_FORWARD_SOURCE_FAILED) return 'FAILED';
  // Nothing was handed over at all, which is an observation rather than an
  // absence of one.
  if (observation.localWrite === 'NOT_HANDED_OVER') return 'FAILED';
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
 * Still a second implementation of `runCommand`'s private sink rather than a
 * shared one, and V3 slice 3 kept it that way deliberately. Collapsing the two
 * would put a sink used by the owned path inside the module that also owns the
 * POSIX one, for no behavioural gain — the two are byte-for-byte equivalent and
 * that equivalence is measured rather than assumed:
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
 * Four callers: the streams-unavailable branch, the unconfirmed-termination
 * branch, an ending promise that rejected, and a refused ending on a run whose
 * ownership had been established. Only the first reaches here before the run
 * loop has attached its own stdin error listener, which is why the listener
 * below is attached before the destroy rather than assumed to exist.
 */
function releaseHelper(owned: OwnedProcess): void {
  for (const stream of [owned.helper.stdout, owned.helper.stderr, owned.helper.stdin]) {
    if (stream === null || stream === undefined) continue;
    try {
      // Listened to before it is destroyed, and that ordering is the point. A
      // stream destroyed under an in-flight write reports it, and an `error`
      // with no listener is an uncaught exception in *this* process. One of the
      // three callers — the streams-unavailable branch — reaches here before
      // the run loop has attached its own stdin listener, and it is the path
      // that exists for a boundary already known not to be behaving as
      // constructed.
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
   * it means this module created no temporary directory that is still there.
   * The first version of this field reported the working directory of every run
   * — including the ones it had just deleted — so a caller doing the obvious
   * thing with it would have aimed a recursive delete at a freed `mkdtemp` name
   * on every command.
   *
   * Normally non-null on the four results that deliberately keep their
   * directory, because each of them may leave a helper still writing into it:
   * `BOUNDARY_STREAMS_UNAVAILABLE`, `BOUNDARY_TERMINATION_UNCONFIRMED`, an
   * ending promise that rejected, and a refusal reported after ownership had
   * been established. It is also non-null on an ordinary run whose removal did
   * not take.
   *
   * One gap, stated rather than papered over: a launch that never established
   * ownership is refused by `startOwnedProcess`, which removes its own
   * temporary directory and does not report where it was — so this side never
   * learns that path and answers `null` even if the removal failed. Closing
   * that needs the boundary to report the directory on a refusal, which is a
   * change to slice 1's result shape and not this slice's to make.
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
   * for that. It is also `null` on the three paths where a launch demonstrably
   * happened and this module then gave up on it without an ending:
   * `BOUNDARY_STREAMS_UNAVAILABLE`, `BOUNDARY_TERMINATION_UNCONFIRMED` and an
   * ending promise that rejected, which are the most dangerous results this
   * module can return.
   */
  readonly ending: BoundaryEnding | null;
  /**
   * Proof that this run's target was created inside a job this process owns, or
   * `null` — which is every run that cannot show it.
   *
   * Opaque, and unconstructable outside its mint: a caller cannot write one
   * down, and a substituted `dependencies.start` cannot *return* one, because
   * the mint is reached from this module and the seam's result shape has no
   * field to put one on. That is what makes the value mean something — a test
   * that fabricates an `OwnedCommandResult` gets `null` here and therefore no
   * evidence, which is the correct answer rather than an inconvenience.
   *
   * What that does **not** say, and an earlier draft of this comment did: that a
   * seam cannot cause one to exist. It can — the mint's inputs are the
   * substituted process's own pids, mode and membership flag, so a substitute
   * that claims a verified job produces a genuine attestation for a process it
   * made up. The honest description is the one
   * `ExecutionLeaseDependencies.link` gives about its own seam: production
   * injects nothing (the package exports only the CLI), and the guarantee is
   * "a seam whose contract the caller must keep", not "a seam that cannot be
   * abused".
   *
   * `null` on every refused, lost or unaccountable run. See
   * {@link ATTESTABLE_OUTCOME} for which outcomes may carry one and why the
   * three that may not, may not.
   */
  readonly containment: ContainmentAttestation | null;
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
  /**
   * The request itself, before anything is launched for it.
   *
   * Everything else this module validates is a number with a documented
   * fallback. These two have none, and one of them was the only caller-supplied
   * value that reached a *throwing* sink after ownership was established:
   * `Writable.end(chunk)` throws synchronously for a chunk that is neither a
   * string nor a Buffer, and the throw escaped past a `finally` that clears
   * timers and removes a listener but does not kill anything. Measured: the
   * helper — holder of the only handle to the job containing the agent tree —
   * was launched and then abandoned with no reference and no kill, for the rest
   * of the machine's uptime.
   *
   * Refused here, where nothing has been created yet, rather than caught there,
   * where something has. The run loop still guards the write as well: a value
   * that gets past this and still throws is reported as a failed hand-over
   * rather than as an escape.
   *
   * The third condition is about *authority* rather than about a throw, and it
   * is the one the boundary's wire format forces. An environment reaches the
   * helper as repeated `env=` lines, and `native/ao-launch/AoLaunch.cs` builds
   * a replacement environment block only when it received at least one — so
   * "an environment with nothing in it" and "no environment given" are the same
   * request, and the helper answers the second by letting the child inherit
   * *its* environment, which is AO's. `child_process.spawn(file, args, { env })`
   * does the opposite: an empty object hands the child an empty environment.
   *
   * That difference is not a cosmetic one. `createProbeEnv` returns `{}` on a
   * machine where none of the allow-listed names is set, and an agent silently
   * inheriting AO's whole environment is exactly the widening the env guard
   * exists to prevent. The launch is refused instead: a request this boundary
   * cannot express is not a request it may approximate.
   */
  const inexpressibleEnv =
    options !== null &&
    typeof options === 'object' &&
    options.env !== undefined &&
    (typeof options.env !== 'object' ||
      options.env === null ||
      !Object.values(options.env).some((value) => typeof value === 'string'));
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.file !== 'string' ||
    options.file.length === 0 ||
    (options.stdin !== undefined && typeof options.stdin !== 'string') ||
    inexpressibleEnv
  ) {
    return Object.freeze({
      // Nothing was launched, so there is nothing to attest to. Stated rather
      // than defaulted: this is the one result in the module that does not go
      // through `finish`.
      containment: null,
      display: '',
      file: typeof options?.file === 'string' ? options.file : '',
      args: [],
      established: false,
      outcome: 'LAUNCH_REFUSED' as const,
      failureCode: 'LAUNCH_REFUSED' as const,
      exitCode: null,
      boundaryFailureCode: null,
      boundaryLostReason: null,
      targetStarted: 'NO' as const,
      sideEffectsPossible: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      // Nothing was launched, so nothing received a payload — and the request
      // that named one is exactly the request being refused.
      stdinDelivery: (options?.stdin === undefined ? 'NOT_REQUESTED' : 'FAILED') as StdinDelivery,
      helperPid: null,
      childPid: null,
      retainedWorkDir: null,
      ending: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    });
  }

  const start = dependencies.start ?? startOwnedProcess;
  const args = options.args ?? [];
  const display = [options.file, ...args].join(' ');
  /**
   * A caller-supplied number, or the default for one this module cannot use.
   *
   * The type check is not redundant with the compiler. This module argues, at
   * {@link classifyOwnedCommand}'s termination guard, that untyped callers are
   * a real input class — the `.mjs` dist harness, a JS consumer, a
   * serialisation boundary — and the three validators here used to disagree
   * about that threat.
   *
   * Measured, replaying the predicate this replaced: a *numeric* string was
   * never the problem, because `Math.min` coerces it and `"20000"` arrived as
   * 20000. What did get through was a non-numeric string or an object — `NaN`
   * deadline, a one-millisecond timeout, the tree killed — and `null`, which
   * coerces to 0 and made every run an instant timeout. `null` is the one worth
   * naming: it is what a JSON round trip does to an absent value, and what an
   * untyped caller of the dist artefact can produce.
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
   * On a *timeout* the two paths used to differ, and V3 slice 3 closed it in
   * this module's favour: measured, `runCommand` with `timeoutMs: Infinity`
   * fired at 1 ms — node turns an over-large delay into one, and nothing there
   * clamped it — while this module clamps to the largest expressible timer.
   * `runCommand` now applies the same clamp, from the same exported constant,
   * on both platforms, so an over-large delay means "effectively never"
   * wherever it is passed. Pinned in `tests/v3-03-owned-runner.test.ts`.
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

  /**
   * `containment` defaults to `null` here rather than being demanded of every
   * call site, and the default is the fail-closed one: a branch that forgets to
   * decide attests nothing. Exactly one call below passes a value, and it is the
   * one that has an established boundary and a classified ending in hand.
   */
  const finish = (
    extra: Omit<OwnedCommandResult, keyof typeof base | 'finishedAt' | 'durationMs' | 'containment'> & {
      readonly containment?: ContainmentAttestation | null;
    },
  ): OwnedCommandResult => {
    const finishedAtMs = Date.now();
    return Object.freeze({
      ...base,
      ...extra,
      containment: extra.containment ?? null,
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
      // Through the classifier rather than by hand, which is the pattern an
      // earlier round removed from the streams-unavailable branch and left
      // here: hand-rolled, this line could be mutated to `NOT_REQUESTED` — "no
      // payload was ever configured" — with the whole gate green.
      stdinDelivery: classifyStdinDelivery({
        requested: stdinRequested,
        established: false,
        localWrite: 'NOT_HANDED_OVER',
        forwarded: null,
      }),
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

  /**
   * The sinks, and the listeners that fill them, exist before the launch does.
   *
   * They used to be created after establishment, which is when this function
   * first *has* a stream — and that was a race a short-lived child wins. See
   * `OwnedProcessRequest.onHelperSpawned`: the handover happens in the same
   * tick as the spawn now, so there is no window in which the helper's output
   * has nowhere to go.
   *
   * The consequence is that a budget can be exceeded before there is a boundary
   * to terminate. That is what `pendingLimit` is for: the reason is remembered
   * and applied the moment termination becomes possible, rather than being
   * dropped (an unbounded stream) or acted on through a `terminate` that does
   * not exist yet (a crash on the one path that must not have one).
   */
  const stdout = new BoundedSink(usable(options.maxStdoutBytes, DEFAULT_OWNED_MAX_OUTPUT_BYTES));
  const stderr = new BoundedSink(usable(options.maxStderrBytes, DEFAULT_OWNED_MAX_OUTPUT_BYTES));
  let requestTermination: ((reason: Exclude<OwnedTermination, 'NONE'>) => void) | undefined;
  let pendingLimit: 'LIMIT_STDOUT' | 'LIMIT_STDERR' | undefined;
  const limitReached = (reason: 'LIMIT_STDOUT' | 'LIMIT_STDERR'): void => {
    if (requestTermination !== undefined) requestTermination(reason);
    else if (pendingLimit === undefined) pendingLimit = reason;
  };
  const onStdout = (chunk: Buffer): void => {
    if (stdout.append(chunk)) limitReached('LIMIT_STDOUT');
  };
  const onStderr = (chunk: Buffer): void => {
    if (stderr.append(chunk)) limitReached('LIMIT_STDERR');
  };
  let sinksAttached = false;
  const attachSinks = (helper: { stdout: unknown; stderr: unknown }): void => {
    const out = helper.stdout as NodeJS.ReadableStream | null | undefined;
    const err = helper.stderr as NodeJS.ReadableStream | null | undefined;
    // Nothing is attached to half a pair. A helper without both streams is the
    // `BOUNDARY_STREAMS_UNAVAILABLE` case, decided after establishment where
    // there is a boundary to terminate.
    if (out === null || out === undefined || err === null || err === undefined) return;
    out.on('data', onStdout);
    err.on('data', onStderr);
    sinksAttached = true;
  };

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
        onHelperSpawned: attachSinks,
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
        // Nothing to reap: `startOwnedProcess` disposes of a temporary directory
        // it created when it refuses — deferred until its own ending settles,
        // so shortly after rather than before it returns — and a directory the
        // caller supplied stays the caller's.
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
     *
     * And it is *observed*, not inferred. Every removal on the boundary's side
     * is an `rmSync` inside a swallowing `catch`, so "we called dispose" is not
     * evidence that the directory is gone — an `EBUSY` from a scanner or from
     * the helper's own staging file leaves it there. Asking the filesystem is
     * the only way this field can mean what it says.
     */
    const retained = (): string | null =>
      options.workDir !== undefined || !existsSync(owned.workDir) ? null : owned.workDir;

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
    // From here a budget has something to act on. Anything the sinks recorded
    // before this point kept its reason rather than acting on it.
    requestTermination = terminate;

    const outStream = owned.helper.stdout;
    const errStream = owned.helper.stderr;
    if (outStream === null || outStream === undefined || errStream === null || errStream === undefined) {
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
          // This branch returns before the writer below exists, so not one byte
          // was handed over — whatever the stdin pipe's own state happens to be.
          localWrite: 'NOT_HANDED_OVER',
          forwarded: null,
        }),
        helperPid: owned.helperPid,
        childPid: owned.childPid,
        retainedWorkDir: retained(),
        ending: null,
      });
    }

    // Normally already done, in the same tick as the spawn. This covers the one
    // caller that cannot have been: a substituted `dependencies.start`, which
    // owes no callback and is how every test drives this function.
    if (!sinksAttached) attachSinks(owned.helper);
    // And a budget that was already gone before there was a boundary to
    // terminate is acted on now, before anything else can name the outcome.
    if (pendingLimit !== undefined) terminate(pendingLimit);

    /**
     * How far this side's own handover got.
     *
     * Only ever half the answer. The other half — whether the boundary
     * forwarded the whole stream and let the child see EOF — comes from the
     * status, and `DELIVERED` needs both. See {@link classifyStdinDelivery}.
     */
    let localWrite: LocalStdinWrite = 'PENDING';
    const input = owned.helper.stdin;
    if (input === null || input === undefined) {
      // Both spellings, because `releaseHelper` already admits both on these
      // very handles — and if `undefined` is reachable there, `input.on(...)`
      // below throws, which is the abandonment this function was just taught to
      // refuse.
      localWrite = 'NOT_HANDED_OVER';
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
      //
      // Guarded, as defence in depth behind the entry check: a synchronous
      // throw here would escape with a live helper already owning a tree, and a
      // failed hand-over is data on this path like every other failure.
      try {
        if (options.stdin === undefined) input.end(record);
        else input.end(options.stdin, record);
      } catch {
        localWrite = 'FAILED';
      }
    }

    // From here an abort has something to act on — and the flag is re-read,
    // because an abort that landed during establishment set it before this
    // function existed.
    terminateOnAbort = () => terminate('CALLER');
    if (abortRequested) terminate('CALLER');

    const remaining = deadline - Date.now();
    if (remaining <= 0) terminate('TIMEOUT');
    else {
      // Clamped, and the clamp is not the redundancy an earlier round took it
      // for. `usableDelay` bounds `timeoutMs`, but `remaining` is
      // `deadline - Date.now()` and `Date.now()` is the wall clock: an NTP step
      // backwards between the two readings makes `remaining` *larger* than the
      // budget. With `timeoutMs: Infinity`, clamped to exactly `MAX_TIMER_MS`,
      // a one-millisecond step is enough to push it over — and node turns an
      // over-large delay into 1 ms, so the run this caller asked never to time
      // out would terminate at once.
      //
      // No test kills this clamp, and none can without stepping the machine's
      // clock. Disclosed rather than left to look pinned, exactly as the two
      // unkillable mutants in `native/ao-launch/AoLaunch.cs` are.
      timer = setTimeout(() => terminate('TIMEOUT'), Math.min(remaining, MAX_TIMER_MS));
      timer.unref?.();
    }

    let settled: BoundaryEnding | typeof unconfirmed;
    try {
      settled = await Promise.race([owned.ending, graceExpired]);
    } catch {
      // "Never throws for a failing command" has to hold after establishment
      // too. `OwnedProcess.ending` carries no promise that it cannot reject,
      // and `dependencies.start` is a documented substitution seam — so a
      // rejection here would have escaped a function whose contract is data,
      // taking a live helper, three referenced sockets and a temporary
      // directory with it.
      outStream.off('data', onStdout);
      errStream.off('data', onStderr);
      owned.terminate();
      releaseHelper(owned);
      return finish({
        established: true,
        outcome: 'BOUNDARY_LOST',
        failureCode: 'ENDING_INCONSISTENT',
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
        retainedWorkDir: retained(),
        ending: null,
      });
    }

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
        }),
        helperPid: owned.helperPid,
        childPid: owned.childPid,
        retainedWorkDir: retained(),
        ending: null,
      });
    }

    /**
     * The boundary has ended, and on every ending that can name a verdict the
     * streams have too.
     *
     * Not an assumption. `owned.ending` settles from `helperClosed`, which has
     * two producers, and they differ exactly here. A `close` is emitted only
     * once the process has ended *and* the stdio streams node counts have
     * closed — which, for a stream in flowing mode, is after every `data` it
     * will ever emit; so anything arriving that way has complete sinks, which
     * is `CHILD_EXITED`, `TERMINATED_BY_CALLER`, `BOUNDARY_LOST`, and a
     * `BOUNDARY_REFUSED` whose status turned foreign or failed after this run
     * was established.
     *
     * The other producer is an `'error'` event, which also arrives as a
     * `BOUNDARY_REFUSED` and can arrive with the helper still running. Nothing
     * distinguishes the two refusals from here, so neither is waited on — and
     * the price is bounded: an established run that ends in a refusal is a
     * contradiction (`classifyOwnedCommand` with `ownershipEstablished: true`
     * answers `ENDING_INCONSISTENT` for every one of them), so its outcome is
     * `BOUNDARY_LOST` whatever the sinks hold. They are still *reported* — the
     * branch below returns `stdout`/`stderr` as collected, and a caller may
     * want them — but nothing reads them as a verdict, so a chunk that never
     * arrived changes no answer.
     *
     * An earlier version of this slice awaited the streams as well, on the
     * reasoning that a short-lived child could finish before its listeners were
     * attached. That was a real defect and it is fixed one layer up, by handing
     * the streams over in the same tick as the spawn
     * (`OwnedProcessRequest.onHelperSpawned`) — so the wait repaired nothing,
     * and it was withdrawn rather than kept as a second mechanism with a
     * measurement borrowed from the first.
     *
     * Removing it was measured before it was done — 120 of 120 fast `.cmd` runs
     * kept their output without it — and that measurement is a one-off, not a
     * gate: it existed to justify a deletion, and there is nothing left to
     * regress. What is pinned, and pins the defect the wait was mistaken for,
     * is the short-lived-child case in `tests/v3-03-owned-runner.test.ts`.
     *
     * Nothing here waits on a pipe, and that is why the second producer above
     * costs nothing to reason about. Node emits `'error'` on a child process
     * when a *kill* fails, not only when a spawn does, so a helper that ignored
     * its own termination arrives here alive and still holding these handles.
     * Waiting for a pipe held by the process you have just declared unaccounted
     * for is exactly how a containment measurement deadlocks on its own
     * survivors.
     */
    const ending = settled;
    const classification = classifyOwnedCommand({ ending, termination, ownershipEstablished: true });
    /**
     * The one place in this build that mints a containment attestation.
     *
     * Every input comes from the boundary rather than from this module's own
     * bookkeeping: the pids and the membership confirmation are the helper's,
     * and the launch nonce is echoed back in the status the helper wrote — so a
     * status that is not this launch's carries no nonce to attest with. The mint
     * re-checks all of it and answers `null` for anything it cannot vouch for,
     * including a `verifiedInJob` that is not `true`.
     *
     * `ownerPid` is `process.pid` because that is what the boundary was coupled
     * to: `startOwnedProcess` defaults `ownerPid` to its own process and this
     * module never overrides it — there is no option on `OwnedCommandOptions`
     * that could. If that ever changes, this line becomes a lie and the lease
     * recorder's owner check is what catches it.
     */
    const containment = ATTESTABLE_OUTCOME[classification.outcome]
      ? mintContainmentAttestation({
          ownerPid: process.pid,
          helperPid: owned.helperPid,
          childPid: owned.childPid,
          mode: owned.mode,
          assignedAtCreation: owned.assignedAtCreation,
          launchNonce: ending.status?.nonce ?? '',
          observedAt: new Date().toISOString(),
          verifiedInJob: owned.verifiedInJob,
        })
      : null;
    const result = finish({
      ...classification,
      containment,
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
      }),
      helperPid: owned.helperPid,
      childPid: owned.childPid,
      // Answered after the disposal below, because the answer is whether the
      // directory is still there — and on this path something is about to try
      // to remove it.
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
      // The sinks come off first. The streams-unavailable branch has none to
      // remove, so its symmetry does not cover this: a chunk delivered after
      // `releaseHelper` would run `terminate` on a run that has already
      // returned, arming a grace timer the `finally` has already been past.
      outStream.off('data', onStdout);
      errStream.off('data', onStderr);
      // And the helper is asked to die, as the streams-unavailable branch asks.
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
    // The sinks come off on this path too, and for the same reason the
    // `BOUNDARY_REFUSED` branch above gives: a chunk delivered after the result
    // is built would run `terminate` on a run that has already returned, arming
    // a grace timer the `finally` below has already been past — an unref'd
    // five-second timer nothing will clear, holding this run's buffers.
    //
    // Defence rather than necessity on this path, and stated as such: the note
    // above argues the sinks are already complete here, so no chunk should be
    // in flight. The detach costs nothing, and the argument it is defending
    // against being wrong is the one thing a comment cannot enforce.
    outStream.off('data', onStdout);
    errStream.off('data', onStderr);
    // Only now: the ending has been read, and the status file it was read from
    // lives in the directory this removes.
    owned.dispose();
    // And the report is taken *after* the removal, not instead of it. Every
    // removal on the boundary's side is an `rmSync` inside a swallowing catch,
    // so "dispose was called" was never evidence the directory is gone — an
    // `EBUSY` from a scanner or from the helper's own staging file leaves it,
    // and the earlier version of this line hard-coded `null` on exactly the
    // path a caller runs most often.
    return Object.freeze({ ...result, retainedWorkDir: retained() });
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
