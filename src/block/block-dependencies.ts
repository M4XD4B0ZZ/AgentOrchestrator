/**
 * The block's dependency relation, projected out of the repository's whole DAG.
 *
 * ── Called once, when a block is frozen ────────────────────────────────────
 *
 * This is the *only* place the relation is computed. The runner never calls it:
 * a run that re-derived the relation between tasks would answer "may B continue
 * after A?" from a roadmap that an operator can edit while the run is in
 * flight, which is the opposite of frozen-plan authority. The result is written
 * into the ledger, bound into the fingerprint, and read from there afterwards.
 *
 * ── Why the obvious version is wrong ───────────────────────────────────────
 *
 * The seductive implementation asks each member for its own `dependsOn` and
 * keeps the entries that are also members. Measured against
 * `src/plan/task-graph.ts`, that is unsound: `normalizeTaskGraph` stores each
 * definition's own edge list and its direct reverse and computes **no
 * transitive closure anywhere**, while normalising over the whole discovered
 * task set. A block is therefore an arbitrary subset of a repository-wide DAG,
 * and this is representable:
 *
 *     A: dependsOn []
 *     X: dependsOn [A]      <- not a block member
 *     B: dependsOn [X]
 *
 *     block = {A, B}   ->   no direct intra-block edge exists,
 *                           yet B transitively depends on A through X
 *
 * So the walk goes up the whole graph and the restriction to members happens at
 * the end, never at each hop.
 *
 * ── What a member's empty row does and does not say ────────────────────────
 *
 * It says: no *member* of this block stands between this task and eligibility.
 * It does **not** say the task is eligible. A member may wait on a non-member
 * that is not `DONE`, and nothing here records that — eligibility is the
 * repository selector's question, asked live, and a block frozen in that state
 * can end with nothing runnable and no disposition to explain it, which is what
 * `NO_ELIGIBLE_TASK` is reserved for.
 */

import { compareTaskIds } from '../plan/task-id.js';
import type { NormalizedTaskGraph } from '../plan/task-graph.js';
import type { FrozenTaskDependency } from './block-definition.js';

/** Every way a projection can fail. A closed set. */
export const BLOCK_PROJECTION_FAILURE_CODES = [
  /**
   * A requested member is not a task of this repository.
   *
   * Refused rather than projected as an empty row. An unknown member with no
   * edges would be frozen as "independent of everything", which is the most
   * dangerous possible answer to give about a task nobody can find.
   */
  'TASK_NOT_IN_GRAPH',
] as const;

export type BlockProjectionFailureCode = (typeof BLOCK_PROJECTION_FAILURE_CODES)[number];

export interface BlockProjectionSuccess {
  readonly ok: true;
  /** One row per member, in the caller's member order. */
  readonly dependencies: readonly FrozenTaskDependency[];
}

export interface BlockProjectionFailure {
  readonly ok: false;
  readonly code: BlockProjectionFailureCode;
  /** The member the failure is about. A validated id, never prose. */
  readonly taskId: string;
}

export type BlockProjectionResult = BlockProjectionSuccess | BlockProjectionFailure;

/**
 * The members each member transitively depends on.
 *
 * Pure: no clock, no filesystem, no Git. The graph is already acyclic — that is
 * what `normalizeTaskGraph` returns — so the visited set is about not walking a
 * diamond's shared ancestor twice rather than about termination.
 */
export function projectBlockDependencies(
  graph: NormalizedTaskGraph,
  taskIds: readonly string[],
): BlockProjectionResult {
  for (const taskId of taskIds) {
    if (!graph.has(taskId)) {
      return Object.freeze({ ok: false as const, code: 'TASK_NOT_IN_GRAPH' as const, taskId });
    }
  }

  const members = new Set(taskIds);

  const dependencies = taskIds.map((taskId) => {
    const reached = new Set<string>();
    const queue = [...(graph.node(taskId)?.dependsOn ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (reached.has(current)) continue;
      reached.add(current);
      for (const next of graph.node(current)?.dependsOn ?? []) queue.push(next);
    }

    // The restriction, applied once and at the end. `taskId` itself is excluded
    // defensively: an acyclic graph cannot reach it, and a relation that could
    // say "A depends on A" would be refused by `defineBlock` anyway.
    const projected = [...reached]
      .filter((id) => members.has(id) && id !== taskId)
      .sort(compareTaskIds);

    return Object.freeze({ taskId, dependsOn: Object.freeze(projected) });
  });

  return Object.freeze({ ok: true as const, dependencies: Object.freeze(dependencies) });
}
