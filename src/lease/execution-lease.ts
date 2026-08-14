/**
 * The repository execution lease: who may produce effects here, right now.
 *
 * ── The one invariant this module exists to hold ───────────────────────────
 *
 * > For one repository, at most one productive orchestrator writer holds
 * > authority at a time.
 *
 * "One repository" is the **local Git administrative domain**, and that choice
 * is load-bearing rather than incidental. `repositoryId` is the profile's
 * *declared logical* identity: two clones of one remote answer the same id and
 * are two independent local writers that must not exclude each other, while two
 * worktrees of one clone answer the same id and are one writer that must.
 * Nothing but the normalised `git-common-dir` separates those, and it is exactly
 * the information that proved worktree membership in V2-06A.
 *
 * The lease file therefore lives in that directory:
 *
 *     <git common dir>/agent-orchestrator-execution-lease.json
 *
 * Every worktree of a clone resolves to it, including the orchestrator's own
 * `<root>.worktrees/<task>` workspaces; two clones resolve to two different
 * ones. It is also the one place a lock can live without being in a working
 * tree — a lease inside the checkout would dirty it, show up in `git status`,
 * and refuse the next workspace with `SOURCE_WORKTREE_DIRTY`, and it would need
 * a new ignore obligation from every target repository. It is deliberately not
 * under `~/.agent-orchestrator/`: a per-OS-user lock would let two users of one
 * checkout each hold "the" lease, which is the split-brain this module exists to
 * prevent.
 *
 * ── Acquisition is one operation, because check-then-write is not enough ───
 *
 * V2-07 shipped a store whose "only if there is none" was a read followed,
 * several syscalls later, by a write, and documented honestly that two callers
 * racing both win. That is the defect this module must not reproduce, so the
 * claim is a single exclusive-create operation whose failure mode is precisely
 * "somebody else has it".
 *
 * ── …and the lease appears complete, or not at all ─────────────────────────
 *
 * The first version claimed with `open(…, 'wx')` and wrote the record through
 * the same handle afterwards. That is exclusive, and it was not enough — proven
 * by the real-process race in `tests/dist-artifact/`, not by reasoning. Sixteen
 * processes reaching for one lease produced exactly one winner every time, and
 * *some of the losers saw the winner's file before its record was in it*. They
 * refused, correctly, and refused with the wrong word: `STALE_LEASE_RECOVERY_UNSAFE`
 * for a lease whose owner was running perfectly well. That is the one confusion
 * the two codes exist to prevent, and it pointed an operator straight at
 * clearing a healthy run.
 *
 * So the record is written to a temporary file in the same directory, flushed,
 * closed, and only then **linked** onto the lease name. `link` is atomic and
 * fails with `EEXIST` when the target exists, so it is exclusive *and* publishes
 * the whole record in the same instant. There is no moment at which a lease
 * exists and is incomplete.
 *
 * `link` is not available on every filesystem — FAT and some network mounts
 * refuse it — so a non-`EEXIST` failure falls back to the original `wx` claim.
 * That path is still exclusive and still fail-closed; it only reopens the
 * narrow window above, on filesystems where nothing better is offered. The two
 * branches are stated rather than blended, because they differ in what a loser
 * is told and that is worth being able to read.
 *
 * A crash before the link leaves an orphan temporary file, which nothing reads —
 * `state/atomic-file.ts` makes the same argument about its own. A crash after it
 * leaves a complete, parseable lease with a dead owner, which is exactly the
 * case the recovery contract below is written for.
 *
 * ── Recovery: measured, and deliberately refused ───────────────────────────
 *
 * The question a stale lease asks is whether a dead owner proves no writer
 * survives it. That was measured on this build's spawn path rather than read
 * out of documentation, and the answer is no:
 *
 *  - killing only the orchestrator process did take its whole agent tree with
 *    it on the Windows host this was measured on — but every process involved
 *    was inside a **Job Object the orchestrator did not create**, inherited from
 *    whatever launched it. `doctor/exec.ts` says as much in its own header:
 *    kernel-enforced ownership of the tree "would need … a Windows Job Object,
 *    which is a separate architecture and deliberately not part of this module";
 *  - on POSIX the agent is spawned `detached`, which makes it a process-group
 *    leader — the opposite of a lifetime tied to its parent's.
 *
 * So the tree lifetime observed on one host is a **platform observation, not a
 * platform guarantee**, and it is not the orchestrator's to assert. Nothing here
 * takes a lease over automatically. An owner that cannot be shown to be running
 * is reported as {@link STALE_LEASE_RECOVERY_UNSAFE} and the lease is left
 * exactly where it is.
 *
 * This module ships **no policy for clearing one** other than its owner
 * releasing it, and as of the second withdrawal of the attended break there is no
 * such policy anywhere in the build. The guarded primitive is here —
 * {@link removeVerifiedLease}, whose whole authority is the predicate it is
 * handed — and its four call sites are all in this file: two acquire rollbacks
 * and `release`.
 *
 * This paragraph used to say the module ships "no way to clear one", which was
 * false in the plainest sense: it exports the removal primitive and always did.
 * What it meant was that the *decision* to clear somebody else's lease lived
 * elsewhere. It no longer lives anywhere; `lease-recovery.ts` now only classifies.
 *
 * What has not changed is what a *lease* does on its own: nothing here takes one
 * over, and no probe result licenses anything. An owner that cannot be shown to
 * be running is reported as {@link STALE_LEASE_RECOVERY_UNSAFE} and the lease is
 * left exactly where it is until a human decides otherwise. Automatic recovery
 * additionally needs owned process containment — necessarily before unattended
 * running.
 *
 * ── Liveness may refuse, and may never permit ──────────────────────────────
 *
 * {@link ProcessLivenessProbe} exists so an operator is told "somebody is
 * running — wait" rather than "a run died here — clear it", which are two
 * different places to go. It is never authority: pids are reused, so `ALIVE` can
 * be a stranger. That is safe in exactly one direction, and the direction is
 * enforced here — liveness can only ever *add* a refusal: acquire refuses
 * whatever it says.
 *
 * With the attended break withdrawn, no code path anywhere consults a probe
 * before an effect at all. The claim that stood here — "no code path anywhere
 * permits an effect because a probe said a process is gone" — was false while the
 * break existed: its gate *required* `STALE_OWNER_GONE`, so a `NOT_FOUND` was a
 * necessary condition for the removal. It was not sufficient, since an operator
 * also had to authorise, and that is what the sentence was reaching for. Stating
 * it as "no code path anywhere" made a load-bearing safety property out of
 * something the code did not do, which is the worst direction for such a claim to
 * be wrong in: it invites deleting the gate arm as decorative.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { comparePathIdentity } from '../core/path-identity.js';
import {
  ExecutionLeaseProof,
  mintExecutionLeaseEvidence,
} from '../core/internal/execution-lease-evidence.js';
import {
  isExecutionLeaseEvidence,
  type ExecutionLeaseEvidence,
} from '../core/execution-lease-evidence.js';
import { safeErrnoCode } from '../core/safe-error.js';
import {
  EXECUTION_LEASE_SCHEMA_VERSION,
  safeParseExecutionLease,
  type ExecutionLease,
} from './lease-document.js';

/** The single file that is one repository's lease. A plain name, never derived. */
export const EXECUTION_LEASE_FILE_NAME = 'agent-orchestrator-execution-lease.json';

/** Largest lease document this build will read back. Generous by orders of magnitude. */
export const MAX_EXECUTION_LEASE_BYTES = 65_536;

/**
 * The repository facts a lease is derived from.
 *
 * Stated as its own shape rather than as `ResolvedRepository`, exactly as
 * `WorkspaceIdentityInput` is: these are the only three fields read, and a
 * function that accepted the whole resolved repository could quietly start
 * depending on a policy the lease has no business consulting. A
 * `ResolvedRepository` is assignable here.
 */
export interface LeaseRepository {
  /** Normalised, absolute Git common directory. The lease key. */
  readonly gitCommonDir: string;
  /** Canonical repository root. Recorded for diagnosis, never the key. */
  readonly root: string;
  /** The profile's declared identity. Recorded for diagnosis, never the key. */
  readonly id: string;
}

/**
 * One reading of a repository record, frozen, for a gate and its effect to share.
 *
 * ── The defect this closes (LF-2) ──────────────────────────────────────────
 *
 * {@link LeaseRepository} is a bare structural interface, so nothing says its
 * three fields are *values*. A record whose `root` is an accessor answers one
 * repository when {@link verifyExecutionLeaseHeldFor} asks and another when the
 * effect that follows asks — and both answers are true, separately. The gate
 * proves the lease of A; the branch, the worktree or the write lands in B. An
 * adversarial review reproduced exactly that against `prepareTaskWorkspace`,
 * `removeTaskWorkspace` and `advanceTaskState`, with nothing forged anywhere:
 * two genuine repositories and one record that changes its mind.
 *
 * No amount of care inside this module can fix it, because the second read is in
 * the caller. What fixes it is that there is no second read: every entry point
 * that gates and then acts takes **one** reading at its top and uses only that.
 *
 * ── Why a spread, and what it does and does not promise ────────────────────
 *
 * The spread reads each own enumerable property exactly once, which is the whole
 * mechanism, and `freeze` stops the copy acquiring a mind of its own afterwards.
 * It is a shallow copy: nested policy objects are shared with the original, and
 * that is deliberate — the fields an authority decision reads are all scalars,
 * and deep-copying a `ResolvedRepository` would be a different, larger promise.
 *
 * An accessor inherited from a *prototype* is not copied at all, so the field
 * arrives `undefined` and every gate refuses it. Fail-closed, which is the
 * direction this has to fail in.
 */
