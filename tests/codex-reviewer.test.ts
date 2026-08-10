/**
 * V1-05 — the Codex reviewer boundary.
 *
 * Two properties are under test, and they pull in opposite directions, which
 * is why both need saying:
 *
 *  1. **A pass is never inferred.** Not from an empty stdout, not from exit
 *     code 0, not from a missing review document, not from a parser failure,
 *     not from a truncated transcript, not from a turn that never completed.
 *  2. **A review that found nothing is a real answer**, and must survive all
 *     of the above being true. A boundary that simply never passes satisfies
 *     property 1 perfectly and is useless, so the positive control is not a
 *     courtesy — it is what makes the other cases mean anything.
 *
 * The adversarial cases are grounded rather than imagined. The reviewer in
 * this system reads *this* repository, so a review whose text quotes a passing
 * review document out of this very file is an ordinary event. Any rule that
 * searched output for a verdict rather than validating the whole of it would
 * eventually read a test fixture as a verdict.
 */

import { describe, expect, it } from 'vitest';

import type { AgentCommandResult, AgentRunner } from '../src/agent/agent-command.js';
import { AGENT_FAILURE_TEXT } from '../src/agent/agent-outcome.js';
import {
  CODEX_REVIEWER_ARGS,
  codexReviewResumePoint,
  runCodexReviewer,
  type CodexReviewRequest,
} from '../src/agent/codex-reviewer.js';
import { FINDING_SEVERITIES } from '../src/core/states.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import { agentCommandResult, codexTranscript, passingReview } from './fixtures.js';

const WORKTREE = '/srv/worktrees/alpha/task-0001';

interface Recorder {
  readonly runner: AgentRunner;
  readonly calls: { agent: string; args: readonly string[]; cwd: string; payload: string }[];
}

function scriptedAgent(result: AgentCommandResult): Recorder {
  const calls: Recorder['calls'] = [];
  const runner: AgentRunner = async (agent, args, cwd, payload) => {
    calls.push({ agent, args, cwd, payload });
    return result;
  };
  return { runner, calls };
}

function request(overrides: Partial<CodexReviewRequest> = {}): CodexReviewRequest {
  return { worktreePath: WORKTREE, round: 1, payload: 'review the diff', ...overrides };
}

async function reviewWith(
  result: AgentCommandResult,
  overrides: Partial<CodexReviewRequest> = {},
) {
  const agent = scriptedAgent(result);
  const outcome = await runCodexReviewer(request(overrides), { agent: agent.runner });
  return { outcome, agent };
}

const finding = (severity: string, path = 'src/core/states.ts', rule = 'AO-001') => ({
  severity,
  path,
  rule,
});

// ── The positive controls ──────────────────────────────────────────────────

describe('a review that positively completed', () => {
  it('reads a validated PASS document as a review that found nothing', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({ stdout: codexTranscript(passingReview()) }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) expect.unreachable();
    expect(outcome.disposition).toBe('AGENT_COMPLETED');
    expect(outcome.findings).toEqual([]);
  });

  it('reads a validated FINDINGS document as a review that found something', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({
          reviewVersion: 1,
          verdict: 'FINDINGS',
          findings: [finding('high'), finding('low', 'src/state/state-store.ts', 'AO-002')],
        }),
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) expect.unreachable();
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings.map((f) => f.severity)).toEqual(['high', 'low']);
  });

  /**
   * An empty finding list and a failed review are different facts, and the
   * type system is what keeps them apart: `findings` exists only on the
   * completed member, so a caller cannot read a failure as "zero findings"
   * without first narrowing on `ok`.
   */
  it('offers no finding list at all on a review that did not complete', async () => {
    const { outcome } = await reviewWith(agentCommandResult({ stdout: '' }));

    expect(outcome.ok).toBe(false);
    expect(outcome).not.toHaveProperty('findings');
  });
});

// ── Fingerprints ───────────────────────────────────────────────────────────

