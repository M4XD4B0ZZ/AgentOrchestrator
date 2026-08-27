/**
 * Writing the outcome of one unattended head publication, exactly once, into the
 * event directory its authorisation already occupies (V4 slice 16).
 *
 * ── Where it goes, and why not anywhere else ───────────────────────────────
 *
 * Beside the authorisation, inside the event directory that invocation created
 * exclusively for itself:
 *
 *     <profile>/.agent-orchestrator/head-publication-authorisations/
 *       <UTC instant>-<uuid v4>/
 *         authorisation.json   ← written before the delivery remote was contacted
 *         outcome.json         ← written after the publication processing ended
 *
 * One event identity, two propositions, two documents. The alternatives were
 * each attacked and each lost something:
 *
 *  - **a second event directory** would give one publication two identities and
 *    need a lookup to pair them, which is a global index this store does not
 *    have and `L-V4-14-3` says so;
 *  - **a global outcome store keyed by event id** is that index, plus a second
 *    root, plus a second retention question;
 *  - **a field on `authorisation.json`** would rewrite the one document this
 *    build writes before contacting a remote. Every sentence in its header about
 *    "these bytes were written before" would stop being true of the bytes on
 *    disk;
 *  - **an append-only history file** would make one event's evidence a sequence,
 *    and a sequence has a last element somebody will call the current state.
 *
 * ── Create-once, and by which primitive ────────────────────────────────────
 *
 * The authorisation store gets its create-once from the **exclusive `mkdir`** of
 * the event directory: `createRunDirectory` refuses a name that exists, so the
 * record inside it is written into a directory nobody else can be writing to.
 * That is not available here — this invocation's own directory already exists —
 * so the exclusivity has to move down to the file, and it is `writeRunArtifact`
 * from `doctor/safe-write.ts` that provides it: one `openSync(target, 'wx')` at
 * the final name, with `EEXIST` answered by the kernel in the same syscall that
 * would have created the file. There is deliberately no `lstat`-then-open, no
 * existence check and no rename — a check-then-rename is the TOCTOU race that
 * module was rewritten to remove, and `writeFileAtomically`'s rename would
 * **replace** an existing outcome, which is the one thing this store may never
 * do.
 *
 * What that costs, stated rather than rounded away: `writeRunArtifact` writes
 * into the final name, so a crash mid-write can leave a **prefix** of an outcome
 * on disk, which the crash-safe primitive would not. That is accepted here and
 * would not be accepted for the authorisation, and the difference is what a
 * prefix reads as. A prefix of this document cannot read as an outcome — the
 * JSON is unbalanced, the schema is `.strict()`, and the binding covers the whole
 * payload — so an operator is told a document is there and cannot be read.
 * Which member they are told depends on how far the write got, and the exclusive
 * open comes first: a crash before the first byte leaves an empty file, which
 * the listing reads as `OUTCOME_EMPTY`, and a crash inside the write leaves a
 * prefix, which it reads as `OUTCOME_MALFORMED`. Neither can read as a *valid*
 * outcome, which is the property that matters and the only one claimed.
 *
 * ── An outcome already at the name is a refusal, and not for slice 14's reason ─
 *
 * There is no `ALREADY_RECORDED` here, and the argument is **not** the one the
 * authorisation store makes. There, a record already at the name is refused
 * because a record that licensed the effect would be a replay. No outcome ever
 * licenses anything, so that argument does not transfer.
 *
 * The argument that does: **a byte-identical outcome cannot be this
 * invocation's.** The event name carries a version-4 UUID this process minted,
 * the event directory was created by an exclusive `mkdir` in this process, and
 * this call is the first and only write of this name. Anything already there was
 * written by something else, and reporting it as recorded would attribute a
 * foreign document to this run. So the existing file is **never opened**, never
 * compared and never replaced: the name is answered by the kernel and the code
 * is `OUTCOME_ALREADY_PRESENT`.
 *
 * ── Written, then read back — after the effect, which changes what it costs ──
 *
 * The bytes are read off the disk again and compared with the ones this
 * invocation intended, exactly as the authorisation store does. What is
 * different is what a failure means. There, a refusal happens *before* the
 * remote is contacted and stops the publication. Here the ladder has already run
 * to the end — on one of its paths with a mutation on the delivery remote — and
 * nothing can be undone: a refusal here **changes what the invocation reports
 * and nothing else**. It never retries, never compensates, never contacts the
 * remote a second time and never touches the authorisation beside it.
 *
 * What may honestly be claimed after that is "written, closed and read back",
 * and **not** "durable across power loss" — the same two gaps the authorisation
 * store states for itself, restated here rather than inherited quietly, because
 * this store feeds a driver member with the word `NOT_DURABLE` in its name. The
 * handle is flushed only where the filesystem supports flushing: the primitive
 * treats an `EINVAL` from `fsync` as "not supported here" and reports the write
 * as done, and this store does not refuse it. And the directory entry is never
 * flushed at all, because nothing in this build flushes one.
 *
 * ── What this module is not ────────────────────────────────────────────────
 *
 * It decides nothing about whether a publication may happen — it runs after one
 * has finished. It imports no grant, mints nothing, reads no declaration, reads
 * no task state and contacts nothing. It builds no identity of its own: every
 * fact it writes down is handed to it by the one caller that held the authority,
 * which is the rule the authorisation store states for the same reason.
 */

