/**
 * V3 slice 5 — safe stale-lease recovery.
 *
 * The slice's claim, in one sentence: *a stale lease may be removed only when
 * this build can prove that no writer launched under it can still be running,
 * and every state in which it cannot prove that is a refusal.*
 *
 * ── What "prove" has to mean here, and why slice 4 could not ──────────────
 *
 * Slice 4 shipped a record that says *the most recent writer launch anybody
 * managed to write about was contained*. Its own header lists the residue, all
 * of it measured: a run makes several launches under one lease, a failed publish
 * leaves the previous launch's positive record standing, and so does a failed
 * clear. So `latestLaunchContained === true` is not "safe to recover", and the
 * cases below include the two failure shapes that make that concrete —
 * a lease whose containment record reads `CONTAINED` while recovery is refused.
 *
 * What replaces it is a launch history that is **poisoned before each launch and
 * confirmed after it**, so the state a killed run leaves behind is visible rather
 * than absent. Several cases exist to prove the ordering rather than the format:
 * a run interrupted between the opening and the confirmation must read unproven,
 * and no later launch may quietly erase it.
 *
 * ── The shape of the counter-proofs ────────────────────────────────────────
 *
 * Eight mutants are named in the slice's report and each is killed here rather
 * than argued about, each a single edit to `src`:
 *
 *     the pending mark is never written                    27 cases red
 *     slice 4's record is treated as sufficient             3
 *     the removal stops binding to the object it proved     1
 *     an unreadable history reads as contained              4
 *     the seam stops refusing an unrecordable launch        1
 *     a supplied liveness opinion may permit                3
 *     a displaced successor reads as a clean abort          1
 *     an incomplete history reads as an absent one          1
 *
 * Re-measured against this file as it stands rather than carried forward: two of
 * them had already drifted, because a case added for one mutant kills others. A
 * count sitting beside the code with nothing keeping the two in step is the
 * defect this repository polices elsewhere, so these are a property of one
 * commit and any case added below can move them.
 *
 * The last three were added after review rounds found them unpinned, and two were
 * live defects rather than hypotheticals. Every case behind them asserts an
 * **effect** rather than the absence of one — an absence assertion pins nothing
 * until the mutant dies — except the seventh, which is pinned against a table by
 * value precisely because its state cannot be produced through this entry point.
 * That is stated where it is asserted, not only here.
 *
 * ── What is deliberately not claimed here ─────────────────────────────────
 *
 * That a real Windows launch produces an attestation. No case below starts one:
 * the boundary executable resolves relative to the compiled adapter and does not
 * exist under `src`, so every attestation here is minted through
 * `core/internal/containment-attestation.ts`, which is exactly what makes these
 * cases about the *gate* and not about a process. The end-to-end measurement of
 * a real contained launch is `tests/dist-artifact/lease-containment-dist-artifact.mjs`.
 *
 * And that this covers every process a run starts. The ledger records the
 * productive writer's launches and nothing else, exactly as slice 4's record
 * does. `writer-launch-ledger.ts` states that boundary; a case below pins that
 * the reviewer does not open a generation, so the limit is measured rather than
 * merely written down.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { PACKAGE_ROOT } from '../src/config/paths.js';

import type { AgentCommandResult } from '../src/agent/agent-command.js';
import {
  containmentFactsOf,
  type ContainmentAttestation,
} from '../src/core/containment-attestation.js';
import { mintContainmentAttestation } from '../src/core/internal/containment-attestation.js';
import type { ExecutionLeaseEvidence } from '../src/core/execution-lease-evidence.js';
import {
  acquireRepositoryExecutionLease,
  assessStaleLeaseRecovery,
  attestWriterLaunchEstablished,
  beginWriterLaunch,
  type WriterLaunchResult,
  clearContainmentEvidence,
  confirmWriterLaunch,
  CONTAINMENT_EVIDENCE_FILE_NAME,
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
  inspectWriterLaunchHistory,
  osProcessLiveness,
  recordContainmentEvidence,
  retractWriterLaunchEstablishment,
  recoverStaleLease,
  releaseRepositoryExecutionLease,
  STALE_LEASE_RECOVERY_CODES,
  STALE_RECOVERY_REFUSALS,
  staleRecoveryOutcomeFor,
  WRITER_LAUNCH_CODES,
  WRITER_LAUNCH_LEDGER_FILE_NAME,
  type LeaseRepository,
  type ProcessLiveness,
  type StaleRecoveryRefusal,
} from '../src/lease/execution-lease.js';
import { assessLeaseRecovery } from '../src/lease/lease-recovery.js';
import {
  MAX_WRITER_LAUNCH_ENTRIES,
  provesEveryLaunchContained,
  provesEveryLaunchContainedUnended,
  readWriterLaunchLedger,
  unendedLaunchesOf,
  writerLaunchBinding,
  WRITER_LAUNCH_LEDGER_VERSION,
  WRITER_LAUNCH_READINGS,
  type WriterLaunchLedgerPayload,
  type WriterLaunchReading,
  type WriterLaunchSubject,
} from '../src/lease/writer-launch-ledger.js';
import { AGENT_LAUNCH_NOT_RECORDED, leasedAgent } from '../src/loop/leased-spawns.js';
import {
  renderLeaseRecovery,
  renderLeaseRecoveryResult,
  STALE_RECOVERY_OUTCOMES,
  STALE_RECOVERY_SENTENCES,
} from '../src/cli/render-lease.js';

/* ───────────────────────────── fixtures ─────────────────────────────────── */

const roots: string[] = [];

/**
 * A directory shaped like an ordinary clone: a work tree with a `.git`
 * directory beside it.
 *
 * The shape is not cosmetic — `acquireRepositoryExecutionLease` proves the
 * record describes *one* repository by deriving the common directory from the
 * root, so a record pairing a root with something that is not its own `.git` is
 * refused.
 */
function repositoryFixture(id = 'v3-05'): LeaseRepository {
  const root = mkdtempSync(join(tmpdir(), 'ao-v3-05-'));
  roots.push(root);
  const gitCommonDir = join(root, '.git');
  mkdirSync(gitCommonDir, { recursive: true });
  return Object.freeze({ gitCommonDir, root, id });
}

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A fixture we cannot remove is inert; it holds nothing open.
    }
  }
});

let clock = 0;
const tick = (): string => new Date(Date.UTC(2026, 7, 21, 0, 0, clock++)).toISOString();

interface Held {
  readonly evidence: ExecutionLeaseEvidence;
  readonly path: string;
}

/** A real lease, through the real entry point. Nothing here is fabricated. */
function leaseOf(repository: LeaseRepository, runId: string | null = 'run-1'): Held {
  const acquired = acquireRepositoryExecutionLease(
    repository,
    { runId, blockId: null },
    { now: tick },
  );
  if (!acquired.ok) throw new Error(`fixture could not take the lease: ${acquired.code}`);
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return { evidence: acquired.evidence, path: location.path };
}

function ledgerPathOf(repository: LeaseRepository): string {
  return join(repository.gitCommonDir, WRITER_LAUNCH_LEDGER_FILE_NAME);
}

function recordPathOf(repository: LeaseRepository): string {
  return join(repository.gitCommonDir, CONTAINMENT_EVIDENCE_FILE_NAME);
}

/** The ledger on disk, or `null` when there is none. */
function ledgerOf(repository: LeaseRepository): Record<string, unknown> | null {
  const path = ledgerPathOf(repository);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : null;
}

