/**
 * V3 slice 4 — containment evidence on the execution lease.
 *
 * The slice's claim, in one sentence: *a lease can record, durably and
 * versioned, that its productive writer was started behind the owned process
 * boundary, and every other input to that record is refused.*
 *
 * The record lives **beside** the lease rather than inside it, and that is a
 * safety property rather than a filing decision — `lease/containment-evidence.ts`
 * records what an in-lease rewrite cost and how it was measured. Several cases
 * below therefore assert the lease's bytes are unchanged, which is the pin that
 * the withdrawn design does not come back.
 *
 * Four things are measured here, and they are deliberately separate:
 *
 *  1. **the format**, which is a pure function of a lease document, so every
 *     hostile input can be constructed exactly — a legacy lease, a future
 *     version, a transplant, a per-field edit, a fully recomputed forgery;
 *  2. **the mint**, which is what makes "evidence may only come from an
 *     established containment path" structural rather than conventional;
 *  3. **the recorder**, against real leases in real directories, including the
 *     refusals that matter more than the success, and including the repeated
 *     recording a real run does — several `claude` spawns under one lease;
 *  4. **the wiring**, from the adapter's result up through `runCommand` and the
 *     agent seam to the leased spawn that records it.
 *
 * What is deliberately *not* claimed here: that a real Windows launch produces
 * an attestation. No case below starts one — the boundary executable is
 * resolved relative to the compiled adapter and does not exist under `src`, so
 * every launch here is the substituted `start` seam. That seam supplies the
 * values the mint sees, which is exactly why these cases prove the *gate* and
 * nothing about a real process. The end-to-end measurement is
 * `tests/dist-artifact/lease-containment-dist-artifact.mjs`, against the
 * shipped artefact with a real contained process.
 *
 * And what is not in this slice at all: recovery. No lease is removed or taken
 * over anywhere below, and one case exists specifically to pin that the recovery
 * classification is the same value with and without evidence present.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, describe, expect, it } from 'vitest';

import { PACKAGE_ROOT } from '../src/config/paths.js';

import { toAgentCommandResult, type AgentCommandResult } from '../src/agent/agent-command.js';
import type { OwnedCommandResult } from '../src/boundary/owned-command.js';
import {
  isAttestableOutcome,
  OWNED_COMMAND_OUTCOMES,
  runOwnedCommand,
} from '../src/boundary/owned-command.js';
import {
  containmentFactsOf,
  isContainmentAttestation,
  type ContainmentAttestation,
} from '../src/core/containment-attestation.js';
import { mintContainmentAttestation } from '../src/core/internal/containment-attestation.js';
import type { ExecutionLeaseEvidence } from '../src/core/execution-lease-evidence.js';
import { carriesContainment, toCommandResultFields, type CommandResult } from '../src/doctor/exec.js';
import {
  CONTAINMENT_READINGS,
  containmentBinding,
  CONTAINMENT_EVIDENCE_VERSION,
  isReliableContainment,
  readContainmentEvidence,
  type ContainmentEvidencePayload,
  type ContainmentReading,
  type ContainmentSubject,
} from '../src/lease/containment-evidence.js';
import {
  acquireRepositoryExecutionLease,
  clearContainmentEvidence,
  CONTAINMENT_EVIDENCE_FILE_NAME,
  CONTAINMENT_RECORD_CODES,
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
  recordContainmentEvidence,
  releaseRepositoryExecutionLease,
  type LeaseRepository,
} from '../src/lease/execution-lease.js';
import { safeParseExecutionLease } from '../src/lease/lease-document.js';
import { assessLeaseRecovery } from '../src/lease/lease-recovery.js';
import { leasedAgent } from '../src/loop/leased-spawns.js';

/* ───────────────────────────── fixtures ─────────────────────────────────── */

const roots: string[] = [];

/**
 * A directory shaped like an ordinary clone: a work tree with a `.git`
 * directory beside it.
 *
 * The shape is not cosmetic. `acquireRepositoryExecutionLease` proves the record
 * describes *one* repository by deriving the common directory from the root, so
 * a record pairing a root with something that is not its own `.git` is refused —
 * which is the same trap `tests/helpers/lease.ts` records having fallen into.
 */
