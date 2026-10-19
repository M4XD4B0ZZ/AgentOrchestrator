/**
 * Where a task's writer-outcome record lives, and the rules for changing it
 * (RM1-03A).
 *
 * ── One file per task, in its own directory ────────────────────────────────
 *
 * `<runtime>/writer-outcomes/<taskId>.json`, for the reason
 * `verify/verification-attempt-store.ts` gives for its own directory: a task id
 * may contain dots, so a sibling name inside the runtime directory could be a
 * legal *other task's* file name. The runtime readers — the dashboard scan, the
 * attention outbox, the durable wake list — enumerate state *files* by name, and
 * a directory carries no `.json` extension, so none of them reads it as a task.
 *
 * ── Under the repository root, never under the worktree ────────────────────
 *
 * `taskRuntimeDirectory(repositoryRoot)`, and the reason is the sibling store's:
 * the writing agent runs in the worktree, so a record there would be writable by
 * the agent whose failure it describes.
 *
 * ── Append to a window, never edit an entry ────────────────────────────────
 *
 * The existing record is read first and every entry in it is carried forward as
 * it was read. Exactly one entry is appended. When that makes more than
 * {@link MAX_WRITER_OUTCOMES_KEPT}, the oldest is dropped and `droppedCount`
 * grows by one, so a reader can see that something was lost. A document this
 * build cannot read is **never replaced** (`EXISTING_HISTORY_UNREADABLE`).
 *
 * ── Evidence only ──────────────────────────────────────────────────────────
 *
 * Nothing this store returns changes a step's outcome, a state, an exit code or
 * what a later step does. `loop/loop-step.ts` reports the result beside the
 * step; `run/run-plan.ts` reads the record into one display field. Those two are
 * the only importers, and a test pins that.
 *
 * ── Read-before-write, and not a transaction ───────────────────────────────
 *
 * As in the sibling store: two invocations racing on one task can both read and
 * both append, and the second replace wins. That loses one entry of evidence,
 * not a document, and it is bounded by the execution lease the caller holds.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';
import { isContained } from '../doctor/safe-write.js';
import { isValidTaskId } from '../plan/task-id.js';
import { writeFileAtomically, type ReplaceFn, type TempSuffixFn } from '../state/atomic-file.js';
import { relativePosix, type RuntimeIgnoreVerdict } from '../state/runtime-ignored.js';
import {
  isStateFileName,
  taskRuntimeDirectory,
  TASK_STATE_FILE_EXTENSION,
} from '../state/state-location.js';
import {
  MAX_WRITER_OUTCOME_RECORD_BYTES,
  MAX_WRITER_OUTCOMES_KEPT,
  readWriterOutcomes,
  WRITER_OUTCOME_VERSION,
  writerOutcomeBinding,
  type WriterOutcomeEntry,
  type WriterOutcomeHistory,
  type WriterOutcomeHistoryPayload,
  type WriterOutcomeSubject,
} from './writer-outcome.js';

/** The directory name holding writer-outcome records. See the header. */
export const WRITER_OUTCOME_DIR_NAME = 'writer-outcomes';

/** The extension of a writer-outcome record file. */
export const WRITER_OUTCOME_FILE_EXTENSION = TASK_STATE_FILE_EXTENSION;

/** The directory holding writer-outcome records for a canonical repository root. */
export function writerOutcomeDirectory(repositoryRoot: string): string {
  return join(taskRuntimeDirectory(repositoryRoot), WRITER_OUTCOME_DIR_NAME);
}

/** Whether a name is one of this store's files. `state-location.ts`'s grammar, shared. */
export function isWriterOutcomeFileName(name: string): boolean {
  return isStateFileName(name);
}

export interface WriterOutcomeLocation {
  readonly ok: true;
  readonly directory: string;
  readonly fileName: string;
  readonly path: string;
}

export interface WriterOutcomeLocationFailure {
  readonly ok: false;
  readonly code: 'REPOSITORY_ROOT_UNSUITABLE' | 'TASK_ID_UNSUITABLE';
}

export type WriterOutcomeLocationResult = WriterOutcomeLocation | WriterOutcomeLocationFailure;

