/**
 * V3 slice 8 — the unattended automatic-resume authority, and its bounded wait.
 *
 * ── What this file is attacking ────────────────────────────────────────────
 *
 * The slice introduces the first authority in this product under which
 * something runs with nobody present. Every case here is written against one of
 * the four ways such an authority is normally widened by accident:
 *
 *  A. **Reading a state name instead of a decision.** "It is
 *     `BLOCKED_USAGE_LIMIT`, so it may resume" is the shortcut that turns a
 *     narrow permission into a general one. The gate must consult
 *     `ResumeDecision.continuation`, and only that.
 *  B. **Continuing something that is not a resume.** A reconciled `VERIFYING`
 *     task looks perfectly healthy and is exactly what must *not* run
 *     unattended; a task with no durable state must not be created.
 *  C. **Carrying evidence across the sleep.** A lease, a login, a resolved
 *     repository, a resume verdict and a clean worktree were all true before
 *     the wait. None of them is authority after it, and every one of them is
 *     attacked here by changing the world *inside the injected sleep*.
 *  D. **Sleeping when sleeping cannot help.** A reset time that is missing, a
 *     denial that is not about time, a bound too small, a lease that was not
 *     provably returned — each has to stop the wait rather than delay a refusal.
 *
 * ── The instruments ───────────────────────────────────────────────────────
 *
 * Real repositories, real worktrees, real Git and the **real execution lease**.
 * The agent and verification seams are recorded stand-ins because the real ones
 * spend subscription quota; the clock and the sleep are injected so that a wait
 * measured in minutes takes none.
 *
 * The sleep seam is where the world changes. `advancingClock().advance(ms)` is
 * called by it, so time really does pass across the sleep from the product's
 * point of view, and a case that wants to break something does it in the same
 * callback — which is the only moment when the waiter genuinely holds nothing.
 *
 * ── What is deliberately *not* claimed here ───────────────────────────────
 *
 * That a second **operating-system process** takes the lease during the sleep.
 * The acquisition inside the sleep seam is a real `acquireRepositoryExecutionLease`
 * against the real file, so it proves the waiter is not holding the lease — an
 * exclusive create refuses an existing file whoever asks — but it happens in
 * this process. The cross-process property that needs no login is measured
 * against the shipped artefact in
 * `tests/dist-artifact/unattended-auto-resume-dist-artifact.mjs`; the full
 * wake-and-resume cycle cannot be measured in a real process without invoking
 * the real subscription CLIs, and is stated as a limit rather than faked.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  INVOCATION_GRANTS,
  mayStartTask,
  permitsContinuation,
  type GrantRefusalCode,
  type InvocationGrant,
} from '../src/run/invocation-grant.js';
import {
  CONTINUATION_AUTHORITIES,
  type ContinuationAuthority,
} from '../src/state/resume-decision.js';
import {
  driveLifecycle,
  type LifecycleDependencies,
  type LifecycleResult,
} from '../src/run/lifecycle-driver.js';
import { runTask, type RunOutcome } from '../src/run/run-driver.js';
import {
  driveUnattendedAutomaticResume,
  isUsableWaitBound,
  MAX_WAIT_MS_CEILING,
  RESET_WAIT_DISPOSITIONS,
  type ResetWaitDisposition,
  type UnattendedResumeDependencies,
  type UnattendedResumeRequest,
} from '../src/run/unattended-resume.js';
import {
  RESET_WAIT_SENTENCES,
  UNATTENDED_AUTO_RESUME_TRAILER,
  renderUnattendedResume,
} from '../src/cli/render-lifecycle.js';
import { ATTENDED_TRAILER } from '../src/cli/render-attended-run.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  exitCodeForUnattendedResume,
} from '../src/cli/run-exit-codes.js';
import {
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  releaseRepositoryExecutionLease,
  type LeaseRepository,
} from '../src/lease/execution-lease.js';
import { resolveRepository, type ResolvedRepository } from '../src/repo/resolve-repository.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { deriveTaskStateLocation } from '../src/state/state-location.js';
import type { AuthPreflightEvidence } from '../src/core/auth-preflight-evidence.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import {
  FIXTURE_PROFILE_RELATIVE_PATH,
  createRepoFixture,
  git,
  removeRepoFixtures,
  writeRepoFile,
} from './helpers/repo-fixtures.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';
import {
  e2eProfile,
  reviewResult,
  recordedAgent,
  recordedVerify,
  seedDeliveredState,
  startTask,
  usageLimitResult,
  writerThatEdits,
  type RecordedAgent,
  type RecordedVerify,
  type StartedTask,
} from './helpers/e2e-fixtures.js';
import { passingReview } from './fixtures.js';
import { runGitCommand } from '../src/worktree/git-command.js';

const TASK_ID = 'V3-08';

/** The instant every scenario's clock starts at. */
const T0 = Date.parse('2026-08-21T09:00:00.000Z');
/** How far ahead of `T0` a "not yet cleared" quota reset sits. */
const RESET_AHEAD_MS = 60_000;

/** What a real repository puts in `.gitignore` so AO's runtime cannot dirty it. */
const NEWLINE = String.fromCharCode(10);

/** The minimal task file the selector and the starter both accept. */
const TASK_FILE = [
  '---',
  `id: ${TASK_ID}`,
  `title: task ${TASK_ID}`,
  'status: OPEN',
  'kind: NORMAL',
  'priority: NORMAL',
  'currentFocus: false',
  'dependsOn: []',
  '---',
  '',
  '# Body',
  '',
].join(NEWLINE);
const IGNORE_RUNTIME = '.agent-orchestrator/runtime/' + NEWLINE;

afterEach(() => {
  releaseTestLeases();
});

afterAll(() => {
  removeTrackedWorkspaces();
  removeRepoFixtures();
});

/* ─────────────────────────────── instruments ────────────────────────────── */

interface AdvancingClock {
  /** The `now` seam. Never repeats, so two writes never share a timestamp. */
  readonly now: () => string;
  /** Move the clock forward, as a real sleep would. */
  readonly advance: (ms: number) => void;
}

function advancingClock(startMs: number = T0): AdvancingClock {
  let base = startMs;
  let tick = 0;
  return {
    now: () => new Date(base + tick++ * 1000).toISOString(),
    advance: (ms: number) => {
      base += ms;
    },
  };
}

interface RecordedSleep {
  readonly seam: (ms: number) => Promise<void>;
  readonly calls: number[];
}

/**
 * A sleep that records what it was asked for and lets a case change the world.
 *
 * `during` runs at the one moment the waiter holds nothing at all: after the
 * first epoch released the lease and before the second acquires one.
 */
function recordedSleep(
  clock: AdvancingClock,
  during?: (ms: number) => void | Promise<void>,
): RecordedSleep {
  const calls: number[] = [];
  return {
    calls,
    seam: async (ms: number) => {
      calls.push(ms);
      clock.advance(ms);
      await during?.(ms);
    },
  };
}

