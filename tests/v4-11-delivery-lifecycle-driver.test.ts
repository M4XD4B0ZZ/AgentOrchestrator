/**
 * V4 slice 11 — the delivery lifecycle driver.
 *
 * The suite is written against the three ways an orchestrator over irreversible
 * acts goes wrong:
 *
 *  1. **doing more than one thing behind one authorisation.** The flag surface
 *     has permitted publish-create-merge behind a single `--attended` since
 *     slice 7. A driver that inherited that would decide a merge from an
 *     observation taken before its own pull request existed. The rule that
 *     stops it — *stop at the first act that reports an attempt* — is driven
 *     with all three flags on a first delivery and the two later acts are
 *     counted at zero;
 *  2. **inventing authority.** Every act still needs its own flag and
 *     `--attended`. A drive given none of them is measured to send nothing
 *     through any of the three mutation seams;
 *  3. **treating a stop as a failure, or a failure as a stop.** The driver's
 *     vocabulary separates a code verdict from a machine that could not answer,
 *     an external condition from a tool defect, and an unauthorised act from a
 *     refused one. Each is driven and its exit code pinned against a
 *     hand-written table that is deliberately not derived from the production
 *     one.
 */

import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DELIVERY_DRIVES,
  DELIVERY_DRIVE_DETAIL,
  DELIVERY_EFFECTS,
  DELIVERY_EFFECT_FLAG,
  refuseDeliveryDrive,
  type DeliveryDrive,
} from '../src/cli/delivery-driver.js';
import {
  DRIVE_OPTION_DESCRIPTION,
  registerDeliveryCommand,
} from '../src/cli/delivery-command.js';
import { DRIVE_TRAILER } from '../src/cli/render-delivery-observation.js';
import {
  exitCodeForDrive,
  exitCodeWithLeaseRelease,
  EXIT_RUN_CALL_AGAIN,
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
} from '../src/cli/run-exit-codes.js';
import {
  MERGE_RECONCILIATION_VERSION,
  mergeReconciliationBinding,
  type MergeReconciliationPayload,
} from '../src/deliver/merge-reconciliation.js';
import {
  mergeReconciliationDirectory,
  receiptIsOnDisk,
  type MergeReconciliationRecordCode,
} from '../src/deliver/merge-reconciliation-store.js';
import {
  POST_MERGE_VERIFICATION_VERSION,
  postMergeVerificationBinding,
  type PostMergeVerificationPayload,
  type VerificationAttempt,
} from '../src/deliver/post-merge-verification.js';
import { postMergeVerificationDirectory } from '../src/deliver/post-merge-verification-store.js';
import {
  DELIVERY_CONCLUSION_VERSION,
  deliveryConclusionBinding,
  type DeliveryConclusionPayload,
} from '../src/deliver/delivery-conclusion.js';
import { deliveryConclusionDirectory } from '../src/deliver/delivery-conclusion-store.js';
import { verificationProfileDigest } from '../src/verify/verification-profile.js';
import type { ResolvedVerificationPolicy } from '../src/repo/resolve-repository.js';
import type { ForgeCommandRunner } from '../src/deliver/github-observer.js';
import type { GitPublicationRunner } from '../src/deliver/git-head-publisher.js';
import { saveTaskState } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { TERMINAL_STATES } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
} from '../src/lease/execution-lease.js';

/* ─────────────────────────────── fixtures ───────────────────────────────── */

const TASK = 'V4-11';
/** H — the implementation head. */
const HEAD = 'a'.repeat(40);
/** M — the merge commit a delivery of H produced. */
const MERGE = 'b'.repeat(40);
/** Neither H nor M. */
const OTHER = 'd'.repeat(40);
const PR = 65;
const AT = '2026-08-26T07:13:56Z';
const LATER = '2026-08-26T09:13:56.000Z';
const IDENTITY = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});
const BASE = 'main';
const BRANCH = 'ao/task/V4-11';

const PROFILE: ResolvedVerificationPolicy = Object.freeze({
  phases: Object.freeze([
    Object.freeze({ phase: 'VERIFY' as const, command: Object.freeze(['npm', 'run', 'verify']) }),
  ]),
});
const DIGEST = verificationProfileDigest(PROFILE);

const OTHER_PROFILE: ResolvedVerificationPolicy = Object.freeze({
  phases: Object.freeze([
    Object.freeze({ phase: 'BUILD' as const, command: Object.freeze(['npm', 'run', 'build']) }),
  ]),
});

const DECLARED = Object.freeze({
  declared: true,
  remoteName: 'origin',
  result: Object.freeze({
    outcome: 'RESOLVED',
    target: Object.freeze({ provider: 'github', ...IDENTITY }),
  }),
});