/** Where one task's writer-outcome record belongs, or why it has no location. */
export function deriveWriterOutcomeLocation(
  repositoryRoot: string,
  taskId: string,
): WriterOutcomeLocationResult {
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }
  if (!isValidTaskId(taskId)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const fileName = `${taskId}${WRITER_OUTCOME_FILE_EXTENSION}`;
  if (!isWriterOutcomeFileName(fileName)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const directory = writerOutcomeDirectory(repositoryRoot);
  const path = join(directory, fileName);
  if (!isContained(repositoryRoot, path)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  return Object.freeze({ ok: true as const, directory, fileName, path });
}

/* ─────────────────────────────── recording ──────────────────────────────── */

/** Every way recording an entry can end. A closed set, and two of them wrote. */
export const WRITER_OUTCOME_RECORD_CODES = [
  /** Appended to an existing record. */
  'OUTCOME_RECORDED',
  /** Wrote the first entry of a new record. */
  'HISTORY_STARTED',
  /** This run is no longer the repository's writer. Nothing was written. */
  'EXECUTION_LEASE_NOT_HELD',
  /** A record is on disk for a different task or repository. */
  'CONFLICTING_HISTORY',
  /** Something is on disk that this build cannot read. Never replaced. */
  'EXISTING_HISTORY_UNREADABLE',
  /** No location could be derived for this repository and task. */
  'LOCATION_UNSUITABLE',
  /** The record's own path is not ignored by Git, or the answer was unreadable. */
  'RUNTIME_PATH_NOT_IGNORED',
  'RUNTIME_IGNORE_UNDETERMINED',
  /** This build would not accept back the document it just built. */
  'RECORD_CONTRACT_VIOLATION',
  /** The document exceeds this build's byte budget. */
  'RECORD_TOO_LARGE',
  /** The directory could not be created. */
  'DIRECTORY_CREATE_FAILED',
  /** The atomic replace did not complete. */
  'WRITE_FAILED',
  /** The document was written and did not read back as what was written. */
  'READBACK_FAILED',
] as const;

export type WriterOutcomeRecordCode = (typeof WRITER_OUTCOME_RECORD_CODES)[number];

export interface WriterOutcomeRecordResult {
  readonly code: WriterOutcomeRecordCode;
  /** Whether the durable record now contains this entry. */
  readonly recorded: boolean;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  readonly errnoCode: string | null;
}

export interface WriterOutcomeWriteRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** The entry to append, built by `writerOutcomeFrom`. */
  readonly entry: WriterOutcomeEntry;
  /** Whether this run still holds the repository's execution lease, asked at the write. */
  readonly leaseHolds: () => boolean;
  /** Whether Git ignores a repository-relative path. */
  readonly checkIgnored: (relativePath: string) => Promise<RuntimeIgnoreVerdict>;
  readonly open?: (path: string) => number;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

function recordFailure(
  code: WriterOutcomeRecordCode,
  path: string | null,
  errnoCode: string | null = null,
): WriterOutcomeRecordResult {
  return Object.freeze({ code, recorded: false as const, path, errnoCode });
}

/**
 * Appends one writer outcome to a task's record.
 *
 * Never throws for an expected condition, and never overwrites a record it
 * could not read.
 */
export async function recordWriterOutcome(
  request: WriterOutcomeWriteRequest,
): Promise<WriterOutcomeRecordResult> {
  const location = deriveWriterOutcomeLocation(request.repositoryRoot, request.taskId);
  if (!location.ok) return recordFailure('LOCATION_UNSUITABLE', null);

  const subject: WriterOutcomeSubject = Object.freeze({
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
  });

  // ── 1. Read what is there, ahead of any filesystem effect ────────────────
  const existing = loadWriterOutcomes(
    request.repositoryRoot,
    request.taskId,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );

  let outcomes: WriterOutcomeEntry[];
  let droppedCount: number;
  let started: boolean;

  if (existing.reading === 'WRITER_OUTCOME_HISTORY') {
    if (existing.record === null) {
      return recordFailure('EXISTING_HISTORY_UNREADABLE', location.path);
    }
    if (
      existing.record.taskId !== request.taskId ||
      existing.record.repositoryRoot !== request.repositoryRoot
    ) {
      return recordFailure('CONFLICTING_HISTORY', location.path);
    }
    // Carried forward as read; exactly one entry is added. The window drops the
    // oldest, and the loss is counted rather than hidden.
    const appended = [...existing.record.outcomes, request.entry];
    const overflow = Math.max(0, appended.length - MAX_WRITER_OUTCOMES_KEPT);
    outcomes = appended.slice(overflow);
    droppedCount = existing.record.droppedCount + overflow;
    started = false;
  } else if (existing.reading === 'ABSENT') {
    outcomes = [request.entry];
    droppedCount = 0;
    started = true;
  } else {
    // `MALFORMED`, `UNSUPPORTED_VERSION` and `NOT_THIS_TASK`: something is on
    // that path and this build cannot say what it claims. It is not replaced.
    return recordFailure('EXISTING_HISTORY_UNREADABLE', location.path);
  }

  const payload: WriterOutcomeHistoryPayload = {
    outcomeVersion: WRITER_OUTCOME_VERSION,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
    droppedCount,
    outcomes,
  };

  // ── 2. The ignore question, for the record and its staging name ──────────
  //
  // Derived from the path about to be written, and asked one name per call,
  // for the reasons `verification-attempt-store.ts` gives.
  const relativeRecord = relativePosix(request.repositoryRoot, location.path);
  if (relativeRecord === null) return recordFailure('LOCATION_UNSUITABLE', location.path);
  const stagingVerdict = await request.checkIgnored(`${relativeRecord}.tmp-probe`);
  if (stagingVerdict === 'UNDETERMINED') {
    return recordFailure('RUNTIME_IGNORE_UNDETERMINED', location.path);
  }
  if (stagingVerdict !== 'IGNORED') return recordFailure('RUNTIME_PATH_NOT_IGNORED', location.path);
  const recordVerdict = await request.checkIgnored(relativeRecord);
  if (recordVerdict === 'UNDETERMINED') {
    return recordFailure('RUNTIME_IGNORE_UNDETERMINED', location.path);
  }
  if (recordVerdict !== 'IGNORED') return recordFailure('RUNTIME_PATH_NOT_IGNORED', location.path);

  const document = { ...payload, binding: writerOutcomeBinding(subject, payload) };

  // ── 3. Prove this build would accept its own record back ─────────────────
  if (readWriterOutcomes(document, subject).reading !== 'WRITER_OUTCOME_HISTORY') {
    return recordFailure('RECORD_CONTRACT_VIOLATION', location.path);
  }

  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_WRITER_OUTCOME_RECORD_BYTES) {
    return recordFailure('RECORD_TOO_LARGE', location.path);
  }

  try {
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    return recordFailure('DIRECTORY_CREATE_FAILED', location.path, safeErrnoCode(error));
  }

  // ── 4. The lease, immediately before the effect ──────────────────────────
  if (!request.leaseHolds()) return recordFailure('EXECUTION_LEASE_NOT_HELD', location.path);

  const written = writeFileAtomically({
    directory: location.directory,
    fileName: location.fileName,
    contents: bytes,
    isAcceptableFileName: isWriterOutcomeFileName,
    ...(request.replace === undefined ? {} : { replace: request.replace }),
    ...(request.tempSuffix === undefined ? {} : { tempSuffix: request.tempSuffix }),
  });
  if (!written.written) return recordFailure('WRITE_FAILED', location.path, written.errnoCode);

  // ── 5. Read it back off the disk ─────────────────────────────────────────
  //
  // Never re-issued on a bad read-back: something is on that path, and
  // replacing it again would destroy a document this build cannot read.
  const readBack = loadWriterOutcomes(
    request.repositoryRoot,
    request.taskId,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );
  if (
    readBack.reading !== 'WRITER_OUTCOME_HISTORY' ||
    readBack.record === null ||
    readBack.record.binding !== document.binding
  ) {
    return recordFailure('READBACK_FAILED', location.path);
  }

  return Object.freeze({
    code: started ? ('HISTORY_STARTED' as const) : ('OUTCOME_RECORDED' as const),
    recorded: true as const,
    path: location.path,
    errnoCode: null,
  });
}

/* ──────────────────────────────── reading ───────────────────────────────── */

export interface WriterOutcomeLoad {
  readonly reading: ReturnType<typeof readWriterOutcomes>['reading'];
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /** The record, on `WRITER_OUTCOME_HISTORY` only, and `null` on every other reading. */
  readonly record: WriterOutcomeHistory | null;
}

function load(
  reading: WriterOutcomeLoad['reading'],
  path: string | null,
  record: WriterOutcomeHistory | null = null,
): WriterOutcomeLoad {
  return Object.freeze({ reading, path, record });
}

/**
 * Reads back the writer-outcome record for one task. The one loader.
 *
 * Never throws. An unreadable file, an oversized one, a directory, one that is
 * not JSON and one that is JSON of the wrong shape all reach a reading rather
 * than an exception, and only a not-found open reads as `ABSENT`.
 */
export function loadWriterOutcomes(
  repositoryRoot: string,
  taskId: string,
  open: (path: string) => number = (path) => openSync(path, 'r'),
  readChunk: (
    handle: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number = readSync,
): WriterOutcomeLoad {
  const location = deriveWriterOutcomeLocation(repositoryRoot, taskId);
  if (!location.ok) return load('MALFORMED', null);

  const subject: WriterOutcomeSubject = Object.freeze({ taskId, repositoryRoot });

  let handle: number;
  try {
    handle = open(location.path);
  } catch (error: unknown) {
    return load(safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'MALFORMED', location.path);
  }

  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) return load('MALFORMED', location.path);
    const size = stat.size;
    if (size > MAX_WRITER_OUTCOME_RECORD_BYTES) return load('MALFORMED', location.path);
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const chunk = readChunk(handle, buffer, read, size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    if (read !== size) return load('MALFORMED', location.path);

    let raw: unknown;
    try {
      raw = JSON.parse(buffer.subarray(0, read).toString('utf8'));
    } catch {
      return load('MALFORMED', location.path);
    }

    const result = readWriterOutcomes(raw, subject);
    return load(result.reading, location.path, result.record);
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A handle that cannot be closed changes nothing about the reading above.
    }
  }
}

/** The newest entry of a load, or `null` for any reading that is not a record. */
export function latestWriterOutcome(load: WriterOutcomeLoad): WriterOutcomeEntry | null {
  if (load.reading !== 'WRITER_OUTCOME_HISTORY' || load.record === null) return null;
  const outcomes = load.record.outcomes;
  return outcomes[outcomes.length - 1] ?? null;
}
