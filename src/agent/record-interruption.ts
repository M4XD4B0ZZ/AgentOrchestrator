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
import { isBlockingState, type AgentId, type ResumePhase, type TaskStateName } from '../core/states.js';
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

/**
 * What was running in each state an agent can be interrupted in.
 *
 * The single source for two questions a caller must not be trusted to answer
 * about itself: *which agent was running* and *where the task re-enters*. Both
 * are properties of the phase, and the phase is persisted — so the durable
 * state already knows, and asking the caller only creates the opportunity to
 * disagree with it (V1-05-RR-F4).
 *
 * `mutatesRepository` is the third property of the same fact and belongs here
 * for the same reason. The writer edits the worktree; the reviewer is
 * contractually read-only, which is why a write attempt by it is a scope
 * violation rather than ordinary work. What survives an interruption as
 * evidence differs accordingly — see `staleAfterInterruption` below.
 *
 * States absent from this table run no agent. `VERIFYING` is the one that
 * matters: it runs the project's own commands and consumes no agent quota,
 * which is why `VERIFYING → BLOCKED_USAGE_LIMIT` is not a declared edge. They
 * are left to `advanceTaskState`, so the transition table stays the one
 * authority on which moves exist.
 */
const AGENT_PHASES: Readonly<
  Partial<
    Record<
      TaskStateName,
      { readonly agent: AgentId; readonly resumePhase: ResumePhase; readonly mutatesRepository: boolean }
    >
  >
> = Object.freeze({
  IMPLEMENTING: Object.freeze({ agent: 'claude', resumePhase: 'IMPLEMENT', mutatesRepository: true }),
  REMEDIATING: Object.freeze({ agent: 'claude', resumePhase: 'REMEDIATE', mutatesRepository: true }),
  REVIEWING: Object.freeze({ agent: 'codex', resumePhase: 'REVIEW', mutatesRepository: false }),
});

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
 * The checkpoint facts an interrupted run may have invalidated.
 *
 * `worktreeCleanAtCheckpoint` and `currentCommit` are observations, true when
 * something last looked. Carrying them across a writer's interruption
 * *re-asserts* them, and a writing agent changing the worktree is not an edge
 * case — it is the job (V1-05-RR-F8).
 *
 * The consequence of re-asserting them is severe and one-directional.
 * `reconcile.ts` reads `worktreeCleanAtCheckpoint: true` as a record that a
 * dirty tree contradicts, which makes the verdict `DIVERGED`, which
 * `classifyResume` turns into `STATE_DIVERGED` / `BLOCKED` — so a self-clearing
 * quota pause became `RESUME_STATE_DIVERGED`, permanently non-resumable, for a
 * condition true of *every* interrupted writer. Reconciliation is already built
 * to survive the honest version: a checkpoint recording `false` is "a task with
 * work in progress, which is the normal thing to find".
 *
 * Neither value is fabricated in the other direction. `false` here does not
 * claim the tree is dirty — nothing in this module looked at it — it withdraws
 * a claim that it is clean, which is a weaker statement and a true one. `null`
 * likewise means the recorded HEAD is no longer known to be current, not that
 * there is no commit. Everything else the state holds, including
 * `basePinnedCommit` and `findingHistory`, is durable evidence and is carried
 * through untouched.
 *
 * Nothing is withdrawn for the reviewer. It is contractually read-only — a
 * write attempt by it is a scope violation rather than ordinary work — so its
 * interruption invalidates nothing, and discarding true evidence for a run that
 * could not have changed it would be its own kind of lie.
 */
function staleAfterInterruption(
  mutatesRepository: boolean,
): { readonly worktreeCleanAtCheckpoint: false; readonly currentCommit: null } | Record<never, never> {
  return mutatesRepository ? { worktreeCleanAtCheckpoint: false, currentCommit: null } : {};
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
  const running = AGENT_PHASES[current.state.state];

  // A task already parked in a blocking state had no agent running, so there is
  // no interruption to record against it. Refused before anything else, because
  // `AGENT_PHASES` holds no entry for these states and every guard below is
  // therefore inoperative for them: the agent identity and resume phase would
  // be taken from the caller verbatim, and nothing stale would be withdrawn.
  //
  // The sharp case is a `BLOCKED_USAGE_LIMIT` self-write. `from === to` is a
  // checkpoint rather than a transition, so the table does not judge it, and a
  // caller could write a `reportedResetAt` that has already passed onto a state
  // that carried none — turning a block `evaluateAutomaticResume` refuses with
  // `RESET_TIME_MISSING` into one it grants on a timer. That is the exact
  // fabrication `AgentBlockEvidence.reportedResetAt` is documented to prevent
  // (V1-05 followup NEW-4).
  //
  // Deliberately not a blanket refusal of "state absent from AGENT_PHASES":
  // `AUTH_PREFLIGHT → BLOCKED_AUTH` is a legitimate non-agent-phase caller, and
  // it is a regular state, not a blocking one.
  if (isBlockingState(current.state.state)) {
    return Object.freeze({
      outcome: 'STATE_NOT_RECORDED' as const,
      state: null,
      save: Object.freeze({
        ok: false as const,
        code: 'INTERRUPTION_INCONSISTENT' as const,
        path: null,
        detail: `${current.state.state}/ALREADY_BLOCKED`,
        errnoCode: null,
      }),
    });
  }

  // The caller and the durable state disagree about what was running. Refused
  // rather than resolved: there is no basis for preferring one, and the cost of
  // guessing is an operator sent to re-authenticate the wrong CLI or to resume
  // at a phase whose work was never started.
  if (
    running !== undefined &&
    (block.blockedAgent !== running.agent || block.resumeFrom.phase !== running.resumePhase)
  ) {
    return Object.freeze({
      outcome: 'STATE_NOT_RECORDED' as const,
      state: null,
      save: Object.freeze({
        ok: false as const,
        code: 'INTERRUPTION_INCONSISTENT' as const,
        path: null,
        // The two values that disagree, not a rendered sentence — the caller
        // holds both, and this is a code path.
        detail: `${current.state.state}/${block.blockedAgent}:${block.resumeFrom.phase}`,
        errnoCode: null,
      }),
    });
  }

  const next = {
    ...current.state,
    state: target,
    stateEnteredAt: now,
    // Derived from the phase, never copied from the caller: see AGENT_PHASES.
    // Only the round comes from the run, because only the run knows which pass
    // it was.
    blockedAgent: running?.agent ?? block.blockedAgent,
    resumeFrom: {
      phase: running?.resumePhase ?? block.resumeFrom.phase,
      round: block.resumeFrom.round,
    },
    // Only a usage limit has a reset time to record, and only if the CLI
    // reported one. Every other block clears it: a stale timestamp left on a
    // state a human has to resolve would be evidence about a condition that is
    // no longer the one holding the task.
    reportedResetAt: usageLimit ? block.reportedResetAt : null,
    ...staleAfterInterruption(running?.mutatesRepository ?? false),
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
