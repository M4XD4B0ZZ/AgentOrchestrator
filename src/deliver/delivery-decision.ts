/**
 * The delivery decision — V4 slice 4.
 *
 * ── What this slice is, and what its name deliberately is not ──────────────
 *
 * Slices 1–3 report facts. This is the first module that *classifies* them into
 * one word a person can act on, so its naming is the whole risk. The name was
 * chosen by asking what the strongest truthful claim is and then narrowing
 * until nothing unproven remains.
 *
 * It is **not** merge eligibility, and no member of {@link DELIVERY_DECISIONS}
 * says it is. That is a measured limit, not modesty:
 *
 *  - `repos/{o}/{n}/branches/{b}/protection` answers **HTTP 404** both for "this
 *    branch is not protected" and for "you may not read its protection". Same
 *    status, same exit code, on this repository and on five foreign ones;
 *  - `repos/{o}/{n}/rulesets` answers **HTTP 200 with `[]`** both for "there are
 *    none" and for "you may not read them" — measured returning `[]` for two
 *    repositories that demonstrably have rulesets;
 *  - `repos/{o}/{n}/rules/branches/{b}` answers `[]` for repositories protected
 *    the classic way, whose pull requests are measurably `BLOCKED`;
 *  - GraphQL `baseRef.branchProtectionRule` answers `null` for both cases too.
 *
 * Every surface returns, for "no rules", a value it also returns for "you
 * cannot see the rules". So AO cannot prove that no rule is outstanding, and a
 * decision claiming "every required check passed" would be claiming a property
 * of a set it cannot enumerate. `reviewDecision` is the same shape: it is empty
 * on every pull request in this repository, and empty is a rendered `null`
 * meaning "no verdict returned", not "no review required".
 *
 * ── What this build does not even look at ──────────────────────────────────
 *
 * Draft status, mergeability, merge-state, review verdict and whether the
 * repository is archived are **not observed by this build at all**. Draft is
 * carried on an endpoint slice 2 already calls and is still not read, because
 * reading it would put a new field in the durable evidence record and change
 * that record's version — a slice-3 contract change that belongs to whoever
 * takes it deliberately. The consequence is stated rather than hidden: a
 * positive decision can be true of a **draft** pull request.
 *
 * ── Freshness is structural, not documented ────────────────────────────────
 *
 * The load-bearing rule is that a **stored observation may never produce a
 * positive decision**. That is enforced by neither a comment nor a timestamp
 * comparison — there is no TTL in this build, by decision — but by the
 * parameter type: {@link decideDelivery} takes a {@link DeliveryObservationProof},
 * slice 3's opaque artefact, which exists only if *this process* went through
 * the recognised observation boundary and both questions came back settled.
 *
 * A durable record cannot produce one. `readDeliveryEvidence` returns plain
 * fields; nothing here accepts them, and there is no overload, no `fromRecord`
 * and no shape a caller could write down instead — the lesson
 * `internal/delivery-observation-proof.ts` records at length about structural
 * types. The one way to a positive decision is to have just asked.
 *
 * ── The instant is carried and never judged ────────────────────────────────
 *
 * The proof carries `observedAt`. Nothing here reads it. An hour-old proof and
 * a millisecond-old proof produce the same decision, deliberately: age is not
 * the property that matters, *provenance* is. A threshold would invent a
 * freshness this build cannot deliver — GitHub can move a millisecond after any
 * answer — and would let a caller argue about the number instead of asking
 * again. Pinned by test, not by this paragraph.
 *
 * ── This module writes nothing and grants nothing ──────────────────────────
 *
 * It is pure: no clock, no filesystem, no process, no network. A positive
 * decision is not authority to merge, does not open a pull request, does not
 * write task state, and is not a claim that GitHub is still in that condition
 * when it is read. `READY_FOR_PR` remains terminal — see
 * `docs/decisions/2026-08-23-adr-delivery-decision.md` for the measured reason
 * this slice moves no task out of it.
 */

import { deliveryObservationFactsOf } from './delivery-observation-proof.js';
import type { DeliveryObservationProof } from './delivery-observation-proof.js';
import type { ObservationSubject } from './forge-observation.js';

