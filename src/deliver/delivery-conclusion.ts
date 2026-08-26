/**
 * The durable delivery-conclusion record: what it says, and the five things it
 * does not.
 *
 * ── The sentence ───────────────────────────────────────────────────────────
 *
 * > At time T, this task's delivery was concluded: its implementation head H
 * > was merged as pull request #N on that target, producing merge commit M, and
 * > M stood at a pass under verification profile P.
 *
 * One judgement, about one **delivery instance**, drawn from two documents that
 * were read in the same invocation and required to agree. It is emphatically
 * *not* a claim about a branch, about the code as it is now, or about the
 * task's state machine.
 *
 * ── Commit claim versus delivery claim ─────────────────────────────────────
 *
 * `post-merge-verification.ts` records a claim about a **commit**: *at time T,
 * commit M completed profile P with result R*. That sentence is true of M no
 * matter which task, receipt or pull request it came from — the record's own
 * header says the subject is a commit, "emphatically not the delivery".
 *
 * This record makes the other claim, and the join is the whole of the
 * difference. Nothing before this slice compared the two documents against each
 * other. `verify-merge.ts` compares the *history's* `mergeCommit` against the
 * receipt's on its convergence path and nothing else; the verification store
 * compares the rest, but only on a path a converged run never reaches. So a
 * verification history filed under a task, naming a real pass for a real
 * commit, could carry a different pull-request number, a different fork or a
 * different implementation head from the receipt beside it, and every existing
 * reader would see an ordinary pass. `internal/delivery-conclusion-proof.ts` is
 * where those six fields are compared, and it is why the conclusion is a minted
 * artefact rather than a boolean somebody computes.
 *
 * ── The five things it does not say ────────────────────────────────────────
 *
 * A reader will want each of these to follow from a conclusion, and none of
 * them does:
 *
 *  1. **that M is on the base branch now, or reachable from it.** This build
 *     does not ask. The decision is measured rather than asserted; see the ADR
 *     and the summary under "Why base membership is not asked" below;
 *  2. **that the merge has not been reverted.** A revert is a new commit, so it
 *     changes nothing a reachability question could see. Measured: a reverted
 *     merge and a clean linear advance answer identically on every Git
 *     predicate available here;
 *  3. **that M's changes are present anywhere today.** Ancestry is neither
 *     sufficient nor necessary for that, and both directions were measured;
 *  4. **that the base branch passes now.** A later commit is a different
 *     subject and needs its own run;
 *  5. **that the task's state machine moved.** Nothing here touches
 *     `TaskState`, the transition table or the block ledger. `READY_FOR_PR`
 *     stays terminal, `currentCommit` stays the implementation head **H**, and
 *     a settled block-ledger entry's `resultCommit` stays **H** — which is a
 *     *different commit from M* and deliberately so.
 *
 * ── Why base membership is not asked ───────────────────────────────────────
 *
 * The obvious extra condition for a completion claim is "and M is on the
 * configured base". It is not here, and the reason is four measurements rather
 * than a preference. They are set out in full in the ADR; in short:
 *
 *  - **the predicate does not carry the meaning a reader takes from it.**
 *    `merge-base --is-ancestor` answers about the commit *graph*. A merge whose
 *    every line was reverted is still an ancestor, and a merge whose content is
 *    byte-identically present under a squashed object name is not one;
 *  - **the predicate can answer "no" when the truth is "yes", silently.** In a
 *    repository shallow enough that the walk stops before M, it exits 1 — the
 *    genuine-no code — with empty stderr, indistinguishable from a force-push.
 *    A same-named tag beside the branch produces the same wrong 1, with only a
 *    stderr warning this build's Git seams do not surface;
 *  - **the base AO knows is local.** `TaskState.baseBranch` comes from the
 *    profile's `repository.defaultBranch` and is existence-checked as
 *    `refs/heads/<name>`. AO does not fetch (L-V4-09-3), so that ref is
 *    whatever the operator last pulled. Measured on this repository while this
 *    slice was written: local `main` sat at the previous delivery's merge
 *    commit while the new one was already merged on the forge — a gate on
 *    ancestry would have answered `NOT_ANCESTOR` for a merge that had just
 *    succeeded;
 *  - **the sibling record already disclaims it in writing.**
 *    `post-merge-verification.ts` lists "currently on the base branch" and
 *    "currently reachable from the base" among the things a pass does not say.
 *    Adding the property to the conclusion would contradict the record it is
 *    drawn from rather than extend it.
 *
 * So this record says the delivery **happened** and its merge commit **was
 * verified**. It does not say the delivery's changes survive, and there is no
 * field in which such a claim could hide.
 *
 * ── Why it is one immutable record and not a history ───────────────────────
 *
 * The opposite of `post-merge-verification.ts`, and for the reason that record
 * gives about itself. A verification verdict is a *measurement of a run*, and
 * the same gate at the same commit has been measured answering differently
 * under load — so it is a history. A conclusion is a *judgement about two
 * documents at an instant*, and re-drawing it from the same documents produces
 * the same judgement. Slice 8's shape is therefore the right one: written once,
 * never overwritten, a repeat run answering `ALREADY_CONCLUDED` and a
 * disagreeing one refused.
 *
 * That is also what keeps a concluded delivery concluded. If this were derived
 * on demand instead of recorded, a delivery would silently un-conclude the
 * moment its verification history became unreadable — a record from a future
 * build, a full attempt list, a byte corrupted. The conclusion is a historical
 * event: *at instant T, AO judged these documents to agree*. That stays true
 * whatever happens to them afterwards, which is precisely why the two source
 * digests are carried.
 */

