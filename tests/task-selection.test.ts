/**
 * Eligibility and deterministic selection.
 *
 * This is the layer that answers the orchestrator's only real question — *which
 * task now?* — and the answer has to be a function of the repository's plan
 * alone. Not of directory order, not of the clock, not of which machine is
 * asking. Every test here is ultimately about that: a rule that says which task
 * wins, plus the evidence that the rule is total (no ties are left unbroken)
 * and stable (no input order changes the winner).
 */

import { describe, expect, it } from 'vitest';

import type { TaskDefinition } from '../src/plan/task-definition.js';
import { normalizeTaskGraph, type NormalizedTaskGraph } from '../src/plan/task-graph.js';
import {
  TASK_SELECTION_CODES,
  evaluateTaskEligibility,
  selectNextTask,
  taskRankingKey,
} from '../src/plan/select-task.js';

function def(id: string, overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id,
    title: `Task ${id}`,
    status: 'OPEN',
    kind: 'NORMAL',
    priority: 'NORMAL',
    currentFocus: false,
    dependsOn: [],
    ...overrides,
  };
}

function graphOf(definitions: readonly TaskDefinition[]): NormalizedTaskGraph {
  const result = normalizeTaskGraph(definitions);
  if (!result.ok) throw new Error(`expected a graph, got ${result.code}`);
  return result.graph;
}

function selectedIdOf(definitions: readonly TaskDefinition[]): string | null {
  return selectNextTask(graphOf(definitions)).selected?.id ?? null;
}

function eligibilityOf(graph: NormalizedTaskGraph, taskId: string) {
  const entry = evaluateTaskEligibility(graph).find((item) => item.taskId === taskId);
  if (entry === undefined) throw new Error(`no eligibility entry for ${taskId}`);
  return entry;
}

