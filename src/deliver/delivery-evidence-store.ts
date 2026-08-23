/**
 * Where delivery evidence lives, and the only way to put one there.
 *
 * ── The location, and why not somewhere else ───────────────────────────────
 *
 * `<repositoryRoot>/.agent-orchestrator/runtime/delivery/<taskId>.json` — a
 * companion beside the task-state file it is bound to, one directory down,
 * published through the same crash-safe primitive (`state/atomic-file.ts`:
 * stage in the same directory, flush, close, one rename).
 *
 * The directory is not decoration: it is what stops a delivery record and a
 * task state from ever addressing the same path. See
 * {@link DELIVERY_EVIDENCE_DIR_NAME} for the collision that made it necessary,
 * which a review reproduced rather than argued.
 *
 * Beside, and not *inside*, the task state. That is the same decision
 * `lease/containment-evidence.ts` records, taken for a different reason and
 * reaching the same place. Writing this into `TaskState` would need
 * `advanceTaskState`, which requires a held execution lease re-proved at the
 * moment of the write (`state/advance-state.ts`) — and this is a read-only
 * command that holds no lease. Taking one to record an observation would turn
 * `delivery` into an executing command and would make an observation contend
 * with a run for the repository. The alternatives and why each was refused are
 * in the ADR; the one worth repeating here is that a companion also keeps
 * `READY_FOR_PR` terminal without argument, because no transition is involved
 * at all.
 *
 * It lives inside the repository rather than under the operator's profile for
 * the reason `state/state-location.ts` gives about task state: copy the
 * repository and the record comes with it, delete it and the record goes, and
 * two checkouts of the same project never share one.
 *
 * ── The ignore check, and why it is here rather than assumed ───────────────
 *
 * The runtime directory is inside the target repository, so an un-ignored file
 * written there makes the checkout dirty and the *next* run refuses with
 * `SOURCE_WORKTREE_DIRTY`. `state/runtime-ignored.ts` exists for exactly that
 * and is run before the first task-state write — but it asks about two names,
 * `<taskId>.json` and its staging probe, and this slice writes two more, in a
 * directory that did not exist when that check was written.
 *
 * Most ignore rules that cover those two cover these as well. Not all: a rule
 * written as `.agent-orchestrator/runtime/*.json` matches the state file and
 * nothing one level down, and the cost of being wrong is a repository that
 * stops being runnable for a reason nothing points at. So it is asked, about
 * the exact paths this module really writes, before anything is written.
 *
 * ── One latest snapshot, not a history ─────────────────────────────────────
 *
 * A task has at most one record and a later observation replaces it. There is
 * no event store here because nothing in the product needs one: the question a
 * later slice asks is "what does AO know about this task's current subject",
 * and a superseded observation about a commit that has moved is answered by
 * `LOCAL_BINDING_MISMATCH` whether it is one record or the newest of fifty.
 * Building an append-only log would be adding a retention policy, a size
 * budget and a compaction story to answer a question nobody asked.
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
import {
  DELIVERY_EVIDENCE_VERSION,
  MAX_DELIVERY_EVIDENCE_BYTES,
  deliveryEvidenceBinding,
  readDeliveryEvidence,
  type DeliveryEvidencePayload,
  type DeliveryEvidenceReading,
  type DeliveryEvidenceSubject,
} from './delivery-evidence.js';
import { deliveryObservationFactsOf } from './delivery-observation-proof.js';

/**
 * The directory that separates delivery records from task state.
 *
 * `<runtime>/delivery/<taskId>.json`, following the precedent
 * `block/block-store.ts` already sets with `<runtime>/blocks/<runId>.json`: a
 * second kind of per-repository record gets its own directory rather than its
 * own name inside a shared one.
 *
 * ── A suffix was tried first, and it was a state-destroying defect ─────────
 *
 * The first version of this module wrote `<taskId>.delivery.json` into the
 * runtime directory itself, and its header claimed that was "deliberately not a
 * name `isStateFileName` would accept". **That was false, and an adversarial
 * review reproduced the consequence.** The task-id grammar
 * (`plan/task-id.ts`) admits `.`, so `T-001.delivery` is a perfectly legal task
 * id — which means `deriveTaskStateLocation(root, 'T-001.delivery')` and the
 * old `deriveDeliveryEvidenceLocation(root, 'T-001')` produced the **same
 * path**. Recording an observation for `T-001` would have renamed an evidence
 * blob over another task's durable state, destroying it; the reverse write
 * would have clobbered the evidence.
 *
 * That is exactly the class `lease/containment-evidence.ts` records as its
 * reason for a companion file — stage-and-rename is an ABA on a *name*, and a
 * name somebody else legitimately owns is the worst one to hold.
 *
 * A directory closes it structurally rather than by grammar. Task state is
 * always joined from `taskRuntimeDirectory()` and can never land one level
 * down, so no task id — however it is spelled — can produce a collision. The
 * file name is then simply `<taskId>.json`, judged by
 * `state-location.ts`'s own `isStateFileName`: the same grammar, shared rather
 * than restated, because the separation is structural and a second copy of the
 * rule could only drift from the first.
 */
