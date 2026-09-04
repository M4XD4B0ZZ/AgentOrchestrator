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
  'OPERATOR_RESOLVED',
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
 * - `OPERATOR_RESOLVED` — an operator took the task out of this orchestrator's
 *   hands, explicitly, from a state in which the loop had already stopped and
 *   was waiting for them.
 *
 * ── Why the third one exists, and what it deliberately does not claim ──────
 *
 * Before it, a task that a human finished outside the loop had nowhere to go.
 * `READY_FOR_PR` was refused from the other direction — the transition table
 * withholds it from `HUMAN_DECISION_REQUIRED` because approving work must go
 * through a real `REVIEWING` pass — and `ABORTED` means *given up on*, which
 * `block/block-ledger.ts` reads as a surrender and which would make the task's
 * block permanently uncompletable. So the task stayed blocked for ever, its
 * attention item stayed open for ever, and the operator had no way to record
 * the one thing they knew: that it was over.
 *
 * The name is the whole of the claim. `OPERATOR_RESOLVED` says a person ended
 * this task on their own authority. It does **not** say the work was delivered,
 * that verification passed, that the scope was clean, or that anything was
 * merged — AO cannot verify any of those, and a state name that implied one
 * would be the orchestrator asserting somebody else's word as its own
 * measurement. What it overrode is recorded beside it, in
 * `TaskState.operatorResolution.closedFrom`, so the decision can never be read
 * as a machine's conclusion.
 */
export const TERMINAL_STATES = ['READY_FOR_PR', 'ABORTED', 'OPERATOR_RESOLVED'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/**
 * States that represent "the task is stuck and something outside the normal
 * happy path has to happen". These are exactly the blocking/terminal states
 * minus `ABORTED` and `OPERATOR_RESOLVED` — both of which are ends, not blocks.
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

/**
 * `true` for states with no outgoing transitions (`READY_FOR_PR`, `ABORTED`,
 * `OPERATOR_RESOLVED`).
 */
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

/**
 * The regular state each resume phase names.
 *
 * It lives here, next to the two vocabularies it relates, so that the resume
 * policy and the state contract read the *same* mapping. `resume-policy.ts`
 * derives its legitimate resume phases from it; `task-state.ts` derives the
 * work-loop set below from it. A second copy of this table would be a second
 * opinion on what `REVIEW` means.
 */
export const RESUME_PHASE_STATES: Readonly<Record<ResumePhase, TaskStateName>> = Object.freeze({
  IMPLEMENT: 'IMPLEMENTING',
  VERIFY: 'VERIFYING',
  REVIEW: 'REVIEWING',
  REMEDIATE: 'REMEDIATING',
});

/**
 * The states in which the loop is *executing* rather than waiting.
 *
 * Derived from {@link RESUME_PHASE_STATES} rather than listed again: a work
 * phase is exactly a state some resume point can name, because a resume point
 * names where execution continues.
 *
 * The set exists because these four states are the ones for which resume-only
 * evidence — a `resumeFrom` point and a reported quota reset — is necessarily
 * stale. A task executing in one of them is not paused, so a record saying
 * where to continue after a pause describes a pause that is over. The setup
 * chain is deliberately *not* here: `BLOCKED_AUTH → AUTH_PREFLIGHT →
 * GIT_PREFLIGHT → WORKTREE_READY → CONTEXT_LOADING` is the declared path a
 * re-authenticated task walks, and `resume-policy.ts` requires the stored point
 * to survive it.
 */
export const WORK_LOOP_STATES = Object.freeze(
  RESUME_PHASES.map((phase) => RESUME_PHASE_STATES[phase]),
) as readonly TaskStateName[];

const WORK_LOOP_SET: ReadonlySet<string> = new Set<string>(WORK_LOOP_STATES);

/** `true` for the four states in which an agent or a verification command runs. */
export function isWorkLoopState(state: TaskStateName): boolean {
  return WORK_LOOP_SET.has(state);
}

/** Severity vocabulary for review findings. */
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