import { z } from 'zod';

import { createHash } from 'node:crypto';

/**
 * The version of this record's contract, as this build writes and requires it.
 *
 * Deliberately not a range and deliberately not migratable, for the reason
 * `merge-reconciliation.ts` gives: a build that reads a record it does not
 * understand and does its best is a build that acting on a document written by
 * rules it does not have.
 */
export const DELIVERY_CONCLUSION_VERSION = 1;

/**
 * The largest conclusion record this build will read or write.
 *
 * A **byte** budget, checked against the bytes that would be written, because a
 * schema `.max()` bounds UTF-16 code units and a code unit is not a byte.
 *
 * It is, honestly, a **floor rather than a gate on the product path**, and the
 * arithmetic that makes it one is measured rather than argued. For any given
 * `repositoryRoot`, this record serialises to **exactly 200 bytes more** than
 * slice 8's receipt for the same root — the two differ by a fixed set of
 * fixed-width fields and by nothing that scales with the root:
 *
 * | `repositoryRoot` (4096 chars) | receipt | this record |
 * | --- | --- | --- |
 * | ASCII | 5,560 | 5,760 |
 * | CJK (U+4E00) | 13,752 | 13,952 |
 * | U+0001 (escapes to ``) | 26,040 | 26,240 |
 *
 * The receipt's own budget is 8,192, and `conclude-delivery.ts` reads the
 * receipt first. So a receipt small enough to be read at all is one for which
 * this record is at most 8,392 bytes, and this budget cannot be the thing that
 * refuses a run. It is set at 16,384 — the same figure the verification record
 * uses — rather than at something snug, because a budget tuned to the current
 * field list is a budget that starts refusing records the first time a field is
 * added, and the gate exists to stop a *pathological* document, not to be the
 * narrowest constraint in the chain.
 *
 * It is still checked, and `RECORD_TOO_LARGE` is still a code, for the reason
 * the sibling records give: this is what stands in front of a file somebody may
 * have written by hand.
 */
export const MAX_DELIVERY_CONCLUSION_BYTES = 16_384;

