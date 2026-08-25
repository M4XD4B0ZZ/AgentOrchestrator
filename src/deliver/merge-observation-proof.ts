/**
 * The merge observation proof: the public type, and the only ways to use one.
 *
 * This module is what the rest of the codebase sees. It can *name* the artefact,
 * *check* one and *read* one, and it cannot make one — the mint stays in
 * `internal/merge-observation-proof.ts`, whose header carries the reasoning for
 * the whole arrangement.
 *
 * Same shape as `delivery-observation-proof.ts` and
 * `core/containment-attestation.ts`, deliberately: a reader who knows one knows
 * the others, and none of them can quietly become laxer than its siblings.
 */

import {
  MergeObservationEvidence,
  type MergeObservationFacts,
} from './internal/merge-observation-proof.js';

export type { MergeObservationFacts };

/**
 * Proof that this process asked github.com about exactly one pull request and
 * was told it is merged, at this head, into this base, producing this commit.
 *
 * Opaque by construction. Callers hold it, forward it and hand it to the
 * reconciliation recorder; they never build one.
 *
 * Note what it does **not** assert. It is not authority to merge, to push, to
 * open a pull request or to write task state. It does not say AO performed the
 * merge, that the resulting commit is currently on the base branch, that
 * anything was verified, or that the answer is still true — see the mint's
 * header, which lists each of those and why.
 */
export type MergeObservationProof = MergeObservationEvidence;

/**
 * Whether this really is a minted proof.
 *
 * Registry membership, not shape, not prototype, not a private-field probe. The
 * mint's header states which of those were defeated against this codebase's
 * other opaque artefacts and how.
 *
 * Accepts `unknown` so the check is meaningful at a boundary where the static
 * type has already been subverted — which is the only place it matters.
 */
export function isMergeObservationProof(value: unknown): value is MergeObservationProof {
  return MergeObservationEvidence.holds(value);
}

/**
 * The facts inside a proof, or `null` for anything that is not one.
 *
 * The safe accessor, and the only one offered. `factsOf` reads a private field,
 * so it *throws* for a value that passed the registry gate without going through
 * the constructor — which is reachable, as `lease/execution-lease.ts` records: a
 * review captured the registry itself by hooking `WeakSet.prototype.add` before
 * the first mint. A check that answers by throwing is not answering, so this one
 * asks safely and reports the refusal as `null`.
 *
 * What that buys, stated exactly, because the reassuring version of this
 * sentence is wrong. Registry capture alone yields a value that passes
 * {@link isMergeObservationProof} and reads back `null` here — so it is refused
 * at the recorder, which is the property that matters. Registry capture
 * *together with* the internal class produces a fully readable forgery. That is
 * not an escalation: anyone who can import `internal/merge-observation-proof.js`
 * can call the mint directly. The artefact's guarantee is against a caller that
 * does **not** import the mint, and it should not be read as more.
 */
export function mergeObservationFactsOf(value: unknown): MergeObservationFacts | null {
  if (!isMergeObservationProof(value)) return null;
  try {
    return MergeObservationEvidence.factsOf(value);
  } catch {
    return null;
  }
}
