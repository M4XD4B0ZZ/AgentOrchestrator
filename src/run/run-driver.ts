/**
 * The governed run driver: what turns the V1 state machine into something that
 * actually runs.
 *
 * Everything it does exists in the slices beneath it. What it adds is the one
 * ordering those slices never composed, and a single closed outcome a caller
 * can branch on without re-deriving it from a reconciliation code, a
 * continuation authority and a loop-step outcome.
 *
 * ── The invariant this module exists to hold ───────────────────────────────
 *
 * **A step is never executed from persisted state alone.** Every iteration, in
 * this order and with each gate closing on the one before it:
 *
 *  0. `verifyExecutionLeaseHeldFor` — is this process still the repository's one
 *     writer? Re-proved against the file every iteration, not carried from the
 *     start of the run, and asked first because it is the only gate that is
 *     about the repository rather than about this task (V2-07L);
 *  1. `reconcileTask` — load the durable state *and* compare it against what
 *     Git says right now. `RECONCILED` is the only outcome anything continues
 *     from;
 *  2. `classifyResume` — decide what, if anything, may continue. Only
 *     `AUTOMATIC_ALLOWED` continues a *blocked* task, and it has exactly one
 *     source, which this module feeds rather than re-implements;
 *  3. `continuationGrant` — whether *this invocation* is cleared to continue
 *     at all. A second requirement on top of the authority module's answer, and
 *     one this run either has or does not. Since V3-08 it is a closed
 *     three-member vocabulary rather than a boolean, and its third member,
 *     `AUTOMATIC_RESUME_ONLY`, passes only where step 2 answered
 *     `AUTOMATIC_ALLOWED` — a conjunct, never an alternative;
 *  4. `observed.authorisedWorktreePath` — the directory Git vouched for. Absent
 *     authority stops the run before anything is spawned;
 *  5. only then a durable write: the one transition an unattended resume
 *     authorises, or `runLoopStep` with that path handed to it explicitly.
 *
 * The order is not a style preference. Reversing any two of them produces a
 * concrete failure this repository has already written down: judging the block
 * before reconciling produces "resume allowed" for a task whose worktree is
 * gone; executing before observing runs an agent in a directory nothing has
 * vouched for; re-reading the state to obtain a fresh revision after a refused
 * write is how a stale-writer refusal becomes a successful overwrite; and
 * writing a blocked task's resume before the gates that decide whether this run
 * may act converts a self-clearing quota pause into an attended-only task
 * without doing any work, because the resume spends the very evidence a later
 * unattended run would need (V1-07-RR-B1).
 *
 * ── Reconciliation is re-run every iteration ───────────────────────────────
 *
 * Not once per run. A step is a subprocess that took minutes and changed the
 * worktree, so the world it left behind is not the world the previous
 * reconciliation described. Re-loading is also how the compare-and-swap token
 * is obtained: `advanceTaskState` threads the revision of the
 * `StateLoadSuccess` it was handed, `StateSaveSuccess` carries no new revision,
 * and so exactly one write may be made per load. Hoisting the reconciliation
 * out of the loop would break both properties at once.
 *
 * ── This driver runs one task ──────────────────────────────────────────────
 *
 * It selects a task through V1-02's selector and drives it until it stops. It
 * does **not** go on to a second one, and that is a refusal rather than an
 * omission: `selectNextTask` decides eligibility from `status: DONE` in the
 * repository's own task files, nothing in this build writes a task file, and
 * `READY_FOR_PR` is terminal precisely because a human takes the task from
 * there. So "this task is finished, move on" is a statement only the repository
 * can make, and a driver that made it — by treating `READY_FOR_PR` as `DONE`,
 * or by keeping its own list of attempted ids — would be inventing completion
 * semantics the repository has not defined. Selection is re-run from the files
 * on the next invocation, which is where a human's edit lands.
 *
 * ── Nothing here retries, sleeps, polls or backs off ───────────────────────
 *
 * A block is a stop. A refused write is a stop. `NOT_APPLICABLE` is a stop. The
 * loop continues only while the previous iteration made a *durable* change,
 * measured by the state file's revision moving, and never by a step having
 * returned a hopeful outcome.
 */

import {
  isBlockingState,
  isTerminalState,
  type BlockingState,
  type TaskStateName,
} from '../core/states.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import { verifyExecutionLeaseHeldFor } from '../lease/execution-lease.js';
import { withdrawnCheckpointFor } from '../core/agent-phases.js';
import {
  mayContinueHumanDecision,
  mayContinueUsageLimit,
  mayRemediateVerifyFailure,
  permitsContinuation,
  type InvocationGrant,
} from './invocation-grant.js';
import { resumePointToState } from '../core/resume-policy.js';
import {
  usageLimitContinuation,
  type UsageLimitContinuationReading,
} from '../core/usage-limit-continuation.js';
import { RESUME_EVIDENCE_SPENT } from '../core/resume-point.js';
import {
  isLoopDrivenState,
  runLoopStep,
  type CompletionObserver,
  type LoopStepResult,
} from '../loop/loop-step.js';
import { planNextTask, type TaskPlanningResult } from '../plan/plan-next-task.js';
import type { TaskDefinition } from '../plan/task-definition.js';
import { readExecutionBrief } from '../plan/task-brief.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { advanceTaskState, type AdvanceOptions } from '../state/advance-state.js';
import {
  reconcileTask,
  stopSpellingFor,
  type TaskReconciliation,
} from '../state/reconcile-task.js';
import { classifyResume, type ResumeDecision } from '../state/resume-decision.js';
import type { ReplaceFn, TempSuffixFn } from '../state/atomic-file.js';
import type { StateLoadSuccess } from '../state/state-store.js';
import type { AgentRunner } from '../agent/agent-command.js';
import {
  mergePermissionDenials,
  NO_PERMISSION_DENIALS,
  type PermissionDenialObservation,
} from '../agent/agent-outcome.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import type { GitRunner } from '../worktree/git-command.js';

/* ──────────────────────────── the outcome ───────────────────────────────── */

/**
 * How a run ended. A closed vocabulary, and deliberately a wide one.
 *
 * Each authority boundary keeps its own member. Collapsing them into a generic
 * failure is the specific mistake this vocabulary exists to prevent: "the quota
 * ran out", "the build is broken", "a human must decide", "we were never
 * allowed to run here" and "another writer got there first" have nothing in
 * common except that the run stopped, and they send an operator to five
 * different places.
 */
