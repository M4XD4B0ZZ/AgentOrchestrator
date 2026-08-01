/**
 * The `COMPLETED` marker: the only thing that makes a run consumable
 * (AO-007-R2-RR2).
 *
 * ── The problem it solves ──────────────────────────────────────────────────
 *
 * A run directory is created before anything is written into it, and its
 * artefacts are written one after another. At every moment in between, the
 * directory on disk looks like a run — it just is not one yet. Without an
 * explicit end-of-run signal, a reader cannot distinguish
 *
 *  - a finished run,
 *  - a run whose report write failed halfway,
 *  - a run whose process was killed between the two artefacts,
 *  - a directory somebody else created,
 *
 * and the old design tried to paper over that by having the report claim its
 * own successful persistence. A document cannot attest to the success of
 * writing itself.
 *
 * ── The protocol ───────────────────────────────────────────────────────────
 *
 * A run is complete if and only if its directory contains exactly three
 * direct entries — {@link REQUIRED_ARTEFACT_NAMES} plus the marker — and the
 * marker holds exactly {@link COMPLETION_MARKER_CONTENTS}, byte for byte. The
 * marker is:
 *
 *  - written **last**, after every artefact is fully written, synced and
 *    closed;
 *  - written only once all of {@link completeRun}'s closing checks pass —
 *    the directory must contain exactly the expected artefacts, no more and no
 *    fewer, and in particular no partial file, no symlink and no junction;
 *  - re-checked once more, together with the whole three-entry structure,
 *    immediately after being written — a run is never reported successful on
 *    the strength of the write call alone;
 *  - created with exclusive `wx` semantics, so it is never replaced. An
 *    existing marker means somebody else's run, and that is a hard failure;
 *  - free of anything run-specific. It carries a fixed format version and
 *    nothing else: no path, no timestamp, no host, no user, no status.
 *
 * ── Producer and consumer share one contract (AO-007-R2-RR2-REVIEW-01) ─────
 *
 * {@link completeRun} (producer) and {@link inspectRun} (consumer) both
 * validate the run id against the single schema in `run-directory.ts`
 * ({@link isValidRunId}), both reject a run reached through a symlink or a
 * Windows junction — checked with `lstat`, never `stat`, and never by trusting
 * `realpath` alone, since `realpath` has already resolved the link by the time
 * containment could be checked — and both apply the exact same three-entry
 * structure rule from {@link checkExactEntries}. There is no second, looser
 * copy of any of these rules.
 *
 * {@link inspectRun} additionally binds every lookup to a trusted
 * `runsRoot`: the run path is computed *only* as `join(runsRoot, runId)`,
 * never taken as an arbitrary caller-supplied path, and the result must be a
 * lexical and canonical direct child of `runsRoot` with no link anywhere
 * between them. This is what stops a validly named Windows junction under
 * `runsRoot`, pointing at an external directory that holds nothing but a
 * planted marker, from ever being treated as a completed run.
 *
 * Consumers **must** ignore a run directory that fails any of these checks.
 * The run may still be inspected by a human for diagnosis — incomplete or
 * malformed artefacts are left in place on purpose — but it is not data.
 * {@link listCompletedRuns} is the supported way to enumerate runs and
 * implements exactly that rule.
 */