export function snapshotRepositoryRecord<T extends LeaseRepository>(repository: T): T {
  return Object.freeze({ ...repository });
}

/* ───────────────────────────── liveness ─────────────────────────────────── */

/** What can be said about a recorded owner process. A closed set. */
export type ProcessLiveness = 'ALIVE' | 'NOT_FOUND' | 'UNDETERMINED';

export type ProcessLivenessProbe = (pid: number) => ProcessLiveness;

/**
 * The real probe: signal 0, which checks for the process without touching it.
 *
 * `EPERM` means the process exists and belongs to somebody else, which is
 * `ALIVE` for every purpose here. Anything else is a refusal to answer, and a
 * refusal to answer is never read as an absence.
 */
export const osProcessLiveness: ProcessLivenessProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return 'ALIVE';
  } catch (error) {
    const code = safeErrnoCode(error);
    if (code === 'ESRCH') return 'NOT_FOUND';
    if (code === 'EPERM') return 'ALIVE';
    return 'UNDETERMINED';
  }
};

/**
 * The seams this module takes. Both default to the real thing.
 *
 * `processAlive` is a test seam of the same class as `ReplaceFn` in
 * `state/atomic-file.ts`: it exists because a dead owner cannot be produced on
 * demand against a real host without racing a real process. It is documented as
 * a test seam rather than quietly available — and note what it cannot do:
 * because liveness only ever adds refusals to `acquire`, no substitute can make
 * this module hand out a lease it would otherwise withhold.
 */
export interface ExecutionLeaseDependencies {
  /** The clock, read once for the durable record. */
  readonly now: () => string;
  readonly processAlive?: ProcessLivenessProbe;
  /**
   * The atomic publish. Production uses `linkSync`.
   *
   * Injectable for the same reason `ReplaceFn` is in `state/atomic-file.ts`: the
   * fallback below exists for filesystems that refuse to link, and no test can
   * make NTFS refuse on demand. Without a seam that branch would ship having
   * never run — an untested path in the one mechanism the whole slice rests on.
   *
   * ── What this seam is, stated exactly ──────────────────────────────────
   *
   * It is a **test seam, and it is load-bearing**: exclusivity of the value this
   * function returns rests on the injected operation being an atomic
   * create-if-absent. An earlier draft of this comment claimed the seam "cannot
   * widen anything", on the reasoning that a substitute must still have staged a
   * real record first. The adversarial review disproved it in one line — staging
   * is not publishing. `link: () => {}` makes two consecutive acquisitions both
   * return minted evidence with no lease file on disk at all.
   *
   * What actually contains that is downstream, not here: every consumption point
   * re-proves the lease against the file (`run-driver.ts` on every iteration,
   * `start-task.ts` and `release-workspace.ts` before anything is created), so
   * evidence that no file backs stops the run at the next checkpoint rather than
   * authorising a write. Production never injects this — the package exports only
   * the CLI — and the honest description is "a seam whose contract the caller
   * must keep", not "a seam that cannot be abused".
   */
  readonly link?: (from: string, to: string) => void;
}

/* ───────────────────────────── location ─────────────────────────────────── */

export interface LeaseLocation {
  readonly ok: true;
  readonly path: string;
  readonly key: string;
}

export interface LeaseLocationFailure {
  readonly ok: false;
  readonly code: 'LEASE_LOCATION_UNSUITABLE';
}

export type LeaseLocationResult = LeaseLocation | LeaseLocationFailure;

/**
 * The one file that is this repository's lease, or why there cannot be one.
 *
 * A relative common directory is refused rather than resolved: `path-identity.ts`
 * gives the reasoning at length, and it applies here with extra force, because
 * resolving against `process.cwd()` would make *which repository is locked* a
 * property of the operator's shell.
 */
export function deriveExecutionLeaseLocation(repository: LeaseRepository): LeaseLocationResult {
  const key = repository.gitCommonDir;
  if (typeof key !== 'string' || key.trim().length === 0 || !isAbsolute(key)) {
    return Object.freeze({ ok: false as const, code: 'LEASE_LOCATION_UNSUITABLE' as const });
  }
  // `isAbsolute` is not enough on Windows, and this is the one place in the
  // codebase where that narrowness bites hardest. It answers `true` for a
  // **drive-relative** root — `\foo`, and `/foo`, which normalises to the same
  // thing — which is absolute only within whichever volume the process happens
  // to be standing on. `core/path-identity.ts` records the same gap (F-4) and
  // deliberately leaves it open, because there the value is only ever a
  // comparison operand. Here it becomes a *file location*: one key string could
  // denote two places, which is two repositories sharing one lease or one
  // repository holding two.
  //
  // Refusing only ever narrows, so this cannot make anything reachable that was
  // not. Nothing in this build can produce such a key — `resolveRepository`
  // hands over a `realpath` — but `LeaseRepository` is a structural interface on
  // three public functions, and a guarantee that holds only because today's one
  // caller is careful is the kind this slice exists to replace.
  if (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(key)) {
    return Object.freeze({ ok: false as const, code: 'LEASE_LOCATION_UNSUITABLE' as const });
  }
  return Object.freeze({
    ok: true as const,
    path: join(key, EXECUTION_LEASE_FILE_NAME),
    key,
  });
}

/**
 * Which filesystem object is at `path` — device and inode — or `null`.
 *
 * ── Why content is not identity ────────────────────────────────────────────
 *
 * An independent review reproduced the consequence of pretending otherwise. The
 * crash-window artefact is a **zero-byte file**, its digest is the constant
 * `sha256("")`, and an authorisation naming that digest therefore matched every
 * empty object at the lease name — including the one each acquisition passes
 * through on a filesystem that refuses hard links, where the name is taken by
 * `openSync(path, 'wx')` and the record written through that handle afterwards.
 * Content cannot identify an object whose content is nothing.
 *
 * Time cannot either, and is deliberately not used: a modification stamp is
 * rounded to two seconds on some filesystems, is trivially shared by a
 * successor, and this build refuses to let time carry authority anywhere else.
 *
 * ── What this returns, and when it refuses ─────────────────────────────────
 *
 * `"<dev>:<ino>"`, read with `bigint: true` because a Windows file index is a
 * 64-bit value and `Number` loses the low bits of one — measured, not assumed: a
 * test written against the lossy reading disagreed with this one by exactly one.
 * On NTFS that index carries a sequence number, so it is not silently reused by
 * the next file to occupy the same record.
 *
 * **That last sentence is about NTFS, and this module deliberately supports
 * filesystems that are not.** `claimViaExclusiveCreate` and `putBack`'s fallback
 * exist for FAT and network mounts, and `deriveExecutionLeaseLocation` has a UNC
 * arm. Where inode numbers are reused promptly, this identity is weaker than it
 * is here, and the digest is what remains: both must match, so a reused number
 * carrying different bytes is still refused. The case that survives both is the
 * **empty** record — every empty file hashes alike — on a filesystem that both
 * reuses numbers quickly and reports a non-zero one. A fifth review raised it;
 * its verification did not run, so it is written down rather than settled, and
 * it is the first thing the next round should decide.
 *
 * `null` when the platform reports nothing usable — `ino` of zero is what a
 * filesystem without the concept answers, and it is exactly the answer that must
 * not be mistaken for an identity. A caller that cannot get one refuses; there
 * is no weaker fallback, because the digest *was* the weaker fallback.
 */
export function leaseObjectIdentity(path: string): string | null {
  return readObject(path).id;
}

/**
 * What is at `path`: its identity, or why there is none.
 *
 * Two reasons, and collapsing them was a defect an independent review measured
 * rather than argued. `leaseObjectIdentity` swallowed every `stat` failure into
 * the same `null` the platform case uses, so a lease that was *deleted between
 * the byte read and the stat* was reported as "this platform cannot identify the
 * object" — the meaning the docstring and the CLI both assign to `Object: none`.
 *
 * The measurement, on this host: 551 successful byte reads under churn produced
 * `ino === 0n` **zero** times and `ENOENT` 181 times. So in practice that report
 * was never the platform fact it claimed to be; it was always this race. Under
 * six real breakers on one stale lease, 18 of 36 attempts answered
 * `OBJECT_IDENTITY_UNVERIFIABLE` with the lease name already empty — at exit 4,
 * under a sentence beginning "The lease is there", where `LEASE_ALREADY_GONE`
 * at exit 0 is the truth.
 *
 * And the rule it broke was written at its own call site: *a lease that vanishes
 * in that window must be reported as gone, not as unidentifiable.*
 */
function readObject(path: string): { readonly id: string | null; readonly gone: boolean } {
  try {
    const stats = statSync(path, { bigint: true });
    // Zero is what a filesystem without the concept answers, and it is exactly
    // the answer that must not be mistaken for an identity.
    if (stats.ino === 0n) return { id: null, gone: false };
    return { id: `${String(stats.dev)}:${String(stats.ino)}`, gone: false };
  } catch (error) {
    return { id: null, gone: safeErrnoCode(error) === 'ENOENT' };
  }
}

/**
 * The identity of one lease: the digest of its exact bytes.
 *
 * Exported because nothing outside this module may *invent* a second answer to
 * the question "is this the same lease". `lease-recovery.ts`
 * compares what an operator was shown against what a removal detached, and two
 * independent digest implementations would be two definitions of sameness — the
 * kind of duplication this repository has already paid for once, in
 * `verifyExecutionLeaseHeld` reading one file three ways.
 */
export function revisionOfLeaseBytes(bytes: Buffer): string {
  return revisionOfBytes(bytes);
}

function revisionOfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ─────────────────────────────── reading ────────────────────────────────── */

/** What is at the lease path right now. A closed set. */
export const LEASE_STATES = [
  /** Nothing is there. The lease may be taken. */
  'FREE',
  /** A valid lease document is there. */
  'HELD',
  /**
   * Something is there and is not a lease this build can read.
   *
   * Kept apart from `HELD` because it is what a crash between the exclusive
   * create and the metadata write leaves — and apart from `FREE` because that is
   * the one thing it must never be mistaken for.
   */
  'UNPARSEABLE',
  /** Something is there and could not be read at all. */
  'UNREADABLE',
  /** No lease path can be derived for this repository. */
  'LOCATION_UNSUITABLE',
] as const;

export type LeaseState = (typeof LEASE_STATES)[number];

export interface LeaseInspection {
  readonly state: LeaseState;
  /** The path inspected, or the empty string when none could be derived. */
  readonly path: string;
  /**
   * Digest of the exact bytes found, or `null` when there were none.
   *
   * Present for `UNPARSEABLE` as well as `HELD`, deliberately: it is what an
   * operator confirms has not changed before clearing a lease by hand, and a
   * lease that cannot be parsed is exactly the one that most needs an exit.
   */
  readonly revision: string | null;
  readonly ownerPid: number | null;
  readonly runId: string | null;
  readonly blockId: string | null;
  readonly acquiredAt: string | null;
  /**
   * What can be said about the recorded owner.
   *
   * `UNKNOWABLE` when no owner was recorded at all — an unparseable lease names
   * no process, and inventing `NOT_FOUND` for it would answer a question nobody
   * can ask.
   */
  readonly liveness: ProcessLiveness | 'UNKNOWABLE';
  /**
   * Which filesystem object this is, or `null` if the platform cannot say.
   *
   * Reported beside the revision because the revision is not identity for every
   * lease this build can meet: the crash-window artefact is empty, and every
   * empty object has the same digest. See {@link leaseObjectIdentity}. An
   * operator authorises a break with both, and both are re-established on the
   * object the removal detaches.
   */
  readonly objectId: string | null;
}

interface ReadLease {
  readonly state: Exclude<LeaseState, 'LOCATION_UNSUITABLE'>;
  readonly bytes: Buffer | null;
  readonly document: ExecutionLease | null;
}

/**
 * Reads whatever is at `path`, once.
 *
 * One read, so that the bytes a revision is computed from and the document it is
 * parsed into can never be two different readings of one file — the divergence
 * this whole module exists to prevent, at its own smallest scale.
 */
function readLeaseFile(path: string, key: string): ReadLease {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const errno = safeErrnoCode(error);
    return { state: errno === 'ENOENT' ? 'FREE' : 'UNREADABLE', bytes: null, document: null };
  }
  if (bytes.byteLength > MAX_EXECUTION_LEASE_BYTES) {
    return { state: 'UNPARSEABLE', bytes, document: null };
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { state: 'UNPARSEABLE', bytes, document: null };
  }

  const parsed = safeParseExecutionLease(value);
  if (!parsed.success) return { state: 'UNPARSEABLE', bytes, document: null };

  // Held to its location, for the reason `lease-document.ts` gives: a lease
  // restored from a backup into another clone would otherwise read as that
  // clone's own. A document that contradicts where it was found is not a lease.
  if (comparePathIdentity(parsed.data.leaseKey, key) !== 'EQUAL') {
    return { state: 'UNPARSEABLE', bytes, document: null };
  }

  return { state: 'HELD', bytes, document: parsed.data };
}

/** Reads the current lease state without changing anything. Never throws. */
export function inspectRepositoryExecutionLease(
  given: LeaseRepository,
  deps: { readonly processAlive?: ProcessLivenessProbe } = {},
): LeaseInspection {
  // Read once here too. This one only reports, so a shifting record could not
  // grant anything - but an inspection is what an operator then acts on, and a
  // report about one repository under another's name is a lie whether or not it
  // is a privileged one.
  const repository = snapshotRepositoryRecord(given);
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) {
    return inspection({ state: 'LOCATION_UNSUITABLE', path: '' });
  }

  const read = readLeaseFile(location.path, location.key);
  // The object those bytes came from, read next and not later: the probe below
  // can take milliseconds, and an identity read after it would describe a
  // different moment from the digest it sits beside.
  const object = read.bytes === null ? { id: null, gone: false } : readObject(location.path);
  // And a lease that vanished inside that window is reported as **gone**, which
  // is the rule this comment used to state while the code did the opposite: the
  // identity read swallowed `ENOENT` into the same answer the platform case
  // uses, so a repository somebody had just released was reported as held and
  // unidentifiable — no break command offered for it, and under contention a
  // refusal at exit 4 saying "the lease is there" about an empty name.
  if (object.gone) return inspection({ state: 'FREE', path: location.path });
  const probe = deps.processAlive ?? osProcessLiveness;
  // Recovered from the bytes when the document itself will not parse, so a
  // lease written by another build is reported with the owner it actually
  // names. Reporting `UNKNOWABLE` there is what previously printed an operator
  // a break command for a running run.
  const owner = read.document?.ownerPid ?? legibleOwnerPid(read.bytes);

  return inspection({
    state: read.state,
    path: location.path,
    revision: read.bytes === null ? null : revisionOfBytes(read.bytes),
    ownerPid: owner,
    runId: read.document?.runId ?? null,
    blockId: read.document?.blockId ?? null,
    acquiredAt: read.document?.acquiredAt ?? null,
    liveness: owner === null ? 'UNKNOWABLE' : probe(owner),
    // Reporting it is never authority; the re-check on the detached object is.
    objectId: object.id,
  });
}

function inspection(from: Partial<LeaseInspection> & { readonly state: LeaseState; readonly path: string }): LeaseInspection {
  return Object.freeze({
    revision: null,
    ownerPid: null,
    runId: null,
    blockId: null,
    acquiredAt: null,
    liveness: 'UNKNOWABLE' as const,
    objectId: null,
    ...from,
  });
}

/* ──────────────────────────── acquisition ───────────────────────────────── */

export const LEASE_ACQUIRE_FAILURE_CODES = [
  /** Another writer holds the lease and its owner is observably running. */
  'LEASE_HELD',
  /**
   * A lease is there and this build cannot prove it is safe to take.
   *
   * Its owner is not observably running, or the document cannot be read at all.
   * Deliberately **not** a licence to take over: see the module header for what
   * was measured and why a dead owner proves nothing about surviving writers.
   */
  'STALE_LEASE_RECOVERY_UNSAFE',
  /** No lease path can be derived for this repository. */
  'LEASE_LOCATION_UNSUITABLE',
  /**
   * A lease path exists, and the record it was derived from is not one
   * repository: its `root` and its `gitCommonDir` describe different places.
   *
   * Its own code rather than {@link LEASE_LOCATION_UNSUITABLE}, which it was
   * folded into at first. That was wrong in a way an operator would feel: the
   * sentence for that code says no location could be derived, while
   * `lease status` prints a derived path for the very same repository, so the
   * two commands contradicted each other and neither said what was actually
   * wrong. A refusal that misdescribes itself is worse than a verbose one.
   */
  'REPOSITORY_RECORD_INCOHERENT',
  /**
   * The lease could not be recorded, so nothing is held.
   *
   * Covers both halves of the claim, deliberately: the staging write that
   * happens *before* anything is attempted at the lease path — where no claim
   * was ever made and nothing was at risk — and a failure after the claim, which
   * gives the lease back. `detail` distinguishes them by errno. Fail-closed
   * either way, which is why they share a code.
   */
  'LEASE_WRITE_FAILED',
] as const;

export type LeaseAcquireFailureCode = (typeof LEASE_ACQUIRE_FAILURE_CODES)[number];

export interface LeaseAcquireSuccess {
  readonly ok: true;
  readonly code: 'ACQUIRED';
  readonly evidence: ExecutionLeaseEvidence;
  readonly path: string;
  /** Digest of the bytes just written, for an operator to name back. */
  readonly revision: string;
}

export interface LeaseAcquireFailure {
  readonly ok: false;
  readonly code: LeaseAcquireFailureCode;
  /** An allow-listed errno or a fixed token. Never a message, never a path. */
  readonly detail: string | null;
}

export type LeaseAcquireResult = LeaseAcquireSuccess | LeaseAcquireFailure;

export interface ExecutionLeaseRequest {
  /** The run this lease is taken for, or `null`. Diagnostic only. */
  readonly runId: string | null;
  /** The block this lease is taken for, or `null`. Diagnostic only. */
  readonly blockId: string | null;
}

/**
 * The lease path an artefact names, or `null` if it cannot yield one.
 *
 * Three call sites read that private field and each had invented its own answer
 * to "what if it throws" — one wrapped, one wrapped later after a review, one
 * bare. A brand check and a field read are two different questions, and the gap
 * between them is reachable: hooking `WeakSet.prototype.add` before the first
 * mint captures the registry, and an arbitrary object added to it satisfies the
 * brand while owning no private field at all. Nothing is gained by it — every
 * consumer of this helper fails closed — but the answer belongs in one place.
 */
function leasePathOrNull(evidence: ExecutionLeaseEvidence): string | null {
  try {
    return ExecutionLeaseProof.leasePathOf(evidence);
  } catch {
    return null;
  }
}

/** `<root>/.git` as a pointer file. Git's own spelling. */
const GITDIR_PREFIX = 'gitdir:';

/**
 * The largest `.git` pointer file this will read.
 *
 * A real one is a single line. The cap is here for the same reason the lease
 * record has one: a path handed in by a caller is not a promise about the size
 * of what sits at it.
 */
