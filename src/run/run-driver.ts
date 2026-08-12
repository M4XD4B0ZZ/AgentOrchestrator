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
 *  0. `verifyExecutionLeaseHeld` — is this process still the repository's one
 *     writer? Re-proved against the file every iteration, not carried from the
 *     start of the run, and asked first because it is the only gate that is
 *     about the repository rather than about this task (V2-07L);
 *  1. `reconcileTask` — load the durable state *and* compare it against what
 *     Git says right now. `RECONCILED` is the only outcome anything continues
 *     from;
 *  2. `classifyResume` — decide what, if anything, may continue. Only
 *     `AUTOMATIC_ALLOWED` continues a *blocked* task, and it has exactly one
 *     source, which this module feeds rather than re-implements;
 *  3. `attendedContinuation` — whether *this invocation* is cleared to continue
 *     at all. A second requirement on top of the authority module's answer,
 *     and one this run either has or does not;
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
import { verifyExecutionLeaseHeld } from '../lease/execution-lease.js';
import { withdrawnCheckpointFor } from '../core/agent-phases.js';
import { resumePointToState } from '../core/resume-policy.js';
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
import { advanceTaskState } from '../state/advance-state.js';
import {
  reconcileTask,
  stopSpellingFor,
  type TaskReconciliation,
} from '../state/reconcile-task.js';
import { classifyResume, type ResumeDecision } from '../state/resume-decision.js';
import type { ReplaceFn, TempSuffixFn } from '../state/atomic-file.js';
import type { StateLoadSuccess } from '../state/state-store.js';
import type { AgentRunner } from '../agent/agent-command.js';
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
   * stale, by a wiped administrative directory — or replaced by a successor. The
   * run stops where it stands rather than finishing "the step it was already
   * doing": there is no such thing as a little bit of exclusive access, and the
   * next durable write would be a second writer's.
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
}

/* ──────────────────────────── the inputs ────────────────────────────────── */

export interface RunRequest {
  /** The repository, already resolved. This module resolves nothing. */
  readonly repository: ResolvedRepository;
  /** The task to drive. */
  readonly taskId: string;
  /** What the task is, in the reviewer's and writer's own words. */
  readonly taskBrief: string;
  /**
   * Whether this run may continue a task that reconciles but is not cleared for
   * unattended execution.
   *
   * `classifyResume` reports a healthy in-flight task as `ATTENDED_ONLY`,
   * because "the record is accurate" and "carry on without me" are different
   * statements — the most common thing that reconciles is an interrupted task
   * with half-written work in its worktree. This flag is the operator saying
   * they are present for *this run*. It is a second requirement on top of the
   * authority module's answer and never a substitute for it: it can only ever
   * narrow what runs, and it grants nothing for a *blocked* task, which moves
   * only on `AUTOMATIC_ALLOWED` and stops on anything else whatever is set
   * here.
   *
   * Because it is a requirement on the *invocation*, it is checked before any
   * durable write, including the one an unattended resume authorises. A run
   * that will refuse to execute must not first spend a task's resume evidence
   * on a transition it cannot follow up (V1-07-RR-B1).
   */
  readonly attendedContinuation: boolean;
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
   * of a non-blocked task never consults it. Operator presence
   * ({@link attendedContinuation}) and auth evidence are independent
   * requirements, and neither substitutes for the other.
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
  const { repository, taskId, taskBrief, maxSteps } = request;
  const stop = (from: Partial<RunResult> & { readonly outcome: RunOutcome }): RunResult =>
    runResult({ taskId, ...from });

  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    return stop({ outcome: 'NO_PROGRESS', reasonCodes: Object.freeze(['STEP_BUDGET_INVALID']) });
  }

  const advance = Object.freeze({
    // From the resolved repository, never from the state that is about to be
    // written: the store compares the two and refuses a disagreement, and
    // taking both from one side would make that check compare a value with
    // itself.
    repositoryRoot: repository.root,
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

  for (let iteration = 0; iteration < maxSteps; iteration += 1) {
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
    const lease = verifyExecutionLeaseHeld(request.lease);
    if (lease.code !== 'HELD') {
      return stop({
        outcome:
          lease.code === 'EVIDENCE_INVALID' ? 'EXECUTION_LEASE_NOT_HELD' : 'EXECUTION_LEASE_LOST',
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
    if (isBlockingState(state.state) && resume.continuation !== 'AUTOMATIC_ALLOWED') {
      return stop({
        outcome: BLOCKING_OUTCOME[state.state],
        state: state.state,
        steps,
        reasonCodes: resume.reasonCodes,
        reconciliation,
        resume,
      });
    }

    // --- 4. Is *this invocation* cleared to continue at all? ----------------
    //
    // Ahead of every durable write, and that ordering is the whole point
    // (V1-07-RR-B1). The operator's grant is a second requirement on top of the
    // authority module's answer, so an invocation without it will refuse to
    // execute whatever `classifyResume` said — and a resume written first would
    // then be a state change made by a run that never did any work.
    //
    // For a blocked task the cost of that ordering is not a lost step but a
    // lost *pause*: `resumeBlockedTask` spends `resumeFrom`, `reportedResetAt`
    // and `blockedAgent`, and the work-loop state it lands in classifies
    // `ATTENDED_ONLY` from then on. So an unattended run that wrote the resume
    // and then stopped would have converted a self-clearing quota block into a
    // task no unattended run can ever pick up, having executed nothing. The
    // grant is therefore checked before the write, never after it.
    //
    // This narrows and never widens. `AUTOMATIC_ALLOWED` remains necessary for
    // a blocked task to move — nothing here can substitute for it — and this
    // flag can still only withhold.
    if (!request.attendedContinuation) {
      return stop({
        outcome: 'CONTINUATION_NOT_AUTHORISED',
        state: state.state,
        steps,
        reasonCodes: Object.freeze(['ATTENDED_CONTINUATION_NOT_GRANTED']),
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
    if (resume.continuation === 'AUTOMATIC_ALLOWED') {
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
          outcome: resumed.save.code === 'STATE_CONFLICT' ? 'STATE_CONFLICT' : 'STATE_NOT_RECORDED',
          state: state.state,
          steps,
          reasonCodes: Object.freeze([resumed.save.code]),
          reconciliation,
          resume,
        });
      }
      // The resume is itself a durable step, and the phase it entered is what
      // the next iteration reconciles and drives. Nothing was executed here.
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
      taskBrief,
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
          outcome:
            step.save !== null && !step.save.ok && step.save.code === 'STATE_CONFLICT'
              ? 'STATE_CONFLICT'
              : 'STATE_NOT_RECORDED',
          ...stopped,
          state: state.state,
          steps,
          reasonCodes:
            step.save !== null && !step.save.ok
              ? Object.freeze([step.save.code])
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
  advance: { readonly repositoryRoot: string; readonly replace?: ReplaceFn; readonly tempSuffix?: TempSuffixFn },
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

export interface RunNextRequest extends Omit<RunRequest, 'taskId' | 'taskBrief'> {
  /**
   * Builds the brief handed to the agents for the selected task.
   *
   * A function, because the task is not known until the selector has spoken —
   * and supplied by the caller rather than composed here, because a brief is
   * prompt text and this module authors none.
   */
  readonly taskBrief: (task: TaskDefinition) => string;
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
      taskBrief: request.taskBrief(task),
      attendedContinuation: request.attendedContinuation,
      authEvidence: request.authEvidence,
      lease: request.lease,
      maxSteps: request.maxSteps,
    },
    deps,
  );

  return Object.freeze({ selection, run });
}
