/**
 * V3-10 / F-10: a quota-interrupted writer is settled to an exact checkpoint.
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 *
 * `evaluateAutomaticResume` grants an unattended resume only against an exact
 * recorded `currentCommit` and `worktreeCleanAtCheckpoint === true` which a
 * *fresh* observation still agrees with. A writing phase interrupted by a usage
 * limit withdrew both — correctly, because the writer may have moved HEAD or
 * left work uncommitted — and nothing put them back. So every production quota
 * block acquired `CURRENT_COMMIT_MISMATCH` and `WORKTREE_NOT_CLEAN` and was
 * permanently non-resumable, however trustworthy its reset time. That is F-10.
 *
 * The fix establishes the two facts instead of ceasing to require them. Nothing
 * in `evaluateAutomaticResume` changed, and the suite is written so that
 * changing it would not make these cases pass.
 *
 * ── What is synthetic here, and what is not ────────────────────────────────
 *
 * Exactly one value: the reset time `T`. When this suite was written the
 * production writer ran `--output-format json`, where no reset instant is
 * reported at all, so `reportedResetAt` was `null` on every real block and
 * `RESET_TIME_MISSING` was the standing denial (L-V3-08-1, since closed by
 * V3-11 — `tests/v3-11-quota-reset-stream.test.ts` reaches the same denial list
 * with nothing synthetic at all). `T` is kept here rather than replaced,
 * because the property this suite owns is the *checkpoint*, and supplying the
 * reset time is what isolates it from the reader that now produces one: every
 * other fact these cases judge —
 * the checkpoint commit, the cleanliness, the resume point, the repository
 * identity, the observation, the reconciliation — comes from production code
 * over a real Git worktree. `T` is applied to a state the producer wrote,
 * field by field unmodified otherwise, which is why `withSyntheticReset` copies
 * one property and re-parses through the real contract rather than building a
 * state by hand.
 *
 * ── Why the cases drive `runImplementStep` rather than a seeded state ──────
 *
 * The claim is about a *producer*. A suite that seeded `BLOCKED_USAGE_LIMIT`
 * with a commit and `clean: true` would be asserting that
 * `evaluateAutomaticResume` reads two fields, which was never in doubt. What
 * has to be shown is that AO writes those fields only when it measured them,
 * and that every way the measurement can fail leaves the old, denying shape.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { runImplementStep, runVerifyStep, type LoopDependencies } from '../src/loop/loop-step.js';
import { recordAgentInterruption } from '../src/agent/record-interruption.js';
import {
  isInterruptionCheckpoint,
  interruptionCheckpointCommitOf,
  type InterruptionCheckpoint,
} from '../src/core/interruption-checkpoint.js';
import {
  InterruptionCheckpointProof as Proof,
  mintInterruptionCheckpoint,
} from '../src/core/internal/interruption-checkpoint.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import { parseTaskState, type TaskState } from '../src/core/task-state.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';
import { startTask } from '../src/run/start-task.js';
import { classifyResume } from '../src/state/resume-decision.js';
import { observeRuntime } from '../src/state/observe-runtime.js';
import { loadTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { runGitCommand, type GitRunner } from '../src/worktree/git-command.js';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { leaseAuthorityFor, leaseFor, releaseTestLeases } from './helpers/lease.js';
import { authPreflightPasses, provenAuthEvidence } from './helpers/auth-evidence.js';
import { createRepoFixture, removeRepoFixtures, git, writeRepoFile } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture } from './helpers/worktree-fixtures.js';
import {
  e2eProfile,
  headOf,
  recordedAgent,
  recordedVerify,
  usageLimitResult,
  writerSuccess,
  writerThatEdits,
  writerThatEditsThenHitsUsageLimit,
} from './helpers/e2e-fixtures.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';

const TASK_ID = 'V3-10';
const NEWLINE = '\n';

/** Far enough ahead that no test machine's clock reaches it mid-run. */
const T = '2027-01-01T00:00:00.000Z';
const BEFORE_T = '2026-12-31T23:59:59.000Z';
const AFTER_T = '2027-01-01T00:00:01.000Z';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

/* ──────────────────────────────── harness ───────────────────────────────── */

/** A repository with one startable task and `src` as its only allowed path. */
async function readyRepo(): Promise<{ repository: ResolvedRepository; root: string }> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      [`tasks/${TASK_ID}.md`]: [
        '---',
        `id: ${TASK_ID}`,
        'title: settle a quota interruption',
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
  return { repository: await resolveFixture(root), root };
}

