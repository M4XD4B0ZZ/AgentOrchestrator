/**
 * The two V1-05 followups that V1-06 turns from latent into live, and the
 * regression tests that pin them shut.
 *
 * Both were harmless while `src/agent/*` had no production caller — the only
 * thing reaching those boundaries was a test that passed them well-formed
 * input. V1-06 is the first slice that hands them values read back from a
 * persisted state file, and this repository's own model of that file is that
 * anything may have edited it. That is the whole of the reclassification: the
 * code did not change its behaviour, its inputs stopped being trustworthy.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRunner } from '../src/agent/agent-command.js';
import { runClaudeWriter } from '../src/agent/claude-writer.js';
import { runCodexReviewer } from '../src/agent/codex-reviewer.js';
import { recordAgentInterruption } from '../src/agent/record-interruption.js';
import type { TaskStateInput } from '../src/core/task-state.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { runVerification } from '../src/verify/run-verification.js';
import type { VerificationRunner } from '../src/verify/verify-command.js';
import type { ResolvedVerificationPolicy } from '../src/repo/resolve-repository.js';
import { SHA_A, SHA_B, validCreatedState } from './fixtures.js';
import { leaseAuthorityAt, releaseTestLeases } from './helpers/lease.js';

const tempDirs: string[] = [];

afterEach(() => {
  releaseTestLeases();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function repoRoot(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-follow-')));
  tempDirs.push(dir);
  return dir;
}

/** A seam that records whether it was reached at all. */
function spyAgent() {
  const calls: string[] = [];
  const runner: AgentRunner = async (_agent, _args, cwd) => {
    calls.push(cwd);
    throw new Error('the agent must not have been started');
  };
  return { runner, calls };
}

/**
 * NEW-2 — a relative worktree path.
 *
 * `SAFE_ARG_PATTERN` is a *character* allow-list, so `.` and `..` pass it
 * cleanly, and a relative `cwd` reaches `spawn` verbatim where it resolves
 * against `process.cwd()`. The writing agent carries no `--permission-mode`
 * cap, so a relative path is the difference between an agent editing its
 * isolated worktree and an agent editing whatever tree this process is standing
 * in — including this orchestrator's own checkout.
 */
