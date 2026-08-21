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
 * missing, which is four things and no more:
 *
 *  1. **Nothing acted on `STEP_BUDGET_EXHAUSTED`.** It is documented as the one
 *     outcome meaning "call again", and no caller ever called again.
 *  2. **Nothing recovered a stale lease before acquiring one.** `run --attended`
 *     acquires directly; V3-05's `recoverStaleLease` existed only as a separate
 *     operator command, so a restart after a crash reported the dead run's lease
 *     and stopped rather than continuing the task.
 *  3. **The release result was discarded at every call site.** A `NOT_OWNER`
 *     with a quarantined record, or a `LEASE_REMOVE_FAILED`, left a file inside
 *     `.git` that no operator was ever told about.
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
 * again. The only things carried across an invocation boundary are the lease
 * evidence — which is re-proved at every use anyway — and one state *revision*
 * string, used solely to refuse to continue when nothing moved.
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
 * has, and `--max-invocations` defaults to one so the CLI's behaviour is
 * unchanged unless an operator asks otherwise.
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
 * whether any entry is *right*; `tests/v3-06-lifecycle-driver.test.ts` asserts
 * the meanings one by one.
 */
const LIFECYCLE_FOR_RUN = {
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
  // Reached only when the invocation budget is what stopped the loop: the
  // continue path consumes this outcome and never returns it.
  STEP_BUDGET_EXHAUSTED: 'INVOCATION_BUDGET_EXHAUSTED',
} as const satisfies Record<RunOutcome, LifecycleOutcome>;

/**
 * The acquisition refusals, spelled for an operator. Total over the acquire
 * vocabulary for the same reason.
 *
 * `STALE_LEASE_RECOVERY_UNSAFE` is absent on purpose: it is the one code this
 * module does not translate directly, because whether it becomes
 * `STALE_LEASE_PRESENT`, a recovery outcome, or a lost race depends on what
 * happens next.
 */
const LIFECYCLE_FOR_ACQUIRE_FAILURE = {
  LEASE_HELD: 'LIVE_OWNER_PRESENT',
  STALE_LEASE_RECOVERY_UNSAFE: 'STALE_LEASE_PRESENT',
  LEASE_LOCATION_UNSUITABLE: 'LEASE_ACQUISITION_REFUSED',
  LEASE_LOCATION_NETWORK_UNSUPPORTED: 'LEASE_ACQUISITION_REFUSED',
  LEASE_LOCATION_DEVICE_NAMESPACE: 'LEASE_ACQUISITION_REFUSED',
  REPOSITORY_RECORD_INCOHERENT: 'LEASE_ACQUISITION_REFUSED',
  LEASE_WRITE_FAILED: 'LEASE_ACQUISITION_REFUSED',
  LEASE_FILESYSTEM_UNSUPPORTED: 'LEASE_ACQUISITION_REFUSED',
} as const satisfies Record<LeaseAcquireFailureCode, LifecycleOutcome>;

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
   * How the lease was obtained, or why it was not. `null` when acquisition was
   * never reached, which cannot currently happen — the lease phase is first.
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
   * **This is the one contract widening in this slice, and it is deliberate.**
   * Until now the grant was per *invocation* of `run --attended`. Here one
   * human act — launching this lifecycle run — covers every invocation it
   * makes, which is what "continue this task without me until it stops" has to
   * mean if it is to mean anything. It is still a human grant, it still cannot
   * be inferred, it has no default, and it still only ever narrows what runs:
   * a *blocked* task moves on `AUTOMATIC_ALLOWED` and on nothing else, whatever
   * is set here.
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
  /** The clock. Read per write and per wait decision, never frozen for the run. */
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
  /** Filesystem and state-store seams, forwarded down. */
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

  if (!Number.isInteger(request.maxInvocations) || request.maxInvocations < 1) {
    return lifecycleResult({
      outcome: 'INVOCATION_BUDGET_EXHAUSTED',
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

  // Deliberately not wrapped in a `finally` that releases and discards: the
  // release result is part of the answer, and that discard is the pre-existing
  // defect this slice closes. `driveUnderLease` releases on every controlled
  // exit and reports what happened. An unexpected throw leaves the lease behind
  // for stale recovery, which is the case V3-05 exists for.
  return await driveUnderLease(request, deps, lease.evidence, lease.recovery);
}

/**
 * The drive itself, with the lease established, plus the release that ends it.
 *
 * The release is here rather than in a `finally` above because its outcome has
 * to reach the caller. A `finally` that released and discarded is precisely the
 * pre-existing defect this slice closes. Every path out of the loop below is a
 * *controlled* exit and passes through `finish`; an unexpected throw is a
 * different case, and Slice 1-5 containment and stale recovery own it.
 */
async function driveUnderLease(
  request: LifecycleRequest,
  deps: LifecycleDependencies,
  evidence: ExecutionLeaseEvidence,
  recovery: StaleLeaseRecoveryResult | null,
): Promise<LifecycleResult> {
  const { repository, taskId } = request;

  const runs: RunResult[] = [];
  const reasonCodes: string[] = [];
  let permissionDenials = NO_PERMISSION_DENIALS;
  let invocations = 0;
  let steps = 0;
  let start: StartTaskResult | null = null;

  /**
   * Ends the run: gives the lease back, and lets a failure to do so replace the
   * outcome rather than sit beside it.
   */
  const finish = (outcome: LifecycleOutcome, extra: readonly string[] = []): LifecycleResult => {
    const release = releaseRepositoryExecutionLease(evidence);
    const codes = [...reasonCodes, ...extra];
    const released = release.code === 'RELEASED';
    if (!released) {
      // The reached outcome is kept, demoted to a reason code. An operator needs
      // both facts and the leftover is the one that will not resolve itself.
      codes.push(outcome, release.code, ...(release.detail !== null ? [release.detail] : []));
    }
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

  start = await startTask(
    { repository, taskId },
    { git: deps.git, now: deps.now, authPreflight: deps.authPreflight, lease: evidence },
  );
  // Exactly the pair `run --attended` accepts today. `ADOPTED` is not among them
  // there and is not here either; widening it would be a separate decision.
  if (start.outcome !== 'STARTED' && start.outcome !== 'ALREADY_STARTED') {
    return finish('TASK_START_REFUSED', [start.outcome]);
  }

  // The revision the previous invocation left behind, used only to refuse to
  // continue when an invocation claimed progress and the file did not move.
  let previousRevision: string | null = null;

  for (;;) {
    if (invocations >= request.maxInvocations) return finish('INVOCATION_BUDGET_EXHAUSTED');

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
      // The outcome claims durable progress. Check the file rather than believe
      // it: an invocation that moved nothing would be repeated forever.
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
}