/** Drives the task through production code to `IMPLEMENTING`, ready to step. */
async function implementing(): Promise<{
  repository: ResolvedRepository;
  root: string;
  current: StateLoadSuccess;
  worktreePath: string;
}> {
  const { repository, root } = await readyRepo();
  const started = await startTask(
    { repository, taskId: TASK_ID },
    {
      git: runGitCommand,
      now: () => '2026-08-22T09:00:00.000Z',
      authPreflight: authPreflightPasses,
      lease: leaseFor(repository),
    },
  );
  expect(started.outcome).toBe('STARTED');

  // Through the real hops, not by seeding: the state this suite measures must
  // be one production wrote from end to end.
  const { runWorktreeReadyStep, runContextLoadingStep } = await import('../src/loop/loop-step.js');
  let current = reload(root);
  const deps = (state: StateLoadSuccess): LoopDependencies => stepDeps(state, repository);
  expect((await runWorktreeReadyStep(current, deps(current))).outcome).toBe('ADVANCED');
  current = reload(root);
  expect((await runContextLoadingStep(current, deps(current))).outcome).toBe('ADVANCED');
  current = reload(root);
  expect(current.state.state).toBe('IMPLEMENTING');

  return { repository, root, current, worktreePath: current.state.worktreePath };
}

/**
 * Drives a fresh task all the way to `REVIEWING` through production steps.
 *
 * Needed because the read-only half of the checkpoint gate can only be asked
 * from a phase that runs the reviewer, and a seeded state would not prove the
 * producer ever reaches one carrying the shape being tested.
 */
async function driveTo(
  repository: ResolvedRepository,
  root: string,
  target: 'REVIEWING',
): Promise<StateLoadSuccess> {
  let current = reload(root);
  const agent = recordedAgent({
    claude: writerThatEdits('src/done.ts', `export const done = true;${NEWLINE}`),
  });
  expect(
    (await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }))).state,
  ).toBe('VERIFYING');
  current = reload(root);
  const verify = recordedVerify();
  expect(
    (await runVerifyStep(current, stepDeps(current, repository, { verify: verify.runner }))).state,
  ).toBe(target);
  return reload(root);
}

function reload(root: string): StateLoadSuccess {
  const loaded = loadTaskState(root, TASK_ID);
  if (loaded.classification !== 'STATE_VALID') {
    throw new Error(`state not valid: ${loaded.classification}`);
  }
  return loaded;
}

function stepDeps(
  current: StateLoadSuccess,
  repository: ResolvedRepository,
  overrides: Partial<LoopDependencies> = {},
): LoopDependencies {
  return {
    now: '2026-08-22T10:00:00.000Z',
    authorisedWorktreePath: current.state.worktreePath,
    verification: repository.verification,
    brief: readExecutionBrief(repository, TASK_ID, current.state.worktreePath),
    lease: leaseAuthorityFor(repository),
    ...overrides,
  };
}

/**
 * The same state with a reported reset time, re-parsed through the real
 * contract.
 *
 * The one synthetic value in this suite — see the header. It is applied by
 * copying a state the producer wrote and replacing a single property, so a case
 * that accidentally depended on a hand-built field would fail the contract here
 * rather than pass quietly.
 */
function withSyntheticReset(state: TaskState, reportedResetAt: string | null): TaskState {
  return parseTaskState({ ...state, reportedResetAt });
}

/** The resume decision for `state` against the world as it stands right now. */
async function decide(
  state: TaskState,
  repository: ResolvedRepository,
  now: string,
): Promise<ReturnType<typeof classifyResume>> {
  const observed = await observeRuntime(runGitCommand, state);
  return classifyResume(state, observed, {
    now,
    authEvidence: provenAuthEvidence(),
    repository: { id: repository.id, root: repository.root, defaultBranch: repository.defaultBranch },
    taskId: TASK_ID,
  });
}

/**
 * A Git seam that refuses one family of command and passes the rest through.
 *
 * `UNAVAILABLE`, not `NONZERO_EXIT`: the condition being modelled is "Git could
 * not be asked", which is what a settlement has to fail closed on. A non-zero
 * exit is Git *answering*, and several of the commands here answer questions
 * with their exit status.
 */
function gitFailing(
  match: (args: readonly string[]) => boolean,
  options: { readonly after?: number } = {},
): GitRunner {
  let seen = 0;
  const after = options.after ?? 0;
  return async (cwd, args) => {
    if (match(args)) {
      seen += 1;
      if (seen > after) {
        return Object.freeze({ outcome: 'UNAVAILABLE' as const, stdout: '', exitCode: null });
      }
    }
    return runGitCommand(cwd, args);
  };
}

/* ───────────────────────── §13 partial in-scope work ─────────────────────── */

