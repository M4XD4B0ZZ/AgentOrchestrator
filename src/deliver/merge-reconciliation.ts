/**
 * The durable merge receipt: the versioned record of one merge event, and the
 * vocabulary for reading one back.
 *
 * ── The question this exists to make answerable ────────────────────────────
 *
 * Slice 7 can merge a pull request and report the resulting commit. The process
 * then ends and the commit is gone. Nothing on this machine can afterwards tell
 *
 *     "AO has never established that this task's delivery was merged"
 *
 * apart from
 *
 *     "pull request #N was observed merged, from head H, producing commit M."
 *
 * This module is that second statement's format, and nothing else.
 *
 * ── The one sentence a receipt carries, and the four it does not ───────────
 *
 * A receipt says exactly this, and an operator report must not be allowed to
 * grow it:
 *
 *     PR #N was observed merged from head H and produced commit M.
 *
 * It is deliberately **not** any of the following, and each is a different
 * question with a different answer:
 *
 *  1. **"commit M is currently the tip of the base branch."** The base moves.
 *     M was produced by the merge; whether it is on `main` now is a question
 *     about `main` now, and this file was written before that question was
 *     asked. See {@link MERGE_PRESENCE_SENTENCE}.
 *  2. **"commit M passed post-merge verification."** Nothing was run against
 *     it. Slice 8 ends at the receipt precisely so that the verification is a
 *     separate, later, provable step rather than an assumption folded into
 *     this one.
 *  3. **"the merge has not been reverted."** A revert is an ordinary later
 *     commit. It does not unmerge the pull request and it does not reach these
 *     bytes.
 *  4. **"AO performed this merge."** Nothing in a *reading* establishes who
 *     did. A merge performed by a human through the GitHub web UI, by another
 *     authorised invocation, or by this build's own slice-7 effect produces the
 *     identical reading — which is the property recovery depends on, not a
 *     shortcoming. See `internal/merge-observation-proof.ts`.
 *
 * ── Why this record has no staleness reading, and slice 3's has one ────────
 *
 * `delivery-evidence.ts` downgrades its record to `LOCAL_BINDING_MISMATCH` the
 * moment the task's durable bytes change, and that is right *there*: what it
 * stores is a snapshot of a **mutable situation** — which pull request is open
 * at this head, what the checks say — taken about the task's *current* subject.
 * A task that moved makes that snapshot no longer an answer to the question
 * being asked.
 *
 * A merge event is not a situation. "Pull request #N was merged from head H and
 * produced M" is monotonic: it was true the instant the forge said so and it
 * stays true afterwards, whatever the task, the branch or the base go on to do.
 * A reading vocabulary that expired it would not be qualifying a fact, it would
 * be *discarding* one — and the fact this discards is the one the next slice
 * needs. So there is no `stateRevision` field here and no reading derived from
 * one, and that absence is a decision rather than an omission.
 *
 * What replaces it is stricter, not laxer. A stored receipt is never *merged*
 * with a new observation and never silently replaced: `reconcile-merge.ts`
 * compares the two whole and refuses a contradiction outright. Agreement writes
 * nothing; disagreement writes nothing and says so.
 *
 * ── What the binding digest is, stated exactly ─────────────────────────────
 *
 * {@link MergeReconciliation.binding} is an **integrity binding, not a message
 * authentication code**. It is a digest over the payload together with the
 * identity of the task it belongs to. Every input is derivable by anyone who
 * can read the repository, so an author who can write this file can recompute
 * it. It does not withstand that author and is not offered as though it does:
 * **anyone who can create a file in the repository's runtime directory can
 * write a receipt this build reads as genuine**, having observed nothing. The
 * in-process mint (`internal/merge-observation-proof.ts`) is what stops *product
 * code* manufacturing one; it does nothing about the filesystem.
 *
 * What the digest does catch is the realistic damage: a receipt copied from one
 * task into another, a field edited in place without recomputation, and a
 * receipt written by a build that disagrees with this one about the payload.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Contract version of the merge receipt. Bump on any payload change.
 *
 * Its own version, separate from `TASK_STATE_SCHEMA_VERSION` and separate from
 * `DELIVERY_EVIDENCE_VERSION`, for the reason slice 3 gives about the first of
 * those: a bump here must lock nobody out of reading a task or a delivery
 * observation. Three records, three independently movable contracts.
 */
export const MERGE_RECONCILIATION_VERSION = 1;

/**
 * The largest receipt this build will write or read back.
 *
 * The payload is a fixed set of scalars — no arrays, no free text, no forge
 * payload — and the only field that can approach this bound is the repository
 * root, whose own maximum the schema states. Anything near this is not a record
 * this build produced. Checked on the encoded bytes before anything is touched,
 * and again on the bytes read back, so a record that grew on disk is refused
 * rather than parsed.
 */
