/**
 * The durable record of what one unattended head publication went on to do, and
 * the exact sentence it is allowed to assert (V4 slice 16).
 *
 * ── The one sentence ───────────────────────────────────────────────────────
 *
 * > At `recordedAt`, the invocation that wrote authorisation event `eventId`
 * > had finished its publication processing, and these are the calls it made
 * > and the readings it took: `outcome` says whether the create-only
 * > publication command was handed to the process boundary and what the last
 * > reading of the ref established, and `commandReport` says what the process
 * > boundary reported about that one command.
 *
 * Every clause of that is a fact the writing invocation held in its hand. What
 * follows is the list of sentences it is **not**.
 *
 * ── What it does not say ───────────────────────────────────────────────────
 *
 *  - **not "this build put the commit on the delivery remote".** That is
 *    measured false rather than merely unproven. When the pushed object name
 *    already equals the remote ref's, Git answers up to date and exits zero
 *    *without evaluating the lease at all* — so an invocation that changed
 *    nothing reaches the strongest reading this record has. `L-V4-13-5`. There
 *    is no member, no field and no wording here that names an author of a ref;
 *  - **not "the ref holds this now".** Every reading is one reading at one
 *    instant. The ref can be moved, deleted or force-updated a millisecond
 *    later, and nothing here is revised when it is;
 *  - **not "bytes reached the delivery remote".** `outcome` distinguishes
 *    *dispatch* — the command was handed to the process boundary — from every
 *    stronger claim, and `commandReport` is the boundary's own report about a
 *    process, not about a network;
 *  - **not "nothing happened", when it says the ref was read absent
 *    afterwards.** One reading afterwards does not establish that nothing ever
 *    existed in between;
 *  - **not "this may be attempted again".** No stored record is ever an input
 *    that permits a publication. A retry begins with a reading, taken by a new
 *    invocation that asks, under a declaration that still permits, against a
 *    freshly resolved subject and a fresh one-shot grant.
 *
 * ── And the sentence its absence is allowed to assert ──────────────────────
 *
 * > **An authorisation with no outcome beside it means no durable outcome was
 * > established. It does not mean no effect happened.**
 *
 * That is load-bearing and is stated in the code, the tests and the operator's
 * report. There is no transaction between a ref update on github.com and a file
 * on this machine's NTFS volume, so a crash between the two leaves exactly this
 * shape — and so does every invocation of every build older than this one.
 *
 * ── Why this is a second document and not a field of the first ─────────────
 *
 * `authorisation.json` is immutable and means what it meant at the pre-effect
 * boundary. A field added to it after the fact would make the one document this
 * build writes before contacting a remote into a document it rewrites
 * afterwards, and every sentence in its header about "written before" would stop
 * being true of the bytes on disk. So the two propositions stay two documents,
 * created once each, neither ever written over.
 *
 * ── The binding digest is integrity structure, not a MAC ───────────────────
 *
 * The same bound `head-publication-authorisation.ts` states for its own, and it
 * is stated again rather than inherited quietly: every input to the digest is
 * plain text under this OS user's own profile, so anything running as this user
 * can write an outcome that reads `HISTORICAL_OUTCOME`. What the digest catches
 * is a record copied out of one event into another, a field edited in place
 * without recomputation, and a record written by a build that disagrees about
 * what the payload is. **Deletion is not caught at all.**
 *
 * One input to that digest is not in this document and cannot be: the binding
 * digest of the authorisation this outcome belongs to. It is supplied by
 * whoever reads or writes the outcome, from the authorisation record itself, so
 * an outcome moved into another event directory fails to recompute even when
 * every field of it is left alone.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { PublicationAttempt, RemoteRefReading } from './head-publication.js';

/**
 * Contract version of the record. Bump on any payload change.
 *
 * Its own version, separate from the authorisation's: a build that meets an
 * outcome it cannot read must still be able to read the authorisation beside it
 * and refuse only the outcome.
 */
export const HEAD_PUBLICATION_OUTCOME_VERSION = 1;

