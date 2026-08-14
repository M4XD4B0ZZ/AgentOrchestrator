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
  PROGRESS_CLAIMING_STOP_REASONS,
  type BlockRunLedger,
  type BlockStopReason,
  type BlockTaskEntry,
} from './block-ledger.js';
import {
  createBlockLedger,
  updateBlockLedger,
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
  /**
   * The run already stopped, and a stopped run does not progress.
   *
   * Kept apart from `DISPOSITION_UNCHANGED`: the task's disposition is not what
   * refused this, the run's own ending is, and an operator reading the two
   * would go to different places.
   */
  'RUN_ALREADY_STOPPED',
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

/**
 * Persists `next` as the successor of the ledger that was read.
 *
 * The store is the authority, not this module: it re-proves every claim the
 * successor newly makes against the task records, so a state that moved between
 * this module's read and the write is caught there rather than raced past here.
 * Its refusal is translated back into this module's vocabulary — an unproven
 * claim is reported as exactly that, never rounded down to "not recorded".
 */
function commit(
  current: LedgerLoadSuccess,
  next: BlockRunLedger,
  options: BlockProgressOptions,
): BlockProgressResult {
  const save = updateBlockLedger(next, {
    repositoryRoot: options.repositoryRoot,
    expectedRevision: current.revision,
    ...(options.replace !== undefined ? { replace: options.replace } : {}),
    ...(options.tempSuffix !== undefined ? { tempSuffix: options.tempSuffix } : {}),
  });
  if (save.ok) return progress({ outcome: 'RECORDED', ledger: next, save });
  if (save.code === 'ENTRY_NOT_PROVEN') {
    return progress({ outcome: unprovenOutcome(save.detail), save });
  }
  return progress({ outcome: 'NOT_RECORDED', save });
}

/** The store's proof code, in this module's vocabulary. */
function unprovenOutcome(detail: string | null): BlockProgressOutcome {
  switch (detail) {
    case 'TASK_NOT_STARTED':
      return 'TASK_NOT_STARTED';
    case 'TASK_STATE_UNUSABLE':
      return 'TASK_STATE_UNUSABLE';
    default:
      // `TASK_STATE_DOES_NOT_PROVE_IT`, `EVIDENCE_NOT_CURRENT` and
      // `COMMIT_NOT_PROVEN_BY_STATE` are one answer to a caller: the record
      // does not support what was about to be written.
      return 'TASK_STATE_DOES_NOT_PROVE_IT';
  }
}

/** `true` when this run has already recorded why it is not continuing. */
function hasStopped(ledger: BlockRunLedger): boolean {
  return ledger.stopReason !== null;
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
    frozenDependencies: request.definition.dependencies.map((row) => ({
      taskId: row.taskId,
      dependsOn: [...row.dependsOn],
    })),
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

  return createBlockLedger(ledger, {
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
  if (hasStopped(ledger)) return progress({ outcome: 'RUN_ALREADY_STOPPED' });
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
  if (hasStopped(ledger)) return progress({ outcome: 'RUN_ALREADY_STOPPED' });
  const entry = entryFor(ledger, taskId);
  if (entry === null) return progress({ outcome: 'TASK_NOT_IN_RUN' });
  if (entry.disposition === 'SETTLED') return progress({ outcome: 'DISPOSITION_UNCHANGED' });
  // Nothing continues from a task that was given up on.
  if (entry.disposition === 'ABANDONED') return progress({ outcome: 'DISPOSITION_UNCHANGED' });

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
  if (hasStopped(ledger)) return progress({ outcome: 'RUN_ALREADY_STOPPED' });
  const entry = entryFor(ledger, taskId);
  if (entry === null) return progress({ outcome: 'TASK_NOT_IN_RUN' });
  if (entry.disposition === 'BLOCKED') return progress({ outcome: 'DISPOSITION_UNCHANGED' });
  // A finished or abandoned task has a past a later writer does not revise.
  if (entry.disposition === 'SETTLED' || entry.disposition === 'ABANDONED') {
    return progress({ outcome: 'DISPOSITION_UNCHANGED' });
  }

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

/* ─────────────────────────────── abandoning ─────────────────────────────── */

/**
 * Records that a task was given up on — if, and only if, its record says so.
 *
 * ── Why this move has to exist ─────────────────────────────────────────────
 *
 * `ABORTED` is terminal and not blocking: the task is over, deliberately and
 * irreversibly, and there is nothing for a human to resolve. Before this
 * function the ledger had no way to say that. An `ACTIVE` task whose record
 * reached `ABORTED` could not be settled (it did not finish), could not be
 * parked (it is not blocked), and while it stayed `ACTIVE` the run could not be
 * stopped — so the block was wedged, and the only remaining move was to falsify
 * one of its own records. A contract that leaves inventing progress as the only
 * escape is a contract that will eventually be escaped that way.
 *
 * ── Why it is not `BLOCKED` ────────────────────────────────────────────────
 *
 * Reusing `BLOCKED` would have been one line, and would have made "waiting for
 * a human" and "over" the same word. An operator triaging a stalled roadmap
 * needs those apart: one is a queue, the other is a decision that was already
 * taken. And `COMPLETE` requires every task `SETTLED`, so an abandoned task
 * correctly makes the block uncompletable rather than silently forgivable.
 *
 * Evidence-backed exactly as settlement and parking are: the task's own record
 * must be in `ABORTED`, and the revision that proved it is written into the
 * entry.
 */
export function abandonBlockTask(
  current: LedgerLoadSuccess,
  taskId: string,
  options: BlockProgressOptions,
): BlockProgressResult {
  const ledger = current.ledger;
  if (hasStopped(ledger)) return progress({ outcome: 'RUN_ALREADY_STOPPED' });
  const entry = entryFor(ledger, taskId);
  if (entry === null) return progress({ outcome: 'TASK_NOT_IN_RUN' });
  if (entry.disposition === 'ABANDONED' || entry.disposition === 'SETTLED') {
    return progress({ outcome: 'DISPOSITION_UNCHANGED' });
  }

  const state = loadTaskState(options.repositoryRoot, taskId);
  if (state.classification === 'STATE_MISSING') return progress({ outcome: 'TASK_NOT_STARTED' });
  if (!state.ok) return progress({ outcome: 'TASK_STATE_UNUSABLE' });

  // The one state that proves it, named rather than derived from a kind:
  // `READY_FOR_PR` is terminal too, and settling and abandoning must never be
  // reachable from the same record.
  if (state.state.state !== 'ABORTED') {
    return progress({ outcome: 'TASK_STATE_DOES_NOT_PROVE_IT' });
  }

  const next: BlockRunLedger = {
    ...ledger,
    activeTaskId: ledger.activeTaskId === taskId ? null : ledger.activeTaskId,
    tasks: withEntry(ledger, taskId, {
      ...entry,
      disposition: 'ABANDONED',
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
 * ── An active task, and the two kinds of ending ────────────────────────────
 *
 * A reason that claims the *tasks* did something — `COMPLETE`, `TASK_BLOCKED`,
 * `TASK_ABANDONED` — still requires the active task to be resolved first, with
 * its own evidence. Claiming any of the three over a task the run is still
 * holding would be this function inventing an outcome for a task it never
 * looked at. So it refuses, and the caller says what happened to the task.
 *
 * A reason that claims **no** progress does not require that, and must not.
 * This once refused every stop while a task was active, and the cost was the
 * wedge the ledger exists to make impossible: a task whose record has become
 * unreadable proves neither settlement nor blocking nor abandonment, so no call
 * could move it off `ACTIVE`, so no stop could be recorded, so a run could see
 * `STATE_UNUSABLE` and never say so. The remaining move was hand-editing the
 * ledger.
 *
 * Such a stop leaves the entry exactly as it found it. The record then reads:
 * the block stopped, and this task was still unresolved when it did — which is
 * what actually happened. `assessLedgerSuccession` holds that write to saying
 * only that, so the one ending that needs no evidence cannot carry any.
 *
 * ── Why it is written once ─────────────────────────────────────────────────
 *
 * A stop reason is history, not a label. `LEDGER_DIVERGED` is the most
 * expensive thing a run can record about itself — the ledger and the task
 * records disagreed, and the run must not continue — and overwriting it with
 * `OPERATOR_STOPPED` destroys the only durable trace that a divergence was ever
 * detected, leaving an operator reading a run that looks deliberately ended.
 * The store refuses the relabelling outright; this refuses it before writing,
 * so the caller gets an answer about the run rather than about a save.
 *
 * ── What `COMPLETE` costs here ─────────────────────────────────────────────
 *
 * Nothing, in this function — and that is the point. `COMPLETE` is a claim
 * about every task in the run, and the store proves it against every task's own
 * record before it lands. Checking it here against the ledger's entries, as
 * this once did, is asking the document that makes the claim whether the claim
 * is true.
 */
export function stopBlockRun(
  current: LedgerLoadSuccess,
  reason: BlockStopReason,
  options: BlockProgressOptions,
): BlockProgressResult {
  if (hasStopped(current.ledger)) {
    // Re-recording the same reason is not a relabelling, and is not progress
    // either. It changes nothing, and says so.
    return progress({ outcome: 'RUN_ALREADY_STOPPED' });
  }
  if (current.ledger.activeTaskId !== null && PROGRESS_CLAIMING_STOP_REASONS.has(reason)) {
    return progress({ outcome: 'ANOTHER_TASK_ACTIVE' });
  }
  const next: BlockRunLedger = { ...current.ledger, stopReason: reason };
  return commit(current, next, options);
}
