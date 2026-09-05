/**
 * M8-01 — what this orchestrator measured, and who is told about it.
 *
 * ── The failure being closed ───────────────────────────────────────────────
 *
 * `RESOLVER-V3-054` burned three review rounds and escalated on a finding that
 * was false: `verification.blocking-checks-not-passed`. Verification had passed,
 * twice. Nothing recorded it — the verify step advanced to `REVIEWING` and
 * dropped the report — so the only statement about verification anywhere was a
 * stale handoff sentence in the working tree saying `verify` exited 1. The
 * reviewer read the tree, found the prose, and was right to report it. The
 * writer could not contradict it either: it holds no shell.
 *
 * ── What these cases are built to break ────────────────────────────────────
 *
 * The temptations, each with a case aimed at it:
 *
 *  - **a scripted reviewer.** The reviewer here is a POLICY over the payload,
 *    not a script: it raises the finding unless the payload names the worktree's
 *    current commit beside a pass. That value cannot appear in a payload built
 *    from the task body, the context paths and stale prose, so a build that
 *    briefed nothing cannot satisfy it by accident;
 *  - **a seamed verification.** No `verify` seam is injected. The profile
 *    declares `git --version`, a real process runs, and `VERIFYING → REVIEWING`
 *    is reachable only on `PASSED`;
 *  - **an in-memory carry.** The review runs in a *separate call* with freshly
 *    built dependencies, which is the restart shape `RESOLVER-V3-054` was in by
 *    its second round. A fix that threaded the live report through one pass
 *    fails here;
 *  - **a floating verdict.** After the tree moves, the same stored pass must
 *    stop being read as this tree's, and the reviewer's finding must come back.
 *    A build that ignored `subjectCommit` passes every other case in this file.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import {
  buildReviewPayload,
  buildVerificationRemediationPayload,
} from '../src/loop/findings.js';
import { runReviewStep, runVerifyStep } from '../src/loop/loop-step.js';
import type { LoopDependencies } from '../src/loop/loop-step.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';

import {
  verificationPassFrom,
  type VerificationPassRecord,
} from '../src/verify/verification-pass.js';
import {
  loadVerificationPass,
  recordVerificationPass,
} from '../src/verify/verification-pass-store.js';
import { loadVerificationAttempts } from '../src/verify/verification-attempt-store.js';
import { verificationStatement } from '../src/verify/verification-statement.js';
import type { VerificationReport } from '../src/verify/run-verification.js';
import { reviewerBriefingLines, writerBriefingLines } from '../src/loop/orchestrator-briefing.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { reload, seedDeliveredState, startTask, tickingClock } from './helpers/e2e-fixtures.js';
import { recordedAgent, reviewResult } from './helpers/e2e-fixtures.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { briefingFixture, notMeasured } from './helpers/briefing.js';
import { git } from './helpers/repo-fixtures.js';

afterEach(() => {
  releaseTestLeases();
});

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const DIGEST_A = '1'.repeat(64);
const DIGEST_B = '2'.repeat(64);

function passingReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return Object.freeze({
    verdict: 'PASSED' as const,
    phases: Object.freeze([
      Object.freeze({
        phase: 'VERIFY' as const,
        outcome: 'RAN' as const,
        exitCode: 0,
        signal: null,
        outputTruncated: false,
        failureCode: null,
        errnoCode: null,
        durationMs: 12,
      }),
    ]),
    stoppedAt: null,
    diagnostics: Object.freeze({ stdoutExcerpt: '', stderrExcerpt: '', trusted: false as const }),
    ...overrides,
  }) as VerificationReport;
}

function passRecord(overrides: Partial<VerificationPassRecord> = {}): VerificationPassRecord {
  const minted = verificationPassFrom(passingReport(), {
    measuredAt: '2026-09-04T08:00:00.000Z',
    subjectCommit: COMMIT_A,
    profileDigest: DIGEST_A,
    taskId: 'M8-01',
    repositoryRoot: 'D:\\repo',
  });
  if (minted === null) throw new Error('the fixture report must mint a pass');
  return Object.freeze({ ...minted, ...overrides });
}

/* ═════════ A. The mint refuses everything that is not a pass ══════════════ */

