import type { AgentCommandResult } from '../src/agent/agent-command.js';
import type { AutomaticResumeEvidence } from '../src/core/automatic-resume.js';
import type { TaskStateInput } from '../src/core/task-state.js';
import type { CommandResult } from '../src/doctor/exec.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';

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

/**
 * The workspace identity `deriveTaskWorkspaceIdentity` produces for
 * {@link FIXTURE_REPOSITORY_ROOT} and {@link FIXTURE_TASK_ID}.
 *
 * Spelled out here rather than imported from the production derivation, so a
 * fixture cannot silently follow a change to the rule it is supposed to pin —
 * and asserted against the real function in `tests/worktree-identity.test.ts`.
 *
 * These values matter now that reconciliation *re-derives* the workspace
 * instead of believing the record (V1-08). The previous fixture claimed
 * `agent/task-0001` and `/srv/worktrees/alpha/task-0001`, neither of which any
 * production write could ever produce, so every state built from it described a
 * task whose workspace the orchestrator would refuse to recognise as its own.
 */
export const FIXTURE_REPOSITORY_ROOT = '/srv/projects/alpha';
export const FIXTURE_TASK_ID = 'task-0001';
export const FIXTURE_WORK_BRANCH = `ao/task/${FIXTURE_TASK_ID}`;
export const FIXTURE_WORKTREE_PATH = `/srv/projects/alpha.worktrees/${FIXTURE_TASK_ID}`;

/**
 * A canonical finding fingerprint: 32 lowercase hex characters.
 *
 * Exactly the grammar `fingerprintFinding` emits and `FindingRecordSchema`
 * requires. A helper rather than a literal per test, so a case that means to
 * vary the *round* or the *severity* does not silently vary the fingerprint too
 * and pass for a reason it did not intend.
 */
export function fingerprint(seed = 0): string {
  return seed.toString(16).padStart(32, '0');
}

/** A valid, fully settled state at the start of a task. */
export function validCreatedState(overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return {
    schemaVersion: 1,
    taskId: FIXTURE_TASK_ID,
    repositoryId: 'repo-alpha',
    repositoryRoot: FIXTURE_REPOSITORY_ROOT,
    worktreePath: FIXTURE_WORKTREE_PATH,
    state: 'CREATED',
    stateEnteredAt: '2026-07-31T10:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: null,
    scopeAuthorityCommit: null,
    workBranch: FIXTURE_WORK_BRANCH,
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
    // Real evidence from the real mint, not a stand-in: see
    // `helpers/auth-evidence.ts` for why a cast is not used here.
    authEvidence: provenAuthEvidence(),
    observedRepositoryId: 'repo-alpha',
    observedRepositoryRoot: FIXTURE_REPOSITORY_ROOT,
    observedWorktreePath: FIXTURE_WORKTREE_PATH,
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
    stdoutBytesObserved: 0,
    stderrBytesObserved: 0,
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

/**
 * The stdout of a Claude run, in the JSONL stream the writer has consumed since
 * V3-11 — `--print --output-format stream-json --verbose`.
 *
 * Shaped after the capture recorded in `internal/claude-result-stream.ts`: a
 * `system`/`init` message, any `rate_limit_event`s, an `assistant` message and
 * the terminal `result`, one object per line, newline-terminated. The surround
 * is not decoration — it is what makes every caller of this fixture exercise
 * the transport layer instead of handing the classifier a bare object.
 *
 * `overrides` patches the terminal `result`; the defaults are the ones observed
 * at 2.1.226 and unchanged by the migration.
 */
export function claudeResultStream(
  overrides: Record<string, unknown> = {},
  options: { readonly rateLimits?: readonly Record<string, unknown>[] } = {},
): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      tools: ['Edit', 'Glob', 'Grep', 'Read', 'Write'],
      mcp_servers: [],
      permissionMode: 'acceptEdits',
    }),
  ];
  for (const info of options.rateLimits ?? []) {
    lines.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }));
  }
  lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }));
  lines.push(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      stop_reason: 'end_turn',
      terminal_reason: 'completed',
      result: 'done',
      ...overrides,
    }),
  );
  return lines.map((line) => `${line}\n`).join('');
}

/**
 * A `rate_limit_info` payload reporting a refusal, with the reset instant the
 * CLI would carry. `resetsAt` is epoch **seconds**.
 */
export function rejectedRateLimit(resetsAt: number): Record<string, unknown> {
  return { status: 'rejected', rateLimitType: 'five_hour', resetsAt };
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

/**
 * The Codex usage-limit message, byte for byte as production printed it.
 *
 * Recovered from `~/.codex/sessions/**` on this machine on 2026-09-02: 51
 * occurrences across sessions whose `originator` is `codex_exec` at
 * `cli_version 0.146.0` — the installed build — every one of them carrying
 * `codex_error_info: "usage_limit_exceeded"` internally. One template, four
 * different times (10:33 PM, 5:25 PM, 5:35 PM, 9:25 PM); this is the 2026-08-29
 * incident, whose structured `rate_limits.primary.resets_at` was 1788017730 =
 * `2026-08-29T15:35:30Z` — 5:35 PM in the machine's own zone.
 *
 * Not paraphrased and not reconstructed. A parser tested against a summary of a
 * message is tested against the summariser.
 */
export const CODEX_USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), " +
  'visit https://chatgpt.com/codex/settings/usage to purchase more credits or ' +
  'try again at 5:35 PM.';

/**
 * The stdout `codex exec --json` prints for a failed turn.
 *
 * Measured on 2026-09-02 by forcing a failure (`-m
 * definitely-not-a-real-model-xyz`): the stream is `thread.started`,
 * `turn.started`, a top-level `{"type":"error","message":…}` and finally
 * `{"type":"turn.failed","error":{"message":…}}`, with exit status 1.
 *
 * The `error` object carries **only** `message`. The same run's rollout
 * recorded `codex_error_info: "other"` alongside it internally, so the
 * structured category is not on this wire — which is why the message is the
 * only quota signal a boundary can read.
 */
export function codexFailedTurn(message: string): string {
  return (
    [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread_0' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message }),
      JSON.stringify({ type: 'turn.failed', error: { message } }),
    ].join('\n') + '\n'
  );
}
/** A review document that positively passes. */
export function passingReview(): Record<string, unknown> {
  return { reviewVersion: 1, verdict: 'PASS', findings: [] };
}
