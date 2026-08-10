/**
 * V1-06 — the governed verify → review → remediate loop.
 *
 * This file is about the four ways a loop like this quietly ruins a task, and
 * every test here is written against one of them:
 *
 *  1. **Advancing on the absence of evidence.** A verification that never ran,
 *     a reviewer that exited 0 without producing a document — neither is a
 *     pass, and the fail-open reading of both is the same sentence: "nothing
 *     said no".
 *  2. **Losing the evidence it already had.** `findingHistory` is what
 *     `reconcile.ts` reads as proof a task has done work, so a round that
 *     overwrites it rather than appending turns the loop's own progress into
 *     reported divergence.
 *  3. **Spending a budget it does not own.** The bound on remediation is
 *     `maxReviewRounds`, which comes from the repository profile — not a
 *     constant here, and not a retry count this slice invented.
 *  4. **Reporting progress that never reached disk.** A step that returns
 *     success on the strength of an in-memory result whose write was refused
 *     has fabricated exactly the thing the durable state exists to prevent.
 *
 * The real store is used against real temporary directories, for the reason
 * `agent-interruption-state.test.ts` gives: the compare-and-swap refusals
 * asserted here are reproducible on real files, and asserting them against a
 * fake would prove only that the fake agreed.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentCommandResult, AgentRunner } from '../src/agent/agent-command.js';
import type { TaskStateInput } from '../src/core/task-state.js';
import type { ResolvedVerificationPolicy } from '../src/repo/resolve-repository.js';
import {
  loadTaskState,
  saveTaskState,
  type StateLoadSuccess,
} from '../src/state/state-store.js';
import {
  observeCompletion,
  runLoopStep,
  runRemediateStep,
  runReviewStep,
  runVerifyStep,
  type CompletionObserver,
  type LoopDependencies,
} from '../src/loop/loop-step.js';
import type { VerificationCommandResult, VerificationRunner } from '../src/verify/verify-command.js';
import {
  agentCommandResult,
  claudeSuccessEnvelope,
  codexTranscript,
  passingReview,
  SHA_A,
  SHA_B,
  validCreatedState,
} from './fixtures.js';

const NOW = '2026-08-10T09:00:00.000Z';
const TASK_ID = 'task-0001';

const tempDirs: string[] = [];

function repoRoot(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-loop-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** One declared phase. The profile schema guarantees a `VERIFY` phase exists. */
const VERIFICATION: ResolvedVerificationPolicy = Object.freeze({
  phases: Object.freeze([
    Object.freeze({ phase: 'VERIFY' as const, command: Object.freeze(['npm', 'run', 'verify']) }),
  ]),
});

function loopState(root: string, overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return validCreatedState({
    repositoryRoot: root,
    worktreePath: join(root, 'worktree'),
    state: 'VERIFYING',
    basePinnedCommit: SHA_A,
    currentCommit: SHA_B,
    reviewRound: 0,
    maxReviewRounds: 3,
    worktreeCleanAtCheckpoint: false,
    ...overrides,
  });
}

/** Persists a state and hands back the `StateLoadSuccess` a step needs. */
function persist(root: string, overrides: Partial<TaskStateInput> = {}): StateLoadSuccess {
  const saved = saveTaskState(loopState(root, overrides), { repositoryRoot: root });
  expect(saved.ok).toBe(true);
  const load = loadTaskState(root, TASK_ID);
  if (!load.ok) throw new Error(`fixture did not load: ${load.code}`);
  return load;
}

function reload(root: string) {
  const load = loadTaskState(root, TASK_ID);
  if (!load.ok) throw new Error(`state did not load: ${load.code}`);
  return load;
}

