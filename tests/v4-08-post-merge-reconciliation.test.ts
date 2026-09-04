/**
 * V4 slice 8 — the durable merge receipt, and the task state it does not touch.
 *
 * Seven sections, in the order the sibling slices established, and the same
 * rule about what an assertion is allowed to be: a count of calls rather than a
 * word about them, an enumerated equality rather than a partition, a minted
 * artefact rather than a hand-built one, and a positive control beside every
 * sweep so an empty scan cannot pass as a clean tree.
 *
 * What this file has that no sibling did: the *absence* of an effect is the
 * headline claim, twice over. The slice's whole architectural argument is that
 * `READY_FOR_PR` stays terminal and the task's durable bytes are never touched
 * — so "nothing was written" has to be measured against a positive control that
 * writes, and the block ledger's own prover has to be run before and after
 * rather than reasoned about. Section 6 does both.
 *
 * The second is that this command reads github.com and mutates nothing there.
 * That is proven structurally (the function has no mutation seam to reach) and
 * behaviourally (the three mutation runners are supplied and counted, and the
 * counts are zero) rather than by a sentence.
 */

import { Command } from 'commander';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  MergeObservationEvidence,
  mintMergeObservation,
  MAX_BASE_REF_LENGTH,
  type MergeObservationFacts,
} from '../src/deliver/internal/merge-observation-proof.js';
import {
  isMergeObservationProof,
  mergeObservationFactsOf,
  type MergeObservationProof,
} from '../src/deliver/merge-observation-proof.js';
import {
  isRecordedMerge,
  mergeReconciliationBinding,
  readMergeReconciliation,
  MAX_MERGE_RECONCILIATION_BYTES,
  MERGE_PRESENCE_SENTENCE,
  MERGE_RECONCILIATION_READINGS,
  MERGE_RECONCILIATION_VERSION,
  MergeReconciliationSchema,
  type MergeReconciliationPayload,
  type MergeReconciliationReading,
  type MergeReconciliationSubject,
} from '../src/deliver/merge-reconciliation.js';
import {
  deriveMergeReconciliationLocation,
  isMergeReconciliationFileName,
  loadMergeReconciliation,
  mergeReconciliationDirectory,
  recordMergeReconciliation,
  MERGE_RECONCILIATION_DIR_NAME,
  WRITE_ATTEMPTS,
  type IgnoreVerdict,
  type MergeReconciliationRecordCode,
  type MergeReconciliationWriteRequest,
} from '../src/deliver/merge-reconciliation-store.js';
import {
  observeMergeForDelivery,
  refuseMergeObservation,
  MERGE_OBSERVATIONS,
  MERGE_OBSERVATION_DETAIL,
  type MergeObservationOutcome,
  type ReconciliationSubject,
} from '../src/deliver/reconcile-merge.js';
import type { MergeReading } from '../src/deliver/pull-request-merge.js';
import type { ForgeCommandRunner } from '../src/deliver/github-observer.js';
import type { CommandResult } from '../src/doctor/exec.js';
import {
  DELIVERY_COMMAND_DESCRIPTION,
  OBSERVE_OPTION_DESCRIPTION,
  RECONCILE_MERGE_OPTION_DESCRIPTION,
  registerDeliveryCommand,
} from '../src/cli/delivery-command.js';
import {
  CONTACTED_TRAILER,
  MERGE_TRAILER,
  NOT_CONTACTED_TRAILER,
  OBSERVED_AND_CHANGED_TRAILER,
  RECONCILIATION_TRAILER,
  renderDeliveryObservation,
} from '../src/cli/render-delivery-observation.js';
import { ALL_STATES, TERMINAL_STATES, isTerminalState } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { proveBlockTaskEntry } from '../src/block/block-evidence.js';
import type { BlockTaskEntry } from '../src/block/block-ledger.js';
import type { ResolvedDelivery } from '../src/deliver/delivery-target.js';
import type { StateLoadResult } from '../src/state/state-store.js';
import type { GitPublicationRunner } from '../src/deliver/git-head-publisher.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

/** The task's delivery head — what went into the merge. */
const HEAD = '10583ee91a5747d0049f563ffaac64b0cf643aeb';
/** Another object name, used wherever "a different commit" is needed. */
const OTHER = 'c89ef605400a15e5d3db4d256c184773c0d533f6';
/** The commit the merge produced. Under a squash merge, on no branch but the base. */
const RESULT = 'f1e2d3c4b5a6978877665544332211ffeeddccbb';
const REV = 'a'.repeat(64);
const TASK = 'T-001';
const BRANCH = 'ao/T-001';
const BASE = 'main';
const REMOTE = 'origin';
const PR = 62;
const ROOT = 'D:\\repo';
const AT = '2026-08-25T00:00:00.000Z';

const IDENTITY = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});

function subjectOf(over: Partial<ReconciliationSubject> = {}): ReconciliationSubject {
  return Object.freeze({
    taskId: TASK,
    ...IDENTITY,
    deliveryCommit: HEAD,
    baseRef: BASE,
    ...over,
  });
}

function commandResult(over: Partial<CommandResult> = {}): CommandResult {
  return {
    display: 'x',
    executable: 'x',
    args: [],
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    failureCode: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytesObserved: 0,
    stderrBytesObserved: 0,
    durationMs: 1,
    timedOut: false,
    treeKilled: false,
    stdinDelivery: 'DELIVERED',
    ...over,
  } as CommandResult;
}

/** The locator answer — the array `commits/{sha}/pulls` returns. */
function candidates(
  entries: readonly {
    number?: number;
    state?: string;
    sha?: string;
    base?: string | null;
  }[] = [{}],
): string {
  return JSON.stringify(
    entries.map((e) => {
      const record: Record<string, unknown> = {
        number: e.number ?? PR,
        state: e.state ?? 'closed',
        head: { sha: e.sha ?? HEAD },
        draft: false,
      };
      if (e.base !== null) record['base'] = { ref: e.base ?? BASE };
      return record;
    }),
  );
}

/**
 * The single pull-request document, in GitHub's own shape.
 *
 * `merge_commit_sha` is supplied independently of `merged`, deliberately: the
 * measured trap is that GitHub fills that field on an OPEN pull request with an
 * ephemeral test-merge commit, and a fixture that could not express that could
 * not test the gate that ignores it.
 */
function prBody(
  over: {
    number?: number;
    state?: string;
    merged?: boolean;
    sha?: string;
    base?: string | null;
    mergeCommit?: string | null;
  } = {},
): string {
  const record: Record<string, unknown> = {
    number: over.number ?? PR,
    state: over.state ?? 'closed',
    merged: over.merged ?? true,
    head: { sha: over.sha ?? HEAD },
    draft: false,
    merge_commit_sha: over.mergeCommit === undefined ? RESULT : over.mergeCommit,
  };
  if (over.base !== null) record['base'] = { ref: over.base ?? BASE };
  return JSON.stringify(record);
}

interface Reads {
  readonly runner: ForgeCommandRunner;
  readonly calls: string[][];
  readonly paths: string[];
}

/**
 * A reading seam that answers the locator and the document endpoint separately.
 *
 * Distinguished by path shape rather than by call order, because the two are
 * asked by one function in a fixed order today and a fixture that encoded that
 * order would stop measuring the moment it changed.
 */
function reads(
  over: { locator?: string | null; document?: string | null } = {},
): Reads {
  const calls: string[][] = [];
  const paths: string[] = [];
  const runner: ForgeCommandRunner = async (_command, args) => {
    calls.push([...args]);
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    paths.push(path);
    // The two check endpoints answer for themselves. They belong to slice 2 and
    // are never asked by the reconciliation ladder — they are here so that the
    // POSITIVE CONTROLS in the command section are real: `--observe --record`
    // has to be able to settle and write, or "no receipt was written" would be
    // measuring a harness that cannot write anything at all.
    if (path.endsWith('/check-runs')) {
      return commandResult({
        stdout: JSON.stringify({
          total_count: 1,
          check_runs: [{ head_sha: HEAD, status: 'completed', conclusion: 'success' }],
        }),
      });
    }
    if (path.endsWith('/status')) {
      return commandResult({
        stdout: JSON.stringify({ sha: HEAD, state: 'success', total_count: 0, statuses: [] }),
      });
    }
    const page = /\/pulls\/\d+$/.test(path)
      ? over.document === undefined
        ? prBody()
        : over.document
      : over.locator === undefined
        ? candidates()
        : over.locator;
    if (page === null) return commandResult({ exitCode: 1, stdout: '{"message":"Not Found"}' });
    return commandResult({ stdout: page });
  };
  return { runner, calls, paths };
}

