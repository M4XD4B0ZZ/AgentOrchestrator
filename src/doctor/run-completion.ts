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
 * A run is complete if and only if its directory contains a `COMPLETED` file
 * holding exactly {@link RUN_PROTOCOL_VERSION}. The marker is:
 *
 *  - written **last**, after every artefact is fully written, synced and
 *    closed;
 *  - written only once all of {@link completeRun}'s closing checks pass —
 *    the directory must contain exactly the expected artefacts, no more and no
 *    fewer, and in particular no temporary or partial files;
 *  - created with exclusive `wx` semantics, so it is never replaced. An
 *    existing marker means somebody else's run, and that is a hard failure;
 *  - free of anything run-specific. It carries a fixed format version and
 *    nothing else: no path, no timestamp, no host, no user, no status.
 *
 * Consumers **must** ignore a run directory without a valid marker. The run may
 * still be inspected by a human for diagnosis — incomplete artefacts are left
 * in place on purpose — but it is not data. {@link listCompletedRuns} is the
 * supported way to enumerate runs and implements exactly that rule.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';
import { isPlainFileName, writeRunArtifact } from './safe-write.js';

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

export type RunCompletionCode =
  /** The marker was created. The run is complete. */
  | 'COMPLETED'
  /** An expected artefact is missing from the run directory. */
  | 'ARTEFACTS_MISSING'
  /** The directory holds something that is not an expected artefact. */
  | 'UNEXPECTED_DIRECTORY_CONTENTS'
  /** An expected artefact name is not a plain single segment. Caller bug. */
  | 'INVALID_ARTEFACT_NAME'
  /** The run directory could not be inspected. */
  | 'RUN_DIRECTORY_UNREADABLE'
  /** A marker is already there. Never replaced; the run is not adopted. */
  | 'MARKER_EXISTS'
  /** The marker could not be written. The run stays incomplete. */
  | 'MARKER_WRITE_FAILED';

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
   * these and nothing else — that is what proves no partial or temporary file
   * was left behind.
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

  let entries: string[];
  try {
    entries = readdirSync(runDirectory);
  } catch (error) {
    return completion('RUN_DIRECTORY_UNREADABLE', markerPath, safeErrnoCode(error));
  }

  if (entries.includes(COMPLETION_MARKER_FILE_NAME)) {
    // Somebody — or some earlier attempt — already closed this directory. It is
    // never re-opened and never re-marked.
    return completion('MARKER_EXISTS', markerPath, null);
  }

  const expected = new Set(request.expectedArtefacts);
  const present = new Set(entries);

  for (const name of expected) {
    if (!present.has(name)) return completion('ARTEFACTS_MISSING', markerPath, null);
  }
  // Anything beyond the expected set — a leftover, a partial write under
  // another name, a planted file — blocks completion.
  for (const name of present) {
    if (!expected.has(name)) return completion('UNEXPECTED_DIRECTORY_CONTENTS', markerPath, null);
  }

  // Every expected entry must also be a regular, non-empty file rather than a
  // directory or a link that merely carries the right name.
  for (const name of expected) {
    let stats;
    try {
      stats = statSync(join(runDirectory, name));
    } catch (error) {
      return completion('ARTEFACTS_MISSING', markerPath, safeErrnoCode(error));
    }
    if (!stats.isFile() || stats.size === 0) {
      return completion('ARTEFACTS_MISSING', markerPath, null);
    }
  }

  const write = writeRunArtifact({
    runDirectory,
    fileName: COMPLETION_MARKER_FILE_NAME,
    contents: COMPLETION_MARKER_CONTENTS,
  });

  if (write.code === 'TARGET_EXISTS') return completion('MARKER_EXISTS', markerPath, write.errnoCode);
  if (!write.written) return completion('MARKER_WRITE_FAILED', markerPath, write.errnoCode);
  return completion('COMPLETED', markerPath, null);
}

// ── Consumer side ──────────────────────────────────────────────────────────

export type RunInspectionCode =
  | 'COMPLETE'
  /** No marker: the run never finished, or is still running. Ignore it. */
  | 'MARKER_MISSING'
  /** The marker exists but could not be read. Ignore it. */
  | 'MARKER_UNREADABLE'
  /** The marker holds a protocol version this build does not speak. Ignore it. */
  | 'MARKER_VERSION_MISMATCH';

export interface RunInspection {
  readonly code: RunInspectionCode;
  /** The single question a consumer should ask. */
  readonly consumable: boolean;
  readonly runDirectory: string;
  readonly errnoCode: string | null;
}

/** How long a valid marker can possibly be. Anything larger is not one. */
const MAX_MARKER_BYTES = 256;

/**
 * Decides whether a run directory may be consumed.
 *
 * Only a directory holding a `COMPLETED` file whose normalised content is
 * exactly {@link RUN_PROTOCOL_VERSION} is consumable. Everything else — no
 * marker, an unreadable marker, a marker from another protocol version — is
 * not, regardless of which artefacts are present.
 */
export function inspectRun(runDirectory: string): RunInspection {
  const directory = resolve(runDirectory);
  const markerPath = join(directory, COMPLETION_MARKER_FILE_NAME);

  let raw: string;
  try {
    const stats = statSync(markerPath);
    if (!stats.isFile() || stats.size > MAX_MARKER_BYTES) {
      return inspection('MARKER_UNREADABLE', directory, null);
    }
    raw = readFileSync(markerPath, 'utf8');
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    return errnoCode === 'ENOENT'
      ? inspection('MARKER_MISSING', directory, null)
      : inspection('MARKER_UNREADABLE', directory, errnoCode);
  }

  return raw.trim() === RUN_PROTOCOL_VERSION
    ? inspection('COMPLETE', directory, null)
    : inspection('MARKER_VERSION_MISMATCH', directory, null);
}

function inspection(
  code: RunInspectionCode,
  runDirectory: string,
  errnoCode: string | null,
): RunInspection {
  return Object.freeze({
    code,
    consumable: code === 'COMPLETE',
    runDirectory,
    errnoCode,
  });
}

/**
 * The supported way to enumerate runs: completed ones only, sorted by run id.
 *
 * Incomplete run directories are skipped silently. They are left on disk for a
 * human to look at, but they are never returned to a consumer.
 */
export function listCompletedRuns(runsRoot: string): readonly string[] {
  const root = resolve(runsRoot);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  return entries
    .filter((name) => inspectRun(join(root, name)).consumable)
    .sort();
}
