/**
 * The one implementation of "is this path safe to touch, and what is it?".
 *
 * ── Why this module exists, and where it lives ─────────────────────────────
 *
 * Three modules used to hold this chain: the repository resolver (for the
 * profile), task discovery (for task files) and the brief reader (for context
 * sources). V2-02 claimed to have reduced that to one owner and had not — the
 * resolver still held byte-identical `isContained`, `samePath` and `classify`
 * and ran the same six steps inline. This module is the claim made true.
 *
 * It sits under `repo/` because `plan/` already depends on `repo/` and not the
 * other way round; putting the primitive in `plan/internal/` would have
 * inverted that.
 *
 * ── What is shared, and what deliberately is not ───────────────────────────
 *
 * Shared: the *security* chain. Classify with `lstat` so a link is seen rather
 * than followed; refuse a link outright; re-canonicalise; re-test containment.
 * Following a link first and asking afterwards is the classic escape, because
 * the answers describe the target while the path that gets used is still the
 * link.
 *
 * Not shared: the *type policy* and the *vocabulary*. Whether a directory is
 * acceptable, what size a document may have, and what each refusal is called
 * are the caller's business — "this is a symlink" is `PROFILE_PATH_UNSAFE` to
 * the resolver, `TASK_FILE_UNSAFE` to discovery and an `UNSAFE` context-source
 * status to the brief. Callers may differ there; they may not each re-derive
 * the safety chain.
 */

import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

/**
 * `true` when `candidate` is `root` itself or lies beneath it.
 *
 * `path.relative` is the comparison, so the platform's own rules apply —
 * including case-insensitive matching on Windows, where treating `D:\Repo` and
 * `D:\repo` as different roots would be a containment hole rather than rigour.
 */
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
 * Why a path was refused. Three facts, kept apart because they send an
 * operator to three different places: something is wrong with the *path*,
 * something is wrong with the *size*, or it could not be read at all.
 */
export type ReadRefusal = 'UNSAFE' | 'TOO_LARGE' | 'READ_FAILED';

export type SafeReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly refusal: ReadRefusal };

/**
 * Runs the safety chain over `path` and returns the canonical path it proved,
 * or the refusal that stopped it. `maxBytes` is optional: pass it only when the
 * caller is going to *parse* the bytes and therefore needs a parsing ceiling.
 */
function proveRegularFile(
  root: string,
  path: string,
  maxBytes: number | null,
): { readonly ok: true; readonly canonical: string } | { readonly ok: false; readonly refusal: ReadRefusal } {
  if (!isContained(root, path)) return { ok: false, refusal: 'UNSAFE' };

  const entry = classify(path);
  if (entry.kind === 'LINK' || entry.kind === 'DIRECTORY' || entry.kind === 'OTHER') {
    return { ok: false, refusal: 'UNSAFE' };
  }
  if (entry.kind === 'ABSENT' || entry.kind === 'UNREADABLE') {
    return { ok: false, refusal: 'READ_FAILED' };
  }
  if (maxBytes !== null && entry.size > maxBytes) return { ok: false, refusal: 'TOO_LARGE' };

  // No segment of this path is a link, so its canonical form must be itself.
  // A difference means something changed underneath us between the checks.
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return { ok: false, refusal: 'READ_FAILED' };
  }
  if (!samePath(path, canonical)) return { ok: false, refusal: 'UNSAFE' };
  if (!isContained(root, canonical)) return { ok: false, refusal: 'UNSAFE' };

  return { ok: true, canonical };
}

/**
 * Reads a regular file that must lie inside `root`, or refuses.
 *
 * `maxBytes` is a **parsing** ceiling and is mandatory here, because every
 * caller of this function goes on to parse what it read. A caller that only
 * needs to know whether a file is there and openable must use
 * {@link inspectContainedFile} instead — see the note there about what
 * borrowing this ceiling cost.
 */
