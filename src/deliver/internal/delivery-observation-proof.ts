/**
 * The delivery observation proof — the mint, and the only place one can be made.
 *
 * ── What this artefact says, and what it emphatically does not ─────────────
 *
 * It says: *this process asked github.com about exactly this subject, through
 * the recognised observation boundary, and both questions came back settled.*
 * That is a statement about **one moment**, and the record built from it is a
 * historical snapshot rather than a claim about now.
 *
 * It is therefore **not**:
 *
 *  - a claim that the pull request still has this head. GitHub may move it a
 *    millisecond later and nothing here will know;
 *  - a claim that the checks are still green, still failing, or still absent;
 *  - authority to merge, to open a pull request, or to write task state;
 *  - freshness of any kind. A proof minted an hour ago and a proof minted now
 *    are indistinguishable to every consumer, deliberately: the only honest use
 *    of either is "AO observed this at `observedAt`".
 *
 * ── Why it is opaque, and why that is not decoration ───────────────────────
 *
 * The requirement the durable record carries is that evidence may only come
 * from an observation that actually happened. A structural type cannot carry
 * that: `{ pullRequest: 'MATCHED', checks: 'SUCCESS', … }` is a shape any
 * caller can write down, and a richer shape is only a longer thing to write
 * down — the lesson `core/internal/execution-lease-evidence.ts` records at
 * length, reached there by an adversarial review that forged working lease
 * evidence twice.
 *
 * So the gate is membership of a registry only {@link mintDeliveryObservation}
 * writes to. It is deliberately **not**:
 *
 *  - `instanceof`, because `Object.create` hands anybody the prototype;
 *  - a private-field probe (`#facts in value`), because the class is reachable
 *    from any genuine artefact as `Object.getPrototypeOf(value).constructor`
 *    with no import at all, and calling it installs a real private field.
 *
 * Both routes were used against this codebase's other opaque artefacts, in that
 * order. This one is built at the end state rather than walking the path again.
 *
 * ── What the boundary is, stated exactly ──────────────────────────────────
 *
 * The guarantee is: **ordinary product code cannot manufacture a successful
 * forge-observation claim without going through the recognised observation
 * boundary.** It is not a guarantee against a caller that imports this module —
 * anyone who can import the mint can call it — and it is not a guarantee
 * against anyone who can write a file into the repository's runtime directory.
 * The durable record's own header states that second limit again, because it is
 * the one a reader is most likely to over-read.
 *
 * ── The mint re-derives; it does not take the caller's word ────────────────
 *
 * Every input is re-checked below even though the single production caller has
 * already checked it. In particular the *settledness* of both answers is
 * re-derived here rather than accepted as a flag: the one function that can
 * produce the artefact is the wrong place to trust a caller's summary of
 * whether the forge actually answered.
 */

import type {
  CheckStateObservation,
  PullRequestObservation,
} from '../forge-observation.js';

/**
 * The registry. A `WeakSet` a value cannot be reached from — an instance can
 * hand out its prototype and its constructor, and neither of those is this.
 */
const MINTED = new WeakSet<object>();

/**
 * Captured and bound at module load, so that a later
 * `WeakSet.prototype.has = () => true` cannot turn the gate off process-wide.
 * The same defence the lease proof and the interruption checkpoint carry.
 */
const registryHas: (value: object) => boolean = WeakSet.prototype.has.bind(MINTED);

function isMinted(value: object): boolean {
  return registryHas(value);
}

const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The pull-request outcomes a proof may carry.
 *
 * Exactly the three that mean *the forge answered the question*. Every shared
 * refusal is absent, and that absence is the contract: there is no proof shape
 * in which "the client was not authenticated" can be recorded as an
 * observation, because nothing was observed.
 */
const SETTLED_PULL_REQUEST: ReadonlySet<string> = new Set([
  'MATCHED',
  'NO_MATCHING_PULL_REQUEST',
  'AMBIGUOUS',
]);

/** The check outcomes a proof may carry. Same rule, same reason. */
const SETTLED_CHECKS: ReadonlySet<string> = new Set([
  'SUCCESS',
  'PENDING',
  'FAILED',
  'NO_CHECKS',
]);

