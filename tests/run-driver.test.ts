/**
 * V1-07 — the governed run driver.
 *
 * A driver is where the safe pieces get to be used unsafely. Each slice below
 * it already refuses the wrong thing when asked directly; what a driver can do
 * is *not ask*. So every test here is written against one of the four ways that
 * happens:
 *
 *  1. **Executing on the record alone.** The persisted state is a sentence in a
 *     file. Stepping a task without first asking Git what is true — or asking
 *     once, at the start, and then trusting the answer for an hour of
 *     subprocesses — is how an agent ends up running in a directory nobody
 *     vouched for.
 *  2. **Reading "the record is accurate" as "carry on".** Reconciling is not
 *     permission. A blocked task that reconciles perfectly is still blocked,
 *     and the states that say a human must decide say it for reasons a driver
 *     has no standing to overrule.
 *  3. **Believing a step's own account of itself.** Progress is the durable
 *     revision moving. A step that reports `ADVANCED` on a write that never
 *     landed, driven by a loop that trusts the report, is a busy-loop that
 *     reports success.
 *  4. **Inventing evidence for the next agent.** A remediation pass needs a
 *     cause that survived. Where none did, the honest answer is to stop, not to
 *     compose a brief whose every claim is fabricated.
 *
 * The real store is used against real temporary directories, and Git is the
 * injected seam — the interesting registries (unreadable, foreign branch, a
 * worktree Git lists that is not there) are exactly the ones a real repository
 * cannot be asked to produce on demand.
 */

import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { AgentCommandResult, AgentRunner } from '../src/agent/agent-command.js';
import type { TaskStateInput } from '../src/core/task-state.js';
import type { CompletionObserver } from '../src/loop/loop-step.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import {
  RUN_OUTCOMES,
  runNextTask,
  runTask,
  selectRunTask,
  type RunDependencies,
  type RunRequest,
} from '../src/run/run-driver.js';
import type { ReplaceFn } from '../src/state/atomic-file.js';
import {
  loadTaskState,
  saveTaskState,
  type StateLoadSuccess,
} from '../src/state/state-store.js';
import type { VerificationCommandResult, VerificationRunner } from '../src/verify/verify-command.js';
import type { GitCommandResult, GitRunner } from '../src/worktree/git-command.js';
import {
  agentCommandResult,
  claudeSuccessEnvelope,
  codexTranscript,
  passingReview,
  SHA_A,
  SHA_B,
  validCreatedState,
} from './fixtures.js';
import {
  createRepoFixture,
  FIXTURE_A_PROFILE,
  removeRepoFixtures,
} from './helpers/repo-fixtures.js';
import { resolveFixture } from './helpers/worktree-fixtures.js';

const TASK_ID = 'task-0001';
const WORK_BRANCH = 'agent/task-0001';
const BRANCH_REF = `refs/heads/${WORK_BRANCH}`;

const tempDirs: string[] = [];

function repoRoot(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-driver-')));
  tempDirs.push(dir);
  return dir;
}

/** The worktree the state records, and the one Git is scripted to vouch for. */
function worktreeOf(root: string): string {
  return join(root, 'worktree');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(removeRepoFixtures);

/* ───────────────────────────── the repository ───────────────────────────── */

/**
 * A resolved repository for a temporary root.
 *
 * Built as a literal rather than resolved from a fixture, because the driver
 * reads exactly four things from it — identity, default branch, root and the
 * verification policy — and a test that had to `git init` to exercise a
 * compare-and-swap refusal would be testing the fixture.
 */
function repository(root: string): ResolvedRepository {
  return Object.freeze({
    root,
    id: 'repo-alpha',
    defaultBranch: 'main',
    profilePath: join(root, '.agent-orchestrator', 'repo-profile.yaml'),
    schemaVersion: 1,
    taskSource: Object.freeze({ kind: 'MARKDOWN_DIRECTORY' as const, path: 'tasks' }),
    context: Object.freeze({ canonicalSources: Object.freeze(['README.md']) }),
    capabilities: Object.freeze({
      codegraph: Object.freeze({
        capability: 'codegraph' as const,
        requirement: 'OPTIONAL' as const,
        status: 'UNAVAILABLE' as const,
        satisfied: true,
      }),
    }),
    verification: Object.freeze({
      phases: Object.freeze([
        Object.freeze({ phase: 'VERIFY' as const, command: Object.freeze(['npm', 'run', 'verify']) }),
      ]),
    }),
    scope: Object.freeze({ allowedPaths: Object.freeze(['src']), protectedPaths: Object.freeze([]) }),
    completion: Object.freeze({ maxReviewRounds: 3 }),
    remote: Object.freeze({ required: false, present: false }),
  });
}

/* ─────────────────────────────── the state ──────────────────────────────── */

function taskState(root: string, overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return validCreatedState({
    repositoryRoot: root,
    worktreePath: worktreeOf(root),
    workBranch: WORK_BRANCH,
    state: 'VERIFYING',
    basePinnedCommit: SHA_A,
    currentCommit: SHA_B,
    reviewRound: 0,
    maxReviewRounds: 3,
    worktreeCleanAtCheckpoint: false,
    ...overrides,
  });
}

function persist(root: string, overrides: Partial<TaskStateInput> = {}): StateLoadSuccess {
  const saved = saveTaskState(taskState(root, overrides), { repositoryRoot: root });
  if (!saved.ok) throw new Error(`fixture did not persist: ${saved.code} ${saved.detail ?? ''}`);
  return reload(root);
}

function reload(root: string): StateLoadSuccess {
  const load = loadTaskState(root, TASK_ID);
  if (!load.ok) throw new Error(`state did not load: ${load.code}`);
  return load;
}

/* ──────────────────────────────── the seams ─────────────────────────────── */

const OK = (stdout = ''): GitCommandResult =>
  Object.freeze({ outcome: 'OK' as const, stdout, exitCode: 0 });
const UNAVAILABLE: GitCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
  exitCode: null,
});

