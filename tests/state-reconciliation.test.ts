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

import { describe, expect, it } from 'vitest';

import type { GitCommandResult, GitRunner } from '../src/worktree/git-command.js';
import { observeRuntime } from '../src/state/observe-runtime.js';
import { reconcileTaskState } from '../src/state/reconcile.js';
import { classifyResume } from '../src/state/resume-decision.js';
import { SHA_A, SHA_B, validCreatedState, validUsageLimitState } from './fixtures.js';
import { parseTaskState } from '../src/core/task-state.js';

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

/** A Git that answers each probe from a script. Records what it was asked. */
function scriptedGit(script: GitScript = {}): GitRunner & { readonly calls: string[][] } {
  const calls: string[][] = [];
  const runner = async (_cwd: string, args: readonly string[]): Promise<GitCommandResult> => {
    calls.push([...args]);
    if (startsWith(args, ['worktree', 'list'])) return script.registry ?? OK(HEALTHY_REGISTRY);
    if (startsWith(args, ['status'])) return script.status ?? OK('');
    if (startsWith(args, ['merge-base', '--is-ancestor'])) return script.ancestry ?? OK();
    if (startsWith(args, ['rev-parse']) && args.includes('HEAD')) {
      return script.head ?? OK(STATE.currentCommit ?? SHA_B);
    }
    if (startsWith(args, ['rev-parse'])) return script.baseObject ?? OK(SHA_A);
    throw new Error(`unscripted git call: ${args.join(' ')}`);
  };
  return Object.assign(runner, { calls });
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

    expect(decision.classification).toBe('RESUME_READY');
  });
});