import { type Dirent, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';
import { isValidRunId } from './run-directory.js';
import { isContained, isPlainFileName, pathContainsLink, samePath, writeRunArtifact } from './safe-write.js';

/** The marker file name. A plain segment, like every artefact name. */
export const COMPLETION_MARKER_FILE_NAME = 'COMPLETED';

/**
 * The run-protocol version, and the entire content of the marker.
 *
 * Fixed and non-sensitive by construction. A reader that does not recognise
 * this exact value must treat the run as unusable rather than guess.
 */
export const RUN_PROTOCOL_VERSION = 'agent-loop-doctor-run/1';

/** The marker's byte-for-byte content. */
export const COMPLETION_MARKER_CONTENTS = `${RUN_PROTOCOL_VERSION}\n`;

/** The same content, as the exact bytes a valid marker must match. */
const COMPLETION_MARKER_BYTES = Buffer.from(COMPLETION_MARKER_CONTENTS, 'utf8');

/**
 * The two artefacts every run writes, and the only ones — besides the marker
 * — a completed run may hold. Fixed here, in the one module both the producer
 * ({@link completeRun}) and the consumer ({@link inspectRun}) read the run's
 * shape from, so the two can never drift apart.
 */
export const REQUIRED_ARTEFACT_NAMES = ['cli-capabilities.txt', 'doctor-report.json'] as const;

export type RunCompletionCode =
  /** The marker was created and the closing re-validation passed. */
  | 'COMPLETED'
  /** The run directory's own name is not a valid run id. */
  | 'INVALID_RUN_ID'
  /** The run directory, or something on its path, is a symlink or junction. */
  | 'RUN_PATH_IS_LINK'
  /** An expected artefact is missing from the run directory, empty, or not a file. */
  | 'ARTEFACTS_MISSING'
  /** An expected artefact exists but is itself a symlink or junction. */
  | 'ARTEFACT_IS_LINK'
  /** The directory holds something that is not an expected artefact. */
  | 'UNEXPECTED_DIRECTORY_CONTENTS'
  /** An expected artefact name is not a plain single segment. Caller bug. */
  | 'INVALID_ARTEFACT_NAME'
  /** The run directory could not be inspected. */
  | 'RUN_DIRECTORY_UNREADABLE'
  /** A marker is already there. Never replaced; the run is not adopted. */
  | 'MARKER_EXISTS'
  /** The marker could not be written. The run stays incomplete. */
  | 'MARKER_WRITE_FAILED'
  /** The structure no longer validated immediately after the marker was written. */
  | 'POST_COMPLETION_VALIDATION_FAILED';

export interface RunCompletionResult {
  readonly code: RunCompletionCode;
  readonly completed: boolean;
  readonly markerPath: string;
  readonly protocolVersion: string;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

export interface RunCompletionRequest {
  readonly runDirectory: string;
  /**
   * Exactly the artefact names this run wrote. The directory must contain
   * these and nothing else — that is what proves no partial or unexpected
   * file was left behind.
   */
  readonly expectedArtefacts: readonly string[];
}

function completion(
  code: RunCompletionCode,
  markerPath: string,
  errnoCode: string | null,
): RunCompletionResult {
  return Object.freeze({
    code,
    completed: code === 'COMPLETED',
    markerPath,
    protocolVersion: RUN_PROTOCOL_VERSION,
    errnoCode,
  });
}

// ── Shared structural check ─────────────────────────────────────────────────

/** What lives at a path, decided with `lstat` — the link itself is never followed. */
function classifyEntry(path: string): 'MISSING' | 'LINK' | 'FILE' | 'OTHER' {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return 'MISSING';
  }
  if (stats.isSymbolicLink()) return 'LINK';
  if (stats.isFile()) return 'FILE';
  return 'OTHER';
}

interface ExactEntriesCheck {
  /** `true` only when `readdir` itself failed; every other field is then empty. */
  readonly unreadable: boolean;
  readonly errnoCode: string | null;
  readonly missing: readonly string[];
  /** Present, but neither a regular file nor a link (a directory, typically). */
  readonly notRegular: readonly string[];
  readonly links: readonly string[];
  /** Directory entries that are not part of the expected set at all. */
  readonly unexpected: readonly string[];
}

/**
 * The exact-structure rule shared by producer and consumer: the directory
 * must hold precisely `expectedNames`, each a direct, non-empty, regular file
 * — checked with `lstat`, so a symlink or junction sharing the right name is
 * never mistaken for the entry it claims to be.
 */
function checkExactEntries(directory: string, expectedNames: readonly string[]): ExactEntriesCheck {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    return {
      unreadable: true,
      errnoCode: safeErrnoCode(error),
      missing: [],
      notRegular: [],
      links: [],
      unexpected: [],
    };
  }

  const expected = new Set(expectedNames);
  const present = new Set(names);
  const unexpected = names.filter((name) => !expected.has(name));

  const missing: string[] = [];
  const notRegular: string[] = [];
  const links: string[] = [];

  for (const name of expectedNames) {
    if (!present.has(name)) {
      missing.push(name);
      continue;
    }
    const kind = classifyEntry(join(directory, name));
    if (kind === 'MISSING') missing.push(name);
    else if (kind === 'LINK') links.push(name);
    else if (kind === 'OTHER') notRegular.push(name);
  }

  return { unreadable: false, errnoCode: null, missing, notRegular, links, unexpected };
}

