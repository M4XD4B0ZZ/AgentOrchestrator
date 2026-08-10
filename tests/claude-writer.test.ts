/**
 * V1-05 — the Claude writer boundary.
 *
 * The property under test throughout is a negative one: *nothing* short of a
 * positively recognised result envelope, produced by a process that ended
 * cleanly under its own control, may be read as a completed writing run.
 *
 * Several of the cases below look redundant and are not. `runCommand` reports
 * a child killed from outside this process as a normal completion — nothing
 * here issued the termination, so from its point of view the child simply
 * ended — which means `outcome` alone, `exitCode` alone and `signal` alone are
 * each individually insufficient. Each has its own case so that removing any
 * one of the three conditions fails a named test rather than silently widening
 * what counts as success.
 *
 * No test in this file starts a real `claude`. The seam is injected, which is
 * what makes a quota refusal, a truncated transcript and a process killed
 * mid-sentence reproducible on demand instead of hoped for.
 */

import { describe, expect, it } from 'vitest';

import type { AgentCommandResult, AgentRunner } from '../src/agent/agent-command.js';
import {
  AGENT_FAILURE_TEXT,
  DIAGNOSTIC_EXCERPT_LIMIT,
  REDACTION_OVERLAP,
} from '../src/agent/agent-outcome.js';
import {
  CLAUDE_WRITER_ARGS,
  runClaudeWriter,
  type ClaudeWriterRequest,
} from '../src/agent/claude-writer.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import { agentCommandResult, claudeSuccessEnvelope, SENSITIVE_MARKER } from './fixtures.js';

const WORKTREE = '/srv/worktrees/alpha/task-0001';

interface Recorder {
  readonly runner: AgentRunner;
  readonly calls: {
    agent: string;
    args: readonly string[];
    cwd: string;
    payload: string;
  }[];
}

/** A seam that answers with a fixed result and records exactly how it was called. */
function scriptedAgent(result: AgentCommandResult): Recorder {
  const calls: Recorder['calls'] = [];
  const runner: AgentRunner = async (agent, args, cwd, payload) => {
    calls.push({ agent, args, cwd, payload });
    return result;
  };
  return { runner, calls };
}

function request(overrides: Partial<ClaudeWriterRequest> = {}): ClaudeWriterRequest {
  return {
    worktreePath: WORKTREE,
    phase: 'IMPLEMENT',
    round: 1,
    payload: 'implement the task',
    ...overrides,
  };
}

async function writerWith(
  result: AgentCommandResult,
  overrides: Partial<ClaudeWriterRequest> = {},
) {
  const agent = scriptedAgent(result);
  const outcome = await runClaudeWriter(request(overrides), { agent: agent.runner });
  return { outcome, agent };
}

// ── The positive control ───────────────────────────────────────────────────

describe('a writing run that positively succeeded', () => {
  it('completes on a recognised result envelope from a clean process', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ stdout: claudeSuccessEnvelope() }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.disposition).toBe('AGENT_COMPLETED');
    expect(outcome.agent).toBe('claude');
    expect(outcome.phase).toBe('IMPLEMENT');
    expect(outcome.round).toBe(1);
  });

  /**
   * The control that keeps every refusal below honest. A suite in which the
   * boundary simply never succeeds would satisfy all of them.
   */
  it('is the only case in this file that reaches AGENT_COMPLETED', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ stdout: claudeSuccessEnvelope() }),
    );
    expect(outcome.ok).toBe(true);
  });
});

// ── Invocation ─────────────────────────────────────────────────────────────

