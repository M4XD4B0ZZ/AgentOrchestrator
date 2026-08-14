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
 * branch pin — and `resultCommit` is populated only when the task's own record
 * proves it, which means it equals the `currentCommit` that record carries.
 * Not that the object exists in Git: nothing here asks Git anything, and
 * `block-evidence.ts` says so where the check lives. V2-09 will make one task's `resultCommit` the next
 * task's `baseCommit`; the fields are here so that doing so needs no new ledger
 * shape, and are deliberately *not* interpreted as a chain by anything yet.
 *
 * Note the distinction the two fields keep apart, which is easy to lose and
 * expensive to lose: a task reaching `READY_FOR_PR` is a **terminal task
 * state**, and a `resultCommit` is **a commit fit to be a successor's base**.
 * V2-07 records the first. Claiming every `READY_FOR_PR` task automatically has
 * the second is exactly the assumption V2-09 has to earn.
 */

import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { compareTaskIds, isValidTaskId } from '../plan/task-id.js';
import {
  fingerprintFrozenMembership,
  isValidBlockId,
  MAX_BLOCK_TASKS,
  type FrozenTaskDependency,
} from './block-definition.js';

/**
 * Contract version of the ledger document. Bump on any breaking shape change.
 *
 * **2 (V2-08).** Two changes land under one bump, deliberately: the frozen plan
 * gained `frozenDependencies`, and `BLOCK_STOP_REASONS` gained
 * `ACTIVE_TASK_UNRESOLVED`. Not one bump per value — and, equally deliberately,
 * no "the enum grew but the version stayed" exception. A reader of version 1
 * genuinely cannot understand a version-2 document: it would meet a stop reason
 * outside its closed vocabulary and a field its `.strict()` schema refuses.
 * Pretending otherwise is the kind of convenient untruth this repository keeps
 * removing.
 *
 * A version-1 document is refused on load and **never migrated**. See
 * `LEDGER_SCHEMA_UNSUPPORTED` in `block-store.ts` for why inventing the missing
 * relation would be worse than refusing.
 */
export const BLOCK_LEDGER_SCHEMA_VERSION = 2;

/** What the run has durably established about one of its tasks. */
export const TASK_DISPOSITIONS = [
  /** Frozen into the run and not yet started. */
  'PLANNED',
  /** The run is working on it. At most one task may be here. */
  'ACTIVE',
  /** Finished, on the strength of a task state that proved it. */
  'SETTLED',
  /**
   * Stopped on something a human must resolve. Also evidence-backed.
   *
   * Terminal for this task and **not** for the run. Until V2-08 this was
   * documented the other way round — "a blocked task is waiting for a human and
   * stops the run as a matter of policy" — and `parkBlockTask` implemented it by
   * writing a stop reason. Both are gone. A block of independent tasks in which
   * one fails locally is not a wasted run: the remaining tasks are still
   * provable on their own records, and stopping would have thrown away work
   * nothing was wrong with.
   *
   * What did not change: this disposition is still `EVIDENCE_BACKED`, still
   * terminal for the task, and still unrecordable without the task state that
   * proves it.
   */
  'BLOCKED',
  /**
   * Given up on, on the strength of a task state that reached `ABORTED`.
   *
   * Terminal, and deliberately **not** `BLOCKED`. The two look similar and are
   * opposite: a blocked task is waiting for a human, while an abandoned one is
   * over — nothing continues from `ABORTED`, and there is nothing for a human to
   * resolve.
   *
   * Without it the run has no legal move at all when its active task aborts:
   * settling would claim work that did not finish, parking would claim a block
   * that does not exist, and `stopBlockRun` refuses a progress-claiming reason
   * while a task is `ACTIVE`. A contract whose only remaining move is to falsify
   * one of its own records has wedged the run, and inventing progress to escape
   * is exactly what this ledger exists to prevent.
   *
   * Like `BLOCKED`, it no longer ends the run by itself (V2-08). `COMPLETE`
   * still requires every task `SETTLED`, so an abandoned task correctly makes
   * the block uncompletable rather than silently forgivable.
   */
  'ABANDONED',
] as const;