function writeLedger(repository: LeaseRepository, value: unknown): void {
  writeFileSync(
    ledgerPathOf(repository),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

/** The four lease fields a ledger is bound to, read from the lease on disk. */
function subjectOf(repository: LeaseRepository): WriterLaunchSubject {
  const document = JSON.parse(readFileSync(leasePathOf(repository), 'utf8')) as {
    leaseKey: string;
    ownerNonce: string;
    ownerPid: number;
    runId: string | null;
  };
  return {
    leaseKey: document.leaseKey,
    ownerNonce: document.ownerNonce,
    ownerPid: document.ownerPid,
    runId: document.runId,
  };
}

function leasePathOf(repository: LeaseRepository): string {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return location.path;
}

/** A minted attestation for `ownerPid`, or a loud failure. Never fabricated. */
function attestationFor(
  ownerPid: number,
  over: Partial<Parameters<typeof mintContainmentAttestation>[0]> = {},
): ContainmentAttestation {
  const minted = mintContainmentAttestation({
    ownerPid,
    helperPid: 4242,
    childPid: 4343,
    mode: 'JOBLIST',
    assignedAtCreation: true,
    launchNonce: 'a1b2c3d4e5f60718',
    attestedAt: '2026-08-21T00:00:00.000Z',
    verifiedInJob: true,
    ...over,
  });
  if (minted === null) throw new Error('fixture could not mint an attestation');
  return minted;
}

/** An agent result, with or without an attestation on it. */
function agentResult(attestation: ContainmentAttestation | null): AgentCommandResult {
  return Object.freeze({
    outcome: 'RAN' as const,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    failureCode: null,
    errnoCode: null,
    durationMs: 1,
    ...(attestation === null ? {} : { containment: attestation }),
  });
}

/** One generation's recorded state, read back off disk. Typed, so a case that
 *  asks about a generation that is not there fails rather than reads undefined
 *  as a passing comparison. */
function stateOf(repository: LeaseRepository, generation: number): string {
  const entries = (ledgerOf(repository)?.entries ?? []) as readonly { readonly state: string }[];
  const entry = entries[generation - 1];
  if (entry === undefined) throw new Error(`no generation ${generation} on disk`);
  return entry.state;
}

/** One generation's whole recorded entry, read back off disk. */
function entryOf(repository: LeaseRepository, generation: number): Readonly<Record<string, unknown>> {
  const entries = (ledgerOf(repository)?.entries ?? []) as readonly Record<string, unknown>[];
  const entry = entries[generation - 1];
  if (entry === undefined) throw new Error(`no generation ${generation} on disk`);
  return entry;
}

const dead = (): ProcessLiveness => 'NOT_FOUND';
const alive = (): ProcessLiveness => 'ALIVE';
const undetermined = (): ProcessLiveness => 'UNDETERMINED';

/**
 * One full writer launch, opened and confirmed, through the public entry points.
 *
 * Each call mints an attestation with its own launch nonce, because that is what
 * a real launch produces and because `confirmWriterLaunch` refuses a digest that
 * already proved another generation of this lease. A fixture that reused one
 * attestation would be exercising a replay the format now rejects.
 */
let launch = 0;
function containedLaunch(repository: LeaseRepository, evidence: ExecutionLeaseEvidence): void {
  const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
  expect(opened.code).toBe('OPENED');
  const generation = opened.generation;
  if (generation === null) throw new Error('an opened launch carries a generation');
  const confirmed = confirmWriterLaunch(
    repository,
    evidence,
    attestationFor(process.pid, { launchNonce: (launch++).toString(16).padStart(16, '0') }),
    { generation, writerId: 'claude', now: tick },
  );
  expect(confirmed.code).toBe('CONFIRMED');
}

/**
 * One writer launch established and left that way: the mark M2 slice 1 writes
 * while the writer is still running, and the state a mid-writer interrupt leaves.
 *
 * The pids are the fixture's whole point, because they are what the recovery
 * predicate re-probes. A caller passes the pair it wants the probe to be asked
 * about.
 */
function establishedLaunch(
  repository: LeaseRepository,
  evidence: ExecutionLeaseEvidence,
  pids: { readonly helperPid: number; readonly childPid: number },
): void {
  const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
  expect(opened.code).toBe('OPENED');
  const generation = opened.generation;
  if (generation === null) throw new Error('an opened launch carries a generation');
  const established = attestWriterLaunchEstablished(
    repository,
    evidence,
    attestationFor(process.pid, {
      ...pids,
      launchNonce: (launch++).toString(16).padStart(16, '0'),
    }),
    { generation, writerId: 'claude', now: tick },
  );
  expect(established.code).toBe('ESTABLISHED');
}

/* ─────────────────────── 1. the format, in isolation ────────────────────── */

const SUBJECT: WriterLaunchSubject = Object.freeze({
  leaseKey: 'D:\\repo\\.git',
  ownerNonce: 'a'.repeat(64),
  ownerPid: 1234,
  runId: 'run-1',
});

function payload(over: Partial<WriterLaunchLedgerPayload> = {}): WriterLaunchLedgerPayload {
  return {
    ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION,
    ownerPid: SUBJECT.ownerPid,
    runId: SUBJECT.runId,
    historyComplete: true,
    entries: [],
    ...over,
  };
}

function sealed(
  over: Partial<WriterLaunchLedgerPayload> = {},
  lease: WriterLaunchSubject = SUBJECT,
): Record<string, unknown> {
  const built = payload(over);
  return { ...built, binding: writerLaunchBinding(lease, built) };
}

const CONTAINED_ENTRY = Object.freeze({
  generation: 1,
  state: 'CONTAINED' as const,
  writerId: 'claude',
  openedAt: '2026-08-21T00:00:00.000Z',
  helperPid: 11,
  childPid: 12,
  mode: 'JOBLIST',
  verifiedInJob: true as const,
  assignedAtCreation: true,
  launchDigest: 'b'.repeat(64),
  attestedAt: '2026-08-21T00:00:01.000Z',
  confirmedAt: '2026-08-21T00:00:02.000Z',
});

const ESTABLISHED_ENTRY = Object.freeze({
  generation: 1,
  state: 'ESTABLISHED' as const,
  writerId: 'claude',
  openedAt: '2026-08-21T00:00:00.000Z',
  helperPid: 11,
  childPid: 12,
  mode: 'JOBLIST',
  verifiedInJob: true as const,
  assignedAtCreation: true,
  launchDigest: 'c'.repeat(64),
  attestedAt: '2026-08-21T00:00:01.000Z',
  establishedAt: '2026-08-21T00:00:02.000Z',
});

const PENDING_ENTRY = Object.freeze({
  generation: 1,
  state: 'PENDING' as const,
  writerId: 'claude',
  openedAt: '2026-08-21T00:00:00.000Z',
});

describe('the launch history format refuses everything it cannot read', () => {
  it('answers exactly one reading that is a proof, asserted by value', () => {
    // The table in `writer-launch-ledger.ts` is total by type, which proves it is
    // complete and says nothing about whether it is *correct* — `satisfies` would
    // accept `true` in every row. So every row is asserted here by value.
    const proving = WRITER_LAUNCH_READINGS.filter((reading) =>
      provesEveryLaunchContained(reading),
    );
    expect(proving).toEqual(['ALL_LAUNCHES_CONTAINED']);
    for (const reading of WRITER_LAUNCH_READINGS) {
      expect(provesEveryLaunchContained(reading)).toBe(reading === 'ALL_LAUNCHES_CONTAINED');
    }
  });

  it('keeps the two licensing predicates disjoint, asserted by value', () => {
    // The second table gets the same treatment as the first, and the *disjoint*
    // part is the property worth pinning rather than either row on its own. If
    // `provesEveryLaunchContainedUnended` ever answered `true` for
    // `ALL_LAUNCHES_CONTAINED`, the weaker predicate would have become a
    // superset of the stronger one — and the recovery would then reach the
    // liveness re-check through a reading that never needed it, which reads as
    // harmless and is how a table stops meaning anything.
    const unendedReadings = WRITER_LAUNCH_READINGS.filter((reading) =>
      provesEveryLaunchContainedUnended(reading),
    );
    expect(unendedReadings).toEqual(['LAUNCHES_CONTAINED_SOME_UNENDED']);
    for (const reading of WRITER_LAUNCH_READINGS) {
      expect(provesEveryLaunchContainedUnended(reading)).toBe(
        reading === 'LAUNCHES_CONTAINED_SOME_UNENDED',
      );
      // No reading is admitted by both. Stated as its own assertion because the
      // two loops above could each pass while one reading satisfied both.
      expect(
        provesEveryLaunchContained(reading) && provesEveryLaunchContainedUnended(reading),
      ).toBe(false);
    }
  });

  it('refuses an ESTABLISHED entry relabelled CONTAINED, in both directions', () => {
    // THE forgery this slice has to refuse. An `ESTABLISHED` entry accepted as
    // `CONTAINED` makes the reading `ALL_LAUNCHES_CONTAINED`, which takes the
    // short-circuit in `assessStaleLeaseRecoveryBound` and never probes the
    // recorded pids at all — one edit, and the liveness proof is skipped.
    //
    // The relabel needs the timestamp field renamed too, because the schema is a
    // strict discriminated union; that is why this is not covered by the
    // per-field mutation cases, which change values and never keys.
    const { establishedAt, ...rest } = ESTABLISHED_ENTRY;
    const relabelledAsContained = {
      ...rest,
      state: 'CONTAINED' as const,
      confirmedAt: establishedAt,
    };
    // No control is asserted here for the relabelled entry sealed as itself: it
    // would be a ledger built and read by the same code, which measures the
    // digest against itself and is already covered by the ALL_LAUNCHES_CONTAINED
    // row of the readings table. What follows is the attack.
    const sealedAsEstablished = sealed({ entries: [ESTABLISHED_ENTRY] }) as Record<string, unknown>;
    expect(
      readWriterLaunchLedger(SUBJECT, {
        ...sealedAsEstablished,
        entries: [relabelledAsContained],
      }),
    ).toBe('NOT_THIS_LEASE');

    // And the other direction: a CONTAINED entry dressed as ESTABLISHED, which
    // would be the harmless-looking edit that adds a liveness check nobody owes.
    const { confirmedAt, ...containedRest } = CONTAINED_ENTRY;
    const sealedAsContained = sealed({ entries: [CONTAINED_ENTRY] }) as Record<string, unknown>;
    expect(
      readWriterLaunchLedger(SUBJECT, {
        ...sealedAsContained,
        entries: [{ ...containedRest, state: 'ESTABLISHED' as const, establishedAt: confirmedAt }],
      }),
    ).toBe('NOT_THIS_LEASE');
  });

  it('detects a per-field edit of an ESTABLISHED entry, establishedAt included', () => {
    // The new state's fields get the same treatment the CONTAINED entry's nine
    // already had. `establishedAt` is the one the shared digest could most
    // plausibly have dropped — it is the only field of this state that
    // `CONTAINED` does not have — so it is asserted rather than assumed.
    const edits: readonly Partial<Record<keyof typeof ESTABLISHED_ENTRY, unknown>>[] = [
      { writerId: 'codex' },
      { openedAt: '2026-08-22T00:00:00.000Z' },
      { helperPid: 99 },
      { childPid: 98 },
      { mode: 'SUSPENDED' },
      { assignedAtCreation: false },
      { launchDigest: 'd'.repeat(64) },
      { attestedAt: '2026-08-22T00:00:01.000Z' },
      { establishedAt: '2026-08-22T00:00:02.000Z' },
    ];
    const sound = sealed({ entries: [ESTABLISHED_ENTRY] }) as Record<string, unknown>;
    expect(readWriterLaunchLedger(SUBJECT, sound)).toBe('LAUNCHES_CONTAINED_SOME_UNENDED');
    for (const edit of edits) {
      expect(
        readWriterLaunchLedger(SUBJECT, {
          ...sound,
          entries: [{ ...ESTABLISHED_ENTRY, ...edit }],
        }),
      ).toBe('NOT_THIS_LEASE');
    }
  });

  it('names the launches a recovery still owes a proof about, and only for that reading', () => {
    // `unendedLaunchesOf` is the only way pids leave the ledger module, so what
    // it refuses matters as much as what it answers. Every reading that is not
    // the one licensing reading must yield `null` — including
    // `ALL_LAUNCHES_CONTAINED`, where a non-null answer would be a list a caller
    // could exhaust and call a proof without ever probing anything.
    expect(
      unendedLaunchesOf(
        SUBJECT,
        sealed({ entries: [ESTABLISHED_ENTRY, { ...CONTAINED_ENTRY, generation: 2 }] }),
      ),
    ).toEqual([{ generation: 1, helperPid: 11, childPid: 12 }]);

    for (const raw of [
      sealed({ entries: [CONTAINED_ENTRY] }),
      sealed({ entries: [PENDING_ENTRY] }),
      sealed({ entries: [ESTABLISHED_ENTRY], historyComplete: false }),
      sealed({ entries: [ESTABLISHED_ENTRY] }, { ...SUBJECT, ownerNonce: 'b'.repeat(64) }),
      { ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION, nonsense: true },
      undefined,
    ]) {
      expect(unendedLaunchesOf(SUBJECT, raw)).toBeNull();
    }
  });

  it('produces every reading in the closed set from a real input', () => {
    const produced = new Map<WriterLaunchReading, unknown>([
      ['ABSENT', undefined],
      ['MALFORMED', { ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION, nonsense: true }],
      ['UNSUPPORTED_VERSION', { ...sealed(), ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION + 1 }],
      ['NOT_THIS_LEASE', sealed({}, { ...SUBJECT, ownerNonce: 'b'.repeat(64) })],
      ['NOT_THIS_RUN', sealed({ runId: 'another-run' })],
      ['HISTORY_INCOMPLETE', sealed({ historyComplete: false })],
      ['LAUNCH_UNPROVEN', sealed({ entries: [PENDING_ENTRY] })],
      ['ALL_LAUNCHES_CONTAINED', sealed({ entries: [CONTAINED_ENTRY] })],
      [
        'LAUNCHES_CONTAINED_SOME_UNENDED',
        sealed({ entries: [ESTABLISHED_ENTRY, { ...CONTAINED_ENTRY, generation: 2 }] }),
      ],
    ]);
    // Every member of the union is produced by something, so no reading is a
    // name with no input behind it.
    expect([...produced.keys()].sort()).toEqual([...WRITER_LAUNCH_READINGS].sort());
    for (const [reading, raw] of produced) {
      expect(readWriterLaunchLedger(SUBJECT, raw)).toBe(reading);
    }
  });

  it('reads an empty complete history as a proof, and an empty incomplete one as not', () => {
    // Vacuously true and deliberately so: a lease under which no writer ever
    // launched has nothing that could have survived it. This is the state
    // `acquireRepositoryExecutionLease` publishes, and it is the reason a run
    // that died before its first writer is recoverable at all.
    expect(readWriterLaunchLedger(SUBJECT, sealed())).toBe('ALL_LAUNCHES_CONTAINED');
    expect(readWriterLaunchLedger(SUBJECT, sealed({ historyComplete: false }))).toBe(
      'HISTORY_INCOMPLETE',
    );
  });

  it('refuses a history with a gap, before it even consults the binding', () => {
    // The edit that matters is *deleting a pending entry*, which is exactly how
    // an unproven launch would be made to disappear. Sealed correctly, so the
    // binding cannot be what refuses it.
    const gapped = sealed({
      entries: [CONTAINED_ENTRY, { ...CONTAINED_ENTRY, generation: 3 }],
    });
    expect(readWriterLaunchLedger(SUBJECT, gapped)).toBe('MALFORMED');
    // And the same two entries, numbered without a gap, are read.
    const contiguous = sealed({
      entries: [CONTAINED_ENTRY, { ...CONTAINED_ENTRY, generation: 2 }],
    });
    expect(readWriterLaunchLedger(SUBJECT, contiguous)).toBe('ALL_LAUNCHES_CONTAINED');
  });

  it('detects a one-field edit of the ledger and of every mutable entry field', () => {
    const base = sealed({ entries: [CONTAINED_ENTRY] });
    const edits: readonly Record<string, unknown>[] = [
      { ownerPid: SUBJECT.ownerPid + 1 },
      { runId: 'other' },
      { historyComplete: false },
    ];
    for (const edit of edits) {
      // Not `NOT_THIS_RUN` or `HISTORY_INCOMPLETE`: the binding is checked first,
      // and an edited field no longer matches it. That ordering is the contract —
      // the agreement checks exist for a *recomputed* forgery, not for an edit.
      expect(readWriterLaunchLedger(SUBJECT, { ...base, ...edit })).toBe('NOT_THIS_LEASE');
    }

    // Nine of a contained entry's twelve fields, one at a time: the pin that the
    // binding covers the entries field by field rather than as an opaque blob.
    // The other three cannot be mutated independently and are not silently
    // omitted — `state` has its own case below, `verifiedInJob` is a literal with
    // no other value, and `generation` is determined positionally by the 1..N
    // check, which refuses any edit to it as `MALFORMED` before the binding is
    // consulted. The case above this one measures exactly that.
    const perField: readonly Record<string, unknown>[] = [
      { writerId: 'codex' },
      { openedAt: '2026-08-21T00:00:09.000Z' },
      { helperPid: 99 },
      { childPid: 98 },
      { mode: 'HANDLE' },
      { assignedAtCreation: false },
      { launchDigest: 'c'.repeat(64) },
      { attestedAt: '2026-08-21T00:00:08.000Z' },
      { confirmedAt: '2026-08-21T00:00:07.000Z' },
    ];
    for (const edit of perField) {
      expect(
        readWriterLaunchLedger(SUBJECT, {
          ...base,
          entries: [{ ...CONTAINED_ENTRY, ...edit }],
        }),
      ).toBe('NOT_THIS_LEASE');
    }
  });

  it('refuses a pending entry relabelled as contained', () => {
    // The single edit the whole format exists to refuse. `state` is fed into the
    // digest explicitly, so relabelling without recomputing breaks the binding —
    // and the relabelled entry is not even a valid contained entry, since it
    // carries none of the containment fields.
    const proven = sealed({ entries: [PENDING_ENTRY] });
    const relabelled = {
      ...proven,
      entries: [{ ...PENDING_ENTRY, state: 'CONTAINED' }],
    };
    expect(readWriterLaunchLedger(SUBJECT, relabelled)).toBe('MALFORMED');

    // And a *fully shaped* contained entry substituted for the pending one, with
    // the original binding left in place, is refused by the digest rather than by
    // the schema. The two arms are separate on purpose: one is "that is not an
    // entry", the other is "that is not this history".
    const substituted = { ...proven, entries: [CONTAINED_ENTRY] };
    expect(readWriterLaunchLedger(SUBJECT, substituted)).toBe('NOT_THIS_LEASE');
  });

  it('refuses a recomputed forgery that names another run or another owner', () => {
    // What a fully recomputed digest still has to satisfy. The digest covers the
    // ledger's *own* owner and run, not the lease's, so a perfectly sealed
    // history about another run is still not this lease's history.
    expect(readWriterLaunchLedger(SUBJECT, sealed({ runId: 'other-run' }))).toBe('NOT_THIS_RUN');
    expect(readWriterLaunchLedger(SUBJECT, sealed({ ownerPid: 4321 }))).toBe('NOT_THIS_RUN');
  });

  it('reads a null run id as a run id, not as an absent one', () => {
    const subject: WriterLaunchSubject = { ...SUBJECT, runId: null };
    expect(readWriterLaunchLedger(subject, sealed({ runId: null }, subject))).toBe(
      'ALL_LAUNCHES_CONTAINED',
    );
    // A history naming a run, beside a lease that names none, is not this
    // lease's — and neither is the reverse.
    expect(readWriterLaunchLedger(subject, sealed({ runId: 'run-1' }, subject))).toBe(
      'NOT_THIS_RUN',
    );
    expect(readWriterLaunchLedger(SUBJECT, sealed({ runId: null }, SUBJECT))).toBe('NOT_THIS_RUN');
  });
});

/* ────────────────── 2. the lifecycle, against real leases ───────────────── */

describe('the launch history is opened before a launch and confirmed after it', () => {
  it('publishes a complete, empty history when the lease is acquired', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);

    const ledger = ledgerOf(repository);
    expect(ledger).not.toBeNull();
    expect(ledger?.historyComplete).toBe(true);
    expect(ledger?.entries).toEqual([]);
    // The one instant at which a complete history can be minted, and this is it.
    expect(inspectWriterLaunchHistory(repository)).toBe('ALL_LAUNCHES_CONTAINED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('opens a generation as pending and confirms exactly that generation', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);

    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(opened.code).toBe('OPENED');
    expect(opened.generation).toBe(1);
    // Poisoned *before* the launch: this is what a run killed mid-writer leaves.
    expect(inspectWriterLaunchHistory(repository)).toBe('LAUNCH_UNPROVEN');

    const confirmed = confirmWriterLaunch(repository, evidence, attestationFor(process.pid), {
      generation: 1,
      writerId: 'claude',
      now: tick,
    });
    expect(confirmed.code).toBe('CONFIRMED');
    expect(inspectWriterLaunchHistory(repository)).toBe('ALL_LAUNCHES_CONTAINED');

    // The facts the attestation carried are in the entry, not merely a flag.
    const facts = containmentFactsOf(attestationFor(process.pid));
    const entries = ledgerOf(repository)?.entries as readonly Record<string, unknown>[];
    expect(entries[0]?.state).toBe('CONTAINED');
    expect(entries[0]?.launchDigest).toBe(facts?.launchDigest);
    expect(entries[0]?.helperPid).toBe(facts?.helperPid);
    releaseRepositoryExecutionLease(evidence);
  });

  it('advances the generation before each launch rather than reusing one', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);

    containedLaunch(repository, evidence);
    const second = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(second.generation).toBe(2);
    expect((ledgerOf(repository)?.entries as unknown[]).length).toBe(2);
    // One contained generation and one still open. The history is not a proof,
    // and the earlier proven launch does not make it one.
    expect(inspectWriterLaunchHistory(repository)).toBe('LAUNCH_UNPROVEN');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses to confirm a generation that is not open', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const attestation = attestationFor(process.pid);

    // Nothing opened at all.
    expect(
      confirmWriterLaunch(repository, evidence, attestation, {
        generation: 1,
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('GENERATION_NOT_OPEN');

    containedLaunch(repository, evidence);
    // Already confirmed. A confirmation must not be idempotent here: the second
    // one would be confirming a launch it has no attestation window for.
    expect(
      confirmWriterLaunch(repository, evidence, attestation, {
        generation: 1,
        writerId: 'claude',
        now: tick,
      }).detail,
    ).toBe('ALREADY_CONFIRMED');

    // A generation nobody opened.
    expect(
      confirmWriterLaunch(repository, evidence, attestation, {
        generation: 9,
        writerId: 'claude',
        now: tick,
      }).detail,
    ).toBe('NOT_PRESENT');

    // Opened for one writer, confirmed for another.
    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(
      confirmWriterLaunch(repository, evidence, attestation, {
        generation: opened.generation ?? 0,
        writerId: 'codex',
        now: tick,
      }).detail,
    ).toBe('ANOTHER_WRITER');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses an attestation coupled to a process other than the lease owner', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });

    // A job coupled to some other process says nothing about this lease's owner
    // dying, which is the entire inference the history exists to support.
    expect(
      confirmWriterLaunch(repository, evidence, attestationFor(process.pid + 1), {
        generation: opened.generation ?? 0,
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('OWNER_MISMATCH');
    expect(inspectWriterLaunchHistory(repository)).toBe('LAUNCH_UNPROVEN');
    releaseRepositoryExecutionLease(evidence);
  });

  it('rebuilds an unusable history as permanently incomplete, never as a fresh proof', () => {
    // The fail-open shape a reviewer would look for: the ledger is lost, the next
    // launch starts a new history at generation 1, and that history reads as a
    // complete proof while hiding every launch the lost file described.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    containedLaunch(repository, evidence);

    rmSync(ledgerPathOf(repository));
    containedLaunch(repository, evidence);

    expect(ledgerOf(repository)?.historyComplete).toBe(false);
    expect((ledgerOf(repository)?.entries as unknown[]).length).toBe(1);
    // A log, and never a proof. This is what makes losing the file safe.
    expect(inspectWriterLaunchHistory(repository)).toBe('HISTORY_INCOMPLETE');

    // And it does not recover on a later, entirely well-behaved launch.
    containedLaunch(repository, evidence);
    expect(inspectWriterLaunchHistory(repository)).toBe('HISTORY_INCOMPLETE');
    releaseRepositoryExecutionLease(evidence);
  });

  it('starts a fresh history for a successor rather than inheriting one', () => {
    const repository = repositoryFixture();
    const first = leaseOf(repository, 'run-first');
    containedLaunch(repository, first.evidence);
    releaseRepositoryExecutionLease(first.evidence);

    // The released lease's history is still on disk — the removal deliberately
    // leaves companions where they are — and it is not this lease's.
    expect(existsSync(ledgerPathOf(repository))).toBe(true);
    const second = leaseOf(repository, 'run-second');
    // Replaced outright by the acquisition, which is why the leftover is inert.
    expect(inspectWriterLaunchHistory(repository)).toBe('ALL_LAUNCHES_CONTAINED');
    expect((ledgerOf(repository)?.entries as unknown[]).length).toBe(0);
    releaseRepositoryExecutionLease(second.evidence);
  });

  it('refuses to touch a history it does not hold the lease for', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const other = repositoryFixture();
    const foreign = leaseOf(other);

    for (const code of [
      beginWriterLaunch(repository, foreign.evidence, { writerId: 'claude', now: tick }).code,
      confirmWriterLaunch(repository, foreign.evidence, attestationFor(process.pid), {
        generation: 1,
        writerId: 'claude',
        now: tick,
      }).code,
    ]) {
      expect(code).toBe('LEASE_FOR_ANOTHER_REPOSITORY');
    }

    // And an artefact that was never minted reaches nothing at all.
    expect(beginWriterLaunch(repository, {}, { writerId: 'claude', now: tick }).code).toBe(
      'EVIDENCE_INVALID',
    );
    expect((ledgerOf(repository)?.entries as unknown[]).length).toBe(0);
    releaseRepositoryExecutionLease(evidence);
    releaseRepositoryExecutionLease(foreign.evidence);
  });

  it('guards the clock seam, which is somebody else\u2019s code', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const hostile = [
      () => {
        throw new Error('no clock today');
      },
      undefined as unknown as () => string,
      'not a function' as unknown as () => string,
      () => 'not an instant',
    ];
    for (const now of hostile) {
      expect(beginWriterLaunch(repository, evidence, { writerId: 'claude', now }).code).toBe(
        'LEDGER_NOT_READABLE_BACK',
      );
    }
    // Nothing reached a file: the history is still the empty one the acquisition
    // published, so a refused clock cannot poison a lease for its whole life.
    expect(inspectWriterLaunchHistory(repository)).toBe('ALL_LAUNCHES_CONTAINED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses one attestation used to prove a second generation', () => {
    // One kernel-confirmed launch proves one launch. Replaying an attestation
    // across generations would build a history reading `ALL_LAUNCHES_CONTAINED`
    // in which only one launch was ever confirmed. Not reachable through the
    // seam — each result carries its own attestation — which is exactly why the
    // format checks it rather than trusting the caller.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const attestation = attestationFor(process.pid);

    const first = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(
      confirmWriterLaunch(repository, evidence, attestation, {
        generation: first.generation ?? 0,
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('CONFIRMED');

    const second = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    const replayed = confirmWriterLaunch(repository, evidence, attestation, {
      generation: second.generation ?? 0,
      writerId: 'claude',
      now: tick,
    });
    expect(replayed.code).toBe('ATTESTATION_ALREADY_USED');
    expect(replayed.detail).toBe('DIGEST_ALREADY_PROVED');
    expect(inspectWriterLaunchHistory(repository)).toBe('LAUNCH_UNPROVEN');

    // A distinct launch confirms normally, so the check refuses the replay and
    // not the second generation.
    expect(
      confirmWriterLaunch(
        repository,
        evidence,
        attestationFor(process.pid, { launchNonce: '0f1e2d3c4b5a6978' }),
        { generation: second.generation ?? 0, writerId: 'claude', now: tick },
      ).code,
    ).toBe('CONFIRMED');
    expect(inspectWriterLaunchHistory(repository)).toBe('ALL_LAUNCHES_CONTAINED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('discards the history rather than leave a full one standing', () => {
    /**
     * The entry cap, reached deliberately.
     *
     * It used to be unreachable — the companion reader's byte cap was a third of
     * what this many entries need, so it bound first at about 2261 entries and
     * this cap could never fire. What that produced was not a refusal: every
     * later confirmation failed its read-back, so every generation stayed
     * `PENDING` and the lease became permanently unrecoverable in silence.
     *
     * Now the cap binds and says so. The history is discarded — which asserts
     * nothing — the launch is still allowed, and this lease is never recoverable
     * again. That is the same trade a failed publish takes.
     */
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const subject = subjectOf(repository);
    const full = Array.from({ length: MAX_WRITER_LAUNCH_ENTRIES }, (_unused, index) => ({
      ...CONTAINED_ENTRY,
      generation: index + 1,
    }));
    // Sealed for this lease's own owner and run, not the format fixture's: the
    // agreement checks come after the binding and would otherwise refuse it as
    // `NOT_THIS_RUN` before the cap could be reached.
    writeLedger(
      repository,
      sealed({ entries: full, ownerPid: subject.ownerPid, runId: subject.runId }, subject),
    );
    // Readable at the cap: the byte cap no longer binds first, which is the half
    // of this that was measured wrong.
    expect(inspectWriterLaunchHistory(repository)).toBe('ALL_LAUNCHES_CONTAINED');

    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(opened.code).toBe('HISTORY_DISCARDED');
    expect(opened.detail).toBe('HISTORY_FULL');
    expect(existsSync(ledgerPathOf(repository))).toBe(false);
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_ABSENT',
    );
    releaseRepositoryExecutionLease(evidence);
  });

  it('discards the history when the publish is refused, and refuses the launch when it cannot', () => {
    /**
     * The two filesystem-refusal arms, produced in process.
     *
     * An earlier version of this file said these had "no in-process trigger" and
     * a follow-up entry repeated it. Both were wrong, and an adversarial review
     * produced each with plain `node:fs`:
     *
     *  - a **held-open handle** blocks a rename onto that name on Windows and
     *    does not block an unlink of it — which is the same mechanism
     *    `clearContainmentEvidence`'s own docstring already records as measured;
     *  - a **directory** at the ledger's name refuses both, which is the state
     *    `LAUNCH_MUST_NOT_START` exists for.
     */
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);

    // The publish is refused; the unlink is not. The history goes, the launch may
    // proceed, and this lease is no longer recoverable.
    const handle = openSync(ledgerPathOf(repository), 'r');
    let opened;
    try {
      opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    } finally {
      closeSync(handle);
    }
    expect(opened.code).toBe('HISTORY_DISCARDED');
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_ABSENT',
    );
    releaseRepositoryExecutionLease(evidence);

    // Neither is possible: the launch itself loses, which is the one place in
    // this build where a failure to record stops productive work.
    const blocked = repositoryFixture();
    const held = leaseOf(blocked);
    rmSync(ledgerPathOf(blocked), { force: true });
    mkdirSync(join(ledgerPathOf(blocked), 'occupied'), { recursive: true });
    const refused = beginWriterLaunch(blocked, held.evidence, { writerId: 'claude', now: tick });
    expect(refused.code).toBe('LAUNCH_MUST_NOT_START');
    expect(refused.detail).not.toBeNull();
    releaseRepositoryExecutionLease(held.evidence);
  });

  it('leaves a generation pending when its confirmation cannot be published', () => {
    // The confirmation has no launch riding on its result, so the conservative
    // end state is already on disk and nothing is discarded. Produced by the same
    // held-open handle.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });

    const handle = openSync(ledgerPathOf(repository), 'r');
    let confirmed;
    try {
      confirmed = confirmWriterLaunch(repository, evidence, attestationFor(process.pid), {
        generation: opened.generation ?? 0,
        writerId: 'claude',
        now: tick,
      });
    } finally {
      closeSync(handle);
    }
    expect(confirmed.code).toBe('LEDGER_WRITE_FAILED');
    // Still there, still open. A failed confirmation loses evidence and never
    // manufactures it.
    expect(inspectWriterLaunchHistory(repository)).toBe('LAUNCH_UNPROVEN');
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_UNPROVEN',
    );
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses to establish a generation twice, and to walk one backwards', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    const generation = opened.generation ?? 0;
    const mark = (nonce: string): WriterLaunchResult =>
      attestWriterLaunchEstablished(
        repository,
        evidence,
        attestationFor(process.pid, { launchNonce: nonce }),
        { generation, writerId: 'claude', now: tick },
      );

    expect(mark('00000000000000a1').code).toBe('ESTABLISHED');
    // Twice is refused, with its own detail: an established generation is not
    // re-established, and a caller that could would be free to replace the pids
    // a later recovery probes.
    const again = mark('00000000000000a2');
    expect(again.code).toBe('GENERATION_NOT_OPEN');
    expect(again.detail).toBe('ALREADY_ESTABLISHED');

    // And backwards is refused too. Confirm it, then try to establish it again.
    expect(
      confirmWriterLaunch(
        repository,
        evidence,
        attestationFor(process.pid, { launchNonce: '00000000000000a1' }),
        { generation, writerId: 'claude', now: tick },
      ).code,
    ).toBe('CONFIRMED');
    const backwards = mark('00000000000000a3');
    expect(backwards.code).toBe('GENERATION_NOT_OPEN');
    expect(backwards.detail).toBe('ALREADY_CONFIRMED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a confirmation that is not the launch it is confirming', () => {
    // The check the code calls load-bearing, measured. Without it an attestation
    // for launch B confirms generation A: the entry keeps A's `openedAt` and
    // gains B's pids, and its `CONTAINED` state then claims A ended when nothing
    // of the kind was observed.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    const generation = opened.generation ?? 0;
    expect(
      attestWriterLaunchEstablished(
        repository,
        evidence,
        attestationFor(process.pid, { launchNonce: '00000000000000b1' }),
        { generation, writerId: 'claude', now: tick },
      ).code,
    ).toBe('ESTABLISHED');
    const established = entryOf(repository, generation);

    const foreign = confirmWriterLaunch(
      repository,
      evidence,
      attestationFor(process.pid, { launchNonce: '00000000000000b2' }),
      { generation, writerId: 'claude', now: tick },
    );
    expect(foreign.code).toBe('ATTESTATION_ALREADY_USED');
    expect(foreign.detail).toBe('DIGEST_NOT_THIS_LAUNCH');
    // The entry is untouched, and that is checked field by field rather than by
    // its state alone: a refusal that had rewritten the pids while leaving the
    // state would satisfy a state-only assertion and would be exactly the defect
    // this refusal exists to prevent.
    expect(entryOf(repository, generation)).toEqual(established);

    // The control: the launch's own attestation confirms it.
    expect(
      confirmWriterLaunch(
        repository,
        evidence,
        attestationFor(process.pid, { launchNonce: '00000000000000b1' }),
        { generation, writerId: 'claude', now: tick },
      ).code,
    ).toBe('CONFIRMED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses an attestation already standing on an ESTABLISHED generation', () => {
    // The replay check reads every non-`PENDING` state, not only `CONTAINED`.
    // Narrowing it to `CONTAINED` lets one kernel-confirmed launch prove two
    // generations, so long as the first is still established — and a history
    // whose entries all read as proofs is exactly what a recovery acts on.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const first = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(
      attestWriterLaunchEstablished(
        repository,
        evidence,
        attestationFor(process.pid, { launchNonce: '00000000000000c1' }),
        { generation: first.generation ?? 0, writerId: 'claude', now: tick },
      ).code,
    ).toBe('ESTABLISHED');

    const second = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    const replayed = attestWriterLaunchEstablished(
      repository,
      evidence,
      attestationFor(process.pid, { launchNonce: '00000000000000c1' }),
      { generation: second.generation ?? 0, writerId: 'claude', now: tick },
    );
    expect(replayed.code).toBe('ATTESTATION_ALREADY_USED');
    expect(replayed.detail).toBe('DIGEST_ALREADY_PROVED');
    expect(stateOf(repository, second.generation ?? 1)).toBe('PENDING');
    releaseRepositoryExecutionLease(evidence);
  });

  it('names every code in the closed set, and produces all but one', () => {
    expect([...WRITER_LAUNCH_CODES].sort()).toEqual(
      [
        'ATTESTATION_ALREADY_USED',
        'ATTESTATION_INVALID',
        'CONFIRMED',
        'ESTABLISHED',
        'EVIDENCE_INVALID',
        'GENERATION_NOT_OPEN',
        'HISTORY_DISCARDED',
        'LAUNCH_MUST_NOT_START',
        'LEASE_ABSENT',
        'LEASE_FOR_ANOTHER_REPOSITORY',
        'LEASE_UNREADABLE',
        'LEDGER_NOT_READABLE_BACK',
        'LEDGER_WRITE_FAILED',
        'NOT_OWNER',
        'OPENED',
        'OWNER_MISMATCH',
        'RETRACTED',
      ].sort(),
    );

    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    expect(
      confirmWriterLaunch(repository, evidence, {}, { generation: 1, writerId: 'claude', now: tick })
        .code,
    ).toBe('ATTESTATION_INVALID');
    releaseRepositoryExecutionLease(evidence);
    expect(beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick }).code).toBe(
      'LEASE_ABSENT',
    );

    // `LEASE_UNREADABLE` is the one member no case above produces: it needs
    // something unreadable at the *lease* path while this process still holds
    // minted evidence naming it, which nothing here can arrange. Stated rather
    // than left as an implied gap — every other member is reached by a case in
    // this file.
    expect(WRITER_LAUNCH_CODES).toContain('LEASE_UNREADABLE');
  });
});

/* ─────────────────── 3. the writer seam opens the generation ────────────── */

describe('the leased writer seam announces its launch before it happens', () => {
  it('marks the generation established while the writer is still running', async () => {
    // The production wiring, and the reason this is a *seam* test rather than a
    // ledger test: what M2 slice 1 adds is a call made from inside the launch,
    // and the ledger cannot tell who called it. The runner below stands where
    // `runAgentCommand` stands and does what the boundary does — invoke the hook
    // once the kernel has confirmed membership — and then asserts the ledger
    // *during* the run, which is the only moment the new state is observable.
    //
    // Deleting the `onLaunchEstablished` wiring in `leased-spawns.ts` leaves the
    // whole in-process suite green except for this case.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const attestation = attestationFor(process.pid, {
      helperPid: 777,
      childPid: 778,
      launchNonce: 'e57ab11500000001',
    });
    let midRun: readonly { readonly state: string }[] = [];

    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async (_id, _args, _cwd, _payload, hooks) => {
        hooks?.onLaunchEstablished?.(attestation);
        // Read after the hook and before the result: this is the state a crash
        // in the middle of a writer leaves behind.
        midRun = (ledgerOf(repository)?.entries ?? []) as readonly { readonly state: string }[];
        return agentResult(attestation);
      },
      containmentNow: tick,
    });

    await run('claude', [], process.cwd(), '');
    expect(midRun.map((entry) => entry.state)).toEqual(['ESTABLISHED']);

    // And the ordinary ending still upgrades it. The establishment mark is a
    // middle step, not a replacement for the one that says the launch ended.
    const after = (ledgerOf(repository)?.entries ?? []) as readonly { readonly state: string }[];
    expect(after.map((entry) => entry.state)).toEqual(['CONTAINED']);
    releaseRepositoryExecutionLease(evidence);
  });

  it('withdraws the establishment mark when the writer ends without a proof', async () => {
    // THE SEQUENCE A REVIEW BLOCKED THIS SLICE ON, in order:
    //
    //   ESTABLISHED writer
    //   -> the writer really ends
    //   -> the CONTAINED upgrade does not happen
    //   -> a later owned subprocess (commit, verification, reviewer) can start
    //   -> the owner dies during THAT
    //   -> recovery MUST refuse
    //
    // The old arm probed only the writer's pids. Those are gone - it ended - so
    // the predicate said SAFE while an AO-started process could still be alive.
    // The ledger cannot see that process; what it can do is stop claiming a
    // proof the moment it stops being true, which is here.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const attestation = attestationFor(process.pid, { helperPid: 61_001, childPid: 61_002 });
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async (_id, _args, _cwd, _payload, hooks) => {
        hooks?.onLaunchEstablished?.(attestation);
        // The writer ends, and its ending cannot be attested. That is a real
        // ending - the run carries on from here - and it is exactly the case
        // that used to leave `ESTABLISHED` standing.
        return agentResult(null);
      },
      containmentNow: tick,
    });

    await run('claude', [], process.cwd(), '');
    expect(stateOf(repository, 1)).toBe('PENDING');

    // Now the owner dies - during the later, unrecorded subprocess this entry
    // used to license removing the lease under. `dead` answers NOT_FOUND for
    // every pid, so the writer's recorded processes are gone too: the refusal
    // below cannot be coming from a live tree, only from the withdrawal.
    freezeAsStale(repository, evidence);
    const assessed = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(assessed.launchHistory).toBe('LAUNCH_UNPROVEN');
    expect(assessed.refusal).toBe('LAUNCH_HISTORY_UNPROVEN');
    // And through the destructive entry point, which makes its own assessment.
    expect(recoverStaleLease(repository).code).toBe('RECOVERY_UNSAFE');
    expect(existsSync(leasePathOf(repository))).toBe(true);
  });

  it('withdraws the mark when the ending was attested and the proof would not publish', async () => {
    // The OTHER way an `ESTABLISHED` entry outlives its launch, and the one that
    // needs no boundary failure at all: a perfectly ordinary writer whose
    // confirmation cannot be written. The seam used to discard that result, so
    // nothing knew, and the entry stood while the run carried on.
    //
    // The handle is opened INSIDE the agent, after the establishment mark has
    // landed, so the mark is real and only the confirmation meets a blocked
    // publish. That is the same technique this file already uses to produce
    // `LEDGER_WRITE_FAILED`.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const attestation = attestationFor(process.pid, { launchNonce: '00000000000000e1' });
    let handle: number | null = null;
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async (_id, _args, _cwd, _payload, hooks) => {
        hooks?.onLaunchEstablished?.(attestation);
        expect(stateOf(repository, 1)).toBe('ESTABLISHED');
        handle = openSync(ledgerPathOf(repository), 'r');
        return agentResult(attestation);
      },
      containmentNow: tick,
    });

    try {
      await run('claude', [], process.cwd(), '');
    } finally {
      if (handle !== null) closeSync(handle);
    }

    // Measured, not predicted: the blocked publish stops the withdrawal too, so
    // the fallback fires and the whole history goes. `ABSENT` asserts nothing at
    // all, which is the conservative end state this chain exists to reach - and
    // it is the one `beginWriterLaunch` already uses for the same reason.
    expect(inspectWriterLaunchHistory(repository)).toBe('ABSENT');
    expect(existsSync(ledgerPathOf(repository))).toBe(false);

    // `freezeAsStale` releases this lease itself, so it is not released above.
    freezeAsStale(repository, evidence);
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).verdict).toBe('UNSAFE');
  });

  it('refuses to withdraw a generation whose ending was proved', () => {
    // A retraction that could undo a proof is a capability this module has no
    // use for, and a build that allowed it would let a confirmed launch be
    // walked back into a state a later call could re-establish with other pids.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    const generation = opened.generation ?? 0;
    expect(
      confirmWriterLaunch(
        repository,
        evidence,
        attestationFor(process.pid, { launchNonce: '00000000000000e2' }),
        { generation, writerId: 'claude', now: tick },
      ).code,
    ).toBe('CONFIRMED');
    const before = entryOf(repository, generation);

    const refused = retractWriterLaunchEstablishment(repository, evidence, {
      generation,
      writerId: 'claude',
    });
    expect(refused.code).toBe('GENERATION_NOT_OPEN');
    expect(refused.detail).toBe('ALREADY_CONFIRMED');
    expect(entryOf(repository, generation)).toEqual(before);

    // And the benign case beside it: nothing to withdraw is a success, because
    // the state the caller asks for already holds.
    const second = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    const nothing = retractWriterLaunchEstablishment(repository, evidence, {
      generation: second.generation ?? 0,
      writerId: 'claude',
    });
    expect(nothing.code).toBe('RETRACTED');
    expect(nothing.detail).toBe('ALREADY_PENDING');
    releaseRepositoryExecutionLease(evidence);
  });

  it('keeps the mark when the writer never ended, which is the case it exists for', async () => {
    // THE CONTROL for the case above, and the reason its refusal is
    // attributable. Same lease, same establishment, same recorded pids - the
    // only difference is that `recordWriterContainment` never runs, because a
    // killed orchestrator never reaches it. The mark stays, and the recovery
    // this slice exists to permit is permitted.
    //
    // Without this pair, a build that withdrew the mark unconditionally would
    // satisfy the case above and would have removed the whole slice.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(
      attestWriterLaunchEstablished(
        repository,
        evidence,
        attestationFor(process.pid, {
          helperPid: 61_001,
          childPid: 61_002,
          launchNonce: '00000000000000f1',
        }),
        { generation: opened.generation ?? 0, writerId: 'claude', now: tick },
      ).code,
    ).toBe('ESTABLISHED');
    // No `recordWriterContainment`: the owner died here.
    expect(stateOf(repository, 1)).toBe('ESTABLISHED');

    freezeAsStale(repository, evidence);
    const assessed = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(assessed.launchHistory).toBe('LAUNCHES_CONTAINED_SOME_UNENDED');
    expect(assessed.verdict).toBe('SAFE_TO_RECOVER');
    expect(recoverStaleLease(repository).code).toBe('RECOVERED');
  });

  it('refuses a caller that brings its own establishment hook', async () => {
    // The fence owns that hook because it writes this lease's ledger, so a
    // second one would be a second writer of the same generation. Silently
    // dropping it - which is what the seam did once `AgentRunner` grew a fifth
    // argument - lets a caller believe it was installed.
    //
    // Measured rather than argued: deleting the guard leaves the whole suite
    // green without this case, which is the shape of survivor this file's
    // neighbours keep finding.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    let started = false;
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () => {
        started = true;
        return agentResult(attestationFor(process.pid));
      },
      containmentNow: tick,
    });

    const refused = await run('claude', [], process.cwd(), '', {
      onLaunchEstablished: () => undefined,
    });
    // Identity against the exported constant, not a field: the two refusals this
    // seam produces are byte-identical once serialised, so a field comparison
    // would pass for either and this case is about which one is returned.
    expect(refused).toBe(AGENT_LAUNCH_NOT_RECORDED);
    // The refusal is before the launch, not after it: nothing was started, and
    // no generation was opened for a launch that never happened.
    expect(started).toBe(false);
    expect(ledgerOf(repository)?.entries).toEqual([]);

    // The control: the same runner, with no hooks, runs and records normally.
    await run('claude', [], process.cwd(), '');
    expect(started).toBe(true);
    expect(stateOf(repository, 1)).toBe('CONTAINED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('opens a generation for the writer and for nothing else', async () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const attestation = attestationFor(process.pid);
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () => agentResult(attestation),
      containmentNow: tick,
    });

    // The reviewer is read-only and is not the writer this history is about.
    // The boundary is measured rather than only written down.
    await run('codex', [], repository.root, '');
    expect((ledgerOf(repository)?.entries as unknown[]).length).toBe(0);

    await run('claude', [], repository.root, '');
    const entries = ledgerOf(repository)?.entries as readonly Record<string, unknown>[];
    expect(entries.length).toBe(1);
    expect(entries[0]?.state).toBe('CONTAINED');
    expect(inspectWriterLaunchHistory(repository)).toBe('ALL_LAUNCHES_CONTAINED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('leaves the generation pending when the launch could not be attested', async () => {
    // A lost boundary, a refused launch, an unconfirmed termination: whatever the
    // cause, there is no attestation, and the generation opened before the launch
    // is what says so. This is prompt case 9 and the shape of case 6.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () => agentResult(null),
      containmentNow: tick,
    });

    await run('claude', [], repository.root, '');
    const entries = ledgerOf(repository)?.entries as readonly Record<string, unknown>[];
    expect(entries.length).toBe(1);
    expect(entries[0]?.state).toBe('PENDING');
    expect(inspectWriterLaunchHistory(repository)).toBe('LAUNCH_UNPROVEN');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses to start a writer whose launch could not be written down', async () => {
    /**
     * The single line the whole ordering rests on, and it had no pin at all: a
     * launch whose poison cannot reach disk **does not happen**.
     *
     * A review named the surviving mutant — treat `'REFUSED'` as `null` in
     * `leasedAgent` and every case stayed green — because all three seam cases
     * used a healthy repository, so `beginWriterLaunch` never answered anything
     * but `OPENED`. The instrument for producing the refusal was already in this
     * file, one describe block up: a directory at the ledger's name refuses both
     * the rename and the unlink.
     *
     * The assertion is that the runner was **never invoked**, which is the effect
     * — a result value alone would not distinguish "refused before the launch"
     * from "launched and then reported a refusal".
     */
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    rmSync(ledgerPathOf(repository), { force: true });
    mkdirSync(join(ledgerPathOf(repository), 'occupied'), { recursive: true });

    let invocations = 0;
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () => {
        invocations += 1;
        return agentResult(attestationFor(process.pid));
      },
      containmentNow: tick,
    });

    const result = await run('claude', [], repository.root, '');
    expect(invocations).toBe(0);
    expect(result).toBe(AGENT_LAUNCH_NOT_RECORDED);
    expect(result.outcome).toBe('UNAVAILABLE');

    // And the refusal is specific to the writer: an agent this history does not
    // record is not stopped by a history it never touches.
    expect((await run('codex', [], repository.root, '')).outcome).toBe('RAN');
    expect(invocations).toBe(1);
    releaseRepositoryExecutionLease(evidence);
  });

  it('keeps an unattested launch visible behind a later contained one', async () => {
    // The residue slice 4 could not close, closed here: the containment record
    // describes the latest launch, so a contained launch *after* an unattested
    // one makes it read `CONTAINED` again. The history does not forget.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    let attestation: ContainmentAttestation | null = null;
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () => agentResult(attestation),
      containmentNow: tick,
    });

    await run('claude', [], repository.root, '');
    attestation = attestationFor(process.pid);
    await run('claude', [], repository.root, '');

    // Slice 4's record says the last launch was contained, and it is right.
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    expect(assessLeaseRecovery(repository, { processAlive: dead }).latestLaunchContained).toBe(true);
    // And the history says a writer of this lease is unaccounted for.
    expect(inspectWriterLaunchHistory(repository)).toBe('LAUNCH_UNPROVEN');
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_UNPROVEN',
    );
    releaseRepositoryExecutionLease(evidence);
  });
});