const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const DeliveryConclusionSchema = z
  .object({
    conclusionVersion: z.int().positive(),

    // ── the task, and the delivery this concludes ─────────────────────────
    taskId: z.string().min(1).max(128),
    /** The repository the task's record lives in. Absolute, compared on read. */
    repositoryRoot: z.string().min(1).max(4096),
    /**
     * The implementation head **H** — the receipt's `subjectCommit`, which the
     * task's `currentCommit` was required to equal when this was drawn.
     *
     * Carried instead of a task-state revision, and that is a decision rather
     * than an omission. A revision would tie this record to the task's mutable
     * bytes and give it a staleness reading — the exact coupling slices 8 and 9
     * removed. H is an object name: it identifies the delivery without going
     * stale when the task is checkpointed.
     */
    subjectCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),
    /** The merge commit **M** — the delivery's product, and what was verified. */
    mergeCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),

    // ── the delivery target ───────────────────────────────────────────────
    provider: z.literal('github'),
    host: z.string().min(1).max(253),
    owner: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    /** The pull request whose merge produced {@link mergeCommit}. */
    pullRequestNumber: z.int().positive(),
    /**
     * The branch the merged pull request targeted, as the forge named it at
     * reconciliation. A **name**, never an object name, and never a claim about
     * where that branch points now — see the header's second list.
     */
    baseRef: z.string().min(1).max(255),

    // ── the evidence this judgement was drawn from ────────────────────────
    /** The profile whose standing verdict for M was a pass. */
    profileDigest: z.string().regex(HEX_64, 'Must be a profile digest.'),
    /** The `attemptedAt` of the attempt that was that standing pass. */
    verifiedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    /**
     * The merge receipt's own binding digest, as it stood when this was drawn.
     *
     * Provenance. Nothing in this build compares it against the file later, and
     * a reader must not either: see {@link verificationBinding}, whose document
     * legitimately changes.
     */
    receiptBinding: z.string().regex(HEX_64, 'Must be a binding digest.'),
    /**
     * The verification history's binding digest, as it stood when this was
     * drawn.
     *
     * That history is **append-only**, so a later attempt changes this digest by
     * design. A mismatch is therefore not evidence of tampering, and this build
     * never treats it as any evidence at all. It names the bytes the judgement
     * was drawn from, and that is its whole job.
     */
    verificationBinding: z.string().regex(HEX_64, 'Must be a binding digest.'),

    /** When this process drew the conclusion. */
    concludedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),

    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The cross-field invariant, and the whole of it. A delivery whose merge
    // commit is its own implementation head is not a merge this build can have
    // concluded: slice 8 requires the receipt's `mergedHeadSha` to equal its
    // `subjectCommit` and `mergeCommit` to be what the merge *produced*, and on
    // every merge method GitHub offers those two are different objects. A record
    // saying otherwise validates field by field while describing something the
    // pipeline that writes it cannot produce.
    if (value.subjectCommit === value.mergeCommit) {
      ctx.addIssue({
        code: 'custom',
        path: ['mergeCommit'],
        message: 'A merge commit is not the head that went into it.',
      });
    }
    // There is deliberately NO invariant ordering `verifiedAt` and
    // `concludedAt`. Both come from clocks — the first from the invocation that
    // ran the gate, possibly on another day, the second from this one — and a
    // backwards step between two machines or across an NTP correction can
    // invert them. The same call slice 8 made about its own pair of instants,
    // and for the same reason: the cost of the invariant is a refused run that
    // wrote nothing, and the benefit is catching a shape no attacker needs.
  });

export type DeliveryConclusion = z.infer<typeof DeliveryConclusionSchema>;

/** The payload without the digest computed over it. */
export type DeliveryConclusionPayload = Omit<DeliveryConclusion, 'binding'>;

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/delivery-conclusion/v1';

/**
 * Who a record is expected to be about — the task's own identity.
 *
 * Deliberately not `TaskState`, and deliberately without a state revision. Same
 * shape and same reasoning as `MergeReconciliationSubject` and
 * `PostMergeVerificationSubject`: this is a record about a delivery, and tying
 * it to mutable task-state bytes would make it go stale when the task is merely
 * checkpointed.
 */
export interface DeliveryConclusionSubject {
  readonly taskId: string;
  readonly repositoryRoot: string;
}

