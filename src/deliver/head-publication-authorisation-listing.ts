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
 *  - a symbolic link or a Windows junction is never followed, at any of the
 *    three levels: not as an event directory, not at the record's own name, and
 *    — since V4 slice 16 — not at the outcome's. A record read
 *    through one would be evidence from somewhere else, filed under a name in
 *    the store — which is the one thing an accountability listing may not do.
 *    **A hard link is not a link this can see**, and that bound is stated rather
 *    than implied: it is not a reparse point, nothing counts links, and a
 *    hard-linked record is opened and graded like any other, with its bytes
 *    living under another name outside the store. `L-V4-14-4`, which this slice
 *    is the first code to read through, and `L-V4-15-6`;
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
import { inspectLinkChain, pathChain } from '../doctor/safe-write.js';
import { isValidRunId } from '../doctor/run-directory.js';
import {
  HEAD_PUBLICATION_AUTHORISATION_RECORD_FIELDS,
  MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES,
  inspectHeadPublicationAuthorisation,
  type AuthorisedPublicationRecord,
  type HeadPublicationAuthorisationReading,
} from './head-publication-authorisation.js';
// The location, and deliberately not either store. What that buys, stated
// exactly, because a review measured the stronger version of this sentence and
// found it false: **neither store's record-building, size gate or publishing
// step is reachable from here**, and in particular `state/atomic-file.ts` — the
// staging write and the `rename` — is not in this module's import closure at
// all.
//
// What it does **not** buy is a closure with no create primitive in it. Two
// imports below, `doctor/safe-write.ts` carries the exclusive `wx` open that
// both stores write through, and `doctor/run-directory.ts` carries the exclusive
// `mkdir` that makes an event directory. This module needs the first for its
// path-safety helpers and the second for the name grammar it reads by, so they
// are in the graph and always were. "This command creates nothing" is therefore
// a fact about what this module *names* — the suite sweeps it for every one of
// those functions — and the import rule above is what keeps the graph small
// enough for that sweep to be worth reading.
import {
  HEAD_PUBLICATION_AUDIT_FILE_NAME,
  HEAD_PUBLICATION_OUTCOME_FILE_NAME,
  headPublicationAuditRoot,
} from './internal/head-publication-audit-location.js';
// The outcome's own contract, and deliberately not its store — the same rule,
// bought for the same reason, with the same honest bound.
import {
  HEAD_PUBLICATION_OUTCOME_RECORD_FIELDS,
  MAX_HEAD_PUBLICATION_OUTCOME_BYTES,
  inspectHeadPublicationOutcome,
  type HeadPublicationOutcomeReading,
  type RecordedPublicationOutcome,
} from './head-publication-outcome.js';

/**
 * What one direct child of the store root turned out to be. A closed set of
 * eight, of which exactly one means "a record this build read".
 *
 * They come from two places, and the split is worth stating because a later
 * member has to be put in the right one. **Four** are the store's own reading
 * vocabulary under a `RECORD_` prefix, mapped one for one by `ENTRY_READING`:
 * they are answers about a *document*, and deriving them rather than inventing a
 * parallel set is deliberate — two spellings of "this record is from a version I
 * cannot read" could drift, and the one that drifted would be the one an
 * operator sees. **Four** are established here, because they are answers about
 * an *entry* and the grader never sees one: it is only ever reached with bytes
 * in hand. `HISTORICAL_AUTHORISATION` is the good answer and carries no prefix;
 * `RECORD_ABSENT` and `RECORD_UNREADABLE` are settled from an errno and a file
 * test before any bytes exist; `UNRECOGNISED_ENTRY` is settled before the record
 * is looked for at all.
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
   * No bytes could be taken from the record's name.
   *
   * Four producers: something at the name that is a link, something that is not
   * a regular file, a read that did not complete — and a name this build could
   * not ask about at all, where nothing is established to be there. The sentence
   * does not open with "something is at" for that last one's sake.
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
 * One entry of the store, as this build reads it.
 *
 * The record is present on exactly one member and is `null` on every other, and
 * that is enforced by the type rather than by care: there is no way to reach a
 * field of a record this build refused, so an unreadable event's values cannot
 * be rendered as though they had been established.
 */