/* ────────────────────────── 4. the safety predicate ─────────────────────── */

describe('the safety predicate refuses everything it cannot prove', () => {
  it('permits a dead owner whose every writer launch is proved contained', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    containedLaunch(repository, evidence);
    containedLaunch(repository, evidence);
    containedLaunch(repository, evidence);

    const assessed = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(assessed.verdict).toBe('SAFE_TO_RECOVER');
    expect(assessed.refusal).toBeNull();
    expect(assessed.launchHistory).toBe('ALL_LAUNCHES_CONTAINED');
    expect(assessed.ownerPid).toBe(process.pid);
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a living owner and an undecidable one, whatever the history says', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    containedLaunch(repository, evidence);

    // A complete, all-contained history beside a living owner describes a run
    // that is working perfectly. The history alone proves nothing.
    expect(assessStaleLeaseRecovery(repository, { processAlive: alive }).refusal).toBe(
      'OWNER_RUNNING',
    );
    expect(assessStaleLeaseRecovery(repository, { processAlive: undetermined }).refusal).toBe(
      'OWNER_LIVENESS_UNDETERMINED',
    );
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a legacy lease, which no build makes safe in hindsight', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    // What every lease taken before this slice looks like: a perfectly good
    // lease with no history beside it.
    rmSync(ledgerPathOf(repository));

    const assessed = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(assessed.refusal).toBe('LAUNCH_HISTORY_ABSENT');
    expect(assessed.launchHistory).toBe('ABSENT');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a lease carrying only a slice-4 containment record', () => {
    // Prompt case 5, and the sharpest one. The record reads `CONTAINED` and is
    // genuine; it describes one launch, and the predicate does not consult it at
    // all. A build that treated it as sufficient passes every slice-4 test.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    expect(
      recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('RECORDED');
    rmSync(ledgerPathOf(repository));

    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    expect(assessLeaseRecovery(repository, { processAlive: dead }).latestLaunchContained).toBe(true);
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_ABSENT',
    );
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a pending generation, and a proven one followed by a pending one', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);

    // Prompt case 6: opened, never confirmed. What a killed run leaves.
    beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_UNPROVEN',
    );

    releaseRepositoryExecutionLease(evidence);

    // Prompt case 7: one contained generation, then an unproven one.
    const second = leaseOf(repository, 'run-2');
    containedLaunch(repository, second.evidence);
    beginWriterLaunch(repository, second.evidence, { writerId: 'claude', now: tick });
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_UNPROVEN',
    );
    releaseRepositoryExecutionLease(second.evidence);
  });

  it('refuses when a publish or a clear failed and left an older positive record', () => {
    // Prompt cases 10 and 11. Both are simulated at the effect rather than at
    // the seam: what a failed publish and a failed clear *leave behind* is an
    // older positive containment record, and that is what is built here.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);

    // Launch 1: contained, recorded, confirmed.
    containedLaunch(repository, evidence);
    expect(
      recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('RECORDED');
    const positive = readFileSync(recordPathOf(repository));

    // Launch 2: opened, and neither confirmed nor recorded — the publish failed.
    beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_UNPROVEN',
    );

    // And the clear that should have removed the stale positive failed too: the
    // record is put back exactly as it was.
    clearContainmentEvidence(repository, evidence);
    writeFileSync(recordPathOf(repository), positive);
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_UNPROVEN',
    );
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a transplanted, malformed, or future-versioned history', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const subject = subjectOf(repository);

    // Prompt case 12: a history sealed for another lease, dropped in beside this
    // one. Every value in it is genuine; only the lease it belongs to is wrong.
    writeLedger(repository, {
      ...sealed({ entries: [CONTAINED_ENTRY] }, { ...subject, ownerNonce: 'f'.repeat(64) }),
    });
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_NOT_THIS_LEASE',
    );

    // Prompt case 13: torn. Half a file is not half a proof.
    writeLedger(repository, '{"ledgerVersion": 1, "entr');
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_MALFORMED',
    );

    // Prompt case 14: written by a build this one does not understand.
    writeLedger(repository, {
      ...sealed({ entries: [] }, subject),
      ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION + 1,
    });
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_UNSUPPORTED_VERSION',
    );

    // A history about another run, correctly sealed for this lease's key.
    writeLedger(repository, sealed({ runId: 'somebody-elses-run' }, subject));
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LAUNCH_HISTORY_NOT_THIS_RUN',
    );
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses an unparseable lease permanently, including the crash artefact', () => {
    const repository = repositoryFixture();
    // The zero-byte file a crash between the exclusive create and the record
    // write leaves. It is the case the withdrawn `lease break` most wanted, and
    // it stays refused: no nonce to bind a removal to, no history to prove
    // anything with.
    writeFileSync(leasePathOf(repository), '');
    const assessed = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(assessed.refusal).toBe('LEASE_UNPARSEABLE');
    expect(assessed.launchHistory).toBeNull();

    // And a history sitting beside it changes nothing, because the predicate
    // never gets that far.
    writeLedger(repository, sealed({ entries: [CONTAINED_ENTRY] }));
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'LEASE_UNPARSEABLE',
    );
  });

  it('refuses an empty repository and an unusable location', () => {
    const repository = repositoryFixture();
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).refusal).toBe(
      'NOTHING_TO_RECOVER',
    );
    expect(
      assessStaleLeaseRecovery(
        { gitCommonDir: '', root: '', id: 'none' },
        { processAlive: dead },
      ).refusal,
    ).toBe('LOCATION_UNSUITABLE');
  });

  it('produces every refusal in the closed set from a real input', () => {
    /**
     * The counterpart of the readings case above, and it was missing — which a
     * review noticed by mutating `refusalForHistory` so that
     * `HISTORY_INCOMPLETE` reported `LAUNCH_HISTORY_ABSENT`, and finding every
     * case green. Three members had no producer at all, and the sharpest of them
     * is `LAUNCH_HISTORY_INCOMPLETE`: it is the state the whole `historyComplete`
     * mechanism exists to create, so a rebuild after a lost ledger is the one
     * refusal an operator most needs named correctly.
     *
     * The *decision* was already pinned by value — `provesEveryLaunchContained`
     * answers `false` for that reading — so what was unpinned is the reason. This
     * pins every member of the union to an input that produces it.
     */
    const stale = repositoryFixture();
    staleLease(stale, (evidence) => containedLaunch(stale, evidence));
    const subject = subjectOf(stale);
    /**
     * ── Why the history cases supply a liveness and the others do not ───────
     *
     * `staleLease` names an owner pid measured `NOT_FOUND` at the moment the
     * fixture is built. That measurement expires. Windows reuses a pid, and the
     * one it reuses first is the one that just became free — so under the loaded
     * gate the real probe can answer `ALIVE` for this same pid a moment later,
     * and liveness is the *first* conjunct of the predicate. Every history
     * refusal below then arrives as `OWNER_RUNNING`, which is what was observed:
     * this case went red on `LAUNCH_HISTORY_UNSUPPORTED_VERSION` with
     * `OWNER_RUNNING` in its place, in a gate run where the product was correct.
     *
     * So the cases whose subject is the *history* take the controlled seam the
     * neighbouring readings take — the reporting path lets a probe substitute
     * outright, and `dead` is the fact the fixture already established, now
     * stated rather than re-measured at an arbitrary later instant.
     *
     * The cases whose subject *is* the liveness keep the real probe:
     * `OWNER_RUNNING` is produced by a genuinely held lease, and
     * `OWNER_LIVENESS_UNDETERMINED` by the one answer that cannot be measured.
     * The location, lease-shape and empty-repository cases are left alone
     * because the predicate refuses them before it ever reaches a pid.
     */
    const ledgerSays = (raw: unknown): StaleRecoveryRefusal | null => {
      writeLedger(stale, raw);
      return assessStaleLeaseRecovery(stale, { processAlive: dead }).refusal;
    };

    // A history rebuilt after its file was lost: `historyComplete: false`,
    // permanently, which is what stops a lost ledger reading as a fresh proof.
    const incomplete = repositoryFixture();
    staleLease(incomplete, (evidence) => {
      containedLaunch(incomplete, evidence);
      rmSync(ledgerPathOf(incomplete));
      containedLaunch(incomplete, evidence);
    });

    const unparseable = repositoryFixture();
    writeFileSync(leasePathOf(unparseable), '');
    const unreadable = repositoryFixture();
    mkdirSync(leasePathOf(unreadable), { recursive: true });
    const pending = repositoryFixture();
    staleLease(pending, (evidence) => {
      beginWriterLaunch(pending, evidence, { writerId: 'claude', now: tick });
    });
    const legacy = repositoryFixture();
    staleLease(legacy);
    rmSync(ledgerPathOf(legacy));
    // One fixture for both LAUNCH_TREE_ refusals, because what separates them is
    // precisely the liveness answer and nothing else: same dead owner, same
    // established launch, same recorded pids. Two fixtures would let a defect
    // that mixed the two look like two independent passes.
    const unended = repositoryFixture();
    const unendedOwner = staleLease(unended, (evidence) => {
      establishedLaunch(unended, evidence, { helperPid: 4242, childPid: 4343 });
    });
    /** Dead owner, and whatever the caller wants said about the recorded tree. */
    const treeSays =
      (tree: ProcessLiveness) =>
      (pid: number): ProcessLiveness =>
        pid === unendedOwner ? 'NOT_FOUND' : tree;
    const live = repositoryFixture();
    const held = leaseOf(live);

    const produced: Readonly<Record<StaleRecoveryRefusal, StaleRecoveryRefusal | null>> = {
      NOTHING_TO_RECOVER: assessStaleLeaseRecovery(repositoryFixture()).refusal,
      OWNER_RUNNING: assessStaleLeaseRecovery(live).refusal,
      // The reporting path lets a probe substitute outright; the destructive one
      // does not. Both halves of that asymmetry are measured elsewhere in this
      // file — here it is simply the only way to name this liveness.
      OWNER_LIVENESS_UNDETERMINED: assessStaleLeaseRecovery(live, { processAlive: undetermined })
        .refusal,
      LEASE_UNPARSEABLE: assessStaleLeaseRecovery(unparseable).refusal,
      LEASE_UNREADABLE: assessStaleLeaseRecovery(unreadable).refusal,
      LOCATION_UNSUITABLE: assessStaleLeaseRecovery({ gitCommonDir: '', root: '', id: 'none' })
        .refusal,
      LOCATION_NETWORK_UNSUPPORTED: assessStaleLeaseRecovery({
        gitCommonDir: '\\\\server\\share\\repo\\.git',
        root: '\\\\server\\share\\repo',
        id: 'unc',
      }).refusal,
      LOCATION_DEVICE_NAMESPACE: assessStaleLeaseRecovery({
        gitCommonDir: '\\\\.\\PhysicalDrive0',
        root: '\\\\.\\PhysicalDrive0',
        id: 'device',
      }).refusal,
      LAUNCH_HISTORY_ABSENT: assessStaleLeaseRecovery(legacy, { processAlive: dead }).refusal,
      LAUNCH_HISTORY_INCOMPLETE: assessStaleLeaseRecovery(incomplete, { processAlive: dead })
        .refusal,
      LAUNCH_HISTORY_UNPROVEN: assessStaleLeaseRecovery(pending, { processAlive: dead }).refusal,
      LAUNCH_TREE_STILL_RUNNING: assessStaleLeaseRecovery(unended, {
        processAlive: treeSays('ALIVE'),
      }).refusal,
      LAUNCH_TREE_LIVENESS_UNDETERMINED: assessStaleLeaseRecovery(unended, {
        processAlive: treeSays('UNDETERMINED'),
      }).refusal,
      LAUNCH_HISTORY_UNSUPPORTED_VERSION: ledgerSays({
        ...sealed({ entries: [] }, subject),
        ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION + 1,
      }),
      LAUNCH_HISTORY_MALFORMED: ledgerSays('{"ledgerVersion": 1, "entr'),
      LAUNCH_HISTORY_NOT_THIS_LEASE: ledgerSays(
        sealed({ entries: [] }, { ...subject, ownerNonce: 'f'.repeat(64) }),
      ),
      LAUNCH_HISTORY_NOT_THIS_RUN: ledgerSays(
        sealed({ entries: [], ownerPid: subject.ownerPid, runId: 'somebody-elses' }, subject),
      ),
    };

    // Every member of the union is produced by something, so no refusal is a name
    // with no input behind it — and each is produced by *its own* input, which is
    // what the mutant that reported one member as another walked through.
    expect(Object.keys(produced).sort()).toEqual([...STALE_RECOVERY_REFUSALS].sort());
    for (const [refusal, observed] of Object.entries(produced)) {
      expect(observed).toBe(refusal);
    }
    releaseRepositoryExecutionLease(held.evidence);
  });

  it('permits a recovery through the established arm when the recorded tree is gone', () => {
    // The positive case for the arm M2 slice 1 added, in process. Without it the
    // arm could refuse in every reachable situation and the suite would stay
    // green: every other case here asserts a REFUSAL, and an arm that never
    // permits satisfies all of them.
    const repository = repositoryFixture();
    const owner = staleLease(repository, (evidence) => {
      establishedLaunch(repository, evidence, { helperPid: 60_001, childPid: 60_002 });
    });
    expect(owner).not.toBe(60_001);
    expect(owner).not.toBe(60_002);

    const assessed = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(assessed.launchHistory).toBe('LAUNCHES_CONTAINED_SOME_UNENDED');
    expect(assessed.verdict).toBe('SAFE_TO_RECOVER');
    expect(assessed.refusal).toBeNull();
  });

  it('refuses when EITHER recorded process of an unended launch is alive', () => {
    // Two cases, and they exist because one is not enough. A predicate that
    // probed only the helper passes the child-alive case; one that probed only
    // the child passes the helper-alive case; and a single case with both alive
    // passes for either. Both mutants were measured surviving the whole suite
    // before these two cases existed.
    const repository = repositoryFixture();
    const owner = staleLease(repository, (evidence) => {
      establishedLaunch(repository, evidence, { helperPid: 60_001, childPid: 60_002 });
    });
    /** Dead everywhere except one pid, so each case names exactly one survivor. */
    const onlyAlive =
      (target: number) =>
      (pid: number): ProcessLiveness =>
        pid === target ? 'ALIVE' : 'NOT_FOUND';

    expect(owner).not.toBe(60_001);
    expect(owner).not.toBe(60_002);
    expect(assessStaleLeaseRecovery(repository, { processAlive: onlyAlive(60_001) }).refusal).toBe(
      'LAUNCH_TREE_STILL_RUNNING',
    );
    expect(assessStaleLeaseRecovery(repository, { processAlive: onlyAlive(60_002) }).refusal).toBe(
      'LAUNCH_TREE_STILL_RUNNING',
    );
    // And the control that makes those two attributable: the same lease, the
    // same ledger, nothing alive.
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).verdict).toBe(
      'SAFE_TO_RECOVER',
    );
  });

  it('answers a verdict of SAFE exactly when it answers no refusal', () => {
    // The union is refusals only, so "permitted" has one spelling and cannot be
    // reached by a value somebody added. Pinned by value across every refusal
    // this suite can produce, plus the safe case.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const safe = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(safe.verdict).toBe('SAFE_TO_RECOVER');
    expect(safe.refusal).toBeNull();

    const refused = assessStaleLeaseRecovery(repository, { processAlive: alive });
    expect(refused.verdict).toBe('UNSAFE');
    expect(STALE_RECOVERY_REFUSALS).toContain(refused.refusal);
    releaseRepositoryExecutionLease(evidence);
  });
});

