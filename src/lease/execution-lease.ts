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
 * by the real-process race in `tests/dist-artifact/`, not by reasoning. Eight
 * processes reaching for one lease produced exactly one winner every time, and
 * *some of the losers saw the winner's file before its record was in it*. They
 * refused, correctly, and refused with the wrong word: `STALE_LEASE_RECOVERY_UNSAFE`
 * for a lease whose owner was running perfectly well. That is the one confusion
 * the two codes exist to prevent, and it points an operator straight at `lease
 * break` for a healthy run.
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
 * exactly where it is; clearing it is an operator's decision, made through
 * {@link breakRepositoryExecutionLease} with the lease they actually inspected
 * named back. Automatic recovery needs owned process containment first, and that
 * is a slice of its own — necessarily before unattended running.
 *
 * ── Liveness may refuse, and may never permit ──────────────────────────────
 *
 * {@link ProcessLivenessProbe} exists so an operator is told "somebody is
 * running — wait" rather than "a run died here — clear it", which are two
 * different places to go. It is never authority: pids are reused, so `ALIVE` can
 * be a stranger. That is safe in exactly one direction, and the direction is
 * enforced here — liveness can only ever *add* a refusal (acquire refuses
 * whatever it says; break refuses on `ALIVE` and on `UNDETERMINED`). No code
 * path anywhere permits an effect because a probe said a process is gone.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { comparePathIdentity } from '../core/path-identity.js';