/**
 * The renamed view of one readable record, and the map that produced it.
 *
 * Both are declared where the grading happens, because the grader is what hands
 * a record out and the rename is what keeps that value from being an argument to
 * the publication mint. They are re-exported here so this module stays the one
 * place a caller has to import to read the store.
 */
export type { AuthorisedPublicationRecord };
export const HEAD_PUBLICATION_AUDIT_RECORD_FIELDS = HEAD_PUBLICATION_AUTHORISATION_RECORD_FIELDS;

/**
 * The outcome record's own view and field map, re-exported so this module stays
 * the one place a caller has to import to read the store.
 */
export type { RecordedPublicationOutcome };
export const HEAD_PUBLICATION_OUTCOME_ENTRY_RECORD_FIELDS =
  HEAD_PUBLICATION_OUTCOME_RECORD_FIELDS;

/**
 * What sits at one event's outcome name. A closed set of seven, of which
 * exactly one means "an outcome this build read".
 *
 * Built the way the entry vocabulary above it is built, and for the same
 * reasons. **Five** are the outcome contract's own reading vocabulary, mapped one
 * for one by {@link OUTCOME_ENTRY_READING} and carrying an `OUTCOME_` prefix
 * except for the good member, which is named for what it is: they are answers
 * about a *document*, and deriving them rather than inventing a parallel set
 * means two spellings of "I cannot read this version" cannot drift.
 * **Two** are established here, because they are answers about a *name* and the
 * grader never sees one: `OUTCOME_ABSENT` and `OUTCOME_UNREADABLE` are settled
 * from an errno and a file test before any bytes exist.
 *
 * `OUTCOME_ABSENT` is the ordinary member, not a fault. Every event this build
 * wrote before V4 slice 16 has it and always will, and nothing backfills them.
 */
export const HEAD_PUBLICATION_OUTCOME_ENTRY_READINGS = [
  /** An outcome this build read, bound to this event and to this authorisation. */
  'HISTORICAL_OUTCOME',
  /** Nothing at the outcome's name. Says nothing about what happened. */
  'OUTCOME_ABSENT',
  /** A file is at the name and holds no bytes. */
  'OUTCOME_EMPTY',
  /** No bytes could be taken from the name: a link, not a file, or an unaskable name. */
  'OUTCOME_UNREADABLE',
  /** Something is there and is not an outcome this build declares. */
  'OUTCOME_MALFORMED',
  /** An outcome contract version this build does not read. Refused, never guessed. */
  'OUTCOME_UNSUPPORTED_VERSION',
  /** Well-formed, and bound to a different event or a different authorisation. */
  'OUTCOME_NOT_THIS_EVENT',
] as const;

export type HeadPublicationOutcomeEntryReading =
  (typeof HEAD_PUBLICATION_OUTCOME_ENTRY_READINGS)[number];

/**
 * How an outcome reading becomes an entry reading.
 *
 * Total by type over the contract's five, so a member added there is a compile
 * error here rather than an outcome that quietly falls through to something
 * reassuring. `ABSENT` maps to `OUTCOME_EMPTY` for the reason the record's own
 * table gives about its twin: the grader answers `ABSENT` for exactly one input,
 * zero bytes, and it is only ever handed bytes — so it can never mean "nothing
 * at the name", which is established here from the errno.
 */
const OUTCOME_ENTRY_READING: Readonly<
  Record<HeadPublicationOutcomeReading, HeadPublicationOutcomeEntryReading>
> = Object.freeze({
  HISTORICAL_OUTCOME: 'HISTORICAL_OUTCOME',
  ABSENT: 'OUTCOME_EMPTY',
  MALFORMED: 'OUTCOME_MALFORMED',
  UNSUPPORTED_VERSION: 'OUTCOME_UNSUPPORTED_VERSION',
  NOT_THIS_EVENT: 'OUTCOME_NOT_THIS_EVENT',
});

