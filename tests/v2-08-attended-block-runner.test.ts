/**
 * V2-08 — the attended block runner.
 *
 * The controls are written against the two things this slice can get wrong in a
 * way nothing else would catch:
 *
 *  - confusing a *task* failure with a failure of the *run's ability to make a
 *    durable claim*, and
 *  - answering "may B continue after A?" from anything other than the frozen
 *    plan.
 *
 * So every case here is driven by effect. A stop is asserted on the persisted
 * ledger, never on an in-memory value; an outcome that is *not* recorded is
 * asserted by comparing the file byte for byte **across the condition** — not
 * against an empty file, because a run that settled a task before meeting one
 * of those outcomes wrote that settlement and is right to keep it; and the
 * independence cases include the one shape a direct intra-block edge check
 * cannot see.
 */

import { describe, expect, it } from 'vitest';

import {
  defineBlock,
  fingerprintBlockDefinition,
  type FrozenTaskDependency,
} from '../src/block/block-definition.js';

/** Rows for a block whose members depend on nothing. */
function independentRows(taskIds: readonly string[]): readonly FrozenTaskDependency[] {
  return taskIds.map((taskId) => ({ taskId, dependsOn: [] }));
}

describe('the frozen plan carries the dependency relation', () => {
  it('requires exactly one row per member', () => {
    const missing = defineBlock('V2', ['A-001', 'B-001'], [{ taskId: 'A-001', dependsOn: [] }]);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('DEPENDENCY_ROW_MISSING');
  });

  it('refuses a row for a task the block does not hold', () => {
    const foreign = defineBlock('V2', ['A-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.code).toBe('DEPENDENCY_ROW_UNKNOWN');
  });

  it('refuses two rows for one member', () => {
    const twice = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(twice.ok).toBe(false);
    if (twice.ok) return;
    expect(twice.code).toBe('DEPENDENCY_ROW_REPEATED');
  });

  it('refuses a dependency on a non-member and on itself', () => {
    const unknown = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['X-001'] },
    ]);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe('DEPENDENCY_UNKNOWN');

    const itself = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: ['A-001'] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(itself.ok).toBe(false);
    if (itself.ok) return;
    expect(itself.code).toBe('DEPENDENCY_SELF');
  });

  it('canonicalises the rows: member order, deduplicated and sorted edges', () => {
    const defined = defineBlock('V2', ['B-001', 'A-001', 'C-001'], [
      { taskId: 'C-001', dependsOn: ['B-001', 'A-001', 'B-001'] },
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    // Rows mirror `taskIds`, which is the operator's order and is identity.
    expect(defined.definition.dependencies.map((row) => row.taskId)).toEqual([
      'B-001',
      'A-001',
      'C-001',
    ]);
    expect(defined.definition.dependencies[2]?.dependsOn).toEqual(['A-001', 'B-001']);
  });

  // The control design §8.3e names. Without it the new authority is modelled
  // and not frozen, which is the whole point of putting it in the plan.
  it('binds the relation into the fingerprint', () => {
    const withoutEdge = defineBlock('V2', ['A-001', 'B-001'], independentRows(['A-001', 'B-001']));
    const withEdge = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    expect(withoutEdge.ok && withEdge.ok).toBe(true);
    if (!withoutEdge.ok || !withEdge.ok) return;

    // Same blockId, same taskIds, one edge added.
    expect(withEdge.definition.blockId).toBe(withoutEdge.definition.blockId);
    expect(withEdge.definition.taskIds).toEqual(withoutEdge.definition.taskIds);
    expect(fingerprintBlockDefinition(withEdge.definition)).not.toBe(
      fingerprintBlockDefinition(withoutEdge.definition),
    );
  });

  it('gives one relation one digest, however the caller spelled it', () => {
    const a = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'B-001', dependsOn: ['A-001', 'A-001'] },
      { taskId: 'A-001', dependsOn: [] },
    ]);
    const b = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(fingerprintBlockDefinition(a.definition)).toBe(
      fingerprintBlockDefinition(b.definition),
    );
  });

  it('cannot encode two different plans to one string', () => {
    // The separators are the whole reason a collision is impossible, so the
    // shapes that would collide under a single separator are named.
    const one = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: ['B-001'] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    const other = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    expect(one.ok && other.ok).toBe(true);
    if (!one.ok || !other.ok) return;
    expect(fingerprintBlockDefinition(one.definition)).not.toBe(
      fingerprintBlockDefinition(other.definition),
    );
  });
});

import { projectBlockDependencies } from '../src/block/block-dependencies.js';
import { normalizeTaskGraph } from '../src/plan/task-graph.js';
import type { TaskDefinition } from '../src/plan/task-definition.js';

/** A definition with only the fields the graph reads. */
function task(id: string, dependsOn: readonly string[] = []): TaskDefinition {
  return {
    id,
    title: `task ${id}`,
    status: 'OPEN',
    kind: 'NORMAL',
    priority: 'NORMAL',
    currentFocus: false,
    dependsOn,
  };
}

