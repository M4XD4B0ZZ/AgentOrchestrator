/**
 * Where a block run's ledger lives, and how it is written.
 *
 *     <canonical repository root>/.agent-orchestrator/runtime/blocks/<runId>.json
 *
 * Beside the task states, for the reason `state-location.ts` gives about those:
 * the record belongs to the repository it describes, so copying the checkout
 * carries it and deleting the checkout removes it. The `blocks/` directory sits
 * *inside* `runtime/`, which repositories are already required to ignore — so a
 * ledger cannot dirty a checkout and refuse the next workspace, and no new
 * onboarding requirement is created.
 *
 * ── Named by the run, not by the block ─────────────────────────────────────
 *
 * The same roadmap block must be startable again later without overwriting the
 * record of the previous attempt. So `runId` names the file and `blockId` is a
 * field. A store keyed on the block would make "start it again" mean "destroy
 * the evidence of what happened last time".
 *
 * ── The same compare-and-swap, deliberately ────────────────────────────────
 *
 * Revision is a digest of the exact bytes on disk; an omitted `expectedRevision`
 * means *creation* and is refused if a ledger already exists; there is no force
 * option. This is the same mechanism as `state-store.ts`, restated here rather
 * than shared because the two write different documents to different places —
 * but the *semantics* are copied on purpose, so a reader who knows one knows the
 * other, and neither can quietly become laxer than its sibling.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { isContained } from '../doctor/safe-write.js';
import { isValidTaskId, MAX_TASK_ID_LENGTH } from '../plan/task-id.js';
import { REPO_PROFILE_DIR_NAME } from '../repo/profile-location.js';
import { writeFileAtomically, type ReplaceFn, type TempSuffixFn } from '../state/atomic-file.js';
import { TASK_RUNTIME_DIR_NAME } from '../state/state-location.js';
import { safeErrnoCode } from '../core/safe-error.js';
import {
  safeParseBlockRunLedger,
  type BlockRunLedger,
} from './block-ledger.js';

/** Directory holding every block-run ledger of one repository. */
export const BLOCK_RUNTIME_DIR_NAME = 'blocks';

/** Extension of a persisted ledger. */
export const BLOCK_LEDGER_FILE_EXTENSION = '.json';

/** Largest ledger this build will read back. */
export const MAX_BLOCK_LEDGER_BYTES = 1_048_576;

/** `<repositoryRoot>/.agent-orchestrator/runtime/blocks`. */
export function blockRuntimeDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, REPO_PROFILE_DIR_NAME, TASK_RUNTIME_DIR_NAME, BLOCK_RUNTIME_DIR_NAME);
}

/**
 * `true` when `name` is the file name of some canonically valid run.
 *
 * The run-id grammar is the task-id grammar — see `block-definition.ts` for why
 * that rule is reused rather than reinvented — so the same length budget
 * applies, derived rather than chosen.
 */
export function isLedgerFileName(name: string): boolean {
  if (name.length > MAX_TASK_ID_LENGTH + BLOCK_LEDGER_FILE_EXTENSION.length) return false;
  if (!name.endsWith(BLOCK_LEDGER_FILE_EXTENSION)) return false;
  return isValidTaskId(name.slice(0, name.length - BLOCK_LEDGER_FILE_EXTENSION.length));
}

export interface BlockLedgerLocation {
  readonly ok: true;
  readonly directory: string;
  readonly fileName: string;
  readonly path: string;
}

export interface BlockLedgerLocationFailure {
  readonly ok: false;
  readonly code: 'REPOSITORY_ROOT_UNSUITABLE' | 'RUN_ID_UNSUITABLE';
}

export type BlockLedgerLocationResult = BlockLedgerLocation | BlockLedgerLocationFailure;

