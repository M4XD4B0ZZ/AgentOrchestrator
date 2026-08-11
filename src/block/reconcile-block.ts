/**
 * Checking a ledger's claims against the records that would have to support
 * them — and believing the records.
 *
 * ── What this protects ─────────────────────────────────────────────────────
 *
 * A ledger is a file. A file can be hand-edited, half-written by a crash, or
 * restored from a backup taken at the wrong moment. The dangerous shape is
 * specific and worth naming:
 *
 *     ledger:  A = SETTLED,  B = ACTIVE
 *     reality: A never reached READY_FOR_PR
 *
 * If that is taken at face value, a corrupted ledger has unlocked B — and once
 * V2-09 makes B's base A's result, it will have unlocked a *dependency edge* on
 * work that does not exist. So the ledger's word is never sufficient: every
 * outcome claim is re-checked against the task state, and where they disagree
 * the verdict is `DIVERGED` and the run stops.
 *
 * ── This reports; it does not repair ───────────────────────────────────────
 *
 * Deliberately conservative for V2-07: **no automatic progress promotion.** The
 * opposite direction — a task that reached `READY_FOR_PR` while the ledger
 * still says `ACTIVE` — is a real and benign situation, and it is *reported*
 * (`TASK_AHEAD_OF_LEDGER`) rather than written. Which positive reconciliations
 * may safely be applied on their own is a decision V2-08 gets to make with a
 * runner in front of it; making it here, with nothing to test it against, would
 * be inventing the answer early.
 *
 * Nothing in this module writes. It is the observation half, exactly as
 * `observe-runtime.ts` is for a task.
 *
 * ── One definition of "supported" ──────────────────────────────────────────
 *
 * The per-entry check is `block-evidence.ts`, the same proof the store applies
 * before it writes anything. A reconciler with its own, weaker idea of what a
 * task record proves is a reconciler that certifies what the gate refused — and
 * the two did drift: `evidenceRevision` was re-derived here on every pass while
 * `baseCommit` and `resultCommit` were carried, so a hand-edited result commit
 * reconciled `CONSISTENT` for as long as anyone cared to look.
 *
 * ── Whose repository is this, asked first ──────────────────────────────────
 *
 * Before any record is read. `loadBlockLedger` holds both identities, but this
 * function takes a ledger *value* and a root, and a value did not have to come
 * through the store to get here — while every task record below is looked up
 * under that root. A ledger describing another project is not slightly wrong
 * here; it is asking about somebody else's tasks.
 */

import { comparePathIdentity } from '../core/path-identity.js';
import { readDeclaredRepositoryId } from '../repo/declared-identity.js';
import { fingerprintBlockDefinition, type BlockDefinition } from './block-definition.js';
import { proveBlockTaskEntry, type EntryProofCode } from './block-evidence.js';
import type { BlockRunLedger, TaskDisposition } from './block-ledger.js';

