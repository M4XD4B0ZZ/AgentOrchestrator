/**
 * The delivery lifecycle driver: one governed pass over the acts slices 1 to 10
 * already built.
 *
 * ── What this module is, in one sentence ───────────────────────────────────
 *
 * It derives where a task's delivery currently stands, invokes only the
 * primitives this invocation is already authorised to invoke, and stops at the
 * first condition it cannot legitimately cross.
 *
 * ── What it is not ─────────────────────────────────────────────────────────
 *
 * It is not a scheduler: it sleeps for nothing, polls nothing and starts no
 * background work. It is not a second delivery state machine: it writes no
 * record of its own and remembers nothing between invocations. It is not a
 * second observer, publisher, creator, merger, reconciler, verifier or
 * concluder: every one of those is `delivery-steps.ts`'s, called by name. And
 * it is not authority: it can perform no act the same invocation could not have
 * performed by naming that act's own flag.
 *
 * ── Position is derived, never stored ──────────────────────────────────────
 *
 * `concludeDeliveryForTask` is the position oracle, and it can be, because of
 * three properties it already had before this slice wanted them:
 *
 *  1. its whole seam list is **a clock**. No forge seam, no Git seam, no
 *     verification seam, so asking it contacts nothing, starts no process and
 *     takes no lease. It is not free — it reads up to three documents from
 *     disk, which its own header says, and an earlier version of this line
 *     called it "pure" and "reaches nothing", which a review measured as
 *     overstating exactly that;
 *  2. it **writes nothing** — the caller records, and only on the one member
 *     that says there is something to record;
 *  3. its refusals **name the stage that is missing**. `RECEIPT_ABSENT` means
 *     "no merge has been reconciled"; `VERIFICATION_ABSENT` and
 *     `PROFILE_NOT_VERIFIED` mean "M has no standing verdict under this
 *     profile"; `VERIFICATION_NOT_PASSING` means the repository answered and
 *     said no. Each of those is exactly one existing act away.
 *
 * So the driver asks it first, on every invocation, and branches on the answer.
 * There is nothing for a durable `DeliveryState` to hold that is not already on
 * disk in the four documents this ladder reads, and a record of *where the last
 * invocation got to* would be the one thing that must never be trusted — see
 * "one mutation" below.
 *
 * ── A concluded delivery is terminal, and costs nothing ────────────────────
 *
 * Because the conclusion is read first — ahead of the receipt and ahead of every
 * verification question, which is `conclude-delivery.ts`'s own ordering and its
 * own correction after a review — a delivery that was concluded answers
 * `ALREADY_CONCLUDED` before this module has contacted anything. The driver
 * turns that into `DELIVERY_CONCLUDED` and returns: no forge request, no
 * publication, no pull request, no merge, no verification, no execution lease.
 *
 * That property is a consequence of the ordering rather than a check bolted on
 * here, and it is why deleting the receipt or the verification history
 * afterwards cannot un-conclude a delivery. What the conclusion is **not** is
 * permission for anything: it ends this driver and authorises nothing. See
 * `L-V4-10-1`, which this slice narrows rather than closes — the record now has
 * a reader, and that reader treats it as a full stop.
 *
 * ── One mutation, and the theorem that rests on it ─────────────────────────
 *
 * **The driver stops at the first act that reports an attempt.** Not at the
 * first act it calls: a publication that answers `ALREADY_PUBLISHED` sent
 * nothing and is a reading, and the driver may go on to the creation. But the
 * moment a ladder's `attempt` is anything other than `NOT_ATTEMPTED`, this
 * invocation is over and the operator is told to ask again.
 *
 * Three things follow, and they are the whole safety argument:
 *
 *  - **at most one irreversible forge effect per invocation.** Never three
 *    behind one grant, even though the flag surface has permitted an operator
 *    to name all three since slice 7 and still does. Stated as a rule about
 *    grants rather than about `--attended`, because since V4 slice 13 there are
 *    two of them; under the automatic one the bound is tighter still, since the
 *    other two acts are refused on the command line;
 *  - **no observation proof is ever consumed after a mutation.** The merge is
 *    the only act that reads the proof, and it is reachable only in an
 *    invocation where nothing was pushed and nothing was created — so the
 *    proof that authorises a merge grant is exactly as fresh as it is under
 *    `--merge-pr` alone. Without this rule the driver would be the first caller
 *    in this build to decide a merge from an observation taken before its own
 *    pull request existed;
 *  - **no grant outlives its act.** Each ladder mints its own from facts read at
 *    its own point, spends it by claiming it, and this module never holds one.
 *
 * It also means the driver cannot close `L-V4-06-10` or `L-V4-07-1`, and it is
 * not trying to. Those say publish-then-create and create-then-merge do not
 * compose in one invocation. They still do not. What changes is that an
 * operator no longer has to know which of the ten acts comes next: the driver
 * says so, by name, with the flag that would authorise it.
 *
 * ── Asking again is the only retry ─────────────────────────────────────────
 *
 * Every uncertain member of every act's vocabulary is a full stop here.
 * `OUTCOME_UNCERTAIN`, `REMOTE_STATE_UNKNOWN`, `PULL_REQUEST_STATE_UNKNOWN`,
 * `POSTCONDITION_MISMATCH`, `OUTCOME_AMBIGUOUS`, `OBSERVATION_UNAVAILABLE`,
 * `EFFECT_NOT_ESTABLISHED` — the driver reports each and returns. It never
 * re-issues the request that produced one, because each of those modules says
 * the same thing about itself: *a retry must begin with a reading, never with a
 * second request*. A later invocation is that reading. It re-derives everything
 * from the world as it then is, which is what makes recovery work at all:
 * a branch somebody else pushed, a pull request somebody else opened, a merge
 * somebody else performed and a conclusion already on disk are all just states
 * the derivation finds.
 *
 * ── The order asks "has this already happened?" before "make it happen" ────
 *
 * Reconciliation runs before the observation, and that is deliberate. An
 * observation looks for an **open** pull request at this head, so a delivery
 * that was merged and closed is indistinguishable to it from one that never had
 * a pull request at all — and a driver that read only the decision would stage a
 * finished delivery as "needs a pull request". `reconcile-merge.ts` asks the
 * other question, takes no authority and no lease, and writes the receipt that
 * moves the delivery on. So it is asked first, every time, whenever no receipt
 * is on disk.
 */

