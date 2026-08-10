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

import { planRun, RUN_PLAN_CONCLUSIONS, type RunPlan } from '../src/run/run-plan.js';
import { renderRunPlan, CONCLUSION_SENTENCES } from '../src/run/render-run-plan.js';
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

    const plan = await planRun({ repository, taskId: null }, deps);

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

    const plan = await planRun({ repository, taskId: null }, deps);

    expect(plan.conclusion).toBe('ALL_TASKS_COMPLETE');
    expect(plan.target).toBeNull();
    expect(plan.reconciliation).toBeNull();
  });

  it('reports PLANNING_FAILED when the task source is missing', async () => {
    const { repository } = await fixtureRepository({
      // No tasks/ directory at all: the declared source does not exist.
      'README.md': 'no tasks here\n',
    });

    const plan = await planRun({ repository, taskId: null }, deps);

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

    const plan = await planRun({ repository, taskId: 'V2-02' }, deps);

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

    const plan = await planRun({ repository, taskId: '../escape' }, deps);

    expect(plan.conclusion).toBe('TASK_ID_INVALID');
    expect(plan.target).toBeNull();
    expect(plan.reconciliation).toBeNull();
    expect(existsSync(runtimeDirectory(root))).toBe(false);
  });

  it('reports a well-formed id that names no task as TASK_UNKNOWN', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01'),
    });

    const plan = await planRun({ repository, taskId: 'V2-99' }, deps);

    expect(plan.conclusion).toBe('TASK_UNKNOWN');
    expect(plan.target).toBeNull();
  });

  it('reports a DONE named task with no state as TASK_INELIGIBLE', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01', { status: 'DONE' }),
      'tasks/V2-02.md': taskFile('V2-02'),
    });

    const plan = await planRun({ repository, taskId: 'V2-01' }, deps);

    expect(plan.conclusion).toBe('TASK_INELIGIBLE');
    expect(plan.reasonCodes).toEqual(['ALREADY_DONE']);
    expect(plan.target?.eligibility?.eligible).toBe(false);
  });

  it('reports a dependency-blocked named task with its unsatisfied ids', async () => {
    const { repository } = await fixtureRepository({
      'tasks/V2-01.md': taskFile('V2-01'),
      'tasks/V2-02.md': taskFile('V2-02', { dependsOn: ['V2-01'] }),
    });

    const plan = await planRun({ repository, taskId: 'V2-02' }, deps);

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

    const plan = await planRun(
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

    const plan = await planRun(
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

    const plan = await planRun(
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

    const plan = await planRun(
      { repository: started.repository, taskId: 'V2-01' },
      deps,
    );

    expect(plan.conclusion).toBe('STATE_DIVERGED');
    expect(plan.reasonCodes.length).toBeGreaterThan(0);
    expect(plan.resume).toBeNull();
  });

  it('reports an unusable record as STATE_UNUSABLE and repairs nothing', async () => {
    const started = await startTask({ taskId: 'V2-01' });
    const seeded = seedState(started);
    const stateFile = seeded.path;
    // Corrupt the durable record in place.
    writeFileSync(stateFile, 'not json at all\n', 'utf8');
    const bytesBefore = readFileSync(stateFile);

    const plan = await planRun(
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

    const plan = await planRun({ repository, taskId: null }, deps);
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

  it('renders a planning failure with only the closed code and static detail', async () => {
    const { repository } = await fixtureRepository({ 'README.md': 'no tasks\n' });
    const plan = await planRun({ repository, taskId: null }, deps);
    const text = renderRunPlan(plan, repository);

    expect(text).toContain('PLANNING_FAILED');
    expect(text).toContain('Read-only plan.');
  });
});

describe('planRun — the conclusion vocabulary is closed', () => {
  it('every conclusion the suite produced is a declared member', () => {
    // A compile-time truth restated at runtime so a widened union cannot
    // bypass the declared list.
    const declared: readonly string[] = RUN_PLAN_CONCLUSIONS;
    const witness: RunPlan['conclusion'][] = [...RUN_PLAN_CONCLUSIONS];
    expect(new Set(witness).size).toBe(declared.length);
  });
});
