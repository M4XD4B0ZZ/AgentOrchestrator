/**
 * The setup hops and the implement pass (V2-04).
 *
 * Three steps arrive together because they are one missing link: `startTask`
 * writes `WORKTREE_READY`, and until now nothing moved a task off it. The
 * suite therefore ends with the thing that could not be written before — a
 * task created by production code and driven, by production code, into
 * `VERIFYING`.
 *
 * Real repositories, real worktrees, real state files. The Claude boundary
 * stays injected: it is a subscription CLI and no test may start one.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  runWorktreeReadyStep,
  runContextLoadingStep,
  runImplementStep,
  runLoopStep,
  isLoopDrivenState,
  type LoopDependencies,
} from '../src/loop/loop-step.js';
import { buildImplementPayload } from '../src/loop/implement-payload.js';
import { MAX_AGENT_PAYLOAD_CHARS } from '../src/loop/payload-budget.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';
import { startTask } from '../src/run/start-task.js';
import { runTask } from '../src/run/run-driver.js';
import { loadTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { authPreflightPasses, provenAuthEvidence } from './helpers/auth-evidence.js';
import { createRepoFixture, removeRepoFixtures, writeRepoFile } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture } from './helpers/worktree-fixtures.js';
import {
  e2eProfile,
  recordedAgent,
  recordedVerify,
  taskFile,
  tickingClock,
  usageLimitResult,
  writerSuccess,
} from './helpers/e2e-fixtures.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';

afterEach(() => {
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

// Real evidence from the real mint; see `helpers/auth-evidence.ts`.
const authPassed = authPreflightPasses;

/** A repository whose runtime directory is ignored, with one startable task. */
async function readyRepo(
  body = 'Do the described thing.',
): Promise<{ repository: ResolvedRepository; root: string }> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      'tasks/V2-04.md': [
        '---',
        'id: V2-04',
        'title: implement me',
        'status: OPEN',
        'kind: NORMAL',
        'priority: NORMAL',
        'currentFocus: true',
        'dependsOn: []',
        '---',
        body,
      ].join('\n'),
    },
  });
  return { repository: await resolveFixture(root), root };
}

/** Starts the task through production code and returns its durable state. */
async function startedAt(
  repository: ResolvedRepository,
  root: string,
): Promise<StateLoadSuccess> {
  const result = await startTask(
    { repository, taskId: 'V2-04' },
    { git: runGitCommand, now: tickingClock(), authPreflight: authPassed },
  );
  expect(result.outcome).toBe('STARTED');
  const loaded = loadTaskState(root, 'V2-04');
  if (!loaded.ok) throw new Error('task did not start');
  return loaded;
}

function stepDeps(
  current: StateLoadSuccess,
  repository: ResolvedRepository,
  overrides: Partial<LoopDependencies> = {},
): LoopDependencies {
  return {
    repositoryRoot: current.state.repositoryRoot,
    now: '2026-08-11T09:00:00.000Z',
    authorisedWorktreePath: current.state.worktreePath,
    verification: repository.verification,
    taskBrief: 'unused by these steps',
    brief: readExecutionBrief(repository, current.state.taskId, current.state.worktreePath),
    ...overrides,
  };
}

