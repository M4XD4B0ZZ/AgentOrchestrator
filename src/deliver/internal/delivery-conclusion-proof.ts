/**
 * The delivery-conclusion proof — the mint, and the only place one can be made.
 *
 * ── What this artefact says ────────────────────────────────────────────────
 *
 * *This process read a merge receipt and a post-merge verification history for
 * one task, in one invocation, found them to agree about one delivery, and
 * found that delivery's merge commit standing at a pass under the profile
 * resolved now.*
 *
 * Three parts, and the middle one is why the artefact exists. Two records that
 * each mention the same commit are two documents; a *conclusion* is what makes
 * them one sentence. The mint below refuses to build one unless the receipt's
 * merge commit, its subject commit, its forge identity and its pull-request
 * number all equal the verification history's — so **there is no representable
 * value that says "this delivery is concluded" and was produced from two
 * records about different deliveries.**
 *
 * ── What it emphatically does not say ──────────────────────────────────────
 *
 *  - **not** that M is on the base branch now, or reachable from it. This build
 *    does not ask, and `delivery-conclusion.ts` records the measurements that
 *    decided it should not;
 *  - **not** that the merge has not been reverted. Measured: a reverted merge
 *    and a clean linear advance are indistinguishable on every Git predicate
 *    this build could run;
 *  - **not** that M's changes are still present anywhere;
 *  - **not** that the base branch passes now, or that any other commit passed;
 *  - **not** that the task's state machine moved. `TaskState` is not written,
 *    `READY_FOR_PR` stays terminal, and `currentCommit` stays **H**;
 *  - **not** authorship of the two records it read. Both are keyless-checksummed
 *    JSON in a runtime directory, and a conclusion drawn from a forged pass is a
 *    conclusion drawn from a forged pass. The boundary here is the same
 *    in-process one every sibling artefact draws, and no wider;
 *  - **not** freshness. A conclusion drawn an hour ago and one drawn now are
 *    indistinguishable to every consumer, deliberately.
 *
 * ── Why it is opaque ───────────────────────────────────────────────────────
 *
 * The durable record downstream carries the sentence *this delivery is
 * concluded*, and such a sentence may only come from an assessment that
 * actually read both records. A structural type cannot carry that:
 * `{ concluded: true }` is a shape any caller can write down, and a richer
 * shape is only a longer thing to write down. Same mechanism, and the same two
 * defeated attacks (`Object.create` for the prototype, `#facts in value` for
 * the private field), as `internal/post-merge-verification-proof.ts` and
 * `internal/merge-observation-proof.ts`.
 *
 * The boundary is exactly: **ordinary product code cannot manufacture a
 * delivery conclusion without going through the join below.** It is an
 * in-process product-code provenance boundary. It is not a guarantee against a
 * caller that imports this module, and it is **not** filesystem authenticity.
 *
 * ── The mint re-derives; it does not take the caller's word ────────────────
 *
 * The caller hands in the two records it read. Every field the conclusion
 * depends on is compared here, and the passing attempt is selected here rather
 * than accepted as a summary. The one function that can produce the artefact is
 * the wrong place to trust a caller's account of what the records said.
 */

import type { MergeReconciliation } from '../merge-reconciliation.js';
import type { PostMergeVerification, VerificationAttempt } from '../post-merge-verification.js';

/**
 * The registry. A `WeakSet` a value cannot be reached from — an instance can
 * hand out its prototype and its constructor, and neither of those is this.
 */
const MINTED = new WeakSet<object>();

/**
 * Captured and bound at module load, so a later
 * `WeakSet.prototype.has = () => true` cannot turn the gate off process-wide.
 * The same defence every other opaque artefact here carries.
 */
const registryHas: (value: object) => boolean = WeakSet.prototype.has.bind(MINTED);

function isMinted(value: object): boolean {
  return registryHas(value);
}

const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The facts a conclusion carries, in plain values.
 *
 * These are what the durable record is built from. They are readable — the
 * artefact hides its *constructibility*, not its content.
 *
 * Note what is **not** here: no base ref reachability, no ancestry verdict, no
 * task-state revision, no diagnostics, no repository path beyond what the two
 * records already carry. A field for a question this build does not ask would
 * be a field somebody fills in later with a guess.
 */