/* ──────────────────────── 5. the recovery itself ────────────────────────── */

/**
 * A pid whose process has really exited.
 *
 * Not a large number nobody is using, and not a substituted probe: a real child
 * is started and waited for, and the **real** `osProcessLiveness` is then asked
 * whether it is gone. If the answer is anything else the fixture fails loudly
 * rather than running — a pid reused inside that window would silently turn
 * every case below into a test of the refusal path.
 */
function deadProcessId(): number {
  const finished = spawnSync(process.execPath, ['-e', '0']);
  if (typeof finished.pid !== 'number') throw new Error('fixture could not start a process to end');
  if (osProcessLiveness(finished.pid) !== 'NOT_FOUND') {
    throw new Error('fixture pid was reused before it could be used');
  }
  return finished.pid;
}

/**
 * The lease a run that really died leaves behind, with a history to match.
 *
 * ── Why the cases below cannot use a substituted probe ─────────────────────
 *
 * They used to. `recoverStaleLease` took the same `processAlive` seam the
 * reporting paths take, and a review reproduced what that cost: one call with
 * `() => 'NOT_FOUND'` removed the lease of a demonstrably living process — the
 * caller's own. The liveness answer *is* the first conjunct of the predicate, so
 * a destructive function accepting it accepted the predicate. It no longer does:
 * the real probe is always consulted, and a supplied opinion can only refuse.
 *
 * So a case that wants a removal has to produce a genuinely ownerless lease. It
 * is built the only honest way: a real lease is acquired and real launches are
 * driven under it, the document and the entries it produced are read back, the
 * lease is released, and the record is rewritten naming a process that has
 * exited. Only two facts are fabricated — the owner pid and the digest binding
 * the history to it — and both are the facts a crashed run leaves genuinely
 * stale. The lease bytes are otherwise exactly what `acquire` wrote.
 *
 * What that does *not* measure is the chain end to end: a real acquire, real
 * launches, a real death and a real recovery all in one repository.
 * `tests/dist-artifact/stale-lease-recovery-dist-artifact.mjs` measures that,
 * against the shipped artefact and with an owner process that really exits.
 */
