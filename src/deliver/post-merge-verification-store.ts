/**
 * Where a post-merge verification history lives, and the rules for changing it.
 *
 * ── One file per task, in its own directory ────────────────────────────────
 *
 * `<runtime>/delivery-verification/<taskId>.json`, following the precedent
 * `block/block-store.ts` set with `<runtime>/blocks/<runId>.json`,
 * `delivery-evidence-store.ts` followed with `<runtime>/delivery/<taskId>.json`
 * and `merge-reconciliation-store.ts` followed with
 * `<runtime>/delivery-merge/<taskId>.json`: a new kind of per-repository record
 * gets its own **directory** rather than its own name inside a shared one. A
 * task id may contain dots, so `<id>.verification.json` is a legal *other
 * task's* file name — the collision that made the rule.
 *
 * ── Append, never overwrite ────────────────────────────────────────────────
 *
 * The record's own header sets out why a verification history cannot be one
 * immutable fact, cannot be latest-wins, and cannot be two files. What this
 * module adds is how that is enforced:
 *
 *  - an existing history is **read first**, and every attempt already in it is
 *    carried forward byte-for-byte into the new document. Nothing here can edit
 *    a stored verdict, because nothing here builds one — the old attempts are
 *    copied, and exactly one new attempt is appended;
 *  - the record's **header** — subject commit, merge commit, target, pull
 *    request — must match what the caller is recording for. A history whose
 *    merge commit is not the one now being verified is not this delivery's
 *    history, and it is refused rather than re-pointed;
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
 * Stated as what it is. `state/atomic-file.ts` replaces **one** file
 * atomically; two invocations racing on one task can both read the same history
 * and both append, and the second replace wins — losing the first's attempt.
 * That is a lost *record of a run*, not a corrupted document, and it is
 * bounded by the execution lease the caller must hold to have run anything at
 * all. It is written down here rather than left for a reader to discover,
 * because a module that claimed a transaction AO does not have would be wrong
 * on the first interruption.
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
import { relativePosix } from '../state/runtime-ignored.js';
import {
  MAX_POST_MERGE_VERIFICATION_BYTES,
  MAX_VERIFICATION_ATTEMPTS,
  POST_MERGE_VERIFICATION_VERSION,
  postMergeVerificationBinding,
  readPostMergeVerification,
  type PostMergeVerification,
  type PostMergeVerificationPayload,
  type PostMergeVerificationReading,
  type PostMergeVerificationSubject,
  type VerificationAttempt,
} from './post-merge-verification.js';
import { postMergeVerificationFactsOf } from './post-merge-verification-proof.js';

/** The directory name holding verification histories. See the header. */
export const POST_MERGE_VERIFICATION_DIR_NAME = 'delivery-verification';

/** The extension of a verification history file. */
export const POST_MERGE_VERIFICATION_FILE_EXTENSION = TASK_STATE_FILE_EXTENSION;

/** The directory holding verification histories for a canonical repository root. */
export function postMergeVerificationDirectory(repositoryRoot: string): string {
  return join(taskRuntimeDirectory(repositoryRoot), POST_MERGE_VERIFICATION_DIR_NAME);
}

/**
 * Whether a name is one of this store's files.
 *
 * `state-location.ts`'s grammar, shared rather than restated: the separation
 * between the kinds of record is structural — a directory — so a second copy of
 * the rule could only drift from the first.
 */
export function isPostMergeVerificationFileName(name: string): boolean {
  return isStateFileName(name);
}

export interface PostMergeVerificationLocation {
  readonly ok: true;
  readonly directory: string;
  readonly fileName: string;
  readonly path: string;
}

export interface PostMergeVerificationLocationFailure {
  readonly ok: false;
  readonly code: 'REPOSITORY_ROOT_UNSUITABLE' | 'TASK_ID_UNSUITABLE';
}

export type PostMergeVerificationLocationResult =
  | PostMergeVerificationLocation
  | PostMergeVerificationLocationFailure;