export const MAX_MERGE_RECONCILIATION_BYTES = 8_192;

const HEX_64 = /^[0-9a-f]{64}$/;
const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The receipt.
 *
 * `.strict()`, so a field this build does not declare makes the record
 * `MALFORMED` rather than being ignored — a record carrying something extra was
 * written by something that is not this build, and reading the part we
 * recognise out of it would be reading half of somebody else's document.
 *
 * ── What is deliberately not here ─────────────────────────────────────────
 *
 * No token, no `Authorization` header, no raw `gh` output, no stderr, no exit
 * code, no URL, no environment snapshot, no pull-request title, body, author or
 * diff, no arbitrary GitHub JSON. That is not enforced by a filter — it is
 * enforced by the shape: every field that carries **what the forge said** comes
 * from {@link MergeObservationFacts}, which has no field any of those could
 * travel in. The rest are local identities the caller already holds — the task,
 * its repository root, its commit and two instants — and none of them has been
 * anywhere near a response body.
 *
 * No head **branch name** either, and that is the same decision slice 3 took
 * about `workBranch`. A branch is a mutable pointer; the head of this merge is
 * an object name, and it stays true after the branch is deleted — measured on
 * this repository, a merged pull request whose head branch no longer exists on
 * the remote still reports its head object name, its base and its resulting
 * commit unchanged.
 *
 * No task **state** and no task-state revision. The receipt is about a merge,
 * not about the task's lifecycle: a reader who wants to know what state the
 * task is in must read the task, which is a live question these bytes are the
 * wrong instrument for. The precondition that the task was `READY_FOR_PR` and
 * that {@link MergeReconciliation.subjectCommit} was its `currentCommit` is
 * enforced by `reconcile-merge.ts` at the moment of writing and re-checkable at
 * any time from the task itself.
 *
 * No `declaredRemote`. Slice 3 carries one to detect reconfiguration, because
 * its record is about where a delivery *would* go. This one is about a merge
 * that already happened on a named forge repository, and which local remote
 * pointed at it is not part of that event's identity.
 */
export const MergeReconciliationSchema = z
  .object({
    reconciliationVersion: z.int().positive(),

    // ── the task and its delivery head ────────────────────────────────────
    /** The task this merge is the delivery of. */
    taskId: z.string().min(1).max(128),
    /** The repository the task's record lives in. Absolute, compared on read. */
    repositoryRoot: z.string().min(1).max(4096),
    /**
     * The task's implementation result — `TaskState.currentCommit` at the
     * moment of reconciliation, and the commit that went into the merge.
     *
     * This is the field that makes the receipt *this task's*. It is required
     * to equal {@link mergedHeadSha} below, which is what the forge reported,
     * so the record cannot describe a merge of somebody else's commit while
     * naming this task.
     */
    subjectCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),

    // ── the delivery target ───────────────────────────────────────────────
    /**
     * The forge. One value today.
     *
     * A literal rather than a free string, so that a later build which learns a
     * second forge cannot silently read this build's records as being about it.
     */
    provider: z.literal('github'),
    host: z.string().min(1).max(253),
    owner: z.string().min(1).max(128),
    name: z.string().min(1).max(128),

    // ── the merge event ───────────────────────────────────────────────────
    /** The pull request that was merged, by number. */
    pullRequestNumber: z.int().positive(),
    /**
     * The head object name the forge reported for the merged pull request.
     *
     * Under a squash merge this commit is on no branch afterwards, so it can
     * only come from the forge. Required to equal {@link subjectCommit}.
     */
    mergedHeadSha: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),
    /** The base branch the forge reported. A name, never an object name. */
    baseRef: z.string().min(1).max(255),
    /**
     * The commit the merge produced — `merge_commit_sha` on a merged pull
     * request.
     *
     * The one field in this record that no local computation can reproduce, and
     * the reason the record exists at all. It is what the next slice verifies.
     */
    mergeCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),

    // ── provenance ────────────────────────────────────────────────────────
    /** When the forge was asked. Not freshness; see the header. */
    observedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    /** When these bytes were written. */
    reconciledAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The cross-field invariant, and the whole of it. A schema that accepted
    // each field individually and said nothing about their combination would
    // accept a receipt that validates while describing something that cannot be
    // this task's delivery: a real merge of a real pull request, filed against
    // a task whose commit was never in it.
    if (value.mergedHeadSha !== value.subjectCommit) {
      ctx.addIssue({
        code: 'custom',
        path: ['mergedHeadSha'],
        message: "The merged pull request's head is the task's delivery commit.",
      });
    }
    // There is deliberately NO second invariant ordering the two instants, and a
    // review raised its absence: a receipt whose `reconciledAt` precedes its
    // `observedAt` validates, and describes a record written before the forge
    // was asked.
    //
    // It stays absent because the check would be the more dangerous of the two.
    // The two instants come from two separate calls to the same clock in one
    // invocation, so a backwards step between them — an NTP correction is the
    // ordinary cause — would refuse a completely honest reconciliation as
    // `RECEIPT_CONTRACT_VIOLATION`, and go on refusing it until the clock caught
    // up. What the invariant would buy is refusing a record nothing in this
    // build can produce and nothing downstream reads: no consumer compares the
    // two, and both are already reported as what they are. Trading a live
    // refusal of good input for a stricter refusal of input that does not occur
    // is the wrong side of that trade, and it is a decision rather than an
    // omission.
  });

