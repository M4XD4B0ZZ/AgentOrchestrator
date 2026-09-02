/**
 * M3 slice 2 — which quota blocks are the operator's, as a policy.
 *
 * ── What this file measures ────────────────────────────────────────────────
 *
 * `core/automatic-resume.ts`'s new `recordOnlyResumeRefusals` and
 * `core/usage-limit-continuation.ts`'s reading of it. Both are pure, so every
 * case here is a value in and a value out — no Git, no filesystem, no clock.
 *
 * The *driver* half — that the reading actually gates `--continue-usage-limit`,
 * that a permitted block really moves and a refused one really does not, and
 * that nothing starts an agent it should not — lives in
 * `tests/run-driver.test.ts` beside the M2-06 cases it widens, because that is
 * where the harness that can run a task is. Neither file replaces the other, and
 * the split is the same one this repository already makes everywhere: policy
 * where the policy is, effect where the effect is.
 *
 * ── The two properties that make the construction safe ─────────────────────
 *
 * `recordOnlyResumeRefusals` asks the resume policy rather than restating it, by
 * evaluating it against evidence stipulated to agree with the record on every
 * observable fact. Two things have to stay true for that to mean anything, and
 * both are measured here rather than argued:
 *
 *  1. a record with nothing wrong with it must produce **no** record-only
 *     refusal. A world check added later that denies under a perfect world
 *     would otherwise arrive silently as "the record is broken";
 *  2. the set of refusals subtracted as world-dependent must be **exactly** the
 *     ones a perfect world cannot satisfy — measured by evaluating the policy on
 *     a healthy record and comparing what comes back, so removing a member or
 *     forgetting to add one fails.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateAutomaticResume,
  recordOnlyResumeRefusals,
  WORLD_DEPENDENT_RESUME_REFUSALS,
  type AutomaticResumeReasonCode,
} from '../src/core/automatic-resume.js';
import type { TaskState } from '../src/core/task-state.js';
import {
  usageLimitContinuation,
  USAGE_LIMIT_CONTINUATION_PERMISSIONS,
  USAGE_LIMIT_CONTINUATION_READINGS,
  USAGE_LIMIT_CONTINUATION_REFUSALS,
  USAGE_LIMIT_CONTINUATION_SENTENCES,
  type UsageLimitContinuationReading,
} from '../src/core/usage-limit-continuation.js';

const NOW = '2026-09-02T12:00:00.000Z';
const PAST = '2026-09-02T11:00:00.000Z';
const AHEAD = '2026-09-02T13:00:00.000Z';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * A quota pause exactly as `recordAgentInterruption` writes a *settled* one:
 * a reset instant, a resume point, an exact commit and a clean tree.
 *
 * Every case below differs from this in the one field it is about, so a
 * difference in outcome is attributable to that field and to nothing else.
 */
function paused(overrides: Partial<TaskState> = {}): TaskState {
  return Object.freeze({
    schemaVersion: 1,
    taskId: 'T-1',
    repositoryId: 'fixture',
    repositoryRoot: 'C:\\repo',
    worktreePath: 'C:\\repo.worktrees\\T-1',
    state: 'BLOCKED_USAGE_LIMIT',
    stateEnteredAt: '2026-09-01T00:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: SHA_A,
    scopeAuthorityCommit: null,
    workBranch: 'ao/task/T-1',
    currentCommit: SHA_B,
    reviewRound: 0,
    maxReviewRounds: 1,
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    reportedResetAt: PAST,
    worktreeCleanAtCheckpoint: true,
    findingHistory: [],
    ...overrides,
  }) as unknown as TaskState;
}

/**
 * The withdrawal `withdrawnCheckpointFor` writes for a mutating phase, and the
 * shape this whole slice exists for: a reset that has passed, over a record
 * that can never be resumed from.
 */
const WITHDRAWN = Object.freeze({ currentCommit: null, worktreeCleanAtCheckpoint: false });

/* ══════════════ 1. what belongs to the record, and what to the world ═══════ */

