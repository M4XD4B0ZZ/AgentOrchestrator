/**
 * `planRun` — the read-only plan composition (V2-01).
 *
 * Real repositories throughout, in the V1-08 style: a real `git init` fixture,
 * the production `resolveRepository`, the production `prepareTaskWorkspace`
 * and `saveTaskState` where a durable state is needed, and the production
 * `runGitCommand` so observation reads Git rather than a script.
 *
 * The property this suite guards hardest is the one in the module's name:
 * a plan is **read-only**. Several cases assert byte-identity of the durable
 * state and absence of any runtime directory after planning, because "plans
 * nothing wrote" is the entire contract V2-01 ships.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  planRun,
  RUN_PLAN_CONCLUSIONS,
  type RunPlan,
  type RunPlanConclusion,
} from '../src/run/run-plan.js';
import type { GitRunner } from '../src/worktree/git-command.js';
import {
  renderRunPlan,
  CONCLUSION_SENTENCES,
  READ_ONLY_TRAILER,
} from '../src/run/render-run-plan.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import {
  e2eProfile,
  removeTree,
  seedState,
  startTask,
  taskFile,
  tickingClock,
} from './helpers/e2e-fixtures.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture } from './helpers/worktree-fixtures.js';

afterEach(() => {
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const deps = { git: runGitCommand, now: tickingClock() };

/**
 * Every conclusion this suite actually produced.
 *
 * Recorded rather than asserted from the declared list, because the point of
 * the coverage check at the bottom of this file is to know which members are
 * exercised end to end — a question no assertion about the declared list can
 * answer.
 */
const produced = new Set<RunPlanConclusion>();

async function planned(
  request: Parameters<typeof planRun>[0],
  dependencies: Parameters<typeof planRun>[1] = deps,
): Promise<RunPlan> {
  const result = await planRun(request, dependencies);
  produced.add(result.conclusion);
  return result;
}

function runtimeDirectory(root: string): string {
  return join(root, '.agent-orchestrator', 'runtime');
}

async function fixtureRepository(files: Readonly<Record<string, string>>): Promise<{
  repository: ResolvedRepository;
  root: string;
}> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files,
  });
  return { repository: await resolveFixture(root), root };
}

describe('planRun — selection-level conclusions', () => {
  it('plans a fresh selected task as TASK_NOT_STARTED, and writes nothing', async () => {
    const { repository, root } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01'),
      'tasks/V2-02.md': taskFile('V2-02', { dependsOn: ['V2-01'] }),
    });

    const plan = await planned({ repository, taskId: null }, deps);

    expect(plan.conclusion).toBe('TASK_NOT_STARTED');
    expect(plan.target).toEqual({
      taskId: 'V2-01',
      source: 'SELECTED',
      eligibility: expect.objectContaining({ taskId: 'V2-01', eligible: true }),
    });
    expect(plan.selection.code).toBe('TASK_SELECTED');
    expect(plan.reconciliation?.outcome).toBe('NO_PERSISTED_STATE');
    expect(plan.resume).toBeNull();
    expect(plan.state).toBeNull();
    // Read-only: no runtime directory came into being, no worktree either.
    expect(existsSync(runtimeDirectory(root))).toBe(false);
    expect(existsSync(`${root}.worktrees`)).toBe(false);
  });

  it('reports ALL_TASKS_COMPLETE when every task is DONE', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01', { status: 'DONE' }),
    });

    const plan = await planned({ repository, taskId: null }, deps);

    expect(plan.conclusion).toBe('ALL_TASKS_COMPLETE');
    expect(plan.target).toBeNull();
    expect(plan.reconciliation).toBeNull();
    // `reasonCodes` carries codes, never task ids. The selector fills its own
    // with every ineligible id — for an all-DONE plan, the whole repository —
    // and passing those through would make the most nominal conclusion there
    // is arrive with a list of task names as its "reasons" (V2-01 review).
    expect(plan.reasonCodes).toEqual([]);
    expect(plan.selection.reasonCodes).toEqual(['V2-01']);
  });

  it('reports PLANNING_FAILED when the task source is missing', async () => {
    const { repository } = await fixtureRepository({
      // No tasks/ directory at all: the declared source does not exist.
      'README.md': 'no tasks here\n',
    });

    const plan = await planned({ repository, taskId: null }, deps);

    expect(plan.conclusion).toBe('PLANNING_FAILED');
    expect(plan.selection.code).toBe('PLANNING_FAILED');
    expect(plan.selection.planning.ok).toBe(false);
    expect(plan.reasonCodes.length).toBeGreaterThan(0);
  });
});

