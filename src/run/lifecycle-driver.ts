/**
 * The unattended lifecycle driver: the thin layer *above* `runTask`.
 *
 * ── What this module is not ────────────────────────────────────────────────
 *
 * It is not a second orchestration model, and it is not a resume runner. Both
 * of those already exist. `run-driver.ts` holds the governed loop — lease
 * verification, reconciliation, the continuation decision, one loop step, then
 * a reload — and it already consumes `evaluateAutomaticResume` through
 * `classifyResume`. Nothing here re-derives any of that, and nothing here may.
 *
 * The V3 slice-6 brief was written against a stale sentence in
 * `core/automatic-resume.ts` claiming there was "deliberately still no resume
 * runner". There is one, and it has been the only caller of `runLoopStep` since
 * V2-04. That sentence has been corrected; this module closes what was actually
 * missing, which is three things and no more:
 *
 *  1. **`run --attended` never acted on `STEP_BUDGET_EXHAUSTED`.** It is the one
 *     outcome documented to mean "call again", and that command stopped on it
 *     and told the operator to invoke again by hand.
 *
 *     Not "no caller ever called again", which an earlier version of this line
 *     claimed and which is false: `block --attended` has re-entered `runTask` on
 *     it since V2-08 — `block/block-conclusion.ts` maps it to `CONTINUE` and
 *     `block/block-runner.ts` loops while that holds. Being wrong about a
 *     neighbouring module is how this slice was mis-scoped to begin with, so it
 *     is worth being exact: the mechanism existed on one of the two commands,
 *     and this brings the other level with it.
 *
 *     The two loops terminate differently, and they now agree. `block-runner`
 *     stops a continuation that landed `steps === 0`; this one carries that
 *     floor too — unreachable, and marked so where it sits — and adds the check
 *     that does the work here: it refuses to continue when the durable revision
 *     did not move, which catches an invocation whose writes cancelled out.
 *  2. **Nothing recovered a stale lease before acquiring one.** `run --attended`
 *     acquires directly; V3-05's `recoverStaleLease` existed only as a separate
 *     operator command, so a restart after a crash reported the dead run's lease
 *     and stopped rather than continuing the task.
 *  3. **The release result was discarded at every call site.** A `NOT_OWNER`
 *     with a quarantined record, or a `LEASE_REMOVE_FAILED`, left a file inside
 *     `.git` that no operator was ever told about.
 *
 *     Closed here for `run --attended`, and closed for the other two commands
 *     by V3-07 — `cli/block-command.ts` and `cli/release-command.ts` both keep
 *     and report the result now. What is still open is **this module's own
 *     `catch`**, which gives the lease back and has no result to attach one to,
 *     because on a throw there is no `LifecycleResult` to carry it. That is the
 *     whole of what `L-V3-06-7` still records.
 *
 * A fourth gap — waiting out a recorded quota reset — was **withdrawn from this
 * slice**, and the reason is in the authority model rather than in the
 * mechanism. See "What is deliberately absent" at the end of this header.
 *
 * ── Durable state is the authority between invocations ─────────────────────
 *
 * This layer keeps no model of the task. It does not remember what phase the
 * previous invocation ended in, and it never branches on `RunResult.state`.
 * Every invocation re-enters `runTask`, which loads the state from disk,
 * re-proves the lease against the file, reconciles against Git and decides
 * again. Three things cross an invocation boundary, and no more: the lease
 * evidence, which is re-proved against the file at every use; one state
 * *revision* string, used solely to refuse to continue when nothing moved; and
 * the auth preflight's artefact.
 *
 * That third one is a verdict carried forward, and it is named rather than
 * hidden. `evaluateAutomaticResume` brand-checks the evidence and applies no
 * freshness test, so a login proven at the first invocation still authorises the
 * last. It is the same lifetime `block --attended` has given it since V2-08 —
 * one preflight, one `--attended`, many `runTask` — so this widens nothing. An
 * earlier version of this paragraph said only two things crossed, which was
 * false.
 *
 * That last guard is this layer's own, and it exists because
 * `STEP_BUDGET_EXHAUSTED` is a *claim* of durable progress. `runTask` measures
 * progress inside one call by watching the revision move; across calls nobody
 * was watching. An invocation that returns `STEP_BUDGET_EXHAUSTED` while the
 * state file is byte-identical to the one the previous invocation left is a
 * loop that would spin forever, so it stops instead.
 *
 * ── Recovery is attempted only when acquisition refuses ────────────────────
 *
 * Not speculatively, and not from a separate assessment carried to a later
 * effect — that shape is what defeated the withdrawn `break` twice. The
 * ordinary acquisition already answers the question: it refuses with
 * `LEASE_HELD` when a *live* process holds the lease and with
 * `STALE_LEASE_RECOVERY_UNSAFE` when the holder is dead, unknowable, or the
 * artefact of a crash. Only the second one leads anywhere, only once, and only
 * when the operator asked for it.
 *
 * **Recovery grants nothing.** `recoverStaleLease` removes a dead object; it
 * does not make this process the writer. The acquisition that follows is the
 * ordinary one, through the same exclusive create as every other holder, and it
 * is allowed to lose — a successor that appeared in between wins, and this run
 * stops having executed nothing.
 *
 * ── One operator grant, many invocations: the existing contract ───────────
 *
 * `attendedContinuation` says an operator is present for *this invocation of the
 * command*. It has never meant "for one `runTask` call": `block --attended`
 * (V2-08) has driven a `for(;;)` loop over many tasks, each its own `runTask`,
 * under a single `--attended` since it shipped — `block/block-runner.ts` passes
 * `attendedContinuation: true` from inside that loop. This layer does the same
 * for one task, inside one foreground process the operator started and can stop.
 * So the loop below extends no authority; it reuses a scope the product already
 * has, and `--max-invocations` defaults to one, so the command drives a task
 * exactly as far as it did before. **Its report did change** — `cli/run-command.ts`
 * lists the four differences, none of which is a change to what runs.
 *
 * ── What is deliberately absent: the wait ─────────────────────────────────
 *
 * An earlier form of this module could sleep until `reportedResetAt` and then
 * carry on. It was withdrawn before review, because it could not be built
 * without extending an authority this product has not granted.
 *
 * The chain is short and it is decisive. `run-driver.ts` refuses **every**
 * continuation when `attendedContinuation` is false — including one
 * `evaluateAutomaticResume` has already allowed, because the grant is checked
 * before the resume write and can only withhold. So AO has no unattended
 * execution path at all today: the automatic-resume machinery decides
 * *eligibility*, and an operator being present is still required on top of it.
 *
 * That makes a wait unbuildable two ways at once. Keeping the grant across a
 * six-hour sleep uses a claim of operator presence hours after it was made,
 * which is the widening. Dropping the grant after the sleep makes the wait
 * pointless, because the resume it slept for is then refused too.
 *
 * A wait therefore needs a *third* authority — something like "may continue
 * without a human, but only where `classifyResume` already answered
 * `AUTOMATIC_ALLOWED`" — which would let an unattended run clear a quota pause
 * while still refusing ordinary in-flight work. That is a product-contract
 * decision, not a driver detail, so it is reported rather than implemented.
 * `BLOCKED_USAGE_LIMIT` stops this driver, exactly as it stops every other
 * caller today.
 */