describe('M3 slice 2 — record-only resume refusals', () => {
  it('reports nothing for a record with nothing wrong with it', () => {
    // The maintenance guard for the whole construction. `recordOnlyResumeRefusals`
    // stipulates favourable values for every world fact; a world check added to
    // `AutomaticResumeEvidence` later would arrive here as whatever the object
    // literal does not set, and a denying default would make every record look
    // unresumable and quietly widen an operator escape. This case is what turns
    // that into a failure.
    expect(recordOnlyResumeRefusals(paused(), NOW)).toEqual([]);
  });

  it('subtracts exactly the refusals a perfect world cannot satisfy', () => {
    // Measured against the policy rather than asserted about the set. Evaluate
    // the real function with the same stipulated-favourable evidence and see
    // what survives on a healthy record: whatever it is, it is by definition the
    // set no pure caller can satisfy, and it must be the set that is subtracted.
    const state = paused();
    const decision = evaluateAutomaticResume(state, {
      now: NOW,
      authEvidence: null,
      observedRepositoryId: state.repositoryId,
      observedRepositoryRoot: state.repositoryRoot,
      observedWorktreePath: state.worktreePath,
      worktreeExists: true,
      observedBasePinnedCommit: state.basePinnedCommit,
      observedCurrentCommit: state.currentCommit,
      worktreeClean: true,
      divergenceDetected: false,
    });

    expect([...decision.reasonCodes].sort()).toEqual([...WORLD_DEPENDENT_RESUME_REFUSALS].sort());
  });

  it('names the two facts a withdrawn checkpoint refuses on', () => {
    const refusals = recordOnlyResumeRefusals(paused(WITHDRAWN), NOW);
    expect([...refusals].sort()).toEqual(['CURRENT_COMMIT_MISMATCH', 'WORKTREE_NOT_CLEAN']);
  });

  it('names the wait when a reset is still ahead, and only the wait', () => {
    expect(recordOnlyResumeRefusals(paused({ reportedResetAt: AHEAD }), NOW)).toEqual([
      'RESET_TIME_NOT_REACHED',
    ]);
  });

  it('names the absent instant when no reset was recorded', () => {
    expect(recordOnlyResumeRefusals(paused({ reportedResetAt: null }), NOW)).toEqual([
      'RESET_TIME_MISSING',
    ]);
  });

  it('is not confused by a clean world that disagrees with a clean record', () => {
    // The disjunction that made the M2 term too narrow, isolated. Both
    // `WORKTREE_NOT_CLEAN` and `CURRENT_COMMIT_MISMATCH` are produced by two
    // different facts each, one of the record and one of the world, and
    // `evaluateAutomaticResume` reports the same code for either. That is why a
    // driver conjunct cannot key on the reason codes of a real evaluation: it
    // would admit a genuinely dirty world. Here the world is stipulated clean,
    // so only the record's half can fire — which is the entire point.
    expect(recordOnlyResumeRefusals(paused({ worktreeCleanAtCheckpoint: false }), NOW)).toEqual([
      'WORKTREE_NOT_CLEAN',
    ]);
    expect(recordOnlyResumeRefusals(paused({ currentCommit: null }), NOW)).toEqual([
      'CURRENT_COMMIT_MISMATCH',
    ]);
  });
});

/* ══════════════════════ 2. the reading, per shape ══════════════════════════ */

