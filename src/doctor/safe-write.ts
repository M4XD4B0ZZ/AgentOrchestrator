/**
 * Path safety primitives and append-only artefact writing (AO-007-R2-RR1).
 *
 * ── What changed, and why ──────────────────────────────────────────────────
 *
 * The previous implementation wrote each artefact to a uniquely named temporary
 * file and then "finalised" it with `linkSync`, falling back to a
 * `targetExists()` check followed by `renameSync`. Every part of that was a
 * liability:
 *
 *  - the check-then-`rename` fallback is a textbook TOCTOU race: between the
 *    existence check and the rename the target can appear, and `rename`
 *    replaces it silently on both Windows and POSIX;
 *  - the hard-link path needed `EXDEV`/`EPERM` handling and left a temporary
 *    file that had to be unlinked on every path, including failure paths, so
 *    "did the cleanup work?" became part of the success criterion;
 *  - all of it existed to gain atomicity that a freshly, exclusively created
 *    run directory already provides. Inside a directory only this run can write
 *    to, there is nothing to be atomic *against*.
 *
 * The replacement is append-only and boring: each artefact is created **once**,
 * directly under its final name, through a single exclusive handle.
 *
 * There is no `linkSync`, no `renameSync`, no temporary file and no unlink in
 * this module any more, and nothing is ever replaced.
 *
 * The rules {@link writeRunArtifact} enforces, all fail-closed:
 *
 *  1. **Containment.** The file name must be a single plain segment, and the
 *     resolved target must still sit directly inside the run directory it was
 *     given. `..`, absolute paths and separators are rejected outright.
 *  2. **No links in the path.** Every segment from the filesystem root down to
 *     the run directory is `lstat`ed. A symbolic link or a Windows junction
 *     anywhere along it aborts the write — otherwise a link planted inside the
 *     application-data root would redirect the artefact somewhere else.
 *  3. **Exclusive create, no existence check.** The file is opened with `wx`.
 *     Whether something already occupies the name is answered by the kernel, in
 *     the same syscall that would create it: `EEXIST` means abandon the write.
 *     There is deliberately no `lstat`-then-open sequence, because that gap is
 *     the race.
 *  4. **Written, synced, closed — in that order, or not at all.** The content
 *     goes out through the open handle, `fsync` is attempted, and the handle is
 *     closed. A failure in any of those phases is reported as that phase and
 *     never as success. A partially written file may remain in the run
 *     directory as evidence; the run simply never gets its `COMPLETED` marker
 *     (see `run-completion.ts`), so no consumer will read it.
 *
 * Failures are returned as fixed codes, never as exception messages (AO-002).
 */

