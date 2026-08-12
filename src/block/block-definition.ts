/**
 * What a block is *supposed* to work through — and nothing about what happened.
 *
 * ── Two words that must not become one ─────────────────────────────────────
 *
 *     BlockDefinition   what this block should work through
 *     BlockRunLedger    what durably happened in one started run of it
 *
 * V1-02 already holds this line once, between `TaskDefinition` (what a
 * repository wrote down) and `TaskState` (what the orchestrator did). Merging
 * them there would have produced a value that is simultaneously a plan and a
 * state, where a repository's markdown could assert a runtime fact. The same
 * mistake is available here one level up, and is refused the same way: nothing
 * in this module is written by the orchestrator, and nothing in the ledger is a
 * statement about what *ought* to happen.
 *
 * ── The fingerprint, and what it is for ────────────────────────────────────
 *
 * A run freezes its membership. Later the roadmap may be edited — a task added,
 * removed, reordered — and the question that must be answerable is not "what
 * does the roadmap say now" but "is the roadmap this run was started against
 * still the one in front of me". {@link fingerprintBlockDefinition} answers it
 * with a digest over the canonical identity only.
 *
 * It deliberately covers the block id and the ordered task ids and **nothing
 * else**. Not the task prose, not their status, not their titles: those change
 * constantly and legitimately during a run — a task's `status` becomes `DONE`
 * precisely *because* the run worked on it — and a fingerprint that moved with
 * them would report drift on every successful step. What must not change under
 * a running block is *which tasks it is, and in what order*.
 */

import { createHash } from 'node:crypto';

import { isValidTaskId } from '../plan/task-id.js';

/**
 * The grammar a block id must satisfy.
 *
 * Deliberately the canonical **task**-id grammar rather than a second one of
 * this module's own. The property needed is identical — one plain path segment,
 * no separators, no traversal, no device name, a bounded length — because a
 * block id becomes a file name in exactly the way a task id does. A second
 * grammar would be a second opinion about what is safe to write down, and the
 * two would drift. It is a *reuse of the rule*, not a claim that a block is a
 * task.
 */
export function isValidBlockId(value: string): boolean {
  return isValidTaskId(value);
}

/** Most tasks one block may declare. A bound, not a target. */
export const MAX_BLOCK_TASKS = 64;

/** Every way a definition can fail to be one. A closed set. */
export const BLOCK_DEFINITION_FAILURE_CODES = [
  'BLOCK_ID_INVALID',
  'BLOCK_EMPTY',
  'BLOCK_TOO_LARGE',
  'TASK_ID_INVALID',
  'TASK_REPEATED',
  'BLOCK_ID_COLLIDES_WITH_TASK',
] as const;

export type BlockDefinitionFailureCode = (typeof BLOCK_DEFINITION_FAILURE_CODES)[number];

/** One block of work, exactly as an operator asked for it. Frozen once made. */
export interface BlockDefinition {
  readonly blockId: string;
  /** Ordered, unique, every one a canonical task id. */
  readonly taskIds: readonly string[];
}

export interface BlockDefinitionSuccess {
  readonly ok: true;
  readonly definition: BlockDefinition;
}

export interface BlockDefinitionFailure {
  readonly ok: false;
  readonly code: BlockDefinitionFailureCode;
}

export type BlockDefinitionResult = BlockDefinitionSuccess | BlockDefinitionFailure;

function definitionFailure(code: BlockDefinitionFailureCode): BlockDefinitionFailure {
  return Object.freeze({ ok: false as const, code });
}

/**
 * Builds a definition, or says why the inputs are not one.
 *
 * Pure: no clock, no filesystem, no Git. Order is the caller's and is preserved
 * exactly — it is part of the identity a run freezes, so normalising it here
 * would silently change what a later drift check compares against.
 */
export function defineBlock(blockId: string, taskIds: readonly string[]): BlockDefinitionResult {
  if (!isValidBlockId(blockId)) return definitionFailure('BLOCK_ID_INVALID');
  if (taskIds.length === 0) return definitionFailure('BLOCK_EMPTY');
  if (taskIds.length > MAX_BLOCK_TASKS) return definitionFailure('BLOCK_TOO_LARGE');

  const seen = new Set<string>();
  for (const taskId of taskIds) {
    if (!isValidTaskId(taskId)) return definitionFailure('TASK_ID_INVALID');
    // A repeated task is not harmless noise: it would give one task two entries
    // in the ledger, and two dispositions that can disagree.
    if (seen.has(taskId)) return definitionFailure('TASK_REPEATED');
    // Nor is a block that is also one of its own tasks. The block-id grammar is
    // the task-id grammar on purpose — see `isValidBlockId` — so an id alone
    // never says which of the two it names. A reconciliation reports findings
    // about the block under the same field it reports findings about a task, and
    // where the two ids are equal a consumer keying on that field cannot tell
    // "this plan drifted" from "this task's record does not support it".
    if (taskId === blockId) return definitionFailure('BLOCK_ID_COLLIDES_WITH_TASK');
    seen.add(taskId);
  }

  return Object.freeze({
    ok: true as const,
    definition: Object.freeze({ blockId, taskIds: Object.freeze([...taskIds]) }),
  });
}

/**
 * The separator of the canonical encoding below.
 *
 * A byte that cannot occur inside a block id or a task id, so no two different
 * definitions can encode to one string.
 *
 * Written as an escape rather than as the byte itself. The value is identical
 * and every fingerprint ever computed is unchanged — but a raw NUL in a source
 * file is invisible in an editor, in a diff and in a review, and this one is
 * load-bearing: it is the whole reason two definitions cannot collide. A
 * separator nobody can see is a separator nobody can check.
 */
const CANONICAL_SEPARATOR = '\u0000';

/**
 * A digest of the identity a run is started against.
 *
 * Over the block id and the ordered task ids only — see the module header for
 * why the task *content* is deliberately excluded. Computed from a canonical
 * encoding rather than `JSON.stringify` of the object, so a change in field
 * order or in how the value was constructed cannot change the digest.
 */
export function fingerprintBlockDefinition(definition: BlockDefinition): string {
  const canonical = [definition.blockId, ...definition.taskIds].join(CANONICAL_SEPARATOR);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The fingerprint a ledger's own frozen membership must carry.
 *
 * The same digest as {@link fingerprintBlockDefinition}, reached from the two
 * fields a ledger stores rather than from a {@link BlockDefinition} object. It
 * exists so that `planFingerprint` can be *re-derived* from the document that
 * carries it rather than believed: a stored digest of a plan the document does
 * not list would make every later drift answer a comparison against a lie.
 */
export function fingerprintFrozenMembership(
  blockId: string,
  taskIds: readonly string[],
): string {
  return fingerprintBlockDefinition({ blockId, taskIds });
}