describe('M3 slice 2 — the usage-limit continuation reading', () => {
  const CASES: readonly {
    readonly name: string;
    readonly state: TaskState;
    readonly reading: UsageLimitContinuationReading;
    readonly permitted: boolean;
  }[] = [
    {
      name: 'a task that is not parked on a quota block at all',
      state: paused({ state: 'BLOCKED_VERIFY' }),
      reading: 'STATE_NOT_BLOCKED_ON_USAGE_LIMIT',
      permitted: false,
    },
    {
      name: 'a reset still ahead — the machine’s wait',
      state: paused({ reportedResetAt: AHEAD }),
      reading: 'RESET_AHEAD',
      permitted: false,
    },
    {
      name: 'a reset ahead AND a withdrawn record — still the wait',
      state: paused({ reportedResetAt: AHEAD, ...WITHDRAWN }),
      reading: 'RESET_AHEAD',
      permitted: false,
    },
    {
      name: 'a reset passed over an intact record — the automatic path’s',
      state: paused(),
      reading: 'MACHINE_MAY_STILL_RESUME',
      permitted: false,
    },
    {
      name: 'no reset recorded — the M2 slice 6 case',
      state: paused({ reportedResetAt: null }),
      reading: 'RESET_UNRECORDED',
      permitted: true,
    },
    {
      name: 'a reset passed over a withdrawn record — the shape this slice adds',
      state: paused(WITHDRAWN),
      reading: 'RESUME_RECORD_WITHDRAWN',
      permitted: true,
    },
    {
      name: 'a record with no base pin — the other half of a withdrawal',
      state: paused({ basePinnedCommit: null }),
      reading: 'RESUME_RECORD_WITHDRAWN',
      permitted: true,
    },
  ];

  for (const testCase of CASES) {
    it(`reads ${testCase.name} as ${testCase.reading}`, () => {
      const answer = usageLimitContinuation(testCase.state, NOW);
      expect(answer.reading).toBe(testCase.reading);
      expect(answer.permitted).toBe(testCase.permitted);
    });
  }

  it('refuses a clock that is not a timestamp, before anything else', () => {
    const answer = usageLimitContinuation(paused(WITHDRAWN), 'not-a-timestamp');
    expect(answer.reading).toBe('CURRENT_TIME_UNREADABLE');
    expect(answer.permitted).toBe(false);
  });

  it('refuses a record with no resume point, though the state contract forbids one', () => {
    const answer = usageLimitContinuation(paused({ resumeFrom: null }), NOW);
    expect(answer.reading).toBe('RESUME_POINT_MISSING');
    expect(answer.permitted).toBe(false);
  });

  /**
   * The fail-closed floor, and the case that put it there.
   *
   * `repositoryRoot` and `worktreePath` are `NonBlankString` in the state
   * contract — a relative path is schema-valid — and `canonicalPathsEqual`
   * refuses a relative path on either side. So the refusal is genuinely
   * record-only, and a catch-all `permit('RESUME_RECORD_WITHDRAWN')` would have
   * permitted it under a sentence that talks about commits and worktrees. The
   * escape has no sentence for this fault, so it does not cover it.
   */
  it('refuses a record-only fault it has no sentence for, rather than guessing', () => {
    const answer = usageLimitContinuation(paused({ repositoryRoot: 'relative/path' }), NOW);
    expect(answer.reading).toBe('RECORD_REFUSAL_UNRECOGNISED');
    expect(answer.permitted).toBe(false);
  });

  it('refuses a record that is both withdrawn and otherwise unusable', () => {
    // Every surviving refusal must be one this build continues past, not merely
    // one of them: the operator would otherwise be shown a sentence describing
    // half of what is wrong with the record.
    const answer = usageLimitContinuation(
      paused({ ...WITHDRAWN, worktreePath: 'relative/tree' }),
      NOW,
    );
    expect(answer.reading).toBe('RECORD_REFUSAL_UNRECOGNISED');
    expect(answer.permitted).toBe(false);
  });

  it('grades every reading exactly once, and permission follows the name', () => {
    expect(new Set(USAGE_LIMIT_CONTINUATION_READINGS).size).toBe(
      USAGE_LIMIT_CONTINUATION_READINGS.length,
    );
    for (const reading of USAGE_LIMIT_CONTINUATION_REFUSALS) {
      expect(USAGE_LIMIT_CONTINUATION_PERMISSIONS).not.toContain(reading);
    }
  });

  it('has a sentence for every reading, and no two are interchangeable', () => {
    // Completeness is `satisfies`' job and it proves only that every member was
    // considered. Correctness is measured the way `notify/attention.ts` measures
    // its own: each sentence carries a token that appears in no other, asserted
    // in both directions, so a sentence swapped between two readings fails.
    const TOKENS: Readonly<Record<UsageLimitContinuationReading, string>> = {
      STATE_NOT_BLOCKED_ON_USAGE_LIMIT: 'not parked on a quota block',
      CURRENT_TIME_UNREADABLE: 'clock this was judged against',
      RESET_AHEAD: 'has not arrived',
      RECORD_REFUSAL_UNRECOGNISED: 'not one this build lets an operator continue past',
      RESUME_POINT_MISSING: 'names no phase to continue at',
      MACHINE_MAY_STILL_RESUME: 'refusing on the repository as it stands right now',
      RESET_UNRECORDED: 'records no reset instant',
      RESET_UNREADABLE: 'not a timestamp, so nothing can wait for it either',
      RESUME_RECORD_WITHDRAWN: 'no settled commit',
    };

    for (const reading of USAGE_LIMIT_CONTINUATION_READINGS) {
      expect(USAGE_LIMIT_CONTINUATION_SENTENCES[reading]).toContain(TOKENS[reading]);
      for (const other of USAGE_LIMIT_CONTINUATION_READINGS) {
        if (other === reading) continue;
        expect(USAGE_LIMIT_CONTINUATION_SENTENCES[other]).not.toContain(TOKENS[reading]);
      }
    }
  });

  /**
   * The widening is strictly a widening, stated as a property rather than as a
   * list of the cases above.
   *
   * Everything the M2 slice 6 term permitted — `reportedResetAt === null` — must
   * still be permitted, and every shape it refused for a reason that still
   * stands must still be refused. A future implementation that got the direction
   * wrong on any record fails here without anybody having enumerated it.
   */
  it('permits everything the narrow term permitted', () => {
    for (const overrides of [
      {},
      WITHDRAWN,
      { basePinnedCommit: null },
      { currentCommit: null },
      { worktreeCleanAtCheckpoint: false },
    ] as const) {
      const answer = usageLimitContinuation(
        paused({ ...overrides, reportedResetAt: null }),
        NOW,
      );
      expect(answer.permitted).toBe(true);
    }
  });

  it('refuses every future reset, whatever else is wrong with the record', () => {
    for (const overrides of [
      {},
      WITHDRAWN,
      { basePinnedCommit: null },
      { currentCommit: null },
      { worktreeCleanAtCheckpoint: false },
    ] as const) {
      const answer = usageLimitContinuation(
        paused({ ...overrides, reportedResetAt: AHEAD }),
        NOW,
      );
      expect(answer.permitted).toBe(false);
      expect(answer.reading).toBe('RESET_AHEAD');
    }
  });

  it('refuses a reset exactly at now, because the resume policy does', () => {
    // `evaluateAutomaticResume` denies while `now <= reportedResetAt`, so the
    // instant itself is still ahead as far as the machine is concerned. The
    // reading has to agree with it: disagreeing would put the operator and the
    // scheduler on two different answers about the same millisecond.
    expect(usageLimitContinuation(paused({ reportedResetAt: NOW }), NOW).reading).toBe(
      'RESET_AHEAD',
    );
  });
});

