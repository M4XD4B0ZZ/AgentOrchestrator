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
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { safeParseTaskState, type TaskState } from '../core/task-state.js';
import { writeFileAtomically, type ReplaceFn, type TempSuffixFn } from './atomic-file.js';
import {
  deriveTaskStateLocation,
  type StateLocationFailureCode,
  type TaskStateLocation,
} from './state-location.js';

export interface StateStoreOptions {
  /** INTERNAL test seam for the persistent root. Never environment-derived. */
  readonly provider?: PathProvider;
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
 */
function revisionOf(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/* ─────────────────────────────── saving ─────────────────────────────────── */

export type StateSaveFailureCode =
  /** The value handed in is not a state this build would accept back. */
  | 'STATE_CONTRACT_VIOLATION'
  /** The identities in the state cannot be used as path segments. */
  | 'LOCATION_UNSUITABLE'
  /** The per-repository state directory could not be created. */
  | 'DIRECTORY_CREATE_FAILED'
  /** Another writer has moved the state on. Nothing was written. */
  | 'STATE_CONFLICT'
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
  let current: string | null;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    if (safeErrnoCode(error) !== 'ENOENT') {
      // A state that exists but cannot be read is not a state we may replace:
      // there is no way to prove we are not destroying someone else's work.
      return 'CURRENT_STATE_UNREADABLE';
    }
    current = null;
  }

  if (expected === undefined) {
    // The creation case: the writer read nothing, so it expects nothing.
    return current === null ? null : 'EXPECTED_ABSENT';
  }
  if (current === null) return 'EXPECTED_PRESENT';
  return revisionOf(current) === expected ? null : 'REVISION_MISMATCH';
}

/**
 * Persists `state` as the current checkpoint of its task.
 *
 * The state is validated *first*, so a contract violation writes nothing at all
 * — not even the directory it would have lived in. The expected revision is
 * checked second, so a conflict likewise creates nothing.
 */
export function saveTaskState(state: unknown, options: StateStoreOptions = {}): StateSaveResult {
  const provider = options.provider ?? OS_PATH_PROVIDER;

  const parsed = safeParseTaskState(state);
  if (!parsed.success) {
    return saveFailure('STATE_CONTRACT_VIOLATION', null, parsed.error.issues[0]?.code ?? null);
  }
  const value: TaskState = parsed.data;

  const location = deriveTaskStateLocation(value.repositoryId, value.taskId, provider);
  if (!location.ok) return saveFailure('LOCATION_UNSUITABLE', null, location.code);

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
    // Trailing newline: the file is meant to be readable by a human debugging a
    // stuck task, and every tool that shows it expects one.
    contents: `${JSON.stringify(value, null, 2)}\n`,
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
 * The three outcomes a caller must be able to tell apart, whatever the precise
 * code. `STATE_INVALID` covers every "there is something there, and it is not
 * usable as state" — unreadable, oversized, malformed, contract-violating or
 * misplaced — because each of them ends the same way: nothing may be resumed,
 * and nothing may be repaired.
 */
export type StateClassification = 'STATE_MISSING' | 'STATE_VALID' | 'STATE_INVALID';

export type StateLoadFailureCode =
  /** Nothing has ever been persisted for this task. Not an error. */
  | 'NO_STATE'
  /** The identities cannot be used as path segments. */
  | 'LOCATION_UNSUITABLE'
  /** The file exists but could not be read. */
  | 'UNREADABLE'
  /** The document is larger than {@link MAX_TASK_STATE_BYTES}. Never parsed. */
  | 'STATE_TOO_LARGE'
  /** The document is valid, but describes a different repository or task. */
  | 'IDENTITY_MISMATCH'
  /** The file is not JSON. */
  | 'MALFORMED_JSON'
  /** Valid JSON written against a contract version this build does not know. */
  | 'SCHEMA_VERSION_UNSUPPORTED'
  /** Valid JSON of this version that the contract nevertheless rejects. */
  | 'CONTRACT_VIOLATION';

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
    classification: code === 'NO_STATE' ? 'STATE_MISSING' : 'STATE_INVALID',
    path,
    detail,
    errnoCode,
  });
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
  | { readonly ok: true; readonly contents: string }
  | { readonly ok: false; readonly code: 'NO_STATE' | 'UNREADABLE' | 'STATE_TOO_LARGE'; readonly errnoCode: string | null };

/**
 * Reads a state document, refusing anything larger than the budget.
 *
 * The size is taken from the *open handle* rather than from a prior `stat` of
 * the path, so there is no window in which the thing measured and the thing
 * read are two different files.
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
    const { size } = fstatSync(handle);
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

    return { ok: true, contents: buffer.toString('utf8') };
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
  repositoryId: string,
  taskId: string,
  options: StateStoreOptions = {},
): StateLoadResult {
  const provider = options.provider ?? OS_PATH_PROVIDER;

  const location = deriveTaskStateLocation(repositoryId, taskId, provider);
  if (!location.ok) return loadFailure('LOCATION_UNSUITABLE', null, location.code);
  const { path }: TaskStateLocation = location;

  // A task that was never started is a normal, expected answer, not an error.
  const read = readBounded(path);
  if (!read.ok) return loadFailure(read.code, path, null, read.errnoCode);
  const raw = read.contents;

  let document: unknown;
  try {
    document = JSON.parse(raw);
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
  if (parsed.data.repositoryId !== repositoryId || parsed.data.taskId !== taskId) {
    return loadFailure('IDENTITY_MISMATCH', path);
  }

  return Object.freeze({
    ok: true as const,
    code: 'LOADED' as const,
    classification: 'STATE_VALID' as const,
    state: parsed.data,
    path,
    // Taken from the bytes actually read, not from the re-serialised value: a
    // writer must be held to what was on disk, not to what we would have
    // written for the same state.
    revision: revisionOf(raw),
  });
}
