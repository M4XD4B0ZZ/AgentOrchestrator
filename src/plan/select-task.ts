/**
 * Eligibility and deterministic selection: *which task now?*
 *
 * Everything upstream of this module produces facts — what the repository
 * declared, what depends on what. This module turns those facts into the single
 * decision the orchestrator acts on, and it is the place where determinism
 * stops being a nice property and becomes the contract: given one normalised
 * graph, the answer is a pure function of that graph. No clock, no random
 * source, no filesystem, no environment, no `process.cwd()`.
 *
 * ── Eligibility ────────────────────────────────────────────────────────────
 *
 * A task is eligible when it is `OPEN` **and** every task it depends on is
 * `DONE`. The two ways of being ineligible are reported separately, because
 * they mean opposite things to an operator: `ALREADY_DONE` is finished work,
 * `BLOCKED_BY_DEPENDENCIES` is waiting work, and the dependencies it is waiting
 * for are named.
 *
 * ── The ranking tuple ──────────────────────────────────────────────────────
 *
 * Eligible tasks are ordered by a five-element tuple, compared most-significant
 * first. Its last element is the task id, which is unique, so the order is
 * **total**: no two eligible tasks can tie, and there is never a residual
 * choice for an implementation detail to make.
 *
 *   1. **kind** — `REMEDIATION` before `NORMAL`. Remediation work exists
 *      because something already delivered is wrong. Starting new work while a
 *      known defect stands is how a plan accumulates unfinished corrections.
 *   2. **currentFocus** — focused before unfocused. This is the repository's
 *      explicit steering signal, and it outranks priority for that reason:
 *      priority is a standing property of a task, focus is a statement about
 *      *now*. It is not a singleton — several tasks may be focused, and the
 *      remaining elements then decide between them.
 *   3. **priority** — `HIGH`, `NORMAL`, `LOW`.
 *   4. **unlock count** — descending. Between two otherwise equal tasks, the
 *      one whose completion releases more blocked work goes first; that is the
 *      choice that keeps the most of the plan reachable.
 *   5. **id** — ascending, by UTF-16 code unit. The tie-breaker of last resort.
 *
 * The order of the first three is a judgement, and it is stated here rather
 * than buried in a comparator so that changing it is a visible act.
 *
 * ── The unlock metric ──────────────────────────────────────────────────────
 *
 * `unlockCount` is the number of **distinct, not-yet-`DONE`** tasks that
 * transitively depend on this one. Transitive, because releasing a task that
 * releases a chain is worth more than releasing a leaf; distinct, because a
 * diamond must not count its tip twice; and not-yet-`DONE`, because finished
 * work cannot be released by anything.
 */

import { compareTaskIds } from './task-id.js';
import type { TaskDefinition, TaskPriority } from './task-definition.js';
import type { NormalizedTaskGraph } from './task-graph.js';

/** Why a task is not eligible. Exactly two ways, and they are not the same. */
export const TASK_INELIGIBILITY_REASONS = ['ALREADY_DONE', 'BLOCKED_BY_DEPENDENCIES'] as const;
export type TaskIneligibilityReason = (typeof TASK_INELIGIBILITY_REASONS)[number];

/** What the planner concluded about one task. */
export interface TaskEligibility {
  readonly taskId: string;
  readonly eligible: boolean;
  /** `null` exactly when {@link eligible} is `true`. */
  readonly reason: TaskIneligibilityReason | null;
  /** Direct dependencies that are not `DONE`, sorted. Empty when eligible. */
  readonly unsatisfiedDependencies: readonly string[];
  /** Distinct not-yet-`DONE` tasks transitively waiting on this one. */
  readonly unlockCount: number;
}

/** The outcome vocabulary of a selection. A closed set. */
export const TASK_SELECTION_CODES = [
  /** Exactly one task was chosen; it is the head of the ranking. */
  'TASK_SELECTED',
  /** The plan is non-empty and every task in it is `DONE`. */
  'ALL_TASKS_COMPLETE',
  /**
   * Open work exists but nothing is eligible.
   *
   * A fail-closed floor, not a reachable state: in an acyclic graph whose
   * dependencies all resolve — which is the only kind `normalizeTaskGraph`
   * returns — the topologically first `OPEN` task can have no `OPEN`
   * dependency, so an eligible task always exists. The code is kept so that a
   * future graph rule which broke that argument would surface as an explicit
   * outcome rather than as a silent `ALL_TASKS_COMPLETE`.
   */
  'NO_ELIGIBLE_TASK',
] as const;

export type TaskSelectionCode = (typeof TASK_SELECTION_CODES)[number];

export interface TaskSelectionOutcome {
  readonly code: TaskSelectionCode;
  /** The chosen task, or `null` for every non-`TASK_SELECTED` outcome. */
  readonly selected: TaskDefinition | null;
  /** Every task's eligibility, in canonical id order. */
  readonly eligibility: readonly TaskEligibility[];
  /** The eligible task ids, best first. Empty when nothing is eligible. */
  readonly ranking: readonly string[];
}

