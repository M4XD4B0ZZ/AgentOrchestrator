/**
 * V3-11 / L-V3-08-1: the quota reset instant, read from the stream the CLI
 * actually emits it in.
 *
 * ── The lock this removes ──────────────────────────────────────────────────
 *
 * `evaluateAutomaticResume` sleeps only when a block's denial list is exactly
 * `[RESET_TIME_NOT_REACHED]`. V3-10 closed the two checkpoint denials, leaving
 * `RESET_TIME_MISSING` alone — and it was unremovable, because the writer ran
 * `--output-format json`, whose terminal `result` object carries no reset field
 * on either variant. The instant exists one output mode away, as
 * `rate_limit_event.rate_limit_info.resetsAt` under
 * `--output-format stream-json --verbose`, where the CLI writes every message
 * instead of keeping only the last.
 *
 * ── What is synthetic here, and what is not ────────────────────────────────
 *
 * **Nothing about the reset instant.** V3-10's suite had to supply `T` itself
 * and said so; this one does not, and that difference is the acceptance proof.
 * The `resetsAt` integer travels through the production recogniser, in a stream
 * shaped after a real capture, and the ISO timestamp asserted below is the one
 * `readClaudeResultStream` derived from it. What is still injected is the
 * *seam*: no test in this file starts a real `claude`, because a real quota
 * refusal cannot be produced on demand.
 *
 * ── The capture these fixtures are shaped after ────────────────────────────
 *
 * `claude 2.1.239`, the production vector, `Reply with exactly the word: ok` on
 * stdin, in a throwaway directory: four lines, 4741 bytes on stdout, nothing on
 * stderr, exit 0 — `system`/`init`, `rate_limit_event`, `assistant`, `result`.
 * The `rate_limit_event` arrived on that **healthy** run carrying
 * `status: "allowed"` and a `resetsAt`, which is why §3 exists.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { AgentCommandResult, AgentRunner } from '../src/agent/agent-command.js';
import { runClaudeWriter, CLAUDE_WRITER_ARGS } from '../src/agent/claude-writer.js';
import { readClaudeResultStream } from '../src/agent/internal/claude-result-stream.js';
import { IsoDateTimeSchema } from '../src/core/internal/task-state-object-schema.js';
import { runImplementStep, type LoopDependencies } from '../src/loop/loop-step.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { observeTaskDelta } from '../src/scope/task-delta.js';
import { startTask } from '../src/run/start-task.js';
import { observeRuntime } from '../src/state/observe-runtime.js';
import { classifyResume } from '../src/state/resume-decision.js';
import { loadTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { agentCommandResult, claudeResultStream, rejectedRateLimit } from './fixtures.js';
import { authPreflightPasses, provenAuthEvidence } from './helpers/auth-evidence.js';
import {
  e2eProfile,
  usageLimitResult,
  recordedAgent,
  writerThatEditsThenHitsUsageLimit,
} from './helpers/e2e-fixtures.js';
import { leaseAuthorityFor, leaseFor, releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, removeRepoFixtures, git } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture } from './helpers/worktree-fixtures.js';

const TASK_ID = 'V3-11';
const NEWLINE = '\n';

/**
 * The reset instant every case in this file uses, in the CLI's own unit.
 *
 * Far enough ahead that no test machine's clock reaches it mid-run, and chosen
 * as a whole number of seconds so the ISO rendering has no rounding to hide
 * behind. `RESET_ISO` is written out rather than computed, so a change to the
 * conversion is a failing assertion instead of two expressions agreeing.
 */
const RESETS_AT = 1_800_000_000;
const RESET_ISO = '2027-01-15T08:00:00.000Z';
const BEFORE_RESET = '2027-01-15T07:59:59.000Z';
const AFTER_RESET = '2027-01-15T08:00:01.000Z';

const WORKTREE = '/srv/worktrees/alpha/task-0001';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

/** A stream whose terminal `result` is a quota refusal. */
function refusalStream(rateLimits: readonly Record<string, unknown>[] = []): string {
  return claudeResultStream(
    { subtype: 'error', is_error: true, api_error_status: 429 },
    { rateLimits },
  );
}

