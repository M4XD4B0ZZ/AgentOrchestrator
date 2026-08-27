/**
 * The durable record of one unattended head-publication authorisation, and the
 * exact sentence it is allowed to assert (V4 slice 14).
 *
 * ── The one sentence ───────────────────────────────────────────────────────
 *
 * > At `authorisedAt`, an invocation of this build established — from the
 * > trusted operator declaration whose exact bytes are `declarationDigest` —
 * > that automatic head publication was permitted for `{host, owner, name}`,
 * > and resolved `{taskId, repositoryRoot, declaredRemote, ref, commit}` as the
 * > subject of the one create-only publication it was then authorised to
 * > attempt. These bytes were written before this invocation contacted the
 * > delivery remote at all.
 *
 * Every clause of that is a fact this build held in its hand at the moment of
 * writing. What follows is the list of sentences it is **not**, each of which
 * was reachable from an earlier draft of this file.
 *
 * ── What it does not say, and why each one is unprovable ───────────────────
 *
 *  - **not "a publication was attempted".** The record is written before the
 *    two `git remote get-url` reads and before the `ls-remote` that decides
 *    whether anything is sent at all. A run that finds the ref already at this
 *    commit, or holding another one, or a remote whose two URLs disagree, or one
 *    whose ref cannot be read at all, sends nothing — and leaves this record
 *    behind. That is a valid historical shape, not a defect, and the vocabulary
 *    has to survive it;
 *  - **not "the ref exists"**, and **not "this build created it"**. That second
 *    one is measured false rather than merely unproven: a create of a commit a
 *    ref already holds exits zero and reports the remote up to date without the
 *    empty lease being evaluated, so a publisher that changed nothing can be
 *    graded `PUBLISHED`. `L-V4-13-5`. Nothing in this record may be read as
 *    strengthening that grade;
 *  - **not "the operator permits this now".** It names the bytes of one read at
 *    one instant. The declaration is an ordinary file and can change in the
 *    next millisecond — including inside the window between this record and the
 *    push, which is `L-V4-13-4` and is unchanged by this slice;
 *  - **not "an attempt is outstanding".** There is no state field, no phase, no
 *    `PENDING`, no expiry and no attempt counter. A record with no mutable field
 *    has no state machine, so there is nothing here for a later slice to resume
 *    from — which is the structural half of "audit is never authority";
 *  - **not "this record permits a publication".** Nothing on any authority path
 *    reads it. A future unattended attempt needs a new invocation that asks, a
 *    declaration that still permits, a freshly resolved subject, a fresh reading
 *    of the remote and a fresh one-shot grant. The record is evidence for a
 *    person, and this build's own history is why that sentence is here: the
 *    delivery observation record carries the same rule for the same reason.
 *
 * ── The binding digest is integrity structure, not a MAC ───────────────────
 *
 * {@link HeadPublicationAuthorisation.binding} is a digest over the payload
 * together with the identity of the event it belongs to. Every input to it is
 * plain text sitting beside it, so **anyone who can create a file in the store
 * can write a record that reads `HISTORICAL_AUTHORISATION`**, having authorised
 * nothing. There is no key material anywhere in this build to do better, and
 * inventing some would be a decision about key storage, permissions, rotation
 * and compromise that is larger than this slice.
 *
 * What the digest does catch is the realistic damage: a record copied out of one
 * event into another, a field edited in place without recomputation, and a
 * record written by a build that disagrees with this one about what the payload
 * is. The same bound `lease/containment-evidence.ts` states for its own record,
 * and it is stated here rather than inherited quietly.
 *
 * **Deletion is not caught at all.** An absent record and a record that never
 * existed are the same bytes.
 *
 * ── What is deliberately not in it ─────────────────────────────────────────
 *
 * No URL. `host`, `owner` and `name` are the forge identity the delivery target
 * parsed out of the remote's URL, and they are the whole of what this record
 * takes from it: no scheme, no userinfo, no port, no path and no query — the
 * delivery target refuses to record any of those, because a URL is the value
 * most likely to carry a credential, and the push vector names a bare remote for
 * the same reason. No bytes of the declaration and no entry of it other than the
 * one that matched: the file may name many repositories and none of the others
 * is this event's business. No subprocess output. No foreign exception message.
 * No repository-authored prose — no task title, no brief, no findings. No path
 * to the declaration, and no operator user name **as a field of its own** —
 * `repositoryRoot` is a local path and on Windows an ordinary checkout under the
 * user profile embeds one, which is stated here rather than claimed away.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { MAX_TASK_ID_LENGTH } from '../plan/task-id.js';

/**
 * Contract version of the record. Bump on any payload change.
 *
 * Its own version, separate from the declaration's `schemaVersion` and from the
 * task state's: a build that meets a record it cannot read must still be able to
 * read the task, grade the declaration and refuse only the record.
 */