export type MergeReconciliation = z.infer<typeof MergeReconciliationSchema>;

/** The payload without the digest computed over it. */
export type MergeReconciliationPayload = Omit<MergeReconciliation, 'binding'>;

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/merge-reconciliation/v1';

/**
 * Who a receipt is expected to be about — the task's own identity.
 *
 * Deliberately not `TaskState`, and deliberately without a state revision:
 * these are the only fields the binding uses, and a revision here would tie a
 * monotonic fact to mutable bytes. See the header.
 */
export interface MergeReconciliationSubject {
  readonly taskId: string;
  readonly repositoryRoot: string;
}

/**
 * The binding digest for one payload against one task.
 *
 * The inputs are listed one by one rather than serialised from the object, and
 * that is deliberate: `JSON.stringify(payload)` would make the digest depend on
 * key order, and would silently start covering — or stop covering — a field
 * added to the payload without anybody deciding it should. Every field of the
 * payload is here, and adding one to {@link MergeReconciliationSchema} without
 * adding it here leaves it unbound, which is why the test file asserts a
 * per-field mutation is detected for each of them.
 */
export function mergeReconciliationBinding(
  subject: MergeReconciliationSubject,
  payload: MergeReconciliationPayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.taskId,
        subject.repositoryRoot,
        payload.reconciliationVersion,
        payload.taskId,
        payload.repositoryRoot,
        payload.subjectCommit,
        payload.provider,
        payload.host,
        payload.owner,
        payload.name,
        payload.pullRequestNumber,
        payload.mergedHeadSha,
        payload.baseRef,
        payload.mergeCommit,
        payload.observedAt,
        payload.reconciledAt,
      ]),
    )
    .digest('hex');
}

/**
 * What a stored receipt turned out to be. A closed set of five, of which **one**
 * means "a merge this build recorded for this task".
 *
 * There is no member for "the task moved on since". See the header: a merge
 * event does not stop having happened because the task did something
 * afterwards, and a reading that expired it would delete the fact the next
 * slice needs.
 */
export const MERGE_RECONCILIATION_READINGS = [
  /**
   * A receipt this build wrote for this task, in this repository: **pull
   * request #N was observed merged, from head H, producing commit M.** True
   * when written and true now — and see the header for the four sentences it
   * still is not.
   */
  'HISTORICAL_MERGE',
  /**
   * No receipt for this task. Absence of a reconciliation, never a
   * reconciliation of absence — in particular never "this task was not merged".
   */
  'ABSENT',
  /** A receipt this build does not know how to read. Refused. */
  'UNSUPPORTED_VERSION',
  /** Something is there and is not a merge receipt this build declares. */
  'MALFORMED',
  /**
   * Well-formed, and the binding says it belongs to a different task or has
   * been edited since it was written.
   */
  'NOT_THIS_TASK',
] as const;

export type MergeReconciliationReading = (typeof MERGE_RECONCILIATION_READINGS)[number];

/**
 * Which readings are a merge this build recorded. Exactly one is.
 *
 * A total table rather than an equality test, and the difference matters: a
 * sixth reading added to the union above stops the build here rather than
 * falling into whatever `=== 'HISTORICAL_MERGE'` happens to answer for it.
 * Completeness is not correctness, though — `satisfies` would accept `true` in
 * every row — so every entry is asserted by value in the test file.
 */
const RECORDED: Readonly<Record<MergeReconciliationReading, boolean>> = Object.freeze({
  HISTORICAL_MERGE: true,
  ABSENT: false,
  UNSUPPORTED_VERSION: false,
  MALFORMED: false,
  NOT_THIS_TASK: false,
});

/**
 * Whether this reading is a merge receipt this build recorded for this task.
 *
 * Named for exactly what it answers. It is **not** `isDelivered`, `isComplete`
 * or `isOnMain`: each of those is a different question, and three of them are
 * about a world this file cannot see.
 */
