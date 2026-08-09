/**
 * The single, deterministic answer to "may this task continue, and how?"
 *
 * Everything upstream produces facts; this module produces the one decision
 * that is made from them, in a fixed order, with no clock of its own and no I/O.
 * Given the same state, the same observation and the same context it always
 * returns the same classification and the same reason codes.
 *
 * ── The order is the policy ────────────────────────────────────────────────
 *
 *  1. **Terminal first.** A finished or abandoned task is not a resume
 *     question. Asking Git whether a `READY_FOR_PR` task's worktree still
 *     matches would invite "your completed task diverged", which is noise about
 *     something nobody is going to continue.
 *  2. **Reconciliation before eligibility.** Whether the quota reset has passed
 *     is irrelevant if the worktree is gone. Judging the block first would
 *     produce "resume allowed" for a task whose repository no longer matches,
 *     and the reconciliation result would then have to override it — a decision
 *     made twice is a decision that can disagree with itself.
 *  3. **Then, and only then, the block.** `evaluateAutomaticResume()` in
 *     `core/automatic-resume.ts` is the authority here, unchanged and unwrapped.
 *     This module feeds it observed evidence; it does not re-implement any of
 *     its checks.
 *
 * ── This module decides; it does not act ───────────────────────────────────
 *
 * Nothing here writes state, transitions a task or touches a repository.
 * {@link ResumeClassification} names what a caller should do — including
 * `STATE_DIVERGED`, which corresponds to the existing `RESUME_STATE_DIVERGED`
 * task state rather than introducing a second vocabulary for the same
 * condition. Performing that transition belongs to the loop, in V1-05.
 */

import {
  evaluateAutomaticResume,
  type AutomaticResumeDecision,
  type AutomaticResumeEvidence,
} from '../core/automatic-resume.js';
import { isAutomaticResumeEligible } from '../core/resume-policy.js';
import { isTerminalState } from '../core/states.js';
import type { TaskState } from '../core/task-state.js';
import { isBlockingState } from '../core/states.js';
import type { ObservedRuntime } from './observe-runtime.js';
import { reconcileTaskState, type ReconciliationReport } from './reconcile.js';

/**
 * The facts this decision needs that are not Git's to give.
 *
 * Repository identity is re-established by V1-01's `resolveRepository()` and
 * auth by the auth preflight; both are executions, and this module performs
 * none. They arrive as evidence so that a caller cannot accidentally get a
 * "resume allowed" without having actually re-proven them.
 */
export interface ResumeContext {
  /** The current instant, supplied rather than read, so the decision is pure. */
  readonly now: string | Date;
  /** Did a *fresh* auth preflight pass for the blocked agent? */
  readonly authPreflightPassed: boolean;
  /** Repository identity observed right now, from a fresh resolution. */
  readonly observedRepositoryId: string | null;
  /** Canonical repository root observed right now. */
  readonly observedRepositoryRoot: string | null;
}

export const RESUME_CLASSIFICATIONS = [
  /** `READY_FOR_PR`: finished. Nothing to resume. */
  'TASK_COMPLETE',
  /** `ABORTED`: given up on, irreversibly. */
  'TASK_ABORTED',
  /** Persisted state and observed reality disagree, or reality is unreadable. */
  'STATE_DIVERGED',
  /** Blocking, and only an operator may continue it. */
  'HUMAN_DECISION_REQUIRED',
  /** Blocking, eligible, and every check produced positive evidence. */
  'AUTOMATIC_RESUME_ALLOWED',
  /** Blocking and eligible, but at least one check denied it. */
  'AUTOMATIC_RESUME_REFUSED',
  /** A regular in-flight state that reconciles cleanly. Continue the loop. */
  'RESUME_READY',
] as const;

export type ResumeClassification = (typeof RESUME_CLASSIFICATIONS)[number];

export interface ResumeDecision {
  readonly classification: ResumeClassification;
  /** The comparison this decision rests on. Always present. */
  readonly reconciliation: ReconciliationReport;
  /** The unattended-resume verdict, or `null` when it was never reached. */
  readonly automaticResume: AutomaticResumeDecision | null;
  /**
   * Why, in stable codes: reconciliation findings when the state diverged,
   * automatic-resume reason codes when the block was judged, empty otherwise.
   */
  readonly reasonCodes: readonly string[];
}

/**
 * Translates observed reality into the evidence `evaluateAutomaticResume()`
 * expects.
 *
 * Two mappings are worth stating, because both could be fudged into a false
 * positive:
 *
 *  - the *observed* worktree path is the one **Git printed**, not the one the
 *    state recorded. Feeding the recorded path back in would make the path
 *    check compare a value with itself and always pass.
 *  - the observed base pin is only reported as matching when the ancestry probe
 *    positively confirmed it. Anything less — rewritten, absent, unevaluable —
 *    is `null`, which denies.
 */
function toEvidence(
  state: TaskState,
  observed: ObservedRuntime,
  context: ResumeContext,
  reconciliation: ReconciliationReport,
): AutomaticResumeEvidence {
  return Object.freeze({
    now: context.now,
    authPreflightPassed: context.authPreflightPassed,
    observedRepositoryId: context.observedRepositoryId,
    observedRepositoryRoot: context.observedRepositoryRoot,
    observedWorktreePath: observed.registeredWorktreePath,
    worktreeExists: observed.worktreeExists,
    observedBasePinnedCommit:
      observed.basePinnedCommitIsAncestor === true ? state.basePinnedCommit : null,
    observedCurrentCommit: observed.observedCurrentCommit,
    worktreeClean: observed.worktreeClean === true,
    divergenceDetected: reconciliation.verdict !== 'CONSISTENT',
  });
}

/**
 * Classifies whether and how a persisted task may continue. Total: every
 * combination of inputs yields exactly one classification.
 */
export function classifyResume(
  state: TaskState,
  observed: ObservedRuntime,
  context: ResumeContext,
): ResumeDecision {
  const reconciliation = reconcileTaskState(state, observed);

  const decision = (
    classification: ResumeClassification,
    automaticResume: AutomaticResumeDecision | null,
    reasonCodes: readonly string[],
  ): ResumeDecision =>
    Object.freeze({
      classification,
      reconciliation,
      automaticResume,
      reasonCodes: Object.freeze([...reasonCodes]),
    });

  // --- 1. Terminal states are not resume questions ------------------------
  if (isTerminalState(state.state)) {
    return decision(state.state === 'READY_FOR_PR' ? 'TASK_COMPLETE' : 'TASK_ABORTED', null, []);
  }

  // --- 2. The record must match the world ---------------------------------
  if (reconciliation.verdict !== 'CONSISTENT') {
    return decision('STATE_DIVERGED', null, reconciliation.findings);
  }

  // --- 3. A regular in-flight state simply continues -----------------------
  if (!isBlockingState(state.state)) {
    return decision('RESUME_READY', null, []);
  }

  // --- 4. Blocking: is an unattended resume even considered? ---------------
  if (!isAutomaticResumeEligible(state.state)) {
    return decision('HUMAN_DECISION_REQUIRED', null, []);
  }

  const automaticResume = evaluateAutomaticResume(
    state,
    toEvidence(state, observed, context, reconciliation),
  );

  return decision(
    automaticResume.allowed ? 'AUTOMATIC_RESUME_ALLOWED' : 'AUTOMATIC_RESUME_REFUSED',
    automaticResume,
    automaticResume.reasonCodes,
  );
}