export const DELIVERY_EVIDENCE_DIR_NAME = 'delivery';

/** The extension of a delivery evidence file. */
export const DELIVERY_EVIDENCE_FILE_EXTENSION = TASK_STATE_FILE_EXTENSION;

/** The directory holding delivery records for a canonical repository root. */
export function deliveryEvidenceDirectory(repositoryRoot: string): string {
  return join(taskRuntimeDirectory(repositoryRoot), DELIVERY_EVIDENCE_DIR_NAME);
}

/**
 * `true` when `name` is the evidence file name of *some* canonically valid task.
 *
 * Identical to the task-state grammar, and shared with it rather than restated.
 * The two records are told apart by the directory they sit in, which is a
 * property no task id can spell its way around.
 */
export function isDeliveryEvidenceFileName(name: string): boolean {
  return isStateFileName(name);
}

export interface DeliveryEvidenceLocation {
  readonly ok: true;
  readonly directory: string;
  readonly fileName: string;
  readonly path: string;
}

export interface DeliveryEvidenceLocationFailure {
  readonly ok: false;
  readonly code: 'REPOSITORY_ROOT_UNSUITABLE' | 'TASK_ID_UNSUITABLE';
}

export type DeliveryEvidenceLocationResult =
  | DeliveryEvidenceLocation
  | DeliveryEvidenceLocationFailure;

/**
 * The one file that holds `taskId`'s delivery evidence, or the reason there
 * cannot be one.
 *
 * `repositoryRoot` must already be canonical — pass `ResolvedRepository.root`.
 * Joins only: it does not resolve, does not touch the filesystem, and never
 * falls back to `process.cwd()`.
 */
