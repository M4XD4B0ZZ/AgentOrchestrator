/**
 * Which predecessor a member chains onto — read from the frozen relation.
 *
 * ── Why a maximum, and why it must be unique ───────────────────────────────
 *
 * A chained member is built on *one* commit. Its predecessors must therefore be
 * totally ordered among themselves, so that the last of them contains all the
 * others: `A1 → A2 → B` gives `base(B) = result(A2)`, and `A2`'s history already
 * contains `A1`'s. Two incomparable predecessors have no such commit, and the
 * only ways to invent one are to merge (a Git effect this slice does not make)
 * or to pick one and silently drop the other's work. Both are refused: the block
 * is unsupported input, exactly as V2-08 treats a relation its runner cannot
 * schedule.
 *
 * ── Pure, and reading a relation somebody else computed ────────────────────
 *
 * `dependsOn` is the **transitive** projection onto block members, computed once
 * at freeze time by `block-dependencies.ts` and bound into the fingerprint. That
 * is what makes the test below a set containment rather than a graph walk: `M`
 * dominates the required set exactly when every other required member appears in
 * `M`'s own row. This module walks nothing, asks Git nothing, and must never
 * import the projection — the relation arrives as data.
 */

import type { FrozenTaskDependency } from './block-definition.js';

/** Every way a shape question is refused. A closed set. */
export const CHAIN_SHAPE_REFUSALS = [
  /** The required predecessors are not totally ordered, so no commit holds all of them. */
  'NO_UNIQUE_MAXIMUM',
  /**
   * The relation has no row for the member asked about.
   *
   * Unreachable through a validated ledger — rule 1a requires one row per frozen
   * task — and answered rather than thrown, so a caller cannot receive a shape
   * for a member the relation is silent about.
   */
  'TASK_NOT_IN_RELATION',
] as const;

export type ChainShapeRefusal = (typeof CHAIN_SHAPE_REFUSALS)[number];

export type UniqueMaximumResult =
  /** `maximum` is `null` exactly when the member has no frozen member predecessor. */
  | { readonly ok: true; readonly maximum: string | null }
  | { readonly ok: false; readonly code: ChainShapeRefusal };

export type ChainShapeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ChainShapeRefusal; readonly taskId: string };

/** The one member of `taskId`'s required set that contains all the others. */
export function uniqueMaximumOf(
  dependencies: readonly FrozenTaskDependency[],
  taskId: string,
): UniqueMaximumResult {
  const row = dependencies.find((entry) => entry.taskId === taskId);
  if (row === undefined) {
    return Object.freeze({ ok: false as const, code: 'TASK_NOT_IN_RELATION' as const });
  }
  if (row.dependsOn.length === 0) return Object.freeze({ ok: true as const, maximum: null });

  const reach = new Map(dependencies.map((entry) => [entry.taskId, new Set(entry.dependsOn)]));
  const dominating = row.dependsOn.filter((candidate) => {
    const below = reach.get(candidate);
    // A required member the relation holds no row for cannot be shown to contain
    // anything, so it never dominates. Fail-closed rather than assumed empty.
    if (below === undefined) return false;
    return row.dependsOn.every((other) => other === candidate || below.has(other));
  });

  return dominating.length === 1
    ? Object.freeze({ ok: true as const, maximum: dominating[0] as string })
    : Object.freeze({ ok: false as const, code: 'NO_UNIQUE_MAXIMUM' as const });
}

/** Whether every member of the block has a chain shape. Freeze-time gate. */
export function chainShapeOf(dependencies: readonly FrozenTaskDependency[]): ChainShapeResult {
  for (const row of dependencies) {
    const maximum = uniqueMaximumOf(dependencies, row.taskId);
    if (!maximum.ok) {
      return Object.freeze({ ok: false as const, code: maximum.code, taskId: row.taskId });
    }
  }
  return Object.freeze({ ok: true as const });
}
