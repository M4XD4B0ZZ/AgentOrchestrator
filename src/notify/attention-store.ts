/**
 * The durable operator-attention outbox (M3-02).
 *
 * ── What a record is ───────────────────────────────────────────────────────
 *
 * One file per open item, named after what the item is *about*. A record says:
 * this repository's task stands in a state no machine can move, here is the
 * reason, and here is what a person has to do. Nothing else. It is not a log,
 * not a history and not a receipt — an item exists exactly while its condition
 * does, and {@link settleAttentionRecords}' caller removes it when it stops.
 *
 * ── The filesystem is the deduplication ────────────────────────────────────
 *
 * The whole concurrency design is one call: `linkSync(staging, target)`. The
 * target name is a digest of the condition, so two processes that find the same
 * condition derive the same name; the kernel gives the link to exactly one of
 * them and tells the other `EEXIST`. There is no read-then-write, no lock, no
 * counter and no lost update, and "already recorded" and "somebody else recorded
 * it" are the same answer because they are the same fact.
 *
 * **`link`, and not `openSync(target, 'wx')`.** The exclusive open was the first
 * design and it has a hole a review found before this shipped: it takes the name
 * *before* the bytes are written, so a process that dies in between leaves a
 * zero-byte file at the record's own name. The listing then counts it unreadable
 * and every later pass is told `ALREADY_RECORDED`, so that one notification is
 * suppressed for ever and only a human deleting the file can bring it back. The
 * window is microseconds and the consequence is permanent, which is the shape
 * this build does not accept.
 *
 * Writing the whole record to a staging name first and then `link`ing it closes
 * it, because `link` is atomic and refuses an existing target: the record's own
 * name never exists holding a partial document. A crash before the link leaves
 * an orphan staging file and *no* record, so the next pass re-derives the
 * condition and writes it again — a delay, which is the direction to fail in. A
 * crash after it leaves an orphan staging file beside a complete record, which
 * the listing recognises as this build's own and ignores.
 *
 * Measured on this platform rather than assumed: `link` inside one directory of
 * the orchestrator home creates a second name for complete content, survives the
 * staging name being unlinked, and refuses a second link with `EEXIST`.
 *
 * That is why the id is content-derived rather than a fresh uuid, and it is the
 * one place this store deliberately departs from
 * `deliver/head-publication-authorisation-store.ts`, which it otherwise
 * follows. That store records *events*, so two of them are two records and a
 * random id is right. This one records *conditions*, so two findings of one
 * condition are one record.
 *
 * ── Written without a lease, on purpose ────────────────────────────────────
 *
 * The outbox is settled between coordinator passes, holding nothing. That is not
 * a gap in the authority model: the record is not authority for anything. No
 * lifecycle decision reads it, no resume consults it, and deleting the whole
 * directory costs an operator a re-notification on the next pass and nothing
 * else. The execution lease governs what may *change a repository*; this changes
 * no repository.
 *
 * ── What may be written down ───────────────────────────────────────────────
 *
 * Validated ids, closed vocabulary codes, ISO instants the state contract
 * already validated, and one action sentence chosen from
 * `core/task-attention.ts`'s fixed table. No agent output, no verifier output,
 * no exception text, no command line, no token. The repository *root* is here
 * and is the one filesystem path in the document: the store sits outside every
 * repository, so a record that could not say where it came from would be
 * useless, and it never leaves this machine — see
 * `notify/attention-notification.ts` for what a *push* is allowed to carry,
 * which is strictly less.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { safeErrnoCode } from '../core/safe-error.js';
import {
  RUN_ATTENTION_JUDGED_CONDITIONS,
  RUN_ATTENTION_REASONS,
  type RunAttentionReason,
} from '../core/run-attention.js';
import { ATTENTION_REASONS, type AttentionReason } from '../core/task-attention.js';
import { ALL_STATES, type TaskStateName } from '../core/states.js';
import { USAGE_LIMIT_CONTINUATION_READINGS } from '../core/usage-limit-continuation.js';
import { isContained, pathContainsLink } from '../doctor/safe-write.js';
import {
  attentionDeliveryPath,
  attentionIdOf,
  attentionStagingName,
  deliveredAttentionIdOf,
  isAttentionFileName,
  isAttentionStagingName,
  operatorAttentionPath,
  operatorAttentionRoot,
} from './internal/attention-location.js';

/** The document version. One field, first, so a later shape is refusable. */
export const ATTENTION_RECORD_VERSION = 1;