function repositoryFixture(id = 'v3-04'): LeaseRepository {
  const root = mkdtempSync(join(tmpdir(), 'ao-v3-04-'));
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
const tick = (): string => new Date(Date.UTC(2026, 7, 20, 0, 0, clock++)).toISOString();

function leaseOf(
  repository: LeaseRepository,
  runId: string | null,
): { readonly evidence: ExecutionLeaseEvidence; readonly path: string } {
  const acquired = acquireRepositoryExecutionLease(repository, { runId, blockId: null }, { now: tick });
  if (!acquired.ok) throw new Error(`fixture could not take the lease: ${acquired.code}`);
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return { evidence: acquired.evidence, path: location.path };
}

function documentAt(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Where the containment record lives: beside the lease, never inside it. */
function recordPathOf(repository: LeaseRepository): string {
  return join(repository.gitCommonDir, CONTAINMENT_EVIDENCE_FILE_NAME);
}

/** The record on disk, or `null` when there is none. */
function recordOf(repository: LeaseRepository): Record<string, unknown> | null {
  const path = recordPathOf(repository);
  return existsSync(path) ? documentAt(path) : null;
}

/** A minted attestation for `ownerPid`, or a loud failure. Never fabricated. */
function attestationFor(ownerPid: number, over: Partial<Parameters<typeof mintContainmentAttestation>[0]> = {}): ContainmentAttestation {
  const minted = mintContainmentAttestation({
    ownerPid,
    helperPid: 4242,
    childPid: 4343,
    mode: 'JOBLIST',
    assignedAtCreation: true,
    launchNonce: 'a1b2c3d4e5f60718',
    attestedAt: '2026-08-20T00:00:00.000Z',
    verifiedInJob: true,
    ...over,
  });
  if (minted === null) throw new Error('fixture could not mint an attestation');
  return minted;
}

/* ─────────────────────── 1. the format, in isolation ────────────────────── */

const SUBJECT: Omit<ContainmentSubject, 'containment'> = Object.freeze({
  leaseKey: 'D:\\repo\\.git',
  ownerNonce: 'a'.repeat(64),
  ownerPid: 1234,
  runId: 'run-1',
});

function payload(over: Partial<ContainmentEvidencePayload> = {}): ContainmentEvidencePayload {
  return {
    evidenceVersion: CONTAINMENT_EVIDENCE_VERSION,
    ownerPid: SUBJECT.ownerPid,
    runId: 'run-1',
    writerId: 'claude',
    helperPid: 11,
    childPid: 12,
    mode: 'JOBLIST',
    verifiedInJob: true,
    assignedAtCreation: true,
    launchDigest: 'b'.repeat(64),
    attestedAt: '2026-08-20T00:00:00.000Z',
    recordedAt: '2026-08-20T00:00:01.000Z',
    ...over,
  };
}

/** A correctly bound record for `SUBJECT`, with the payload overridden freely. */
function bound(
  over: Partial<ContainmentEvidencePayload> = {},
  lease: Pick<ContainmentSubject, 'leaseKey' | 'ownerNonce'> = SUBJECT,
): Record<string, unknown> {
  const body = payload(over);
  return { ...body, binding: containmentBinding(lease, body) };
}

function reading(containment: unknown, subject: Partial<ContainmentSubject> = {}): ContainmentReading {
  return readContainmentEvidence({ ...SUBJECT, ...subject, containment });
}

describe('containment evidence — the format', () => {
  it('reads a legacy lease, which carries no field at all, as ABSENT', () => {
    expect(readContainmentEvidence({ ...SUBJECT })).toBe('ABSENT');
    expect(reading(undefined)).toBe('ABSENT');
    // And `undefined` alone. A record file whose contents are the JSON value
    // `null` is a file somebody wrote, so it is a record this build cannot read
    // rather than an absent one — the vocabulary rule `readContainmentRecord`
    // states, applied one level up. It used to read `ABSENT` here, justified by
    // a build that cleared the field in place; no build does that any more.
    expect(reading(null)).toBe('MALFORMED');
  });

  it('reads a correctly bound, agreeing record as CONTAINED', () => {
    expect(reading(bound())).toBe('CONTAINED');
  });

  it('refuses a record for a different run, however well it is bound', () => {
    // The digest is recomputed over the altered payload, so the binding is
    // valid. What refuses it is the agreement check against the lease's own
    // `runId` — the check the binding cannot imply, because it does not cover
    // the document's fields.
    const evidence = bound({ runId: 'some-other-run' });
    expect(containmentBinding(SUBJECT, payload({ runId: 'some-other-run' }))).toBe(evidence.binding);
    expect(reading(evidence)).toBe('NOT_THIS_RUN');
  });

  it('refuses a record for a different owner, however well it is bound', () => {
    expect(reading(bound({ ownerPid: 9999 }))).toBe('NOT_THIS_RUN');
  });

  it('refuses a record for a different writer when the caller names one', () => {
    // The lease document records no writer, so this is the one field that can
    // only be checked against an expectation. Without one the record is
    // reliable; with a contradicting one it is not.
    const evidence = bound({ writerId: 'codex' });
    expect(reading(evidence)).toBe('CONTAINED');
    expect(
      readContainmentEvidence(
        { ...SUBJECT, containment: evidence },
        { runId: 'run-1', writerId: 'claude', ownerPid: SUBJECT.ownerPid },
      ),
    ).toBe('NOT_THIS_RUN');
  });

  it('refuses a lease that names no run, even with a well-formed record', () => {
    expect(reading(bound(), { runId: null })).toBe('NOT_THIS_RUN');
  });

  it('detects an edit to every single bound field', () => {
    /**
     * One case per field rather than one representative edit, and the reason is
     * the binding's own comment: a field added to the schema and forgotten in
     * `containmentBinding` is silently unbound, and a single-field test would
     * not see it. Each entry below is a value that differs from the payload's.
     */
    const edits: ReadonlyArray<Partial<ContainmentEvidencePayload>> = [
      { ownerPid: 4321 },
      { runId: 'edited' },
      { writerId: 'edited' },
      { helperPid: 99 },
      { childPid: 98 },
      { mode: 'SUSPENDED' },
      { assignedAtCreation: false },
      { launchDigest: 'c'.repeat(64) },
      { attestedAt: '2027-01-01T00:00:00.000Z' },
      { recordedAt: '2027-01-01T00:00:00.000Z' },
    ];
    for (const edit of edits) {
      // The genuine record, with one field changed and the digest left alone.
      const tampered = { ...bound(), ...edit };
      expect(reading(tampered), JSON.stringify(edit)).toBe('NOT_THIS_LEASE');
    }
    // `evidenceVersion` is bound too, and an edit to it is caught earlier and
    // more usefully — as a version this build does not know.
    expect(reading({ ...bound(), evidenceVersion: 7 })).toBe('UNSUPPORTED_VERSION');
    // And `verifiedInJob` cannot be edited to anything the schema will accept,
    // which is a stronger refusal than the binding's.
    expect(reading({ ...bound(), verifiedInJob: false })).toBe('MALFORMED');
  });

  it('refuses a record transplanted from another lease', () => {
    // Genuine, correctly bound — for somebody else's lease. Both halves of the
    // lease identity differ, and either one alone is enough.
    const foreign = bound({}, { leaseKey: 'D:\\other\\.git', ownerNonce: 'f'.repeat(64) });
    expect(reading(foreign)).toBe('NOT_THIS_LEASE');
    expect(reading(bound({}, { leaseKey: 'D:\\other\\.git', ownerNonce: SUBJECT.ownerNonce }))).toBe(
      'NOT_THIS_LEASE',
    );
    expect(reading(bound({}, { leaseKey: SUBJECT.leaseKey, ownerNonce: 'f'.repeat(64) }))).toBe(
      'NOT_THIS_LEASE',
    );
  });

  it('refuses anything that is not a record this build declares', () => {
    expect(reading(42)).toBe('MALFORMED');
    expect(reading('contained')).toBe('MALFORMED');
    expect(reading([])).toBe('MALFORMED');
    expect(reading({})).toBe('MALFORMED');
    // A key this build does not declare. `.strict()` refuses it rather than
    // ignoring it: an unread field is a field that travels.
    expect(reading({ ...bound(), extra: true })).toBe('MALFORMED');
    // The binding is what a forger would strip first.
    const { binding: _dropped, ...withoutBinding } = bound();
    expect(reading(withoutBinding)).toBe('MALFORMED');
  });

  it('refuses a version from a future build without making the lease unreadable', () => {
    // The point of the arm: a future record is reported as a *version* this
    // build cannot read, not as garbage — and the reading happens before the
    // strict schema, so a payload with fields this build has never heard of
    // still lands here.
    expect(reading({ evidenceVersion: 2, whateverComesNext: true })).toBe('UNSUPPORTED_VERSION');
    expect(reading({ ...bound(), evidenceVersion: CONTAINMENT_EVIDENCE_VERSION + 1 })).toBe(
      'UNSUPPORTED_VERSION',
    );
    // A version that is not a version at all is not a future build.
    expect(reading({ ...bound(), evidenceVersion: 'two' })).toBe('MALFORMED');
    expect(reading({ ...bound(), evidenceVersion: 0 })).toBe('MALFORMED');
  });

  it('names exactly three attestable outcomes and three carrying ones, row by row', () => {
    /**
     * By value, through the exported predicates. The tables used to be private
     * and this claim used to be made about them anyway: only three of
     * `ATTESTABLE_OUTCOME`'s six rows were reachable from any test, so flipping
     * `TERMINATED_BY_CALLER` to `true` was an undetected mutant of the gate. A
     * claim about a table nothing can read is not a claim.
     */
    expect(isAttestableOutcome('COMPLETED')).toBe(true);
    expect(isAttestableOutcome('TIMED_OUT')).toBe(true);
    expect(isAttestableOutcome('OUTPUT_LIMIT_EXCEEDED')).toBe(true);
    expect(isAttestableOutcome('TERMINATED_BY_CALLER')).toBe(false);
    expect(isAttestableOutcome('BOUNDARY_LOST')).toBe(false);
    expect(isAttestableOutcome('LAUNCH_REFUSED')).toBe(false);
    // Total, so a seventh outcome cannot slip past unjudged.
    expect(OWNED_COMMAND_OUTCOMES.filter((o) => isAttestableOutcome(o))).toEqual([
      'COMPLETED',
      'TIMED_OUT',
      'OUTPUT_LIMIT_EXCEEDED',
    ]);

    expect(carriesContainment('COMPLETED')).toBe(true);
    expect(carriesContainment('TIMED_OUT')).toBe(true);
    expect(carriesContainment('OUTPUT_LIMIT_EXCEEDED')).toBe(true);
    expect(carriesContainment('NOT_FOUND')).toBe(false);
    expect(carriesContainment('SPAWN_FAILED')).toBe(false);
    expect(carriesContainment('BOUNDARY_LOST')).toBe(false);
  });

  it('has the number of record codes its own header claims', () => {
    // The header says "a closed set of fourteen, of which three are successes",
    // and it said "thirteen" for one commit after the fourteenth member landed.
    // `VerifiedRemoval` records the same defect forty lines up in that file: a
    // number describing the code, sitting beside the code, with nothing keeping
    // the two in step. This is the something.
    expect(CONTAINMENT_RECORD_CODES).toHaveLength(14);
    expect(new Set(CONTAINMENT_RECORD_CODES).size).toBe(CONTAINMENT_RECORD_CODES.length);
    expect(CONTAINMENT_RECORD_CODES.filter((c) => c === 'RECORDED' || c === 'CLEARED' || c === 'NOTHING_TO_CLEAR')).toHaveLength(3);
  });

  it('calls exactly one reading reliable, asserted row by row', () => {
    // By value rather than by "the table is total": a total table with `true` in
    // every row type-checks. This is the assertion that a later edit to the
    // table has to survive.
    expect(isReliableContainment('CONTAINED')).toBe(true);
    expect(isReliableContainment('ABSENT')).toBe(false);
    expect(isReliableContainment('UNSUPPORTED_VERSION')).toBe(false);
    expect(isReliableContainment('MALFORMED')).toBe(false);
    expect(isReliableContainment('NOT_THIS_LEASE')).toBe(false);
    expect(isReliableContainment('NOT_THIS_RUN')).toBe(false);
    expect(CONTAINMENT_READINGS.filter((r) => isReliableContainment(r))).toEqual(['CONTAINED']);
  });
});

/* ───────────────────────── 2. the mint, and only it ─────────────────────── */

/** Every `.ts` file under `src`. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
    }
  };
  walk(join(PACKAGE_ROOT, 'src'));
  return files;
}

/**
 * Every production module that can reach `name` from the internal attestation
 * module, by any static route.
 *
 * The same scan `tests/v2-07l-execution-lease.test.ts` runs against the lease
 * evidence's mint, restated rather than shared — the two documents are different
 * contracts and a single helper would be one edit that loosens both, which is
 * the argument `lease-document.ts` makes about its own restated patterns.
 *
 * The routes it refuses are the ones a review walked past the lease's first
 * version of this pin with: a namespace import, an awaited dynamic import, an
 * `export … from` re-export, and a specifier no static scan can resolve.
 */
function reachesInternalAttestation(name: string): string[] {
  const declaringModule = join(PACKAGE_ROOT, 'src', 'core', 'internal', 'containment-attestation.ts');
  const importers: string[] = [];
  for (const file of sourceFiles()) {
    if (file === declaringModule) continue;
    const text = readFileSync(file, 'utf8');
    const namesTheModule = /['"][^'"]*internal\/containment-attestation\.js['"]/.test(text);
    const named =
      namesTheModule &&
      new RegExp(
        String.raw`import[\s\S]{0,400}?\{[\s\S]{0,400}?${name}[\s\S]{0,400}?\}`,
      ).test(text);
    const indirect =
      namesTheModule &&
      (/import\s*\*\s*as\s+\w+/.test(text) ||
        /import\s*\(/.test(text) ||
        /export\s*(\*|\{[^}]*\})\s*from/.test(text));
    const unresolvable = /import\s*\(\s*[^'")\s]/.test(text) || /createRequire/.test(text);
    if (named || indirect || unresolvable) importers.push(relative(PACKAGE_ROOT, file));
  }
  return importers.sort();
}

describe('containment attestation — what may produce one', () => {
  it('refuses to mint for a launch whose job membership was never confirmed', () => {
    expect(mintContainmentAttestation({
      ownerPid: 1,
      helperPid: 2,
      childPid: 3,
      mode: 'JOBLIST',
      assignedAtCreation: true,
      launchNonce: 'a1b2c3d4',
      attestedAt: '2026-08-20T00:00:00.000Z',
      verifiedInJob: false,
    })).toBeNull();
  });

  it('refuses every input it cannot vouch for', () => {
    const base = {
      ownerPid: 1,
      helperPid: 2,
      childPid: 3,
      mode: 'JOBLIST',
      assignedAtCreation: true,
      launchNonce: 'a1b2c3d4',
      attestedAt: '2026-08-20T00:00:00.000Z',
      verifiedInJob: true,
    };
    expect(mintContainmentAttestation({ ...base, launchNonce: '' })).toBeNull();
    expect(mintContainmentAttestation({ ...base, launchNonce: 'short' })).toBeNull();
    expect(mintContainmentAttestation({ ...base, launchNonce: 'has space' })).toBeNull();
    expect(mintContainmentAttestation({ ...base, launchNonce: 'x'.repeat(129) })).toBeNull();
    // The shape the boundary actually produces. Pinned by value, because a
    // pattern written from a remembered hex nonce refused every real launch and
    // the whole suite stayed green — the mint is not the place to guess at a
    // format another module owns.
    expect(
      mintContainmentAttestation({ ...base, launchNonce: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }),
    ).not.toBeNull();
    expect(mintContainmentAttestation({ ...base, ownerPid: 0 })).toBeNull();
    expect(mintContainmentAttestation({ ...base, helperPid: -1 })).toBeNull();
    expect(mintContainmentAttestation({ ...base, childPid: 1.5 })).toBeNull();
    expect(mintContainmentAttestation({ ...base, mode: '' })).toBeNull();
    expect(mintContainmentAttestation({ ...base, attestedAt: 'yesterday' })).toBeNull();
    // And the shape that succeeds, so the refusals above are not all passing for
    // one shared reason.
    expect(mintContainmentAttestation(base)).not.toBeNull();
  });

  it('cannot be forged by shape, by prototype, or by the class itself', () => {
    const genuine = attestationFor(process.pid);
    expect(isContainmentAttestation(genuine)).toBe(true);

    // A plain object with everything an inspection could look for.
    const facts = containmentFactsOf(genuine);
    expect(isContainmentAttestation({ ...facts })).toBe(false);

    // The two routes that defeated this codebase's other opaque artefact.
    const proto = Object.getPrototypeOf(genuine) as object;
    expect(isContainmentAttestation(Object.create(proto) as unknown)).toBe(false);
    // The prototype's own back reference to the class is gone, so the class
    // cannot be reached from an instance. What is still visible through it is
    // `Object.prototype`'s inherited `constructor`, which is `Object` — calling
    // that builds a plain object, and the registry does not recognise one.
    expect(Object.prototype.hasOwnProperty.call(proto, 'constructor')).toBe(false);
    const reached = (proto as { constructor: new () => unknown }).constructor;
    expect(reached).toBe(Object);
    expect(isContainmentAttestation(new reached())).toBe(false);
    // And the gate cannot be switched off process-wide: the class is frozen.
    expect(Object.isFrozen(proto)).toBe(true);

    expect(containmentFactsOf({ ...facts })).toBeNull();
    expect(containmentFactsOf(undefined)).toBeNull();
  });

  it('has its mint imported by exactly one module in the product', () => {
    /**
     * The regression detector this artefact was shipped without, and its sibling
     * has two of. Anyone who can import the mint can produce a genuine
     * attestation for a launch that never happened — reproduced by an
     * adversarial review with `launchNonce: 'never-happened-01'` and pids 1 and
     * 2, straight through the recorder to `CONTAINED`.
     *
     * That is not a hole in the artefact: the mint's whole job is to be the one
     * place. It is a hole in the *guard*, because a second importer added
     * tomorrow is exactly the change nobody would notice, and the prose
     * admission in `core/containment-attestation.ts` names this privilege as the
     * bound the type is worth.
     *
     * The boundary adapter is the only module that has seen an established
     * containment, so it is the only one that may say so.
     */
    expect(reachesInternalAttestation('mintContainmentAttestation')).toEqual([
      join('src', 'boundary', 'owned-command.ts'),
    ]);
  });

  it('has the class itself reachable from only the module that needs it', () => {
    /**
     * A weaker pin than its sibling's, and the difference is worth stating
     * rather than inheriting the sibling's sentence.
     *
     * The lease evidence's version of this test says a *subclass* can construct
     * evidence, because that artefact's gate was once a private-field probe and
     * `super(…)` installs the field. This artefact's gate is registry membership
     * and nothing else, so a subclass buys nothing — measured, not assumed:
     * a subclass instance answers `holds() === false`, and therefore the public
     * `containmentFactsOf` answers `null` for it. Note where that `null` comes
     * from: the registry gate, not the field. `super(…)` really does install the
     * private field, so the internal `factsOf` static reads a subclass instance
     * perfectly well — a draft of this sentence claimed otherwise and was wrong
     * about which of the two checks does the work.
     *
     * So this pin is not a security boundary; it is a *notification*. It says
     * one module names the class today, and it will fail if a second one starts
     * to. It does **not** bound reachability: a value alias re-exported from the
     * public module lets a third module name the class without ever naming the
     * internal specifier, and an adversarial review walked past both pins that
     * way. What actually bounds forgery is that only the mint writes to the
     * registry, which the sibling test above pins.
     */
    expect(reachesInternalAttestation('ContainmentProof')).toEqual([
      join('src', 'core', 'containment-attestation.ts'),
    ]);
  });

  it('exposes a digest of the launch nonce and never the nonce', () => {
    const facts = containmentFactsOf(attestationFor(7, { launchNonce: 'deadbeefdeadbeef' }));
    expect(facts).not.toBeNull();
    expect(JSON.stringify(facts)).not.toContain('deadbeefdeadbeef');
    expect(facts?.launchDigest).toMatch(/^[0-9a-f]{64}$/);
    // Two launches, two digests.
    const other = containmentFactsOf(attestationFor(7, { launchNonce: 'cafebabecafebabe' }));
    expect(other?.launchDigest).not.toBe(facts?.launchDigest);
  });
});

/* ─────────────────────── 3. the recorder, on real leases ────────────────── */

describe('recording containment evidence into a lease', () => {
  it('records beside the lease, leaves the lease byte-identical, and reads back CONTAINED', () => {
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-alpha');
    const leaseBefore = readFileSync(path);
    expect(recordOf(repository)).toBeNull();

    const recorded = recordContainmentEvidence(
      repository,
      evidence,
      attestationFor(process.pid),
      { writerId: 'claude', now: tick },
    );
    expect(recorded.code).toBe('RECORDED');

    /**
     * The load-bearing assertion of the whole redesign, and it is about bytes
     * rather than about fields.
     *
     * The first version of this slice wrote the record *into* the lease. A
     * review reproduced the consequence: the record is written once per writer
     * launch, later records are routinely shorter than earlier ones, and an
     * interrupted in-place rewrite leaves a lease with no legible owner that its
     * own holder cannot release and nothing in this build can clear. Nothing
     * about the lease may change here — not its length, not a key order, not a
     * whitespace — because the moment it does, that window is back.
     */
    expect(readFileSync(path).equals(leaseBefore)).toBe(true);

    const containment = recordOf(repository);
    expect(containment).not.toBeNull();
    expect(containment?.evidenceVersion).toBe(CONTAINMENT_EVIDENCE_VERSION);
    expect(containment?.verifiedInJob).toBe(true);
    expect(containment?.runId).toBe('run-alpha');
    expect(containment?.writerId).toBe('claude');
    expect(containment?.ownerPid).toBe(process.pid);

    // And through the reader every consumer uses, not only by looking at keys.
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('replaces its own earlier record, and still never writes the lease', () => {
    // A run makes several `claude` spawns under one lease, so this is the
    // ordinary case rather than an edge one — and it is the case the in-lease
    // design got wrong, because the second record is not the same length as the
    // first.
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-repeat');
    const leaseBefore = readFileSync(path);

    const first = attestationFor(process.pid, { helperPid: 999_998, childPid: 999_999 });
    const second = attestationFor(process.pid, { helperPid: 11, childPid: 12 });
    expect(
      recordContainmentEvidence(repository, evidence, first, { writerId: 'claude', now: tick }).code,
    ).toBe('RECORDED');
    const afterFirst = recordOf(repository);
    expect(
      recordContainmentEvidence(repository, evidence, second, { writerId: 'claude', now: tick }).code,
    ).toBe('RECORDED');
    const afterSecond = recordOf(repository);

    expect(afterFirst?.childPid).toBe(999_999);
    expect(afterSecond?.childPid).toBe(12);
    // The second record really is shorter than the first, which is the fact the
    // withdrawn design's "never shorter" invariant denied.
    expect(JSON.stringify(afterSecond).length).toBeLessThan(JSON.stringify(afterFirst).length);
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    expect(readFileSync(path).equals(leaseBefore)).toBe(true);
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses an attestation that is not minted, and writes nothing', () => {
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-beta');
    const before = readFileSync(path);

    const facts = containmentFactsOf(attestationFor(process.pid));
    const result = recordContainmentEvidence(repository, evidence, { ...facts }, {
      writerId: 'claude',
      now: tick,
    });
    expect(result.code).toBe('ATTESTATION_INVALID');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(recordOf(repository)).toBeNull();
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('ABSENT');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses lease evidence that is not minted, and writes nothing', () => {
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-gamma');
    const before = readFileSync(path);
    const result = recordContainmentEvidence(repository, { leasePath: path }, attestationFor(process.pid), {
      writerId: 'claude',
      now: tick,
    });
    expect(result.code).toBe('EVIDENCE_INVALID');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(recordOf(repository)).toBeNull();
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a containment coupled to a process other than the lease owner', () => {
    // The whole inference the record supports is "the owner died, so the job
    // died, so the writer died". A job coupled to somebody else's process
    // supports none of it.
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-delta');
    const before = readFileSync(path);
    const result = recordContainmentEvidence(repository, evidence, attestationFor(process.pid + 1), {
      writerId: 'claude',
      now: tick,
    });
    expect(result.code).toBe('OWNER_MISMATCH');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(recordOf(repository)).toBeNull();
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses a lease that names no run', () => {
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, null);
    const before = readFileSync(path);
    const result = recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
      writerId: 'claude',
      now: tick,
    });
    expect(result.code).toBe('RUN_NOT_IDENTIFIED');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(recordOf(repository)).toBeNull();
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses when the lease at the path is no longer this holder\u2019s, and leaves it alone', () => {
    /**
     * The ABA case the single open handle exists for, in the form a test can
     * reach: the holder's lease is replaced on disk by another owner's. A
     * recorder that checked ownership at one moment and wrote at another would
     * overwrite a *legitimate* second writer's lease with this run's record.
     */
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-epsilon');
    const successor = { ...documentAt(path), ownerNonce: 'e'.repeat(64), runId: 'somebody-else' };
    const successorBytes = Buffer.from(`${JSON.stringify(successor, null, 2)}\n`, 'utf8');
    writeFileSync(path, successorBytes);

    const result = recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
      writerId: 'claude',
      now: tick,
    });
    expect(result.code).toBe('NOT_OWNER');
    expect(readFileSync(path).equals(successorBytes)).toBe(true);
    // And nothing was written beside it either: a process that has lost the
    // lease publishes no record for the holder that took it.
    expect(recordOf(repository)).toBeNull();
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses to remove a record it does not hold the lease for', () => {
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-omicron');
    expect(
      recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('RECORDED');

    // A successor takes the lease. The previous holder may not touch what is
    // there — removing evidence is still an effect on somebody else's
    // repository, and the gate on it is the same one the publish takes.
    const successor = { ...documentAt(path), ownerNonce: 'e'.repeat(64), runId: 'somebody-else' };
    writeFileSync(path, `${JSON.stringify(successor, null, 2)}\n`);
    expect(clearContainmentEvidence(repository, evidence).code).toBe('NOT_OWNER');
    expect(recordOf(repository)).not.toBeNull();

    // And the other refusals, which must also leave the record alone.
    const other = repositoryFixture('other-for-clear');
    expect(clearContainmentEvidence(other, evidence).code).toBe('LEASE_FOR_ANOTHER_REPOSITORY');
    expect(clearContainmentEvidence(repository, { leasePath: path }).code).toBe('EVIDENCE_INVALID');
    expect(recordOf(repository)).not.toBeNull();

    releaseRepositoryExecutionLease(evidence);
  });

  it('removes the record when it does hold the lease, and says which happened', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository, 'run-pi');
    // Three distinct successes, not one. A caller testing `code === 'RECORDED'`
    // must not read a removal as a publish, and a caller that needs to know
    // whether it destroyed something must be able to tell.
    expect(clearContainmentEvidence(repository, evidence).code).toBe('NOTHING_TO_CLEAR');
    expect(
      recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('RECORDED');
    expect(recordOf(repository)).not.toBeNull();
    expect(clearContainmentEvidence(repository, evidence).code).toBe('CLEARED');
    expect(recordOf(repository)).toBeNull();
    expect(clearContainmentEvidence(repository, evidence).code).toBe('NOTHING_TO_CLEAR');
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('ABSENT');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses to publish when the lease was taken by somebody else mid-call', () => {
    /**
     * The window the publish's re-proof exists to narrow, and nothing pinned it
     * — deleting `stillHeld()` left the whole suite green while restoring the
     * exact defect: the loser destroys the winner's genuine record and is told
     * `RECORDED`.
     *
     * The `now` seam is the hook. It is read after the ownership gate and before
     * the staged write, which is precisely inside the window, so a handover
     * performed from it is the real sequence rather than a simulation of one.
     */
    const repository = repositoryFixture();
    const first = leaseOf(repository, 'run-rho');
    let successorEvidence: ExecutionLeaseEvidence | null = null;

    const handOverTheLease = (): string => {
      if (successorEvidence === null) {
        releaseRepositoryExecutionLease(first.evidence);
        const second = leaseOf(repository, 'run-successor');
        successorEvidence = second.evidence;
        // The new holder records its own, genuine containment.
        expect(
          recordContainmentEvidence(repository, second.evidence, attestationFor(process.pid), {
            writerId: 'claude',
            now: tick,
          }).code,
        ).toBe('RECORDED');
      }
      return tick();
    };

    const loser = recordContainmentEvidence(repository, first.evidence, attestationFor(process.pid), {
      writerId: 'claude',
      now: handOverTheLease,
    });
    expect(loser.code).toBe('NOT_OWNER');
    expect(loser.detail).toBe('LOST_BEFORE_PUBLISH');
    // The successor's record survived, and is still the one that reads back.
    expect(recordOf(repository)?.runId).toBe('run-successor');
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    if (successorEvidence !== null) releaseRepositoryExecutionLease(successorEvidence);
  });

  it('does not throw for a clock or a request the caller got wrong', () => {
    // `leasedAgent` does not catch, on the strength of this function's "never
    // throws". A caller-supplied function is somebody else's code, so calling it
    // is the one line here that can throw, and it is guarded rather than trusted.
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-sigma');
    const before = readFileSync(path);
    const hostile = [
      () => {
        throw new Error('no clock today');
      },
      undefined as unknown as () => string,
      42 as unknown as () => string,
    ];
    for (const now of hostile) {
      const result = recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now,
      });
      expect(result.code).toBe('RECORD_NOT_READABLE_BACK');
      expect(recordOf(repository)).toBeNull();
    }
    expect(
      recordContainmentEvidence(repository, evidence, attestationFor(process.pid), null as never).code,
    ).toBe('RECORD_NOT_READABLE_BACK');
    expect(readFileSync(path).equals(before)).toBe(true);
    releaseRepositoryExecutionLease(evidence);
  });

  it('reports a removal it could not perform, rather than claiming success', () => {
    /**
     * A failure that is not conservative: a clear that cannot remove the record
     * leaves the previous launch's positive record standing, so the lease keeps
     * reading `CONTAINED` about a writer that was not contained. It is not the
     * *only* such failure — see the note on the code below — but it is the one
     * this case can reach.
     *
     * It has no retry. One was added for exactly this reason and withdrawn in
     * the next round: its justification — that a reader holding the file open
     * refuses the removal — was measured false, and its ownership proof sat
     * outside its loop, which is how a retried removal reached a successor's
     * record.
     *
     * A non-empty directory at the record path is the way to make `unlink`
     * refuse. It is also, as far as this build can tell, the *only* way: node
     * opens files with `FILE_SHARE_DELETE`, so a reader holding the record open
     * blocks a rename onto the name and does not block a removal of it. That
     * measurement is why the retry a previous round gave this operation was
     * withdrawn — it named a hazard that does not apply here, and its gate sat
     * outside its loop.
     */
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository, 'run-tau');
    const path = recordPathOf(repository);
    mkdirSync(path);
    writeFileSync(join(path, 'occupied'), 'x');

    const result = clearContainmentEvidence(repository, evidence);
    /**
     * Its own code, not the publish's — because it says **which operation**
     * failed, and for no stronger reason than that.
     *
     * This comment used to say the two point in opposite safety directions: a
     * publish that failed wrote nothing, a removal that failed left a stale
     * positive. That is false under the final design and it is the half worth
     * being exact about, because Slice 5 derives recovery decisions from this
     * semantics. A run makes several writer launches under one lease, so a
     * **failed publish also leaves the previous launch's record standing** — the
     * lease keeps reading `CONTAINED` about the older launch, exactly as it does
     * after a failed clear. Measured, and stated on `RECORD_WRITE_FAILED`'s own
     * member doc and in `containment-evidence.ts`'s residue list.
     *
     * So: both failures can leave a stale positive. Neither is announced
     * anywhere a reader of the record can see it. What the two codes separate is
     * what the caller was trying to do, and therefore what it may try next.
     */
    expect(result.code).toBe('RECORD_CLEAR_FAILED');
    expect(result.detail).not.toBeNull();
    // And it is not mistaken for either success, nor for the publish's failure.
    expect(result.code).not.toBe('CLEARED');
    expect(result.code).not.toBe('NOTHING_TO_CLEAR');
    expect(result.code).not.toBe('RECORD_WRITE_FAILED');

    rmSync(path, { recursive: true, force: true });
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses when there is no lease at all', () => {
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-zeta');
    rmSync(path);
    expect(
      recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('LEASE_ABSENT');
  });

  it('refuses a repository the evidence was not taken for', () => {
    const held = repositoryFixture('held');
    const other = repositoryFixture('other');
    const { evidence } = leaseOf(held, 'run-eta');
    expect(
      recordContainmentEvidence(other, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('LEASE_FOR_ANOTHER_REPOSITORY');
    releaseRepositoryExecutionLease(evidence);
  });

  it('refuses to publish a record it would not read back as reliable', () => {
    // The clock is a seam. A `now` that returns something the contract refuses
    // is enough to build an unreadable record, and the read-back is what stops
    // it reaching the file — the same guard `acquire` puts on its own document.
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-theta');
    const before = readFileSync(path);
    const result = recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
      writerId: 'claude',
      now: () => 'not an instant',
    });
    expect(result.code).toBe('RECORD_NOT_READABLE_BACK');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(recordOf(repository)).toBeNull();
    releaseRepositoryExecutionLease(evidence);
  });
});

