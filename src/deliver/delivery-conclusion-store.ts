/**
 * Where a delivery conclusion lives, and the rules for writing one.
 *
 * ── One file per task, in its own directory ────────────────────────────────
 *
 * `<runtime>/delivery-conclusion/<taskId>.json`, following the precedent
 * `block/block-store.ts` set with `<runtime>/blocks/<runId>.json` and the three
 * delivery records have followed since: a new kind of per-repository record
 * gets its own **directory** rather than its own name inside a shared one. A
 * task id may contain dots, so `<id>.conclusion.json` is a legal *other task's*
 * file name — the collision that made the rule.
 *
 * ── Written once, never overwritten ────────────────────────────────────────
 *
 * Slice 8's discipline, not slice 9's. A conclusion is a judgement about two
 * documents at an instant, and re-drawing it from the same documents produces
 * the same judgement, so there is nothing to accumulate:
 *
 *  - an existing conclusion is **read first**. One that agrees about the
 *    delivery answers `ALREADY_CONCLUDED` and writes nothing; one that
 *    disagrees is `CONFLICTING_CONCLUSION` and writes nothing;
 *  - a document this build cannot read is **never replaced**. `MALFORMED`,
 *    `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` all mean "something is there and
 *    this build cannot say what it claims", including — under
 *    `UNSUPPORTED_VERSION` — a perfectly good conclusion written by a newer
 *    build.
 *
 * ── The freshness gate, and what it is worth ───────────────────────────────
 *
 * A conclusion is drawn from four documents beside the task — any conclusion
 * already recorded, the merge receipt, the verification history and the task
 * state — and only then arrives here. That is a window, and this module closes
 * as much of it as one process can: the last thing before the write is a
 * **re-read of all four**. Three are compared against what the proof says was
 * assessed and produce `EVIDENCE_MOVED`; the fourth is the target itself, and
 * anything now standing on it produces the code step 4 would have. Nothing is
 * written in either case.
 *
 * What that is worth, stated rather than implied. It closes the window between
 * the assessment and this function, which on this path is the long one — several
 * file reads, a digest, and two awaited Git subprocesses. It does **not** close
 * the window between the last compare and the `rename`. That window is not
 * negligible and an earlier version of this paragraph called it "microseconds":
 * a review counted what is in it — `mkdirSync`, an `lstat` per path component,
 * an exclusive `open`, the write loop and an **`fsync`**, which is a durability
 * barrier and routinely milliseconds. It cannot be closed without a lock, and a
 * lock is a service. So this is a
 * *narrowing*, not mutual exclusion, and it is the same honest position
 * `merge-reconciliation-store.ts` takes about its own read-before-write.
 *
 * The target's own re-read was not in the first version, and a review measured
 * the cost: a conclusion appearing in that window — including one written by a
 * newer build, which this module classifies as unreplaceable — was overwritten
 * and reported as `CONCLUSION_RECORDED`.
 *
 * ── Read-before-write, and not a transaction ───────────────────────────────
 *
 * `state/atomic-file.ts` replaces **one** file atomically. Two invocations
 * racing on one task can both read `ABSENT` and both write; the second rename
 * wins, and because both would have written the same judgement about the same
 * delivery, the loser's bytes and the winner's differ only in `concludedAt`.
 * That is stated rather than fixed, for the reason the sibling stores give.
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
  DELIVERY_CONCLUSION_VERSION,
  MAX_DELIVERY_CONCLUSION_BYTES,
  deliveryConclusionBinding,
  readDeliveryConclusion,
  sameConcludedDelivery,
  type DeliveryConclusion,
  type DeliveryConclusionPayload,
  type DeliveryConclusionReading,
  type DeliveryConclusionSubject,
} from './delivery-conclusion.js';
import { deliveryConclusionFactsOf } from './delivery-conclusion-proof.js';
import { loadMergeReconciliation } from './merge-reconciliation-store.js';
import { loadPostMergeVerification } from './post-merge-verification-store.js';

/** The directory name holding delivery conclusions. See the header. */
export const DELIVERY_CONCLUSION_DIR_NAME = 'delivery-conclusion';

/** The extension of a delivery-conclusion file. */
export const DELIVERY_CONCLUSION_FILE_EXTENSION = TASK_STATE_FILE_EXTENSION;

/** The directory holding conclusions for a canonical repository root. */
export function deliveryConclusionDirectory(repositoryRoot: string): string {
  return join(taskRuntimeDirectory(repositoryRoot), DELIVERY_CONCLUSION_DIR_NAME);
}

