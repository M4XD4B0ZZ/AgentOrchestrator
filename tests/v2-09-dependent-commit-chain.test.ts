/**
 * V2-09 — dependent execution and the controlled commit chain.
 *
 * Every control of this slice lives here. The cheap ones drive pure functions
 * and injected Git seams; the expensive ones are named in the plan's budget
 * table and each carries the defect it proves that a cheaper test cannot.
 */

import { rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  BLOCK_LEDGER_SCHEMA_VERSION,
  parseBlockRunLedger,
  type BlockRunLedger,
  type BlockTaskEntry,
  type TaskDisposition,
} from '../src/block/block-ledger.js';
import { memberRunnability } from '../src/block/block-conclusion.js';
import { fingerprintFrozenMembership } from '../src/block/block-definition.js';
import { planNextTask, type TaskPlanningSuccess } from '../src/plan/plan-next-task.js';
import type { TaskEligibility } from '../src/plan/select-task.js';
import { REPO_PROFILE_RELATIVE_PATH } from '../src/repo/profile-location.js';
import { startPlannedTask, startTask } from '../src/run/start-task.js';
import { assessTaskScope } from '../src/scope/assess-scope.js';
import { proveChainBase } from '../src/block/chain-fitness.js';
import { chainShapeOf, uniqueMaximumOf } from '../src/block/chain-shape.js';
import {
  classifyAncestry,
  commitIsReferenced,
  commitObjectPresent,
} from '../src/worktree/commit-probes.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { prepareTaskWorkspace } from '../src/worktree/prepare-workspace.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import {
  createRepoFixture,
  FIXTURE_A_PROFILE,
  git as fixtureGit,
  removeRepoFixtures,
  writeRepoFile,
} from './helpers/repo-fixtures.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  taskWithId,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { e2eProfile, reload, taskFile, tickingClock } from './helpers/e2e-fixtures.js';

afterAll(() => {
  releaseTestLeases();
  removeTrackedWorkspaces();
  removeRepoFixtures();
});

/** A resolved fixture repository whose workspaces will be cleaned up. */
async function realRepository(): Promise<ResolvedRepository> {
  const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return repository;
}

const headOf = (path: string) => fixtureGit(path, ['rev-parse', 'HEAD']).trim();

/** Moves the default branch on, so a frozen base stops being the tip. */
function commitOnDefaultBranch(repository: ResolvedRepository, relativePath: string): string {
  writeRepoFile(repository.root, relativePath, 'later\n');
  fixtureGit(repository.root, ['add', '--all']);
  fixtureGit(repository.root, ['commit', '--quiet', '-m', `add ${relativePath}`]);
  return headOf(repository.root);
}

const branchExists = (root: string, branch: string) =>
  fixtureGit(root, ['branch', '--list', branch]).trim().length > 0;

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

/** A runner whose reply depends on the first two argv words. */
const answering = (
  answers: Record<string, { outcome: string; stdout?: string; exitCode?: number | null }>,
) =>
  (async (_cwd: string, args: readonly string[]) => ({
    stdout: '',
    exitCode: 0,
    ...(answers[`${args[0]} ${args[1]}`] ?? { outcome: 'OK' }),
  })) as never;

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

  it('answers presence from the object type, and separates absent from unreadable', async () => {
    expect(await commitObjectPresent(gitReturning({ outcome: 'OK', stdout: 'commit' }), 'C:/r', 'a')).toBe(true);
    // Present, and not something a workspace can be built on.
    expect(await commitObjectPresent(gitReturning({ outcome: 'OK', stdout: 'blob' }), 'C:/r', 'a')).toBe(false);
    // `cat-file -t` exits 128 for a missing object and for a broken repository
    // alike, so the second question is what makes these two different answers.
    expect(await commitObjectPresent(
      answering({ 'cat-file -t': { outcome: 'NONZERO_EXIT', exitCode: 128 },
                  'cat-file -e': { outcome: 'NONZERO_EXIT', exitCode: 1 } }), 'C:/r', 'a')).toBe(false);
    expect(await commitObjectPresent(
      answering({ 'cat-file -t': { outcome: 'NONZERO_EXIT', exitCode: 128 },
                  'cat-file -e': { outcome: 'NONZERO_EXIT', exitCode: 128 } }), 'C:/r', 'a')).toBeNull();
    expect(await commitObjectPresent(gitReturning({ outcome: 'REFUSED_UNSAFE_ARGUMENT', exitCode: null }), 'C:/r', 'a'))
      .toBeNull();
  });

  it('calls a commit referenced when some ref contains it, and unknown when Git could not say', async () => {
    expect(await commitIsReferenced(gitReturning({ outcome: 'OK', stdout: 'refs/heads/agent/task-a' }), 'C:/r', 'a'))
      .toBe(true);
    expect(await commitIsReferenced(gitReturning({ outcome: 'OK', stdout: '' }), 'C:/r', 'a')).toBe(false);
    expect(await commitIsReferenced(gitReturning({ outcome: 'UNAVAILABLE', exitCode: null }), 'C:/r', 'a')).toBeNull();
  });
});

