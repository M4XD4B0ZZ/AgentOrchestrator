/**
 * The operator's own repair of a failed verification, adopted without a writer.
 *
 * ── The defect this exists for, measured ───────────────────────────────────
 *
 * `healthapp/CAPTURE-004`, 2026-09-12. Verification failed on subject commit
 * `71ec85f`, and the failure was mechanical: `prettier -c` on one file. An
 * operator could prove the repair in seconds and apply it. This build then had
 * nowhere to put it.
 *
 *  - **Commit the repair, then resume.** HEAD no longer matches
 *    `attempt.subjectCommit`, so the stored failure is evidence about a tree
 *    that no longer exists and `resumedBrief` correctly refuses to reuse it
 *    (`loop-step.ts`). Refusing was right; there was simply nothing else.
 *  - **Leave the repair uncommitted and resume.** The only door out of
 *    `BLOCKED_VERIFY` was `--remediate-verify-failure`, which starts a *writing
 *    agent*. That writer has no shell, could not run the formatter, did not
 *    recognise a diff that was already correct, searched `node_modules` for the
 *    formatter's source, spent its budget, and returned
 *    `HUMAN_DECISION_REQUIRED`. A repaired tree was thereby parked by the one
 *    mechanism meant to unpark it.
 *
 * What was missing is not a fix for either of those: both behaved as designed.
 * It is the edge neither of them is — *the operator has repaired this exact
 * failed tree; adopt the repair and verify again, with no agent involved.*
 *
 * ── What this module is, and what it deliberately is not ───────────────────
 *
 * Two halves, split so the decision can be tested without the effect.
 * {@link assessOperatorRepair} observes and classifies and writes
 * nothing. {@link verifyOperatorRepair} performs the one effect — staging and
 * committing the operator's diff under AO's own commit controls — and performs
 * it only against an assessment that already said yes.
 *
 * It is **agent-free** by construction: nothing here imports a runner, builds a
 * payload, or has a seam that could carry one. The three optional seams it does
 * take — {@link OperatorRepairAssessmentInput.loadAttempts}, `observeClean` and
 * `assessScope` — are a store read and two observations, none of which can
 * start a process, and production passes none of them. That is the property
 * the whole grant exists for, so it is structural rather than promised.
 *
 * What follows the adoption is the ordinary loop, in full. This module starts
 * no agent; the invocation that calls it goes on to re-verify and, if that
 * passes, to review — which does. See the flag's own help text, which says so.
 *
 * It grants **no review round**, touches `reviewRound`, `grantedReviewRounds`
 * and `findingHistory` not at all, and produces no `resumeFrom`. The task
 * re-enters `VERIFYING`, which is where a tree whose contents just changed
 * belongs, and the ordinary lifecycle takes it from there.
 *
 * ── Why the predicates are what they are ───────────────────────────────────
 *
 * Every one of them answers "is this operator talking about the tree I think
 * they are". The dangerous version of this feature is the one that adopts *some
 * other* change — a half-finished edit, a rebase, another task's work — and
 * calls it a repair of a failure it never saw. So:
 *
 *  - the state is exactly `BLOCKED_VERIFY`, the only state whose block a
 *    verification failure produces;
 *  - the resume point still names `REMEDIATE`, which is the one phase that
 *    state declares. A record naming anything else has been edited, and an
 *    operator decision does not get to pick which phase it enters;
 *  - a verification attempt history exists and can be read as this task's;
 *  - its **latest** attempt is the subject. Not any historical failure: a task
 *    that failed, was remediated, and failed again has two records, and
 *    adopting against the older one would re-verify a tree whose evidence has
 *    already been superseded;
 *  - that latest attempt is a `FAILED`, not an `UNAVAILABLE`. `UNAVAILABLE`
 *    means the commands could not be run at all — a missing toolchain, an empty
 *    profile — which is not a thing a diff in the worktree repairs;
 *  - HEAD is still **exactly** that attempt's `subjectCommit`. This is the
 *    conjunct that makes the whole grant honest: it is what proves the operator
 *    repaired *the tree that failed*, and not a later one;
 *  - the worktree actually carries a repair. An adoption of nothing would
 *    commit nothing and re-verify an unchanged tree, which is a way to spend a
 *    verification run to learn what is already recorded;
 *  - the whole delta from the task's base pin is `WITHIN_SCOPE`. The operator
 *    is trusted to decide, not to be exempt from the boundary the task declared
 *    — and the approved path set the gate produces is handed to the commit
 *    rather than re-derived there, for the reason `assess-scope.ts` gives.
 *
 * Identity, the execution lease, the authorised worktree and reconciliation are
 * **not** re-checked here. They are proven by `run-driver.ts` before any of
 * this is reached, and a second copy of a gate is a gate that can disagree with
 * the first.
 */