/**
 * The sentence that is true of every decision, including the positive one.
 *
 * Deliberately not a member of the vocabulary, for the reason slice 3 gives
 * about remote freshness: a fact true of *every* value is not a value — a
 * caller could `switch` past it, and its presence would imply some other
 * decision for which the opposite holds. There is none. Exported so the report
 * cannot forget it and a test can pin it by literal.
 */
export const MERGE_ELIGIBILITY_SENTENCE =
  'Merge eligibility is not established by any of these decisions, and cannot be by this build. ' +
  'Draft status, mergeability, required reviews, branch protection and repository rulesets are ' +
  'not observed here — and the rule endpoints answer the same way for "there are none" as for ' +
  '"you may not read them", so their absence is not provable. A decision describes the moment it ' +
  'was taken: anything that later acts on it must observe again first.';

/**
 * Every way one delivery decision can come out. Closed, and total over the
 * inputs {@link concludeDeliveryDecision} accepts.
 *
 * ── The order below is the precedence, and it is the contract ──────────────
 *
 * The two observed questions are independent, so more than one member can be
 * true of a single observation and something has to choose. The order is by
 * *what has to happen next*, hardest stop first:
 *
 *  - a **failed check** stops delivery whatever the pull-request answer is. A
 *    pull request at a red commit does not make the commit green, and sending
 *    an operator to open one first would send them to the wrong place;
 *  - **ambiguity** is next, because AO cannot tell which pull request it would
 *    be talking about and every later answer would be about an unknown one;
 *  - **no pull request** outranks a pending or absent check, because opening
 *    one is the next action and it can be taken while checks are still running.
 *
 * Every member is reachable, and the suite pins each one by name.
 */
export const DELIVERY_DECISIONS = [
  /** No local subject could be established, so there was nothing to decide about. */
  'SUBJECT_NOT_ESTABLISHED',
  /** A subject exists and nothing was contacted. A decision needs a fresh observation. */
  'NOT_DECIDED',
  /**
   * The forge did not settle both questions, so at least one fact is missing.
   * Fail-closed: a half-answered observation decides nothing. This is also
   * where a proof that cannot be read, or one whose own halves disagree about
   * the commit, lands — an unreadable attestation is not an observation.
   */
  'OBSERVATION_UNSETTLED',
  /** The local subject could not be re-established after the observation. */
  'SUBJECT_REVALIDATION_FAILED',
  /**
   * The subject the answers are about is not the subject in front of us — the
   * task pinned a new commit, its state changed, the delivery target now
   * resolves elsewhere, or the proof was minted for a different subject
   * entirely. A green answer for commit A never satisfies a question about
   * commit B, and this is where that rule is enforced at the decision layer.
   */
  'SUBJECT_CHANGED',
  /** At least one check attached to exactly this commit did not succeed. */
  'CHECKS_FAILED',
  /** More than one open pull request claims this exact head. AO cannot tell which. */
  'PULL_REQUEST_AMBIGUOUS',
  /** No open pull request has this exact commit as its head. One has to be opened. */
  'PULL_REQUEST_REQUIRED',
  /** The pull request matched and at least one check on this commit is still running. */
  'CHECKS_PENDING',
  /**
   * The pull request matched and this commit carries no checks at all, through
   * either mechanism.
   *
   * Not a success. Zero checks is the absence of evidence, never evidence of
   * absence, and a build that graded it green would report an unverified commit
   * as verified.
   */
  'CHECKS_ABSENT',
  /**
   * The only positive decision. It claims exactly two things, both about the
   * instant of the observation: exactly one **open** pull request had this
   * exact commit as its head, and every check attached to this exact commit had
   * succeeded.
   *
   * It does not claim the pull request is mergeable, that it is not a draft,
   * that reviews are satisfied, that branch rules are met, that any check was
   * *required*, or that any of it is still true now. See
   * {@link MERGE_ELIGIBILITY_SENTENCE}.
   */
  'PULL_REQUEST_MATCHED_CHECKS_PASSED',
] as const;

export type DeliveryDecision = (typeof DELIVERY_DECISIONS)[number];