/* ══════════════════ 1. Transport: what counts as a stream ═════════════════ */

/**
 * The layer that decides whether bytes are a stream at all, before anything
 * asks what they say.
 *
 * The contract is one sentence: the **last non-empty line** must be the one and
 * only `result` message. Until V3-11 the equivalent guarantee came for free —
 * the whole trimmed stdout had to be the envelope — and scanning JSONL gives
 * that up, so every way of losing it has a case here.
 */
describe('the transport layer decides what counts as a complete stream', () => {
  it('reads a stream shaped like the real capture', () => {
    const reading = readClaudeResultStream(claudeResultStream());
    expect(reading.verdict).toBe('COMPLETED');
  });

  it('refuses a stream that never reached its terminating result', () => {
    const whole = refusalStream([rejectedRateLimit(RESETS_AT)]);
    const lines = whole.split('\n').filter((line) => line.trim().length > 0);
    // Everything except the last line — the shape a stream cut at its byte
    // budget leaves behind, and the shape `BoundedSink` produces because it
    // keeps the head and drops the tail. The refusal event and its instant are
    // still in there, and they buy nothing: without the terminator there is no
    // run for them to be attached to.
    const cut = `${lines.slice(0, -1).join('\n')}\n`;
    expect(cut).toContain('rate_limit_event');
    expect(cut).toContain(String(RESETS_AT));

    const reading = readClaudeResultStream(cut);
    expect(reading.verdict).toBe('UNRECOGNISED');
    expect(reading.reportedResetAt).toBeNull();
  });

  it('refuses a stream cut in the middle of its terminating result', () => {
    const whole = claudeResultStream();
    const cut = whole.slice(0, whole.length - 40);
    expect(readClaudeResultStream(cut).verdict).toBe('UNRECOGNISED');
  });

  it('refuses a stream that carries two terminating results', () => {
    const doubled = claudeResultStream() + claudeResultStream();
    expect(readClaudeResultStream(doubled).verdict).toBe('UNRECOGNISED');
  });

  it('refuses a result that is not what the stream ends on', () => {
    const trailing = `${claudeResultStream()}${JSON.stringify({ type: 'assistant' })}\n`;
    expect(readClaudeResultStream(trailing).verdict).toBe('UNRECOGNISED');
  });

  it('refuses a stream wrapped in anything that is not JSONL', () => {
    // The quoted-envelope case, in the shape a JSONL reader is vulnerable to:
    // the terminator is present and parseable, and it is not the last line.
    const quoted = `A test file contains:\n${claudeResultStream()}and that is line 12.\n`;
    expect(readClaudeResultStream(quoted).verdict).toBe('UNRECOGNISED');
  });

  it('reads a stream whose lines are CRLF-terminated', () => {
    const crlf = claudeResultStream().split('\n').join('\r\n');
    expect(readClaudeResultStream(crlf).verdict).toBe('COMPLETED');
  });

  it('ignores blank lines and message kinds it has never seen', () => {
    const lines = claudeResultStream().split('\n').filter((line) => line.trim().length > 0);
    const noisy = [
      '',
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta' } }),
      '   ',
      ...lines,
    ].join('\n');
    expect(readClaudeResultStream(noisy).verdict).toBe('COMPLETED');
  });

  /**
   * Found by mutation, not by design. Removing the `endsWithObject = false` in
   * the non-object branch left this passing: the flag stayed true from the
   * `result` line before it, and the array was simply not collected, so the
   * `result` was still the last *object* and the stream looked complete.
   */
  it('refuses a stream ending in valid JSON that is not a message', () => {
    for (const tail of ['[]', '[1,2,3]', '"a quoted string"', '42', 'null']) {
      const stream = `${claudeResultStream()}${tail}\n`;
      expect(readClaudeResultStream(stream).verdict).toBe('UNRECOGNISED');
    }
  });

  it('refuses an empty stream', () => {
    expect(readClaudeResultStream('').verdict).toBe('UNRECOGNISED');
    expect(readClaudeResultStream('   \n\n').verdict).toBe('UNRECOGNISED');
  });
});

