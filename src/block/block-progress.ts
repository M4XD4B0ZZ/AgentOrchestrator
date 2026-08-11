/**
 * Moving a block run forward — never further than the task records allow.
 *
 * ── `SETTLED` is not a setter ──────────────────────────────────────────────
 *
 * Every function here that records an outcome for a task **reads that task's
 * durable state first** and refuses if the state does not prove the claim. That
 * is the whole point of the module: a ledger is orchestration truth, and the
 * one thing it must never be able to do is assert that a task finished when the
 * task's own record does not say so.
 *
 * The evidence is kept, not just consulted: the task state's revision is
 * written into the entry, so a later reconciliation can tell a claim that was
 * justified when it was made from one that has since stopped being true — and
 * from one that was simply typed into the file.
 *
 * ── One durable write per call ─────────────────────────────────────────────
 *
 * The same discipline `loop-step.ts` states for task states, for the same three
 * reasons: there is no half-applied progress, the compare-and-swap has exactly
 * one revision to thread, and a caller that dies between calls loses nothing
 * that was not already on disk.
 */

import { getStateKind } from '../core/states.js';
import { loadTaskState } from '../state/state-store.js';
import type { ReplaceFn, TempSuffixFn } from '../state/atomic-file.js';
import type { BlockDefinition } from './block-definition.js';
import { fingerprintBlockDefinition } from './block-definition.js';
import {
  BLOCK_LEDGER_SCHEMA_VERSION,
  entryFor,
  type BlockRunLedger,
  type BlockStopReason,
  type BlockTaskEntry,
} from './block-ledger.js';
import {
  saveBlockLedger,
  type LedgerLoadSuccess,
  type LedgerSaveResult,
} from './block-store.js';

/** Every way a progress call can end. A closed set. */
export const BLOCK_PROGRESS_OUTCOMES = [
  /** The move was made and one durable write landed. */
  'RECORDED',
  /** The task is not one this run froze. */
  'TASK_NOT_IN_RUN',
  /** The move is not legal from the task's current disposition. */
  'DISPOSITION_UNCHANGED',
  /** Another task is already active, and a run drives at most one. */
  'ANOTHER_TASK_ACTIVE',
  /**
   * The task's durable state does not prove the claim being recorded.
   *
   * The refusal this module exists for. Never rounded to a softer outcome, and
   * never resolved by writing the ledger anyway.
   */
  'TASK_STATE_DOES_NOT_PROVE_IT',
  /** No durable state exists for the task at all. */
  'TASK_NOT_STARTED',
  /** A state exists and cannot be used: broken, or somebody else's. */
  'TASK_STATE_UNUSABLE',
  /** Nothing was written; `save` says why. */
  'NOT_RECORDED',
] as const;

export type BlockProgressOutcome = (typeof BLOCK_PROGRESS_OUTCOMES)[number];

export interface BlockProgressResult {
  readonly outcome: BlockProgressOutcome;
  /** The ledger now on disk, or `null` when nothing was written. */
  readonly ledger: BlockRunLedger | null;
  readonly save: LedgerSaveResult | null;
}