import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { isValidRunId } from '../doctor/run-directory.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { inspectLinkChain, writeRunArtifact, type RunArtifactCode } from '../doctor/safe-write.js';
import {
  HEAD_PUBLICATION_OUTCOME_FILE_NAME,
  headPublicationAuditRoot,
} from './internal/head-publication-audit-location.js';
import {
  HEAD_PUBLICATION_OUTCOME_VERSION,
  MAX_HEAD_PUBLICATION_OUTCOME_BYTES,
  headPublicationOutcomeBinding,
  readHeadPublicationOutcome,
  type HeadPublicationOutcomePayload,
  type HeadPublicationOutcomeSubject,
  type PublicationCommandReport,
  type PublicationOutcome,
} from './head-publication-outcome.js';

/** The file name, re-exported so one import serves a caller that needs both. */
export { HEAD_PUBLICATION_OUTCOME_FILE_NAME };

/**
 * Every way recording an outcome can end. A closed set, and exactly one of them
 * **established** an outcome.
 *
 * Not "exactly one of them wrote", which is what this sentence said until a
 * review counted: four of them can leave bytes at the name. `WRITE_UNCONFIRMED`
 * reaches it without carrying the write to a confirmed end, and the two
 * read-back refusals are only reachable *after* a complete write, an attempted
 * flush and a clean close. What separates `RECORDED` from those three is the
 * read-back, not the writing.
 *
 * The members are apart because the remedies are, and each carries its own
 * sentence below. There is deliberately no tally here — a count beside an
 * enumeration is the shape this repository has already had to correct more than
 * once.
 */
