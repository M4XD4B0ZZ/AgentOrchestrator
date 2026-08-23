/**
 * The delivery observation proof: the public type, and the only ways to use one.
 *
 * This module is what the rest of the codebase sees. It can *name* the artefact,
 * *check* one and *read* one, and it cannot make one — the mint stays in
 * `internal/delivery-observation-proof.ts`, whose header carries the reasoning
 * for the whole arrangement.
 *
 * Same shape as `core/containment-attestation.ts`, deliberately: a reader who
 * knows one knows the other, and neither can quietly become laxer than its
 * sibling.
 */

import {
  DeliveryObservationEvidence,
  type DeliveryObservationFacts,
} from './internal/delivery-observation-proof.js';

export type { DeliveryObservationFacts };

/**
 * Proof that this process asked github.com about exactly one subject and got a
 * settled answer to both questions.
 *
 * Opaque by construction. Callers hold it, forward it and hand it to the
 * evidence recorder; they never build one.
 *
 * Note what it does **not** assert. It is not authority to merge, to open a
 * pull request or to write task state, and it is not a claim that the answers
 * are still true — see the mint's header. It is a statement about one moment,
 * which is exactly why the record built from it is bound to that moment's task,
 * target and commit rather than left standing on its own.
 */
export type DeliveryObservationProof = DeliveryObservationEvidence;

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
export function isDeliveryObservationProof(value: unknown): value is DeliveryObservationProof {
  return DeliveryObservationEvidence.holds(value);
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
 * {@link isDeliveryObservationProof} and reads back `null` here — so it is
 * refused at the recorder, which is the property that matters. Registry capture
 * *together with* the internal class produces a fully readable forgery. That is
 * not an escalation: anyone who can import `internal/delivery-observation-proof.js`
 * can call the mint directly. The artefact's guarantee is against a caller that
 * does **not** import the mint, and it should not be read as more.
 */
export function deliveryObservationFactsOf(value: unknown): DeliveryObservationFacts | null {
  if (!isDeliveryObservationProof(value)) return null;
  try {
    return DeliveryObservationEvidence.factsOf(value);
  } catch {
    return null;
  }
}
