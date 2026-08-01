/**
 * The `COMPLETED` marker: the only thing that makes a run consumable
 * (AO-007-R2-RR2, AO-007-R2-RR2-REVIEW-01-C1).
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
 * ── The protocol is fixed, not caller-configurable ─────────────────────────
 *
 * There used to be a `completeRun({ runDirectory, expectedArtefacts })` API:
 * any caller could name any set of "required" artefacts, which made the
 * run's own shape a parameter rather than a fact. That is gone. The protocol
 * is exactly:
 *
 *  - before completion: {@link REQUIRED_ARTEFACT_NAMES} and nothing else;
 *  - after completion: {@link REQUIRED_ARTEFACT_NAMES} plus
 *    {@link COMPLETION_MARKER_FILE_NAME}, and nothing else.
 *
 * Both lists are derived, once, from {@link REQUIRED_ARTEFACT_NAMES} — the
 * single internal source of truth for artefact names — so there is no second,
 * looser copy anywhere, in this module or in `run-doctor.ts`. Nothing in this
 * module's public surface accepts an alternative artefact list; TypeScript
 * gives {@link completeRun} no parameter through which one could be supplied.
 *
 * ── completeRun is bound to (runsRoot, runId), not to an arbitrary path ────
 *
 * {@link completeRun} takes a trusted `runsRoot` and a `runId`, exactly like
 * {@link inspectRun}. There is no `runDirectory` parameter a caller could
 * point anywhere: the run directory is always computed internally as
 * `join(runsRoot, runId)`, `runId` is validated before that join ever
 * happens, and the result must be a lexical *and* canonical direct child of
 * `runsRoot` — see {@link validateRunPath}. A validly named run directory
 * living under any other parent, reached through a nested path, named by an
 * absolute path passed off as an id, or sitting behind a Windows junction, is
 * rejected before anything is read from it.
 *
 * ── Producer and consumer share one validator, not two ─────────────────────
 *
 * {@link completeRun} (producer) and {@link inspectRun} (consumer) run
 * through the same internal checks: the same run-id schema
 * ({@link isValidRunId} in `run-directory.ts`), the same root binding
 * ({@link validateRunPath}), the same fail-closed link inspection
 * ({@link inspectLinkChain} in `safe-write.ts`), and the same fixed
 * three-or-two-entry structure check. `completeRun` additionally re-runs the
 * *entire* completed-run validation — the one `inspectRun` uses — immediately
 * after creating the marker, and only reports success if that second pass
 * also comes back clean (AO-007-R2-RR2-REVIEW-01-C1-F2). A run that already
 * looks broken the instant after its own marker was written is never reported
 * as a success.
 *
 * ── Every unproven path segment fails closed ───────────────────────────────
 *
 * The link check used here is tri-state
 * ({@link import('./safe-write.js').LinkChainResult}): `CLEAR`, `LINK_FOUND`,
 * or `INSPECTION_FAILED`. An `lstat` failure this process cannot explain is
 * never treated as "nothing there" — it is treated exactly as suspiciously as
 * a confirmed link, because neither can be ruled out as a redirection
 * (AO-007-R2-RR2-REVIEW-01-C1-F4). The one exception — a path segment that
 * simply does not exist yet — only applies where that is an expected state;
 * every check in this module inspects a run that has already been created, so
 * none of them tolerate a missing segment.
 *
 * ── What this module does not promise ──────────────────────────────────────
 *
 * This is a local, single-writer orchestrator: nothing here defends against a
 * second, adversarial writer racing the same run directory from another
 * process at the same time as the one legitimate doctor run. What it does
 * promise, even so, is narrower and cheaper: `completeRun` never *reports*
 * success for a state that is already invalid by the time its own write
 * returns, and every later reader — `inspectRun`, `listCompletedRuns`, a
 * future CLI command — re-validates the full contract from scratch rather
 * than trusting a prior success. A writer that modifies the directory *after*
 * `completeRun` has already returned `completed: true` is not preventable by
 * anything Node or the filesystem offers here; the next `inspectRun` call is
 * what catches that, not a stronger atomicity guarantee this module does not
 * have and does not claim to have.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';
import { isValidRunId } from './run-directory.js';
import {
  inspectLinkChain,
  isContained,
  samePath,
  writeRunArtifact,
} from './safe-write.js';

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
 * — a completed run may hold. This is the single internal source of truth for
 * the fixed artefact set: {@link completeRun}, {@link inspectRun} and
 * `run-doctor.ts` (via its own re-exported names) all read the run's required
 * shape from here, and from nowhere else. There is no parameter, on this
 * module's public API, through which a caller could add to, remove from, or
 * replace this list.
 */