import { assessTaskScope } from '../scope/assess-scope.js';
import { commitTaskWork } from '../worktree/commit-task-work.js';
import type { GitRunner } from '../worktree/git-command.js';
import { observeWorktreeCleanliness } from '../worktree/worktree-cleanliness.js';
import type { TaskState } from '../core/task-state.js';
import {
  latestVerificationAttempt,
  loadVerificationAttempts,
} from './verification-attempt-store.js';
import type { VerificationAttemptLoad } from './verification-attempt-store.js';
import type { VerificationAttemptRecord } from './verification-attempt.js';

/**
 * Why an adoption was refused. A closed vocabulary, one member per proven
 * condition, so a refusal names its own cause rather than a category.
 */
export const OPERATOR_REPAIR_REFUSALS = [
  /** The task is not blocked on a verification failure. */
  'STATE_NOT_BLOCKED_VERIFY',
  /** The record's resume point names a phase this state does not declare. */
  'RESUME_POINT_NOT_REMEDIATE',
  /** No attempt history for this task, or none readable as this task's. */
  'NO_VERIFICATION_ATTEMPT',
  /** The latest attempt is `UNAVAILABLE`: the commands never ran. */
  'LATEST_ATTEMPT_NOT_FAILED',
  /** Git would not say what HEAD is, so nothing can be compared to it. */
  'HEAD_UNREADABLE',
  /** HEAD is not the commit the recorded failure is about. */
  'HEAD_MOVED',
  /** Git would not say whether the worktree is clean. */
  'WORKTREE_UNREADABLE',
  /** The worktree carries no repair to adopt. */
  'NOTHING_TO_ADOPT',
  /** The repair reaches outside the paths this task declared. */
  'REPAIR_OUT_OF_SCOPE',
  /** The scope gate could not reach a verdict, which is never permission. */
  'SCOPE_INDETERMINATE',
] as const;

export type OperatorRepairRefusal = (typeof OPERATOR_REPAIR_REFUSALS)[number];

/** Permission, carrying exactly what the effect needs and nothing it could re-derive. */
export interface OperatorRepairAllowed {
  readonly allowed: true;
  /** The failed attempt this repair is about. Its `subjectCommit` is the current HEAD. */
  readonly attempt: VerificationAttemptRecord;
  /**
   * The path set the scope gate approved, handed on rather than re-derived.
   *
   * `commitTaskWork` compares it against what the commit actually contains, and
   * a set derived at the commit would be measured after whatever it is meant to
   * catch and would agree with itself.
   */
  readonly approvedPaths: readonly string[];
}

export interface OperatorRepairRefused {
  readonly allowed: false;
  readonly refusal: OperatorRepairRefusal;
}

export type OperatorRepairAssessment = OperatorRepairAllowed | OperatorRepairRefused;

export interface OperatorRepairAssessmentInput {
  /** The task's durable state, as the driver loaded it. */
  readonly state: TaskState;
  /** The Git seam. Raw evidence, never a verdict. */
  readonly git: GitRunner;
  /** The path Git printed for this task's registration, proven by the driver. */
  readonly authorisedWorktreePath: string;
  /** Seam for the attempt store, so the decision is testable without a filesystem. */
  readonly loadAttempts?: (
    repositoryRoot: string,
    taskId: string,
  ) => VerificationAttemptLoad;
  /**
   * Seams for the two observations, injected for the same reason the store is:
   * so that each predicate can be measured on its own rather than through a
   * repository fixture that has to be manoeuvred into the shape under test.
   *
   * Both default to the production observers. A caller that supplies neither
   * gets exactly the behaviour this module has in the driver.
   */
  readonly observeClean?: (
    git: GitRunner,
    worktreePath: string,
  ) => Promise<boolean | null>;
  readonly assessScope?: typeof assessTaskScope;
}

