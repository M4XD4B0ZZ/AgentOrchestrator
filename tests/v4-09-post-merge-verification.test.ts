import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
import { describe, expect, it, vi } from 'vitest';

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
  MAX_MERGE_RECONCILIATION_BYTES,
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
  NOT_CONTACTED_TRAILER,
  VERIFICATION_TRAILER,
} from '../src/cli/render-delivery-observation.js';
import {
  registerDeliveryCommand,
  ATTENDED_OPTION_DESCRIPTION,
  DELIVERY_COMMAND_DESCRIPTION,
  VERIFY_MERGE_OPTION_DESCRIPTION,
} from '../src/cli/delivery-command.js';
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
 * The same stripper the sibling files use, and the same limit — stated
 * accurately, because a review measured the usual wording as false here. A `//`
 * inside a string literal IS read as a comment, and `walk('src')` scans one
 * file that contains one: `src/repo/branch-name.ts`, whose
 * `name.includes('//')` loses its tail.
 *
 * That costs nothing for what this file asks. Every use is an *absence*
 * assertion — "this source does not name X" — and over-stripping can only make
 * a forbidden name harder to find, never invent one; the file it affects is not
 * one any of those assertions is about. The positive controls beside each use
 * would fail if a file emptied out entirely.
 */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A temporary directory whose path this build will accept as a Git argument.
 *
 * `realpathSync.native` is not decoration, and CI is what proved it. On the
 * GitHub Windows runner `os.tmpdir()` answers with an 8.3 short path —
 * `C:\Users\RUNNER~1\AppData\Local\Temp` — and `~` is outside `SAFE_ARG_PATTERN`,
 * so every path derived from it is refused as `WORKSPACE_PATH_UNSAFE`. Fourteen
 * real-Git cases passed on a developer machine and failed on CI with
 * `IDENTITY_UNDERIVABLE`, which is the product behaving exactly as
 * `workspace-identity.ts` documents ("a repository checked out under
 * `C:\Users\Ada Lovelace\src` cannot be given a workspace, and says so") and the
 * fixture standing in the wrong place.
 *
 * Resolving to the long form fixes it. The assertion below is the part that
 * matters for the next environment: if a host ever hands back a temporary path
 * this build will not accept, these cases must fail as a fixture problem rather
 * than as fourteen confusing assertion failures about workspaces.
 */
function scratchRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const derived = deriveVerificationWorkspaceIdentity(root, TASK);
  if (!derived.ok) {
    throw new Error(
      `fixture root is not usable by this build (${derived.code}): ${root}. ` +
        'The host temporary directory is not shell-inert; see scratchRoot.',
    );
  }
  return root;
}