export const RUN_OUTCOMES = [
  /* --- the task finished ------------------------------------------------- */
  /** The task reached `READY_FOR_PR`. Terminal; a human opens the pull request. */
  'TASK_COMPLETED',
  /** The task was already `ABORTED`. Terminal, and nothing was run. */
  'TASK_ABORTED',

  /* --- the task is durably parked ---------------------------------------- */
  /**
   * A subscription quota is exhausted. A pause, not a failure — but this run
   * stops, and whether a later one may continue is answered by
   * `evaluateAutomaticResume` from evidence including a reset time this block
   * may not even carry. `reasonCodes` says which checks denied it.
   */
  'BLOCKED_USAGE_LIMIT',
  /**
   * The repository's verification commands failed. Never retried here: the only
   * continuation is remediation by the writing agent, which is a decision.
   */
  'BLOCKED_VERIFY',
  /** An agent's credentials are missing or expired. Only a human restores them. */
  'BLOCKED_AUTH',
  /** An agent wrote outside its allowed scope. Not resumable at all. */
  'SCOPE_VIOLATION',
  /** The durable state records that record and reality disagreed. Not resumable. */
  'RESUME_STATE_DIVERGED',
  /** The loop escalated to an operator, or found one already waiting. */
  'HUMAN_DECISION_REQUIRED',

  /* --- the record and the world ------------------------------------------ */
  /** Reconciliation found the world contradicting the record. Nothing was run. */
  'STATE_DIVERGED',
  /**
   * Reconciliation could not read the world. Kept apart from `STATE_DIVERGED`
   * on purpose: telling an operator their base commit was rewritten when the
   * truth is "Git could not be run" sends them to look at the wrong thing.
   */
  'STATE_UNOBSERVABLE',
  /**
   * A state exists and cannot be used: malformed, oversized, written to a
   * contract version this build does not know, or intact but belonging to
   * another repository or another task. Never repaired — see `state-store.ts`.
   */
  'STATE_UNUSABLE',
  /**
   * No state has ever been persisted for this task.
   *
   * Not an error, and deliberately not a start. Creating the first state means
   * recording a `worktreePath`, and this driver does not prepare workspaces;
   * writing one anyway would durably assert a directory nobody created.
   *
   * Starting a task is `startTask`'s job (V2-03), and since V2-04 this driver
   * can carry one the whole way from the `WORKTREE_READY` it produces. The
   * division stands: preparing a workspace and driving one are different
   * authorities, and this outcome is still the correct answer to "drive a task
   * that has no state".
   */
  'TASK_NOT_STARTED',

  /* --- the write --------------------------------------------------------- */
  /**
   * A write was refused because another writer moved the task on. Nothing was
   * written, and the run stops rather than re-reading and deciding again — that
   * re-read is exactly how a stale-writer refusal gets laundered.
   */
  'STATE_CONFLICT',
  /**
   * A write was refused for any other reason. Distinct from every block: an
   * unrecorded block is a task whose durable state still claims it is running,
   * which is the opposite of parked.
   */
  'STATE_NOT_RECORDED',

  /* --- authority --------------------------------------------------------- */
  /**
   * The record and the world agree, and still nothing may continue: an
   * unattended resume was refused, or continuing an in-flight task was not
   * authorised for this run. `reasonCodes` says which.
   */
  'CONTINUATION_NOT_AUTHORISED',
  /**
   * Git authorised no worktree for this task, so nothing was spawned. A
   * fail-closed floor: reconciliation already refuses an unregistered worktree
   * and a foreign branch, so reaching this means a gate above it changed.
   */
  'EXECUTION_UNAUTHORISED',
  /**
   * This invocation never held the repository's execution lease.
   *
   * The value handed to {@link RunRequest.lease} is not minted evidence. Kept
   * apart from {@link EXECUTION_LEASE_LOST} because they are opposite
   * situations: this one means a caller asserted authority it never had, and
   * that one means authority this run really held has gone away.
   */
  'EXECUTION_LEASE_NOT_HELD',
  /**
   * The lease this run took is no longer this run's.
   *
   * Removed underneath it — by an operator breaking a lease they believed
   * stale, by a wiped administrative directory — or replaced by a successor.
   *
   * **The step in flight finishes, and its durable write does not land.**
   * `advanceTaskState` re-proves the lease immediately before every transition,
   * so a loss during an agent subprocess is caught at the write rather than at
   * the next iteration — measured, in both directions: the write is refused and
   * the state file is byte-identical.
   *
   * What is *not* claimed is anything about the subprocess itself. An agent
   * already running may still write in the worktree and may still land a commit
   * on the task branch; stopping that needs owned process containment, which is
   * a later slice and is not pretended to be solved here.
   */
  'EXECUTION_LEASE_LOST',

  /* --- nothing to do ----------------------------------------------------- */
  /**
   * The task is in a state this driver does not drive, or an iteration left the
   * durable state exactly as it found it. Either way the next iteration would
   * do the same thing, so there is not one.
   */
  'NO_PROGRESS',
  /**
   * Durable progress was made and the step budget ran out. The only outcome
   * that means "call again": everything is on disk, and a further invocation
   * picks up from the durable phase.
   */
  'STEP_BUDGET_EXHAUSTED',
] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** The outcome each blocking state produces. Total, so a new state must choose one. */
const BLOCKING_OUTCOME: Readonly<Record<BlockingState, RunOutcome>> = Object.freeze({
  BLOCKED_AUTH: 'BLOCKED_AUTH',
  BLOCKED_USAGE_LIMIT: 'BLOCKED_USAGE_LIMIT',
  BLOCKED_VERIFY: 'BLOCKED_VERIFY',
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  RESUME_STATE_DIVERGED: 'RESUME_STATE_DIVERGED',
  HUMAN_DECISION_REQUIRED: 'HUMAN_DECISION_REQUIRED',
});

/**
 * The verify codes that mean this run **never** held the lease, as opposed to
 * having lost one it did hold.
 *
 * The two outcomes send an operator to different places, so the split has to be
 * right: a forged artefact and a genuine lease for *another* repository are both
 * "you were never the writer here", however real the second one is somewhere
 * else. Only a lease that was this repository's and has gone is a loss.
 */
const NEVER_HELD: ReadonlySet<string> = new Set([
  'EVIDENCE_INVALID',
  'LEASE_FOR_ANOTHER_REPOSITORY',
]);

export interface RunResult {
  readonly outcome: RunOutcome;
  readonly taskId: string;
  /** The durable state the run stopped on, or `null` when none was loaded. */
  readonly state: TaskStateName | null;
  /** Durable writes this call landed. Zero is a complete answer, not a failure. */
  readonly steps: number;
  /**
   * Why, in stable codes: reconciliation findings, automatic-resume reason
   * codes, or the code a refused write carried. Empty when the outcome says
   * everything.
   */
  readonly reasonCodes: readonly string[];
  /** The reconciliation the run stopped on, or `null` when none was reached. */
  readonly reconciliation: TaskReconciliation | null;
  /** The continuation decision the run stopped on, or `null` when never reached. */
  readonly resume: ResumeDecision | null;
  /** The loop step the run stopped on, or `null` when none ran. */
  readonly lastStep: LoopStepResult | null;
  /**
   * Whether this call took a task out of `BLOCKED_VERIFY` on the operator's
   * decision.
   *
   * Reported so the **lifecycle** can bound the cycle across invocations, which
   * the local `verifyRemediationSpent` cannot: `driveLifecycle` re-enters
   * `runTask` on `STEP_BUDGET_EXHAUSTED`, and a fresh call gets a fresh local.
   * Measured rather than assumed — a counter-proof mutant removing the local
   * bound survived every test, and chasing why found this: with a small
   * `--max-steps` and a larger `--max-invocations`, the resume and the
   * remediation can exhaust the budget *before* the failing verification, so the
   * next invocation meets the block again with nothing spent.
   *
   * Never persisted. It is a fact about one call, and a durable one would be a
   * claim about a decision rather than the decision itself.
   */
  readonly remediatedVerifyFailure: boolean;
  /**
   * Whether this call took a task out of `HUMAN_DECISION_REQUIRED` on the
   * operator's decision.
   *
   * Reported for the same reason as the field above, and read by
   * `driveLifecycle` to bound the decision across the invocations one lifecycle
   * makes. Never persisted: it is a fact about one call.
   */
  readonly continuedHumanDecision: boolean;
  /**
   * Whether this run spent the operator's decision to continue a
   * `BLOCKED_USAGE_LIMIT` task the machine cannot wait out.
   *
   * The third of the same shape, reported for the same reason: the operator
   * bought one departure and has to be able to see whether it was used. Never
   * persisted — it is a fact about one call.
   */
  readonly continuedUsageLimit: boolean;
  /**
   * How this run read a `BLOCKED_USAGE_LIMIT` record, or `null` for a run that
   * never met one.
   *
   * The reading `core/usage-limit-continuation.ts` produced, carried out so that
   * an operator meeting the block is told **which** of its readings applies —
   * whether the wait is still the machine's, whether the automatic path owns the
   * task and is refusing on the repository rather than the record, or whether
   * the decision is theirs. `--continue-usage-limit`'s help promises that
   * `run --task <id>` prints it, and this field is what makes that true rather
   * than an intention.
   *
   * Never persisted, and never authority: the permission is re-derived at the
   * conjunct from the record and the clock, so a reading that travelled here
   * cannot become a grant somewhere else.
   */
  readonly usageLimitContinuation: UsageLimitContinuationReading | null;
  /**
   * What the writing agent was refused, **across every step of this run**.
   *
   * Run-level rather than per-step, and that placement is the whole point.
   * `lastStep` cannot carry it: a writer pass that succeeds is followed by
   * verification and review, so by the time a run ends `lastStep` is a later
   * step whose own observation is `null` — the observation would vanish in
   * exactly the case it exists for, a run that reported success while the
   * writer had been refused.
   *
   * Aggregating, never last-writer-wins: see {@link mergePermissionDenials}.
   * Never persisted (G2) — this is a report to the operator, and it is the
   * `renderRunResult` line that makes it one.
   */
  readonly permissionDenials: PermissionDenialObservation;
}