function refuse(refusal: OperatorRepairRefusal): OperatorRepairRefused {
  return Object.freeze({ allowed: false as const, refusal });
}

/**
 * Whether this operator repair may be adopted. Observes; writes nothing.
 *
 * The order is deliberate: the cheap record reads come first and the two Git
 * observations last, so a refusal that can be decided from durable state alone
 * never spends a subprocess. It is also the order a reader needs — "is this
 * even the right kind of task" before "is this the right tree".
 */
export async function assessOperatorRepair(
  input: OperatorRepairAssessmentInput,
): Promise<OperatorRepairAssessment> {
  const state = input.state;

  if (state.state !== 'BLOCKED_VERIFY') return refuse('STATE_NOT_BLOCKED_VERIFY');
  if (state.resumeFrom === null || state.resumeFrom.phase !== 'REMEDIATE') {
    return refuse('RESUME_POINT_NOT_REMEDIATE');
  }

  const load = (input.loadAttempts ?? loadVerificationAttempts)(
    state.repositoryRoot,
    state.taskId,
  );
  const attempt = latestVerificationAttempt(load);
  if (attempt === null) return refuse('NO_VERIFICATION_ATTEMPT');
  if (attempt.verdict !== 'FAILED') return refuse('LATEST_ATTEMPT_NOT_FAILED');

  const head = await input.git(input.authorisedWorktreePath, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    'HEAD',
  ]);
  if (head.outcome !== 'OK' || head.stdout === '') return refuse('HEAD_UNREADABLE');
  if (head.stdout !== attempt.subjectCommit) return refuse('HEAD_MOVED');

  // `null` is "not established" and is treated as a denial, the same reading
  // every other caller of this observer takes.
  const observe = input.observeClean ?? observeWorktreeCleanliness;
  const clean = await observe(input.git, input.authorisedWorktreePath);
  if (clean === null) return refuse('WORKTREE_UNREADABLE');
  if (clean) return refuse('NOTHING_TO_ADOPT');

  const scope = await (input.assessScope ?? assessTaskScope)({
    git: input.git,
    authorisedWorktreePath: input.authorisedWorktreePath,
    basePinnedCommit: state.basePinnedCommit,
    scopeAuthorityCommit: state.scopeAuthorityCommit,
  });
  if (scope.verdict === 'VIOLATION') return refuse('REPAIR_OUT_OF_SCOPE');
  if (scope.verdict !== 'WITHIN_SCOPE') return refuse('SCOPE_INDETERMINATE');

  return Object.freeze({
    allowed: true as const,
    attempt,
    approvedPaths: scope.approvedPaths,
  });
}

/** How an adoption ended. Closed, and never a message. */
export const OPERATOR_REPAIR_COMMIT_OUTCOMES = [
  'ADOPTED',
  /** The commit was refused because an argument was not shell-inert. */
  'REFUSED_UNSAFE_ARGUMENT',
  /** The repository configures a filter that would execute a program. */
  'REFUSED_EXECUTABLE_DRIVER',
  /**
   * The commit contains a path the scope gate did not approve.
   *
   * `commitTaskWork` keeps that commit rather than unwinding it — the evidence
   * is the point — so this is reported as *not adopted* and the task stays
   * `BLOCKED_VERIFY`. A caller must not read it as a success: the tree moved,
   * but not within the boundary the operator was permitted to move it in, and
   * that is a human's problem rather than a fresh verification's.
   */
  'COMMITTED_BEYOND_APPROVED_SCOPE',
  /** Git did not answer. */
  'GIT_UNAVAILABLE',
  /**
   * Nothing was recorded although the assessment saw a dirty tree.
   *
   * Reachable when everything dirty is ignored — `add --all` stages none of it.
   * Its own outcome rather than a success with no commit, because a caller that
   * read this as adopted would move a task to `VERIFYING` over an unchanged
   * tree and re-learn the failure it already had.
   */
  'NOTHING_RECORDED',
] as const;

