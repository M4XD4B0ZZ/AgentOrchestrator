/**
 * The single, explicit source of truth for legal task-state transitions.
 *
 * Rules of this module:
 *  - Every legal transition is listed in {@link TRANSITION_TABLE}. There is no
 *    "any state may go to any error state" catch-all: each error edge is
 *    listed deliberately, next to a comment explaining *why* that error can
 *    physically occur in that state.
 *  - Illegal transitions are derived from the table (complement), never
 *    maintained by hand.
 *  - Pure: no I/O, no clock, no randomness.
 */

import { ALL_STATES, getStateKind, isTerminalState, type TaskStateName } from './states.js';
import { IllegalTransitionError } from './errors.js';

/**
 * Allowed successor states per state.
 *
 * Design notes for the error edges:
 *
 *  - `BLOCKED_AUTH` is only reachable where an *agent* is actually invoked or
 *    where agent credentials are actively checked: `AUTH_PREFLIGHT`,
 *    `IMPLEMENTING`, `REVIEWING`, `REMEDIATING`. A token can expire mid-run.
 *  - `BLOCKED_USAGE_LIMIT` is only reachable from states that consume agent
 *    quota: `IMPLEMENTING`, `REVIEWING`, `REMEDIATING`. Notably *not* from
 *    `VERIFYING`: verification runs deterministic local project commands and
 *    involves no agent, so it cannot hit a subscription usage limit.
 *  - `BLOCKED_VERIFY` is only reachable from `VERIFYING`, because that is the
 *    only state that executes the verification commands.
 *  - `SCOPE_VIOLATION` is reachable from `GIT_PREFLIGHT` (the resolved
 *    repository/worktree is outside the configured scope) and from the three
 *    agent-executing states. It is reachable from `REVIEWING` on purpose: the
 *    reviewer is contractually read-only, so any write attempt by it is a
 *    scope violation.
 *  - `RESUME_STATE_DIVERGED` is reachable from `WORKTREE_READY` (the persisted
 *    state does not match what is actually on disk when re-attaching) and from
 *    `BLOCKED_USAGE_LIMIT` (the world moved on while we waited for the quota
 *    reset).
 *  - `HUMAN_DECISION_REQUIRED` is reachable from every non-terminal state:
 *    the operator may always be asked. This is the one broad rule in the
 *    table and it is safe by construction, because it strictly *reduces*
 *    autonomy — it can never let the loop do something on its own that it
 *    could not otherwise do.
 *  - `ABORTED` is likewise reachable from every non-terminal state: giving up
 *    must always be possible, and it is terminal, so it cannot widen autonomy.
 */