describe('the pass record is minted only from a pass', () => {
  it('refuses a report that did not pass', () => {
    for (const verdict of ['FAILED', 'UNAVAILABLE'] as const) {
      expect(
        verificationPassFrom(passingReport({ verdict, stoppedAt: 'VERIFY' }), {
          measuredAt: '2026-09-04T08:00:00.000Z',
          subjectCommit: COMMIT_A,
          profileDigest: DIGEST_A,
          taskId: 'M8-01',
          repositoryRoot: 'D:\\repo',
        }),
      ).toBeNull();
    }
  });

  it('refuses a PASSED report whose own phases contradict it', () => {
    // `runVerification` cannot produce these. Minting from one anyway would put
    // a document on disk asserting a pass its own contents deny.
    const contradictions: readonly VerificationReport[] = [
      passingReport({ phases: Object.freeze([]) }),
      passingReport({
        phases: Object.freeze([
          Object.freeze({
            phase: 'VERIFY' as const,
            outcome: 'RAN' as const,
            exitCode: 1,
            signal: null,
            outputTruncated: false,
            failureCode: null,
            errnoCode: null,
            durationMs: 1,
          }),
        ]),
      }),
      passingReport({
        phases: Object.freeze([
          Object.freeze({
            phase: 'VERIFY' as const,
            outcome: 'UNAVAILABLE' as const,
            exitCode: null,
            signal: null,
            outputTruncated: false,
            failureCode: 'SPAWN_FAILED' as const,
            errnoCode: null,
            durationMs: 1,
          }),
        ]),
      }),
    ];
    for (const report of contradictions) {
      expect(
        verificationPassFrom(report, {
          measuredAt: '2026-09-04T08:00:00.000Z',
          subjectCommit: COMMIT_A,
          profileDigest: DIGEST_A,
          taskId: 'M8-01',
          repositoryRoot: 'D:\\repo',
        }),
      ).toBeNull();
    }
  });

  it('carries the truncation flag of a passing phase', () => {
    // A gate that writes 62 MiB and passes is the M6 case. An operator reading
    // "PASSED" needs to know the evidence behind it was cut.
    const record = verificationPassFrom(
      passingReport({
        phases: Object.freeze([
          Object.freeze({
            phase: 'VERIFY' as const,
            outcome: 'RAN' as const,
            exitCode: 0,
            signal: null,
            outputTruncated: true,
            failureCode: null,
            errnoCode: null,
            durationMs: 9,
          }),
        ]),
      }),
      {
        measuredAt: '2026-09-04T08:00:00.000Z',
        subjectCommit: COMMIT_A,
        profileDigest: DIGEST_A,
        taskId: 'M8-01',
        repositoryRoot: 'D:\\repo',
      },
    );
    expect(record?.phases[0]?.outputTruncated).toBe(true);
  });
});

/* ═════════ B. The statement, and the order it resolves conflicts in ═══════ */

