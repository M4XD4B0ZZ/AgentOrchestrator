/**
 * The bounded quota-reset wait for ONE named task, and the only path on which AO
 * runs an agent under the `AUTOMATIC_RESUME_ONLY` grant (V3-08).
 *
 * The sentence here used to read "the only unattended path on which AO runs an
 * AGENT", which M3-01 made false: `repositories --attended --wait-for-reset`
 * runs agents hours after the operator walked away. That one is a different
 * claim — it carries the ordinary attended grant and this one does not — so the
 * distinction is spelled by the grant rather than by the word "unattended".
 *
 * ── What this module is, in one sentence ───────────────────────────────────
 *
 * A thin controller **above** `driveLifecycle` that may, at most once per
 * command invocation, sleep until a reported quota reset has passed and then
 * start a completely new lifecycle epoch — carrying no authority and no evidence
 * across the sleep, only the task id, the grant, the bound and a counter.
 *
 * "Holding nothing except" was too strong and is retracted: the first epoch's
 * `LifecycleResult` stays in `epochs` across the `await`, because the report
 * prints both attempts. It is retained for reporting and never consulted —
 * nothing kept from before the wait authorises anything after it.
 *
 * ── Why above, and not inside ──────────────────────────────────────────────
 *
 * The hard invariant is: **no execution lease may be held across the wait.** A
 * reset can be hours away. The lease is the repository's single writer slot, and
 * a process asleep inside `driveUnderLease` holds it for the whole sleep —
 * refusing every other invocation, and refusing stale recovery too, because a
 * sleeping owner really is alive. So the layering is:
 *
 *     epoch 1: driveLifecycle  → acquire → drive → BLOCKED_USAGE_LIMIT → release
 *     here   : read the result, prove RELEASED, sleep holding no lease
 *     epoch 2: driveLifecycle  → acquire again, ordinarily → drive → release
 *
 * `driveLifecycle` keeps one job and keeps it whole; this module never reaches
 * inside it, never takes a lease of its own, and never writes state.
 *
 * ── Nothing before the sleep is authority after it ─────────────────────────
 *
 * Everything the second epoch acts on is established again, from scratch:
 *
 *  - the repository is **re-resolved** (`deps.resolveRepository`), because a
 *    `ResolvedRepository` is a reading of a profile and a root taken hours ago,
 *    not a standing fact. The first epoch's object is deliberately not reused,
 *    and the fresh identity is then compared against durable state by the
 *    ordinary reconciliation, which is the component that owns that comparison;
 *  - the execution lease is acquired again through the ordinary path, which is
 *    allowed to lose;
 *  - the auth preflight is run again. `deps.authPreflight` is a **factory**
 *    rather than a memoised function for exactly this reason: each epoch gets
 *    its own once-only preflight, so attended runs keep the one-preflight-per-
 *    command semantics they have always had, and a login that expired during a
 *    six-hour sleep is caught rather than assumed (`AuthPreflightEvidence`
 *    carries no timestamp and never has — see its module header);
 *  - the durable state is loaded again, Git is observed again, reconciliation
 *    runs again, and `classifyResume` produces a **new** `ResumeDecision`.
 *
 * The pre-sleep decision is used for exactly one thing — deciding whether to
 * sleep — and for nothing afterwards. In particular the arithmetic that chooses
 * the sleep length is never treated as proof that the reset has passed:
 * `evaluateAutomaticResume` refuses while `now <= reportedResetAt`, and the
 * post-wake epoch re-runs that policy from a fresh clock reading. A timer that
 * fires a millisecond early simply produces a second `RESET_TIME_NOT_REACHED`.
 *
 * ── One cycle, never a daemon ──────────────────────────────────────────────
 *
 * At most one sleep per call, unconditionally, by construction rather than by a
 * counter that could be miscounted: there is no loop in this file. A second
 * quota block after a successful automatic resume ends the run. Recurring
 * operation belongs to a layer above this one, and since M3-01 that layer
 * exists: `schedule/scheduler.ts` waits between cross-repository coordinator
 * passes. It never reaches inside this module, and this module still has no
 * loop.
 *
 * ── What this module deliberately cannot do ────────────────────────────────
 *
 *  - **Start a task.** The grant is fixed at `AUTOMATIC_RESUME_ONLY` here, and
 *    `lifecycle-driver.ts` refuses to reach `startTask` under it.
 *  - **Recover a stale lease.** `recoverStaleLease` is fixed at `false`, so an
 *    operator's destructive permission can never be carried across hours of
 *    sleep. If another writer — live or dead — owns the repository when this
 *    wakes, the run stops.
 *  - **Choose a different task.** The task id crosses the sleep and nothing
 *    else about the task does. If the target became terminal, or was resumed by
 *    somebody else and is now ordinary in-flight work, the second epoch reports
 *    that and runs nothing. There is no queue and no next-task selection.
 *  - **Re-implement any policy.** Whether the block cleared, whether the
 *    worktree is clean, whether auth passed — every one of those is
 *    `evaluateAutomaticResume`'s to answer, reached through the ordinary
 *    `runTask` path. This module reads the decision that machinery already
 *    produced; the *only* judgement it makes of its own is "was the reported
 *    reset time the single thing standing in the way", and that is a test on
 *    the canonical decision's own reason codes, not a re-derivation of them.
 */