/* ──────────────────────────── the inputs ────────────────────────────────── */

export interface RunRequest {
  /** The repository, already resolved. This module resolves nothing. */
  readonly repository: ResolvedRepository;
  /** The task to drive. */
  readonly taskId: string;
  /**
   * What *this invocation* is permitted to continue.
   *
   * `classifyResume` reports a healthy in-flight task as `ATTENDED_ONLY`,
   * because "the record is accurate" and "carry on without me" are different
   * statements — the most common thing that reconciles is an interrupted task
   * with half-written work in its worktree. This field is what the caller asked
   * for. It is a second requirement on top of the authority module's answer and
   * never a substitute for it: it can only ever narrow what runs, and no value
   * here can produce `AUTOMATIC_ALLOWED` for a *blocked* task, which still moves
   * only on that verdict and stops on anything else.
   *
   * It was `attendedContinuation: boolean` until V3-08. The boolean's `false`
   * is now `NO_CONTINUATION` and its `true` is `ATTENDED`, with the same reason
   * code on refusal; the third member, `AUTOMATIC_RESUME_ONLY`, is the
   * invocation authority `L-V3-06-2` asked for and passes this gate only where
   * the resume decision answered `AUTOMATIC_ALLOWED`. See
   * `run/invocation-grant.ts` for why a closed type rather than a second
   * boolean beside the first.
   *
   * Because it is a requirement on the *invocation*, it is checked before any
   * durable write, including the one an unattended resume authorises. A run
   * that will refuse to execute must not first spend a task's resume evidence
   * on a transition it cannot follow up (V1-07-RR-B1).
   */
  readonly continuationGrant: InvocationGrant;
  /**
   * Whether the operator asked, on this invocation, to continue a
   * `BLOCKED_VERIFY` task to remediation.
   *
   * The declared edge `BLOCKED_VERIFY -> REMEDIATING` has existed in
   * `core/transitions.ts` since V1, and `core/resume-policy.ts` has said all
   * along that the state is `resumable: true` with `requiresHumanDecision: true`
   * and a resume phase of `REMEDIATE`. Nothing could take it: the blocking gate
   * below admits exactly one verdict, `AUTOMATIC_ALLOWED`, which
   * `BLOCKED_VERIFY` can never carry because it is `automaticResumeEligible:
   * false`. The contract and the executor disagreed, and the M1 release gate is
   * where that stopped being a curiosity.
   *
   * This is the operator's half of the decision. It is conjoined with
   * `mayRemediateVerifyFailure(continuationGrant)`, so it does nothing without
   * `ATTENDED`, and it is spent after one use — see `verifyRemediationSpent`.
   *
   * Defaulting is deliberate: absent means no. A field that had to be set to
   * *refuse* would make every existing caller a caller that continues blocked
   * tasks.
   */
  readonly remediateVerifyFailure?: boolean;
  /**
   * Whether the operator asked, on this invocation, to continue a
   * `HUMAN_DECISION_REQUIRED` task from the resume point it recorded.
   *
   * The second half of the same story the field above tells, and it was found
   * the same way. `core/transitions.ts` has declared
   * `HUMAN_DECISION_REQUIRED -> IMPLEMENTING | VERIFYING | REVIEWING |
   * REMEDIATING` since V1, and `core/resume-policy.ts` calls the state
   * `resumable: true` with `resumeReentry: 'DIRECT'` and a `REQUIRED` resume
   * point. Nothing could take any of those four edges: the blocking gate admits
   * `AUTOMATIC_ALLOWED`, which this state can never carry
   * (`automaticResumeEligible: false`), and the `remediateVerifyFailure`
   * conjunct is scoped to `BLOCKED_VERIFY` by its first term. Measured on
   * 2026-08-29 against `87e90ba`: an attended re-run of a task parked here took
   * `0` steps and left the state untouched.
   *
   * This is the operator's half. It is conjoined with
   * `mayContinueHumanDecision(continuationGrant)`, so it does nothing without
   * `ATTENDED`, and it is spent after one use — see
   * `humanDecisionContinuationSpent`.
   *
   * It is a *different* field from `remediateVerifyFailure` rather than a wider
   * spelling of it, and the existing pin that `--remediate-verify-failure`
   * refuses to move a `HUMAN_DECISION_REQUIRED` task stays true afterwards.
   *
   * Defaulting is deliberate: absent means no.
   */
  readonly continueHumanDecision?: boolean;
  /**
   * Whether the operator asked, on this invocation, to continue a
   * `BLOCKED_USAGE_LIMIT` task **the machine cannot wait out**, from the resume
   * point it recorded.
   *
   * The third half of the same story, and it was found the same way: by asking
   * which declared edge no executor could take. `BLOCKED_USAGE_LIMIT` is
   * `resumable: true` with `resumeReentry: 'DIRECT'` and a `REQUIRED` resume
   * point, and its edges back into the work loop are declared. The automatic
   * path takes them — but only where the *record* it reads permits. Where it
   * does not — no reset instant to wait for, or a withdrawn resume record —
   * `evaluateAutomaticResume` denies for ever, and the two operator conjuncts
   * beside this one are pinned by their first terms to other states. Such a task
   * could not be moved by anything.
   *
   * Which records qualify lives in the driver's conjunct, not here, because it
   * is a property of the *record* rather than of the invocation — see
   * `core/usage-limit-continuation.ts` for the readings and
   * {@link mayContinueUsageLimit} for why a machine-owned wait must not be
   * reachable through this door.
   *
   * Conjoined with `mayContinueUsageLimit(continuationGrant)`, so it does
   * nothing without `ATTENDED`, and spent after one use — see
   * `usageLimitContinuationSpent`.
   *
   * A *different* field from the two above rather than a wider spelling, and
   * the existing pins that each of those refuses to move the other's state stay
   * true afterwards.
   *
   * Defaulting is deliberate: absent means no.
   */
  readonly continueUsageLimit?: boolean;
  /**
   * The artefact a *fresh* auth preflight produced, or `null` when none ran.
   *
   * Evidence, never assumed — and since V2-05 that is enforced rather than
   * asserted. This used to be `authPreflightPassed: boolean`, which made the
   * claim in its own documentation and did not keep it: any caller could write
   * `true`. The type is now opaque, its only producer is `runAuthPreflight`, and
   * `evaluateAutomaticResume` verifies it at runtime instead of comparing it to
   * `true` — so a caller holding nothing cannot describe a passing preflight,
   * and a caller holding a cast gets a denial.
   *
   * `null` is the honest value for a path that ran no preflight, and it denies
   * an unattended resume. It does not, on its own, stop a run: an attended run
   * of a non-blocked task never consults it. The invocation grant
   * ({@link continuationGrant}) and auth evidence are independent requirements,
   * and neither substitutes for the other.
   */
  readonly authEvidence: AuthPreflightEvidence | null;
  /**
   * Proof that this invocation holds the repository's execution lease.
   *
   * **Required, and never nullable** — unlike {@link authEvidence}, which has an
   * honest `null` for a path that ran no preflight. There is no honest `null`
   * here: a run that is not the repository's writer must not drive a task at
   * all, so "no lease" is not a weaker mode of running, it is not running.
   *
   * Re-proved against the file on every iteration rather than trusted once. See
   * the module header: a step is a subprocess that took minutes, and a lease
   * taken before it is not a lease held after it.
   */
  readonly lease: ExecutionLeaseEvidence;
  /**
   * The most durable steps this call may take.
   *
   * Not the bound on the loop — `maxReviewRounds` is, and it is the
   * repository's. This is the bound on one *invocation*, so that a driver
   * cannot run away if a future edge makes an unbounded cycle reachable.
   *
   * **It is not a strict ceiling in exactly one case, and that case clears
   * itself.** A call holding a live remediation brief when the budget runs out
   * takes one further step to discharge it, because the brief is the only copy
   * of the review's actionable detail and nothing durable carries it. The
   * overrun is at most one step: the brief is consumed and cleared by the step
   * that spends it. See the loop below for why this is preferable to persisting
   * a reviewer-authored path.
   */
  readonly maxSteps: number;
}