/** One static sentence per decision. Pinned by literal, never by reading the map. */
export const DELIVERY_DECISION_DETAIL: Readonly<Record<DeliveryDecision, string>> = Object.freeze({
  SUBJECT_NOT_ESTABLISHED:
    'There is no subject to decide about. Nothing was asked and nothing was decided.',
  NOT_DECIDED:
    'The subject is established and nothing was contacted. A decision needs a fresh observation; ' +
    'pass --observe as well.',
  OBSERVATION_UNSETTLED:
    'At least one question was not answered, so there is nothing to decide from.',
  SUBJECT_REVALIDATION_FAILED:
    'The local subject could not be read back after the observation, so the answers cannot be ' +
    'tied to it.',
  SUBJECT_CHANGED:
    'The answers describe a different subject from the one in front of us now. Ask again.',
  CHECKS_FAILED:
    'At least one check on this exact commit did not succeed. Delivery does not proceed from here.',
  PULL_REQUEST_AMBIGUOUS:
    'More than one open pull request claims this exact head, so there is no single one to decide ' +
    'about.',
  PULL_REQUEST_REQUIRED:
    'No open pull request has this exact commit as its head. Opening one is a human step; this ' +
    'build opens none.',
  CHECKS_PENDING:
    'The pull request matched and at least one check on this commit is still running.',
  CHECKS_ABSENT:
    'The pull request matched and this commit carries no checks at all. Absent checks are not ' +
    'passing checks.',
  PULL_REQUEST_MATCHED_CHECKS_PASSED:
    'At the moment of the observation, exactly one open pull request had this exact commit as its ' +
    'head and every check on this commit had succeeded. Nothing was merged and nothing was granted.',
});

/**
 * The one positive member, named once.
 *
 * Exported so "is this decision a positive one" has a single answer in the
 * codebase rather than a comparison spelled out wherever it is asked. The suite
 * partitions the vocabulary against this constant, so a second positive member
 * added and forgotten here turns a test red rather than quietly widening what
 * counts as success.
 */
export const POSITIVE_DELIVERY_DECISION = 'PULL_REQUEST_MATCHED_CHECKS_PASSED' as const;

/** `true` for the one decision that says both facts landed the good way. */
export function isPositiveDeliveryDecision(decision: DeliveryDecision): boolean {
  return decision === POSITIVE_DELIVERY_DECISION;
}

// ── Re-establishing the local subject after the observation ────────────────

/**
 * What a second look at the local world found.
 *
 * The forge cannot be frozen while AO thinks, and this does not pretend
 * otherwise — it protects the *local* half only. Between resolving a subject
 * and getting an answer about it the task may have advanced, been aborted, or
 * had its delivery target repointed, and a report presenting the answers
 * against the new subject would be attaching true facts to the wrong thing.
 */
export const SUBJECT_REVALIDATIONS = [
  /** Re-established and identical: same target identity, same commit, same task state. */
  'UNCHANGED',
  /** Re-established and different in at least one of those. */
  'CHANGED',
  /** Could not be re-established at all — the record or the target stopped resolving. */
  'UNAVAILABLE',
] as const;

export type SubjectRevalidation = (typeof SUBJECT_REVALIDATIONS)[number];

/**
 * One local subject, as this module compares them.
 *
 * The task state name is part of the identity on purpose. A task aborted while
 * the forge was being asked has the same commit and the same target, and a
 * decision reported against it would describe delivery for something nobody
 * intends to deliver.
 */
export interface LocalSubject {
  readonly subject: ObservationSubject;
  readonly taskState: string;
}

/**
 * Compares the subject the observation was made about with the subject as it
 * stands now.
 *
 * `null` for `after` means the second look established none — a different
 * answer from "it established a different one", because the first can be a
 * transient read failure and the second is a fact about the task.
 */
export function revalidateSubject(
  before: LocalSubject,
  after: LocalSubject | null,
): SubjectRevalidation {
  if (after === null) return 'UNAVAILABLE';
  return before.subject.host === after.subject.host &&
    before.subject.owner === after.subject.owner &&
    before.subject.name === after.subject.name &&
    before.subject.commit === after.subject.commit &&
    before.taskState === after.taskState
    ? 'UNCHANGED'
    : 'CHANGED';
}

