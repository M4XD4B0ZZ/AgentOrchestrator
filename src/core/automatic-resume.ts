/**
 * Whether an unattended resume may actually happen (AO-005).
 *
 * The blocking-state policy only says whether a state is *eligible* for an
 * unattended resume. Eligibility is a property of the state name; permission is
 * a property of the world right now. A statically true
 * "automaticResumeAllowed" flag proves nothing about the quota having reset,
 * the credentials still being good, or the worktree still being the one that
 * was interrupted — so it must never be the basis for acting on its own.
 *
 * This module is a **pure decision function**:
 *  - no filesystem access, no Git invocation, no clock read, no child process;
 *  - every fact it needs is passed in as {@link AutomaticResumeEvidence};
 *  - it returns a structured verdict, never a bare boolean.
 *
 * It is fail-closed in the strongest sense: `allowed` is true only when every
 * required check produced positive evidence. Missing evidence is a denial, not
 * a neutral value.
 *
 * There is deliberately still **no resume runner**. Gathering the evidence
 * (running `git status`, re-running the auth preflight, canonicalising paths)
 * belongs to the loop that does not exist yet.
 */

import { absolutePathsEqual } from './path-identity.js';
import type { TaskState } from './task-state.js';
import { BLOCKED_STATE_POLICIES } from './resume-policy.js';
import { isBlockingState } from './states.js';

/**
 * Facts about the world that an unattended resume depends on.
 *
 * Every field is required. There is no optional evidence: an absent fact is
 * expressed as `null` / `false` and denies the resume, rather than being
 * silently treated as "fine".
 */
export interface AutomaticResumeEvidence {
  /** The current instant, as an ISO-8601 string or a `Date`. */
  readonly now: string | Date;
  /** Did a *fresh* auth preflight pass for the blocked agent? */
  readonly authPreflightPassed: boolean;
  /** Repository identity observed right now. */
  readonly observedRepositoryId: string | null;
  /** Canonicalised repository root observed right now. */
  readonly observedRepositoryRoot: string | null;
  /** Canonicalised worktree path observed right now. */
  readonly observedWorktreePath: string | null;
  /** Does that worktree path exist on disk? */
  readonly worktreeExists: boolean;
  /** Base commit the worktree is actually pinned to right now. */
  readonly observedBasePinnedCommit: string | null;
  /** Head commit of the work branch right now. */
  readonly observedCurrentCommit: string | null;
  /** Is the worktree free of uncommitted changes right now? */
  readonly worktreeClean: boolean;
  /** Did any divergence check report a mismatch? */
  readonly divergenceDetected: boolean;
}

export type AutomaticResumeReasonCode =
  | 'STATE_NOT_BLOCKING'
  | 'STATE_NOT_ELIGIBLE_FOR_UNATTENDED_RESUME'
  | 'RESUME_POINT_MISSING'
  | 'RESET_TIME_MISSING'
  | 'RESET_TIME_UNPARSEABLE'
  | 'RESET_TIME_NOT_REACHED'
  | 'CURRENT_TIME_UNPARSEABLE'
  | 'AUTH_PREFLIGHT_NOT_PASSED'
  | 'REPOSITORY_ID_MISMATCH'
  | 'REPOSITORY_ROOT_MISMATCH'
  | 'WORKTREE_PATH_MISMATCH'
  | 'WORKTREE_MISSING'
  | 'BASE_COMMIT_MISMATCH'
  | 'CURRENT_COMMIT_MISMATCH'
  | 'WORKTREE_NOT_CLEAN'
  | 'DIVERGENCE_DETECTED';

/** Human-readable name of the check behind each reason code. */
const CHECK_NAMES: Readonly<Record<AutomaticResumeReasonCode, string>> = Object.freeze({
  STATE_NOT_BLOCKING: 'state is a blocking state',
  STATE_NOT_ELIGIBLE_FOR_UNATTENDED_RESUME: 'state is eligible for an unattended resume',
  RESUME_POINT_MISSING: 'state records where to continue',
  RESET_TIME_MISSING: 'state records a reported quota reset time',
  RESET_TIME_UNPARSEABLE: 'reported quota reset time is a valid timestamp',
  RESET_TIME_NOT_REACHED: 'reported quota reset time has passed',
  CURRENT_TIME_UNPARSEABLE: 'current time is a valid timestamp',
  AUTH_PREFLIGHT_NOT_PASSED: 'auth preflight passed again',
  REPOSITORY_ID_MISMATCH: 'repository id is unchanged',
  REPOSITORY_ROOT_MISMATCH: 'canonical repository root is unchanged',
  WORKTREE_PATH_MISMATCH: 'canonical worktree path is unchanged',
  WORKTREE_MISSING: 'worktree exists on disk',
  BASE_COMMIT_MISMATCH: 'pinned base commit is unchanged',
  CURRENT_COMMIT_MISMATCH: 'current commit is unchanged',
  WORKTREE_NOT_CLEAN: 'worktree is clean',
  DIVERGENCE_DETECTED: 'no divergence was reported',
});

