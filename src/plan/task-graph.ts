/**
 * The dependency DAG: a set of task definitions, normalised into one canonical
 * graph and validated as a whole.
 *
 * ── Why "normalised" is the load-bearing word ──────────────────────────────
 *
 * The definitions arrive from a directory listing, which is an ordering the
 * filesystem chose. Two machines, two checkouts or two Node versions may hand
 * over the same tasks in different sequences. Everything downstream — the
 * topological order, the unlock metric, which task wins a tie, and therefore
 * *which task the orchestrator does next* — has to be blind to that. So this
 * module re-derives one canonical arrangement from the ids alone: tasks sorted
 * by id, every edge list sorted by id, and a topological order that resolves
 * each of its own ties by id. Feeding the same tasks in any of the 24 possible
 * orders of a four-task set produces one identical graph.
 *
 * ── Edge direction ─────────────────────────────────────────────────────────
 *
 *     B: dependsOn: [A]        means        A ──▶ B
 *
 * A must be `DONE` before B may be selected. `node(A).dependents` therefore
 * lists B, and `node(B).dependsOn` lists A. Both directions are stored because
 * both are asked for: eligibility reads *upward* (are my dependencies done?),
 * and the unlock metric reads *downward* (how much unfinished work is below
 * me?). The downward question is deliberately not "what would finishing me
 * release?" — M2 slice 4 measured the two apart, and `select-task.ts` says on
 * which graph they differ and which one is implemented.
 *
 * ── This layer does not trust its input ────────────────────────────────────
 *
 * The parameter type says `TaskDefinition`, which means the values came through
 * `TaskDefinitionSchema`. The checks below nevertheless repeat the one
 * invariant that schema already enforces — no self-dependency — and add the
 * ones only a whole-set view can see: two tasks claiming one id, a dependency
 * naming a task that does not exist, and a cycle. A graph builder that assumed
 * its input was validated would be exactly one refactor away from being wrong,
 * and its failure mode is an orchestrator that acts on a plan that is not one.
 *
 * ── Everything is fail-closed, and nothing is repaired ─────────────────────
 *
 * A cycle is not broken by dropping an edge. An unknown dependency is not
 * ignored. A duplicate id does not resolve to "the last one wins". Each is a
 * closed failure code, because each means the repository's plan does not say
 * what it appears to say, and guessing which half was intended is not a
 * decision this module is entitled to make.
 */

import { compareTaskIds } from './task-id.js';
import type { TaskDefinition } from './task-definition.js';

/**
 * The largest plan that is normalised at all.
 *
 * The cycle check is O(V+E) and the unlock metric is O(V·E) in the worst case,
 * so the ceiling is about bounding a *hostile* repository rather than a
 * plausible one: 512 task files is already far past the point where a human
 * plan is legible.
 */
export const MAX_TASK_GRAPH_SIZE = 512;

/** Every way normalisation can fail, as a closed set. */
export const TASK_GRAPH_FAILURE_CODES = [
  /** No task definitions at all. Never reported as "everything is done". */
  'TASK_GRAPH_EMPTY',
  /** More task definitions than the ceiling admits. */
  'TASK_GRAPH_TOO_LARGE',
  /** Two definitions claim the same id, or ids differing only in case. */
  'TASK_ID_DUPLICATE',
  /** A task lists itself as a dependency. */
  'TASK_DEPENDENCY_SELF',
  /** A dependency names a task that is not in the set. */
  'TASK_DEPENDENCY_UNKNOWN',
  /** The dependency edges contain a cycle, so no task could ever start. */
  'TASK_GRAPH_CYCLE',
] as const;

export type TaskGraphFailureCode = (typeof TASK_GRAPH_FAILURE_CODES)[number];

/**
 * One static sentence per failure code.
 *
 * Nothing is interpolated — not a task id, not a title, not a path. The failing
 * task's id is carried separately in {@link TaskGraphFailure.taskId}, where it
 * is a validated identifier rather than a fragment spliced into prose.
 */
const FAILURE_DETAIL: Readonly<Record<TaskGraphFailureCode, string>> = Object.freeze({
  TASK_GRAPH_EMPTY: 'A task graph needs at least one task definition.',
  TASK_GRAPH_TOO_LARGE: 'The task source declares more tasks than the orchestrator will normalise.',
  TASK_ID_DUPLICATE:
    'Two task definitions claim the same identifier, or identifiers differing only in case.',
  TASK_DEPENDENCY_SELF: 'A task declares itself as one of its own dependencies.',
  TASK_DEPENDENCY_UNKNOWN: 'A task depends on an identifier no task definition declares.',
  TASK_GRAPH_CYCLE:
    'The dependency declarations contain a cycle, so no task in it could ever become eligible.',
});

/** One task, with both directions of its edges resolved and sorted. */
export interface NormalizedTaskNode {
  readonly definition: TaskDefinition;
  /** Ids this task waits for. Sorted. */
  readonly dependsOn: readonly string[];
  /** Ids waiting for this task. Sorted. */
  readonly dependents: readonly string[];
}

/**
 * An immutable, canonically ordered dependency DAG.
 *
 * The lookup index is a `Map` internally and stays there: handing one out would
 * hand out a mutable structure, so the graph exposes {@link has} and
 * {@link node} instead. Every array it returns is frozen.
 */
export interface NormalizedTaskGraph {
  /** Every task id, sorted. The canonical order for anything that iterates. */
  readonly taskIds: readonly string[];
  /** Every definition, in {@link taskIds} order. */
  readonly tasks: readonly TaskDefinition[];
  /** A dependency-respecting order, with ties broken by id. */
  readonly topologicalOrder: readonly string[];
  readonly size: number;
  has(taskId: string): boolean;
  node(taskId: string): NormalizedTaskNode | null;
}