import type { DeliveryConclusionOutcome } from '../deliver/conclude-delivery.js';
import { conclusionIsDurable } from '../deliver/delivery-conclusion-store.js';
import { receiptIsOnDisk } from '../deliver/merge-reconciliation-store.js';
import { isPositiveDeliveryDecision, type DeliveryDecision } from '../deliver/delivery-decision.js';
import type {
  DeliveryObservation,
  ObservationConclusion,
  resolveObservationSubject,
} from '../deliver/observe-delivery.js';
import type { PublicationResult } from '../deliver/publish-delivery-head.js';
import type { CreationResult } from '../deliver/create-pull-request.js';
import type { MergeResult } from '../deliver/merge-pull-request.js';
import type { SubjectRevalidation } from '../deliver/delivery-decision.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import type { loadTaskState } from '../state/state-store.js';
import type { resolveRepository } from '../repo/resolve-repository.js';
import {
  performConclusion,
  performCreation,
  performMerge,
  performObservation,
  performPublication,
  publishableRef,
  performReconciliation,
  performVerification,
  type DeliveryCommandSeams,
  type DeliveryOptions,
} from './delivery-steps.js';
import type {
  DeliveryConclusionView,
  ReconciliationView,
  VerificationView,
} from './render-delivery-observation.js';

/**
 * The three acts an operator can authorise for one driver invocation.
 *
 * Named rather than collapsed into a boolean, because they are three different
 * authorities and the report has to be able to say **which** one is missing.
 * A driver told it may publish is not a driver told it may merge.
 */
export const DELIVERY_EFFECTS = ['PUBLISH_HEAD', 'CREATE_PULL_REQUEST', 'MERGE_PULL_REQUEST'] as const;

export type DeliveryEffect = (typeof DELIVERY_EFFECTS)[number];

/** The flag that authorises each act, for the sentence the report prints. */
export const DELIVERY_EFFECT_FLAG: Readonly<Record<DeliveryEffect, string>> = Object.freeze({
  // Two entries for one act, since V4 slice 13. Both are named because naming
  // only the first would send an operator running unattended to a flag their
  // invocation refuses, and naming only the second would send an operator at a
  // terminal to a declaration they do not need.
  PUBLISH_HEAD: '--publish-head --attended (or --publish-head --automatic-publish-head-only)',
  CREATE_PULL_REQUEST: '--create-pr --attended',
  MERGE_PULL_REQUEST: '--merge-pr --attended',
});

/**
 * The closed vocabulary, ordered as the driver's own ladder decides it.
 *
 * Every member answers one question — *what stopped this invocation* — and
 * every member says what the operator or the world has to do next. There is no
 * member meaning "in progress": a driver invocation is over when it returns.
 */