export interface AutomaticResumeDecision {
  /** True only when every required check produced positive evidence. */
  readonly allowed: boolean;
  /** Stable codes for every check that denied the resume. Empty when allowed. */
  readonly reasonCodes: readonly AutomaticResumeReasonCode[];
  /** The same failures phrased as the checks that did not hold. */
  readonly missingChecks: readonly string[];
}

/** Milliseconds since the epoch, or `null` when the input is not a timestamp. */
function toEpochMs(value: string | Date): number | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Compares two filesystem paths as canonical forms.
 *
 * The caller supplies the *observed* path already canonicalised (symlinks and
 * junctions resolved) because this function performs no I/O. What is done here
 * is the purely lexical part, and it lives in `core/path-identity.ts` so there
 * is exactly one such comparison in the codebase.
 *
 * A relative path on either side is `false`, not "equal once resolved": a
 * relative `repositoryRoot` or `worktreePath` would otherwise be measured
 * against `process.cwd()`, and a state recorded as `"."` would match whichever
 * checkout the process was launched from. See the module comment there.
 */
export function canonicalPathsEqual(a: string, b: string): boolean {
  return absolutePathsEqual(a, b);
}

/**
 * Decides whether the orchestrator may continue this task without a human.
 *
 * Pure and side-effect free. The task state must already have passed
 * `TaskStateSchema`; this function assumes a structurally valid state and only
 * judges it against the observed world.
 */
export function evaluateAutomaticResume(
  state: TaskState,
  evidence: AutomaticResumeEvidence,
): AutomaticResumeDecision {
  const denied: AutomaticResumeReasonCode[] = [];
  const deny = (code: AutomaticResumeReasonCode): void => {
    denied.push(code);
  };

  // --- 1. Is this state even a candidate? ---------------------------------
  if (!isBlockingState(state.state)) {
    deny('STATE_NOT_BLOCKING');
    return finish(denied);
  }
  if (!BLOCKED_STATE_POLICIES[state.state].automaticResumeEligible) {
    deny('STATE_NOT_ELIGIBLE_FOR_UNATTENDED_RESUME');
    return finish(denied);
  }
  if (state.resumeFrom === null) {
    deny('RESUME_POINT_MISSING');
  }

  // --- 2. Has the block actually cleared? ---------------------------------
  // Without a reliable reset timestamp there is nothing to wait for, so no
  // unattended resume is ever granted — the operator has to decide.
  const nowMs = toEpochMs(evidence.now);
  if (nowMs === null) {
    deny('CURRENT_TIME_UNPARSEABLE');
  }

  if (state.reportedResetAt === null) {
    deny('RESET_TIME_MISSING');
  } else {
    const resetMs = toEpochMs(state.reportedResetAt);
    if (resetMs === null) {
      deny('RESET_TIME_UNPARSEABLE');
    } else if (nowMs !== null && nowMs <= resetMs) {
      deny('RESET_TIME_NOT_REACHED');
    }
  }

  // --- 3. Are the credentials good again? ---------------------------------
  if (evidence.authPreflightPassed !== true) {
    deny('AUTH_PREFLIGHT_NOT_PASSED');
  }

  // --- 4. Is this still the same repository, worktree and commit? ---------
  if (
    evidence.observedRepositoryId === null ||
    evidence.observedRepositoryId !== state.repositoryId
  ) {
    deny('REPOSITORY_ID_MISMATCH');
  }
  if (
    evidence.observedRepositoryRoot === null ||
    !canonicalPathsEqual(evidence.observedRepositoryRoot, state.repositoryRoot)
  ) {
    deny('REPOSITORY_ROOT_MISMATCH');
  }
  if (
    evidence.observedWorktreePath === null ||
    !canonicalPathsEqual(evidence.observedWorktreePath, state.worktreePath)
  ) {
    deny('WORKTREE_PATH_MISMATCH');
  }
  if (evidence.worktreeExists !== true) {
    deny('WORKTREE_MISSING');
  }
  if (
    state.basePinnedCommit === null ||
    evidence.observedBasePinnedCommit !== state.basePinnedCommit
  ) {
    deny('BASE_COMMIT_MISMATCH');
  }
  if (state.currentCommit === null || evidence.observedCurrentCommit !== state.currentCommit) {
    deny('CURRENT_COMMIT_MISMATCH');
  }

  // --- 5. Is the worktree in the state we left it in? ---------------------
  if (evidence.worktreeClean !== true || state.worktreeCleanAtCheckpoint !== true) {
    deny('WORKTREE_NOT_CLEAN');
  }
  if (evidence.divergenceDetected !== false) {
    deny('DIVERGENCE_DETECTED');
  }

  return finish(denied);
}

function finish(denied: readonly AutomaticResumeReasonCode[]): AutomaticResumeDecision {
  return Object.freeze({
    allowed: denied.length === 0,
    reasonCodes: Object.freeze([...denied]),
    missingChecks: Object.freeze(denied.map((code) => CHECK_NAMES[code])),
  });
}