interface GitScript {
  readonly registry?: GitCommandResult;
  readonly head?: GitCommandResult;
  readonly status?: GitCommandResult;
}

/** The porcelain listing a healthy repository produces for {@link taskState}. */
function healthyRegistry(root: string, worktreePath = worktreeOf(root)): string {
  return `worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktreePath}\nbranch ${BRANCH_REF}\n`;
}

function startsWith(args: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((value, index) => args[index] === value);
}

/** A Git that answers from a script and records the order it was asked in. */
function scriptedGit(root: string, script: GitScript = {}) {
  const calls: { cwd: string; args: readonly string[] }[] = [];
  const runner: GitRunner = async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    if (startsWith(args, ['worktree', 'list'])) return script.registry ?? OK(healthyRegistry(root));
    if (startsWith(args, ['status'])) return script.status ?? OK('');
    if (startsWith(args, ['merge-base', '--is-ancestor'])) return OK();
    if (startsWith(args, ['rev-parse']) && args.includes('HEAD')) return script.head ?? OK(SHA_B);
    if (startsWith(args, ['rev-parse'])) return OK(SHA_A);
    throw new Error(`unscripted git call: ${args.join(' ')}`);
  };
  return Object.assign(runner, {
    calls,
    registryReads: () => calls.filter((call) => startsWith(call.args, ['worktree', 'list'])).length,
  });
}

/** A verification seam answering from a script, recording every `cwd`. */
function scriptedVerify(...results: Partial<VerificationCommandResult>[]) {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  let index = 0;
  const runner: VerificationRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    const overrides = results[Math.min(index, results.length - 1)] ?? {};
    index += 1;
    return Object.freeze({
      outcome: 'RAN' as const,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      failureCode: null,
      errnoCode: null,
      durationMs: 5,
      ...overrides,
    });
  };
  return { runner, calls };
}

/** An agent seam answering from a script, recording every `cwd` and payload. */
function scriptedAgent(...results: AgentCommandResult[]) {
  const calls: { agent: string; cwd: string; payload: string }[] = [];
  let index = 0;
  const runner: AgentRunner = async (agent, _args, cwd, payload) => {
    calls.push({ agent, cwd, payload });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result === undefined) throw new Error('unscripted agent call');
    return result;
  };
  return { runner, calls };
}

/**
 * A seam that throws past `cap`, so a driver that fails to stop fails as an
 * error rather than as a hang. Every "nothing was run" assertion below is
 * backed by one of these at zero.
 */
function cappedAgent(result: AgentCommandResult, cap: number) {
  let calls = 0;
  const runner: AgentRunner = async () => {
    calls += 1;
    if (calls > cap) throw new Error(`agent invoked more than ${cap} times`);
    return result;
  };
  return { runner, count: () => calls };
}

function cappedVerify(cap: number) {
  let calls = 0;
  const runner: VerificationRunner = async () => {
    calls += 1;
    if (calls > cap) throw new Error(`verification invoked more than ${cap} times`);
    return Object.freeze({
      outcome: 'RAN' as const,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      failureCode: null,
      errnoCode: null,
      durationMs: 1,
    });
  };
  return { runner, count: () => calls };
}

const settledObserver: CompletionObserver = async () =>
  Object.freeze({ currentCommit: SHA_B, worktreeClean: true });

/** A clock that moves, so two states never claim the same `stateEnteredAt`. */
function tickingClock(): () => string {
  let minute = 0;
  return () => {
    minute += 1;
    return `2026-08-10T09:${String(minute).padStart(2, '0')}:00.000Z`;
  };
}

function deps(root: string, overrides: Partial<RunDependencies> = {}): RunDependencies {
  return {
    now: tickingClock(),
    git: scriptedGit(root),
    exists: () => true,
    observe: settledObserver,
    ...overrides,
  };
}

function request(root: string, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    repository: repository(root),
    taskId: TASK_ID,
    taskBrief: 'Add a widget.',
    attendedContinuation: true,
    authPreflightPassed: true,
    maxSteps: 12,
    ...overrides,
  };
}

/** A reviewer transcript reporting one finding. */
function findingsReview(): string {
  return codexTranscript({
    reviewVersion: 1,
    verdict: 'FINDINGS',
    findings: [{ severity: 'high', path: 'src/agent/claude-writer.ts', rule: 'bounded.rule' }],
  });
}

const DURABLE_FINDING = { round: 1, severity: 'high' as const, fingerprint: 'c'.repeat(32) };

/* ═══════════════════════ J — reconciliation comes first ═════════════════════ */