import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import {
  acquireRepositoryExecutionLease,
  recoverStaleLease,
  releaseRepositoryExecutionLease,
  type LeaseAcquireFailureCode,
  type LeaseReleaseResult,
  type StaleLeaseRecoveryResult,
} from '../lease/execution-lease.js';
import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import { loadTaskState } from '../state/state-store.js';
import type { ReplaceFn, TempSuffixFn } from '../state/atomic-file.js';
import type { AgentRunner } from '../agent/agent-command.js';
import {
  mergePermissionDenials,
  NO_PERMISSION_DENIALS,
  type PermissionDenialObservation,
} from '../agent/agent-outcome.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import type { CompletionObserver } from '../loop/loop-step.js';
import type { GitRunner } from '../worktree/git-command.js';
import { startTask, type StartTaskResult } from './start-task.js';
import { runTask, type RunOutcome, type RunResult } from './run-driver.js';

/* ──────────────────────────── the outcome ───────────────────────────────── */

/**
 * How a lifecycle run ended. Closed, and deliberately wide for the same reason
 * `RUN_OUTCOMES` is: an operator reading one of these has to know which door to
 * open, and "it stopped" is not a door.
 *
 * Most members are the run driver's own outcome passed through unchanged rather
 * than folded into a summary. Folding is the tempting move here and it is the
 * wrong one — `BLOCKED_VERIFY` and `SCOPE_VIOLATION` are both "a human is
 * needed" and they are not the same errand.
 */