describe('how the writer is invoked', () => {
  it('passes the instructions as a payload and never as an argument', async () => {
    const { agent } = await writerWith(agentCommandResult({ stdout: claudeSuccessEnvelope() }), {
      payload: 'a prompt with spaces, "quotes" & a pipe |',
    });

    const call = agent.calls[0];
    expect(call?.payload).toBe('a prompt with spaces, "quotes" & a pipe |');
    expect(call?.args).toEqual([...CLAUDE_WRITER_ARGS]);
    for (const arg of call?.args ?? []) expect(isShellInertArgument(arg)).toBe(true);
  });

  it('runs in the worktree it was given, never in the process working directory', async () => {
    const { agent } = await writerWith(agentCommandResult({ stdout: claudeSuccessEnvelope() }));

    expect(agent.calls[0]?.cwd).toBe(WORKTREE);
    expect(agent.calls[0]?.cwd).not.toBe(process.cwd());
  });

  it('builds the same argument vector and payload for the same request', async () => {
    const first = await writerWith(agentCommandResult({ stdout: claudeSuccessEnvelope() }));
    const second = await writerWith(agentCommandResult({ stdout: claudeSuccessEnvelope() }));

    expect(first.agent.calls[0]).toEqual(second.agent.calls[0]);
  });

  it('refuses a worktree path that is not shell-inert instead of throwing', async () => {
    const agent = scriptedAgent(agentCommandResult());

    const outcome = await runClaudeWriter(
      request({ worktreePath: 'C:\\Program Files\\checkout' }),
      { agent: agent.runner },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_ARGUMENT_REFUSED');
    // Nothing was spawned: the refusal is about the request, not about a run.
    expect(agent.calls).toHaveLength(0);
  });

  it.each([
    ['a completed run', agentCommandResult({ stdout: claudeSuccessEnvelope() })],
    ['a non-zero exit', agentCommandResult({ exitCode: 1 })],
    ['an unavailable process', agentCommandResult({ outcome: 'UNAVAILABLE', exitCode: null })],
    ['a truncated stream', agentCommandResult({ outcome: 'UNAVAILABLE', outputTruncated: true })],
  ])('starts exactly one process for %s, never a retry', async (_label, result) => {
    const { agent } = await writerWith(result);
    expect(agent.calls).toHaveLength(1);
  });
});

// ── Evidence precedence ────────────────────────────────────────────────────

describe('process evidence outranks anything the agent printed', () => {
  it('refuses a perfect envelope from a process that did not run cleanly', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        outcome: 'UNAVAILABLE',
        exitCode: 0,
        stdout: claudeSuccessEnvelope(),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
  });

  /**
   * The trap that motivated `ranCleanly`. A child killed by something outside
   * this process is reported by `runCommand` as a normal completion — nothing
   * here asked for its termination — with a null exit code and a signal. A
   * success rule that only asked whether the run "completed" accepts it.
   */
  it('refuses a perfect envelope from a child that ended without an exit code', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        exitCode: null,
        signal: 'SIGKILL',
        stdout: claudeSuccessEnvelope(),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.process.signal).toBe('SIGKILL');
  });

  /**
   * Node reports a signalled child with a null exit code, so the case above
   * would be refused by the exit-code check alone and does not, on its own,
   * prove the signal is consulted. This one does: a zero exit code carried
   * alongside a signal is refused because of the signal and nothing else.
   *
   * The combination is not reachable from Node today, which is the argument
   * for checking it rather than against — the seam's type permits it, so a
   * future producer of an `AgentCommandResult` (a different transport, a
   * replayed transcript) could present it, and "completed with a signal" must
   * not be the one shape that slips through as success.
   *
   * The *diagnosis* is what V1-05-RR-F3 corrected. A run whose exit status was
   * zero is not a "non-zero exit", and saying so put an untrue sentence in
   * front of the person holding the failure. `AGENT_NONZERO_EXIT` documents
   * itself as "exited non-zero **without any recognised signal**"; a signalled
   * run belongs to `AGENT_PROCESS_UNAVAILABLE`, which already says "it was
   * terminated". Same disposition, truthful sentence.
   */
  it('refuses a run that reports both a zero exit and a signal, as a terminated process', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        exitCode: 0,
        signal: 'SIGTERM',
        stdout: claudeSuccessEnvelope(),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.detail).toBe(AGENT_FAILURE_TEXT['AGENT_PROCESS_UNAVAILABLE']);
    expect(outcome.process.signal).toBe('SIGTERM');
  });

  it('refuses a perfect envelope carried on a non-zero exit', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ exitCode: 1, stdout: claudeSuccessEnvelope() }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_NONZERO_EXIT');
  });

  /**
   * A stream cut at its byte budget can still end on a closing brace and parse
   * as perfect JSON. Parsing before checking truncation is therefore not a
   * theoretical mistake — it is the mistake that turns a cut-off transcript
   * into a completed run.
   */
  it('refuses a truncated stream that happens to parse', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        outcome: 'UNAVAILABLE',
        outputTruncated: true,
        stdout: claudeSuccessEnvelope(),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.process.outputTruncated).toBe(true);
  });
});

