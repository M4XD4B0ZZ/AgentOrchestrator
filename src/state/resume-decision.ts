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
 * ── Two answers, because they are two questions ────────────────────────────
 *
 * {@link ResumeClassification} says *what the situation is* — including
 * `STATE_DIVERGED`, which corresponds to the existing `RESUME_STATE_DIVERGED`
 * task state rather than introducing a second vocabulary for the same
 * condition. {@link ContinuationAuthority} says *what may be done about it*,
 * and it is the only field that speaks to unattended execution.
 *
 * They are separate because the alternative has a failure mode: a single status
 * meaning "everything checks out" invites a future caller to read it as "carry
 * on", and the most common thing that checks out is an interrupted task with
 * half-written work in its worktree. There is deliberately no classification
 * whose name suggests a machine may continue on its own, and the one authority
 * that grants it is `evaluateAutomaticResume()` — fed here, never
 * re-implemented and never widened.
 *
 * ── This module decides; it does not act ───────────────────────────────────
 *
 * Nothing here writes state, transitions a task or touches a repository.
 * Performing the transition a classification implies belongs to the loop, in
 * V1-05.
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
import {
  reconcileTaskState,
  type ReconciliationReport,
  type RepositoryIdentity,
} from './reconcile.js';

export type { RepositoryIdentity };

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
  /** The repository just resolved — the identity the state must still match. */
  readonly repository: RepositoryIdentity;
  /** The task just selected. */
  readonly taskId: string;
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
  /**
   * A regular in-flight state whose record agrees with observed reality.
   *
   * This says the two *agree*. It says nothing about whether anything may be
   * continued, and deliberately does not read as though it does — see
   * {@link ContinuationAuthority}.
   */
  'RECONCILED_IN_FLIGHT',
] as const;

export type ResumeClassification = (typeof RESUME_CLASSIFICATIONS)[number];

/**
 * What kind of continuation, if any, this result permits.
 *
 * ── Why this is not the classification ─────────────────────────────────────
 *
 * A classification answers "what is the situation". Whether a machine may act
 * on it without a human is a different question with a different authority, and
 * collapsing the two is how an interrupted, half-written worktree ends up being
 * picked up unattended: a dirty `IMPLEMENTING` checkpoint *reconciles* — that is
 * exactly what the phase-sensitive checks are for — and reconciling is not
 * permission to run.
 *
 * So the permission is stated separately, in a closed vocabulary a caller can
 * branch on without interpreting an English word:
 *
 *  - `TERMINAL` — the task is over. There is nothing to continue.
 *  - `BLOCKED` — nothing may continue until something changes: the record and
 *    reality disagree, or the unattended-resume authority denied it.
 *  - `ATTENDED_ONLY` — a human may continue this. A machine may not do so on
 *    its own.
 *  - `AUTOMATIC_ALLOWED` — unattended execution is permitted.
 *
 * `AUTOMATIC_ALLOWED` has exactly one source: an `AutomaticResumeDecision` from
 * `evaluateAutomaticResume()` with `allowed === true`. It is not derivable from
 * a classification, from a `CONSISTENT` reconciliation, or from any combination
 * of the two — see {@link continuationFor}.
 */
export const CONTINUATION_AUTHORITIES = [
  'TERMINAL',
  'BLOCKED',
  'ATTENDED_ONLY',
  'AUTOMATIC_ALLOWED',
] as const;

export type ContinuationAuthority = (typeof CONTINUATION_AUTHORITIES)[number];

export interface ResumeDecision {
  readonly classification: ResumeClassification;
  /**
   * Whether, and how, this task may continue. The only field a caller should
   * consult before running anything unattended.
   */
  readonly continuation: ContinuationAuthority;
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
 * The single place a continuation authority is produced.
 *
 * `AUTOMATIC_ALLOWED` is read off the canonical decision object and nowhere
 * else, so no classification and no reconciliation verdict can produce it on
 * its own. Everything a machine may not do unattended lands in one of the other
 * three — including a perfectly reconciled in-flight task, which is
 * `ATTENDED_ONLY` precisely because "the record is accurate" and "carry on
 * without me" are different statements.
 */
function continuationFor(
  classification: ResumeClassification,
  automaticResume: AutomaticResumeDecision | null,
): ContinuationAuthority {
  if (automaticResume !== null && automaticResume.allowed) return 'AUTOMATIC_ALLOWED';
  switch (classification) {
    case 'TASK_COMPLETE':
    case 'TASK_ABORTED':
      return 'TERMINAL';
    case 'STATE_DIVERGED':
    case 'AUTOMATIC_RESUME_REFUSED':
      return 'BLOCKED';
    case 'HUMAN_DECISION_REQUIRED':
    case 'RECONCILED_IN_FLIGHT':
      return 'ATTENDED_ONLY';
    case 'AUTOMATIC_RESUME_ALLOWED':
      // Only reachable with an `allowed` decision in hand, which the guard
      // above already answered. Present so the switch stays exhaustive.
      return 'AUTOMATIC_ALLOWED';
  }
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
 *
 * Repository identity is passed through from the freshly resolved repository.
 * By the time this runs, reconciliation has already compared it against the
 * state and refused on any mismatch, so these two checks are defence in depth
 * rather than the primary guard — which is why identity is *not* something a
 * caller can quietly weaken by supplying the recorded value back.
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
    observedRepositoryId: context.repository.id,
    observedRepositoryRoot: context.repository.root,
    observedWorktreePath: observed.registeredWorktreePath,
    // `null` is "never established", which denies — the evidence contract takes
    // a boolean precisely so that an unasked question cannot pass for a yes.
    worktreeExists: observed.worktreeExists === true,
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
  const reconciliation = reconcileTaskState(state, observed, {
    repository: context.repository,
    taskId: context.taskId,
  });

  const decision = (
    classification: ResumeClassification,
    automaticResume: AutomaticResumeDecision | null,
    reasonCodes: readonly string[],
  ): ResumeDecision =>
    Object.freeze({
      classification,
      continuation: continuationFor(classification, automaticResume),
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

  // --- 3. A regular in-flight state is consistent, and that is all ---------
  // It is *not* cleared for unattended execution: an interrupted IMPLEMENTING
  // with uncommitted work reconciles exactly like a quiescent one, and only the
  // automatic-resume authority may say a machine can pick either of them up.
  if (!isBlockingState(state.state)) {
    return decision('RECONCILED_IN_FLIGHT', null, []);
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