const MAX_GIT_MARKER_BYTES = 4096;

function acquireFailure(
  code: LeaseAcquireFailureCode,
  detail: string | null = null,
): LeaseAcquireFailure {
  return Object.freeze({ ok: false as const, code, detail });
}

/**
 * Whether a repository record's `root` and `gitCommonDir` are the same
 * repository — asked of the filesystem, not of the record.
 *
 * ── Why this asks Git's own question instead of matching shapes ────────────
 *
 * The first version enumerated the layouts it had been shown — ordinary clone,
 * linked worktree, separate git dir — and refused everything else. A review
 * showed what that costs. A **submodule** working tree, which is Git's own
 * default for a very ordinary thing, became permanently unrunnable: its `.git`
 * file carries a *relative* pointer (`gitdir: ../.git/modules/<name>`), and a
 * rule written from three absolute-pointer samples rejected it. `run --attended`
 * and `release --attended` could never succeed there, while `lease status`
 * cheerfully printed a derived path for the same repository. A `.git` that is a
 * symlink or a junction failed the same way, because only one side of the
 * comparison was canonicalised and `resolve-repository.ts` canonicalises the
 * other.
 *
 * A whitelist of measured shapes presented as a rule fails in exactly that
 * direction: every layout nobody thought to measure becomes a lockout, and a
 * lockout is not a safe default — it is an outage. So this no longer matches
 * shapes. It performs Git's own resolution, which is two questions and no
 * guessing:
 *
 *   1. `<root>/.git` — a **directory** is itself the git dir; a **file** reading
 *      `gitdir: <target>` names one, and `<target>` may be relative, in which
 *      case it resolves against `<root>`.
 *   2. inside that git dir, a **`commondir` file** — present only for a linked
 *      worktree, holding the path (`../..`) of the common dir it shares. Absent
 *      means the git dir *is* the common dir.
 *
 * Both were measured. Step 2 is why the old `worktrees` basename test is gone:
 * Git *records* the answer instead of encoding it in a path segment, so reading
 * the record cannot be fooled by a directory that merely happens to be called
 * `worktrees`, nor confused by a separate git dir that happens to live under
 * one.
 *
 * This is still not a containment rule, and cannot become one: a linked
 * worktree's root is nowhere near its common dir, and two worktrees of one clone
 * are deliberately *one* execution domain — `deriveExecutionLeaseLocation` keys
 * on the common dir precisely so they share a lease.
 *
 * Synchronous and never throwing, like everything else on the acquire path: it
 * reads at most three directory entries and two small files.
 */
function repositoryRecordIsCoherent(repository: LeaseRepository): boolean {
  const derived = commonDirOfWorkTree(repository.root);
  if (derived === null) return false;
  return sameDirectoryOnDisk(derived, repository.gitCommonDir);
}

/** Git's common directory for the work tree at `root`, or `null` if there is none. */
function commonDirOfWorkTree(root: string): string | null {
  const marker = join(root, '.git');

  let markerStat: Stats;
  try {
    markerStat = statSync(marker);
  } catch {
    return null;
  }

  // An ordinary clone. `statSync` follows a link, so a symlinked or junctioned
  // `.git` lands here too — which is why the comparison canonicalises rather
  // than trusting this path as it was spelled.
  if (markerStat.isDirectory()) return commonDirOfGitDir(marker);

  if (!markerStat.isFile()) return null;
  // A `.git` pointer is one short line. A large file is not one, and is not read.
  if (markerStat.size > MAX_GIT_MARKER_BYTES) return null;

  let pointer: string;
  try {
    pointer = readFileSync(marker, 'utf8');
  } catch {
    return null;
  }

  const declared = pointer.trim();
  if (!declared.startsWith(GITDIR_PREFIX)) return null;
  const target = declared.slice(GITDIR_PREFIX.length).trim();
  if (target.length === 0) return null;

  // Relative is not an oddity to be defended against here: it is what Git writes
  // for a submodule, and refusing it was the defect.
  return commonDirOfGitDir(isAbsolute(target) ? target : resolve(root, target));
}

/**
 * The common dir a git dir belongs to.
 *
 * A linked worktree's git dir records it in a `commondir` file; every other kind
 * of git dir is its own common dir. Reading that record is the whole method —
 * see the header for why a path-segment heuristic was removed in its favour.
 */
function commonDirOfGitDir(gitDir: string): string {
  const record = join(gitDir, 'commondir');

  let recordStat: Stats;
  try {
    recordStat = statSync(record);
  } catch {
    return gitDir;
  }
  if (!recordStat.isFile() || recordStat.size > MAX_GIT_MARKER_BYTES) return gitDir;

  let recorded: string;
  try {
    recorded = readFileSync(record, 'utf8').trim();
  } catch {
    return gitDir;
  }
  if (recorded.length === 0) return gitDir;

  return isAbsolute(recorded) ? recorded : resolve(gitDir, recorded);
}

/**
 * Whether two paths name the same directory, links resolved.
 *
 * The cheap comparison first, because it settles the ordinary case without
 * touching the disk. The canonicalising one second, for the case a review found:
 * a `.git` reached through a junction is a different string and the same
 * directory, and refusing it locks a legitimate repository out for good.
 */
function sameDirectoryOnDisk(left: string, right: string): boolean {
  if (comparePathIdentity(left, right) === 'EQUAL') return true;

  try {
    return comparePathIdentity(realpathSync.native(left), realpathSync.native(right)) === 'EQUAL';
  } catch {
    return false;
  }
}

/**
 * Takes the repository's execution lease, or says exactly why it could not.
 *
 * Synchronous, and that is a property rather than an accident: the claim is one
 * uninterrupted sequence of filesystem calls with no `await` for anything to
 * interleave with. Never throws.
 */
export function acquireRepositoryExecutionLease(
  given: LeaseRepository,
  request: ExecutionLeaseRequest,
  deps: ExecutionLeaseDependencies,
): LeaseAcquireResult {
  // One reading of the record, before the gate below and before the document
  // built from it (LF-2, and the one entry point the original fix missed).
  //
  // An independent review reproduced the consequence: `repositoryRecordIsCoherent`
  // reads `root` and answers about repository A, and the durable record is then
  // written from a second read that answers B. Nothing is forged - both roots
  // are genuine - and the result is a lease at A's key whose document names B,
  // which `verifyExecutionLeaseHeldFor` then reads back as `HELD` for B. That is
  // the second simultaneous authority the coherence gate exists to prevent,
  // reached *through* it. A gate and the effect it guards must read one value.
  const repository = snapshotRepositoryRecord(given);

  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) return acquireFailure('LEASE_LOCATION_UNSUITABLE');

  // The record must be *one* repository before anything is claimed for it.
  //
  // `LeaseRepository` is a bare structural interface, so nothing ties its fields
  // to one place, and a review built a record carrying repository A's
  // `gitCommonDir` — which is the key, and so decides which lease file is read —
  // beside repository B's `root`, which is what callers then write into. Every
  // value was genuine; only the pairing was a lie. It acquired, and held a
  // second simultaneous authority over B beside B's own honest lease.
  //
  // `verifyExecutionLeaseHeldFor` cannot be where this is caught, and its
  // comment used to claim it was: it compares the document's `repositoryRoot`
  // against `repository.root`, and at acquire time that field is written *from
  // the same mixed record*, so the document agrees with the lie it was born
  // from. A field can only settle a question it was not copied from.
  if (!repositoryRecordIsCoherent(repository)) {
    return acquireFailure('REPOSITORY_RECORD_INCOHERENT');
  }

  const nonce = randomBytes(32).toString('hex');
  const document: ExecutionLease = {
    schemaVersion: EXECUTION_LEASE_SCHEMA_VERSION,
    leaseKey: location.key,
    repositoryRoot: repository.root,
    repositoryId: repository.id,
    ownerPid: process.pid,
    ownerNonce: nonce,
    acquiredAt: deps.now(),
    runId: request.runId,
    blockId: request.blockId,
  };

  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');

  // Read back before it is published, not after.
  //
  // A lease this build cannot itself parse is the worst artefact this module can
  // produce: it reads as `UNPARSEABLE`, which means held-and-unsafe, so its own
  // holder's repository is locked and every diagnosis about it is degraded. The
  // clock is a seam, and a `now` that returns something the contract refuses is
  // enough to publish one. Nothing is claimed for a record this build would not
  // accept back.
  if (!safeParseExecutionLease(JSON.parse(bytes.toString('utf8'))).success) {
    return acquireFailure('LEASE_WRITE_FAILED', 'RECORD_NOT_READABLE_BACK');
  }

  const claimed = claimLeaseFile(location, bytes, deps.link ?? linkSync, nonce);
  if (claimed.code === 'HELD_BY_ANOTHER') return refusalForExistingLease(location, deps);
  if (claimed.code !== 'CLAIMED') return acquireFailure('LEASE_WRITE_FAILED', claimed.detail);

  const evidence = mintExecutionLeaseEvidence(nonce, location.path);
  if (evidence === null) {
    // Not reachable: the nonce is 32 random bytes hex-encoded and the path is
    // absolute. A fail-closed floor rather than an assertion — and it gives the
    // lease back rather than holding one nobody can prove.
    removeVerifiedLease(location.path, (present) => nonceOfBytes(present) === nonce);
    return acquireFailure('LEASE_WRITE_FAILED', 'EVIDENCE_NOT_MINTED');
  }

  return Object.freeze({
    ok: true as const,
    code: 'ACQUIRED' as const,
    evidence,
    path: location.path,
    revision: revisionOfBytes(bytes),
  });
}