describe('a quota interruption over in-scope partial work is settled to a checkpoint', () => {
  it('recognises the limit, scopes the effect, commits it, and records the exact HEAD', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    const before = headOf(worktreePath);

    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/partial.ts', `export const partial = 1;${NEWLINE}`),
    });
    const step = await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    // 1–2. The limit was recognised and the scope gate ran on the real effect.
    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(step.scope?.verdict).toBe('WITHIN_SCOPE');
    expect(step.scope?.approvedPaths).toEqual(['src/partial.ts']);

    // 3. AO owns the commit, and it is a real object with a moved HEAD.
    expect(step.commit?.outcome).toBe('COMMITTED');
    const checkpoint = headOf(worktreePath);
    expect(checkpoint).not.toBe(before);

    // 4–5. The tree is settled and the recorded HEAD is the one Git reports.
    expect(git(worktreePath, ['status', '--porcelain']).trim()).toBe('');
    const blocked = reload(root).state;
    expect(blocked.currentCommit).toBe(checkpoint);
    expect(blocked.worktreeCleanAtCheckpoint).toBe(true);

    // 6–7. Still a block, at the exact phase and round that was interrupted.
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.blockedAgent).toBe('claude');
    expect(blocked.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });

    // 8. A checkpoint is not a pass. Nothing advanced, and no budget was spent.
    expect(blocked.state).not.toBe('VERIFYING');
    expect(blocked.reviewRound).toBe(current.state.reviewRound);
    expect(blocked.maxReviewRounds).toBe(current.state.maxReviewRounds);
    expect(blocked.basePinnedCommit).toBe(current.state.basePinnedCommit);
    expect(blocked.findingHistory).toEqual(current.state.findingHistory);
    expect(blocked.workBranch).toBe(current.state.workBranch);
    expect(blocked.scopeAuthorityCommit).toBe(current.state.scopeAuthorityCommit);
  });

  it('is the writer AO commits for — the object carries AO identity, not the agent', async () => {
    const { repository, current, worktreePath } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/partial.ts', `export const partial = 1;${NEWLINE}`),
    });
    await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    expect(git(worktreePath, ['log', '-1', '--format=%an']).trim()).toBe('AgentOrchestrator');
    expect(git(worktreePath, ['log', '-1', '--format=%ae']).trim()).toBe(
      'agent-orchestrator@local.invalid',
    );
    // The message names the pass, and says nothing about an outcome. No CLI
    // text, no reset time, no account information.
    expect(git(worktreePath, ['log', '-1', '--format=%s']).trim()).toBe(`AO:${TASK_ID}:IMPLEMENT:r1`);
  });

  /**
   * The primary F-10 acceptance criterion (§12), and the reason the suite
   * exists. Before `T` the only thing standing between this block and an
   * unattended resume must be the clock.
   */
  it('denies with exactly [RESET_TIME_NOT_REACHED] before T, and allows after it', async () => {
    const { repository, root, current } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/partial.ts', `export const partial = 1;${NEWLINE}`),
    });
    await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));
    releaseTestLeases();

    const produced = reload(root).state;
    const waiting = withSyntheticReset(produced, T);

    const before = await decide(waiting, repository, BEFORE_T);
    expect(before.automaticResume?.allowed).toBe(false);
    expect(before.automaticResume?.reasonCodes).toEqual(['RESET_TIME_NOT_REACHED']);
    expect(before.reconciliation.findings).toEqual([]);

    const after = await decide(waiting, repository, AFTER_T);
    expect(after.automaticResume?.reasonCodes).toEqual([]);
    expect(after.continuation).toBe('AUTOMATIC_ALLOWED');
    expect(after.classification).toBe('AUTOMATIC_RESUME_ALLOWED');
  });
});

/* ─────────────────────────── §14 no repository delta ─────────────────────── */

describe('a quota interruption that changed nothing needs no fake work', () => {
  it('records the existing HEAD without manufacturing an empty commit', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    const before = headOf(worktreePath);
    const countBefore = git(worktreePath, ['rev-list', '--count', 'HEAD']).trim();

    const agent = recordedAgent({ claude: () => usageLimitResult() });
    const step = await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(step.commit?.outcome).toBe('NOTHING_TO_COMMIT');
    // No commit was made: HEAD is where it was, and the history is the same
    // length. The second half is what catches an `--allow-empty` that happened
    // to be reverted by a later step.
    expect(headOf(worktreePath)).toBe(before);
    expect(git(worktreePath, ['rev-list', '--count', 'HEAD']).trim()).toBe(countBefore);

    const blocked = reload(root).state;
    expect(blocked.currentCommit).toBe(before);
    expect(blocked.worktreeCleanAtCheckpoint).toBe(true);
    expect(blocked.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });
  });

  it('is resumable on the clock alone, exactly as a partial one is', async () => {
    const { repository, root, current } = await implementing();
    const agent = recordedAgent({ claude: () => usageLimitResult() });
    await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));
    releaseTestLeases();

    const waiting = withSyntheticReset(reload(root).state, T);
    expect((await decide(waiting, repository, BEFORE_T)).automaticResume?.reasonCodes).toEqual([
      'RESET_TIME_NOT_REACHED',
    ]);
    expect((await decide(waiting, repository, AFTER_T)).continuation).toBe('AUTOMATIC_ALLOWED');
  });
});

/* ────────────────────────── §15 scope outranks quota ─────────────────────── */