export const HEAD_PUBLICATION_OUTCOME_CODES = [
  /** Written, and read back byte-for-byte as this event's outcome. */
  'RECORDED',
  /** The OS could not be asked where the user profile is, so there is no store. */
  'PROFILE_UNAVAILABLE',
  /** The event name handed to this store is not one it would accept as a segment. */
  'EVENT_ID_UNSUITABLE',
  /**
   * The store's path could not be shown to be free of links, so nothing was
   * written through it.
   *
   * Two producers and the sentence covers both, because this build cannot tell
   * them apart: a symbolic link or a junction was found on the path, or a
   * component of it could not be inspected at all. Naming only the first would
   * send an operator to look for a link that may not be there — which is what
   * `doctor/safe-write.ts` says in as many words about its own answer.
   */
  'STORE_PATH_UNSAFE',
  /**
   * The event directory could not be used: it is not there, it is not a
   * directory, or it could not be described at all.
   *
   * Its own member because the remedy is its own — something happened to this
   * event's own directory between the authorisation and now — and the errno is
   * carried beside it for the cases where the OS said which. This store creates
   * nothing, so there is nothing for it to do about any of them.
   */
  'EVENT_DIRECTORY_UNUSABLE',
  /**
   * Something already occupies this event's outcome name. Never replaced, and
   * never opened — see the header for why an identical document would still be
   * somebody else's.
   */
  'OUTCOME_ALREADY_PRESENT',
  /** The outcome this build produced is larger than it will read back. */
  'OUTCOME_TOO_LARGE',
  /** The outcome this build produced is not one it would accept back. */
  'OUTCOME_CONTRACT_VIOLATION',
  /**
   * The name was not created. Nothing at all is on disk for this event's
   * outcome, and the name is still free — though nothing will ever use it.
   */
  'WRITE_REFUSED',
  /**
   * The name **was** created and the write did not reach a confirmed end: the
   * bytes did not all go out, the flush failed, or the handle did not close
   * cleanly.
   *
   * Permanently different from `WRITE_REFUSED`, and the difference is that the
   * name is consumed: nothing will ever write this event's outcome now.
   *
   * What is *at* the name is deliberately not claimed, and an earlier draft of
   * this sentence claimed it — that every later listing would show an outcome it
   * cannot read. Measured false for two of the three producers: the primitive
   * refuses a short write before it flushes, so a failed flush and a failed
   * close both leave the whole document on the disk, and a later listing reads
   * it as `HISTORICAL_OUTCOME`. A short write is the one producer that can leave
   * something else there.
   * This build does not read the name back on this path — the read-back is the
   * step it did not reach — so the honest answer is that it does not know, and
   * an operator finding a readable outcome for an event reported this way is
   * seeing the ordinary case rather than a contradiction.
   */
  'WRITE_UNCONFIRMED',
  /** The bytes could not be read back at all. */
  'READBACK_FAILED',
  /** The bytes read back are not the ones this invocation intended. */
  'READBACK_MISMATCH',
] as const;

export type HeadPublicationOutcomeCode = (typeof HEAD_PUBLICATION_OUTCOME_CODES)[number];

