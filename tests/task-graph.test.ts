/**
 * Normalisation of a set of task definitions into a dependency DAG.
 *
 * The property under test throughout is *determinism*: the same tasks must
 * produce the same graph, byte for byte, whatever order the filesystem, the
 * parser or a caller happened to hand them over in. A planner whose answer
 * depended on directory order would give two machines two different next tasks
 * from one repository.
 *
 * The second property is that the graph layer validates its own input. It is
 * typed to receive values that came through `TaskDefinitionSchema`, but it does
 * not *rely* on that: the tests below hand it definitions that the schema would
 * have refused, and require it to fail closed anyway.
 */

import { describe, expect, it } from 'vitest';

import type { TaskDefinition } from '../src/plan/task-definition.js';
import {
  MAX_TASK_GRAPH_SIZE,
  TASK_GRAPH_FAILURE_CODES,
  normalizeTaskGraph,
  type NormalizedTaskGraph,
} from '../src/plan/task-graph.js';

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

/** Normalises, requiring success. */
function graphOf(definitions: readonly TaskDefinition[]): NormalizedTaskGraph {
  const result = normalizeTaskGraph(definitions);
  if (!result.ok) throw new Error(`expected a graph, got ${result.code}`);
  return result.graph;
}

/** A total, order-independent fingerprint of a graph's structure. */
function fingerprint(graph: NormalizedTaskGraph): string {
  return JSON.stringify({
    taskIds: graph.taskIds,
    topologicalOrder: graph.topologicalOrder,
    nodes: graph.taskIds.map((id) => {
      const node = graph.node(id);
      return { id, dependsOn: node?.dependsOn, dependents: node?.dependents };
    }),
  });
}

/** A deterministic shuffle, so a failure can be reproduced from its seed. */
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

const DIAMOND: readonly TaskDefinition[] = [
  def('A'),
  def('B', { dependsOn: ['A'] }),
  def('C', { dependsOn: ['A'] }),
  def('D', { dependsOn: ['B', 'C'] }),
];

describe('graph normalisation', () => {
  it('orders tasks by id, not by input order', () => {
    const graph = graphOf([def('V1-03'), def('AO-008'), def('V1-01')]);
    expect(graph.taskIds).toEqual(['AO-008', 'V1-01', 'V1-03']);
    expect(graph.tasks.map((task) => task.id)).toEqual(['AO-008', 'V1-01', 'V1-03']);
  });

  it('produces an identical graph for every input order', () => {
    const expected = fingerprint(graphOf(DIAMOND));
    for (let seed = 1; seed <= 100; seed += 1) {
      expect(fingerprint(graphOf(shuffle(DIAMOND, seed))), `seed ${seed}`).toBe(expected);
    }
  });

  it('records the edge direction as "a dependency points at its dependent"', () => {
    // B dependsOn A  means  A -> B: A must finish before B can start.
    const graph = graphOf([def('A'), def('B', { dependsOn: ['A'] })]);
    expect(graph.node('A')?.dependents).toEqual(['B']);
    expect(graph.node('A')?.dependsOn).toEqual([]);
    expect(graph.node('B')?.dependsOn).toEqual(['A']);
    expect(graph.node('B')?.dependents).toEqual([]);
  });

  it('sorts both edge lists, whatever order they were written in', () => {
    const graph = graphOf([def('A'), def('B'), def('C', { dependsOn: ['B', 'A'] })]);
    expect(graph.node('C')?.dependsOn).toEqual(['A', 'B']);
  });

  it('answers lookups for known ids and refuses unknown ones', () => {
    const graph = graphOf(DIAMOND);
    expect(graph.has('A')).toBe(true);
    expect(graph.has('Z')).toBe(false);
    expect(graph.node('Z')).toBeNull();
    expect(graph.node('A')?.definition.id).toBe('A');
    expect(graph.size).toBe(4);
  });

  it('exposes nothing mutable', () => {
    const graph = graphOf(DIAMOND);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.taskIds)).toBe(true);
    expect(Object.isFrozen(graph.tasks)).toBe(true);
    expect(Object.isFrozen(graph.topologicalOrder)).toBe(true);
    const node = graph.node('D');
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node?.dependsOn)).toBe(true);
    expect(Object.isFrozen(node?.dependents)).toBe(true);
  });
});