/**
 * The largest outcome this build will write or read back.
 *
 * The payload is a fixed set of bounded scalars — two closed vocabularies, one
 * literal, one event name, one instant and two digests — and every field's own
 * bound is below. Measured against them: a record with every field at its
 * declared maximum, in ASCII, encodes to 465 bytes. This bound is far above what
 * the contract admits, and it is checked on the encoded bytes before anything is
 * created and again on the bytes read back.
 */
export const MAX_HEAD_PUBLICATION_OUTCOME_BYTES = 4_096;

/** Domain separation, so a digest from another record type can never collide. */
const BINDING_LABEL = 'agent-orchestrator/head-publication-outcome/v1';

/** Exactly sixty-four lowercase hex digits: one SHA-256 in hex. */
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * The act this record is about. One member, and a literal rather than a free
 * string, so a second act cannot be filed here without a schema change and a
 * decision of its own.
 */
export const OUTCOME_FORGE_ACTS = ['HEAD_PUBLICATION'] as const;

export type OutcomeForgeAct = (typeof OUTCOME_FORGE_ACTS)[number];

/**
 * What this invocation did and what its last reading of the ref established.
 *
 * Nine members, and every one of them names a **call this build made** and a
 * **reading this build took**. None of them names an actor on the remote ref,
 * because no reading available here can identify one.
 *
 * The first word is the dispatch fact and it is decided by control flow alone:
 * `DISPATCHED` means the create-only publication command was handed to the
 * process boundary, and `NOT_DISPATCHED` means it was not. That is the one thing
 * on this record that is certain, and it is deliberately separated from
 * {@link PUBLICATION_COMMAND_REPORTS}, which is what the boundary said back.
 *
 * Ordered as the ladder reaches them: the four that sent nothing first, then the
 * four that sent something, and the ninth — a confirmed absence with no command
 * sent — beside its siblings rather than at the end, because it is a
 * `NOT_DISPATCHED` fact.
 */
export const PUBLICATION_OUTCOMES = [
  /**
   * No publication command was handed to the process boundary, and nothing was
   * asked of the delivery remote for this publication.
   *
   * A refusal that came before the first request is the whole of what is
   * claimed, and the cause is deliberately not named: this build reaches it from
   * a remote whose two URL lists disagree, and the same shape would carry any
   * other refusal taken before a reading. A member that named one of them would
   * be true of one producer and false of the rest, which is the rule every
   * closed vocabulary in this build is held to.
   *
   * It is also not a claim that this invocation contacted nothing at all: the
   * same command may have asked the forge other questions under other flags.
   */
  'NOT_DISPATCHED_REMOTE_NOT_ASKED',
  /**
   * A reading of the ref was taken and did not establish what the ref held, and
   * no publication command was handed to the process boundary.
   *
   * Not "the ref is not there" and not "the remote is down". It is also not a
   * claim that a request reached the delivery remote: a question that could not
   * be asked and an answer this build would not read are one reading here.
   */
  'NOT_DISPATCHED_REF_NOT_READ',
  /**
   * A reading of the ref established that it held exactly the authorised
   * commit, and no publication command was handed to the process boundary.
   *
   * Zero mutation by this invocation, and nothing about who put the commit
   * there or when. The reading is one instant, and it is the instant before this
   * record was written rather than now.
   */
  'NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT',
  /**
   * A reading of the ref established that it held a commit other than the
   * authorised one, and no publication command was handed to the process
   * boundary.
   *
   * Which commit is deliberately not recorded — see the header's note on what
   * this document carries. Nothing here names a cause: an earlier run of this
   * build at another commit and a person with a terminal look the same from
   * here.
   */
  'NOT_DISPATCHED_REF_AT_OTHER_COMMIT',
  /**
   * A reading of the ref established that it was absent, and no publication
   * command was handed to the process boundary.
   *
   * Reachable by construction rather than by this build's own ladder, which
   * pushes on exactly this reading. It exists because the classifier below is
   * total over its inputs, and a total function with an arm that answers nothing
   * is a function with a default. The suite drives this arm directly.
   */
  'NOT_DISPATCHED_REF_ABSENT',
  /**
   * The publication command was handed to the process boundary once, and the
   * reading afterwards did not establish what the ref held.
   *
   * **This is the first-class unknown**, and it is the member under which a
   * remote mutation is most likely to have happened and to be unrecorded
   * anywhere. It is not a failure, it is not "not published", and the answer to
   * it is a reading rather than a second command.
   */
  'DISPATCHED_REF_NOT_READ_AFTER',
  /**
   * The publication command was handed to the process boundary once, and the
   * reading afterwards established that the ref was absent.
   *
   * The command did not leave the ref behind, as far as one reading at one
   * instant can say. It does not establish that nothing ever existed in between,
   * and it does not establish that no process ran — {@link
   * PUBLICATION_COMMAND_REPORTS} answers that, separately and more weakly.
   */
  'DISPATCHED_REF_ABSENT_AFTER',
  /**
   * The publication command was handed to the process boundary once, and the
   * reading afterwards established that the ref held exactly the authorised
   * commit.
   *
   * The intended state was true at that instant. **This is not a claim that
   * this invocation is what made it true**, and that limit is measured rather
   * than assumed: a create of a commit a ref already holds exits zero and
   * reports the remote up to date without the lease being evaluated, so a
   * publisher that changed nothing arrives here. `L-V4-13-5`.
   */
  'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER',
  /**
   * The publication command was handed to the process boundary once, and the
   * reading afterwards established that the ref held a commit other than the
   * authorised one.
   *
   * This build cannot have put that commit there: the vector names an object
   * name on the left and carries an empty lease, which refuses an existing ref.
   * Somebody else did, and a person decides what the ref should hold.
   *
   * It does **not** say how many of them there were. An earlier draft said "two
   * writers touched this ref", and the reachable history refutes it: the
   * pre-reading found the ref absent, another actor created it at that commit
   * inside the window, and this build's command was refused — one writer wrote
   * the ref, and the vocabulary's own header forbids naming actors for exactly
   * this reason.
   */
  'DISPATCHED_REF_AT_OTHER_COMMIT_AFTER',
] as const;