function staleLease(
  repository: LeaseRepository,
  underLease: (evidence: ExecutionLeaseEvidence) => void = () => {},
): number {
  const { evidence } = leaseOf(repository, 'run-stale');
  underLease(evidence);
  return freezeAsStale(repository, evidence);
}

/**
 * Releases this lease and re-writes it as one whose owner is gone.
 *
 * Split out of {@link staleLease} so a case whose work under the lease is
 * `async` can reach the same tail. One implementation, because the re-sealing
 * below is where a fixture most easily lies to itself.
 */
function freezeAsStale(repository: LeaseRepository, evidence: ExecutionLeaseEvidence): number {
  const document = JSON.parse(readFileSync(leasePathOf(repository), 'utf8')) as Record<
    string,
    unknown
  >;
  const ledger = ledgerOf(repository);
  const entries = (ledger?.entries ?? []) as readonly unknown[];
  // Carried across rather than defaulted. `sealed()` forces `historyComplete:
  // true`, so a fixture that let it default would silently *upgrade* an
  // incomplete history — and this helper is the one that would then be unable to
  // produce the `HISTORY_INCOMPLETE` refusal it exists to be able to produce.
  const historyComplete = ledger?.historyComplete === true;
  releaseRepositoryExecutionLease(evidence);

  const ownerPid = deadProcessId();
  writeFileSync(
    leasePathOf(repository),
    `${JSON.stringify({ ...document, ownerPid }, null, 2)}\n`,
    'utf8',
  );
  const runId = (document.runId ?? null) as string | null;
  const subject: WriterLaunchSubject = {
    leaseKey: document.leaseKey as string,
    ownerNonce: document.ownerNonce as string,
    ownerPid,
    runId,
  };
  writeLedger(
    repository,
    sealed(
      {
        entries: entries as WriterLaunchLedgerPayload['entries'],
        historyComplete,
        ownerPid,
        runId,
      },
      subject,
    ),
  );
  return ownerPid;
}

