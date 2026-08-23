/**
 * Durable delivery evidence: the versioned record of one forge observation, and
 * the vocabulary for reading one back.
 *
 * ── The question this exists to make answerable ────────────────────────────
 *
 * Slice 2 can answer "at this moment, AO observed X about exact subject Y". The
 * process then ends and the fact is gone. A later merge-policy slice needs to
 * tell apart:
 *
 *     "AO has never observed this"
 *
 * from
 *
 *     "AO observed this exact pull request, head and check state at time T."
 *
 * This module is that statement's format, and nothing else. It decides nothing
 * about whether the evidence is sufficient for anything.
 *
 * ── A stored observation is a HISTORICAL SNAPSHOT. This is the whole rule ──
 *
 * Persistence does not freeze GitHub. At 14:00 this record may say the checks
 * were `SUCCESS`; at 14:01 a new check can start, an existing one can fail, the
 * pull request can close, the head can move, a force-push can land, or the
 * repository's review requirements can change. The bytes on disk know none of
 * that.
 *
 * Therefore, and these are not slogans but the reason every name below reads
 * the way it does:
 *
 *     STORED SUCCESS      is not  CURRENT SUCCESS
 *     STORED PR MATCH     is not  CURRENT PR MATCH
 *     A RECENT TIMESTAMP  is not  FRESHNESS
 *
 * {@link observedAt} is evidence of **when** the forge was asked. It is not
 * evidence that the answer remains true, and no interval makes it so — which is
 * why nothing in this build compares it against a threshold, and why there is
 * deliberately no TTL. A time-to-live would be an invented number dressed up as
 * safety: it would license acting on a stale answer for as long as somebody
 * guessed, and it would refuse a still-correct answer the moment the guess
 * expired. Neither behaviour is derivable from anything GitHub tells us.
 *
 * The vocabulary reflects that. The good reading is `HISTORICAL_VALID`, never
 * `VALID` and never `CURRENT`. No function here is named or documented as
 * answering "what is true now", because none of them can, and a name that
 * implied it would be the whole defect.
 *
 * ── Local validity and remote freshness are different questions ────────────
 *
 * There are three states a caller must be able to tell apart, and only two of
 * them are decidable from bytes:
 *
 *  A. **Structurally valid historical evidence.** The record parses, is of a
 *     version this build knows, belongs to this task and this target, names the
 *     expected exact subject, is internally consistent, and came from a
 *     completed observation. That is `HISTORICAL_VALID`, and it is decided
 *     offline.
 *  B. **Locally stale or mismatched.** The task moved under the record — a new
 *     `currentCommit`, a different task, a delivery target that now resolves
 *     elsewhere, a record version this build does not know, or a record whose
 *     own fields contradict each other. Every one of those is decided offline
 *     too, and each has its own member below.
 *  C. **Remote freshness unknown.** The record is internally valid and locally
 *     bound, and AO has not freshly asked GitHub whether the external facts
 *     still hold.
 *
 * **C is not a member of the vocabulary, and that is deliberate.** It is not a
 * reading a file can produce: it is true of *every* reading, always, including
 * `HISTORICAL_VALID`. Making it a member would let a caller `switch` its way
 * past it, and would suggest there is some other reading for which freshness
 * *is* established. There is not. {@link REMOTE_FRESHNESS_SENTENCE} says so in
 * the operator's own words, and it is exported so the report cannot forget it.
 *
 * ── What the binding digest is, stated exactly ─────────────────────────────
 *
 * {@link DeliveryEvidence.binding} is an **integrity binding, not a message
 * authentication code**, and the difference is worth being blunt about because
 * the reassuring reading of it is wrong.
 *
 * It is a digest over the evidence payload together with the identity of the
 * task it belongs to. Every input to it is derivable by anyone who can read the
 * repository, so an author who can write this file can also recompute the
 * digest. It does not withstand that author and is not offered as though it
 * does. **Anyone who can create a file in the repository's runtime directory
 * can write a record that reads `HISTORICAL_VALID`**, having observed nothing.
 * The in-process mint (`internal/delivery-observation-proof.ts`) is what stops
 * *product code* manufacturing one; it does nothing about the filesystem, and
 * this is why the record may never be read as authority.
 *
 * What the digest does catch is everything short of that, which is the
 * realistic damage: a record copied from one task into another, a field edited
 * in place without recomputation, and a record written by a build that
 * disagrees with this one about what the payload is.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Contract version of the delivery evidence record. Bump on any payload change.
 *
 * Deliberately its own version, separate from `TASK_STATE_SCHEMA_VERSION`. The
 * task state's version governs whether the *task* can be read at all — a bump
 * there locks every existing task out, which is the right severity for the
 * durable record of a run and the wrong one for a change to an observation
 * note. A build that meets an unknown evidence version must still be able to
 * read the task, report its state, and refuse the evidence.
 */
