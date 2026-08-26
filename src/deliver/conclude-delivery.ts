/**
 * Concluding a delivery: joining the merge receipt to the verification history,
 * and refusing everything that is not that join.
 *
 * ── What is being decided ──────────────────────────────────────────────────
 *
 * Four propositions, kept apart on purpose because they are not equivalent and
 * the temptation to collapse them into one boolean is the defect this module
 * exists to avoid:
 *
 *   **P1** commit **M** has a `VERIFIED_PASS` standing under profile **P**;
 *   **P2** **M** is reachable from the configured delivery base;
 *   **P3** the merge receipt still reconciles *this task* to **M**;
 *   **P4** this task's delivery may be concluded.
 *
 * This build decides **P4 = P1 ∧ P3**, and does not ask P2 at all.
 *
 * P3 is the half nothing before this slice checked. The receipt names H, the
 * target, the pull request and M; the verification history names all four
 * again — and no existing reader compares the two documents. `verify-merge.ts`
 * compares the history's merge commit against the receipt's on its convergence
 * path and nothing else, and the verification store compares the rest only on a
 * path a converged run never reaches. So a history filed under this task,
 * recording a genuine pass of a genuine commit, may carry a different pull
 * request, fork or implementation head and be indistinguishable from a correct
 * one. `internal/delivery-conclusion-proof.ts` closes that, and this ladder
 * reports it.
 *
 * P2's absence is a decision with measurements behind it, not an omission. The
 * summary is in `delivery-conclusion.ts` and the measurements are in the ADR;
 * the shortest form is that `merge-base --is-ancestor` answers about the commit
 * *graph* — a fully reverted merge is still an ancestor, a squashed one is not —
 * that it can return the genuine-no exit code when the truth is yes and say
 * nothing about having done so, and that the base AO can see is a **local** ref
 * this build never fetches, so the answer is about the operator's last pull
 * rather than about the delivery.
 *
 * ── What this never does ───────────────────────────────────────────────────
 *
 * No task state is written and none could be: `advanceTaskState` requires an
 * execution lease this path does not take, and `READY_FOR_PR` has no outgoing
 * transition to take. No block-ledger entry is touched — a ledger entry's
 * evidence is a digest over the task-state file's raw bytes, so a write of any
 * kind would make every settled entry for the task unprovable. No agent is
 * started, no verification is run, no workspace is made, and nothing at all is
 * sent to a forge: this module has no forge seam, no Git seam and no
 * verification seam, and starts no subprocess at all. The two
 * `git check-ignore` probes belong to the store, which runs them before it
 * writes; the command that reaches both has already resolved the repository,
 * which starts Git children of its own before any flag is examined.
 *
 * ── What a conclusion does not authorise ───────────────────────────────────
 *
 * Nothing, today. It is a durable statement that the lifecycle reached its end,
 * not a permission for a later step to act. That is deliberate: slice 4
 * declined to persist its *decision* on the ground that "a stored verdict is a
 * strictly more dangerous artefact than a stored observation, because it
 * already looks like a conclusion", and the answer to that objection here is
 * not that this record is safer but that it is a different kind of thing — a
 * judgement about two immutable events, which authorises no act.
 */

import type { ResolvedVerificationPolicy } from '../repo/resolve-repository.js';
import { verificationProfileDigest } from '../verify/verification-profile.js';
import {
  describesSameDelivery,
  mintDeliveryConclusion,
  standingVerdictFor,
} from './internal/delivery-conclusion-proof.js';
import type { DeliveryConclusionProof } from './delivery-conclusion-proof.js';
import { loadDeliveryConclusion } from './delivery-conclusion-store.js';
import { loadMergeReconciliation } from './merge-reconciliation-store.js';
import type { MergeReconciliationSubject } from './merge-reconciliation.js';
import { loadPostMergeVerification } from './post-merge-verification-store.js';

/**
 * The repository facts a conclusion reads.
 *
 * Narrowed to exactly these rather than taking `ResolvedRepository`, for the
 * reason `verify-merge.ts` gives about its own input: a function that accepted
 * the whole resolved repository could quietly start depending on the scope
 * policy or the delivery target, and this one would stop being a statement
 * about the conclusion contract alone.
 */
