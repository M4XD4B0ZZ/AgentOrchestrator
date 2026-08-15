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

import {
  conclusionForRunOutcome,
  endReasonFor,
  independenceIsEstablished,
  recordingResultFor,
} from '../src/block/block-conclusion.js';
import { BLOCK_PROGRESS_OUTCOMES, type BlockProgressOutcome } from '../src/block/block-progress.js';
import { RUN_OUTCOMES, type RunOutcome } from '../src/run/run-driver.js';
import type { BlockTaskEntry, TaskDisposition } from '../src/block/block-ledger.js';

describe('a run outcome decides what the ledger may be told', () => {
  /**
   * Hand-written, outcome by outcome. Derived from the production map this
   * would be a copy that cannot disagree; the point of the table is that a
   * reviewer graded each row and a future member cannot inherit a grade.
   */
  const EXPECTED: Readonly<Record<RunOutcome, string>> = {
    // The task's own record proves an outcome.
    TASK_COMPLETED: 'SETTLE',
    TASK_ABORTED: 'ABANDON',
    BLOCKED_USAGE_LIMIT: 'PARK',
    BLOCKED_VERIFY: 'PARK',
    BLOCKED_AUTH: 'PARK',
    SCOPE_VIOLATION: 'PARK',
    RESUME_STATE_DIVERGED: 'PARK',
    HUMAN_DECISION_REQUIRED: 'PARK',
    // The run's authority is in doubt. Nothing may be written at all.
    EXECUTION_LEASE_NOT_HELD: 'LEASE_UNCERTAIN',
    EXECUTION_LEASE_LOST: 'LEASE_UNCERTAIN',
    // A task record exists and cannot be used. That is its own class-2 reason.
    STATE_UNUSABLE: 'STATE_UNUSABLE',
    // Durable progress happened and the driver's per-call bound was reached.
    // The one grade that is not an ending at all: the runner drives the same
    // task again under the same lease. Graded any other way, a scheduling limit
    // becomes a claim about a task's outcome — and graded as an ending of the
    // invocation it would need a block run that outlives its lease holder.
    STEP_BUDGET_EXHAUSTED: 'CONTINUE',
    // Everything else leaves the task's outcome undetermined. Each is a real
    // situation and none of them proves settle, park or abandon.
    STATE_DIVERGED: 'UNRESOLVED',
    STATE_UNOBSERVABLE: 'UNRESOLVED',
    TASK_NOT_STARTED: 'UNRESOLVED',
    STATE_CONFLICT: 'UNRESOLVED',
    STATE_NOT_RECORDED: 'UNRESOLVED',
    CONTINUATION_NOT_AUTHORISED: 'UNRESOLVED',
    EXECUTION_UNAUTHORISED: 'UNRESOLVED',
    NO_PROGRESS: 'UNRESOLVED',
  };

  it('grades every run outcome, and only the run outcomes', () => {
    expect([...RUN_OUTCOMES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [outcome, conclusion] of Object.entries(EXPECTED)) {
    it(`${outcome} -> ${conclusion}`, () => {
      expect(conclusionForRunOutcome(outcome as RunOutcome)).toBe(conclusion);
    });
  }
});

describe('a progress outcome decides whether anything landed', () => {
  const EXPECTED: Readonly<Record<BlockProgressOutcome, string>> = {
    RECORDED: 'RECORDED',
    // The write itself could not be made. The run cannot presuppose a
    // successful stop write either, so this is the no-write exit.
    NOT_RECORDED: 'WRITE_FAILED',
    // Every refusal that is *about the claim* rather than about the write. The
    // task's outcome is not established, and the honest end is a stop that says
    // so rather than a second attempt at a claim the records refuse.
    TASK_NOT_IN_RUN: 'UNRESOLVED',
    DISPOSITION_UNCHANGED: 'UNRESOLVED',
    ANOTHER_TASK_ACTIVE: 'UNRESOLVED',
    TASK_STATE_DOES_NOT_PROVE_IT: 'UNRESOLVED',
    TASK_NOT_STARTED: 'UNRESOLVED',
    TASK_STATE_UNUSABLE: 'STATE_UNUSABLE',
    RUN_ALREADY_STOPPED: 'UNRESOLVED',
  };

  it('grades every progress outcome', () => {
    expect([...BLOCK_PROGRESS_OUTCOMES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [outcome, result] of Object.entries(EXPECTED)) {
    it(`${outcome} -> ${result}`, () => {
      expect(recordingResultFor(outcome as BlockProgressOutcome)).toBe(result);
    });
  }
});

describe('the end reason names the cause, not the consequence', () => {
  const entry = (taskId: string, disposition: TaskDisposition): BlockTaskEntry => ({
    taskId,
    disposition,
    evidenceRevision: disposition === 'PLANNED' || disposition === 'ACTIVE' ? null : 'f'.repeat(64),
    baseCommit: null,
    resultCommit: null,
  });

  it('is COMPLETE when every task settled', () => {
    expect(endReasonFor([entry('A-001', 'SETTLED'), entry('B-001', 'SETTLED')])).toBe('COMPLETE');
  });

  // The worked example from the design. A block that did as much as could
  // honestly be done ends naming the task outcome that explains the remainder.
  it('is TASK_BLOCKED when a task is blocked and nothing runnable is left', () => {
    expect(
      endReasonFor([
        entry('A-001', 'BLOCKED'),
        entry('B-001', 'SETTLED'),
        entry('C-001', 'SETTLED'),
      ]),
    ).toBe('TASK_BLOCKED');
  });

  it('prefers BLOCKED over ABANDONED when both are present', () => {
    // Ordered, not arbitrary: a human can act on a blocked task, and nobody can
    // act on an abandoned one. The reason should send them to the one that has
    // a next step.
    expect(endReasonFor([entry('A-001', 'BLOCKED'), entry('B-001', 'ABANDONED')])).toBe(
      'TASK_BLOCKED',
    );
  });

  it('is TASK_ABANDONED when only an abandonment explains the ending', () => {
    expect(endReasonFor([entry('A-001', 'ABANDONED'), entry('B-001', 'SETTLED')])).toBe(
      'TASK_ABANDONED',
    );
  });

  // The other half of the pair. Only both cases together prove an ordering
  // rather than a constant.
  it('is NO_ELIGIBLE_TASK when no disposition explains why nothing is eligible', () => {
    expect(endReasonFor([entry('A-001', 'PLANNED'), entry('B-001', 'SETTLED')])).toBe(
      'NO_ELIGIBLE_TASK',
    );
  });
});

describe('independence is read from the frozen plan', () => {
  it('is established only when no member depends on a member', () => {
    expect(
      independenceIsEstablished([
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: [] },
      ]),
    ).toBe(true);
    expect(
      independenceIsEstablished([
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: ['A-001'] },
      ]),
    ).toBe(false);
  });

  it('does not care which member the edge is on', () => {
    // A relation with any edge at all is dependent execution, which is V2-09.
    // There is no partial answer here and deliberately no per-pair one: "these
    // two are independent, so run them and skip the rest" is the improvised
    // scheduling this slice refuses.
    expect(
      independenceIsEstablished([
        { taskId: 'A-001', dependsOn: ['C-001'] },
        { taskId: 'B-001', dependsOn: [] },
        { taskId: 'C-001', dependsOn: [] },
      ]),
    ).toBe(false);
  });
});

import { planNextTask, type TaskPlanningSuccess } from '../src/plan/plan-next-task.js';
import { startPlannedTask } from '../src/run/start-task.js';
import { git, writeRepoFile } from './helpers/repo-fixtures.js';

/**
 * One reading of the roadmap, exactly as `block-command.ts` takes it.
 *
 * The whole `TaskPlanningSuccess`, not a list of eligible ids: the runner filters
 * by it *and* hands it to the start path, so a suite that produced two values
 * would be testing a shape production does not have.
 */
function planningOf(fixture: Fixture): TaskPlanningSuccess {
  const planned = planNextTask(fixture.repository);
  if (!planned.ok) throw new Error(`fixture repository does not plan: ${planned.code}`);
  return planned;
}

/**
 * The two directions of one control, and a third claim deliberately not made.
 *
 * The pair below discriminates "the eligibility gate moved" from "the
 * eligibility gate was deleted": a start path that re-plans reddens the first
 * case only, and a start path with no eligibility gate at all reddens the second
 * case only. Neither subsumes the other, which is why both are here.
 *
 * **Not proved here:** that the workspace is prepared from the *frozen*
 * definition rather than from the current file. It is a real consequence and
 * worth stating — the task definition the workspace is built from comes out of
 * the same graph the eligibility answer did, so one instant yields one plan, and
 * a start that gated on the frozen reading and then built from an edited file
 * would be the same split authority in a quieter place. There was a case here
 * asserting it, and it was removed: it only checked that the fixture's own graph
 * had a node, called no production code, and would have passed against an
 * implementation that built from the current file. A name promising a control
 * that the body does not provide is worse than no case at all, because it reads
 * as coverage exactly where a reader would look for it. Proving it needs a
 * fixture that changes something the workspace actually derives from the
 * definition; that is recorded as a follow-up rather than faked here.
 */
describe('a start may be authorised by a planning result it did not take', () => {
  it('starts a task the roadmap has since made ineligible', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const frozen = planningOf(fixture);
    // The premise: B-001 is eligible in the frozen reading.
    expect(frozen.selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible).toBe(true);

    // The roadmap moves underneath. A fresh planning now refuses B-001.
    //
    // Committed, and that is not decoration. `prepareTaskWorkspace` refuses a
    // dirty source checkout with `SOURCE_WORKTREE_DIRTY`
    // (`src/worktree/prepare-workspace.ts:406`, `git status --porcelain
    // --untracked-files=all`), so an edit left uncommitted here never reaches
    // the gate this case is about: measured, the start answered
    // WORKSPACE_REFUSED / SOURCE_WORKTREE_DIRTY at step 5 rather than STARTED,
    // against a correct split.
    //
    // And committing does not weaken what is being tested, because planning does
    // not read Git: `discoverTasks` lists the working tree with `readdirSync`
    // (`src/plan/discover-tasks.ts:278`). The commit changes checkout
    // cleanliness and nothing either planning sees — the frozen reading and the
    // fresh one are exactly what they would have been. An operator's mid-run
    // roadmap edit is a commit anyway, so this is also the truthful fixture.
    writeRepoFile(fixture.root, 'tasks/GATE-001.md', taskFile('GATE-001'));
    writeRepoFile(fixture.root, 'tasks/B-001.md', taskFile('B-001', { dependsOn: ['GATE-001'] }));
    git(fixture.root, ['add', '--all']);
    git(fixture.root, ['commit', '--quiet', '-m', 'the roadmap moves under the frozen plan']);
    expect(planningOf(fixture).selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible)
      .toBe(false);

    const started = await startPlannedTask(
      { repository: fixture.repository, taskId: 'B-001', planning: frozen },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: leaseFor(fixture.repository) },
    );

    // The frozen reading is the authority. A path that planned again would
    // answer TASK_INELIGIBLE here, which is exactly the hidden second read.
    expect(started.outcome).toBe('STARTED');
  }, 600_000);

  it('still refuses a task the frozen reading itself calls ineligible', async () => {
    // The other half, and without it the case above passes against a function
    // that skipped the eligibility gate altogether rather than moving it.
    const fixture = await repoWith({ 'A-001': [], 'B-001': ['A-001'] });
    const frozen = planningOf(fixture);
    expect(frozen.selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible).toBe(false);

    const started = await startPlannedTask(
      { repository: fixture.repository, taskId: 'B-001', planning: frozen },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: leaseFor(fixture.repository) },
    );

    expect(started.outcome).toBe('TASK_INELIGIBLE');
  }, 600_000);
});

import { START_TASK_OUTCOMES, type StartTaskOutcome } from '../src/run/start-task.js';
import { START_CONCLUSIONS, startConclusionFor } from '../src/block/block-conclusion.js';

describe('a start outcome decides what the block run may do next', () => {
  /**
   * Hand-written, outcome by outcome, for the reason the two tables above give:
   * a table derived from the production map agrees with it by construction.
   */
  const EXPECTED: Readonly<Record<StartTaskOutcome, string>> = {
    // A durable state exists, however this invocation came by it.
    STARTED: 'DRIVE',
    ADOPTED: 'DRIVE',
    ALREADY_STARTED: 'DRIVE',
    // Authority, not outcome. Nothing may be written at all.
    EXECUTION_LEASE_NOT_HELD: 'LEASE_UNCERTAIN',
    EXECUTION_LEASE_LOST: 'LEASE_UNCERTAIN',
    // A record that exists and cannot be used has its own persisted reason.
    STATE_UNUSABLE: 'STATE_UNUSABLE',
    // Every gate. None of these is a claim about the task's *outcome*, so none
    // may be recorded as one and the entry stays PLANNED — which is true.
    TASK_ID_INVALID: 'GATE_REFUSED',
    PLANNING_FAILED: 'GATE_REFUSED',
    TASK_UNKNOWN: 'GATE_REFUSED',
    TASK_INELIGIBLE: 'GATE_REFUSED',
    RUNTIME_NOT_IGNORED: 'GATE_REFUSED',
    RUNTIME_IGNORE_UNDETERMINED: 'GATE_REFUSED',
    AUTH_PREFLIGHT_FAILED: 'GATE_REFUSED',
    WORKSPACE_COLLISION: 'GATE_REFUSED',
    WORKSPACE_REFUSED: 'GATE_REFUSED',
    STATE_NOT_RECORDED: 'GATE_REFUSED',
  };

  it('grades every start outcome, and only the start outcomes', () => {
    expect([...START_TASK_OUTCOMES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('knows exactly these conclusions', () => {
    expect([...START_CONCLUSIONS].sort()).toEqual([...new Set(Object.values(EXPECTED))].sort());
  });

  for (const [outcome, conclusion] of Object.entries(EXPECTED)) {
    it(`${outcome} -> ${conclusion}`, () => {
      expect(startConclusionFor(outcome as StartTaskOutcome)).toBe(conclusion);
    });
  }
});

import { BLOCK_RUN_OUTCOMES, runAttendedBlock } from '../src/block/block-runner.js';
import {
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  releaseRepositoryExecutionLease,
} from '../src/lease/execution-lease.js';
import type { GitRunner } from '../src/worktree/git-command.js';
import { passingReview } from './fixtures.js';
import { recordedAgent, recordedVerify, reviewResult, writerSuccess } from './helpers/e2e-fixtures.js';

/** Seams that drive a task all the way to `READY_FOR_PR`. */
function drivingSeams() {
  const agent = recordedAgent({
    claude: () => writerSuccess(),
    codex: () => reviewResult(passingReview()),
  });
  const verify = recordedVerify();
  return { agent: agent.runner, verify: verify.runner, agentCalls: agent };
}

/**
 * A writer that reports success while having written outside its scope.
 *
 * Produces a real `SCOPE_VIOLATION`, through the real scope check, rather than
 * a state file edited into place: the task-local failure this suite is about
 * has to be one the product itself produced. The mechanism is the one
 * `tests/v2-06-scope-enforcement.test.ts` drives for its untracked
 * out-of-scope-file case — the fixture profile allows `src` and nothing else,
 * so a file left at the worktree root is a real, measured offence.
 */
function scopeViolatingWriter() {
  return (call: { readonly cwd: string }) => {
    writeRepoFile(call.cwd, 'outside-scope.txt', 'written where the profile does not allow');
    return writerSuccess();
  };
}

/**
 * `planningOf` — added in Task 6B — is the one reading of the roadmap every case
 * below hands to the runner.
 *
 * There is deliberately no second helper producing a list of eligible ids: the
 * runner derives that list from the snapshot itself, so a suite that built one
 * separately would be exercising a shape production does not have.
 */

async function runBlock(
  fixture: Fixture,
  definition = independentBlock(['A-001', 'B-001']),
  overrides: Partial<Parameters<typeof runAttendedBlock>[1]> = {},
) {
  const seams = drivingSeams();
  return runAttendedBlock(
    {
      repository: fixture.repository,
      definition,
      runId: RUN_ID,
      lease: leaseFor(fixture.repository),
      maxStepsPerTask: 8,
      planning: planningOf(fixture),
    },
    {
      now: tickingClock(),
      git: runGitCommand,
      authPreflight: authPreflightPasses,
      agent: seams.agent,
      verify: seams.verify,
      ...overrides,
    },
  );
}

describe('the attended block runner', () => {
  it('runs a block of independent tasks to the end under one lease', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    const result = await runBlock(fixture);

    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('COMPLETE');
    const after = onDisk(fixture.root);
    expect(
      (after['tasks'] as readonly Record<string, unknown>[]).map((t) => t['disposition']),
    ).toEqual(['SETTLED', 'SETTLED']);
    expect(after['stopReason']).toBe('COMPLETE');
  }, 600_000);

  // Design §8.1 — the control that fails against V2-07's policy, driven through
  // the runner rather than through the primitives.
  it('does not stop when one task fails locally', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    const definition = independentBlock(['A-001', 'B-001', 'C-001']);
    const seams = drivingSeams();
    // A-001's writer refuses for scope, which is blocking and carries no resume
    // point. B-001 and C-001 are driven normally.
    const agent = recordedAgent({
      claude: (call) =>
        call.cwd.includes('A-001') ? scopeViolatingWriter()(call) : writerSuccess(),
      codex: () => reviewResult(passingReview()),
    });

    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition,
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: seams.verify,
      },
    );

    const after = onDisk(fixture.root);
    const dispositions = (after['tasks'] as readonly Record<string, unknown>[]).map(
      (task) => task['disposition'],
    );
    // Design §8.4: asserted on the persisted ledger, not on an in-memory value.
    expect(dispositions).toEqual(['BLOCKED', 'SETTLED', 'SETTLED']);
    expect(after['stopReason']).not.toBe('COMPLETE');
    // Design §8.3c: the end reason names the cause.
    expect(after['stopReason']).toBe('TASK_BLOCKED');
    expect(result.stopReason).toBe('TASK_BLOCKED');
  }, 900_000);

  // Design §8.5.
  it('stops at the first local failure when independence is not established', async () => {
    // `A <- X <- B`, with X outside the block: the shape a direct intra-block
    // edge check cannot see. X is `DONE`, and that is what makes this case
    // *discriminate* rather than merely pass — B-001 is then eligible in the
    // frozen reading, so a runner that ignored the frozen relation would go on
    // and drive it. With X-001 left `OPEN`, B-001 is ineligible and `chooseTask`
    // skips it for a reason that has nothing to do with independence, and the
    // case stays green against a runner with no independence check at all.
    // Measured by mutant rather than argued; see the task report.
    const fixture = await repoWith({ 'A-001': [], 'B-001': ['X-001'] });
    writeRepoFile(
      fixture.root,
      'tasks/X-001.md',
      taskFile('X-001', { dependsOn: ['A-001'], status: 'DONE' }),
    );
    git(fixture.root, ['add', '--all']);
    git(fixture.root, ['commit', '--quiet', '-m', 'the non-member between A and B']);

    // One reading, projected from and run against — exactly as the CLI does it.
    const frozen = planningOf(fixture);
    // The premise of the premise: both members are eligible right now, so
    // nothing but the frozen relation can stop B-001 being driven.
    expect(frozen.selection.eligibility.find((e) => e.taskId === 'A-001')?.eligible).toBe(true);
    expect(frozen.selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible).toBe(true);
    const projected = projectBlockDependencies(frozen.graph, ['A-001', 'B-001']);
    if (!projected.ok) throw new Error('fixture projection failed');
    const defined = defineBlock(BLOCK_ID, ['A-001', 'B-001'], projected.dependencies);
    if (!defined.ok) throw new Error('fixture block is not a block');
    // The premise: the projection saw the dependency through the non-member.
    expect(defined.definition.dependencies[1]?.dependsOn).toEqual(['A-001']);

    const agent = recordedAgent({
      claude: (call) => scopeViolatingWriter()(call),
      codex: () => reviewResult(passingReview()),
    });
    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: defined.definition,
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: frozen,
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: recordedVerify().runner,
      },
    );

    expect(result.stopReason).toBe('TASK_BLOCKED');
    const dispositions = (onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[]).map(
      (task) => task['disposition'],
    );
    // B-001 was never touched. Without established independence the run stops
    // at the first local failure, exactly as V2-07 does.
    expect(dispositions).toEqual(['BLOCKED', 'PLANNED']);
    // The same fact measured on the other side of the seam: a run that had
    // continued would have prepared a second worktree and started a second
    // writer in it.
    expect(agent.countFor('claude')).toBe(1);
  }, 600_000);

  // Design §8.6, measured by effect rather than by reading the code.
  it('holds one lease for the whole run, not one per task', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const attempts: string[] = [];
    const agent = recordedAgent({
      claude: () => {
        // A second acquirer, inside the drive of *each* task. A per-task lease
        // would leave a window between tasks; this measures the answer during
        // both of them.
        const second = acquireRepositoryExecutionLease(
          fixture.repository,
          { runId: 'run-0002', blockId: BLOCK_ID },
          { now: () => new Date().toISOString() },
        );
        attempts.push(second.ok ? 'ACQUIRED' : second.code);
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });

    await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: recordedVerify().runner,
      },
    );

    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts)).toEqual(new Set(['LEASE_HELD']));
  }, 600_000);
});