/* ════════════ 2. The reset instant is read, and only from a refusal ═══════ */

describe('the reset instant is read from a rejected rate-limit event', () => {
  it('converts the epoch seconds the CLI reports into an exact instant', () => {
    const reading = readClaudeResultStream(refusalStream([rejectedRateLimit(RESETS_AT)]));

    expect(reading.verdict).toBe('USAGE_LIMIT');
    expect(reading.reportedResetAt).toBe(RESET_ISO);
  });

  it('takes the last rejected event when the window was restated', () => {
    const reading = readClaudeResultStream(
      refusalStream([rejectedRateLimit(RESETS_AT - 3_600), rejectedRateLimit(RESETS_AT)]),
    );
    expect(reading.reportedResetAt).toBe(RESET_ISO);
  });

  /**
   * The newest refusal decides, **including when it turns out to be
   * unreadable**. Found by an independent review of the merged slice: the
   * rejection arms used `continue`, so a readable older refusal beside an
   * unreadable newer one produced the older instant — the "falls back to an
   * older statement" arm this module's own docstring says does not exist.
   *
   * Every spelling is listed rather than one, because the fall-back lived in
   * the shared tail of all of them.
   */
  it.each([
    ['a string instant', String(RESETS_AT)],
    ['a fractional instant', RESETS_AT + 0.5],
    ['a zero instant', 0],
    ['an instant beyond the durable contract', 253_402_300_800],
  ])('reports no instant when the newest refusal carries %s', (_label, resetsAt) => {
    const older = rejectedRateLimit(RESETS_AT - 7_200);
    const reading = readClaudeResultStream(
      refusalStream([older, { status: 'rejected', rateLimitType: 'seven_day', resetsAt }]),
    );

    expect(reading.verdict).toBe('USAGE_LIMIT');
    expect(reading.reportedResetAt).toBeNull();
  });

  it('reports no instant when the newest refusal carries none at all', () => {
    const reading = readClaudeResultStream(
      refusalStream([rejectedRateLimit(RESETS_AT - 7_200), { status: 'rejected' }]),
    );

    expect(reading.verdict).toBe('USAGE_LIMIT');
    expect(reading.reportedResetAt).toBeNull();
  });

  it('skips a later event that reports no refusal, and keeps the refusal it saw', () => {
    const reading = readClaudeResultStream(
      refusalStream([
        rejectedRateLimit(RESETS_AT),
        { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1 },
      ]),
    );
    expect(reading.reportedResetAt).toBe(RESET_ISO);
  });

  it('still refuses the run, and reports no instant, when none was carried', () => {
    const reading = readClaudeResultStream(refusalStream());

    expect(reading.verdict).toBe('USAGE_LIMIT');
    expect(reading.reportedResetAt).toBeNull();
  });

  /**
   * Each of these is a value the field could arrive as and must not be read as
   * an instant. Every one of them is `RESET_TIME_MISSING`, which is a human
   * decision — there is no arm here that estimates, rounds or falls back.
   */
  it.each([
    ['a status that reports no refusal', { status: 'allowed', resetsAt: RESETS_AT }],
    ['a warning that reports no refusal', { status: 'allowed_warning', resetsAt: RESETS_AT }],
    ['a refusal with no instant', { status: 'rejected' }],
    ['a string instant', { status: 'rejected', resetsAt: String(RESETS_AT) }],
    ['a fractional instant', { status: 'rejected', resetsAt: RESETS_AT + 0.5 }],
    ['a zero instant', { status: 'rejected', resetsAt: 0 }],
    ['a negative instant', { status: 'rejected', resetsAt: -RESETS_AT }],
    ['an instant beyond what the durable contract can hold', { status: 'rejected', resetsAt: 253_402_300_800 }],
    ['a non-finite instant', { status: 'rejected', resetsAt: Number.POSITIVE_INFINITY }],
    ['a missing status', { resetsAt: RESETS_AT }],
    ['a null payload', null],
    ['a payload that is not an object', 'rejected'],
  ])('reports no instant for %s', (_label, info) => {
    const stream = claudeResultStream(
      { subtype: 'error', is_error: true, api_error_status: 429 },
      { rateLimits: [] },
    );
    const lines = stream.split('\n').filter((line) => line.trim().length > 0);
    const withEvent = [
      ...lines.slice(0, -1),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }),
      lines[lines.length - 1],
    ].join('\n');

    const reading = readClaudeResultStream(withEvent);
    expect(reading.verdict).toBe('USAGE_LIMIT');
    expect(reading.reportedResetAt).toBeNull();
  });

  it('reports no instant for a rate-limit event with no payload at all', () => {
    const lines = refusalStream().split('\n').filter((line) => line.trim().length > 0);
    const withEvent = [
      ...lines.slice(0, -1),
      JSON.stringify({ type: 'rate_limit_event' }),
      lines[lines.length - 1],
    ].join('\n');

    expect(readClaudeResultStream(withEvent).reportedResetAt).toBeNull();
  });
});