export const DELIVERY_EVIDENCE_VERSION = 1;

/**
 * The largest record this build will write or read back.
 *
 * Small on purpose. The payload is a fixed set of scalars — no arrays, no free
 * text, no forge payload — so anything approaching this bound is not a record
 * this build produced. Checked on the encoded bytes before anything is touched,
 * and again on the bytes read back, so a record that grew on disk is refused
 * rather than parsed.
 */
export const MAX_DELIVERY_EVIDENCE_BYTES = 8_192;

const HEX_64 = /^[0-9a-f]{64}$/;
const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The pull-request outcomes a record may carry, and the check outcomes.
 *
 * Both lists are exactly the *settled* members of slice 2's vocabularies. Every
 * shared refusal is absent, and the absence is the contract: there is no record
 * shape in which `NOT_AUTHENTICATED` or `REQUEST_FAILED` can be stored, because
 * nothing was observed. A refusal is not a weaker observation to be written
 * down with a caveat; it is the absence of one, and the honest durable form of
 * it is no record at all.
 */
export const RECORDABLE_PULL_REQUEST_OUTCOMES = [
  'MATCHED',
  'NO_MATCHING_PULL_REQUEST',
  'AMBIGUOUS',
] as const;

export const RECORDABLE_CHECK_OUTCOMES = ['SUCCESS', 'PENDING', 'FAILED', 'NO_CHECKS'] as const;

/**
 * The record.
 *
 * `.strict()`, so a field this build does not declare makes the record
 * `MALFORMED` rather than being ignored — a record carrying something extra was
 * written by something that is not this build, and reading the part we
 * recognise out of it would be reading half of somebody else's document.
 *
 * ── What is deliberately not here ─────────────────────────────────────────
 *
 * No token, no `Authorization` header, no raw `gh` output, no stderr, no exit
 * code, no URL of any kind, no environment snapshot, no arbitrary GitHub JSON.
 * That is not enforced by a filter — it is enforced by the shape: the only way
 * to build this payload is from {@link DeliveryObservationFacts}, which has no
 * field any of those could travel in.
 *
 * No branch name either. A branch is a mutable pointer, and a record that
 * identified its subject by one would be making exactly the claim slice 2 was
 * built to refuse. `workBranch` is not context worth the risk of somebody later
 * reading it as identity.
 */
