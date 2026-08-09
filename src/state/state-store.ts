/**
 * Reading and writing the persisted runtime state of one task.
 *
 * ── Validate before persisting, validate after loading ─────────────────────
 *
 * `TaskStateSchema` is the binding contract, and it is applied on both sides of
 * the disk. On the way out, because a state that violates the contract must
 * never reach the filesystem: once written it would be loaded again after a
 * restart, and a self-contradictory state that survives a restart is
 * indistinguishable from a real one. On the way in, because a file is not a
 * value — anything may have edited it, an older build may have written it, and
 * a half-written file may have survived a crash on a filesystem that does not
 * order writes.
 *
 * ── Nothing here repairs anything ──────────────────────────────────────────
 *
 * {@link loadTaskState} performs no writes of any kind. A malformed, stale or
 * unsupported state file is *reported* with a typed code and left exactly as it
 * was found — not migrated, not truncated, not renamed aside, not deleted.
 *
 * That is a deliberate refusal, not an omission. Every repair is a guess about
 * what the previous run meant, made at the one moment when the evidence for it
 * is weakest, and it destroys the only copy of that evidence in the process. An
 * orchestrator that quietly rewrites a state it could not understand is an
 * orchestrator that can resume a task into a repository it has no accurate
 * record of. The operator decides; V1-04 only reports.
 */

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';

import { comparePathIdentity } from '../core/path-identity.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { safeParseTaskState, type TaskState } from '../core/task-state.js';
import { writeFileAtomically, type ReplaceFn, type TempSuffixFn } from './atomic-file.js';
import {
  deriveTaskStateLocation,
  isStateFileName,
  type StateLocationFailureCode,
  type TaskStateLocation,
} from './state-location.js';

export interface StateStoreOptions {
  /**
   * The canonical repository root — `ResolvedRepository.root`.
   *
   * Required, and never defaulted: the one thing this must not do is fall back
   * to `process.cwd()` and write a task's record into whatever checkout the
   * operator happened to be standing in.
   */
  readonly repositoryRoot: string;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
  /**
   * The revision this writer read, from {@link StateLoadSuccess.revision}.
   *
   * Omitting it does **not** mean "overwrite whatever is there". It means "I
   * read nothing, so I expect nothing" — the creation case — and the save is
   * refused if a state already exists. There is deliberately no "force" option:
   * an unconditional overwrite is precisely the operation this mechanism exists
   * to prevent, so it is not offered as a flag someone can reach for.
   */
  readonly expectedRevision?: string;
}

/**
 * An opaque identity for the exact bytes of one persisted state.
 *
 * A content digest rather than a counter: it needs no field in `TaskState`
 * (which is canonical and unchanged), it cannot drift from the file it
 * describes, and two writers that independently produce byte-identical states
 * are correctly treated as not conflicting.
 *
 * ── Bytes, never decoded text ──────────────────────────────────────────────
 *
 * The digest is taken over the raw bytes read from disk, not over the string
 * they decoded to. Decoding is lossy in exactly the direction that matters
 * here: every invalid UTF-8 sequence — an overlong encoding, a surrogate half,
 * a truncated multi-byte character — decodes to the same replacement
 * character, so two files that differ on disk can decode to one identical
 * string. Hashing that string would hand both files the same revision, and the
 * compare-and-swap that exists to stop a stale writer from flattening someone
 * else's work would wave it through.
 */
function revisionOfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ─────────────────────────────── saving ─────────────────────────────────── */

export type StateSaveFailureCode =
  /** The value handed in is not a state this build would accept back. */
  | 'STATE_CONTRACT_VIOLATION'
  /** The identities in the state cannot be used as path segments. */
  | 'LOCATION_UNSUITABLE'
  /** The state describes a different repository than the one being written to. */
  | 'REPOSITORY_ROOT_MISMATCH'
  /** The per-repository state directory could not be created. */
  | 'DIRECTORY_CREATE_FAILED'
  /** Another writer has moved the state on. Nothing was written. */
  | 'STATE_CONFLICT'
  /**
   * The state serialises to more bytes than {@link MAX_TASK_STATE_BYTES}, so
   * this build could never load it back. Refused before anything is touched.
   */
  | 'STATE_TOO_LARGE'
  /**
   * The move is not declared by the transition table. Produced only by
   * `advanceTaskState()`; `saveTaskState()` writes states without a
   * predecessor and has no edge to judge.
   */
  | 'ILLEGAL_TRANSITION'
  /** The atomic replacement did not complete. The previous state survives. */
  | 'WRITE_FAILED';

