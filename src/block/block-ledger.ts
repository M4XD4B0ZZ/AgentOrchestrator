/**
 * The durable record of one started block run.
 *
 * ── The one principle this module exists to hold ───────────────────────────
 *
 * > The ledger is durable **orchestration** truth, and never the primary truth
 * > about a single task.
 *
 * A `TaskState` proves what happened to a task. The ledger may *reference* that
 * and derive block progress from it; it may never overwrite it, and where the
 * two disagree the ledger never wins. Every rule below follows from that one
 * sentence, and the invariants exist so that a hand-edited or corrupted ledger
 * cannot assert progress the task records do not support.
 *
 * That is why `SETTLED` and `BLOCKED` are not free setter operations: each
 * requires `evidenceRevision`, the exact revision of the task state that was
 * read to justify the claim. A ledger entry saying "settled" with no evidence
 * is refused by the contract itself, before reconciliation ever looks.
 *
 * ── Frozen membership ──────────────────────────────────────────────────────
 *
 * `frozenTaskIds` and `planFingerprint` are written once, when the run starts,
 * and never change. A roadmap edited mid-run must not silently swap task four
 * while tasks one to three have already gone; the frozen copy is what a later
 * check compares the current definition against, and drift is *reported*, never
 * adopted.
 *
 * ── Room for the chain, without the chain ──────────────────────────────────
 *
 * Each entry carries `baseCommit` and `resultCommit`. Today `baseCommit` is
 * whatever the task was pinned to — for independent tasks, the ordinary default
 * branch pin — and `resultCommit` is populated only when a commit has actually
 * been proven to exist. V2-09 will make one task's `resultCommit` the next
 * task's `baseCommit`; the fields are here so that doing so needs no new ledger
 * shape, and are deliberately *not* interpreted as a chain by anything yet.
 *
 * Note the distinction the two fields keep apart, which is easy to lose and
 * expensive to lose: a task reaching `READY_FOR_PR` is a **terminal task
 * state**, and a `resultCommit` is **a commit fit to be a successor's base**.
 * V2-07 records the first. Claiming every `READY_FOR_PR` task automatically has
 * the second is exactly the assumption V2-09 has to earn.
 */

import { z } from 'zod';

import { isValidTaskId } from '../plan/task-id.js';
import { isValidBlockId, MAX_BLOCK_TASKS } from './block-definition.js';

/** Contract version of the ledger document. Bump on any breaking shape change. */
export const BLOCK_LEDGER_SCHEMA_VERSION = 1;

/** What the run has durably established about one of its tasks. */
export const TASK_DISPOSITIONS = [
  /** Frozen into the run and not yet started. */
  'PLANNED',
  /** The run is working on it. At most one task may be here. */
  'ACTIVE',
  /** Finished, on the strength of a task state that proved it. */
  'SETTLED',
  /** Stopped on something a human must resolve. Also evidence-backed. */
  'BLOCKED',
] as const;

export type TaskDisposition = (typeof TASK_DISPOSITIONS)[number];

/**
 * Why a run is not continuing. A closed set, because "the block simply stopped"
 * is the one thing an operator must never be told.
 */
export const BLOCK_STOP_REASONS = [
  /** Every frozen task is settled. The intended end. */
  'COMPLETE',
  /** A task is blocked and only a human continues it. */
  'TASK_BLOCKED',
  /** No frozen task is currently eligible to run. */
  'NO_ELIGIBLE_TASK',
  /** An operator stopped this run deliberately. */
  'OPERATOR_STOPPED',
  /** The ledger and the task records disagree. Never resolved by writing. */
  'LEDGER_DIVERGED',
  /** A task record exists and cannot be used: broken, or somebody else's. */
  'STATE_UNUSABLE',
  /** The frozen plan no longer matches the repository's definition. */
  'DEFINITION_DRIFTED',
] as const;

export type BlockStopReason = (typeof BLOCK_STOP_REASONS)[number];

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const TaskIdSchema = z.string().refine(isValidTaskId, 'Must be a canonical task id.');

const BlockTaskEntrySchema = z
  .object({
    taskId: TaskIdSchema,
    disposition: z.enum(TASK_DISPOSITIONS),
    /**
     * The revision of the task state that justified this disposition.
     *
     * Not decoration: it is what makes a claim checkable later. A `SETTLED`
     * entry whose evidence no longer matches the task state on disk is a
     * divergence a reconciler can *see*, where a bare boolean would have been
     * indistinguishable from a hand-edit.
     */
    evidenceRevision: z.string().regex(SHA256_HEX, 'Must be a state revision digest.').nullable(),
    baseCommit: z.string().regex(GIT_SHA, 'Must be a full Git object name.').nullable(),
    resultCommit: z.string().regex(GIT_SHA, 'Must be a full Git object name.').nullable(),
  })
  .strict();