export interface ConclusionRepository {
  readonly root: string;
  readonly verification: ResolvedVerificationPolicy;
}

/**
 * Everything one conclusion is about, from the task and the repository's own
 * delivery target. Never from a stored record and never from an argument.
 */
export interface ConclusionSubject {
  readonly taskId: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /**
   * The task's implementation result — `TaskState.currentCommit`, **H**.
   *
   * The receipt must agree with it. A receipt whose `subjectCommit` is some
   * other commit is a receipt about some other delivery, however well-formed.
   */
  readonly deliveryCommit: string;
}

/**
 * The seams a conclusion needs.
 *
 * One, and the shortness of this list is the guarantee rather than an
 * accident. There is deliberately **no forge seam of any kind, no Git seam and
 * no verification seam**: concluding a delivery asks github.com nothing, asks
 * Git nothing about the commit graph, and starts no gate. A seam this path does
 * not hold is a capability it provably does not have, which is a stronger
 * statement than a comment saying it does not use one.
 */
export interface ConclusionSeams {
  /** The clock, for the instant the judgement was drawn. */
  readonly now: () => Date;
}

/**
 * The closed vocabulary. Ordered as the ladder decides, weakest claim first.
 *
 * Every member says what could not be established and why it is not the member
 * beside it.
 */
