/**
 * M2 slice 2: every AO-owned subprocess of an execution epoch is accounted for,
 * and a stale lease is not removed while one of them may still be running.
 *
 * ── What was measured before any of this was written ───────────────────────
 *
 * On `main` at `fba4cfd`, with real processes and the shipped artefact: a real
 * lease, a real writer launch run to its end and confirmed `CONTAINED`, then a
 * real verification subprocess started through the production path
 * (`verify/verify-command.ts` -> `doctor/exec.ts` -> the owned boundary), the
 * owner killed with `taskkill /F` and no `/T`. The writer history read
 * `ALL_LAUNCHES_CONTAINED`, `assessStaleLeaseRecovery` answered
 * `SAFE_TO_RECOVER`, and `agent-loop lease recover` deleted the lease — having
 * probed exactly one process, the owner, and nothing else. Nothing in the
 * predicate named the verification subprocess and nothing ever could.
 *
 * The subprocess had in fact already died, from a coupling
 * `native/ao-launch/AoLaunch.cs` owns and the predicate never consults. That is
 * why this is a defect and not merely a wording bug: the same inference is
 * *refused* everywhere else in this build — for a writer launch that was
 * established and never seen to end, the predicate re-probes the recorded pids
 * "rather than inheriting that measurement".
 *
 * ── What this file pins ────────────────────────────────────────────────────
 *
 * The format, the seam, and the refusal, in that order. The real-process half —
 * a real owner killed while a real owned subprocess of the same epoch is
 * running — is `tests/dist-artifact/crash-recovery-dist-artifact.mjs`, because
 * everything about it is a claim about processes that outlive the process
 * making the assertion.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mintContainmentAttestation } from '../src/core/internal/containment-attestation.js';
import type { ContainmentAttestation } from '../src/core/containment-attestation.js';
import {
  acquireRepositoryExecutionLease,
  announceOwnedLaunch,
  assessStaleLeaseRecovery,
  attestOwnedLaunchEstablished,
  attestWriterLaunchEstablished,
  beginWriterLaunch,
  confirmWriterLaunch,
  deriveExecutionLeaseLocation,
  inspectOwnedLaunchRegister,
  OWNED_LAUNCH_CODES,
  recoverStaleLease,
  releaseRepositoryExecutionLease,
  settleOwnedLaunch,
  STALE_RECOVERY_REFUSALS,
  WRITER_LAUNCH_LEDGER_FILE_NAME,
  type LeaseRepository,
  type ProcessLiveness,
} from '../src/lease/execution-lease.js';
import {
  MAX_OPEN_OWNED_LAUNCHES,
  OWNED_LAUNCH_READINGS,
  admissibleOpenSet,
  openLaunchBindingFields,
  openOwnedLaunchesOf,
  provesNoOwnedLaunchOpen,
  provesOwnedLaunchesOpenUnended,
  readOpenSet,
  type OpenOwnedLaunch,
} from '../src/lease/owned-launch-register.js';
import {
  openOwnedProcessesOf,
  readOwnedLaunchRegister,
  readWriterLaunchLedger,
  writerLaunchBinding,
  WRITER_LAUNCH_LEDGER_VERSION,
  type WriterLaunchLedgerPayload,
  type WriterLaunchSubject,
} from '../src/lease/writer-launch-ledger.js';
import {
  installOwnedLaunchAccountant,
  installedOwnedLaunchAccountants,
  openOwnedLaunch,
  type OwnedLaunchOpening,
} from '../src/boundary/owned-launch-accounting.js';
import { endingWasAccountedFor, runCommand, type CommandResult } from '../src/doctor/exec.js';
import { createProbeEnv } from '../src/auth/env-guard.js';
import type { ExecutionLeaseEvidence } from '../src/core/execution-lease-evidence.js';

/* ───────────────────────────── fixtures ─────────────────────────────────── */

const roots: string[] = [];

function repositoryFixture(id = 'm2-02'): LeaseRepository {
  const root = mkdtempSync(join(tmpdir(), 'ao-m2-02-'));
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
      /* a fixture we cannot remove is inert */
    }
  }
});

let clock = 0;
const tick = (): string => new Date(Date.UTC(2026, 7, 30, 0, 0, clock++)).toISOString();
let launch = 0;
const nonce = (): string => (launch++).toString(16).padStart(16, '0');

function leaseOf(repository: LeaseRepository, runId: string | null = 'run-1'): ExecutionLeaseEvidence {
  const acquired = acquireRepositoryExecutionLease(repository, { runId, blockId: null }, { now: tick });
  if (!acquired.ok) throw new Error(`fixture could not take the lease: ${acquired.code}`);
  return acquired.evidence;
}

function leasePathOf(repository: LeaseRepository): string {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return location.path;
}

const ledgerPathOf = (repository: LeaseRepository): string =>
  join(repository.gitCommonDir, WRITER_LAUNCH_LEDGER_FILE_NAME);

function ledgerOf(repository: LeaseRepository): Record<string, unknown> | null {
  const path = ledgerPathOf(repository);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;
}