function scratch(prefix = 'ao-v409-'): string {
  const root = scratchRoot(prefix);
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
/**
 * One repository, built once, and copied for every fixture that needs one.
 *
 * ── Why this is not eight `git` calls per fixture ──────────────────────────
 *
 * It was, and CI measured the cost. This file makes 27 real repositories; at
 * ~8 processes each that is over 200 `git` invocations, and on the Windows
 * runner the file took 107 seconds against 41 here. A solo run flatters a new
 * slice — the gate runs files in parallel, and the extra load pushed a 10-second
 * hook in `tests/v2-09-dependent-commit-chain.test.ts`, a 190-second file this
 * slice never touched, over its limit. Three of its cases were skipped and the
 * whole gate failed.
 *
 * So the template is built once and `cpSync`-ed. A plain repository's `.git`
 * holds no absolute paths, so a copy is a working repository with the same two
 * commits — which also makes `baseCommit` and `mergeCommit` constants rather
 * than something each fixture has to ask Git for.
 *
 * Only `--git-common-dir` is still read per fixture: it is the execution
 * lease's key, and deriving it here rather than asking Git would be this file
 * inventing the one value the lease is identified by.
 */
let templateRepo: { path: string; baseCommit: string; mergeCommit: string } | null = null;

function repositoryTemplate(): { path: string; baseCommit: string; mergeCommit: string } {
  if (templateRepo !== null) return templateRepo;
  const path = scratchRoot('ao-v409-template-');
  git(path, 'init', '--quiet', '-b', BASE, '.');
  git(path, 'config', 'user.email', 'fixture@example.invalid');
  git(path, 'config', 'user.name', 'fixture');
  writeFileSync(join(path, '.gitignore'), 'node_modules/\ndist/\n.agent-orchestrator/\n', 'utf8');
  writeFileSync(join(path, 'tracked.txt'), 'base\n', 'utf8');
  git(path, 'add', '-A');
  git(path, 'commit', '--quiet', '-m', 'base');
  writeFileSync(join(path, 'tracked.txt'), 'merged\n', 'utf8');
  git(path, 'add', '-A');
  git(path, 'commit', '--quiet', '-m', 'the merge');
  // Both object names in one process rather than two `rev-parse` calls.
  const [mergeCommit, baseCommit] = git(path, 'log', '--format=%H', '-2').split('\n');
  if (mergeCommit === undefined || baseCommit === undefined) {
    throw new Error('fixture template has fewer than two commits');
  }
  templateRepo = { path, baseCommit, mergeCommit };
  return templateRepo;
}

/** A working copy of the template, at a fresh scratch root. */
function copyTemplate(prefix: string): { root: string; baseCommit: string; mergeCommit: string } {
  const template = repositoryTemplate();
  const root = scratchRoot(prefix);
  cpSync(template.path, root, { recursive: true });
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  return { root, baseCommit: template.baseCommit, mergeCommit: template.mergeCommit };
}

function realRepo(): RealRepo {
  const { root, baseCommit, mergeCommit } = copyTemplate('ao-v409-git-');
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

  it('reads facts only through an accessor that cannot answer by throwing', () => {
    // A correction, and the limit is stated rather than dressed up.
    //
    // This case used to build an "impostor", add it to a WeakSet of its own,
    // and claim to be measuring the try/catch inside
    // `postMergeVerificationFactsOf`. A review measured that the impostor never
    // entered the module-private registry, so `holds` refused it and the
    // function returned `null` at its guard clause — the catch was never
    // entered, and deleting it left the case green.
    //
    // The honest position: the catch is **unreachable from outside this
    // module**. Reaching it needs a value the registry accepts whose private
    // field was never installed, and the only route to that is capturing
    // `WeakSet.prototype.add` before the first mint — which a test importing
    // the module cannot do, because the module is already loaded. It stays for
    // the reason `lease/execution-lease.ts` records: that capture has been
    // performed against this codebase's other opaque artefacts, and a check
    // that answers by throwing is not answering.
    //
    // What IS measured here is the part that is reachable, with both halves.
    const impostor = Object.create(PostMergeVerificationEvidence.prototype) as object;
    // `factsOf` really does throw for such a value — so the catch is guarding
    // something real, even though nothing outside can drive it.
    expect(() => PostMergeVerificationEvidence.factsOf(impostor as never)).toThrow();
    // And the safe accessor refuses it without throwing.
    expect(postMergeVerificationFactsOf(impostor)).toBeNull();
    expect(isPostMergeVerificationProof(impostor)).toBe(false);
    // The positive control: a genuine artefact reads.
    expect(postMergeVerificationFactsOf(mintedProof())).not.toBeNull();
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

  it('holds the worst record the schema can represent inside the byte budget', () => {
    // Recomputed from the schema's OWN maxima, not from a plausible-looking
    // fixture. Two things made this case worth rewriting:
    //
    //  - the first version used a 200-character `repositoryRoot` where the
    //    schema admits 4,096, so it measured a comfortable record rather than
    //    the worst one;
    //  - a review then claimed the true worst case was 19,271 bytes and asked
    //    for the budget to be raised. Measuring it refuted that — it is 11,083
    //    — and the budget was left alone. A finding is a claim; this is the
    //    measurement.
    const root = `D:/${'x'.repeat(4093)}`;
    const taskId = 't'.repeat(128);
    const subject = subjectOf({ taskId, repositoryRoot: root });
    const worst = recordOf(
      {
        taskId,
        repositoryRoot: root,
        host: 'h'.repeat(253),
        owner: 'o'.repeat(128),
        name: 'n'.repeat(128),
        pullRequestNumber: 2_147_483_647,
        attempts: Array.from({ length: MAX_VERIFICATION_ATTEMPTS }, () =>
          attemptOf({
            // The longest instant this build's ISO grammar admits, the longest
            // outcome member, and both bounded strings at 32.
            attemptedAt: '2026-12-31T23:59:59.999999999+01:00',
            outcome: 'VERIFICATION_NOT_ESTABLISHED',
            stoppedAt: 'V'.repeat(32),
            exitCode: -2_147_483_648,
            signal: 'S'.repeat(32),
            phasesRun: 8,
          }),
        ),
      },
      subject,
    );
    // The fixture really is at the maxima, so what follows measures the worst
    // case rather than whatever this test happened to build.
    expect(PostMergeVerificationSchema.safeParse(worst).success).toBe(true);
    const bytes = Buffer.byteLength(`${JSON.stringify(worst, null, 2)}\n`, 'utf8');
    // A floor as well as a ceiling. Without the floor a future edit that made
    // the fixture smaller would keep passing while measuring nothing — which is
    // exactly how the first version of this case survived.
    expect(bytes).toBeGreaterThan(10_000);
    expect(bytes).toBeLessThanOrEqual(MAX_POST_MERGE_VERIFICATION_BYTES);
    // And it round-trips: the budget is enforced on the file's stat size, so a
    // record inside it must be one this build reads back.
    expect(readPostMergeVerification(worst, subject).reading).toBe('VERIFICATION_HISTORY');
  });

  it('refuses a schema-legal record whose bytes exceed the budget', () => {
    // The byte gate is **load-bearing, not redundant with the schema**, and
    // this is what proves it. A schema `.max()` bounds UTF-16 code units; a
    // code unit is not a byte, so a perfectly valid record built from
    // non-Latin characters is larger than the budget.
    //
    // Two reviewers computed different worst cases — 11,083 and 19,271 — and
    // both were right about their own alphabet. The gap is this case.
    const cjkRoot = '一'.repeat(4096);
    const subject = subjectOf({ repositoryRoot: cjkRoot });
    const oversized = recordOf(
      {
        repositoryRoot: cjkRoot,
        attempts: Array.from({ length: MAX_VERIFICATION_ATTEMPTS }, () =>
          attemptOf({
            attemptedAt: '2026-12-31T23:59:59.999999999+01:00',
            outcome: 'VERIFICATION_NOT_ESTABLISHED',
            stoppedAt: 'V'.repeat(32),
            exitCode: -2_147_483_648,
            signal: 'S'.repeat(32),
            phasesRun: 8,
          }),
        ),
      },
      subject,
    );

    // It really is legal, and really does read in memory — so the refusal below
    // is attributable to the byte gate and to nothing else.
    expect(PostMergeVerificationSchema.safeParse(oversized).success).toBe(true);
    expect(readPostMergeVerification(oversized, subject).reading).toBe('VERIFICATION_HISTORY');

    const bytes = Buffer.byteLength(`${JSON.stringify(oversized, null, 2)}\n`, 'utf8');
    expect(bytes).toBeGreaterThan(MAX_POST_MERGE_VERIFICATION_BYTES);

    // And the product path never gets here: slice 8's receipt budget is
    // tighter, so a repository with a root this long is refused one slice
    // earlier. Measured, not asserted — the two thresholds are computed.
    const crossesAt = (limit: number, build: (root: string) => unknown): number => {
      for (let n = 1; n <= 4096; n += 1) {
        const size = Buffer.byteLength(
          `${JSON.stringify(build('一'.repeat(n)), null, 2)}\n`,
          'utf8',
        );
        if (size > limit) return n;
      }
      return Number.POSITIVE_INFINITY;
    };
    const verificationThreshold = crossesAt(MAX_POST_MERGE_VERIFICATION_BYTES, (root) =>
      recordOf({ repositoryRoot: root }, subjectOf({ repositoryRoot: root })),
    );
    const receiptThreshold = crossesAt(MAX_MERGE_RECONCILIATION_BYTES, (root) => {
      const payload: MergeReconciliationPayload = {
        reconciliationVersion: MERGE_RECONCILIATION_VERSION,
        taskId: TASK,
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
      return {
        ...payload,
        binding: mergeReconciliationBinding({ taskId: TASK, repositoryRoot: root }, payload),
      };
    });
    expect(receiptThreshold).toBeLessThan(verificationThreshold);
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
      const mismatch = await proveVerificationWorkspaceAt(
        runGitCommand,
        derived.identity,
        repo.baseCommit,
      );
      expect(mismatch.proof).toBe('HEAD_MISMATCH');
      expect(
        (await proveVerificationWorkspaceAt(runGitCommand, derived.identity, MERGE)).proof,
      ).toBe('HEAD_MISMATCH');

      // `observedHead` is Git's READING, not the expectation echoed back — and
      // this is where that is measurable. On a mismatch the two values differ,
      // so a version that reported the expectation would say `baseCommit` here.
      //
      // It is the pin for the defect three review lenses found: the value handed
      // to the mint used to be the commit this process had asked for, which made
      // the mint's refusal compare a value with itself. A mutant that puts
      // `expectedCommit` back in its place dies on this line.
      expect(mismatch.observedHead).toBe(repo.mergeCommit);
      expect(mismatch.observedHead).not.toBe(repo.baseCommit);

      // On the matching path it is the same reading, cross-checked against a
      // `rev-parse` this test ran itself rather than against the value it asked
      // for.
      const matching = await proveVerificationWorkspaceAt(
        runGitCommand,
        derived.identity,
        repo.mergeCommit,
      );
      expect(matching.observedHead).toBe(git(derived.identity.workspacePath, 'rev-parse', 'HEAD'));
      expect(created.ok && created.workspace.headCommit).toBe(
        git(derived.identity.workspacePath, 'rev-parse', 'HEAD'),
      );

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

  it('refuses a checkout of a different repository parked at the derived path', async () => {
    // The `--git-common-dir` test, which the module's own header calls "not
    // optional and not a formality" — and which a review measured as killed by
    // no test at all. Without it every other probe here can be satisfied by a
    // checkout of a *different* repository sitting at this path: same shape,
    // same detached HEAD, same clean status, and a commit that is not ours.
    //
    // The fixture is exactly that. A second repository is built whose HEAD
    // commit has the same content, and one of ITS worktrees is placed at our
    // derived path. Two worktrees of one repository share a common directory;
    // no two repositories do.
    const repo = realRepo();
    const foreign = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-v409-foreign-')));
    try {
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');

      git(foreign, 'init', '--quiet', '-b', BASE, '.');
      git(foreign, 'config', 'user.email', 'other@example.invalid');
      git(foreign, 'config', 'user.name', 'other');
      writeFileSync(join(foreign, 'tracked.txt'), 'merged\n', 'utf8');
      git(foreign, 'add', '-A');
      git(foreign, 'commit', '--quiet', '-m', 'the merge');
      const foreignHead = git(foreign, 'rev-parse', 'HEAD');
      mkdirSync(derived.identity.workspaceParent, { recursive: true });
      git(foreign, 'worktree', 'add', '--quiet', '--detach', derived.identity.workspacePath, foreignHead);

      // Every other probe is satisfied: the path is right, it is detached, it
      // is clean, and HEAD is the commit we are about to ask about.
      expect(git(derived.identity.workspacePath, 'rev-parse', 'HEAD')).toBe(foreignHead);
      expect(git(derived.identity.workspacePath, 'status', '--porcelain')).toBe('');

      const proved = await proveVerificationWorkspaceAt(
        runGitCommand,
        derived.identity,
        foreignHead,
      );
      expect(proved.proof).toBe('FOREIGN_REPOSITORY');
      expect(proved.canonicalWorkspacePath).toBeNull();

      // The positive control, so the refusal above is attributable to the
      // common-directory test rather than to the fixture being broken: one of
      // OUR worktrees at the same path proves.
      git(foreign, 'worktree', 'remove', '--force', derived.identity.workspacePath);
      const ours = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(ours.code).toBe('WORKSPACE_READY');
      expect(
        (await proveVerificationWorkspaceAt(runGitCommand, derived.identity, repo.mergeCommit))
          .proof,
      ).toBe('AT_COMMIT');
      await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
    } finally {
      try {
        git(foreign, 'worktree', 'prune');
      } catch {
        /* teardown only */
      }
      rmSync(foreign, { recursive: true, force: true });
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

  it('does not let another commit’s recorded pass suppress this commit’s run', async () => {
    // The ladder skips the gate when a pass for **this** commit under **this**
    // profile is already on disk. A counter-proof measured the commit half of
    // that as unpinned: dropping `history.record.mergeCommit === mergeCommit`
    // left the whole suite green, so a history about an entirely different
    // merge would have suppressed this one.
    const repo = realRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });

      // A history that passed — for a DIFFERENT commit, under this profile.
      const other = await recordPostMergeVerification({
        repositoryRoot: repo.root,
        taskId: TASK,
        proof: mintedProof({ mergeCommit: OTHER, workspaceHeadCommit: OTHER }),
        expectedSubjectCommit: HEAD,
        expectedMergeCommit: OTHER,
        expectedHost: IDENTITY.host,
        expectedOwner: IDENTITY.owner,
        expectedName: IDENTITY.name,
        expectedPullRequestNumber: PR,
        checkIgnored: async () => 'IGNORED',
      });
      expect(other.code).toBe('HISTORY_STARTED');

      const { runner, calls } = recordingRunner();
      const result = await verifyMergeForDelivery(
        repo.repository,
        { taskId: TASK, ...IDENTITY, deliveryCommit: HEAD },
        { git: runGitCommand, verify: runner, lease: repo.lease, now: () => new Date(AT) },
      );

      // The gate ran. A pass about another object is not about this one.
      expect(result.outcome).toBe('VERIFICATION_ATTEMPTED');
      expect(calls).toHaveLength(1);
      expect(result.mergeCommit).toBe(repo.mergeCommit);

      // The control: with the history about THIS commit, it is not run again.
      const mine = await recordPostMergeVerification({
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
      // The stored history is about `OTHER`, so this is refused rather than
      // appended — which is the store's own guard, and is why the second run
      // below still reaches the gate.
      expect(mine.code).toBe('CONFLICTING_HISTORY');
    } finally {
      repo.dispose();
    }
  });

  it('refuses to create or remove without the execution lease, at the effect', async () => {
    const repo = realRepo();
    try {
      // A workspace that really exists, so the removal below has a real effect
      // to be refused. Without this the removal stops at `NOTHING_REGISTERED`
      // and the case would measure the ownership proof rather than the lease —
      // which is what an earlier version of it did.
      const first = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(first.code).toBe('WORKSPACE_READY');
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');

      // A released lease is not held. The gate is inside each function, not in
      // a caller, so a lease lost between a caller's check and the effect is
      // still caught.
      releaseRepositoryExecutionLease(repo.lease);

      const removal = await removeVerificationWorkspace(repo.repository, TASK, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(removal.code).toBe('EXECUTION_LEASE_NOT_HELD');
      // And nothing was deleted.
      expect(statSync(derived.identity.workspacePath).isDirectory()).toBe(true);

      // Creation is refused for the same reason, and creates nothing.
      git(repo.root, 'worktree', 'remove', '--force', derived.identity.workspacePath);
      const created = await createVerificationWorkspace(repo.repository, TASK, repo.mergeCommit, {
        git: runGitCommand,
        lease: repo.lease,
      });
      expect(created.code).toBe('EXECUTION_LEASE_NOT_HELD');
      expect(created.ok).toBe(false);
      if (created.ok) throw new Error('unreachable');
      expect(created.residue).toBe(false);
      expect(() => statSync(derived.identity.workspacePath)).toThrow();
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

  it('re-proves HEAD immediately before the gate, and refuses if it moved', async () => {
    // The window this exists for, made reachable.
    //
    // The first proof describes the moment the worktree was made; this one
    // describes the moment before a process is started in it, and the two are
    // separated by however long the steps between them take. A counter-proof
    // measured the second proof as UNKILLED without this case: nothing changes
    // between them in an ordinary fixture, so removing it was unobservable —
    // the "an absence assertion is vacuous until the mutant dies" shape.
    //
    // The seam answers the SECOND `rev-parse --verify HEAD` with a different
    // commit, which is what a concurrent actor moving the checkout would look
    // like from here.
    const repo = realRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      let headReads = 0;
      const movingHead = async (cwd: string, args: readonly string[]) => {
        const result = await runGitCommand(cwd, args);
        const isHeadRead =
          args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD');
        if (!isHeadRead) return result;
        headReads += 1;
        if (headReads !== 2) return result;
        return { ...result, stdout: repo.baseCommit };
      };

      const { runner, calls } = recordingRunner();
      const result = await verifyMergeForDelivery(repo.repository, subject(), {
        git: movingHead,
        verify: runner,
        lease: repo.lease,
        now: () => new Date(AT),
      });

      // The first proof really happened, so this is a measurement of the second
      // one rather than of a run that fell over earlier.
      expect(headReads).toBe(2);
      expect(result.outcome).toBe('WORKSPACE_NOT_ESTABLISHED');
      expect(result.mergeCommit).toBe(repo.mergeCommit);
      // Nothing was started. This is the assertion that matters: the gate must
      // not run in a tree whose HEAD is no longer the subject.
      expect(calls).toEqual([]);
      expect(result.proof).toBeNull();
      // And the workspace was still cleaned up.
      expect(workspaceIsGone(result.workspaceRemoval ?? 'REMOVAL_FAILED')).toBe(true);
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

  it('states honestly which of the two subject guards can be reached', () => {
    // A correction. This case used to assert
    // `facts.workspaceHeadCommit === facts.mergeCommit` on a minted proof and
    // call itself a test of the store's belt-and-braces line. It reached no
    // store, and its assertion restated the invariant the mint had just
    // enforced — it could not fail while the mint was intact, which is the
    // definition of a test that pins nothing. A review measured that, and a
    // counter-proof measured the same thing from the other side: each of the
    // store's two subject comparisons survives on its own.
    //
    // The truthful statement is that they are a PAIR. Through the mint — the
    // only route by which a proof exists — the two fields are equal by
    // construction, so either comparison alone refuses everything the other
    // would. What can be measured is that removing *both* is caught, and that
    // is what the store's own cases below do.
    //
    // What this case pins is the property that makes the pair redundant, so
    // that a change which broke it would land here rather than silently make
    // the store's second line load-bearing without anyone noticing.
    for (const over of [
      {},
      { report: reportOf({ verdict: 'FAILED' as const, stoppedAt: 'VERIFY' }) },
      { attemptedAt: '2026-12-31T23:59:59.999999999+01:00' },
    ]) {
      const facts = postMergeVerificationFactsOf(mintedProof(over));
      expect(facts, JSON.stringify(over)).not.toBeNull();
      expect(facts?.workspaceHeadCommit).toBe(facts?.mergeCommit);
    }
    // And the mint really is the only route: a proof for a differing pair does
    // not exist, so no fixture can drive the store's two comparisons apart.
    expect(mintPostMergeVerification(attemptedOf({ workspaceHeadCommit: OTHER }))).toBeNull();
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
      // `recorded` is FALSE here, and the field's own documentation is why: it
      // says whether the history now contains **this attempt**, and it does not
      // — an earlier passing one is what satisfied the request. A review found
      // this returning `true`, and the case that named this arm asserted only
      // the code, so nothing caught it.
      expect(repeat.recorded).toBe(false);

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
      // The seeded attempt is a FAILURE, deliberately.
      //
      // An earlier version of this case seeded a pass and then accepted either
      // `CONFLICTING_HISTORY` or `ALREADY_VERIFIED`. A review built the mutant
      // that deletes the `sameDelivery` refusal and watched the suite stay
      // green: without that guard the run falls through to `hasPassFor` and
      // answers `ALREADY_VERIFIED`, which the assertion allowed. An assertion
      // that accepts the mutant's answer is not a test of the guard.
      //
      // With a failing attempt on disk, `hasPassFor` is false for every
      // profile, so `CONFLICTING_HISTORY` is the only correct answer and the
      // mutant produces `ATTEMPT_RECORDED` instead — which this fails on.
      const failing = mintedProof({
        report: reportOf({
          verdict: 'FAILED',
          stoppedAt: 'VERIFY',
          phases: [
            { phase: 'VERIFY', outcome: 'RAN', exitCode: 1, signal: null, outputTruncated: false, durationMs: 1 },
          ],
        }),
      });
      expect((await recordPostMergeVerification(writeRequest(root, { proof: failing }))).code).toBe(
        'HISTORY_STARTED',
      );
      const before = readFileSync(recordPath(root));

      for (const over of [
        {
          expectedMergeCommit: OTHER,
          proof: mintedProof({ mergeCommit: OTHER, workspaceHeadCommit: OTHER }),
        },
        { expectedSubjectCommit: OTHER },
        { expectedPullRequestNumber: 64 },
        { expectedOwner: 'someone' },
        { expectedHost: 'github.example' },
        { expectedName: 'other' },
      ]) {
        const result = await recordPostMergeVerification(writeRequest(root, over));
        expect(result.code, `${JSON.stringify(Object.keys(over))}`).toBe('CONFLICTING_HISTORY');
        expect(result.recorded).toBe(false);
        expect(result.writeAttempt).toBe('NOT_ATTEMPTED');
      }
      // Every one of them left the bytes alone.
      expect(readFileSync(recordPath(root))).toEqual(before);

      // The positive control: with the header agreeing, the same request is
      // recorded — so the refusals above are attributable to the header rather
      // than to the run stopping somewhere earlier.
      expect((await recordPostMergeVerification(writeRequest(root))).code).toBe('ATTEMPT_RECORDED');
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

  it('refuses a file larger than the budget, from its size on disk', () => {
    // The byte gate on the READ side, driven against a real file. A
    // counter-proof measured it unpinned: nothing in this suite ever put an
    // oversized document on disk, so removing the check changed no outcome.
    const root = scratch();
    try {
      mkdirSync(postMergeVerificationDirectory(root), { recursive: true });
      const path = join(postMergeVerificationDirectory(root), `${TASK}.json`);
      const subject = { taskId: TASK, repositoryRoot: root };
      // Valid in every other respect: this build wrote the shape, and the
      // binding is genuine. Only its size is wrong.
      const padded = recordOf(
        {
          repositoryRoot: root,
          attempts: Array.from({ length: MAX_VERIFICATION_ATTEMPTS }, () =>
            attemptOf({ stoppedAt: null }),
          ),
        },
        subject,
      );
      writeFileSync(path, `${JSON.stringify(padded, null, 2)}
${' '.repeat(MAX_POST_MERGE_VERIFICATION_BYTES)}`, 'utf8');
      expect(statSync(path).size).toBeGreaterThan(MAX_POST_MERGE_VERIFICATION_BYTES);
      expect(loadPostMergeVerification(root, TASK, subject).reading).toBe('MALFORMED');

      // The control: the same document inside the budget reads back.
      writeFileSync(path, `${JSON.stringify(padded, null, 2)}
`, 'utf8');
      expect(statSync(path).size).toBeLessThanOrEqual(MAX_POST_MERGE_VERIFICATION_BYTES);
      expect(loadPostMergeVerification(root, TASK, subject).reading).toBe('VERIFICATION_HISTORY');
    } finally {
      rmSync(root, { recursive: true, force: true });
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
      // The reader fills the buffer COMPLETELY and then under-reports by one
      // byte, which is what makes this case kill the guard rather than pass by
      // coincidence.
      //
      // The obvious fixture — read ten bytes, then stop — is measured to prove
      // nothing: without the `read !== size` check the ten-byte prefix is not
      // valid JSON either, so both the guarded and the unguarded build answer
      // MALFORMED and the mutant survives. Here the bytes ARE the whole
      // document; only the count is short. Drop the guard and
      // `buffer.subarray(0, size - 1)` is the record minus its trailing
      // newline — valid JSON, a valid record, and read as VERIFICATION_HISTORY.
      // That is a torn file accepted as a whole one, which is exactly what the
      // guard exists to refuse.
      const stops = (
        handle: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ): number => {
        calls += 1;
        if (calls > 1) return 0;
        const read = readSync(handle, buffer, offset, length, position);
        return read > 0 ? read - 1 : read;
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

/* ── 7b. The command, end to end, with a real repository and a real lease ── */

describe('the delivery command verifies only when asked, and takes the lease to do it', () => {
  /**
   * A real repository with **no** lease held, so the command has to take one.
   *
   * What is real: the Git repository, `acquireRepositoryExecutionLease`,
   * `leasedGit`, the `check-ignore` probe, the worktree operations and the
   * store. What is substituted, stated as the list it is rather than as a
   * count a review measured wrong: `resolveRepository` and `loadTaskState`
   * (this fixture has no profile on disk and no task record), `verify` (a real
   * `npm run verify` inside a test is not a test), `now` (so the recorded
   * instant is pinnable), and the three forge runners — which are supplied
   * precisely so that reaching one is a COUNT in the result rather than an
   * argument in a comment.
   */
  function unleasedRepo(): { root: string; mergeCommit: string; gitCommonDir: string; dispose: () => void } {
    const { root, mergeCommit } = copyTemplate('ao-v409-cli-');
    const gitCommonDir = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return {
      root,
      mergeCommit,
      gitCommonDir,
      dispose: () => {
        const derived = deriveVerificationWorkspaceIdentity(root, TASK);
        if (derived.ok) rmSync(derived.identity.workspaceParent, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  async function runCli(
    argv: readonly string[],
    repo: ReturnType<typeof unleasedRepo>,
    verify: VerificationRunner,
  ): Promise<{ out: string; forgeReads: number; forgeMutations: number; exitCode: number | undefined }> {
    let forgeReads = 0;
    let forgeMutations = 0;
    const chunks: string[] = [];
    const outerExitCode = process.exitCode;
    process.exitCode = undefined;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
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
              verification: PROFILE,
              delivery: {
                declared: true,
                remoteName: 'origin',
                result: { outcome: 'RESOLVED', target: { provider: 'github', ...IDENTITY } },
              },
            },
          }) as never,
        loadTaskState: () =>
          ({
            ok: true,
            revision: 'a'.repeat(64),
            state: {
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
            },
          }) as never,
        // Every forge seam is supplied and counted. A verification that reached
        // any of them is a number here rather than an argument in a comment.
        runner: (async () => {
          forgeReads += 1;
          return { outcome: 'COMPLETED', exitCode: 0, stdout: '{}', stderr: '' } as never;
        }) as never,
        creationRunner: (async () => {
          forgeMutations += 1;
          return {} as never;
        }) as never,
        mergeRunner: (async () => {
          forgeMutations += 1;
          return {} as never;
        }) as never,
        publicationRunner: (async () => {
          forgeMutations += 1;
          return {} as never;
        }) as never,
        // Real Git, so the worktree really appears and really goes; real
        // check-ignore, so the store's own gate is exercised rather than stubbed.
        git: runGitCommand,
        verify,
        now: () => new Date(AT),
      });
      await program.parseAsync(['node', 'x', 'delivery', '--repository', repo.root, '--task', TASK, ...argv]);
    } finally {
      write.mockRestore();
    }
    const exitCode = process.exitCode;
    process.exitCode = outerExitCode;
    return { out: chunks.join(''), forgeReads, forgeMutations, exitCode };
  }

  it('runs the gate, records the attempt, and gives the lease back', async () => {
    const repo = unleasedRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner, calls } = recordingRunner();
      const r = await runCli(['--verify-merge'], repo, runner);

      expect(r.out, r.out).toContain('Verification : VERIFICATION_ATTEMPTED');
      expect(r.out).toContain(`Merge commit : ${repo.mergeCommit}`);
      expect(r.out).toContain('Result       : VERIFIED_PASS');
      expect(r.out).toContain('Record       : HISTORY_STARTED  (write: COMPLETED)');
      // The sentence that keeps the event apart from every standing it is not.
      expect(r.out).toContain('It is not a claim that the commit is on the base');

      // The gate ran in the workspace, at the merge commit, and not in the
      // developer's checkout.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cwd).not.toBe(repo.root);
      expect(calls[0]?.headAtRun).toBe(repo.mergeCommit);

      // Nothing was asked of a forge, and nothing was changed on one.
      expect(r.forgeReads).toBe(0);
      expect(r.forgeMutations).toBe(0);

      // The record is on disk and reads back.
      const loaded = loadPostMergeVerification(repo.root, TASK, {
        taskId: TASK,
        repositoryRoot: repo.root,
      });
      expect(loaded.reading).toBe('VERIFICATION_HISTORY');
      expect(loaded.record?.mergeCommit).toBe(repo.mergeCommit);
      expect(loaded.record?.subjectCommit).toBe(HEAD);
      expect(loaded.record?.attempts).toHaveLength(1);
      expect(loaded.record?.attempts[0]?.outcome).toBe('VERIFIED_PASS');

      // The lease was given back: nothing holds the repository afterwards, and
      // a fresh acquisition succeeds. This is the assertion that would fail if
      // the `finally` were removed.
      const after = acquireRepositoryExecutionLease(
        { id: 'fixture-repo', root: repo.root, gitCommonDir: repo.gitCommonDir },
        { runId: null, blockId: null },
        { now: () => new Date().toISOString() },
      );
      expect(after.ok, JSON.stringify(after)).toBe(true);
      if (after.ok) releaseRepositoryExecutionLease(after.evidence);

      // The temporary workspace is gone and the developer's tree is untouched.
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      expect(() => statSync(derived.identity.workspacePath)).toThrow();
      expect(git(repo.root, 'status', '--porcelain')).toBe('');
      expect(git(repo.root, 'rev-parse', 'HEAD')).toBe(repo.mergeCommit);
    } finally {
      repo.dispose();
    }
  });

  it('never closes a verification run by calling it read-only', async () => {
    // A review found `--verify-merge` closing with "Read-only. No forge was
    // contacted, no task state was written, and nothing was delivered." after
    // taking the repository's lease, creating and destroying a checkout,
    // running the declared commands and writing a record. The trailer block had
    // no term for verification at all.
    const repo = unleasedRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner } = recordingRunner();
      const r = await runCli(['--verify-merge'], repo, runner);

      expect(r.out).not.toContain(NOT_CONTACTED_TRAILER);
      expect(r.out).not.toContain('nothing was delivered');
      expect(r.out).toContain(VERIFICATION_TRAILER);
      // The disclosure the trailer exists for: this build does not answer for
      // what the repository's own commands do.
      expect(r.out).toContain("declares: what those do, and whether they reach a network");

      // The control: a run that did NOT verify still gets the read-only
      // sentence, so the suppression above is attributable to verification
      // rather than to the trailer block having stopped working.
      const none = await runCli([], repo, runner);
      expect(none.out).toContain(NOT_CONTACTED_TRAILER);
      expect(none.out).not.toContain(VERIFICATION_TRAILER);
    } finally {
      repo.dispose();
    }
  });

  it('may not exit nominal when it cannot prove it gave the lease back', async () => {
    // The rule is the repository's, not this slice's: `run-exit-codes.ts` says
    // "an invocation that took this repository's only writer slot and cannot
    // prove it gave the slot back has left something behind, and it may not
    // exit nominal however well its own work went. **No primary code is
    // exempt**." `block --attended` and `release --attended` both apply it, and
    // a review found this — the third lease-taking path — exiting 0 with a
    // stuck lease.
    const repo = unleasedRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner } = recordingRunner();

      // The control first: a clean run keeps its own verdict.
      const clean = await runCli(['--verify-merge'], repo, runner);
      expect(clean.out).toContain('Verification : VERIFICATION_ATTEMPTED');
      expect(clean.out).toContain('Lease        : RELEASED');
      expect(clean.exitCode ?? 0).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  it('prints a lease line on every run that took one, including the clean ones', async () => {
    // An earlier version printed only failures, which made "the release was
    // fine" and "the release threw and this invocation does not know what is in
    // the repository" identical from the console — the confusion
    // `render-lease.ts` introduced `LEASE_RELEASE_UNREPORTED` to prevent. The
    // shared renderer is used rather than a wording invented here.
    const repo = unleasedRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner } = recordingRunner();
      const r = await runCli(['--verify-merge'], repo, runner);
      expect(r.out).toContain('Lease        : RELEASED');

      // And a run that took no lease prints no lease line at all — the two
      // cases must not look the same in either direction.
      const none = await runCli([], repo, runner);
      expect(none.out).not.toContain('Lease        :');
    } finally {
      repo.dispose();
    }
  });

  it('does nothing at all without the flag', async () => {
    const repo = unleasedRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner, calls } = recordingRunner();
      const r = await runCli([], repo, runner);
      expect(r.out).not.toContain('Verification :');
      expect(calls).toEqual([]);
      expect(
        loadPostMergeVerification(repo.root, TASK, { taskId: TASK, repositoryRoot: repo.root })
          .reading,
      ).toBe('ABSENT');
      // And no lease was taken, so one is free.
      const after = acquireRepositoryExecutionLease(
        { id: 'fixture-repo', root: repo.root, gitCommonDir: repo.gitCommonDir },
        { runId: null, blockId: null },
        { now: () => new Date().toISOString() },
      );
      expect(after.ok).toBe(true);
      if (after.ok) releaseRepositoryExecutionLease(after.evidence);
    } finally {
      repo.dispose();
    }
  });

  it('reports a semantic failure without doing anything about it', async () => {
    const repo = unleasedRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const { runner } = recordingRunner({ exitCode: 1 });
      const r = await runCli(['--verify-merge'], repo, runner);
      expect(r.out).toContain('Result       : VERIFIED_FAIL');
      expect(r.out).toContain('Stopped at   : VERIFY');
      expect(r.out).toContain('Record       : HISTORY_STARTED');
      // No remediation of any kind: no forge call, and the task's own record is
      // not even loaded for writing — the state seam is a reader.
      expect(r.forgeMutations).toBe(0);
      expect(r.forgeReads).toBe(0);
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      expect(() => statSync(derived.identity.workspacePath)).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('names why no workspace could be made, rather than collapsing every reason', async () => {
    // README and the ADR both tell an operator that something already at the
    // derived path "is reported as `WORKSPACE_PATH_OCCUPIED` and left alone". A
    // review measured that the result had no field for it — every creation
    // failure became one ladder member and the code was discarded, so the
    // sentence described a report the code could not produce.
    const repo = unleasedRepo();
    try {
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      const derived = deriveVerificationWorkspaceIdentity(repo.root, TASK);
      if (!derived.ok) throw new Error('unreachable');
      mkdirSync(derived.identity.workspacePath, { recursive: true });
      writeFileSync(join(derived.identity.workspacePath, 'mine.txt'), 'keep', 'utf8');

      const { runner, calls } = recordingRunner();
      const r = await runCli(['--verify-merge'], repo, runner);

      expect(r.out).toContain('Verification : WORKSPACE_NOT_ESTABLISHED');
      expect(r.out).toContain('Workspace    : WORKSPACE_PATH_OCCUPIED');
      // No gate ran, and the operator's directory is untouched.
      expect(calls).toEqual([]);
      expect(readFileSync(join(derived.identity.workspacePath, 'mine.txt'), 'utf8')).toBe('keep');
      // And the lease was still taken and given back, so the run is not read-only.
      expect(r.out).toContain('Lease        : RELEASED');
      expect(r.out).toContain(VERIFICATION_TRAILER);
    } finally {
      repo.dispose();
    }
  });

  it('refuses without a receipt, and runs nothing', async () => {
    const repo = unleasedRepo();
    try {
      const { runner, calls } = recordingRunner();
      const r = await runCli(['--verify-merge'], repo, runner);
      expect(r.out).toContain('Verification : RECEIPT_ABSENT');
      expect(r.out).toContain('Merge commit : none was established');
      expect(calls).toEqual([]);
      // No record, and no history started for a run that did not happen.
      expect(
        loadPostMergeVerification(repo.root, TASK, { taskId: TASK, repositoryRoot: repo.root })
          .reading,
      ).toBe('ABSENT');
    } finally {
      repo.dispose();
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
      //
      // Built with `new RegExp` from a raw string, and given its own controls.
      // The previous version of this line was written through a shell-quoted
      // script and its word-boundary escapes arrived as literal U+0008
      // BACKSPACE bytes — a pattern that cannot match any source file, so the
      // assertion was incapable of failing. A review measured that. The two
      // controls below are what stop it happening again: a dead regex fails
      // them before it ever reaches the file it is supposed to judge.
      const COMPLETE_STATE = /\bCOMPLETE\b/;
      expect(COMPLETE_STATE.test("state === 'COMPLETE'")).toBe(true);
      expect(COMPLETE_STATE.test("writeAttempt: 'COMPLETED'")).toBe(false);
      expect(source, `${file} must not name the COMPLETE state`).not.toMatch(COMPLETE_STATE);
    }
    // Positive controls: the modules that DO write those still do.
    expect(codeOnly('src/state/state-store.ts')).toContain('saveTaskState');
    expect(codeOnly('src/state/advance-state.ts')).toContain('advanceTaskState');

    // And the CLI, which the six above deliberately exclude because it is the
    // whole delivery surface rather than this slice's modules.
    //
    // It is here because of what the lease widening opened: `delivery-command.ts`
    // now imports `loop/leased-spawns.js`, and that module exports `leasedAgent`
    // beside `leasedGit` and `leasedVerify`. Before this slice, `tests/v4-02-…`
    // refused the whole import; its ADMITTED list now lets it in and says the
    // "no agent" half is asserted here — which a review found was true of no
    // file. It is true of this line.
    const cli = codeOnly('src/cli/delivery-command.ts');
    expect(cli.replace(/\s+/g, '').length).toBeGreaterThan(1000);
    for (const forbidden of ['leasedAgent', 'runClaudeWriter', 'runCodexReviewer', 'startTask']) {
      expect(cli, `src/cli/delivery-command.ts must not reach ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // The two it MAY reach, named so the exclusion above is a boundary rather
    // than a blanket ban that would go stale the moment the file changes.
    expect(cli).toContain('leasedGit');
    expect(cli).toContain('leasedVerify');
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

  it('describes every act flag it registers, so an enumeration cannot go stale', () => {
    // The command description is a list of clauses, one per flag, and a list
    // beside a registered surface is a number nothing enforces — the shape this
    // repository has been caught by repeatedly. So the rule is asserted rather
    // than the list: **every optional flag the command registers must be named
    // in the description.** The two required options are excluded because they
    // are not acts.
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const optional = (delivery?.options ?? []).filter((o) => !o.mandatory).map((o) => o.long ?? '');
    // Positive control: the surface really has flags, so a registry that
    // returned nothing could not pass this by silence.
    expect(optional.length).toBeGreaterThanOrEqual(8);
    for (const long of optional) {
      expect(DELIVERY_COMMAND_DESCRIPTION, long).toContain(long);
    }
    // And the clause that enumerates the writing flags names this slice's.
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--verify-merge');
    // The clause says what this build answers for and what it does not. It
    // used to read "contacting no network at all", which is an unqualified
    // claim about processes AO does not control: the flag runs whatever the
    // repository profile declares.
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('It contacts no forge');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain("the profile's to answer for");
    expect(DELIVERY_COMMAND_DESCRIPTION).not.toContain('contacting no network at all');
    // `--attended` still means what it meant: an effect outside this machine.
    // Verification has none, so it must not have been added to that list.
    expect(ATTENDED_OPTION_DESCRIPTION).toContain('--publish-head, --create-pr and --merge-pr');
    expect(ATTENDED_OPTION_DESCRIPTION).not.toContain('--verify-merge');
  });

  it('registers the sentence that was pinned, not a copy', () => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const option = (delivery?.options ?? []).find((o) => o.long === '--verify-merge');
    expect(option?.description).toBe(VERIFY_MERGE_OPTION_DESCRIPTION);
    // The five words that name an override of a refusal stay forbidden.
    expect('--verify-merge').not.toMatch(/force|unattended|adopt|takeover|steal/i);
  });

  it('says what it does and does not establish', () => {
    for (const phrase of [
      'the exact merge commit',
      'named by this task',
      'not from a commit you name',
      "execution lease",
      'will not fetch a merge commit',
      'your own working tree is never touched'.replace('your', 'your'),
      'no agent is started',
      'no task state and no block ledger is written',
      'is not a claim',
      'still reachable from it',
      'has not been reverted',
      'passes today',
      'is not run again',
      // The two clauses a self-review tightened: the network claim is about
      // THIS act rather than the whole invocation (a run that also passes
      // --observe does contact github.com), and the removal is a promise that
      // can be refused, so the sentence says what happens when it is.
      'opens no network connection of its own',
      'may do anything they like',
      'if that removal is refused you are told',
    ]) {
      expect(VERIFY_MERGE_OPTION_DESCRIPTION.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
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

    // And the five sibling files carry a pointer here rather than a copy, so a
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

  it('introduces no Git fetch anywhere in the product', () => {
    // `L-V4-09-3` and the `--verify-merge` help text both say this build will
    // not fetch a merge commit it does not have, and both are claims about the
    // whole of `src/` rather than about this slice's modules. So they are
    // measured over the whole of `src/`.
    //
    // Matched on the argument literal a Git invocation would have to carry.
    // Prose about a remote's "fetch URL" is not a fetch, and several modules
    // discuss one; a `'fetch'` token is what a `git(cwd, ['fetch', …])` needs.
    const sources = walk('src');
    expect(sources.length).toBeGreaterThan(50);
    const fetchers = sources.filter((file) => /['"]fetch['"]/.test(codeOnly(file)));
    expect(fetchers).toEqual([]);
    // The control: the same shape does find the Git verbs this build DOES run,
    // so an empty result above is an absence rather than a broken pattern.
    expect(sources.filter((file) => /['"]worktree['"]/.test(codeOnly(file))).length).toBeGreaterThan(
      0,
    );
    expect(sources.filter((file) => /['"]rev-parse['"]/.test(codeOnly(file))).length).toBeGreaterThan(
      0,
    );
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