describe('topological order', () => {
  it('places every dependency before every dependent', () => {
    const graph = graphOf(DIAMOND);
    const position = new Map(graph.topologicalOrder.map((id, index) => [id, index]));
    for (const id of graph.taskIds) {
      for (const dependency of graph.node(id)?.dependsOn ?? []) {
        expect(position.get(dependency), `${dependency} before ${id}`).toBeLessThan(
          position.get(id) as number,
        );
      }
    }
  });

  it('breaks ties by id, so the order is one order and not a family of them', () => {
    const graph = graphOf([def('B'), def('A'), def('C')]);
    expect(graph.topologicalOrder).toEqual(['A', 'B', 'C']);
  });

  it('contains every task exactly once', () => {
    const graph = graphOf(DIAMOND);
    expect([...graph.topologicalOrder].sort()).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('graph-wide validation', () => {
  it('publishes its failure codes as a closed set', () => {
    expect([...TASK_GRAPH_FAILURE_CODES]).toEqual([
      'TASK_GRAPH_EMPTY',
      'TASK_GRAPH_TOO_LARGE',
      'TASK_ID_DUPLICATE',
      'TASK_DEPENDENCY_SELF',
      'TASK_DEPENDENCY_UNKNOWN',
      'TASK_GRAPH_CYCLE',
    ]);
  });

  it('refuses an empty set rather than calling it a finished plan', () => {
    const result = normalizeTaskGraph([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_GRAPH_EMPTY');
  });

  it('refuses a set beyond the size ceiling', () => {
    const many = Array.from({ length: MAX_TASK_GRAPH_SIZE + 1 }, (_v, i) =>
      def(`T${String(i).padStart(5, '0')}`),
    );
    const result = normalizeTaskGraph(many);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_GRAPH_TOO_LARGE');
  });

  it('accepts a set exactly at the ceiling', () => {
    const many = Array.from({ length: MAX_TASK_GRAPH_SIZE }, (_v, i) =>
      def(`T${String(i).padStart(5, '0')}`),
    );
    expect(normalizeTaskGraph(many).ok).toBe(true);
  });

  it('refuses two tasks claiming the same id', () => {
    const result = normalizeTaskGraph([def('A'), def('A')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_ID_DUPLICATE');
    expect(result.taskId).toBe('A');
  });

  it('refuses two ids that differ only in case', () => {
    // `V1-02.md` and `v1-02.md` cannot both exist on Windows, so a repository
    // carrying both is one that cannot be checked out here at all.
    const result = normalizeTaskGraph([def('V1-02'), def('v1-02')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_ID_DUPLICATE');
  });

  it('refuses a task that depends on itself, without trusting the schema', () => {
    const result = normalizeTaskGraph([def('A', { dependsOn: ['A'] })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_DEPENDENCY_SELF');
    expect(result.taskId).toBe('A');
  });

  it('refuses a dependency on a task that does not exist', () => {
    const result = normalizeTaskGraph([def('A', { dependsOn: ['GHOST'] })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_DEPENDENCY_UNKNOWN');
    expect(result.taskId).toBe('A');
  });

  it('treats a dependency that differs only in case as unknown', () => {
    const result = normalizeTaskGraph([def('V1-01'), def('B', { dependsOn: ['v1-01'] })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_DEPENDENCY_UNKNOWN');
  });

  it('refuses a two-task cycle', () => {
    const result = normalizeTaskGraph([
      def('A', { dependsOn: ['B'] }),
      def('B', { dependsOn: ['A'] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_GRAPH_CYCLE');
  });

  it('refuses a longer cycle, and finds it from any input order', () => {
    const cyclic = [
      def('A', { dependsOn: ['C'] }),
      def('B', { dependsOn: ['A'] }),
      def('C', { dependsOn: ['B'] }),
      def('D'),
    ];
    for (let seed = 1; seed <= 20; seed += 1) {
      const result = normalizeTaskGraph(shuffle(cyclic, seed));
      expect(result.ok, `seed ${seed}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe('TASK_GRAPH_CYCLE');
    }
  });

  it('accepts a graph that merely looks cyclic but is not', () => {
    // Two independent chains sharing a name prefix. A sloppy cycle check that
    // compared prefixes rather than ids would reject this.
    expect(
      normalizeTaskGraph([
        def('A'),
        def('A-1', { dependsOn: ['A'] }),
        def('A-1-1', { dependsOn: ['A-1'] }),
      ]).ok,
    ).toBe(true);
  });
});

describe('graph failures are data', () => {
  it('carries a static sentence and never a host path', () => {
    const result = normalizeTaskGraph([def('A', { dependsOn: ['GHOST'] })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.detail).not.toContain('D:\\');
    expect(result.detail).not.toContain('GHOST');
  });

  it('never throws, even for definitions the schema would have refused', () => {
    const hostile = [
      [def('A', { dependsOn: ['A'] })],
      [def('A', { dependsOn: ['A', 'A'] })],
      [def('A'), def('A')],
      [],
    ];
    for (const definitions of hostile) {
      expect(() => normalizeTaskGraph(definitions)).not.toThrow();
    }
  });
});
