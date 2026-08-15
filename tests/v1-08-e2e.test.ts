/**
 * V1-08 — the integrated V1 runtime, over real Git.
 *
 * Every slice below V1-07 has its own suite, and each of those builds the layer
 * beneath it as a literal or a script. That is right for asking whether one
 * module holds its own contract, and it cannot answer the question this file
 * exists for: **do the slices agree with each other when nothing is scripted?**
 *
 * So the repository here is a real `git init`, the worktree is a real
 * `git worktree add` made by the production `prepareTaskWorkspace`, the state
 * is a real file written by the production `saveTaskState`, and the registry the
 * driver reads is what `git worktree list --porcelain` really prints on this
 * machine. The only injected seams are the two agent boundaries — Claude and
 * Codex are subscription CLIs, and `AgentRunner` exists so that no test starts
 * one — plus the verification runner, which a fixture repository has no npm
 * project to satisfy. `tests/v1-08-verification-boundary.test.ts` covers the
 * production verification seam with real processes.
 *
 * Two limits of the product bound what can be asserted, and they are limits
 * rather than omissions:
 *
 *  - **There is no setup chain.** `CREATED → … → IMPLEMENTING` is declared in
 *    the transition table and driven by nothing, and `runTask` refuses to create
 *    a first state (`TASK_NOT_STARTED`). So a scenario seeds its state at
 *    `VERIFYING` — from the real workspace receipt — and the composition from a
 *    resolved repository to that first state is the test's, not the product's.
 *  - **`READY_FOR_PR` is terminal.** No push, no pull request, no CI, no merge
 *    is part of this product. The furthest an assertion may go is that the state
 *    is reached and that running again does nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { absolutePathsEqual } from '../src/core/path-identity.js';
import { runTask, runNextTask } from '../src/run/run-driver.js';
import { saveTaskState } from '../src/state/state-store.js';
import type { ReplaceFn } from '../src/state/atomic-file.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { deriveTaskWorkspaceIdentity } from '../src/worktree/workspace-identity.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { removeRepoFixtures, git, writeRepoFile } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';
import {
  e2eProfile,
  expectNothingRan,
  findingsReview,
  headOf,
  recordedAgent,
  recordedVerify,
  reload,
  removeTree,
  reviewResult,
  seedDeliveredState,
  seedState,
  startTask,
  taskFile,
  tickingClock,
  tryReload,
  usageLimitResult,
  writerSuccess,
  writerThatEdits,
  type StartedTask,
} from './helpers/e2e-fixtures.js';
import { fingerprint, passingReview } from './fixtures.js';

afterAll(() => {
  // Before the fixtures go: a lease lives inside its repository's own Git
  // directory, so removing the fixture would take the file and leave this
  // process still holding an artefact for a path a later fixture could reuse.
  releaseTestLeases();
  removeTrackedWorkspaces();
  removeRepoFixtures();
});

const TASK_ID = 'V1-08-A';

/** The request shape every scenario starts from: attended, auth proven, bounded. */
function request(started: StartedTask, overrides: Record<string, unknown> = {}) {
  return {
    repository: started.repository,
    taskId: started.taskId,
    taskBrief: 'Make the integrated pipeline behave.',
    attendedContinuation: true,
    authEvidence: provenAuthEvidence(),
    // Real, and re-proved by the driver on every iteration.
    lease: leaseFor(started.repository),
    maxSteps: 8,
    ...overrides,
  };
}

/** Dependencies with **real** Git and real filesystem existence. */
function deps(overrides: Record<string, unknown> = {}) {
  return { now: tickingClock(), git: runGitCommand, ...overrides };
}

/* ════════════════════ 1. The happy path, end to end ════════════════════════ */