describe('finding identity is computed here, not supplied by the reviewer', () => {
  it('fingerprints the same finding identically across two reviews', async () => {
    const document = {
      reviewVersion: 1,
      verdict: 'FINDINGS',
      findings: [finding('critical')],
    };
    const first = await reviewWith(agentCommandResult({ stdout: codexTranscript(document) }));
    const second = await reviewWith(agentCommandResult({ stdout: codexTranscript(document) }));

    if (!first.outcome.ok || !second.outcome.ok) expect.unreachable();
    expect(first.outcome.findings[0]?.fingerprint).toBe(second.outcome.findings[0]?.fingerprint);
  });

  it('gives different findings different fingerprints', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({
          reviewVersion: 1,
          verdict: 'FINDINGS',
          findings: [
            finding('high', 'src/a.ts', 'R1'),
            finding('high', 'src/a.ts', 'R2'),
            finding('high', 'src/b.ts', 'R1'),
            finding('low', 'src/a.ts', 'R1'),
          ],
        }),
      }),
    );

    if (!outcome.ok) expect.unreachable();
    expect(new Set(outcome.findings.map((f) => f.fingerprint)).size).toBe(4);
  });

  /**
   * `fingerprint` is the only free-form string in the persisted state
   * contract. A reviewer that could choose it would be choosing what gets
   * written durably into a task's history — so it does not get to, and a
   * `fingerprint` field in the document is ignored rather than honoured.
   */
  it('ignores a fingerprint the reviewer tried to supply', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({
          reviewVersion: 1,
          verdict: 'FINDINGS',
          findings: [{ ...finding('high'), fingerprint: 'zzCHOSEN-BY-THE-REVIEWERzz' }],
        }),
      }),
    );

    if (!outcome.ok) expect.unreachable();
    expect(outcome.findings[0]?.fingerprint).not.toContain('CHOSEN');
    expect(outcome.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  /**
   * A fixed width is what makes the state-size bound arithmetic rather than
   * hopeful: `saveTaskState` refuses a state over 1 MiB, and `findingHistory`
   * is the field that can grow.
   */
  it('produces a fixed-width fingerprint whatever the reviewer wrote', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({
          reviewVersion: 1,
          verdict: 'FINDINGS',
          findings: [finding('info', `src/${'a'.repeat(900)}.ts`, 'R'.repeat(100))],
        }),
      }),
    );

    if (!outcome.ok) expect.unreachable();
    expect(outcome.findings[0]?.fingerprint).toHaveLength(32);
  });
});

// ── PASS is never inferred ─────────────────────────────────────────────────