export const HEAD_PUBLICATION_AUTHORISATION_VERSION = 1;

/**
 * The largest record this build will write or read back.
 *
 * The payload is a fixed set of bounded scalars — no arrays, no free text — and
 * every field's own bound is below. Measured against them: a record with every
 * field at its declared maximum, in ASCII, encodes to 5,852 bytes, so this bound
 * is above what the contract admits rather than merely above what it produces in
 * practice. It can still be reached, because JSON escaping is per character and
 * a `repositoryRoot` of 4,096 characters that all need escaping does not fit —
 * and such a record is refused rather than written.
 *
 * Checked on the encoded bytes before anything is created, and again on the
 * bytes read back.
 */
export const MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES = 8_192;

/** Domain separation, so a digest from another record type can never collide. */
const BINDING_LABEL = 'agent-orchestrator/head-publication-authorisation/v1';

/** Forty or sixty-four lowercase hex digits, anchored. The object name grammar. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Exactly sixty-four lowercase hex digits: one SHA-256 in hex. */
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * The act this record is about. One member, and it is a literal rather than a
 * free string so a second act cannot be filed here without a schema change and
 * a decision of its own.
 */
export const AUDITED_FORGE_ACTS = ['HEAD_PUBLICATION'] as const;

export type AuditedForgeAct = (typeof AUDITED_FORGE_ACTS)[number];

/**
 * The invocation shape this record is about. One member.
 *
 * `ATTENDED` is deliberately absent. An attended publication is performed with
 * a person present and needs no accountability record to answer "why did this
 * branch appear?" — they were there. Widening this vocabulary would be widening
 * the slice, and it would make the attended path depend on a store it has never
 * needed.
 */
export const AUDITED_INVOCATION_MODES = ['AUTOMATIC'] as const;

export type AuditedInvocationMode = (typeof AUDITED_INVOCATION_MODES)[number];

/**
 * The identity a record is read *under*, supplied by the reader and never taken
 * from the record.
 *
 * Separate from the payload on purpose. Reading the identity out of the record
 * and then checking it against itself would make the check a tautology: the
 * record would be evidence for whatever the record said, and one filed against
 * another event or another task would read as valid.
 */
export interface HeadPublicationAuthorisationSubject {
  /** The event directory's own name. Binds the record to where it sits. */
  readonly eventId: string;
  readonly taskId: string;
  readonly repositoryRoot: string;
}

