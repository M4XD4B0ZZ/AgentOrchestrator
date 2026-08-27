/**
 * How the unattended-publication authorisation store is reported to an operator
 * (V4 slice 15).
 *
 * ── Every sentence here is written against one failure ─────────────────────
 *
 * The record this store holds is easy to overclaim, and the overclaim is
 * comfortable: a directory full of `HISTORICAL_AUTHORISATION` reads like proof
 * that this build published those branches. It is not. What each record
 * establishes is bounded exactly, in `deliver/head-publication-authorisation.ts`,
 * and the report may not widen it by a word:
 *
 *  - **it is not "a publication was attempted".** The record is written before
 *    the two `git remote get-url` reads and before the `ls-remote` that decides
 *    whether anything is sent at all. A run that finds the ref already at this
 *    commit sends nothing and leaves this record behind;
 *  - **it is not "the ref exists"**, and **it is not "this build created it"** —
 *    the second is measured false rather than merely unproven (`L-V4-13-5`);
 *  - **it is not "the operator permits this now".** It names the bytes of one
 *    read at one instant, and this command deliberately does not go and look at
 *    the declaration as it stands today;
 *  - **it is not authenticated.** The binding digest is integrity structure with
 *    no key behind it, so anything running as this OS user can write a record
 *    that reads exactly like the rest, and can delete one without trace.
 *
 * So no line here says published, created, succeeded, completed, attempted,
 * executed, valid, current, permitted-now, verified, signed, tamper-proof or
 * complete. The suite sweeps this file for each of those, and for every member
 * of the publication vocabulary, because a renderer is where a bounded record
 * turns back into a comfortable sentence.
 *
 * ── Two absences that are not the same absence ─────────────────────────────
 *
 * "There is nothing recorded here" and "I could not establish what is recorded"
 * are printed as different reports with different exit grades, and neither is
 * ever printed as the other. That distinction is the whole reason this command
 * exists: a listing that answered an unreadable store with an empty list would
 * be the most dangerous thing it could do.
 *
 * ── ASCII only ────────────────────────────────────────────────────────────
 *
 * The printed vocabulary is ASCII, and the suite holds it there, for the reason
 * `render-lease.ts` gives about its own: this repository has twice had text
 * damaged by a re-encoding pass, and an operator-facing report is the worst
 * place for that. The comments are prose and are not held to it.
 *
 * ── The store path is printed, deliberately ────────────────────────────────
 *
 * AO-002 keeps paths out of refusals, with one standing exception that
 * `render-lease.ts` states for the lease path: the one place an operator has
 * explicitly asked *where* something is and cannot act without it. An operator
 * who ran this command asked exactly that, and the path is under their own
 * profile. `repositoryRoot` is printed for the same reason and with the same
 * bound: it is what a record says about the checkout the authorising invocation
 * had resolved, it is the only thing that separates two clones of one project,
 * and nothing here resolves it, stats it or follows it.
 */

import {
  HEAD_PUBLICATION_AUDIT_ENTRY_READINGS,
  type AuthorisedPublicationRecord,
  type HeadPublicationAuditEntry,
  type HeadPublicationAuditEntryReading,
  type HeadPublicationAuditListing,
  type HeadPublicationAuditListingOutcome,
} from '../deliver/head-publication-authorisation-listing.js';
import { line } from './render-attended-run.js';

/**
 * One static sentence per entry reading. Closed, and total by type.
 *
 * Each one has to hold for **every** producer of that reading, which is the rule
 * `render-lease.ts` states for its own tables and the reason none of these names
 * a cause: `RECORD_NOT_THIS_EVENT` is produced by a copied record and by an
 * edited one and this build cannot tell them apart, so the sentence says both
 * and claims neither.
 */