// ── The result envelope ────────────────────────────────────────────────────

describe('the result envelope is recognised, never assumed', () => {
  it.each([
    ['an empty stdout', ''],
    ['whitespace only', '   \n  '],
    ['prose', 'Done! I have implemented the task.'],
    ['a JSON array', '[{"type":"result","subtype":"success","is_error":false}]'],
    ['a JSON string', '"success"'],
    ['a truncated object', '{"type":"result","subtype":"suc'],
    ['some other envelope', JSON.stringify({ type: 'assistant', subtype: 'success' })],
    ['a missing subtype', JSON.stringify({ type: 'result', is_error: false })],
    [
      'an unknown subtype',
      JSON.stringify({ type: 'result', subtype: 'partial', is_error: false, api_error_status: null }),
    ],
    [
      'an error envelope',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: null }),
    ],
    [
      'a non-boolean is_error',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: 'false' }),
    ],
  ])('refuses to read %s as a completed run', async (_label, stdout) => {
    const { outcome } = await writerWith(agentCommandResult({ stdout }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
  });

  /**
   * The envelope is the whole of stdout, not something found inside it. This
   * repository's own reviewer reads this repository, so an agent quoting a
   * success envelope out of a source file or a test is an ordinary event, not
   * an attack scenario.
   */
  it('refuses an envelope quoted inside a larger document', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        stdout: `The file contains ${claudeSuccessEnvelope()} on line 12.`,
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
  });

  it('refuses an envelope that claims success while carrying an API error status', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ stdout: claudeSuccessEnvelope({ api_error_status: 500 }) }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
  });
});

// ── Usage limit ────────────────────────────────────────────────────────────

