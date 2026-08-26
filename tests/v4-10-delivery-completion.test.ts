/**
 * V4 slice 10 — delivery completion from a reconciled merge and exact-commit
 * verification evidence.
 *
 * The suite is written against the two ways this feature goes wrong:
 *
 *  1. **"concluded" quietly meaning more than it says.** The record is a
 *     judgement about two past events. Every case that could be read as a claim
 *     about the base branch, the code today, or the task's lifecycle is driven
 *     and pinned to the opposite — including three real-Git repositories where
 *     the base has moved, been reverted, and lost the merge object entirely;
 *  2. **the join not actually being made.** Nothing before this slice compared
 *     the merge receipt to the verification history, so a history filed under a
 *     task for a different pull request, fork or implementation head reads as an
 *     ordinary pass to every existing reader. Each of the six joined fields is
 *     driven apart on its own.
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
  DeliveryConclusionEvidence,
  describesSameDelivery,
  mintDeliveryConclusion,
  standingVerdictFor,
} from '../src/deliver/internal/delivery-conclusion-proof.js';
import {
  deliveryConclusionFactsOf,
  isDeliveryConclusionProof,
} from '../src/deliver/delivery-conclusion-proof.js';
import {
  CONCLUSION_EVENT_SENTENCE,
  DELIVERY_CONCLUSION_READINGS,
  DELIVERY_CONCLUSION_VERSION,
  DeliveryConclusionSchema,
  MAX_DELIVERY_CONCLUSION_BYTES,
  deliveryConclusionBinding,
  isDeliveryConcluded,
  readDeliveryConclusion,
  sameConcludedDelivery,
  type DeliveryConclusionPayload,
  type DeliveryConclusionSubject,
} from '../src/deliver/delivery-conclusion.js';
import {
  CONCLUSION_WRITE_ATTEMPTS,
  DELIVERY_CONCLUSION_DIR_NAME,
  conclusionIsDurable,
  deliveryConclusionDirectory,
  deriveDeliveryConclusionLocation,
  loadDeliveryConclusion,
  recordDeliveryConclusion,
  type DeliveryConclusionRecordCode,
  type ConclusionIgnoreVerdict,
} from '../src/deliver/delivery-conclusion-store.js';
import {
  DELIVERY_CONCLUSIONS,
  DELIVERY_CONCLUSION_DETAIL,
  concludeDeliveryForTask,
  refuseDeliveryConclusion,
  type ConclusionRepository,
  type DeliveryConclusionOutcome,
} from '../src/deliver/conclude-delivery.js';
import {
  MAX_MERGE_RECONCILIATION_BYTES,
  MERGE_RECONCILIATION_VERSION,
  mergeReconciliationBinding,
  type MergeReconciliationPayload,
} from '../src/deliver/merge-reconciliation.js';
import { mergeReconciliationDirectory } from '../src/deliver/merge-reconciliation-store.js';
import {
  POST_MERGE_VERIFICATION_VERSION,
  postMergeVerificationBinding,
  type PostMergeVerificationPayload,
  type VerificationAttempt,
} from '../src/deliver/post-merge-verification.js';
import {
  hasPassFor,
  postMergeVerificationDirectory,
} from '../src/deliver/post-merge-verification-store.js';
import { verificationProfileDigest } from '../src/verify/verification-profile.js';
import type { ResolvedVerificationPolicy } from '../src/repo/resolve-repository.js';
import {
  CONCLUSION_TRAILER,
  VERIFICATION_TRAILER,
  renderDeliveryObservation,
} from '../src/cli/render-delivery-observation.js';
import {
  CONCLUDE_DELIVERY_OPTION_DESCRIPTION,
  DELIVERY_COMMAND_DESCRIPTION,
  registerDeliveryCommand,
} from '../src/cli/delivery-command.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { proveBlockTaskEntry } from '../src/block/block-evidence.js';
import type { BlockTaskEntry } from '../src/block/block-ledger.js';
import { ALL_STATES, TERMINAL_STATES } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  EXECUTION_LEASE_FILE_NAME,
} from '../src/lease/execution-lease.js';
import {
  exitCodeForConclusionRecord,
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
} from '../src/cli/run-exit-codes.js';

/* ─────────────────────────────── fixtures ───────────────────────────────── */

const TASK = 'V4-10';
/** H — the implementation head the receipt records. */
const HEAD = 'a'.repeat(40);
/** M — the merge commit the delivery produced, and the verified one. */
const MERGE = 'b'.repeat(40);
/** Neither H nor M. */
const OTHER = 'd'.repeat(40);
const PR = 64;
const AT = '2026-08-26T07:13:56Z';
// Written in the exact form `Date.prototype.toISOString` produces, because the
// clock seam's value reaches the record through it: a fixture spelled without
// milliseconds would compare unequal to its own normalised self.
const LATER = '2026-08-26T09:13:56.000Z';
const IDENTITY = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});
const BASE = 'main';
const BRANCH = 'ao/task/V4-10';

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
const OTHER_DIGEST = verificationProfileDigest(OTHER_PROFILE);

/**
 * Everything the conclusion path may not reach.
 *
 * A named constant rather than an inline array, so the positive control below
 * can iterate the same list the exclusion does. Two copies of a list that has
 * to agree is the shape this repository keeps catching in review.
 */
const FORBIDDEN_ON_THE_CONCLUSION_PATH = [
  'saveTaskState',
  'advanceTaskState',
  'recordAgentInterruption',
  'settleBlockTask',
  'block-store',
  'block-progress',
  'block-ledger',
  'runClaudeWriter',
  'runCodexReviewer',
  'leasedAgent',
  'leasedGit',
  'leasedVerify',
  'acquireRepositoryExecutionLease',
  'mergePullRequest',
  'createPullRequest',
  'publishDeliveryHead',
  'createForgeCommandRunner',
  'ForgeMutationRunner',
  'ForgeMergeRunner',
  'runVerification',
  'VerificationRunner',
] as const;

