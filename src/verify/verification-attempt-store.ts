/**
 * Where a task's verification-attempt history lives, and the rules for changing
 * it.
 *
 * ── One file per task, in its own directory ────────────────────────────────
 *
 * `<runtime>/verification-attempts/<taskId>.json`, following the precedent
 * `block/block-store.ts` set with `<runtime>/blocks/<runId>.json` and
 * `deliver/post-merge-verification-store.ts` followed with
 * `<runtime>/delivery-verification/<taskId>.json`: a new kind of per-repository
 * record gets its own **directory** rather than its own name inside a shared
 * one. A task id may contain dots, so `<id>.verification.json` is a legal *other
 * task's* file name — the collision that made the rule, and one a review had
 * already reproduced once against `<taskId>.delivery.json`.
 *
 * ── Under the repository root, never under the worktree ────────────────────
 *
 * `taskRuntimeDirectory(repositoryRoot)`, and the distinction is a security
 * boundary rather than a tidiness one. The writing agent runs with its cwd set
 * to the *worktree*, which is a sibling of the repository root, and
 * `agent/claude-writer.ts` records the measurement that `acceptEdits` confines it
 * there. A record placed under the worktree's own `.agent-orchestrator/runtime/`
 * would therefore be **writable by the agent whose work it describes** — and,
 * because `scope/task-delta.ts` passes `--exclude-standard`, a forged one would
 * be structurally invisible to the scope guard. That is a forgery primitive with
 * no detector, and the only defence is not to put the record there.
 *
 * ── Append, never overwrite ────────────────────────────────────────────────
 *
 * `verification-attempt.ts`'s header sets out why a verification history cannot
 * be one immutable fact, cannot be latest-wins, and cannot be two files. What
 * this module adds is how that is enforced, and it is the sibling store's list
 * because the reasoning is the sibling store's:
 *
 *  - an existing history is **read first**, and every attempt already in it is
 *    carried forward byte-for-byte. Nothing here can edit a stored attempt,
 *    because nothing here builds one from an old one — the old attempts are
 *    copied, and exactly one new attempt is appended;
 *  - the record's **header** — task id and repository root — must match what the
 *    caller is recording for, or the write is refused rather than re-pointed;
 *  - a document this build cannot read is **never replaced**. `MALFORMED`,
 *    `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` all mean "something is there and
 *    this build cannot say what it claims", including — under
 *    `UNSUPPORTED_VERSION` — a perfectly good history written by a newer build;
 *  - when the history is **full** the attempt is refused, with its own code.
 *    Making room would mean deleting the oldest evidence, which is the evidence
 *    most likely to disagree with the newest.
 *
 * ── Read-before-write, and not a transaction ───────────────────────────────
 *
 * Stated as what it is, in the sibling store's words because they are exactly
 * true here too. `state/atomic-file.ts` replaces **one** file atomically; two
 * invocations racing on one task can both read the same history and both append,
 * and the second replace wins — losing the first's attempt. That is a lost
 * *record of a run*, not a corrupted document, and it is bounded by the
 * execution lease the caller must hold to have run anything at all.
 *
 * ── The lease is proved here, not only upstream ────────────────────────────
 *
 * {@link recordVerificationAttempt} takes an authority and re-proves it
 * immediately before the write. That is not belt and braces: the verification
 * whose result this records can take twenty minutes, so the lease check the
 * *spawn* made is twenty minutes stale by the time the record is built, and a
 * record written by a run that has stopped being the repository's writer is a
 * durable artefact from an unauthorised process. `loop/leased-spawns.ts` fences
 * every Git mutation the same way, immediately before the effect, for the same
 * reason.
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
  MAX_VERIFICATION_ATTEMPTS_KEPT,
  MAX_VERIFICATION_ATTEMPT_RECORD_BYTES,
  readVerificationAttempts,
  VERIFICATION_ATTEMPT_VERSION,
  verificationAttemptBinding,
  type VerificationAttemptHistory,
  type VerificationAttemptHistoryPayload,
  type VerificationAttemptRecord,
  type VerificationAttemptSubject,
} from './verification-attempt.js';

/** The directory name holding verification-attempt histories. See the header. */
export const VERIFICATION_ATTEMPT_DIR_NAME = 'verification-attempts';

/** The extension of a verification-attempt history file. */
export const VERIFICATION_ATTEMPT_FILE_EXTENSION = TASK_STATE_FILE_EXTENSION;

