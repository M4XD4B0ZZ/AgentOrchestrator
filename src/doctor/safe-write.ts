/**
 * Containment-checked, atomic writing of diagnostics artefacts (AO-007).
 *
 * Every persistent doctor artefact goes through this module. The rules it
 * enforces, all fail-closed:
 *
 *  1. **Containment.** The file name must be a single plain segment, and the
 *     resolved target must still sit inside the trusted application-data root.
 *     `..`, absolute paths and separators are rejected outright.
 *  2. **No links in the path.** Every segment from the filesystem root down to
 *     the target directory is `lstat`ed. A symbolic link or a Windows junction
 *     anywhere along it aborts the write — otherwise a link planted inside the
 *     application-data root would redirect the report somewhere else.
 *  3. **Regular files only.** An existing target must be a regular file. A
 *     directory, a symlink or any other reparse point is refused.
 *  4. **No foreign files.** An existing target must carry this tool's own
 *     ownership marker. The doctor replaces its own reports and nothing else.
 *  5. **Atomic replacement.** Content is written to a uniquely named temporary
 *     file in the same directory and then renamed over the target, so a crash
 *     mid-write can never leave a half-written report behind.
 *  6. **Temporary cleanup.** The temporary file is removed on every path,
 *     including every failure path, and the result says whether it is gone.
 *
 * Failures are returned as fixed codes, never as exception messages (AO-002).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';

export type DiagnosticWriteCode =
  | 'WRITTEN'
  /** The file name is not a single plain segment, or escapes the root. */
  | 'PATH_ESCAPES_ROOT'
  /** A symlink/junction was found in the target directory path. */
  | 'PATH_CONTAINS_LINK'
  /** The containment root could not be created. */
  | 'ROOT_CREATE_FAILED'
  /** An existing target is not a regular file. */
  | 'TARGET_NOT_REGULAR_FILE'
  /** An existing target is a regular file this tool does not own. */
  | 'TARGET_FOREIGN_FILE'
  /** The temporary file could not be written. */
  | 'WRITE_FAILED'
  /** The temporary file could not be renamed over the target. */
  | 'REPLACE_FAILED';

export interface DiagnosticWriteResult {
  readonly code: DiagnosticWriteCode;
  readonly written: boolean;
  /** The intended target path. Always inside the containment root. */
  readonly path: string;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
  /** `false` only if a temporary file was created and could not be removed. */
  readonly temporaryFileRemoved: boolean;
}

export interface DiagnosticWriteRequest {
  /** Trusted containment root; created if missing. */
  readonly root: string;
  /** A single plain file name, e.g. `doctor-report.json`. */
  readonly fileName: string;
  readonly contents: string;
  /**
   * Text that must appear in an existing target before it may be replaced.
   * This is what stops the doctor from overwriting a foreign file that happens
   * to share the name.
   */
  readonly ownershipMarker: string;
}

/** A plain file name: no separators, no `..`, no drive letters. */
const SAFE_FILE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

function isPlainFileName(name: string): boolean {
  if (!SAFE_FILE_NAME.test(name)) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('..')) return false;
  return !name.includes('/') && !name.includes('\\') && !isAbsolute(name);
}

/** Case-insensitive on Windows, exact elsewhere. */
function samePath(a: string, b: string): boolean {
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
  code: DiagnosticWriteCode,
  path: string,
  errnoCode: string | null,
  temporaryFileRemoved: boolean,
): DiagnosticWriteResult {
  return Object.freeze({ code, written: code === 'WRITTEN', path, errnoCode, temporaryFileRemoved });
}

/**
 * Writes one diagnostics artefact, or explains precisely why it did not.
 * Never throws.
 */
export function writeDiagnosticFile(request: DiagnosticWriteRequest): DiagnosticWriteResult {
  const root = resolve(request.root);

  if (!isPlainFileName(request.fileName)) {
    return result('PATH_ESCAPES_ROOT', join(root, request.fileName), null, true);
  }

  const target = resolve(root, request.fileName);
  // Belt and braces: even with a validated name, prove the result is contained.
  if (!isContained(root, target) || !samePath(dirname(target), root)) {
    return result('PATH_ESCAPES_ROOT', target, null, true);
  }

  // Reject links on whatever part of the path already exists, *before* creating
  // anything: creating through a junction would already be a redirected write.
  if (pathContainsLink(root)) {
    return result('PATH_CONTAINS_LINK', target, null, true);
  }

  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    return result('ROOT_CREATE_FAILED', target, safeErrnoCode(error), true);
  }

  // Re-check after creation: a racing writer could have planted a link.
  if (pathContainsLink(root)) {
    return result('PATH_CONTAINS_LINK', target, null, true);
  }

  // The target itself must be either absent or a regular file we own.
  let targetStats;
  try {
    targetStats = lstatSync(target);
  } catch {
    targetStats = null;
  }

  if (targetStats !== null) {
    if (!targetStats.isFile()) {
      return result('TARGET_NOT_REGULAR_FILE', target, null, true);
    }
    let existing: string;
    try {
      existing = readFileSync(target, 'utf8');
    } catch (error) {
      return result('TARGET_FOREIGN_FILE', target, safeErrnoCode(error), true);
    }
    if (!existing.includes(request.ownershipMarker)) {
      return result('TARGET_FOREIGN_FILE', target, null, true);
    }
  }

  const temporary = join(root, `.${request.fileName}.${randomUUID()}.tmp`);
  let temporaryCreated = false;

  try {
    // `wx` guarantees we never adopt an existing file as our temporary.
    writeFileSync(temporary, request.contents, { encoding: 'utf8', flag: 'wx' });
    temporaryCreated = true;
  } catch (error) {
    const removed = removeTemporary(temporary, temporaryCreated);
    return result('WRITE_FAILED', target, safeErrnoCode(error), removed);
  }

  try {
    renameSync(temporary, target);
    // The rename consumed the temporary file.
    return result('WRITTEN', target, null, true);
  } catch (error) {
    const removed = removeTemporary(temporary, temporaryCreated);
    return result('REPLACE_FAILED', target, safeErrnoCode(error), removed);
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