/**
 * The largest record this build will write or read back.
 *
 * Every field is bounded by its own contract already — ids by their grammars,
 * codes by closed vocabularies, the action by a fixed table — so this is the
 * floor under a file somebody else put in the directory, not a budget any
 * record of ours approaches.
 */
export const MAX_ATTENTION_RECORD_BYTES = 8192;

/**
 * The fields both subjects carry, and they mean the same thing in both.
 *
 * Split out rather than repeated so that "every record names a repository, an
 * id, a reason, an instant and an action" is one statement in one place. A
 * second copy is how the two halves start disagreeing about `observedAt`.
 */
const commonFields = {
  attentionVersion: z.literal(ATTENTION_RECORD_VERSION),
  attentionId: z.string().regex(/^[0-9a-f]{32}$/),
  repositoryId: z.string().min(1),
  repositoryRoot: z.string().min(1),
  /** When this item was first written down. Not part of the identity. */
  observedAt: z.string().min(1),
  action: z.string().min(1),
} as const;

/**
 * A record about one **task**, unchanged from M3-02 down to the field names.
 *
 * `subject` is new and is the only addition. It is not redundant with the
 * presence of `taskId`: a reader that decided the kind by sniffing which
 * optional fields were present would be inferring the contract instead of
 * reading it, and the first record that gained a field would break the sniff.
 */
const TaskAttentionRecordSchema = z
  .object({
    ...commonFields,
    subject: z.literal('TASK'),
    taskId: z.string().min(1),
    state: z.enum(ALL_STATES),
    reason: z.enum(ATTENTION_REASONS),
    detail: z.enum(USAGE_LIMIT_CONTINUATION_READINGS).nullable(),
    /** The instant the task entered this state. Part of the identity. */
    stateEnteredAt: z.string().min(1),
    /** The reset the diagnosis mentions, when there is one. */
    reportedResetAt: z.string().min(1).nullable(),
  })
  .strict();

/**
 * A record about a **repository**, for a condition no task record was written
 * for (`U3`, `L-M3-F-3`).
 *
 * It carries no `taskId` and no `state` — not `null` versions of them, no field
 * at all — because `.strict()` then makes "a repository record that names a task
 * state" unrepresentable rather than merely discouraged. That is the same reason
 * `core/task-attention.ts` discriminates its judgement instead of pairing a
 * disposition with an optional action.
 *
 * `condition` is the exact lifecycle outcome, or `RUN_THREW`. It is closed
 * vocabulary, never a message: an exception's text is not a document field.
 */
const RepositoryAttentionRecordSchema = z
  .object({
    ...commonFields,
    subject: z.literal('REPOSITORY'),
    condition: z.enum(RUN_ATTENTION_JUDGED_CONDITIONS as readonly [string, ...string[]]),
    reason: z.enum(RUN_ATTENTION_REASONS),
  })
  .strict();

const AttentionRecordSchema = z.discriminatedUnion('subject', [
  TaskAttentionRecordSchema,
  RepositoryAttentionRecordSchema,
]);

export type TaskAttentionRecord = z.infer<typeof TaskAttentionRecordSchema>;
export type RepositoryAttentionRecord = z.infer<typeof RepositoryAttentionRecordSchema>;
export type AttentionRecord = z.infer<typeof AttentionRecordSchema>;

/** Every way writing one record can end. A closed set. */
export const ATTENTION_WRITE_CODES = [
  /** Created by this call. The one code that means "say it out loud too". */
  'RECORDED',
  /**
   * The name was already taken, so this condition has already been written
   * down — by an earlier pass, or by another process a moment ago. Not a
   * failure: it is the deduplication working.
   */
  'ALREADY_RECORDED',
  /** The record this build built does not satisfy its own contract. */
  'RECORD_CONTRACT_VIOLATION',
  /** The record is larger than {@link MAX_ATTENTION_RECORD_BYTES}. */
  'RECORD_TOO_LARGE',
  /** The OS profile could not be resolved, so there is no store root. */
  'PROFILE_UNAVAILABLE',
  /** The store root could not be created, or is reached through a link. */
  'STORE_UNAVAILABLE',
  /** The file was created and did not receive all of its bytes. */
  'WRITE_FAILED',
] as const;