describe('nothing executes before the world has been re-read', () => {
  it('reads the worktree registry before it starts anything, on every iteration', async () => {
    const root = repoRoot();
    persist(root);
    const git = scriptedGit(root);
    const verify = scriptedVerify({ exitCode: 0 });
    const agent = scriptedAgent(agentCommandResult({ stdout: codexTranscript(passingReview()) }));

    const run = await runTask(request(root), deps(root, { git, verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('TASK_COMPLETED');
    // Two durable steps were taken, and each was preceded by its own reading of
    // the registry. A driver that hoisted reconciliation out of its loop would
    // read it once, and would then be stepping a task on an hour-old answer.
    expect(run.steps).toBe(2);
    expect(git.registryReads()).toBe(2);

    // And the order, not merely the count: the registry was read before the
    // first verification command was ever spawned.
    const firstGit = git.calls.findIndex((call) => startsWith(call.args, ['worktree', 'list']));
    expect(firstGit).toBe(0);
    expect(verify.calls).toHaveLength(1);
  });

  it.each([
    ['an unregistered worktree', { registry: OK('worktree /elsewhere\nbranch refs/heads/main\n') }, 'STATE_DIVERGED', 'WORKTREE_NOT_REGISTERED'],
    ['an unreadable registry', { registry: UNAVAILABLE }, 'STATE_UNOBSERVABLE', 'WORKTREE_REGISTRY_UNREADABLE'],
    ['a HEAD that moved', { head: OK('d'.repeat(40)) }, 'STATE_DIVERGED', 'CURRENT_COMMIT_MOVED'],
  ])('runs nothing when reconciliation reports %s', async (_label, script, outcome, reason) => {
    const root = repoRoot();
    const before = persist(root);
    const agent = cappedAgent(agentCommandResult(), 0);
    const verify = cappedVerify(0);

    const run = await runTask(
      request(root),
      deps(root, { git: scriptedGit(root, script), agent: agent.runner, verify: verify.runner }),
    );

    expect(run.outcome).toBe(outcome);
    expect(run.reasonCodes).toContain(reason);
    expect(run.steps).toBe(0);
    expect(agent.count()).toBe(0);
    expect(verify.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  it('stops mid-run when the world stops being readable between steps', async () => {
    const root = repoRoot();
    persist(root);
    // Healthy for the first reading, unreadable for every one after it.
    let reads = 0;
    const git: GitRunner = async (cwd, args) => {
      if (startsWith(args, ['worktree', 'list'])) {
        reads += 1;
        return reads === 1 ? OK(healthyRegistry(root)) : UNAVAILABLE;
      }
      if (startsWith(args, ['status'])) return OK('');
      if (startsWith(args, ['merge-base', '--is-ancestor'])) return OK();
      if (startsWith(args, ['rev-parse']) && args.includes('HEAD')) return OK(SHA_B);
      return OK(SHA_A);
    };
    const verify = cappedVerify(1);

    const run = await runTask(
      request(root),
      deps(root, { git, verify: verify.runner, agent: cappedAgent(agentCommandResult(), 0).runner }),
    );

    expect(run.outcome).toBe('STATE_UNOBSERVABLE');
    // The first step landed; the second was never attempted, and no reviewer ran.
    expect(run.steps).toBe(1);
    expect(reload(root).state.state).toBe('REVIEWING');
  });
});

/* ═════════════ A / F-6 — the worktree Git vouched for, and no other ═════════ */

describe('execution authority comes from Git, never from the record', () => {
  it('cannot be redirected by a tampered persisted worktreePath', async () => {
    const root = repoRoot();
    const stolen = join(root, 'stolen');
    const before = persist(root, { worktreePath: stolen });
    const agent = cappedAgent(agentCommandResult(), 0);
    const verify = cappedVerify(0);

    // Git lists the *real* worktree; the state names a directory it does not.
    const run = await runTask(
      request(root),
      deps(root, {
        git: scriptedGit(root, { registry: OK(healthyRegistry(root)) }),
        agent: agent.runner,
        verify: verify.runner,
      }),
    );

    expect(run.outcome).toBe('STATE_DIVERGED');
    expect(run.reasonCodes).toContain('WORKTREE_NOT_REGISTERED');
    expect(agent.count()).toBe(0);
    expect(verify.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  it('refuses a registration that holds somebody else\u2019s branch', async () => {
    const root = repoRoot();
    const before = persist(root);
    const agent = cappedAgent(agentCommandResult(), 0);
    const verify = cappedVerify(0);

    const foreign = `worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktreeOf(root)}\nbranch refs/heads/agent/task-9999\n`;
    const run = await runTask(
      request(root),
      deps(root, {
        git: scriptedGit(root, { registry: OK(foreign) }),
        agent: agent.runner,
        verify: verify.runner,
      }),
    );

    expect(run.outcome).toBe('STATE_DIVERGED');
    expect(run.reasonCodes).toContain('WORK_BRANCH_NOT_CHECKED_OUT');
    expect(agent.count()).toBe(0);
    expect(verify.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  /**
   * The positive half, and the sharper one: Git prints POSIX-shaped paths even
   * on Windows, so the authorised path and the recorded path are routinely two
   * spellings of one directory. The spelling that reaches a `spawn` must be
   * Git's, and the comparison between the two must be by path identity — a
   * string equality here would refuse every Windows worktree instead.
   */
  it('runs every process in the path Git printed', async () => {
    const root = repoRoot();
    persist(root);
    const printed = worktreeOf(root).split('\\').join('/');
    const verify = scriptedVerify({ exitCode: 0 });
    const agent = scriptedAgent(
      agentCommandResult({ stdout: findingsReview() }),
      agentCommandResult({ stdout: claudeSuccessEnvelope() }),
    );

    const run = await runTask(
      request(root, { maxSteps: 3 }),
      deps(root, {
        git: scriptedGit(root, { registry: OK(healthyRegistry(root, printed)) }),
        verify: verify.runner,
        agent: agent.runner,
      }),
    );

    expect(run.outcome).toBe('STEP_BUDGET_EXHAUSTED');
    // All three phases ran, and none of them in the recorded spelling.
    expect(verify.calls).toHaveLength(1);
    expect(agent.calls.map((call) => call.agent)).toEqual(['codex', 'claude']);
    for (const cwd of [...verify.calls.map((c) => c.cwd), ...agent.calls.map((c) => c.cwd)]) {
      expect(cwd).toBe(printed);
    }
  });

  it('starts nothing when Git authorises no worktree at all', async () => {
    const root = repoRoot();
    persist(root);
    const agent = cappedAgent(agentCommandResult(), 0);
    const verify = cappedVerify(0);

    const run = await runTask(
      request(root),
      deps(root, {
        git: scriptedGit(root, { registry: OK('') }),
        agent: agent.runner,
        verify: verify.runner,
      }),
    );

    expect(['STATE_DIVERGED', 'EXECUTION_UNAUTHORISED']).toContain(run.outcome);
    expect(run.steps).toBe(0);
    expect(agent.count()).toBe(0);
    expect(verify.count()).toBe(0);
  });
});

/* ══════════════════════ D — a finished task is finished ═════════════════════ */

describe('a terminal task is never stepped again', () => {
  it('reports READY_FOR_PR as complete and runs nothing', async () => {
    const root = repoRoot();
    const before = persist(root, {
      state: 'READY_FOR_PR',
      reviewRound: 1,
      worktreeCleanAtCheckpoint: true,
    });
    const agent = cappedAgent(agentCommandResult(), 0);
    const verify = cappedVerify(0);

    const run = await runTask(
      request(root),
      deps(root, { agent: agent.runner, verify: verify.runner }),
    );

    expect(run.outcome).toBe('TASK_COMPLETED');
    expect(run.state).toBe('READY_FOR_PR');
    expect(run.steps).toBe(0);
    expect(agent.count()).toBe(0);
    expect(verify.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  /**
   * Terminality is judged before the world is, and that ordering is the point:
   * "your completed task diverged" is noise about something nobody is going to
   * continue, and it would send an operator to inspect a worktree they have
   * already finished with.
   */
  it('stays complete even when Git cannot be read', async () => {
    const root = repoRoot();
    persist(root, { state: 'READY_FOR_PR', reviewRound: 1, worktreeCleanAtCheckpoint: true });

    const run = await runTask(
      request(root),
      deps(root, { git: scriptedGit(root, { registry: UNAVAILABLE }) }),
    );

    expect(run.outcome).toBe('TASK_COMPLETED');
  });

  it('reports an abandoned task as aborted, not as blocked', async () => {
    const root = repoRoot();
    persist(root, { state: 'ABORTED' });

    const run = await runTask(request(root), deps(root));

    expect(run.outcome).toBe('TASK_ABORTED');
    expect(run.steps).toBe(0);
  });
});

/* ═════════════ E / F — the states only a human may move on ══════════════════ */

describe('the driver never grants itself an authority it does not have', () => {
  /**
   * `BLOCKED_VERIFY` is the one that matters most, because re-running a failed
   * verification is the single most plausible thing a driver would "helpfully"
   * do — and the refusal to leave that state is the only bound on
   * `VERIFYING → BLOCKED_VERIFY → REMEDIATING → VERIFYING`, a cycle
   * `maxReviewRounds` never touches.
   */
  it('does not retry a failed verification', async () => {
    const root = repoRoot();
    persist(root);
    const verify = cappedVerify(1);

    const run = await runTask(
      request(root),
      deps(root, {
        git: scriptedGit(root),
        verify: (async (command, args, cwd) => {
          await verify.runner(command, args, cwd);
          return Object.freeze({
            outcome: 'RAN' as const,
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: '',
            outputTruncated: false,
            failureCode: null,
            errnoCode: null,
            durationMs: 1,
          });
        }) satisfies VerificationRunner,
        agent: cappedAgent(agentCommandResult(), 0).runner,
      }),
    );

    expect(run.outcome).toBe('BLOCKED_VERIFY');
    // Exactly one verification, and no writer was handed the failure.
    expect(verify.count()).toBe(1);
    expect(reload(root).state.resumeFrom).toEqual({ phase: 'REMEDIATE', round: 1 });
  });

  it('leaves a standing BLOCKED_VERIFY exactly where it found it', async () => {
    const root = repoRoot();
    const before = persist(root, {
      state: 'BLOCKED_VERIFY',
      blockedAgent: null,
      resumeFrom: { phase: 'REMEDIATE', round: 1 },
    });
    const verify = cappedVerify(0);
    const agent = cappedAgent(agentCommandResult(), 0);

    const run = await runTask(
      request(root),
      deps(root, { verify: verify.runner, agent: agent.runner }),
    );

    expect(run.outcome).toBe('BLOCKED_VERIFY');
    expect(run.steps).toBe(0);
    expect(verify.count()).toBe(0);
    expect(agent.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  /**
   * The world here is as favourable as it can be — registry healthy, HEAD
   * where the record says, tree clean, auth re-proven, any reset long past —
   * and that is the whole test. A state that reconciles perfectly and is still
   * not continuable is precisely what "reconciling is not permission" means.
   */
  it.each([
    ['HUMAN_DECISION_REQUIRED', { phase: 'REMEDIATE', round: 1 }],
    ['BLOCKED_AUTH', { phase: 'REMEDIATE', round: 1 }],
  ] as const)('never automatically resumes %s', async (state, resumeFrom) => {
    const root = repoRoot();
    const before = persist(root, {
      state,
      blockedAgent: state === 'BLOCKED_AUTH' ? 'claude' : null,
      resumeFrom,
      reviewRound: 1,
      worktreeCleanAtCheckpoint: true,
      findingHistory: [DURABLE_FINDING],
    });
    const agent = cappedAgent(agentCommandResult(), 0);

    const run = await runTask(
      request(root),
      deps(root, { agent: agent.runner, verify: cappedVerify(0).runner }),
    );

    expect(run.reconciliation?.outcome).toBe('RECONCILED');
    expect(run.resume?.continuation).toBe('ATTENDED_ONLY');
    expect(run.outcome).toBe(state);
    expect(agent.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  it('refuses a quota resume the evidence does not support, and says which check denied it', async () => {
    const root = repoRoot();
    const before = persist(root, {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'REMEDIATE', round: 1 },
      // No reported reset time — the usual case, because no CLI reports one.
      reportedResetAt: null,
      reviewRound: 1,
      worktreeCleanAtCheckpoint: true,
    });
    const agent = cappedAgent(agentCommandResult(), 0);

    const run = await runTask(request(root), deps(root, { agent: agent.runner }));

    expect(run.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(run.reasonCodes).toContain('RESET_TIME_MISSING');
    expect(agent.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  /**
   * An in-flight task that reconciles is `ATTENDED_ONLY`, and the operator's
   * grant for this run is what supplies the missing half. Without it the driver
   * does nothing at all — the flag can only ever narrow what runs.
   */
  it('will not continue an in-flight task without an attended grant', async () => {
    const root = repoRoot();
    const before = persist(root);
    const verify = cappedVerify(0);

    const run = await runTask(
      request(root, { attendedContinuation: false }),
      deps(root, { verify: verify.runner, agent: cappedAgent(agentCommandResult(), 0).runner }),
    );

    expect(run.outcome).toBe('CONTINUATION_NOT_AUTHORISED');
    expect(run.reasonCodes).toContain('ATTENDED_CONTINUATION_NOT_GRANTED');
    expect(verify.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });
});

/* ══════════════════ L / C — resuming a quota pause, honestly ════════════════ */

describe('an authorised quota resume', () => {
  const RESET_PASSED = '2026-08-10T08:00:00.000Z';

  it('re-enters the phase that was interrupted and spends the resume evidence', async () => {
    const root = repoRoot();
    persist(root, {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'REMEDIATE', round: 1 },
      reportedResetAt: RESET_PASSED,
      reviewRound: 1,
      currentCommit: SHA_B,
      worktreeCleanAtCheckpoint: true,
      findingHistory: [DURABLE_FINDING],
    });
    const agent = scriptedAgent(agentCommandResult({ stdout: claudeSuccessEnvelope() }));

    const run = await runTask(
      request(root, { maxSteps: 2 }),
      deps(root, { agent: agent.runner, verify: cappedVerify(0).runner }),
    );

    // The resume itself is one durable step; the remediation pass is the next.
    expect(run.steps).toBe(2);
    const after = reload(root).state;
    expect(after.state).toBe('VERIFYING');

    // The phase the block named is the phase that ran, and the agent that was
    // blocked is the agent that was started.
    expect(agent.calls.map((call) => call.agent)).toEqual(['claude']);

    // C: the pause is over, so nothing describing it survives into the work.
    expect(after.resumeFrom).toBeNull();
    expect(after.reportedResetAt).toBeNull();
    expect(after.blockedAgent).toBeNull();
    // The evidence that is *not* about the pause is carried through untouched.
    expect(after.findingHistory).toEqual([DURABLE_FINDING]);
    expect(after.reviewRound).toBe(1);
  });

  /**
   * The sharpest half of the stale-metadata rule: an elapsed reset time that
   * survived into the work loop would sit there until the task blocked again,
   * and would then be read as "the quota has already cleared" for a block that
   * reported nothing of the kind — a governed pause turned into a timer.
   */
  it('cannot let a spent reset time authorise the next block', async () => {
    const root = repoRoot();
    persist(root, {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'REMEDIATE', round: 1 },
      reportedResetAt: RESET_PASSED,
      reviewRound: 1,
      currentCommit: SHA_B,
      worktreeCleanAtCheckpoint: true,
      findingHistory: [DURABLE_FINDING],
    });
    // The resumed writer immediately hits the quota again, and this time the
    // CLI reports no reset instant.
    const refusal = agentCommandResult({
      exitCode: 1,
      stdout: JSON.stringify({ type: 'result', is_error: true, api_error_status: 429 }),
    });
    const agent = cappedAgent(refusal, 1);

    const first = await runTask(
      request(root, { maxSteps: 4 }),
      deps(root, { agent: agent.runner, verify: cappedVerify(0).runner }),
    );

    expect(first.outcome).toBe('BLOCKED_USAGE_LIMIT');
    const after = reload(root).state;
    expect(after.state).toBe('BLOCKED_USAGE_LIMIT');
    // Not the instant the *previous* block carried.
    expect(after.reportedResetAt).toBeNull();

    // A second run therefore has nothing to resume on, and starts no agent.
    const second = await runTask(
      request(root, { maxSteps: 4 }),
      deps(root, { agent: cappedAgent(refusal, 0).runner, verify: cappedVerify(0).runner }),
    );

    expect(second.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(second.reasonCodes).toContain('RESET_TIME_MISSING');
    expect(second.steps).toBe(0);
  });

  it('leaves no resume evidence anywhere along a full driven cycle', async () => {
    const root = repoRoot();
    persist(root, {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'REVIEW', round: 1 },
      reportedResetAt: RESET_PASSED,
      reviewRound: 0,
      currentCommit: SHA_B,
      worktreeCleanAtCheckpoint: true,
    });
    const agent = scriptedAgent(
      agentCommandResult({ stdout: findingsReview() }),
      agentCommandResult({ stdout: claudeSuccessEnvelope() }),
    );
    const seen: (string | null)[] = [];

    // Step the run one durable write at a time, inspecting the disk between
    // each: an assertion only on the final state would miss a field that was
    // carried through three phases and cleared by the fourth.
    for (let step = 0; step < 4; step += 1) {
      const run = await runTask(
        request(root, { maxSteps: 1 }),
        deps(root, { agent: agent.runner, verify: scriptedVerify({ exitCode: 0 }).runner }),
      );
      if (run.steps === 0) break;
      const after = reload(root).state;
      seen.push(after.state);
      expect(after.resumeFrom).toBeNull();
      expect(after.reportedResetAt).toBeNull();
    }

    expect(seen).toEqual(['REVIEWING', 'REMEDIATING', 'VERIFYING', 'REVIEWING']);
  });
});

/* ══════════════ B — remediation needs a cause that survived ═════════════════ */

describe('remediation is never started on invented evidence', () => {
  it.each([
    ['no findings at all', [] as { round: number; severity: 'high'; fingerprint: string }[], 1],
    ['findings from another round only', [{ ...DURABLE_FINDING, round: 1 }], 2],
  ])('refuses to start a writer with %s', async (_label, findingHistory, reviewRound) => {
    const root = repoRoot();
    const agent = cappedAgent(agentCommandResult(), 0);
    persist(root, {
      state: 'REMEDIATING',
      reviewRound,
      findingHistory,
      worktreeCleanAtCheckpoint: false,
      currentCommit: SHA_B,
    });

    const run = await runTask(
      request(root, { maxSteps: 2 }),
      deps(root, { agent: agent.runner, verify: cappedVerify(0).runner }),
    );

    expect(run.outcome).toBe('HUMAN_DECISION_REQUIRED');
    // The point of the test: no writer was started against a brief that would
    // have claimed a review reported findings and then listed none.
    expect(agent.count()).toBe(0);
    const after = reload(root).state;
    expect(after.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(after.state).not.toBe('VERIFYING');
    expect(after.resumeFrom).toEqual({ phase: 'REMEDIATE', round: reviewRound });
  });

  it('does start one on the durable record of this round, and says the detail is gone', async () => {
    const root = repoRoot();
    const agent = scriptedAgent(agentCommandResult({ stdout: claudeSuccessEnvelope() }));
    persist(root, {
      state: 'REMEDIATING',
      reviewRound: 1,
      findingHistory: [DURABLE_FINDING],
      worktreeCleanAtCheckpoint: false,
      currentCommit: SHA_B,
    });

    const run = await runTask(
      request(root, { maxSteps: 1 }),
      deps(root, { agent: agent.runner, verify: cappedVerify(0).runner }),
    );

    expect(run.steps).toBe(1);
    expect(reload(root).state.state).toBe('VERIFYING');
    const payload = agent.calls[0]?.payload ?? '';
    expect(payload).toContain('did not survive');
    expect(payload).toContain(DURABLE_FINDING.fingerprint);
    expect(payload).not.toMatch(/FINDINGS \(0;/);
  });

  /**
   * The live brief is built from one review's `path` and `rule`, which are
   * never persisted. Carrying it anywhere other than the single edge that
   * produced it would brief a writer on work that is not in front of it, so the
   * driver drops it the moment the step it belongs to is over.
   */
  it('hands the live brief to the pass that earned it, and no other', async () => {
    const root = repoRoot();
    persist(root, { state: 'REVIEWING', reviewRound: 0, currentCommit: SHA_B });
    const agent = scriptedAgent(
      agentCommandResult({ stdout: findingsReview() }),
      agentCommandResult({ stdout: claudeSuccessEnvelope() }),
    );

    const run = await runTask(
      request(root, { maxSteps: 2 }),
      deps(root, { agent: agent.runner, verify: cappedVerify(0).runner }),
    );

    expect(run.steps).toBe(2);
    const writerPayload = agent.calls[1]?.payload ?? '';
    // The precise brief, naming the file — not the degraded durable one.
    expect(writerPayload).toContain('src/agent/claude-writer.ts');
    expect(writerPayload).not.toContain('did not survive');
  });
});

/* ═══════════ G / K / H — writes, crashes and the absence of progress ════════ */

describe('a refused write stops the run', () => {
  it('terminates on a compare-and-swap conflict without deciding twice', async () => {
    const root = repoRoot();
    const current = persist(root, { state: 'REVIEWING', reviewRound: 0, currentCommit: SHA_B });
    let agentCalls = 0;

    // A competitor lands inside the driver's decision window: after the state
    // was read, before the conclusion drawn from it is persisted.
    const agent: AgentRunner = async () => {
      agentCalls += 1;
      const competitor = saveTaskState(
        { ...current.state, stateEnteredAt: '2026-08-10T07:00:00.000Z' },
        { repositoryRoot: root, expectedRevision: current.revision },
      );
      if (!competitor.ok) throw new Error(`competitor did not land: ${competitor.code}`);
      return agentCommandResult({ stdout: findingsReview() });
    };

    const run = await runTask(
      request(root, { maxSteps: 6 }),
      deps(root, { agent, verify: cappedVerify(0).runner }),
    );

    expect(run.outcome).toBe('STATE_CONFLICT');
    expect(run.reasonCodes).toContain('STATE_CONFLICT');
    expect(run.steps).toBe(0);
    // The reviewer ran once. A driver that re-read the state and tried again
    // would have spent a second review to launder the refusal.
    expect(agentCalls).toBe(1);
    expect(reload(root).state.state).toBe('REVIEWING');
    expect(reload(root).state.reviewRound).toBe(0);
  });

  it('reports a write that never reached the disk as unrecorded, not as blocked', async () => {
    const root = repoRoot();
    const before = persist(root);
    const replace: ReplaceFn = () => {
      throw new Error('crash between the decision and the write');
    };

    const run = await runTask(
      request(root),
      deps(root, { verify: scriptedVerify({ exitCode: 0 }).runner, replace }),
    );

    expect(run.outcome).toBe('STATE_NOT_RECORDED');
    expect(run.reasonCodes).toContain('WRITE_FAILED');
    expect(run.steps).toBe(0);
    // The durable state still says what it said. That is the whole distinction:
    // an unrecorded block is a task whose record claims it is still running.
    expect(reload(root).revision).toBe(before.revision);
    expect(reload(root).state.state).toBe('VERIFYING');
  });

  /**
   * K: a crashed step may repeat an external side effect — that is the price of
   * running subprocesses — but it must never leave durable progress behind that
   * did not happen. The second run re-runs the *same* phase, and the round it
   * consumes is the round it was always going to consume.
   */
  it('re-runs the interrupted phase after a crash rather than skipping it', async () => {
    const root = repoRoot();
    persist(root, { state: 'REVIEWING', reviewRound: 0, currentCommit: SHA_B });
    const crashing: ReplaceFn = () => {
      throw new Error('crash');
    };
    const first = scriptedAgent(agentCommandResult({ stdout: findingsReview() }));

    const crashed = await runTask(
      request(root, { maxSteps: 1 }),
      deps(root, { agent: first.runner, replace: crashing }),
    );

    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
    expect(first.calls).toHaveLength(1);
    const after = reload(root).state;
    expect(after.state).toBe('REVIEWING');
    expect(after.reviewRound).toBe(0);
    expect(after.findingHistory).toEqual([]);

    // The restart. Same phase, same round — the interrupted review was not a
    // completed one, and nothing pretends it was.
    const second = scriptedAgent(agentCommandResult({ stdout: findingsReview() }));
    const resumed = await runTask(
      request(root, { maxSteps: 1 }),
      deps(root, { agent: second.runner }),
    );

    expect(resumed.steps).toBe(1);
    expect(second.calls).toHaveLength(1);
    const finished = reload(root).state;
    expect(finished.state).toBe('REMEDIATING');
    expect(finished.reviewRound).toBe(1);
    expect(finished.findingHistory).toHaveLength(1);
  });
});

describe('progress is the durable state moving, not a step saying so', () => {
  /**
   * H, and the reason the guard is measured on bytes: a `replace` that silently
   * does nothing produces a `SAVED` result over a file that never changed, so
   * every step reports `ADVANCED` while the task stands still. A driver that
   * trusted the outcome would spend its whole budget here.
   */
  it('stops when an iteration leaves the state exactly as it found it', async () => {
    const root = repoRoot();
    persist(root);
    let writes = 0;
    const replace: ReplaceFn = (from, to) => {
      writes += 1;
      if (writes > 1) return;
      renameSync(from, to);
    };
    const verify = cappedVerify(4);

    const run = await runTask(
      request(root, { maxSteps: 20 }),
      deps(root, {
        verify: verify.runner,
        agent: cappedAgent(agentCommandResult({ stdout: findingsReview() }), 4).runner,
        replace,
      }),
    );

    expect(run.outcome).toBe('NO_PROGRESS');
    expect(run.reasonCodes).toContain('DURABLE_STATE_UNCHANGED');
    // Far short of the budget: the run stopped on the evidence, not on the bound.
    expect(run.steps).toBeLessThan(5);
  });

  it.each([
    ['SCOPE_VIOLATION', 'SCOPE_VIOLATION'],
    ['RESUME_STATE_DIVERGED', 'RESUME_STATE_DIVERGED'],
  ] as const)('parks on %s without running or writing anything', async (state, outcome) => {
    const root = repoRoot();
    const before = persist(root, { state, blockedAgent: null, resumeFrom: null });
    const agent = cappedAgent(agentCommandResult(), 0);

    const run = await runTask(
      request(root),
      deps(root, { agent: agent.runner, verify: cappedVerify(0).runner }),
    );

    expect(run.outcome).toBe(outcome);
    expect(run.steps).toBe(0);
    expect(agent.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  it('reports a state the loop does not drive as no progress, once', async () => {
    const root = repoRoot();
    const before = persist(root, { state: 'IMPLEMENTING', currentCommit: SHA_B });
    const agent = cappedAgent(agentCommandResult(), 0);
    const verify = cappedVerify(0);

    const run = await runTask(
      request(root, { maxSteps: 10 }),
      deps(root, { agent: agent.runner, verify: verify.runner }),
    );

    expect(run.outcome).toBe('NO_PROGRESS');
    expect(run.steps).toBe(0);
    expect(agent.count()).toBe(0);
    expect(verify.count()).toBe(0);
    expect(reload(root).revision).toBe(before.revision);
  });

  it('refuses a step budget that is not a positive whole number', async () => {
    const root = repoRoot();
    persist(root);

    for (const maxSteps of [0, -1, 1.5, Number.NaN]) {
      const run = await runTask(
        request(root, { maxSteps }),
        deps(root, { agent: cappedAgent(agentCommandResult(), 0).runner, verify: cappedVerify(0).runner }),
      );
      expect(run.outcome).toBe('NO_PROGRESS');
      expect(run.reasonCodes).toContain('STEP_BUDGET_INVALID');
    }
  });

  it('hands back an exhausted budget as the one outcome that means "call again"', async () => {
    const root = repoRoot();
    persist(root);

    const run = await runTask(
      request(root, { maxSteps: 1 }),
      deps(root, { verify: scriptedVerify({ exitCode: 0 }).runner }),
    );

    expect(run.outcome).toBe('STEP_BUDGET_EXHAUSTED');
    expect(run.steps).toBe(1);
    expect(reload(root).state.state).toBe('REVIEWING');
  });

  it('reports a task that has never run as not started, and creates nothing', async () => {
    const root = repoRoot();

    const run = await runTask(
      request(root),
      deps(root, { agent: cappedAgent(agentCommandResult(), 0).runner, verify: cappedVerify(0).runner }),
    );

    expect(run.outcome).toBe('TASK_NOT_STARTED');
    expect(run.steps).toBe(0);
    expect(loadTaskState(root, TASK_ID).ok).toBe(false);
  });
});

/* ═══════════════════ I — the queue, and what it may not do ══════════════════ */

describe('task selection', () => {
  const taskFile = (id: string, status: string, dependsOn: readonly string[] = []) =>
    [
      '---',
      `id: ${id}`,
      `title: task ${id}`,
      `status: ${status}`,
      'kind: NORMAL',
      'priority: NORMAL',
      'currentFocus: false',
      dependsOn.length === 0
        ? 'dependsOn: []'
        : ['dependsOn:', ...dependsOn.map((value) => `  - ${value}`)].join('\n'),
      '---',
      '',
      'Prose a plan never reads.',
      '',
    ].join('\n');

  it('never selects a task whose dependency is unfinished', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: {
        'tasks/AA-1.md': taskFile('AA-1', 'OPEN'),
        'tasks/AA-2.md': taskFile('AA-2', 'OPEN', ['AA-1']),
      },
    });
    const resolved = await resolveFixture(root);

    const selection = selectRunTask(resolved);

    expect(selection.code).toBe('TASK_SELECTED');
    expect(selection.task?.id).toBe('AA-1');
    // The dependant is present in the reasoning and absent from the ranking.
    const planned = selection.planning;
    if (!planned.ok) throw new Error(`planning failed: ${planned.code}`);
    expect(planned.selection.ranking).toEqual(['AA-1']);
    const blocked = planned.selection.eligibility.find((entry) => entry.taskId === 'AA-2');
    expect(blocked?.reason).toBe('BLOCKED_BY_DEPENDENCIES');
    expect(blocked?.unsatisfiedDependencies).toEqual(['AA-1']);
  });

  /**
   * A dependant becomes selectable when the *repository* says its dependency is
   * done, and never because a run of that dependency finished. Nothing in this
   * build writes `status: DONE`, and `READY_FOR_PR` is terminal precisely
   * because a human takes the task from there.
   */
  it('follows the repository, not a previous run, in deciding what is finished', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: {
        'tasks/AA-1.md': taskFile('AA-1', 'DONE'),
        'tasks/AA-2.md': taskFile('AA-2', 'OPEN', ['AA-1']),
      },
    });
    const resolved = await resolveFixture(root);

    const selection = selectRunTask(resolved);

    expect(selection.code).toBe('TASK_SELECTED');
    expect(selection.task?.id).toBe('AA-2');
  });

  it('says why there is nothing to do, and names the tasks it means', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'tasks/AA-1.md': taskFile('AA-1', 'DONE') },
    });
    const resolved = await resolveFixture(root);

    const selection = selectRunTask(resolved);

    expect(selection.code).toBe('ALL_TASKS_COMPLETE');
    expect(selection.task).toBeNull();
    expect(selection.reasonCodes).toEqual(['AA-1']);
  });

  it('reports an unreadable plan as a planning failure, never as finished work', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: {},
    });
    const resolved = await resolveFixture(root);

    const selection = selectRunTask(resolved);

    expect(selection.code).toBe('PLANNING_FAILED');
    expect(selection.code).not.toBe('ALL_TASKS_COMPLETE');
    expect(selection.reasonCodes).toEqual(['TASK_SOURCE_NOT_FOUND']);
  });

  it('drives nothing when the selector has nothing to give', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'tasks/AA-1.md': taskFile('AA-1', 'DONE') },
    });
    const resolved = await resolveFixture(root);

    const outcome = await runNextTask(
      {
        repository: resolved,
        taskBrief: (task) => task.title,
        attendedContinuation: true,
        authPreflightPassed: true,
        maxSteps: 4,
      },
      {
        now: tickingClock(),
        git: scriptedGit(resolved.root),
        agent: cappedAgent(agentCommandResult(), 0).runner,
        verify: cappedVerify(0).runner,
      },
    );

    expect(outcome.selection.code).toBe('ALL_TASKS_COMPLETE');
    expect(outcome.run).toBeNull();
  });
});

/* ══════════════════════════ the vocabulary itself ═══════════════════════════ */

describe('the outcome vocabulary', () => {
  it('keeps every authority boundary as its own member', () => {
    // Not a tautology: the assertion is that these are *distinct*, because the
    // failure this vocabulary exists to prevent is a driver that answers "it
    // stopped" and leaves an operator to guess which of five reasons applied.
    expect(new Set(RUN_OUTCOMES).size).toBe(RUN_OUTCOMES.length);
    for (const required of [
      'BLOCKED_USAGE_LIMIT',
      'BLOCKED_VERIFY',
      'HUMAN_DECISION_REQUIRED',
      'STATE_DIVERGED',
      'STATE_UNOBSERVABLE',
      'STATE_CONFLICT',
      'STATE_NOT_RECORDED',
      'CONTINUATION_NOT_AUTHORISED',
      'EXECUTION_UNAUTHORISED',
      'NO_PROGRESS',
      'TASK_COMPLETED',
      'STEP_BUDGET_EXHAUSTED',
    ]) {
      expect(RUN_OUTCOMES).toContain(required);
    }
  });

  it('offers no member a caller could read as permission to continue', () => {
    for (const outcome of RUN_OUTCOMES) {
      expect(outcome).not.toMatch(/RESUME_READY|RETRY|AUTOMATIC_ALLOWED|OK$/);
    }
  });

  it('never returns a state file it did not read', async () => {
    const root = repoRoot();
    const run = await runTask(request(root), deps(root));
    expect(run.state).toBeNull();
    expect(readFileSync).toBeDefined();
  });
});
