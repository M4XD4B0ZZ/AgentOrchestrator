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
 * releasing it or {@link recoverStaleLease} proving one dead, and as of the
 * second withdrawal of the attended break there is no such policy anywhere else
 * in the build. The guarded primitive is here — {@link removeVerifiedLease},
 * whose whole authority is the predicate it is handed — and its three call sites
 * are all in this file: one acquire rollback, `recoverStaleLease` and `release`.
 *
 * That sentence said "four call sites … two acquire rollbacks and `release`",
 * which was wrong twice and in the direction that matters: there are three, and
 * the enumeration left out the only **destructive** one, which is the call the
 * whole recovery contract rests on. Counted from `grep -n 'removeVerifiedLease('`
 * rather than from memory.
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
  lstatSync,
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

import { containmentFactsOf } from '../core/containment-attestation.js';
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
  containmentBinding,
  CONTAINMENT_EVIDENCE_VERSION,
  readContainmentEvidence,
  type ContainmentEvidencePayload,
  type ContainmentReading,
} from './containment-evidence.js';
import {
  EXECUTION_LEASE_SCHEMA_VERSION,
  safeParseExecutionLease,
  type ExecutionLease,
} from './lease-document.js';
import {
  installOwnedLaunchAccountant,
  type OwnedLaunchAccountant,
  type OwnedLaunchOpening,
} from '../boundary/owned-launch-accounting.js';
import {
  MAX_OPEN_OWNED_LAUNCHES,
  provesNoOwnedLaunchOpen,
  provesOwnedLaunchesOpenUnended,
  readOpenSet,
  type OpenOwnedLaunch,
  type OwnedLaunchReading,
} from './owned-launch-register.js';
import {
  extendableWriterLaunchLedger,
  MAX_WRITER_LAUNCH_ENTRIES,
  WriterLaunchLedgerSchema,
  openOwnedProcessesOf,
  provesEveryLaunchContained,
  provesEveryLaunchContainedUnended,
  readOwnedLaunchRegister,
  readWriterLaunchLedger,
  unendedLaunchesOf,
  writerLaunchBinding,
  WRITER_LAUNCH_LEDGER_VERSION,
  type WriterLaunchEntry,
  type WriterLaunchLedger,
  type WriterLaunchLedgerPayload,
  type WriterLaunchReading,
  type WriterLaunchSubject,
} from './writer-launch-ledger.js';

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
 * a test seam rather than quietly available — and note what it cannot do, and
 * that this slice had to *make* the sentence true again. It read "because
 * liveness only ever adds refusals to `acquire`, no substitute can make this
 * module hand out a lease it would otherwise withhold",
 * which was true while `acquire` and the inspection were the only consumers. V3
 * slice 5 added one for which a liveness answer is *permissive* — the recovery's
 * first conjunct — and a review reproduced a substituted probe removing a living
 * owner's lease. {@link StaleRecoveryDependencies} is what closed that: the
 * destructive path always consults the real probe and combines a supplied
 * opinion by taking the more refusing answer. So the bound holds **for the
 * destructive path**, by construction rather than by there being nothing to
 * break — and it does not hold for this seam, which still substitutes: a
 * supplied probe changes what `assessStaleLeaseRecovery` *reports*, and
 * `lease-recovery.ts` states why that is safe and what it is safe because of.
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

/**
 * Why no lease location exists for a repository. A closed set.
 *
 * Three codes rather than one, following the reasoning already recorded for
 * `REPOSITORY_RECORD_INCOHERENT` below: a refusal that misdescribes itself is
 * worse than a verbose one. `LEASE_LOCATION_UNSUITABLE`'s sentence says no
 * location could be derived, which is plainly false for a UNC path that
 * resolves perfectly well and is refused because V2 does not support network
 * storage.
 */
export type LeaseLocationFailureCode =
  | 'LEASE_LOCATION_UNSUITABLE'
  | 'LEASE_LOCATION_NETWORK_UNSUPPORTED'
  | 'LEASE_LOCATION_DEVICE_NAMESPACE';

export interface LeaseLocationFailure {
  readonly ok: false;
  readonly code: LeaseLocationFailureCode;
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
  const shapeFailure = classifyWindowsKey(key);
  if (shapeFailure !== null) {
    return Object.freeze({ ok: false as const, code: shapeFailure });
  }
  return Object.freeze({
    ok: true as const,
    path: join(key, EXECUTION_LEASE_FILE_NAME),
    key,
  });
}

/**
 * Which V2 path class this key is, or `null` when it is one V2 supports.
 *
 * Purely syntactic: no filesystem is consulted, nothing is measured, and the
 * answer for a given string never changes. That is what keeps it out of the
 * class of check that has to sit at its effect — and it is *not* a statement
 * about the volume. A drive letter can be a mapped network share, in the plain
 * and the extended form alike, and neither is detected here or anywhere else in
 * this build. See the ACCEPTED LIMIT in README's supported-runtime section; the
 * real protection for that case is the link refusal at the acquire effect.
 *
 * ── Why `isAbsolute` is not enough, and which case it does catch ───────────
 *
 * `isAbsolute` answers `false` for a genuinely **drive-relative** key —
 * `C:repo\.git`, relative to the current directory of that drive — so the
 * `isAbsolute` check in {@link deriveExecutionLeaseLocation} above already
 * refuses that one. What it answers `true` for, and this function
 * must refuse, is a **root-relative** key: `\foo`, and `/foo` which normalises
 * to the same thing, absolute only within whichever volume the process happens
 * to be standing on. One such key could denote two places, which is two
 * repositories sharing one lease or one repository holding two. (`F-4` in the
 * README records the same gap for `core/path-identity.ts`, where the value is
 * only ever a comparison operand and the gap stays open.)
 *
 * Refusing only ever narrows, so nothing here can make reachable what was not.
 */
function classifyWindowsKey(key: string): LeaseLocationFailureCode | null {
  // One normalisation, because every rule below is about shape and none of them
  // is about which separator character was used. Windows accepts both.
  const shape = key.replace(/\//g, '\\');

  if (shape.startsWith('\\\\?\\')) {
    // The extended-length namespace carries both a local and a network form.
    if (/^\\\\\?\\UNC\\/i.test(shape)) return 'LEASE_LOCATION_NETWORK_UNSUPPORTED';
    if (/^\\\\\?\\[A-Za-z]:\\/.test(shape)) return null;
    // `\\?\Volume{…}` and anything else in that namespace: not refused as
    // network, not accepted either. V2 supports the drive-letter forms, and a
    // shape nobody has verified is not one of them.
    return 'LEASE_LOCATION_UNSUITABLE';
  }

  // `\\.\…` — the device namespace. Its own code: subsuming it under "UNC"
  // would make the network code as imprecise as the one it replaces.
  if (shape.startsWith('\\\\.\\')) return 'LEASE_LOCATION_DEVICE_NAMESPACE';

  // `\\server\share\…` — plain UNC.
  if (/^\\\\[^\\]/.test(shape)) return 'LEASE_LOCATION_NETWORK_UNSUPPORTED';

  // `C:\…` — the supported shape, and the only one.
  if (/^[A-Za-z]:\\/.test(shape)) return null;

  // Root-relative, and anything else `isAbsolute` let through.
  return 'LEASE_LOCATION_UNSUITABLE';
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
 * **That last sentence was about NTFS while this module still supported
 * filesystems that are not, and that gap is now closed from the other end.** The
 * exclusive-create claim that served FAT and network mounts is withdrawn, and an
 * acquisition on a filesystem whose `link` refuses is refused outright — see
 * {@link LEASE_FILESYSTEM_UNSUPPORTED}. So a lease exists only where `link`
 * works, which is where this identity is strong.
 *
 * That is a platform boundary, not a proof about every such filesystem, and the
 * distinction is worth keeping: the boundary is enforced by the acquire path
 * refusing, not by anything here. Nothing in this module may treat a
 * `(dev,ino)` pair as an authority — the sixth review reproduced a removal of a
 * legitimately acquired lease that way, and it is why the attended break is gone.
 * This value is reported, never compared to decide an effect.
 *
 * `null` when the platform reports nothing usable — `ino` of zero is what a
 * filesystem without the concept answers, and it is exactly the answer that must
 * not be mistaken for an identity. A caller that cannot get one refuses; there
 * is no weaker fallback, because the digest *was* the weaker fallback.
 *
 * ── Not exported, and that is the point ───────────────────────────────────
 *
 * There was an exported `leaseObjectIdentity(path)` here. It existed so the
 * attended break could name an object, and with the break withdrawn it had no
 * production caller at all — `inspectRepositoryExecutionLease` reads
 * {@link readObject} directly. An exported reader of exactly the value a
 * withdrawn authority was built on is the affordance that authority leaves
 * behind: a review reconnected the break from outside this module by composing
 * it with {@link removeVerifiedLease}, and reached a real removal of a
 * legitimately held lease. The plumbing was removed from the predicate; this is
 * the rest of it.
 *
 * The identity is still *reported* — `lease status` prints it, from the
 * inspection — because telling an operator which object they are looking at is
 * not the same as handing them a way to act on it.
 *
 * ── Two reasons for `null`, and collapsing them was a defect ───────────────
 *
 * Measured by an independent review rather than argued. The reader used to
 * swallow every `stat` failure into the same `null` the platform case uses, so a
 * lease *deleted between the byte read and the stat* was reported as "this
 * platform cannot identify the object" — the meaning the CLI assigns to
 * `Object: none`.
 *
 * The measurement, on this host: 551 successful byte reads under churn produced
 * `ino === 0n` **zero** times and `ENOENT` 181 times. So in practice that report
 * was never the platform fact it claimed to be; it was always this race. It was
 * then reproduced reaching an operator: half of the break attempts in a
 * real-process harness reported a lease as present-but-unidentifiable while its
 * name was already empty, where "already gone" was the truth. The break and its
 * reason codes are withdrawn, so that consequence is history — but the
 * discrimination it argued for is not, because `inspect` still answers `FREE`
 * against `HELD` on it, and that answer decides whether the next invocation may
 * take the lease.
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
 * There was an exported `revisionOfLeaseBytes` wrapper here, justified by the
 * rule that nothing outside this module may invent a second answer to "is this
 * the same lease" — because `lease-recovery.ts` compared what an operator had
 * been shown against what a removal had detached. That comparison went with the
 * attended break, and the wrapper was left with no importer anywhere in the
 * repository, still carrying a docstring naming a caller that no longer exists.
 *
 * Unexported rather than kept "in case": an exported digest-of-a-lease is a piece
 * of the withdrawn authorisation model, and the rule it enforced has no subject
 * while nothing outside this file decides which lease is which.
 */
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
  /** The location is a UNC/network path, which V2 does not support. */
  'LOCATION_NETWORK_UNSUPPORTED',
  /** The location is in the Windows device namespace. */
  'LOCATION_DEVICE_NAMESPACE',
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
   * empty object has the same digest. See {@link readObject}, which produces
   * this value.
   *
   * It authorises nothing and never did in this build: the sentence here used to
   * read "an operator authorises a break with both, and both are re-established
   * on the object the removal detaches", which described the twice-withdrawn
   * `lease break` in the present tense long after it was gone. Reported so an
   * operator can tell two records apart by eye; the recovery that does remove a
   * lease binds to the record's bytes and nonce, never to this.
   */
  readonly objectId: string | null;
  /**
   * What this lease's containment evidence turned out to be, or `null` when
   * there was no lease document to read one from.
   *
   * `null` and `'ABSENT'` are two different facts and are kept apart on purpose:
   * `null` means *no document was parsed*, which is every state but `HELD`, and
   * `'ABSENT'` means a lease was read and carries no containment record — a
   * legacy lease, or one whose writer never went behind the boundary.
   *
   * **Reported, never acted on**, and V3 slice 5 did not change that — it
   * confirmed it. Nothing in this build removes, takes over or shortens the life
   * of any lease because of what this says: `assessStaleLeaseRecovery` reads the
   * writer-launch ledger and never this field, precisely because a `CONTAINED`
   * reading is a statement about one writer **launch** and a failed publish or a
   * failed clear can leave an older positive one standing.
   *
   * The sentence this replaces predicted the opposite — "it exists so the slice
   * that does implement recovery has a measured input rather than an assumption".
   * That slice exists now and deliberately does not take this input. See
   * `lease/containment-evidence.ts` for why containment is lifetime evidence and
   * not writer authority, and `lease/writer-launch-ledger.ts` for what a recovery
   * needed instead.
   */
  readonly containment: ContainmentReading | null;
}

/** The states that mean "there is no lease path", as opposed to what is at one. */
export type LeaseLocationState =
  | 'LOCATION_UNSUITABLE'
  | 'LOCATION_NETWORK_UNSUPPORTED'
  | 'LOCATION_DEVICE_NAMESPACE';

interface ReadLease {
  readonly state: Exclude<LeaseState, LeaseLocationState>;
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

/** One inspection state per location failure. Total by type. */
const LOCATION_STATE_FOR: Readonly<Record<LeaseLocationFailureCode, LeaseLocationState>> =
  Object.freeze({
    LEASE_LOCATION_UNSUITABLE: 'LOCATION_UNSUITABLE',
    LEASE_LOCATION_NETWORK_UNSUPPORTED: 'LOCATION_NETWORK_UNSUPPORTED',
    LEASE_LOCATION_DEVICE_NAMESPACE: 'LOCATION_DEVICE_NAMESPACE',
  });

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
    // The state that matches the refusal, so `lease status` and a refused
    // `run --attended` tell an operator the same story about the same
    // repository. Reporting "no location could be derived" for a UNC path the
    // tool understood perfectly well is the misdescription this slice removes.
    return inspection({ state: LOCATION_STATE_FOR[location.code], path: '' });
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
    // Only for a lease this build parsed. A containment reading is a statement
    // *about a lease*, and there is no lease here to make one about — `null` and
    // `'ABSENT'` are two different facts and collapsing them would claim a
    // document was read and carried nothing.
    //
    // The companion record is read after the lease and not before: an inspection
    // that found no lease must not go looking for a record beside it, and one
    // that did should describe the record as it was when the lease was read.
    containment:
      read.document === null
        ? null
        : readContainmentEvidence({ ...read.document, containment: readContainmentRecord(location) }),
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
    // No document, no reading. Every state but `HELD` lands here, and the
    // default is the one that claims nothing.
    containment: null,
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
   * The repository's Git common directory is on an explicitly unsupported
   * UNC/network path.
   *
   * A location was derived perfectly well; V2 does not support network storage
   * for it. Its own code rather than {@link LEASE_LOCATION_UNSUITABLE} for the
   * reason recorded on `REPOSITORY_RECORD_INCOHERENT`: that code's sentence
   * says no location could be derived, and `lease status` would print a path
   * for the very same repository.
   */
  'LEASE_LOCATION_NETWORK_UNSUPPORTED',
  /**
   * The key is in the Windows device namespace (`\\.\…`).
   *
   * Kept apart from the network code deliberately. A device path is not network
   * storage, and one code covering both would be exactly the over-broad refusal
   * this vocabulary exists to avoid.
   */
  'LEASE_LOCATION_DEVICE_NAMESPACE',
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
  /**
   * This filesystem cannot carry an execution lease, so none was taken.
   *
   * ── The platform boundary, drawn deliberately ──────────────────────────────
   *
   * The lease's whole safety argument rests on binding a decision to a
   * filesystem **object** rather than to a name, and every non-destructive step
   * that binding needs is a hard link: the claim publishes a finished record by
   * linking a staged file into place, and {@link removeVerifiedLease} puts back
   * a record it may not remove by linking the object it detached. Where `link`
   * is unavailable neither is possible, and this module used to answer that with
   * an exclusive-create fallback plus a copying restore.
   *
   * Six adversarial review rounds established that the fallback creates a class
   * of lease object for which the rest of the protocol has no safe complete
   * lifecycle. The attended break could not be authorised on it and was
   * withdrawn. The acquire rollback dispossessed a competing acquirer on it. And
   * the restore, having no link, writes a *copy* and then discards the detached
   * original — destroying the object of a writer that still holds its descriptor,
   * with `release` one small path difference from the same fault.
   *
   * So the fallback is gone, and this is what replaces it: **fail closed before a
   * lease exists at all**, rather than offer an acquisition whose release and
   * rollback cannot be implemented safely. A named unsupported filesystem is a
   * better product than a supported-looking one whose destructive operations
   * lack the primitive they need.
   *
   * `detail` carries the errno the link refused with.
   */
  'LEASE_FILESYSTEM_UNSUPPORTED',
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
  // The code the derivation produced, not a fresh one. Collapsing three
  // distinct refusals into the vaguest of them is the defect this slice removes
  // one layer up; re-introducing it here would put it back.
  if (!location.ok) return acquireFailure(location.code);

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

  const claimed = claimLeaseFile(location, bytes, deps.link ?? linkSync);
  if (claimed.code === 'HELD_BY_ANOTHER') return refusalForExistingLease(location, deps);
  if (claimed.code === 'FILESYSTEM_UNSUPPORTED') {
    // Nothing was created: the staged file is discarded and the lease name was
    // never occupied. This is the one refusal that is about the *platform*
    // rather than about the repository's state, and it is deliberately not
    // folded into `LEASE_WRITE_FAILED` — that code means a claim was attempted
    // and given back, and an operator who reads it will retry.
    return acquireFailure('LEASE_FILESYSTEM_UNSUPPORTED', claimed.detail);
  }
  if (claimed.code !== 'CLAIMED') return acquireFailure('LEASE_WRITE_FAILED', claimed.detail);

  const evidence = mintExecutionLeaseEvidence(nonce, location.path);
  if (evidence === null) {
    // Not reachable: the nonce is 32 random bytes hex-encoded and the path is
    // absolute. A fail-closed floor rather than an assertion — and it gives the
    // lease back rather than holding one nobody can prove.
    removeVerifiedLease(location.path, (present) => nonceOfBytes(present) === nonce);
    return acquireFailure('LEASE_WRITE_FAILED', 'EVIDENCE_NOT_MINTED');
  }

  // The launch history starts here and nowhere else. This is the only instant at
  // which "no writer has launched under this lease" is a fact — the lease was
  // created a syscall ago and this process holds it — so it is the only instant
  // that may mint a history claiming to be complete. It changes nothing about
  // the acquisition: a failure to publish leaves the lease held and simply
  // unrecoverable, which is what every lease before this slice was.
  openWriterLaunchHistory(location, document, evidence);

  // ── And every owned subprocess of this epoch is accounted from here ───────
  //
  // Here rather than in a caller, and that is the whole of what makes the
  // register exhaustive. There are four places in this build that take a lease
  // — `run/lifecycle-driver.ts`, `cli/block-command.ts`, `cli/delivery-steps.ts`
  // and `cli/release-command.ts` — and a fifth is a normal thing for a later
  // slice to add. An install any of them could forget is an epoch whose
  // subprocesses are invisible to recovery, which is precisely the defect this
  // slice exists to close; an install the acquisition itself performs cannot be
  // forgotten by a caller that does not know it happens.
  //
  // It changes nothing about the acquisition. The accountant records; it grants
  // nothing, and it is not consulted by anything that decides who may write.
  ACCOUNTANT_DISPOSERS.set(evidence, installOwnedLaunchAccountant(accountantFor(repository, evidence)));

  return Object.freeze({
    ok: true as const,
    code: 'ACQUIRED' as const,
    evidence,
    path: location.path,
    revision: revisionOfBytes(bytes),
  });
}

/**
 * How a lease's own release finds the accountant it installed.
 *
 * Keyed by the evidence object, so a release removes exactly the accountant its
 * acquisition made and can remove no other. A `WeakMap` rather than a `Map`
 * because the key is the only thing that keeps the entry alive: a process that
 * loses its evidence without releasing has nothing left that could dispose, and
 * an accountant that outlives its evidence evicts itself on the next launch it
 * is asked about.
 *
 * The explicit disposal is therefore not the mechanism that bounds the
 * registry — self-eviction is — and it is here because a lifetime that ends
 * where it is supposed to end is one an operator and a reviewer can both follow.
 */
const ACCOUNTANT_DISPOSERS = new WeakMap<object, () => void>();

/**
 * What a launch may do, given what the announcement answered. Total, and the
 * default is the refusing one.
 *
 * ── The defect this table replaces ────────────────────────────────────────
 *
 * `accountantFor` used to name two codes and send *everything else* to
 * `EPOCH_ENDED`, which drops the accountant and lets the launch proceed. An
 * adversarial review reproduced what that costs, and it is the whole of this
 * slice undone by one failed `readFileSync`:
 *
 *   1. the lease is acquired, the document published, the writer runs and is
 *      confirmed — the document reads `ALL_LAUNCHES_CONTAINED`, register empty;
 *   2. any later owned spawn announces, and `heldLeaseFor` cannot read the lease
 *      file for one call — a share violation, `EMFILE` under a loaded gate — so
 *      the answer is `LEASE_UNREADABLE`;
 *   3. that fell into `EPOCH_ENDED`: the accountant was evicted **for the life
 *      of the process**, and nothing re-installs it — only an acquisition does;
 *   4. the lease and its document were untouched and still license;
 *   5. every later subprocess, the thirty-minute verification included, ran
 *      unannounced;
 *   6. the owner died, and the recovery removed the lease.
 *
 * ── The rule the table encodes ────────────────────────────────────────────
 *
 * `EPOCH_ENDED` is permitted for exactly the answers that **prove no document
 * of this epoch can license a recovery**, so an unrecorded launch after one of
 * them cannot be turned into a removal:
 *
 *  - `LEASE_ABSENT` — there is no lease; a recovery answers `NOTHING_TO_RECOVER`;
 *  - `NOT_OWNER` — a lease was read and its nonce is somebody else's, so this
 *    epoch's document is gone and any register still on disk reads
 *    `NOT_THIS_LEASE` for the successor's subject;
 *  - `LEASE_FOR_ANOTHER_REPOSITORY` and `EVIDENCE_INVALID` — programming errors,
 *    deterministic, and this accountant can never work;
 *  - `REGISTER_DISCARDED` — the document was removed; the reading is
 *    `LAUNCH_HISTORY_ABSENT`, and nothing promotes it back.
 *
 * Everything else refuses the launch, **including codes an announcement cannot
 * produce**, because the alternative is a launch that happened and was not
 * written down beside a document that still reads as a proof.
 * `OWNERSHIP_UNCONFIRMED` is the sharp one and is the reason that code exists.
 *
 * Every row is asserted by value in
 * `tests/m2-02-owned-launch-quiescence.test.ts`; a `satisfies` clause would
 * accept `EPOCH_ENDED` everywhere.
 */
export const ANNOUNCEMENT_DISPOSITION: Readonly<
  Record<OwnedLaunchCode, 'RECORDED' | 'EPOCH_ENDED' | 'LAUNCH_MUST_NOT_START'>
> = Object.freeze({
  ANNOUNCED: 'RECORDED',
  LEASE_ABSENT: 'EPOCH_ENDED',
  NOT_OWNER: 'EPOCH_ENDED',
  LEASE_FOR_ANOTHER_REPOSITORY: 'EPOCH_ENDED',
  EVIDENCE_INVALID: 'EPOCH_ENDED',
  REGISTER_DISCARDED: 'EPOCH_ENDED',
  LAUNCH_MUST_NOT_START: 'LAUNCH_MUST_NOT_START',
  // The rest, and every one of them leaves a document that can still license.
  OWNERSHIP_UNCONFIRMED: 'LAUNCH_MUST_NOT_START',
  LEASE_UNREADABLE: 'LAUNCH_MUST_NOT_START',
  REGISTER_NOT_READABLE_BACK: 'LAUNCH_MUST_NOT_START',
  REGISTER_WRITE_FAILED: 'LAUNCH_MUST_NOT_START',
  // Not producible by an announcement, and stated rather than defaulted: a
  // table with an unstated row is a table with a default, and the default here
  // is the one that was wrong.
  ESTABLISHED: 'LAUNCH_MUST_NOT_START',
  SETTLED: 'LAUNCH_MUST_NOT_START',
  ALREADY_SETTLED: 'LAUNCH_MUST_NOT_START',
  ATTESTATION_INVALID: 'LAUNCH_MUST_NOT_START',
  ATTESTATION_ALREADY_USED: 'LAUNCH_MUST_NOT_START',
  OWNER_MISMATCH: 'LAUNCH_MUST_NOT_START',
  SLOT_NOT_OPEN: 'LAUNCH_MUST_NOT_START',
});

/**
 * The accountant one lease installs, in the boundary's lease-free vocabulary.
 *
 * ── It answers `EPOCH_ENDED` rather than clinging on ───────────────────────
 *
 * A process can take many leases over its life — a test file takes hundreds —
 * and every accountant that stayed installed would be asked about every later
 * spawn, reading a document that is not its own each time. So the answers that
 * mean *this lease is no longer this evidence's* are turned into
 * `EPOCH_ENDED`, and `owned-launch-accounting.ts` drops the accountant that
 * says it.
 *
 * That is not a hole. `EPOCH_ENDED` means there is no document for a later
 * recovery to read this launch out of, and no lease of this run's for that
 * recovery to remove. A run that has lost its lease is stopped by the gates
 * that exist for it — `loop/leased-spawns.ts`'s `leaseHolds`, and
 * `advanceTaskState` after it.
 *
 * ── And a failure to record is not a failure to run, except once ───────────
 *
 * `REGISTER_DISCARDED` proceeds: the document is gone, so nothing on disk
 * claims anything, and this lease is simply never recoverable — the trade
 * `beginWriterLaunch` already makes. Only `LAUNCH_MUST_NOT_START` stops a
 * launch, and it is reached only when the document could be neither written nor
 * removed.
 */
function accountantFor(
  repository: LeaseRepository,
  evidence: ExecutionLeaseEvidence,
): OwnedLaunchAccountant {
  const now = (): string => new Date().toISOString();
  return {
    open: (): OwnedLaunchOpening => {
      // `announceOwnedLaunch` documents that it never throws, and this makes
      // that true rather than trusted. It reaches `randomBytes` and the
      // filesystem through `publishCompanionRecord`, and a fault-injection test
      // in `tests/v3-07-lease-release-fault.test.ts` proved the reachability by
      // refusing entropy. A throw is an unknown, and an unknown refuses.
      let announced: OwnedLaunchResult;
      try {
        announced = announceOwnedLaunch(repository, evidence, { now });
      } catch {
        return { opening: 'LAUNCH_MUST_NOT_START', detail: 'ANNOUNCEMENT_THREW' };
      }
      if (announced.code === 'ANNOUNCED' && announced.slot !== null) {
        const slot = announced.slot;
        return {
          opening: 'RECORDED',
          record: {
            established: (attestation): void => {
              attestOwnedLaunchEstablished(repository, evidence, attestation, { slot, now });
            },
            ended: (): void => {
              settleOwnedLaunch(repository, evidence, { slot });
            },
          },
        };
      }
      // Everything else through the table, whose default is the refusing one.
      // An `ANNOUNCED` answer carrying no slot number cannot be settled and is
      // therefore not a record; it falls here rather than being closed over.
      return ANNOUNCEMENT_DISPOSITION[announced.code] === 'EPOCH_ENDED'
        ? { opening: 'EPOCH_ENDED' }
        : { opening: 'LAUNCH_MUST_NOT_START', detail: announced.detail ?? announced.code };
    },
  };
}

interface ClaimResult {
  readonly code: 'CLAIMED' | 'HELD_BY_ANOTHER' | 'CLAIM_FAILED' | 'FILESYSTEM_UNSUPPORTED';
  readonly detail: string | null;
}

function claim(code: ClaimResult['code'], detail: string | null = null): ClaimResult {
  return Object.freeze({ code, detail });
}

/**
 * Writes `bytes` and makes them the lease, in that order, exclusively.
 *
 * **One mechanism, and only one.** A staged file is written whole and then
 * `link`ed into place, so the lease name appears already complete and never
 * exists as a half-written record. There is no second mechanism: the
 * exclusive-create fallback that used to catch a filesystem refusing to link is
 * withdrawn, and a link failure that is not `EEXIST` now refuses the acquisition
 * outright. {@link LEASE_FILESYSTEM_UNSUPPORTED} states why.
 *
 * Never throws. A failure removes whatever it created, because a lease nobody
 * holds is worse than no lease: it would be reported as unsafe forever.
 */
function claimLeaseFile(
  location: LeaseLocation,
  bytes: Buffer,
  link: (from: string, to: string) => void,
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
    // Any other refusal means this filesystem will not link, and the lease
    // protocol needs `link` twice — here, and in the restore that puts back a
    // record it may not remove. The staged file is already discarded and the
    // lease name was never touched, so refusing here leaves the repository
    // exactly as it was found.
    return claim('FILESYSTEM_UNSUPPORTED', errno);
  }
}

