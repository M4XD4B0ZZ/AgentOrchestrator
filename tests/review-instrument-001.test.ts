/**
 * REVIEW-INSTRUMENT-001 — a review whose instrument answered for another
 * repository must fail as a review, not as findings.
 *
 * ── The measured incident this file exists for ─────────────────────────────
 *
 * `healthapp/CAPTURE-003`, review round 2, 2026-09-12. Codex session
 * `rollout-2026-09-12T15-43-03`, spawned by AO with `cwd` set to the
 * CAPTURE-003 worktree — correctly, and it did not help. All six
 * `codegraph_explore` calls in that session tree omitted `projectPath`, and
 * every one was answered from **AgentOrchestrator's** index, because the MCP
 * server entry carried a fixed `cwd` pointing at another checkout.
 *
 * The reviewer noticed. It refused to substitute `grep`, which is exactly what
 * its instructions demand of it, and therefore never read a line of
 * CAPTURE-003's source. Then it emitted a well-formed `FINDINGS` document
 * anyway, built from `handoffs/latest-handoff.md` prose — because `FINDINGS`
 * and `PASS` were the only two things it was allowed to say. Those two findings
 * spent round 2 of 2 and forced `HUMAN_DECISION_REQUIRED` on work no reviewer
 * had read.
 *
 * ── What is being pinned, and what is deliberately not ─────────────────────
 *
 * Two halves, and neither is sufficient alone. §1 pins that AO now *names the
 * tree* and *names the parameter*; §2–§3 pin that a reviewer can now *say its
 * instrument was wrong*; §4 pins the consequence that matters — such a review
 * appends no finding and spends no round.
 *
 * Not pinned, because it is not true: that AO can *verify* the reviewer
 * complied. AO parses `turn.completed` and `agent_message` and never MCP tool
 * traffic (`codex-review-transcript.ts`), so a reviewer that ignores the
 * obligation is indistinguishable from one that met it. The repair makes the
 * obligation stated and the refusal expressible. It does not make compliance
 * measurable, and a test claiming otherwise would be the overclaim.
 *
 * ── Two mutants this file is built to catch ────────────────────────────────
 *
 * Each is named at the case that catches it, because a mutant nobody can locate
 * is a sentence rather than a gate.
 */

import { describe, expect, it } from 'vitest';

import { AGENT_FAILURE_TEXT } from '../src/agent/agent-outcome.js';
import { runCodexReviewer } from '../src/agent/codex-reviewer.js';
import {
  INSTRUMENT_FAILURE_TOKEN,
  readCodexTranscript,
  readReviewDocument,
} from '../src/agent/internal/codex-review-transcript.js';
import { buildReviewPayload } from '../src/loop/findings.js';
import { runReviewStep } from '../src/loop/loop-step.js';
import { createReviewerProviderGate } from '../src/loop/reviewer-provider-gate.js';
import { readExecutionBrief, type ExecutionBrief } from '../src/plan/task-brief.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { AgentCommandResult, AgentRunner } from '../src/agent/agent-command.js';
import { agentCommandResult, codexTranscript, passingReview } from './fixtures.js';
import { briefCapabilityFields, briefingFixture } from './helpers/briefing.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';
import {
  e2eProfile,
  findingsReview,
  recordedAgent,
  reload,
  seedState,
  startTask,
} from './helpers/e2e-fixtures.js';
import { afterAll } from 'vitest';

afterAll(() => {
  releaseTestLeases();
  removeTrackedWorkspaces();
  removeRepoFixtures();
});

/**
 * The worktree under review, spelled the way a real one is.
 *
 * A Windows absolute path with backslashes, because that is what
 * `authorisedWorktreePath` actually holds on the platform this repository
 * declares, and a POSIX stand-in would not exercise the same string.
 */
const TREE = 'D:\\Workspaces_VSCode\\HealthApp.worktrees\\CAPTURE-003';

/** A sibling checkout of the same repository — the tree the incident answered from. */
const SIBLING = 'D:\\Workspaces_VSCode\\HealthApp';

