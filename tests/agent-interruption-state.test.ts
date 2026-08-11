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
import { phaseMutatesRepository, withdrawnCheckpointFor } from '../src/core/agent-phases.js';
import { evaluateAutomaticResume } from '../src/core/automatic-resume.js';
import { allowedResumePhases } from '../src/core/resume-policy.js';
import { parseTaskState, type TaskStateInput } from '../src/core/task-state.js';
import { loadTaskState, saveTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { observeRuntime } from '../src/state/observe-runtime.js';
import { reconcileTaskState } from '../src/state/reconcile.js';
import type { GitCommandResult, GitRunner } from '../src/worktree/git-command.js';
import { deriveTaskWorkspaceIdentity } from '../src/worktree/workspace-identity.js';
import { fingerprint, positiveResumeEvidence, SHA_A, SHA_B, validCreatedState } from './fixtures.js';

const GIT_OK = (stdout = ''): GitCommandResult =>
  Object.freeze({ outcome: 'OK' as const, stdout, exitCode: 0 });

/**
 * A Git that answers as it would over a worktree the writer has been working
 * in: an edited file, and a commit of its own that no checkpoint recorded.
 */
function scriptedWriterGit(
  root: string,
  worktreePath: string,
  workBranch: string,
  head: string,
): GitRunner {
  const registry = `worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktreePath}\nbranch refs/heads/${workBranch}\n`;
  return async (_cwd: string, args: readonly string[]): Promise<GitCommandResult> => {
    if (args[0] === 'worktree' && args[1] === 'list') return GIT_OK(registry);
    if (args[0] === 'status') return GIT_OK(' M src/index.ts');
    if (args[0] === 'merge-base') return GIT_OK();
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return GIT_OK(head);
    if (args[0] === 'rev-parse') return GIT_OK(SHA_A);
    throw new Error(`unscripted git call: ${args.join(' ')}`);
  };
}

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

/**
 * The worktree path this task's identity derives for `root`.
 *
 * From the production derivation, because reconciliation re-derives it and
 * refuses a record that does not match (V1-08) — a fixture path of its own
 * choosing would make every reconciliation below report divergence for a reason
 * the case is not about.
 */
function worktreeOf(root: string): string {
  const derived = deriveTaskWorkspaceIdentity(
    { id: 'repo-alpha', root, defaultBranch: 'main' },
    TASK_ID,
  );
  if (!derived.ok) throw new Error(`fixture identity did not derive: ${derived.code}`);
  return derived.identity.worktreePath;
}

/** Work already done and already persisted: two findings, a completed round, a commit. */
function inFlightState(root: string, overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return validCreatedState({
    repositoryRoot: root,
    worktreePath: worktreeOf(root),
    state: 'IMPLEMENTING',
    basePinnedCommit: SHA_A,
    currentCommit: SHA_B,
    reviewRound: 1,
    maxReviewRounds: 3,
    findingHistory: [
      { round: 1, severity: 'high', fingerprint: fingerprint(1) },
      { round: 1, severity: 'low', fingerprint: fingerprint(2) },
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

  /**
   * The pinned base is the one commit fact an interruption can never make
   * stale: it is what the task branched from, not what anyone last saw. The
   * *current* commit is a different kind of claim and is withdrawn for a writer
   * — see the V1-05-RR-F8 suite below, where the reviewer case shows it carried
   * through untouched.
   */
  it('carries the pinned commit through unchanged', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root));

    record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', CLAUDE_BLOCK));

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.basePinnedCommit).toBe(SHA_A);
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
    // The last two are the checkpoint claims a writer may have invalidated
    // (V1-05-RR-F8). They are listed here rather than allowed to drift, so that
    // widening what an interruption rewrites stays a decision someone makes.
    expect(changed.sort()).toEqual(
      [
        'blockedAgent',
        'resumeFrom',
        'state',
        'stateEnteredAt',
        'currentCommit',
        'worktreeCleanAtCheckpoint',
      ].sort(),
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

  /**
   * The schema guard, reached from a state that runs no agent — so the
   * cross-field guard added for V1-05-RR-F4 has no phase to derive from and
   * stands aside. `AUTH_PREFLIGHT` is such a state: credentials are checked
   * there, no agent executes, and `BLOCKED_AUTH` is a declared successor.
   *
   * From an agent-executing state the same input is refused one step earlier
   * and more precisely, which is what the neighbouring suite asserts. Both
   * refusals are wanted: this one is the floor under any phase the derivation
   * does not cover.
   */
  it('refuses a resume phase the blocked state cannot be continued at', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root, { state: 'AUTH_PREFLIGHT' }));

    const result = record(
      current,
      root,
      interruption('AGENT_BLOCKED_AUTH', {
        blockedAgent: 'claude',
        // `VERIFY` is not an allowed re-entry phase for `BLOCKED_AUTH`, so this
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
        authEvidence: null,
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

// ── The interruption describes the run that was actually interrupted ───────

/**
 * V1-05-RR-F4.
 *
 * `blockedAgent` and `resumeFrom` are the operator's instructions: they say
 * which CLI ran out and where the task picks up. They used to be copied
 * verbatim from whatever the caller passed, and every combination the schema
 * permits is a combination the schema permits — `allowedBlockedAgents` for
 * `BLOCKED_USAGE_LIMIT` is `['claude','codex']` and `allowedResumePhases` is
 * `['IMPLEMENT','REVIEW','REMEDIATE']`, so the whole cross-product validates.
 *
 * That let a Codex review interrupted in `REVIEWING` be written down as
 * *Claude's quota is exhausted, continue at IMPLEMENT round 1*. Every gate
 * passes, nothing downstream disagrees — `reconcile.ts` reads `resumeFrom` only
 * for existence and `evaluateAutomaticResume` never looks at the agent at
 * all — and the operator re-authenticates the wrong CLI.
 *
 * The state itself already knows which agent was running: `IMPLEMENTING` and
 * `REMEDIATING` are the writer's, `REVIEWING` is the reviewer's. So the two
 * fields are derived from the persisted phase, and a caller whose evidence
 * disagrees is refused rather than believed — a disagreement between the caller
 * and the durable state is not something to resolve by picking one.
 */
describe('an interruption is recorded against the phase that was running', () => {
  const CODEX_BLOCK: AgentBlockEvidence = Object.freeze({
    blockedAgent: 'codex' as const,
    resumeFrom: Object.freeze({ phase: 'REVIEW' as const, round: 1 }),
    reportedResetAt: null,
  });

  it.each([
    ['IMPLEMENTING', 'claude', 'IMPLEMENT'],
    ['REMEDIATING', 'claude', 'REMEDIATE'],
    ['REVIEWING', 'codex', 'REVIEW'],
  ] as const)('records %s as the %s agent resuming at %s', (state, agent, phase) => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root, { state }));

    const result = record(
      current,
      root,
      interruption('AGENT_NEEDS_ATTENTION', {
        blockedAgent: agent,
        resumeFrom: { phase, round: 2 },
        reportedResetAt: null,
      }),
    );

    expect(result.outcome).toBe('NEEDS_ATTENTION');
    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.blockedAgent).toBe(agent);
    expect(reloaded.state.resumeFrom?.phase).toBe(phase);
    // The round is the run's own, and is carried rather than derived: the
    // phase says *where*, the round says *which pass*, and only the caller
    // knows the second.
    expect(reloaded.state.resumeFrom?.round).toBe(2);
  });

  it.each([
    [
      'a Codex review written down as a Claude block',
      'REVIEWING' as const,
      CLAUDE_BLOCK,
    ],
    [
      'a Claude implementation written down as a Codex block',
      'IMPLEMENTING' as const,
      CODEX_BLOCK,
    ],
    [
      'a resume phase belonging to a different state',
      'IMPLEMENTING' as const,
      {
        blockedAgent: 'claude' as const,
        resumeFrom: { phase: 'REMEDIATE' as const, round: 1 },
        reportedResetAt: null,
      },
    ],
  ])('refuses %s', (_label, state, block) => {
    const root = repoRoot();
    const before = inFlightState(root, { state });
    const current = persisted(root, before);

    const result = record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT', block));

    expect(result.outcome).toBe('STATE_NOT_RECORDED');
    expect(result.state).toBeNull();
    expect(result.save.ok).toBe(false);
    if (result.save.ok) expect.unreachable();
    expect(result.save.code).toBe('INTERRUPTION_INCONSISTENT');

    // Nothing was written: the task is still running, which is the truth.
    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.state).toBe(state);
    expect(reloaded.state.blockedAgent).toBeNull();
  });

  /**
   * The fallback is substituted whenever a boundary recognised no block of its
   * own, which is every `AGENT_NEEDS_ATTENTION` — the commonest case by far. It
   * is a constant at its call site, so it is exactly where a wrong agent gets
   * in without anyone choosing it.
   */
  it('applies the same rule to a substituted fallback as to explicit evidence', () => {
    const root = repoRoot();
    const current = persisted(root, inFlightState(root, { state: 'REVIEWING' }));

    const result = record(current, root, interruption('AGENT_NEEDS_ATTENTION'), CLAUDE_BLOCK);

    expect(result.outcome).toBe('STATE_NOT_RECORDED');
    if (result.save.ok) expect.unreachable();
    expect(result.save.code).toBe('INTERRUPTION_INCONSISTENT');
  });
});

// ── Checkpoint facts a writer may have invalidated ─────────────────────────

/**
 * V1-05-RR-F8.
 *
 * `worktreeCleanAtCheckpoint` and `currentCommit` are checkpoint facts: they
 * were true when something last looked. Carrying them across a *writer's*
 * interruption asserts they are still true, and the whole point of the writer
 * is that it changes the worktree.
 *
 * The consequence is not cosmetic, and it is the reason this is a defect rather
 * than an untidiness. `reconcile.ts` reads `worktreeCleanAtCheckpoint: true` as
 * a record that contradicts a dirty tree, raises `WORKTREE_DIRTY`, and a
 * dirty-tree finding makes the verdict `DIVERGED`. `classifyResume` then
 * short-circuits every diverged reconciliation to `STATE_DIVERGED` /
 * `BLOCKED` — so a routine, self-clearing quota pause was being escalated into
 * `RESUME_STATE_DIVERGED`, a state that is `resumable: false`, for the one
 * reason that is guaranteed to be true of every interrupted writer.
 *
 * `reconcile.ts` says as much itself: an interrupted `IMPLEMENTING` whose
 * checkpoint recorded `worktreeCleanAtCheckpoint: false` is "a task with work
 * in progress, which is the normal thing to find and the case this slice exists
 * to survive". Nothing was writing that `false`.
 */
describe('an interrupted writer stops claiming checkpoint facts it may have invalidated', () => {
  it.each([
    ['IMPLEMENTING', 'IMPLEMENT'],
    ['REMEDIATING', 'REMEDIATE'],
  ] as const)(
    'stops claiming a clean worktree and a known HEAD after %s',
    (state, phase) => {
      const root = repoRoot();
      const before = inFlightState(root, { state, worktreeCleanAtCheckpoint: true });
      const current = persisted(root, before);
      expect(before.worktreeCleanAtCheckpoint).toBe(true);
      expect(before.currentCommit).toBe(SHA_B);

      const result = record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT'), {
        blockedAgent: 'claude',
        resumeFrom: { phase, round: 1 },
        reportedResetAt: null,
      });
      expect(result.outcome).toBe('PAUSED_USAGE_LIMIT');

      const reloaded = loadTaskState(root, TASK_ID);
      if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
      // Not "the tree is dirty" — "this state no longer claims it is clean".
      // Nothing here observed the worktree, and nothing here may pretend to.
      expect(reloaded.state.worktreeCleanAtCheckpoint).toBe(false);
      // Likewise: the writer may have committed, so the recorded HEAD is no
      // longer a fact. `null` is "unknown", which is what we have.
      expect(reloaded.state.currentCommit).toBeNull();
      // The durable evidence that did not become stale is untouched.
      expect(reloaded.state.basePinnedCommit).toBe(SHA_A);
      expect(reloaded.state.findingHistory).toEqual(before.findingHistory);
    },
  );

  /**
   * The reviewer is contractually read-only — a write attempt by it is a scope
   * violation, not ordinary work — so its interruption invalidates nothing. The
   * asymmetry is the point: invalidating on every interruption would throw away
   * true evidence for a run that could not have changed it.
   */
  it('leaves the checkpoint intact when the read-only reviewer was interrupted', () => {
    const root = repoRoot();
    const before = inFlightState(root, { state: 'REVIEWING', worktreeCleanAtCheckpoint: true });
    const current = persisted(root, before);

    record(
      current,
      root,
      interruption('AGENT_NEEDS_ATTENTION', {
        blockedAgent: 'codex',
        resumeFrom: { phase: 'REVIEW', round: 1 },
        reportedResetAt: null,
      }),
    );

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    expect(reloaded.state.worktreeCleanAtCheckpoint).toBe(true);
    expect(reloaded.state.currentCommit).toBe(SHA_B);
  });

  /**
   * The end-to-end claim, through the real reconciler rather than by reading
   * the fields back: a writer interrupted by governed usage exhaustion, over a
   * worktree it has since modified and committed to, must still be a resumable
   * pause — not `STATE_DIVERGED`.
   *
   * This is the test that would have caught the defect. Both halves of it are
   * real: the state comes from `recordAgentInterruption` through the real
   * store, and the verdict comes from `reconcileTaskState` over an observation
   * of a dirty tree at a moved HEAD.
   */
  it('leaves a usage-limit pause resumable rather than diverged', async () => {
    const root = repoRoot();
    const worktreePath = worktreeOf(root);
    const before = inFlightState(root, {
      state: 'IMPLEMENTING',
      worktreeCleanAtCheckpoint: true,
    });
    const current = persisted(root, before);

    record(current, root, interruption('AGENT_BLOCKED_USAGE_LIMIT'), CLAUDE_BLOCK);

    const reloaded = loadTaskState(root, TASK_ID);
    if (reloaded.classification !== 'STATE_VALID') expect.unreachable();
    const state = reloaded.state;

    // What the writer left behind: an edited tree, sitting on a commit that is
    // neither the pinned base nor anything a checkpoint recorded.
    const WRITTEN = 'd'.repeat(40);
    const git = scriptedWriterGit(root, worktreePath, state.workBranch, WRITTEN);
    const observed = await observeRuntime(git, state, { exists: () => true });
    expect(observed.worktreeClean).toBe(false);

    const report = reconcileTaskState(state, observed, {
      repository: {
        id: state.repositoryId,
        root: state.repositoryRoot,
        defaultBranch: state.baseBranch,
      },
      taskId: state.taskId,
    });

    expect(report.findings).not.toContain('WORKTREE_DIRTY');
    expect(report.findings).not.toContain('CURRENT_COMMIT_MOVED');
    expect(report.verdict).toBe('CONSISTENT');
  });
});