export const DELIVERY_CONCLUSIONS = [
  /**
   * No subject was established, so there is nothing this could be about.
   *
   * The delivery target did not resolve, the task state could not be read, or
   * the task has no current commit. Produced by the caller's own refusal path,
   * the same arrangement slices 7, 8 and 9 use.
   */
  'SUBJECT_NOT_ESTABLISHED',
  /** The task is not at the state a delivery is concluded from. */
  'TASK_NOT_READY',
  /**
   * This delivery is already concluded, and this run changed nothing.
   *
   * Decided **before every other document is read** — before the merge receipt
   * as well as before any verification question — and that ordering is the
   * contract rather than an accident: a delivery that was concluded stays
   * concluded. Edit the profile, make the verification history unreadable,
   * delete the merge receipt, or let a newer build rewrite either of them: the
   * conclusion still stands, because it is a statement about an instant that
   * has passed and re-deriving it is not what makes it true.
   *
   * An earlier version asked the receipt first, and a review measured the cost:
   * a task whose conclusion sat readable on disk answered `RECEIPT_ABSENT` and
   * never mentioned it. The monotonicity this record exists for held against
   * two of its three sources and not the third.
   *
   * What is compared is the stored conclusion's own identity — the
   * implementation head **H** and the delivery target — against the task's
   * subject, by the same predicate the receipt gate uses. The record's *own*
   * merge commit and profile digest are reported, not this run's.
   */
  'ALREADY_CONCLUDED',
  /**
   * Something is on the conclusion's path and this build cannot read it:
   * malformed, a contract version it does not have, or bound to another task —
   * **or edited in place**, because the binding digest covers every field.
   *
   * Refused rather than written over. Under `UNSUPPORTED_VERSION` the document
   * may be a perfectly good conclusion written by a newer build.
   */
  'CONCLUSION_UNREADABLE',
  /**
   * A readable conclusion is on disk for a **different** delivery of this task:
   * its implementation head or its target is not this task's.
   *
   * Nothing is written and nothing is repaired. Two conclusions for one task
   * would be two answers to one question, and choosing between them is not a
   * decision this build makes silently.
   */
  'CONCLUSION_CONFLICT',
  /**
   * No merge receipt. **Not** a claim that the delivery was not merged — only
   * that AO has not reconciled one, which is `--reconcile-merge`'s job.
   *
   * Reached only when no conclusion is on disk: a concluded delivery is
   * reported as concluded whatever became of the receipt afterwards.
   */
  'RECEIPT_ABSENT',
  /**
   * A receipt is on disk and this build cannot read it as one: malformed, a
   * contract version it does not have, or bound to another task.
   */
  'RECEIPT_UNREADABLE',
  /**
   * A readable receipt that is not about this task's current delivery — its
   * `subjectCommit` is not the task's `currentCommit`, or it names a different
   * repository from the one the profile declares.
   */
  'RECEIPT_NOT_THIS_DELIVERY',
  /**
   * No verification history. **Not** a claim that the merge is unverified —
   * only that AO holds no record of having verified it, which is
   * `--verify-merge`'s job.
   */
  'VERIFICATION_ABSENT',
  /**
   * A verification history is on disk and this build cannot read it as one.
   *
   * Includes a record edited in place: the history's binding digest covers
   * every field of every attempt, so an altered verdict reads as a foreign
   * record rather than as evidence.
   */
  'VERIFICATION_UNREADABLE',
  /**
   * A readable verification history that is not about the delivery this
   * receipt names.
   *
   * The six-field join in {@link describesSameDelivery}: the merge commit, the
   * implementation head, the forge identity and the pull-request number. This
   * is the member no existing reader could ever have produced.
   */
  'VERIFICATION_NOT_THIS_DELIVERY',
  /**
   * The history holds no verdict about this commit under **this** profile.
   *
   * Either nothing has been run under it, or everything run under it was
   * `VERIFICATION_NOT_ESTABLISHED` — a machine that could not answer, which is
   * not the machine saying no. Run `--verify-merge`.
   *
   * A pass under a *different* profile is deliberately not enough. That is a
   * verdict about a different contract, and it is the only kind of reason this
   * build accepts for setting a result aside — age is never one.
   */
  'PROFILE_NOT_VERIFIED',
  /**
   * The standing verdict for this commit under this profile is a **fail**.
   *
   * The repository answered the question it was asked, about the code at M, and
   * said no. This build does nothing about it: no revert, no branch, no issue,
   * no follow-up task. What to do about a merge that does not pass is a
   * decision this slice deliberately does not make.
   */
  'VERIFICATION_NOT_PASSING',
  /**
   * Every question was answered and this build declined to attest to the join.
   *
   * It is **not** claimed to be unreachable, and the reachable cause is not the
   * one an earlier version of this note named. That version said the mint only
   * "re-checks the object-name, digest and instant shapes that both schemas
   * already enforce", which would make this member a floor. A review found two
   * of the mint's gates reading values **no schema produced**: the profile
   * digest computed in this function, and `seams.now().toISOString()` — and
   * `toISOString` yields `+275760-09-13T00:00:00.000Z` for a date past year
   * 9999, which the `^\d{4}` anchor rejects. A clock seam returning such a date
   * reaches this member with both documents perfectly valid, and the test file
   * drives exactly that.
   *
   * The mint also checks that the two records agree about the task and the
   * repository root, which the ladder does not, because each loader has already
   * compared its own document against the subject.
   */
  'CONCLUSION_NOT_ATTESTED',
  /**
   * The join held: this task's delivery is concluded.
   *
   * The proof is minted and the caller may record it. Whether it *became*
   * durable is a separate fact with its own vocabulary — see
   * `delivery-conclusion-store.ts`, and the two report lines that never become
   * one.
   */
  'DELIVERY_CONCLUDED',
] as const;

export type DeliveryConclusionOutcome = (typeof DELIVERY_CONCLUSIONS)[number];