/* ────────── 4. legacy compatibility, and what recovery may see ──────────── */

describe('legacy leases and the recovery classification', () => {
  it('keeps the lease readable whatever the record beside it says', () => {
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-iota');
    const leaseBytes = readFileSync(path);

    for (const [label, contents, expected] of [
      ['garbage', '42', 'MALFORMED'],
      // A file somebody wrote is never `ABSENT`, whatever is in it. This one
      // used to read absent, justified by a build that no longer exists.
      ['the JSON value null', 'null', 'MALFORMED'],
      ['not JSON at all', '{ half a rec', 'MALFORMED'],
      ['an empty file', '', 'MALFORMED'],
      ['a future version', '{"evidenceVersion":99,"anything":"goes"}', 'UNSUPPORTED_VERSION'],
      [
        'a foreign record',
        JSON.stringify(bound({}, { leaseKey: 'X', ownerNonce: 'f'.repeat(64) })),
        'NOT_THIS_LEASE',
      ],
    ] as ReadonlyArray<readonly [string, string, ContainmentReading]>) {
      writeFileSync(recordPathOf(repository), contents);
      const inspection = inspectRepositoryExecutionLease(repository);
      // The lease is untouched by any of this. An enrichment may not lock a
      // repository, and here it cannot even reach the file that would.
      expect(readFileSync(path).equals(leaseBytes), label).toBe(true);
      expect(safeParseExecutionLease(documentAt(path)).success, label).toBe(true);
      expect(inspection.state, label).toBe('HELD');
      expect(inspection.ownerPid, label).toBe(process.pid);
      expect(inspection.containment, label).toBe(expected);
    }

    // A record nobody can read is not a record nobody wrote: an unreadable
    // companion must refuse rather than answer `ABSENT`.
    rmSync(recordPathOf(repository));
    mkdirSync(recordPathOf(repository));
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('MALFORMED');
    rmSync(recordPathOf(repository), { recursive: true });

    /**
     * And the case that made this rule real rather than decorative: a dangling
     * junction. `readFileSync` follows it and reports the *target's* `ENOENT`,
     * so an `ENOENT`-means-absent reader answers `ABSENT` — telling an operator
     * no record was ever written, about a path that visibly has an entry on it.
     * `lstat` does not follow, which is what separates the two.
     */
    const dangling = join(repository.gitCommonDir, 'ao-v3-04-dangling-target');
    mkdirSync(dangling);
    try {
      symlinkSync(dangling, recordPathOf(repository), 'junction');
    } catch {
      // A host that will not create a junction cannot measure this. Skipped
      // loudly rather than silently: the assertion below is simply not made.
    }
    if (existsSync(recordPathOf(repository))) {
      rmSync(dangling, { recursive: true, force: true });
      expect(inspectRepositoryExecutionLease(repository).containment).toBe('MALFORMED');
      rmSync(recordPathOf(repository), { force: true });
    }
    rmSync(dangling, { recursive: true, force: true });

    expect(inspectRepositoryExecutionLease(repository).containment).toBe('ABSENT');
    releaseRepositoryExecutionLease(evidence);
  });

  it('ignores a record left behind by an earlier lease', () => {
    // The companion is not removed on release, so the next holder finds it. It
    // is bound to the lease that wrote it, so it refuses rather than carrying
    // over — which is the direction that matters, because carrying over would
    // credit a fresh lease with somebody else's containment.
    const repository = repositoryFixture();
    const first = leaseOf(repository, 'run-first');
    expect(
      recordContainmentEvidence(repository, first.evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('RECORDED');
    releaseRepositoryExecutionLease(first.evidence);
    expect(recordOf(repository)).not.toBeNull();

    const second = leaseOf(repository, 'run-second');
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('NOT_THIS_LEASE');
    releaseRepositoryExecutionLease(second.evidence);
  });

  it('reports no reading at all when there is no lease document', () => {
    const repository = repositoryFixture();
    // `null` and `'ABSENT'` are two different facts; a state with no parsed
    // document must not claim a lease was read and carried nothing.
    expect(inspectRepositoryExecutionLease(repository).containment).toBeNull();
    expect(assessLeaseRecovery(repository).containment).toBeNull();
    expect(assessLeaseRecovery(repository).latestLaunchContained).toBe(false);
  });

  it('lets recovery see containment and changes no classification because of it', () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository, 'run-kappa');

    const gone = () => 'NOT_FOUND' as const;
    const before = assessLeaseRecovery(repository, { processAlive: gone });
    expect(before.classification).toBe('STALE_OWNER_GONE');
    expect(before.containment).toBe('ABSENT');
    expect(before.latestLaunchContained).toBe(false);

    expect(
      recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('RECORDED');

    const after = assessLeaseRecovery(repository, { processAlive: gone });
    // The reading changed. The classification did not, and that is the whole
    // scope boundary of this slice: nothing is recovered, removed or taken over
    // because a lease can now prove its writer was contained.
    expect(after.containment).toBe('CONTAINED');
    expect(after.latestLaunchContained).toBe(true);
    expect(after.classification).toBe(before.classification);
    expect(after.inspection.state).toBe('HELD');

    // And with a live owner, still just a report.
    const alive = assessLeaseRecovery(repository, { processAlive: () => 'ALIVE' as const });
    expect(alive.classification).toBe('OWNER_RUNNING');
    expect(alive.latestLaunchContained).toBe(true);

    releaseRepositoryExecutionLease(evidence);
  });
});

/* ───────────────── 5. the wiring, from the boundary upwards ─────────────── */

/** A `BoundaryStatus` the adapter will accept, overridable field by field. */
function status(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boundary: 'OK',
    failure: null,
    win32: null,
    mode: 'JOBLIST',
    helperPid: 4242,
    childPid: 4343,
    verifiedInJob: true,
    assignedAtCreation: true,
    jobHandleInheritable: false,
    jobMembersAtStart: 1,
    jobMembersAtEnd: 0,
    childExitCode: 0,
    terminatedByOwnerLoss: false,
    stdinForward: null,
    nonce: 'a1b2c3d4e5f60718',
    targetStarted: true,
    childExitUnobservable: false,
    raw: {},
    ...over,
  };
}