// ── The decision itself ────────────────────────────────────────────────────

/**
 * The check outcomes this layer grades as success. Exactly one word.
 *
 * `aggregateCheckState` already fails closed one layer down — it grades
 * `success` as the only success and everything else as blocking. This set is
 * not a restatement of that: it is *this* layer refusing to inherit an outcome
 * word it has not decided about. The defect the brief names is
 * `else => success` reappearing higher up, and a closed positive set with an
 * explicit refusal after it is the shape that cannot grow one.
 */
const PASSING_CHECK_OUTCOMES: ReadonlySet<string> = new Set(['SUCCESS']);

/**
 * Decides from a proof that this process observed, and from a second look at
 * the local subject.
 *
 * The proof is the freshness requirement in parameter form; see the header. It
 * is verified rather than trusted: a value that is not a minted proof, or one
 * that passed the registry gate carrying no readable facts, yields
 * `OBSERVATION_UNSETTLED` and never a positive answer.
 *
 * `expected` is the subject this question is about, and the proof's own
 * recorded subject is compared against it. That comparison is what stops a
 * proof minted for commit A from answering a question about commit B — the
 * exact-SHA contract, enforced at the layer that decides rather than assumed
 * from the layer that observed.
 */
export function decideDelivery(
  proof: DeliveryObservationProof,
  expected: ObservationSubject,
  revalidation: SubjectRevalidation,
): DeliveryDecision {
  const facts = deliveryObservationFactsOf(proof);
  if (facts === null) return 'OBSERVATION_UNSETTLED';

  // A proof whose two halves name different commits is internally inconsistent
  // and is not graded at all. Asked first, because everything below reads
  // `facts.commit` as though both answers were about it.
  //
  // **This is a floor, not a live gate, and it is labelled as one because a
  // counter-proof said so.** Removing it kills no test: the mint writes
  // `checkQueriedCommit` from the subject, so no proof this build can produce
  // has ever differed. What the floor is for is the day something else can
  // produce facts — a record read back from disk, a proof from a build that
  // graded differently — and the premise it rests on is pinned by a test that
  // asserts the mint's derivation, so a change there makes this live rather
  // than making it wrong.
  if (facts.checkQueriedCommit !== facts.commit) return 'OBSERVATION_UNSETTLED';

  if (
    facts.host !== expected.host ||
    facts.owner !== expected.owner ||
    facts.name !== expected.name ||
    facts.commit !== expected.commit
  ) {
    return 'SUBJECT_CHANGED';
  }

  if (revalidation === 'UNAVAILABLE') return 'SUBJECT_REVALIDATION_FAILED';
  if (revalidation === 'CHANGED') return 'SUBJECT_CHANGED';

  // The exact-head requirement, restated where the decision is taken.
  //
  // The head comparison is the second floor, and the same counter-proof result
  // applies: the mint writes `pullRequestHeadSha` from the subject for a
  // `MATCHED` outcome, so replacing the comparison with `true` kills no test.
  // The two live conditions are the outcome word and the number — both of those
  // mutants die. The comparison stays for the reason the transport gives about
  // `isAddressableSubject`, a guarantee read at another moment is a guarantee
  // about another moment, and its premise is pinned by test rather than assumed.
  const matched =
    facts.pullRequestOutcome === 'MATCHED' &&
    facts.pullRequestNumber !== null &&
    facts.pullRequestHeadSha === facts.commit;

  // Checks first: see the precedence note on DELIVERY_DECISIONS.
  if (facts.checkOutcome === 'FAILED') return 'CHECKS_FAILED';
  if (facts.pullRequestOutcome === 'AMBIGUOUS') return 'PULL_REQUEST_AMBIGUOUS';
  if (!matched) return 'PULL_REQUEST_REQUIRED';
  if (facts.checkOutcome === 'PENDING') return 'CHECKS_PENDING';
  if (facts.checkOutcome === 'NO_CHECKS') return 'CHECKS_ABSENT';

  // Known success and nothing else. A check outcome this build has not decided
  // about — a value a future grading could produce, or one from a build that
  // graded differently — arrives here and is refused, never inherited as
  // success by falling off the end of the ladder.
  //
  // Also a floor today, and measured as one: the three arms above name every
  // settled check word except `SUCCESS`, so replacing this with an
  // unconditional success kills no test. What keeps it honest is not a mutant
  // but the partition assertion in the suite, which fails the moment the mint's
  // settled set grows a fifth member — turning a silent grading into a decision
  // somebody has to take.
  return PASSING_CHECK_OUTCOMES.has(facts.checkOutcome)
    ? 'PULL_REQUEST_MATCHED_CHECKS_PASSED'
    : 'OBSERVATION_UNSETTLED';
}

