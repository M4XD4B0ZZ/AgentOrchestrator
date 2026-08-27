/**
 * Reading the unattended-publication authorisation store, for a person
 * (V4 slice 15).
 *
 * Slice 14 gave this build somewhere to write down what it was authorised to
 * do before it did it, and left `L-V4-14-3` behind: nothing read the store, so
 * the only way to answer "why did that branch appear?" was to open a directory
 * by hand and know what a binding digest is. Evidence nobody can read is not
 * accountability. This module is the read.
 *
 * ── What it is, in one sentence ────────────────────────────────────────────
 *
 * > It reports what is in this operator profile's authorisation store **now**,
 * > entry by entry, and grades each entry with the same contract that wrote it.
 *
 * Everything below is a consequence of that sentence being the whole claim.
 *
 * ── Enumeration is the new capability, and the new hazard ──────────────────
 *
 * Slice 14 only ever opened one record, by a name it had just minted, inside a
 * directory it had just created exclusively. It never enumerated anything, and
 * its own crash table says so: "a reader opens by name and never enumerates, so
 * an event directory with no record in it is not a record."
 *
 * A listing cannot do that. It has to look at whatever is in the store, which
 * on a real machine includes what a crash left behind, what an operator dropped
 * there, and what anything else running as this OS user chose to put there. So
 * the direct children of the store root are **untrusted input**, and every one
 * of them is classified rather than assumed:
 *
 *  - a name this build would not mint is not an event, and is reported as an
 *    entry rather than skipped;
 *  - a symbolic link or a Windows junction is never followed. A record read
 *    through one would be evidence from somewhere else, filed under a name in
 *    the store — which is the one thing an accountability listing may not do;
 *  - an event directory with no record in it is `RECORD_ABSENT`, which is a
 *    crash artefact and not a record;
 *  - a record this build cannot read is reported as the kind of unreadable it
 *    is. `MALFORMED`, `UNSUPPORTED_VERSION` and a binding that does not hold
 *    are three different situations and send a person to three different
 *    places, so they stay apart.
 *
 * **Nothing is silently omitted.** An entry this build cannot interpret is
 * still listed, and it still changes the listing's own grade. The alternative —
 * skipping what cannot be read and printing the rest — produces a report that
 * looks complete and is not, which is worse than no report at all.
 *
 * And nothing is stopped at either. Events are independent: one damaged
 * directory says nothing about the twenty beside it, so a listing that gave up
 * at the first one would hide unrelated evidence for no gain. The listing
 * continues, and grades itself down.
 *
 * ── The order is this module's, never the filesystem's ─────────────────────
 *
 * Entries are sorted by their own names, ascending, by code unit. That is a
 * total order because names in one directory are unique, and it is the only
 * order every entry can be placed in: an entry this build cannot read supplies
 * no timestamp, and one it can read supplies a timestamp that came out of the
 * document rather than out of the filesystem.
 *
 * It is emphatically **not** the order the filesystem hands over. Measured on
 * this NTFS volume: `readdir` returns entries in the directory index's own
 * case-insensitive collation — `a-entry`, `B-entry`, `C-entry`, `Z-entry`,
 * `_under` — which is not the order this module prints and not an order any
 * other filesystem promises.
 *
 * For the names this build mints the sort is also chronological, because the
 * instant is fixed-width, zero-padded and leading. That is a property of the
 * *name*, and the name is not evidence: `authorisedAt` inside a record is what
 * says when something was established, and a name is only what a directory is
 * called.
 *
 * ── What it does not do ────────────────────────────────────────────────────
 *
 * It creates nothing — a missing store is an observation, not an invitation to
 * make one. It writes nothing, moves nothing and deletes nothing. It resolves
 * no repository, starts no Git, contacts no forge, takes no lease, reads no
 * task state and reads no declaration. The store names its own subjects, so a
 * historical authorisation stays readable after the checkout it was about has
 * been deleted, and after the declaration that permitted it has changed.
 *
 * That last one is a rule and not an accident: **a policy file edited today may
 * not change what yesterday's record means.** A listing that compared a record
 * against the current declaration would be answering a different question, and
 * would answer it wrongly for every record older than the last edit.
 *
 * ── It is a reader, and readers grant nothing ──────────────────────────────
 *
 * Nothing this module returns is an authority. There is no grant here, no
 * permission, no token and no opaque artefact; the result is plain data whose
 * good member is called `HISTORICAL_AUTHORISATION` for the same reason slice 14
 * named its own — a member called `AUTHORISED` is one somebody switches on.
 * The dependency direction is one-way and the suite pins it: the publication
 * path writes evidence, this module reads it, and no path runs the other way.
 */

