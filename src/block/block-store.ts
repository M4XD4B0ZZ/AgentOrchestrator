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
 * Revision is a digest of the exact bytes on disk, and there is no force
 * option. This is the same mechanism as `state-store.ts`, restated here rather
 * than shared because the two write different documents to different places —
 * but the *semantics* are copied on purpose, so a reader who knows one knows the
 * other, and neither can quietly become laxer than its sibling.
 *
 * ── Two functions, because they were never one operation ───────────────────
 *
 * There used to be one `saveBlockLedger`, and whether a call meant *create* or
 * *update* was carried by the presence of an optional field. That reads as a
 * convenience and is actually the hole: an update presented a schema-valid
 * document plus a current revision, and got a write. A revision proves nobody
 * else wrote since it was read; it never proved this writer was entitled to
 * change these fields. So a caller holding nothing but a fresh revision could
 * rewrite the frozen plan, rename the block, backdate the run, or rewind a
 * mid-flight task to `PLANNED` with its evidence erased — through the ordinary
 * public API, with no corruption anywhere.
 *
 * {@link createBlockLedger} and {@link updateBlockLedger} are separate so that
 * the two can no longer be confused by a caller *or* by this module, and so the
 * update path has somewhere to put the two questions creation cannot ask:
 *
 *   - is `next` a legal successor of the ledger actually on disk
 *     (`assessLedgerSuccession`), and
 *   - is every claim it newly makes supported by the task records
 *     (`proveBlockTaskEntry`)?
 *
 * The second one is deliberately *here*, at the write, rather than only in
 * `block-progress.ts`. A proof that lives one layer above the store is a proof
 * a caller can walk around.
 *
 * ── A ledger is bound to the file it came from ─────────────────────────────
 *
 * A document found *by* one identity that carries another is not that run's
 * ledger. The copy/backup shape this module names as its threat model made that
 * concrete: `run-0001.json` copied to `run-0002.json` loaded happily as run
 * 0002, and every later write through that value landed back in
 * `run-0001.json`, a run the caller never opened, under a revision it never
 * read. Refused on load now, exactly as `state-store.ts` refuses
 * `TASK_ID_MISMATCH`, and for the same reason.
 *
 * The declared `repositoryId` is checked the same way, against the profile the
 * checkout actually carries. A field a store only ever writes is a field nobody
 * checks — and this one would otherwise travel intact inside a ledger copied
 * out of another project.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { isContained } from '../doctor/safe-write.js';
import { comparePathIdentity } from '../core/path-identity.js';
import { isValidTaskId, MAX_TASK_ID_LENGTH } from '../plan/task-id.js';
import { readDeclaredRepositoryId } from '../repo/declared-identity.js';
import { REPO_PROFILE_DIR_NAME } from '../repo/profile-location.js';
import { writeFileAtomically, type ReplaceFn, type TempSuffixFn } from '../state/atomic-file.js';
import { TASK_RUNTIME_DIR_NAME } from '../state/state-location.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { proveBlockTaskEntry, type EntryProofCode } from './block-evidence.js';
import {
  assessLedgerSuccession,
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
  /** The recorded repository root is not an absolute path. */
  | 'REPOSITORY_ROOT_NOT_ABSOLUTE'
  /** The ledger claims an identity this checkout's profile does not declare. */
  | 'REPOSITORY_ID_MISMATCH'
  /** This checkout declares no usable identity to hold the ledger to. */
  | 'REPOSITORY_PROFILE_UNUSABLE'
  /** The directory could not be created. */
  | 'DIRECTORY_CREATE_FAILED'
  /** Another writer moved the ledger on. Nothing was written. */
  | 'LEDGER_CONFLICT'
  /**
   * `next` is not a legal successor of the ledger on disk.
   *
   * Distinct from `LEDGER_CONFLICT` on purpose: a conflict says *somebody else
   * wrote*, and this says *you may not write this*, however current your
   * revision. Conflating them would let a caller conclude that re-reading and
   * retrying is the fix.
   */
  | 'LEDGER_SUCCESSION_REFUSED'
  /**
   * A claim the successor makes is not supported by the task records.
   *
   * `detail` carries the {@link EntryProofCode} that stopped it.
   */
  | 'ENTRY_NOT_PROVEN'
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
}

export interface BlockUpdateOptions extends BlockStoreOptions {
  /**
   * The revision this writer read. **Required.**
   *
   * There is no "I did not read anything" update and no force option. An update
   * is by definition a statement about a document the caller has seen, and a
   * writer that has not seen it is creating, not updating — which is a
   * different function.
   */
  readonly expectedRevision: string;
}

