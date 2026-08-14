/**
 * Every decision the block runner makes that is not I/O.
 *
 * Four judgements live here, kept apart from the sequencing so that each can be
 * reviewed — and broken — without a repository, a lease or a subprocess in the
 * way:
 *
 *   1. what a task's run outcome entitles the ledger to be told;
 *   2. whether a recording attempt landed, was refused, or could not be written
 *      at all;
 *   3. which reason a run ends under;
 *   4. whether the frozen plan establishes independence.
 *
 * ── Total by type, correct by test ─────────────────────────────────────────
 *
 * Both maps are written `satisfies Record<…>` over a vocabulary owned
 * elsewhere, so a new run outcome or progress outcome fails the build here
 * until somebody grades it. That is completeness and it is all a type can do:
 * nothing in the compiler objects to `TASK_ABORTED` being graded `SETTLE`. The
 * grades themselves are pinned by hand-written tables in
 * `tests/v2-08-attended-block-runner.test.ts`, which are deliberately not
 * derived from these maps — a table generated from the module under test agrees
 * with it by construction and can never disagree.
 */

import type { FrozenTaskDependency } from './block-definition.js';
import type { BlockStopReason, BlockTaskEntry } from './block-ledger.js';
import type { BlockProgressOutcome } from './block-progress.js';
import type { RunOutcome } from '../run/run-driver.js';

/* ─────────────────── 1. what a run outcome entitles ──────────────────────── */

/** What a driven task's outcome entitles this run to record. A closed set. */
export const TASK_CONCLUSIONS = [
  /** The record proves `READY_FOR_PR`. */
  'SETTLE',
  /** The record proves a blocking state. */
  'PARK',
  /** The record proves `ABORTED`. */
  'ABANDON',
  /**
   * The task's outcome cannot be established, and re-driving would do the same
   * thing again. The run ends with `ACTIVE_TASK_UNRESOLVED`.
   */
  'UNRESOLVED',
  /** A task record exists and cannot be used. The run ends `STATE_UNUSABLE`. */
  'STATE_UNUSABLE',
  /**
   * This run may no longer be the repository's writer.
   *
   * Kept apart from every other conclusion because it is the one that forbids
   * the *write*, not merely the claim: any further ledger mutation is precisely
   * the act the run has lost the authority for.
   */
  'LEASE_UNCERTAIN',
  /**
   * The driver's own per-call step budget ran out, with durable progress made.
   *
   * **Drive the same task again, under the same lease.** Not an ending of any
   * kind: `maxSteps` bounds one `runTask` call so a driver cannot run away, and
   * reaching it says nothing about the task's outcome. Graded as an ending it
   * would turn a scheduling limit into `ACTIVE_TASK_UNRESOLVED`, a claim about a
   * task; graded as an ending of the *invocation* it would need a block run
   * that outlives its holder, which the lease guarantee does not allow.
   *
   * The continuation terminates: every `STEP_BUDGET_EXHAUSTED` carries durable
   * progress by its own definition, the task's state machine is bounded by the
   * repository's `maxReviewRounds`, and a continuation that lands zero durable
   * steps is refused as unresolved rather than tried again.
   */
  'CONTINUE',
] as const;

export type TaskConclusion = (typeof TASK_CONCLUSIONS)[number];

const CONCLUSION_FOR_RUN_OUTCOME = Object.freeze({
  TASK_COMPLETED: 'SETTLE',
  TASK_ABORTED: 'ABANDON',

  // The six blocking states, each of which the task's own record now carries.
  // `parkBlockTask` re-reads that record and refuses if it does not classify as
  // BLOCKING, so this map proposes and the evidence disposes.
  BLOCKED_USAGE_LIMIT: 'PARK',
  BLOCKED_VERIFY: 'PARK',
  BLOCKED_AUTH: 'PARK',
  SCOPE_VIOLATION: 'PARK',
  RESUME_STATE_DIVERGED: 'PARK',
  HUMAN_DECISION_REQUIRED: 'PARK',

  // Authority, not outcome. `EXECUTION_LEASE_NOT_HELD` means this invocation
  // never was the writer and `EXECUTION_LEASE_LOST` means it has stopped being
  // one; the operator's next move differs, which is why the driver keeps two
  // outcomes, and the *ledger's* answer is identical: write nothing.
  EXECUTION_LEASE_NOT_HELD: 'LEASE_UNCERTAIN',
  EXECUTION_LEASE_LOST: 'LEASE_UNCERTAIN',

  // A record that exists and cannot be used is a fact about the record, and the
  // ledger has a reason for exactly that.
  STATE_UNUSABLE: 'STATE_UNUSABLE',

  STEP_BUDGET_EXHAUSTED: 'CONTINUE',

  // Everything left. None of these proves settle, park or abandon, and none of
  // them is improved by trying again inside this invocation:
  //   - the record and the world disagree, or the world could not be read;
  //   - no state was ever persisted for a task this run just started;
  //   - a write was refused, by a conflict or otherwise;
  //   - continuation or execution was not authorised;
  //   - an iteration left the durable state exactly as it found it.
  // Graded one by one rather than by a default arm, because a `default` is how
  // a vocabulary grows a member nobody classified.
  STATE_DIVERGED: 'UNRESOLVED',
  STATE_UNOBSERVABLE: 'UNRESOLVED',
  TASK_NOT_STARTED: 'UNRESOLVED',
  STATE_CONFLICT: 'UNRESOLVED',
  STATE_NOT_RECORDED: 'UNRESOLVED',
  CONTINUATION_NOT_AUTHORISED: 'UNRESOLVED',
  EXECUTION_UNAUTHORISED: 'UNRESOLVED',
  NO_PROGRESS: 'UNRESOLVED',
}) satisfies Record<RunOutcome, TaskConclusion>;