import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { inspectLinkChain } from '../doctor/safe-write.js';
import { isValidRunId } from '../doctor/run-directory.js';
import {
  MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES,
  inspectHeadPublicationAuthorisation,
  type AuditedForgeAct,
  type AuditedInvocationMode,
  type HeadPublicationAuthorisation,
  type HeadPublicationAuthorisationReading,
} from './head-publication-authorisation.js';
// The location, and deliberately not the store: importing the writer to learn a
// directory name would put the exclusive `mkdir`, the staging write and the
// publishing `rename` into this module's own import closure, and "this command
// creates nothing" would stop being a fact about the graph.
import {
  HEAD_PUBLICATION_AUDIT_FILE_NAME,
  headPublicationAuditRoot,
} from './internal/head-publication-audit-location.js';

/**
 * What one direct child of the store root turned out to be. A closed set of
 * seven, of which exactly one means "a record this build read".
 *
 * The five that describe a record are the store's own reading vocabulary,
 * renamed with a `RECORD_` prefix and nothing else: they are answers about the
 * document, and the two remaining members are answers about the entry, which is
 * a different kind of fact. Deriving them from that vocabulary rather than
 * inventing a parallel one is deliberate — two spellings of "this record is
 * from a version I cannot read" could drift, and the one that drifted would be
 * the one an operator sees.
 */
export const HEAD_PUBLICATION_AUDIT_ENTRY_READINGS = [
  /**
   * An event directory holding a record this build read, whose binding holds
   * for the name that directory has.
   *
   * What that establishes is exactly what the record establishes and no more —
   * see `head-publication-authorisation.ts`. In particular it is not evidence
   * that a publication was attempted, that a ref exists, that this build made
   * one, or that the permission still stands.
   */
  'HISTORICAL_AUTHORISATION',
  /**
   * An event directory with nothing at the record's name.
   *
   * This is what a crash between the directory being created and the record
   * being renamed into place leaves behind — slice 14's crash table, row 3 —
   * and it is the permanent resting state of every refusal after the directory
   * was made, because that protocol deletes nothing, ever. An event directory
   * holding only a staging file is this member and not a record: the record's
   * own name is only ever created by the rename that completes the write, so a
   * file called `authorisation.json` is never a prefix of one.
   *
   * It is the absence of a record and never a record of absence.
   */
  'RECORD_ABSENT',
  /**
   * A file is at the record's name and holds no bytes at all.
   *
   * Deliberately not the same member as `RECORD_ABSENT`, and the difference is
   * the fact rather than the wording: the write protocol publishes by renaming a
   * complete staging file, so it cannot leave an empty one behind. Something
   * created this. Folding the two would tell a person the same thing about a
   * crash and about a file somebody made.
   */
  'RECORD_EMPTY',
  /**
   * Something is at the record's name and no bytes could be taken from it: it is
   * a link, it is not a regular file, or the read did not complete.
   */
  'RECORD_UNREADABLE',
  /** Bytes are there and are not a record this build declares. */
  'RECORD_MALFORMED',
  /** A record version this build does not know how to read. Refused, never guessed. */
  'RECORD_UNSUPPORTED_VERSION',
  /**
   * A well-formed record whose binding does not hold for the directory it sits
   * in: a field was edited without recomputing the digest, or the record was
   * copied out of another event.
   *
   * It is not an authenticity failure and must never be reported as one. There
   * is no key in this build, so a *recomputed* record reads as valid — see
   * `L-V4-14-2`.
   */
  'RECORD_NOT_THIS_EVENT',
  /**
   * Something in the store that this build does not read as an event directory:
   * not a directory, a link of any kind, a name this build would not mint, or
   * an entry it could not classify at all.
   *
   * Reported rather than skipped. The store is one directory under the
   * operator's profile and anything can be put in it; saying so is more honest
   * than a listing that quietly ignored whatever it did not recognise.
   */
  'UNRECOGNISED_ENTRY',
] as const;