function saveFailure(code: LedgerSaveFailureCode, detail: string | null = null): LedgerSaveFailure {
  return Object.freeze({ ok: false as const, code, detail });
}

/* ── the checks both paths share ─────────────────────────────────────────── */

/**
 * The document's own identity claims, held against the checkout it is going to.
 *
 * `null` when they agree.
 */
function checkRecordedIdentity(
  value: BlockRunLedger,
  repositoryRoot: string,
): LedgerSaveFailure | null {
  // Two spellings of the same fact must agree, or the record is somebody
  // else's. Compared by path identity rather than by string, so this store
  // answers the question exactly as `state-store.ts` answers it.
  const recordedRoot = comparePathIdentity(value.repositoryRoot, repositoryRoot);
  if (recordedRoot === 'NOT_ABSOLUTE') return saveFailure('REPOSITORY_ROOT_NOT_ABSOLUTE');
  if (recordedRoot === 'DIFFERENT') return saveFailure('REPOSITORY_ROOT_MISMATCH');

  const declared = readDeclaredRepositoryId(repositoryRoot);
  if (!declared.ok) return saveFailure('REPOSITORY_PROFILE_UNUSABLE');
  if (declared.id !== value.repositoryId) return saveFailure('REPOSITORY_ID_MISMATCH');

  return null;
}

/** The serialised bytes of a ledger, or why they may not be written. */
function encode(value: BlockRunLedger): Buffer | LedgerSaveFailure {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_BLOCK_LEDGER_BYTES) return saveFailure('LEDGER_TOO_LARGE');
  return bytes;
}

function persist(
  location: BlockLedgerLocation,
  bytes: Buffer,
  options: BlockStoreOptions,
): LedgerSaveResult {
  try {
    mkdirSync(location.directory, { recursive: true });
  } catch (error) {
    return saveFailure('DIRECTORY_CREATE_FAILED', safeErrnoCode(error));
  }

  const written = writeFileAtomically({
    directory: location.directory,
    fileName: location.fileName,
    contents: bytes,
    isAcceptableFileName: isLedgerFileName,
    ...(options.replace !== undefined ? { replace: options.replace } : {}),
    ...(options.tempSuffix !== undefined ? { tempSuffix: options.tempSuffix } : {}),
  });
  if (written.code !== 'WRITTEN') return saveFailure('WRITE_FAILED', written.code);

  return Object.freeze({
    ok: true as const,
    path: location.path,
    revision: revisionOfBytes(bytes),
  });
}

/* ── creating ────────────────────────────────────────────────────────────── */

/**
 * Writes the first ledger of a run, atomically, and only if there is none.
 *
 * A run id that already has a ledger is refused rather than overwritten: a
 * block is not a run, and starting one again must not destroy the record of
 * what happened last time.
 *
 * A creation **claims no progress**, and that is enforced here rather than
 * assumed: every entry `PLANNED`, nothing active, no stop reason. Without it,
 * creation would be the door update closed — a first ledger written straight
 * into a repository with every entry `SETTLED`, digest-shaped evidence behind
 * none of it and `COMPLETE` on top, needing no predecessor to get past and no
 * task record to support it. A run that has not started has nothing to say
 * about what its tasks did.
 *
 * Which is also why nothing is proved against the task records here: after that
 * rule there is no claim left to prove.
 */
export function createBlockLedger(ledger: unknown, options: BlockStoreOptions): LedgerSaveResult {
  const parsed = safeParseBlockRunLedger(ledger);
  if (!parsed.success) {
    return saveFailure('LEDGER_CONTRACT_VIOLATION', parsed.error.issues[0]?.message ?? null);
  }
  const value = parsed.data;

  if (
    value.stopReason !== null ||
    value.activeTaskId !== null ||
    value.tasks.some((task) => task.disposition !== 'PLANNED')
  ) {
    return saveFailure('LEDGER_CONTRACT_VIOLATION', 'CREATION_MUST_CLAIM_NO_PROGRESS');
  }

  const identity = checkRecordedIdentity(value, options.repositoryRoot);
  if (identity !== null) return identity;

  const location = deriveBlockLedgerLocation(options.repositoryRoot, value.runId);
  if (!location.ok) return saveFailure('LOCATION_UNSUITABLE', location.code);

  const bytes = encode(value);
  if (!Buffer.isBuffer(bytes)) return bytes;

  // Read rather than `existsSync`: the question is whether a ledger is there,
  // and an unreadable one is there.
  try {
    readFileSync(location.path);
    return saveFailure('LEDGER_CONFLICT', 'LEDGER_EXISTS');
  } catch (error) {
    if (safeErrnoCode(error) !== 'ENOENT') return saveFailure('LEDGER_CONFLICT', 'UNREADABLE');
  }

  return persist(location, bytes, options);
}

