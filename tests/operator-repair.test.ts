/**
 * The operator's own repair of a failed verification, adopted with no agent.
 *
 * ── What this file measures, and why each case exists ──────────────────────
 *
 * `--verify-operator-repair` is the one grant in this build that performs a
 * **write to the repository** — a commit — on an operator's word rather than an
 * agent's work. Every predicate guarding it is therefore a case here, on its
 * own, with the seams injected so that each one can be made to fail in
 * isolation. A fixture manoeuvred into eight shapes proves eight things badly;
 * eight scripted inputs prove them one at a time.
 *
 * The dangerous version of this feature is the one that adopts *some other*
 * change — a half-finished edit, a rebase, another task's work — and calls it a
 * repair of a failure it never saw. So the refusals are the substance of the
 * file and the happy path is one case.
 *
 * The defect it exists for is measured, not imagined: `healthapp/CAPTURE-004`,
 * 2026-09-12. Verification failed on `prettier -c` over one file. Committing
 * the repair moved HEAD off `attempt.subjectCommit`, so the stored failure
 * stopped being evidence about the tree; leaving it uncommitted meant a writing
 * agent that had no shell, could not run the formatter, did not recognise an
 * already-correct diff, and spent its budget parking the task.
 */

import { describe, expect, it } from 'vitest';

import {
  OPERATOR_REPAIR_COMMIT_PHASE,
  OPERATOR_REPAIR_REFUSALS,
  assessOperatorRepair,
  commitOperatorRepair,
  type OperatorRepairAllowed,
  type OperatorRepairAssessmentInput,
} from '../src/verify/operator-repair.js';
import type { ScopeAssessment } from '../src/scope/assess-scope.js';
import type { TaskState } from '../src/core/task-state.js';
import type { GitRunner } from '../src/worktree/git-command.js';
import type { VerificationAttemptLoad } from '../src/verify/verification-attempt-store.js';
import type { VerificationAttemptRecord } from '../src/verify/verification-attempt.js';

const ROOT = 'D:\\Repos\\subject';
const WORKTREE = 'D:\\Repos\\subject.worktrees\\TASK-001';
const FAILED_AT = 'a'.repeat(40);
const LATER = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

function attempt(over: Partial<VerificationAttemptRecord> = {}): VerificationAttemptRecord {
  return Object.freeze({
    attemptedAt: '2026-09-13T09:00:00.000Z',
    subjectCommit: FAILED_AT,
    profileDigest: 'd'.repeat(64),
    verdict: 'FAILED' as const,
    stoppedAt: 'VERIFY',
    phases: Object.freeze([
      Object.freeze({
        phase: 'VERIFY',
        outcome: 'RAN' as const,
        exitCode: 1,
        signal: null,
        outputTruncated: false,
        failureCode: null,
        errnoCode: null,
        durationMs: 12,
      }),
    ]),
    excerpt: Object.freeze({ stdout: Object.freeze([]), stderr: Object.freeze([]) }),
    ...over,
  }) as VerificationAttemptRecord;
}

function history(...attempts: VerificationAttemptRecord[]): VerificationAttemptLoad {
  return Object.freeze({
    reading: 'ATTEMPT_HISTORY' as const,
    record: Object.freeze({
      attemptVersion: 1,
      taskId: 'TASK-001',
      repositoryRoot: ROOT,
      attempts: Object.freeze(attempts),
      binding: 'e'.repeat(64),
    }),
  }) as unknown as VerificationAttemptLoad;
}

function blockedState(over: Partial<TaskState> = {}): TaskState {
  return Object.freeze({
    schemaVersion: 1,
    taskId: 'TASK-001',
    repositoryId: 'subject',
    repositoryRoot: ROOT,
    worktreePath: WORKTREE,
    state: 'BLOCKED_VERIFY' as const,
    stateEnteredAt: '2026-09-13T09:00:01.000Z',
    baseBranch: 'main',
    basePinnedCommit: BASE,
    scopeAuthorityCommit: null,
    workBranch: 'ao/task/TASK-001',
    currentCommit: null,
    reviewRound: 0,
    maxReviewRounds: 2,
    grantedReviewRounds: 0,
    blockedAgent: null,
    resumeFrom: Object.freeze({ phase: 'REMEDIATE' as const, round: 1 }),
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: false,
    findingHistory: Object.freeze([]),
    ...over,
  }) as TaskState;
}