export interface TaskGraphSuccess {
  readonly ok: true;
  readonly code: 'NORMALIZED';
  readonly graph: NormalizedTaskGraph;
}

export interface TaskGraphFailure {
  readonly ok: false;
  readonly code: TaskGraphFailureCode;
  /** A sentence from {@link FAILURE_DETAIL}. Carries no host or input data. */
  readonly detail: string;
  /**
   * The task the failure is about, when there is exactly one and its id is a
   * validated identifier; `null` otherwise.
   *
   * An id is safe to carry where a title or a path would not be: it has passed
   * the grammar in `plan/task-id.ts`, so it holds no whitespace, no control
   * character, no separator and no shell metacharacter.
   */
  readonly taskId: string | null;
}

export type TaskGraphResult = TaskGraphSuccess | TaskGraphFailure;

function failure(code: TaskGraphFailureCode, taskId: string | null = null): TaskGraphFailure {
  return Object.freeze({ ok: false as const, code, detail: FAILURE_DETAIL[code], taskId });
}

/**
 * Normalises and validates a set of task definitions.
 *
 * Never throws: every expected condition is a {@link TaskGraphFailure} carrying
 * a closed code.
 */
export function normalizeTaskGraph(
  definitions: readonly TaskDefinition[],
): TaskGraphResult {
  // --- 1. A plan exists, and is of a sane size -----------------------------
  // An empty set is refused rather than normalised into an empty graph. An
  // empty graph would select nothing, and "nothing to select" is one keystroke
  // away from being reported as "all work is finished" — which is precisely the
  // confusion a mis-configured task source produces.
  if (definitions.length === 0) return failure('TASK_GRAPH_EMPTY');
  if (definitions.length > MAX_TASK_GRAPH_SIZE) return failure('TASK_GRAPH_TOO_LARGE');

  // --- 2. Canonical order, derived from ids and nothing else ---------------
  const sorted = [...definitions].sort((a, b) => compareTaskIds(a.id, b.id));

  // --- 3. Ids are unique, and unique on Windows too ------------------------
  // Case-insensitive comparison is the stricter rule and the correct one here:
  // an id names a file, `V1-02.md` and `v1-02.md` are one file on this
  // platform, and a repository that distinguishes them cannot be checked out.
  const byLowerCase = new Map<string, string>();
  for (const definition of sorted) {
    const key = definition.id.toLowerCase();
    const existing = byLowerCase.get(key);
    if (existing !== undefined) return failure('TASK_ID_DUPLICATE', existing);
    byLowerCase.set(key, definition.id);
  }

  const index = new Map<string, TaskDefinition>(
    sorted.map((definition) => [definition.id, definition]),
  );

  // --- 4. Every edge points at a real, different task ----------------------
  for (const definition of sorted) {
    if (definition.dependsOn.includes(definition.id)) {
      return failure('TASK_DEPENDENCY_SELF', definition.id);
    }
    for (const dependency of definition.dependsOn) {
      // Exact match, deliberately: the duplicate rule above guarantees no two
      // ids differ only in case, so a case-insensitive *lookup* here could only
      // ever accept a dependency spelled differently from the task it names.
      if (!index.has(dependency)) {
        return failure('TASK_DEPENDENCY_UNKNOWN', definition.id);
      }
    }
  }

  // --- 5. Both edge directions, sorted -------------------------------------
  const dependents = new Map<string, string[]>(sorted.map((definition) => [definition.id, []]));
  for (const definition of sorted) {
    for (const dependency of definition.dependsOn) {
      dependents.get(dependency)?.push(definition.id);
    }
  }

  // --- 6. Topological order, and the cycle check that falls out of it ------
  // Kahn's algorithm, with the ready set kept sorted: at every step the
  // smallest eligible id is emitted, so the order is a single order rather than
  // one of many valid ones. If fewer than every task is emitted, the remainder
  // is a set in which every member still waits for another member — a cycle.
  const remainingDependencies = new Map<string, number>(
    sorted.map((definition) => [definition.id, definition.dependsOn.length]),
  );
  const ready = sorted
    .filter((definition) => definition.dependsOn.length === 0)
    .map((definition) => definition.id);
  const topologicalOrder: string[] = [];

  while (ready.length > 0) {
    ready.sort(compareTaskIds);
    const current = ready.shift() as string;
    topologicalOrder.push(current);
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (topologicalOrder.length !== sorted.length) return failure('TASK_GRAPH_CYCLE');

  // --- 7. The frozen result ------------------------------------------------
  const nodes = new Map<string, NormalizedTaskNode>(
    sorted.map((definition) => [
      definition.id,
      Object.freeze({
        definition,
        dependsOn: Object.freeze([...definition.dependsOn].sort(compareTaskIds)),
        dependents: Object.freeze((dependents.get(definition.id) ?? []).sort(compareTaskIds)),
      }),
    ]),
  );

  const graph: NormalizedTaskGraph = Object.freeze({
    taskIds: Object.freeze(sorted.map((definition) => definition.id)),
    tasks: Object.freeze([...sorted]),
    topologicalOrder: Object.freeze([...topologicalOrder]),
    size: sorted.length,
    has: (taskId: string): boolean => nodes.has(taskId),
    node: (taskId: string): NormalizedTaskNode | null => nodes.get(taskId) ?? null,
  });

  return Object.freeze({ ok: true as const, code: 'NORMALIZED' as const, graph });
}