/**
 * The binding digest for one payload against one task.
 *
 * The inputs are listed one by one rather than serialised from the object, for
 * the reason `mergeReconciliationBinding` states: `JSON.stringify(payload)`
 * would make the digest depend on key order, and would silently start covering
 * — or stop covering — a field added to the payload without anybody deciding it
 * should. Every field is here, and the test file asserts that moving any one of
 * them moves the digest.
 */
export function deliveryConclusionBinding(
  subject: DeliveryConclusionSubject,
  payload: DeliveryConclusionPayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.taskId,
        subject.repositoryRoot,
        payload.conclusionVersion,
        payload.taskId,
        payload.repositoryRoot,
        payload.subjectCommit,
        payload.mergeCommit,
        payload.provider,
        payload.host,
        payload.owner,
        payload.name,
        payload.pullRequestNumber,
        payload.baseRef,
        payload.profileDigest,
        payload.verifiedAt,
        payload.receiptBinding,
        payload.verificationBinding,
        payload.concludedAt,
      ]),
    )
    .digest('hex');
}

/**
 * What a stored record turned out to be. A closed set of five, of which **one**
 * means "a conclusion this build wrote for this task".
 *
 * There is no member for "the task moved on since", for the reason
 * `merge-reconciliation.ts` gives about its own readings: a judgement that was
 * drawn does not stop having been drawn because the task did something
 * afterwards.
 */
export const DELIVERY_CONCLUSION_READINGS = [
  /**
   * A conclusion this build wrote for this task, in this repository: **at that
   * instant, this delivery was concluded**. True when written and true now. See
   * the header for the five things it still does not claim.
   */
  'DELIVERY_CONCLUDED',
  /** Nobody has written one. Not an assertion that nothing was delivered. */
  'ABSENT',
  /** Bytes are there and this build cannot read them as a record. */
  'MALFORMED',
  /** A well-formed record this build's contract version does not cover. */
  'UNSUPPORTED_VERSION',
  /**
   * A record about another task or another repository — **or one that has been
   * edited since it was written.**
   *
   * The last clause is not decoration. The binding digest covers every field,
   * so a stored conclusion changed in place fails the same comparison a foreign
   * record does, and lands here.
   */
  'NOT_THIS_TASK',
] as const;

export type DeliveryConclusionReading = (typeof DELIVERY_CONCLUSION_READINGS)[number];

/**
 * Whether a reading is one this build may read facts out of.
 *
 * A total table rather than an `===` test, the convention the sibling records
 * use: a new reading has to be graded here before the build compiles, and the
 * grade is asserted by value in the test file rather than derived from this
 * map.
 */
const CONCLUDED_BY_READING: Readonly<Record<DeliveryConclusionReading, boolean>> = Object.freeze({
  DELIVERY_CONCLUDED: true,
  ABSENT: false,
  MALFORMED: false,
  UNSUPPORTED_VERSION: false,
  NOT_THIS_TASK: false,
});

/** `true` for the one reading whose facts this build may use. */
export function isDeliveryConcluded(reading: DeliveryConclusionReading): boolean {
  return CONCLUDED_BY_READING[reading];
}

/**
 * The fields that identify **which delivery** a conclusion is about.
 *
 * Structural rather than `DeliveryConclusion`, because the two things compared
 * are never both conclusions: the store compares a stored conclusion against
 * the payload it is about to write, and `conclude-delivery.ts` compares a
 * stored conclusion against the merge receipt. One rule, two call sites, and
 * therefore one function — two spellings of a comparison that has to agree is a
 * defect this repository has caught in review more than once.
 */
export interface ConcludedDeliveryIdentity {
  readonly subjectCommit: string;
  readonly mergeCommit: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly pullRequestNumber: number;
  readonly baseRef: string;
}

/**
 * Whether two records name the same delivery.
 *
 * The delivery's identity, and only that. Deliberately **not** every field of a
 * conclusion: a conclusion drawn under profile P and a second assessment under
 * a later profile Q are about the same delivery, and grading the second a
 * conflict would tell an operator their repository was inconsistent when all
 * that changed was the gate. The provenance fields — the profile digest, the
 * two source digests, both instants — are what a judgement was drawn *from*,
 * not what it is *about*.
 *
 * `provider` is absent for a reason rather than by oversight: it is a
 * `z.literal('github')` on both sides of every comparison this build can make,
 * so a line comparing it could never fail. It is in the binding digest, which
 * is where a future second forge would be caught.
 */
