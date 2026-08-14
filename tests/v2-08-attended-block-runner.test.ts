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

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  defineBlock,
  fingerprintBlockDefinition,
  fingerprintFrozenMembership,
  type FrozenTaskDependency,
} from '../src/block/block-definition.js';
import {
  BLOCK_LEDGER_SCHEMA_VERSION,
  safeParseBlockRunLedger,
} from '../src/block/block-ledger.js';
import { startBlockRun } from '../src/block/block-progress.js';
import {
  loadBlockLedger,
  updateBlockLedger,
  type LedgerLoadResult,
  type LedgerSaveResult,
} from '../src/block/block-store.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';
import { e2eProfile, taskFile } from './helpers/e2e-fixtures.js';

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

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const RUN_ID = 'run-0001';
const BLOCK_ID = 'V2';
const NOW = '2026-08-14T09:00:00.000Z';

interface Fixture {
  readonly repository: ResolvedRepository;
  readonly root: string;
}

/**
 * A real repository whose task files carry the dependencies asked for.
 *
 * Real throughout: the projection is taken from the repository's own graph, so
 * a fixture that wrote the relation by hand would prove only that the fixture
 * agreed with itself.
 */
async function repoWith(tasks: Readonly<Record<string, readonly string[]>>): Promise<Fixture> {
  const files: Record<string, string> = { '.gitignore': '.agent-orchestrator/runtime/\n' };
  for (const [taskId, dependsOn] of Object.entries(tasks)) {
    files[`tasks/${taskId}.md`] = taskFile(taskId, { dependsOn });
  }
  const root = createRepoFixture({ defaultBranch: 'main', profile: e2eProfile(), files });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return { repository, root };
}

function ledgerPath(root: string, runId = RUN_ID): string {
  return join(root, '.agent-orchestrator', 'runtime', 'blocks', `${runId}.json`);
}

/** A frozen, independent block over `taskIds`. */
function independentBlock(taskIds: readonly string[]) {
  const defined = defineBlock(BLOCK_ID, taskIds, independentRows(taskIds));
  if (!defined.ok) throw new Error(`fixture block is not a block: ${defined.code}`);
  return defined.definition;
}

function startRun(fixture: Fixture, definition = independentBlock(['A-001', 'B-001'])) {
  return startBlockRun({
    definition,
    repositoryId: fixture.repository.id,
    repositoryRoot: fixture.root,
    runId: RUN_ID,
    now: NOW,
  });
}

function reload(root: string, runId = RUN_ID) {
  const loaded = loadBlockLedger(root, runId);
  if (!loaded.ok) throw new Error(`ledger did not load: ${loaded.code}`);
  return loaded;
}