function briefFor(overrides: Partial<ExecutionBrief> = {}): ExecutionBrief {
  return {
    taskId: 'CAPTURE-003',
    title: 'Captured Ingredient to Resolver Bridge',
    body: 'Bridge the captured ingredient to the existing resolver.',
    bodyTruncated: false,
    contextSources: [],
    contextComplete: true,
    ...briefCapabilityFields(),
    ...overrides,
  } as ExecutionBrief;
}

/** A brief whose repository declares the capability REQUIRED, as HealthApp's does. */
function requiredBrief(): ExecutionBrief {
  return briefFor({
    ...briefCapabilityFields({ requirement: 'REQUIRED', status: 'INDEX_PRESENT', satisfied: true }),
  });
}

const instrumentFailureDocument = (findings: readonly unknown[] = []) => ({
  reviewVersion: 1,
  verdict: INSTRUMENT_FAILURE_TOKEN,
  findings,
});

/* ═══════ §1 the prompt: which tree, and which argument names it ═══════════ */

describe('§1 the reviewer is told which tree it is reviewing', () => {
  /** Proof 1. Failed before this slice: the builder was not given a path at all. */
  it('states the absolute worktree path, not a deictic "this repository"', () => {
    const payload = buildReviewPayload(requiredBrief(), 1, briefingFixture(), TREE);

    expect(payload).toContain(TREE);
    // The opening sentence, specifically. A path buried below a maximal task
    // body would be the first thing `clampPayload` cuts.
    expect(payload.indexOf(TREE)).toBeLessThan(payload.indexOf('TASK'));
  });

  it('says the sibling checkout is a different tree, because that is what fooled it', () => {
    const payload = buildReviewPayload(requiredBrief(), 1, briefingFixture(), TREE);
    expect(payload).toMatch(/sibling checkout[\s\S]*DIFFERENT tree/);
    // The incident's actual wrong answer came from this path. Nothing in the
    // payload may name it as the subject.
    expect(payload).not.toContain(`at ${SIBLING} against`);
  });

  /** Proof 2. `projectPath` occurred zero times anywhere in this repository before. */
  it('requires that exact path as the code-intelligence projectPath', () => {
    const payload = buildReviewPayload(requiredBrief(), 1, briefingFixture(), TREE);

    expect(payload).toContain('projectPath');
    expect(payload).toMatch(/must be given\s+D:\\Workspaces_VSCode\\HealthApp\.worktrees\\CAPTURE-003 as that path/);
    expect(payload).toMatch(/confirm the files it names lie/);
  });

  it('tells a REQUIRED repository to stop rather than substitute grep or prose', () => {
    const payload = buildReviewPayload(requiredBrief(), 1, briefingFixture(), TREE);

    expect(payload).toContain('REQUIRED');
    expect(payload).toContain(INSTRUMENT_FAILURE_TOKEN);
    expect(payload).toMatch(/Do NOT fall back to text search/);
    expect(payload).toMatch(/handoff notes, task text or any other prose/);
  });

  /**
   * The negative half of the gate. Without it the block is not a gate at all,
   * and a repository that never asked for code intelligence would be told to
   * abort over a tool it does not have.
   */
  it('does not impose the stop-obligation where the capability is OPTIONAL', () => {
    const optional = buildReviewPayload(briefFor(), 1, briefingFixture(), TREE);

    expect(optional).not.toMatch(/Do NOT fall back to text search/);
    // The targeting instruction is unconditional, though: it is true wherever
    // such a tool exists, and a reviewer without one has nothing to apply it to.
    expect(optional).toContain('projectPath');
    expect(optional).toContain(TREE);
  });

  /**
   * MUTANT — delete the third verdict from the quoted schema in `findings.ts`
   * and leave the parser, the failure code and everything else in place. Every
   * parser-level case in §2 still passes, and nothing else in the build fails:
   * the parser branch becomes unreachable dead code, because a reviewer cannot
   * emit a verdict it was never told about. This case is what reddens.
   */
  it('offers the verdict in the reply schema, in every payload', () => {
    for (const brief of [briefFor(), requiredBrief()]) {
      const payload = buildReviewPayload(brief, 1, briefingFixture(), TREE);
      expect(payload).toContain(`"verdict": "PASS" | "FINDINGS" | "${INSTRUMENT_FAILURE_TOKEN}"`);
      expect(payload).toMatch(/requires an EMPTY findings array/);
      expect(payload).toMatch(/does not spend a review round/);
    }
  });

  /**
   * The join. Prompt and parser must name one token, and a literal on each side
   * is free to drift; the shared constant is what makes drift impossible.
   */
  it('quotes the same token the parser accepts', () => {
    const payload = buildReviewPayload(requiredBrief(), 1, briefingFixture(), TREE);
    expect(payload).toContain(INSTRUMENT_FAILURE_TOKEN);
    expect(readReviewDocument(JSON.stringify(instrumentFailureDocument())).verdict).toBe(
      'INSTRUMENT_FAILURE',
    );
  });

  it('keeps the reply schema inside the budget beside a maximal body', () => {
    const payload = buildReviewPayload(
      requiredBrief(),
      1,
      briefingFixture(),
      `${TREE}${'\\deeply\\nested'.repeat(20)}`,
    );
    expect(payload).toContain('"reviewVersion": 1');
    expect(payload).toContain(INSTRUMENT_FAILURE_TOKEN);
  });
});

