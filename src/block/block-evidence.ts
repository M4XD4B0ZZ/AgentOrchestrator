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
import { EVIDENCE_BACKED } from './block-ledger.js';
import type { BlockTaskEntry, ReprovedEntryField } from './block-ledger.js';

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
 * What a single field's proof gets to look at.
 *
 * The record and its revision travel together because they are one reading of
 * one file: a prover that re-read the state would risk two answers inside one
 * proof, which is the divergence this module exists to detect rather than
 * create.
 */
export interface ReprovedFieldContext {
  readonly entry: BlockTaskEntry;
  /** The task's durable record, or `null` when it has none yet. */
  readonly record: TaskState | null;
  /** The revision of that record, or `null` when there is none. */
  readonly revision: string | null;
}

/**
 * Decides whether one field of `entry` is supported by the task record.
 *
 * `null` means supported. Anything else is the verdict that refuses the write,
 * and it is returned rather than thrown so a prover can never take the decision
 * away from {@link proveBlockTaskEntry}.
 */
export type ReprovedFieldProver = (context: ReprovedFieldContext) => EntryProofCode | null;

/**
 * A prover for every entry field the ledger classifies `REPROVED`.
 *
 * ── Why this is a registry and not four `if`s ──────────────────────────────
 *
 * `ENTRY_FIELD_AUTHORITY` forces a decision about any field added to
 * `BlockTaskEntrySchema`, and `REPROVED` is the decision that says "this field
 * may move during a legal disposition change, because something re-derives it
 * here". That was a promise with nothing behind it. A field could be declared,
 * classified `REPROVED`, and persisted with a forged value on an otherwise
 * honest settlement — because the proof was four field names written before
 * that field existed, and it simply never looked.
 *
 * `satisfies Record<ReprovedEntryField, ReprovedFieldProver>` makes the promise
 * keepable and the compiler its enforcer. The union comes from the ledger's own
 * map, so:
 *
 *   a new schema field            must be classified          (block-ledger.ts)
 *   classified `REPROVED`         must appear here            (this file)
 *   classified `PINNED`           is covered by construction  (the projection)
 *
 * and there is no fourth option. What the type cannot do is judge whether a
 * handler is any good — nothing can — so each one is separately held to
 * refusing a forged value against durable evidence in
 * `tests/v2-07-remediation.test.ts`. Completeness here, correctness there.
 *
 * Declaration order is precedence order: the first prover to refuse names the
 * verdict, and it reproduces the order these checks were written in, so the
 * code an operator sees for a given forgery does not change.
 */
const REPROVED_FIELD_PROVERS = {
  /**
   * The disposition is judged by the task contract's own vocabulary rather than
   * by a second definition kept here. `ABANDONED` names its state instead of
   * asking for a kind, because `READY_FOR_PR` is terminal too and settling and
   * abandoning must never be reachable from one record.
   *
   * `PLANNED` and `ACTIVE` claim nothing about the record's phase — the first
   * claims no record at all, the second only that the run is working on a task
   * that exists — so there is nothing here to re-derive for them.
   */
  disposition: ({ entry, record }) => {
    if (entry.disposition === 'PLANNED' || entry.disposition === 'ACTIVE') return null;
    if (record === null) return 'TASK_STATE_DOES_NOT_PROVE_IT';
    const proved =
      entry.disposition === 'SETTLED'
        ? record.state === 'READY_FOR_PR'
        : entry.disposition === 'BLOCKED'
          ? getStateKind(record.state) === 'BLOCKING'
          : record.state === 'ABORTED';
    return proved ? null : 'TASK_STATE_DOES_NOT_PROVE_IT';
  },

  /**
   * The evidence must still be the revision that proved it. This is what makes
   * a claim that *was* justified distinguishable from one that has since
   * stopped being true — and from one that was simply typed into the file.
   *
   * Only the evidence-backed dispositions carry it; rule 4 of the ledger
   * contract pins it to `null` for the rest, which is checked here too so the
   * field has one owner rather than two.
   */
  evidenceRevision: ({ entry, revision }) =>
    EVIDENCE_BACKED.has(entry.disposition)
      ? entry.evidenceRevision === revision
        ? null
        : 'EVIDENCE_NOT_CURRENT'
      : entry.evidenceRevision === null
        ? null
        : 'EVIDENCE_NOT_CURRENT',

  /**
   * A base pin is a claim that this run pinned the task to a tree. A `PLANNED`
   * entry has none to justify — recording which tree a task is built on needs a
   * task that was prepared — and every other disposition must match the record.
   */
  baseCommit: ({ entry, record }) => {
    if (entry.disposition === 'PLANNED') {
      return entry.baseCommit === null ? null : 'COMMIT_NOT_PROVEN_BY_STATE';
    }
    if (record === null) return 'COMMIT_NOT_PROVEN_BY_STATE';
    return entry.baseCommit === record.basePinnedCommit ? null : 'COMMIT_NOT_PROVEN_BY_STATE';
  },

  /**
   * Only a `SETTLED` entry may carry one, and it must be the commit the record
   * says the task ended at. Rule 4 pins it to `null` everywhere else, restated
   * here for the same reason as the evidence revision.
   */
  resultCommit: ({ entry, record }) => {
    if (entry.disposition !== 'SETTLED') {
      return entry.resultCommit === null ? null : 'COMMIT_NOT_PROVEN_BY_STATE';
    }
    if (record === null) return 'COMMIT_NOT_PROVEN_BY_STATE';
    return entry.resultCommit === record.currentCommit ? null : 'COMMIT_NOT_PROVEN_BY_STATE';
  },
} as const satisfies Record<ReprovedEntryField, ReprovedFieldProver>;

