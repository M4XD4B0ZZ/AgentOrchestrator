/**
 * Whether a ledger entry is supported by the task record it claims to describe.
 *
 * ── One proof, in one place ────────────────────────────────────────────────
 *
 * V2-07 had this proof twice over, in two different strengths. `block-progress`
 * read the task state before recording an outcome — correctly — while the store
 * beneath it accepted any schema-valid document, so a caller that skipped the
 * progress API skipped the proof with it. And `stopBlockRun` checked `COMPLETE`
 * against the ledger's *own entries*, which is asking the liar whether it lied:
 * a hand-forged file with every entry set to `SETTLED` was recorded as a
 * finished block, and only an optional later reconciliation would ever notice.
 *
 * So the proof lives here, once, and the store applies it on every write. The
 * rule it exists to hold is a single sentence:
 *
 * > No mutating block call may persist progress that a later reconciler would
 * > be the first to call false.
 *
 * A reconciliation that runs afterwards is a safety net, not a substitute for
 * the check. Nobody is obliged to run it, nothing stops a run continuing before
 * it does, and by the time it speaks the false claim is already durable.
 *
 * ── Evidence is a task's own, and only its own ─────────────────────────────
 *
 * Every check below reads the state of *the entry's own* `taskId`. That one
 * task's record can never justify another's is therefore true by construction
 * rather than by the incidental fact that state files happen to be named after
 * tasks — and `tests/v2-07-remediation.test.ts` pins it directly rather than
 * leaving it to that coincidence.
 *
 * ── Commit fields are re-derived, not carried ──────────────────────────────
 *
 * `baseCommit` and `resultCommit` are checked against the task record on every
 * proof, not just at the moment they are written. A hand-edited `resultCommit`
 * is a forged base for the chain V2-09 intends to build on it, and a field that
 * is only ever validated once is a field an editor can change afterwards for
 * free. The task state is the authority for both: `basePinnedCommit` is what
 * the workspace pinned, `currentCommit` is what the task actually ended at.
 *
 * Read "on every proof" exactly: `baseCommit` is checked for every disposition,
 * `resultCommit` only for `SETTLED` — because rule 4 of the ledger contract
 * already pins it to `null` everywhere else, and a field the schema will not
 * let carry a value needs no second gate. `evidenceRevision` divides the same
 * way, checked for the three dispositions permitted to carry it. The two
 * mechanisms are complementary and `ENTRY_FIELD_AUTHORITY` names both.
 *
 * Nothing here asks Git whether a commit exists. It does not need to: a commit
 * that equals the task record's is as proven as that record, and one that does
 * not is already refused. Whether a settled task's result is *fit to be a
 * successor's base* is a different question, and V2-09's to answer.
 */

import { getStateKind } from '../core/states.js';
import type { TaskState } from '../core/task-state.js';
import { loadTaskState } from '../state/state-store.js';
import type { BlockTaskEntry } from './block-ledger.js';

/** Every verdict a single entry's proof can reach. A closed set. */
export const ENTRY_PROOF_CODES = [
  /** The task record supports everything this entry claims. */
  'PROVEN',
  /** No durable state exists for the task at all. */
  'TASK_NOT_STARTED',
  /** A state exists and cannot be used: broken, or somebody else's. */
  'TASK_STATE_UNUSABLE',
  /** The state exists and does not prove the claimed disposition. */
  'TASK_STATE_DOES_NOT_PROVE_IT',
  /**
   * The claim may still be true; it is no longer *proven*. The task state has
   * moved on since the revision recorded as evidence.
   */
  'EVIDENCE_NOT_CURRENT',
  /** A commit field does not match what the task record says it should be. */
  'COMMIT_NOT_PROVEN_BY_STATE',
] as const;

export type EntryProofCode = (typeof ENTRY_PROOF_CODES)[number];

export interface EntryProof {
  readonly code: EntryProofCode;
  /**
   * The record the proof was taken from, when there was one to read.
   *
   * Handed back so a caller that has more to ask of the same task — the
   * reconciler wants to know whether it has run *ahead* of the ledger — can ask
   * it without reading the file a second time and risking two answers.
   */
  readonly state: TaskState | null;
}

/**
 * Reads `entry`'s task record and says whether it supports the entry.
 *
 * Read-only, synchronous, and never throws for an expected condition.
 */
export function proveBlockTaskEntry(repositoryRoot: string, entry: BlockTaskEntry): EntryProof {
  // A planned entry claims nothing about a record, so a missing state is not a
  // failure — it is the normal case. What it must not carry is a base pin:
  // recording which tree a task is built on needs a task that was prepared.
  if (entry.disposition === 'PLANNED') {
    const state = loadTaskState(repositoryRoot, entry.taskId);
    const record = state.ok ? state.state : null;
    if (entry.baseCommit !== null) return proof('COMMIT_NOT_PROVEN_BY_STATE', record);
    return proof('PROVEN', record);
  }

  const state = loadTaskState(repositoryRoot, entry.taskId);
  if (state.classification === 'STATE_MISSING') return proof('TASK_NOT_STARTED', null);
  if (!state.ok) return proof('TASK_STATE_UNUSABLE', null);

  const record = state.state;

  if (entry.disposition === 'ACTIVE') {
    // An active entry claims only that the run is working on a task that
    // exists, plus the tree that task was pinned to.
    return entry.baseCommit === record.basePinnedCommit
      ? proof('PROVEN', record)
      : proof('COMMIT_NOT_PROVEN_BY_STATE', record);
  }

  // The three outcome dispositions, each judged by the task contract's own
  // vocabulary rather than by a second definition kept here. `ABANDONED` names
  // its state rather than asking for a kind, because `READY_FOR_PR` is terminal
  // too and settling and abandoning must never be reachable from one record.
  const proved =
    entry.disposition === 'SETTLED'
      ? record.state === 'READY_FOR_PR'
      : entry.disposition === 'BLOCKED'
        ? getStateKind(record.state) === 'BLOCKING'
        : record.state === 'ABORTED';
  if (!proved) return proof('TASK_STATE_DOES_NOT_PROVE_IT', record);

  // The evidence must still be the revision that proved it. This is what makes
  // a claim that *was* justified distinguishable from one that has since
  // stopped being true — and from one that was simply typed into the file.
  if (entry.evidenceRevision !== state.revision) return proof('EVIDENCE_NOT_CURRENT', record);

  if (entry.baseCommit !== record.basePinnedCommit) {
    return proof('COMMIT_NOT_PROVEN_BY_STATE', record);
  }
  if (entry.disposition === 'SETTLED' && entry.resultCommit !== record.currentCommit) {
    return proof('COMMIT_NOT_PROVEN_BY_STATE', record);
  }

  return proof('PROVEN', record);
}

function proof(code: EntryProofCode, state: TaskState | null): EntryProof {
  return Object.freeze({ code, state });
}