/* ═══════ §2 the parser: three verdicts, and they do not collapse ══════════ */

describe('§2 the review document parses three verdicts', () => {
  /** Proof 3. The positive control. A pass must survive the whole slice. */
  it('reads a valid PASS exactly as before', () => {
    const reading = readReviewDocument(JSON.stringify(passingReview()));
    expect(reading.verdict).toBe('REVIEWED');
    expect(reading.findings).toEqual([]);
  });

  /** Proof 4. The other positive control. */
  it('reads a valid FINDINGS exactly as before', () => {
    const reading = readReviewDocument(
      JSON.stringify({
        reviewVersion: 1,
        verdict: 'FINDINGS',
        findings: [{ severity: 'high', path: 'src/a.ts', rule: 'x.y' }],
      }),
    );
    expect(reading.verdict).toBe('REVIEWED');
    expect(reading.findings).toHaveLength(1);
    expect(reading.findings[0]?.rule).toBe('x.y');
  });

  /** Proof 5. Distinct from both, and that is the whole point of the member. */
  it('reads an instrument failure as its own verdict, not REVIEWED and not UNRECOGNISED', () => {
    const reading = readReviewDocument(JSON.stringify(instrumentFailureDocument()));

    expect(reading.verdict).toBe('INSTRUMENT_FAILURE');
    expect(reading.verdict).not.toBe('REVIEWED');
    expect(reading.verdict).not.toBe('UNRECOGNISED');
    expect(reading.findings).toEqual([]);
  });

  /**
   * Proof 6, at the parser. The agreement rule closes the one route by which an
   * instrument failure could still carry findings into AO.
   */
  it('refuses an instrument failure that also reports findings', () => {
    const reading = readReviewDocument(
      JSON.stringify(
        instrumentFailureDocument([{ severity: 'high', path: 'src/a.ts', rule: 'x.y' }]),
      ),
    );
    expect(reading.verdict).toBe('UNRECOGNISED');
    expect(reading.findings).toEqual([]);
  });

  it('still refuses a verdict nobody defined', () => {
    for (const verdict of ['INSTRUMENT', 'instrument_failure', 'BLOCKED', '']) {
      expect(
        readReviewDocument(JSON.stringify({ reviewVersion: 1, verdict, findings: [] })).verdict,
      ).toBe('UNRECOGNISED');
    }
  });

  it('requires the turn to have completed, for the third verdict as for the others', () => {
    const stdout = codexTranscript(instrumentFailureDocument(), { completed: false });
    expect(readCodexTranscript(stdout).verdict).toBe('UNRECOGNISED');
  });
});

/* ═══════ §3 the boundary: an instrument failure is not a review ═══════════ */