export interface DeliveryConclusionFacts {
  /** The task's implementation head **H** — the receipt's `subjectCommit`. */
  readonly subjectCommit: string;
  /** The merge commit **M** — the receipt's `mergeCommit`, and the verified one. */
  readonly mergeCommit: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly pullRequestNumber: number;
  /** The branch the merged pull request targeted, as the forge named it then. */
  readonly baseRef: string;
  /**
   * The profile the standing verdict passed under — the digest of the profile
   * resolved *now*, which the mint requires the passing attempt to carry.
   */
  readonly profileDigest: string;
  /** The `attemptedAt` of the attempt that is the standing pass. */
  readonly verifiedAt: string;
  /**
   * The receipt document's own binding digest, as it stood when this conclusion
   * was drawn.
   *
   * Provenance, never a gate on a later read. The receipt is written once and
   * never rewritten, so this value is stable in practice; it is carried so an
   * auditor can say *which document* was concluded from, not so anything can
   * compare it afterwards.
   */
  readonly receiptBinding: string;
  /**
   * The verification history's binding digest, as it stood when this conclusion
   * was drawn.
   *
   * The history is **append-only**, so a later attempt legitimately changes it.
   * A mismatch against the file later is therefore *not* evidence of tampering,
   * and nothing in this build compares the two. Same role as
   * {@link receiptBinding}: it names the bytes this judgement was drawn from.
   */
  readonly verificationBinding: string;
  /** When this process drew the conclusion. ISO-8601 with an explicit offset. */
  readonly concludedAt: string;
}

export class DeliveryConclusionEvidence {
  readonly #facts: DeliveryConclusionFacts;

  constructor(facts: DeliveryConclusionFacts) {
    this.#facts = facts;
  }