export interface RunDependencies {
  /**
   * The clock, read once per durable write.
   *
   * A function rather than a value: a run takes several steps, and one frozen
   * timestamp would stamp every state with the instant the run began, making
   * `stateEnteredAt` a record of the invocation rather than of the state.
   */
  readonly now: () => string;
  /** Git. Required and never defaulted, so a test never reaches a real repository. */
  readonly git: GitRunner;
  /** Filesystem existence seam, forwarded to the observation half. */
  readonly exists?: (path: string) => boolean;
  /** Execution seams, forwarded to the loop. Default to the real ones. */
  readonly verify?: VerificationRunner;
  readonly agent?: AgentRunner;
  readonly observe?: CompletionObserver;
  /** State-store seams, forwarded to every write. */
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

/* ──────────────────────────── the driver ────────────────────────────────── */

function runResult(
  from: Partial<RunResult> & { readonly outcome: RunOutcome; readonly taskId: string },
): RunResult {
  return Object.freeze({
    state: null,
    steps: 0,
    reasonCodes: Object.freeze([]),
    reconciliation: null,
    resume: null,
    lastStep: null,
    remediatedVerifyFailure: false,
    continuedHumanDecision: false,
    continuedUsageLimit: false,
    usageLimitContinuation: null,
    permissionDenials: NO_PERMISSION_DENIALS,
    ...from,
  });
}

/**
 * The load-failure outcomes, kept as distinct as the loader reports them.
 *
 * The three non-continuable spellings come from `stopSpellingFor`, which owns
 * that fold beside the vocabulary it folds. Only the two outcomes it leaves to
 * its caller are decided here — and this driver's answer to "never started" is
 * a refusal, which is exactly the decision that must not live in a shared table.
 */
function outcomeForReconciliation(reconciliation: TaskReconciliation): RunOutcome {
  const stop = stopSpellingFor(reconciliation.outcome);
  if (stop !== null) return stop;

  // `RECONCILED` is not reachable: the caller checks for it before asking.
  // Answered anyway so the function stays total against a widened outcome set.
  return reconciliation.outcome === 'NO_PERSISTED_STATE' ? 'TASK_NOT_STARTED' : 'NO_PROGRESS';
}

/**
 * Drives one task until it stops.
 *
 * Never throws for an expected condition. Every refusal — Git unavailable, a
 * write rejected, an agent blocked — arrives as data with its own outcome, so
 * there is no path on which a caller learns less than what happened.
 */
export async function runTask(
  request: RunRequest,
  deps: RunDependencies,
): Promise<RunResult> {
  const { repository, taskId, maxSteps } = request;

  // Accumulated here rather than read off the step this run happens to stop on.
  // Every `stop` below is a way this run can end, and an operator is owed the
  // same answer on all of them, so the accumulation is attached in one place
  // instead of at each return — a rule that holds by being unavoidable rather
  // than by every future exit remembering it.
  let permissionDenials = NO_PERMISSION_DENIALS;
  /**
   * Whether this invocation has already taken a task out of `BLOCKED_VERIFY`.
   *
   * **The cycle bound, and it is the whole reason this is a variable rather than
   * a condition.** `VERIFYING -> BLOCKED_VERIFY -> REMEDIATING -> VERIFYING`
   * touches neither `reviewRound` nor `maxReviewRounds` — remediation rounds are
   * counted by *reviews*, and a verification failure is not one. Until now that
   * cycle was bounded by the fact that nothing could leave `BLOCKED_VERIFY` at
   * all, which is a real bound and the one being removed here. Without a
   * replacement, an invocation with `--max-steps 8` would traverse it about two
   * and a half times on its own, and one with a larger budget would keep sending
   * a writer at a gate that keeps saying no.
   *
   * So the operator's decision buys exactly **one** departure. That is the same
   * shape as `continuingOwnAutomaticResume` above — a local fact in one
   * `runTask` frame, cleared by the frame ending, never durable and never
   * assertable by a caller.
   *
   * **Declared here, above `stop`, and that placement is not cosmetic.** `stop`
   * closes over it to report `remediatedVerifyFailure`, and `stop` is called for
   * the invalid-step-budget refusal a few lines below — before this declaration
   * stood originally, which is a temporal-dead-zone `ReferenceError` on that
   * path. Reproduced in isolation, not reasoned about: a `const` arrow reading a
   * later `let` and invoked before it throws "Cannot access before
   * initialization". Typecheck does not catch it and no test reached that
   * refusal.
   *
   * **It is a fail-closed floor, and does not fire today.** Two things already
   * stop the cycle, and a counter-proof mutant removing this variable survived
   * every test, which is how that was established rather than assumed: a
   * `BLOCKED` loop step ends the `runTask` call unconditionally, and
   * `driveLifecycle` re-enters `runTask` only on `STEP_BUDGET_EXHAUSTED`, so a
   * `BLOCKED_VERIFY` outcome ends the lifecycle too. Either of those changing
   * would make the cycle reachable, and this is what would stop it then. It is
   * kept for the same reason the `isLoopDrivenState` floor below is kept, and it
   * is described as a floor rather than as the bound.
   */
  let verifyRemediationSpent = false;
  /**
   * Whether this call has already taken the operator's one departure from
   * `HUMAN_DECISION_REQUIRED`.
   *
   * A separate variable from `verifyRemediationSpent`, not a shared one. The two
   * decisions are bought separately and an invocation may legitimately be given
   * both flags for one task over two states, so a single counter would silently
   * make the second decision unusable after the first was spent.
   *
   * It is the same kind of fail-closed floor its sibling is, and that was
   * measured rather than assumed: a counter-proof mutant deleting this conjunct
   * survived the whole of `tests/run-driver.test.ts`, alongside a control mutant
   * that had to survive and did. The two mechanisms the sibling names — a
   * `BLOCKED` loop step ending the call unconditionally, and `driveLifecycle`
   * re-entering only on `STEP_BUDGET_EXHAUSTED` — apply to this state too. It is
   * kept for the same reason: it is the bound that would stop the cycle if
   * either of those changed, and a decision the operator buys once must not be
   * spendable twice by a loop that returns to the state it left.
   */
  let humanDecisionContinuationSpent = false;
  /** The third decision, bounded exactly as its two siblings are. */
  let usageLimitContinuationSpent = false;
  const stop = (from: Partial<RunResult> & { readonly outcome: RunOutcome }): RunResult =>
    runResult({
      taskId,
      permissionDenials,
      remediatedVerifyFailure: verifyRemediationSpent,
      continuedHumanDecision: humanDecisionContinuationSpent,
      continuedUsageLimit: usageLimitContinuationSpent,
      ...from,
    });

  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    return stop({ outcome: 'NO_PROGRESS', reasonCodes: Object.freeze(['STEP_BUDGET_INVALID']) });
  }

  const advance = Object.freeze({
    // No `repositoryRoot` here. `advanceTaskState` derives the write target from
    // the authority itself, so there is no second value to keep in step with it.
    //
    // Threaded into every durable transition this run makes, including the ones
    // `runLoopStep` reaches after an agent has been running for minutes.
    // `advanceTaskState` re-proves it against the file at the write, which is
    // the only moment that matters — see its header.
    lease: Object.freeze({ repository, evidence: request.lease }),
    ...(deps.replace !== undefined ? { replace: deps.replace } : {}),
    ...(deps.tempSuffix !== undefined ? { tempSuffix: deps.tempSuffix } : {}),
  });
  const observation = deps.exists !== undefined ? { exists: deps.exists } : {};