interface CountingPreflight {
  /** The factory the controller calls once per lifecycle epoch. */
  readonly factory: () => () => Promise<AuthPreflightEvidence | null>;
  /** How many epochs asked for a preflight closure. */
  readonly epochs: () => number;
  /** How many times the real check was actually performed. */
  readonly checks: () => number;
}

/**
 * A preflight factory that counts, and can be told to fail from the Nth epoch.
 *
 * The memoisation inside each closure is `onceOnlyPreflight`'s, reproduced
 * rather than imported so that this file measures the *shape* the controller
 * depends on: one check per epoch, remembered within it.
 */
function countingPreflight(failFromEpoch = Number.POSITIVE_INFINITY): CountingPreflight {
  let epochs = 0;
  let checks = 0;
  return {
    epochs: () => epochs,
    checks: () => checks,
    factory: () => {
      epochs += 1;
      const epoch = epochs;
      let done = false;
      let evidence: AuthPreflightEvidence | null = null;
      return async () => {
        if (done) return evidence;
        done = true;
        checks += 1;
        evidence = epoch >= failFromEpoch ? null : provenAuthEvidence();
        return evidence;
      };
    },
  };
}

/** The lease path of a repository, or a loud failure. */
function leasePathOf(repository: LeaseRepository): string {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return location.path;
}

/** The durable state file of a task, or a loud failure. */
function statePathOf(repositoryRoot: string, taskId: string): string {
  const location = deriveTaskStateLocation(repositoryRoot, taskId);
  if (!location.ok) throw new Error(`no state location: ${location.code}`);
  return location.path;
}

/* ─────────────────────────────── scenarios ──────────────────────────────── */

interface Scenario {
  readonly started: StartedTask;
  readonly agent: RecordedAgent;
  readonly verify: RecordedVerify;
  readonly clock: AdvancingClock;
  readonly preflight: CountingPreflight;
  readonly resolutions: () => number;
  readonly request: (
    overrides?: Partial<UnattendedResumeRequest>,
  ) => UnattendedResumeRequest;
  readonly deps: (sleep?: RecordedSleep) => UnattendedResumeDependencies;
  readonly lifecycleDeps: () => LifecycleDependencies;
}

/**
 * A task durably parked on `BLOCKED_USAGE_LIMIT`, with the lease given back.
 *
 * The release is load-bearing exactly as it is in the slice-6 suite:
 * `startTask` takes a real lease to prepare the worktree, and leaving it held
 * would make every case here `LIVE_OWNER_PRESENT` — a suite measuring its own
 * fixture.
 */
async function scenario(
  options: {
    readonly stateOverrides?: Parameters<typeof seedDeliveredState>[1];
    readonly resetAheadMs?: number | null;
    readonly failPreflightFromEpoch?: number;
    readonly agent?: Parameters<typeof recordedAgent>[0];
  } = {},
): Promise<Scenario> {
  const started = await startTask({ taskId: TASK_ID });
  const resetAhead = options.resetAheadMs === undefined ? RESET_AHEAD_MS : options.resetAheadMs;
  seedDeliveredState(started, {
    state: 'BLOCKED_USAGE_LIMIT',
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    reportedResetAt: resetAhead === null ? null : new Date(T0 + resetAhead).toISOString(),
    ...options.stateOverrides,
  });
  releaseTestLeases();

  const agent = recordedAgent(
    options.agent ?? {
      claude: writerThatEdits('src/resumed.ts', 'export const resumed = true;' + NEWLINE),
      codex: () => reviewResult(passingReview()),
    },
  );
  const verify = recordedVerify();
  const clock = advancingClock();
  const preflight = countingPreflight(options.failPreflightFromEpoch);
  let resolutions = 0;

  return {
    started,
    agent,
    verify,
    clock,
    preflight,
    resolutions: () => resolutions,
    request: (overrides = {}) => ({
      repository: started.repository,
      taskId: TASK_ID,
      maxSteps: 8,
      maxInvocations: 2,
      wait: { wait: true, maxWaitMs: 300_000 },
      ...overrides,
    }),
    deps: (sleep) => ({
      now: clock.now,
      git: runGitCommand,
      authPreflight: preflight.factory,
      resolveRepository: async () => {
        resolutions += 1;
        const resolution = await resolveRepository({ repositoryPath: started.root });
        return resolution.ok ? resolution.repository : null;
      },
      ...(sleep !== undefined ? { sleep: sleep.seam } : {}),
      agent: agent.runner,
      verify: verify.runner,
    }),
    lifecycleDeps: () => ({
      now: clock.now,
      git: runGitCommand,
      authPreflight: preflight.factory(),
      agent: agent.runner,
      verify: verify.runner,
    }),
  };
}

/** Asserts nothing was spawned at all. */
function expectNothingExecuted(scene: Scenario): void {
  expect(scene.agent.calls).toEqual([]);
  expect(scene.verify.calls).toEqual([]);
}

/* ══════════════ 1. the invocation grant, as a vocabulary ═════════════════ */

