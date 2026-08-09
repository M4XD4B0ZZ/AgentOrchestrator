/**
 * Comparing what was persisted against what was observed.
 *
 * Pure and side-effect free: it performs no I/O, spawns nothing, and reads no
 * clock. Everything it judges arrives as a {@link TaskState} that has already
 * passed the contract and an {@link ObservedRuntime} gathered by
 * `observe-runtime.ts`.
 *
 * ── Two ways to fail, kept apart ───────────────────────────────────────────
 *
 * `DIVERGED` means the world contradicts the record: Git no longer lists the
 * worktree, someone else's branch is checked out, HEAD moved, the base pin was
 * rewritten out of history, there is uncommitted work.
 *
 * `UNOBSERVABLE` means the world could not be read: the registry was
 * unavailable, the ancestry probe refused to evaluate, `git status` never
 * answered.
 *
 * Both refuse a resume, so collapsing them would not change any decision — and
 * that is exactly why they must stay apart. They are reported to a human, and
 * telling an operator "your base commit is no longer an ancestor" when the truth
 * is "Git could not be run" sends them to look at the wrong thing. A false
 * reason is worse than none.
 *
 * A refusal to answer never masquerades as an answer in the other direction
 * either: when the registry cannot be read, this module does **not** report the
 * worktree as unregistered. It does not know that.
 */

import { canonicalPathsEqual } from '../core/automatic-resume.js';
import type { TaskState } from '../core/task-state.js';
import { expectedWorkBranchRef, type ObservedRuntime } from './observe-runtime.js';

/**
 * The identity half of the reconciliation input.
 *
 * A `ResolvedRepository` is assignable to this. Reconciliation asks for the
 * three fields it actually compares rather than for the whole resolved value:
 * it has no use for the scope policy, the verification phases or the remote,
 * and a narrower input is one fewer thing a caller can get wrong.
 */
export interface RepositoryIdentity {
  readonly id: string;
  readonly root: string;
  readonly defaultBranch: string;
}

/**
 * What the orchestrator believes it is working on *now*: the repository it just
 * resolved and the task it just selected.
 *
 * A state file that parses cleanly proves only that something wrote valid JSON.
 * It does not prove the file describes this repository or this task, and a state
 * copied between checkouts parses exactly as well as one that belongs here.
 */
export interface ReconciliationExpectation {
  readonly repository: RepositoryIdentity;
  readonly taskId: string;
}

/** Findings that mean the world contradicts the record. */
export const DIVERGENCE_FINDING_CODES = [
  'REPOSITORY_ID_MISMATCH',
  'REPOSITORY_ROOT_MISMATCH',
  'TASK_ID_MISMATCH',
  'BASE_BRANCH_MISMATCH',
  'WORKTREE_NOT_REGISTERED',
  'WORKTREE_MISSING_ON_DISK',
  'WORK_BRANCH_NOT_CHECKED_OUT',
  'BASE_COMMIT_ABSENT',
  'BASE_COMMIT_NOT_ANCESTOR',
  'CURRENT_COMMIT_MOVED',
  'WORKTREE_DIRTY',
] as const;

/** Findings that mean the world could not be read. */
export const UNOBSERVABLE_FINDING_CODES = [
  'WORKTREE_REGISTRY_UNREADABLE',
  'BASE_COMMIT_UNVERIFIABLE',
  'CURRENT_COMMIT_UNKNOWN',
  'WORKTREE_CLEANLINESS_UNKNOWN',
] as const;

export type DivergenceFindingCode = (typeof DIVERGENCE_FINDING_CODES)[number];
export type UnobservableFindingCode = (typeof UNOBSERVABLE_FINDING_CODES)[number];
export type ReconciliationFindingCode = DivergenceFindingCode | UnobservableFindingCode;

const DIVERGENCE_SET: ReadonlySet<string> = new Set<string>(DIVERGENCE_FINDING_CODES);

/**
 * `CONSISTENT` is the only verdict that permits anything to continue.
 * See the module comment for why the two failures are not one.
 */
export type ReconciliationVerdict = 'CONSISTENT' | 'DIVERGED' | 'UNOBSERVABLE';

export interface ReconciliationReport {
  readonly verdict: ReconciliationVerdict;
  /** Every finding, in a fixed order so two runs report identically. */
  readonly findings: readonly ReconciliationFindingCode[];
}

