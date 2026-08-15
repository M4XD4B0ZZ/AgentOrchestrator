/**
 * DOGFOOD-REM-001 — the two defects the first dogfood run exposed.
 *
 * The run reported a delivered task and delivered nothing. Two causes, and
 * this file holds the controls for both as they land:
 *
 *  1. the writing agent had no authority to edit anything, because the
 *     argument vector never granted it — and no test pinned that vector, so
 *     the absence was invisible;
 *  2. a run with no effect could still settle as complete.
 *
 * The first is pinned here **as a whole**. `tests/claude-writer.test.ts`
 * asserts only that whatever `CLAUDE_WRITER_ARGS` holds is passed through to
 * the seam, which is true of an empty vector too. Pass-through is not
 * authority.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { CLAUDE_WRITER_ARGS } from '../src/agent/claude-writer.js';
import { readClaudeResultEnvelope } from '../src/agent/internal/claude-result-envelope.js';
import { renderRunResult } from '../src/cli/render-attended-run.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import { runTask, type RunResult } from '../src/run/run-driver.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { passingReview } from './fixtures.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';
import {
  findingsReview,
  recordedAgent,
  recordedVerify,
  reviewResult,
  seedState,
  startTask,
  tickingClock,
  writerThatEdits,
  type StartedTask,
} from './helpers/e2e-fixtures.js';

afterAll(() => {
  releaseTestLeases();
  removeTrackedWorkspaces();
  removeRepoFixtures();
});

describe('the writer is configured hermetically and can actually edit', () => {
  // Pinned as a whole. Today NO test pins the contents of this constant —
  // tests/claude-writer.test.ts asserts only that whatever it holds is passed
  // through — so any change to it is currently invisible. That is the gap.
  it('is exactly the measured vector for CLI 2.1.233', () => {
    expect([...CLAUDE_WRITER_ARGS]).toEqual([
      '--print',
      '--output-format',
      'json',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--tools',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
    ]);
  });

  it('is expressible as argv at all', () => {
    for (const token of CLAUDE_WRITER_ARGS) {
      expect(isShellInertArgument(token)).toBe(true);
    }
  });

  // The authority ceiling, asserted as absence with a live mutant (G7): each of
  // these tokens would widen authority past what the payload asks for.
  it.each([
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--add-dir',
  ])('does not grant authority through %s', (forbidden) => {
    expect(CLAUDE_WRITER_ARGS).not.toContain(forbidden);
  });

  it('grants no shell and no git tool', () => {
    const toolsAt = CLAUDE_WRITER_ARGS.indexOf('--tools');
    expect(toolsAt).toBeGreaterThanOrEqual(0);
    const tools = CLAUDE_WRITER_ARGS.slice(toolsAt + 1);
    expect(tools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('PowerShell');
  });

  it('bounds MCP authority, which --tools does not', () => {
    // Measured: without this flag the writer held the operator's MCP tools and
    // attempted mcp__claude_ai_Gmail__list_labels.
    expect(CLAUDE_WRITER_ARGS).toContain('--strict-mcp-config');
  });

  it('takes its settings from no ambient source', () => {
    const at = CLAUDE_WRITER_ARGS.indexOf('--setting-sources');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(CLAUDE_WRITER_ARGS[at + 1]).toBe('');
    // --bare would also be hermetic and would break subscription auth: its help
    // says OAuth and the keychain are never read. Measured from the binary.
    expect(CLAUDE_WRITER_ARGS).not.toContain('--bare');
    // --safe-mode's documented and measured behaviour disagree on CLAUDE.md.
    expect(CLAUDE_WRITER_ARGS).not.toContain('--safe-mode');
  });
});

/* ══════════ 2. A refused write is observable without reading prose ═════════ */

/** The envelope the real CLI printed for the dogfood's root cause, measured. */
const refusedButSuccessful = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  num_turns: 3,
  result: 'I could not do it. I am blocked. Write permission was not granted.',
  permission_denials: [
    { tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: 'C:\\wt\\a.ts' } },
    { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'git add -A' } },
  ],
});

/** A `RunResult` carrying nothing but the observation under test. */
function runResultWithDenials(denials: { count: number; tools: readonly string[] }): RunResult {
  return Object.freeze({
    outcome: 'TASK_COMPLETED' as const,
    taskId: 'REM-001',
    state: 'READY_FOR_PR' as const,
    steps: 3,
    reasonCodes: Object.freeze([]),
    reconciliation: null,
    resume: null,
    lastStep: null,
    permissionDenials: Object.freeze({ ...denials, tools: Object.freeze([...denials.tools]) }),
  });
}

/** Dependencies with **real** Git, as the e2e suite runs them. */
function deps(overrides: Record<string, unknown> = {}) {
  return { now: tickingClock(), git: runGitCommand, ...overrides };
}

/** The request shape the transport scenarios run under: attended, proven, bounded. */
function request(started: StartedTask) {
  return {
    repository: started.repository,
    taskId: started.taskId,
    taskBrief: 'Make the writer authority observable.',
    attendedContinuation: true,
    authEvidence: provenAuthEvidence(),
    lease: leaseFor(started.repository),
    maxSteps: 8,
  };
}

