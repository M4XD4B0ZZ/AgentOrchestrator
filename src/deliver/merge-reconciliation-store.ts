/**
 * Where merge receipts live, and the only way to put one there.
 *
 * ── The location, and why not somewhere else ───────────────────────────────
 *
 * `<repositoryRoot>/.agent-orchestrator/runtime/delivery-merge/<taskId>.json` —
 * a third kind of per-repository record, in its own directory, published
 * through the same crash-safe primitive (`state/atomic-file.ts`: stage in the
 * same directory, flush, close, one rename).
 *
 * Its own directory, and not a second file inside `runtime/delivery/`, for the
 * reason `delivery-evidence-store.ts` records at length: the task-id grammar
 * (`plan/task-id.ts`) admits `.`, so any scheme that distinguishes two kinds of
 * record by a **suffix inside one directory** lets a legitimately-named task
 * alias another task's file. That was not a theoretical objection — a review
 * reproduced it against `<taskId>.delivery.json`, where recording for `T-001`
 * would have renamed a blob over `T-001.delivery`'s durable state. A directory
 * closes it structurally: the file name is simply `<taskId>.json`, judged by
 * `state-location.ts`'s own `isStateFileName`, the same grammar shared rather
 * than restated.
 *
 * Not inside the delivery-evidence record either, and that is a lifetime
 * argument rather than a naming one. Slice 3's record is a *latest snapshot*: a
 * later observation replaces it, deliberately, because the question it answers
 * is "what does AO know about this task's current subject". A merge receipt is
 * the opposite — a monotonic event that must survive every later observation.
 * Folding the two into one file would mean the next `--observe --record` erased
 * the merge, which is the one fact the next slice needs.
 *
 * Beside, and not *inside*, the task state. That is slice 3's decision, taken
 * again here for the same three reasons: writing this into `TaskState` would
 * need `advanceTaskState`, which requires a held execution lease re-proved at
 * the moment of the write (`state/advance-state.ts`) — and this command holds
 * no lease; taking one would make a reconciliation contend with a run for the
 * whole repository; and a companion keeps `READY_FOR_PR` terminal without
 * argument, because no transition is involved at all.
 *
 * ── Never overwritten, and exactly what that guarantee is ─────────────────
 *
 * A receipt on disk is read *before* anything is written, and a receipt that
 * contradicts the merge now being reconciled refuses the write outright. There
 * is no last-writer-wins rule for contradictory merge identities, and no
 * merging of two receipts into one.
 *
 * State the limit exactly, because the reassuring reading is wrong. This is
 * **read-before-write, not a transaction.** Two processes that both read
 * `ABSENT` can both go on to write, and this module has no mechanism that would
 * stop the second — `writeFileAtomically` replaces, and the primitive offers no
 * exclusive create. What the check guarantees is that a receipt *already on
 * disk when this process looked* is never silently replaced by a different one.
 * Two reconcilers of the same merge converge, because they write the same event
 * and differ only in *when they asked* and *when they wrote* — `observedAt` and
 * `reconciledAt`. Those two are not compared, and neither are three more:
 * {@link sameMergeEvent} compares nine of the payload's fourteen fields, and the
 * other three are refused earlier or are not a fact about the merge. Two earlier
 * versions of this sentence were wrong in different directions — one named only
 * `reconciledAt`, and its correction called the two instants "exactly the two
 * fields" not compared, which a review counted. The claim that matters is the
 * narrow one: two honest reconcilers of one merge differ in nothing this
 * function looks at. Two reconcilers
 * of *different* merges for one task is a state `reconcile-merge.ts` refuses
 * upstream in the ordinary case, because a task whose delivery head carries two
 * pull requests is ambiguous there and reaches no write at all.
 *
 * ── One receipt per task ──────────────────────────────────────────────────
 *
 * A task has at most one, and it is written once. There is no event store and
 * no history: a task's delivery head is merged once, and a *second* merge of a
 * *different* pull request at the same head is the contradiction above rather
 * than a second entry.
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
  MERGE_RECONCILIATION_VERSION,
  MAX_MERGE_RECONCILIATION_BYTES,
  mergeReconciliationBinding,
  readMergeReconciliation,
  type MergeReconciliation,
  type MergeReconciliationPayload,
  type MergeReconciliationReading,
  type MergeReconciliationSubject,
} from './merge-reconciliation.js';
import { mergeObservationFactsOf } from './merge-observation-proof.js';

/**
 * The directory that separates merge receipts from task state and from delivery
 * observations.
 *
 * `<runtime>/delivery-merge/<taskId>.json`, following the precedent
 * `block/block-store.ts` set with `<runtime>/blocks/<runId>.json` and
 * `delivery-evidence-store.ts` followed with `<runtime>/delivery/<taskId>.json`:
 * a new kind of per-repository record gets its own directory rather than its own
 * name inside a shared one. See this module's header for the collision that made
 * the rule, which a review reproduced rather than argued.
 */