import type { LeaseReleaseResult } from '../lease/execution-lease.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import type { McpPreflightFactory } from '../agent/mcp-capability-preflight.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import {
  driveLifecycle,
  type LifecycleDependencies,
  type LifecycleOutcome,
  type LifecycleResult,
} from './lifecycle-driver.js';

/* ──────────────────────────── the wait policy ───────────────────────────── */

/**
 * Whether this invocation may wait, and for how long at most.
 *
 * A discriminated union rather than `{ wait: boolean; maxWaitMs?: number }`, so
 * that "wait with no bound" is not a value anybody can construct. There is no
 * default duration anywhere in this module: a multi-hour sleep invented by a
 * default is a multi-hour sleep nobody asked for.
 */
export type ResetWaitPolicy =
  | { readonly wait: false }
  | { readonly wait: true; readonly maxWaitMs: number };

/**
 * The largest wait this build will accept, in milliseconds: 24 hours.
 *
 * Two reasons, and the second is a real trap rather than a preference. A
 * subscription quota window is measured in hours, so a bound beyond a day is
 * describing something other than a quota reset. And Node's timer takes a signed
 * 32-bit delay: a `setTimeout` above 2_147_483_647 ms does not sleep longer, it
 * warns and fires **immediately**, which would turn "wait a week" into "do not
 * wait at all" while reporting a wait. The ceiling keeps every accepted value
 * far below that edge.
 */
export const MAX_WAIT_MS_CEILING = 24 * 60 * 60 * 1000;

/** `true` for a bound this build will sleep on. Total, and fail-closed. */
export function isUsableWaitBound(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_WAIT_MS_CEILING;
}

/* ──────────────────────────── the wait report ───────────────────────────── */

/**
 * What the wait controller did, and — when it did not wait — why.
 *
 * A closed vocabulary, and deliberately a wide one, for the reason
 * `RUN_OUTCOMES` is wide: "you never asked to wait", "the reset time was
 * missing", "the reset is further away than you allowed" and "the lease could
 * not be given back" are four different things to be told, and an operator
 * reading one of them has to know which.
 *
 * These are **not** task states. Nothing here is persisted; the durable truth
 * while this process sleeps is `BLOCKED_USAGE_LIMIT`, exactly as it was before,
 * and a process that dies mid-sleep leaves a correctly parked task behind.
 */