export const AUDIT_ENTRY_SENTENCES: Readonly<Record<HeadPublicationAuditEntryReading, string>> =
  Object.freeze({
    HISTORICAL_AUTHORISATION:
      'A record this build read: the event identity it carries is the directory it sits in,\n' +
      '    and its digest recomputes from that name and from the values it records - of which\n' +
      '    the two contract versions are the only ones not shown above.',
    RECORD_ABSENT:
      'This event directory holds no record. An invocation that died while staging one leaves\n' +
      '    this, so does a refusal after the directory was made - this build removes neither -\n' +
      '    and so does anything running as this OS user deleting the record, or simply making a\n' +
      '    directory here. This build cannot tell those apart. It says nothing about a\n' +
      '    publication and it authorises nothing.',
    RECORD_EMPTY:
      'A file is at this record\'s name and holds no bytes, so there is no record to read.\n' +
      '    The write protocol publishes by renaming a complete file into place and cannot leave\n' +
      '    an empty one, so something else made this. The absence of a record is never a record\n' +
      '    of absence.',
    RECORD_UNREADABLE:
      'No bytes could be taken from this record\'s name: something is at it that is a link or\n' +
      '    is not an ordinary file, the read did not complete, or the name could not be asked\n' +
      '    about at all. Nothing was followed and nothing was touched.',
    RECORD_MALFORMED:
      'Something is here and it is not a record this build declares, so it was not read. A\n' +
      '    record that cannot be read is not a record that says nothing was authorised. It is\n' +
      '    left exactly as it is.',
    RECORD_UNSUPPORTED_VERSION:
      'This record names a contract version this build does not read. It is refused rather\n' +
      '    than guessed at, and nothing in it is shown, because none of it has been checked.\n' +
      '    It is left exactly as it is.',
    RECORD_NOT_THIS_EVENT:
      'The digest does not recompute for the directory this record sits in. That is what a\n' +
      '    record copied out of another event directory looks like, and what a record with a\n' +
      '    field edited in place looks like; this build does not tell the two apart, and it\n' +
      '    repairs neither. Nothing in it is shown.',
    UNRECOGNISED_ENTRY:
      'This build does not read this entry as an event directory: it is a link, or it is not\n' +
      '    a directory, or its name is not one this build mints - or it could not be described\n' +
      '    at all, which is refused for the same reason rather than assumed to be harmless. It\n' +
      '    was not opened and not followed. It is listed because a store that quietly ignored\n' +
      '    what it did not recognise would look complete and would not be.',
  });

/** One static sentence per listing outcome. Closed, and total by type. */
export const AUDIT_LISTING_SENTENCES: Readonly<
  Record<HeadPublicationAuditListingOutcome, string>
> = Object.freeze({
  READ: 'Every entry in the store is a record this build read.',
  READ_WITH_UNUSABLE_ENTRIES:
    'At least one entry in the store is not a record this build read. Each one is listed\n' +
    '  above with what it turned out to be. Nothing was repaired, moved or removed.',
  STORE_ABSENT:
    'There is no store under this user profile, and this command did not create one.',
  STORE_PATH_UNSAFE:
    'A link sits on the store\'s path, or a part of that path could not be inspected.\n' +
    '  Nothing was read through it: what a link points at is not this store, and this build\n' +
    '  does not follow one to find out.',
  STORE_UNREADABLE:
    'The store could not be listed: something is at its path that cannot be, or a directory\n' +
    '  on the way to it is not a directory. Nothing here is a list of what is in it, and a\n' +
    '  store that cannot be read is not a store that says nothing was authorised.',
  PROFILE_UNAVAILABLE:
    'This build could not establish where this user\'s profile directory is - the operating\n' +
    '  system could not be asked, or the answer it gave was not one this build accepts - so\n' +
    '  there is no store to read and no path to name.',
});

/**
 * What a readable record establishes, printed once rather than per record.
 *
 * Framed as what the *record says* rather than as what this build did, and that
 * is not a stylistic choice: a readable reading cannot tell a record this build
 * wrote from one written by anything else running as this OS user, so a sentence
 * beginning "this build established" would be asserting the one thing the
 * reading does not carry.
 */
/**
 * How the list is ordered, and what that order is not evidence of.
 *
 * Printed because the sort key and the printed instant are two different values
 * that can disagree: the key is the directory's name, and `authorisedAt` is a
 * value inside a document whose contract bounds it as a string of at most 64
 * characters and checks nothing else about it. A record grading
 * `HISTORICAL_AUTHORISATION` can carry an `authorisedAt` that is not a date at
 * all, or one that contradicts the instant in its own directory name — measured,
 * not supposed — so the report says which of the two it sorted by.
 */
export const AUDIT_ORDER = [
  'How this list is ordered:',
  '  by the name of each entry: first the ones read as event directories, then everything',
  '  else, each group in the same order. An event directory\'s name carries the instant the',
  '  writing invocation\'s own clock reported, so for records this build wrote the first group',
  '  is that clock\'s order - a name is only what a directory is called, and anything able to',
  '  write here can choose one. Two events minted in the same millisecond are separated by a',
  '  random identifier and their order between them means nothing. The time shown against a',
  '  record is the one inside that record and is checked against nothing - not against a',
  '  calendar, not against the directory name - and it is shown as recorded except that a',
  '  character able to forge a line or reorder one is written as its code point. A sorted',
  '  list cannot show a gap: a',
  '  deleted record leaves nothing behind to be missing.',
].join('\n');