export interface StateSaveSuccess {
  readonly ok: true;
  readonly code: 'SAVED';
  readonly path: string;
}

export interface StateSaveFailure {
  readonly ok: false;
  readonly code: StateSaveFailureCode;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /** The reason the underlying step refused, in its own closed vocabulary. */
  readonly detail: string | null;
  readonly errnoCode: string | null;
}

export type StateSaveResult = StateSaveSuccess | StateSaveFailure;

function saveFailure(
  code: StateSaveFailureCode,
  path: string | null,
  detail: string | null = null,
  errnoCode: string | null = null,
): StateSaveFailure {
  return Object.freeze({ ok: false as const, code, path, detail, errnoCode });
}

/**
 * Compares what is on disk against what the writer expected to find there.
 * Returns a reason on conflict, or `null` when the write may proceed.
 *
 * ── The window, stated rather than papered over ────────────────────────────
 *
 * This is optimistic concurrency: read, compare, then replace. Between the
 * compare and the `rename` there is a window in which a third writer could land
 * its own state, and this writer would then overwrite it. Closing that window
 * entirely needs a lock, and a lock is a service — with an owner, a lease, a
 * timeout and a recovery story for the process that died holding it.
 *
 * The window is nanoseconds wide, it is bounded by a single `rename`, and no
 * state is ever corrupted by losing that race — the loser's file is complete and
 * valid, merely superseded. The failure mode this actually defends against is a
 * writer that read a state minutes ago, went away to run an agent, and came back
 * to persist a conclusion drawn from a world that has since moved. That window
 * is minutes wide, and this closes it.
 */
function checkExpectedRevision(path: string, expected: string | undefined): string | null {
  // The same bounded reader the loader uses, for the same reason: whatever is
  // sitting where a state belongs is untrusted input, and reading it unbounded
  // to decide whether we may replace it would make "someone put a large file
  // there" this process's memory problem.
  const current = readBounded(path);

  if (!current.ok) {
    // A state that exists but cannot be read — unreadable, or larger than a
    // state may be — is not a state we may replace: there is no way to prove we
    // are not destroying someone else's work.
    if (current.code === 'STATE_TOO_LARGE') return 'CURRENT_STATE_TOO_LARGE';
    if (current.code === 'UNREADABLE') return 'CURRENT_STATE_UNREADABLE';
  }

  const bytes = current.ok ? current.bytes : null;

  if (expected === undefined) {
    // The creation case: the writer read nothing, so it expects nothing.
    return bytes === null ? null : 'EXPECTED_ABSENT';
  }
  if (bytes === null) return 'EXPECTED_PRESENT';
  return revisionOfBytes(bytes) === expected ? null : 'REVISION_MISMATCH';
}

/**
 * Persists `state` as the current checkpoint of its task.
 *
 * The state is validated *first*, so a contract violation writes nothing at all
 * — not even the directory it would have lived in. The expected revision is
 * checked second, so a conflict likewise creates nothing.
 */
