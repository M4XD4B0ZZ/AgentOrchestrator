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
 */

import { getStateKind } from '../core/states.js';
import { loadTaskState } from '../state/state-store.js';
import { fingerprintBlockDefinition, type BlockDefinition } from './block-definition.js';
import type { BlockRunLedger } from './block-ledger.js';

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
  /** An `ACTIVE` entry with no durable task state at all. */
  'ACTIVE_WITHOUT_TASK_STATE',
  /** A task record exists and cannot be read or validated. */
  'TASK_STATE_UNUSABLE',
  /**
   * A task finished while the ledger still says `PLANNED` or `ACTIVE`.
   *
   * Not a divergence: nothing false is claimed. Reported so a runner can decide
   * what to do about it, and deliberately not written here.
   */
  'TASK_AHEAD_OF_LEDGER',
  /** The block definition in the repository is no longer the frozen one. */
  'DEFINITION_DRIFTED',
] as const;

export type BlockReconciliationFinding = (typeof BLOCK_RECONCILIATION_FINDINGS)[number];

/** Findings that mean the ledger asserts something reality does not support. */
const DIVERGENT: ReadonlySet<BlockReconciliationFinding> = new Set([
  'SETTLED_WITHOUT_TERMINAL_STATE',
  'EVIDENCE_STALE',
  'BLOCKED_WITHOUT_BLOCKING_STATE',
  'ACTIVE_WITHOUT_TASK_STATE',
  'TASK_STATE_UNUSABLE',
  'DEFINITION_DRIFTED',
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
    const state = loadTaskState(options.repositoryRoot, entry.taskId);

    if (state.classification === 'STATE_MISSING') {
      // A task that was never started cannot support a claim about its outcome.
      if (entry.disposition === 'ACTIVE') {
        findings.push(record(entry.taskId, 'ACTIVE_WITHOUT_TASK_STATE'));
      } else if (entry.disposition === 'SETTLED') {
        findings.push(record(entry.taskId, 'SETTLED_WITHOUT_TERMINAL_STATE'));
      } else if (entry.disposition === 'BLOCKED') {
        findings.push(record(entry.taskId, 'BLOCKED_WITHOUT_BLOCKING_STATE'));
      }
      continue;
    }

    if (!state.ok) {
      findings.push(record(entry.taskId, 'TASK_STATE_UNUSABLE'));
      continue;
    }

    const taskState = state.state.state;

    switch (entry.disposition) {
      case 'SETTLED':
        // The claim, re-derived rather than trusted.
        if (taskState !== 'READY_FOR_PR') {
          findings.push(record(entry.taskId, 'SETTLED_WITHOUT_TERMINAL_STATE'));
        } else if (entry.evidenceRevision !== state.revision) {
          findings.push(record(entry.taskId, 'EVIDENCE_STALE'));
        }
        break;
      case 'BLOCKED':
        if (getStateKind(taskState) !== 'BLOCKING') {
          findings.push(record(entry.taskId, 'BLOCKED_WITHOUT_BLOCKING_STATE'));
        } else if (entry.evidenceRevision !== state.revision) {
          findings.push(record(entry.taskId, 'EVIDENCE_STALE'));
        }
        break;
      case 'ACTIVE':
      case 'PLANNED':
        // The benign direction: the task finished and the ledger has not caught
        // up. Reported, never written — see the module header.
        if (taskState === 'READY_FOR_PR') {
          findings.push(record(entry.taskId, 'TASK_AHEAD_OF_LEDGER'));
          progressAvailable = true;
        }
        break;
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