/** A Git that answers `rev-parse HEAD` with one commit and refuses to be asked anything else. */
function gitAt(head: string | null): GitRunner {
  return (async (_cwd: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') {
      return head === null
        ? { outcome: 'GIT_FAILED' as const, exitCode: 128, stdout: '', stderr: '' }
        : { outcome: 'OK' as const, exitCode: 0, stdout: head, stderr: '' };
    }
    throw new Error(`this stub answers rev-parse only; asked: ${args.join(' ')}`);
  }) as unknown as GitRunner;
}

function withinScope(paths: readonly string[] = ['src/a.ts']): ScopeAssessment {
  return Object.freeze({
    verdict: 'WITHIN_SCOPE' as const,
    approvedPaths: Object.freeze([...paths]),
    offences: Object.freeze([]),
    offenceCount: 0,
    offencesTruncated: false,
    reason: null,
  });
}

function scopeVerdict(verdict: ScopeAssessment['verdict']): ScopeAssessment {
  return Object.freeze({
    verdict,
    approvedPaths: Object.freeze([]),
    offences: Object.freeze([]),
    offenceCount: verdict === 'VIOLATION' ? 1 : 0,
    offencesTruncated: false,
    reason: null,
  });
}

/** Everything permitted, so a case changes exactly the one thing it is about. */
function input(over: Partial<OperatorRepairAssessmentInput> = {}): OperatorRepairAssessmentInput {
  return {
    state: blockedState(),
    git: gitAt(FAILED_AT),
    authorisedWorktreePath: WORKTREE,
    loadAttempts: () => history(attempt()),
    observeClean: async () => false,
    assessScope: async () => withinScope(),
    ...over,
  };
}

describe('the one shape that is permitted', () => {
  it('allows a scoped repair of the latest failure on the tree that failed', async () => {
    const assessment = await assessOperatorRepair(input());

    expect(assessment.allowed).toBe(true);
    if (!assessment.allowed) expect.unreachable();
    expect(assessment.attempt.subjectCommit).toBe(FAILED_AT);
    // The approved set is the scope gate's own, handed on rather than re-derived
    // at the commit — which would measure after whatever it is meant to catch.
    expect(assessment.approvedPaths).toEqual(['src/a.ts']);
  });
});