export const DELIVERY_CONCLUSION_DETAIL: Readonly<Record<DeliveryConclusionOutcome, string>> =
  Object.freeze({
    SUBJECT_NOT_ESTABLISHED: 'No delivery subject could be established for this task.',
    TASK_NOT_READY: 'The task is not at the state a delivery is concluded from.',
    RECEIPT_ABSENT: 'No merge receipt has been recorded for this task.',
    RECEIPT_UNREADABLE: 'A merge receipt is present and this build cannot read it.',
    RECEIPT_NOT_THIS_DELIVERY: "The merge receipt is not about this task's current delivery.",
    ALREADY_CONCLUDED: 'This delivery was already concluded, and this run changed nothing.',
    CONCLUSION_UNREADABLE: 'A conclusion is present and this build cannot read it.',
    CONCLUSION_CONFLICT: 'A conclusion is present for a different delivery of this task.',
    VERIFICATION_ABSENT: 'No verification of this merge commit has been recorded.',
    VERIFICATION_UNREADABLE:
      'A verification history is present and this build cannot read it.',
    VERIFICATION_NOT_THIS_DELIVERY:
      'The verification history and the merge receipt describe different deliveries.',
    PROFILE_NOT_VERIFIED:
      'No verdict about this merge commit exists under the profile resolved now.',
    VERIFICATION_NOT_PASSING:
      'The standing verdict for this merge commit under this profile is a failure.',
    CONCLUSION_NOT_ATTESTED:
      'The records were read and this build declined to attest to the join.',
    DELIVERY_CONCLUDED: "This task's delivery is concluded.",
  });

export interface DeliveryConclusionResult {
  readonly outcome: DeliveryConclusionOutcome;
  /**
   * The merge commit this result is about.
   *
   * On `ALREADY_CONCLUDED` and `CONCLUSION_CONFLICT` it is the **stored
   * conclusion's** own merge commit; from the line that reads a usable receipt
   * onwards it is the receipt's; `null` before either. Nothing else decides it.
   */
  readonly mergeCommit: string | null;
  /**
   * The implementation head, from whichever document supplied
   * {@link mergeCommit}.
   *
   * Carried because an operator reading `VERIFICATION_NOT_THIS_DELIVERY` needs
   * both halves of the join to see which document is the odd one.
   */
  readonly subjectCommit: string | null;
  /**
   * The profile **this invocation resolved**, and never a stored one.
   *
   * Non-null on every outcome, including the ones decided before any document
   * is read, because the digest is computed from the resolved repository and
   * does not depend on any of them — a report can therefore always say what a
   * refusal was measured against. A review found three receipt refusals
   * printing "not resolved" for a digest that had been computed two lines
   * earlier.
   */
  readonly profileDigest: string | null;
  /**
   * The profile the **stored** conclusion was drawn under, on the two outcomes
   * that read one, and `null` everywhere else.
   *
   * Kept apart from {@link profileDigest} rather than folded into it, because
   * they are different facts and a run can hold both: `ALREADY_CONCLUDED` under
   * an edited profile means "a conclusion exists, drawn under a contract this
   * build no longer has". A review measured the earlier version printing only
   * the current digest there, so an operator could not tell the two apart —
   * while deleting the record and re-running the same repository answers
   * `PROFILE_NOT_VERIFIED`.
   */
  readonly concludedUnderProfile: string | null;
  /**
   * The standing verdict's outcome under that profile, where one was found, and
   * `null` where the ladder stopped before asking or found none.
   *
   * Reported rather than folded into the outcome: `VERIFICATION_NOT_PASSING`
   * and a pass are both *answers about the code*, and an operator is entitled
   * to see which one without opening the record.
   */
  readonly standingOutcome: string | null;
  /**
   * The minted proof, on `DELIVERY_CONCLUDED` and on nothing else.
   *
   * The store refuses anything that is not one of these, so this field is the
   * only route from an assessment to a durable record.
   */
  readonly proof: DeliveryConclusionProof | null;
}

function outcome(
  code: DeliveryConclusionOutcome,
  mergeCommit: string | null = null,
  subjectCommit: string | null = null,
  profileDigest: string | null = null,
  standingOutcome: string | null = null,
  proof: DeliveryConclusionProof | null = null,
  concludedUnderProfile: string | null = null,
): DeliveryConclusionResult {
  return Object.freeze({
    outcome: code,
    mergeCommit,
    subjectCommit,
    profileDigest,
    standingOutcome,
    proof,
    concludedUnderProfile,
  });
}

/**
 * Whether a record naming an implementation head and a target is about **this
 * task's current delivery**.
 *
 * One predicate, two call sites — the stored conclusion and the merge receipt —
 * because it is one question asked of two documents. Written as a shared
 * derivation rather than as two spellings of the same rule, for the reason a
 * review gave when it found `publishableRef` duplicated: two expressions that
 * had to agree, and nothing that made them.
 *
 * `subjectCommit` is the record's own copy of the task's `currentCommit`. A
 * record naming another commit is about a delivery this task has walked away
 * from. The forge identity is part of the same question rather than something
 * assumed to follow from it: two forks can share a commit object name exactly.
 */
