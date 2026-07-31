import { describe, expect, it } from 'vitest';

import {
  listMissingPreferredEvidence,
  parseTaskState,
  safeParseTaskState,
  TASK_STATE_SCHEMA_VERSION,
} from '../src/core/task-state.js';
import { SHA_A, SHA_B, validCreatedState, validUsageLimitState } from './fixtures.js';

function issuePaths(result: ReturnType<typeof safeParseTaskState>): string[] {
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('valid task states', () => {
  it('accepts a fully populated CREATED state', () => {
    const parsed = parseTaskState(validCreatedState());
    expect(parsed.state).toBe('CREATED');
    expect(parsed.schemaVersion).toBe(TASK_STATE_SCHEMA_VERSION);
  });

  it('accepts a fully populated BLOCKED_USAGE_LIMIT state', () => {
    const parsed = parseTaskState(validUsageLimitState());
    expect(parsed.blockedAgent).toBe('claude');
    expect(parsed.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });
  });

  it('accepts a settled READY_FOR_PR state', () => {
    const parsed = parseTaskState(
      validCreatedState({
        state: 'READY_FOR_PR',
        reviewRound: 2,
        basePinnedCommit: SHA_A,
        currentCommit: SHA_B,
        findingHistory: [{ round: 1, severity: 'medium', fingerprint: 'abc123' }],
      }),
    );
    expect(parsed.resumeFrom).toBeNull();
    expect(parsed.findingHistory).toHaveLength(1);
  });

  it('accepts SHA-256 object names', () => {
    expect(() =>
      parseTaskState(validCreatedState({ basePinnedCommit: 'f'.repeat(64) })),
    ).not.toThrow();
  });
});

describe('required fields', () => {
  it.each([
    'taskId',
    'repositoryId',
    'repositoryRoot',
    'worktreePath',
    'state',
    'stateEnteredAt',
    'baseBranch',
    'workBranch',
    'reviewRound',
    'maxReviewRounds',
    'blockedAgent',
    'resumeFrom',
    'reportedResetAt',
    'worktreeCleanAtCheckpoint',
    'findingHistory',
    'schemaVersion',
    'basePinnedCommit',
    'currentCommit',
  ])('rejects a state missing %s', (field) => {
    const state = validCreatedState() as Record<string, unknown>;
    delete state[field];
    const result = safeParseTaskState(state);
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(field);
  });

  it.each(['taskId', 'repositoryId', 'repositoryRoot', 'worktreePath', 'baseBranch', 'workBranch'])(
    'rejects an empty %s',
    (field) => {
      const result = safeParseTaskState(validCreatedState({ [field]: '' }));
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(field);
    },
  );

  it('rejects a blank (whitespace-only) taskId', () => {
    const result = safeParseTaskState(validCreatedState({ taskId: '   ' }));
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra properties', () => {
    const result = safeParseTaskState({ ...validCreatedState(), somethingElse: true });
    expect(result.success).toBe(false);
  });

  it('rejects an unsupported schemaVersion', () => {
    const result = safeParseTaskState(validCreatedState({ schemaVersion: 99 }));
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('schemaVersion');
  });

  it('rejects a non-positive schemaVersion', () => {
    expect(safeParseTaskState(validCreatedState({ schemaVersion: 0 })).success).toBe(false);
  });

  it('rejects an unknown state name', () => {
    expect(safeParseTaskState(validCreatedState({ state: 'NOPE' as never })).success).toBe(false);
  });
});

describe('ISO-8601 timestamps', () => {
  it.each([
    'not-a-date',
    '2026-07-31',
    '2026-07-31 10:00:00',
    '31.07.2026T10:00:00Z',
    '2026-13-01T10:00:00Z',
    '',
  ])('rejects stateEnteredAt = %j', (value) => {
    const result = safeParseTaskState(validCreatedState({ stateEnteredAt: value }));
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('stateEnteredAt');
  });

  it('accepts a numeric UTC offset', () => {
    expect(
      safeParseTaskState(validCreatedState({ stateEnteredAt: '2026-07-31T12:00:00+02:00' })).success,
    ).toBe(true);
  });

  it('rejects an invalid reportedResetAt but allows null', () => {
    expect(safeParseTaskState(validCreatedState({ reportedResetAt: null })).success).toBe(true);
    expect(safeParseTaskState(validCreatedState({ reportedResetAt: 'soon' })).success).toBe(false);
  });
});

describe('git commit fields', () => {
  it.each([
    'abc1234',
    'not-a-sha',
    'A'.repeat(40),
    '0'.repeat(39),
    '0'.repeat(41),
    'g'.repeat(40),
    '',
  ])('rejects basePinnedCommit = %j', (value) => {
    const result = safeParseTaskState(validCreatedState({ basePinnedCommit: value }));
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('basePinnedCommit');
  });

  it('rejects an abbreviated currentCommit', () => {
    expect(safeParseTaskState(validCreatedState({ currentCommit: 'deadbee' })).success).toBe(false);
  });

  it('allows null for both commit fields', () => {
    expect(
      safeParseTaskState(validCreatedState({ basePinnedCommit: null, currentCommit: null })).success,
    ).toBe(true);
  });
});