describe('a task the repository is happy with reaches READY_FOR_PR', () => {
  it('verifies, reviews clean, and settles — observing HEAD through real Git', async () => {
    const started = await startTask({ taskId: TASK_ID });
    // Work already delivered: settling additionally requires that the task did
    // something (DOGFOOD-REM-001 R2), so the fixture commits before it verifies.
    seedDeliveredState(started);

    const verify = recordedVerify();
    const agent = recordedAgent({ codex: () => reviewResult(passingReview()) });

    const run = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    expect(run.outcome).toBe('TASK_COMPLETED');
    expect(run.steps).toBe(2);

    const final = reload(started.root, TASK_ID).state;
    expect(final.state).toBe('READY_FOR_PR');
    expect(final.reviewRound).toBe(1);
    expect(final.worktreeCleanAtCheckpoint).toBe(true);
    expect(final.resumeFrom).toBeNull();
    expect(final.reportedResetAt).toBeNull();
    expect(final.blockedAgent).toBeNull();

    // The completion checkpoint was *observed*, not carried: it is the commit
    // real Git reports for the real worktree, which is what separates a task
    // that is finished from one that believes it is.
    expect(final.currentCommit).toBe(headOf(started.workspace.worktreePath));
    expect(final.basePinnedCommit).toBe(started.workspace.basePinnedCommit);
  });

  it('runs every process in the worktree Git vouched for, never in the main checkout', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);

    const verify = recordedVerify();
    const agent = recordedAgent({ codex: () => reviewResult(passingReview()) });

    await runTask(request(started), deps({ verify: verify.runner, agent: agent.runner }));

    const authorised = started.workspace.worktreePath;
    expect(verify.calls.length).toBeGreaterThan(0);
    expect(agent.calls.length).toBeGreaterThan(0);

    // Compared as path identities rather than as strings, and that is the
    // finding rather than a convenience: the directory every process really ran
    // in is **the path Git printed** (`C:/…/wt`), not the one `node:path` built
    // when the workspace was created (`C:\…\wt`). The two denote one directory,
    // which is precisely why `loop-step.ts` compares them with
    // `absolutePathsEqual` and why reconciliation's re-derivation must too. A
    // string comparison anywhere on this path would refuse every real task on
    // Windows.
    for (const call of [...verify.calls, ...agent.calls]) {
      expect(absolutePathsEqual(call.cwd, authorised)).toBe(true);
      // The thing that must never happen, stated positively.
      expect(absolutePathsEqual(call.cwd, started.root)).toBe(false);
    }
  });

  /**
   * "No further step", not "no subprocess".
   *
   * Reconciliation runs *before* the terminal gate — deliberately, so the gate
   * is reached only for a state that loaded and belongs to this repository — so
   * a rerun does spawn real Git probes (`worktree list`, `rev-parse`, `status`,
   * `merge-base`). What it must not do is run another task phase or write
   * anything, and an earlier title claiming "no external work at all" was simply
   * false about the Git probes.
   */
  it('does not execute another task step for a terminal task', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedDeliveredState(started);
    const first = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: recordedAgent({ codex: () => reviewResult(passingReview()) }).runner }),
    );
    expect(first.outcome).toBe('TASK_COMPLETED');
    const settled = reload(started.root, TASK_ID);

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const again = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    expect(again.outcome).toBe('TASK_COMPLETED');
    expect(again.steps).toBe(0);
    // No *task* work: no agent, no verification command. Git observation did
    // run, ahead of the terminal gate — see this case's note.
    expectNothingRan(agent, verify);
    // Byte-identical: a terminal task is not re-checkpointed.
    expect(reload(started.root, TASK_ID).revision).toBe(settled.revision);
  });
});

/* ═══════════ 2. The full remediation cycle, with a writer that writes ══════ */

describe('a review that finds something drives a real remediation cycle', () => {
  it('persists findings, remediates, re-verifies and completes on the second round', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);

    const verify = recordedVerify();
    const agent = recordedAgent({
      // Round 1 finds something; round 2 is clean.
      codex: ({ index }) => reviewResult(index === 0 ? findingsReview() : passingReview()),
      claude: writerThatEdits('src/fix.ts', 'export const fixed = true;\n'),
    });

    const run = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    expect(run.outcome).toBe('TASK_COMPLETED');
    // VERIFYING→REVIEWING, REVIEWING→REMEDIATING, REMEDIATING→VERIFYING,
    // VERIFYING→REVIEWING, REVIEWING→READY_FOR_PR.
    expect(run.steps).toBe(5);
    expect(agent.countFor('codex')).toBe(2);
    expect(agent.countFor('claude')).toBe(1);
    expect(verify.calls.length).toBe(2);

    const final = reload(started.root, TASK_ID).state;
    expect(final.state).toBe('READY_FOR_PR');
    expect(final.reviewRound).toBe(2);

    // The round-1 finding survives into the terminal state: it is the evidence
    // that remediation was needed, and history is appended to, never rewritten.
    expect(final.findingHistory).toHaveLength(1);
    expect(final.findingHistory[0]?.round).toBe(1);
    expect(final.findingHistory[0]?.fingerprint).toMatch(/^[0-9a-f]{32}$/);

    // The writer really committed, and the completion checkpoint is that commit
    // rather than the base the task started from.
    const head = headOf(started.workspace.worktreePath);
    expect(final.currentCommit).toBe(head);
    expect(head).not.toBe(started.workspace.basePinnedCommit);
    expect(existsSync(join(started.workspace.worktreePath, 'src', 'fix.ts'))).toBe(true);
    // …and it committed in the worktree, not in the repository it branched from.
    expect(existsSync(join(started.root, 'src', 'fix.ts'))).toBe(false);
  });

  it('briefs the writer from the live review, naming the path the reviewer named', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);

    const agent = recordedAgent({
      codex: ({ index }) => reviewResult(index === 0 ? findingsReview('src/broken.ts', 'e2e.named') : passingReview()),
      claude: writerThatEdits('src/fix.ts', 'export const fixed = true;\n'),
    });

    await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: agent.runner }),
    );

    const brief = agent.calls.find((call) => call.agent === 'claude')?.payload ?? '';
    expect(brief).toContain('review round 1');
    expect(brief).toContain('src/broken.ts');
    expect(brief).toContain('e2e.named');
    // The live brief is the strong one; it must not announce itself as degraded.
    expect(brief).not.toContain('did not survive');
  });

  it('stops at a human when the review budget is spent, with its evidence intact', async () => {
    const started = await startTask({
      taskId: TASK_ID,
      profile: e2eProfile({ maxReviewRounds: 1 }),
    });
    seedState(started);

    const agent = recordedAgent({ codex: () => reviewResult(findingsReview()) });

    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: agent.runner }),
    );

    expect(run.outcome).toBe('HUMAN_DECISION_REQUIRED');
    // A remediation pass whose result could never be reviewed is not started.
    expect(agent.countFor('claude')).toBe(0);

    const final = reload(started.root, TASK_ID).state;
    expect(final.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(final.reviewRound).toBe(1);
    expect(final.findingHistory).toHaveLength(1);
  });
});