function shuffle<T>(values: readonly T[], seed: number): T[] {
  const out = [...values];
  let state = seed * 2654435761 + 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

describe('eligibility', () => {
  it('reports one entry per task, in canonical id order', () => {
    const entries = evaluateTaskEligibility(graphOf([def('C'), def('A'), def('B')]));
    expect(entries.map((entry) => entry.taskId)).toEqual(['A', 'B', 'C']);
  });

  it('makes an open task with no dependencies eligible', () => {
    const entry = eligibilityOf(graphOf([def('A')]), 'A');
    expect(entry.eligible).toBe(true);
    expect(entry.reason).toBeNull();
    expect(entry.unsatisfiedDependencies).toEqual([]);
  });

  it('makes a DONE task ineligible, and says why', () => {
    const entry = eligibilityOf(graphOf([def('A', { status: 'DONE' })]), 'A');
    expect(entry.eligible).toBe(false);
    expect(entry.reason).toBe('ALREADY_DONE');
  });

  it('blocks a task whose dependency is still open, and names the dependency', () => {
    const graph = graphOf([def('A'), def('B', { dependsOn: ['A'] })]);
    const entry = eligibilityOf(graph, 'B');
    expect(entry.eligible).toBe(false);
    expect(entry.reason).toBe('BLOCKED_BY_DEPENDENCIES');
    expect(entry.unsatisfiedDependencies).toEqual(['A']);
  });

  it('releases a task once every dependency is DONE', () => {
    const graph = graphOf([
      def('A', { status: 'DONE' }),
      def('B', { status: 'DONE' }),
      def('C', { dependsOn: ['A', 'B'] }),
    ]);
    expect(eligibilityOf(graph, 'C').eligible).toBe(true);
  });

  it('lists every unsatisfied dependency, sorted, not just the first', () => {
    const graph = graphOf([
      def('Z'),
      def('A'),
      def('M', { status: 'DONE' }),
      def('T', { dependsOn: ['Z', 'M', 'A'] }),
    ]);
    expect(eligibilityOf(graph, 'T').unsatisfiedDependencies).toEqual(['A', 'Z']);
  });

  it('lets DONE win over blocked: a finished task is not "waiting"', () => {
    const graph = graphOf([def('A'), def('B', { status: 'DONE', dependsOn: ['A'] })]);
    expect(eligibilityOf(graph, 'B').reason).toBe('ALREADY_DONE');
  });
});

describe('the unlock metric', () => {
  // The case title said "counts the tasks a completion would release". M2 slice
  // 4 measured that reading false — the walk passes *through* a `DONE` task, so
  // it counts work that is already runnable — and the title is corrected here to
  // the reading the code implements. The assertions are unchanged; see
  // `plan/select-task.ts` and `tests/m2-04-dependencies-and-priorities.test.ts`.
  it('counts the unfinished tasks downstream of one, transitively', () => {
    const graph = graphOf([
      def('A'),
      def('B', { dependsOn: ['A'] }),
      def('C', { dependsOn: ['B'] }),
    ]);
    expect(eligibilityOf(graph, 'A').unlockCount).toBe(2);
    expect(eligibilityOf(graph, 'B').unlockCount).toBe(1);
    expect(eligibilityOf(graph, 'C').unlockCount).toBe(0);
  });

  it('counts a diamond once, not once per path', () => {
    const graph = graphOf([
      def('A'),
      def('B', { dependsOn: ['A'] }),
      def('C', { dependsOn: ['A'] }),
      def('D', { dependsOn: ['B', 'C'] }),
    ]);
    expect(eligibilityOf(graph, 'A').unlockCount).toBe(3);
  });

  it('does not count work that is already finished', () => {
    const graph = graphOf([
      def('A'),
      def('B', { status: 'DONE', dependsOn: ['A'] }),
      def('C', { dependsOn: ['B'] }),
    ]);
    expect(eligibilityOf(graph, 'A').unlockCount).toBe(1);
  });

  it('does not count the task itself', () => {
    expect(eligibilityOf(graphOf([def('A')]), 'A').unlockCount).toBe(0);
  });
});

describe('the ranking tuple', () => {
  it('prefers remediation over new work, however the new work is flagged', () => {
    expect(
      selectedIdOf([
        def('FIX', { kind: 'REMEDIATION', priority: 'LOW' }),
        def('NEW', { priority: 'HIGH', currentFocus: true }),
      ]),
    ).toBe('FIX');
  });

  it('prefers the focused task, at equal kind', () => {
    expect(
      selectedIdOf([
        def('FOCUSED', { currentFocus: true, priority: 'LOW' }),
        def('OTHER', { priority: 'HIGH' }),
      ]),
    ).toBe('FOCUSED');
  });

  it('prefers the higher priority, at equal kind and focus', () => {
    expect(selectedIdOf([def('LOW-ONE', { priority: 'LOW' }), def('HIGH-ONE', { priority: 'HIGH' })])).toBe(
      'HIGH-ONE',
    );
    expect(
      selectedIdOf([def('N', { priority: 'NORMAL' }), def('L', { priority: 'LOW' })]),
    ).toBe('N');
  });

  it('prefers the task that unlocks more, at equal kind, focus and priority', () => {
    // `Z` sorts last by id, so only the unlock metric can put it first.
    expect(
      selectedIdOf([
        def('A'),
        def('Z'),
        def('B', { dependsOn: ['Z'] }),
        def('C', { dependsOn: ['Z'] }),
      ]),
    ).toBe('Z');
  });

  it('falls back to the id, so no two tasks can ever tie', () => {
    expect(selectedIdOf([def('B'), def('A'), def('C')])).toBe('A');
  });

  it('exposes the tuple it ranked by', () => {
    const graph = graphOf([def('A', { kind: 'REMEDIATION', currentFocus: true, priority: 'HIGH' })]);
    expect(taskRankingKey(eligibilityOf(graph, 'A'), graph)).toEqual([0, 0, 0, 0, 'A']);
  });

  it('orders the tuple most-significant first: kind, focus, priority, unlock, id', () => {
    const graph = graphOf([
      def('A', { kind: 'NORMAL', currentFocus: false, priority: 'LOW' }),
      def('B', { dependsOn: ['A'] }),
    ]);
    expect(taskRankingKey(eligibilityOf(graph, 'A'), graph)).toEqual([1, 1, 2, -1, 'A']);
  });
});

describe('selection outcomes', () => {
  it('publishes its outcome codes as a closed set', () => {
    expect([...TASK_SELECTION_CODES]).toEqual([
      'TASK_SELECTED',
      'ALL_TASKS_COMPLETE',
      'NO_ELIGIBLE_TASK',
    ]);
  });

  it('selects a task when one is eligible', () => {
    const outcome = selectNextTask(graphOf([def('A')]));
    expect(outcome.code).toBe('TASK_SELECTED');
    expect(outcome.selected?.id).toBe('A');
  });

  it('reports ALL_TASKS_COMPLETE only when every task is DONE', () => {
    const outcome = selectNextTask(
      graphOf([def('A', { status: 'DONE' }), def('B', { status: 'DONE', dependsOn: ['A'] })]),
    );
    expect(outcome.code).toBe('ALL_TASKS_COMPLETE');
    expect(outcome.selected).toBeNull();
  });

  it('ranks exactly the eligible tasks, best first', () => {
    const outcome = selectNextTask(
      graphOf([
        def('A', { status: 'DONE' }),
        def('B', { dependsOn: ['A'] }),
        def('C', { dependsOn: ['B'] }),
        def('D', { priority: 'HIGH' }),
      ]),
    );
    expect(outcome.ranking).toEqual(['D', 'B']);
    expect(outcome.selected?.id).toBe('D');
  });

  it('always selects the head of its own ranking', () => {
    const outcome = selectNextTask(
      graphOf([def('B', { priority: 'HIGH' }), def('A'), def('C', { currentFocus: true })]),
    );
    expect(outcome.selected?.id).toBe(outcome.ranking[0]);
  });

  it('carries the full eligibility report either way', () => {
    const outcome = selectNextTask(graphOf([def('A', { status: 'DONE' })]));
    expect(outcome.eligibility.map((entry) => entry.taskId)).toEqual(['A']);
  });

  it('exposes nothing mutable', () => {
    const outcome = selectNextTask(graphOf([def('A')]));
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.ranking)).toBe(true);
    expect(Object.isFrozen(outcome.eligibility)).toBe(true);
  });
});