/**
 * The same three probes against a real repository, and the reason they exist.
 *
 * Every assertion above drives an injected runner, so all of them pass while the
 * probe asks Git nothing at all: an argument the seam refuses as shell-unsafe
 * never spawns, comes back `REFUSED_UNSAFE_ARGUMENT`, and is classified as "could
 * not evaluate" — which is a legitimate answer for the classifier and a dead
 * probe in production. That is not hypothetical. Two of these three were written
 * with `<sha>^{commit}` and `--format=%(refname)`, both of which contain
 * characters `SAFE_ARG_PATTERN` excludes, and both answered `null` for every
 * input from the day they were written.
 *
 * These cases are cheap — a fixture repository and no worktree — and they are the
 * only ones that can fail when a probe's *arguments* are wrong rather than its
 * reading of the reply.
 */
describe('the commit probes really ask Git, against a repository that exists', () => {
  it('answers presence, type, reachability and ancestry from real objects', async () => {
    const repository = await realRepository();
    const first = headOf(repository.root);
    const second = commitOnDefaultBranch(repository, 'second.txt');
    const blob = fixtureGit(repository.root, ['rev-parse', 'HEAD:second.txt']).trim();
    const missing = 'f'.repeat(40);

    expect(await commitObjectPresent(runGitCommand, repository.root, second)).toBe(true);
    expect(await commitObjectPresent(runGitCommand, repository.root, missing)).toBe(false);
    expect(await commitObjectPresent(runGitCommand, repository.root, blob)).toBe(false);

    expect(await commitIsReferenced(runGitCommand, repository.root, second)).toBe(true);

    expect(await classifyAncestry(runGitCommand, repository.root, first, second)).toBe('ANCESTOR');
    expect(await classifyAncestry(runGitCommand, repository.root, second, first)).toBe('NOT_ANCESTOR');
    expect(await classifyAncestry(runGitCommand, repository.root, missing, second)).toBe('INDETERMINATE');
  });

  it('calls a commit no ref contains unreferenced, which is the discarded-work case', async () => {
    const repository = await realRepository();
    fixtureGit(repository.root, ['checkout', '--quiet', '-b', 'scratch']);
    const orphaned = commitOnDefaultBranch(repository, 'scratch.txt');
    fixtureGit(repository.root, ['checkout', '--quiet', 'main']);
    fixtureGit(repository.root, ['branch', '-D', 'scratch']);

    // The object survives until it is pruned; no ref reaches it any more.
    expect(await commitObjectPresent(runGitCommand, repository.root, orphaned)).toBe(true);
    expect(await commitIsReferenced(runGitCommand, repository.root, orphaned)).toBe(false);
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
        'cat-file -t': { outcome: 'OK', stdout: 'commit' },
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
    ['BASE_OBJECT_ABSENT', {}, { 'cat-file -t': { outcome: 'OK', stdout: 'blob' } }],
    ['BASE_OBJECT_UNREADABLE', {}, { 'cat-file -t': { outcome: 'UNAVAILABLE' }, 'cat-file -e': { outcome: 'UNAVAILABLE' } }],
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
      if (args[0] === 'cat-file') return { outcome: 'OK', stdout: 'commit', exitCode: 0 };
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

/* ═════════════════ the workspace base is a parameter ═════════════════════ */

describe('a workspace is created at the base it was told, not at one it derived', () => {
  // Git-tier control G-6. The effect is a worktree created at a commit that is
  // no longer the branch tip, and no cheaper test can observe which commit
  // `git worktree add` actually used.
  it('pins a workspace at the base it was given, even after the default branch moves', async () => {
    const repository = await realRepository();
    const frozen = headOf(repository.root);
    const moved = commitOnDefaultBranch(repository, 'later.txt');
    expect(moved).not.toBe(frozen);

    const prepared = await prepareTaskWorkspace(repository, taskWithId('task-a'), {
      git: runGitCommand,
      lease: leaseFor(repository),
      base: { kind: 'PINNED_COMMIT', commit: frozen },
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.workspace.basePinnedCommit).toBe(frozen);
    expect(headOf(prepared.workspace.worktreePath)).toBe(frozen);
  });

  // Specificity (G6): the default-branch path is unchanged for every existing caller.
  it('still resolves the declared default branch when told to', async () => {
    const repository = await realRepository();
    const tip = headOf(repository.root);

    const prepared = await prepareTaskWorkspace(repository, taskWithId('task-a'), {
      git: runGitCommand,
      lease: leaseFor(repository),
      base: { kind: 'DEFAULT_BRANCH_TIP' },
    });

    expect(prepared.ok && prepared.workspace.basePinnedCommit).toBe(tip);
  });

  it('refuses a pinned base this repository does not have, and creates nothing', async () => {
    const repository = await realRepository();

    const prepared = await prepareTaskWorkspace(repository, taskWithId('task-a'), {
      git: runGitCommand,
      lease: leaseFor(repository),
      base: { kind: 'PINNED_COMMIT', commit: 'f'.repeat(40) },
    });

    expect(prepared).toMatchObject({ ok: false, code: 'BASE_COMMIT_ABSENT', residue: false });
    expect(branchExists(repository.root, 'agent/task-a')).toBe(false);
  });
});

/* ═══════════════════════ run-local runnability ═══════════════════════════ */

describe('a settled member satisfies a dependency inside the run, and nothing else does', () => {
  const eligibility = (over: readonly Partial<TaskEligibility>[]) =>
    over.map((entry) => ({
      taskId: 'task-b',
      eligible: false,
      reason: 'BLOCKED_BY_DEPENDENCIES',
      unsatisfiedDependencies: [],
      unlockCount: 0,
      ...entry,
    })) as readonly TaskEligibility[];

  /** Entries in ledger shape; only the two fields this rule reads are set. */
  const entries = (spec: Record<string, TaskDisposition>) =>
    Object.entries(spec).map(([taskId, disposition]) => ({
      taskId,
      disposition,
      evidenceRevision: null,
      baseCommit: null,
      resultCommit: null,
    })) as readonly BlockTaskEntry[];

  it('lets a member run when every unsatisfied dependency is a settled member', () => {
    expect(memberRunnability('task-b',
      eligibility([{ taskId: 'task-b', unsatisfiedDependencies: ['task-a'] }]),
      entries({ 'task-a': 'SETTLED', 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: true, satisfiedBy: ['task-a'] });
  });

  it.each(['PLANNED', 'ACTIVE', 'BLOCKED', 'ABANDONED'] as const)(
    'does not let it run when the dependency is %s', (disposition) => {
      expect(memberRunnability('task-b',
        eligibility([{ taskId: 'task-b', unsatisfiedDependencies: ['task-a'] }]),
        entries({ 'task-a': disposition, 'task-b': 'PLANNED' }),
      )).toEqual({ runnable: false, reason: 'DEPENDENCY_NOT_SETTLED' });
    });

  it('never satisfies a dependency the block does not hold', () => {
    expect(memberRunnability('task-b',
      eligibility([{ taskId: 'task-b', unsatisfiedDependencies: ['task-x'] }]),
      entries({ 'task-a': 'SETTLED', 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: false, reason: 'DEPENDENCY_OUTSIDE_BLOCK' });
  });

  it('does not resurrect a task the roadmap calls finished', () => {
    expect(memberRunnability('task-b',
      eligibility([{ taskId: 'task-b', reason: 'ALREADY_DONE' }]),
      entries({ 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: false, reason: 'FROZEN_INELIGIBLE' });
  });

  it('answers nothing about a member the frozen reading has no entry for', () => {
    expect(memberRunnability('task-z',
      eligibility([{ taskId: 'task-b', unsatisfiedDependencies: ['task-a'] }]),
      entries({ 'task-a': 'SETTLED', 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: false, reason: 'FROZEN_INELIGIBLE' });
  });

  // Specificity (G6): the rule must not disturb the members V2-08 already runs.
  it('passes a frozen-eligible member through untouched, with nothing claimed as satisfied', () => {
    expect(memberRunnability('task-b',
      eligibility([{ taskId: 'task-b', eligible: true, reason: null }]),
      entries({ 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: true, satisfiedBy: [] });
  });
});

/**
 * A repository whose roadmap really holds the relation under test.
 *
 * The two cases below are about the eligibility gate of `startPlannedTask`, and
 * that gate reads a planning result taken from a real roadmap — so the roadmap
 * has to be real, or the "frozen ineligibility" they overrule would be a value
 * a test wrote rather than one the planner produced.
 */
async function chainRepository(
  tasks: Readonly<Record<string, readonly string[]>>,
): Promise<ResolvedRepository> {
  const files: Record<string, string> = { '.gitignore': '.agent-orchestrator/runtime/\n' };
  for (const [taskId, dependsOn] of Object.entries(tasks)) {
    files[`tasks/${taskId}.md`] = taskFile(taskId, { dependsOn });
  }
  const root = createRepoFixture({ defaultBranch: 'main', profile: e2eProfile(), files });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return repository;
}

function planningOf(repository: ResolvedRepository): TaskPlanningSuccess {
  const planned = planNextTask(repository);
  if (!planned.ok) throw new Error(`fixture repository does not plan: ${planned.code}`);
  return planned;
}

describe('a start may be authorised for a dependency this run satisfied', () => {
  const startDeps = (repository: ResolvedRepository) => ({
    git: runGitCommand,
    now: tickingClock(),
    authPreflight: authPreflightPasses,
    lease: leaseFor(repository),
  });

  it('starts a frozen-ineligible member when the caller names the settled dependency', async () => {
    const repository = await chainRepository({ 'A-001': [], 'B-001': ['A-001'] });
    const planning = planningOf(repository);
    // The precondition, and it is the whole deadlock: B is ineligible at freeze
    // because A is OPEN, and A must be OPEN or it could not run either.
    expect(planning.selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible).toBe(false);

    const start = await startPlannedTask(
      {
        repository,
        taskId: 'B-001',
        planning,
        base: { kind: 'PINNED_COMMIT', commit: headOf(repository.root) },
        satisfiedDependencies: ['A-001'],
        // Stated rather than defaulted: these two cases are about the
        // eligibility gate and nothing else, and `null` is the answer an
        // ordinary start gives.
        scopeAuthorityCommit: null,
      },
      startDeps(repository),
    );

    expect(start.outcome).toBe('STARTED');
  });

  it('still refuses when the caller names a different dependency than the one blocking it', async () => {
    const repository = await chainRepository({ 'A-001': [], 'B-001': ['A-001'] });

    const start = await startPlannedTask(
      {
        repository,
        taskId: 'B-001',
        planning: planningOf(repository),
        base: { kind: 'DEFAULT_BRANCH_TIP' },
        satisfiedDependencies: ['C-001'],
        scopeAuthorityCommit: null,
      },
      startDeps(repository),
    );

    expect(start).toMatchObject({ outcome: 'TASK_INELIGIBLE', reasonCodes: ['BLOCKED_BY_DEPENDENCIES'] });
  });
});

/* ══════════════ the scope authority, split from the execution base ═══════ */

/** The e2e profile with a different scope, so two commits can disagree. */
function scopedProfile(allowedPaths: readonly string[]): string {
  return e2eProfile().replace(
    'scope:\n  allowedPaths:\n    - src\n',
    `scope:\n  allowedPaths:\n${allowedPaths.map((path) => `    - ${path}`).join('\n')}\n`,
  );
}

/**
 * A repository holding two profiles in two commits, and a worktree on the second.
 *
 * Git-tier controls **G-2a** and **G-2b**. The effect under test is *which
 * committed tree the scope declaration was read out of*, and only a repository
 * that really holds two different declarations in two different commits can show
 * it: with one profile every answer is the same whichever commit is consulted,
 * which is precisely the case that cannot tell a correct implementation from one
 * that ignores the authority entirely.
 */
async function repositoryWithWidenedProfile(change: string): Promise<{
  readonly blockBase: string;
  readonly widened: string;
  readonly worktreePath: string;
}> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: scopedProfile(['src/a']),
    files: { '.gitignore': '.agent-orchestrator/runtime/\n' },
  });
  const blockBase = headOf(root);

  // The predecessor's agent commits a widened profile. Nothing about this commit
  // is illegitimate — a task may well be *about* changing the profile — and the
  // whole question is whether it thereby decides its successor's permissions.
  writeRepoFile(root, REPO_PROFILE_RELATIVE_PATH, scopedProfile(['src']));
  fixtureGit(root, ['add', '--all']);
  fixtureGit(root, ['commit', '--quiet', '-m', 'widen the allowed scope']);
  const widened = headOf(root);

  const worktreePath = join(dirname(root), `${basename(root)}-chained`);
  chainedWorktrees.push(worktreePath);
  fixtureGit(root, ['worktree', 'add', '--quiet', '--detach', worktreePath, widened]);
  writeRepoFile(worktreePath, change, 'work\n');

  return { blockBase, widened, worktreePath };
}

const chainedWorktrees: string[] = [];

afterAll(() => {
  for (const path of chainedWorktrees) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked Git file on Windows must not fail an otherwise passing suite.
    }
  }
});

describe('the scope declaration comes from the authority, the delta from the base pin', () => {
  it('reads the declaration from the scope authority and the delta from the base pin', async () => {
    const { blockBase, widened, worktreePath } = await repositoryWithWidenedProfile('src/b/x.ts');

    const assessment = await assessTaskScope({
      git: runGitCommand,
      authorisedWorktreePath: worktreePath,
      basePinnedCommit: widened,
      scopeAuthorityCommit: blockBase,
    });

    expect(assessment.verdict).toBe('VIOLATION');
    expect(assessment.offences.map((offence) => offence.path)).toEqual(['src/b/x.ts']);
  });

  // The mutant this kills: an implementation that ignores the authority reads
  // the widened profile out of the base pin and calls the same change allowed.
  it('would allow the same change if the predecessor decided the scope', async () => {
    const { widened, worktreePath } = await repositoryWithWidenedProfile('src/b/x.ts');

    const assessment = await assessTaskScope({
      git: runGitCommand,
      authorisedWorktreePath: worktreePath,
      basePinnedCommit: widened,
      scopeAuthorityCommit: null,
    });

    expect(assessment).toMatchObject({ verdict: 'WITHIN_SCOPE', offences: [] });
  });

  // Specificity (G6): the frozen profile must still permit what it really
  // permits, and the delta must still be measured from the chained base.
  it('lets a chained task change what the block-base profile allows', async () => {
    const { blockBase, widened, worktreePath } = await repositoryWithWidenedProfile('src/a/y.ts');

    const assessment = await assessTaskScope({
      git: runGitCommand,
      authorisedWorktreePath: worktreePath,
      basePinnedCommit: widened,
      scopeAuthorityCommit: blockBase,
    });

    expect(assessment).toMatchObject({ verdict: 'WITHIN_SCOPE', offences: [] });
  });
});

describe('an ordinary task carries no scope authority of its own', () => {
  it('writes no scope authority for a task started outside a block', async () => {
    const repository = await chainRepository({ 'A-001': [] });

    const started = await startTask(
      { repository, taskId: 'A-001' },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: leaseFor(repository),
      },
    );

    expect(started.outcome).toBe('STARTED');
    expect(reload(repository.root, 'A-001').state.scopeAuthorityCommit).toBeNull();
  });
});