export function deriveDeliveryEvidenceLocation(
  repositoryRoot: string,
  taskId: string,
): DeliveryEvidenceLocationResult {
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return Object.freeze({ ok: false as const, code: 'REPOSITORY_ROOT_UNSUITABLE' as const });
  }
  if (!isValidTaskId(taskId)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const fileName = `${taskId}${DELIVERY_EVIDENCE_FILE_EXTENSION}`;
  // Belt and braces: the derived name is judged in its own right, so a future
  // change cannot silently produce a name nothing would accept back.
  if (!isDeliveryEvidenceFileName(fileName)) {
    return Object.freeze({ ok: false as const, code: 'TASK_ID_UNSUITABLE' as const });
  }
  const directory = deliveryEvidenceDirectory(repositoryRoot);
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
 * `OBSERVATION_NOT_PROVEN` is the one worth naming twice. It is what a caller
 * gets for handing over a plain object of the right shape, a value cast to the
 * proof type, or a proof whose facts cannot be read — everything except an
 * artefact this process minted at the observation boundary. It is not a
 * validation failure to be worked around; it is the whole authority model.
 */
export type DeliveryEvidenceRecordCode =
  | 'RECORDED'
  /** The value handed in is not a minted observation proof. Nothing was written. */
  | 'OBSERVATION_NOT_PROVEN'
  /** The proof describes a different subject than the task being recorded for. */
  | 'SUBJECT_MISMATCH'
  /** The identities cannot be used as path segments. */
  | 'LOCATION_UNSUITABLE'
  /** Git does not ignore the record's own name, so writing it would dirty the checkout. */
  | 'RUNTIME_PATH_NOT_IGNORED'
  /** Git could not say whether the path is ignored. Never rounded to either answer. */
  | 'RUNTIME_IGNORE_UNDETERMINED'
  /** The per-repository runtime directory could not be created. */
  | 'DIRECTORY_CREATE_FAILED'
  /** The record this build produced is larger than it will read back. */
  | 'EVIDENCE_TOO_LARGE'
  /** The record this build produced is not one it would accept back. */
  | 'EVIDENCE_CONTRACT_VIOLATION'
  /** The atomic replacement did not complete. Any previous record survives. */
  | 'WRITE_FAILED';

export interface DeliveryEvidenceRecordResult {
  readonly code: DeliveryEvidenceRecordCode;
  /** `true` only after a complete write, a successful flush and a clean replace. */
  readonly recorded: boolean;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

function recordFailure(
  code: DeliveryEvidenceRecordCode,
  path: string | null,
  errnoCode: string | null = null,
): DeliveryEvidenceRecordResult {
  return Object.freeze({ code, recorded: false as const, path, errnoCode });
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

export interface DeliveryEvidenceWriteRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** The task's own identity, read fresh. Binds the record to these bytes. */
  readonly subject: DeliveryEvidenceSubject;
  /** The state the task was in, and the base it was built on. Context. */
  readonly taskState: string;
  readonly basePinnedCommit: string | null;
  /** The remote name the profile declared. */
  readonly declaredRemote: string;
  /**
   * The subject the caller believes it asked about, from the task's own record
   * and the repository's own delivery target — never from the proof.
   *
   * Supplied separately so the two can be *compared*. Reading the subject out
   * of the proof and then recording it would make the check a tautology: the
   * proof would be evidence for whatever the proof said, and a real observation
   * of one commit could be filed against a task pinning another.
   */
  readonly expectedSubjectCommit: string;
  readonly expectedHost: string;
  readonly expectedOwner: string;
  readonly expectedName: string;
  /**
   * The minted observation. Typed as `unknown` deliberately.
   *
   * The gate is a runtime check on an artefact this process made, so the
   * parameter must be able to receive the shape-valid object a forger would
   * hand over. Typing it as the proof would make the refusal a compile-time
   * one, which is exactly the guarantee that does not survive a cast — and the
   * test that matters drives a cast value through this argument.
   */
  readonly proof: unknown;
  /** When these bytes are being written. */
  readonly recordedAt: string;
  /** Asks Git whether a repository-relative path is ignored. */
  readonly checkIgnored: (relativePath: string) => Promise<IgnoreVerdict>;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

/**
 * Writes one task's delivery evidence, or refuses.
 *
 * The order is the contract. The proof is checked first, before a path is
 * derived and before Git is asked anything, so that a caller who never observed
 * anything cannot cause a filesystem effect of any kind — not even a created
 * directory.
 */
export async function recordDeliveryEvidence(
  request: DeliveryEvidenceWriteRequest,
): Promise<DeliveryEvidenceRecordResult> {
  // ── 1. Provenance, before anything else ──────────────────────────────────
  const facts = deliveryObservationFactsOf(request.proof);
  if (facts === null) return recordFailure('OBSERVATION_NOT_PROVEN', null);

  const location = deriveDeliveryEvidenceLocation(request.repositoryRoot, request.taskId);
  if (!location.ok) return recordFailure('LOCATION_UNSUITABLE', null);

  // ── 2. The proof must be about the task being recorded for ───────────────
  //
  // The proof carries its own subject, and the caller supplies the task's. A
  // caller that observed commit A and recorded it against a task pinning commit
  // B would be manufacturing evidence out of a *real* observation, which the
  // mint alone cannot prevent — it vouches that an observation happened, never
  // that it was about this task, this commit or this repository.
  //
  // All five are checked, not just the commit. An observation of the right
  // commit in the wrong repository is the same defect wearing a different hat:
  // two forks can share a commit object name exactly, so the identity has to be
  // part of the question rather than assumed to follow from it.
  if (facts.commit !== request.expectedSubjectCommit) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }
  if (
    facts.host !== request.expectedHost ||
    facts.owner !== request.expectedOwner ||
    facts.name !== request.expectedName
  ) {
    return recordFailure('SUBJECT_MISMATCH', null);
  }

  // ── 3. The ignore question, before any filesystem effect ─────────────────
  const relativeRecord = `.agent-orchestrator/runtime/${DELIVERY_EVIDENCE_DIR_NAME}/${location.fileName}`;
  // `writeFileAtomically` stages `<name>.tmp-<suffix>` beside the target, and a
  // crash can leave one behind, so the staging shape is asked about too. Two
  // calls rather than two arguments: `check-ignore` ORs its arguments, so one
  // call carrying both would answer "ignored" whenever either passed — the
  // opposite of the conjunction this needs.
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

  // ── 4. Build the payload from the proof's facts, and from nothing else ───
  const payload: DeliveryEvidencePayload = {
    evidenceVersion: DELIVERY_EVIDENCE_VERSION,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
    taskState: request.taskState,
    stateRevision: request.subject.stateRevision,
    subjectCommit: facts.commit,
    basePinnedCommit: request.basePinnedCommit,
    provider: 'github',
    host: facts.host,
    owner: facts.owner,
    name: facts.name,
    declaredRemote: request.declaredRemote,
    pullRequestOutcome: facts.pullRequestOutcome as DeliveryEvidencePayload['pullRequestOutcome'],
    pullRequestNumber: facts.pullRequestNumber,
    pullRequestHeadSha: facts.pullRequestHeadSha,
    checkQueriedCommit: facts.checkQueriedCommit,
    checkOutcome: facts.checkOutcome as DeliveryEvidencePayload['checkOutcome'],
    checkRuns: facts.checkRuns,
    commitStatuses: facts.commitStatuses,
    checksFailed: facts.checksFailed,
    checksPending: facts.checksPending,
    checksSucceeded: facts.checksSucceeded,
    checksNeutralOrSkipped: facts.checksNeutralOrSkipped,
    observedAt: facts.observedAt,
    recordedAt: request.recordedAt,
  };
  const record = { ...payload, binding: deliveryEvidenceBinding(request.subject, payload) };

  // ── 5. Prove this build would accept its own record back ─────────────────
  //
  // Read-back-before-write, the same guard the containment record uses. A
  // record this build could not parse would be indistinguishable on disk from
  // one somebody corrupted, and the difference between "we wrote nonsense" and
  // "somebody tampered" is worth keeping.
  const reading = readDeliveryEvidence(record, request.subject, {
    subjectCommit: facts.commit,
    host: facts.host,
    owner: facts.owner,
    name: facts.name,
    declaredRemote: request.declaredRemote,
  });
  if (reading !== 'HISTORICAL_VALID') {
    return recordFailure('EVIDENCE_CONTRACT_VIOLATION', location.path);
  }

  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_DELIVERY_EVIDENCE_BYTES) {
    return recordFailure('EVIDENCE_TOO_LARGE', location.path);
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
    isAcceptableFileName: isDeliveryEvidenceFileName,
    ...(request.replace === undefined ? {} : { replace: request.replace }),
    ...(request.tempSuffix === undefined ? {} : { tempSuffix: request.tempSuffix }),
  });
  if (!written.written) {
    return recordFailure('WRITE_FAILED', location.path, written.errnoCode);
  }
  return Object.freeze({
    code: 'RECORDED' as const,
    recorded: true as const,
    path: location.path,
    errnoCode: null,
  });
}