/* ═════════════════════ 3. Verification is a real gate ══════════════════════ */

describe('the repository verdict is the repository\'s', () => {
  it('parks a failing verification on BLOCKED_VERIFY and never retries it', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);

    const verify = recordedVerify(() => ({ exitCode: 1 }));
    const agent = recordedAgent({});

    const run = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    expect(run.outcome).toBe('BLOCKED_VERIFY');
    expect(verify.calls.length).toBe(1);
    expect(agent.calls).toEqual([]);

    const blocked = reload(started.root, TASK_ID);
    expect(blocked.state.state).toBe('BLOCKED_VERIFY');
    expect(blocked.state.resumeFrom).toEqual({ phase: 'REMEDIATE', round: 1 });

    // A second invocation is a stop, not a retry: the loop refuses to leave
    // `BLOCKED_VERIFY`, because handing a failure to the writer is a decision.
    const secondVerify = recordedVerify();
    const secondAgent = recordedAgent({});
    const again = await runTask(
      request(started),
      deps({ verify: secondVerify.runner, agent: secondAgent.runner }),
    );

    expect(again.outcome).toBe('BLOCKED_VERIFY');
    expect(again.steps).toBe(0);
    expectNothingRan(secondAgent, secondVerify);
    expect(reload(started.root, TASK_ID).revision).toBe(blocked.revision);
  });

  it('sends an unrunnable verification to a human rather than to BLOCKED_VERIFY', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);

    const run = await runTask(
      request(started),
      deps({
        verify: recordedVerify(() => ({ outcome: 'UNAVAILABLE' as const, exitCode: null })).runner,
        agent: recordedAgent({}).runner,
      }),
    );

    expect(run.outcome).toBe('HUMAN_DECISION_REQUIRED');
    expect(reload(started.root, TASK_ID).state.state).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('never reads a malformed review as an absence of findings', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);

    const agent = recordedAgent({
      codex: () => reviewResult({ reviewVersion: 1, verdict: 'PASS', findings: [{ severity: 'high', path: 'a.ts', rule: 'r' }] }),
    });

    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: agent.runner }),
    );

    expect(run.outcome).toBe('HUMAN_DECISION_REQUIRED');
    const final = reload(started.root, TASK_ID).state;
    expect(final.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(final.state).not.toBe('READY_FOR_PR');
    expect(final.findingHistory).toEqual([]);
  });
});

/* ══════════════════ 4. Crash and restart, over a real worktree ═════════════ */