export const REQUIRED_ARTEFACT_NAMES = ['cli-capabilities.txt', 'doctor-report.json'] as const;

/** The fixed set of direct entries a *completed* run holds — and no others. */
const COMPLETED_ENTRY_NAMES: readonly string[] = [
  ...REQUIRED_ARTEFACT_NAMES,
  COMPLETION_MARKER_FILE_NAME,
];

// ── Shared result vocabulary ────────────────────────────────────────────────

/** Failures that concern the run's *path*, shared by producer and consumer. */
export type RunPathCode =
  /** `runId` is not a valid single path segment. */
  | 'INVALID_RUN_ID'
  /** `runsRoot` itself is not a canonical, existing, link-free directory. */
  | 'RUNS_ROOT_INVALID'
  /** The computed run path would not sit directly inside `runsRoot`. */
  | 'RUN_OUTSIDE_ROOT'
  /** The run path, or something on the way to it, is a symlink or junction. */
  | 'RUN_PATH_IS_LINK'
  /** A path segment could not be conclusively inspected. Never "probably fine". */
  | 'PATH_INSPECTION_FAILED';

/** Failures that concern the run directory's *shape*, shared likewise. */
export type RunStructureCode =
  /** The directory holds something beyond the fixed expected set. */
  | 'RUN_STRUCTURE_INVALID'
  /** A required artefact is missing from the run directory. */
  | 'REQUIRED_ARTIFACT_MISSING'
  /** A required artefact exists but is not a regular file. */
  | 'REQUIRED_ARTIFACT_NOT_REGULAR'
  /** A required artefact exists but is itself a symlink or junction. */
  | 'REQUIRED_ARTIFACT_IS_LINK'
  /** A required artefact exists as a regular file but is empty. */
  | 'REQUIRED_ARTIFACT_EMPTY';

export type RunCompletionCode =
  /** The marker was created and the closing re-validation passed. */
  | 'COMPLETED'
  | RunPathCode
  | RunStructureCode
  /** A marker is already there. Never replaced; the run is not adopted. */
  | 'COMPLETION_MARKER_ALREADY_EXISTS'
  /** The marker could not be written. The run stays incomplete. */
  | 'MARKER_WRITE_FAILED'
  /** The full completed-run contract no longer holds right after the marker
   *  write. The run is reported as failed, not as successful. */
  | 'POST_COMPLETION_VALIDATION_FAILED';