export type PublicationOutcome = (typeof PUBLICATION_OUTCOMES)[number];

/**
 * What became of the one create-only publication command. A closed set of five,
 * weakest claim last.
 *
 * One member is not a report at all: `NOT_CALLED` says the command was never
 * handed to the process boundary, so there was nothing for it to report on. The
 * other four are the boundary's own words, and every sentence about "what the
 * boundary reported" is about those four — a distinction an earlier draft of the
 * operator-facing paragraph dropped, and one that matters because four of the
 * nine outcome members always pair with `NOT_CALLED`.
 *
 * Those four are **evidence about a process, never about a network**, and are kept
 * apart from {@link PUBLICATION_OUTCOMES} for the reason `doctor/exec.ts` keeps
 * `stdinDelivery` apart from `outcome`: a command can have run and a ref can be
 * absent, and both of those are true at once.
 *
 * Every member is derived from what the boundary already answers, and the
 * derivation is conservative in exactly the places the boundary's own contract
 * says it must be. In particular a refused launch is **not** proof that nothing
 * ran: `doctor/exec.ts` answers `started` "`false` only where the boundary
 * proved the target never ran, and `true` for `YES` and for `UNKNOWN` alike",
 * and a timeout has a producer in which the boundary was never established at
 * all. Both therefore land on the weakest member here.
 */
