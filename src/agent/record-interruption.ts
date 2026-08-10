/**
 * Writing down an interrupted agent run.
 *
 * ── Why this is not a second state mechanism ───────────────────────────────
 *
 * It is a thin, deliberate composition of V1-04: it builds the successor state
 * and hands it to `advanceTaskState`, which consults the transition table,
 * carries the exact-byte revision of the state that was read, and refuses with
 * `STATE_CONFLICT` if another writer got there first. Nothing here opens a
 * file, chooses a path, or decides that a move is legal — every one of those
 * questions already has exactly one answer in this repository, and a runner
 * that answered them again would be a second, quieter authority.
 *
 * Two consequences follow directly, and both are tested:
 *
 *  - a usage-limit block recorded from `VERIFYING` is refused with
 *    `ILLEGAL_TRANSITION`, because that edge does not exist — verification
 *    runs local commands and cannot consume an agent's quota;
 *  - the write is compare-and-swap, so a task that moved underneath this run
 *    is not overwritten by a result computed against the older state.
 *
 * ── What is carried forward, and why it matters ────────────────────────────
 *
 * Everything except the five interruption fields. `findingHistory` in
 * particular is copied unchanged, and that is not politeness toward earlier
 * work: `reconcile.ts` reads a non-empty `findingHistory` as evidence that a
 * task has *done* something. Dropping it would make a resumed task look like
 * one that had never started, and the reconciler would then report the loop's
 * own progress as divergence. `reviewRound` is carried for the same reason and
 * is never incremented here — a round that was interrupted was not completed.
 *
 * ── The phase does not advance ─────────────────────────────────────────────
 *
 * An interrupted writer does not reach `VERIFYING`; an interrupted reviewer
 * does not reach `READY_FOR_PR`. The successor is a blocking state, always.
 * The temptation this guards against is real and cheap to write — "the writer
 * ran, so verification is next" — and it is wrong precisely when it matters,
 * because the run that was interrupted is the run whose work is incomplete.
 */

import type { AgentBlockEvidence, AgentDisposition } from './agent-outcome.js';
import type { TaskStateName } from '../core/states.js';
import { advanceTaskState, type AdvanceOptions } from '../state/advance-state.js';
import type { StateLoadSuccess, StateSaveResult } from '../state/state-store.js';

/**
 * What the run driver is told. A closed set, and deliberately without a member
 * that reads as permission to continue.
 *
 * There is no `RESUME_READY`, no `RETRY` and no `AUTOMATIC_ALLOWED` here, and
 * that absence is load-bearing. `AUTOMATIC_ALLOWED` has exactly one source in
 * this repository — `evaluateAutomaticResume`, reached through
 * `classifyResume` after reconciliation — and a second value that a driver
 * could mistake for the same thing would be a way to resume a task without
 * ever having checked the reset time, the auth state, or the worktree.
 */
export const AGENT_RUN_OUTCOMES = [
  /** The agent finished. Nothing was blocked and nothing was written here. */
  'RUN_COMPLETED',
  /**
   * The task is durably parked in `BLOCKED_USAGE_LIMIT`.
   *
   * A pause, not a failure: the block clears by itself, and the run driver is
   * meant to stop working on this task and move on rather than report an
   * error. It is emphatically *not* a licence to come back later on a timer —
   * whether the task may continue is answered by `classifyResume`, from
   * evidence that includes a reset time this outcome may not even have.
   */
  'PAUSED_USAGE_LIMIT',
  /** The task is durably parked in a state only a human clears. */
  'NEEDS_ATTENTION',
  /**
   * The interruption could not be written down.
   *
   * Distinct from every other member and never silently folded into one: an
   * unrecorded block is a task whose durable state still claims it is running.
   * The save result says why.
   */
  'STATE_NOT_RECORDED',
] as const;

export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];

/** The blocking state each disposition lands in. Total, so a new disposition must choose one. */
const DISPOSITION_STATE: Readonly<
  Record<Exclude<AgentDisposition, 'AGENT_COMPLETED'>, TaskStateName>
> = Object.freeze({
  AGENT_BLOCKED_USAGE_LIMIT: 'BLOCKED_USAGE_LIMIT',
  AGENT_BLOCKED_AUTH: 'BLOCKED_AUTH',
  AGENT_NEEDS_ATTENTION: 'HUMAN_DECISION_REQUIRED',
});

const DISPOSITION_OUTCOME: Readonly<
  Record<Exclude<AgentDisposition, 'AGENT_COMPLETED'>, AgentRunOutcome>
> = Object.freeze({
  AGENT_BLOCKED_USAGE_LIMIT: 'PAUSED_USAGE_LIMIT',
  AGENT_BLOCKED_AUTH: 'NEEDS_ATTENTION',
  AGENT_NEEDS_ATTENTION: 'NEEDS_ATTENTION',
});

/** The shape both boundaries produce for a run that did not complete. */
export interface AgentInterruption {
  readonly disposition: Exclude<AgentDisposition, 'AGENT_COMPLETED'>;
  /**
   * Block evidence, when the boundary recognised a block.
   *
   * When absent, this module supplies the two fields the contract requires —
   * the blocked agent and the resume point — from `fallback`, because
   * `BLOCKED_AUTH` and `HUMAN_DECISION_REQUIRED` require a resume point just
   * as `BLOCKED_USAGE_LIMIT` does.
   */
  readonly block: AgentBlockEvidence | null;
}

export interface RecordInterruptionOptions extends AdvanceOptions {
  /** The instant the block is entered, ISO-8601 with an offset. Injected, never read from a clock. */
  readonly now: string;
  /**
   * The block evidence to use when the run produced none — the resume point
   * the interrupted run would re-enter at.
   */
  readonly fallback: AgentBlockEvidence;
}

export interface AgentInterruptionRecord {
  readonly outcome: AgentRunOutcome;
  /** The state that was written, or `null` when nothing was. */
  readonly state: TaskStateName | null;
  readonly save: StateSaveResult;
}

/**
 * Records `interruption` against the state in `current`.
 *
 * Returns rather than throws for every expected condition, including a refused
 * write: a caller must be able to see that the block did not land.
 */
export function recordAgentInterruption(
  current: StateLoadSuccess,
  interruption: AgentInterruption,
  options: RecordInterruptionOptions,
): AgentInterruptionRecord {
  const { now, fallback, ...advance } = options;
  const target = DISPOSITION_STATE[interruption.disposition];
  const block = interruption.block ?? fallback;
  const usageLimit = interruption.disposition === 'AGENT_BLOCKED_USAGE_LIMIT';

  const next = {
    ...current.state,
    state: target,
    stateEnteredAt: now,
    blockedAgent: block.blockedAgent,
    resumeFrom: { phase: block.resumeFrom.phase, round: block.resumeFrom.round },
    // Only a usage limit has a reset time to record, and only if the CLI
    // reported one. Every other block clears it: a stale timestamp left on a
    // state a human has to resolve would be evidence about a condition that is
    // no longer the one holding the task.
    reportedResetAt: usageLimit ? block.reportedResetAt : null,
  };

  const save = advanceTaskState(current, next, advance);
  if (!save.ok) {
    return Object.freeze({ outcome: 'STATE_NOT_RECORDED' as const, state: null, save });
  }

  return Object.freeze({
    outcome: DISPOSITION_OUTCOME[interruption.disposition],
    state: target,
    save,
  });
}