export interface HeadPublicationOutcomeResult {
  readonly code: HeadPublicationOutcomeCode;
  /** `true` only after a complete write and a matching read-back. */
  readonly recorded: boolean;
  /** The event identity this outcome was filed under. Always present. */
  readonly eventId: string;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

function outcomeResult(
  code: HeadPublicationOutcomeCode,
  eventId: string,
  errnoCode: string | null = null,
): HeadPublicationOutcomeResult {
  return Object.freeze({ code, recorded: code === 'RECORDED', eventId, errnoCode });
}

/**
 * Every fact one outcome binds, supplied by the caller and never derived here.
 *
 * `authorisationBinding` is the binding digest of the authorisation record this
 * outcome belongs to, as the store that wrote it reported. It is the anchor that
 * makes an outcome unattachable to any other event, and it is a caller's value
 * rather than something read back off the disk here: this module does not open
 * the authorisation, and a store that re-read it would be grading its own second
 * opinion of an event it did not authorise.
 */
export interface HeadPublicationOutcomeRequest {
  readonly eventId: string;
  /** The task the authorisation record names. */
  readonly taskId: string;
  /** The canonical local root the authorisation record names. */
  readonly repositoryRoot: string;
  /** The authorisation record's own binding digest. */
  readonly authorisationBinding: string;
  readonly outcome: PublicationOutcome;
  readonly commandReport: PublicationCommandReport;
  /** When the outcome was built, immediately after the publication processing ended. */
  readonly recordedAt: string;
  readonly pathProvider?: PathProvider | undefined;
  /**
   * The exclusive create-and-write. Production uses the real one.
   *
   * Injectable for the reason `state/atomic-file.ts` gives about its own
   * `replace`: the guarantees this module exists to provide — that a write which
   * did not carry through refuses, and that bytes which came back wrong refuse —
   * cannot be provoked reliably against a real filesystem. It is a **seam beside
   * the real thing and never instead of it**: the productive default is pinned
   * by the suite, and the create-once and already-present cases are measured
   * against the real primitive on a real scratch profile.
   */
  readonly writeArtifact?: typeof writeRunArtifact | undefined;
}

/** The act an outcome in this store is about. A constant, never a parameter. */
const RECORDED_ACT = 'HEAD_PUBLICATION' as const;

/**
 * How the artefact writer's answers become this store's.
 *
 * Total by type over {@link RunArtifactCode}, so a member added to that
 * vocabulary is a compile error here rather than a code that falls past a switch
 * and lets the caller believe an outcome is on disk. `null` is the one answer
 * that continues.
 *
 * The three that mean "the name was created and the write did not carry through"
 * collapse into one member on purpose: they send an operator to the same place —
 * a consumed name holding something unreadable — and three codes describing one
 * situation would be three vocabularies for one remedy.
 */
const ARTEFACT_REFUSAL: Readonly<Record<RunArtifactCode, HeadPublicationOutcomeCode | null>> =
  Object.freeze({
    WRITTEN: null,
    PATH_ESCAPES_RUN_DIRECTORY: 'WRITE_REFUSED',
    PATH_CONTAINS_LINK: 'STORE_PATH_UNSAFE',
    RUN_DIRECTORY_UNUSABLE: 'EVENT_DIRECTORY_UNUSABLE',
    TARGET_EXISTS: 'OUTCOME_ALREADY_PRESENT',
    OPEN_FAILED: 'WRITE_REFUSED',
    WRITE_FAILED: 'WRITE_UNCONFIRMED',
    SYNC_FAILED: 'WRITE_UNCONFIRMED',
    CLOSE_FAILED: 'WRITE_UNCONFIRMED',
  });

/**
 * Reads back exactly what is on disk at `path`, or `null` when it cannot.
 *
 * Opened by name and `fstat`ed rather than `stat`ed, for the reason the
 * authorisation store's own read-back gives: on Windows a directory opens
 * successfully and reports size zero, so without the file test a directory would
 * read as an empty file — the right answer reached by accident.
 */
function readOutcomeBytes(path: string): Buffer | null {
  let handle: number;
  try {
    handle = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_HEAD_PUBLICATION_OUTCOME_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(handle, buffer, read, buffer.length - read, read);
      if (got <= 0) break;
      read += got;
    }
    return read === buffer.length ? buffer : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(handle);
    } catch {
      // The bytes are already in hand or already lost; a failed close adds
      // nothing to either answer.
    }
  }
}

/**
 * Writes one outcome record, or refuses — and a refusal here never undoes
 * anything, because there is nothing left to undo.
 *
 * The order is the contract. The outcome is built and graded **before** any
 * filesystem effect, so a caller whose facts cannot make a readable outcome
 * touches nothing; and the bytes are read back off the disk **before** this
 * returns, so "recorded" is a statement about the disk rather than about a
 * function that returned.
 *
 * Nothing here decides whether anything may happen. It reports what it did, and
 * the caller — which is the only module that held the publication authority —
 * decides what a refusal means.
 */