export const MERGE_RECONCILIATION_DIR_NAME = 'delivery-merge';

/** The extension of a merge receipt file. */
export const MERGE_RECONCILIATION_FILE_EXTENSION = TASK_STATE_FILE_EXTENSION;

/** The directory holding merge receipts for a canonical repository root. */
export function mergeReconciliationDirectory(repositoryRoot: string): string {
  return join(taskRuntimeDirectory(repositoryRoot), MERGE_RECONCILIATION_DIR_NAME);
}

/**
 * Whether a name is one of this store's files.
 *
 * `state-location.ts`'s grammar, shared rather than restated: the separation
 * between the two kinds of record is structural — a directory — so a second
 * copy of the rule could only drift from the first.
 */
export function isMergeReconciliationFileName(name: string): boolean {
  return isStateFileName(name);
}

export interface MergeReconciliationLocation {
  readonly ok: true;
  readonly directory: string;
  readonly fileName: string;
  readonly path: string;
}

export interface MergeReconciliationLocationFailure {
  readonly ok: false;
  readonly code: 'REPOSITORY_ROOT_UNSUITABLE' | 'TASK_ID_UNSUITABLE';
}

export type MergeReconciliationLocationResult =
  | MergeReconciliationLocation
  | MergeReconciliationLocationFailure;