export const DELIVERY_DRIVES = [
  /**
   * No subject, so there is nothing this could be about. The delivery target
   * did not resolve, the task record could not be read, or the task has no
   * current commit. Produced by the caller, as slices 7 to 10 all do.
   */
  'SUBJECT_NOT_ESTABLISHED',
  /** The task is not at the state a delivery is driven from. Caller's too. */
  'TASK_NOT_READY',
  /**
   * `--drive` was passed together with an act flag it does not compose with.
   *
   * The driver decides which acts to run; a run that also names `--observe`,
   * `--record`, `--decide`, `--reconcile-merge`, `--verify-merge` or
   * `--conclude-delivery` is asking for two different orderings of the same
   * acts in one invocation. Nothing is contacted and nothing is written.
   */
  'DRIVE_NOT_COMBINABLE',
  /**
   * A document on the conclusion's path could not be read, or is about another
   * delivery: the conclusion, the merge receipt or the verification history.
   *
   * Terminal for this build, and deliberately so — under `UNSUPPORTED_VERSION`
   * the document may be a perfectly good record written by a newer one.
   * Nothing is repaired, nothing is overwritten and nothing is deleted.
   */
  'DELIVERY_EVIDENCE_UNUSABLE',
  /**
   * Every document was read and the conclusion mint declined to attest.
   *
   * Distinct from the member above because nothing here is unreadable: the two
   * records agree and something the mint checks — the profile digest or the
   * instant this run stamped — did not pass its own shape gate.
   */
  'CONCLUSION_NOT_ATTESTED',
  /**
   * The standing verdict for this merge commit under this profile is a fail.
   *
   * A **code** verdict: the repository answered the question it was asked, about
   * the code at M, and said no. The driver does nothing about it — no revert,
   * no branch, no issue, no follow-up task, and emphatically no re-run.
   */
  'VERIFICATION_FAILED',
  /**
   * The verification could not be established, which is never the same as a
   * failure.
   *
   * The merge commit is not present locally and this build will not fetch it,
   * the workspace could not be made, the execution lease could not be taken, or
   * the gate could not be run to an answer. An **infrastructure** verdict.
   */
  'VERIFICATION_NOT_ESTABLISHED',
  /**
   * A reading this invocation needed could not be taken.
   *
   * The forge could not answer the merge question, or an act's own reading —
   * the remote ref, the pull request by number, the situation at this head —
   * could not be completed. Nothing was sent on any of those paths, and nothing
   * durable is wrong: the next invocation begins with the same reading.
   *
   * It is deliberately **not** `MERGE_NOT_ESTABLISHED`, which this member
   * replaced. A review measured that name covering two unrelated conditions —
   * a forge that would not answer, and a receipt that would not reach the disk
   * — and grading them both as "nothing durable is wrong", which is false of
   * the second.
   */
  'FORGE_STATE_UNKNOWN',
  /**
   * The merge was observed and the receipt did not reach the disk.
   *
   * The delivery has not moved, because every act after this one reads the
   * document rather than the reading that produced it. **Something durable may
   * well be wrong** — a contradictory receipt already on disk, a directory that
   * could not be made, a write that got far enough to leave a staging file —
   * so the exit code is the store's own, graded one code at a time, exactly as
   * {@link DELIVERY_DRIVES}' conclusion counterpart is.
   */
  'RECEIPT_NOT_DURABLE',
  /**
   * The unattended publication was permitted and its accountability record did
   * not reach the disk, so nothing was published.
   *
   * A member of its own rather than a variant of `ATTENDED_AUTHORITY_REQUIRED`,
   * because the authority is not what is missing: this invocation was permitted
   * and would have published. Telling an operator to pass a flag would be
   * telling them to work around the one gate this build put in front of an act
   * nobody watches.
   *
   * Nothing was read from the delivery remote and nothing was attempted, which
   * is why it is not `EFFECT_ATTEMPTED` either. What is wrong is local and in
   * one of two places: the store under the operator's own profile, or a subject
   * this build's record contract will not hold. Neither is cleared by asking
   * again, and the `Publication` line beside this says which member it was.
   */
  'PUBLICATION_AUDIT_NOT_DURABLE',
  /**
   * The forge did not answer both of the observation's questions, so nothing
   * was established to decide from. Slice 2's `OBSERVATION_INCOMPLETE`, one
   * level up.
   */
  'OBSERVATION_UNSETTLED',
  /**
   * The local subject moved while the forge was being asked, or could not be
   * re-established afterwards. Nothing was decided against answers about a
   * commit the task has since walked away from.
   */
  'SUBJECT_CHANGED',
  /**
   * No open pull request has this head, and the driver may not open one.
   *
   * Not a claim that none is needed and not a claim that the head is published:
   * both of those are questions the acts answer for themselves.
   */
  'PULL_REQUEST_REQUIRED',
  /** More than one open pull request claims this head. A person decides which. */
  'PULL_REQUEST_AMBIGUOUS',
  /** A pull request has this head and the commit carries no checks at all. */
  'CHECKS_ABSENT',
  /** A pull request has this head and at least one check is still running. */
  'CHECKS_PENDING',
  /** A pull request has this head and at least one check did not succeed. */
  'CHECKS_FAILED',
  /**
   * The world is in a state this build refuses to act on, and a person put it
   * there: a pull request closed unmerged at this head, a delivery ref holding
   * another commit, a draft or a base this build will not work around.
   *
   * Several of these github.com would permit. The refusal is AO's, and a driver
   * that resolved one would be widening authority rather than orchestrating.
   */
  'HUMAN_DECISION_REQUIRED',
  /**
   * The next act is a forge mutation this invocation was not authorised to
   * perform. Nothing was sent. {@link DeliveryDriveResult.requiredEffect} names
   * which one, and {@link DELIVERY_EFFECT_FLAG} the flags that would grant it.
   */
  'ATTENDED_AUTHORITY_REQUIRED',
  /**
   * One act attempted a forge mutation, and this invocation stops there.
   *
   * Whether it succeeded is the act's own result and is reported beside this;
   * the driver does not read it to decide anything, because the next thing to
   * do after any attempt — successful, failed or uncertain — is the same: ask
   * again, and let the reading say what happened.
   */
  'EFFECT_ATTEMPTED',
  /**
   * The ladder concluded the delivery and the claim is not on disk afterwards.
   *
   * The one shape that must not be reported as success: a caller told yes about
   * something that did not happen would act on it.
   */
  'CONCLUSION_NOT_DURABLE',
  /**
   * This task's delivery is concluded, and the lifecycle is over.
   *
   * Reached two ways that are deliberately one member: a conclusion already on
   * disk, and a conclusion this invocation drew and recorded. An operator
   * asking "is this delivered?" gets the same answer either way, and the
   * Completion line beside it says which happened.
   */
  'DELIVERY_CONCLUDED',
] as const;

export type DeliveryDrive = (typeof DELIVERY_DRIVES)[number];

export const DELIVERY_DRIVE_DETAIL: Readonly<Record<DeliveryDrive, string>> = Object.freeze({
  SUBJECT_NOT_ESTABLISHED: 'No delivery subject could be established for this task.',
  TASK_NOT_READY: 'The task is not at the state a delivery is driven from.',
  DRIVE_NOT_COMBINABLE:
    '--drive chooses the acts itself, so it does not compose with the flags that name them. ' +
    'Nothing was contacted and nothing was written.',
  DELIVERY_EVIDENCE_UNUSABLE:
    'A record on this delivery’s path could not be read, or is about another delivery. ' +
    'Nothing was repaired and nothing was overwritten.',
  CONCLUSION_NOT_ATTESTED:
    'The records were read and this build declined to attest to the join.',
  VERIFICATION_FAILED:
    'The standing verdict for this merge commit under this profile is a failure. ' +
    'That is an answer about the code, and this build does nothing about it.',
  VERIFICATION_NOT_ESTABLISHED:
    'No standing verdict about this merge commit under this profile could be established. ' +
    'That is not the machine saying no — the Verification block above says what stopped it.',
  FORGE_STATE_UNKNOWN:
    'A reading this invocation needed could not be taken from github.com. Nothing was sent.',
  RECEIPT_NOT_DURABLE:
    'The merge was observed and the receipt did not reach the disk, so this delivery has not moved.',
  PUBLICATION_AUDIT_NOT_DURABLE:
    'Publishing with nobody present was permitted, and the record of that permission did not reach the disk. ' +
    'Nothing was read from the delivery remote and nothing was attempted.',
  OBSERVATION_UNSETTLED:
    'At least one of the two questions was not answered, so there is nothing to decide from.',
  SUBJECT_CHANGED:
    'The task moved, or could not be re-read, while the forge was being asked. Ask again.',
  PULL_REQUEST_REQUIRED:
    'No open pull request has this head. Opening one is an act an operator authorises.',
  PULL_REQUEST_AMBIGUOUS:
    'More than one open pull request claims this head. Which one is delivered is a person’s decision.',
  CHECKS_ABSENT: 'This commit carries no checks, so nothing has succeeded on it.',
  CHECKS_PENDING: 'At least one check on this commit is still running. Ask again later.',
  CHECKS_FAILED: 'At least one check on this commit did not succeed.',
  HUMAN_DECISION_REQUIRED:
    'The delivery is in a state this build will not act on, and a person put it there.',
  ATTENDED_AUTHORITY_REQUIRED:
    'The next act is a forge mutation this invocation was not authorised to perform. Nothing was sent.',
  EFFECT_ATTEMPTED:
    'One act was attempted on the forge, and this invocation stops there. Ask again: ' +
    'the next invocation reads what happened rather than repeating it.',
  CONCLUSION_NOT_DURABLE:
    'The delivery was concluded and the claim did not reach the disk.',
  DELIVERY_CONCLUDED: 'This task’s delivery is concluded.',
});

