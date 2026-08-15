/**
 * What an ending means for the operator who is not watching (V2-10).
 *
 * ── One question, asked of an answer that already exists ────────────────────
 *
 * This module observes a finished {@link AttendedBlockResult} and answers two
 * things about it: whether it needs an operator, and — when it does — the one
 * sentence saying what that operator has to go and do. It decides nothing about
 * the run. Nothing here reads the ledger, writes anything, or can be reached
 * before a run is over.
 *
 * ── Why not the exit code ──────────────────────────────────────────────────
 *
 * `exitCodeForBlockRun` grades the same two vocabularies and it is tempting to
 * say "attention iff the exit code is not 0". That would notify
 * `OPERATOR_STOPPED`, which exits 4 because nothing durable is wrong and
 * re-invoking can differ — a true statement about a shell, and the wrong answer
 * to "should this person's phone buzz?". They are two questions, so they are two
 * tables, and this one imports nothing from `run-exit-codes.ts`.
 *
 * The relation between them is still worth pinning, and it is pinned as a *test*
 * rather than as a dependency: every ending the exit table grades `EXIT_RUN_OK`
 * must be silent here. A future member added to both tables inconsistently fails
 * that, without either table having to know about the other.
 *
 * ── Why the disposition and the action are one table ───────────────────────
 *
 * A `satisfies Record<…>` table proves that every member was *considered*, never
 * that any member was judged correctly — and two tables keyed by the same
 * vocabulary can be individually total while disagreeing about the same ending.
 * Binding the judgement into one value per member removes that failure mode by
 * construction: there is no ending with a disposition and no action, and no
 * ending whose action came from a different row than its disposition.
 *
 * The union is discriminated, so a silent ending carries `action: null` and the
 * type — not a convention — says that a silent ending has no instruction for
 * anybody. Correctness of the surviving eleven sentences is a separate matter
 * from completeness and is measured separately: each action carries a token that
 * appears in no other action, and the suite proves both directions, that each
 * sentence satisfies its own constraint and that no other sentence does.
 */

import type { BlockStopReason } from '../block/block-ledger.js';
import type { AttendedBlockResult, BlockRunOutcome } from '../block/block-runner.js';

export const NOTIFICATION_DISPOSITIONS = ['ATTENTION', 'SILENT'] as const;

export type NotificationDisposition = (typeof NOTIFICATION_DISPOSITIONS)[number];

/**
 * What one ending means for an absent operator.
 *
 * Discriminated on purpose: `SILENT` carries no action because there is nobody
 * to give one to, and `ATTENTION` cannot exist without one.
 */
export type EndingJudgement =
  | { readonly disposition: 'SILENT'; readonly action: null }
  | { readonly disposition: 'ATTENTION'; readonly action: string };

const silent: EndingJudgement = Object.freeze({ disposition: 'SILENT' as const, action: null });

const attention = (action: string): EndingJudgement =>
  Object.freeze({ disposition: 'ATTENTION' as const, action });

/**
 * The nine endings the ledger records. Total; every member judged by hand.
 *
 * `COMPLETE` is the intended end and says nothing to anybody.
 * `OPERATOR_STOPPED` is the one ending a human caused, and telling them about an
 * intervention they made themselves is noise, not notification.
 */
const STOP_REASON_JUDGEMENTS = Object.freeze({
  COMPLETE: silent,
  OPERATOR_STOPPED: silent,
  TASK_BLOCKED: attention(
    'A task is blocked on something a human must resolve; the block cannot complete until it is.',
  ),
  TASK_ABANDONED: attention(
    'A task was given up on, which is terminal for it; the block cannot complete.',
  ),
  NO_ELIGIBLE_TASK: attention(
    'No member was eligible to run; look for a prerequisite outside this block.',
  ),
  LEDGER_DIVERGED: attention(
    'The ledger and the task records disagree; compare them by hand and write nothing.',
  ),
  STATE_UNUSABLE: attention(
    'A task record cannot be used, broken or belonging elsewhere; inspect that record.',
  ),
  DEFINITION_DRIFTED: attention(
    'The frozen plan no longer matches the repository; start a new run against the current one.',
  ),
  ACTIVE_TASK_UNRESOLVED: attention(
    'A task was left active with no outcome that could be established; establish it by hand.',
  ),
}) satisfies Record<BlockStopReason, EndingJudgement>;

/**
 * The four endings the ledger does **not** record. Total; every member judged.
 *
 * None of their sentences may claim a persisted ending, because for all four the
 * ledger stands at its last durable state and carries no stop reason. That is a
 * property of the class rather than of any one sentence, and it is asserted over
 * the class.
 */
const OUTCOME_JUDGEMENTS = Object.freeze({
  LEASE_AUTHORITY_UNCERTAIN: attention(
    'This run may have lost the execution lease; find out who owns the repository now.',
  ),
  DURABLE_WRITE_FAILED: attention(
    'A durable write was refused; a disk or a permission has to be fixed before this will run.',
  ),
  RUN_GATE_REFUSED: attention(
    'A gate refused and no task was driven; the detail names which gate it was.',
  ),
  RECONCILIATION_UNRESOLVED: attention(
    'Task state moved under a held lease; nothing was repaired, and a human decides what now.',
  ),
}) satisfies Record<Exclude<BlockRunOutcome, 'BLOCK_RUN_ENDED'>, EndingJudgement>;

/**
 * The judgement for one finished run.
 *
 * `BLOCK_RUN_ENDED` is graded by the reason the ledger carries; every other
 * outcome is graded on its own. A `BLOCK_RUN_ENDED` without a reason cannot be
 * produced — `RunState.stop` is its only producer and always names one — so it is
 * treated as the defect it would be and judged as needing an operator rather
 * than being silently dropped.
 */
export function judgeBlockRun(result: AttendedBlockResult): EndingJudgement {
  if (result.outcome !== 'BLOCK_RUN_ENDED') return OUTCOME_JUDGEMENTS[result.outcome];
  if (result.stopReason === null) {
    return attention('This run reported an ending with no reason, which is a defect; look at it.');
  }
  return STOP_REASON_JUDGEMENTS[result.stopReason];
}

/** Whether a finished run needs the operator who is not watching. */
export function attentionForBlockRun(result: AttendedBlockResult): NotificationDisposition {
  return judgeBlockRun(result).disposition;
}

/**
 * The judgement tables, exported for the suite that measures their correctness.
 *
 * Reading them is how a test can assert *per member* and *pairwise*; nothing in
 * production reads them except {@link judgeBlockRun}.
 */
export const ENDING_JUDGEMENTS = Object.freeze({
  stopReasons: STOP_REASON_JUDGEMENTS,
  outcomes: OUTCOME_JUDGEMENTS,
});