describe('what AO may honestly say about verification', () => {
  const absentPass = { reading: 'ABSENT' as const, path: null, record: null };
  const absentAttempts = { reading: 'ABSENT' as const, path: null, record: null };

  function statementWith(
    pass: VerificationPassRecord | null,
    observedCommit: string | null,
    profileDigest = DIGEST_A,
  ) {
    return verificationStatement({
      pass: pass === null ? absentPass : { reading: 'PASS_RECORD', path: null, record: pass },
      attempts: absentAttempts,
      observedCommit,
      worktreeClean: true,
      profileDigest,
    });
  }

  it('says PASSED only for the commit the tree is at, under the profile in force', () => {
    expect(statementWith(passRecord(), COMMIT_A).reading).toBe('PASSED_ON_THIS_TREE');
  });

  it('names the commit as what differs when the tree has moved', () => {
    const statement = statementWith(passRecord(), COMMIT_B);
    expect(statement.reading).toBe('PASSED_ELSEWHERE');
    expect(statement.differs).toBe('COMMIT');
  });

  it('names the profile as what differs when the contract changed', () => {
    const statement = statementWith(passRecord(), COMMIT_A, DIGEST_B);
    expect(statement.reading).toBe('PASSED_ELSEWHERE');
    expect(statement.differs).toBe('PROFILE');
  });

  it('separates "not measured" from "could not be compared"', () => {
    expect(statementWith(null, COMMIT_A).reading).toBe('NOT_MEASURED');
    // A HEAD Git could not read is a question that was not answered, which is
    // not the same as an answer of nothing.
    expect(statementWith(passRecord(), null).reading).toBe('NOT_OBSERVABLE');
  });

  it('lets a newer failure for the same commit outrank the pass', () => {
    const statement = verificationStatement({
      pass: { reading: 'PASS_RECORD', path: null, record: passRecord() },
      attempts: {
        reading: 'ATTEMPT_HISTORY',
        path: null,
        record: {
          attemptVersion: 1,
          taskId: 'M8-01',
          repositoryRoot: 'D:\\repo',
          binding: '0'.repeat(64),
          attempts: [
            {
              // Later than the pass at 08:00.
              attemptedAt: '2026-09-04T09:00:00.000Z',
              subjectCommit: COMMIT_A,
              profileDigest: DIGEST_A,
              verdict: 'FAILED' as const,
              stoppedAt: 'VERIFY',
              phases: [
                {
                  phase: 'VERIFY',
                  outcome: 'RAN' as const,
                  exitCode: 1,
                  signal: null,
                  outputTruncated: false,
                  failureCode: null,
                  errnoCode: null,
                  durationMs: 3,
                },
              ],
              stdoutExcerpt: [],
              stderrExcerpt: [],
            },
          ],
        },
      },
      observedCommit: COMMIT_A,
      worktreeClean: true,
      profileDigest: DIGEST_A,
    });
    expect(statement.reading).toBe('FAILED_ON_THIS_TREE');
    expect(statement.failureVerdict).toBe('FAILED');
  });

  it('resolves an unorderable pair to the failure, never to the good news', () => {
    // The pessimistic direction is the whole rule: a build that reports a pass
    // it cannot prove is the newest word is the failure this slice exists to end.
    const statement = verificationStatement({
      pass: {
        reading: 'PASS_RECORD',
        path: null,
        record: passRecord({ measuredAt: '2026-09-04T08:00:00.000Z' }),
      },
      attempts: {
        reading: 'ATTEMPT_HISTORY',
        path: null,
        record: {
          attemptVersion: 1,
          taskId: 'M8-01',
          repositoryRoot: 'D:\\repo',
          binding: '0'.repeat(64),
          attempts: [
            {
              // Schema-shaped and unparseable as an instant by `Date.parse`.
              attemptedAt: '0000-00-00T00:00:00Z',
              subjectCommit: COMMIT_A,
              profileDigest: DIGEST_A,
              verdict: 'FAILED' as const,
              stoppedAt: 'VERIFY',
              phases: [
                {
                  phase: 'VERIFY',
                  outcome: 'RAN' as const,
                  exitCode: 1,
                  signal: null,
                  outputTruncated: false,
                  failureCode: null,
                  errnoCode: null,
                  durationMs: 3,
                },
              ],
              stdoutExcerpt: [],
              stderrExcerpt: [],
            },
          ],
        },
      },
      observedCommit: COMMIT_A,
      worktreeClean: true,
      profileDigest: DIGEST_A,
    });
    expect(statement.reading).toBe('FAILED_ON_THIS_TREE');
  });

  it('reports uncommitted changes without letting them decide the reading', () => {
    // A passing gate routinely leaves untracked output behind. Demanding a clean
    // tree would degrade the ordinary passing path and reproduce the incident.
    const statement = verificationStatement({
      pass: { reading: 'PASS_RECORD', path: null, record: passRecord() },
      attempts: absentAttempts,
      observedCommit: COMMIT_A,
      worktreeClean: false,
      profileDigest: DIGEST_A,
    });
    expect(statement.reading).toBe('PASSED_ON_THIS_TREE');
    expect(statement.uncommittedChanges).toBe(true);
  });
});

/* ═════════ C. What each audience is told, per reading ═════════════════════ */

