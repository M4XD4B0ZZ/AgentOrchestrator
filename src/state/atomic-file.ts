/**
 * Crash-safe replacement of a single file.
 *
 * ── Why this is not `doctor/safe-write.ts` ─────────────────────────────────
 *
 * That module is deliberately **append-only**: it opens each artefact with `wx`
 * directly under its final name, and documents that "nothing is ever replaced".
 * That is exactly right for a run artefact, which is written once inside a
 * directory only that run can write to, and it is exactly wrong for task state,
 * which is a *checkpoint* — rewritten at every state transition, over a file
 * that already exists and whose previous contents are the only thing standing
 * between a killed process and a lost task.
 *
 * So the two coexist. What is shared is the safety posture, and it is shared by
 * *importing* it rather than restating it: `isPlainFileName`, `isContained`,
 * `pathContainsLink` and `safeErrnoCode` all come from the existing modules, so
 * there is one notion of a safe file name and one errno allow-list, not two.
 *
 * ── The guarantee ──────────────────────────────────────────────────────────
 *
 * After this function returns, the target file holds **either** its previous
 * complete contents **or** the new complete contents. Never a prefix of either,
 * and never nothing at all.
 *
 * It is bought the only way it can be: the new contents are written to a
 * temporary file *in the same directory*, flushed to stable storage, closed, and
 * only then moved onto the target in one `rename`. The target is never opened
 * for writing, never truncated, and never unlinked — so every failure before the
 * rename is a failure that could not have touched it. Same directory matters:
 * `rename` is only atomic within a filesystem, and a temporary file staged in
 * the system temp directory would cross one (`EXDEV`) on any machine whose
 * state root is on a different volume.
 *
 * A failure at any phase removes the temporary file, so a refusal leaves no
 * residue. A *crash* may leave one behind, which is harmless: readers open the
 * target by name and never enumerate the directory, so an orphan temp is
 * ignored rather than mistaken for state.
 *
 * Failures are returned as fixed codes, never as exception messages (AO-002).
 */

import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';
import { isContained, isPlainFileName, pathContainsLink, samePath } from '../doctor/safe-write.js';

export type AtomicWriteCode =
  | 'WRITTEN'
  /** The file name is not a single plain segment, or escapes the directory. */
  | 'PATH_ESCAPES_DIRECTORY'
  /** A symlink/junction was found on the directory's path. */
  | 'PATH_CONTAINS_LINK'
  /** The target directory does not exist, or is not a directory. */
  | 'DIRECTORY_UNUSABLE'
  /** The temporary file could not be created. Nothing was touched. */
  | 'TEMP_CREATE_FAILED'
  /** The contents could not be written to the temporary file in full. */
  | 'WRITE_FAILED'
  /** The temporary file could not be flushed to stable storage. */
  | 'SYNC_FAILED'
  /** The temporary file's handle could not be closed cleanly. */
  | 'CLOSE_FAILED'
  /** The temporary file could not be moved onto the target. */
  | 'REPLACE_FAILED';