/* ── updating ────────────────────────────────────────────────────────────── */

/**
 * Writes a successor of the ledger currently on disk.
 *
 * Four gates, in order, and every refusal writes nothing:
 *
 *  1. the successor is a valid ledger and names this checkout;
 *  2. the revision the caller read is still the revision on disk;
 *  3. the successor may legally change what it changed
 *     (`assessLedgerSuccession`);
 *  4. every claim it newly makes is supported by the task records
 *     (`proveBlockTaskEntry`).
 *
 * Gate 4 is scoped to what the successor *asserts that its predecessor did
 * not*: entries whose disposition moved, and the stop reasons that are claims
 * about progress. That scope is deliberate in both directions. Narrower would
 * let a forged `COMPLETE` through — the shape where a hand-edited file of
 * `SETTLED` entries was accepted as a finished block, because the claim was
 * checked against the same document that made it. Wider would make a diverged
 * ledger unwritable, so a run that has detected `LEDGER_DIVERGED` could not
 * record that it had; a reason that asserts the run *cannot continue* asserts
 * no progress and needs no proof.
 */
export function updateBlockLedger(
  ledger: unknown,
  options: BlockUpdateOptions,
): LedgerSaveResult {
  const parsed = safeParseBlockRunLedger(ledger);
  if (!parsed.success) {
    return saveFailure('LEDGER_CONTRACT_VIOLATION', parsed.error.issues[0]?.message ?? null);
  }
  const next = parsed.data;

  const identity = checkRecordedIdentity(next, options.repositoryRoot);
  if (identity !== null) return identity;

  const location = deriveBlockLedgerLocation(options.repositoryRoot, next.runId);
  if (!location.ok) return saveFailure('LOCATION_UNSUITABLE', location.code);

  const bytes = encode(next);
  if (!Buffer.isBuffer(bytes)) return bytes;

  // --- 2. the compare-and-swap ---------------------------------------------
  let current: Buffer;
  try {
    current = readFileSync(location.path);
  } catch (error) {
    const errno = safeErrnoCode(error);
    // A caller holding a revision is describing a file that was there.
    return saveFailure('LEDGER_CONFLICT', errno === 'ENOENT' ? 'LEDGER_ABSENT' : 'UNREADABLE');
  }
  if (revisionOfBytes(current) !== options.expectedRevision) {
    return saveFailure('LEDGER_CONFLICT', 'REVISION_MISMATCH');
  }

  // --- 3. succession -------------------------------------------------------
  // Read back from the bytes rather than taken from the caller: the authority
  // on what the predecessor said is the file, not the value the caller kept.
  let document: unknown;
  try {
    document = JSON.parse(current.toString('utf8'));
  } catch {
    return saveFailure('LEDGER_CONFLICT', 'PREDECESSOR_MALFORMED');
  }
  const previous = safeParseBlockRunLedger(document);
  if (!previous.success) return saveFailure('LEDGER_CONFLICT', 'PREDECESSOR_INVALID');

  const violations = assessLedgerSuccession(previous.data, next);
  if (violations.length > 0) {
    return saveFailure('LEDGER_SUCCESSION_REFUSED', violations.join(','));
  }

  // --- 4. proof ------------------------------------------------------------
  const unproven = firstUnprovenClaim(previous.data, next, options.repositoryRoot);
  if (unproven !== null) return saveFailure('ENTRY_NOT_PROVEN', unproven);

  return persist(location, bytes, options);
}

/**
 * The proof code of the first claim in `next` the task records do not support,
 * or `null` when every one of them holds.
 *
 * ── Why every entry, and not only the ones that moved ──────────────────────
 *
 * Proving only the moved entry looks sufficient and is not. A write
 * re-serialises the *whole* document, so an entry forged on disk by hand rides
 * out on the next legitimate activation — carried forward under this store's
 * signature, having been examined by nothing. And there is no such thing as
 * progressing a run whose record is already unsupported: the correct move for a
 * ledger that disagrees with the task states is to stop with `LEDGER_DIVERGED`,
 * not to add a well-proven step to it.
 *
 * ── The one write that is exempt, and why it must be ───────────────────────
 *
 * A stop whose reason asserts no progress. `LEDGER_DIVERGED`, `STATE_UNUSABLE`,
 * `OPERATOR_STOPPED`, `NO_ELIGIBLE_TASK` and `DEFINITION_DRIFTED` say the run
 * *cannot continue*, which is exactly what a run with an unsupported ledger
 * needs to be able to say. Requiring a clean proof for those would mean a run
 * that has just detected a divergence could not record having detected it —
 * the one thing it must always be able to do.
 */