/** Everything a reconciliation can find. A closed set. */
export const BLOCK_RECONCILIATION_FINDINGS = [
  /**
   * A `SETTLED` entry whose task never reached `READY_FOR_PR`.
   *
   * The finding this module exists for: a ledger claiming completed work that
   * the task's own record does not support.
   */
  'SETTLED_WITHOUT_TERMINAL_STATE',
  /**
   * A `SETTLED` or `BLOCKED` entry whose task state has moved on since the
   * evidence was taken. The claim may still be true; it is no longer *proven*.
   */
  'EVIDENCE_STALE',
  /** A `BLOCKED` entry whose task is not in a blocking state. */
  'BLOCKED_WITHOUT_BLOCKING_STATE',
  /** An `ABANDONED` entry whose task record did not reach `ABORTED`. */
  'ABANDONED_WITHOUT_ABORTED_STATE',
  /** An `ACTIVE` entry with no durable task state at all. */
  'ACTIVE_WITHOUT_TASK_STATE',
  /** A task record exists and cannot be read or validated. */
  'TASK_STATE_UNUSABLE',
  /**
   * A `baseCommit` or `resultCommit` is not the one the task record proves.
   *
   * The finding this module was missing. `evidenceRevision` was re-checked on
   * every reconciliation and the commit fields never were, so a hand-edited
   * `resultCommit` — a perfectly-shaped object name belonging to no task and,
   * in the reproduced case, to nothing in the repository at all — survived
   * every later check and reconciled `CONSISTENT`. That field is exactly what
   * V2-09 intends to make a successor's base, so a forgery there is a forged
   * dependency edge rather than a cosmetic error.
   */
  'COMMIT_NOT_PROVEN_BY_STATE',
  /**
   * A task finished while the ledger still says `PLANNED` or `ACTIVE`.
   *
   * Not a divergence: nothing false is claimed. Reported so a runner can decide
   * what to do about it, and deliberately not written here.
   */
  'TASK_AHEAD_OF_LEDGER',
  /** The block definition in the repository is no longer the frozen one. */
  'DEFINITION_DRIFTED',
  /**
   * The ledger is being reconciled against a repository it does not describe.
   *
   * Either the recorded root is not this one, or the identity the profile
   * declares now is not the one the run was started under. Both make every task
   * record read below somebody else's, so it is a fact about the whole
   * reconciliation rather than about a task — and it is checked here as well as
   * on load, because this function takes a ledger value and a root, and a value
   * did not have to come through the store to get here.
   */
  'REPOSITORY_IDENTITY_DRIFTED',
] as const;

export type BlockReconciliationFinding = (typeof BLOCK_RECONCILIATION_FINDINGS)[number];

/** Findings that mean the ledger asserts something reality does not support. */
const DIVERGENT: ReadonlySet<BlockReconciliationFinding> = new Set([
  'SETTLED_WITHOUT_TERMINAL_STATE',
  'EVIDENCE_STALE',
  'BLOCKED_WITHOUT_BLOCKING_STATE',
  'ABANDONED_WITHOUT_ABORTED_STATE',
  'ACTIVE_WITHOUT_TASK_STATE',
  'TASK_STATE_UNUSABLE',
  'COMMIT_NOT_PROVEN_BY_STATE',
  'DEFINITION_DRIFTED',
  'REPOSITORY_IDENTITY_DRIFTED',
]);

export interface BlockReconciliationEntry {
  readonly taskId: string;
  readonly finding: BlockReconciliationFinding;
}

export interface BlockReconciliation {
  /**
   * `CONSISTENT` only when every claim is supported. `DIVERGED` means the run
   * must not continue on this ledger — never that the ledger should be
   * rewritten to match.
   */
  readonly verdict: 'CONSISTENT' | 'DIVERGED';
  readonly findings: readonly BlockReconciliationEntry[];
  /**
   * `true` when at least one task has finished ahead of the ledger.
   *
   * Reported separately from `verdict` because it is not a disagreement about
   * the past — it is progress the ledger has not caught up with, and only a
   * runner may decide whether to record it.
   */
  readonly progressAvailable: boolean;
}

export interface BlockReconciliationOptions {
  readonly repositoryRoot: string;
  /**
   * The block definition as the repository states it *now*.
   *
   * Optional: drift can only be checked against something, and a caller that
   * has not resolved the current definition is not asking that question. When
   * supplied, its fingerprint is compared with the frozen one and any
   * difference is reported — never adopted.
   */
  readonly definition?: BlockDefinition;
}

/**
 * Compares one ledger with the task records and the current definition.
 *
 * Read-only, and never throws for an expected condition.
 */