describe('blockedAgent consistency', () => {
  it.each(['CREATED', 'IMPLEMENTING', 'REVIEWING', 'READY_FOR_PR', 'ABORTED'] as const)(
    'rejects a blockedAgent in the non-blocking state %s',
    (state) => {
      const result = safeParseTaskState(
        validCreatedState({ state, blockedAgent: 'claude', reviewRound: 1 }),
      );
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('blockedAgent');
    },
  );

  it('rejects an unknown agent name', () => {
    expect(
      safeParseTaskState(validUsageLimitState({ blockedAgent: 'gemini' as never })).success,
    ).toBe(false);
  });

  it('rejects a blockedAgent for BLOCKED_VERIFY, where no agent runs', () => {
    const result = safeParseTaskState(
      validCreatedState({
        state: 'BLOCKED_VERIFY',
        blockedAgent: 'claude',
        resumeFrom: { phase: 'VERIFY', round: 1 },
      }),
    );
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('blockedAgent');
  });

  it('accepts BLOCKED_VERIFY without a blockedAgent', () => {
    expect(
      safeParseTaskState(
        validCreatedState({
          state: 'BLOCKED_VERIFY',
          blockedAgent: null,
          resumeFrom: { phase: 'VERIFY', round: 1 },
        }),
      ).success,
    ).toBe(true);
  });
});

describe('resumeFrom invariants', () => {
  it('rejects BLOCKED_USAGE_LIMIT without a resumeFrom', () => {
    const result = safeParseTaskState(validUsageLimitState({ resumeFrom: null }));
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('resumeFrom');
  });

  it('rejects BLOCKED_USAGE_LIMIT without a blockedAgent', () => {
    const result = safeParseTaskState(validUsageLimitState({ blockedAgent: null }));
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('blockedAgent');
  });

  it('rejects BLOCKED_AUTH without a resumeFrom', () => {
    const result = safeParseTaskState(
      validCreatedState({ state: 'BLOCKED_AUTH', blockedAgent: 'codex', resumeFrom: null }),
    );
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('resumeFrom');
  });

  it('rejects round 0', () => {
    const result = safeParseTaskState(
      validUsageLimitState({ resumeFrom: { phase: 'IMPLEMENT', round: 0 } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a round greater than maxReviewRounds', () => {
    const result = safeParseTaskState(
      validUsageLimitState({ maxReviewRounds: 2, resumeFrom: { phase: 'REVIEW', round: 3 } }),
    );
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('resumeFrom.round');
  });

  it('rejects an unstructured string resumeFrom', () => {
    const result = safeParseTaskState(
      validUsageLimitState({ resumeFrom: 'IMPLEMENT_ROUND_1' as never }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown phase', () => {
    const result = safeParseTaskState(
      validUsageLimitState({ resumeFrom: { phase: 'DEPLOY' as never, round: 1 } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a pending resumeFrom on READY_FOR_PR', () => {
    const result = safeParseTaskState(
      validCreatedState({ state: 'READY_FOR_PR', resumeFrom: { phase: 'REVIEW', round: 1 } }),
    );
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('resumeFrom');
  });
});

describe('review budget', () => {
  it('rejects reviewRound greater than maxReviewRounds', () => {
    const result = safeParseTaskState(validCreatedState({ reviewRound: 4, maxReviewRounds: 3 }));
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('reviewRound');
  });

  it('accepts reviewRound equal to maxReviewRounds', () => {
    expect(safeParseTaskState(validCreatedState({ reviewRound: 3, maxReviewRounds: 3 })).success).toBe(
      true,
    );
  });

  it('rejects a negative reviewRound', () => {
    expect(safeParseTaskState(validCreatedState({ reviewRound: -1 })).success).toBe(false);
  });

  it('rejects maxReviewRounds of 0', () => {
    expect(safeParseTaskState(validCreatedState({ maxReviewRounds: 0 })).success).toBe(false);
  });

  it('rejects a finding recorded beyond maxReviewRounds', () => {
    const result = safeParseTaskState(
      validCreatedState({
        maxReviewRounds: 2,
        findingHistory: [{ round: 5, severity: 'high', fingerprint: 'fp' }],
      }),
    );
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('findingHistory.0.round');
  });
});

describe('findingHistory entries', () => {
  it('accepts every allowed severity', () => {
    const result = safeParseTaskState(
      validCreatedState({
        maxReviewRounds: 5,
        findingHistory: (['critical', 'high', 'medium', 'low', 'info'] as const).map(
          (severity, index) => ({ round: index + 1, severity, fingerprint: `fp-${index}` }),
        ),
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an unknown severity', () => {
    const result = safeParseTaskState(
      validCreatedState({
        findingHistory: [{ round: 1, severity: 'blocker' as never, fingerprint: 'fp' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an empty fingerprint', () => {
    const result = safeParseTaskState(
      validCreatedState({ findingHistory: [{ round: 1, severity: 'low', fingerprint: '' }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a finding round below 1', () => {
    const result = safeParseTaskState(
      validCreatedState({ findingHistory: [{ round: 0, severity: 'low', fingerprint: 'fp' }] }),
    );
    expect(result.success).toBe(false);
  });
});

describe('preferred-but-missing evidence', () => {
  it('flags a usage-limit state without a reported reset time without invalidating it', () => {
    const state = parseTaskState(validUsageLimitState({ reportedResetAt: null }));
    expect(listMissingPreferredEvidence(state)).toContain('reportedResetAt');
  });

  it('reports nothing for a complete usage-limit state', () => {
    const state = parseTaskState(validUsageLimitState());
    expect(listMissingPreferredEvidence(state)).toHaveLength(0);
  });

  it('reports nothing for non-blocking states', () => {
    expect(listMissingPreferredEvidence(parseTaskState(validCreatedState()))).toHaveLength(0);
  });
});