export const LIFECYCLE_OUTCOMES = [
  /* --- the lease, before anything ran ------------------------------------ */
  /**
   * A live process holds this repository's execution lease. Nothing was run,
   * nothing was recovered, and nothing waited for it.
   */
  'LIVE_OWNER_PRESENT',
  /**
   * A lease is present, acquisition refused it, and stale recovery was not
   * permitted for this run. The lease is untouched.
   */
  'STALE_LEASE_PRESENT',
  /** Recovery refused: it could not prove the lease dead and safely removable. */
  'RECOVERY_UNSAFE',
  /** The lease changed under the recovery. Nothing was removed. */
  'LEASE_CHANGED',
  /**
   * Recovery displaced something: a successor lease, or a record detached and
   * quarantined. An operator condition, never a retry signal.
   */
  'LEASE_DISPLACED',
  /** Recovery was permitted and failed. An operator condition. */
  'RECOVERY_FAILED',
  /**
   * Acquisition refused for a reason that is not a live owner: an unusable
   * location, an incoherent repository record, a filesystem that cannot support
   * the claim, or a successor that won the race after a recovery.
   */
  'LEASE_ACQUISITION_REFUSED',

  /* --- starting ---------------------------------------------------------- */
  /** `startTask` refused. Its own outcome is in `reasonCodes`. */
  'TASK_START_REFUSED',
  /** The auth preflight produced no evidence. Nothing was driven. */
  'AUTH_PREFLIGHT_FAILED',

  /* --- the run, passed through ------------------------------------------- */
  'COMPLETED',
  'TASK_ABORTED',
  'BLOCKED_USAGE_LIMIT',
  'BLOCKED_VERIFY',
  'BLOCKED_AUTH',
  'SCOPE_VIOLATION',
  'RESUME_STATE_DIVERGED',
  'HUMAN_DECISION_REQUIRED',
  'RECONCILIATION_DIVERGED',
  'RECONCILIATION_UNOBSERVABLE',
  'STATE_UNUSABLE',
  'TASK_NOT_STARTED',
  'STATE_CONFLICT',
  'STATE_NOT_RECORDED',
  'CONTINUATION_NOT_AUTHORISED',
  'EXECUTION_UNAUTHORISED',
  'EXECUTION_LEASE_NOT_HELD',
  'EXECUTION_LEASE_LOST',
  'NO_PROGRESS',

  /* --- this layer's own stops -------------------------------------------- */
  /**
   * Durable progress was still being made when this run's invocation budget ran
   * out. Everything is on disk; another lifecycle run continues.
   */
  'INVOCATION_BUDGET_EXHAUSTED',
  /**
   * The invocation bound itself is unusable. Nothing was taken and nothing ran.
   *
   * Its own member rather than the one above, because that one means "call
   * again" and this one means "calling again with the same argument repeats
   * forever". They are opposite instructions to a scheduler.
   */
  'INVOCATION_BUDGET_INVALID',
  /* --- the exit ---------------------------------------------------------- */
  /**
   * Everything above finished and the lease could not be given back provably.
   *
   * It replaces whatever outcome the run reached, which is the point: a clean
   * report plus an unexplained file inside `.git` is the combination this
   * member exists to make impossible. The outcome it replaced is kept in
   * `reasonCodes`, so nothing is lost by the override.
   */
  'LEASE_RELEASE_FAILED',
] as const;

export type LifecycleOutcome = (typeof LIFECYCLE_OUTCOMES)[number];

/**
 * Every run outcome's lifecycle spelling. Total, so a new `RunOutcome` cannot
 * be added without choosing one here.
 *
 * `satisfies` proves this map is complete and proves nothing at all about
 * whether any entry is *right*. **Exported for that reason**:
 * `tests/v3-06-lifecycle-driver.test.ts` compares it entry by entry against an
 * independently written table, which is the only thing that can catch a complete
 * map whose entries are wrong. The first version of that test built its own
 * table and never read this one, so every entry here could have been permuted
 * with the suite still green.
 */
