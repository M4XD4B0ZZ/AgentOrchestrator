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
 * The gate every consumer uses, and the reason a cast gains nothing. It is an
 * `instanceof` test rather than a shape test on purpose: a shape test would
 * accept exactly the forgery the nominal type exists to refuse.
 *
 * Accepts `unknown` so that the check is also meaningful at a boundary where the
 * static type has already been subverted — which is the only place it matters.
 */
export function isExecutionLeaseEvidence(value: unknown): value is ExecutionLeaseEvidence {
  // A brand check on the private field, not `instanceof`. See the mint's header:
  // `instanceof` walks a prototype chain, and `Object.create` hands anybody that
  // prototype — which an adversarial review turned into working evidence with no
  // imports at all. A private field is not copied by `Object.create`.
  return ExecutionLeaseProof.holds(value);
}