export const DeliveryEvidenceSchema = z
  .object({
    evidenceVersion: z.int().positive(),

    // ── the task and local subject ────────────────────────────────────────
    /** The task this observation is about. Must be the task being asked about. */
    taskId: z.string().min(1).max(128),
    /** The repository the task's record lives in. Absolute, compared on read. */
    repositoryRoot: z.string().min(1).max(4096),
    /** The state the task was in when the observation was made. */
    taskState: z.string().min(1).max(64),
    /**
     * The exact bytes of the task state that justified this observation.
     *
     * `StateLoadSuccess.revision` — a SHA-256 over the raw bytes read from
     * disk. The strongest local invalidator this repository ships, and it is
     * used here for the reason `block/block-evidence.ts` uses `evidenceRevision`
     * for: *any* change to the task's durable record invalidates evidence
     * derived from it, without this module having to enumerate which fields
     * would have mattered. A record whose task has moved on in any way at all
     * reads `LOCAL_BINDING_MISMATCH`.
     */
    stateRevision: z.string().regex(HEX_64, 'Must be a task-state revision.'),
    /** The exact commit the forge was asked about. */
    subjectCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),
    /** The base the work was built on, as the task recorded it. Context only. */
    basePinnedCommit: z.string().regex(COMMIT_OBJECT_NAME).nullable(),

    // ── the delivery target ───────────────────────────────────────────────
    /**
     * The forge this build contacted. One value today.
     *
     * A literal rather than a free string, so that a later build which learns a
     * second forge cannot silently read this build's records as being about it.
     */
    provider: z.literal('github'),
    host: z.string().min(1).max(253),
    owner: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    /**
     * The remote name the profile declared.
     *
     * Carried to distinguish reconfiguration: a repository that re-points
     * `delivery.remote` at a different remote has changed where a delivery
     * would go, even when the resolved identity happens to match. It is
     * compared on read.
     */
    declaredRemote: z.string().min(1).max(256),

    // ── the pull-request observation ──────────────────────────────────────
    pullRequestOutcome: z.enum(RECORDABLE_PULL_REQUEST_OUTCOMES),
    /** Present only for `MATCHED`; cross-checked below. */
    pullRequestNumber: z.int().positive().nullable(),
    /**
     * The matched pull request's head object name.
     *
     * Required to equal {@link subjectCommit} for a `MATCHED` record, and
     * required absent otherwise. That is checked as a cross-field invariant
     * rather than left implied, because "this record says #57's head was a
     * different commit than the one it is evidence about" is precisely the
     * internally-contradictory record the reading vocabulary must be able to
     * refuse.
     */
    pullRequestHeadSha: z.string().regex(COMMIT_OBJECT_NAME).nullable(),

    // ── the check observation ─────────────────────────────────────────────
    /** The commit the check answer was about. Required to equal the subject. */
    checkQueriedCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),
    checkOutcome: z.enum(RECORDABLE_CHECK_OUTCOMES),
    checkRuns: z.int().nonnegative(),
    commitStatuses: z.int().nonnegative(),
    checksFailed: z.int().nonnegative(),
    checksPending: z.int().nonnegative(),
    checksSucceeded: z.int().nonnegative(),
    checksNeutralOrSkipped: z.int().nonnegative(),

    // ── provenance ────────────────────────────────────────────────────────
    /** When the forge was asked. See the header: this is not freshness. */
    observedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    /** When these bytes were written. */
    recordedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The three cross-field invariants. A schema that accepted these
    // individually and refused nothing about their combination would accept a
    // record that validates while describing something that cannot have
    // happened.
    if (value.pullRequestOutcome === 'MATCHED') {
      if (value.pullRequestNumber === null) {
        ctx.addIssue({ code: 'custom', path: ['pullRequestNumber'], message: 'MATCHED must name a pull request.' });
      }
      if (value.pullRequestHeadSha !== value.subjectCommit) {
        ctx.addIssue({
          code: 'custom',
          path: ['pullRequestHeadSha'],
          message: 'A matched pull request\'s head is the subject commit.',
        });
      }
    } else {
      if (value.pullRequestNumber !== null) {
        ctx.addIssue({ code: 'custom', path: ['pullRequestNumber'], message: 'Only MATCHED names a pull request.' });
      }
      if (value.pullRequestHeadSha !== null) {
        ctx.addIssue({ code: 'custom', path: ['pullRequestHeadSha'], message: 'Only MATCHED carries a head.' });
      }
    }
    if (value.checkQueriedCommit !== value.subjectCommit) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkQueriedCommit'],
        message: 'The check answer must be about the subject commit.',
      });
    }
  });

export type DeliveryEvidence = z.infer<typeof DeliveryEvidenceSchema>;

/** The payload without the digest computed over it. */
export type DeliveryEvidencePayload = Omit<DeliveryEvidence, 'binding'>;

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/delivery-evidence/v1';

/**
 * Who a record is expected to be about — the task's own identity, read fresh.
 *
 * Deliberately not `TaskState`: these are the only fields the binding and the
 * agreement checks use, and naming them keeps this module free of an import
 * cycle and free of the temptation to consult a field nobody decided about.
 */
export interface DeliveryEvidenceSubject {
  readonly taskId: string;
  readonly repositoryRoot: string;
  readonly stateRevision: string;
}

/**
 * The binding digest for one payload against one task.
 *
 * The inputs are listed one by one rather than serialised from the object, and
 * that is deliberate: `JSON.stringify(payload)` would make the digest depend on
 * key order, and would silently start covering — or stop covering — a field
 * added to the payload without anybody deciding it should. Every field of the
 * payload is here, and adding one to {@link DeliveryEvidenceSchema} without
 * adding it here leaves it unbound, which is why the test file asserts a
 * per-field mutation is detected for each of them.
 */