export type HeadPublicationAuditEntryReading =
  (typeof HEAD_PUBLICATION_AUDIT_ENTRY_READINGS)[number];

/**
 * How a record reading this build refused becomes an entry reading.
 *
 * Total by type over the refusals, so a member added to the store's reading
 * vocabulary is a compile error here rather than an entry that quietly falls
 * through to something reassuring. The good member is deliberately absent: it
 * is the one answer that carries a record, so it is handled where the record is
 * still in hand rather than translated by a table that would have to drop it.
 */
const ENTRY_READING: Readonly<
  Record<
    Exclude<HeadPublicationAuthorisationReading, 'HISTORICAL_AUTHORISATION'>,
    Exclude<HeadPublicationAuditEntryReading, 'HISTORICAL_AUTHORISATION'>
  >
> = Object.freeze({
  // The grader answers `ABSENT` for exactly one input: zero bytes. It is only
  // ever handed bytes, so it can never mean "nothing at the name" — that answer
  // is established here, from the errno, before any bytes exist.
  ABSENT: 'RECORD_EMPTY',
  MALFORMED: 'RECORD_MALFORMED',
  UNSUPPORTED_VERSION: 'RECORD_UNSUPPORTED_VERSION',
  NOT_THIS_EVENT: 'RECORD_NOT_THIS_EVENT',
});

/**
 * One readable record, as this module hands it out.
 *
 * Every field of the stored document is here, and six of them are **renamed**.
 * That is not decoration: `mintHeadPublicationGrant` takes a structurally typed
 * `{host, owner, name, commit}` and the publication re-check seam takes
 * `{host, owner, name, remoteName, ref, commit}`, so a value carrying the
 * record's own field names is an argument either of them accepts. Measured,
 * with the real declarations: a view with the record's names compiles into the
 * mint; renaming one identity field is enough to make it a type error, and
 * renaming all of them is what keeps that true when a field is added later.
 *
 * Measured too, and the reason this is a rename rather than something cleverer:
 * a `unique symbol` brand, a branded `commit` string and a class with a
 * `#private` field were each tried against the mint's parameter and each was
 * **no defence at all** — excess properties do not break structural
 * assignability from a variable, and a `#private` field is nominal only when the
 * class is the target. Names are what work here.
 *
 * This is a view and not a second contract. It carries no field the record does
 * not have, adds no interpretation, and the suite pins the correspondence value
 * by value rather than key by key.
 */
export interface AuthorisedPublicationRecord {
  readonly authorisationVersion: number;
  /** The `eventId` the document carries. The name it is filed under is the entry's. */
  readonly recordedEventId: string;
  readonly act: AuditedForgeAct;
  readonly invocationMode: AuditedInvocationMode;
  readonly taskId: string;
  /** The local checkout the authorising invocation had resolved. Not resolved, stat'ed or followed here. */
  readonly repositoryRoot: string;
  readonly forgeHost: string;
  readonly forgeOwner: string;
  readonly forgeName: string;
  /** The **local** name of the remote. Never a URL. */
  readonly declaredRemote: string;
  readonly authorisedRef: string;
  readonly authorisedCommit: string;
  readonly declarationSchemaVersion: number;
  readonly declaredPermission: string;
  /** SHA-256 of the declaration's exact bytes, as they were when they were read. */
  readonly declarationDigest: string;
  /**
   * The instant the record says it was built.
   *
   * Displayed exactly as recorded and checked against nothing: the contract
   * bounds this as a string of at most 64 characters, so it is not established
   * to be a date, and nothing compares it with the instant in the event name.
   */
  readonly authorisedAt: string;
  readonly binding: string;
}

