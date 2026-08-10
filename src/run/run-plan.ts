/**
 * The read-only answer to "what would a run do with this repository right now?"
 *
 * This module composes four existing read-only layers — the planner, the state
 * loader, the reconciler and the resume classifier — into one report an
 * operator can act on. It adds **no policy of its own**: the selection is the
 * planner's, the load classification is the store's, the verdict is the
 * reconciler's and the continuation authority is `classifyResume`'s. What it
 * adds is a *single closed conclusion* a caller can branch on without
 * re-deriving it from four vocabularies — the same argument, one layer up, that
 * `reconcile-task.ts` makes for its own composed outcome.
 *
 * ── Read-only, and provably so ─────────────────────────────────────────────
 *
 * Nothing here writes a state, prepares a workspace, spawns an agent or runs a
 * verification command. The only processes started are the read-only Git
 * queries `observeRuntime` needs, through the injected {@link GitRunner}. A
 * plan of a repository leaves it byte-identical — the tests assert this on the
 * durable state file and on the workspace directory, not just on this comment.
 *
 * ── Evidence, never assumed ────────────────────────────────────────────────
 *
 * The plan performs no auth preflight, so `classifyResume` is fed
 * `authPreflightPassed: false` — the honest value for a check that did not run.
 * The only consequence today is in the automatic-resume reason codes of a
 * quota-blocked task; a plan grants nothing and can therefore never overstate.
 *
 * ── Conclusion spellings are reused, not invented ──────────────────────────
 *
 * Where an existing vocabulary already names the fact — `TASK_NOT_STARTED`,
 * `STATE_DIVERGED`, `RECONCILED_IN_FLIGHT` — the conclusion reuses that exact
 * spelling, for the reason `resume-decision.ts` gives: a second spelling for
 * one condition is a second opinion about what it means.
 */

import { isTerminalState, isBlockingState, type TaskStateName } from '../core/states.js';
import { isValidTaskId } from '../plan/task-id.js';
import type { TaskEligibility } from '../plan/select-task.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { reconcileTask, type TaskReconciliation } from '../state/reconcile-task.js';
import { classifyResume, type ResumeDecision } from '../state/resume-decision.js';
import type { GitRunner } from '../worktree/git-command.js';
import { selectRunTask, type RunSelection } from './run-driver.js';

/**
 * Every way a plan can conclude. A closed set; the renderer and the exit-code
 * mapping both branch on it, and `tests/run-exit-codes.test.ts` pins that every
 * member has an exit code.
 */
export const RUN_PLAN_CONCLUSIONS = [
  /* ── no task in hand ──────────────────────────────────────────────────── */
  /** The plan could not be read or normalised. `selection.planning` says why. */
  'PLANNING_FAILED',
  /** The plan is non-empty and every task in it is `DONE`. */
  'ALL_TASKS_COMPLETE',
  /** Open work exists but nothing is eligible. A fail-closed floor. */
  'NO_ELIGIBLE_TASK',
  /**
   * The named id does not satisfy the task-id grammar. Refused before any
   * lookup, so an arbitrary operator-typed string never travels further than
   * this code — it is not echoed, not compared and not used as a path segment.
   */
  'TASK_ID_INVALID',
  /** The named id is well-formed but names no task in the plan. */
  'TASK_UNKNOWN',
  /**
   * The named task exists but may not run: it is `DONE`, or a dependency is
   * not. `target.eligibility` carries the reason and the unsatisfied ids.
   */
  'TASK_INELIGIBLE',
  /* ── task in hand ─────────────────────────────────────────────────────── */
  /** No durable state exists. Starting it is not something this build offers. */
  'TASK_NOT_STARTED',
  /** The durable state is `READY_FOR_PR`: finished, handed to a human. */
  'TASK_COMPLETED',
  /** The durable state is `ABORTED`: given up on, irreversibly. */
  'TASK_ABORTED',
  /**
   * A regular in-flight state whose record agrees with observed reality. A
   * human may continue it; `resume.continuation` says exactly on whose
   * authority.
   */
  'RECONCILED_IN_FLIGHT',
  /**
   * Durably parked in a blocking state. `state` names which one and
   * `reasonCodes` say why it stays parked — the per-state distinction the run
   * driver's outcome vocabulary insists on is preserved by those two fields,
   * not flattened into this code.
   */
  'TASK_PARKED',
  /** The record is broken, or intact but belonging to somewhere else. */
  'STATE_UNUSABLE',
  /** The world contradicts the record. */
  'STATE_DIVERGED',
  /** The world could not be read. */
  'STATE_UNOBSERVABLE',
] as const;

