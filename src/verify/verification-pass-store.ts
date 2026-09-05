/**
 * Where a task's verification-pass record lives, and the rules for changing it.
 *
 * ── One file per task, in its own directory ────────────────────────────────
 *
 * `<runtime>/verification-passes/<taskId>.json`, following the precedent
 * `block/block-store.ts` set and `verify/verification-attempt-store.ts`
 * followed: a new kind of per-repository record gets its own **directory**
 * rather than its own name inside a shared one. A task id may contain dots, so
 * `<id>.pass.json` is a legal *other task's* file name — the collision that made
 * the rule.
 *
 * ── Under the repository root, never under the worktree ────────────────────
 *
 * `taskRuntimeDirectory(repositoryRoot)`, and the distinction is a security
 * boundary rather than a tidiness one, for exactly the reason the attempt store
 * states: the writing agent's cwd is the worktree, so a record placed there
 * would be writable by the agent whose work it describes — and this record is
 * the one an agent has the strongest reason to forge, because a reviewer is
 * briefed from it. A `.gitignore`d forgery would additionally be invisible to
 * the scope guard. The only defence is not to put it there.
 *
 * ── Latest wins, and why that is right here and wrong next door ────────────
 *
 * The attempt history is append-only because an older failure is evidence a
 * newer one does not replace. This record answers a different question — "what
 * is the newest commit AO measured as passing" — whose answer is by definition
 * the newest, and a pass carries no diagnosis whose loss would matter. So one
 * document per task, replaced whole.
 *
 * What latest-wins does **not** mean is replacing something this build cannot
 * read. `MALFORMED`, `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` all mean "there
 * is a document there and this build cannot say what it claims", including a
 * perfectly good record written by a newer build. Those are refused rather than
 * overwritten, exactly as the sibling store refuses them.
 *
 * ── The lease is proved here, not only upstream ────────────────────────────
 *
 * {@link recordVerificationPass} takes an authority and re-proves it
 * immediately before the write, for the sibling store's reason: the verification
 * this records can take twenty minutes, so the lease check the *spawn* made is
 * twenty minutes stale by the time the record is built, and a record written by
 * a run that has stopped being the repository's writer is a durable artefact
 * from an unauthorised process.
 *
 * ── A failed write never fails the task ────────────────────────────────────
 *
 * The caller's ordering is the opposite of the attempt store's, and deliberately
 * so. There, the record must land *before* the block, because a durable
 * accusation with no evidence is the defect that store exists to prevent. Here
 * the news is good, and a sidecar that could not be written must never turn a
 * passing gate into a stopped task. The verify step advances on the report and
 * reports this result beside it.
 */

import { mkdirSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';
import { isContained } from '../doctor/safe-write.js';
import { isValidTaskId } from '../plan/task-id.js';
import {
  isStateFileName,
  taskRuntimeDirectory,
  TASK_STATE_FILE_EXTENSION,
} from '../state/state-location.js';
import { writeFileAtomically, type ReplaceFn, type TempSuffixFn } from '../state/atomic-file.js';
import { relativePosix, type RuntimeIgnoreVerdict } from '../state/runtime-ignored.js';
import {
  MAX_VERIFICATION_PASS_RECORD_BYTES,
  readVerificationPass,
  type VerificationPassRecord,
  type VerificationPassSubject,
} from './verification-pass.js';

/** The directory name holding verification-pass records. See the header. */
export const VERIFICATION_PASS_DIR_NAME = 'verification-passes';

/** The extension of a verification-pass record file. */
export const VERIFICATION_PASS_FILE_EXTENSION = TASK_STATE_FILE_EXTENSION;

/** The directory holding pass records for a canonical repository root. */
export function verificationPassDirectory(repositoryRoot: string): string {
  return join(taskRuntimeDirectory(repositoryRoot), VERIFICATION_PASS_DIR_NAME);
}

/**
 * Whether a name is one of this store's files.
 *
 * `state-location.ts`'s grammar, shared rather than restated: the separation
 * between the kinds of record is structural — a directory — so a second copy of
 * the rule could only drift from the first.
 */
export function isVerificationPassFileName(name: string): boolean {
  return isStateFileName(name);
}

export interface VerificationPassLocation {
  readonly ok: true;
  readonly directory: string;
  readonly fileName: string;
  readonly path: string;
}

export interface VerificationPassLocationFailure {
  readonly ok: false;
  readonly code: 'REPOSITORY_ROOT_UNSUITABLE' | 'TASK_ID_UNSUITABLE';
}

export type VerificationPassLocationResult =
  | VerificationPassLocation
  | VerificationPassLocationFailure;

/** Where one task's pass record belongs, or why it has no location. */
export function deriveVerificationPassLocation(
  repositoryRoot: string,
  taskId: string,
): VerificationPassLocationResult {
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }
  if (!isValidTaskId(taskId)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const fileName = `${taskId}${VERIFICATION_PASS_FILE_EXTENSION}`;
  // Belt and braces: the derived name is judged in its own right, so a future
  // change cannot silently produce a name nothing would accept back.
  if (!isVerificationPassFileName(fileName)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const directory = verificationPassDirectory(repositoryRoot);
  const path = join(directory, fileName);
  // Belt and braces: even with a validated id, prove the result stayed inside
  // the repository it belongs to.
  if (!isContained(repositoryRoot, path)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  return Object.freeze({ ok: true as const, directory, fileName, path });
}

/* ─────────────────────────────── recording ──────────────────────────────── */

/** Every way recording a pass can end. A closed set, and two of them wrote. */
export const VERIFICATION_PASS_RECORD_CODES = [
  /** Wrote the first pass record this task has had. */
  'PASS_RECORDED',
  /** Replaced an earlier pass record for this task. */
  'PASS_REPLACED',
  /** This run is no longer the repository's writer. Nothing was written. */
  'EXECUTION_LEASE_NOT_HELD',
  /** A record is on disk for a different task or repository. */
  'CONFLICTING_RECORD',
  /** Something is on disk that this build cannot read. Never replaced blindly. */
  'EXISTING_RECORD_UNREADABLE',
  /** No location could be derived for this repository and task. */
  'LOCATION_UNSUITABLE',
  /** The record's own path is not ignored by Git, or the answer was unreadable. */
  'RUNTIME_PATH_NOT_IGNORED',
  'RUNTIME_IGNORE_UNDETERMINED',
  /** This build would not accept back the document it just built. */
  'RECORD_CONTRACT_VIOLATION',
  /** The document exceeds this build's byte budget. */
  'RECORD_TOO_LARGE',
  /** The directory could not be created. */
  'DIRECTORY_CREATE_FAILED',
  /** The atomic replace did not complete. */
  'WRITE_FAILED',
  /** The document was written and did not read back as what was written. */
  'READBACK_FAILED',
] as const;

export type VerificationPassRecordCode = (typeof VERIFICATION_PASS_RECORD_CODES)[number];

export const PASS_WRITE_ATTEMPTS = ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const;
export type PassWriteAttempt = (typeof PASS_WRITE_ATTEMPTS)[number];

export interface VerificationPassRecordResult {
  readonly code: VerificationPassRecordCode;
  /** Whether the durable record now holds this pass. */
  readonly recorded: boolean;
  /** Whether a write was tried, and how it ended. Never inferred from `code`. */
  readonly writeAttempt: PassWriteAttempt;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  readonly errnoCode: string | null;
}

export interface VerificationPassWriteRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** The pass to record. Built by the caller from its own `VerificationReport`. */
  readonly pass: VerificationPassRecord;
  /**
   * Whether this run still holds the repository's execution lease.
   *
   * Asked as a function rather than taken as a boolean so it is answered *now*,
   * at the write, and cannot be a value computed before a twenty-minute
   * verification run. See the module header.
   */
  readonly leaseHolds: () => boolean;
  /** Whether Git ignores a repository-relative path. */
  readonly checkIgnored: (relativePath: string) => Promise<RuntimeIgnoreVerdict>;
  readonly open?: (path: string) => number;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

function recordFailure(
  code: VerificationPassRecordCode,
  path: string | null,
  errnoCode: string | null = null,
  writeAttempt: PassWriteAttempt = 'NOT_ATTEMPTED',
): VerificationPassRecordResult {
  return Object.freeze({ code, recorded: false as const, writeAttempt, path, errnoCode });
}

/**
 * Records one verification pass for a task, replacing any earlier one.
 *
 * Never throws for an expected condition.
 */
export async function recordVerificationPass(
  request: VerificationPassWriteRequest,
): Promise<VerificationPassRecordResult> {
  const location = deriveVerificationPassLocation(request.repositoryRoot, request.taskId);
  if (!location.ok) return recordFailure('LOCATION_UNSUITABLE', null);

  // The record must be about the task it is being written for. Checked here
  // rather than trusted, because the mint takes the identity from its caller and
  // a mismatched pair would put a record on this task's path claiming another
  // task's pass — readable, binding-valid for that other subject, and refused on
  // read as `NOT_THIS_TASK` for ever afterwards.
  if (
    request.pass.taskId !== request.taskId ||
    request.pass.repositoryRoot !== request.repositoryRoot
  ) {
    return recordFailure('CONFLICTING_RECORD', location.path);
  }

  // ── 1. Read what is there, ahead of any filesystem effect ────────────────
  const existing = loadVerificationPass(
    request.repositoryRoot,
    request.taskId,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );

  let replaced: boolean;
  if (existing.reading === 'PASS_RECORD') {
    replaced = true;
  } else if (existing.reading === 'ABSENT') {
    replaced = false;
  } else {
    // Something is on that path and this build cannot say what it claims.
    // Replacing it would be destroying a document whose content is unknown.
    return recordFailure('EXISTING_RECORD_UNREADABLE', location.path);
  }

  // ── 2. The ignore question, before any filesystem effect ─────────────────
  //
  // The relative path is DERIVED from the path about to be written rather than
  // spelled out again, for the reason `merge-reconciliation-store.ts` records: a
  // review found a hardcoded runtime literal beside a write target built from
  // two other constants, with nothing making them agree.
  const relativeRecord = relativePosix(request.repositoryRoot, location.path);
  if (relativeRecord === null) return recordFailure('LOCATION_UNSUITABLE', location.path);
  // `writeFileAtomically` stages `<name>.tmp-<suffix>` beside the target, and a
  // crash can leave one behind, so the staging shape is asked about too. One
  // call per name: `check-ignore --quiet` refuses a second pathname outright,
  // and dropping `--quiet` to batch them turns the conjunction this needs into
  // a disjunction.
  const stagingVerdict = await request.checkIgnored(`${relativeRecord}.tmp-probe`);
  if (stagingVerdict === 'UNDETERMINED') {
    return recordFailure('RUNTIME_IGNORE_UNDETERMINED', location.path);
  }
  if (stagingVerdict !== 'IGNORED') return recordFailure('RUNTIME_PATH_NOT_IGNORED', location.path);
  const recordVerdict = await request.checkIgnored(relativeRecord);
  if (recordVerdict === 'UNDETERMINED') {
    return recordFailure('RUNTIME_IGNORE_UNDETERMINED', location.path);
  }
  if (recordVerdict !== 'IGNORED') return recordFailure('RUNTIME_PATH_NOT_IGNORED', location.path);

  const subject: VerificationPassSubject = Object.freeze({
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
  });

  // ── 3. Prove this build would accept its own record back ─────────────────
  //
  // Read-back-before-write, the guard the sibling stores use. A record this
  // build could not parse would be indistinguishable on disk from one somebody
  // corrupted — and this one is read by the step that briefs a reviewer.
  if (readVerificationPass(request.pass, subject).reading !== 'PASS_RECORD') {
    return recordFailure('RECORD_CONTRACT_VIOLATION', location.path);
  }

  const bytes = Buffer.from(`${JSON.stringify(request.pass, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_VERIFICATION_PASS_RECORD_BYTES) {
    return recordFailure('RECORD_TOO_LARGE', location.path);
  }

  try {
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    return recordFailure('DIRECTORY_CREATE_FAILED', location.path, safeErrnoCode(error));
  }

  // ── 4. The lease, immediately before the effect ──────────────────────────
  //
  // Last of every gate and first of nothing, because it is the one whose answer
  // goes stale: the verification this records may have taken twenty minutes.
  if (!request.leaseHolds()) return recordFailure('EXECUTION_LEASE_NOT_HELD', location.path);

  const written = writeFileAtomically({
    directory: location.directory,
    fileName: location.fileName,
    contents: bytes,
    isAcceptableFileName: isVerificationPassFileName,
    ...(request.replace === undefined ? {} : { replace: request.replace }),
    ...(request.tempSuffix === undefined ? {} : { tempSuffix: request.tempSuffix }),
  });
  if (!written.written) {
    return recordFailure('WRITE_FAILED', location.path, written.errnoCode, 'FAILED');
  }

  // ── 5. Read it back off the disk ─────────────────────────────────────────
  //
  // `recorded: true` is a statement about the filesystem, and the only way to
  // make it one is to go and look. A later step briefs a reviewer from this
  // document, so "the write call returned" is not a strong enough thing to say.
  //
  // The write is **never re-issued** on a bad read-back: something is on that
  // path, and replacing it again would destroy a document this build cannot
  // read.
  const readBack = loadVerificationPass(
    request.repositoryRoot,
    request.taskId,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );
  if (
    readBack.reading !== 'PASS_RECORD' ||
    readBack.record === null ||
    readBack.record.binding !== request.pass.binding
  ) {
    return recordFailure('READBACK_FAILED', location.path, null, 'COMPLETED');
  }

  return Object.freeze({
    code: replaced ? ('PASS_REPLACED' as const) : ('PASS_RECORDED' as const),
    recorded: true as const,
    writeAttempt: 'COMPLETED' as const,
    path: location.path,
    errnoCode: null,
  });
}

/* ──────────────────────────────── reading ───────────────────────────────── */

export interface VerificationPassLoad {
  readonly reading: ReturnType<typeof readVerificationPass>['reading'];
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /**
   * The record, on `PASS_RECORD` only, and `null` on every other reading.
   * Nothing is handed back from a record this build refused.
   */
  readonly record: VerificationPassRecord | null;
}

function load(
  reading: VerificationPassLoad['reading'],
  path: string | null,
  record: VerificationPassRecord | null = null,
): VerificationPassLoad {
  return Object.freeze({ reading, path, record });
}

/**
 * Reads back the verification-pass record for one task.
 *
 * Named for what it produces. There is deliberately no `hasPassed` and no
 * `isVerified`: what this returns is a record of one past run against one
 * commit, and a name suggesting it described the task's standing *now* is
 * exactly the authority confusion the record's own header refuses.
 *
 * Never throws. An unreadable file, an oversized one, one that is not JSON and
 * one that is JSON of the wrong shape all reach a reading rather than an
 * exception.
 */
export function loadVerificationPass(
  repositoryRoot: string,
  taskId: string,
  /**
   * The open. Production uses `openSync`.
   *
   * Injectable for the reason the sibling store gives: the property below — "a
   * file that exists and cannot be opened is never reported as one nobody
   * wrote" — cannot be observed on demand against a real filesystem.
   */
  open: (path: string) => number = (path) => openSync(path, 'r'),
  /**
   * One chunk read. Production uses `readSync`.
   *
   * Injectable for the same reason `open` is: the branch that refuses a **short
   * read** is defence against a partial read no fixture can provoke, and without
   * this seam it is unreachable and therefore unpinned.
   */
  readChunk: (
    handle: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number = readSync,
): VerificationPassLoad {
  const location = deriveVerificationPassLocation(repositoryRoot, taskId);
  if (!location.ok) return load('MALFORMED', null);

  const subject: VerificationPassSubject = Object.freeze({ taskId, repositoryRoot });

  let handle: number;
  try {
    handle = open(location.path);
  } catch (error: unknown) {
    // Not-found is the only errno that means "nobody wrote one". Every other
    // reason a file cannot be opened is a file that may well exist, and
    // reporting it as absent would let a reviewer be briefed "not measured"
    // about a task whose measurement is sitting there unreadable.
    return load(safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'MALFORMED', location.path);
  }

  try {
    const stat = fstatSync(handle);
    // A directory standing where the record should be is not a record. Stated as
    // its own check because the platform does not state it for us: measured on
    // Windows, `openSync(dir, 'r')` succeeds and `fstat` reports size 0.
    if (!stat.isFile()) return load('MALFORMED', location.path);
    const size = stat.size;
    if (size > MAX_VERIFICATION_PASS_RECORD_BYTES) return load('MALFORMED', location.path);
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const chunk = readChunk(handle, buffer, read, size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    // A short read is a torn or truncated file, not a smaller record.
    if (read !== size) return load('MALFORMED', location.path);

    let raw: unknown;
    try {
      raw = JSON.parse(buffer.subarray(0, read).toString('utf8'));
    } catch {
      return load('MALFORMED', location.path);
    }

    const result = readVerificationPass(raw, subject);
    return load(result.reading, location.path, result.record);
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A handle that cannot be closed changes nothing about the reading above,
      // and throwing here would turn a successful read into an exception.
    }
  }
}
