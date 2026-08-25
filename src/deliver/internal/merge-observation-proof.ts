/**
 * The merge observation proof — the mint, and the only place one can be made.
 *
 * ── What this artefact says, and what it emphatically does not ─────────────
 *
 * It says: *this process asked github.com about exactly this pull request,
 * through the recognised reading boundary, and the forge answered that it is
 * merged, at this head, into this base, with this resulting commit.*
 *
 * That is a statement about **one pull request's merge event**. It is therefore
 * **not**:
 *
 *  - a claim that AO performed the merge. Nothing in a reading establishes who
 *    did, and the one response that would seem to — a `200` from a second merge
 *    request — is a replay `deliver/pull-request-merge.ts` measured and refuses
 *    to send. A merge performed by a human, by another invocation, or by this
 *    build's own slice-7 effect produces the *same* reading;
 *  - a claim that the resulting commit is currently the tip of the base branch,
 *    or currently reachable from it. The base moves; a later revert, a force
 *    push or a branch reset changes what is on it and changes nothing here;
 *  - a claim that the merge commit has passed any verification. Nothing was run
 *    against it;
 *  - a claim that the task is complete. The task's own lifecycle is not this
 *    artefact's subject and is not touched by it;
 *  - freshness of any kind. A proof minted an hour ago and a proof minted now
 *    are indistinguishable to every consumer, deliberately: the only honest use
 *    of either is "AO observed this at `observedAt`".
 *
 * ── Why it is opaque, and why that is not decoration ───────────────────────
 *
 * The durable receipt downstream carries the strongest sentence this build
 * writes to disk about a forge mutation — *pull request N was merged and
 * produced commit M* — and the requirement is that such a sentence may only
 * come from an observation that actually happened. A structural type cannot
 * carry that: `{ outcome: 'MERGED', mergeCommit: '…' }` is a shape any caller
 * can write down, and a richer shape is only a longer thing to write down —
 * the lesson `core/internal/execution-lease-evidence.ts` records at length,
 * reached there by an adversarial review that forged working lease evidence
 * twice.
 *
 * So the gate is membership of a registry only {@link mintMergeObservation}
 * writes to. It is deliberately **not**:
 *
 *  - `instanceof`, because `Object.create` hands anybody the prototype;
 *  - a private-field probe (`#facts in value`), because the class is reachable
 *    from any genuine artefact as `Object.getPrototypeOf(value).constructor`
 *    with no import at all, and calling it installs a real private field.
 *
 * Both routes were used against this codebase's other opaque artefacts, in that
 * order. This one is built at the end state rather than walking the path again,
 * and it is closed the same way at the foot of this file.
 *
 * ── What the boundary is, stated exactly ──────────────────────────────────
 *
 * The guarantee is: **ordinary product code cannot manufacture a merged-pull-
 * request claim without going through the recognised reading boundary.** It is
 * an in-process product-code provenance boundary and nothing more. It is not a
 * guarantee against a caller that imports this module — anyone who can import
 * the mint can call it — and it is **not** filesystem authenticity: there is no
 * MAC here, no signature, and nothing that would detect a receipt written
 * directly into the repository's runtime directory by something else. The
 * receipt's own header states that second limit again, because it is the one a
 * reader is most likely to over-read.
 *
 * ── The mint re-derives; it does not take the caller's word ────────────────
 *
 * Every input is re-checked below even though the single production caller has
 * already checked it. In particular *mergedness* is re-derived from the reading
 * rather than accepted as a flag: the one function that can produce the
 * artefact is the wrong place to trust a caller's summary of what the forge
 * said.
 */

import type { MergeReading } from '../pull-request-merge.js';

/**
 * The registry. A `WeakSet` a value cannot be reached from — an instance can
 * hand out its prototype and its constructor, and neither of those is this.
 */
const MINTED = new WeakSet<object>();

/**
 * Captured and bound at module load, so that a later
 * `WeakSet.prototype.has = () => true` cannot turn the gate off process-wide.
 * The same defence the observation proof and the lease proof carry.
 */
const registryHas: (value: object) => boolean = WeakSet.prototype.has.bind(MINTED);

function isMinted(value: object): boolean {
  return registryHas(value);
}

const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The longest base branch name this artefact will carry.
 *
 * A bound rather than a grammar: the ref is compared for equality against what
 * the task recorded and is never put in an argument vector by this path, so the
 * property that matters is that it cannot grow without limit inside a record
 * that has a size budget.
 */
export const MAX_BASE_REF_LENGTH = 255;

/**
 * What one settled merge observation looked like, in plain values.
 *
 * These are the facts a durable receipt is built from. They are readable — the
 * artefact hides its *constructibility*, not its content, because a reader
 * learning which commit resulted gains nothing while a writer minting a merge
 * that never happened gains everything.
 *
 * Note what is **not** here: no raw response, no `gh` output, no exit code, no
 * stderr, no URL, no header, no pull-request title or body, no author, no
 * branch diff. The receipt downstream can only hold what this carries, so the
 * hygiene rule is enforced by the shape rather than by a filtering step
 * somebody has to remember to run.
 */