/** Creates `path` exclusively and writes `bytes` into it. `null` on success. */
function writeRecord(path: string, bytes: Buffer, durable = true): string | null {
  let handle: number;
  try {
    handle = openSync(path, 'wx', 0o600);
  } catch (error) {
    return safeErrnoCode(error);
  }
  return writeInto(handle, bytes, durable);
}

/**
 * Writes, optionally flushes, and closes. `null` on success, an errno token
 * otherwise.
 *
 * ── Why the flush is a choice rather than a rule ──────────────────────────
 *
 * `fsyncSync` costs a seek. Measured on this repository's own volume, a
 * spinning disk, replaying this exact sequence over a 19 KB payload 200 times
 * in each of three rounds: **73 ms mean with the flush, 6.5 ms without**. The
 * lease document and the writer history are written a handful of times per run
 * and pay it gladly. The owned-launch register is written twice per *spawn* —
 * tens of times per step — and at 73 ms a publish that is seconds of blocked
 * event loop per step, which is not a cost this accounting may impose.
 *
 * ── And what the flush actually protects against ──────────────────────────
 *
 * A **power failure**, not a killed process. `taskkill /F` leaves the page
 * cache alone and the operating system still writes it out, so every case the
 * recovery predicate exists for — an orchestrator that was killed — is
 * unaffected by this choice.
 *
 * What a power cut can lose, for a non-durable write, is safe in every
 * direction that matters, and each one is worth stating rather than asserting
 * as a class:
 *
 *  - **a lost announcement** would leave a document that does not mention a
 *    launch that happened. That is the one fail-open shape this record has —
 *    and it is unreachable here, because the event that lost it is a power cut,
 *    which killed that launch too. Permitting a recovery afterwards is correct;
 *  - **a lost establishment** leaves the slot `ANNOUNCED`, which refuses;
 *  - **a lost settlement** leaves the slot open, which refuses or over-refuses;
 *  - **a torn document** — the rename persisted, the bytes did not — reads
 *    `MALFORMED`, which refuses. Note what that costs: the writer history lives
 *    in the same document, so a power cut during a register publish can lose a
 *    durably-written writer history along with it. The lease becomes
 *    unrecoverable and nothing false is asserted, which is the direction this
 *    format fails in everywhere else.
 */
