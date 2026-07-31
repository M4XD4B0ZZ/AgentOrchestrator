import { describe, expect, it } from 'vitest';

import { InvalidResumePointError } from '../src/core/errors.js';
import { BLOCKING_STATES, RESUME_PHASES } from '../src/core/states.js';
import {
  BLOCKED_STATE_POLICIES,
  formatResumePoint,
  getBlockedStatePolicy,
  isAutomaticResumeAllowed,
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

  it('never allows an automatic resume for a non-resumable state', () => {
    for (const state of BLOCKING_STATES) {
      const policy = BLOCKED_STATE_POLICIES[state];
      if (!policy.resumable) expect(policy.automaticResumeAllowed).toBe(false);
    }
  });

  it('never combines an automatic resume with a required human decision', () => {
    for (const state of BLOCKING_STATES) {
      const policy = BLOCKED_STATE_POLICIES[state];
      expect(policy.automaticResumeAllowed && policy.requiresHumanDecision).toBe(false);
    }
  });

  it('permits an unattended resume only for BLOCKED_USAGE_LIMIT', () => {
    const automatic = BLOCKING_STATES.filter(isAutomaticResumeAllowed);
    expect(automatic).toEqual(['BLOCKED_USAGE_LIMIT']);
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
      expect(isAutomaticResumeAllowed(state)).toBe(false);
      expect(requiresHumanDecision(state)).toBe(false);
      expect(requiresResumePoint(state)).toBe(false);
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

describe('resume points', () => {
  it('maps every phase to a state the transition table knows', () => {
    for (const phase of RESUME_PHASES) {
      const target = resumePointToState({ phase, round: 1 });
      expect(['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'REMEDIATING']).toContain(target);
    }
  });

  it('lets an automatically resumable block reach its own resume target', () => {
    for (const phase of ['IMPLEMENT', 'REVIEW', 'REMEDIATE'] as const) {
      const target = resumePointToState({ phase, round: 1 });
      expect(canTransition('BLOCKED_USAGE_LIMIT', target)).toBe(true);
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

  it.each(['IMPLEMENT', 'IMPLEMENT_ROUND_', 'DEPLOY_ROUND_1', 'IMPLEMENT_ROUND_0', 'implement_round_1'])(
    'rejects the malformed resume point %j',
    (text) => {
      expect(() => parseResumePoint(text)).toThrow(InvalidResumePointError);
    },
  );

  it('rejects an unknown phase at runtime', () => {
    expect(() => resumePointToState({ phase: 'DEPLOY' as never, round: 1 })).toThrow(
      InvalidResumePointError,
    );
  });
});