interface ClaimResult {
  readonly code: 'CLAIMED' | 'HELD_BY_ANOTHER' | 'CLAIM_FAILED';
  readonly detail: string | null;
}

function claim(code: ClaimResult['code'], detail: string | null = null): ClaimResult {
  return Object.freeze({ code, detail });
}

/**
 * Writes `bytes` and makes them the lease, in that order, exclusively.
 *
 * Two mechanisms, and the module header says why both exist. `link` publishes a
 * finished record atomically and is what the ordinary case uses; the `wx` claim
 * is the fallback for a filesystem that will not link, and is exclusive but
 * briefly visible before its record is whole.
 *
 * Never throws. A failure removes whatever it created, because a lease nobody
 * holds is worse than no lease: it would be reported as unsafe forever.
 */
function claimLeaseFile(
  location: LeaseLocation,
  bytes: Buffer,
  link: (from: string, to: string) => void,
  ourNonce: string,
): ClaimResult {
  const staging = join(
    dirname(location.path),
    `${EXECUTION_LEASE_FILE_NAME}.tmp-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`,
  );

  const staged = writeRecord(staging, bytes);
  if (staged !== null) {
    discard(staging);
    return claim('CLAIM_FAILED', staged);
  }

  try {
    link(staging, location.path);
    discard(staging);
    return claim('CLAIMED');
  } catch (error) {
    const errno = safeErrnoCode(error);
    discard(staging);
    // `EEXIST` is the answer this whole design is built on: somebody else got
    // there first, and their record is already complete.
    if (errno === 'EEXIST') return claim('HELD_BY_ANOTHER');
    return claimViaExclusiveCreate(location, bytes, errno, ourNonce);
  }
}

/**
 * The fallback claim, for a filesystem that refused to link.
 *
 * Exclusive, and honest about the one thing it cannot offer: between the create
 * and the write, a competing acquirer sees a lease with no record in it and
 * reports it as unsafe rather than as held. That is a worse message, never a
 * weaker guarantee.
 */
function claimViaExclusiveCreate(
  location: LeaseLocation,
  bytes: Buffer,
  linkErrno: string,
  ourNonce: string,
): ClaimResult {
  let handle: number;
  try {
    handle = openSync(location.path, 'wx', 0o600);
  } catch (error) {
    const errno = safeErrnoCode(error);
    if (errno === 'EEXIST') return claim('HELD_BY_ANOTHER');
    // Neither mechanism worked. The link's errno is the more informative of
    // the two, and is what is reported.
    return claim('CLAIM_FAILED', linkErrno);
  }

  const failure = writeInto(handle, bytes);
  if (failure !== null) {
    // Giving back a claim that could not be recorded — by identity, not by
    // name, for the reason {@link removeVerifiedLease} exists. The fact that
    // justifies the removal ("I created this file exclusively") was established
    // several syscalls ago, and in between the lease can have been broken and
    // legitimately re-acquired; unlinking the name would then destroy a
    // successor's authority.
    //
    // ── Why an unreadable record is not removed here ───────────────────────
    //
    // This predicate used to read `nonce === null || nonce === ourNonce`, and
    // the `null` arm was a defect an independent review reproduced with real
    // processes and no mocked identity. `nonceOfBytes` answers `null` for
    // anything it cannot parse — including an *empty* file, because
    // `JSON.parse('')` throws — and the empty file at this name is not
    // necessarily ours: it is exactly what a **competing** acquirer leaves
    // while it sits between its own `openSync(path,'wx')` above and its own
    // record write. Reproduced: P1's failed write rolled back and deleted P2's
    // file, with measurably different inodes, so no identity collision was
    // needed. P2 kept its descriptor, believed it held the claim, and the lease
    // name was left free for a third writer.
    //
    // So the rule is now the one the other two rollbacks already keep:
    // **`nonceOfBytes` answering `null` is the absence of an ownership fact,
    // never an ownership fact of its own.** Only a legible record carrying this
    // claim's own nonce is removed.
    //
    // The deliberate cost: when this call's own write fails partway, the
    // half-written file it created stays at the lease name. That is a crash
    // artefact the next acquirer reports as unsafe rather than takes — the same
    // artefact a power failure one syscall earlier would have left. Leaving one
    // behind is strictly better than deleting a record this call cannot prove
    // is its own, because the second mistake ends with two writers.
    //
    // Note what is *not* used to close this: the identity of the object this
    // call created. `fstat` on the handle would supply one, but comparing it
    // later re-derives authority from a `(dev,ino)` pair — and this module
    // ships fallbacks for filesystems that reuse those promptly, which is the
    // reason the attended break was withdrawn. The nonce is a fact about the
    // record's *content* that a successor cannot accidentally share.
    removeVerifiedLease(location.path, (present) => nonceOfBytes(present) === ourNonce);
    return claim('CLAIM_FAILED', failure);
  }
  return claim('CLAIMED');
}

/** Creates `path` exclusively and writes `bytes` into it. `null` on success. */
function writeRecord(path: string, bytes: Buffer): string | null {
  let handle: number;
  try {
    handle = openSync(path, 'wx', 0o600);
  } catch (error) {
    return safeErrnoCode(error);
  }
  return writeInto(handle, bytes);
}

/** Writes, flushes and closes. `null` on success, an errno token otherwise. */
function writeInto(handle: number, bytes: Buffer): string | null {
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(handle, bytes, offset, bytes.length - offset);
      if (written <= 0) break;
      offset += written;
    }
    if (offset !== bytes.length) {
      closeQuietly(handle);
      return 'SHORT_WRITE';
    }
    // A lease that survives a power failure without its record would be read as
    // unsafe forever, so it is flushed before it is published.
    fsyncSync(handle);
    closeSync(handle);
    return null;
  } catch (error) {
    const errno = safeErrnoCode(error);
    closeQuietly(handle);
    return errno;
  }
}

function closeQuietly(handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // The failure is already decided; an unclosable handle adds nothing.
  }
}

/** Best-effort removal. A leftover we cannot remove is inert, never authority. */
function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Nothing reads a staging file by name, and a lease we could not remove is
    // reported as unsafe by the next invocation rather than taken.
  }
}

/**
 * What became of a guarded removal. A closed set, and five rather than four.
 *
 * `DETACH_FAILED` and `UNIDENTIFIABLE` were one member called `FAILED` until the
 * real-process break harness ran: a `rename` can fail outright, and that is
 * **nothing having happened** — the lease is still exactly where it was. It
 * shared a code with "detached, and then unreadable", which is the opposite
 * situation and the one where a record is sitting in quarantine. The operator
 * sentence for it said to go and look at a file that, in the common case, did
 * not exist.
 *
 * The cause this paragraph used to give — "a `rename` of a file another process
 * has open fails outright on Windows" — was measured false, cross-process
 * included, and is removed rather than restated: what the harness established is
 * that the two end states are different, not why the refusal happens.
 */
export type VerifiedRemoval =
  /** The verified bytes were detached and deleted. */
  | 'REMOVED'
  /** Something else was there. It was detached and **put back**. */
  | 'CHANGED'
  /**
   * Something else was there, and it could not be put back: the freed name had
   * been taken. The record is **kept** in the quarantine file, never deleted.
   *
   * Its own member rather than a shade of `CHANGED`, because the two are
   * opposite states of the repository - one leaves the lease exactly as it was
   * found, the other leaves a writer displaced and a file inside the
   * administrative directory. An independent review found the collapsed version
   * telling an operator to inspect a `.breaking-` file the same call had
   * deleted, which is the same "one code for two end states" defect the
   * `DETACH_FAILED` split had already been made for once.
   */
  | 'CHANGED_QUARANTINED'
  /**
   * Something else was there, it could not be put back, and **nothing holds the
   * lease name now**: the repository is unowned and the record is in quarantine.
   *
   * Kept apart from `CHANGED_QUARANTINED` because the two ask opposite things of
   * an operator — wait for the successor, or notice that this repository has no
   * owner and re-inspect before anything runs. A review found both being
   * reported as the second, from a call that had never looked at the name.
   */
  | 'CHANGED_AND_UNOWNED'
  /** Nothing was at the name. */
  | 'ABSENT'
  /** The name could not be detached at all. Nothing was touched. */
  | 'DETACH_FAILED'
  /** Detached, then unreadable, and **put back**. */
  | 'UNIDENTIFIABLE'
  /** Detached, then unreadable, and kept in quarantine: it could not be put back. */
  | 'UNIDENTIFIABLE_QUARANTINED'
  /** Detached, unreadable, kept — and the lease name is free. Unowned. */
  | 'UNIDENTIFIABLE_AND_UNOWNED';