describe('usage exhaustion is recognised structurally, never from prose', () => {
  it.each([[429], ['429']])(
    'classifies an error envelope carrying api_error_status %j as a usage limit',
    async (status) => {
      const { outcome } = await writerWith(
        agentCommandResult({
          exitCode: 1,
          stdout: claudeSuccessEnvelope({ is_error: true, subtype: 'error', api_error_status: status }),
        }),
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) expect.unreachable();
      expect(outcome.code).toBe('AGENT_USAGE_LIMIT');
      expect(outcome.disposition).toBe('AGENT_BLOCKED_USAGE_LIMIT');
    },
  );

  /**
   * Above the exit-code check on purpose. A quota refusal exits non-zero, so a
   * boundary that read the exit code first would bury every usage limit as an
   * ordinary failure — and lose the one outcome a run driver is supposed to
   * pause on rather than escalate.
   */
  it('reports the usage limit rather than the non-zero exit that carries it', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        exitCode: 1,
        stdout: claudeSuccessEnvelope({ is_error: true, subtype: 'error', api_error_status: 429 }),
      }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.code).not.toBe('AGENT_NONZERO_EXIT');
  });

  it('carries the block evidence the state contract requires', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        exitCode: 1,
        stdout: claudeSuccessEnvelope({ is_error: true, subtype: 'error', api_error_status: 429 }),
      }),
      { phase: 'REMEDIATE', round: 2 },
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.block).toEqual({
      blockedAgent: 'claude',
      resumeFrom: { phase: 'REMEDIATE', round: 2 },
      // Never invented. No reset timestamp was observed in this CLI's envelope,
      // so none is reported, and no unattended resume can be granted on one.
      reportedResetAt: null,
    });
  });

  it('records a resume round of at least 1, even for an untouched round counter', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        exitCode: 1,
        stdout: claudeSuccessEnvelope({ is_error: true, subtype: 'error', api_error_status: 429 }),
      }),
      { round: 0 },
    );

    if (outcome.ok) expect.unreachable();
    // `reviewRound` starts at 0 but `ResumePointSchema` requires 1: a first
    // pass interrupted before any review completed must still record a state
    // the contract accepts.
    expect(outcome.block?.resumeFrom.round).toBe(1);
  });

  /**
   * The mutation this kills is `stdout.includes('usage limit')`, and the
   * scenario is not hypothetical: the reviewer in this very system reads this
   * repository, so any sentinel phrase would eventually be matched against a
   * review that quotes the sentinel's own source file.
   */
  it.each([
    ['a limit phrase in a successful run', claudeSuccessEnvelope({ result: 'usage limit reached' })],
    [
      'a limit phrase quoted in prose',
      claudeSuccessEnvelope({ result: 'The file says "Claude usage limit reached. Resets at 3pm".' }),
    ],
  ])('does not read %s as a usage limit', async (_label, stdout) => {
    const { outcome } = await writerWith(agentCommandResult({ stdout }));

    expect(outcome.ok).toBe(true);
    expect(outcome.disposition).toBe('AGENT_COMPLETED');
  });

  it('does not read a limit phrase on stderr as authority', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        stdout: claudeSuccessEnvelope(),
        stderr: 'Claude usage limit reached. Your limit will reset at 3pm.',
      }),
    );

    expect(outcome.disposition).toBe('AGENT_COMPLETED');
  });

  /**
   * A killed or never-started process has said nothing about anyone's quota.
   * Classifying one as a usage limit would park a task on a timer for an
   * infrastructure fault.
   */
  it('does not read an unavailable process as a usage limit, whatever it printed', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        outcome: 'UNAVAILABLE',
        exitCode: null,
        stdout: claudeSuccessEnvelope({ is_error: true, api_error_status: 429 }),
      }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
  });

  /**
   * V1-05-RR-F1. The case above is caught by `outcome`, and so it never proved
   * anything about a run the seam *did* report as `RAN`.
   *
   * `runCommand` reports a child killed from outside this process as an
   * ordinary completion — nothing here issued the termination — so a SIGKILLed
   * agent arrives as `{outcome:'RAN', exitCode:null, signal:'SIGKILL'}` with
   * whatever bytes it had already written. If those bytes happen to be a
   * structurally perfect 429 envelope, reading them before the signal parks the
   * task on `BLOCKED_USAGE_LIMIT`: a governed pause, waiting on a quota that
   * was never the reason, for what is an infrastructure kill.
   *
   * The invariant is therefore stronger than "recognise 429 structurally": a
   * process terminated by a signal is never classified from its own output at
   * all — not as a success, and not as a usage limit.
   */
  it('does not let a signalled run be reclassified as a usage limit by its own output', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        outcome: 'RAN',
        exitCode: null,
        signal: 'SIGKILL',
        stdout: claudeSuccessEnvelope({ is_error: true, subtype: 'error', api_error_status: 429 }),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
    // No block evidence, so nothing downstream can record a resume point or a
    // reset time for a limit that was never reported.
    expect(outcome.block).toBeNull();
  });

  /**
   * The same, with the one difference that makes it a distinct mutation: a zero
   * exit code. Without the signal guard this input reaches the envelope reader
   * exactly as the case above does, and neither the exit-code check nor
   * `ranCleanly` gets a chance to disagree first.
   */
  it('does not let a signalled run with a zero exit be read as a usage limit', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        outcome: 'RAN',
        exitCode: 0,
        signal: 'SIGTERM',
        stdout: claudeSuccessEnvelope({ is_error: true, subtype: 'error', api_error_status: 429 }),
      }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.block).toBeNull();
  });

  /**
   * V1-05-RR-F2. The envelope reader recognises a quota refusal only when the
   * envelope also admits to being an error, and that guard had no test of its
   * own: every 429 case in this file sets `is_error:true`, so deleting the
   * condition left the whole suite green.
   *
   * A success that carries a 429 is a contradiction. It must fail closed to
   * `AGENT_RESULT_MALFORMED` — an inconsistent envelope is not authority for a
   * pause any more than prose is.
   */
  it.each([[429], ['429']])(
    'refuses an envelope that claims success while carrying api_error_status %j',
    async (status) => {
      const { outcome } = await writerWith(
        agentCommandResult({
          stdout: claudeSuccessEnvelope({ is_error: false, api_error_status: status }),
        }),
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) expect.unreachable();
      expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
      expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
      expect(outcome.block).toBeNull();
    },
  );

  /**
   * The other half of the guard, so that "inconsistent" is not quietly narrowed
   * to "429". A non-null error status on an envelope claiming success is
   * unrecognised whatever the status is.
   */
  it('refuses an envelope that claims success while carrying a non-429 error status', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ stdout: claudeSuccessEnvelope({ is_error: false, api_error_status: 503 }) }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
  });

  /**
   * The positive control for the two above: with the guard in place a genuine
   * error envelope carrying 429 is still recognised as the usage limit it is,
   * so the fix cannot be "stop recognising quota refusals".
   */
  it('still recognises a genuine error envelope carrying 429', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({
        exitCode: 1,
        stdout: claudeSuccessEnvelope({ is_error: true, subtype: 'error', api_error_status: 429 }),
      }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_USAGE_LIMIT');
  });
});

