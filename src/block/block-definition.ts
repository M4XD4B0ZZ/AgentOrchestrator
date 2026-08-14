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

import { compareTaskIds, isValidTaskId } from '../plan/task-id.js';

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
  /**
   * A member has no dependency row.
   *
   * Five codes rather than one `DEPENDENCIES_INVALID`, for the reason this
   * repository has recorded twice already: a refusal that misdescribes itself
   * sends an operator to the wrong fix. "You forgot a row", "you sent a row for
   * a task that is not in this block" and "your row points at a stranger" are
   * three different mistakes.
   */
  'DEPENDENCY_ROW_MISSING',
  /** A row names a task this block does not hold. */
  'DEPENDENCY_ROW_UNKNOWN',
  /** Two rows claim one member, so the relation has two answers for it. */
  'DEPENDENCY_ROW_REPEATED',
  /** A dependency names a task this block does not hold. */
  'DEPENDENCY_UNKNOWN',
  /** A row lists its own task. */
  'DEPENDENCY_SELF',
] as const;

export type BlockDefinitionFailureCode = (typeof BLOCK_DEFINITION_FAILURE_CODES)[number];

/**
 * What one member of a block waits for, **restricted to members of that block**.
 *
 * `dependsOn` is the *transitive* projection — the set of block members this
 * task depends on through any path, member or not — computed once at freeze
 * time by `block-dependencies.ts`. A direct intra-block edge check is not sound:
 * a block is an arbitrary subset of a repository-wide DAG, so `A ← X ← B` with
 * `X` outside the block has no intra-block edge and B still depends on A.
 *
 * The relation is frozen rather than derived live, and the *evidence* is frozen
 * rather than a `independent: true` judgement, so that what a run's continuation
 * decision rests on is inspectable and cannot move under it.
 */
export type FrozenTaskDependency = {
  readonly taskId: string;
  readonly dependsOn: readonly string[];
};

/** One block of work, exactly as an operator asked for it. Frozen once made. */
export interface BlockDefinition {
  readonly blockId: string;
  /** Ordered, unique, every one a canonical task id. */
  readonly taskIds: readonly string[];
  /**
   * Exactly one row per member, in {@link taskIds} order.
   *
   * Row order carries no information of its own — it is a function of
   * `taskIds` — so two spellings of one relation cannot produce two
   * fingerprints.
   */
  readonly dependencies: readonly FrozenTaskDependency[];
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
export function defineBlock(
  blockId: string,
  taskIds: readonly string[],
  dependencies: readonly FrozenTaskDependency[],
): BlockDefinitionResult {
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

  // The relation, canonicalised rather than believed. There is no default and
  // no optional argument: a caller that omitted the relation would be asserting
  // that every member is independent, which is precisely the claim this slice
  // exists to make provable rather than assumable.
  const rows = new Map<string, readonly string[]>();
  for (const row of dependencies) {
    if (!seen.has(row.taskId)) return definitionFailure('DEPENDENCY_ROW_UNKNOWN');
    if (rows.has(row.taskId)) return definitionFailure('DEPENDENCY_ROW_REPEATED');
    const deduplicated = new Set<string>();
    for (const dependency of row.dependsOn) {
      if (dependency === row.taskId) return definitionFailure('DEPENDENCY_SELF');
      if (!seen.has(dependency)) return definitionFailure('DEPENDENCY_UNKNOWN');
      deduplicated.add(dependency);
    }
    rows.set(row.taskId, Object.freeze([...deduplicated].sort(compareTaskIds)));
  }
  for (const taskId of taskIds) {
    if (!rows.has(taskId)) return definitionFailure('DEPENDENCY_ROW_MISSING');
  }

  return Object.freeze({
    ok: true as const,
    definition: Object.freeze({
      blockId,
      taskIds: Object.freeze([...taskIds]),
      dependencies: Object.freeze(
        taskIds.map((taskId) =>
          Object.freeze({ taskId, dependsOn: rows.get(taskId) as readonly string[] }),
        ),
      ),
    }),
  });
}

/**
 * The separators of the canonical encoding below.
 *
 * Three bytes that cannot occur inside a block id or a task id, so no two
 * different plans can encode to one string. Written as escapes rather than as
 * the bytes themselves: the value is identical, and a raw control character is
 * invisible in an editor, in a diff and in a review — while these are
 * load-bearing, because they are the whole reason two plans cannot collide.
 *
 * Three, not one. With a single separator the plan `{A: [B], B: []}` and the
 * plan `{A: [], B: [A]}` encode to permutations of the same token list, and a
 * digest that could not tell those apart would be a frozen relation that is not
 * frozen at all.
 */
const CANONICAL_SEPARATOR = '\u0000';
const DEPENDENCY_ROW_SEPARATOR = '\u0001';
const CANONICAL_SECTION_SEPARATOR = '\u0002';

/**
 * A digest of the identity a run is started against.
 *
 * Over the block id, the ordered task ids **and the frozen dependency
 * relation** — see the module header for why the task *content* is deliberately
 * excluded. The relation is included because a run's continuation decision
 * rests on it: a plan that could gain or lose an edge without moving the
 * fingerprint would be a plan whose authority a mid-run roadmap edit could
 * change.
 *
 * Computed from a canonical encoding rather than `JSON.stringify` of the
 * object, so a change in field order or in how the value was constructed cannot
 * change the digest.
 */
export function fingerprintBlockDefinition(definition: BlockDefinition): string {
  return fingerprintFrozenMembership(
    definition.blockId,
    definition.taskIds,
    definition.dependencies,
  );
}

/**
 * The fingerprint a ledger's own frozen plan must carry.
 *
 * The same digest as {@link fingerprintBlockDefinition}, reached from the three
 * fields a ledger stores rather than from a {@link BlockDefinition} object. It
 * exists so that `planFingerprint` can be *re-derived* from the document that
 * carries it rather than believed: a stored digest of a plan the document does
 * not list would make every later drift answer a comparison against a lie.
 */
export function fingerprintFrozenMembership(
  blockId: string,
  taskIds: readonly string[],
  dependencies: readonly FrozenTaskDependency[],
): string {
  const membership = [blockId, ...taskIds].join(CANONICAL_SEPARATOR);
  const relation = dependencies
    .map((row) => [row.taskId, ...row.dependsOn].join(CANONICAL_SEPARATOR))
    .join(DEPENDENCY_ROW_SEPARATOR);
  return createHash('sha256')
    .update(`${membership}${CANONICAL_SECTION_SEPARATOR}${relation}`, 'utf8')
    .digest('hex');
}