export type RunPlanConclusion = (typeof RUN_PLAN_CONCLUSIONS)[number];

/** How the task under inspection came to be the one under inspection. */
export interface RunPlanTarget {
  readonly taskId: string;
  /** `NAMED` — the operator named it; `SELECTED` — the ranking chose it. */
  readonly source: 'NAMED' | 'SELECTED';
  /**
   * The planner's eligibility entry for this task, or `null` when planning
   * failed before eligibility was evaluated.
   */
  readonly eligibility: TaskEligibility | null;
}

export interface RunPlanRequest {
  /** The repository, already resolved. This module resolves nothing. */
  readonly repository: ResolvedRepository;
  /** A task to inspect instead of the selector's choice, or `null`. */
  readonly taskId: string | null;
}

export interface RunPlanDependencies {
  /** Read-only Git queries for `observeRuntime`. Required, never defaulted. */
  readonly git: GitRunner;
  /** The clock, injected so the decision layer stays pure. */
  readonly now: () => string;
}

export interface RunPlan {
  readonly conclusion: RunPlanConclusion;
  /** The task under inspection, or `null` when none was reached. */
  readonly target: RunPlanTarget | null;
  /** The selector's full answer, including ranking and eligibility. */
  readonly selection: RunSelection;
  /** Load + observation + comparison, or `null` when no task was in hand. */
  readonly reconciliation: TaskReconciliation | null;
  /** The continuation decision, or `null` when it was never reached. */
  readonly resume: ResumeDecision | null;
  /** The durable state's name, or `null` when none was loaded. */
  readonly state: TaskStateName | null;
  /** Stable codes explaining the conclusion. Empty when nominal. */
  readonly reasonCodes: readonly string[];
}

function plan(
  from: Partial<RunPlan> & {
    readonly conclusion: RunPlanConclusion;
    readonly selection: RunSelection;
  },
): RunPlan {
  return Object.freeze({
    target: null,
    reconciliation: null,
    resume: null,
    state: null,
    reasonCodes: Object.freeze([]),
    ...from,
  });
}

/** Mirrors the run driver's mapping for a non-`RECONCILED` outcome. */
function conclusionForReconciliation(reconciliation: TaskReconciliation): RunPlanConclusion {
  switch (reconciliation.outcome) {
    case 'STATE_DIVERGED':
      return 'STATE_DIVERGED';
    case 'STATE_UNOBSERVABLE':
      return 'STATE_UNOBSERVABLE';
    // A well-formed record of somewhere else is not a broken document, but it
    // is equally unusable here, and neither may be repaired.
    case 'STATE_INVALID':
    case 'STATE_REPOSITORY_MISMATCH':
    case 'STATE_TASK_MISMATCH':
      return 'STATE_UNUSABLE';
    case 'NO_PERSISTED_STATE':
    case 'RECONCILED':
      // Both handled before this function is asked. Present so the switch
      // stays total against a widened outcome set, and fail-closed.
      return 'STATE_UNUSABLE';
  }
}

/**
 * Plans one run, read-only. Never throws for an expected condition; every
 * refusal arrives as a conclusion with its own reason codes.
 */
