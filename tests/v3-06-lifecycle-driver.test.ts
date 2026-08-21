/**
 * V3 slice 6 — the unattended lifecycle driver.
 *
 * ── What this file may and may not test ────────────────────────────────────
 *
 * The slice was planned against a stale comment claiming AO had no resume
 * runner. It has had one since V2-04, so most of the original brief's test list
 * describes behaviour that already ships and is already covered:
 * reconciliation before execution, the reload after every step, the
 * automatic-resume evidence gate, per-phase crash continuation and the review
 * budget all live in `run-driver.ts` and `loop-step.ts` and are pinned by
 * `tests/run-driver.test.ts` and `tests/v1-08-e2e.test.ts`. Re-testing them
 * through this layer would not make them safer; it would make two suites that
 * can disagree about whose behaviour it is.
 *
 * So this file tests the three things that genuinely did not exist, plus the
 * minimum needed to prove the thin layer *delegates* rather than reimplements:
 *
 *  1. the lease phase — acquire, and on the one refusal that can mean "the
 *     holder is gone", recover once and then acquire *again*, ordinarily;
 *  2. the loop across invocations, and its refusal to spin;
 *  3. the release, whose result every pre-existing call site discarded.
 *
 * A fourth — waiting out a recorded quota reset — was withdrawn from the slice
 * because it cannot be built without an authority this product has not granted.
 * What is tested about it is the refusal: a quota block stops the run. See
 * `run/lifecycle-driver.ts` and `README.md` `L-V3-06-2`.
 *
 * ── The shape every case here is written against ───────────────────────────
 *
 * An outer loop is where the layers below it get used without being asked
 * again. The three ways that happens, and the cases that attack each:
 *
 *  A. **Believing an invocation's account of itself.** `STEP_BUDGET_EXHAUSTED`
 *     is a *claim* of durable progress. A loop that re-enters on the claim
 *     rather than on the file having moved is a spin that reports work.
 *  B. **Treating a removal as a grant.** Recovering a dead lease removes an
 *     object. It does not make this process the writer, and the acquisition
 *     that follows is allowed to lose.
 *  C. **Reporting a clean shutdown over an unexplained lease.** A release whose
 *     result nobody reads is a release nobody performed, as far as an operator
 *     can tell — and a release skipped on a throw leaves this *live* process
 *     holding it, which no recovery can clear.
 *
 * Real repositories, real worktrees, real Git and a real execution lease. The
 * agent and verification seams are recorded stand-ins, because the real ones
 * spend subscription quota; every other seam is the product's own.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  LIFECYCLE_FOR_RUN,
  LIFECYCLE_OUTCOMES,
  driveLifecycle,
  type LifecycleOutcome,
  type LifecycleDependencies,
  type LifecycleRequest,
} from '../src/run/lifecycle-driver.js';
import { RUN_OUTCOMES } from '../src/run/run-driver.js';
import {
  LIFECYCLE_OUTCOME_SENTENCES,
  LIFECYCLE_TRAILER,
  renderLifecycleRun,
} from '../src/cli/render-lifecycle.js';
import {
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  releaseRepositoryExecutionLease,
  type LeaseRepository,
} from '../src/lease/execution-lease.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';
import {
  e2eProfile,
  reviewResult,
  recordedAgent,
  recordedVerify,
  reload,
  seedDeliveredState,
  startTask,
  tickingClock,
  usageLimitResult,
  writerSuccess,
  type RecordedAgent,
  type RecordedVerify,
  type StartedTask,
} from './helpers/e2e-fixtures.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { passingReview } from './fixtures.js';

const TASK_ID = 'V3-06';

afterEach(() => {
  releaseTestLeases();
});

afterAll(() => {
  removeTrackedWorkspaces();
  removeRepoFixtures();
});

/* ─────────────────────────────── harness ────────────────────────────────── */

interface Scenario {
  readonly started: StartedTask;
  readonly agent: RecordedAgent;
  readonly verify: RecordedVerify;
  readonly request: (overrides?: Partial<LifecycleRequest>) => LifecycleRequest;
  readonly deps: () => LifecycleDependencies;
}