/** The one file that holds `runId`'s ledger, or why there cannot be one. */
export function deriveBlockLedgerLocation(
  repositoryRoot: string,
  runId: string,
): BlockLedgerLocationResult {
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }
  if (!isValidTaskId(runId)) {
    return Object.freeze({ ok: false as const, code: 'RUN_ID_UNSUITABLE' as const });
  }

  const fileName = `${runId}${BLOCK_LEDGER_FILE_EXTENSION}`;
  if (!isLedgerFileName(fileName)) {
    return Object.freeze({ ok: false as const, code: 'RUN_ID_UNSUITABLE' as const });
  }

  const directory = blockRuntimeDirectory(repositoryRoot);
  const path = join(directory, fileName);
  if (!isContained(repositoryRoot, path)) {
    return Object.freeze({ ok: false as const, code: 'RUN_ID_UNSUITABLE' as const });
  }

  return Object.freeze({ ok: true as const, directory, fileName, path });
}

function revisionOfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ─────────────────────────────── saving ─────────────────────────────────── */

export type LedgerSaveFailureCode =
  /** The value is not a ledger this build would accept back. */
  | 'LEDGER_CONTRACT_VIOLATION'
  /** The identities cannot be used as path segments. */
  | 'LOCATION_UNSUITABLE'
  /** The ledger describes a different repository than the one being written to. */
  | 'REPOSITORY_ROOT_MISMATCH'
  /** The directory could not be created. */
  | 'DIRECTORY_CREATE_FAILED'
  /** Another writer moved the ledger on. Nothing was written. */
  | 'LEDGER_CONFLICT'
  /** The document is larger than this build could load back. */
  | 'LEDGER_TOO_LARGE'
  /** The atomic write itself failed. */
  | 'WRITE_FAILED';

export interface LedgerSaveSuccess {
  readonly ok: true;
  readonly path: string;
  /** Revision of the bytes just written, for the next compare-and-swap. */
  readonly revision: string;
}

export interface LedgerSaveFailure {
  readonly ok: false;
  readonly code: LedgerSaveFailureCode;
  readonly detail: string | null;
}

export type LedgerSaveResult = LedgerSaveSuccess | LedgerSaveFailure;

export interface BlockStoreOptions {
  /** The canonical repository root. Required, and never defaulted. */
  readonly repositoryRoot: string;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
  /**
   * The revision this writer read.
   *
   * Omitting it means "I read nothing, so I expect nothing" — the creation
   * case — and the save is refused if a ledger already exists. It does not mean
   * "overwrite whatever is there", and there is no option that does.
   */
  readonly expectedRevision?: string;
}

function saveFailure(code: LedgerSaveFailureCode, detail: string | null = null): LedgerSaveFailure {
  return Object.freeze({ ok: false as const, code, detail });
}

/** `null` when the on-disk revision is what the caller expected. */
function checkExpectedRevision(path: string, expected: string | undefined): string | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = safeErrnoCode(error);
    // Absent is exactly what a creation expects, and exactly what an update
    // does not: a caller holding a revision is describing a file that was there.
    if (code === 'ENOENT') return expected === undefined ? null : 'LEDGER_ABSENT';
    return 'UNREADABLE';
  }
  if (expected === undefined) return 'LEDGER_EXISTS';
  return revisionOfBytes(bytes) === expected ? null : 'REVISION_MISMATCH';
}

/**
 * Persists one ledger, atomically and under compare-and-swap.
 *
 * Never throws for an expected condition. Every refusal writes nothing.
 */