function firstUnprovenClaim(
  previous: BlockRunLedger,
  next: BlockRunLedger,
  repositoryRoot: string,
): EntryProofCode | null {
  // Succession has already established that the two lists line up by index.
  const dispositionsMoved = next.tasks.some(
    (entry, index) => entry.disposition !== previous.tasks[index]?.disposition,
  );
  const claimsProgress =
    next.stopReason !== null &&
    next.stopReason !== previous.stopReason &&
    CLAIMS_PROGRESS.has(next.stopReason);

  if (!dispositionsMoved && !claimsProgress) return null;

  for (const entry of next.tasks) {
    const { code } = proveBlockTaskEntry(repositoryRoot, entry);
    if (code !== 'PROVEN') return code;
  }

  return null;
}

/**
 * The stop reasons that assert something about the tasks rather than about the
 * run's ability to continue.
 *
 * The others — `OPERATOR_STOPPED`, `NO_ELIGIBLE_TASK`, `LEDGER_DIVERGED`,
 * `STATE_UNUSABLE`, `DEFINITION_DRIFTED` — claim no progress, and must stay
 * writable over a ledger whose entries are *not* supported. Otherwise a run
 * that has just detected a divergence could not record that it had, which is
 * the one thing it must always be able to do.
 */
const CLAIMS_PROGRESS: ReadonlySet<string> = new Set<string>([
  'COMPLETE',
  'TASK_BLOCKED',
  'TASK_ABANDONED',
]);

/* ─────────────────────────────── loading ────────────────────────────────── */

export const LEDGER_LOAD_FAILURE_CODES = [
  'LEDGER_MISSING',
  'LEDGER_UNREADABLE',
  'LEDGER_TOO_LARGE',
  'LEDGER_MALFORMED',
  'LEDGER_CONTRACT_VIOLATION',
  'LOCATION_UNSUITABLE',
  'REPOSITORY_ROOT_MISMATCH',
  /** The recorded repository root is not an absolute path. */
  'REPOSITORY_ROOT_NOT_ABSOLUTE',
  /** The ledger claims an identity this checkout's profile does not declare. */
  'REPOSITORY_ID_MISMATCH',
  /** This checkout declares no usable identity to hold the ledger to. */
  'REPOSITORY_PROFILE_UNUSABLE',
  /**
   * The ledger found at this run's path is another run's.
   *
   * Kept apart from every other failure for the same reason `state-store.ts`
   * keeps `TASK_ID_MISMATCH` apart: the document contradicts its own location,
   * which is a ledger copied or restored across runs rather than a stale one.
   */
  'RUN_ID_MISMATCH',
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

  // The document was found *by* these identities, so a disagreement means its
  // contents contradict its own location. All three are refused here rather
  // than deferred to reconciliation, because all three are provable without
  // resolving anything — and because a value handed back from this function is
  // what a later write threads its revision through. A ledger loaded under the
  // wrong run id writes back to the *other* run's file.
  const recordedRoot = comparePathIdentity(parsed.data.repositoryRoot, repositoryRoot);
  if (recordedRoot === 'NOT_ABSOLUTE') return loadFailure('REPOSITORY_ROOT_NOT_ABSOLUTE');
  if (recordedRoot === 'DIFFERENT') return loadFailure('REPOSITORY_ROOT_MISMATCH');
  if (parsed.data.runId !== runId) return loadFailure('RUN_ID_MISMATCH');

  const declared = readDeclaredRepositoryId(repositoryRoot);
  if (!declared.ok) return loadFailure('REPOSITORY_PROFILE_UNUSABLE');
  if (declared.id !== parsed.data.repositoryId) return loadFailure('REPOSITORY_ID_MISMATCH');

  return Object.freeze({
    ok: true as const,
    classification: 'LEDGER_VALID' as const,
    ledger: parsed.data,
    revision: revisionOfBytes(raw),
    path: location.path,
  });
}