// ── Failing closed ─────────────────────────────────────────────────────────

describe('an unclassifiable run fails closed', () => {
  it.each([
    ['a bare non-zero exit', agentCommandResult({ exitCode: 2 })],
    ['a spawn failure', agentCommandResult({ outcome: 'UNAVAILABLE', exitCode: null })],
    ['unrecognised output', agentCommandResult({ stdout: 'something went wrong' })],
    ['an unsafe argument', agentCommandResult({ outcome: 'REFUSED_UNSAFE_ARGUMENT', exitCode: null })],
  ])('escalates %s to a human decision rather than guessing', async (_label, result) => {
    const { outcome } = await writerWith(result);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
    expect(outcome.block).toBeNull();
  });
});

// ── Untrusted text ─────────────────────────────────────────────────────────

describe('the agent\u2019s own words are carried, never trusted', () => {
  /** The raw prefix the redactors are shown before anything is thrown away. */
  const RAW_WINDOW = DIAGNOSTIC_EXCERPT_LIMIT + REDACTION_OVERLAP;
  /** An ordinary credential \u2014 24 characters, the size real ones come in. */
  const SECRET = 'm4xd4b0zz@googlemail.com';

  it('reports only static text as the failure detail', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ exitCode: 1, stdout: SENSITIVE_MARKER, stderr: SENSITIVE_MARKER }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.detail).toBe(AGENT_FAILURE_TEXT[outcome.code]);
    expect(outcome.detail).not.toContain(SENSITIVE_MARKER);
  });

  it('quarantines the diagnostics it keeps rather than presenting them as a result', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ exitCode: 1, stdout: SENSITIVE_MARKER, stderr: 'boom' }),
    );

    // Kept, because a human debugging a failed run needs it...
    expect(outcome.diagnostics.stdoutExcerpt).toContain(SENSITIVE_MARKER);
    // ...and marked, so no caller can serialise it into a durable artefact
    // believing it to be a result.
    expect(outcome.diagnostics.trusted).toBe(false);
  });

  /**
   * The size here is the point. An agent's stream budget is 8 MiB, and an
   * implementation that redacts the whole stream before clamping it — which is
   * what `redactAndClamp` does, and what this boundary therefore does not
   * use — took roughly thirty seconds on a 200 KB input on this machine.
   * Describing a failed run must not cost more than the run.
   */
  it('bounds the diagnostics it keeps promptly, and says so where it cut', async () => {
    const started = Date.now();
    const { outcome } = await writerWith(
      agentCommandResult({ exitCode: 1, stdout: 'x'.repeat(4_000_000) }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);

    const excerpt = outcome.diagnostics.stdoutExcerpt;
    // The budget is the budget: the notice saying where the cut fell is counted
    // inside it, not added on top. What matters is that a runaway agent cannot
    // decide how much memory its diagnostics occupy.
    expect(excerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
    expect(excerpt).toContain('truncated');
    // Still recognisably the head of the stream, not a stub.
    expect(excerpt.startsWith('x'.repeat(3_500))).toBe(true);
  });

  /**
   * V1-05-RR-F6. The case above cannot detect this defect, because a stream of
   * `x`s is the one input class on which redaction is a no-op.
   *
   * Redaction *expands*: `a@b.co` (6 characters) becomes `<redacted:email>`
   * (16). Clamping the raw text to the budget and redacting afterwards
   * therefore returns something far larger than the budget — measured at 9 745
   * characters for this input, 2.4× the limit — and the limit is the only thing
   * standing between an 8 MiB stream budget and the memory a failed run costs
   * to describe.
   */
  it('holds the budget even when redaction expands what it kept', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ exitCode: 1, stdout: 'a@b.co '.repeat(600) }),
    );

    const excerpt = outcome.diagnostics.stdoutExcerpt;
    expect(excerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
    expect(excerpt).toContain('<redacted:email>');
    expect(excerpt).not.toContain('a@b.co');
  });

  /**
   * The same expansion below the truncation threshold, where the old fast path
   * returned `redact(text)` with no clamp at all — so a 3 500-character stdout
   * could still produce an 8 500-character excerpt.
   */
  it('holds the budget for a stream that never needed truncating', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ exitCode: 1, stdout: 'a@b.co '.repeat(500) }),
    );

    expect(outcome.diagnostics.stdoutExcerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
  });

  /**
   * The boundary leak, which is the half of V1-05-RR-F6 that is a safety
   * property rather than a size one.
   *
   * Every redaction rule anchors on a suffix — a TLD, an `{8,}` token body.
   * Cutting the raw text mid-secret amputates that suffix, so the surviving
   * prefix matches no rule and is emitted verbatim: clamping first used to
   * print `m4xd4b0zz@googlemail.` in the clear where redacting first prints
   * `<redacted:email>`. Truncation must not be a way to defeat redaction.
   */
  it('does not expose a secret that straddles the point where it cuts', async () => {
    const secret = 'm4xd4b0zz@googlemail.com';
    const { outcome } = await writerWith(
      agentCommandResult({
        exitCode: 1,
        stdout: `${'x'.repeat(DIAGNOSTIC_EXCERPT_LIMIT - 21)} ${secret} ${'y'.repeat(2_000)}`,
      }),
    );

    const excerpt = outcome.diagnostics.stdoutExcerpt;
    expect(excerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
    // Neither whole nor halved: no part of the local part or the domain.
    expect(excerpt).not.toContain('m4xd4b0zz');
    expect(excerpt).not.toContain('googlemail');
  });

  /**
   * The same property swept across the boundary, because a single offset only
   * proves that one alignment is safe. Every one of these places the secret so
   * that it either straddles the budget or sits just inside it; none may leak a
   * fragment.
   */
  it.each([-40, -24, -12, -1, 0, 8, 20])(
    'does not expose a secret placed at budget offset %i',
    async (offset) => {
      const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA';
      const lead = DIAGNOSTIC_EXCERPT_LIMIT + offset;
      const { outcome } = await writerWith(
        agentCommandResult({
          exitCode: 1,
          stdout: `${'x'.repeat(lead)} ${secret} ${'y'.repeat(2_000)}`,
        }),
      );

      const excerpt = outcome.diagnostics.stdoutExcerpt;
      expect(excerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
      expect(excerpt).not.toContain('sk-ant');
    },
  );

  /**
   * The far edge of the redaction window, which the cases above cannot reach.
   *
   * Widening the window moves the bisection risk rather than removing it: an
   * entity straddling the window's own end still loses its tail. It normally
   * falls outside the excerpt anyway — but only because redaction roughly
   * preserves length, and one rule does not. A JWT collapses from thousands of
   * characters to fourteen, and that shrinkage drags whatever followed it back
   * inside the budget.
   *
   * So this input is built to land a *fragment* of a token in the excerpt: a
   * long JWT that redacts to almost nothing, then a token positioned so that
   * only its first nine characters lie inside the window — too few for the
   * `{8,}` body the rule requires, so the fragment matches nothing and would be
   * printed verbatim. Dropping the trailing partial run is what removes it.
   */
  it('does not expose a token bisected by the far edge of the redaction window', async () => {
    const visible = 9;
    const lead = DIAGNOSTIC_EXCERPT_LIMIT + REDACTION_OVERLAP - visible - 1;
    const jwt = `eyJ${'A'.repeat(lead - 3)}`;
    const stdout = `${jwt} sk-ant-api03-${'S'.repeat(400)} ${'y'.repeat(2_000)}`;

    const { outcome } = await writerWith(agentCommandResult({ exitCode: 1, stdout }));
    const excerpt = outcome.diagnostics.stdoutExcerpt;

    // The premise: the window really does cut this token after nine characters.
    expect(stdout.slice(lead + 1, DIAGNOSTIC_EXCERPT_LIMIT + REDACTION_OVERLAP)).toBe('sk-ant-ap');
    expect(excerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
    expect(excerpt).toContain('<redacted:jwt>');
    expect(excerpt).not.toContain('sk-ant');
  });

  /**
   * V1-05-RR-F6 / NEW-1, and the case the test above was too kind to find.
   *
   * That one leaves a space ten characters before the bisected token, so the
   * bounded backward scan finds it. The bound, though, is on the *run*, while
   * the reasoning behind it — "1 KiB is far larger than any credential these
   * rules recognise" — is about the *credential*. Minified agent output makes
   * the two diverge: a 24-character e-mail inside a 3 000-character
   * whitespace-free run is bisected by the window's far edge, matches nothing
   * without its TLD, and the scan gives up two thousand characters short of
   * the whitespace it needed.
   *
   * The JWT is what makes the fragment reachable at all: it collapses 2 000
   * characters to fourteen, so the redacted window is 3 038 characters against
   * a body cap of ~3 946 — the clamp discards nothing, and the raw cut becomes
   * the end of the excerpt.
   */
  it('does not expose a credential the window bisects inside a long unbroken run', async () => {
    const jwt = `eyJ${'A'.repeat(1_997)}`;
    const visible = 'm4xd4b0zz@googlemail.'.length;
    const run = '#'.repeat(RAW_WINDOW - visible - jwt.length - 1);
    const stdout = `${jwt} ${run}${SECRET}${'#'.repeat(73)}`;

    // The premise, asserted rather than assumed: the window really does cut
    // this credential before its TLD, and the run carrying it really is longer
    // than the margin the backward scan is allowed to look back over.
    expect(stdout.slice(RAW_WINDOW - visible, RAW_WINDOW)).toBe('m4xd4b0zz@googlemail.');
    expect(stdout.indexOf(' ', jwt.length + 1)).toBe(-1);
    expect(run.length).toBeGreaterThan(REDACTION_OVERLAP);

    const { outcome } = await writerWith(agentCommandResult({ exitCode: 1, stdout }));
    const excerpt = outcome.diagnostics.stdoutExcerpt;

    expect(excerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
    // Neither whole nor halved: no part of the local part or the domain.
    expect(excerpt).not.toContain('m4xd4b0zz');
    expect(excerpt).not.toContain('googlemail');
    // ...and what came before the cut is still there. Safety here is bought by
    // dropping the margin, not by emptying the excerpt.
    expect(excerpt).toContain('<redacted:jwt>');
    expect(excerpt).toContain('truncated');
  });

  /**
   * The control for the case above. The same credential, the same shrinking
   * JWT, the same unbroken run — moved so that it lies wholly inside the text
   * the excerpt keeps. Nothing about the boundary rule may weaken redaction of
   * a credential that was never near the boundary.
   */
  it('redacts that same credential when it lies wholly inside what is kept', async () => {
    const jwt = `eyJ${'A'.repeat(1_997)}`;
    const run = '#'.repeat(1_000);
    const stdout = `${jwt} ${run}${SECRET}${'#'.repeat(2_075)}`;

    const at = jwt.length + 1 + run.length;
    expect(stdout.indexOf(SECRET)).toBe(at);
    expect(at + SECRET.length).toBeLessThan(DIAGNOSTIC_EXCERPT_LIMIT);

    const { outcome } = await writerWith(agentCommandResult({ exitCode: 1, stdout }));
    const excerpt = outcome.diagnostics.stdoutExcerpt;

    expect(excerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
    expect(excerpt).toContain('<redacted:email>');
    expect(excerpt).not.toContain('m4xd4b0zz');
    expect(excerpt).not.toContain('googlemail');
  });

  /**
   * The other half of the same rule, and the reason it cannot simply be "drop
   * whatever trails". A stream that legitimately contains no whitespace at all
   * — minified JSON is the ordinary case — must still be described, promptly
   * and within the budget.
   */
  it('keeps a whitespace-free stream bounded and prompt without emptying it', async () => {
    const started = Date.now();
    const { outcome } = await writerWith(
      agentCommandResult({ exitCode: 1, stdout: '#'.repeat(2_000_000) }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);

    const excerpt = outcome.diagnostics.stdoutExcerpt;
    expect(excerpt.length).toBe(DIAGNOSTIC_EXCERPT_LIMIT);
    expect(excerpt.startsWith('#'.repeat(3_500))).toBe(true);
    expect(excerpt).toContain('truncated; 2000000 characters in the original stream');
  });

  /**
   * The bound itself, swept across the threshold. Below and at the limit the
   * stream is the excerpt; one character above it, the notice appears — and it
   * is counted inside the budget, never added on top of it.
   */
  it.each([
    ['below', DIAGNOSTIC_EXCERPT_LIMIT - 1, false],
    ['exactly at', DIAGNOSTIC_EXCERPT_LIMIT, false],
    ['one past', DIAGNOSTIC_EXCERPT_LIMIT + 1, true],
  ] as [string, number, boolean][])(
    'holds the total bound for a stream %s the limit',
    async (_label, size, truncated) => {
      const stdout = 'd'.repeat(size);
      const { outcome } = await writerWith(agentCommandResult({ exitCode: 1, stdout }));
      const excerpt = outcome.diagnostics.stdoutExcerpt;

      expect(excerpt.length).toBeLessThanOrEqual(DIAGNOSTIC_EXCERPT_LIMIT);
      expect(excerpt.includes('truncated')).toBe(truncated);
      if (truncated) expect(excerpt.endsWith('characters in the original stream]')).toBe(true);
      else expect(excerpt).toBe(stdout);
    },
  );

  /** A short diagnostic is redacted and otherwise returned as it stands. */
  it('leaves a short diagnostic exactly as redaction left it', async () => {
    const { outcome } = await writerWith(
      agentCommandResult({ exitCode: 1, stdout: `contact ${SECRET} now` }),
    );

    expect(outcome.diagnostics.stdoutExcerpt).toBe('contact <redacted:email> now');
  });
});