/**
 * The entry readings under which nothing beside the record is a document this
 * build could not read.
 *
 * Two members, and the second is `OUTCOME_ABSENT` because an event with no
 * outcome is the ordinary shape and always will be: nothing backfills the events
 * written before V4 slice 16, so counting them against the store would produce a
 * signal that is permanent, that no invocation of this tool can clear, and that
 * everybody would learn to ignore.
 *
 * Held as a set, and the reason is exactly what a review found in its first
 * draft: the predicate below read `entry.outcome === 'OUTCOME_ABSENT' ||` a
 * one-member set's `has`, so half the condition was a string test on a name
 * beside a comment claiming a set was what stopped that, and the one-member set
 * had no other consumer. One set, one question, and the suite partitions the
 * vocabulary against it.
 */
export const CLEAN_OUTCOME_ENTRY_READINGS: ReadonlySet<HeadPublicationOutcomeEntryReading> =
  Object.freeze(
    new Set<HeadPublicationOutcomeEntryReading>(['HISTORICAL_OUTCOME', 'OUTCOME_ABSENT']),
  ) as ReadonlySet<HeadPublicationOutcomeEntryReading>;

export type HeadPublicationAuditEntry =
  | {
      readonly reading: 'HISTORICAL_AUTHORISATION';
      /** The directory's own name. Always the name on disk, never a value from the record. */
      readonly name: string;
      readonly record: AuthorisedPublicationRecord;
      /**
       * What sits beside this record and says what became of it, if anything.
       *
       * On this arm and on no other, and that is enforced by the type rather
       * than by care (V4 slice 16). An outcome is the outcome **of an
       * authorisation**, and on every other arm there is no established
       * authorisation for it to be the outcome of: the record was refused, or
       * could not be read, or belongs to another event. Rendering one there
       * would attach a publication history to a document this build declined —
       * and for `RECORD_NOT_THIS_EVENT`, to one it can prove it did not write.
       *
       * The cost is real and is disclosed where it can be: on those arms the
       * outcome file is not looked at at all, so a readable outcome can be
       * sitting beside a record this build refused and no line of the report
       * will mention it. The entry's own sentence cannot carry that — those
       * eight sentences are about the *record*, and each has to hold for every
       * producer of its reading — so it is said once, in the paragraph the
       * report prints about the store itself. An earlier version of this comment
       * claimed the entry sentences carried it; they never did.
       */
      readonly outcome: HeadPublicationOutcomeEntryReading;
      /** Non-null exactly when `outcome` is `HISTORICAL_OUTCOME`. */
      readonly outcomeRecord: RecordedPublicationOutcome | null;
    }
  | {
      readonly reading: Exclude<HeadPublicationAuditEntryReading, 'HISTORICAL_AUTHORISATION'>;
      readonly name: string;
      readonly record: null;
    };

/**
 * How the listing itself ended. A closed set of six.
 *
 * Three of them are answers *about the store*: two say it was read — "everything
 * in it is a record I could read" and "something in it is not", which a script
 * must be able to tell apart — and `STORE_ABSENT` says there is nothing there.
 * The remaining three each mean **I could not establish what is recorded**,
 * which is not the same sentence as "nothing is recorded" and is deliberately
 * not reachable from it. Putting `STORE_ABSENT` in that second group is an error
 * this header made and this slice shipped once: the listing decided it from an
 * errno that could not carry it, and reported a blocked path as an empty
 * store.
 */