export const AUDIT_MEANING = [
  'What a record here says:',
  '  at the instant under `Authorised at`, an invocation read the operator declaration whose',
  '  exact bytes are the digest shown, found that automatic head publication was permitted for',
  '  that forge identity, and resolved that task, checkout, remote, ref and commit as the',
  '  subject of the one create-only publication it was then authorised to attempt. Those bytes',
  '  were written before that invocation contacted the delivery remote at all.',
  '',
  'What it does not say:',
  '  not that a publication was attempted - the record precedes the reads that decide whether',
  '  anything is sent; not that the ref exists; not that this build put it there; and not that',
  '  the declaration still permits any of it. This command reads the store and nothing else:',
  '  it asks no forge what a ref holds now, and it does not open the declaration as it stands',
  '  today. A record brings no publication closer to happening: no stored record is ever an',
  '  input that permits a publication. The one place the effect path reads one is the write it',
  '  has just made, and that read can only refuse.',
].join('\n');

/**
 * What the store is, and what it is not, printed once.
 *
 * The forgery and deletion limits are stated here rather than beside every
 * record: repeated often enough to be honest, once so the report stays usable.
 */
export const AUDIT_PROVENANCE = [
  'What this store is:',
  '  one directory per publication this build was permitted to attempt with nobody present,',
  '  under this OS user\'s own profile. An attended publication records nothing here, and no',
  '  other act is recorded here at all. Any process running as this OS user can write a record',
  '  that reads exactly like the rest, and can delete one without trace, so this is what is',
  '  present now: it is neither a complete history nor evidence of who wrote what. There is no',
  '  key material in this build and there is nothing here to sign with.',
].join('\n');

/**
 * The closing promise, in two forms.
 *
 * The clause list is true on every outcome; the leading verb is not. A single
 * trailer saying "This command read the store" printed three lines under
 * "Something is at the store's path and its contents could not be listed" — two
 * printed sentences, six lines apart, one denying the other, and the denial was
 * the reassuring one. That is the failure this whole command exists to prevent,
 * arriving through the trailer rather than through the listing.
 */
const READ_ONLY_CLAUSES =
  'changed nothing: it created no directory and no file, wrote nothing, removed nothing,\n' +
  'started no git and no forge client, took no execution lease, read no task state and opened\n' +
  'no declaration.';

export const AUDIT_READ_ONLY_TRAILER = `This command read the store and ${READ_ONLY_CLAUSES}`;

/** For every outcome where no listing was produced. */
export const AUDIT_NOTHING_READ_TRAILER = `This command ${READ_ONLY_CLAUSES}`;

/**
 * Every label this report puts a value beside.
 *
 * Exported because the suite sweeps the *value* lines under a stricter rule than
 * the prose: a value line is where a claim is made, and the prose below it is
 * where the claim is bounded — and bounding it means saying the words in order
 * to deny them. A sweep that could not tell "not that a publication was
 * attempted" from an assertion would forbid the sentence that does the work.
 */
export const AUDIT_REPORT_LABELS = [
  'Store',
  'Listing',
  'Entries',
  'Reason',
  'Entry',
  'Reading',
  'Authorised at',
  'Act',
  'Task',
  'Checkout',
  'Delivery',
  'Ref',
  'Commit',
  'Declaration',
] as const;

/**
 * Every character class a recorded value may not put on a line unaltered.
 *
 * The C0 and C1 controls, because a newline splits one entry into two and an
 * escape sequence paints over the lines above it. The twelve Unicode
 * bidirectional formatting characters, because they do the same damage by
 * another route: an override reorders what a terminal shows without changing a
 * byte, so a ref or a checkout path can be made to read as something else
 * entirely. And the line and paragraph separators, for the first reason.
 *
 * So the class is **not** "control characters" — most of what is in it is
 * `Cf`, not `Cc` — and no sentence here says that any more, because one did and
 * it was false the moment this widened. It is "what can forge a line or reorder
 * one". Everything outside it is left exactly as recorded.
 */
const UNPRINTABLE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * A recorded value, made safe to put on a line of a report.
 *
 * Nine fields of a record are bounded in length and in nothing else — the event
 * identity it claims, the task id, the checkout, the host, the owner, the name,
 * the remote, the ref and the recorded instant — and eight of those are printed.
 * (The ninth is refused before anything is printed: a record whose claimed
 * identity is not the directory it sits in is not read at all.) A record is a file under this OS user's
 * profile and `L-V4-14-2` concedes that anything running as this user can write
 * one — so a value carrying a newline would let a single forged record print
 * itself as several plausible entries, and one carrying an escape sequence would
 * let it paint over the lines above it. That is worse than the forgery this
 * build already concedes: it is a forged record misrepresenting the *reading*.
 *
 * So every character in {@link UNPRINTABLE} is replaced by its code point in
 * angle brackets, and **nothing outside that class is changed**. A path with an
 * umlaut, a branch name with a hyphen and a hundred-character owner all print
 * exactly as recorded; a value that could not have come from a name, a path or a
 * ref does not get to choose what the report looks like.
 */