/**
 * The ranking tuple: kind, focus, priority, unlock, id.
 *
 * Lower is better in every position, so one elementwise comparison ranks the
 * whole tuple. Exported because a decision that cannot be inspected cannot be
 * reviewed — the tests assert on this directly rather than inferring it from
 * which task happened to win.
 */
export type TaskRankingKey = readonly [
  kind: number,
  focus: number,
  priority: number,
  unlock: number,
  id: string,
];

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = Object.freeze({
  HIGH: 0,
  NORMAL: 1,
  LOW: 2,
});

export function taskRankingKey(
  eligibility: TaskEligibility,
  graph: NormalizedTaskGraph,
): TaskRankingKey {
  const definition = graph.node(eligibility.taskId)?.definition;
  if (definition === undefined) {
    // Not reachable through `selectNextTask`, which only ever ranks ids taken
    // from the graph itself. Ranked last rather than thrown on: a selection
    // must not become an exception because a lookup missed.
    return [Number.MAX_SAFE_INTEGER, 1, 2, 0, eligibility.taskId];
  }
  return [
    definition.kind === 'REMEDIATION' ? 0 : 1,
    definition.currentFocus ? 0 : 1,
    PRIORITY_RANK[definition.priority],
    // Negated so that "more unlocked" sorts earlier under the same
    // lower-is-better rule as every other element. Zero is normalised to `+0`:
    // `-0` compares equal but serialises differently, and this tuple is
    // compared *and* asserted on.
    eligibility.unlockCount === 0 ? 0 : -eligibility.unlockCount,
    definition.id,
  ];
}

function compareRankingKeys(a: TaskRankingKey, b: TaskRankingKey): number {
  for (let index = 0; index < 4; index += 1) {
    const left = a[index] as number;
    const right = b[index] as number;
    if (left !== right) return left - right;
  }
  return compareTaskIds(a[4], b[4]);
}

/**
 * Distinct not-yet-`DONE` tasks that transitively depend on `taskId`.
 *
 * A breadth-first walk down the `dependents` edges with a visited set, so a
 * diamond counts its tip once and a long chain costs one visit per node.
 */
function countUnlocked(graph: NormalizedTaskGraph, taskId: string): number {
  const visited = new Set<string>([taskId]);
  const queue: string[] = [taskId];
  let unlocked = 0;

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of graph.node(current)?.dependents ?? []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      queue.push(dependent);
      if (graph.node(dependent)?.definition.status !== 'DONE') unlocked += 1;
    }
  }

  return unlocked;
}

/**
 * Evaluates every task in the graph, in canonical id order.
 *
 * Pure: the same graph always yields the same report, element for element.
 */
export function evaluateTaskEligibility(
  graph: NormalizedTaskGraph,
): readonly TaskEligibility[] {
  return Object.freeze(
    graph.taskIds.map((taskId) => {
      const node = graph.node(taskId);
      const definition = node?.definition;
      const unlockCount = countUnlocked(graph, taskId);

      // A finished task is not "waiting for" anything, even if something it
      // depends on is still open. Reporting it as blocked would describe a
      // situation that cannot be acted on and is not a problem.
      if (definition?.status === 'DONE') {
        return Object.freeze({
          taskId,
          eligible: false,
          reason: 'ALREADY_DONE' as const,
          unsatisfiedDependencies: Object.freeze([]),
          unlockCount,
        });
      }

      const unsatisfied = (node?.dependsOn ?? []).filter(
        (dependency) => graph.node(dependency)?.definition.status !== 'DONE',
      );
      if (unsatisfied.length > 0) {
        return Object.freeze({
          taskId,
          eligible: false,
          reason: 'BLOCKED_BY_DEPENDENCIES' as const,
          unsatisfiedDependencies: Object.freeze([...unsatisfied].sort(compareTaskIds)),
          unlockCount,
        });
      }

      return Object.freeze({
        taskId,
        eligible: true,
        reason: null,
        unsatisfiedDependencies: Object.freeze([]),
        unlockCount,
      });
    }),
  );
}

/**
 * Chooses the next task, or explains why there is none.
 *
 * Never throws, and never returns a selection that is not the head of its own
 * published ranking — the ranking is the reasoning, and a selection that
 * disagreed with it would be an answer with no shown work.
 */
export function selectNextTask(graph: NormalizedTaskGraph): TaskSelectionOutcome {
  const eligibility = evaluateTaskEligibility(graph);

  const ranked = eligibility
    .filter((entry) => entry.eligible)
    .map((entry) => ({ entry, key: taskRankingKey(entry, graph) }))
    .sort((a, b) => compareRankingKeys(a.key, b.key));

  const ranking = Object.freeze(ranked.map((candidate) => candidate.entry.taskId));

  const best = ranked[0];
  if (best !== undefined) {
    return Object.freeze({
      code: 'TASK_SELECTED' as const,
      selected: graph.node(best.entry.taskId)?.definition ?? null,
      eligibility,
      ranking,
    });
  }

  const everyTaskDone = eligibility.every((entry) => entry.reason === 'ALREADY_DONE');
  return Object.freeze({
    code: everyTaskDone ? ('ALL_TASKS_COMPLETE' as const) : ('NO_ELIGIBLE_TASK' as const),
    selected: null,
    eligibility,
    ranking,
  });
}