describe('the invocation absorbs the driver budget rather than ending on it', () => {
  it('drives the same task again when only the per-call bound was reached', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    // maxStepsPerTask of 1 makes the driver stop after its first durable write
    // on every call, so a task that needs several reaches STEP_BUDGET_EXHAUSTED
    // repeatedly — the exact condition that used to end the invocation.
    const seams = drivingSeams();
    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 1,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: seams.agent,
        verify: seams.verify,
      },
    );

    // The block still finishes, under one lease, in one invocation.
    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('COMPLETE');
    // And a scheduling limit never became a claim about a task.
    expect(result.stopReason).not.toBe('ACTIVE_TASK_UNRESOLVED');
    expect(onDisk(fixture.root)['stopReason']).toBe('COMPLETE');
    // The bound really was reached, or this case proves nothing: several
    // durable steps landed for a budget of one per call.
    expect(result.steps).toBeGreaterThan(2);
  }, 900_000);

  it('is not a block-run outcome at all', () => {
    // The vocabulary itself, so a future edit that reintroduces the outcome
    // fails here rather than in a behaviour case somebody may not run.
    expect([...BLOCK_RUN_OUTCOMES]).not.toContain('STEP_BUDGET_EXHAUSTED');
  });

  /**
   * The other half of `CONTINUE`'s claim: *under the same lease*.
   *
   * The case above proves the task is driven again; on its own it says nothing
   * about whose authority the continuation runs on. A runner that gave the lease
   * back between two `runTask` calls and took it again would finish the block
   * just the same, having opened — several times over — exactly the window an
   * execution lease exists to close.
   *
   * Two instruments, because neither is sufficient alone.
   *
   * The **lease document's own bytes**, compared across the whole run, are the
   * claim stated directly: a lease given back and taken again is a different
   * lease, carrying a fresh owner nonce and a fresh acquisition time, and the
   * file says so. Nothing in a run rewrites that file — every consumer reads it
   * — so byte identity is exactly "this is still the lease the run opened with".
   *
   * A **competing acquirer**, sampled at every Git call, is the second: it asks
   * whether anyone *else* could have taken the repository, and the first thing a
   * continuation does is reconcile, which is Git. Its blind spot is stated
   * rather than papered over: a window between two `runTask` calls that contains
   * no Git call at all is invisible to it, and that is why the byte comparison
   * above carries the claim.
   */
  it('makes every continuation under the lease the run opened with', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const leaseLocation = deriveExecutionLeaseLocation(fixture.repository);
    if (!leaseLocation.ok) throw new Error('fixture has no lease location');
    const attempts: string[] = [];
    const sampling: GitRunner = async (cwd, args) => {
      const second = acquireRepositoryExecutionLease(
        fixture.repository,
        { runId: 'run-0003', blockId: BLOCK_ID },
        { now: () => new Date().toISOString() },
      );
      attempts.push(second.ok ? 'ACQUIRED' : second.code);
      return runGitCommand(cwd, args);
    };
    const seams = drivingSeams();
    // Read after the lease is taken and before the run: the document this
    // invocation's authority *is*.
    const evidence = leaseFor(fixture.repository);
    const leaseBefore = readFileSync(leaseLocation.path);

    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001']),
        runId: RUN_ID,
        lease: evidence,
        maxStepsPerTask: 1,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: sampling,
        authPreflight: authPreflightPasses,
        agent: seams.agent,
        verify: seams.verify,
      },
    );

    // The claim this case is named for, asserted first because it is the claim:
    // the lease on disk is the very document the run opened with.
    expect(readFileSync(leaseLocation.path).equals(leaseBefore)).toBe(true);
    // The premise: continuations really happened, and the block really finished.
    expect(result.stopReason).toBe('COMPLETE');
    expect(result.steps).toBeGreaterThan(2);
    // The second instrument, and it is not a handful of samples.
    expect(attempts.length).toBeGreaterThan(20);
    expect(new Set(attempts)).toEqual(new Set(['LEASE_HELD']));
  }, 900_000);
});