/** Every `.ts` file under `src/`, for the positive controls. */
function sourceFilesUnderSrc(dir = 'src'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnderSrc(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A temporary directory whose path this build will accept as a Git argument.
 *
 * `realpathSync.native` is not decoration, and CI is what proved it for the
 * slice before this one: on the GitHub Windows runner `os.tmpdir()` answers
 * with an 8.3 short path — `C:\Users\RUNNER~1\…` — and `~` is outside
 * `SAFE_ARG_PATTERN`. Nothing in *this* slice hands a path to Git, so the short
 * name would not break it; the call stays because the real-Git fixtures below
 * do run `git`, and because a fixture root that differs from its own canonical
 * form makes `repositoryRoot` comparisons meaningless.
 */
function scratchRoot(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function scratch(prefix = 'ao-v410-'): string {
  const root = scratchRoot(prefix);
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  return root;
}

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

function writeReceipt(root: string, over: Partial<MergeReconciliationPayload> = {}): void {
  const payload = receiptPayload(root, over);
  const subject = { taskId: payload.taskId, repositoryRoot: root };
  const dir = mergeReconciliationDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${TASK}.json`),
    `${JSON.stringify(
      { ...payload, binding: mergeReconciliationBinding(subject, payload) },
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

/** A non-pass attempt, whose schema requires a stopping phase. */
function failedAttempt(
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

function verificationPayload(
  root: string,
  over: Partial<PostMergeVerificationPayload> = {},
): PostMergeVerificationPayload {
  return {
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
}

function writeVerification(root: string, over: Partial<PostMergeVerificationPayload> = {}): void {
  const payload = verificationPayload(root, over);
  const subject = { taskId: payload.taskId, repositoryRoot: root };
  const dir = postMergeVerificationDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${TASK}.json`),
    `${JSON.stringify(
      { ...payload, binding: postMergeVerificationBinding(subject, payload) },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function conclusionPath(root: string): string {
  return join(deliveryConclusionDirectory(root), `${TASK}.json`);
}

function conclusionPayload(
  root: string,
  over: Partial<DeliveryConclusionPayload> = {},
): DeliveryConclusionPayload {
  return {
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
}

function writeConclusion(root: string, over: Partial<DeliveryConclusionPayload> = {}): void {
  const payload = conclusionPayload(root, over);
  const subject = { taskId: payload.taskId, repositoryRoot: root };
  mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
  writeFileSync(
    conclusionPath(root),
    `${JSON.stringify(
      { ...payload, binding: deliveryConclusionBinding(subject, payload) },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function repositoryOf(root: string, verification: ResolvedVerificationPolicy = PROFILE): ConclusionRepository {
  return Object.freeze({ root, verification });
}

function subjectOf(over: Partial<Parameters<typeof concludeDeliveryForTask>[1]> = {}) {
  return { taskId: TASK, ...IDENTITY, deliveryCommit: HEAD, ...over };
}

const CLOCK = { now: () => new Date(LATER) };

function conclude(root: string, over = {}, profile = PROFILE) {
  return concludeDeliveryForTask(repositoryOf(root, profile), subjectOf(over), CLOCK);
}

/** A real merge/verification pair on disk, plus the freshly minted proof. */
function provenConclusion(root: string) {
  writeReceipt(root);
  writeVerification(root);
  const result = conclude(root);
  if (result.outcome !== 'DELIVERY_CONCLUDED' || result.proof === null) {
    throw new Error(`fixture did not conclude: ${result.outcome}`);
  }
  return result;
}

function writeRequest(root: string, proof: unknown, over: Record<string, unknown> = {}) {
  return {
    repositoryRoot: root,
    taskId: TASK,
    proof,
    expectedSubjectCommit: HEAD,
    expectedMergeCommit: MERGE,
    expectedHost: IDENTITY.host,
    expectedOwner: IDENTITY.owner,
    expectedName: IDENTITY.name,
    expectedPullRequestNumber: PR,
    assessedStateRevision: 'r'.repeat(64),
    readStateRevision: () => 'r'.repeat(64),
    checkIgnored: async (): Promise<ConclusionIgnoreVerdict> => 'IGNORED',
    ...over,
  };
}

/* ── 1. The record contract ──────────────────────────────────────────────── */

describe('the delivery-conclusion record says one thing and refuses the rest', () => {
  it('reads back what this build writes, and nothing else', () => {
    const root = scratch();
    try {
      const subject: DeliveryConclusionSubject = { taskId: TASK, repositoryRoot: root };
      const payload = conclusionPayload(root);
      const record = { ...payload, binding: deliveryConclusionBinding(subject, payload) };
      expect(readDeliveryConclusion(record, subject).reading).toBe('DELIVERY_CONCLUDED');
      expect(readDeliveryConclusion(record, subject).conclusion).toEqual(record);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a document whose merge commit is its own implementation head', () => {
    // Not a taste rule. Slice 8 requires the receipt's `mergedHeadSha` to equal
    // its `subjectCommit`, and its `mergeCommit` to be what the merge produced;
    // on every merge method GitHub offers those are different objects. A record
    // saying otherwise validates field by field while describing something the
    // pipeline that writes it cannot produce.
    const root = scratch();
    try {
      const subject = { taskId: TASK, repositoryRoot: root };
      const payload = conclusionPayload(root, { mergeCommit: HEAD });
      const record = { ...payload, binding: deliveryConclusionBinding(subject, payload) };
      expect(DeliveryConclusionSchema.safeParse(record).success).toBe(false);
      expect(readDeliveryConclusion(record, subject).reading).toBe('MALFORMED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every reading, and grades exactly one of them usable', () => {
    // Asserted by value rather than derived from the module under test: a table
    // generated from the thing it judges agrees with it by construction.
    expect([...DELIVERY_CONCLUSION_READINGS]).toEqual([
      'DELIVERY_CONCLUDED',
      'ABSENT',
      'MALFORMED',
      'UNSUPPORTED_VERSION',
      'NOT_THIS_TASK',
    ]);
    expect(DELIVERY_CONCLUSION_READINGS.filter((r) => isDeliveryConcluded(r))).toEqual([
      'DELIVERY_CONCLUDED',
    ]);
  });

  it('refuses a version this build does not have, without reading its shape', () => {
    const root = scratch();
    try {
      const subject = { taskId: TASK, repositoryRoot: root };
      // A record from the future may legally carry fields this schema forbids,
      // so the version is read before the shape.
      const future = { conclusionVersion: DELIVERY_CONCLUSION_VERSION + 1, whatever: true };
      expect(readDeliveryConclusion(future, subject).reading).toBe('UNSUPPORTED_VERSION');
      expect(readDeliveryConclusion(future, subject).conclusion).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects an edit to any bound field, one field at a time', () => {
    const root = scratch();
    try {
      const subject = { taskId: TASK, repositoryRoot: root };
      const payload = conclusionPayload(root);
      const base = deliveryConclusionBinding(subject, payload);
      const moved: Partial<DeliveryConclusionPayload>[] = [
        { subjectCommit: OTHER },
        { mergeCommit: OTHER },
        { host: 'ghe.example.invalid' },
        { owner: 'someone-else' },
        { name: 'OtherRepo' },
        { pullRequestNumber: PR + 1 },
        { baseRef: 'release' },
        { profileDigest: OTHER_DIGEST },
        { verifiedAt: LATER },
        { receiptBinding: '1'.repeat(64) },
        { verificationBinding: '2'.repeat(64) },
        { concludedAt: LATER },
        { taskId: 'OTHER-TASK' },
        { repositoryRoot: `${root}-other` },
        { conclusionVersion: 99 },
      ];
      for (const over of moved) {
        const other = { ...payload, ...over };
        expect(deliveryConclusionBinding(subject, other), JSON.stringify(over)).not.toBe(base);
      }
      // And the subject's own identity is an input, so a record bound for
      // another task fails against this one.
      expect(
        deliveryConclusionBinding({ taskId: 'OTHER', repositoryRoot: root }, payload),
      ).not.toBe(base);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a foreign payload carrying a binding computed for this subject', () => {
    // The reachable belt-and-braces pair. The digest takes the subject's ids
    // alongside the payload's, so a record bound for a different subject fails
    // the digest; a record whose PAYLOAD names another task, with a binding
    // computed for that payload against THIS subject, matches the digest and is
    // refused by the two explicit comparisons instead.
    const root = scratch();
    try {
      const subject = { taskId: TASK, repositoryRoot: root };
      const foreignTask = conclusionPayload(root, { taskId: 'SOMEONE-ELSE' });
      expect(
        readDeliveryConclusion(
          { ...foreignTask, binding: deliveryConclusionBinding(subject, foreignTask) },
          subject,
        ).reading,
      ).toBe('NOT_THIS_TASK');
      const foreignRoot = conclusionPayload(root, { repositoryRoot: `${root}-elsewhere` });
      expect(
        readDeliveryConclusion(
          { ...foreignRoot, binding: deliveryConclusionBinding(subject, foreignRoot) },
          subject,
        ).reading,
      ).toBe('NOT_THIS_TASK');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a floor the product path cannot reach, and the arithmetic says why', () => {
    // The byte budget. Measured rather than reasoned about: for any given
    // `repositoryRoot` this record serialises to exactly 200 bytes more than
    // slice 8's receipt for the same root, and the receipt's budget is 8,192 —
    // so a receipt small enough to be read at all leaves this record at most
    // 8,392 bytes. The gate exists for a hand-written document.
    const root = scratch();
    try {
      const subject = { taskId: TASK, repositoryRoot: root };
      for (const filler of ['x', '\u4e00', '\u0001']) {
        const long = filler.repeat(4096);
        const receipt = receiptPayload(root, { repositoryRoot: long, taskId: 'x'.repeat(128) });
        const conclusion = conclusionPayload(root, {
          repositoryRoot: long,
          taskId: 'x'.repeat(128),
          baseRef: 'r'.repeat(255),
          host: 'h'.repeat(253),
          owner: 'o'.repeat(128),
          name: 'n'.repeat(128),
          pullRequestNumber: 2_147_483_647,
          verifiedAt: '2026-08-26T07:00:00.123456789+02:00',
          concludedAt: '2026-08-26T07:00:00.123456789+02:00',
        });
        const size = (o: unknown) => Buffer.byteLength(`${JSON.stringify(o, null, 2)}\n`, 'utf8');
        const receiptBytes = size({
          ...receipt,
          observedAt: '2026-08-26T07:00:00.123456789+02:00',
          reconciledAt: '2026-08-26T07:00:00.123456789+02:00',
          baseRef: 'r'.repeat(255),
          host: 'h'.repeat(253),
          owner: 'o'.repeat(128),
          name: 'n'.repeat(128),
          pullRequestNumber: 2_147_483_647,
          binding: 'f'.repeat(64),
        });
        const conclusionBytes = size({
          ...conclusion,
          binding: 'f'.repeat(64),
        });
        expect(conclusionBytes - receiptBytes, filler).toBe(200);
      }
      // And the constant itself is what the store compares against.
      expect(MAX_DELIVERY_CONCLUSION_BYTES).toBe(16_384);
      expect(readDeliveryConclusion(conclusionPayload(root), subject).reading).toBe('MALFORMED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says in one place what a conclusion is not', () => {
    for (const clause of [
      'on the base branch now',
      'reachable from it',
      'has not been reverted',
      'changes are still\npresent',
      'base branch passes today',
      'READY_FOR_PR stays terminal',
    ]) {
      expect(CONCLUSION_EVENT_SENTENCE, clause).toContain(clause);
    }
  });

  it('compares a delivery by its identity and not by its provenance', () => {
    const a = {
      subjectCommit: HEAD,
      mergeCommit: MERGE,
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      pullRequestNumber: PR,
      baseRef: BASE,
    };
    expect(sameConcludedDelivery(a, { ...a })).toBe(true);
    for (const over of [
      { subjectCommit: OTHER },
      { mergeCommit: OTHER },
      { host: 'ghe.example.invalid' },
      { owner: 'x' },
      { name: 'y' },
      { pullRequestNumber: PR + 1 },
      { baseRef: 'release' },
    ]) {
      expect(sameConcludedDelivery(a, { ...a, ...over }), JSON.stringify(over)).toBe(false);
    }
  });
});

/* ── 2. The mint ─────────────────────────────────────────────────────────── */

describe('a conclusion can only be minted from two records that agree', () => {
  const root = 'D:/fixture';
  const receipt = { ...receiptPayload(root), binding: 'a'.repeat(64) };
  const verification = { ...verificationPayload(root), binding: 'b'.repeat(64) };

  it('mints from an agreeing pair, and carries both source digests', () => {
    const proof = mintDeliveryConclusion({
      receipt,
      verification,
      profileDigest: DIGEST,
      concludedAt: LATER,
    });
    expect(proof).not.toBeNull();
    const facts = deliveryConclusionFactsOf(proof);
    expect(facts).toEqual({
      subjectCommit: HEAD,
      mergeCommit: MERGE,
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      pullRequestNumber: PR,
      baseRef: BASE,
      profileDigest: DIGEST,
      verifiedAt: AT,
      receiptBinding: receipt.binding,
      verificationBinding: verification.binding,
      concludedAt: LATER,
    });
  });

  it('refuses each of the six joined fields, one at a time', () => {
    for (const over of [
      { mergeCommit: OTHER },
      { subjectCommit: OTHER },
      { host: 'ghe.example.invalid' },
      { owner: 'someone-else' },
      { name: 'OtherRepo' },
      { pullRequestNumber: PR + 1 },
    ]) {
      const skewed = { ...verification, ...over };
      expect(describesSameDelivery(receipt, skewed), JSON.stringify(over)).toBe(false);
      expect(
        mintDeliveryConclusion({
          receipt,
          verification: skewed,
          profileDigest: DIGEST,
          concludedAt: LATER,
        }),
        JSON.stringify(over),
      ).toBeNull();
    }
    expect(describesSameDelivery(receipt, verification)).toBe(true);
  });

  it('refuses two records about different tasks or different roots', () => {
    for (const over of [{ taskId: 'ANOTHER' }, { repositoryRoot: 'D:/elsewhere' }]) {
      expect(
        mintDeliveryConclusion({
          receipt,
          verification: { ...verification, ...over },
          profileDigest: DIGEST,
          concludedAt: LATER,
        }),
        JSON.stringify(over),
      ).toBeNull();
    }
  });

  it('refuses a history with no verdict, or a failing one, under this profile', () => {
    for (const attempts of [
      [attemptOf({ profileDigest: OTHER_DIGEST })],
      [failedAttempt('VERIFICATION_NOT_ESTABLISHED')],
      [failedAttempt('VERIFIED_FAIL')],
      [attemptOf(), failedAttempt('VERIFIED_FAIL', { attemptedAt: LATER })],
    ]) {
      expect(
        mintDeliveryConclusion({
          receipt,
          verification: { ...verification, attempts },
          profileDigest: DIGEST,
          concludedAt: LATER,
        }),
        JSON.stringify(attempts.map((a) => a.outcome)),
      ).toBeNull();
    }
  });

  it('refuses a shape neither schema would have produced', () => {
    for (const over of [
      { profileDigest: 'not-a-digest' },
      { concludedAt: 'yesterday' },
    ]) {
      expect(
        mintDeliveryConclusion({
          receipt,
          verification,
          profileDigest: DIGEST,
          concludedAt: LATER,
          ...over,
        }),
        JSON.stringify(over),
      ).toBeNull();
    }
    for (const over of [
      { subjectCommit: 'short' },
      { mergeCommit: 'short' },
      { binding: 'not-a-digest' },
    ]) {
      expect(
        mintDeliveryConclusion({
          receipt: { ...receipt, ...over },
          verification: { ...verification, ...over },
          profileDigest: DIGEST,
          concludedAt: LATER,
        }),
        JSON.stringify(over),
      ).toBeNull();
    }
    expect(
      mintDeliveryConclusion({
        receipt,
        verification: { ...verification, binding: 'not-a-digest' },
        profileDigest: DIGEST,
        concludedAt: LATER,
      }),
    ).toBeNull();
    expect(
      mintDeliveryConclusion({
        receipt,
        verification: { ...verification, attempts: [attemptOf({ attemptedAt: 'yesterday' })] },
        profileDigest: DIGEST,
        concludedAt: LATER,
      }),
    ).toBeNull();
  });

  it('cannot be forged by shape, by prototype or by a captured registry', () => {
    const genuine = mintDeliveryConclusion({
      receipt,
      verification,
      profileDigest: DIGEST,
      concludedAt: LATER,
    });
    if (genuine === null) throw new Error('fixture proof not minted');

    // Shape.
    expect(isDeliveryConclusionProof({ mergeCommit: MERGE })).toBe(false);
    expect(deliveryConclusionFactsOf({ mergeCommit: MERGE })).toBeNull();
    // The class, reachable from a genuine artefact with no import at all.
    const Ctor = Object.getPrototypeOf(genuine).constructor as typeof DeliveryConclusionEvidence;
    expect(Ctor).toBe(DeliveryConclusionEvidence);
    expect(Object.isFrozen(Ctor)).toBe(true);
    expect(Object.isFrozen(Ctor.prototype)).toBe(true);
    expect(isDeliveryConclusionProof(new Ctor(deliveryConclusionFactsOf(genuine)!))).toBe(false);
    // The prototype, without the constructor.
    expect(isDeliveryConclusionProof(Object.create(Object.getPrototypeOf(genuine)))).toBe(false);
    // The registry-capture attack — hooking `WeakSet.prototype.add` before the
    // first mint — is not driven here, and saying so is the point. A test that
    // imports this module cannot perform it: the module is already loaded and
    // `registryHas` was bound at load, which is exactly the defence. What IS
    // reachable is the other half of that scenario, and both of its halves are
    // measured: a value on the prototype makes `factsOf` **throw**…
    const impostor = Object.create(DeliveryConclusionEvidence.prototype) as object;
    expect(() => DeliveryConclusionEvidence.factsOf(impostor as never)).toThrow();
    // …and the safe accessor refuses it without throwing, which is the whole
    // reason it exists. A check that answers by throwing is not answering.
    expect(deliveryConclusionFactsOf(impostor)).toBeNull();
  });

  it('takes the standing verdict, where hasPassFor takes any pass', () => {
    // The one shape on which the two predicates differ, and the reason this
    // slice does not reuse `hasPassFor`. It is unreachable through the product
    // path today — a pass converges `--verify-merge` before it runs anything —
    // and becomes reachable the moment a forced re-verification exists.
    const passThenFail = {
      ...verification,
      attempts: [attemptOf(), failedAttempt('VERIFIED_FAIL', { attemptedAt: LATER })],
    };
    expect(hasPassFor(passThenFail, DIGEST)).toBe(true);
    expect(standingVerdictFor(passThenFail, DIGEST)?.outcome).toBe('VERIFIED_FAIL');

    // A fail followed by a pass is a pass: the later measurement stands.
    const failThenPass = {
      ...verification,
      attempts: [failedAttempt('VERIFIED_FAIL'), attemptOf({ attemptedAt: LATER })],
    };
    expect(standingVerdictFor(failThenPass, DIGEST)?.outcome).toBe('VERIFIED_PASS');

    // An infrastructure failure after a pass is not a verdict and is skipped.
    const passThenUnavailable = {
      ...verification,
      attempts: [
        attemptOf(),
        failedAttempt('VERIFICATION_NOT_ESTABLISHED', { attemptedAt: LATER }),
      ],
    };
    expect(standingVerdictFor(passThenUnavailable, DIGEST)?.outcome).toBe('VERIFIED_PASS');

    // Only infrastructure failures is no verdict at all.
    expect(
      standingVerdictFor(
        { ...verification, attempts: [failedAttempt('VERIFICATION_NOT_ESTABLISHED')] },
        DIGEST,
      ),
    ).toBeNull();

    // And a verdict under another profile answers another question.
    expect(standingVerdictFor(verification, OTHER_DIGEST)).toBeNull();
    // Array order is the order — no instant is compared, because the clock can
    // step backwards between two machines.
    const outOfOrderClock = {
      ...verification,
      attempts: [
        attemptOf({ attemptedAt: LATER }),
        failedAttempt('VERIFIED_FAIL', { attemptedAt: AT }),
      ],
    };
    expect(standingVerdictFor(outOfOrderClock, DIGEST)?.outcome).toBe('VERIFIED_FAIL');
  });
});

/* ── 3. The ladder ───────────────────────────────────────────────────────── */

describe('the conclusion ladder refuses everything that is not the join', () => {
  it('declares its members in the order it decides them', () => {
    // The order is the order the ladder decides in, and the first three after
    // the caller's two are the conclusion's own: a delivery that was concluded
    // is reported as concluded before any other document is read.
    expect([...DELIVERY_CONCLUSIONS]).toEqual([
      'SUBJECT_NOT_ESTABLISHED',
      'TASK_NOT_READY',
      'ALREADY_CONCLUDED',
      'CONCLUSION_UNREADABLE',
      'CONCLUSION_CONFLICT',
      'RECEIPT_ABSENT',
      'RECEIPT_UNREADABLE',
      'RECEIPT_NOT_THIS_DELIVERY',
      'VERIFICATION_ABSENT',
      'VERIFICATION_UNREADABLE',
      'VERIFICATION_NOT_THIS_DELIVERY',
      'PROFILE_NOT_VERIFIED',
      'VERIFICATION_NOT_PASSING',
      'CONCLUSION_NOT_ATTESTED',
      'DELIVERY_CONCLUDED',
    ]);
    // Every member has a sentence, and no sentence is for a member that is gone.
    expect(Object.keys(DELIVERY_CONCLUSION_DETAIL).sort()).toEqual([...DELIVERY_CONCLUSIONS].sort());
    for (const member of DELIVERY_CONCLUSIONS) {
      expect(DELIVERY_CONCLUSION_DETAIL[member].length, member).toBeGreaterThan(20);
    }
  });

  it('concludes a legitimate receipt and an applicable pass', () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      expect(result.outcome).toBe('DELIVERY_CONCLUDED');
      expect(result.mergeCommit).toBe(MERGE);
      expect(result.subjectCommit).toBe(HEAD);
      expect(result.profileDigest).toBe(DIGEST);
      expect(result.standingOutcome).toBe('VERIFIED_PASS');
      const facts = deliveryConclusionFactsOf(result.proof);
      expect(facts?.concludedAt).toBe(LATER);
      expect(facts?.verifiedAt).toBe(AT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses without a receipt, and says nothing about the merge', () => {
    const root = scratch();
    try {
      writeVerification(root);
      const result = conclude(root);
      expect(result.outcome).toBe('RECEIPT_ABSENT');
      expect(result.mergeCommit).toBeNull();
      expect(result.proof).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a receipt it cannot read, however it is broken', () => {
    for (const [label, bytes] of [
      ['not json', 'nonsense'],
      ['json of the wrong shape', JSON.stringify({ reconciliationVersion: 1 })],
      [
        'a future contract',
        JSON.stringify({ reconciliationVersion: MERGE_RECONCILIATION_VERSION + 1 }),
      ],
    ] as const) {
      const root = scratch();
      try {
        mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
        writeFileSync(join(mergeReconciliationDirectory(root), `${TASK}.json`), bytes, 'utf8');
        writeVerification(root);
        expect(conclude(root).outcome, label).toBe('RECEIPT_UNREADABLE');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('refuses a receipt bound to another task, and one edited in place', () => {
    const root = scratch();
    try {
      // Bound for another subject: the digest covers the subject's own ids.
      const payload = receiptPayload(root);
      mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
      writeFileSync(
        join(mergeReconciliationDirectory(root), `${TASK}.json`),
        `${JSON.stringify(
          {
            ...payload,
            binding: mergeReconciliationBinding(
              { taskId: 'SOMEONE-ELSE', repositoryRoot: root },
              payload,
            ),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      writeVerification(root);
      expect(conclude(root).outcome).toBe('RECEIPT_UNREADABLE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a receipt about a commit this task no longer stands on', () => {
    const root = scratch();
    try {
      writeReceipt(root, { subjectCommit: OTHER, mergedHeadSha: OTHER });
      writeVerification(root, { subjectCommit: OTHER });
      expect(conclude(root).outcome).toBe('RECEIPT_NOT_THIS_DELIVERY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a receipt about another fork of the same commit', () => {
    for (const over of [
      { host: 'ghe.example.invalid' },
      { owner: 'someone-else' },
      { name: 'OtherRepo' },
    ]) {
      const root = scratch();
      try {
        writeReceipt(root, over);
        writeVerification(root, over);
        expect(conclude(root).outcome, JSON.stringify(over)).toBe('RECEIPT_NOT_THIS_DELIVERY');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('refuses without a verification history, and says which commit it wanted', () => {
    const root = scratch();
    try {
      writeReceipt(root);
      const result = conclude(root);
      expect(result.outcome).toBe('VERIFICATION_ABSENT');
      expect(result.mergeCommit).toBe(MERGE);
      expect(result.profileDigest).toBe(DIGEST);
      expect(result.standingOutcome).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a verification history it cannot read, including an edited one', () => {
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root);
      // The naive tamper: flip the verdict, leave the binding. The digest
      // covers every field of every attempt.
      const path = join(postMergeVerificationDirectory(root), `${TASK}.json`);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { attempts: VerificationAttempt[] };
      raw.attempts[0] = { ...raw.attempts[0]!, outcome: 'VERIFIED_PASS', profileDigest: DIGEST };
      raw.attempts.push(attemptOf({ attemptedAt: LATER }));
      writeFileSync(path, JSON.stringify(raw, null, 2), 'utf8');
      expect(conclude(root).outcome).toBe('VERIFICATION_UNREADABLE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a verification history about a different delivery, field by field', () => {
    // The member no existing reader could ever have produced. `verify-merge`
    // compares the merge commit alone on its convergence path; the verification
    // store compares the rest only on a path a converged run never reaches.
    for (const over of [
      { mergeCommit: OTHER },
      { subjectCommit: OTHER },
      { host: 'ghe.example.invalid' },
      { owner: 'someone-else' },
      { name: 'OtherRepo' },
      { pullRequestNumber: PR + 1 },
    ]) {
      const root = scratch();
      try {
        writeReceipt(root);
        writeVerification(root, over);
        expect(conclude(root).outcome, JSON.stringify(over)).toBe(
          'VERIFICATION_NOT_THIS_DELIVERY',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('refuses when this profile has no verdict, and names the profile it asked under', () => {
    for (const [label, attempts] of [
      ['another profile', [attemptOf({ profileDigest: OTHER_DIGEST })]],
      ['only infrastructure failures', [failedAttempt('VERIFICATION_NOT_ESTABLISHED')]],
    ] as const) {
      const root = scratch();
      try {
        writeReceipt(root);
        writeVerification(root, { attempts: [...attempts] });
        const result = conclude(root);
        expect(result.outcome, label).toBe('PROFILE_NOT_VERIFIED');
        expect(result.profileDigest, label).toBe(DIGEST);
        expect(result.standingOutcome, label).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('refuses a profile that has moved since the pass', () => {
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root);
      // The pass is real and is about this commit — under a contract this
      // repository no longer declares.
      const result = conclude(root, {}, OTHER_PROFILE);
      expect(result.outcome).toBe('PROFILE_NOT_VERIFIED');
      expect(result.profileDigest).toBe(OTHER_DIGEST);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a standing failure, and names it', () => {
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root, { attempts: [failedAttempt('VERIFIED_FAIL')] });
      const result = conclude(root);
      expect(result.outcome).toBe('VERIFICATION_NOT_PASSING');
      expect(result.standingOutcome).toBe('VERIFIED_FAIL');
      expect(result.proof).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an old pass that a newer failure has overtaken', () => {
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root, {
        attempts: [attemptOf(), failedAttempt('VERIFIED_FAIL', { attemptedAt: LATER })],
      });
      const result = conclude(root);
      expect(result.outcome).toBe('VERIFICATION_NOT_PASSING');
      expect(result.standingOutcome).toBe('VERIFIED_FAIL');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('concludes an old pass that only an infrastructure failure followed', () => {
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root, {
        attempts: [
          attemptOf(),
          failedAttempt('VERIFICATION_NOT_ESTABLISHED', { attemptedAt: LATER }),
        ],
      });
      const result = conclude(root);
      expect(result.outcome).toBe('DELIVERY_CONCLUDED');
      expect(result.standingOutcome).toBe('VERIFIED_PASS');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers ALREADY_CONCLUDED before it asks any verification question', () => {
    // The ordering is the contract. A delivery that was concluded stays
    // concluded: the profile may be edited afterwards, and the history may
    // become unreadable or vanish entirely, and none of that un-concludes it.
    for (const [label, prepare] of [
      ['no verification history at all', () => {}],
      [
        'an unreadable history',
        (root: string) => {
          mkdirSync(postMergeVerificationDirectory(root), { recursive: true });
          writeFileSync(
            join(postMergeVerificationDirectory(root), `${TASK}.json`),
            'nonsense',
            'utf8',
          );
        },
      ],
      [
        'a standing failure',
        (root: string) => writeVerification(root, { attempts: [failedAttempt('VERIFIED_FAIL')] }),
      ],
    ] as const) {
      const root = scratch();
      try {
        writeReceipt(root);
        writeConclusion(root);
        prepare(root);
        // …and under a profile this build no longer declares, for good measure.
        expect(conclude(root, {}, OTHER_PROFILE).outcome, label).toBe('ALREADY_CONCLUDED');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('refuses a stored conclusion about a different delivery of this task', () => {
    // "A different delivery" means a different implementation head or a
    // different target — the two things the ladder can compare without reading
    // the receipt, which it deliberately has not read at this point.
    for (const [label, over] of [
      ['another implementation head', { subjectCommit: OTHER }],
      ['another fork', { owner: 'someone-else' }],
      ['another host', { host: 'ghe.example.invalid' }],
      ['another repository', { name: 'OtherRepo' }],
    ] as const) {
      const root = scratch();
      try {
        writeReceipt(root);
        writeVerification(root);
        writeConclusion(root, over);
        const result = conclude(root);
        expect(result.outcome, label).toBe('CONCLUSION_CONFLICT');
        expect(result.proof, label).toBeNull();
        // Nothing was repaired: the disagreeing document is exactly as it was.
        const onDisk = JSON.parse(readFileSync(conclusionPath(root), 'utf8')) as Record<
          string,
          unknown
        >;
        for (const [k, v] of Object.entries(over)) expect(onDisk[k], label).toBe(v);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('reports a stored conclusion whose merge commit differs, without flagging it', () => {
    // The price of asking the conclusion before the receipt, stated as a test
    // rather than left to be discovered. The ladder compares the head and the
    // target, which it can get from the task; it cannot compare the merge
    // commit, which only the receipt carries. So a hand-written conclusion
    // naming a different merge for the same head reads as ALREADY_CONCLUDED —
    // and the report prints the STORED merge commit, so the discrepancy is in
    // front of the operator even though this build does not call it one.
    // Carried as L-V4-10-11.
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root);
      writeConclusion(root, { mergeCommit: OTHER });
      const result = conclude(root);
      expect(result.outcome).toBe('ALREADY_CONCLUDED');
      expect(result.mergeCommit).toBe(OTHER);
      expect(result.mergeCommit).not.toBe(MERGE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a stored conclusion it cannot read, and never writes over it', () => {
    for (const [label, bytes] of [
      ['not json', 'nonsense'],
      ['a future contract', JSON.stringify({ conclusionVersion: DELIVERY_CONCLUSION_VERSION + 1 })],
    ] as const) {
      const root = scratch();
      try {
        writeReceipt(root);
        writeVerification(root);
        mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
        writeFileSync(conclusionPath(root), bytes, 'utf8');
        expect(conclude(root).outcome, label).toBe('CONCLUSION_UNREADABLE');
        expect(readFileSync(conclusionPath(root), 'utf8'), label).toBe(bytes);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('builds the two refusals it does not own in one place', () => {
    for (const code of ['SUBJECT_NOT_ESTABLISHED', 'TASK_NOT_READY'] as const) {
      const refusal = refuseDeliveryConclusion(code);
      expect(refusal.outcome).toBe(code);
      expect(refusal.mergeCommit).toBeNull();
      expect(refusal.subjectCommit).toBeNull();
      expect(refusal.profileDigest).toBeNull();
      expect(refusal.standingOutcome).toBeNull();
      expect(refusal.proof).toBeNull();
    }
  });
});

/* ── 4. The store ────────────────────────────────────────────────────────── */

describe('the conclusion store writes once and never over anything', () => {
  it('derives one path per task, in its own directory', () => {
    const root = scratch();
    try {
      const located = deriveDeliveryConclusionLocation(root, TASK);
      expect(located.ok).toBe(true);
      if (!located.ok) throw new Error('unreachable');
      expect(located.path).toBe(conclusionPath(root));
      expect(located.directory).toContain(DELIVERY_CONCLUSION_DIR_NAME);
      // A task id may contain dots, which is why the record gets a directory
      // rather than a name inside a shared one.
      expect(deriveDeliveryConclusionLocation(root, 'a.b').ok).toBe(true);
      for (const bad of ['', '..', 'a/b', 'a\\b']) {
        expect(deriveDeliveryConclusionLocation(root, bad).ok, bad).toBe(false);
      }
      expect(deriveDeliveryConclusionLocation('relative', TASK).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records a minted conclusion, and reads it back', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      const wrote = await recordDeliveryConclusion(writeRequest(root, result.proof));
      expect(wrote.code).toBe('CONCLUSION_RECORDED');
      expect(wrote.recorded).toBe(true);
      expect(wrote.writeAttempt).toBe('COMPLETED');
      expect(conclusionIsDurable(wrote.code)).toBe(true);
      const load = loadDeliveryConclusion(root, TASK, { taskId: TASK, repositoryRoot: root });
      expect(load.reading).toBe('DELIVERY_CONCLUDED');
      expect(load.conclusion?.mergeCommit).toBe(MERGE);
      expect(load.conclusion?.subjectCommit).toBe(HEAD);
      expect(load.conclusion?.profileDigest).toBe(DIGEST);
      expect(load.conclusion?.concludedAt).toBe(LATER);
      // The two source digests really are the ones on disk.
      const receiptBytes = JSON.parse(
        readFileSync(join(mergeReconciliationDirectory(root), TASK + '.json'), 'utf8'),
      ) as { binding: string };
      const verificationBytes = JSON.parse(
        readFileSync(join(postMergeVerificationDirectory(root), TASK + '.json'), 'utf8'),
      ) as { binding: string };
      expect(load.conclusion?.receiptBinding).toBe(receiptBytes.binding);
      expect(load.conclusion?.verificationBinding).toBe(verificationBytes.binding);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses anything that is not a minted proof', async () => {
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root);
      for (const forged of [null, {}, { subjectCommit: HEAD, mergeCommit: MERGE }]) {
        const wrote = await recordDeliveryConclusion(writeRequest(root, forged));
        expect(wrote.code).toBe('CONCLUSION_NOT_PROVEN');
        expect(wrote.recorded).toBe(false);
        expect(wrote.writeAttempt).toBe('NOT_ATTEMPTED');
      }
      expect(() => statSync(conclusionPath(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a genuine proof recorded against a different expectation', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      for (const over of [
        { expectedMergeCommit: OTHER },
        { expectedSubjectCommit: OTHER },
        { expectedHost: 'ghe.example.invalid' },
        { expectedOwner: 'someone-else' },
        { expectedName: 'OtherRepo' },
        { expectedPullRequestNumber: PR + 1 },
      ]) {
        const wrote = await recordDeliveryConclusion(writeRequest(root, result.proof, over));
        expect(wrote.code, JSON.stringify(over)).toBe('SUBJECT_MISMATCH');
      }
      expect(() => statSync(conclusionPath(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent, byte for byte', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      const first = await recordDeliveryConclusion(writeRequest(root, result.proof));
      expect(first.code).toBe('CONCLUSION_RECORDED');
      const bytes = readFileSync(conclusionPath(root));

      // A second assessment converges before the store is reached…
      expect(conclude(root).outcome).toBe('ALREADY_CONCLUDED');
      // …and the store itself answers the same, for the racing caller that
      // reached it anyway. `recorded` is false — this call filed nothing — while
      // the durable claim is present all the same.
      const again = await recordDeliveryConclusion(writeRequest(root, result.proof));
      expect(again.code).toBe('ALREADY_CONCLUDED');
      expect(again.recorded).toBe(false);
      expect(again.writeAttempt).toBe('NOT_ATTEMPTED');
      expect(conclusionIsDurable(again.code)).toBe(true);
      expect(readFileSync(conclusionPath(root))).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to replace a conclusion about a different delivery', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      writeConclusion(root, { pullRequestNumber: PR + 1 });
      const bytes = readFileSync(conclusionPath(root));
      const wrote = await recordDeliveryConclusion(writeRequest(root, result.proof));
      expect(wrote.code).toBe('CONFLICTING_CONCLUSION');
      expect(wrote.recorded).toBe(false);
      expect(readFileSync(conclusionPath(root))).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to replace a document it cannot read', async () => {
    for (const label of ['not json', 'a future contract', 'another task'] as const) {
      const root = scratch();
      try {
        const result = provenConclusion(root);
        mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
        if (label === 'another task') {
          const payload = conclusionPayload(root, { taskId: 'SOMEONE-ELSE' });
          writeFileSync(
            conclusionPath(root),
            JSON.stringify(
              {
                ...payload,
                binding: deliveryConclusionBinding({ taskId: TASK, repositoryRoot: root }, payload),
              },
              null,
              2,
            ) + '\n',
            'utf8',
          );
        } else {
          writeFileSync(
            conclusionPath(root),
            label === 'not json'
              ? 'nonsense'
              : JSON.stringify({ conclusionVersion: DELIVERY_CONCLUSION_VERSION + 1 }),
            'utf8',
          );
        }
        const before = readFileSync(conclusionPath(root));
        const wrote = await recordDeliveryConclusion(writeRequest(root, result.proof));
        expect(wrote.code, label).toBe('EXISTING_CONCLUSION_UNREADABLE');
        expect(readFileSync(conclusionPath(root)), label).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('refuses to write where the record would not be ignored by Git', async () => {
    for (const [verdict, code] of [
      ['NOT_IGNORED', 'RUNTIME_PATH_NOT_IGNORED'],
      ['UNDETERMINED', 'RUNTIME_IGNORE_UNDETERMINED'],
    ] as const) {
      const root = scratch();
      try {
        const result = provenConclusion(root);
        // Both names are asked about, and both must answer. The staging probe
        // fires first…
        const staging = await recordDeliveryConclusion(
          writeRequest(root, result.proof, {
            checkIgnored: async (p: string): Promise<ConclusionIgnoreVerdict> =>
              p.endsWith('.tmp-probe') ? verdict : 'IGNORED',
          }),
        );
        expect(staging.code, 'staging ' + verdict).toBe(code);
        // …and the record name is asked about separately, so a build that only
        // gated the staging name would let this through.
        const record = await recordDeliveryConclusion(
          writeRequest(root, result.proof, {
            checkIgnored: async (p: string): Promise<ConclusionIgnoreVerdict> =>
              p.endsWith('.tmp-probe') ? 'IGNORED' : verdict,
          }),
        );
        expect(record.code, 'record ' + verdict).toBe(code);
        expect(() => statSync(conclusionPath(root))).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('reports a failed replace as a failed write, and writes nothing', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, {
          replace: () => {
            const error = new Error('nope') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          },
        }),
      );
      expect(wrote.code).toBe('WRITE_FAILED');
      expect(wrote.recorded).toBe(false);
      expect(wrote.writeAttempt).toBe('FAILED');
      expect(wrote.errnoCode).toBe('EPERM');
      expect(conclusionIsDurable(wrote.code)).toBe(false);
      expect(() => statSync(conclusionPath(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('grades every code, and only two of them as durable', () => {
    const codes: DeliveryConclusionRecordCode[] = [
      'CONCLUSION_RECORDED',
      'ALREADY_CONCLUDED',
      'CONCLUSION_NOT_PROVEN',
      'SUBJECT_MISMATCH',
      'CONFLICTING_CONCLUSION',
      'EXISTING_CONCLUSION_UNREADABLE',
      'EVIDENCE_MOVED',
      'LOCATION_UNSUITABLE',
      'RUNTIME_PATH_NOT_IGNORED',
      'RUNTIME_IGNORE_UNDETERMINED',
      'RECORD_CONTRACT_VIOLATION',
      'RECORD_TOO_LARGE',
      'DIRECTORY_CREATE_FAILED',
      'WRITE_FAILED',
    ];
    expect(codes.filter((c) => conclusionIsDurable(c))).toEqual([
      'CONCLUSION_RECORDED',
      'ALREADY_CONCLUDED',
    ]);
    expect([...CONCLUSION_WRITE_ATTEMPTS]).toEqual(['NOT_ATTEMPTED', 'COMPLETED', 'FAILED']);
  });

  it('reports an unusable location without touching the filesystem', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, { taskId: 'a/b' }),
      );
      expect(wrote.code).toBe('LOCATION_UNSUITABLE');
      expect(wrote.path).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads an unopenable file as unreadable rather than as one nobody wrote', () => {
    const root = scratch();
    try {
      const load = loadDeliveryConclusion(
        root,
        TASK,
        { taskId: TASK, repositoryRoot: root },
        () => {
          const error = new Error('denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      );
      // Not `ABSENT`. Reporting a permissions problem as "nobody wrote one"
      // would, at the writer, become permission to write a fresh conclusion
      // over it.
      expect(load.reading).toBe('MALFORMED');
      expect(load.conclusion).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a torn file as malformed rather than as a smaller record', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      await recordDeliveryConclusion(writeRequest(root, result.proof));
      expect(
        loadDeliveryConclusion(root, TASK, { taskId: TASK, repositoryRoot: root }).reading,
      ).toBe('DELIVERY_CONCLUDED');
      // A short read is a torn or truncated file. No real local filesystem
      // returns early for a file this small, which is why the seam exists.
      const torn = loadDeliveryConclusion(
        root,
        TASK,
        { taskId: TASK, repositoryRoot: root },
        undefined,
        () => 0,
      );
      expect(torn.reading).toBe('MALFORMED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ── 5. The freshness gate ───────────────────────────────────────────────── */

describe('a conclusion is refused when its own evidence moves under it', () => {
  /**
   * The gate is reached without injecting it.
   *
   * `checkIgnored` is awaited a few lines before the re-read, so a probe that
   * moves a document exercises the real readers at the real moment. That
   * matters: a `reread` seam would prove the comparison and never that anything
   * was read.
   */
  function movingProbe(move: () => void) {
    let fired = false;
    return async (): Promise<ConclusionIgnoreVerdict> => {
      if (!fired) {
        fired = true;
        move();
      }
      return 'IGNORED';
    };
  }

  it('refuses when the receipt changes between the assessment and the write', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, {
          // A different, perfectly valid receipt for the same delivery: only
          // the instants move, so every identity comparison still holds and the
          // binding is what catches it.
          checkIgnored: movingProbe(() => writeReceipt(root, { reconciledAt: LATER })),
        }),
      );
      expect(wrote.code).toBe('EVIDENCE_MOVED');
      expect(wrote.recorded).toBe(false);
      expect(wrote.writeAttempt).toBe('NOT_ATTEMPTED');
      expect(() => statSync(conclusionPath(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the receipt becomes unreadable between the two', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, {
          checkIgnored: movingProbe(() =>
            rmSync(join(mergeReconciliationDirectory(root), TASK + '.json')),
          ),
        }),
      );
      expect(wrote.code).toBe('EVIDENCE_MOVED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the verification history grows between the two', async () => {
    // The honest case: the history is append-only, so a concurrent
    // `--verify-merge` moves it without anybody tampering.
    const root = scratch();
    try {
      const result = provenConclusion(root);
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, {
          checkIgnored: movingProbe(() =>
            writeVerification(root, {
              attempts: [attemptOf(), attemptOf({ attemptedAt: LATER })],
            }),
          ),
        }),
      );
      expect(wrote.code).toBe('EVIDENCE_MOVED');
      expect(() => statSync(conclusionPath(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the task state has moved, and asks a function for the answer', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      let reads = 0;
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, {
          assessedStateRevision: 'r'.repeat(64),
          readStateRevision: () => {
            reads += 1;
            return 's'.repeat(64);
          },
        }),
      );
      expect(wrote.code).toBe('EVIDENCE_MOVED');
      // Asked exactly once, at the write, rather than captured up front.
      expect(reads).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the task state cannot be read at all', async () => {
    const root = scratch();
    try {
      const result = provenConclusion(root);
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, { readStateRevision: () => null }),
      );
      expect(wrote.code).toBe('EVIDENCE_MOVED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not refuse when nothing moved', async () => {
    // The positive control. Without it every `EVIDENCE_MOVED` above could be an
    // instrument that always fires.
    const root = scratch();
    try {
      const result = provenConclusion(root);
      let probes = 0;
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, {
          checkIgnored: async (): Promise<ConclusionIgnoreVerdict> => {
            probes += 1;
            return 'IGNORED';
          },
        }),
      );
      expect(wrote.code).toBe('CONCLUSION_RECORDED');
      expect(probes).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ── 6. Real Git: what a conclusion is deliberately blind to ─────────────── */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}${r.stdout ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

/**
 * One repository, built once, and copied for every fixture that needs one.
 *
 * The template holds a real merge: `base` on `main`, `side` on a branch, and a
 * real `--no-ff` merge commit **M** on `main`. Each fixture then moves `main`
 * somewhere else, so that a build which *did* ask Git about the base would give
 * a different answer in each of them.
 *
 * Built once and `cpSync`-ed for the reason the slice before this one recorded
 * after CI measured it: a plain repository's `.git` holds no absolute paths, so
 * a copy is a working repository, and 27 repositories at eight `git` processes
 * each is what pushed an unrelated 190-second file's hook over its timeout.
 * This file makes the template plus one copy per fixture that needs one; a
 * review counted them, so a number is deliberately not restated here to go
 * stale. Measured solo runtime is under three seconds.
 */
let templateRepo: { path: string; mergeCommit: string; baseCommit: string } | null = null;

function repositoryTemplate(): { path: string; mergeCommit: string; baseCommit: string } {
  if (templateRepo !== null) return templateRepo;
  const path = scratchRoot('ao-v410-template-');
  git(path, 'init', '--quiet', '-b', BASE, '.');
  git(path, 'config', 'user.email', 'fixture@example.invalid');
  git(path, 'config', 'user.name', 'fixture');
  writeFileSync(join(path, '.gitignore'), 'node_modules/\ndist/\n.agent-orchestrator/\n', 'utf8');
  writeFileSync(join(path, 'tracked.txt'), 'base\n', 'utf8');
  git(path, 'add', '-A');
  git(path, 'commit', '--quiet', '-m', 'base');
  const baseCommit = git(path, 'rev-parse', 'HEAD');
  git(path, 'checkout', '--quiet', '-b', 'side');
  writeFileSync(join(path, 'delivered.txt'), 'the delivery\n', 'utf8');
  git(path, 'add', '-A');
  git(path, 'commit', '--quiet', '-m', 'the delivery');
  git(path, 'checkout', '--quiet', BASE);
  git(path, 'merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
  const mergeCommit = git(path, 'rev-parse', 'HEAD');
  templateRepo = { path, mergeCommit, baseCommit };
  return templateRepo;
}

function realRepo(prefix: string): { root: string; mergeCommit: string; baseCommit: string } {
  const template = repositoryTemplate();
  const root = scratchRoot(prefix);
  cpSync(template.path, root, { recursive: true });
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  return { root, mergeCommit: template.mergeCommit, baseCommit: template.baseCommit };
}

describe('a conclusion asks Git nothing, measured against repositories where it would matter', () => {
  /**
   * The four fixtures, and what a base-membership gate would have answered.
   *
   * Measured with real Git while this slice was written, on Git 2.55.0.windows.3:
   *
   *  - **advanced** — `main` moved on past M. `merge-base --is-ancestor M main`
   *    exits 0;
   *  - **reverted** — M's whole contribution is deleted from `main` by a real
   *    `git revert -m 1`. It exits **0 as well** — byte for byte the same answer
   *    as `advanced`, which is why ancestry is not a claim about content;
   *  - **rewritten** — `main` is force-moved to history without M. It exits 1,
   *    the genuine-no code;
   *  - **absent** — the object M is not in this repository at all. It exits 128,
   *    which is not an answer.
   *
   * The conclusion is identical in all four, because none of those questions is
   * asked. A build that started asking would fail the last two.
   */
  const fixtures = [
    {
      label: 'the base advanced past the merge',
      prepare: (root: string) => {
        writeFileSync(join(root, 'tracked.txt'), 'later\n', 'utf8');
        git(root, 'add', '-A');
        git(root, 'commit', '--quiet', '-m', 'later work');
      },
      ancestor: 0,
      // The ancestry control alone cannot fail for this fixture — the untouched
      // template also answers 0 — so each arm names a second fact that is true
      // only if `prepare` really did its work. A review measured two of these
      // three arms passing identically with no preparation at all.
      moved: (root: string, merge: string) => git(root, 'rev-parse', BASE) !== merge,
    },
    {
      label: 'the merge was reverted',
      prepare: (root: string, merge: string) => {
        git(root, 'revert', '-m', '1', '--no-edit', merge);
      },
      ancestor: 0,
      // The delivery's whole contribution is gone from the base tree, while
      // ancestry still answers 0. That is the finding this fixture exists for.
      moved: (root: string) => git(root, 'ls-tree', BASE, '--', 'delivered.txt') === '',
    },
    {
      label: 'the base was force-moved off the merge',
      prepare: (root: string, _merge: string, base: string) => {
        git(root, 'reset', '--hard', '--quiet', base);
      },
      ancestor: 1,
      moved: (root: string, _merge: string, base: string) =>
        git(root, 'rev-parse', BASE) === base,
    },
  ] as const;

  for (const fixture of fixtures) {
    it(`concludes the same when ${fixture.label}`, () => {
      const repo = realRepo('ao-v410-git-');
      try {
        fixture.prepare(repo.root, repo.mergeCommit, repo.baseCommit);
        // The control: Git really does answer what this fixture is for. Without
        // it, "the conclusion is unchanged" could be a statement about a
        // repository nothing ever happened in.
        const probe = spawnSync(
          'git',
          ['merge-base', '--is-ancestor', repo.mergeCommit, BASE],
          { cwd: repo.root, encoding: 'utf8' },
        );
        expect(probe.status, fixture.label).toBe(fixture.ancestor);
        // …and the second control, which the ancestry one cannot supply for two
        // of the three arms: the repository really is in the state the label
        // claims.
        expect(
          fixture.moved(repo.root, repo.mergeCommit, repo.baseCommit),
          `${fixture.label} (the fixture did not take)`,
        ).toBe(true);

        writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
        writeVerification(repo.root, { mergeCommit: repo.mergeCommit });
        const result = conclude(repo.root);
        expect(result.outcome, fixture.label).toBe('DELIVERY_CONCLUDED');
        expect(result.mergeCommit).toBe(repo.mergeCommit);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }

  it('concludes when the merge object is not in this repository at all', () => {
    // The sharpest case, and the one that makes the claim "no Git history is
    // read" measurable rather than asserted. `--verify-merge` refuses this
    // repository with `MERGE_COMMIT_UNAVAILABLE`; the conclusion does not ask,
    // because the pass it is reading was recorded when the object was there.
    const repo = realRepo('ao-v410-absent-');
    try {
      const absent = 'c'.repeat(40);
      const probe = spawnSync('git', ['cat-file', '-t', absent], {
        cwd: repo.root,
        encoding: 'utf8',
      });
      expect(probe.status).not.toBe(0);

      writeReceipt(repo.root, { mergeCommit: absent });
      writeVerification(repo.root, { mergeCommit: absent });
      const result = conclude(repo.root);
      expect(result.outcome).toBe('DELIVERY_CONCLUDED');
      expect(result.mergeCommit).toBe(absent);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('concludes when the base branch does not exist', () => {
    const repo = realRepo('ao-v410-nobase-');
    try {
      git(repo.root, 'checkout', '--quiet', '-b', 'detached-work');
      git(repo.root, 'branch', '-D', BASE);
      const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${BASE}`], {
        cwd: repo.root,
        encoding: 'utf8',
      });
      expect(probe.status).not.toBe(0);

      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      writeVerification(repo.root, { mergeCommit: repo.mergeCommit });
      expect(conclude(repo.root).outcome).toBe('DELIVERY_CONCLUDED');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});

/* ── 7. What this slice must not touch ───────────────────────────────────── */

describe('concluding a delivery changes no execution state and no ledger', () => {
  it('leaves the task state byte-identical and a settled entry provable', async () => {
    const repo = realRepo('ao-v410-state-');
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

      // Now conclude, for real, end to end — with the real state revision on
      // both sides of the freshness gate.
      const result = provenConclusion(repo.root);
      const wrote = await recordDeliveryConclusion(
        writeRequest(repo.root, result.proof, {
          assessedStateRevision: before.revision,
          readStateRevision: () => {
            const again = loadTaskState(repo.root, TASK);
            return again.ok ? again.revision : null;
          },
        }),
      );
      // The positive control: something really was written, so the assertions
      // below are about a conclusion that happened.
      expect(wrote.code).toBe('CONCLUSION_RECORDED');

      // Byte-identical. Not "equivalent", not "unchanged in the fields we care
      // about" — the ledger's evidence revision is a digest over exactly these
      // bytes.
      expect(readFileSync(saved.path)).toEqual(stateBytes);
      const after = loadTaskState(repo.root, TASK);
      if (!after.ok) throw new Error('state unreadable after');
      expect(after.revision).toBe(before.revision);
      expect(after.state.state).toBe('READY_FOR_PR');
      // `currentCommit` stays H. It is emphatically not advanced to M.
      expect(after.state.currentCommit).toBe(HEAD);
      expect(after.state.currentCommit).not.toBe(MERGE);
      // And the settled entry still proves — `resultCommit` is still H too.
      expect(proveBlockTaskEntry(repo.root, entry).code).toBe('PROVEN');

      // The negative controls, so the assertions above are instruments rather
      // than restatements of a default.
      expect(
        proveBlockTaskEntry(repo.root, { ...entry, evidenceRevision: 'f'.repeat(64) }).code,
      ).not.toBe('PROVEN');
      expect(proveBlockTaskEntry(repo.root, { ...entry, resultCommit: MERGE }).code).not.toBe(
        'PROVEN',
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('leaves READY_FOR_PR terminal and invents no COMPLETE state', () => {
    // The invariant the whole architecture of this slice rests on, pinned by a
    // test rather than by a document. A `COMPLETE` task state would break the
    // ledger's byte digest for every settled entry, and `tests/v4-08-…` already
    // fails by name on one; this states the other half — that slice 10 did not
    // add one either.
    expect([...TERMINAL_STATES]).toEqual(['READY_FOR_PR', 'ABORTED']);
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
    for (const invented of ['COMPLETE', 'COMPLETED', 'DELIVERED', 'CONCLUDED', 'MERGED']) {
      expect(ALL_STATES, invented).not.toContain(invented);
    }
  });

  it('reaches no state writer, no ledger writer, no agent and no forge', () => {
    for (const file of [
      'src/deliver/conclude-delivery.ts',
      'src/deliver/delivery-conclusion.ts',
      'src/deliver/delivery-conclusion-store.ts',
      'src/deliver/delivery-conclusion-proof.ts',
      'src/deliver/internal/delivery-conclusion-proof.ts',
    ]) {
      const source = codeOnly(file);
      expect(source.replace(/\s+/g, '').length, file).toBeGreaterThan(300);
      for (const forbidden of FORBIDDEN_ON_THE_CONCLUSION_PATH) {
        expect(source, `${file} must not reach ${forbidden}`).not.toContain(forbidden);
      }
      // The COMPLETE state, as a whole word. Built with `new RegExp` from a raw
      // string and given its own controls first: a word-boundary escape that
      // arrives mangled produces a pattern incapable of matching anything, and
      // a review measured exactly that in the sibling suite.
      const COMPLETE_STATE = new RegExp('\\bCOMPLETE\\b');
      expect(COMPLETE_STATE.test("state === 'COMPLETE'")).toBe(true);
      expect(COMPLETE_STATE.test("writeAttempt: 'COMPLETED'")).toBe(false);
      expect(source, `${file} must not name the COMPLETE state`).not.toMatch(COMPLETE_STATE);
    }
    // A positive control for EVERY forbidden token, not three of twenty-one.
    //
    // A boundary is only a boundary while the words in it name something real:
    // rename any of these anywhere in `src/` and the loop above silently stops
    // guarding, with nothing failing. So each token is proved to exist in the
    // tree it is being excluded from. A review counted 17 without one.
    const everySource = sourceFilesUnderSrc()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(everySource.length).toBeGreaterThan(100_000);
    for (const token of FORBIDDEN_ON_THE_CONCLUSION_PATH) {
      expect(
        everySource.includes(token),
        `${token} no longer exists in src/, so excluding it measures nothing`,
      ).toBe(true);
    }
  });

  it('asks Git nothing about the commit graph, and fetches nothing', () => {
    // The measurable form of "no Git history is read". Every probe this build
    // owns for asking about the graph is named, and the positive control proves
    // the names are the real ones rather than a list that matches nothing.
    const probes = ['classifyAncestry', 'commitObjectPresent', 'commitIsReferenced'];
    for (const file of [
      'src/deliver/conclude-delivery.ts',
      'src/deliver/delivery-conclusion.ts',
      'src/deliver/delivery-conclusion-store.ts',
      'src/deliver/internal/delivery-conclusion-proof.ts',
    ]) {
      const source = codeOnly(file);
      for (const probe of [...probes, 'commit-probes', 'merge-base', 'is-ancestor', 'rev-parse']) {
        expect(source, `${file} must not reach ${probe}`).not.toContain(probe);
      }
      // The pattern is shown able to match before it is trusted as a boundary:
      // a regex that matches nothing anywhere is an assertion incapable of
      // failing, and this repository has shipped one of those before.
      const QUOTED_FETCH = /['"]fetch['"]/;
      expect(QUOTED_FETCH.test("await runner('fetch', args)")).toBe(true);
      expect(QUOTED_FETCH.test('const prefetch = 1;')).toBe(false);
      expect(source, `${file} must not fetch`).not.toMatch(QUOTED_FETCH);
    }
    // The positive control for the probe names: they are what the module that
    // owns them really exports, so the loop above is a boundary rather than a
    // list of words nothing uses.
    const owner = readFileSync('src/worktree/commit-probes.ts', 'utf8');
    for (const probe of probes) expect(owner, probe).toContain(`export async function ${probe}`);
    // And the one Git question the write path DOES ask, which is not about the
    // graph: whether the path it is about to write is ignored.
    expect(codeOnly('src/deliver/delivery-conclusion-store.ts')).toContain('checkIgnored');
    // Neither of this slice's two reading modules names a fetch, comments
    // included. A previous version of this comment said "the whole product
    // still has no fetch anywhere" — which is true, and is not what these two
    // lines measure. Slice 9's suite pins the whole-product property.
    for (const file of [
      'src/deliver/conclude-delivery.ts',
      'src/deliver/delivery-conclusion-store.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/git\s+fetch/);
    }
  });

  it('never writes the merge receipt or the verification history it reads', () => {
    for (const file of [
      'src/deliver/conclude-delivery.ts',
      'src/deliver/delivery-conclusion-store.ts',
    ]) {
      const source = codeOnly(file);
      // Both are read, BY NAME. `toContain('load')` stood here, and a review
      // measured it satisfied by the word `payload` — an assertion that holds
      // with every loader call deleted.
      expect(source, file).toContain('loadMergeReconciliation(');
      expect(source, file).toContain('loadPostMergeVerification(');
      // …and neither is written. Slices 8 and 9 own their own records.
      expect(source, file).not.toContain('recordMergeReconciliation');
      expect(source, file).not.toContain('recordPostMergeVerification');
    }
  });
});

/* ── 8. The command surface ──────────────────────────────────────────────── */

describe('the delivery command concludes only when asked', () => {
  function fixtureRepo(): { root: string; gitCommonDir: string; dispose: () => void } {
    const repo = realRepo('ao-v410-cli-');
    const gitCommonDir = git(repo.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return {
      root: repo.root,
      gitCommonDir,
      dispose: () => rmSync(repo.root, { recursive: true, force: true }),
    };
  }

  function taskStateFor(root: string) {
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
    };
  }

  async function runCli(
    argv: readonly string[],
    repo: { root: string; gitCommonDir: string },
    over: { taskState?: unknown } = {},
  ): Promise<{ out: string; forgeCalls: number; exitCode: number | undefined }> {
    let forgeCalls = 0;
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
        // The REAL task-state reader. The freshness gate compares a revision
        // read at the write against the one the subject was resolved from, and
        // a stub would answer the same value both times — which is the shape of
        // a check that always passes.
        ...(over.taskState === undefined ? {} : { loadTaskState: over.taskState as never }),
        runner: (async () => {
          forgeCalls += 1;
          return { outcome: 'UNAVAILABLE' } as never;
        }) as never,
        checkIgnored: async () => 'IGNORED',
        now: () => new Date(LATER),
      });
      await program.parseAsync(
        ['node', 'agent-loop', 'delivery', '--repository', repo.root, '--task', TASK, ...argv],
        { from: 'node' },
      );
      return { out: chunks.join(''), forgeCalls, exitCode: process.exitCode as number | undefined };
    } finally {
      write.mockRestore();
      process.exitCode = outerExitCode;
    }
  }

  it('says nothing about a conclusion when the flag is absent', async () => {
    const repo = fixtureRepo();
    try {
      saveTaskState(taskStateFor(repo.root), { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);
      const r = await runCli([], repo);
      expect(r.out).not.toContain('Completion   :');
      expect(r.out).not.toContain(CONCLUSION_TRAILER);
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('concludes, reports both lines, and exits nominal', async () => {
    const repo = fixtureRepo();
    try {
      saveTaskState(taskStateFor(repo.root), { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);
      const r = await runCli(['--conclude-delivery'], repo);
      expect(r.out).toContain('Completion   : DELIVERY_CONCLUDED');
      expect(r.out).toContain(`Merge commit : ${MERGE}`);
      expect(r.out).toContain(`Delivered    : ${HEAD}`);
      expect(r.out).toContain(`Profile      : ${DIGEST}`);
      expect(r.out).toContain('Verified as  : VERIFIED_PASS');
      expect(r.out).toContain('Record       : CONCLUSION_RECORDED  (write: COMPLETED)');
      expect(r.out).toContain(CONCLUSION_EVENT_SENTENCE);
      expect(r.out).toContain(CONCLUSION_TRAILER);
      // Not read-only here, and it must not say it is.
      expect(r.out).not.toContain('Read-only. No forge was contacted');
      // No forge client was ever started, and no lease was taken — so the
      // verification trailer, which is the one that discloses a lease, is absent.
      expect(r.forgeCalls).toBe(0);
      expect(r.out).not.toContain(VERIFICATION_TRAILER);
      expect(r.exitCode ?? EXIT_RUN_OK).toBe(EXIT_RUN_OK);
      // And the record really is on disk.
      expect(
        loadDeliveryConclusion(repo.root, TASK, { taskId: TASK, repositoryRoot: repo.root })
          .reading,
      ).toBe('DELIVERY_CONCLUDED');
    } finally {
      repo.dispose();
    }
  });

  it('is idempotent from the command, and says so', async () => {
    const repo = fixtureRepo();
    try {
      saveTaskState(taskStateFor(repo.root), { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);
      const first = await runCli(['--conclude-delivery'], repo);
      const bytes = readFileSync(conclusionPath(repo.root));
      const again = await runCli(['--conclude-delivery'], repo);
      expect(again.out).toContain('Completion   : ALREADY_CONCLUDED');
      expect(again.out).toContain('Record       : not written — no attempt was made to record');
      expect(again.out).toContain(CONCLUSION_EVENT_SENTENCE);
      // The line that says which profile the STORED conclusion was drawn under,
      // beside the one resolved now. Nothing asserted the rendered line until a
      // counter-proof deleted it and survived; the result field alone is not
      // what an operator reads.
      expect(again.out).toContain(`Concluded on : ${DIGEST}  (the same profile)`);
      expect(again.out).toContain(`Profile      : ${DIGEST}`);
      // …and it is NOT printed on the run that drew the conclusion, because
      // there was no stored one to report.
      expect(first.out).not.toContain('Concluded on :');
      expect(again.exitCode ?? EXIT_RUN_OK).toBe(EXIT_RUN_OK);
      expect(readFileSync(conclusionPath(repo.root))).toEqual(bytes);
    } finally {
      repo.dispose();
    }
  });

  it('refuses a task that is not ready, and writes nothing', async () => {
    const repo = fixtureRepo();
    try {
      saveTaskState(
        { ...taskStateFor(repo.root), state: 'REVIEWING' },
        { repositoryRoot: repo.root },
      );
      writeReceipt(repo.root);
      writeVerification(repo.root);
      const r = await runCli(['--conclude-delivery'], repo);
      expect(r.out).toContain('Completion   : TASK_NOT_READY');
      expect(r.out).toContain('Merge commit : none was established');
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('does not exit nominal when it concluded and could not leave the conclusion on disk', async () => {
    // The one departure from this command's exit-code convention, and it is
    // narrow on purpose. A refusal is an *answer* and keeps the convention: the
    // report carries it and `$?` is unchanged. But a run that decided the
    // delivery was concluded and then wrote nothing has told a caller yes about
    // something that did not happen.
    const repo = fixtureRepo();
    try {
      saveTaskState(taskStateFor(repo.root), { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);
      // Make the ignore probe refuse, so the ladder concludes and the store does
      // not write.
      const chunks: string[] = [];
      const outer = process.exitCode;
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
          checkIgnored: async () => 'NOT_IGNORED',
          now: () => new Date(LATER),
        });
        await program.parseAsync(
          [
            'node',
            'agent-loop',
            'delivery',
            '--repository',
            repo.root,
            '--task',
            TASK,
            '--conclude-delivery',
          ],
          { from: 'node' },
        );
        const out = chunks.join('');
        expect(out).toContain('Completion   : DELIVERY_CONCLUDED');
        expect(out).toContain('Record       : RUNTIME_PATH_NOT_IGNORED  (write: NOT_ATTEMPTED)');
        // Not nominal — and not `EXIT_RUN_NEEDS_OPERATOR` either. A path Git
        // says is not ignored is a repository defect fixed by editing it, which
        // this repository grades 2 for `RUNTIME_NOT_IGNORED` in the very same
        // table. A review measured the first version collapsing all twelve
        // non-durable codes onto 3.
        expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
        expect(process.exitCode).not.toBe(EXIT_RUN_OK);
        expect(() => statSync(conclusionPath(repo.root))).toThrow();
      } finally {
        write.mockRestore();
        process.exitCode = outer;
      }
    } finally {
      repo.dispose();
    }
  });

  it('keeps the convention for every refusal, which is an answer rather than a failure', async () => {
    const repo = fixtureRepo();
    try {
      saveTaskState(taskStateFor(repo.root), { repositoryRoot: repo.root });
      // No receipt and no history: the ladder refuses, and the exit code is the
      // observation's, exactly as `--reconcile-merge` and `--verify-merge` do.
      const r = await runCli(['--conclude-delivery'], repo);
      expect(r.out).toContain('Completion   : RECEIPT_ABSENT');
      expect(r.exitCode ?? EXIT_RUN_OK).toBe(EXIT_RUN_OK);
    } finally {
      repo.dispose();
    }
  });

  it('registers one sentence, and says on it what a conclusion is not', () => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const option = delivery?.options.find((o) => o.long === '--conclude-delivery');
    expect(option).toBeDefined();
    // The registered sentence is the exported one, not a copy.
    expect(option?.description).toBe(CONCLUDE_DELIVERY_OPTION_DESCRIPTION);
    for (const clause of [
      'takes no execution lease',
      'starts no agent',
      'runs no verification',
      'contacts no forge',
      'READY_FOR_PR stays terminal',
      'no Git history is read',
      'is reachable from it',
      'has not been reverted',
      'changes are still present',
      'base branch passes today',
      'does not exit nominal',
      'Read the Completion and Record lines',
    ]) {
      expect(CONCLUDE_DELIVERY_OPTION_DESCRIPTION, clause).toContain(clause);
    }
    // And the command's own description names it as a record writer, beside the
    // three that came before it.
    expect(DELIVERY_COMMAND_DESCRIPTION).toMatch(
      /flag here that writes a record[^.]*--conclude-delivery/,
    );
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--conclude-delivery it joins that receipt');
    // The five words that name an override of a refusal, read from the
    // REGISTERED option rather than from a literal written here — a review
    // measured the literal version incapable of failing for any product change.
    // `tests/v4-07-…` enforces the same rule over the whole registered set.
    expect(option?.long).toBe('--conclude-delivery');
    expect(option?.long ?? '').not.toMatch(/force|unattended|adopt|takeover|steal/i);
  });
});

/* ── 9. Two guards a counter-proof found unmeasured ──────────────────────── */

describe('the conclusion record refuses what a hand and a schema can each produce', () => {
  it('refuses a stored conclusion edited in place, and never writes over it', async () => {
    // A mutation campaign found this unmeasured: every earlier case reached the
    // reading through a *recomputed* binding, so the comparison against the
    // stored one was never the line that fired. This is the naive tamper — flip
    // a field, leave the digest — and it is the one an operator is most likely
    // to attempt.
    for (const [label, over] of [
      ['the merge commit', { mergeCommit: OTHER }],
      ['the pull request', { pullRequestNumber: PR + 1 }],
      ['the profile it was judged under', { profileDigest: OTHER_DIGEST }],
      ['the instant it was drawn', { concludedAt: LATER }],
    ] as const) {
      const root = scratch();
      try {
        writeReceipt(root);
        writeVerification(root);
        writeConclusion(root);
        const raw = JSON.parse(readFileSync(conclusionPath(root), 'utf8')) as Record<
          string,
          unknown
        >;
        // The binding is left exactly as it was. That is the whole case.
        const tampered: Record<string, unknown> = { ...raw, ...over };
        expect(tampered['binding']).toBe(raw['binding']);
        writeFileSync(conclusionPath(root), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

        expect(
          loadDeliveryConclusion(root, TASK, { taskId: TASK, repositoryRoot: root }).reading,
          label,
        ).toBe('NOT_THIS_TASK');
        // The ladder reports it as a document it cannot read, and refuses.
        expect(conclude(root).outcome, label).toBe('CONCLUSION_UNREADABLE');

        // And the store refuses to replace it, so the tampered bytes are not
        // quietly repaired into a fresh conclusion.
        const clean = scratch();
        try {
          const result = provenConclusion(clean);
          const before = readFileSync(conclusionPath(root));
          const wrote = await recordDeliveryConclusion(
            writeRequest(root, result.proof, {
              // The proof is about `clean`'s documents; what is being measured
              // is that the store will not overwrite an unreadable file at
              // `root`, which it refuses before it ever compares evidence.
            }),
          );
          expect(wrote.code, label).toBe('EXISTING_CONCLUSION_UNREADABLE');
          expect(readFileSync(conclusionPath(root)), label).toEqual(before);
        } finally {
          rmSync(clean, { recursive: true, force: true });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('will not file a document it would not accept back', async () => {
    // The read-back-before-write, and a counter-proof measured that nothing
    // reached it. It is **not** unreachable: the merge receipt's schema requires
    // `mergedHeadSha === subjectCommit` and says nothing about `mergeCommit`, so
    // a hand-written receipt whose merge commit IS its own head validates,
    // passes the ladder and mints a proof — and the conclusion's own schema then
    // refuses it, because on every merge method GitHub offers those two are
    // different objects.
    const root = scratch();
    try {
      writeReceipt(root, { mergeCommit: HEAD });
      writeVerification(root, { mergeCommit: HEAD });
      const result = conclude(root);
      // The positive control: the ladder really did get all the way through, so
      // the assertion below is about the write gate rather than about an earlier
      // refusal.
      expect(result.outcome).toBe('DELIVERY_CONCLUDED');
      expect(result.mergeCommit).toBe(HEAD);

      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, { expectedMergeCommit: HEAD }),
      );
      expect(wrote.code).toBe('RECORD_CONTRACT_VIOLATION');
      expect(wrote.recorded).toBe(false);
      expect(wrote.writeAttempt).toBe('NOT_ATTEMPTED');
      expect(conclusionIsDurable(wrote.code)).toBe(false);
      expect(() => statSync(conclusionPath(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ── 10. What an independent review measured as unpinned ─────────────────── */

describe('a concluded delivery survives every source the ladder reads', () => {
  /**
   * The ordering finding, driven.
   *
   * The first version of this ladder asked the merge receipt before it looked
   * for a conclusion, so a task whose conclusion sat readable on disk answered
   * `RECEIPT_ABSENT` — the monotonicity the record exists for held against two
   * of its three sources and not the third. Each arm below is a source going
   * away underneath a conclusion that is still there.
   */
  const wreck = [
    {
      label: 'the receipt is deleted',
      break: (root: string) => rmSync(join(mergeReconciliationDirectory(root), `${TASK}.json`)),
    },
    {
      label: 'the receipt is rewritten by a newer build',
      break: (root: string) =>
        writeFileSync(
          join(mergeReconciliationDirectory(root), `${TASK}.json`),
          JSON.stringify({ reconciliationVersion: MERGE_RECONCILIATION_VERSION + 1 }),
          'utf8',
        ),
    },
    {
      label: 'the receipt is corrupted',
      break: (root: string) =>
        writeFileSync(join(mergeReconciliationDirectory(root), `${TASK}.json`), 'nonsense', 'utf8'),
    },
    {
      label: 'the verification history is deleted',
      break: (root: string) =>
        rmSync(join(postMergeVerificationDirectory(root), `${TASK}.json`)),
    },
    {
      label: 'the verification history is corrupted',
      break: (root: string) =>
        writeFileSync(
          join(postMergeVerificationDirectory(root), `${TASK}.json`),
          'nonsense',
          'utf8',
        ),
    },
  ] as const;

  for (const arm of wreck) {
    it(`still answers ALREADY_CONCLUDED when ${arm.label}`, () => {
      const root = scratch();
      try {
        writeReceipt(root);
        writeVerification(root);
        writeConclusion(root);
        // The control: with everything intact this is what the ladder says, so
        // the assertion below is about the conclusion surviving rather than
        // about a fixture that never worked.
        expect(conclude(root).outcome, `${arm.label} (control)`).toBe('ALREADY_CONCLUDED');
        arm.break(root);
        const result = conclude(root);
        expect(result.outcome, arm.label).toBe('ALREADY_CONCLUDED');
        // And it reports the STORED record's facts, which are all it has left.
        expect(result.mergeCommit, arm.label).toBe(MERGE);
        expect(result.subjectCommit, arm.label).toBe(HEAD);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('reports the profile the conclusion was drawn under, beside the one resolved now', () => {
    // Measured as missing: the earlier version printed only the digest resolved
    // now, so `ALREADY_CONCLUDED` under an edited profile was indistinguishable
    // from one under the profile in front of the operator — while deleting the
    // record and re-running the same repository answers `PROFILE_NOT_VERIFIED`.
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root);
      writeConclusion(root);
      const same = conclude(root);
      expect(same.outcome).toBe('ALREADY_CONCLUDED');
      expect(same.profileDigest).toBe(DIGEST);
      expect(same.concludedUnderProfile).toBe(DIGEST);

      const moved = conclude(root, {}, OTHER_PROFILE);
      expect(moved.outcome).toBe('ALREADY_CONCLUDED');
      expect(moved.profileDigest).toBe(OTHER_DIGEST);
      expect(moved.concludedUnderProfile).toBe(DIGEST);
      expect(moved.concludedUnderProfile).not.toBe(moved.profileDigest);
      // The control that makes the pair meaningful: without the record, this
      // repository in this state refuses.
      rmSync(conclusionPath(root));
      expect(conclude(root, {}, OTHER_PROFILE).outcome).toBe('PROFILE_NOT_VERIFIED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the profile it asked under on every refusal, including the earliest', () => {
    // Three refusals used to report `Profile: not resolved` for a digest that
    // had been computed before any document was read.
    for (const [label, prepare] of [
      ['no receipt', () => {}],
      [
        'an unreadable receipt',
        (root: string) => {
          mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
          writeFileSync(
            join(mergeReconciliationDirectory(root), `${TASK}.json`),
            'nonsense',
            'utf8',
          );
        },
      ],
      ['a receipt about another commit', (root: string) => writeReceipt(root, { subjectCommit: OTHER, mergedHeadSha: OTHER })],
    ] as const) {
      const root = scratch();
      try {
        prepare(root);
        const result = conclude(root);
        expect(result.profileDigest, label).toBe(DIGEST);
        expect(result.concludedUnderProfile, label).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('the write refuses a conclusion that appears while it is deciding', () => {
  function movingProbe(move: () => void) {
    let fired = false;
    return async (): Promise<ConclusionIgnoreVerdict> => {
      if (!fired) {
        fired = true;
        move();
      }
      return 'IGNORED';
    };
  }

  it('will not overwrite a document that arrives after the first read', async () => {
    // Measured: the freshness gate re-read the three *source* documents and not
    // the one it was about to replace. A conclusion appearing in that window —
    // including one written by a newer build, which this store classifies as
    // unreplaceable — was overwritten, and the run reported CONCLUSION_RECORDED.
    for (const [label, place, expected] of [
      [
        'a newer build wrote one',
        (root: string) => {
          mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
          writeFileSync(
            conclusionPath(root),
            JSON.stringify({ conclusionVersion: DELIVERY_CONCLUSION_VERSION + 1 }),
            'utf8',
          );
        },
        'EXISTING_CONCLUSION_UNREADABLE',
      ],
      [
        'a conflicting conclusion appeared',
        (root: string) => writeConclusion(root, { subjectCommit: OTHER }),
        'CONFLICTING_CONCLUSION',
      ],
      [
        'the same conclusion appeared',
        (root: string) => writeConclusion(root),
        'ALREADY_CONCLUDED',
      ],
    ] as const) {
      const root = scratch();
      try {
        const result = provenConclusion(root);
        let arrived: Buffer | null = null;
        const wrote = await recordDeliveryConclusion(
          writeRequest(root, result.proof, {
            checkIgnored: movingProbe(() => {
              place(root);
              // The exact bytes that landed, captured at the moment they landed,
              // so the assertion below compares against them rather than against
              // a shape the winner would also have.
              arrived = readFileSync(conclusionPath(root));
            }),
          }),
        );
        if (arrived === null) throw new Error('fixture never placed a document');
        expect(wrote.code, label).toBe(expected);
        expect(wrote.recorded, label).toBe(false);
        expect(wrote.writeAttempt, label).toBe('NOT_ATTEMPTED');
        // The document that arrived is BYTE-IDENTICAL to what arrived.
        //
        // The first version of this line asked whether the file still contained
        // `"concludedAt"` or `conclusionVersion` — which the record this build
        // would have written contains too, so it passed whether or not the gate
        // refused. A review measured it as an assertion incapable of failing for
        // the defect it names.
        expect(readFileSync(conclusionPath(root)), label).toEqual(arrived);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('the reader answers rather than throwing, on every way a read can fail', () => {
  it('reports a post-open read failure as unreadable', () => {
    // The sibling in `merge-reconciliation-store.ts` carries a `catch` here,
    // with a comment recording that a review measured its absence. The module
    // this one was modelled on does not, and a review measured the same gap
    // here: an injected read failing after a successful open escaped as a
    // rejection, past two functions whose headers say they never throw, into a
    // commander action with no catch of its own.
    const root = scratch();
    try {
      writeConclusion(root);
      // The control: the record really is readable, so the assertion below is
      // about the failing read rather than about a fixture that has no file.
      expect(
        loadDeliveryConclusion(root, TASK, { taskId: TASK, repositoryRoot: root }).reading,
      ).toBe('DELIVERY_CONCLUDED');

      let load: ReturnType<typeof loadDeliveryConclusion> | null = null;
      expect(() => {
        load = loadDeliveryConclusion(
          root,
          TASK,
          { taskId: TASK, repositoryRoot: root },
          undefined,
          () => {
            const error = new Error('simulated I/O failure') as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          },
        );
      }).not.toThrow();
      // `MALFORMED`, not `ABSENT`: at the writer, "nobody wrote one" is
      // permission to write a fresh conclusion over whatever is there.
      expect(load!.reading).toBe('MALFORMED');
      expect(load!.conclusion).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the arms an independent review found declared and unreached', () => {
  it('reaches CONCLUSION_NOT_ATTESTED, and it is not a floor', () => {
    // The mint tests `seams.now().toISOString()` against `^\d{4}-`, and
    // `toISOString` yields an expanded year for a date past 9999. So a clock
    // seam — a registered member of `DeliveryCommandSeams` — drives the ladder
    // all the way to the mint and is refused there, with both documents
    // perfectly valid. Nothing had ever rendered this outcome.
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root);
      // The control: with an ordinary clock this repository concludes.
      expect(conclude(root).outcome).toBe('DELIVERY_CONCLUDED');

      const far = new Date(8.64e15);
      expect(far.toISOString()).toBe('+275760-09-13T00:00:00.000Z');
      const result = concludeDeliveryForTask(repositoryOf(root), subjectOf(), { now: () => far });
      expect(result.outcome).toBe('CONCLUSION_NOT_ATTESTED');
      expect(result.proof).toBeNull();
      // The arm carries the standing verdict it got that far with.
      expect(result.standingOutcome).toBe('VERIFIED_PASS');
      expect(result.mergeCommit).toBe(MERGE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a document over the byte budget, and says which side can reach it', async () => {
    // The read side was measured surviving deletion, and it is **not** an
    // equivalent mutant: a schema-valid record can exceed the budget, and
    // without the guard an oversized file is read as a conclusion.
    //
    // `repositoryRoot` is a plain `.min(1).max(4096)` string, so 4,096
    // characters that JSON escapes to six bytes each is schema-legal and far
    // over 16,384.
    const root = scratch();
    try {
      const huge = ''.repeat(4096);
      const payload = conclusionPayload(root, {
        repositoryRoot: huge,
        taskId: 'x'.repeat(128),
        host: 'h'.repeat(253),
        owner: 'o'.repeat(128),
        name: 'n'.repeat(128),
        baseRef: 'r'.repeat(255),
      });
      const subject = { taskId: payload.taskId, repositoryRoot: huge };
      const document = { ...payload, binding: deliveryConclusionBinding(subject, payload) };
      // The control: this build accepts the document itself, so what the size
      // gate refuses below is a record it would otherwise have read.
      expect(readDeliveryConclusion(document, subject).reading).toBe('DELIVERY_CONCLUDED');
      const bytes = Buffer.byteLength(`${JSON.stringify(document, null, 2)}
`, 'utf8');
      expect(bytes).toBeGreaterThan(MAX_DELIVERY_CONCLUSION_BYTES);

      mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
      writeFileSync(conclusionPath(root), `${JSON.stringify(document, null, 2)}
`, 'utf8');
      // Refused on size, before the shape is looked at.
      expect(
        loadDeliveryConclusion(root, TASK, { taskId: TASK, repositoryRoot: root }).reading,
      ).toBe('MALFORMED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cannot reach the write-side byte budget, and the arithmetic says why', () => {
    // Stated as a floor rather than tested as a gate, because it is one and
    // pretending otherwise is what the review caught. The write path builds the
    // payload from the request's own `repositoryRoot`, which must be an
    // absolute path this process can create a directory under; the read path
    // has no such constraint, which is why only that side is reachable above.
    //
    // The arithmetic, measured over the shortest (20-char), production
    // (24-char) and longest (35-char) ISO-8601 instants both records admit:
    // this record is 189 to 230 bytes larger than the merge receipt for the
    // same root, and the ladder reads the receipt first. A receipt over its own
    // 8,192-byte budget is `RECEIPT_UNREADABLE` and no conclusion is built.
    const size = (o: unknown) => Buffer.byteLength(`${JSON.stringify(o, null, 2)}
`, 'utf8');
    const SHORT = '2026-08-26T07:00:00Z';
    const LONG = '2026-08-26T07:00:00.123456789+02:00';
    const PROD = new Date().toISOString();
    expect(SHORT.length).toBe(20);
    expect(PROD.length).toBe(24);
    expect(LONG.length).toBe(35);

    let worst = 0;
    let smallestDelta = Number.POSITIVE_INFINITY;
    let largestDelta = 0;
    for (const filler of ['x', '一', '']) {
      for (const receiptInstant of [SHORT, LONG]) {
        // The largest root for which the receipt is still inside ITS budget.
        let lo = 1;
        let hi = 4096;
        let chars = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const candidate = size({
            ...receiptPayload('unused', {
              repositoryRoot: filler.repeat(mid),
              taskId: 'x'.repeat(128),
              host: 'h'.repeat(253),
              owner: 'o'.repeat(128),
              name: 'n'.repeat(128),
              baseRef: 'r'.repeat(255),
              pullRequestNumber: 2_147_483_647,
              observedAt: receiptInstant,
              reconciledAt: receiptInstant,
            }),
            binding: 'f'.repeat(64),
          });
          if (candidate <= MAX_MERGE_RECONCILIATION_BYTES) {
            chars = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        const rootAtLimit = filler.repeat(chars);
        const receiptBytes = size({
          ...receiptPayload('unused', {
            repositoryRoot: rootAtLimit,
            taskId: 'x'.repeat(128),
            host: 'h'.repeat(253),
            owner: 'o'.repeat(128),
            name: 'n'.repeat(128),
            baseRef: 'r'.repeat(255),
              pullRequestNumber: 2_147_483_647,
            observedAt: receiptInstant,
            reconciledAt: receiptInstant,
          }),
          binding: 'f'.repeat(64),
        });
        for (const concludedAt of [PROD, LONG]) {
          const conclusionBytes = size({
            ...conclusionPayload('unused', {
              repositoryRoot: rootAtLimit,
              taskId: 'x'.repeat(128),
              host: 'h'.repeat(253),
              owner: 'o'.repeat(128),
              name: 'n'.repeat(128),
              baseRef: 'r'.repeat(255),
              pullRequestNumber: 2_147_483_647,
              verifiedAt: LONG,
              concludedAt,
            }),
            binding: 'f'.repeat(64),
          });
          worst = Math.max(worst, conclusionBytes);
          smallestDelta = Math.min(smallestDelta, conclusionBytes - receiptBytes);
          largestDelta = Math.max(largestDelta, conclusionBytes - receiptBytes);
        }
      }
    }
    // The measured numbers, pinned. An earlier docblock said the delta was a
    // constant 200; a review measured that it is not, because the two documents
    // carry independent instants of independent length.
    expect(smallestDelta).toBe(189);
    expect(largestDelta).toBe(230);
    expect(worst).toBe(8420);
    expect(worst).toBeLessThan(MAX_DELIVERY_CONCLUSION_BYTES);
    expect(MAX_DELIVERY_CONCLUSION_BYTES - worst).toBe(7964);
  });

  it('pins every detail sentence by value, not by length', () => {
    // Measured: swapping two sentences left the suite green. A completeness
    // test is `satisfies Record<keyof T>` by another spelling — it can never
    // catch a sentence attached to the wrong member.
    expect(DELIVERY_CONCLUSION_DETAIL).toEqual({
      SUBJECT_NOT_ESTABLISHED: 'No delivery subject could be established for this task.',
      TASK_NOT_READY: 'The task is not at the state a delivery is concluded from.',
      ALREADY_CONCLUDED: 'This delivery was already concluded, and this run changed nothing.',
      CONCLUSION_UNREADABLE: 'A conclusion is present and this build cannot read it.',
      CONCLUSION_CONFLICT: 'A conclusion is present for a different delivery of this task.',
      RECEIPT_ABSENT: 'No merge receipt has been recorded for this task.',
      RECEIPT_UNREADABLE: 'A merge receipt is present and this build cannot read it.',
      RECEIPT_NOT_THIS_DELIVERY: "The merge receipt is not about this task's current delivery.",
      VERIFICATION_ABSENT: 'No verification of this merge commit has been recorded.',
      VERIFICATION_UNREADABLE: 'A verification history is present and this build cannot read it.',
      VERIFICATION_NOT_THIS_DELIVERY:
        'The verification history and the merge receipt describe different deliveries.',
      PROFILE_NOT_VERIFIED:
        'No verdict about this merge commit exists under the profile resolved now.',
      VERIFICATION_NOT_PASSING:
        'The standing verdict for this merge commit under this profile is a failure.',
      CONCLUSION_NOT_ATTESTED:
        'The records were read and this build declined to attest to the join.',
      DELIVERY_CONCLUDED: "This task's delivery is concluded.",
    });
  });

  it('grades every store code against this repository own exit-code definitions', () => {
    // A hand-written table, deliberately not derived from the module it judges:
    // a table generated from the thing under test agrees with it by
    // construction and can never disagree.
    expect({
      CONCLUSION_RECORDED: exitCodeForConclusionRecord('CONCLUSION_RECORDED'),
      ALREADY_CONCLUDED: exitCodeForConclusionRecord('ALREADY_CONCLUDED'),
      EVIDENCE_MOVED: exitCodeForConclusionRecord('EVIDENCE_MOVED'),
      RUNTIME_IGNORE_UNDETERMINED: exitCodeForConclusionRecord('RUNTIME_IGNORE_UNDETERMINED'),
      RUNTIME_PATH_NOT_IGNORED: exitCodeForConclusionRecord('RUNTIME_PATH_NOT_IGNORED'),
      LOCATION_UNSUITABLE: exitCodeForConclusionRecord('LOCATION_UNSUITABLE'),
      RECORD_TOO_LARGE: exitCodeForConclusionRecord('RECORD_TOO_LARGE'),
      CONFLICTING_CONCLUSION: exitCodeForConclusionRecord('CONFLICTING_CONCLUSION'),
      EXISTING_CONCLUSION_UNREADABLE: exitCodeForConclusionRecord('EXISTING_CONCLUSION_UNREADABLE'),
      RECORD_CONTRACT_VIOLATION: exitCodeForConclusionRecord('RECORD_CONTRACT_VIOLATION'),
      DIRECTORY_CREATE_FAILED: exitCodeForConclusionRecord('DIRECTORY_CREATE_FAILED'),
      WRITE_FAILED: exitCodeForConclusionRecord('WRITE_FAILED'),
      CONCLUSION_NOT_PROVEN: exitCodeForConclusionRecord('CONCLUSION_NOT_PROVEN'),
      SUBJECT_MISMATCH: exitCodeForConclusionRecord('SUBJECT_MISMATCH'),
    }).toEqual({
      // On disk. `null` means "keep the primary".
      CONCLUSION_RECORDED: null,
      ALREADY_CONCLUDED: null,
      // Nothing is wrong; the next invocation may well succeed.
      EVIDENCE_MOVED: EXIT_RUN_REFUSED,
      RUNTIME_IGNORE_UNDETERMINED: EXIT_RUN_REFUSED,
      // A repository defect fixed by editing it.
      RUNTIME_PATH_NOT_IGNORED: EXIT_RUN_INPUT_UNUSABLE,
      LOCATION_UNSUITABLE: EXIT_RUN_INPUT_UNUSABLE,
      RECORD_TOO_LARGE: EXIT_RUN_INPUT_UNUSABLE,
      // Durable state an operator has to look at.
      CONFLICTING_CONCLUSION: EXIT_RUN_NEEDS_OPERATOR,
      EXISTING_CONCLUSION_UNREADABLE: EXIT_RUN_NEEDS_OPERATOR,
      RECORD_CONTRACT_VIOLATION: EXIT_RUN_NEEDS_OPERATOR,
      DIRECTORY_CREATE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
      WRITE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
      // Floors: something is wrong inside the tool.
      CONCLUSION_NOT_PROVEN: EXIT_RUN_UNEXPECTED,
      SUBJECT_MISMATCH: EXIT_RUN_UNEXPECTED,
    });
    // And none of them is nominal, which is the property the rule exists for.
    for (const code of [
      'EVIDENCE_MOVED',
      'RUNTIME_IGNORE_UNDETERMINED',
      'RUNTIME_PATH_NOT_IGNORED',
      'LOCATION_UNSUITABLE',
      'RECORD_TOO_LARGE',
      'CONFLICTING_CONCLUSION',
      'EXISTING_CONCLUSION_UNREADABLE',
      'RECORD_CONTRACT_VIOLATION',
      'DIRECTORY_CREATE_FAILED',
      'WRITE_FAILED',
      'CONCLUSION_NOT_PROVEN',
      'SUBJECT_MISMATCH',
    ] as const) {
      expect(exitCodeForConclusionRecord(code), code).not.toBe(EXIT_RUN_OK);
      expect(exitCodeForConclusionRecord(code), code).not.toBeNull();
    }
  });

  it('binds every field the schema declares, derived from the schema', () => {
    // The completeness of the binding used to rest on a hand-written list of
    // overrides. A seventeenth field added to the schema and to the payload
    // builder but omitted from the digest would be unbound — editable on disk
    // without changing it — and the suite would stay green. This derives the
    // field list from the schema itself.
    const root = scratch();
    try {
      const subject = { taskId: TASK, repositoryRoot: root };
      const payload = conclusionPayload(root);
      const base = deliveryConclusionBinding(subject, payload);
      const declared = Object.keys(DeliveryConclusionSchema.shape).filter((k) => k !== 'binding');
      // The control: the schema really does declare the fields this expects.
      expect(declared.length).toBe(16);
      expect(declared.sort()).toEqual(Object.keys(payload).sort());
      for (const field of declared) {
        const current = (payload as Record<string, unknown>)[field];
        // A value of the same type that is certainly different.
        const moved =
          typeof current === 'number'
            ? current + 1
            : typeof current === 'string'
              ? `${current}-moved`
              : current;
        expect(
          deliveryConclusionBinding(subject, {
            ...payload,
            [field]: moved,
          } as unknown as DeliveryConclusionPayload),
          field,
        ).not.toBe(base);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ── 11. The command's own gates, driven through the command ─────────────── */

describe('the command holds the gates its help text claims', () => {
  function cliRepo(): { root: string; gitCommonDir: string; dispose: () => void } {
    const repo = realRepo('ao-v410-cli2-');
    const gitCommonDir = git(repo.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return {
      root: repo.root,
      gitCommonDir,
      dispose: () => rmSync(repo.root, { recursive: true, force: true }),
    };
  }

  function taskState(root: string, over: Record<string, unknown> = {}) {
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

  async function driveCli(
    repo: { root: string; gitCommonDir: string },
    checkIgnored: () => Promise<ConclusionIgnoreVerdict>,
  ): Promise<{ out: string; exitCode: number | undefined }> {
    const chunks: string[] = [];
    const outer = process.exitCode;
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
        checkIgnored,
        now: () => new Date(LATER),
      });
      await program.parseAsync(
        [
          'node',
          'agent-loop',
          'delivery',
          '--repository',
          repo.root,
          '--task',
          TASK,
          '--conclude-delivery',
        ],
        { from: 'node' },
      );
      return { out: chunks.join(''), exitCode: process.exitCode as number | undefined };
    } finally {
      write.mockRestore();
      process.exitCode = outer;
    }
  }

  it('refuses through the real task-state reader when the task moves mid-write', async () => {
    // The CLI half of the freshness gate, driven end to end.
    //
    // The store takes `readStateRevision` as a FUNCTION so a caller cannot
    // satisfy it by handing the same number in twice, and the command's comment
    // says a closure over `taskLoad.revision` "would make the store compare a
    // number with itself". A review measured that exact mutant: it typechecks
    // and the whole suite stayed green, because the only test of the gate
    // injected the seam into the store and never ran through the command.
    //
    // `checkIgnored` is awaited between the assessment and the re-read, so
    // saving the task state from inside it moves the real bytes at the real
    // moment, through the real `loadTaskState`.
    const repo = cliRepo();
    try {
      const saved = saveTaskState(taskState(repo.root), { repositoryRoot: repo.root });
      expect(saved.code).toBe('SAVED');
      writeReceipt(repo.root);
      writeVerification(repo.root);

      const before = loadTaskState(repo.root, TASK);
      if (!before.ok) throw new Error('fixture state unreadable');

      let moved = false;
      const r = await driveCli(repo, async () => {
        if (!moved) {
          moved = true;
          // A different, entirely legal task state: only the instant changes,
          // so nothing about the delivery moves — the revision is a digest over
          // the raw bytes, which is what the gate compares.
          saveTaskState(taskState(repo.root, { stateEnteredAt: LATER }), {
            repositoryRoot: repo.root,
            expectedRevision: before.revision,
          });
        }
        return 'IGNORED';
      });

      // The control: the bytes really did move.
      const after = loadTaskState(repo.root, TASK);
      if (!after.ok) throw new Error('state unreadable after');
      expect(after.revision).not.toBe(before.revision);

      expect(r.out).toContain('Completion   : DELIVERY_CONCLUDED');
      expect(r.out).toContain('Record       : EVIDENCE_MOVED  (write: NOT_ATTEMPTED)');
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
      // And a run that concluded and left nothing on disk does not exit nominal.
      expect(r.exitCode).toBe(EXIT_RUN_REFUSED);
      expect(r.exitCode).not.toBe(EXIT_RUN_OK);
    } finally {
      repo.dispose();
    }
  });

  it('does not refuse when the task state stands still', async () => {
    // The positive control for the case above: same command, same seam, nothing
    // moved. Without it, `EVIDENCE_MOVED` there could be an instrument that
    // always fires.
    const repo = cliRepo();
    try {
      saveTaskState(taskState(repo.root), { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);
      const r = await driveCli(repo, async () => 'IGNORED');
      expect(r.out).toContain('Completion   : DELIVERY_CONCLUDED');
      expect(r.out).toContain('Record       : CONCLUSION_RECORDED  (write: COMPLETED)');
      expect(r.exitCode ?? EXIT_RUN_OK).toBe(EXIT_RUN_OK);
    } finally {
      repo.dispose();
    }
  });

  it('prints the trailer on a refusal, which is the run that most needs it', async () => {
    // The trailer is gated on the FLAG, not on the write, and its own comment
    // says so. A review measured that nothing pinned it: changing the gate to
    // "only when something was written" left the suite green, and the runs that
    // lose the "read no Git history" disclosure are exactly the refusals.
    const repo = cliRepo();
    try {
      saveTaskState(taskState(repo.root), { repositoryRoot: repo.root });
      // No receipt and no history: the ladder refuses and nothing is written.
      const r = await driveCli(repo, async () => 'IGNORED');
      expect(r.out).toContain('Completion   : RECEIPT_ABSENT');
      expect(r.out).toContain(CONCLUSION_TRAILER);
      // …and the over-reading sentence is NOT printed, because there is no
      // conclusion to over-read.
      expect(r.out).not.toContain(CONCLUSION_EVENT_SENTENCE);
      expect(() => statSync(conclusionPath(repo.root))).toThrow();
    } finally {
      repo.dispose();
    }
  });

  it('takes no execution lease, measured by taking one', async () => {
    // Two places on the product surface claim it and nothing measured it. The
    // instrument: hold the repository's only writer slot for the whole
    // invocation. A path that took a lease could not acquire it and would
    // refuse; this one does not care.
    const repo = cliRepo();
    try {
      saveTaskState(taskState(repo.root), { repositoryRoot: repo.root });
      writeReceipt(repo.root);
      writeVerification(repo.root);

      const held = acquireRepositoryExecutionLease(
        { id: 'fixture-repo', root: repo.root, gitCommonDir: repo.gitCommonDir },
        { runId: null, blockId: null },
        { now: () => new Date().toISOString() },
      );
      expect(held.ok).toBe(true);
      if (!held.ok) throw new Error('fixture lease not acquired');
      try {
        const r = await driveCli(repo, async () => 'IGNORED');
        // It concluded, with somebody else holding the writer slot.
        expect(r.out).toContain('Completion   : DELIVERY_CONCLUDED');
        expect(r.out).toContain('Record       : CONCLUSION_RECORDED  (write: COMPLETED)');
        // And it reports no lease at all — the line the two lease-taking paths
        // print is absent.
        expect(r.out).not.toContain('Lease        :');
        expect(r.out).not.toContain(VERIFICATION_TRAILER);
      } finally {
        // The control: the lease was ours throughout, and giving it back works
        // — so the run really did leave it alone rather than breaking it.
        expect(releaseRepositoryExecutionLease(held.evidence).code).toBe('RELEASED');
      }
    } finally {
      repo.dispose();
    }
  });
});

/* ── 12. Two cases whose names promised more than the bodies drove ───────── */

describe('an edited record is refused, for both of the records this reads', () => {
  it('refuses a merge receipt whose field was changed in place', () => {
    // The existing case drives a receipt BOUND for another subject, which is a
    // different document and a different code path. This is the other half its
    // name promised: a stored receipt with one field edited and the digest left
    // alone.
    for (const [label, field, value] of [
      ['the merge commit', 'mergeCommit', OTHER],
      ['the pull request', 'pullRequestNumber', PR + 1],
      ['the base branch', 'baseRef', 'release'],
    ] as const) {
      const root = scratch();
      try {
        writeReceipt(root);
        writeVerification(root);
        const path = join(mergeReconciliationDirectory(root), `${TASK}.json`);
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const tampered = { ...raw, [field]: value };
        // The binding is left exactly as it was. That is the whole case.
        expect(tampered['binding']).toBe(raw['binding']);
        writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
        expect(conclude(root).outcome, label).toBe('RECEIPT_UNREADABLE');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('refuses a verification history whose verdict was changed in place', () => {
    // The existing case advertised "flip the verdict, leave the binding" and a
    // review measured the flip as a no-op — the fixture's default attempt was
    // already a pass under that digest, and what actually moved the reading was
    // an appended attempt. This flips a verdict that really was something else.
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root, { attempts: [failedAttempt('VERIFIED_FAIL')] });
      // The control: as written, this history is read and refused on its merits.
      expect(conclude(root).outcome).toBe('VERIFICATION_NOT_PASSING');

      const path = join(postMergeVerificationDirectory(root), `${TASK}.json`);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        attempts: Record<string, unknown>[];
        binding: string;
      };
      const before = raw.attempts[0]!['outcome'];
      expect(before).toBe('VERIFIED_FAIL');
      raw.attempts[0] = { ...raw.attempts[0]!, outcome: 'VERIFIED_PASS', stoppedAt: null };
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

      // The binding covers every field of every attempt, so the edited verdict
      // reads as a foreign record rather than as evidence.
      expect(conclude(root).outcome).toBe('VERIFICATION_UNREADABLE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ── 13. What review 2 measured as unpinned ──────────────────────────────── */

describe('the ladder decides in the order it declares, measured by outcome', () => {
  /**
   * The vocabulary array pins the *list*; nothing pinned the *decisions*.
   *
   * A review reordered three steps of `concludeDeliveryForTask` and stayed green
   * on 95 tests and on 852, each reordering producing a different answer for a
   * real input. Each case below is one of those inputs: the two documents are
   * arranged so that two different rungs could both fire, and only the earlier
   * one may.
   */
  it('reports an unreadable conclusion before it notices the receipt is gone', () => {
    // The F1 defect class, for the conclusion readings F1's fix did not cover.
    // A readable conclusion survives its receipt; so must an unreadable one,
    // because "something is there and this build cannot read it" is a stronger
    // reason to stop than "there is no receipt".
    for (const [label, bytes] of [
      ['corrupted', 'nonsense'],
      ['written by a newer build', JSON.stringify({ conclusionVersion: DELIVERY_CONCLUSION_VERSION + 1 })],
    ] as const) {
      const root = scratch();
      try {
        // No receipt at all, and no verification history.
        mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
        writeFileSync(conclusionPath(root), bytes, 'utf8');
        // The control: with no conclusion on the path, this repository answers
        // about the receipt — so the assertion below is about the ordering.
        rmSync(conclusionPath(root));
        expect(conclude(root).outcome, `${label} (control)`).toBe('RECEIPT_ABSENT');
        writeFileSync(conclusionPath(root), bytes, 'utf8');

        expect(conclude(root).outcome, label).toBe('CONCLUSION_UNREADABLE');
        // …and the document is not repaired or replaced on the way out.
        expect(readFileSync(conclusionPath(root), 'utf8'), label).toBe(bytes);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('reports a receipt about another commit before it notices the history is gone', () => {
    const root = scratch();
    try {
      writeReceipt(root, { subjectCommit: OTHER, mergedHeadSha: OTHER });
      // No verification history: the later rung would answer VERIFICATION_ABSENT.
      expect(conclude(root).outcome).toBe('RECEIPT_NOT_THIS_DELIVERY');
      // The control: with a receipt that IS about this delivery, the same
      // repository answers about the missing history — so the assertion above
      // is about which rung fired.
      writeReceipt(root);
      expect(conclude(root).outcome).toBe('VERIFICATION_ABSENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a history about another delivery before it asks about the profile', () => {
    const root = scratch();
    try {
      writeReceipt(root);
      // Both wrong at once: a different pull request AND a verdict recorded
      // under a profile this repository no longer declares.
      writeVerification(root, {
        pullRequestNumber: PR + 1,
        attempts: [attemptOf({ profileDigest: OTHER_DIGEST })],
      });
      expect(conclude(root).outcome).toBe('VERIFICATION_NOT_THIS_DELIVERY');
      // The control: fix only the join, and the profile rung fires.
      writeVerification(root, { attempts: [attemptOf({ profileDigest: OTHER_DIGEST })] });
      expect(conclude(root).outcome).toBe('PROFILE_NOT_VERIFIED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses before the conclusion is consulted when there is no subject at all', () => {
    // The honest limit of "a concluded delivery stays concluded", driven rather
    // than asserted. The delivery target and the task state ARE the subject;
    // without them there is nothing for a conclusion to be about, so the
    // caller's two refusals come first and the record is never read. That is
    // L-V4-10-14, and the module's own note says so.
    const repo = realRepo('ao-v410-nosubject-');
    try {
      writeReceipt(repo.root);
      writeVerification(repo.root);
      writeConclusion(repo.root);
      // The control: the record really is readable.
      expect(
        loadDeliveryConclusion(repo.root, TASK, { taskId: TASK, repositoryRoot: repo.root })
          .reading,
      ).toBe('DELIVERY_CONCLUDED');

      const refusal = refuseDeliveryConclusion('SUBJECT_NOT_ESTABLISHED');
      expect(refusal.outcome).toBe('SUBJECT_NOT_ESTABLISHED');
      expect(refusal.mergeCommit).toBeNull();
      // The point: the refusal carries nothing about the conclusion, because the
      // conclusion was never consulted. It is a limit, not a defect, and it is
      // in the register.
      expect(refusal.concludedUnderProfile).toBeNull();
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});

describe('the two durability tables agree, and the report says which profile', () => {
  it('grades a code durable exactly when the exit table keeps the primary', () => {
    // Durability is stated twice — `DURABLE_BY_CODE` in the store and the
    // null-versus-code split in `CONCLUSION_RECORD_EXIT_CODES` — by two
    // hand-written tables in two modules, neither derived from the other. A
    // review found nothing making them agree. This is what makes them agree.
    const codes: DeliveryConclusionRecordCode[] = [
      'CONCLUSION_RECORDED',
      'ALREADY_CONCLUDED',
      'CONCLUSION_NOT_PROVEN',
      'SUBJECT_MISMATCH',
      'CONFLICTING_CONCLUSION',
      'EXISTING_CONCLUSION_UNREADABLE',
      'EVIDENCE_MOVED',
      'LOCATION_UNSUITABLE',
      'RUNTIME_PATH_NOT_IGNORED',
      'RUNTIME_IGNORE_UNDETERMINED',
      'RECORD_CONTRACT_VIOLATION',
      'RECORD_TOO_LARGE',
      'DIRECTORY_CREATE_FAILED',
      'WRITE_FAILED',
    ];
    // The control: the list is the whole vocabulary, not a sample. Both tables
    // are total by type, so a missing member would be a build error there and a
    // silent gap here.
    expect(codes.length).toBe(14);
    expect(new Set(codes).size).toBe(14);
    for (const code of codes) {
      expect(
        exitCodeForConclusionRecord(code) === null,
        `${code}: durable=${String(conclusionIsDurable(code))} but exit=${String(
          exitCodeForConclusionRecord(code),
        )}`,
      ).toBe(conclusionIsDurable(code));
    }
  });

  it('says when a conclusion was drawn under a different profile', () => {
    // The operator-facing half of the fix. Deleting the "(a DIFFERENT profile)"
    // literal — or inverting it — left the suite green: the same-profile
    // spelling was asserted and this one was not, and it is the only signal that
    // distinguishes a conclusion drawn under a contract this repository no
    // longer declares.
    const view = renderDeliveryObservation({
      repositoryId: 'fixture-repo',
      repositoryRoot: 'D:/fixture',
      taskId: TASK,
      subject: { ok: false, refusal: 'DELIVERY_NOT_DECLARED' } as never,
      observation: null,
      conclusion: 'NOT_OBSERVED' as never,
      stored: null,
      recording: null,
      deliveryConclusion: {
        result: {
          outcome: 'ALREADY_CONCLUDED',
          mergeCommit: MERGE,
          subjectCommit: HEAD,
          profileDigest: OTHER_DIGEST,
          standingOutcome: null,
          proof: null,
          concludedUnderProfile: DIGEST,
        },
        record: null,
      },
    } as never);
    expect(view).toContain(`Concluded on : ${DIGEST}  (a DIFFERENT profile)`);
    expect(view).not.toContain('(the same profile)');
    // The control: the same renderer, same shape, one digest changed.
    const same = renderDeliveryObservation({
      repositoryId: 'fixture-repo',
      repositoryRoot: 'D:/fixture',
      taskId: TASK,
      subject: { ok: false, refusal: 'DELIVERY_NOT_DECLARED' } as never,
      observation: null,
      conclusion: 'NOT_OBSERVED' as never,
      stored: null,
      recording: null,
      deliveryConclusion: {
        result: {
          outcome: 'ALREADY_CONCLUDED',
          mergeCommit: MERGE,
          subjectCommit: HEAD,
          profileDigest: DIGEST,
          standingOutcome: null,
          proof: null,
          concludedUnderProfile: DIGEST,
        },
        record: null,
      },
    } as never);
    expect(same).toContain(`Concluded on : ${DIGEST}  (the same profile)`);
    expect(same).not.toContain('(a DIFFERENT profile)');
  });
});

describe('the byte budget is reachable on the write side too', () => {
  it('refuses an oversized payload through the exported writer, with no injected seam', async () => {
    // A review refuted the "unreachable through any callable path" claim by
    // measurement, and this is that measurement. `deriveDeliveryConclusionLocation`
    // requires only that the root be ABSOLUTE, and the size is judged long
    // before `mkdirSync` — so the directory never has to be creatable at the
    // moment the budget is evaluated.
    const root = scratch();
    try {
      const result = provenConclusion(root);
      // 4,094 characters that JSON escapes to six bytes each, on an absolute
      // root. Schema-legal (`.max(4096)`), and far over 16,384 once serialised.
      const huge = `C:\\${'\u0001'.repeat(4090)}`;
      expect(huge.length).toBeLessThanOrEqual(4096);
      const wrote = await recordDeliveryConclusion(
        writeRequest(root, result.proof, { repositoryRoot: huge }),
      );
      expect(wrote.code).toBe('RECORD_TOO_LARGE');
      expect(wrote.recorded).toBe(false);
      expect(wrote.writeAttempt).toBe('NOT_ATTEMPTED');

      // The control that makes this a measurement of the BUDGET rather than of
      // the fabricated root: the same shape with a 3-byte character passes the
      // budget and is refused later, by the freshness gate.
      const smaller = `C:\\${'\u4e00'.repeat(4090)}`;
      const past = await recordDeliveryConclusion(
        writeRequest(root, result.proof, { repositoryRoot: smaller }),
      );
      expect(past.code).not.toBe('RECORD_TOO_LARGE');
      expect(past.recorded).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the command hands the store two independently-read operands', () => {
  it('takes the store expectations from its own receipt read, not from the ladder result', () => {
    // Three anti-tautology properties the docblocks name and a review measured
    // unpinned: replacing any of the four `expected*` values with the ladder's
    // own result, or the subject's, leaves the store comparing values that both
    // trace to one read.
    //
    // Pinned structurally, because the defect is *which expression is written*
    // rather than a behaviour any fixture can separate: the two reads agree on
    // every input an in-process test can construct.
    const source = readFileSync('src/cli/delivery-command.ts', 'utf8');
    const opens = source.indexOf('const record = await recordDeliveryConclusion({');
    expect(opens).toBeGreaterThan(0);
    // Searched FORWARD from the call, not from the top of the file: the same
    // `return` line appears in an earlier helper, so a plain `indexOf` produced
    // an empty slice and every assertion below passed vacuously. Caught by the
    // length floor, which is why it is here.
    const call = source.slice(opens, source.indexOf('return Object.freeze({ result, record });', opens));
    expect(call.length).toBeGreaterThan(200);
    for (const field of [
      'expectedSubjectCommit: stored.receipt.subjectCommit',
      'expectedMergeCommit: stored.receipt.mergeCommit',
      'expectedHost: stored.receipt.host',
      'expectedOwner: stored.receipt.owner',
      'expectedName: stored.receipt.name',
      'expectedPullRequestNumber: stored.receipt.pullRequestNumber',
    ]) {
      expect(call, field).toContain(field);
    }
    // …and none of them comes from the ladder's result or from the subject,
    // which is what would make the store's comparison a tautology.
    for (const forbidden of [
      'expectedSubjectCommit: result.',
      'expectedMergeCommit: result.',
      'expectedHost: subject.',
      'expectedOwner: subject.',
      'expectedName: subject.',
    ]) {
      expect(call, forbidden).not.toContain(forbidden);
    }
    // The assessed revision is the one from the single load at the top of the
    // action, not a fresh read taken here — re-reading would move the window the
    // gate exists to close rather than closing it.
    expect(call).toContain('assessedStateRevision: taskLoad.revision');
    expect(call).not.toContain('assessedStateRevision: load(');
    // The control: the two forbidden spellings really are spellings this file
    // could have, so the loop above is a boundary rather than a list of words
    // nothing resembles.
    expect(source).toContain('taskLoad.revision');
    expect(source).toContain('stored.receipt.subjectCommit');
  });
});

/* ── 14. The lease rule outranks the conclusion's own code ───────────────── */

describe('a stuck lease outranks whatever the conclusion came to', () => {
  /**
   * The precedence a review found broken by this slice's own fix.
   *
   * While the conclusion override was the single constant
   * `EXIT_RUN_NEEDS_OPERATOR` it happened to equal what
   * `exitCodeWithLeaseRelease` forces, so applying it *over* an already
   * lease-adjusted code was indistinguishable from the right answer. Grading the
   * store's codes one by one made the override able to return 2 or 4 — and a run
   * holding the repository's writer slot it could not give back would then have
   * told a caller "nothing is wrong, try again".
   *
   * `run-exit-codes.ts` states the rule: **no primary code is exempt**. So the
   * lease rule is applied last, and this is the case that separates the two
   * orderings. It needs both flags, which is why nothing else in this file
   * reaches it.
   */
  it('exits 3 when the lease is stuck and the conclusion write was refused', async () => {
    const repo = realRepo('ao-v410-both-');
    const gitCommonDir = git(repo.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    try {
      saveTaskState(
        {
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
        { repositoryRoot: repo.root },
      );
      writeReceipt(repo.root, { mergeCommit: repo.mergeCommit });
      // A standing FAILURE, deliberately. With a pass on disk `--verify-merge`
      // converges to `ALREADY_VERIFIED` and calls no seam at all between taking
      // the lease and giving it back, so there is no moment at which the lease
      // can be removed from under the run. A failure makes the gate really run,
      // which is what opens that window.
      writeVerification(repo.root, {
        mergeCommit: repo.mergeCommit,
        attempts: [failedAttempt('VERIFIED_FAIL')],
      });

      const leasePath = join(gitCommonDir, EXECUTION_LEASE_FILE_NAME);

      async function run(
        argv: readonly string[],
        opts: { steal?: boolean; ignored?: ConclusionIgnoreVerdict } = {},
      ): Promise<{ out: string; exitCode: number | undefined; stolen: boolean }> {
        const chunks: string[] = [];
        const outer = process.exitCode;
        process.exitCode = undefined;
        let stolen = false;
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
                  gitCommonDir,
                  verification: PROFILE,
                  delivery: {
                    declared: true,
                    remoteName: 'origin',
                    result: { outcome: 'RESOLVED', target: { provider: 'github', ...IDENTITY } },
                  },
                },
              }) as never,
            // The verification gate itself: it answers immediately, and — when
            // asked to — removes the lease document from under the run, so the
            // release afterwards cannot answer RELEASED.
            verify: (async () => {
              if (opts.steal === true && !stolen) {
                stolen = true;
                rmSync(leasePath, { force: true });
              }
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
              };
            }) as never,
            // Path-aware on purpose: the verification's own record must be
            // allowed to land — its pass is what the conclusion then reads —
            // while the conclusion's write is the one being refused.
            checkIgnored: async (relative: string) =>
              relative.includes(DELIVERY_CONCLUSION_DIR_NAME)
                ? (opts.ignored ?? 'IGNORED')
                : 'IGNORED',
            now: () => new Date(LATER),
          });
          await program.parseAsync(
            [
              'node',
              'agent-loop',
              'delivery',
              '--repository',
              repo.root,
              '--task',
              TASK,
              ...argv,
            ],
            { from: 'node' },
          );
          return { out: chunks.join(''), exitCode: process.exitCode as number | undefined, stolen };
        } finally {
          write.mockRestore();
          process.exitCode = outer;
        }
      }

      // ── control 1: both flags, everything clean ───────────────────────────
      // The gate runs, records a pass, and the conclusion then reads it.
      const clean = await run(['--verify-merge', '--conclude-delivery']);
      expect(clean.out, clean.out).toContain('Lease        : RELEASED');
      expect(clean.out, clean.out).toContain('Completion   : DELIVERY_CONCLUDED');
      expect(clean.exitCode ?? EXIT_RUN_OK).toBe(EXIT_RUN_OK);
      expect(
        loadDeliveryConclusion(repo.root, TASK, { taskId: TASK, repositoryRoot: repo.root })
          .reading,
      ).toBe('DELIVERY_CONCLUDED');
      rmSync(conclusionPath(repo.root));

      // ── control 2: the conclusion write is refused, the lease is fine ─────
      // The store's own grade for this code is 2, not 3 — which is the whole
      // reason the case below can tell the two orderings apart.
      const refusedWrite = await run(['--conclude-delivery'], { ignored: 'NOT_IGNORED' });
      expect(refusedWrite.out).toContain('Completion   : DELIVERY_CONCLUDED');
      expect(refusedWrite.out).toContain('Record       : RUNTIME_PATH_NOT_IGNORED');
      expect(refusedWrite.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);

      // ── the case: both wrong at once ──────────────────────────────────────
      //
      // The history is put back to a standing failure first. Control 1 recorded
      // a pass, and with one on disk `--verify-merge` converges before it calls
      // any seam — so without this the lease could not be removed from under the
      // run, and the case would measure nothing. (It measured exactly nothing
      // once, which is why this comment is here.)
      writeVerification(repo.root, {
        mergeCommit: repo.mergeCommit,
        attempts: [failedAttempt('VERIFIED_FAIL')],
      });
      const both = await run(['--verify-merge', '--conclude-delivery'], {
        steal: true,
        ignored: 'NOT_IGNORED',
      });
      // The lease really was taken and really is gone.
      expect(both.stolen).toBe(true);
      expect(() => statSync(leasePath)).toThrow();
      expect(both.out).toContain('Lease        :');
      expect(both.out).not.toContain('Lease        : RELEASED');
      expect(both.out).toContain('Completion   : DELIVERY_CONCLUDED');
      expect(both.out).toContain('Record       : RUNTIME_PATH_NOT_IGNORED');
      // The lease wins. Not 2 — which is what the conclusion's own grade would
      // have made it, and what the first ordering of this rule produced — and
      // emphatically not nominal.
      expect(both.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      expect(both.exitCode).not.toBe(EXIT_RUN_INPUT_UNUSABLE);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