function scratchRoot(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}${r.stdout ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

/**
 * One repository, built once and copied per fixture.
 *
 * Real Git, because the execution lease this suite exercises is keyed on the
 * repository's own Git identity and a stubbed one would make the lease cases
 * measure the stub. A plain repository's `.git` holds no absolute paths, so a
 * copy is a working repository — the same argument slice 10's file records,
 * and the reason this file does not run `git init` per case.
 */
let template: { path: string; gitCommonDir: string; mergeCommit: string } | null = null;

function repositoryTemplate(): { path: string; gitCommonDir: string; mergeCommit: string } {
  if (template !== null) return template;
  const path = scratchRoot('ao-v411-template-');
  git(path, 'init', '--quiet', '-b', BASE, '.');
  git(path, 'config', 'user.email', 'fixture@example.invalid');
  git(path, 'config', 'user.name', 'Fixture');
  writeFileSync(join(path, 'a.txt'), 'a\n', 'utf8');
  git(path, 'add', 'a.txt');
  git(path, 'commit', '--quiet', '-m', 'base');
  // A real merge, so the cases that reach the gate detach a real workspace at a
  // real object. A stub cannot stand in for this: the workspace proof reads the
  // checkout Git made, and a proof a fixture could satisfy would measure the
  // fixture. Driven and measured — the stubbed version of these four cases
  // answered `WORKSPACE_NOT_AS_REQUESTED` and never reached the gate at all.
  git(path, 'checkout', '--quiet', '-b', 'side');
  writeFileSync(join(path, 'b.txt'), 'b\n', 'utf8');
  git(path, 'add', 'b.txt');
  git(path, 'commit', '--quiet', '-m', 'side');
  git(path, 'checkout', '--quiet', BASE);
  git(path, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'side');
  template = {
    path,
    gitCommonDir: git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    mergeCommit: git(path, 'rev-parse', 'HEAD'),
  };
  return template;
}

interface Fixture {
  readonly root: string;
  readonly gitCommonDir: string;
  /** The real merge object M this repository holds. */
  readonly mergeCommit: string;
  readonly dispose: () => void;
}

function fixture(): Fixture {
  const t = repositoryTemplate();
  const root = scratchRoot('ao-v411-');
  cpSync(t.path, root, { recursive: true });
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  return {
    root,
    gitCommonDir: git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    mergeCommit: t.mergeCommit,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function taskStateFor(root: string, over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK,
    repositoryId: 'fixture-repo',
    repositoryRoot: root,
    worktreePath: root,
    state: 'READY_FOR_PR',
    stateEnteredAt: AT,
    baseBranch: BASE,
    basePinnedCommit: OTHER,
    scopeAuthorityCommit: null,
    workBranch: BRANCH,
    currentCommit: HEAD,
    reviewRound: 1,
    maxReviewRounds: 3,
    blockedAgent: null,
    resumeFrom: null,
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: true,
    findingHistory: [],
    ...over,
  };
}

/* ── the three durable records, written directly ─────────────────────────── */

function receiptPayload(
  root: string,
  over: Partial<MergeReconciliationPayload> = {},
): MergeReconciliationPayload {
  return {
    reconciliationVersion: MERGE_RECONCILIATION_VERSION,
    taskId: TASK,
    repositoryRoot: root,
    subjectCommit: HEAD,
    provider: 'github',
    host: IDENTITY.host,
    owner: IDENTITY.owner,
    name: IDENTITY.name,
    pullRequestNumber: PR,
    mergedHeadSha: HEAD,
    baseRef: BASE,
    mergeCommit: MERGE,
    observedAt: AT,
    reconciledAt: AT,
    ...over,
  };
}

function receiptPath(root: string): string {
  return join(mergeReconciliationDirectory(root), `${TASK}.json`);
}

function writeReceipt(root: string, over: Partial<MergeReconciliationPayload> = {}): void {
  const payload = receiptPayload(root, over);
  mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
  writeFileSync(
    receiptPath(root),
    `${JSON.stringify(
      {
        ...payload,
        binding: mergeReconciliationBinding({ taskId: TASK, repositoryRoot: root }, payload),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function attemptOf(over: Partial<VerificationAttempt> = {}): VerificationAttempt {
  return {
    attemptedAt: AT,
    profileDigest: DIGEST,
    outcome: 'VERIFIED_PASS',
    stoppedAt: null,
    exitCode: null,
    signal: null,
    phasesRun: 1,
    ...over,
  };
}

function nonPass(
  outcome: 'VERIFIED_FAIL' | 'VERIFICATION_NOT_ESTABLISHED',
  over: Partial<VerificationAttempt> = {},
): VerificationAttempt {
  return attemptOf({
    outcome,
    stoppedAt: 'VERIFY',
    exitCode: outcome === 'VERIFIED_FAIL' ? 1 : null,
    ...over,
  });
}

function verificationPath(root: string): string {
  return join(postMergeVerificationDirectory(root), `${TASK}.json`);
}

function writeVerification(
  root: string,
  over: Partial<PostMergeVerificationPayload> = {},
): void {
  const payload: PostMergeVerificationPayload = {
    verificationVersion: POST_MERGE_VERIFICATION_VERSION,
    taskId: TASK,
    repositoryRoot: root,
    subjectCommit: HEAD,
    mergeCommit: MERGE,
    provider: 'github',
    host: IDENTITY.host,
    owner: IDENTITY.owner,
    name: IDENTITY.name,
    pullRequestNumber: PR,
    attempts: [attemptOf()],
    ...over,
  };
  mkdirSync(postMergeVerificationDirectory(root), { recursive: true });
  writeFileSync(
    verificationPath(root),
    `${JSON.stringify(
      {
        ...payload,
        binding: postMergeVerificationBinding({ taskId: TASK, repositoryRoot: root }, payload),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function conclusionPath(root: string): string {
  return join(deliveryConclusionDirectory(root), `${TASK}.json`);
}

function writeConclusion(root: string, over: Partial<DeliveryConclusionPayload> = {}): void {
  const payload: DeliveryConclusionPayload = {
    conclusionVersion: DELIVERY_CONCLUSION_VERSION,
    taskId: TASK,
    repositoryRoot: root,
    subjectCommit: HEAD,
    mergeCommit: MERGE,
    provider: 'github',
    host: IDENTITY.host,
    owner: IDENTITY.owner,
    name: IDENTITY.name,
    pullRequestNumber: PR,
    baseRef: BASE,
    profileDigest: DIGEST,
    verifiedAt: AT,
    receiptBinding: 'e'.repeat(64),
    verificationBinding: 'f'.repeat(64),
    concludedAt: AT,
    ...over,
  };
  mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
  writeFileSync(
    conclusionPath(root),
    `${JSON.stringify(
      {
        ...payload,
        binding: deliveryConclusionBinding({ taskId: TASK, repositoryRoot: root }, payload),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/* ── the forge, as a counted stub ────────────────────────────────────────── */

function commandResult(over: Record<string, unknown> = {}) {
  return {
    display: 'gh',
    executable: 'gh',
    args: [],
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    failureCode: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    timedOut: false,
    ...over,
  } as never;
}

interface Forge {
  /** What `commits/{sha}/pulls` answers. */
  readonly atHead?: readonly Record<string, unknown>[];
  /** What `pulls/{n}` answers, in order, one per read. */
  readonly byNumber?: readonly (Record<string, unknown> | null)[];
  /** The conclusion every check run reports. */
  readonly checks?: 'success' | 'failure' | 'pending' | 'none';
  /** Make every request fail, so nothing settles. */
  readonly unreadable?: boolean;
  /** What the locator answers, one entry per asking module, in order. */
  readonly atHeadByAsking?: readonly (readonly Record<string, unknown>[])[];
  /** Fail every read-by-number taken after this many locator reads. */
  readonly byNumberFailsAfterLocator?: number;
}

function openPull(over: Record<string, unknown> = {}) {
  return {
    number: PR,
    state: 'open',
    draft: false,
    merged: false,
    merge_commit_sha: null,
    head: { sha: HEAD },
    base: { ref: BASE },
    ...over,
  };
}

function mergedPull(over: Record<string, unknown> = {}) {
  return openPull({
    state: 'closed',
    merged: true,
    merge_commit_sha: MERGE,
    ...over,
  });
}

interface Counts {
  forge: number;
  publish: number;
  create: number;
  merge: number;
  verify: number;
}

interface Run {
  readonly out: string;
  readonly exitCode: number | undefined;
  readonly counts: Counts;
}

/**
 * Drives the real CLI, with every vector counted.
 *
 * The task-state reader is the **real** one. The conclusion store compares a
 * revision read at the write against the one the subject was resolved from, and
 * a stub would answer the same value both times — the shape of a check that
 * always passes.
 */
async function drive(
  argv: readonly string[],
  repo: Fixture,
  over: {
    readonly forge?: Forge;
    readonly profile?: ResolvedVerificationPolicy;
    readonly delivery?: unknown;
    readonly taskState?: unknown;
    readonly gitPresent?: boolean;
    readonly remoteRef?: 'absent' | 'at-head' | 'other';
    /** The push completes and the ref is still absent afterwards. */
    readonly publicationLeavesRefAbsent?: boolean;
    /** The remote cannot be read at all, so nothing about the head settles. */
    readonly remoteUnreadable?: boolean;
    /** The remote fetches from one URL and pushes to another. */
    readonly remoteUrlsDiverge?: boolean;
    /** What Git answers about the runtime path, which decides every write. */
    readonly ignored?: 'IGNORED' | 'NOT_IGNORED' | 'UNDETERMINED';
    /**
     * Answer Git as a repository that holds M and can detach a workspace at
     * it, so the gate itself is reached and its verdict is the seam's.
     */
    readonly workspaceAtMerge?: boolean;
    /** What the gate command comes to when it is reached. */
    readonly gate?: 'RAN_PASS' | 'RAN_FAIL' | 'UNAVAILABLE';
  } = {},
): Promise<Run> {
  const forge = over.forge ?? {};
  const counts: Counts = { forge: 0, publish: 0, create: 0, merge: 0, verify: 0 };
  let byNumberReads = 0;
  let locatorReads = 0;
  let remoteRef: 'absent' | 'at-head' | 'other' = over.remoteRef ?? 'absent';
  const chunks: string[] = [];
  const outer = process.exitCode;
  process.exitCode = undefined;
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });

  const reader: ForgeCommandRunner = async (_command, args) => {
    counts.forge += 1;
    if (forge.unreadable === true) return commandResult({ exitCode: 1 });
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (/\/pulls\/\d+$/.test(path)) {
      // A read by number taken after the reconciliation has had its answer.
      // The merge ladder's pre-reading is the only one that qualifies, so this
      // is how a case reaches "the forge could not be read at the merge"
      // without the merge having been attempted.
      if (forge.byNumberFailsAfterLocator !== undefined && locatorReads > forge.byNumberFailsAfterLocator) {
        return commandResult({ exitCode: 1, stdout: '{}' });
      }
      const page = (forge.byNumber ?? [openPull()])[
        Math.min(byNumberReads, (forge.byNumber ?? [openPull()]).length - 1)
      ];
      byNumberReads += 1;
      if (page === null || page === undefined) return commandResult({ exitCode: 1, stdout: '{}' });
      return commandResult({ stdout: JSON.stringify(page) });
    }
    if (path.endsWith('/pulls')) {
      locatorReads += 1;
      // The locator is asked by three different modules in one drive — the
      // reconciliation, the observation and the creation — and a case that
      // needs them to see different worlds says so by ordinal. Anything past
      // the list repeats its last entry.
      const pages = forge.atHeadByAsking;
      if (pages !== undefined) {
        const page = pages[Math.min(locatorReads - 1, pages.length - 1)] ?? [];
        return commandResult({ stdout: JSON.stringify(page) });
      }
      return commandResult({ stdout: JSON.stringify(forge.atHead ?? []) });
    }
    if (path.endsWith('/check-runs')) {
      const checks = forge.checks ?? 'success';
      if (checks === 'none') {
        return commandResult({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) });
      }
      return commandResult({
        stdout: JSON.stringify({
          total_count: 1,
          check_runs: [
            checks === 'pending'
              ? { head_sha: HEAD, status: 'in_progress', conclusion: null }
              : { head_sha: HEAD, status: 'completed', conclusion: checks },
          ],
        }),
      });
    }
    return commandResult({
      stdout: JSON.stringify({ sha: HEAD, state: 'success', total_count: 0, statuses: [] }),
    });
  };

  try {
    const program = new Command();
    program.exitOverride();
    registerDeliveryCommand(program, {
      resolveRepository: async () =>
        ({
          ok: true,
          repository: {
            id: 'fixture-repo',
            root: repo.root,
            gitCommonDir: repo.gitCommonDir,
            verification: over.profile ?? PROFILE,
            delivery: over.delivery ?? DECLARED,
          },
        }) as never,
      ...(over.taskState === undefined ? {} : { loadTaskState: over.taskState as never }),
      runner: reader,
      publicationRunner: (async (args: readonly string[]) => {
        const joined = args.join(' ');
        // The two local questions: which URLs this remote carries. Answered
        // with one URL for both, so they agree.
        if (joined.includes('remote get-url')) {
          // Two questions, both local, both answered. Under this knob they
          // answer differently, which is `REMOTE_URLS_DIVERGE` — and the point
          // of the case is that nothing was asked of github.com to learn it.
          const url =
            over.remoteUrlsDiverge === true && joined.includes('--push')
              ? 'https://github.com/someone-else/AgentOrchestrator.git'
              : 'https://github.com/M4XD4B0ZZ/AgentOrchestrator.git';
          return commandResult({ stdout: url });
        }
        // The remote reading, before and after. `--exit-code` turns absence
        // into status 2, which is the distinction the act is built on.
        if (joined.includes('ls-remote')) {
          if (over.remoteUnreadable === true) return commandResult({ exitCode: 128 });
          const ref = args[args.length - 1] ?? '';
          const at = remoteRef === 'absent' ? null : remoteRef === 'at-head' ? HEAD : OTHER;
          if (at === null) return commandResult({ exitCode: 2 });
          return commandResult({ stdout: `${at}	${ref}` });
        }
        // The one write vector.
        counts.publish += 1;
        if (over.publicationLeavesRefAbsent !== true) remoteRef = 'at-head';
        return commandResult();
      }) as unknown as GitPublicationRunner,
      creationRunner: (async () => {
        counts.create += 1;
        return commandResult({ stdout: JSON.stringify(openPull()) });
      }) as never,
      mergeRunner: (async () => {
        counts.merge += 1;
        return commandResult({ stdout: JSON.stringify({ sha: MERGE, merged: true }) });
      }) as never,
      verify: (async () => {
        counts.verify += 1;
        const gate = over.gate ?? 'RAN_PASS';
        const base = { signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        if (gate === 'UNAVAILABLE') {
          return { outcome: 'UNAVAILABLE', exitCode: null, ...base } as never;
        }
        return { outcome: 'RAN', exitCode: gate === 'RAN_PASS' ? 0 : 1, ...base } as never;
      }) as never,
      // The REAL Git runner for a case that reaches the gate. A stub cannot
      // satisfy the workspace proof — it reads the checkout Git actually made —
      // so a case a stub could satisfy would be measuring the stub. Driven and
      // measured: the stubbed version answered `WORKSPACE_NOT_AS_REQUESTED`.
      //
      // Everywhere else the merge object is deliberately absent, which is how
      // the verification stage reaches a determinate refusal without paying for
      // a worktree in a case that is not about one.
      git:
        over.workspaceAtMerge === true
          ? runGitCommand
          : ((async () => ({ outcome: 'FAILED', stdout: '', stderr: 'not a commit' })) as never),
      envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
      checkIgnored: async () => (over.ignored ?? 'IGNORED') as never,
      now: () => new Date(LATER),
    });
    await program.parseAsync(
      ['node', 'agent-loop', 'delivery', '--repository', repo.root, '--task', TASK, ...argv],
      { from: 'node' },
    );
    return { out: chunks.join(''), exitCode: process.exitCode as number | undefined, counts };
  } finally {
    write.mockRestore();
    process.exitCode = outer;
  }
}

/** The `Drive :` line's outcome word, which is the driver's own member. */
function driven(run: Run): string {
  const m = /^Drive {8}: (\S+)$/m.exec(run.out);
  if (m === null) throw new Error(`no Drive line in report:\n${run.out}`);
  return m[1] as string;
}

function contactedForge(run: Run): boolean {
  return run.counts.forge > 0;
}

function mutated(run: Run): boolean {
  return run.counts.publish + run.counts.create + run.counts.merge > 0;
}

/* ── source-scan helpers ─────────────────────────────────────────────────── */

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DRIVER = 'src/cli/delivery-driver.ts';

/* ══════════════════════════ 1. the vocabulary ═══════════════════════════ */

describe('the driver vocabulary is closed, total and graded', () => {
  it('has no duplicate member', () => {
    expect(new Set(DELIVERY_DRIVES).size).toBe(DELIVERY_DRIVES.length);
    expect(DELIVERY_DRIVES.length).toBeGreaterThan(10);
  });

  it('gives every member a sentence, and no sentence a member it does not have', () => {
    for (const member of DELIVERY_DRIVES) {
      const detail = DELIVERY_DRIVE_DETAIL[member];
      expect(detail, member).toBeTypeOf('string');
      expect(detail.length, member).toBeGreaterThan(20);
    }
    expect(Object.keys(DELIVERY_DRIVE_DETAIL).sort()).toEqual([...DELIVERY_DRIVES].sort());
  });

  /**
   * The grades, hand-written here and deliberately not derived from the
   * production table.
   *
   * A test that mapped the same object twice would pass for any grading at all.
   * This is the second opinion: if the two disagree, one of them is wrong and
   * somebody has to say which.
   */
  const GRADES: Readonly<Record<DeliveryDrive, number>> = Object.freeze({
    DELIVERY_CONCLUDED: EXIT_RUN_OK,
    SUBJECT_NOT_ESTABLISHED: EXIT_RUN_INPUT_UNUSABLE,
    TASK_NOT_READY: EXIT_RUN_INPUT_UNUSABLE,
    DRIVE_NOT_COMBINABLE: EXIT_RUN_INPUT_UNUSABLE,
    DELIVERY_EVIDENCE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
    CONCLUSION_NOT_ATTESTED: EXIT_RUN_NEEDS_OPERATOR,
    VERIFICATION_FAILED: EXIT_RUN_NEEDS_OPERATOR,
    VERIFICATION_NOT_ESTABLISHED: EXIT_RUN_NEEDS_OPERATOR,
    PULL_REQUEST_AMBIGUOUS: EXIT_RUN_NEEDS_OPERATOR,
    CHECKS_ABSENT: EXIT_RUN_NEEDS_OPERATOR,
    CHECKS_FAILED: EXIT_RUN_NEEDS_OPERATOR,
    HUMAN_DECISION_REQUIRED: EXIT_RUN_NEEDS_OPERATOR,
    FORGE_STATE_UNKNOWN: EXIT_RUN_REFUSED,
    RECEIPT_NOT_DURABLE: EXIT_RUN_REFUSED,
    OBSERVATION_UNSETTLED: EXIT_RUN_REFUSED,
    SUBJECT_CHANGED: EXIT_RUN_REFUSED,
    PULL_REQUEST_REQUIRED: EXIT_RUN_REFUSED,
    CONCLUSION_NOT_DURABLE: EXIT_RUN_REFUSED,
    ATTENDED_AUTHORITY_REQUIRED: EXIT_RUN_REFUSED,
    EFFECT_ATTEMPTED: EXIT_RUN_CALL_AGAIN,
    CHECKS_PENDING: EXIT_RUN_CALL_AGAIN,
  });

  it('grades every member, against a table written by hand', () => {
    for (const member of DELIVERY_DRIVES) {
      expect(exitCodeForDrive(member), member).toBe(GRADES[member]);
    }
    expect(Object.keys(GRADES).sort()).toEqual([...DELIVERY_DRIVES].sort());
  });

  it('exits zero for exactly one member, and it is the terminal one', () => {
    const nominal = DELIVERY_DRIVES.filter((m) => exitCodeForDrive(m) === EXIT_RUN_OK);
    expect(nominal).toEqual(['DELIVERY_CONCLUDED']);
  });

  it('substitutes the conclusion store’s own grade for the one member that needs it', () => {
    // The floor, when no record came back at all.
    expect(exitCodeForDrive('CONCLUSION_NOT_DURABLE')).toBe(EXIT_RUN_REFUSED);
    // A benign race the store already grades 4.
    expect(exitCodeForDrive('CONCLUSION_NOT_DURABLE', { conclusion: 'EVIDENCE_MOVED' })).toBe(EXIT_RUN_REFUSED);
    // Durable state an operator has to look at, graded 3 by the same table.
    expect(exitCodeForDrive('CONCLUSION_NOT_DURABLE', { conclusion: 'WRITE_FAILED' })).toBe(
      EXIT_RUN_NEEDS_OPERATOR,
    );
    expect(exitCodeForDrive('CONCLUSION_NOT_DURABLE', { conclusion: 'CONFLICTING_CONCLUSION' })).toBe(
      EXIT_RUN_NEEDS_OPERATOR,
    );
    // The input situation is unusable and is fixed by editing the repository.
    expect(exitCodeForDrive('CONCLUSION_NOT_DURABLE', { conclusion: 'RUNTIME_PATH_NOT_IGNORED' })).toBe(
      EXIT_RUN_INPUT_UNUSABLE,
    );
    // And no other member consults it: a record code handed in beside a member
    // that has nothing to do with the store must change nothing.
    expect(exitCodeForDrive('CHECKS_PENDING', { conclusion: 'WRITE_FAILED' })).toBe(EXIT_RUN_CALL_AGAIN);
  });

  it('names an act and its flags for each of the three, and no others', () => {
    expect([...DELIVERY_EFFECTS].sort()).toEqual(
      ['CREATE_PULL_REQUEST', 'MERGE_PULL_REQUEST', 'PUBLISH_HEAD'].sort(),
    );
    for (const effect of DELIVERY_EFFECTS) {
      // Every act still names a grant, and `--attended` is still one for each.
      expect(DELIVERY_EFFECT_FLAG[effect], effect).toContain('--attended');
      // And every entry names its own act, so no report can send an operator to
      // the flag for a different one.
      expect(DELIVERY_EFFECT_FLAG[effect], effect).toContain(
        { PUBLISH_HEAD: '--publish-head', CREATE_PULL_REQUEST: '--create-pr', MERGE_PULL_REQUEST: '--merge-pr' }[effect],
      );
    }
    // Two grants for one act since V4 slice 13, and both are named. An operator
    // running unattended who is sent to `--attended` has been sent to a flag
    // their own invocation refuses.
    expect(DELIVERY_EFFECT_FLAG.PUBLISH_HEAD).toBe(
      '--publish-head --attended (or --publish-head --automatic-publish-head-only)',
    );
    expect(DELIVERY_EFFECT_FLAG.CREATE_PULL_REQUEST).toBe('--create-pr --attended');
    expect(DELIVERY_EFFECT_FLAG.MERGE_PULL_REQUEST).toBe('--merge-pr --attended');
  });

  it('builds a refusal in exactly one place, carrying no act', () => {
    for (const code of ['SUBJECT_NOT_ESTABLISHED', 'TASK_NOT_READY', 'DRIVE_NOT_COMBINABLE'] as const) {
      const r = refuseDeliveryDrive(code);
      expect(r.outcome).toBe(code);
      expect(r.requiredEffect).toBeNull();
      expect(r.conclusionOutcome).toBeNull();
      expect(r.observation).toBeNull();
      expect(r.publication).toBeNull();
      expect(r.creation).toBeNull();
      expect(r.merge).toBeNull();
      expect(r.reconciliation).toBeNull();
      expect(r.verification).toBeNull();
      expect(r.deliveryConclusion).toBeNull();
    }
  });
});

/* ══════════════════ 2. the subject, and the flags it refuses ═════════════ */

describe('the driver refuses before it derives anything', () => {
  it('refuses a task that has no durable record', async () => {
    const repo = fixture();
    try {
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('SUBJECT_NOT_ESTABLISHED');
      expect(r.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      expect(contactedForge(r)).toBe(false);
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('refuses a task that is not at READY_FOR_PR', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root, { state: 'IMPLEMENTING' }) as never, {
        repositoryRoot: repo.root,
      });
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('TASK_NOT_READY');
      expect(r.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      expect(contactedForge(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('refuses a repository that declares no delivery target', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive'], repo, {
        delivery: { declared: false, remoteName: null, result: null },
      });
      expect(driven(r)).toBe('SUBJECT_NOT_ESTABLISHED');
      expect(r.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      expect(contactedForge(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('refuses a target that could not be resolved', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive'], repo, {
        delivery: {
          declared: true,
          remoteName: 'origin',
          result: { outcome: 'REMOTE_URL_AMBIGUOUS', target: null },
        },
      });
      expect(driven(r)).toBe('SUBJECT_NOT_ESTABLISHED');
      expect(contactedForge(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  /**
   * The six flags `--drive` does not compose with, driven one at a time.
   *
   * As a table rather than as one representative case: a refusal written as a
   * chain of `||` is one arm away from being wrong about a flag nobody drove,
   * and this repository has already replaced a repeated wording round with a
   * table for the same reason.
   */
  const NOT_COMBINABLE = [
    '--observe',
    '--record',
    '--decide',
    '--reconcile-merge',
    '--verify-merge',
    '--conclude-delivery',
  ] as const;

  for (const flag of NOT_COMBINABLE) {
    it(`refuses --drive beside ${flag}, and touches nothing`, async () => {
      const repo = fixture();
      try {
        saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
        writeReceipt(repo.root);
        writeVerification(repo.root);
        const r = await drive(['--drive', flag], repo);
        expect(driven(r)).toBe('DRIVE_NOT_COMBINABLE');
        expect(r.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
        expect(contactedForge(r)).toBe(false);
        expect(mutated(r)).toBe(false);
        expect(r.counts.verify).toBe(0);
        // And nothing was concluded, though the evidence for it was on disk.
        expect(() => statSync(conclusionPath(repo.root))).toThrow();
      } finally {
        repo.dispose();
      }
    });
  }

  it('accepts --drive beside the three act flags', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeConclusion(repo.root);
      const r = await drive(
        ['--drive', '--publish-head', '--create-pr', '--merge-pr', '--attended'],
        repo,
      );
      expect(driven(r)).toBe('DELIVERY_CONCLUDED');
    } finally {
      repo.dispose();
    }
  });
});

/* ═══════════════ 3. a concluded delivery is terminal, and free ═══════════ */

describe('a conclusion already on disk ends the driver', () => {
  it('answers DELIVERY_CONCLUDED and exits zero', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeConclusion(repo.root);
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('DELIVERY_CONCLUDED');
      expect(r.exitCode).toBe(EXIT_RUN_OK);
      expect(r.out).toContain('Completion   : ALREADY_CONCLUDED');
    } finally {
      repo.dispose();
    }
  });

  it('contacts github.com not at all', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeConclusion(repo.root);
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo);
      expect(driven(r)).toBe('DELIVERY_CONCLUDED');
      expect(contactedForge(r)).toBe(false);
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('runs no verification and takes no execution lease', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeConclusion(repo.root);
      // The lease is held by somebody else for the whole invocation. A driver
      // that tried to verify would have to acquire it and would be refused, so
      // the run completing nominally is the measurement.
      const held = acquireRepositoryExecutionLease(
        { id: 'fixture-repo', root: repo.root, gitCommonDir: repo.gitCommonDir } as never,
        { runId: null, blockId: null },
        { now: () => LATER },
      );
      expect(held.ok).toBe(true);
      try {
        const r = await drive(['--drive'], repo);
        expect(driven(r)).toBe('DELIVERY_CONCLUDED');
        expect(r.exitCode).toBe(EXIT_RUN_OK);
        expect(r.counts.verify).toBe(0);
      } finally {
        if (held.ok) {
          releaseRepositoryExecutionLease(held.evidence);
        }
      }
    } finally {
      repo.dispose();
    }
  });

  it('stays concluded when the receipt and the history are gone', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);
      writeConclusion(repo.root);
      rmSync(receiptPath(repo.root));
      rmSync(verificationPath(repo.root));
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('DELIVERY_CONCLUDED');
      expect(r.exitCode).toBe(EXIT_RUN_OK);
      expect(contactedForge(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('repeats to the same answer, and writes nothing the second time', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeConclusion(repo.root);
      const before = readFileSync(conclusionPath(repo.root), 'utf8');
      const first = await drive(['--drive'], repo);
      const second = await drive(['--drive'], repo);
      expect(driven(first)).toBe('DELIVERY_CONCLUDED');
      expect(driven(second)).toBe('DELIVERY_CONCLUDED');
      expect(first.exitCode).toBe(second.exitCode);
      expect(readFileSync(conclusionPath(repo.root), 'utf8')).toBe(before);
    } finally {
      repo.dispose();
    }
  });

  it('fails closed on a conclusion for another delivery of this task', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeConclusion(repo.root, { subjectCommit: OTHER });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo);
      expect(driven(r)).toBe('DELIVERY_EVIDENCE_UNUSABLE');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(r.out).toContain('Completion   : CONCLUSION_CONFLICT');
      expect(contactedForge(r)).toBe(false);
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('fails closed on a conclusion it cannot read, and never overwrites it', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      mkdirSync(deliveryConclusionDirectory(repo.root), { recursive: true });
      writeFileSync(conclusionPath(repo.root), '{ not a conclusion', 'utf8');
      const before = readFileSync(conclusionPath(repo.root), 'utf8');
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo);
      expect(driven(r)).toBe('DELIVERY_EVIDENCE_UNUSABLE');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(contactedForge(r)).toBe(false);
      expect(readFileSync(conclusionPath(repo.root), 'utf8')).toBe(before);
    } finally {
      repo.dispose();
    }
  });
});

/* ═════════════════ 4. the records the ladder reads on the way ════════════ */

describe('a record that cannot be read stops the driver where it is', () => {
  it('stops on a receipt about another delivery', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // Internally consistent, or the schema refuses it as malformed before
      // the identity is ever compared: `mergedHeadSha` is the head the merge
      // actually carried, and a receipt whose two heads disagree is not a
      // receipt about another delivery — it is not a receipt.
      writeReceipt(repo.root, { subjectCommit: OTHER, mergedHeadSha: OTHER });
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('DELIVERY_EVIDENCE_UNUSABLE');
      expect(r.out).toContain('Completion   : RECEIPT_NOT_THIS_DELIVERY');
      expect(contactedForge(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('stops on a receipt it cannot read', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      mkdirSync(mergeReconciliationDirectory(repo.root), { recursive: true });
      writeFileSync(receiptPath(repo.root), 'not json', 'utf8');
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('DELIVERY_EVIDENCE_UNUSABLE');
      expect(contactedForge(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('stops on a verification history it cannot read', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      mkdirSync(postMergeVerificationDirectory(repo.root), { recursive: true });
      writeFileSync(verificationPath(repo.root), 'not json', 'utf8');
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('DELIVERY_EVIDENCE_UNUSABLE');
      expect(r.counts.verify).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('stops on a history that describes a different delivery from the receipt', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root, { pullRequestNumber: PR + 1 });
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('DELIVERY_EVIDENCE_UNUSABLE');
      expect(r.out).toContain('Completion   : VERIFICATION_NOT_THIS_DELIVERY');
    } finally {
      repo.dispose();
    }
  });
});

/* ═══════════════════ 5. the verdict, and the two ways it is not one ══════ */

describe('a verdict about the code and a machine that could not answer are different', () => {
  it('concludes from a standing pass, and runs no gate to do it', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('DELIVERY_CONCLUDED');
      expect(r.exitCode).toBe(EXIT_RUN_OK);
      expect(r.counts.verify).toBe(0);
      expect(contactedForge(r)).toBe(false);
      expect(r.out).toContain('Completion   : DELIVERY_CONCLUDED');
      expect(statSync(conclusionPath(repo.root)).isFile()).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  it('stops as a code failure when the standing verdict is a fail', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root, { attempts: [nonPass('VERIFIED_FAIL')] });
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('VERIFICATION_FAILED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      // Not re-run, and nothing concluded.
      expect(r.counts.verify).toBe(0);
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('lets a later real failure outrank an earlier pass', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root, { attempts: [attemptOf(), nonPass('VERIFIED_FAIL')] });
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('VERIFICATION_FAILED');
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('does not let a machine that could not answer become a verdict', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root, {
        attempts: [nonPass('VERIFIED_FAIL'), nonPass('VERIFICATION_NOT_ESTABLISHED')],
      });
      // The standing verdict skips the unavailable attempt, so the fail stands.
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('VERIFICATION_FAILED');
    } finally {
      repo.dispose();
    }
  });

  it('runs the gate once when no verdict exists, and reports what stopped it', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      const r = await drive(['--drive'], repo);
      expect(driven(r)).toBe('VERIFICATION_NOT_ESTABLISHED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      // The merge object is not in this repository and this build will not
      // fetch one, so the gate never ran.
      expect(r.out).toContain('MERGE_COMMIT_UNAVAILABLE');
      expect(r.counts.verify).toBe(0);
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('treats a pass under another profile as no verdict at all', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root, {
        attempts: [attemptOf({ profileDigest: verificationProfileDigest(OTHER_PROFILE) })],
      });
      const r = await drive(['--drive'], repo);
      // It went to the gate rather than concluding: a verdict about another
      // contract is not a verdict about this one.
      expect(driven(r)).toBe('VERIFICATION_NOT_ESTABLISHED');
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('stops as infrastructure when the execution lease is held elsewhere', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      const held = acquireRepositoryExecutionLease(
        { id: 'fixture-repo', root: repo.root, gitCommonDir: repo.gitCommonDir } as never,
        { runId: null, blockId: null },
        { now: () => LATER },
      );
      expect(held.ok).toBe(true);
      try {
        const r = await drive(['--drive'], repo);
        expect(driven(r)).toBe('VERIFICATION_NOT_ESTABLISHED');
        expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
        expect(r.counts.verify).toBe(0);
      } finally {
        if (held.ok) {
          releaseRepositoryExecutionLease(held.evidence);
        }
      }
    } finally {
      repo.dispose();
    }
  });

  /**
   * The lease rule, pinned where it is decidable.
   *
   * A release that fails cannot be forced from a test without breaking the
   * lease module's own guarantees, so what is measured here is the composition
   * the command performs: the driver's grade goes through
   * `exitCodeWithLeaseRelease`, which answers `EXIT_RUN_NEEDS_OPERATOR` for
   * every release that is not a proven `RELEASED` — **including the nominal
   * member**. The structural half is measured beside it.
   */
  it('lets a release that cannot be proven outrank every driver grade', () => {
    for (const member of DELIVERY_DRIVES) {
      const primary = exitCodeForDrive(member);
      expect(exitCodeWithLeaseRelease(primary, null), member).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(
        exitCodeWithLeaseRelease(primary, { code: 'NOT_OWNER' } as never),
        member,
      ).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(exitCodeWithLeaseRelease(primary, { code: 'RELEASED' } as never), member).toBe(
        primary,
      );
    }
  });

  it('applies the lease rule last, over the driver’s own grade', () => {
    const source = codeOnly('src/cli/delivery-command.ts');
    const opens = source.indexOf('const primary = exitCodeForDrive(');
    expect(opens).toBeGreaterThan(0);
    const tail = source.slice(opens, opens + 700);
    // The lease call comes after the grade, and reads it.
    expect(tail).toContain('exitCodeWithLeaseRelease(primary');
    expect(tail).toContain('driven.verification !== null && driven.verification.leaseTaken');
  });
});

/* ══════════════ 6. asking whether it already happened, first ═════════════ */

describe('the driver asks about a merge before it asks about a pull request', () => {
  it('records a receipt for a merge somebody else performed', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive'], repo, {
        forge: { atHead: [mergedPull()], byNumber: [mergedPull()] },
      });
      // The receipt is on disk, filed from a merge AO did not perform.
      expect(statSync(receiptPath(repo.root)).isFile()).toBe(true);
      // …and the driver moved on to the verdict, which is what stopped it.
      expect(driven(r)).toBe('VERIFICATION_NOT_ESTABLISHED');
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('converges: a second run files nothing and answers the same', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const forge = { atHead: [mergedPull()], byNumber: [mergedPull()] };
      const first = await drive(['--drive'], repo, { forge });
      const bytes = readFileSync(receiptPath(repo.root), 'utf8');
      const second = await drive(['--drive'], repo, { forge });
      expect(driven(second)).toBe(driven(first));
      expect(readFileSync(receiptPath(repo.root), 'utf8')).toBe(bytes);
    } finally {
      repo.dispose();
    }
  });

  it('refuses to file a second, contradictory receipt', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // A receipt for this delivery naming a different merge commit.
      writeReceipt(repo.root, { mergeCommit: OTHER });
      const bytes = readFileSync(receiptPath(repo.root), 'utf8');
      const r = await drive(['--drive'], repo, {
        forge: { atHead: [mergedPull()], byNumber: [mergedPull()] },
      });
      // The ladder reads the receipt it already has, so it never reaches the
      // forge at all: a delivery with a receipt is past reconciliation.
      expect(driven(r)).toBe('VERIFICATION_NOT_ESTABLISHED');
      expect(readFileSync(receiptPath(repo.root), 'utf8')).toBe(bytes);
    } finally {
      repo.dispose();
    }
  });

  it('stops when the forge cannot answer the merge question', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: { unreadable: true },
      });
      expect(driven(r)).toBe('FORGE_STATE_UNKNOWN');
      expect(r.exitCode).toBe(EXIT_RUN_REFUSED);
      expect(mutated(r)).toBe(false);
      expect(() => statSync(receiptPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('hands back a pull request closed unmerged at this head', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const closed = openPull({ state: 'closed', merged: false, merge_commit_sha: null });
      // The head is already on the remote, so the publication is a reading and
      // the creation is the first act that could attempt anything.
      const r = await drive(['--drive', '--publish-head', '--create-pr', '--attended'], repo, {
        forge: { atHead: [closed], byNumber: [closed] },
        remoteRef: 'at-head',
      });
      expect(driven(r)).toBe('HUMAN_DECISION_REQUIRED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(r.counts.create).toBe(0);
    } finally {
      repo.dispose();
    }
  });
});

/* ═══════════════════ 7. the way in, and the authority for it ═════════════ */

describe('the way in: every act still needs its own flag', () => {
  it('names the publication when nothing is authorised', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive'], repo, { forge: { atHead: [] } });
      expect(driven(r)).toBe('ATTENDED_AUTHORITY_REQUIRED');
      expect(r.exitCode).toBe(EXIT_RUN_REFUSED);
      expect(r.out).toContain('Next act     : PUBLISH_HEAD');
      expect(r.out).toContain('Authorise by : --publish-head --attended');
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('names the pull request when only the publication is authorised', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--publish-head', '--attended'], repo, {
        forge: { atHead: [] },
      });
      // The publication ran and attempted, so this run stops there.
      expect(driven(r)).toBe('EFFECT_ATTEMPTED');
      expect(r.exitCode).toBe(EXIT_RUN_CALL_AGAIN);
      expect(r.counts.publish).toBeGreaterThan(0);
      expect(r.counts.create).toBe(0);
      expect(r.counts.merge).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('refuses every mutation when --attended is absent', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--publish-head', '--create-pr', '--merge-pr'], repo, {
        forge: { atHead: [] },
      });
      expect(driven(r)).toBe('ATTENDED_AUTHORITY_REQUIRED');
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('names the merge when a pull request matched and its checks passed', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive'], repo, {
        forge: { atHead: [openPull()], byNumber: [openPull()], checks: 'success' },
      });
      expect(driven(r)).toBe('ATTENDED_AUTHORITY_REQUIRED');
      expect(r.out).toContain('Next act     : MERGE_PULL_REQUEST');
      expect(r.out).toContain('Authorise by : --merge-pr --attended');
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('merges when the merge is the authorised act, and stops there', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: {
          atHead: [openPull()],
          byNumber: [openPull(), mergedPull()],
          checks: 'success',
        },
      });
      expect(driven(r)).toBe('EFFECT_ATTEMPTED');
      expect(r.exitCode).toBe(EXIT_RUN_CALL_AGAIN);
      expect(r.counts.merge).toBe(1);
      // Nothing was reconciled, verified or concluded in the same run.
      expect(() => statSync(receiptPath(repo.root))).toThrow();
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('waits for checks that are still running, and does not sleep', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const started = Date.now();
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: { atHead: [openPull()], byNumber: [openPull()], checks: 'pending' },
      });
      expect(driven(r)).toBe('CHECKS_PENDING');
      expect(r.exitCode).toBe(EXIT_RUN_CALL_AGAIN);
      expect(mutated(r)).toBe(false);
      // A driver that waited would take seconds. The ceiling is generous
      // because a loaded parallel gate is slow; a poll loop would blow it.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      repo.dispose();
    }
  });

  it('stops on checks that did not succeed', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: { atHead: [openPull()], byNumber: [openPull()], checks: 'failure' },
      });
      expect(driven(r)).toBe('CHECKS_FAILED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('stops on a commit that carries no checks at all', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: { atHead: [openPull()], byNumber: [openPull()], checks: 'none' },
      });
      expect(driven(r)).toBe('CHECKS_ABSENT');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('stops when more than one open pull request claims this head', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: {
          atHead: [openPull(), openPull({ number: PR + 1 })],
          byNumber: [openPull()],
        },
      });
      expect(['PULL_REQUEST_AMBIGUOUS', 'HUMAN_DECISION_REQUIRED']).toContain(driven(r));
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('stops when the forge answers neither question', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root, { subjectCommit: HEAD, mergeCommit: MERGE });
      rmSync(receiptPath(repo.root));
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: { unreadable: true },
      });
      // The reconciliation is the first forge question, so an unreadable forge
      // stops there rather than at the observation.
      expect(driven(r)).toBe('FORGE_STATE_UNKNOWN');
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });
});

/* ══════════ 8. one mutation per invocation — the load-bearing rule ═══════ */

describe('at most one forge mutation is attempted per invocation', () => {
  it('publishes and stops, though all three acts were authorised', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(
        ['--drive', '--publish-head', '--create-pr', '--merge-pr', '--attended'],
        repo,
        { forge: { atHead: [] } },
      );
      expect(driven(r)).toBe('EFFECT_ATTEMPTED');
      expect(r.counts.publish).toBe(1);
      // The two acts that would have consumed a proof taken before this
      // invocation changed the world.
      expect(r.counts.create).toBe(0);
      expect(r.counts.merge).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('never merges in the same invocation that opened the pull request', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // The head is already on the remote, so the publication is a reading and
      // the creation is the first act that attempts anything.
      const r = await drive(
        ['--drive', '--create-pr', '--merge-pr', '--attended'],
        repo,
        { forge: { atHead: [] } },
      );
      expect(r.counts.merge).toBe(0);
      expect(driven(r)).not.toBe('DELIVERY_CONCLUDED');
    } finally {
      repo.dispose();
    }
  });

  it('calls each act at most once, structurally', () => {
    const code = codeOnly(DRIVER);
    for (const act of [
      'performPublication(',
      'performCreation(',
      'performMerge(',
      'performReconciliation(',
      'performObservation(',
    ]) {
      const calls = code.split(act).length - 1;
      expect(calls, act).toBe(1);
    }
    // The two that are reached from more than one branch go through one
    // helper each, so the number of *call sites* stays one apiece.
    expect(code.split('performVerification(').length - 1).toBe(1);
    expect(code.split('performConclusion(').length - 1).toBe(1);
  });

  it('contains no loop over an act, no sleep and no timer', () => {
    const code = codeOnly(DRIVER);
    expect(code).not.toMatch(/\bwhile\s*\(/);
    expect(code).not.toMatch(/\bfor\s*\(/);
    expect(code).not.toMatch(/\bdo\s*\{/);
    expect(code).not.toMatch(/setTimeout|setInterval|setImmediate/);
    expect(code).not.toMatch(/\bsleep\b|\bdelay\b|\bbackoff\b|\bretry\b/i);
    // The positive control: the same search finds a loop where one exists.
    expect(codeOnly('src/deliver/forge-observation.ts')).toMatch(
      /\bfor\s*\(|\bwhile\s*\(|\.map\(/,
    );
  });
});

/* ═══════════════ 9. what the driver cannot do, by construction ═══════════ */

describe('the driver adds no capability', () => {
  it('mints nothing', () => {
    const code = codeOnly(DRIVER);
    for (const mint of [
      'mintHeadPublicationGrant',
      'mintPullRequestCreationGrant',
      'mintMergeGrant',
      'attestDeliveryObservation',
      'mintDeliveryConclusion',
    ]) {
      expect(code, mint).not.toContain(mint);
    }
  });

  it('names no transport, so it cannot step around a grant', () => {
    const code = codeOnly(DRIVER);
    for (const transport of [
      'pushDeliveryHead',
      'createPullRequestVia',
      'mergePullRequestVia',
      'runGitCommand',
      'child_process',
      'spawn',
    ]) {
      expect(code, transport).not.toContain(transport);
    }
  });

  it('takes no execution lease, and is not the file that does', () => {
    expect(codeOnly(DRIVER)).not.toMatch(/\bacquire\w*ExecutionLease\s*\(/);
    const surface = [...walk('src/deliver'), ...walk('src/cli').filter((f) => f.includes('delivery'))];
    expect(
      surface.filter((f) => /\bacquire\w*ExecutionLease\s*\(/.test(codeOnly(f))),
    ).toEqual(['src/cli/delivery-steps.ts']);
    expect(
      walk('src/deliver').filter((f) => /\bacquire\w*ExecutionLease\s*\(/.test(codeOnly(f))),
    ).toEqual([]);
  });

  it('writes no task state, no ledger entry and starts no agent', () => {
    const code = codeOnly(DRIVER);
    for (const writer of [
      'saveTaskState',
      'advanceTaskState',
      'recordAgentInterruption',
      'settleBlockTask',
      'block-ledger',
      'runClaudeWriter',
      'runCodexReviewer',
      'leasedAgent',
      'runOwnedCommand',
      'writeFileSync',
      'mkdirSync',
      'renameSync',
    ]) {
      expect(code, writer).not.toContain(writer);
    }
    // The positive control: the same search finds a writer where one exists.
    expect(readFileSync('src/state/state-store.ts', 'utf8')).toContain('saveTaskState');
  });

  it('leaves the task bytes and READY_FOR_PR exactly as they were', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // `<runtime>/<taskId>.json`, with no `tasks/` segment — the path
      // `state-location.ts` derives. The first version of this line inserted
      // one, so every read threw, the `try` swallowed it, `bytes` was always
      // `null`, and the guarded comparison below never ran: half of what this
      // case is titled for was measuring nothing. Read unguarded now, because
      // `saveTaskState` two lines up either wrote that file or threw.
      const statePath = join(repo.root, '.agent-orchestrator', 'runtime', `${TASK}.json`);
      writeReceipt(repo.root);
      writeVerification(repo.root);
      const before = readdirSync(join(repo.root, '.agent-orchestrator', 'runtime'));
      const bytes = readFileSync(statePath, 'utf8');
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo);
      expect(driven(r)).toBe('DELIVERY_CONCLUDED');
      expect(readFileSync(statePath, 'utf8')).toBe(bytes);
      // The runtime directory gained the conclusion and nothing else.
      const after = readdirSync(join(repo.root, '.agent-orchestrator', 'runtime'));
      expect(after.filter((d) => !before.includes(d)).sort()).toEqual(['delivery-conclusion']);
    } finally {
      repo.dispose();
    }
  });

  it('leaves READY_FOR_PR terminal, with no outgoing transition', () => {
    expect([...TERMINAL_STATES]).toContain('READY_FOR_PR');
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
  });

  it('introduces no Git fetch', () => {
    const sources = walk('src');
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.filter((f) => /['"]fetch['"]/.test(codeOnly(f)))).toEqual([]);
  });
});

/* ═══════════════════════ 10. the report and the help ════════════════════ */

describe('the report says what happened and what is needed next', () => {
  it('prints the drive block, its position and its trailer', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      const r = await drive(['--drive'], repo);
      expect(r.out).toMatch(/^Drive {8}: VERIFICATION_NOT_ESTABLISHED$/m);
      expect(r.out).toContain(DELIVERY_DRIVE_DETAIL.VERIFICATION_NOT_ESTABLISHED);
      expect(r.out).toContain('Position     : VERIFICATION_ABSENT');
      expect(r.out).toContain(DRIVE_TRAILER);
    } finally {
      repo.dispose();
    }
  });

  it('says nothing about a drive when the flag is absent', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeConclusion(repo.root);
      const r = await drive([], repo);
      expect(r.out).not.toContain('Drive        :');
      expect(r.out).not.toContain(DRIVE_TRAILER);
    } finally {
      repo.dispose();
    }
  });

  it('names the next act only where there is one to authorise', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeConclusion(repo.root);
      const r = await drive(['--drive'], repo);
      expect(r.out).not.toContain('Next act     :');
      expect(r.out).not.toContain('Authorise by :');
    } finally {
      repo.dispose();
    }
  });

  it('uses a label no other line in this report uses', () => {
    const render = readFileSync('src/cli/render-delivery-observation.ts', 'utf8');
    // `Drive` is not `Delivery`, `Decision`, `Conclusion` or `Completion`, all
    // of which already name different facts in the same report.
    for (const taken of ['Delivery     :', 'Decision     :', 'Conclusion   :', 'Completion   :']) {
      expect(render).toContain(taken);
    }
    expect(render).toContain('Drive        :');
  });

  /**
   * The help text, pinned to rules rather than to a list.
   *
   * Five review rounds were spent on one paragraph of this command's help
   * before the lesson was written down: a sentence that enumerates goes stale,
   * and a sentence that states a rule does not. So what is checked is that the
   * description says the three things that are true of every drive, and names
   * the flags it will not compose with — which it must, because the refusal is
   * otherwise a surprise.
   */
  it('says what a drive may do, in the terms the driver enforces', () => {
    // '--attended' stood here, and V4 slice 13 made naming one grant the wrong
    // shape for this sentence: the rule the driver enforces is that an act needs
    // its own flag AND a grant for that act, whichever grant that is. The rule
    // is what is pinned, because a sentence that enumerates goes stale and a
    // sentence that states a rule does not.
    expect(DRIVE_OPTION_DESCRIPTION).toContain('its own flag and a grant that names that act');
    expect(DRIVE_OPTION_DESCRIPTION).toContain('It adds no act and no grant');
    expect(DRIVE_OPTION_DESCRIPTION).toContain('At most one');
    expect(DRIVE_OPTION_DESCRIPTION).toContain('no sleep, no loop and no background work');
    for (const flag of [
      '--observe',
      '--record',
      '--decide',
      '--reconcile-merge',
      '--verify-merge',
      '--conclude-delivery',
    ]) {
      expect(DRIVE_OPTION_DESCRIPTION, flag).toContain(flag);
    }
  });

  it('carries no word this build refuses to put on a flag', () => {
    for (const banned of [/\bforce\b/i, /\bunattended\b/i, /\badopt\b/i, /\btakeover\b/i, /\bsteal\b/i]) {
      expect(DRIVE_OPTION_DESCRIPTION, String(banned)).not.toMatch(banned);
    }
  });
});

/* ═══════════════ 11. the durability predicate the driver reads ═══════════ */

describe('the receipt durability predicate is total', () => {
  const CODES: readonly MergeReconciliationRecordCode[] = [
    'RECORDED',
    'ALREADY_RECORDED',
    'CONFLICTING_RECEIPT',
    'EXISTING_RECEIPT_UNREADABLE',
    'MERGE_NOT_PROVEN',
    'SUBJECT_MISMATCH',
    'LOCATION_UNSUITABLE',
    'RUNTIME_PATH_NOT_IGNORED',
    'RUNTIME_IGNORE_UNDETERMINED',
    'DIRECTORY_CREATE_FAILED',
    'RECEIPT_TOO_LARGE',
    'RECEIPT_CONTRACT_VIOLATION',
    'WRITE_FAILED',
  ];

  it('answers for every code, and true for exactly the two that leave bytes', () => {
    for (const code of CODES) {
      expect(receiptIsOnDisk(code), code).toBeTypeOf('boolean');
    }
    expect(CODES.filter((c) => receiptIsOnDisk(c))).toEqual(['RECORDED', 'ALREADY_RECORDED']);
  });
});

/* ═══════════ 12. an uncertain effect is asked about, never repeated ══════ */

describe('a mutation is attempted at most once, whatever it came to', () => {
  it('refuses a delivery ref that holds another commit, and pushes nothing', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--publish-head', '--create-pr', '--attended'], repo, {
        forge: { atHead: [] },
        remoteRef: 'other',
      });
      expect(driven(r)).toBe('HUMAN_DECISION_REQUIRED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(r.counts.publish).toBe(0);
      expect(r.counts.create).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('sends one push and stops, even when the reading afterwards is uncertain', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--publish-head', '--create-pr', '--attended'], repo, {
        forge: { atHead: [] },
        // The push "completes" and the ref is still not there afterwards, which
        // is exactly `OUTCOME_UNCERTAIN`: the transport claimed success and the
        // remote does not show it.
        publicationLeavesRefAbsent: true,
      });
      expect(driven(r)).toBe('EFFECT_ATTEMPTED');
      expect(r.exitCode).toBe(EXIT_RUN_CALL_AGAIN);
      expect(r.out).toContain('OUTCOME_UNCERTAIN');
      // One request, and no second one to find out what the first did.
      expect(r.counts.publish).toBe(1);
      expect(r.counts.create).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('does not push again once the head is on the remote', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const first = await drive(['--drive', '--publish-head', '--attended'], repo, {
        forge: { atHead: [] },
      });
      expect(first.counts.publish).toBe(1);
      // A later invocation finds the ref where the first one left it. Nothing
      // is replayed; the reading is what tells it so.
      const second = await drive(['--drive', '--publish-head', '--attended'], repo, {
        forge: { atHead: [] },
        remoteRef: 'at-head',
      });
      expect(second.counts.publish).toBe(0);
      expect(driven(second)).toBe('ATTENDED_AUTHORITY_REQUIRED');
      expect(second.out).toContain('Next act     : CREATE_PULL_REQUEST');
    } finally {
      repo.dispose();
    }
  });

  it('sends one create request and stops, whatever the reading afterwards says', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--create-pr', '--attended'], repo, {
        // Nothing at the head before, and nothing after either: the pull
        // request this build intended is not the one it can find.
        forge: { atHead: [] },
        remoteRef: 'at-head',
      });
      expect(driven(r)).toBe('EFFECT_ATTEMPTED');
      expect(r.counts.create).toBe(1);
      expect(r.counts.merge).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('sends one merge request and stops, whatever the reading afterwards says', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: {
          atHead: [openPull()],
          // Open before; unreadable after, which is the state in which the
          // forge may have committed the merge and the answer never arrived.
          byNumber: [openPull(), null],
          checks: 'success',
        },
      });
      expect(driven(r)).toBe('EFFECT_ATTEMPTED');
      expect(r.counts.merge).toBe(1);
      // Nothing was recorded from an attempt nobody could read.
      expect(() => statSync(receiptPath(repo.root))).toThrow();
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('reconciles a merge that really happened, on the next invocation', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // The merge happened; this invocation only reads. No authority is given,
      // and the receipt is filed all the same — reconciliation is not an act
      // an operator authorises.
      const r = await drive(['--drive'], repo, {
        forge: { atHead: [mergedPull()], byNumber: [mergedPull()] },
      });
      expect(mutated(r)).toBe(false);
      expect(statSync(receiptPath(repo.root)).isFile()).toBe(true);
    } finally {
      repo.dispose();
    }
  });
});

/* ═══════════ 13. each act's own flag, and the write that must land ═══════ */

describe('an authority given for one act is not an authority for another', () => {
  it('will not publish for a run that only authorised the pull request', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // The head is NOT on the remote and `--publish-head` was not given.
      const r = await drive(['--drive', '--create-pr', '--attended'], repo, {
        forge: { atHead: [] },
        remoteRef: 'absent',
      });
      expect(r.counts.publish).toBe(0);
      // The creation refused because the branch is not there, and the report
      // names the act that would put it there.
      expect(driven(r)).toBe('ATTENDED_AUTHORITY_REQUIRED');
      expect(r.out).toContain('Next act     : PUBLISH_HEAD');
    } finally {
      repo.dispose();
    }
  });

  it('will not merge for a run that authorised no act at all', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // `--attended` alone. The operator is present and has named nothing.
      const r = await drive(['--drive', '--attended'], repo, {
        forge: { atHead: [openPull()], byNumber: [openPull()], checks: 'success' },
      });
      expect(driven(r)).toBe('ATTENDED_AUTHORITY_REQUIRED');
      expect(r.out).toContain('Next act     : MERGE_PULL_REQUEST');
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('will not merge for a run that authorised only the publication', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--publish-head', '--attended'], repo, {
        forge: { atHead: [openPull()], byNumber: [openPull()], checks: 'success' },
        remoteRef: 'at-head',
      });
      expect(driven(r)).toBe('ATTENDED_AUTHORITY_REQUIRED');
      expect(r.out).toContain('Next act     : MERGE_PULL_REQUEST');
      expect(r.counts.merge).toBe(0);
      expect(r.counts.publish).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('stops on a reading of the remote that could not be taken', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--publish-head', '--create-pr', '--attended'], repo, {
        forge: { atHead: [] },
        remoteUnreadable: true,
      });
      // A reading that could not be taken, not a head that is not there — the
      // driver names the two differently now, and a review measured why.
      expect(driven(r)).toBe('FORGE_STATE_UNKNOWN');
      expect(r.exitCode).toBe(EXIT_RUN_REFUSED);
      // Nothing was pushed, and the creation was never reached: a pull request
      // is opened from a branch, and this run cannot say there is one.
      expect(r.counts.publish).toBe(0);
      expect(r.counts.create).toBe(0);
    } finally {
      repo.dispose();
    }
  });
});

describe('a record that did not reach the disk has not moved the delivery', () => {
  it('does not move on from a receipt the store refused to write', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive'], repo, {
        forge: { atHead: [mergedPull()], byNumber: [mergedPull()] },
        // Git says the runtime path is not ignored, so every store refuses.
        ignored: 'NOT_IGNORED',
      });
      expect(driven(r)).toBe('RECEIPT_NOT_DURABLE');
      // The receipt store's own grade for this code, not a number chosen by the
      // driver: an unignored runtime path is fixed by editing the repository.
      expect(r.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      expect(() => statSync(receiptPath(repo.root))).toThrow();
      // And no verification was run for a merge nothing recorded.
      expect(r.counts.verify).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('does not report a delivery concluded when the claim did not reach the disk', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);
      const r = await drive(['--drive'], repo, { ignored: 'NOT_IGNORED' });
      expect(driven(r)).toBe('CONCLUSION_NOT_DURABLE');
      // The store's own grade for this code, not a number chosen by the driver.
      expect(r.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      expect(r.out).toContain('Completion   : DELIVERY_CONCLUDED');
      expect(r.out).toContain('RUNTIME_PATH_NOT_IGNORED');
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });
});

/* ══════════ 14. the gate actually running, and what follows from it ══════ */

describe('when the gate is reached, its verdict is what the driver carries', () => {
  it('runs the gate, records the pass, and concludes the delivery in one invocation', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const r = await drive(['--drive'], repo, { workspaceAtMerge: true, gate: 'RAN_PASS' });
      expect(r.counts.verify).toBe(1);
      expect(driven(r)).toBe('DELIVERY_CONCLUDED');
      expect(r.exitCode).toBe(EXIT_RUN_OK);
      expect(statSync(verificationPath(repo.root)).isFile()).toBe(true);
      expect(statSync(conclusionPath(repo.root)).isFile()).toBe(true);
      // Nothing was contacted to do it: the merge was already reconciled.
      expect(contactedForge(r)).toBe(false);
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('stops as a code failure when the gate says no', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const r = await drive(['--drive'], repo, { workspaceAtMerge: true, gate: 'RAN_FAIL' });
      if (r.counts.verify !== 1) throw new Error(r.out);
      expect(driven(r)).toBe('VERIFICATION_FAILED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('stops as infrastructure when the gate could not be run to an answer', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const r = await drive(['--drive'], repo, { workspaceAtMerge: true, gate: 'UNAVAILABLE' });
      expect(r.counts.verify).toBe(1);
      // The gate was attempted and answered nothing. That is not a verdict
      // about the code, and it is not a conclusion either.
      expect(driven(r)).toBe('VERIFICATION_NOT_ESTABLISHED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('reconciles, verifies and concludes a human merge across one invocation', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // Nothing on disk. Somebody merged the pull request by hand.
      const merged = mergedPull({ merge_commit_sha: repo.mergeCommit });
      const r = await drive(['--drive'], repo, {
        forge: { atHead: [merged], byNumber: [merged] },
        workspaceAtMerge: true,
        gate: 'RAN_PASS',
      });
      expect(driven(r)).toBe('DELIVERY_CONCLUDED');
      expect(r.exitCode).toBe(EXIT_RUN_OK);
      // Three records, none of which existed when the invocation began, and no
      // mutation of github.com to produce any of them.
      expect(statSync(receiptPath(repo.root)).isFile()).toBe(true);
      expect(statSync(verificationPath(repo.root)).isFile()).toBe(true);
      expect(statSync(conclusionPath(repo.root)).isFile()).toBe(true);
      expect(mutated(r)).toBe(false);
      // …and a second invocation is terminal without contacting anything.
      const again = await drive(['--drive'], repo, {
        forge: { atHead: [merged], byNumber: [merged] },
      });
      expect(driven(again)).toBe('DELIVERY_CONCLUDED');
      expect(contactedForge(again)).toBe(false);
      expect(again.counts.verify).toBe(0);
    } finally {
      repo.dispose();
    }
  });
});

/* ═══════ 15. one reading, one member — the fixes Review 1 measured ═══════ */

describe('an act that refuses without sending is read member by member', () => {
  it('says two pull requests claim this head, not that none does', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // The reconciliation and the observation see an empty head, so the
      // decision is `PULL_REQUEST_REQUIRED` and the creation is reached. The
      // creation's own fresh reading — the third — sees two open pull requests
      // at this head, which is the exact negation of that decision.
      const r = await drive(['--drive', '--create-pr', '--attended'], repo, {
        forge: {
          atHeadByAsking: [[], [], [openPull(), openPull({ number: PR + 1 })]],
          byNumber: [openPull()],
        },
        remoteRef: 'at-head',
      });
      expect(driven(r)).toBe('PULL_REQUEST_AMBIGUOUS');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(r.counts.create).toBe(0);
      // And never the sentence that says the opposite of what was read.
      expect(r.out).not.toContain('Drive        : PULL_REQUEST_REQUIRED');
    } finally {
      repo.dispose();
    }
  });

  it('does not tell an operator to ask again about a work branch that is its base', async () => {
    const repo = fixture();
    try {
      // The mint refuses a head ref equal to the base, and no invocation clears
      // it. Reported as a subject nobody can deliver — exit 2 — rather than as
      // "nothing durable is wrong, ask again".
      saveTaskState(taskStateFor(repo.root, { workBranch: BASE }) as never, {
        repositoryRoot: repo.root,
      });
      const r = await drive(['--drive', '--publish-head', '--create-pr', '--attended'], repo, {
        forge: { atHead: [] },
        remoteRef: 'at-head',
      });
      expect(driven(r)).toBe('SUBJECT_NOT_ESTABLISHED');
      expect(r.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('stops on a base branch this build will not send, before any reading', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root, { baseBranch: 'a..b' }) as never, {
        repositoryRoot: repo.root,
      });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: { atHead: [openPull()], byNumber: [openPull()] },
      });
      // The reconciliation refuses it, and the driver reports the subject
      // rather than calling the arm unreachable — a review measured that the
      // caller's own gates do not cover this producer.
      expect(driven(r)).toBe('SUBJECT_NOT_ESTABLISHED');
      expect(r.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      expect(mutated(r)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('calls a forge it could not read at the merge a reading, not a person', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive', '--merge-pr', '--attended'], repo, {
        forge: {
          atHead: [openPull()],
          byNumber: [openPull()],
          checks: 'success',
          // The reconciliation and the observation get their answers; the
          // merge ladder's own pre-reading does not.
          byNumberFailsAfterLocator: 1,
        },
      });
      expect(driven(r)).toBe('FORGE_STATE_UNKNOWN');
      expect(r.exitCode).toBe(EXIT_RUN_REFUSED);
      // Nothing was sent, and nobody put this delivery anywhere: reporting it
      // as a person's decision is the confusion the vocabulary keeps apart.
      expect(r.counts.merge).toBe(0);
      expect(r.out).toContain('Merge        : PULL_REQUEST_STATE_UNKNOWN');
    } finally {
      repo.dispose();
    }
  });

  it('reports the position the ladder names now, not the one it opened with', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      const r = await drive(['--drive'], repo, {
        forge: { atHead: [mergedPull()], byNumber: [mergedPull()] },
      });
      // This invocation filed the receipt, so `RECEIPT_ABSENT` is exactly what
      // the position is NOT — and a review measured the earlier version
      // printing it three lines under a Completion line saying otherwise.
      expect(statSync(receiptPath(repo.root)).isFile()).toBe(true);
      expect(r.out).toContain('Position     : VERIFICATION_ABSENT');
      expect(r.out).not.toContain('Position     : RECEIPT_ABSENT');
    } finally {
      repo.dispose();
    }
  });
});

/* ══════ 16. two flags that could not have helped — Review 2's findings ═══ */

describe('the driver never names an act that could not fix the condition', () => {
  it('does not send an operator to --publish-head for a ref holding another commit', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // The delivery ref is on the remote at a commit that is not this head.
      // Publishing is create-only and answers that world `REF_HOLDS_ANOTHER_COMMIT`
      // — moving a ref is a destructive act this build does not perform, and no
      // flag makes it perform one. So naming the flag would send an operator to
      // a refusal.
      const r = await drive(['--drive', '--create-pr', '--attended'], repo, {
        forge: { atHead: [] },
        remoteRef: 'other',
      });
      expect(driven(r)).toBe('HUMAN_DECISION_REQUIRED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(r.out).not.toContain('Authorise by : --publish-head --attended');
      expect(r.counts.create).toBe(0);
      // …and the same world reached with the publication authorised answers the
      // same member, rather than two members for one world.
      const withPublish = await drive(
        ['--drive', '--publish-head', '--create-pr', '--attended'],
        repo,
        { forge: { atHead: [] }, remoteRef: 'other' },
      );
      expect(driven(withPublish)).toBe('HUMAN_DECISION_REQUIRED');
      expect(withPublish.counts.publish).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('does not call a local answer a reading github.com could not give', async () => {
    const repo = fixture();
    try {
      saveTaskState(taskStateFor(repo.root) as never, { repositoryRoot: repo.root });
      // `git remote get-url --all` and `--push --all` both answer, and they
      // answer differently. Nothing was asked of github.com, and a person put
      // that configuration there.
      const r = await drive(['--drive', '--publish-head', '--create-pr', '--attended'], repo, {
        forge: { atHead: [] },
        remoteUrlsDiverge: true,
      });
      expect(driven(r)).toBe('HUMAN_DECISION_REQUIRED');
      expect(r.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(r.out).toContain('REMOTE_URLS_DIVERGE');
      // Never the sentence that says a reading could not be taken from a host
      // this run did not ask anything.
      expect(r.out).not.toContain('Drive        : FORGE_STATE_UNKNOWN');
      expect(r.counts.publish).toBe(0);
      expect(r.counts.create).toBe(0);

      // And the creation asks the same two local questions on its own account,
      // so the same world reached without the publication authorised has to
      // answer the same member rather than a different one.
      const creationOnly = await drive(['--drive', '--create-pr', '--attended'], repo, {
        forge: { atHead: [] },
        remoteUrlsDiverge: true,
        remoteRef: 'at-head',
      });
      expect(driven(creationOnly)).toBe('HUMAN_DECISION_REQUIRED');
      expect(creationOnly.out).not.toContain('Drive        : FORGE_STATE_UNKNOWN');
      expect(creationOnly.counts.create).toBe(0);
    } finally {
      repo.dispose();
    }
  });
});