/* ──────────────────────────────── reading ───────────────────────────────── */

export interface DeliveryEvidenceLoad {
  readonly reading: DeliveryEvidenceReading;
  /** The intended path, or `null` when no location could be derived. */
  readonly path: string | null;
  /**
   * When the observation was made, for a reading that produced one.
   *
   * Present only on `HISTORICAL_VALID`, and on nothing else: a timestamp read
   * out of a record this build refused would be a fact borrowed from a document
   * it has just said it cannot read.
   */
  readonly observedAt: string | null;
  /** The settled outcomes, on `HISTORICAL_VALID` only. Historical, always. */
  readonly pullRequestOutcome: string | null;
  readonly pullRequestNumber: number | null;
  readonly checkOutcome: string | null;
}

function load(
  reading: DeliveryEvidenceReading,
  path: string | null,
  observedAt: string | null = null,
  pullRequestOutcome: string | null = null,
  pullRequestNumber: number | null = null,
  checkOutcome: string | null = null,
): DeliveryEvidenceLoad {
  return Object.freeze({
    reading,
    path,
    observedAt,
    pullRequestOutcome,
    pullRequestNumber,
    checkOutcome,
  });
}

/**
 * Reads back the record for one task, and judges it against that task now.
 *
 * Named for what it produces. There is deliberately no `loadCurrentDelivery…`
 * and no `isDeliveryGreen`: every value this returns is about the past, and a
 * name that suggested otherwise is the defect this slice exists to avoid.
 *
 * Never throws. An unreadable file, an oversized one, one that is not JSON, and
 * one that is JSON of the wrong shape all reach a reading rather than an
 * exception, because the caller is an operator report and a thrown error there
 * is a worse answer than a refusal.
 */