function writeInto(handle: number, bytes: Buffer, durable = true): string | null {
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
    // unsafe forever, so it is flushed before it is published — unless the
    // caller has stated it does not need to be. See this function's header for
    // the measurement and for what each loss costs.
    if (durable) fsyncSync(handle);
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
 * What became of a guarded removal. A closed set of nine.
 *
 * The count is stated because it was wrong here: this line read "five rather than
 * four" while the union had nine members, having been written when it had five
 * and never revisited. It is the same class of defect as the stale test counts
 * this slice removed from its prose — a number that describes the code sitting
 * beside the code, with nothing keeping the two in step. The union below is the
 * authority; if these disagree again, the union is right.
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
 *
 * That harness is no longer in the repository — it was withdrawn with the
 * attended break — so the two references to it above are history rather than
 * something to go and read. Each of the nine members is pinned in process, by
 * value, in `tests/v2-07lr-release-window.test.ts`; the mapping onto
 * {@link LeaseReleaseResult} is one-to-one, so a test that names the pair names
 * the member. The effect the shipped artefact has on a real directory is
 * measured by `tests/dist-artifact/execution-lease-release-dist-artifact.mjs`.
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
 * **Three call sites, all inside this file**: the acquire rollback for a lease
 * whose evidence could not be minted, `recoverStaleLease`, and
 * `releaseRepositoryExecutionLease`.
 *
 * Counted rather than described, because the count has been wrong in every
 * previous form of this paragraph — including the one this replaces, which V3
 * slice 5 falsified on the day it was written by adding the recovery and leaving
 * "two" in place. It said "one of its two users" under a heading saying "to
 * exactly one caller" while there were four; the correction then said "four call
 * sites, all inside this file" and enumerated three, naming the fourth as being
 * in another file; then it said two, and a review found three.
 *
 * The third is the one worth naming rather than counting. `recoverStaleLease` is
 * the only caller that removes a lease **this process never held**, so it is the
 * only one whose `matches` predicate is the entire authority for the removal
 * rather than a second opinion about its own record.
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
 * accidentally share. The object identity is still *reported* — `lease status`
 * prints it — but no function by that name remains: the inspection reads
 * {@link readObject} directly. An exported reader of exactly the value a
 * withdrawn authority rested on is the affordance that authority leaves behind.
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
    // It was measured, in five racers out of six: on this platform a `rename`
    // whose source has just been taken by a competitor can *return success
    // without having moved anything*, so the only evidence that a detach really
    // happened is the object being there afterwards. A plain `rename` of a
    // missing file does throw `ENOENT` — the phantom success appears under
    // concurrency — which is exactly why the answer has to be read from the
    // result rather than from the call.
    //
    // **The instrument that measured it is not in this repository.** It was the
    // real-process break harness, and it was deleted with the attended break it
    // existed for — so this paragraph cited an empirical record a reader could
    // not reach, which is the same defect as a stale test count. The
    // measurement stands as history; what pins the *branch* is
    // `tests/v2-07lr-release-window.test.ts`, which produces the state the
    // phantom leaves (the detached object is not there) and lets the real
    // `ENOENT` follow. Nothing in the build reproduces the concurrency itself.
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
  // also receive the quarantined file's `(dev,ino)` identity, read by a
  // since-removed `leaseObjectIdentity` helper. That was the attended break's
  // authority; the break is withdrawn and so is the helper, and neither name
  // resolves to anything in this build.
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
 * So the restore keeps two mechanisms even though the claim no longer does.
 * `link` first, because it is atomic and publishes the whole record; an
 * **exclusive create** second. Both refuse to overwrite — `EEXIST` from either
 * means the name belongs to somebody else now — so the rule the detach exists to
 * enforce is unchanged: *the lease name is never touched by an operation that can
 * clobber*.
 *
 * ── Why the copying restore is safe now, and was not before ────────────────
 *
 * The fallback writes a copy rather than relinking the object, and the caller
 * then discards the detached original. On a filesystem with no links at all that
 * **destroys** the original — and a sixth review reproduced the harm: a competing
 * acquirer sitting in the exclusive-create claim's pre-write window had its
 * object deleted out from under a descriptor it still held, wrote its record into
 * an orphaned inode, and left the lease name holding a permanently empty file
 * that nothing in the build could clear.
 *
 * What removed that is not a change here. It is that **no acquirer ever holds
 * the lease name with an unwritten record any more**: the exclusive-create claim
 * is withdrawn, so the name only ever appears already complete, by `link`. The
 * detached original is therefore always a finished record, a copy of it carries
 * the same bytes, and ownership is decided by the nonce inside — so the holder's
 * next `verifyExecutionLeaseHeld` answers `HELD` exactly as before.
 *
 * The remaining reachable link failure here is an anomaly rather than a platform
 * fact — NTFS's 1024-name limit on the object being restored, which a review
 * reproduced without mocking, or a permission refusal. Keeping the fallback for
 * those is what stops the *dispossession* half: without it a refused restore
 * leaves the lease name free while reporting that nothing was removed, which is
 * the defect the fallback was added to close.
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

/* ─────────────────────── recording containment evidence ─────────────────── */

/**
 * The companion record's file name. A plain name, never derived, and never the
 * lease's own — see `lease/containment-evidence.ts` for why the record sits
 * beside the lease rather than inside it.
 */
export const CONTAINMENT_EVIDENCE_FILE_NAME = 'agent-orchestrator-execution-lease.containment.json';

/** Largest companion record this build will read back. */
const MAX_CONTAINMENT_EVIDENCE_BYTES = 16_384;

/**
 * What became of an attempt to record or remove containment evidence. A closed
 * set of fourteen, of which three are successes and each names which one.
 *
 * The count was "thirteen" the moment the fourteenth member was added, which is
 * the defect `VerifiedRemoval` records forty lines up in this same file: a
 * number describing the code, sitting beside the code, with nothing keeping the
 * two in step. The array below is the authority; if these disagree again, it is
 * right and this sentence is wrong.
 *
 * `RECORDED`, `CLEARED` and `NOTHING_TO_CLEAR` are three values rather than one
 * because a caller testing `code === 'RECORDED'` must not read a *removal* as a
 * publish. The removal used to answer `RECORDED` with `detail: 'CLEARED'`, which
 * put the difference in a field nothing is obliged to look at and made the
 * member's own sentence — "the record is beside the lease" — false for half the
 * calls that produced it.
 */
export const CONTAINMENT_RECORD_CODES = [
  /** The record is beside the lease, and this build read it back as reliable. */
  'RECORDED',
  /** A record was there and is gone. */
  'CLEARED',
  /** There was no record to remove, which is the state the caller asked for. */
  'NOTHING_TO_CLEAR',
  /** The lease artefact was not minted evidence. Nothing was opened. */
  'EVIDENCE_INVALID',
  /** The containment artefact was not minted. Nothing was written. */
  'ATTESTATION_INVALID',
  /** The evidence names a different repository's lease than the record does. */
  'LEASE_FOR_ANOTHER_REPOSITORY',
  /** No lease path can be derived, or nothing is at the one derived. */
  'LEASE_ABSENT',
  /** Something is at the lease path and could not be read. */
  'LEASE_UNREADABLE',
  /** What is there is not this holder's lease — or is not a lease at all. */
  'NOT_OWNER',
  /** The lease names no run, so there is nothing to bind the evidence to. */
  'RUN_NOT_IDENTIFIED',
  /** The containment was coupled to a process other than the lease's owner. */
  'OWNER_MISMATCH',
  /** The record this build built is one this build would not accept back. */
  'RECORD_NOT_READABLE_BACK',
  /**
   * The record could not be published. Nothing this call built reached a file.
   *
   * That is **not** the same as "there is no record", and the first version of
   * this sentence said it was. A run makes several writer launches under one
   * lease, so a failed publish leaves whatever the *previous* launch left —
   * measured: a `RECORDED` launch followed by a `RECORD_WRITE_FAILED` one still
   * reads `CONTAINED`, describing the older launch. It is conservative only for
   * the first launch under a lease.
   */
  'RECORD_WRITE_FAILED',
  /**
   * The record could not be **removed**, and is therefore still on disk.
   *
   * Its own code because it says which operation failed, and a caller that has
   * to decide what to do about the file on disk needs that. It does **not** mean
   * the two codes point in opposite safety directions — a draft of this comment
   * claimed exactly that and it was measured false. Both failures can leave the
   * previous launch's record standing; see {@link RECORD_WRITE_FAILED}. What
   * separates them is what the caller was *trying* to do, and therefore what it
   * can try next.
   *
   * Nothing in this build consumes it, because nothing in this build reads the
   * record. The slice that does must.
   */
  'RECORD_CLEAR_FAILED',
] as const;

export type ContainmentRecordCode = (typeof CONTAINMENT_RECORD_CODES)[number];

export interface ContainmentRecordResult {
  readonly code: ContainmentRecordCode;
  /** An errno token or a short reason, never free text from anywhere else. */
  readonly detail: string | null;
}

export interface ContainmentRecordRequest {
  /** Which agent was contained. The productive writer is `claude`. */
  readonly writerId: string;
  /** The clock, read once for the durable record. */
  readonly now: () => string;
}

function recordFailure(
  code: ContainmentRecordCode,
  detail: string | null = null,
): ContainmentRecordResult {
  return Object.freeze({ code, detail });
}

/**
 * The containment vocabulary's answer to each refusal of the shared lease gate.
 *
 * A total function of {@link HeldLeaseFailure} rather than a cast, so a token
 * added to that union stops the build here. `NOT_OWNER_UNPARSEABLE` is the one
 * that is not a pass-through, and it is the reason this exists: the two callers
 * report it as `NOT_OWNER` with a detail, which is a mapping and not a rename.
 */
function containmentFailureFor(failure: HeldLeaseFailure): ContainmentRecordResult {
  switch (failure) {
    case 'EVIDENCE_INVALID':
      return recordFailure('EVIDENCE_INVALID');
    case 'LEASE_FOR_ANOTHER_REPOSITORY':
      return recordFailure('LEASE_FOR_ANOTHER_REPOSITORY');
    case 'LEASE_ABSENT':
      return recordFailure('LEASE_ABSENT');
    case 'LEASE_UNREADABLE':
      return recordFailure('LEASE_UNREADABLE');
    case 'NOT_OWNER_UNPARSEABLE':
      return recordFailure('NOT_OWNER', 'UNPARSEABLE');
    case 'NOT_OWNER':
      return recordFailure('NOT_OWNER');
  }
}

/** The companion record's path for a lease location. One derivation, one place. */
function containmentPathFor(location: LeaseLocation): string {
  return join(location.key, CONTAINMENT_EVIDENCE_FILE_NAME);
}

/**
 * The lease this evidence holds, right now, or why it does not.
 *
 * ── One gate, not four copies of one ───────────────────────────────────────
 *
 * Every companion-file writer in this module has to establish the same six
 * things before it may touch anything: the artefact is minted evidence, it names
 * *this* repository's lease path, something is at that path, it parses, the
 * document describes the repository the caller handed in, and its nonce is this
 * evidence's. Slice 4 shipped that chain twice — once in the publish, once in
 * the removal — and slice 5 needs it twice more.
 *
 * Four hand-written copies of an ownership gate is how one of them ends up a
 * check short, which is the defect class this module records against itself
 * repeatedly. So it is written once. The failure tokens are returned rather than
 * mapped here, because the callers have different vocabularies and a shared gate
 * must not force a shared result type on them — `NOT_OWNER_UNPARSEABLE` is one
 * token precisely so a caller cannot collapse "somebody else's lease" and "not a
 * lease at all" by accident.
 *
 * It deliberately does **not** check the *containment attestation*.
 * `recordContainmentEvidence` and `confirmWriterLaunch` both refuse an unminted
 * one before they look at any file, and moving that check behind this one would
 * change which refusal a caller sees for two simultaneous faults. (This said
 * "does not check the evidence artefact", which is the first thing it does —
 * "evidence" is this module's defined term for the *lease* artefact, so the
 * sentence read as false about the line directly below it.)
 */
type HeldLeaseFailure =
  | 'EVIDENCE_INVALID'
  | 'LEASE_FOR_ANOTHER_REPOSITORY'
  | 'LEASE_ABSENT'
  | 'LEASE_UNREADABLE'
  | 'NOT_OWNER_UNPARSEABLE'
  | 'NOT_OWNER';

interface HeldLease {
  readonly location: LeaseLocation;
  readonly document: ExecutionLease;
  /**
   * The same artefact the caller passed, narrowed.
   *
   * Handed back rather than re-tested at each call site: the gate has already
   * proved it is minted evidence for exactly this lease, and a second brand
   * check downstream would be a second answer to a question this gate exists to
   * answer once.
   */
  readonly evidence: ExecutionLeaseEvidence;
}

function heldLeaseFor(repository: LeaseRepository, evidence: unknown): HeldLease | HeldLeaseFailure {
  if (!isExecutionLeaseEvidence(evidence)) return 'EVIDENCE_INVALID';

  const location = deriveExecutionLeaseLocation(repository);
  const claimedPath = leasePathOrNull(evidence);
  if (
    claimedPath === null ||
    !location.ok ||
    comparePathIdentity(claimedPath, location.path) !== 'EQUAL'
  ) {
    return 'LEASE_FOR_ANOTHER_REPOSITORY';
  }

  // Through the same reader every other consumer uses, so one file cannot mean
  // two things. It applies the size cap, the JSON parse, the schema and the
  // `leaseKey` binding — the last of which is what refuses a lease document
  // copied here out of another clone.
  const read = readLeaseFile(location.path, location.key);
  if (read.state === 'FREE') return 'LEASE_ABSENT';
  if (read.state === 'UNREADABLE') return 'LEASE_UNREADABLE';
  if (read.document === null) return 'NOT_OWNER_UNPARSEABLE';

  // The record being written against must be the one the lease was taken for,
  // for the reason `verifyExecutionLeaseHeldFor` gives: a mixed record pairs one
  // repository's key with another's root, and every value in it is genuine.
  if (comparePathIdentity(read.document.repositoryRoot, repository.root) !== 'EQUAL') {
    return 'LEASE_FOR_ANOTHER_REPOSITORY';
  }
  if (!ExecutionLeaseProof.matchesNonce(evidence, read.document.ownerNonce)) return 'NOT_OWNER';

  return Object.freeze({ location, document: read.document, evidence });
}

/** Whether the gate answered with a lease rather than with a refusal token. */
function isHeldLease(result: HeldLease | HeldLeaseFailure): result is HeldLease {
  return typeof result !== 'string';
}

/**
 * Records, beside this repository's lease, that its writer was started behind
 * the owned process boundary.
 *
 * ── What may produce evidence, and what may not ────────────────────────────
 *
 * Two artefacts and no shortcut. The caller must hold **minted lease evidence**,
 * which is what proves it is the lease's owner rather than a process that
 * happens to know the path, and a **minted containment attestation**, which can
 * only exist for a launch whose job membership the kernel confirmed. Neither is
 * constructible outside its mint — `core/internal/execution-lease-evidence.ts`
 * and `core/internal/containment-attestation.ts` record why a structural type is
 * not enough and what was forged against the earlier attempt. A boundary that
 * was refused, lost, or never established produces no attestation at all, so
 * there is no arm here that has to detect one: the argument this function cannot
 * be given is the one it cannot mis-handle.
 *
 * ── The lease itself is never written, and that is the whole shape ─────────
 *
 * Learned the hard way, in review. The first version wrote the record *into* the
 * lease document through a single open handle, so that the ownership check and
 * the write shared one file object and could not be raced onto a successor's
 * lease. The binding was sound; the effect was not. An in-place rewrite of a
 * JSON document is not atomic, the record is written once per **writer launch**
 * rather than once per lease — so later records replace earlier ones and are
 * routinely shorter, which was measured — and an interrupted rewrite leaves a
 * lease with no legible owner, which its own holder cannot release, which
 * refuses every future acquisition as `STALE_LEASE_RECOVERY_UNSAFE`, and which
 * nothing in this build can clear. A feature whose purpose is to make a killed
 * orchestrator recoverable must not add a window, once per spawn, in which being
 * killed makes the repository permanently unrunnable.
 *
 * So the lease is **read** here and never written. The record is staged and
 * published by rename onto its own name, which is not the lease's name and is
 * authority for nothing.
 *
 * ── The window that is left, stated because it is real ─────────────────────
 *
 * The ownership check reads the **lease** and the effect writes a **different**
 * file, so the one-file-object argument the withdrawn design rested on does not
 * apply here and nothing replaced it. An adversarial review reproduced the
 * consequence: a process whose lease is released and re-taken *between* its
 * check and its rename publishes anyway, destroying the new holder's genuine
 * record and being told `RECORDED`.
 *
 * Two things are done about it and neither is a claim that it is closed. The
 * ownership check is re-taken immediately before the rename, so the window is
 * one syscall rather than a staged write and an `fsync`; and it is written down
 * here. What makes the residue tolerable is its **direction**: the loser is the
 * new holder's *evidence*, never its lease and never its authority, and the next
 * writer launch under that lease publishes again. A record that is replaced,
 * removed, or left behind by an earlier lease reads as no reliable proof —
 * which is what a missing one reads as.
 *
 * `RECORDED` therefore means "this build built a reliable record and the rename
 * reported success", not "that record is the one on disk now". Nothing in this
 * build reads it as the stronger claim.
 *
 * Never throws. A failure to record is not a failure of the run: the caller keeps
 * its lease and its result, and the repository simply carries no containment
 * proof for that writer.
 */
export function recordContainmentEvidence(
  given: LeaseRepository,
  evidence: unknown,
  attestation: unknown,
  request: ContainmentRecordRequest,
): ContainmentRecordResult {
  if (!isExecutionLeaseEvidence(evidence)) return recordFailure('EVIDENCE_INVALID');

  const facts = containmentFactsOf(attestation);
  if (facts === null) return recordFailure('ATTESTATION_INVALID');

  // One reading of the record, for the gate and the effect alike (LF-2).
  const repository = snapshotRepositoryRecord(given);
  const held = heldLeaseFor(repository, evidence);
  if (!isHeldLease(held)) return containmentFailureFor(held);
  const { location, document } = held;

  // A lease with no run names nothing for the evidence to be about, and an
  // unbound proof is the one thing this record may not become.
  if (document.runId === null) return recordFailure('RUN_NOT_IDENTIFIED');

  // The containment must have been coupled to *this lease's* owner. Anything
  // else is a job whose destruction says nothing about this lease's owner dying,
  // which is the entire inference the record exists to support.
  if (facts.ownerPid !== document.ownerPid) return recordFailure('OWNER_MISMATCH');

  if (
    request === null ||
    typeof request !== 'object' ||
    typeof request.writerId !== 'string' ||
    request.writerId.length === 0 ||
    request.writerId.length > 64 ||
    typeof request.now !== 'function'
  ) {
    return recordFailure('RECORD_NOT_READABLE_BACK', 'WRITER_NOT_NAMED');
  }

  // The clock is a caller-supplied function, so calling it is calling somebody
  // else's code, and "never throws" is a contract this function's only caller
  // relies on by not catching. A `now` that throws is a failed record, not a
  // failed agent run — the same guard `classifyOwnedCommand` puts on its own
  // observation one layer down.
  let recordedAt: string;
  try {
    recordedAt = request.now();
  } catch {
    return recordFailure('RECORD_NOT_READABLE_BACK', 'CLOCK_REFUSED');
  }

  const payload: ContainmentEvidencePayload = {
    evidenceVersion: CONTAINMENT_EVIDENCE_VERSION,
    ownerPid: document.ownerPid,
    runId: document.runId,
    writerId: request.writerId,
    helperPid: facts.helperPid,
    childPid: facts.childPid,
    mode: facts.mode,
    verifiedInJob: true,
    assignedAtCreation: facts.assignedAtCreation,
    launchDigest: facts.launchDigest,
    attestedAt: facts.attestedAt,
    recordedAt,
  };
  const record = { ...payload, binding: containmentBinding(document, payload) };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');

  // Read back before anything is written, and read back through the reader
  // itself: the record must be one this build calls reliable for exactly this
  // lease, run and writer. The clock is a seam, so a `now` returning something
  // the contract refuses is enough to build a record that would be refused for
  // the rest of the lease's life; this is what stops it reaching a file.
  if (bytes.byteLength > MAX_CONTAINMENT_EVIDENCE_BYTES) {
    return recordFailure('RECORD_NOT_READABLE_BACK', 'OVERSIZED');
  }
  let back: unknown;
  try {
    back = JSON.parse(bytes.toString('utf8'));
  } catch {
    return recordFailure('RECORD_NOT_READABLE_BACK', 'NOT_JSON');
  }
  if (
    readContainmentEvidence(
      { ...document, containment: back },
      { runId: document.runId, writerId: request.writerId, ownerPid: document.ownerPid },
    ) !== 'CONTAINED'
  ) {
    return recordFailure('RECORD_NOT_READABLE_BACK', 'NOT_RELIABLE');
  }

  const published = publishCompanionRecord(containmentPathFor(location), bytes, () =>
    stillHeldBy(location, evidence),
  );
  if (published === 'NOT_OWNER') return recordFailure('NOT_OWNER', 'LOST_BEFORE_PUBLISH');
  return published === null
    ? Object.freeze({ code: 'RECORDED' as const, detail: null })
    : recordFailure('RECORD_WRITE_FAILED', published);
}

/**
 * Whether the lease at `location` is still this evidence's, right now.
 *
 * A fresh read every time it is asked, because the whole point of asking it a
 * second time is that the first answer may have expired. It cannot make the
 * publish atomic — see the header — it only makes the window one syscall wide.
 */
function stillHeldBy(location: LeaseLocation, evidence: ExecutionLeaseEvidence): boolean {
  const read = readLeaseFile(location.path, location.key);
  return (
    read.document !== null && ExecutionLeaseProof.matchesNonce(evidence, read.document.ownerNonce)
  );
}

/**
 * Removes this lease's containment record, if there is one.
 *
 * ── Why a removal exists at all in a slice that removes nothing ────────────
 *
 * It removes **evidence**, never a lease, and it exists because the alternative
 * is a lie. The record describes one writer launch. A launch that cannot be
 * attested has nothing to publish, so without this it would leave the *previous*
 * launch's positive record standing and the lease would read `CONTAINED` while
 * its most recent writer was not contained — reproduced by an adversarial review,
 * and the fail-open direction in the one place this slice exists to be
 * conservative.
 *
 * Gated on the same ownership proof the publish takes, and for the same reason:
 * a process that has lost the lease may not touch the holder's record. The same
 * residual window applies and the same direction bounds it — the worst outcome
 * is evidence lost, which is the answer a missing record already gives.
 *
 * It does **not** require the lease to name a run, and the publish does. The
 * asymmetry is deliberate: a run id is what a record has to be *bound to*, and a
 * removal binds to nothing. Refusing to tidy up a lease that names no run would
 * leave a stale positive standing for the one lease shape that can never replace
 * it.
 *
 * ── One attempt, and the retry that was here is withdrawn ─────────────────
 *
 * A previous round gave this the publish's five-attempt budget, reasoning that a
 * removal failing is worse than a publish failing — true — and that "both fail
 * for the same reason on Windows, a reader holding the file open". That second
 * half was measured false: node opens with `FILE_SHARE_DELETE`, so this build's
 * own reader blocks a *rename* onto the name and does not block an `unlink` of
 * it. The budget bought nothing against the hazard it named.
 *
 * And it cost something real. The ownership proof sat outside the loop, so five
 * attempts over eight milliseconds ran against a check taken once — and an
 * adversarial review reproduced a lease changing hands inside that window and a
 * later attempt destroying the *new* holder's record, with the loser told
 * `CLEARED`. A retried destructive loop with its gate outside it is the shape
 * `removeVerifiedLease` already records as a defect class here.
 *
 * So it is withdrawn rather than repaired. One attempt, immediately after the
 * proof, which is the same one-syscall window the publish narrows itself to.
 * A removal that fails answers {@link RECORD_CLEAR_FAILED} with the errno, and
 * the caller is then holding the only evidence that the record on disk is stale;
 * `lease/containment-evidence.ts` states that residue in the format's own terms.
 *
 * Never throws.
 */
export function clearContainmentEvidence(
  given: LeaseRepository,
  evidence: unknown,
): ContainmentRecordResult {
  const held = heldLeaseFor(snapshotRepositoryRecord(given), evidence);
  if (!isHeldLease(held)) return containmentFailureFor(held);
  const { location } = held;

  try {
    unlinkSync(containmentPathFor(location));
  } catch (error) {
    const errno = safeErrnoCode(error);
    // Nothing to remove is the state this was asked to reach, and it is a
    // different answer from "a record was there and is gone": a caller that
    // needs to know whether it destroyed something can tell.
    if (errno === 'ENOENT') return Object.freeze({ code: 'NOTHING_TO_CLEAR' as const, detail: null });
    return recordFailure('RECORD_CLEAR_FAILED', errno);
  }
  return Object.freeze({ code: 'CLEARED' as const, detail: null });
}

/**
 * Stages `bytes` and renames them onto `path`. `null` on success.
 *
 * `rename` rather than a write in place, so a reader never sees half a record —
 * and unlike the lease's own publish this one may *replace* what is there,
 * because what is there is this same holder's earlier record and is authority
 * for nothing. A staged file that cannot be published is removed; nothing reads
 * one by name.
 *
 * Named for the class rather than for one member of it: it publishes both
 * companions this module keeps beside a lease — slice 4's containment record and
 * slice 5's writer-launch ledger. It was called `publishContainmentRecord` while
 * it had one caller, and a shared mechanism carrying one caller's name is how the
 * next author concludes the other caller is doing something different.
 *
 * The retry is not decoration. A rename onto a name a reader currently has open
 * is refused on Windows, and the reader here is this build's own inspection — a
 * `lease status` running beside a writer is an ordinary thing to do. A few short
 * attempts cover a scheduler quantum; failing after them costs a record and
 * nothing else.
 *
 * `stillHeld` is asked immediately before **every** attempt, not once before the
 * loop. That is the whole of the narrowing described on
 * {@link recordContainmentEvidence}: the staged write and its `fsync` happen
 * before the first ask, so the window between the last check and the effect is
 * one syscall. It is a narrowing and not a closure, and answering `'NOT_OWNER'`
 * rather than throwing keeps the caller's vocabulary total.
 *
 * **What no test pins**, stated because a silent gap reads as coverage: that the
 * ask happens before *every* attempt rather than once. The test in
 * `tests/v3-04-lease-containment.test.ts` hands the lease over from the `now`
 * seam, which runs before this function is entered, so it kills a mutant that
 * deletes the check and survives one that hoists it out of the loop — an
 * adversarial review demonstrated exactly that. Nothing single-threaded and
 * synchronous can take a lease between two iterations of this loop, so pinning
 * the position needs a second process, which is a dist-artifact harness and not
 * this slice's to add. The position is kept because it is free and strictly
 * better, not because it is measured.
 */
function publishCompanionRecord(
  path: string,
  bytes: Buffer,
  stillHeld: () => boolean,
  durable = true,
): string | null | 'NOT_OWNER' {
  const staging = `${path}.tmp-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`;
  const staged = writeRecord(staging, bytes, durable);
  if (staged !== null) {
    discard(staging);
    return staged;
  }

  let lastError = 'RENAME_NOT_ATTEMPTED';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!stillHeld()) {
      discard(staging);
      return 'NOT_OWNER';
    }
    try {
      renameSync(staging, path);
      return null;
    } catch (error) {
      // `safeErrnoCode` answers `'UNKNOWN'` rather than nullish, so a fallback
      // here would be dead. The initial value below is what a loop that never
      // reaches this line reports.
      lastError = safeErrnoCode(error);
    }
    // A short synchronous pause, and not after the final attempt — this module
    // is synchronous by contract, its claim being one uninterrupted sequence of
    // filesystem calls with no `await` for anything to interleave with, so the
    // wait cannot be a timer and it blocks the loop while it runs. Measured at
    // roughly 8 ms of blocking for a rename that can never succeed.
    //
    // `hrtime` rather than `Date.now`: a wall clock can step backwards — NTP,
    // a VM resume — and this loop would then spin until it stepped forward
    // again. `owned-command.ts` discloses the same hazard for its own clamp.
    if (attempt < 4) spinFor(2);
  }
  discard(staging);
  return lastError;
}

/** Blocks for `ms`, measured on a clock that cannot step backwards. */
function spinFor(ms: number): void {
  const until = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < until) {
    /* a scheduler quantum is all a transient share violation needs. */
  }
}

/**
 * The containment record beside this lease, or `undefined` when there is none.
 *
 * Every failure to read one answers with a value that *cannot* be reliable:
 * `undefined` only for "there is nothing there", and a plain token for anything
 * else, which `readContainmentEvidence` refuses as `MALFORMED`. There is
 * deliberately no arm that turns an unreadable record into a missing one — a
 * torn companion must not read as "no writer was contained", it must read as
 * "nothing here is proof", and those are different sentences to an operator.
 */
function readContainmentRecord(location: LeaseLocation): unknown {
  return readCompanionRecord(containmentPathFor(location), MAX_CONTAINMENT_EVIDENCE_BYTES);
}

/**
 * Whatever is at a companion path, for a reader that judges it. Never throws.
 *
 * One reader for both companions, for the reason {@link publishCompanionRecord}
 * is one publisher: the vocabulary rule below is the same rule for both, and two
 * copies of it is one copy that can drift into answering `undefined` for a file
 * it merely failed to read.
 */
function readCompanionRecord(path: string, maxBytes: number): unknown {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (safeErrnoCode(error) !== 'ENOENT') return 'UNREADABLE';
    // `ENOENT` from a *read* is not always "there is nothing there": a dangling
    // junction or symlink is an entry at this path whose target is gone, and
    // `readFileSync` follows it and reports the target's absence. Reported as
    // `ABSENT` it would tell an operator no record was ever written, about a
    // path that visibly has something on it — the exact vocabulary rule this
    // function is written to keep. `lstat` does not follow, so it separates the
    // two cases, and a failure to `lstat` at all is not-there.
    try {
      lstatSync(path);
    } catch {
      return undefined;
    }
    return 'UNREADABLE';
  }
  if (bytes.byteLength > maxBytes) return 'OVERSIZED';
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return 'NOT_JSON';
  }
}

/* ─────────────────────── the writer-launch ledger ───────────────────────── */