/* ═════════ 3. Two guards, and neither of them is the other's spare ════════ */

/**
 * The measured healthy run carried `status: "allowed"` **with** a `resetsAt`.
 * So "the stream reported an instant" is not "the run was refused", and the two
 * guards that keep those apart are independent: the status check, and the
 * verdict branch the instant is attached on. Each case below removes one of
 * them from the input and requires the other to hold.
 */
describe('a reset instant reaches a task only through a recognised refusal', () => {
  it('carries no instant on a healthy run, exactly as the real capture is shaped', () => {
    const reading = readClaudeResultStream(
      claudeResultStream({}, { rateLimits: [{ status: 'allowed', resetsAt: RESETS_AT }] }),
    );

    expect(reading.verdict).toBe('COMPLETED');
    expect(reading.reportedResetAt).toBeNull();
  });

  it('carries no instant on a healthy run that somehow saw a refusal event', () => {
    // The status guard alone would let this through; the verdict branch is what
    // stops it. A completed pass is not a block, so there is no state for an
    // instant to authorise.
    const reading = readClaudeResultStream(
      claudeResultStream({}, { rateLimits: [rejectedRateLimit(RESETS_AT)] }),
    );

    expect(reading.verdict).toBe('COMPLETED');
    expect(reading.reportedResetAt).toBeNull();
  });

  it('carries no instant on an unrecognised document that saw a refusal event', () => {
    const reading = readClaudeResultStream(
      claudeResultStream(
        { subtype: 'success', is_error: false, api_error_status: 503 },
        { rateLimits: [rejectedRateLimit(RESETS_AT)] },
      ),
    );

    expect(reading.verdict).toBe('UNRECOGNISED');
    expect(reading.reportedResetAt).toBeNull();
  });
});

/* ═════════════ 4. The writer boundary, and the guards above it ════════════ */

function scriptedAgent(result: AgentCommandResult): AgentRunner {
  return async () => result;
}