  let steps = 0;
  /** The revision the previous iteration read. Progress is this value moving. */
  let previousRevision: string | null = null;
  /**
   * The precise remediation brief the previous step produced, carried only
   * across the one edge it belongs to. Dropped otherwise, so a brief built for
   * one round can never be handed to another.
   */
  let remediationPayload: string | undefined;
  /**
   * Whether *this call* has already performed the automatic resume it is now
   * driving.
   *
   * A local, and that is the whole of its safety. The resume write moves the
   * task into a work-loop phase, so from the next iteration `classifyResume`
   * answers `ATTENDED_ONLY` about it — accurately. Without this flag an
   * `AUTOMATIC_RESUME_ONLY` run would refuse the continuation its own resume
   * authorised, having already spent `resumeFrom` and `reportedResetAt`: the
   * pause converted into an attended-only task with no work done, which is
   * V1-07-RR-B1's failure arriving one iteration later than it used to.
   *
   * It dies with this frame. A second `runTask` — the next invocation of the
   * lifecycle loop, or a later command — starts with it `false` and is refused
   * the same in-flight task, so the grant never becomes durable and never
   * becomes "run unattended".
   *
   * Within the frame it is **not** limited to the phase the resume entered. It
   * is set once and read on every remaining iteration, so the loop drives the
   * whole work cycle up to `maxSteps` — writer, verification, review,
   * remediation — exactly as an attended run would. That is the intended
   * behaviour and it is stated here because an earlier version of this comment
   * said "the phase that resume entered", which describes only the first
   * iteration after the write.
   */
  let continuingOwnAutomaticResume = false;

