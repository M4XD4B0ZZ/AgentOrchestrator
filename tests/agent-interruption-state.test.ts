/**
 * V1-05 — what an interrupted agent run writes down.
 *
 * This file is about the boundary between "an agent run ended badly" and "the
 * task's durable state now says so". Three properties matter, and each of them
 * describes a way the loop could quietly corrupt a task:
 *
 *  1. **The phase does not advance.** An interrupted writer has not earned
 *     `VERIFYING`; an interrupted reviewer has not earned `READY_FOR_PR`. The
 *     tempting mutation — "the writer ran, so verification is next" — is wrong
 *     exactly when it matters, because the interrupted run is the incomplete
 *     one.
 *  2. **Nothing already persisted is erased.** `findingHistory` is not
 *     sentiment: `reconcile.ts` reads a non-empty history as evidence that the
 *     task has done work, so dropping it would make a resumed task look
 *     virgin and turn the loop's own progress into reported divergence.
 *  3. **A process exiting grants no authority to continue.** Recording a block
 *     is not permission to clear it. That decision has exactly one source in
 *     this repository, and it is not here.
 *
 * The real store is used against real temporary directories rather than a
 * stubbed one: the compare-and-swap refusal this file asserts is reproducible
 * on real files, and asserting it against a fake would prove only that the
 * fake was written to agree.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_RUN_OUTCOMES,
  recordAgentInterruption,
  type AgentInterruption,
} from '../src/agent/record-interruption.js';
import type { AgentBlockEvidence } from '../src/agent/agent-outcome.js';
import { evaluateAutomaticResume } from '../src/core/automatic-resume.js';
import { allowedResumePhases } from '../src/core/resume-policy.js';
import { parseTaskState, type TaskStateInput } from '../src/core/task-state.js';
import { loadTaskState, saveTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { positiveResumeEvidence, SHA_A, SHA_B, validCreatedState } from './fixtures.js';

const NOW = '2026-08-10T09:00:00.000Z';
const TASK_ID = 'task-0001';

const tempDirs: string[] = [];

/** A canonical scratch directory standing in for a repository root. */
function repoRoot(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-agent-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Work already done and already persisted: two findings, a completed round, a commit. */
function inFlightState(root: string, overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return validCreatedState({
    repositoryRoot: root,
    worktreePath: join(root, 'worktree'),
    state: 'IMPLEMENTING',
    basePinnedCommit: SHA_A,
    currentCommit: SHA_B,
    reviewRound: 1,
    maxReviewRounds: 3,
    findingHistory: [
      { round: 1, severity: 'high', fingerprint: 'aaaa1111' },
      { round: 1, severity: 'low', fingerprint: 'bbbb2222' },
    ],
    ...overrides,
  });
}

/** Persists `state` and hands back the load result a caller would have held. */
function persisted(root: string, state: TaskStateInput): StateLoadSuccess {
  const saved = saveTaskState(state, { repositoryRoot: root });
  expect(saved.ok).toBe(true);
  const loaded = loadTaskState(root, TASK_ID);
  if (loaded.classification !== 'STATE_VALID') expect.unreachable();
  return loaded;
}

const CLAUDE_BLOCK: AgentBlockEvidence = Object.freeze({
  blockedAgent: 'claude' as const,
  resumeFrom: Object.freeze({ phase: 'IMPLEMENT' as const, round: 1 }),
  reportedResetAt: null,
});

function interruption(
  disposition: AgentInterruption['disposition'],
  block: AgentBlockEvidence | null = null,
): AgentInterruption {
  return { disposition, block };
}

function record(
  current: StateLoadSuccess,
  root: string,
  value: AgentInterruption,
  fallback: AgentBlockEvidence = CLAUDE_BLOCK,
) {
  return recordAgentInterruption(current, value, {
    repositoryRoot: root,
    now: NOW,
    fallback,
  });
}

// ── The phase does not advance ─────────────────────────────────────────────

describe('an interrupted run does not advance the task', () => {
  it.each([
    ['a usage limit', 'AGENT_BLOCKED_USAGE_LIMIT', 'BLOCKED_USAGE_LIMIT'],
    ['an auth rejection', 'AGENT_BLOCKED_AUTH', 'BLOCKED_AUTH'],
    ['an unclassifiable failure', 'AGENT_NEEDS_ATTENTION', 'HUMAN_DECISION_REQUIRED'],
  ] as const)('parks an interrupted writer on %s rather than moving it on', async (
    _label,
    disposition,
    expected,
  ) => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    const result = record(current, root, interruption(disposition, CLAUDE_BLOCK));

    expect(result.state).toBe(expected);
    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.state).toBe(expected);
    // The two states a completed run would have reached, and did not.
    expect(reloaded.state.state).not.toBe('VERIFYING');
    expect(reloaded.state.state).not.toBe('READY_FOR_PR');
  });

  it('parks an interrupted reviewer without ever reaching READY_FOR_PR', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root, { state: 'REVIEWING' }));

    record(
      current,
      root,
      interruption('AGENT_BLOCKED_USAGE_LIMIT', {
        blockedAgent: 'codex',
        resumeFrom: { phase: 'REVIEW', round: 1 },
        reportedResetAt: null,
      }),
    );

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(reloaded.state.blockedAgent).toBe('codex');
  });

  /**
   * `VERIFYING → BLOCKED_USAGE_LIMIT` is deliberately absent from the
   * transition table: verification runs local project commands and consumes no
   * agent quota. Going through `advanceTaskState` rather than `saveTaskState`
   * is what makes that refusal automatic — `saveTaskState` alone would have
   * written it.
   */
  it('refuses to record a usage-limit block from VERIFYING', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root, { state: 'VERIFYING' }));

    const result = record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    expect(result.outcome).toBe('STATE_NOT_RECORDED');
    expect(result.state).toBeNull();
    expect(result.save.ok).toBe(false);
    if (result.save.ok) expect.unreachable();
    expect(result.save.code).toBe('ILLEGAL_TRANSITION');

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.state).toBe('VERIFYING');
  });

  it('does not increment the review round for a round that was interrupted', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root, { state: 'REVIEWING' }));

    record(current, root, interruption('AGENT_NEEDS_ATTENTION'));

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.reviewRound).toBe(1);
  });
});

