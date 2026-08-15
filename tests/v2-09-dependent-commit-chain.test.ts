/**
 * V2-09 — dependent execution and the controlled commit chain.
 *
 * Every control of this slice lives here. The cheap ones drive pure functions
 * and injected Git seams; the expensive ones are named in the plan's budget
 * table and each carries the defect it proves that a cheaper test cannot.
 */

import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BLOCK_LEDGER_SCHEMA_VERSION,
  BLOCK_STOP_REASONS,
  parseBlockRunLedger,
  type BlockRunLedger,
  entryFor,
  type BlockStopReason,
  type BlockTaskEntry,
  type TaskDisposition,
} from '../src/block/block-ledger.js';
import { memberRunnability } from '../src/block/block-conclusion.js';
import { projectBlockDependencies } from '../src/block/block-dependencies.js';
import { runAttendedBlock } from '../src/block/block-runner.js';
import { loadBlockLedger } from '../src/block/block-store.js';
import { defineBlock, fingerprintFrozenMembership } from '../src/block/block-definition.js';
import { planNextTask, type TaskPlanningSuccess } from '../src/plan/plan-next-task.js';
import type { TaskEligibility } from '../src/plan/select-task.js';
import { registerBlockCommand, type BlockCommandSeams } from '../src/cli/block-command.js';
import {
  BLOCK_BASE_UNRESOLVED_SENTENCE,
  BLOCK_STOP_SENTENCES,
  CHAIN_SHAPE_SENTENCE,
  renderBlockRun,
} from '../src/cli/render-block-run.js';
import { REPO_PROFILE_RELATIVE_PATH } from '../src/repo/profile-location.js';
import { loadTaskState } from '../src/state/state-store.js';
import { runTask } from '../src/run/run-driver.js';
import { startPlannedTask, startTask } from '../src/run/start-task.js';
import { assessTaskScope } from '../src/scope/assess-scope.js';
import { proveChainBase } from '../src/block/chain-fitness.js';
import { chainShapeOf, uniqueMaximumOf } from '../src/block/chain-shape.js';
import {
  classifyAncestry,
  commitIsReferenced,
  commitObjectPresent,
} from '../src/worktree/commit-probes.js';
import { runGitCommand, type GitRunner } from '../src/worktree/git-command.js';
import { prepareTaskWorkspace, proveSourcePreflight } from '../src/worktree/prepare-workspace.js';
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
import { deriveTaskWorkspaceIdentity } from '../src/worktree/workspace-identity.js';
import { passingReview } from './fixtures.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
} from '../src/lease/execution-lease.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import type { AgentCommandResult } from '../src/agent/agent-command.js';
import {
  e2eProfile,
  recordedAgent,
  recordedVerify,
  reload,
  reviewResult,
  taskFile,
  tickingClock,
  writerSuccess,
  writerThatCommits,
} from './helpers/e2e-fixtures.js';

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

/** A real Git repository, with no profile resolved for it. */
const gitFixtureRoot = () =>
  createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

