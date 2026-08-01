import { describe, expect, it } from 'vitest';

import { InvalidResumePointError } from '../src/core/errors.js';
import { BLOCKING_STATES, RESUME_PHASES, type ResumePhase } from '../src/core/states.js';
import { MAX_ROUND, ResumePointSchema } from '../src/core/resume-point.js';
import {
  allowedResumePhases,
  BLOCKED_STATE_POLICIES,
  forbidsResumePoint,
  formatResumePoint,
  getBlockedStatePolicy,
  isAllowedResumePhase,
  isAutomaticResumeEligible,
  isResumableState,
  parseResumePoint,
  requiresBlockedAgent,
  requiresHumanDecision,
  requiresResumePoint,
  resumePointToState,
} from '../src/core/resume-policy.js';
import { canTransition } from '../src/core/transitions.js';

describe('blocked-state policies', () => {
  it('covers every blocking state exactly once', () => {
    expect(Object.keys(BLOCKED_STATE_POLICIES).sort()).toEqual([...BLOCKING_STATES].sort());
  });

  it('keeps each policy self-consistent with its own state name', () => {
    for (const state of BLOCKING_STATES) {
      expect(getBlockedStatePolicy(state).state).toBe(state);
    }
  });

  it('requires a resume point exactly where the state is resumable', () => {
    for (const state of BLOCKING_STATES) {
      const policy = BLOCKED_STATE_POLICIES[state];
      expect(policy.resumeFromRequirement === 'REQUIRED').toBe(policy.resumable);
    }
  });

  it('never marks a non-resumable state as eligible for an unattended resume', () => {
    for (const state of BLOCKING_STATES) {
      const policy = BLOCKED_STATE_POLICIES[state];
      if (!policy.resumable) expect(policy.automaticResumeEligible).toBe(false);
    }
  });

  it('never combines unattended-resume eligibility with a required human decision', () => {
    for (const state of BLOCKING_STATES) {
      const policy = BLOCKED_STATE_POLICIES[state];
      expect(policy.automaticResumeEligible && policy.requiresHumanDecision).toBe(false);
    }
  });

  it('considers an unattended resume only for BLOCKED_USAGE_LIMIT', () => {
    expect(BLOCKING_STATES.filter(isAutomaticResumeEligible)).toEqual(['BLOCKED_USAGE_LIMIT']);
  });

  it('requires the blocked agent to be named exactly for auth and usage-limit blocks', () => {
    expect(BLOCKING_STATES.filter(requiresBlockedAgent).sort()).toEqual([
      'BLOCKED_AUTH',
      'BLOCKED_USAGE_LIMIT',
    ]);
  });

  it('marks scope violations and diverged resumes as non-resumable', () => {
    expect(isResumableState('SCOPE_VIOLATION')).toBe(false);
    expect(isResumableState('RESUME_STATE_DIVERGED')).toBe(false);
    expect(requiresHumanDecision('SCOPE_VIOLATION')).toBe(true);
    expect(requiresHumanDecision('RESUME_STATE_DIVERGED')).toBe(true);
  });

  it('reports non-blocking states as neither resumable nor human-gated', () => {
    for (const state of ['CREATED', 'IMPLEMENTING', 'READY_FOR_PR', 'ABORTED'] as const) {
      expect(isResumableState(state)).toBe(false);
      expect(isAutomaticResumeEligible(state)).toBe(false);
      expect(requiresHumanDecision(state)).toBe(false);
      expect(requiresResumePoint(state)).toBe(false);
      expect(allowedResumePhases(state)).toEqual([]);
    }
  });

  it('only allows blockedAgent values the transition table can produce', () => {
    for (const state of BLOCKING_STATES) {
      for (const agent of BLOCKED_STATE_POLICIES[state].allowedBlockedAgents) {
        expect(agent === null || agent === 'claude' || agent === 'codex').toBe(true);
      }
    }
  });

  it('gives every policy a non-empty rationale', () => {
    for (const state of BLOCKING_STATES) {
      expect(BLOCKED_STATE_POLICIES[state].rationale.length).toBeGreaterThan(20);
    }
  });
});

