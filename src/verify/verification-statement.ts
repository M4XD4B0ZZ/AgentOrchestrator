/**
 * What this orchestrator can honestly say about verification, for one tree, at
 * one moment.
 *
 * ── Why a statement and not a boolean ──────────────────────────────────────
 *
 * Two durable stores hold verification facts, and neither is a standing verdict.
 * `verification-pass.ts` holds at most one pass, about one commit;
 * `verification-attempt.ts` holds a history of failures, each about one commit.
 * Both are records of a *past run*, and the question an agent's briefing needs
 * answered is about the tree in front of it **now**.
 *
 * This module is the join, and it is deliberately a five-member reading rather
 * than a boolean, because the five send a reader to five different places:
 *
 *  - `PASSED_ON_THIS_TREE` — AO ran this repository's own declared verification
 *    against the commit the worktree is at now, under the profile in force now,
 *    and every phase exited 0. This is the only member that entitles anything to
 *    say the gate is green;
 *  - `FAILED_ON_THIS_TREE` — AO measured *this* commit and it did not pass. It
 *    outranks a pass for the same commit when it is the newer of the two, and it
 *    outranks one whose order cannot be established, because a build that
 *    reports good news it cannot prove is the latest word is the failure this
 *    whole slice exists to end;
 *  - `PASSED_ELSEWHERE` — a pass exists, and it is about a different commit or a
 *    different verification contract. Named as such, with which of the two
 *    differed, so nobody reads it as this tree's standing;
 *  - `NOT_OBSERVABLE` — Git could not say what the worktree is at, so no
 *    comparison was possible. Distinct from "no record": the difference between
 *    a question that was not answered and one whose answer is nothing;
 *  - `NOT_MEASURED` — no usable record for this task. Also what an unreadable,
 *    foreign or newer-version document produces, because "there is a document
 *    and this build cannot say what it claims" is not evidence of a pass.
 *
 * ── What is deliberately not in the predicate ──────────────────────────────
 *
 * Worktree cleanliness. It is **reported** — `uncommittedChanges` — and it is
 * not part of what makes a statement `PASSED_ON_THIS_TREE`, which is a
 * departure worth stating rather than hiding. Verification runs against the
 * working tree, and a passing run routinely leaves untracked output behind
 * (coverage, reports, generated fixtures). `git status --untracked-files=normal`
 * then calls the tree dirty, so a predicate demanding cleanliness would degrade
 * the ordinary passing path to "not on this tree" — reproducing the incident
 * this fixes, with the fix as its cause. The commit is what the record names and
 * what it can honestly be compared against; the cleanliness is a separate
 * observation, reported beside it.
 */

import {
  latestVerificationAttempt,
  type VerificationAttemptLoad,
} from './verification-attempt-store.js';
import type { VerificationAttemptRecord } from './verification-attempt.js';
import type { VerificationPassLoad } from './verification-pass-store.js';
import type { PassedPhase } from './verification-pass.js';

export const VERIFICATION_STATEMENT_READINGS = [
  'PASSED_ON_THIS_TREE',
  'FAILED_ON_THIS_TREE',
  'PASSED_ELSEWHERE',
  'NOT_OBSERVABLE',
  'NOT_MEASURED',
] as const;

export type VerificationStatementReading = (typeof VERIFICATION_STATEMENT_READINGS)[number];

/** What made a pass "elsewhere". Never `null` on `PASSED_ELSEWHERE`. */
export const STATEMENT_DIFFERENCES = ['COMMIT', 'PROFILE'] as const;
export type StatementDifference = (typeof STATEMENT_DIFFERENCES)[number];

export interface VerificationStatement {
  readonly reading: VerificationStatementReading;
  /** The instant of the run being described, or `null` when none is. */
  readonly measuredAt: string | null;
  /** The commit that run measured, or `null` when no run is being described. */
  readonly subjectCommit: string | null;
  /** The commit the tree is at now, or `null` when Git could not say. */
  readonly observedCommit: string | null;
  /** The phases of a described pass, in order. Empty unless one is described. */
  readonly phases: readonly PassedPhase[];
  /** Which fact made a pass "elsewhere". `null` on every other reading. */
  readonly differs: StatementDifference | null;
  /** The verdict of a described failure, and where it stopped. */
  readonly failureVerdict: VerificationAttemptRecord['verdict'] | null;
  readonly failureStoppedAt: string | null;
  /**
   * Whether the tree carries changes that were not committed, or `null` when
   * the question was not answered.
   *
   * `null` is not a soft `false`. It is reported, never folded into the reading.
   */
  readonly uncommittedChanges: boolean | null;
}