import { closeSync, fsyncSync, lstatSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';

export type RunArtifactCode =
  | 'WRITTEN'
  /** The file name is not a single plain segment, or escapes the run directory. */
  | 'PATH_ESCAPES_RUN_DIRECTORY'
  /** A symlink/junction was found in the run directory's path. */
  | 'PATH_CONTAINS_LINK'
  /** The run directory does not exist, or is not a directory. */
  | 'RUN_DIRECTORY_UNUSABLE'
  /** Something already occupies the target name. Never replaced. */
  | 'TARGET_EXISTS'
  /** The exclusive handle could not be opened. Nothing was created. */
  | 'OPEN_FAILED'
  /** The content could not be written in full. The file stays incomplete. */
  | 'WRITE_FAILED'
  /** The content was written but could not be flushed to stable storage. */
  | 'SYNC_FAILED'
  /** The handle could not be closed cleanly, so completion is unproven. */
  | 'CLOSE_FAILED';

export interface RunArtifactResult {
  readonly code: RunArtifactCode;
  /** `true` only after a complete write, a successful sync and a clean close. */
  readonly written: boolean;
  /** The intended target path. Always inside the run directory. */
  readonly path: string;
  /** Number of content bytes actually handed to the OS. */
  readonly bytesWritten: number;
  /** Whether `fsync` ran. `false` when the filesystem does not support it. */
  readonly synced: boolean;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

export interface RunArtifactRequest {
  /** A run directory this run created exclusively. Never a shared directory. */
  readonly runDirectory: string;
  /** A single plain file name, e.g. `doctor-report.json`. */
  readonly fileName: string;
  readonly contents: string;
}

/** A plain file name: no separators, no `..`, no drive letters. */
const SAFE_FILE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export function isPlainFileName(name: string): boolean {
  if (!SAFE_FILE_NAME.test(name)) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('..')) return false;
  return !name.includes('/') && !name.includes('\\') && !isAbsolute(name);
}

/** Case-insensitive on Windows, exact elsewhere. */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `true` when `candidate` is `root` itself or lies beneath it. */
export function isContained(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  if (samePath(r, c)) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return process.platform === 'win32'
    ? c.toLowerCase().startsWith(prefix.toLowerCase())
    : c.startsWith(prefix);
}

/**
 * Every path from the filesystem root down to and including `target`.
 * `C:\a\b` yields `C:\`, `C:\a`, `C:\a\b`.
 */
export function pathChain(target: string): readonly string[] {
  const absolute = resolve(target);
  const { root } = parsePath(absolute);
  const chain: string[] = [];
  let current = absolute;

  while (true) {
    chain.push(current);
    if (samePath(current, root)) break;
    const parent = dirname(current);
    if (samePath(parent, current)) break;
    current = parent;
  }
  return chain.reverse();
}

/**
 * The tri-state answer to "is there a link on this path chain?"
 * (AO-007-R2-RR2-REVIEW-01-C1-F4).
 *
 *  - `CLEAR`: every segment was inspected and none is a link.
 *  - `LINK_FOUND`: a symbolic link or Windows junction sits on the chain.
 *  - `INSPECTION_FAILED`: at least one segment could not be conclusively
 *    classified. This is not "probably fine" — a segment this process cannot
 *    even `lstat` is, for path-safety purposes, exactly as dangerous as one it
 *    can prove is a link, because neither can be ruled out as a redirection.
 */
export type LinkChainResult = 'CLEAR' | 'LINK_FOUND' | 'INSPECTION_FAILED';

export interface LinkChainOptions {
  /**
   * `true` when a segment that does not exist yet is an expected, benign
   * state (e.g. checking the path down to a directory this call is about to
   * create). `false` when every segment is expected to already exist, so a
   * missing one is itself suspicious rather than "nothing to redirect
   * through" — the shared run-completion validators always pass `false`,
   * because by the time they run, the run directory has already been
   * created.
   */
  readonly allowMissing: boolean;
}

/**
 * Classifies every existing segment of `target`'s path with `lstat`, never
 * `stat` — a symbolic link or a Windows junction must never be silently
 * followed and reported as "just a directory".
 *
 * Every `lstat` failure is mapped through the closed errno allow-list before
 * it can influence the result: an unrecognised or unexpected error is never
 * treated as "the component is absent". Only `ENOENT`, and only when
 * `allowMissing` is `true`, is treated as "nothing here yet, keep looking" —
 * every other errno, including `ENOENT` when `allowMissing` is `false`,
 * yields `INSPECTION_FAILED`.
 */
export function inspectLinkChain(target: string, options: LinkChainOptions): LinkChainResult {
  for (const segment of pathChain(target)) {
    let stats;
    try {
      stats = lstatSync(segment);
    } catch (error) {
      const errnoCode = safeErrnoCode(error);
      if (options.allowMissing && errnoCode === 'ENOENT') continue;
      return 'INSPECTION_FAILED';
    }
    if (stats.isSymbolicLink()) return 'LINK_FOUND';
  }
  return 'CLEAR';
}

/**
 * `true` when any existing segment of `target`'s path is a link, *or* when a
 * segment could not be conclusively inspected at all. Both cases fail closed:
 * the caller must treat `true` as "do not proceed", never as "probably a
 * link, probably not".
 *
 * Segments that do not exist yet are tolerated — this helper is used before a
 * directory has been created, when a not-yet-existing component is expected.
 */
export function pathContainsLink(target: string): boolean {
  return inspectLinkChain(target, { allowMissing: true }) !== 'CLEAR';
}

function result(
  code: RunArtifactCode,
  path: string,
  errnoCode: string | null,
  bytesWritten = 0,
  synced = false,
): RunArtifactResult {
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
 * `fsync` is not available on every filesystem or every handle type.
 *
 * `EINVAL` is the answer a filesystem gives when the operation is meaningless
 * there; it is treated as "not supported" rather than as a failure, and the
 * result records `synced: false` so the caller can see which happened. Every
 * other errno is a genuine sync failure and fails the write.
 */
const FSYNC_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['EINVAL']);

/**
 * Creates one artefact in a freshly created run directory, or explains
 * precisely why it did not. Never throws.
 *
 * Success means: the file did not exist, was created exclusively, received all
 * of its content, was flushed where the filesystem supports flushing, and its
 * handle was closed without error. Anything less is not `WRITTEN`.
 */
export function writeRunArtifact(request: RunArtifactRequest): RunArtifactResult {
  const runDirectory = resolve(request.runDirectory);

  if (!isPlainFileName(request.fileName)) {
    return result('PATH_ESCAPES_RUN_DIRECTORY', join(runDirectory, request.fileName), null);
  }

  const target = resolve(runDirectory, request.fileName);
  // Belt and braces: even with a validated name, prove the result is contained.
  if (!isContained(runDirectory, target) || !samePath(dirname(target), runDirectory)) {
    return result('PATH_ESCAPES_RUN_DIRECTORY', target, null);
  }

  // The run directory must already exist — this function never creates one, so
  // it can never write outside a directory the caller exclusively created.
  let runDirStats;
  try {
    runDirStats = lstatSync(runDirectory);
  } catch (error) {
    return result('RUN_DIRECTORY_UNUSABLE', target, safeErrnoCode(error));
  }
  if (!runDirStats.isDirectory() || runDirStats.isSymbolicLink()) {
    return result('RUN_DIRECTORY_UNUSABLE', target, null);
  }

  if (pathContainsLink(runDirectory)) {
    return result('PATH_CONTAINS_LINK', target, null);
  }

  // Exclusive create. No prior existence check: `wx` asks the kernel to create
  // the file *or* fail, in one step, which is the only race-free way to ask.
  let handle: number;
  try {
    handle = openSync(target, 'wx', 0o600);
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    return result(errnoCode === 'EEXIST' ? 'TARGET_EXISTS' : 'OPEN_FAILED', target, errnoCode);
  }

  const buffer = Buffer.from(request.contents, 'utf8');
  let offset = 0;
  let synced = false;
  let closed = false;

  try {
    // `writeSync` may write fewer bytes than asked for; loop until the whole
    // buffer is out, so a short write is never mistaken for a complete one.
    while (offset < buffer.length) {
      const written = writeSync(handle, buffer, offset, buffer.length - offset);
      if (written <= 0) break;
      offset += written;
    }
    if (offset !== buffer.length) {
      closeSync(handle);
      closed = true;
      return result('WRITE_FAILED', target, null, offset);
    }
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    closeQuietly(handle);
    return result('WRITE_FAILED', target, errnoCode, offset);
  }

  try {
    fsyncSync(handle);
    synced = true;
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    if (!FSYNC_UNSUPPORTED_CODES.has(errnoCode)) {
      closeQuietly(handle);
      return result('SYNC_FAILED', target, errnoCode, offset);
    }
    // Not supported here. Recorded as `synced: false`, not as success-by-silence.
  }

  try {
    closeSync(handle);
    closed = true;
  } catch (error) {
    return result('CLOSE_FAILED', target, safeErrnoCode(error), offset, synced);
  }

  return closed ? result('WRITTEN', target, null, offset, synced) : result('CLOSE_FAILED', target, null, offset, synced);
}

/** Best-effort close on a failure path. The failure code is already decided. */
function closeQuietly(handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // Nothing to add: the caller is already returning a failure.
  }
}