export const HEAD_PUBLICATION_AUDIT_LISTINGS = [
  /**
   * The store was read, every entry in it is a record this build read, and
   * nothing beside one of those records is a document it could not. Zero entries
   * included.
   *
   * Both halves, since V4 slice 16, and {@link entryWasRead} is the one place
   * the condition is written down — these two sentences are its documentation
   * and not a second copy of it.
   */
  'READ',
  /**
   * The store was read, and at least one entry is not a record this build read,
   * or holds beside that record a document it could not read.
   */
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
  /**
    * The store could not be listed.
    *
    * Three producers, and the first is why this sentence does not say
    * "something is at the store's path": a directory **on the way** to the
    * store is not a directory, in which case nothing is at the store's path at
    * all. The others are something at the path itself that cannot be listed,
    * and an enumeration that failed for another reason.
    */
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
 * size zero, so without a file test a directory sitting at the record's name
 * would read as an empty file — the wrong answer reached by accident. Measured,
 * not assumed.
 *
 * That test is the second of a **pair**, and this says so rather than letting a
 * later reader take it for coverage it does not provide. `classify` has already
 * `lstat`ed the same path and refused a non-file, so removing either half alone
 * leaves the suite green — the other half answers. Removing both fails it, and a
 * mutant does exactly that. They are kept because they answer about different
 * objects: the `lstat` refuses a **link**, which an `fstat` on an opened handle
 * cannot see because it reports the target; and the `fstat` binds the answer to
 * the object this call actually opened, which the earlier `lstat` cannot,
 * because anything may replace the name between the two.
 *
 * The bound is applied by reading no further rather than by judging the size
 * here: whatever comes back goes to the contract's own grader, which is the one
 * place that decides what "too large to be a record" means, and one byte past
 * the bound is enough for it to say so. **What the bound buys is bounded
 * allocation and nothing else**, and that is stated because it is not something
 * this suite can observe: measured on this machine, reading a five-gigabyte
 * sparse file whole succeeds and grades `MALFORMED` exactly as the bounded read
 * does. A mutant that removes the bound therefore survives, deliberately.
 */
function boundedBytes(path: string, bound: number): Buffer | null {
  let handle: number;
  try {
    handle = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) return null;
    const wanted = Math.min(stat.size, bound + 1);
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
 * The two documents' bounded reads, sharing one implementation.
 *
 * A parameter and not a second copy: the body above is a path-safety and
 * short-read chain, and this repository has already had to pin against that
 * chain being copied into a fourth module. Two names because two contracts own
 * two bounds, and neither may be applied to the other's document.
 */
function recordBytes(path: string): Buffer | null {
  return boundedBytes(path, MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES);
}

function outcomeBytes(path: string): Buffer | null {
  return boundedBytes(path, MAX_HEAD_PUBLICATION_OUTCOME_BYTES);
}

/**
 * Classifies one direct child of the store root.
 *
 * Named `classifyEntry` and not `classify`, deliberately: a bare `classify` is
 * one of three names `tests/v2-02-remediation.test.ts` sweeps `src/` for, because
 * the path-safety chain was once copied verbatim into three modules and that pin
 * is how a fourth copy would be caught. This function is not that chain and
 * belongs nowhere near its exception list, so it does not answer to its name.
 *
 * The order of the tests is the contract. An entry is only opened once it has
 * been established to be a directory this build would have made, so a link is
 * never followed and a name this build could not have minted is never read
 * through.
 */
function classifyEntry(root: string, name: string): HeadPublicationAuditEntry {
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
    // The one point at which an authorisation exists, so the one point at which
    // an outcome can be the outcome of anything. The anchor handed down is the
    // record's own binding digest — which on this arm is a value the grader has
    // just *recomputed* and found equal, not merely one it read — so an outcome
    // moved here out of another event cannot recompute.
    const outcome = classifyOutcome(root, name, inspection.record);
    return {
      reading: 'HISTORICAL_AUTHORISATION',
      name,
      record: inspection.record,
      outcome: outcome.reading,
      outcomeRecord: outcome.record,
    };
  }
  return { reading: ENTRY_READING[inspection.reading], name, record: null };
}

/**
 * Classifies what sits at one event's outcome name, under the identity its
 * authorisation establishes.
 *
 * The same order of tests as the record above it, for the same reasons: `lstat`
 * before anything is opened so a link is never followed, absence established
 * from `ENOENT` alone rather than from any failure, and the bytes graded by the
 * contract that wrote them.
 *
 * All four fields of the subject come from somewhere other than these bytes —
 * the directory's own name, and three values the authorisation record carries,
 * one of which is a digest this reader has just recomputed and found equal. That
 * is what keeps the grading from being evidence for whatever the outcome
 * happened to say.
 */
function classifyOutcome(
  root: string,
  name: string,
  record: AuthorisedPublicationRecord,
): {
  readonly reading: HeadPublicationOutcomeEntryReading;
  readonly record: RecordedPublicationOutcome | null;
} {
  const path = join(root, name, HEAD_PUBLICATION_OUTCOME_FILE_NAME);

  let target;
  try {
    target = lstatSync(path);
  } catch (error) {
    // Absence, and only from this errno. An outcome that is not there is the
    // ordinary shape for every event written before V4 slice 16 and for every
    // invocation that ended before it could write one, and those are not told
    // apart here — see the sentence the report prints for it. Anything else is a
    // name this build could not ask about, which is not the same thing.
    return safeErrnoCode(error) === 'ENOENT'
      ? { reading: 'OUTCOME_ABSENT', record: null }
      : { reading: 'OUTCOME_UNREADABLE', record: null };
  }
  // A link at the outcome's name is never followed, for the reason a link at the
  // record's name is not: reading through one would file somebody else's bytes
  // under this event's name as its history.
  if (target.isSymbolicLink() || !target.isFile()) {
    return { reading: 'OUTCOME_UNREADABLE', record: null };
  }

  const bytes = outcomeBytes(path);
  if (bytes === null) return { reading: 'OUTCOME_UNREADABLE', record: null };

  const inspection = inspectHeadPublicationOutcome(bytes, {
    eventId: name,
    taskId: record.taskId,
    repositoryRoot: record.repositoryRoot,
    authorisationBinding: record.binding,
  });
  return { reading: OUTCOME_ENTRY_READING[inspection.reading], record: inspection.record };
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

  // "There is no store" is established from the path itself, never from the
  // errno the enumeration failed with, and that distinction is a defect this
  // slice shipped and a review reproduced. Windows collapses "a component of the
  // path is not a directory" into `ENOENT` — `ERROR_PATH_NOT_FOUND` — so a
  // profile whose `.agent-orchestrator` is a *file* made `readdir` answer
  // `ENOENT`, and the listing reported "there is no store under this user
  // profile" and exited 0. Measured against the writer on the same profile at
  // the same instant: it answers `STORE_UNAVAILABLE`/`ENOTDIR` and the drive
  // grades that 3. Two commands, one condition, opposite answers, and the
  // reassuring one was this.
  //
  // `ENOTDIR` reaches the caller only when the *root itself* is the non-
  // directory, which is exactly the one shape a test covered.
  const blocked = firstNonDirectoryOnPath(root);
  if (blocked !== null) return listing('STORE_UNREADABLE', root, [], blocked);

  let names: readonly string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    const errnoCode = safeErrnoCode(error);
    // Reached with every existing component of the path already established to
    // be a directory, so `ENOENT` here really is "the store is not there".
    return errnoCode === 'ENOENT'
      ? listing('STORE_ABSENT', root, [])
      : listing('STORE_UNREADABLE', root, [], errnoCode);
  }

  // Sorted here, by this module. The filesystem's own enumeration order is
  // measured to differ from this one and is not a contract anywhere; a listing
  // that printed it would be reproducible only by accident.
  const classified = [...names].sort(byName).map((name) => classifyEntry(root, name));

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
    entries.every(entryWasRead) ? 'READ' : 'READ_WITH_UNUSABLE_ENTRIES',
    root,
    entries,
  );
}