export interface RunCompletionResult {
  readonly code: RunCompletionCode;
  readonly completed: boolean;
  readonly markerPath: string;
  readonly protocolVersion: string;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
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

export type RunInspectionCode =
  | 'COMPLETE'
  | RunPathCode
  | RunStructureCode
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

// ── Shared path/root binding (producer and consumer alike) ─────────────────

interface RunPathValidation {
  readonly code: 'OK' | RunPathCode;
  readonly runDirectory: string;
  readonly errnoCode: string | null;
}

/**
 * Validates that `runId` names a run directory directly, lexically *and*
 * canonically, inside the trusted `runsRoot` — with no link anywhere on the
 * way — before anything downstream is allowed to read from or write to it.
 *
 * `runsRoot` is the caller's trusted, canonical diagnostics root — never a
 * value read back from an untrusted source — and `runId` is validated
 * independently before it is ever joined onto it. The run path is computed
 * *only* as `join(runsRoot, runId)`; nothing else this function is given can
 * influence which directory gets inspected.
 *
 * Two independent containment checks both have to pass:
 *
 *  - **lexical**: `dirname(join(runsRoot, runId))` must equal `runsRoot` as a
 *    plain string;
 *  - **canonical**: `dirname(realpath(join(runsRoot, runId)))` must equal
 *    `realpath(runsRoot)`.
 *
 * The canonical check is additional, not a replacement for the lexical one or
 * for the `lstat`-based link walk below: by the time `realpath` has resolved
 * a junction, containment can no longer be checked against the external
 * target it points at, which is exactly why the link walk exists as well.
 */
function validateRunPath(runsRoot: string, runId: string): RunPathValidation {
  if (!isValidRunId(runId)) {
    return { code: 'INVALID_RUN_ID', runDirectory: resolve(runsRoot), errnoCode: null };
  }

  const root = resolve(runsRoot);
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch (error) {
    return { code: 'RUNS_ROOT_INVALID', runDirectory: root, errnoCode: safeErrnoCode(error) };
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return { code: 'RUNS_ROOT_INVALID', runDirectory: root, errnoCode: null };
  }

  const runDirectory = join(root, runId);
  // Lexical direct-child check: the run directory's own parent, as a plain
  // string, must be exactly `runsRoot` — not two levels down, not a sibling
  // that merely shares a prefix.
  if (!isContained(root, runDirectory) || !samePath(dirname(runDirectory), root)) {
    return { code: 'RUN_OUTSIDE_ROOT', runDirectory, errnoCode: null };
  }

  // Every segment from the filesystem root down to and including the run
  // directory must be link-free. Every one of them is expected to already
  // exist — this function is only ever called on a run that was already
  // created — so a missing segment is itself a failure, never "nothing to
  // redirect through" (AO-007-R2-RR2-REVIEW-01-C1-F4).
  const chain = inspectLinkChain(runDirectory, { allowMissing: false });
  if (chain === 'LINK_FOUND') return { code: 'RUN_PATH_IS_LINK', runDirectory, errnoCode: null };
  if (chain === 'INSPECTION_FAILED') {
    return { code: 'PATH_INSPECTION_FAILED', runDirectory, errnoCode: null };
  }

  let runStats;
  try {
    runStats = lstatSync(runDirectory);
  } catch (error) {
    return { code: 'PATH_INSPECTION_FAILED', runDirectory, errnoCode: safeErrnoCode(error) };
  }
  if (runStats.isSymbolicLink()) return { code: 'RUN_PATH_IS_LINK', runDirectory, errnoCode: null };
  if (!runStats.isDirectory()) return { code: 'PATH_INSPECTION_FAILED', runDirectory, errnoCode: null };

  let realRoot: string;
  let realRunDirectory: string;
  try {
    realRoot = realpathSync(root);
    realRunDirectory = realpathSync(runDirectory);
  } catch (error) {
    return { code: 'PATH_INSPECTION_FAILED', runDirectory, errnoCode: safeErrnoCode(error) };
  }
  if (!samePath(dirname(realRunDirectory), realRoot)) {
    return { code: 'RUN_PATH_IS_LINK', runDirectory, errnoCode: null };
  }

  return { code: 'OK', runDirectory, errnoCode: null };
}

// ── Shared structural checks (producer and consumer alike) ─────────────────

type EntryKind = 'MISSING' | 'LINK' | 'FILE' | 'OTHER';

interface EntryClassification {
  readonly kind: EntryKind;
  readonly size: number;
  readonly errnoCode: string | null;
}

/** What lives at a path, decided with `lstat` — the link itself is never followed. */
function classifyEntry(path: string): EntryClassification {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return { kind: 'MISSING', size: 0, errnoCode: safeErrnoCode(error) };
  }
  if (stats.isSymbolicLink()) return { kind: 'LINK', size: stats.size, errnoCode: null };
  if (stats.isFile()) return { kind: 'FILE', size: stats.size, errnoCode: null };
  return { kind: 'OTHER', size: stats.size, errnoCode: null };
}

interface StructureCheck {
  readonly code: 'OK' | RunStructureCode;
  readonly errnoCode: string | null;
}

/** The directory must hold precisely `expectedNames` — nothing more. */
function checkExactEntries(runDirectory: string, expectedNames: readonly string[]): StructureCheck {
  let names: string[];
  try {
    names = readdirSync(runDirectory);
  } catch (error) {
    return { code: 'RUN_STRUCTURE_INVALID', errnoCode: safeErrnoCode(error) };
  }

  const expected = new Set(expectedNames);
  if (names.some((name) => !expected.has(name))) {
    return { code: 'RUN_STRUCTURE_INVALID', errnoCode: null };
  }
  return { code: 'OK', errnoCode: null };
}

/**
 * Every name in `names` must be a direct, non-linked, non-empty regular file
 * — checked with `lstat`, so a symlink or junction sharing the right name is
 * never mistaken for the entry it claims to be.
 */
