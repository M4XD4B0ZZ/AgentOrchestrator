/**
 * The exit-code contract of `agent-loop run`.
 *
 * One small closed set of codes, and two total mappings onto it: one for the
 * plan conclusions the command produces today, one for the run outcomes the
 * execution mode will produce when it exists. The second table is defined and
 * pinned now, deliberately: the vocabulary of `run-driver.ts` insists that
 * "the quota ran out", "a human must decide" and "another writer got there
 * first" send an operator to different places, and an exit-code scheme bolted
 * on later would be designed under pressure to collapse them. Fixing the
 * mapping while nothing depends on it is the cheap moment to fix it.
 *
 * ── The codes ──────────────────────────────────────────────────────────────
 *
 * | Code | Meaning |
 * | ---- | ------- |
 * | 0    | Nominal. The answer is actionable or the work is finished.       |
 * | 1    | Unexpected failure inside the tool. Global convention (AO-002).  |
 * | 2    | The input situation is unusable: repository, plan or named task. |
 * | 3    | The durable state needs an operator before anything may run.     |
 * | 4    | This invocation was refused or achieved nothing; the state may   |
 * |      | be fine. Re-invoking under other conditions can differ.          |
 * | 5    | Budget exhausted mid-drive: call again to continue.              |
 *
 * `NO_PROGRESS` remains one outcome for more than one situation (the V1-07
 * followup recorded as R-2/R-3); its exit code is uniformly 4, and the finer
 * distinction stays where it already lives — in `reasonCodes`. Splitting the
 * outcome itself is the execution slice's decision, not this table's.
 */

import type { RunOutcome } from '../run/run-driver.js';
import { RUN_PLAN_CONCLUSIONS, type RunPlanConclusion } from '../run/run-plan.js';

export const EXIT_RUN_OK = 0;
export const EXIT_RUN_UNEXPECTED = 1;
export const EXIT_RUN_INPUT_UNUSABLE = 2;
export const EXIT_RUN_NEEDS_OPERATOR = 3;
export const EXIT_RUN_REFUSED = 4;
export const EXIT_RUN_CALL_AGAIN = 5;

/** Exit code for every plan conclusion. Total; pinned by test. */
const PLAN_EXIT_CODES: Readonly<Record<RunPlanConclusion, number>> = Object.freeze({
  // Nominal answers: the operator got exactly what they asked for.
  ALL_TASKS_COMPLETE: EXIT_RUN_OK,
  TASK_NOT_STARTED: EXIT_RUN_OK,
  TASK_COMPLETED: EXIT_RUN_OK,
  RECONCILED_IN_FLIGHT: EXIT_RUN_OK,
  // The input cannot be planned or the named task cannot run.
  PLANNING_FAILED: EXIT_RUN_INPUT_UNUSABLE,
  NO_ELIGIBLE_TASK: EXIT_RUN_INPUT_UNUSABLE,
  TASK_ID_INVALID: EXIT_RUN_INPUT_UNUSABLE,
  TASK_UNKNOWN: EXIT_RUN_INPUT_UNUSABLE,
  TASK_INELIGIBLE: EXIT_RUN_INPUT_UNUSABLE,
  // The durable state needs an operator.
  TASK_ABORTED: EXIT_RUN_NEEDS_OPERATOR,
  TASK_PARKED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  STATE_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNOBSERVABLE: EXIT_RUN_NEEDS_OPERATOR,
});

export function exitCodeForPlan(conclusion: RunPlanConclusion): number {
  return PLAN_EXIT_CODES[conclusion];
}

/** Every plan conclusion, re-exported so the exit-code test can be total. */
export const PLAN_CONCLUSIONS_FOR_EXIT = RUN_PLAN_CONCLUSIONS;

/**
 * Exit code for every run outcome. Total; pinned by test. Not consumed by any
 * command yet — the execution mode arrives in a later slice — but part of the
 * `run` command's documented contract from the start.
 */
const RUN_EXIT_CODES: Readonly<Record<RunOutcome, number>> = Object.freeze({
  TASK_COMPLETED: EXIT_RUN_OK,
  // Durably parked, or a record an operator has to look at.
  TASK_ABORTED: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_USAGE_LIMIT: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_VERIFY: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_AUTH: EXIT_RUN_NEEDS_OPERATOR,
  SCOPE_VIOLATION: EXIT_RUN_NEEDS_OPERATOR,
  RESUME_STATE_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  HUMAN_DECISION_REQUIRED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNOBSERVABLE: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  // Nothing to continue: no state has ever been persisted for this task.
  TASK_NOT_STARTED: EXIT_RUN_INPUT_UNUSABLE,
  // This invocation was refused or achieved nothing; nothing durable is wrong.
  STATE_CONFLICT: EXIT_RUN_REFUSED,
  STATE_NOT_RECORDED: EXIT_RUN_REFUSED,
  CONTINUATION_NOT_AUTHORISED: EXIT_RUN_REFUSED,
  EXECUTION_UNAUTHORISED: EXIT_RUN_REFUSED,
  NO_PROGRESS: EXIT_RUN_REFUSED,
  // The only outcome that means "call again".
  STEP_BUDGET_EXHAUSTED: EXIT_RUN_CALL_AGAIN,
});

export function exitCodeForRunOutcome(outcome: RunOutcome): number {
  return RUN_EXIT_CODES[outcome];
}