/**
 * Removes exactly the bytes `matches` accepts, or nothing at all.
 *
 * ── The defect this exists to close ────────────────────────────────────────
 *
 * Both destructive operations here used to read the lease, decide, and then
 * `unlink` **the path**. The decision was therefore about bytes and the removal
 * was about a name, and between the two the name can come to hold something
 * else. For `break` that is an ABA authority defect, and it was reproduced
 * rather than theorised: an operator breaks a lease whose owner really is dead,
 * that lease is released, a **new legitimate run acquires**, and the break's
 * `unlink` destroys the new run's authority — bypassing the command's own rule
 * that a lease with a living owner is never broken, because the liveness check
 * was made against the dead owner of a lease that no longer existed.
 *
 * A revision an operator names back closes nothing on its own. It has to be
 * bound to the destructive step, and this is that binding.
 *
 * ── How it binds ───────────────────────────────────────────────────────────
 *
 * `rename` within a directory atomically detaches whatever is at the name into a
 * name only this call knows. From that instant the decision is about an *object*
 * this call owns, and **the lease name is never touched by an operation that can
 * clobber**. If the detached bytes are the ones that were verified they are
 * deleted; if they are not, they are put back — by `link`, or on a filesystem
 * that refuses one by an exclusive create — and an `EEXIST` from either means
 * somebody acquired the freed name, which is a real authority and is left alone.
 *
 * That sentence used to read "never touched again except through `link`", and it
 * was false in five places at once: `putBack`'s fallback reaches `writeRecord`,
 * which is an `openSync(path,'wx')` aimed at the lease name. The rule was
 * correctly restated here when the fallback was added and the four copies of the
 * slogan were left behind — which is what a rule repeated for emphasis does, since
 * a slogan has no back-reference to the mechanism it describes.
 *
 * ── Two wrong answers, both reproduced, both worth recording ───────────────
 *
 * The first version read the lease, decided, and then `unlink`ed the *path* — an
 * ABA defect that destroyed a legitimately acquired successor's lease.
 *
 * The second re-occupied the name with a 0-byte placeholder after the detach and
 * then acted on the name twice, guarded by a boolean recording that the create
 * had succeeded. That is the same defect one level up: a belief about a name,
 * acted on several syscalls later. An empty file is `UNPARSEABLE` with the
 * constant revision `sha256("")`, so a *second* break identifies it by revision
 * alone — exactly as the CLI instructs for an unreadable lease — and removes it;
 * the first break then unlinks or overwrites whatever has taken the freed name.
 * An adversarial review reproduced that with real processes, twelve times out of
 * twelve, destroying a lease an acquirer had successfully taken.
 *
 * The rule that survives both is the one stated above, and it is a rule rather
 * than four correct lines on purpose.
 *
 * ── The residual, stated exactly ───────────────────────────────────────────
 *
 * Between the gate reads and the `rename`, and again between the `rename` and
 * the restoring `link`, the name can change hands. What that costs is bounded:
 *
 *  - a lease acquired in either window is **never removed or overwritten**,
 *    because every operation aimed at the name — the restoring `link`, and the
 *    exclusive create it falls back to — refuses to clobber;
 *  - a lease that was detached and cannot be put back is **kept**, in the
 *    quarantine file, rather than deleted — inert, inspectable, recoverable;
 *  - but a writer that acquired between the gate read and the `rename` is
 *    *displaced*: its record is detached, and if the name has since been taken
 *    it stays detached. It loses authority and stops at its next checkpoint.
 *
 * Closing that last one needs an atomic compare-and-delete on a directory entry,
 * which no portable filesystem primitive offers. It is named here rather than
 * argued away, because the previous two attempts to argue it away were both
 * wrong.
 *
 * ── Its callers, counted rather than described ─────────────────────────────
 *
 * Four call sites, all inside this file: the two acquire rollbacks (`:910` when
 * evidence cannot be minted, and `claimViaExclusiveCreate`'s failed write), and
 * `releaseRepositoryExecutionLease`. The fourth was `lease-recovery.ts`'s
 * attended break, and it is gone with the break.
 *
 * This paragraph said "one of its two users" while four call sites existed, and
 * its own heading said "to exactly one caller" — three numbers, none of them the
 * code's. The two it omitted were both rollback paths, which is exactly the class
 * that gets forgotten when destructive callers are enumerated, and one of them
 * turned out to hold the defect that outlived the break.
 *
 * This is the only function in the build that may detach or delete a lease.
 * `matches` is the whole of the authority it takes, and a caller passing
 * `() => true` has written a plain `unlink` with extra steps — which is why
 * `tests/v2-07lr-lease-recovery.test.ts` pins that no module outside this one
 * calls it, rather than leaving it to convention. Note what does *not* follow
 * from that pin: "only one function unlinks a lease" is a fact about reachability
 * and not a safety property, because the predicate is where the safety lives.
 *
 * ── Why the predicate no longer sees an object identity ────────────────────
 *
 * It used to be `(bytes, objectId) => boolean`, and the object identity was the
 * authority the attended break rested on. With the break withdrawn — see
 * `lease-recovery.ts` for why the contract could not be written — all three
 * remaining callers ignored the argument, and what was left was a parameter that
 * handed every future caller the exact mechanism that had just been found
 * unsound. An affordance for a withdrawn operation is how the operation comes
 * back. Identity here is the nonce inside the record, which a successor cannot
 * accidentally share; `leaseObjectIdentity` remains, for `lease status` to report.
 */
export function removeVerifiedLease(
  leasePath: string,
  matches: (bytes: Buffer) => boolean,
): VerifiedRemoval {
  const quarantine = `${leasePath}.breaking-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`;

  try {
    renameSync(leasePath, quarantine);
  } catch (error) {
    // Nothing has happened here, and that distinction is load-bearing: the lease
    // is untouched, there is no quarantined record, and telling an operator to
    // go and inspect one would send them after a file that does not exist.
    //
    // The stated cause used to be "a `rename` of a file another process has open
    // is refused on Windows". That was **measured false**, cross-process
    // included: libuv opens with delete sharing, so renaming a lease file another
    // of this build's acquirers holds open succeeds. The refusals the harness
    // produced were real; this was not their cause, and the discrimination is
    // kept because the *distinction* is right whatever produces it. (The
    // instrument that pins it — a directory holding an open file, which Windows
    // genuinely does refuse to rename — is a different mechanism and unaffected.)
    return safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'DETACH_FAILED';
  }

  // From here the lease name is **never touched by an operation that can
  // clobber** — the restoring `link`, or the exclusive create it falls back to on
  // a filesystem that has no links. That single rule is what this function got
  // wrong twice.
  //
  // Stated in the form the mechanism actually has, rather than the shorter
  // "except through `link`" it carried in four other places: that wording was
  // written before `putBack` gained its fallback, and an `openSync(path,'wx')`
  // aimed at the lease name falsified it everywhere it had been copied to.
  //
  // The version before this one re-occupied the name with a 0-byte placeholder
  // and then acted on the name twice — `unlink` on the match path, `rename` on
  // the restore — guarded by a boolean recording that the create had succeeded
  // several syscalls earlier. That boolean is a belief about a name, which is
  // exactly the defect the detach exists to avoid, reintroduced one level up:
  // an empty file is `UNPARSEABLE` with the constant revision `sha256("")`, so a
  // *second* break identifies it by revision alone and removes it — and the
  // first break then unlinks or overwrites whatever took the freed name, which
  // an adversarial review demonstrated destroying a legitimately acquired lease
  // with real processes, twelve times out of twelve.
  //
  // So: no placeholder. The quarantined file is ours by construction — a name
  // only this call knows — and every decision below is about *it*.
  let bytes: Buffer | null = null;
  try {
    bytes = readFileSync(quarantine);
  } catch (error) {
    // `ENOENT` here means **nothing was detached**, and that is a measurement
    // rather than a deduction.
    //
    // The real-process break harness produced it in five racers out of six: on
    // this platform a `rename` whose source has just been taken by a competitor
    // can *return success without having moved anything*, so the only evidence
    // that a detach really happened is the object being there afterwards. A
    // plain `rename` of a missing file does throw `ENOENT` — the phantom
    // success appears under concurrency — which is exactly why the answer has
    // to be read from the result rather than from the call.
    //
    // Reported as `ABSENT`, because that is what it is: the lease was already
    // gone. Calling it "detached and unreadable" sent an operator looking for a
    // quarantined record that was never created, in the common case.
    if (safeErrnoCode(error) === 'ENOENT') return 'ABSENT';
    // Anything else is a genuine detach this call cannot identify. It is
    // neither removed nor claimed to have been: the restore below puts it back.
  }

  // The decision, on the object this call detached rather than on the name it
  // came from. The predicate is handed the bytes and nothing else: it used to
  // also receive `leaseObjectIdentity(quarantine)`, which was the attended
  // break's authority and is now no caller's.
  if (bytes !== null && matches(bytes)) {
    discard(quarantine);
    return 'REMOVED';
  }

  // Not ours to remove — put it back.
  const restoration = putBack(quarantine, leasePath, bytes);
  if (restoration === 'RESTORED') {
    discard(quarantine);
    return bytes === null ? 'UNIDENTIFIABLE' : 'CHANGED';
  }
  if (restoration === 'NAME_FREE') {
    // Kept, like every other refusal — and the repository is unowned, which is a
    // different thing to tell somebody than "a successor holds it now".
    return bytes === null ? 'UNIDENTIFIABLE_AND_UNOWNED' : 'CHANGED_AND_UNOWNED';
  }
  // It could not be put back, so it is **kept** where it is: deleting it would
  // destroy a record this call has just decided it may not remove, and a stray
  // file inside the administrative directory is inert, inspectable and
  // recoverable. An earlier version discarded it here, which turned a refusal
  // into a deletion.
  return bytes === null ? 'UNIDENTIFIABLE_QUARANTINED' : 'CHANGED_QUARANTINED';
}