/**
 * A started task with durable state, and the lease **given back**.
 *
 * The release is the load-bearing line. `startTask` prepares a real worktree and
 * takes a real lease to do it, and that lease is this process's. Leaving it held
 * would make every case here `LIVE_OWNER_PRESENT` — a suite that measured its own
 * fixture instead of its subject.
 */
async function scenario(
  options: {
    readonly stateOverrides?: Parameters<typeof seedDeliveredState>[1];
    readonly agent?: Parameters<typeof recordedAgent>[0];
    readonly verify?: Parameters<typeof recordedVerify>[0];
    readonly maxReviewRounds?: number;
  } = {},
): Promise<Scenario> {
  const started = await startTask({
    taskId: TASK_ID,
    ...(options.maxReviewRounds !== undefined
      ? { profile: e2eProfile({ maxReviewRounds: options.maxReviewRounds }) }
      : {}),
  });
  seedDeliveredState(started, options.stateOverrides ?? {});
  releaseTestLeases();

  const agent = recordedAgent(
    options.agent ?? {
      claude: () => writerSuccess(),
      codex: () => reviewResult(passingReview()),
    },
  );
  const verify = recordedVerify(options.verify);

  return {
    started,
    agent,
    verify,
    request: (overrides = {}) => ({
      repository: started.repository,
      taskId: TASK_ID,
      continuationGrant: true,
      recoverStaleLease: false,
      maxSteps: 8,
      maxInvocations: 1,
      ...overrides,
    }),
    deps: () => ({
      now: tickingClock(),
      git: runGitCommand,
      // Memoised, exactly like `onceOnlyPreflight`: one artefact for the whole
      // run, however many invocations it makes.
      authPreflight: (() => {
        let evidence: ReturnType<typeof provenAuthEvidence> | null = null;
        return async () => {
          evidence ??= provenAuthEvidence();
          return evidence;
        };
      })(),
      agent: agent.runner,
      verify: verify.runner,
    }),
  };
}

/** The lease path of a repository, or a loud failure. */
function leasePathOf(repository: LeaseRepository): string {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return location.path;
}

/**
 * A lease whose recorded owner is a process id nothing is running under.
 *
 * Built the way `tests/v3-05-stale-lease-recovery.test.ts` builds one: take the
 * real lease, keep its bytes, give it back, and write them again with a dead
 * owner. Nothing is fabricated except the one field that makes it stale.
 *
 * No writer-launch ledger is created, so `recoverStaleLease` **refuses** this
 * one — `LAUNCH_HISTORY_ABSENT`. That is deliberate: the safely-recoverable case
 * needs a real contained launch under a real dead process, which cannot be
 * staged inside a vitest worker, and is measured against the shipped artefact in
 * `tests/dist-artifact/lifecycle-restart-dist-artifact.mjs` instead.
 */
function staleLeaseAt(repository: LeaseRepository): void {
  const path = leasePathOf(repository);
  const evidence = leaseFor(repository);
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  releaseTestLeases();
  releaseRepositoryExecutionLease(evidence);
  writeFileSync(
    path,
    `${JSON.stringify({ ...document, ownerPid: deadProcessId() }, null, 2)}\n`,
    'utf8',
  );
}

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

/** Asserts the driver spawned nothing at all. */
function expectNothingExecuted(scene: Scenario): void {
  expect(scene.agent.calls).toEqual([]);
  expect(scene.verify.calls).toEqual([]);
}

/* ══════════════ 1. the lease phase, which did not exist ══════════════════ */