// ── Nothing already persisted is erased ────────────────────────────────────

describe('an interrupted run keeps the evidence the task already had', () => {
  it.each([
    'AGENT_BLOCKED_USAGE_LIMIT',
    'AGENT_BLOCKED_AUTH',
    'AGENT_NEEDS_ATTENTION',
  ] as const)('carries the finding history through %s unchanged', (disposition) => {
    const root = repoRoot();
    const before = inFlightState(root, { state: 'REVIEWING' });
    const current = persisted(root, before);

    record(current, root, interruption(disposition, CLAUDE_BLOCK));

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.findingHistory).toEqual(before.findingHistory);
  });

  it('carries the pinned and current commits through unchanged', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.basePinnedCommit).toBe(SHA_A);
    expect(reloaded.state.currentCommit).toBe(SHA_B);
  });

  it('changes only the fields that describe the interruption', () => {
    const root = repoRoot();
    const before = inFlightState(root);
    const current = persisted(root, before);

    record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();

    const changed = Object.keys(reloaded.state).filter(
      (key) =>
        JSON.stringify((reloaded.state as Record<string, unknown>)[key]) !==
        JSON.stringify((before as Record<string, unknown>)[key]),
    );
    expect(changed.sort()).toEqual(
      ['blockedAgent', 'resumeFrom', 'state', 'stateEnteredAt'].sort(),
    );
  });
});

// ── The block is well formed ───────────────────────────────────────────────

describe('the recorded block satisfies the state contract', () => {
  it('records a resume phase the blocked state can actually be continued at', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    const phases = allowedResumePhases('BLOCKED_USAGE_LIMIT');
    expect(phases).toContain(reloaded.state.resumeFrom?.phase);
    // Derived from the transition table, so `VERIFY` is structurally
    // impossible here — `VERIFYING` is not a successor of this state.
    expect(phases).not.toContain('VERIFY');
  });

  it('records the blocked agent, which the contract requires', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.blockedAgent).toBe('claude');
  });

  it('refuses a resume phase the blocked state cannot be continued at', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    const result = record(
      current,
      root,
      interruption('AGENT_BLOCKED_USAGE_LIMIT', {
        blockedAgent: 'claude',
        // `VERIFYING` is not a successor of `BLOCKED_USAGE_LIMIT`, so this
        // re-entry point could never be reached.
        resumeFrom: { phase: 'VERIFY', round: 1 },
        reportedResetAt: null,
      }),
    );

    expect(result.outcome).toBe('STATE_NOT_RECORDED');
    if (result.save.ok) expect.unreachable();
    expect(result.save.code).toBe('STATE_CONTRACT_VIOLATION');
  });

  it('clears a reset time on a block that is not time-based', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    record(
      current,
      root,
      interruption('AGENT_BLOCKED_AUTH', {
        blockedAgent: 'claude',
        resumeFrom: { phase: 'IMPLEMENT', round: 1 },
        reportedResetAt: '2026-08-10T14:00:00.000Z',
      }),
    );

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    // A stale quota timestamp on a state a human has to clear would be
    // evidence about a condition that is no longer the one holding the task.
    expect(reloaded.state.reportedResetAt).toBeNull();
  });

  it('records a reported reset time when the agent genuinely reported one', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    record(
      current,
      root,
      interruption('AGENT_BLOCKED_USAGE_LIMIT', {
        ...CLAUDE_BLOCK,
        reportedResetAt: '2026-08-10T14:00:00.000Z',
      }),
    );

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.reportedResetAt).toBe('2026-08-10T14:00:00.000Z');
  });
});

// ── A process exiting grants no authority ──────────────────────────────────