// ── Producer side ───────────────────────────────────────────────────────────

/**
 * Runs the closing checks and, only if they all pass, creates the marker.
 *
 * Never throws. A `false` in {@link RunCompletionResult.completed} always means
 * the run must be treated as incomplete, whatever else is on disk.
 */
export function completeRun(request: RunCompletionRequest): RunCompletionResult {
  const runDirectory = resolve(request.runDirectory);
  const markerPath = join(runDirectory, COMPLETION_MARKER_FILE_NAME);

  for (const name of request.expectedArtefacts) {
    if (!isPlainFileName(name)) return completion('INVALID_ARTEFACT_NAME', markerPath, null);
  }

  // The run id is the directory's own name. Re-validated here against the
  // same schema the producer used to create it (AO-007-R2-RR2-REVIEW-01):
  // nothing downstream of this point trusts the caller's path alone.
  if (!isValidRunId(basename(runDirectory))) {
    return completion('INVALID_RUN_ID', markerPath, null);
  }

  // Every segment on the way to the run directory, and the run directory
  // itself, must be link-free before it is read or written to at all.
  if (pathContainsLink(runDirectory)) {
    return completion('RUN_PATH_IS_LINK', markerPath, null);
  }

  let runDirStats;
  try {
    runDirStats = lstatSync(runDirectory);
  } catch (error) {
    return completion('RUN_DIRECTORY_UNREADABLE', markerPath, safeErrnoCode(error));
  }
  if (runDirStats.isSymbolicLink()) return completion('RUN_PATH_IS_LINK', markerPath, null);
  if (!runDirStats.isDirectory()) return completion('RUN_DIRECTORY_UNREADABLE', markerPath, null);

  const before = checkExactEntries(runDirectory, request.expectedArtefacts);
  if (before.unreadable) {
    return completion('RUN_DIRECTORY_UNREADABLE', markerPath, before.errnoCode);
  }
  if (before.unexpected.includes(COMPLETION_MARKER_FILE_NAME)) {
    // Somebody — or some earlier attempt — already closed this directory. It is
    // never re-opened and never re-marked.
    return completion('MARKER_EXISTS', markerPath, null);
  }
  if (before.unexpected.length > 0) {
    // Anything beyond the expected set — a leftover, a partial write under
    // another name, a planted file — blocks completion.
    return completion('UNEXPECTED_DIRECTORY_CONTENTS', markerPath, null);
  }
  if (before.links.length > 0) return completion('ARTEFACT_IS_LINK', markerPath, null);
  if (before.missing.length > 0 || before.notRegular.length > 0) {
    return completion('ARTEFACTS_MISSING', markerPath, null);
  }

  // Every expected entry is confirmed to be a direct, non-linked regular
  // file. It must also be non-empty, which `checkExactEntries` does not test.
  for (const name of request.expectedArtefacts) {
    let stats;
    try {
      stats = lstatSync(join(runDirectory, name));
    } catch (error) {
      return completion('ARTEFACTS_MISSING', markerPath, safeErrnoCode(error));
    }
    if (stats.size === 0) return completion('ARTEFACTS_MISSING', markerPath, null);
  }

  const write = writeRunArtifact({
    runDirectory,
    fileName: COMPLETION_MARKER_FILE_NAME,
    contents: COMPLETION_MARKER_CONTENTS,
  });

  if (write.code === 'TARGET_EXISTS') return completion('MARKER_EXISTS', markerPath, write.errnoCode);
  if (!write.written) return completion('MARKER_WRITE_FAILED', markerPath, write.errnoCode);

  // The closing word: re-validate the exact three-entry structure with the
  // marker now in place. The run is reported successful only if this passes
  // too — never on the strength of the write call alone.
  const after = checkExactEntries(runDirectory, [...request.expectedArtefacts, COMPLETION_MARKER_FILE_NAME]);
  const afterOk =
    !after.unreadable &&
    after.unexpected.length === 0 &&
    after.missing.length === 0 &&
    after.notRegular.length === 0 &&
    after.links.length === 0;
  if (!afterOk) {
    return completion('POST_COMPLETION_VALIDATION_FAILED', markerPath, after.errnoCode);
  }

  return completion('COMPLETED', markerPath, null);
}