export type OperatorRepairCommitOutcome = (typeof OPERATOR_REPAIR_COMMIT_OUTCOMES)[number];

export interface OperatorRepairCommitted {
  readonly outcome: 'ADOPTED';
  /** The commit the repair now sits on. The subject the fresh verification will run against. */
  readonly commit: string;
}

export interface OperatorRepairNotCommitted {
  readonly outcome: Exclude<OperatorRepairCommitOutcome, 'ADOPTED'>;
}

export type OperatorRepairCommitResult = OperatorRepairCommitted | OperatorRepairNotCommitted;

/**
 * The commit phase label. **Not** `IMPLEMENT` or `REMEDIATE`.
 *
 * `commitTaskWork` writes `AO:<task>:<phase>:r<round>`, and both of its phases
 * mean "a writing agent produced this". No agent produced this, so a message in
 * that vocabulary would be the one thing this whole grant is not allowed to do:
 * claim a writer ran. The prefix is different from the first character so that
 * `git log --oneline` separates the two without being read closely.
 */
export const OPERATOR_REPAIR_COMMIT_PHASE = 'OPERATOR-REPAIR' as const;

/**
 * Stages and commits the operator's repair.
 *
 * Takes the assessment rather than re-deriving it, so the permission and the
 * effect cannot disagree about which tree, which paths or which failure. There
 * is no argument by which a caller could ask this to commit something the gate
 * did not approve.
 */
export async function commitOperatorRepair(
  git: GitRunner,
  worktreePath: string,
  state: TaskState,
  allowed: OperatorRepairAllowed,
): Promise<OperatorRepairCommitResult> {
  const committed = await commitTaskWork(git, worktreePath, {
    taskId: state.taskId,
    phase: OPERATOR_REPAIR_COMMIT_PHASE,
    // The round the BLOCK ITSELF recorded, read off the resume point the
    // assessment has already proved names `REMEDIATE`.
    //
    // It was `state.reviewRound + 1`, under a comment claiming it did not
    // invent a counter — which it did. `loop-step.ts` writes every sibling
    // artefact with `currentRound(state) = min(max(1, reviewRound), budget)`:
    // the IMPLEMENT commit, the REMEDIATE commit, and this very block's resume
    // point. At `reviewRound: 1` the two disagree, so the operator repair went
    // into permanent history as `r2` while every other artefact for that task
    // said `r1` — and at the budget ceiling it named a round above the declared
    // budget, which is exactly what that clamp exists to prevent.
    //
    // Reading the resume point rather than re-deriving the formula is the
    // narrower fix and the truer one: it is the round the failed attempt
    // belongs to, written by the step that recorded the failure.
    round: state.resumeFrom?.round ?? 1,
    approvedPaths: allowed.approvedPaths,
    basePinnedCommit: state.basePinnedCommit ?? '',
  });

  switch (committed.outcome) {
    case 'COMMITTED':
      return Object.freeze({ outcome: 'ADOPTED' as const, commit: committed.commit });
    case 'NOTHING_TO_COMMIT':
      return Object.freeze({ outcome: 'NOTHING_RECORDED' as const });
    case 'COMMITTED_BEYOND_APPROVED_SCOPE':
      return Object.freeze({ outcome: 'COMMITTED_BEYOND_APPROVED_SCOPE' as const });
    case 'REFUSED_UNSAFE_ARGUMENT':
      return Object.freeze({ outcome: 'REFUSED_UNSAFE_ARGUMENT' as const });
    case 'TARGET_CONFIG_EXECUTES_CODE':
      return Object.freeze({ outcome: 'REFUSED_EXECUTABLE_DRIVER' as const });
    default:
      return Object.freeze({ outcome: 'GIT_UNAVAILABLE' as const });
  }
}
