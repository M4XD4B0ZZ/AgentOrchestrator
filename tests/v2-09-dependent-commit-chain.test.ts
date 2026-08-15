/**
 * V2-09 — dependent execution and the controlled commit chain.
 *
 * Every control of this slice lives here. The cheap ones drive pure functions
 * and injected Git seams; the expensive ones are named in the plan's budget
 * table and each carries the defect it proves that a cheaper test cannot.
 */

import { describe, expect, it } from 'vitest';

import {
  BLOCK_LEDGER_SCHEMA_VERSION,
  parseBlockRunLedger,
  type BlockRunLedger,
  type TaskDisposition,
} from '../src/block/block-ledger.js';
import { fingerprintFrozenMembership } from '../src/block/block-definition.js';
import { proveChainBase } from '../src/block/chain-fitness.js';
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

/* ═════════════════ chain fitness, proved at the effect ═══════════════════ */

const BASE = 'a'.repeat(40);
const RESULT = 'b'.repeat(40);
const FOREIGN = 'c'.repeat(40);
const REVISION = '1'.repeat(64);

/** What a case says about one member's entry; everything else keeps its default. */
type EntryOverride = {
  readonly disposition?: TaskDisposition;
  readonly baseCommit?: string | null;
  readonly resultCommit?: string | null;
};

/**
 * The chain `task-a1 → task-a2 → task-b`, plus any extra root members.
 *
 * Built through `parseBlockRunLedger`, never hand-typed as a literal: a fixture
 * that bypassed the contract could hold a document no run could ever produce,
 * and the refusals below would then be proved against a fiction.
 */
function chainLedgerWithRoots(
  roots: Record<string, string | null>,
  overrides: Record<string, EntryOverride>,
): BlockRunLedger {
  const chain: Record<string, readonly string[]> = {
    'task-a1': [],
    'task-a2': ['task-a1'],
    'task-b': ['task-a1', 'task-a2'],
  };
  const defaultsFor = (taskId: string): Required<EntryOverride> =>
    taskId === 'task-a1'
      ? { disposition: 'SETTLED', baseCommit: BASE, resultCommit: FOREIGN }
      : taskId === 'task-a2'
        ? { disposition: 'SETTLED', baseCommit: FOREIGN, resultCommit: RESULT }
        : { disposition: 'PLANNED', baseCommit: null, resultCommit: null };

  const taskIds = [...Object.keys(chain), ...Object.keys(roots)];
  const frozenDependencies = [
    ...Object.entries(chain).map(([taskId, dependsOn]) => ({ taskId, dependsOn })),
    ...Object.keys(roots).map((taskId) => ({ taskId, dependsOn: [] as string[] })),
  ];

  const entry = (taskId: string) => {
    if (taskId in roots) {
      const baseCommit = roots[taskId] ?? null;
      // A root that has not started is PLANNED and carries no base, which the
      // contract requires and which the anchor rule must not count.
      return baseCommit === null
        ? { taskId, disposition: 'PLANNED', evidenceRevision: null, baseCommit: null, resultCommit: null }
        : { taskId, disposition: 'SETTLED', evidenceRevision: REVISION, baseCommit, resultCommit: null };
    }
    const merged = { ...defaultsFor(taskId), ...(overrides[shortNameOf(taskId)] ?? {}) };
    return {
      taskId,
      disposition: merged.disposition,
      evidenceRevision:
        merged.disposition === 'SETTLED' || merged.disposition === 'BLOCKED' ||
        merged.disposition === 'ABANDONED'
          ? REVISION
          : null,
      baseCommit: merged.disposition === 'PLANNED' ? null : merged.baseCommit,
      resultCommit: merged.disposition === 'SETTLED' ? merged.resultCommit : null,
    };
  };

  const tasks = taskIds.map(entry);
  const active = tasks.find((task) => task.disposition === 'ACTIVE') ?? null;

  return parseBlockRunLedger({
    schemaVersion: BLOCK_LEDGER_SCHEMA_VERSION,
    repositoryId: 'fixture',
    repositoryRoot: 'D:\\repo',
    blockId: 'block-1',
    runId: 'run-1',
    startedAt: '2026-08-15T10:00:00.000Z',
    frozenTaskIds: taskIds,
    frozenDependencies,
    planFingerprint: fingerprintFrozenMembership('block-1', taskIds, frozenDependencies),
    activeTaskId: active?.taskId ?? null,
    tasks,
    stopReason: null,
  });
}

/** `task-a2` is spelled `a2` in a case, because that is the part that varies. */
const shortNameOf = (taskId: string) => taskId.replace(/^task-/, '');

const chainLedger = (overrides: Record<string, EntryOverride>) => chainLedgerWithRoots({}, overrides);