const AuthorisationSchema = z
  .object({
    authorisationVersion: z.literal(HEAD_PUBLICATION_AUTHORISATION_VERSION),
    eventId: z.string().min(1).max(128),
    act: z.enum(AUDITED_FORGE_ACTS),
    invocationMode: z.enum(AUDITED_INVOCATION_MODES),
    /** Derived from the task-id contract rather than chosen, so the two cannot drift. */
    taskId: z.string().min(1).max(MAX_TASK_ID_LENGTH),
    /** The bound every sibling delivery record uses for the same value. */
    repositoryRoot: z.string().min(1).max(4096),
    host: z.string().min(1).max(253),
    /** The bound the operator's declaration puts on this value. */
    owner: z.string().min(1).max(100),
    /** The bound the operator's declaration puts on this value. */
    name: z.string().min(1).max(100),
    /** The **local** name of the remote. Never a URL; see the header. */
    declaredRemote: z.string().min(1).max(100),
    ref: z.string().min(1).max(300),
    commit: z.string().regex(OBJECT_NAME, 'Must be an object name.'),
    declarationSchemaVersion: z.literal(1),
    /** The matched entry's own permission member, as written by the operator. */
    declaredPermission: z.literal('AUTOMATIC_ALLOWED'),
    declarationDigest: z.string().regex(HEX_64, 'Must be a digest.'),
    authorisedAt: z.string().min(1).max(64),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict();

export type HeadPublicationAuthorisation = z.infer<typeof AuthorisationSchema>;

/** Everything except the binding — what the binding is computed over. */
export type HeadPublicationAuthorisationPayload = Omit<HeadPublicationAuthorisation, 'binding'>;

/**
 * The binding digest for one payload under one subject.
 *
 * The inputs are listed one by one rather than as `JSON.stringify(payload)`,
 * because that would make the digest depend on key order — the rule every other
 * binding in this build follows, shared by repetition rather than by a helper,
 * since a helper taking an object would have the same problem.
 */
export function headPublicationAuthorisationBinding(
  subject: HeadPublicationAuthorisationSubject,
  payload: HeadPublicationAuthorisationPayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.eventId,
        subject.taskId,
        subject.repositoryRoot,
        payload.authorisationVersion,
        payload.eventId,
        payload.act,
        payload.invocationMode,
        payload.taskId,
        payload.repositoryRoot,
        payload.host,
        payload.owner,
        payload.name,
        payload.declaredRemote,
        payload.ref,
        payload.commit,
        payload.declarationSchemaVersion,
        payload.declaredPermission,
        payload.declarationDigest,
        payload.authorisedAt,
      ]),
    )
    .digest('hex');
}

/**
 * What a stored record turned out to be. A closed set of five, of which one
 * means "structurally valid historical evidence" — and see the header for what
 * even that one does not mean.
 *
 * The good member is **not** called `VALID`, `CURRENT` or `AUTHORISED`. A member
 * named `AUTHORISED` is a member somebody switches on to authorise something,
 * and this record may never be an input to an authority.
 */
export const HEAD_PUBLICATION_AUTHORISATION_READINGS = [
  /**
   * A well-formed, current-version record bound to this exact event, task and
   * repository: **at `authorisedAt`, this was established.** It establishes
   * nothing about now, and nothing about what happened afterwards.
   */
  'HISTORICAL_AUTHORISATION',
  /** No record here. Absence of a record, never a record of absence. */
  'ABSENT',
  /** Something is there and is not a record this build declares. */
  'MALFORMED',
  /** A record version this build does not know how to read. Refused, never guessed. */
  'UNSUPPORTED_VERSION',
  /**
   * Well-formed, and the binding says it belongs to a different event, task or
   * repository — or a field was edited without recomputing the digest.
   */
  'NOT_THIS_EVENT',
] as const;

export type HeadPublicationAuthorisationReading =
  (typeof HEAD_PUBLICATION_AUTHORISATION_READINGS)[number];

/**
 * What one grading produced: the answer, and — only on the good answer — the
 * record it read.
 *
 * The record is `null` on every other member, and that is a property of the type
 * rather than a convention: a caller cannot reach the fields of a record this
 * build refused, so there is no path along which an unreadable event's values
 * get displayed as though they had been established.
 */
export type HeadPublicationAuthorisationInspection =
  | {
      readonly reading: 'HISTORICAL_AUTHORISATION';
      readonly record: HeadPublicationAuthorisation;
    }
  | {
      readonly reading: Exclude<HeadPublicationAuthorisationReading, 'HISTORICAL_AUTHORISATION'>;
      readonly record: null;
    };