export type AttentionWriteCode = (typeof ATTENTION_WRITE_CODES)[number];

export interface AttentionWriteResult {
  readonly code: AttentionWriteCode;
  readonly attentionId: string;
  /** An allow-listed errno, or `null`. Never a message. */
  readonly errnoCode: string | null;
}

const wrote = (
  code: AttentionWriteCode,
  attentionId: string,
  errnoCode: string | null = null,
): AttentionWriteResult => Object.freeze({ code, attentionId, errnoCode });

/**
 * Creates the store root if it is not there, and refuses a linked path.
 *
 * `recursive: true` on the root itself is right and is not the exclusive create
 * that matters: the exclusivity this store depends on is on the *file*, one call
 * down. A shared directory that already exists is the ordinary case here, unlike
 * the per-event directories `deliver/` creates.
 */
function ensureRoot(root: string): AttentionWriteCode | null {
  if (pathContainsLink(root)) return 'STORE_UNAVAILABLE';
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    void error;
    return 'STORE_UNAVAILABLE';
  }
  // Re-checked after creation, for the reason `doctor/run-directory.ts` gives:
  // a racing writer could have planted a link in between.
  if (pathContainsLink(root)) return 'STORE_UNAVAILABLE';
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error: unknown) {
    void error;
    return 'STORE_UNAVAILABLE';
  }
  return stats.isDirectory() && !stats.isSymbolicLink() ? null : 'STORE_UNAVAILABLE';
}

/**
 * Writes one record if nothing has written it already.
 *
 * Never throws: every failure is a return value, because this is called from a
 * scheduler loop whose answer about the repositories must not be rewritten by
 * the outbox failing to record something.
 */
export function writeAttentionRecord(
  record: AttentionRecord,
  provider: PathProvider = OS_PATH_PROVIDER,
): AttentionWriteResult {
  // The record this build produced, judged before anything is created — the
  // ordering `deliver/head-publication-authorisation-store.ts` uses, and for the
  // same reason: a document that would not read back is not worth a file.
  const parsed = AttentionRecordSchema.safeParse(record);
  if (!parsed.success) return wrote('RECORD_CONTRACT_VIOLATION', record.attentionId);

  const bytes = Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_ATTENTION_RECORD_BYTES) {
    return wrote('RECORD_TOO_LARGE', record.attentionId);
  }

  let root: string;
  let target: string;
  try {
    root = operatorAttentionRoot(provider);
    target = operatorAttentionPath(record.attentionId, provider);
  } catch {
    // The profile resolver throws rather than guessing. Its message is already
    // value-free and is dropped regardless.
    return wrote('PROFILE_UNAVAILABLE', record.attentionId);
  }

  // Belt and braces: the id has passed the schema's grammar, and the derived
  // path is proven to have stayed inside the root all the same.
  if (!isContained(root, target)) return wrote('STORE_UNAVAILABLE', record.attentionId);

  const rootRefusal = ensureRoot(root);
  if (rootRefusal !== null) return wrote(rootRefusal, record.attentionId);

  // ── 1. the whole record, under a name nothing reads ────────────────────
  const staging = join(
    root,
    attentionStagingName(
      record.attentionId,
      `${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`,
    ),
  );

  let handle: number;
  try {
    // `wx` here too, though the name is unique: a staging file this call did not
    // create is one it may not write into or delete.
    handle = openSync(staging, 'wx', 0o600);
  } catch (error: unknown) {
    return wrote('STORE_UNAVAILABLE', record.attentionId, safeErrnoCode(error));
  }

  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(handle, bytes, offset, bytes.length - offset);
      if (written <= 0) break;
      offset += written;
    }
    if (offset !== bytes.length) {
      closeSync(handle);
      discard(staging);
      return wrote('WRITE_FAILED', record.attentionId);
    }
    try {
      fsyncSync(handle);
    } catch {
      // Not every filesystem flushes on demand. `doctor/safe-write.ts` records
      // the same concession; a record that reads back is what matters here.
    }
    closeSync(handle);
  } catch (error: unknown) {
    const errnoCode = safeErrnoCode(error);
    try {
      closeSync(handle);
    } catch {
      /* the failure code is already decided */
    }
    discard(staging);
    return wrote('WRITE_FAILED', record.attentionId, errnoCode);
  }

  // ── 2. the name, atomically, or the answer that somebody else has it ────
  //
  // No prior existence check: `link` asks the kernel to create the name *or*
  // fail, in one step, which is the only race-free way to ask — and the failure
  // is the answer this store wants rather than an error. The content is already
  // complete and flushed, so the record's own name never exists holding a
  // partial document.
  try {
    linkSync(staging, target);
  } catch (error: unknown) {
    const errnoCode = safeErrnoCode(error);
    discard(staging);
    return errnoCode === 'EEXIST'
      ? wrote('ALREADY_RECORDED', record.attentionId)
      : wrote('STORE_UNAVAILABLE', record.attentionId, errnoCode);
  }

  // Best effort, and only ever this call's own staging name. A leftover is
  // inert: the listing recognises it as this build's and ignores it.
  discard(staging);
  return wrote('RECORDED', record.attentionId);
}

