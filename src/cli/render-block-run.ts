/**
 * Console rendering for an attended block run. Plain ASCII, no secrets.
 *
 * The same discipline as `render-attended-run.ts`, and for the same reason: only
 * values that have already passed a validating boundary may appear here — task
 * ids, block and run ids, closed-vocabulary codes and the canonical repository
 * identity. Agent output, verifier output, exception text and finding paths are
 * not representable in an `AttendedBlockResult` and therefore cannot be printed.
 * `detail` is the one field that carries a value from elsewhere, and it is an
 * allow-listed code from another module's closed vocabulary, printed as one
 * (AO-002).
 *
 * ── What the unrecorded sentences may and may not say ──────────────────────
 *
 * Four of the five outcomes are not written into the ledger, and the tempting
 * sentence for them — "nothing was written" — is false. Every one of the four is
 * reachable *after* this run has already settled, parked or abandoned tasks, and
 * those records are true and stay. An operator told that nothing was written
 * either goes looking for a record that is there, or walks past one that is.
 *
 * So what the sentence says is the exact claim the runner's own header makes:
 * the run ended here, the ledger does not carry that ending, and what it does
 * carry is every task outcome recorded before this point. Whether a ledger
 * exists at all is a fact about the individual run — `DURABLE_WRITE_FAILED` and
 * `RUN_GATE_REFUSED` can both strike before one is created — and the report
 * shows that by listing what the ledger holds, never by a sentence attached to
 * the outcome.
 *
 * That is why the task table below is not decoration. For the unrecorded
 * outcomes the ledger is the authority on what happened *up to* the condition
 * and silent about the condition itself, so this report is the only place the
 * two are visible together.
 */

import type { BlockStopReason } from '../block/block-ledger.js';
import type { AttendedBlockResult, BlockRunOutcome } from '../block/block-runner.js';
import { line } from './render-attended-run.js';

/**
 * One static sentence per outcome. Closed, distinct, and pinned by test.
 *
 * Distinct is a requirement rather than an aesthetic: four unrecorded outcomes
 * that read alike are four outcomes an operator cannot act on differently, which
 * is the whole reason they are four rather than one generic `RUN_UNSAFE`. Each
 * one says what happened, what the ledger is left holding, and what to do.
 */
export const BLOCK_OUTCOME_SENTENCES: Readonly<Record<BlockRunOutcome, string>> = Object.freeze({
  BLOCK_RUN_ENDED:
    'The run ended and the ledger carries the ending. The reason above is the one it\n' +
    '  recorded, and the task table below is that record.',
  LEASE_AUTHORITY_UNCERTAIN:
    'This run may no longer be the repository\'s writer, so it stopped rather than write\n' +
    '  again - a further mutation is precisely the act it has lost the authority for. The\n' +
    '  ledger does not carry this ending; it stands at its last durable state, holding\n' +
    '  every task outcome recorded while this run was the writer. Run `agent-loop lease\n' +
    '  status` to see who owns the repository now.',
  DURABLE_WRITE_FAILED:
    'A durable write was refused, and the ledger could not record that either - the failed\n' +
    '  write is the condition. It stands at whatever last landed, which is every task\n' +
    '  outcome recorded before this point and may be no ledger at all if the failure\n' +
    '  struck the creation. The detail carries the store code. A disk or a permission has\n' +
    '  to be fixed before this will run.',
  RUN_GATE_REFUSED:
    'A repository, auth or runtime gate refused, which ends the run and is not a claim\n' +
    '  about any task - the task it refused to start is still PLANNED. The ledger does not\n' +
    '  carry this ending; it stands at its last durable state, and for a refusal met before\n' +
    '  the run opened there is no ledger yet. The detail names the gate.',
  RECONCILIATION_UNRESOLVED:
    'Progress that was forced when it was read was refused by the authoritative primitive\n' +
    '  when it was applied: the evidence moved in between, which means task state moved\n' +
    '  under a held execution lease. Nothing was repaired and nothing was retried - a\n' +
    '  second read and a second decision is how a refusal gets laundered. The ledger does\n' +
    '  not carry this ending; it stands at its last durable state.',
});

/**
 * The block's members are not chainable, so no run may be opened for it.
 *
 * A shape refusal is about the *input*, not about the repository: some member's
 * required predecessors are not totally ordered, so there is no single commit
 * that holds all of them. The two ways to invent one are to merge and to drop
 * somebody's work, and this build does neither.
 */
export const CHAIN_SHAPE_SENTENCE =
  'A member of this block depends on two members that are not ordered relative to each\n' +
  '  other, so there is no single commit its work could be built on. Nothing was started.\n' +
  '  Split the block, or add the missing dependency that orders the two.';

