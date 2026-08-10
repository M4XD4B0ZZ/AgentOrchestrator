/**
 * V1-04: reconciling a persisted state against current Git reality.
 *
 * A state file says what the previous run believed. Git says what is true now.
 * Between the two sits a restart, a crash, an operator who deleted a folder, a
 * `git worktree prune`, a force-push, or three weeks. Nothing may be resumed on
 * the strength of the file alone.
 *
 * Every case below drives the real reconciler through the injected
 * {@link GitRunner} seam, because the interesting states — a registry that
 * cannot be read, an ancestry probe that refuses to answer, a worktree Git still
 * lists but that no longer exists — are precisely the ones a real repository
 * cannot be asked to produce on demand.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GitCommandResult, GitRunner } from '../src/worktree/git-command.js';
import { saveTaskState } from '../src/state/state-store.js';
import { reconcileTask, RECONCILIATION_OUTCOMES } from '../src/state/reconcile-task.js';
import { observeRuntime } from '../src/state/observe-runtime.js';
import {
  DIVERGENCE_FINDING_CODES,
  isPreWorkState,
  isVirginPreWorkState,
  PRE_WORK_STATES,
  reconcileTaskState,
  UNOBSERVABLE_FINDING_CODES,
  type ReconciliationFindingCode,
  type ReconciliationReport,
} from '../src/state/reconcile.js';
import {
  classifyResume,
  CONTINUATION_AUTHORITIES,
  RESUME_CLASSIFICATIONS,
} from '../src/state/resume-decision.js';
import { SHA_A, SHA_B, validCreatedState, validUsageLimitState } from './fixtures.js';
import { parseTaskState, type TaskState, type TaskStateInput } from '../src/core/task-state.js';
import { ALL_STATES, type TaskStateName } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';

const OK = (stdout = ''): GitCommandResult =>
  Object.freeze({ outcome: 'OK' as const, stdout, exitCode: 0 });
const NONZERO = (exitCode: number): GitCommandResult =>
  Object.freeze({ outcome: 'NONZERO_EXIT' as const, stdout: '', exitCode });
const UNAVAILABLE: GitCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
  exitCode: null,
});

const STATE = parseTaskState(validUsageLimitState());
const WORKTREE = STATE.worktreePath;
const BRANCH_REF = `refs/heads/${STATE.workBranch}`;

/**
 * The identity half of the reconciliation input.
 *
 * A real `ResolvedRepository` is assignable to this: reconciliation needs the
 * repository's *identity* and nothing else, so it asks for exactly that rather
 * than for twelve fields it will never read.
 */
const REPOSITORY = Object.freeze({
  id: STATE.repositoryId,
  root: STATE.repositoryRoot,
  defaultBranch: STATE.baseBranch,
});

const EXPECTATION = Object.freeze({ repository: REPOSITORY, taskId: STATE.taskId });

/** The porcelain listing a healthy, matching repository produces. */
const HEALTHY_REGISTRY = `worktree ${STATE.repositoryRoot}\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nbranch ${BRANCH_REF}\n`;

function startsWith(args: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((value, index) => args[index] === value);
}

interface GitScript {
  readonly registry?: GitCommandResult;
  readonly head?: GitCommandResult;
  readonly status?: GitCommandResult;
  readonly ancestry?: GitCommandResult;
  readonly baseObject?: GitCommandResult;
}

interface GitInvocation {
  readonly cwd: string;
  readonly args: readonly string[];
}

/** A Git that answers each probe from a script. Records what it was asked. */
function scriptedGit(
  script: GitScript = {},
): GitRunner & { readonly calls: string[][]; readonly invocations: GitInvocation[] } {
  const calls: string[][] = [];
  const invocations: GitInvocation[] = [];
  const runner = async (cwd: string, args: readonly string[]): Promise<GitCommandResult> => {
    calls.push([...args]);
    invocations.push({ cwd, args: [...args] });
    if (startsWith(args, ['worktree', 'list'])) return script.registry ?? OK(HEALTHY_REGISTRY);
    if (startsWith(args, ['status'])) return script.status ?? OK('');
    if (startsWith(args, ['merge-base', '--is-ancestor'])) return script.ancestry ?? OK();
    if (startsWith(args, ['rev-parse']) && args.includes('HEAD')) {
      return script.head ?? OK(STATE.currentCommit ?? SHA_B);
    }
    if (startsWith(args, ['rev-parse'])) return script.baseObject ?? OK(SHA_A);
    throw new Error(`unscripted git call: ${args.join(' ')}`);
  };
  return Object.assign(runner, { calls, invocations });
}

const alwaysExists = (): boolean => true;
const neverExists = (): boolean => false;

async function reconcileWith(script: GitScript = {}, exists = alwaysExists) {
  const observed = await observeRuntime(scriptedGit(script), STATE, { exists });
  return reconcileTaskState(STATE, observed, EXPECTATION);
}

describe('observing Git reality', () => {
  it('reads the registry from the repository root and HEAD from the worktree', async () => {
    const git = scriptedGit();

    await observeRuntime(git, STATE, { exists: alwaysExists });

    expect(git.calls.some((args) => startsWith(args, ['worktree', 'list', '--porcelain']))).toBe(
      true,
    );
    expect(git.calls.some((args) => startsWith(args, ['status', '--porcelain']))).toBe(true);
  });

  it('reports the branch Git has checked out in the recorded worktree', async () => {
    const observed = await observeRuntime(scriptedGit(), STATE, { exists: alwaysExists });

    expect(observed.worktreeRegistered).toBe(true);
    expect(observed.observedWorkBranchRef).toBe(BRANCH_REF);
    expect(observed.observedCurrentCommit).toBe(STATE.currentCommit);
  });

  it('does not invent facts when the registry cannot be read', async () => {
    const observed = await observeRuntime(scriptedGit({ registry: UNAVAILABLE }), STATE, {
      exists: alwaysExists,
    });

    expect(observed.registryReadable).toBe(false);
    expect(observed.worktreeRegistered).toBe(false);
    expect(observed.observedWorkBranchRef).toBeNull();
  });

  it('answers the ancestry question with a single Git call when Git answers it', async () => {
    const git = scriptedGit();

    await observeRuntime(git, STATE, { exists: alwaysExists });

    const baseProbes = git.calls.filter(
      (args) => startsWith(args, ['rev-parse']) && !args.includes('HEAD'),
    );
    expect(baseProbes).toHaveLength(0);
  });

  it('separates "not an ancestor" from "could not be evaluated"', async () => {
    const answered = await observeRuntime(scriptedGit({ ancestry: NONZERO(1) }), STATE, {
      exists: alwaysExists,
    });
    const refused = await observeRuntime(
      scriptedGit({ ancestry: NONZERO(128), baseObject: NONZERO(1) }),
      STATE,
      { exists: alwaysExists },
    );

    expect(answered.basePinnedCommitIsAncestor).toBe(false);
    expect(refused.basePinnedCommitIsAncestor).toBeNull();
    expect(refused.basePinnedCommitPresent).toBe(false);
  });
});