export function recordHeadPublicationOutcome(
  request: HeadPublicationOutcomeRequest,
): HeadPublicationOutcomeResult {
  // ── 0. The one argument this store judges, judged first ───────────────────
  //
  // Before the record is built, because an argument refusal placed after work
  // becomes conditional on what that work answered — this suite caught exactly
  // that: an empty event name failed the record contract instead, and reported
  // a defect in the document rather than in the name it was to be filed under.
  //
  // It is the producer's own grammar. `writeRunArtifact` validates the *file*
  // name and proves containment inside the directory it is given; it does not
  // judge the directory, and a name with a separator in it would name a
  // directory outside the store before that proof ever runs.
  if (!isValidRunId(request.eventId)) {
    return outcomeResult('EVENT_ID_UNSUITABLE', request.eventId);
  }

  const subject: HeadPublicationOutcomeSubject = Object.freeze({
    eventId: request.eventId,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
    authorisationBinding: request.authorisationBinding,
  });

  const payload: HeadPublicationOutcomePayload = Object.freeze({
    outcomeVersion: HEAD_PUBLICATION_OUTCOME_VERSION as 1,
    eventId: request.eventId,
    act: RECORDED_ACT,
    outcome: request.outcome,
    commandReport: request.commandReport,
    recordedAt: request.recordedAt,
  });

  const bytes = Buffer.from(
    `${JSON.stringify(
      { ...payload, binding: headPublicationOutcomeBinding(subject, payload) },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // ── 1. The outcome this build produced, judged before anything is touched ─
  if (bytes.byteLength > MAX_HEAD_PUBLICATION_OUTCOME_BYTES) {
    return outcomeResult('OUTCOME_TOO_LARGE', request.eventId);
  }
  if (readHeadPublicationOutcome(bytes, subject) !== 'HISTORICAL_OUTCOME') {
    return outcomeResult('OUTCOME_CONTRACT_VIOLATION', request.eventId);
  }

  // ── 2. Where it goes ──────────────────────────────────────────────────────
  let root: string;
  try {
    root = headPublicationAuditRoot(request.pathProvider ?? OS_PATH_PROVIDER);
  } catch {
    // The profile resolver throws rather than guessing, and its message is
    // already value-free. It is dropped here regardless.
    return outcomeResult('PROFILE_UNAVAILABLE', request.eventId);
  }

  const directory = join(root, request.eventId);

  // A store reached through a link is somebody else's directory wearing this
  // one's name. `writeRunArtifact` inspects the chain too; this asks first so
  // that a blocked path is reported as a blocked path rather than as whatever
  // the open happened to fail with.
  //
  // `allowMissing` is `true`, and the missing case is answered one step below
  // rather than here: by the time an outcome is written this invocation has
  // already created this directory, so a directory that is gone is a fact about
  // the store having been removed underneath it — which is its own member — and
  // not a link refusal. Reporting it here would send an operator to look for a
  // junction that is not there.
  const chain = inspectLinkChain(directory, { allowMissing: true });
  if (chain !== 'CLEAR') return outcomeResult('STORE_PATH_UNSAFE', request.eventId);

  let directoryStats;
  try {
    directoryStats = lstatSync(directory);
  } catch (error) {
    return outcomeResult('EVENT_DIRECTORY_UNUSABLE', request.eventId, safeErrnoCode(error));
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    return outcomeResult('EVENT_DIRECTORY_UNUSABLE', request.eventId);
  }

  // ── 3. The bytes, created exclusively at their final name ─────────────────
  const write = request.writeArtifact ?? writeRunArtifact;
  const written = write({
    runDirectory: directory,
    fileName: HEAD_PUBLICATION_OUTCOME_FILE_NAME,
    contents: bytes.toString('utf8'),
  });
  const refusal = ARTEFACT_REFUSAL[written.code];
  // Two conditions, and **the second is not reachable today** — which is
  // measured, not assumed: a mutant that removed `!written.written` alone left
  // the suite green, and one that disabled both failed it thirteen ways. The map
  // answers for every code the primitive produces, and `WRITTEN` is the only one
  // it maps to `null`.
  //
  // It is kept as a stated rule rather than as coverage: a future member mapped
  // to `null` by mistake would otherwise resume the read-back against a file
  // nobody made. This says so plainly rather than letting a later reader take
  // the pair for a measurement.
  if (refusal !== null || !written.written) {
    return outcomeResult(refusal ?? 'WRITE_REFUSED', request.eventId, written.errnoCode);
  }

  // ── 4. The disk, not the return value ─────────────────────────────────────
  const stored = readOutcomeBytes(join(directory, HEAD_PUBLICATION_OUTCOME_FILE_NAME));
  if (stored === null) return outcomeResult('READBACK_FAILED', request.eventId);
  // One comparison, not two. Step 1 already graded these exact bytes as this
  // event's outcome, so "the disk holds these bytes" and "the disk holds an
  // outcome this build reads as this event's" are the same sentence. Grading the
  // bytes again here would be a check that cannot fail while this one passes — a
  // redundancy that reads as coverage and is not.
  if (!stored.equals(bytes)) return outcomeResult('READBACK_MISMATCH', request.eventId);

  return outcomeResult('RECORDED', request.eventId);
}
