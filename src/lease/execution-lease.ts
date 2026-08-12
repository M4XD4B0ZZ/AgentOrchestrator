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
 * This module also ships **no way to clear one** other than its owner releasing
 * it. An attended break existed and was withdrawn after three adversarial review
 * rounds each found a fresh way for it to destroy an authority somebody had
 * legitimately acquired; `cli/lease-command.ts` records what each attempt got
 * wrong. Recovery from a crash is a manual operator step that `lease status`
 * spells out and that is explicitly outside what this build guarantees, and a
 * supported flow for it is its own slice. Automatic recovery additionally needs
 * owned process containment — necessarily before unattended running.
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
  repository: LeaseRepository,
  request: ExecutionLeaseRequest,
  deps: ExecutionLeaseDependencies,
): LeaseAcquireResult {
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
    // successor's authority. Removed only if what is there is unreadable — which
    // is what a failed write leaves — or is still this claim's own record.
    removeVerifiedLease(location.path, (present) => {
      const nonce = nonceOfBytes(present);
      return nonce === null || nonce === ourNonce;
    });
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
 * `rename` within a directory atomically detaches whatever is at the name into a
 * name only this call knows. From that instant the decision is about an *object*
 * this call owns, and **the lease name is never touched again except through
 * `link`**, which cannot overwrite. If the detached bytes are the ones that were
 * verified they are deleted; if they are not, they are linked back — and an
 * `EEXIST` there means somebody acquired the freed name, which is a real
 * authority and is left alone.
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
 *    because the only operation aimed at the name is a `link` that refuses to
 *    clobber;
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

  // From here the lease name is **never touched again except through `link`**,
  // which cannot overwrite. That single rule is what this function got wrong
  // twice, and it is worth stating as a rule rather than as four correct lines.
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
  } catch {
    // Detached and unreadable. Identifying it is impossible, so it is neither
    // removed nor claimed to have been: the restore below puts it back.
  }

  if (bytes !== null && matches(bytes)) {
    discard(quarantine);
    return 'REMOVED';
  }

  // Not ours to remove — put it back. `link` and never `rename`: if somebody
  // acquired the freed name in the meantime, that acquisition is a real
  // authority and stands, and `EEXIST` is the answer that says so.
  try {
    linkSync(quarantine, leasePath);
  } catch {
    // Either somebody holds the name (`EEXIST`) or the filesystem refuses to
    // link. Both leave the detached file where it is, deliberately: deleting it
    // would be destroying a record this call has just decided it may not
    // remove, and a stray file inside the administrative directory is inert,
    // inspectable and recoverable. An earlier version discarded it here, which
    // turned a refusal into a deletion.
    return bytes === null ? 'FAILED' : 'CHANGED';
  }
  discard(quarantine);
  return bytes === null ? 'FAILED' : 'CHANGED';
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
  repository: LeaseRepository,
  evidence: unknown,
): LeaseVerifyResult {
  if (!isExecutionLeaseEvidence(evidence)) {
    return Object.freeze({ code: 'EVIDENCE_INVALID' as const });
  }

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
  // mean three things. `verifyExecutionLeaseHeld` deliberately applies neither
  // the size cap nor the location binding — it has no repository to bind to —
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
  if (removed === 'FAILED') {
    // `UNREADABLE_AFTER_DETACH` rather than `null`: an operator hitting this has
    // a file they cannot read where their lease was, and a code with no detail
    // at all was a regression against the version this replaced.
    return Object.freeze({ code: 'LEASE_REMOVE_FAILED' as const, detail: 'UNREADABLE_AFTER_DETACH' });
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
function legibleOwnerPid(bytes: Buffer | null): number | null {
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