/**
 * The ledger's file name. A plain name, never derived, and its own file.
 *
 * A third file in the Git common directory rather than a field in either of the
 * two that exist, and both alternatives were considered and refused for reasons
 * this repository has already paid for:
 *
 *  - **not in the lease document.** The ledger is rewritten before and after
 *    every writer launch. `lease/containment-evidence.ts` records what an
 *    in-place rewrite of the lease costs when it is interrupted: a lease with no
 *    legible owner, which its holder cannot release, which refuses every future
 *    acquisition, and which nothing in this build can clear. That is the exact
 *    failure this slice exists to make recoverable, so putting the fix inside
 *    the thing it fixes is not an option;
 *  - **not in the containment record.** That record's contract is "the most
 *    recent launch", it is *removed* when a launch cannot be attested, and the
 *    recovery predicate must never read it. Two contracts in one file is how one
 *    of them gets read as the other — which is precisely the confusion between
 *    `latestLaunchContained` and "this lease is safe" that slice 5 exists to
 *    stop.
 */
export const WRITER_LAUNCH_LEDGER_FILE_NAME = 'agent-orchestrator-execution-lease.launches.json';

/**
 * Largest ledger this build will read back.
 *
 * Four mebibytes, which covers {@link MAX_WRITER_LAUNCH_ENTRIES} entries at
 * roughly 465 bytes each — about 1.9 MB — with room for a future field. It was
 * 1 MiB and described as "sized for the entry cap", and it was not: an
 * adversarial review measured the byte cap binding first, at about 2261 entries,
 * which made the entry cap dead and turned the overflow into a silent permanent
 * loss of recoverability. The entry cap is the one that binds now, and reaching
 * it is a reported outcome. See `writer-launch-ledger.ts` for what was measured.
 */
const MAX_WRITER_LAUNCH_LEDGER_BYTES = 4_194_304;

/** The ledger's path for a lease location. One derivation, one place. */
function ledgerPathFor(location: LeaseLocation): string {
  return join(location.key, WRITER_LAUNCH_LEDGER_FILE_NAME);
}

/**
 * What became of an attempt to open or confirm a writer-launch generation.
 *
 * A closed set. **Four** members are successes since M2 slice 1 added the middle
 * mark and its withdrawal, one is the deliberate *loss* of a history, and one is
 * the only condition in this build under which a failure to record stops
 * productive work — see {@link LAUNCH_MUST_NOT_START}, which two callers reach
 * and which stops the same run at two different moments. (It said two members,
 * and was not recounted when the third arrived; it is counted from the array
 * below now. It also said "an enrichment", which stopped being the right word
 * for the withdrawal once its answer was consumed.)
 */
export const WRITER_LAUNCH_CODES = [
  /** The generation is on disk as `PENDING`. The launch may proceed. */
  'OPENED',
  /**
   * The generation is on disk as `ESTABLISHED`: the kernel confirmed job
   * membership, and the launch has not been seen to end.
   *
   * Its own code rather than a shade of {@link CONFIRMED}, because the two mean
   * different things to a recovery and a caller that could not tell them apart
   * would report the weaker one as the stronger.
   */
  'ESTABLISHED',
  /** The generation is on disk as `CONTAINED`. */
  'CONFIRMED',
  /**
   * The generation is on disk as `PENDING` again: an establishment mark was
   * withdrawn, or there was none to withdraw.
   *
   * A success, and the one that is easy to misread. It does not mean a launch
   * failed; it means this build has stopped claiming a proof it can no longer
   * support. See {@link retractWriterLaunchEstablishment}.
   */
  'RETRACTED',
  /**
   * The generation could not be published, so the whole history was **removed**
   * instead. The launch may proceed; this lease can never be recovered.
   *
   * The escape hatch that keeps a failed publish from stopping a run, and it is
   * fail-closed rather than a compromise. The hazard a publish has is a stale
   * *affirmative* history — generations 1..N-1 all `CONTAINED`, and generation N
   * launching unrecorded — which reads as a complete proof and is a lie. Deleting
   * the file removes the affirmative claim entirely: the next reading is
   * `ABSENT`, the next rebuild is `historyComplete: false`, and both refuse
   * recovery. Evidence is lost; nothing is asserted that is not true.
   */
  'HISTORY_DISCARDED',
  /**
   * The history could neither be extended nor removed. **Productive work must
   * not go on.**
   *
   * The one place in this build where a failure to record stops productive work,
   * and it is deliberate. Every other recording failure has a fail-closed
   * fallback; this one has run out of them. What is on disk is an affirmative
   * history that does not mention the launch about to happen, and launching
   * anyway would leave a lease that reads *provably recoverable* while an
   * unrecorded writer tree may outlive it. That is the single fail-open state
   * this slice exists to make unreachable, so the launch loses.
   *
   * It said "the launch must not start", which named one of its two producers.
   * {@link beginWriterLaunch} is that one and the sentence is exact there. The
   * other is {@link retractWriterLaunchEstablishment}, where the launch is
   * already **over** and there is nothing left to refuse to start: what the code
   * means there is that the *step* must not go on, because the entry it could
   * not take back is the one a recovery would remove the lease on. Both
   * producers are read in `loop/leased-spawns.ts` and both stop the same run;
   * they simply stop it at different moments, and a reader who took the
   * launch-shaped wording literally would look for a gate that does not exist
   * on the commit, the verification or the reviewer.
   *
   * Reached when the ledger path can be neither renamed onto nor unlinked. A
   * read-only or vanished administrative directory does it; so does a
   * **directory** sitting at the ledger's own name, which is the case an
   * adversarial review produced in-process with one `mkdir` after this comment
   * claimed the state needed a broken filesystem. `tests/v3-05-stale-lease-recovery.test.ts`
   * produces it that way now, rather than leaving the arm unreached.
   */
  'LAUNCH_MUST_NOT_START',
  /** The lease artefact was not minted evidence. Nothing was opened. */
  'EVIDENCE_INVALID',
  /** The containment artefact was not minted. Nothing was written. */
  'ATTESTATION_INVALID',
  /** The evidence names a different repository's lease than the record does. */
  'LEASE_FOR_ANOTHER_REPOSITORY',
  /** No lease path can be derived, or nothing is at the one derived. */
  'LEASE_ABSENT',
  /** Something is at the lease path and could not be read. */
  'LEASE_UNREADABLE',
  /** What is there is not this holder's lease — or is not a lease at all. */
  'NOT_OWNER',
  /** The containment was coupled to a process other than the lease's owner. */
  'OWNER_MISMATCH',
  /**
   * The generation being confirmed is not open in the history on disk.
   *
   * Its own code, and it is a refusal rather than a repair: a confirmation that
   * cannot find its own `PENDING` entry must not invent one, because the entry
   * is the record of a launch and inventing it would confirm a launch nobody
   * announced. `detail` carries the reading that produced it.
   */
  'GENERATION_NOT_OPEN',
  /**
   * This attestation has already proved another generation of this lease.
   *
   * Its own code rather than a shade of {@link GENERATION_NOT_OPEN}, because the
   * generation *is* open and the fault is in the proof. One kernel-confirmed
   * launch proves one launch; replaying its attestation across several
   * generations would produce a history reading `ALL_LAUNCHES_CONTAINED` in
   * which only one of the launches was ever confirmed.
   *
   * Not reachable through `loop/leased-spawns.ts`, where each result carries its
   * own attestation — which is exactly why it is a check here. "Every launch in
   * it is proved contained" was guaranteed by the caller and is now guaranteed
   * by the format, and `confirmWriterLaunch` is exported.
   */
  'ATTESTATION_ALREADY_USED',
  /** The ledger this build built is one this build would not accept back. */
  'LEDGER_NOT_READABLE_BACK',
  /**
   * The ledger could not be written, and the history on disk is unchanged.
   *
   * Answered by the two marks that follow an open - the establishment and the
   * confirmation - where leaving the generation **where it already was** is
   * already the conservative end state. Since M2 slice 1 that is `PENDING` for a
   * failed establishment and `ESTABLISHED` for a failed confirmation, and neither
   * claims the launch ended. (This said "leaving the generation `PENDING`", which
   * was the third copy of a promise the middle mark made false.) The opening path
   * never answers it: a failed open has a launch about to happen and therefore
   * must reach {@link HISTORY_DISCARDED} or {@link LAUNCH_MUST_NOT_START}
   * instead.
   */
  'LEDGER_WRITE_FAILED',
] as const;

export type WriterLaunchCode = (typeof WRITER_LAUNCH_CODES)[number];

export interface WriterLaunchResult {
  readonly code: WriterLaunchCode;
  /** An errno token or a short reason, never free text from anywhere else. */
  readonly detail: string | null;
  /**
   * The generation this call is about, or `null` when none was reached.
   *
   * Present on `OPENED` so the caller can name it back when confirming, and
   * deliberately **not** re-derived at confirmation time: "the last generation"
   * read a second time is a different question from "the generation I opened",
   * and the difference is a launch that opened generation 4 confirming
   * generation 5.
   */
  readonly generation: number | null;
}

function launchFailure(
  code: WriterLaunchCode,
  detail: string | null = null,
  generation: number | null = null,
): WriterLaunchResult {
  return Object.freeze({ code, detail, generation });
}

/** The ledger vocabulary's answer to each refusal of the shared lease gate. */
function launchFailureFor(failure: HeldLeaseFailure): WriterLaunchResult {
  switch (failure) {
    case 'EVIDENCE_INVALID':
      return launchFailure('EVIDENCE_INVALID');
    case 'LEASE_FOR_ANOTHER_REPOSITORY':
      return launchFailure('LEASE_FOR_ANOTHER_REPOSITORY');
    case 'LEASE_ABSENT':
      return launchFailure('LEASE_ABSENT');
    case 'LEASE_UNREADABLE':
      return launchFailure('LEASE_UNREADABLE');
    case 'NOT_OWNER_UNPARSEABLE':
      return launchFailure('NOT_OWNER', 'UNPARSEABLE');
    case 'NOT_OWNER':
      return launchFailure('NOT_OWNER');
  }
}

/** The four lease fields a ledger is bound to and judged against. */
function subjectOf(document: ExecutionLease): {
  readonly leaseKey: string;
  readonly ownerNonce: string;
  readonly ownerPid: number;
  readonly runId: string | null;
} {
  return {
    leaseKey: document.leaseKey,
    ownerNonce: document.ownerNonce,
    ownerPid: document.ownerPid,
    runId: document.runId,
  };
}

/** The ledger beside this lease, as a value for the format to judge. */
function readLedgerRecord(location: LeaseLocation): unknown {
  return readCompanionRecord(ledgerPathFor(location), MAX_WRITER_LAUNCH_LEDGER_BYTES);
}

/** Seals a payload with its binding and renders the bytes. */
function ledgerBytesFor(document: ExecutionLease, payload: WriterLaunchLedgerPayload): Buffer {
  const sealed = { ...payload, binding: writerLaunchBinding(document, payload) };
  return Buffer.from(`${JSON.stringify(sealed, null, 2)}\n`, 'utf8');
}

/**
 * Parses `bytes` back as this build's reader would. `undefined` when they are
 * not a ledger at all, which is a value the reader refuses rather than accepts.
 */
function ledgerReadBack(bytes: Buffer): unknown {
  if (bytes.byteLength > MAX_WRITER_LAUNCH_LEDGER_BYTES) return 'OVERSIZED';
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return 'NOT_JSON';
  }
}

/**
 * Starts a lease's launch history, at the one moment it can be complete.
 *
 * Called by {@link acquireRepositoryExecutionLease} immediately after the lease
 * is published, and from nowhere else. That placement is the whole of what
 * `historyComplete: true` means: the lease exists, this process holds it, and no
 * writer can have launched under it yet, so an empty history is a true and
 * complete one. A ledger written at any later moment cannot say that, and
 * `writer-launch-ledger.ts` records why nothing promotes a `false` to a `true`.
 *
 * It replaces whatever ledger is at the path, and that is correct rather than
 * careless: what is there belongs to a lease that no longer exists — the name was
 * free a moment ago — and it is refused by its own binding for this one anyway.
 *
 * **Failure is silent, and the direction is safe.** A lease that could not
 * publish a history simply has none: every reading of an absent ledger refuses
 * recovery, and the acquisition itself is untouched. Turning a failed enrichment
 * into a refused lease would be the wrong severity, and it is the severity slice
 * 4 already settled for the containment record.
 */
function openWriterLaunchHistory(
  location: LeaseLocation,
  document: ExecutionLease,
  evidence: ExecutionLeaseEvidence,
): void {
  const bytes = ledgerBytesFor(document, {
    ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION,
    ownerPid: document.ownerPid,
    runId: document.runId,
    historyComplete: true,
    entries: [],
    // The register is opened at the same instant and for the same reason: this
    // is the one moment nothing can have been hidden, because the lease exists,
    // this process holds it, and no owned subprocess can have been started under
    // it yet. An empty register minted anywhere later would be a claim this
    // build cannot make.
    open: [],
    // Slots start at 1 and only ever go up. See `owned-launch-register.ts` for
    // what a rolled-back counter would let a stale settlement do.
    nextSlot: 1,
  });
  // Read back before it is written, through the reader itself, for the reason
  // the containment record is: a ledger this build would refuse is worse than no
  // ledger, because it is a file an operator has to explain.
  if (readWriterLaunchLedger(subjectOf(document), ledgerReadBack(bytes)) !== 'ALL_LAUNCHES_CONTAINED') {
    return;
  }
  publishCompanionRecord(ledgerPathFor(location), bytes, () => stillHeldBy(location, evidence));
}

/**
 * Announces a writer launch under this lease, **before** it happens.
 *
 * ── Why the order cannot be the other way round ────────────────────────────
 *
 * The record that matters for recovery is the one describing a launch that was
 * killed. A record written after a launch cannot describe one that never got
 * that far; a mark written before it can. So the generation goes down as
 * `PENDING` first, the launch happens only once that is on disk, and everything
 * that can go wrong afterwards — a lost boundary, a killed orchestrator, an
 * unpublishable confirmation — leaves the mark exactly where it is.
 *
 * That is what makes {@link LAUNCH_MUST_NOT_START} necessary rather than
 * fussy. If this call cannot change what is on disk, the history there is an
 * affirmative one that does not mention the launch about to happen. It gets one
 * fallback — delete the history, which asserts nothing — and if that fails too
 * the launch is refused, because the alternative is the single fail-open state
 * this slice exists to make unreachable.
 *
 * ── What it does with a history it cannot use ──────────────────────────────
 *
 * Rebuilds from empty with `historyComplete: false`, permanently. A ledger that
 * is absent, torn, versioned for another build or bound to another lease might
 * have described launches this one cannot see, and starting a fresh *complete*
 * history at generation 1 would hide every one of them. This is the fail-open
 * shape a review would find, so it is closed by construction: only the
 * acquisition may mint a complete history.
 *
 * Never throws.
 */
export function beginWriterLaunch(
  given: LeaseRepository,
  evidence: unknown,
  request: { readonly writerId: string; readonly now: () => string },
): WriterLaunchResult {
  const held = heldLeaseFor(snapshotRepositoryRecord(given), evidence);
  if (!isHeldLease(held)) return launchFailureFor(held);
  const { location, document, evidence: holder } = held;

  if (
    request === null ||
    typeof request !== 'object' ||
    typeof request.writerId !== 'string' ||
    request.writerId.length === 0 ||
    request.writerId.length > 64 ||
    typeof request.now !== 'function'
  ) {
    return launchFailure('LEDGER_NOT_READABLE_BACK', 'WRITER_NOT_NAMED');
  }

  // The clock is a caller-supplied function, so calling it is calling somebody
  // else's code, and this module's "never throws" is relied on by not catching.
  let openedAt: string;
  try {
    openedAt = request.now();
  } catch {
    return launchFailure('LEDGER_NOT_READABLE_BACK', 'CLOCK_REFUSED');
  }

  const subject = subjectOf(document);
  const raw = readLedgerRecord(location);
  const existing = extendableWriterLaunchLedger(subject, raw);
  const entries: WriterLaunchEntry[] = existing === null ? [] : [...existing.entries];
  // `false` when there was nothing usable to extend, and it never becomes `true`
  // again: see the header, and `writer-launch-ledger.ts` for why.
  const historyComplete = existing !== null && existing.historyComplete;
  const generation = entries.length + 1;

  // A history that cannot grow may not be *left standing* either: it would be an
  // affirmative record that stops mentioning launches, which is the one shape
  // this whole path exists to prevent. So it is discarded, the launch proceeds,
  // and this lease is never recoverable again — the same trade the publish
  // failure takes, reached for a different reason and reported with its own.
  //
  // Before the fix this arm replaces, the cap was unreachable and the *byte* cap
  // bound first, which produced no code at all: every later confirmation failed
  // its read-back in silence.
  if (entries.length >= MAX_WRITER_LAUNCH_ENTRIES) {
    return discardWriterLaunchHistory(location, holder, 'HISTORY_FULL');
  }

  const payload: WriterLaunchLedgerPayload = {
    ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION,
    ownerPid: document.ownerPid,
    runId: document.runId,
    historyComplete,
    entries: [...entries, { generation, state: 'PENDING', writerId: request.writerId, openedAt }],
    // Carried through untouched. A writer launch is not an owned-launch event,
    // and a payload built here that dropped the register would erase the record
    // of every owned subprocess still open — which is the one edit in that
    // format that turns a refusal into a permission.
    //
    // Empty and 1 only where `existing` is `null`, which is a document this
    // build could not extend. That path also sets `historyComplete: false`, so
    // the rebuilt register is never read as a proof: every reading of such a
    // document is `HISTORY_INCOMPLETE`, and `readOwnedLaunchRegister` collapses
    // that to `REGISTER_NOT_READABLE`. Losing the old register there costs
    // nothing that was not already lost.
    open: existing === null ? [] : existing.open,
    nextSlot: existing === null ? 1 : existing.nextSlot,
  };
  const bytes = ledgerBytesFor(document, payload);

  // Read back before anything is written, and through the reader itself. The
  // clock is a seam, so a `now` returning something the contract refuses is
  // enough to build a ledger that would be refused for the rest of this lease's
  // life; this is what stops it reaching a file. The expected reading is stated
  // rather than merely "not refused": a freshly opened generation is unproven by
  // construction, so a build of this payload that read as a *proof* would be the
  // format failing in the one direction that matters.
  const expected: WriterLaunchReading = historyComplete ? 'LAUNCH_UNPROVEN' : 'HISTORY_INCOMPLETE';
  if (readWriterLaunchLedger(subject, ledgerReadBack(bytes)) !== expected) {
    return launchFailure('LEDGER_NOT_READABLE_BACK', 'NOT_AS_BUILT');
  }

  const published = publishCompanionRecord(ledgerPathFor(location), bytes, () =>
    stillHeldBy(location, holder),
  );
  if (published === null) return Object.freeze({ code: 'OPENED' as const, detail: null, generation });
  if (published === 'NOT_OWNER') {
    // The lease changed hands mid-publish. The history on disk is the **new**
    // holder's, and this call has no standing to delete it — the discard below
    // would destroy a successor's evidence, which is the mistake
    // `removeVerifiedLease` records as its own defect class.
    return launchFailure('NOT_OWNER', 'LOST_BEFORE_PUBLISH');
  }

  // The publish failed and a launch is about to happen. Removing the history is
  // the fallback, and it is the conservative one: an absent ledger asserts
  // nothing, while the affirmative one on disk would assert something false.
  return discardWriterLaunchHistory(location, holder, published);
}

/**
 * Removes this lease's launch history, so that nothing on disk asserts anything
 * about the launch that is about to happen.
 *
 * The fallback {@link HISTORY_DISCARDED} names, and the only destructive step in
 * the ledger's write path. Two callers: a publish that failed, and a history
 * that has reached {@link MAX_WRITER_LAUNCH_ENTRIES} and cannot grow.
 *
 * ── The ownership re-check is not decoration ───────────────────────────────
 *
 * The unlink used to run on the last `stillHeldBy` answer taken *inside*
 * `publishCompanionRecord`'s loop, one or more syscalls earlier. An adversarial
 * review pointed out what that costs: a lease that changed hands in that window
 * has its successor's brand-new complete history deleted by the previous holder,
 * and the successor then rebuilds at `historyComplete: false` and is
 * unrecoverable for the rest of its life. Fail-closed, bounded — and an unowned
 * write at a name somebody else now holds, which is the defect class this module
 * records against itself repeatedly.
 *
 * So it is re-asked here, immediately before the effect. That is a **narrowing
 * to one syscall and not a closure**, exactly as the publish's own re-check is,
 * and it is stated the same way rather than claimed to be more.
 */