/**
 * `LEASE_UNCERTAIN` forbids the write, and not merely the claim.
 *
 * `block-conclusion.ts` states it, and nothing consumed that module until this
 * task, so it was an unproved assertion. The distinction is not decorative: a
 * runner that treated lost authority as "an ending that must be recorded" would
 * write a stop reason into a repository it may no longer be the writer of, which
 * is precisely the act it has lost the authority for. Measured on the bytes,
 * across the condition — not against an empty file, because the run had already
 * legitimately recorded an activation before the lease went, and that record is
 * true and stays.
 */
describe('a run that may have stopped being the writer writes nothing at all', () => {
  it('leaves the ledger byte for byte and reports the ending instead', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const evidence = leaseFor(fixture.repository);
    const atRelease: Buffer[] = [];
    const agent = recordedAgent({
      claude: () => {
        // The last provably durable state this run reached: A-001 activated.
        atRelease.push(readFileSync(ledgerPath(fixture.root)));
        // The repository stops being this invocation's to write.
        releaseRepositoryExecutionLease(evidence);
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });

    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001']),
        runId: RUN_ID,
        lease: evidence,
        maxStepsPerTask: 8,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: recordedVerify().runner,
      },
    );

    expect(result.outcome).toBe('LEASE_AUTHORITY_UNCERTAIN');
    // Reported, never recorded.
    expect(result.stopReason).toBeNull();

    const before = atRelease[0];
    if (before === undefined) throw new Error('the fixture never reached the writer');
    // The whole claim, on the bytes: not one further write was made.
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);
    const after = onDisk(fixture.root);
    expect(after['stopReason']).toBeNull();
    // And what stands is true: the run was holding A-001 when its authority
    // became uncertain, and it says so rather than inventing an outcome for it.
    expect(after['activeTaskId']).toBe('A-001');
    expect((after['tasks'] as readonly Record<string, unknown>[])[0]?.['disposition']).toBe(
      'ACTIVE',
    );
  }, 600_000);
});