/** Everything one invocation knows when the decision is taken. */
export interface DecisionInputs {
  /** Whether a local subject was established at all. */
  readonly subjectEstablished: boolean;
  /** Whether this invocation contacted the forge. */
  readonly observed: boolean;
  /** The attestation of that contact, or `null` if it settled nothing. */
  readonly proof: DeliveryObservationProof | null;
  /** The subject the question is about, or `null` when none was established. */
  readonly expected: ObservationSubject | null;
  /**
   * The second look at the local world, or `null` if none was taken.
   *
   * Nullable rather than defaulted, and that is the point. The first version
   * had the caller substitute a verdict when it had not re-read anything, and a
   * counter-proof showed what that shape costs: changing the substituted value
   * from `UNAVAILABLE` to `UNCHANGED` broke nothing, because no test could
   * reach a fabricated value through the public contract. There is nothing to
   * fabricate now — a proof with no second look is refused here, by name.
   */
  readonly revalidation: SubjectRevalidation | null;
}

/**
 * The whole invocation's decision, including the cases where there is nothing
 * to decide from.
 *
 * Total, and the counterpart of slice 2's `concludeObservation`: the refusals
 * that happen before a proof could exist are decided here, and everything from
 * a real proof onwards is {@link decideDelivery}'s. Folding the two together
 * would mean one signature that accepts `null` for the freshness token, which
 * is precisely the door this slice is built to keep shut.
 */
export function concludeDeliveryDecision(inputs: DecisionInputs): DeliveryDecision {
  if (!inputs.subjectEstablished || inputs.expected === null) return 'SUBJECT_NOT_ESTABLISHED';
  if (!inputs.observed) return 'NOT_DECIDED';
  if (inputs.proof === null) return 'OBSERVATION_UNSETTLED';
  // A proof and no second look. Refused rather than defaulted: "nobody
  // re-read the subject" is the same thing to a reader as "the subject could
  // not be re-read", and neither may reach a positive answer.
  if (inputs.revalidation === null) return 'SUBJECT_REVALIDATION_FAILED';
  return decideDelivery(inputs.proof, inputs.expected, inputs.revalidation);
}

// ── What the stored record is for, and what it is not ──────────────────────

/**
 * Slice 3's record has exactly one role here, and it is not an input.
 *
 * The decision never reads it. Not "does not currently read it" — there is no
 * parameter for it, no import of the store in this module, and the suite pins
 * both. A stored `SUCCESS` and a stored pull-request match cannot move any
 * decision one step, which is the whole freshness rule stated as a property of
 * the code rather than as a promise.
 *
 * The record is not dead weight for it. Two things of slice 3's are load-bearing
 * here:
 *
 *  - its **mint** is this module's freshness token. `DeliveryObservationProof`
 *    was built so a forge-observation claim cannot be manufactured without going
 *    through the observation boundary, and that is exactly the property a
 *    decision needs. Slice 3 needed it to keep a *record* honest; slice 4 needs
 *    it to keep a *decision* honest, and it is the same artefact;
 *  - its **record** stays what slice 3 made it — audit history, reported beside
 *    the fresh answer and already compared against it by
 *    `cli/render-delivery-observation.ts`. That comparison is not repeated here.
 *    A second implementation of "does the stored record agree" would be a second
 *    opinion about one question, and the disagreement it is there to surface is
 *    a thing for a person to read, never a thing for this module to weigh.
 */