/** A verification seam answering with fixed results, one per call, and counting. */
function scriptedVerify(...results: Partial<VerificationCommandResult>[]) {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  let index = 0;
  const runner: VerificationRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    const overrides = results[Math.min(index, results.length - 1)] ?? {};
    index += 1;
    return Object.freeze({
      outcome: 'RAN' as const,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      failureCode: null,
      errnoCode: null,
      durationMs: 5,
      ...overrides,
    });
  };
  return { runner, calls };
}

/** An agent seam answering with fixed results, one per call, and counting. */
function scriptedAgent(...results: AgentCommandResult[]) {
  const calls: { agent: string; cwd: string; payload: string }[] = [];
  let index = 0;
  const runner: AgentRunner = async (agent, _args, cwd, payload) => {
    calls.push({ agent, cwd, payload });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result === undefined) throw new Error('unscripted agent call');
    return result;
  };
  return { runner, calls };
}

/** A seam that throws past `cap`, so an unbounded loop fails as an error, not a hang. */
function cappedAgent(result: AgentCommandResult, cap: number) {
  let calls = 0;
  const runner: AgentRunner = async () => {
    calls += 1;
    if (calls > cap) throw new Error(`agent invoked more than ${cap} times`);
    return result;
  };
  return { runner, count: () => calls };
}

const settledObserver: CompletionObserver = async () =>
  Object.freeze({ currentCommit: SHA_B, worktreeClean: true });

function deps(root: string, overrides: Partial<LoopDependencies> = {}): LoopDependencies {
  return {
    repositoryRoot: root,
    now: NOW,
    verification: VERIFICATION,
    taskBrief: 'Add a widget.',
    observe: settledObserver,
    ...overrides,
  };
}

/** A reviewer transcript reporting one finding. */
function findingsReview(rule = 'classification.order'): string {
  return codexTranscript({
    reviewVersion: 1,
    verdict: 'FINDINGS',
    findings: [{ severity: 'high', path: 'src/agent/claude-writer.ts', rule }],
  });
}

/* ───────────────────────────── the verify stage ─────────────────────────── */

describe('the verify stage', () => {
  it('advances to REVIEWING when every declared phase passes', async () => {
    const root = repoRoot();
    const verify = scriptedVerify({ exitCode: 0 });

    const step = await runVerifyStep(persist(root), deps(root, { verify: verify.runner }));

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('REVIEWING');
    expect(reload(root).state.state).toBe('REVIEWING');
    expect(verify.calls).toHaveLength(1);
    // The declared argv, unaltered, in the recorded worktree.
    expect(verify.calls[0]?.command).toBe('npm');
    expect(verify.calls[0]?.args).toEqual(['run', 'verify']);
    expect(verify.calls[0]?.cwd).toBe(join(root, 'worktree'));
  });

  /**
   * The fail-open reading of every row below is the same sentence — "nothing
   * said no" — and each row is a different way of not saying it.
   */
  it.each([
    ['a non-zero exit', { exitCode: 1 }, 'BLOCKED_VERIFY'],
    ['a process that never started', { outcome: 'UNAVAILABLE' as const, exitCode: null }, 'HUMAN_DECISION_REQUIRED'],
    ['a run killed from outside', { outcome: 'UNAVAILABLE' as const, exitCode: null, signal: 'SIGKILL' as const }, 'HUMAN_DECISION_REQUIRED'],
    ['a refused argv', { outcome: 'REFUSED_UNSAFE_ARGUMENT' as const, exitCode: null }, 'HUMAN_DECISION_REQUIRED'],
  ])('does not reach REVIEWING on %s', async (_label, overrides, expected) => {
    const root = repoRoot();
    const verify = scriptedVerify(overrides);

    const step = await runVerifyStep(persist(root), deps(root, { verify: verify.runner }));

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe(expected);
    const after = reload(root).state;
    expect(after.state).toBe(expected);
    expect(after.reviewRound).toBe(0);
  });

  /**
   * "The build is broken" and "we could not run the build" send an operator to
   * different places. Collapsing them is the cheapest way to have someone spend
   * an afternoon on a repository that is fine.
   */
  it('separates a failing verification from an unrunnable one', async () => {
    const root = repoRoot();
    const failed = await runVerifyStep(
      persist(root),
      deps(root, { verify: scriptedVerify({ exitCode: 1 }).runner }),
    );
    expect(failed.verification?.verdict).toBe('FAILED');
    expect(failed.state).toBe('BLOCKED_VERIFY');

    const root2 = repoRoot();
    const unavailable = await runVerifyStep(
      persist(root2),
      deps(root2, { verify: scriptedVerify({ outcome: 'UNAVAILABLE', exitCode: null }).runner }),
    );
    expect(unavailable.verification?.verdict).toBe('UNAVAILABLE');
    expect(unavailable.state).toBe('HUMAN_DECISION_REQUIRED');
  });

  /**
   * `BLOCKED_VERIFY` is `automaticResumeEligible: false`: resuming it means
   * handing the failure to the writing agent, which the repository defines as a
   * decision rather than a retry. So the loop stops there — and that refusal is
   * also what bounds the one cycle `maxReviewRounds` does not, since
   * VERIFYING → BLOCKED_VERIFY → REMEDIATING → VERIFYING never touches
   * `reviewRound`.
   */
  it('will not continue a task out of BLOCKED_VERIFY on its own', async () => {
    const root = repoRoot();
    const current = persist(root, { state: 'BLOCKED_VERIFY', blockedAgent: null, resumeFrom: { phase: 'REMEDIATE', round: 1 } });
    const agent = cappedAgent(agentCommandResult(), 0);

    const step = await runLoopStep(current, deps(root, { agent: agent.runner }));

    expect(step.outcome).toBe('NOT_APPLICABLE');
    expect(step.save).toBeNull();
    expect(agent.count()).toBe(0);
    expect(reload(root).state.state).toBe('BLOCKED_VERIFY');
  });
});