describe('the invocation acts on the plan as it was when it opened', () => {
  // The counter-proof for the snapshot rule, and the case that discriminates:
  // it fails with RUN_GATE_REFUSED against any implementation in which a start
  // path plans again — which is what `startTask` did before Task 6B, one layer
  // below a runner that imports no planner and looks correct.
  it('does not let a mid-run roadmap edit change what runs next', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const snapshot = planningOf(fixture);
    const seams = drivingSeams();
    let edited = false;
    const agent = recordedAgent({
      claude: () => {
        if (!edited) {
          edited = true;
          // B-001 gains a dependency on a task that is not DONE. Anything that
          // re-read the roadmap would now find it ineligible: a runner doing so
          // would end NO_ELIGIBLE_TASK, and a *start path* doing so would answer
          // TASK_INELIGIBLE and end the run RUN_GATE_REFUSED.
          writeRepoFile(fixture.root, 'tasks/GATE-001.md', taskFile('GATE-001'));
          writeRepoFile(
            fixture.root,
            'tasks/B-001.md',
            taskFile('B-001', { dependsOn: ['GATE-001'] }),
          );
          // Committed, and that is not decoration. `prepareTaskWorkspace`
          // refuses a dirty source checkout with `SOURCE_WORKTREE_DIRTY` and
          // counts untracked files, and B-001's workspace is prepared *after*
          // this edit — so left uncommitted, this case would end
          // RUN_GATE_REFUSED, which is exactly the answer a re-planning start
          // path produces. It would look like the defect had been caught while
          // actually reporting a broken fixture. Committing changes nothing
          // either planning sees, because discovery lists the working tree with
          // `readdirSync` rather than asking Git; and an operator's mid-run
          // roadmap edit is a commit anyway.
          git(fixture.root, ['add', '--all']);
          git(fixture.root, ['commit', '--quiet', '-m', 'the roadmap moves under the frozen plan']);
        }
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });

    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: snapshot,
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: seams.verify,
      },
    );

    // The premise: the edit really did change what the planner would say.
    expect(
      planningOf(fixture).selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible,
    ).toBe(false);
    // And the run acted on the snapshot regardless. Asserted as COMPLETE and
    // *not* as "not RUN_GATE_REFUSED", because the two failure modes this
    // discriminates against produce two different wrong answers and only the
    // finished block excludes both.
    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('COMPLETE');
    expect(
      (onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[]).map(
        (task) => task['disposition'],
      ),
    ).toEqual(['SETTLED', 'SETTLED']);
  }, 900_000);
});