/**
 * Whether everything this build found under one entry is something it read.
 *
 * The one predicate, exported because the listing's own grade and the report's
 * tally both need it and a second spelling would let them disagree — which is
 * exactly what a first draft of V4 slice 16 did: a store whose every outcome was
 * unreadable was graded `READ_WITH_UNUSABLE_ENTRIES` and counted as
 * "3 (3 read, 0 not read)", so the line whose whole purpose is that a damaged
 * store cannot read as a clean one at a glance said it was clean.
 *
 * What counts is {@link CLEAN_OUTCOME_ENTRY_READINGS}, which is where the
 * `OUTCOME_ABSENT` decision is written down.
 */
export function entryWasRead(entry: HeadPublicationAuditEntry): boolean {
  return (
    entry.reading === 'HISTORICAL_AUTHORISATION' &&
    CLEAN_OUTCOME_ENTRY_READINGS.has(entry.outcome)
  );
}

/* ── Asking about one branch (V4 slice 17) ──────────────────────────────── */

/**
 * The four values that name one branch on one forge repository.
 *
 * Four and not one, because a ref is not a branch: `refs/heads/main` in one
 * repository is not the branch of that name in another, and the record's own
 * schema admits **any** host and any owner rather than an enum — so a key
 * missing one of these answers with somebody else's history. Measured against
 * the contract rather than against what this build happens to write today:
 * `SUPPORTED_FORGE_HOSTS` has one member, and a key resting on that is a key
 * that is right only until the list grows.
 *
 * Four and not more. `authorisedCommit` is what the branch pointed at, not
 * which branch it is; `declaredRemote` is the **local** name of the pointer the
 * identity was read through, and two records agreeing on host, owner and name
 * name one repository whatever the local remote is called; `repositoryRoot` is
 * a checkout, and "two clones of one project are two of these". A key carrying
 * any of those splits one branch's history and reports part of it as the whole.
 * The rest of the record is either a per-event fact — the instant, the event
 * identity, the binding, the declaration digest — or a field the schema pins to
 * a single admissible value, which discriminates nothing.
 *
 * Spelled in {@link AuthorisedPublicationRecord}'s renamed field names, and
 * that is the same defence the rename itself is: a value carrying `host`,
 * `owner`, `name`, `commit`, `ref` or `remoteName` is structurally an argument
 * to the publication mint and to the re-check seam. A query is one field short
 * of that today, which is an accident of one field rather than a defence.
 */