function checkArtefacts(runDirectory: string, names: readonly string[]): StructureCheck {
  for (const name of names) {
    const entry = classifyEntry(join(runDirectory, name));
    if (entry.kind === 'MISSING') {
      return { code: 'REQUIRED_ARTIFACT_MISSING', errnoCode: entry.errnoCode };
    }
    if (entry.kind === 'LINK') return { code: 'REQUIRED_ARTIFACT_IS_LINK', errnoCode: null };
    if (entry.kind === 'OTHER') return { code: 'REQUIRED_ARTIFACT_NOT_REGULAR', errnoCode: null };
    if (entry.size === 0) return { code: 'REQUIRED_ARTIFACT_EMPTY', errnoCode: null };
  }
  return { code: 'OK', errnoCode: null };
}

type MarkerCheckCode =
  | 'OK'
  | 'COMPLETION_MARKER_MISSING'
  | 'COMPLETION_MARKER_NOT_REGULAR'
  | 'COMPLETION_MARKER_IS_LINK'
  | 'COMPLETION_MARKER_INVALID';

interface MarkerCheck {
  readonly code: MarkerCheckCode;
  readonly errnoCode: string | null;
}

/**
 * The marker must be a direct, non-linked regular file whose content is
 * byte-for-byte {@link COMPLETION_MARKER_CONTENTS} — no `trim`, no encoding
 * normalisation, a plain buffer comparison. Size is checked before content is
 * ever read, so an oversized planted file is rejected without being read in
 * full.
 */
function checkCompletionMarker(runDirectory: string): MarkerCheck {
  const markerPath = join(runDirectory, COMPLETION_MARKER_FILE_NAME);
  const entry = classifyEntry(markerPath);
  if (entry.kind === 'MISSING') {
    return { code: 'COMPLETION_MARKER_MISSING', errnoCode: entry.errnoCode };
  }
  if (entry.kind === 'LINK') return { code: 'COMPLETION_MARKER_IS_LINK', errnoCode: null };
  if (entry.kind === 'OTHER') return { code: 'COMPLETION_MARKER_NOT_REGULAR', errnoCode: null };
  if (entry.size !== COMPLETION_MARKER_BYTES.length) {
    return { code: 'COMPLETION_MARKER_INVALID', errnoCode: null };
  }

  let contents: Buffer;
  try {
    contents = readFileSync(markerPath);
  } catch (error) {
    return { code: 'COMPLETION_MARKER_NOT_REGULAR', errnoCode: safeErrnoCode(error) };
  }
  if (!contents.equals(COMPLETION_MARKER_BYTES)) {
    return { code: 'COMPLETION_MARKER_INVALID', errnoCode: null };
  }
  return { code: 'OK', errnoCode: null };
}

// ── The two shared, fixed protocol validators ───────────────────────────────

type PreCompletionCode = 'OK' | RunPathCode | RunStructureCode | 'COMPLETION_MARKER_ALREADY_EXISTS';

interface ProtocolValidation<C extends string> {
  readonly code: C;
  readonly runDirectory: string;
  readonly errnoCode: string | null;
}

/**
 * Everything {@link completeRun} must confirm *before* it is allowed to write
 * the marker: a validated, root-bound, link-free run directory holding
 * exactly {@link REQUIRED_ARTEFACT_NAMES} — each a direct, non-linked,
 * non-empty regular file — and no {@link COMPLETION_MARKER_FILE_NAME} yet.
 */
function validateRunBeforeCompletion(
  runsRoot: string,
  runId: string,
): ProtocolValidation<PreCompletionCode> {
  const pathCheck = validateRunPath(runsRoot, runId);
  if (pathCheck.code !== 'OK') return pathCheck;
  const { runDirectory } = pathCheck;

  const markerEntry = classifyEntry(join(runDirectory, COMPLETION_MARKER_FILE_NAME));
  if (markerEntry.kind !== 'MISSING') {
    return { code: 'COMPLETION_MARKER_ALREADY_EXISTS', runDirectory, errnoCode: null };
  }

  const entries = checkExactEntries(runDirectory, REQUIRED_ARTEFACT_NAMES);
  if (entries.code !== 'OK') {
    return { code: entries.code, runDirectory, errnoCode: entries.errnoCode };
  }

  const artefacts = checkArtefacts(runDirectory, REQUIRED_ARTEFACT_NAMES);
  if (artefacts.code !== 'OK') {
    return { code: artefacts.code, runDirectory, errnoCode: artefacts.errnoCode };
  }

  return { code: 'OK', runDirectory, errnoCode: null };
}

type CompletedRunCode = 'OK' | RunPathCode | RunStructureCode | MarkerCheckCode;