describe('a run id is used once', () => {
  it('refuses a second invocation of the same run id rather than continuing it', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const first = await runBlock(fixture);
    expect(first.stopReason).toBe('COMPLETE');
    const after = readFileSync(ledgerPath(fixture.root));

    const second = await runBlock(fixture);

    // A block run's lifetime is its invocation's lifetime, so there is nothing
    // to continue — and the record of what the first one did is not overwritten.
    expect(second.outcome).toBe('RUN_GATE_REFUSED');
    expect(second.detail).toBe('RUN_ID_ALREADY_USED');
    expect(readFileSync(ledgerPath(fixture.root)).equals(after)).toBe(true);
  }, 900_000);
});

import { existsSync, renameSync, rmSync } from 'node:fs';

import type { AttendedBlockDependencies, AttendedBlockResult } from '../src/block/block-runner.js';
import type { ReplaceFn } from '../src/state/atomic-file.js';
import { authPreflightFails } from './helpers/auth-evidence.js';

/**
 * A three-task block whose first task is driven, and a hook that fires while
 * the second is still eligible.
 *
 * The hook is what makes these cases mean anything: a class-2 condition
 * introduced after the block would have ended anyway proves nothing, so each
 * case below breaks something *between* two tasks and then asserts that the
 * untouched ones are untouched.
 */