/**
 * Everything one driver invocation did, and what it came to.
 *
 * The per-act fields are the same views the command already builds and the
 * renderer already prints, carried rather than restated: an act the driver did
 * not reach is `null`, and an act it did reach renders exactly as it would have
 * under its own flag. Nothing here is a second wording of a result.
 */
export interface DeliveryDriveResult {
  readonly outcome: DeliveryDrive;
  /**
   * The act the driver stopped short of, on `ATTENDED_AUTHORITY_REQUIRED`, and
   * `null` on every other member — including `EFFECT_ATTEMPTED`, where the act
   * is named by its own view rather than by a second field that could disagree
   * with it.
   */
  readonly requiredEffect: DeliveryEffect | null;
  /** The conclusion ladder's last answer, which is where position came from. */
  readonly conclusionOutcome: DeliveryConclusionOutcome | null;
  readonly observation: DeliveryObservation | null;
  readonly observationConclusion: ObservationConclusion | null;
  readonly decision: { readonly decision: DeliveryDecision; readonly revalidation: SubjectRevalidation | null } | null;
  readonly publication: {
    readonly result: PublicationResult;
    readonly ref: string | null;
    readonly remoteName: string | null;
  } | null;
  readonly creation: {
    readonly result: CreationResult;
    readonly headRef: string | null;
    readonly baseRef: string | null;
    readonly draft: boolean | null;
  } | null;
  readonly merge: {
    readonly result: MergeResult;
    readonly pullRequestNumber: number | null;
    readonly baseRef: string | null;
  } | null;
  readonly reconciliation: ReconciliationView | null;
  readonly verification: VerificationView | null;
  readonly deliveryConclusion: DeliveryConclusionView | null;
}

const EMPTY = Object.freeze({
  requiredEffect: null,
  conclusionOutcome: null,
  observation: null,
  observationConclusion: null,
  decision: null,
  publication: null,
  creation: null,
  merge: null,
  reconciliation: null,
  verification: null,
  deliveryConclusion: null,
}) satisfies Omit<DeliveryDriveResult, 'outcome'>;

/**
 * The refusal shape for the three members the driver's own ladder cannot
 * produce for itself.
 *
 * Exported so this module stays the only place a `DeliveryDriveResult` is
 * built. Two places that construct one type is two places that can disagree
 * about which fields a refusal carries, which is a defect this repository has
 * already had more than once.
 */
export function refuseDeliveryDrive(
  outcome: Extract<
    DeliveryDrive,
    'SUBJECT_NOT_ESTABLISHED' | 'TASK_NOT_READY' | 'DRIVE_NOT_COMBINABLE'
  >,
): DeliveryDriveResult {
  return Object.freeze({ outcome, ...EMPTY });
}

/**
 * What each member of the conclusion ladder means to the driver.
 *
 * A **total** map rather than a set of the interesting ones, and that is the
 * whole point: `satisfies Record<DeliveryConclusionOutcome, …>` makes a
 * sixteenth member of that vocabulary fail the build here until somebody
 * classifies it. A review measured the earlier version — a `ReadonlySet` plus
 * an unconditional fall-through — claiming exactly this property and not having
 * it: a new member would have compiled and been treated as a *stage*, sending
 * the driver on to reconcile, observe and mutate on an outcome nobody had read.
 *
 * `null` means "this is a stage, not a stop": the ladder is telling the driver
 * which act is missing rather than why it may not proceed.
 */
const CONCLUSION_MEANING = Object.freeze({
  // Stops the caller already refused. Floors here, kept so the map stays total.
  SUBJECT_NOT_ESTABLISHED: 'SUBJECT_NOT_ESTABLISHED',
  TASK_NOT_READY: 'TASK_NOT_READY',
  // The terminal member, and the one that needs the record read beside it.
  ALREADY_CONCLUDED: 'DELIVERY_CONCLUDED',
  DELIVERY_CONCLUDED: 'DELIVERY_CONCLUDED',
  // A document that could not be read, or is about another delivery.
  CONCLUSION_UNREADABLE: 'DELIVERY_EVIDENCE_UNUSABLE',
  CONCLUSION_CONFLICT: 'DELIVERY_EVIDENCE_UNUSABLE',
  RECEIPT_UNREADABLE: 'DELIVERY_EVIDENCE_UNUSABLE',
  RECEIPT_NOT_THIS_DELIVERY: 'DELIVERY_EVIDENCE_UNUSABLE',
  VERIFICATION_UNREADABLE: 'DELIVERY_EVIDENCE_UNUSABLE',
  VERIFICATION_NOT_THIS_DELIVERY: 'DELIVERY_EVIDENCE_UNUSABLE',
  // Everything was read and the mint declined.
  CONCLUSION_NOT_ATTESTED: 'CONCLUSION_NOT_ATTESTED',
  // The repository answered about the code, and said no.
  VERIFICATION_NOT_PASSING: 'VERIFICATION_FAILED',
  // The three that name a stage rather than a stop.
  RECEIPT_ABSENT: null,
  VERIFICATION_ABSENT: null,
  PROFILE_NOT_VERIFIED: null,
}) satisfies Record<DeliveryConclusionOutcome, DeliveryDrive | null>;