describe('the invocation grant is a closed vocabulary conjoined with the resume decision', () => {
  it('has exactly three members and no way to spell a fourth', () => {
    expect([...INVOCATION_GRANTS]).toEqual([
      'NO_CONTINUATION',
      'ATTENDED',
      'AUTOMATIC_RESUME_ONLY',
    ]);
  });

  /**
   * The permission table, written independently.
   *
   * Not derived from `permitsContinuation`, not built by iterating the
   * production vocabulary and applying the production rule. Every cell is typed
   * out, because a table generated from the thing it tests proves only that the
   * thing agrees with itself.
   */
  const EXPECTED: readonly {
    readonly grant: InvocationGrant;
    readonly continuation: ContinuationAuthority;
    readonly permitted: boolean;
    readonly refusal: GrantRefusalCode | null;
  }[] = [
    { grant: 'NO_CONTINUATION', continuation: 'TERMINAL', permitted: false, refusal: 'ATTENDED_CONTINUATION_NOT_GRANTED' },
    { grant: 'NO_CONTINUATION', continuation: 'BLOCKED', permitted: false, refusal: 'ATTENDED_CONTINUATION_NOT_GRANTED' },
    { grant: 'NO_CONTINUATION', continuation: 'ATTENDED_ONLY', permitted: false, refusal: 'ATTENDED_CONTINUATION_NOT_GRANTED' },
    { grant: 'NO_CONTINUATION', continuation: 'AUTOMATIC_ALLOWED', permitted: false, refusal: 'ATTENDED_CONTINUATION_NOT_GRANTED' },
    { grant: 'ATTENDED', continuation: 'TERMINAL', permitted: true, refusal: null },
    { grant: 'ATTENDED', continuation: 'BLOCKED', permitted: true, refusal: null },
    { grant: 'ATTENDED', continuation: 'ATTENDED_ONLY', permitted: true, refusal: null },
    { grant: 'ATTENDED', continuation: 'AUTOMATIC_ALLOWED', permitted: true, refusal: null },
    { grant: 'AUTOMATIC_RESUME_ONLY', continuation: 'TERMINAL', permitted: false, refusal: 'AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED' },
    { grant: 'AUTOMATIC_RESUME_ONLY', continuation: 'BLOCKED', permitted: false, refusal: 'AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED' },
    { grant: 'AUTOMATIC_RESUME_ONLY', continuation: 'ATTENDED_ONLY', permitted: false, refusal: 'AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED' },
    { grant: 'AUTOMATIC_RESUME_ONLY', continuation: 'AUTOMATIC_ALLOWED', permitted: true, refusal: null },
  ];

  it('permits exactly the twelve combinations written down here', () => {
    // Completeness first: the table below must cover the whole product of both
    // vocabularies, or a missing row would look like a passing case.
    expect(EXPECTED).toHaveLength(INVOCATION_GRANTS.length * CONTINUATION_AUTHORITIES.length);

    for (const row of EXPECTED) {
      const verdict = permitsContinuation(row.grant, row.continuation, false);
      expect({
        grant: row.grant,
        continuation: row.continuation,
        permitted: verdict.permitted,
        refusal: verdict.permitted ? null : verdict.refusal,
      }).toEqual(row);
    }
  });

  /**
   * The `continuingOwnAutomaticResume` axis, which nothing asserted.
   *
   * A review pointed out that every cell above passes `false`, so the property
   * "the carry belongs to one grant only" was an argument rather than a measured
   * fact: hoisting `if (continuingOwnAutomaticResume) return PERMITTED;` above
   * the switch survived the whole suite. It cannot be *observed* through the
   * driver — a `NO_CONTINUATION` run is refused before any resume write can set
   * the flag — which is exactly why it has to be pinned here instead.
   */
  it('lets only the automatic grant be carried by its own resume', () => {
    for (const continuation of CONTINUATION_AUTHORITIES) {
      // The carry is the automatic grant's alone.
      expect(permitsContinuation('AUTOMATIC_RESUME_ONLY', continuation, true)).toEqual({
        permitted: true,
      });
      // It grants nothing to an invocation that asked for no continuation.
      expect(permitsContinuation('NO_CONTINUATION', continuation, true)).toEqual({
        permitted: false,
        refusal: 'ATTENDED_CONTINUATION_NOT_GRANTED',
      });
      // And it changes nothing for the attended grant, which was already through.
      expect(permitsContinuation('ATTENDED', continuation, true)).toEqual({ permitted: true });
    }
  });

  it('keeps the attended refusal code it had before the type grew a member', () => {
    // Scripts read this code. `NO_CONTINUATION` is precisely what
    // `attendedContinuation: false` meant, so the wording must not have moved.
    const verdict = permitsContinuation('NO_CONTINUATION', 'ATTENDED_ONLY', false);
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) expect(verdict.refusal).toBe('ATTENDED_CONTINUATION_NOT_GRANTED');
  });

  it('refuses to start a task under the automatic grant only', () => {
    expect(mayStartTask('ATTENDED')).toBe(true);
    expect(mayStartTask('NO_CONTINUATION')).toBe(true);
    expect(mayStartTask('AUTOMATIC_RESUME_ONLY')).toBe(false);
  });
});

/* ═══════ 2. the negative authority matrix, through the real driver ═══════ */

/**
 * What `AUTOMATIC_RESUME_ONLY` is allowed to do with each durable condition.
 *
 * Written from the brief rather than from `BLOCKING_OUTCOME`, `LIFECYCLE_FOR_RUN`
 * or any other production table, so that permuting one of those tables fails
 * here. Every row is "nothing ran" except the one that is the whole point of the
 * slice.
 */
interface MatrixRow {
  readonly what: string;
  readonly overrides: Parameters<typeof seedDeliveredState>[1];
  /** `null` means "the reset time is absent"; a number is ms ahead of T0. */
  readonly resetAheadMs?: number | null;
  readonly outcome: RunOutcome;
  readonly executes: boolean;
}

const MATRIX: readonly MatrixRow[] = [
  {
    what: 'a quota block whose reset has passed and whose evidence all checks out',
    overrides: {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    },
    resetAheadMs: -60_000,
    outcome: 'TASK_COMPLETED',
    executes: true,
  },
  {
    what: 'a quota block whose reset has not been reached',
    overrides: {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    },
    resetAheadMs: RESET_AHEAD_MS,
    outcome: 'BLOCKED_USAGE_LIMIT',
    executes: false,
  },
  {
    what: 'a quota block carrying no reported reset time',
    overrides: {
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    },
    resetAheadMs: null,
    outcome: 'BLOCKED_USAGE_LIMIT',
    executes: false,
  },
  {
    what: 'a failed verification',
    overrides: { state: 'BLOCKED_VERIFY', resumeFrom: { phase: 'REMEDIATE', round: 1 } },
    outcome: 'BLOCKED_VERIFY',
    executes: false,
  },
  {
    what: 'expired credentials',
    overrides: {
      state: 'BLOCKED_AUTH',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    },
    outcome: 'BLOCKED_AUTH',
    executes: false,
  },
  {
    what: 'an escalation to an operator',
    overrides: {
      state: 'HUMAN_DECISION_REQUIRED',
      resumeFrom: { phase: 'REVIEW', round: 1 },
    },
    outcome: 'HUMAN_DECISION_REQUIRED',
    executes: false,
  },
  {
    what: 'a writer that went outside its scope',
    overrides: { state: 'SCOPE_VIOLATION' },
    outcome: 'SCOPE_VIOLATION',
    executes: false,
  },
  {
    what: 'a record that already diverged',
    overrides: { state: 'RESUME_STATE_DIVERGED' },
    outcome: 'RESUME_STATE_DIVERGED',
    executes: false,
  },
  {
    what: 'ordinary in-flight work that reconciles perfectly',
    overrides: { state: 'VERIFYING' },
    outcome: 'CONTINUATION_NOT_AUTHORISED',
    executes: false,
  },
  {
    what: 'ordinary in-flight work mid-implementation',
    overrides: { state: 'IMPLEMENTING' },
    outcome: 'CONTINUATION_NOT_AUTHORISED',
    executes: false,
  },
  {
    what: 'a finished task',
    overrides: { state: 'READY_FOR_PR', reviewRound: 1 },
    outcome: 'TASK_COMPLETED',
    executes: false,
  },
  {
    what: 'an abandoned task',
    overrides: { state: 'ABORTED' },
    outcome: 'TASK_ABORTED',
    executes: false,
  },
];