/**
 * Drives `runOwnedCommand` with a substituted launch.
 *
 * Proves the *gate* — which endings may attest and which may not — and nothing
 * about a real process. A substituted `start` supplies the values the mint sees,
 * so a seam can cause an attestation to exist; production never injects one, and
 * the real measurement is the dist-artifact harness. That is the same honesty
 * `ExecutionLeaseDependencies.link` records about its own seam.
 */
async function ownedRun(over: {
  readonly established?: boolean;
  readonly verifiedInJob?: boolean;
  readonly ending?: Record<string, unknown>;
} = {}): Promise<OwnedCommandResult> {
  const ending = over.ending ?? { ending: 'CHILD_EXITED', childExitCode: 0, status: status() };
  return runOwnedCommand(
    { file: 'C:\\Windows\\System32\\cmd.exe', args: [], timeoutMs: 5_000 },
    {
      start: async () => {
        if (over.established === false) {
          return { established: false, ending } as never;
        }
        // Real streams, ended immediately. A helper without both of them is the
        // `BOUNDARY_STREAMS_UNAVAILABLE` path, which is a lost boundary — so a
        // fake with no pipes would measure the wrong branch of this gate.
        const out = new PassThrough();
        const err = new PassThrough();
        out.end();
        err.end();
        return {
          established: true,
          process: {
            helper: { stdout: out, stderr: err, stdin: null },
            helperPid: 4242,
            childPid: 4343,
            mode: 'JOBLIST',
            assignedAtCreation: true,
            verifiedInJob: over.verifiedInJob ?? true,
            jobMembersAtStart: 1,
            workDir: 'C:\\nowhere',
            terminate: () => undefined,
            ending: Promise.resolve(ending),
            dispose: () => undefined,
          },
        } as never;
      },
    },
  );
}

