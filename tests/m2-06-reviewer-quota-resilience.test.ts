/**
 * M2 slice 6: a Codex quota block is a pause, not a human decision.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `transitions.ts` has always declared `REVIEWING → BLOCKED_USAGE_LIMIT`, and
 * `resume-policy.ts` has always allowed `blockedAgent: 'codex'` on it. Nothing
 * could reach either. `codex-reviewer.ts` recognised no quota signal, so an
 * exhausted allowance arrived as `AGENT_NONZERO_EXIT` →
 * `AGENT_NEEDS_ATTENTION` → `HUMAN_DECISION_REQUIRED`, with `reportedResetAt:
 * null` — a task ended, by a condition that clears itself in five hours.
 *
 * Two further things had to be true before fixing the classification meant
 * anything, and each is a section below:
 *
 *  - the reset instant has to survive. Codex names it as a bare time of day, so
 *    it is *derived*, and §2 pins the derivation against a stated timezone
 *    rather than the host's;
 *  - the block has to carry a checkpoint, or `evaluateAutomaticResume` denies
 *    it with `CURRENT_COMMIT_MISMATCH` and `WORKTREE_NOT_CLEAN` for ever. That
 *    is F-10's defect on the phase F-10 could not cover, and §5 measures the
 *    denial list rather than asserting a boolean.
 *
 * ── What is synthetic here ─────────────────────────────────────────────────
 *
 * The provider's bytes are not. `CODEX_USAGE_LIMIT_MESSAGE` is the recorded
 * production message, and `codexFailedTurn` is the measured `turn.failed`
 * envelope — both documented in `tests/fixtures.ts` with the date, the CLI
 * version and the cross-check against the structured `resets_at` they were
 * verified against.
 *
 * The clock is injected, because it is in every other suite here. The timezone
 * is injected in §2 alone, and only there: a test that cannot choose the zone
 * can only assert daylight-saving behaviour against whichever zone the machine
 * happens to sit in, which is not an assertion about the rule.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { runCodexReviewer } from '../src/agent/codex-reviewer.js';
import {
  deriveResetInstant,
  readCodexQuotaRefusal,
  type LocalOffsetMinutes,
} from '../src/agent/internal/codex-quota-signal.js';
import { evaluateAutomaticResume } from '../src/core/automatic-resume.js';
import { parseTaskState, type TaskState } from '../src/core/task-state.js';
import {
  createReviewerProviderGate,
  REVIEWER_PROVIDER_GATE,
  type ReviewerProviderGate,
} from '../src/loop/reviewer-provider-gate.js';
import {
  runImplementStep,
  runReviewStep,
  runVerifyStep,
  type LoopDependencies,
} from '../src/loop/loop-step.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { startTask } from '../src/run/start-task.js';
import { observeRuntime } from '../src/state/observe-runtime.js';
import { loadTaskState, saveTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { classifyResume } from '../src/state/resume-decision.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { AgentCommandResult } from '../src/agent/agent-command.js';
import { agentCommandResult, codexFailedTurn, CODEX_USAGE_LIMIT_MESSAGE } from './fixtures.js';
import { authPreflightPasses, provenAuthEvidence } from './helpers/auth-evidence.js';
import { leaseAuthorityFor, leaseFor, releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, git, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture } from './helpers/worktree-fixtures.js';
import {
  codexUsageLimitResult,
  e2eProfile,
  findingsReview,
  headOf,
  recordedAgent,
  recordedVerify,
  reviewResult,
  writerThatEdits,
} from './helpers/e2e-fixtures.js';

const TASK_ID = 'M2-06';
const NEWLINE = '\n';

/**
 * The instant the recorded refusal was written: `2026-08-29T11:29:57Z`, from
 * the `task_complete` event of the incident whose message is the fixture.
 *
 * The reset that message named — `5:35 PM` — was structurally `1788017730` =
 * `2026-08-29T15:35:30Z`. So the derivation is measured against the pair the
 * provider itself produced, not against a chosen number.
 */
const REFUSED_AT = '2026-08-29T11:29:57.000Z';

/** The zone the recorded message was rendered in: UTC+2 (CEST). */
const CEST: LocalOffsetMinutes = () => -120;

/** What the derivation must produce for the recorded pair, in that zone. */
const DERIVED_RESET = '2026-08-29T15:36:00.000Z';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

/* ─────────────────────────── §1 the signal reader ───────────────────────── */

