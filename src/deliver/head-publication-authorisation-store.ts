/**
 * Where the unattended-publication authorisation records live, and the only way
 * to put one there (V4 slice 14).
 *
 * ── The location, and why not beside the delivery's other records ──────────
 *
 *     <OS user profile>/.agent-orchestrator/head-publication-authorisations/
 *         <event id>/
 *             authorisation.json
 *
 * Every other durable delivery record in this build sits inside the repository
 * it describes — the observation, the merge receipt, the verification history,
 * the conclusion — for a reason `state/state-location.ts` states well: state
 * belongs to the repository it describes, copy the repository and the record
 * comes with it, delete it and the record goes.
 *
 * That reason inverts here, and three measurements say so.
 *
 *  1. **The subject outlives the checkout.** What this record is about is a ref
 *     on a forge. The checkout is the most deletable thing in the system —
 *     worktrees are removed, clones are re-made, disks are wiped — and "delete
 *     the repository and the record of what you were authorised to publish goes
 *     with it" is not a property anyone would choose for an accountability
 *     record.
 *  2. **The audited party must not own the store.** `--repository` is a path,
 *     and a linked worktree answers `rev-parse --show-toplevel` with itself, so
 *     it resolves as a repository in its own right. Point the command at ground
 *     the writing agent can edit and every in-repository store is inside that
 *     agent's sandbox. The operator profile is the one root that is immune, and
 *     the immunity is structural rather than conventional: it is derived from
 *     `os.userInfo()` through `config/internal/trusted-profile.ts`, which
 *     consults no environment block, takes no parameter, and cannot be
 *     relocated by a caller, a parent process, a CLI flag or a repository file.
 *  3. **It is where the authority already lives.** The declaration this record
 *     names is a file in that same directory. Filing the record beside the
 *     permission it acted under means one trust argument governs both, and no
 *     repository operation can separate them.
 *
 * There is a fourth, narrower reason and it is the one that decides the *order*
 * of things rather than the place. An in-repository record has to ask Git
 * whether its own path is ignored before it may be written — an un-ignored file
 * under the runtime directory makes the checkout dirty and the next run refuses.
 * Under `--automatic-publish-head-only` this record is a precondition of a forge
 * mutation, so that question would put the target repository's `.gitignore`, and
 * two more child processes, on the critical path of an authority record. The
 * operator profile needs neither.
 *
 * The cost is stated rather than hidden: the record is not repository-reviewable
 * and travels with the machine rather than with the code. That is `L-V4-13-2`'s
 * trade taken a second time, deliberately, for an artefact whose whole point is
 * that the audited party cannot reach it.
 *
 * ── One directory per event, created exclusively ───────────────────────────
 *
 * Two unattended invocations may run at once, on one repository and one task.
 * Nothing local fences them — the publication takes no execution lease, and
 * deliberately: a local lock cannot fence a second clone, another machine or a
 * person with a terminal. So the store has to be safe under two writers with no
 * coordination at all.
 *
 * Every existing per-task store here would be wrong for that. They are
 * file-per-task and published by replacement — stage beside the target, flush,
 * one rename — and a rename overwrites. Two invocations would produce one
 * record, and the survivor would be whichever finished second.
 *
 * So the identity is per **event**, not per task, and the fence is the kernel's:
 * the event directory is created with a non-recursive `mkdir`, which either
 * creates it or fails `EEXIST`, in one step. A name already taken is a refusal
 * and never a reuse. That is `doctor/run-directory.ts`'s protocol, used as it is
 * written rather than copied: it also carries three link inspections — before
 * creating the root, again after creating it because a racing writer could have
 * planted one, and once more on the directory it just made.
 *
 * The name is a UTC instant plus a version-4 UUID, and the parts do different
 * jobs: the instant makes the store readable by a person, the UUID is what makes
 * the name unguessable and collision-free. Neither is trusted on its own —
 * equal timestamps collide by construction and a process id is reused after
 * exit, so the guarantee is taken from the exclusive `mkdir` and the name only
 * has to be unlikely to repeat.
 *
 * **Nothing from the repository, the task, the forge identity, the environment
 * or the command line enters the path.** All of those live in the record's body,
 * byte-exact. Two measurements decided that. Owner and repository names admit
 * Windows device names, trailing dots and a hundred characters, and the
 * declaration's own schema admits arbitrary text of the same length because it
 * is only ever compared exactly. And identity is compared case-sensitively while
 * NTFS folds case, so two entries differing only in capitalisation are two
 * different permissions that would file into one directory — two authorities,
 * one trail, and the trail unable to say which authority it was about.
 *
 * ── Created once, and never rewritten ──────────────────────────────────────
 *
 * The record file is written into a directory this invocation exclusively
 * created, through the crash-safe primitive: stage beside the target, flush,
 * close, one rename. Inside a directory nobody else can have, that rename has
 * nothing to race against, and the guarantee it buys is the one that matters
 * after a crash — the file is either absent or complete, never a prefix.
 *
 * There is no update path, no second write and no field a later invocation
 * could change. A record is one immutable fact about one instant, and a later
 * invocation that reaches the same boundary again writes its own.
 *
 * ── Written, then read back, before the effect ─────────────────────────────
 *
 * "The write function returned" is not the guarantee this slice needs, so the
 * bytes are read off the disk again and compared with the ones this invocation
 * intended. Success is exactly that: byte-for-byte the record it built, on the
 * disk, under the name it chose.
 *
 * Those bytes were already graded — before the directory existed — by the same
 * reader an operator would use, so the comparison here carries the grading with
 * it rather than repeating it.
 *
 * What may honestly be claimed after that is "written, closed and read back",
 * and **not** "durable across power loss". Two gaps, and both are stated rather
 * than rounded away. The staging handle is flushed only where the filesystem
 * supports flushing — the primitive treats an `EINVAL` from `fsync` as "not
 * supported here" and reports the write as done, and this store does not refuse
 * it, because refusing would make the publication depend on a filesystem
 * property nothing else in this build depends on. And the directory entry is
 * never flushed at all, because nothing in this build flushes one.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { orchestratorHome } from '../config/paths.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { createRunDirectory, newRunId, type RunDirectoryCode } from '../doctor/run-directory.js';
import { writeFileAtomically, type ReplaceFn, type TempSuffixFn } from '../state/atomic-file.js';
import {
  HEAD_PUBLICATION_AUTHORISATION_VERSION,
  MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES,
  headPublicationAuthorisationBinding,
  readHeadPublicationAuthorisation,
  type HeadPublicationAuthorisationPayload,
  type HeadPublicationAuthorisationSubject,
} from './head-publication-authorisation.js';

/**
 * The directory under the orchestrator home that holds the records.
 *
 * A directory of its own, following the rule this build already made structural
 * after reproducing the alternative: a new kind of record gets its own
 * directory rather than its own name inside a shared one.
 *
 * Named for what it holds — authorisations — and deliberately not for
 * publications. A directory called `head-publications` would make its own
 * existence a claim that things were published, and the records inside it assert
 * nothing of the sort.
 */