export function isRecordedMerge(reading: MergeReconciliationReading): boolean {
  return RECORDED[reading] === true;
}

/** One static sentence per reading, for the operator report. */
export const MERGE_RECONCILIATION_READING_DETAIL: Readonly<
  Record<MergeReconciliationReading, string>
> = Object.freeze({
  HISTORICAL_MERGE:
    'A merge recorded for exactly this task: the pull request, head, base and resulting commit below.',
  ABSENT: 'No merge has been reconciled for this task.',
  UNSUPPORTED_VERSION: 'The stored receipt was written by another build, so it was not read.',
  MALFORMED: 'The stored receipt is not one this build recognises, so it was not read.',
  NOT_THIS_TASK:
    'The stored receipt does not belong to this task, has been edited since it was written, ' +
    'or was written when this repository was at a different path.',
});

/**
 * The sentence every report carries beside a recorded merge.
 *
 * Exported rather than written at the call site so there is one wording, and so
 * a test can pin it. This is the distinction the whole slice turns on, and it
 * is the one an operator is most likely to over-read.
 */
export const MERGE_PRESENCE_SENTENCE =
  'A merge receipt records one event: this pull request was merged and produced this\n' +
  'commit. It is not a claim that the commit is on the base branch now, that it has not\n' +
  'been reverted, that anything was verified against it, or that AO performed the merge.\n' +
  'Nothing here has asked any of those questions.';

/**
 * Reads a stored receipt against the task it is supposed to be about.
 *
 * Never throws. The order of the checks is the contract, and it is the same
 * shape slice 3 uses: each step can only reach a *worse* answer than the one
 * after it, so nothing later can rescue an earlier refusal.
 */
export function readMergeReconciliation(
  raw: unknown,
  subject: MergeReconciliationSubject,
): MergeReconciliationReading {
  // `undefined` is "there is no receipt", and it is the **only** input that
  // reads as absent. A file whose contents are the JSON value `null` is a file
  // somebody wrote, and it lands on `MALFORMED` with every other payload this
  // build does not recognise. Nothing may turn a record it cannot read into a
  // record nobody wrote.
  if (raw === undefined) return 'ABSENT';

  // The version is read *before* the shape, and from the raw value. A receipt
  // written by a future build will not satisfy this build's strict schema —
  // that is what a version bump is for — so asking the schema first would
  // report every future record as `MALFORMED` and hide the one fact an operator
  // needs: this was written by something newer.
  const declared: unknown =
    typeof raw === 'object' && raw !== null
      ? (raw as { reconciliationVersion?: unknown }).reconciliationVersion
      : undefined;
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) {
    if (declared !== MERGE_RECONCILIATION_VERSION) return 'UNSUPPORTED_VERSION';
  }

  const parsed = MergeReconciliationSchema.safeParse(raw);
  if (!parsed.success) return 'MALFORMED';
  const receipt = parsed.data;

  // Belt and braces against the version arm above being loosened: the schema
  // accepts any positive version so that a future record stays *readable*, so
  // this build must state its own version requirement somewhere the schema
  // cannot be edited out from under it.
  if (receipt.reconciliationVersion !== MERGE_RECONCILIATION_VERSION) {
    return 'UNSUPPORTED_VERSION';
  }

  const { binding, ...payload } = receipt;
  if (mergeReconciliationBinding(subject, payload) !== binding) return 'NOT_THIS_TASK';

  // Belt and braces against the binding above, and stated as exactly that
  // rather than as a check that catches something it does not.
  //
  // The obvious sentence here — "the digest covers the record's own identity,
  // not the subject's, so a foreign receipt can be perfectly bound" — is FALSE
  // of this build, and a counter-proof measured it: both mutants below survive
  // the whole suite, because {@link mergeReconciliationBinding} takes the
  // subject's `taskId` and `repositoryRoot` as inputs alongside the payload's.
  // A receipt bound for another task therefore fails the digest comparison one
  // line up and never reaches here.
  //
  // They stay because the redundancy is one-directional and cheap: if the
  // binding's input list ever stopped covering the subject, these two lines are
  // what would keep a foreign receipt out — and the digest is the kind of thing
  // a refactor edits. Their honest status is "unreachable today, load-bearing
  // if the line above changes", which is why they are documented rather than
  // claimed as a second independent gate.
  if (receipt.taskId !== subject.taskId) return 'NOT_THIS_TASK';
  if (receipt.repositoryRoot !== subject.repositoryRoot) return 'NOT_THIS_TASK';

  return 'HISTORICAL_MERGE';
}