describe('the writer boundary carries the instant, and only from a usable process', () => {
  it('asks for the output mode the instant lives in, and no longer for the other', () => {
    expect([...CLAUDE_WRITER_ARGS]).toContain('stream-json');
    expect([...CLAUDE_WRITER_ARGS]).toContain('--verbose');
    // `--verbose` is mandatory here, not a preference: with `--print` the CLI
    // refuses `stream-json` without it.
    const at = CLAUDE_WRITER_ARGS.indexOf('--output-format');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(CLAUDE_WRITER_ARGS[at + 1]).toBe('stream-json');
    expect([...CLAUDE_WRITER_ARGS]).not.toContain('json');
  });

  it('records the instant on the block evidence a refusal produces', async () => {
    const outcome = await runClaudeWriter(
      { worktreePath: WORKTREE, phase: 'IMPLEMENT', round: 1, payload: 'do it' },
      {
        agent: scriptedAgent(
          agentCommandResult({ exitCode: 1, stdout: refusalStream([rejectedRateLimit(RESETS_AT)]) }),
        ),
      },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_USAGE_LIMIT');
    expect(outcome.block?.reportedResetAt).toBe(RESET_ISO);
  });

  /**
   * The process-level guards stand above the reader and are not weakened by it.
   * Each input below is a *perfect* refusal stream carrying a valid instant, so
   * nothing but the process fact can be what refuses it — and the block must not
   * exist at all, instant or no instant.
   */
  it.each([
    ['a process killed from outside', { exitCode: null, signal: 'SIGKILL' as const }],
    ['a stream that hit its byte budget', { outcome: 'UNAVAILABLE' as const, outputTruncated: true }],
  ])('refuses to read a valid instant out of %s', async (_label, overrides) => {
    const outcome = await runClaudeWriter(
      { worktreePath: WORKTREE, phase: 'IMPLEMENT', round: 1, payload: 'do it' },
      {
        agent: scriptedAgent(
          agentCommandResult({
            stdout: refusalStream([rejectedRateLimit(RESETS_AT)]),
            ...overrides,
          }),
        ),
      },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.block).toBeNull();
  });
});

/* ══════════ 5. What the reader produces, the durable contract accepts ═════ */

describe('the instant the reader derives is a value the state contract accepts', () => {
  it('satisfies the schema the durable field is declared with', () => {
    const reading = readClaudeResultStream(refusalStream([rejectedRateLimit(RESETS_AT)]));
    expect(reading.reportedResetAt).toBe(RESET_ISO);

    // `reportedResetAt` is `z.iso.datetime({ offset: true })`, which is narrower
    // than `Date.parse`. A reader emitting anything else would produce a value
    // `saveTaskState` refuses, so the block would fail to be written at all —
    // and `L-V3-08-4` records that such a timestamp never reaches the wait
    // arithmetic, it stops the run at `STATE_UNUSABLE` instead.
    expect(IsoDateTimeSchema.safeParse(reading.reportedResetAt).success).toBe(true);
  });

  it('is a check that can fail, on a timestamp Date.parse would have accepted', () => {
    // The control. Without it the assertion above passes for any schema that
    // accepts everything, and `Date.parse` accepts this one.
    expect(Number.isNaN(Date.parse('2027-01-15 08:00:00'))).toBe(false);
    expect(IsoDateTimeSchema.safeParse('2027-01-15 08:00:00').success).toBe(false);
  });

  /**
   * The bound is the schema's, not `Date`'s, and the difference is a defect
   * this case exists to keep out.
   *
   * `Date` holds ±8.64e15 ms, and an instant near that end renders with an
   * expanded year — `+275760-09-13T00:00:00.000Z` — which `Date.parse` accepts
   * and `z.iso.datetime({ offset: true })` refuses. A reader bounded by `Date`
   * would hand `recordAgentInterruption` a value the durable contract rejects,
   * so the block would fail to be *written*: the task would stop with no record
   * of why, which is worse than reporting no instant at all.
   */
  it('reads the last instant the durable contract can hold, and refuses the next one', () => {
    const LAST = 253_402_300_799;

    const held = readClaudeResultStream(refusalStream([rejectedRateLimit(LAST)]));
    expect(held.reportedResetAt).toBe('9999-12-31T23:59:59.000Z');
    expect(IsoDateTimeSchema.safeParse(held.reportedResetAt).success).toBe(true);

    const beyond = readClaudeResultStream(refusalStream([rejectedRateLimit(LAST + 1)]));
    expect(beyond.verdict).toBe('USAGE_LIMIT');
    expect(beyond.reportedResetAt).toBeNull();

    // And the premise, so the bound is not merely asserted: the value one past
    // it really is one the contract refuses.
    expect(IsoDateTimeSchema.safeParse(new Date((LAST + 1) * 1000).toISOString()).success).toBe(
      false,
    );
  });
});

/* ═══════ 5b. The failure an operator reads is still about the failure ═════ */

/**
 * The excerpt is a redacted *prefix* of stdout, and under `stream-json` the
 * first four kilobytes are the `init` message. Left alone, a writer that failed
 * would report a listing of its own tool set to the operator and cut off before
 * anything about the failure — a regression in exactly the two cases the
 * excerpt exists for.
 */
describe('a failed run still tells an operator what the agent said', () => {
  it('excerpts the terminal result rather than the init message', async () => {
    const outcome = await runClaudeWriter(
      { worktreePath: WORKTREE, phase: 'IMPLEMENT', round: 1, payload: 'do it' },
      {
        agent: scriptedAgent(
          agentCommandResult({
            exitCode: 1,
            stdout: claudeResultStream({
              subtype: 'error',
              is_error: true,
              result: 'THE-REASON-THE-RUN-FAILED',
            }),
          }),
        ),
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.stdoutExcerpt).toContain('THE-REASON-THE-RUN-FAILED');
    // The init message is what the excerpt would otherwise have been full of.
    expect(outcome.diagnostics.stdoutExcerpt).not.toContain('permissionMode');
  });

  it('falls back to the whole stream when there is no terminal result', async () => {
    // A cut stream: the head is the evidence, because there is nothing else.
    const lines = claudeResultStream().split('\n').filter((line) => line.trim().length > 0);
    const outcome = await runClaudeWriter(
      { worktreePath: WORKTREE, phase: 'IMPLEMENT', round: 1, payload: 'do it' },
      {
        agent: scriptedAgent(
          agentCommandResult({ exitCode: 1, stdout: `${lines.slice(0, -1).join('\n')}\n` }),
        ),
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.stdoutExcerpt).toContain('permissionMode');
  });
});

/* ═════════ 6. End to end: the denial list, with nothing synthetic ═════════ */

/**
 * The acceptance proof for L-V3-08-1.
 *
 * A writer edits inside scope and is refused for quota in the stream a real 429
 * produces. V3-10 settles the repository; V3-11 supplies the instant. The
 * denial list is then asserted as an **exact list**, because the claim is not
 * "one more check passes" — it is that `RESET_TIME_NOT_REACHED` is now the only
 * thing holding the task, which is precisely the list the unattended wait
 * sleeps on.
 */
describe('a real quota block now denies for exactly one reason, and then stops denying', () => {
  it('records the instant the recogniser derived, and nothing a test supplied', async () => {
    const { repository, root, current, worktreePath } = await implementing();

    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit(
        'src/partial.ts',
        `export const partial = 1;${NEWLINE}`,
        { resetsAt: RESETS_AT },
      ),
    });
    const step = await runImplementStep(
      current,
      stepDeps(current, repository, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('BLOCKED_USAGE_LIMIT');

    const blocked = reload(root).state;
    expect(blocked.reportedResetAt).toBe(RESET_ISO);
    // V3-10's settlement, still doing its half: without these two the denial
    // list below could never be a single element.
    expect(blocked.currentCommit).toBe(git(worktreePath, ['rev-parse', 'HEAD']).trim());
    expect(blocked.worktreeCleanAtCheckpoint).toBe(true);

    const before = await decide(blocked, repository, BEFORE_RESET);
    expect(before.automaticResume?.allowed).toBe(false);
    expect(before.automaticResume?.reasonCodes).toEqual(['RESET_TIME_NOT_REACHED']);

    const after = await decide(blocked, repository, AFTER_RESET);
    expect(after.automaticResume?.allowed).toBe(true);
    expect(after.automaticResume?.reasonCodes).toEqual([]);
  });

  it('still waits for a human when the refusal reported no instant', async () => {
    const { repository, root, current } = await implementing();

    const agent = recordedAgent({ claude: () => usageLimitResult() });
    await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    const blocked = reload(root).state;
    expect(blocked.reportedResetAt).toBeNull();

    const decision = await decide(blocked, repository, AFTER_RESET);
    expect(decision.automaticResume?.allowed).toBe(false);
    expect(decision.automaticResume?.reasonCodes).toEqual(['RESET_TIME_MISSING']);
  });
});

/* ═══════ 7. L-V3-10-4 narrowed: two configuration blind spots closed ══════ */

/**
 * Until V3-11 an unattended resume could not happen, so a repository that
 * *configured away* Git's answer to "is this worktree clean" cost only an
 * inaccurate report. It now mints the authority for a writer launch, so the
 * question has to be asked in a way the observed repository cannot answer for
 * us. Both cases below are reproduced against real Git before the flags are
 * credited with anything: each first shows the default reading, then the one
 * the observers take.
 */
describe('the observed repository cannot configure away its own cleanliness', () => {
  it('sees an untracked file a worktree-local status.showUntrackedFiles hides', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/p.ts', `export const p = 1;${NEWLINE}`, {
        resetsAt: RESETS_AT,
      }),
    });
    await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));
    const blocked = reload(root).state;
    expect(blocked.worktreeCleanAtCheckpoint).toBe(true);

    // The worktree changes while the task waits — which is exactly what the
    // checkpoint promises did not happen — and the repository is configured so
    // that a bare `status --porcelain` cannot see it.
    git(worktreePath, ['config', 'status.showUntrackedFiles', 'no']);
    writeFileInWorktree(worktreePath, 'src/appeared.ts');

    // The premise, measured: the hidden answer really is hidden.
    expect(git(worktreePath, ['status', '--porcelain']).trim()).toBe('');
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all']).trim()).not.toBe(
      '',
    );

    const observed = await observeRuntime(runGitCommand, blocked);
    expect(observed.worktreeClean).toBe(false);

    // The reconciler reaches its verdict first, so the automatic-resume question
    // is never asked at all — `STATE_DIVERGED` is a stronger refusal than a
    // denial, and `continuation` is the field a caller is allowed to read.
    const decision = await decide(blocked, repository, AFTER_RESET);
    expect(decision.classification).toBe('STATE_DIVERGED');
    expect(decision.continuation).toBe('BLOCKED');
    expect(decision.automaticResume).toBeNull();
  });

  it('sees a submodule change that a `.gitmodules` ignore rule hides', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/p.ts', `export const p = 1;${NEWLINE}`, {
        resetsAt: RESETS_AT,
      }),
    });
    await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));
    const blocked = reload(root).state;

    // A submodule, added inside the paused worktree and committed there, then
    // modified and told to keep quiet about it.
    addDirtySubmodule(worktreePath);

    // The premise, measured: Git really does report this tree as clean.
    expect(git(worktreePath, ['status', '--porcelain']).trim()).toBe('');
    expect(
      git(worktreePath, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]).trim(),
    ).not.toBe('');

    const observed = await observeRuntime(runGitCommand, blocked);
    expect(observed.worktreeClean).toBe(false);
  });

  /**
   * The scope gate's half, and the reason the submodule flag went on the diff
   * as well as on the two `status` observers.
   *
   * A writer with `Read Edit Write Glob Grep` cannot move a submodule pointer,
   * but it can edit a file *inside* one, and `git diff <base>` reports that as
   * a modification of the gitlink — unless the repository has said not to.
   * Hardening cleanliness alone would have been worse than hardening neither:
   * a change the gate cannot see and the settlement can is one that gets
   * **committed** rather than blocked.
   */
  it('measures a submodule modification the scope gate would otherwise miss', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    expect(repository.id).not.toBe('');
    expect(root).not.toBe('');
    const base = addDirtySubmodule(worktreePath);

    // The premise, measured: the gate's own question, asked without the flag,
    // answers "nothing changed".
    expect(
      git(worktreePath, [
        'diff',
        '--name-status',
        '--no-renames',
        '--no-color',
        base,
        '--',
      ]).trim(),
    ).toBe('');

    const delta = await observeTaskDelta(runGitCommand, worktreePath, base);
    expect(delta.outcome).toBe('OBSERVED');
    if (delta.outcome !== 'OBSERVED') return;
    expect(delta.paths.map((entry) => entry.path)).toContain('vendor');
  });
});