describe('recording a block is not permission to clear it', () => {
  /**
   * The single most dangerous mutation in this slice is one that fabricates a
   * reset timestamp — `now + five hours`, say — when the CLI reported none. It
   * would not merely mislead a report: `evaluateAutomaticResume` grants an
   * unattended resume once a reported reset time has passed, so a fabricated
   * one converts a governed block into an automatic retry on a timer.
   */
  it('leaves no reset time behind when none was reported, so no unattended resume is granted', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.reportedResetAt).toBeNull();

    // Everything else about this task is in perfect order, and it still does
    // not resume: the missing timestamp alone is disqualifying.
    const decision = evaluateAutomaticResume(
      reloaded.state,
      positiveResumeEvidence({
        observedRepositoryId: reloaded.state.repositoryId,
        observedRepositoryRoot: reloaded.state.repositoryRoot,
        observedWorktreePath: reloaded.state.worktreePath,
        observedBasePinnedCommit: SHA_A,
        observedCurrentCommit: SHA_B,
        now: '2026-08-10T23:00:00.000Z',
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('RESET_TIME_MISSING');
  });

  it('does not make a block resumable merely because the agent process exited', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    record(
      current,
      root,
      interruption('AGENT_BLOCKED_USAGE_LIMIT', {
        ...CLAUDE_BLOCK,
        reportedResetAt: '2026-08-10T14:00:00.000Z',
      }),
    );

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();

    const decision = evaluateAutomaticResume(
      reloaded.state,
      positiveResumeEvidence({
        observedRepositoryId: reloaded.state.repositoryId,
        observedRepositoryRoot: reloaded.state.repositoryRoot,
        observedWorktreePath: reloaded.state.worktreePath,
        observedBasePinnedCommit: SHA_A,
        observedCurrentCommit: SHA_B,
        // Before the reported reset, and with the login not re-proven.
        now: '2026-08-10T10:00:00.000Z',
        authPreflightPassed: false,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('RESET_TIME_NOT_REACHED');
    expect(decision.reasonCodes).toContain('AUTH_PREFLIGHT_NOT_PASSED');
  });

  /**
   * `AUTOMATIC_ALLOWED` has exactly one source in this repository, reached
   * through reconciliation. A V1-05 outcome a driver could mistake for the
   * same thing would be a way to resume without ever having checked.
   */
  it('offers no outcome that reads as permission to continue unattended', () => {
    expect(AGENT_RUN_OUTCOMES).not.toContain('AUTOMATIC_ALLOWED');
    expect(AGENT_RUN_OUTCOMES).not.toContain('RESUME_READY');
    expect(AGENT_RUN_OUTCOMES).not.toContain('RETRY');
    expect([...AGENT_RUN_OUTCOMES].sort()).toEqual(
      ['RUN_COMPLETED', 'PAUSED_USAGE_LIMIT', 'NEEDS_ATTENTION', 'STATE_NOT_RECORDED'].sort(),
    );
  });

  /**
   * A pause is not a failure. The run driver is meant to be able to tell "come
   * back to this task later" apart from "this task needs a person", because
   * they lead to different behaviour for the queue as a whole.
   */
  it('distinguishes a pause from an escalation', () => {
    const root = repoRoot();
    const paused = record(
      persisted(root, inFlightState(root)),
      root,
      interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK),
    );
    expect(paused.outcome).toBe('PAUSED_USAGE_LIMIT');

    const other = repoRoot();
    const escalated = record(
      persisted(other, inFlightState(other)),
      other,
      interruption('AGENT_NEEDS_ATTENTION'),
    );
    expect(escalated.outcome).toBe('NEEDS_ATTENTION');
  });
});

// ── Concurrency ────────────────────────────────────────────────────────────

describe('an interruption is written under compare-and-swap', () => {
  /**
   * The state a run was computed against is the state it may replace. A blind
   * write here would let a result derived from stale facts overwrite a task
   * that has since moved — the classic lost update, with a task's history as
   * the thing lost.
   */
  it('refuses to overwrite a task that moved underneath the run', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    // A competing writer lands between the read and the block.
    const competing = saveTaskState(
      parseTaskState(inFlightState(root, { stateEnteredAt: '2026-08-10T08:30:00.000Z' })),
      { repositoryRoot: root, expectedRevision: current.revision },
    );
    expect(competing.ok).toBe(true);

    const result = record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    expect(result.outcome).toBe('STATE_NOT_RECORDED');
    if (result.save.ok) expect.unreachable();
    expect(result.save.code).toBe('STATE_CONFLICT');

    // The winner's state is untouched: the loser reports, it does not repair.
    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.state).toBe('IMPLEMENTING');
  });

  it('reports a refused write rather than presenting the block as durable', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root, { state: 'VERIFYING' }));

    const result = record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    // An unrecorded block is a task whose durable state still claims it is
    // running, and that must never be reported as a successful pause.
    expect(result.outcome).not.toBe('PAUSED_USAGE_LIMIT');
    expect(result.outcome).toBe('STATE_NOT_RECORDED');
  });
});
