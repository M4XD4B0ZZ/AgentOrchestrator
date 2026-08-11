/**
 * The one safe way to open a file inside a repository's task source.
 *
 * ── Why this is its own module ─────────────────────────────────────────────
 *
 * The chain below — classify with `lstat`, refuse a link outright, cap the
 * size before reading, re-canonicalise and re-test containment, then read — is
 * not a convenience wrapper around `readFileSync`. Every step of it is a
 * refusal that `discover-tasks.ts` documents at length, and the order matters:
 * following a link first and asking afterwards is the classic escape, because
 * the answers would describe the target while the path that gets used is still
 * the link.
 *
 * More than one caller now needs that chain — discovery reads task files, and
 * the brief reader reads a task file and the profile's declared context
 * sources. Restating it in each would be a second opinion about what "safe to
 * open" means, and the copies could drift while both callers' suites stayed
 * green. So it is owned here, once.
 *
 * ── What it does not do ────────────────────────────────────────────────────
 *
 * It maps nothing to a caller's vocabulary. It answers in {@link ReadRefusal},
 * a set of three facts about the filesystem, and each caller translates those
 * into its own closed failure codes — because "this file is a symlink" means
 * `TASK_FILE_UNSAFE` to discovery and `CONTEXT_SOURCE_UNSAFE` to the brief
 * reader, and those are different sentences for the same fact.
 *
 * It also never composes a path. Callers pass an already-joined absolute path
 * and the canonical root it must stay inside; deciding *which* file to open is
 * policy, and policy belongs to the caller.
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

/** `true` when `candidate` is `root` itself or lies beneath it. */
export function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** `true` when the two canonical paths denote the same location. */
export function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

export type Entry =
  | { readonly kind: 'DIRECTORY' }
  | { readonly kind: 'FILE'; readonly size: number }
  | { readonly kind: 'OTHER' }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'LINK' }
  | { readonly kind: 'UNREADABLE' };

/**
 * Classifies a path with `lstat`, so a link is *seen* rather than followed.
 *
 * Following first and asking afterwards is the classic escape: the answers
 * would describe the target while the path that gets used is still the link.
 */
export function classify(path: string): Entry {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'ABSENT' };
    return { kind: 'UNREADABLE' };
  }
  if (stats.isSymbolicLink()) return { kind: 'LINK' };
  if (stats.isDirectory()) return { kind: 'DIRECTORY' };
  if (stats.isFile()) return { kind: 'FILE', size: stats.size };
  return { kind: 'OTHER' };
}

/**
 * Why a read was refused. Three facts, kept apart because they send an
 * operator to three different places: something is wrong with the *path*,
 * something is wrong with the *size*, or the file simply could not be read.
 */
export type ReadRefusal = 'UNSAFE' | 'TOO_LARGE' | 'READ_FAILED';

export type SafeReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly refusal: ReadRefusal };

/**
 * Reads a regular file that must lie inside `root`, or refuses.
 *
 * `path` must already be absolute and joined by the caller. Never throws: an
 * unreadable file, a link, a directory, a device and an oversized document are
 * all refusals, and no fragment of the path or of any exception escapes.
 */
export function readContainedFile(
  root: string,
  path: string,
  maxBytes: number,
): SafeReadResult {
  if (!isContained(root, path)) return { ok: false, refusal: 'UNSAFE' };

  const entry = classify(path);
  if (entry.kind === 'LINK' || entry.kind === 'DIRECTORY' || entry.kind === 'OTHER') {
    return { ok: false, refusal: 'UNSAFE' };
  }
  if (entry.kind === 'ABSENT' || entry.kind === 'UNREADABLE') {
    return { ok: false, refusal: 'READ_FAILED' };
  }
  if (entry.size > maxBytes) return { ok: false, refusal: 'TOO_LARGE' };

  // No segment of this path is a link, so its canonical form must be itself.
  // A difference means something changed underneath us between the checks.
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return { ok: false, refusal: 'READ_FAILED' };
  }
  if (!samePath(path, canonical)) return { ok: false, refusal: 'UNSAFE' };
  // And the canonical form must still be inside the root it was checked against.
  if (!isContained(root, canonical)) return { ok: false, refusal: 'UNSAFE' };

  try {
    return { ok: true, text: readFileSync(canonical, 'utf8') };
  } catch {
    return { ok: false, refusal: 'READ_FAILED' };
  }
}
