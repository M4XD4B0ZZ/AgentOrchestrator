/**
 * Path safety primitives and exclusive, atomic artefact writing (AO-007).
 *
 * Every persistent doctor artefact goes through {@link writeRunArtifact}. The
 * rules it enforces, all fail-closed:
 *
 *  1. **Containment.** The file name must be a single plain segment, and the
 *     resolved target must still sit directly inside the run directory it was
 *     given. `..`, absolute paths and separators are rejected outright.
 *  2. **No links in the path.** Every segment from the filesystem root down to
 *     the run directory is `lstat`ed. A symbolic link or a Windows junction
 *     anywhere along it aborts the write — otherwise a link planted inside the
 *     application-data root would redirect the artefact somewhere else.
 *  3. **Nothing is ever replaced.** An existing target — regular file,
 *     directory, link, anything — aborts the write. There is no ownership
 *     check and no overwrite path, because there is nothing to overwrite: each
 *     run gets its own freshly created directory (see `run-directory.ts`).
 *
 *     This replaces the old content-marker ownership test (AO-007-R2). A marker
 *     that is written into a public artefact is not a secret, so anyone able to
 *     drop a file in the diagnostics directory could also put the marker in it
 *     and have the doctor overwrite their file. Immutable per-run directories
 *     make the question moot.
 *  4. **Exclusive create, atomic finalisation.** Content goes to a uniquely
 *     named temporary file in the *same* run directory, created with `wx`, and
 *     is then finalised by an atomic exclusive `link`. If the target appeared
 *     in the meantime, the link fails with `EEXIST` and the write is abandoned.
 *  5. **Temporary cleanup.** The temporary file is removed on every path,
 *     including every failure path, and the result says whether it is gone.
 *
 * Failures are returned as fixed codes, never as exception messages (AO-002).
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  /** The temporary file could not be written. */
  | 'WRITE_FAILED'
  /** The temporary file could not be finalised into the target. */
  | 'FINALIZE_FAILED';

export interface RunArtifactResult {
  readonly code: RunArtifactCode;
  readonly written: boolean;
  /** The intended target path. Always inside the run directory. */
  readonly path: string;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
  /** `false` only if a temporary file was created and could not be removed. */
  readonly temporaryFileRemoved: boolean;
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
 * `true` when any existing segment of `target`'s path is a link.
 *
 * `lstatSync` does not follow the final component, and Node reports Windows
 * junctions as symbolic links, so both cases are covered. Segments that do not
 * exist yet are skipped — they cannot be links.
 */
export function pathContainsLink(target: string): boolean {
  for (const segment of pathChain(target)) {
    let stats;
    try {
      stats = lstatSync(segment);
    } catch {
      continue; // Not present (or not inspectable): nothing to redirect through.
    }
    if (stats.isSymbolicLink()) return true;
  }
  return false;
}

function result(
  code: RunArtifactCode,
  path: string,
  errnoCode: string | null,
  temporaryFileRemoved: boolean,
): RunArtifactResult {
  return Object.freeze({
    code,
    written: code === 'WRITTEN',
    path,
    errnoCode,
    temporaryFileRemoved,
  });
}

/**
 * Writes one artefact into a freshly created run directory, or explains
 * precisely why it did not. Never throws.
 */
export function writeRunArtifact(request: RunArtifactRequest): RunArtifactResult {
  const runDirectory = resolve(request.runDirectory);

  if (!isPlainFileName(request.fileName)) {
    return result('PATH_ESCAPES_RUN_DIRECTORY', join(runDirectory, request.fileName), null, true);
  }

  const target = resolve(runDirectory, request.fileName);
  // Belt and braces: even with a validated name, prove the result is contained.
  if (!isContained(runDirectory, target) || !samePath(dirname(target), runDirectory)) {
    return result('PATH_ESCAPES_RUN_DIRECTORY', target, null, true);
  }

  // The run directory must already exist — this function never creates one, so
  // it can never write outside a directory the caller exclusively created.
  let runDirStats;
  try {
    runDirStats = lstatSync(runDirectory);
  } catch (error) {
    return result('RUN_DIRECTORY_UNUSABLE', target, safeErrnoCode(error), true);
  }
  if (!runDirStats.isDirectory() || runDirStats.isSymbolicLink()) {
    return result('RUN_DIRECTORY_UNUSABLE', target, null, true);
  }

  if (pathContainsLink(runDirectory)) {
    return result('PATH_CONTAINS_LINK', target, null, true);
  }

  // Nothing may already occupy the target name — not a file, not a directory,
  // not a link. There is no ownership test, because nothing is ever replaced.
  if (targetExists(target)) {
    return result('TARGET_EXISTS', target, null, true);
  }

  const temporary = join(runDirectory, `.${request.fileName}.${randomUUID()}.tmp`);
  let temporaryCreated = false;

  try {
    // `wx` guarantees we never adopt an existing file as our temporary.
    writeFileSync(temporary, request.contents, { encoding: 'utf8', flag: 'wx' });
    temporaryCreated = true;
  } catch (error) {
    return result(
      'WRITE_FAILED',
      target,
      safeErrnoCode(error),
      removeTemporary(temporary, temporaryCreated),
    );
  }

  return finalize(temporary, target);
}

/** `true` when anything at all occupies `target`. */
function targetExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns the temporary file into the target atomically and exclusively.
 *
 * `link` is the primitive that gives both properties at once: it either creates
 * the target in one step or fails with `EEXIST`, so a concurrent run can never
 * be clobbered. `rename` would silently replace an existing target on both
 * Windows and POSIX and is therefore only used as a fallback for filesystems
 * without hard links — and then only after proving the target is absent.
 */
function finalize(temporary: string, target: string): RunArtifactResult {
  try {
    linkSync(temporary, target);
    return result('WRITTEN', target, null, removeTemporary(temporary, true));
  } catch (error) {
    const code = safeErrnoCode(error);
    if (code === 'EEXIST') {
      return result('TARGET_EXISTS', target, code, removeTemporary(temporary, true));
    }

    // No hard-link support (or not permitted): fall back to rename, but only
    // when the target still does not exist, so nothing is replaced.
    if (targetExists(target)) {
      return result('TARGET_EXISTS', target, code, removeTemporary(temporary, true));
    }
    try {
      renameSync(temporary, target);
      // The rename consumed the temporary file.
      return result('WRITTEN', target, null, true);
    } catch (renameError) {
      return result(
        'FINALIZE_FAILED',
        target,
        safeErrnoCode(renameError),
        removeTemporary(temporary, true),
      );
    }
  }
}

/** Removes the temporary file if it exists; reports whether it is gone. */
function removeTemporary(temporary: string, created: boolean): boolean {
  if (!created) return true;
  try {
    rmSync(temporary, { force: true });
  } catch {
    // Fall through to the existence check.
  }
  return !existsSync(temporary);
}