describe('a pass is never inferred', () => {
  it.each([
    ['an empty stdout', ''],
    ['whitespace only', '  \n '],
    ['prose instead of a transcript', 'The review found no problems.\n'],
    ['a transcript with no agent message', '{"type":"turn.completed"}\n'],
    [
      'a transcript whose turn never completed',
      codexTranscript(passingReview(), { completed: false }),
    ],
    ['an agent message that is not JSON', codexTranscript('Looks fine to me.')],
    ['an agent message that is truncated JSON', codexTranscript('{"reviewVersion":1,"verd')],
    ['a document with no verdict', codexTranscript({ reviewVersion: 1, findings: [] })],
    ['a document with no findings key', codexTranscript({ reviewVersion: 1, verdict: 'PASS' })],
    [
      'a document from a future contract',
      codexTranscript({ reviewVersion: 2, verdict: 'PASS', findings: [] }),
    ],
    [
      'a document with no version',
      codexTranscript({ verdict: 'PASS', findings: [] }),
    ],
    ['an unknown verdict', codexTranscript({ reviewVersion: 1, verdict: 'OK', findings: [] })],
    [
      'a lowercase verdict',
      codexTranscript({ reviewVersion: 1, verdict: 'pass', findings: [] }),
    ],
  ])('refuses to read %s as a review', async (_label, stdout) => {
    const { outcome } = await reviewWith(agentCommandResult({ stdout }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
    expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
  });

  /**
   * A document whose verdict and list disagree is not a pass with a caveat.
   * It is a document we cannot read, and the safe reading of an unreadable
   * review is never "no problems found".
   */
  it('refuses a PASS that lists findings', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({
          reviewVersion: 1,
          verdict: 'PASS',
          findings: [finding('critical')],
        }),
      }),
    );

    expect(outcome.ok).toBe(false);
  });

  it('refuses a FINDINGS verdict that lists none', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({ reviewVersion: 1, verdict: 'FINDINGS', findings: [] }),
      }),
    );

    expect(outcome.ok).toBe(false);
  });

  it('refuses exit code 0 with a valid-looking document but no completed turn', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        exitCode: 0,
        stdout: codexTranscript(passingReview(), { completed: false }),
      }),
    );

    expect(outcome.ok).toBe(false);
  });

  /**
   * The case a `try { JSON.parse } catch` guard passes and a truncation guard
   * catches: output cut exactly at a closing brace parses perfectly.
   */
  it('refuses a truncated transcript that happens to parse', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        outcome: 'UNAVAILABLE',
        outputTruncated: true,
        stdout: codexTranscript(passingReview()),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
  });

  it('refuses a valid document from a child that ended without an exit code', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        exitCode: null,
        signal: 'SIGKILL',
        stdout: codexTranscript(passingReview()),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
  });

  /**
   * The signal is consulted in its own right; see the writer suite for why.
   *
   * The diagnosis is pinned as well as the refusal (V1-05-RR-F3). Refusing for
   * an untrue reason is still a defect: this run's exit status was zero, so
   * `AGENT_NONZERO_EXIT` — documented as "exited non-zero **without any
   * recognised signal**" — would contradict both the evidence and its own
   * definition. A terminated process is `AGENT_PROCESS_UNAVAILABLE`.
   */
  it('refuses a valid document from a run reporting both a zero exit and a signal', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        exitCode: 0,
        signal: 'SIGTERM',
        stdout: codexTranscript(passingReview()),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.detail).toBe(AGENT_FAILURE_TEXT['AGENT_PROCESS_UNAVAILABLE']);
  });

  /**
   * The reviewer reads this repository, so a review quoting a passing document
   * out of this file is expected traffic, not an attack. A rule that searched
   * the transcript for a verdict would read the quotation as one.
   */
  it('does not read a review document quoted inside the review prose', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript(
          `The fixture at tests/fixtures.ts returns ${JSON.stringify(passingReview())} — looks fine.`,
        ),
      }),
    );

    expect(outcome.ok).toBe(false);
  });

  it('takes the final agent message, not an earlier one that passed', async () => {
    const lines = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'a', type: 'agent_message', text: JSON.stringify(passingReview()) },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'b',
          type: 'agent_message',
          text: JSON.stringify({
            reviewVersion: 1,
            verdict: 'FINDINGS',
            findings: [finding('critical')],
          }),
        },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');

    const { outcome } = await reviewWith(agentCommandResult({ stdout: lines }));

    if (!outcome.ok) expect.unreachable();
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe('critical');
  });
});

// ── Finding validation ─────────────────────────────────────────────────────

describe('every finding is validated before it can reach a task', () => {
  it.each([
    ['an unknown severity', [finding('blocker')]],
    ['a severity in the wrong case', [finding('HIGH')]],
    ['a numeric severity', [{ severity: 3, path: 'src/a.ts', rule: 'R' }]],
    ['a missing path', [{ severity: 'high', rule: 'R' }]],
    ['an absolute path', [finding('high', '/etc/passwd')]],
    ['a drive-letter path', [finding('high', 'C:/Windows/system32')]],
    ['a traversing path', [finding('high', 'src/../../secrets.txt')]],
    ['a backslash path', [finding('high', 'src\\core\\states.ts')]],
    ['a missing rule', [{ severity: 'high', path: 'src/a.ts' }]],
    ['a prose rule', [finding('high', 'src/a.ts', 'this rule has spaces')]],
    ['a finding that is not an object', ['high']],
  ])('refuses the whole document for %s', async (_label, findings) => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({ reviewVersion: 1, verdict: 'FINDINGS', findings }),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
  });

  /**
   * An unrecognised severity must not degrade into the least alarming known
   * one. Severity decides whether a task is blocked, so quietly rewriting
   * `blocker` as `info` would silence the finding that mattered most.
   */
  it('does not fall back to a benign severity for an unrecognised one', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({
          reviewVersion: 1,
          verdict: 'FINDINGS',
          findings: [finding('blocker')],
        }),
      }),
    );

    expect(outcome.ok).toBe(false);
  });

  it.each(FINDING_SEVERITIES)('accepts the contract severity %s', async (severity) => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({
          reviewVersion: 1,
          verdict: 'FINDINGS',
          findings: [finding(severity)],
        }),
      }),
    );

    expect(outcome.ok).toBe(true);
  });

  /**
   * Refused, not shortened. A silently truncated finding list is a review that
   * reports fewer problems than it found, which is the worst possible failure
   * mode for a reviewer.
   */
  it('refuses a review with more findings than the cap rather than truncating it', async () => {
    const findings = Array.from({ length: 65 }, (_unused, index) =>
      finding('low', `src/file-${index}.ts`, `R${index}`),
    );

    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript({ reviewVersion: 1, verdict: 'FINDINGS', findings }),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
  });
});