function discardWriterLaunchHistory(
  location: LeaseLocation,
  holder: ExecutionLeaseEvidence,
  reason: string,
): WriterLaunchResult {
  if (!stillHeldBy(location, holder)) return launchFailure('NOT_OWNER', 'LOST_BEFORE_DISCARD');
  try {
    unlinkSync(ledgerPathFor(location));
  } catch (error) {
    const errno = safeErrnoCode(error);
    // Nothing there is the state this was reaching for, so it counts as reached.
    if (errno !== 'ENOENT') return launchFailure('LAUNCH_MUST_NOT_START', errno);
  }
  return launchFailure('HISTORY_DISCARDED', reason);
}

/**
 * Confirms that the generation `request.generation` opened was contained.
 *
 * Takes the generation as an argument rather than confirming "the latest one",
 * and that is load-bearing: two questions that look the same — *which generation
 * did I open* and *which generation is last on disk* — have different answers the
 * moment anything else has written, and confirming the wrong one would mark an
 * unproven launch proven. The opener returns the number; this consumes it.
 *
 * It refuses rather than repairs. A ledger it cannot extend, a generation that is
 * not there, one already confirmed, one opened for a different writer — every one
 * of those answers {@link GENERATION_NOT_OPEN} and writes nothing, because the
 * entry *is* the record of a launch and a confirmation that invents one is a
 * confirmation of a launch nobody announced.
 *
 * A failure to publish leaves the generation **where it already was**. Since M2
 * slice 1 that may be `ESTABLISHED` rather than `PENDING` - the establishment
 * mark is written first, so it is `PENDING` only when that mark did not land
 * either. Which is more common is not measured and is not claimed. Both are conservative in the sense that matters — neither
 * claims the launch ended — and they are not equally strong: `PENDING` refuses a
 * recovery outright, while `ESTABLISHED` still owes, and is granted only after,
 * the liveness proof on the processes it names. This paragraph said "leaves the
 * generation `PENDING` … the answer a recovery refuses", and both halves stopped
 * being true when the middle state was added.
 *
 * Nothing is discarded here: unlike the opening path there is no launch pending
 * on the result, so a conservative end state is already on disk.
 *
 * Never throws.
 */
export function confirmWriterLaunch(
  given: LeaseRepository,
  evidence: unknown,
  attestation: unknown,
  request: { readonly generation: number; readonly writerId: string; readonly now: () => string },
): WriterLaunchResult {
  return recordLaunchContainment(given, evidence, attestation, request, 'CONTAINED');
}

/**
 * Records that the kernel placed this generation's target in the owner's job.
 *
 * The middle mark, written **while the writer is still running** — between the
 * boundary reporting confirmed membership and the target's first instruction —
 * which is the whole of M2 slice 1. `writer-launch-ledger.ts` carries the
 * reasoning and the measurement; what matters at this call site is the ordering
 * it belongs to and the one thing it does not claim.
 *
 * It does not claim the tree ended. {@link confirmWriterLaunch} is still the
 * call that says that, and it is still made after the launch has been seen to
 * end. This one only moves a generation out of `PENDING`, so a later recovery
 * has something to re-verify instead of nothing to go on.
 *
 * Refuses a generation that is not `PENDING`: an already-established generation
 * is not established twice, and a confirmed one is not walked backwards. Both
 * answer `GENERATION_NOT_OPEN` with a detail that says which.
 */
export function attestWriterLaunchEstablished(
  given: LeaseRepository,
  evidence: unknown,
  attestation: unknown,
  request: { readonly generation: number; readonly writerId: string; readonly now: () => string },
): WriterLaunchResult {
  return recordLaunchContainment(given, evidence, attestation, request, 'ESTABLISHED');
}

/**
 * Puts an `ESTABLISHED` generation back to `PENDING`, withdrawing the recovery
 * proof it carried.
 *
 * ── The hazard this exists for, which a review found and this build owns ───
 *
 * `ESTABLISHED` licenses a recovery on the strength of the pids it records, and
 * that is sound for exactly one situation: the owner died **while that launch
 * was running**, when nothing else of the epoch could be running either, because
 * this build starts owned launches one at a time.
 *
 * A launch that *ends* without reaching `CONTAINED` breaks that. It happens: the
 * ending may be unattestable (`BOUNDARY_LOST`), or the confirmation may fail to
 * publish after a perfectly ordinary run. The entry then stays `ESTABLISHED`
 * while the run carries on to a commit, a verification and a reviewer — all
 * owned, none of them in this ledger. If the owner dies during one of *those*,
 * the recovery probes the old writer's pids, finds them gone, and removes the
 * lease while an AO-started process may still be alive.
 *
 * The ledger cannot see those launches; widening it to record every owned
 * subprocess is a different contract. What it *can* do is stop claiming
 * something it no longer knows, at the one moment it learns it: the instant a
 * writer launch is over without a proof of its ending.
 *
 * ── Why `PENDING`, and why that is exactly the right target ────────────────
 *
 * Because it is the state this build left such a launch in **before** the
 * establishment mark existed. Retracting to it does not invent a conservative
 * answer; it restores the one that shipped, so the new arm cannot license a
 * recovery the previous build refused. The lease is then unrecoverable for the
 * same reason and to the same extent as before — no wider, and no narrower.
 *
 * The recorded pids go with it. They are not lost information anybody may act
 * on: they were only ever an input to a proof this call is withdrawing, and
 * keeping them beside a state that no longer proves anything is how a field
 * starts being read as one that does.
 *
 * ── Fail-closed twice, and the third ending belongs to the caller ─────────
 *
 * A retraction that cannot be published falls back to discarding the whole
 * history — the same escape hatch `beginWriterLaunch` uses, and for the same
 * reason: what is on disk would otherwise be an affirmative claim that is no
 * longer true, and deleting it asserts nothing. `HISTORY_DISCARDED` is a worse
 * outcome for this lease and a safe one.
 *
 * Twice is not always enough, and this heading said so without saying what
 * follows. When the publish *and* the discard are both refused the answer is
 * {@link LAUNCH_MUST_NOT_START}, and the affirmative entry is still on disk,
 * still readable, and still bound to a live lease — so a later recovery reads
 * it as `LAUNCHES_CONTAINED_SOME_UNENDED` and may remove the lease. Nothing in
 * this function can prevent that: the two writes it has are the two that were
 * refused. What it can do is *report* it, which is why the third ending has its
 * own code, and `loop/leased-spawns.ts` is where that report has to be acted
 * on — it stops the step rather than returning the writer's result. Measured
 * rather than argued: with the ledger held open by another process the rename
 * answers `EPERM`, the unlink answers `EBUSY`, and
 * `tests/v3-05-stale-lease-recovery.test.ts` drives the whole sequence.
 *
 * A `CONTAINED` generation is never walked back. Its ending *was* proved, so
 * there is nothing stale about it, and a call that could undo a proof is a
 * capability this module has no use for.
 */
export function retractWriterLaunchEstablishment(
  given: LeaseRepository,
  evidence: unknown,
  request: { readonly generation: number; readonly writerId: string },
): WriterLaunchResult {
  if (!isExecutionLeaseEvidence(evidence)) return launchFailure('EVIDENCE_INVALID');

  const held = heldLeaseFor(snapshotRepositoryRecord(given), evidence);
  if (!isHeldLease(held)) return launchFailureFor(held);
  const { location, document, evidence: holder } = held;

  if (
    request === null ||
    typeof request !== 'object' ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 1 ||
    typeof request.writerId !== 'string' ||
    request.writerId.length === 0 ||
    request.writerId.length > 64
  ) {
    return launchFailure('LEDGER_NOT_READABLE_BACK', 'GENERATION_NOT_NAMED');
  }

  const subject = subjectOf(document);
  const raw = readLedgerRecord(location);
  const existing = extendableWriterLaunchLedger(subject, raw);
  if (existing === null) {
    return launchFailure(
      'GENERATION_NOT_OPEN',
      readWriterLaunchLedger(subject, raw),
      request.generation,
    );
  }

  const index = request.generation - 1;
  const open = existing.entries[index];
  if (open === undefined || open.generation !== request.generation) {
    return launchFailure('GENERATION_NOT_OPEN', 'NOT_PRESENT', request.generation);
  }
  if (open.writerId !== request.writerId) {
    return launchFailure('GENERATION_NOT_OPEN', 'ANOTHER_WRITER', request.generation);
  }
  if (open.state === 'CONTAINED') {
    return launchFailure('GENERATION_NOT_OPEN', 'ALREADY_CONFIRMED', request.generation);
  }
  if (open.state === 'PENDING') {
    // Nothing to withdraw, and the postcondition this call exists for already
    // holds. Answered as a success rather than as a refusal because the caller
    // asks for a *state*, not for a write: the establishment mark that never
    // landed is the commonest way to get here.
    return Object.freeze({
      code: 'RETRACTED' as const,
      detail: 'ALREADY_PENDING',
      generation: request.generation,
    });
  }

  const entries = [...existing.entries];
  entries[index] = {
    generation: open.generation,
    state: 'PENDING',
    writerId: open.writerId,
    openedAt: open.openedAt,
  };

  const payload: WriterLaunchLedgerPayload = {
    ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION,
    ownerPid: document.ownerPid,
    runId: document.runId,
    historyComplete: existing.historyComplete,
    entries,
    // Carried through untouched, for the reason `beginWriterLaunch` gives: a
    // writer-history write is not an owned-launch event, and a payload that
    // dropped the register would erase the record of every owned subprocess
    // still open.
    open: existing.open,
    nextSlot: existing.nextSlot,
  };
  const bytes = ledgerBytesFor(document, payload);

  const back = ledgerReadBack(bytes);
  const rebuilt = extendableWriterLaunchLedger(subject, back);
  if (rebuilt === null || rebuilt.entries[index]?.state !== 'PENDING') {
    // Not a plain refusal: what is on disk still claims this launch is a proof,
    // and this call has just established that it is not. The history goes.
    return discardWriterLaunchHistory(location, holder, 'RETRACTION_NOT_AS_BUILT');
  }

  const published = publishCompanionRecord(ledgerPathFor(location), bytes, () =>
    stillHeldBy(location, holder),
  );
  if (published === 'NOT_OWNER') {
    // Somebody else's lease is at that path now, and this call has no standing
    // to delete their history. Their ledger describes their run, not this one.
    return launchFailure('NOT_OWNER', 'LOST_BEFORE_PUBLISH', request.generation);
  }
  if (published !== null) return discardWriterLaunchHistory(location, holder, published);
  return Object.freeze({ code: 'RETRACTED' as const, detail: null, generation: request.generation });
}

/**
 * The one implementation behind both marks.
 *
 * Shared rather than copied, and that is a safety decision rather than a tidiness
 * one: the two differ in four small places — which prior state they accept, which
 * state they write, which instant field they stamp and which code they answer —
 * and every other step is the lease gate, the owner check, the replay check, the
 * read-back and the byte-bound publish. Two copies of that would be two places
 * for a later slice to strengthen one and forget the other, which is the failure
 * this file's neighbours keep recording.
 */
function recordLaunchContainment(
  given: LeaseRepository,
  evidence: unknown,
  attestation: unknown,
  request: { readonly generation: number; readonly writerId: string; readonly now: () => string },
  target: 'ESTABLISHED' | 'CONTAINED',
): WriterLaunchResult {
  if (!isExecutionLeaseEvidence(evidence)) return launchFailure('EVIDENCE_INVALID');

  const facts = containmentFactsOf(attestation);
  if (facts === null) return launchFailure('ATTESTATION_INVALID');

  const held = heldLeaseFor(snapshotRepositoryRecord(given), evidence);
  if (!isHeldLease(held)) return launchFailureFor(held);
  const { location, document, evidence: holder } = held;

  // The containment must have been coupled to *this lease's* owner. Anything
  // else is a job whose destruction says nothing about this lease's owner dying,
  // which is the entire inference the ledger exists to support.
  if (facts.ownerPid !== document.ownerPid) return launchFailure('OWNER_MISMATCH');

  if (
    request === null ||
    typeof request !== 'object' ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 1 ||
    typeof request.writerId !== 'string' ||
    request.writerId.length === 0 ||
    request.writerId.length > 64 ||
    typeof request.now !== 'function'
  ) {
    return launchFailure('LEDGER_NOT_READABLE_BACK', 'GENERATION_NOT_NAMED');
  }

  const subject = subjectOf(document);
  const raw = readLedgerRecord(location);
  const existing = extendableWriterLaunchLedger(subject, raw);
  if (existing === null) {
    return launchFailure(
      'GENERATION_NOT_OPEN',
      readWriterLaunchLedger(subject, raw),
      request.generation,
    );
  }

  const index = request.generation - 1;
  const open = existing.entries[index];
  if (open === undefined || open.generation !== request.generation) {
    return launchFailure('GENERATION_NOT_OPEN', 'NOT_PRESENT', request.generation);
  }
  // Which prior state each mark may act on. `ESTABLISHED` is written only over a
  // freshly announced generation; `CONTAINED` may be written over either, because
  // the ordinary path now passes through `ESTABLISHED` on its way there and a
  // launch whose establishment could not be published still has to be
  // confirmable from `PENDING`.
  if (open.state === 'CONTAINED' || (target === 'ESTABLISHED' && open.state !== 'PENDING')) {
    return launchFailure(
      'GENERATION_NOT_OPEN',
      open.state === 'CONTAINED' ? 'ALREADY_CONFIRMED' : 'ALREADY_ESTABLISHED',
      request.generation,
    );
  }
  if (open.writerId !== request.writerId) {
    return launchFailure('GENERATION_NOT_OPEN', 'ANOTHER_WRITER', request.generation);
  }
  // One kernel-confirmed launch proves one launch. The digest is the launch's
  // identity — `core/internal/containment-attestation.ts` derives it per launch —
  // so a digest already standing in this history is an attestation being replayed.
  //
  // Every entry **except this generation's own** is examined, and both
  // containment-bearing states count. Excluding the entry at `index` is what
  // lets one real launch carry its single digest from `ESTABLISHED` to
  // `CONTAINED`; it is not a hole, because the check below then requires that
  // the confirmation is carrying the *same* digest rather than an arbitrary one.
  if (
    existing.entries.some(
      (entry, at) =>
        at !== index && entry.state !== 'PENDING' && entry.launchDigest === facts.launchDigest,
    )
  ) {
    return launchFailure('ATTESTATION_ALREADY_USED', 'DIGEST_ALREADY_PROVED', request.generation);
  }
  // Confirming an established generation must be the same launch confirming
  // itself. Without this, an attestation for launch B could confirm generation
  // A — leaving an entry whose recorded pids belong to B and whose `CONTAINED`
  // state claims A ended. The exclusion above is what makes this check
  // load-bearing rather than implied.
  if (open.state === 'ESTABLISHED' && open.launchDigest !== facts.launchDigest) {
    return launchFailure('ATTESTATION_ALREADY_USED', 'DIGEST_NOT_THIS_LAUNCH', request.generation);
  }

  let stampedAt: string;
  try {
    stampedAt = request.now();
  } catch {
    return launchFailure('LEDGER_NOT_READABLE_BACK', 'CLOCK_REFUSED', request.generation);
  }

  const common = {
    generation: open.generation,
    writerId: open.writerId,
    openedAt: open.openedAt,
    helperPid: facts.helperPid,
    childPid: facts.childPid,
    mode: facts.mode,
    verifiedInJob: true as const,
    assignedAtCreation: facts.assignedAtCreation,
    launchDigest: facts.launchDigest,
    attestedAt: facts.attestedAt,
  };
  const entries = [...existing.entries];
  entries[index] =
    target === 'ESTABLISHED'
      ? { ...common, state: 'ESTABLISHED', establishedAt: stampedAt }
      : { ...common, state: 'CONTAINED', confirmedAt: stampedAt };

  const payload: WriterLaunchLedgerPayload = {
    ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION,
    ownerPid: document.ownerPid,
    runId: document.runId,
    historyComplete: existing.historyComplete,
    entries,
    // Carried through untouched, for the reason `beginWriterLaunch` gives: a
    // writer-history write is not an owned-launch event, and a payload that
    // dropped the register would erase the record of every owned subprocess
    // still open.
    open: existing.open,
    nextSlot: existing.nextSlot,
  };
  const bytes = ledgerBytesFor(document, payload);

  // Read back through the reader, and then check the one entry this call is
  // about. The reading alone is not enough: a history with an earlier unproven
  // generation still reads `LAUNCH_UNPROVEN` whether or not *this* generation
  // was confirmed, so the assertion has to name the entry.
  const back = ledgerReadBack(bytes);
  const rebuilt = extendableWriterLaunchLedger(subject, back);
  if (rebuilt === null || rebuilt.entries[index]?.state !== target) {
    return launchFailure('LEDGER_NOT_READABLE_BACK', 'NOT_AS_BUILT', request.generation);
  }

  const published = publishCompanionRecord(ledgerPathFor(location), bytes, () =>
    stillHeldBy(location, holder),
  );
  if (published === 'NOT_OWNER') {
    return launchFailure('NOT_OWNER', 'LOST_BEFORE_PUBLISH', request.generation);
  }
  return published === null
    ? Object.freeze({
        code: target === 'ESTABLISHED' ? ('ESTABLISHED' as const) : ('CONFIRMED' as const),
        detail: null,
        generation: request.generation,
      })
    : launchFailure('LEDGER_WRITE_FAILED', published, request.generation);
}

/* ────────────────────── the owned-launch register ───────────────────────── */

/**
 * What became of an attempt to announce, establish or settle an owned launch.
 *
 * A closed set. Its own vocabulary rather than {@link WRITER_LAUNCH_CODES},
 * although several members share a spelling, because the two records answer
 * different questions and a caller that could pass one result where the other
 * belongs would be one refactor away from reading `OPENED` as `ANNOUNCED`.
 * Where a member has a twin next door it means exactly what the twin means.
 */
export const OWNED_LAUNCH_CODES = [
  /** The slot is on disk as `ANNOUNCED`. The launch may proceed. */
  'ANNOUNCED',
  /** The slot is on disk as `ESTABLISHED`: the kernel confirmed job membership. */
  'ESTABLISHED',
  /** The slot is gone from the register. Nothing of this launch is open. */
  'SETTLED',
  /**
   * There was no such open slot, so the postcondition already holds.
   *
   * A success, and the one that is easy to misread. It does not mean a launch
   * was lost; it means the register does not claim this launch is open — which
   * is what a settlement is for. Reached when an announcement was discarded, or
   * when a settlement runs twice.
   */
  'ALREADY_SETTLED',
  /**
   * The announcement could not be published, so the whole document was
   * **removed** instead. The launch may proceed; this lease can never be
   * recovered.
   *
   * The same escape hatch {@link HISTORY_DISCARDED} is, reached for the same
   * hazard: what is on disk would otherwise be a document that reads as a
   * complete account while a launch happens that it does not mention.
   */
  'REGISTER_DISCARDED',
  /**
   * Neither the announcement nor the removal was possible. **Productive work
   * must not go on.**
   *
   * The twin of {@link LAUNCH_MUST_NOT_START} next door, and the only condition
   * under which this register refuses a launch. `doctor/exec.ts` turns it into a
   * `SPAWN_FAILED` result and nothing is started.
   */
  'LAUNCH_MUST_NOT_START',
  /** The lease artefact was not minted evidence. Nothing was written. */
  'EVIDENCE_INVALID',
  /** The containment artefact was not minted. Nothing was written. */
  'ATTESTATION_INVALID',
  /** The evidence names a different repository's lease than the record does. */
  'LEASE_FOR_ANOTHER_REPOSITORY',
  /** No lease path can be derived, or nothing is at the one derived. */
  'LEASE_ABSENT',
  /** Something is at the lease path and could not be read. */
  'LEASE_UNREADABLE',
  /** What is there is not this holder's lease — or is not a lease at all. */
  'NOT_OWNER',
  /**
   * Whether this holder still owns the lease could not be confirmed, so nothing
   * was written and nothing was removed.
   *
   * Its own code rather than a shade of {@link NOT_OWNER}, and the distinction
   * is the one an adversarial review found this format collapsing. `NOT_OWNER`
   * is a *proved* mismatch: a lease document was read and its nonce is somebody
   * else's, so this run's epoch has no document left that could license a
   * recovery. This one comes from `stillHeldBy`, which answers `false` for a
   * mismatch **and** for any failure to read the file at all — a share
   * violation, `EMFILE` under a loaded gate, a scanner holding the handle for a
   * moment. In that second case the licensing document is still there, so
   * treating the two the same would let one failed read leave a launch
   * unrecorded beside a document that still reads as a proof.
   */
  'OWNERSHIP_UNCONFIRMED',
  /** The containment was coupled to a process other than the lease's owner. */
  'OWNER_MISMATCH',
  /**
   * The slot named is not open in the register on disk, or is not in the state
   * this call requires.
   *
   * A refusal rather than a repair, for the reason `GENERATION_NOT_OPEN` is: the
   * entry *is* the record of a launch, and a call that invented one would
   * establish a launch nobody announced.
   */
  'SLOT_NOT_OPEN',
  /**
   * This attestation already proves another open slot of this lease.
   *
   * One kernel-confirmed launch proves one launch. Replaying an attestation
   * across two open slots would put one launch's pids on both, and the second
   * launch's real processes would then be named nowhere — a live process the
   * predicate cannot see.
   *
   * The guard is complete over the **open** set and cannot be complete over a
   * settled one, because a settled slot leaves nothing behind to compare
   * against. That is a stated bound rather than a hidden one: it is the same
   * bound the binding digest has, and it is not reachable from production,
   * where `doctor/exec.ts` holds one slot and one attestation in one closure.
   */
  'ATTESTATION_ALREADY_USED',
  /** The document this build built is one this build would not accept back. */
  'REGISTER_NOT_READABLE_BACK',
  /**
   * The document could not be written, and what is on disk is unchanged.
   *
   * Answered by the establishment and the settlement, never by the
   * announcement: a failed announcement has a launch about to happen and must
   * therefore reach {@link REGISTER_DISCARDED} or {@link LAUNCH_MUST_NOT_START}.
   *
   * Leaving the slot where it already was is the conservative end state in both
   * cases, and the direction is the opposite of the writer ledger's. There, a
   * mark left standing by a launch that is over reads as a **proof** and is a
   * lie, which is why that path carries a withdrawal and stops the run when it
   * fails. Here a slot left standing reads as *open*, and open is a **refusal**:
   * a recovery probes the processes it names, permits only if they are gone, and
   * over-refuses if they cannot be probed. There is no leftover in this format
   * that permits anything, which is why nothing here stops a run.
   */
  'REGISTER_WRITE_FAILED',
] as const;