export function saveTaskState(state: unknown, options: StateStoreOptions): StateSaveResult {
  const parsed = safeParseTaskState(state);
  if (!parsed.success) {
    return saveFailure('STATE_CONTRACT_VIOLATION', null, parsed.error.issues[0]?.code ?? null);
  }
  const value: TaskState = parsed.data;

  // The path comes from the *resolved* root, and the state must agree with it.
  // Without this, a state carrying one repository could be filed under another.
  //
  // A relative recorded root is refused rather than resolved: `"."` would
  // otherwise compare equal whenever the process happened to be standing in the
  // repository, which is the `process.cwd()` authority this must not have.
  const recordedRoot = comparePathIdentity(value.repositoryRoot, options.repositoryRoot);
  if (recordedRoot !== 'EQUAL') {
    return saveFailure(
      'REPOSITORY_ROOT_MISMATCH',
      null,
      recordedRoot === 'NOT_ABSOLUTE' ? 'REPOSITORY_ROOT_NOT_ABSOLUTE' : null,
    );
  }

  const location = deriveTaskStateLocation(options.repositoryRoot, value.taskId);
  if (!location.ok) return saveFailure('LOCATION_UNSUITABLE', null, location.code);

  // Serialise, encode, and measure — all before the filesystem is touched at
  // all. The bytes checked here are the exact bytes that would be persisted, so
  // there is no second encoding step between the budget and the write.
  //
  // Trailing newline: the file is meant to be readable by a human debugging a
  // stuck task, and every tool that shows it expects one.
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

  // A state larger than the read budget is one this build would refuse to load
  // back, so persisting it would checkpoint a task into permanent
  // unrecoverability. Refused with a typed code, and nothing is created —
  // not the runtime directory, not a staging file, not the state itself.
  if (bytes.byteLength > MAX_TASK_STATE_BYTES) {
    return saveFailure('STATE_TOO_LARGE', location.path);
  }

  const conflict = checkExpectedRevision(location.path, options.expectedRevision);
  if (conflict !== null) return saveFailure('STATE_CONFLICT', location.path, conflict);

  try {
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    return saveFailure('DIRECTORY_CREATE_FAILED', location.path, null, safeErrnoCode(error));
  }

  const written = writeFileAtomically({
    directory: location.directory,
    fileName: location.fileName,
    contents: bytes,
    // The staging step judges the name by the *state* contract, not by the
    // artefact writer's shorter budget: every canonically valid task id must be
    // writable, or a task the planner can select can never be checkpointed.
    isAcceptableFileName: isStateFileName,
    // Spread rather than assigned: under `exactOptionalPropertyTypes`, passing
    // an explicit `undefined` is not the same as omitting the seam.
    ...(options.replace !== undefined ? { replace: options.replace } : {}),
    ...(options.tempSuffix !== undefined ? { tempSuffix: options.tempSuffix } : {}),
  });

  if (!written.written) {
    return saveFailure('WRITE_FAILED', location.path, written.code, written.errnoCode);
  }

  return Object.freeze({ ok: true as const, code: 'SAVED' as const, path: location.path });
}

/* ─────────────────────────────── loading ────────────────────────────────── */

/**
 * Read budget for one state document.
 *
 * A state file is untrusted input: whatever wrote it last, this process did not
 * watch it being written. Reading it unbounded turns "someone put a large file
 * where a state belongs" into this process's memory problem, so the size is
 * taken from the open handle and checked *before* a single byte is read.
 *
 * 1 MiB matches the output budget `worktree/git-command.ts` already applies to
 * the largest thing this codebase reads from a subprocess. A real state is a
 * few kilobytes; anything near this ceiling is not a state.
 */
export const MAX_TASK_STATE_BYTES = 1_048_576;

/**
 * The four outcomes a caller must be able to tell apart, whatever the precise
 * code.
 *
 * `STATE_INVALID` covers every "there is something there, and it is not usable
 * as state" — unreadable, oversized, malformed, contract-violating — because
 * each of them ends the same way: nothing may be resumed, and nothing may be
 * repaired.
 *
 * `STATE_MISPLACED` is deliberately *not* folded into it. A well-formed state
 * that belongs to another repository or another task is not a broken document;
 * it is an intact record of something else, found where this one should be.
 * Reporting it as "invalid" would send an operator looking for corruption
 * instead of for the copy or the rename that actually happened, and it would
 * lose the distinction the composed outcome needs to keep "the wrong
 * repository" apart from "this repository moved on".
 */
export type StateClassification =
  | 'STATE_MISSING'
  | 'STATE_VALID'
  | 'STATE_INVALID'
  | 'STATE_MISPLACED';