describe('§1 the Codex quota signal, read from what the CLI actually prints', () => {
  it('recognises the recorded production refusal and reads the time it named', () => {
    const refusal = readCodexQuotaRefusal(codexFailedTurn(CODEX_USAGE_LIMIT_MESSAGE));

    expect(refusal.verdict).toBe('USAGE_LIMIT');
    // 5:35 PM in 24-hour form. Read from the message, not assumed.
    expect(refusal.resetTimeOfDay).toEqual({ hour: 17, minute: 35 });
  });

  it('recognises the refusal even when the message names no time', () => {
    const refusal = readCodexQuotaRefusal(
      codexFailedTurn("You've hit your usage limit. Upgrade to Pro to continue."),
    );

    // A pause with nothing to wait for is still a pause. The reset is the part
    // that is missing, not the classification.
    expect(refusal.verdict).toBe('USAGE_LIMIT');
    expect(refusal.resetTimeOfDay).toBeNull();
  });

  it.each([
    ['midnight', '12:05 AM', { hour: 0, minute: 5 }],
    ['an early morning hour', '4:05 AM', { hour: 4, minute: 5 }],
    ['noon', '12:05 PM', { hour: 12, minute: 5 }],
    ['an afternoon hour', '4:05 PM', { hour: 16, minute: 5 }],
    ['one minute to midnight', '11:59 PM', { hour: 23, minute: 59 }],
  ])('converts %s from the 12-hour clock the message uses', (_label, printed, expected) => {
    // Every other case in this file is PM and neither 12 nor 0, so the two ends
    // of the conversion — where `12 AM` is hour 0 and `12 PM` is hour 12 — were
    // walked past entirely. `hour12 % 12` is the whole rule and it is wrong in
    // both directions if written as a bare `+ 12`.
    const refusal = readCodexQuotaRefusal(
      codexFailedTurn(`You've hit your usage limit. Upgrade to Pro or try again at ${printed}.`),
    );

    expect(refusal.verdict).toBe('USAGE_LIMIT');
    expect(refusal.resetTimeOfDay).toEqual(expected);
  });

  it.each([
    ['a 12-hour clock has no hour 0', 'or try again at 0:35 PM.'],
    ['a 12-hour clock has no hour 13', 'or try again at 13:35 PM.'],
    ['there is no minute 61', 'or try again at 5:61 PM.'],
  ])('refuses a malformed time (%s) without losing the classification', (_why, tail) => {
    const refusal = readCodexQuotaRefusal(
      codexFailedTurn(`You've hit your usage limit. Upgrade to Pro ${tail}`),
    );

    expect(refusal.verdict).toBe('USAGE_LIMIT');
    expect(refusal.resetTimeOfDay).toBeNull();
  });

  it.each([
    ['an unrelated failure', 'The model is not supported when using Codex with a ChatGPT account.'],
    [
      'a message that merely quotes the sentence',
      'The reviewed file says: "You\'ve hit your usage limit." Fix the wording.',
    ],
    ['an auth rejection', 'Not authenticated. Run `codex login` and try again at 5:35 PM.'],
  ])('reads no quota refusal from %s', (_label, message) => {
    expect(readCodexQuotaRefusal(codexFailedTurn(message)).verdict).toBe('NONE');
  });

  it('reads no quota refusal from a transcript with no failed turn', () => {
    const healthy = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n');

    expect(readCodexQuotaRefusal(healthy).verdict).toBe('NONE');
  });

  it('cannot be reached through an agent message, however it is spelled', () => {
    // The reviewer reads this repository, so it reads the fixture above. The
    // recogniser must look at the event type, not at the bytes anywhere.
    const quoting = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i', type: 'agent_message', text: CODEX_USAGE_LIMIT_MESSAGE },
      }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n');

    expect(readCodexQuotaRefusal(quoting).verdict).toBe('NONE');
  });

  it('takes the last failed turn, and skips lines it cannot parse', () => {
    const noisy = [
      JSON.stringify({ type: 'turn.failed', error: { message: 'a transient stream error' } }),
      '{ not json at all',
      JSON.stringify({ type: 'turn.failed', error: { message: CODEX_USAGE_LIMIT_MESSAGE } }),
    ].join('\n');

    expect(readCodexQuotaRefusal(noisy).verdict).toBe('USAGE_LIMIT');
  });
});

/* ────────────────────── §2 turning a time into an instant ───────────────── */

describe('§2 the reset instant, derived against a stated timezone', () => {
  it('reproduces the instant the provider structurally reported', () => {
    // The message said 5:35 PM; `rate_limits.primary.resets_at` said
    // 2026-08-29T15:35:30Z. The derivation rounds the named minute up, so it
    // lands at :36:00 — after the real reset, never before it.
    const derived = deriveResetInstant({ hour: 17, minute: 35 }, Date.parse(REFUSED_AT), CEST);

    expect(derived).toBe(DERIVED_RESET);
    expect(Date.parse(derived ?? '')).toBeGreaterThan(1788017730 * 1000);
  });

  it('names later today, not tomorrow, when the clock is inside the named minute', () => {
    // The message truncates seconds. A block observed at 17:35:10 whose message
    // says 5:35 PM is naming a reset later in this very minute; a search that
    // started at the next minute would return tomorrow.
    const derived = deriveResetInstant(
      { hour: 17, minute: 35 },
      Date.parse('2026-08-29T15:35:10.000Z'),
      CEST,
    );

    expect(derived).toBe(DERIVED_RESET);
  });

  it('names tomorrow when the time of day has already gone by', () => {
    const derived = deriveResetInstant(
      { hour: 9, minute: 5 },
      Date.parse('2026-08-29T15:35:10.000Z'),
      CEST,
    );

    expect(derived).toBe('2026-08-30T07:06:00.000Z');
  });

  it('always returns an instant strictly after the moment it was derived at', () => {
    const now = Date.parse('2026-08-29T15:35:59.900Z');
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of [0, 35, 59]) {
        const derived = deriveResetInstant({ hour, minute }, now, CEST);
        expect(derived).not.toBeNull();
        expect(Date.parse(derived ?? '')).toBeGreaterThan(now);
      }
    }
  });

  it('resolves an ambiguous wall clock to the later instant', () => {
    // A fall-back fold: the zone is UTC+2 until 01:00Z and UTC+1 after it, so
    // local 02:30 happens twice — at 00:30Z and again at 01:30Z. The earlier one
    // is before the reset, so the later one is the safe reading.
    const folding: LocalOffsetMinutes = (ms) => (ms < Date.parse('2026-10-25T01:00:00.000Z') ? -120 : -60);

    const derived = deriveResetInstant(
      { hour: 2, minute: 30 },
      Date.parse('2026-10-25T00:00:00.000Z'),
      folding,
    );

    expect(derived).toBe('2026-10-25T01:31:00.000Z');
  });

  it('skips a wall clock that does not exist and finds the next real one', () => {
    // A spring-forward gap: local jumps 02:00 → 03:00, so 02:30 never happens
    // on this day. The search walks past it to tomorrow rather than inventing
    // an instant for a time that was not on the clock.
    const springing: LocalOffsetMinutes = (ms) =>
      ms < Date.parse('2026-03-29T01:00:00.000Z') ? -60 : -120;

    const derived = deriveResetInstant(
      { hour: 2, minute: 30 },
      Date.parse('2026-03-29T00:00:00.000Z'),
      springing,
    );

    expect(derived).toBe('2026-03-30T00:31:00.000Z');
  });

  it('refuses rather than guesses when the clock itself is unreadable', () => {
    expect(deriveResetInstant({ hour: 17, minute: 35 }, Number.NaN, CEST)).toBeNull();
  });
});