/**
 * Compares a persisted state with observed reality.
 *
 * Deterministic: the same inputs always produce the same findings in the same
 * order, because the checks run in a fixed sequence and nothing here is derived
 * from a clock, a map iteration order or the filesystem.
 */
export function reconcileTaskState(
  state: TaskState,
  observed: ObservedRuntime,
  expected: ReconciliationExpectation,
): ReconciliationReport {
  const findings: ReconciliationFindingCode[] = [];

  // --- 0. Is this even the right repository and the right task? -----------
  // Checked first, and checked for *every* state rather than only on the
  // unattended-resume path: a state resumed into the wrong repository is the
  // one failure this whole slice exists to make impossible, and it must not
  // depend on which state the task happens to be in.
  if (state.repositoryId !== expected.repository.id) {
    findings.push('REPOSITORY_ID_MISMATCH');
  }
  // Compared as paths, not strings: separator shape, a trailing separator and
  // Windows' case-insensitivity all denote the same directory.
  if (!canonicalPathsEqual(state.repositoryRoot, expected.repository.root)) {
    findings.push('REPOSITORY_ROOT_MISMATCH');
  }
  // The file was found *by* task id, so a mismatch means its contents disagree
  // with its own location — a state copied between tasks, not a stale one.
  if (state.taskId !== expected.taskId) {
    findings.push('TASK_ID_MISMATCH');
  }
  // The base the work was branched from must still be the base the repository
  // declares; otherwise the pin below is measured against the wrong history.
  if (state.baseBranch !== expected.repository.defaultBranch) {
    findings.push('BASE_BRANCH_MISMATCH');
  }

  // --- 1. Does Git still know this worktree? ------------------------------
  if (!observed.registryReadable) {
    // Not knowing the registry is not evidence about the registration.
    findings.push('WORKTREE_REGISTRY_UNREADABLE');
  } else if (!observed.worktreeRegistered) {
    findings.push('WORKTREE_NOT_REGISTERED');
  } else if (observed.observedWorkBranchRef !== expectedWorkBranchRef(state)) {
    // Covers both a different branch and a detached HEAD (`null`): either way,
    // the work this state describes is not what is checked out there.
    findings.push('WORK_BRANCH_NOT_CHECKED_OUT');
  }

  // --- 2. Is it still on disk? --------------------------------------------
  if (!observed.worktreeExists) {
    findings.push('WORKTREE_MISSING_ON_DISK');
  }

  // --- 3. Is the base pin still in the history? ---------------------------
  // Skipped entirely when nothing has been pinned yet: a task that has not
  // reached WORKTREE_READY has no base commit to contradict.
  if (state.basePinnedCommit !== null) {
    if (observed.basePinnedCommitPresent === false) {
      findings.push('BASE_COMMIT_ABSENT');
    } else if (observed.basePinnedCommitIsAncestor === false) {
      findings.push('BASE_COMMIT_NOT_ANCESTOR');
    } else if (observed.basePinnedCommitIsAncestor === null) {
      findings.push('BASE_COMMIT_UNVERIFIABLE');
    }
  }

  // --- 4. Is HEAD where we left it? ---------------------------------------
  // Before the first commit exists the state carries no `currentCommit`, and
  // the worktree's HEAD is legitimately the base pin. Expect that instead of
  // treating a fresh, untouched worktree as divergence.
  const expectedHead = state.currentCommit ?? state.basePinnedCommit;
  if (expectedHead !== null) {
    if (observed.observedCurrentCommit === null) {
      findings.push('CURRENT_COMMIT_UNKNOWN');
    } else if (observed.observedCurrentCommit !== expectedHead) {
      findings.push('CURRENT_COMMIT_MOVED');
    }
  }

  // --- 5. Is there uncommitted work? --------------------------------------
  if (observed.worktreeClean === null) {
    findings.push('WORKTREE_CLEANLINESS_UNKNOWN');
  } else if (!observed.worktreeClean) {
    findings.push('WORKTREE_DIRTY');
  }

  return Object.freeze({
    verdict: verdictFor(findings),
    findings: Object.freeze([...findings]),
  });
}

/**
 * Divergence outranks unobservability when both are present: a concrete
 * contradiction is the more useful thing to put in front of an operator, and
 * both verdicts refuse a resume anyway.
 */
function verdictFor(findings: readonly ReconciliationFindingCode[]): ReconciliationVerdict {
  if (findings.length === 0) return 'CONSISTENT';
  return findings.some((code) => DIVERGENCE_SET.has(code)) ? 'DIVERGED' : 'UNOBSERVABLE';
}