describe('a process that dies mid-step loses nothing and fabricates nothing', () => {
  it('re-runs the step when the write never landed, without consuming a round', async () => {
    const started = await startTask({ taskId: TASK_ID });
    const before = seedDeliveredState(started);

    const crashing: ReplaceFn = () => {
      throw new Error('crash between the subprocess and the state file');
    };
    const firstVerify = recordedVerify();
    const crashed = await runTask(
      request(started),
      deps({ verify: firstVerify.runner, agent: recordedAgent({}).runner, replace: crashing }),
    );

    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
    expect(crashed.steps).toBe(0);
    expect(firstVerify.calls.length).toBe(1);
    // Byte-identical: the phase on disk is exactly the one the step started from.
    const after = reload(started.root, TASK_ID);
    expect(after.revision).toBe(before.revision);
    expect(after.state.state).toBe('VERIFYING');
    expect(after.state.reviewRound).toBe(0);

    // The restart is a fresh invocation, which is what a new process is.
    const verify = recordedVerify();
    const agent = recordedAgent({ codex: () => reviewResult(passingReview()) });
    const restarted = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    expect(restarted.outcome).toBe('TASK_COMPLETED');
    // Verification really did run a second time — the at-least-once cost of the
    // one-write-per-step design, stated rather than hidden.
    expect(verify.calls.length).toBe(1);
    expect(reload(started.root, TASK_ID).state.reviewRound).toBe(1);
  });

  it('does not replay a transition whose write did land', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedDeliveredState(started);

    // The write lands and *then* the process dies, which is the one crash point
    // where the caller's report and the disk disagree.
    const landThenDie: ReplaceFn = (from, to) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { renameSync } = require('node:fs') as typeof import('node:fs');
      renameSync(from, to);
      throw new Error('death after the rename');
    };

    const agent = recordedAgent({ codex: () => reviewResult(passingReview()) });
    const crashed = await runTask(
      request(started, { maxSteps: 1 }),
      deps({ verify: recordedVerify().runner, agent: agent.runner, replace: landThenDie }),
    );

    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
    // The disk disagrees with the report, and the disk is what a restart reads.
    expect(reload(started.root, TASK_ID).state.state).toBe('REVIEWING');

    // The restart therefore starts at REVIEWING and must not verify again.
    const verify = recordedVerify();
    const restartAgent = recordedAgent({ codex: () => reviewResult(passingReview()) });
    const restarted = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: restartAgent.runner }),
    );

    expect(restarted.outcome).toBe('TASK_COMPLETED');
    expect(verify.calls).toEqual([]);
    expect(reload(started.root, TASK_ID).state.reviewRound).toBe(1);
  });

  it('survives a writer that really mutated the worktree and then lost its write', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);

    // Drive as far as REMEDIATING, then crash the writer's completion write
    // after it has already committed in the real worktree.
    let crashArmed = false;
    const crashOnce: ReplaceFn = (from, to) => {
      if (crashArmed) {
        crashArmed = false;
        throw new Error('crash after the writer changed the repository');
      }
      const { renameSync } = require('node:fs') as typeof import('node:fs');
      renameSync(from, to);
    };

    const agent = recordedAgent({
      codex: ({ index }) => reviewResult(index === 0 ? findingsReview() : passingReview()),
      claude: (call) => {
        crashArmed = true;
        return writerThatEdits('src/fix.ts', 'export const fixed = true;\n')(call);
      },
    });

    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: agent.runner, replace: crashOnce }),
    );

    expect(run.outcome).toBe('STATE_NOT_RECORDED');
    const stalled = reload(started.root, TASK_ID).state;
    expect(stalled.state).toBe('REMEDIATING');
    // The withdrawal is what makes the next reconciliation survive: the record
    // claims neither a known HEAD nor a clean tree, so the writer's own commit
    // and its own edits are not read as the world contradicting the record.
    expect(stalled.currentCommit).toBeNull();
    expect(stalled.worktreeCleanAtCheckpoint).toBe(false);
    expect(headOf(started.workspace.worktreePath)).not.toBe(started.workspace.basePinnedCommit);

    // The restart reconciles rather than diverging, and finishes the task.
    //
    // Its writer edits rather than reporting a bare success: since
    // DOGFOOD-REM-001 a pass that leaves nothing behind is inadmissible and
    // parks, so a no-effect restart would stop this case one state short for a
    // reason it is not about. The subject here is reconciliation surviving the
    // writer's own authorised mutation.
    const restartAgent = recordedAgent({
      codex: () => reviewResult(passingReview()),
      claude: writerThatEdits('src/fix-again.ts', 'export const again = true;\n'),
    });
    const restarted = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: restartAgent.runner }),
    );

    expect(restarted.reconciliation?.outcome).toBe('RECONCILED');
    expect(restarted.outcome).toBe('TASK_COMPLETED');
  });

  /**
   * A write that was refused entered no phase, so there is no brief for it.
   *
   * `LoopStepResult.remediationPayload` is documented as present *only* on the
   * write that enters `REMEDIATING`. The driver happens to be safe — it carries
   * a payload only out of `ADVANCED` — but the contract held by the caller's
   * good manners rather than by the value itself, and a second caller would
   * have had no way to know (V1-08).
   */
  it('offers no remediation brief for a write that was refused', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started, {
      state: 'REVIEWING',
      currentCommit: started.workspace.basePinnedCommit,
    });

    const crashing: ReplaceFn = () => {
      throw new Error('crash on the write that would have entered REMEDIATING');
    };
    const run = await runTask(
      request(started, { maxSteps: 1 }),
      deps({
        verify: recordedVerify().runner,
        agent: recordedAgent({ codex: () => reviewResult(findingsReview()) }).runner,
        replace: crashing,
      }),
    );

    expect(run.outcome).toBe('STATE_NOT_RECORDED');
    expect(run.lastStep?.outcome).toBe('STATE_NOT_RECORDED');
    expect(run.lastStep?.state).toBeNull();
    expect(run.lastStep?.remediationPayload).toBeNull();
    // The durable state never entered REMEDIATING, so no round was consumed.
    const after = reload(started.root, TASK_ID).state;
    expect(after.state).toBe('REVIEWING');
    expect(after.reviewRound).toBe(0);
    expect(after.findingHistory).toEqual([]);
  });

  it('rebuilds a degraded brief after a restart, and says that it is degraded', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started, {
      state: 'REVIEWING',
      currentCommit: started.workspace.basePinnedCommit,
    });

    // Round 1 finds something, and the run stops there.
    const first = await runTask(
      request(started, { maxSteps: 1 }),
      deps({
        verify: recordedVerify().runner,
        agent: recordedAgent({ codex: () => reviewResult(findingsReview('src/named.ts', 'e2e.named')) }).runner,
      }),
    );
    expect(first.outcome).toBe('STEP_BUDGET_EXHAUSTED');
    expect(reload(started.root, TASK_ID).state.state).toBe('REMEDIATING');

    // A new process: the in-memory payload is gone, and only the durable record
    // remains. `path` and `rule` were agent text and were never persisted.
    const agent = recordedAgent({
      codex: () => reviewResult(passingReview()),
      claude: () => writerSuccess(),
    });
    await runTask(request(started), deps({ verify: recordedVerify().runner, agent: agent.runner }));

    const brief = agent.calls.find((call) => call.agent === 'claude')?.payload ?? '';
    expect(brief).toContain('did not survive');
    expect(brief).toContain('review round 1');
    expect(brief).not.toContain('src/named.ts');
    expect(brief).not.toContain('e2e.named');
  });

  it('refuses a stale write rather than flattening the writer that got there first', async () => {
    const started = await startTask({ taskId: TASK_ID });
    // Seeded at `REVIEWING` so that the first step is the one whose subprocess
    // the competitor writes underneath. Seeded at `VERIFYING` the first step
    // would be the verification, and the reviewer — where the competing write is
    // staged — would never run at all.
    const held = seedState(started, {
      state: 'REVIEWING',
      currentCommit: started.workspace.basePinnedCommit,
    });

    // A competitor lands a durable state while the reviewer is running.
    const agent = recordedAgent({
      codex: () => {
        const competitor = saveTaskState(
          { ...held.state, state: 'HUMAN_DECISION_REQUIRED', resumeFrom: { phase: 'REVIEW', round: 1 }, stateEnteredAt: '2026-08-10T11:00:00.000Z' },
          { repositoryRoot: started.root, expectedRevision: held.revision },
        );
        expect(competitor.ok).toBe(true);
        return reviewResult(passingReview());
      },
    });

    const run = await runTask(
      request(started, { maxSteps: 1 }),
      deps({ verify: recordedVerify().runner, agent: agent.runner }),
    );

    expect(run.outcome).toBe('STATE_CONFLICT');
    expect(run.steps).toBe(0);

    // The *reason* matters, not just the refusal. `STATE_CONFLICT` is also what
    // a save with no `expectedRevision` at all produces (`EXPECTED_ABSENT`), so
    // asserting the outcome alone would pass just as well if the driver had
    // stopped threading the revision — which is the one thing this case is
    // about. `REVISION_MISMATCH` says the compare-and-swap really compared.
    const save = run.lastStep?.save;
    expect(save?.ok).toBe(false);
    if (save !== null && save !== undefined && !save.ok) {
      expect(save.code).toBe('STATE_CONFLICT');
      expect(save.detail).toBe('REVISION_MISMATCH');
    }

    // The competitor's state stands. Nothing was re-read and retried.
    expect(reload(started.root, TASK_ID).state.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(agent.countFor('codex')).toBe(1);
  });
});