export const PUBLICATION_COMMAND_REPORTS = [
  /** No publication command was handed to the boundary, so it reported nothing. */
  'NOT_CALLED',
  /**
   * The boundary reported that there was nothing to run, so no process for this
   * command was ever created.
   *
   * The one member that establishes a **negative** about the process, and the
   * only outcome in the boundary's vocabulary that does.
   *
   * Three producers, and the negative holds for all three — which is worth
   * writing down, because an earlier draft named only the first and a review
   * counted them. `doctor/exec.ts` answers it when nothing was found to run at
   * all, which is decided before either platform path is taken; and on the
   * unowned path when the launch itself failed with the errno for a missing
   * target, either synchronously or on the child's own error. All three set
   * `started: false`, and a launch that failed that way is one whose target
   * never began. The owned Windows path cannot produce it: a refusal there is a
   * refused launch, which lands on the weakest member below.
   */
  'NO_PROCESS',
  /** The boundary reported a process that ran and ended with status zero. */
  'RAN_TO_EXIT_ZERO',
  /**
   * The boundary reported a process that ran and did not end with status zero —
   * it exited non-zero, or a byte budget ended it.
   *
   * A process existed. What it did before it ended is not established here.
   */
  'RAN_TO_ANOTHER_ENDING',
  /**
   * The boundary did not establish whether a process ran, or how it ended.
   *
   * Every conservative case folds here and the folding is the point: a launch
   * the boundary refused may still have run its target, a run that exceeded its
   * deadline may never have been established at all, a boundary this build
   * cannot account for may have run everything, and a report this build does not
   * recognise establishes nothing whatsoever.
   */
  'ENDING_NOT_ESTABLISHED',
] as const;

export type PublicationCommandReport = (typeof PUBLICATION_COMMAND_REPORTS)[number];

/**
 * The identity an outcome is read *under*, supplied by the reader and never
 * taken from the outcome.
 *
 * Four fields and three of them come from somewhere other than this document:
 * the event directory's own name, and the task and checkout the **authorisation
 * record** names. The fourth is the authorisation's own binding digest, which
 * on the reading path is a value the reader has just recomputed and found equal
 * — so using it as the anchor is not a tautology, and an outcome cannot be
 * moved from one event to another without failing to recompute.
 *
 * Reading any of these out of the outcome and checking it against itself would
 * make the check evidence for whatever the outcome happened to say. That is the
 * mistake `head-publication-authorisation.ts` states for its own subject, and it
 * is repeated here because the two documents are graded by two functions.
 */
export interface HeadPublicationOutcomeSubject {
  /** The event directory's own name. Binds the outcome to where it sits. */
  readonly eventId: string;
  /** The task the authorisation record names. Never read from the outcome. */
  readonly taskId: string;
  /** The checkout the authorisation record names. Never read from the outcome. */
  readonly repositoryRoot: string;
  /** The authorisation record's own binding digest. Never read from the outcome. */
  readonly authorisationBinding: string;
}

const OutcomeSchema = z
  .object({
    outcomeVersion: z.literal(HEAD_PUBLICATION_OUTCOME_VERSION),
    eventId: z.string().min(1).max(128),
    act: z.enum(OUTCOME_FORGE_ACTS),
    outcome: z.enum(PUBLICATION_OUTCOMES),
    commandReport: z.enum(PUBLICATION_COMMAND_REPORTS),
    recordedAt: z.string().min(1).max(64),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict();

export type HeadPublicationOutcomeRecord = z.infer<typeof OutcomeSchema>;

/** Everything except the binding — what the binding is computed over. */
export type HeadPublicationOutcomePayload = Omit<HeadPublicationOutcomeRecord, 'binding'>;

/**
 * The binding digest for one payload under one subject.
 *
 * The inputs are listed one by one rather than as `JSON.stringify(payload)`,
 * because that would make the digest depend on key order — the rule every other
 * binding in this build follows, shared by repetition rather than by a helper,
 * since a helper taking an object would have the same problem.
 *
 * Note what is bound without being carried: the task, the checkout and the whole
 * of the authorisation's own payload — its act, forge identity, remote, ref and
 * commit — reach this digest through `subject.authorisationBinding`, which is a
 * digest over all of them. Duplicating those fields into this document would add
 * a second place for them to be edited and a second place for them to disagree,
 * and would buy nothing the anchor does not already buy.
 */
export function headPublicationOutcomeBinding(
  subject: HeadPublicationOutcomeSubject,
  payload: HeadPublicationOutcomePayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.eventId,
        subject.taskId,
        subject.repositoryRoot,
        subject.authorisationBinding,
        payload.outcomeVersion,
        payload.eventId,
        payload.act,
        payload.outcome,
        payload.commandReport,
        payload.recordedAt,
      ]),
    )
    .digest('hex');
}

