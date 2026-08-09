/**
 * The planning entry point: from a resolved repository to one decision.
 *
 * Three steps, each of which already refuses to guess, composed in the only
 * order they can be composed in:
 *
 *   1. `discoverTasks`      — the repository's task files become definitions;
 *   2. `normalizeTaskGraph` — the definitions become one canonical DAG;
 *   3. `selectNextTask`     — the DAG becomes a selection.
 *
 * The composition adds no policy of its own. Its whole job is to stop at the
 * first failure and hand back the code that step produced, so that "the task
 * source is empty", "two tasks depend on each other" and "nothing is eligible"
 * stay three different answers all the way out to the caller. A planner that
 * flattened them into one "no task" result would be the exact failure this
 * slice exists to prevent: a broken plan reported as a finished one.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It does not start a task, create a worktree, write a `TaskState`, touch Git
 * or open a pull request. It answers *which task*, and it is a pure function of
 * the repository's files at the moment it is called.
 */

import type { ResolvedRepository } from '../repo/resolve-repository.js';
import {
  discoverTasks,
  type TaskDiscoveryFailureCode,
} from './discover-tasks.js';
import {
  normalizeTaskGraph,
  type NormalizedTaskGraph,
  type TaskGraphFailureCode,
} from './task-graph.js';
import { selectNextTask, type TaskSelectionOutcome } from './select-task.js';

/**
 * Every way planning can fail: the union of the two upstream closed sets.
 *
 * They are kept distinct rather than merged into a third vocabulary, so a code
 * always means the same thing wherever it is read.
 */
export type TaskPlanningFailureCode = TaskDiscoveryFailureCode | TaskGraphFailureCode;

export interface TaskPlanningSuccess {
  readonly ok: true;
  readonly code: 'PLANNED';
  readonly graph: NormalizedTaskGraph;
  /** The selection, including its full eligibility report and ranking. */
  readonly selection: TaskSelectionOutcome;
}

export interface TaskPlanningFailure {
  readonly ok: false;
  readonly code: TaskPlanningFailureCode;
  /** A static sentence from the step that failed. Carries no host data. */
  readonly detail: string;
  /** The offending task's validated id, or `null`. */
  readonly taskId: string | null;
  /** A count of contract violations where one applies; `null` otherwise. */
  readonly issueCount: number | null;
}

export type TaskPlanningResult = TaskPlanningSuccess | TaskPlanningFailure;

/**
 * Plans the next task for a resolved repository.
 *
 * Never throws for an expected condition. A successful result always carries a
 * selection, and that selection always carries the reasoning — the eligibility
 * of every task and the ranking that produced the winner.
 */
export function planNextTask(repository: ResolvedRepository): TaskPlanningResult {
  const discovered = discoverTasks(repository);
  if (!discovered.ok) {
    return Object.freeze({
      ok: false as const,
      code: discovered.code,
      detail: discovered.detail,
      taskId: discovered.taskId,
      issueCount: discovered.issueCount,
    });
  }

  const normalized = normalizeTaskGraph(discovered.tasks);
  if (!normalized.ok) {
    return Object.freeze({
      ok: false as const,
      code: normalized.code,
      detail: normalized.detail,
      taskId: normalized.taskId,
      issueCount: null,
    });
  }

  return Object.freeze({
    ok: true as const,
    code: 'PLANNED' as const,
    graph: normalized.graph,
    selection: selectNextTask(normalized.graph),
  });
}