describe('every predicate refuses on its own, and names itself', () => {
  it('refuses a task that is not blocked on a verification failure', async () => {
    for (const state of ['REMEDIATING', 'HUMAN_DECISION_REQUIRED', 'VERIFYING'] as const) {
      const assessment = await assessOperatorRepair(input({ state: blockedState({ state }) }));
      expect(assessment.allowed).toBe(false);
      if (assessment.allowed) expect.unreachable();
      expect(assessment.refusal).toBe('STATE_NOT_BLOCKED_VERIFY');
    }
  });

  /**
   * `BLOCKED_VERIFY` declares one phase, so a record naming another has been
   * edited. An operator decision does not get to choose which phase it enters.
   */
  it('refuses a record whose resume point was changed under it', async () => {
    for (const resumeFrom of [null, { phase: 'IMPLEMENT' as const, round: 1 }]) {
      const assessment = await assessOperatorRepair(
        input({ state: blockedState({ resumeFrom }) }),
      );
      expect(assessment.allowed).toBe(false);
      if (assessment.allowed) expect.unreachable();
      expect(assessment.refusal).toBe('RESUME_POINT_NOT_REMEDIATE');
    }
  });

  it('refuses when no verification failure was ever recorded', async () => {
    for (const load of [
      history(),
      Object.freeze({ reading: 'ABSENT' as const, record: null }) as VerificationAttemptLoad,
      Object.freeze({ reading: 'MALFORMED' as const, record: null }) as VerificationAttemptLoad,
    ]) {
      const assessment = await assessOperatorRepair(input({ loadAttempts: () => load }));
      expect(assessment.allowed).toBe(false);
      if (assessment.allowed) expect.unreachable();
      expect(assessment.refusal).toBe('NO_VERIFICATION_ATTEMPT');
    }
  });

  /**
   * `UNAVAILABLE` means the commands never ran — a missing toolchain, an empty
   * profile. That is not a thing a diff in the worktree repairs, and adopting
   * against it would re-run a verification that will be just as unavailable.
   */
  it('refuses when the latest attempt is UNAVAILABLE rather than FAILED', async () => {
    const assessment = await assessOperatorRepair(
      input({ loadAttempts: () => history(attempt({ verdict: 'UNAVAILABLE' })) }),
    );
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) expect.unreachable();
    expect(assessment.refusal).toBe('LATEST_ATTEMPT_NOT_FAILED');
  });

  /**
   * The stale-attempt case, and it is the one a naive implementation gets
   * wrong. A task that failed, was remediated, and failed again has two
   * records. HEAD matches the OLDER one here — so an implementation that
   * searched the history for *any* failure matching HEAD would allow this, and
   * would re-verify against evidence that has already been superseded.
   */
  it('refuses when HEAD matches an older failure and not the latest one', async () => {
    const assessment = await assessOperatorRepair(
      input({
        loadAttempts: () =>
          history(attempt({ subjectCommit: FAILED_AT }), attempt({ subjectCommit: LATER })),
      }),
    );
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) expect.unreachable();
    expect(assessment.refusal).toBe('HEAD_MOVED');
  });

  it('allows when HEAD matches the latest of several failures', async () => {
    const assessment = await assessOperatorRepair(
      input({
        loadAttempts: () =>
          history(attempt({ subjectCommit: LATER }), attempt({ subjectCommit: FAILED_AT })),
      }),
    );
    expect(assessment.allowed).toBe(true);
  });

  /**
   * The conjunct that makes the whole grant honest: it is what proves the
   * operator repaired *the tree that failed*, and not a later one. This is
   * exactly the case that made committing-then-resuming impossible on
   * CAPTURE-004.
   */
  it('refuses when HEAD has moved off the failed subject commit', async () => {
    const assessment = await assessOperatorRepair(input({ git: gitAt(LATER) }));
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) expect.unreachable();
    expect(assessment.refusal).toBe('HEAD_MOVED');
  });

  it('refuses when Git will not say what HEAD is', async () => {
    const assessment = await assessOperatorRepair(input({ git: gitAt(null) }));
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) expect.unreachable();
    expect(assessment.refusal).toBe('HEAD_UNREADABLE');
  });

  /**
   * An adoption of nothing would commit nothing and re-verify an unchanged
   * tree — spending a verification run to learn what is already recorded.
   */
  it('refuses when the worktree carries no repair', async () => {
    const assessment = await assessOperatorRepair(input({ observeClean: async () => true }));
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) expect.unreachable();
    expect(assessment.refusal).toBe('NOTHING_TO_ADOPT');
  });

  it('treats an unreadable worktree as a denial, never as a repair', async () => {
    const assessment = await assessOperatorRepair(input({ observeClean: async () => null }));
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) expect.unreachable();
    expect(assessment.refusal).toBe('WORKTREE_UNREADABLE');
  });

  /**
   * The operator is trusted to decide, not to be exempt from the boundary the
   * task declared. A repair that reaches outside it is a different change.
   */
  it('refuses a repair that reaches outside the task’s declared scope', async () => {
    const assessment = await assessOperatorRepair(
      input({ assessScope: async () => scopeVerdict('VIOLATION') }),
    );
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) expect.unreachable();
    expect(assessment.refusal).toBe('REPAIR_OUT_OF_SCOPE');
  });

  it('refuses when the scope gate could not reach a verdict', async () => {
    const assessment = await assessOperatorRepair(
      input({ assessScope: async () => scopeVerdict('INDETERMINATE') }),
    );
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) expect.unreachable();
    expect(assessment.refusal).toBe('SCOPE_INDETERMINATE');
  });

  it('never approves a path on any refusal', async () => {
    const refusals = await Promise.all([
      assessOperatorRepair(input({ observeClean: async () => true })),
      assessOperatorRepair(input({ git: gitAt(LATER) })),
      assessOperatorRepair(input({ assessScope: async () => scopeVerdict('VIOLATION') })),
    ]);
    for (const assessment of refusals) {
      expect(assessment.allowed).toBe(false);
      expect('approvedPaths' in assessment).toBe(false);
    }
  });

  it('every declared refusal is a member of the closed vocabulary', () => {
    expect(new Set(OPERATOR_REPAIR_REFUSALS).size).toBe(OPERATOR_REPAIR_REFUSALS.length);
    expect(OPERATOR_REPAIR_REFUSALS).toContain('HEAD_MOVED');
    expect(OPERATOR_REPAIR_REFUSALS).toContain('REPAIR_OUT_OF_SCOPE');
  });
});

