import type { AgentCommandResult } from '../src/agent/agent-command.js';
import type { AutomaticResumeEvidence } from '../src/core/automatic-resume.js';
import type { TaskStateInput } from '../src/core/task-state.js';
import type { CommandResult } from '../src/doctor/exec.js';

/** A plausible full SHA-1 object name. Not a real commit from any repository. */
export const SHA_A = '0'.repeat(40);
export const SHA_B = `${'a'.repeat(39)}1`;

/**
 * A marker that is deliberately *not* token-shaped: it is not an email, not a
 * UUID, not `sk-`-prefixed and not a JWT, so the redactor does not recognise
 * it. It exists to prove that the report is safe because unknown text is never
 * copied, not because a pattern happened to match it (AO-002/AO-010).
 */
export const SENSITIVE_MARKER = 'zzQUARANTINEDzz';

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

/** A valid, fully settled `READY_FOR_PR` state. */
export function validReadyForPrState(overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return validCreatedState({
    state: 'READY_FOR_PR',
    reviewRound: 1,
    basePinnedCommit: SHA_A,
    currentCommit: SHA_B,
    worktreeCleanAtCheckpoint: true,
    blockedAgent: null,
    resumeFrom: null,
    reportedResetAt: null,
    ...overrides,
  });
}

/**
 * Evidence under which an automatic resume of {@link validUsageLimitState} is
 * legitimate: quota reset passed, auth re-proven, nothing moved.
 */
export function positiveResumeEvidence(
  overrides: Partial<AutomaticResumeEvidence> = {},
): AutomaticResumeEvidence {
  return {
    now: '2026-07-31T15:00:00.000Z',
    authPreflightPassed: true,
    observedRepositoryId: 'repo-alpha',
    observedRepositoryRoot: '/srv/projects/alpha',
    observedWorktreePath: '/srv/worktrees/alpha/task-0001',
    worktreeExists: true,
    observedBasePinnedCommit: SHA_A,
    observedCurrentCommit: SHA_B,
    worktreeClean: true,
    divergenceDetected: false,
    ...overrides,
  };
}

/** A completed `CommandResult`, for evaluating parsers without spawning. */
export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    display: 'claude auth status --json',
    executable: 'claude',
    args: ['auth', 'status', '--json'],
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    startedAt: '2026-07-31T10:00:00.000Z',
    finishedAt: '2026-07-31T10:00:01.000Z',
    durationMs: 1000,
    failureCode: null,
    errnoCode: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdinDelivery: 'NOT_REQUESTED',
    processTreeKilled: false,
    ...overrides,
  };
}

/**
 * An agent run that ended under its own control, for driving the V1-05
 * boundaries without starting a real CLI.
 *
 * The default is the *permissive* case — ran, exit 0, nothing truncated — so
 * that every adversarial test below has to say explicitly which single fact it
 * is changing, and a boundary that stopped checking one of them would be
 * caught by the test that varies it rather than hidden by a stricter default.
 */
export function agentCommandResult(
  overrides: Partial<AgentCommandResult> = {},
): AgentCommandResult {
  return {
    outcome: 'RAN',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    failureCode: null,
    errnoCode: null,
    durationMs: 1000,
    ...overrides,
  };
}

/** The stdout of a Claude run that positively succeeded, as observed at 2.1.226. */
export function claudeSuccessEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    result: 'done',
    ...overrides,
  });
}

/** A Codex `--json` transcript ending in `review`, as observed at codex-cli 0.146.0. */
export function codexTranscript(review: unknown, options: { completed?: boolean } = {}): string {
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread_0' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'agent_message',
        text: typeof review === 'string' ? review : JSON.stringify(review),
      },
    }),
  ];
  if (options.completed !== false) {
    lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }));
  }
  return `${lines.join('\n')}\n`;
}

/** A review document that positively passes. */
export function passingReview(): Record<string, unknown> {
  return { reviewVersion: 1, verdict: 'PASS', findings: [] };
}
