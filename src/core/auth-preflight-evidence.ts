/**
 * Auth-preflight evidence: the public type, and the only way to check one.
 *
 * This module is what the rest of the codebase sees. It can *name* the artefact
 * and *verify* one, and it cannot make one — the mint stays in
 * `internal/auth-preflight-evidence.ts`, whose reasoning for the whole
 * arrangement lives in its header.
 *
 * The type is re-exported as a type alias rather than as the class, so
 * importing this module gives a caller no constructor to reach for.
 */

import { AuthPreflightProof } from './internal/auth-preflight-evidence.js';

/**
 * Proof that a real auth preflight ran in this process and every check passed.
 *
 * Opaque by construction: see the mint's header. Callers hold it, forward it and
 * hand it to {@link isAuthPreflightEvidence}; they never build one.
 */
export type AuthPreflightEvidence = AuthPreflightProof;

/**
 * Whether this really is minted evidence.
 *
 * The gate every consumer uses, and the reason a cast gains nothing. It is an
 * `instanceof` test rather than a shape test on purpose: a shape test would
 * accept exactly the forgery the nominal type exists to refuse.
 *
 * Accepts `unknown` so that the check is also meaningful at a boundary where
 * the static type has already been subverted — which is the only place it
 * matters.
 */
export function isAuthPreflightEvidence(value: unknown): value is AuthPreflightEvidence {
  return value instanceof AuthPreflightProof;
}
