import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  mintPostMergeVerification,
  PostMergeVerificationEvidence,
  POST_MERGE_VERIFICATION_OUTCOMES,
  type AttemptedVerification,
} from '../src/deliver/internal/post-merge-verification-proof.js';
import {
  isPostMergeVerificationProof,
  postMergeVerificationFactsOf,
} from '../src/deliver/post-merge-verification-proof.js';
import {
  postMergeVerificationBinding,
  readPostMergeVerification,
  MAX_POST_MERGE_VERIFICATION_BYTES,
  MAX_VERIFICATION_ATTEMPTS,
  POST_MERGE_VERIFICATION_READINGS,
  POST_MERGE_VERIFICATION_VERSION,
  PostMergeVerificationSchema,
  VERIFICATION_EVENT_SENTENCE,
  type PostMergeVerificationPayload,
  type PostMergeVerificationSubject,
  type VerificationAttempt,
} from '../src/deliver/post-merge-verification.js';
import {
  derivePostMergeVerificationLocation,
  hasPassFor,
  loadPostMergeVerification,
  postMergeVerificationDirectory,
  recordPostMergeVerification,
  POST_MERGE_VERIFICATION_DIR_NAME,
  type IgnoreVerdict,
  type PostMergeVerificationWriteRequest,
} from '../src/deliver/post-merge-verification-store.js';
import {
  refuseMergeVerification,
  verifyMergeForDelivery,
  verificationWorkspaceResidue,
  MERGE_VERIFICATIONS,
  MERGE_VERIFICATION_DETAIL,
  type MergeVerificationOutcome,
  type VerificationRepository,
  type VerificationSubject,
} from '../src/deliver/verify-merge.js';
import {
  mergeReconciliationBinding,
  MERGE_RECONCILIATION_VERSION,
  type MergeReconciliationPayload,
} from '../src/deliver/merge-reconciliation.js';
import {
  mergeReconciliationDirectory,
} from '../src/deliver/merge-reconciliation-store.js';
import { verificationProfileDigest } from '../src/verify/verification-profile.js';
import type { VerificationReport } from '../src/verify/run-verification.js';
import type { VerificationCommandResult, VerificationRunner } from '../src/verify/verify-command.js';
import {
  createVerificationWorkspace,
  deriveVerificationWorkspaceIdentity,
  proveVerificationWorkspaceAt,
  removeVerificationWorkspace,
  workspaceIsGone,
  VERIFICATION_DIRECTORY_SUFFIX,
} from '../src/worktree/verification-workspace.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  type LeaseRepository,
} from '../src/lease/execution-lease.js';
import type { ExecutionLeaseEvidence } from '../src/core/execution-lease-evidence.js';
import type { ResolvedVerificationPolicy } from '../src/repo/resolve-repository.js';
import { saveTaskState, loadTaskState } from '../src/state/state-store.js';
import { proveBlockTaskEntry } from '../src/block/block-evidence.js';
import type { BlockTaskEntry } from '../src/block/block-ledger.js';

/* ─────────────────────────────── fixtures ───────────────────────────────── */

const TASK = 'V4-09';
/** H — the implementation head the receipt records. */
const HEAD = 'a'.repeat(40);
/** M — the merge commit, and the only thing this slice verifies. */
const MERGE = 'b'.repeat(40);
/** S — a synthetic pull-request merge commit. Neither H nor M. */
const SYNTHETIC = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const PR = 63;
const AT = '2026-08-25T17:45:33Z';
const IDENTITY = Object.freeze({ host: 'github.com', owner: 'M4XD4B0ZZ', name: 'AgentOrchestrator' });
const BASE = 'main';
const BRANCH = 'ao/task/V4-09';

const PROFILE: ResolvedVerificationPolicy = Object.freeze({
  phases: Object.freeze([
    Object.freeze({ phase: 'VERIFY' as const, command: Object.freeze(['npm', 'run', 'verify']) }),
  ]),
});
const DIGEST = verificationProfileDigest(PROFILE);

