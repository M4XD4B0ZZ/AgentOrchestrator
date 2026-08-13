/**
 * Execution-lease evidence: the public type, and the only way to check one.
 *
 * This module is what the rest of the codebase sees. It can *name* the artefact
 * and *verify* one, and it cannot make one — the mint stays in
 * `internal/execution-lease-evidence.ts`, whose reasoning for the whole
 * arrangement lives in its header.
 *
 * The type is re-exported as a type alias rather than as the class, so importing
 * this module gives a caller no constructor to reach for. Same arrangement as
 * `core/auth-preflight-evidence.ts`, and deliberately so: a reader who knows one
 * knows the other, and neither can quietly become laxer than its sibling.
 */

import { ExecutionLeaseProof } from './internal/execution-lease-evidence.js';

/**
 * Proof that this process performed the exclusive create that claimed a
 * repository's execution lease.
 *
 * Opaque by construction. Callers hold it, forward it, and hand it to
 * {@link isExecutionLeaseEvidence} or to the lease store; they never build one.
 *
 * Note what it does **not** assert: that the lease is still held. That question
 * has its own answer (`verifyExecutionLeaseHeld`), because a file can be removed
 * underneath its owner and an artefact in memory would never notice.
 */
export type ExecutionLeaseEvidence = ExecutionLeaseProof;

/**
 * Whether this really is minted evidence.
 *
 * The gate every consumer uses, and the reason a cast gains nothing. It asks
 * whether the **mint** produced this object — membership of a registry only the
 * mint writes to — rather than anything about the object's shape, prototype or
 * fields. A shape test would accept exactly the forgery the nominal type exists
 * to refuse.
 *
 * Accepts `unknown` so that the check is also meaningful at a boundary where the
 * static type has already been subverted — which is the only place it matters.
 */
export function isExecutionLeaseEvidence(value: unknown): value is ExecutionLeaseEvidence {
  // Registry membership, and this comment has been wrong twice, so it is worth
  // being exact. It is **not** `instanceof`: that walks a prototype chain, and
  // `Object.create` hands anybody the prototype — a review turned that into
  // working evidence with no imports at all. It is **not** a private-field
  // check either: `Object.getPrototypeOf(evidence).constructor` reached the
  // class with no import, and calling it installs a real private field, which a
  // second review used to delete a rightful owner's lease.
  //
  // See the mint's header for why only a set the mint alone writes to answers
  // the question actually being asked, which is "did the mint build this?".
  return ExecutionLeaseProof.holds(value);
}