/** Where one task's verification history belongs, or why it has no location. */
export function derivePostMergeVerificationLocation(
  repositoryRoot: string,
  taskId: string,
): PostMergeVerificationLocationResult {
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }
  if (!isValidTaskId(taskId)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const fileName = `${taskId}${POST_MERGE_VERIFICATION_FILE_EXTENSION}`;
  // Belt and braces: the derived name is judged in its own right, so a future
  // change cannot silently produce a name nothing would accept back.
  if (!isPostMergeVerificationFileName(fileName)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const directory = postMergeVerificationDirectory(repositoryRoot);
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
export type PostMergeVerificationRecordCode =
  /** Appended to an existing history. */
  | 'ATTEMPT_RECORDED'
  /** Wrote the first attempt of a new history. */
  | 'HISTORY_STARTED'
  /**
   * A successful attempt for exactly this commit under exactly this profile is
   * already on disk. Nothing was written and — see `verify-merge.ts` — nothing
   * was run.
   *
   * It means **"a historical successful verification exists"**, never "this
   * commit is verified now". The distinction is the same one slice 3 draws
   * about its own stored observation, and it is why this code is not spelled
   * `VERIFIED`.
   */
  | 'ALREADY_VERIFIED'
  /** The value handed in is not a minted verification proof. Nothing was written. */
  | 'VERIFICATION_NOT_PROVEN'
  /** The proof describes a different commit than the one being recorded for. */
  | 'SUBJECT_MISMATCH'
  /** A history is on disk for a different merge, target or pull request. */
  | 'CONFLICTING_HISTORY'
  /** Something is on disk that this build cannot read. Never replaced blindly. */
  | 'EXISTING_HISTORY_UNREADABLE'
  /** The history holds the most attempts this build keeps. Nothing was written. */
  | 'ATTEMPT_HISTORY_FULL'
  /** No location could be derived for this repository and task. */
  | 'LOCATION_UNSUITABLE'
  /** The record's own path is not ignored by Git, or the answer was unreadable. */
  | 'RUNTIME_PATH_NOT_IGNORED'
  | 'RUNTIME_IGNORE_UNDETERMINED'
  /** This build would not accept back the document it just built. */
  | 'RECORD_CONTRACT_VIOLATION'
  /** The document exceeds this build's byte budget. */
  | 'RECORD_TOO_LARGE'
  /** The directory could not be created. */
  | 'DIRECTORY_CREATE_FAILED'
  /** The atomic replace did not complete. */
  | 'WRITE_FAILED';

export const WRITE_ATTEMPTS = ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const;
export type WriteAttempt = (typeof WRITE_ATTEMPTS)[number];

export interface PostMergeVerificationRecordResult {
  readonly code: PostMergeVerificationRecordCode;
  /** Whether the durable history now contains this attempt. */
  readonly recorded: boolean;
  /** Whether a write was tried, and how it ended. Never inferred from `code`. */
  readonly writeAttempt: WriteAttempt;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  readonly errnoCode: string | null;
}

export type IgnoreVerdict = 'IGNORED' | 'NOT_IGNORED' | 'UNDETERMINED';

export interface PostMergeVerificationWriteRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** The proof. The only route to an attempt this store will file. */
  readonly proof: unknown;
  /** The implementation head H, from the merge receipt. */
  readonly expectedSubjectCommit: string;
  /** The merge commit M, from the merge receipt. The proof must be about it. */
  readonly expectedMergeCommit: string;
  readonly expectedHost: string;
  readonly expectedOwner: string;
  readonly expectedName: string;
  readonly expectedPullRequestNumber: number;
  /** Whether Git ignores a repository-relative path. */
  readonly checkIgnored: (relativePath: string) => Promise<IgnoreVerdict>;
  readonly open?: (path: string) => number;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

function recordFailure(
  code: PostMergeVerificationRecordCode,
  path: string | null,
  errnoCode: string | null = null,
  writeAttempt: WriteAttempt = 'NOT_ATTEMPTED',
): PostMergeVerificationRecordResult {
  return Object.freeze({ code, recorded: false as const, writeAttempt, path, errnoCode });
}

/**
 * Whether an existing history is about the delivery now being verified.
 *
 * Every field of the header, one by one. A history that agrees about the task
 * and disagrees about the merge is not a stale copy to be extended; it is a
 * record of a *different* delivery under this task's name, and appending to it
 * would put two merges' attempts in one list with nothing saying which was
 * which.
 */
function sameDelivery(
  existing: PostMergeVerification,
  payload: PostMergeVerificationPayload,
): boolean {
  return (
    existing.subjectCommit === payload.subjectCommit &&
    existing.mergeCommit === payload.mergeCommit &&
    existing.provider === payload.provider &&
    existing.host === payload.host &&
    existing.owner === payload.owner &&
    existing.name === payload.name &&
    existing.pullRequestNumber === payload.pullRequestNumber
  );
}

/**
 * Whether a history already holds a successful attempt for this profile.
 *
 * Both halves matter. A pass under a *different* profile does not answer the
 * current profile's question — that is a structural reason, and the only kind
 * this build accepts for setting an old result aside. Age is never one.
 */
export function hasPassFor(existing: PostMergeVerification, profileDigest: string): boolean {
  return existing.attempts.some(
    (attempt) => attempt.outcome === 'VERIFIED_PASS' && attempt.profileDigest === profileDigest,
  );
}

/**
 * Records one verification attempt against a task's history.
 *
 * Never throws for an expected condition, and never overwrites an attempt.
 */
export async function recordPostMergeVerification(
  request: PostMergeVerificationWriteRequest,
): Promise<PostMergeVerificationRecordResult> {
  // ── 1. Provenance, before anything else ──────────────────────────────────
  const facts = postMergeVerificationFactsOf(request.proof);
  if (facts === null) return recordFailure('VERIFICATION_NOT_PROVEN', null);

  const location = derivePostMergeVerificationLocation(request.repositoryRoot, request.taskId);
  if (!location.ok) return recordFailure('LOCATION_UNSUITABLE', null);

  // ── 2. The proof must be about the merge being recorded for ──────────────
  //
  // The mint already guarantees the workspace HEAD equalled the proof's own
  // merge commit — that a run happened against *some* exact commit. It cannot
  // guarantee that commit is the one the task's receipt names, because it never
  // saw the receipt. This is where those two meet.
  // Two comparisons, and they are a **pair** rather than two gates. The mint
  // guarantees `facts.workspaceHeadCommit === facts.mergeCommit`, so against a
  // genuinely minted proof either line alone refuses everything the other one
  // would — and a counter-proof measured exactly that: each mutant survives the
  // whole suite on its own, and removing *both* together is killed.
  //
  // They stay as a pair because they fail in opposite directions if the mint
  // changes. The first is the one that matters if the mint's equality check
  // were ever removed and a proof arrived naming one commit while having been
  // run against another; the second is the one that matters if the proof's
  // `mergeCommit` field were ever set from something other than the run. Their
  // honest status is "each redundant while the mint holds, together not".
  if (facts.mergeCommit !== request.expectedMergeCommit) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }
  if (facts.workspaceHeadCommit !== request.expectedMergeCommit) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }

  const subject: PostMergeVerificationSubject = Object.freeze({
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
  });

  const attempt: VerificationAttempt = {
    attemptedAt: facts.attemptedAt,
    profileDigest: facts.profileDigest,
    outcome: facts.outcome,
    stoppedAt: facts.stoppedAt,
    exitCode: facts.exitCode,
    signal: facts.signal,
    phasesRun: facts.phasesRun,
  };

  const header = {
    verificationVersion: POST_MERGE_VERIFICATION_VERSION,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
    subjectCommit: request.expectedSubjectCommit,
    mergeCommit: request.expectedMergeCommit,
    provider: 'github' as const,
    host: request.expectedHost,
    owner: request.expectedOwner,
    name: request.expectedName,
    pullRequestNumber: request.expectedPullRequestNumber,
  };

  // ── 3. Read what is there, ahead of any filesystem effect ────────────────
  const existing = loadPostMergeVerification(
    request.repositoryRoot,
    request.taskId,
    subject,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );

  let attempts: VerificationAttempt[];
  let started: boolean;

  if (existing.reading === 'VERIFICATION_HISTORY') {
    // `record` is non-null on this reading by construction; the guard is here so
    // a future change to the load result cannot make this arm read `null` as an
    // empty history and quietly start a new one over it.
    if (existing.record === null) {
      return recordFailure('EXISTING_HISTORY_UNREADABLE', location.path);
    }
    const priorPayload: PostMergeVerificationPayload = {
      ...header,
      attempts: [...existing.record.attempts],
    };
    if (!sameDelivery(existing.record, priorPayload)) {
      return recordFailure('CONFLICTING_HISTORY', location.path);
    }
    if (hasPassFor(existing.record, attempt.profileDigest)) {
      // `recorded: false`, and the field's own documentation is why: it says
      // whether the history now contains **this attempt**, and it does not —
      // the attempt handed in was discarded in favour of an earlier passing
      // one. A review found this returning `true`, which would have told a
      // caller a verdict was durable when the file had not been touched.
      //
      // The code is what carries the good news. `ALREADY_VERIFIED` means a
      // historical successful verification exists for this exact commit and
      // profile; it does not mean this run was filed.
      return Object.freeze({
        code: 'ALREADY_VERIFIED' as const,
        recorded: false as const,
        writeAttempt: 'NOT_ATTEMPTED' as const,
        path: location.path,
        errnoCode: null,
      });
    }
    if (existing.record.attempts.length >= MAX_VERIFICATION_ATTEMPTS) {
      return recordFailure('ATTEMPT_HISTORY_FULL', location.path);
    }
    // Carried forward, not rebuilt. Nothing in this function can edit a stored
    // attempt, because nothing in this function constructs one from an old one.
    attempts = [...existing.record.attempts, attempt];
    started = false;
  } else if (existing.reading === 'ABSENT') {
    attempts = [attempt];
    started = true;
  } else {
    // `MALFORMED`, `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` all mean the same
    // thing to a writer: something is on that path and this build cannot say
    // what it claims. Replacing it would be destroying a document whose content
    // is unknown. It fails closed.
    return recordFailure('EXISTING_HISTORY_UNREADABLE', location.path);
  }

  const payload: PostMergeVerificationPayload = { ...header, attempts };

  // ── 4. The ignore question, before any filesystem effect ─────────────────
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

  const document = { ...payload, binding: postMergeVerificationBinding(subject, payload) };

  // ── 5. Prove this build would accept its own record back ─────────────────
  //
  // Read-back-before-write, the same guard slices 3 and 8 use. A record this
  // build could not parse would be indistinguishable on disk from one somebody
  // corrupted.
  if (readPostMergeVerification(document, subject).reading !== 'VERIFICATION_HISTORY') {
    return recordFailure('RECORD_CONTRACT_VIOLATION', location.path);
  }

  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_POST_MERGE_VERIFICATION_BYTES) {
    return recordFailure('RECORD_TOO_LARGE', location.path);
  }

  try {
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    return recordFailure('DIRECTORY_CREATE_FAILED', location.path, safeErrnoCode(error));
  }

  const written = writeFileAtomically({
    directory: location.directory,
    fileName: location.fileName,
    contents: bytes,
    isAcceptableFileName: isPostMergeVerificationFileName,
    ...(request.replace === undefined ? {} : { replace: request.replace }),
    ...(request.tempSuffix === undefined ? {} : { tempSuffix: request.tempSuffix }),
  });
  if (!written.written) {
    return recordFailure('WRITE_FAILED', location.path, written.errnoCode, 'FAILED');
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

export interface PostMergeVerificationLoad {
  readonly reading: PostMergeVerificationReading;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /**
   * The history, on `VERIFICATION_HISTORY` only, and `null` on every other
   * reading. Nothing is handed back from a record this build refused.
   */
  readonly record: PostMergeVerification | null;
}

function load(
  reading: PostMergeVerificationReading,
  path: string | null,
  record: PostMergeVerification | null = null,
): PostMergeVerificationLoad {
  return Object.freeze({ reading, path, record });
}

/**
 * Reads back the verification history for one task.
 *
 * Named for what it produces. There is deliberately no `isVerified` and no
 * `loadCurrentVerification`: what this returns is a list of past runs, and a
 * name suggesting it described the base branch now — or the commit's standing
 * today — is the defect this slice exists to avoid.
 *
 * Never throws. An unreadable file, an oversized one, one that is not JSON and
 * one that is JSON of the wrong shape all reach a reading rather than an
 * exception.
 */
export function loadPostMergeVerification(
  repositoryRoot: string,
  taskId: string,
  subject: PostMergeVerificationSubject,
  /**
   * The open. Production uses `openSync`.
   *
   * Injectable for the reason `state/atomic-file.ts` gives about its `replace`:
   * the property below — "a file that exists and cannot be opened is never
   * reported as one nobody wrote" — cannot be observed on demand against a real
   * filesystem, because it needs an open that fails with something other than
   * `ENOENT` at a chosen moment. Measured on Windows: opening a *directory*
   * succeeds and reports size 0, so the obvious fixture does not reach this
   * path at all.
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
): PostMergeVerificationLoad {
  const location = derivePostMergeVerificationLocation(repositoryRoot, taskId);
  if (!location.ok) return load('MALFORMED', null);

  let handle: number;
  try {
    handle = open(location.path);
  } catch (error: unknown) {
    // Not-found is the only errno that means "nobody wrote one". Every other
    // reason a file cannot be opened is a file that may well exist, and
    // reporting it as absent would turn a permissions problem into "AO has
    // never verified this merge" — and, at the writer above, into permission to
    // start a fresh history over it.
    return load(safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'MALFORMED', location.path);
  }

  try {
    const stat = fstatSync(handle);
    // A directory standing where the record should be is not a record. Stated
    // as its own check because the platform does not state it for us: measured
    // on Windows, `openSync(dir, 'r')` succeeds and `fstat` reports size 0, so
    // without this a directory would read as an empty file.
    if (!stat.isFile()) return load('MALFORMED', location.path);
    const size = stat.size;
    if (size > MAX_POST_MERGE_VERIFICATION_BYTES) return load('MALFORMED', location.path);
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

    const result = readPostMergeVerification(raw, subject);
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