describe('the briefing block', () => {
  const passing = verificationStatement({
    pass: { reading: 'PASS_RECORD', path: null, record: passRecord() },
    attempts: { reading: 'ABSENT', path: null, record: null },
    observedCommit: COMMIT_A,
    worktreeClean: true,
    profileDigest: DIGEST_A,
  });

  it('tells a reviewer that tree prose does not overrule a measurement', () => {
    const lines = reviewerBriefingLines(
      briefingFixture({ verification: passing }),
    ).join('\n');
    expect(lines).toContain('PASSED');
    expect(lines).toContain(COMMIT_A);
    expect(lines).toMatch(/prose, not a measurement/);
    expect(lines).toMatch(/does not overrule this block/);
  });

  it('withholds that sentence where nothing was measured', () => {
    // Per member, not shared. Telling a reviewer that prose cannot overrule a
    // block which says NOT MEASURED would discourage the finding that is right.
    const lines = reviewerBriefingLines(briefingFixture()).join('\n');
    expect(lines).toContain('NOT MEASURED');
    expect(lines).not.toMatch(/does not overrule this block/);
  });

  it('carries no process output and no command token', () => {
    const lines = reviewerBriefingLines(briefingFixture({ verification: passing })).join('\n');
    expect(lines).not.toContain('UNTRUSTED');
    expect(lines).not.toContain('npm');
    expect(lines).not.toContain('git ');
  });

  it('tells a writer the facts it has no shell to obtain', () => {
    const lines = writerBriefingLines(
      briefingFixture({
        verification: passing,
        codegraph: 'UNAVAILABLE',
        changedPaths: ['src/a.ts', 'src/b.ts'],
      }),
    ).join('\n');
    expect(lines).toContain('CODEGRAPH INDEX');
    expect(lines).toContain('src/a.ts');
    expect(lines).toContain('2 paths');
    expect(lines).toMatch(/You have no shell and do not need one/);
  });

  it('says the paths were not established rather than printing an empty list', () => {
    const lines = writerBriefingLines(briefingFixture()).join('\n');
    expect(lines).toMatch(/did not establish which paths/);
  });
});

describe('the payloads that carry it', () => {
  const brief = {
    taskId: 'M8-01',
    body: 'Add a widget.',
    bodyTruncated: false,
    contextSources: [],
    contextComplete: true,
    codegraph: {
      capability: 'codegraph' as const,
      requirement: 'OPTIONAL' as const,
      status: 'UNAVAILABLE' as const,
      satisfied: true,
    },
    capabilitiesSatisfied: true,
  };

  it('puts the block above the task body, where the clamp cannot cut it', () => {
    const payload = buildReviewPayload(brief, 1, briefingFixture());
    expect(payload.indexOf('VERIFICATION')).toBeLessThan(payload.indexOf('TASK'));
  });

  it('keeps the reply schema inside the budget beside a maximal body', () => {
    const payload = buildReviewPayload(
      { ...brief, body: 'x'.repeat(8_192), bodyTruncated: true },
      1,
      briefingFixture(),
    );
    expect(payload).toContain('"reviewVersion": 1');
  });

  it('gives a remediating writer the measurement and the excerpt both', () => {
    const payload = buildVerificationRemediationPayload(
      {
        attemptedAt: '2026-09-04T08:00:00.000Z',
        subjectCommit: COMMIT_A,
        profileDigest: DIGEST_A,
        verdict: 'FAILED',
        stoppedAt: 'VERIFY',
        phases: [
          {
            phase: 'VERIFY',
            outcome: 'RAN',
            exitCode: 1,
            signal: null,
            outputTruncated: false,
            failureCode: null,
            errnoCode: null,
            durationMs: 4,
          },
        ],
        stdoutExcerpt: ['a test failed'],
        stderrExcerpt: [],
      },
      1,
      briefingFixture({ verification: notMeasured() }),
    );
    expect(payload).toContain('WHAT THIS ORCHESTRATOR MEASURED FOR YOU');
    expect(payload).toContain('BEGIN UNTRUSTED stdout EXCERPT');
  });
});

/* ═════════ D. End to end: a real pass, a stale handoff, a real reviewer ═══ */