const WORKTREE = '/srv/worktrees/alpha/task-0001';

function scriptedRunner(result: AgentCommandResult): AgentRunner {
  return async () => result;
}

async function reviewOf(document: unknown) {
  return runCodexReviewer(
    { worktreePath: WORKTREE, round: 1, payload: 'review', now: '2026-09-12T13:51:36.000Z' },
    { agent: scriptedRunner(agentCommandResult({ stdout: codexTranscript(document) })) },
  );
}

describe('§3 the reviewer boundary keeps an instrument failure out of the results', () => {
  /** Proof 7. Not success — the property the incident violated. */
  it('is not a review that completed', async () => {
    const outcome = await reviewOf(instrumentFailureDocument());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.disposition).not.toBe('AGENT_COMPLETED');
    expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
  });

  /**
   * Proof 6, at the boundary. Structural, not a value check: `findings` does
   * not exist on `CodexReviewFailed`, so there is no member a caller could read
   * an empty list from and no member it could read a populated one from.
   */
  it('carries no findings member at all', async () => {
    const outcome = await reviewOf(instrumentFailureDocument());
    expect(Object.prototype.hasOwnProperty.call(outcome, 'findings')).toBe(false);
  });

  /**
   * MUTANT — revert only the acceptance at `codex-review-transcript.ts` so the
   * third verdict falls back to `UNRECOGNISED`. Measured on 2026-09-12: three
   * cases redden — this one, §2's "reads an instrument failure as its own
   * verdict", and §1's token-join case — and **twenty pass**, including every
   * case in §4.
   *
   * That is the honest sizing of the parser-and-code half of this repair. §4
   * survives the mutant because `AGENT_RESULT_MALFORMED` is also a failure and
   * is also routed away from `appendFindings`: no finding is appended and no
   * round is spent either way. So the third verdict buys **diagnosis fidelity**
   * for the human reading the escalation, not safety. Do not let a later
   * summary sell it as safety.
   */
  it('names the instrument, not "the agent printed garbage"', async () => {
    const outcome = await reviewOf(instrumentFailureDocument());
    if (outcome.ok) expect.unreachable();

    expect(outcome.code).toBe('AGENT_REVIEW_INSTRUMENT_FAILED');
    expect(outcome.code).not.toBe('AGENT_RESULT_MALFORMED');
    expect(outcome.detail).toBe(AGENT_FAILURE_TEXT.AGENT_REVIEW_INSTRUMENT_FAILED);
    expect(outcome.detail).not.toBe(AGENT_FAILURE_TEXT.AGENT_RESULT_MALFORMED);
    // It is a statement about the instrument, and it says so in words an
    // operator can act on without reading this file.
    expect(outcome.detail).toMatch(/worktree under review/);
  });

  it('records no quota block, because nothing about the subscription was learned', async () => {
    const outcome = await reviewOf(instrumentFailureDocument());
    if (outcome.ok) expect.unreachable();
    expect(outcome.block).toBeNull();
  });

  /** Proofs 3 and 4 at the boundary: the controls still pass through unchanged. */
  it('leaves an ordinary PASS and an ordinary FINDINGS exactly as they were', async () => {
    const pass = await reviewOf(passingReview());
    expect(pass.ok).toBe(true);
    if (!pass.ok) expect.unreachable();
    expect(pass.disposition).toBe('AGENT_COMPLETED');
    expect(pass.findings).toEqual([]);

    const found = await reviewOf({
      reviewVersion: 1,
      verdict: 'FINDINGS',
      findings: [{ severity: 'high', path: 'src/a.ts', rule: 'x.y' }],
    });
    expect(found.ok).toBe(true);
    if (!found.ok) expect.unreachable();
    expect(found.disposition).toBe('AGENT_COMPLETED');
    expect(found.findings).toHaveLength(1);
  });

  it('still reads genuinely malformed output as malformed', async () => {
    const outcome = await reviewOf('not a document at all');
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_RESULT_MALFORMED');
  });
});

/* ═══════ §4 the loop: no finding appended, no round spent ═════════════════ */