describe('the commit says an operator made it', () => {
  /**
   * The one thing this grant may never do is claim a writer ran.
   * `commitTaskWork` writes `AO:<task>:<phase>:r<n>` for its two agent phases,
   * so the operator phase gets a different prefix from the first character —
   * a reader of `git log --oneline` can tell them apart without knowing the
   * vocabulary.
   */
  it('writes a message that is not a writing agent’s, and never AO:REMEDIATE', async () => {
    const seen: string[] = [];
    const vectors: (readonly string[])[] = [];
    const git = (async (_cwd: string, args: readonly string[]) => {
      seen.push(args.join(' '));
      vectors.push([...args]);
      if (args.includes('status')) {
        return { outcome: 'OK' as const, exitCode: 0, stdout: ' M src/a.ts', stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { outcome: 'OK' as const, exitCode: 0, stdout: LATER, stderr: '' };
      }
      return { outcome: 'OK' as const, exitCode: 0, stdout: '', stderr: '' };
    }) as unknown as GitRunner;

    const allowed: OperatorRepairAllowed = {
      allowed: true,
      attempt: attempt(),
      approvedPaths: ['src/a.ts'],
      basePinnedCommit: BASE,
    };

    // `reviewRound: 1` deliberately, and it is the whole point of the fixture.
    // The round came from `state.reviewRound + 1` under a comment claiming it
    // invented no counter; at `reviewRound: 0` — the only value this file used —
    // that formula and the block's own recorded round both give 1, so the pin
    // could not tell them apart. At 1 they disagree: the resume point says r1,
    // the old formula said r2, and r2 is a round no other artefact for this task
    // carries and one this repair went into permanent history claiming.
    await commitOperatorRepair(
      git,
      WORKTREE,
      blockedState({ reviewRound: 1 }),
      allowed,
    );

    const message = seen.find((call) => call.includes('commit -m')) ?? '';
    expect(message).toContain('OPERATOR-REPAIR:TASK-001:VERIFY:r1');
    expect(message).not.toContain(':r2');
    expect(message).not.toContain('AO:TASK-001');
    expect(message).not.toContain('REMEDIATE');
    expect(message).not.toContain('IMPLEMENT');
    // Still one shell-inert token: `-m` takes one argument. Asked of the
    // message the CALL carried, not of a literal typed here — the previous
    // version asserted `'OPERATOR-REPAIR:TASK-001:VERIFY:r1'.includes(' ')`,
    // which is a claim about the test file and cannot fail for any
    // implementation.
    expect(OPERATOR_REPAIR_COMMIT_PHASE).toBe('OPERATOR-REPAIR');
    const commitArgs = vectors.find((args) => args.includes('commit')) ?? [];
    const subject = commitArgs[commitArgs.indexOf('-m') + 1] ?? '';
    expect(subject).toBe('OPERATOR-REPAIR:TASK-001:VERIFY:r1');
    expect(subject.includes(' ')).toBe(false);
  });

  /**
   * The fresh verification has to run against the repair, not against the tree
   * that failed. What binds it is the commit this returns: it is HEAD read
   * *after* the commit landed, and the assertion is that it differs from the
   * failed attempt's own subject — the two are the before and after of the same
   * tree, and returning the wrong one would re-verify what already failed.
   */
  it('reports the commit the repair produced, not the one that failed', async () => {
    const git = (async (_cwd: string, args: readonly string[]) => {
      if (args.includes('status')) {
        return { outcome: 'OK' as const, exitCode: 0, stdout: ' M src/a.ts', stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { outcome: 'OK' as const, exitCode: 0, stdout: LATER, stderr: '' };
      }
      return { outcome: 'OK' as const, exitCode: 0, stdout: '', stderr: '' };
    }) as unknown as GitRunner;

    const failed = attempt({ subjectCommit: FAILED_AT });
    const result = await commitOperatorRepair(git, WORKTREE, blockedState(), {
      allowed: true,
      attempt: failed,
      approvedPaths: ['src/a.ts'],
      basePinnedCommit: BASE,
    });

    expect(result.outcome).toBe('ADOPTED');
    if (result.outcome !== 'ADOPTED') expect.unreachable();
    expect(result.commit).toBe(LATER);
    expect(result.commit).not.toBe(failed.subjectCommit);
  });

/**
   * A commit that landed but reached beyond what the gate approved is NOT an
   * adoption, and this is the case that says so.
   *
   * A review found the arm unpinned and named the sharp mutant: rewriting
   * `case 'COMMITTED_BEYOND_APPROVED_SCOPE': return ADOPTED` killed no test,
   * and that arm is the only thing between a commit containing unapproved
   * paths and the task entering `VERIFYING`.
   *
   * The window it exists for is real rather than theoretical. `commitTaskWork`
   * stages with `add --all` and compares what landed against the approved set
   * *afterwards*, so a path appearing between the assessment and the staging —
   * a background formatter, an editor writing a sibling file, the operator
   * carrying on working — is committed and then noticed. The commit is kept as
   * evidence and deliberately not undone; what must not happen is the task
   * treating it as the operator's approved repair and verifying on it.
   */
  it('refuses a commit that reached beyond the approved paths', async () => {
    const git = (async (_cwd: string, args: readonly string[]) => {
      // Dirty, so the commit path runs at all.
      if (args.includes('status')) {
        return { outcome: 'OK' as const, exitCode: 0, stdout: ' M src/a.ts', stderr: '' };
      }
      // What the commit actually contains: a second path nobody approved.
      if (args.includes('diff') && args.includes('--name-only')) {
        return {
          outcome: 'OK' as const,
          exitCode: 0,
          stdout: 'src/a.ts\0src/elsewhere.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'rev-parse') {
        return { outcome: 'OK' as const, exitCode: 0, stdout: LATER, stderr: '' };
      }
      return { outcome: 'OK' as const, exitCode: 0, stdout: '', stderr: '' };
    }) as unknown as GitRunner;

    const result = await commitOperatorRepair(git, WORKTREE, blockedState(), {
      allowed: true,
      attempt: attempt(),
      approvedPaths: ['src/a.ts'],
      basePinnedCommit: BASE,
    });

    expect(result.outcome).toBe('COMMITTED_BEYOND_APPROVED_SCOPE');
    // The distinction that matters to the driver: anything but `ADOPTED` stops
    // the transition, so the task stays where it was and a person looks.
    expect(result.outcome).not.toBe('ADOPTED');
  });


  it('reports nothing recorded rather than a success when the commit staged nothing', async () => {
    const git = (async (_cwd: string, args: readonly string[]) => {
      if (args.includes('status')) {
        return { outcome: 'OK' as const, exitCode: 0, stdout: '', stderr: '' };
      }
      return { outcome: 'OK' as const, exitCode: 0, stdout: '', stderr: '' };
    }) as unknown as GitRunner;

    const result = await commitOperatorRepair(git, WORKTREE, blockedState(), {
      allowed: true,
      attempt: attempt(),
      approvedPaths: [],
      basePinnedCommit: BASE,
    });

    // Never `ADOPTED` with no commit: a caller reading that would move the task
    // to VERIFYING over an unchanged tree and re-learn the failure it had.
    expect(result.outcome).toBe('NOTHING_RECORDED');
    expect('commit' in result).toBe(false);
  });
});