async function runWithHookAfterFirstTask(
  fixture: Fixture,
  hook: () => void,
  overrides: Partial<AttendedBlockDependencies> = {},
): Promise<AttendedBlockResult> {
  let driven = 0;
  const agent = recordedAgent({
    claude: () => writerSuccess(),
    codex: () => {
      driven += 1;
      if (driven === 1) hook();
      return reviewResult(passingReview());
    },
  });
  const planning = planningOf(fixture);
  // The premise every case built on this helper depends on, asserted rather than
  // argued: all three members are eligible in the reading the run is given, so a
  // run that stopped is distinguishable from a block that had nothing left to
  // do. Three §8.5-style controls in this slice turned out to be vacuous because
  // the task they left behind was never runnable in the first place.
  expect(
    planning.selection.eligibility.filter((entry) => entry.eligible).map((entry) => entry.taskId).sort(),
  ).toEqual(['A-001', 'B-001', 'C-001']);
  return runAttendedBlock(
    {
      repository: fixture.repository,
      definition: independentBlock(['A-001', 'B-001', 'C-001']),
      runId: RUN_ID,
      lease: leaseFor(fixture.repository),
      maxStepsPerTask: 8,
      planning,
    },
    {
      now: tickingClock(),
      git: runGitCommand,
      authPreflight: authPreflightPasses,
      agent: agent.runner,
      verify: recordedVerify().runner,
      ...overrides,
    },
  );
}

/**
 * A ledger replace seam that does the real rename and remembers what went past.
 *
 * Two questions need two records. `staged()` is every document the run *tried*
 * to write, which is how a best-effort stop write is caught even when it never
 * landed; `last()` is the bytes on disk after the last write that succeeded,
 * which is the only honest anchor for "the ledger did not move across this
 * condition" when the condition is reached some time after the last write.
 */
function recordingLedgerReplace(root: string) {
  const stagedDocuments: string[] = [];
  let landed: Buffer | null = null;
  return {
    replace: ((from, to) => {
      stagedDocuments.push(readFileSync(from, 'utf8'));
      renameSync(from, to);
      landed = readFileSync(ledgerPath(root));
    }) as ReplaceFn,
    staged: (): readonly string[] => stagedDocuments,
    last: (): Buffer | null => landed,
  };
}

/**
 * A ledger replace seam that lands `hook` the instant the first settlement does.
 *
 * The moment matters and no agent seam can reach it. A ledger write is a
 * compare-and-swap against the bytes on disk, so anything that disturbs the
 * ledger *during* a drive is met by the run's own next write — measured: forging
 * an entry inside the first task's review ended the run
 * `DURABLE_WRITE_FAILED / LEDGER_CONFLICT:REVISION_MISMATCH`, with the runner
 * never loading the document at all. And anything that disturbs a *task record*
 * before the run's next disposition change is caught by the store's proof gate,
 * which re-proves every entry whenever one moves.
 *
 * The one window in which a divergence survives to be *observed* is therefore
 * between the run's last durable write and the reconciliation at the top of the
 * next iteration. This seam performs the real rename and then hands that window
 * to a second writer, which is exactly the shape of the thing being modelled: a
 * record that moved after this run pinned its evidence.
 */
function afterFirstSettlement(hook: () => void): ReplaceFn {
  let fired = false;
  return (from, to) => {
    const staged = JSON.parse(readFileSync(from, 'utf8')) as {
      readonly tasks: readonly { readonly disposition: string }[];
    };
    renameSync(from, to);
    if (fired || !staged.tasks.some((entry) => entry.disposition === 'SETTLED')) return;
    fired = true;
    hook();
  };
}

/** A task record that exists and cannot be parsed. */
function corruptTaskState(root: string, taskId: string): void {
  writeFileSync(join(root, '.agent-orchestrator', 'runtime', `${taskId}.json`), '{ not json', 'utf8');
}

/**
 * A legitimate write by somebody who is not this run, landed mid-drive.
 *
 * Through the production store, at the current revision, so it succeeds exactly
 * as a second writer's would — and the driver's own next write then meets a
 * revision that is no longer the one it read. That is a real `STATE_CONFLICT`
 * rather than a state file edited into a shape.
 */
function movedByAnotherWriter(fixture: Fixture, taskId: string): void {
  const loaded = loadTaskState(fixture.root, taskId);
  if (!loaded.ok) throw new Error('fixture: the task never started');
  const saved = saveTaskState(
    { ...loaded.state, stateEnteredAt: '2026-08-14T11:30:00.000Z' },
    { repositoryRoot: fixture.root, expectedRevision: loaded.revision },
  );
  if (!saved.ok) throw new Error(`fixture could not move the task on: ${saved.code}`);
}

/**
 * The persisted reasons `runAttendedBlock` cannot reach, and why.
 *
 * A list rather than a comment, because "we decided not to cover these" and "we
 * forgot to cover these" look identical in a suite otherwise organised as one
 * case per reason. Every other member of `BLOCK_STOP_REASONS` has a case above.
 */
const UNPRODUCED_BY_THIS_RUNNER = ['DEFINITION_DRIFTED', 'OPERATOR_STOPPED'] as const;