export const RESET_WAIT_DISPOSITIONS = [
  /** The run did not stop on a quota block, so no wait was ever in question. */
  'NOT_A_QUOTA_BLOCK',
  /** A quota block, and `--wait-for-reset` was not given. Waiting is opt-in. */
  'NOT_REQUESTED',
  /**
   * The run stopped on a quota block that carries no automatic-resume verdict,
   * so there is nothing canonical to read and nothing is interpreted.
   *
   * **Ordinary, not a defect**, and an earlier version of this comment and of
   * `L-V3-08-4` both called it unreachable. It is the shape of "this run
   * resumed the task, did some work, and hit the quota again": `RunResult.resume`
   * is the decision taken at the *top* of the last iteration, which was about
   * the in-flight state the step then blocked from — and `classifyResume`
   * returns `automaticResume: null` for every non-blocking state. The new block
   * is durable and correct; nobody has judged it yet, and the next invocation
   * will.
   */
  'RESUME_DECISION_ABSENT',
  /** The reset time has passed and something *else* refused the resume. */
  'RESUME_DENIED_BY_OTHER_CHECKS',
  /** The state records no reported reset time. There is nothing to wait for. */
  'RESET_TIME_MISSING',
  /** The recorded reset time is not a timestamp this build can read. */
  'RESET_TIME_UNPARSEABLE',
  /** The clock produced something that is not a timestamp. */
  'CURRENT_TIME_UNPARSEABLE',
  /** The reset is further away than `--max-wait-ms` permitted. */
  'BOUND_EXCEEDED',
  /**
   * `--max-wait-ms` is not a bound this build will sleep on at all.
   *
   * Its own member rather than {@link BOUND_EXCEEDED}, because the two are
   * opposite instructions: that one means "the reset is far away, raise the
   * bound or come back later", and this one means "the number you gave is not
   * usable, and raising it is not the fix". A review found both reported under
   * one name, with a sentence telling an operator to raise a bound of `NaN`.
   */
  'WAIT_BOUND_UNUSABLE',
  /**
   * The lease was not provably given back before the sleep. Nothing slept: a
   * waiter that cannot prove it released may still be holding the repository.
   */
  'LEASE_RELEASE_UNPROVEN',
  /** The invocation budget was spent by the first epoch. Nothing slept. */
  'INVOCATION_BUDGET_SPENT',
  /**
   * Slept, woke, and could not resolve the repository again. Nothing was
   * acquired and nothing ran.
   */
  'REPOSITORY_UNRESOLVED_AFTER_WAIT',
  /** Slept once and ran a second lifecycle epoch. */
  'WAITED',
] as const;

export type ResetWaitDisposition = (typeof RESET_WAIT_DISPOSITIONS)[number];

export interface ResetWaitReport {
  readonly disposition: ResetWaitDisposition;
  /** How long this run actually slept, or `null` when it did not sleep. */
  readonly waitedMs: number | null;
  /**
   * Stable codes behind the disposition — the canonical automatic-resume reason
   * codes when a resume was judged, the release code when the release was not
   * proven. Empty when the disposition says everything.
   */
  readonly reasonCodes: readonly string[];
}

/* ──────────────────────────── the result ────────────────────────────────── */

export interface UnattendedResumeResult {
  /**
   * The outcome of the **last** epoch that ran, or the controller's own refusal
   * when no epoch ran at all.
   *
   * A `LifecycleOutcome` rather than a new vocabulary, deliberately: everything
   * that can happen to an unattended resume already has a lifecycle spelling and
   * already has an exit code, and a parallel set of names would give an operator
   * two words for one condition. What the wait adds is reported beside it, in
   * {@link wait}, which is a different question.
   */
  readonly outcome: LifecycleOutcome;
  readonly taskId: string;
  /** Every lifecycle epoch this call ran, in order. One, or two. */
  readonly epochs: readonly LifecycleResult[];
  readonly wait: ResetWaitReport;
}

/* ──────────────────────────── the inputs ────────────────────────────────── */