// ── Consumer side ──────────────────────────────────────────────────────────

export type RunInspectionCode =
  | 'COMPLETE'
  /** The run id is not a valid single path segment. */
  | 'INVALID_RUN_ID'
  /** `runsRoot` itself is not a canonical, existing, link-free directory. */
  | 'RUNS_ROOT_INVALID'
  /** The computed run path would not sit directly inside `runsRoot`. */
  | 'RUN_OUTSIDE_ROOT'
  /** The run path, or something on the way to it, is a symlink or junction. */
  | 'RUN_PATH_IS_LINK'
  /** The run directory holds something other than exactly the expected entries. */
  | 'RUN_STRUCTURE_INVALID'
  /** A required artefact is missing from the run directory. */
  | 'REQUIRED_ARTIFACT_MISSING'
  /** A required artefact exists but is not a regular file. */
  | 'REQUIRED_ARTIFACT_NOT_REGULAR'
  /** A required artefact exists but is itself a symlink or junction. */
  | 'REQUIRED_ARTIFACT_IS_LINK'
  /** No marker: the run never finished, or is still running. Ignore it. */
  | 'COMPLETION_MARKER_MISSING'
  /** The marker exists but is not a regular file. Ignore it. */
  | 'COMPLETION_MARKER_NOT_REGULAR'
  /** The marker exists but is itself a symlink or junction. Ignore it. */
  | 'COMPLETION_MARKER_IS_LINK'
  /** The marker's byte content does not match exactly. Ignore it. */
  | 'COMPLETION_MARKER_INVALID';

export interface RunInspection {
  readonly code: RunInspectionCode;
  /** The single question a consumer should ask. */
  readonly consumable: boolean;
  readonly runDirectory: string;
  readonly runId: string;
  readonly errnoCode: string | null;
}

function inspection(
  code: RunInspectionCode,
  runDirectory: string,
  runId: string,
  errnoCode: string | null,
): RunInspection {
  return Object.freeze({
    code,
    consumable: code === 'COMPLETE',
    runDirectory,
    runId,
    errnoCode,
  });
}

/**
 * Decides whether a run may be consumed.
 *
 * `runsRoot` is the caller's trusted, canonical diagnostics root — never a
 * value read back from an untrusted source — and `runId` is validated
 * independently before it is ever joined onto it. The run path is computed
 * *only* as `join(runsRoot, runId)`; nothing else this function is given can
 * influence which directory gets inspected (AO-007-R2-RR2-REVIEW-01).
 *
 * A run is consumable if and only if:
 *
 *  - `runId` matches the shared run-id schema;
 *  - `runsRoot` itself is a canonical, existing, link-free directory;
 *  - the computed run path is a direct child of `runsRoot`, lexically and
 *    canonically, with no symlink or junction anywhere between them;
 *  - the run directory holds exactly {@link REQUIRED_ARTEFACT_NAMES} plus the
 *    marker, each a direct, non-linked regular file, and nothing else;
 *  - the marker's content is byte-for-byte {@link COMPLETION_MARKER_CONTENTS}.
 */