describe('planRun — named-task conclusions', () => {
  it('inspects the named task even when the ranking prefers another', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01'),
      'tasks/V2-02.md': taskFile('V2-02'),
    });

    const plan = await planned({ repository, taskId: 'V2-02' }, deps);

    expect(plan.conclusion).toBe('TASK_NOT_STARTED');
    expect(plan.target?.taskId).toBe('V2-02');
    expect(plan.target?.source).toBe('NAMED');
    // The selector's own answer is still reported alongside.
    expect(plan.selection.task?.id).toBe('V2-01');
  });

  it('refuses an id outside the task-id grammar without looking it up', async () => {
    const { repository, root } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01'),
    });

    const plan = await planned({ repository, taskId: '../escape' }, deps);

    expect(plan.conclusion).toBe('TASK_ID_INVALID');
    expect(plan.target).toBeNull();
    expect(plan.reconciliation).toBeNull();
    expect(existsSync(runtimeDirectory(root))).toBe(false);
  });

  it('reports a well-formed id that names no task as TASK_UNKNOWN', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01'),
    });

    const plan = await planned({ repository, taskId: 'V2-99' }, deps);

    expect(plan.conclusion).toBe('TASK_UNKNOWN');
    expect(plan.target).toBeNull();
  });

  it('reports a DONE named task with no state as TASK_INELIGIBLE', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01', { status: 'DONE' }),
      'tasks/V2-02.md': taskFile('V2-02'),
    });

    const plan = await planned({ repository, taskId: 'V2-01' }, deps);

    expect(plan.conclusion).toBe('TASK_INELIGIBLE');
    expect(plan.reasonCodes).toEqual(['ALREADY_DONE']);
    expect(plan.target?.eligibility?.eligible).toBe(false);
  });

  it('reports a dependency-blocked named task with its unsatisfied ids', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01'),
      'tasks/V2-02.md': taskFile('V2-02', { dependsOn: ['V2-01'] }),
    });

    const plan = await planned({ repository, taskId: 'V2-02' }, deps);

    expect(plan.conclusion).toBe('TASK_INELIGIBLE');
    expect(plan.reasonCodes).toEqual(['BLOCKED_BY_DEPENDENCIES']);
    expect(plan.target?.eligibility?.unsatisfiedDependencies).toEqual(['V2-01']);
  });
});

describe('planRun — durable-state conclusions', () => {
  it('classifies a reconciled in-flight task as attended-only, changing nothing', async () => {
    const started = await startTask({ taskId: 'V2-01' });
    const seeded = seedState(started);
    const stateFile = seeded.path;
    const bytesBefore = readFileSync(stateFile);

    const plan = await planned(
      { repository: started.repository, taskId: 'V2-01' },
      deps,
    );

    expect(plan.conclusion).toBe('RECONCILED_IN_FLIGHT');
    expect(plan.state).toBe('VERIFYING');
    expect(plan.reconciliation?.outcome).toBe('RECONCILED');
    expect(plan.resume?.classification).toBe('RECONCILED_IN_FLIGHT');
    expect(plan.resume?.continuation).toBe('ATTENDED_ONLY');
    // The plan performed no auth preflight and granted nothing.
    expect(plan.resume?.automaticResume).toBeNull();
    // Read-only: the durable bytes are exactly as they were.
    expect(readFileSync(stateFile)).toEqual(bytesBefore);
  });

  it('reports READY_FOR_PR as TASK_COMPLETED, before judging the world', async () => {
    const started = await startTask({ taskId: 'V2-01' });
    seedState(started, {
      state: 'READY_FOR_PR',
      reviewRound: 1,
    });

    const plan = await planned(
      { repository: started.repository, taskId: 'V2-01' },
      deps,
    );

    expect(plan.conclusion).toBe('TASK_COMPLETED');
    expect(plan.state).toBe('READY_FOR_PR');
    expect(plan.resume).toBeNull();
  });

  it('reports a parked task with the codes that keep it parked', async () => {
    const started = await startTask({ taskId: 'V2-01' });
    seedState(started, {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'IMPLEMENT', round: 1 },
      worktreeCleanAtCheckpoint: true,
    });

    const plan = await planned(
      { repository: started.repository, taskId: 'V2-01' },
      deps,
    );

    expect(plan.conclusion).toBe('TASK_PARKED');
    expect(plan.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(plan.resume?.classification).toBe('AUTOMATIC_RESUME_REFUSED');
    expect(plan.resume?.continuation).toBe('BLOCKED');
    // No reset time exists in this build, and no preflight ran for a plan.
    expect(plan.reasonCodes).toContain('RESET_TIME_MISSING');
    expect(plan.reasonCodes).toContain('AUTH_PREFLIGHT_NOT_PASSED');
  });

  it('reports a deleted worktree as STATE_DIVERGED', async () => {
    const started = await startTask({ taskId: 'V2-01' });
    seedState(started);
    removeTree(started.workspace.worktreePath);

    const plan = await planned(
      { repository: started.repository, taskId: 'V2-01' },
      deps,
    );

    expect(plan.conclusion).toBe('STATE_DIVERGED');
    expect(plan.reasonCodes.length).toBeGreaterThan(0);
    expect(plan.resume).toBeNull();
  });

  it('reports an aborted task as TASK_ABORTED, before judging the world', async () => {
    const started = await startTask({ taskId: 'V2-01' });
    seedState(started, { state: 'ABORTED' });
    // Even with the worktree gone — a terminal task is not a resume question.
    removeTree(started.workspace.worktreePath);

    const plan = await planned({ repository: started.repository, taskId: 'V2-01' });

    expect(plan.conclusion).toBe('TASK_ABORTED');
    expect(plan.state).toBe('ABORTED');
    expect(plan.resume).toBeNull();
  });

  it('reports an unreadable repository as STATE_UNOBSERVABLE', async () => {
    const started = await startTask({ taskId: 'V2-01' });
    seedState(started);
    // A Git that cannot answer at all: every probe is UNAVAILABLE, so the
    // world is unobservable rather than merely different.
    const blindGit: GitRunner = async () =>
      Object.freeze({ outcome: 'UNAVAILABLE' as const, stdout: '', exitCode: null });

    const plan = await planned(
      { repository: started.repository, taskId: 'V2-01' },
      { git: blindGit, now: deps.now },
    );

    expect(plan.conclusion).toBe('STATE_UNOBSERVABLE');
    expect(plan.resume).toBeNull();
    expect(plan.reasonCodes.length).toBeGreaterThan(0);
  });

  it('reports an unusable record as STATE_UNUSABLE and repairs nothing', async () => {
    const started = await startTask({ taskId: 'V2-01' });
    const seeded = seedState(started);
    const stateFile = seeded.path;
    // Corrupt the durable record in place.
    writeFileSync(stateFile, 'not json at all\n', 'utf8');
    const bytesBefore = readFileSync(stateFile);

    const plan = await planned(
      { repository: started.repository, taskId: 'V2-01' },
      deps,
    );

    expect(plan.conclusion).toBe('STATE_UNUSABLE');
    expect(plan.reconciliation?.outcome).toBe('STATE_INVALID');
    // Repairs nothing: the broken bytes are untouched.
    expect(readFileSync(stateFile)).toEqual(bytesBefore);
  });
});