/** The directory holding attempt histories for a canonical repository root. */
export function verificationAttemptDirectory(repositoryRoot: string): string {
  return join(taskRuntimeDirectory(repositoryRoot), VERIFICATION_ATTEMPT_DIR_NAME);
}

/**
 * Whether a name is one of this store's files.
 *
 * `state-location.ts`'s grammar, shared rather than restated: the separation
 * between the kinds of record is structural — a directory — so a second copy of
 * the rule could only drift from the first.
 */
export function isVerificationAttemptFileName(name: string): boolean {
  return isStateFileName(name);
}

export interface VerificationAttemptLocation {
  readonly ok: true;
  readonly directory: string;
  readonly fileName: string;
  readonly path: string;
}

export interface VerificationAttemptLocationFailure {
  readonly ok: false;
  readonly code: 'REPOSITORY_ROOT_UNSUITABLE' | 'TASK_ID_UNSUITABLE';
}

export type VerificationAttemptLocationResult =
  | VerificationAttemptLocation
  | VerificationAttemptLocationFailure;

/** Where one task's attempt history belongs, or why it has no location. */
export function deriveVerificationAttemptLocation(
  repositoryRoot: string,
  taskId: string,
): VerificationAttemptLocationResult {
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }
  if (!isValidTaskId(taskId)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const fileName = `${taskId}${VERIFICATION_ATTEMPT_FILE_EXTENSION}`;
  // Belt and braces: the derived name is judged in its own right, so a future
  // change cannot silently produce a name nothing would accept back.
  if (!isVerificationAttemptFileName(fileName)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const directory = verificationAttemptDirectory(repositoryRoot);
  const path = join(directory, fileName);
  // Belt and braces: even with a validated id, prove the result stayed inside
  // the repository it belongs to.
  if (!isContained(repositoryRoot, path)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  return Object.freeze({ ok: true as const, directory, fileName, path });
}

/* ─────────────────────────────── recording ──────────────────────────────── */

/** Every way recording an attempt can end. A closed set, and two of them wrote. */
export const VERIFICATION_ATTEMPT_RECORD_CODES = [
  /** Appended to an existing history. */
  'ATTEMPT_RECORDED',
  /** Wrote the first attempt of a new history. */
  'HISTORY_STARTED',
  /** This run is no longer the repository's writer. Nothing was written. */
  'EXECUTION_LEASE_NOT_HELD',
  /** A history is on disk for a different task or repository. */
  'CONFLICTING_HISTORY',
  /** Something is on disk that this build cannot read. Never replaced blindly. */
  'EXISTING_HISTORY_UNREADABLE',
  /** The history holds the most attempts this build keeps. Nothing was written. */
  'ATTEMPT_HISTORY_FULL',
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

export type VerificationAttemptRecordCode = (typeof VERIFICATION_ATTEMPT_RECORD_CODES)[number];

export const WRITE_ATTEMPTS = ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const;
export type WriteAttempt = (typeof WRITE_ATTEMPTS)[number];

export interface VerificationAttemptRecordResult {
  readonly code: VerificationAttemptRecordCode;
  /** Whether the durable history now contains this attempt. */
  readonly recorded: boolean;
  /** Whether a write was tried, and how it ended. Never inferred from `code`. */
  readonly writeAttempt: WriteAttempt;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  readonly errnoCode: string | null;
}

export interface VerificationAttemptWriteRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** The attempt to append. Built by the caller from its own `VerificationReport`. */
  readonly attempt: VerificationAttemptRecord;
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
  code: VerificationAttemptRecordCode,
  path: string | null,
  errnoCode: string | null = null,
  writeAttempt: WriteAttempt = 'NOT_ATTEMPTED',
): VerificationAttemptRecordResult {
  return Object.freeze({ code, recorded: false as const, writeAttempt, path, errnoCode });
}

/**
 * Records one verification attempt against a task's history.
 *
 * Never throws for an expected condition, and never overwrites an attempt.
 */
export async function recordVerificationAttempt(
  request: VerificationAttemptWriteRequest,
): Promise<VerificationAttemptRecordResult> {
  const location = deriveVerificationAttemptLocation(request.repositoryRoot, request.taskId);
  if (!location.ok) return recordFailure('LOCATION_UNSUITABLE', null);

  const subject: VerificationAttemptSubject = Object.freeze({
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
  });

  const header = {
    attemptVersion: VERIFICATION_ATTEMPT_VERSION,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
  };

  // ── 1. Read what is there, ahead of any filesystem effect ────────────────
  const existing = loadVerificationAttempts(
    request.repositoryRoot,
    request.taskId,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );

  let attempts: VerificationAttemptRecord[];
  let started: boolean;

  if (existing.reading === 'ATTEMPT_HISTORY') {
    // `record` is non-null on this reading by construction; the guard is here so
    // a future change to the load result cannot make this arm read `null` as an
    // empty history and quietly start a new one over it.
    if (existing.record === null) {
      return recordFailure('EXISTING_HISTORY_UNREADABLE', location.path);
    }
    if (
      existing.record.taskId !== header.taskId ||
      existing.record.repositoryRoot !== header.repositoryRoot
    ) {
      return recordFailure('CONFLICTING_HISTORY', location.path);
    }
    if (existing.record.attempts.length >= MAX_VERIFICATION_ATTEMPTS_KEPT) {
      return recordFailure('ATTEMPT_HISTORY_FULL', location.path);
    }
    // Carried forward, not rebuilt. Nothing in this function can edit a stored
    // attempt, because nothing in this function constructs one from an old one.
    attempts = [...existing.record.attempts, request.attempt];
    started = false;
  } else if (existing.reading === 'ABSENT') {
    attempts = [request.attempt];
    started = true;
  } else {
    // `MALFORMED`, `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` all mean the same
    // thing to a writer: something is on that path and this build cannot say
    // what it claims. Replacing it would be destroying a document whose content
    // is unknown. It fails closed.
    return recordFailure('EXISTING_HISTORY_UNREADABLE', location.path);
  }

  const payload: VerificationAttemptHistoryPayload = { ...header, attempts };

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

  const document = { ...payload, binding: verificationAttemptBinding(subject, payload) };

  // ── 3. Prove this build would accept its own record back ─────────────────
  //
  // Read-back-before-write, the guard the sibling stores use. A record this
  // build could not parse would be indistinguishable on disk from one somebody
  // corrupted.
  if (readVerificationAttempts(document, subject).reading !== 'ATTEMPT_HISTORY') {
    return recordFailure('RECORD_CONTRACT_VIOLATION', location.path);
  }

  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_VERIFICATION_ATTEMPT_RECORD_BYTES) {
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
  // Placed after `mkdir` deliberately — a created empty directory is inert, and
  // asking earlier would leave a wider window between the proof and the write
  // than between the proof and any other step.
  if (!request.leaseHolds()) return recordFailure('EXECUTION_LEASE_NOT_HELD', location.path);

  const written = writeFileAtomically({
    directory: location.directory,
    fileName: location.fileName,
    contents: bytes,
    isAcceptableFileName: isVerificationAttemptFileName,
    ...(request.replace === undefined ? {} : { replace: request.replace }),
    ...(request.tempSuffix === undefined ? {} : { tempSuffix: request.tempSuffix }),
  });
  if (!written.written) {
    return recordFailure('WRITE_FAILED', location.path, written.errnoCode, 'FAILED');
  }

  // ── 5. Read it back off the disk ─────────────────────────────────────────
  //
  // `recorded: true` is a statement about the filesystem, and the only way to
  // make it one is to go and look. A caller acts on this by writing
  // `BLOCKED_VERIFY` — a durable accusation whose whole justification is that
  // the explanation is now readable — so "the write call returned" is not a
  // strong enough thing to say.
  //
  // The write is **never re-issued** on a bad read-back. Something is on that
  // path; replacing it again would destroy a document this build cannot read,
  // which is the rule the load path already follows.
  const readBack = loadVerificationAttempts(
    request.repositoryRoot,
    request.taskId,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );
  if (
    readBack.reading !== 'ATTEMPT_HISTORY' ||
    readBack.record === null ||
    readBack.record.binding !== document.binding
  ) {
    return recordFailure('READBACK_FAILED', location.path, null, 'COMPLETED');
  }

  return Object.freeze({
    code: started ? ('HISTORY_STARTED' as const) : ('ATTEMPT_RECORDED' as const),
    recorded: true as const,
    writeAttempt: 'COMPLETED' as const,
    path: location.path,
    errnoCode: null,
  });
}

/* ──────────────────────────────── reading ───────────────────────────────── */

export interface VerificationAttemptLoad {
  readonly reading: ReturnType<typeof readVerificationAttempts>['reading'];
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /**
   * The history, on `ATTEMPT_HISTORY` only, and `null` on every other reading.
   * Nothing is handed back from a record this build refused.
   */
  readonly record: VerificationAttemptHistory | null;
}

function load(
  reading: VerificationAttemptLoad['reading'],
  path: string | null,
  record: VerificationAttemptHistory | null = null,
): VerificationAttemptLoad {
  return Object.freeze({ reading, path, record });
}

/**
 * Reads back the verification-attempt history for one task.
 *
 * Named for what it produces. There is deliberately no `isVerifying`, no
 * `lastFailure` and no `verificationFailed`: what this returns is a list of past
 * runs, and a name suggesting it described the task's standing now is exactly
 * the authority confusion the record's own header refuses.
 *
 * Never throws. An unreadable file, an oversized one, one that is not JSON and
 * one that is JSON of the wrong shape all reach a reading rather than an
 * exception.
 */
export function loadVerificationAttempts(
  repositoryRoot: string,
  taskId: string,
  /**
   * The open. Production uses `openSync`.
   *
   * Injectable for the reason `state/atomic-file.ts` gives about its `replace`:
   * the property below — "a file that exists and cannot be opened is never
   * reported as one nobody wrote" — cannot be observed on demand against a real
   * filesystem, because it needs an open that fails with something other than
   * `ENOENT` at a chosen moment. Measured on Windows: opening a *directory*
   * succeeds and reports size 0, so the obvious fixture does not reach this path
   * at all.
   */
  open: (path: string) => number = (path) => openSync(path, 'r'),
  /**
   * One chunk read. Production uses `readSync`.
   *
   * Injectable for the same reason `open` is, and for one this repository has
   * learned to state: the branch below that refuses a **short read** is defence
   * against a partial read that no fixture can provoke, because a real
   * filesystem serving a small local file does not return early. Without this
   * seam that branch is unreachable and therefore unpinned — an absence
   * assertion that is vacuous until the mutant dies.
   */
  readChunk: (
    handle: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number = readSync,
): VerificationAttemptLoad {
  const location = deriveVerificationAttemptLocation(repositoryRoot, taskId);
  if (!location.ok) return load('MALFORMED', null);

  const subject: VerificationAttemptSubject = Object.freeze({ taskId, repositoryRoot });

  let handle: number;
  try {
    handle = open(location.path);
  } catch (error: unknown) {
    // Not-found is the only errno that means "nobody wrote one". Every other
    // reason a file cannot be opened is a file that may well exist, and
    // reporting it as absent would turn a permissions problem into "AO recorded
    // no explanation" — and, at the writer above, into permission to start a
    // fresh history over it.
    return load(safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'MALFORMED', location.path);
  }

  try {
    const stat = fstatSync(handle);
    // A directory standing where the record should be is not a record. Stated as
    // its own check because the platform does not state it for us: measured on
    // Windows, `openSync(dir, 'r')` succeeds and `fstat` reports size 0, so
    // without this a directory would read as an empty file.
    if (!stat.isFile()) return load('MALFORMED', location.path);
    const size = stat.size;
    if (size > MAX_VERIFICATION_ATTEMPT_RECORD_BYTES) return load('MALFORMED', location.path);
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

    const result = readVerificationAttempts(raw, subject);
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

/**
 * The most recent attempt in a task's history, or `null`.
 *
 * `null` for every reading that is not `ATTEMPT_HISTORY`, which deliberately
 * makes "nobody wrote one" and "something is there and cannot be read"
 * indistinguishable **to this helper**. Callers that must tell them apart —
 * every caller that reports to an operator — read {@link loadVerificationAttempts}
 * and switch on `reading`. This exists for the one caller that only wants the
 * evidence, and it is named so that the absence it returns cannot be read as a
 * verdict.
 */
export function latestVerificationAttempt(
  load: VerificationAttemptLoad,
): VerificationAttemptRecord | null {
  if (load.reading !== 'ATTEMPT_HISTORY' || load.record === null) return null;
  const attempts = load.record.attempts;
  return attempts.length === 0 ? null : (attempts[attempts.length - 1] ?? null);
}