export function saveBlockLedger(ledger: unknown, options: BlockStoreOptions): LedgerSaveResult {
  const parsed = safeParseBlockRunLedger(ledger);
  if (!parsed.success) {
    return saveFailure('LEDGER_CONTRACT_VIOLATION', parsed.error.issues[0]?.message ?? null);
  }
  const value = parsed.data;

  // The document names its repository, and it is being written into one. Two
  // spellings of the same fact must agree, or the record is somebody else's.
  if (value.repositoryRoot !== options.repositoryRoot) {
    return saveFailure('REPOSITORY_ROOT_MISMATCH');
  }

  const location = deriveBlockLedgerLocation(options.repositoryRoot, value.runId);
  if (!location.ok) return saveFailure('LOCATION_UNSUITABLE', location.code);

  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_BLOCK_LEDGER_BYTES) return saveFailure('LEDGER_TOO_LARGE');

  try {
    mkdirSync(location.directory, { recursive: true });
  } catch (error) {
    return saveFailure('DIRECTORY_CREATE_FAILED', safeErrnoCode(error));
  }

  const conflict = checkExpectedRevision(location.path, options.expectedRevision);
  if (conflict !== null) return saveFailure('LEDGER_CONFLICT', conflict);

  const written = writeFileAtomically({
    directory: location.directory,
    fileName: location.fileName,
    contents: bytes,
    isAcceptableFileName: isLedgerFileName,
    ...(options.replace !== undefined ? { replace: options.replace } : {}),
    ...(options.tempSuffix !== undefined ? { tempSuffix: options.tempSuffix } : {}),
  });
  if (written.code !== 'WRITTEN') {
    return saveFailure('WRITE_FAILED', written.code);
  }

  return Object.freeze({
    ok: true as const,
    path: location.path,
    revision: revisionOfBytes(bytes),
  });
}

/* ─────────────────────────────── loading ────────────────────────────────── */

export const LEDGER_LOAD_FAILURE_CODES = [
  'LEDGER_MISSING',
  'LEDGER_UNREADABLE',
  'LEDGER_TOO_LARGE',
  'LEDGER_MALFORMED',
  'LEDGER_CONTRACT_VIOLATION',
  'LOCATION_UNSUITABLE',
  'REPOSITORY_ROOT_MISMATCH',
] as const;

export type LedgerLoadFailureCode = (typeof LEDGER_LOAD_FAILURE_CODES)[number];

export interface LedgerLoadSuccess {
  readonly ok: true;
  readonly classification: 'LEDGER_VALID';
  readonly ledger: BlockRunLedger;
  /** Feed straight back as `expectedRevision`. */
  readonly revision: string;
  readonly path: string;
}

export interface LedgerLoadFailure {
  readonly ok: false;
  /**
   * `LEDGER_MISSING` is kept apart from every other failure, and callers must
   * keep it apart too: "no run has been recorded" and "a run was recorded and
   * cannot be read" are opposite situations, and only the first is an absence.
   */
  readonly classification: LedgerLoadFailureCode;
  readonly code: LedgerLoadFailureCode;
}

export type LedgerLoadResult = LedgerLoadSuccess | LedgerLoadFailure;

function loadFailure(code: LedgerLoadFailureCode): LedgerLoadFailure {
  return Object.freeze({ ok: false as const, classification: code, code });
}

/** Reads one ledger back, or says exactly why it could not. Never throws. */
export function loadBlockLedger(repositoryRoot: string, runId: string): LedgerLoadResult {
  const location = deriveBlockLedgerLocation(repositoryRoot, runId);
  if (!location.ok) return loadFailure('LOCATION_UNSUITABLE');

  let size: number;
  try {
    size = statSync(location.path).size;
  } catch (error) {
    return loadFailure(safeErrnoCode(error) === 'ENOENT' ? 'LEDGER_MISSING' : 'LEDGER_UNREADABLE');
  }
  if (size > MAX_BLOCK_LEDGER_BYTES) return loadFailure('LEDGER_TOO_LARGE');

  let raw: Buffer;
  try {
    raw = readFileSync(location.path);
  } catch {
    return loadFailure('LEDGER_UNREADABLE');
  }

  let document: unknown;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    return loadFailure('LEDGER_MALFORMED');
  }

  const parsed = safeParseBlockRunLedger(document);
  if (!parsed.success) return loadFailure('LEDGER_CONTRACT_VIOLATION');

  // An intact ledger belonging to another checkout is not this repository's.
  if (parsed.data.repositoryRoot !== repositoryRoot) {
    return loadFailure('REPOSITORY_ROOT_MISMATCH');
  }

  return Object.freeze({
    ok: true as const,
    classification: 'LEDGER_VALID' as const,
    ledger: parsed.data,
    revision: revisionOfBytes(raw),
    path: location.path,
  });
}