export function deliveryEvidenceBinding(
  subject: Pick<DeliveryEvidenceSubject, 'taskId' | 'repositoryRoot'>,
  payload: DeliveryEvidencePayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.taskId,
        subject.repositoryRoot,
        payload.evidenceVersion,
        payload.taskId,
        payload.repositoryRoot,
        payload.taskState,
        payload.stateRevision,
        payload.subjectCommit,
        payload.basePinnedCommit,
        payload.provider,
        payload.host,
        payload.owner,
        payload.name,
        payload.declaredRemote,
        payload.pullRequestOutcome,
        payload.pullRequestNumber,
        payload.pullRequestHeadSha,
        payload.checkQueriedCommit,
        payload.checkOutcome,
        payload.checkRuns,
        payload.commitStatuses,
        payload.checksFailed,
        payload.checksPending,
        payload.checksSucceeded,
        payload.checksNeutralOrSkipped,
        payload.observedAt,
        payload.recordedAt,
      ]),
    )
    .digest('hex');
}

/**
 * What a stored record turned out to be. A closed set of six, of which **one**
 * means "structurally valid historical evidence" — and see the header for what
 * even that one does not mean.
 */
export const DELIVERY_EVIDENCE_READINGS = [
  /**
   * A well-formed, current-version record, bound to this task and still
   * agreeing with it: **at `observedAt`, AO observed this.** The only reading a
   * later slice may build on, and it establishes nothing about now.
   */
  'HISTORICAL_VALID',
  /**
   * No record for this task. Conservative by construction — absence of an
   * observation, never an observation of absence, and in particular never "no
   * pull request exists".
   */
  'ABSENT',
  /** A record this build does not know how to read. Refused. */
  'UNSUPPORTED_VERSION',
  /** Something is there and is not a delivery evidence record this build declares. */
  'MALFORMED',
  /**
   * Well-formed, and the binding says it belongs to a different task or has
   * been edited since it was written.
   */
  'NOT_THIS_TASK',
  /**
   * Well-formed and correctly bound, and the world it describes has moved: the
   * task's durable record changed, the subject commit is no longer the task's
   * current commit, or the delivery target now resolves somewhere else. The
   * record is still a true statement about the past; it is no longer *about*
   * the thing being asked.
   */
  'LOCAL_BINDING_MISMATCH',
] as const;

export type DeliveryEvidenceReading = (typeof DELIVERY_EVIDENCE_READINGS)[number];

/**
 * Which readings are structurally valid historical evidence. Exactly one is.
 *
 * A total table rather than an equality test, and the difference matters: a
 * seventh reading added to the union above stops the build here rather than
 * falling into whatever `=== 'HISTORICAL_VALID'` happens to answer for it.
 * Completeness is not correctness, though — `satisfies` would accept `true` in
 * every row — so every entry is asserted by value in the test file.
 */
const HISTORICAL: Readonly<Record<DeliveryEvidenceReading, boolean>> = Object.freeze({
  HISTORICAL_VALID: true,
  ABSENT: false,
  UNSUPPORTED_VERSION: false,
  MALFORMED: false,
  NOT_THIS_TASK: false,
  LOCAL_BINDING_MISMATCH: false,
});

/**
 * Whether this reading is structurally valid historical evidence.
 *
 * Named for exactly what it answers. It is **not** `isUsable`, `isCurrent` or
 * `isTrusted`: a caller that needs to know whether GitHub still agrees has to
 * go and ask GitHub, and there is no function in this module that will save
 * them the trip.
 */
export function isHistoricalDeliveryEvidence(reading: DeliveryEvidenceReading): boolean {
  return HISTORICAL[reading] === true;
}

/** One static sentence per reading, for the operator report. */
export const DELIVERY_EVIDENCE_READING_DETAIL: Readonly<
  Record<DeliveryEvidenceReading, string>
> = Object.freeze({
  HISTORICAL_VALID:
    'A past observation for exactly this task, target and commit. It says what was true when it was made.',
  ABSENT: 'No observation has been recorded for this task.',
  UNSUPPORTED_VERSION: 'The stored record was written by another build, so it was not read.',
  MALFORMED: 'The stored record is not one this build recognises, so it was not read.',
  NOT_THIS_TASK:
    'The stored record does not belong to this task, or has been edited since it was written.',
  LOCAL_BINDING_MISMATCH:
    'The stored record is about a different commit, target or durable record than the one here now.',
});