/**
 * How the identity a record is graded *under* is obtained.
 *
 * Two callers need two answers, and the difference is the whole of what
 * separates {@link readHeadPublicationAuthorisation} from
 * {@link inspectHeadPublicationAuthorisation}. It is a function of the parsed
 * document rather than a value, because the second caller cannot build the
 * subject until the bytes have parsed — and it is applied *after* the contract
 * has been satisfied, so it is never handed an unvalidated shape.
 */
type SubjectFor = (
  payload: HeadPublicationAuthorisationPayload,
) => HeadPublicationAuthorisationSubject;

/**
 * The one grader. Both entry points below are this function under a different
 * answer to "whose identity is this record read under?", so there is a single
 * parser, a single version gate and a single binding comparison in this build.
 */
function grade(bytes: Buffer, subjectFor: SubjectFor): HeadPublicationAuthorisationInspection {
  if (bytes.byteLength === 0) return { reading: 'ABSENT', record: null };
  if (bytes.byteLength > MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES) {
    return { reading: 'MALFORMED', record: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { reading: 'MALFORMED', record: null };
  }

  // The version is read before the contract, so a record written by a later
  // build is answered as a version this one does not understand rather than as
  // a malformed document. The two send a person to different places.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('authorisationVersion' in parsed)
  ) {
    return { reading: 'MALFORMED', record: null };
  }
  const version = (parsed as { readonly authorisationVersion: unknown }).authorisationVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { reading: 'MALFORMED', record: null };
  }
  if (version !== HEAD_PUBLICATION_AUTHORISATION_VERSION) {
    return { reading: 'UNSUPPORTED_VERSION', record: null };
  }

  const contract = AuthorisationSchema.safeParse(parsed);
  if (!contract.success) return { reading: 'MALFORMED', record: null };

  const { binding, ...payload } = contract.data;
  if (headPublicationAuthorisationBinding(subjectFor(payload), payload) !== binding) {
    return { reading: 'NOT_THIS_EVENT', record: null };
  }
  return { reading: 'HISTORICAL_AUTHORISATION', record: contract.data };
}

/**
 * Grades bytes that claim to be one event's authorisation record, under an
 * identity the caller establishes for itself.
 *
 * Total and offline. Never throws, never repairs, never rewrites: a record this
 * build cannot read is reported, and the file is left exactly as it is.
 *
 * This is the form the writer uses, and the subject it passes came from the
 * facts the publication was authorised against — never from the document. That
 * is the point: a record read under an identity taken out of itself would be
 * evidence for whatever it happened to say.
 */
export function readHeadPublicationAuthorisation(
  bytes: Buffer,
  subject: HeadPublicationAuthorisationSubject,
): HeadPublicationAuthorisationReading {
  return grade(bytes, () => subject).reading;
}

/**
 * Grades bytes found at one event directory, for a reader that has no
 * independent knowledge of the task or the repository — and says so.
 *
 * An operator listing the store is exactly that reader: the record is the only
 * evidence there is about which task and which checkout an event was about, so
 * those two halves of the subject are taken from the document, and `eventId` —
 * the directory's own name — is the one half that is not.
 *
 * What that costs, stated exactly rather than left to be discovered. The
 * comparison is still not a tautology, and this was measured rather than
 * reasoned: because every field is also an input to the digest in its own right,
 * an edit to `taskId` or `repositoryRoot` changes the digest inputs even when
 * the subject is rebuilt from the edited document, and a record moved into
 * another event directory is refused on the name that directory has. What it
 * cannot catch is what {@link headPublicationAuthorisationBinding} never could:
 * a whole record recomputed by somebody who can write in the store. There is no
 * key material in this build, so a valid binding is an integrity statement and
 * never an authentication one.
 */
export function inspectHeadPublicationAuthorisation(
  bytes: Buffer,
  eventId: string,
): HeadPublicationAuthorisationInspection {
  return grade(bytes, (payload) => ({
    eventId,
    taskId: payload.taskId,
    repositoryRoot: payload.repositoryRoot,
  }));
}
