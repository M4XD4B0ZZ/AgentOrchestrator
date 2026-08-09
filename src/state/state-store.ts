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

import { mkdirSync, readFileSync } from 'node:fs';

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
}

/* ─────────────────────────────── saving ─────────────────────────────────── */

export type StateSaveFailureCode =
  /** The value handed in is not a state this build would accept back. */
  | 'STATE_CONTRACT_VIOLATION'
  /** The identities in the state cannot be used as path segments. */
  | 'LOCATION_UNSUITABLE'
  /** The per-repository state directory could not be created. */
  | 'DIRECTORY_CREATE_FAILED'
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
 * Persists `state` as the current checkpoint of its task.
 *
 * The state is validated *first*, so a contract violation writes nothing at all
 * — not even the directory it would have lived in.
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

export type StateLoadFailureCode =
  /** Nothing has ever been persisted for this task. Not an error. */
  | 'NO_STATE'
  /** The identities cannot be used as path segments. */
  | 'LOCATION_UNSUITABLE'
  /** The file exists but could not be read. */
  | 'UNREADABLE'
  /** The file is not JSON. */
  | 'MALFORMED_JSON'
  /** Valid JSON written against a contract version this build does not know. */
  | 'SCHEMA_VERSION_UNSUPPORTED'
  /** Valid JSON of this version that the contract nevertheless rejects. */
  | 'CONTRACT_VIOLATION';

export interface StateLoadSuccess {
  readonly ok: true;
  readonly code: 'LOADED';
  readonly state: TaskState;
  readonly path: string;
}

export interface StateLoadFailure {
  readonly ok: false;
  readonly code: StateLoadFailureCode;
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
  return Object.freeze({ ok: false as const, code, path, detail, errnoCode });
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

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    // A task that was never started is a normal, expected answer.
    if (errnoCode === 'ENOENT') return loadFailure('NO_STATE', path);
    return loadFailure('UNREADABLE', path, null, errnoCode);
  }

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

  return Object.freeze({
    ok: true as const,
    code: 'LOADED' as const,
    state: parsed.data,
    path,
  });
}