/** Every way a load can fail to produce a state. A closed set. */
export const STATE_LOAD_FAILURE_CODES = [
  /** Nothing has ever been persisted for this task. Not an error. */
  'NO_STATE',
  /** The identities cannot be used as path segments. */
  'LOCATION_UNSUITABLE',
  /** The file exists but could not be read. */
  'UNREADABLE',
  /** The document is larger than {@link MAX_TASK_STATE_BYTES}. Never parsed. */
  'STATE_TOO_LARGE',
  /** The document is valid, but describes a different repository. */
  'REPOSITORY_ROOT_MISMATCH',
  /**
   * The recorded repository root is not an absolute path, so it cannot be
   * compared with the resolved one at all — and must never be resolved against
   * `process.cwd()` to make it comparable.
   */
  'REPOSITORY_ROOT_NOT_ABSOLUTE',
  /** The document is valid, but describes a different task. */
  'TASK_ID_MISMATCH',
  /** The file is not JSON. */
  'MALFORMED_JSON',
  /** Valid JSON written against a contract version this build does not know. */
  'SCHEMA_VERSION_UNSUPPORTED',
  /** Valid JSON of this version that the contract nevertheless rejects. */
  'CONTRACT_VIOLATION',
] as const;

export type StateLoadFailureCode = (typeof STATE_LOAD_FAILURE_CODES)[number];

/**
 * The codes that mean "a well-formed state, but not this one's". They carry
 * `STATE_MISPLACED`; everything else that fails carries `STATE_INVALID`.
 */
const MISPLACED_CODES: ReadonlySet<string> = new Set<string>([
  'REPOSITORY_ROOT_MISMATCH',
  'TASK_ID_MISMATCH',
]);

export interface StateLoadSuccess {
  readonly ok: true;
  readonly code: 'LOADED';
  readonly classification: 'STATE_VALID';
  readonly state: TaskState;
  readonly path: string;
  /**
   * Identity of the exact bytes this state was read from. Hand it back as
   * {@link StateStoreOptions.expectedRevision} to persist a state derived from
   * it; the save is refused if anything advanced in the meantime.
   */
  readonly revision: string;
}

export interface StateLoadFailure {
  readonly ok: false;
  readonly code: StateLoadFailureCode;
  readonly classification: Exclude<StateClassification, 'STATE_VALID'>;
  readonly path: string | null;
  readonly detail: StateLocationFailureCode | null;
  readonly errnoCode: string | null;
}

export type StateLoadResult = StateLoadSuccess | StateLoadFailure;

function loadFailure(
  code: StateLoadFailureCode,
  path: string | null,
  detail: StateLocationFailureCode | null = null,
  errnoCode: string | null = null,
): StateLoadFailure {
  return Object.freeze({
    ok: false as const,
    code,
    classification: classificationFor(code),
    path,
    detail,
    errnoCode,
  });
}

function classificationFor(
  code: StateLoadFailureCode,
): Exclude<StateClassification, 'STATE_VALID'> {
  if (code === 'NO_STATE') return 'STATE_MISSING';
  return MISPLACED_CODES.has(code) ? 'STATE_MISPLACED' : 'STATE_INVALID';
}

/** Best-effort close. The outcome is already decided by the caller. */
function closeQuietly(handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // Nothing to add.
  }
}

type BoundedRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly code: 'NO_STATE' | 'UNREADABLE' | 'STATE_TOO_LARGE';
      readonly errnoCode: string | null;
    };

/**
 * The one way this module reads a persisted state: bounded, and as raw bytes.
 *
 * Open the canonical path, `fstat` the *handle*, refuse anything past the
 * budget, read that many bytes, and hand them back undecoded. Every consumer —
 * the loader, and the compare-and-swap that decides whether a write may
 * proceed — goes through here, so there is one budget and one notion of "the
 * bytes that are on disk".
 *
 * The size comes from the open handle rather than from a prior `stat` of the
 * path, so there is no window in which the thing measured and the thing read
 * are two different files. Decoding and parsing happen afterwards, to the
 * caller's taste; the digest is taken over these bytes, before any of that.
 */