export interface HeadPublicationBranchQuery {
  readonly forgeHost: string;
  readonly forgeOwner: string;
  readonly forgeName: string;
  readonly authorisedRef: string;
}

/**
 * Whether one record this build read names the branch that was asked for.
 *
 * Four `===` and nothing else. No case is folded, no prefix is added, no suffix
 * is trimmed and no part of a value is matched, and each of those is a decision
 * rather than an omission:
 *
 *  - **case is not folded** because the authority this store is about does not
 *    fold it either. `permitsUnattendedHeadPublication` compares owner and name
 *    exactly and answers `NOT_DECLARED` for a differently capitalised entry
 *    (`L-V4-13-3`). A reader that folded would put a second, disagreeing
 *    definition of "the same repository" into one build, and would teach an
 *    operator a rule the permission path does not honour. It would also apply
 *    one forge's convention to a record whose host field admits any string;
 *  - **nothing is prepended** because the query and the record are compared as
 *    they are. A rule that turned `main` into `refs/heads/main` would make one
 *    query string mean two stored values, since a ref of `refs/heads/refs/heads/x`
 *    is one the writer's own grammar admits;
 *  - **no part of a value is matched** because a substring rule names records
 *    the operator did not ask for, and on a store nothing prunes that is a
 *    mistake with no undo.
 *
 * It takes a record and never bytes. Every field it reads is one the grader has
 * already checked and whose binding it has already recomputed, which is what
 * keeps a record this build refused from answering a question about a branch —
 * see {@link selectQueriedBranch}.
 */
export function recordNamesQueriedBranch(
  record: AuthorisedPublicationRecord,
  query: HeadPublicationBranchQuery,
): boolean {
  return (
    record.forgeHost === query.forgeHost &&
    record.forgeOwner === query.forgeOwner &&
    record.forgeName === query.forgeName &&
    record.authorisedRef === query.authorisedRef
  );
}

/**
 * What a store's entries turned out to be, once one branch was asked about.
 *
 * Three counts over the whole store and one list, and the three counts
 * partition the entries exactly: every entry is counted once and in one group.
 */
