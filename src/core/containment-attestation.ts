/**
 * Containment attestation: the public type, and the only ways to use one.
 *
 * This module is what the rest of the codebase sees. It can *name* the artefact,
 * *check* one and *read* one, and it cannot make one — the mint stays in
 * `internal/containment-attestation.ts`, whose header carries the reasoning for
 * the whole arrangement.
 *
 * Same shape as `core/execution-lease-evidence.ts`, deliberately: a reader who
 * knows one knows the other, and neither can quietly become laxer than its
 * sibling. The one addition is {@link containmentFactsOf}, because unlike lease
 * evidence — which is only ever *compared* — this artefact's content is written
 * into a durable record, so somebody has to be able to read it.
 */

import {
  ContainmentProof,
  type ContainmentFacts,
} from './internal/containment-attestation.js';

export type { ContainmentFacts };

/**
 * Proof that a process was created for a Job Object this process owns, that the
 * kernel confirmed its membership, and that **no instruction of the target
 * executed outside that job**.
 *
 * That third clause is the one to read carefully, because the two obvious
 * wordings are each false in one launch mode and this file has now carried both.
 * "Membership confirmed before the target executed" is false in `JOBLIST`, the
 * production default: there the target is created into the job and is *not*
 * created suspended, so it is already running when the kernel is asked
 * (`native/ao-launch/AoLaunch.cs`: `if (!jobList) flags |= CREATE_SUSPENDED`).
 * "It never existed outside the job" is false in `SUSPENDED`: there it is
 * created suspended, exists briefly in no job, and is assigned before it is
 * resumed. What holds in **both** is that no code of the target ran outside the
 * job, which is the claim containment actually needs.
 *
 * Opaque by construction. Callers hold it, forward it and hand it to the lease
 * recorder; they never build one.
 *
 * Note what it does **not** assert. It is not authority to write anywhere — see
 * the mint's header — and it is not a claim that the contained process is still
 * running, or that the job still exists. It is a statement about one moment,
 * which is exactly why the record built from it is bound to that moment's run,
 * writer and owner rather than left standing on its own.
 */
export type ContainmentAttestation = ContainmentProof;

/**
 * Whether this really is a minted attestation.
 *
 * Registry membership, not shape, not prototype, not a private-field probe. The
 * mint's header states which of those were defeated against this codebase's
 * other opaque artefact and how.
 *
 * Accepts `unknown` so the check is meaningful at a boundary where the static
 * type has already been subverted — which is the only place it matters.
 */
export function isContainmentAttestation(value: unknown): value is ContainmentAttestation {
  return ContainmentProof.holds(value);
}

/**
 * The facts inside an attestation, or `null` for anything that is not one.
 *
 * The safe accessor, and the only one offered. `ContainmentProof.factsOf` reads
 * a private field, so it *throws* for a value that passed the registry gate
 * without going through the constructor — which is reachable, as
 * `lease/execution-lease.ts` records: a review captured the registry itself by
 * hooking `WeakSet.prototype.add` before the first mint. A check that answers by
 * throwing is not answering, so this one asks safely and reports the refusal as
 * `null`.
 *
 * What that buys, stated exactly, because the reassuring version of this
 * sentence is wrong. Registry capture alone yields a value that passes
 * {@link isContainmentAttestation} and reads back `null` here — so it is refused
 * at the recorder, which is the property that matters. Registry capture
 * *together with* the internal class produces a fully readable forgery, and an
 * adversarial review demonstrated it. That is not an escalation: anyone who can
 * import `internal/containment-attestation.js` can call the mint directly. The
 * artefact's guarantee is against a caller that does **not** import the mint,
 * and it should not be read as more.
 */
export function containmentFactsOf(value: unknown): ContainmentFacts | null {
  if (!isContainmentAttestation(value)) return null;
  try {
    return ContainmentProof.factsOf(value);
  } catch {
    return null;
  }
}