export const LIFECYCLE_FOR_RUN = {
  TASK_COMPLETED: 'COMPLETED',
  TASK_ABORTED: 'TASK_ABORTED',
  BLOCKED_USAGE_LIMIT: 'BLOCKED_USAGE_LIMIT',
  BLOCKED_VERIFY: 'BLOCKED_VERIFY',
  BLOCKED_AUTH: 'BLOCKED_AUTH',
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  RESUME_STATE_DIVERGED: 'RESUME_STATE_DIVERGED',
  HUMAN_DECISION_REQUIRED: 'HUMAN_DECISION_REQUIRED',
  STATE_DIVERGED: 'RECONCILIATION_DIVERGED',
  STATE_UNOBSERVABLE: 'RECONCILIATION_UNOBSERVABLE',
  STATE_UNUSABLE: 'STATE_UNUSABLE',
  TASK_NOT_STARTED: 'TASK_NOT_STARTED',
  STATE_CONFLICT: 'STATE_CONFLICT',
  STATE_NOT_RECORDED: 'STATE_NOT_RECORDED',
  CONTINUATION_NOT_AUTHORISED: 'CONTINUATION_NOT_AUTHORISED',
  EXECUTION_UNAUTHORISED: 'EXECUTION_UNAUTHORISED',
  EXECUTION_LEASE_NOT_HELD: 'EXECUTION_LEASE_NOT_HELD',
  EXECUTION_LEASE_LOST: 'EXECUTION_LEASE_LOST',
  NO_PROGRESS: 'NO_PROGRESS',
  // Never reached *through this map*. The loop consumes `STEP_BUDGET_EXHAUSTED`
  // itself — it continues, or stops on the revision guard — and the budget stop
  // names its outcome literally. The entry keeps the map total and names the
  // outcome the loop does produce, so the two agree rather than sending a reader
  // looking for a difference.
  STEP_BUDGET_EXHAUSTED: 'INVOCATION_BUDGET_EXHAUSTED',
} as const satisfies Record<RunOutcome, LifecycleOutcome>;

/**
 * The acquisition refusals, spelled for an operator. Total over the acquire
 * vocabulary for the same reason.
 *
 * `STALE_LEASE_RECOVERY_UNSAFE` is **excluded from the key type**, not merely
 * omitted: whether it becomes `STALE_LEASE_PRESENT`, a recovery outcome or a
 * lost race depends on what happens next, and `takeLease` handles it before
 * reaching here. An earlier version called it "absent on purpose" while listing
 * it one line below — an unreachable entry under a comment denying it existed.
 * Excluding it from the type is the form of that statement the compiler keeps.
 */
const LIFECYCLE_FOR_ACQUIRE_FAILURE = {
  LEASE_HELD: 'LIVE_OWNER_PRESENT',
  LEASE_LOCATION_UNSUITABLE: 'LEASE_ACQUISITION_REFUSED',
  LEASE_LOCATION_NETWORK_UNSUPPORTED: 'LEASE_ACQUISITION_REFUSED',
  LEASE_LOCATION_DEVICE_NAMESPACE: 'LEASE_ACQUISITION_REFUSED',
  REPOSITORY_RECORD_INCOHERENT: 'LEASE_ACQUISITION_REFUSED',
  LEASE_WRITE_FAILED: 'LEASE_ACQUISITION_REFUSED',
  LEASE_FILESYSTEM_UNSUPPORTED: 'LEASE_ACQUISITION_REFUSED',
} as const satisfies Record<
  Exclude<LeaseAcquireFailureCode, 'STALE_LEASE_RECOVERY_UNSAFE'>,
  LifecycleOutcome
>;

/**
 * What each stale-recovery code means for a lifecycle run. Total.
 *
 * `RECOVERED` is not a stop and is not in the map — it is the only code that
 * continues, to an ordinary acquisition, and giving it a lifecycle spelling
 * here would invite a caller to treat recovery as an ending.
 */
const LIFECYCLE_FOR_RECOVERY_REFUSAL = {
  RECOVERY_UNSAFE: 'RECOVERY_UNSAFE',
  LEASE_CHANGED: 'LEASE_CHANGED',
  LEASE_DISPLACED: 'LEASE_DISPLACED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
} as const satisfies Record<
  Exclude<StaleLeaseRecoveryResult['code'], 'RECOVERED'>,
  LifecycleOutcome
>;

/* ──────────────────────────── the result ────────────────────────────────── */