  // The budget bounds steps that **begin new work**.
  //
  // ── Why an outstanding remediation brief buys one more iteration ─────────
  //
  // A review's actionable content is its findings' `path` and `rule`, and
  // neither is persisted: the durable record keeps `{round, severity,
  // fingerprint}`, and a fingerprint is one-way by construction. The precise
  // brief lives in `remediationPayload` below — a local, which dies with this
  // frame. So a budget that expired between the review that produced it and the
  // remediation that consumes it silently downgraded the next writer's
  // instructions from "fix src/named.ts, rule e2e.named" to "something was
  // wrong in round 1", and the run *reported success*: `STEP_BUDGET_EXHAUSTED`
  // means "call again", and calling again is exactly what loses it.
  //
  // Both invocation models needed this. `run --attended` calls `runTask` once
  // and exits, so no in-memory carry is even possible there; `block --attended`
  // re-enters `runTask`, where the local is re-declared. Moving the boundary
  // fixes both; carrying the payload through the caller would fix one and would
  // re-open caller-authored prompt text, which both producers refuse.
  //
  // It terminates, and that is not an assumption: the extra iteration exists
  // only while a payload is outstanding, `runRemediateStep` consumes it, and the
  // assignment below clears it on any edge that is not `REMEDIATING`. The
  // overrun is therefore at most one step and cannot recur.
  //
  // Not persisting `path`/`rule` instead is deliberate: that would write
  // agent-authored free text into the durable record, and a persisted path is a
  // durable claim that can go stale — a renamed file would aim the writer at
  // something no reviewer ever saw. Fingerprints do not have that problem;
  // paths do.
  for (
    let iteration = 0;
    iteration < maxSteps || remediationPayload !== undefined;
    iteration += 1
  ) {
    // --- 0. Is this run still the repository's writer? -----------------------
    //
    // Re-proved every iteration, and *first*, for the same reason
    // reconciliation is re-run every iteration: the previous iteration was a
    // subprocess that took minutes, and the world it left behind is not the one
    // the previous check described. A lease is authority over the present.
    //
    // Ahead of reconciliation rather than beside it because it is the wider
    // question. Reconciliation asks whether this task's record matches reality;
    // this asks whether this process may act on the repository at all, and there
    // is no point establishing the first while the second is false.
    const lease = verifyExecutionLeaseHeldFor(repository, request.lease);
    if (lease.code !== 'HELD') {
      return stop({
        outcome: NEVER_HELD.has(lease.code) ? 'EXECUTION_LEASE_NOT_HELD' : 'EXECUTION_LEASE_LOST',
        steps,
        reasonCodes: Object.freeze([lease.code]),
      });
    }

    // --- 1. The record, and the world it claims to describe -----------------
    const reconciliation = await reconcileTask(deps.git, { repository, taskId }, observation);
    const loaded: StateLoadSuccess | null = reconciliation.load.ok ? reconciliation.load : null;

    // Terminal first, and deliberately *before* the world is judged.
    //
    // A finished or abandoned task has no outgoing transition, so nothing can
    // run whatever Git says — and asking anyway invites "your completed task
    // diverged", which is noise about something nobody is going to continue and
    // sends an operator to inspect a worktree they are done with.
    // `classifyResume` orders itself the same way and for the same reason.
    //
    // This never widens what runs: it is reached only for a state that loaded
    // *and* belongs to this repository and this task — a record of somewhere
    // else fails the load, not the comparison — and it always stops.
    if (loaded !== null && isTerminalState(loaded.state.state)) {
      return stop({
        outcome: loaded.state.state === 'READY_FOR_PR' ? 'TASK_COMPLETED' : 'TASK_ABORTED',
        state: loaded.state.state,
        steps,
        reconciliation,
      });
    }

    if (reconciliation.outcome !== 'RECONCILED') {
      return stop({
        outcome: outcomeForReconciliation(reconciliation),
        state: reconciliation.state?.state ?? null,
        steps,
        reasonCodes: reconciliation.reasonCodes,
        reconciliation,
      });
    }

    // `RECONCILED` implies both of these. Checked rather than asserted because
    // a fail-closed floor costs one branch and an unchecked assumption costs a
    // step executed against a state nobody loaded.
    const load = loaded;
    const observed = reconciliation.observed;
    if (load === null || observed === null) {
      return stop({ outcome: 'STATE_UNUSABLE', steps, reconciliation });
    }
    const state = load.state;

    // --- 2. Did the previous iteration actually change anything? ------------
    // Measured on the durable bytes, never on the outcome a step returned. A
    // step that reports progress whose write did not land would otherwise be
    // driven round the same phase until the budget ran out.
    if (previousRevision !== null && load.revision === previousRevision) {
      return stop({
        outcome: 'NO_PROGRESS',
        state: state.state,
        steps,
        reasonCodes: Object.freeze(['DURABLE_STATE_UNCHANGED']),
        reconciliation,
      });
    }
    previousRevision = load.revision;

    // --- 3. May anything continue, and on whose authority? ------------------
    const resume = classifyResume(state, observed, {
      now: deps.now(),
      authEvidence: request.authEvidence,
      repository,
      taskId,
    });

    // Unreachable while `TERMINAL` and `isTerminalState` agree, which the
    // terminal gate above already acted on. Kept as a fail-closed floor so that
    // a widened terminal vocabulary stops the run rather than falling through
    // into the blocking and execution gates below.
    if (resume.continuation === 'TERMINAL') {
      return stop({
        outcome: state.state === 'READY_FOR_PR' ? 'TASK_COMPLETED' : 'TASK_ABORTED',
        state: state.state,
        steps,
        reconciliation,
        resume,
      });
    }

    // A durably blocked task stops here, whatever else is true, unless the one
    // authority that may continue one said so. This is where
    // `HUMAN_DECISION_REQUIRED` is refused a resume, `BLOCKED_VERIFY` is
    // refused a retry, and a refused quota resume is reported with the checks
    // that denied it.
    // The one blocked-state departure an operator can ask for, and every
    // conjunct is load-bearing:
    //
    //  - the state is `BLOCKED_VERIFY`. No other block is reachable this way;
    //    `SCOPE_VIOLATION` is not resumable at all, and `HUMAN_DECISION_REQUIRED`
    //    is a different decision that this flag does not claim to be;
    //  - the operator asked on *this* invocation;
    //  - the grant is `ATTENDED`. `mayRemediateVerifyFailure` refuses
    //    `AUTOMATIC_RESUME_ONLY`, so no unattended run reaches this however it is
    //    invoked, and `BLOCKED_VERIFY` stays `automaticResumeEligible: false`;
    //  - the resume point names `REMEDIATE`. The authority is "continue this
    //    block to remediation", so a record naming any other phase is refused
    //    rather than followed — a task whose resume point has been hand-edited
    //    does not get to choose which phase this decision enters;
    //  - this invocation has not already spent it. See `verifyRemediationSpent`.
    //
    // It cannot produce `AUTOMATIC_ALLOWED` and does not try to: `resume` is
    // still whatever `classifyResume` said, every gate below still runs, and the
    // resume write at step 6 is still `resumeBlockedTask` unchanged.
    const remediatingVerifyFailure =
      state.state === 'BLOCKED_VERIFY' &&
      request.remediateVerifyFailure === true &&
      mayRemediateVerifyFailure(request.continuationGrant) &&
      state.resumeFrom !== null &&
      state.resumeFrom.phase === 'REMEDIATE' &&
      !verifyRemediationSpent;

    // The same shape for `HUMAN_DECISION_REQUIRED`, and every conjunct is
    // load-bearing for the same reasons — with one deliberate difference.
    //
    // There is **no phase term**. Its sibling above pins `REMEDIATE` because
    // `BLOCKED_VERIFY` declares exactly one outgoing edge, so a record naming
    // any other phase is a record that has been tampered with. This state
    // declares four, and which one applies is the record's to say, not the
    // operator's and not this line's. What replaces the pin is the check that
    // was already there: the write below refuses a resume point that names a
    // phase the loop does not drive (`RESUME_PHASE_NOT_DRIVEN`), so a nonsense
    // record is still refused — before the write, and by the gate that owns
    // that question.
    //
    // `state.resumeFrom !== null` is kept and is not redundant with
    // `resumeFromRequirement: 'REQUIRED'`: that requirement describes what a
    // valid record carries, and this is a read of one particular record.
    const continuingHumanDecision =
      state.state === 'HUMAN_DECISION_REQUIRED' &&
      request.continueHumanDecision === true &&
      mayContinueHumanDecision(request.continuationGrant) &&
      state.resumeFrom !== null &&
      !humanDecisionContinuationSpent;

    // The third, and the one conjunct its siblings have no equivalent of.
    //
    // `usageLimitContinuation` is what keeps this door shut on every block that
    // can still clear itself, and it is a *call into the resume policy* rather
    // than a second reading of it. It permits exactly the states whose own
    // record makes an automatic resume impossible — no reset instant recorded,
    // an instant that is not a timestamp, or a resume record that was withdrawn
    // after the reset had already passed — and refuses everything else. A future
    // instant is `RESET_AHEAD`: the machine knows when the quota returns and an
    // escape that overrode that would start an agent before its window, which is
    // the waste M2 slice 6 exists to stop. A past instant over an intact record
    // is `MACHINE_MAY_STILL_RESUME`: the automatic path grants that one unless
    // the *world* denies, and this decision carries no evidence about the world.
    //
    // Until M3 slice 2 the term was `state.reportedResetAt === null`, which is
    // the `RESET_UNRECORDED` reading above and nothing else. It was too narrow
    // by one shape and the gap was measured, not argued: a block written with
    // its interruption checkpoint withdrawn records a reset **and** cannot be
    // resumed from, and every command in the build refused it. See that module's
    // header for the reproduction.
    //
    // No phase term, for the reason its `HUMAN_DECISION_REQUIRED` sibling gives:
    // this state declares three work-loop edges and the record says which one,
    // while `RESUME_PHASE_NOT_DRIVEN` still refuses a nonsense point at the
    // write. `state.resumeFrom !== null` is kept beside it all the same, and is
    // not redundant with the reading's own `RESUME_POINT_MISSING` refusal: this
    // is the read of one particular record that the write below depends on.
    //
    // Read once per iteration and used twice: the permission below, and the
    // reading carried out to the operator on the refusal. One read rather than
    // two so that a clock crossing the reset instant between them cannot make
    // the report disagree with the decision it is reporting.
    const quota =
      state.state === 'BLOCKED_USAGE_LIMIT' ? usageLimitContinuation(state, deps.now()) : null;

    const continuingUsageLimit =
      state.state === 'BLOCKED_USAGE_LIMIT' &&
      quota !== null &&
      quota.permitted &&
      request.continueUsageLimit === true &&
      mayContinueUsageLimit(request.continuationGrant) &&
      state.resumeFrom !== null &&
      !usageLimitContinuationSpent;

    if (
      isBlockingState(state.state) &&
      resume.continuation !== 'AUTOMATIC_ALLOWED' &&
      !remediatingVerifyFailure &&
      !continuingHumanDecision &&
      !continuingUsageLimit
    ) {
      return stop({
        outcome: BLOCKING_OUTCOME[state.state],
        state: state.state,
        steps,
        reasonCodes: resume.reasonCodes,
        reconciliation,
        resume,
        ...(quota === null ? {} : { usageLimitContinuation: quota.reading }),
      });
    }

    // --- 4. Is *this invocation* cleared to continue at all? ----------------
    //
    // Ahead of every durable write, and that ordering is the whole point
    // (V1-07-RR-B1). The caller's grant is a second requirement on top of the
    // authority module's answer, so an invocation without it will refuse to
    // execute whatever `classifyResume` said — and a resume written first would
    // then be a state change made by a run that never did any work.
    //
    // For a blocked task the cost of that ordering is not a lost step but a
    // lost *pause*: `resumeBlockedTask` spends `resumeFrom`, `reportedResetAt`
    // and `blockedAgent`, and the work-loop state it lands in classifies
    // `ATTENDED_ONLY` from then on. So a run that wrote the resume and then
    // stopped would have converted a self-clearing quota block into a task no
    // unattended run can ever pick up, having executed nothing. The grant is
    // therefore checked before the write, never after it.
    //
    // The invariant, stated as the one that actually holds: **no invocation
    // grant can manufacture `AUTOMATIC_ALLOWED`.** The verdict is computed from
    // the grant *and* `resume.continuation`, so `AUTOMATIC_RESUME_ONLY` is
    // *entered* only where the one authority that produces `AUTOMATIC_ALLOWED`
    // already did. It reads that value and nothing else — not the state name,
    // not the reconciliation verdict — because a blocked task can be
    // `BLOCKED_USAGE_LIMIT` and reconcile perfectly while the resume is refused,
    // and a grant that consulted either would be a second, weaker copy of the
    // decision it is supposed to depend on.
    //
    // This paragraph said "narrows and never widens, and V3-08 did not change
    // that" while the widening was described nine lines below it. There is
    // exactly one, it is named `continuingOwnAutomaticResume`, and it extends
    // nothing except the resume **this same frame** already performed under an
    // authorisation this gate granted.
    //
    // The blocking gate above already stopped a blocked task without
    // `AUTOMATIC_ALLOWED`, so what this arm actually refuses under
    // `AUTOMATIC_RESUME_ONLY` is the *in-flight* case — a reconciled
    // `IMPLEMENTING` or `REVIEWING`, which classifies `ATTENDED_ONLY`. That is
    // the whole difference between "resume a self-clearing pause" and "run
    // unattended", and it is enforced here rather than argued for.
    //
    // With one exception, and it is local: an in-flight task **this call itself
    // just resumed** is the continuation the resume authorised, so the third
    // argument carries it — for the rest of this call, not for one phase. See
    // `continuingOwnAutomaticResume` above for why refusing there would spend a
    // pause and do no work, and why the permission cannot outlive this frame.
    //
    // ── And why the third operator decision is a disjunct here (M2-06) ─────
    //
    // Its two siblings need nothing at this gate: `BLOCKED_VERIFY` and
    // `HUMAN_DECISION_REQUIRED` are both `automaticResumeEligible: false`, so
    // `classifyResume` calls them `HUMAN_DECISION_REQUIRED` and
    // `continuationFor` maps that to `ATTENDED_ONLY`, which `ATTENDED` permits.
    //
    // `BLOCKED_USAGE_LIMIT` is the state that *is* eligible, so a denied
    // automatic resume classifies `AUTOMATIC_RESUME_REFUSED` and maps to
    // `BLOCKED` — a value no grant permits. That is the right answer to the
    // question this gate asks, "may this run continue **on its own**", and it
    // is not the question the flag answers. Without the disjunct the operator's
    // decision would pass the blocking gate and die here, which is how it was
    // measured before this line existed.
    //
    // Expressed at the call site rather than by widening `permitsContinuation`,
    // which stays a pure function of the two vocabularies: an operator's
    // sentence is a third input, and folding it in would make one grant look
    // like an authority it is not. It widens nothing either —
    // `continuingUsageLimit` has already required `ATTENDED`, this exact state,
    // a **record the machine cannot wait out**, a recorded resume point and an
    // unspent decision. The iteration after the resume needs none of this: the task is
    // then in-flight and classifies `ATTENDED_ONLY` like any other.
    const granted = permitsContinuation(
      request.continuationGrant,
      resume.continuation,
      continuingOwnAutomaticResume,
    );
    if (!granted.permitted && !continuingUsageLimit) {
      return stop({
        outcome: 'CONTINUATION_NOT_AUTHORISED',
        state: state.state,
        steps,
        reasonCodes: Object.freeze([granted.refusal]),
        reconciliation,
        resume,
      });
    }

    // --- 5. Where may this run execute? -------------------------------------
    // Also ahead of the resume write, and for the same reason: a run with no
    // authorised directory cannot drive the phase it would resume into, so
    // writing the resume would spend the pause on nothing.
    const authorisedWorktreePath = observed.authorisedWorktreePath;
    if (authorisedWorktreePath === null) {
      return stop({
        outcome: 'EXECUTION_UNAUTHORISED',
        state: state.state,
        steps,
        reconciliation,
        resume,
      });
    }

    // --- 6. A blocked task's resume, once every gate above has passed -------
    if (
      resume.continuation === 'AUTOMATIC_ALLOWED' ||
      remediatingVerifyFailure ||
      continuingHumanDecision ||
      continuingUsageLimit
    ) {
      // The phase this resume would enter must be one this run can actually
      // continue from, and that is checked *before* the write for the same
      // reason the attended grant is (V1-07-RR-B1).
      //
      // `resumeBlockedTask` spends `resumeFrom`, `reportedResetAt` and
      // `blockedAgent`, and withdraws the checkpoint claims for a mutating
      // target. If the phase it enters were one `runLoopStep` does not drive,
      // the next iteration would return `NOT_APPLICABLE` and the run would
      // stop with `NO_PROGRESS`, having done no work at all — leaving the task
      // in a phase nothing advances, without the resume point, the reset time
      // or the checkpoint facts a later run would need to try again. A
      // self-clearing pause would have become a task no run can pick up.
      //
      // RR-B1 closed this on the axis of "this run will refuse to execute".
      // This is the same loss on the axis of "the phase is a dead end", and the
      // same rule applies: every gate that decides whether the run may act
      // comes before the durable write (V1-08).
      //
      // **This gate no longer fires from a legal resume point.** `IMPLEMENT`
      // was the case it existed for, and V2-04 added the implement step, so
      // all four resume phases now name states the loop drives. It is kept as
      // a fail-closed floor: `resumePointToState` and `LOOP_DRIVEN_STATES` are
      // separate vocabularies, and a future phase added to one and not the
      // other would land here rather than spending a pause on a dead end.
      const target = state.resumeFrom === null ? null : resumePointToState(state.resumeFrom);
      if (target === null || !isLoopDrivenState(target)) {
        return stop({
          outcome: 'CONTINUATION_NOT_AUTHORISED',
          state: state.state,
          steps,
          reasonCodes: Object.freeze([
            target === null ? 'RESUME_POINT_MISSING' : 'RESUME_PHASE_NOT_DRIVEN',
          ]),
          reconciliation,
          resume,
        });
      }

      const resumed = resumeBlockedTask(load, deps.now(), advance);
      if (resumed === null) {
        return stop({
          outcome: 'CONTINUATION_NOT_AUTHORISED',
          state: state.state,
          steps,
          reasonCodes: Object.freeze(['RESUME_POINT_MISSING']),
          reconciliation,
          resume,
        });
      }
      if (!resumed.save.ok) {
        return stop({
          // The same three-way split as the loop's write below. A review found
          // this site still folding a lost lease into `STATE_NOT_RECORDED` —
          // the collapse `RUN_OUTCOMES` exists to prevent — because the fix was
          // applied to its sibling and not to it. The window is real: the
          // step-0 gate and this write are separated by a reconciliation and its
          // Git subprocesses.
          outcome:
            resumed.save.code === 'EXECUTION_LEASE_LOST'
              ? 'EXECUTION_LEASE_LOST'
              : resumed.save.code === 'STATE_CONFLICT'
                ? 'STATE_CONFLICT'
                : 'STATE_NOT_RECORDED',
          state: state.state,
          steps,
          reasonCodes: Object.freeze([resumed.save.code]),
          reconciliation,
          resume,
        });
      }
      // The resume is itself a durable step, and the phase it entered is what
      // the next iteration reconciles and drives. Nothing was executed here.
      //
      // Set **after** the write landed, never before it and never on any path
      // that refused: the flag means "this run really did resume this task",
      // and a run that only intended to must not inherit the permission.
      //
      // Each arm names the conjunct that actually fired rather than deducing it
      // from the other two. An `else` that meant "therefore the verify
      // remediation" was correct while that was the only operator decision here;
      // with a second one it would mark the wrong decision spent, leaving the
      // operator's real departure unaccounted for and the one they did not use
      // consumed.
      if (resume.continuation === 'AUTOMATIC_ALLOWED') {
        continuingOwnAutomaticResume = true;
      } else if (remediatingVerifyFailure) {
        // The operator's decision is spent here, and only here: after the write
        // landed, never before it and never on any path that refused. A run that
        // only intended to continue must not inherit the permission, and — more
        // to the point — must not have consumed it either, or a refused write
        // would silently cost the operator their one departure.
        verifyRemediationSpent = true;
      } else if (continuingUsageLimit) {
        usageLimitContinuationSpent = true;
      } else {
        humanDecisionContinuationSpent = true;
      }
      steps += 1;
      remediationPayload = undefined;
      continue;
    }

    // --- 7. One step -------------------------------------------------------
    const step = await runLoopStep(load, {
      ...advance,
      now: deps.now(),
      authorisedWorktreePath,
      verification: repository.verification,
      // Read fresh each iteration rather than once per run: a task file can be
      // corrected between steps, and a driver holding a stale answer would
      // park a task a human has already fixed. Reading it is not authoring it
      // — the words are the repository's, and this module still writes none.
      //
      // Proven against `authorisedWorktreePath`, never against the repository
      // root: that is the tree the agents this loop starts will open, and the
      // one the payload names. The path Git printed, not the one the record
      // claims — the same authority every other execution input here uses.
      brief: readExecutionBrief(repository, taskId, authorisedWorktreePath),
      // The same Git this driver reconciled with, handed down rather than left
      // to be reached for. A mutating step's scope guard asks the repository
      // what the writer actually did (V2-06); if it resolved its own runner,
      // this run would be observing one Git and enforcing against another.
      git: deps.git,
      ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
      ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
      ...(deps.observe !== undefined ? { observe: deps.observe } : {}),
      ...(remediationPayload !== undefined ? { remediationPayload } : {}),
    });

    // Merged before the outcome is read, so a step that blocked contributes as
    // much as one that advanced: being refused a tool is not less true because
    // the step it happened in went on to fail.
    if (step.permissionDenials !== null) {
      permissionDenials = mergePermissionDenials(permissionDenials, step.permissionDenials);
    }

    const stopped = {
      state: step.state ?? state.state,
      steps: steps + 1,
      reconciliation,
      resume,
      lastStep: step,
    };

    switch (step.outcome) {
      case 'ADVANCED':
        steps += 1;
        // Carried only onto the edge that produced it. A payload is built from
        // one review's findings, so handing it to any other pass would brief a
        // writer on work that is not in front of it.
        remediationPayload =
          step.state === 'REMEDIATING' && step.remediationPayload !== null
            ? step.remediationPayload
            : undefined;
        continue;

      case 'COMPLETED':
        return stop({ outcome: 'TASK_COMPLETED', ...stopped });

      case 'BLOCKED':
        return stop({
          outcome:
            step.state !== null && isBlockingState(step.state)
              ? BLOCKING_OUTCOME[step.state]
              : 'HUMAN_DECISION_REQUIRED',
          ...stopped,
        });

      case 'STATE_NOT_RECORDED':
        return stop({
          // A lease lost *during* the step surfaces here, because the write is
          // where it is caught. It must keep its own outcome: `RUN_OUTCOMES`
          // separates these precisely because they send an operator to different
          // places, and folding a lost authority into "a write was refused for
          // some other reason" is the collapse that vocabulary exists to prevent.
          outcome:
            step.save !== null && !step.save.ok && step.save.code === 'EXECUTION_LEASE_LOST'
              ? 'EXECUTION_LEASE_LOST'
              : step.save !== null && !step.save.ok && step.save.code === 'STATE_CONFLICT'
                ? 'STATE_CONFLICT'
                : 'STATE_NOT_RECORDED',
          ...stopped,
          state: state.state,
          steps,
          // The code *and* its detail: `LEASE_ABSENT`, `NOT_OWNER` and
          // `LEASE_UNREADABLE` are "cleared", "taken over by a successor" and
          // "could not be read", which send an operator to three different
          // places. Forwarding only the code drops that.
          reasonCodes:
            step.save !== null && !step.save.ok
              ? Object.freeze(
                  step.save.detail === null
                    ? [step.save.code]
                    : [step.save.code, step.save.detail],
                )
              : Object.freeze([]),
        });

      case 'NOT_APPLICABLE':
        return stop({ ...stopped, outcome: 'NO_PROGRESS', state: state.state, steps });

      case 'EXECUTION_UNAUTHORISED':
        // The loop refused the authority this driver handed it — the observed
        // path did not denote the directory the state records. Nothing ran.
        return stop({
          ...stopped,
          outcome: 'EXECUTION_UNAUTHORISED',
          state: state.state,
          steps,
        });
    }
  }