describe('the lease is taken before anything runs, and given back after', () => {
  it('acquires a free lease, drives the task, and releases provably', async () => {
    const scene = await scenario();

    const result = await driveLifecycle(scene.request(), scene.deps());

    expect(result.acquire).toBeNull();
    expect(result.recovery).toBeNull();
    expect(result.release?.code).toBe('RELEASED');
    expect(result.invocations).toBe(1);
    // The lease really is gone from disk, not merely reported as released.
    expect(() => readFileSync(leasePathOf(scene.started.repository), 'utf8')).toThrow();
  });

  it('runs nothing at all while a live owner holds the lease', async () => {
    const scene = await scenario();
    // This process is alive and holds it, which is exactly the case.
    leaseFor(scene.started.repository);

    const result = await driveLifecycle(scene.request(), scene.deps());

    expect(result.outcome).toBe('LIVE_OWNER_PRESENT');
    expectNothingExecuted(scene);
    expect(result.invocations).toBe(0);
    expect(result.start).toBeNull();
    // Nothing was released either — this run never held anything to release.
    expect(result.release).toBeNull();
  });

  it('leaves a stale lease untouched when recovery was not permitted', async () => {
    const scene = await scenario();
    staleLeaseAt(scene.started.repository);
    const before = readFileSync(leasePathOf(scene.started.repository), 'utf8');

    const result = await driveLifecycle(
      scene.request({ recoverStaleLease: false }),
      scene.deps(),
    );

    expect(result.outcome).toBe('STALE_LEASE_PRESENT');
    expect(result.recovery).toBeNull();
    expect(result.reasonCodes).toContain('STALE_RECOVERY_NOT_PERMITTED');
    expectNothingExecuted(scene);
    // Byte-identical: a run that may not recover must not have touched it.
    expect(readFileSync(leasePathOf(scene.started.repository), 'utf8')).toBe(before);
  });

  it('stops on a refused recovery and does not try a second time', async () => {
    const scene = await scenario();
    staleLeaseAt(scene.started.repository);
    const before = readFileSync(leasePathOf(scene.started.repository), 'utf8');

    const result = await driveLifecycle(
      scene.request({ recoverStaleLease: true }),
      scene.deps(),
    );

    expect(result.outcome).toBe('RECOVERY_UNSAFE');
    // The refusal is the ledger's, reported rather than folded away.
    expect(result.recovery?.code).toBe('RECOVERY_UNSAFE');
    // Which launch-history refusal depends on what the fixture's own prepare
    // step recorded under the lease it took; the property under test is that an
    // unproven history refuses at all, not which of its spellings applies.
    expect(result.recovery?.refusal).toMatch(/^LAUNCH_HISTORY_/);
    expectNothingExecuted(scene);
    expect(readFileSync(leasePathOf(scene.started.repository), 'utf8')).toBe(before);
  });

  /**
   * B, stated so it cannot pass by accident.
   *
   * A crash between the exclusive create and the record write leaves a
   * zero-byte file with no owner and no nonce. It is permanently unrecoverable
   * by design (V3-05), and the danger for an *outer loop* is not that it fails
   * — it is that a loop retries it forever. One attempt, then a stop.
   */
  it('refuses the crash-window artefact once rather than looping on it', async () => {
    const scene = await scenario();
    writeFileSync(leasePathOf(scene.started.repository), '', 'utf8');

    const result = await driveLifecycle(
      scene.request({ recoverStaleLease: true, maxInvocations: 5 }),
      scene.deps(),
    );

    expect(result.outcome).toBe('RECOVERY_UNSAFE');
    expect(result.recovery?.refusal).toBe('LEASE_UNPARSEABLE');
    expect(result.invocations).toBe(0);
    expectNothingExecuted(scene);
    // Still there. Nothing in this build removes it, and this one did not try.
    expect(readFileSync(leasePathOf(scene.started.repository), 'utf8')).toBe('');
  });
});

/* ══════════ 2. the loop across invocations, and its refusal to spin ══════ */