function writeLedger(repository: LeaseRepository, value: unknown): void {
  writeFileSync(
    ledgerPathOf(repository),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

function openOf(repository: LeaseRepository): readonly OpenOwnedLaunch[] {
  return (ledgerOf(repository)?.open ?? []) as readonly OpenOwnedLaunch[];
}

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

/** A minted attestation for `ownerPid`, or a loud failure. Never fabricated. */
function attestationFor(
  ownerPid: number,
  over: Partial<Parameters<typeof mintContainmentAttestation>[0]> = {},
): ContainmentAttestation {
  const minted = mintContainmentAttestation({
    ownerPid,
    helperPid: 4001,
    childPid: 4002,
    mode: 'JOBLIST',
    assignedAtCreation: true,
    launchNonce: nonce(),
    attestedAt: tick(),
    verifiedInJob: true,
    ...over,
  });
  if (minted === null) throw new Error('the fixture could not mint an attestation');
  return minted;
}

/** One owned launch announced and established over `pids`, through production. */
function ownedLaunch(
  repository: LeaseRepository,
  evidence: ExecutionLeaseEvidence,
  pids?: { readonly helperPid: number; readonly childPid: number },
): number {
  const announced = announceOwnedLaunch(repository, evidence, { now: tick });
  expect(announced.code).toBe('ANNOUNCED');
  const slot = announced.slot;
  if (slot === null) throw new Error('an announced launch carries a slot');
  if (pids === undefined) return slot;
  const established = attestOwnedLaunchEstablished(
    repository,
    evidence,
    attestationFor(process.pid, pids),
    { slot, now: tick },
  );
  expect(established.code).toBe('ESTABLISHED');
  return slot;
}

/** A writer launch run to `CONTAINED`, so the writer conjunct permits. */
function containedWriter(repository: LeaseRepository, evidence: ExecutionLeaseEvidence): void {
  const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
  expect(opened.code).toBe('OPENED');
  const generation = opened.generation;
  if (generation === null) throw new Error('an opened launch carries a generation');
  const confirmed = confirmWriterLaunch(repository, evidence, attestationFor(process.pid), {
    generation,
    writerId: 'claude',
    now: tick,
  });
  expect(confirmed.code).toBe('CONFIRMED');
}

/**
 * A pid that is certainly not running.
 *
 * The same trick the neighbouring file uses: a real child, awaited to its exit,
 * so the number came from the operating system rather than from this file.
 */
const deadProcessId = (): number => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const done = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (typeof done.pid !== 'number') throw new Error('the fixture could not obtain a dead pid');
  return done.pid;
};

/** Releases the lease and re-writes it as one whose owner is gone. */
function freezeAsStale(repository: LeaseRepository, evidence: ExecutionLeaseEvidence): number {
  const document = JSON.parse(readFileSync(leasePathOf(repository), 'utf8')) as Record<string, unknown>;
  const ledger = ledgerOf(repository);
  releaseRepositoryExecutionLease(evidence);
  const ownerPid = deadProcessId();
  writeFileSync(leasePathOf(repository), `${JSON.stringify({ ...document, ownerPid }, null, 2)}\n`, 'utf8');
  const runId = (document.runId ?? null) as string | null;
  const subject: WriterLaunchSubject = {
    leaseKey: document.leaseKey as string,
    ownerNonce: document.ownerNonce as string,
    ownerPid,
    runId,
  };
  // Every field carried across, the register included. A helper that defaulted
  // the register would empty it, and empty is the licensing value — so every
  // refusal case in this file would pass while measuring a document the fixture
  // had quietly made safe.
  const payload: WriterLaunchLedgerPayload = {
    ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION,
    ownerPid,
    runId,
    historyComplete: ledger?.historyComplete === true,
    entries: (ledger?.entries ?? []) as WriterLaunchLedgerPayload['entries'],
    open: (ledger?.open ?? []) as WriterLaunchLedgerPayload['open'],
    nextSlot: typeof ledger?.nextSlot === 'number' ? ledger.nextSlot : 1,
  };
  writeLedger(repository, { ...payload, binding: writerLaunchBinding(subject, payload) });
  return ownerPid;
}

const dead = (): ProcessLiveness => 'NOT_FOUND';
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
    open: [],
    nextSlot: 1,
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

const ESTABLISHED_OPEN: OpenOwnedLaunch = Object.freeze({
  slot: 1,
  state: 'ESTABLISHED',
  openedAt: '2026-08-30T00:00:00.000Z',
  helperPid: 7001,
  childPid: 7002,
  mode: 'JOBLIST',
  verifiedInJob: true,
  assignedAtCreation: true,
  launchDigest: 'b'.repeat(64),
  attestedAt: '2026-08-30T00:00:01.000Z',
  establishedAt: '2026-08-30T00:00:02.000Z',
});

const ANNOUNCED_OPEN: OpenOwnedLaunch = Object.freeze({
  slot: 1,
  state: 'ANNOUNCED',
  openedAt: '2026-08-30T00:00:00.000Z',
});

/* ──────────────────── 1. the register format, in isolation ──────────────── */

describe('the owned-launch register refuses everything it cannot read', () => {
  it('answers exactly one reading that proves nothing is open, asserted by value', () => {
    // A total table, asserted row by row rather than by `satisfies`: completeness
    // is not correctness, and a `satisfies Record<Reading, boolean>` would accept
    // `true` everywhere.
    expect(
      Object.fromEntries(OWNED_LAUNCH_READINGS.map((r) => [r, provesNoOwnedLaunchOpen(r)])),
    ).toEqual({
      NO_OWNED_LAUNCH_OPEN: true,
      OWNED_LAUNCHES_OPEN_UNENDED: false,
      OWNED_LAUNCH_UNPROVEN: false,
      REGISTER_NOT_READABLE: false,
    });
  });

  it('keeps the two licensing predicates disjoint, asserted by value', () => {
    expect(
      Object.fromEntries(
        OWNED_LAUNCH_READINGS.map((r) => [r, provesOwnedLaunchesOpenUnended(r)]),
      ),
    ).toEqual({
      NO_OWNED_LAUNCH_OPEN: false,
      OWNED_LAUNCHES_OPEN_UNENDED: true,
      OWNED_LAUNCH_UNPROVEN: false,
      REGISTER_NOT_READABLE: false,
    });
    // Disjoint, not nested. Neither answer may be read as the other's superset:
    // one licenses outright and the other still owes a liveness proof, and a
    // caller that took the second for the first would skip it.
    for (const reading of OWNED_LAUNCH_READINGS) {
      expect(provesNoOwnedLaunchOpen(reading) && provesOwnedLaunchesOpenUnended(reading)).toBe(false);
    }
  });

  it('produces every reading in the closed set from a real input', () => {
    // Each from ITS OWN input, so no reading is a name with nothing behind it.
    const produced: Readonly<Record<(typeof OWNED_LAUNCH_READINGS)[number], string>> = {
      NO_OWNED_LAUNCH_OPEN: readOwnedLaunchRegister(SUBJECT, sealed()),
      OWNED_LAUNCHES_OPEN_UNENDED: readOwnedLaunchRegister(
        SUBJECT,
        sealed({ open: [ESTABLISHED_OPEN], nextSlot: 2 }),
      ),
      OWNED_LAUNCH_UNPROVEN: readOwnedLaunchRegister(
        SUBJECT,
        sealed({ open: [ANNOUNCED_OPEN], nextSlot: 2 }),
      ),
      // The document itself is not one a recovery may read. Anything the writer
      // reading refuses collapses to this; a ledger bound to another lease is
      // the cheapest of them.
      REGISTER_NOT_READABLE: readOwnedLaunchRegister(
        SUBJECT,
        sealed({}, { ...SUBJECT, ownerNonce: 'f'.repeat(64) }),
      ),
    };
    expect(Object.keys(produced).sort()).toEqual([...OWNED_LAUNCH_READINGS].sort());
    for (const [reading, observed] of Object.entries(produced)) expect(observed).toBe(reading);
  });

  it('reads an announced launch as unproven whatever else is open', () => {
    // `ANNOUNCED` dominates. Reading the two states in any other order would let
    // an established entry describe a register that still hides a launch nothing
    // can be said about.
    expect(readOpenSet([ESTABLISHED_OPEN, { ...ANNOUNCED_OPEN, slot: 2 }])).toBe(
      'OWNED_LAUNCH_UNPROVEN',
    );
    expect(readOpenSet([{ ...ANNOUNCED_OPEN, slot: 1 }, { ...ESTABLISHED_OPEN, slot: 2 }])).toBe(
      'OWNED_LAUNCH_UNPROVEN',
    );
    expect(readOpenSet([])).toBe('NO_OWNED_LAUNCH_OPEN');
  });

  it('names the processes a recovery owes a proof about, and only for that reading', () => {
    expect(openOwnedLaunchesOf([ESTABLISHED_OPEN])).toEqual([
      { slot: 1, helperPid: 7001, childPid: 7002 },
    ]);
    // `null` for every other reading, so a register that is unproven yields
    // nothing to probe rather than a shorter list a caller could exhaust and
    // call proven.
    expect(openOwnedLaunchesOf([ANNOUNCED_OPEN])).toBeNull();
    expect(openOwnedLaunchesOf([])).toBeNull();
    // And through the document, fail-closed on every structural refusal.
    expect(openOwnedProcessesOf(SUBJECT, sealed({ open: [ESTABLISHED_OPEN], nextSlot: 2 }))).toEqual([
      { slot: 1, helperPid: 7001, childPid: 7002 },
    ]);
    expect(
      openOwnedProcessesOf(SUBJECT, sealed({ open: [ESTABLISHED_OPEN], nextSlot: 2 }, {
        ...SUBJECT,
        ownerNonce: 'f'.repeat(64),
      })),
    ).toBeNull();
    expect(openOwnedProcessesOf(SUBJECT, undefined)).toBeNull();
  });

  it('refuses an announced entry relabelled established, in both directions', () => {
    // The single edit this format exists to refuse. `state` is fed into the
    // binding before every value field, so neither relabelling recomputes.
    const announced = sealed({ open: [ANNOUNCED_OPEN], nextSlot: 2 });
    const relabelled = {
      ...announced,
      open: [{ ...ESTABLISHED_OPEN, openedAt: ANNOUNCED_OPEN.openedAt }],
    };
    expect(readOwnedLaunchRegister(SUBJECT, relabelled)).toBe('REGISTER_NOT_READABLE');
    expect(readWriterLaunchLedger(SUBJECT, relabelled)).toBe('NOT_THIS_LEASE');

    const established = sealed({ open: [ESTABLISHED_OPEN], nextSlot: 2 });
    const weakened = { ...established, open: [ANNOUNCED_OPEN] };
    expect(readOwnedLaunchRegister(SUBJECT, weakened)).toBe('REGISTER_NOT_READABLE');
  });

  it('detects a per-field edit of an established open entry', () => {
    // Ten of the eleven fields. `verifiedInJob` is a `z.literal(true)` with no
    // other value to try, and `state` has its own case above.
    const mutations: Readonly<Record<string, unknown>> = {
      slot: 9,
      openedAt: '2026-08-30T09:09:09.000Z',
      helperPid: 9001,
      childPid: 9002,
      mode: 'SUSPENDED',
      assignedAtCreation: false,
      launchDigest: 'c'.repeat(64),
      attestedAt: '2026-08-30T09:09:08.000Z',
      establishedAt: '2026-08-30T09:09:07.000Z',
    };
    const base = sealed({ open: [ESTABLISHED_OPEN], nextSlot: 10 });
    for (const [field, value] of Object.entries(mutations)) {
      const edited = { ...base, open: [{ ...ESTABLISHED_OPEN, [field]: value }] };
      expect(readOwnedLaunchRegister(SUBJECT, edited)).toBe('REGISTER_NOT_READABLE');
    }
    // And the eleventh, `nextSlot`, which is not on an entry and is the one an
    // attacker most wants: rolling it back is what would let a settled slot be
    // handed out twice.
    expect(readOwnedLaunchRegister(SUBJECT, { ...base, nextSlot: 2 })).toBe('REGISTER_NOT_READABLE');

    // The binding really covers every field this asserts, stated as a property
    // of the field list rather than inferred from the loop above.
    expect(openLaunchBindingFields(ESTABLISHED_OPEN)).toHaveLength(11);
    expect(openLaunchBindingFields(ANNOUNCED_OPEN)).toHaveLength(3);
  });

  it('refuses a register whose slots are impossible, before the binding', () => {
    // Refused as MALFORMED, which is a *document* verdict: this is one record
    // with one binding, and a well-bound impossible document is still not a
    // document.
    const cases: readonly { readonly open: readonly OpenOwnedLaunch[]; readonly nextSlot: number }[] = [
      // two entries with one slot: a settlement could not name one of them
      { open: [ESTABLISHED_OPEN, { ...ANNOUNCED_OPEN, slot: 1 }], nextSlot: 2 },
      // out of order
      { open: [{ ...ESTABLISHED_OPEN, slot: 2 }, { ...ANNOUNCED_OPEN, slot: 1 }], nextSlot: 3 },
      // a slot at or above the counter: the counter was rolled back
      { open: [{ ...ESTABLISHED_OPEN, slot: 5 }], nextSlot: 5 },
      { open: [{ ...ESTABLISHED_OPEN, slot: 6 }], nextSlot: 5 },
    ];
    for (const { open, nextSlot } of cases) {
      expect(admissibleOpenSet(open, nextSlot)).toBe(false);
      expect(readWriterLaunchLedger(SUBJECT, sealed({ open: [...open], nextSlot }))).toBe('MALFORMED');
      expect(readOwnedLaunchRegister(SUBJECT, sealed({ open: [...open], nextSlot }))).toBe(
        'REGISTER_NOT_READABLE',
      );
    }
    expect(admissibleOpenSet([ESTABLISHED_OPEN], 2)).toBe(true);
    expect(admissibleOpenSet([], 1)).toBe(true);
    expect(admissibleOpenSet([], 0)).toBe(false);
  });

  it('refuses a document from a build that kept no register', () => {
    // The version bump's cost, stated as a test rather than as prose. A
    // version-2 document has no register at all, and there is deliberately no
    // arm that reads a missing register as an empty one.
    const legacy = { ...sealed(), ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION - 1 };
    expect(readWriterLaunchLedger(SUBJECT, legacy)).toBe('UNSUPPORTED_VERSION');
    expect(readOwnedLaunchRegister(SUBJECT, legacy)).toBe('REGISTER_NOT_READABLE');
  });
});

/* ─────────────────── 2. the lifecycle, through production ───────────────── */

describe('an owned launch is announced before it happens and settled after it', () => {
  it('publishes an empty register when the lease is acquired', () => {
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    expect(ledgerOf(repository)?.open).toEqual([]);
    expect(ledgerOf(repository)?.nextSlot).toBe(1);
    expect(inspectOwnedLaunchRegister(repository)).toBe('NO_OWNED_LAUNCH_OPEN');
    releaseRepositoryExecutionLease(evidence);
  });

  it('announces as ANNOUNCED, establishes in place, and settles by removal', () => {
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);

    const announced = announceOwnedLaunch(repository, evidence, { now: tick });
    expect(announced.code).toBe('ANNOUNCED');
    expect(announced.slot).toBe(1);
    expect(openOf(repository).map((e) => e.state)).toEqual(['ANNOUNCED']);
    expect(inspectOwnedLaunchRegister(repository)).toBe('OWNED_LAUNCH_UNPROVEN');

    const established = attestOwnedLaunchEstablished(
      repository,
      evidence,
      attestationFor(process.pid, { helperPid: 3101, childPid: 3102 }),
      { slot: 1, now: tick },
    );
    expect(established.code).toBe('ESTABLISHED');
    const open = openOf(repository);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ slot: 1, state: 'ESTABLISHED', helperPid: 3101, childPid: 3102 });
    expect(inspectOwnedLaunchRegister(repository)).toBe('OWNED_LAUNCHES_OPEN_UNENDED');

    const settled = settleOwnedLaunch(repository, evidence, { slot: 1 });
    expect(settled.code).toBe('SETTLED');
    expect(openOf(repository)).toEqual([]);
    expect(inspectOwnedLaunchRegister(repository)).toBe('NO_OWNED_LAUNCH_OPEN');
    releaseRepositoryExecutionLease(evidence);
  });

  it('never hands out a settled slot again', () => {
    // The rule the whole format rests on. Without it a settlement for an old
    // launch, arriving after a new one took the same slot, would remove a LIVE
    // launch's record — the one edit here that turns a refusal into a
    // permission.
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    const slots: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const slot = ownedLaunch(repository, evidence, { helperPid: 3200 + i, childPid: 3300 + i });
      slots.push(slot);
      expect(settleOwnedLaunch(repository, evidence, { slot }).code).toBe('SETTLED');
      expect(openOf(repository)).toEqual([]);
    }
    expect(slots).toEqual([1, 2, 3, 4, 5]);
    expect(ledgerOf(repository)?.nextSlot).toBe(6);
    releaseRepositoryExecutionLease(evidence);
  });

  it('settles a slot that is not open as a success, and removes nothing else', () => {
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    const kept = ownedLaunch(repository, evidence, { helperPid: 3401, childPid: 3402 });
    expect(settleOwnedLaunch(repository, evidence, { slot: 99 }).code).toBe('ALREADY_SETTLED');
    expect(openOf(repository).map((e) => e.slot)).toEqual([kept]);
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses to establish a slot twice, and to establish one that is not announced', () => {
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    const slot = ownedLaunch(repository, evidence, { helperPid: 3501, childPid: 3502 });
    // A second establishment would overwrite the first launch's pids, which is
    // the same hazard the replay guard catches from the other side.
    const twice = attestOwnedLaunchEstablished(
      repository,
      evidence,
      attestationFor(process.pid, { helperPid: 9999, childPid: 9998 }),
      { slot, now: tick },
    );
    expect(twice.code).toBe('SLOT_NOT_OPEN');
    expect(openOf(repository)[0]).toMatchObject({ helperPid: 3501, childPid: 3502 });

    const absent = attestOwnedLaunchEstablished(
      repository,
      evidence,
      attestationFor(process.pid),
      { slot: 404, now: tick },
    );
    expect(absent.code).toBe('SLOT_NOT_OPEN');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses one attestation used to prove a second open slot', () => {
    // One kernel-confirmed launch proves one launch. A replay would put one
    // launch's pids on two slots, and the second launch's real processes would
    // then be named nowhere.
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    const attestation = attestationFor(process.pid, { helperPid: 3601, childPid: 3602 });
    const first = announceOwnedLaunch(repository, evidence, { now: tick });
    const second = announceOwnedLaunch(repository, evidence, { now: tick });
    expect(
      attestOwnedLaunchEstablished(repository, evidence, attestation, {
        slot: first.slot ?? 0,
        now: tick,
      }).code,
    ).toBe('ESTABLISHED');
    expect(
      attestOwnedLaunchEstablished(repository, evidence, attestation, {
        slot: second.slot ?? 0,
        now: tick,
      }).code,
    ).toBe('ATTESTATION_ALREADY_USED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a containment coupled to a process other than the lease owner', () => {
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    const slot = announceOwnedLaunch(repository, evidence, { now: tick }).slot ?? 0;
    const foreign = attestOwnedLaunchEstablished(
      repository,
      evidence,
      attestationFor(process.pid + 1),
      { slot, now: tick },
    );
    expect(foreign.code).toBe('OWNER_MISMATCH');
    expect(openOf(repository)[0]?.state).toBe('ANNOUNCED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses to touch a register it does not hold the lease for', () => {
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    releaseRepositoryExecutionLease(evidence);
    expect(announceOwnedLaunch(repository, evidence, { now: tick }).code).toBe('LEASE_ABSENT');
    expect(
      attestOwnedLaunchEstablished(repository, evidence, attestationFor(process.pid), {
        slot: 1,
        now: tick,
      }).code,
    ).toBe('LEASE_ABSENT');
    expect(settleOwnedLaunch(repository, evidence, { slot: 1 }).code).toBe('LEASE_ABSENT');
  });

  it('leaves the writer history untouched, in both directions', () => {
    // One document, two records. A register write that disturbed the writer
    // history would silently weaken the other proof, and the writer paths carry
    // the register across for the same reason.
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    containedWriter(repository, evidence);
    // Compared by VALUE, not by bytes. A register write rebuilds the document
    // from the parsed one, so the writer entries come back with the schema's key
    // order rather than the order they were first written in. Nothing depends on
    // that order — the binding is computed field by field, by name — and the
    // reading below is what a recovery actually asks. Asserting the bytes would
    // pin a property this format does not have.
    const stable = (value: unknown): string =>
      JSON.stringify(value, (_key, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort())
          : v,
      );
    const beforeEntries = stable(ledgerOf(repository)?.entries);
    const slot = ownedLaunch(repository, evidence, { helperPid: 3701, childPid: 3702 });
    expect(stable(ledgerOf(repository)?.entries)).toBe(beforeEntries);
    expect(readWriterLaunchLedger(subjectOf(repository), ledgerOf(repository))).toBe(
      'ALL_LAUNCHES_CONTAINED',
    );

    const beforeOpen = stable(ledgerOf(repository)?.open);
    containedWriter(repository, evidence);
    expect(stable(ledgerOf(repository)?.open)).toBe(beforeOpen);
    expect(readOwnedLaunchRegister(subjectOf(repository), ledgerOf(repository))).toBe(
      'OWNED_LAUNCHES_OPEN_UNENDED',
    );
    expect(settleOwnedLaunch(repository, evidence, { slot }).code).toBe('SETTLED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('names every code in the closed set', () => {
    // Not "produces every one": four of them need a filesystem this suite does
    // not have. The set is closed and stated, so a code added without a decision
    // is visible here.
    expect([...OWNED_LAUNCH_CODES].sort()).toEqual(
      [
        'ALREADY_SETTLED',
        'ANNOUNCED',
        'ATTESTATION_ALREADY_USED',
        'ATTESTATION_INVALID',
        'ESTABLISHED',
        'EVIDENCE_INVALID',
        'LAUNCH_MUST_NOT_START',
        'LEASE_ABSENT',
        'LEASE_FOR_ANOTHER_REPOSITORY',
        'LEASE_UNREADABLE',
        'NOT_OWNER',
        'OWNER_MISMATCH',
        'REGISTER_DISCARDED',
        'REGISTER_NOT_READABLE_BACK',
        'REGISTER_WRITE_FAILED',
        'SETTLED',
        'SLOT_NOT_OPEN',
      ].sort(),
    );
  });

  it('discards the document rather than let an unusable one stand, and refuses when it cannot', () => {
    // The two fail-closed exits of the announcement, both reached with a real
    // filesystem rather than a stub. An unusable document is one this build
    // cannot write a register into; leaving it would be a record that accounts
    // for owned launches and stops mentioning them.
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    writeLedger(repository, '{"ledgerVersion": 3, "not-a"');
    const discarded = announceOwnedLaunch(repository, evidence, { now: tick });
    expect(discarded.code).toBe('REGISTER_DISCARDED');
    expect(existsSync(ledgerPathOf(repository))).toBe(false);

    // And when the path can be neither written nor removed. A **directory** at
    // the ledger's own name does it, which is a condition this suite can make.
    mkdirSync(ledgerPathOf(repository), { recursive: true });
    const refused = announceOwnedLaunch(repository, evidence, { now: tick });
    expect(refused.code).toBe('LAUNCH_MUST_NOT_START');
    rmSync(ledgerPathOf(repository), { recursive: true, force: true });
    releaseRepositoryExecutionLease(evidence);
  });
});

/* ─────────────── 3. the seam: every owned launch is announced ───────────── */

describe('the execution seam accounts for every launch it starts', () => {
  it('installs an accountant on acquisition and disposes of it on release', () => {
    const before = installedOwnedLaunchAccountants();
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    expect(installedOwnedLaunchAccountants()).toBe(before + 1);
    releaseRepositoryExecutionLease(evidence);
    expect(installedOwnedLaunchAccountants()).toBe(before);
  });

  it('announces a real command before it starts and settles it after', async () => {
    // The measurement the whole slice turns on, and it drives the PRODUCTION
    // entry point with no accounting argument of any kind: `runCommand` takes
    // none, which is what makes a future spawn path unable to opt out.
    const repository = repositoryFixture();
    const evidence = leaseOf(repository);
    const seen: string[] = [];
    // `--version` because every argument reaching this seam must be
    // shell-inert; a JS one-liner cannot be one, by design.
    const result = await runCommand(process.execPath, ['--version'], {
      env: createProbeEnv('capability:generic', process.env),
      cwd: repository.root,
    });
    void seen;
    expect(result.outcome).toBe('COMPLETED');
    // Announced, then removed. What survives is the counter, which only grows.
    expect(openOf(repository)).toEqual([]);
    expect(ledgerOf(repository)?.nextSlot).toBe(2);
    releaseRepositoryExecutionLease(evidence);
  });

  it('leaves the record OPEN for an ending the boundary did not account for', () => {
    // The rule, asserted directly rather than through a spawn that cannot be
    // made to lose its boundary on demand. Closing says "this launch ended", and
    // `boundary/owned-command.ts` is explicit that a lost boundary is precisely
    // the case where that stops being true.
    const base = {
      display: 'x',
      executable: 'x',
      args: [],
      startedAt: '2026-08-30T00:00:00.000Z',
      finishedAt: '2026-08-30T00:00:01.000Z',
      durationMs: 1,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      errnoCode: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdinDelivery: 'NOT_REQUESTED',
      processTreeKilled: false,
    } as unknown as CommandResult;
    // Nothing was created: there is no process to describe.
    expect(endingWasAccountedFor({ ...base, started: false, outcome: 'SPAWN_FAILED' } as CommandResult)).toBe(true);
    // Started, and the boundary accounted for the ending.
    expect(
      endingWasAccountedFor({
        ...base,
        started: true,
        outcome: 'COMPLETED',
        containment: attestationFor(process.pid),
      } as CommandResult),
    ).toBe(true);
    // Started, and it did not. The record stays open and a recovery probes it.
    expect(
      endingWasAccountedFor({ ...base, started: true, outcome: 'BOUNDARY_LOST' } as CommandResult),
    ).toBe(false);
    expect(
      endingWasAccountedFor({ ...base, started: true, outcome: 'COMPLETED' } as CommandResult),
    ).toBe(false);
  });

  it('refuses a launch no installed accountant could record, and closes what it opened', () => {
    // The one answer that stops a launch, and the cleanup that must follow it: a
    // refused launch may not leave open slots in the epochs that DID record it,
    // because each of those would refuse a recovery forever for a process that
    // never existed.
    const closed: string[] = [];
    const disposeFirst = installOwnedLaunchAccountant({
      open: (): OwnedLaunchOpening => ({
        opening: 'RECORDED',
        record: { established: () => {}, ended: () => closed.push('first') },
      }),
    });
    const disposeSecond = installOwnedLaunchAccountant({
      open: (): OwnedLaunchOpening => ({ opening: 'LAUNCH_MUST_NOT_START', detail: 'NO_ROOM' }),
    });
    const opened = openOwnedLaunch();
    expect(opened.refusal).toBe('NO_ROOM');
    expect(opened.records).toEqual([]);
    expect(closed).toEqual(['first']);
    disposeFirst();
    disposeSecond();
  });

  it('drops an accountant whose epoch has ended, and one that throws', () => {
    const before = installedOwnedLaunchAccountants();
    const disposeEnded = installOwnedLaunchAccountant({
      open: (): OwnedLaunchOpening => ({ opening: 'EPOCH_ENDED' }),
    });
    const disposeThrower = installOwnedLaunchAccountant({
      open: (): OwnedLaunchOpening => {
        throw new Error('an accountant is somebody else\u2019s code');
      },
    });
    expect(installedOwnedLaunchAccountants()).toBe(before + 2);
    // Neither stops the launch, and both are gone afterwards.
    expect(openOwnedLaunch().refusal).toBeNull();
    expect(installedOwnedLaunchAccountants()).toBe(before);
    disposeEnded();
    disposeThrower();
    expect(installedOwnedLaunchAccountants()).toBe(before);
  });
});

/* ─────────────── 4. the refusal, which is what this slice is ────────────── */

describe('a stale lease is not removed while an owned subprocess may be running', () => {
  it('refuses when an open launch names a process that exists', () => {
    // THE NEGATIVE REGRESSION, in process. The writer history reads
    // ALL_LAUNCHES_CONTAINED, so the writer conjunct PERMITS and the only thing
    // that can refuse is the register. The owner is genuinely gone.
    const repository = repositoryFixture();
    const owner = (() => {
      const evidence = leaseOf(repository, 'run-stale');
      containedWriter(repository, evidence);
      ownedLaunch(repository, evidence, { helperPid: 8001, childPid: 8002 });
      return freezeAsStale(repository, evidence);
    })();
    expect(owner).not.toBe(8001);
    expect(owner).not.toBe(8002);

    const bytes = readFileSync(leasePathOf(repository));
    const alive = (pid: number): ProcessLiveness => (pid === owner ? 'NOT_FOUND' : 'ALIVE');
    const assessed = assessStaleLeaseRecovery(repository, { processAlive: alive });
    expect(assessed.launchHistory).toBe('ALL_LAUNCHES_CONTAINED');
    expect(assessed.ownedLaunches).toBe('OWNED_LAUNCHES_OPEN_UNENDED');
    expect(assessed.refusal).toBe('OWNED_LAUNCH_STILL_RUNNING');
    expect(assessed.verdict).toBe('UNSAFE');

    // The destructive path, and the lease bytes after it. `recoverStaleLease`
    // COMBINES a supplied opinion with the real probe rather than substituting,
    // so this refuses through the real predicate too.
    const recovered = recoverStaleLease(repository, { additionalLiveness: alive });
    expect(recovered.code).toBe('RECOVERY_UNSAFE');
    expect(recovered.refusal).toBe('OWNED_LAUNCH_STILL_RUNNING');
    expect(readFileSync(leasePathOf(repository)).equals(bytes)).toBe(true);

    // And with nothing alive, the SAME lease is recoverable — which is what
    // makes the refusal attributable to liveness rather than to anything else
    // about the fixture.
    expect(assessStaleLeaseRecovery(repository, { processAlive: dead }).verdict).toBe(
      'SAFE_TO_RECOVER',
    );
  });

  it('probes the child as well as the helper, and refuses on either', () => {
    // The helper is the load-bearing one - it owns the job - and the child is
    // asked too rather than trusted to that inference: it is the process that
    // was actually doing the work, and a build that got the job coupling wrong
    // would still be caught by its own pid being alive.
    //
    // Written because a mutant that probed only the helper SURVIVED the rest of
    // this file: every other fixture here makes the two pids alive or dead
    // together, so neither one alone was ever the reason for a refusal.
    for (const [helper, child] of [
      [8301, 8302],
      [8302, 8301],
    ]) {
      const repository = repositoryFixture();
      const owner = (() => {
        const evidence = leaseOf(repository, 'run-stale');
        containedWriter(repository, evidence);
        ownedLaunch(repository, evidence, { helperPid: helper, childPid: child });
        return freezeAsStale(repository, evidence);
      })();
      // Exactly ONE of the recorded pair exists, and it is a different one each
      // time round. Everything else - the owner, the other pid - is gone.
      const onlyOneAlive = (pid: number): ProcessLiveness => (pid === 8301 ? 'ALIVE' : 'NOT_FOUND');
      expect(owner).not.toBe(8301);
      expect(assessStaleLeaseRecovery(repository, { processAlive: onlyOneAlive }).refusal).toBe(
        'OWNED_LAUNCH_STILL_RUNNING',
      );
    }
  });

  it('refuses an announced launch outright, with nothing to probe', () => {
    const repository = repositoryFixture();
    const owner = (() => {
      const evidence = leaseOf(repository, 'run-stale');
      containedWriter(repository, evidence);
      ownedLaunch(repository, evidence);
      return freezeAsStale(repository, evidence);
    })();
    void owner;
    const assessed = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(assessed.launchHistory).toBe('ALL_LAUNCHES_CONTAINED');
    expect(assessed.refusal).toBe('OWNED_LAUNCH_UNPROVEN');
  });

  it('refuses when the liveness of an open launch cannot be established', () => {
    const repository = repositoryFixture();
    const owner = (() => {
      const evidence = leaseOf(repository, 'run-stale');
      containedWriter(repository, evidence);
      ownedLaunch(repository, evidence, { helperPid: 8101, childPid: 8102 });
      return freezeAsStale(repository, evidence);
    })();
    const undetermined = (pid: number): ProcessLiveness =>
      pid === owner ? 'NOT_FOUND' : 'UNDETERMINED';
    expect(assessStaleLeaseRecovery(repository, { processAlive: undetermined }).refusal).toBe(
      'OWNED_LAUNCH_LIVENESS_UNDETERMINED',
    );
  });

  it('permits when every open launch names processes that are gone', () => {
    // THE POSITIVE CONTROL for the arm. Without it the arm could refuse in every
    // reachable situation and this file would stay green: every other case here
    // asserts a refusal, and an arm that never permits satisfies all of them.
    const repository = repositoryFixture();
    const owner = (() => {
      const evidence = leaseOf(repository, 'run-stale');
      containedWriter(repository, evidence);
      ownedLaunch(repository, evidence, { helperPid: 60_101, childPid: 60_102 });
      return freezeAsStale(repository, evidence);
    })();
    expect(owner).not.toBe(60_101);
    const assessed = assessStaleLeaseRecovery(repository, { processAlive: dead });
    expect(assessed.ownedLaunches).toBe('OWNED_LAUNCHES_OPEN_UNENDED');
    expect(assessed.verdict).toBe('SAFE_TO_RECOVER');
    expect(assessed.refusal).toBeNull();
    expect(recoverStaleLease(repository).code).toBe('RECOVERED');
    expect(existsSync(leasePathOf(repository))).toBe(false);
  });

  it('asks the register only after the writer history, so no older refusal is displaced', () => {
    // Ordering is the difference between adding a proof and replacing one. A
    // lease whose writer history is unproven AND whose register is open must
    // still report the writer refusal: that is the sentence an operator has been
    // shown since V3 slice 5, and a new conjunct above it would make three
    // existing gates vacuous.
    const repository = repositoryFixture();
    const owner = (() => {
      const evidence = leaseOf(repository, 'run-stale');
      const opened = beginWriterLaunch(repository, evidence, { writerId: 'claude', now: tick });
      expect(opened.code).toBe('OPENED');
      ownedLaunch(repository, evidence, { helperPid: 8201, childPid: 8202 });
      return freezeAsStale(repository, evidence);
    })();
    const alive = (pid: number): ProcessLiveness => (pid === owner ? 'NOT_FOUND' : 'ALIVE');
    const assessed = assessStaleLeaseRecovery(repository, { processAlive: alive });
    expect(assessed.refusal).toBe('LAUNCH_HISTORY_UNPROVEN');
    // And the register was never read, so its reading is absent rather than
    // reported: the conjuncts stop at the first refusal.
    expect(assessed.ownedLaunches).toBeNull();
  });

  it('names the three refusals the register contributes, in the closed set', () => {
    for (const refusal of [
      'OWNED_LAUNCH_UNPROVEN',
      'OWNED_LAUNCH_STILL_RUNNING',
      'OWNED_LAUNCH_LIVENESS_UNDETERMINED',
    ]) {
      expect(STALE_RECOVERY_REFUSALS).toContain(refusal);
    }
  });

  it('bounds the register rather than letting it grow without one', () => {
    expect(MAX_OPEN_OWNED_LAUNCHES).toBe(64);
  });
});