export function readContainedFile(root: string, path: string, maxBytes: number): SafeReadResult {
  const proved = proveRegularFile(root, path, maxBytes);
  if (!proved.ok) return proved;

  try {
    return { ok: true, text: readFileSync(proved.canonical, 'utf8') };
  } catch {
    return { ok: false, refusal: 'READ_FAILED' };
  }
}

/** Why a directory was refused. Four facts; each caller names them itself. */
export type DirectoryRefusal = 'UNSAFE' | 'MISSING' | 'NOT_A_DIRECTORY' | 'UNREADABLE';

export type DirectoryResult =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly refusal: DirectoryRefusal };

/**
 * Proves a path is a real directory inside `root`, and returns its canonical
 * form.
 *
 * The directory counterpart of {@link readContainedFile}, and here for the same
 * reason: task discovery and the brief reader both need it, and each had its
 * own copy of the same four steps. The refusals stay separate because the
 * callers name them differently — an absent task source is
 * `TASK_SOURCE_NOT_FOUND` to discovery, while the brief only cares that it is
 * not usable.
 */
export function proveContainedDirectory(root: string, path: string): DirectoryResult {
  if (!isContained(root, path) || samePath(root, path)) return { ok: false, refusal: 'UNSAFE' };

  const entry = classify(path);
  if (entry.kind === 'LINK') return { ok: false, refusal: 'UNSAFE' };
  if (entry.kind === 'ABSENT') return { ok: false, refusal: 'MISSING' };
  if (entry.kind === 'UNREADABLE') return { ok: false, refusal: 'UNREADABLE' };
  if (entry.kind !== 'DIRECTORY') return { ok: false, refusal: 'NOT_A_DIRECTORY' };

  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return { ok: false, refusal: 'UNREADABLE' };
  }
  if (!samePath(path, canonical) || !isContained(root, canonical)) {
    return { ok: false, refusal: 'UNSAFE' };
  }
  return { ok: true, canonical };
}

/** What an inspection concluded about a path nobody intends to parse. */
export type InspectRefusal = 'UNSAFE' | 'MISSING' | 'UNREADABLE';

export type InspectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: InspectRefusal };

/**
 * Proves a path is a regular file inside `root` that can be opened read-only —
 * and reads none of it.
 *
 * ── Why there is no size ceiling here ──────────────────────────────────────
 *
 * Because nothing is parsed. The brief reader used to borrow
 * {@link readContainedFile} and its 256 KiB *task-file parsing* ceiling to
 * check declared context sources, then throw the bytes away. The ceiling
 * protected nothing and manufactured a false verdict: an architecture note or
 * an OpenAPI spec over 256 KiB was reported unreadable, and once execution
 * gated on that verdict, no task in such a repository could run at all.
 *
 * So the question this answers is exactly the question that was being asked:
 * is the path there, is it safe, is it a regular file, and does it open? The
 * byte budget for actually *loading* context is a separate contract, and it
 * belongs wherever that loading is eventually implemented — not here.
 *
 * The open-and-close is deliberate rather than a `stat`: permissions, locks
 * and a filesystem that lies about a directory entry are only settled by an
 * `open` succeeding.
 */
export function inspectContainedFile(root: string, path: string): InspectResult {
  const proved = proveRegularFile(root, path, null);
  if (!proved.ok) {
    // `READ_FAILED` from the chain means absent-or-unstattable; the two are
    // different facts to an operator, and `classify` already separated them.
    if (proved.refusal === 'UNSAFE') return { ok: false, refusal: 'UNSAFE' };
    return { ok: false, refusal: classify(path).kind === 'ABSENT' ? 'MISSING' : 'UNREADABLE' };
  }

  let handle: number;
  try {
    handle = openSync(proved.canonical, 'r');
  } catch {
    return { ok: false, refusal: 'UNREADABLE' };
  }
  try {
    closeSync(handle);
  } catch {
    // The file opened, which is what was asked. A failure to close is this
    // process's problem, not a fact about the repository.
  }
  return { ok: true };
}