/** Removes a staging file this call created. Never throws, never recursive. */
function discard(staging: string): void {
  try {
    unlinkSync(staging);
  } catch {
    // A staging file that will not go away is inert. Reporting it would be
    // reporting a leftover as a failure of the record, which succeeded.
  }
}

/** What one entry in the directory turned out to be. */
export const ATTENTION_ENTRY_READINGS = [
  /** A record this build wrote and can read back. */
  'RECORD',
  /** A name this build would not have written. Left alone and counted. */
  'FOREIGN_NAME',
  /** The right name, and the bytes are not a record. Left alone and counted. */
  'UNREADABLE',
] as const;

export type AttentionEntryReading = (typeof ATTENTION_ENTRY_READINGS)[number];

export interface AttentionListing {
  readonly records: readonly AttentionRecord[];
  /**
   * The ids that carry a delivery receipt: this item reached a configured
   * endpoint and the endpoint acknowledged it (`U2`, M4).
   *
   * Ids rather than a flag on each record, because a receipt can outlive the
   * moment its record was read and because a receipt for an id no record is
   * listed under is a real state — a record removed between the two reads. The
   * caller that cares about the pairing does the pairing.
   *
   * The **complement** is what makes silence mean something: an item that is in
   * `records` and not in `delivered` was written down and never acknowledged by
   * anybody, which is a fact on disk rather than the absence of one.
   */
  readonly delivered: readonly string[];
  /** Names present that this build did not write or could not read. */
  readonly foreignNames: number;
  readonly unreadable: number;
  /**
   * This build's own staging leftovers: a complete record that never got its
   * name because the process writing it died in between. Inert, and counted
   * rather than reported, so an operator is not sent to look at something
   * harmless.
   */
  readonly staging: number;
  /** `true` when the store root is simply not there. Not an error. */
  readonly absent: boolean;
  /** The root could not be enumerated for some other reason. */
  readonly unreadableRoot: boolean;
}

/**
 * Everything currently in the outbox.
 *
 * Never throws. An absent root is the ordinary answer on a machine where nothing
 * has ever needed an operator, and is reported as `absent` rather than as a
 * failure — the distinction `doctor/` already makes about its own runs root.
 *
 * A file it cannot read is counted and skipped rather than removed. This store
 * deletes only records whose condition it has positively re-derived; anything
 * else in the directory belongs to somebody, and guessing whose is what this
 * build does not do.
 */