export interface AtomicWriteResult {
  readonly code: AtomicWriteCode;
  /** `true` only after a complete write, a successful sync and a clean replace. */
  readonly written: boolean;
  /** The intended target path. Always inside the given directory. */
  readonly path: string;
  /** Number of content bytes actually handed to the OS. */
  readonly bytesWritten: number;
  /** Whether `fsync` ran on the temporary file before it was moved. */
  readonly synced: boolean;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

/**
 * The move that makes the write atomic. Production uses `renameSync`.
 *
 * Injectable because the guarantee this module exists to provide — "a failed
 * replace leaves the previous state byte-for-byte intact" — cannot be observed
 * on demand against a real filesystem: it needs a `rename` that fails at a
 * chosen moment, which no test can reliably provoke.
 */
export type ReplaceFn = (from: string, to: string) => void;

/**
 * The unique part of the temporary file's name. Injectable so a test can pin it
 * and assert *where* the staging happens; never used to make a security
 * decision, since containment is proven from the resolved path either way.
 */
export type TempSuffixFn = () => string;

const defaultReplace: ReplaceFn = (from, to) => {
  renameSync(from, to);
};

const defaultTempSuffix: TempSuffixFn = () =>
  `${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`;

export interface AtomicWriteRequest {
  /** An existing directory. This function never creates one. */
  readonly directory: string;
  /** A single plain file name, e.g. `task-0001.json`. */
  readonly fileName: string;
  readonly contents: string;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

function result(
  code: AtomicWriteCode,
  path: string,
  errnoCode: string | null,
  bytesWritten = 0,
  synced = false,
): AtomicWriteResult {
  return Object.freeze({
    code,
    written: code === 'WRITTEN',
    path,
    bytesWritten,
    synced,
    errnoCode,
  });
}

/**
 * `fsync` is not available on every filesystem or every handle type. `EINVAL`
 * is the answer a filesystem gives when the operation is meaningless there; it
 * is recorded as `synced: false` rather than failing the write. Every other
 * errno is a genuine sync failure, and a state that was not flushed is exactly
 * the state a crash loses.
 */
const FSYNC_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['EINVAL']);

/** Best-effort removal of the staging file on a failure path. */
function discard(temp: string): void {
  try {
    unlinkSync(temp);
  } catch {
    // The caller is already returning a failure; a surviving temp file is
    // inert, because nothing reads the directory by enumeration.
  }
}

/** Best-effort close on a failure path. The failure code is already decided. */
function closeQuietly(handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // Nothing to add.
  }
}

/**
 * Replaces `directory/fileName` with `contents`, atomically, or explains
 * precisely why it did not. Never throws.
 */
export function writeFileAtomically(request: AtomicWriteRequest): AtomicWriteResult {
  const directory = resolve(request.directory);
  const replace = request.replace ?? defaultReplace;
  const tempSuffix = request.tempSuffix ?? defaultTempSuffix;

  if (!isPlainFileName(request.fileName)) {
    return result('PATH_ESCAPES_DIRECTORY', join(directory, request.fileName), null);
  }

  const target = resolve(directory, request.fileName);
  // Belt and braces: even with a validated name, prove the result is contained.
  if (!isContained(directory, target) || !samePath(dirname(target), directory)) {
    return result('PATH_ESCAPES_DIRECTORY', target, null);
  }

  let directoryStats;
  try {
    directoryStats = lstatSync(directory);
  } catch (error) {
    return result('DIRECTORY_UNUSABLE', target, safeErrnoCode(error));
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    return result('DIRECTORY_UNUSABLE', target, null);
  }

  if (pathContainsLink(directory)) {
    return result('PATH_CONTAINS_LINK', target, null);
  }

  // Staged beside the target, so the later rename stays inside one filesystem.
  const temp = join(directory, `${request.fileName}.tmp-${tempSuffix()}`);

  let handle: number;
  try {
    handle = openSync(temp, 'wx', 0o600);
  } catch (error) {
    return result('TEMP_CREATE_FAILED', target, safeErrnoCode(error));
  }

  const buffer = Buffer.from(request.contents, 'utf8');
  let offset = 0;
  let synced = false;

  try {
    // `writeSync` may write fewer bytes than asked for; loop until the whole
    // buffer is out, so a short write is never mistaken for a complete one.
    while (offset < buffer.length) {
      const written = writeSync(handle, buffer, offset, buffer.length - offset);
      if (written <= 0) break;
      offset += written;
    }
    if (offset !== buffer.length) {
      closeQuietly(handle);
      discard(temp);
      return result('WRITE_FAILED', target, null, offset);
    }
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    closeQuietly(handle);
    discard(temp);
    return result('WRITE_FAILED', target, errnoCode, offset);
  }

  try {
    fsyncSync(handle);
    synced = true;
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    if (!FSYNC_UNSUPPORTED_CODES.has(errnoCode)) {
      closeQuietly(handle);
      discard(temp);
      return result('SYNC_FAILED', target, errnoCode, offset);
    }
    // Not supported here. Recorded as `synced: false`, not as success-by-silence.
  }

  try {
    closeSync(handle);
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    discard(temp);
    return result('CLOSE_FAILED', target, errnoCode, offset, synced);
  }

  // The only step that touches the target, and the only one that is atomic.
  try {
    replace(temp, target);
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    discard(temp);
    return result('REPLACE_FAILED', target, errnoCode, offset, synced);
  }

  return result('WRITTEN', target, null, offset, synced);
}