describe('a predecessor result is proved fit before it becomes a base', () => {
  // git answers keyed by the first two argv words, so a case states only what it
  // changes. The defaults are the answers a healthy repository gives.
  const gitAnswering = (
    answers: Record<string, { outcome: string; stdout?: string; exitCode?: number }>,
  ) =>
    (async (_cwd: string, args: readonly string[]) => {
      const key = `${args[0]} ${args[1]}`;
      const healthy: Record<string, { outcome: string; stdout?: string }> = {
        'rev-parse --verify': { outcome: 'OK' },
        'for-each-ref --count=1': { outcome: 'OK', stdout: 'refs/heads/agent/task-a2' },
        'merge-base --is-ancestor': { outcome: 'OK' },
      };
      const answer = answers[key] ?? healthy[key] ?? { outcome: 'OK' };
      return { stdout: '', exitCode: 0, ...answer };
    }) as never;

  it('proves a settled predecessor whose result is real, referenced and descended', async () => {
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedger({ a2: { disposition: 'SETTLED', resultCommit: RESULT } }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: true, commit: RESULT });
  });

  it.each([
    ['PREDECESSOR_NOT_SETTLED', { a2: { disposition: 'ACTIVE' as const } }, {}],
    ['PREDECESSOR_RESULT_ABSENT', { a2: { disposition: 'SETTLED' as const, resultCommit: null } }, {}],
    ['BASE_OBJECT_ABSENT', {}, { 'rev-parse --verify': { outcome: 'NONZERO_EXIT', exitCode: 1 } }],
    ['BASE_OBJECT_UNREADABLE', {}, { 'rev-parse --verify': { outcome: 'NONZERO_EXIT', exitCode: 128 } }],
    ['BASE_NOT_REFERENCED', {}, { 'for-each-ref --count=1': { outcome: 'OK', stdout: '' } }],
    [
      'BASE_NOT_DESCENDED_FROM_BLOCK_BASE',
      {},
      { 'merge-base --is-ancestor': { outcome: 'NONZERO_EXIT', exitCode: 1 } },
    ],
  ])('refuses with %s', async (code, entries, answers) => {
    const result = await proveChainBase(gitAnswering(answers), 'C:/r', {
      ledger: chainLedger(entries),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: false, code });
  });

  it('refuses a maximum whose history does not contain a required predecessor', async () => {
    // A1 is settled from an older run: its result is not in A2's history.
    // Only the second ancestry probe answers "no", which is what separates this
    // refusal from BASE_NOT_DESCENDED_FROM_BLOCK_BASE.
    let call = 0;
    const git = (async (_cwd: string, args: readonly string[]) => {
      if (args[0] !== 'merge-base') return { outcome: 'OK', stdout: 'refs/heads/x', exitCode: 0 };
      call += 1;
      return call === 1
        ? { outcome: 'OK', stdout: '', exitCode: 0 }
        : { outcome: 'NONZERO_EXIT', stdout: '', exitCode: 1 };
    }) as never;
    const result = await proveChainBase(git, 'C:/r', {
      ledger: chainLedger({
        a1: { disposition: 'SETTLED', resultCommit: FOREIGN },
        a2: { disposition: 'SETTLED', resultCommit: RESULT },
      }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: false, code: 'BASE_MISSING_REQUIRED_PREDECESSOR' });
  });

  it('refuses when no member of this run is recorded at the block base', async () => {
    // Every root came from an older run, so nothing durable names this base.
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedger({ a1: { baseCommit: FOREIGN }, a2: { disposition: 'SETTLED', resultCommit: RESULT } }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: false, code: 'CHAIN_ANCHOR_MISSING' });
  });

  it('refuses when the empty-row members name two different bases', async () => {
    // R1 was started by this run at BASE; R2 was forced-settled from an older
    // run at FOREIGN. The anchor exists, and a later reader of this document
    // alone still cannot say which commit the block was frozen on.
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedgerWithRoots({ 'task-r1': BASE, 'task-r2': FOREIGN }, {
        a2: { disposition: 'SETTLED', resultCommit: RESULT },
      }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: false, code: 'CHAIN_ANCHOR_AMBIGUOUS' });
  });

  // Specificity (G6): the anchor must not refuse the ordinary chain.
  it('accepts several roots that all name the same base', async () => {
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedgerWithRoots({ 'task-r1': BASE, 'task-r2': BASE }, {
        a2: { disposition: 'SETTLED', resultCommit: RESULT },
      }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: true, commit: RESULT });
  });

  // An empty-row member that has not started yet carries no baseCommit, and a
  // PLANNED entry must not count against the cardinality.
  it('ignores an empty-row member that has not started', async () => {
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedgerWithRoots({ 'task-r1': BASE, 'task-r2': null }, {
        a2: { disposition: 'SETTLED', resultCommit: RESULT },
      }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: true, commit: RESULT });
  });
});
