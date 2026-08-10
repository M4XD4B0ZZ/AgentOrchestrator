/**
 * Whether two filesystem paths denote the same place — and when that question
 * may be asked at all.
 *
 * ── Why a relative path has no identity here ───────────────────────────────
 *
 * A relative path is not a location. It becomes one only by being resolved
 * against a base, and the only base available inside a pure comparison is
 * `process.cwd()`. Using it would make "is this state's repository the
 * repository I just resolved?" depend on the directory the operator's shell
 * happened to be standing in: a persisted `repositoryRoot` of `"."` would
 * compare *equal* to whichever checkout the process was launched from, and a
 * record belonging to one project could be accepted as a record of another.
 *
 * So the contract is three-valued rather than boolean:
 *
 *   absolute A vs absolute B  →  `EQUAL` / `DIFFERENT`
 *   anything relative         →  `NOT_ABSOLUTE`
 *
 * `NOT_ABSOLUTE` is a refusal to answer, and every caller fails closed on it.
 * Note what this module deliberately does *not* offer: a way to "fix" a
 * relative input by resolving it. There is no correct base to resolve against,
 * so the only safe answer is to refuse.
 *
 * ── Lexical only ───────────────────────────────────────────────────────────
 *
 * No I/O: no `realpath`, no `stat`, no symlink resolution. A caller that needs
 * symlinks resolved does that itself and passes the canonical result in — as
 * `automatic-resume.ts` documents for its observed paths. What happens here is
 * the purely lexical part, and it is done with `path.normalize()` rather than
 * `path.resolve()` precisely because `resolve()` consults `process.cwd()`:
 *
 *  - `.` and `..` segments are folded away;
 *  - separator shape is unified (`D:/repo` and `D:\repo` on Windows);
 *  - a trailing separator is dropped;
 *  - the comparison is case-insensitive on Windows and exact elsewhere.
 */

import { isAbsolute, normalize, sep as pathSep } from 'node:path';

/**
 * The answer to "are these the same place?", including the case where the
 * question cannot be answered.
 */
export const PATH_IDENTITY_VERDICTS = ['EQUAL', 'DIFFERENT', 'NOT_ABSOLUTE'] as const;

export type PathIdentityVerdict = (typeof PATH_IDENTITY_VERDICTS)[number];

/** The lexical canonical form of an absolute path, for comparison only. */
function canonicalise(value: string): string {
  const normalised = normalize(value);
  const trimmed =
    normalised.length > 1 && normalised.endsWith(pathSep)
      ? normalised.slice(0, -1)
      : normalised;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** `true` when `value` can be compared at all: non-blank and absolute. */
export function isComparablePath(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && isAbsolute(value);
}

/**
 * Compares two paths as identities.
 *
 * Returns `NOT_ABSOLUTE` if *either* side is blank or relative, without
 * inspecting the other: an unanswerable question has no partial answer.
 */
export function comparePathIdentity(a: string, b: string): PathIdentityVerdict {
  if (!isComparablePath(a) || !isComparablePath(b)) return 'NOT_ABSOLUTE';
  return canonicalise(a) === canonicalise(b) ? 'EQUAL' : 'DIFFERENT';
}

/**
 * `true` only for two absolute paths that denote the same place.
 *
 * A relative input is `false`, never "equal after resolving": callers that
 * must tell "different place" from "not a comparable path" use
 * {@link comparePathIdentity} instead.
 */
export function absolutePathsEqual(a: string, b: string): boolean {
  return comparePathIdentity(a, b) === 'EQUAL';
}