describe('recovery removes exactly the lease it has just proved dead', () => {
  it('removes the stale lease, and nothing else in the directory', () => {
    const repository = repositoryFixture();
    staleLease(repository, (evidence) => containedLaunch(repository, evidence));
    const bystander = join(repository.gitCommonDir, 'HEAD');
    writeFileSync(bystander, 'ref: refs/heads/main\n');
    // The real probe, and nothing supplied. This is a genuinely ownerless lease.
    expect(assessStaleLeaseRecovery(repository).verdict).toBe('SAFE_TO_RECOVER');

    const result = recoverStaleLease(repository);
    expect(result.code).toBe('RECOVERED');
    expect(result.refusal).toBeNull();
    expect(existsSync(leasePathOf(repository))).toBe(false);
    expect(readFileSync(bystander, 'utf8')).toBe('ref: refs/heads/main\n');
    // The companions are deliberately left where they are: once the lease name
    // is free this call owns nothing in that directory. They are inert — bound to
    // a lease that no longer exists — and the next acquisition replaces the
    // history outright.
    expect(existsSync(ledgerPathOf(repository))).toBe(true);
    expect(inspectRepositoryExecutionLease(repository).state).toBe('FREE');
  });

  it('cannot be told a living owner is gone', () => {
    /**
     * The counter-proof for the seam that shipped and was withdrawn inside this
     * slice. `recoverStaleLease(repository, { processAlive: () => 'NOT_FOUND' })`
     * removed a living owner's lease, measured; the parameter that allowed it no
     * longer exists, and the one that replaced it is combined with the operating
     * system's answer by taking the **more refusing** of the two.
     *
     * The owner here is this very process, so `ALIVE` is not an opinion. Delete
     * the combination and use the supplied answer directly and this case goes
     * red with the lease destroyed under a running writer.
     */
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    containedLaunch(repository, evidence);
    const before = readFileSync(leasePathOf(repository));

    const insisted = recoverStaleLease(repository, { additionalLiveness: () => 'NOT_FOUND' });
    expect(insisted.code).toBe('RECOVERY_UNSAFE');
    expect(insisted.refusal).toBe('OWNER_RUNNING');
    expect(readFileSync(leasePathOf(repository)).equals(before)).toBe(true);

    // The asymmetry, measured rather than asserted in a comment. The *reporting*
    // path still lets a caller substitute the probe outright, so the same
    // fabricated answer that changes nothing above changes the report here — and
    // `lease-recovery.ts` states that this is safe precisely because nothing
    // destructive reads it. Both halves in one case, so neither can drift.
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).verdict).toBe(
      'SAFE_TO_RECOVER',
    );
    expect(assessLeaseRecovery(repository, { processAlive: dead }).staleRecovery.verdict).toBe(
      'SAFE_TO_RECOVER',
    );
    expect(existsSync(leasePathOf(repository))).toBe(true);

    // And the direction that *is* allowed: a supplied opinion may refuse a
    // recovery the operating system would have permitted.
    const other = repositoryFixture();
    staleLease(other, (owner) => containedLaunch(other, owner));
    expect(recoverStaleLease(other, { additionalLiveness: () => 'ALIVE' }).refusal).toBe(
      'OWNER_RUNNING',
    );
    expect(
      recoverStaleLease(other, {
        additionalLiveness: () => {
          throw new Error('a probe that misbehaves');
        },
      }).refusal,
    ).toBe('OWNER_LIVENESS_UNDETERMINED');
    // Still there. Both refusals left the lease exactly as they found it.
    expect(existsSync(leasePathOf(other))).toBe(true);
    releaseRepositoryExecutionLease(evidence);
  });

  it('lets the next invocation acquire normally, and grants it nothing', () => {
    const repository = repositoryFixture();
    staleLease(repository, (evidence) => containedLaunch(repository, evidence));
    expect(recoverStaleLease(repository).code).toBe('RECOVERED');

    // Prompt case 17. The recovery removed a dead record and authorised nothing:
    // this acquisition takes its authority from the exclusive create like every
    // other holder, and starts its own history.
    const second = leaseOf(repository, 'run-new');
    expect(inspectRepositoryExecutionLease(repository).runId).toBe('run-new');
    expect(inspectWriterLaunchHistory(repository)).toBe('ALL_LAUNCHES_CONTAINED');
    expect((ledgerOf(repository)?.entries as unknown[]).length).toBe(0);

    // And the recovered repository behaves like any other: a second acquisition
    // is refused while this one is held.
    const again = acquireRepositoryExecutionLease(
      repository,
      { runId: 'run-third', blockId: null },
      { now: tick },
    );
    expect(again.ok).toBe(false);
    releaseRepositoryExecutionLease(second.evidence);
  });

  it('refuses without touching anything when the predicate refuses', () => {
    const repository = repositoryFixture();
    staleLease(repository, (evidence) => {
      beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
    });
    const before = readFileSync(leasePathOf(repository));

    const result = recoverStaleLease(repository);
    expect(result.code).toBe('RECOVERY_UNSAFE');
    expect(result.refusal).toBe('LAUNCH_HISTORY_UNPROVEN');
    expect(readFileSync(leasePathOf(repository)).equals(before)).toBe(true);
    expect(inspectRepositoryExecutionLease(repository).state).toBe('HELD');
  });

  it('aborts when the lease changes between the assessment and the removal', () => {
    /**
     * Prompt case 15, and the counter-proof for the removal's identity binding.
     *
     * The supplied liveness opinion is the injection point:
     * `assessStaleLeaseRecoveryBound` reads the lease's bytes, then asks for
     * liveness, then reads the history — so changing the lease document from
     * inside that call lands in exactly the window the removal has to survive.
     * The assessment holds the *old* bytes and the name now holds different ones.
     *
     * The opinion itself decides nothing: the owner is genuinely gone, so the
     * real probe already answers `NOT_FOUND` and `NOT_FOUND` is the neutral
     * element of the combination. It is used for its timing, not its answer.
     *
     * The replacement keeps the nonce, the owner, the run and the key, so the
     * history still binds and the assessment still says `SAFE_TO_RECOVER`. The
     * only thing that differs is the bytes. Replace the removal's predicate with
     * `() => true` and this case goes **red** — the removal answers `REMOVED`,
     * the call answers `RECOVERED`, and the assertion below fails — which is what
     * makes it a counter-proof rather than a description. Measured: 1 case red.
     */
    const repository = repositoryFixture();
    staleLease(repository, (evidence) => containedLaunch(repository, evidence));
    const leasePath = leasePathOf(repository);

    let swapped = false;
    const swapDuringAssessment = (): ProcessLiveness => {
      if (!swapped) {
        swapped = true;
        const document = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>;
        writeFileSync(leasePath, `${JSON.stringify({ ...document, blockId: 'later' }, null, 2)}\n`);
      }
      return 'NOT_FOUND';
    };

    const result = recoverStaleLease(repository, { additionalLiveness: swapDuringAssessment });
    expect(swapped).toBe(true);
    expect(result.code).toBe('LEASE_CHANGED');
    expect(result.detail).toBe('CHANGED');
    // Put back, not destroyed. The record the removal detached was not the one
    // it was allowed to remove, so it is where it was.
    expect(existsSync(leasePath)).toBe(true);
    expect(
      (JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>).blockId,
    ).toBe('later');
  });

  it('aborts when another owner takes the lease before the history is read', () => {
    // The same window, one step earlier, and caught by a different mechanism: a
    // genuine successor has a different nonce, so the history beside the lease no
    // longer binds to the lease the assessment started reading.
    const repository = repositoryFixture();
    staleLease(repository, (evidence) => containedLaunch(repository, evidence));

    let taken = false;
    const takeOverDuringAssessment = (): ProcessLiveness => {
      if (!taken) {
        taken = true;
        rmSync(leasePathOf(repository));
        leaseOf(repository, 'run-successor');
      }
      return 'NOT_FOUND';
    };

    const result = recoverStaleLease(repository, { additionalLiveness: takeOverDuringAssessment });
    expect(taken).toBe(true);
    expect(result.code).toBe('RECOVERY_UNSAFE');
    expect(result.refusal).toBe('LAUNCH_HISTORY_NOT_THIS_LEASE');
    // The successor's lease is untouched.
    expect(inspectRepositoryExecutionLease(repository).runId).toBe('run-successor');
  });

  it('takes no verdict from a caller, so a stale one cannot be acted on', () => {
    // The withdrawn `lease break` took an authorisation minted earlier and acted
    // on it later. This takes a repository and proves everything itself, inside
    // the call that removes.
    //
    // Two pins, and they are pinned by two different gates. Saying which is
    // which is the point: an earlier version asserted `recoverStaleLease.length
    // === 1`, which `Function.length` satisfies for any number of *optional*
    // parameters — so it read as runtime coverage, was green for the very seam it
    // excluded, and stayed green through a round in which that seam could remove
    // a living owner's lease.
    //
    // (1) The **shape**, which `npm run typecheck` holds and this suite does not:
    // the object below is written here, so `Object.keys` on it can only ever
    // answer what it was given. What refuses a `verdict` key is `satisfies`, at
    // compile time. A review measured that too — adding a field to
    // `StaleRecoveryDependencies` leaves all cases green and fails `tsc`.
    const shape = Object.keys(
      { additionalLiveness: undefined } satisfies Record<
        keyof NonNullable<Parameters<typeof recoverStaleLease>[1]>,
        undefined
      >,
    );
    expect(shape).toEqual(['additionalLiveness']);

    // (2) The **behaviour**, which this suite does hold: a key nobody declared is
    // not honoured. A hostile deps object carrying every shape a smuggled verdict
    // could take changes nothing about a lease whose owner is alive.
    const smuggled = repositoryFixture();
    const held = leaseOf(smuggled);
    containedLaunch(smuggled, held.evidence);
    const untouched = readFileSync(leasePathOf(smuggled));
    for (const hostile of [
      { verdict: 'SAFE_TO_RECOVER' },
      { assessment: { verdict: 'SAFE_TO_RECOVER', refusal: null } },
      { processAlive: () => 'NOT_FOUND' as const },
      { force: true },
      { additionalLiveness: () => 'NOT_FOUND' as const, verdict: 'SAFE_TO_RECOVER' },
    ]) {
      const result = recoverStaleLease(smuggled, hostile as never);
      expect(result.code).toBe('RECOVERY_UNSAFE');
      expect(result.refusal).toBe('OWNER_RUNNING');
    }
    expect(readFileSync(leasePathOf(smuggled)).equals(untouched)).toBe(true);
    releaseRepositoryExecutionLease(held.evidence);

    // And the reported assessment is the one this call made, not one handed in:
    // a refusal carries the refusal that produced it.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    const refused = recoverStaleLease(repository);
    expect(refused.assessment.refusal).toBe('OWNER_RUNNING');
    expect(refused.refusal).toBe('OWNER_RUNNING');
    releaseRepositoryExecutionLease(evidence);
  });

  it('names every outcome code, and reports nothing as a success that is not one', () => {
    expect([...STALE_LEASE_RECOVERY_CODES].sort()).toEqual([
      'LEASE_CHANGED',
      'LEASE_DISPLACED',
      'RECOVERED',
      'RECOVERY_FAILED',
      'RECOVERY_UNSAFE',
    ]);
    // `LEASE_DISPLACED` is its own member rather than a shade of
    // `LEASE_CHANGED`, and the reason is an end state, not a nuance: a record was
    // detached, could not be put back, and is being kept in a quarantine file, so
    // a writer is displaced and there is a file inside `.git`. It was folded into
    // `LEASE_CHANGED` for one round, under that member's sentence saying nothing
    // had been moved — which is the "one code for two end states" defect
    // `VerifiedRemoval` split its own members apart for, reintroduced by the one
    // caller that acts on a lease it never held.
    //
    // No case here reaches it through `recoverStaleLease`: it needs a restore to
    // fail, which `tests/v2-07lr-remediation.test.ts` produces by squatting the
    // freed name *from inside the predicate* — and this call's predicate is not a
    // caller's to hook. So the mapping is pinned instead of the arm, by value,
    // below. Without that, collapsing the two members back into `LEASE_CHANGED`
    // leaves every case in this file green — measured, which is why the switch
    // that used to be there is now a table.
    expect(
      Object.fromEntries(
        (
          [
            'REMOVED',
            'ABSENT',
            'CHANGED',
            'CHANGED_QUARANTINED',
            'CHANGED_AND_UNOWNED',
            'DETACH_FAILED',
            'UNIDENTIFIABLE',
            'UNIDENTIFIABLE_QUARANTINED',
            'UNIDENTIFIABLE_AND_UNOWNED',
          ] as const
        ).map((removal) => [removal, staleRecoveryOutcomeFor(removal)]),
      ),
    ).toEqual({
      REMOVED: 'RECOVERED',
      ABSENT: 'LEASE_CHANGED',
      CHANGED: 'LEASE_CHANGED',
      CHANGED_QUARANTINED: 'LEASE_DISPLACED',
      CHANGED_AND_UNOWNED: 'LEASE_DISPLACED',
      DETACH_FAILED: 'RECOVERY_FAILED',
      UNIDENTIFIABLE: 'RECOVERY_FAILED',
      UNIDENTIFIABLE_QUARANTINED: 'RECOVERY_FAILED',
      UNIDENTIFIABLE_AND_UNOWNED: 'RECOVERY_FAILED',
    });
    // Exactly one member means this call removed the lease. A second one
    // arriving in that column is a removal being reported as a recovery.
    expect(
      (['REMOVED', 'ABSENT', 'CHANGED', 'CHANGED_QUARANTINED'] as const).filter(
        (removal) => staleRecoveryOutcomeFor(removal) === 'RECOVERED',
      ),
    ).toEqual(['REMOVED']);
    // Exactly one of them means the lease is gone by this call's doing. The
    // discrimination matters: `LEASE_CHANGED` also leaves a repository somebody
    // else may hold, and reporting it as a recovery would tell an operator they
    // had cleared something they had not touched.
    const repository = repositoryFixture();
    expect(recoverStaleLease(repository).code).toBe('RECOVERY_UNSAFE');
  });
});