/**
 * What one settled observation looked like, in plain values.
 *
 * These are the facts a durable record is built from. They are readable — the
 * artefact hides its *constructibility*, not its content, because a reader
 * learning which pull request was matched gains nothing while a writer minting
 * an observation that never happened gains everything.
 *
 * Note what is **not** here: no raw response, no `gh` output, no exit code, no
 * stderr, no URL, no header. The record downstream can only hold what this
 * carries, so the hygiene rule is enforced by the shape rather than by a
 * filtering step somebody has to remember to run.
 */
export interface DeliveryObservationFacts {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** The exact subject. Forty lowercase hex digits. */
  readonly commit: string;
  readonly pullRequestOutcome: string;
  /** The matched pull request, and `null` for every other outcome. */
  readonly pullRequestNumber: number | null;
  /**
   * The head object name of the matched pull request.
   *
   * Equal to {@link commit} by construction — the match *is* the equality — and
   * carried anyway, because a durable record that states both is a record whose
   * own consistency can be checked without knowing how it was produced. A
   * reader that finds them different has found a corrupted or forged record,
   * which is exactly the check the reading vocabulary needs to be able to make.
   */
  readonly pullRequestHeadSha: string | null;
  readonly checkOutcome: string;
  /** The commit the check answer was about. Equal to {@link commit}. */
  readonly checkQueriedCommit: string;
  readonly checkRuns: number;
  readonly commitStatuses: number;
  readonly checksFailed: number;
  readonly checksPending: number;
  readonly checksSucceeded: number;
  readonly checksNeutralOrSkipped: number;
  /**
   * When the observation was made, ISO-8601.
   *
   * Named for what it is. It is evidence of **when** the forge was asked, and
   * it is not evidence that the answer is still true — no interval makes it so,
   * which is why no consumer in this build compares it against a threshold.
   */
  readonly observedAt: string;
}

/**
 * What the observation boundary reports, before anything is minted.
 *
 * Separate from {@link DeliveryObservationFacts} because it carries the whole
 * discriminated observation rather than the flattened facts, and because the
 * settledness of each half is a *precondition* here rather than a recorded
 * fact: an unsettled observation mints nothing at all, so the artefact has no
 * way to express one.
 */
export interface ObservedDelivery {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly commit: string;
  readonly pullRequest: PullRequestObservation;
  readonly checks: CheckStateObservation;
  readonly observedAt: string;
}

export class DeliveryObservationEvidence {
  readonly #facts: DeliveryObservationFacts;

  constructor(facts: DeliveryObservationFacts) {
    this.#facts = facts;
  }

  /** Whether the mint built this value. See the header for what this is not. */
  static holds(value: unknown): value is DeliveryObservationEvidence {
    return typeof value === 'object' && value !== null && isMinted(value as object);
  }

  /**
   * The facts this proof carries.
   *
   * A static reading a private field rather than a getter, for the reason the
   * lease proof gives: an own property shadows a prototype getter, so a getter
   * would be a member a forgery can define and the private field would never be
   * read.
   */
  static factsOf(proof: DeliveryObservationEvidence): DeliveryObservationFacts {
    return proof.#facts;
  }
}