function readBounded(path: string): BoundedRead {
  let handle: number;
  try {
    handle = openSync(path, 'r');
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    if (errnoCode === 'ENOENT') return { ok: false, code: 'NO_STATE', errnoCode: null };
    return { ok: false, code: 'UNREADABLE', errnoCode };
  }

  try {
    const stats = fstatSync(handle);
    // Windows opens a directory handle happily and reports it as zero bytes,
    // which would decode to an empty document and be reported as malformed
    // JSON — a wrong reason. Whatever is at the canonical path, if it is not a
    // regular file it is not a state, and this build will not read it.
    if (!stats.isFile()) return { ok: false, code: 'UNREADABLE', errnoCode: null };

    const { size } = stats;
    if (size > MAX_TASK_STATE_BYTES) {
      return { ok: false, code: 'STATE_TOO_LARGE', errnoCode: null };
    }

    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(handle, buffer, offset, size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== size) return { ok: false, code: 'UNREADABLE', errnoCode: null };

    return { ok: true, bytes: buffer };
  } catch (error) {
    return { ok: false, code: 'UNREADABLE', errnoCode: safeErrnoCode(error) };
  } finally {
    closeQuietly(handle);
  }
}

/**
 * `true` when the contract rejected the *version* rather than the content.
 *
 * Read off the reported issue paths and the raw value, so this module does not
 * need the internal version constant and cannot drift from it. A version issue
 * takes precedence over every other complaint: the rest of the contract cannot
 * meaningfully judge a document written to a shape this build does not know.
 */
function isUnsupportedVersion(value: unknown, issuePaths: readonly (readonly PropertyKey[])[]): boolean {
  const flagged = issuePaths.some((path) => path.length === 1 && path[0] === 'schemaVersion');
  if (!flagged) return false;
  const raw = (value as { readonly schemaVersion?: unknown } | null)?.schemaVersion;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0;
}

/**
 * Reads the current checkpoint of one task. Performs no writes, on any path.
 *
 * The state file is opened by its derived name. The directory is never
 * enumerated, so a temporary file a crashed run left behind is invisible here
 * rather than being mistaken for a candidate state.
 */
export function loadTaskState(
  repositoryRoot: string,
  taskId: string,
): StateLoadResult {
  const location = deriveTaskStateLocation(repositoryRoot, taskId);
  if (!location.ok) return loadFailure('LOCATION_UNSUITABLE', null, location.code);
  const { path }: TaskStateLocation = location;

  // A task that was never started is a normal, expected answer, not an error.
  const read = readBounded(path);
  if (!read.ok) return loadFailure(read.code, path, null, read.errnoCode);
  const raw = read.bytes;

  let document: unknown;
  try {
    // Decoded here, and only here: the revision below is taken from `raw`, so
    // the digest describes the file rather than the text it turned into.
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    // The parser's message quotes the offending input; it is never surfaced.
    return loadFailure('MALFORMED_JSON', path);
  }

  const parsed = safeParseTaskState(document);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path);
    return loadFailure(
      isUnsupportedVersion(document, paths) ? 'SCHEMA_VERSION_UNSUPPORTED' : 'CONTRACT_VIOLATION',
      path,
    );
  }

  // The document was found *by* these identities, so a disagreement means its
  // contents contradict its own location — a state copied or moved between
  // repositories, not merely a stale one. Refused here rather than deferred to
  // reconciliation, because this is provable without resolving anything.
  //
  // The two are reported apart, because they are not the same accident: a
  // repository mismatch means this record is about another project entirely,
  // while a task mismatch means two tasks of *this* project got crossed. They
  // send an operator to different places, and the composed outcome in
  // `reconcile-task.ts` keeps them apart all the way to its caller.
  const recordedRoot = comparePathIdentity(parsed.data.repositoryRoot, repositoryRoot);
  if (recordedRoot === 'NOT_ABSOLUTE') return loadFailure('REPOSITORY_ROOT_NOT_ABSOLUTE', path);
  if (recordedRoot === 'DIFFERENT') return loadFailure('REPOSITORY_ROOT_MISMATCH', path);
  if (parsed.data.taskId !== taskId) return loadFailure('TASK_ID_MISMATCH', path);

  return Object.freeze({
    ok: true as const,
    code: 'LOADED' as const,
    classification: 'STATE_VALID' as const,
    state: parsed.data,
    path,
    // Taken from the bytes actually read, not from the re-serialised value and
    // not from the decoded string: a writer must be held to what was on disk,
    // byte for byte.
    revision: revisionOfBytes(raw),
  });
}
