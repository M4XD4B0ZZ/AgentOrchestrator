import type { TaskStateInput } from '../src/core/task-state.js';

/** A plausible full SHA-1 object name. Not a real commit from any repository. */
export const SHA_A = '0'.repeat(40);
export const SHA_B = `${'a'.repeat(39)}1`;

/** A valid, fully settled state at the start of a task. */
export function validCreatedState(overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return {
    schemaVersion: 1,
    taskId: 'task-0001',
    repositoryId: 'repo-alpha',
    repositoryRoot: '/srv/projects/alpha',
    worktreePath: '/srv/worktrees/alpha/task-0001',
    state: 'CREATED',
    stateEnteredAt: '2026-07-31T10:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: null,
    workBranch: 'agent/task-0001',
    currentCommit: null,
    reviewRound: 0,
    maxReviewRounds: 3,
    blockedAgent: null,
    resumeFrom: null,
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: true,
    findingHistory: [],
    ...overrides,
  };
}

/** A valid `BLOCKED_USAGE_LIMIT` state with complete evidence. */
export function validUsageLimitState(overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return validCreatedState({
    state: 'BLOCKED_USAGE_LIMIT',
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    reportedResetAt: '2026-07-31T14:00:00.000Z',
    basePinnedCommit: SHA_A,
    currentCommit: SHA_B,
    reviewRound: 1,
    ...overrides,
  });
}