export interface BlockProgressOptions {
  readonly repositoryRoot: string;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

function progress(
  from: Partial<BlockProgressResult> & { readonly outcome: BlockProgressOutcome },
): BlockProgressResult {
  return Object.freeze({ ledger: null, save: null, ...from });
}

/** Persists `next` as the successor of the ledger that was read. */
function commit(
  current: LedgerLoadSuccess,
  next: BlockRunLedger,
  options: BlockProgressOptions,
): BlockProgressResult {
  const save = saveBlockLedger(next, {
    repositoryRoot: options.repositoryRoot,
    expectedRevision: current.revision,
    ...(options.replace !== undefined ? { replace: options.replace } : {}),
    ...(options.tempSuffix !== undefined ? { tempSuffix: options.tempSuffix } : {}),
  });
  if (!save.ok) return progress({ outcome: 'NOT_RECORDED', save });
  return progress({ outcome: 'RECORDED', ledger: next, save });
}

/** The entries with `taskId`'s replaced. Order is preserved; it is identity. */
function withEntry(
  ledger: BlockRunLedger,
  taskId: string,
  replacement: BlockTaskEntry,
): BlockTaskEntry[] {
  return ledger.tasks.map((task) => (task.taskId === taskId ? replacement : task));
}

/* ──────────────────────────────── starting ──────────────────────────────── */

export interface StartBlockRunRequest {
  readonly definition: BlockDefinition;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  /** Identity of *this* run. A previous run's record is never overwritten. */
  readonly runId: string;
  /** ISO-8601, injected. Never read from a clock here. */
  readonly now: string;
}

/**
 * Writes the first ledger of a run: every task `PLANNED`, nothing active.
 *
 * The membership and the fingerprint are frozen here and never written again.
 * `expectedRevision` is omitted, which is the creation case — a run id that
 * already has a ledger is refused rather than overwritten.
 */
export function startBlockRun(
  request: StartBlockRunRequest,
  options: Omit<BlockProgressOptions, 'repositoryRoot'> = {},
): LedgerSaveResult {
  const ledger: BlockRunLedger = {
    schemaVersion: BLOCK_LEDGER_SCHEMA_VERSION,
    repositoryId: request.repositoryId,
    repositoryRoot: request.repositoryRoot,
    blockId: request.definition.blockId,
    runId: request.runId,
    startedAt: request.now,
    frozenTaskIds: [...request.definition.taskIds],
    planFingerprint: fingerprintBlockDefinition(request.definition),
    activeTaskId: null,
    tasks: request.definition.taskIds.map((taskId) => ({
      taskId,
      disposition: 'PLANNED' as const,
      evidenceRevision: null,
      baseCommit: null,
      resultCommit: null,
    })),
    stopReason: null,
  };

  return saveBlockLedger(ledger, {
    repositoryRoot: request.repositoryRoot,
    ...(options.replace !== undefined ? { replace: options.replace } : {}),
    ...(options.tempSuffix !== undefined ? { tempSuffix: options.tempSuffix } : {}),
  });
}

/* ─────────────────────────────── activating ─────────────────────────────── */

/**
 * Marks one planned task as the run's active one.
 *
 * Requires a durable task state to exist: a run cannot be "working on" a task
 * that has never been started, and recording that it is would be the first
 * invented fact. The state's own base pin is copied into the entry, so the
 * ledger records what the task is actually built on rather than what the run
 * assumed.
 */
export function activateBlockTask(
  current: LedgerLoadSuccess,
  taskId: string,
  options: BlockProgressOptions,
): BlockProgressResult {
  const ledger = current.ledger;
  const entry = entryFor(ledger, taskId);
  if (entry === null) return progress({ outcome: 'TASK_NOT_IN_RUN' });
  if (entry.disposition !== 'PLANNED') return progress({ outcome: 'DISPOSITION_UNCHANGED' });
  if (ledger.activeTaskId !== null) return progress({ outcome: 'ANOTHER_TASK_ACTIVE' });

  const state = loadTaskState(options.repositoryRoot, taskId);
  if (state.classification === 'STATE_MISSING') return progress({ outcome: 'TASK_NOT_STARTED' });
  if (!state.ok) return progress({ outcome: 'TASK_STATE_UNUSABLE' });

  const next: BlockRunLedger = {
    ...ledger,
    activeTaskId: taskId,
    tasks: withEntry(ledger, taskId, {
      ...entry,
      disposition: 'ACTIVE',
      baseCommit: state.state.basePinnedCommit,
    }),
  };
  return commit(current, next, options);
}

/* ──────────────────────────────── settling ──────────────────────────────── */

/**
 * Records that a task finished — if, and only if, its own record proves it.
 *
 * The proof is `READY_FOR_PR`, which the task-state contract already makes
 * expensive to reach: it is only reachable through a real `REVIEWING` pass, and
 * it additionally requires a resolved `currentCommit`, a clean checkpoint and no
 * outstanding block evidence. So this function needs no second definition of
 * "finished" — it reads the one the task contract already enforces.
 *
 * `resultCommit` records the commit that record proves the task ended at. That
 * is a fact about the task and **not** a claim that the commit is a suitable
 * base for a dependent successor: whether a settled task yields a usable chain
 * commit is V2-09's separate question, and nothing here answers it.
 */
export function settleBlockTask(
  current: LedgerLoadSuccess,
  taskId: string,
  options: BlockProgressOptions,
): BlockProgressResult {
  const ledger = current.ledger;
  const entry = entryFor(ledger, taskId);
  if (entry === null) return progress({ outcome: 'TASK_NOT_IN_RUN' });
  if (entry.disposition === 'SETTLED') return progress({ outcome: 'DISPOSITION_UNCHANGED' });

  const state = loadTaskState(options.repositoryRoot, taskId);
  if (state.classification === 'STATE_MISSING') return progress({ outcome: 'TASK_NOT_STARTED' });
  if (!state.ok) return progress({ outcome: 'TASK_STATE_UNUSABLE' });

  // The refusal this module exists for.
  if (state.state.state !== 'READY_FOR_PR') {
    return progress({ outcome: 'TASK_STATE_DOES_NOT_PROVE_IT' });
  }

  const next: BlockRunLedger = {
    ...ledger,
    activeTaskId: ledger.activeTaskId === taskId ? null : ledger.activeTaskId,
    tasks: withEntry(ledger, taskId, {
      ...entry,
      disposition: 'SETTLED',
      evidenceRevision: state.revision,
      baseCommit: state.state.basePinnedCommit,
      resultCommit: state.state.currentCommit,
    }),
  };
  return commit(current, next, options);
}

/* ──────────────────────────────── blocking ──────────────────────────────── */

/**
 * Records that a task stopped on something a human must resolve.
 *
 * Evidence-backed in the same way settlement is, and for the same reason: a
 * ledger that could declare a task blocked without its record saying so would
 * be able to stall a run on a fact nobody established.
 */
export function parkBlockTask(
  current: LedgerLoadSuccess,
  taskId: string,
  options: BlockProgressOptions,
): BlockProgressResult {
  const ledger = current.ledger;
  const entry = entryFor(ledger, taskId);
  if (entry === null) return progress({ outcome: 'TASK_NOT_IN_RUN' });
  if (entry.disposition === 'BLOCKED') return progress({ outcome: 'DISPOSITION_UNCHANGED' });

  const state = loadTaskState(options.repositoryRoot, taskId);
  if (state.classification === 'STATE_MISSING') return progress({ outcome: 'TASK_NOT_STARTED' });
  if (!state.ok) return progress({ outcome: 'TASK_STATE_UNUSABLE' });

  // Judged by the state contract's own classification, never by a list here.
  if (getStateKind(state.state.state) !== 'BLOCKING') {
    return progress({ outcome: 'TASK_STATE_DOES_NOT_PROVE_IT' });
  }

  const next: BlockRunLedger = {
    ...ledger,
    activeTaskId: ledger.activeTaskId === taskId ? null : ledger.activeTaskId,
    stopReason: 'TASK_BLOCKED',
    tasks: withEntry(ledger, taskId, {
      ...entry,
      disposition: 'BLOCKED',
      evidenceRevision: state.revision,
      baseCommit: state.state.basePinnedCommit,
    }),
  };
  return commit(current, next, options);
}

/* ──────────────────────────────── stopping ──────────────────────────────── */

/**
 * Records why the run is not continuing.
 *
 * A run may not simply stop being driven: an operator reading a ledger with no
 * active task and no reason cannot tell "finished" from "abandoned". `COMPLETE`
 * is checked by the contract against every entry, so it cannot be claimed over
 * unfinished work.
 *
 * An **active task must be resolved first** — settled, or parked with its own
 * evidence. Clearing `activeTaskId` here while an entry still said `ACTIVE`
 * would produce a document the contract refuses, and clearing the entry too
 * would be this function inventing an outcome for a task it never looked at.
 * So it refuses, and the caller says what happened to the task.
 */
export function stopBlockRun(
  current: LedgerLoadSuccess,
  reason: BlockStopReason,
  options: BlockProgressOptions,
): BlockProgressResult {
  if (current.ledger.activeTaskId !== null) return progress({ outcome: 'ANOTHER_TASK_ACTIVE' });
  const next: BlockRunLedger = { ...current.ledger, stopReason: reason };
  return commit(current, next, options);
}