export interface HeadPublicationBranchSelection {
  /** Entries whose record this build read, naming the branch that was asked for. */
  readonly named: number;
  /** Entries whose record it read, naming a different branch. Not shown. */
  readonly elsewhere: number;
  /**
   * Entries it read no record for, so nothing about the query is established
   * for them. Shown.
   *
   * There is nothing to compare: the entry type puts the record on one arm and
   * `null` on the other seven, and the only other field those arms carry is the
   * directory's name — an instant and a random identifier, which encodes no
   * ref, no task and no repository. So one of these may be the record for the
   * branch being asked about and this build cannot say that it is not.
   */
  readonly unestablished: number;
  /**
   * What a report prints, in the order the listing established.
   *
   * **Exactly one class is left out: an entry this build read in full which
   * names a different branch.** Everything else is here, and that is the whole
   * decision this type exists to record.
   *
   * The unestablished are here because dropping them would turn "one of these
   * might be your branch and I cannot tell" into "there is no record for this
   * branch" — the reassuring absence this command exists to prevent, arriving
   * through a filter instead of through a listing.
   *
   * And an entry naming another branch is here too **when this build did not
   * read all of its evidence** — a record it read beside an outcome document it
   * could not. That case is not obvious and was a shipped defect for one
   * commit: the store's grade and the report's tally are `entryWasRead`, which
   * is "the record was read *and* nothing beside it was a document I could
   * not", while this selection asked only whether a record was read. The two
   * disagreed on exactly that entry, so a store of one such record printed
   * `Entries : 1 (0 read, 1 not read)`, printed "each one is listed above with
   * what it turned out to be", and listed nothing. Measured, with the real
   * writers and the real renderer.
   *
   * So the rule here is `entryWasRead` and not "a record was read": one
   * predicate, one question. That is the rule V4 slice 16 already learned once,
   * and this is its second spelling being removed rather than added.
   */
  readonly shown: readonly HeadPublicationAuditEntry[];
}

/**
 * Sorts one store's entries into what was asked for, what was not, and what
 * could not be judged either way.
 *
 * A projection over a listing that has already happened, and deliberately not a
 * parameter to {@link listHeadPublicationAuthorisations}. Two things rest on
 * that. The store's grade is `entries.every(entryWasRead)` over **every**
 * classified entry, and its printed sentence says "every entry in the store" —
 * a filter inside the enumeration would narrow that to the selection while the
 * sentence went on claiming the store. And the outcome beside each readable
 * record is graded for every entry, so an entry excluded by a query still
 * counts against the store the way it did before there were queries.
 *
 * Total, pure, and one pass. It opens nothing, builds no path and asks the
 * filesystem nothing, so a value that looks like a path — `refs/heads/../x`,
 * which the writer's own grammar admits — is a string that names no record
 * rather than a path anything walks.
 */
export function selectQueriedBranch(
  entries: readonly HeadPublicationAuditEntry[],
  query: HeadPublicationBranchQuery,
): HeadPublicationBranchSelection {
  let named = 0;
  let elsewhere = 0;
  let unestablished = 0;
  const shown: HeadPublicationAuditEntry[] = [];

  for (const entry of entries) {
    // The record is `null` on seven of the eight arms, by type. There is no
    // branch on those entries to compare, so this is not a policy about broken
    // evidence — it is the absence of anything to have a policy about.
    if (entry.record === null) {
      unestablished += 1;
      shown.push(entry);
      continue;
    }
    if (recordNamesQueriedBranch(entry.record, query)) {
      named += 1;
      shown.push(entry);
      continue;
    }
    // Counted as naming another branch, because that is what this build
    // established about it. Shown anyway unless it was read in full: an entry
    // that grades the store down is an entry the store's own sentence promises
    // is listed, and a filter that hid one would make that sentence false.
    elsewhere += 1;
    if (!entryWasRead(entry)) shown.push(entry);
  }

  return Object.freeze({ named, elsewhere, unestablished, shown: Object.freeze(shown) });
}

/**
 * What a store had to say about one branch. A closed set of three.
 *
 * Two of them are negatives and they are deliberately not one member. "Nothing
 * here names that branch, and everything here was read" and "nothing here names
 * that branch, and some of what is here was not read" are different sentences,
 * and folding them would let the second be printed as the first — which is the
 * reassuring-absence failure in its exact shape.
 */