export type OwnedLaunchCode = (typeof OWNED_LAUNCH_CODES)[number];

export interface OwnedLaunchResult {
  readonly code: OwnedLaunchCode;
  /** An errno token or a short reason, never free text from anywhere else. */
  readonly detail: string | null;
  /**
   * The slot this call is about, or `null` when none was reached.
   *
   * Present on `ANNOUNCED` so the caller can name it back, and deliberately not
   * re-derived later: "the last slot" read a second time is a different
   * question from "the slot I announced", and the difference is a settlement
   * that removes somebody else's launch.
   */
  readonly slot: number | null;
}

function ownedFailure(
  code: OwnedLaunchCode,
  detail: string | null = null,
  slot: number | null = null,
): OwnedLaunchResult {
  return Object.freeze({ code, detail, slot });
}

/** The register vocabulary's answer to each refusal of the shared lease gate. */
function ownedFailureFor(failure: HeldLeaseFailure): OwnedLaunchResult {
  switch (failure) {
    case 'EVIDENCE_INVALID':
      return ownedFailure('EVIDENCE_INVALID');
    case 'LEASE_FOR_ANOTHER_REPOSITORY':
      return ownedFailure('LEASE_FOR_ANOTHER_REPOSITORY');
    case 'LEASE_ABSENT':
      return ownedFailure('LEASE_ABSENT');
    case 'LEASE_UNREADABLE':
      return ownedFailure('LEASE_UNREADABLE');
    case 'NOT_OWNER_UNPARSEABLE':
      return ownedFailure('NOT_OWNER', 'UNPARSEABLE');
    case 'NOT_OWNER':
      return ownedFailure('NOT_OWNER');
  }
}

/**
 * Removes this lease's launch document, so that nothing on disk asserts
 * anything about the owned launch about to happen.
 *
 * The register's use of the same destructive fallback the writer ledger has,
 * reported in this vocabulary. One caller: an announcement that could not be
 * published. It is emphatically **not** reached by a settlement — see
 * {@link REGISTER_WRITE_FAILED} for why a slot left open costs nothing and
 * discarding to tidy it up would trade a harmless refusal for a permanent one.
 */
function discardForOwnedLaunch(
  location: LeaseLocation,
  holder: ExecutionLeaseEvidence,
  reason: string,
): OwnedLaunchResult {
  if (!stillHeldBy(location, holder)) {
    return ownedFailure('OWNERSHIP_UNCONFIRMED', 'LOST_BEFORE_DISCARD');
  }
  try {
    unlinkSync(ledgerPathFor(location));
  } catch (error) {
    const errno = safeErrnoCode(error);
    if (errno !== 'ENOENT') return ownedFailure('LAUNCH_MUST_NOT_START', errno);
  }
  return ownedFailure('REGISTER_DISCARDED', reason);
}

/**
 * Builds the document with a replaced register and publishes it. Never throws.
 *
 * The one writer of the register, so the read-back rule, the ownership re-check
 * and the publish live in one place rather than three copies that can drift.
 * `expected` is what this build must read back out of its own bytes — stated by
 * the caller rather than inferred, so a payload that read as something else is a
 * refusal instead of a file.
 */
function publishRegister(
  location: LeaseLocation,
  document: ExecutionLease,
  holder: ExecutionLeaseEvidence,
  existing: WriterLaunchLedger,
  open: readonly OpenOwnedLaunch[],
  nextSlot: number,
  expected: OwnedLaunchReading,
  expectSlot: { readonly slot: number; readonly state: OpenOwnedLaunch['state'] | 'ABSENT' },
): { readonly published: true } | OwnedLaunchResult {
  const subject = subjectOf(document);
  const bytes = ledgerBytesFor(document, {
    ledgerVersion: WRITER_LAUNCH_LEDGER_VERSION,
    ownerPid: document.ownerPid,
    runId: document.runId,
    historyComplete: existing.historyComplete,
    // Carried through untouched: an owned-launch event is not a writer event,
    // and this is the mirror of the carry the writer paths make in the other
    // direction.
    entries: existing.entries,
    open: [...open],
    nextSlot,
  });

  // Read back through the reader itself, before anything is written. The clock
  // is a caller-supplied seam, so a `now` returning something the contract
  // refuses is enough to build a document that would be refused for the rest of
  // this lease's life; this is what stops it reaching a file.
  const back = ledgerReadBack(bytes);
  if (readOwnedLaunchRegister(subject, back) !== expected) {
    return ownedFailure('REGISTER_NOT_READABLE_BACK', 'NOT_AS_BUILT');
  }
  // The reading alone is not enough, and this is the assertion that carries the
  // weight. A register with any announced slot in it reads `OWNED_LAUNCH_UNPROVEN`
  // whether or not *this* slot reached the state this call is writing, so the
  // check has to name the entry — the same correction `recordLaunchContainment`
  // already carries for the writer ledger, and the same defect: without it,
  // establishing one slot while another was announced was refused outright,
  // which a test caught before this line existed.
  const parsed = WriterLaunchLedgerSchema.safeParse(back);
  const written = parsed.success
    ? parsed.data.open.find((entry) => entry.slot === expectSlot.slot)
    : undefined;
  if ((written?.state ?? 'ABSENT') !== expectSlot.state) {
    return ownedFailure('REGISTER_NOT_READABLE_BACK', 'SLOT_NOT_AS_BUILT');
  }
  // And the writer history must survive the write untouched. Asserted rather
  // than assumed: this function rewrites the whole document, so a defect here
  // would silently weaken the *other* record, and the reading is the thing every
  // recovery asks first.
  if (readWriterLaunchLedger(subject, back) !== readWriterLaunchLedger(subject, existing)) {
    return ownedFailure('REGISTER_NOT_READABLE_BACK', 'HISTORY_DISTURBED');
  }

  // Not flushed to the platter, and {@link writeInto} carries the measurement
  // and the four losses that choice admits. In short: this is written twice per
  // spawn rather than a handful of times per run, `fsyncSync` costs 73 ms on
  // this repository's volume against 6.5 ms without it, and the only event that
  // can lose an unflushed write is a power cut — which killed the launch the
  // record was about.
  const published = publishCompanionRecord(
    ledgerPathFor(location),
    bytes,
    () => stillHeldBy(location, holder),
    false,
  );
  if (published === null) return { published: true };
  if (published === 'NOT_OWNER') {
    return ownedFailure('OWNERSHIP_UNCONFIRMED', 'LOST_BEFORE_PUBLISH');
  }
  return ownedFailure('REGISTER_WRITE_FAILED', published);
}

/**
 * The parsed launch document, when it is one this build may write a register
 * into. `null` otherwise.
 *
 * `extendableWriterLaunchLedger` asks the same question for the writer history
 * and answers it for four readings; this asks it for the register and answers it
 * for the same four, because it is the same document. Kept as its own call
 * rather than reused directly so the two questions cannot silently become one.
 */
function registerDocument(
  subject: WriterLaunchSubject,
  raw: unknown,
): WriterLaunchLedger | null {
  return extendableWriterLaunchLedger(subject, raw);
}

/**
 * Announces an AO-owned subprocess launch under this lease, **before** it
 * happens.
 *
 * ── Why the order cannot be the other way round ────────────────────────────
 *
 * The record that matters for a recovery is the one describing a launch that
 * was interrupted. A record written after a launch cannot describe one that
 * never got that far; a mark written before it can. So the slot goes down as
 * `ANNOUNCED` first, the launch happens only once that is on disk, and
 * everything that can go wrong afterwards — a lost boundary, a killed
 * orchestrator, an unpublishable establishment — leaves the mark exactly where
 * it is.
 *
 * That is what makes {@link LAUNCH_MUST_NOT_START} necessary rather than fussy.
 * If this call cannot change what is on disk, the document there is one that
 * accounts for every owned launch **except** the one about to happen. It gets
 * one fallback — delete the document, which asserts nothing — and if that fails
 * too the launch is refused.
 *
 * ── What it does with a document it cannot use ─────────────────────────────
 *
 * Nothing, and that is not the writer path's answer. `beginWriterLaunch`
 * rebuilds an unusable history from empty as permanently incomplete, because a
 * writer launch has to be recorded somewhere even when the history is broken.
 * Here the same rebuild would *create* a register that claims to account for
 * this epoch's owned launches while knowing nothing about the ones before it —
 * and a fresh empty register is the licensing value. So an unusable document is
 * a refusal: {@link REGISTER_DISCARDED} if it can be removed, and the removal is
 * what makes the lease honestly unrecoverable rather than falsely quiescent.
 *
 * Never throws.
 */
export function announceOwnedLaunch(
  given: LeaseRepository,
  evidence: unknown,
  request: { readonly now: () => string },
): OwnedLaunchResult {
  const held = heldLeaseFor(snapshotRepositoryRecord(given), evidence);
  if (!isHeldLease(held)) return ownedFailureFor(held);
  const { location, document, evidence: holder } = held;

  if (request === null || typeof request !== 'object' || typeof request.now !== 'function') {
    return ownedFailure('REGISTER_NOT_READABLE_BACK', 'CLOCK_NOT_SUPPLIED');
  }
  // The clock is a caller-supplied function, so calling it is calling somebody
  // else's code, and this module's "never throws" is relied on by not catching.
  let openedAt: string;
  try {
    openedAt = request.now();
  } catch {
    return ownedFailure('REGISTER_NOT_READABLE_BACK', 'CLOCK_REFUSED');
  }

  const subject = subjectOf(document);
  const existing = registerDocument(subject, readLedgerRecord(location));
  if (existing === null) return discardForOwnedLaunch(location, holder, 'REGISTER_UNUSABLE');

  // A register that cannot grow may not be left standing either: it would be a
  // document that accounts for owned launches and stops mentioning them, which
  // is the one shape this path exists to prevent.
  if (existing.open.length >= MAX_OPEN_OWNED_LAUNCHES) {
    return discardForOwnedLaunch(location, holder, 'REGISTER_FULL');
  }

  const slot = existing.nextSlot;
  const published = publishRegister(
    location,
    document,
    holder,
    existing,
    [...existing.open, { slot, state: 'ANNOUNCED', openedAt }],
    slot + 1,
    // Stated rather than merely "not refused": a freshly announced slot is
    // unproven by construction whatever else is open, so a build of this payload
    // that read as a proof would be the format failing in the one direction that
    // matters.
    'OWNED_LAUNCH_UNPROVEN',
    { slot, state: 'ANNOUNCED' },
  );
  if ('published' in published) {
    return Object.freeze({ code: 'ANNOUNCED' as const, detail: null, slot });
  }
  // A publish that failed with a launch about to happen. `NOT_OWNER` is not a
  // reason to discard: the document on disk is the **new** holder's, and this
  // call has no standing to delete it.
  if (published.code === 'NOT_OWNER') return published;
  return discardForOwnedLaunch(location, holder, published.detail ?? published.code);
}

/**
 * Records that the kernel placed this owned launch in the owner's job, while it
 * is still running.
 *
 * Without it, the whole of an owned subprocess's runtime is on disk as
 * `ANNOUNCED`, which proves nothing — and for a verification command that is up
 * to thirty minutes. This is the mark that makes the interrupted case
 * recoverable instead of permanently refused, exactly as
 * `attestWriterLaunchEstablished` is for the writer.
 *
 * It writes `ESTABLISHED` and never anything stronger. There is no `CONTAINED`
 * state in this register, and its absence is the design rather than an omission:
 * a launch that was seen to end has its slot **removed**, so "ended" is spelled
 * by the entry not being there.
 *
 * A failure to publish leaves the slot `ANNOUNCED`, which refuses. Never throws.
 */
export function attestOwnedLaunchEstablished(
  given: LeaseRepository,
  evidence: unknown,
  attestation: unknown,
  request: { readonly slot: number; readonly now: () => string },
): OwnedLaunchResult {
  const held = heldLeaseFor(snapshotRepositoryRecord(given), evidence);
  if (!isHeldLease(held)) return ownedFailureFor(held);
  const { location, document, evidence: holder } = held;

  if (
    request === null ||
    typeof request !== 'object' ||
    !Number.isSafeInteger(request.slot) ||
    request.slot < 1 ||
    typeof request.now !== 'function'
  ) {
    return ownedFailure('REGISTER_NOT_READABLE_BACK', 'SLOT_NOT_NAMED');
  }

  const facts = containmentFactsOf(attestation);
  if (facts === null) return ownedFailure('ATTESTATION_INVALID', null, request.slot);
  // The containment must be coupled to *this lease's* owner. A record proving a
  // launch of some other process would be a claim about a tree this lease never
  // started.
  if (facts.ownerPid !== document.ownerPid) {
    return ownedFailure('OWNER_MISMATCH', null, request.slot);
  }

  let establishedAt: string;
  try {
    establishedAt = request.now();
  } catch {
    return ownedFailure('REGISTER_NOT_READABLE_BACK', 'CLOCK_REFUSED', request.slot);
  }

  const subject = subjectOf(document);
  const existing = registerDocument(subject, readLedgerRecord(location));
  if (existing === null) return ownedFailure('SLOT_NOT_OPEN', 'REGISTER_UNUSABLE', request.slot);

  const index = existing.open.findIndex((entry) => entry.slot === request.slot);
  const target = index < 0 ? undefined : existing.open[index];
  // `ANNOUNCED` only. A slot already `ESTABLISHED` is not established twice —
  // that would let a second attestation overwrite the pids of the first, which
  // is the same hazard as the replay guard below reached from the other side.
  if (target === undefined || target.state !== 'ANNOUNCED') {
    return ownedFailure('SLOT_NOT_OPEN', target?.state ?? 'ABSENT', request.slot);
  }
  if (
    existing.open.some(
      (entry) => entry.state === 'ESTABLISHED' && entry.launchDigest === facts.launchDigest,
    )
  ) {
    return ownedFailure('ATTESTATION_ALREADY_USED', null, request.slot);
  }

  const open = [...existing.open];
  open[index] = {
    slot: target.slot,
    state: 'ESTABLISHED',
    openedAt: target.openedAt,
    helperPid: facts.helperPid,
    childPid: facts.childPid,
    mode: facts.mode,
    verifiedInJob: true as const,
    assignedAtCreation: facts.assignedAtCreation,
    launchDigest: facts.launchDigest,
    attestedAt: facts.attestedAt,
    establishedAt,
  };

  const published = publishRegister(
    location,
    document,
    holder,
    existing,
    open,
    existing.nextSlot,
    // Computed from the set this call built, never asserted as a constant. A
    // register holding a second, still-announced slot reads `OWNED_LAUNCH_UNPROVEN`
    // however well this one was established, and a constant here refused exactly
    // that document.
    readOpenSet(open),
    { slot: request.slot, state: 'ESTABLISHED' },
  );
  return 'published' in published
    ? Object.freeze({ code: 'ESTABLISHED' as const, detail: null, slot: request.slot })
    : Object.freeze({ ...published, slot: request.slot });
}

/**
 * Records that an owned launch was seen to end, by removing its slot.
 *
 * ── Removal is the whole point, and it is why this record is affordable ────
 *
 * Every productive owned spawn under a lease is announced here — the commit's
 * `git add`, every `rev-parse`, every verification phase, the reviewer — which
 * is tens of launches per step. An append-only entry for each would rewrite a
 * document that grows without bound. A removed one leaves a register whose size
 * is how many launches are open at once, which in this build is one.
 *
 * ── What the removal claims, and what it does not ──────────────────────────
 *
 * It claims the launch **ended**: the owned-command adapter settles on the helper's
 * close, and the helper holds the only handle to a job carrying
 * `KILL_ON_JOB_CLOSE` with neither breakaway flag, so the kernel has destroyed
 * everything in it, grandchildren included. That inference is a contract of the
 * job flags — `native/ao-launch/AoLaunch.cs` — and not of this function.
 *
 * On a platform with no boundary the ending is the child's exit and nothing
 * more, so a removal there claims less than it does here. The shipped CLI
 * refuses to run anywhere but `win32` (`platform/runtime-support.ts`), so no
 * product path reaches that case; a library caller on POSIX does, and this
 * sentence is what it is owed.
 *
 * A failure to publish leaves the slot where it is, which refuses or
 * over-refuses and never permits. Nothing is discarded and no run is stopped.
 * Never throws.
 */
export function settleOwnedLaunch(
  given: LeaseRepository,
  evidence: unknown,
  request: { readonly slot: number },
): OwnedLaunchResult {
  const held = heldLeaseFor(snapshotRepositoryRecord(given), evidence);
  if (!isHeldLease(held)) return ownedFailureFor(held);
  const { location, document, evidence: holder } = held;

  if (
    request === null ||
    typeof request !== 'object' ||
    !Number.isSafeInteger(request.slot) ||
    request.slot < 1
  ) {
    return ownedFailure('REGISTER_NOT_READABLE_BACK', 'SLOT_NOT_NAMED');
  }

  const subject = subjectOf(document);
  const existing = registerDocument(subject, readLedgerRecord(location));
  // Nothing this build can write a register into asserts that this launch is
  // open, so the postcondition holds. Not a discard: there is no launch pending
  // on this answer, and destroying a document to tidy up a slot that is not
  // there would cost the lease its recoverability for nothing.
  if (existing === null) return ownedFailure('ALREADY_SETTLED', 'REGISTER_UNUSABLE', request.slot);

  const open = existing.open.filter((entry) => entry.slot !== request.slot);
  if (open.length === existing.open.length) {
    return ownedFailure('ALREADY_SETTLED', 'NOT_OPEN', request.slot);
  }

  // `nextSlot` is carried, never recomputed. A counter derived from the open set
  // would fall back the moment the set emptied, and the reused slot would let a
  // late settlement remove a live launch's record.
  const published = publishRegister(
    location,
    document,
    holder,
    existing,
    open,
    existing.nextSlot,
    readOpenSet(open),
    { slot: request.slot, state: 'ABSENT' },
  );
  return 'published' in published
    ? Object.freeze({ code: 'SETTLED' as const, detail: null, slot: request.slot })
    : Object.freeze({ ...published, slot: request.slot });
}

/**
 * Reads a lease's owned-launch register without changing anything. Never
 * throws.
 *
 * Exists for reporting — `lease status` prints it — and it is deliberately not
 * how {@link recoverStaleLease} obtains its own reading, for the reason
 * {@link inspectWriterLaunchHistory} gives.
 */