describe('the ledger freezes the relation, and version 1 is refused', () => {
  it('writes the relation into the first ledger and fingerprints all three parts', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    expect(startRun(fixture).ok).toBe(true);

    const ledger = reload(fixture.root).ledger;
    expect(ledger.schemaVersion).toBe(2);
    expect(ledger.frozenDependencies).toEqual([
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(ledger.planFingerprint).toBe(
      fingerprintFrozenMembership(BLOCK_ID, ['A-001', 'B-001'], ledger.frozenDependencies),
    );
  });

  it('refuses a document whose fingerprint describes a different relation', () => {
    const honest = independentBlock(['A-001', 'B-001']);
    const edged = defineBlock(BLOCK_ID, ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    if (!edged.ok) throw new Error('fixture block is not a block');

    const lying = {
      schemaVersion: 2,
      repositoryId: 'fixture',
      repositoryRoot: 'D:\\repo',
      blockId: BLOCK_ID,
      runId: RUN_ID,
      startedAt: NOW,
      frozenTaskIds: ['A-001', 'B-001'],
      frozenDependencies: honest.dependencies,
      // The digest of a relation this document does not list. Stored and
      // believed, this inverts drift detection rather than losing it.
      planFingerprint: fingerprintFrozenMembership(
        BLOCK_ID,
        ['A-001', 'B-001'],
        edged.definition.dependencies,
      ),
      activeTaskId: null,
      tasks: [
        { taskId: 'A-001', disposition: 'PLANNED' as const, evidenceRevision: null, baseCommit: null, resultCommit: null },
        { taskId: 'B-001', disposition: 'PLANNED' as const, evidenceRevision: null, baseCommit: null, resultCommit: null },
      ],
      stopReason: null,
    };

    expect(safeParseBlockRunLedger(lying).success).toBe(false);
  });

  it('refuses a relation that is not one canonical row per member, in order', () => {
    const base = {
      schemaVersion: 2,
      repositoryId: 'fixture',
      repositoryRoot: 'D:\\repo',
      blockId: BLOCK_ID,
      runId: RUN_ID,
      startedAt: NOW,
      frozenTaskIds: ['A-001', 'B-001'],
      activeTaskId: null,
      tasks: [
        { taskId: 'A-001', disposition: 'PLANNED' as const, evidenceRevision: null, baseCommit: null, resultCommit: null },
        { taskId: 'B-001', disposition: 'PLANNED' as const, evidenceRevision: null, baseCommit: null, resultCommit: null },
      ],
      stopReason: null,
    };
    // The fingerprint is recomputed for each candidate, so every refusal below
    // is the relation rule refusing — not the digest disagreeing by accident.
    const withRelation = (dependencies: readonly FrozenTaskDependency[]) => ({
      ...base,
      frozenDependencies: dependencies,
      planFingerprint: fingerprintFrozenMembership(BLOCK_ID, ['A-001', 'B-001'], dependencies),
    });

    const refused: readonly (readonly FrozenTaskDependency[])[] = [
      // Short by one row.
      [{ taskId: 'A-001', dependsOn: [] }],
      // Reordered against `frozenTaskIds`.
      [
        { taskId: 'B-001', dependsOn: [] },
        { taskId: 'A-001', dependsOn: [] },
      ],
      // An edge to a stranger.
      [
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: ['X-001'] },
      ],
      // A self-edge.
      [
        { taskId: 'A-001', dependsOn: ['A-001'] },
        { taskId: 'B-001', dependsOn: [] },
      ],
      // Repeated, so one relation would have two encodings.
      [
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: ['A-001', 'A-001'] },
      ],
    ];

    for (const dependencies of refused) {
      expect(safeParseBlockRunLedger(withRelation(dependencies)).success).toBe(false);
    }

    // The control: a canonical relation over the same members is accepted, so
    // the rule above is not simply refusing everything.
    expect(
      safeParseBlockRunLedger(
        withRelation([
          { taskId: 'A-001', dependsOn: [] },
          { taskId: 'B-001', dependsOn: ['A-001'] },
        ]),
      ).success,
    ).toBe(true);
  });

  it('refuses a version-1 document under its own code, and migrates nothing', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);

    // A document exactly as the shipped version-1 build wrote them: no
    // `frozenDependencies`, and a fingerprint over two parts.
    const path = ledgerPath(fixture.root);
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const { frozenDependencies: _dropped, ...version1 } = current;
    writeFileSync(path, `${JSON.stringify({ ...version1, schemaVersion: 1 }, null, 2)}\n`, 'utf8');
    const before = readFileSync(path);

    const loaded = loadBlockLedger(fixture.root, RUN_ID);

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    // Its own code. `LEDGER_CONTRACT_VIOLATION` would tell an operator their
    // file is broken, when what happened is that an older build wrote it.
    expect(loaded.code).toBe('LEDGER_SCHEMA_UNSUPPORTED');
    // And nothing was rewritten on the way to saying so.
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('states the version this build writes', () => {
    expect(BLOCK_LEDGER_SCHEMA_VERSION).toBe(2);
  });
});

import { createHash } from 'node:crypto';

/**
 * Overwrites the on-disk ledger with `content`, and returns the CAS revision
 * it now carries — the sha256 of the exact bytes just written, computed the
 * same way `block-store.ts` computes it, so a caller can hand it straight
 * back as `expectedRevision`.
 */