/* ═════════ V1-07-RR-B2 — one definition of "this phase mutates" ═════════════ */

/**
 * The phase table and the withdrawal rule are shared rather than restated,
 * because more than one durable write has to answer the same question: the
 * interruption above, and the run driver's resume into a work phase. Two
 * tables would be two opinions about what `REMEDIATING` costs a checkpoint,
 * and they would disagree the first time one of them was edited.
 *
 * Asserted directly, so the rule is pinned once rather than only inferred from
 * whichever caller happens to exercise it.
 */
describe('the mutating-phase rule is stated once and is total', () => {
  it('names the writer’s phases as mutating and the reviewer’s as not', () => {
    expect(phaseMutatesRepository('IMPLEMENTING')).toBe(true);
    expect(phaseMutatesRepository('REMEDIATING')).toBe(true);
    expect(phaseMutatesRepository('REVIEWING')).toBe(false);
  });

  /**
   * `VERIFYING` runs the project's own commands and no agent at all, which is
   * why it is absent from the table — and absence must answer "does not
   * mutate" rather than throwing or returning `undefined`, because both
   * callers spread the result into a state object.
   */
  it.each(['VERIFYING', 'WORKTREE_READY', 'BLOCKED_USAGE_LIMIT', 'READY_FOR_PR'] as const)(
    'treats %s, which runs no agent, as mutating nothing',
    (state) => {
      expect(phaseMutatesRepository(state)).toBe(false);
      expect(withdrawnCheckpointFor(state)).toEqual({});
    },
  );

  it('withdraws exactly the two checkpoint claims, and only for a mutating phase', () => {
    for (const phase of ['IMPLEMENTING', 'REMEDIATING'] as const) {
      expect(withdrawnCheckpointFor(phase)).toEqual({
        worktreeCleanAtCheckpoint: false,
        currentCommit: null,
      });
    }
    // Not a weaker claim in the other direction: nothing is asserted about the
    // reviewer's worktree, so the spread contributes no field at all.
    expect(withdrawnCheckpointFor('REVIEWING')).toEqual({});
  });
});