export const HEAD_PUBLICATION_AUDIT_DIR_NAME = 'head-publication-authorisations';

/** The one file name inside an event directory. No alternative spelling. */
export const HEAD_PUBLICATION_AUDIT_FILE_NAME = 'authorisation.json';

/** The store root. A pure function of the OS user identity. */
export function headPublicationAuditRoot(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(orchestratorHome(provider), HEAD_PUBLICATION_AUDIT_DIR_NAME);
}

/**
 * A fresh event identity: a UTC instant and a version-4 UUID.
 *
 * The grammar is `doctor/run-directory.ts`'s, shared rather than restated. It is
 * already a validated single path segment with a producer and a consumer that
 * agree, and a second spelling of "an unguessable sortable name" could only
 * drift from the first. What it identifies here is one authorisation event, not
 * a diagnostics run; the format is what is borrowed.
 */
export function newHeadPublicationAuditEventId(now: Date): string {
  return newRunId(now);
}

/**
 * Every way recording can end. A closed set, and exactly one of them wrote.
 *
 * The members are apart because the remedies are: folding them into one "audit
 * failed" would tell a person the same thing about conditions that need
 * different things done to them. Each carries its own sentence below, and there
 * is deliberately no tally here — a count beside an enumeration is the shape
 * this repository has already had to correct more than once.
 *
 * There is deliberately **no** `ALREADY_RECORDED`. In a receipt store that
 * member is an idempotency claim; here a record already at the name is a
 * refusal, because a record that licensed the effect would be the replay this
 * slice exists to forbid.
 */
