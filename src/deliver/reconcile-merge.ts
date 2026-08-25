/**
 * Establishing that a task's delivery was merged, from the forge, right now.
 *
 * ── What this answers, and what it is not allowed to answer ────────────────
 *
 * One question: *is there exactly one pull request whose head is this task's
 * delivery commit, and did the forge just say it is merged, into the branch this
 * task targets, producing which commit?*
 *
 * It performs **no mutation of any kind**. Two GET requests through slice 2's
 * transport, and nothing else — no push, no pull-request creation, no merge, no
 * comment, no label, no review, no agent. It cannot: the only two functions it
 * calls that reach a network are `readPullCandidatesAtHead` and
 * `readPullRequestByNumber`, both of which build their argument vector from
 * `FORGE_REQUEST_PREFIX`, whose `-X GET` pair `tests/v4-02-…` pins by exact
 * equality.
 *
 * ── Why it does not take a MergeGrant, and must not ────────────────────────
 *
 * A `MergeGrant` authorises **one external merge attempt** and is spent by
 * being claimed. Requiring one here would be wrong three times over:
 *
 *  - reconciliation performs no external mutation, so there is nothing for an
 *    authority over external mutations to authorise;
 *  - a grant is one-shot, and the merge it authorised is exactly the one that
 *    already happened — the grant is gone by the time there is anything to
 *    reconcile;
 *  - most importantly, it would make recovery impossible. AO may crash after
 *    GitHub merges. A human may merge the pull request in the web UI. Another
 *    authorised invocation may merge it. In every one of those cases there is no
 *    grant and there never was one, and those are precisely the cases a
 *    reconciliation exists for. A design that could only reconcile merges it had
 *    itself performed would reconcile exactly the merges that need it least.
 *
 * So the authority for this is the operator's explicit action — `--reconcile-
 * merge`, an argument nothing defaults — and the local write is gated on a
 * minted observation rather than on a grant. `--attended` is deliberately not
 * required: it is this build's marker that a human is present for an
 * irreversible *external* effect, and reconciling a fact that already exists on
 * the forge is not one. See the ADR.
 *
 * ── Why AO cannot claim to have performed the merge ───────────────────────
 *
 * Nothing here establishes an actor, and nothing here pretends to. A merge by a
 * human, by another invocation and by this build's own slice-7 effect produce
 * the identical reading — `merged: true` with a head, a base and a resulting
 * commit. Slice 7 can claim attribution because it saw the pull request `OPEN`
 * immediately before its own request and `MERGED` immediately after; this
 * module sees only the second half of that, which is a statement about the pull
 * request and not about who acted on it.
 *
 * ── The pull request is found from the commit, never from a stored number ──
 *
 * The number comes from asking the forge which pull requests carry this task's
 * delivery commit as their head — slice 2's locator endpoint,
 * `commits/{sha}/pulls`, keyed on an object name. It is deliberately **not**
 * taken from slice 3's stored record, and there is no flag that carries one:
 *
 *  - a stored number is historical, and a historical number with no current
 *    proof is exactly what this must not act on;
 *  - a stored record may not exist at all — the manual-merge and crash-recovery
 *    cases above — so a design that needed one could not recover;
 *  - an operator-supplied number would let a reconciliation be pointed at any
 *    pull request in the repository, and the identity binding would then be
 *    something a human typed rather than something the forge answered.
 *
 * Deriving it from the commit means the head↔pull-request binding is established
 * by the same request that names the number, and cannot disagree with itself.
 *
 * Measured, read-only, on this repository: the locator still resolves a merged
 * pull request from its head object name **after the head branch is deleted**
 * (pull requests 49 and 50, whose head branches are absent from `origin`), and
 * after a squash merge has left that head object on no branch at all. GitHub's
 * schema states the same property — `headRefOid` is documented as identifying
 * the head "even if the ref has been deleted". Branch names are never used as
 * identity here for that reason and for the ordinary one: a branch is a mutable
 * pointer.
 */

import {
  createObservationSubject,
  type ObservationSubject,
} from './forge-observation.js';
import {
  readPullCandidatesAtHead,
  readPullRequestByNumber,
  type ForgeCommandRunner,
} from './github-observer.js';
import { classifyPullRequestSituation } from './pull-request-situation.js';
import type { MergeReading } from './pull-request-merge.js';
import {
  mintMergeObservation,
} from './internal/merge-observation-proof.js';
import type { MergeObservationProof } from './merge-observation-proof.js';