describe('a quota response never hides what the writer did to the repository', () => {
  it('records SCOPE_VIOLATION, not a quota pause, when the partial work escaped', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('docs/escaped.md', `outside${NEWLINE}`),
    });
    const step = await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(step.scope?.verdict).toBe('VIOLATION');
    // Nothing was committed as a "safe" checkpoint, and the evidence is left
    // exactly where the writer put it.
    expect(step.commit).toBeNull();
    expect(git(worktreePath, ['status', '--porcelain']).trim()).not.toBe('');

    const blocked = reload(root).state;
    expect(blocked.state).toBe('SCOPE_VIOLATION');
    expect(blocked.blockedAgent).toBe('claude');
    // Not continuable, so it carries no re-entry point and no checkpoint claim.
    expect(blocked.resumeFrom).toBeNull();
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('never becomes automatically resumable, whatever the clock says', async () => {
    const { repository, root, current } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('docs/escaped.md', `outside${NEWLINE}`),
    });
    await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));
    releaseTestLeases();

    // `SCOPE_VIOLATION` cannot carry a reset time at all, so the clock is asked
    // against the state as production wrote it.
    const decision = await decide(reload(root).state, repository, AFTER_T);
    expect(decision.continuation).not.toBe('AUTOMATIC_ALLOWED');
    expect(decision.classification).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('fails closed when the scope of the effect cannot be established', async () => {
    const { repository, root, current } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/partial.ts', `export const partial = 1;${NEWLINE}`),
    });
    // The delta probe answers for PRE-SCOPE and then stops answering, so the
    // writer really runs and it is the **post**-writer assessment that has no
    // verdict. Failing it from the first call would park the task before the
    // writer ever started — this case would then pass while measuring the
    // pre-writer gate, which is not what it claims.
    const blindAfterPreScope = gitFailing((args) => args.includes('diff'), { after: 1 });
    const step = await runImplementStep(
      current,
      stepDeps(current, repository, { agent: agent.runner, git: blindAfterPreScope }),
    );
    expect(agent.countFor('claude')).toBe(1);

    expect(step.scope?.verdict).toBe('INDETERMINATE');
    // Nothing was committed on an assessment that approved nothing — which is
    // the fail-closed half, and the one §15 requires.
    expect(step.commit).toBeNull();

    const blocked = reload(root).state;
    // Still a quota pause, and this is where the quota path deliberately
    // differs from the completed-writer path. `enforceScope` parks an
    // indeterminate tree at `HUMAN_DECISION_REQUIRED`, which clears
    // `reportedResetAt` — spending the one fact that *is* known, because
    // `git diff` would not answer. Here the block keeps saying why the task
    // stopped, and denies the resume with its withdrawn claims instead.
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);

    releaseTestLeases();
    const waiting = withSyntheticReset(blocked, T);
    expect((await decide(waiting, repository, AFTER_T)).continuation).not.toBe('AUTOMATIC_ALLOWED');
  });

  it('still parks an indeterminate scope for a writer that COMPLETED', async () => {
    const { repository, root, current } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEdits('src/done.ts', `export const done = true;${NEWLINE}`),
    });
    const blindAfterPreScope = gitFailing((args) => args.includes('diff'), { after: 1 });
    const step = await runImplementStep(
      current,
      stepDeps(current, repository, { agent: agent.runner, git: blindAfterPreScope }),
    );

    // The control for the case above: nothing else holds a completed pass, so a
    // human has to look. The asymmetry is about the quota fact, not about scope.
    expect(agent.countFor('claude')).toBe(1);
    expect(step.scope?.verdict).toBe('INDETERMINATE');
    expect(reload(root).state.state).toBe('HUMAN_DECISION_REQUIRED');
  });
});

/* ───────────────────── §16 every settlement failure is closed ────────────── */