function isAddressablePart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function counted(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Mints a proof for an observation that was settled, or `null`.
 *
 * `null` for every input this cannot vouch for, and the list is not defensive
 * padding — each entry is a way the calling module could come to hold a value
 * it did not establish:
 *
 *  - either half unsettled: the forge did not answer that question, so there is
 *    no observation of it to attest to. This is the one that matters, and it is
 *    re-derived from the outcome word rather than taken as a flag;
 *  - a `MATCHED` outcome carrying no pull-request number, or a non-matched one
 *    carrying one: the payload and the outcome disagree, and a record built
 *    from them would be internally false;
 *  - a graded check outcome carrying no counts: the aggregate cannot be
 *    explained, and an unexplainable aggregate is exactly what this slice is
 *    built not to persist;
 *  - a subject that is not a subject this build addresses, or an instant that
 *    is not one: a record built from them would be unreadable by the schema
 *    that has to accept it back.
 */
export function mintDeliveryObservation(
  observed: ObservedDelivery,
): DeliveryObservationEvidence | null {
  if (!isAddressablePart(observed.host)) return null;
  if (!isAddressablePart(observed.owner)) return null;
  if (!isAddressablePart(observed.name)) return null;
  if (typeof observed.commit !== 'string' || !COMMIT_OBJECT_NAME.test(observed.commit)) {
    return null;
  }
  if (typeof observed.observedAt !== 'string' || !ISO_8601.test(observed.observedAt)) return null;

  const pullRequest = observed.pullRequest;
  const checks = observed.checks;
  if (typeof pullRequest !== 'object' || pullRequest === null) return null;
  if (typeof checks !== 'object' || checks === null) return null;

  // The settledness gate, re-derived. A refusal has no `counts` and no number to
  // read, and there is deliberately no arm here that turns one into a proof
  // carrying nulls: "the client was not authenticated" is not a weaker
  // observation, it is not an observation.
  if (!SETTLED_PULL_REQUEST.has(pullRequest.outcome)) return null;
  if (!SETTLED_CHECKS.has(checks.outcome)) return null;

  let pullRequestNumber: number | null = null;
  if (pullRequest.outcome === 'MATCHED') {
    const number = pullRequest.pullRequest;
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    pullRequestNumber = number;
  }

  // `NO_CHECKS` carries no counts by construction — the graded members are the
  // only ones that do — so it is the one settled check outcome whose counts are
  // legitimately absent, and it is recorded with zeros rather than with nulls
  // so the record has one shape.
  let checkRuns = 0;
  let commitStatuses = 0;
  let checksFailed = 0;
  let checksPending = 0;
  let checksSucceeded = 0;
  let checksNeutralOrSkipped = 0;
  if (checks.outcome !== 'NO_CHECKS') {
    const counts = (checks as { readonly counts?: unknown }).counts;
    if (typeof counts !== 'object' || counts === null) return null;
    const c = counts as Record<string, unknown>;
    if (
      !counted(c['checkRuns']) ||
      !counted(c['commitStatuses']) ||
      !counted(c['failed']) ||
      !counted(c['pending']) ||
      !counted(c['succeeded']) ||
      !counted(c['neutralOrSkipped'])
    ) {
      return null;
    }
    checkRuns = c['checkRuns'];
    commitStatuses = c['commitStatuses'];
    checksFailed = c['failed'];
    checksPending = c['pending'];
    checksSucceeded = c['succeeded'];
    checksNeutralOrSkipped = c['neutralOrSkipped'];
  }

  const proof = new DeliveryObservationEvidence(
    Object.freeze({
      host: observed.host,
      owner: observed.owner,
      name: observed.name,
      commit: observed.commit,
      pullRequestOutcome: pullRequest.outcome,
      pullRequestNumber,
      // The subject commit, because the match is the equality. Written from the
      // subject rather than copied from the response so that the two fields in
      // the record cannot disagree for any reason other than tampering.
      pullRequestHeadSha: pullRequestNumber === null ? null : observed.commit,
      checkOutcome: checks.outcome,
      checkQueriedCommit: observed.commit,
      checkRuns,
      commitStatuses,
      checksFailed,
      checksPending,
      checksSucceeded,
      checksNeutralOrSkipped,
      observedAt: observed.observedAt,
    }),
  );
  // The only line in the codebase that admits anything to the registry.
  MINTED.add(proof);
  return proof;
}

// Closed for the same two reasons the lease and containment proofs are closed:
// the constructor is reachable from any instance through its prototype, and a
// writable static is a process-wide off switch for the gate. Neither is what
// makes the type safe — the registry is — and both are cheap.
Reflect.deleteProperty(DeliveryObservationEvidence.prototype, 'constructor');
Object.freeze(DeliveryObservationEvidence.prototype);
Object.freeze(DeliveryObservationEvidence);