function aboutThisDelivery(
  record: {
    readonly subjectCommit: string;
    readonly host: string;
    readonly owner: string;
    readonly name: string;
  },
  subject: ConclusionSubject,
): boolean {
  return (
    record.subjectCommit === subject.deliveryCommit &&
    record.host === subject.host &&
    record.owner === subject.owner &&
    record.name === subject.name
  );
}

/**
 * The refusal shape for the two members the caller owns.
 *
 * Exported so the two members the ladder cannot produce for itself have one
 * spelling, and so this module is the only place a `DeliveryConclusionResult`
 * is built at all. Two places that construct one type is two places that can
 * disagree about which fields a refusal carries, which is a defect this
 * repository has already had twice.
 */
export function refuseDeliveryConclusion(
  code: Extract<DeliveryConclusionOutcome, 'SUBJECT_NOT_ESTABLISHED' | 'TASK_NOT_READY'>,
): DeliveryConclusionResult {
  return outcome(code);
}

/**
 * Decides whether this task's delivery may be concluded, and proves it.
 *
 * Never throws for an expected condition. Writes nothing, and reads **up to
 * three** documents — any conclusion already recorded, then the merge receipt,
 * then the verification history — stopping at the first that answers. It never
 * reads the task state; the caller does that, and hands the subject in.
 * Recording is the caller's step, through `recordDeliveryConclusion`.
 */