describe('determinism', () => {
  const CANDIDATES: readonly TaskDefinition[] = [
    def('AO-008', { status: 'DONE' }),
    def('V1-01', { status: 'DONE' }),
    def('V1-02', { dependsOn: ['V1-01'], priority: 'HIGH', currentFocus: true }),
    def('V1-03', { dependsOn: ['V1-02'] }),
    def('V1-04', { dependsOn: ['V1-02'], priority: 'HIGH' }),
    def('OPS-1', { priority: 'LOW' }),
    def('FIX-1', { kind: 'REMEDIATION', dependsOn: ['AO-008'] }),
  ];

  it('selects the same task for 100 different input orders', () => {
    const expected = selectNextTask(graphOf(CANDIDATES));
    for (let seed = 1; seed <= 100; seed += 1) {
      const outcome = selectNextTask(graphOf(shuffle(CANDIDATES, seed)));
      expect(outcome.code, `seed ${seed}`).toBe(expected.code);
      expect(outcome.selected?.id, `seed ${seed}`).toBe(expected.selected?.id);
      expect(outcome.ranking, `seed ${seed}`).toEqual(expected.ranking);
      expect(outcome.eligibility, `seed ${seed}`).toEqual(expected.eligibility);
    }
  });

  it('picks the remediation task in that plan, and says so reproducibly', () => {
    expect(selectNextTask(graphOf(CANDIDATES)).selected?.id).toBe('FIX-1');
  });
});

describe('the no-eligible-task floor', () => {
  it('is representable', () => {
    expect(TASK_SELECTION_CODES).toContain('NO_ELIGIBLE_TASK');
  });

  it('is unreachable for a valid graph that still has open work', () => {
    // In an acyclic graph where every dependency exists, the topologically
    // first OPEN task can have no OPEN dependency — so an eligible task always
    // exists. The outcome is kept as a fail-closed floor rather than as a
    // reachable state; this is the evidence for that claim.
    for (let seed = 1; seed <= 100; seed += 1) {
      let state = seed * 7919 + 13;
      const next = (bound: number): number => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % bound;
      };
      const size = 2 + next(8);
      const definitions: TaskDefinition[] = [];
      for (let i = 0; i < size; i += 1) {
        // Depend only on earlier tasks, which guarantees acyclicity.
        const dependsOn = definitions
          .filter(() => next(3) === 0)
          .map((earlier) => earlier.id)
          .slice(0, 4);
        definitions.push(
          def(`T${String(i).padStart(2, '0')}`, {
            status: next(2) === 0 ? 'DONE' : 'OPEN',
            dependsOn,
          }),
        );
      }
      const outcome = selectNextTask(graphOf(definitions));
      const hasOpen = definitions.some((definition) => definition.status === 'OPEN');
      expect(outcome.code, `seed ${seed}`).toBe(hasOpen ? 'TASK_SELECTED' : 'ALL_TASKS_COMPLETE');
    }
  });
});