/* ──────────────────── 6. what an operator is actually told ──────────────── */

describe('the recovery vocabulary says what the code does', () => {
  it('has a sentence for every refusal and every outcome, and no spare ones', () => {
    // Total by type is not correct by value — `Readonly<Record<…, string>>`
    // accepts the empty string in every row and accepts one member's sentence
    // pasted into another's. Pinned by key here and by content below.
    expect(Object.keys(STALE_RECOVERY_SENTENCES).sort()).toEqual([...STALE_RECOVERY_REFUSALS].sort());
    expect(Object.keys(STALE_RECOVERY_OUTCOMES).sort()).toEqual([...STALE_LEASE_RECOVERY_CODES].sort());
    // No two refusals share a sentence: a duplicated one is how two different
    // facts start being reported as the same fact.
    const sentences = Object.values(STALE_RECOVERY_SENTENCES);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('keeps the printed vocabulary ASCII', () => {
    // This repository has twice had text damaged by a re-encoding pass, and an
    // operator-facing refusal is the worst place for that. The pre-existing pin
    // in `tests/v2-07l-execution-lease.test.ts` enumerates the three older
    // tables by name and did not grow to cover these two.
    for (const text of [
      ...Object.values(STALE_RECOVERY_SENTENCES),
      ...Object.values(STALE_RECOVERY_OUTCOMES),
      renderLeaseRecovery(
        { verdict: 'SAFE_TO_RECOVER', refusal: null, path: 'D:\\r\\.git', ownerPid: 1, runId: 'r', launchHistory: 'ALL_LAUNCHES_CONTAINED' },
        'ALL_LAUNCHES_CONTAINED',
      ),
    ]) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    }
  });

  it('claims only what the launch history proves: the writer, not every agent', () => {
    // The narrowing the ledger's own header insists on, printed to the one
    // reader who cannot check it. An earlier draft said "no agent process it
    // started can still be running", which is the wider claim the format
    // refuses to make — the reviewer is an agent and is not in the history.
    const safe = renderLeaseRecovery(
      { verdict: 'SAFE_TO_RECOVER', refusal: null, path: 'D:\\r\\.git', ownerPid: 7, runId: 'r', launchHistory: 'ALL_LAUNCHES_CONTAINED' },
      'ALL_LAUNCHES_CONTAINED',
    );
    expect(safe).toContain('no writer process it started can still be running');
    expect(safe).not.toContain('no agent process');
    // And it names the command an operator would then run, on one line, so the
    // pin that checks every named command against the real program can see it.
    expect(safe).toContain('`agent-loop lease recover --repository <path>`');
    expect(safe).toContain('Launches     : ALL_LAUNCHES_CONTAINED');
    // The stronger arm says the endings were seen, because on this arm they were.
    expect(safe).toContain('was seen to end');
  });

  it('gives the established arm its own reason, not the one it has not earned', () => {
    // One sentence covered both arms and said "every writer launch under this
    // lease is proved contained" for each. On the arm M2 slice 1 added, the
    // endings were never observed and the tree's absence comes from probing the
    // recorded pids — so the stronger sentence printed the one thing that arm
    // does not prove, to the reader least able to check it.
    const unended = renderLeaseRecovery(
      {
        verdict: 'SAFE_TO_RECOVER',
        refusal: null,
        path: 'D:\\r\\.git',
        ownerPid: 7,
        runId: 'r',
        launchHistory: 'LAUNCHES_CONTAINED_SOME_UNENDED',
      },
      'LAUNCHES_CONTAINED_SOME_UNENDED',
    );
    expect(unended).toContain('Launches     : LAUNCHES_CONTAINED_SOME_UNENDED');
    expect(unended).toContain('never seen to end');
    expect(unended).toContain('checked just now and do not exist');
    // The load-bearing negative: it must NOT claim the endings were observed.
    expect(unended).not.toContain('was seen to end');
    // The conclusion is the same on both arms, and stays.
    expect(unended).toContain('no writer process it started can still be running');
    expect(unended).toContain('`agent-loop lease recover --repository <path>`');
  });

  it('chooses the reason from the assessment, never from the reading beside it', () => {
    // The two inputs are two different reads of the ledger: `lease status` fills
    // the second from its own `inspectWriterLaunchHistory` call, so they can
    // disagree, and the sentence must come from the one the verdict was computed
    // from. Selecting on the parameter instead produced two false prints, both
    // reproduced by a review: a safe UNENDED verdict whose re-read returned
    // `null` fell through to the STRONGER sentence, and a safe ENDED verdict
    // whose re-read had moved on claimed pids had been probed when none were.
    //
    // Both cases below pass MISMATCHED inputs on purpose. That pairing cannot
    // arise from one read, which is exactly why it is the pairing that separates
    // the two implementations.
    const safeUnendedWithNoReread = renderLeaseRecovery(
      {
        verdict: 'SAFE_TO_RECOVER',
        refusal: null,
        path: 'D:\r\.git',
        ownerPid: 7,
        runId: 'r',
        launchHistory: 'LAUNCHES_CONTAINED_SOME_UNENDED',
      },
      null,
    );
    expect(safeUnendedWithNoReread).toContain('never seen to end');
    expect(safeUnendedWithNoReread).not.toContain('was seen to end');

    const safeEndedWithMovedReread = renderLeaseRecovery(
      {
        verdict: 'SAFE_TO_RECOVER',
        refusal: null,
        path: 'D:\r\.git',
        ownerPid: 7,
        runId: 'r',
        launchHistory: 'ALL_LAUNCHES_CONTAINED',
      },
      'LAUNCHES_CONTAINED_SOME_UNENDED',
    );
    expect(safeEndedWithMovedReread).toContain('was seen to end');
    expect(safeEndedWithMovedReread).not.toContain('checked just now');
    // The `Launches` line still reports the fresh read, which is what it is for.
    expect(safeEndedWithMovedReread).toContain('Launches     : LAUNCHES_CONTAINED_SOME_UNENDED');
  });

  it('claims no proof at all for a safe verdict it cannot explain', () => {
    // Reachable only if the predicate and the renderer's table disagree about
    // which readings license a removal. The direction is the point: an
    // unexplained safe verdict must not borrow the strongest sentence available.
    const unexplained = renderLeaseRecovery(
      {
        verdict: 'SAFE_TO_RECOVER',
        refusal: null,
        path: 'D:\r\.git',
        ownerPid: 7,
        runId: 'r',
        launchHistory: 'LAUNCH_UNPROVEN',
      },
      'LAUNCH_UNPROVEN',
    );
    expect(unexplained).toContain('cannot say which proof it rests on');
    expect(unexplained).not.toContain('was seen to end');
    expect(unexplained).not.toContain('checked just now');
  });

  it('reports the launch history even when the predicate stopped before reading one', () => {
    // A living owner refuses at the liveness conjunct, so the assessment carries
    // no reading. "Is this run's bookkeeping intact" is a question about a
    // healthy repository too, which is why the report reads it separately.
    const report = renderLeaseRecovery(
      { verdict: 'UNSAFE', refusal: 'OWNER_RUNNING', path: 'D:\\r\\.git', ownerPid: 7, runId: 'r', launchHistory: null },
      'LAUNCH_UNPROVEN',
    );
    expect(report).toContain('Launches     : LAUNCH_UNPROVEN');
    expect(report).toContain('Recovery     : OWNER_RUNNING');
    expect(report).toContain(STALE_RECOVERY_SENTENCES.OWNER_RUNNING);
    // And `none` rather than a blank when there is no lease to read one from.
    expect(
      renderLeaseRecovery(
        { verdict: 'UNSAFE', refusal: 'NOTHING_TO_RECOVER', path: '', ownerPid: null, runId: null, launchHistory: null },
        null,
      ),
    ).toContain('Launches     : none');
  });

  it('reports a refused recovery with the refusal, not with a bare code', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository);
    // The owner is this process, so the real probe answers `ALIVE` and no
    // opinion has to be supplied to reach the refusal being rendered.
    const rendered = renderLeaseRecoveryResult(recoverStaleLease(repository));
    expect(rendered).toContain('Recovery     : RECOVERY_UNSAFE');
    expect(rendered).toContain('Reason       : OWNER_RUNNING');
    expect(rendered).toContain(STALE_RECOVERY_OUTCOMES.RECOVERY_UNSAFE);
    expect(rendered).toContain(STALE_RECOVERY_SENTENCES.OWNER_RUNNING);
    releaseRepositoryExecutionLease(evidence);

    // And the other label. `detail` is unconditional, so a success would read
    // `Reason : REMOVED` - a fault's word over a success - which is why the line
    // switches. Deleting the ternary left this branch rendered by nothing.
    const recovered = repositoryFixture();
    staleLease(recovered, (owner) => containedLaunch(recovered, owner));
    const success = renderLeaseRecoveryResult(recoverStaleLease(recovered));
    expect(success).toContain('Recovery     : RECOVERED');
    expect(success).toContain('End state    : REMOVED');
    expect(success).not.toContain('Reason');
  });

  it('names no command that the shipped program does not register', async () => {
    // The same property `tests/v2-07l-execution-lease.test.ts` holds for the
    // older tables, applied to these two — and applied to the *rendered* text
    // rather than to the literals, because the sentence that matters here wraps
    // across a line and a scan of the source would read `lease\n  recover`.
    const { buildProgram } = await import('../src/cli/index.js');
    const lease = buildProgram().commands.find((command) => command.name() === 'lease');
    const registered = new Set((lease?.commands ?? []).map((command) => command.name()));

    const rendered = [
      ...Object.values(STALE_RECOVERY_SENTENCES),
      ...Object.values(STALE_RECOVERY_OUTCOMES),
      renderLeaseRecovery(
        { verdict: 'SAFE_TO_RECOVER', refusal: null, path: 'p', ownerPid: 1, runId: 'r', launchHistory: 'ALL_LAUNCHES_CONTAINED' },
        'ALL_LAUNCHES_CONTAINED',
      ),
    ].join('\n');
    const named = [...rendered.matchAll(/agent-loop lease\s+([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(registered).toContain(name);
  });
});

/* ────────────────── 7. the boundaries this slice does not cross ─────────── */

describe('recovery stays inside the contract it was given', () => {
  it('keeps containment out of writer authority', () => {
    // A recovered repository is unowned, not owned by the recoverer. There is no
    // evidence handed back by `recoverStaleLease` and no field of its result that
    // could be mistaken for one.
    const repository = repositoryFixture();
    staleLease(repository, (evidence) => containedLaunch(repository, evidence));
    const result = recoverStaleLease(repository);

    expect(result.code).toBe('RECOVERED');
    expect(Object.keys(result).sort()).toEqual(['assessment', 'code', 'detail', 'refusal']);
    expect(Object.keys(result).filter((name) => /evidence|lease$|authority/i.test(name))).toEqual(
      [],
    );
    expect(inspectRepositoryExecutionLease(repository).state).toBe('FREE');
  });

  it('leaves READY_FOR_PR terminal and adds no transition', async () => {
    // The governance boundary the slice was told to respect rather than
    // reinterpret. Recovery is about a lease; it is not a task-state concept.
    const { getAllowedTransitions } = await import('../src/core/transitions.js');
    expect(getAllowedTransitions('READY_FOR_PR')).toEqual([]);
  });

  it('adds no importer of the old process-tree termination module', () => {
    /**
     * Named in the slice's scope limits: the withdrawn Windows tree-kill cleanup
     * is not taken on here. The recovery kills nothing — it removes a record
     * whose subject the kernel already destroyed.
     *
     * This used to assert that `execution-lease.ts` exported no name matching
     * `/kill|terminate|taskkill/`, which measured nothing of the sort: it said
     * nothing about importers, nothing about reachability, and never named the
     * module. Deleting the scope limit entirely would have left it green. An
     * adversarial review called it exactly the vacuous-absence shape this file's
     * own header disavows, and it was right.
     *
     * So it uses the instrument `tests/v2-07lr-lease-recovery.test.ts` already
     * uses for the same class of claim: walk the shipped source, strip comments —
     * explaining a module is not importing it — and require the importer set to
     * be the one that existed before this slice.
     */
    // Nothing names it. The scan reads file *contents* with comments stripped —
    // explaining a module is not importing it — and the module's own definition
    // does not mention its own name, so an empty answer here is the true one.
    expect([...namingModule('windows-process-tree-termination')].sort()).toEqual([]);

    // The positive control, without which the assertion above is a scan that
    // found nothing because it can find nothing. The same instrument, pointed at
    // a module this slice certainly does reach, must come back non-empty.
    expect(namingModule('writer-launch-ledger').length).toBeGreaterThan(1);
  });
});

/**
 * The shipped source files that name `module`, with comments stripped.
 *
 * The same instrument `tests/v2-07lr-lease-recovery.test.ts` uses, and comments
 * are removed for the reason it gives: explaining a mechanism is not importing
 * it, and a scan that counted prose would report the file that documents a
 * module as one of its callers.
 */
function namingModule(module: string): readonly string[] {
  const pattern = new RegExp(module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const found: string[] = [];
  for (const file of sourceFiles(join(PACKAGE_ROOT, 'src'))) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[^\n]*\/\/.*$/gm, '');
    if (pattern.test(code)) found.push(relative(PACKAGE_ROOT, file));
  }
  return found;
}

/** Every `.ts` under a directory, for the reachability scans above. */
function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}