/**
 * Everything one reconciliation is about, from the task and the repository's
 * own delivery target. Never from a stored record and never from an argument.
 */
export interface ReconciliationSubject {
  /** The task whose delivery this is. */
  readonly taskId: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /**
   * The task's implementation result — `TaskState.currentCommit`.
   *
   * The commit the pull request must have carried as its head. This is the only
   * input that decides *which* pull request is asked about, and the only thing
   * that makes an answer this task's delivery rather than somebody else's.
   */
  readonly deliveryCommit: string;
  /**
   * The branch the task targets — `TaskState.baseBranch`.
   *
   * Compared by exact equality against the base the forge reports. A real merge
   * of this exact commit into a branch this task never aimed at is a real merge
   * and is not this delivery.
   */
  readonly baseRef: string;
}

export interface ReconciliationSeams {
  /** The forge **reading** seam. Slice 2's, unchanged. There is no other. */
  readonly reader: ForgeCommandRunner;
  readonly envSource: NodeJS.ProcessEnv;
  /** The clock, for the instant the forge was asked. */
  readonly now: () => Date;
}

/**
 * The closed vocabulary. Ordered as the ladder decides, weakest claim first.
 *
 * Every member is a statement about what could or could not be established, and
 * each says why it is not the member beside it.
 */
export const MERGE_OBSERVATIONS = [
  /**
   * No subject was established, so there is nothing this could be about.
   *
   * The delivery target did not resolve, the task state could not be read, the
   * task has no current commit, or the base branch is not a name this build will
   * compare. Produced by the caller's own refusal path, not by
   * {@link observeMergeForDelivery} — the same arrangement slice 7 uses, where
   * the ladder's earliest members belong to the command that assembles the
   * subject.
   */
  'SUBJECT_NOT_ESTABLISHED',
  /**
   * The task is not finished, so its head is not a delivery head.
   *
   * `READY_FOR_PR` is the state at which the work is settled and provable, and
   * it is what makes `currentCommit` mean "what this task delivered". A merge
   * reconciled against a task still being worked on would bind a permanent
   * receipt to a commit that is not the task's result.
   *
   * Also produced by the caller, for the same reason as the member above.
   */
  'TASK_NOT_READY',
  /**
   * The forge could not be read, or its answer could not be classified.
   *
   * Slice 2's refusal vocabulary is rich — not authenticated, request failed,
   * response malformed, results truncated — and every member of it means the
   * same thing here: this build did not establish what the pull request is. A
   * ladder that branched on *why* it could not see would be deciding whether to
   * act on the shape of an error.
   */
  'FORGE_UNREADABLE',
  /**
   * The forge reports no pull request whose head is this commit.
   *
   * Absence of a pull request, never a claim that the work was not delivered.
   * A delivery landed by some route that never opened one is a real thing, and
   * it is not something this build has any way to see.
   */
  'NO_PULL_REQUEST_AT_HEAD',
  /**
   * A pull request at this head is still open.
   *
   * Not merged, so there is no merge event to record. Separate from
   * {@link NOT_MERGED} below because it is decided from the candidate set
   * without addressing a single pull request, and because an open pull request
   * at the delivery head is the ordinary *pre*-merge state rather than a
   * refusal an operator needs to investigate.
   */
  'PULL_REQUEST_STILL_OPEN',
  /**
   * More than one pull request carries this commit as its head.
   *
   * Refused rather than resolved. Picking the lowest number, the most recent, or
   * the one that happens to be merged would each be this build choosing which
   * delivery a task had, from data that says a human made two.
   */
  'PULL_REQUEST_AMBIGUOUS',
  /**
   * The one pull request at this head is not merged.
   *
   * Reached only after addressing it by number, so it distinguishes a pull
   * request that was closed without being merged from one that is open — a
   * distinction the candidate list cannot make, because it carries no `merged`
   * field.
   */
  'NOT_MERGED',
  /**
   * The pull request is merged, and the head the forge reports is not this
   * task's delivery commit.
   *
   * A real merge of somebody else's work. The locator was asked about this exact
   * commit, so reaching this member means the two endpoints disagree about the
   * same pull request's head — which is not something to average out.
   */
  'MERGE_NOT_THIS_DELIVERY',
  /**
   * The pull request is merged, at this head, into a branch this task does not
   * target.
   *
   * The one member that is a genuine near-miss: the work went in, somewhere this
   * task never asked for. A receipt built from it would say this task's delivery
   * reached `main` when it reached a release branch.
   */
  'BASE_NOT_INTENDED',
  /**
   * The forge said this pull request is merged, at this head, into this base,
   * producing this commit — and a proof of that reading was minted.
   *
   * The only member that carries a proof, and the only one from which a receipt
   * can be written. What it establishes and what it does not is the whole
   * subject of `internal/merge-observation-proof.ts`'s header; the short form is
   * that it is an event, it is not attribution, it is not presence on the base
   * branch, and it is not verification.
   */
  'MERGE_OBSERVED',
] as const;