export function inspectRun(runsRoot: string, runId: string): RunInspection {
  if (!isValidRunId(runId)) {
    return inspection('INVALID_RUN_ID', resolve(runsRoot), runId, null);
  }

  const root = resolve(runsRoot);
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch (error) {
    return inspection('RUNS_ROOT_INVALID', root, runId, safeErrnoCode(error));
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return inspection('RUNS_ROOT_INVALID', root, runId, null);
  }

  const runDirectory = join(root, runId);
  if (!isContained(root, runDirectory) || !samePath(dirname(runDirectory), root)) {
    return inspection('RUN_OUTSIDE_ROOT', runDirectory, runId, null);
  }

  // Every segment from the filesystem root down to and including the run
  // directory must be link-free. This, not `realpath`, is what catches a
  // validly named junction under `runsRoot`: `realpath` would already have
  // resolved it to whatever external directory it points at, by which point
  // containment can no longer be checked against that external target.
  if (pathContainsLink(runDirectory)) {
    return inspection('RUN_PATH_IS_LINK', runDirectory, runId, null);
  }

  let runStats;
  try {
    runStats = lstatSync(runDirectory);
  } catch (error) {
    return inspection('RUN_STRUCTURE_INVALID', runDirectory, runId, safeErrnoCode(error));
  }
  if (runStats.isSymbolicLink()) return inspection('RUN_PATH_IS_LINK', runDirectory, runId, null);
  if (!runStats.isDirectory()) return inspection('RUN_STRUCTURE_INVALID', runDirectory, runId, null);

  const expectedEntries = [...REQUIRED_ARTEFACT_NAMES, COMPLETION_MARKER_FILE_NAME];
  const structure = checkExactEntries(runDirectory, expectedEntries);
  if (structure.unreadable) {
    return inspection('RUN_STRUCTURE_INVALID', runDirectory, runId, structure.errnoCode);
  }
  if (structure.unexpected.length > 0) {
    return inspection('RUN_STRUCTURE_INVALID', runDirectory, runId, null);
  }

  for (const name of REQUIRED_ARTEFACT_NAMES) {
    if (structure.missing.includes(name)) {
      return inspection('REQUIRED_ARTIFACT_MISSING', runDirectory, runId, null);
    }
    if (structure.links.includes(name)) {
      return inspection('REQUIRED_ARTIFACT_IS_LINK', runDirectory, runId, null);
    }
    if (structure.notRegular.includes(name)) {
      return inspection('REQUIRED_ARTIFACT_NOT_REGULAR', runDirectory, runId, null);
    }
  }

  if (structure.missing.includes(COMPLETION_MARKER_FILE_NAME)) {
    return inspection('COMPLETION_MARKER_MISSING', runDirectory, runId, null);
  }
  if (structure.links.includes(COMPLETION_MARKER_FILE_NAME)) {
    return inspection('COMPLETION_MARKER_IS_LINK', runDirectory, runId, null);
  }
  if (structure.notRegular.includes(COMPLETION_MARKER_FILE_NAME)) {
    return inspection('COMPLETION_MARKER_NOT_REGULAR', runDirectory, runId, null);
  }

  // The structural check confirms the marker is a direct, non-linked regular
  // file. What remains is its exact byte content — no `trim`, no encoding
  // normalisation, a plain buffer comparison. The size is checked first so an
  // oversized planted file is rejected without ever being read in full.
  const markerPath = join(runDirectory, COMPLETION_MARKER_FILE_NAME);
  let markerStats;
  try {
    markerStats = lstatSync(markerPath);
  } catch (error) {
    return inspection('COMPLETION_MARKER_MISSING', runDirectory, runId, safeErrnoCode(error));
  }
  if (markerStats.size !== COMPLETION_MARKER_BYTES.length) {
    return inspection('COMPLETION_MARKER_INVALID', runDirectory, runId, null);
  }

  let markerBuffer: Buffer;
  try {
    markerBuffer = readFileSync(markerPath);
  } catch (error) {
    return inspection('COMPLETION_MARKER_NOT_REGULAR', runDirectory, runId, safeErrnoCode(error));
  }
  if (!markerBuffer.equals(COMPLETION_MARKER_BYTES)) {
    return inspection('COMPLETION_MARKER_INVALID', runDirectory, runId, null);
  }

  return inspection('COMPLETE', runDirectory, runId, null);
}

/**
 * The supported way to enumerate runs: completed ones only, sorted by run id.
 *
 * Every directory entry under `runsRoot` is treated as untrusted until proven
 * otherwise: its `Dirent` type is only a cheap pre-filter — on Windows it does
 * not reliably distinguish a junction from a real directory — so every
 * candidate is `lstat`ed directly before it is even offered to
 * {@link inspectRun}, and `inspectRun` then re-applies the full trusted-root
 * contract on top of that. A single manipulated or vanished entry is skipped,
 * never allowed to abort the listing or to appear as complete.
 */
export function listCompletedRuns(runsRoot: string): readonly string[] {
  const root = resolve(runsRoot);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const runIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidRunId(entry.name)) continue;

    let stats;
    try {
      stats = lstatSync(join(root, entry.name));
    } catch {
      continue; // Vanished or unreadable between readdir and lstat: skip it.
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;

    try {
      if (inspectRun(root, entry.name).consumable) runIds.push(entry.name);
    } catch {
      continue; // One manipulated entry must never abort the whole listing.
    }
  }

  return runIds.sort();
}