describe('WORKTREE_READY → CONTEXT_LOADING', () => {
  it('advances a started task, and starts nothing', async () => {
    const { repository, root } = await readyRepo();
    const current = await startedAt(repository, root);
    expect(current.state.state).toBe('WORKTREE_READY');

    const step = await runWorktreeReadyStep(current, stepDeps(current, repository));

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('CONTEXT_LOADING');

    const after = loadTaskState(root, 'V2-04');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // One durable write, and it changed exactly two fields. A hop that starts
    // nothing must not quietly restate anything else about the task.
    expect(after.state.state).toBe('CONTEXT_LOADING');
    expect(after.state.stateEnteredAt).toBe('2026-08-11T09:00:00.000Z');
    expect({ ...after.state, state: null, stateEnteredAt: null }).toEqual({
      ...current.state,
      state: null,
      stateEnteredAt: null,
    });
    // The checkpoint a fresh workspace carries is preserved, not withdrawn:
    // nothing has run, so the tree really is clean at its base commit. Both
    // facts are what `reconcile.ts` checks the record against — a state that
    // claims them is checked against them directly, rather than falling back
    // to the phase expectation for records that claim nothing.
    expect(after.state.worktreeCleanAtCheckpoint).toBe(true);
    expect(after.state.currentCommit).toBe(current.state.basePinnedCommit);
  });

  it('refuses a caller whose authority is for a different worktree', async () => {
    const { repository, root } = await readyRepo();
    const current = await startedAt(repository, root);

    const step = await runWorktreeReadyStep(
      current,
      stepDeps(current, repository, { authorisedWorktreePath: 'D:/somewhere/else' }),
    );

    expect(step.outcome).toBe('EXECUTION_UNAUTHORISED');
    expect(step.save).toBeNull();
  });

  it('is not applicable to any other state', async () => {
    const { repository, root } = await readyRepo();
    const current = await startedAt(repository, root);
    const advanced = await runWorktreeReadyStep(current, stepDeps(current, repository));
    expect(advanced.outcome).toBe('ADVANCED');

    const now = loadTaskState(root, 'V2-04');
    if (!now.ok) throw new Error('unreadable');
    expect((await runWorktreeReadyStep(now, stepDeps(now, repository))).outcome).toBe(
      'NOT_APPLICABLE',
    );
  });
});