export const TRANSITION_TABLE: Readonly<Record<TaskStateName, readonly TaskStateName[]>> =
  Object.freeze({
    // --- setup chain -------------------------------------------------------
    // Nothing has been executed yet, so no auth/git/verify failure is possible.
    CREATED: ['REPOSITORY_RESOLVED', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],
    REPOSITORY_RESOLVED: ['CONFIG_VALIDATED', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],
    CONFIG_VALIDATED: ['AUTH_PREFLIGHT', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // Auth is actively probed here.
    AUTH_PREFLIGHT: ['GIT_PREFLIGHT', 'BLOCKED_AUTH', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // Repository/worktree location is validated against the configured scope.
    GIT_PREFLIGHT: ['WORKTREE_READY', 'SCOPE_VIOLATION', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // Re-attaching to an existing worktree can reveal a diverged persisted state.
    WORKTREE_READY: [
      'CONTEXT_LOADING',
      'RESUME_STATE_DIVERGED',
      'HUMAN_DECISION_REQUIRED',
      'ABORTED',
    ],
    CONTEXT_LOADING: ['IMPLEMENTING', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // --- work loop ---------------------------------------------------------
    // Writing agent (Claude Code) runs here: auth, quota and scope can all fail.
    IMPLEMENTING: [
      'VERIFYING',
      'BLOCKED_AUTH',
      'BLOCKED_USAGE_LIMIT',
      'SCOPE_VIOLATION',
      'HUMAN_DECISION_REQUIRED',
      'ABORTED',
    ],

    // Deterministic local verification: no agent, hence no auth/quota edge.
    VERIFYING: ['REVIEWING', 'BLOCKED_VERIFY', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // Read-only reviewer (Codex) runs here.
    REVIEWING: [
      'READY_FOR_PR',
      'REMEDIATING',
      'BLOCKED_AUTH',
      'BLOCKED_USAGE_LIMIT',
      'SCOPE_VIOLATION',
      'HUMAN_DECISION_REQUIRED',
      'ABORTED',
    ],

    // Writing agent runs again to address findings; loops back to VERIFYING.
    REMEDIATING: [
      'VERIFYING',
      'BLOCKED_AUTH',
      'BLOCKED_USAGE_LIMIT',
      'SCOPE_VIOLATION',
      'HUMAN_DECISION_REQUIRED',
      'ABORTED',
    ],

    // --- terminal ----------------------------------------------------------
    READY_FOR_PR: [],
    ABORTED: [],

    // --- blocking states ---------------------------------------------------
    // After the operator re-authenticates, auth is re-proven from scratch
    // rather than trusted; the setup chain then leads back into the work loop.
    BLOCKED_AUTH: ['AUTH_PREFLIGHT', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // The only automatically resumable block. It returns to exactly the phase
    // that was interrupted, which is why only the three quota-consuming states
    // are listed. `RESUME_STATE_DIVERGED` covers the case where the worktree
    // changed underneath us while we waited.
    BLOCKED_USAGE_LIMIT: [
      'IMPLEMENTING',
      'REVIEWING',
      'REMEDIATING',
      'RESUME_STATE_DIVERGED',
      'HUMAN_DECISION_REQUIRED',
      'ABORTED',
    ],

    // A failed verification is handed to the writing agent for remediation, or
    // escalated. It never goes straight back to VERIFYING: re-running the same
    // verification without a change would just fail again.
    BLOCKED_VERIFY: ['REMEDIATING', 'HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // Never automatically resumable: an agent left its sandbox, so a human has
    // to look at the damage before anything else happens.
    SCOPE_VIOLATION: ['HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // Never automatically resumable: persisted state and reality disagree, and
    // guessing which one is right is exactly what we must not do.
    RESUME_STATE_DIVERGED: ['HUMAN_DECISION_REQUIRED', 'ABORTED'],

    // The operator decides where to continue. Deliberately *not* including
    // `READY_FOR_PR`: approving a task must go through a real REVIEWING pass,
    // it cannot be short-circuited by a decision prompt.
    HUMAN_DECISION_REQUIRED: ['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'REMEDIATING', 'ABORTED'],
  } satisfies Record<TaskStateName, readonly TaskStateName[]>);

/** Allowed successors of `from`. Empty for terminal states. */
export function getAllowedTransitions(from: TaskStateName): readonly TaskStateName[] {
  return TRANSITION_TABLE[from];
}

/**
 * Every transition that is *not* in the table, derived rather than hand-written
 * so that the two can never drift apart.
 */
export function getForbiddenTransitions(from: TaskStateName): readonly TaskStateName[] {
  const allowed = new Set<string>(TRANSITION_TABLE[from]);
  return ALL_STATES.filter((to) => !allowed.has(to));
}

/** All legal `(from, to)` pairs, in a stable order. */
export function listAllTransitions(): readonly (readonly [TaskStateName, TaskStateName])[] {
  const pairs: (readonly [TaskStateName, TaskStateName])[] = [];
  for (const from of ALL_STATES) {
    for (const to of TRANSITION_TABLE[from]) {
      pairs.push([from, to]);
    }
  }
  return pairs;
}

export function canTransition(from: TaskStateName, to: TaskStateName): boolean {
  return TRANSITION_TABLE[from].includes(to);
}

/**
 * Like {@link canTransition}, but throws an {@link IllegalTransitionError} with
 * a domain-specific explanation instead of returning `false`.
 */
export function assertTransition(from: TaskStateName, to: TaskStateName): void {
  if (canTransition(from, to)) return;

  const reason = isTerminalState(from)
    ? `${from} is a terminal state and has no outgoing transitions`
    : `${to} is not a declared successor of ${from} ` +
      `(${getStateKind(from)} -> ${getStateKind(to)})`;

  throw new IllegalTransitionError(from, to, TRANSITION_TABLE[from], reason);
}
