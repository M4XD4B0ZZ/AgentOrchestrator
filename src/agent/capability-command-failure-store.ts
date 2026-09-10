/**
 * The one writer of a capability-command failure record.
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 *
 * A required capability that cannot be proven refuses the run **before**
 * `startTask`, so on that path there is no task state, no worktree and no
 * branch — and, until this module, nothing durable at all. The refusal reached
 * an operator's console and nowhere else, which is why the same failure could
 * happen twice and still not be explainable the second time.
 *
 * ── Where it writes, and where it must not ─────────────────────────────────
 *
 * Under the orchestrator home, in a directory of its own. Never under a
 * repository: `run/lifecycle-driver.ts` promises that this refusal happens
 * before the repository is modified at all, and a record there would falsify it.
 * Never inside a doctor run directory either — `doctor/run-completion.ts`
 * freezes the artefact names a doctor run may contain and rejects extras, so an
 * additional file would silently make that run non-consumable.
 *
 * It reuses `createRunDirectory` and `writeRunArtifact` against a different
 * runs root. That is the shipped pattern rather than a new one, and it inherits
 * their guarantees whole: an exclusive directory that is never reused, a link
 * check on the path, an exclusive `wx` open, an fsync and a clean close.
 *
 * ── One record per occurrence, never deduplicated ──────────────────────────
 *
 * Each call takes a fresh run id, so two refusals are two directories. That is
 * the property the operator-attention store deliberately does *not* have — it
 * folds by identity — and it is the property this needs: the defect that
 * prompted this module occurred twice and cleared twice, and a store that kept
 * one of the two would have hidden exactly the fact that mattered.
 *
 * ── It can never change a decision ─────────────────────────────────────────
 *
 * Never throws, and its result is reported *beside* a refusal, never in place
 * of one. A capability that could not be proven stays unproven whether or not
 * the record was written, and a store failure is visible as itself rather than
 * as a changed verdict. The fail-closed half of the preflight does not depend
 * on this module in any way.
 *
 * ── Retention: none, and said out loud ─────────────────────────────────────
 *
 * Nothing prunes this directory. That is the same debt the doctor's run
 * directories and the head-publication audit already carry, it is declared
 * rather than accidental, and recording is restricted to endings that are
 * ambiguous without a record so the growth is bounded by real trouble rather
 * than by traffic.
 */

import { readFileSync } from 'node:fs';

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { createRunDirectory, newRunId, type RunDirectoryCode } from '../doctor/run-directory.js';
import { writeRunArtifact, type RunArtifactCode } from '../doctor/safe-write.js';
import {
  CAPABILITY_COMMAND_FAILURE_FILE_NAME,
  MAX_CAPABILITY_COMMAND_FAILURE_BYTES,
  capabilityCommandFailuresRoot,
  type CapabilityCommandFailureDocument,
  type CapabilityCommandObservation,
  type CapabilityCommandSite,
} from './capability-command-failure.js';

/**
 * Every way recording can end. Closed, and value-free.
 *
 * The two refusal codes carry the nested store's own code in `detailCode`
 * rather than restating it here: a directory refusal and an artefact refusal
 * each already have a vocabulary, and duplicating them would be two lists to
 * keep in step.
 */
export const CAPABILITY_COMMAND_RECORD_CODES = [
  'RECORDED',
  /** The rendered document exceeds its byte ceiling. Nothing was created. */
  'RECORD_TOO_LARGE',
  /** The user profile could not be resolved, so there is no home to write under. */
  'PROFILE_UNAVAILABLE',
  /** The record directory was refused. Carries the run-directory code. */
  'DIRECTORY_REFUSED',
  /** The directory exists and the file was refused. Carries the artefact code. */
  'ARTEFACT_REFUSED',
  /** The file was written and does not read back byte-for-byte. */
  'READBACK_MISMATCH',
] as const;

export type CapabilityCommandRecordCode = (typeof CAPABILITY_COMMAND_RECORD_CODES)[number];

export interface CapabilityCommandFailureRecord {
  /** `true` only for `RECORDED`. Never inferred from the presence of a path. */
  readonly recorded: boolean;
  readonly code: CapabilityCommandRecordCode;
  readonly eventId: string | null;
  /** Absolute path of the written file, or `null` where nothing was written. */
  readonly path: string | null;
  /** The nested store's own code, where one refused. */
  readonly detailCode: RunDirectoryCode | RunArtifactCode | null;
}

export interface CapabilityCommandFailureRequest {
  readonly site: CapabilityCommandSite;
  readonly reason: string;
  readonly capability: string;
  readonly observation: CapabilityCommandObservation;
  readonly now: Date;
  readonly provider?: PathProvider;
  /** Seam. Production reads the file back with `node:fs`; tests may replace it. */
  readonly readBack?: (path: string) => string;
}

function ended(
  code: CapabilityCommandRecordCode,
  eventId: string | null,
  path: string | null,
  detailCode: RunDirectoryCode | RunArtifactCode | null = null,
): CapabilityCommandFailureRecord {
  return Object.freeze({ recorded: code === 'RECORDED', code, eventId, path, detailCode });
}

/**
 * Records one ambiguous capability-command ending, or explains why it did not.
 *
 * The order is deliberate and testable: the document is rendered and **graded
 * before anything is created**, so an oversized or unrenderable record leaves
 * no directory behind at all. A grade that ran after the effect would be a
 * cleanup problem rather than a gate.
 */
export function recordCapabilityCommandFailure(
  request: CapabilityCommandFailureRequest,
): CapabilityCommandFailureRecord {
  const document: CapabilityCommandFailureDocument = {
    recordVersion: 1,
    site: request.site,
    reason: request.reason,
    capability: request.capability,
    observedAt: request.now.toISOString(),
    observation: request.observation,
  };

  let contents: string;
  try {
    contents = `${JSON.stringify(document, null, 2)}\n`;
  } catch {
    return ended('RECORD_TOO_LARGE', null, null);
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_CAPABILITY_COMMAND_FAILURE_BYTES) {
    return ended('RECORD_TOO_LARGE', null, null);
  }

  let runsRoot: string;
  try {
    runsRoot = capabilityCommandFailuresRoot(request.provider ?? OS_PATH_PROVIDER);
  } catch {
    return ended('PROFILE_UNAVAILABLE', null, null);
  }

  const eventId = newRunId(request.now);
  const directory = createRunDirectory({ runsRoot, runId: eventId });
  if (!directory.created) return ended('DIRECTORY_REFUSED', eventId, null, directory.code);

  const artefact = writeRunArtifact({
    runDirectory: directory.path,
    fileName: CAPABILITY_COMMAND_FAILURE_FILE_NAME,
    contents,
  });
  if (!artefact.written) {
    return ended('ARTEFACT_REFUSED', eventId, artefact.path, artefact.code);
  }

  // Read back, because a write that reported success and left different bytes
  // is the one failure a caller cannot see from the result. `doctor/` proves its
  // artefacts the same way, and this store's whole purpose is to be believed
  // later by somebody who was not here.
  const read = request.readBack ?? defaultReadBack;
  let stored: string | null;
  try {
    stored = read(artefact.path);
  } catch {
    stored = null;
  }
  if (stored !== contents) return ended('READBACK_MISMATCH', eventId, artefact.path, null);

  return ended('RECORDED', eventId, artefact.path, null);
}

function defaultReadBack(path: string): string {
  return readFileSync(path, 'utf8');
}