/**
 * Puts a detached record back at the lease name, without ever overwriting.
 *
 * ── Why this needed a second mechanism ─────────────────────────────────────
 *
 * The restore was a bare `linkSync`, chosen because `link` cannot clobber: if
 * somebody acquired the freed name, `EEXIST` says so and their authority
 * stands. That is right, and it was not enough. `link` is unavailable on whole
 * filesystems — FAT and some network mounts — and this module *ships an entire
 * acquire fallback for exactly those*, so on them the restore could never
 * succeed. Every refusal established after the detach therefore left the lease
 * name **empty** while reporting that nothing had been removed, and the next
 * writer took a repository whose owner was still running.
 *
 * An independent review reproduced that without mocking anything, by saturating
 * NTFS's 1024-name limit on the very inode being restored. It is the third
 * withdrawn attempt's defect, shipped: the README named that attempt's flaw as
 * "on a filesystem that refuses hard links … every non-matching detach becomes
 * an unconditional destruction", and the fix at the time closed the *deletion*
 * half while leaving the *dispossession* half in place.
 *
 * So the restore now mirrors the claim it undoes. `link` first, because it is
 * atomic and publishes the whole record; an **exclusive create** second, which
 * is what `claimViaExclusiveCreate` uses on the same filesystems and for the
 * same reason. Both refuse to overwrite — `EEXIST` from either means the name
 * belongs to somebody else now — so the rule the detach exists to enforce is
 * unchanged: *the lease name is never touched by an operation that can clobber*.
 *
 * The fallback writes a copy rather than relinking the object, so the restored
 * record is a different inode carrying identical bytes. Nothing decides ownership
 * by inode — identity here is the nonce inside the record — so the holder's next
 * `verifyExecutionLeaseHeld` answers `HELD` exactly as before.
 *
 * That sentence read "nothing reads a lease by inode", which was false while the
 * attended break read it twice and decided a deletion on it. The break is gone
 * and the claim would now be nearly true, but "reads" was never the point:
 * `lease status` still reports the object, and reporting is not deciding.
 *
 * Returns a {@link Restoration}: `RESTORED`, or `NAME_TAKEN` / `NAME_FREE`, which
 * are two states the caller must tell apart — "somebody else holds it now" and
 * "nobody holds it now" send an operator to opposite actions. This paragraph
 * described a `boolean` return for three commits after the union replaced it,
 * because it sits above `type Restoration` rather than above `putBack`, where
 * nothing associates it with the signature it documents.
 */
type Restoration =
  /** The record is back at the lease name. */
  | 'RESTORED'
  /** It could not go back because somebody else holds the name. Theirs stands. */
  | 'NAME_TAKEN'
  /**
   * It could not go back and **nothing holds the name**: this repository is now
   * unowned, and the record is in the quarantine file.
   *
   * Its own answer because it is the one an operator has to act on, and because
   * reporting it as `NAME_TAKEN` is a statement about the world that this call
   * never checked. An adversarial review reproduced that with no injection at
   * all — a directory at the lease path detaches, cannot be read, and takes the
   * `bytes === null` exit below, which attempts no restore — and the operator was
   * told the name "had been taken in that instant" while the repository sat
   * unowned and the next acquire succeeded.
   */
  | 'NAME_FREE';

function putBack(quarantine: string, leasePath: string, bytes: Buffer | null): Restoration {
  try {
    linkSync(quarantine, leasePath);
    return 'RESTORED';
  } catch (error) {
    // Somebody holds the name. That acquisition is a real authority and stands,
    // and this is the one errno that *proves* occupancy rather than implying it.
    if (safeErrnoCode(error) === 'EEXIST') return 'NAME_TAKEN';
    // The filesystem will not link. Without the detached bytes there is nothing
    // to write back — a record this call could not even read is one it cannot
    // reconstruct — so it stays in quarantine, and what is at the name decides
    // what this call is entitled to say about it.
    if (bytes === null) return occupancyOf(leasePath);
    if (writeRecord(leasePath, bytes) === null) return 'RESTORED';
    return occupancyOf(leasePath);
  }
}

/**
 * Whether anything holds `leasePath`, asked rather than assumed.
 *
 * The whole point of the member above: after a failed restore this call knows it
 * did not put the record back, and knows nothing else. `EEXIST` is proof of
 * occupancy; every other failure is proof of nothing, and the difference decides
 * whether an operator is told the repository is unowned or that a successor
 * holds it. A stat that itself fails answers `NAME_TAKEN`, because the one thing
 * this must never do is announce a free repository it has not established.
 */
function occupancyOf(leasePath: string): Restoration {
  try {
    statSync(leasePath);
    return 'NAME_TAKEN';
  } catch (error) {
    return safeErrnoCode(error) === 'ENOENT' ? 'NAME_FREE' : 'NAME_TAKEN';
  }
}

/**
 * Which refusal an existing lease earns.
 *
 * Both outcomes refuse. They differ only in what an operator is told, and that
 * difference is the whole reason the liveness probe exists: "somebody is
 * running" and "a run died here" send a human to two different places.
 */
function refusalForExistingLease(
  location: LeaseLocation,
  deps: ExecutionLeaseDependencies,
): LeaseAcquireFailure {
  const read = readLeaseFile(location.path, location.key);
  if (read.document === null) {
    // Unreadable, unparseable, or a lease belonging to another clone. None of
    // those is an absence, and this is the branch a crash between the create and
    // the write lands in.
    return acquireFailure('STALE_LEASE_RECOVERY_UNSAFE', read.state);
  }

  const probe = deps.processAlive ?? osProcessLiveness;
  const liveness = probe(read.document.ownerPid);
  if (liveness === 'ALIVE') return acquireFailure('LEASE_HELD', 'OWNER_ALIVE');
  return acquireFailure('STALE_LEASE_RECOVERY_UNSAFE', liveness);
}

/* ────────────────────────── holding and releasing ───────────────────────── */

export const LEASE_VERIFY_CODES = [
  /** The lease named by this evidence is on disk and is this holder's. */
  'HELD',
  /** The value is not minted evidence. */
  'EVIDENCE_INVALID',
  /** Nothing is at the lease path any more. */
  'LEASE_ABSENT',
  /** Something is there and it is not this holder's lease. */
  'NOT_OWNER',
  /** Something is there and could not be read. */
  'LEASE_UNREADABLE',
  /**
   * The evidence is genuine, current, and for a different repository.
   *
   * Its own code because it is a different mistake from every other one here:
   * nothing is wrong with the lease, and everything is wrong with using it
   * *here*. See {@link verifyExecutionLeaseHeldFor}.
   */
  'LEASE_FOR_ANOTHER_REPOSITORY',
] as const;

export type LeaseVerifyCode = (typeof LEASE_VERIFY_CODES)[number];

/**
 * Everything the *unscoped* check can say.
 *
 * Narrower than {@link LeaseVerifyCode} by exactly one member, and the
 * difference is load-bearing rather than tidy: only the repository-scoped
 * variant can answer `LEASE_FOR_ANOTHER_REPOSITORY`, because only it was told
 * which repository to compare against. Splitting the types keeps that fact in
 * the compiler rather than in a comment — `releaseRepositoryExecutionLease`
 * forwards this code into its own vocabulary, and a wider union there would be
 * a code it has no meaning for.
 */
export type UnscopedLeaseVerifyCode = Exclude<LeaseVerifyCode, 'LEASE_FOR_ANOTHER_REPOSITORY'>;

export interface LeaseVerifyResult {
  readonly code: LeaseVerifyCode;
}

export interface UnscopedLeaseVerifyResult {
  readonly code: UnscopedLeaseVerifyCode;
}

/**
 * Whether the lease this evidence describes is still held by this holder.
 *
 * The question the artefact deliberately cannot answer on its own. A run that
 * took the lease minutes ago and has been inside an agent subprocess since is
 * exactly the caller that must ask again — the driver does, every iteration, for
 * the same reason it re-reconciles every iteration.
 *
 * An unparseable document answers `NOT_OWNER` rather than `HELD`: this holder
 * cannot show the bytes are its own, and "cannot show" is not "is".
 */
export function verifyExecutionLeaseHeld(evidence: unknown): UnscopedLeaseVerifyResult {
  if (!isExecutionLeaseEvidence(evidence)) return Object.freeze({ code: 'EVIDENCE_INVALID' as const });

  let bytes: Buffer;
  try {
    bytes = readFileSync(ExecutionLeaseProof.leasePathOf(evidence));
  } catch (error) {
    const errno = safeErrnoCode(error);
    return Object.freeze({ code: errno === 'ENOENT' ? ('LEASE_ABSENT' as const) : ('LEASE_UNREADABLE' as const) });
  }
  // The same ceiling every other reader applies. Without it this one consumer
  // would parse a document the rest of the module refuses to look at.
  if (bytes.byteLength > MAX_EXECUTION_LEASE_BYTES) {
    return Object.freeze({ code: 'NOT_OWNER' as const });
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return Object.freeze({ code: 'NOT_OWNER' as const });
  }
  const parsed = safeParseExecutionLease(value);
  if (!parsed.success) return Object.freeze({ code: 'NOT_OWNER' as const });

  return Object.freeze({
    code: ExecutionLeaseProof.matchesNonce(evidence, parsed.data.ownerNonce)
      ? ('HELD' as const)
      : ('NOT_OWNER' as const),
  });
}

/**
 * Whether this evidence is a current lease **for this repository**.
 *
 * ── Why the unscoped question was not enough ───────────────────────────────
 *
 * {@link verifyExecutionLeaseHeld} answers "is the file at the path this
 * artefact names still mine". That is the right question for `release`, which
 * has no repository in hand and must not be able to point at one. It is the
 * wrong question for a *writer*, and the adversarial review demonstrated why: a
 * genuine, current, perfectly held lease for repository A satisfied the gate for
 * a mutation of repository B, because nothing compared the artefact's path with
 * the repository about to be written to.
 *
 * Nothing reachable from today's CLI does that — each command acquires for the
 * repository it then acts on. But that is *convention* carrying the guarantee,
 * in a slice whose entire argument is that opaque evidence exists to replace
 * convention with structure. The artefact already carries its path, so making it
 * structural costs one comparison.
 *
 * Compared by path identity rather than by string, so separator shape and
 * Windows' case-insensitivity do not read as a different repository —
 * `core/path-identity.ts` gives the reasoning, including why a relative path is
 * refused outright rather than resolved.
 */