/**
 * Git's exit status is an answer only where Git documents one.
 *
 * `rev-parse --verify --quiet <object>` exits **1** when the object does not
 * resolve — a real answer — and **128** when Git could not evaluate the
 * question at all: a broken repository, a bad invocation, a `.git` this process
 * may not read. Treating the second as "the commit is gone" would tell an
 * operator their base commit was rewritten out of history when the truth is
 * that nothing was ever established, and they would go looking for a force-push
 * that never happened.
 */
describe('separating an absent Git object from an unobservable one', () => {
  const REFUSED: GitCommandResult = Object.freeze({
    outcome: 'REFUSED_UNSAFE_ARGUMENT' as const,
    stdout: '',
    exitCode: null,
  });

  /** The base-pin probe is only reached when ancestry could not be evaluated. */
  async function basePinProbe(baseObject: GitCommandResult) {
    return observeRuntime(scriptedGit({ ancestry: NONZERO(128), baseObject }), STATE, {
      exists: alwaysExists,
    });
  }

  it('reads exit 1 as the documented "object does not resolve"', async () => {
    const observed = await basePinProbe(NONZERO(1));

    expect(observed.basePinnedCommitPresent).toBe(false);
  });

  it.each([
    ['exit 128', NONZERO(128)],
    ['an unexpected non-zero exit', NONZERO(2)],
    ['Git being unavailable', UNAVAILABLE],
    ['a refused argument', REFUSED],
  ])('never turns %s into proof of absence', async (_label, baseObject) => {
    const observed = await basePinProbe(baseObject);

    expect(observed.basePinnedCommitPresent).toBeNull();
  });

  it('reports an indeterminate probe as unobservable, not as a rewritten base', async () => {
    const report = await reconcileWith({ ancestry: NONZERO(128), baseObject: NONZERO(128) });

    expect(report.findings).not.toContain('BASE_COMMIT_ABSENT');
    expect(report.findings).toContain('BASE_COMMIT_UNVERIFIABLE');
    expect(report.verdict).toBe('UNOBSERVABLE');
  });

  it('still reports a genuinely absent base commit as divergence', async () => {
    const report = await reconcileWith({ ancestry: NONZERO(128), baseObject: NONZERO(1) });

    expect(report.findings).toContain('BASE_COMMIT_ABSENT');
    expect(report.verdict).toBe('DIVERGED');
  });
});

/**
 * The persisted worktree path is a *claim*, and Git's registry is the authority
 * that either confirms it or does not.
 *
 * Running `git status` — or anything else — inside a directory named by a state
 * file, before Git has confirmed that directory is this task's registered
 * worktree, executes in a location nothing has vouched for. A stale record, a
 * hand-edited file or a state copied from another machine would all be enough
 * to point the orchestrator's probes at somebody else's checkout. So the order
 * is fixed: read the registry, require it to be readable, find the registration
 * for the recorded path, confirm it holds this task's branch — and only then
 * use *the path Git printed* as a place to look.
 */
describe('registry authority before any local probe', () => {
  /** Every Git call made somewhere other than the repository root. */
  const probesOutsideRoot = (git: { readonly invocations: GitInvocation[] }): GitInvocation[] =>
    git.invocations.filter((call) => call.cwd !== STATE.repositoryRoot);

  it('runs no probe in the recorded worktree when the registry cannot be read', async () => {
    const git = scriptedGit({ registry: UNAVAILABLE });
    const seen: string[] = [];

    const observed = await observeRuntime(git, STATE, {
      exists: (path) => {
        seen.push(path);
        return true;
      },
    });

    expect(probesOutsideRoot(git)).toEqual([]);
    expect(seen).toEqual([]);
    expect(observed.worktreeExists).toBeNull();
    expect(observed.observedCurrentCommit).toBeNull();
    expect(observed.worktreeClean).toBeNull();
  });

  it('reports an unreadable registry as unobservable rather than as a missing worktree', async () => {
    const report = await reconcileWith({ registry: UNAVAILABLE });

    expect(report.findings).not.toContain('WORKTREE_MISSING_ON_DISK');
    expect(report.findings).toContain('WORKTREE_REGISTRY_UNREADABLE');
    expect(report.verdict).toBe('UNOBSERVABLE');
  });

  it('runs no probe in the recorded worktree when Git does not register it', async () => {
    const git = scriptedGit({
      registry: OK(`worktree ${STATE.repositoryRoot}\nbranch refs/heads/main\n`),
    });

    await observeRuntime(git, STATE, { exists: alwaysExists });

    expect(probesOutsideRoot(git)).toEqual([]);
  });

  it('runs no probe in a registered worktree holding somebody else’s branch', async () => {
    const git = scriptedGit({
      registry: OK(`worktree ${WORKTREE}\nbranch refs/heads/somebody-elses-branch\n`),
    });

    const observed = await observeRuntime(git, STATE, { exists: alwaysExists });

    expect(probesOutsideRoot(git)).toEqual([]);
    expect(observed.observedWorkBranchRef).toBe('refs/heads/somebody-elses-branch');
    expect(observed.worktreeExists).toBeNull();
  });

  it('probes the path Git printed, not the path the state recorded', async () => {
    // Two spellings of one directory. Git's is the one that gets executed in.
    const printed = `${WORKTREE}/`;
    const git = scriptedGit({ registry: OK(`worktree ${printed}\nbranch ${BRANCH_REF}\n`) });
    const seen: string[] = [];

    const observed = await observeRuntime(git, STATE, {
      exists: (path) => {
        seen.push(path);
        return true;
      },
    });

    expect(observed.registeredWorktreePath).toBe(printed);
    expect(seen).toEqual([printed]);
    const outside = probesOutsideRoot(git);
    expect(outside.length).toBeGreaterThan(0);
    for (const call of outside) expect(call.cwd).toBe(printed);
  });

  it('still probes normally once the registration is confirmed', async () => {
    const git = scriptedGit();

    const observed = await observeRuntime(git, STATE, { exists: alwaysExists });

    expect(observed.worktreeExists).toBe(true);
    expect(observed.observedCurrentCommit).toBe(STATE.currentCommit);
    expect(observed.worktreeClean).toBe(true);
  });
});