  // The budget ran out, and the last step was never re-proved — the check is at
  // the *top* of an iteration, so nothing looked after the final one. That
  // matters here more than it looks: `STEP_BUDGET_EXHAUSTED` is the one outcome
  // documented as "call again", it exits 5, and a scheduler acts on it. Handing
  // that back for a run that has lost authority tells the caller everything is
  // fine and to continue. One syscall says otherwise.
  const stillHeld = verifyExecutionLeaseHeldFor(repository, request.lease);
  if (stillHeld.code !== 'HELD') {
    return stop({
      outcome: NEVER_HELD.has(stillHeld.code)
        ? 'EXECUTION_LEASE_NOT_HELD'
        : 'EXECUTION_LEASE_LOST',
      steps,
      reasonCodes: Object.freeze([stillHeld.code]),
    });
  }

  return stop({
    outcome: 'STEP_BUDGET_EXHAUSTED',
    state: null,
    steps,
  });
}

/**
 * Performs the one transition an unattended resume authorises.
 *
 * `null` when the state carries no resume point — impossible for a decision
 * `evaluateAutomaticResume` allowed, which denies `RESUME_POINT_MISSING`, and
 * checked anyway because the alternative is dereferencing a value on the
 * strength of another module's reasoning.
 *
 * The successor is spelled out rather than spread blindly: `blockedAgent` must
 * be `null` in a regular state, and the resume point and reset time that
 * described the pause are spent the moment the pause ends. `advanceTaskState`
 * still judges the edge, and the contract still judges the result, so this
 * cannot reach a phase the table does not declare.
 *
 * ── The checkpoint the resumed phase is about to invalidate (V1-07-RR-B2) ───
 *
 * `currentCommit` and `worktreeCleanAtCheckpoint` are exactly the evidence
 * `evaluateAutomaticResume` demanded before it allowed this resume — but they
 * describe the worktree as the *pause* left it, not as the resumed phase will
 * leave it. Carrying them into `IMPLEMENTING` or `REMEDIATING` re-asserts "this
 * task is at a known HEAD with a clean tree" about a phase whose whole purpose
 * is to modify the worktree, and `reconcile.ts` reads that assertion literally:
 * a writer's own commit becomes `CURRENT_COMMIT_MOVED` and its own uncommitted
 * work becomes `WORKTREE_DIRTY`, verdict `DIVERGED` — for the mutation this
 * driver itself authorised. So the claims are withdrawn on the same write that
 * enters the phase, exactly as the loop's own writing edge and the interruption
 * path already do, from the one table that says which phases mutate.
 *
 * Withdrawn only for a mutating target. `REVIEWING` is contractually read-only,
 * and discarding true evidence there would deny a later resume the checkpoint
 * it was entitled to.
 */