export function listAttentionRecords(
  provider: PathProvider = OS_PATH_PROVIDER,
): AttentionListing {
  const empty = {
    records: Object.freeze([]),
    delivered: Object.freeze([]),
    foreignNames: 0,
    unreadable: 0,
    staging: 0,
    absent: true,
    unreadableRoot: false,
  };

  let root: string;
  try {
    root = operatorAttentionRoot(provider);
  } catch {
    return Object.freeze({ ...empty, absent: false, unreadableRoot: true });
  }

  let names: readonly string[];
  try {
    names = readdirSync(root);
  } catch (error: unknown) {
    const absent = safeErrnoCode(error) === 'ENOENT';
    return Object.freeze({ ...empty, absent, unreadableRoot: !absent });
  }

  const records: AttentionRecord[] = [];
  const delivered: string[] = [];
  let foreignNames = 0;
  let unreadable = 0;
  let staging = 0;

  // Sorted so that a truncation or a report is a property of the names rather
  // than of the filesystem's enumeration order.
  for (const name of [...names].sort()) {
    // This build's own leftovers, and neither a record nor foreign. One is left
    // by a process that died between writing a record and giving it its name;
    // it holds no name anybody reads, so it is invisible rather than a problem.
    if (isAttentionStagingName(name)) {
      staging += 1;
      continue;
    }
    // A delivery receipt. Its content is never read - the file existing *is* the
    // fact, which is why it is written empty and why a torn write cannot make it
    // say the wrong thing.
    const deliveredId = deliveredAttentionIdOf(name);
    if (deliveredId !== null) {
      delivered.push(deliveredId);
      continue;
    }
    if (!isAttentionFileName(name)) {
      foreignNames += 1;
      continue;
    }
    const path = operatorAttentionPath(attentionIdOf(name) ?? '', provider);
    let raw: string;
    try {
      // Refused before reading, for the reason `state-store.ts` gives: on
      // Windows a directory opens and reads as zero bytes, which would parse as
      // nothing and be reported as a broken record rather than as a directory.
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > MAX_ATTENTION_RECORD_BYTES) {
        unreadable += 1;
        continue;
      }
      raw = readFileSync(path, 'utf8');
    } catch {
      unreadable += 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unreadable += 1;
      continue;
    }
    const record = AttentionRecordSchema.safeParse(parsed);
    // The name is the identity, so a record whose own `attentionId` disagrees
    // with the file it is in is not this record — it is a document that has been
    // moved or edited, and it is left alone.
    if (!record.success || record.data.attentionId !== attentionIdOf(name)) {
      unreadable += 1;
      continue;
    }
    records.push(record.data);
  }

  return Object.freeze({
    records: Object.freeze(records),
    delivered: Object.freeze(delivered),
    foreignNames,
    unreadable,
    staging,
    absent: false,
    unreadableRoot: false,
  });
}

/** Every way removing one record can end. */
export const ATTENTION_REMOVAL_CODES = ['REMOVED', 'ALREADY_GONE', 'REMOVAL_FAILED'] as const;

export type AttentionRemovalCode = (typeof ATTENTION_REMOVAL_CODES)[number];

/**
 * Removes one record, by id.
 *
 * `ALREADY_GONE` rather than a failure when it is not there: two processes
 * settling the same resolved condition is the expected case, and both of them
 * are right.
 *
 * Never recursive and never a pattern: one derived path, one `rm`. A store that
 * could delete a directory tree is a store that can delete the wrong one.
 */
export function removeAttentionRecord(
  attentionId: string,
  provider: PathProvider = OS_PATH_PROVIDER,
): AttentionRemovalCode {
  let root: string;
  let target: string;
  try {
    root = operatorAttentionRoot(provider);
    target = operatorAttentionPath(attentionId, provider);
  } catch {
    return 'REMOVAL_FAILED';
  }
  if (!isContained(root, target)) return 'REMOVAL_FAILED';

  // The receipt goes with the record, and it goes **first**.
  //
  // This used to run after the record was unlinked, with a comment that argued
  // for the opposite order and then did not take it. The argument was right. A
  // receipt outliving its record is read by the next listing as "delivered", and
  // a REPOSITORY-subject identity digests no instant (`repositoryAttentionIdFor`
  // takes root, condition and reason and deliberately no time) - so when the
  // same condition recurs it re-uses the same name, the re-raised item is born
  // already acknowledged, and it is **never sent again**, for as long as the
  // orphan survives. Two ways to orphan one: the process dies between the two
  // unlinks, or the receipt unlink fails for anything but ENOENT, which on this
  // build's Windows/NTFS contract is an indexer or a scanner holding a file.
  //
  // Reversed, the surviving failure is a record with no receipt: it is offered
  // again, which is at worst one duplicate push and is the failure this module's
  // header already names as the acceptable one - "a removal that does not happen
  // is a stale item, which is noise rather than silence". Not even that, usually:
  // `settleAttention` derives what to announce from the conditions that are true
  // *now*, so a record left behind by a failed unlink whose condition has
  // cleared is not announced at all.
  //
  // Its own outcome is deliberately not reported: this function answers about
  // the record, and a caller counting resolutions must not be told a different
  // number because a receipt was already gone.
  discardDeliveryReceipt(attentionId, provider);

  let code: AttentionRemovalCode;
  try {
    rmSync(target, { force: false, recursive: false });
    code = 'REMOVED';
  } catch (error: unknown) {
    code = safeErrnoCode(error) === 'ENOENT' ? 'ALREADY_GONE' : 'REMOVAL_FAILED';
  }
  return code;
}