describe('an invocation is repeated only while the durable state moves', () => {
  it('re-enters after a step budget runs out, and counts each entry', async () => {
    const scene = await scenario();

    const result = await driveLifecycle(
      scene.request({ maxSteps: 1, maxInvocations: 4 }),
      scene.deps(),
    );

    // More than one entry, which is the behaviour that did not exist: with
    // `maxInvocations: 1` the same scenario stops at the step budget.
    expect(result.invocations).toBeGreaterThan(1);
    expect(result.runs.length).toBe(result.invocations);
    // Every invocation but the last claimed "call again".
    for (const run of result.runs.slice(0, -1)) {
      expect(run.outcome).toBe('STEP_BUDGET_EXHAUSTED');
    }
    expect(result.release?.code).toBe('RELEASED');
  });

  it('reproduces the pre-V3-06 behaviour at an invocation budget of one', async () => {
    const scene = await scenario();

    const result = await driveLifecycle(
      scene.request({ maxSteps: 1, maxInvocations: 1 }),
      scene.deps(),
    );

    expect(result.invocations).toBe(1);
    expect(result.outcome).toBe('INVOCATION_BUDGET_EXHAUSTED');
    expect(result.runs[0]?.outcome).toBe('STEP_BUDGET_EXHAUSTED');
  });

  /**
   * A, and the reason the guard reads the file instead of the report.
   *
   * The state file is made read-only-in-effect by pinning it back after every
   * invocation, so each one really does claim progress it did not make. A loop
   * that trusted `STEP_BUDGET_EXHAUSTED` would run to its invocation budget;
   * this one stops at the second entry, having seen the revision repeat.
   */
  it('stops when an invocation claims progress and the state did not move', async () => {
    const scene = await scenario();
    const root = scene.started.root;
    const pinned = reload(root, TASK_ID);

    const deps = scene.deps();
    const restoring: LifecycleDependencies = {
      ...deps,
      // Runs at every durable write and puts the file back, so the revision the
      // driver reads after each invocation is the one it read before.
      // The real rename first — a `ReplaceFn` *is* the write, not a hook beside
      // it, and a substitute that skips it makes every write fail instead of
      // land. That would test the run driver's own guard rather than this
      // layer's. The state is put back afterwards, so each invocation really
      // does complete a durable write and then find the file where it was.
      replace: (source: string, destination: string) => {
        renameSync(source, destination);
        // `expectedRevision` is not optional decoration: without it the store
        // treats a save as a create and refuses with `EXPECTED_ABSENT`, so the
        // restore would silently do nothing and the case would pass while
        // measuring the run driver's guard instead of this layer's.
        const current = loadTaskState(root, TASK_ID);
        if (!current.ok) return;
        const restored = saveTaskState(pinned.state, {
          repositoryRoot: root,
          expectedRevision: current.revision,
        });
        if (!restored.ok) throw new Error(`restore refused: ${restored.code}`);
      },
    };

    const result = await driveLifecycle(
      scene.request({ maxSteps: 1, maxInvocations: 6 }),
      restoring,
    );

    expect(result.invocations).toBeLessThan(6);
    expect(result.reasonCodes).toContain('DURABLE_STATE_UNCHANGED');
    expect(result.outcome).toBe('NO_PROGRESS');
  });
});

/* ═══ 3. a quota pause stops the run, and this is an authority question ═══ */

/**
 * The wait was withdrawn from this slice, and these cases pin the refusal.
 *
 * `run-driver.ts` refuses every continuation when `attendedContinuation` is
 * false — including one `evaluateAutomaticResume` has already allowed, because
 * the grant is checked before the resume write and can only withhold. So a run
 * that slept for hours and carried on would be spending a claim of operator
 * presence made before the sleep, and a run that dropped the grant instead
 * could not resume at all. Either way a wait needs an authority this build does
 * not have, so there is none.
 */