function graphOf(definitions: readonly TaskDefinition[]) {
  const normalized = normalizeTaskGraph(definitions);
  if (!normalized.ok) throw new Error(`fixture graph is not a graph: ${normalized.code}`);
  return normalized.graph;
}

describe('the projection is transitive, and restricted to members', () => {
  // The control design §8.3f names, and the one that distinguishes the correct
  // projection from the seductive, wrong, direct intra-block check. X is not a
  // member, so no intra-block edge exists at all — and B still depends on A.
  it('sees a dependency that runs through a non-member', () => {
    const graph = graphOf([task('A-001'), task('X-001', ['A-001']), task('B-001', ['X-001'])]);

    const projected = projectBlockDependencies(graph, ['A-001', 'B-001']);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.dependencies).toEqual([
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
  });

  it('does not record a dependency on a non-member', () => {
    // The consequence stated in the design: a member whose path to eligibility
    // runs through a non-member is not recorded as dependent on anything. That
    // block can be frozen and that member can never become eligible, which ends
    // the run NO_ELIGIBLE_TASK rather than pretending it is blocked by a sibling.
    const graph = graphOf([task('A-001'), task('X-001'), task('B-001', ['X-001'])]);

    const projected = projectBlockDependencies(graph, ['A-001', 'B-001']);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.dependencies).toEqual([
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
  });

  it('collapses a diamond and sorts what it found', () => {
    const graph = graphOf([
      task('A-001'),
      task('M-001', ['A-001']),
      task('N-001', ['A-001']),
      task('Z-001', ['M-001', 'N-001']),
    ]);

    const projected = projectBlockDependencies(graph, ['Z-001', 'A-001', 'M-001']);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    // Rows follow the caller's member order; edges are sorted canonically.
    expect(projected.dependencies).toEqual([
      { taskId: 'Z-001', dependsOn: ['A-001', 'M-001'] },
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'M-001', dependsOn: ['A-001'] },
    ]);
  });

  it('refuses a member the repository does not declare', () => {
    const graph = graphOf([task('A-001')]);

    const projected = projectBlockDependencies(graph, ['A-001', 'GHOST-001']);

    expect(projected.ok).toBe(false);
    if (projected.ok) return;
    expect(projected.code).toBe('TASK_NOT_IN_GRAPH');
    expect(projected.taskId).toBe('GHOST-001');
  });

  it('feeds a definition that `defineBlock` accepts unchanged', () => {
    // The projection's output is the definition's input, so the two
    // canonicalisations must already agree. If `defineBlock` had to reorder or
    // deduplicate anything here, the fingerprint would depend on which of the
    // two ran last.
    const graph = graphOf([task('A-001'), task('X-001', ['A-001']), task('B-001', ['X-001'])]);
    const projected = projectBlockDependencies(graph, ['A-001', 'B-001']);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const defined = defineBlock('V2', ['A-001', 'B-001'], projected.dependencies);
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    expect(defined.definition.dependencies).toEqual(projected.dependencies);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory = join(PACKAGE_ROOT, 'src')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

/** Every production module that can reach `projectBlockDependencies` statically. */
function projectionCallSites(): string[] {
  const declaring = join(PACKAGE_ROOT, 'src', 'block', 'block-dependencies.ts');
  const reached: string[] = [];
  for (const file of sourceFiles()) {
    if (file === declaring) continue;
    const text = readFileSync(file, 'utf8');
    const namesTheModule = /['"][^'"]*block-dependencies\.js['"]/.test(text);
    const named =
      namesTheModule &&
      /import[\s\S]{0,400}?\{[\s\S]{0,400}?\bprojectBlockDependencies\b[\s\S]{0,400}?\}/.test(text);
    const indirect =
      namesTheModule &&
      (/import\s*\*\s*as\s+\w+/.test(text) ||
        /import\s*\(/.test(text) ||
        /export\s*(\*|\{[^}]*\})\s*from/.test(text));
    if (named || indirect) reached.push(relative(PACKAGE_ROOT, file));
  }
  return reached.sort();
}

describe('the projection is computed at freeze time and nowhere else', () => {
  it('is reachable from exactly one production module', () => {
    // The freeze site, and nothing else. Not a style rule: a second caller is a
    // second moment at which "may B continue after A?" could be answered, and
    // the whole authority argument is that it is answered once, before the run,
    // and then frozen.
    //
    // Until Task 11 lands this list is empty, which is also correct — nothing
    // in src/ freezes a block yet. Change the expectation in the same commit
    // that adds the caller, never afterwards.
    expect(projectionCallSites()).toEqual([]);
  });

  it('is not reachable from the runner, by any route', () => {
    // Stated separately from the list above, because this is the claim the
    // runner's module header makes and a reader should be able to find it here
    // under its own name.
    expect(projectionCallSites()).not.toContain(join('src', 'block', 'block-runner.ts'));
  });
});