/**
 * The acts the driver may run, and the ones it may not.
 *
 * Read from the same flags the manual surface uses, and that is the whole of
 * the authority model: `--drive --merge-pr --attended` authorises exactly what
 * `--merge-pr --attended` authorises, on a delivery the driver has worked out
 * is at the merge. There is no drive-shaped authority, no "advance everything"
 * flag, and no way to reach an act whose own flag was not named.
 *
 * ── The one act with two grants, and why the shape changed ────────────────
 *
 * V4 slice 13 gave the publication a second grant, `--automatic-publish-head-
 * only`, and the function is restructured rather than extended so that the
 * second grant cannot leak. `options.attended !== true` used to be a single
 * floor over all three acts; a slice that added an `||` to it would have widened
 * every act at once, which is exactly the mistake a floor makes easy. So the
 * publication answers first and completely, and the floor below it now guards
 * only the two acts that still have one grant each.
 *
 * What it still reads is flags, and only flags: the act's own, plus the grants.
 * Whether the *declaration* permits an unattended publication is not asked here
 * — this function is pure, and asking would mean reading a file to answer a
 * question about a command line. `performPublication` asks it, at the point of
 * effect, and refuses there under its own member.
 */
function mayPerform(options: DeliveryOptions, effect: DeliveryEffect): boolean {
  if (effect === 'PUBLISH_HEAD') {
    if (options.publishHead !== true) return false;
    return options.attended === true || options.automaticPublishHeadOnly === true;
  }
  // The two acts this build performs only with an operator present. Neither is
  // reachable under the automatic publication grant, and `delivery-command.ts`
  // refuses their flags alongside it besides — two independent refusals, because
  // one of them is a rule about a command line and this one is a rule about an
  // authority.
  if (options.attended !== true) return false;
  if (effect === 'CREATE_PULL_REQUEST') return options.createPr === true;
  return options.mergePr === true;
}

/**
 * Drives one task's delivery as far as this invocation legitimately can.
 *
 * Never throws for an expected condition. Writes at most the records the acts
 * it runs write, and mutates the forge at most once.
 */
