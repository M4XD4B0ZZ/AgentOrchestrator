/**
 * Canonical task-state vocabulary and its classification.
 *
 * This module is deliberately free of side effects and free of any dependency
 * on Zod, the CLI, or the filesystem, so that the state vocabulary can be
 * imported by the schema, the transition table and the tests alike.
 */

/**
 * Regular (non-error) states of a single orchestrated task.
 *
 * `READY_FOR_PR` is a regular state but is also *terminal*: it is the intended
 * successful end of a task run. See {@link TERMINAL_STATES}.
 */
export const REGULAR_STATES = [
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
  'REMEDIATING',
  'READY_FOR_PR',
] as const;

/**
 * Blocking / terminal states.
 *
 * "Blocking" means: the task cannot make progress on its own right now.
 * Whether a blocking state can *ever* be continued is expressed separately in
 * `resume-policy.ts` — see `BLOCKED_STATE_POLICIES`.
 *
 * `ABORTED` is listed here but is terminal, not blocking: nothing continues
 * from it.
 */
export const BLOCKING_OR_TERMINAL_STATES = [
  'BLOCKED_AUTH',
  'BLOCKED_USAGE_LIMIT',
  'BLOCKED_VERIFY',
  'SCOPE_VIOLATION',
  'RESUME_STATE_DIVERGED',
  'HUMAN_DECISION_REQUIRED',
  'ABORTED',
] as const;

export const ALL_STATES = [...REGULAR_STATES, ...BLOCKING_OR_TERMINAL_STATES] as const;

export type RegularState = (typeof REGULAR_STATES)[number];
export type BlockingOrTerminalState = (typeof BLOCKING_OR_TERMINAL_STATES)[number];
export type TaskStateName = (typeof ALL_STATES)[number];

/**
 * Terminal states. A terminal state has *no* outgoing transitions at all:
 *
 * - `READY_FOR_PR` — the task finished successfully; handing over to a human
 *   for the actual PR is out of scope for the orchestrator loop.
 * - `ABORTED`      — the task was given up on, deliberately and irreversibly.
 *
 * Everything else, including every blocking state, has at least one documented
 * outgoing transition.
 */
export const TERMINAL_STATES = ['READY_FOR_PR', 'ABORTED'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/**
 * States that represent "the task is stuck and something outside the normal
 * happy path has to happen". These are exactly the blocking/terminal states
 * minus `ABORTED` (which is an end, not a block).
 */
export const BLOCKING_STATES = [
  'BLOCKED_AUTH',
  'BLOCKED_USAGE_LIMIT',
  'BLOCKED_VERIFY',
  'SCOPE_VIOLATION',
  'RESUME_STATE_DIVERGED',
  'HUMAN_DECISION_REQUIRED',
] as const;
export type BlockingState = (typeof BLOCKING_STATES)[number];

/** Coarse classification used by the transition table and by reporting. */
export type StateKind = 'REGULAR' | 'BLOCKING' | 'TERMINAL';

const TERMINAL_SET: ReadonlySet<string> = new Set<string>(TERMINAL_STATES);
const BLOCKING_SET: ReadonlySet<string> = new Set<string>(BLOCKING_STATES);
const ALL_SET: ReadonlySet<string> = new Set<string>(ALL_STATES);

export function isTaskStateName(value: unknown): value is TaskStateName {
  return typeof value === 'string' && ALL_SET.has(value);
}

/** `true` for states with no outgoing transitions (`READY_FOR_PR`, `ABORTED`). */
export function isTerminalState(state: TaskStateName): state is TerminalState {
  return TERMINAL_SET.has(state);
}

/** `true` for states in which the task is stuck (excludes `ABORTED`). */
export function isBlockingState(state: TaskStateName): state is BlockingState {
  return BLOCKING_SET.has(state);
}

/**
 * Terminal wins over blocking: `ABORTED` is classified TERMINAL even though it
 * appears in the blocking/terminal enum, and `READY_FOR_PR` is classified
 * TERMINAL even though it appears in the regular enum.
 */
export function getStateKind(state: TaskStateName): StateKind {
  if (isTerminalState(state)) return 'TERMINAL';
  if (isBlockingState(state)) return 'BLOCKING';
  return 'REGULAR';
}

/** The two agents the orchestrator will drive. */
export const AGENT_IDS = ['claude', 'codex'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/**
 * Work phases that a task can be re-entered at. These are the semantic
 * counterparts to `IMPLEMENT_ROUND_1`, `VERIFY_ROUND_1`, ... but modelled
 * structurally so that the round is a number, not a substring.
 */
export const RESUME_PHASES = ['IMPLEMENT', 'VERIFY', 'REVIEW', 'REMEDIATE'] as const;
export type ResumePhase = (typeof RESUME_PHASES)[number];

/** Severity vocabulary for review findings. */
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