/** Where one task's receipt belongs, or why it has no usable location. */
export function deriveMergeReconciliationLocation(
  repositoryRoot: string,
  taskId: string,
): MergeReconciliationLocationResult {
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }
  if (!isValidTaskId(taskId)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const fileName = `${taskId}${MERGE_RECONCILIATION_FILE_EXTENSION}`;
  // Belt and braces: the derived name is judged in its own right, so a future
  // change cannot silently produce a name nothing would accept back.
  if (!isMergeReconciliationFileName(fileName)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const directory = mergeReconciliationDirectory(repositoryRoot);
  const path = join(directory, fileName);
  // Belt and braces: even with a validated id, prove the result stayed inside
  // the repository it belongs to.
  if (!isContained(repositoryRoot, path)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  return Object.freeze({ ok: true as const, directory, fileName, path });
}

/* ─────────────────────────────── recording ──────────────────────────────── */

/**
 * Every way recording can end. A closed set, and only one of them wrote.
 *
 * `MERGE_NOT_PROVEN` is the one worth naming twice. It is what a caller gets
 * for handing over a plain object of the right shape, a value cast to the proof
 * type, or a proof whose facts cannot be read — everything except an artefact
 * this process minted at the reading boundary. It is not a validation failure
 * to be worked around; it is the whole authority model.
 *
 * `ALREADY_RECORDED` and `CONFLICTING_RECEIPT` are the two halves of the
 * never-overwrite rule, and they are kept apart because they send an operator
 * to completely different places: one is "this was already done", the other is
 * "something on disk says this task's delivery was a different merge".
 */
export type MergeReconciliationRecordCode =
  /** Written. The only code that touched the filesystem's target path. */
  | 'RECORDED'
  /** An identical receipt is already on disk. Nothing was written. */
  | 'ALREADY_RECORDED'
  /** A receipt on disk names a different merge for this task. Nothing was written. */
  | 'CONFLICTING_RECEIPT'
  /** Something is on disk that this build cannot read. Never replaced blindly. */
  | 'EXISTING_RECEIPT_UNREADABLE'
  /** The value handed in is not a minted merge observation. Nothing was written. */
  | 'MERGE_NOT_PROVEN'
  /** The proof describes a different subject than the task being recorded for. */
  | 'SUBJECT_MISMATCH'
  /** The identities cannot be used as path segments. */
  | 'LOCATION_UNSUITABLE'
  /** Git does not ignore the receipt's own name, so writing it would dirty the checkout. */
  | 'RUNTIME_PATH_NOT_IGNORED'
  /** Git could not say whether the path is ignored. Never rounded to either answer. */
  | 'RUNTIME_IGNORE_UNDETERMINED'
  /** The per-repository runtime directory could not be created. */
  | 'DIRECTORY_CREATE_FAILED'
  /** The receipt this build produced is larger than it will read back. */
  | 'RECEIPT_TOO_LARGE'
  /** The receipt this build produced is not one it would accept back. */
  | 'RECEIPT_CONTRACT_VIOLATION'
  /** The atomic replacement did not complete. Any previous receipt survives. */
  | 'WRITE_FAILED';

/**
 * Whether an attempt to put bytes on the target path was made at all.
 *
 * Reported separately from the code, and named for the question an operator
 * actually asks after a repeat run: *did this touch anything?* A code alone
 * would answer it only by being memorised, and there are thirteen of them.
 */
export const WRITE_ATTEMPTS = ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const;
export type WriteAttempt = (typeof WRITE_ATTEMPTS)[number];

export interface MergeReconciliationRecordResult {
  readonly code: MergeReconciliationRecordCode;
  /** `true` only after a complete write, a successful flush and a clean replace. */
  readonly recorded: boolean;
  /**
   * Whether the target path was written to.
   *
   * `NOT_ATTEMPTED` for every refusal *and* for `ALREADY_RECORDED`, which is the
   * idempotency claim: a second identical reconciliation performs no write.
   */
  readonly writeAttempt: WriteAttempt;
  /**
   * The intended path, when this refusal has one to report.
   *
   * `null` before a location is derived **and** on the subject-mismatch
   * refusals, which are decided after the derivation and deliberately report
   * nothing: a caller that filed a real merge against the wrong task should not
   * be handed the path it would have written to. A review found the previous
   * wording — "null when no location could be derived" — describing only the
   * first of those.
   */
  readonly path: string | null;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

function recordFailure(
  code: MergeReconciliationRecordCode,
  path: string | null,
  errnoCode: string | null = null,
  writeAttempt: WriteAttempt = 'NOT_ATTEMPTED',
): MergeReconciliationRecordResult {
  return Object.freeze({ code, recorded: false as const, writeAttempt, path, errnoCode });
}

/**
 * What Git said about the two names this module writes.
 *
 * A verdict rather than a boolean, and the three states are kept apart for the
 * reason `state/runtime-ignored.ts` gives: reporting "could not evaluate" as
 * "not ignored" refuses a correctly configured repository because Git hiccuped,
 * and reporting it as "ignored" walks into the defect the check exists for.
 */
export type IgnoreVerdict = 'IGNORED' | 'NOT_IGNORED' | 'UNDETERMINED';

export interface MergeReconciliationWriteRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /**
   * The subject the caller believes it asked about, from the task's own record
   * and the repository's own delivery target — never from the proof.
   *
   * Supplied separately so the two can be *compared*. Reading the subject out
   * of the proof and then recording it would make the check a tautology: the
   * proof would be evidence for whatever the proof said, and a real merge of one
   * commit could be filed against a task pinning another.
   */
  readonly expectedSubjectCommit: string;
  readonly expectedHost: string;
  readonly expectedOwner: string;
  readonly expectedName: string;
  /**
   * The base branch the task declares it targets.
   *
   * Compared against what the forge reported. A merge into a branch this task
   * was never aimed at is a real merge and is not this task's delivery.
   */
  readonly expectedBaseRef: string;
  /**
   * The minted merge observation. Typed as `unknown` deliberately.
   *
   * The gate is a runtime check on an artefact this process made, so the
   * parameter must be able to receive the shape-valid object a forger would
   * hand over. Typing it as the proof would make the refusal a compile-time
   * one, which is exactly the guarantee that does not survive a cast — and the
   * test that matters drives a cast value through this argument.
   */
  readonly proof: unknown;
  /** When these bytes are being written. */
  readonly reconciledAt: string;
  /** Asks Git whether a repository-relative path is ignored. */
  readonly checkIgnored: (relativePath: string) => Promise<IgnoreVerdict>;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
  /** The open, for reading back an existing receipt. Production uses `openSync`. */
  readonly open?: (path: string) => number;
}

/**
 * Whether two receipts describe the same merge event.
 *
 * Every field of the event is compared, and `reconciledAt` deliberately is not:
 * two processes reconciling the same merge write the same event at different
 * moments, and calling that a conflict would turn idempotency into a refusal.
 * `observedAt` is likewise excluded — it is when the forge was asked, not part
 * of what it said.
 *
 * `taskId` and `repositoryRoot` are not compared here because the reading has
 * already refused a receipt that names either differently: it would have been
 * `NOT_THIS_TASK` and never reached this comparison.
 */
function sameMergeEvent(
  stored: MergeReconciliation,
  candidate: MergeReconciliationPayload,
): boolean {
  return (
    stored.subjectCommit === candidate.subjectCommit &&
    stored.provider === candidate.provider &&
    stored.host === candidate.host &&
    stored.owner === candidate.owner &&
    stored.name === candidate.name &&
    stored.pullRequestNumber === candidate.pullRequestNumber &&
    stored.mergedHeadSha === candidate.mergedHeadSha &&
    stored.baseRef === candidate.baseRef &&
    stored.mergeCommit === candidate.mergeCommit
  );
}

/**
 * Writes one task's merge receipt, or refuses.
 *
 * The order is the contract. The proof is checked first, before a path is
 * derived and before Git is asked anything, so that a caller who observed no
 * merge cannot cause a filesystem effect of any kind — not even a created
 * directory.
 */
export async function recordMergeReconciliation(
  request: MergeReconciliationWriteRequest,
): Promise<MergeReconciliationRecordResult> {
  // ── 1. Provenance, before anything else ──────────────────────────────────
  const facts = mergeObservationFactsOf(request.proof);
  if (facts === null) return recordFailure('MERGE_NOT_PROVEN', null);

  const location = deriveMergeReconciliationLocation(request.repositoryRoot, request.taskId);
  if (!location.ok) return recordFailure('LOCATION_UNSUITABLE', null);

  // ── 2. The proof must be about the task being recorded for ───────────────
  //
  // The proof carries the forge's own answer, and the caller supplies the
  // task's. A caller that observed a merge of commit A and recorded it against
  // a task pinning commit B would be manufacturing a delivery out of a *real*
  // merge, which the mint alone cannot prevent — it vouches that a reading
  // happened, never that it was about this task, this commit, this repository
  // or this base.
  //
  // All five are checked. A merge of the right commit in the wrong repository is
  // the same defect wearing a different hat: two forks can share a commit object
  // name exactly, so the identity has to be part of the question rather than
  // assumed to follow from it. And the base is checked because a merge of this
  // exact commit into a branch this task never targeted is somebody else's
  // delivery of the same work.
  if (facts.headSha !== request.expectedSubjectCommit) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }
  if (
    facts.host !== request.expectedHost ||
    facts.owner !== request.expectedOwner ||
    facts.name !== request.expectedName
  ) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }
  if (facts.baseRef !== request.expectedBaseRef) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }

  // The identity this receipt is bound to, derived from the request rather than
  // supplied beside it.
  //
  // It used to be a field of its own, and that was a defect waiting to happen: a
  // caller could hand over a `subject` naming one task while `taskId` named
  // another, and the receipt would then be READ under one identity and BOUND
  // under the other. Nothing in the type stopped it and no caller wanted it.
  // Deriving it means the two cannot disagree, because there is only one.
  const subject: MergeReconciliationSubject = Object.freeze({
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
  });

  // ── 3. Build the payload from the proof's facts, and from nothing else ───
  //
  // Built before the existing receipt is read, because the comparison below
  // needs something to compare against. Building a payload touches nothing.
  const payload: MergeReconciliationPayload = {
    reconciliationVersion: MERGE_RECONCILIATION_VERSION,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
    subjectCommit: request.expectedSubjectCommit,
    provider: 'github',
    host: facts.host,
    owner: facts.owner,
    name: facts.name,
    pullRequestNumber: facts.pullRequestNumber,
    mergedHeadSha: facts.headSha,
    baseRef: facts.baseRef,
    mergeCommit: facts.mergeCommit,
    observedAt: facts.observedAt,
    reconciledAt: request.reconciledAt,
  };

  // ── 4. Never overwrite. Read what is there first ─────────────────────────
  //
  // Ahead of the ignore question and ahead of any directory creation, because a
  // repeat run must be able to answer `ALREADY_RECORDED` without a filesystem
  // effect of any kind. See the header for what this guarantee is and is not.
  const existing = loadMergeReconciliation(
    request.repositoryRoot,
    request.taskId,
    subject,
    ...(request.open === undefined ? [] : ([request.open] as const)),
  );
  if (existing.reading === 'HISTORICAL_MERGE') {
    // `receipt` is non-null on this reading by construction; the guard is here
    // so that a future change to the load result cannot make this arm read a
    // `null` as agreement.
    if (existing.receipt === null) {
      return recordFailure('EXISTING_RECEIPT_UNREADABLE', location.path);
    }
    return sameMergeEvent(existing.receipt, payload)
      ? Object.freeze({
          code: 'ALREADY_RECORDED' as const,
          recorded: false as const,
          writeAttempt: 'NOT_ATTEMPTED' as const,
          path: location.path,
          errnoCode: null,
        })
      : recordFailure('CONFLICTING_RECEIPT', location.path);
  }
  if (existing.reading !== 'ABSENT') {
    // `MALFORMED`, `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` all mean the same
    // thing to a writer: something is on that path and this build cannot say
    // what it claims. Replacing it would be destroying a document whose content
    // is unknown — including, under `UNSUPPORTED_VERSION`, a perfectly good
    // receipt written by a newer build. It fails closed.
    return recordFailure('EXISTING_RECEIPT_UNREADABLE', location.path);
  }

  // ── 5. The ignore question, before any filesystem effect ─────────────────
  //
  // The relative path is DERIVED from the path that will actually be written,
  // not spelled out again. A review found a hardcoded
  // `.agent-orchestrator/runtime/...` literal here while the write target came
  // from `REPO_PROFILE_DIR_NAME` and `TASK_RUNTIME_DIR_NAME` — two independent
  // spellings of one path, with nothing making them agree. `relativePosix` is
  // `state/runtime-ignored.ts`'s own conversion, so the question Git is asked is
  // about the file this function is about to create.
  const relativeRecord = relativePosix(request.repositoryRoot, location.path);
  if (relativeRecord === null) return recordFailure('LOCATION_UNSUITABLE', location.path);
  // `writeFileAtomically` stages `<name>.tmp-<suffix>` beside the target, and a
  // crash can leave one behind, so the staging shape is asked about too.
  //
  // Two calls rather than two arguments, and the reason is measured rather than
  // inherited. `state/runtime-ignored.ts` runs `check-ignore --quiet -- <path>`,
  // and measured against this repository's Git, `--quiet` **refuses** a second
  // pathname outright: `fatal: --quiet is only valid with a single pathname`,
  // exit 128 — which this build would read as `UNDETERMINED`, not as an answer.
  // Dropping `--quiet` to batch them would then reintroduce the hazard the
  // shared module's header names: plain `check-ignore` exits 0 when *any*
  // argument is ignored, which is the disjunction where this needs a
  // conjunction. Both routes are closed; one call per name is the only one open.
  //
  // This comment previously gave only the second half as the reason, copied from
  // the shared module, and a review measured it inapplicable to the command this
  // build actually runs. The sibling copies of it are noted as `L-V4-08-6`.
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

  const receipt = { ...payload, binding: mergeReconciliationBinding(subject, payload) };

  // ── 6. Prove this build would accept its own receipt back ────────────────
  //
  // Read-back-before-write, the same guard slice 3 and the containment record
  // use. A receipt this build could not parse would be indistinguishable on disk
  // from one somebody corrupted, and the difference between "we wrote nonsense"
  // and "somebody tampered" is worth keeping.
  if (readMergeReconciliation(receipt, subject) !== 'HISTORICAL_MERGE') {
    return recordFailure('RECEIPT_CONTRACT_VIOLATION', location.path);
  }

  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_MERGE_RECONCILIATION_BYTES) {
    return recordFailure('RECEIPT_TOO_LARGE', location.path);
  }

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
    isAcceptableFileName: isMergeReconciliationFileName,
    ...(request.replace === undefined ? {} : { replace: request.replace }),
    ...(request.tempSuffix === undefined ? {} : { tempSuffix: request.tempSuffix }),
  });
  if (!written.written) {
    return recordFailure('WRITE_FAILED', location.path, written.errnoCode, 'FAILED');
  }
  return Object.freeze({
    code: 'RECORDED' as const,
    recorded: true as const,
    writeAttempt: 'COMPLETED' as const,
    path: location.path,
    errnoCode: null,
  });
}