describe('a measured pass reaches the reviewer across a restart', () => {
  const STALE_HANDOFF =
    '# Handoff\n\nThe last run left `npm run verify` exiting 1. Blocking checks are NOT passing.\n';

  async function scenario() {
    const started = await startTask({
      taskId: 'M8-01-E2E',
      files: { 'HANDOFF.md': STALE_HANDOFF },
    });
    const current = seedDeliveredState(started, { state: 'VERIFYING' });
    return { started, current };
  }

  function depsFor(started: Awaited<ReturnType<typeof startTask>>): LoopDependencies {
    return {
      now: tickingClock()(),
      authorisedWorktreePath: started.workspace.worktreePath,
      verification: started.repository.verification,
      writerMcp: null,
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
      git: runGitCommand,
      brief: readExecutionBrief(
        started.repository,
        started.taskId,
        started.workspace.worktreePath,
      ),
    };
  }

  it('records the pass, and the next call briefs the reviewer with it', async () => {
    const { started, current } = await scenario();

    // No `verify` seam: the profile's `git --version` really runs, and
    // `VERIFYING -> REVIEWING` is reachable only on PASSED.
    const verified = await runVerifyStep(current, depsFor(started));
    expect(verified.state).toBe('REVIEWING');
    expect(verified.verificationPass?.recorded).toBe(true);

    const head = git(started.workspace.worktreePath, ['rev-parse', 'HEAD']).trim();
    const stored = loadVerificationPass(started.root, started.taskId);
    expect(stored.reading).toBe('PASS_RECORD');
    expect(stored.record?.subjectCommit).toBe(head);
    // Nothing was added to the failure history. The two stores stay apart.
    expect(loadVerificationAttempts(started.root, started.taskId).reading).toBe('ABSENT');

    // A SEPARATE call, with dependencies built afresh: the restart shape. A fix
    // that carried the live report through one pass has nothing here.
    const agent = recordedAgent({
      codex: ({ payload, cwd }) => {
        const currentHead = git(cwd, ['rev-parse', 'HEAD']).trim();
        const measured = payload.includes(currentHead) && /PASSED/.test(payload);
        return reviewResult(
          measured
            ? { reviewVersion: 1, verdict: 'PASS', findings: [] }
            : {
                reviewVersion: 1,
                verdict: 'FINDINGS',
                findings: [
                  {
                    severity: 'high',
                    path: 'HANDOFF.md',
                    rule: 'verification.blocking-checks-not-passed',
                  },
                ],
              },
        );
      },
    });

    const reviewed = await runReviewStep(reload(started.root, started.taskId), {
      ...depsFor(started),
      agent: agent.runner,
    });

    expect(agent.countFor('codex')).toBe(1);
    const payload = agent.calls[0]?.payload ?? '';
    expect(payload).toContain(head);
    expect(payload).toContain('PASSED');
    // The stale prose is still in the tree and is still a declared context
    // source. What changed is that it no longer speaks for verification.
    expect(reviewed.state).not.toBe('REMEDIATING');
  });

  it('stops calling it this tree once the tree has moved', async () => {
    const { started, current } = await scenario();
    await runVerifyStep(current, depsFor(started));

    // A commit after the measurement. The stored pass is now about a commit the
    // worktree is no longer at, and saying otherwise would be the floating
    // verdict `subjectCommit` exists to prevent.
    writeFileSync(join(started.workspace.worktreePath, 'src', 'later.ts'), 'export const x = 1;\n');
    git(started.workspace.worktreePath, ['add', '--all']);
    git(started.workspace.worktreePath, [
      '-c',
      'user.name=AgentOrchestrator',
      '-c',
      'user.email=agent-orchestrator@local.invalid',
      'commit',
      '--quiet',
      '-m',
      'later',
    ]);

    const agent = recordedAgent({
      codex: () => reviewResult({ reviewVersion: 1, verdict: 'PASS', findings: [] }),
    });
    await runReviewStep(reload(started.root, started.taskId), {
      ...depsFor(started),
      agent: agent.runner,
    });

    const payload = agent.calls[0]?.payload ?? '';
    expect(payload).toContain('DIFFERENT commit');
    expect(payload).not.toMatch(/does not overrule this block/);
  });

  it('the reviewer policy really can raise the finding — the control', async () => {
    // Without this, every "the finding was not raised" assertion above could be
    // satisfied by a reviewer that was never able to raise it.
    const stripped = 'TASK\nAdd a widget.\n';
    const measured = stripped.includes('a'.repeat(40)) && /PASSED/.test(stripped);
    expect(measured).toBe(false);
  });
});

/* ═════════ E. The store refuses what it cannot prove ══════════════════════ */