/**
 * What a stored outcome turned out to be. A closed set of five, of which one
 * means "structurally valid historical evidence" — and see the header for what
 * even that one does not mean.
 *
 * The good member is **not** called `VALID`, `SUCCESS` or `PUBLISHED`. It is
 * named for what it is: one invocation's own history, read back.
 */
export const HEAD_PUBLICATION_OUTCOME_READINGS = [
  /**
   * A well-formed, current-version outcome bound to this exact event, task,
   * checkout and authorisation: **at `recordedAt`, this invocation had done
   * this and seen this.** It establishes nothing about now.
   */
  'HISTORICAL_OUTCOME',
  /** No outcome here. Absence of a record, never a record of absence. */
  'ABSENT',
  /** Something is there and is not an outcome this build declares. */
  'MALFORMED',
  /** An outcome version this build does not know how to read. Refused, never guessed. */
  'UNSUPPORTED_VERSION',
  /**
   * Well-formed, and the binding says it belongs to a different event or to a
   * different authorisation — or a field was edited without recomputing the
   * digest.
   */
  'NOT_THIS_EVENT',
] as const;

export type HeadPublicationOutcomeReading = (typeof HEAD_PUBLICATION_OUTCOME_READINGS)[number];

/**
 * One readable outcome, as this module hands it out.
 *
 * Every field of the stored document is here, and one of them is **renamed**:
 * `eventId` becomes `recordedEventId`, so a reader that prints it cannot be
 * mistaken for one printing the name of the directory it sits in. The rest keep
 * their names — unlike the authorisation's view, no field here is structurally
 * an argument to the publication mint, and renaming for its own sake would be a
 * second vocabulary to keep in step.
 */
export interface RecordedPublicationOutcome {
  readonly outcomeVersion: number;
  /** The `eventId` the document carries. The name it is filed under is the entry's. */
  readonly recordedEventId: string;
  readonly act: OutcomeForgeAct;
  readonly outcome: PublicationOutcome;
  readonly commandReport: PublicationCommandReport;
  /**
   * The instant the outcome says it was written.
   *
   * Displayed exactly as recorded and checked against nothing: the contract
   * bounds this as a string of at most 64 characters, so it is not established
   * to be a date, and nothing compares it with the instant in the event name or
   * with the authorisation's own.
   */
  readonly recordedAt: string;
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
const OUTCOME_FIELD: Readonly<
  Record<keyof HeadPublicationOutcomeRecord, keyof RecordedPublicationOutcome>
> = Object.freeze({
  outcomeVersion: 'outcomeVersion',
  eventId: 'recordedEventId',
  act: 'act',
  outcome: 'outcome',
  commandReport: 'commandReport',
  recordedAt: 'recordedAt',
  binding: 'binding',
});

/**
 * The rename, exported as pairs so the suite can pin the correspondence rather
 * than restate it. Pairs and not the object it is built from, for the reason
 * `head-publication-authorisation.ts` gives about its own: a `Record` keyed by a
 * record's field names is itself a value some other function may accept
 * structurally.
 */
export const HEAD_PUBLICATION_OUTCOME_RECORD_FIELDS: readonly (readonly [
  keyof HeadPublicationOutcomeRecord,
  keyof RecordedPublicationOutcome,
])[] = Object.freeze(
  Object.entries(OUTCOME_FIELD).map(([from, to]) => Object.freeze([from, to])) as readonly (readonly [
    keyof HeadPublicationOutcomeRecord,
    keyof RecordedPublicationOutcome,
  ])[],
);

function view(record: HeadPublicationOutcomeRecord): RecordedPublicationOutcome {
  return Object.freeze({
    outcomeVersion: record.outcomeVersion,
    recordedEventId: record.eventId,
    act: record.act,
    outcome: record.outcome,
    commandReport: record.commandReport,
    recordedAt: record.recordedAt,
    binding: record.binding,
  });
}

/**
 * What one grading produced. The record is present on exactly one member and is
 * `null` on every other, enforced by the type rather than by care: there is no
 * way to reach a field of an outcome this build refused.
 */
export type HeadPublicationOutcomeInspection =
  | {
      readonly reading: 'HISTORICAL_OUTCOME';
      readonly record: RecordedPublicationOutcome;
    }
  | {
      readonly reading: Exclude<HeadPublicationOutcomeReading, 'HISTORICAL_OUTCOME'>;
      readonly record: null;
    };

type Graded =
  | { readonly reading: 'HISTORICAL_OUTCOME'; readonly record: HeadPublicationOutcomeRecord }
  | {
      readonly reading: Exclude<HeadPublicationOutcomeReading, 'HISTORICAL_OUTCOME'>;
      readonly record: null;
    };

/**
 * The one grader. Both entry points below are this function, so there is a
 * single parser, a single version gate and a single binding comparison in this
 * build.
 *
 * Unlike the authorisation's grader there is no "whose identity is this read
 * under?" parameter, and that is a consequence of the shape rather than a
 * choice: this document carries no task and no checkout, so there is nothing a
 * reader could take out of it even if it wanted to. The subject is always
 * entirely external.
 */
function grade(bytes: Buffer, subject: HeadPublicationOutcomeSubject): Graded {
  if (bytes.byteLength === 0) return { reading: 'ABSENT', record: null };
  if (bytes.byteLength > MAX_HEAD_PUBLICATION_OUTCOME_BYTES) {
    return { reading: 'MALFORMED', record: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { reading: 'MALFORMED', record: null };
  }

  // The version is read before the contract, so an outcome written by a later
  // build is answered as a version this one does not understand rather than as
  // a malformed document. The two send a person to different places.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('outcomeVersion' in parsed)
  ) {
    return { reading: 'MALFORMED', record: null };
  }
  const version = (parsed as { readonly outcomeVersion: unknown }).outcomeVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { reading: 'MALFORMED', record: null };
  }
  if (version !== HEAD_PUBLICATION_OUTCOME_VERSION) {
    return { reading: 'UNSUPPORTED_VERSION', record: null };
  }