import {
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
   * It cannot widen anything. A substitute that always succeeds still has to
   * have staged a real record first, and one that always fails only pushes the
   * claim onto the `wx` path, which is exclusive too.
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
  return Object.freeze({
    ok: true as const,
    path: join(key, EXECUTION_LEASE_FILE_NAME),
    key,
  });
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
   * operator names back to {@link breakRepositoryExecutionLease}, and a lease
   * that cannot be parsed is exactly the one that most needs an exit.
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
  repository: LeaseRepository,
  deps: { readonly processAlive?: ProcessLivenessProbe } = {},
): LeaseInspection {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) {
    return inspection({ state: 'LOCATION_UNSUITABLE', path: '' });
  }

  const read = readLeaseFile(location.path, location.key);
  const probe = deps.processAlive ?? osProcessLiveness;

  return inspection({
    state: read.state,
    path: location.path,
    revision: read.bytes === null ? null : revisionOfBytes(read.bytes),
    ownerPid: read.document?.ownerPid ?? null,
    runId: read.document?.runId ?? null,
    blockId: read.document?.blockId ?? null,
    acquiredAt: read.document?.acquiredAt ?? null,
    liveness: read.document === null ? 'UNKNOWABLE' : probe(read.document.ownerPid),
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
  /** The claim was made and the record could not be written. Nothing is held. */
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

function acquireFailure(
  code: LeaseAcquireFailureCode,
  detail: string | null = null,
): LeaseAcquireFailure {
  return Object.freeze({ ok: false as const, code, detail });
}

/**
 * Takes the repository's execution lease, or says exactly why it could not.
 *
 * Synchronous, and that is a property rather than an accident: the claim is one
 * uninterrupted sequence of filesystem calls with no `await` for anything to
 * interleave with. Never throws.
 */
export function acquireRepositoryExecutionLease(
  repository: LeaseRepository,
  request: ExecutionLeaseRequest,
  deps: ExecutionLeaseDependencies,
): LeaseAcquireResult {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) return acquireFailure('LEASE_LOCATION_UNSUITABLE');

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
  const claimed = claimLeaseFile(location, bytes, deps.link ?? linkSync);
  if (claimed.code === 'HELD_BY_ANOTHER') return refusalForExistingLease(location, deps);
  if (claimed.code !== 'CLAIMED') return acquireFailure('LEASE_WRITE_FAILED', claimed.detail);

  const evidence = mintExecutionLeaseEvidence(nonce, location.path);
  if (evidence === null) {
    // Not reachable: the nonce is 32 random bytes hex-encoded and the path is
    // absolute. A fail-closed floor rather than an assertion — and it gives the
    // lease back rather than holding one nobody can prove.
    try {
      unlinkSync(location.path);
    } catch {
      // As above.
    }
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
    return claimViaExclusiveCreate(location, bytes, errno);
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
    discard(location.path);
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

/** What became of a guarded removal. */
type VerifiedRemoval = 'REMOVED' | 'CHANGED' | 'ABSENT' | 'FAILED';

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
 * `rename` within a directory atomically detaches whatever is at the name. So
 * the file is detached first and *then* identified: if it is the one that was
 * verified, it is deleted; if it is not, it is put back with `link`, which
 * refuses to overwrite — so a third party that acquired in the meantime keeps
 * what it took.
 *
 * What remains is narrow and is a loss of *availability*, never of safety: a
 * lease detached and restored is briefly absent, and a holder checking in that
 * instant sees `LEASE_ABSENT` and stops. It stops — it does not carry on beside
 * a second writer, which is the failure this module exists to prevent. There is
 * no portable atomic compare-and-delete; this is the closest available, and the
 * difference from the previous shape is the difference between "somebody's run
 * stopped early" and "somebody's run kept going without authority".
 */
function removeVerifiedLease(
  leasePath: string,
  matches: (bytes: Buffer) => boolean,
): VerifiedRemoval {
  const quarantine = `${leasePath}.breaking-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`;

  try {
    renameSync(leasePath, quarantine);
  } catch (error) {
    return safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'FAILED';
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(quarantine);
  } catch {
    // Detached and unreadable. Putting back something that cannot be read would
    // restore a lease nobody can prove anything about, so it is dropped and
    // reported as a failure rather than as a removal.
    discard(quarantine);
    return 'FAILED';
  }

  if (matches(bytes)) {
    discard(quarantine);
    return 'REMOVED';
  }

  // Not ours to remove. `link` rather than `rename` on the way back, because it
  // refuses to overwrite: if somebody acquired the freed name in the meantime,
  // that acquisition stands and this restore must not clobber it.
  try {
    linkSync(quarantine, leasePath);
  } catch (error) {
    if (safeErrnoCode(error) !== 'EEXIST') {
      // A filesystem that will not link. Best effort, and the only case in
      // which a restore can overwrite a newer acquisition — narrower than the
      // window it is closing, and stated rather than hidden.
      try {
        renameSync(quarantine, leasePath);
      } catch {
        // Nothing further to try. The lease is gone; the next invocation
        // reports an absence rather than taking anything it should not.
      }
    }
  }
  discard(quarantine);
  return 'CHANGED';
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
] as const;

export type LeaseVerifyCode = (typeof LEASE_VERIFY_CODES)[number];

export interface LeaseVerifyResult {
  readonly code: LeaseVerifyCode;
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
export function verifyExecutionLeaseHeld(evidence: unknown): LeaseVerifyResult {
  if (!isExecutionLeaseEvidence(evidence)) return Object.freeze({ code: 'EVIDENCE_INVALID' as const });

  let bytes: Buffer;
  try {
    bytes = readFileSync(evidence.leasePath);
  } catch (error) {
    const errno = safeErrnoCode(error);
    return Object.freeze({ code: errno === 'ENOENT' ? ('LEASE_ABSENT' as const) : ('LEASE_UNREADABLE' as const) });
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
    code: evidence.matchesRecordedNonce(parsed.data.ownerNonce)
      ? ('HELD' as const)
      : ('NOT_OWNER' as const),
  });
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
  const removed = removeVerifiedLease(evidence.leasePath, (bytes) =>
    evidence.matchesRecordedNonce(nonceOfBytes(bytes)),
  );
  if (removed === 'ABSENT') return Object.freeze({ code: 'LEASE_ABSENT' as const, detail: null });
  if (removed === 'CHANGED') return Object.freeze({ code: 'NOT_OWNER' as const, detail: null });
  if (removed === 'FAILED') {
    return Object.freeze({ code: 'LEASE_REMOVE_FAILED' as const, detail: null });
  }
  return Object.freeze({ code: 'RELEASED' as const, detail: null });
}

/* ──────────────────────────── the attended break ────────────────────────── */

export const LEASE_BREAK_CODES = [
  /** The lease the operator named was removed. */
  'BROKEN',
  /** There is nothing to break. */
  'LEASE_ABSENT',
  /** The bytes on disk are not the ones the operator inspected. */
  'LEASE_CHANGED',
  /** The recorded owner is running. Nothing an operator asserts changes that. */
  'LEASE_OWNER_ALIVE',
  /** Whether the recorded owner is running could not be established. */
  'LEASE_OWNER_LIVENESS_UNDETERMINED',
  /** A readable lease names an owner, and the break did not name it back. */
  'OWNER_PID_REQUIRED',
  /** The break named an owner the lease does not record. */
  'OWNER_PID_MISMATCH',
  /** The break named an owner for a lease that records none. */
  'OWNER_PID_UNEXPECTED',
  /** Nothing could be read at the lease path. */
  'LEASE_UNREADABLE',
  /** No lease path can be derived for this repository. */
  'LEASE_LOCATION_UNSUITABLE',
  /** The removal itself failed. */
  'LEASE_REMOVE_FAILED',
] as const;

export type LeaseBreakCode = (typeof LEASE_BREAK_CODES)[number];

export interface LeaseBreakResult {
  readonly code: LeaseBreakCode;
  readonly detail: string | null;
}

export interface LeaseBreakRequest {
  /**
   * The digest the operator inspected. **Required**, and there is deliberately
   * no way to omit it.
   *
   * This is what makes a break an act on *the lease that was looked at* rather
   * than on whatever happens to be there now. Without it an operator who read a
   * report, went away to think, and came back would remove a lease a legitimate
   * new run had taken in the meantime.
   */
  readonly expectedRevision: string | null;
  /**
   * The owner the operator inspected, or `null` for a lease that records none.
   *
   * Required when the document is readable and forbidden when it is not — so the
   * operator has to have looked at the same thing this function is about, in
   * both directions.
   */
  readonly ownerPid: number | null;
}

/**
 * Removes a lease an operator has identified and taken responsibility for.
 *
 * **This module performs no attendance check**, exactly as `release-workspace.ts`
 * performs none: the operator grant is a property of an *invocation*, and the
 * CLI is what knows whether one was made. There is no `--force` anywhere above
 * it and nothing here reaches past its own gates.
 *
 * What the gates establish, in order: the bytes are the ones inspected; the
 * owner is the one inspected; and that owner cannot be shown to be running.
 * Only then is anything removed.
 *
 * ── The residual window, stated rather than papered over ───────────────────
 *
 * Between the read that establishes the revision and the `unlink` that acts on
 * it, a legitimate new owner could take the lease — and would then have it
 * removed. The window is a few syscalls wide, and reaching it requires the
 * operator's own premise ("nothing is running here") to have been false, which
 * the liveness gate has already refused on separately. Closing it entirely needs
 * an atomic compare-and-delete, which no portable filesystem primitive offers;
 * `state-store.ts` and `block-store.ts` name their own equivalent windows for
 * the same reason rather than implying they do not exist.
 */
export function breakRepositoryExecutionLease(
  repository: LeaseRepository,
  request: LeaseBreakRequest,
  deps: { readonly processAlive?: ProcessLivenessProbe } = {},
): LeaseBreakResult {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) return breakResult('LEASE_LOCATION_UNSUITABLE');

  const read = readLeaseFile(location.path, location.key);
  if (read.state === 'FREE') return breakResult('LEASE_ABSENT');
  if (read.bytes === null) return breakResult('LEASE_UNREADABLE');

  // 1. The bytes the operator inspected, and no others.
  if (request.expectedRevision === null || revisionOfBytes(read.bytes) !== request.expectedRevision) {
    return breakResult('LEASE_CHANGED');
  }

  if (read.document === null) {
    // 2a. An unreadable lease names no owner, so naming one is a claim about a
    // document the operator did not read. The observed bytes are the only
    // identification available, and they have already been given.
    if (request.ownerPid !== null) return breakResult('OWNER_PID_UNEXPECTED');
  } else {
    // 2b. A readable lease must be identified by its owner as well.
    if (request.ownerPid === null) return breakResult('OWNER_PID_REQUIRED');
    if (request.ownerPid !== read.document.ownerPid) return breakResult('OWNER_PID_MISMATCH');

    // 3. And that owner must not be running. Liveness refuses here; it never
    // permits — an operator cannot assert a process away.
    const probe = deps.processAlive ?? osProcessLiveness;
    const liveness = probe(read.document.ownerPid);
    if (liveness === 'ALIVE') return breakResult('LEASE_OWNER_ALIVE');
    if (liveness === 'UNDETERMINED') return breakResult('LEASE_OWNER_LIVENESS_UNDETERMINED');
  }

  // Every gate above was about bytes; this removes those bytes rather than that
  // name. Without the binding, the sequence "operator inspects a stale lease →
  // it is released → a new legitimate run acquires → the break unlinks" destroys
  // the new run's authority and reports success, with the liveness gate having
  // been satisfied by the *old* lease's dead owner. Reproduced, then closed.
  const removed = removeVerifiedLease(
    location.path,
    (bytes) => revisionOfBytes(bytes) === request.expectedRevision,
  );
  if (removed === 'ABSENT') return breakResult('LEASE_ABSENT');
  if (removed === 'CHANGED') return breakResult('LEASE_CHANGED');
  if (removed === 'FAILED') return breakResult('LEASE_REMOVE_FAILED');
  return breakResult('BROKEN');
}

/**
 * The nonce inside `bytes`, or `null` when they are not a lease.
 *
 * Parsed from the detached bytes rather than taken from an earlier reading, so
 * the ownership check and the removal are about the same file.
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

function breakResult(code: LeaseBreakCode, detail: string | null = null): LeaseBreakResult {
  return Object.freeze({ code, detail });
}