describe('a settlement that cannot be proven leaves the block denying', () => {
  /**
   * Each case breaks one step of the settlement and requires the same two
   * things: the quota fact survives, and the checkpoint does not.
   *
   * `BLOCKED_USAGE_LIMIT` with the claims withdrawn is what this build wrote
   * before V3-10, so every failure here degrades to the previously proven
   * behaviour rather than to something new — and `evaluateAutomaticResume`
   * denies it on `CURRENT_COMMIT_MISMATCH` and `WORKTREE_NOT_CLEAN` even with a
   * reset time that has passed.
   */
  it.each([
    [
      'the commit cannot be made',
      gitFailing((args) => args.includes('commit')),
    ],
    [
      'HEAD cannot be observed afterwards',
      // `--end-of-options` is what distinguishes the two `rev-parse HEAD` calls
      // in this flow. `commitTaskWork` reads HEAD with a bare `['rev-parse',
      // 'HEAD']`, so a seam matching on the command name alone breaks *that*
      // call first and this case becomes a second copy of "the commit cannot be
      // made" — the post-settlement observation is then never reached at all. A
      // review caught exactly that.
      gitFailing((args) => args[0] === 'rev-parse' && args.includes('--end-of-options')),
    ],
    [
      'cleanliness cannot be observed afterwards',
      // Only the *post-settlement* observation: `commitTaskWork`'s own effect
      // gate uses `-z`, so this leaves the commit itself working and breaks the
      // measurement that follows it.
      gitFailing((args) => args[0] === 'status' && !args.includes('-z')),
    ],
  ])('denies an unattended resume when %s', async (_label, git_) => {
    const { repository, root, current } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/partial.ts', `export const partial = 1;${NEWLINE}`),
    });
    const step = await runImplementStep(
      current,
      stepDeps(current, repository, { agent: agent.runner, git: git_ }),
    );

    expect(step.state).toBe('BLOCKED_USAGE_LIMIT');
    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    // The quota fact is not lost — this is still a pause, with its resume point.
    expect(blocked.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });
    // And no claim was made that was not established.
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);

    releaseTestLeases();
    const waiting = withSyntheticReset(blocked, T);
    const decision = await decide(waiting, repository, AFTER_T);
    expect(decision.continuation).not.toBe('AUTOMATIC_ALLOWED');

    // Fixed, not derived from the result. An expectation computed from the
    // value under test passes for either shape, so it would not notice a case
    // silently changing which refusal it exercises.
    //
    // Reconciliation is `CONSISTENT` in all three, and that is the point rather
    // than a weakness: a withdrawn checkpoint *accounts for* whatever the tree
    // holds — `worktreeCleanAtCheckpoint: false` is exactly the record that
    // stops a dirty tree being a contradiction. So the world agrees with the
    // record, no divergence hides the result, and the refusal has to come from
    // the unattended authority itself, naming both withdrawn claims. That is
    // the property this slice must not lose, measured with nothing else in
    // front of it.
    expect(decision.reconciliation.verdict).toBe('CONSISTENT');
    expect(decision.classification).toBe('AUTOMATIC_RESUME_REFUSED');
    expect(decision.automaticResume?.reasonCodes).toContain('CURRENT_COMMIT_MISMATCH');
    expect(decision.automaticResume?.reasonCodes).toContain('WORKTREE_NOT_CLEAN');
  });

  it('refuses to settle a target repository whose configuration would run code', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    // A clean filter Git would execute for the path being staged.
    git(worktreePath, ['config', '--local', 'filter.probe.clean', 'node -e ""']);
    git(worktreePath, ['config', '--local', 'filter.probe.process', 'node -e ""']);
    // Inside `src`, because the file itself joins the writer's delta and a
    // root-level one would be an out-of-scope path — a different refusal, and
    // one that would never reach the commit this case is about.
    writeRepoFile(worktreePath, 'src/.gitattributes', 'partial.ts filter=probe\n');

    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/partial.ts', `export const partial = 1;${NEWLINE}`),
    });
    const step = await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    expect(step.commit?.outcome).toBe('TARGET_CONFIG_EXECUTES_CODE');
    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('commits nothing and records nothing when the lease is lost mid-step', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    const before = headOf(worktreePath);

    // The lease has to be **valid while the writer runs and gone afterwards**.
    // Releasing it before the step instead would make `leasedAgent` refuse to
    // start the writer at all: the tree would stay untouched, nothing would be
    // settled, and the case would pass having measured a step that never
    // reached the settlement. So it is given back from inside the writer, which
    // is also what a real lease loss looks like — minutes of subprocess time
    // after the step began.
    const writer = writerThatEditsThenHitsUsageLimit(
      'src/partial.ts',
      `export const partial = 1;${NEWLINE}`,
    );
    const agent = recordedAgent({
      claude: (call) => {
        const result = writer(call);
        releaseTestLeases();
        return result;
      },
    });

    const step = await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));
    expect(agent.countFor('claude')).toBe(1);
    expect(step.outcome).toBe('STATE_NOT_RECORDED');

    // Positive assertions, because "not ADVANCED" and "currentCommit is null"
    // are both already true of the state this step started from — an earlier
    // version of this case would have passed had the step done nothing at all.
    // What has to be shown is that the *effects* were refused: no object
    // entered the repository, the writer's work is still there as evidence, and
    // the durable record never moved.
    expect(step.commit?.outcome).toBe('GIT_UNAVAILABLE');
    expect(headOf(worktreePath)).toBe(before);
    expect(git(worktreePath, ['status', '--porcelain']).trim()).not.toBe('');

    const after = reload(root);
    expect(after.state.state).toBe('IMPLEMENTING');
    expect(after.revision).toBe(current.revision);
  });
});

/* ─────────────── §17 nothing may have moved while the task waited ────────── */

describe('a checkpoint is a claim about the world, re-checked before anything resumes', () => {
  async function checkpointed(): Promise<{
    repository: ResolvedRepository;
    root: string;
    worktreePath: string;
    waiting: TaskState;
  }> {
    const { repository, root, current, worktreePath } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEditsThenHitsUsageLimit('src/partial.ts', `export const partial = 1;${NEWLINE}`),
    });
    await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));
    releaseTestLeases();
    const waiting = withSyntheticReset(reload(root).state, T);
    // The control: as it stands, this really would resume.
    expect((await decide(waiting, repository, AFTER_T)).continuation).toBe('AUTOMATIC_ALLOWED');
    return { repository, root, worktreePath, waiting };
  }

  it('refuses after HEAD moved while the task was paused', async () => {
    const { repository, worktreePath, waiting } = await checkpointed();
    git(worktreePath, ['commit', '--allow-empty', '--quiet', '-m', 'somebody-else']);

    const decision = await decide(waiting, repository, AFTER_T);
    expect(decision.continuation).toBe('BLOCKED');
    expect(decision.classification).toBe('STATE_DIVERGED');
    expect(decision.reconciliation.findings).toContain('CURRENT_COMMIT_MOVED');
  });

  it('refuses after a tracked file was modified while the task was paused', async () => {
    const { repository, worktreePath, waiting } = await checkpointed();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(worktreePath, 'src/partial.ts'), 'export const tampered = 2;\n', 'utf8');

    const decision = await decide(waiting, repository, AFTER_T);
    expect(decision.continuation).toBe('BLOCKED');
    expect(decision.reconciliation.findings).toContain('WORKTREE_DIRTY');
  });

  it('refuses after an untracked file appeared while the task was paused', async () => {
    const { repository, worktreePath, waiting } = await checkpointed();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(worktreePath, 'src/appeared.ts'), 'export const appeared = 3;\n', 'utf8');

    const decision = await decide(waiting, repository, AFTER_T);
    expect(decision.continuation).toBe('BLOCKED');
    expect(decision.reconciliation.findings).toContain('WORKTREE_DIRTY');
  });

  it('refuses after the worktree disappeared', async () => {
    const { repository, worktreePath, waiting } = await checkpointed();
    rmSync(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    expect(existsSync(worktreePath)).toBe(false);

    const decision = await decide(waiting, repository, AFTER_T);
    expect(decision.continuation).toBe('BLOCKED');
    expect(decision.classification).toBe('STATE_DIVERGED');
  });
});