export interface VerificationStatementInputs {
  /** What the pass store said. */
  readonly pass: VerificationPassLoad;
  /** What the attempt store said. */
  readonly attempts: VerificationAttemptLoad;
  /** HEAD of the worktree as observed now, or `null` when unreadable. */
  readonly observedCommit: string | null;
  /** Whether the worktree was clean when observed, or `null` when unasked. */
  readonly worktreeClean: boolean | null;
  /** The digest of the verification policy in force for this run. */
  readonly profileDigest: string;
}

const EMPTY_PHASES: readonly PassedPhase[] = Object.freeze([]);

function statement(from: Partial<VerificationStatement> & { readonly reading: VerificationStatementReading }): VerificationStatement {
  return Object.freeze({
    measuredAt: null,
    subjectCommit: null,
    observedCommit: null,
    phases: EMPTY_PHASES,
    differs: null,
    failureVerdict: null,
    failureStoppedAt: null,
    uncommittedChanges: null,
    ...from,
  });
}

/**
 * The instant, as a number, or `null` when this build cannot order it.
 *
 * Bounded rather than trusted: `Date.parse` accepts a great deal and answers
 * `NaN` for the rest, and an unorderable instant must not silently sort as zero
 * — which would make an ancient failure look newer than today's pass. A `null`
 * here is what makes the caller fall back to the pessimistic answer.
 */
function instant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The newest attempt in the history that measured a given commit, or `null`.
 *
 * Scanned from the back rather than taking `latestVerificationAttempt`, because
 * the newest attempt overall may be about another commit entirely — a remediated
 * task's history routinely is — and "did AO measure THIS tree and fail" is the
 * question being asked.
 */
function newestAttemptFor(
  attempts: VerificationAttemptLoad,
  commit: string,
): VerificationAttemptRecord | null {
  if (attempts.reading !== 'ATTEMPT_HISTORY' || attempts.record === null) return null;
  const list = attempts.record.attempts;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const attempt = list[index];
    if (attempt !== undefined && attempt.subjectCommit === commit) return attempt;
  }
  return null;
}

/**
 * What AO may honestly say about verification for the tree it just observed.
 *
 * A pure function of two store readings and one observation. It performs no
 * I/O, reads no clock and decides no transition: the caller has already made
 * every measurement, and what happens next is the caller's.
 */
export function verificationStatement(inputs: VerificationStatementInputs): VerificationStatement {
  const clean = inputs.worktreeClean;
  const uncommittedChanges = clean === null ? null : !clean;

  if (inputs.observedCommit === null) {
    return statement({ reading: 'NOT_OBSERVABLE', uncommittedChanges });
  }
  const observedCommit = inputs.observedCommit;

  const passRecord = inputs.pass.reading === 'PASS_RECORD' ? inputs.pass.record : null;
  const failure = newestAttemptFor(inputs.attempts, observedCommit);

  const passIsThisTree = passRecord !== null && passRecord.subjectCommit === observedCommit;
  const passIsThisProfile = passRecord !== null && passRecord.profileDigest === inputs.profileDigest;

  // A failure measured against this very commit outranks a pass for it unless
  // the pass is provably the newer of the two. "Provably" is the whole of the
  // rule: an instant this build cannot parse leaves the order unknown, and an
  // unknown order resolves to the failure.
  if (failure !== null) {
    const passNewer =
      passIsThisTree && passRecord !== null
        ? (() => {
            const passAt = instant(passRecord.measuredAt);
            const failAt = instant(failure.attemptedAt);
            return passAt !== null && failAt !== null && passAt > failAt;
          })()
        : false;
    if (!passNewer) {
      return statement({
        reading: 'FAILED_ON_THIS_TREE',
        measuredAt: failure.attemptedAt,
        subjectCommit: failure.subjectCommit,
        observedCommit,
        failureVerdict: failure.verdict,
        failureStoppedAt: failure.stoppedAt,
        uncommittedChanges,
      });
    }
  }

  if (passRecord === null) {
    return statement({ reading: 'NOT_MEASURED', observedCommit, uncommittedChanges });
  }

  if (passIsThisTree && passIsThisProfile) {
    return statement({
      reading: 'PASSED_ON_THIS_TREE',
      measuredAt: passRecord.measuredAt,
      subjectCommit: passRecord.subjectCommit,
      observedCommit,
      phases: passRecord.phases,
      uncommittedChanges,
    });
  }

  // A pass exists and is not about this tree's current state. Which of the two
  // facts differed is named, because "you are looking at a different commit" and
  // "the verification contract changed under you" are different things to fix.
  return statement({
    reading: 'PASSED_ELSEWHERE',
    measuredAt: passRecord.measuredAt,
    subjectCommit: passRecord.subjectCommit,
    observedCommit,
    phases: passRecord.phases,
    differs: passIsThisTree ? 'PROFILE' : 'COMMIT',
    uncommittedChanges,
  });
}