export async function planRun(
  request: RunPlanRequest,
  deps: RunPlanDependencies,
): Promise<RunPlan> {
  const { repository } = request;

  // The selector always runs, even for a named task: the ranking is the
  // reasoning, and a report that only mentioned the named task would answer
  // "may this run?" while hiding "what would run instead?".
  const selection = selectRunTask(repository);

  // --- 1. Which task is under inspection? ---------------------------------
  let target: RunPlanTarget;
  if (request.taskId !== null) {
    if (!isValidTaskId(request.taskId)) {
      return plan({ conclusion: 'TASK_ID_INVALID', selection });
    }
    if (!selection.planning.ok) {
      return plan({
        conclusion: 'PLANNING_FAILED',
        selection,
        reasonCodes: selection.reasonCodes,
      });
    }
    const eligibility =
      selection.planning.selection.eligibility.find(
        (entry) => entry.taskId === request.taskId,
      ) ?? null;
    if (eligibility === null) {
      return plan({ conclusion: 'TASK_UNKNOWN', selection });
    }
    target = Object.freeze({ taskId: request.taskId, source: 'NAMED' as const, eligibility });
  } else {
    if (selection.code !== 'TASK_SELECTED' || selection.task === null) {
      return plan({
        conclusion:
          selection.code === 'TASK_SELECTED' ? 'NO_ELIGIBLE_TASK' : selection.code,
        selection,
        reasonCodes: selection.reasonCodes,
      });
    }
    const selectedId = selection.task.id;
    target = Object.freeze({
      taskId: selectedId,
      source: 'SELECTED' as const,
      eligibility:
        (selection.planning.ok
          ? selection.planning.selection.eligibility.find(
              (entry) => entry.taskId === selectedId,
            )
          : undefined) ?? null,
    });
  }

  // --- 2. The record, and the world it claims to describe ------------------
  const reconciliation = await reconcileTask(deps.git, {
    repository,
    taskId: target.taskId,
  });

  // No durable state: the eligibility answer is the whole answer. A named task
  // that is `DONE` or dependency-blocked is reported as such rather than as
  // "not started", because "you could start this" would be the wrong reading.
  if (reconciliation.outcome === 'NO_PERSISTED_STATE') {
    const ineligible = target.eligibility !== null && !target.eligibility.eligible;
    return plan({
      conclusion: ineligible ? 'TASK_INELIGIBLE' : 'TASK_NOT_STARTED',
      target,
      selection,
      reconciliation,
      reasonCodes:
        ineligible && target.eligibility !== null && target.eligibility.reason !== null
          ? Object.freeze([target.eligibility.reason])
          : Object.freeze([]),
    });
  }

  // Terminal first, and deliberately before the world is judged — the same
  // ordering, for the same reason, as the run driver and `classifyResume`: a
  // finished task's worktree drifting is noise about something nobody is going
  // to continue.
  if (reconciliation.load.ok && isTerminalState(reconciliation.load.state.state)) {
    return plan({
      conclusion:
        reconciliation.load.state.state === 'READY_FOR_PR' ? 'TASK_COMPLETED' : 'TASK_ABORTED',
      target,
      selection,
      reconciliation,
      state: reconciliation.load.state.state,
    });
  }

  if (reconciliation.outcome !== 'RECONCILED') {
    return plan({
      conclusion: conclusionForReconciliation(reconciliation),
      target,
      selection,
      reconciliation,
      state: reconciliation.state?.state ?? null,
      reasonCodes: reconciliation.reasonCodes,
    });
  }

  // `RECONCILED` implies both of these. Checked rather than asserted — the
  // same fail-closed floor the driver keeps, at the same cost of one branch.
  if (!reconciliation.load.ok || reconciliation.observed === null) {
    return plan({
      conclusion: 'STATE_UNUSABLE',
      target,
      selection,
      reconciliation,
    });
  }

  // --- 3. May anything continue, and on whose authority? -------------------
  const state = reconciliation.load.state;
  const resume = classifyResume(state, reconciliation.observed, {
    now: deps.now(),
    // No preflight ran; the honest value for a check that was not performed.
    authPreflightPassed: false,
    repository,
    taskId: target.taskId,
  });

  return plan({
    conclusion: isBlockingState(state.state) ? 'TASK_PARKED' : 'RECONCILED_IN_FLIGHT',
    target,
    selection,
    reconciliation,
    resume,
    state: state.state,
    reasonCodes: resume.reasonCodes,
  });
}