/** Removes one delivery receipt, best effort. Never throws, never reports. */
function discardDeliveryReceipt(attentionId: string, provider: PathProvider): void {
  try {
    const root = operatorAttentionRoot(provider);
    const receipt = attentionDeliveryPath(attentionId, provider);
    if (!isContained(root, receipt)) return;
    rmSync(receipt, { force: true, recursive: false });
  } catch {
    // Swallowed, and the cost is stated as it really is rather than softened.
    // For a TASK item it is one suppressed re-send: the identity carries
    // `stateEnteredAt`, so a re-entry is a different name and is announced. For
    // a REPOSITORY item there is no instant in the identity, so every future
    // occurrence of that condition on that root re-uses this name and stays
    // silent while the file survives.
    //
    // It is still not worth failing on: the record has not been removed yet at
    // this point, so returning early would leave a record *and* a receipt, which
    // is the same silence plus a stale item. The removal continues, and the next
    // successful resolution of the same condition tries this unlink again.
  }
}

/** Every way marking one item delivered can end. A closed set. */
export const ATTENTION_DELIVERY_CODES = [
  /** The receipt was created by this call. */
  'MARKED',
  /**
   * A receipt was already there. Not a failure: two processes that both
   * delivered the same item are both right, and the fact is the same fact.
   */
  'ALREADY_MARKED',
  /** No receipt exists and none could be created. The item stays undelivered. */
  'MARK_FAILED',
] as const;

export type AttentionDeliveryCode = (typeof ATTENTION_DELIVERY_CODES)[number];

/**
 * Records that one item reached a configured endpoint and was acknowledged.
 *
 * Written **only** after a transport reported success, and that is the whole of
 * what a receipt claims: an endpoint took it. It is not a claim that a person
 * read it, and nothing in this build ever makes that claim.
 *
 * The file is empty, and empty is a design decision rather than laziness. The
 * fact is carried by the name existing, so there is no content a torn write
 * could corrupt into a different answer - which is the one failure mode a
 * two-file scheme could otherwise have that the single-record scheme does not.
 *
 * Never throws: this is called from a scheduler loop whose answer about the
 * repositories must not be rewritten by a receipt failing to be written. A
 * failed mark costs one duplicate push on the next cycle, which is the direction
 * to fail in - the alternative is an item recorded as delivered that was not.
 */
export function markAttentionDelivered(
  attentionId: string,
  provider: PathProvider = OS_PATH_PROVIDER,
): AttentionDeliveryCode {
  let root: string;
  let target: string;
  try {
    root = operatorAttentionRoot(provider);
    target = attentionDeliveryPath(attentionId, provider);
  } catch {
    return 'MARK_FAILED';
  }
  if (!isContained(root, target)) return 'MARK_FAILED';
  const rootRefusal = ensureRoot(root);
  if (rootRefusal !== null) return 'MARK_FAILED';

  // `wx`, so two processes that delivered the same item do not both claim to
  // have created the receipt - the same exclusive-create discipline the record
  // itself uses, and for the same reason.
  try {
    closeSync(openSync(target, 'wx', 0o600));
    return 'MARKED';
  } catch (error: unknown) {
    return safeErrnoCode(error) === 'EEXIST' ? 'ALREADY_MARKED' : 'MARK_FAILED';
  }
}

/** The state vocabulary the record schema accepts, exported for the suite. */
export const ATTENTION_RECORD_STATES: readonly TaskStateName[] = ALL_STATES;

/** The reason vocabulary the record schema accepts, exported for the suite. */
export const ATTENTION_RECORD_REASONS: readonly AttentionReason[] = ATTENTION_REASONS;