export const BlockRunLedgerObjectSchema = z
  .object({
    schemaVersion: z.int().positive(),
    /** Stable identity of the repository, from its profile. */
    repositoryId: z.string().min(1).max(64),
    /** Canonical absolute root. The ledger belongs to exactly this checkout. */
    repositoryRoot: z.string().min(1),
    blockId: z.string().refine(isValidBlockId, 'Must be a canonical block id.'),
    /**
     * Identity of this *run*, distinct from the block.
     *
     * The same roadmap block must be startable again later without overwriting
     * the record of the previous attempt, so the run is what names the file.
     */
    runId: z.string().refine(isValidTaskId, 'Must be a canonical run id.'),
    startedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    /** Membership as frozen at start. Never edited afterwards. */
    frozenTaskIds: z.array(TaskIdSchema).min(1).max(MAX_BLOCK_TASKS),
    planFingerprint: z.string().regex(SHA256_HEX, 'Must be a definition fingerprint.'),
    activeTaskId: TaskIdSchema.nullable(),
    tasks: z.array(BlockTaskEntrySchema).min(1).max(MAX_BLOCK_TASKS),
    stopReason: z.enum(BLOCK_STOP_REASONS).nullable(),
  })
  .strict();

export type BlockRunLedgerInput = z.input<typeof BlockRunLedgerObjectSchema>;
export type BlockRunLedger = z.infer<typeof BlockRunLedgerObjectSchema>;
export type BlockTaskEntry = z.infer<typeof BlockTaskEntrySchema>;

/**
 * The cross-field invariants, which are where this contract does its work.
 *
 * Each corresponds to a way a ledger could otherwise assert progress no task
 * record supports.
 */
export const BlockRunLedgerSchema = BlockRunLedgerObjectSchema.superRefine((value, ctx) => {
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path, message });
  };

  if (value.schemaVersion !== BLOCK_LEDGER_SCHEMA_VERSION) {
    issue(['schemaVersion'], `Unsupported schemaVersion ${value.schemaVersion}.`);
  }

  // --- 1. The entries are exactly the frozen membership, in order ----------
  // Not a subset, not a superset, not reordered. The frozen list is the run's
  // identity; entries that drifted from it would make "which tasks is this run
  // about" a question with two answers.
  const entryIds = value.tasks.map((task) => task.taskId);
  if (entryIds.length !== value.frozenTaskIds.length ||
      entryIds.some((id, index) => id !== value.frozenTaskIds[index])) {
    issue(['tasks'], 'tasks must mirror frozenTaskIds exactly, in the same order.');
  }
  if (new Set(value.frozenTaskIds).size !== value.frozenTaskIds.length) {
    issue(['frozenTaskIds'], 'frozenTaskIds must not repeat a task.');
  }

  // --- 2. At most one active task -----------------------------------------
  // Parallelism inside a block is not a V2 contract, and a ledger that could
  // express two active tasks would be a ledger a later runner could act on.
  const active = value.tasks.filter((task) => task.disposition === 'ACTIVE');
  if (active.length > 1) {
    issue(['tasks'], 'A block run may have at most one ACTIVE task.');
  }

  // --- 3. activeTaskId and the dispositions are one fact -------------------
  if (value.activeTaskId === null && active.length === 1) {
    issue(['activeTaskId'], 'A task is ACTIVE, so activeTaskId must name it.');
  }
  if (value.activeTaskId !== null) {
    const named = value.tasks.find((task) => task.taskId === value.activeTaskId);
    if (named === undefined) {
      issue(['activeTaskId'], 'activeTaskId must name a task of this run.');
    } else if (named.disposition !== 'ACTIVE') {
      issue(['activeTaskId'], 'activeTaskId must name the task whose disposition is ACTIVE.');
    }
  }

  // --- 4. A settled or blocked claim carries the evidence that justified it -
  value.tasks.forEach((task, index) => {
    const claimsOutcome = task.disposition === 'SETTLED' || task.disposition === 'BLOCKED';
    if (claimsOutcome && task.evidenceRevision === null) {
      issue(
        ['tasks', index, 'evidenceRevision'],
        `${task.disposition} must carry the task-state revision that proved it.`,
      );
    }
    if (!claimsOutcome && task.evidenceRevision !== null) {
      issue(
        ['tasks', index, 'evidenceRevision'],
        'Only a SETTLED or BLOCKED entry may carry evidence.',
      );
    }
    // A result commit is a claim about finished work. Nothing else may carry
    // one — least of all a task that has not started.
    if (task.resultCommit !== null && task.disposition !== 'SETTLED') {
      issue(['tasks', index, 'resultCommit'], 'Only a SETTLED entry may carry a resultCommit.');
    }
  });

  // --- 5. A stopped run is not also running --------------------------------
  if (value.stopReason !== null && value.activeTaskId !== null) {
    issue(['stopReason'], 'A run with a stop reason must not also have an active task.');
  }
  // `COMPLETE` is the one stop reason that is a claim about every task.
  if (value.stopReason === 'COMPLETE' &&
      value.tasks.some((task) => task.disposition !== 'SETTLED')) {
    issue(['stopReason'], 'COMPLETE requires every task to be SETTLED.');
  }
});

/** Throws a `ZodError` if the document violates the contract. */
export function parseBlockRunLedger(value: unknown): BlockRunLedger {
  return BlockRunLedgerSchema.parse(value);
}

/** Non-throwing variant of {@link parseBlockRunLedger}. */
export function safeParseBlockRunLedger(value: unknown) {
  return BlockRunLedgerSchema.safeParse(value);
}

/** The entry for `taskId`, or `null` when this run does not hold that task. */
export function entryFor(ledger: BlockRunLedger, taskId: string): BlockTaskEntry | null {
  return ledger.tasks.find((task) => task.taskId === taskId) ?? null;
}
