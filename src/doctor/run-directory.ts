/**
 * Immutable per-run diagnostics directories (AO-007-R2).
 *
 * Every `agent-loop doctor` invocation gets its own directory:
 *
 *     <orchestrator home>/diagnostics/doctor/runs/<run-id>/
 *         cli-capabilities.txt
 *         doctor-report.json
 *         COMPLETED              ← written last; see `run-completion.ts`
 *
 * Why this replaced the two fixed, overwritable files:
 *
 *  - The old scheme proved ownership of `doctor-report.json` by looking for a
 *    marker string *inside* the existing file. That marker is written into a
 *    world-readable artefact, so it is public knowledge — anyone who could
 *    create a file in the diagnostics directory could also embed the marker and
 *    have the next doctor run overwrite their file. Content is not identity.
 *  - A fixed path is also a stable target: a symlink, a junction or a
 *    pre-created file at a predictable location is an attractive primitive.
 *
 * The rules here, all fail-closed:
 *
 *  - the run id is a single validated path segment made of a UTC timestamp and
 *    a cryptographically random UUID;
 *  - the run directory is created **exclusively** (`mkdir` without `recursive`),
 *    so an already existing directory is an error, never a reuse;
 *  - links anywhere in the path abort the run before anything is created;
 *  - **nothing is ever deleted.** The run protocol is append-only: a run
 *    directory, once created, is never removed, emptied or reused — not even by
 *    the run that created it and not even when it failed. An incomplete run is
 *    left exactly as it is, as diagnostic evidence, and is excluded from
 *    consumption by the absence of its `COMPLETED` marker rather than by
 *    cleanup (AO-007-R2-RR2).
 *
 * Retention of completed runs is deliberately out of scope here; old runs are
 * left alone until a retention policy is implemented.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';
import { isContained, pathContainsLink, samePath } from './safe-write.js';

/**
 * `<YYYYMMDD>T<HHMMSSmmm>Z-<uuid v4>`.
 *
 * The timestamp makes runs sortable and human-recognisable; the UUID is what
 * makes the name unguessable and collision-free. Both parts are produced by
 * this process — no part of a run id ever comes from the environment, the
 * command line or a probed program.
 *
 * The UUID half is constrained to version 4 / RFC 4122 variant (the version
 * nibble is `4`, the variant nibble is one of `8`/`9`/`a`/`b`), matching
 * exactly what `crypto.randomUUID()` produces. This is the single schema both
 * the producer and the consumer of a run id validate against
 * (AO-007-R2-RR2-REVIEW-01) — there is no second, looser regex anywhere else
 * in the run protocol.
 */
export const RUN_ID_PATTERN =
  /^\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `true` when the value is a run id *and* a safe single path segment. */
export function isValidRunId(runId: string): boolean {
  if (!RUN_ID_PATTERN.test(runId)) return false;
  // Redundant given the pattern, and kept deliberately: the segment rules are
  // what actually matter for path safety, so they are asserted explicitly.
  return (
    runId !== '.' &&
    runId !== '..' &&
    !runId.includes('..') &&
    !runId.includes('/') &&
    !runId.includes('\\') &&
    !runId.includes(':')
  );
}

/** A fresh run id. `now` is injectable so tests can pin the timestamp part. */
export function newRunId(now: Date = new Date()): string {
  // `2026-08-01T12:34:56.789Z` → `20260801T123456789Z`
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${stamp.slice(0, 8)}T${stamp.slice(9, 18)}Z-${randomUUID()}`;
}

export type RunDirectoryCode =
  | 'CREATED'
  /** The run id is not a valid single path segment. */
  | 'INVALID_RUN_ID'
  /** The run directory would not sit directly inside the runs root. */
  | 'PATH_ESCAPES_RUNS_ROOT'
  /** A symlink/junction was found in the runs root's path. */
  | 'PATH_CONTAINS_LINK'
  /** The runs root could not be created. */
  | 'RUNS_ROOT_CREATE_FAILED'
  /** A directory with this run id already exists. Never reused. */
  | 'RUN_DIRECTORY_EXISTS'
  /** The run directory could not be created for another reason. */
  | 'RUN_DIRECTORY_CREATE_FAILED';

export interface RunDirectoryResult {
  readonly code: RunDirectoryCode;
  readonly created: boolean;
  readonly runId: string;
  readonly path: string;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

export interface RunDirectoryRequest {
  /** `<orchestrator home>/diagnostics/doctor/runs`. */
  readonly runsRoot: string;
  readonly runId: string;
}

function outcome(
  code: RunDirectoryCode,
  runId: string,
  path: string,
  errnoCode: string | null,
): RunDirectoryResult {
  return Object.freeze({ code, created: code === 'CREATED', runId, path, errnoCode });
}

/**
 * Creates one fresh run directory, or explains precisely why it did not.
 * Never throws, and never reuses an existing directory.
 */
export function createRunDirectory(request: RunDirectoryRequest): RunDirectoryResult {
  const runsRoot = resolve(request.runsRoot);
  const { runId } = request;

  if (!isValidRunId(runId)) {
    return outcome('INVALID_RUN_ID', runId, runsRoot, null);
  }

  const target = resolve(runsRoot, runId);
  if (!isContained(runsRoot, target) || !samePath(dirname(target), runsRoot)) {
    return outcome('PATH_ESCAPES_RUNS_ROOT', runId, target, null);
  }

  // Reject links on whatever part of the path already exists, *before* creating
  // anything: creating through a junction would already be a redirected write.
  if (pathContainsLink(runsRoot)) {
    return outcome('PATH_CONTAINS_LINK', runId, target, null);
  }

  try {
    mkdirSync(runsRoot, { recursive: true });
  } catch (error) {
    return outcome('RUNS_ROOT_CREATE_FAILED', runId, target, safeErrnoCode(error));
  }

  // Re-check after creation: a racing writer could have planted a link.
  if (pathContainsLink(runsRoot)) {
    return outcome('PATH_CONTAINS_LINK', runId, target, null);
  }

  try {
    // No `recursive`: an existing directory raises EEXIST instead of being
    // silently adopted. This is the exclusive-creation guarantee.
    mkdirSync(target);
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    return errnoCode === 'EEXIST'
      ? outcome('RUN_DIRECTORY_EXISTS', runId, target, errnoCode)
      : outcome('RUN_DIRECTORY_CREATE_FAILED', runId, target, errnoCode);
  }

  // The directory we just created must not be reachable through a link either.
  // It is reported and abandoned, never removed: deleting through a link would
  // itself be an operation at an attacker-chosen location.
  if (pathContainsLink(target)) {
    return outcome('PATH_CONTAINS_LINK', runId, target, null);
  }

  return outcome('CREATED', runId, target, null);
}