export function concludeDeliveryForTask(
  repository: ConclusionRepository,
  subject: ConclusionSubject,
  seams: ConclusionSeams,
): DeliveryConclusionResult {
  // ONE reading of each field of the record, and everything below uses it.
  //
  // `ConclusionRepository` is a bare structural type, so nothing says its
  // fields are values. A record whose `root` is an accessor answers about
  // repository A when the receipt is loaded and B when the history is; a
  // `verification` getter answers policy P when the digest is computed and Q
  // when it is compared. That is LF-2, which `lease/execution-lease.ts` records
  // as reproduced against three real functions with nothing forged anywhere.
  const root = repository.root;
  const profileDigest = verificationProfileDigest(repository.verification);

  const recordSubject = Object.freeze({ taskId: subject.taskId, repositoryRoot: root });

  // ── 1. A concluded delivery stays concluded ──────────────────────────────
  //
  // **First**, ahead of the receipt as well as ahead of the verification
  // questions, and the ordering is the contract rather than a convenience.
  //
  // It used to sit after the receipt gate, and a review measured what that
  // cost: delete the receipt, or let a newer build rewrite it, or let the task
  // move — and a task whose conclusion was on disk and perfectly readable
  // answered `RECEIPT_ABSENT`, never mentioning the conclusion at all. The
  // monotonicity this record exists for held against two of its three sources
  // and not the third, while the documentation claimed all three.
  //
  // Asking first is possible because the conclusion record carries its own
  // identity: the implementation head **H** and the delivery target. Those are
  // exactly what the receipt gate below compares, so the same predicate answers
  // both questions and there is no second spelling to drift.
  const storedConclusion = loadDeliveryConclusion(root, subject.taskId, recordSubject);
  if (storedConclusion.reading === 'DELIVERY_CONCLUDED') {
    // Non-null on this reading by construction; the guard keeps a future change
    // to the load result from letting a `null` be read as agreement.
    if (storedConclusion.conclusion === null) {
      return outcome('CONCLUSION_UNREADABLE', null, null, profileDigest);
    }
    const already = storedConclusion.conclusion;
    // The **stored** record's own facts are reported, not this run's: an
    // operator reading `ALREADY_CONCLUDED` needs the merge commit and the
    // profile the conclusion was actually drawn under, and this run has not
    // asked any question under the profile it resolved. A review measured the
    // earlier version printing the digest resolved *now* beside a conclusion
    // recorded under another one, with nothing saying they differed.
    const recorded = (code: DeliveryConclusionOutcome) =>
      outcome(
        code,
        already.mergeCommit,
        already.subjectCommit,
        profileDigest,
        null,
        null,
        already.profileDigest,
      );
    return aboutThisDelivery(already, subject)
      ? recorded('ALREADY_CONCLUDED')
      : recorded('CONCLUSION_CONFLICT');
  }
  if (storedConclusion.reading !== 'ABSENT') {
    return outcome('CONCLUSION_UNREADABLE', null, null, profileDigest);
  }

  // ── 2. The receipt is the only authority for a NEW conclusion ────────────
  const storedReceipt = loadMergeReconciliation(
    root,
    subject.taskId,
    recordSubject as MergeReconciliationSubject,
  );
  if (storedReceipt.reading === 'ABSENT') {
    return outcome('RECEIPT_ABSENT', null, null, profileDigest);
  }
  if (storedReceipt.reading !== 'HISTORICAL_MERGE' || storedReceipt.receipt === null) {
    return outcome('RECEIPT_UNREADABLE', null, null, profileDigest);
  }
  const receipt = storedReceipt.receipt;

  // ── 3. The receipt must be about this task's current delivery ────────────
  //
  // `subjectCommit` is the receipt's own record of the task's `currentCommit`
  // at reconciliation. If the task has moved since, this receipt describes a
  // delivery of a commit the task no longer stands on, and concluding it would
  // conclude a delivery the task has walked away from. The forge identity is
  // part of the same question: two forks can share a commit object name
  // exactly, so the target is checked rather than assumed to follow.
  if (!aboutThisDelivery(receipt, subject)) {
    return outcome('RECEIPT_NOT_THIS_DELIVERY', null, null, profileDigest);
  }

  const mergeCommit = receipt.mergeCommit;
  const head = receipt.subjectCommit;
  const at = (code: DeliveryConclusionOutcome, standing: string | null = null) =>
    outcome(code, mergeCommit, head, profileDigest, standing);

  // ── 4. The verification history for this task ────────────────────────────
  const storedVerification = loadPostMergeVerification(root, subject.taskId, recordSubject);
  if (storedVerification.reading === 'ABSENT') return at('VERIFICATION_ABSENT');
  if (
    storedVerification.reading !== 'VERIFICATION_HISTORY' ||
    storedVerification.record === null
  ) {
    return at('VERIFICATION_UNREADABLE');
  }
  const verification = storedVerification.record;

  // ── 5. The two documents must describe one delivery ──────────────────────
  if (!describesSameDelivery(receipt, verification)) {
    return at('VERIFICATION_NOT_THIS_DELIVERY');
  }

  // ── 6. The standing verdict under the profile resolved now ───────────────
  //
  // `standingVerdictFor`, not `hasPassFor`. The verification store's predicate
  // answers "is a re-run pointless?", for which any pass anywhere is a yes;
  // this asks "is the standing verdict a pass?", and the two differ on exactly
  // one shape — a pass followed by a fail for the same profile. That shape is
  // unreachable through this build's own product path, because a pass converges
  // `--verify-merge` before it runs anything, and it becomes reachable the
  // moment a forced re-verification exists (L-V4-09-2). Using the looser
  // predicate here would bake in the assumption that it never will.
  const standing = standingVerdictFor(verification, profileDigest);
  if (standing === null) return at('PROFILE_NOT_VERIFIED');
  if (standing.outcome !== 'VERIFIED_PASS') return at('VERIFICATION_NOT_PASSING', standing.outcome);

  // ── 7. Attest, from the two documents and the profile resolved here ──────
  const proof = mintDeliveryConclusion({
    receipt,
    verification,
    profileDigest,
    concludedAt: seams.now().toISOString(),
  });
  if (proof === null) return at('CONCLUSION_NOT_ATTESTED', standing.outcome);

  return outcome(
    'DELIVERY_CONCLUDED',
    mergeCommit,
    head,
    profileDigest,
    standing.outcome,
    proof,
  );
}