const ENV = Object.freeze({ PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' });

function seamsOf(runner: ForgeCommandRunner) {
  return { reader: runner, envSource: ENV, now: () => new Date(AT) };
}

function reading(over: Partial<MergeReading> = {}): MergeReading {
  return Object.freeze({
    outcome: 'MERGED' as const,
    number: PR,
    headSha: HEAD,
    baseRef: BASE,
    draft: false,
    mergeCommit: RESULT,
    ...over,
  });
}

/** A genuinely minted proof, for the cases that need one. */
function mintedProof(over: Partial<MergeReading> = {}, number = PR): MergeObservationProof {
  const proof = mintMergeObservation({
    ...IDENTITY,
    pullRequestNumber: number,
    reading: reading(over),
    observedAt: AT,
  });
  if (proof === null) throw new Error('fixture proof refused');
  return proof;
}

const SUBJECT: MergeReconciliationSubject = Object.freeze({
  taskId: TASK,
  repositoryRoot: ROOT,
});

function payloadOf(over: Partial<MergeReconciliationPayload> = {}): MergeReconciliationPayload {
  return {
    reconciliationVersion: MERGE_RECONCILIATION_VERSION,
    taskId: TASK,
    repositoryRoot: ROOT,
    subjectCommit: HEAD,
    provider: 'github' as const,
    ...IDENTITY,
    pullRequestNumber: PR,
    mergedHeadSha: HEAD,
    baseRef: BASE,
    mergeCommit: RESULT,
    observedAt: AT,
    reconciledAt: AT,
    ...over,
  };
}

/** A receipt whose binding is correct for whatever payload it carries. */
function receiptOf(
  over: Partial<MergeReconciliationPayload> = {},
  subject: MergeReconciliationSubject = SUBJECT,
): Record<string, unknown> {
  const payload = payloadOf(over);
  return { ...payload, binding: mergeReconciliationBinding(subject, payload) };
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

// ── 1. The record contract ─────────────────────────────────────────────────

describe('the merge receipt is a versioned, bounded, self-describing document', () => {
  it('accepts the record this build writes, and refuses one field at a time', () => {
    expect(MergeReconciliationSchema.safeParse(receiptOf()).success).toBe(true);

    // `.strict()`: a field this build does not declare is not ignored. A record
    // carrying something extra was written by something that is not this build,
    // and reading the part we recognise out of it would be reading half of
    // somebody else's document.
    expect(
      MergeReconciliationSchema.safeParse({ ...receiptOf(), extra: 1 }).success,
    ).toBe(false);

    // Every declared field is required. Enumerated from the record itself rather
    // than listed by hand, so a field added to the schema without being made
    // required cannot slip past this case.
    const full = receiptOf();
    for (const key of Object.keys(full)) {
      const without = { ...full };
      delete without[key];
      expect(MergeReconciliationSchema.safeParse(without).success, key).toBe(false);
    }
  });

  it('refuses a receipt whose head is not the commit it claims to be about', () => {
    // The one cross-field invariant, and the whole of it. Each field is
    // individually valid here — two different, well-formed object names — and
    // the combination describes something that cannot be this task's delivery:
    // a real merge of a real pull request, filed against a task whose commit was
    // never in it.
    const crossed = MergeReconciliationSchema.safeParse(
      receiptOf({ mergedHeadSha: OTHER }),
    );
    expect(crossed.success).toBe(false);

    // The control: the same two fields agreeing is accepted, so the refusal
    // above is about their relation and not about either value.
    expect(
      MergeReconciliationSchema.safeParse(
        receiptOf({ subjectCommit: OTHER, mergedHeadSha: OTHER }),
      ).success,
    ).toBe(true);
  });

  it('binds every payload field, and detects a one-field edit in each', () => {
    // A digest that covered only some fields would leave the rest editable in
    // place for free. Driven per field rather than asserted about the function,
    // because "every field is an input" is exactly the claim a hand-written
    // input list stops honouring the moment a field is added.
    const payload = payloadOf();
    const binding = mergeReconciliationBinding(SUBJECT, payload);
    const mutations: Partial<MergeReconciliationPayload>[] = [
      { reconciliationVersion: 2 },
      { taskId: 'T-002' },
      { repositoryRoot: 'D:\\other' },
      { subjectCommit: OTHER },
      // Cast because the field is a literal type: the schema admits one forge,
      // and the point here is that the DIGEST covers it — a future build that
      // learns a second forge must not be able to read this build's records as
      // being about it.
      { provider: 'gitlab' as unknown as 'github' },
      { host: 'example.com' },
      { owner: 'someone' },
      { name: 'other-repo' },
      { pullRequestNumber: 63 },
      { mergedHeadSha: OTHER },
      { baseRef: 'release' },
      { mergeCommit: OTHER },
      { observedAt: '2026-08-26T00:00:00.000Z' },
      { reconciledAt: '2026-08-26T00:00:00.000Z' },
    ];
    // Exactly the payload's own fields, neither fewer nor more. Without this the
    // list above could quietly stop covering a field somebody added.
    expect(
      mutations.map((m) => Object.keys(m)[0]).sort(),
    ).toEqual(Object.keys(payload).sort());
    for (const mutation of mutations) {
      const key = Object.keys(mutation)[0] ?? '';
      expect(
        mergeReconciliationBinding(SUBJECT, { ...payload, ...mutation }),
        key,
      ).not.toBe(binding);
    }

    // And the subject is an input too: the same payload against another task
    // binds differently, which is what makes a copied receipt detectable.
    expect(
      mergeReconciliationBinding({ taskId: 'T-002', repositoryRoot: ROOT }, payload),
    ).not.toBe(binding);
    expect(
      mergeReconciliationBinding({ taskId: TASK, repositoryRoot: 'D:\\other' }, payload),
    ).not.toBe(binding);
  });

  it('reads exactly five things, and exactly one of them is a recorded merge', () => {
    expect([...MERGE_RECONCILIATION_READINGS]).toEqual([
      'HISTORICAL_MERGE',
      'ABSENT',
      'UNSUPPORTED_VERSION',
      'MALFORMED',
      'NOT_THIS_TASK',
    ]);
    // Asserted by value, one row at a time. `satisfies` would accept `true`
    // everywhere, so completeness is the compiler's job and correctness is this
    // case's.
    const recorded = MERGE_RECONCILIATION_READINGS.filter((r) => isRecordedMerge(r));
    expect(recorded).toEqual(['HISTORICAL_MERGE']);
    // There is deliberately no per-reading sentence map, and no assertion here
    // standing in for one. A map was written with a docblock saying it was "for
    // the operator report"; a review measured that no report consumed it, and it
    // was deleted rather than given an invented use. A placeholder assertion in
    // its place would be a vacuous line pretending to be coverage.

    // There is deliberately no staleness member. A merge event does not stop
    // having happened because the task moved afterwards, and a reading that
    // expired it would discard the one fact the next slice needs. Stated as an
    // assertion so that adding one is a decision rather than a slip.
    expect(MERGE_RECONCILIATION_READINGS).not.toContain('LOCAL_BINDING_MISMATCH');
  });

  it('reads a receipt back, and refuses each way one can be wrong', () => {
    const cases: readonly [string, unknown, MergeReconciliationReading][] = [
      ['a genuine receipt', receiptOf(), 'HISTORICAL_MERGE'],
      // `undefined` is the ONLY input that reads as absent. A file whose
      // contents are the JSON value `null` is a file somebody wrote.
      ['nothing at all', undefined, 'ABSENT'],
      ['the JSON value null', null, 'MALFORMED'],
      ['a number', 7, 'MALFORMED'],
      ['an array', [], 'MALFORMED'],
      ['an empty object', {}, 'MALFORMED'],
      [
        'a future version',
        { ...receiptOf(), reconciliationVersion: MERGE_RECONCILIATION_VERSION + 1 },
        'UNSUPPORTED_VERSION',
      ],
      [
        'a version this build predates',
        { ...receiptOf(), reconciliationVersion: MERGE_RECONCILIATION_VERSION + 99 },
        'UNSUPPORTED_VERSION',
      ],
      ['an edited field', { ...receiptOf(), mergeCommit: OTHER }, 'NOT_THIS_TASK'],
      ['a stripped binding', { ...receiptOf(), binding: 'b'.repeat(64) }, 'NOT_THIS_TASK'],
      // Bound perfectly, for somebody else. The digest covers the record's OWN
      // identity, not the subject's, so a correctly-bound foreign receipt is
      // still not this task's.
      [
        'another task, correctly bound',
        receiptOf({ taskId: 'T-002' }, { taskId: 'T-002', repositoryRoot: ROOT }),
        'NOT_THIS_TASK',
      ],
      [
        'another repository, correctly bound',
        receiptOf({ repositoryRoot: 'D:\\other' }, { taskId: TASK, repositoryRoot: 'D:\\other' }),
        'NOT_THIS_TASK',
      ],
    ];
    for (const [label, raw, expected] of cases) {
      expect(readMergeReconciliation(raw, SUBJECT), label).toBe(expected);
    }
  });

  it('reads the version before the shape, so a future record says so', () => {
    // A future build's record will not satisfy this build's strict schema —
    // that is what a version bump is for. Asking the schema first would report
    // it `MALFORMED` and hide the one fact an operator needs.
    const future = { reconciliationVersion: 99, anything: 'at all' };
    expect(readMergeReconciliation(future, SUBJECT)).toBe('UNSUPPORTED_VERSION');
    // And a record with no version at all is not rescued by that arm.
    expect(readMergeReconciliation({ anything: 'at all' }, SUBJECT)).toBe('MALFORMED');
  });

  it('states what a receipt does not prove, in the operator\'s own words', () => {
    // Four sentences, and every one of them is a claim this slice must not make.
    // Pinned by phrase rather than by whole string so the wording can be
    // improved without the meaning being lost.
    for (const phrase of [
      'not a claim that the commit is on the base branch now',
      'has not\nbeen reverted',
      'anything was verified against it',
      'AO performed the merge',
    ]) {
      expect(MERGE_PRESENCE_SENTENCE, phrase).toContain(phrase);
    }
  });
});

// ── 2. The mint ────────────────────────────────────────────────────────────

describe('a merged-pull-request claim can only come from a reading', () => {
  it('mints for a merged reading, and carries exactly the forge\'s own facts', () => {
    const proof = mintedProof();
    expect(isMergeObservationProof(proof)).toBe(true);
    const facts = mergeObservationFactsOf(proof);
    expect(facts).toEqual({
      ...IDENTITY,
      pullRequestNumber: PR,
      headSha: HEAD,
      baseRef: BASE,
      mergeCommit: RESULT,
      observedAt: AT,
    } satisfies MergeObservationFacts);
    // Frozen: a caller holding a proof cannot edit the facts out from under the
    // recorder that will read them.
    expect(Object.isFrozen(facts)).toBe(true);
  });

  it('refuses every reading that is not a merge it can vouch for', () => {
    const refused: readonly [string, Parameters<typeof mintMergeObservation>[0]][] = [
      [
        'an open pull request',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ outcome: 'OPEN', mergeCommit: null }), observedAt: AT },
      ],
      [
        // The measured trap, and the reason this arm exists: GitHub fills
        // `merge_commit_sha` on an OPEN pull request with an ephemeral
        // two-parent TEST merge commit that is on no branch. A mint that read
        // the field without first re-deriving mergedness would attest to it.
        'an open pull request that still carries a merge commit',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ outcome: 'OPEN' }), observedAt: AT },
      ],
      [
        'a pull request closed without being merged',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ outcome: 'CLOSED_UNMERGED', mergeCommit: null }), observedAt: AT },
      ],
      [
        'a reading that established nothing',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ outcome: 'UNKNOWN' }), observedAt: AT },
      ],
      [
        'an answer about a different pull request',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ number: 63 }), observedAt: AT },
      ],
      [
        'a merge with no resulting commit',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ mergeCommit: null }), observedAt: AT },
      ],
      [
        'a resulting commit that is not an object name',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ mergeCommit: 'HEAD' }), observedAt: AT },
      ],
      [
        'an abbreviated resulting commit',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ mergeCommit: RESULT.slice(0, 7) }), observedAt: AT },
      ],
      [
        'a merge with no head',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ headSha: null }), observedAt: AT },
      ],
      [
        'a merge with no base',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ baseRef: null }), observedAt: AT },
      ],
      [
        'a base longer than a receipt will carry',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading({ baseRef: 'b'.repeat(MAX_BASE_REF_LENGTH + 1) }), observedAt: AT },
      ],
      [
        'a pull-request number that is not one',
        { ...IDENTITY, pullRequestNumber: 0, reading: reading({ number: 0 }), observedAt: AT },
      ],
      [
        'an instant this build does not write',
        { ...IDENTITY, pullRequestNumber: PR, reading: reading(), observedAt: 'yesterday' },
      ],
      [
        'a host that is not addressable',
        { ...IDENTITY, host: '', pullRequestNumber: PR, reading: reading(), observedAt: AT },
      ],
      [
        'a reading that is not an object',
        { ...IDENTITY, pullRequestNumber: PR, reading: null as unknown as MergeReading, observedAt: AT },
      ],
    ];
    for (const [label, input] of refused) {
      expect(mintMergeObservation(input), label).toBeNull();
    }
    // The control: exactly one base character shorter is accepted, so the bound
    // above is a bound and not a rejection of every long name.
    expect(
      mintMergeObservation({
        ...IDENTITY,
        pullRequestNumber: PR,
        reading: reading({ baseRef: 'b'.repeat(MAX_BASE_REF_LENGTH) }),
        observedAt: AT,
      }),
    ).not.toBeNull();
  });

  it('cannot be forged by shape, by prototype, or by the constructor', () => {
    // The three routes that were used against this codebase's other opaque
    // artefacts, in the order they were used.
    const shaped = {
      ...IDENTITY,
      pullRequestNumber: PR,
      headSha: HEAD,
      baseRef: BASE,
      mergeCommit: RESULT,
      observedAt: AT,
    };
    expect(isMergeObservationProof(shaped)).toBe(false);
    expect(mergeObservationFactsOf(shaped)).toBeNull();

    // `Object.create` hands anybody the prototype. Registry membership, not
    // `instanceof`, is what the gate asks.
    const genuine = mintedProof();
    const prototyped = Object.create(Object.getPrototypeOf(genuine) as object) as unknown;
    expect(isMergeObservationProof(prototyped)).toBe(false);
    expect(mergeObservationFactsOf(prototyped)).toBeNull();

    // The constructor is reachable from any instance as
    // `Object.getPrototypeOf(x).constructor` — with no import at all — and that
    // route produced a working forgery against an earlier artefact here. It is
    // deleted, and both objects are frozen so it cannot be put back.
    expect(
      Object.prototype.hasOwnProperty.call(MergeObservationEvidence.prototype, 'constructor'),
    ).toBe(false);
    expect(Object.isFrozen(MergeObservationEvidence.prototype)).toBe(true);
    expect(Object.isFrozen(MergeObservationEvidence)).toBe(true);

    // A value cast past the compiler reaches a live runtime gate, which is the
    // only place the guarantee matters.
    expect(mergeObservationFactsOf(shaped as unknown as MergeObservationProof)).toBeNull();
  });

  it('refuses a real instance that was never minted', () => {
    // The registry is the gate, and this is the case that proves it is doing
    // work rather than being decoration. A genuine `MergeObservationEvidence`,
    // constructed directly with a real private field, reads its facts perfectly
    // — and was never admitted to the registry, so it is not a proof.
    //
    // Written after a counter-proof measured the registry check in
    // `mergeObservationFactsOf` as removable with no test failing: without this
    // case the private-field read alone was carrying the guarantee, and the
    // module's header claims the registry is.
    const unminted = new MergeObservationEvidence({
      ...IDENTITY,
      pullRequestNumber: PR,
      headSha: HEAD,
      baseRef: BASE,
      mergeCommit: RESULT,
      observedAt: AT,
    });
    // It really is one — the facts are readable through the private accessor —
    // so the refusal below is about provenance and not about shape.
    expect(MergeObservationEvidence.factsOf(unminted).mergeCommit).toBe(RESULT);
    expect(isMergeObservationProof(unminted)).toBe(false);
    expect(mergeObservationFactsOf(unminted)).toBeNull();
  });

  /**
   * The reachability pin. The guarantee is "product code cannot go around the
   * boundary", and it is worth exactly as much as the number of modules that
   * can reach the mint.
   *
   * Added after a review pointed out that slice 8 was the first opaque artefact
   * here without one, and that without it the whole claim reduces to "no module
   * other than the ladder imports the mint" — with nothing measuring that set. A
   * later slice importing `mintMergeObservation` and minting from a locally
   * assembled reading would write a receipt for a merge github.com was never
   * asked about, with the suite green.
   *
   * Structured exactly as `tests/v4-03-delivery-evidence.test.ts:405`, including
   * both holes that file records reopening: a hand-written file list is not a
   * reachability check, and matching the specifier by an `internal/` segment
   * cannot see a module placed *inside* that directory.
   */
  it('is minted from exactly one module beside its own public wrapper', () => {
    const sources = walk('src');
    // Positive control: the walk really found the tree, not an empty directory.
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain('src/deliver/reconcile-merge.ts');

    // BOTH quote styles. A review defeated the first version with a
    // double-quoted specifier — this file's own style is single quotes and
    // nothing in the scan enforced that, so `from "./internal/…"` was simply
    // invisible to it. A pin that a formatting choice can switch off is not one.
    const specifier = /from\s+['"]([^'"]*merge-observation-proof\.js)['"]/g;
    const importers = sources
      .filter((file) => {
        const code = codeOnly(file);
        for (const match of code.matchAll(specifier)) {
          const found = match[1] ?? '';
          // The specifier is RESOLVED against the importing file's directory
          // before it is judged, rather than compared by its last two segments.
          //
          // A confirmation defeated the segment comparison with a `..` inside
          // the specifier: `'../deliver/internal/x/../merge-observation-proof.js'`
          // ends in `../merge-observation-proof.js`, which matched neither arm
          // while resolving to the mint. ESM and TypeScript resolve lexically, so
          // the `x/` segment need not exist. Normalising first closes the whole
          // family — `.` segments, redundant separators and any depth of `..` —
          // rather than the one spelling that was demonstrated.
          // `walk` builds its paths with forward slashes, so `file` is already
          // POSIX-shaped and needs no conversion before `posix.dirname`.
          const resolved = posix.normalize(posix.join(posix.dirname(file), found));
          if (resolved === 'src/deliver/internal/merge-observation-proof.js') return true;
        }
        return false;
      })
      .sort();
    expect(importers).toEqual([
      'src/deliver/merge-observation-proof.ts',
      'src/deliver/reconcile-merge.ts',
    ]);

    // The call, not just the import: a module could import the class and mint
    // through it. Exactly one file outside the declaring module calls the mint.
    const callers = sources
      .filter(
        (file) =>
          file !== 'src/deliver/internal/merge-observation-proof.ts' &&
          /\bmintMergeObservation\s*\(/.test(codeOnly(file)),
      )
      .sort();
    expect(callers).toEqual(['src/deliver/reconcile-merge.ts']);

    // Positive control on the search itself: it finds the mint's own name where
    // one exists, so an empty result above would be a fact about the tree and
    // not about the scan.
    expect(readFileSync('src/deliver/reconcile-merge.ts', 'utf8')).toContain(
      'mintMergeObservation',
    );

    // Nothing anywhere may re-export the mint or the class, which would walk
    // past the import pin entirely.
    //
    // `export *` is banned separately and for a different reason, and it is the
    // second hole a review measured. A named re-export is caught by the pattern
    // below; `export * from './internal/merge-observation-proof.js'` in the
    // PUBLIC WRAPPER is not — and the wrapper is already an expected importer,
    // so the list above would still be exactly right while every module that
    // imports the wrapper could reach the mint through it.
    for (const file of sources) {
      if (file === 'src/deliver/internal/merge-observation-proof.ts') continue;
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/export\s*\{[^}]*mintMergeObservation/);
      expect(source, file).not.toMatch(/export\s*\{[^}]*MergeObservationEvidence/);
      expect(source, `${file}: export *`).not.toMatch(
        /export\s*\*[^;]*merge-observation-proof/,
      );
      // And no exported ALIAS of the mint, which is the form that walks past
      // both scans above. `export const mint = mintMergeObservation;` inside an
      // allowed importer is not an `export {` re-export, and consumers calling
      // `mint(...)` do not name the mint at all — so the import list stays
      // exactly right while anything that imports that module can mint.
      //
      // TWO bans, and the second is the general one. A confirmation measured the
      // first — a single `=` pattern — and got four spellings past it:
      // `export default mintMergeObservation;`, a member of an exported object
      // literal, a wrapping arrow function, and a namespace import re-exported
      // from the public wrapper. Any line that both exports and names the mint
      // is refused now, which covers the first three.
      expect(source, `${file}: exported alias`).not.toMatch(
        /export[^;\n]*=\s*mintMergeObservation/,
      );
      expect(source, `${file}: export naming the mint`).not.toMatch(
        /^\s*export\b.*mintMergeObservation/m,
      );
    }
    // And the mint's name may not appear in the public wrapper at all, which
    // would be a re-export in all but name.
    expect(readFileSync('src/deliver/merge-observation-proof.ts', 'utf8')).not.toContain(
      'mintMergeObservation',
    );
    // The mint's NAME may appear only in the two files allowed to have it.
    //
    // The import scan asks which modules name the module; this asks which name
    // the function. A confirmation walked past both with
    // `export const mint = mintMergeObservation;` inside an allowed importer —
    // not an `export {` form, so the re-export ban missed it, and consumers
    // calling `mint(...)` miss a scan for `mintMergeObservation(`. A bare
    // identifier ban closes the aliasing family outright.
    const namers = sources
      .filter((file) => codeOnly(file).includes('mintMergeObservation'))
      .sort();
    expect(namers).toEqual([
      'src/deliver/internal/merge-observation-proof.ts',
      'src/deliver/reconcile-merge.ts',
    ]);

    // No dynamic import can route around the static scan either, in either
    // quote style, and no `require` of it.
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/import\s*\(\s*[^)]*merge-observation-proof/);
      expect(source, file).not.toMatch(/require\s*\(\s*[^)]*merge-observation-proof/);
    }

    // The scan's own controls, because a regex that matched nothing would pass
    // every assertion above. Each pattern is shown to find what it is for.
    expect(specifier.test("from \"./internal/merge-observation-proof.js\"")).toBe(true);
    specifier.lastIndex = 0;
    expect(specifier.test("from './internal/merge-observation-proof.js'")).toBe(true);
    specifier.lastIndex = 0;
    expect(
      /export\s*\*[^;]*merge-observation-proof/.test(
        "export * from './internal/merge-observation-proof.js';",
      ),
    ).toBe(true);
    // And the resolver really does normalise a `..` specifier onto the mint, so
    // the arm that closes that hole is measured rather than assumed.
    expect(
      posix.normalize(
        posix.join(
          posix.dirname('src/deliver/pull-request-merge.ts'),
          './internal/x/../merge-observation-proof.js',
        ),
      ),
    ).toBe('src/deliver/internal/merge-observation-proof.js');
    // And the two alias bans really match the forms they were written for —
    // including the three a confirmation got past the first of them.
    const anyExport = /^\s*export\b.*mintMergeObservation/m;
    for (const form of [
      'export const mint = mintMergeObservation;',
      'export default mintMergeObservation;',
      'export const proofApi = { mint: mintMergeObservation };',
      'export const mintAnything = (f: X) => mintMergeObservation(f);',
    ]) {
      expect(anyExport.test(form), form).toBe(true);
    }
    // …without matching the ordinary call the one allowed caller makes, which
    // would make the ban unsatisfiable rather than protective.
    for (const ordinary of [
      '  const proof = mintMergeObservation({',
      'import { mintMergeObservation } from ',
    ]) {
      expect(anyExport.test(ordinary), ordinary).toBe(false);
    }
    // The narrower `=` ban is kept beside it and still matches its own form: two
    // patterns whose failure modes differ is the point, not redundancy.
    expect(
      /export[^;\n]*=\s*mintMergeObservation/.test('export const mint = mintMergeObservation;'),
    ).toBe(true);
  });

  it('answers null rather than throwing for a value that captured the registry', () => {
    // Registry capture is reachable, and this is how: hook
    // `WeakSet.prototype.add` and ride the mint's own call to smuggle a second
    // object into the same registry. A review captured a sibling artefact here
    // exactly this way.
    //
    // The class itself is frozen, so `vi.spyOn(MergeObservationEvidence,
    // 'holds')` throws `Cannot redefine property` — which is the freeze doing
    // its job and is why this case does not take that shortcut.
    const captured = Object.create(MergeObservationEvidence.prototype) as object;
    const realAdd = WeakSet.prototype.add;
    let smuggled = false;
    // eslint-disable-next-line no-extend-native
    WeakSet.prototype.add = function patched<T extends object>(this: WeakSet<T>, value: T) {
      const out = realAdd.call(this, value) as WeakSet<T>;
      if (!smuggled) {
        smuggled = true;
        realAdd.call(this, captured as T);
      }
      return out;
    } as typeof WeakSet.prototype.add;
    try {
      mintMergeObservation({
        ...IDENTITY,
        pullRequestNumber: PR,
        reading: reading(),
        observedAt: AT,
      });
    } finally {
      // eslint-disable-next-line no-extend-native
      WeakSet.prototype.add = realAdd;
    }
    expect(smuggled).toBe(true);

    // It passes the membership gate — that is what capture buys — and has no
    // private field, so `factsOf` throws. A check that answers by throwing is
    // not answering, so the safe accessor reports the refusal as `null` and the
    // recorder refuses it. That is the property that matters; capture together
    // with the internal class is a fully readable forgery, and is not an
    // escalation, because anyone who can import the mint can call it.
    expect(isMergeObservationProof(captured)).toBe(true);
    expect(mergeObservationFactsOf(captured)).toBeNull();
  });
});