export function reconcileBlockRun(
  ledger: BlockRunLedger,
  options: BlockReconciliationOptions,
): BlockReconciliation {
  const findings: BlockReconciliationEntry[] = [];
  let progressAvailable = false;

  // Whose repository is this? Asked before anything is read from it, because
  // every answer below is a task record looked up under `repositoryRoot`, and
  // if the ledger is not this checkout's then none of those records is the one
  // it is talking about.
  const declared = readDeclaredRepositoryId(options.repositoryRoot);
  if (
    comparePathIdentity(ledger.repositoryRoot, options.repositoryRoot) !== 'EQUAL' ||
    !declared.ok ||
    declared.id !== ledger.repositoryId
  ) {
    findings.push(
      Object.freeze({ taskId: ledger.blockId, finding: 'REPOSITORY_IDENTITY_DRIFTED' as const }),
    );
  }

  if (
    options.definition !== undefined &&
    fingerprintBlockDefinition(options.definition) !== ledger.planFingerprint
  ) {
    // The membership this run was started against is not the one in front of
    // us. Reported against the block rather than a task, because it is a fact
    // about the plan.
    findings.push(Object.freeze({ taskId: ledger.blockId, finding: 'DEFINITION_DRIFTED' as const }));
  }

  for (const entry of ledger.tasks) {
    // The same proof the store applies before it writes anything, asked again
    // afterwards. One definition of "supported", used by the gate and by the
    // observer: a reconciler with its own, weaker idea of what a task record
    // proves is a reconciler that certifies what the gate refused.
    const { code, state } = proveBlockTaskEntry(options.repositoryRoot, entry);

    if (code !== 'PROVEN') {
      findings.push(record(entry.taskId, findingFor(code, entry.disposition)));
      continue;
    }

    // The benign direction: the task finished and the ledger has not caught up.
    // Nothing false is claimed, so it is reported and never written — see the
    // module header.
    if (
      (entry.disposition === 'PLANNED' || entry.disposition === 'ACTIVE') &&
      state?.state === 'READY_FOR_PR'
    ) {
      findings.push(record(entry.taskId, 'TASK_AHEAD_OF_LEDGER'));
      progressAvailable = true;
    }
  }

  const diverged = findings.some((entry) => DIVERGENT.has(entry.finding));

  return Object.freeze({
    verdict: diverged ? ('DIVERGED' as const) : ('CONSISTENT' as const),
    findings: Object.freeze(findings),
    progressAvailable,
  });
}

function record(taskId: string, finding: BlockReconciliationFinding): BlockReconciliationEntry {
  return Object.freeze({ taskId, finding });
}

/**
 * The finding a failed proof reads as, for the disposition that failed it.
 *
 * The proof answers *why* a claim is unsupported; a finding also says *which
 * claim*, because an operator reading `SETTLED_WITHOUT_TERMINAL_STATE` and one
 * reading `ACTIVE_WITHOUT_TASK_STATE` are looking at different problems.
 */
function findingFor(
  code: Exclude<EntryProofCode, 'PROVEN'>,
  disposition: TaskDisposition,
): BlockReconciliationFinding {
  if (code === 'TASK_STATE_UNUSABLE') return 'TASK_STATE_UNUSABLE';
  if (code === 'EVIDENCE_NOT_CURRENT') return 'EVIDENCE_STALE';
  if (code === 'COMMIT_NOT_PROVEN_BY_STATE') return 'COMMIT_NOT_PROVEN_BY_STATE';

  // `TASK_NOT_STARTED` and `TASK_STATE_DOES_NOT_PROVE_IT` are both "the record
  // does not support this disposition", and the disposition names which.
  switch (disposition) {
    case 'ACTIVE':
      return 'ACTIVE_WITHOUT_TASK_STATE';
    case 'SETTLED':
      return 'SETTLED_WITHOUT_TERMINAL_STATE';
    case 'BLOCKED':
      return 'BLOCKED_WITHOUT_BLOCKING_STATE';
    case 'ABANDONED':
      return 'ABANDONED_WITHOUT_ABORTED_STATE';
    case 'PLANNED':
      // A planned entry only fails a proof by carrying a base pin, which the
      // first two arms already answered. Kept exhaustive rather than defaulted.
      return 'COMMIT_NOT_PROVEN_BY_STATE';
  }
}
