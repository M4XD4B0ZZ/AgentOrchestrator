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
 * ── Frozen membership, and what "frozen" had to be made to mean ────────────
 *
 * `frozenTaskIds` and `planFingerprint` are written once, when the run starts,
 * and never change. A roadmap edited mid-run must not silently swap task four
 * while tasks one to three have already gone; the frozen copy is what a later
 * check compares the current definition against, and drift is *reported*, never
 * adopted.
 *
 * That was the intent from the start, and for one slice it was only prose. A
 * caller holding a current revision could rewrite the frozen list, and a stored
 * `planFingerprint` could describe a plan the document did not list — which
 * does not merely lose drift detection, it inverts it. Both are now contract:
 * the fingerprint is re-derived from the document that carries it, and
 * {@link assessLedgerSuccession} decides which fields a successor may touch at
 * all. See that function for why a compare-and-swap never answered this.
 *
 * ── Two questions this document does not confuse ───────────────────────────
 *
 * A ledger is about one run. "At most one `ACTIVE` task" is a guarantee *per
 * ledger*, and is all a document about one run can honestly offer. Two runs of
 * one repository can each hold the same task `ACTIVE`, and no invariant here
 * could see it. Deciding which process may produce effects for a task is
 * repository-wide execution ownership — the execution lease's contract, keyed
 * on the local Git administrative identity rather than on the profile's
 * `repositoryId` — and this module deliberately does not grow half of it.
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
import {
  fingerprintFrozenMembership,
  isValidBlockId,
  MAX_BLOCK_TASKS,
} from './block-definition.js';

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
  /**
   * Given up on, on the strength of a task state that reached `ABORTED`.
   *
   * Terminal, and deliberately **not** `BLOCKED`. The two look similar and are
   * opposite: a blocked task is waiting for a human and stops the run as a
   * matter of policy, while an abandoned one is over — nothing continues from
   * `ABORTED`, and there is nothing for a human to resolve.
   *
   * Without it the run has no legal move at all when its active task aborts:
   * settling would claim work that did not finish, parking would claim a block
   * that does not exist, and `stopBlockRun` refuses while a task is `ACTIVE`.
   * A contract whose only remaining move is to falsify one of its own records
   * has wedged the run, and inventing progress to escape is exactly what this
   * ledger exists to prevent.
   */
  'ABANDONED',
] as const;

export type TaskDisposition = (typeof TASK_DISPOSITIONS)[number];

/** Dispositions that assert an outcome and therefore require evidence. */
const EVIDENCE_BACKED: ReadonlySet<TaskDisposition> = new Set<TaskDisposition>([
  'SETTLED',
  'BLOCKED',
  'ABANDONED',
]);


/**
 * Why a run is not continuing. A closed set, because "the block simply stopped"
 * is the one thing an operator must never be told.
 */