const REVIEW_AT = '2026-09-12T13:51:36.000Z';

/**
 * A task seeded at `REVIEWING` with its budget one round from exhausted.
 *
 * `maxReviewRounds: 2` and `reviewRound: 1` means the round about to run **is**
 * the last permitted one. That is the exact position CAPTURE-003 was in, and it
 * is the only position where the difference between "a finding" and "no review"
 * is visible in the durable state rather than merely in a log line.
 */
async function atTheLastRound(taskId: string) {
  const started = await startTask({ taskId, profile: e2eProfile({ maxReviewRounds: 2 }) });
  const current = seedState(started, { state: 'REVIEWING', reviewRound: 1 });
  return { started, current };
}

function reviewDeps(
  started: Awaited<ReturnType<typeof atTheLastRound>>['started'],
  runner: AgentRunner,
) {
  return {
    writerMcp: null,
    now: REVIEW_AT,
    authorisedWorktreePath: started.workspace.worktreePath,
    verification: started.repository.verification,
    brief: readExecutionBrief(
      started.repository,
      started.workspace.taskId,
      started.workspace.worktreePath,
    ),
    git: runGitCommand,
    agent: runner,
    // Never the process-wide gate: a suite that shared it would measure its own
    // earlier cases rather than this one.
    reviewerProviderGate: createReviewerProviderGate(),
    lease: { repository: started.repository, evidence: leaseFor(started.repository) },
  };
}

describe('§4 an instrument failure spends nothing and claims nothing', () => {
  /**
   * Proofs 6 and 8 together, and the inverse of the incident.
   *
   * The control below is what makes it mean something: the identical state, the
   * identical round, and an ordinary FINDINGS document — which *does* append and
   * *does* spend the round. Without the control this case would also pass
   * against a build that had simply stopped reviewing.
   */
  it('appends no finding and spends no round at the last permitted round', async () => {
    const { started, current } = await atTheLastRound('RI-001-INSTRUMENT');
    const agent = recordedAgent({
      codex: () => agentCommandResult({ stdout: codexTranscript(instrumentFailureDocument()) }),
    });

    const step = await runReviewStep(current, reviewDeps(started, agent.runner));

    expect(step.outcome).toBe('BLOCKED');
    expect(agent.countFor('codex')).toBe(1); // the reviewer really ran

    const after = reload(started.root, started.workspace.taskId).state;
    expect(after.findingHistory).toEqual([]);
    expect(after.reviewRound).toBe(1); // unchanged: the round was not spent
  });

  /**
   * Proof 8, the control. Existing review-budget semantics are unchanged: at
   * the last permitted round a real finding still appends and still spends.
   *
   * This is the CAPTURE-003 escalation reproduced deliberately, so that the
   * case above is a *difference* rather than an absence.
   */
  it('leaves an ordinary finding appending and spending, exactly as before', async () => {
    const { started, current } = await atTheLastRound('RI-001-CONTROL');
    const agent = recordedAgent({
      codex: () => agentCommandResult({ stdout: codexTranscript(findingsReview()) }),
    });

    const step = await runReviewStep(current, reviewDeps(started, agent.runner));

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');

    const after = reload(started.root, started.workspace.taskId).state;
    expect(after.findingHistory).toHaveLength(1);
    expect(after.reviewRound).toBe(2); // spent, and the budget is now exhausted
  });

  /** And a pass at the last round still finishes the task, which is the other half. */
  it('leaves an ordinary pass advancing, exactly as before', async () => {
    const { started, current } = await atTheLastRound('RI-001-PASS');
    const agent = recordedAgent({
      codex: () => agentCommandResult({ stdout: codexTranscript(passingReview()) }),
    });

    const step = await runReviewStep(current, reviewDeps(started, agent.runner));

    const after = reload(started.root, started.workspace.taskId).state;
    expect(after.findingHistory).toEqual([]);
    expect(after.reviewRound).toBe(2);
    expect(step.outcome).not.toBe('STATE_NOT_RECORDED');
  });
});