describe('each class-2 condition ends the run under its own name', () => {
  it('LEDGER_DIVERGED — the ledger and the records disagree', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // A second writer moves A-001's record on the instant this run has pinned
    // its evidence, so the ledger's settlement claim is no longer *proven* by
    // the record it names. Nothing is hand-edited: the mutation goes through the
    // production store at the current revision, exactly as another writer's
    // would, and every entry, disposition and reason below is the product's.
    const result = await runWithHookAfterFirstTask(
      fixture,
      // Nothing during the drive. This condition cannot be reached from an
      // agent's moment at all — see `afterFirstSettlement`.
      () => {},
      { ledgerReplace: afterFirstSettlement(() => movedByAnotherWriter(fixture, 'A-001')) },
    );

    // The premise: A-001 really was driven to completion and really was settled,
    // so the run stopped *after* a task rather than instead of one.
    expect(result.tasks[0]?.runOutcome).toBe('TASK_COMPLETED');
    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('LEDGER_DIVERGED');
    expect(onDisk(fixture.root)['stopReason']).toBe('LEDGER_DIVERGED');
    // B-001 and C-001 were eligible and are untouched. Without the record check
    // the run would have gone on to B-001, whose activation the store's own
    // proof gate then refuses — ending `ACTIVE_TASK_UNRESOLVED`, which is a
    // different reason and a different ledger. Measured by mutant; see the task
    // report.
    expect(
      (onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[]).map(
        (task) => task['disposition'],
      ),
    ).toEqual(['SETTLED', 'PLANNED', 'PLANNED']);
  }, 900_000);

  it('STATE_UNUSABLE — a task record exists and cannot be used', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // B-001's record, not A-001's, and that is the whole mechanism rather than a
    // detail. Corrupting the record of the task being *driven* does not produce
    // this condition: the driver has already read that state, so its own next
    // write meets changed bytes and the run ends `ACTIVE_TASK_UNRESOLVED` under
    // run outcome `STATE_CONFLICT` — measured, and the reason the case below
    // exists separately. A record that exists and cannot be used is refused when
    // it is *read*, which for a member still `PLANNED` is at its start.
    const result = await runWithHookAfterFirstTask(fixture, () => {
      corruptTaskState(fixture.root, 'B-001');
    });

    // Its own reason, not LEDGER_DIVERGED: "a record cannot be read" and "the
    // ledger and the records disagree" send an operator to different places.
    // And not `RUN_GATE_REFUSED` either, which is what every *other* refusal
    // from the same start path grades to.
    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('STATE_UNUSABLE');
    expect(onDisk(fixture.root)['stopReason']).toBe('STATE_UNUSABLE');
    // A-001 finished; B-001 and C-001 were eligible and are untouched.
    const dispositions = (onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[]).map(
      (task) => task['disposition'],
    );
    expect(dispositions).toEqual(['SETTLED', 'PLANNED', 'PLANNED']);
    expect(dispositions.slice(1)).toEqual(['PLANNED', 'PLANNED']);
  }, 900_000);

  it('names the two reasons this runner cannot produce, rather than pretending', () => {
    // `DEFINITION_DRIFTED` compares a frozen plan with a current one, and a block
    // run does not outlive its invocation — so there is never a persisted
    // predecessor to compare against, and the reason has no producer here.
    // `OPERATOR_STOPPED` has none either: this runner installs no signal
    // handling.
    //
    // Asserted rather than left implicit, and asserted on the *runner* rather
    // than on the vocabulary: both reasons are V2-07's, both stay graded in the
    // exit table, and `reconcileBlockRun` still reports drift to a caller that
    // supplies a definition. What must not happen is a later reader taking the
    // "one case per reason" rule above to mean these two were covered.
    expect(BLOCK_STOP_REASONS).toContain('DEFINITION_DRIFTED');
    expect(BLOCK_STOP_REASONS).toContain('OPERATOR_STOPPED');
    expect(UNPRODUCED_BY_THIS_RUNNER).toEqual(['DEFINITION_DRIFTED', 'OPERATOR_STOPPED']);
  });

  it('ACTIVE_TASK_UNRESOLVED — the active task’s outcome cannot be established', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // A second writer moves the task on while it is being driven, so the
    // driver's own next write meets a revision that is no longer the one it
    // read. `STATE_CONFLICT` is graded UNRESOLVED: the driver's write did not
    // land, the task's outcome is not established, and re-reading and deciding
    // again is exactly how a stale-writer refusal gets laundered.
    const agent = recordedAgent({
      claude: () => {
        movedByAnotherWriter(fixture, 'A-001');
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });

    const planning = planningOf(fixture);
    // The same premise the shared helper asserts, restated here because this
    // case does not use it: B-001 and C-001 are eligible, so "the run stopped"
    // is distinguishable from "the block had nothing left to run".
    expect(
      planning.selection.eligibility.filter((entry) => entry.eligible).map((entry) => entry.taskId).sort(),
    ).toEqual(['A-001', 'B-001', 'C-001']);

    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001', 'C-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning,
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: recordedVerify().runner,
      },
    );

    // The driver's own answer, so the case is pinned to the run outcome it
    // names rather than to whatever else might grade `UNRESOLVED`.
    expect(result.tasks[0]?.runOutcome).toBe('STATE_CONFLICT');
    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('ACTIVE_TASK_UNRESOLVED');
    const after = onDisk(fixture.root);
    expect(after['stopReason']).toBe('ACTIVE_TASK_UNRESOLVED');
    // The coexistence contract, at the runner level this time.
    expect(after['activeTaskId']).toBe('A-001');
    const entries = after['tasks'] as readonly Record<string, unknown>[];
    expect(entries[0]?.['disposition']).toBe('ACTIVE');
    expect(entries[0]?.['evidenceRevision']).toBeNull();
    // B-001 and C-001 were eligible and are untouched.
    expect(entries.slice(1).map((task) => task['disposition'])).toEqual(['PLANNED', 'PLANNED']);
  }, 900_000);

  it('RUN_GATE_REFUSED — auth is not there, and no ledger is created', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    const result = await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      authPreflight: authPreflightFails,
    });

    expect(result.outcome).toBe('RUN_GATE_REFUSED');
    expect(result.stopReason).toBeNull();
    expect(result.detail).toBe('AUTH_PREFLIGHT_FAILED');
    // This gate is answered before the first ledger is created, so there is not
    // even a file to be byte-identical with. That is a property of *this* gate
    // and not of the outcome — see the case below, which is the same outcome
    // over a ledger that exists and carries a settled task.
    expect(existsSync(ledgerPath(fixture.root))).toBe(false);
  }, 600_000);

  // The case the outcome's own wording used to hide. `RUN_GATE_REFUSED` said
  // "nothing was written", and the only case pinning it met the gate ahead of
  // `openRun` — so the claim was true of the convenient half and untested on the
  // other. A start gate met *between two tasks* ends the run under the same
  // outcome with a ledger that exists, carries A-001's settlement, and must not
  // gain a stop claim about the refusal.
  it('RUN_GATE_REFUSED — a start gate refuses after the ledger exists', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // The anchor has to be the last write the run made, not a value read at hook
    // time: the hook fires while A-001 is still being driven, and A-001's
    // settlement lands after it. `landed` therefore holds the ledger exactly as
    // it stood when the gate was reached, because a gate refusal writes nothing.
    const landed = recordingLedgerReplace(fixture.root);

    const result = await runWithHookAfterFirstTask(
      fixture,
      () => {
        // The repository stops ignoring its own runtime directory, so the next
        // start refuses RUNTIME_NOT_IGNORED. A real misconfiguration an operator
        // fixes outside the run — not a stubbed refusal, and not a condition
        // that would have ended the block anyway: B-001 and C-001 are eligible.
        writeFileSync(join(fixture.root, '.gitignore'), '# nothing ignored\n', 'utf8');
      },
      { ledgerReplace: landed.replace },
    );

    expect(result.outcome).toBe('RUN_GATE_REFUSED');
    expect(result.detail).toBe('RUNTIME_NOT_IGNORED');
    expect(result.stopReason).toBeNull();

    // Byte for byte across the gate. Not "the file is empty" and not "no stop
    // reason was written": the ledger holds A-001's settlement, that record is
    // true, and it stays. What must not appear is an ending.
    const before = landed.last();
    if (before === null) throw new Error('the run never wrote a ledger, so nothing was measured');
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);

    // And the anchor's own content, which is what carries the claim rather than
    // the comparison above. Measured: a runner that writes a best-effort stop
    // and *then* reports `RUN_GATE_REFUSED` passes the byte comparison, because
    // the anchor is the last write that landed and therefore moves with the
    // extra one. Byte identity says "nothing was written after the ledger
    // stopped moving"; these two say "the ledger never gained an ending".
    const document = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
    expect(document['stopReason']).toBeNull();
    const entries = document['tasks'] as readonly Record<string, unknown>[];
    expect(entries.map((task) => task['disposition'])).toEqual(['SETTLED', 'PLANNED', 'PLANNED']);
    // Every document the run staged, not only the last: a best-effort stop write
    // that was attempted and lost would be invisible in the file.
    for (const staged of landed.staged()) {
      expect((JSON.parse(staged) as Record<string, unknown>)['stopReason']).toBeNull();
    }
    // And the report carries the ending the ledger deliberately does not.
    expect(result.tasks[0]?.disposition).toBe('SETTLED');
  }, 900_000);
});