export interface UnattendedResumeRequest {
  /** The repository, already resolved — for the **first** epoch only. */
  readonly repository: ResolvedRepository;
  /** The one task this call may continue. Definite: nothing here selects. */
  readonly taskId: string;
  /** The step budget handed to each `runTask`. */
  readonly maxSteps: number;
  /**
   * The most times `runTask` may be entered **across the whole call**, both
   * epochs together.
   *
   * Shared rather than per-epoch, because `--max-invocations` is the operator's
   * bound on one command invocation and a wait does not make it two commands.
   * The first epoch spends at least one on the invocation that met the quota
   * block, so a wait needs at least two — asked for explicitly, and refused
   * before any effect when it is not there, rather than quietly given a second
   * budget under another name.
   */
  readonly maxInvocations: number;
  readonly wait: ResetWaitPolicy;
}

export interface UnattendedResumeDependencies
  extends Omit<LifecycleDependencies, 'authPreflight' | 'mcpPreflight'> {
  /**
   * A **factory** for the auth preflight, called once per lifecycle epoch.
   *
   * Not the preflight itself. `onceOnlyPreflight` memoises, which is right
   * within one epoch — the subscription CLIs are expensive and a failure inside
   * one invocation should not be retried — and wrong across a sleep, because
   * the artefact carries no freshness and would let a login proven before a
   * six-hour wait authorise the resume after it. Resetting the memoisation at
   * the epoch boundary is the whole mechanism: attended runs are untouched, and
   * the post-wake epoch pays for a real preflight.
   */
  readonly authPreflight: () => () => Promise<AuthPreflightEvidence | null>;
  /**
   * A **factory** for the capability preflight, on exactly the terms above.
   *
   * The reasoning transfers without change: a granted MCP server that answered
   * before a six-hour wait is not evidence that it answers after one, and the
   * epoch boundary is where that memo is reset (M5).
   */
  readonly mcpPreflight: () => McpPreflightFactory;
  /**
   * Resolves the repository again, after the wait. `null` when it cannot be.
   *
   * A seam rather than a direct call so that this module performs no path
   * handling of its own: the caller already knows which repository path the
   * operator named, and re-deriving it here would be a second answer to a
   * question `resolveRepository` owns.
   */
  readonly resolveRepository: () => Promise<ResolvedRepository | null>;
  /** The sleep. Injected so a test can wait deterministically and instantly. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/* ──────────────────────────── the decision ──────────────────────────────── */

/**
 * The sole reason code that a wait is allowed to be waiting for.
 *
 * Named once, here, because the whole eligibility test is "this code and no
 * other". A denial list containing it *and* `WORKTREE_NOT_CLEAN` describes a
 * task no amount of sleeping will help.
 */
const RESET_TIME_NOT_REACHED = 'RESET_TIME_NOT_REACHED';

interface WaitRefused {
  readonly sleep: false;
  readonly report: ResetWaitReport;
}

interface WaitPermitted {
  readonly sleep: true;
  readonly waitMs: number;
  readonly reasonCodes: readonly string[];
}

function refuse(
  disposition: ResetWaitDisposition,
  reasonCodes: readonly string[] = [],
): WaitRefused {
  return {
    sleep: false,
    report: Object.freeze({
      disposition,
      waitedMs: null,
      reasonCodes: Object.freeze([...reasonCodes]),
    }),
  };
}

/** `RELEASED` is the only proof there is. Absence of a lease proves nothing. */
function releaseProven(release: LeaseReleaseResult | null): boolean {
  return release !== null && release.code === 'RELEASED';
}

/**
 * Decides whether this run may sleep, and for how long.
 *
 * Pure apart from one clock read. Everything it consults is either the operator's
 * own request or a value the canonical machinery already produced — the last
 * `RunResult`'s `ResumeDecision`, and the `reportedResetAt` of the state that
 * decision was made about. It re-runs none of `evaluateAutomaticResume`'s checks:
 * the single judgement made here is whether the decision's *own* reason codes
 * are exactly `[RESET_TIME_NOT_REACHED]`, which is a test on the verdict rather
 * than a second copy of it.
 *
 * The order matters and is the fail-closed one: shape of the stop, then the
 * operator's opt-in, then the canonical verdict, then the timestamp, then the
 * bound, then the lease release, then the budget. Every arm before the sleep is
 * a refusal, so a condition that is not positively established cannot pass.
 */
function decideWait(
  request: UnattendedResumeRequest,
  epoch: LifecycleResult,
  nowIso: string,
): WaitRefused | WaitPermitted {
  // 1. Did the *run* stop on a quota block?
  //
  // Read from the run rather than from `epoch.outcome`, and that is not a
  // shortcut. A first epoch whose release failed carries the outcome
  // `LEASE_RELEASE_FAILED`, which would make the quota block invisible here —
  // and the release check below, the one that must refuse it, would never be
  // reached. Asking the run keeps the hazard reachable so the gate inside it
  // can do its job.
  const run = epoch.runs.at(-1);
  if (run === undefined || run.outcome !== 'BLOCKED_USAGE_LIMIT') {
    return refuse('NOT_A_QUOTA_BLOCK');
  }

  // 2. Was a wait asked for? It is never implied by the block.
  if (!request.wait.wait) return refuse('NOT_REQUESTED', run.reasonCodes);
  const maxWaitMs = request.wait.maxWaitMs;

  // 3. The canonical verdict, unwrapped and not re-derived.
  // `allowed` is folded in with `null`, and the two really are one condition
  // here: both mean there is no *denial* on record about the block this run
  // stopped on. A decision that allowed a resume cannot have produced a
  // `BLOCKED_USAGE_LIMIT` stop — the blocking gate excludes it and the resume
  // arm always returns or continues — so the `allowed` half is a floor. It is
  // folded in rather than left to fall through because an empty denial list
  // would otherwise reach `RESUME_DENIED_BY_OTHER_CHECKS`, whose sentence
  // states that at least one reason is something time does not fix.
  const automatic = run.resume?.automaticResume ?? null;
  if (automatic === null || automatic.allowed) return refuse('RESUME_DECISION_ABSENT');
  const denials = automatic.reasonCodes;

  // **The eligibility test, in one expression.** Exactly one denial, and it is
  // the reset time. `RESET_TIME_MISSING`, `RESET_TIME_UNPARSEABLE`,
  // `AUTH_PREFLIGHT_NOT_PASSED`, `WORKTREE_NOT_CLEAN`, a commit that moved, a
  // divergence — any of them, alone or alongside the reset time, means sleeping
  // changes nothing, so nothing sleeps.
  if (denials.length !== 1 || denials[0] !== RESET_TIME_NOT_REACHED) {
    // The disposition below is *reporting*, not deciding: the decision was made
    // on the line above. It names the specific timestamp failures because those
    // are the ones an operator can act on, and folds everything else into one
    // member whose reason codes say the rest.
    const disposition: ResetWaitDisposition = denials.includes('RESET_TIME_MISSING')
      ? 'RESET_TIME_MISSING'
      : denials.includes('RESET_TIME_UNPARSEABLE')
        ? 'RESET_TIME_UNPARSEABLE'
        : denials.includes('CURRENT_TIME_UNPARSEABLE')
          ? 'CURRENT_TIME_UNPARSEABLE'
          : 'RESUME_DENIED_BY_OTHER_CHECKS';
    return refuse(disposition, denials);
  }

  // 4. The instant itself, from the state that decision was made about.
  //
  // Both floors below are unreachable while the verdict above says the reset
  // time is the only thing outstanding — a missing or unreadable timestamp is a
  // denial of its own, and would have failed the test. They are kept because
  // "another module's reasoning says this cannot be null" is not the same as a
  // check, and the cost of being wrong here is a sleep computed from `NaN`.
  const resetAt = run.reconciliation?.state?.reportedResetAt ?? null;
  if (resetAt === null) return refuse('RESET_TIME_MISSING', denials);
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return refuse('RESET_TIME_UNPARSEABLE', denials);

  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return refuse('CURRENT_TIME_UNPARSEABLE', denials);

  // The `+ 1` is not an assumption about the policy; it is a consequence of it.
  // `evaluateAutomaticResume` refuses while `now <= reportedResetAt`, so waking
  // *at* the reported instant is refused, and a timer aimed exactly there would
  // reliably produce a second `RESET_TIME_NOT_REACHED`. Waking one millisecond
  // later is the earliest moment the existing policy can possibly allow — and
  // it is still only *possibly*: the policy is re-run after the wake and is the
  // authority, whatever this arithmetic aimed at.
  //
  // Clamped at zero because the reset may already have passed between the
  // decision that produced this result and this line. Sleeping for nothing and
  // re-evaluating is the correct answer there; treating it as "the block has
  // cleared" would be this module deciding the very thing it must not.
  const waitMs = Math.max(0, resetMs - nowMs + 1);
  if (waitMs > maxWaitMs) {
    return refuse('BOUND_EXCEEDED', [...denials, `REQUIRED_WAIT_MS_${String(waitMs)}`]);
  }

  // 5. The lease must be **provably** back before anything sleeps.
  //
  // Not "the outcome looked fine", not "the finally block ran", not "the lease
  // file is gone". A sleeper that cannot prove it gave the repository back may
  // still be its writer, and it is about to be unreachable for hours.
  if (!releaseProven(epoch.release)) {
    return refuse(
      'LEASE_RELEASE_UNPROVEN',
      epoch.release === null ? ['LEASE_RELEASE_ABSENT'] : [epoch.release.code],
    );
  }

  // 6. And there must be an invocation left to spend on the second epoch.
  if (request.maxInvocations - epoch.invocations < 1) {
    return refuse('INVOCATION_BUDGET_SPENT', ['MAX_INVOCATIONS_SPENT']);
  }

  return { sleep: true, waitMs, reasonCodes: denials };
}

/* ──────────────────────────── the controller ────────────────────────────── */

function result(
  taskId: string,
  epochs: readonly LifecycleResult[],
  wait: ResetWaitReport,
  fallback: LifecycleOutcome,
): UnattendedResumeResult {
  const last = epochs.at(-1);
  return Object.freeze({
    outcome: last?.outcome ?? fallback,
    taskId,
    epochs: Object.freeze([...epochs]),
    wait,
  });
}

/**
 * Continues one already-durable task without a human, waiting out a reported
 * quota reset at most once.
 *
 * Never throws for an expected condition; every refusal arrives as data. The
 * grant and the stale-recovery permission are **fixed** here rather than taken
 * from the caller, and that is the point of having this entry point at all: a
 * library caller cannot reach an unattended start or an unattended lease removal
 * through it, whatever the CLI does or does not check.
 */
export async function driveUnattendedAutomaticResume(
  request: UnattendedResumeRequest,
  deps: UnattendedResumeDependencies,
): Promise<UnattendedResumeResult> {
  const { taskId } = request;
  const sleep = deps.sleep ?? realSleep;

  // Refused before any effect: before a lease, before a preflight, before a
  // single Git subprocess. A bound this build will not sleep on is an unusable
  // input, and invoking again with the same value repeats it exactly — which is
  // what `INVOCATION_BUDGET_INVALID`'s code 2 already tells a scheduler.
  if (request.wait.wait && !isUsableWaitBound(request.wait.maxWaitMs)) {
    return result(
      taskId,
      [],
      Object.freeze({
        disposition: 'WAIT_BOUND_UNUSABLE' as const,
        waitedMs: null,
        reasonCodes: Object.freeze(['MAX_WAIT_MS_INVALID']),
      }),
      'INVOCATION_BUDGET_INVALID',
    );
  }
  if (request.wait.wait && request.maxInvocations < 2) {
    return result(
      taskId,
      [],
      Object.freeze({
        disposition: 'INVOCATION_BUDGET_SPENT' as const,
        waitedMs: null,
        reasonCodes: Object.freeze(['MAX_INVOCATIONS_TOO_LOW_FOR_WAIT']),
      }),
      'INVOCATION_BUDGET_INVALID',
    );
  }

  const epochs: LifecycleResult[] = [];

  const first = await driveLifecycle(
    {
      repository: request.repository,
      taskId,
      continuationGrant: 'AUTOMATIC_RESUME_ONLY',
      // Fixed, never forwarded. Removing a lease is a destructive operator
      // permission, and this mode exists to run when no operator is there.
      //
      // Belt and braces since a review: `driveLifecycle` now refuses a recovery
      // under this grant whatever is passed here (`mayRecoverStaleLease`), so
      // this line is no longer what enforces the property — it states the intent
      // at the call site, and the mutant that flips it to `true` is now
      // equivalent for exactly that reason. The gate that dies is the one at the
      // boundary.
      recoverStaleLease: false,
      maxSteps: request.maxSteps,
      maxInvocations: request.maxInvocations,
    },
    // Both factories are applied together: an epoch that re-proves auth and
    // carries a stale capability answer across the same sleep would be half a
    // freshness guarantee (M5). The capability factory is applied to *this*
    // epoch's repository reading, never to the other one's.
    {
      ...deps,
      authPreflight: deps.authPreflight(),
      mcpPreflight: deps.mcpPreflight()(request.repository.capabilities),
    },
  );
  epochs.push(first);

  const decision = decideWait(request, first, deps.now());
  if (!decision.sleep) return result(taskId, epochs, decision.report, first.outcome);

  await sleep(decision.waitMs);

  // ── Everything from here is established again ──────────────────────────
  const repository = await deps.resolveRepository();
  if (repository === null) {
    return result(
      taskId,
      epochs,
      Object.freeze({
        disposition: 'REPOSITORY_UNRESOLVED_AFTER_WAIT' as const,
        waitedMs: decision.waitMs,
        reasonCodes: Object.freeze(['REPOSITORY_UNRESOLVED']),
      }),
      first.outcome,
    );
  }

  const second = await driveLifecycle(
    {
      repository,
      taskId,
      continuationGrant: 'AUTOMATIC_RESUME_ONLY',
      recoverStaleLease: false,
      maxSteps: request.maxSteps,
      // What is left of the one budget, so two epochs cannot spend more
      // `runTask` invocations than the operator allowed for the command.
      maxInvocations: request.maxInvocations - first.invocations,
    },
    // A **new** once-only preflight. The first epoch's is not reused, and this
    // is the line that makes "post-wake auth is fresh" true rather than
    // intended.
    // Both factories are applied together: an epoch that re-proves auth and
    // carries a stale capability answer across the same sleep would be half a
    // freshness guarantee (M5). Applied to the repository resolved AFTER the
    // wait, for the reason that resolution exists: the requirement itself is a
    // reading taken at a moment, and the profile may have changed.
    {
      ...deps,
      authPreflight: deps.authPreflight(),
      mcpPreflight: deps.mcpPreflight()(repository.capabilities),
    },
  );
  epochs.push(second);

  // No loop, and no second decision. A quota block met by the post-wake epoch
  // ends the run: sleeping through a second reset in one invocation is a daemon,
  // and that is a later layer's authority.
  return result(
    taskId,
    epochs,
    Object.freeze({
      disposition: 'WAITED' as const,
      waitedMs: decision.waitMs,
      reasonCodes: Object.freeze([...decision.reasonCodes]),
    }),
    second.outcome,
  );
}