export const BLOCK_STOP_REASONS = [
  /** Every frozen task is settled. The intended end. */
  'COMPLETE',
  /** A task is blocked and only a human continues it. */
  'TASK_BLOCKED',
  /** A task was given up on, so the block cannot be completed. */
  'TASK_ABANDONED',
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

/**
 * The stop reasons that assert something about the tasks, rather than about the
 * run's ability to continue.
 *
 * The distinction earns its keep twice over. A reason in this set is proved
 * against every task's own record before it is written; the others claim no
 * progress and must stay writable over a ledger whose entries are *not*
 * supported, because a run that has just detected a divergence has to be able
 * to say so.
 *
 * It lives here, with the contract, rather than beside the gate that consumes
 * it. The schema and the store both have to answer "does this reason claim
 * progress?", and two answers to that question would be two contracts.
 */
export const PROGRESS_CLAIMING_STOP_REASONS: ReadonlySet<BlockStopReason> =
  new Set<BlockStopReason>(['COMPLETE', 'TASK_BLOCKED', 'TASK_ABANDONED']);

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
  // A block id that is also one of its own task ids makes a finding reported
  // against the *block* indistinguishable from one reported against that task:
  // the two id grammars are deliberately the same rule, so nothing but this
  // separates them, and a reconciliation reports both under one field name.
  // Refused here as well as in `defineBlock`, because a document did not have
  // to come from a definition to get here.
  if (value.frozenTaskIds.includes(value.blockId)) {
    issue(['blockId'], 'blockId must not also be a task id of this block.');
  }

  // --- 1b. The fingerprint describes the plan the document actually lists ---
  // `planFingerprint` used to be stored and believed, which made it possible
  // for a ledger to carry the digest of a plan it does not contain. That is
  // worse than losing drift detection: it *inverts* it, so the honest roadmap
  // reports as drifted and the edited one reports as clean. Re-derived here,
  // from the document itself, so the two spellings of the frozen plan can never
  // disagree — on creation, on update and on every load.
  if (value.planFingerprint !== fingerprintFrozenMembership(value.blockId, value.frozenTaskIds)) {
    issue(
      ['planFingerprint'],
      'planFingerprint must be the fingerprint of this document’s own blockId and frozenTaskIds.',
    );
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

  // --- 4. An outcome claim carries the evidence that justified it ----------
  value.tasks.forEach((task, index) => {
    const claimsOutcome = EVIDENCE_BACKED.has(task.disposition);
    if (claimsOutcome && task.evidenceRevision === null) {
      issue(
        ['tasks', index, 'evidenceRevision'],
        `${task.disposition} must carry the task-state revision that proved it.`,
      );
    }
    if (!claimsOutcome && task.evidenceRevision !== null) {
      issue(
        ['tasks', index, 'evidenceRevision'],
        'Only a SETTLED, BLOCKED or ABANDONED entry may carry evidence.',
      );
    }
    // A result commit is a claim about finished work. Nothing else may carry
    // one — least of all a task that has not started.
    if (task.resultCommit !== null && task.disposition !== 'SETTLED') {
      issue(['tasks', index, 'resultCommit'], 'Only a SETTLED entry may carry a resultCommit.');
    }
    // A base commit is a claim that this run pinned the task to a tree, which
    // is only knowable once the task has a durable state to read it from.
    if (task.baseCommit !== null && task.disposition === 'PLANNED') {
      issue(['tasks', index, 'baseCommit'], 'A PLANNED entry has no base commit to record yet.');
    }
  });

  // --- 5. A stopped run may still be holding an unresolved task ------------
  // For one slice this read "a stopped run is not also running" and forbade the
  // two outright. That was the wrong shape, and it cost the run the one write
  // it must always have.
  //
  // A task whose record has become unreadable can be neither settled, parked
  // nor abandoned — no evidence proves any of the three — so requiring
  // `activeTaskId` to be cleared first was requiring a disposition to move,
  // which re-arms the whole evidence proof. A run could therefore *see*
  // `STATE_UNUSABLE` and never record it, and the only move left was to edit
  // the ledger by hand: precisely what this contract exists to prevent.
  //
  // So the honest record is now sayable: the block stopped while this task was
  // still unresolved. Rewinding the entry to `PLANNED` was the other way out
  // and is a worse one — it claims the task was never started, when the run
  // knows perfectly well that it was.
  //
  // What may still never coexist with an active task is a reason that claims
  // the *tasks* did something. Those three are proved against the task records,
  // and a run still holding an unresolved task has not finished, has not been
  // blocked, and has not given anything up. `assessLedgerSuccession` holds the
  // other half: such a stop may say that the run stopped, and nothing else.
  if (
    value.stopReason !== null &&
    value.activeTaskId !== null &&
    PROGRESS_CLAIMING_STOP_REASONS.has(value.stopReason)
  ) {
    issue(
      ['stopReason'],
      `${value.stopReason} must not be claimed while a task is still ACTIVE.`,
    );
  }
  // Three stop reasons are claims about the entries, and are checked against
  // them here. That is a consistency check and never a *proof*: whether the
  // entries themselves are supported is a question about the task records,
  // answered in `block-evidence.ts` before any of this is written.
  if (value.stopReason === 'COMPLETE' &&
      value.tasks.some((task) => task.disposition !== 'SETTLED')) {
    issue(['stopReason'], 'COMPLETE requires every task to be SETTLED.');
  }
  if (value.stopReason === 'TASK_BLOCKED' &&
      !value.tasks.some((task) => task.disposition === 'BLOCKED')) {
    issue(['stopReason'], 'TASK_BLOCKED requires a task recorded as BLOCKED.');
  }
  if (value.stopReason === 'TASK_ABANDONED' &&
      !value.tasks.some((task) => task.disposition === 'ABANDONED')) {
    issue(['stopReason'], 'TASK_ABANDONED requires a task recorded as ABANDONED.');
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

/* ─────────────────────── successor authority ─────────────────────────────── */

/**
 * Which successors a given ledger may legally have.
 *
 * ── The question a compare-and-swap does not answer ────────────────────────
 *
 * A revision check answers exactly one thing:
 *
 * > Has anybody written since the revision I read?
 *
 * It does **not** answer:
 *
 * > May this successor change these fields at all?
 *
 * V2-07 read the first answer as though it were the second, and a caller
 * holding nothing but a current revision could therefore rewrite the frozen
 * plan, rename the block, backdate the run, rewind a mid-flight task to
 * `PLANNED` with its evidence erased, or relabel why the run stopped — all
 * through the sanctioned API, with no hand-editing and no corruption. A fresh
 * revision is proof that nobody else wrote; it was never authority over what
 * this writer may write.
 *
 * So succession is its own contract, checked against the ledger **as persisted**
 * rather than against the caller's copy of it.
 */
export const LEDGER_SUCCESSION_VIOLATIONS = [
  /** The successor is about a different run, repository, block or start. */
  'RUN_IDENTITY_CHANGED',
  /** The membership frozen at start, or its fingerprint, was rewritten. */
  'FROZEN_PLAN_CHANGED',
  /** A task's disposition moved backwards, or out of a terminal one. */
  'DISPOSITION_REWOUND',
  /** An entry was edited without its disposition changing. */
  'RECORDED_ENTRY_CHANGED',
  /** A run that already stopped was given a different reason, or restarted. */
  'STOP_REASON_RELABELLED',
  /** A run that had already recorded its ending changed one of its records. */
  'STOPPED_RUN_PROGRESSED',
  /** A stop recorded over a still-unresolved active task said more than that. */
  'UNRESOLVED_STOP_CARRIED_MORE',
] as const;

export type LedgerSuccessionViolation = (typeof LEDGER_SUCCESSION_VIOLATIONS)[number];

/**
 * The dispositions each disposition may move to.
 *
 * Read it as a one-way street. Every forward move is one the progress API can
 * justify from a task record; nothing moves back, and nothing leaves `SETTLED`
 * or `ABANDONED` — a task that has finished, or that has been given up on, has
 * a past that a later writer does not get to revise.
 *
 * `BLOCKED` is the one non-terminal outcome: a human resolves it and the task
 * either finishes or is abandoned. It deliberately does not lead back to
 * `ACTIVE` — re-driving a blocked task is a runner decision V2-08 has to make
 * with evidence in front of it, and a ledger that already permitted the write
 * would have made it in advance.
 */
const LEGAL_SUCCESSION: Readonly<Record<TaskDisposition, readonly TaskDisposition[]>> =
  Object.freeze({
    PLANNED: Object.freeze(['ACTIVE', 'SETTLED', 'BLOCKED', 'ABANDONED'] as const),
    ACTIVE: Object.freeze(['SETTLED', 'BLOCKED', 'ABANDONED'] as const),
    BLOCKED: Object.freeze(['SETTLED', 'ABANDONED'] as const),
    SETTLED: Object.freeze([] as const),
    ABANDONED: Object.freeze([] as const),
  });

/** `true` when the two entries are the same record, field for field. */
function sameEntry(a: BlockTaskEntry, b: BlockTaskEntry): boolean {
  return (
    a.taskId === b.taskId &&
    a.disposition === b.disposition &&
    a.evidenceRevision === b.evidenceRevision &&
    a.baseCommit === b.baseCommit &&
    a.resultCommit === b.resultCommit
  );
}

/** `true` when the two documents hold the same task records, in order. */
function sameEntries(previous: BlockRunLedger, next: BlockRunLedger): boolean {
  return (
    previous.tasks.length === next.tasks.length &&
    previous.tasks.every((before, index) => {
      const after = next.tasks[index];
      return after !== undefined && sameEntry(before, after);
    })
  );
}

/**
 * `true` when `next` is `previous` with nothing but its stop reason set.
 *
 * Every field of the document except `stopReason` is named here, deliberately
 * and exhaustively, in the same spirit as {@link sameEntry}: this is the
 * predicate that keeps the one evidence-exempt write from becoming the one
 * write that can carry anything. A field added to the contract and not added
 * here would be a field that write could change unexamined, so the list is
 * meant to be edited whenever the schema is.
 */
function onlyStopReasonChanged(previous: BlockRunLedger, next: BlockRunLedger): boolean {
  return (
    next.schemaVersion === previous.schemaVersion &&
    next.repositoryId === previous.repositoryId &&
    next.repositoryRoot === previous.repositoryRoot &&
    next.blockId === previous.blockId &&
    next.runId === previous.runId &&
    next.startedAt === previous.startedAt &&
    next.planFingerprint === previous.planFingerprint &&
    next.activeTaskId === previous.activeTaskId &&
    next.frozenTaskIds.length === previous.frozenTaskIds.length &&
    next.frozenTaskIds.every((taskId, index) => taskId === previous.frozenTaskIds[index]) &&
    sameEntries(previous, next)
  );
}

/**
 * Every way `next` fails to be a legal successor of `previous`.
 *
 * All of them, not the first: a caller refusing a write should be able to say
 * everything that was wrong with it, and a partial answer invites a second
 * attempt that fixes one thing.
 *
 * Both arguments must already satisfy the ledger contract; this asks only about
 * the *relation* between two valid documents.
 */
export function assessLedgerSuccession(
  previous: BlockRunLedger,
  next: BlockRunLedger,
): readonly LedgerSuccessionViolation[] {
  const violations = new Set<LedgerSuccessionViolation>();

  // Identity: what this run *is*. Written once, at creation.
  if (
    next.schemaVersion !== previous.schemaVersion ||
    next.runId !== previous.runId ||
    next.repositoryId !== previous.repositoryId ||
    next.repositoryRoot !== previous.repositoryRoot ||
    next.blockId !== previous.blockId ||
    next.startedAt !== previous.startedAt
  ) {
    violations.add('RUN_IDENTITY_CHANGED');
  }

  // The frozen plan. The module header calls it written once and never edited;
  // until now nothing enforced that beyond the header.
  if (
    next.frozenTaskIds.length !== previous.frozenTaskIds.length ||
    next.frozenTaskIds.some((taskId, index) => taskId !== previous.frozenTaskIds[index]) ||
    next.planFingerprint !== previous.planFingerprint
  ) {
    violations.add('FROZEN_PLAN_CHANGED');
  }

  // Per entry: forward only, and a record that did not move did not change.
  // Entries mirror `frozenTaskIds` in both documents (the contract says so), so
  // once the frozen plan is unchanged the two lists line up by index.
  if (!violations.has('FROZEN_PLAN_CHANGED')) {
    previous.tasks.forEach((before, index) => {
      const after = next.tasks[index];
      if (after === undefined) return;
      if (after.disposition === before.disposition) {
        if (!sameEntry(before, after)) violations.add('RECORDED_ENTRY_CHANGED');
        return;
      }
      if (!LEGAL_SUCCESSION[before.disposition].includes(after.disposition)) {
        violations.add('DISPOSITION_REWOUND');
      }
    });
  }

  // Why a run stopped is history. Once written it is neither relabelled nor
  // cleared: an operator reading `OPERATOR_STOPPED` over a run that actually
  // detected `LEDGER_DIVERGED` is reading a deliberate ending that never
  // happened, and the only durable trace of the divergence is gone.
  if (previous.stopReason !== null && next.stopReason !== previous.stopReason) {
    violations.add('STOP_REASON_RELABELLED');
  }

  // A run that has recorded why it is not continuing has a past, not a present.
  // `block-progress` refuses to progress a stopped run and, until this rule
  // existed, was the *only* thing that did — which made it caller manners
  // rather than contract, and a caller going straight to the store walked
  // around it exactly as one walked around the evidence proof before the store
  // owned that. The result was a durable ledger reading `LEDGER_DIVERGED` over
  // entries that had all moved to `SETTLED` afterwards, every one of them
  // genuinely proved, which a reconciliation then called consistent.
  //
  // Note what this does *not* say: the stop reason itself is already write-once
  // above, and an ended run holding an unresolved `ACTIVE` task keeps it. What
  // is frozen is the record — no disposition moves, no entry is edited, and the
  // task the run was working on when it ended stays the task it was working on.
  if (previous.stopReason !== null) {
    if (!sameEntries(previous, next) || next.activeTaskId !== previous.activeTaskId) {
      violations.add('STOPPED_RUN_PROGRESSED');
    }
  }

  // The escape hatch, held to its own minimum.
  //
  // A run may record that it stopped while a task is still unresolved — see the
  // contract rule this pairs with — and that write is exempt from the evidence
  // proof, because the whole point is that no evidence is available. An exempt
  // write that could also carry a disposition, a commit or a rewritten identity
  // would be the widest hole in the module rather than its narrowest allowance.
  // So it may say one thing: that the run stopped.
  if (previous.stopReason === null && next.stopReason !== null && next.activeTaskId !== null) {
    if (!onlyStopReasonChanged(previous, next)) {
      violations.add('UNRESOLVED_STOP_CARRIED_MORE');
    }
  }

  return Object.freeze([...violations]);
}