export interface LifecycleResult {
  readonly outcome: LifecycleOutcome;
  readonly taskId: string;
  /**
   * The refusal the lease phase stopped on, or `null` when there was none.
   *
   * `null` is the *successful* case — the run took the lease — and every result
   * produced under a lease carries it. An earlier version of this sentence read
   * "null when acquisition was never reached", the exact opposite of what the
   * field means.
   */
  readonly acquire: LeaseAcquireFailureCode | null;
  /** The recovery this run attempted, or `null` when it attempted none. */
  readonly recovery: StaleLeaseRecoveryResult | null;
  /**
   * The result of giving the lease back, or `null` when no lease was ever held.
   *
   * **Never discarded, unlike every pre-existing call site.** A code other than
   * `RELEASED` means something is still sitting in `.git`.
   */
  readonly release: LeaseReleaseResult | null;
  /** The start attempt, or `null` when the lease phase stopped first. */
  readonly start: StartTaskResult | null;
  /** Every `runTask` this lifecycle ran, in order. Empty is a complete answer. */
  readonly runs: readonly RunResult[];
  /** How many times `runTask` was entered. */
  readonly invocations: number;
  /** Durable steps across every invocation. */
  readonly steps: number;
  /** Stable codes: the run outcome it stopped on, and the refusals beneath it. */
  readonly reasonCodes: readonly string[];
  /**
   * What the writing agent was refused, across every invocation.
   *
   * Aggregated with `mergePermissionDenials` rather than taken from the last
   * run, for the reason `RunResult` gives: the run that ends a lifecycle is
   * usually a verify or review pass whose own observation is `null`, so
   * last-writer-wins would drop the denials in exactly the case they matter.
   */
  readonly permissionDenials: PermissionDenialObservation;
}

/* ──────────────────────────── the inputs ────────────────────────────────── */

export interface LifecycleRequest {
  /** The repository, already resolved. This module resolves nothing. */
  readonly repository: ResolvedRepository;
  /**
   * The task to drive. Definite: this layer selects nothing.
   *
   * Selection stays with the caller because `selectNextTask` reads the
   * repository's own task files and its refusals are the plan's to report. A
   * driver that chose would be inventing the eligibility semantics
   * `run-driver.ts` refuses to invent.
   */
  readonly taskId: string;
  /**
   * The operator's grant to continue a task that reconciles but is not cleared
   * for unattended execution, forwarded verbatim to
   * `RunRequest.attendedContinuation`.
   *
   * **Not a widening**, though an earlier version of this doc called it "the one
   * contract widening in this slice". `attendedContinuation` has never meant
   * "one `runTask` call": it means an operator is present for this invocation of
   * the *command*, and `block --attended` has passed one grant to many `runTask`
   * calls since V2-08. This forwards it the same way, inside one foreground
   * process the operator started and can stop.
   *
   * It is still a human grant, it still cannot be inferred, it has no default,
   * and it still only ever narrows what runs: a *blocked* task moves on
   * `AUTOMATIC_ALLOWED` and on nothing else, whatever is set here.
   */
  readonly continuationGrant: boolean;
  /**
   * Whether this run may remove a lease it can prove is dead.
   *
   * Off is the safe answer and there is no default. When off, a stale lease
   * stops the run as `STALE_LEASE_PRESENT` and is left exactly as it was.
   */
  readonly recoverStaleLease: boolean;
  /** The step budget handed to each `runTask`. */
  readonly maxSteps: number;
  /**
   * The most times `runTask` may be entered. At least 1.
   *
   * The runaway guard for this layer, in the same spirit as `maxSteps` for the
   * one below it. It bounds a loop whose continue condition is a durable write
   * having happened, so exhausting it is progress, not failure.
   */
  readonly maxInvocations: number;
}