function printable(value: string): string {
  return value.replace(UNPRINTABLE, (character) => {
    const code = (character.codePointAt(0) ?? 0).toString(16).padStart(4, '0');
    return `<U+${code.toUpperCase()}>`;
  });
}

function field(label: string, value: string): string {
  return `  ${label.padEnd(13)}: ${printable(value)}`;
}

/** The identity of a record, one line, in the shape the delivery report already uses. */
function delivery(record: AuthorisedPublicationRecord): string {
  return `${record.declaredRemote} -> ${record.forgeHost}/${record.forgeOwner}/${record.forgeName}`;
}

function entryLines(entry: HeadPublicationAuditEntry): readonly string[] {
  const lines = [line('Entry', printable(entry.name)), field('Reading', entry.reading)];

  if (entry.record !== null) {
    const record = entry.record;
    lines.push(
      field('Authorised at', record.authorisedAt),
      field('Act', `${record.act}, invocation mode ${record.invocationMode}`),
      field('Task', record.taskId),
      field('Checkout', record.repositoryRoot),
      field('Delivery', delivery(record)),
      field('Ref', record.authorisedRef),
      field('Commit', record.authorisedCommit),
      field('Declaration', `${record.declaredPermission}, sha256 ${record.declarationDigest}`),
    );
  }

  lines.push(`    ${AUDIT_ENTRY_SENTENCES[entry.reading]}`);
  return lines;
}

/**
 * How many entries were read, and how many were not. Both halves always, so a
 * store with one damaged entry cannot be read as a clean one at a glance.
 */
function tally(entries: readonly HeadPublicationAuditEntry[]): string {
  const read = entries.filter((e) => e.reading === 'HISTORICAL_AUTHORISATION').length;
  const rest = entries.length - read;
  return `${entries.length} (${read} read, ${rest} not read)`;
}

/**
 * The whole report.
 *
 * Every entry is printed, always. There is no limit, no page and no "most
 * recent": the store is unbounded by decision (`L-V4-14-1`) and a listing that
 * silently dropped part of it would be exactly the failure this command exists
 * to prevent. What that costs is one block per event, forever, and it is stated
 * in the operator guide rather than solved by truncation.
 */
export function renderPublicationAuthorisations(listing: HeadPublicationAuditListing): string {
  const lines: string[] = [''];

  if (listing.root !== null) lines.push(line('Store', printable(listing.root)));
  lines.push(line('Listing', listing.outcome));

  if (listing.outcome === 'READ' || listing.outcome === 'READ_WITH_UNUSABLE_ENTRIES') {
    lines.push(line('Entries', tally(listing.entries)));
  }
  if (listing.errnoCode !== null) lines.push(line('Reason', listing.errnoCode));

  lines.push(`  ${AUDIT_LISTING_SENTENCES[listing.outcome]}`);

  for (const entry of listing.entries) {
    lines.push('', ...entryLines(entry));
  }

  if (listing.entries.length > 0) lines.push('', AUDIT_ORDER);
  // The meaning names the labels of a readable record, so it is printed only
  // where one exists. A store holding a single stray file used to be told what
  // "the instant under `Authorised at`" means, in a report with no such line.
  if (listing.entries.some((entry) => entry.reading === 'HISTORICAL_AUTHORISATION')) {
    lines.push('', AUDIT_MEANING);
  }
  const read = listing.outcome === 'READ' || listing.outcome === 'READ_WITH_UNUSABLE_ENTRIES';
  lines.push('', AUDIT_PROVENANCE, '', read ? AUDIT_READ_ONLY_TRAILER : AUDIT_NOTHING_READ_TRAILER);

  return `${lines.join('\n')}\n\n`;
}

/** Exported so the suite can sweep every printed sentence in one place. */
export const AUDIT_PRINTED_TEXT: readonly string[] = Object.freeze([
  ...HEAD_PUBLICATION_AUDIT_ENTRY_READINGS.map((r) => AUDIT_ENTRY_SENTENCES[r]),
  ...Object.values(AUDIT_LISTING_SENTENCES),
  AUDIT_ORDER,
  AUDIT_MEANING,
  AUDIT_PROVENANCE,
  AUDIT_READ_ONLY_TRAILER,
  AUDIT_NOTHING_READ_TRAILER,
]);