/**
 * The registry's keys are *exactly* the classified fields — neither fewer nor
 * more, and not merely "some strings".
 *
 * `satisfies Record<ReprovedEntryField, …>` says every classified field has a
 * handler. It does not say the constraint is still meaningful, and there are two
 * ordinary-looking edits that make it meaningless. Widening the declaration to
 * `Record<string, ReprovedFieldProver>` drops the obligation entirely; and if
 * `ENTRY_FIELD_AUTHORITY` loses its literal types over in `block-ledger.ts`,
 * `ReprovedEntryField` collapses to `never`, `Record<never, …>` becomes `{}`,
 * and this line accepts anything — including an empty registry.
 *
 * An exact key-set comparison refuses both, because either one moves one side
 * of it and not the other. The comparison is written with the invariant
 * `(<T>() => T extends A ? 1 : 2)` form rather than mutual `extends`, so a
 * widened side cannot pass by assignability.
 */
type ExactlyKeys<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : { readonly ERROR: 'REPROVED_FIELD_PROVERS no longer covers exactly the REPROVED fields' };

const _proversCoverExactlyTheClassifiedFields: ExactlyKeys<
  keyof typeof REPROVED_FIELD_PROVERS,
  ReprovedEntryField
> = true;
void _proversCoverExactlyTheClassifiedFields;

/** The verdict of the first prover that refuses, or `null` when all hold. */
function firstUnprovenField(context: ReprovedFieldContext): EntryProofCode | null {
  // Iterated rather than called one by one, so a prover added to the registry
  // cannot be forgotten by a runner that lists them again.
  for (const prove of Object.values(REPROVED_FIELD_PROVERS) as ReprovedFieldProver[]) {
    const code = prove(context);
    if (code !== null) return code;
  }
  return null;
}

/**
 * Reads `entry`'s task record and says whether it supports the entry.
 *
 * Read-only, synchronous, and never throws for an expected condition. The
 * per-field questions live in {@link REPROVED_FIELD_PROVERS}; what stays here
 * is the reading of the record and the two verdicts that are about the record
 * existing at all rather than about any one field.
 */
export function proveBlockTaskEntry(repositoryRoot: string, entry: BlockTaskEntry): EntryProof {
  const state = loadTaskState(repositoryRoot, entry.taskId);

  // A planned entry claims nothing about a record, so a missing state is not a
  // failure — it is the normal case, and the only one where the provers run
  // against no record at all.
  if (entry.disposition === 'PLANNED') {
    const record = state.ok ? state.state : null;
    const code = firstUnprovenField({
      entry,
      record,
      revision: state.ok ? state.revision : null,
    });
    return proof(code ?? 'PROVEN', record);
  }

  if (state.classification === 'STATE_MISSING') return proof('TASK_NOT_STARTED', null);
  if (!state.ok) return proof('TASK_STATE_UNUSABLE', null);

  const code = firstUnprovenField({
    entry,
    record: state.state,
    revision: state.revision,
  });
  return proof(code ?? 'PROVEN', state.state);
}

function proof(code: EntryProofCode, state: TaskState | null): EntryProof {
  return Object.freeze({ code, state });
}