/* ═══════════════ 3. the reading is derived, never independent ══════════════ */

describe('M3 slice 2 — the reading tracks the resume policy', () => {
  it('permits nothing the resume policy would have granted', () => {
    // The safety sentence, as a property over the shapes this file builds: a
    // record the automatic path could resume from is never the operator's. If
    // both were true at once, the escape would be spending a decision on a task
    // that was about to move by itself.
    for (const overrides of [{}, { reportedResetAt: AHEAD }] as const) {
      const state = paused(overrides);
      const refusals: readonly AutomaticResumeReasonCode[] = recordOnlyResumeRefusals(state, NOW);
      const answer = usageLimitContinuation(state, NOW);
      if (refusals.length === 0) expect(answer.permitted).toBe(false);
    }
  });

  it('permits only where the record refuses for a reason time cannot fix', () => {
    for (const overrides of [WITHDRAWN, { reportedResetAt: null }] as const) {
      const state = paused(overrides);
      expect(usageLimitContinuation(state, NOW).permitted).toBe(true);
      // …and the same record, judged an hour later, still cannot resume by
      // itself. That is what "time cannot fix it" means, and it is the property
      // that distinguishes this class from `RESET_AHEAD`.
      const later = '2026-09-02T13:00:00.000Z';
      expect(recordOnlyResumeRefusals(state, later).length).toBeGreaterThan(0);
      expect(usageLimitContinuation(state, later).permitted).toBe(true);
    }
  });
});