export type MergeObservationOutcome = (typeof MERGE_OBSERVATIONS)[number];

/** One static sentence per outcome, for the operator report. */
export const MERGE_OBSERVATION_DETAIL: Readonly<Record<MergeObservationOutcome, string>> =
  Object.freeze({
    SUBJECT_NOT_ESTABLISHED:
      'No delivery subject could be established, so no pull request was asked about.',
    TASK_NOT_READY:
      'The task is not at READY_FOR_PR, so its current commit is not a delivery head.',
    FORGE_UNREADABLE:
      'The forge could not be read, or its answer could not be classified. Nothing was established.',
    NO_PULL_REQUEST_AT_HEAD:
      'The forge reports no pull request whose head is this task’s delivery commit.',
    PULL_REQUEST_STILL_OPEN:
      'A pull request at this head is still open, so no merge has happened to reconcile.',
    PULL_REQUEST_AMBIGUOUS:
      'More than one pull request carries this commit as its head. Which one is the delivery is not this build’s to choose.',
    NOT_MERGED: 'The pull request at this head was closed without being merged.',
    MERGE_NOT_THIS_DELIVERY:
      'The merged pull request’s head is not this task’s delivery commit, so this merge is not this delivery.',
    BASE_NOT_INTENDED:
      'The merge went into a branch this task does not target. The work is merged somewhere this delivery did not ask for.',
    MERGE_OBSERVED:
      'The forge reports this pull request merged, at this head, into this base, producing the commit below.',
  });

/** Everything the caller learned, including the reading the outcome came from. */
export interface MergeObservationResult {
  readonly outcome: MergeObservationOutcome;
  /**
   * The pull request that was addressed by number, or `null` when none was.
   *
   * Non-null from {@link MERGE_OBSERVATIONS} member `NOT_MERGED` onwards: the
   * earlier members are decided from the candidate set, before any single pull
   * request has been named.
   */
  readonly pullRequestNumber: number | null;
  /** The reading that came back, or `null` when no pull request was addressed. */
  readonly reading: MergeReading | null;
  /**
   * Whether at least one request was sent through the reading seam.
   *
   * Carried explicitly rather than inferred from the fields above, because
   * inferring it is wrong in both directions. A locator read that refused
   * leaves `reading` and `pullRequestNumber` `null` while a process really did
   * run — so a report deriving egress from those would say nothing was
   * contacted when something was. And a subject this build will not address
   * refuses *before* any process exists, which looks identical.
   *
   * The operator report's egress disclosure is derived from this and from
   * nothing else.
   */
  readonly contacted: boolean;
  /**
   * The minted proof, on `MERGE_OBSERVED` and on nothing else.
   *
   * The store refuses anything that is not one of these, so this field is the
   * only route from a reading to a durable receipt.
   */
  readonly proof: MergeObservationProof | null;
}

function outcome(
  code: MergeObservationOutcome,
  contacted: boolean,
  pullRequestNumber: number | null = null,
  reading: MergeReading | null = null,
  proof: MergeObservationProof | null = null,
): MergeObservationResult {
  return Object.freeze({ outcome: code, pullRequestNumber, reading, proof, contacted });
}

/**
 * The refusal shape for the two members the caller owns.
 *
 * Exported so the command does not build a result object of its own: two places
 * that construct the same type is two places that can disagree about which
 * fields a refusal carries.
 */
export function refuseMergeObservation(
  code: Extract<MergeObservationOutcome, 'SUBJECT_NOT_ESTABLISHED' | 'TASK_NOT_READY'>,
): MergeObservationResult {
  return outcome(code, false);
}

