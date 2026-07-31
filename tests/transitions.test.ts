import { describe, expect, it } from 'vitest';

import { IllegalTransitionError } from '../src/core/errors.js';
import {
  ALL_STATES,
  BLOCKING_STATES,
  getStateKind,
  isBlockingState,
  isTerminalState,
  TERMINAL_STATES,
  type TaskStateName,
} from '../src/core/states.js';
import {
  assertTransition,
  canTransition,
  getAllowedTransitions,
  getForbiddenTransitions,
  listAllTransitions,
  TRANSITION_TABLE,
} from '../src/core/transitions.js';

const HAPPY_PATH: readonly TaskStateName[] = [
  'CREATED',
  'REPOSITORY_RESOLVED',
  'CONFIG_VALIDATED',
  'AUTH_PREFLIGHT',
  'GIT_PREFLIGHT',
  'WORKTREE_READY',
  'CONTEXT_LOADING',
  'IMPLEMENTING',
  'VERIFYING',
  'REVIEWING',
];

describe('state classification', () => {
  it('classifies exactly READY_FOR_PR and ABORTED as terminal', () => {
    expect(ALL_STATES.filter(isTerminalState)).toEqual([...TERMINAL_STATES].sort((a, b) =>
      ALL_STATES.indexOf(a) - ALL_STATES.indexOf(b),
    ));
  });

  it('does not classify ABORTED as blocking', () => {
    expect(isBlockingState('ABORTED')).toBe(false);
    expect(getStateKind('ABORTED')).toBe('TERMINAL');
  });

  it('classifies READY_FOR_PR as terminal, not regular', () => {
    expect(getStateKind('READY_FOR_PR')).toBe('TERMINAL');
  });

  it('classifies every blocking state as BLOCKING', () => {
    for (const state of BLOCKING_STATES) {
      expect(getStateKind(state)).toBe('BLOCKING');
    }
  });
});