export function sameConcludedDelivery(
  a: ConcludedDeliveryIdentity,
  b: ConcludedDeliveryIdentity,
): boolean {
  return (
    a.subjectCommit === b.subjectCommit &&
    a.mergeCommit === b.mergeCommit &&
    a.host === b.host &&
    a.owner === b.owner &&
    a.name === b.name &&
    a.pullRequestNumber === b.pullRequestNumber &&
    a.baseRef === b.baseRef
  );
}

/**
 * The sentence every report carries beside a recorded conclusion.
 *
 * Exported rather than written at the call site so there is one wording, and so
 * a test can pin it. It is the distinction this whole slice turns on, and the
 * one an operator is most likely to over-read: a conclusion is a **judgement
 * about a delivery that happened**, not a standing about the code today.
 */
export const CONCLUSION_EVENT_SENTENCE =
  'A conclusion states that a delivery happened and that the commit it produced was\n' +
  'verified. It is not a claim that the merge commit is on the base branch now, that it\n' +
  'is reachable from it, that the merge has not been reverted, that its changes are still\n' +
  'present, or that the base branch passes today. Nothing here has asked any of those\n' +
  'questions, and the task state machine is untouched: READY_FOR_PR stays terminal.';

/**
 * Reads one stored record, given the bytes and who it should be about.
 *
 * Never throws. Every way a document can be wrong reaches a reading.
 */
export function readDeliveryConclusion(
  raw: unknown,
  subject: DeliveryConclusionSubject,
): {
  readonly reading: DeliveryConclusionReading;
  readonly conclusion: DeliveryConclusion | null;
} {
  // The version is read before the shape, so a record written by a build with a
  // different contract is refused as such rather than as malformed. A future
  // record may legally carry fields this schema forbids.
  const declared =
    typeof raw === 'object' && raw !== null && 'conclusionVersion' in raw
      ? (raw as { conclusionVersion: unknown }).conclusionVersion
      : undefined;
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) {
    if (declared !== DELIVERY_CONCLUSION_VERSION) {
      return Object.freeze({ reading: 'UNSUPPORTED_VERSION' as const, conclusion: null });
    }
  }

  const parsed = DeliveryConclusionSchema.safeParse(raw);
  if (!parsed.success) return Object.freeze({ reading: 'MALFORMED' as const, conclusion: null });
  const record = parsed.data;

  // Belt and braces against the version check above: a record that reached here
  // with a version this build does not require would be read under rules it was
  // not written by.
  if (record.conclusionVersion !== DELIVERY_CONCLUSION_VERSION) {
    return Object.freeze({ reading: 'UNSUPPORTED_VERSION' as const, conclusion: null });
  }

  const { binding, ...payload } = record;
  if (deliveryConclusionBinding(subject, payload) !== binding) {
    return Object.freeze({ reading: 'NOT_THIS_TASK' as const, conclusion: null });
  }

  // Belt and braces against the binding above, and **reachable**, exactly as
  // the verification record's sibling pair is. The digest takes the subject's
  // ids alongside the payload's, so a record bound for a *different* subject
  // fails one line up. But a record whose payload names another task, with a
  // binding computed for THAT payload against THIS subject, matches the digest
  // and arrives here — and these two lines are what refuse it. The test file
  // constructs exactly that document.
  if (record.taskId !== subject.taskId) {
    return Object.freeze({ reading: 'NOT_THIS_TASK' as const, conclusion: null });
  }
  if (record.repositoryRoot !== subject.repositoryRoot) {
    return Object.freeze({ reading: 'NOT_THIS_TASK' as const, conclusion: null });
  }

  return Object.freeze({ reading: 'DELIVERY_CONCLUDED' as const, conclusion: record });
}