// ── AO-004: one derived source for allowed resume phases ────────────────────

describe('allowed resume phases per blocking state', () => {
  const EXPECTED: Readonly<Record<string, readonly ResumePhase[]>> = {
    // Re-entry runs through AUTH_PREFLIGHT and carries the stored point along,
    // so exactly the phases that can *lose* auth are legitimate. Not VERIFY:
    // verification uses no agent credentials.
    BLOCKED_AUTH: ['IMPLEMENT', 'REVIEW', 'REMEDIATE'],
    // Direct re-entry; VERIFYING is not a successor because verification burns
    // no agent quota, so a VERIFY resume point is unreachable.
    BLOCKED_USAGE_LIMIT: ['IMPLEMENT', 'REVIEW', 'REMEDIATE'],
    // A failed verification is only ever handed to remediation.
    BLOCKED_VERIFY: ['REMEDIATE'],
    // The operator may pick any work phase.
    HUMAN_DECISION_REQUIRED: ['IMPLEMENT', 'VERIFY', 'REVIEW', 'REMEDIATE'],
    // Not continuable at all.
    SCOPE_VIOLATION: [],
    RESUME_STATE_DIVERGED: [],
  };

  it.each(BLOCKING_STATES)('declares the expected phase set for %s', (state) => {
    expect([...allowedResumePhases(state)]).toEqual([...(EXPECTED[state] ?? [])]);
  });

  it('rejects VERIFY for BLOCKED_USAGE_LIMIT, which has no way back to VERIFYING', () => {
    expect(isAllowedResumePhase('BLOCKED_USAGE_LIMIT', 'VERIFY')).toBe(false);
    expect(canTransition('BLOCKED_USAGE_LIMIT', 'VERIFYING')).toBe(false);
  });

  it('allows only REMEDIATE for BLOCKED_VERIFY', () => {
    for (const phase of RESUME_PHASES) {
      expect(isAllowedResumePhase('BLOCKED_VERIFY', phase)).toBe(phase === 'REMEDIATE');
    }
  });

  it('preserves every interrupted phase across a re-authentication', () => {
    // The point is that BLOCKED_AUTH does not collapse to IMPLEMENT: a review
    // or a remediation interrupted by an expired token resumes where it was.
    for (const phase of ['IMPLEMENT', 'REVIEW', 'REMEDIATE'] as const) {
      expect(isAllowedResumePhase('BLOCKED_AUTH', phase)).toBe(true);
      // …and each of those phases really can enter BLOCKED_AUTH.
      expect(canTransition(resumePointToState({ phase, round: 1 }), 'BLOCKED_AUTH')).toBe(true);
    }
    expect(isAllowedResumePhase('BLOCKED_AUTH', 'VERIFY')).toBe(false);
  });

  it('lets a directly resumed block reach every phase it declares', () => {
    for (const state of BLOCKING_STATES) {
      if (BLOCKED_STATE_POLICIES[state].resumeReentry !== 'DIRECT') continue;
      for (const phase of allowedResumePhases(state)) {
        expect(canTransition(state, resumePointToState({ phase, round: 1 }))).toBe(true);
      }
    }
  });

  it('routes an auth-gated resume through a real AUTH_PREFLIGHT edge', () => {
    for (const state of BLOCKING_STATES) {
      if (BLOCKED_STATE_POLICIES[state].resumeReentry !== 'VIA_AUTH_PREFLIGHT') continue;
      expect(canTransition(state, 'AUTH_PREFLIGHT')).toBe(true);
    }
  });

  it('declares no phases exactly for the states that forbid a resume point', () => {
    for (const state of BLOCKING_STATES) {
      expect(forbidsResumePoint(state)).toBe(allowedResumePhases(state).length === 0);
      expect(forbidsResumePoint(state)).toBe(!BLOCKED_STATE_POLICIES[state].resumable);
    }
  });

  it('never declares a phase whose target is not a known work state', () => {
    for (const state of BLOCKING_STATES) {
      for (const phase of allowedResumePhases(state)) {
        expect(['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'REMEDIATING']).toContain(
          resumePointToState({ phase, round: 1 }),
        );
      }
    }
  });
});

describe('resume points', () => {
  it('maps every phase to a state the transition table knows', () => {
    for (const phase of RESUME_PHASES) {
      const target = resumePointToState({ phase, round: 1 });
      expect(['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'REMEDIATING']).toContain(target);
    }
  });

  it('round-trips the display form', () => {
    for (const phase of RESUME_PHASES) {
      const point = { phase, round: 2 };
      expect(parseResumePoint(formatResumePoint(point))).toEqual(point);
    }
  });

  it('formats the documented shorthand', () => {
    expect(formatResumePoint({ phase: 'IMPLEMENT', round: 1 })).toBe('IMPLEMENT_ROUND_1');
    expect(formatResumePoint({ phase: 'REMEDIATE', round: 7 })).toBe('REMEDIATE_ROUND_7');
  });

  it.each([
    'IMPLEMENT',
    'IMPLEMENT_ROUND_',
    'DEPLOY_ROUND_1',
    'IMPLEMENT_ROUND_0',
    'implement_round_1',
  ])('rejects the malformed resume point %j', (text) => {
    expect(() => parseResumePoint(text)).toThrow(InvalidResumePointError);
  });

  it('rejects an unknown phase at runtime', () => {
    expect(() => resumePointToState({ phase: 'DEPLOY' as never, round: 1 })).toThrow(
      InvalidResumePointError,
    );
  });
});

// ── AO-012: the parser cannot produce a point the schema rejects ────────────

describe('parseResumePoint hardening', () => {
  it.each([
    ['an extremely long digit sequence', `IMPLEMENT_ROUND_${'9'.repeat(400)}`],
    ['an unsafe integer', `IMPLEMENT_ROUND_${'9'.repeat(17)}`],
    ['a value above the schema ceiling', `IMPLEMENT_ROUND_${MAX_ROUND + 1}`],
    ['a leading-zero padded overflow', `IMPLEMENT_ROUND_${'0'.repeat(20)}1`],
    ['Infinity', 'IMPLEMENT_ROUND_Infinity'],
    ['NaN', 'IMPLEMENT_ROUND_NaN'],
    ['an exponent', 'IMPLEMENT_ROUND_1e9'],
    ['a hex literal', 'IMPLEMENT_ROUND_0x10'],
    ['a negative round', 'IMPLEMENT_ROUND_-1'],
    ['a fractional round', 'IMPLEMENT_ROUND_1.5'],
    ['round zero', 'IMPLEMENT_ROUND_0'],
    ['whitespace padding', ' IMPLEMENT_ROUND_1 '],
  ])('rejects %s', (_label, text) => {
    expect(() => parseResumePoint(text)).toThrow(InvalidResumePointError);
  });

  it('accepts the highest round the schema allows', () => {
    const point = parseResumePoint(`REVIEW_ROUND_${MAX_ROUND}`);
    expect(point).toEqual({ phase: 'REVIEW', round: MAX_ROUND });
  });

  it('only ever produces values ResumePointSchema accepts', () => {
    for (const phase of RESUME_PHASES) {
      for (const round of [1, 2, 9, 99, MAX_ROUND]) {
        const parsed = parseResumePoint(`${phase}_ROUND_${round}`);
        expect(ResumePointSchema.safeParse(parsed).success).toBe(true);
      }
    }
  });

  it('rejects every malformed input the schema would also reject', () => {
    // Property-style cross-check: whatever the parser returns must validate,
    // and whatever it throws on must not be silently coerced.
    const inputs = [
      'IMPLEMENT_ROUND_1',
      'VERIFY_ROUND_3',
      `REVIEW_ROUND_${MAX_ROUND + 5}`,
      'REMEDIATE_ROUND_-2',
      'IMPLEMENT_ROUND_00000000000000000009',
    ];
    for (const input of inputs) {
      let parsed: unknown;
      try {
        parsed = parseResumePoint(input);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidResumePointError);
        continue;
      }
      expect(ResumePointSchema.safeParse(parsed).success).toBe(true);
    }
  });
});