/* ───────────────────────────── the review stage ─────────────────────────── */

describe('the review stage', () => {
  it('reaches READY_FOR_PR on a validated clean review over a settled worktree', async () => {
    const root = repoRoot();
    const agent = scriptedAgent(agentCommandResult({ stdout: codexTranscript(passingReview()) }));

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING' }),
      deps(root, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('COMPLETED');
    const after = reload(root).state;
    expect(after.state).toBe('READY_FOR_PR');
    expect(after.reviewRound).toBe(1);
    expect(after.worktreeCleanAtCheckpoint).toBe(true);
    expect(after.currentCommit).toBe(SHA_B);
  });

  /**
   * The liveness control for the rules below. Without it, an implementation
   * that simply never passes would satisfy every negative test in this file —
   * and would make `READY_FOR_PR` unreachable for any task a reviewer ever
   * commented on.
   */
  it('reaches READY_FOR_PR even when earlier rounds found things, and keeps that history', async () => {
    const root = repoRoot();
    const agent = scriptedAgent(agentCommandResult({ stdout: codexTranscript(passingReview()) }));
    const history = [{ round: 1, severity: 'high' as const, fingerprint: 'a'.repeat(32) }];

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING', reviewRound: 1, findingHistory: history }),
      deps(root, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('COMPLETED');
    const after = reload(root).state;
    expect(after.state).toBe('READY_FOR_PR');
    expect(after.reviewRound).toBe(2);
    expect(after.findingHistory).toEqual(history);
  });

  /**
   * Every row is a reviewer that did not produce a review. None of them may be
   * read as an empty finding list: `runCodexReviewer` refuses to put `findings`
   * on its failure member precisely so this step cannot read one from the other.
   */
  it.each([
    ['empty stdout', agentCommandResult({ stdout: '' })],
    ['whitespace only', agentCommandResult({ stdout: '   ' })],
    ['a transcript with no completed turn', agentCommandResult({ stdout: codexTranscript(passingReview(), { completed: false }) })],
    ['a truncated transcript that parses', agentCommandResult({ outcome: 'UNAVAILABLE', outputTruncated: true, stdout: codexTranscript(passingReview()) })],
    ['a future document version', agentCommandResult({ stdout: codexTranscript({ reviewVersion: 2, verdict: 'PASS', findings: [] }) })],
    ['prose around the document', agentCommandResult({ stdout: codexTranscript('Looks good to me!') })],
    ['exit 0 with a SIGTERM', agentCommandResult({ exitCode: 0, signal: 'SIGTERM', stdout: codexTranscript(passingReview()) })],
  ])('never treats %s as a clean review', async (_label, result) => {
    const root = repoRoot();

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING' }),
      deps(root, { agent: scriptedAgent(result).runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    const after = reload(root).state;
    expect(after.state).not.toBe('READY_FOR_PR');
    expect(after.state).not.toBe('REMEDIATING');
    // An interrupted round was not a completed round.
    expect(after.reviewRound).toBe(0);
    expect(after.blockedAgent).toBe('codex');
    expect(after.resumeFrom).toEqual({ phase: 'REVIEW', round: 1 });
  });

  it('routes a valid review carrying findings to REMEDIATING', async () => {
    const root = repoRoot();

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING' }),
      deps(root, { agent: scriptedAgent(agentCommandResult({ stdout: findingsReview() })).runner }),
    );

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('REMEDIATING');
    const after = reload(root).state;
    expect(after.reviewRound).toBe(1);
    expect(after.findingHistory).toHaveLength(1);
    expect(after.findingHistory[0]?.round).toBe(1);
    expect(after.findingHistory[0]?.severity).toBe('high');
    expect(after.findingHistory[0]?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  /**
   * A finding is not a licence to finish, whatever its severity. If `info`-only
   * findings were ever to count as passable that would be a product rule with
   * its own name and its own test — not an unreviewed `filter` in a routing
   * expression.
   */
  it('does not complete a task over low-severity findings', async () => {
    const root = repoRoot();
    const review = codexTranscript({
      reviewVersion: 1,
      verdict: 'FINDINGS',
      findings: [
        { severity: 'low', path: 'src/a.ts', rule: 'style.nit' },
        { severity: 'info', path: 'src/b.ts', rule: 'style.note' },
      ],
    });

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING' }),
      deps(root, { agent: scriptedAgent(agentCommandResult({ stdout: review })).runner }),
    );

    expect(reload(root).state.state).toBe('REMEDIATING');
    expect(step.state).not.toBe('READY_FOR_PR');
  });

  /**
   * `findingHistory` is appended to, and repeats are kept. The same finding in
   * rounds 1 and 2 is the evidence that remediation did not work; a `Set` keyed
   * on the fingerprint would delete precisely that fact.
   */
  it('appends to the finding history without disturbing earlier rounds', async () => {
    const root = repoRoot();
    const earlier = [
      { round: 1, severity: 'high' as const, fingerprint: 'a'.repeat(32) },
      { round: 1, severity: 'low' as const, fingerprint: 'b'.repeat(32) },
    ];

    await runReviewStep(
      persist(root, { state: 'REVIEWING', reviewRound: 1, findingHistory: earlier }),
      deps(root, { agent: scriptedAgent(agentCommandResult({ stdout: findingsReview() })).runner }),
    );

    const after = reload(root).state;
    expect(after.findingHistory).toHaveLength(3);
    expect(after.findingHistory.slice(0, 2)).toEqual(earlier);
    expect(after.findingHistory[2]?.round).toBe(2);
  });

  it('keeps a repeat finding as its own record rather than de-duplicating it', async () => {
    const root = repoRoot();
    // Round 1 recorded the fingerprint the same finding will produce again.
    const first = await runReviewStep(
      persist(root, { state: 'REVIEWING' }),
      deps(root, { agent: scriptedAgent(agentCommandResult({ stdout: findingsReview() })).runner }),
    );
    expect(first.state).toBe('REMEDIATING');
    const round1 = reload(root).state.findingHistory;

    // The very same finding, reported again in round 2.
    const current = reload(root);
    const saved = saveTaskState(
      { ...current.state, state: 'REVIEWING', stateEnteredAt: NOW },
      { repositoryRoot: root, expectedRevision: current.revision },
    );
    expect(saved.ok).toBe(true);

    await runReviewStep(
      reload(root),
      deps(root, { agent: scriptedAgent(agentCommandResult({ stdout: findingsReview() })).runner }),
    );

    const after = reload(root).state;
    expect(after.findingHistory).toHaveLength(2);
    expect(after.findingHistory[0]?.fingerprint).toBe(after.findingHistory[1]?.fingerprint);
    expect(after.findingHistory.map((f) => f.round)).toEqual([1, 2]);
    expect(round1).toHaveLength(1);
  });

  /**
   * `READY_FOR_PR` demands a settled commit and a clean worktree, and no
   * reviewer can attest to either. When they cannot be positively established
   * the task goes to a human — a clean review is necessary for completion, and
   * on its own never sufficient.
   */
  it.each([
    ['an unobservable worktree', { currentCommit: null, worktreeClean: null }],
    ['uncommitted work', { currentCommit: SHA_B, worktreeClean: false }],
    ['an unresolved HEAD', { currentCommit: null, worktreeClean: true }],
  ])('does not complete a task over %s, even on a clean review', async (_label, checkpoint) => {
    const root = repoRoot();
    const observe: CompletionObserver = async () => Object.freeze(checkpoint);

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING' }),
      deps(root, {
        agent: scriptedAgent(agentCommandResult({ stdout: codexTranscript(passingReview()) })).runner,
        observe,
      }),
    );

    expect(step.outcome).toBe('BLOCKED');
    const after = reload(root).state;
    expect(after.state).toBe('HUMAN_DECISION_REQUIRED');
    // The round still completed — it is the *completion* that is refused.
    expect(after.reviewRound).toBe(1);
  });
});

/* ─────────────────────────────── the bound ──────────────────────────────── */

describe('the remediation bound', () => {
  /**
   * The budget is the state's, taken from the repository profile's
   * `completion.maxReviewRounds`. A remediation pass is only worth starting if
   * its result could still be reviewed; at the last permitted round it could
   * not, so the task goes to a human with its evidence intact.
   */
  it('refuses a further remediation round at the budget, and does not run the writer', async () => {
    const root = repoRoot();
    const agent = scriptedAgent(agentCommandResult({ stdout: findingsReview() }));

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING', reviewRound: 1, maxReviewRounds: 2 }),
      deps(root, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    const after = reload(root).state;
    expect(after.state).not.toBe('REMEDIATING');
    expect(after.reviewRound).toBe(2);
    // The review itself ran and was recorded; only the *next* pass is refused.
    expect(after.findingHistory).toHaveLength(1);
    expect(agent.calls).toHaveLength(1);
  });

  /** The bound is read from the state, not from a constant in this module. */
  it('honours a budget of one round', async () => {
    const root = repoRoot();

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING', reviewRound: 0, maxReviewRounds: 1 }),
      deps(root, { agent: scriptedAgent(agentCommandResult({ stdout: findingsReview() })).runner }),
    );

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(reload(root).state.reviewRound).toBe(1);
  });

  /** A review that could not be performed within the budget is not performed at all. */
  it('does not spend an agent run on a round the budget cannot hold', async () => {
    const root = repoRoot();
    const agent = cappedAgent(agentCommandResult({ stdout: findingsReview() }), 0);

    const step = await runReviewStep(
      persist(root, { state: 'REVIEWING', reviewRound: 2, maxReviewRounds: 2 }),
      deps(root, { agent: agent.runner }),
    );

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(agent.count()).toBe(0);
  });

  /**
   * Liveness under a reviewer that never runs out of findings. Every seam is
   * capped and throws past its cap, so an unbounded loop fails as a test error
   * rather than hanging — which is what makes "no infinite loop" a proposition
   * a test can actually settle.
   */
  it('terminates against a reviewer that always finds something', async () => {
    const root = repoRoot();
    let reviews = 0;
    const agent: AgentRunner = async (which) => {
      if (which === 'codex') {
        reviews += 1;
        if (reviews > 10) throw new Error('reviewer invoked more than 10 times');
        return agentCommandResult({ stdout: findingsReview(`round.${reviews}`) });
      }
      return agentCommandResult({ stdout: claudeSuccessEnvelope() });
    };
    const verify = scriptedVerify({ exitCode: 0 });

    let current = persist(root, { state: 'VERIFYING', maxReviewRounds: 2 });
    const seen: string[] = [];

    for (let step = 0; step < 12; step += 1) {
      const outcome = await runLoopStep(
        current,
        deps(root, { agent, verify: verify.runner }),
      );
      if (outcome.outcome === 'NOT_APPLICABLE' || outcome.outcome === 'STATE_NOT_RECORDED') break;
      seen.push(String(outcome.state));
      if (outcome.outcome !== 'ADVANCED') break;
      current = reload(root);
    }

    expect(seen.at(-1)).toBe('HUMAN_DECISION_REQUIRED');
    // Exactly the budget: two reviews, and no third.
    expect(reviews).toBe(2);
    expect(reload(root).state.reviewRound).toBe(2);
  });
});

/* ──────────────────────────── the remediate stage ───────────────────────── */

describe('the remediate stage', () => {
  it('returns a completed writer to VERIFYING, and never straight to REVIEWING', async () => {
    const root = repoRoot();
    const agent = scriptedAgent(agentCommandResult({ stdout: claudeSuccessEnvelope() }));

    const step = await runRemediateStep(
      persist(root, { state: 'REMEDIATING', reviewRound: 1 }),
      deps(root, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('VERIFYING');
    const after = reload(root).state;
    expect(after.state).toBe('VERIFYING');
    // The writer finished; that is not the same as the task being fixed, so no
    // round was consumed and nothing was declared clean.
    expect(after.reviewRound).toBe(1);
    expect(after.worktreeCleanAtCheckpoint).toBe(false);
    expect(after.currentCommit).toBeNull();
  });

  /**
   * "The writer ran, so verification is next" is the tempting mutation, and it
   * is wrong exactly when it matters: the run that failed is the incomplete one.
   */
  it.each([
    ['a non-zero exit', agentCommandResult({ exitCode: 2 })],
    ['a malformed envelope', agentCommandResult({ stdout: 'Done!' })],
    ['a process that never ran', agentCommandResult({ outcome: 'UNAVAILABLE', exitCode: null })],
    ['a run killed from outside', agentCommandResult({ exitCode: 0, signal: 'SIGTERM', stdout: claudeSuccessEnvelope() })],
  ])('does not advance out of REMEDIATING on %s', async (_label, result) => {
    const root = repoRoot();
    const verify = scriptedVerify({ exitCode: 0 });

    const step = await runRemediateStep(
      persist(root, { state: 'REMEDIATING', reviewRound: 1 }),
      deps(root, { agent: scriptedAgent(result).runner, verify: verify.runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    const after = reload(root).state;
    expect(after.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(after.state).not.toBe('VERIFYING');
    expect(after.blockedAgent).toBe('claude');
    expect(after.resumeFrom).toEqual({ phase: 'REMEDIATE', round: 1 });
    expect(verify.calls).toHaveLength(0);
  });

  it('pauses on a usage limit rather than escalating it', async () => {
    const root = repoRoot();
    const refusal = agentCommandResult({
      exitCode: 1,
      stdout: JSON.stringify({ type: 'result', is_error: true, api_error_status: 429 }),
    });

    const step = await runRemediateStep(
      persist(root, { state: 'REMEDIATING', reviewRound: 1 }),
      deps(root, { agent: scriptedAgent(refusal).runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    const after = reload(root).state;
    expect(after.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(after.blockedAgent).toBe('claude');
    // Never fabricated: no reset time was reported, so none is recorded, and
    // `evaluateAutomaticResume` keeps refusing with RESET_TIME_MISSING.
    expect(after.reportedResetAt).toBeNull();
    expect(after.findingHistory).toEqual([]);
  });

  /**
   * The remediation prompt names what to fix. `path` and `rule` are held in
   * memory only — they are agent-authored text and never reach `TaskState` —
   * so a resumed pass gets a weaker prompt that says so rather than a confident
   * one built on evidence that did not survive.
   */
  it('hands the writer the findings it must address', async () => {
    const root = repoRoot();
    const review = await runReviewStep(
      persist(root, { state: 'REVIEWING' }),
      deps(root, { agent: scriptedAgent(agentCommandResult({ stdout: findingsReview() })).runner }),
    );

    expect(review.remediationPayload).toContain('src/agent/claude-writer.ts');
    expect(review.remediationPayload).toContain('classification.order');

    const writer = scriptedAgent(agentCommandResult({ stdout: claudeSuccessEnvelope() }));
    await runRemediateStep(
      reload(root),
      deps(root, {
        agent: writer.runner,
        ...(review.remediationPayload === null ? {} : { remediationPayload: review.remediationPayload }),
      }),
    );

    expect(writer.calls[0]?.payload).toContain('src/agent/claude-writer.ts');
  });

  it('tells the writer when the detail did not survive a restart', async () => {
    const root = repoRoot();
    const writer = scriptedAgent(agentCommandResult({ stdout: claudeSuccessEnvelope() }));

    await runRemediateStep(
      persist(root, {
        state: 'REMEDIATING',
        reviewRound: 1,
        findingHistory: [{ round: 1, severity: 'high', fingerprint: 'c'.repeat(32) }],
      }),
      deps(root, { agent: writer.runner }),
    );

    const payload = writer.calls[0]?.payload ?? '';
    expect(payload).toContain('did not survive');
    expect(payload).toContain('c'.repeat(32));
    expect(payload).not.toContain('undefined');
  });
});

/* ───────────────────────── durability, CAS and resume ───────────────────── */

describe('durability', () => {
  /**
   * The property the whole slice rests on: progress lives on disk, never in a
   * closure. A refused write is reported as a refusal, and a second invocation
   * re-runs the step rather than trusting a result it never persisted.
   */
  it('reports a refused write instead of the decision it could not record', async () => {
    const root = repoRoot();
    const current = persist(root, { state: 'REVIEWING' });
    const before = readFileSync(current.path, 'utf8');

    const step = await runReviewStep(
      current,
      deps(root, {
        agent: scriptedAgent(agentCommandResult({ stdout: findingsReview() })).runner,
        replace: () => {
          throw new Error('crash between decision and write');
        },
      }),
    );

    expect(step.outcome).toBe('STATE_NOT_RECORDED');
    expect(step.save?.ok).toBe(false);
    expect(step.state).toBeNull();
    // The previous state survives, byte for byte.
    expect(readFileSync(current.path, 'utf8')).toBe(before);
    expect(reload(root).revision).toBe(current.revision);
  });

  it('re-runs a step whose write never landed, and lands it exactly once', async () => {
    const root = repoRoot();
    const current = persist(root, { state: 'REVIEWING' });
    const agent = scriptedAgent(
      agentCommandResult({ stdout: findingsReview() }),
      agentCommandResult({ stdout: findingsReview() }),
    );

    const crashed = await runReviewStep(
      current,
      deps(root, {
        agent: agent.runner,
        replace: () => {
          throw new Error('crash');
        },
      }),
    );
    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');

    const retried = await runReviewStep(reload(root), deps(root, { agent: agent.runner }));

    expect(retried.outcome).toBe('ADVANCED');
    expect(agent.calls).toHaveLength(2);
    const after = reload(root).state;
    expect(after.reviewRound).toBe(1);
    expect(after.findingHistory).toHaveLength(1);
  });

  /**
   * A writer that moved the task on while the reviewer was running must not be
   * overwritten by a result computed against the older state.
   */
  it('fails closed when another writer got there first', async () => {
    const root = repoRoot();
    const current = persist(root, { state: 'REVIEWING' });

    // A competitor lands between the load and the loop's write.
    const competitor = saveTaskState(
      { ...current.state, state: 'ABORTED', stateEnteredAt: '2026-08-10T08:00:00.000Z' },
      { repositoryRoot: root, expectedRevision: current.revision },
    );
    expect(competitor.ok).toBe(true);
    const competitorBytes = readFileSync(current.path, 'utf8');

    const step = await runReviewStep(
      current,
      deps(root, { agent: scriptedAgent(agentCommandResult({ stdout: findingsReview() })).runner }),
    );

    expect(step.outcome).toBe('STATE_NOT_RECORDED');
    expect(step.save?.ok).toBe(false);
    if (step.save?.ok === false) expect(step.save.code).toBe('STATE_CONFLICT');
    // The competitor's state survives untouched.
    expect(readFileSync(current.path, 'utf8')).toBe(competitorBytes);
    expect(reload(root).state.state).toBe('ABORTED');
  });

  /** A full cycle, asserting the round after every durable write. */
  it('consumes exactly one review round per completed review', async () => {
    const root = repoRoot();
    const verify = scriptedVerify({ exitCode: 0 });
    const agent: AgentRunner = async (which) =>
      which === 'codex'
        ? agentCommandResult({ stdout: findingsReview() })
        : agentCommandResult({ stdout: claudeSuccessEnvelope() });

    let current = persist(root, { state: 'VERIFYING', maxReviewRounds: 3 });
    const trail: [string, number][] = [];

    for (let i = 0; i < 4; i += 1) {
      const step = await runLoopStep(current, deps(root, { agent, verify: verify.runner }));
      if (step.outcome !== 'ADVANCED') break;
      const after = reload(root).state;
      trail.push([after.state, after.reviewRound]);
      current = reload(root);
    }

    expect(trail).toEqual([
      ['REVIEWING', 0],
      ['REMEDIATING', 1],
      ['VERIFYING', 1],
      ['REVIEWING', 1],
    ]);
  });

  /** The dispatcher reads the durable state, never a caller's claim about it. */
  it('does nothing for a state the loop does not drive', async () => {
    const root = repoRoot();
    const agent = cappedAgent(agentCommandResult(), 0);

    for (const state of ['READY_FOR_PR', 'BLOCKED_USAGE_LIMIT', 'HUMAN_DECISION_REQUIRED'] as const) {
      const overrides: Partial<TaskStateInput> =
        state === 'READY_FOR_PR'
          ? { state, reviewRound: 1, worktreeCleanAtCheckpoint: true }
          : state === 'BLOCKED_USAGE_LIMIT'
            ? { state, blockedAgent: 'claude', resumeFrom: { phase: 'REMEDIATE', round: 1 } }
            : { state, resumeFrom: { phase: 'VERIFY', round: 1 } };

      const root2 = repoRoot();
      const step = await runLoopStep(persist(root2, overrides), deps(root2, { agent: agent.runner }));
      expect(step.outcome).toBe('NOT_APPLICABLE');
      expect(step.save).toBeNull();
    }
    expect(agent.count()).toBe(0);
    void root;
  });

  it('exposes a production completion observer', () => {
    expect(typeof observeCompletion).toBe('function');
  });
});