export const HEAD_PUBLICATION_BRANCH_QUERY_READINGS = [
  /** At least one record this build read names the branch. */
  'NAMED_RECORDS_PRESENT',
  /** None does, and every entry in the store is an entry it read a record for. */
  'NO_NAMED_RECORD_PRESENT',
  /** None does, and at least one entry is one it read no record for at all. */
  'NO_NAMED_RECORD_AND_EVIDENCE_UNREAD',
  /**
   * No listing was produced, so the branch was not asked about anything.
   *
   * A member rather than a printed silence. The three above are answers; this
   * one is the refusal to give an answer, and it exists because the absence of
   * a line is not a sentence — the rule this slice's suite states for the
   * negatives and which the store-level outcomes escaped in the first version
   * of this report. `STORE_ABSENT` is the shape that needs it most: it exits 0
   * like a clean negative does.
   */
  'STORE_NOT_READ',
] as const;

export type HeadPublicationBranchQueryReading =
  (typeof HEAD_PUBLICATION_BRANCH_QUERY_READINGS)[number];

/**
 * Which of the four a query got. Total, and the order of the tests is the
 * contract.
 *
 * `null` is "no listing was produced", which is why this takes a selection or
 * nothing rather than only a selection: a selection over the empty entry list
 * of a store that could not be read would answer the strong negative for a
 * store nothing was read from.
 *
 * A store with a match is reported as having one whatever else is in it,
 * because everything this build did not read in full is listed beside the match
 * and speaks for itself.
 *
 * **The negatives split on `unestablished` and not on `entryWasRead`**, and a
 * review proposed the other one. The question these two members answer is
 * "could something here be the branch I asked about, without this build being
 * able to tell?", and that is exactly "no record was read". An entry whose
 * *record* this build read names a different branch as definitely as any record
 * here names anything — an unreadable document beside it changes what became of
 * that publication and not which branch it was about. Splitting on
 * `entryWasRead` would print "whether any of these concerns that branch is not
 * established" over an entry this build can say does not, which is an overclaim
 * in the other direction.
 *
 * What that entry does change is the store's grade and the tally, and both are
 * printed above these sentences; the entry itself is listed, because
 * {@link selectQueriedBranch} shows everything `entryWasRead` is false for. The
 * clean negative's own wording says only what it means and points at the line
 * that owns the other question.
 */
export function branchQueryReading(
  selection: HeadPublicationBranchSelection | null,
): HeadPublicationBranchQueryReading {
  if (selection === null) return 'STORE_NOT_READ';
  if (selection.named > 0) return 'NAMED_RECORDS_PRESENT';
  return selection.unestablished > 0
    ? 'NO_NAMED_RECORD_AND_EVIDENCE_UNREAD'
    : 'NO_NAMED_RECORD_PRESENT';
}

/** Code-unit order, written out so no locale, collation or default can enter it. */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The errno of the first component of `target`'s path that exists and is not a
 * directory, or `null` when every existing component is one.
 *
 * This is what separates "the store is not there" from "something is standing in
 * the way of it", and it has to be asked of the path rather than of `readdir`,
 * because on Windows the two arrive as one errno. It walks the same chain
 * `inspectLinkChain` has already walked and stops at the first component that is
 * absent: nothing below an absent component can exist either.
 *
 * A component this call cannot describe at all is `null` here rather than a
 * refusal, and that is not a hole: the link inspection runs first and answers
 * `INSPECTION_FAILED` for exactly that, which is already `STORE_PATH_UNSAFE`.
 */
function firstNonDirectoryOnPath(target: string): string | null {
  for (const segment of pathChain(target)) {
    let stats;
    try {
      stats = lstatSync(segment);
    } catch {
      // An absent component ends the walk: nothing below it can exist either.
      // Any other failure was already refused by the link inspection above,
      // which answers `INSPECTION_FAILED` for a component it cannot describe.
      return null;
    }
    if (!stats.isDirectory()) return 'ENOTDIR';
  }
  return null;
}