/**
 * Adds a submodule to `worktreePath`, commits it, modifies its content and
 * tells Git to ignore the modification. Returns the commit the submodule was
 * added in, which is the base a delta is measured against.
 *
 * `protocol.file.allow` is a test affordance: modern Git refuses a
 * file-protocol submodule by default. It is on the *fixture's* command line and
 * never on AO's.
 */
function addDirtySubmodule(worktreePath: string): string {
  const inner = createRepoFixture({
    defaultBranch: 'main',
    profile: null,
    files: { 'f.txt': `one${NEWLINE}` },
  });
  git(worktreePath, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--quiet',
    inner.split('\\').join('/'),
    'vendor',
  ]);
  git(worktreePath, ['add', '--all']);
  git(worktreePath, ['commit', '--quiet', '-m', 'AO:V3-11:vendor']);
  const base = git(worktreePath, ['rev-parse', 'HEAD']).trim();

  writeFileInWorktree(join(worktreePath, 'vendor'), 'f.txt', `two${NEWLINE}`);
  git(worktreePath, ['config', 'submodule.vendor.ignore', 'all']);
  return base;
}

/* ──────────────────────────────── harness ───────────────────────────────── */

/** A repository with one startable task and `src` as its only allowed path. */
async function readyRepo(): Promise<{ repository: ResolvedRepository; root: string }> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      [`tasks/${TASK_ID}.md`]: [
        '---',
        `id: ${TASK_ID}`,
        'title: read a quota reset instant',
        'status: OPEN',
        'kind: NORMAL',
        'priority: NORMAL',
        'currentFocus: true',
        'dependsOn: []',
        '---',
        'Do the described thing.',
      ].join('\n'),
    },
  });
  return { repository: await resolveFixture(root), root };
}