function subjectOf(over: Partial<PostMergeVerificationSubject> = {}): PostMergeVerificationSubject {
  return { taskId: TASK, repositoryRoot: 'D:/repo', ...over };
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

function payloadOf(
  over: Partial<PostMergeVerificationPayload> = {},
): PostMergeVerificationPayload {
  return {
    verificationVersion: POST_MERGE_VERIFICATION_VERSION,
    taskId: TASK,
    repositoryRoot: 'D:/repo',
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
}

function recordOf(
  over: Partial<PostMergeVerificationPayload> = {},
  subject = subjectOf({ repositoryRoot: over.repositoryRoot ?? 'D:/repo' }),
): unknown {
  const payload = payloadOf(over);
  return { ...payload, binding: postMergeVerificationBinding(subject, payload) };
}

function reportOf(over: Partial<VerificationReport> = {}): VerificationReport {
  return {
    verdict: 'PASSED',
    phases: [
      { phase: 'VERIFY', outcome: 'RAN', exitCode: 0, signal: null, outputTruncated: false, durationMs: 5 },
    ],
    stoppedAt: null,
    diagnostics: { stdoutExcerpt: '', stderrExcerpt: '', trusted: false },
    ...over,
  };
}

function attemptedOf(over: Partial<AttemptedVerification> = {}): AttemptedVerification {
  return {
    mergeCommit: MERGE,
    workspaceHeadCommit: MERGE,
    profileDigest: DIGEST,
    report: reportOf(),
    attemptedAt: AT,
    ...over,
  };
}

/** A minted proof, or a thrown fixture error — never `null` silently. */
function mintedProof(over: Partial<AttemptedVerification> = {}) {
  const proof = mintPostMergeVerification(attemptedOf(over));
  if (proof === null) throw new Error('fixture proof was refused by the mint');
  return proof;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Source with comments removed.
 *
 * The same stripper the sibling files use, and the same stated limit: a `//`
 * inside a string literal would be read as a comment. No file scanned here
 * contains one, and the positive controls beside each use would fail if a file
 * ever emptied out.
 */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function scratch(prefix = 'ao-v409-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  return root;
}

function writeReceipt(root: string, over: Partial<MergeReconciliationPayload> = {}): void {
  const subject = { taskId: TASK, repositoryRoot: root };
  const payload: MergeReconciliationPayload = {
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
  const dir = mergeReconciliationDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${TASK}.json`),
    `${JSON.stringify({ ...payload, binding: mergeReconciliationBinding(subject, payload) }, null, 2)}\n`,
    'utf8',
  );
}

/* ── a real Git repository, for everything the seams cannot answer ────────── */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}${r.stdout ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

interface RealRepo {
  readonly repository: VerificationRepository;
  readonly root: string;
  /** A commit that is not the base — this fixture's stand-in for M. */
  readonly mergeCommit: string;
  readonly baseCommit: string;
  readonly lease: ExecutionLeaseEvidence;
  readonly dispose: () => void;
}

/**
 * A real repository on a real filesystem, with a real held lease.
 *
 * The workspace module's whole subject is what Git does, and every one of its
 * guarantees — a detached checkout, an exact HEAD, a registry entry, a refused
 * removal — is a fact about a real `git worktree`. An injected runner could
 * only prove how the *classification* of Git's answers works, which is the
 * shape this repository has repeatedly measured as a test that pins nothing.
 */
function realRepo(): RealRepo {
  const root = mkdtempSync(join(tmpdir(), 'ao-v409-git-'));
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  git(root, 'init', '--quiet', '-b', BASE, '.');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.agent-orchestrator/\n', 'utf8');
  writeFileSync(join(root, 'tracked.txt'), 'base\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'base');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'tracked.txt'), 'merged\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'the merge');
  const mergeCommit = git(root, 'rev-parse', 'HEAD');
  const gitCommonDir = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');

  const repository: VerificationRepository = Object.freeze({
    id: 'fixture-repo',
    root,
    gitCommonDir,
    verification: PROFILE,
  });

  const acquired = acquireRepositoryExecutionLease(
    repository,
    { runId: null, blockId: null },
    { now: () => new Date().toISOString() },
  );
  if (!acquired.ok) throw new Error(`fixture lease not acquired: ${acquired.code}`);

  return {
    repository,
    root,
    mergeCommit,
    baseCommit,
    lease: acquired.evidence,
    dispose: () => {
      try {
        releaseRepositoryExecutionLease(acquired.evidence);
      } catch {
        /* the fixture's own teardown is not this suite's subject */
      }
      const derived = deriveVerificationWorkspaceIdentity(root, TASK);
      if (derived.ok) rmSync(derived.identity.workspaceParent, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A verification runner that records what it was asked, and answers as told. */
function recordingRunner(result: Partial<VerificationCommandResult> = {}): {
  runner: VerificationRunner;
  calls: { command: string; args: readonly string[]; cwd: string; headAtRun: string | null }[];
} {
  const calls: { command: string; args: readonly string[]; cwd: string; headAtRun: string | null }[] =
    [];
  const runner: VerificationRunner = async (command, args, cwd) => {
    // Read WHILE the gate is running, which is the only moment the question is
    // meaningful: the workspace is destroyed afterwards, so an assertion taken
    // after the call would be about a directory that no longer exists — and an
    // earlier version of this file made exactly that mistake and reported a Git
    // failure instead of a verdict.
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
    calls.push({
      command,
      args,
      cwd,
      headAtRun: head.status === 0 ? (head.stdout ?? '').trim() : null,
    });
    return {
      outcome: 'RAN',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      failureCode: null,
      errnoCode: null,
      durationMs: 1,
      ...result,
    };
  };
  return { runner, calls };
}

/* ── 1. The verification profile identity ────────────────────────────────── */

describe('a verification result names which contract produced it', () => {
  it('is stable for the same policy and different for every governed change', () => {
    expect(verificationProfileDigest(PROFILE)).toBe(DIGEST);
    // Recomputed from an equal-but-distinct object: the digest is over values,
    // never over identity.
    expect(
      verificationProfileDigest({ phases: [{ phase: 'VERIFY', command: ['npm', 'run', 'verify'] }] }),
    ).toBe(DIGEST);

    // Every governed part moves it. A field of `ResolvedVerificationPolicy`
    // added without being added to the digest would leave this list unable to
    // fail — which is why each case below is a *different* digest rather than a
    // shape assertion.
    const different: ResolvedVerificationPolicy[] = [
      { phases: [{ phase: 'VERIFY', command: ['npm', 'run', 'test'] }] },
      { phases: [{ phase: 'TEST', command: ['npm', 'run', 'verify'] }] },
      { phases: [{ phase: 'VERIFY', command: ['npm', 'run'] }] },
      { phases: [{ phase: 'VERIFY', command: ['npm', 'run', 'verify', '--'] }] },
      {
        phases: [
          { phase: 'BUILD', command: ['npm', 'run', 'build'] },
          { phase: 'VERIFY', command: ['npm', 'run', 'verify'] },
        ],
      },
    ];
    for (const policy of different) {
      expect(verificationProfileDigest(policy), JSON.stringify(policy)).not.toBe(DIGEST);
    }
  });

  it('distinguishes phase order, because the gate stops at the first non-pass', () => {
    const a: ResolvedVerificationPolicy = {
      phases: [
        { phase: 'BUILD', command: ['b'] },
        { phase: 'TEST', command: ['t'] },
      ],
    };
    const b: ResolvedVerificationPolicy = {
      phases: [
        { phase: 'TEST', command: ['t'] },
        { phase: 'BUILD', command: ['b'] },
      ],
    };
    expect(verificationProfileDigest(a)).not.toBe(verificationProfileDigest(b));
  });

  it('cannot be confused with a phase name and a command swapping places', () => {
    // The reason the phases are hashed as pairs rather than as one flat list.
    const a: ResolvedVerificationPolicy = { phases: [{ phase: 'BUILD', command: ['TEST', 'x'] }] };
    const b: ResolvedVerificationPolicy = { phases: [{ phase: 'TEST', command: ['BUILD', 'x'] }] };
    expect(verificationProfileDigest(a)).not.toBe(verificationProfileDigest(b));
  });

  it('is domain-separated from the merge receipt binding', () => {
    // Two sha256 values computed from different questions must not be
    // comparable by accident.
    expect(verificationProfileDigest(PROFILE)).not.toBe(
      mergeReconciliationBinding(
        { taskId: TASK, repositoryRoot: 'D:/repo' },
        {
          reconciliationVersion: 1,
          taskId: TASK,
          repositoryRoot: 'D:/repo',
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
        },
      ),
    );
  });
});

/* ── 2. The proof, and the refusal the whole slice turns on ──────────────── */

describe('a verification verdict cannot be minted for a run against another commit', () => {
  it('refuses when the proved workspace HEAD is not the commit being attested', () => {
    // THE case. A gate that ran somewhere else produces no artefact at all, so
    // no downstream code has to remember to check.
    expect(mintPostMergeVerification(attemptedOf({ workspaceHeadCommit: OTHER }))).toBeNull();
    // Including the two commits this slice is most likely to be confused with.
    expect(mintPostMergeVerification(attemptedOf({ workspaceHeadCommit: HEAD }))).toBeNull();
    expect(mintPostMergeVerification(attemptedOf({ workspaceHeadCommit: SYNTHETIC }))).toBeNull();
    // The positive control: the same call with the two equal does mint.
    expect(mintPostMergeVerification(attemptedOf())).not.toBeNull();
  });

  it('refuses anything that is not a full object name, digest or instant', () => {
    expect(mintPostMergeVerification(attemptedOf({ mergeCommit: MERGE.slice(0, 7) }))).toBeNull();
    expect(
      mintPostMergeVerification(attemptedOf({ workspaceHeadCommit: MERGE.slice(0, 7) })),
    ).toBeNull();
    expect(mintPostMergeVerification(attemptedOf({ mergeCommit: MERGE.toUpperCase() }))).toBeNull();
    expect(mintPostMergeVerification(attemptedOf({ profileDigest: 'not-a-digest' }))).toBeNull();
    expect(mintPostMergeVerification(attemptedOf({ profileDigest: DIGEST.slice(0, 63) }))).toBeNull();
    expect(mintPostMergeVerification(attemptedOf({ attemptedAt: 'yesterday' }))).toBeNull();
  });

  it('derives the outcome from the report instead of accepting a summary', () => {
    const pass = postMergeVerificationFactsOf(mintedProof());
    expect(pass?.outcome).toBe('VERIFIED_PASS');

    const fail = postMergeVerificationFactsOf(
      mintedProof({
        report: reportOf({
          verdict: 'FAILED',
          stoppedAt: 'VERIFY',
          phases: [
            { phase: 'VERIFY', outcome: 'RAN', exitCode: 1, signal: null, outputTruncated: false, durationMs: 9 },
          ],
        }),
      }),
    );
    expect(fail?.outcome).toBe('VERIFIED_FAIL');
    expect(fail?.exitCode).toBe(1);
    expect(fail?.stoppedAt).toBe('VERIFY');

    const unavailable = postMergeVerificationFactsOf(
      mintedProof({
        report: reportOf({
          verdict: 'UNAVAILABLE',
          stoppedAt: 'VERIFY',
          phases: [
            {
              phase: 'VERIFY',
              outcome: 'UNAVAILABLE',
              exitCode: null,
              signal: 'SIGTERM',
              outputTruncated: false,
              durationMs: 1_800_000,
            },
          ],
        }),
      }),
    );
    // The distinction this build refuses to collapse: a timeout is not a code
    // defect. It is `VERIFICATION_NOT_ESTABLISHED`, never `VERIFIED_FAIL`.
    expect(unavailable?.outcome).toBe('VERIFICATION_NOT_ESTABLISHED');
    expect(unavailable?.signal).toBe('SIGTERM');
    expect(unavailable?.exitCode).toBeNull();
  });

  it('refuses a report whose verdict and stopping phase contradict each other', () => {
    // Shapes `runVerification` cannot produce, refused here rather than trusted,
    // because this is the boundary a hand-built report would arrive at.
    expect(
      mintPostMergeVerification(attemptedOf({ report: reportOf({ stoppedAt: 'VERIFY' }) })),
    ).toBeNull();
    expect(
      mintPostMergeVerification(attemptedOf({ report: reportOf({ verdict: 'FAILED', stoppedAt: null }) })),
    ).toBeNull();
    expect(
      mintPostMergeVerification(
        attemptedOf({ report: reportOf({ verdict: 'BLESSED' } as unknown as Partial<VerificationReport>) }),
      ),
    ).toBeNull();
  });

  it('is opaque: shape, prototype and constructor all fail the registry gate', () => {
    const real = mintedProof();
    expect(isPostMergeVerificationProof(real)).toBe(true);

    // A structural forgery.
    const shaped = {
      mergeCommit: MERGE,
      workspaceHeadCommit: MERGE,
      profileDigest: DIGEST,
      outcome: 'VERIFIED_PASS',
    };
    expect(isPostMergeVerificationProof(shaped)).toBe(false);

    // `Object.create` on the prototype reachable from a real artefact.
    const viaPrototype = Object.create(Object.getPrototypeOf(real) as object);
    expect(isPostMergeVerificationProof(viaPrototype)).toBe(false);

    // The constructor reachable from a real artefact with no import at all.
    const Ctor = (Object.getPrototypeOf(real) as { constructor: new (facts: unknown) => unknown })
      .constructor;
    const viaConstructor = new Ctor({ mergeCommit: MERGE, workspaceHeadCommit: MERGE });
    expect(isPostMergeVerificationProof(viaConstructor)).toBe(false);

    expect(isPostMergeVerificationProof(null)).toBe(false);
    expect(isPostMergeVerificationProof(undefined)).toBe(false);
    expect(isPostMergeVerificationProof('VERIFIED_PASS')).toBe(false);
  });

  it('answers null rather than throwing for a value that beat the registry', () => {
    // Reachable, as the lease proof records: a review captured a registry by
    // hooking `WeakSet.prototype.add` before the first mint. A check that
    // answers by throwing is not answering.
    const impostor = Object.create(PostMergeVerificationEvidence.prototype) as object;
    const captured = new WeakSet<object>();
    captured.add(impostor);
    // Simulate the captured-registry outcome directly: `holds` would say yes and
    // `factsOf` would throw. The safe accessor must report `null`.
    expect(() => PostMergeVerificationEvidence.factsOf(impostor as never)).toThrow();
    expect(postMergeVerificationFactsOf(impostor)).toBeNull();
  });

  it('carries no repository output of any kind', () => {
    const facts = postMergeVerificationFactsOf(
      mintedProof({
        report: reportOf({
          verdict: 'FAILED',
          stoppedAt: 'VERIFY',
          diagnostics: { stdoutExcerpt: 'SECRET=hunter2', stderrExcerpt: 'boom', trusted: false },
          phases: [
            { phase: 'VERIFY', outcome: 'RAN', exitCode: 1, signal: null, outputTruncated: false, durationMs: 1 },
          ],
        }),
      }),
    );
    expect(facts).not.toBeNull();
    const serialised = JSON.stringify(facts);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('boom');
    expect(Object.keys(facts as object).sort()).toEqual(
      [
        'attemptedAt',
        'exitCode',
        'mergeCommit',
        'outcome',
        'phasesRun',
        'profileDigest',
        'signal',
        'stoppedAt',
        'workspaceHeadCommit',
      ].sort(),
    );
  });

  it('has exactly one mint, reachable from exactly one production module', () => {
    const sources = walk('src');
    const importers = sources.filter((file) =>
      /from '[^']*internal\/post-merge-verification-proof\.js'/.test(codeOnly(file)),
    );
    // Three, and each is classified rather than merely listed. The public
    // wrapper re-exports the type; the record schema takes only the outcome
    // vocabulary, so the literals a document may carry and the literals a proof
    // may report cannot drift apart; the ladder is the one place that mints.
    // The list is a tripwire — a fourth importer has to be justified — and the
    // property it guards is asserted directly below it.
    expect(importers.sort()).toEqual(
      [
        'src/deliver/post-merge-verification-proof.ts',
        'src/deliver/post-merge-verification.ts',
        'src/deliver/verify-merge.ts',
      ].sort(),
    );
    // And the mint is named in exactly two files: the one that declares it, and
    // the one that calls it. Stated as both, rather than as a filtered list,
    // because a filter that removed the declaring module by name would go on
    // passing if the declaration moved somewhere else.
    const named = sources.filter((file) => /\bmintPostMergeVerification\b/.test(codeOnly(file)));
    expect(named.sort()).toEqual(
      [
        'src/deliver/internal/post-merge-verification-proof.ts',
        'src/deliver/verify-merge.ts',
      ].sort(),
    );
    expect(
      codeOnly('src/deliver/internal/post-merge-verification-proof.ts'),
    ).toContain('export function mintPostMergeVerification');
  });
});

/* ── 3. The record contract ──────────────────────────────────────────────── */

describe('the verification record is a versioned, bounded, self-describing document', () => {
  it('accepts the record this build writes, and refuses one field at a time', () => {
    expect(PostMergeVerificationSchema.safeParse(recordOf()).success).toBe(true);

    // `.strict()`: a field this build does not declare is not ignored.
    expect(
      PostMergeVerificationSchema.safeParse({ ...(recordOf() as object), extra: 1 }).success,
    ).toBe(false);

    const record = recordOf() as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      const without = { ...record };
      delete without[field];
      expect(PostMergeVerificationSchema.safeParse(without).success, field).toBe(false);
    }
  });

  it('refuses an attempt whose outcome and stopping phase contradict each other', () => {
    expect(
      PostMergeVerificationSchema.safeParse(
        recordOf({ attempts: [attemptOf({ stoppedAt: 'VERIFY' })] }),
      ).success,
    ).toBe(false);
    expect(
      PostMergeVerificationSchema.safeParse(
        recordOf({ attempts: [attemptOf({ outcome: 'VERIFIED_FAIL', stoppedAt: null })] }),
      ).success,
    ).toBe(false);
    expect(
      PostMergeVerificationSchema.safeParse(
        recordOf({
          attempts: [attemptOf({ outcome: 'VERIFIED_FAIL', stoppedAt: 'VERIFY', exitCode: 1 })],
        }),
      ).success,
    ).toBe(true);
  });

  it('accepts the exit codes this platform really produces, at both spellings', () => {
    // Measured, not assumed: Node reports a Windows exception code unsigned
    // while the launch boundary writes the same number as a signed int32. A
    // bound admitting only one would discard the whole record.
    for (const exitCode of [0, 1, 255, 3_221_225_477, -1_073_741_819, -2_147_483_648, 4_294_967_295]) {
      expect(
        PostMergeVerificationSchema.safeParse(
          recordOf({ attempts: [attemptOf({ outcome: 'VERIFIED_FAIL', stoppedAt: 'VERIFY', exitCode })] }),
        ).success,
        String(exitCode),
      ).toBe(true);
    }
    for (const exitCode of [4_294_967_296, -2_147_483_649, 1.5]) {
      expect(
        PostMergeVerificationSchema.safeParse(
          recordOf({ attempts: [attemptOf({ outcome: 'VERIFIED_FAIL', stoppedAt: 'VERIFY', exitCode })] }),
        ).success,
        String(exitCode),
      ).toBe(false);
    }
  });

  it('bounds the history and refuses an empty one', () => {
    expect(PostMergeVerificationSchema.safeParse(recordOf({ attempts: [] })).success).toBe(false);
    const full = Array.from({ length: MAX_VERIFICATION_ATTEMPTS }, () => attemptOf());
    expect(PostMergeVerificationSchema.safeParse(recordOf({ attempts: full })).success).toBe(true);
    expect(
      PostMergeVerificationSchema.safeParse(recordOf({ attempts: [...full, attemptOf()] })).success,
    ).toBe(false);
  });

  it('holds a maximal history inside the byte budget', () => {
    // A budget sized against the worst representable record rather than a
    // typical one — and measured against it, in bytes, because a schema `.max()`
    // bounds characters and a character is not a byte.
    const worst = recordOf({
      repositoryRoot: 'D:/'.padEnd(200, 'x'),
      attempts: Array.from({ length: MAX_VERIFICATION_ATTEMPTS }, () =>
        attemptOf({
          outcome: 'VERIFIED_FAIL',
          stoppedAt: 'V'.repeat(32),
          exitCode: -2_147_483_648,
          signal: 'S'.repeat(32),
          phasesRun: 8,
        }),
      ),
    });
    const bytes = Buffer.byteLength(`${JSON.stringify(worst, null, 2)}\n`, 'utf8');
    expect(bytes).toBeLessThanOrEqual(MAX_POST_MERGE_VERIFICATION_BYTES);
  });

  it('binds every field, including every field of every attempt', () => {
    const subject = subjectOf();
    const base = payloadOf();
    const digest = postMergeVerificationBinding(subject, base);

    const mutations: Partial<PostMergeVerificationPayload>[] = [
      { taskId: 'V4-10' },
      { repositoryRoot: 'D:/other' },
      { subjectCommit: OTHER },
      { mergeCommit: OTHER },
      { host: 'example.invalid' },
      { owner: 'someone' },
      { name: 'other' },
      { pullRequestNumber: 64 },
      { verificationVersion: 2 },
      { attempts: [attemptOf({ attemptedAt: '2026-08-26T00:00:00Z' })] },
      { attempts: [attemptOf({ profileDigest: 'f'.repeat(64) })] },
      { attempts: [attemptOf({ outcome: 'VERIFIED_FAIL', stoppedAt: 'VERIFY' })] },
      { attempts: [attemptOf({ phasesRun: 2 })] },
      { attempts: [attemptOf({ exitCode: 1 })] },
      { attempts: [attemptOf({ signal: 'SIGKILL' })] },
      { attempts: [attemptOf(), attemptOf()] },
    ];
    for (const over of mutations) {
      expect(
        postMergeVerificationBinding(subject, payloadOf(over)),
        JSON.stringify(over),
      ).not.toBe(digest);
    }
    // And the subject is an input, so a perfectly-formed record bound for one
    // task cannot read as another's.
    expect(postMergeVerificationBinding(subjectOf({ taskId: 'V4-10' }), base)).not.toBe(digest);
    expect(postMergeVerificationBinding(subjectOf({ repositoryRoot: 'D:/x' }), base)).not.toBe(digest);
  });

  it('reads a record for what it is, and never for what a caller hoped', () => {
    const subject = subjectOf();
    expect(readPostMergeVerification(recordOf(), subject).reading).toBe('VERIFICATION_HISTORY');
    expect(readPostMergeVerification({ ...(recordOf() as object), verificationVersion: 2 }, subject).reading).toBe(
      'UNSUPPORTED_VERSION',
    );
    expect(readPostMergeVerification({}, subject).reading).toBe('MALFORMED');
    expect(readPostMergeVerification(null, subject).reading).toBe('MALFORMED');
    expect(readPostMergeVerification('a string', subject).reading).toBe('MALFORMED');
    // Bound for another task: refused, whatever it says about itself.
    expect(
      readPostMergeVerification(recordOf(), subjectOf({ taskId: 'V4-10' })).reading,
    ).toBe('NOT_THIS_TASK');
    // A record whose binding was recomputed for the other subject still names
    // this task's id inside, and the belt-and-braces line refuses it.
    const foreign = payloadOf({ taskId: 'V4-10' });
    expect(
      readPostMergeVerification(
        { ...foreign, binding: postMergeVerificationBinding(subject, foreign) },
        subject,
      ).reading,
    ).toBe('NOT_THIS_TASK');
    // A tampered binding.
    expect(
      readPostMergeVerification({ ...(recordOf() as object), binding: 'f'.repeat(64) }, subject).reading,
    ).toBe('NOT_THIS_TASK');
    // Nothing is handed back from a record this build refused.
    expect(readPostMergeVerification({}, subject).record).toBeNull();
  });

  it('states what a pass is not, in one wording a test can pin', () => {
    for (const phrase of [
      'is not a claim that the commit is on the base',
      'still reachable from it',
      'has not been reverted',
      'passes today',
    ]) {
      expect(VERIFICATION_EVENT_SENTENCE.replace(/\n/g, ' ')).toContain(phrase);
    }
  });

  it('closes both vocabularies', () => {
    expect([...POST_MERGE_VERIFICATION_READINGS].sort()).toEqual(
      ['ABSENT', 'MALFORMED', 'NOT_THIS_TASK', 'UNSUPPORTED_VERSION', 'VERIFICATION_HISTORY'].sort(),
    );
    expect([...POST_MERGE_VERIFICATION_OUTCOMES].sort()).toEqual(
      ['VERIFICATION_NOT_ESTABLISHED', 'VERIFIED_FAIL', 'VERIFIED_PASS'].sort(),
    );
  });
});

/* ── 4. The isolated workspace, against real Git ─────────────────────────── */

describe('a verification runs in an owned, detached checkout at exactly one commit', () => {
  it('derives a path outside the repository, in its own reserved directory', () => {
    const derived = deriveVerificationWorkspaceIdentity('D:/repo', TASK);
    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error('unreachable');
    // Never inside: a second checkout in the tree whose own verification
    // commands expand globs over it is the thing the sibling location prevents.
    expect(derived.identity.workspacePath.replace(/\\/g, '/')).not.toContain('D:/repo/');
    expect(derived.identity.workspaceParent).toContain(VERIFICATION_DIRECTORY_SUFFIX);
    // And it is not the task-workspace directory, whose lifetime and ownership
    // proof are different.
    expect(derived.identity.workspaceParent).not.toContain('.worktrees');

    expect(deriveVerificationWorkspaceIdentity('D:/repo', '../escape').ok).toBe(false);
    expect(deriveVerificationWorkspaceIdentity('relative/path', TASK).ok).toBe(false);
    expect(deriveVerificationWorkspaceIdentity('D:/', TASK).ok).toBe(false);
    // Shell-inert: `run-verification` refuses a path with a space, so a
    // workspace at one would report UNAVAILABLE having measured nothing.
    expect(deriveVerificationWorkspaceIdentity('D:/my repo', TASK).ok).toBe(false);
  });

  it('creates a detached checkout at the exact commit, and proves it in Git', async () => {
    const repo = realRepo();
    try {
      const created = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(created.code, JSON.stringify(created)).toBe('WORKSPACE_READY');
      if (!created.ok) throw new Error('workspace not created');

      // HEAD is the commit, read from inside the workspace by real Git.
      expect(git(created.workspace.workspacePath, 'rev-parse', 'HEAD')).toBe(repo.mergeCommit);
      // Detached: no branch was invented for the subject.
      expect(
        spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
          cwd: created.workspace.workspacePath,
          encoding: 'utf8',
        }).status,
      ).not.toBe(0);
      // The developer's own checkout is untouched.
      expect(git(repo.root, 'rev-parse', 'HEAD')).toBe(repo.mergeCommit);
      expect(git(repo.root, 'status', '--porcelain')).toBe('');

      const removal = await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(removal.code).toBe('REMOVED');
      expect(workspaceIsGone(removal.code)).toBe(true);
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      expect(() => statSync(derived.identity.workspacePath)).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('proves HEAD against the commit it was asked about, and refuses another', async () => {
    const repo = realRepo();
    try {
      const created = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(created.ok).toBe(true);
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');

      expect(
        (await proveVerificationWorkspaceAt(runGitCommand, derived.identity, repo.mergeCommit)).proof,
      ).toBe('AT_COMMIT');
      // The refusal this module exists for: a workspace at A asked about B.
      expect(
        (await proveVerificationWorkspaceAt(runGitCommand, derived.identity, repo.baseCommit)).proof,
      ).toBe('HEAD_MISMATCH');
      expect(
        (await proveVerificationWorkspaceAt(runGitCommand, derived.identity, MERGE)).proof,
      ).toBe('HEAD_MISMATCH');

      // Dirtied: not clean, and therefore not a workspace a gate may start in.
      writeFileSync(join(derived.identity.workspacePath, 'stray.txt'), 'x', 'utf8');
      expect(
        (await proveVerificationWorkspaceAt(runGitCommand, derived.identity, repo.mergeCommit)).proof,
      ).toBe('NOT_CLEAN');

      await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
    } finally {
      repo.dispose();
    }
  });

  it('refuses a workspace on a branch, because it never makes one', async () => {
    const repo = realRepo();
    try {
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      mkdirSync(derived.identity.workspaceParent, { recursive: true });
      // Somebody else's worktree, at exactly the derived path, holding a branch.
      git(repo.root, 'worktree', 'add', '--quiet', '-b', 'somebody-else', derived.identity.workspacePath, repo.mergeCommit);

      expect(
        (await proveVerificationWorkspaceAt(runGitCommand, derived.identity, repo.mergeCommit)).proof,
      ).toBe('NOT_DETACHED');

      // And it is never removed: the ownership proof fails closed.
      const removal = await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(removal.code).toBe('WORKSPACE_NOT_OWNED');
      expect(workspaceIsGone(removal.code)).toBe(false);
      expect(statSync(derived.identity.workspacePath).isDirectory()).toBe(true);

      git(repo.root, 'worktree', 'remove', '--force', derived.identity.workspacePath);
    } finally {
      repo.dispose();
    }
  });

  it('never adopts, cleans or re-points something already at the path', async () => {
    const repo = realRepo();
    try {
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      mkdirSync(derived.identity.workspacePath, { recursive: true });
      writeFileSync(join(derived.identity.workspacePath, 'someones-work.txt'), 'keep me', 'utf8');

      const created = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(created.code).toBe('WORKSPACE_PATH_OCCUPIED');
      expect(created.ok).toBe(false);
      if (created.ok) throw new Error('unreachable');
      expect(created.residue).toBe(false);
      // Untouched.
      expect(readFileSync(join(derived.identity.workspacePath, 'someones-work.txt'), 'utf8')).toBe(
        'keep me',
      );
    } finally {
      repo.dispose();
    }
  });

  it('removes a dirtied workspace only with force, and says so', async () => {
    // Measured, and it is why `--force` exists here at all: a plain removal
    // succeeds over ignored build output and is refused for a modified tracked
    // file. A repository's declared gate can produce either, and AO does not
    // get to say which.
    const repo = realRepo();
    try {
      const created = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('unreachable');

      // What a build does: ignored output. Removable without force.
      mkdirSync(join(created.workspace.workspacePath, 'dist'), { recursive: true });
      writeFileSync(join(created.workspace.workspacePath, 'dist', 'out.js'), 'x', 'utf8');
      const plain = await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(plain.code).toBe('REMOVED');

      // What a generator does: a modified tracked file. Needs force.
      const again = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(again.ok).toBe(true);
      if (!again.ok) throw new Error('unreachable');
      writeFileSync(join(again.workspace.workspacePath, 'tracked.txt'), 'regenerated\n', 'utf8');
      const forced = await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(forced.code).toBe('REMOVED_FORCED');
      expect(workspaceIsGone(forced.code)).toBe(true);
      expect(verificationWorkspaceResidue(forced.code)).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('refuses to create or remove without the execution lease, at the effect', async () => {
    const repo = realRepo();
    try {
      // A released lease is not held. The gate is inside the function, not in a
      // caller, so a lease lost between a caller's check and here is caught.
      releaseRepositoryExecutionLease(repo.lease);

      const created = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(created.code).toBe('EXECUTION_LEASE_NOT_HELD');
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      expect(() => statSync(derived.identity.workspacePath)).toThrow();

      const removal = await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(removal.code).toBe('EXECUTION_LEASE_NOT_HELD');
    } finally {
      repo.dispose();
    }
  });

  it('never asks Git about a commit that is not an object name', async () => {
    const repo = realRepo();
    const asked: string[][] = [];
    const spy = async (cwd: string, args: readonly string[]) => {
      asked.push([...args]);
      return runGitCommand(cwd, args);
    };
    try {
      for (const bad of ['HEAD', 'main', repo.mergeCommit.slice(0, 7), `${repo.mergeCommit}^`, '']) {
        const created = await createVerificationWorkspace(repo.repository, TASK, bad, {
          git: spy,
          lease: repo.lease,
        });
        expect(created.code, bad).toBe('COMMIT_NOT_OBJECT_NAME');
      }
      // Nothing was spawned to find that out.
      expect(asked).toEqual([]);
    } finally {
      repo.dispose();
    }
  });

  it('reports a path Git does not register as not owned, and deletes nothing', async () => {
    const repo = realRepo();
    try {
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      // A directory that merely looks like a checkout.
      mkdirSync(join(derived.identity.workspacePath, '.git'), { recursive: true });
      writeFileSync(join(derived.identity.workspacePath, 'file.txt'), 'x', 'utf8');

      const removal = await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(removal.code).toBe('NOTHING_REGISTERED');
      // `NOTHING_REGISTERED` is deliberately not "gone": a directory is sitting
      // there, and calling it clean is how residue gets reported as success.
      expect(workspaceIsGone(removal.code)).toBe(false);
      expect(verificationWorkspaceResidue(removal.code)).toBe(true);
      expect(readFileSync(join(derived.identity.workspacePath, 'file.txt'), 'utf8')).toBe('x');
    } finally {
      repo.dispose();
    }
  });
});

/* ── 5. The ladder: the subject, and the substitutions it refuses ─────────── */

describe('the subject is the receipt’s merge commit and nothing else', () => {
  function repoOf(root: string): VerificationRepository {
    return Object.freeze({ id: 'r', root, gitCommonDir: join(root, '.git'), verification: PROFILE });
  }

  function subject(over: Partial<VerificationSubject> = {}): VerificationSubject {
    return { taskId: TASK, ...IDENTITY, deliveryCommit: HEAD, ...over };
  }

  function seams(over: Partial<Parameters<typeof verifyMergeForDelivery>[2]> = {}) {
    return {
      git: (async () => ({
        outcome: 'UNAVAILABLE' as const,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        outputTruncated: false,
        failureCode: null,
        errnoCode: null,
        durationMs: 0,
      })) as never,
      verify: recordingRunner().runner,
      lease: {} as ExecutionLeaseEvidence,
      now: () => new Date(AT),
      ...over,
    };
  }

  it('refuses when no receipt has been recorded', async () => {
    const root = scratch();
    try {
      const result = await verifyMergeForDelivery(repoOf(root), subject(), seams());
      expect(result.outcome).toBe('RECEIPT_ABSENT');
      expect(result.mergeCommit).toBeNull();
      expect(result.proof).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a receipt it cannot read, and one bound to another task', async () => {
    const root = scratch();
    try {
      mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
      writeFileSync(join(mergeReconciliationDirectory(root), `${TASK}.json`), '{ not json', 'utf8');
      expect((await verifyMergeForDelivery(repoOf(root), subject(), seams())).outcome).toBe(
        'RECEIPT_UNREADABLE',
      );

      // Perfectly-formed, bound for a different task.
      const foreignSubject = { taskId: 'V4-10', repositoryRoot: root };
      const payload: MergeReconciliationPayload = {
        reconciliationVersion: MERGE_RECONCILIATION_VERSION,
        taskId: 'V4-10',
        repositoryRoot: root,
        subjectCommit: HEAD,
        provider: 'github',
        ...IDENTITY,
        pullRequestNumber: PR,
        mergedHeadSha: HEAD,
        baseRef: BASE,
        mergeCommit: MERGE,
        observedAt: AT,
        reconciledAt: AT,
      };
      writeFileSync(
        join(mergeReconciliationDirectory(root), `${TASK}.json`),
        `${JSON.stringify({ ...payload, binding: mergeReconciliationBinding(foreignSubject, payload) }, null, 2)}\n`,
        'utf8',
      );
      expect((await verifyMergeForDelivery(repoOf(root), subject(), seams())).outcome).toBe(
        'RECEIPT_UNREADABLE',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a receipt whose recorded head is not the task’s current commit', async () => {
    const root = scratch();
    try {
      writeReceipt(root);
      // The task has moved on: its `currentCommit` is no longer the head this
      // receipt was written about, so the merge it names is not this subject.
      const result = await verifyMergeForDelivery(
        repoOf(root),
        subject({ deliveryCommit: OTHER }),
        seams(),
      );
      expect(result.outcome).toBe('RECEIPT_NOT_THIS_DELIVERY');
      expect(result.mergeCommit).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a receipt from another repository, however well-formed', async () => {
    const root = scratch();
    try {
      writeReceipt(root, { host: 'github.example', owner: 'someone', name: 'fork' });
      for (const over of [
        { host: 'github.example' },
        { owner: 'someone' },
        { name: 'fork' },
      ]) {
        writeReceipt(root, over);
        const result = await verifyMergeForDelivery(repoOf(root), subject(), seams());
        expect(result.outcome, JSON.stringify(over)).toBe('RECEIPT_NOT_THIS_DELIVERY');
      }
      // The positive control: with the target agreeing, the ladder gets past
      // this rung and refuses for the next reason instead.
      writeReceipt(root);
      expect((await verifyMergeForDelivery(repoOf(root), subject(), seams())).outcome).toBe(
        'MERGE_COMMIT_UNAVAILABLE',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses rather than fetching a merge commit the repository does not have', async () => {
    const repo = realRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: MERGE });
      const asked: string[][] = [];
      const spy = async (cwd: string, args: readonly string[]) => {
        asked.push([...args]);
        return runGitCommand(cwd, args);
      };
      const result = await verifyMergeForDelivery(repo.repository, subject(), {
        git: spy,
        verify: recordingRunner().runner,
        lease: repo.lease,
        now: () => new Date(AT),
      });
      expect(result.outcome).toBe('MERGE_COMMIT_UNAVAILABLE');
      expect(result.mergeCommit).toBe(MERGE);
      // No fetch, and no substitution of whatever the base branch has become.
      expect(asked.some((args) => args.includes('fetch'))).toBe(false);
      expect(asked.some((args) => args.includes('worktree'))).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  it('runs the declared gate in the workspace, and attests it to the exact commit', async () => {
    const repo = realRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner, calls } = recordingRunner();
      const result = await verifyMergeForDelivery(repo.repository, subject(), {
        git: runGitCommand,
        verify: runner,
        lease: repo.lease,
        now: () => new Date(AT),
      });

      expect(result.outcome, JSON.stringify(result)).toBe('VERIFICATION_ATTEMPTED');
      expect(result.mergeCommit).toBe(repo.mergeCommit);
      expect(result.profileDigest).toBe(DIGEST);

      // The declared command, in the workspace, and in no other directory.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe('npm');
      expect(calls[0]?.args).toEqual(['run', 'verify']);
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      // Not the developer's checkout — the load-bearing isolation assertion.
      expect(calls[0]?.cwd).not.toBe(repo.root);
      expect(calls[0]?.cwd.toLowerCase()).toContain(VERIFICATION_DIRECTORY_SUFFIX);

      const facts = postMergeVerificationFactsOf(result.proof);
      expect(facts?.mergeCommit).toBe(repo.mergeCommit);
      expect(facts?.workspaceHeadCommit).toBe(repo.mergeCommit);
      expect(facts?.outcome).toBe('VERIFIED_PASS');
      expect(facts?.profileDigest).toBe(DIGEST);

      // The workspace is gone and the developer's tree is untouched.
      expect(workspaceIsGone(result.workspaceRemoval ?? 'REMOVAL_FAILED')).toBe(true);
      expect(git(repo.root, 'status', '--porcelain')).toBe('');
      expect(git(repo.root, 'rev-parse', 'HEAD')).toBe(repo.mergeCommit);
    } finally {
      repo.dispose();
    }
  });

  it('verifies the receipt’s commit even when the base has moved past it', async () => {
    // The invariant this slice exists for. The base advances twice after the
    // receipt is written; the gate must still run against M.
    const repo = realRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      writeFileSync(join(repo.root, 'tracked.txt'), 'after\n', 'utf8');
      git(repo.root, 'commit', '--quiet', '-am', 'X');
      writeFileSync(join(repo.root, 'tracked.txt'), 'later\n', 'utf8');
      git(repo.root, 'commit', '--quiet', '-am', 'Y');
      const tip = git(repo.root, 'rev-parse', 'HEAD');
      expect(tip).not.toBe(repo.mergeCommit);

      const { runner, calls } = recordingRunner();
      const result = await verifyMergeForDelivery(repo.repository, subject(), {
        git: runGitCommand,
        verify: runner,
        lease: repo.lease,
        now: () => new Date(AT),
      });
      expect(result.outcome).toBe('VERIFICATION_ATTEMPTED');
      expect(result.mergeCommit).toBe(repo.mergeCommit);
      // The tree the gate ran in was at M, not at the branch tip — read from
      // inside that tree at the moment the gate was started.
      expect(calls[0]?.headAtRun).toBe(repo.mergeCommit);
      expect(calls[0]?.headAtRun).not.toBe(tip);
      expect(postMergeVerificationFactsOf(result.proof)?.workspaceHeadCommit).toBe(repo.mergeCommit);
    } finally {
      repo.dispose();
    }
  });

  it('reports a gate that could not run as unestablished, never as a code failure', async () => {
    const repo = realRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner } = recordingRunner({
        outcome: 'UNAVAILABLE',
        exitCode: null,
        signal: null,
        failureCode: 'TIMEOUT',
        durationMs: 1_800_000,
      });
      const result = await verifyMergeForDelivery(repo.repository, subject(), {
        git: runGitCommand,
        verify: runner,
        lease: repo.lease,
        now: () => new Date(AT),
      });
      expect(result.outcome).toBe('VERIFICATION_ATTEMPTED');
      expect(postMergeVerificationFactsOf(result.proof)?.outcome).toBe(
        'VERIFICATION_NOT_ESTABLISHED',
      );
    } finally {
      repo.dispose();
    }
  });

  it('reports a gate that ran and said no as a code failure', async () => {
    const repo = realRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner } = recordingRunner({ exitCode: 1 });
      const result = await verifyMergeForDelivery(repo.repository, subject(), {
        git: runGitCommand,
        verify: runner,
        lease: repo.lease,
        now: () => new Date(AT),
      });
      const facts = postMergeVerificationFactsOf(result.proof);
      expect(facts?.outcome).toBe('VERIFIED_FAIL');
      expect(facts?.exitCode).toBe(1);
      // And nothing was done about it.
      expect(result.outcome).toBe('VERIFICATION_ATTEMPTED');
    } finally {
      repo.dispose();
    }
  });

  it('closes the ladder’s vocabulary and gives every member a sentence', () => {
    const members = [...MERGE_VERIFICATIONS];
    expect(new Set(members).size).toBe(members.length);
    expect(Object.keys(MERGE_VERIFICATION_DETAIL).sort()).toEqual([...members].sort());
    for (const member of members) {
      expect(MERGE_VERIFICATION_DETAIL[member].length, member).toBeGreaterThan(10);
    }
    const refused: MergeVerificationOutcome[] = ['SUBJECT_NOT_ESTABLISHED', 'TASK_NOT_READY'];
    for (const code of refused) {
      const result = refuseMergeVerification(code as never);
      expect(result.outcome).toBe(code);
      expect(result.proof).toBeNull();
      expect(result.mergeCommit).toBeNull();
      expect(result.workspaceRemoval).toBeNull();
    }
  });
});

/* ── 6. Pull-request CI is not post-merge verification ───────────────────── */

describe('a workflow result associated with the head cannot stand in for the merge commit', () => {
  it('keeps H, the synthetic merge commit and M as three different subjects', () => {
    // Measured on this repository: the run associated with head 735eab7 checked
    // out refs/pull/63/merge = c51d442 ("Merge 735eab7… into 309e5e6…"), while
    // the merge produced e203143. Three objects; the record may only ever be
    // about the third.
    expect(new Set([HEAD, SYNTHETIC, MERGE]).size).toBe(3);
    for (const other of [HEAD, SYNTHETIC, OTHER]) {
      expect(mintPostMergeVerification(attemptedOf({ workspaceHeadCommit: other }))).toBeNull();
    }
  });

  it('reads no check state, no workflow run and no forge at all', () => {
    // The strongest available form of this: the modules that could conflate a
    // CI result with a commit do not import anything that can ask a forge.
    for (const file of [
      'src/deliver/verify-merge.ts',
      'src/deliver/post-merge-verification.ts',
      'src/deliver/post-merge-verification-store.ts',
      'src/deliver/internal/post-merge-verification-proof.ts',
      'src/worktree/verification-workspace.ts',
    ]) {
      const source = codeOnly(file);
      // A positive control, so an emptied file cannot pass this by silence.
      expect(source.length, file).toBeGreaterThan(500);
      for (const forbidden of [
        'github-observer',
        'forge-observation',
        'ForgeCommandRunner',
        'statusCheckRollup',
        'check-runs',
        'checkRuns',
        'workflow',
        'conclusion',
        'head_sha',
        'headSha',
      ]) {
        expect(source, `${file} must not reach ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('cannot be satisfied by a proof whose workspace was never proved', () => {
    // The store's own belt-and-braces line: even if the mint ever stopped
    // requiring the proved HEAD to equal the attested commit, a record naming a
    // run against another tree is refused.
    const facts = postMergeVerificationFactsOf(mintedProof());
    expect(facts?.workspaceHeadCommit).toBe(facts?.mergeCommit);
  });
});

/* ── 7. The store: append, never overwrite ───────────────────────────────── */

describe('a verification history is appended to, never rewritten', () => {
  function writeRequest(
    root: string,
    over: Partial<PostMergeVerificationWriteRequest> = {},
  ): PostMergeVerificationWriteRequest {
    return {
      repositoryRoot: root,
      taskId: TASK,
      proof: mintedProof(),
      expectedSubjectCommit: HEAD,
      expectedMergeCommit: MERGE,
      expectedHost: IDENTITY.host,
      expectedOwner: IDENTITY.owner,
      expectedName: IDENTITY.name,
      expectedPullRequestNumber: PR,
      checkIgnored: async () => 'IGNORED' as IgnoreVerdict,
      ...over,
    };
  }

  function recordPath(root: string): string {
    return join(postMergeVerificationDirectory(root), `${TASK}.json`);
  }

  it('puts the record in its own directory, never where another record can land', () => {
    expect(POST_MERGE_VERIFICATION_DIR_NAME).toBe('delivery-verification');
    const location = derivePostMergeVerificationLocation('D:/repo', TASK);
    expect(location.ok).toBe(true);
    if (!location.ok) throw new Error('unreachable');
    expect(location.directory).toContain(POST_MERGE_VERIFICATION_DIR_NAME);
    // Not the merge receipt's directory, and not the task state's.
    expect(location.directory).not.toBe(mergeReconciliationDirectory('D:/repo'));
    expect(derivePostMergeVerificationLocation('D:/repo', '../escape').ok).toBe(false);
    expect(derivePostMergeVerificationLocation('relative', TASK).ok).toBe(false);
  });

  it('starts a history, then appends to it, keeping every earlier attempt', async () => {
    const root = scratch();
    try {
      const first = await recordPostMergeVerification(
        writeRequest(root, {
          proof: mintedProof({
            report: reportOf({
              verdict: 'FAILED',
              stoppedAt: 'VERIFY',
              phases: [
                { phase: 'VERIFY', outcome: 'RAN', exitCode: 1, signal: null, outputTruncated: false, durationMs: 1 },
              ],
            }),
          }),
        }),
      );
      expect(first.code, JSON.stringify(first)).toBe('HISTORY_STARTED');
      expect(first.recorded).toBe(true);
      expect(first.writeAttempt).toBe('COMPLETED');

      const second = await recordPostMergeVerification(
        writeRequest(root, { proof: mintedProof({ attemptedAt: '2026-08-26T09:00:00Z' }) }),
      );
      expect(second.code).toBe('ATTEMPT_RECORDED');

      const loaded = loadPostMergeVerification(root, TASK, {
        taskId: TASK,
        repositoryRoot: root,
      });
      expect(loaded.reading).toBe('VERIFICATION_HISTORY');
      expect(loaded.record?.attempts).toHaveLength(2);
      // The earlier, contradicting attempt is still there, first, unchanged.
      expect(loaded.record?.attempts[0]?.outcome).toBe('VERIFIED_FAIL');
      expect(loaded.record?.attempts[0]?.attemptedAt).toBe(AT);
      expect(loaded.record?.attempts[1]?.outcome).toBe('VERIFIED_PASS');
      expect(loaded.record?.attempts[1]?.attemptedAt).toBe('2026-08-26T09:00:00Z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not run or record again once this exact commit passed this exact profile', async () => {
    const root = scratch();
    try {
      expect((await recordPostMergeVerification(writeRequest(root))).code).toBe('HISTORY_STARTED');
      const repeat = await recordPostMergeVerification(writeRequest(root));
      expect(repeat.code).toBe('ALREADY_VERIFIED');
      expect(repeat.writeAttempt).toBe('NOT_ATTEMPTED');

      // A DIFFERENT profile is a different question, and is recorded.
      const otherDigest = verificationProfileDigest({
        phases: [{ phase: 'VERIFY', command: ['npm', 'run', 'other'] }],
      });
      const different = await recordPostMergeVerification(
        writeRequest(root, { proof: mintedProof({ profileDigest: otherDigest }) }),
      );
      expect(different.code).toBe('ATTEMPT_RECORDED');

      const loaded = loadPostMergeVerification(root, TASK, { taskId: TASK, repositoryRoot: root });
      expect(loaded.record?.attempts).toHaveLength(2);
      expect(hasPassFor(loaded.record!, DIGEST)).toBe(true);
      expect(hasPassFor(loaded.record!, 'f'.repeat(64))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a history that is about a different merge, and rewrites nothing', async () => {
    const root = scratch();
    try {
      await recordPostMergeVerification(writeRequest(root));
      const before = readFileSync(recordPath(root));

      for (const over of [
        { expectedMergeCommit: OTHER, proof: mintedProof({ mergeCommit: OTHER, workspaceHeadCommit: OTHER }) },
        { expectedSubjectCommit: OTHER },
        { expectedPullRequestNumber: 64 },
        { expectedOwner: 'someone' },
      ]) {
        const result = await recordPostMergeVerification(writeRequest(root, over));
        expect(
          ['CONFLICTING_HISTORY', 'ALREADY_VERIFIED'].includes(result.code),
          `${JSON.stringify(Object.keys(over))} -> ${result.code}`,
        ).toBe(true);
        if (result.code === 'CONFLICTING_HISTORY') expect(result.recorded).toBe(false);
      }
      // The conflicting cases must leave the bytes alone; ALREADY_VERIFIED
      // writes nothing either, so the file is untouched on every path above.
      expect(readFileSync(recordPath(root))).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the history is full rather than dropping the oldest evidence', async () => {
    const root = scratch();
    try {
      // A full history, built through the real writer so the binding is real.
      // Each attempt is a distinct failure so no `ALREADY_VERIFIED` short-cut
      // fires and the history really fills.
      for (let i = 0; i < MAX_VERIFICATION_ATTEMPTS; i += 1) {
        const result = await recordPostMergeVerification(
          writeRequest(root, {
            proof: mintedProof({
              attemptedAt: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
              report: reportOf({
                verdict: 'FAILED',
                stoppedAt: 'VERIFY',
                phases: [
                  { phase: 'VERIFY', outcome: 'RAN', exitCode: 1, signal: null, outputTruncated: false, durationMs: 1 },
                ],
              }),
            }),
          }),
        );
        expect(result.recorded, `attempt ${i}: ${result.code}`).toBe(true);
      }
      const before = readFileSync(recordPath(root));
      const overflow = await recordPostMergeVerification(
        writeRequest(root, {
          proof: mintedProof({
            attemptedAt: '2026-09-01T00:00:00Z',
            report: reportOf({
              verdict: 'FAILED',
              stoppedAt: 'VERIFY',
              phases: [
                { phase: 'VERIFY', outcome: 'RAN', exitCode: 1, signal: null, outputTruncated: false, durationMs: 1 },
              ],
            }),
          }),
        }),
      );
      expect(overflow.code).toBe('ATTEMPT_HISTORY_FULL');
      expect(overflow.recorded).toBe(false);
      // Nothing was pushed out of the back.
      expect(readFileSync(recordPath(root))).toEqual(before);
      const loaded = loadPostMergeVerification(root, TASK, { taskId: TASK, repositoryRoot: root });
      expect(loaded.record?.attempts).toHaveLength(MAX_VERIFICATION_ATTEMPTS);
      expect(loaded.record?.attempts[0]?.attemptedAt).toBe('2026-08-10T00:00:00Z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses anything that is not a minted proof', async () => {
    const root = scratch();
    try {
      for (const proof of [
        null,
        undefined,
        {},
        { mergeCommit: MERGE, workspaceHeadCommit: MERGE, outcome: 'VERIFIED_PASS' },
        'VERIFIED_PASS',
      ]) {
        const result = await recordPostMergeVerification(writeRequest(root, { proof }));
        expect(result.code, JSON.stringify(proof)).toBe('VERIFICATION_NOT_PROVEN');
        expect(result.writeAttempt).toBe('NOT_ATTEMPTED');
      }
      expect(() => statSync(recordPath(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a proof about a different commit than the one being recorded for', async () => {
    const root = scratch();
    try {
      const result = await recordPostMergeVerification(
        writeRequest(root, {
          proof: mintedProof({ mergeCommit: OTHER, workspaceHeadCommit: OTHER }),
        }),
      );
      expect(result.code).toBe('SUBJECT_MISMATCH');
      expect(() => statSync(recordPath(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never replaces a document it cannot read', async () => {
    for (const [label, contents] of [
      ['not json', '{ nope'],
      ['wrong shape', JSON.stringify({ hello: 'world' })],
      ['a future version', JSON.stringify({ ...(recordOf() as object), verificationVersion: 99 })],
    ] as const) {
      const root = scratch();
      try {
        mkdirSync(postMergeVerificationDirectory(root), { recursive: true });
        writeFileSync(recordPath(root), contents, 'utf8');
        const before = readFileSync(recordPath(root));
        const result = await recordPostMergeVerification(writeRequest(root));
        expect(result.code, label).toBe('EXISTING_HISTORY_UNREADABLE');
        expect(readFileSync(recordPath(root)), label).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('reads an unopenable file as unreadable, never as one nobody wrote', () => {
    const root = scratch();
    try {
      const denied = () => {
        const error: NodeJS.ErrnoException = new Error('denied');
        error.code = 'EACCES';
        throw error;
      };
      expect(
        loadPostMergeVerification(root, TASK, { taskId: TASK, repositoryRoot: root }, denied).reading,
      ).toBe('MALFORMED');
      // And a genuine absence still reads as absence.
      expect(
        loadPostMergeVerification(root, TASK, { taskId: TASK, repositoryRoot: root }).reading,
      ).toBe('ABSENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a short read rather than parsing a fragment', async () => {
    const root = scratch();
    try {
      await recordPostMergeVerification(writeRequest(root));
      const short = (
        handle: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ): number => readSync(handle, buffer, offset, Math.max(1, Math.floor(length / 3)), position);
      // A reader that always returns a third of what was asked still completes,
      // because the loop continues — this is the control that the seam works.
      expect(
        loadPostMergeVerification(
          root,
          TASK,
          { taskId: TASK, repositoryRoot: root },
          (path) => openSync(path, 'r'),
          short,
        ).reading,
      ).toBe('VERIFICATION_HISTORY');
      // A reader that stops early is a torn file, not a smaller record.
      let calls = 0;
      const stops = (
        handle: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ): number => {
        calls += 1;
        return calls === 1 ? readSync(handle, buffer, offset, 10, position) : 0;
      };
      expect(
        loadPostMergeVerification(
          root,
          TASK,
          { taskId: TASK, repositoryRoot: root },
          (path) => openSync(path, 'r'),
          stops,
        ).reading,
      ).toBe('MALFORMED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to write where Git would not ignore the result', async () => {
    for (const [label, verdict] of [
      ['not ignored', 'NOT_IGNORED'],
      ['undetermined', 'UNDETERMINED'],
    ] as const) {
      const root = scratch();
      try {
        const result = await recordPostMergeVerification(
          writeRequest(root, { checkIgnored: async () => verdict as IgnoreVerdict }),
        );
        expect(result.code, label).toBe(
          verdict === 'NOT_IGNORED' ? 'RUNTIME_PATH_NOT_IGNORED' : 'RUNTIME_IGNORE_UNDETERMINED',
        );
        expect(() => statSync(recordPath(root))).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('asks about the staging name as well as the record name', async () => {
    const root = scratch();
    try {
      const asked: string[] = [];
      await recordPostMergeVerification(
        writeRequest(root, {
          checkIgnored: async (path) => {
            asked.push(path);
            return 'IGNORED';
          },
        }),
      );
      expect(asked).toHaveLength(2);
      expect(asked.some((p) => p.endsWith('.tmp-probe'))).toBe(true);
      expect(asked.some((p) => p.endsWith(`${TASK}.json`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a failed write as failed, and records nothing', async () => {
    const root = scratch();
    try {
      const result = await recordPostMergeVerification(
        writeRequest(root, {
          replace: () => {
            const error: NodeJS.ErrnoException = new Error('nope');
            error.code = 'EPERM';
            throw error;
          },
        }),
      );
      expect(result.code).toBe('WRITE_FAILED');
      expect(result.recorded).toBe(false);
      expect(result.writeAttempt).toBe('FAILED');
      expect(result.errnoCode).toBe('EPERM');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('survives a restart: what is written is read back as exactly what it was', async () => {
    const root = scratch();
    try {
      await recordPostMergeVerification(writeRequest(root));
      const onDisk = JSON.parse(readFileSync(recordPath(root), 'utf8')) as Record<string, unknown>;
      expect(onDisk['mergeCommit']).toBe(MERGE);
      expect(onDisk['subjectCommit']).toBe(HEAD);
      expect(onDisk['verificationVersion']).toBe(POST_MERGE_VERIFICATION_VERSION);
      expect(
        readPostMergeVerification(onDisk, { taskId: TASK, repositoryRoot: root }).reading,
      ).toBe('VERIFICATION_HISTORY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ── 8. What this slice must not touch ───────────────────────────────────── */

describe('post-merge verification changes no execution state and no ledger', () => {
  it('leaves the task state byte-identical and a settled entry provable', async () => {
    const repo = realRepo();
    try {
      const state = {
        schemaVersion: 1,
        taskId: TASK,
        repositoryId: 'fixture-repo',
        repositoryRoot: repo.root,
        worktreePath: repo.root,
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
      };
      const saved = saveTaskState(state, { repositoryRoot: repo.root });
      expect(saved.code, JSON.stringify(saved)).toBe('SAVED');
      if (!saved.ok) throw new Error('fixture state not saved');
      const before = loadTaskState(repo.root, TASK);
      if (!before.ok) throw new Error('fixture state unreadable');
      const stateBytes = readFileSync(saved.path);

      const entry: BlockTaskEntry = {
        taskId: TASK,
        disposition: 'SETTLED',
        evidenceRevision: before.revision,
        baseCommit: OTHER,
        resultCommit: HEAD,
      };
      expect(proveBlockTaskEntry(repo.root, entry).code).toBe('PROVEN');

      // Now verify, for real, end to end.
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner } = recordingRunner();
      const result = await verifyMergeForDelivery(
        repo.repository,
        { taskId: TASK, ...IDENTITY, deliveryCommit: HEAD },
        { git: runGitCommand, verify: runner, lease: repo.lease, now: () => new Date(AT) },
      );
      expect(result.outcome, JSON.stringify(result)).toBe('VERIFICATION_ATTEMPTED');
      const recorded = await recordPostMergeVerification({
        repositoryRoot: repo.root,
        taskId: TASK,
        proof: result.proof,
        expectedSubjectCommit: HEAD,
        expectedMergeCommit: repo.mergeCommit,
        expectedHost: IDENTITY.host,
        expectedOwner: IDENTITY.owner,
        expectedName: IDENTITY.name,
        expectedPullRequestNumber: PR,
        checkIgnored: async () => 'IGNORED',
      });
      // The positive control: something really was written, so the assertions
      // below are about a verification that happened.
      expect(recorded.code).toBe('HISTORY_STARTED');

      // Byte-identical. Not "equivalent", not "unchanged in the fields we care
      // about" — the revision is a digest over exactly these bytes.
      expect(readFileSync(saved.path)).toEqual(stateBytes);
      const after = loadTaskState(repo.root, TASK);
      if (!after.ok) throw new Error('state unreadable after');
      expect(after.revision).toBe(before.revision);
      expect(after.state.state).toBe('READY_FOR_PR');
      // `currentCommit` stays H. It is emphatically not advanced to M.
      expect(after.state.currentCommit).toBe(HEAD);
      expect(after.state.currentCommit).not.toBe(repo.mergeCommit);
      // And the settled entry still proves.
      expect(proveBlockTaskEntry(repo.root, entry).code).toBe('PROVEN');

      // The negative controls, so the assertions above are instruments rather
      // than restatements of a default.
      expect(
        proveBlockTaskEntry(repo.root, { ...entry, evidenceRevision: 'f'.repeat(64) }).code,
      ).not.toBe('PROVEN');
      expect(
        proveBlockTaskEntry(repo.root, { ...entry, resultCommit: repo.mergeCommit }).code,
      ).not.toBe('PROVEN');
    } finally {
      repo.dispose();
    }
  });

  it('reaches no state writer, no ledger writer and no agent', () => {
    for (const file of [
      'src/deliver/verify-merge.ts',
      'src/deliver/post-merge-verification.ts',
      'src/deliver/post-merge-verification-store.ts',
      'src/deliver/internal/post-merge-verification-proof.ts',
      'src/worktree/verification-workspace.ts',
      'src/verify/verification-profile.ts',
    ]) {
      const source = codeOnly(file);
      expect(source.length, file).toBeGreaterThan(300);
      for (const forbidden of [
        'saveTaskState',
        'advanceTaskState',
        'recordAgentInterruption',
        'settleBlockTask',
        'block-store',
        'block-progress',
        'runClaudeWriter',
        'runCodexReviewer',
        'leasedAgent',
        'DELIVERY_COMPLETE',
      ]) {
        expect(source, `${file} must not reach ${forbidden}`).not.toContain(forbidden);
      }
      // A whole word, because `COMPLETED` is the store's own write-attempt
      // vocabulary and a substring match reported it as the task state.
      expect(source, `${file} must not name the COMPLETE state`).not.toMatch(/COMPLETE/);
    }
    // Positive controls: the modules that DO write those still do.
    expect(codeOnly('src/state/state-store.ts')).toContain('saveTaskState');
    expect(codeOnly('src/state/advance-state.ts')).toContain('advanceTaskState');
  });

  it('performs no forge mutation and creates no grant', () => {
    for (const file of [
      'src/deliver/verify-merge.ts',
      'src/deliver/post-merge-verification-store.ts',
      'src/worktree/verification-workspace.ts',
    ]) {
      const source = codeOnly(file);
      for (const forbidden of [
        'mergePullRequest',
        'createPullRequest',
        'publishDeliveryHead',
        'mintMergeGrant',
        'mintHeadPublicationGrant',
        'mintPullRequestCreationGrant',
        "'push'",
        'ForgeMutationRunner',
        'ForgeMergeRunner',
      ]) {
        expect(source, `${file} must not reach ${forbidden}`).not.toContain(forbidden);
      }
    }
    // Positive control: the module that does merge still does.
    expect(codeOnly('src/cli/delivery-command.ts')).toContain('mergePullRequest');
  });

  it('names the merge receipt as read-only, and never writes one', () => {
    const source = codeOnly('src/deliver/verify-merge.ts');
    // The receipt is the authority for the subject, so it is read…
    expect(source).toContain('loadMergeReconciliation');
    // …and never written. Slice 8's record stays immutable.
    expect(source).not.toContain('recordMergeReconciliation');
  });

  it('takes the execution lease in exactly one place, for exactly one act', () => {
    // The one guarantee this slice deliberately narrowed, and it is stated here
    // — once — rather than in the five slice files that each used to carry it.
    //
    // Until now **no** file on the delivery surface named a lease acquisition,
    // and `tests/v4-03…`, `v4-04…`, `v4-05…`, `v4-06…` and `v4-07…` each said
    // so. `--verify-merge` is the first delivery act that starts the
    // repository's own build and test commands, and two existing contracts
    // already govern that: `loop/leased-spawns.ts` names `git worktree add` and
    // `git worktree remove` as productive spawns fenced immediately before the
    // effect, and `tests/v2-07l-execution-lease.test.ts` makes that module the
    // only value importer of `verify/verify-command.js` — so the only
    // production `VerificationRunner` is `leasedVerify`, which demands an
    // `ExecutionLeaseAuthority`. Running the gate unleased would mean amending
    // a structural pin, not skipping a formality.
    //
    // What replaces the blanket ban is stronger than the sentence it came from.
    const SURFACE = [
      ...walk('src/deliver'),
      'src/cli/delivery-command.ts',
      'src/cli/render-delivery-observation.ts',
    ].sort();
    expect(SURFACE.length).toBeGreaterThanOrEqual(20);

    // One file, derived from the tree rather than named.
    expect(SURFACE.filter((file) => /\bacquire\w*ExecutionLease\s*\(/.test(codeOnly(file)))).toEqual(
      ['src/cli/delivery-command.ts'],
    );

    // Nothing under `src/deliver/` at all. The ladder and every store take
    // lease *evidence* they were handed; none of them becomes the repository's
    // writer on its own account.
    expect(
      walk('src/deliver').filter((file) => /\bacquire\w*ExecutionLease\s*\(/.test(codeOnly(file))),
    ).toEqual([]);

    // Once each. A second acquire is a second window, and an acquire without a
    // matching release leaves the repository claimed.
    const cli = codeOnly('src/cli/delivery-command.ts');
    expect(cli.match(/\bacquireRepositoryExecutionLease\s*\(/g)).toHaveLength(1);
    expect(cli.match(/\breleaseRepositoryExecutionLease\s*\(/g)).toHaveLength(1);
    // Given back in a `finally`, so no path out — including a throw — keeps it.
    expect(cli).toMatch(/finally\s*\{[\s\S]{0,600}?releaseRepositoryExecutionLease/);

    // And the four sibling files carry a pointer here rather than a copy, so a
    // reader who looks where the clause used to be is sent to one place. The
    // pointer names this case by its title; if the title changes, this fails.
    for (const file of [
      'tests/v4-03-delivery-evidence.test.ts',
      'tests/v4-04-delivery-decision.test.ts',
      'tests/v4-05-delivery-head-publication.test.ts',
      'tests/v4-06-pull-request-creation.test.ts',
      'tests/v4-07-explicit-merge-effect.test.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('takes the execution lease in exactly one place');
      expect(source, file).toContain('tests/v4-09-post-merge-verification.test.ts');
      // And none of them still asserts the retired blanket ban.
      expect(source, file).not.toMatch(/not\.toMatch\(\/\\bacquire\\w\*ExecutionLease/);
    }
  });

  it('runs Git only through the seam it was handed', () => {
    // The whole point of the fence: nothing here reaches a raw runner. The
    // repository-wide pin in tests/v2-07l-execution-lease.test.ts owns the
    // general statement; this is the local one for the new modules.
    for (const file of [
      'src/deliver/verify-merge.ts',
      'src/worktree/verification-workspace.ts',
    ]) {
      const source = codeOnly(file);
      expect(source, file).not.toContain('runGitCommand');
      expect(source, file).not.toContain('runVerificationCommand');
      expect(source, file).not.toContain('child_process');
      expect(source, file).not.toContain('spawnSync');
    }
  });
});