/** Commits one file at `root` and returns the new HEAD. */
function commitAt(root: string, relativePath: string): string {
  writeRepoFile(root, relativePath, 'later\n');
  fixtureGit(root, ['add', '--all']);
  fixtureGit(root, ['commit', '--quiet', '-m', `add ${relativePath}`]);
  return headOf(root);
}

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
    // A bare fixture root, not a resolved repository: these probes take a `cwd`
    // and a commit, so resolving a profile would be cost with nothing behind it.
    const root = gitFixtureRoot();
    const first = headOf(root);
    const second = commitAt(root, 'second.txt');
    const blob = fixtureGit(root, ['rev-parse', 'HEAD:second.txt']).trim();
    const missing = 'f'.repeat(40);

    expect(await commitObjectPresent(runGitCommand, root, second)).toBe(true);
    expect(await commitObjectPresent(runGitCommand, root, missing)).toBe(false);
    expect(await commitObjectPresent(runGitCommand, root, blob)).toBe(false);

    expect(await commitIsReferenced(runGitCommand, root, second)).toBe(true);

    expect(await classifyAncestry(runGitCommand, root, first, second)).toBe('ANCESTOR');
    expect(await classifyAncestry(runGitCommand, root, second, first)).toBe('NOT_ANCESTOR');
    expect(await classifyAncestry(runGitCommand, root, missing, second)).toBe('INDETERMINATE');
  });

  it('calls a commit no ref contains unreferenced, which is the discarded-work case', async () => {
    const root = gitFixtureRoot();
    fixtureGit(root, ['checkout', '--quiet', '-b', 'scratch']);
    const orphaned = commitAt(root, 'scratch.txt');
    fixtureGit(root, ['checkout', '--quiet', 'main']);
    fixtureGit(root, ['branch', '-D', 'scratch']);

    // The object survives until it is pruned; no ref reaches it any more.
    expect(await commitObjectPresent(runGitCommand, root, orphaned)).toBe(true);
    expect(await commitIsReferenced(runGitCommand, root, orphaned)).toBe(false);
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
  // Asked at `proveSourcePreflight`, which is where the switch on `base` lives,
  // rather than by creating a second workspace. That the worktree is then made
  // *at* the pinned commit is the positive case above, and every V1-03 control
  // asserts it for the default-branch path already — so a second `worktree add`
  // here would buy nothing and cost the budget a row.
  it('still resolves the declared default branch when told to', async () => {
    const repository = await realRepository();
    const tip = headOf(repository.root);
    const derived = deriveTaskWorkspaceIdentity(repository, 'task-a');
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    const preflight = await proveSourcePreflight(runGitCommand, derived.identity, {
      kind: 'DEFAULT_BRANCH_TIP',
    });

    expect(preflight).toEqual({ ok: true, basePinnedCommit: tip });
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
  profile: string = e2eProfile(),
): Promise<ResolvedRepository> {
  const files: Record<string, string> = { '.gitignore': '.agent-orchestrator/runtime/\n' };
  for (const [taskId, dependsOn] of Object.entries(tasks)) {
    files[`tasks/${taskId}.md`] = taskFile(taskId, { dependsOn });
  }
  const root = createRepoFixture({ defaultBranch: 'main', profile, files });
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
    // Written from the argument, and `null` lands as `null`. Asserted here
    // rather than in a second repository of its own: the standalone entry point
    // passes `null` as a literal, so what needs proving is that the value
    // reaches the record - and this start is already paid for.
    expect(reload(repository.root, 'B-001').state.scopeAuthorityCommit).toBeNull();

    // And the standalone entry point, whose own argument is that literal. The
    // same repository, the same lease, one more workspace rather than one more
    // fixture.
    const standalone = await startTask({ repository, taskId: 'A-001' }, startDeps(repository));
    expect(standalone.outcome).toBe('STARTED');
    expect(reload(repository.root, 'A-001').state.scopeAuthorityCommit).toBeNull();
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

/* ═════════════════════ the runner drives a chain ═════════════════════════ */

const RUN_ID = 'run-1';
const BLOCK_ID = 'block-1';

/** A frozen block over `taskIds`, with the relation the roadmap really holds. */
function frozenBlock(repository: ResolvedRepository, taskIds: readonly string[]) {
  const planned = planningOf(repository);
  const projected = projectBlockDependencies(planned.graph, taskIds);
  if (!projected.ok) throw new Error(`fixture relation is not projectable: ${projected.code}`);
  const defined = defineBlock(BLOCK_ID, taskIds, projected.dependencies);
  if (!defined.ok) throw new Error(`fixture block is not a block: ${defined.code}`);
  return defined.definition;
}

type ClaudeHandler = (call: {
  readonly cwd: string;
  readonly payload: string;
  readonly index: number;
}) => AgentCommandResult;

async function runChainedBlock(
  repository: ResolvedRepository,
  options: {
    readonly taskIds?: readonly string[];
    readonly blockBaseCommit?: string;
    readonly claude?: ClaudeHandler;
    readonly git?: GitRunner;
  } = {},
) {
  const taskIds = options.taskIds ?? ['A-001', 'B-001'];
  const claude: ClaudeHandler =
    options.claude ?? ((call) => writerThatCommits('src/work.ts', `// ${call.index}\n`)(call));
  const agent = recordedAgent({ claude, codex: () => reviewResult(passingReview()) });
  return runAttendedBlock(
    {
      repository,
      definition: frozenBlock(repository, taskIds),
      runId: RUN_ID,
      lease: leaseFor(repository),
      maxStepsPerTask: 8,
      planning: planningOf(repository),
      blockBaseCommit: options.blockBaseCommit ?? headOf(repository.root),
    },
    {
      now: tickingClock(),
      git: options.git ?? runGitCommand,
      authPreflight: authPreflightPasses,
      agent: agent.runner,
      verify: recordedVerify().runner,
    },
  );
}

function ledgerOf(root: string): BlockRunLedger {
  const loaded = loadBlockLedger(root, RUN_ID);
  if (!loaded.ok) throw new Error(`the ledger did not load: ${loaded.code}`);
  return loaded.ledger;
}

describe('the runner bases a dependent member on its predecessor', () => {
  // Git-tier control G-1. The effect is a worktree whose history really contains
  // the predecessor's commit, and no cheaper control can observe which commit
  // `git worktree add` used.
  it('bases a dependent member on the predecessor result commit', async () => {
    const repository = await chainRepository({ 'A-001': [], 'B-001': ['A-001'] });

    const result = await runChainedBlock(repository);

    expect(result).toMatchObject({ outcome: 'BLOCK_RUN_ENDED', stopReason: 'COMPLETE' });
    const ledger = ledgerOf(repository.root);
    const a = entryFor(ledger, 'A-001');
    const b = entryFor(ledger, 'B-001');
    expect(a?.resultCommit).toEqual(expect.any(String));
    // The ledger says so...
    expect(b?.baseCommit).toBe(a?.resultCommit);
    // ...and the durable task record says so...
    const state = reload(repository.root, 'B-001').state;
    expect(state.basePinnedCommit).toBe(a?.resultCommit);
    // ...and so does Git, which is the only one of the three that is an effect.
    expect(await classifyAncestry(runGitCommand, state.worktreePath, a?.resultCommit ?? '', 'HEAD'))
      .toBe('ANCESTOR');
  }, 600_000);

  // Git-tier control G-3. Reachability is a Git fact and not a record fact: the
  // ledger still names the commit, the object still exists, and no ref reaches
  // it. The release happens on the Git seam rather than in an agent handler
  // because the window it has to land in - after A has settled, before B's base
  // is proved - is not one any agent or verify call sits inside. What the seam
  // does is real: it removes A's worktree and deletes A's branch, exactly as
  // `agent-loop release` would, and every answer below still comes from Git.
  it('refuses to chain onto a result no ref contains any more', async () => {
    const repository = await chainRepository({ 'A-001': [], 'B-001': ['A-001'] });

    let released = false;
    const releasingGit: GitRunner = async (cwd, args) => {
      // `for-each-ref --contains` is issued by the chain proof and by nothing
      // else, so this fires once, in the one instant that matters.
      if (!released && args[0] === 'for-each-ref') {
        released = true;
        const worktree = reload(repository.root, 'A-001').state.worktreePath;
        fixtureGit(repository.root, ['worktree', 'remove', '--force', worktree]);
        fixtureGit(repository.root, ['branch', '-D', 'ao/task/A-001']);
      }
      return runGitCommand(cwd, args);
    };

    const result = await runChainedBlock(repository, { git: releasingGit });

    expect(result).toMatchObject({ outcome: 'RUN_GATE_REFUSED', detail: 'BASE_NOT_REFERENCED' });
    expect(entryFor(ledgerOf(repository.root), 'B-001')?.disposition).toBe('PLANNED');
  }, 600_000);

  // Git-tier control G-4. The ancestry of two real commit histories. A-001 was
  // started before this block, off a commit on another line; the block is frozen
  // somewhere else; A settles legitimately, and its result is real, referenced
  // and useless as a base for B because the chain would leave the line the run is
  // authorised for. No record-level check can see this - both commits exist and
  // both entries are honest.
  it('refuses a predecessor result that does not descend from the block base', async () => {
    const repository = await chainRepository({ 'A-001': [], 'B-001': ['A-001'] });

    // A line the block will not be frozen on...
    fixtureGit(repository.root, ['checkout', '--quiet', '-b', 'elsewhere']);
    const elsewhere = commitOnDefaultBranch(repository, 'elsewhere.txt');
    fixtureGit(repository.root, ['checkout', '--quiet', 'main']);
    // ...and the block base, which moved on independently of it.
    const blockBaseCommit = commitOnDefaultBranch(repository, 'blockbase.txt');

    // A-001 is started against the other line, before the block opens.
    const started = await startPlannedTask(
      {
        repository,
        taskId: 'A-001',
        planning: planningOf(repository),
        base: { kind: 'PINNED_COMMIT', commit: elsewhere },
        satisfiedDependencies: [],
        scopeAuthorityCommit: null,
      },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: leaseFor(repository),
      },
    );
    expect(started.outcome).toBe('STARTED');

    const result = await runChainedBlock(repository, { blockBaseCommit });

    expect(result).toMatchObject({
      outcome: 'RUN_GATE_REFUSED',
      detail: 'BASE_NOT_DESCENDED_FROM_BLOCK_BASE',
    });
    expect(entryFor(ledgerOf(repository.root), 'A-001')?.disposition).toBe('SETTLED');
    expect(entryFor(ledgerOf(repository.root), 'B-001')?.disposition).toBe('PLANNED');
  }, 600_000);
});

/**
 * The two rules pinned against each other, without a repository.
 *
 * G3 (a settled member satisfies a dependency) and G4 (the base it offers is
 * fit) are separate conditions, and a build that collapsed them into one would
 * pass every control above. These two say which is which: each holds while the
 * other fails, and the two answers differ.
 */
describe('run-local runnability and chain fitness are two rules, not one', () => {
  const eligibility = (unsatisfied: readonly string[]) =>
    [{
      taskId: 'task-b',
      eligible: false,
      reason: 'BLOCKED_BY_DEPENDENCIES',
      unsatisfiedDependencies: unsatisfied,
      unlockCount: 0,
    }] as readonly TaskEligibility[];

  it('holds a member runnable while its base is unfit', async () => {
    const ledger = chainLedger({ a2: { disposition: 'SETTLED', resultCommit: RESULT } });

    expect(memberRunnability('task-b', eligibility(['task-a2']), ledger.tasks))
      .toEqual({ runnable: true, satisfiedBy: ['task-a2'] });

    const git = answering({
      'cat-file -t': { outcome: 'OK', stdout: 'commit' },
      'for-each-ref --count=1': { outcome: 'OK', stdout: '' },
    });
    expect(await proveChainBase(git, 'C:/r', {
      ledger, taskId: 'task-b', maximum: 'task-a2', blockBaseCommit: BASE,
    })).toEqual({ ok: false, code: 'BASE_NOT_REFERENCED' });
  });

  it('holds a base fit while its member is not runnable', async () => {
    // The dependency the *planner* still calls unsatisfied is not a member, so
    // nothing in this run could ever satisfy it — while the frozen relation's
    // required set is settled and its base proves out perfectly.
    const ledger = chainLedger({ a2: { disposition: 'SETTLED', resultCommit: RESULT } });

    expect(memberRunnability('task-b', eligibility(['task-outside']), ledger.tasks))
      .toEqual({ runnable: false, reason: 'DEPENDENCY_OUTSIDE_BLOCK' });

    const git = answering({
      'cat-file -t': { outcome: 'OK', stdout: 'commit' },
      'for-each-ref --count=1': { outcome: 'OK', stdout: 'refs/heads/x' },
    });
    expect(await proveChainBase(git, 'C:/r', {
      ledger, taskId: 'task-b', maximum: 'task-a2', blockBaseCommit: BASE,
    })).toEqual({ ok: true, commit: RESULT });
  });
});

/**
 * Git-tier control **G-5**: the authority outlives the invocation that made it.
 *
 * This is the control the plan's review demanded, and nothing that stays inside
 * one invocation can stand in for it. The claim is that a chained task is judged
 * against the block base *after the block run is over* — so the state has to be
 * written by a real chained start, the block run has to end with that task
 * unfinished, and a caller that knows nothing about blocks has to drive it
 * afterwards.
 *
 * The counter-example is the review's own, and it is not exotic: A commits a
 * profile widening the allowed scope, B is chained onto A's result, the run ends
 * before B finishes, and the roadmap is then marked DONE for A. `status: DONE` is
 * a markdown field. It says nothing about which commits reached the default
 * branch or in what shape, and this build treats it as evidence nowhere.
 */
describe('a chained task keeps the scope it was started under, after its run is over', () => {
  it('judges a chained task against the block base even after the block run ended', async () => {
    // The block-base profile allows the profile file itself and `src/a`, so A's
    // widening is a legitimate change *within* A's own scope. That matters: the
    // question is whether a lawful profile change decides its successor's
    // permissions, not whether an unlawful one can be made at all.
    const repository = await chainRepository(
      { 'A-001': [], 'B-001': ['A-001'] },
      scopedProfile(['.agent-orchestrator', 'src/a']),
    );
    const blockBase = headOf(repository.root);

    // A widens the profile and commits it. B is then started chained onto A's
    // result — and the run ends there, with B started and unfinished, because
    // this invocation stops being the repository's writer. That is the shape the
    // claim needs: any way of ending the run would do, and a lost lease is the
    // one that leaves B's record healthy and continuable rather than blocked.
    const lease = leaseFor(repository);
    const agent = recordedAgent({
      claude: (call) => {
        if (call.index === 0) {
          return writerThatCommits(
            REPO_PROFILE_RELATIVE_PATH,
            scopedProfile(['.agent-orchestrator', 'src']),
          )(call);
        }
        releaseRepositoryExecutionLease(lease);
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });
    const result = await runAttendedBlock(
      {
        repository,
        definition: frozenBlock(repository, ['A-001', 'B-001']),
        runId: RUN_ID,
        lease,
        maxStepsPerTask: 8,
        planning: planningOf(repository),
        blockBaseCommit: blockBase,
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

    const chained = reload(repository.root, 'B-001').state;
    const a = entryFor(ledgerOf(repository.root), 'A-001');
    expect(chained.basePinnedCommit).toBe(a?.resultCommit);
    // Durable, not remembered. Without this line the guarantee below would be a
    // property of the invocation that has just ended.
    expect(chained.scopeAuthorityCommit).toBe(blockBase);

    // Now a caller that knows nothing about blocks, and a roadmap that has since
    // been marked DONE for A — which proves nothing about Git.
    writeRepoFile(repository.root, 'tasks/A-001.md', taskFile('A-001', { status: 'DONE' }));
    fixtureGit(repository.root, ['add', '--all']);
    fixtureGit(repository.root, ['commit', '--quiet', '-m', 'mark A done by hand']);

    const continuationLease = acquireRepositoryExecutionLease(
      repository,
      { runId: null, blockId: null },
      { now: () => new Date().toISOString() },
    );
    if (!continuationLease.ok) throw new Error(`no lease: ${continuationLease.code}`);

    const continued = await runTask(
      {
        repository,
        taskId: 'B-001',
        taskBrief: 'continue the chained task',
        attendedContinuation: true,
        authEvidence: null,
        // A genuinely fresh lease. Not `leaseFor`, which memoises per repository
        // and would hand back the evidence the block run gave up: this caller is
        // a separate one, and it takes the repository's turn as writer for
        // itself.
        lease: continuationLease.evidence,
        maxSteps: 4,
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        agent: recordedAgent({
          claude: (call) => writerThatCommits('src/b/x.ts', 'work\n')(call),
          codex: () => reviewResult(passingReview()),
        }).runner,
        verify: recordedVerify().runner,
      },
    );

    // `src/b/**` was never allowed by the profile at the block base, and that is
    // still the profile that governs — however long afterwards this happens, and
    // whatever the roadmap has since been edited to say.
    expect(continued.outcome).toBe('SCOPE_VIOLATION');
    expect(reload(repository.root, 'B-001').state.state).toBe('SCOPE_VIOLATION');
    releaseRepositoryExecutionLease(continuationLease.evidence);
  }, 600_000);
});

/* ═══════════════ operator-facing sentences, bound to state ═══════════════ */

/**
 * A sentence is judged by what it *claims*, not by whether it is non-empty.
 *
 * Measured before this slice: the V2-08 renderer controls accept a table in
 * which `TASK_BLOCKED` and `NO_ELIGIBLE_TASK` have swapped sentences. The swap
 * preserves distinctness, non-emptiness and ASCII, so none of those properties
 * could see it — and an operator would read "no frozen member was eligible to
 * run" for a run whose ledger holds a `BLOCKED` task, which is a false statement
 * about their repository presented as a diagnosis.
 *
 * These assertions are two-sided on purpose. `must` fails when a sentence stops
 * saying its own thing; `mustNot` fails when it starts saying another reason's.
 * Either half alone survives the swap in one direction.
 */
describe('an operator-facing sentence is bound to the state that produced it', () => {
  const claims: Record<BlockStopReason, { must: RegExp; mustNot: RegExp }> = {
    COMPLETE: { must: /block is done/i, mustNot: /no frozen member|human must resolve/i },
    TASK_BLOCKED: { must: /human must resolve/i, mustNot: /no frozen member|given up on/i },
    TASK_ABANDONED: { must: /given up on/i, mustNot: /human must resolve|no frozen member/i },
    NO_ELIGIBLE_TASK: {
      must: /no frozen member was eligible/i,
      mustNot: /human must resolve|given up on/i,
    },
    OPERATOR_STOPPED: { must: /operator stopped/i, mustNot: /task/i },
    LEDGER_DIVERGED: { must: /records disagree/i, mustNot: /cannot be used|no longer matches/i },
    STATE_UNUSABLE: { must: /cannot be used/i, mustNot: /records disagree|no longer matches/i },
    DEFINITION_DRIFTED: {
      must: /no longer matches/i,
      mustNot: /records disagree|cannot be used/i,
    },
    ACTIVE_TASK_UNRESOLVED: {
      must: /could not be safely established/i,
      mustNot: /cannot be used|records disagree/i,
    },
  };

  it.each(BLOCK_STOP_REASONS)('%s explains itself and claims nothing another reason owns', (reason) => {
    expect(BLOCK_STOP_SENTENCES[reason]).toMatch(claims[reason].must);
    expect(BLOCK_STOP_SENTENCES[reason]).not.toMatch(claims[reason].mustNot);
  });

  it('renders, for a persisted TASK_BLOCKED, a sentence that does not deny the blocked task', () => {
    const printed = renderBlockRun(
      { id: 'fixture', root: 'D:\\repo' },
      {
        outcome: 'BLOCK_RUN_ENDED',
        stopReason: 'TASK_BLOCKED',
        detail: null,
        runId: RUN_ID,
        blockId: BLOCK_ID,
        steps: 3,
        tasks: [{ taskId: 'A-001', disposition: 'BLOCKED', runOutcome: 'BLOCKED_VERIFY' }],
      },
    );

    expect(printed).toMatch(/human must resolve/i);
    expect(printed).not.toMatch(/no frozen member was eligible/i);
  });

  it('says what a shapeless block and an unresolvable base each are, in their own words', () => {
    // Two refusals that happen above the runner, so neither is a stop reason and
    // neither may borrow one's sentence.
    expect(CHAIN_SHAPE_SENTENCE).toMatch(/no single commit/i);
    expect(CHAIN_SHAPE_SENTENCE).not.toMatch(/default branch/i);
    expect(BLOCK_BASE_UNRESOLVED_SENTENCE).toMatch(/default branch did not resolve/i);
    expect(BLOCK_BASE_UNRESOLVED_SENTENCE).not.toMatch(/no single commit/i);
  });
});

/* ══════════════ the freeze site refuses a shapeless block ════════════════ */

/**
 * The `block` command, driven through Commander, with stdout captured.
 *
 * Restores the spy and the previous exit code on every path, because this file
 * has no global stdout capture and a leaked mock would silence every test that
 * runs after it in the same worker.
 */
async function runBlockCli(
  args: readonly string[],
  seams: BlockCommandSeams = {},
): Promise<{ readonly stdout: string; readonly exitCode: number | undefined }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerBlockCommand(program, seams);
    await program.parseAsync(['block', ...args], { from: 'user' });
    return { stdout: chunks.join(''), exitCode: process.exitCode as number | undefined };
  } finally {
    spy.mockRestore();
    process.exitCode = previous;
  }
}

const blocksDirectoryOf = (root: string) =>
  join(root, '.agent-orchestrator', 'runtime', 'blocks');

describe('the freeze site refuses a block no member could be built on', () => {
  /**
   * A diamond: `D-001` requires `B-001` and `C-001`, which are incomparable.
   *
   * Refused in **both** modes, and refused for the whole block rather than for
   * the offending member. Skipping `D-001` and running the other three would be
   * this build improvising which half of an operator's request to honour.
   */
  const diamond = {
    'A-001': [],
    'B-001': ['A-001'],
    'C-001': ['A-001'],
    'D-001': ['B-001', 'C-001'],
  } as const;

  const members = ['A-001', 'B-001', 'C-001', 'D-001'];

  /**
   * One fixture for both refusals, and it is safe to share precisely because of
   * what is being proved: neither path writes anything, so neither can leave the
   * repository in a state the other would read. A fixture each would buy no
   * isolation and would cost the test budget a row.
   */
  let shapeless: ResolvedRepository;
  beforeAll(async () => {
    shapeless = await chainRepository(diamond);
  });

  it('refuses it in the read-only report, before any lease is taken', async () => {
    const repository = shapeless;

    const printed = await runBlockCli([
      '--repository', repository.root, '--block', BLOCK_ID, '--tasks', ...members, '--run', RUN_ID,
    ]);

    expect(printed.exitCode).toBe(2);
    expect(printed.stdout).toContain('NO_UNIQUE_MAXIMUM (D-001)');
    expect(printed.stdout).toContain('no single commit');
    expect(existsSync(blocksDirectoryOf(repository.root))).toBe(false);
  });

  it('refuses it in the attended path too, and opens no run', async () => {
    const repository = shapeless;

    const printed = await runBlockCli([
      '--repository', repository.root, '--block', BLOCK_ID, '--tasks', ...members,
      '--run', RUN_ID, '--attended',
    ]);

    expect(printed.exitCode).toBe(2);
    expect(printed.stdout).toContain('NO_UNIQUE_MAXIMUM (D-001)');
    // Refused after the lease was taken and before anything durable: no ledger.
    expect(existsSync(blocksDirectoryOf(repository.root))).toBe(false);
  });

  // Specificity (G6): a chain that *does* have a shape is reported, not refused,
  // and the report says which member each dependent one would be built on.
  it('reports the chain of a block every member of which has a base', async () => {
    const repository = await chainRepository({ 'A-001': [], 'B-001': ['A-001'] });

    const printed = await runBlockCli([
      '--repository', repository.root, '--block', BLOCK_ID,
      '--tasks', 'A-001', 'B-001', '--run', RUN_ID,
    ]);

    expect(printed.exitCode).toBe(0);
    expect(printed.stdout).toContain('Chain shape');
    expect(printed.stdout).toContain('would be built on the result of A-001');
    expect(printed.stdout).not.toContain('NO_UNIQUE_MAXIMUM');
  });
});

/* ═══════════════════ the two end-to-end controls ═════════════════════════ */

/**
 * Exactly two, per the plan's test budget, and each carries the defect it proves
 * that no cheaper control can.
 *
 * Everything below this line is proved one tier down in isolation: the lease is
 * V2-07L's, the single plan snapshot is V2-08's, the frozen relation is V2-07's,
 * the ledger's successor contract is V2-07's, workspace preparation is V1-03's
 * and the scope authority is this slice's own G-2. None of those shows that the
 * six of them *compose* for a chained member, which is what a whole-command run
 * is for and the only thing these two are for.
 */
describe('the block command drives a dependent chain end to end', () => {
  /**
   * E2E-1. The defect only this can prove: that the lease, the one plan
   * snapshot, the frozen relation, the ledger's successor contract, workspace
   * preparation and the scope authority are all satisfied *at the same time*
   * for a chained member — through the real command, including the freeze site
   * that reads the block base and the exit code an operator acts on.
   */
  it('drives a dependent block end to end and exits on its reason', async () => {
    const repository = await chainRepository({ 'A-001': [], 'B-001': ['A-001'] });

    const printed = await runBlockCli(
      [
        '--repository', repository.root, '--block', BLOCK_ID,
        '--tasks', 'A-001', 'B-001', '--run', RUN_ID, '--attended',
      ],
      {
        authPreflight: authPreflightPasses,
        agent: recordedAgent({
          claude: (call) => writerThatCommits('src/work.ts', `// ${call.index}\n`)(call),
          codex: () => reviewResult(passingReview()),
        }).runner,
        verify: recordedVerify().runner,
      },
    );

    expect(printed.exitCode).toBe(0);
    expect(printed.stdout).toContain('COMPLETE');
    const ledger = ledgerOf(repository.root);
    expect(ledger.stopReason).toBe('COMPLETE');
    // The chain, in the durable document the command wrote.
    expect(entryFor(ledger, 'B-001')?.baseCommit).toBe(entryFor(ledger, 'A-001')?.resultCommit);
    // And the block base, derivable from that same document: the one distinct
    // value among the empty-row members that carry a base.
    expect(entryFor(ledger, 'A-001')?.baseCommit).toEqual(expect.any(String));
    expect(reload(repository.root, 'B-001').state.scopeAuthorityCommit)
      .toBe(entryFor(ledger, 'A-001')?.baseCommit);
  }, 600_000);

  /**
   * E2E-2. The defect only this can prove: that Task 5's widening does not
   * over-reach through the whole stack when the predecessor does **not**
   * deliver. That is the one direction in which a mistake becomes durable and
   * false — a successor started on a base its predecessor never produced, with a
   * ledger entry claiming it.
   */
  it('never starts the successor when the predecessor blocks, and claims nothing about it', async () => {
    const repository = await chainRepository({ 'A-001': [], 'B-001': ['A-001'] });

    const printed = await runBlockCli(
      [
        '--repository', repository.root, '--block', BLOCK_ID,
        '--tasks', 'A-001', 'B-001', '--run', RUN_ID, '--attended',
      ],
      {
        authPreflight: authPreflightPasses,
        agent: recordedAgent({
          // A real scope violation, through the real scope check: the fixture
          // profile allows `src` and nothing else, so a file at the worktree
          // root is a measured offence rather than a state edited into place.
          claude: (call) => {
            writeRepoFile(call.cwd, 'outside-scope.txt', 'written where the profile does not allow');
            return writerSuccess();
          },
          codex: () => reviewResult(passingReview()),
        }).runner,
        verify: recordedVerify().runner,
      },
    );

    expect(printed.stdout).toContain('TASK_BLOCKED');
    const ledger = ledgerOf(repository.root);
    expect(entryFor(ledger, 'A-001')?.disposition).toBe('BLOCKED');
    // Nothing is claimed about B: not a disposition, not a base, not a result.
    expect(entryFor(ledger, 'B-001')).toMatchObject({
      disposition: 'PLANNED',
      baseCommit: null,
      resultCommit: null,
      evidenceRevision: null,
    });
    // And nothing was created for it either.
    // `STATE_MISSING` exactly, not merely "not valid": an unreadable record
    // would also fail a `tryReload`, and it would mean something quite different.
    expect(loadTaskState(repository.root, 'B-001').classification).toBe('STATE_MISSING');
    expect(branchExists(repository.root, 'ao/task/B-001')).toBe(false);
  }, 600_000);
});