/**
 * Everything that makes a run consumable: the same root-bound, link-free run
 * directory, holding exactly {@link REQUIRED_ARTEFACT_NAMES} plus
 * {@link COMPLETION_MARKER_FILE_NAME} and nothing else, every artefact a
 * direct non-linked non-empty regular file, and the marker byte-exact.
 *
 * {@link inspectRun} uses this directly. {@link completeRun} uses it twice:
 * implicitly (its own pre-checks are a strict subset, minus the marker) and
 * explicitly, immediately after writing the marker, as the closing
 * re-validation (AO-007-R2-RR2-REVIEW-01-C1-F2).
 */
function validateCompletedRun(runsRoot: string, runId: string): ProtocolValidation<CompletedRunCode> {
  const pathCheck = validateRunPath(runsRoot, runId);
  if (pathCheck.code !== 'OK') return pathCheck;
  const { runDirectory } = pathCheck;

  const entries = checkExactEntries(runDirectory, COMPLETED_ENTRY_NAMES);
  if (entries.code !== 'OK') {
    return { code: entries.code, runDirectory, errnoCode: entries.errnoCode };
  }

  const artefacts = checkArtefacts(runDirectory, REQUIRED_ARTEFACT_NAMES);
  if (artefacts.code !== 'OK') {
    return { code: artefacts.code, runDirectory, errnoCode: artefacts.errnoCode };
  }

  const marker = checkCompletionMarker(runDirectory);
  if (marker.code !== 'OK') {
    return { code: marker.code, runDirectory, errnoCode: marker.errnoCode };
  }

  return { code: 'OK', runDirectory, errnoCode: null };
}

// ── Producer ────────────────────────────────────────────────────────────────

/**
 * Runs the fixed closing checks and, only if they all pass, creates the
 * marker — then re-runs the full completed-run validation before reporting
 * success.
 *
 * `runId` is validated, and the run directory is derived *only* as
 * `join(runsRoot, runId)`, exactly as {@link inspectRun} does: there is no
 * parameter through which a caller can name a different directory, and no
 * parameter through which a caller can name a different artefact contract.
 *
 * Never throws. A `false` in {@link RunCompletionResult.completed} always
 * means the run must be treated as incomplete, whatever else is on disk —
 * including when the marker itself was successfully written: if the
 * immediate re-validation after that write finds anything wrong, this still
 * reports failure.
 */
export function completeRun(runsRoot: string, runId: string): RunCompletionResult {
  const before = validateRunBeforeCompletion(runsRoot, runId);
  const markerPathFor = (dir: string): string => join(dir, COMPLETION_MARKER_FILE_NAME);

  if (before.code !== 'OK') {
    return completion(before.code, markerPathFor(before.runDirectory), before.errnoCode);
  }

  const { runDirectory } = before;
  const markerPath = markerPathFor(runDirectory);

  const write = writeRunArtifact({
    runDirectory,
    fileName: COMPLETION_MARKER_FILE_NAME,
    contents: COMPLETION_MARKER_CONTENTS,
  });

  if (write.code === 'TARGET_EXISTS') {
    return completion('COMPLETION_MARKER_ALREADY_EXISTS', markerPath, write.errnoCode);
  }
  if (!write.written) {
    return completion('MARKER_WRITE_FAILED', markerPath, write.errnoCode);
  }

  // The closing word: re-run the exact same completed-run validation a
  // consumer would apply, now that the marker exists. The run is reported
  // successful only if this passes too — never on the strength of the write
  // call alone (AO-007-R2-RR2-REVIEW-01-C1-F2).
  const after = validateCompletedRun(runsRoot, runId);
  if (after.code !== 'OK') {
    return completion('POST_COMPLETION_VALIDATION_FAILED', markerPath, after.errnoCode);
  }

  return completion('COMPLETED', markerPath, null);
}

// ── Consumer ────────────────────────────────────────────────────────────────

/**
 * Decides whether a run may be consumed. A thin, code-translating wrapper
 * around {@link validateCompletedRun} — the same validator {@link completeRun}
 * re-applies to itself after writing the marker.
 */
export function inspectRun(runsRoot: string, runId: string): RunInspection {
  const validated = validateCompletedRun(runsRoot, runId);
  const code: RunInspectionCode = validated.code === 'OK' ? 'COMPLETE' : validated.code;
  return inspection(code, validated.runDirectory, runId, validated.errnoCode);
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