function corrupt(root: string, content: unknown, runId = RUN_ID): string {
  const bytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`, 'utf8');
  writeFileSync(ledgerPath(root, runId), bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

describe('the schema-version classifier never mislabels corruption as an old build', () => {
  /**
   * Every document that carries no *usable* declaration: no field at all, a
   * `null` field, the whole document itself `null`, and a value of the right
   * name but the wrong type. None of these says "an older build wrote this" —
   * that gentler label is reserved for a version this build can actually name
   * and simply does not match. Reported here as `LEDGER_CONTRACT_VIOLATION` /
   * `PREDECESSOR_INVALID`, exactly as an unparseable document always was.
   */
  const CORRUPT: readonly { readonly label: string; readonly content: unknown }[] = [
    { label: 'a missing schemaVersion', content: {} },
    { label: 'schemaVersion: null', content: { schemaVersion: null } },
    { label: 'the whole document being null', content: null },
    { label: 'schemaVersion as a string', content: { schemaVersion: '2' } },
  ];

  it('loadBlockLedger reports every corrupt declaration as a contract violation, never as an unsupported version, and never throws', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);

    for (const { label, content } of CORRUPT) {
      corrupt(fixture.root, content);

      let loaded: LedgerLoadResult | undefined;
      expect(() => {
        loaded = loadBlockLedger(fixture.root, RUN_ID);
      }, label).not.toThrow();
      expect(loaded?.ok, label).toBe(false);
      if (loaded?.ok !== false) continue;
      expect(loaded.code, label).toBe('LEDGER_CONTRACT_VIOLATION');
    }
  });

  it('loadBlockLedger reports a genuinely valid old version as unsupported, not as a contract violation', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    corrupt(fixture.root, { schemaVersion: 1 });

    let loaded: LedgerLoadResult | undefined;
    expect(() => {
      loaded = loadBlockLedger(fixture.root, RUN_ID);
    }).not.toThrow();
    expect(loaded?.ok).toBe(false);
    if (loaded?.ok !== false) return;
    expect(loaded.code).toBe('LEDGER_SCHEMA_UNSUPPORTED');
  });

  it('updateBlockLedger reports every corrupt predecessor as PREDECESSOR_INVALID, never PREDECESSOR_SCHEMA_UNSUPPORTED, and never throws', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    // The successor is otherwise unremarkable and irrelevant to what is being
    // proved: the predecessor read fails before `next` is ever compared to it.
    const next = reload(fixture.root).ledger;

    for (const { label, content } of CORRUPT) {
      const revision = corrupt(fixture.root, content);

      let saved: LedgerSaveResult | undefined;
      expect(() => {
        saved = updateBlockLedger(next, {
          repositoryRoot: fixture.root,
          expectedRevision: revision,
        });
      }, label).not.toThrow();
      expect(saved?.ok, label).toBe(false);
      if (saved?.ok !== false) continue;
      expect(saved.code, label).toBe('LEDGER_CONFLICT');
      expect(saved.detail, label).toBe('PREDECESSOR_INVALID');
    }
  });

  it('updateBlockLedger reports a genuinely valid old predecessor version as PREDECESSOR_SCHEMA_UNSUPPORTED', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    const next = reload(fixture.root).ledger;
    const revision = corrupt(fixture.root, { schemaVersion: 1 });

    let saved: LedgerSaveResult | undefined;
    expect(() => {
      saved = updateBlockLedger(next, {
        repositoryRoot: fixture.root,
        expectedRevision: revision,
      });
    }).not.toThrow();
    expect(saved?.ok).toBe(false);
    if (saved?.ok !== false) return;
    expect(saved.code).toBe('LEDGER_CONFLICT');
    expect(saved.detail).toBe('PREDECESSOR_SCHEMA_UNSUPPORTED');
  });
});

import {
  BLOCK_STOP_REASONS,
  PROGRESS_CLAIMING_STOP_REASONS,
  type BlockStopReason,
} from '../src/block/block-ledger.js';

describe('the stop-reason vocabulary is sorted correctly, not merely totally', () => {
  /**
   * Written by hand, reason by reason, and deliberately not derived from the
   * production set.
   *
   * `satisfies Record<keyof T>` proves every member was *considered*; it proves
   * nothing about whether each landed on the right side. A table generated from
   * the module under test would agree with it by construction and could never
   * disagree, which is the only thing a correctness test is for.
   */
  const CLAIMS_PROGRESS: Readonly<Record<BlockStopReason, boolean>> = {
    // These three assert what the *tasks* did, and are proved against every
    // task record before they are written.
    COMPLETE: true,
    TASK_BLOCKED: true,
    TASK_ABANDONED: true,
    // These assert only that the run cannot continue, and must stay writable
    // over a ledger whose entries are not supported.
    NO_ELIGIBLE_TASK: false,
    OPERATOR_STOPPED: false,
    LEDGER_DIVERGED: false,
    STATE_UNUSABLE: false,
    DEFINITION_DRIFTED: false,
    ACTIVE_TASK_UNRESOLVED: false,
  };

  it('knows exactly these reasons', () => {
    expect([...BLOCK_STOP_REASONS].sort()).toEqual(Object.keys(CLAIMS_PROGRESS).sort());
  });

  for (const [reason, claims] of Object.entries(CLAIMS_PROGRESS)) {
    it(`${reason} ${claims ? 'claims' : 'does not claim'} progress`, () => {
      expect(PROGRESS_CLAIMING_STOP_REASONS.has(reason as BlockStopReason)).toBe(claims);
    });
  }
});

import { activateBlockTask, stopBlockRun } from '../src/block/block-progress.js';
import { startTask } from '../src/run/start-task.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { leaseFor } from './helpers/lease.js';
import { tickingClock } from './helpers/e2e-fixtures.js';

/** A real task, started through production code, so its state is a real one. */
async function reallyStart(fixture: Fixture, taskId: string): Promise<void> {
  const started = await startTask(
    { repository: fixture.repository, taskId },
    {
      git: runGitCommand,
      now: tickingClock(),
      authPreflight: authPreflightPasses,
      lease: leaseFor(fixture.repository),
    },
  );
  expect(started.outcome).toBe('STARTED');
}

/** The ledger as JSON, read from disk. Assertions are on what persisted. */
function onDisk(root: string, runId = RUN_ID): Record<string, unknown> {
  return JSON.parse(readFileSync(ledgerPath(root, runId), 'utf8')) as Record<string, unknown>;
}

describe('a class-2 stop is writable over a ledger whose entries are not proved', () => {
  it('records ACTIVE_TASK_UNRESOLVED while the task it cannot judge is still ACTIVE', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    expect(
      activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');

    const stopped = stopBlockRun(reload(fixture.root), 'ACTIVE_TASK_UNRESOLVED', {
      repositoryRoot: fixture.root,
    });

    expect(stopped.outcome).toBe('RECORDED');
    const after = onDisk(fixture.root);
    expect(after['stopReason']).toBe('ACTIVE_TASK_UNRESOLVED');
    // The entry is still ACTIVE, under the same activeTaskId, and nothing was
    // invented for the task that could not be concluded.
    expect(after['activeTaskId']).toBe('A-001');
    const entries = after['tasks'] as readonly Record<string, unknown>[];
    expect(entries[0]?.['disposition']).toBe('ACTIVE');
    expect(entries[0]?.['evidenceRevision']).toBeNull();
    expect(entries[0]?.['resultCommit']).toBeNull();
  }, 180_000);
});

import { parkBlockTask } from '../src/block/block-progress.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';

/** Drives a real task's durable state into a blocking one. */
function driveToBlocking(fixture: Fixture, taskId: string): void {
  const loaded = loadTaskState(fixture.root, taskId);
  if (!loaded.ok) throw new Error('fixture: the task never started');
  // `SCOPE_VIOLATION` rather than one of the resumable blocks: it is blocking
  // by the state contract's own classification and carries no resume point, so
  // the fixture states one fact and not three.
  const saved = saveTaskState(
    {
      ...loaded.state,
      state: 'SCOPE_VIOLATION',
      stateEnteredAt: '2026-08-14T12:00:00.000Z',
      blockedAgent: 'claude',
    },
    { repositoryRoot: fixture.root, expectedRevision: loaded.revision },
  );
  if (!saved.ok) throw new Error(`fixture could not reach a blocking state: ${saved.code}`);
}

describe('a task-local failure is recorded and does not end the run', () => {
  it('parks a task without writing a stop reason', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    expect(
      activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');
    driveToBlocking(fixture, 'A-001');

    expect(
      parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');

    const after = onDisk(fixture.root);
    // The evidence-backed disposition is unchanged. Only the run's reaction to
    // it is what V2-08 reverses.
    expect((after['tasks'] as readonly Record<string, unknown>[])[0]?.['disposition']).toBe('BLOCKED');
    expect((after['tasks'] as readonly Record<string, unknown>[])[0]?.['evidenceRevision']).not.toBeNull();
    expect(after['stopReason']).toBeNull();
    expect(after['activeTaskId']).toBeNull();
  }, 180_000);

  it('lets the next task be activated afterwards', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToBlocking(fixture, 'A-001');
    parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    await reallyStart(fixture, 'B-001');

    // This is the assertion that fails against V2-07's policy, so it is the one
    // that proves the reversal actually happened. Under V2-07 the park wrote
    // TASK_BLOCKED and this answered RUN_ALREADY_STOPPED.
    expect(
      activateBlockTask(reload(fixture.root), 'B-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');
  }, 180_000);

  it('still refuses to park a task whose record does not prove it', async () => {
    // The reversal changes the run's reaction, never the evidence rule.
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');

    expect(
      parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
  }, 180_000);
});