/* ─────────────────────────── §3 the reviewer boundary ───────────────────── */

async function reviewOf(result: AgentCommandResult) {
  return runCodexReviewer(
    { worktreePath: '/srv/worktrees/alpha/task', round: 2, payload: 'review', now: REFUSED_AT },
    { agent: async () => result, localOffsetMinutes: CEST },
  );
}

describe('§3 the boundary classifies a quota refusal as a pause', () => {
  it('produces AGENT_USAGE_LIMIT, the codex block and the derived reset', async () => {
    const outcome = await reviewOf(codexUsageLimitResult());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_USAGE_LIMIT');
    expect(outcome.disposition).toBe('AGENT_BLOCKED_USAGE_LIMIT');
    expect(outcome.block).toEqual({
      blockedAgent: 'codex',
      resumeFrom: { phase: 'REVIEW', round: 2 },
      reportedResetAt: DERIVED_RESET,
    });
  });

  it('still pauses when the message named no time, with no reset invented', async () => {
    const outcome = await reviewOf(
      codexUsageLimitResult({ message: "You've hit your usage limit." }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.disposition).toBe('AGENT_BLOCKED_USAGE_LIMIT');
    expect(outcome.block?.reportedResetAt).toBeNull();
  });

  it.each<[string, AgentCommandResult]>([
    [
      'an auth rejection',
      agentCommandResult({ exitCode: 1, stdout: codexFailedTurn('Not authenticated with Codex.') }),
    ],
    [
      'an unknown provider error',
      agentCommandResult({ exitCode: 1, stdout: codexFailedTurn('internal server error') }),
    ],
    ['a reviewer executable failure', agentCommandResult({ outcome: 'UNAVAILABLE', exitCode: null })],
    ['malformed reviewer output', agentCommandResult({ exitCode: 0, stdout: 'not a transcript' })],
  ])('does not read %s as a quota pause', async (_label, result) => {
    const outcome = await reviewOf(result);

    if (outcome.ok) expect.unreachable();
    expect(outcome.code).not.toBe('AGENT_USAGE_LIMIT');
    expect(outcome.disposition).not.toBe('AGENT_BLOCKED_USAGE_LIMIT');
  });

  it('never classifies from the bytes of a process that was killed', async () => {
    // The quota sentence is on stdout, but the run did not end under its own
    // control — so it is not a verdict about anything. This is the rule
    // `endedUnderOwnControl` exists to state, and the recogniser sits behind it.
    const outcome = await reviewOf(
      agentCommandResult({
        exitCode: null,
        signal: 'SIGKILL',
        stdout: codexFailedTurn(CODEX_USAGE_LIMIT_MESSAGE),
      }),
    );

    if (outcome.ok) expect.unreachable();
    expect(outcome.code).toBe('AGENT_PROCESS_UNAVAILABLE');
    expect(outcome.block).toBeNull();
  });

  it('does not reclassify a healthy review that happens to exit zero', async () => {
    const outcome = await reviewOf(reviewResult({ reviewVersion: 1, verdict: 'PASS', findings: [] }));

    expect(outcome.ok).toBe(true);
  });
});

/* ──────────────────────── the end-to-end harness ────────────────────────── */

async function reviewingRepo(
  options: { readonly maxReviewRounds?: number } = {},
): Promise<{ repository: ResolvedRepository; root: string; current: StateLoadSuccess }> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(options),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      [`tasks/${TASK_ID}.md`]: [
        '---',
        `id: ${TASK_ID}`,
        'title: survive a reviewer quota block',
        'status: OPEN',
        'kind: NORMAL',
        'priority: NORMAL',
        'currentFocus: true',
        'dependsOn: []',
        '---',
        'Do the described thing.',
      ].join('\n'),
    },
  });
  const repository = await resolveFixture(root);

  const started = await startTask(
    { repository, taskId: TASK_ID },
    {
      git: runGitCommand,
      now: () => '2026-08-29T09:00:00.000Z',
      authPreflight: authPreflightPasses,
      lease: leaseFor(repository),
    },
  );
  expect(started.outcome).toBe('STARTED');

  const { runWorktreeReadyStep, runContextLoadingStep } = await import('../src/loop/loop-step.js');
  let current = reload(root);
  expect((await runWorktreeReadyStep(current, deps(current, repository))).outcome).toBe('ADVANCED');
  current = reload(root);
  expect((await runContextLoadingStep(current, deps(current, repository))).outcome).toBe('ADVANCED');

  // Through the real writing and verifying hops, so the state that reaches
  // `REVIEWING` is one production wrote — including the two checkpoint
  // withdrawals that make this slice necessary.
  current = reload(root);
  const writer = recordedAgent({
    claude: writerThatEdits('src/done.ts', `export const done = true;${NEWLINE}`),
  });
  expect(
    (await runImplementStep(current, deps(current, repository, { agent: writer.runner }))).state,
  ).toBe('VERIFYING');
  current = reload(root);
  expect(
    (await runVerifyStep(current, deps(current, repository, { verify: recordedVerify().runner })))
      .state,
  ).toBe('REVIEWING');

  return { repository, root, current: reload(root) };
}

