/**
 * The composed reconciliation entry point: load, observe, compare, answer.
 *
 * Everything this module does exists in the three modules beneath it. What it
 * adds is a *single closed outcome* a caller can branch on without re-deriving
 * it from a load code and a finding list. That matters because the derivation is
 * where the mistakes live: "no state" and "unreadable state" invite the same
 * `if (!loaded)`, and "this is the wrong repository" invites being folded into
 * the same bucket as "someone committed since we last looked". They are not the
 * same, and they do not deserve the same response.
 *
 * ── The outcomes, and why these ────────────────────────────────────────────
 *
 *  - `NO_PERSISTED_STATE` — a task that has never run. The normal starting
 *    point, and emphatically not an error.
 *  - `STATE_INVALID` — something is there and it is not usable as state. Needs
 *    an operator, and never a repair (see `state-store.ts`).
 *  - `STATE_REPOSITORY_MISMATCH` — the state is well-formed but describes a
 *    different repository than the one just resolved. Kept apart from ordinary
 *    divergence because it is not a repository that drifted; it is the wrong
 *    repository, and continuing would apply one project's work to another.
 *  - `STATE_TASK_MISMATCH` — the state is well-formed and about this
 *    repository, but about a different task. A separate outcome from the one
 *    above because the two have different causes and different repairs: a
 *    copied checkout versus two tasks of one project crossed over. Neither is
 *    `STATE_INVALID`, because in both cases the document itself is intact.
 *  - `STATE_DIVERGED` — the world contradicts the record.
 *  - `STATE_UNOBSERVABLE` — the world could not be read.
 *  - `RECONCILED` — the only outcome from which anything may continue.
 *
 * This module decides nothing about *resuming*; that is `resume-decision.ts`.
 * It performs no writes, and it repairs nothing.
 */

import type { TaskState } from '../core/task-state.js';
import type { GitRunner } from '../worktree/git-command.js';
import { observeRuntime, type ObservedRuntime, type RuntimeObservationOptions } from './observe-runtime.js';
import {
  reconcileTaskState,
  type ReconciliationExpectation,
  type ReconciliationReport,
} from './reconcile.js';
import {
  loadTaskState,
  type StateLoadFailureCode,
  type StateLoadResult,
} from './state-store.js';

export const RECONCILIATION_OUTCOMES = [
  'RECONCILED',
  'NO_PERSISTED_STATE',
  'STATE_INVALID',
  'STATE_REPOSITORY_MISMATCH',
  'STATE_TASK_MISMATCH',
  'STATE_DIVERGED',
  'STATE_UNOBSERVABLE',
] as const;

export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

export interface TaskReconciliation {
  readonly outcome: ReconciliationOutcome;
  /** The raw load result, for a caller that needs the precise code. */
  readonly load: StateLoadResult;
  /** The validated state, or `null` when none was loaded. */
  readonly state: TaskState | null;
  /** What was observed, or `null` when no state existed to observe against. */
  readonly observed: ObservedRuntime | null;
  /** The comparison, or `null` when it was never reached. */
  readonly report: ReconciliationReport | null;
  /** Stable codes explaining a non-`RECONCILED` outcome. Empty otherwise. */
  readonly reasonCodes: readonly string[];
}

/**
 * Findings that mean "this is the wrong repository" rather than "this
 * repository moved on". Either one makes the state unusable, but only these
 * mean the state was never about this repository in the first place.
 */
const REPOSITORY_FINDINGS: ReadonlySet<string> = new Set([
  'REPOSITORY_ID_MISMATCH',
  'REPOSITORY_ROOT_MISMATCH',
]);

/**
 * Loads the persisted state for `expectation`'s task and reconciles it against
 * current reality. Never throws, never writes.
 */
export async function reconcileTask(
  git: GitRunner,
  expectation: ReconciliationExpectation,
  options: RuntimeObservationOptions = {},
): Promise<TaskReconciliation> {
  const load = loadTaskState(expectation.repository.root, expectation.taskId);

  if (!load.ok) {
    return Object.freeze({
      outcome: outcomeForLoadFailure(load.code),
      load,
      state: null,
      observed: null,
      report: null,
      reasonCodes: load.code === 'NO_STATE' ? [] : Object.freeze([load.code]),
    });
  }

  const observed = await observeRuntime(git, load.state, options);
  const report = reconcileTaskState(load.state, observed, expectation);

  return Object.freeze({
    outcome: outcomeFor(report),
    load,
    state: load.state,
    observed,
    report,
    reasonCodes: report.findings,
  });
}

/**
 * A load that failed still has to answer with a precise outcome.
 *
 * A well-formed state belonging to somewhere else keeps its own outcome rather
 * than being flattened into `STATE_INVALID`: the document is not broken, and
 * telling an operator it is sends them looking for corruption instead of for
 * the copied checkout or the renamed task that actually happened.
 */
function outcomeForLoadFailure(code: StateLoadFailureCode): ReconciliationOutcome {
  switch (code) {
    case 'NO_STATE':
      return 'NO_PERSISTED_STATE';
    case 'REPOSITORY_ROOT_MISMATCH':
      return 'STATE_REPOSITORY_MISMATCH';
    case 'TASK_ID_MISMATCH':
      return 'STATE_TASK_MISMATCH';
    default:
      return 'STATE_INVALID';
  }
}

/**
 * A repository mismatch outranks every other finding: if this is not the right
 * repository, nothing else observed about it is worth reporting as the headline.
 * A task mismatch comes next, for the same reason and one level down.
 */
function outcomeFor(report: ReconciliationReport): ReconciliationOutcome {
  if (report.findings.some((code) => REPOSITORY_FINDINGS.has(code))) {
    return 'STATE_REPOSITORY_MISMATCH';
  }
  if (report.findings.includes('TASK_ID_MISMATCH')) {
    return 'STATE_TASK_MISMATCH';
  }
  switch (report.verdict) {
    case 'CONSISTENT':
      return 'RECONCILED';
    case 'DIVERGED':
      return 'STATE_DIVERGED';
    case 'UNOBSERVABLE':
      return 'STATE_UNOBSERVABLE';
  }
}