describe('AUTOMATIC_RESUME_ONLY runs one thing and refuses everything else', () => {
  for (const row of MATRIX) {
    it(`${row.executes ? 'continues' : 'refuses'} ${row.what}`, async () => {
      const started = await startTask({ taskId: TASK_ID });
      const resetAhead = row.resetAheadMs === undefined ? null : row.resetAheadMs;
      seedDeliveredState(started, {
        reportedResetAt: resetAhead === null ? null : new Date(T0 + resetAhead).toISOString(),
        ...row.overrides,
      });
      const agent = recordedAgent({
        claude: writerThatEdits('src/resumed.ts', 'export const resumed = true;' + NEWLINE),
        codex: () => reviewResult(passingReview()),
      });
      const verify = recordedVerify();

      const run = await runTask(
        {
          repository: started.repository,
          taskId: TASK_ID,
          continuationGrant: 'AUTOMATIC_RESUME_ONLY',
          authEvidence: provenAuthEvidence(),
          lease: leaseFor(started.repository),
          maxSteps: 8,
        },
        {
          now: advancingClock().now,
          git: runGitCommand,
          agent: agent.runner,
          verify: verify.runner,
        },
      );

      expect(run.outcome).toBe(row.outcome);
      if (row.executes) {
        expect(agent.countFor('claude')).toBeGreaterThan(0);
      } else {
        expect(agent.calls).toEqual([]);
        expect(verify.calls).toEqual([]);
      }
    });
  }

  it('names the grant, not the state, when it refuses in-flight work', async () => {
    const started = await startTask({ taskId: TASK_ID });
    seedDeliveredState(started, { state: 'VERIFYING' });

    const run = await runTask(
      {
        repository: started.repository,
        taskId: TASK_ID,
        continuationGrant: 'AUTOMATIC_RESUME_ONLY',
        authEvidence: provenAuthEvidence(),
        lease: leaseFor(started.repository),
        maxSteps: 8,
      },
      { now: advancingClock().now, git: runGitCommand },
    );

    // The reason has to say *which* requirement failed. "The record and reality
    // agree and still nothing ran" is only actionable with this code beside it.
    expect(run.reasonCodes).toEqual(['AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED']);
    expect(run.resume?.continuation).toBe('ATTENDED_ONLY');
  });

  it('leaves the review budget hard: an exhausted one is never resumed automatically', async () => {
    // The single most valuable thing this authority must not be able to do.
    // `HUMAN_DECISION_REQUIRED` is where an exhausted `maxReviewRounds` lands,
    // and no grant, no wait and no new invocation refills it.
    const started = await startTask({ taskId: TASK_ID });
    seedDeliveredState(started, {
      state: 'HUMAN_DECISION_REQUIRED',
      resumeFrom: { phase: 'REVIEW', round: 3 },
      reviewRound: 3,
      maxReviewRounds: 3,
    });
    const agent = recordedAgent({});

    const run = await runTask(
      {
        repository: started.repository,
        taskId: TASK_ID,
        continuationGrant: 'AUTOMATIC_RESUME_ONLY',
        authEvidence: provenAuthEvidence(),
        lease: leaseFor(started.repository),
        maxSteps: 8,
      },
      { now: advancingClock().now, git: runGitCommand, agent: agent.runner },
    );

    expect(run.outcome).toBe('HUMAN_DECISION_REQUIRED');
    expect(run.resume?.continuation).toBe('ATTENDED_ONLY');
    expect(agent.calls).toEqual([]);
    // And the record is untouched: no round was given back.
    const after = loadTaskState(started.root, TASK_ID);
    expect(after.ok && after.state.reviewRound).toBe(3);
  });
});

/* ═════════ 3. the lifecycle boundary: it cannot start anything ══════════ */

describe('the lifecycle boundary refuses to start a task under the automatic grant', () => {
  it('creates no workspace, branch, state, agent or verify run when nothing exists', async () => {
    // A repository with a task in its plan and **no durable state at all**: the
    // exact input `startTask` would happily turn into a worktree and a branch.
    const started = await startTask({ taskId: TASK_ID });
    releaseTestLeases();
    // Remove the workspace the fixture prepared, so "nothing exists" is true of
    // the worktree as well as of the state.
    rmSync(started.workspace.worktreePath, { recursive: true, force: true, maxRetries: 5 });
    git(started.root, ['worktree', 'prune']);

    const agent = recordedAgent({});
    const verify = recordedVerify();
    const preflight = countingPreflight();
    const branchesBefore = git(started.root, ['branch', '--list']);

    const result = await driveLifecycle(
      {
        repository: started.repository,
        taskId: TASK_ID,
        continuationGrant: 'AUTOMATIC_RESUME_ONLY',
        recoverStaleLease: false,
        maxSteps: 8,
        maxInvocations: 2,
      },
      {
        now: advancingClock().now,
        git: runGitCommand,
        authPreflight: preflight.factory(),
        agent: agent.runner,
        verify: verify.runner,
      },
    );

    expect(result.outcome).toBe('TASK_NOT_STARTED');
    // `startTask` was never entered: there is no start result to report.
    expect(result.start).toBeNull();
    expect(result.invocations).toBe(0);
    expect(agent.calls).toEqual([]);
    expect(verify.calls).toEqual([]);
    // The refusal is ahead of the preflight, so no subscription CLI was asked
    // to answer for a task that was never going to run.
    expect(preflight.checks()).toBe(0);
    // Nothing on disk moved, and the lease was given back.
    expect(loadTaskState(started.root, TASK_ID).ok).toBe(false);
    expect(git(started.root, ['branch', '--list'])).toBe(branchesBefore);
    expect(result.release?.code).toBe('RELEASED');
  });

  it('still starts a task under the attended grant, from the same input', async () => {
    // The control. Without it, "nothing was created" above could be a fixture
    // that could not have created anything either way.
    //
    // A repository built here rather than through the `startTask` helper,
    // because that helper prepares a workspace and this case needs one that has
    // never had one. It also supplies the `.gitignore` a real repository has:
    // `startTask` refuses to write state into a checkout its own runtime
    // directory would dirty, and the unattended case above never reaches that
    // check — which is itself part of what is being measured.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: {
        '.gitignore': IGNORE_RUNTIME,
        [`tasks/${TASK_ID}.md`]: TASK_FILE,
      },
    });
    const repository = await resolveFixture(root);
    trackWorkspacesOf(repository);

    const preflight = countingPreflight();
    const result = await driveLifecycle(
      {
        repository,
        taskId: TASK_ID,
        continuationGrant: 'ATTENDED',
        recoverStaleLease: false,
        maxSteps: 1,
        maxInvocations: 1,
      },
      {
        now: advancingClock().now,
        git: runGitCommand,
        authPreflight: preflight.factory(),
        agent: recordedAgent({}).runner,
        verify: recordedVerify().runner,
      },
    );

    // A workspace, a branch and the first durable state — everything the
    // unattended grant produced none of, from an input of the same shape.
    expect(result.start?.outcome).toBe('STARTED');
    expect(loadTaskState(root, TASK_ID).ok).toBe(true);
    expect(preflight.checks()).toBe(1);
  });
});

/* ══════════════ 4. the wait: when it happens, and when it does not ══════ */