export function loadDeliveryEvidence(
  repositoryRoot: string,
  taskId: string,
  subject: DeliveryEvidenceSubject,
  expected: {
    readonly subjectCommit: string;
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly declaredRemote: string;
  },
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
): DeliveryEvidenceLoad {
  const location = deriveDeliveryEvidenceLocation(repositoryRoot, taskId);
  if (!location.ok) return load('MALFORMED', null);

  let handle: number;
  try {
    handle = open(location.path);
  } catch (error: unknown) {
    // Not-found is the only errno that means "nobody wrote one". Every other
    // reason a file cannot be opened is a file that may well exist, and
    // reporting it as absent would turn a permissions problem into "AO has
    // never observed this".
    return load(safeErrnoCode(error) === 'ENOENT' ? 'ABSENT' : 'MALFORMED', location.path);
  }

  try {
    const stat = fstatSync(handle);
    // A directory standing where the record should be is not a record. Stated
    // as its own check because the platform does not state it for us: measured
    // on Windows, `openSync(dir, 'r')` succeeds and `fstat` reports size 0, so
    // without this a directory would read as an empty file — the right answer
    // reached for the wrong reason, and only by accident.
    if (!stat.isFile()) return load('MALFORMED', location.path);
    const size = stat.size;
    if (size > MAX_DELIVERY_EVIDENCE_BYTES) return load('MALFORMED', location.path);
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const chunk = readSync(handle, buffer, read, size - read, read);
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
    // `undefined` is the only input `readDeliveryEvidence` reads as absent, and
    // `JSON.parse` can never produce it, so a file that exists can never be
    // reported as one nobody wrote.
    const reading = readDeliveryEvidence(raw, subject, expected);
    if (reading !== 'HISTORICAL_VALID') return load(reading, location.path);

    const record = raw as {
      observedAt: string;
      pullRequestOutcome: string;
      pullRequestNumber: number | null;
      checkOutcome: string;
    };
    return load(
      reading,
      location.path,
      record.observedAt,
      record.pullRequestOutcome,
      record.pullRequestNumber,
      record.checkOutcome,
    );
  } catch (error: unknown) {
    void error;
    return load('MALFORMED', location.path);
  } finally {
    try {
      closeSync(handle);
    } catch {
      // Nothing to do and nothing to report: the read either produced a reading
      // or it did not, and a failed close cannot change which.
    }
  }
}