function resumeBlockedTask(
  load: StateLoadSuccess,
  now: string,
  advance: AdvanceOptions,
): { readonly save: ReturnType<typeof advanceTaskState> } | null {
  const state = load.state;
  if (state.resumeFrom === null) return null;

  const target = resumePointToState(state.resumeFrom);

  return {
    save: advanceTaskState(
      load,
      {
        ...state,
        state: target,
        stateEnteredAt: now,
        blockedAgent: null,
        ...RESUME_EVIDENCE_SPENT,
        ...withdrawnCheckpointFor(target),
      },
      advance,
    ),
  };
}

/* ─────────────────────────── task selection ─────────────────────────────── */

/**
 * Why this run has, or has not, a task to drive.
 *
 * The planner's own vocabulary, plus one member for a plan that could not be
 * read at all. They stay apart for the reason `plan-next-task.ts` gives: "the
 * task source is empty", "two tasks depend on each other" and "nothing is
 * eligible" are three different answers, and a driver that flattened them would
 * report a broken plan as a finished one.
 */
export const RUN_SELECTION_CODES = [
  'TASK_SELECTED',
  /** The plan is non-empty and every task in it is `DONE`. */
  'ALL_TASKS_COMPLETE',
  /** Open work exists but nothing is eligible. A fail-closed floor. */
  'NO_ELIGIBLE_TASK',
  /** The plan could not be read or normalised. `planning.code` says why. */
  'PLANNING_FAILED',
] as const;

export type RunSelectionCode = (typeof RUN_SELECTION_CODES)[number];

export interface RunSelection {
  readonly code: RunSelectionCode;
  /** The chosen task, or `null` for every other code. */
  readonly task: TaskDefinition | null;
  /**
   * The planner's full answer, including the eligibility of every task and the
   * ranking that produced the winner. The reasoning is part of the answer.
   */
  readonly planning: TaskPlanningResult;
  readonly reasonCodes: readonly string[];
}

/**
 * Answers "which task now?" using the repository's own selector.
 *
 * It adds no ordering, no filter and no eligibility rule of its own. A driver
 * that re-decided any of those would be a second scheduling policy, disagreeing
 * with the published ranking that is supposed to be the reasoning.
 */
export function selectRunTask(repository: ResolvedRepository): RunSelection {
  const planning = planNextTask(repository);

  if (!planning.ok) {
    return Object.freeze({
      code: 'PLANNING_FAILED' as const,
      task: null,
      planning,
      reasonCodes: Object.freeze([planning.code]),
    });
  }

  const { selection } = planning;
  if (selection.code === 'TASK_SELECTED' && selection.selected !== null) {
    return Object.freeze({
      code: 'TASK_SELECTED' as const,
      task: selection.selected,
      planning,
      reasonCodes: Object.freeze([]),
    });
  }

  return Object.freeze({
    code: selection.code === 'ALL_TASKS_COMPLETE' ? ('ALL_TASKS_COMPLETE' as const) : ('NO_ELIGIBLE_TASK' as const),
    task: null,
    planning,
    // The ineligible tasks name themselves, so an operator asking "why is there
    // nothing to do?" gets the blocked ids rather than a bare code.
    reasonCodes: Object.freeze(
      selection.eligibility.filter((entry) => !entry.eligible).map((entry) => entry.taskId),
    ),
  });
}

export interface RunNextRequest extends Omit<RunRequest, 'taskId'> {
}

export interface RunNextResult {
  readonly selection: RunSelection;
  /** The run, or `null` when there was no task to drive. */
  readonly run: RunResult | null;
}

/**
 * Selects a task and drives it.
 *
 * Exactly one task per call. See the module header for why there is no second:
 * a task's completion for queue purposes is stated by the repository's own task
 * file, and nothing in this build writes one.
 */
export async function runNextTask(
  request: RunNextRequest,
  deps: RunDependencies,
): Promise<RunNextResult> {
  const selection = selectRunTask(request.repository);
  if (selection.code !== 'TASK_SELECTED' || selection.task === null) {
    return Object.freeze({ selection, run: null });
  }

  const task = selection.task;
  const run = await runTask(
    {
      repository: request.repository,
      taskId: task.id,
      continuationGrant: request.continuationGrant,
      authEvidence: request.authEvidence,
      lease: request.lease,
      maxSteps: request.maxSteps,
    },
    deps,
  );

  return Object.freeze({ selection, run });
}