function reload(root: string): StateLoadSuccess {
  const loaded = loadTaskState(root, TASK_ID);
  if (loaded.classification !== 'STATE_VALID') {
    throw new Error(`state not valid: ${loaded.classification}`);
  }
  return loaded;
}

function deps(
  current: StateLoadSuccess,
  repository: ResolvedRepository,
  overrides: Partial<LoopDependencies> = {},
): LoopDependencies {
  return {
    now: REFUSED_AT,
    authorisedWorktreePath: current.state.worktreePath,
    verification: repository.verification,
    brief: readExecutionBrief(repository, TASK_ID, current.state.worktreePath),
    lease: leaseAuthorityFor(repository),
    // A gate nobody else shares. The production instance is process-wide by
    // design, and a suite that used it would be measuring its own earlier cases.
    reviewerProviderGate: createReviewerProviderGate(),
    writerMcp: null,
    ...overrides,
  };
}

/** The resume decision for `state` against the world as it stands right now. */
async function decide(state: TaskState, repository: ResolvedRepository, now: string) {
  const observed = await observeRuntime(runGitCommand, state);
  return classifyResume(state, observed, {
    now,
    authEvidence: provenAuthEvidence(),
    repository: {
      id: repository.id,
      root: repository.root,
      defaultBranch: repository.defaultBranch,
    },
    taskId: TASK_ID,
  });
}

/* ───────────────── §4 the production path, end to end ───────────────────── */