export function inspectOwnedLaunchRegister(given: LeaseRepository): OwnedLaunchReading | null {
  const repository = snapshotRepositoryRecord(given);
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) return null;
  const read = readLeaseFile(location.path, location.key);
  if (read.document === null) return null;
  return readOwnedLaunchRegister(subjectOf(read.document), readLedgerRecord(location));
}

/**
 * Reads a lease's launch history without changing anything. Never throws.
 *
 * Exists for reporting — `lease status` prints it — and it is deliberately not
 * how {@link recoverStaleLease} obtains its own reading. A recovery reads the
 * history inside the same call that removes the lease; a report may be minutes
 * old by the time anybody acts on it, and this module has already paid once for
 * a judgement made at one moment and carried to a later effect.
 */
export function inspectWriterLaunchHistory(given: LeaseRepository): WriterLaunchReading | null {
  const repository = snapshotRepositoryRecord(given);
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) return null;
  const read = readLeaseFile(location.path, location.key);
  if (read.document === null) return null;
  return readWriterLaunchLedger(subjectOf(read.document), readLedgerRecord(location));
}

/* ─────────────────────── safe stale-lease recovery ──────────────────────── */

/**
 * Why a stale lease may not be recovered. A closed set, and **every** member is
 * a refusal: there is no member of this union that means "go ahead".
 *
 * That shape is on purpose. `LeaseRecoveryClassification` next door is a
 * *description* of what is at a path, and one of its members happens to be the
 * one a removal wants; this is a list of reasons to stop, so a caller cannot
 * read a description as a permission. The permission is the absence of a member,
 * which is one value and cannot be spelled two ways.
 */
export const STALE_RECOVERY_REFUSALS = [
  /** Nothing is at the lease path. There is no lease to recover. */
  'NOTHING_TO_RECOVER',
  /** A process with the recorded owner's id exists. */
  'OWNER_RUNNING',
  /**
   * Whether the owner exists could not be established.
   *
   * Refused rather than retried, and this is the liveness rule this module keeps
   * everywhere: a probe **may refuse and may never permit**. An unknown answer is
   * an unknown answer.
   */
  'OWNER_LIVENESS_UNDETERMINED',
  /**
   * Something is at the lease path and this build cannot parse it as a lease.
   *
   * Includes the zero-byte crash artefact, which is exactly the case the twice
   * withdrawn `lease break` most wanted and could not have. See
   * {@link recoverStaleLease} for why this slice refuses it rather than trying
   * again: an unparseable lease has no nonce, so the removal has no identity to
   * bind to, and it has no launch history to prove anything with either.
   */
  'LEASE_UNPARSEABLE',
  /** Something is there and could not be read at all. */
  'LEASE_UNREADABLE',
  /** No lease path can be derived for this repository. */
  'LOCATION_UNSUITABLE',
  /** The Git common directory is on a UNC/network path, which V2 does not support. */
  'LOCATION_NETWORK_UNSUPPORTED',
  /** The Git common directory is a Windows device path. */
  'LOCATION_DEVICE_NAMESPACE',
  /**
   * There is no launch history beside the lease.
   *
   * The reading every lease taken before this slice produces, and the one that
   * makes "no legacy lease is retroactively safe" true by construction rather
   * than by a version check somebody has to remember to write.
   */
  'LAUNCH_HISTORY_ABSENT',
  /** The history did not begin with its lease, so it can be missing launches. */
  'LAUNCH_HISTORY_INCOMPLETE',
  /** At least one writer launch under this lease is not proven contained. */
  'LAUNCH_HISTORY_UNPROVEN',
  /**
   * A launch proved contained and never seen to end still has a
   * process of its recorded tree in existence.
   *
   * Its own refusal rather than a shade of {@link OWNER_RUNNING}, because it
   * names a different process and sends an operator somewhere else: the owner is
   * gone and something it started is not. The `ESTABLISHED` state records the
   * helper and the child precisely so this can be asked, and this is the answer
   * that says asking was worth it.
   *
   * Note which direction pid reuse pushes this. A recycled pid now belonging to
   * an unrelated process reads `ALIVE` and lands here — an over-refusal, and the
   * only kind of error this comparison can make. The dangerous reading would be
   * a live process whose pid reads `NOT_FOUND`, and that cannot happen: a
   * running process's pid is by definition in use.
   */
  'LAUNCH_TREE_STILL_RUNNING',
  /**
   * Whether a recorded launch's tree still exists could not be established.
   *
   * The same rule the owner probe follows one conjunct up — liveness may refuse
   * and may never permit — applied to the processes an unended launch names.
   */
  'LAUNCH_TREE_LIVENESS_UNDETERMINED',
  /** The history was written by a build this one does not understand. */
  'LAUNCH_HISTORY_UNSUPPORTED_VERSION',
  /** Something is there and is not a history this build declares. */
  'LAUNCH_HISTORY_MALFORMED',
  /** The history is bound to a different lease. */
  'LAUNCH_HISTORY_NOT_THIS_LEASE',
  /** The history describes a different run or a different owner. */
  'LAUNCH_HISTORY_NOT_THIS_RUN',
  /**
   * An AO-owned subprocess of this lease was announced and never reached the
   * point where the kernel confirmed it had been placed in the owner's job.
   *
   * The register's counterpart to {@link LAUNCH_HISTORY_UNPROVEN}, and its own
   * member rather than a reuse of it because the two send an operator to
   * different places: that one is about the productive writer, this one is
   * about a verification command, a reviewer pass, a Git subprocess or anything
   * else this run started through the owned boundary. Nothing at all can be
   * said about the process, so nothing is removed.
   */
  'OWNED_LAUNCH_UNPROVEN',
  /**
   * An AO-owned subprocess of this lease was placed in the owner's job, was
   * never seen to end, and a process bearing one of the ids it recorded exists
   * right now.
   *
   * The refusal this slice exists for. Before it, a lease whose *writer* history
   * read `ALL_LAUNCHES_CONTAINED` reached `SAFE_TO_RECOVER` having probed
   * exactly one process — the owner — while a verification or reviewer
   * subprocess of the same epoch was represented nowhere. Reproduced on `main`
   * at `fba4cfd` with the shipped CLI, which removed the lease.
   *
   * Its own member rather than a shade of {@link LAUNCH_TREE_STILL_RUNNING},
   * which names a *writer* tree: the two send an operator to different
   * processes, and one report that could mean either would be a report that
   * names neither.
   *
   * Pid reuse pushes this the same way it pushes its writer twin. A recycled pid
   * now belonging to an unrelated process reads `ALIVE` and lands here — an
   * over-refusal, and the only kind of error this comparison can make.
   */
  'OWNED_LAUNCH_STILL_RUNNING',
  /**
   * Whether the processes of an open owned launch still exist could not be
   * established.
   *
   * The same rule every liveness answer in this module follows — a probe may
   * refuse and may never permit — applied to the processes an open register
   * entry names.
   */
  'OWNED_LAUNCH_LIVENESS_UNDETERMINED',
] as const;

export type StaleRecoveryRefusal = (typeof STALE_RECOVERY_REFUSALS)[number];

/**
 * The refusal to report for a launch history that is not a proof.
 *
 * Total over {@link WriterLaunchReading}, including the one reading that *is* a
 * proof. That arm is unreachable while `provesEveryLaunchContained` is the thing
 * that decides — which it is, at the one call site below — and it answers the
 * conservative refusal rather than throwing, so a future loosening of that table
 * degrades the *reason* an operator is shown and never the *decision*.
 */
function refusalForHistory(reading: WriterLaunchReading): StaleRecoveryRefusal {
  switch (reading) {
    case 'ALL_LAUNCHES_CONTAINED':
    // Both licensing readings answer the conservative refusal here, and for the
    // same reason: this function is reached only when the caller has *already*
    // decided the reading is not a proof, so an arm that named something
    // reassuring would be describing a decision that was not made.
    case 'LAUNCHES_CONTAINED_SOME_UNENDED':
    case 'LAUNCH_UNPROVEN':
      return 'LAUNCH_HISTORY_UNPROVEN';
    case 'HISTORY_INCOMPLETE':
      return 'LAUNCH_HISTORY_INCOMPLETE';
    case 'ABSENT':
      return 'LAUNCH_HISTORY_ABSENT';
    case 'UNSUPPORTED_VERSION':
      return 'LAUNCH_HISTORY_UNSUPPORTED_VERSION';
    case 'MALFORMED':
      return 'LAUNCH_HISTORY_MALFORMED';
    case 'NOT_THIS_LEASE':
      return 'LAUNCH_HISTORY_NOT_THIS_LEASE';
    case 'NOT_THIS_RUN':
      return 'LAUNCH_HISTORY_NOT_THIS_RUN';
  }
}

/**
 * The refusal to report for an owned-launch register that is not a proof.
 *
 * Total over {@link OwnedLaunchReading}, including the one reading that *is* a
 * proof and the one that owes a liveness check. Both of those arms are
 * unreachable while `provesNoOwnedLaunchOpen` and
 * `provesOwnedLaunchesOpenUnended` are what decide — which they are, at the one
 * call site — and they answer the conservative refusal rather than throwing, so
 * a future loosening of those tables degrades the *reason* an operator is shown
 * and never the *decision*.
 *
 * A table rather than a switch, so a reading added to `OWNED_LAUNCH_READINGS`
 * without a row here fails to compile. Every row is asserted by value in
 * `tests/m2-02-owned-launch-quiescence.test.ts`; completeness is not
 * correctness.
 */
const REFUSAL_FOR_REGISTER: Readonly<Record<OwnedLaunchReading, StaleRecoveryRefusal>> =
  Object.freeze({
    // Both reached only when the caller has already decided the reading is not
    // the proof it needs, so an arm naming something reassuring would be
    // describing a decision that was not made.
    NO_OWNED_LAUNCH_OPEN: 'OWNED_LAUNCH_UNPROVEN',
    OWNED_LAUNCHES_OPEN_UNENDED: 'OWNED_LAUNCH_UNPROVEN',
    OWNED_LAUNCH_UNPROVEN: 'OWNED_LAUNCH_UNPROVEN',
    // No member of its own, deliberately. A register this build cannot read
    // beside a writer history it *can* is not a document any code here
    // produces — the two are fields of one record, sealed by one binding and
    // published in one atomic write, so the reading that reaches this row is
    // unreachable from the predicate. A member nothing can produce is a
    // vocabulary entry no fixture can pin, which is how an arm stops being
    // checked at all; `LAUNCH_TREE_LIVENESS_UNDETERMINED` next door already
    // records that argument for its own unreachable floor.
    //
    // The undetermined refusal is also the truthful word for it: nothing was
    // named, so nothing could be established.
    REGISTER_NOT_READABLE: 'OWNED_LAUNCH_LIVENESS_UNDETERMINED',
  });

export interface StaleLeaseRecoveryAssessment {
  /** `SAFE_TO_RECOVER` exactly when `refusal` is `null`. Never otherwise. */
  readonly verdict: 'SAFE_TO_RECOVER' | 'UNSAFE';
  readonly refusal: StaleRecoveryRefusal | null;
  /** The path examined, or the empty string when none could be derived. */
  readonly path: string;
  /** The owner named by the lease, when one was parsed. */
  readonly ownerPid: number | null;
  /** The run the lease was taken for, when one was parsed. */
  readonly runId: string | null;
  /** The launch history's reading, or `null` when no lease document was read. */
  readonly launchHistory: WriterLaunchReading | null;
  /**
   * The owned-launch register's reading, or `null` when the predicate stopped
   * before reading it.
   *
   * `null` is common and is not a shade of "empty". The conjuncts run in order
   * and each stops at the first refusal, so a lease with a living owner, or one
   * whose writer history is unreadable, never reaches the register at all — and
   * reporting an absent reading as a reading would tell an operator that the
   * subprocess question was asked and answered when it was not asked.
   */
  readonly ownedLaunches: OwnedLaunchReading | null;
}

/** The assessment, plus the two facts that identify the object it is about. */
interface BoundAssessment extends StaleLeaseRecoveryAssessment {
  /** Digest of the exact bytes read. `null` unless the verdict is safe. */
  readonly revision: string | null;
  /** The nonce inside those bytes. `null` unless the verdict is safe. */
  readonly ownerNonce: string | null;
}

function unsafe(
  refusal: StaleRecoveryRefusal,
  over: Partial<StaleLeaseRecoveryAssessment> = {},
): BoundAssessment {
  return Object.freeze({
    verdict: 'UNSAFE' as const,
    refusal,
    path: '',
    ownerPid: null,
    runId: null,
    launchHistory: null,
    ownedLaunches: null,
    revision: null,
    ownerNonce: null,
    ...over,
  });
}

/** One refusal per location failure. Total by type. */
const RECOVERY_REFUSAL_FOR_LOCATION: Readonly<Record<LeaseLocationFailureCode, StaleRecoveryRefusal>> =
  Object.freeze({
    LEASE_LOCATION_UNSUITABLE: 'LOCATION_UNSUITABLE',
    LEASE_LOCATION_NETWORK_UNSUPPORTED: 'LOCATION_NETWORK_UNSUPPORTED',
    LEASE_LOCATION_DEVICE_NAMESPACE: 'LOCATION_DEVICE_NAMESPACE',
  });

/**
 * The safety predicate, evaluated against what is on disk right now.
 *
 * ── The contract, stated once ──────────────────────────────────────────────
 *
 *     SAFE_TO_RECOVER
 *     iff  a lease document is at this repository's lease path
 *     and  the process it names does not exist
 *     and  the launch history beside it is complete, bound to this exact lease,
 *          and about this exact owner and run
 *     and  either every launch in it is proven contained **and observed to end**
 *          or   every launch in it was placed in the owner's job by the kernel
 *               and every process the unended ones name — helper
 *               and child alike — is observed not to exist, now, by this call's
 *               own probe
 *
 * Anything else — including anything unknown, unreadable, from another build, or
 * merely undecidable — is a refusal. There is no default arm and no "probably".
 *
 * ── What each conjunct is doing, since none of them is redundant ───────────
 *
 * The dead owner alone proves nothing, and `execution-lease.ts`'s header records
 * the measurement: on this platform the agent tree died with the orchestrator
 * only because everything sat in a Job Object *somebody else* created. That is a
 * platform observation, not a guarantee, and it is not this build's to assert.
 *
 * The launch history alone proves nothing either: a complete, all-contained
 * history beside a **living** owner describes a run that is working perfectly.
 *
 * Together they say the one thing a removal needs: every writer tree that ever
 * existed under this lease was created inside a Job Object coupled to the owner,
 * every one of them was observed to end, and the owner is gone.
 *
 * ── And the extra proof the second arm needs and the first does not ─────────
 *
 * The `ESTABLISHED` arm is missing exactly one of those: no ending was observed.
 * It could be closed by inheritance — a helper dies when its owner does, so the
 * job goes, so the tree goes — and it deliberately is not, because that first
 * step is a *measurement* and not a contract. `boundary/start-owned-process.ts`
 * says so in as many words, and `native/ao-launch/AoLaunch.cs` says the watcher
 * "normally wins" while nothing enforces it. Building a removal on a step
 * described that way would be exactly the reasoning this module's header refuses.
 *
 * So the arm asks instead. The helper is probed directly, at the removal, with
 * the real probe: gone means it has closed the only handle to a job carrying
 * `KILL_ON_JOB_CLOSE` and neither breakaway flag, and the kernel has destroyed
 * everything inside it. That inference is a contract — it is what the job flags
 * *are* — and it does not pass through the owner at all.
 *
 * ── And it still is not authority ──────────────────────────────────────────
 *
 * `containment != authority`. What this licenses is removing a **dead object**,
 * never writing to the repository. The caller that recovers a lease holds
 * nothing afterwards and must go through {@link acquireRepositoryExecutionLease}
 * like anybody else.
 */
export function assessStaleLeaseRecovery(
  given: LeaseRepository,
  deps: { readonly processAlive?: ProcessLivenessProbe } = {},
): StaleLeaseRecoveryAssessment {
  const { revision: _revision, ownerNonce: _nonce, ...report } = assessStaleLeaseRecoveryBound(
    snapshotRepositoryRecord(given),
    deps.processAlive ?? osProcessLiveness,
  );
  return Object.freeze(report);
}

/**
 * The same predicate, keeping the two facts that identify the object.
 *
 * Not exported, and that is the point. `revision` and `ownerNonce` are what the
 * removal binds to, and an exported reader of exactly the values a destructive
 * step rests on is the affordance that step leaves behind — the argument
 * {@link removeVerifiedLease} already makes about the object identity the
 * withdrawn break used. A caller cannot obtain them, cannot hold them, and
 * therefore cannot act on a stale pair.
 */