// ── Infrastructure is not a finding ────────────────────────────────────────

describe('a reviewer that could not run is not a reviewer that found nothing', () => {
  it.each([
    ['a process that never started', agentCommandResult({ outcome: 'UNAVAILABLE', exitCode: null })],
    ['a non-zero exit', agentCommandResult({ exitCode: 2, stdout: codexTranscript(passingReview()) })],
    [
      'an unsafe argument',
      agentCommandResult({ outcome: 'REFUSED_UNSAFE_ARGUMENT', exitCode: null }),
    ],
  ])('reports %s as an infrastructure failure, not as a review', async (_label, result) => {
    const { outcome } = await reviewWith(result);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).not.toBe('AGENT_RESULT_MALFORMED');
    expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
  });

  /**
   * No usage-limit signal has been observed from this CLI, so there is nothing
   * to recognise and nothing is guessed. An exhausted Codex allowance reaches
   * a human rather than a pause — a documented consequence of missing
   * evidence, and the fail-closed direction to be wrong in.
   */
  it('does not invent a usage limit for a Codex failure it cannot classify', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({ exitCode: 1, stderr: 'You have hit your usage limit.' }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.code).not.toBe('AGENT_USAGE_LIMIT');
    expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
    expect(outcome.block).toBeNull();
  });

  /**
   * The CLI writes diagnostics to stderr on runs that succeed — a models-cache
   * warning was observed on a healthy run at 0.146.0 — so stderr content can
   * never be read as failure.
   */
  it('ignores routine stderr noise on a run that completed', async () => {
    const { outcome } = await reviewWith(
      agentCommandResult({
        stdout: codexTranscript(passingReview()),
        stderr: 'ERROR codex_models_manager::cache: failed to load models cache\n',
      }),
    );

    expect(outcome.ok).toBe(true);
  });
});

// ── Invocation ─────────────────────────────────────────────────────────────

describe('how the reviewer is invoked', () => {
  it('asks the CLI to enforce the read-only contract it is held to', async () => {
    const { agent } = await reviewWith(
      agentCommandResult({ stdout: codexTranscript(passingReview()) }),
    );

    expect(agent.calls[0]?.args).toEqual([...CODEX_REVIEWER_ARGS]);
    expect([...CODEX_REVIEWER_ARGS]).toContain('read-only');
  });

  it('passes the review instructions as a payload and keeps every argument shell-inert', async () => {
    const { agent } = await reviewWith(
      agentCommandResult({ stdout: codexTranscript(passingReview()) }),
      { payload: 'review this & report "findings"' },
    );

    expect(agent.calls[0]?.payload).toBe('review this & report "findings"');
    for (const arg of agent.calls[0]?.args ?? []) expect(isShellInertArgument(arg)).toBe(true);
  });

  it('starts exactly one process and never retries', async () => {
    const { agent } = await reviewWith(agentCommandResult({ exitCode: 1 }));
    expect(agent.calls).toHaveLength(1);
  });

  it('offers a resume point at the review phase, never below round 1', () => {
    expect(codexReviewResumePoint(0)).toEqual({
      blockedAgent: 'codex',
      resumeFrom: { phase: 'REVIEW', round: 1 },
      reportedResetAt: null,
    });
    expect(codexReviewResumePoint(3).resumeFrom.round).toBe(3);
  });
});