describe('renderRunPlan', () => {
  it('renders ids, closed codes and the read-only note — never a title', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01'),
      'tasks/V2-02.md': taskFile('V2-02', { dependsOn: ['V2-01'] }),
    });

    const plan = await planned({ repository, taskId: null }, deps);
    const text = renderRunPlan(plan, repository);

    expect(text).toContain('TASK_NOT_STARTED');
    expect(text).toContain('V2-01');
    expect(text).toContain('waiting on V2-01');
    expect(text).toContain('Read-only plan.');
    // The task file's title prose must never reach the console.
    expect(text).not.toContain('task V2-01');
  });

  it('has a static sentence for every conclusion', () => {
    for (const conclusion of RUN_PLAN_CONCLUSIONS) {
      expect(CONCLUSION_SENTENCES[conclusion]).toMatch(/\S/);
    }
  });

  it('closes with the one shared contract sentence, which claims only what is true', () => {
    expect(READ_ONLY_TRAILER).toContain('no task state was written');
    // The narrower, honest claim: Git's own index refresh is not denied.
    expect(READ_ONLY_TRAILER).toContain('refresh its own index');
    expect(READ_ONLY_TRAILER).not.toContain('byte-identical');
  });

  it('renders a planning failure with only the closed code and static detail', async () => {
    const { repository } = await fixtureRepository({ 'README.md': 'no tasks\n' });
    const plan = await planned({ repository, taskId: null }, deps);
    const text = renderRunPlan(plan, repository);

    expect(text).toContain('PLANNING_FAILED');
    expect(text).toContain('Read-only plan.');
  });
});

/**
 * Runs last, and reads the record every case above wrote through `planned`.
 *
 * This replaces an earlier check that compared the declared list with itself
 * and therefore asserted only that it had no duplicates, while its name
 * claimed coverage it never measured (V2-01 review). What follows measures the
 * coverage, and states the exception explicitly rather than leaving a silent
 * hole: a member nobody can produce is worth naming in one place.
 */
describe('planRun — conclusion coverage', () => {
  it('exercises every conclusion except the one that is unreachable by construction', () => {
    const uncovered = RUN_PLAN_CONCLUSIONS.filter((conclusion) => !produced.has(conclusion));

    // `NO_ELIGIBLE_TASK` is a fail-closed floor, not a reachable state:
    // `select-task.ts` documents that in an acyclic graph whose dependencies
    // all resolve — the only kind `normalizeTaskGraph` returns — the
    // topologically first OPEN task can have no OPEN dependency, so an
    // eligible task always exists. No fixture can produce it without first
    // breaking the graph normaliser, which is that module's own test's job.
    expect(uncovered).toEqual(['NO_ELIGIBLE_TASK']);
  });
});