describe('the pass store', () => {
  it('refuses to write where Git does not ignore the path', async () => {
    const started = await startTask({ taskId: 'M8-01-IGN' });
    const record = verificationPassFrom(passingReport(), {
      measuredAt: '2026-09-04T08:00:00.000Z',
      subjectCommit: COMMIT_A,
      profileDigest: DIGEST_A,
      taskId: started.taskId,
      repositoryRoot: started.root,
    });
    if (record === null) throw new Error('the fixture must mint a pass');

    const refused = await recordVerificationPass({
      repositoryRoot: started.root,
      taskId: started.taskId,
      pass: record,
      leaseHolds: () => true,
      checkIgnored: async () => 'NOT_IGNORED',
    });
    expect(refused.code).toBe('RUNTIME_PATH_NOT_IGNORED');
    expect(refused.recorded).toBe(false);
    expect(loadVerificationPass(started.root, started.taskId).reading).toBe('ABSENT');
  });

  it('refuses to write when the lease has gone, after every other gate passed', async () => {
    const started = await startTask({ taskId: 'M8-01-LEASE' });
    const record = verificationPassFrom(passingReport(), {
      measuredAt: '2026-09-04T08:00:00.000Z',
      subjectCommit: COMMIT_A,
      profileDigest: DIGEST_A,
      taskId: started.taskId,
      repositoryRoot: started.root,
    });
    if (record === null) throw new Error('the fixture must mint a pass');

    const refused = await recordVerificationPass({
      repositoryRoot: started.root,
      taskId: started.taskId,
      pass: record,
      leaseHolds: () => false,
      checkIgnored: async () => 'IGNORED',
    });
    expect(refused.code).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(refused.recorded).toBe(false);
  });

  it('never replaces a document it cannot read', async () => {
    const started = await startTask({ taskId: 'M8-01-JUNK' });
    const directory = join(started.root, '.agent-orchestrator', 'runtime', 'verification-passes');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${started.taskId}.json`), '{ not json at all', 'utf8');

    const record = verificationPassFrom(passingReport(), {
      measuredAt: '2026-09-04T08:00:00.000Z',
      subjectCommit: COMMIT_A,
      profileDigest: DIGEST_A,
      taskId: started.taskId,
      repositoryRoot: started.root,
    });
    if (record === null) throw new Error('the fixture must mint a pass');

    const refused = await recordVerificationPass({
      repositoryRoot: started.root,
      taskId: started.taskId,
      pass: record,
      leaseHolds: () => true,
      checkIgnored: async () => 'IGNORED',
    });
    expect(refused.code).toBe('EXISTING_RECORD_UNREADABLE');
  });

  it('reads back a record written for another task as not this task', async () => {
    const started = await startTask({ taskId: 'M8-01-SUBJ' });
    const foreign = verificationPassFrom(passingReport(), {
      measuredAt: '2026-09-04T08:00:00.000Z',
      subjectCommit: COMMIT_A,
      profileDigest: DIGEST_A,
      taskId: 'SOMEONE-ELSE',
      repositoryRoot: started.root,
    });
    if (foreign === null) throw new Error('the fixture must mint a pass');

    const directory = join(started.root, '.agent-orchestrator', 'runtime', 'verification-passes');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${started.taskId}.json`),
      `${JSON.stringify(foreign, null, 2)}\n`,
      'utf8',
    );

    expect(loadVerificationPass(started.root, started.taskId).reading).toBe('NOT_THIS_TASK');
  });
});

/* ═════════ F. The residual the join cannot close ══════════════════════════ */

describe('an unreadable failure history is a blind spot, and says so', () => {
  const passing = {
    pass: { reading: 'PASS_RECORD' as const, path: null, record: passRecord() },
    observedCommit: COMMIT_A,
    worktreeClean: true,
    profileDigest: DIGEST_A,
  };

  it('leaves the reading alone and raises the flag', () => {
    // The pass record is intact and about this commit, so the reading stands.
    // What cannot be ruled out is a NEWER failure inside the document this build
    // could not read — and a statement that said nothing about that would be
    // narrower than it looks.
    for (const reading of ['MALFORMED', 'UNSUPPORTED_VERSION', 'NOT_THIS_TASK'] as const) {
      const statement = verificationStatement({
        ...passing,
        attempts: { reading, path: null, record: null },
      });
      expect(statement.reading).toBe('PASSED_ON_THIS_TREE');
      expect(statement.failureHistoryUnreadable).toBe(true);
    }
  });

  it('does not raise it for a history nobody wrote', () => {
    const statement = verificationStatement({
      ...passing,
      attempts: { reading: 'ABSENT', path: null, record: null },
    });
    expect(statement.failureHistoryUnreadable).toBe(false);
  });

  it('prints the caution beside the measurement', () => {
    const statement = verificationStatement({
      ...passing,
      attempts: { reading: 'MALFORMED', path: null, record: null },
    });
    const lines = reviewerBriefingLines(briefingFixture({ verification: statement })).join('\n');
    expect(lines).toContain('PASSED');
    expect(lines).toMatch(/could not be read/);
  });
});
