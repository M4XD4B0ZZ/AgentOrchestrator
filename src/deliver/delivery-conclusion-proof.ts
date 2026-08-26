/**
 * The delivery-conclusion proof: the public type, and the only ways to use one.
 *
 * This module is what the rest of the codebase sees. It can *name* the
 * artefact, *check* one and *read* one, and it cannot make one — the mint stays
 * in `internal/delivery-conclusion-proof.ts`, whose header carries the
 * reasoning for the whole arrangement.
 *
 * Same shape as `post-merge-verification-proof.ts`, `merge-observation-proof.ts`,
 * `delivery-observation-proof.ts` and `core/containment-attestation.ts`,
 * deliberately: a reader who knows one knows the others, and none of them can
 * quietly become laxer than its siblings.
 */

import {
  DeliveryConclusionEvidence,
  type DeliveryConclusionFacts,
} from './internal/delivery-conclusion-proof.js';

export type { DeliveryConclusionFacts };

/**
 * Proof that this process read one task's merge receipt and its post-merge
 * verification history together, found them to describe one delivery, and found
 * that delivery's merge commit standing at a pass under the profile resolved in
 * the same invocation.
 *
 * Opaque by construction. Callers hold it, forward it and hand it to the
 * conclusion recorder; they never build one.
 *
 * Note what it does **not** assert: that the merge commit is on the base branch
 * now, that it is reachable from it, that the merge is unreverted, that the
 * changes survive anywhere, that the base passes now, or that any task state
 * moved. The mint's header lists each of those and why.
 */
export type DeliveryConclusionProof = DeliveryConclusionEvidence;

/**
 * Whether this really is a minted proof.
 *
 * Registry membership, not shape, not prototype, not a private-field probe.
 * Accepts `unknown` so the check is meaningful at a boundary where the static
 * type has already been subverted — which is the only place it matters.
 */
export function isDeliveryConclusionProof(value: unknown): value is DeliveryConclusionProof {
  return DeliveryConclusionEvidence.holds(value);
}

/**
 * The facts inside a proof, or `null` for anything that is not one.
 *
 * The safe accessor, and the only one offered. `factsOf` reads a private field,
 * so it *throws* for a value that passed the registry gate without going
 * through the constructor — reachable, as `lease/execution-lease.ts` records: a
 * review captured a registry by hooking `WeakSet.prototype.add` before the
 * first mint. A check that answers by throwing is not answering, so this one
 * asks safely and reports the refusal as `null`.
 */
export function deliveryConclusionFactsOf(value: unknown): DeliveryConclusionFacts | null {
  if (!isDeliveryConclusionProof(value)) return null;
  try {
    return DeliveryConclusionEvidence.factsOf(value);
  } catch {
    return null;
  }
}