describe('a quota pause stops the run rather than being waited out', () => {
  const usageLimit = {
    agent: { claude: () => usageLimitResult() },
    stateOverrides: { state: 'IMPLEMENTING' as const, worktreeCleanAtCheckpoint: false },
  };

  it('stops on the quota block even with invocations left in the budget', async () => {
    const scene = await scenario(usageLimit);

    const result = await driveLifecycle(scene.request({ maxInvocations: 3 }), scene.deps());

    expect(result.outcome).toBe('BLOCKED_USAGE_LIMIT');
    // One invocation, though three were permitted: a block is a stop, and the
    // loop continues only on STEP_BUDGET_EXHAUSTED.
    expect(result.invocations).toBe(1);
    expect(result.release?.code).toBe('RELEASED');
  });

  it('offers no way to ask for a wait', () => {
    // A structural pin, and the cheapest honest one: the request type carries no
    // waiting concept at all, so no caller can express one and no default can
    // quietly acquire one. A future slice that adds waiting has to change this
    // shape, which is exactly the decision that should not happen by accident.
    const keys = Object.keys({
      repository: null,
      taskId: null,
      continuationGrant: null,
      recoverStaleLease: null,
      maxSteps: null,
      maxInvocations: null,
    } satisfies Record<keyof LifecycleRequest, null>);
    expect(keys).not.toContain('waitForReset');
    expect(keys).not.toContain('maxWaitMs');
  });
});

/* ═══════════ 4. the release, whose result every caller discarded ═════════ */

