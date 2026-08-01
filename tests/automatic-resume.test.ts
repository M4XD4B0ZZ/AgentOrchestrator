import { describe, expect, it } from 'vitest';

import {
  canonicalPathsEqual,
  evaluateAutomaticResume,
  type AutomaticResumeEvidence,
} from '../src/core/automatic-resume.js';
import { parseTaskState } from '../src/core/task-state.js';
import {
  positiveResumeEvidence,
  SHA_A,
  SHA_B,
  validCreatedState,
  validUsageLimitState,
} from './fixtures.js';

const usageLimit = (overrides = {}) => parseTaskState(validUsageLimitState(overrides));

function decide(stateOverrides = {}, evidenceOverrides: Partial<AutomaticResumeEvidence> = {}) {
  return evaluateAutomaticResume(
    usageLimit(stateOverrides),
    positiveResumeEvidence(evidenceOverrides),
  );
}

describe('evaluateAutomaticResume', () => {
  it('allows the resume only when every check produced positive evidence', () => {
    const decision = decide();
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCodes).toEqual([]);
    expect(decision.missingChecks).toEqual([]);
  });

  it('is pure: the same inputs always yield the same verdict', () => {
    expect(decide()).toEqual(decide());
  });

  // ── Eligibility ─────────────────────────────────────────────────────────
  it('refuses every state that is not eligible for an unattended resume', () => {
    for (const state of ['BLOCKED_AUTH', 'BLOCKED_VERIFY', 'HUMAN_DECISION_REQUIRED'] as const) {
      const parsed = parseTaskState(
        validCreatedState({
          state,
          reviewRound: 1,
          basePinnedCommit: SHA_A,
          currentCommit: SHA_B,
          blockedAgent: state === 'BLOCKED_AUTH' ? 'claude' : null,
          resumeFrom: {
            phase: state === 'BLOCKED_VERIFY' ? 'REMEDIATE' : 'IMPLEMENT',
            round: 1,
          },
        }),
      );
      const decision = evaluateAutomaticResume(parsed, positiveResumeEvidence());
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCodes).toContain('STATE_NOT_ELIGIBLE_FOR_UNATTENDED_RESUME');
    }
  });

  it('refuses a non-blocking state outright', () => {
    const decision = evaluateAutomaticResume(
      parseTaskState(validCreatedState({ state: 'IMPLEMENTING' })),
      positiveResumeEvidence(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toEqual(['STATE_NOT_BLOCKING']);
  });

  // ── The reset time is mandatory for an unattended resume ────────────────
  it('refuses when no quota reset time was ever reported', () => {
    const decision = decide({ reportedResetAt: null });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('RESET_TIME_MISSING');
  });

  it('refuses while the reported reset time has not passed', () => {
    const decision = decide({}, { now: '2026-07-31T13:59:59.000Z' });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('RESET_TIME_NOT_REACHED');
  });

  it('refuses at exactly the reset instant — the block must be demonstrably over', () => {
    const decision = decide({}, { now: '2026-07-31T14:00:00.000Z' });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('RESET_TIME_NOT_REACHED');
  });

  it('allows one millisecond after the reset instant', () => {
    expect(decide({}, { now: '2026-07-31T14:00:00.001Z' }).allowed).toBe(true);
  });

  it('refuses when the current time is not a usable timestamp', () => {
    const decision = decide({}, { now: 'later' });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('CURRENT_TIME_UNPARSEABLE');
  });

  it('accepts a Date as the current instant', () => {
    expect(decide({}, { now: new Date('2026-08-01T00:00:00.000Z') }).allowed).toBe(true);
  });

  // ── Every remaining check, one at a time ────────────────────────────────
  it.each([
    ['auth was not re-proven', { authPreflightPassed: false }, 'AUTH_PREFLIGHT_NOT_PASSED'],
    ['the repository id changed', { observedRepositoryId: 'repo-beta' }, 'REPOSITORY_ID_MISMATCH'],
    ['the repository id is unknown', { observedRepositoryId: null }, 'REPOSITORY_ID_MISMATCH'],
    [
      'the repository root moved',
      { observedRepositoryRoot: '/srv/projects/beta' },
      'REPOSITORY_ROOT_MISMATCH',
    ],
    ['the repository root is unknown', { observedRepositoryRoot: null }, 'REPOSITORY_ROOT_MISMATCH'],
    [
      'the worktree path moved',
      { observedWorktreePath: '/srv/worktrees/other' },
      'WORKTREE_PATH_MISMATCH',
    ],
    ['the worktree is gone', { worktreeExists: false }, 'WORKTREE_MISSING'],
    [
      'the pinned base commit moved',
      { observedBasePinnedCommit: 'b'.repeat(40) },
      'BASE_COMMIT_MISMATCH',
    ],
    ['the base commit is unknown', { observedBasePinnedCommit: null }, 'BASE_COMMIT_MISMATCH'],
    ['the head commit moved', { observedCurrentCommit: 'c'.repeat(40) }, 'CURRENT_COMMIT_MISMATCH'],
    ['the worktree is dirty', { worktreeClean: false }, 'WORKTREE_NOT_CLEAN'],
    ['a divergence was reported', { divergenceDetected: true }, 'DIVERGENCE_DETECTED'],
  ])('refuses when %s', (_label, evidenceOverrides, code) => {
    const decision = decide({}, evidenceOverrides);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain(code);
    expect(decision.missingChecks.length).toBe(decision.reasonCodes.length);
  });

  it('refuses when the persisted checkpoint itself was not clean', () => {
    const decision = decide({ worktreeCleanAtCheckpoint: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('WORKTREE_NOT_CLEAN');
  });

  it('refuses when the state never pinned a base commit', () => {
    const decision = decide({ basePinnedCommit: null }, { observedBasePinnedCommit: null });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('BASE_COMMIT_MISMATCH');
  });

  it('collects every failing check rather than stopping at the first', () => {
    const decision = decide(
      { reportedResetAt: null },
      { authPreflightPassed: false, worktreeClean: false, divergenceDetected: true },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        'RESET_TIME_MISSING',
        'AUTH_PREFLIGHT_NOT_PASSED',
        'WORKTREE_NOT_CLEAN',
        'DIVERGENCE_DETECTED',
      ]),
    );
  });

  it('names a human-readable check for every reason code', () => {
    const decision = decide({}, { authPreflightPassed: false });
    expect(decision.missingChecks).toEqual(['auth preflight passed again']);
  });
});

describe('canonicalPathsEqual', () => {
  it('treats a trailing separator as insignificant', () => {
    expect(canonicalPathsEqual('/srv/projects/alpha/', '/srv/projects/alpha')).toBe(true);
  });

  it('normalises traversal segments', () => {
    expect(canonicalPathsEqual('/srv/projects/beta/../alpha', '/srv/projects/alpha')).toBe(true);
  });

  it('does not treat a sibling as equal', () => {
    expect(canonicalPathsEqual('/srv/projects/alpha2', '/srv/projects/alpha')).toBe(false);
  });

  it.runIf(process.platform === 'win32')('compares case-insensitively on Windows', () => {
    expect(canonicalPathsEqual('D:\\Repos\\Alpha', 'd:\\repos\\alpha')).toBe(true);
  });
});