/* ────────────── §18/§19 nothing else about a writer's ending moved ───────── */

describe('only a positively recognised usage limit is settled', () => {
  it.each([
    ['a non-zero exit', { exitCode: 3, stdout: '' }],
    ['output that is not a result envelope', { exitCode: 0, stdout: 'not json at all' }],
    ['a run that was killed from outside', { exitCode: null, signal: 'SIGKILL' as const }],
  ])('does not checkpoint %s', async (_label, overrides) => {
    const { repository, root, current, worktreePath } = await implementing();
    const before = headOf(worktreePath);
    const { agentCommandResult } = await import('./fixtures.js');

    const agent = recordedAgent({
      claude: (call) => {
        writeRepoFile(call.cwd, 'src/partial.ts', `export const partial = 1;${NEWLINE}`);
        return agentCommandResult(overrides);
      },
    });
    const step = await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    // No commit was attempted, and the writer's work is left as evidence.
    expect(step.commit).toBeNull();
    expect(headOf(worktreePath)).toBe(before);
    expect(git(worktreePath, ['status', '--porcelain']).trim()).not.toBe('');

    const blocked = reload(root).state;
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('leaves a completed writer on its own path, unchanged', async () => {
    const { repository, root, current, worktreePath } = await implementing();
    const agent = recordedAgent({
      claude: writerThatEdits('src/done.ts', `export const done = true;${NEWLINE}`),
    });
    const step = await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('VERIFYING');
    expect(step.commit?.outcome).toBe('COMMITTED');

    // A completed pass still leaves verification to settle the checkpoint: it
    // did not become a quota block, and it did not acquire a checkpoint either.
    const verifying = reload(root).state;
    expect(verifying.currentCommit).toBeNull();
    expect(verifying.worktreeCleanAtCheckpoint).toBe(false);
    expect(git(worktreePath, ['status', '--porcelain']).trim()).toBe('');
  });

  it('still parks a completed writer that changed nothing', async () => {
    const { repository, root, current } = await implementing();
    const agent = recordedAgent({ claude: () => writerSuccess() });
    const step = await runImplementStep(current, stepDeps(current, repository, { agent: agent.runner }));

    // The asymmetry V3-10 introduces is deliberate and lives here: an
    // interrupted writer that changed nothing is a pause; a *completed* writer
    // that changed nothing is still inadmissible.
    expect(step.commit?.outcome).toBe('NOTHING_TO_COMMIT');
    expect(reload(root).state.state).toBe('HUMAN_DECISION_REQUIRED');
  });
});

/* ──────────────────────── the checkpoint cannot be forged ────────────────── */

describe('checkpoint evidence can only be produced, never asserted', () => {
  const SHA = 'a'.repeat(40);

  it('mints nothing without a positive observation of both facts', () => {
    expect(mintInterruptionCheckpoint({ observedCommit: SHA, worktreeClean: false })).toBeNull();
    // The one that matters: "Git was not asked" must never read as "clean".
    expect(mintInterruptionCheckpoint({ observedCommit: SHA, worktreeClean: null })).toBeNull();
    expect(mintInterruptionCheckpoint({ observedCommit: null, worktreeClean: true })).toBeNull();
    expect(mintInterruptionCheckpoint({ observedCommit: '', worktreeClean: true })).toBeNull();
    // Not a full object name: refused here rather than at the state contract.
    expect(mintInterruptionCheckpoint({ observedCommit: 'abc', worktreeClean: true })).toBeNull();
    expect(mintInterruptionCheckpoint({ observedCommit: SHA.toUpperCase(), worktreeClean: true })).toBeNull();
    expect(mintInterruptionCheckpoint({ observedCommit: SHA, worktreeClean: true })).not.toBeNull();
  });

  it('refuses a literal, a cast and a prototype forgery alike', () => {
    const genuine = mintInterruptionCheckpoint({ observedCommit: SHA, worktreeClean: true });
    expect(isInterruptionCheckpoint(genuine)).toBe(true);
    expect(interruptionCheckpointCommitOf(genuine)).toBe(SHA);

    // Route 1: write the artefact down. Not evidence, and the cast is on the
    // call rather than on a fabricated value, because there is nothing to build.
    expect(isInterruptionCheckpoint({ commit: SHA })).toBe(false);
    expect(interruptionCheckpointCommitOf({ commit: SHA, clean: true })).toBeNull();

    // Route 2: cast. No type system stops it, so the runtime gate must.
    const cast = { commit: SHA } as unknown as InterruptionCheckpoint;
    expect(isInterruptionCheckpoint(cast)).toBe(false);
    expect(interruptionCheckpointCommitOf(cast)).toBeNull();

    // Route 3: reach the class through a genuine artefact, with no import of
    // the mint at all. This is how the class was reached against this
    // codebase's earlier opaque artefacts, and it is closed twice over — the
    // deleted `constructor` means the lookup no longer finds the class (route 4
    // asserts that directly), and the registry would refuse the result anyway.
    //
    // Both halves are kept: `Object.create` on the prototype is still a genuine
    // route to an object `instanceof` would accept, and it is refused.
    if (genuine === null) expect.unreachable();
    const Constructor = Object.getPrototypeOf(genuine).constructor as new (c: string) => unknown;
    expect(isInterruptionCheckpoint(new Constructor(SHA))).toBe(false);
    const created = Object.create(Object.getPrototypeOf(genuine)) as unknown;
    expect(created).toBeInstanceOf(Proof);
    expect(isInterruptionCheckpoint(created)).toBe(false);
    expect(interruptionCheckpointCommitOf(created)).toBeNull();

    // Route 4: turn the gate off process-wide instead of getting past it.
    //
    // This is the route that mattered. `execution-lease-evidence.ts` records
    // `ExecutionLeaseProof.holds = () => true` as how an adversarial review
    // disabled that artefact's gate once it had reached the class — and the
    // class is reachable from any genuine artefact, above, with no import. Two
    // assignments here would make `recordAgentInterruption` write an
    // unattended-resume grant for a repository nobody looked at.
    //
    // The class and its prototype are frozen, so both throw in strict mode
    // (which every ESM module is). An earlier version of this file shipped
    // without the freeze while its header claimed parity with its siblings.
    // First: the class is not reachable from an artefact at all any more.
    // `Reflect.deleteProperty(prototype, 'constructor')` means the lookup walks
    // past it to `Object`, so the no-import route to the class is closed.
    expect(Object.getPrototypeOf(genuine).constructor).not.toBe(Proof);

    // And with the class in hand — which needs the internal import this test
    // deliberately has — the statics cannot be replaced.
    const gate = Proof as unknown as Record<string, unknown>;
    expect(() => {
      gate['holds'] = (): boolean => true;
    }).toThrow(TypeError);
    expect(() => {
      gate['commitOf'] = (): string => 'f'.repeat(40);
    }).toThrow(TypeError);
    expect(Object.isFrozen(Proof)).toBe(true);
    expect(Object.isFrozen(Proof.prototype)).toBe(true);

    // The gate still answers truthfully afterwards.
    expect(isInterruptionCheckpoint({ commit: SHA })).toBe(false);
    expect(isInterruptionCheckpoint(genuine)).toBe(true);
  });

  it('withdraws the checkpoint for a forged artefact exactly as for an absent one', async () => {
    const { repository, root, current } = await implementing();
    const forged = { commit: 'b'.repeat(40) } as unknown as InterruptionCheckpoint;

    const record = recordAgentInterruption(
      current,
      {
        disposition: 'AGENT_BLOCKED_USAGE_LIMIT',
        block: { blockedAgent: 'claude', resumeFrom: { phase: 'IMPLEMENT', round: 1 }, reportedResetAt: null },
      },
      {
        now: '2026-08-22T11:00:00.000Z',
        fallback: { blockedAgent: 'claude', resumeFrom: { phase: 'IMPLEMENT', round: 1 }, reportedResetAt: null },
        checkpoint: forged,
        lease: leaseAuthorityFor(repository),
      },
    );
    expect(record.outcome).toBe('PAUSED_USAGE_LIMIT');

    const blocked = reload(root).state;
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  it('refuses a genuine checkpoint for a block that is not a usage limit', async () => {
    const { repository, root, current } = await implementing();
    const genuine = mintInterruptionCheckpoint({
      observedCommit: current.state.basePinnedCommit,
      worktreeClean: true,
    });
    expect(genuine).not.toBeNull();

    recordAgentInterruption(
      current,
      {
        disposition: 'AGENT_BLOCKED_AUTH',
        block: { blockedAgent: 'claude', resumeFrom: { phase: 'IMPLEMENT', round: 1 }, reportedResetAt: null },
      },
      {
        now: '2026-08-22T11:00:00.000Z',
        fallback: { blockedAgent: 'claude', resumeFrom: { phase: 'IMPLEMENT', round: 1 }, reportedResetAt: null },
        checkpoint: genuine,
        lease: leaseAuthorityFor(repository),
      },
    );

    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_AUTH');
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  /**
   * This case pinned the opposite behaviour until M2 slice 6, and the reason it
   * changed is worth keeping.
   *
   * It read: *a checkpoint offered for `REVIEWING` could only overwrite a true
   * checkpoint the read-only reviewer could not have invalidated, so refuse it.*
   * Its own sharpening assertion is what refuted it — `carried` is `null`,
   * because the write into `VERIFYING` withdrew it and `REVIEWING` restores
   * nothing. There was no true checkpoint to protect. What the refusal actually
   * did was leave every codex quota block denied by `evaluateAutomaticResume`
   * with `CURRENT_COMMIT_MISMATCH` and `WORKTREE_NOT_CLEAN` — F-10, on the phase
   * F-10 could not reach, because no codex quota block could be produced at all
   * until slice 6 produced one.
   *
   * **No safety moved with it.** The property this suite is about is that a
   * checkpoint cannot be *written down*, only minted from an observation, and
   * that the mint has exactly one importer in `src/` — the case below still
   * pins both. `phaseMutatesRepository` was never what made the artefact
   * trustworthy; it only decided which phases were allowed to offer one.
   */
  it('records a genuine checkpoint for a read-only phase that measured one', async () => {
    const { repository, root } = await implementing();
    const reviewing = await driveTo(repository, root, 'REVIEWING');
    const observed = headOf(reviewing.state.worktreePath);
    const genuine = mintInterruptionCheckpoint({
      observedCommit: observed,
      worktreeClean: true,
    });
    expect(genuine).not.toBeNull();

    // The shape the slice inherits, restated here so the case cannot silently
    // become weak: both checkpoint facts are already withdrawn on arrival.
    expect(reviewing.state.currentCommit).toBeNull();
    expect(reviewing.state.worktreeCleanAtCheckpoint).toBe(false);

    const record = recordAgentInterruption(
      reviewing,
      {
        disposition: 'AGENT_BLOCKED_USAGE_LIMIT',
        block: { blockedAgent: 'codex', resumeFrom: { phase: 'REVIEW', round: 1 }, reportedResetAt: null },
      },
      {
        now: '2026-08-22T11:00:00.000Z',
        fallback: { blockedAgent: 'codex', resumeFrom: { phase: 'REVIEW', round: 1 }, reportedResetAt: null },
        checkpoint: genuine,
        lease: leaseAuthorityFor(repository),
      },
    );
    expect(record.outcome).toBe('PAUSED_USAGE_LIMIT');

    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.currentCommit).toBe(observed);
    expect(blocked.worktreeCleanAtCheckpoint).toBe(true);
  });

  it('still refuses a forged checkpoint for that same read-only phase', async () => {
    const { repository, root } = await implementing();
    const reviewing = await driveTo(repository, root, 'REVIEWING');
    const observed = headOf(reviewing.state.worktreePath);

    // Shaped exactly like a genuine one and never minted. Widening the gate to
    // read-only phases must not have widened what counts as evidence for them.
    const forged = { commit: observed, clean: true } as unknown as InterruptionCheckpoint;

    recordAgentInterruption(
      reviewing,
      {
        disposition: 'AGENT_BLOCKED_USAGE_LIMIT',
        block: { blockedAgent: 'codex', resumeFrom: { phase: 'REVIEW', round: 1 }, reportedResetAt: null },
      },
      {
        now: '2026-08-22T11:00:00.000Z',
        fallback: { blockedAgent: 'codex', resumeFrom: { phase: 'REVIEW', round: 1 }, reportedResetAt: null },
        checkpoint: forged,
        lease: leaseAuthorityFor(repository),
      },
    );

    const blocked = reload(root).state;
    expect(blocked.state).toBe('BLOCKED_USAGE_LIMIT');
    expect(blocked.currentCommit).toBeNull();
    expect(blocked.worktreeCleanAtCheckpoint).toBe(false);
  });

  /**
   * The reachability claim the whole design rests on: exactly one module in
   * `src/` may import the mint. Asserted structurally, the same way
   * `tests/auth-preflight-evidence.test.ts` and `tests/internal-api.test.ts`
   * keep their own producers singular — a second producer would make every case
   * above a statement about only one of them.
   */
  it('is minted from exactly one module in src/', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
      }
    };
    walk(join(PACKAGE_ROOT, 'src'));

    // The *mint*, not the module: `core/interruption-checkpoint.ts` legitimately
    // imports the class from the same file in order to alias the public type,
    // and gives no caller a way to produce one.
    const importers = files
      .filter((file) => !file.endsWith(join('internal', 'interruption-checkpoint.ts')))
      .filter((file) => readFileSync(file, 'utf8').includes('mintInterruptionCheckpoint'))
      .map((file) => relative(PACKAGE_ROOT, file));

    expect(importers).toEqual([join('src', 'loop', 'loop-step.ts')]);
    // And no module re-exports it, which would make the mint reachable anyway.
    const reexporters = files
      .filter((file) => !file.includes(`${sep}internal${sep}`))
      .filter((file) => /export\s*\{[^}]*mintInterruptionCheckpoint/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PACKAGE_ROOT, file));
    expect(reexporters).toEqual([]);
  });
});