/**
 * The block base could not be resolved, so no run was opened.
 *
 * Not a stop reason and not a run outcome: it happens above `runAttendedBlock`,
 * under the lease, before any ledger exists. Every member's execution base and
 * every member's scope authority are that one commit, so a run that cannot name
 * it has nothing to freeze against and refuses rather than falling back to
 * whatever the default branch says later.
 */
export const BLOCK_BASE_UNRESOLVED_SENTENCE =
  'The declared default branch did not resolve to a commit, so the block has no base to\n' +
  '  freeze on. Nothing was started and no ledger was written. Check that the branch this\n' +
  '  repository declares exists locally and points at a commit.';

/**
 * One static sentence per stop reason. Closed, distinct, and pinned by test.
 *
 * These are the endings the ledger *does* carry, so none of them has anything to
 * say about what was written: the task table is the answer, and the reason is on
 * disk beside it.
 */
export const BLOCK_STOP_SENTENCES: Readonly<Record<BlockStopReason, string>> = Object.freeze({
  COMPLETE: 'Every frozen task is settled on the strength of its own record. The block is done.',
  TASK_BLOCKED:
    'A task stopped on something a human must resolve, and until they do the block\n' +
    '  cannot complete. Whether any other member ran depends on the frozen plan and on\n' +
    '  what was eligible - the task table below is that record, and a member this run\n' +
    '  never drove is still PLANNED unless its own record had already settled it.',
  TASK_ABANDONED:
    'A task was given up on, so the block cannot complete. That is terminal for the task\n' +
    '  and different from blocked: nothing continues from it, and there is nothing to\n' +
    '  resolve.',
  NO_ELIGIBLE_TASK:
    'No frozen member was eligible to run. A member with no frozen block-member dependency\n' +
    '  can still be waiting on a task outside the block, and that is what this looks like.',
  OPERATOR_STOPPED: 'An operator stopped this run deliberately.',
  LEDGER_DIVERGED:
    'The ledger and the task records disagree. It is never resolved by writing, so the run\n' +
    '  stopped and said so. Compare the entries below against the task states.',
  STATE_UNUSABLE:
    'A task record exists and cannot be used: broken, or an intact record of somewhere\n' +
    '  else. That is a fact about the record rather than a disagreement, which is why it is\n' +
    '  reported apart from a divergence.',
  DEFINITION_DRIFTED:
    'The frozen plan no longer matches the repository\'s definition. Drift is reported and\n' +
    '  never adopted: this run is about the plan it was started against.',
  ACTIVE_TASK_UNRESOLVED:
    'A task was still being worked on and its outcome could not be safely established, so\n' +
    '  the run ended holding it. Deliberately not a claim that the record is unusable, and\n' +
    '  deliberately not a disposition invented to close the entry.',
});

/** One line per task: what the ledger persisted, and what the driver said. */
function taskLines(result: AttendedBlockResult): readonly string[] {
  if (result.tasks.length === 0) {
    // Honest rather than empty. Two outcomes can strike before a ledger exists,
    // and a bare heading would read as "the run held no tasks".
    return ['  none recorded - no ledger was read by this run'];
  }
  return result.tasks.map(
    (task) =>
      `  ${task.taskId.padEnd(12)} ${task.disposition.padEnd(10)} ${task.runOutcome ?? '-'}`,
  );
}

/**
 * The whole report for one attended block run.
 *
 * The sentence printed is the one that names *the ending*: the stop reason when
 * the ledger carries one, and the outcome otherwise. Printing both would offer
 * an operator two endings for one run.
 */
export function renderBlockRun(
  repository: { id: string; root: string },
  result: AttendedBlockResult,
): string {
  const qualifiers = [
    ...(result.stopReason === null ? [] : [`reason ${result.stopReason}`]),
    ...(result.detail === null ? [] : [`detail ${result.detail}`]),
  ];
  const sentence =
    result.outcome === 'BLOCK_RUN_ENDED' && result.stopReason !== null
      ? BLOCK_STOP_SENTENCES[result.stopReason]
      : BLOCK_OUTCOME_SENTENCES[result.outcome];

  const lines = [
    '',
    line('Repository', `${repository.id}  (${repository.root})`),
    line('Block', `${result.blockId}   run ${result.runId}`),
    line('Outcome', [result.outcome, ...qualifiers].join('   ')),
    `  ${sentence}`,
    '',
    'Tasks',
    ...taskLines(result),
    '',
    line('Steps', String(result.steps)),
    '',
  ];

  return `${lines.join('\n')}\n`;
}