export async function driveDelivery(
  repository: ResolvedRepository,
  options: DeliveryOptions,
  subject: ReturnType<typeof resolveObservationSubject>,
  taskLoad: ReturnType<typeof loadTaskState>,
  resolve: typeof resolveRepository,
  load: typeof loadTaskState,
  seams: DeliveryCommandSeams,
): Promise<DeliveryDriveResult> {
  // The two members the ladder does not produce for itself, in the order every
  // sibling slice declares them: a subject that could not be established comes
  // ahead of a task that is not ready, because a refusal about a subject that
  // does not exist would be describing nothing.
  if (!subject.ok || !taskLoad.ok) return refuseDeliveryDrive('SUBJECT_NOT_ESTABLISHED');
  if (taskLoad.state.state !== 'READY_FOR_PR') return refuseDeliveryDrive('TASK_NOT_READY');

  // Everything the driver accumulates as it goes. Assembled into the result at
  // each exit rather than mutated into one, so a field can only be non-null on
  // an invocation that actually reached the act it describes.
  let reconciliation: ReconciliationView | null = null;
  let verification: VerificationView | null = null;
  let deliveryConclusion: DeliveryConclusionView | null = null;
  let observation: DeliveryObservation | null = null;
  let observationConclusion: DeliveryDriveResult['observationConclusion'] = null;
  let decision: DeliveryDriveResult['decision'] = null;
  let publication: DeliveryDriveResult['publication'] = null;
  let creation: DeliveryDriveResult['creation'] = null;
  let merge: DeliveryDriveResult['merge'] = null;

  const settle = (
    outcome: DeliveryDrive,
    conclusionOutcome: DeliveryConclusionOutcome | null = null,
    requiredEffect: DeliveryEffect | null = null,
  ): DeliveryDriveResult =>
    Object.freeze({
      outcome,
      requiredEffect,
      conclusionOutcome,
      observation,
      observationConclusion,
      decision,
      publication,
      creation,
      merge,
      reconciliation,
      verification,
      deliveryConclusion,
    });

  const conclusionSeams = {
    now: seams.now,
    checkIgnored: seams.checkIgnored,
    git: seams.git,
  };

  /**
   * Ask the position oracle, and turn its answer into either a stop or a stage.
   *
   * `null` means "the answer is a stage, not a stop" and the caller reads
   * `deliveryConclusion` for which one. Everything else is this invocation's
   * result.
   *
   * Called at most three times, and only on one path: once at the top, once
   * after a reconciliation that filed a receipt, and once after the gate. Each
   * is a re-derivation from disk rather than a retry — nothing is re-attempted,
   * and only the terminal one can mint or record. The second call is a re-derivation
   * from disk, not a retry — nothing is re-attempted, and if it still answers a
   * stage the driver stops rather than going round again.
   */
  const askConclusion = async (): Promise<{
    readonly stop: DeliveryDriveResult | null;
    readonly stage: DeliveryConclusionOutcome;
  }> => {
    const view = await performConclusion(
      repository,
      options.task,
      subject,
      taskLoad,
      load,
      conclusionSeams,
    );
    deliveryConclusion = view;
    const stage = view.result.outcome;
    const stop = (outcome: DeliveryDrive): { stop: DeliveryDriveResult; stage: DeliveryConclusionOutcome } =>
      ({ stop: settle(outcome, stage), stage });

    // One lookup in a total map, rather than a chain of comparisons a new
    // member could fall off the end of.
    const meaning = CONCLUSION_MEANING[stage];
    if (meaning === null) {
      // `RECEIPT_ABSENT`, `VERIFICATION_ABSENT` and `PROFILE_NOT_VERIFIED`: the
      // three that name a stage rather than a stop.
      return { stop: null, stage };
    }
    if (meaning === 'DELIVERY_CONCLUDED' && stage === 'DELIVERY_CONCLUDED') {
      // Concluded **and** on disk, or it is not concluded as far as a caller is
      // concerned: a run that answered yes and left nothing behind has told a
      // caller about something that did not happen. `ALREADY_CONCLUDED` takes
      // the map's answer directly and needs no record — the claim was there
      // before this invocation began.
      return view.record !== null && conclusionIsDurable(view.record.code)
        ? stop('DELIVERY_CONCLUDED')
        : stop('CONCLUSION_NOT_DURABLE');
    }
    return stop(meaning);
  };

  const first = await askConclusion();
  if (first.stop !== null) return first.stop;
  const stage = first.stage;

  /**
   * Run the gate once, then re-derive.
   *
   * One attempt per invocation, deliberately. A second run here would be this
   * build's first retry of a verification, and a fail is terminal for the
   * commit/profile pair anyway — so a loop could only ever re-pay a ten-minute
   * gate to be told the same thing.
   */
  const verifyThenConclude = async (
    /**
     * The stage the ladder names **now**, not the one this invocation opened
     * with. The reconciliation branch moves the ladder past `RECEIPT_ABSENT`
     * before calling this, and a review measured the earlier version reporting
     * the opening stage on that path — `Position: RECEIPT_ABSENT` under a
     * `Completion: VERIFICATION_ABSENT` line, on the run that had just recorded
     * the receipt.
     */
    at: DeliveryConclusionOutcome,
  ): Promise<DeliveryDriveResult> => {
    verification = await performVerification(options, repository, subject, taskLoad, {
      // A fresh object of exactly the named seams, not `seams` itself. A wider
      // value is assignable to a narrower parameter type, so passing `seams`
      // would leave the three forge-mutation runners on the value at runtime
      // and "it cannot reach one" would be about the type only.
      now: seams.now,
      checkIgnored: seams.checkIgnored,
      git: seams.git,
      verify: seams.verify,
    });
    const ran = verification.result.outcome;
    if (ran !== 'VERIFICATION_ATTEMPTED' && ran !== 'ALREADY_VERIFIED') {
      // Every other member is a machine that could not answer: the execution
      // lease, the workspace, a merge commit this build will not fetch, or a
      // mint that declined. None of them is a verdict about the code, and
      // reporting one as a failure is the confusion slice 9 exists to prevent.
      return settle('VERIFICATION_NOT_ESTABLISHED', at);
    }
    const after = await askConclusion();
    // The gate ran and the ladder still names a stage: the history it wrote is
    // not one this profile can conclude from. Not a verdict, and not a loop —
    // this invocation is over either way.
    return after.stop ?? settle('VERIFICATION_NOT_ESTABLISHED', after.stage);
  };

  // ── The merge is on disk; what is missing is a verdict about it ───────────
  if (stage === 'VERIFICATION_ABSENT' || stage === 'PROFILE_NOT_VERIFIED') {
    return verifyThenConclude(stage);
  }

  // ── No receipt: ask whether this delivery was already merged ──────────────
  //
  // Before anything is published, opened or merged, and before the observation.
  // A merged pull request is closed, and slice 2's observation only counts open
  // ones — so a driver that asked the observation first would stage a finished
  // delivery as "needs a pull request" and, with the authority, open a second
  // one for a commit that is already on the base branch.
  reconciliation = await performReconciliation(options, repository.root, subject, taskLoad, {
    now: seams.now,
    checkIgnored: seams.checkIgnored,
    git: seams.git,
    runner: seams.runner,
    envSource: seams.envSource,
  });
  const reconciled = reconciliation.result.outcome;
  if (reconciled === 'MERGE_OBSERVED') {
    // The reading found a merge. Whether the receipt reached the disk decides
    // whether the delivery moved: every act after this one reads the document
    // rather than this result, so a reading nobody could store has advanced
    // nothing.
    if (reconciliation.record === null || !receiptIsOnDisk(reconciliation.record.code)) {
      return settle('RECEIPT_NOT_DURABLE', stage);
    }
    const after = await askConclusion();
    if (after.stop !== null) return after.stop;
    // The receipt is on disk, so the ladder has moved past `RECEIPT_ABSENT` and
    // is asking for a verdict about M. Run the gate, once — and under the stage
    // the ladder names **now**, not the one this invocation started from. A
    // review measured the earlier version reporting `Position: RECEIPT_ABSENT`
    // on the invocation that had just recorded one, three lines under a
    // `Completion` line saying otherwise.
    return verifyThenConclude(after.stage);
  }
  if (reconciled === 'FORGE_UNREADABLE') return settle('FORGE_STATE_UNKNOWN', stage);
  if (
    reconciled === 'PULL_REQUEST_AMBIGUOUS' ||
    reconciled === 'MERGE_NOT_THIS_DELIVERY' ||
    reconciled === 'BASE_NOT_INTENDED'
  ) {
    return settle('HUMAN_DECISION_REQUIRED', stage);
  }
  if (reconciled === 'SUBJECT_NOT_ESTABLISHED' || reconciled === 'TASK_NOT_READY') {
    // `TASK_NOT_READY` is a floor — the caller refused it before this function
    // ran. `SUBJECT_NOT_ESTABLISHED` is **not**, and a review measured why: the
    // reconciliation has a producer the caller does not check, a `baseBranch`
    // that is not a sendable branch name. A task at `READY_FOR_PR` carrying
    // `a..b` reaches it.
    return settle(reconciled, stage);
  }
  // `NOT_MERGED`, `PULL_REQUEST_STILL_OPEN` and `NO_PULL_REQUEST_AT_HEAD` all
  // mean the same thing to a driver: nothing is merged, so the delivery is
  // somewhere on the way in.

  // ── Look, and decide ─────────────────────────────────────────────────────
  const looked = await performObservation(
    options,
    { observe: true, proof: true, decide: true },
    subject,
    resolve,
    load,
    seams,
  );
  observation = looked.observation;
  observationConclusion = looked.conclusion;
  if (looked.decision === null) {
    // Unreachable: `decide` is passed as `true` above, and
    // `concludeDeliveryDecision` is total. It stays because a `null` reaching
    // the acts below would be a mutation decided from no decision at all.
    return settle('OBSERVATION_UNSETTLED', stage);
  }
  decision = Object.freeze({ decision: looked.decision, revalidation: looked.revalidation });
  const decided = looked.decision;

  if (decided === 'OBSERVATION_UNSETTLED' || decided === 'NOT_DECIDED') {
    return settle('OBSERVATION_UNSETTLED', stage);
  }
  if (decided === 'SUBJECT_NOT_ESTABLISHED') return settle('SUBJECT_NOT_ESTABLISHED', stage);
  if (decided === 'SUBJECT_CHANGED' || decided === 'SUBJECT_REVALIDATION_FAILED') {
    return settle('SUBJECT_CHANGED', stage);
  }
  if (decided === 'CHECKS_FAILED') return settle('CHECKS_FAILED', stage);
  if (decided === 'PULL_REQUEST_AMBIGUOUS') return settle('PULL_REQUEST_AMBIGUOUS', stage);

  // ── The merge, and it is the only act reachable from a positive decision ──
  if (isPositiveDeliveryDecision(decided)) {
    if (!mayPerform(options, 'MERGE_PULL_REQUEST')) {
      return settle('ATTENDED_AUTHORITY_REQUIRED', stage, 'MERGE_PULL_REQUEST');
    }
    merge = await performMerge(
      options,
      subject,
      taskLoad,
      decided,
      looked.proof,
      resolve,
      load,
      seams,
    );
    if (merge.result.attempt !== 'NOT_ATTEMPTED') return settle('EFFECT_ATTEMPTED', stage);
    // Nothing was sent, so the ladder's refusal is the answer — and it is read
    // member by member rather than collapsed. A review measured the collapsed
    // version reporting "a person put it there" for a forge that could not be
    // read, which is the machine-versus-person confusion this vocabulary exists
    // to keep apart.
    const merged = merge.result.outcome;
    if (merged === 'PULL_REQUEST_STATE_UNKNOWN' || merged === 'OBSERVATION_UNAVAILABLE') {
      return settle('FORGE_STATE_UNKNOWN', stage);
    }
    if (merged === 'SUBJECT_CHANGED') return settle('SUBJECT_CHANGED', stage);
    // What is left is mostly states somebody put this delivery in —
    // `PULL_REQUEST_NOT_OPEN`, `DRAFT_REFUSED`, `WRONG_BASE`, `HEAD_MOVED`,
    // `POSTCONDITION_MISMATCH`, `ALREADY_MERGED` — plus `AUTHORITY_REFUSED`,
    // the four floors this path cannot reach, and the three members the
    // transport can answer before a process exists. **Not every one of them is
    // a person's doing**, and the sentence this member carries says one is:
    // that is `L-V4-11-10`, widened. `ALREADY_MERGED` is the race worth naming
    // — the reconciliation two steps above said otherwise a moment ago, and two
    // readings that disagree is not a state to act on either.
    return settle('HUMAN_DECISION_REQUIRED', stage);
  }

  // ── Everything else means no open pull request has this head ──────────────
  //
  // `PULL_REQUEST_REQUIRED`, and the two that mean one exists but has not
  // settled: `CHECKS_PENDING` and `CHECKS_ABSENT`. The last two are reported
  // and not acted on — there is no act between a pull request and its checks.
  if (decided === 'CHECKS_PENDING') return settle('CHECKS_PENDING', stage);
  if (decided === 'CHECKS_ABSENT') return settle('CHECKS_ABSENT', stage);

  // Publish first, then create: a pull request is opened from a branch that has
  // to be on the remote already. The publication is create-only and fenced
  // server-side, so a head that is already there answers `ALREADY_PUBLISHED`,
  // sends nothing, and the driver goes on to the creation in the same pass.
  if (mayPerform(options, 'PUBLISH_HEAD')) {
    publication = {
      result: await performPublication(
        options,
        repository.root,
        subject,
        taskLoad,
        resolve,
        load,
        seams,
      ),
      ref: taskLoad.ok ? publishableRef(taskLoad.state.workBranch) : null,
      remoteName: subject.remoteName,
    };
    if (publication.result.attempt !== 'NOT_ATTEMPTED') return settle('EFFECT_ATTEMPTED', stage);
    const published = publication.result.publication;
    if (published === 'REF_HOLDS_ANOTHER_COMMIT') return settle('HUMAN_DECISION_REQUIRED', stage);
    if (published === 'REMOTE_STATE_UNKNOWN') {
      // A reading that could not be taken, not a head that is not there.
      return settle('FORGE_STATE_UNKNOWN', stage);
    }
    if (published === 'REMOTE_URLS_DIVERGE') {
      // **Nothing was asked of github.com.** `readUrlAgreement` is two local
      // `git remote get-url` calls, and this member covers both of its
      // not-`AGREE` answers: they answered and disagreed, or neither could be
      // answered. `head-publication.ts` says exactly that, and this build does
      // not tell the two apart — so the member is right about the act (nothing
      // sent, nothing attempted, no invocation clears it) while the sentence
      // beside it, "a person put it there", is true of the first half only.
      // That is `L-V4-11-13`. A review measured the earlier version, which told
      // an operator a reading "could not be taken from github.com" about a host
      // this run had not asked anything.
      return settle('HUMAN_DECISION_REQUIRED', stage);
    }
    if (published === 'SUBJECT_CHANGED') return settle('SUBJECT_CHANGED', stage);
    if (published === 'PUBLICATION_AUDIT_UNWRITTEN') {
      // Named before the authority arm below, because this run had the
      // authority. The publication was permitted, this build would not perform
      // it without leaving durable evidence of that permission, and the evidence
      // could not be established — so nothing was contacted. An operator sent to
      // `--attended` here would be sent to work around the gate rather than to
      // fix the machine.
      return settle('PUBLICATION_AUDIT_NOT_DURABLE', stage);
    }
    if (
      published === 'AUTOMATIC_PUBLICATION_NOT_DECLARED' ||
      published === 'AUTOMATIC_PUBLICATION_DENIED' ||
      published === 'PUBLICATION_POLICY_UNREADABLE'
    ) {
      // The invocation asked to publish with nobody present and the authority
      // for that was not established. Named ahead of the arm below because that
      // one answers `SUBJECT_NOT_ESTABLISHED`, and there is nothing wrong with
      // this subject: the work branch is publishable, the task is ready, and an
      // operator passing `--publish-head --attended` would publish it now.
      //
      // `ATTENDED_AUTHORITY_REQUIRED` is the member because it is the true one:
      // this act was not authorised by this invocation, an attended invocation
      // would authorise it, and `DELIVERY_EFFECT_FLAG` names both routes.
      // Which of the three refusals it was is on the `Publication` line beside
      // this, in that member's own words — a summary that tried to carry it
      // would be a second vocabulary saying the same thing one step later.
      return settle('ATTENDED_AUTHORITY_REQUIRED', stage, 'PUBLISH_HEAD');
    }
    if (published !== 'ALREADY_PUBLISHED') {
      // Nothing was pushed and the head is not established. What is left, with
      // nothing attempted, is a work branch this build will not turn into a ref
      // and an authority the mint would not grant. No invocation clears either,
      // so neither is "ask again".
      //
      // A floor **only when `--create-pr --attended` was given too**, and a
      // review measured the difference: with the creation authorised, both
      // reach its own subject refusal one step later and this function answers
      // that with the same member. Without it, control falls to the authority
      // branch below and answers `ATTENDED_AUTHORITY_REQUIRED` — telling an
      // operator to pass a flag for a delivery whose work branch this build
      // will not send at all. So the arm is load-bearing on the shape a
      // counter-proof does not reach, which is why the mutant survives and the
      // arm stays.
      return settle('SUBJECT_NOT_ESTABLISHED', stage);
    }
  }

  if (!mayPerform(options, 'CREATE_PULL_REQUEST')) {
    // Which authority is named depends on what is still missing. A run that was
    // not allowed to publish either is told about the publication first,
    // because that is the act that has to happen first.
    return mayPerform(options, 'PUBLISH_HEAD')
      ? settle('ATTENDED_AUTHORITY_REQUIRED', stage, 'CREATE_PULL_REQUEST')
      : settle('ATTENDED_AUTHORITY_REQUIRED', stage, 'PUBLISH_HEAD');
  }

  creation = await performCreation(
    options,
    repository.root,
    subject,
    taskLoad,
    decided,
    resolve,
    load,
    seams,
  );
  if (creation.result.attempt !== 'NOT_ATTEMPTED') return settle('EFFECT_ATTEMPTED', stage);
  const created = creation.result.creation;
  if (created === 'HEAD_NOT_PUBLISHED') {
    // The branch is not on the remote at all, and publishing it is the act that
    // puts it there.
    return settle('ATTENDED_AUTHORITY_REQUIRED', stage, 'PUBLISH_HEAD');
  }
  if (created === 'HEAD_SHA_MISMATCH') {
    // The ref is there and holds another commit. **Publishing cannot fix
    // that** — the publication is create-only and answers the same world with
    // `REF_HOLDS_ANOTHER_COMMIT`, because moving a ref is a destructive act
    // this build does not perform and no flag makes it perform one. A review
    // measured the earlier version answering both with "pass --publish-head
    // --attended", which sends an operator to a flag that would refuse, and
    // gave one world two different members depending on which flags were named.
    return settle('HUMAN_DECISION_REQUIRED', stage);
  }
  if (
    created === 'PRIOR_PULL_REQUEST_CLOSED' ||
    created === 'WRONG_BASE_CONFLICT' ||
    created === 'DRAFT_STATE_CONFLICT' ||
    created === 'ALREADY_EXISTS'
  ) {
    return settle('HUMAN_DECISION_REQUIRED', stage);
  }
  // The creation ladder's own vocabulary decides the rest, member by member,
  // rather than falling through to one word. A review measured what a bare
  // fall-through cost here: `PULL_REQUEST_AMBIGUOUS` — *more* than one open
  // pull request at this head — was reported as "no open pull request has this
  // head", and a `SUBJECT_NOT_ESTABLISHED` that no re-run can clear was graded
  // "ask again". Both are conditions the driver already has an exact member for.
  if (created === 'PULL_REQUEST_AMBIGUOUS') return settle('PULL_REQUEST_AMBIGUOUS', stage);
  if (created === 'SUBJECT_CHANGED') return settle('SUBJECT_CHANGED', stage);
  if (created === 'REMOTE_STATE_UNKNOWN' || created === 'PULL_REQUEST_STATE_UNKNOWN') {
    return settle('FORGE_STATE_UNKNOWN', stage);
  }
  if (created === 'REMOTE_URLS_DIVERGE') {
    // Local, and nothing was asked of github.com — the same argument the
    // publication path makes about the same reading, `L-V4-11-13` included.
    return settle('HUMAN_DECISION_REQUIRED', stage);
  }
  if (created === 'SUBJECT_NOT_ESTABLISHED' || created === 'AUTHORITY_REFUSED') {
    // The intended pull request is not one the mint will describe: the work
    // branch and the base are the same ref, or one of them is not a name this
    // build will send. No invocation clears that, so it is not "ask again".
    return settle('SUBJECT_NOT_ESTABLISHED', stage);
  }
  // What is left is `CREATION_REFUSED` — the request was sent nowhere because
  // the ladder would not send it — and the three floors this path cannot reach,
  // `OPERATOR_ABSENT`, `TASK_NOT_READY` and `DECISION_NOT_ESTABLISHED`, all
  // decided above. In every one of them the sentence is true: no open pull
  // request has this head.
  return settle('PULL_REQUEST_REQUIRED', stage);
}