export function verifyExecutionLeaseHeldFor(
  given: LeaseRepository,
  evidence: unknown,
): LeaseVerifyResult {
  if (!isExecutionLeaseEvidence(evidence)) {
    return Object.freeze({ code: 'EVIDENCE_INVALID' as const });
  }

  // The two reads this makes - the key it derives a path from, and the root it
  // compares the document against - must be of one reading. Callers snapshot
  // before calling, and this closes the same hole for the ones that do not.
  const repository = snapshotRepositoryRecord(given);
  const location = deriveExecutionLeaseLocation(repository);
  // `leasePathOf` reads a private field, so it throws for anything that passed
  // the brand check without going through the constructor — which a review
  // achieved by hooking `WeakSet.prototype.add` before the first mint and
  // capturing the registry itself. No authority was gained (the read fails, and
  // a throw is refused everywhere it can surface), but an authority check that
  // answers by throwing is not answering, so it is asked safely.
  const claimedPath = leasePathOrNull(evidence);
  if (
    claimedPath === null ||
    !location.ok ||
    comparePathIdentity(claimedPath, location.path) !== 'EQUAL'
  ) {
    return Object.freeze({ code: 'LEASE_FOR_ANOTHER_REPOSITORY' as const });
  }

  // Read through the same reader every other consumer uses, so one file cannot
  // mean three things. `verifyExecutionLeaseHeld` applies the size cap — the same
  // ceiling every other reader applies — but deliberately not the location
  // binding, because it has no repository to bind to. This comment claimed it
  // applied neither, which was half false and in the reassuring direction —
  // and the adversarial review found the consequence: a lease whose recorded
  // `leaseKey` names somewhere else read `UNPARSEABLE` to `lease status` and to
  // `break`, and `HELD` to the driver's authority gate. Three readers, two
  // opinions, about the one question that decides who may write.
  const read = readLeaseFile(location.path, location.key);
  if (read.state === 'FREE') return Object.freeze({ code: 'LEASE_ABSENT' as const });
  if (read.state === 'UNREADABLE') return Object.freeze({ code: 'LEASE_UNREADABLE' as const });
  if (read.document === null) return Object.freeze({ code: 'NOT_OWNER' as const });

  // The record being verified against must be the one the lease was taken for.
  //
  // `LeaseRepository` is a bare structural interface, so nothing ties its three
  // fields to one place — and a review built a record carrying repository A's
  // `gitCommonDir` (which is the key, and so decides *which lease is read*)
  // beside repository B's `root` (which is what callers then write into). Every
  // value was genuine; only the combination was a lie, and it read as `HELD`.
  //
  // The document is what settles it: `repositoryRoot` was written at acquire
  // time from the acquiring record, so a mixed record disagrees with it. This is
  // the same argument `block-store.ts` makes about a field a store only ever
  // writes — a field nobody checks is a field that travels.
  if (comparePathIdentity(read.document.repositoryRoot, repository.root) !== 'EQUAL') {
    return Object.freeze({ code: 'LEASE_FOR_ANOTHER_REPOSITORY' as const });
  }

  return Object.freeze({
    code: ExecutionLeaseProof.matchesNonce(evidence, read.document.ownerNonce)
      ? ('HELD' as const)
      : ('NOT_OWNER' as const),
  });
}

/**
 * A held lease together with the repository it authorises.
 *
 * The pair, because neither half means anything alone: evidence names a file,
 * and only a repository says whether that file is *this* repository's. Carried
 * as one value so a caller cannot thread one and forget the other — which is
 * precisely the mistake the adversarial review found when the writers took only
 * the evidence.
 */
export interface ExecutionLeaseAuthority {
  readonly repository: LeaseRepository;
  readonly evidence: ExecutionLeaseEvidence;
}

export const LEASE_RELEASE_CODES = [
  'RELEASED',
  'EVIDENCE_INVALID',
  'LEASE_ABSENT',
  'NOT_OWNER',
  'LEASE_UNREADABLE',
  'LEASE_REMOVE_FAILED',
] as const;

export type LeaseReleaseCode = (typeof LEASE_RELEASE_CODES)[number];

export interface LeaseReleaseResult {
  readonly code: LeaseReleaseCode;
  readonly detail: string | null;
}

/**
 * Gives back a lease this holder took.
 *
 * Takes **only** the evidence, and that is the owner-only rule made structural:
 * there is no path argument, no run id and no owner id to supply, so there is
 * nothing for a caller to guess. A caller holding a run id, a pid, or another
 * invocation's identifiers has nothing this function accepts.
 *
 * The nonce is then checked against the file as well, because the path alone is
 * not identity: a lease released and re-taken by a successor sits at the same
 * path, and removing that one would hand the repository to a third writer.
 */
export function releaseRepositoryExecutionLease(evidence: unknown): LeaseReleaseResult {
  const held = verifyExecutionLeaseHeld(evidence);
  if (held.code !== 'HELD') return Object.freeze({ code: held.code, detail: null });
  // `verifyExecutionLeaseHeld` returning `HELD` implies this; narrowed rather
  // than asserted, at the cost of one branch.
  if (!isExecutionLeaseEvidence(evidence)) {
    return Object.freeze({ code: 'EVIDENCE_INVALID' as const, detail: null });
  }

  // Removed by identity, not by name. The nonce is re-checked on the detached
  // bytes, so a successor that took this path between the verification above and
  // this line keeps its lease — see {@link removeVerifiedLease}. `NOT_OWNER` is
  // then the honest answer: what is there is somebody else's.
  // Read inside the guard, not in front of it. Its sibling in
  // `verifyExecutionLeaseHeld` is already wrapped, and a review found this one
  // bare: a value that satisfies the brand check and then fails to yield its
  // private field turns a refusal into an uncaught `TypeError`.
  let leasePath: string;
  try {
    leasePath = ExecutionLeaseProof.leasePathOf(evidence);
  } catch {
    return Object.freeze({ code: 'EVIDENCE_INVALID' as const, detail: null });
  }

  const removed = removeVerifiedLease(leasePath, (bytes) =>
    ExecutionLeaseProof.matchesNonce(evidence, nonceOfBytes(bytes)),
  );
  if (removed === 'ABSENT') return Object.freeze({ code: 'LEASE_ABSENT' as const, detail: null });
  if (removed === 'CHANGED') return Object.freeze({ code: 'NOT_OWNER' as const, detail: null });
  if (removed === 'CHANGED_QUARANTINED') {
    // Somebody else's record, detached and not restorable because the freed name
    // was taken in that instant. `NOT_OWNER` is still the honest headline — this
    // holder does not own what is there — and the detail says the part an
    // operator would otherwise discover only by looking inside `.git`.
    return Object.freeze({ code: 'NOT_OWNER' as const, detail: 'RECORD_QUARANTINED' });
  }
  if (removed === 'UNIDENTIFIABLE_QUARANTINED') {
    return Object.freeze({ code: 'LEASE_REMOVE_FAILED' as const, detail: 'RECORD_QUARANTINED' });
  }
  if (removed === 'CHANGED_AND_UNOWNED') {
    return Object.freeze({ code: 'NOT_OWNER' as const, detail: 'RECORD_QUARANTINED_LEASE_UNOWNED' });
  }
  if (removed === 'UNIDENTIFIABLE_AND_UNOWNED') {
    return Object.freeze({
      code: 'LEASE_REMOVE_FAILED' as const,
      detail: 'RECORD_QUARANTINED_LEASE_UNOWNED',
    });
  }
  if (removed === 'UNIDENTIFIABLE') {
    // A detail rather than `null`: an operator hitting this has a file they
    // cannot read where their lease was, and a code with no detail at all was a
    // regression against the version this replaced. It is kept distinct from
    // the one below, which is the case where nothing was detached at all.
    return Object.freeze({ code: 'LEASE_REMOVE_FAILED' as const, detail: 'UNREADABLE_AFTER_DETACH' });
  }
  if (removed === 'DETACH_FAILED') {
    return Object.freeze({ code: 'LEASE_REMOVE_FAILED' as const, detail: 'DETACH_REFUSED' });
  }
  return Object.freeze({ code: 'RELEASED' as const, detail: null });
}

/* ─────────────────────────── reading raw bytes ──────────────────────────── */

/**
 * A plausible owner pid inside `bytes`, whatever else is wrong with them.
 *
 * Deliberately weaker than the schema, and only ever used to *report*. A lease
 * this build cannot validate may still be somebody's — the likeliest reason for
 * it is another build of this same tool — and the one thing worth recovering
 * from it is who to ask about. `lease status` reports that owner and its
 * liveness, so an operator looking at an unreadable lease is told whether
 * anything is still running rather than being told nothing can be said.
 *
 * It authorises nothing. There is no path in this build that removes a lease on
 * the strength of what this returns.
 */
export function legibleOwnerPid(bytes: Buffer | null): number | null {
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const pid: unknown = (value as { ownerPid?: unknown }).ownerPid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The nonce inside `bytes`, or `null` when they are not a lease.
 *
 * Parsed from the bytes a removal has just detached rather than taken from an
 * earlier reading, so the ownership check and the removal are about the same
 * file. That binding is the whole point — see {@link removeVerifiedLease}.
 */
function nonceOfBytes(bytes: Buffer): string | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = safeParseExecutionLease(value);
  return parsed.success ? parsed.data.ownerNonce : null;
}