describe('a controlled exit reports what happened to the lease', () => {
  it('reports the release on a run that ended cleanly', async () => {
    const scene = await scenario();

    const result = await driveLifecycle(scene.request(), scene.deps());

    expect(result.release).not.toBeNull();
    expect(result.release?.code).toBe('RELEASED');
    expect(result.outcome).not.toBe('LEASE_RELEASE_FAILED');
  });

  /**
   * The safety net, and the regression that made it necessary.
   *
   * `run --attended` released inside a `finally` — "on every path out, including
   * a throw" — and this slice replaced that with a release whose result reaches
   * the caller. The first version of the replacement dropped the throw path with
   * it, which is strictly worse than the crash it was reasoned about as: the
   * process is still **alive** holding the lease, so acquisition refuses it as a
   * live owner and stale recovery refuses it as a running one. The repository
   * would be locked out until the process exited.
   *
   * A throw must therefore still give the lease back, and must still be a throw.
   */
  it('gives the lease back when a seam throws, and does not swallow the error', async () => {
    const scene = await scenario();
    const deps = scene.deps();
    const boom = new Error('seam exploded');

    await expect(
      driveLifecycle(scene.request(), {
        ...deps,
        authPreflight: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    // The lease is gone from disk, so a later invocation is not locked out.
    expect(() => readFileSync(leasePathOf(scene.started.repository), 'utf8')).toThrow();
    expectNothingExecuted(scene);
  });

  /**
   * C. The combination this member exists to make impossible.
   *
   * The lease is removed underneath the run, so the release cannot prove it gave
   * back what it held. The run itself succeeded — and the reported outcome is
   * *not* that success, because a clean report over an unexplained lease is the
   * report an operator acts on wrongly.
   */
  it('never reports a clean shutdown when the release could not be proven', async () => {
    const scene = await scenario();
    const deps = scene.deps();
    const path = leasePathOf(scene.started.repository);
    let removed = false;

    const stealing: LifecycleDependencies = {
      ...deps,
      replace: (source: string, destination: string) => {
        renameSync(source, destination);
        if (!removed) {
          removed = true;
          // The lease is gone from under the run — an operator who believed it
          // stale, a wiped administrative directory. The release that follows
          // cannot prove it gave back what it held, which is the whole point:
          // only `RELEASED` is success, and an absent lease is not that.
          rmSync(path, { force: true });
        }
      },
    };

    const result = await driveLifecycle(scene.request(), stealing);

    expect(result.release?.code).not.toBe('RELEASED');
    expect(result.outcome).toBe('LEASE_RELEASE_FAILED');

    // The outcome the run had actually reached is kept, and kept **first** —
    // `LIFECYCLE_OUTCOME_SENTENCES.LEASE_RELEASE_FAILED` tells the operator the
    // first reason code is that outcome, so the ordering is a contract rather
    // than a detail. The first version asserted only `length > 0`, which a
    // driver that dropped the outcome entirely would also satisfy.
    const reached = result.runs.at(-1)?.outcome;
    expect(reached).toBeDefined();
    expect(result.reasonCodes[0]).toBe(LIFECYCLE_FOR_RUN[reached!]);
    // The release code travels with it, so the operator learns what was found.
    expect(result.reasonCodes[1]).toBe(result.release?.code);
    expect(LIFECYCLE_OUTCOME_SENTENCES.LEASE_RELEASE_FAILED).toContain(
      'first reason code',
    );
  });
});

/* ═══════════════ delegation: the layer must not re-decide ═══════════════ */

describe('the layer delegates rather than re-implements', () => {
  /**
   * `satisfies Record<RunOutcome, LifecycleOutcome>` proves the map is complete
   * and proves nothing about any entry being right. Every meaning is asserted
   * here, one by one, and the two lists are compared so a new run outcome cannot
   * arrive unclassified.
   */
  it('gives every run outcome the lifecycle spelling an operator expects', () => {
    // Written out independently and then compared against the shipped map. The
    // first version of this case built this table and never read
    // `LIFECYCLE_FOR_RUN` at all, so any entry there could have been permuted —
    // `BLOCKED_VERIFY` reported as `SCOPE_VIOLATION`, `TASK_ABORTED` as
    // `COMPLETED` — with the suite still green. `satisfies` proves the map is
    // complete; only this comparison says it is right.
    const expected: Record<(typeof RUN_OUTCOMES)[number], LifecycleOutcome> = {
      TASK_COMPLETED: 'COMPLETED',
      TASK_ABORTED: 'TASK_ABORTED',
      BLOCKED_USAGE_LIMIT: 'BLOCKED_USAGE_LIMIT',
      BLOCKED_VERIFY: 'BLOCKED_VERIFY',
      BLOCKED_AUTH: 'BLOCKED_AUTH',
      SCOPE_VIOLATION: 'SCOPE_VIOLATION',
      RESUME_STATE_DIVERGED: 'RESUME_STATE_DIVERGED',
      HUMAN_DECISION_REQUIRED: 'HUMAN_DECISION_REQUIRED',
      STATE_DIVERGED: 'RECONCILIATION_DIVERGED',
      STATE_UNOBSERVABLE: 'RECONCILIATION_UNOBSERVABLE',
      STATE_UNUSABLE: 'STATE_UNUSABLE',
      TASK_NOT_STARTED: 'TASK_NOT_STARTED',
      STATE_CONFLICT: 'STATE_CONFLICT',
      STATE_NOT_RECORDED: 'STATE_NOT_RECORDED',
      CONTINUATION_NOT_AUTHORISED: 'CONTINUATION_NOT_AUTHORISED',
      EXECUTION_UNAUTHORISED: 'EXECUTION_UNAUTHORISED',
      EXECUTION_LEASE_NOT_HELD: 'EXECUTION_LEASE_NOT_HELD',
      EXECUTION_LEASE_LOST: 'EXECUTION_LEASE_LOST',
      NO_PROGRESS: 'NO_PROGRESS',
      STEP_BUDGET_EXHAUSTED: 'INVOCATION_BUDGET_EXHAUSTED',
    };
    // The shipped map, entry by entry. This is the assertion that bites.
    expect(LIFECYCLE_FOR_RUN).toEqual(expected);
    // No run outcome may be missing, and none may be invented.
    expect(Object.keys(expected).sort()).toEqual([...RUN_OUTCOMES].sort());
    // And an operator sentence exists for every member, including the ones no
    // run outcome maps to — the lease phase's own.
    for (const outcome of LIFECYCLE_OUTCOMES) {
      expect(LIFECYCLE_OUTCOME_SENTENCES[outcome].length).toBeGreaterThan(0);
    }
  });

  it('stops on a human-decision block instead of starting another review', async () => {
    // One round, already spent: the loop's own budget check parks the task, and
    // a new invocation must not refill it.
    const scene = await scenario({
      maxReviewRounds: 1,
      stateOverrides: { state: 'REVIEWING', reviewRound: 1 },
      agent: { claude: () => writerSuccess(), codex: () => reviewResult(passingReview()) },
    });
    const before = reload(scene.started.root, TASK_ID).state;

    const result = await driveLifecycle(
      scene.request({ maxInvocations: 5 }),
      scene.deps(),
    );

    expect(result.outcome).toBe('HUMAN_DECISION_REQUIRED');
    // The budget did not move, and the loop did not go round again looking.
    const after = reload(scene.started.root, TASK_ID).state;
    expect(after.maxReviewRounds).toBe(before.maxReviewRounds);
    expect(after.reviewRound).toBeLessThanOrEqual(after.maxReviewRounds);
    expect(scene.agent.countFor('codex')).toBe(0);
  });

  it('treats a lease taken by somebody else mid-run as the run driver does', async () => {
    const scene = await scenario();
    const path = leasePathOf(scene.started.repository);
    const deps = scene.deps();

    const losing: LifecycleDependencies = {
      ...deps,
      replace: (source: string, destination: string) => {
        // Remove the lease before the write lands, so `advanceTaskState`
        // re-proves it and refuses — the run driver's own mechanism, reached
        // through this layer rather than reimplemented in it.
        //
        // The real rename still happens. `scenario().deps()` supplies no
        // `replace`, so the first version's `deps.replace?.(…)` short-circuited
        // and no write ever landed: every publish failed for the wrong reason
        // and the two-member disjunction below passed regardless.
        writeFileSync(path, '', 'utf8');
        renameSync(source, destination);
      },
    };

    const result = await driveLifecycle(scene.request(), losing);

    // The write is refused by `advanceTaskState`'s re-proof, not by this layer:
    // the lease it was told to use is no longer at the path. Whichever of the
    // two the run surfaces, the durable write must not have landed and no
    // further invocation may follow it.
    expect(['EXECUTION_LEASE_LOST', 'LEASE_RELEASE_FAILED']).toContain(result.outcome);
    expect(result.invocations).toBe(1);
    expect(result.runs[0]?.outcome).toBe('EXECUTION_LEASE_LOST');
  });
});

/* ═══════════════ the report an operator actually reads ═══════════════════ */

describe('the lifecycle report', () => {
  /**
   * `renderLifecycleRun` had no test at all until this one, while the renderer
   * it replaced — `renderAttendedRun`, since deleted — kept several. The product
   * shipped the untested one.
   */
  it('names the outcome, the release and the invocation count', async () => {
    const scene = await scenario();
    const result = await driveLifecycle(scene.request(), scene.deps());

    const text = renderLifecycleRun(scene.started.repository, result);

    expect(text).toContain(`Lifecycle    : ${result.outcome}`);
    expect(text).toContain(LIFECYCLE_OUTCOME_SENTENCES[result.outcome]);
    // The line that did not exist anywhere before this slice, printed on every
    // run that held a lease rather than only on failures — a line that appeared
    // only when something went wrong is a line nobody learns to look for.
    expect(text).toContain('Release      : RELEASED');
    expect(text).toContain('Invocations  : 1');
    // One invocation, so the repeated-run sentence must be absent.
    expect(text).not.toContain(LIFECYCLE_TRAILER);
    // And the attended contract sentence is still there, unchanged.
    expect(text).toContain('Attended run.');
  });

  it('adds the repeated-run sentence only once the run repeats', async () => {
    const scene = await scenario();
    const result = await driveLifecycle(
      scene.request({ maxSteps: 1, maxInvocations: 4 }),
      scene.deps(),
    );
    expect(result.invocations).toBeGreaterThan(1);

    expect(renderLifecycleRun(scene.started.repository, result)).toContain(LIFECYCLE_TRAILER);
  });
});

/* ═════════════ an adopted workspace is driven, not refused ═══════════════ */

/**
 * The case this slice exists for, and the one the first version got wrong.
 *
 * `startTask` returns `ADOPTED` when a pristine orphan worktree left by an
 * earlier crashed start is proven to be this task's own and reused — *after* the
 * first durable state has been written. So the task is started. Refusing it
 * produced the worst possible report for a crash-restart: a workspace adopted,
 * state written, nothing driven, the sentence "the task could not be started or
 * adopted", and exit 0.
 */
describe('a workspace left by a crashed start is adopted and then driven', () => {
  it('drives an adopted task instead of refusing it', async () => {
    // A real prepared worktree with no durable state — exactly what a start that
    // died between preparing and writing leaves behind. Nothing is seeded.
    // The runtime directory must be ignored, or `startTask` refuses with
    // `RUNTIME_NOT_IGNORED` before it ever reaches adoption. Every other case in
    // this file seeds a state first, so `ALREADY_STARTED` returns ahead of that
    // check and the fixture never needed it.
    const started = await startTask({
      taskId: TASK_ID,
      files: { '.gitignore': '.agent-orchestrator/runtime/\n' },
    });
    releaseTestLeases();
    const agent = recordedAgent({
      claude: () => writerSuccess(),
      codex: () => reviewResult(passingReview()),
    });
    const verify = recordedVerify();

    const result = await driveLifecycle(
      {
        repository: started.repository,
        taskId: TASK_ID,
        continuationGrant: true,
        recoverStaleLease: false,
        maxSteps: 2,
        maxInvocations: 2,
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: async () => provenAuthEvidence(),
        agent: agent.runner,
        verify: verify.runner,
      },
    );

    expect(result.start?.outcome).toBe('ADOPTED');
    // The property: adoption did not end the run.
    expect(result.outcome).not.toBe('TASK_START_REFUSED');
    expect(result.invocations).toBeGreaterThan(0);
    // And durable state exists for it afterwards, which is what "started" means.
    expect(reload(started.root, TASK_ID).state.taskId).toBe(TASK_ID);
  });
});

/* ───────────────────────── a bad bound is refused ───────────────────────── */

describe('the invocation bound is validated before anything is taken', () => {
  it('refuses a budget below one without touching the lease', async () => {
    const scene = await scenario();

    const result = await driveLifecycle(scene.request({ maxInvocations: 0 }), scene.deps());

    // The outcome, not only the reason code. The first version asserted the code
    // alone, which let an unusable argument be reported as
    // `INVOCATION_BUDGET_EXHAUSTED` — exit 5, "call again to continue" — for an
    // argument that repeats forever.
    expect(result.outcome).toBe('INVOCATION_BUDGET_INVALID');
    expect(result.reasonCodes).toContain('MAX_INVOCATIONS_INVALID');
    expect(result.release).toBeNull();
    expectNothingExecuted(scene);
    // No lease was created by the refusal.
    expect(() => readFileSync(leasePathOf(scene.started.repository), 'utf8')).toThrow();
  });
});

/* ─────────── a real acquisition really is exclusive, here too ──────────── */

/**
 * What this does **not** cover, stated so the title cannot mislead.
 *
 * The post-recovery lost race — recover a dead lease, then lose the ordinary
 * acquisition to a successor that appeared in between — is produced by no test
 * here and by no phase of the dist harness. Reaching it needs a lease that
 * recovery *accepts* (a real proved launch history) and a competitor arriving
 * inside the window between the removal and the second acquire. It is recorded
 * as `L-V3-06-5` rather than covered. The case below is the neighbouring one:
 * a live owner is refused before any recovery is attempted at all.
 */
describe('a live owner is refused before recovery is even attempted', () => {
  it('refuses without calling the recovery, and executes nothing', async () => {
    const scene = await scenario();
    const held = acquireRepositoryExecutionLease(
      scene.started.repository,
      { runId: null, blockId: null },
      { now: () => new Date().toISOString() },
    );
    expect(held.ok).toBe(true);

    const result = await driveLifecycle(
      scene.request({ recoverStaleLease: true }),
      scene.deps(),
    );

    expect(result.outcome).toBe('LIVE_OWNER_PRESENT');
    expect(result.acquire).toBe('LEASE_HELD');
    // The assertion the first version of this case lacked, and the reason its
    // title was wrong: the recovery was never called, so nothing here can say
    // anything about what happens after one.
    expect(result.recovery).toBeNull();
    expectNothingExecuted(scene);
    if (held.ok) releaseRepositoryExecutionLease(held.evidence);
  });
});