/* ──────────────────────────────── reading ───────────────────────────────── */

export interface MergeReconciliationLoad {
  readonly reading: MergeReconciliationReading;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /**
   * The receipt, on `HISTORICAL_MERGE` only, and `null` on every other reading.
   *
   * Nothing is handed back from a record this build refused: a fact read out of
   * a document it has just said it cannot read would be borrowed from nowhere.
   */
  readonly receipt: MergeReconciliation | null;
}

function load(
  reading: MergeReconciliationReading,
  path: string | null,
  receipt: MergeReconciliation | null = null,
): MergeReconciliationLoad {
  return Object.freeze({ reading, path, receipt });
}

/**
 * Reads back the receipt for one task.
 *
 * Named for what it produces. There is deliberately no `isDelivered` and no
 * `loadCurrentMerge`: what this returns is a past event, and a name that
 * suggested it described the base branch now is the defect this slice exists to
 * avoid.
 *
 * Never throws. An unreadable file, an oversized one, one that is not JSON, and
 * one that is JSON of the wrong shape all reach a reading rather than an
 * exception, because the caller is an operator report and a thrown error there
 * is a worse answer than a refusal.
 */
export function loadMergeReconciliation(
  repositoryRoot: string,
  taskId: string,
  subject: MergeReconciliationSubject,
  /**
   * The open. Production uses `openSync`.
   *
   * Injectable for the reason `state/atomic-file.ts` gives about its `replace`:
   * the property below — "a file that exists and cannot be opened is never
   * reported as one nobody wrote" — cannot be observed on demand against a real
   * filesystem, because it needs an open that fails with something other than
   * `ENOENT` at a chosen moment. Measured on Windows: opening a *directory*
   * succeeds and reports size 0, so the obvious fixture does not reach this
   * path at all. Never used to make a decision; the reading is derived from the
   * bytes either way.
   */
  open: (path: string) => number = (path) => openSync(path, 'r'),
  /**
   * One chunk read. Production uses `readSync`.
   *
   * Injectable for the same reason `open` is, and for one this repository has
   * learned to state: the branch below that refuses a **short read** —
   * `read !== size` — is defence against a partial read that no fixture can
   * provoke, because a real filesystem serving a small local file does not
   * return early. A counter-proof measured that branch as unreachable and
   * therefore unpinned, which is the shape "an absence assertion is vacuous
   * until the mutant dies" describes. With this seam it is reachable, and it is
   * pinned.
   *
   * Never used to make a decision; the reading is derived from the bytes either
   * way.
   */
  readChunk: (
    handle: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number = readSync,
): MergeReconciliationLoad {
  const location = deriveMergeReconciliationLocation(repositoryRoot, taskId);
  if (!location.ok) return load('MALFORMED', null);

  let handle: number;
  try {
    handle = open(location.path);
  } catch (error: unknown) {
    // Not-found is the only errno that means "nobody wrote one". Every other
    // reason a file cannot be opened is a file that may well exist, and
    // reporting it as absent would turn a permissions problem into "AO has
    // never reconciled a merge for this task" — and, at the writer above, into
    // permission to overwrite it.
    return load(safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'MALFORMED', location.path);
  }

  try {
    const stat = fstatSync(handle);
    // A directory standing where the receipt should be is not a receipt. Stated
    // as its own check because the platform does not state it for us: measured
    // on Windows, `openSync(dir, 'r')` succeeds and `fstat` reports size 0, so
    // without this a directory would read as an empty file — the right answer
    // reached for the wrong reason, and only by accident.
    if (!stat.isFile()) return load('MALFORMED', location.path);
    const size = stat.size;
    if (size > MAX_MERGE_RECONCILIATION_BYTES) return load('MALFORMED', location.path);
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const chunk = readChunk(handle, buffer, read, size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    // A short read is a torn or truncated file, not a smaller receipt.
    if (read !== size) return load('MALFORMED', location.path);

    let raw: unknown;
    try {
      raw = JSON.parse(buffer.subarray(0, read).toString('utf8'));
    } catch {
      return load('MALFORMED', location.path);
    }
    // `undefined` is the only input `readMergeReconciliation` reads as absent,
    // and `JSON.parse` can never produce it, so a file that exists can never be
    // reported as one nobody wrote.
    const reading = readMergeReconciliation(raw, subject);
    if (reading !== 'HISTORICAL_MERGE') return load(reading, location.path);

    return load(reading, location.path, raw as MergeReconciliation);
  } catch {
    // MALFORMED unconditionally, and the absence of an errno test here is the
    // point. The `open` above has already succeeded, so *something* is on that
    // path; nothing that fails afterwards — an `fstat`, a read, a platform
    // quirk — can honestly mean "nobody wrote one", whatever errno it carries.
    //
    // It used to mirror the outer catch and map `ENOENT` to `ABSENT`. A review
    // measured that: an ENOENT-coded throw after a successful open reported the
    // receipt as absent, and at `recordMergeReconciliation` above, `ABSENT` is
    // the one reading that grants permission to write over the path. The
    // never-overwrite guarantee ran through this line.
    return load('MALFORMED', location.path);
  } finally {
    try {
      closeSync(handle);
    } catch {
      // The reading is already decided; a handle that will not close changes
      // nothing about the bytes that were read.
    }
  }
}