  const contract = OutcomeSchema.safeParse(parsed);
  if (!contract.success) return { reading: 'MALFORMED', record: null };

  const { binding, ...payload } = contract.data;

  // The two event identities must agree, and the binding does not make them.
  //
  // It covers both — `subject.eventId` and `payload.eventId` are separate
  // inputs — so a digest recomputed over a *pair* that disagrees is
  // self-consistent and recomputes cleanly. The writer never produces such a
  // pair: it sets both from one value. So an outcome whose own `eventId`
  // differs from the identity it is read under cannot have come from this
  // build's writer, and `HISTORICAL_OUTCOME` about it would be this reader's
  // strongest sentence about a document it can prove it did not write. The
  // authorisation's grader learned this the same way, in review.
  if (payload.eventId !== subject.eventId) return { reading: 'NOT_THIS_EVENT', record: null };

  if (headPublicationOutcomeBinding(subject, payload) !== binding) {
    return { reading: 'NOT_THIS_EVENT', record: null };
  }
  return { reading: 'HISTORICAL_OUTCOME', record: contract.data };
}

/**
 * Grades bytes that claim to be one event's outcome, and answers with a reading
 * alone.
 *
 * The form the writer uses, to judge the bytes it built before it creates
 * anything and to judge the bytes it read back afterwards. Total and offline.
 * Never throws, never repairs, never rewrites.
 */
export function readHeadPublicationOutcome(
  bytes: Buffer,
  subject: HeadPublicationOutcomeSubject,
): HeadPublicationOutcomeReading {
  return grade(bytes, subject).reading;
}

/**
 * Grades bytes found beside one authorisation record, and hands back the view
 * on the one reading that carries a record.
 *
 * The form the operator-facing listing uses. Its `subject` is built from the
 * event directory's own name and from the authorisation record the listing has
 * just read and whose binding it has just recomputed — never from these bytes.
 */