describe('a refused write is observable without reading prose', () => {
  it('reports the denials as structure', () => {
    const reading = readClaudeResultEnvelope(refusedButSuccessful);
    expect(reading.permissionDenials).toEqual({ count: 2, tools: ['Write', 'Bash'] });
  });

  // G6: denials are evidence, not a verdict. The CLI said the turn completed and
  // that remains what the verdict reports; whether the PASS was real is decided
  // by the measured delta in Task 3, not here.
  it('does not turn denials into a failed verdict', () => {
    expect(readClaudeResultEnvelope(refusedButSuccessful).verdict).toBe('COMPLETED');
  });

  it('reports no denials when the field is absent, and does not invent any', () => {
    const clean = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
    });
    expect(readClaudeResultEnvelope(clean).permissionDenials).toEqual({ count: 0, tools: [] });
  });

  // A foreign document must not be able to put free text into our observation.
  it('takes only string tool names, and nothing else from the entries', () => {
    const hostile = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      permission_denials: [
        { tool_name: 42 },
        { tool_name: 'Write', tool_input: { secret: 'sk-live-x' } },
        'nonsense',
      ],
    });
    const reading = readClaudeResultEnvelope(hostile);
    expect(reading.permissionDenials.tools).toEqual(['Write']);
    expect(JSON.stringify(reading)).not.toContain('sk-live-x');
  });

  // Printing, proven at the renderer. This is a unit control on the FORM only —
  // it feeds a hand-built RunResult and therefore proves nothing about whether a
  // real run ever puts the observation there. The transport control below is the
  // load-bearing one.
  it('prints the observation it is given: count and tool names, nothing else', () => {
    const rendered = renderRunResult(runResultWithDenials({ count: 2, tools: ['Write', 'Bash'] }));

    expect(rendered).toContain('2');
    expect(rendered).toContain('Write');
    expect(rendered).toContain('Bash');
    // Evidence, not prose: no tool_input, no agent sentence, ever.
    expect(rendered).not.toContain('C:\\wt\\a.ts');
    expect(rendered).not.toContain('git add -A');
  });

  it('says nothing about denials when there were none', () => {
    // The closest legitimate variant: a clean run must not gain a noise line.
    const rendered = renderRunResult(runResultWithDenials({ count: 0, tools: [] }));
    expect(rendered).not.toMatch(/denial/i);
  });

  // THE transport control. It must outlive the writer step, because the
  // successful case is exactly the one where the run does not stop there.
  //
  // The premise is asserted as "the run did not stop on the writer step", not as
  // a terminal state: an editing writer leaves the worktree dirty, and
  // `READY_FOR_PR` demands a settled tree that nothing commits yet. Task 3 is
  // what makes this same run settle; until then it walks implement → verify →
  // review and parks. Either way the writer step is three steps behind the end,
  // which is the whole point — a per-step carrier loses the observation exactly
  // here.
  it('survives every later step of a real run and still reaches the operator', async () => {
    const started = await startTask({ taskId: 'REM-001-T' });
    seedState(started, { state: 'IMPLEMENTING' });

    const verify = recordedVerify();
    const agent = recordedAgent({
      // A writer that really edits AND reports a denial it did not need.
      claude: writerThatEdits('src/work.ts', '// work\n', { permissionDenials: ['Bash'] }),
      codex: () => reviewResult(passingReview()),
    });

    const run = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    // The premise. Without these the case could pass by accidentally stopping on
    // the writer step — which is the shape a per-step carrier would also survive.
    expect(run.steps).toBe(3);
    expect(run.lastStep?.state).not.toBe('VERIFYING');
    expect(agent.countFor('claude')).toBe(1);
    expect(agent.countFor('codex')).toBe(1);

    const rendered = renderRunResult(run);
    expect(rendered).toContain('Bash');
  });

  it('accumulates across rounds instead of keeping only the last', async () => {
    // Round 1 denied, round 2 clean. Last-writer-wins would erase round 1.
    const started = await startTask({ taskId: 'REM-001-U' });
    seedState(started, { state: 'IMPLEMENTING' });

    const verify = recordedVerify();
    const agent = recordedAgent({
      claude: (call) =>
        call.index === 0
          ? writerThatEdits('src/a.ts', '// a\n', { permissionDenials: ['Bash'] })(call)
          : writerThatEdits('src/b.ts', '// b\n', { permissionDenials: [] })(call),
      codex: (call) =>
        reviewResult(call.index === 0 ? findingsReview('src/a.ts') : passingReview()),
    });

    const run = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    // The premise: a second writing pass really happened, and it was clean.
    expect(agent.countFor('claude')).toBe(2);

    const rendered = renderRunResult(run);
    expect(rendered).toContain('Bash');
  });

  it('is not a prose matcher', () => {
    // The closest legitimate variant: a run that genuinely completed while its
    // answer happens to quote the words of a refusal — e.g. a writer editing
    // this very plan. It must read as COMPLETED with zero denials.
    const quoting = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      result: 'I added a test asserting the text "permission had not been granted".',
      permission_denials: [],
    });
    const reading = readClaudeResultEnvelope(quoting);
    expect(reading.verdict).toBe('COMPLETED');
    expect(reading.permissionDenials.count).toBe(0);
  });
});