export interface LifecycleDependencies {
  /** The clock. Read per durable write, never frozen for the run. */
  readonly now: () => string;
  /** Git. Required and never defaulted, so a test never reaches a real repository. */
  readonly git: GitRunner;
  /**
   * The auth preflight, run at most once for the whole lifecycle run.
   *
   * `onceOnlyPreflight`'s own shape, unchanged: the subscription CLIs start once
   * and a failure is remembered rather than retried. One per run rather than one
   * per invocation because the run is one process, and asking twice would start
   * the real CLIs twice to answer a question already answered.
   */
  readonly authPreflight: () => Promise<AuthPreflightEvidence | null>;
  /** Execution seams, forwarded to the run driver. */
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
  readonly observe?: CompletionObserver;
  /**
   * Filesystem and state-store seams, forwarded to `runTask` — and to nothing
   * else. `startTask` performs a durable write of its own and does not receive
   * them, so no injected `replace` reaches the first state a task ever gets.
   * Production supplies neither, so this bounds what a test can reach rather
   * than what the product does.
   */
  readonly exists?: (path: string) => boolean;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

/** The durable revision, or `null` when the state cannot be read. */
function revisionOf(repositoryRoot: string, taskId: string): string | null {
  const load = loadTaskState(repositoryRoot, taskId);
  return load.ok ? load.revision : null;
}

/* ──────────────────────────── the driver ────────────────────────────────── */

interface LeasePhaseHeld {
  readonly held: true;
  readonly evidence: ExecutionLeaseEvidence;
  readonly acquire: LeaseAcquireFailureCode | null;
  readonly recovery: StaleLeaseRecoveryResult | null;
}

interface LeasePhaseRefused {
  readonly held: false;
  readonly outcome: LifecycleOutcome;
  readonly acquire: LeaseAcquireFailureCode | null;
  readonly recovery: StaleLeaseRecoveryResult | null;
  readonly reasonCodes: readonly string[];
}

/**
 * Take the lease, recovering a provably dead one at most once on the way.
 *
 * The order is the contract: acquire, and only on the *one* refusal that can
 * mean "the holder is gone" try a recovery, and then acquire again through the
 * ordinary path. There is no third attempt, because a second failure to acquire
 * after a successful removal means somebody else is there now — an answer, not
 * a transient.
 */
function takeLease(
  request: LifecycleRequest,
  deps: LifecycleDependencies,
): LeasePhaseHeld | LeasePhaseRefused {
  const { repository } = request;
  const acquireOnce = (): ReturnType<typeof acquireRepositoryExecutionLease> =>
    acquireRepositoryExecutionLease(repository, { runId: null, blockId: null }, { now: deps.now });

  const first = acquireOnce();
  if (first.ok) {
    return { held: true, evidence: first.evidence, acquire: null, recovery: null };
  }

  if (first.code !== 'STALE_LEASE_RECOVERY_UNSAFE') {
    return {
      held: false,
      outcome: LIFECYCLE_FOR_ACQUIRE_FAILURE[first.code],
      acquire: first.code,
      recovery: null,
      reasonCodes: [first.code],
    };
  }

  if (!request.recoverStaleLease) {
    return {
      held: false,
      outcome: 'STALE_LEASE_PRESENT',
      acquire: first.code,
      recovery: null,
      reasonCodes: [first.code, 'STALE_RECOVERY_NOT_PERMITTED'],
    };
  }

  // Proves everything itself, from its own liveness probe and its own reading of
  // the bytes. Nothing measured above is handed to it, and nothing it reports is
  // treated as authority below.
  const recovery = recoverStaleLease(repository);
  if (recovery.code !== 'RECOVERED') {
    return {
      held: false,
      outcome: LIFECYCLE_FOR_RECOVERY_REFUSAL[recovery.code],
      acquire: first.code,
      recovery,
      reasonCodes: [
        first.code,
        recovery.code,
        ...(recovery.refusal !== null ? [recovery.refusal] : []),
      ],
    };
  }

  // Removing a dead object granted nothing. This is the ordinary acquisition,
  // and it is allowed to lose.
  const second = acquireOnce();
  if (second.ok) {
    return { held: true, evidence: second.evidence, acquire: null, recovery };
  }

  return {
    held: false,
    // A successor after a successful removal is a race lost, never a stale lease
    // to recover again — so `STALE_LEASE_RECOVERY_UNSAFE` is spelled as a refused
    // acquisition here rather than reusing the table's `STALE_LEASE_PRESENT`,
    // which would invite a retry.
    outcome:
      second.code === 'LEASE_HELD' ? 'LIVE_OWNER_PRESENT' : 'LEASE_ACQUISITION_REFUSED',
    acquire: second.code,
    recovery,
    reasonCodes: ['RECOVERED', second.code, 'ACQUISITION_AFTER_RECOVERY_LOST'],
  };
}

function lifecycleResult(
  from: Partial<LifecycleResult> & {
    readonly outcome: LifecycleOutcome;
    readonly taskId: string;
  },
): LifecycleResult {
  return Object.freeze({
    acquire: null,
    recovery: null,
    release: null,
    start: null,
    runs: Object.freeze([]),
    invocations: 0,
    steps: 0,
    reasonCodes: Object.freeze([]),
    permissionDenials: NO_PERMISSION_DENIALS,
    ...from,
  });
}

/**
 * Drives one task, across as many invocations as it takes, under one lease.
 *
 * Never throws for an expected condition. Every refusal arrives as data.
 */
export async function driveLifecycle(
  request: LifecycleRequest,
  deps: LifecycleDependencies,
): Promise<LifecycleResult> {
  const { taskId } = request;

  if (!Number.isSafeInteger(request.maxInvocations) || request.maxInvocations < 1) {
    return lifecycleResult({
      outcome: 'INVOCATION_BUDGET_INVALID',
      taskId,
      reasonCodes: ['MAX_INVOCATIONS_INVALID'],
    });
  }

  const lease = takeLease(request, deps);
  if (!lease.held) {
    return lifecycleResult({
      outcome: lease.outcome,
      taskId,
      acquire: lease.acquire,
      recovery: lease.recovery,
      reasonCodes: lease.reasonCodes,
    });
  }

  return await driveUnderLease(request, deps, lease.evidence, lease.recovery);
}

/**
 * The drive itself, with the lease established, plus the release that ends it.
 *
 * ── Two releases, and both are needed ──────────────────────────────────────
 *
 * A controlled exit releases through `finish`, which keeps the result: that is
 * the whole point of the slice, because every pre-existing call site called
 * `releaseRepositoryExecutionLease` inside a `finally` and threw the answer
 * away, leaving a quarantined record invisible.
 *
 * A `finally` alone cannot do that — it cannot contribute to the value it wraps
 * — but removing it is not the answer either, and an earlier version of this
 * module did remove it. That was a regression against `run --attended` as it
 * shipped: its `finally` released "on every path out, including a throw", and
 * dropping it meant an exception from `startTask`, the preflight or `runTask`
 * left this process holding the lease **while still alive**. A live holder is
 * refused by acquisition and refused by stale recovery, so the repository would
 * be locked out until the process exited — worse than the crash case, which at
 * least leaves a dead owner something can prove.
 *
 * So both exist and they cannot double-release: `finish` records that it ran,
 * and the `catch` releases only when it did not, then rethrows unchanged.
 */
async function driveUnderLease(
  request: LifecycleRequest,
  deps: LifecycleDependencies,
  evidence: ExecutionLeaseEvidence,
  recovery: StaleLeaseRecoveryResult | null,
): Promise<LifecycleResult> {
  const { repository, taskId } = request;

  const runs: RunResult[] = [];
  let permissionDenials = NO_PERMISSION_DENIALS;
  let invocations = 0;
  let steps = 0;
  let start: StartTaskResult | null = null;
  // Whether the lease has already been given back. Read only by the `catch`
  // below, so that the safety net cannot release a second time.
  let releaseAttempted = false;

  /**
   * Ends the run: gives the lease back, and lets a failure to do so replace the
   * outcome rather than sit beside it.
   */
  const finish = (outcome: LifecycleOutcome, extra: readonly string[] = []): LifecycleResult => {
    // The flag is set **after** the call returns, never before. Setting it first
    // meant a release that threw disarmed the safety net below: the `catch`
    // would read "already attempted", skip its own release, and rethrow —
    // leaving this live process holding the lease, which is the exact condition
    // that net exists to prevent.
    const release = releaseRepositoryExecutionLease(evidence);
    releaseAttempted = true;
    const released = release.code === 'RELEASED';
    // The reached outcome is kept, demoted to a reason code, and put **first**
    // — the operator sentence for `LEASE_RELEASE_FAILED` says the first code is
    // the outcome the run actually reached, and it has to be true. Appending it
    // instead left the run's own reasons in front of it on every path that had
    // any, which is every path but two.
    const codes = released
      ? [...extra]
      : [outcome, release.code, ...(release.detail !== null ? [release.detail] : []), ...extra];
    return lifecycleResult({
      outcome: released ? outcome : 'LEASE_RELEASE_FAILED',
      taskId,
      acquire: null,
      recovery,
      release,
      start,
      runs: Object.freeze([...runs]),
      invocations,
      steps,
      reasonCodes: Object.freeze(codes),
      permissionDenials,
    });
  };

  try {
    start = await startTask(
      { repository, taskId },
      { git: deps.git, now: deps.now, authPreflight: deps.authPreflight, lease: evidence },
    );
    // The three outcomes that leave a durable state to drive.
    //
    // `ADOPTED` is among them, and `run --attended` refusing it was an anomaly
    // rather than a policy: `startTask` returns it only after proving a pristine
    // orphan worktree is this task's own and writing the first durable state, so
    // by then the task *is* started. `block --attended` has driven it since
    // V2-06A — `tests/v2-08-attended-block-runner.test.ts` maps `ADOPTED` to
    // `DRIVE`. Refusing it here produced the worst possible report for the exact
    // case this slice exists for: a crash-restart that adopted a workspace, wrote
    // state, drove nothing, printed "the task could not be started or adopted",
    // and exited 0.
    if (
      start.outcome !== 'STARTED' &&
      start.outcome !== 'ALREADY_STARTED' &&
      start.outcome !== 'ADOPTED'
    ) {
      return finish('TASK_START_REFUSED', [start.outcome]);
    }

    // The revision the previous invocation left behind, used only to refuse to
    // continue when an invocation claimed progress and the file did not move.
    let previousRevision: string | null = null;

    for (;;) {
      if (invocations >= request.maxInvocations) {
        // No reason codes, and there are none to be had. The loop continues only
        // on `STEP_BUDGET_EXHAUSTED`, and `run-driver.ts` returns that outcome
        // with the default empty `reasonCodes` — so every invocation this stop
        // could inherit from carries nothing. Threading `runs.at(-1)` through
        // here reads as recovering information and recovers none; it was written
        // that way for one round and measured to be a no-op.
        return finish('INVOCATION_BUDGET_EXHAUSTED');
      }

      // On `ALREADY_STARTED` the preflight has not run yet, because `startTask`
      // returned before reaching it. Auth is a requirement of *executing* rather
      // than of starting, so it is proven here, on every path that is about to
      // drive. Memoised, so later invocations pay nothing.
      const authEvidence = await deps.authPreflight();
      if (authEvidence === null) return finish('AUTH_PREFLIGHT_FAILED');

      invocations += 1;
      const run = await runTask(
        {
          repository,
          taskId,
          attendedContinuation: request.continuationGrant,
          authEvidence,
          lease: evidence,
          maxSteps: request.maxSteps,
        },
        {
          now: deps.now,
          git: deps.git,
          ...(deps.exists !== undefined ? { exists: deps.exists } : {}),
          ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
          ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
          ...(deps.observe !== undefined ? { observe: deps.observe } : {}),
          ...(deps.replace !== undefined ? { replace: deps.replace } : {}),
          ...(deps.tempSuffix !== undefined ? { tempSuffix: deps.tempSuffix } : {}),
        },
      );
      runs.push(run);
      steps += run.steps;
      permissionDenials = mergePermissionDenials(permissionDenials, run.permissionDenials);

      if (run.outcome === 'STEP_BUDGET_EXHAUSTED') {
        // A fail-closed floor, and **unreachable today** — which is stated here
        // rather than left for a reader to assume it is load-bearing.
        //
        // `run-driver.ts:472` refuses a `maxSteps` below one, so any run that
        // reaches the budget stop completed at least one iteration, and every
        // iteration that does not stop early performs a durable write. So
        // `STEP_BUDGET_EXHAUSTED` implies `steps >= 1`, the mutant that deletes
        // this branch survives the suite, and the test below pins the refusal
        // that makes it unreachable instead of pretending to reach it.
        //
        // It is kept because `block-runner.ts` carries the identical floor for
        // the identical loop, and because a change to the budget guard one
        // module over would otherwise turn a nothing-invocation into a spin
        // silently. An earlier version of this comment claimed it "covers the
        // first invocation, which the revision comparison cannot" — there is
        // nothing to cover there: the first invocation provably wrote.
        if (run.steps === 0) {
          return finish('NO_PROGRESS', [...run.reasonCodes, 'NO_DURABLE_STEP']);
        }
        // The second is this layer's own. The outcome claims durable progress, so
        // check the file rather than believe it: an invocation whose writes
        // cancelled out reports steps and moves nothing.
        const revision = revisionOf(repository.root, taskId);
        if (revision === null) {
          return finish('STATE_UNUSABLE', [...run.reasonCodes, 'DURABLE_STATE_UNREADABLE']);
        }
        if (previousRevision !== null && revision === previousRevision) {
          return finish('NO_PROGRESS', [...run.reasonCodes, 'DURABLE_STATE_UNCHANGED']);
        }
        previousRevision = revision;
        continue;
      }

      return finish(LIFECYCLE_FOR_RUN[run.outcome], run.reasonCodes);
    }
  } catch (error: unknown) {
    // The safety net `run --attended` had before V3-06, restored. Reaching here
    // means either that no controlled exit ran, or that the release inside one
    // threw before it could set the flag. Both leave this **live** process
    // holding the lease, and a live holder is refused by acquisition and by
    // stale recovery alike.
    //
    // The retry is wrapped, because it can be the thing that threw. A second
    // failure is swallowed rather than allowed to replace `error`: the original
    // is what an operator needs, and there is nowhere to report a release result
    // on this path anyway (`L-V3-06-7`). The error is rethrown exactly as it
    // arrived, because swallowing it would turn a crash into a silent success.
    if (!releaseAttempted) {
      try {
        releaseRepositoryExecutionLease(evidence);
      } catch {
        // Nothing further to try, and nothing to report it through.
      }
    }
    throw error;
  }
}