/** What the ledger may be told about a task the driver has just stopped on. */
export function conclusionForRunOutcome(outcome: RunOutcome): TaskConclusion {
  return CONCLUSION_FOR_RUN_OUTCOME[outcome];
}

/* ──────────────── 2. whether a recording attempt landed ──────────────────── */

/** What a `block-progress` call means for the run. A closed set. */
export const RECORDING_RESULTS = ['RECORDED', 'UNRESOLVED', 'STATE_UNUSABLE', 'WRITE_FAILED'] as const;

export type RecordingResult = (typeof RECORDING_RESULTS)[number];

const RECORDING_RESULT_FOR = Object.freeze({
  RECORDED: 'RECORDED',

  // The store could not write. `NOT_RECORDED` is the outcome `block-progress`
  // uses for every save failure that is not a refused proof, so it is the only
  // one that means "the durable write did not happen".
  NOT_RECORDED: 'WRITE_FAILED',

  // A record exists and cannot be used, which has its own stop reason.
  TASK_STATE_UNUSABLE: 'STATE_UNUSABLE',

  // Every remaining refusal is about the *claim*. The run does not retry and
  // does not soften: the task's outcome is not established, and the honest end
  // is a stop that says exactly that.
  //
  // `RUN_ALREADY_STOPPED` is in here rather than in a class of its own on
  // purpose. It is unreachable through the runner — nothing drives a stopped
  // run — so a grade for it is a fail-closed floor, and the floor that says
  // "nothing was recorded" is the safe one.
  TASK_NOT_IN_RUN: 'UNRESOLVED',
  DISPOSITION_UNCHANGED: 'UNRESOLVED',
  ANOTHER_TASK_ACTIVE: 'UNRESOLVED',
  TASK_STATE_DOES_NOT_PROVE_IT: 'UNRESOLVED',
  TASK_NOT_STARTED: 'UNRESOLVED',
  RUN_ALREADY_STOPPED: 'UNRESOLVED',
}) satisfies Record<BlockProgressOutcome, RecordingResult>;

export function recordingResultFor(outcome: BlockProgressOutcome): RecordingResult {
  return RECORDING_RESULT_FOR[outcome];
}

/* ───────────────────────── 3. how a run ends ─────────────────────────────── */

/**
 * The reason a run ends when nothing runnable is left.
 *
 * **Cause beats consequence.** `NO_ELIGIBLE_TASK` became reachable in a new way
 * once a task-local failure stopped ending the run: after A fails and B and C
 * settle, a block with nothing left to run is *finished*, not obstructed. If it
 * became the generic "the loop ended" code, an operator would be told the
 * consequence and never the cause.
 *
 * So the most specific task disposition that explains the ending wins, and
 * `NO_ELIGIBLE_TASK` is reserved for a genuine eligibility dead end that no
 * disposition accounts for — a member whose path to eligibility runs through a
 * non-member, which the frozen relation deliberately does not record.
 *
 * Order matters between the two failures: a human can act on a blocked task and
 * nobody can act on an abandoned one, so the reason names the one with a next
 * step.
 */
export function endReasonFor(entries: readonly BlockTaskEntry[]): BlockStopReason {
  if (entries.every((entry) => entry.disposition === 'SETTLED')) return 'COMPLETE';
  if (entries.some((entry) => entry.disposition === 'BLOCKED')) return 'TASK_BLOCKED';
  if (entries.some((entry) => entry.disposition === 'ABANDONED')) return 'TASK_ABANDONED';
  return 'NO_ELIGIBLE_TASK';
}

/* ─────────────────────── 4. established independence ─────────────────────── */

/**
 * Whether the frozen plan establishes that its members are independent.
 *
 * Read, never derived. The relation was projected once, at freeze time, from
 * the whole normalised DAG and bound into the fingerprint; this function asks
 * it a question and computes nothing.
 *
 * ── Why the answer is about the block and not about a pair ─────────────────
 *
 * It is tempting to ask "may B continue after A?" per pair and keep going with
 * whatever is still unrelated. That is a dependency scheduler, and V2-08 does
 * not get one: as soon as any dependency relation holds between members the
 * block still has to process, the block is **not supported input** for this
 * runner. No improvised ordering, no partial scheduling. Dependent execution —
 * where one task's result commit becomes another's base — is V2-09, and it must
 * earn a claim V2-07 explicitly refused to make.
 *
 * A block that fails this does not fail the *run*: it simply stops at the first
 * task-local failure, exactly as V2-07 does today. That degradation is the
 * correct one, because it is the behaviour that is already proved.
 */
export function independenceIsEstablished(
  dependencies: readonly FrozenTaskDependency[],
): boolean {
  return dependencies.every((row) => row.dependsOn.length === 0);
}