/* ═════════════ 5. Divergence, produced by really changing the world ════════ */

describe('the world contradicting the record stops the run, having run nothing', () => {
  it('refuses when the worktree directory is really gone', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);
    removeTree(started.workspace.worktreePath);

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const run = await runTask(request(started), deps({ verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('STATE_DIVERGED');
    expect(run.steps).toBe(0);
    expectNothingRan(agent, verify);
    expect(run.reconciliation?.report?.findings).toContain('WORKTREE_MISSING_ON_DISK');
  });

  it('refuses when somebody else\'s branch is really checked out there', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);
    git(started.workspace.worktreePath, ['switch', '--quiet', '--detach', 'HEAD']);

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const run = await runTask(request(started), deps({ verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('STATE_DIVERGED');
    expectNothingRan(agent, verify);
    expect(run.reconciliation?.report?.findings).toContain('WORK_BRANCH_NOT_CHECKED_OUT');
  });

  it('refuses when Git no longer registers the worktree at all', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);
    git(started.root, ['worktree', 'remove', '--force', started.workspace.worktreePath]);

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const run = await runTask(request(started), deps({ verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('STATE_DIVERGED');
    expectNothingRan(agent, verify);
    expect(run.reconciliation?.report?.findings).toContain('WORKTREE_NOT_REGISTERED');
  });
});

/* ══════════════ 6. Two repositories, and the same task id in both ══════════ */

describe('one repository cannot reach into another', () => {
  it('keeps the same task id in two repositories completely apart', async () => {
    const alpha = await startTask({ taskId: TASK_ID });
    const beta = await startTask({ taskId: TASK_ID });

    expect(alpha.root).not.toBe(beta.root);
    expect(alpha.repository.id).toBe(beta.repository.id); // same profile id on purpose
    seedDeliveredState(alpha);
    seedDeliveredState(beta);

    // Drive alpha to completion; beta must be untouched.
    const betaBefore = reload(beta.root, TASK_ID);
    const run = await runTask(
      request(alpha),
      deps({ verify: recordedVerify().runner, agent: recordedAgent({ codex: () => reviewResult(passingReview()) }).runner }),
    );

    expect(run.outcome).toBe('TASK_COMPLETED');
    expect(reload(alpha.root, TASK_ID).state.state).toBe('READY_FOR_PR');
    const betaAfter = reload(beta.root, TASK_ID);
    expect(betaAfter.revision).toBe(betaBefore.revision);
    expect(betaAfter.state.state).toBe('VERIFYING');
    // Repository-scoped by root, with no id segment: identical ids, distinct files.
    expect(betaAfter.path).not.toBe(reload(alpha.root, TASK_ID).path);
  });

  it('refuses a state file copied from another repository, and repairs nothing', async () => {
    const alpha = await startTask({ taskId: TASK_ID });
    const beta = await startTask({ taskId: TASK_ID });
    seedState(alpha);
    const alphaBytes = readFileSync(reload(alpha.root, TASK_ID).path);

    // Alpha's intact, well-formed record, dropped into beta's runtime directory.
    const betaState = seedState(beta);
    writeRepoFile(
      beta.root,
      `.agent-orchestrator/runtime/${TASK_ID}.json`,
      alphaBytes.toString('utf8'),
    );

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const run = await runTask(request(beta), deps({ verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('STATE_UNUSABLE');
    expect(run.reconciliation?.outcome).toBe('STATE_REPOSITORY_MISMATCH');
    expect(run.steps).toBe(0);
    expectNothingRan(agent, verify);
    // Nothing repaired: the bytes are exactly the ones that were planted.
    expect(readFileSync(betaState.path).equals(alphaBytes)).toBe(true);
  });

  it('cannot let one repository\'s worktree authorise another\'s task', async () => {
    const alpha = await startTask({ taskId: TASK_ID });
    const beta = await startTask({ taskId: TASK_ID });
    // Beta's state, pointing at alpha's real, really-registered worktree.
    seedState(beta, { worktreePath: alpha.workspace.worktreePath });

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const run = await runTask(request(beta), deps({ verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('STATE_DIVERGED');
    expectNothingRan(agent, verify);
    // Beta's registry is read from beta's root, so alpha's path is simply not in it.
    expect(run.reconciliation?.report?.findings).toContain('WORKTREE_PATH_NOT_DERIVED');
  });
});

/* ═══════ 7. The residual worktree-identity gap this slice exists to close ═══ */

/**
 * V1-07-R-1, driven end to end.
 *
 * Before V1-08 the authority chain compared the persisted `worktreePath` with
 * Git's registry and the persisted `workBranch` with the ref Git printed there —
 * both sides of both comparisons coming from the same file. `git worktree list`
 * registers the **main working tree** and it **does** hold the default branch,
 * so a state naming the repository root and `main` satisfied every check, and
 * the verifier, the reviewer and the Claude writer were handed the canonical
 * checkout as their working directory.
 *
 * Two claims that agree with each other are not authority; they are one claim
 * written twice. Reconciliation now re-derives both.
 */
describe('a tampered state cannot make the main checkout a task workspace', () => {
  /**
   * The unmasked exploit, and the only case here that is a true regression test.
   *
   * The obvious tampered scenario — a `VERIFYING` state claiming the root — was
   * refused before this fix existed too, but for an unrelated reason: the
   * persisted state file is itself an untracked file in the main checkout, so
   * `worktreeCleanAtCheckpoint: true` met a dirty tree and reconciliation
   * answered `WORKTREE_DIRTY`. A test built that way documents the fix without
   * being able to fail without it.
   *
   * This scenario removes both accidental defences, which is what a real
   * deployment looks like:
   *
   *  - `.agent-orchestrator/runtime/` is git-ignored, exactly as the
   *    state-persistence contract says a repository is expected to ignore it, so
   *    the main checkout is genuinely clean;
   *  - the phase is `REMEDIATING` with `worktreeCleanAtCheckpoint: false` and
   *    `currentCommit: null` — the honest record of an interrupted writer. In
   *    that phase a dirty tree contradicts nothing and no HEAD is expected, so
   *    neither `WORKTREE_DIRTY` nor `CURRENT_COMMIT_MOVED` can fire.
   *
   * Every other check then passes on the tampered record, and without the
   * derived-identity comparison reconciliation answers `CONSISTENT` — Git's
   * registry vouches for the main working tree, which really does hold `main`.
   * The Claude **writer** is then handed the canonical checkout as its `cwd`.
   *
   * The durable finding for round 1 is required, or the remediate step would
   * refuse for lack of a cause (`NO_DURABLE_FINDINGS`) and mask the exploit a
   * third way.
   */
  it('refuses the tampered state that would otherwise reconcile clean', async () => {
    const started = await startTask({
      taskId: TASK_ID,
      // A repository that ignores the orchestrator's runtime directory, so the
      // main checkout stays clean and cannot refuse this state by accident.
      files: { '.gitignore': '.agent-orchestrator/runtime/\n' },
    });

    seedState(started, {
      worktreePath: started.root,
      workBranch: 'main',
      state: 'REMEDIATING',
      reviewRound: 1,
      currentCommit: null,
      worktreeCleanAtCheckpoint: false,
      findingHistory: [{ round: 1, severity: 'high', fingerprint: fingerprint(7) }],
    });

    // The main checkout really is clean: the accidental defence is gone.
    expect(git(started.root, ['status', '--porcelain']).trim()).toBe('');

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const run = await runTask(request(started), deps({ verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('STATE_DIVERGED');
    expect(run.steps).toBe(0);

    // The identity findings are the *only* reason this was refused. Asserted as
    // an exact set rather than with `toContain`, because a scenario that also
    // diverged for some other reason would prove nothing about the identity
    // invariant — which is precisely how the weaker version of this test passed
    // against code that did not have the fix.
    expect(run.reconciliation?.report?.findings).toEqual([
      'WORK_BRANCH_NOT_DERIVED',
      'WORKTREE_PATH_NOT_DERIVED',
    ]);

    // The point of the whole exercise: nothing was started anywhere, least of
    // all a writing agent in the canonical checkout.
    expectNothingRan(agent, verify);
  });

  it('refuses a state claiming the repository root and the default branch', async () => {
    const started = await startTask({ taskId: TASK_ID });
    // Self-consistent, contract-valid, and a lie: both claims agree with each
    // other and with Git's registry, which is exactly why they used to pass.
    seedState(started, { worktreePath: started.root, workBranch: 'main' });

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const run = await runTask(request(started), deps({ verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('STATE_DIVERGED');
    expect(run.steps).toBe(0);
    const findings = run.reconciliation?.report?.findings ?? [];
    expect(findings).toContain('WORKTREE_PATH_NOT_DERIVED');
    expect(findings).toContain('WORK_BRANCH_NOT_DERIVED');

    // The point of the whole exercise: nothing was started anywhere, least of
    // all a writing agent in the canonical checkout.
    expectNothingRan(agent, verify);
  });

  it('refuses a work branch that is not this task\'s, even at the right path', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started, { workBranch: 'ao/task/some-other-task' });

    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: recordedAgent({}).runner }),
    );

    expect(run.outcome).toBe('STATE_DIVERGED');
    expect(run.reconciliation?.report?.findings).toContain('WORK_BRANCH_NOT_DERIVED');
  });

  it('accepts exactly the identity the production derivation produces', async () => {
    const started = await startTask({ taskId: TASK_ID });
    const derived = deriveTaskWorkspaceIdentity(started.repository, TASK_ID);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    // The claim this slice rests on: what `prepareTaskWorkspace` really created
    // is what `deriveTaskWorkspaceIdentity` really derives, spelled the same way
    // once compared as paths. If these ever disagree, the check above would
    // refuse every legitimate task.
    expect(started.workspace.workBranch).toBe(derived.identity.workBranch);
    seedDeliveredState(started);
    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: recordedAgent({ codex: () => reviewResult(passingReview()) }).runner }),
    );
    expect(run.outcome).toBe('TASK_COMPLETED');
  });
});

/* ═════════════════ 8. The usage-limit path, as it really behaves ═══════════ */

/**
 * What a quota refusal really does, driven through the production recogniser.
 *
 * The important assertion here is a *denial*. `evaluateAutomaticResume` demands
 * a reported reset time, an exact recorded `currentCommit` and
 * `worktreeCleanAtCheckpoint === true`; entering `REMEDIATING` withdraws the
 * last two by contract, and no CLI this build has observed reports a reset time
 * at all. So an unattended resume of a block this loop recorded is not merely
 * unlikely — it is unreachable, and V1-08 pins that rather than leaving it
 * implied by fixtures which hand-build states production never writes.
 */
describe('a quota refusal is a governed pause, and this build never lifts it alone', () => {
  it('parks the task with the evidence the recogniser really produced', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);

    const agent = recordedAgent({
      codex: () => reviewResult(findingsReview()),
      claude: () => usageLimitResult(),
    });

    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: agent.runner }),
    );

    expect(run.outcome).toBe('BLOCKED_USAGE_LIMIT');
    const blocked = reload(started.root, TASK_ID).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.blockedAgent).toBe('claude');
    expect(blocked.resumeFrom).toEqual({ phase: 'REMEDIATE', round: 1 });
    // Never invented: no CLI observed by this build reports one.
    expect(blocked.reportedResetAt).toBeNull();
    // Withdrawn on the way into the writing phase, and still withdrawn here.
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('refuses to resume that block unattended, naming every check that denied it', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);
    await runTask(
      request(started),
      deps({
        verify: recordedVerify().runner,
        agent: recordedAgent({ codex: () => reviewResult(findingsReview()), claude: () => usageLimitResult() }).runner,
      }),
    );
    const blocked = reload(started.root, TASK_ID);

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const again = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    expect(again.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(again.steps).toBe(0);
    expectNothingRan(agent, verify);
    // The three independent locks, each sufficient on its own.
    expect(again.reasonCodes).toContain('RESET_TIME_MISSING');
    expect(again.reasonCodes).toContain('CURRENT_COMMIT_MISMATCH');
    expect(again.reasonCodes).toContain('WORKTREE_NOT_CLEAN');
    // The pause is intact for a human, byte for byte.
    expect(reload(started.root, TASK_ID).revision).toBe(blocked.revision);
  });

  /**
   * The blocking gate, not the attended gate — and the distinction is the point.
   *
   * An earlier version of this case was titled as though it proved the
   * V1-07-RR-B1 ordering ("an unattended run must not spend the pause before
   * refusing to execute"). It could not, for a reason specific to *this*
   * fixture: the block is recorded with `reportedResetAt: null`, because no CLI
   * this build has observed reports a reset time. `evaluateAutomaticResume`
   * therefore denies `RESET_TIME_MISSING`, `classifyResume` cannot answer
   * `AUTOMATIC_ALLOWED`, and the blocking gate returns `BLOCKED_USAGE_LIMIT`
   * before the attended-continuation gate is ever reached. Deleting the attended
   * gate outright left that test green.
   *
   * Note what that does *not* say. A blocked task is not categorically refused
   * ahead of the attended gate: the blocking gate lets `AUTOMATIC_ALLOWED`
   * through, so a block whose evidence the authority module grants does reach
   * the attended gate and is refused there with
   * `CONTINUATION_NOT_AUTHORISED` / `ATTENDED_CONTINUATION_NOT_GRANTED`. That is
   * exactly the RR-B1 case, and it is owned by
   * `tests/run-driver.test.ts` — "writes nothing when the quota resume is
   * allowed but the run is unattended", which hand-builds a block carrying an
   * elapsed reset time, asserts `resume.continuation === 'AUTOMATIC_ALLOWED'`,
   * and then asserts the attended refusal left every field of the pause intact.
   * Reproducing that here would restate a lower-level test in a slower one.
   *
   * So the ownership split is: this case owns the earlier **blocking-gate**
   * behaviour for a block this build can actually produce, and the run-driver
   * regression owns the **attendedContinuation** behaviour. What this case
   * genuinely proves is narrower and still worth having: for a block denied by
   * the authority module, the operator's grant changes nothing.
   */
  it('leaves a blocked task blocked whether or not this invocation is attended', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedState(started);
    await runTask(
      request(started),
      deps({
        verify: recordedVerify().runner,
        agent: recordedAgent({ codex: () => reviewResult(findingsReview()), claude: () => usageLimitResult() }).runner,
      }),
    );
    const blocked = reload(started.root, TASK_ID);

    const again = await runTask(
      request(started, { attendedContinuation: false }),
      deps({ verify: recordedVerify().runner, agent: recordedAgent({}).runner }),
    );

    // The blocking gate is what fired, and saying so is what makes the title
    // true: `CONTINUATION_NOT_AUTHORISED` would mean the attended gate had been
    // reached, which for *this* block — denied `AUTOMATIC_ALLOWED` because it
    // carries no reset time — cannot happen.
    expect(again.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(again.reasonCodes).not.toContain('ATTENDED_CONTINUATION_NOT_GRANTED');
    expect(again.steps).toBe(0);
    expect(reload(started.root, TASK_ID).revision).toBe(blocked.revision);
    expect(reload(started.root, TASK_ID).state.resumeFrom).toEqual({ phase: 'REMEDIATE', round: 1 });
  });
});

/* ═══════════════════════ 9. Selection, driven for real ═════════════════════ */

describe('selection reads the repository\'s own task files', () => {
  it('drives the selected task and re-selects it afterwards, inventing no completion', async () => {
    const started = await startTask({
      taskId: TASK_ID,
      files: { 'tasks/V1-08-B.md': taskFile('V1-08-B', { dependsOn: [TASK_ID] }) },
    });
    seedDeliveredState(started);

    const first = await runNextTask(
      {
        repository: started.repository,
        taskBrief: (task) => `brief for ${task.id}`,
        attendedContinuation: true,
        authEvidence: provenAuthEvidence(),
        lease: leaseFor(started.repository),
        maxSteps: 8,
      },
      deps({ verify: recordedVerify().runner, agent: recordedAgent({ codex: () => reviewResult(passingReview()) }).runner }),
    );

    expect(first.selection.code).toBe('TASK_SELECTED');
    expect(first.selection.task?.id).toBe(TASK_ID);
    expect(first.run?.outcome).toBe('TASK_COMPLETED');

    // `READY_FOR_PR` is terminal, and it is *not* `DONE`. Only the repository
    // can say a task is finished for queue purposes, and nothing here writes a
    // task file — so the same task is selected again, and stops immediately.
    const second = await runNextTask(
      {
        repository: started.repository,
        taskBrief: (task) => `brief for ${task.id}`,
        attendedContinuation: true,
        authEvidence: provenAuthEvidence(),
        lease: leaseFor(started.repository),
        maxSteps: 8,
      },
      deps({ verify: recordedVerify().runner, agent: recordedAgent({}).runner }),
    );

    expect(second.selection.task?.id).toBe(TASK_ID);
    expect(second.run?.outcome).toBe('TASK_COMPLETED');
    expect(second.run?.steps).toBe(0);
  });
});

/* ════════════════════ 10. A fresh task is never invented ═══════════════════ */

describe('the driver creates nothing it did not find', () => {
  it('reports a task with no persisted state and writes nothing', async () => {
    const started = await startTask({ taskId: TASK_ID });

    const verify = recordedVerify();
    const agent = recordedAgent({});
    const run = await runTask(request(started), deps({ verify: verify.runner, agent: agent.runner }));

    expect(run.outcome).toBe('TASK_NOT_STARTED');
    expect(run.steps).toBe(0);
    expectNothingRan(agent, verify);
    expect(tryReload(started.root, TASK_ID)).toBeNull();
  });
});