/**
 * The rename, one field at a time.
 *
 * Typed as a total map over the record's own keys, so a field added to the
 * record is a compile error here rather than a value that quietly stops being
 * shown. Completeness is all this proves — that the two sides carry the same
 * *values* is a separate question, and the suite asks it.
 */
const RECORD_FIELD: Readonly<
  Record<keyof HeadPublicationAuthorisation, keyof AuthorisedPublicationRecord>
> = Object.freeze({
  authorisationVersion: 'authorisationVersion',
  eventId: 'recordedEventId',
  act: 'act',
  invocationMode: 'invocationMode',
  taskId: 'taskId',
  repositoryRoot: 'repositoryRoot',
  host: 'forgeHost',
  owner: 'forgeOwner',
  name: 'forgeName',
  declaredRemote: 'declaredRemote',
  ref: 'authorisedRef',
  commit: 'authorisedCommit',
  declarationSchemaVersion: 'declarationSchemaVersion',
  declaredPermission: 'declaredPermission',
  declarationDigest: 'declarationDigest',
  authorisedAt: 'authorisedAt',
  binding: 'binding',
});

/** The map, exported so the suite can pin the correspondence rather than restate it. */
export const HEAD_PUBLICATION_AUDIT_RECORD_FIELD = RECORD_FIELD;

function view(record: HeadPublicationAuthorisation): AuthorisedPublicationRecord {
  return Object.freeze({
    authorisationVersion: record.authorisationVersion,
    recordedEventId: record.eventId,
    act: record.act,
    invocationMode: record.invocationMode,
    taskId: record.taskId,
    repositoryRoot: record.repositoryRoot,
    forgeHost: record.host,
    forgeOwner: record.owner,
    forgeName: record.name,
    declaredRemote: record.declaredRemote,
    authorisedRef: record.ref,
    authorisedCommit: record.commit,
    declarationSchemaVersion: record.declarationSchemaVersion,
    declaredPermission: record.declaredPermission,
    declarationDigest: record.declarationDigest,
    authorisedAt: record.authorisedAt,
    binding: record.binding,
  });
}

/**
 * One entry of the store, as this build reads it.
 *
 * The record is present on exactly one member and is `null` on every other, and
 * that is enforced by the type rather than by care: there is no way to reach a
 * field of a record this build refused, so an unreadable event's values cannot
 * be rendered as though they had been established.
 */
export type HeadPublicationAuditEntry =
  | {
      readonly reading: 'HISTORICAL_AUTHORISATION';
      /** The directory's own name. Always the name on disk, never a value from the record. */
      readonly name: string;
      readonly record: AuthorisedPublicationRecord;
    }
  | {
      readonly reading: Exclude<HeadPublicationAuditEntryReading, 'HISTORICAL_AUTHORISATION'>;
      readonly name: string;
      readonly record: null;
    };

/**
 * How the listing itself ended. A closed set of six.
 *
 * Two of them mean "the store was read", and they are apart because "everything
 * in it is a record I could read" and "something in it is not" are different
 * answers that a script must be able to tell apart. The other four each mean
 * **I could not establish what is recorded**, which is not the same sentence as
 * "nothing is recorded" and is deliberately not reachable from it.
 */