describe('the wait is opt-in, bounded, and happens for exactly one reason', () => {
  it('waits once when the reported reset is the only thing left refusing', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.wait.disposition).toBe('WAITED');
    expect(result.wait.reasonCodes).toEqual(['RESET_TIME_NOT_REACHED']);
    // One sleep. Not two, and the length is the distance to the reset plus the
    // one millisecond the `now <= resetAt` boundary costs.
    expect(sleep.calls).toHaveLength(1);
    expect(sleep.calls[0]).toBeGreaterThan(0);
    expect(sleep.calls[0]).toBeLessThanOrEqual(RESET_AHEAD_MS + 1);
    expect(result.epochs).toHaveLength(2);
    // The first attempt stopped on the block; the second did the work.
    expect(result.epochs[0]?.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(result.outcome).toBe('COMPLETED');
    expect(scene.agent.countFor('claude')).toBeGreaterThan(0);
    expect(exitCodeForUnattendedResume(result)).toBe(EXIT_RUN_OK);
  });

  it('does not sleep when the wait was not requested', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(
      scene.request({ wait: { wait: false } }),
      scene.deps(sleep),
    );

    expect(sleep.calls).toEqual([]);
    expect(result.wait.disposition).toBe('NOT_REQUESTED');
    expect(result.epochs).toHaveLength(1);
    expect(result.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expectNothingExecuted(scene);
    expect(exitCodeForUnattendedResume(result)).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('does not sleep when the state records no reset time', async () => {
    const scene = await scenario({ resetAheadMs: null });
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(sleep.calls).toEqual([]);
    expect(result.wait.disposition).toBe('RESET_TIME_MISSING');
    expect(result.wait.reasonCodes).toContain('RESET_TIME_MISSING');
    expectNothingExecuted(scene);
  });

  it('never reaches the wait at all when the recorded reset time is not a timestamp', async () => {
    // `RESET_TIME_UNPARSEABLE` cannot be produced through the durable path: the
    // state schema accepts a strict subset of what `Date.parse` accepts, so a
    // value the clock arithmetic could not read is a value the loader refuses
    // outright. Rather than fabricate a state object to reach a code that
    // production cannot, this drives what an operator would actually meet — a
    // hand-corrupted timestamp in the state file — and pins that it stops before
    // any wait is considered.
    const scene = await scenario();
    const path = statePathOf(scene.started.root, TASK_ID);
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      path,
      `${JSON.stringify({ ...document, reportedResetAt: '2026-13-45T99:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(sleep.calls).toEqual([]);
    expect(result.outcome).toBe('STATE_UNUSABLE');
    expect(result.wait.disposition).toBe('NOT_A_QUOTA_BLOCK');
    expectNothingExecuted(scene);
  });

  it('does not sleep when something other than the clock also refuses', async () => {
    // The reset is in the future *and* the checkpoint does not claim a clean
    // worktree. Sleeping would delay a refusal rather than clear one.
    //
    // The second denial is staged through `worktreeCleanAtCheckpoint` rather
    // than by dirtying the tree, deliberately: a genuinely dirty worktree is
    // refused one gate *earlier*, by reconciliation, so the run would never
    // reach an automatic-resume verdict at all and this case would be measuring
    // a different refusal. Here the record and the world still agree, the
    // decision is reached, and it carries two denials.
    const scene = await scenario({ stateOverrides: { worktreeCleanAtCheckpoint: false } });
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(sleep.calls).toEqual([]);
    expect(result.wait.disposition).toBe('RESUME_DENIED_BY_OTHER_CHECKS');
    expect(result.wait.reasonCodes).toContain('RESET_TIME_NOT_REACHED');
    expect(result.wait.reasonCodes).toContain('WORKTREE_NOT_CLEAN');
    expectNothingExecuted(scene);
  });

  it('does not sleep when the reset is further away than the bound allows', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(
      scene.request({ wait: { wait: true, maxWaitMs: 1_000 } }),
      scene.deps(sleep),
    );

    expect(sleep.calls).toEqual([]);
    expect(result.wait.disposition).toBe('BOUND_EXCEEDED');
    expect(result.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expectNothingExecuted(scene);
    expect(exitCodeForUnattendedResume(result)).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('refuses an unusable wait bound before taking a lease at all', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);

    for (const maxWaitMs of [0, -1, 1.5, Number.NaN, MAX_WAIT_MS_CEILING + 1]) {
      const result = await driveUnattendedAutomaticResume(
        scene.request({ wait: { wait: true, maxWaitMs } }),
        scene.deps(sleep),
      );
      expect(result.epochs).toEqual([]);
      expect(result.outcome).toBe('INVOCATION_BUDGET_INVALID');
      expect(result.wait.reasonCodes).toEqual(['MAX_WAIT_MS_INVALID']);
      expect(exitCodeForUnattendedResume(result)).toBe(EXIT_RUN_INPUT_UNUSABLE);
    }
    expect(sleep.calls).toEqual([]);
    expectNothingExecuted(scene);
    // No lease was ever taken: the file is not there, and never was.
    expect(() => readFileSync(leasePathOf(scene.started.repository), 'utf8')).toThrow();
  });

  it('agrees with the CLI about which bounds are usable', () => {
    expect(isUsableWaitBound(1)).toBe(true);
    expect(isUsableWaitBound(MAX_WAIT_MS_CEILING)).toBe(true);
    expect(isUsableWaitBound(0)).toBe(false);
    expect(isUsableWaitBound(MAX_WAIT_MS_CEILING + 1)).toBe(false);
    expect(isUsableWaitBound(1.5)).toBe(false);
    expect(isUsableWaitBound(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('refuses a wait the invocation budget cannot cover, before any effect', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(
      scene.request({ maxInvocations: 1 }),
      scene.deps(sleep),
    );

    expect(result.epochs).toEqual([]);
    expect(result.wait.reasonCodes).toEqual(['MAX_INVOCATIONS_TOO_LOW_FOR_WAIT']);
    expect(sleep.calls).toEqual([]);
    expect(exitCodeForUnattendedResume(result)).toBe(EXIT_RUN_INPUT_UNUSABLE);
  });

  it('does not sleep when the lease was not provably given back', async () => {
    // A real hazard, staged through the product's own Git seam: the lease
    // vanishes while the first attempt is reconciling, so the release that
    // follows cannot prove anything. The attempt still reports the quota block
    // it reached — and the waiter must refuse to sleep on top of it.
    const scene = await scenario();
    const path = leasePathOf(scene.started.repository);
    let removed = false;
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), {
      ...scene.deps(sleep),
      git: async (cwd: string, args: readonly string[]) => {
        const answer = await runGitCommand(cwd, args);
        if (!removed) {
          removed = true;
          rmSync(path, { force: true });
        }
        return answer;
      },
    });

    expect(removed).toBe(true);
    expect(sleep.calls).toEqual([]);
    expect(result.wait.disposition).toBe('LEASE_RELEASE_UNPROVEN');
    expect(result.wait.reasonCodes).toEqual(['LEASE_ABSENT']);
    expect(result.epochs).toHaveLength(1);
    expect(result.epochs[0]?.outcome).toBe('LEASE_RELEASE_FAILED');
    expectNothingExecuted(scene);
  });

  it('treats waking exactly at the reported reset as refused, and lets the policy say so', async () => {
    // `evaluateAutomaticResume` refuses while `now <= reportedResetAt`. A clock
    // that does not move across the sleep therefore wakes into a second refusal
    // rather than into a resume — the post-wake decision is the authority, and
    // the arithmetic that chose the sleep length is not.
    const scene = await scenario({ resetAheadMs: 0 });
    const frozen = { seam: async (ms: number) => void frozen.calls.push(ms), calls: [] as number[] };

    const result = await driveUnattendedAutomaticResume(scene.request(), {
      ...scene.deps(),
      // A clock stopped exactly at the reported reset. `now === resetAt` on
      // every reading, before the sleep and after it, so the boundary is the
      // only thing under test.
      now: () => new Date(T0).toISOString(),
      // Sleeps without advancing anything: time did not pass.
      sleep: frozen.seam,
    });

    expect(frozen.calls).toHaveLength(1);
    expect(result.wait.disposition).toBe('WAITED');
    expect(result.epochs).toHaveLength(2);
    expect(result.epochs[1]?.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(result.epochs[1]?.runs.at(-1)?.resume?.automaticResume?.reasonCodes).toEqual([
      'RESET_TIME_NOT_REACHED',
    ]);
    expectNothingExecuted(scene);
  });

  it('sleeps at most once, however many quota blocks follow', async () => {
    // The post-wake resume runs the writer, which reports a usage limit again.
    // A daemon would sleep a second time; this stops.
    const scene = await scenario({
      agent: {
        claude: () => usageLimitResult(),
        codex: () => reviewResult(passingReview()),
      },
    });
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(sleep.calls).toHaveLength(1);
    expect(result.epochs).toHaveLength(2);
    expect(result.epochs[1]?.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(scene.agent.countFor('claude')).toBe(1);
  });
});

/* ══════════ 5. nothing survives the sleep except the task id ═══════════ */

describe('everything the second attempt acts on is established after the wait', () => {
  it('holds no execution lease while it sleeps', async () => {
    const scene = await scenario();
    let takenDuringSleep = false;
    const sleep = recordedSleep(scene.clock, () => {
      // The real exclusive create, against the real file. It refuses an
      // existing lease whoever asks, so succeeding here is proof the waiter is
      // holding nothing.
      const acquired = acquireRepositoryExecutionLease(
        scene.started.repository,
        { runId: null, blockId: null },
        { now: scene.clock.now },
      );
      takenDuringSleep = acquired.ok;
      if (acquired.ok) releaseRepositoryExecutionLease(acquired.evidence);
    });

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(takenDuringSleep).toBe(true);
    expect(result.wait.disposition).toBe('WAITED');
    expect(result.outcome).toBe('COMPLETED');
  });

  it('stops without running anything when another writer still owns the lease on waking', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock, () => {
      // Taken and kept: this process is alive and holds it when the waiter wakes.
      leaseFor(scene.started.repository);
    });

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.epochs).toHaveLength(2);
    expect(result.epochs[1]?.outcome).toBe('LIVE_OWNER_PRESENT');
    expect(result.epochs[1]?.invocations).toBe(0);
    expectNothingExecuted(scene);
    expect(exitCodeForUnattendedResume(result)).toBe(EXIT_RUN_REFUSED);
  });

  it('resolves the repository again rather than reusing the object it began with', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);

    await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    // Exactly one re-resolution, and it happened: the second attempt did not run
    // on the `ResolvedRepository` the first was handed.
    expect(scene.resolutions()).toBe(1);
  });

  it('runs nothing when the repository cannot be resolved after the wait', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), {
      ...scene.deps(sleep),
      resolveRepository: async () => null,
    });

    expect(result.wait.disposition).toBe('REPOSITORY_UNRESOLVED_AFTER_WAIT');
    expect(result.epochs).toHaveLength(1);
    expect(result.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expectNothingExecuted(scene);
  });

  it('refuses when the repository identity changed while it slept', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock, () => {
      // The same directory, declaring itself a different repository.
      writeRepoFile(
        scene.started.root,
        FIXTURE_PROFILE_RELATIVE_PATH,
        e2eProfile().replace('id: e2e-alpha', 'id: e2e-somewhere-else'),
      );
    });

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.epochs).toHaveLength(2);
    // A durable record whose `repositoryId` is not this repository's is an
    // intact record of somewhere else, which the loader refuses outright. The
    // second attempt therefore never reaches a resume decision — which is the
    // property under test: the identity is compared again, from a repository
    // resolved again, and the pre-wait resolution proves nothing.
    expect(result.epochs[1]?.outcome).toBe('STATE_UNUSABLE');
    expectNothingExecuted(scene);
  });

  it('refuses when the worktree was made dirty while it slept', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock, () => {
      writeRepoFile(scene.started.workspace.worktreePath, 'src/late.ts', 'export const late = 1;\n');
    });

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.epochs).toHaveLength(2);
    // Reconciliation refuses a checkpoint whose worktree has moved, one gate
    // before the resume decision is reached. That is the correct answer and the
    // one an operator gets: the record and the world disagree.
    expect(result.epochs[1]?.outcome).toBe('RECONCILIATION_DIVERGED');
    expectNothingExecuted(scene);
  });

  it('refuses when the current commit moved while it slept', async () => {
    const scene = await scenario();
    const worktree = scene.started.workspace.worktreePath;
    const sleep = recordedSleep(scene.clock, () => {
      writeRepoFile(worktree, 'src/other.ts', 'export const other = 1;\n');
      git(worktree, ['add', '--all']);
      git(worktree, [
        '-c', 'user.name=Somebody',
        '-c', 'user.email=somebody@local.invalid',
        'commit', '--quiet', '-m', 'a commit nobody recorded',
      ]);
    });

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.epochs).toHaveLength(2);
    // Reconciliation sees the record and the world disagree and stops first.
    expect(result.epochs[1]?.outcome).toBe('RECONCILIATION_DIVERGED');
    expectNothingExecuted(scene);
  });

  it('refuses when the durable state changed to ordinary in-flight work while it slept', async () => {
    // Somebody else resumed the task. It is now healthy, reconciled, in-flight
    // work — and this grant may not continue that.
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock, () => {
      const loaded = loadTaskState(scene.started.root, TASK_ID);
      if (!loaded.ok) throw new Error('fixture state did not load');
      const saved = saveTaskState(
        {
          ...loaded.state,
          state: 'VERIFYING',
          stateEnteredAt: scene.clock.now(),
          blockedAgent: null,
          resumeFrom: null,
          reportedResetAt: null,
        },
        { repositoryRoot: scene.started.root, expectedRevision: loaded.revision },
      );
      if (!saved.ok) throw new Error(`fixture rewrite refused: ${saved.code}`);
    });

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.epochs).toHaveLength(2);
    expect(result.epochs[1]?.outcome).toBe('CONTINUATION_NOT_AUTHORISED');
    expect(result.epochs[1]?.reasonCodes).toContain(
      'AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED',
    );
    expectNothingExecuted(scene);
  });

  it('runs nothing when the task became terminal while it slept', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock, () => {
      const loaded = loadTaskState(scene.started.root, TASK_ID);
      if (!loaded.ok) throw new Error('fixture state did not load');
      const saved = saveTaskState(
        {
          ...loaded.state,
          state: 'READY_FOR_PR',
          stateEnteredAt: scene.clock.now(),
          blockedAgent: null,
          resumeFrom: null,
          reportedResetAt: null,
          // `READY_FOR_PR` is only reachable through a completed review.
          reviewRound: 1,
        },
        { repositoryRoot: scene.started.root, expectedRevision: loaded.revision },
      );
      if (!saved.ok) throw new Error(`fixture rewrite refused: ${saved.code}`);
    });

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.epochs[1]?.outcome).toBe('COMPLETED');
    expectNothingExecuted(scene);
  });

  it('proves auth again after the wait, and stops when the second proof fails', async () => {
    const scene = await scenario({ failPreflightFromEpoch: 2 });
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    // Two epochs, two preflight closures, two real checks. The artefact minted
    // before the sleep authorised nothing after it.
    expect(scene.preflight.epochs()).toBe(2);
    expect(scene.preflight.checks()).toBe(2);
    expect(result.epochs[1]?.outcome).toBe('AUTH_PREFLIGHT_FAILED');
    expectNothingExecuted(scene);
    expect(exitCodeForUnattendedResume(result)).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('still pays for only one preflight per epoch, however many invocations it makes', async () => {
    // The other half of the freshness rule: resetting the memoisation at the
    // epoch boundary must not make an ordinary run start the subscription CLIs
    // repeatedly.
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);

    await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(scene.preflight.checks()).toBe(scene.preflight.epochs());
  });

  it('reports a quota block it created itself as parked, not as a defect', async () => {
    // The shape a scheduled invocation actually meets: the reset had passed, the
    // run resumed, it worked, and the writer hit the quota again. The block on
    // record is one *this run* created, so `RunResult.resume` — taken at the top
    // of that iteration — is a decision about the in-flight state the step
    // blocked from, and carries no automatic-resume verdict.
    //
    // A review found this listed in the README as unreachable and reported to
    // the operator as "a defect floor rather than an operator condition". It is
    // neither. Nothing slept, the task is parked correctly, and a later
    // invocation judges the new block.
    const scene = await scenario({
      resetAheadMs: -60_000,
      agent: {
        claude: () => usageLimitResult(),
        codex: () => reviewResult(passingReview()),
      },
    });
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(result.wait.disposition).toBe('RESUME_DECISION_ABSENT');
    expect(sleep.calls).toEqual([]);
    // The resume really happened: the writer ran, and a durable step landed.
    expect(scene.agent.countFor('claude')).toBe(1);
    expect(result.epochs[0]?.steps).toBeGreaterThan(0);
    // And the report does not call an ordinary condition a defect.
    const report = renderUnattendedResume(scene.started.repository, result);
    expect(report).toContain('Wait         : RESUME_DECISION_ABSENT');
    expect(report).not.toContain('defect');
    expect(report).toContain('durably parked');
  });

  it('tells an unusable wait bound apart from a reset that is too far away', async () => {
    // Two opposite instructions that shared one name until a review separated
    // them: "raise the bound or come back later" and "that number is not usable
    // at all". The report is rendered here, which is what the earlier
    // codes-only assertions could not catch.
    const scene = await scenario();

    const unusable = await driveUnattendedAutomaticResume(
      scene.request({ wait: { wait: true, maxWaitMs: Number.NaN } }),
      scene.deps(),
    );
    const report = renderUnattendedResume(scene.started.repository, unusable);

    expect(unusable.wait.disposition).toBe('WAIT_BOUND_UNUSABLE');
    expect(report).toContain('Wait         : WAIT_BOUND_UNUSABLE');
    // What names the actual cause is the reasons line, not the outcome
    // sentence: one outcome has three producers, so its sentence lists all
    // three and could not truthfully accuse any one of them. This assertion was
    // first written as "the report does not mention --max-invocations", which
    // would have been satisfied only by a sentence that lies to the other two
    // producers.
    expect(report).toContain('Wait reasons : MAX_WAIT_MS_INVALID');
    // The disambiguating advice is the wait sentence, and it is about the right
    // flag and does not tell the operator to raise a bound of NaN.
    expect(report).toContain('The --max-wait-ms value is not a bound this build will sleep on');
    expect(report).not.toContain('Raise the bound, or invoke again after the reset');
  });

  it('answers a too-low budget with the same shared sentence and its own reason', async () => {
    const scene = await scenario();

    const budget = await driveUnattendedAutomaticResume(
      scene.request({ maxInvocations: 1 }),
      scene.deps(),
    );
    const report = renderUnattendedResume(scene.started.repository, budget);

    expect(budget.wait.disposition).toBe('INVOCATION_BUDGET_SPENT');
    expect(report).toContain('MAX_INVOCATIONS_TOO_LOW_FOR_WAIT');
    // One shared outcome, two producers, and the sentence has to hold for both:
    // it names all three possibilities and the reasons line says which.
    expect(report).toContain('A bound this run was given cannot be used');
  });
});

/* ═══════════════ 6. stale recovery is not part of this grant ════════════ */

describe('the automatic grant carries no destructive lease permission', () => {
  it('leaves a stale lease untouched and runs nothing', async () => {
    const scene = await scenario();
    const path = leasePathOf(scene.started.repository);
    // A lease whose recorded owner is not running — the input `--recover-stale-lease`
    // exists for. Built the way the slice-5 and slice-6 suites build one.
    const evidence = leaseFor(scene.started.repository);
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    releaseTestLeases();
    releaseRepositoryExecutionLease(evidence);
    writeFileSync(
      path,
      `${JSON.stringify({ ...document, ownerPid: deadProcessId() }, null, 2)}\n`,
      'utf8',
    );
    const before = readFileSync(path, 'utf8');
    const sleep = recordedSleep(scene.clock);

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    expect(result.epochs[0]?.outcome).toBe('STALE_LEASE_PRESENT');
    expect(result.epochs[0]?.recovery).toBeNull();
    expect(result.epochs[0]?.reasonCodes).toContain('STALE_RECOVERY_NOT_PERMITTED');
    // Byte-identical. There is no argument to this entry point that would have
    // changed that, which is the point of fixing the permission inside it.
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(sleep.calls).toEqual([]);
    expectNothingExecuted(scene);
  });

  it('refuses a recovery permission at the driver boundary, not only in its callers', async () => {
    // `driveUnattendedAutomaticResume` passes `recoverStaleLease: false` and the
    // CLI refuses the flag combination, so no caller reaches this with both set.
    // A review pointed out that made the property an argument about callers
    // rather than one the layer that performs the removal holds — so it is asked
    // of `driveLifecycle` directly, with the permission explicitly on.
    const scene = await scenario();
    const path = leasePathOf(scene.started.repository);
    const evidence = leaseFor(scene.started.repository);
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    releaseTestLeases();
    releaseRepositoryExecutionLease(evidence);
    writeFileSync(
      path,
      `${JSON.stringify({ ...document, ownerPid: deadProcessId() }, null, 2)}
`,
      'utf8',
    );
    const before = readFileSync(path, 'utf8');

    const result = await driveLifecycle(
      {
        repository: scene.started.repository,
        taskId: TASK_ID,
        continuationGrant: 'AUTOMATIC_RESUME_ONLY',
        // Explicitly granted, and it must still be refused.
        recoverStaleLease: true,
        maxSteps: 8,
        maxInvocations: 1,
      },
      scene.lifecycleDeps(),
    );

    expect(result.outcome).toBe('STALE_LEASE_PRESENT');
    expect(result.recovery).toBeNull();
    expect(result.reasonCodes).toContain('STALE_RECOVERY_NOT_PERMITTED');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expectNothingExecuted(scene);
  });

  it('still lets the attended grant recover, so the refusal above is the grant', async () => {
    // The control. Without it, "nothing was removed" could be a fixture whose
    // lease no recovery would ever have accepted — which is in fact true here
    // (no writer-launch ledger, so the predicate refuses) — and the difference
    // that matters is *where* the two runs stop. Under the automatic grant the
    // recovery is never attempted at all (`recovery === null`); under the
    // attended one it is attempted and refuses on its own proof.
    const scene = await scenario();
    const path = leasePathOf(scene.started.repository);
    const evidence = leaseFor(scene.started.repository);
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    releaseTestLeases();
    releaseRepositoryExecutionLease(evidence);
    writeFileSync(
      path,
      `${JSON.stringify({ ...document, ownerPid: deadProcessId() }, null, 2)}
`,
      'utf8',
    );

    const result = await driveLifecycle(
      {
        repository: scene.started.repository,
        taskId: TASK_ID,
        continuationGrant: 'ATTENDED',
        recoverStaleLease: true,
        maxSteps: 8,
        maxInvocations: 1,
      },
      scene.lifecycleDeps(),
    );

    expect(result.recovery).not.toBeNull();
    expect(result.outcome).toBe('RECOVERY_UNSAFE');
  });
});

/** A process id that is not running. Verified, never assumed. */
function deadProcessId(): number {
  for (let candidate = 60_000; candidate < 65_000; candidate += 7) {
    try {
      process.kill(candidate, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('no dead process id could be established');
}

/* ══════════════════════════ 7. the operator report ══════════════════════ */

describe('the report distinguishes every way this mode can end', () => {
  it('has a sentence for every wait disposition, and no two the same', () => {
    expect(Object.keys(RESET_WAIT_SENTENCES).sort()).toEqual([...RESET_WAIT_DISPOSITIONS].sort());
    for (const disposition of RESET_WAIT_DISPOSITIONS) {
      expect(RESET_WAIT_SENTENCES[disposition].length).toBeGreaterThan(40);
    }
    // Distinctness, which length alone does not give: a table of fourteen
    // identical 41-character strings satisfied the check above, and a review
    // pointed out that the sibling table in `tests/v3-06-lifecycle-driver.test.ts`
    // has this and this one did not.
    const sentences = RESET_WAIT_DISPOSITIONS.map((d) => RESET_WAIT_SENTENCES[d]);
    expect(new Set(sentences).size).toBe(RESET_WAIT_DISPOSITIONS.length);
  });

  it('does not tell an operator whose login failed that auth was proven', async () => {
    // Two sentences in one report used to contradict each other: the outcome
    // said the preflight runs "once per invocation of this command", which a
    // wait makes false, and the trailer beside it said auth was proven for every
    // attempt, which is false for an attempt that never got that far. Both were
    // rewritten, and neither was rendered by any case until now.
    const scene = await scenario({ failPreflightFromEpoch: 1 });

    const result = await driveUnattendedAutomaticResume(
      scene.request({ wait: { wait: false } }),
      scene.deps(),
    );
    const report = renderUnattendedResume(scene.started.repository, result);

    expect(result.outcome).toBe('AUTH_PREFLIGHT_FAILED');
    expect(report).toContain('It runs once per attempt');
    expect(report).not.toContain('once per invocation of this command');
    expect(report).not.toContain('Auth evidence was proven separately for every attempt');
    expectNothingExecuted(scene);
  });

  it('does not claim every reason needs fixing when one of them is the clock', async () => {
    const scene = await scenario({ stateOverrides: { worktreeCleanAtCheckpoint: false } });

    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps());
    const report = renderUnattendedResume(scene.started.repository, result);

    expect(result.wait.disposition).toBe('RESUME_DENIED_BY_OTHER_CHECKS');
    // The list contains one reason time *does* fix, so the sentence may not say
    // every reason needs resolving — it must exclude the reset time by name.
    expect(report).toContain('RESET_TIME_NOT_REACHED');
    // Matched within one rendered line: the sentences are hard-wrapped, so a
    // needle that spans a break is a needle that can never be found.
    expect(report).toContain('that are not about the reset time have to be resolved');
    expect(report).not.toContain('each one has to be resolved');
  });

  it('never claims an operator was present', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);
    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    const report = renderUnattendedResume(scene.started.repository, result);

    expect(report).toContain(UNATTENDED_AUTO_RESUME_TRAILER);
    expect(report).not.toContain(ATTENDED_TRAILER);
    expect(report).not.toContain('--attended was given');
    // Both attempts are shown, labelled, with the wait between them.
    expect(report).toContain('Attempt      : 1 of 2');
    expect(report).toContain('Attempt      : 2 of 2');
    expect(report).toContain('Wait         : WAITED');
    expect(report).toContain(RESET_WAIT_SENTENCES.WAITED);
  });

  it('reports a refusal that never took a lease without inventing a run', async () => {
    const scene = await scenario();
    const result = await driveUnattendedAutomaticResume(
      scene.request({ maxInvocations: 1 }),
      scene.deps(),
    );

    const report = renderUnattendedResume(scene.started.repository, result);

    expect(report).toContain('Lifecycle    : INVOCATION_BUDGET_INVALID');
    expect(report).toContain('Wait         : INVOCATION_BUDGET_SPENT');
    expect(report).toContain('MAX_INVOCATIONS_TOO_LOW_FOR_WAIT');
    // No lease lines, no run lines: nothing happened, and the report says so by
    // omission rather than by printing empty fields.
    expect(report).not.toContain('Release');
    expect(report).not.toContain('Invocations');
  });

  it('prints only closed vocabulary, counts, ids and validated values', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);
    const result = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    const report = renderUnattendedResume(scene.started.repository, result);

    // The seams answer with recorded agent output; none of it may appear.
    expect(report).not.toContain('is_error');
    expect(report).not.toContain('api_error_status');
    expect(report.toLowerCase()).not.toContain('stack');
  });
});

/* ═══════════════════ 8. the exit-code contract is unchanged ════════════ */

describe('the exit-code taxonomy gained no members', () => {
  it('grades an unattended run by its last attempt', async () => {
    const scene = await scenario();
    const sleep = recordedSleep(scene.clock);
    const waited = await driveUnattendedAutomaticResume(scene.request(), scene.deps(sleep));

    // The run slept on a quota block (which would be 3) and then completed.
    // The code is the *last* attempt's, because that is what happened.
    expect(waited.epochs[0]?.outcome).toBe('BLOCKED_USAGE_LIMIT');
    expect(exitCodeForUnattendedResume(waited)).toBe(EXIT_RUN_OK);
  });
});