describe('transition table integrity', () => {
  it('has an entry for every state', () => {
    for (const state of ALL_STATES) {
      expect(TRANSITION_TABLE[state]).toBeDefined();
    }
    expect(Object.keys(TRANSITION_TABLE).sort()).toEqual([...ALL_STATES].sort());
  });

  it('only ever targets known states', () => {
    for (const [from, to] of listAllTransitions()) {
      expect(ALL_STATES).toContain(to);
      expect(ALL_STATES).toContain(from);
    }
  });

  it('never lists a self-transition', () => {
    for (const state of ALL_STATES) {
      expect(TRANSITION_TABLE[state]).not.toContain(state);
    }
  });

  it('never lists a duplicate target', () => {
    for (const state of ALL_STATES) {
      const targets = TRANSITION_TABLE[state];
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it('gives terminal states no outgoing transitions', () => {
    for (const state of TERMINAL_STATES) {
      expect(TRANSITION_TABLE[state]).toHaveLength(0);
    }
  });

  it('leaves every non-terminal state with at least one way out', () => {
    for (const state of ALL_STATES) {
      if (isTerminalState(state)) continue;
      expect(TRANSITION_TABLE[state].length).toBeGreaterThan(0);
    }
  });

  it('makes every state reachable from CREATED', () => {
    const seen = new Set<TaskStateName>(['CREATED']);
    const queue: TaskStateName[] = ['CREATED'];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const next of TRANSITION_TABLE[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ALL_STATES].sort());
  });

  it('derives forbidden transitions as the exact complement of the allowed ones', () => {
    for (const from of ALL_STATES) {
      const allowed = new Set(getAllowedTransitions(from));
      const forbidden = getForbiddenTransitions(from);
      expect(allowed.size + forbidden.length).toBe(ALL_STATES.length);
      for (const to of forbidden) {
        expect(allowed.has(to)).toBe(false);
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe('legal transitions', () => {
  it('allows the full regular chain CREATED -> REVIEWING', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i += 1) {
      const from = HAPPY_PATH[i];
      const to = HAPPY_PATH[i + 1];
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect(canTransition(from as TaskStateName, to as TaskStateName)).toBe(true);
      expect(() => assertTransition(from as TaskStateName, to as TaskStateName)).not.toThrow();
    }
  });

  it.each(['READY_FOR_PR', 'REMEDIATING', 'HUMAN_DECISION_REQUIRED', 'BLOCKED_USAGE_LIMIT', 'ABORTED'] as const)(
    'allows REVIEWING -> %s',
    (to) => {
      expect(canTransition('REVIEWING', to)).toBe(true);
    },
  );

  it.each(['VERIFYING', 'BLOCKED_USAGE_LIMIT', 'HUMAN_DECISION_REQUIRED', 'ABORTED'] as const)(
    'allows REMEDIATING -> %s',
    (to) => {
      expect(canTransition('REMEDIATING', to)).toBe(true);
    },
  );

  it('supports the remediation loop REVIEWING -> REMEDIATING -> VERIFYING -> REVIEWING', () => {
    expect(() => {
      assertTransition('REVIEWING', 'REMEDIATING');
      assertTransition('REMEDIATING', 'VERIFYING');
      assertTransition('VERIFYING', 'REVIEWING');
    }).not.toThrow();
  });

  it('allows an automatic usage-limit resume back into each quota-consuming phase', () => {
    for (const to of ['IMPLEMENTING', 'REVIEWING', 'REMEDIATING'] as const) {
      expect(canTransition('BLOCKED_USAGE_LIMIT', to)).toBe(true);
    }
  });

  it('routes BLOCKED_AUTH back through a fresh auth preflight', () => {
    expect(canTransition('BLOCKED_AUTH', 'AUTH_PREFLIGHT')).toBe(true);
  });

  it('lets every non-terminal state escalate to a human or abort', () => {
    for (const state of ALL_STATES) {
      if (isTerminalState(state)) continue;
      expect(canTransition(state, 'ABORTED')).toBe(true);
      if (state !== 'HUMAN_DECISION_REQUIRED') {
        expect(canTransition(state, 'HUMAN_DECISION_REQUIRED')).toBe(true);
      }
    }
  });
});

describe('illegal transitions', () => {
  it.each([
    ['REVIEWING', 'IMPLEMENTING'],
    ['VERIFYING', 'CONTEXT_LOADING'],
    ['IMPLEMENTING', 'WORKTREE_READY'],
    ['WORKTREE_READY', 'GIT_PREFLIGHT'],
    ['CONFIG_VALIDATED', 'CREATED'],
    ['READY_FOR_PR', 'REVIEWING'],
  ] as const)('rejects the backwards jump %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
  });

  it.each(['READY_FOR_PR', 'ABORTED'] as const)('rejects every transition out of %s', (from) => {
    for (const to of ALL_STATES) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
    }
  });

  it('explains that a terminal source has no outgoing transitions', () => {
    expect(() => assertTransition('ABORTED', 'IMPLEMENTING')).toThrow(
      /ABORTED is a terminal state and has no outgoing transitions/,
    );
  });

  it('does not permit skipping the setup chain', () => {
    expect(canTransition('CREATED', 'IMPLEMENTING')).toBe(false);
    expect(canTransition('CONFIG_VALIDATED', 'WORKTREE_READY')).toBe(false);
  });

  it('does not allow a usage-limit block during deterministic verification', () => {
    // VERIFYING runs local project commands; no agent quota is consumed there.
    expect(canTransition('VERIFYING', 'BLOCKED_USAGE_LIMIT')).toBe(false);
    expect(canTransition('VERIFYING', 'BLOCKED_AUTH')).toBe(false);
  });

  it('does not let a human decision short-circuit review and go straight to READY_FOR_PR', () => {
    expect(canTransition('HUMAN_DECISION_REQUIRED', 'READY_FOR_PR')).toBe(false);
  });

  it('does not let non-resumable blocks return to the work loop', () => {
    for (const from of ['SCOPE_VIOLATION', 'RESUME_STATE_DIVERGED'] as const) {
      for (const to of ['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'REMEDIATING'] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('does not re-run a failed verification without a change', () => {
    expect(canTransition('BLOCKED_VERIFY', 'VERIFYING')).toBe(false);
    expect(canTransition('BLOCKED_VERIFY', 'REMEDIATING')).toBe(true);
  });

  it('reports the allowed alternatives in the error message', () => {
    try {
      assertTransition('CREATED', 'IMPLEMENTING');
      expect.unreachable('assertTransition should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      const message = (error as IllegalTransitionError).message;
      expect(message).toContain('CREATED -> IMPLEMENTING');
      expect(message).toContain('REPOSITORY_RESOLVED');
      expect((error as IllegalTransitionError).allowed).toEqual(getAllowedTransitions('CREATED'));
    }
  });
});

describe('transition-table stability', () => {
  /**
   * A change to this snapshot is a deliberate change to the state machine and
   * must be reviewed as such — it is not an incidental refactor.
   */
  it('matches the pinned edge set', () => {
    const edges = listAllTransitions().map(([from, to]) => `${from} -> ${to}`);
    expect(edges).toMatchInlineSnapshot(`
      [
        "CREATED -> REPOSITORY_RESOLVED",
        "CREATED -> HUMAN_DECISION_REQUIRED",
        "CREATED -> ABORTED",
        "REPOSITORY_RESOLVED -> CONFIG_VALIDATED",
        "REPOSITORY_RESOLVED -> HUMAN_DECISION_REQUIRED",
        "REPOSITORY_RESOLVED -> ABORTED",
        "CONFIG_VALIDATED -> AUTH_PREFLIGHT",
        "CONFIG_VALIDATED -> HUMAN_DECISION_REQUIRED",
        "CONFIG_VALIDATED -> ABORTED",
        "AUTH_PREFLIGHT -> GIT_PREFLIGHT",
        "AUTH_PREFLIGHT -> BLOCKED_AUTH",
        "AUTH_PREFLIGHT -> HUMAN_DECISION_REQUIRED",
        "AUTH_PREFLIGHT -> ABORTED",
        "GIT_PREFLIGHT -> WORKTREE_READY",
        "GIT_PREFLIGHT -> SCOPE_VIOLATION",
        "GIT_PREFLIGHT -> HUMAN_DECISION_REQUIRED",
        "GIT_PREFLIGHT -> ABORTED",
        "WORKTREE_READY -> CONTEXT_LOADING",
        "WORKTREE_READY -> RESUME_STATE_DIVERGED",
        "WORKTREE_READY -> HUMAN_DECISION_REQUIRED",
        "WORKTREE_READY -> ABORTED",
        "CONTEXT_LOADING -> IMPLEMENTING",
        "CONTEXT_LOADING -> HUMAN_DECISION_REQUIRED",
        "CONTEXT_LOADING -> ABORTED",
        "IMPLEMENTING -> VERIFYING",
        "IMPLEMENTING -> BLOCKED_AUTH",
        "IMPLEMENTING -> BLOCKED_USAGE_LIMIT",
        "IMPLEMENTING -> SCOPE_VIOLATION",
        "IMPLEMENTING -> HUMAN_DECISION_REQUIRED",
        "IMPLEMENTING -> ABORTED",
        "VERIFYING -> REVIEWING",
        "VERIFYING -> BLOCKED_VERIFY",
        "VERIFYING -> HUMAN_DECISION_REQUIRED",
        "VERIFYING -> ABORTED",
        "REVIEWING -> READY_FOR_PR",
        "REVIEWING -> REMEDIATING",
        "REVIEWING -> BLOCKED_AUTH",
        "REVIEWING -> BLOCKED_USAGE_LIMIT",
        "REVIEWING -> SCOPE_VIOLATION",
        "REVIEWING -> HUMAN_DECISION_REQUIRED",
        "REVIEWING -> ABORTED",
        "REMEDIATING -> VERIFYING",
        "REMEDIATING -> BLOCKED_AUTH",
        "REMEDIATING -> BLOCKED_USAGE_LIMIT",
        "REMEDIATING -> SCOPE_VIOLATION",
        "REMEDIATING -> HUMAN_DECISION_REQUIRED",
        "REMEDIATING -> ABORTED",
        "BLOCKED_AUTH -> AUTH_PREFLIGHT",
        "BLOCKED_AUTH -> HUMAN_DECISION_REQUIRED",
        "BLOCKED_AUTH -> ABORTED",
        "BLOCKED_USAGE_LIMIT -> IMPLEMENTING",
        "BLOCKED_USAGE_LIMIT -> REVIEWING",
        "BLOCKED_USAGE_LIMIT -> REMEDIATING",
        "BLOCKED_USAGE_LIMIT -> RESUME_STATE_DIVERGED",
        "BLOCKED_USAGE_LIMIT -> HUMAN_DECISION_REQUIRED",
        "BLOCKED_USAGE_LIMIT -> ABORTED",
        "BLOCKED_VERIFY -> REMEDIATING",
        "BLOCKED_VERIFY -> HUMAN_DECISION_REQUIRED",
        "BLOCKED_VERIFY -> ABORTED",
        "SCOPE_VIOLATION -> HUMAN_DECISION_REQUIRED",
        "SCOPE_VIOLATION -> ABORTED",
        "RESUME_STATE_DIVERGED -> HUMAN_DECISION_REQUIRED",
        "RESUME_STATE_DIVERGED -> ABORTED",
        "HUMAN_DECISION_REQUIRED -> IMPLEMENTING",
        "HUMAN_DECISION_REQUIRED -> VERIFYING",
        "HUMAN_DECISION_REQUIRED -> REVIEWING",
        "HUMAN_DECISION_REQUIRED -> REMEDIATING",
        "HUMAN_DECISION_REQUIRED -> ABORTED",
      ]
    `);
  });
});
