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
 * Gathering the evidence — running `git status`, re-running the auth preflight,
 * canonicalising paths — deliberately belongs elsewhere, and since V2-04 that
 * elsewhere exists. `state/resume-decision.ts` translates an observed runtime
 * into {@link AutomaticResumeEvidence} and is the only caller of this function;
 * `run/run-driver.ts` reaches it through `classifyResume` on every iteration.
 *
 * A resume this function allows is still not a resume that happens:
 * `run-driver.ts` checks the invocation's continuation grant *before* the resume
 * write, and that check can only withhold. So eligibility decided here plus an
 * invocation authorised to act is what moves a blocked task.
 *
 * Since V3-08 that second authority has three values rather than two, and one of
 * them — `AUTOMATIC_RESUME_ONLY` — states that nobody is present. It is *entered*
 * only where this function answered `allowed`: an in-flight task the invocation
 * did not itself resume classifies `ATTENDED_ONLY` and is refused, and the layers
 * above refuse to start a task or remove a lease under it. AO therefore has
 * exactly one unattended path on which it RUNS AN AGENT, and this decision is
 * the gate on the way in.
 *
 * The qualifier is written down because V4 slice 13 made the unqualified version
 * false, and a review measured the difference rather than arguing it. That slice
 * added a second unattended path — `delivery --drive --publish-head
 * --automatic-publish-head-only` — which starts no agent and writes no task
 * state, but which is a `--drive`, and a drive writes local records, takes this
 * repository's execution lease and runs the verification commands the target
 * repository's own profile declares. So "no agent" is the property that
 * survives; "no execution" and "no lease" are not.
 *
 * It is not a gate on every step afterwards, and saying so was a review finding
 * against this very paragraph. Once the resume this function allowed has been
 * written, `run-driver.ts` carries the continuation through the rest of that one
 * call — the ordinary loop, to its step budget — because a resume that could take
 * a single step would spend the pause and leave the task no better off. The
 * decision governs entry; the step budget governs how far. `run/unattended-resume.ts` may also wait out a reported reset
 * once, holding no execution lease, and then ask this function again from
 * evidence gathered entirely after the wait — a fresh decision, never a stored
 * one.
 *
 * (This paragraph read "there is deliberately still **no resume runner**" until
 * V3-06. That had been false since V2-04, and it was not a harmless leftover:
 * the slice-6 brief was planned from it, and specified rebuilding a consumer
 * this module already had. Its replacement then claimed the lifecycle driver
 * re-entered this path "after waiting out a recorded quota reset" — describing a
 * wait that was withdrawn from the same commit. Documentation that outlives its
 * code writes the next plan, and a correction can do it too.)
 */

import {
  isAuthPreflightEvidence,
  type AuthPreflightEvidence,
} from './auth-preflight-evidence.js';
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
  /**
   * The artefact a real auth preflight produced, or `null` when none ran.
   *
   * Not a boolean, deliberately (V2-05 / I4): a caller cannot mint one, so a
   * caller cannot claim a preflight it never performed. `null` is the honest
   * value for "no check was run" and denies the resume.
   */
  readonly authEvidence: AuthPreflightEvidence | null;
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
  // Verified, not read. `authEvidence` is typed as the opaque artefact, but a
  // static type is not a runtime guarantee: `as unknown as` defeats any of them.
  // So the gate is the `instanceof` predicate, and a forged or absent value
  // denies identically. The reason code is unchanged — from an operator's point
  // of view "auth was not re-proven" is still exactly what happened.
  if (!isAuthPreflightEvidence(evidence.authEvidence)) {
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

/* ────────────── which refusals belong to the record, not the world ────────── */

/**
 * The refusals a perfect world could not remove.
 *
 * Exactly one member, and it is here because it cannot be *satisfied* from a
 * pure function rather than because it is uninteresting: `authEvidence` is the
 * opaque artefact a real preflight mints, and {@link recordOnlyResumeRefusals}
 * is documented as performing no I/O, so it has no way to produce one. Every
 * other world fact this module reads is a value the caller can state, and
 * {@link recordOnlyResumeRefusals} states each of them favourably.
 *
 * Kept as a named set rather than a filter written inline so that the claim is
 * checkable: the suite asserts that a record with nothing wrong with it refuses
 * under favourable evidence with *this set exactly*, which is what makes
 * removing a member — or forgetting to add one — a failure rather than a
 * silently wider permission.
 */
export const WORLD_DEPENDENT_RESUME_REFUSALS: ReadonlySet<AutomaticResumeReasonCode> = new Set([
  'AUTH_PREFLIGHT_NOT_PASSED',
]);

/**
 * The refusals that survive a world agreeing with the record on every fact.
 *
 * ── The question this answers ──────────────────────────────────────────────
 *
 * `evaluateAutomaticResume` denies for two very different kinds of reason, and
 * the difference decides who owns a parked task:
 *
 *  - the **world** disagrees with the record — a dirty tree, a moved HEAD, a
 *    login that no longer passes. An operator can go and fix any of those, and
 *    the automatic path will then grant the resume by itself;
 *  - the **record** cannot be resumed from at all — it names no commit, or it
 *    says the worktree was already dirty when the interruption was recorded, or
 *    it carries no reset instant. Nothing anybody does to the repository changes
 *    those, because they are properties of the document.
 *
 * This function returns the second kind. It gets them by *asking the policy* —
 * evaluating it against evidence that agrees with the record on every
 * observable fact — rather than by restating which checks are record-only. That
 * distinction is the whole point of the construction. `README.md`'s L-M3-01-1
 * declined to narrow the wake scan by `currentCommit` and
 * `worktreeCleanAtCheckpoint` precisely because doing so would have been "a
 * second reading of another module's policy, correct only for as long as that
 * policy keeps those two checks record-only". A call is not a second reading:
 * if a later slice makes one of them consult the world, or adds a third check
 * of either kind, this function's answer moves with it and nothing here has to
 * be edited.
 *
 * ── The one maintenance obligation, and the test that enforces it ──────────
 *
 * The favourable evidence below has to stay favourable. A new world fact added
 * to {@link AutomaticResumeEvidence} would arrive here as whatever value the
 * object literal happens not to set, and a denying default would make every
 * record look unresumable. The guard is a test rather than a comment: a state
 * with nothing wrong with it must produce `[]`, so a new check that denies
 * under a perfect world fails the suite instead of silently widening an
 * operator escape.
 *
 * Pure and side-effect free, like everything else in this module: no clock read,
 * no filesystem, no Git. `now` is supplied.
 */
export function recordOnlyResumeRefusals(
  state: TaskState,
  now: string | Date,
): readonly AutomaticResumeReasonCode[] {
  const decision = evaluateAutomaticResume(state, {
    now,
    // The one fact that cannot be stated favourably. See the set above.
    authEvidence: null,
    // Every remaining fact, asserted to agree with the record. Where the record
    // itself is `null` the comparison still denies, and that denial is exactly
    // what this function is for.
    observedRepositoryId: state.repositoryId,
    observedRepositoryRoot: state.repositoryRoot,
    observedWorktreePath: state.worktreePath,
    worktreeExists: true,
    observedBasePinnedCommit: state.basePinnedCommit,
    observedCurrentCommit: state.currentCommit,
    worktreeClean: true,
    divergenceDetected: false,
  });

  return Object.freeze(
    decision.reasonCodes.filter((code) => !WORLD_DEPENDENT_RESUME_REFUSALS.has(code)),
  );
}