export type TaskDisposition = (typeof TASK_DISPOSITIONS)[number];

/**
 * Dispositions that assert an outcome and therefore require evidence.
 *
 * Exported for the same reason {@link PROGRESS_CLAIMING_STOP_REASONS} is: the
 * contract and the proof both have to answer "does this entry carry evidence?",
 * and two answers to that question would be two contracts. `block-evidence.ts`
 * re-derives `evidenceRevision` for exactly this set and for no other
 * disposition, because rule 4 below pins the field to `null` everywhere else.
 */
export const EVIDENCE_BACKED: ReadonlySet<TaskDisposition> = new Set<TaskDisposition>([
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
  /**
   * An active task's outcome could not be safely established, so the run ends.
   *
   * ── Why this is not `STATE_UNUSABLE` ───────────────────────────────────────
   *
   * `STATE_UNUSABLE` says something about the task *state*: damaged, foreign,
   * not trustworthy. A task can hold entirely legitimate prior evidence and
   * still end in a condition whose outcome cannot be determined — a driver that
   * made no progress, a settlement whose proof no longer holds, an interruption
   * nothing can conclude. That is a **different fact**, and folding it into
   * `STATE_UNUSABLE` is exactly the misdescription class V2-07P spent three
   * review rounds deleting.
   *
   * ── What it may and may not carry ──────────────────────────────────────────
   *
   * It **may coexist** with `ACTIVE` and an unchanged `activeTaskId`: it does
   * not require the run to first invent a disposition for the task it could not
   * conclude. It drags **no** task disposition and **no** commit evidence with
   * it — `assessLedgerSuccession`'s `UNRESOLVED_STOP_CARRIED_MORE` already holds
   * that write to saying one thing.
   *
   * It is deliberately **not** required to have an active task. The design says
   * where it may coexist with one, never that it may only be written with one,
   * and a class-2 reason that quietly acquired a precondition is the shape that
   * wedges a run in the case the reason was added for.
   */
  'ACTIVE_TASK_UNRESOLVED',
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
 *
 * `ACTIVE_TASK_UNRESOLVED` is deliberately not a member, and the omission is
 * load-bearing rather than incidental. Sorted in, it would be proved against
 * every task record before it could be written — and it exists precisely for
 * the case where one of those records cannot be judged. It would be unwritable
 * exactly when it is true.
 */
export const PROGRESS_CLAIMING_STOP_REASONS: ReadonlySet<BlockStopReason> =
  new Set<BlockStopReason>(['COMPLETE', 'TASK_BLOCKED', 'TASK_ABANDONED']);

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const TaskIdSchema = z.string().refine(isValidTaskId, 'Must be a canonical task id.');

const FrozenTaskDependencySchema = z
  .object({
    taskId: TaskIdSchema,
    /** Members this task transitively depends on. Deduplicated and sorted. */
    dependsOn: z.array(TaskIdSchema).max(MAX_BLOCK_TASKS),
  })
  .strict();

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
    /**
     * The dependency relation as frozen at start. Never edited afterwards.
     *
     * The **only** persisted image of the relation. No `dependents` copy sits
     * beside it: two spellings of one fact are two facts that can disagree, and
     * the one a run's continuation decision reads would then be a matter of
     * which the caller happened to look at.
     */
    frozenDependencies: z.array(FrozenTaskDependencySchema).min(1).max(MAX_BLOCK_TASKS),
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

  // --- 1a. The relation is one row per frozen task, in the same order -------
  // The same shape as rule 1, for the same reason: the frozen plan is the run's
  // identity, and a relation that drifted from the membership would make "what
  // does this run consider independent" a question with two answers. Row order
  // mirrors `frozenTaskIds`, so row order carries no information of its own and
  // one relation cannot have two fingerprints.
  const relationIds = value.frozenDependencies.map((row) => row.taskId);
  if (
    relationIds.length !== value.frozenTaskIds.length ||
    relationIds.some((id, index) => id !== value.frozenTaskIds[index])
  ) {
    issue(
      ['frozenDependencies'],
      'frozenDependencies must carry exactly one row per frozen task, in the same order.',
    );
  }
  const frozenMembers = new Set(value.frozenTaskIds);
  value.frozenDependencies.forEach((row, index) => {
    for (const dependency of row.dependsOn) {
      if (dependency === row.taskId) {
        issue(['frozenDependencies', index, 'dependsOn'], 'A task may not depend on itself.');
      } else if (!frozenMembers.has(dependency)) {
        // The relation is the *projection* onto this block's members. An edge
        // to a non-member is not a stricter relation, it is a different one —
        // and a runner reading it would answer independence from a task the
        // ledger says nothing else about.
        issue(
          ['frozenDependencies', index, 'dependsOn'],
          'A frozen dependency must name a task of this block.',
        );
      }
    }
    const canonical = [...new Set(row.dependsOn)].sort(compareTaskIds);
    if (
      row.dependsOn.length !== canonical.length ||
      row.dependsOn.some((id, position) => id !== canonical[position])
    ) {
      issue(
        ['frozenDependencies', index, 'dependsOn'],
        'dependsOn must be deduplicated and canonically sorted.',
      );
    }
  });

  // --- 1b. The fingerprint describes the plan the document actually lists ---
  // `planFingerprint` used to be stored and believed, which made it possible
  // for a ledger to carry the digest of a plan it does not contain. That is
  // worse than losing drift detection: it *inverts* it, so the honest roadmap
  // reports as drifted and the edited one reports as clean. Re-derived here,
  // from the document itself, so the two spellings of the frozen plan can never
  // disagree — on creation, on update and on every load.
  if (
    value.planFingerprint !==
    fingerprintFrozenMembership(value.blockId, value.frozenTaskIds, value.frozenDependencies)
  ) {
    issue(
      ['planFingerprint'],
      'planFingerprint must be the fingerprint of this document’s own blockId, frozenTaskIds and frozenDependencies.',
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
  /**
   * An entry moved forward legally and carried more than the move.
   *
   * The counterpart of `RECORDED_ENTRY_CHANGED` for the case that rule cannot
   * answer. An entry whose disposition moves *must* change — that is what a
   * move is — so the question is not whether it changed but whether it changed
   * in anything beyond the fields the write gate re-derives from the task
   * record.
   */
  'MOVED_ENTRY_CARRIED_MORE',
  /** A run that already stopped was given a different reason, or restarted. */
  'STOP_REASON_RELABELLED',
  /**
   * A run that had already recorded its ending was given a different document.
   *
   * Named for the case it exists to stop — a stopped run being progressed —
   * but deliberately wider than that: it fires for *any* difference other than
   * the stop reason, identity and frozen plan included, because a run with a
   * past has no field left that a successor may move. The narrower reasons
   * co-fire when they apply.
   */
  'STOPPED_RUN_PROGRESSED',
  /** A stop recorded over a still-unresolved active task said more than that. */
  'UNRESOLVED_STOP_CARRIED_MORE',
] as const;

export type LedgerSuccessionViolation = (typeof LEDGER_SUCCESSION_VIOLATIONS)[number];

/**
 * Which part of the successor contract is answerable for each persisted field.
 *
 * A **completeness** obligation, made compile-time — and nothing more than
 * that. Every key of the document appears exactly once, and the `satisfies` is
 * against `keyof BlockRunLedger`, which is inferred from the schema, so adding a
 * field to {@link BlockRunLedgerObjectSchema} without deciding what succession
 * does about it does not compile.
 *
 * ── What this map does not prove, and what does ────────────────────────────
 *
 * It makes the classification *total*. It cannot make any entry *correct*:
 * nothing in the type system objects to `startedAt` being called a record
 * field, and when that was tried the build was clean and the entire suite
 * stayed green while a run could be backdated through the sanctioned API. A
 * map like this one relocates the reviewer's prompt; it does not decide the
 * answer, and reading it as an authority proof is how it would become a new
 * self-consistent bug.
 *
 * So correctness lives where it can actually fail:
 * `tests/v2-07-remediation.test.ts`
 * mutates every persisted field on its own and asserts the exact verdict, with
 * expectations written by hand rather than derived from here. This module
 * deliberately does not export the map, so that test cannot become a second
 * copy of it and lose the ability to disagree.
 *
 * ── Which classes carry a rule, and which name one kept elsewhere ──────────
 *
 * `IDENTITY` and `FROZEN_PLAN` are enforced by derivation from this map, so a
 * field classified as either is enforced by having been classified.
 *
 * `RECORD` and `STOP_REASON` deliberately derive nothing here, and that is
 * stated rather than implied: their authority is real but sited elsewhere, and
 * pressing them into a generic rule so that every token "does something" would
 * buy symmetry with a fiction. `activeTaskId` is fully determined by rules 2
 * and 3 of the contract above — the dispositions leave it exactly one legal
 * value — `tasks` is held by {@link sameEntry} and
 * {@link onlyReprovedFieldsChanged} below, and `stopReason` is write-once at
 * the check that names it. Each of those is pinned by its own counter-proof, so
 * a classification token here is never the evidence that a field is guarded.
 */
const FIELD_AUTHORITY = {
  schemaVersion: 'IDENTITY',
  repositoryId: 'IDENTITY',
  repositoryRoot: 'IDENTITY',
  blockId: 'IDENTITY',
  runId: 'IDENTITY',
  startedAt: 'IDENTITY',
  frozenTaskIds: 'FROZEN_PLAN',
  frozenDependencies: 'FROZEN_PLAN',
  planFingerprint: 'FROZEN_PLAN',
  activeTaskId: 'RECORD',
  tasks: 'RECORD',
  stopReason: 'STOP_REASON',
} as const satisfies Record<
  keyof BlockRunLedger,
  'IDENTITY' | 'FROZEN_PLAN' | 'RECORD' | 'STOP_REASON'
>;

const fieldsClassified = (
  authority: (typeof FIELD_AUTHORITY)[keyof typeof FIELD_AUTHORITY],
): readonly (keyof BlockRunLedger)[] =>
  Object.freeze(
    (Object.keys(FIELD_AUTHORITY) as (keyof BlockRunLedger)[]).filter(
      (field) => FIELD_AUTHORITY[field] === authority,
    ),
  );

/** What this run *is*, taken from the map above rather than restated. */
const IDENTITY_FIELDS = fieldsClassified('IDENTITY');

/** The plan frozen at start, likewise taken from the map. */
const FROZEN_PLAN_FIELDS = fieldsClassified('FROZEN_PLAN');

/**
 * The same obligation one level down, for the fields of a single entry.
 *
 * `FIELD_AUTHORITY` is keyed on `keyof BlockRunLedger`, so it is silent about
 * everything inside `tasks` — and an entry is where the ledger keeps its actual
 * claims. Without this map the authority gap was not closed but moved: a field
 * added to {@link BlockTaskEntrySchema} compiled without a decision, and then
 * mutated freely on every legitimate step, because succession stops looking
 * once a disposition moves and `proveBlockTaskEntry` reads five fields by name.
 *
 * Two classes, and the split is the whole rule:
 *
 *   `PINNED`     nothing may change it during a move. Enforced by derivation —
 *                by *not* appearing in the projection below — so a new field
 *                classified this way is guarded by having been classified.
 *
 *   `REPROVED`   it may change during a move, because something else on the
 *                very same write decides what it is allowed to become. Two
 *                mechanisms share that job, and naming only the first would
 *                overstate it: `block-evidence.ts` re-derives the field from
 *                the task record *where the disposition permits a value*, and
 *                rule 4 of the contract above pins it to `null` where it does
 *                not. `disposition` and `baseCommit` are re-derived for every
 *                disposition; `evidenceRevision` only for the three that carry
 *                evidence, and `resultCommit` only for `SETTLED` — for the rest
 *                both are `null` on either side of any move, so there is no
 *                freedom left to abuse.
 *
 *                For one revision this class was the module's soft spot, and it
 *                failed exactly where an unchecked assertion always fails. The
 *                classification was a *promise* that another gate re-derives the
 *                field, and nothing made the promise keepable: declaring a new
 *                entry field, writing `REPROVED` beside it and changing nothing
 *                else compiled clean, and the value was then persisted with a
 *                stolen value riding a settlement that was itself entirely
 *                honest — `proveBlockTaskEntry` read five field names and never
 *                saw it. {@link ReprovedEntryField} closes that: the class now
 *                *demands* a handler, and `block-evidence.ts` cannot compile
 *                without one for every member.
 *
 * `taskId` is `PINNED` twice over: rule 1 already requires the entries to
 * mirror the frozen plan, so this restates a guarantee rather than inventing
 * one, and costs nothing if that rule is ever relaxed.
 */
export type EntryFieldAuthority = 'PINNED' | 'REPROVED';

const ENTRY_FIELD_AUTHORITY = {
  taskId: 'PINNED',
  disposition: 'REPROVED',
  evidenceRevision: 'REPROVED',
  baseCommit: 'REPROVED',
  resultCommit: 'REPROVED',
} as const satisfies Record<keyof BlockTaskEntry, EntryFieldAuthority>;

/**
 * Exactly the entry fields classified `REPROVED`, as a type.
 *
 * The other half of that classification's cost, and the reason it is no longer
 * a promise nobody can be held to. `block-evidence.ts` keeps a registry of
 * proof handlers `satisfies Record<ReprovedEntryField, …>`, so this union is
 * what that file must cover: classify a field `REPROVED` and the registry stops
 * compiling until a handler for it exists; declassify one and the leftover
 * handler is an excess property. The two files cannot drift, and neither can be
 * edited into agreement without the other noticing.
 *
 * The threshold this sets is deliberate and worth stating, because it is not
 * the obvious one. It does **not** promise that a handler is *correct* — a
 * developer can always write a prover that proves nothing, and no type can see
 * that. What it makes impossible is the failure that actually happened: a field
 * classified `REPROVED` with **no handler at all**, silently inheriting a proof
 * written before it existed. Completeness is the type's job; correctness is the
 * job of the per-field forgery tests in `tests/v2-07-remediation.test.ts`, which
 * mutate each field against durable evidence and require a refusal.
 */
export type ReprovedEntryField = {
  [K in keyof typeof ENTRY_FIELD_AUTHORITY]: (typeof ENTRY_FIELD_AUTHORITY)[K] extends 'REPROVED'
    ? K
    : never;
}[keyof typeof ENTRY_FIELD_AUTHORITY];

/**
 * The union above may never be empty — and this is what says so.
 *
 * A guarantee has to protect its own foundation or it protects nothing. The
 * union is read out of `ENTRY_FIELD_AUTHORITY`'s *literal* value type, which
 * only survives because the map is written `as const satisfies …`. Replace that
 * with the ordinary-looking annotation
 *
 *     const ENTRY_FIELD_AUTHORITY: Record<keyof BlockTaskEntry, EntryFieldAuthority> = { … }
 *
 * and every value widens to the union, no key matches `extends 'REPROVED'`, and
 * this type silently becomes `never`. `Record<never, …>` is `{}`, which every
 * object satisfies — so the registry in `block-evidence.ts` would accept an
 * empty one, and a field classified `REPROVED` with no handler at all would
 * compile clean. Measured: deleting an existing prover while its field stays
 * `REPROVED` went from a compile error to `exit 0`.
 *
 * Nothing else catches that. It is not a type error anywhere, and it looks like
 * a style change in review. So the emptiness is asserted directly, and the
 * assertion carries its own diagnosis into the compiler's message.
 */
type NonEmptyUnion<T, Why extends string> = [T] extends [never] ? { readonly ERROR: Why } : true;

const _entryAuthorityStillDerivesItsUnion: NonEmptyUnion<
  ReprovedEntryField,
  'ENTRY_FIELD_AUTHORITY lost its literal types — restore `as const satisfies`, or every REPROVED field is unguarded'
> = true;
void _entryAuthorityStillDerivesItsUnion;

/** The entry fields the write gate re-derives, taken from the map above. */
const REPROVED_ON_MOVE: readonly ReprovedEntryField[] = Object.freeze(
  (Object.keys(ENTRY_FIELD_AUTHORITY) as (keyof BlockTaskEntry)[]).filter(
    (field): field is ReprovedEntryField => ENTRY_FIELD_AUTHORITY[field] === 'REPROVED',
  ),
);

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

/**
 * `true` when the two entries are the same record.
 *
 * Compared structurally rather than field by field, for the reason spelled out
 * over {@link onlyStopReasonChanged}: a list of field names is a list somebody
 * has to remember to extend, and the day it is not extended is the day a new
 * entry field may be rewritten on a record that did not move.
 */
function sameEntry(a: BlockTaskEntry, b: BlockTaskEntry): boolean {
  return isDeepStrictEqual(a, b);
}

/**
 * `true` when `after` is `before` with nothing but its re-proved fields moved.
 *
 * The question {@link sameEntry} cannot ask. An entry whose disposition moves
 * *has* to change — recording the move is the point — so "did it change" is the
 * wrong question and equality is the wrong test. The right question is whether
 * it changed in anything the write gate will not look at, and that is answered
 * the same way {@link onlyStopReasonChanged} answers its own: construct the
 * document the move is entitled to produce and compare it structurally.
 *
 * Everything outside {@link REPROVED_ON_MOVE} is therefore covered by
 * construction, including fields this contract has not been told about yet —
 * which is what makes it a rule about the schema's future rather than about
 * today's five field names.
 */
function onlyReprovedFieldsChanged(before: BlockTaskEntry, after: BlockTaskEntry): boolean {
  const projected = { ...before } as Record<string, unknown>;
  const source = after as unknown as Record<string, unknown>;
  for (const field of REPROVED_ON_MOVE) projected[field] = source[field];
  return isDeepStrictEqual(projected, after);
}

/**
 * `true` when `next` is `previous` with nothing but its stop reason replaced.
 *
 * ── Why this is structural and not a list of field names ───────────────────
 *
 * One structural question, asked by two rules that need opposite predecessors.
 *
 * It was written for the write in this module that is deliberately exempt from
 * the evidence proof: a run recording that it stopped while a task is still
 * unresolved (`previous.stopReason === null`). That exemption exists because no
 * evidence is available, so nothing downstream will examine what the write
 * carries — the single worst place in the contract for a check that is complete
 * only by somebody remembering to keep it complete.
 *
 * The stopped-run rule then wanted the same question for the opposite
 * predecessor (`previous.stopReason !== null`), and reuses this rather than
 * restating it. That write is *not* evidence-exempt; what the two share is only
 * the question, and asking it once is what keeps their two codes apart.
 *
 * It was first written as an exhaustive list of every field but `stopReason`,
 * and that list was complete. The problem is what happens *next*: add a field
 * to {@link BlockRunLedgerObjectSchema} and forget this line, and that field
 * becomes freely rewritable during a privileged write, with no test failing and
 * no reviewer prompted. A hand-maintained allowlist guarding an authority
 * exception fails **open**, which is the same defect class this whole slice
 * exists to close — only sited at the exception itself.
 *
 * So the question asked is the whole one: *is `next` the predecessor with only
 * its stop reason moved?* Construct that document and compare it structurally.
 * New top-level fields, new entry fields, entry order, added and removed
 * entries, and anything else the schema grows are all covered by construction,
 * because nothing here enumerates what to look at.
 *
 * What this does **not** decide is whether the new `stopReason` is *allowed*.
 * Each caller states the predecessor it requires, a stopped run may not be
 * relabelled at all (`STOP_REASON_RELABELLED`), and that a reason claims no
 * progress while a task is active is rule 5 of the contract above. Those keep
 * their own homes; this one asks only about the rest of the document.
 */
function onlyStopReasonChanged(previous: BlockRunLedger, next: BlockRunLedger): boolean {
  return isDeepStrictEqual({ ...previous, stopReason: next.stopReason }, next);
}

/**
 * Every way `next` fails to be a legal successor of `previous`.
 *
 * Every way it can still be asked about, rather than the first one found: a
 * caller refusing a write should be able to say what was wrong with it, and a
 * one-item answer invites a second attempt that fixes one thing.
 *
 * There is one deliberate exception, and it is a limit of the question rather
 * than of the effort. The per-entry rules are skipped when the frozen plan
 * changed, because they compare `previous.tasks[i]` with `next.tasks[i]` and
 * that pairing only means anything while both documents mirror the same frozen
 * membership. Reporting `DISPOSITION_REWOUND` for two entries that are not the
 * same task would be a *wrong* answer, which is worse than a short one — and
 * `FROZEN_PLAN_CHANGED` already refuses the write.
 *
 * Both arguments must already satisfy the ledger contract; this asks only about
 * the *relation* between two valid documents.
 */
export function assessLedgerSuccession(
  previous: BlockRunLedger,
  next: BlockRunLedger,
): readonly LedgerSuccessionViolation[] {
  const violations = new Set<LedgerSuccessionViolation>();

  // Identity: what this run *is*. Written once, at creation. The fields are
  // taken from `FIELD_AUTHORITY` rather than listed again here, so a field
  // classified as identity is enforced by having been classified.
  if (IDENTITY_FIELDS.some((field) => !isDeepStrictEqual(previous[field], next[field]))) {
    violations.add('RUN_IDENTITY_CHANGED');
  }

  // The frozen plan. The module header calls it written once and never edited;
  // until now nothing enforced that beyond the header.
  if (FROZEN_PLAN_FIELDS.some((field) => !isDeepStrictEqual(previous[field], next[field]))) {
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
      // A legal move is a licence to write what the move proves, and nothing
      // else. Without this, the one branch where an entry is *expected* to
      // change was the one branch where anything about it could.
      if (!onlyReprovedFieldsChanged(before, after)) {
        violations.add('MOVED_ENTRY_CARRIED_MORE');
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
  // above, and an ended run holding an unresolved `ACTIVE` task keeps it.
  //
  // What is frozen is everything else — asked structurally, and for the reason
  // spelled out over `onlyStopReasonChanged`. This once named the entries and
  // `activeTaskId`, which was complete for that day's schema and was the same
  // hand-maintained allowlist this module removed from its two other gates,
  // left standing at the strictest state in the contract: an unenumerated field
  // could be rewritten on a run whose history is supposed to be over.
  //
  // Reusing the predicate rather than restating it keeps the two codes apart.
  // A successor differing in nothing but the reason is not *progress*, so it is
  // not reported as progress — it is a relabelling, refused just above. What
  // remains after both rules is exact idempotence: the only successor a stopped
  // ledger has is the one identical to it.
  if (previous.stopReason !== null && !onlyStopReasonChanged(previous, next)) {
    violations.add('STOPPED_RUN_PROGRESSED');
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