/**
 * The sentence every report carries beside a historical reading.
 *
 * Exported rather than written at the call site so there is one wording, and so
 * a test can pin it. The whole slice is one claim, and this is it.
 */
export const REMOTE_FRESHNESS_SENTENCE =
  'A stored observation is a record of one past moment. It is not a claim about the forge now: ' +
  'the pull request, its head and the checks may all have changed since. Nothing here has asked ' +
  'again.';

/**
 * Reads a stored record against the task it is supposed to be about.
 *
 * Never throws. The order of the checks is the contract, and it is the same
 * shape the containment record uses: each step can only reach a *worse* answer
 * than the one after it, so nothing later can rescue an earlier refusal.
 */
export function readDeliveryEvidence(
  raw: unknown,
  subject: DeliveryEvidenceSubject,
  expected: {
    readonly subjectCommit: string;
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly declaredRemote: string;
  },
): DeliveryEvidenceReading {
  // `undefined` is "there is no record", and it is the **only** input that
  // reads as absent. A file whose contents are the JSON value `null` is a file
  // somebody wrote, and it lands on `MALFORMED` with every other payload this
  // build does not recognise. Nothing may turn a record it cannot read into a
  // record nobody wrote.
  if (raw === undefined) return 'ABSENT';

  // The version is read *before* the shape, and from the raw value. A record
  // written by a future build will not satisfy this build's strict schema —
  // that is what a version bump is for — so asking the schema first would
  // report every future record as `MALFORMED` and hide the one fact an operator
  // needs: this was written by something newer.
  const declared: unknown =
    typeof raw === 'object' && raw !== null
      ? (raw as { evidenceVersion?: unknown }).evidenceVersion
      : undefined;
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) {
    if (declared !== DELIVERY_EVIDENCE_VERSION) return 'UNSUPPORTED_VERSION';
  }

  const parsed = DeliveryEvidenceSchema.safeParse(raw);
  if (!parsed.success) return 'MALFORMED';
  const evidence = parsed.data;

  // Belt and braces against the version arm above being loosened: the schema
  // accepts any positive version so that a future record stays *readable*, so
  // this build must state its own version requirement somewhere the schema
  // cannot be edited out from under it.
  if (evidence.evidenceVersion !== DELIVERY_EVIDENCE_VERSION) return 'UNSUPPORTED_VERSION';

  const { binding, ...payload } = evidence;
  if (deliveryEvidenceBinding(subject, payload) !== binding) return 'NOT_THIS_TASK';

  // The agreement checks the digest does not imply. The digest covers the
  // record's *own* `taskId` and `repositoryRoot`, not the subject's, so a
  // record that names a different task can be perfectly bound and is still not
  // this task's evidence.
  if (evidence.taskId !== subject.taskId) return 'NOT_THIS_TASK';
  if (evidence.repositoryRoot !== subject.repositoryRoot) return 'NOT_THIS_TASK';

  // Everything below is "the record is genuine and the world moved". Separated
  // from the above because they send an operator to different places: one is a
  // record that is not theirs, the other is their own record, gone stale.
  //
  // The state revision is checked first and is the strongest of them: it is a
  // digest of the exact task-state bytes, so it catches every field change
  // including ones this module does not name. The commit is checked separately
  // anyway, because "the subject moved" is the specific thing an operator most
  // needs to be told, and a shared refusal would bury it.
  if (evidence.stateRevision !== subject.stateRevision) return 'LOCAL_BINDING_MISMATCH';
  if (evidence.subjectCommit !== expected.subjectCommit) return 'LOCAL_BINDING_MISMATCH';
  if (evidence.host !== expected.host) return 'LOCAL_BINDING_MISMATCH';
  if (evidence.owner !== expected.owner) return 'LOCAL_BINDING_MISMATCH';
  if (evidence.name !== expected.name) return 'LOCAL_BINDING_MISMATCH';
  if (evidence.declaredRemote !== expected.declaredRemote) return 'LOCAL_BINDING_MISMATCH';

  return 'HISTORICAL_VALID';
}