/** Drives the task through production code to `IMPLEMENTING`, ready to step. */
async function implementing(): Promise<{
  repository: ResolvedRepository;
  root: string;
  current: StateLoadSuccess;
  worktreePath: string;
}> {
  const { repository, root } = await readyRepo();
  const started = await startTask(
    { repository, taskId: TASK_ID },
    {
      git: runGitCommand,
      now: () => '2026-08-22T09:00:00.000Z',
      authPreflight: authPreflightPasses,
      lease: leaseFor(repository),
    },
  );
  expect(started.outcome).toBe('STARTED');

  const { runWorktreeReadyStep, runContextLoadingStep } = await import('../src/loop/loop-step.js');
  let current = reload(root);
  expect((await runWorktreeReadyStep(current, stepDeps(current, repository))).outcome).toBe(
    'ADVANCED',
  );
  current = reload(root);
  expect((await runContextLoadingStep(current, stepDeps(current, repository))).outcome).toBe(
    'ADVANCED',
  );
  current = reload(root);
  expect(current.state.state).toBe('IMPLEMENTING');

  return { repository, root, current, worktreePath: current.state.worktreePath };
}

function reload(root: string): StateLoadSuccess {
  const loaded = loadTaskState(root, TASK_ID);
  if (loaded.classification !== 'STATE_VALID') {
    throw new Error(`state not valid: ${loaded.classification}`);
  }
  return loaded;
}

function stepDeps(
  current: StateLoadSuccess,
  repository: ResolvedRepository,
  overrides: Partial<LoopDependencies> = {},
): LoopDependencies {
  return {
    now: '2026-08-22T10:00:00.000Z',
    authorisedWorktreePath: current.state.worktreePath,
    verification: repository.verification,
    brief: readExecutionBrief(repository, TASK_ID, current.state.worktreePath),
    lease: leaseAuthorityFor(repository),
    ...overrides,
  };
}

/** The resume decision for `state` against the world as it stands right now. */
async function decide(
  state: Parameters<typeof classifyResume>[0],
  repository: ResolvedRepository,
  now: string,
): Promise<ReturnType<typeof classifyResume>> {
  const observed = await observeRuntime(runGitCommand, state);
  return classifyResume(state, observed, {
    now,
    authEvidence: provenAuthEvidence(),
    repository: {
      id: repository.id,
      root: repository.root,
      defaultBranch: repository.defaultBranch,
    },
    taskId: TASK_ID,
  });
}

/** Writes a file inside a directory, creating parents. */
function writeFileInWorktree(root: string, relativePath: string, contents?: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents ?? `export const appeared = 1;${NEWLINE}`, 'utf8');
}