export const HEAD_PUBLICATION_AUDIT_LISTINGS = [
  /** The store was read, and every entry in it is a record this build read. Zero entries included. */
  'READ',
  /** The store was read, and at least one entry is not a record this build read. */
  'READ_WITH_UNUSABLE_ENTRIES',
  /**
   * There is no store under this profile.
   *
   * Nothing was created. This says the store is not there **now**: a store is an
   * ordinary directory and anything running as this OS user can remove it, so it
   * is never evidence that nothing was ever authorised. `L-V4-14-2`.
   */
  'STORE_ABSENT',
  /**
   * A symbolic link or a junction sits on the store's path, or a component of it
   * could not be inspected. Nothing was read through it.
   */
  'STORE_PATH_UNSAFE',
  /** Something is at the store's path and its contents could not be listed. */
  'STORE_UNREADABLE',
  /** The OS could not be asked where the user profile is, so there is no store to read. */
  'PROFILE_UNAVAILABLE',
] as const;

export type HeadPublicationAuditListingOutcome =
  (typeof HEAD_PUBLICATION_AUDIT_LISTINGS)[number];

export interface HeadPublicationAuditListing {
  readonly outcome: HeadPublicationAuditListingOutcome;
  /**
   * The store root this listing is about, or `null` when the profile could not
   * be resolved and there was therefore no path to name.
   */
  readonly root: string | null;
  /**
   * Every direct child of the store, in this module's own order. Empty on every
   * outcome except the two that read it, and empty is a valid reading there.
   */
  readonly entries: readonly HeadPublicationAuditEntry[];
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
}

function listing(
  outcome: HeadPublicationAuditListingOutcome,
  root: string | null,
  entries: readonly HeadPublicationAuditEntry[],
  errnoCode: string | null = null,
): HeadPublicationAuditListing {
  return Object.freeze({ outcome, root, entries: Object.freeze([...entries]), errnoCode });
}

/**
 * At most one byte past the contract's bound, read from `path`, or `null`.
 *
 * Opened by name and `fstat`ed rather than `stat`ed, for the reason the store's
 * own read-back gives: on Windows a directory opens successfully and reports
 * size zero, so without the file test a directory sitting at the record's name
 * would read as an empty file — `RECORD_ABSENT` reached by accident, about an
 * entry that is not absent at all. Measured, not assumed.
 *
 * The bound is applied by reading no further rather than by judging the size
 * here: whatever comes back goes to the contract's own grader, which is the one
 * place that decides what "too large to be a record" means. One byte past the
 * bound is enough for it to say so, and a file of any size costs the same read.
 */
