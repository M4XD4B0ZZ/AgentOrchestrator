/**
 * The post-merge verification proof: the public type, and the only ways to use
 * one.
 *
 * This module is what the rest of the codebase sees. It can *name* the
 * artefact, *check* one and *read* one, and it cannot make one — the mint stays
 * in `internal/post-merge-verification-proof.ts`, whose header carries the
 * reasoning for the whole arrangement.
 *
 * Same shape as `merge-observation-proof.ts`, `delivery-observation-proof.ts`
 * and `core/containment-attestation.ts`, deliberately: a reader who knows one
 * knows the others, and none of them can quietly become laxer than its
 * siblings.
 */

import {
  PostMergeVerificationEvidence,
  POST_MERGE_VERIFICATION_OUTCOMES,
  type PostMergeVerificationFacts,
  type PostMergeVerificationOutcome,
} from './internal/post-merge-verification-proof.js';

export type { PostMergeVerificationFacts, PostMergeVerificationOutcome };
export { POST_MERGE_VERIFICATION_OUTCOMES };

/**
 * Proof that this process ran the canonical verification profile in a workspace
 * it had proved was at exactly this merge commit, and that the run ended this
 * way.
 *
 * Opaque by construction. Callers hold it, forward it and hand it to the
 * verification recorder; they never build one.
 *
 * Note what it does **not** assert: that the commit is currently on the base
 * branch, that it is currently reachable from it, that the merge is unreverted,
 * that the base passes now, or that the task is complete. The mint's header
 * lists each of those and why.
 */
export type PostMergeVerificationProof = PostMergeVerificationEvidence;

/**
 * Whether this really is a minted proof.
 *
 * Registry membership, not shape, not prototype, not a private-field probe.
 * Accepts `unknown` so the check is meaningful at a boundary where the static
 * type has already been subverted — which is the only place it matters.
 */
export function isPostMergeVerificationProof(
  value: unknown,
): value is PostMergeVerificationProof {
  return PostMergeVerificationEvidence.holds(value);
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
export function postMergeVerificationFactsOf(
  value: unknown,
): PostMergeVerificationFacts | null {
  if (!isPostMergeVerificationProof(value)) return null;
  try {
    return PostMergeVerificationEvidence.factsOf(value);
  } catch {
    return null;
  }
}