describe('NEW-2: an agent is never started against a relative worktree path', () => {
  const relative = ['.', '..', 'worktree', 'sub/dir', 'C:foo', ''];

  it.each(relative)('the writer refuses %j without spawning', async (worktreePath) => {
    const agent = spyAgent();

    const outcome = await runClaudeWriter(
      { worktreePath, phase: 'REMEDIATE', round: 1, payload: 'fix it' },
      { agent: agent.runner },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('AGENT_ARGUMENT_REFUSED');
    expect(agent.calls).toHaveLength(0);
  });

  it.each(relative)('the reviewer refuses %j without spawning', async (worktreePath) => {
    const agent = spyAgent();

    const outcome = await runCodexReviewer(
      { worktreePath, round: 1, payload: 'review it', now: '2026-08-29T11:29:57.000Z' },
      { agent: agent.runner },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('AGENT_ARGUMENT_REFUSED');
    expect(agent.calls).toHaveLength(0);
  });

  /** The same exposure exists for a repository's own build and test commands. */
  it('verification refuses a relative worktree path without spawning', async () => {
    const verification: ResolvedVerificationPolicy = {
      phases: [{ phase: 'VERIFY', command: ['npm', 'run', 'verify'] }],
    };
    let started = 0;
    const verify: VerificationRunner = async () => {
      started += 1;
      throw new Error('no command may be started');
    };

    const report = await runVerification({ worktreePath: '.', verification }, { verify });

    expect(report.verdict).toBe('UNAVAILABLE');
    expect(report.phases[0]?.outcome).toBe('REFUSED_UNSAFE_ARGUMENT');
    expect(started).toBe(0);
  });

  /** The control: an absolute path is still accepted, so the guard is not a wall. */
  it('still accepts an absolute worktree path', async () => {
    const calls: string[] = [];
    const agent: AgentRunner = async (_a, _args, cwd) => {
      calls.push(cwd);
      return {
        outcome: 'RAN',
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          api_error_status: null,
        }),
        stderr: '',
        outputTruncated: false,
        failureCode: null,
        errnoCode: null,
        durationMs: 1,
      };
    };
    const absolute = join(repoRoot(), 'worktree');

    const outcome = await runClaudeWriter(
      { worktreePath: absolute, phase: 'REMEDIATE', round: 1, payload: 'fix it' },
      { agent },
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([absolute]);
  });
});

/**
 * NEW-4 — an interruption recorded against a task that is already blocked.
 *
 * `AGENT_PHASES` holds only the three agent-running states, and every guard in
 * `recordAgentInterruption` is gated on finding an entry there. For a task
 * already parked in a blocking state, none of them applied: the agent identity
 * and resume phase were taken from the caller verbatim, and nothing stale was
 * withdrawn.
 *
 * The sharp consequence is a `BLOCKED_USAGE_LIMIT` self-write. `from === to` is
 * a checkpoint rather than a transition, so the table never judged it, and a
 * caller could write an *already elapsed* `reportedResetAt` onto a state that
 * carried none — converting a block `evaluateAutomaticResume` refuses with
 * `RESET_TIME_MISSING` into one it grants on a timer.
 */
describe('NEW-4: a task already blocked has no interruption to record', () => {
  const NOW = '2026-08-10T10:00:00.000Z';
  const ELAPSED = '2026-08-10T09:00:00.000Z';

  function blocked(root: string, overrides: Partial<TaskStateInput>) {
    const saved = saveTaskState(
      validCreatedState({
        repositoryRoot: root,
        worktreePath: join(root, 'worktree'),
        basePinnedCommit: SHA_A,
        currentCommit: SHA_B,
        reviewRound: 1,
        ...overrides,
      }),
      { repositoryRoot: root },
    );
    expect(saved.ok).toBe(true);
    const load = loadTaskState(root, 'task-0001');
    if (!load.ok) throw new Error(`fixture did not load: ${load.code}`);
    return load;
  }

  it('refuses a usage-limit self-write that would fabricate a reset time', async () => {
    const root = repoRoot();
    const current = blocked(root, {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'IMPLEMENT', round: 1 },
      reportedResetAt: null,
    });
    const before = readFileSync(current.path, 'utf8');

    const record = recordAgentInterruption(
      current,
      {
        disposition: 'AGENT_BLOCKED_USAGE_LIMIT',
        block: {
          blockedAgent: 'codex',
          resumeFrom: { phase: 'REVIEW', round: 3 },
          // Already in the past relative to `now`: the value that would make
          // `evaluateAutomaticResume` grant an unattended retry immediately.
          reportedResetAt: ELAPSED,
        },
      },
      {
        now: NOW,
        fallback: { blockedAgent: 'codex', resumeFrom: { phase: 'REVIEW', round: 3 }, reportedResetAt: null },
        lease: leaseAuthorityAt(root),
      },
    );

    expect(record.outcome).toBe('STATE_NOT_RECORDED');
    expect(record.state).toBeNull();
    expect(record.save.ok).toBe(false);
    if (!record.save.ok) expect(record.save.code).toBe('INTERRUPTION_INCONSISTENT');

    // Nothing was written: the block stays governed, and stays un-resumable.
    expect(readFileSync(current.path, 'utf8')).toBe(before);
    const after = loadTaskState(root, 'task-0001');
    if (!after.ok) throw new Error('state vanished');
    expect(after.state.reportedResetAt).toBeNull();
    expect(after.state.blockedAgent).toBe('claude');
    expect(after.state.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });
  });

  it.each([
    ['BLOCKED_AUTH', { state: 'BLOCKED_AUTH' as const, blockedAgent: 'claude' as const, resumeFrom: { phase: 'IMPLEMENT' as const, round: 1 } }],
    ['HUMAN_DECISION_REQUIRED', { state: 'HUMAN_DECISION_REQUIRED' as const, resumeFrom: { phase: 'IMPLEMENT' as const, round: 1 } }],
    ['BLOCKED_VERIFY', { state: 'BLOCKED_VERIFY' as const, blockedAgent: null, resumeFrom: { phase: 'REMEDIATE' as const, round: 1 } }],
  ])('refuses a self-write from %s', async (_label, overrides) => {
    const root = repoRoot();
    const current = blocked(root, overrides);
    const before = readFileSync(current.path, 'utf8');

    const record = recordAgentInterruption(
      current,
      { disposition: 'AGENT_NEEDS_ATTENTION', block: null },
      {
        now: NOW,
        fallback: { blockedAgent: 'codex', resumeFrom: { phase: 'REVIEW', round: 2 }, reportedResetAt: null },
        lease: leaseAuthorityAt(root),
      },
    );

    expect(record.outcome).toBe('STATE_NOT_RECORDED');
    if (!record.save.ok) expect(record.save.code).toBe('INTERRUPTION_INCONSISTENT');
    expect(readFileSync(current.path, 'utf8')).toBe(before);
  });

  /**
   * The control, and the reason this is not a blanket refusal of "no entry in
   * `AGENT_PHASES`": `AUTH_PREFLIGHT` probes real agent credentials and is a
   * legitimate non-agent-phase caller. It is a regular state, not a blocking
   * one, so it must still be able to record a block.
   */
  it('still records an auth block raised during AUTH_PREFLIGHT', async () => {
    const root = repoRoot();
    const current = blocked(root, { state: 'AUTH_PREFLIGHT', reviewRound: 0 });

    const record = recordAgentInterruption(
      current,
      { disposition: 'AGENT_BLOCKED_AUTH', block: null },
      {
        now: NOW,
        fallback: { blockedAgent: 'claude', resumeFrom: { phase: 'IMPLEMENT', round: 1 }, reportedResetAt: null },
        lease: leaseAuthorityAt(root),
      },
    );

    expect(record.outcome).toBe('NEEDS_ATTENTION');
    expect(record.state).toBe('BLOCKED_AUTH');
  });
});