export const HEAD_PUBLICATION_AUDIT_CODES = [
  /** Written, flushed, and read back as this event's record. */
  'RECORDED',
  /** The OS could not be asked where the user profile is, so there is no store. */
  'PROFILE_UNAVAILABLE',
  /** The event name this build produced is not one it would accept as a segment. */
  'EVENT_ID_UNSUITABLE',
  /** A symlink or junction sits on the store's path. Never written through. */
  'STORE_PATH_UNSAFE',
  /** The store root or the event directory could not be created. */
  'STORE_UNAVAILABLE',
  /** An event directory of this name already exists. Never reused. */
  'EVENT_NAME_TAKEN',
  /** The record this build produced is larger than it will read back. */
  'RECORD_TOO_LARGE',
  /** The record this build produced is not one it would accept back. */
  'RECORD_CONTRACT_VIOLATION',
  /** The write did not complete. Nothing on disk is this event's record. */
  'WRITE_FAILED',
  /** The bytes could not be read back at all. */
  'READBACK_FAILED',
  /** The bytes read back are not the ones this invocation intended. */
  'READBACK_MISMATCH',
] as const;

export type HeadPublicationAuditCode = (typeof HEAD_PUBLICATION_AUDIT_CODES)[number];

export interface HeadPublicationAuditResult {
  readonly code: HeadPublicationAuditCode;
  /** `true` only after a complete write, a flush and a matching read-back. */
  readonly recorded: boolean;
  /** The event identity this invocation used. Always present. */
  readonly eventId: string;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

function outcome(
  code: HeadPublicationAuditCode,
  eventId: string,
  errnoCode: string | null = null,
): HeadPublicationAuditResult {
  return Object.freeze({ code, recorded: code === 'RECORDED', eventId, errnoCode });
}

/**
 * Every fact one record binds, supplied by the caller and never derived here.
 *
 * This module builds no identity of its own. It is handed the exact subject the
 * authority was proved against and writes that down; a store that re-resolved
 * anything would be recording its own second opinion rather than the event.
 */
export interface HeadPublicationAuditRequest {
  readonly eventId: string;
  readonly taskId: string;
  /** The canonical local root. Two clones of one project are two of these. */
  readonly repositoryRoot: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** The local remote name the publication addresses. Never a URL. */
  readonly declaredRemote: string;
  readonly ref: string;
  readonly commit: string;
  /** SHA-256 of the exact declaration bytes the permission was graded from. */
  readonly declarationDigest: string;
  /** When the permission was graded. Not freshness — see the record's header. */
  readonly authorisedAt: string;
  readonly pathProvider?: PathProvider | undefined;
  /**
   * The rename that publishes the bytes. Production uses the real one.
   *
   * Injectable for the reason `state/atomic-file.ts` gives about its own: the
   * guarantees this module exists to provide — that a write which did not
   * complete refuses, and that bytes which came back wrong refuse — cannot be
   * observed on demand against a real filesystem, because neither can be
   * provoked reliably.
   */
  readonly replace?: ReplaceFn | undefined;
  readonly tempSuffix?: TempSuffixFn | undefined;
}

/**
 * The permission member a record may name.
 *
 * A constant rather than a parameter, and the reason is the grader's shape:
 * `permitsUnattendedHeadPublication` answers `ALLOWED` from an exhaustive switch
 * with exactly one arm, so an `ALLOWED` answer *is* this member and nothing else
 * could have produced it. A caller passing the member in could pass a different
 * one; deriving it here from a fact about the code cannot. A third member added
 * to the declaration vocabulary makes that switch a compile error, which is
 * where the question would have to be answered again.
 */
const RECORDED_PERMISSION = 'AUTOMATIC_ALLOWED' as const;

/** The declaration contract version a record is written against. */
const RECORDED_DECLARATION_SCHEMA_VERSION = 1 as const;

/**
 * How the exclusive directory creation's answers become this store's.
 *
 * Total by type over {@link RunDirectoryCode}, so a member added to that
 * vocabulary is a compile error here rather than a code that falls past a switch
 * and lets the write proceed into a directory nobody established. `null` is the
 * one answer that continues.
 */
const DIRECTORY_REFUSAL: Readonly<Record<RunDirectoryCode, HeadPublicationAuditCode | null>> =
  Object.freeze({
    CREATED: null,
    INVALID_RUN_ID: 'EVENT_ID_UNSUITABLE',
    PATH_ESCAPES_RUNS_ROOT: 'EVENT_ID_UNSUITABLE',
    PATH_CONTAINS_LINK: 'STORE_PATH_UNSAFE',
    RUN_DIRECTORY_EXISTS: 'EVENT_NAME_TAKEN',
    RUNS_ROOT_CREATE_FAILED: 'STORE_UNAVAILABLE',
    RUN_DIRECTORY_CREATE_FAILED: 'STORE_UNAVAILABLE',
  });

/**
 * Reads back exactly what is on disk at `path`, or `null` when it cannot.
 *
 * Opened by name and `fstat`ed rather than `stat`ed: on Windows a directory
 * opens successfully and reports size zero, so without the file test a directory
 * would read as an empty file — the right answer reached by accident.
 */
function readRecordBytes(path: string): Buffer | null {
  let handle: number;
  try {
    handle = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES) return null;
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
 * Writes one authorisation record, or refuses — and refusing is the whole point.
 *
 * The order is the contract. The record is built and graded **before** any
 * filesystem effect, so a caller whose facts cannot make a readable record
 * causes no directory to be created; and the bytes are read back off the disk
 * **before** this returns, so "recorded" is a statement about the disk rather
 * than about a function that returned.
 *
 * Nothing here decides whether a publication may happen. It reports what it did,
 * and the caller — which is the only module that holds the publication authority
 * — decides what a refusal means. This module imports no grant, mints nothing,
 * and is never consulted about permission.
 */
export function recordHeadPublicationAuthorisation(
  request: HeadPublicationAuditRequest,
): HeadPublicationAuditResult {
  const subject: HeadPublicationAuthorisationSubject = Object.freeze({
    eventId: request.eventId,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
  });

  const payload: HeadPublicationAuthorisationPayload = Object.freeze({
    authorisationVersion: HEAD_PUBLICATION_AUTHORISATION_VERSION as 1,
    eventId: request.eventId,
    act: 'HEAD_PUBLICATION' as const,
    invocationMode: 'AUTOMATIC' as const,
    taskId: request.taskId,
    repositoryRoot: request.repositoryRoot,
    host: request.host,
    owner: request.owner,
    name: request.name,
    declaredRemote: request.declaredRemote,
    ref: request.ref,
    commit: request.commit,
    declarationSchemaVersion: RECORDED_DECLARATION_SCHEMA_VERSION,
    declaredPermission: RECORDED_PERMISSION,
    declarationDigest: request.declarationDigest,
    authorisedAt: request.authorisedAt,
  });

  const bytes = Buffer.from(
    `${JSON.stringify(
      { ...payload, binding: headPublicationAuthorisationBinding(subject, payload) },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // ── 1. The record this build produced, judged before anything is created ──
  if (bytes.byteLength > MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES) {
    return outcome('RECORD_TOO_LARGE', request.eventId);
  }
  if (readHeadPublicationAuthorisation(bytes, subject) !== 'HISTORICAL_AUTHORISATION') {
    return outcome('RECORD_CONTRACT_VIOLATION', request.eventId);
  }

  // ── 2. Where it goes ──────────────────────────────────────────────────────
  let root: string;
  try {
    root = headPublicationAuditRoot(request.pathProvider ?? OS_PATH_PROVIDER);
  } catch {
    // The profile resolver throws rather than guessing, and its message is
    // already value-free. It is dropped here regardless.
    return outcome('PROFILE_UNAVAILABLE', request.eventId);
  }

  // ── 3. One directory, created exclusively ─────────────────────────────────
  const directory = createRunDirectory({ runsRoot: root, runId: request.eventId });
  const refusal = DIRECTORY_REFUSAL[directory.code];
  if (refusal !== null) return outcome(refusal, request.eventId, directory.errnoCode);

  // ── 4. The bytes ──────────────────────────────────────────────────────────
  const written = writeFileAtomically({
    directory: directory.path,
    fileName: HEAD_PUBLICATION_AUDIT_FILE_NAME,
    contents: bytes,
    // Spread rather than passed, because the primitive's optional fields are
    // declared without `| undefined` and this build compiles under
    // `exactOptionalPropertyTypes`. Absent means absent.
    ...(request.replace === undefined ? {} : { replace: request.replace }),
    ...(request.tempSuffix === undefined ? {} : { tempSuffix: request.tempSuffix }),
  });
  if (written.code !== 'WRITTEN') {
    return outcome('WRITE_FAILED', request.eventId, written.errnoCode);
  }

  // ── 5. The disk, not the return value ─────────────────────────────────────
  const stored = readRecordBytes(join(directory.path, HEAD_PUBLICATION_AUDIT_FILE_NAME));
  if (stored === null) return outcome('READBACK_FAILED', request.eventId);
  // One comparison, not two, and the chain is why. Step 1 already graded these
  // exact bytes as this event's record, so "the disk holds these bytes" and
  // "the disk holds a record this build reads as this event's" are the same
  // sentence. Grading the bytes again here would be a second check that cannot
  // fail while this one passes — a redundancy that reads as coverage and is not.
  if (!stored.equals(bytes)) return outcome('READBACK_MISMATCH', request.eventId);

  return outcome('RECORDED', request.eventId);
}