/**
 * Whether a name is one of this store's files.
 *
 * `state-location.ts`'s grammar, shared rather than restated: the separation
 * between the kinds of record is structural — a directory — so a second copy of
 * the rule could only drift from the first.
 */
export function isDeliveryConclusionFileName(name: string): boolean {
  return isStateFileName(name);
}

export interface DeliveryConclusionLocation {
  readonly ok: true;
  readonly directory: string;
  readonly fileName: string;
  readonly path: string;
}

export interface DeliveryConclusionLocationFailure {
  readonly ok: false;
  readonly code: 'REPOSITORY_ROOT_UNSUITABLE' | 'TASK_ID_UNSUITABLE';
}

export type DeliveryConclusionLocationResult =
  | DeliveryConclusionLocation
  | DeliveryConclusionLocationFailure;

/** Where one task's conclusion belongs, or why it has no location. */
export function deriveDeliveryConclusionLocation(
  repositoryRoot: string,
  taskId: string,
): DeliveryConclusionLocationResult {
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }
  if (!isValidTaskId(taskId)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const fileName = `${taskId}${DELIVERY_CONCLUSION_FILE_EXTENSION}`;
  // Belt and braces: the derived name is judged in its own right, so a future
  // change cannot silently produce a name nothing would accept back.
  if (!isDeliveryConclusionFileName(fileName)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const directory = deliveryConclusionDirectory(repositoryRoot);
  const path = join(directory, fileName);
  // Belt and braces: even with a validated id, prove the result stayed inside
  // the repository it belongs to.
  if (!isContained(repositoryRoot, path)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  return Object.freeze({ ok: true as const, directory, fileName, path });
}

/* ─────────────────────────────── recording ──────────────────────────────── */

/** Every way recording a conclusion can end. A closed set, and one of them wrote. */
export type DeliveryConclusionRecordCode =
  /** Wrote the conclusion. */
  | 'CONCLUSION_RECORDED'
  /**
   * A conclusion for exactly this delivery is already on disk. Nothing was
   * written, and nothing needed to be.
   *
   * The durable claim is present either way, which is why
   * {@link conclusionIsDurable} grades this alongside `CONCLUSION_RECORDED` and
   * why `recorded` is nevertheless `false`: this invocation filed nothing.
   */
  | 'ALREADY_CONCLUDED'
  /** The value handed in is not a minted conclusion proof. Nothing was written. */
  | 'CONCLUSION_NOT_PROVEN'
  /** The proof describes a different delivery than the one being recorded for. */
  | 'SUBJECT_MISMATCH'
  /** A conclusion is on disk for a different merge, target or pull request. */
  | 'CONFLICTING_CONCLUSION'
  /** Something is on disk that this build cannot read. Never replaced blindly. */
  | 'EXISTING_CONCLUSION_UNREADABLE'
  /**
   * One of the three documents the judgement was drawn from is no longer what
   * it was when it was read. Nothing was written.
   *
   * The receipt, the verification history or the task state changed, or one of
   * them stopped being readable, between the assessment and this write. It is
   * emphatically not a claim that anybody tampered: the verification history is
   * append-only, so an honest concurrent `--verify-merge` moves it.
   */
  | 'EVIDENCE_MOVED'
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

export const CONCLUSION_WRITE_ATTEMPTS = ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const;
export type ConclusionWriteAttempt = (typeof CONCLUSION_WRITE_ATTEMPTS)[number];

/**
 * Whether the durable conclusion is on disk after this call.
 *
 * A total table rather than an `===` chain, so a new code has to be graded here
 * before the build compiles. It is **not** the same question as `recorded`,
 * which asks whether *this invocation* wrote: `ALREADY_CONCLUDED` filed nothing
 * and the claim is durable all the same.
 *
 * It has **no production consumer today**, and that is stated rather than
 * quietly true: the exit-code rule in `cli/delivery-command.ts` used to call it
 * and now grades each code individually through
 * `run-exit-codes.ts`'s own table. The two must agree — a code graded `null`
 * there is exactly a code that is durable here — and nothing in the types says
 * so, which is why the test file asserts the correspondence over the whole
 * vocabulary rather than trusting it. A review found the pair unbound.
 */
const DURABLE_BY_CODE: Readonly<Record<DeliveryConclusionRecordCode, boolean>> = Object.freeze({
  CONCLUSION_RECORDED: true,
  ALREADY_CONCLUDED: true,
  CONCLUSION_NOT_PROVEN: false,
  SUBJECT_MISMATCH: false,
  CONFLICTING_CONCLUSION: false,
  EXISTING_CONCLUSION_UNREADABLE: false,
  EVIDENCE_MOVED: false,
  LOCATION_UNSUITABLE: false,
  RUNTIME_PATH_NOT_IGNORED: false,
  RUNTIME_IGNORE_UNDETERMINED: false,
  RECORD_CONTRACT_VIOLATION: false,
  RECORD_TOO_LARGE: false,
  DIRECTORY_CREATE_FAILED: false,
  WRITE_FAILED: false,
});

/** `true` when the conclusion is on disk after the call this code came from. */
export function conclusionIsDurable(code: DeliveryConclusionRecordCode): boolean {
  return DURABLE_BY_CODE[code];
}

export interface DeliveryConclusionRecordResult {
  readonly code: DeliveryConclusionRecordCode;
  /** Whether **this call** wrote the conclusion. Never inferred from `code`. */
  readonly recorded: boolean;
  /** Whether a write was tried, and how it ended. Never inferred from `code`. */
  readonly writeAttempt: ConclusionWriteAttempt;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  readonly errnoCode: string | null;
}

export type ConclusionIgnoreVerdict = 'IGNORED' | 'NOT_IGNORED' | 'UNDETERMINED';

export interface DeliveryConclusionWriteRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** The proof. The only route to a conclusion this store will file. */
  readonly proof: unknown;
  /** The implementation head H, from the merge receipt. */
  readonly expectedSubjectCommit: string;
  /** The merge commit M, from the merge receipt. */
  readonly expectedMergeCommit: string;
  readonly expectedHost: string;
  readonly expectedOwner: string;
  readonly expectedName: string;
  readonly expectedPullRequestNumber: number;
  /** The task-state revision the assessment was made against. */
  readonly assessedStateRevision: string;
  /**
   * Re-reads the task-state revision, at the moment of the write.
   *
   * A seam because it must be, not for testability: `tests/v4-03-…` pins that
   * no module under `src/deliver/` takes a **value** import from
   * `state/state-store.js`, and the one admitted exception is the CLI's own
   * reader. The task's bytes are the CLI's to read, so the CLI supplies the
   * reading and this module compares it. It is required rather than defaulted
   * for exactly that reason: there is no default this module is allowed to have.
   *
   * `null` when the state can no longer be read at all — treated exactly like a
   * changed revision, because both mean the assessment's ground is not what is
   * there now.
   *
   * The two *delivery* documents are re-read by this module itself, below.
   * Those are the evidence, and a store that took the caller's word for whether
   * its own evidence had moved would be comparing a value with itself.
   */
  readonly readStateRevision: () => string | null;
  /** Whether Git ignores a repository-relative path. */
  readonly checkIgnored: (relativePath: string) => Promise<ConclusionIgnoreVerdict>;
  readonly open?: (path: string) => number;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

function recordFailure(
  code: DeliveryConclusionRecordCode,
  path: string | null,
  errnoCode: string | null = null,
  writeAttempt: ConclusionWriteAttempt = 'NOT_ATTEMPTED',
): DeliveryConclusionRecordResult {
  return Object.freeze({ code, recorded: false as const, writeAttempt, path, errnoCode });
}

/**
 * Records one delivery conclusion.
 *
 * Never throws for an expected condition, and never overwrites a conclusion.
 */
export async function recordDeliveryConclusion(
  request: DeliveryConclusionWriteRequest,
): Promise<DeliveryConclusionRecordResult> {
  // ── 1. Provenance, before anything else ──────────────────────────────────
  const facts = deliveryConclusionFactsOf(request.proof);
  if (facts === null) return recordFailure('CONCLUSION_NOT_PROVEN', null);

  const location = deriveDeliveryConclusionLocation(request.repositoryRoot, request.taskId);
  if (!location.ok) return recordFailure('LOCATION_UNSUITABLE', null);

  // ── 2. The proof must be about the delivery being recorded for ───────────
  //
  // Every expectation comes from the caller's own reading of the receipt and
  // the task, never from the proof. The mint guarantees the two records agreed
  // with each other; it cannot guarantee they are the ones the *caller* is
  // recording for, because it never saw the caller's subject. This is where
  // those two meet.
  //
  // Six comparisons, and they are not redundant with each other: the mint
  // compares receipt against history, and these compare the mint's result
  // against the caller. A proof minted from two consistent records about
  // somebody else's delivery passes the first and fails here.
  if (facts.mergeCommit !== request.expectedMergeCommit) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }
  if (facts.subjectCommit !== request.expectedSubjectCommit) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }
  if (
    facts.host !== request.expectedHost ||
    facts.owner !== request.expectedOwner ||
    facts.name !== request.expectedName
  ) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }
  if (facts.pullRequestNumber !== request.expectedPullRequestNumber) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }

  // The identity this conclusion is bound to, derived from the request rather
  // than supplied beside it — `merge-reconciliation-store.ts` records why: a
  // caller could otherwise hand over a subject naming one task while `taskId`
  // named another, and the record would be READ under one identity and BOUND
  // under the other.
  const subject: DeliveryConclusionSubject = Object.freeze({
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
  });

  // ── 3. Build the payload from the proof's facts, and from nothing else ───
  const payload: DeliveryConclusionPayload = {
    conclusionVersion: DELIVERY_CONCLUSION_VERSION,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
    subjectCommit: facts.subjectCommit,
    mergeCommit: facts.mergeCommit,
    provider: 'github',
    host: facts.host,
    owner: facts.owner,
    name: facts.name,
    pullRequestNumber: facts.pullRequestNumber,
    baseRef: facts.baseRef,
    profileDigest: facts.profileDigest,
    verifiedAt: facts.verifiedAt,
    receiptBinding: facts.receiptBinding,
    verificationBinding: facts.verificationBinding,
    concludedAt: facts.concludedAt,
  };

  // ── 4. Never overwrite. Read what is there first ─────────────────────────
  //
  // Ahead of the ignore question and ahead of any directory creation, because a
  // repeat run must be able to answer `ALREADY_CONCLUDED` without a filesystem
  // effect of any kind.
  const existing = loadDeliveryConclusion(
    request.repositoryRoot,
    request.taskId,
    subject,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );
  if (existing.reading === 'DELIVERY_CONCLUDED') {
    // `conclusion` is non-null on this reading by construction; the guard is
    // here so that a future change to the load result cannot make this arm read
    // a `null` as agreement.
    if (existing.conclusion === null) {
      return recordFailure('EXISTING_CONCLUSION_UNREADABLE', location.path);
    }
    return sameConcludedDelivery(existing.conclusion, payload)
      ? Object.freeze({
          code: 'ALREADY_CONCLUDED' as const,
          recorded: false as const,
          writeAttempt: 'NOT_ATTEMPTED' as const,
          path: location.path,
          errnoCode: null,
        })
      : recordFailure('CONFLICTING_CONCLUSION', location.path);
  }
  if (existing.reading !== 'ABSENT') {
    // `MALFORMED`, `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` all mean the same
    // thing to a writer: something is on that path and this build cannot say
    // what it claims. Replacing it would be destroying a document whose content
    // is unknown — including, under `UNSUPPORTED_VERSION`, a perfectly good
    // conclusion written by a newer build. It fails closed.
    return recordFailure('EXISTING_CONCLUSION_UNREADABLE', location.path);
  }

  // ── 5. The ignore question, before any filesystem effect ─────────────────
  //
  // The relative path is DERIVED from the path that will actually be written,
  // not spelled out again. Two calls rather than two arguments, because
  // `check-ignore --quiet` refuses a second pathname outright — measured
  // against this repository's Git as `fatal: --quiet is only valid with a
  // single pathname`, exit 128 — and dropping `--quiet` to batch them would
  // turn the conjunction this needs into the disjunction plain `check-ignore`
  // answers.
  const relativeRecord = relativePosix(request.repositoryRoot, location.path);
  if (relativeRecord === null) return recordFailure('LOCATION_UNSUITABLE', location.path);
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

  const conclusion = { ...payload, binding: deliveryConclusionBinding(subject, payload) };

  // ── 6. Prove this build would accept its own conclusion back ─────────────
  //
  // Read-back-before-write, the same guard slices 3, 8 and 9 use. A record this
  // build could not parse would be indistinguishable on disk from one somebody
  // corrupted, and the difference between "we wrote nonsense" and "somebody
  // tampered" is worth keeping.
  if (readDeliveryConclusion(conclusion, subject).reading !== 'DELIVERY_CONCLUDED') {
    return recordFailure('RECORD_CONTRACT_VIOLATION', location.path);
  }

  const bytes = Buffer.from(`${JSON.stringify(conclusion, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_DELIVERY_CONCLUSION_BYTES) {
    return recordFailure('RECORD_TOO_LARGE', location.path);
  }

  // ── 7. The evidence is re-read, as late as it can be ─────────────────────
  //
  // Last before the directory is touched and the bytes are staged. Everything
  // above this line is pure or a read; everything below it changes the disk.
  //
  // Compared against what the PROOF says was assessed, never against values the
  // caller supplies alongside — a caller that passed the same numbers to both
  // sides would be comparing a value with itself, and this repository has had
  // that exact defect reach production once already.
  //
  // Reachable without any injection, which is why the two record re-reads are
  // not seams: `checkIgnored` is awaited a few lines above, so a test that
  // moves a document from inside it exercises this gate through the real
  // readers. The state revision is the one value that has to come from the
  // caller, and it comes from a *function* rather than a second field so that a
  // caller cannot satisfy it by handing the same number in twice.
  const subjectOf = { taskId: request.taskId, repositoryRoot: request.repositoryRoot };
  const receiptNow = loadMergeReconciliation(request.repositoryRoot, request.taskId, subjectOf);
  const receiptBindingNow =
    receiptNow.reading === 'HISTORICAL_MERGE' && receiptNow.receipt !== null
      ? receiptNow.receipt.binding
      : null;
  if (receiptBindingNow !== facts.receiptBinding) {
    return recordFailure('EVIDENCE_MOVED', location.path);
  }
  const verificationNow = loadPostMergeVerification(
    request.repositoryRoot,
    request.taskId,
    subjectOf,
  );
  const verificationBindingNow =
    verificationNow.reading === 'VERIFICATION_HISTORY' && verificationNow.record !== null
      ? verificationNow.record.binding
      : null;
  if (verificationBindingNow !== facts.verificationBinding) {
    return recordFailure('EVIDENCE_MOVED', location.path);
  }
  if (request.readStateRevision() !== request.assessedStateRevision) {
    return recordFailure('EVIDENCE_MOVED', location.path);
  }

  // ── 8. And the path itself, which step 4 read and nothing has re-read ────
  //
  // The document this call is about to replace is the one document the gate
  // above does not cover, and a review measured what that cost: a conclusion —
  // including one written by a **newer build**, which this build classifies as
  // unreplaceable — appearing between step 4 and the rename was overwritten,
  // and the run reported `CONCLUSION_RECORDED`. Three written guarantees said
  // otherwise, including this module's own "never replaced blindly".
  //
  // So the last read before the write is of the target itself, and anything
  // other than `ABSENT` refuses. The two codes are the ones step 4 would have
  // produced, because the situation is the one step 4 exists for — it simply
  // arrived later.
  const targetNow = loadDeliveryConclusion(
    request.repositoryRoot,
    request.taskId,
    subject,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );
  if (targetNow.reading === 'DELIVERY_CONCLUDED') {
    // The `conclusion === null` floor is folded in here rather than given its
    // own arm, unlike step 4's. Both grade to the same exit code and neither is
    // reachable — the reading implies a non-null record — so the difference is
    // which word a report prints for a state this build cannot produce. Named
    // rather than made symmetrical, because symmetry here would be two more
    // lines nothing can reach.
    return targetNow.conclusion !== null && sameConcludedDelivery(targetNow.conclusion, payload)
      ? Object.freeze({
          code: 'ALREADY_CONCLUDED' as const,
          recorded: false as const,
          writeAttempt: 'NOT_ATTEMPTED' as const,
          path: location.path,
          errnoCode: null,
        })
      : recordFailure('CONFLICTING_CONCLUSION', location.path);
  }
  if (targetNow.reading !== 'ABSENT') {
    return recordFailure('EXISTING_CONCLUSION_UNREADABLE', location.path);
  }
  // What remains open is the window between this line and the `rename` below,
  // which is microseconds and cannot be closed without a lock — and a lock is a
  // service. This is a narrowing, not mutual exclusion, and `L-V4-10-5` says so.

  try {
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    return recordFailure('DIRECTORY_CREATE_FAILED', location.path, safeErrnoCode(error));
  }

  // The two seams are spread in only when supplied. `exactOptionalPropertyTypes`
  // is on, so an explicit `replace: undefined` is a different thing from an
  // absent key — and the absent one is what "use the production default" means.
  const written = writeFileAtomically({
    directory: location.directory,
    fileName: location.fileName,
    contents: bytes,
    isAcceptableFileName: isDeliveryConclusionFileName,
    ...(request.replace === undefined ? {} : { replace: request.replace }),
    ...(request.tempSuffix === undefined ? {} : { tempSuffix: request.tempSuffix }),
  });
  if (!written.written) {
    return recordFailure('WRITE_FAILED', location.path, written.errnoCode, 'FAILED');
  }
  return Object.freeze({
    code: 'CONCLUSION_RECORDED' as const,
    recorded: true as const,
    writeAttempt: 'COMPLETED' as const,
    path: location.path,
    errnoCode: null,
  });
}

/* ──────────────────────────────── reading ───────────────────────────────── */

export interface DeliveryConclusionLoad {
  readonly reading: DeliveryConclusionReading;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /**
   * The conclusion, on `DELIVERY_CONCLUDED` only, and `null` on every other
   * reading. Nothing is handed back from a record this build refused.
   */
  readonly conclusion: DeliveryConclusion | null;
}

function load(
  reading: DeliveryConclusionReading,
  path: string | null,
  conclusion: DeliveryConclusion | null = null,
): DeliveryConclusionLoad {
  return Object.freeze({ reading, path, conclusion });
}

/**
 * Reads back the conclusion for one task.
 *
 * Named for what it produces. There is deliberately no `isDelivered` and no
 * `loadDeliveryStatus`: what this returns is a past judgement, and a name
 * suggesting it described the base branch now — or the code today — is the
 * defect this slice exists to avoid.
 *
 * Never throws. An unreadable file, an oversized one, one that is not JSON and
 * one that is JSON of the wrong shape all reach a reading rather than an
 * exception.
 */
export function loadDeliveryConclusion(
  repositoryRoot: string,
  taskId: string,
  subject: DeliveryConclusionSubject,
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
   * Injectable for the same reason `open` is: the branch below that refuses a
   * **short read** is defence against a partial read no fixture can provoke,
   * because a real filesystem serving a small local file does not return early.
   * Without this seam that branch is unreachable and therefore unpinned — an
   * absence assertion that is vacuous until the mutant dies.
   */
  readChunk: (
    handle: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number = readSync,
): DeliveryConclusionLoad {
  const location = deriveDeliveryConclusionLocation(repositoryRoot, taskId);
  if (!location.ok) return load('MALFORMED', null);

  let handle: number;
  try {
    handle = open(location.path);
  } catch (error: unknown) {
    // Not-found is the only errno that means "nobody wrote one". Every other
    // reason a file cannot be opened is a file that may well exist, and
    // reporting it as absent would turn a permissions problem into "AO has
    // never concluded this delivery" — and, at the writer above, into
    // permission to write a fresh conclusion over it.
    return load(safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'MALFORMED', location.path);
  }

  try {
    const stat = fstatSync(handle);
    // A directory standing where the record should be is not a record.
    //
    // Stated honestly: this guard is **not** observable. Measured on Windows,
    // `openSync(dir, 'r')` succeeds and `fstat` reports size 0 — so without it
    // the read loop does not run, `read === size`, and `JSON.parse('')` throws
    // into the arm below, which returns the same `MALFORMED`. A review measured
    // deleting this line and the suite stayed green, correctly: no behaviour
    // depends on it, so no test can pin it. It stays as a statement of intent
    // about a platform answer this repository has been surprised by before, and
    // it is named here rather than defended as load-bearing.
    if (!stat.isFile()) return load('MALFORMED', location.path);
    const size = stat.size;
    if (size > MAX_DELIVERY_CONCLUSION_BYTES) return load('MALFORMED', location.path);
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

    const result = readDeliveryConclusion(raw, subject);
    return load(result.reading, location.path, result.conclusion);
  } catch {
    // Everything after a successful open — `fstat`, the read loop, the decode —
    // can still fail, and this function's contract is that it never throws.
    // `merge-reconciliation-store.ts` carries this same `catch` with a comment
    // recording that a review measured its absence and that "the
    // never-overwrite guarantee ran through this line"; the sibling this module
    // was modelled on does **not** have it, and a review measured that gap
    // here too: an injected read that fails with `EIO` after the open escaped
    // as a rejection, past two functions whose headers say they never throw,
    // into a commander action with no `catch`.
    //
    // `MALFORMED` rather than `ABSENT`, for the reason the open's own arm
    // gives: at the writer above, "nobody wrote one" is permission to write a
    // fresh conclusion over whatever is there.
    return load('MALFORMED', location.path);
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A handle that cannot be closed changes nothing about the reading above,
      // and throwing here would turn a successful read into an exception.
    }
  }
}