  /** Whether the mint built this value. See the header for what this is not. */
  static holds(value: unknown): value is DeliveryConclusionEvidence {
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
  static factsOf(proof: DeliveryConclusionEvidence): DeliveryConclusionFacts {
    return proof.#facts;
  }
}

/**
 * What the caller says it read. Every field is re-checked below.
 *
 * The two records are passed **whole**, not as a summary of them. A summary is
 * a place for a caller to make the join true by describing it that way.
 */
export interface AssessedDelivery {
  readonly receipt: MergeReconciliation;
  readonly verification: PostMergeVerification;
  /** The digest of the profile resolved in this invocation. */
  readonly profileDigest: string;
  /** When this process drew the conclusion. */
  readonly concludedAt: string;
}

/**
 * The attempt that stands for one profile, or `null` when none does.
 *
 * **This is not {@link hasPassFor}, and the difference is the whole point.**
 * `post-merge-verification-store.ts` asks "is a re-run pointless?", and for
 * that question *any* pass anywhere in the history is a yes — which is why it
 * is written with `.some()`. This asks a strictly bigger question, "is the
 * standing verdict a pass?", and the two answers differ on exactly one shape:
 * a pass followed by a fail for the same profile.
 *
 * The rule, and each clause is load-bearing:
 *
 *  - only attempts under **this** profile are considered. A verdict about a
 *    different contract does not answer this contract's question. That is the
 *    structural reason this build accepts for setting a result aside, and age
 *    is still never one;
 *  - `VERIFICATION_NOT_ESTABLISHED` attempts are **skipped, not counted**.
 *    Nothing was learned about the code, and a machine that could not answer is
 *    not the machine saying no. Treating one as the standing verdict would let
 *    a busy workstation un-conclude a delivery;
 *  - of what remains — the attempts that are a *verdict about the code* — the
 *    **last** one stands. `attempts` is append-only and ordered oldest first,
 *    so array position is the order; no instant is compared, which matters
 *    because `attemptedAt` comes from a clock that can step backwards.
 *
 * Reachability, stated rather than left to be found: through the product path a
 * pass is terminal for a (commit, profile) pair — `verify-merge.ts` converges
 * on `ALREADY_VERIFIED` and runs nothing more — so a pass followed by a fail
 * cannot be produced by this build today. The rule is therefore **unreachable
 * through the product and load-bearing the moment a re-verification exists**
 * (L-V4-09-2 is exactly that gap), and it is pinned by a test that constructs
 * the history directly.
 */
export function standingVerdictFor(
  verification: PostMergeVerification,
  profileDigest: string,
): VerificationAttempt | null {
  let standing: VerificationAttempt | null = null;
  for (const attempt of verification.attempts) {
    if (attempt.profileDigest !== profileDigest) continue;
    if (attempt.outcome === 'VERIFICATION_NOT_ESTABLISHED') continue;
    standing = attempt;
  }
  return standing;
}

/**
 * Whether a merge receipt and a verification history describe **one delivery**.
 *
 * The join, in one place, called by the mint below and by the ladder in
 * `conclude-delivery.ts`. Six fields, and none of them is decoration:
 *
 *  - **`mergeCommit`** — the commit that was verified must be the commit this
 *    task's merge produced;
 *  - **`subjectCommit`** — and it must have been produced by *this task's*
 *    implementation head. A history about the right merge filed against the
 *    wrong head is a history about somebody else's delivery of the same object;
 *  - **`host` / `owner` / `name`** — two forks can share a commit object name
 *    exactly, so the target is part of the question rather than something
 *    assumed to follow from it;
 *  - **`pullRequestNumber`** — the same head can be opened twice.
 *
 * **Nothing else in this build performs this join.** `verify-merge.ts` compares
 * the history's `mergeCommit` alone on its convergence path, and the
 * verification store's `sameDelivery` compares the rest only on a path a
 * converged run never reaches — so a history whose header names a different
 * pull request, fork or implementation head reads as an ordinary pass to every
 * existing reader. That gap is what this function closes, and it is the reason
 * a conclusion is a minted artefact rather than a boolean.
 */
export function describesSameDelivery(
  receipt: MergeReconciliation,
  verification: PostMergeVerification,
): boolean {
  return (
    receipt.mergeCommit === verification.mergeCommit &&
    receipt.subjectCommit === verification.subjectCommit &&
    receipt.host === verification.host &&
    receipt.owner === verification.owner &&
    receipt.name === verification.name &&
    receipt.pullRequestNumber === verification.pullRequestNumber
  );
}

/**
 * Mints a proof, or answers `null`.
 *
 * `null` for every input this build will not draw a conclusion from:
 *
 *  - the two records disagree about the task or the repository root. Either
 *    would already have been refused by its own loader, which compares both
 *    against the subject; this is the pair being compared *against each other*,
 *    which no loader does;
 *  - the two records do not describe one delivery — **the load-bearing
 *    refusal**. See {@link describesSameDelivery};
 *  - the verification history has no standing verdict under this profile, or
 *    its standing verdict is not a pass. See {@link standingVerdictFor};
 *  - any object name is not a full 40-hex commit name, either digest is not a
 *    digest, or either instant is not ISO-8601.
 */
export function mintDeliveryConclusion(
  assessed: AssessedDelivery,
): DeliveryConclusionEvidence | null {
  const receipt = assessed.receipt;
  const verification = assessed.verification;

  // ── The two records must be about one task, in one repository ────────────
  //
  // Each loader has already compared its own document against the subject it
  // was asked for, so in this build both equal it and therefore each other.
  // That makes these two lines redundant *today* and it is stated rather than
  // left to be discovered: they are the lines that keep a conclusion from being
  // drawn across two documents if either loader ever stopped comparing.
  if (receipt.taskId !== verification.taskId) return null;
  if (receipt.repositoryRoot !== verification.repositoryRoot) return null;

  // ── The two records must be about one delivery ───────────────────────────
  //
  // {@link describesSameDelivery} is called here and in `conclude-delivery.ts`,
  // and the two calls are a **pair** rather than two gates. The ladder asks
  // first, so that an operator whose two records disagree is told *that* rather
  // than being told the mint declined; the mint asks because it is the thing
  // that may not produce an artefact from records it has not checked itself.
  // Against this build's ladder the mint's call refuses nothing the ladder
  // would have let through, and a counter-proof measures exactly that: deleting
  // the mint's call alone survives, deleting both together is killed. Its
  // honest status is "redundant while the ladder stands, load-bearing without
  // it".
  if (!describesSameDelivery(receipt, verification)) return null;

  // ── The standing verdict under the profile resolved now ──────────────────
  if (!HEX_64.test(assessed.profileDigest)) return null;
  const standing = standingVerdictFor(verification, assessed.profileDigest);
  if (standing === null) return null;
  if (standing.outcome !== 'VERIFIED_PASS') return null;

  // ── Shapes. Both records have been schema-parsed, so these are floors ────
  if (!COMMIT_OBJECT_NAME.test(receipt.subjectCommit)) return null;
  if (!COMMIT_OBJECT_NAME.test(receipt.mergeCommit)) return null;
  if (!HEX_64.test(receipt.binding)) return null;
  if (!HEX_64.test(verification.binding)) return null;
  if (!ISO_8601.test(standing.attemptedAt)) return null;
  if (!ISO_8601.test(assessed.concludedAt)) return null;

  const evidence = new DeliveryConclusionEvidence(
    Object.freeze({
      subjectCommit: receipt.subjectCommit,
      mergeCommit: receipt.mergeCommit,
      host: receipt.host,
      owner: receipt.owner,
      name: receipt.name,
      pullRequestNumber: receipt.pullRequestNumber,
      baseRef: receipt.baseRef,
      profileDigest: assessed.profileDigest,
      verifiedAt: standing.attemptedAt,
      receiptBinding: receipt.binding,
      verificationBinding: verification.binding,
      concludedAt: assessed.concludedAt,
    }),
  );
  MINTED.add(evidence);
  return evidence;
}

// The class is reachable from any genuine artefact as
// `Object.getPrototypeOf(value).constructor`, with no import at all. Closing it
// here means that route hands back a value the registry does not know, so
// `holds` refuses it — which is the attack `internal/merge-observation-proof.ts`
// records having been used against this codebase's other opaque artefacts.
Object.freeze(DeliveryConclusionEvidence);
Object.freeze(DeliveryConclusionEvidence.prototype);