export function inspectHeadPublicationOutcome(
  bytes: Buffer,
  subject: HeadPublicationOutcomeSubject,
): HeadPublicationOutcomeInspection {
  const graded = grade(bytes, subject);
  return graded.reading === 'HISTORICAL_OUTCOME'
    ? { reading: 'HISTORICAL_OUTCOME', record: view(graded.record) }
    : { reading: graded.reading, record: null };
}

/**
 * What this invocation did and last saw, from the three facts the publication
 * path already holds.
 *
 * Pure, total over its inputs, and deliberately **not** a translation of
 * `HeadPublication`. The grader upstream answers "is the delivery remote holding
 * this commit under this ref"; this answers "what did this invocation call, and
 * what did its last reading establish". They are two questions about one set of
 * readings, and mapping one onto the other would make a change to either into a
 * silent change to the other. What the suite pins instead is that the two never
 * *disagree* about the one thing they share — whether the ref was observed at
 * the authorised commit.
 *
 * `before === null` means no reading was taken at all. Three shapes of the
 * publication path produce it — an authority refused at the effect, a local
 * subject that moved, and a remote whose two URL lists disagree — and only the
 * third is reachable with an authorisation record already on disk, because the
 * other two are decided before the record is written. The sentence on
 * `NOT_DISPATCHED_REMOTE_NOT_ASKED` is written to hold for all three anyway,
 * because this function is exported and total and does not get to assume its
 * caller.
 */
export function publicationOutcomeFor(
  expectedCommit: string,
  before: RemoteRefReading | null,
  attempt: PublicationAttempt,
  after: RemoteRefReading | null,
): PublicationOutcome {
  if (attempt === 'NOT_ATTEMPTED') {
    if (before === null) return 'NOT_DISPATCHED_REMOTE_NOT_ASKED';
    if (before.outcome === 'UNKNOWN') return 'NOT_DISPATCHED_REF_NOT_READ';
    if (before.outcome === 'ABSENT') return 'NOT_DISPATCHED_REF_ABSENT';
    return before.commit === expectedCommit
      ? 'NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT'
      : 'NOT_DISPATCHED_REF_AT_OTHER_COMMIT';
  }

  if (after === null || after.outcome === 'UNKNOWN') return 'DISPATCHED_REF_NOT_READ_AFTER';
  if (after.outcome === 'ABSENT') return 'DISPATCHED_REF_ABSENT_AFTER';
  return after.commit === expectedCommit
    ? 'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER'
    : 'DISPATCHED_REF_AT_OTHER_COMMIT_AFTER';
}

/**
 * The outcomes under which the publication command was handed to the process
 * boundary.
 *
 * Held as a set rather than as a string test on the name, so that adding a
 * member to the vocabulary cannot silently widen or narrow it: the suite
 * partitions {@link PUBLICATION_OUTCOMES} against this set and fails on any
 * member neither side claims.
 */
export const DISPATCHED_PUBLICATION_OUTCOMES: ReadonlySet<PublicationOutcome> = Object.freeze(
  new Set<PublicationOutcome>([
    'DISPATCHED_REF_NOT_READ_AFTER',
    'DISPATCHED_REF_ABSENT_AFTER',
    'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER',
    'DISPATCHED_REF_AT_OTHER_COMMIT_AFTER',
  ]),
) as ReadonlySet<PublicationOutcome>;

/** Whether the create-only publication command was handed to the process boundary. */
export function publicationCommandWasDispatched(outcome: PublicationOutcome): boolean {
  return DISPATCHED_PUBLICATION_OUTCOMES.has(outcome);
}

/**
 * The outcomes whose last reading established that the ref held the authorised
 * commit.
 *
 * Two members and three provenances, and none of them is authorship. A caller
 * that wants to know whether the ref was seen at the commit asks this rather
 * than comparing names, for the reason `ESTABLISHED_HEAD_PUBLICATIONS` exists.
 */
export const REF_OBSERVED_AT_SUBJECT_COMMIT: ReadonlySet<PublicationOutcome> = Object.freeze(
  new Set<PublicationOutcome>([
    'NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT',
    'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER',
  ]),
) as ReadonlySet<PublicationOutcome>;
