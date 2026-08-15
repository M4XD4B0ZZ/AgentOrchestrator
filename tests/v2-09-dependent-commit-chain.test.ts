/**
 * V2-09 — dependent execution and the controlled commit chain.
 *
 * Every control of this slice lives here. The cheap ones drive pure functions
 * and injected Git seams; the expensive ones are named in the plan's budget
 * table and each carries the defect it proves that a cheaper test cannot.
 */

import { describe, expect, it } from 'vitest';

import { chainShapeOf, uniqueMaximumOf } from '../src/block/chain-shape.js';
import {
  classifyAncestry,
  commitIsReferenced,
  commitObjectPresent,
} from '../src/worktree/commit-probes.js';

const rows = (spec: Record<string, readonly string[]>) =>
  Object.entries(spec).map(([taskId, dependsOn]) => ({ taskId, dependsOn }));

describe('the chain shape is read from the frozen relation', () => {
  it('gives a member with no frozen predecessor no maximum, and that is not a refusal', () => {
    const result = uniqueMaximumOf(rows({ 'task-a': [], 'task-b': [] }), 'task-a');
    expect(result).toEqual({ ok: true, maximum: null });
  });

  it('names the deepest predecessor of a path as the maximum', () => {
    // The relation is transitive by construction, so B's row lists both.
    const relation = rows({ 'task-a1': [], 'task-a2': ['task-a1'], 'task-b': ['task-a1', 'task-a2'] });
    expect(uniqueMaximumOf(relation, 'task-b')).toEqual({ ok: true, maximum: 'task-a2' });
    expect(uniqueMaximumOf(relation, 'task-a2')).toEqual({ ok: true, maximum: 'task-a1' });
  });

  it('refuses two incomparable predecessors rather than choosing one', () => {
    const relation = rows({ 'task-a1': [], 'task-a2': [], 'task-b': ['task-a1', 'task-a2'] });
    expect(uniqueMaximumOf(relation, 'task-b')).toEqual({ ok: false, code: 'NO_UNIQUE_MAXIMUM' });
  });

  it('refuses a member the relation does not hold a row for', () => {
    expect(uniqueMaximumOf(rows({ 'task-a': [] }), 'task-z')).toEqual({
      ok: false,
      code: 'TASK_NOT_IN_RELATION',
    });
  });

  it('judges the whole block, and names the first member that has no shape', () => {
    expect(chainShapeOf(rows({ 'task-a1': [], 'task-a2': ['task-a1'], 'task-b': ['task-a1', 'task-a2'] })))
      .toEqual({ ok: true });
    expect(chainShapeOf(rows({ 'task-a1': [], 'task-a2': [], 'task-b': ['task-a1', 'task-a2'] })))
      .toEqual({ ok: false, code: 'NO_UNIQUE_MAXIMUM', taskId: 'task-b' });
  });

  // Specificity (G6): the shape rule must not refuse the blocks V2-08 already runs.
  it('accepts a wholly independent block, which is the shape V2-08 supports', () => {
    expect(chainShapeOf(rows({ 'task-a': [], 'task-b': [], 'task-c': [] }))).toEqual({ ok: true });
  });
});

const gitReturning = (result: Partial<{ outcome: string; stdout: string; exitCode: number | null }>) =>
  (async () => ({ outcome: 'OK', stdout: '', exitCode: 0, ...result })) as never;

describe('the commit probes separate an answer from a refusal to answer', () => {
  it('reads exit 1 as a genuine "no" and 128 as "could not evaluate"', async () => {
    expect(await classifyAncestry(gitReturning({ outcome: 'OK' }), 'C:/r', 'a', 'b')).toBe('ANCESTOR');
    expect(await classifyAncestry(gitReturning({ outcome: 'NONZERO_EXIT', exitCode: 1 }), 'C:/r', 'a', 'b'))
      .toBe('NOT_ANCESTOR');
    expect(await classifyAncestry(gitReturning({ outcome: 'NONZERO_EXIT', exitCode: 128 }), 'C:/r', 'a', 'b'))
      .toBe('INDETERMINATE');
    expect(await classifyAncestry(gitReturning({ outcome: 'UNAVAILABLE', exitCode: null }), 'C:/r', 'a', 'b'))
      .toBe('INDETERMINATE');
  });

  it('answers presence only on exit 0 and exit 1', async () => {
    expect(await commitObjectPresent(gitReturning({ outcome: 'OK' }), 'C:/r', 'a')).toBe(true);
    expect(await commitObjectPresent(gitReturning({ outcome: 'NONZERO_EXIT', exitCode: 1 }), 'C:/r', 'a')).toBe(false);
    expect(await commitObjectPresent(gitReturning({ outcome: 'NONZERO_EXIT', exitCode: 128 }), 'C:/r', 'a')).toBeNull();
  });

  it('calls a commit referenced when some ref contains it, and unknown when Git could not say', async () => {
    expect(await commitIsReferenced(gitReturning({ outcome: 'OK', stdout: 'refs/heads/agent/task-a' }), 'C:/r', 'a'))
      .toBe(true);
    expect(await commitIsReferenced(gitReturning({ outcome: 'OK', stdout: '' }), 'C:/r', 'a')).toBe(false);
    expect(await commitIsReferenced(gitReturning({ outcome: 'UNAVAILABLE', exitCode: null }), 'C:/r', 'a')).toBeNull();
  });
});