/**
 * Asks the forge whether this task's delivery was merged, and proves the answer.
 *
 * Two reads, in this order, and the order is the contract:
 *
 *  1. **the locator**, keyed on the delivery commit, answering which pull
 *     requests carry it as their head. Its answer is a candidate set, never a
 *     verdict — the classification is `pull-request-situation.ts`'s, unchanged
 *     from slice 6, because "which pull requests are at this exact commit" is
 *     one question with one right answer and a second implementation of it could
 *     only drift;
 *  2. **the single-document endpoint**, addressed by the number the first read
 *     produced, answering what that pull request *is*.
 *
 * The second read is not redundant. The candidate list carries no `merged`
 * field — a merged pull request and one a human closed both read
 * `state: "closed"` there — so mergedness, the base, and the resulting commit
 * can only come from the document endpoint. Slice 2 records the same finding
 * from the other direction, and slice 7 already depends on it.
 */
export async function observeMergeForDelivery(
  subject: ReconciliationSubject,
  seams: ReconciliationSeams,
): Promise<MergeObservationResult> {
  const target = createObservationSubject(
    { host: subject.host, owner: subject.owner, name: subject.name },
    subject.deliveryCommit,
  );
  // Refused before any process exists: this build will not address the subject.
  if (!target.ok) return outcome('FORGE_UNREADABLE', false);
  const observed: ObservationSubject = target.subject;

  const candidates = await readPullCandidatesAtHead(observed, {
    runner: seams.reader,
    envSource: seams.envSource,
  });
  if (!candidates.ok) return outcome('FORGE_UNREADABLE', true);

  const situation = classifyPullRequestSituation(candidates.candidates, subject.deliveryCommit);
  switch (situation.outcome) {
    case 'UNKNOWN':
      // The classifier could not settle what it was looking at — an open
      // candidate whose base or draft the forge did not report. Graded with the
      // read failures because it means the same thing: nothing established.
      return outcome('FORGE_UNREADABLE', true);
    case 'NONE':
      return outcome('NO_PULL_REQUEST_AT_HEAD', true);
    case 'OPEN_ONE':
    case 'OPEN_MANY':
      // An open pull request still carries this head. Whatever else is at this
      // commit, the settled fact about this delivery is not a merge — and a
      // build that looked past an open pull request to find a merged one would
      // be choosing the answer it wanted.
      return outcome('PULL_REQUEST_STILL_OPEN', true);
    case 'CLOSED_ONLY':
      break;
  }

  // `CLOSED_ONLY` carries every candidate at this head, and all of them are
  // closed. More than one means two pull requests were opened from this exact
  // commit and both were closed; which of them is the delivery is a question
  // about what a human did, not one this build may answer by picking.
  const numbers = situation.numbers;
  if (numbers.length !== 1) return outcome('PULL_REQUEST_AMBIGUOUS', true);
  const number = numbers[0];
  if (number === undefined) return outcome('PULL_REQUEST_AMBIGUOUS', true);

  const read = await readPullRequestByNumber(observed, number, {
    runner: seams.reader,
    envSource: seams.envSource,
  });
  if (!read.ok) return outcome('FORGE_UNREADABLE', true, number);
  const reading = read.reading;

  if (reading.outcome === 'UNKNOWN') return outcome('FORGE_UNREADABLE', true, number, reading);
  if (reading.outcome !== 'MERGED') return outcome('NOT_MERGED', true, number, reading);

  // The two bindings, in the order an operator needs them. The head decides
  // whether this merge is this task's at all; the base decides whether it went
  // where the task aimed. Both are compared against values that came from the
  // task and the repository profile, never from the answer being judged.
  if (reading.headSha !== subject.deliveryCommit) {
    return outcome('MERGE_NOT_THIS_DELIVERY', true, number, reading);
  }
  if (reading.baseRef !== subject.baseRef) {
    return outcome('BASE_NOT_INTENDED', true, number, reading);
  }

  const proof = mintMergeObservation({
    host: observed.host,
    owner: observed.owner,
    name: observed.name,
    pullRequestNumber: number,
    reading,
    observedAt: seams.now().toISOString(),
  });
  // The mint re-derives every one of the checks above and refuses a reading it
  // cannot vouch for — a merged reading with no resulting commit is the case
  // that reaches here, because nothing above asks for one. A refusal is graded
  // `FORGE_UNREADABLE` and not as a merge: the forge said "merged" and could not
  // name what it produced, which is an answer this build cannot record.
  if (proof === null) return outcome('FORGE_UNREADABLE', true, number, reading);

  return outcome('MERGE_OBSERVED', true, number, reading, proof);
}
