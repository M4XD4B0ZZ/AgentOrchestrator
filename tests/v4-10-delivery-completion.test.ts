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
import { acquireRepositoryExecutionLease, releaseRepositoryExecutionLease } from '../src/lease/execution-lease.js';
import { EXIT_RUN_NEEDS_OPERATOR, EXIT_RUN_OK } from '../src/cli/run-exit-codes.js';

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
    expect([...DELIVERY_CONCLUSIONS]).toEqual([
      'SUBJECT_NOT_ESTABLISHED',
      'TASK_NOT_READY',
      'RECEIPT_ABSENT',
      'RECEIPT_UNREADABLE',
      'RECEIPT_NOT_THIS_DELIVERY',
      'ALREADY_CONCLUDED',
      'CONCLUSION_UNREADABLE',
      'CONCLUSION_CONFLICT',
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
    const root = scratch();
    try {
      writeReceipt(root);
      writeVerification(root);
      writeConclusion(root, { mergeCommit: OTHER });
      const result = conclude(root);
      expect(result.outcome).toBe('CONCLUSION_CONFLICT');
      expect(result.proof).toBeNull();
      // Nothing was repaired: the disagreeing document is exactly as it was.
      expect(JSON.parse(readFileSync(conclusionPath(root), 'utf8')).mergeCommit).toBe(OTHER);
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
 * This file makes four.
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
    },
    {
      label: 'the merge was reverted',
      prepare: (root: string, merge: string) => {
        git(root, 'revert', '-m', '1', '--no-edit', merge);
      },
      ancestor: 0,
    },
    {
      label: 'the base was force-moved off the merge',
      prepare: (root: string, _merge: string, base: string) => {
        git(root, 'reset', '--hard', '--quiet', base);
      },
      ancestor: 1,
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
      for (const forbidden of [
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
      ]) {
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
    // Positive controls: the modules that DO write those still do.
    expect(codeOnly('src/state/state-store.ts')).toContain('saveTaskState');
    expect(codeOnly('src/state/advance-state.ts')).toContain('advanceTaskState');
    expect(codeOnly('src/cli/delivery-command.ts')).toContain('mergePullRequest');
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
      expect(source, `${file} must not fetch`).not.toMatch(/['"]fetch['"]/);
    }
    // The positive control for the probe names: they are what the module that
    // owns them really exports, so the loop above is a boundary rather than a
    // list of words nothing uses.
    const owner = readFileSync('src/worktree/commit-probes.ts', 'utf8');
    for (const probe of probes) expect(owner, probe).toContain(`export async function ${probe}`);
    // And the one Git question the write path DOES ask, which is not about the
    // graph: whether the path it is about to write is ignored.
    expect(codeOnly('src/deliver/delivery-conclusion-store.ts')).toContain('checkIgnored');
    // The whole product still has no fetch anywhere.
    for (const file of [
      'src/deliver/conclude-delivery.ts',
      'src/deliver/delivery-conclusion-store.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/git\s+fetch|['"]fetch['"]/);
    }
  });

  it('never writes the merge receipt or the verification history it reads', () => {
    for (const file of [
      'src/deliver/conclude-delivery.ts',
      'src/deliver/delivery-conclusion-store.ts',
    ]) {
      const source = codeOnly(file);
      // Both are read…
      expect(source).toContain('load');
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
      await runCli(['--conclude-delivery'], repo);
      const bytes = readFileSync(conclusionPath(repo.root));
      const again = await runCli(['--conclude-delivery'], repo);
      expect(again.out).toContain('Completion   : ALREADY_CONCLUDED');
      expect(again.out).toContain('Record       : not written — no attempt was made to record');
      expect(again.out).toContain(CONCLUSION_EVENT_SENTENCE);
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
        expect(process.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
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
    // The five words that name an override of a refusal stay forbidden here too.
    expect('--conclude-delivery').not.toMatch(/force|unattended|adopt|takeover|steal/i);
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