describe('CONTEXT_LOADING → IMPLEMENTING', () => {
  async function atContextLoading(body?: string) {
    const { repository, root } = await readyRepo(body);
    let current = await startedAt(repository, root);
    await runWorktreeReadyStep(current, stepDeps(current, repository));
    const loaded = loadTaskState(root, 'V2-04');
    if (!loaded.ok) throw new Error('unreadable');
    current = loaded;
    return { repository, root, current };
  }

  it('enters IMPLEMENTING with the checkpoint withdrawn', async () => {
    const { repository, root, current } = await atContextLoading();

    const step = await runContextLoadingStep(current, stepDeps(current, repository));

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('IMPLEMENTING');

    const after = loadTaskState(root, 'V2-04');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // The single most costly mistake available here: carrying a clean
    // checkpoint into a phase whose whole purpose is to dirty the worktree
    // makes the writer's own work reconcile as RESUME_STATE_DIVERGED, which
    // nothing resumes.
    expect(after.state.worktreeCleanAtCheckpoint).toBe(false);
    expect(after.state.currentCommit).toBeNull();
    // And the review budget is untouched: no review has happened.
    expect(after.state.reviewRound).toBe(0);
  });

  it('parks for a human when the repository gave the task no prose', async () => {
    const { repository, root, current } = await atContextLoading();
    // Empty the body after the task was started, as a human edit would.
    writeRepoFile(
      root,
      'tasks/V2-04.md',
      ['---', 'id: V2-04', 'title: t', 'status: OPEN', 'kind: NORMAL', 'priority: NORMAL', 'currentFocus: true', 'dependsOn: []', '---', ''].join('\n'),
    );

    const step = await runContextLoadingStep(current, stepDeps(current, repository));

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');

    const after = loadTaskState(root, 'V2-04');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // Named so a human who fixes the file resumes into the pass it was
    // heading for, not back into loading.
    expect(after.state.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });
  });

  it('parks when a declared context source cannot be opened', async () => {
    // The gap two review lenses found: `readTaskBrief` reports a missing
    // declared source on a *successful* brief, as a per-source status, so a
    // step that only asked `brief.ok` advanced and briefed the agent with a
    // path that is not there. The profile declares README.md; delete it.
    const { repository, root, current } = await atContextLoading();
    // Removed from the **worktree**, which is the tree the agent opens and the
    // tree the verdict is about. Deleting it from the source checkout instead
    // � which is what this test did until the V2-02 remediation � proved
    // nothing about the run, and the gate correctly ignores it now.
    rmSync(join(current.state.worktreePath, 'README.md'));
    expect(existsSync(join(root, 'README.md'))).toBe(true);

    const briefNow = readExecutionBrief(repository, 'V2-04', current.state.worktreePath);
    // Still "ok" — the task file is fine. Only the context is incomplete.
    expect(briefNow.ok).toBe(true);
    if (!briefNow.ok) return;
    expect(briefNow.brief.contextComplete).toBe(false);

    const step = await runContextLoadingStep(current, stepDeps(current, repository));

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('parks rather than proceeding when the caller supplied no brief at all', async () => {
    const { repository, current } = await atContextLoading();
    const deps = stepDeps(current, repository);
    const { brief: _dropped, ...withoutBrief } = deps;

    const step = await runContextLoadingStep(current, withoutBrief as LoopDependencies);

    // Fail closed: a writing agent briefed with nothing is the failure this
    // layer exists to prevent, so a caller's omission parks the task rather
    // than being papered over.
    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
  });
});

describe('IMPLEMENTING → VERIFYING', () => {
  async function atImplementing(body?: string) {
    const { repository, root } = await readyRepo(body);
    let current = await startedAt(repository, root);
    await runWorktreeReadyStep(current, stepDeps(current, repository));
    let loaded = loadTaskState(root, 'V2-04');
    if (!loaded.ok) throw new Error('unreadable');
    current = loaded;
    await runContextLoadingStep(current, stepDeps(current, repository));
    loaded = loadTaskState(root, 'V2-04');
    if (!loaded.ok) throw new Error('unreadable');
    return { repository, root, current: loaded };
  }

  it('runs the writer in the authorised worktree and enters VERIFYING', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      stepDeps(current, repository, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('VERIFYING');
    expect(agent.countFor('claude')).toBe(1);
    // The directory Git vouched for, never the one the record merely claims.
    expect(agent.calls[0]?.cwd).toBe(current.state.worktreePath);
    // The prompt is the repository's own words.
    expect(agent.calls[0]?.payload).toContain('Do the described thing.');

    const after = loadTaskState(root, 'V2-04');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.state.state).toBe('VERIFYING');
    expect(after.state.worktreeCleanAtCheckpoint).toBe(false);
    expect(after.state.currentCommit).toBeNull();
    // A writer that finished is not a task that finished, and not a review.
    expect(after.state.reviewRound).toBe(0);
    expect(step.remediationPayload).toBeNull();
  });

  it('records a quota interruption as a resumable block, naming IMPLEMENT', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({ claude: () => usageLimitResult() });

    const step = await runImplementStep(
      current,
      stepDeps(current, repository, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('BLOCKED_USAGE_LIMIT');

    const after = loadTaskState(root, 'V2-04');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.state.blockedAgent).toBe('claude');
    expect(after.state.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });
    // Never invented: no CLI observed by this build reports a reset time.
    expect(after.state.reportedResetAt).toBeNull();
  });

  it('refuses a caller whose authority is for a different worktree', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      stepDeps(current, repository, {
        agent: agent.runner,
        authorisedWorktreePath: 'D:/somewhere/else',
      }),
    );

    expect(step.outcome).toBe('EXECUTION_UNAUTHORISED');
    // Nothing started: the refusal precedes the writer.
    expect(agent.countFor('claude')).toBe(0);
  });

  it('parks without starting a writer when the brief became unreadable', async () => {
    const { repository, root, current } = await atImplementing();
    writeRepoFile(root, 'tasks/V2-04.md', 'no frontmatter at all\n');
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      stepDeps(current, repository, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(agent.countFor('claude')).toBe(0);
  });

  it('parks without starting a writer when declared context vanished mid-run', async () => {
    // Re-checked here and not merely inherited from `CONTEXT_LOADING`: a
    // restarted driver enters this step directly, so the same conjunction has
    // to hold at both entry points.
    const { repository, current } = await atImplementing();
    rmSync(join(current.state.worktreePath, 'README.md'));
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      stepDeps(current, repository, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(agent.countFor('claude')).toBe(0);
  });
});

describe('the dispatch advertises what it drives', () => {
  it('drives the three new states through runLoopStep', async () => {
    const { repository, root } = await readyRepo();
    const current = await startedAt(repository, root);

    for (const state of ['WORKTREE_READY', 'CONTEXT_LOADING', 'IMPLEMENTING'] as const) {
      expect(isLoopDrivenState(state)).toBe(true);
    }

    // Dispatched on the durable state, not on anything a caller says.
    const step = await runLoopStep(current, stepDeps(current, repository));
    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('CONTEXT_LOADING');
  });
});