describe('reconciling state against Git', () => {
  it('finds nothing wrong when the world matches the state', async () => {
    const report = await reconcileWith();

    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('CONSISTENT');
  });

  it('refuses when Git no longer lists the recorded worktree', async () => {
    const report = await reconcileWith({
      registry: OK(`worktree ${STATE.repositoryRoot}\nbranch refs/heads/main\n`),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('WORKTREE_NOT_REGISTERED');
  });

  it('refuses when the recorded worktree directory is gone from disk', async () => {
    const report = await reconcileWith({}, neverExists);

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('WORKTREE_MISSING_ON_DISK');
  });

  it('refuses when a different branch is checked out in the worktree', async () => {
    const report = await reconcileWith({
      registry: OK(`worktree ${WORKTREE}\nbranch refs/heads/somebody-elses-branch\n`),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('WORK_BRANCH_NOT_CHECKED_OUT');
  });

  it('refuses when HEAD has moved away from the recorded commit', async () => {
    const report = await reconcileWith({ head: OK('c'.repeat(40)) });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('CURRENT_COMMIT_MOVED');
  });

  it('refuses when the pinned base commit is no longer an ancestor of the work', async () => {
    const report = await reconcileWith({ ancestry: NONZERO(1) });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('BASE_COMMIT_NOT_ANCESTOR');
  });

  it('refuses when the pinned base commit no longer exists in the repository', async () => {
    const report = await reconcileWith({
      ancestry: NONZERO(128),
      baseObject: NONZERO(1),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('BASE_COMMIT_ABSENT');
  });

  it('refuses when the worktree has uncommitted changes', async () => {
    const report = await reconcileWith({ status: OK(' M src/index.ts') });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('WORKTREE_DIRTY');
  });

  it('reports an unreadable registry as unobservable, not as divergence', async () => {
    const report = await reconcileWith({ registry: UNAVAILABLE });

    expect(report.verdict).toBe('UNOBSERVABLE');
    expect(report.findings).toContain('WORKTREE_REGISTRY_UNREADABLE');
  });

  it('reports an unanswerable cleanliness probe as unobservable', async () => {
    const report = await reconcileWith({ status: UNAVAILABLE });

    expect(report.verdict).toBe('UNOBSERVABLE');
    expect(report.findings).toContain('WORKTREE_CLEANLINESS_UNKNOWN');
  });

  /**
   * Every declared finding code must be producible, or it is a promise the
   * reconciler cannot keep. A code nothing can reach is either dead or, worse,
   * reachable only by a path nobody has thought about.
   */
  it('produces every declared finding code from a real observation', async () => {
    const otherBranch = `worktree ${WORKTREE}\nbranch refs/heads/somebody-elses-branch\n`;
    const noWorktree = `worktree ${STATE.repositoryRoot}\nbranch refs/heads/main\n`;

    /** A healthy world, reconciled against a different declared identity. */
    async function reconcileAgainst(
      expectation: typeof EXPECTATION,
    ): Promise<ReconciliationReport> {
      const observed = await observeRuntime(scriptedGit(), STATE, { exists: alwaysExists });
      return reconcileTaskState(STATE, observed, expectation);
    }

    const produce: Readonly<
      Record<ReconciliationFindingCode, () => Promise<ReconciliationReport>>
    > = {
      REPOSITORY_ID_MISMATCH: () =>
        reconcileAgainst({ ...EXPECTATION, repository: { ...REPOSITORY, id: 'elsewhere' } }),
      REPOSITORY_ROOT_MISMATCH: () =>
        reconcileAgainst({
          ...EXPECTATION,
          repository: { ...REPOSITORY, root: '/srv/projects/elsewhere' },
        }),
      TASK_ID_MISMATCH: () => reconcileAgainst({ ...EXPECTATION, taskId: 'task-0002' }),
      BASE_BRANCH_MISMATCH: () =>
        reconcileAgainst({ ...EXPECTATION, repository: { ...REPOSITORY, defaultBranch: 'dev' } }),
      WORKTREE_NOT_REGISTERED: () => reconcileWith({ registry: OK(noWorktree) }),
      WORKTREE_MISSING_ON_DISK: () => reconcileWith({}, neverExists),
      WORK_BRANCH_NOT_CHECKED_OUT: () => reconcileWith({ registry: OK(otherBranch) }),
      BASE_COMMIT_ABSENT: () =>
        reconcileWith({ ancestry: NONZERO(128), baseObject: NONZERO(1) }),
      BASE_COMMIT_NOT_ANCESTOR: () => reconcileWith({ ancestry: NONZERO(1) }),
      CURRENT_COMMIT_MOVED: () => reconcileWith({ head: OK('c'.repeat(40)) }),
      WORKTREE_DIRTY: () => reconcileWith({ status: OK(' M src/index.ts') }),
      WORKTREE_REGISTRY_UNREADABLE: () => reconcileWith({ registry: UNAVAILABLE }),
      BASE_COMMIT_UNVERIFIABLE: () =>
        reconcileWith({ ancestry: NONZERO(128), baseObject: NONZERO(128) }),
      CURRENT_COMMIT_UNKNOWN: () => reconcileWith({ head: NONZERO(128) }),
      WORKTREE_CLEANLINESS_UNKNOWN: () => reconcileWith({ status: UNAVAILABLE }),
    };

    const declared = [...DIVERGENCE_FINDING_CODES, ...UNOBSERVABLE_FINDING_CODES];
    expect(Object.keys(produce).sort()).toEqual([...declared].sort());

    for (const code of declared) {
      expect((await produce[code]()).findings).toContain(code);
    }
  });

  it('checks no commit expectations for a task that has not pinned anything yet', async () => {
    const fresh = parseTaskState(validCreatedState());
    const observed = await observeRuntime(scriptedGit({ head: NONZERO(128) }), fresh, {
      exists: alwaysExists,
    });

    const report = reconcileTaskState(fresh, observed, EXPECTATION);

    expect(report.findings).not.toContain('CURRENT_COMMIT_MOVED');
    expect(report.findings).not.toContain('BASE_COMMIT_NOT_ANCESTOR');
  });
});

/**
 * Git reality is not the same question in every phase.
 *
 * A worktree that has just been created still stands on its pinned base; a task
 * that reached `IMPLEMENTING` has a writing agent committing into it, and an
 * interrupted one has uncommitted work by design. Asking either question
 * globally would report the loop's own progress as divergence and make the
 * ordinary crash — the case this slice exists to survive — unresumable.
 */
describe('phase-sensitive Git expectations', () => {
  /** A commit that is neither the pinned base nor the recorded checkpoint. */
  const COMMITTED = 'd'.repeat(40);

  const stateAt = (overrides: Partial<TaskStateInput>): TaskState =>
    parseTaskState(validCreatedState({ basePinnedCommit: SHA_A, ...overrides }));

  async function reportFor(state: TaskState, script: GitScript): Promise<ReconciliationReport> {
    const observed = await observeRuntime(scriptedGit(script), state, { exists: alwaysExists });
    return reconcileTaskState(state, observed, EXPECTATION);
  }

  it('accepts a task commit made during IMPLEMENTING that no checkpoint recorded', async () => {
    // The base pin is *not* a global expectation: this is the writing agent
    // doing its job. Ancestry still holds, and still gets checked.
    const report = await reportFor(stateAt({ state: 'IMPLEMENTING', currentCommit: null }), {
      head: OK(COMMITTED),
    });

    expect(report.findings).not.toContain('CURRENT_COMMIT_MOVED');
    expect(report.verdict).toBe('CONSISTENT');
  });

  it('still expects the pinned base at WORKTREE_READY, where nothing has run yet', async () => {
    const report = await reportFor(stateAt({ state: 'WORKTREE_READY', currentCommit: null }), {
      head: OK(COMMITTED),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('CURRENT_COMMIT_MOVED');
  });

  it('holds a recorded currentCommit in a work phase too', async () => {
    // Loosening the *fallback* must not loosen the recorded claim: once the
    // checkpoint says where HEAD was, the world contradicting it is divergence
    // in every phase.
    const report = await reportFor(stateAt({ state: 'IMPLEMENTING', currentCommit: SHA_B }), {
      head: OK(COMMITTED),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('CURRENT_COMMIT_MOVED');
  });

  it('accepts uncommitted work the checkpoint already recorded', async () => {
    const report = await reportFor(
      stateAt({ state: 'IMPLEMENTING', currentCommit: SHA_B, worktreeCleanAtCheckpoint: false }),
      { head: OK(SHA_B), status: OK(' M src/index.ts') },
    );

    expect(report.findings).not.toContain('WORKTREE_DIRTY');
    expect(report.verdict).toBe('CONSISTENT');
  });

  it('refuses uncommitted work the checkpoint claimed was clean', async () => {
    const report = await reportFor(
      stateAt({ state: 'IMPLEMENTING', currentCommit: SHA_B, worktreeCleanAtCheckpoint: true }),
      { head: OK(SHA_B), status: OK(' M src/index.ts') },
    );

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('WORKTREE_DIRTY');
  });

  it('refuses uncommitted work in a phase where nothing has run to create it', async () => {
    // Even a record that claims the tree was dirty cannot make a dirty
    // WORKTREE_READY legitimate: no agent has executed in that worktree.
    const report = await reportFor(
      stateAt({ state: 'WORKTREE_READY', currentCommit: null, worktreeCleanAtCheckpoint: false }),
      { head: OK(SHA_A), status: OK(' M src/index.ts') },
    );

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('WORKTREE_DIRTY');
  });

  it('reports an unreadable cleanliness probe as unobservable in a work phase too', async () => {
    const report = await reportFor(
      stateAt({ state: 'IMPLEMENTING', currentCommit: SHA_B, worktreeCleanAtCheckpoint: false }),
      { head: OK(SHA_B), status: UNAVAILABLE },
    );

    expect(report.verdict).toBe('UNOBSERVABLE');
    expect(report.findings).toContain('WORKTREE_CLEANLINESS_UNKNOWN');
  });

  it('derives the pre-work phases from the transition table', () => {
    const predecessorsOf = (to: TaskStateName): readonly TaskStateName[] =>
      ALL_STATES.filter((from) => TRANSITION_TABLE[from].includes(to));

    // The two facts the pre-work set rests on. If the table ever grew an edge
    // from a work phase into either of these, the base-pin and cleanliness
    // expectations below would stop being legitimate — and this fails first.
    expect(predecessorsOf('WORKTREE_READY')).toEqual(['GIT_PREFLIGHT']);
    expect(predecessorsOf('CONTEXT_LOADING')).toEqual(['WORKTREE_READY']);

    // Quota is only consumed where an agent actually runs, which is the table's
    // own definition of the phases that may commit.
    const agentExecuting = ALL_STATES.filter((from) =>
      TRANSITION_TABLE[from].includes('BLOCKED_USAGE_LIMIT'),
    );
    expect(agentExecuting).toEqual(['IMPLEMENTING', 'REVIEWING', 'REMEDIATING']);

    for (const phase of PRE_WORK_STATES) {
      expect(agentExecuting).not.toContain(phase);
      expect(isPreWorkState(phase)).toBe(true);
    }
    expect(isPreWorkState('IMPLEMENTING')).toBe(false);
  });

  it('resumes an interrupted IMPLEMENTING that still has work in progress', async () => {
    // The point of the whole correction: a crash mid-implementation is a
    // resumable task, not a diverged one.
    const state = stateAt({
      state: 'IMPLEMENTING',
      currentCommit: SHA_B,
      worktreeCleanAtCheckpoint: false,
    });
    const observed = await observeRuntime(
      scriptedGit({ head: OK(SHA_B), status: OK(' M src/index.ts') }),
      state,
      { exists: alwaysExists },
    );

    const decision = classifyResume(state, observed, {
      now: '2026-07-31T15:00:00.000Z',
      authPreflightPassed: true,
      repository: REPOSITORY,
      taskId: STATE.taskId,
    });

    expect(decision.classification).toBe('RECONCILED_IN_FLIGHT');
  });

  it('does not let the loosened checks widen an unattended resume', async () => {
    // `BLOCKED_USAGE_LIMIT` is the only state an unattended resume is even
    // considered for. Reconciliation now accepts the dirty tree its checkpoint
    // recorded — and `evaluateAutomaticResume()`, untouched, still denies.
    const state = parseTaskState(validUsageLimitState({ worktreeCleanAtCheckpoint: false }));
    const observed = await observeRuntime(
      scriptedGit({ head: OK(SHA_B), status: OK(' M src/index.ts') }),
      state,
      { exists: alwaysExists },
    );

    expect(reconcileTaskState(state, observed, EXPECTATION).verdict).toBe('CONSISTENT');

    const decision = classifyResume(state, observed, {
      now: '2026-07-31T15:00:00.000Z',
      authPreflightPassed: true,
      repository: REPOSITORY,
      taskId: STATE.taskId,
    });

    expect(decision.classification).toBe('AUTOMATIC_RESUME_REFUSED');
    expect(decision.reasonCodes).toContain('WORKTREE_NOT_CLEAN');
  });
});

/**
 * A valid state file proves only that *something* wrote valid JSON. It does not
 * prove it describes the repository now being resolved, or the task now being
 * run. These checks are what stop a state that parses cleanly from being
 * resumed into the wrong repository.
 */
describe('reconciling state against resolved identity', () => {
  async function reconcileAgainst(expectation: typeof EXPECTATION) {
    const observed = await observeRuntime(scriptedGit(), STATE, { exists: alwaysExists });
    return reconcileTaskState(STATE, observed, expectation);
  }

  it('refuses when the resolved repository has a different id', async () => {
    const report = await reconcileAgainst({
      ...EXPECTATION,
      repository: { ...REPOSITORY, id: 'some-other-repository' },
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('REPOSITORY_ID_MISMATCH');
  });

  it('refuses when the resolved repository root is a different directory', async () => {
    const report = await reconcileAgainst({
      ...EXPECTATION,
      repository: { ...REPOSITORY, root: '/srv/projects/somewhere-else' },
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('REPOSITORY_ROOT_MISMATCH');
  });

  it('accepts a repository root that differs only in spelling', async () => {
    const report = await reconcileAgainst({
      ...EXPECTATION,
      repository: { ...REPOSITORY, root: `${REPOSITORY.root}/` },
    });

    expect(report.findings).not.toContain('REPOSITORY_ROOT_MISMATCH');
  });

  it('refuses when the state file describes a different task', async () => {
    const report = await reconcileAgainst({ ...EXPECTATION, taskId: 'task-0002' });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('TASK_ID_MISMATCH');
  });

  it('refuses when the base branch is no longer the one the repository declares', async () => {
    const report = await reconcileAgainst({
      ...EXPECTATION,
      repository: { ...REPOSITORY, defaultBranch: 'develop' },
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('BASE_BRANCH_MISMATCH');
  });
});

/**
 * The composed entry point: load, observe, compare, and answer with one closed
 * outcome. A caller must be able to branch on that single value without
 * re-deriving it from findings.
 */
describe('reconciliation outcomes', () => {
  const roots: string[] = [];

  function repoRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ao-recon-'));
    roots.push(dir);
    return dir;
  }

  afterEach(() => {
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A persisted, self-consistent task in `root`, plus a Git that agrees. */
  function persistedTask(root: string) {
    const worktreePath = join(root, 'wt');
    const state = validUsageLimitState({
      repositoryRoot: root,
      worktreePath,
      taskId: 'task-0001',
    });
    const saved = saveTaskState(state, { repositoryRoot: root });
    if (!saved.ok) throw new Error(`fixture did not persist: ${saved.code}`);

    const registry = `worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktreePath}\nbranch refs/heads/agent/task-0001\n`;
    const expectation = {
      repository: { id: 'repo-alpha', root, defaultBranch: 'main' },
      taskId: 'task-0001',
    };
    return { state, worktreePath, registry, expectation };
  }

  it('reports a task that was never persisted', async () => {
    const root = repoRoot();
    const { registry, expectation } = persistedTask(root);
    rmSync(join(root, '.agent-orchestrator'), { recursive: true, force: true });

    const result = await reconcileTask(scriptedGit({ registry: OK(registry) }), expectation, {
      exists: alwaysExists,
    });

    expect(result.outcome).toBe('NO_PERSISTED_STATE');
    expect(result.state).toBeNull();
  });

  it('reports a persisted state that is not usable', async () => {
    const root = repoRoot();
    const { registry, expectation } = persistedTask(root);
    writeFileSync(join(root, '.agent-orchestrator', 'runtime', 'task-0001.json'), '{ not json');

    const result = await reconcileTask(scriptedGit({ registry: OK(registry) }), expectation, {
      exists: alwaysExists,
    });

    expect(result.outcome).toBe('STATE_INVALID');
    expect(result.report).toBeNull();
  });

  it('reconciles a persisted state that matches reality', async () => {
    const root = repoRoot();
    const { registry, expectation } = persistedTask(root);

    const result = await reconcileTask(scriptedGit({ registry: OK(registry) }), expectation, {
      exists: alwaysExists,
    });

    expect(result.outcome).toBe('RECONCILED');
    expect(result.reasonCodes).toEqual([]);
    expect(result.state?.taskId).toBe('task-0001');
  });

  it('keeps a state belonging to another repository out of STATE_INVALID', async () => {
    const root = repoRoot();
    const { registry, expectation } = persistedTask(root);
    // A well-formed state, for a real task, describing a different checkout.
    writeFileSync(
      join(root, '.agent-orchestrator', 'runtime', 'task-0001.json'),
      JSON.stringify(validUsageLimitState({ repositoryRoot: repoRoot(), taskId: 'task-0001' })),
    );

    const result = await reconcileTask(scriptedGit({ registry: OK(registry) }), expectation, {
      exists: alwaysExists,
    });

    expect(result.outcome).toBe('STATE_REPOSITORY_MISMATCH');
    expect(result.reasonCodes).toContain('REPOSITORY_ROOT_MISMATCH');
  });

  it('reports a state belonging to another task as its own outcome', async () => {
    const root = repoRoot();
    const { registry, expectation } = persistedTask(root);
    writeFileSync(
      join(root, '.agent-orchestrator', 'runtime', 'task-0001.json'),
      JSON.stringify(validUsageLimitState({ repositoryRoot: root, taskId: 'task-0002' })),
    );

    const result = await reconcileTask(scriptedGit({ registry: OK(registry) }), expectation, {
      exists: alwaysExists,
    });

    expect(result.outcome).toBe('STATE_TASK_MISMATCH');
    expect(result.reasonCodes).toContain('TASK_ID_MISMATCH');
  });

  it('distinguishes malformed, wrong-repository and wrong-task documents', async () => {
    const write = (root: string, contents: string): void => {
      writeFileSync(join(root, '.agent-orchestrator', 'runtime', 'task-0001.json'), contents);
    };
    const outcomeAfter = async (contents: (root: string) => string): Promise<string> => {
      const root = repoRoot();
      const { registry, expectation } = persistedTask(root);
      write(root, contents(root));
      const result = await reconcileTask(scriptedGit({ registry: OK(registry) }), expectation, {
        exists: alwaysExists,
      });
      return result.outcome;
    };

    expect(await outcomeAfter(() => '{ not json')).toBe('STATE_INVALID');
    expect(
      await outcomeAfter(() =>
        JSON.stringify(validUsageLimitState({ repositoryRoot: repoRoot(), taskId: 'task-0001' })),
      ),
    ).toBe('STATE_REPOSITORY_MISMATCH');
    expect(
      await outcomeAfter((root) =>
        JSON.stringify(validUsageLimitState({ repositoryRoot: root, taskId: 'task-0002' })),
      ),
    ).toBe('STATE_TASK_MISMATCH');
  });

  it('separates a repository mismatch from ordinary divergence', async () => {
    const root = repoRoot();
    const { registry, expectation } = persistedTask(root);

    const result = await reconcileTask(scriptedGit({ registry: OK(registry) }), {
      ...expectation,
      repository: { ...expectation.repository, id: 'some-other-repository' },
    }, { exists: alwaysExists });

    expect(result.outcome).toBe('STATE_REPOSITORY_MISMATCH');
    expect(result.reasonCodes).toContain('REPOSITORY_ID_MISMATCH');
  });

  it('reports divergence when the world contradicts the record', async () => {
    const root = repoRoot();
    const { registry, expectation } = persistedTask(root);

    const result = await reconcileTask(
      scriptedGit({ registry: OK(registry), head: OK('c'.repeat(40)) }),
      expectation,
      { exists: alwaysExists },
    );

    expect(result.outcome).toBe('STATE_DIVERGED');
    expect(result.reasonCodes).toContain('CURRENT_COMMIT_MOVED');
  });

  it('reports unobservability separately from divergence', async () => {
    const root = repoRoot();
    const { expectation } = persistedTask(root);

    const result = await reconcileTask(scriptedGit({ registry: UNAVAILABLE }), expectation, {
      exists: alwaysExists,
    });

    expect(result.outcome).toBe('STATE_UNOBSERVABLE');
  });

  it('always answers with an outcome from the closed set', async () => {
    const root = repoRoot();
    const { registry, expectation } = persistedTask(root);

    const result = await reconcileTask(scriptedGit({ registry: OK(registry) }), expectation, {
      exists: alwaysExists,
    });

    expect(RECONCILIATION_OUTCOMES).toContain(result.outcome);
  });
});

describe('classifying whether a task may resume', () => {
  const context = {
    now: '2026-07-31T15:00:00.000Z',
    authPreflightPassed: true,
    repository: REPOSITORY,
    taskId: STATE.taskId,
  };

  async function classifyWith(script: GitScript = {}, exists = alwaysExists, state = STATE) {
    const observed = await observeRuntime(scriptedGit(script), state, { exists });
    return classifyResume(state, observed, context);
  }

  it('allows an unattended resume when the block cleared and nothing moved', async () => {
    const decision = await classifyWith();

    expect(decision.classification).toBe('AUTOMATIC_RESUME_ALLOWED');
    expect(decision.reasonCodes).toEqual([]);
  });

  it('refuses an unattended resume before the reported quota reset', async () => {
    const observed = await observeRuntime(scriptedGit(), STATE, { exists: alwaysExists });

    const decision = classifyResume(STATE, observed, {
      ...context,
      now: '2026-07-31T13:00:00.000Z',
    });

    expect(decision.classification).toBe('AUTOMATIC_RESUME_REFUSED');
    expect(decision.reasonCodes).toContain('RESET_TIME_NOT_REACHED');
  });

  it('refuses an unattended resume when auth has not been re-proven', async () => {
    const observed = await observeRuntime(scriptedGit(), STATE, { exists: alwaysExists });

    const decision = classifyResume(STATE, observed, { ...context, authPreflightPassed: false });

    expect(decision.classification).toBe('AUTOMATIC_RESUME_REFUSED');
    expect(decision.reasonCodes).toContain('AUTH_PREFLIGHT_NOT_PASSED');
  });

  it('stops at reconciliation when Git disagrees, before judging the block', async () => {
    const decision = await classifyWith({ head: OK('c'.repeat(40)) });

    // Named for the state a caller moves the task into (`RESUME_STATE_DIVERGED`),
    // rather than a second vocabulary for the same condition.
    expect(decision.classification).toBe('STATE_DIVERGED');
    expect(decision.reasonCodes).toContain('CURRENT_COMMIT_MOVED');
    expect(decision.automaticResume).toBeNull();
  });

  it('refuses to resume a repository whose identity no longer matches', async () => {
    const observed = await observeRuntime(scriptedGit(), STATE, { exists: alwaysExists });

    const decision = classifyResume(STATE, observed, {
      ...context,
      repository: { ...REPOSITORY, id: 'some-other-repository' },
    });

    // Caught while reconciling, so it applies to every state — not only to the
    // one blocking state an unattended resume is ever considered for.
    expect(decision.classification).toBe('STATE_DIVERGED');
    expect(decision.reasonCodes).toContain('REPOSITORY_ID_MISMATCH');
  });

  it('checks repository identity for a regular in-flight state too', async () => {
    const working = parseTaskState(
      validUsageLimitState({ state: 'IMPLEMENTING', blockedAgent: null, resumeFrom: null }),
    );
    const observed = await observeRuntime(scriptedGit(), working, { exists: alwaysExists });

    const decision = classifyResume(working, observed, {
      ...context,
      repository: { ...REPOSITORY, id: 'some-other-repository' },
    });

    expect(decision.classification).toBe('STATE_DIVERGED');
  });

  it('hands a state needing an operator to the operator', async () => {
    const human = parseTaskState(
      validUsageLimitState({
        state: 'HUMAN_DECISION_REQUIRED',
        blockedAgent: null,
        reportedResetAt: null,
      }),
    );

    const decision = await classifyWith({}, alwaysExists, human);

    expect(decision.classification).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('treats a finished task as finished rather than as resumable', async () => {
    const done = parseTaskState(
      validUsageLimitState({
        state: 'READY_FOR_PR',
        blockedAgent: null,
        resumeFrom: null,
        reportedResetAt: null,
      }),
    );

    const decision = await classifyWith({}, alwaysExists, done);

    expect(decision.classification).toBe('TASK_COMPLETE');
  });

  it('continues a regular in-flight state that reconciles cleanly', async () => {
    const working = parseTaskState(
      validUsageLimitState({ state: 'IMPLEMENTING', blockedAgent: null, resumeFrom: null }),
    );

    const decision = await classifyWith({}, alwaysExists, working);

    expect(decision.classification).toBe('RECONCILED_IN_FLIGHT');
  });
});

/**
 * Reconciliation is not permission.
 *
 * "The persisted record agrees with observed reality" and "this task may run
 * unattended" are two different statements, and the first must never be
 * mistakable for the second. A dirty `IMPLEMENTING` checkpoint reconciles
 * perfectly — that is the whole point of the phase-sensitive checks — and it is
 * emphatically not a task an orchestrator may pick up and continue with nobody
 * watching. Only `evaluateAutomaticResume()` says that.
 */
describe('continuation authority is separate from reconciliation', () => {
  const context = {
    now: '2026-07-31T15:00:00.000Z',
    authPreflightPassed: true,
    repository: REPOSITORY,
    taskId: STATE.taskId,
  };

  async function decide(state: TaskState, script: GitScript = {}, exists = alwaysExists) {
    const observed = await observeRuntime(scriptedGit(script), state, { exists });
    return classifyResume(state, observed, context);
  }

  it('offers no classification that reads as "continue unattended"', () => {
    expect(RESUME_CLASSIFICATIONS).not.toContain('RESUME_READY');
  });

  it('marks a reconciling dirty IMPLEMENTING as attended-only', async () => {
    const state = parseTaskState(
      validUsageLimitState({
        state: 'IMPLEMENTING',
        blockedAgent: null,
        resumeFrom: null,
        worktreeCleanAtCheckpoint: false,
      }),
    );

    const decision = await decide(state, { head: OK(SHA_B), status: OK(' M src/index.ts') });

    expect(decision.reconciliation.verdict).toBe('CONSISTENT');
    expect(decision.classification).toBe('RECONCILED_IN_FLIGHT');
    expect(decision.continuation).toBe('ATTENDED_ONLY');
    expect(decision.automaticResume).toBeNull();
  });

  it('grants AUTOMATIC_ALLOWED only from the automatic-resume authority', async () => {
    const decision = await decide(STATE);

    expect(decision.continuation).toBe('AUTOMATIC_ALLOWED');
    expect(decision.automaticResume?.allowed).toBe(true);
  });

  it('never grants AUTOMATIC_ALLOWED without that authority having said yes', async () => {
    const done = parseTaskState(
      validUsageLimitState({
        state: 'READY_FOR_PR',
        blockedAgent: null,
        resumeFrom: null,
        reportedResetAt: null,
      }),
    );
    const human = parseTaskState(
      validUsageLimitState({
        state: 'HUMAN_DECISION_REQUIRED',
        blockedAgent: null,
        reportedResetAt: null,
      }),
    );
    const working = parseTaskState(
      validUsageLimitState({ state: 'IMPLEMENTING', blockedAgent: null, resumeFrom: null }),
    );

    const decisions = [
      await decide(STATE),
      await decide(STATE, { head: OK('c'.repeat(40)) }),
      await decide(STATE, { registry: UNAVAILABLE }),
      await decide(done),
      await decide(human),
      await decide(working),
      await decide(working, { status: OK(' M src/index.ts') }),
    ];

    // The invariant a naive caller may rely on, in both directions.
    for (const decision of decisions) {
      expect(CONTINUATION_AUTHORITIES).toContain(decision.continuation);
      expect(decision.continuation === 'AUTOMATIC_ALLOWED').toBe(
        decision.automaticResume?.allowed === true,
      );
    }
  });

  it.each([
    ['a finished task', 'TERMINAL'],
    ['a diverged task', 'BLOCKED'],
    ['a task awaiting an operator', 'ATTENDED_ONLY'],
  ])('reports %s as %s', async (label, expected) => {
    const decision =
      label === 'a finished task'
        ? await decide(
            parseTaskState(
              validUsageLimitState({
                state: 'READY_FOR_PR',
                blockedAgent: null,
                resumeFrom: null,
                reportedResetAt: null,
              }),
            ),
          )
        : label === 'a diverged task'
          ? await decide(STATE, { head: OK('c'.repeat(40)) })
          : await decide(
              parseTaskState(
                validUsageLimitState({
                  state: 'HUMAN_DECISION_REQUIRED',
                  blockedAgent: null,
                  reportedResetAt: null,
                }),
              ),
            );

    expect(decision.continuation).toBe(expected);
  });

  it('blocks a usage-limit task whose block has not cleared', async () => {
    const observed = await observeRuntime(scriptedGit(), STATE, { exists: alwaysExists });

    const decision = classifyResume(STATE, observed, {
      ...context,
      now: '2026-07-31T13:00:00.000Z',
    });

    expect(decision.classification).toBe('AUTOMATIC_RESUME_REFUSED');
    expect(decision.continuation).toBe('BLOCKED');
  });
});

/**
 * Re-authenticating re-enters the setup chain — with the task's work already in
 * the worktree.
 *
 * `BLOCKED_AUTH → AUTH_PREFLIGHT → GIT_PREFLIGHT → WORKTREE_READY` is a
 * declared path through the transition table, and a task that walks it after
 * days of implementation arrives at `WORKTREE_READY` carrying commits and,
 * often, uncommitted work. Treating that arrival as a freshly created worktree
 * — HEAD must equal the base pin, any dirt is divergence — would report the
 * loop's own work as corruption at exactly the moment an operator has just
 * fixed the thing that blocked it.
 *
 * The fix is not to make `WORKTREE_READY` permissive. It is to ask what the
 * record already says: a state that carries a resume point, a checkpointed
 * commit, a completed review round or recorded findings is not a virgin
 * worktree, whatever phase it is in.
 */
describe('auth re-entry preserves work history', () => {
  const COMMITTED = 'd'.repeat(40);

  /** The state of a task that has just re-authenticated and been re-prepared. */
  const afterAuthCycle = (overrides: Partial<TaskStateInput> = {}): TaskState =>
    parseTaskState(
      validCreatedState({
        state: 'WORKTREE_READY',
        basePinnedCommit: SHA_A,
        currentCommit: null,
        // What `BLOCKED_AUTH` required and the loop carries through the
        // re-entry chain: where to continue once credentials are good again.
        resumeFrom: { phase: 'IMPLEMENT', round: 1 },
        ...overrides,
      }),
    );

  /** A freshly prepared worktree: nothing has ever run in it. */
  const freshlyPrepared = (overrides: Partial<TaskStateInput> = {}): TaskState =>
    parseTaskState(
      validCreatedState({
        state: 'WORKTREE_READY',
        basePinnedCommit: SHA_A,
        currentCommit: null,
        resumeFrom: null,
        ...overrides,
      }),
    );

  async function reportFor(state: TaskState, script: GitScript): Promise<ReconciliationReport> {
    const observed = await observeRuntime(scriptedGit(script), state, { exists: alwaysExists });
    return reconcileTaskState(state, observed, EXPECTATION);
  }

  it('is a path the transition table actually declares', () => {
    const chain: readonly TaskStateName[] = [
      'BLOCKED_AUTH',
      'AUTH_PREFLIGHT',
      'GIT_PREFLIGHT',
      'WORKTREE_READY',
    ];
    for (let index = 0; index + 1 < chain.length; index += 1) {
      expect(TRANSITION_TABLE[chain[index] as TaskStateName]).toContain(chain[index + 1]);
    }
  });

  it('A: reconciles a freshly prepared worktree standing on its base', async () => {
    const report = await reportFor(freshlyPrepared(), { head: OK(SHA_A) });

    expect(report.verdict).toBe('CONSISTENT');
  });

  it('B: still calls a freshly prepared worktree with a moved HEAD diverged', async () => {
    const report = await reportFor(freshlyPrepared(), { head: OK(COMMITTED) });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('CURRENT_COMMIT_MOVED');
  });

  it('C: does not call a legitimate task commit divergence after an auth cycle', async () => {
    const report = await reportFor(afterAuthCycle(), { head: OK(COMMITTED) });

    expect(report.findings).not.toContain('CURRENT_COMMIT_MOVED');
    expect(report.verdict).toBe('CONSISTENT');
  });

  it('D: does not call interrupted dirty work divergence after an auth cycle', async () => {
    const report = await reportFor(
      afterAuthCycle({ worktreeCleanAtCheckpoint: false }),
      { head: OK(COMMITTED), status: OK(' M src/index.ts') },
    );

    expect(report.findings).not.toContain('WORKTREE_DIRTY');
    expect(report.verdict).toBe('CONSISTENT');
  });

  it('E: still refuses a HEAD that does not descend from the pinned base', async () => {
    const report = await reportFor(afterAuthCycle(), {
      head: OK(COMMITTED),
      ancestry: NONZERO(1),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('BASE_COMMIT_NOT_ANCESTOR');
  });

  it('still holds a recorded currentCommit after an auth cycle', async () => {
    const report = await reportFor(afterAuthCycle({ currentCommit: SHA_B }), {
      head: OK(COMMITTED),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('CURRENT_COMMIT_MOVED');
  });

  it('still refuses dirt the checkpoint said was not there', async () => {
    const report = await reportFor(afterAuthCycle({ worktreeCleanAtCheckpoint: true }), {
      head: OK(COMMITTED),
      status: OK(' M src/index.ts'),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('WORKTREE_DIRTY');
  });

  it('still refuses somebody else’s branch after an auth cycle', async () => {
    const report = await reportFor(afterAuthCycle(), {
      registry: OK(`worktree ${STATE.worktreePath}\nbranch refs/heads/not-ours\n`),
    });

    expect(report.verdict).toBe('DIVERGED');
    expect(report.findings).toContain('WORK_BRANCH_NOT_CHECKED_OUT');
  });

  it.each([
    ['a carried resume point', { resumeFrom: { phase: 'IMPLEMENT', round: 1 } }],
    ['a checkpointed commit', { currentCommit: SHA_B }],
    ['a completed review round', { reviewRound: 1 }],
    [
      'recorded findings',
      { findingHistory: [{ round: 1, severity: 'high', fingerprint: 'f-1' }] },
    ],
  ])('treats %s as evidence that work already exists', (_label, overrides) => {
    const state = freshlyPrepared(overrides as Partial<TaskStateInput>);

    expect(isPreWorkState(state.state)).toBe(true);
    expect(isVirginPreWorkState(state)).toBe(false);
  });

  it('treats a state with none of that evidence as a virgin worktree', () => {
    expect(isVirginPreWorkState(freshlyPrepared())).toBe(true);
    // And a work phase is never "virgin pre-work", evidence or not.
    expect(
      isVirginPreWorkState(parseTaskState(validCreatedState({ state: 'IMPLEMENTING' }))),
    ).toBe(false);
  });
});