export interface MergeObservationFacts {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** The pull request the forge was asked about, by number. */
  readonly pullRequestNumber: number;
  /**
   * The head object name the forge reported for the merged pull request.
   *
   * This is the commit that *went in* — the pull request's head before the
   * merge — and it is the field that binds the merge to a task. Under a squash
   * merge it is on no branch afterwards, which is precisely why it has to come
   * from the forge rather than from anything local.
   */
  readonly headSha: string;
  /** The base branch the forge reported. A bare branch name, never an object name. */
  readonly baseRef: string;
  /**
   * The commit the merge produced.
   *
   * `merge_commit_sha` on a **merged** pull request. Read only under `MERGED`,
   * and that is a correctness property rather than a convention: measured, on
   * an *open* pull request that same field holds an ephemeral two-parent *test*
   * merge commit that is on no branch. The reading this mint accepts has
   * already established mergedness, so the field means what it says.
   */
  readonly mergeCommit: string;
  /** When this process asked. ISO-8601 with an explicit offset. */
  readonly observedAt: string;
}

export class MergeObservationEvidence {
  readonly #facts: MergeObservationFacts;

  constructor(facts: MergeObservationFacts) {
    this.#facts = facts;
  }

  /** Whether the mint built this value. See the header for what this is not. */
  static holds(value: unknown): value is MergeObservationEvidence {
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
  static factsOf(proof: MergeObservationEvidence): MergeObservationFacts {
    return proof.#facts;
  }
}

/**
 * What the caller says it asked about. Every field is re-derived against the
 * reading below; none of it is taken on trust.
 */
export interface ObservedMerge {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** The number the request was addressed to. */
  readonly pullRequestNumber: number;
  /** The reading that came back, from the recognised boundary. */
  readonly reading: MergeReading;
  /** When this process asked. */
  readonly observedAt: string;
}

function isAddressablePart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/**
 * Mints a proof for a reading that established a merge, or `null`.
 *
 * `null` for every input this cannot vouch for, and the list is not defensive
 * padding — each entry is a way the calling module could come to hold a value
 * it did not establish:
 *
 *  - a reading whose outcome is not `MERGED`: the forge did not say the pull
 *    request is merged, so there is no merge to attest to. This is the one that
 *    matters, and it is re-derived from the outcome word rather than taken as a
 *    flag;
 *  - a reading about a different pull request than the one addressed: the
 *    answer and the question disagree, and a receipt built from them would bind
 *    a merge to a number nobody asked about;
 *  - a merged reading with no resulting commit, or one that is not an object
 *    name: the field a later slice exists to verify is the one field a caller
 *    cannot recompute, so a reading that cannot name it has not established the
 *    thing the receipt is for;
 *  - a merged reading with no head or no base: the two bindings that decide
 *    whether this merge is *this task's* delivery;
 *  - a subject or an instant that is not one this build addresses: a receipt
 *    built from them would be unreadable by the schema that has to accept it
 *    back.
 */
export function mintMergeObservation(observed: ObservedMerge): MergeObservationEvidence | null {
  if (!isAddressablePart(observed.host)) return null;
  if (!isAddressablePart(observed.owner)) return null;
  if (!isAddressablePart(observed.name)) return null;
  if (!Number.isSafeInteger(observed.pullRequestNumber) || observed.pullRequestNumber <= 0) {
    return null;
  }
  if (typeof observed.observedAt !== 'string' || !ISO_8601.test(observed.observedAt)) return null;

  const reading = observed.reading;
  if (typeof reading !== 'object' || reading === null) return null;

  // The mergedness gate, re-derived. There is deliberately no arm here that
  // turns an `OPEN`, a `CLOSED_UNMERGED` or an `UNKNOWN` into a proof carrying
  // nulls: "the pull request is not merged" is not a weaker merge observation,
  // it is not one.
  if (reading.outcome !== 'MERGED') return null;
  // A reading about another pull request is not a reading about this one.
  if (reading.number !== observed.pullRequestNumber) return null;

  const { headSha, baseRef, mergeCommit } = reading;
  if (typeof headSha !== 'string' || !COMMIT_OBJECT_NAME.test(headSha)) return null;
  if (typeof mergeCommit !== 'string' || !COMMIT_OBJECT_NAME.test(mergeCommit)) return null;
  if (typeof baseRef !== 'string' || baseRef.length === 0) return null;
  if (baseRef.length > MAX_BASE_REF_LENGTH) return null;

  const proof = new MergeObservationEvidence(
    Object.freeze({
      host: observed.host,
      owner: observed.owner,
      name: observed.name,
      pullRequestNumber: observed.pullRequestNumber,
      headSha,
      baseRef,
      mergeCommit,
      observedAt: observed.observedAt,
    }),
  );
  // The only line in this module that admits anything to the registry.
  MINTED.add(proof);
  return proof;
}

// Closed for the same two reasons the observation, lease and containment proofs
// are closed: the constructor is reachable from any instance through its
// prototype, and a writable static is a process-wide off switch for the gate.
// Neither is what makes the type safe — the registry is — and both are cheap.
Reflect.deleteProperty(MergeObservationEvidence.prototype, 'constructor');
Object.freeze(MergeObservationEvidence.prototype);
Object.freeze(MergeObservationEvidence);