function recordBytes(path: string): Buffer | null {
  let handle: number;
  try {
    handle = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) return null;
    const wanted = Math.min(stat.size, MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES + 1);
    const buffer = Buffer.alloc(wanted);
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
 * Classifies one direct child of the store root.
 *
 * The order of the tests is the contract. An entry is only opened once it has
 * been established to be a directory this build would have made, so a link is
 * never followed and a name this build could not have minted is never read
 * through.
 */
function classify(root: string, name: string): HeadPublicationAuditEntry {
  const unrecognised: HeadPublicationAuditEntry = {
    reading: 'UNRECOGNISED_ENTRY',
    name,
    record: null,
  };

  let entry;
  try {
    // `lstat` and never `stat`: a junction that resolves to a directory must be
    // refused for being a junction rather than accepted for what it points at.
    // Measured on this volume — a junction answers `isSymbolicLink()` true and
    // `isDirectory()` false, so one call settles both questions.
    entry = lstatSync(join(root, name));
  } catch {
    // An entry the filesystem named and would not describe. Refused, because
    // "this build could not classify it" is not "it is fine".
    return unrecognised;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) return unrecognised;

  // The name grammar is the producer's own, imported rather than restated, so a
  // build that changed what it mints cannot disagree with what it reads.
  if (!isValidRunId(name)) return unrecognised;

  const record = join(root, name, HEAD_PUBLICATION_AUDIT_FILE_NAME);

  let target;
  try {
    target = lstatSync(record);
  } catch (error) {
    // The one place absence is established, and it is established from the
    // errno rather than from a failure of any kind: `ENOENT` is a crash between
    // the directory and the rename, and anything else is a directory this build
    // could not ask about, which is not the same thing.
    return safeErrnoCode(error) === 'ENOENT'
      ? { reading: 'RECORD_ABSENT', name, record: null }
      : { reading: 'RECORD_UNREADABLE', name, record: null };
  }
  // A link at the record's name is never followed. Reading through one would
  // file somebody else's bytes under this event's name, which is the single
  // thing an accountability listing may not do.
  if (target.isSymbolicLink() || !target.isFile()) {
    return { reading: 'RECORD_UNREADABLE', name, record: null };
  }

  const bytes = recordBytes(record);
  if (bytes === null) return { reading: 'RECORD_UNREADABLE', name, record: null };

  const inspection = inspectHeadPublicationAuthorisation(bytes, name);
  if (inspection.reading === 'HISTORICAL_AUTHORISATION') {
    return { reading: 'HISTORICAL_AUTHORISATION', name, record: view(inspection.record) };
  }
  return { reading: ENTRY_READING[inspection.reading], name, record: null };
}

/**
 * Reads the unattended head-publication authorisation store of this operator
 * profile, and grades every entry in it.
 *
 * Total and offline. Never throws, never creates, never writes, never removes,
 * and asks nothing outside the store root.
 *
 * `provider` exists for the reason every path in this build has one: tests point
 * the profile root at a scratch directory through internal dependency
 * injection. It is not reachable from the CLI, takes nothing from the
 * environment, and the productive answer comes from `os.userInfo()`.
 */
export function listHeadPublicationAuthorisations(
  provider: PathProvider = OS_PATH_PROVIDER,
): HeadPublicationAuditListing {
  let root: string;
  try {
    root = headPublicationAuditRoot(provider);
  } catch {
    // The profile resolver throws rather than guessing, and its message is
    // already value-free. It is dropped here regardless.
    return listing('PROFILE_UNAVAILABLE', null, []);
  }

  // A store reached through a link is somebody else's directory wearing this
  // one's name, and a listing that read it would attribute those records to this
  // profile. `allowMissing` is `true` because a store that has never been
  // written is the ordinary case and is not a link.
  if (inspectLinkChain(root, { allowMissing: true }) !== 'CLEAR') {
    return listing('STORE_PATH_UNSAFE', root, []);
  }

  let names: readonly string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    // `ENOENT` is the whole of "there is no store", and every other answer —
    // including `ENOTDIR` from a file sitting at the path — is "I could not
    // establish what is recorded". The two are never merged: one is a normal
    // machine that has published nothing, the other needs a person.
    return errnoCode === 'ENOENT'
      ? listing('STORE_ABSENT', root, [])
      : listing('STORE_UNREADABLE', root, [], errnoCode);
  }

  // Sorted here, by this module. The filesystem's own enumeration order is
  // measured to differ from this one and is not a contract anywhere; a listing
  // that printed it would be reproducible only by accident.
  const classified = [...names].sort(byName).map((name) => classify(root, name));

  // Two tiers, and the reason is what a name means rather than tidiness. A name
  // this build minted carries the instant the writing invocation's own clock
  // reported, so ordering those by name orders them by that instant; a name
  // anything else chose carries no instant at all, and interleaving the two
  // would place an entry at a time nothing measured. Both tiers are ordered by
  // name, so the whole order is total — names in one directory are unique.
  const entries = [
    ...classified.filter((entry) => entry.reading !== 'UNRECOGNISED_ENTRY'),
    ...classified.filter((entry) => entry.reading === 'UNRECOGNISED_ENTRY'),
  ];

  return listing(
    entries.every((entry) => entry.reading === 'HISTORICAL_AUTHORISATION')
      ? 'READ'
      : 'READ_WITH_UNUSABLE_ENTRIES',
    root,
    entries,
  );
}

/** Code-unit order, written out so no locale, collation or default can enter it. */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