describe('buildImplementPayload', () => {
  it('names context sources instead of pasting them', async () => {
    const { repository, root } = await readyRepo();
    // Started first: writing into the source checkout before preparing the
    // workspace leaves it dirty, and `prepareTaskWorkspace` refuses that.
    const started = await startedAt(repository, root);
    writeRepoFile(started.state.worktreePath, 'README.md', 'CANARY-README-BODY\n');
    const brief = readExecutionBrief(repository, 'V2-04', started.state.worktreePath);
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;

    const payload = buildImplementPayload(brief.brief, 1);

    expect(payload).toContain('README.md');
    expect(payload).not.toContain('CANARY-README-BODY');
    expect(payload).toContain('Do the described thing.');
  });

  it('is deterministic and bounded', async () => {
    const { repository, root } = await readyRepo('x'.repeat(40_000));
    const started = await startedAt(repository, root);
    const brief = readExecutionBrief(repository, 'V2-04', started.state.worktreePath);
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;

    const once = buildImplementPayload(brief.brief, 2);
    expect(buildImplementPayload(brief.brief, 2)).toBe(once);
    expect(once).toContain('pass 2');
    // At or under the budget, marker included — not "roughly". The earlier
    // form allowed a slack of 32 characters, which passed with the clamp
    // deleted entirely, because the body is capped upstream at 8 192.
    expect(once.length).toBeLessThanOrEqual(MAX_AGENT_PAYLOAD_CHARS);
  });

  it('clamps a payload that really does exceed the budget, marker included', async () => {
    const { repository, root } = await readyRepo();
    const started = await startedAt(repository, root);
    const brief = readExecutionBrief(repository, 'V2-04', started.state.worktreePath);
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;

    // The body is capped at 8 192 by the reader, so no repository can push a
    // payload past the ceiling through prose alone. Context sources are the
    // axis that can: the profile may declare many, and each contributes a line.
    const many = {
      ...brief.brief,
      contextSources: Array.from({ length: 4_000 }, (_unused, index) => ({
        path: `docs/generated/source-${index}.md`,
        status: 'PRESENT' as const,
      })),
    };

    const payload = buildImplementPayload(many, 1);

    expect(payload.length).toBe(MAX_AGENT_PAYLOAD_CHARS);
    expect(payload.endsWith('[truncated]')).toBe(true);
  });

  it('says so when the task text was truncated', async () => {
    const { repository, root } = await readyRepo('y'.repeat(20_000));
    const started = await startedAt(repository, root);
    const brief = readExecutionBrief(repository, 'V2-04', started.state.worktreePath);
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.brief.bodyTruncated).toBe(true);
    expect(buildImplementPayload(brief.brief, 1)).toContain('truncated');
  });
});

describe('a task created by production code now runs', () => {
  it('drives WORKTREE_READY to VERIFYING through the run driver alone', async () => {
    const { repository, root } = await readyRepo();
    const start = await startTask(
      { repository, taskId: 'V2-04' },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPassed },
    );
    expect(start.outcome).toBe('STARTED');

    const agent = recordedAgent({ claude: () => writerSuccess() });
    const verify = recordedVerify();

    // Three durable moves: the two setup hops and the implement pass. The
    // budget stops it at VERIFYING so this case stays about V2-04's link
    // rather than re-testing the verify/review loop.
    const run = await runTask(
      {
        repository,
        taskId: 'V2-04',
        taskBrief: 'unused: the implement step reads the repository',
        attendedContinuation: true,
        authEvidence: provenAuthEvidence(),
        maxSteps: 3,
      },
      { now: tickingClock(), git: runGitCommand, agent: agent.runner, verify: verify.runner },
    );

    expect(run.steps).toBe(3);
    expect(agent.countFor('claude')).toBe(1);

    const after = loadTaskState(root, 'V2-04');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.state.state).toBe('VERIFYING');
    // Before V2-04 this sequence was impossible: `startTask` produced a state
    // the loop refused to drive, and the run stopped at NO_PROGRESS.
    expect(readFileSync(after.path, 'utf8')).toContain('"state": "VERIFYING"');
  });
});