describe('the wiring — what may carry an attestation upwards', () => {
  it('attests an established run that ended accountably', async () => {
    const result = await ownedRun();
    expect(result.outcome).toBe('COMPLETED');
    expect(isContainmentAttestation(result.containment)).toBe(true);
    const facts = containmentFactsOf(result.containment);
    expect(facts?.ownerPid).toBe(process.pid);
    expect(facts?.childPid).toBe(4343);
  });

  it('attests nothing for a boundary that was never established', async () => {
    const result = await ownedRun({
      established: false,
      ending: { ending: 'BOUNDARY_REFUSED', failureCode: 'BOUNDARY_EXECUTABLE_MISSING', win32: null, targetStarted: 'NO', status: null },
    });
    expect(result.established).toBe(false);
    expect(result.outcome).toBe('LAUNCH_REFUSED');
    expect(result.containment).toBeNull();
  });

  it('attests nothing for a boundary that was lost', async () => {
    const result = await ownedRun({
      ending: { ending: 'BOUNDARY_LOST', reason: 'HELPER_DIED', status: status() },
    });
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.containment).toBeNull();
  });

  it('attests nothing when job membership was never confirmed', async () => {
    // Unreachable through the real boundary, which refuses such a launch. Pinned
    // anyway: the mint is what makes it unreachable, and a mint that stopped
    // checking would leave nothing else asking.
    const result = await ownedRun({ verifiedInJob: false });
    expect(result.containment).toBeNull();
  });

  it('attests nothing when the status carries no launch nonce', async () => {
    const result = await ownedRun({
      ending: { ending: 'CHILD_EXITED', childExitCode: 0, status: status({ nonce: null }) },
    });
    expect(result.outcome).toBe('COMPLETED');
    expect(result.containment).toBeNull();
  });

  it('carries a minted attestation through runCommand and drops anything else', async () => {
    const owned = await ownedRun();
    const carried = toCommandResultFields(owned);
    expect(carried.containment).toBe(owned.containment);

    // A fabricated result — which is what a substituted `runOwned` seam can
    // produce — carries nothing, because the registry gate is what decides.
    const forged = { ...owned, containment: { pretend: true } } as unknown as OwnedCommandResult;
    expect(toCommandResultFields(forged).containment).toBeUndefined();
    expect('containment' in toCommandResultFields(forged)).toBe(false);

    /**
     * And an unaccountable outcome drops it even when the attestation itself is
     * genuine. This is the pair the fail-closed branch does *not* catch — a
     * lost boundary carrying its declared failure code is a well-formed result —
     * so it is the case the outcome table exists for, asserted row by row.
     */
    for (const [outcome, failureCode] of [
      ['BOUNDARY_LOST', 'BOUNDARY_LOST'],
      ['SPAWN_FAILED', 'LAUNCH_REFUSED'],
    ] as ReadonlyArray<readonly [string, string]>) {
      const refused = { ...owned, outcome, failureCode } as unknown as OwnedCommandResult;
      expect(toCommandResultFields(refused).containment, outcome).toBeUndefined();
    }
    // The three that may carry one, so the table is not passing by refusing
    // everything.
    for (const [outcome, failureCode] of [
      ['COMPLETED', null],
      ['TIMED_OUT', 'TIMEOUT'],
      ['OUTPUT_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_STDOUT'],
    ] as ReadonlyArray<readonly [string, string | null]>) {
      const accountable = { ...owned, outcome, failureCode } as unknown as OwnedCommandResult;
      expect(toCommandResultFields(accountable).containment, outcome).toBe(owned.containment);
    }
  });

  it('carries it through the agent seam on both the ran and unavailable branches', async () => {
    const owned = await ownedRun();
    const attestation = owned.containment;
    expect(attestation).not.toBeNull();

    const base: CommandResult = {
      display: 'claude',
      executable: 'claude',
      args: [],
      started: true,
      outcome: 'COMPLETED',
      exitCode: 0,
      signal: null,
      stdout: '{}',
      stderr: '',
      failureCode: null,
      errnoCode: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutBytesObserved: 0,
      stderrBytesObserved: 0,
      stdinDelivery: 'DELIVERED',
      processTreeKilled: false,
      startedAt: '2026-08-20T00:00:00.000Z',
      finishedAt: '2026-08-20T00:00:01.000Z',
      durationMs: 1000,
      ...(attestation === null ? {} : { containment: attestation }),
    };
    expect(toAgentCommandResult(base).outcome).toBe('RAN');
    expect(toAgentCommandResult(base).containment).toBe(attestation);

    // A timed-out writer was still contained: the tree died with the boundary,
    // whatever the run said.
    const timedOut: CommandResult = { ...base, outcome: 'TIMED_OUT', failureCode: 'TIMEOUT' };
    expect(toAgentCommandResult(timedOut).outcome).toBe('UNAVAILABLE');
    expect(toAgentCommandResult(timedOut).containment).toBe(attestation);

    // And absence stays absence, not an `undefined` somebody decided on.
    const { containment: _none, ...withoutContainment } = base;
    expect('containment' in toAgentCommandResult(withoutContainment)).toBe(false);
  });

  it('records the writer\u2019s containment through the leased seam, and only the writer\u2019s', async () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository, 'run-lambda');
    const attestation = (await ownedRun()).containment;
    expect(attestation).not.toBeNull();

    const agentResult = (): AgentCommandResult =>
      Object.freeze({
        outcome: 'RAN' as const,
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        outputTruncated: false,
        outputBytesObserved: 0,
        failureCode: null,
        errnoCode: null,
        durationMs: 1,
        ...(attestation === null ? {} : { containment: attestation }),
      });

    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () => agentResult(),
      containmentNow: tick,
    });

    // The reviewer is read-only. Its containment says nothing about whether a
    // dead owner left a *writer* behind, so it is not recorded as one.
    await run('codex', [], repository.root, '');
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('ABSENT');

    await run('claude', [], repository.root, '');
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    releaseRepositoryExecutionLease(evidence);
  });

  it('takes the previous record away when a writer launch cannot be attested', async () => {
    /**
     * The defect an adversarial review reproduced, pinned as the behaviour that
     * closes it.
     *
     * A run makes several `claude` launches under one lease. Publishing only on
     * success left an unattested launch standing on the *previous* launch's
     * positive record, so the lease read `CONTAINED` — and the assessment said
     * the latest writer was contained — while the writer that had just run was
     * not contained at all. That is the fail-open direction in the one place
     * this slice exists to be conservative.
     *
     * Note what makes this test non-vacuous: it starts from a lease that
     * *already* reads `CONTAINED`. A version of it that started from a fresh
     * lease would assert `ABSENT` and pass whether or not the removal exists.
     */
    const repository = repositoryFixture();
    const { evidence, path } = leaseOf(repository, 'run-nu');
    const leaseBefore = readFileSync(path);
    const contained = (await ownedRun()).containment;
    expect(contained).not.toBeNull();

    const result = (attestation: unknown): AgentCommandResult =>
      Object.freeze({
        outcome: 'RAN' as const,
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        outputTruncated: false,
        outputBytesObserved: 0,
        failureCode: null,
        errnoCode: null,
        durationMs: 1,
        ...(attestation === null ? {} : { containment: attestation as ContainmentAttestation }),
      });

    let next: AgentCommandResult = result(contained);
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () => next,
      containmentNow: tick,
    });

    await run('claude', [], repository.root, '');
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
    expect(assessLeaseRecovery(repository).latestLaunchContained).toBe(true);

    // The second launch: the boundary was lost, so there is no attestation.
    next = result(null);
    await run('claude', [], repository.root, '');
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('ABSENT');
    expect(assessLeaseRecovery(repository).latestLaunchContained).toBe(false);
    expect(recordOf(repository)).toBeNull();
    // And the lease is still untouched by any of it.
    expect(readFileSync(path).equals(leaseBefore)).toBe(true);
    releaseRepositoryExecutionLease(evidence);
  });

  it('does not take a reviewer run as evidence about the writer, either way', () => {
    // The reviewer is read-only, so its containment says nothing about whether a
    // dead owner left a *writer* behind — and an unattested reviewer run must
    // not remove the writer's record either.
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository, 'run-xi');
    expect(
      recordContainmentEvidence(repository, evidence, attestationFor(process.pid), {
        writerId: 'claude',
        now: tick,
      }).code,
    ).toBe('RECORDED');

    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () =>
        Object.freeze({
          outcome: 'RAN' as const,
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          outputTruncated: false,
          outputBytesObserved: 0,
          failureCode: null,
          errnoCode: null,
          durationMs: 1,
        }),
      containmentNow: tick,
    });
    return run('codex', [], repository.root, '').then(() => {
      expect(inspectRepositoryExecutionLease(repository).containment).toBe('CONTAINED');
      releaseRepositoryExecutionLease(evidence);
    });
  });

  it('records nothing when the agent result carries no attestation', async () => {
    const repository = repositoryFixture();
    const { evidence } = leaseOf(repository, 'run-mu');
    const run = leasedAgent({
      lease: { repository, evidence },
      agent: async () =>
        Object.freeze({
          outcome: 'RAN' as const,
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          outputTruncated: false,
          outputBytesObserved: 0,
          failureCode: null,
          errnoCode: null,
          durationMs: 1,
        }),
      containmentNow: tick,
    });
    await run('claude', [], repository.root, '');
    expect(inspectRepositoryExecutionLease(repository).containment).toBe('ABSENT');
    releaseRepositoryExecutionLease(evidence);
  });
});