function assessStaleLeaseRecoveryBound(
  repository: LeaseRepository,
  liveness: ProcessLivenessProbe,
): BoundAssessment {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) return unsafe(RECOVERY_REFUSAL_FOR_LOCATION[location.code]);

  // One read of the bytes, for the identity and the document alike. The two must
  // not be two readings of one file — the divergence this module exists to
  // prevent, and here it would mean removing an object the decision was not
  // about.
  const read = readLeaseFile(location.path, location.key);
  if (read.state === 'FREE') return unsafe('NOTHING_TO_RECOVER', { path: location.path });
  if (read.state === 'UNREADABLE') return unsafe('LEASE_UNREADABLE', { path: location.path });
  if (read.document === null || read.bytes === null) {
    // `UNPARSEABLE`, which includes the zero-byte crash artefact and a lease
    // document belonging to another clone. Neither has a nonce, so neither can
    // be named to a removal, and neither has a history to prove anything with.
    return unsafe('LEASE_UNPARSEABLE', {
      path: location.path,
      ownerPid: legibleOwnerPid(read.bytes),
    });
  }
  const document = read.document;
  const facts = {
    path: location.path,
    ownerPid: document.ownerPid,
    runId: document.runId,
  };

  const observed = liveness(document.ownerPid);
  if (observed === 'ALIVE') return unsafe('OWNER_RUNNING', facts);
  if (observed === 'UNDETERMINED') return unsafe('OWNER_LIVENESS_UNDETERMINED', facts);

  // The history is read *after* the liveness answer and from the same location,
  // so a report about a running owner never goes looking for one. The reading is
  // the whole of the second conjunct.
  const subject = subjectOf(document);
  const ledgerRecord = readLedgerRecord(location);
  const history = readWriterLaunchLedger(subject, ledgerRecord);
  if (!provesEveryLaunchContained(history)) {
    // ── The extra proof, and it exists for one reading only ───────────────
    //
    // `LAUNCHES_CONTAINED_SOME_UNENDED` says every launch was placed in the
    // owner's job by the kernel and at least one was never seen to end. That is
    // strictly weaker than `ALL_LAUNCHES_CONTAINED`, so it buys the removal
    // nothing on its own and is not routed through the predicate above — it owes
    // the missing half here, freshly, against the same probe the owner was
    // judged with and inside the same call that removes.
    //
    // What is owed is *not* the owner→helper coupling. `start-owned-process.ts`
    // is explicit that a helper dying with its owner is measured rather than
    // guaranteed, so this asks the helper directly instead of inheriting that
    // measurement: a helper that is gone has closed the only handle to a job
    // carrying `KILL_ON_JOB_CLOSE` and neither breakaway flag, and the kernel
    // has therefore destroyed everything in it, grandchildren included. A helper
    // that is *not* gone refuses, whatever the owner did.
    if (!provesEveryLaunchContainedUnended(history)) {
      return unsafe(refusalForHistory(history), { ...facts, launchHistory: history });
    }
    // The SAME bytes the reading was taken from, not a second read of the file.
    // That is what makes the guard below a floor rather than a live branch: both
    // calls run `readWriterLaunchLedger` over one value, so they cannot disagree,
    // and the reading that got here requires an `ESTABLISHED` entry — which is
    // exactly what this returns. Re-reading the file instead would make the two
    // answers questions about different moments, which is the divergence this
    // module exists to refuse.
    const unended = unendedLaunchesOf(subject, ledgerRecord);
    // So `null` or empty is unreachable while that holds, and it is a **refusal**
    // rather than a throw so that a future change which breaks the determinism
    // above degrades the *reason* and never the decision. Two mutants that make
    // this arm permit survive the suite for that reason, and they are recorded as
    // an unreachable floor rather than as coverage.
    //
    // It answers the undetermined refusal rather than a member of its own, and
    // that is the truthful word for it: nothing was named, so nothing could be
    // established. A member nothing can produce would be a vocabulary entry no
    // fixture could pin, which is how an arm stops being checked at all.
    if (unended === null || unended.length === 0) {
      return unsafe('LAUNCH_TREE_LIVENESS_UNDETERMINED', { ...facts, launchHistory: history });
    }
    for (const launch of unended) {
      // The helper first: it is the load-bearing one, because it owns the job.
      // The child is asked too rather than trusted to the same inference — it is
      // the process that was actually writing, and a build that got the job
      // coupling wrong would still be caught by its own pid being alive.
      for (const pid of [launch.helperPid, launch.childPid]) {
        const seen = liveness(pid);
        if (seen === 'ALIVE') {
          return unsafe('LAUNCH_TREE_STILL_RUNNING', { ...facts, launchHistory: history });
        }
        if (seen !== 'NOT_FOUND') {
          return unsafe('LAUNCH_TREE_LIVENESS_UNDETERMINED', {
            ...facts,
            launchHistory: history,
          });
        }
      }
    }
  }

  // ── The third conjunct: every OTHER owned subprocess of this epoch ────────
  //
  // The writer history above answers one question — "can an unproven *writer*
  // launch still exist under this lease" — and M2 slice 2 was opened because
  // that is not the question a removal needs answered. A run starts a
  // verification, a reviewer and a stream of Git subprocesses through the same
  // owned boundary, all of them after the writer has ended, and until this
  // conjunct existed none of them was represented anywhere. Reproduced on
  // `main` at `fba4cfd`: a real writer confirmed `CONTAINED`, a real
  // verification subprocess started through the production path, the owner
  // killed, and `agent-loop lease recover` removed the lease having probed the
  // owner and nothing else.
  //
  // ── Why it is here and not first ──────────────────────────────────────────
  //
  // Because the writer conjunct's refusals must keep firing where they already
  // fire. `LAUNCH_HISTORY_ABSENT`, `LAUNCH_HISTORY_UNPROVEN` and the rest are
  // what an operator is shown for a lease from an older build, for a launch
  // killed before the kernel answered, and for a writer whose mark was
  // withdrawn — and a new conjunct placed above them would answer for all three,
  // making those refusals unreachable and their gates vacuous. Ordering is the
  // difference between adding a proof and replacing one.
  //
  // ── And it is a separate reading of the same bytes ────────────────────────
  //
  // `ledgerRecord` is read once, above, and both readings are taken from that
  // one value. Two reads of the file would be two questions about two moments,
  // which is the divergence this module exists to refuse.
  const register = readOwnedLaunchRegister(subject, ledgerRecord);
  if (!provesNoOwnedLaunchOpen(register)) {
    if (!provesOwnedLaunchesOpenUnended(register)) {
      return unsafe(REFUSAL_FOR_REGISTER[register], { ...facts, launchHistory: history, ownedLaunches: register });
    }
    const open = openOwnedProcessesOf(subject, ledgerRecord);
    // `null` or empty is unreachable while the reading and this function agree —
    // both run over the one value above, and the reading that gets here requires
    // an `ESTABLISHED` entry, which is exactly what this returns. It is a
    // **refusal** rather than a throw so that a future change which breaks that
    // determinism degrades the reason and never the decision.
    if (open === null || open.length === 0) {
      return unsafe('OWNED_LAUNCH_LIVENESS_UNDETERMINED', { ...facts, launchHistory: history, ownedLaunches: register });
    }
    for (const launch of open) {
      // The helper first, and the child too, for the reasons the writer loop one
      // conjunct up gives. The real probe answers both: a supplied opinion can
      // only make the answer worse, because `recoverStaleLease` combines the two
      // with `mostRefusing` rather than substituting one for the other.
      for (const pid of [launch.helperPid, launch.childPid]) {
        const seen = liveness(pid);
        if (seen === 'ALIVE') {
          return unsafe('OWNED_LAUNCH_STILL_RUNNING', { ...facts, launchHistory: history, ownedLaunches: register });
        }
        if (seen !== 'NOT_FOUND') {
          return unsafe('OWNED_LAUNCH_LIVENESS_UNDETERMINED', {
            ...facts,
            launchHistory: history,
            ownedLaunches: register,
          });
        }
      }
    }
  }

  return Object.freeze({
    verdict: 'SAFE_TO_RECOVER' as const,
    refusal: null,
    ...facts,
    launchHistory: history,
    ownedLaunches: register,
    revision: revisionOfBytes(read.bytes),
    ownerNonce: document.ownerNonce,
  });
}

/**
 * What became of an attempt to recover a stale lease. A closed set of **five**.
 *
 * This said "four" while the array below had five members. Counted rather than
 * restated.
 */
export const STALE_LEASE_RECOVERY_CODES = [
  /** The stale lease is gone. Nothing is held; acquisition is now possible. */
  'RECOVERED',
  /** The predicate refused. Nothing was touched. `refusal` says which conjunct. */
  'RECOVERY_UNSAFE',
  /**
   * The lease at the path was not the one the predicate accepted, and whatever
   * was there is **still there**. Nothing was removed and nothing was moved.
   *
   * The abort this contract requires: a lease that changes hands between the
   * assessment and the removal takes the recovery with it. It is not an error
   * anybody has to fix — usually the repository has a live owner again, which is
   * the outcome the operator wanted the recovery to make possible. `detail`
   * separates "somebody else's lease is there" from "nothing is there".
   *
   * It deliberately does **not** cover the two end states in which a record was
   * detached and could not be put back; see {@link LEASE_DISPLACED}. Those were
   * folded in here at first, under a sentence saying nothing had been moved and
   * that this call had not looked at who holds the name — both false for them,
   * and both false in the direction that leaves an operator unaware of a
   * displaced writer and a file inside `.git`. That is the same "one code for two
   * end states" defect {@link VerifiedRemoval} split its own members apart for,
   * reintroduced by the one caller that acts on a lease it never held.
   */
  'LEASE_CHANGED',
  /**
   * Something that was **not** this call's to remove was detached from the lease
   * name and could not be put back. It is kept, never deleted.
   *
   * A writer that acquired inside the window between the assessment and the
   * detach is *displaced*: its record is in a `.breaking-…` file in the Git
   * directory, and the lease name is now either free or held by somebody else
   * again. `detail` says which, because those send an operator to opposite
   * actions — `removeVerifiedLease` records at length why that distinction is
   * kept rather than collapsed.
   *
   * Nothing was destroyed. The repository nevertheless needs looking at before
   * anything runs against it, which is why this is not {@link LEASE_CHANGED}.
   */
  'LEASE_DISPLACED',
  /**
   * The removal could not be completed. `detail` names the end state.
   *
   * Kept apart from {@link LEASE_CHANGED} because they leave the repository in
   * different conditions and send an operator to different places — the same
   * discrimination {@link VerifiedRemoval} draws between its own nine members,
   * for the same reason.
   */
  'RECOVERY_FAILED',
] as const;

export type StaleLeaseRecoveryCode = (typeof STALE_LEASE_RECOVERY_CODES)[number];

export interface StaleLeaseRecoveryResult {
  readonly code: StaleLeaseRecoveryCode;
  /** The refusal, when the predicate refused. `null` for every other code. */
  readonly refusal: StaleRecoveryRefusal | null;
  /** A removal end state or a short token. Never free text, never a path. */
  readonly detail: string | null;
  /** The assessment this call made, for a report. Never supplied by a caller. */
  readonly assessment: StaleLeaseRecoveryAssessment;
}

/**
 * What {@link recoverStaleLease} accepts, which is deliberately not a probe.
 *
 * ── The hole this shape closes, which was shipped and measured ─────────────
 *
 * The first version of this took `{ processAlive?: ProcessLivenessProbe }`, the
 * same seam the *reporting* paths take, and a review reproduced the consequence
 * in one call: `recoverStaleLease(repository, { processAlive: () => 'NOT_FOUND' })`
 * removed the lease of a process that was demonstrably alive — the caller's own —
 * leaving the repository free for a competing acquirer while its writer ran. The
 * liveness answer *is* the first conjunct of the safety predicate, so handing it
 * to the caller of a destructive function handed them the predicate.
 *
 * It was also the exact rule this module states everywhere else, broken by the
 * one function that could least afford it: **a probe may refuse and may never
 * permit**. On `acquire` and on the reporting paths a substituted probe can only
 * ever add a refusal, so the seam is safe there and stays. Here it could permit.
 *
 * ── So the answer is combined, not replaced ────────────────────────────────
 *
 * `osProcessLiveness` is always consulted and cannot be substituted.
 * {@link additionalLiveness} is asked as well, and the **more refusing** of the
 * two answers wins — `ALIVE` beats `UNDETERMINED` beats `NOT_FOUND`. So a
 * supplied opinion can stop a recovery and can never cause one, which is the
 * rule made structural rather than restated.
 *
 * That is what "there is no override" means for this command: no argument here,
 * and no argument anywhere, can make a lease removable that the operating system
 * does not agree is ownerless.
 */
export interface StaleRecoveryDependencies {
  /**
   * A second liveness opinion, which may only ever **refuse**.
   *
   * Its answer is combined with the operating system's, not substituted for it,
   * and the refusing answer wins. A caller that answers `NOT_FOUND` for a
   * running process changes nothing; one that answers `ALIVE` for a dead one
   * stops the recovery.
   *
   * It exists so a caller with a stronger source of "this run is still going" —
   * a job-object handle, a supervisor's own record — can contribute it without
   * being handed the predicate. Nothing in this build supplies one.
   */
  readonly additionalLiveness?: ProcessLivenessProbe;
}

/** How refusing each answer is. Higher wins when two opinions are combined. */
const LIVENESS_REFUSAL: Readonly<Record<ProcessLiveness, number>> = Object.freeze({
  ALIVE: 2,
  UNDETERMINED: 1,
  NOT_FOUND: 0,
});

/** The more refusing of two liveness answers. Total by type. */
function mostRefusing(observed: ProcessLiveness, claimed: ProcessLiveness): ProcessLiveness {
  return LIVENESS_REFUSAL[claimed] > LIVENESS_REFUSAL[observed] ? claimed : observed;
}

/**
 * A supplied opinion, or the answer that contributes nothing.
 *
 * `NOT_FOUND` is the neutral element of {@link mostRefusing}, so an absent seam
 * and a seam that agrees are the same thing. A probe that throws, or that returns
 * something outside the union, answers `UNDETERMINED` — a refusal, because
 * calling somebody else's code is the one line here that can misbehave and the
 * safe direction for a misbehaving one is to stop.
 */
function opinionOf(probe: ProcessLivenessProbe | undefined, pid: number): ProcessLiveness {
  if (probe === undefined) return 'NOT_FOUND';
  let answer: unknown;
  try {
    answer = probe(pid);
  } catch {
    return 'UNDETERMINED';
  }
  return answer === 'ALIVE' || answer === 'UNDETERMINED' || answer === 'NOT_FOUND'
    ? answer
    : 'UNDETERMINED';
}

/**
 * Removes a stale lease, and only one this call has just proved removable.
 *
 * ── Why this can be written when `lease break` could not ───────────────────
 *
 * The break was withdrawn twice, and `lease-recovery.ts` gives the reason: for
 * the artefact that most needed recovering — the zero-byte crash file — every
 * fact that could name *one object* collapsed at once. Its digest is
 * `sha256("")`, which every empty file shares; it records no owner, so the
 * liveness cross-check compared `null` with `null`; and the filesystem's
 * `(dev,ino)` was the only thing left, on a module that then shipped fallbacks
 * for filesystems reusing those. A sixth review reproduced the consequence: an
 * authorisation minted for artefact A removed a **legitimately acquired** lease B
 * that had taken the same name.
 *
 * This is not that operation with a better predicate. It is a different
 * operation, and two structural differences carry it:
 *
 *  - **it can only ever act on a lease it parsed.** The predicate requires a
 *    readable lease document with a launch history bound to it, so the object is
 *    named by 32 random bytes of `ownerNonce` inside its own record. The
 *    zero-byte artefact — the case that defeated the break — is refused as
 *    {@link LEASE_UNPARSEABLE} and stays refused. This slice recovers the case
 *    it can prove and declines the case it cannot, rather than trying to cover
 *    both with one authorisation;
 *  - **there is no window for an operator to sit in.** The break minted an
 *    authorisation, showed it to a human, and acted on it later. Here the
 *    assessment and the removal are one synchronous call: nothing is displayed,
 *    nothing is typed back, and no caller can supply a verdict — the parameter
 *    does not exist. The one parameter that does exist,
 *    {@link StaleRecoveryDependencies.additionalLiveness}, may only *refuse*;
 *    it took a review to notice that its predecessor could permit.
 *
 * ── The removal binds to the object, not to the name ───────────────────────
 *
 * {@link removeVerifiedLease} detaches whatever is at the name into a private
 * name and then decides on *that object*, and the predicate handed to it here
 * requires both the exact bytes and the nonce inside them. A successor that
 * acquired in the window between the assessment and the detach cannot match
 * either — its nonce is 32 fresh random bytes — so it is put back and this call
 * answers {@link LEASE_CHANGED}. When the
 * put-back itself fails — `link` is not always available on the object being
 * restored — the successor's record is *kept* in a quarantine file rather than
 * deleted, and the answer is {@link LEASE_DISPLACED} instead. "Put back" is what
 * happens; it is not what is guaranteed, and this sentence used to say only the
 * first half.
 *
 * Both halves are stated because they fail differently. The revision is the
 * whole-file identity; the nonce is the identity that survives somebody deciding
 * a whitespace-insensitive comparison would be friendlier. Requiring both means
 * neither can be relaxed alone.
 *
 * ── The companions are deliberately left where they are ────────────────────
 *
 * Once the lease name is free this call owns nothing in that directory, and a
 * successor may already have acquired. Deleting the launch history or the
 * containment record *after* the removal would therefore be an unowned write
 * aimed at a name somebody else may now be using — the exact defect class this
 * module records against its own past. They are safe to leave: the acquisition
 * that follows replaces the history outright, and every companion belonging to a
 * dead lease is refused by its own binding for any other.
 *
 * ── What this does not do ──────────────────────────────────────────────────
 *
 * It does not acquire. It does not retry. It does not restart anything. A caller
 * that wants the repository back calls
 * {@link acquireRepositoryExecutionLease} afterwards, through the ordinary path,
 * and takes its authority from the exclusive create like every other holder —
 * because containment proves process lifetime and never writer authority.
 *
 * Never throws.
 */
export function recoverStaleLease(
  given: LeaseRepository,
  deps: StaleRecoveryDependencies = {},
): StaleLeaseRecoveryResult {
  const repository = snapshotRepositoryRecord(given);

  // Taken here, immediately before the removal, and taken by this call rather
  // than accepted from one. An assessment is a statement about one moment; the
  // whole history of this module is judgements made at one moment and carried to
  // a later effect, and a `verdict` parameter would be that defect with a type
  // signature.
  const assessed = assessStaleLeaseRecoveryBound(repository, (pid) =>
    mostRefusing(osProcessLiveness(pid), opinionOf(deps.additionalLiveness, pid)),
  );
  const { revision, ownerNonce, ...report } = assessed;
  const assessment = Object.freeze(report);
  if (assessed.verdict !== 'SAFE_TO_RECOVER' || revision === null || ownerNonce === null) {
    return Object.freeze({
      code: 'RECOVERY_UNSAFE' as const,
      refusal: assessed.refusal,
      detail: null,
      assessment,
    });
  }

  const removal = removeVerifiedLease(
    assessment.path,
    (bytes) => revisionOfBytes(bytes) === revision && nonceOfBytes(bytes) === ownerNonce,
  );
  // The detail is the removal member itself, always, so the code an operator
  // reads and the end state it came from can never disagree.
  return Object.freeze({
    code: staleRecoveryOutcomeFor(removal),
    refusal: null,
    detail: removal,
    assessment,
  });
}

/**
 * Which outcome each removal end state is reported as.
 *
 * ── Why this is a table and not the `switch` it replaced ───────────────────
 *
 * Because the `switch` could not be tested. The two members this table sends to
 * {@link LEASE_DISPLACED} — a *readable* record detached and not put back — need
 * a **failed restore**, which `putBack` reaches either from an `EEXIST` on the
 * restoring `link` (somebody squatted the freed name) or from the exclusive
 * create it falls back to failing as well.
 *
 * Four of the nine need a failed restore, not two: the other pair are
 * `UNIDENTIFIABLE_QUARANTINED` and `UNIDENTIFIABLE_AND_UNOWNED`, where the
 * detached bytes could not be read either. Named rather than written
 * `UNIDENTIFIABLE_*`, because the glob reads as "the UNIDENTIFIABLE ones" and
 * plain `UNIDENTIFIABLE` is *not* one of them — it restores successfully — which
 * would make the count three and falsify the sentence it sits in, in a paragraph
 * whose whole subject is a count disagreeing with its description.
 *
 * For that pair `putBack` never reaches its fallback: with `bytes` null it
 * returns from the `link`'s own `EEXIST`, or from `occupancyOf(leasePath)`, before
 * the exclusive create is attempted. They answer {@link RECOVERY_FAILED}, because
 * there the removal genuinely did not complete.
 *
 * (This paragraph said "two … the ones where a record was detached and could not
 * be put back", which is a count and a description that disagree — the defect
 * {@link VerifiedRemoval}'s own docstring records against this file. Correcting
 * the count then left the mechanism clause claiming both a refused `link` *and* a
 * refused exclusive create were needed, which is false for two of the four and
 * contradicted the very test this paragraph cites.) `tests/v2-07lr-remediation.test.ts`
 * produces them by squatting the freed name *from inside the predicate*, and
 * this function's predicate is not a caller's to hook. So no case can reach
 * those two arms through `recoverStaleLease`, and a review demonstrated the
 * consequence: collapsing them back into {@link LEASE_CHANGED} left every test
 * green while an operator was told nothing had been moved about a state in which
 * a writer is displaced and a file is sitting in `.git`.
 *
 * A total table is testable where the arms are not. It is total by type, so a
 * tenth `VerifiedRemoval` member stops the build here rather than falling into a
 * default — and completeness is not correctness, so **every row is asserted by
 * value** in `tests/v3-05-stale-lease-recovery.test.ts`. That is the whole point:
 * the mapping is pinned even where the state behind it cannot be produced.
 */
const RECOVERY_OUTCOME_FOR: Readonly<Record<VerifiedRemoval, StaleLeaseRecoveryCode>> =
  Object.freeze({
    /** The one member that means this call removed the lease. */
    REMOVED: 'RECOVERED',
    // Nothing of this call's doing, and nothing moved: `CHANGED` was detached and
    // put back, `ABSENT` was never there.
    ABSENT: 'LEASE_CHANGED',
    CHANGED: 'LEASE_CHANGED',
    // A record was detached, could not be put back, and is kept in a quarantine
    // file — so a writer is displaced and there is a file inside `.git`. Reported
    // apart from `LEASE_CHANGED` because its sentence says the opposite of both.
    CHANGED_QUARANTINED: 'LEASE_DISPLACED',
    CHANGED_AND_UNOWNED: 'LEASE_DISPLACED',
    // The removal could not be completed. `detail` names which of the four.
    DETACH_FAILED: 'RECOVERY_FAILED',
    UNIDENTIFIABLE: 'RECOVERY_FAILED',
    UNIDENTIFIABLE_QUARANTINED: 'RECOVERY_FAILED',
    UNIDENTIFIABLE_AND_UNOWNED: 'RECOVERY_FAILED',
  });

/**
 * The outcome one removal end state is reported as.
 *
 * Exported for the test that asserts every row by value, and it authorises
 * nothing: it is a pure translation between two closed vocabularies, takes no
 * repository and touches no file.
 */
export function staleRecoveryOutcomeFor(removal: VerifiedRemoval): StaleLeaseRecoveryCode {
  return RECOVERY_OUTCOME_FOR[removal];
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

  // ── The accountant goes only once the lease really has ───────────────────
  //
  // After the removal and only on the one outcome that means it succeeded, and
  // this ordering is a repair rather than a preference. Disposing first — which
  // is what this did — hands the lease back to nobody on every arm above: the
  // removal can be refused, and then the lease document and its register are
  // still on disk, still licensing, and this process has no accountant left to
  // announce the subprocesses it goes on starting. That is the same shape as
  // the `EPOCH_ENDED` defect {@link ANNOUNCEMENT_DISPOSITION} records, reached
  // from the other end.
  //
  // Disposing after opens no window worth the name. Between the removal and
  // this line an announcement finds no lease, answers `LEASE_ABSENT`, and the
  // accountant evicts itself — the same end state by a slower route.
  ACCOUNTANT_DISPOSERS.get(evidence)?.();
  ACCOUNTANT_DISPOSERS.delete(evidence);
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