// ── 3. The ladder: exact identity, from the forge ──────────────────────────

describe('a merge is established from the delivery commit, and bound to it', () => {
  it('names eleven outcomes, each with its own sentence, and no dead member', () => {
    expect(MERGE_OBSERVATIONS).toHaveLength(11);
    expect(new Set(MERGE_OBSERVATIONS).size).toBe(MERGE_OBSERVATIONS.length);
    for (const o of MERGE_OBSERVATIONS) {
      expect(MERGE_OBSERVATION_DETAIL[o], o).toBeTruthy();
    }
    expect(Object.keys(MERGE_OBSERVATION_DETAIL).sort()).toEqual([...MERGE_OBSERVATIONS].sort());
  });

  it('observes a merge, mints a proof, and asks exactly two questions', async () => {
    const r = reads();
    const out = await observeMergeForDelivery(subjectOf(), seamsOf(r.runner));
    expect(out.outcome).toBe('MERGE_OBSERVED');
    expect(out.pullRequestNumber).toBe(PR);
    expect(out.contacted).toBe(true);
    expect(out.proof).not.toBeNull();

    // Two requests, and both are the ones named. The locator is keyed on the
    // delivery commit; the document endpoint on the number that answer gave.
    expect(r.paths).toEqual([
      `repos/${IDENTITY.owner}/${IDENTITY.name}/commits/${HEAD}/pulls`,
      `repos/${IDENTITY.owner}/${IDENTITY.name}/pulls/${String(PR)}`,
    ]);

    // The facts are the forge's, not the caller's. In particular the resulting
    // commit is a value no local computation can produce, and it is not the
    // head — under a squash merge those are necessarily different objects.
    const facts = mergeObservationFactsOf(out.proof);
    expect(facts?.mergeCommit).toBe(RESULT);
    expect(facts?.mergeCommit).not.toBe(HEAD);
    expect(facts?.headSha).toBe(HEAD);
    expect(facts?.baseRef).toBe(BASE);
    expect(facts?.observedAt).toBe(AT);
  });

  it('refuses every way the forge answer can fail to be this delivery', async () => {
    const cases: readonly [string, Parameters<typeof reads>[0], MergeObservationOutcome][] = [
      // No pull request carries this commit as its head.
      ['no candidate at all', { locator: '[]' }, 'NO_PULL_REQUEST_AT_HEAD'],
      [
        'candidates at other heads only',
        { locator: candidates([{ sha: OTHER }]) },
        'NO_PULL_REQUEST_AT_HEAD',
      ],
      // An open pull request still carries this head, so the settled fact about
      // this delivery is not a merge.
      ['an open candidate', { locator: candidates([{ state: 'open' }]) }, 'PULL_REQUEST_STILL_OPEN'],
      [
        'two open candidates',
        { locator: candidates([{ state: 'open' }, { state: 'open', number: 63 }]) },
        'PULL_REQUEST_STILL_OPEN',
      ],
      // Two closed pull requests were opened from this exact commit. Which is
      // the delivery is a question about what a human did.
      [
        'two closed candidates',
        { locator: candidates([{}, { number: 63 }]) },
        'PULL_REQUEST_AMBIGUOUS',
      ],
      // Addressed by number, and it is not merged. The candidate list cannot
      // make this distinction: it carries no `merged` field.
      ['closed, not merged', { document: prBody({ merged: false }) }, 'NOT_MERGED'],
      // The two endpoints disagree about the same pull request's head.
      ['merged at another head', { document: prBody({ sha: OTHER }) }, 'MERGE_NOT_THIS_DELIVERY'],
      // The near miss: the work went in, somewhere this task never asked for.
      ['merged into another base', { document: prBody({ base: 'release' }) }, 'BASE_NOT_INTENDED'],
      // Merged, and the forge cannot name what it produced.
      ['merged with no resulting commit', { document: prBody({ mergeCommit: null }) }, 'FORGE_UNREADABLE'],
      // The forge could not be read, at either endpoint.
      ['the locator refused', { locator: null }, 'FORGE_UNREADABLE'],
      ['the document refused', { document: null }, 'FORGE_UNREADABLE'],
      ['a malformed locator answer', { locator: '{"not":"an array"}' }, 'FORGE_UNREADABLE'],
      ['a malformed document answer', { document: '[]' }, 'FORGE_UNREADABLE'],
      // A state word this build has never seen is not read as either of the two
      // it knows. Fail-closed, and note WHICH way it fails: `UNKNOWN` becomes
      // `FORGE_UNREADABLE` — "this build did not establish what this is" — and
      // NOT `NOT_MERGED`, which would be a claim about the pull request. This
      // expectation was written the other way round first, and the code was
      // right: reporting an unreadable answer as a settled negative is exactly
      // the rounding this vocabulary exists to refuse.
      [
        'an unrecognised state',
        { document: prBody({ state: 'archived', merged: false }) },
        'FORGE_UNREADABLE',
      ],
    ];
    for (const [label, over, expected] of cases) {
      const out = await observeMergeForDelivery(subjectOf(), seamsOf(reads(over).runner));
      expect(out.outcome, label).toBe(expected);
      // Not one of these mints anything. A refusal is not a weaker merge.
      expect(out.proof, label).toBeNull();
    }
  });

  it('carries the pull-request number from the moment one is addressed, and not before', async () => {
    // The field's contract, pinned. A review measured the docblock wrong: it
    // said the number is non-null only from `NOT_MERGED` onwards, and two
    // ordinary `FORGE_UNREADABLE` paths carry one — both reached AFTER a single
    // pull request has been addressed by number. The vocabulary's order and the
    // reads' order are different things.
    const addressed: readonly [string, Parameters<typeof reads>[0], MergeObservationOutcome][] = [
      ['the document refused', { document: null }, 'FORGE_UNREADABLE'],
      [
        'an unrecognised state',
        { document: prBody({ state: 'archived', merged: false }) },
        'FORGE_UNREADABLE',
      ],
      ['closed, not merged', { document: prBody({ merged: false }) }, 'NOT_MERGED'],
      ['merged at another head', { document: prBody({ sha: OTHER }) }, 'MERGE_NOT_THIS_DELIVERY'],
      ['merged into another base', { document: prBody({ base: 'release' }) }, 'BASE_NOT_INTENDED'],
    ];
    for (const [label, over, expected] of addressed) {
      const out = await observeMergeForDelivery(subjectOf(), seamsOf(reads(over).runner));
      expect(out.outcome, label).toBe(expected);
      expect(out.pullRequestNumber, label).toBe(PR);
    }

    // And null on every member decided from the candidate set alone, including
    // the locator-level refusal that shares the outcome word with two above.
    const unaddressed: readonly [string, Parameters<typeof reads>[0]][] = [
      ['the locator refused', { locator: null }],
      ['no pull request at this head', { locator: '[]' }],
      ['still open', { locator: candidates([{ state: 'open' }]) }],
      ['two closed candidates', { locator: candidates([{}, { number: 63 }]) }],
    ];
    for (const [label, over] of unaddressed) {
      const out = await observeMergeForDelivery(subjectOf(), seamsOf(reads(over).runner));
      expect(out.pullRequestNumber, label).toBeNull();
    }
  });

  it('reconciles a different task\'s delivery only by asking about that commit', async () => {
    // The head is the whole binding. Two tasks with two commits ask two
    // different questions of the forge, and the answer to one is not evidence
    // about the other — measured by the request path rather than argued.
    const a = reads();
    await observeMergeForDelivery(subjectOf(), seamsOf(a.runner));
    const b = reads();
    await observeMergeForDelivery(subjectOf({ deliveryCommit: OTHER }), seamsOf(b.runner));
    expect(a.paths[0]).toContain(HEAD);
    expect(b.paths[0]).toContain(OTHER);
    expect(a.paths[0]).not.toBe(b.paths[0]);
  });

  it('asks a different repository a different question', async () => {
    const r = reads();
    await observeMergeForDelivery(
      subjectOf({ owner: 'someone', name: 'other-repo' }),
      seamsOf(r.runner),
    );
    expect(r.paths[0]).toBe(`repos/someone/other-repo/commits/${HEAD}/pulls`);
  });

  it('refuses before any process exists when the subject is not addressable', async () => {
    const r = reads();
    const out = await observeMergeForDelivery(
      subjectOf({ deliveryCommit: 'not-a-commit' }),
      seamsOf(r.runner),
    );
    expect(out.outcome).toBe('FORGE_UNREADABLE');
    // The distinction the report's egress disclosure is derived from: nothing
    // was contacted, and the fields alone cannot say so.
    expect(out.contacted).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  it('carries the two members the caller owns, and contacts nothing for them', () => {
    for (const code of ['SUBJECT_NOT_ESTABLISHED', 'TASK_NOT_READY'] as const) {
      const out = refuseMergeObservation(code);
      expect(out.outcome).toBe(code);
      expect(out.contacted).toBe(false);
      expect(out.proof).toBeNull();
      expect(out.reading).toBeNull();
      expect(out.pullRequestNumber).toBeNull();
    }
  });

  it('takes no grant, and names none', () => {
    // Structural, not a promise. Requiring a `MergeGrant` would make the
    // recovery case impossible — a merge AO did not perform has no grant and
    // never had one — so the ladder must not so much as mention one.
    const source = codeOnly('src/deliver/reconcile-merge.ts');
    expect(source.length).toBeGreaterThan(200);
    for (const token of ['MergeGrant', 'claimMerge', 'mintMergeGrant', 'HeadPublicationGrant']) {
      expect(source, token).not.toContain(token);
    }
    // The positive control: the same search DOES find the grant in the module
    // that is supposed to have one, so an empty scan cannot pass as a clean one.
    expect(codeOnly('src/deliver/merge-pull-request.ts')).toContain('claimMerge');
  });

  it('reads no stored record, so history alone can never manufacture a merge', () => {
    // Slice 3's store has no path into the ladder. A historical pull-request
    // number is not evidence, and a design that took one could not tell a
    // remembered delivery from a current one.
    const source = codeOnly('src/deliver/reconcile-merge.ts');
    for (const token of ['loadDeliveryEvidence', 'delivery-evidence', 'readDeliveryEvidence']) {
      expect(source, token).not.toContain(token);
    }
    expect(codeOnly('src/cli/delivery-command.ts')).toContain('loadDeliveryEvidence');
  });
});

/**
 * V4 slice 18R — the one locator answer this ladder tells apart.
 *
 * Measured against `github.com` on 2026-08-28: a commit the repository cannot
 * resolve makes `commits/{sha}/pulls` answer HTTP 422 with
 * `{"message":"No commit found for SHA: <sha>", …, "status":"422"}` and `gh`
 * exit 1. Before this slice that was one more `FORGE_UNREADABLE`, and the
 * driver could therefore never reach the act whose whole purpose is to put the
 * commit on the forge — the real defect the M1 dogfood found.
 */
describe('the forge answering that it cannot resolve the delivery commit', () => {
  const LOCATOR_DOC_URL =
    'https://docs.github.com/rest/commits/commits#list-pull-requests-associated-with-a-commit';

  const missing = (sha: string, over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      message: `No commit found for SHA: ${sha}`,
      documentation_url: LOCATOR_DOC_URL,
      status: '422',
      ...over,
    });

  /** The locator answers the measured document with the exit code `gh` reports. */
  function refusingReader(stdout: string): ForgeCommandRunner {
    return (async (_command, args) => {
      const path = (args as readonly string[]).find((a) => a.startsWith('repos/')) ?? '';
      if (path.endsWith('/pulls')) return commandResult({ exitCode: 1, stdout });
      throw new Error(`unexpected request: ${path}`);
    }) as ForgeCommandRunner;
  }

  it('is its own outcome, decided from one request, and mints nothing', async () => {
    const out = await observeMergeForDelivery(
      subjectOf(),
      seamsOf(refusingReader(missing(HEAD))),
    );
    expect(out.outcome).toBe('DELIVERY_COMMIT_UNRESOLVED');
    // A process ran and github.com replied, so the egress disclosure is owed.
    expect(out.contacted).toBe(true);
    // Decided before any pull request was addressed, so it carries none of the
    // fields that only an addressed pull request can fill.
    expect(out.pullRequestNumber).toBeNull();
    expect(out.reading).toBeNull();
    expect(out.proof).toBeNull();
  });

  it('sits between the refusal and the report, weakest claim first', () => {
    // `MERGE_OBSERVATIONS` says of itself that it is ordered as the ladder
    // decides, weakest claim first. This member is decided after
    // `FORGE_UNREADABLE`'s conditions and before any candidate set exists, so
    // that is where it belongs — and the position is pinned rather than assumed,
    // because the report-shape table two sections down is built from this array
    // and would silently encode whatever order it found.
    const at = (o: MergeObservationOutcome): number => MERGE_OBSERVATIONS.indexOf(o);
    expect(at('DELIVERY_COMMIT_UNRESOLVED')).toBe(at('FORGE_UNREADABLE') + 1);
    expect(at('NO_PULL_REQUEST_AT_HEAD')).toBe(at('DELIVERY_COMMIT_UNRESOLVED') + 1);
  });

  /**
   * The sentence, pinned by literal — and, which matters more here, pinned
   * against the six things it must not grow into.
   *
   * This is the one member of this vocabulary that a driver consumes as a
   * premise for an irreversible act, so an operator sentence that claimed more
   * than the endpoint established would be the worst kind of drift.
   */
  it('claims what the forge answered, and none of the six neighbouring claims', () => {
    const sentence = MERGE_OBSERVATION_DETAIL.DELIVERY_COMMIT_UNRESOLVED;
    expect(sentence).toBe(
      'Asked which pull requests carry this task’s delivery commit, the forge answered that it ' +
        'found no commit with that object name in this repository. Nothing about a pull request, ' +
        'about a merge, or about where this commit has been is established.',
    );
    // It attributes — "the forge answered" — rather than adopting.
    expect(sentence).toContain('the forge answered');
    for (const forbidden of [
      'does not exist',
      'never',
      'not merged',
      'was not published',
      'no pull request has',
      'nowhere',
    ]) {
      expect(sentence.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  /**
   * Everything that is not the measured answer for this exact subject stays
   * `FORGE_UNREADABLE`, which is where it was before this slice.
   *
   * The wrong-subject case is the load-bearing one: without the equality against
   * the object name the request was built from, a crossed or replayed answer
   * would authorise a publication for somebody else's commit.
   */
  it.each([
    ['an answer naming a different commit', missing('b'.repeat(40))],
    ['an answer naming an abbreviation', missing('10583ee')],
    ['an answer naming the same commit in upper case', missing(HEAD.toUpperCase())],
    ['a validation 422 carrying an errors array', missing(HEAD, { errors: [{ field: 'q' }] })],
    ['this exact message under a 404', missing(HEAD, { status: '404' })],
    ['this exact message under a 500', missing(HEAD, { status: '500' })],
    ['a 404 for a repository that is not there', JSON.stringify({ message: 'Not Found', documentation_url: LOCATOR_DOC_URL, status: '404' })],
    ['a 409 for an empty repository', JSON.stringify({ message: 'Git Repository is empty.', documentation_url: LOCATOR_DOC_URL, status: '409' })],
    ['a 401 for a credential the forge rejected', JSON.stringify({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' })],
    ['the same answer from another endpoint', missing(HEAD).replace(LOCATOR_DOC_URL, 'https://docs.github.com/rest/checks/runs#list-check-runs-for-a-git-reference')],
    ['a body that is not JSON', 'gh: No commit found for SHA (HTTP 422)'],
    ['no body at all', ''],
  ])('grades %s as unreadable, exactly as before', async (_label, stdout) => {
    const out = await observeMergeForDelivery(subjectOf(), seamsOf(refusingReader(stdout)));
    expect(out.outcome).toBe('FORGE_UNREADABLE');
    expect(out.proof).toBeNull();
  });

  /**
   * The recovery property this member must not eat.
   *
   * A merged pull request whose head branch was deleted still resolves through
   * the locator — measured on this repository for pull requests 49, 50 and, on
   * 2026-08-28, 74. So the missing-commit answer never arises for it, and the
   * ladder reconciles rather than concluding the head is not there.
   */
  it('never fires for a merged delivery whose head branch was deleted', async () => {
    const out = await observeMergeForDelivery(subjectOf(), seamsOf(reads().runner));
    expect(out.outcome).toBe('MERGE_OBSERVED');
  });
});

// ── 4. The store: durability, idempotency, conflict ────────────────────────

describe('a receipt is written once, never overwritten, and read back exactly', () => {
  function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), 'ao-v408-'));
    mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
    return root;
  }

  function writeRequest(
    root: string,
    over: Partial<MergeReconciliationWriteRequest> = {},
  ): MergeReconciliationWriteRequest {
    return {
      repositoryRoot: root,
      taskId: TASK,
      expectedSubjectCommit: HEAD,
      expectedHost: IDENTITY.host,
      expectedOwner: IDENTITY.owner,
      expectedName: IDENTITY.name,
      expectedBaseRef: BASE,
      proof: mintedProof(),
      reconciledAt: AT,
      checkIgnored: async () => 'IGNORED' as IgnoreVerdict,
      ...over,
    };
  }

  function receiptPath(root: string): string {
    return join(mergeReconciliationDirectory(root), `${TASK}.json`);
  }

  it('puts the receipt in its own directory, never where a task state can land', () => {
    // The defect a review reproduced against a suffix scheme: the task-id
    // grammar admits `.`, so `<taskId>.merge.json` inside the runtime directory
    // is a name another legitimately-named task already owns. A directory closes
    // it structurally.
    expect(MERGE_RECONCILIATION_DIR_NAME).toBe('delivery-merge');
    const a = deriveMergeReconciliationLocation(ROOT, 'T-001');
    const b = deriveMergeReconciliationLocation(ROOT, 'T-001.delivery-merge');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.path).not.toBe(b.path);

    // And it is not slice 3's directory either. Two records with two lifetimes:
    // one is a latest snapshot a later observation replaces, the other is an
    // event that must survive every later observation.
    expect(mergeReconciliationDirectory(ROOT)).not.toBe(join(ROOT, '.agent-orchestrator', 'runtime'));
    expect(mergeReconciliationDirectory(ROOT)).toContain(MERGE_RECONCILIATION_DIR_NAME);

    expect(isMergeReconciliationFileName('T-001.json')).toBe(true);
    expect(isMergeReconciliationFileName('../escape.json')).toBe(false);
    expect(isMergeReconciliationFileName('T-001.txt')).toBe(false);

    for (const bad of ['', ' ', 'relative/path']) {
      expect(deriveMergeReconciliationLocation(bad, TASK).ok, bad).toBe(false);
    }
    expect(deriveMergeReconciliationLocation(ROOT, '').ok).toBe(false);
  });

  it('writes, reads back, and survives a restart', async () => {
    const root = scratch();
    try {
      const first = await recordMergeReconciliation(writeRequest(root));
      expect(first.code).toBe('RECORDED');
      expect(first.recorded).toBe(true);
      expect(first.writeAttempt).toBe('COMPLETED');
      expect(first.path).toBe(receiptPath(root));

      // Read back from BYTES, through the production path, exactly as a later
      // process would. Nothing in memory is consulted.
      const back = loadMergeReconciliation(root, TASK, { taskId: TASK, repositoryRoot: root });
      expect(back.reading).toBe('HISTORICAL_MERGE');
      expect(back.receipt?.pullRequestNumber).toBe(PR);
      expect(back.receipt?.mergedHeadSha).toBe(HEAD);
      expect(back.receipt?.subjectCommit).toBe(HEAD);
      expect(back.receipt?.baseRef).toBe(BASE);
      expect(back.receipt?.mergeCommit).toBe(RESULT);
      expect(back.receipt?.observedAt).toBe(AT);

      // The one field the next slice exists to verify, and the one no local
      // computation can produce.
      expect(back.receipt?.mergeCommit).not.toBe(back.receipt?.subjectCommit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent: an identical second reconciliation writes nothing', async () => {
    const root = scratch();
    try {
      await recordMergeReconciliation(writeRequest(root));
      const bytes = readFileSync(receiptPath(root));

      // A later moment, a fresh proof, the same merge. `reconciledAt` differs,
      // which is exactly the field a conflict test must not look at.
      const again = await recordMergeReconciliation(
        writeRequest(root, { reconciledAt: '2026-08-26T12:00:00.000Z', proof: mintedProof() }),
      );
      expect(again.code).toBe('ALREADY_RECORDED');
      expect(again.recorded).toBe(false);
      // The idempotency claim, stated as the question an operator asks: did this
      // touch anything?
      expect(again.writeAttempt).toBe('NOT_ATTEMPTED');
      // And the bytes prove it: byte-identical, so not even a rewrite of the
      // same content happened.
      expect(readFileSync(receiptPath(root))).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a receipt that names a different merge, and changes nothing', async () => {
    const root = scratch();
    try {
      await recordMergeReconciliation(writeRequest(root));
      const bytes = readFileSync(receiptPath(root));

      // Every field of the event, one at a time. Each is a real merge; none is
      // the merge already on disk. There is no last-writer-wins rule for
      // contradictory merge identities.
      const contradictions: readonly [string, MergeObservationProof][] = [
        ['another pull request', mintedProof({ number: 63 }, 63)],
        ['another resulting commit', mintedProof({ mergeCommit: OTHER })],
      ];
      for (const [label, proof] of contradictions) {
        const clash = await recordMergeReconciliation(writeRequest(root, { proof }));
        expect(clash.code, label).toBe('CONFLICTING_RECEIPT');
        expect(clash.recorded, label).toBe(false);
        expect(clash.writeAttempt, label).toBe('NOT_ATTEMPTED');
        expect(readFileSync(receiptPath(root)), label).toEqual(bytes);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never replaces something it cannot read', async () => {
    // `MALFORMED`, `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` mean one thing to a
    // writer: there is a document there and this build cannot say what it
    // claims. Replacing it destroys content of unknown value — including, under
    // a future version, a perfectly good receipt from a newer build.
    const unreadable: readonly [string, unknown][] = [
      ['a malformed receipt', { nonsense: true }],
      ['a future version', { ...receiptOf(), reconciliationVersion: 99 }],
      ['another task\'s receipt', receiptOf({ taskId: 'T-002' }, { taskId: 'T-002', repositoryRoot: ROOT })],
    ];
    for (const [label, content] of unreadable) {
      const root = scratch();
      try {
        mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
        writeFileSync(receiptPath(root), JSON.stringify(content), 'utf8');
        const bytes = readFileSync(receiptPath(root));
        const out = await recordMergeReconciliation(writeRequest(root));
        expect(out.code, label).toBe('EXISTING_RECEIPT_UNREADABLE');
        expect(out.writeAttempt, label).toBe('NOT_ATTEMPTED');
        expect(readFileSync(receiptPath(root)), label).toEqual(bytes);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('refuses anything that is not a minted proof, before touching the filesystem', async () => {
    const root = scratch();
    try {
      const forgeries: readonly [string, unknown][] = [
        ['nothing at all', null],
        ['undefined', undefined],
        [
          'a shape-valid object',
          { ...IDENTITY, pullRequestNumber: PR, headSha: HEAD, baseRef: BASE, mergeCommit: RESULT, observedAt: AT },
        ],
        ['a prototype forgery', Object.create(MergeObservationEvidence.prototype) as unknown],
        ['a string', 'MERGED'],
      ];
      for (const [label, proof] of forgeries) {
        const out = await recordMergeReconciliation(writeRequest(root, { proof }));
        expect(out.code, label).toBe('MERGE_NOT_PROVEN');
        expect(out.writeAttempt, label).toBe('NOT_ATTEMPTED');
      }
      // No filesystem effect of ANY kind — not even the directory it would have
      // lived in. The proof is checked before a path is derived.
      expect(readdirSync(join(root, '.agent-orchestrator', 'runtime'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a real merge filed against the wrong task, target or base', async () => {
    const root = scratch();
    try {
      // The proof is genuine every time. What is wrong is the caller's claim
      // about what it is evidence FOR — which the mint alone cannot prevent,
      // because it vouches that a reading happened and never that it was about
      // this task, this commit, this repository or this base.
      const mismatches: readonly [string, Partial<MergeReconciliationWriteRequest>][] = [
        ['another commit', { expectedSubjectCommit: OTHER }],
        ['another host', { expectedHost: 'example.com' }],
        // Two forks can share a commit object name exactly, so identity has to
        // be part of the question rather than assumed to follow from the commit.
        ['another owner', { expectedOwner: 'someone' }],
        ['another repository', { expectedName: 'other-repo' }],
        ['another base branch', { expectedBaseRef: 'release' }],
      ];
      for (const [label, over] of mismatches) {
        const out = await recordMergeReconciliation(writeRequest(root, over));
        expect(out.code, label).toBe('SUBJECT_MISMATCH');
        expect(out.writeAttempt, label).toBe('NOT_ATTEMPTED');
      }
      expect(readdirSync(join(root, '.agent-orchestrator', 'runtime'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('asks Git about both names it writes, and refuses on either answer', async () => {
    for (const [label, verdicts, expected] of [
      ['neither ignored', ['NOT_IGNORED', 'NOT_IGNORED'], 'RUNTIME_PATH_NOT_IGNORED'],
      ['only the staging name ignored', ['IGNORED', 'NOT_IGNORED'], 'RUNTIME_PATH_NOT_IGNORED'],
      ['only the record name ignored', ['NOT_IGNORED', 'IGNORED'], 'RUNTIME_PATH_NOT_IGNORED'],
      ['Git could not say', ['UNDETERMINED', 'IGNORED'], 'RUNTIME_IGNORE_UNDETERMINED'],
      ['Git could not say, second', ['IGNORED', 'UNDETERMINED'], 'RUNTIME_IGNORE_UNDETERMINED'],
    ] as readonly [string, readonly IgnoreVerdict[], MergeReconciliationRecordCode][]) {
      const root = scratch();
      try {
        const asked: string[] = [];
        let index = 0;
        const out = await recordMergeReconciliation(
          writeRequest(root, {
            checkIgnored: async (p) => {
              asked.push(p);
              const v = verdicts[index] ?? 'IGNORED';
              index += 1;
              return v;
            },
          }),
        );
        expect(out.code, label).toBe(expected);
        expect(out.writeAttempt, label).toBe('NOT_ATTEMPTED');
        // Two separate questions, never one call carrying both names:
        // `check-ignore` ORs its arguments, so one call would answer "ignored"
        // whenever EITHER passed — the opposite of the conjunction this needs.
        expect(asked[0], label).toContain('.tmp-probe');
        expect(asked.every((p) => p.includes(MERGE_RECONCILIATION_DIR_NAME)), label).toBe(true);
        expect(readdirSync(join(root, '.agent-orchestrator', 'runtime')), label).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('leaves any previous receipt intact when the replace fails', async () => {
    const root = scratch();
    try {
      await recordMergeReconciliation(writeRequest(root));
      const bytes = readFileSync(receiptPath(root));

      // A torn publication: the staging file is written and flushed, and the
      // move onto the target does not happen. The guarantee is that the previous
      // receipt survives byte-for-byte — which cannot be observed against a real
      // filesystem, because it needs a rename that fails at a chosen moment.
      const torn = await recordMergeReconciliation(
        writeRequest(root, {
          reconciledAt: '2026-08-27T00:00:00.000Z',
          proof: mintedProof({ mergeCommit: OTHER }),
          replace: () => {
            throw Object.assign(new Error('no'), { code: 'EPERM' });
          },
        }),
      );
      // It never reaches the replace: a receipt naming a different merge is
      // refused before anything is staged. That is the stronger guarantee, and
      // asserting the weaker one here would be describing a path this input
      // cannot take.
      expect(torn.code).toBe('CONFLICTING_RECEIPT');
      expect(readFileSync(receiptPath(root))).toEqual(bytes);

      // So the torn-write path is driven where it is actually reachable: a
      // fresh task with no receipt on disk.
      const fresh = scratch();
      try {
        const failed = await recordMergeReconciliation(
          writeRequest(fresh, {
            replace: () => {
              throw Object.assign(new Error('no'), { code: 'EPERM' });
            },
          }),
        );
        expect(failed.code).toBe('WRITE_FAILED');
        expect(failed.recorded).toBe(false);
        expect(failed.writeAttempt).toBe('FAILED');
        // Nothing readable was left standing where the receipt would be.
        expect(
          loadMergeReconciliation(fresh, TASK, { taskId: TASK, repositoryRoot: fresh }).reading,
        ).toBe('ABSENT');
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a missing, torn, oversized or directory-shaped receipt as what it is', () => {
    const root = scratch();
    try {
      const subject = { taskId: TASK, repositoryRoot: root };
      // Nobody wrote one.
      expect(loadMergeReconciliation(root, TASK, subject).reading).toBe('ABSENT');

      mkdirSync(mergeReconciliationDirectory(root), { recursive: true });

      // Truncated mid-document: not a smaller receipt, and not absent.
      //
      // The trailing newline is not cosmetic — it is what the store's own writer
      // emits, and the short-read case below depends on the file's real byte
      // layout. Without it a one-byte-short read cuts the closing brace and is
      // refused by `JSON.parse` rather than by the guard being measured, which
      // is how the first version of that case passed over a build with the guard
      // removed.
      const whole = `${JSON.stringify(receiptOf({ repositoryRoot: root }, subject), null, 2)}
`;
      writeFileSync(receiptPath(root), whole.slice(0, Math.floor(whole.length / 2)), 'utf8');
      expect(loadMergeReconciliation(root, TASK, subject).reading).toBe('MALFORMED');

      // Not JSON at all.
      writeFileSync(receiptPath(root), 'not json', 'utf8');
      expect(loadMergeReconciliation(root, TASK, subject).reading).toBe('MALFORMED');

      // Larger than this build will read back. Refused on the size, before it is
      // parsed, so a record that grew on disk is never parsed at all.
      writeFileSync(receiptPath(root), 'x'.repeat(MAX_MERGE_RECONCILIATION_BYTES + 1), 'utf8');
      expect(loadMergeReconciliation(root, TASK, subject).reading).toBe('MALFORMED');

      // The whole document, correctly bound to THIS root, reads back — so every
      // refusal above is about the bytes and not about the fixture.
      writeFileSync(receiptPath(root), whole, 'utf8');
      expect(loadMergeReconciliation(root, TASK, subject).reading).toBe('HISTORICAL_MERGE');

      // A file that exists and cannot be opened is never reported as one nobody
      // wrote — which would, at the writer, be permission to overwrite it.
      const denied = loadMergeReconciliation(root, TASK, subject, () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      });
      expect(denied.reading).toBe('MALFORMED');

      // A SHORT READ — the file is whole on disk and the read returns fewer
      // bytes than it. Distinct from a truncated file, which the case above
      // covers: here the bytes that arrive are a valid PREFIX of a valid
      // document, so nothing later in the ladder would notice.
      //
      // Reached through an injected read, because a real filesystem serving a
      // small local file does not return early. A counter-proof measured this
      // branch as removable with no test failing before the seam existed —
      // which is what an absence assertion that never reaches the effect looks
      // like.
      let chunks = 0;
      const short = loadMergeReconciliation(
        root,
        TASK,
        subject,
        (p) => openSync(p, 'r'),
        (handle, buffer, offset, length, position) => {
          // ONE BYTE short, then nothing. Both halves of that are load-bearing,
          // and each was measured.
          //
          // "Then nothing": halving every call is not a short read at all — the
          // loop goes round again and ends with the whole document. The stream
          // has to STOP.
          //
          // "One byte": the receipt is JSON followed by a trailing newline, so a
          // read that stops one byte early yields a COMPLETE, VALID, correctly
          // bound document. Every larger shortfall lands mid-JSON and would be
          // refused by `JSON.parse` whatever this guard did — which is exactly
          // what a counter-proof measured, with the guard removed and the suite
          // still green. This is the one shortfall where the guard is the only
          // thing standing between a partial read and `HISTORICAL_MERGE`.
          chunks += 1;
          if (chunks > 1) return 0;
          return readSync(handle, buffer, offset, Math.max(1, length - 1), position);
        },
      );
      expect(chunks).toBeGreaterThan(1);
      expect(short.reading).toBe('MALFORMED');
      expect(short.receipt).toBeNull();

      // The control: the same call with the real read returns the document, so
      // the refusal above is about the short read and not about the seam being
      // supplied at all.
      const full = loadMergeReconciliation(root, TASK, subject, (p) => openSync(p, 'r'), readSync);
      expect(full.reading).toBe('HISTORICAL_MERGE');

      // A FAILURE AFTER A SUCCESSFUL OPEN IS NEVER "NOBODY WROTE ONE".
      //
      // This is the guarantee the writer depends on, and the direction of the
      // failure is what makes it matter: `ABSENT` is the single reading that
      // grants `recordMergeReconciliation` permission to write over the path, so
      // a reader that answers it for a file it could not finish reading would
      // hand a receipt's destruction to a transient error.
      //
      // A review found the inner catch mapping an ENOENT-coded throw to
      // `ABSENT`, mirroring the outer one — where it is correct, because there
      // the open itself failed. Here the open has already succeeded, so
      // something IS on that path whatever errno arrives afterwards. The mutant
      // that restores the errno test survived the suite until this case existed.
      for (const code of ['ENOENT', 'EACCES', 'EIO']) {
        const afterOpen = loadMergeReconciliation(
          root,
          TASK,
          subject,
          (p) => openSync(p, 'r'),
          () => {
            throw Object.assign(new Error('late'), { code });
          },
        );
        expect(afterOpen.reading, code).toBe('MALFORMED');
        expect(afterOpen.reading, code).not.toBe('ABSENT');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an oversized receipt that is otherwise perfectly well formed', () => {
    // The reader's size gate, reached by the one input that isolates it.
    //
    // This case replaces one that asserted the gate was EQUIVALENT — "no
    // schema-valid receipt can exceed the budget, so any file over it fails a
    // later gate anyway". A review measured that false, and the measurement is
    // worth keeping: the schema bounds fields in CHARACTERS and the budget is in
    // BYTES. A `repositoryRoot` of 4096 non-ASCII characters, or of 4096
    // backslashes (each of which JSON-escapes to two), is schema-valid and
    // encodes to well over 8192 bytes. Insignificant JSON whitespace does it
    // too, and is the easiest to reach.
    //
    // So the gate is not equivalent, it is load-bearing, and the previous
    // classification of the mutant that removes it was wrong.
    // A repository root of 4000 characters outside the Basic Latin range. Each
    // is three bytes in UTF-8 and JSON keeps it literal, so the field is
    // comfortably inside the schema's 4096-CHARACTER bound and the encoded
    // document is comfortably over the 8192-BYTE budget. That gap is the whole
    // finding.
    const longRoot = `D:\\${'\u4e2d'.repeat(4000)}`;
    const subject = { taskId: TASK, repositoryRoot: longRoot };
    const oversized = receiptOf({ repositoryRoot: longRoot }, subject);

    // It really is a receipt this build would otherwise accept: strict-valid,
    // current version, correctly bound to the subject it names.
    expect(MergeReconciliationSchema.safeParse(oversized).success).toBe(true);
    expect(readMergeReconciliation(oversized, subject)).toBe('HISTORICAL_MERGE');

    const encoded = `${JSON.stringify(oversized, null, 2)}\n`;
    expect(Buffer.byteLength(encoded, 'utf8')).toBeGreaterThan(MAX_MERGE_RECONCILIATION_BYTES);
    // And under the budget as CHARACTERS, which is what makes this a byte/char
    // confusion rather than an oversized document by any measure.
    expect(oversized['repositoryRoot']).toHaveLength(4003);

    const root = scratch();
    try {
      mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
      writeFileSync(receiptPath(root), encoded, 'utf8');
      // The path comes from the real scratch root; the binding from the long one.
      // Only the size gate stands between this file and HISTORICAL_MERGE, which
      // the line above proved it reads as when handed the same bytes directly.
      expect(loadMergeReconciliation(root, TASK, subject).reading).toBe('MALFORMED');

      // The control: the same document with an ordinary root reads back, so the
      // refusal above is about the size and not about the fixture.
      const ordinary = { taskId: TASK, repositoryRoot: root };
      writeFileSync(
        receiptPath(root),
        `${JSON.stringify(receiptOf({ repositoryRoot: root }, ordinary), null, 2)}\n`,
        'utf8',
      );
      expect(loadMergeReconciliation(root, TASK, ordinary).reading).toBe('HISTORICAL_MERGE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces a receipt inside its own size budget', async () => {
    const root = scratch();
    try {
      await recordMergeReconciliation(writeRequest(root));
      const size = readFileSync(receiptPath(root)).byteLength;
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(MAX_MERGE_RECONCILIATION_BYTES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores no raw forge output, no credential and no free text', async () => {
    const root = scratch();
    try {
      await recordMergeReconciliation(writeRequest(root));
      const text = readFileSync(receiptPath(root), 'utf8');
      // Enforced by the shape rather than by a filter: the payload can only be
      // built from `MergeObservationFacts`, which has no field any of these
      // could travel in. Asserted anyway, because that argument is only as good
      // as the shape staying that way.
      for (const banned of ['Authorization', 'token', 'stderr', 'exitCode', 'https://', 'gh ']) {
        expect(text, banned).not.toContain(banned);
      }
      // And the field set is exactly what is declared — no branch name, no task
      // state, no state revision.
      expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(
        [...Object.keys(payloadOf()), 'binding'].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('converges when two reconcilers of the same merge run together', async () => {
    const root = scratch();
    try {
      // Read-before-write is not a transaction, and this file says so rather
      // than claiming otherwise. What it must guarantee is that two reconcilers
      // of the SAME merge converge on a receipt that names that merge — never
      // that one of them is refused.
      const results = await Promise.all([
        recordMergeReconciliation(writeRequest(root)),
        recordMergeReconciliation(writeRequest(root, { reconciledAt: '2026-08-26T00:00:00.000Z' })),
      ]);
      for (const r of results) {
        expect(['RECORDED', 'ALREADY_RECORDED']).toContain(r.code);
      }
      const back = loadMergeReconciliation(root, TASK, { taskId: TASK, repositoryRoot: root });
      expect(back.reading).toBe('HISTORICAL_MERGE');
      expect(back.receipt?.pullRequestNumber).toBe(PR);
      expect(back.receipt?.mergeCommit).toBe(RESULT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names three write attempts, and only one of them touched the path', () => {
    expect([...WRITE_ATTEMPTS]).toEqual(['NOT_ATTEMPTED', 'COMPLETED', 'FAILED']);
  });
});

// ── 5. The command: one flag, read-only on the forge ───────────────────────

describe('the delivery command reconciles only when asked, and mutates nothing remote', () => {
  const DECLARED: ResolvedDelivery = Object.freeze({
    declared: true as const,
    remoteName: REMOTE,
    result: Object.freeze({ outcome: 'RESOLVED' as const, target: IDENTITY }),
  });

  function taskState(over: Record<string, unknown> = {}, root = ROOT): StateLoadResult {
    return {
      ok: true,
      revision: REV,
      state: {
        schemaVersion: 1,
        taskId: TASK,
        repositoryId: 'repo',
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
      },
    } as unknown as StateLoadResult;
  }

  async function run(
    argv: readonly string[],
    over: {
      readonly locator?: string | null;
      readonly document?: string | null;
      readonly state?: StateLoadResult;
      readonly delivery?: ResolvedDelivery;
      /**
       * Drive the REAL ignore probe instead of stubbing its verdict.
       *
       * Every other case supplies `checkIgnored`, which is the right seam for
       * the store's own refusals and the wrong one for measuring what the
       * command layer actually starts. With this set, `checkIgnored` is left
       * absent and a counting `git` seam is supplied in its place.
       */
      readonly countGit?: boolean;
    } = {},
  ): Promise<{
    out: string;
    reader: Reads;
    mutations: number;
    receipt: string | null;
    runtimeAfter: readonly string[];
    gitCalls: string[][];
    /**
     * The exit code this invocation set, captured and restored.
     *
     * Returned by the harness rather than read from `process.exitCode` at the
     * call site, so a case cannot accidentally observe a code some earlier run
     * left behind — which is how the round-2 exit-code assertion came to measure
     * something other than what it named.
     */
    exitCode: number | undefined;
  }> {
    const root = mkdtempSync(join(tmpdir(), 'ao-v408-cli-'));
    mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
    const reader = reads({
      ...(over.locator === undefined ? {} : { locator: over.locator }),
      ...(over.document === undefined ? {} : { document: over.document }),
    });
    // All three forge-mutation seams are supplied and counted. A reconciliation
    // that reached any of them would be visible as a number rather than argued
    // about in a comment.
    let mutations = 0;
    const gitCalls: string[][] = [];
    const countingGit = async (_cwd: string, args: readonly string[]) => {
      gitCalls.push([...args]);
      // `check-ignore --quiet` exits 0 for an ignored path. Answering that keeps
      // the write path reachable, so the count below is of a run that completed
      // rather than one that stopped at the probe.
      return { outcome: 'OK' as const, exitCode: 0, stdout: '', stderr: '' };
    };
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
            repository: { id: 'repo', root, delivery: over.delivery ?? DECLARED },
          }) as unknown as Awaited<
            ReturnType<typeof import('../src/repo/resolve-repository.js').resolveRepository>
          >,
        loadTaskState: () => over.state ?? taskState({}, root),
        runner: reader.runner,
        mergeRunner: async () => {
          mutations += 1;
          return commandResult();
        },
        creationRunner: async () => {
          mutations += 1;
          return commandResult();
        },
        publicationRunner: (async () => {
          mutations += 1;
          return commandResult();
        }) as unknown as GitPublicationRunner,
        envSource: ENV,
        now: () => new Date(AT),
        ...(over.countGit === true
          ? { git: countingGit as never }
          : { checkIgnored: async () => 'IGNORED' as never }),
      });
      await program.parseAsync([
        'node',
        'x',
        'delivery',
        '--repository',
        root,
        '--task',
        TASK,
        ...argv,
      ]);
    } finally {
      write.mockRestore();
    }
    const exitCode = process.exitCode;
    process.exitCode = outerExitCode;
    const path = join(mergeReconciliationDirectory(root), `${TASK}.json`);
    let receipt: string | null = null;
    try {
      receipt = readFileSync(path, 'utf8');
    } catch {
      receipt = null;
    }
    const runtimeAfter = readdirSync(join(root, '.agent-orchestrator', 'runtime'));
    rmSync(root, { recursive: true, force: true });
    return { out: chunks.join(''), reader, mutations, receipt, runtimeAfter, gitCalls, exitCode };
  }

  it('reconciles when everything holds, and reports the commit the merge produced', async () => {
    const r = await run(['--reconcile-merge']);
    expect(r.out).toContain('Merge observed: MERGE_OBSERVED');
    expect(r.out).toContain(`Pull request : #${String(PR)}`);
    expect(r.out).toContain('Receipt      : RECORDED  (write: COMPLETED)');
    expect(r.out).toContain(RESULT);
    expect(r.receipt).not.toBeNull();
    expect(r.runtimeAfter).toContain(MERGE_RECONCILIATION_DIR_NAME);

    // Two reads, no mutation, on any of the three seams that could make one.
    expect(r.reader.calls).toHaveLength(2);
    expect(r.mutations).toBe(0);
  });

  it('writes nothing at all without the flag, having contacted nothing', async () => {
    const r = await run([]);
    expect(r.receipt).toBeNull();
    expect(r.runtimeAfter).toEqual([]);
    expect(r.reader.calls).toHaveLength(0);
    expect(r.mutations).toBe(0);
    // And the report does not mention a reconciliation that did not happen.
    expect(r.out).not.toContain('Merge observed');
    expect(r.out).not.toContain(RECONCILIATION_TRAILER);
  });

  it('does not reconcile on any other flag, however much it reads', async () => {
    // The reachability case for "the write is gated on THIS flag". A run with
    // `--observe` contacts the forge and settles an observation, and a run with
    // `--record` writes a record — and neither may produce a merge receipt.
    //
    // Written because the no-flag case above cannot reach the mutant that
    // matters: swapping the gate to `options.observe` leaves a bare run writing
    // nothing either way, so that case passes over a build whose receipt is
    // written by the read-only flag. Measured, not assumed.
    for (const argv of [['--observe'], ['--observe', '--record'], ['--observe', '--decide']]) {
      const r = await run(argv);
      expect(r.receipt, argv.join(' ')).toBeNull();
      expect(r.runtimeAfter, argv.join(' ')).not.toContain(MERGE_RECONCILIATION_DIR_NAME);
      expect(r.out, argv.join(' ')).not.toContain('Merge observed');
      expect(r.mutations, argv.join(' ')).toBe(0);
    }
    // The positive control: `--observe --record` really does write something, so
    // the assertions above measure the absence of a RECEIPT and not the absence
    // of any write at all.
    const recorded = await run(['--observe', '--record']);
    expect(recorded.runtimeAfter.length).toBeGreaterThan(0);
  });

  it('is idempotent through the command, and says so', async () => {
    // Driven end to end rather than at the store, because the idempotency an
    // operator meets is the one the command performs.
    const root = mkdtempSync(join(tmpdir(), 'ao-v408-idem-'));
    mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
    try {
      const once = await recordMergeReconciliation({
        repositoryRoot: root,
        taskId: TASK,
          expectedSubjectCommit: HEAD,
        expectedHost: IDENTITY.host,
        expectedOwner: IDENTITY.owner,
        expectedName: IDENTITY.name,
        expectedBaseRef: BASE,
        proof: mintedProof(),
        reconciledAt: AT,
        checkIgnored: async () => 'IGNORED' as IgnoreVerdict,
      });
      expect(once.code).toBe('RECORDED');
      const bytes = readFileSync(
        join(mergeReconciliationDirectory(root), `${TASK}.json`),
        'utf8',
      );
      const again = await recordMergeReconciliation({
        repositoryRoot: root,
        taskId: TASK,
          expectedSubjectCommit: HEAD,
        expectedHost: IDENTITY.host,
        expectedOwner: IDENTITY.owner,
        expectedName: IDENTITY.name,
        expectedBaseRef: BASE,
        proof: mintedProof(),
        reconciledAt: '2026-08-27T00:00:00.000Z',
        checkIgnored: async () => 'IGNORED' as IgnoreVerdict,
      });
      expect(again.code).toBe('ALREADY_RECORDED');
      expect(
        readFileSync(join(mergeReconciliationDirectory(root), `${TASK}.json`), 'utf8'),
      ).toBe(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a task that has not finished, before contacting anything', async () => {
    const r = await run(['--reconcile-merge'], { state: taskState({ state: 'REVIEWING' }) });
    expect(r.out).toContain('Merge observed: TASK_NOT_READY');
    expect(r.reader.calls).toHaveLength(0);
    expect(r.receipt).toBeNull();
    expect(r.runtimeAfter).toEqual([]);
  });

  it('writes nothing when the forge does not establish a merge', async () => {
    for (const [label, over] of [
      ['still open', { locator: candidates([{ state: 'open' }]) }],
      ['closed, not merged', { document: prBody({ merged: false }) }],
      ['no pull request', { locator: '[]' }],
      ['the forge refused', { locator: null }],
    ] as readonly [string, { locator?: string | null; document?: string | null }][]) {
      const r = await run(['--reconcile-merge'], over);
      expect(r.receipt, label).toBeNull();
      expect(r.runtimeAfter, label).toEqual([]);
      expect(r.out, label).toContain('Receipt      : not written');
      expect(r.mutations, label).toBe(0);
    }
  });

  it('needs no --attended, and no --observe, and no --decide', async () => {
    // Each of the three is required by something else on this surface, and none
    // of them is required by this. `--attended` marks a person present for an
    // irreversible effect OUTSIDE this machine, and this has none.
    const r = await run(['--reconcile-merge']);
    expect(r.out).toContain('Merge observed: MERGE_OBSERVED');
    expect(r.receipt).not.toBeNull();
  });

  it('reconciles a merge nobody here performed, and never claims otherwise', async () => {
    // No grant is held, none was ever minted in this process, and the merge was
    // performed by somebody else — which is the ordinary recovery case, not an
    // edge one. The report must say the pull request is merged and must not say
    // who merged it.
    const r = await run(['--reconcile-merge']);
    expect(r.out).toContain('MERGE_OBSERVED');
    expect(r.out).toContain(MERGE_PRESENCE_SENTENCE);
    for (const claim of [
      'AO merged',
      'this build merged',
      'merged by this invocation',
      'this invocation merged',
    ]) {
      expect(r.out, claim).not.toContain(claim);
    }
  });

  it('prints the presence sentence and its own trailer, and stays read-only on the forge', async () => {
    const r = await run(['--reconcile-merge']);
    expect(r.out).toContain(MERGE_PRESENCE_SENTENCE);
    expect(r.out).toContain(RECONCILIATION_TRAILER);
    // Not "Read-only." full stop: this run writes a file, and a trailer opening
    // with the bare word would be false in the direction that matters to an
    // auditor.
    expect(RECONCILIATION_TRAILER.startsWith('Read-only on the forge')).toBe(true);

    // Every clause is a BOUND, not an act. The trailer is printed for all ten
    // ladder outcomes, including two that start no process and four that never
    // address a pull request, so a sentence saying what the run *did* is false
    // on most of them — which a review measured on the first version of this
    // string. Pinned as an absence, because the failure mode is a past tense
    // creeping back in.
    for (const act of [
      'The reconciliation asked github.com',
      'and it changed\nnothing there',
      'this task is still READY_FOR_PR',
      'it changed at most',
      'and not read-only here',
    ]) {
      expect(RECONCILIATION_TRAILER, act).not.toContain(act);
    }
    expect(RECONCILIATION_TRAILER).toContain('A reconciliation asks');
    // Not "the one named above": on SUBJECT_NOT_ESTABLISHED the report prints no
    // Subject line at all, so a review found the phrase pointing at nothing.
    // And not "asks about one commit" either — a confirmation pointed out that
    // asserts a request the two caller-owned refusals never make. Naming the
    // referent without asserting the act is what both findings leave standing.
    expect(RECONCILIATION_TRAILER).toContain("about no commit but this task's own");
    expect(RECONCILIATION_TRAILER).not.toContain('the one named above');
    expect(RECONCILIATION_TRAILER).toContain('It changes nothing there');
    // The opening is a CAPABILITY, not an act. The first repair here said "and
    // not read-only here", which claims a write on the eleven report shapes
    // where nothing was written — the same mistake one clause further along.
    expect(RECONCILIATION_TRAILER).toContain('not necessarily read-only here');
    expect(RECONCILIATION_TRAILER).toContain('says whether this run did');
    // The directory the write creates is an effect too, and the first version
    // omitted it while claiming "at most one file".
    // The effects clause names all three things a write creates. A review found
    // the previous "one file … and the directory holding it — nothing else"
    // omitting the staging file — which the store's own comment says a crash can
    // leave behind, and which it asks Git about for exactly that reason.
    expect(RECONCILIATION_TRAILER).toContain('one directory, one receipt beside the task');
    expect(RECONCILIATION_TRAILER).toContain('a staging file');
    expect(RECONCILIATION_TRAILER).not.toContain('nothing else');
  });

  it('never contradicts itself in the trailer block', async () => {
    // A run that wrote must not open its trailers with the bare word
    // "Read-only." two paragraphs above "not read-only here". A review found
    // exactly that, and the new trailer's own docblock names avoiding it as its
    // reason for existing.
    const wrote = await run(['--reconcile-merge']);
    expect(wrote.receipt).not.toBeNull();
    expect(wrote.out).toContain(RECONCILIATION_TRAILER);
    expect(wrote.out).not.toContain(CONTACTED_TRAILER);
    expect(wrote.out).not.toContain('Read-only. ');
    // The L-V4-02-6 disclosure — the GitHub CLI's own telemetry and update
    // calls — still has to survive, which is what that branch previously
    // carried. It is the one sentence that must not be lost by dropping the
    // read-only framing.
    expect(wrote.out).toContain(OBSERVED_AND_CHANGED_TRAILER);

    // A run that established nothing and wrote nothing IS read-only, and says
    // so — so the rule above is about the write and not about the flag.
    const refused = await run(['--reconcile-merge'], { state: taskState({ state: 'REVIEWING' }) });
    expect(refused.receipt).toBeNull();
    expect(refused.out).toContain(NOT_CONTACTED_TRAILER);
  });

  it('claims a merge only where one was established', async () => {
    // MERGE_PRESENCE_SENTENCE caveats a merge. A review found it printed under
    // NO_PULL_REQUEST_AT_HEAD and NOT_MERGED, asserting "this pull request was
    // merged and produced this commit" directly beneath a line saying the
    // opposite.
    for (const [label, over] of [
      ['no pull request', { locator: '[]' }],
      ['still open', { locator: candidates([{ state: 'open' }]) }],
      ['closed, not merged', { document: prBody({ merged: false }) }],
      ['the forge refused', { locator: null }],
    ] as readonly [string, { locator?: string | null; document?: string | null }][]) {
      const r = await run(['--reconcile-merge'], over);
      expect(r.out, label).not.toContain(MERGE_PRESENCE_SENTENCE);
      // The trailer still prints — it is about the run, not about a merge.
      expect(r.out, label).toContain(RECONCILIATION_TRAILER);
    }
    // And on a refusal that never reached the forge at all.
    const notReady = await run(['--reconcile-merge'], { state: taskState({ state: 'REVIEWING' }) });
    expect(notReady.out).not.toContain(MERGE_PRESENCE_SENTENCE);

    // The positive control: where a merge WAS established, the sentence is
    // there — including on the repeat run, which writes nothing and needs the
    // caveat exactly as much.
    expect((await run(['--reconcile-merge'])).out).toContain(MERGE_PRESENCE_SENTENCE);
  });

  it('never reports this flag in its exit code, whatever the reconciliation did', async () => {
    // Third statement of this, and the first that is not a value claim.
    //
    // Round 1 said "a refusal to write exits zero". Round 2 corrected that to
    // "on its own this exits zero however the reconciliation ended, and with
    // --observe it reports that observation" — and a narrow confirmation
    // MEASURED that false too: `--reconcile-merge` on its own exits 2 whenever
    // the subject cannot be established, because `concludeObservation` tests
    // `!subject.ok` BEFORE it tests whether anything was observed, and
    // `exitCodeFor` runs unconditionally. `--observe` has nothing to do with it.
    //
    // The claim that survives is structural rather than numeric: the exit code
    // is computed from the observation conclusion, and the reconciliation result
    // never reaches it. That is what this case measures, and it is why the
    // sentence no longer names a number.
    const before = process.exitCode;
    try {
      // Same subject failure, with and without `--observe`. Identical, which is
      // what makes the round-2 assertion a co-occurrence control: it passed
      // `--observe` and attributed to it an exit code that has another cause.
      const withoutObserve = await run(['--reconcile-merge'], {
        delivery: { declared: false } as never,
      });
      const withObserve = await run(['--observe', '--reconcile-merge'], {
        delivery: { declared: false } as never,
      });
      expect(withoutObserve.exitCode).toBe(withObserve.exitCode);
      expect(withoutObserve.exitCode).not.toBe(0);

      // And with a subject that resolves, the exit code is zero across
      // reconciliation outcomes that differ from each other in every way that
      // matters to an operator — a merge recorded, no pull request at the head,
      // and a forge that refused. If the reconciliation reached the exit code at
      // all, these three could not agree.
      const recorded = await run(['--reconcile-merge']);
      const none = await run(['--reconcile-merge'], { locator: '[]' });
      const refused = await run(['--reconcile-merge'], { locator: null });
      expect(recorded.receipt).not.toBeNull();
      expect(none.receipt).toBeNull();
      expect(refused.receipt).toBeNull();
      for (const r of [recorded, none, refused]) {
        expect(r.exitCode).toBe(0);
      }
    } finally {
      process.exitCode = before;
    }

    // And the operator is told, on the surface they read before running it —
    // without a number, because the number is not this flag's to promise.
    expect(RECONCILE_MERGE_OPTION_DESCRIPTION).toContain(
      'never reports this flag, so a refused write is not visible in it',
    );
    expect(RECONCILE_MERGE_OPTION_DESCRIPTION).not.toContain('exits zero');
  });

  it('says nothing was contacted only when nothing was', async () => {
    // Derived from the ladder's own flag. A locator read that refused leaves
    // every other field null while a process really ran, so a report deriving
    // egress from those fields would say nothing was contacted when something
    // was — and this is the case that measures it.
    //
    // RESTORED after a confirmation found it silently deleted by an edit that
    // rewrote the case above it. The deletion changed no behaviour and broke no
    // test, which is exactly why it was invisible: what it cost was a KILL.
    // Mutating `reconcile-merge.ts`'s locator-refusal arm from
    // `outcome('FORGE_UNREADABLE', true)` to `false` survives the whole suite
    // without this case, and with it the report prints "No forge was contacted"
    // over a run that started a process and drops the L-V4-02-6 disclosure
    // entirely — the class review round 1 is named after.
    const refused = await run(['--reconcile-merge'], { locator: null });
    expect(refused.reader.calls).toHaveLength(1);
    expect(refused.out).toContain('Read-only.');
    expect(refused.out).not.toContain('No forge was contacted');
    // And the disclosure that a contacting run owes is present, which is the
    // half of the mutant's damage the three assertions above do not name.
    expect(refused.out).toContain('L-V4-02-6');
  });

  it('starts exactly two forge reads and two Git queries, and nothing else', async () => {
    // The command-layer measurement, and the reason the source scan below is no
    // longer named as though it were one.
    //
    // A review pointed out that a token scan of two `src/deliver` modules cannot
    // see what the CLI starts — and that the write path really does launch two
    // `git check-ignore` processes against the operator's checkout, through a
    // seam every other case here stubs out. Both are read-only and harmless; the
    // defect was a test whose name asserted a property it never measured.
    const r = await run(['--reconcile-merge'], { countGit: true });
    expect(r.receipt).not.toBeNull();

    // Two reads of the forge, and no mutation on any of the three seams.
    expect(r.reader.calls).toHaveLength(2);
    expect(r.mutations).toBe(0);

    // Two Git queries, both read-only, both `check-ignore`, and both about the
    // two names this write creates. No other Git command runs at all.
    expect(r.gitCalls).toHaveLength(2);
    for (const args of r.gitCalls) {
      expect(args[0]).toBe('check-ignore');
      expect(args).toContain('--quiet');
      expect(args.some((a) => a.includes(MERGE_RECONCILIATION_DIR_NAME))).toBe(true);
    }
    // One asks about the staging shape and one about the record itself — the
    // conjunction the store's header explains, measured rather than assumed.
    expect(r.gitCalls.filter((a) => a.some((x) => x.endsWith('.tmp-probe')))).toHaveLength(1);
    expect(
      r.gitCalls.filter((a) => a.some((x) => x.endsWith(`${TASK}.json`))),
    ).toHaveLength(1);
  });

  it('registers exactly the sentence that was pinned, not a copy', () => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const option = (delivery?.options ?? []).find((o) => o.long === '--reconcile-merge');
    expect(option?.description).toBe(RECONCILE_MERGE_OPTION_DESCRIPTION);
    // The five words that name an override of a refusal stay forbidden, and this
    // name carries none of them.
    expect(option?.long ?? '').not.toMatch(/force|unattended|adopt|takeover|steal/i);
  });

  it('says on the surface what the receipt is and is not', () => {
    for (const phrase of [
      'changing nothing there',
      'never from a stored number and never from one you name',
      'it never claims AO did it',
      'refuses rather than being\noverwritten'.replace('\n', ' '),
      'It is not a claim that the commit is on the base branch now',
      'the task is still READY_FOR_PR afterwards',
    ]) {
      expect(RECONCILE_MERGE_OPTION_DESCRIPTION, phrase).toContain(phrase);
    }
    // The command's own paragraph names the new flag and stops claiming that
    // one flag is the only thing that writes.
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--reconcile-merge');
    // "on THIS machine" is load-bearing, and a review is why. The previous
    // wording said "the flags that write anything at all", which is false of the
    // three flags the same paragraph has just described as changing something on
    // a forge — they write, just not here.
    // "write a record here", not "write anything". A confirmation pointed out
    // that the previous repair swapped one unmeasurable absolute for another:
    // --publish-head pushes, and a push updates a remote-tracking ref and its
    // reflog inside .git. What this build can stand behind is which flags write
    // a RECORD, which is what the sentence now says.
    // Third rewording of this one sentence, and the first that is not about
    // accuracy: V4 slice 9 added `--verify-merge`, which writes a record here
    // too, so an enumeration naming two was simply out of date.
    //
    // What is pinned is therefore the PROPERTY rather than the spelling. The
    // exact string used to be asserted, and the cost of that showed up
    // immediately — a new flag broke *this case* rather than the sentence it
    // had invalidated, which is a pin measuring a wording. The clause must name
    // this slice's flag among the record-writers; how many others it names is
    // not slice 8's business, and that the paragraph names **every** registered
    // act flag is asserted once, in
    // `tests/v4-09-post-merge-verification.test.ts`.
    expect(DELIVERY_COMMAND_DESCRIPTION).toMatch(
      /flag here that writes a record[^.]*--reconcile-merge/,
    );
    expect(DELIVERY_COMMAND_DESCRIPTION).not.toContain('write anything');
    // And the observe sentence no longer enumerates which flags can change
    // something — a list that went stale for a whole slice before this one.
    expect(OBSERVE_OPTION_DESCRIPTION).not.toContain(
      'The flags that can change something are',
    );
  });

  it('closes every reachable report shape without contradicting itself', () => {
    // The trailer block, enumerated over the WHOLE ladder vocabulary rather than
    // sampled. Two review rounds and one hand enumeration all found the same
    // class of defect here — a sentence stating an act on a path where the act
    // did not happen — and each time the previous fix had moved the problem one
    // clause along rather than closing it. A table is what stops that.
    //
    // Three properties, checked on every shape:
    //   1. the bare word "Read-only." appears only where the run really was;
    //   2. the L-V4-02-6 disclosure — the GitHub CLI's own telemetry and update
    //      traffic — appears wherever a forge was contacted, and is never lost;
    //   3. the merge-presence caveat appears only where a merge was established.
    const shape = (
      outcome: MergeObservationOutcome,
      contacted: boolean,
      record: { code: string; writeAttempt: string } | null,
    ) =>
      renderDeliveryObservation({
        repositoryId: 'repo',
        repositoryRoot: ROOT,
        taskId: TASK,
        subject: { ok: false, refusal: 'DELIVERY_NOT_DECLARED' } as never,
        observation: null,
        conclusion: 'SUBJECT_NOT_ESTABLISHED',
        reconciliation: {
          result: {
            outcome,
            pullRequestNumber: contacted ? PR : null,
            reading: outcome === 'MERGE_OBSERVED' ? reading() : null,
            proof: null,
            contacted,
          },
          record:
            record === null
              ? null
              : ({ ...record, recorded: record.code === 'RECORDED', path: 'p', errnoCode: null } as never),
        },
      });

    // The two members the caller owns never contact anything; every other member
    // of the ladder is reached only after a request.
    const CALLER_OWNED: readonly string[] = ['SUBJECT_NOT_ESTABLISHED', 'TASK_NOT_READY'];
    type Shape = readonly [
      string,
      MergeObservationOutcome,
      boolean,
      { readonly code: string; readonly writeAttempt: string } | null,
    ];
    const shapes: readonly Shape[] = [
      ...MERGE_OBSERVATIONS.map(
        (o): Shape => [
          `ladder:${o}`,
          o,
          !CALLER_OWNED.includes(o),
          o === 'MERGE_OBSERVED' ? { code: 'RECORDED', writeAttempt: 'COMPLETED' } : null,
        ],
      ),
      // The three ways a merge can be established and the write still not
      // happen. These are the shapes the first repair got wrong.
      ['already recorded', 'MERGE_OBSERVED', true, { code: 'ALREADY_RECORDED', writeAttempt: 'NOT_ATTEMPTED' }],
      ['conflicting receipt', 'MERGE_OBSERVED', true, { code: 'CONFLICTING_RECEIPT', writeAttempt: 'NOT_ATTEMPTED' }],
      ['write failed', 'MERGE_OBSERVED', true, { code: 'WRITE_FAILED', writeAttempt: 'FAILED' }],
    ];

    // All three write attempts are represented, so the table measures the
    // distinction the gate turns on rather than one arm of it.
    for (const attempt of WRITE_ATTEMPTS) {
      expect(
        shapes.some(([, , , record]) => record?.writeAttempt === attempt),
        attempt,
      ).toBe(true);
    }

    // The table is BUILT from the vocabulary, so an assertion that it merely
    // covers the vocabulary is tautological and a confirmation named the old one
    // as such. What replaces it is a control that can actually fail: the outcomes
    // the table carries are compared against the vocabulary itself, so building
    // it from a SLICE — the drift the tautological assertion did incidentally
    // guard, measured — is refused here.
    expect(
      shapes.filter(([label]) => label.startsWith('ladder:')).map(([, outcome]) => outcome),
    ).toEqual([...MERGE_OBSERVATIONS]);

    // The loop below is a second control, and a narrower one than its first
    // description claimed: `NOT_ATTEMPTED` is carried by two shapes, so dropping
    // either of those leaves it green. Dropping the `write failed` shape is what
    // makes it fail — and that is the shape the corrected gate turns on.

    for (const [label, outcome, contacted, record] of shapes) {
      const out = shape(outcome, contacted, record);
      // An ATTEMPT, not a success. A write that failed still created the
      // receipt's directory and staged a file beside the target, so it is not a
      // read-only run — a review measured the previous `=== 'COMPLETED'`
      // describing one as though it were.
      const wrote = record !== null && record.writeAttempt !== 'NOT_ATTEMPTED';
      const merged = outcome === 'MERGE_OBSERVED';

      // 1. The bare word, and only where it is true.
      expect(/(^|\n)Read-only\. /.test(out), `${label}: bare Read-only.`).toBe(!wrote);
      // The trailer never claims a write it did not make. Its opening is a
      // capability — "not NECESSARILY read-only here" — for exactly this reason.
      expect(out, label).not.toContain('and not read-only here');

      // 2. The disclosure survives wherever a forge was contacted.
      expect(out.includes('L-V4-02-6'), `${label}: egress disclosure`).toBe(contacted);

      // 3. The caveat, only where there is a merge to caveat.
      expect(out.includes(MERGE_PRESENCE_SENTENCE), `${label}: presence sentence`).toBe(merged);

      // And the trailer itself is always there — it is about the run, not about
      // the outcome.
      expect(out, label).toContain(RECONCILIATION_TRAILER);
      // No run of blank lines from the conditional separator.
      expect(/\n\n\n\n/.test(out), `${label}: blank-line run`).toBe(false);
    }

    // The shape the table above cannot reach: a run that ALSO attempted a forge
    // act, which selects the other branch entirely.
    //
    // Found by enumeration rather than by review, and it was a real hole. Until
    // this slice, "an observation ran" and "the GitHub CLI ran" were the same
    // thing on that branch — the two acts that need `gh` both require
    // `--observe`, and the publication runs Git. `--publish-head --attended
    // --reconcile-merge` takes that branch with no observation and runs `gh`
    // twice, and the L-V4-02-6 egress disclosure was silently dropped.
    const alsoMerged = renderDeliveryObservation({
      repositoryId: 'repo',
      repositoryRoot: ROOT,
      taskId: TASK,
      subject: { ok: false, refusal: 'DELIVERY_NOT_DECLARED' } as never,
      observation: null,
      conclusion: 'SUBJECT_NOT_ESTABLISHED',
      merge: {
        result: {
          outcome: 'MERGED',
          before: reading(),
          attempt: 'COMPLETED',
          after: reading(),
          mergeCommit: RESULT,
        },
        pullRequestNumber: PR,
        baseRef: BASE,
      } as never,
      reconciliation: {
        result: {
          outcome: 'MERGE_OBSERVED',
          pullRequestNumber: PR,
          reading: reading(),
          proof: null,
          contacted: true,
        },
        record: {
          code: 'RECORDED',
          recorded: true,
          writeAttempt: 'COMPLETED',
          path: 'p',
          errnoCode: null,
        },
      } as never,
    });
    expect(alsoMerged).toContain('L-V4-02-6');
    expect(alsoMerged).toContain(MERGE_TRAILER);
    expect(alsoMerged).toContain(RECONCILIATION_TRAILER);
    expect(/(^|\n)Read-only\. /.test(alsoMerged)).toBe(false);
    expect(/\n\n\n\n/.test(alsoMerged)).toBe(false);
    // The disclosure appears once, not twice, when both routes would owe it.
    expect(alsoMerged.split('L-V4-02-6')).toHaveLength(2);
  });

  it('renders the two answers separately, because they can disagree', () => {
    // A merge established and a write refused is the case an operator has to act
    // on, and a single word for both would hide it.
    const out = renderDeliveryObservation({
      repositoryId: 'repo',
      repositoryRoot: ROOT,
      taskId: TASK,
      subject: { ok: false, refusal: 'DELIVERY_NOT_DECLARED' } as never,
      observation: null,
      conclusion: 'SUBJECT_NOT_ESTABLISHED',
      reconciliation: {
        result: {
          outcome: 'MERGE_OBSERVED',
          pullRequestNumber: PR,
          reading: reading(),
          proof: mintedProof(),
          contacted: true,
        },
        record: {
          code: 'CONFLICTING_RECEIPT',
          recorded: false,
          writeAttempt: 'NOT_ATTEMPTED',
          path: 'p',
          errnoCode: null,
        },
      },
    });
    expect(out).toContain('Merge observed: MERGE_OBSERVED');
    expect(out).toContain('Receipt      : CONFLICTING_RECEIPT  (write: NOT_ATTEMPTED)');
  });
});

// ── 6. What this slice does NOT touch ──────────────────────────────────────

describe('the execution lifecycle is untouched, and the block ledger with it', () => {
  it('leaves READY_FOR_PR terminal, with no outgoing transition and no new state', () => {
    // The architectural decision, stated as an assertion. This slice deliberately
    // does not extend `TaskState`: block settlement re-proves itself against the
    // task file's exact BYTES, so any post-delivery write to it — a state change
    // or a same-state checkpoint — falsifies every SETTLED entry for the task.
    // The third member is M8's, and this case's claim is unchanged by it: what
    // is pinned here is that *this* slice invented no post-delivery state, and
    // `OPERATOR_RESOLVED` is not one — it is written by an operator's own
    // command, out of a blocking state, and says nothing about a delivery.
    expect([...TERMINAL_STATES]).toEqual(['READY_FOR_PR', 'ABORTED', 'OPERATOR_RESOLVED']);
    expect(isTerminalState('READY_FOR_PR')).toBe(true);
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
    // No state gained an edge INTO a post-delivery member either, because there
    // is no such member: the vocabulary is unchanged.
    for (const state of ALL_STATES) {
      expect(TRANSITION_TABLE[state], state).not.toContain('MERGED' as never);
    }
    expect(ALL_STATES).not.toContain('MERGED' as never);
    expect(ALL_STATES).not.toContain('POST_MERGE_VERIFY' as never);
    expect(ALL_STATES).not.toContain('COMPLETE' as never);
  });

  it('names no task-state writer anywhere on the reconciliation path', () => {
    const files = [
      'src/deliver/reconcile-merge.ts',
      'src/deliver/merge-reconciliation.ts',
      'src/deliver/merge-reconciliation-store.ts',
      'src/deliver/merge-observation-proof.ts',
      'src/deliver/internal/merge-observation-proof.ts',
    ];
    for (const file of files) {
      const source = codeOnly(file);
      // A per-file floor, so a renamed or emptied file cannot pass as clean.
      expect(source.length, file).toBeGreaterThan(200);
      for (const token of [
        'saveTaskState',
        'advanceTaskState',
        'recordAgentInterruption',
        'acquireExecutionLease',
        'settleBlockTask',
        'block-ledger',
        'block-store',
      ]) {
        expect(source, `${file}: ${token}`).not.toContain(token);
      }
    }
    // The pattern control: the same search DOES find the writer in the module
    // that owns it, so an empty scan cannot pass as a clean tree.
    expect(codeOnly('src/state/state-store.ts')).toContain('saveTaskState');
    expect(codeOnly('src/state/advance-state.ts')).toContain('advanceTaskState');
  });

  it('leaves a settled block entry provable, byte for byte', async () => {
    // The load-bearing case of this file. `proveBlockTaskEntry` is the function
    // that decides whether a SETTLED ledger entry still holds, and it is run
    // before and after a real reconciliation against a real task-state file on
    // a real filesystem — rather than reasoned about.
    const root = mkdtempSync(join(tmpdir(), 'ao-v408-block-'));
    try {
      mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
      const state = {
        schemaVersion: 1,
        taskId: TASK,
        repositoryId: 'repo',
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
      const saved = saveTaskState(state, { repositoryRoot: root });
      expect(saved.code, JSON.stringify(saved)).toBe('SAVED');
      if (!saved.ok) throw new Error('fixture state not saved');

      const before = loadTaskState(root, TASK);
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error('fixture state unreadable');
      const statePath = saved.path;
      const stateBytes = readFileSync(statePath);

      // A legitimately settled entry, built the way the ledger builds one: the
      // revision that justified it, and the commit the task ended at.
      const entry: BlockTaskEntry = {
        taskId: TASK,
        disposition: 'SETTLED',
        evidenceRevision: before.revision,
        baseCommit: OTHER,
        resultCommit: HEAD,
      };
      expect(proveBlockTaskEntry(root, entry).code).toBe('PROVEN');

      // Now deliver: establish the merge and write the receipt, for real.
      const recorded = await recordMergeReconciliation({
        repositoryRoot: root,
        taskId: TASK,
          expectedSubjectCommit: HEAD,
        expectedHost: IDENTITY.host,
        expectedOwner: IDENTITY.owner,
        expectedName: IDENTITY.name,
        expectedBaseRef: BASE,
        proof: mintedProof(),
        reconciledAt: AT,
        checkIgnored: async () => 'IGNORED' as IgnoreVerdict,
      });
      expect(recorded.code).toBe('RECORDED');

      // The positive control: something really was written, so the assertions
      // below are about a delivery that happened.
      expect(
        loadMergeReconciliation(root, TASK, { taskId: TASK, repositoryRoot: root }).reading,
      ).toBe('HISTORICAL_MERGE');

      // The task's durable bytes are byte-identical. Not "equivalent", not
      // "unchanged in the fields we care about" — the revision is a digest over
      // exactly these bytes, so anything less would not be the guarantee.
      expect(readFileSync(statePath)).toEqual(stateBytes);
      const after = loadTaskState(root, TASK);
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error('state unreadable after');
      expect(after.revision).toBe(before.revision);

      // And the settlement still proves itself — the same instrument, the same
      // verdict, after the delivery progressed.
      expect(proveBlockTaskEntry(root, entry).code).toBe('PROVEN');

      // The negative control that makes the line above mean something: the same
      // prover DOES refuse when the evidence really is stale. Without this, a
      // prover that answered PROVEN for everything would pass the case above.
      expect(
        proveBlockTaskEntry(root, { ...entry, evidenceRevision: 'f'.repeat(64) }).code,
      ).toBe('EVIDENCE_NOT_CURRENT');
      // And it refuses a result commit that is not what the task ended at —
      // which is exactly what moving `currentCommit` to the merge commit would
      // have produced.
      expect(proveBlockTaskEntry(root, { ...entry, resultCommit: RESULT }).code).toBe(
        'COMMIT_NOT_PROVEN_BY_STATE',
      );

      // The third control, and the one this slice's whole architecture rests
      // on: settlement requires the task's state to be the literal
      // `READY_FOR_PR`. A post-delivery state name would make every settled
      // entry for this task unprovable, which is why this slice adds no state
      // and takes no transition. Driven against a real record rather than
      // asserted about the table.
      const moved = { ...state, state: 'ABORTED' };
      const rewritten = saveTaskState(moved, {
        repositoryRoot: root,
        expectedRevision: after.revision,
      });
      expect(rewritten.code, JSON.stringify(rewritten)).toBe('SAVED');
      // `TASK_STATE_DOES_NOT_PROVE_IT` and not `EVIDENCE_NOT_CURRENT`, because
      // the disposition prover runs first and declaration order is precedence
      // order. BOTH conditions are false here — the state moved and so did the
      // file's bytes — and the code an operator sees is the first refusal, which
      // is the stronger statement of the two.
      expect(proveBlockTaskEntry(root, entry).code).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
      // With the revision brought up to date — the repair a post-delivery
      // mutation would have to make — the disposition still refuses, so the
      // revision was not the only thing standing in the way.
      const movedLoad = loadTaskState(root, TASK);
      if (!movedLoad.ok) throw new Error('moved state unreadable');
      expect(
        proveBlockTaskEntry(root, { ...entry, evidenceRevision: movedLoad.revision }).code,
      ).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the reconciliation modules name no agent, no mutation runner and no spawn', () => {
    for (const file of [
      'src/deliver/reconcile-merge.ts',
      'src/deliver/merge-reconciliation-store.ts',
    ]) {
      const source = codeOnly(file);
      expect(source.length, file).toBeGreaterThan(200);
      for (const token of [
        'runOwnedCommand',
        'ForgeMergeRunner',
        'ForgeMutationRunner',
        'GitPublicationRunner',
        'mergePullRequest',
        'createPullRequest',
        'publishDeliveryHead',
        'spawn',
      ]) {
        expect(source, `${file}: ${token}`).not.toContain(token);
      }
    }
    // The control: those names DO appear in the modules that own them. V4
    // slice 11 moved the act ladders out of the command and into
    // `delivery-steps.ts`, which is where the merge call now sits.
    expect(codeOnly('src/cli/delivery-steps.ts')).toContain('mergePullRequest');
  });

  it('sweeps the reconciliation modules for a mutating request vector', () => {
    // Slice 2's transport is the only route to a network here, and its prefix
    // pins `-X GET`. What this sweep adds is that no module in this slice builds
    // a vector of its own — the failure mode a sibling slice measured, where a
    // second spelling of a request drifted from the first.
    const modules = walk('src/deliver').filter((f) => f.includes('merge-reconciliation') || f.endsWith('reconcile-merge.ts'));
    expect(modules.length).toBeGreaterThanOrEqual(2);
    for (const file of modules) {
      const source = codeOnly(file);
      for (const token of ['-X POST', '-X PATCH', '-X PUT', '-X DELETE', '--method']) {
        expect(source, `${file}: ${token}`).not.toContain(token);
      }
    }
  });
});