// Design §8.3a. Asserting "no stop reason was written" is weaker: it passes
// against a run that mutated the ledger some other way.
//
// "Byte-identical" is always *across the condition* — the ledger before it and
// the ledger after it. Never "byte-identical with an empty file": a run that
// settled a task before meeting one of these outcomes wrote that settlement, and
// it is true.
describe('an unrecorded outcome leaves the ledger byte-identical across it', () => {
  it('LEASE_AUTHORITY_UNCERTAIN', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    const atGate: Buffer[] = [];

    const result = await runWithHookAfterFirstTask(fixture, () => {
      atGate.push(readFileSync(ledgerPath(fixture.root)));
      // The lease removed underneath the run, which is what an operator
      // breaking a lease they believed stale actually does.
      const location = deriveExecutionLeaseLocation(fixture.repository);
      if (!location.ok) throw new Error('fixture: no lease location');
      rmSync(location.path, { force: true });
    });

    expect(result.outcome).toBe('LEASE_AUTHORITY_UNCERTAIN');
    expect(result.stopReason).toBeNull();
    const before = atGate[0];
    if (before === undefined) throw new Error('the hook never ran, so nothing was measured');
    // Byte for byte. The run may no longer be the writer, so any mutation at
    // all is precisely the act it has lost the authority for.
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);
  }, 900_000);
});

/** A replace seam that fails every time, so no ledger write can land. */
function alwaysFailingReplace(): ReplaceFn {
  return () => {
    const error = new Error('replace refused by the test seam') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  };
}

/** A replace seam that works `n` times and then fails. */
function replaceFailingAfter(n: number): ReplaceFn {
  let seen = 0;
  return (from, to) => {
    seen += 1;
    if (seen > n) {
      const error = new Error('replace refused by the test seam') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    renameSync(from, to);
  };
}

describe('a durable write that is not possible is reported, never claimed', () => {
  it('reports the failure of the very first write, with no ledger on disk', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    const result = await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      ledgerReplace: alwaysFailingReplace(),
    });

    expect(result.outcome).toBe('DURABLE_WRITE_FAILED');
    expect(result.stopReason).toBeNull();
    // The condition is that the run cannot write. There is no ledger, and the
    // runner did not manufacture one to record that it could not write.
    expect(existsSync(ledgerPath(fixture.root))).toBe(false);
    // The detail names the failure rather than describing it.
    expect(result.detail).toContain('WRITE_FAILED');
  }, 600_000);

  it('leaves the ledger byte-identical when a later write fails', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    // One successful write — the creation — and every later one refused.
    const result = await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      ledgerReplace: replaceFailingAfter(1),
    });
    const after = readFileSync(ledgerPath(fixture.root));

    expect(result.outcome).toBe('DURABLE_WRITE_FAILED');
    expect(result.stopReason).toBeNull();
    // The activation failed, so the ledger is still the creation. Byte for
    // byte, and with no stop reason: the run cannot presuppose a successful
    // stop write, because the failed write is the condition being reported.
    const document = JSON.parse(after.toString('utf8')) as Record<string, unknown>;
    expect(document['stopReason']).toBeNull();
    expect(document['activeTaskId']).toBeNull();
    expect((document['tasks'] as readonly Record<string, unknown>[]).map((t) => t['disposition']))
      .toEqual(['PLANNED', 'PLANNED']);
  }, 600_000);

  it('does not try to record a stop reason about a write it could not make', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const attempted: string[] = [];

    await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      ledgerReplace: (from, to) => {
        attempted.push(readFileSync(from, 'utf8'));
        const error = new Error('refused') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
    });

    // Every document the run staged is inspected. A best-effort stop write
    // would appear here as a staged document carrying a stopReason — the run's
    // least trustworthy claim, made at its least trustworthy moment.
    for (const staged of attempted) {
      const document = JSON.parse(staged) as Record<string, unknown>;
      expect(document['stopReason']).toBeNull();
    }
    expect(attempted.length).toBeGreaterThan(0);
  }, 600_000);
});