describe('§4 a reviewer quota block, driven through production', () => {
  it('parks at BLOCKED_USAGE_LIMIT with the reset, the agent and the resume point', async () => {
    const { repository, root, current } = await reviewingRepo();

    // The state this slice inherits: both checkpoint facts already withdrawn.
    expect(current.state.currentCommit).toBeNull();
    expect(current.state.worktreeCleanAtCheckpoint).toBe(false);

    const agent = recordedAgent({ codex: () => codexUsageLimitResult() });
    const step = await runReviewStep(
      current,
      deps(current, repository, { agent: agent.runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('BLOCKED_USAGE_LIMIT');

    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.blockedAgent).toBe('codex');
    expect(blocked.resumeFrom).toEqual({ phase: 'REVIEW', round: 1 });
    expect(blocked.reportedResetAt).not.toBeNull();

    // The round is not spent: an interrupted review reviewed nothing.
    expect(blocked.reviewRound).toBe(0);
  });

  it('settles the worktree so the pause can actually be resumed', async () => {
    const { repository, root, current } = await reviewingRepo();
    const head = headOf(current.state.worktreePath);

    const agent = recordedAgent({ codex: () => codexUsageLimitResult() });
    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    const blocked = reload(root).state;
    // Measured, not restored: this is the HEAD Git reports for the worktree.
    expect(blocked.currentCommit).toBe(head);
    expect(blocked.worktreeCleanAtCheckpoint).toBe(true);
    expect(git(current.state.worktreePath, ['status', '--porcelain']).trim()).toBe('');
  });

  it('withholds the checkpoint when the reviewer left the worktree dirty', async () => {
    const { repository, root, current } = await reviewingRepo();

    // A reviewer that wrote has broken its contract. `--sandbox read-only` is a
    // request to the CLI; the transition table admits `REVIEWING →
    // SCOPE_VIOLATION` because the request can be refused, so a settled
    // checkpoint here has to be measured rather than assumed.
    const agent = recordedAgent({
      codex: ({ cwd }) => {
        writeFileSync(join(cwd, 'src', 'reviewer-wrote.ts'), 'export const oops = 1;\n');
        return codexUsageLimitResult();
      },
    });
    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    // Still a pause — the quota fact is true — but nothing may resume into a
    // tree the reviewer changed.
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('withholds the checkpoint from a reviewer that committed, not just a dirty one', async () => {
    const { repository, root, current } = await reviewingRepo();
    const before = headOf(current.state.worktreePath);

    // A reviewer that escaped `--sandbox read-only` and *committed* leaves a
    // CLEAN worktree at a DIFFERENT HEAD. The clean-tree test alone cannot see
    // that — `mintInterruptionCheckpoint` refuses only a dirty tree and a
    // malformed SHA — so this is the case the before/after HEAD comparison
    // exists for, and the only one that kills a mutant which drops it.
    const agent = recordedAgent({
      codex: ({ cwd }) => {
        writeFileSync(join(cwd, 'src', 'reviewer-committed.ts'), 'export const oops = 1;\n');
        git(cwd, ['add', '--all']);
        git(cwd, [
          '-c',
          'user.name=Reviewer',
          '-c',
          'user.email=reviewer@local.invalid',
          'commit',
          '--quiet',
          '-m',
          'the reviewer broke its contract',
        ]);
        return codexUsageLimitResult();
      },
    });
    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    // The tree really is clean, at a HEAD that really did move. Both stated, so
    // the case cannot decay into the dirty-tree one beside it.
    expect(git(current.state.worktreePath, ['status', '--porcelain']).trim()).toBe('');
    expect(headOf(current.state.worktreePath)).not.toBe(before);

    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('withdraws a carried checkpoint when the review interruption measured none', async () => {
    // The regression this pins, found by review before it shipped:
    //
    // giving `REVIEWING` a checkpoint of its own made it possible for a
    // `REVIEWING` state to *carry* `clean: true` at an exact commit — a resumed
    // quota pause does exactly that. `withdrawnCheckpointFor` used to withdraw
    // nothing for a read-only phase, so a second interruption that measured
    // nothing re-asserted both claims over a tree the reviewer may have
    // dirtied. `reconcile.ts` reads that as divergence, and
    // `RESUME_STATE_DIVERGED` is a state no operator command clears — strictly
    // worse than the `HUMAN_DECISION_REQUIRED` it replaced.
    const { repository, root, current } = await reviewingRepo();
    const head = headOf(current.state.worktreePath);

    const carried = saveTaskState(
      { ...current.state, currentCommit: head, worktreeCleanAtCheckpoint: true },
      { repositoryRoot: root, expectedRevision: current.revision },
    );
    expect(carried.ok).toBe(true);
    const carrying = reload(root);
    expect(carrying.state.state).toBe('REVIEWING');
    expect(carrying.state.worktreeCleanAtCheckpoint).toBe(true);

    // Not a quota refusal, so nothing is measured and nothing may be claimed.
    const agent = recordedAgent({
      codex: ({ cwd }) => {
        writeFileSync(join(cwd, 'src', 'reviewer-wrote.ts'), 'export const oops = 1;\n');
        return agentCommandResult({ exitCode: 0, stdout: 'not a transcript' });
      },
    });
    await runReviewStep(carrying, deps(carrying, repository, { agent: agent.runner }));

    const blocked = reload(root).state;
    expect(blocked.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('records the instant the message actually named, in the host’s own zone', async () => {
    // Every other end-to-end assertion here is satisfied by any parseable
    // string: they compare the stored value with itself, or with a bound
    // derived from it. This is the one that pins the *derivation*, and it is
    // zone-independent by construction — the message said 5:35 PM local, the
    // rounding takes it to 5:36 PM local, and that reads the same on a host in
    // UTC, in CEST or in UTC-10.
    const { repository, root, current } = await reviewingRepo();
    const agent = recordedAgent({ codex: () => codexUsageLimitResult() });

    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    const stored = reload(root).state.reportedResetAt ?? '';
    const local = new Date(Date.parse(stored));
    expect(local.getHours()).toBe(17);
    expect(local.getMinutes()).toBe(36);
    // And it is in the future of the instant that observed the refusal.
    expect(Date.parse(stored)).toBeGreaterThan(Date.parse(REFUSED_AT));
  });

  it('withholds the checkpoint from a reviewer that cleaned the worktree', async () => {
    const { repository, root, current } = await reviewingRepo();
    const worktree = current.state.worktreePath;

    // The tree is dirty *before* the reviewer opens it. A reviewer that then
    // discards that work — `git checkout -- .`, a stash — leaves a clean tree at
    // the same HEAD, which the after-observation alone cannot tell from a tree
    // that was clean all along. Only the before-observation can, and this is the
    // case that measures it.
    writeFileSync(join(worktree, 'src', 'work-in-progress.ts'), 'export const wip = 1;\n');
    expect(git(worktree, ['status', '--porcelain']).trim()).not.toBe('');

    const agent = recordedAgent({
      codex: ({ cwd }) => {
        rmSync(join(cwd, 'src', 'work-in-progress.ts'));
        return codexUsageLimitResult();
      },
    });
    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    expect(git(worktree, ['status', '--porcelain']).trim()).toBe('');
    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('withholds the checkpoint on a withheld call over a tree that was never clean', async () => {
    // The withheld branch settles from the pre-review observation alone, because
    // nothing ran between taking it and the write. That is only sound while the
    // observation is judged: a repository reaching `REVIEWING` with a dirty tree
    // must not be recorded as settled just because no reviewer was started.
    const shared = createReviewerProviderGate();
    shared.noteExhausted('codex', DERIVED_RESET);

    const { repository, root, current } = await reviewingRepo();
    writeFileSync(
      join(current.state.worktreePath, 'src', 'left-behind.ts'),
      'export const stray = 1;\n',
    );

    const agent = recordedAgent({ codex: () => codexUsageLimitResult() });
    await runReviewStep(
      current,
      deps(current, repository, { agent: agent.runner, reviewerProviderGate: shared }),
    );

    expect(agent.countFor('codex')).toBe(0);
    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.reportedResetAt).toBe(DERIVED_RESET);
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('leaves a genuine human decision a human decision', async () => {
    // The last permitted round found something. Nothing could review a
    // remediation of it, so it goes to a person — and must not be diverted into
    // a pause by anything this slice added.
    const { repository, root, current } = await reviewingRepo({ maxReviewRounds: 1 });
    const agent = recordedAgent({ codex: () => reviewResult(findingsReview('src/done.ts')) });

    const step = await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    const blocked = reload(root).state;
    expect(blocked.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(blocked.reportedResetAt).toBeNull();
  });

  it.each<[string, AgentCommandResult]>([
    [
      'an auth rejection',
      agentCommandResult({ exitCode: 1, stdout: codexFailedTurn('Not authenticated with Codex.') }),
    ],
    ['a reviewer that never started', agentCommandResult({ outcome: 'UNAVAILABLE', exitCode: null })],
    ['malformed reviewer output', agentCommandResult({ exitCode: 0, stdout: 'garbage' })],
  ])('does not downgrade %s into a quota pause', async (_label, result) => {
    const { repository, root, current } = await reviewingRepo();
    const agent = recordedAgent({ codex: () => result });

    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    const blocked = reload(root).state;
    expect(blocked.state).not.toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.reportedResetAt).toBeNull();
    // And the reverse of the same rule: nothing that is not a proven pause gets
    // an unattended-resume claim written for it.
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });
});

/* ───────────────────── §5 eligibility, before and after ─────────────────── */

describe('§5 the pause becomes eligible again, and not before', () => {
  async function blockedState(): Promise<{
    repository: ResolvedRepository;
    state: TaskState;
  }> {
    const { repository, root, current } = await reviewingRepo();
    const agent = recordedAgent({ codex: () => codexUsageLimitResult() });
    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));
    return { repository, state: reload(root).state };
  }

  it('is denied only for the reset not having passed', async () => {
    const { repository, state } = await blockedState();
    const reset = state.reportedResetAt ?? '';
    const before = new Date(Date.parse(reset) - 1000).toISOString();

    const decision = evaluateAutomaticResume(state, {
      now: before,
      authEvidence: provenAuthEvidence(),
      observedRepositoryId: state.repositoryId,
      observedRepositoryRoot: state.repositoryRoot,
      observedWorktreePath: state.worktreePath,
      worktreeExists: true,
      observedBasePinnedCommit: state.basePinnedCommit,
      observedCurrentCommit: state.currentCommit,
      worktreeClean: true,
      divergenceDetected: false,
    });

    // The whole point of the checkpoint half of this slice: the denial list is
    // exactly one item, and it is the one that clears itself. Before the slice
    // it also carried CURRENT_COMMIT_MISMATCH and WORKTREE_NOT_CLEAN, which
    // never clear.
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toEqual(['RESET_TIME_NOT_REACHED']);
  });

  it('is allowed once the reset has passed, against the real repository', async () => {
    const { repository, state } = await blockedState();
    const after = new Date(Date.parse(state.reportedResetAt ?? '') + 1000).toISOString();

    // Through `classifyResume`, so the evidence is gathered from Git rather
    // than written down here.
    const decision = await decide(state, repository, after);

    expect(decision.classification).toBe('AUTOMATIC_RESUME_ALLOWED');
  });

  it('is not eligible before the reset, through the same real path', async () => {
    const { repository, state } = await blockedState();
    const before = new Date(Date.parse(state.reportedResetAt ?? '') - 1000).toISOString();

    const decision = await decide(state, repository, before);

    expect(decision.classification).not.toBe('AUTOMATIC_RESUME_ALLOWED');
  });

  it('does not deadlock on a reset that is already in the past', async () => {
    const { repository, state } = await blockedState();
    // An expired reset is not a permanent block: it is a reset that has passed,
    // which is the condition for continuing.
    const expired = parseTaskState({ ...state, reportedResetAt: '2020-01-01T00:00:00.000Z' });

    const decision = await decide(expired, repository, REFUSED_AT);

    expect(decision.classification).toBe('AUTOMATIC_RESUME_ALLOWED');
  });

  it('refuses to resume a pause whose message named no time', async () => {
    const { repository, root, current } = await reviewingRepo();
    const agent = recordedAgent({
      codex: () => codexUsageLimitResult({ message: "You've hit your usage limit." }),
    });
    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    const state = reload(root).state;
    expect(state.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(state.reportedResetAt).toBeNull();

    const decision = await decide(state, repository, '2027-01-01T00:00:00.000Z');
    expect(decision.classification).not.toBe('AUTOMATIC_RESUME_ALLOWED');
  });
});

/* ────────────────────────── §6 the restart boundary ─────────────────────── */

describe('§6 the wait survives the process that recorded it', () => {
  it('is on disk, in the durable contract, readable by a fresh load', async () => {
    const { root, current, repository } = await reviewingRepo();
    const agent = recordedAgent({ codex: () => codexUsageLimitResult() });
    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    // Not the in-memory value: the file, parsed through the real contract by a
    // loader that shares nothing with the writer.
    const raw = JSON.parse(
      readFileSync(
        join(root, '.agent-orchestrator', 'runtime', `${TASK_ID}.json`),
        'utf8',
      ),
    ) as Record<string, unknown>;

    expect(raw['state']).toBe('BLOCKED_USAGE_LIMIT');
    expect(raw['blockedAgent']).toBe('codex');
    expect(raw['resumeFrom']).toEqual({ phase: 'REVIEW', round: 1 });
    expect(typeof raw['reportedResetAt']).toBe('string');
    expect(raw['worktreeCleanAtCheckpoint']).toBe(true);
    expect(typeof raw['currentCommit']).toBe('string');

    // And it is an absolute instant in UTC, not a local wall clock: everything
    // downstream compares it with `Date.parse`.
    expect(String(raw['reportedResetAt'])).toMatch(/Z$/);
    expect(Number.isFinite(Date.parse(String(raw['reportedResetAt'])))).toBe(true);
  });

  it('carries nothing about the provider gate, which is deliberately volatile', async () => {
    const { root, current, repository } = await reviewingRepo();
    const agent = recordedAgent({ codex: () => codexUsageLimitResult() });
    await runReviewStep(current, deps(current, repository, { agent: agent.runner }));

    const raw = readFileSync(
      join(root, '.agent-orchestrator', 'runtime', `${TASK_ID}.json`),
      'utf8',
    );

    // The gate is a process-lifetime memo, not a scheduler and not a record. A
    // fresh process knows nothing and asks the provider, which is the correct
    // default — and the reason this slice ships no persistence of its own.
    expect(raw).not.toMatch(/exhausted/i);
    expect(raw).not.toMatch(/providerGate/i);
  });
});

/* ─────────────────────── §7 one subscription, one call ──────────────────── */

describe('§7 the provider gate', () => {
  it('runs one reviewer call at a time', async () => {
    const gate = createReviewerProviderGate();
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const a = gate.runExclusively('codex', async () => {
      order.push('a:start');
      await first;
      order.push('a:end');
    });
    const b = gate.runExclusively('codex', async () => {
      order.push('b:start');
    });

    // `b` cannot have started: `a` is still in flight.
    await Promise.resolve();
    expect(order).toEqual(['a:start']);

    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('does not strand later callers when one call throws', async () => {
    const gate = createReviewerProviderGate();

    await expect(
      gate.runExclusively('codex', async () => {
        throw new Error('the reviewer blew up');
      }),
    ).rejects.toThrow('the reviewer blew up');

    await expect(gate.runExclusively('codex', async () => 'still works')).resolves.toBe(
      'still works',
    );
  });

  it('withholds the provider after a recognised exhaustion, until the reset', () => {
    const gate = createReviewerProviderGate();
    gate.noteExhausted('codex', DERIVED_RESET);

    expect(gate.availability('codex', REFUSED_AT)).toEqual({
      available: false,
      resetAt: DERIVED_RESET,
    });
    expect(gate.availability('codex', '2026-08-29T15:36:00.000Z')).toEqual({ available: true });
  });

  it('keeps the later of two reported resets', () => {
    const gate = createReviewerProviderGate();
    gate.noteExhausted('codex', '2026-08-29T15:36:00.000Z');
    gate.noteExhausted('codex', '2026-08-29T15:35:00.000Z');

    const availability = gate.availability('codex', REFUSED_AT);
    expect(availability.available).toBe(false);
    if (availability.available) expect.unreachable();
    expect(availability.resetAt).toBe('2026-08-29T15:36:00.000Z');
  });

  it.each([null, 'not a timestamp', ''])(
    'remembers nothing from an unusable reset (%j)',
    (value) => {
      const gate = createReviewerProviderGate();
      gate.noteExhausted('codex', value);

      // A gate that withheld calls on an unreadable value would be an outage it
      // inflicted on itself. The next caller asks the provider instead.
      expect(gate.availability('codex', REFUSED_AT)).toEqual({ available: true });
    },
  );

  it('keeps its memory to itself, so the process-wide one is not a test artefact', () => {
    const mine = createReviewerProviderGate();
    mine.noteExhausted('codex', DERIVED_RESET);

    // Two independent facts, and the second is the one worth pinning: a suite
    // that exhausted its own gate must not have exhausted the machine's.
    expect(mine.availability('codex', REFUSED_AT).available).toBe(false);
    expect(REVIEWER_PROVIDER_GATE.availability('codex', REFUSED_AT).available).toBe(true);
  });
});

describe('§7a the review step calls the reviewer from inside the exclusion', () => {
  it('is inside runExclusively when the reviewer process starts', async () => {
    // The gate's own exclusion is pinned in §7. This pins the thing §7 cannot
    // see: that `runReviewStep` actually *uses* it. A mutant that replaced
    // `gate.runExclusively(...)` with a direct call to the same callback left
    // every other case in this file green — availability is still consulted and
    // the exhaustion is still recorded — while two repositories could once
    // again have two reviewers in flight.
    //
    // Asserted structurally rather than by timing: the reviewer records whether
    // the exclusive section is open around it, so there is no window to race
    // and no sleep to tune.
    const inner = createReviewerProviderGate();
    let entered = false;
    let exited = false;
    let ranInsideExclusion: boolean | null = null;

    const observing: ReviewerProviderGate = {
      runExclusively: async (provider, call) => {
        entered = true;
        try {
          return await inner.runExclusively(provider, call);
        } finally {
          exited = true;
        }
      },
      availability: (provider, now) => inner.availability(provider, now),
      noteExhausted: (provider, resetAt) => inner.noteExhausted(provider, resetAt),
    };

    const { repository, current } = await reviewingRepo();
    const agent = recordedAgent({
      codex: () => {
        ranInsideExclusion = entered && !exited;
        return codexUsageLimitResult();
      },
    });

    await runReviewStep(
      current,
      deps(current, repository, { agent: agent.runner, reviewerProviderGate: observing }),
    );

    expect(agent.countFor('codex')).toBe(1);
    expect(ranInsideExclusion).toBe(true);
    expect(exited).toBe(true);
  });
});

describe('§7c the binding production actually uses', () => {
  it('falls back to the one gate the process shares, not to a fresh one', async () => {
    // Every other case in this file injects a gate, so the identity of the
    // default was unobservable — and a mutant that made it
    // `?? createReviewerProviderGate()` left the whole suite green while voiding
    // both of the gate's rules in production at once: each call would get an
    // empty queue and an empty memory.
    //
    // Measured by teaching the process-wide gate an exhaustion and then driving
    // a step that injects nothing. The record is removed again through the
    // gate's own expiry, so this case leaves the process as it found it.
    REVIEWER_PROVIDER_GATE.noteExhausted('codex', DERIVED_RESET);
    try {
      const { repository, root, current } = await reviewingRepo();
      const agent = recordedAgent({ codex: () => codexUsageLimitResult() });

      // Built here rather than through `deps()`, because `deps()` injects a
      // gate and the whole point of this case is the field being **absent**.
      const step = await runReviewStep(current, { writerMcp: null,
        now: REFUSED_AT,
        authorisedWorktreePath: current.state.worktreePath,
        verification: repository.verification,
        brief: readExecutionBrief(repository, TASK_ID, current.state.worktreePath),
        lease: leaseAuthorityFor(repository),
        agent: agent.runner,
      });

      expect(agent.countFor('codex')).toBe(0);
      expect(step.state).toBe('BLOCKED_USAGE_LIMIT');
      expect(reload(root).state.reportedResetAt).toBe(DERIVED_RESET);
    } finally {
      // Asking after the reset is what forgets it — the gate's own rule, used
      // here rather than a back door.
      REVIEWER_PROVIDER_GATE.availability('codex', '2027-01-01T00:00:00.000Z');
    }
    expect(REVIEWER_PROVIDER_GATE.availability('codex', REFUSED_AT).available).toBe(true);
  });
});

describe('§7b two repositories sharing one subscription', () => {
  it('spends one reviewer call, not two, and parks both tasks as pauses', async () => {
    // One gate, two repositories — which is what `maxConcurrentRepositories > 1`
    // produces on one machine, since the reviewer's login is the operator's and
    // not the repository's.
    const shared = createReviewerProviderGate();

    const alpha = await reviewingRepo();
    const beta = await reviewingRepo();

    const alphaAgent = recordedAgent({ codex: () => codexUsageLimitResult() });
    const betaAgent = recordedAgent({ codex: () => codexUsageLimitResult() });

    await runReviewStep(
      alpha.current,
      deps(alpha.current, alpha.repository, {
        agent: alphaAgent.runner,
        reviewerProviderGate: shared,
      }),
    );
    await runReviewStep(
      beta.current,
      deps(beta.current, beta.repository, {
        agent: betaAgent.runner,
        reviewerProviderGate: shared,
      }),
    );

    // The first repository learned it from the provider; the second learned it
    // from the first, and spent nothing doing so.
    expect(alphaAgent.countFor('codex')).toBe(1);
    expect(betaAgent.countFor('codex')).toBe(0);

    const alphaState = reload(alpha.root).state;
    const betaState = reload(beta.root).state;
    for (const state of [alphaState, betaState]) {
      expect(state.state).toBe('BLOCKED_USAGE_LIMIT');
      expect(state.blockedAgent).toBe('codex');
      expect(state.resumeFrom).toEqual({ phase: 'REVIEW', round: 1 });
      // Both are resumable, and both wait for the same window.
      expect(state.worktreeCleanAtCheckpoint).toBe(true);
    }
    expect(betaState.reportedResetAt).toBe(alphaState.reportedResetAt);
  });

  it('lets the second repository through once the window has reset', async () => {
    const shared = createReviewerProviderGate();
    const alpha = await reviewingRepo();
    const beta = await reviewingRepo();

    const alphaAgent = recordedAgent({ codex: () => codexUsageLimitResult() });
    await runReviewStep(
      alpha.current,
      deps(alpha.current, alpha.repository, {
        agent: alphaAgent.runner,
        reviewerProviderGate: shared,
      }),
    );

    // Read from what the first repository actually recorded, never hard-coded:
    // the instant is derived in the machine's own zone, so a literal here would
    // pass in one timezone and fail in another.
    const reset = reload(alpha.root).state.reportedResetAt ?? '';
    const afterReset = new Date(Date.parse(reset) + 1000).toISOString();

    const betaAgent = recordedAgent({
      codex: () => reviewResult({ reviewVersion: 1, verdict: 'PASS', findings: [] }),
    });
    const step = await runReviewStep(
      beta.current,
      deps(beta.current, beta.repository, {
        agent: betaAgent.runner,
        reviewerProviderGate: shared,
        now: afterReset,
      }),
    );

    expect(betaAgent.countFor('codex')).toBe(1);
    expect(step.outcome).not.toBe('STATE_NOT_RECORDED');
    expect(reload(beta.root).state.state).not.toBe('BLOCKED_USAGE_LIMIT');
  });

  it('does not withhold on an exhaustion that named no reset', async () => {
    // Remembering "exhausted, indefinitely" would be a self-inflicted outage
    // with no instant to end it. The second repository asks the provider.
    const shared = createReviewerProviderGate();
    const alpha = await reviewingRepo();
    const beta = await reviewingRepo();

    await runReviewStep(
      alpha.current,
      deps(alpha.current, alpha.repository, {
        agent: recordedAgent({
          codex: () => codexUsageLimitResult({ message: "You've hit your usage limit." }),
        }).runner,
        reviewerProviderGate: shared,
      }),
    );

    const betaAgent = recordedAgent({ codex: () => codexUsageLimitResult() });
    await runReviewStep(
      beta.current,
      deps(beta.current, beta.repository, {
        agent: betaAgent.runner,
        reviewerProviderGate: shared,
      }),
    );

    expect(betaAgent.countFor('codex')).toBe(1);
  });
});
