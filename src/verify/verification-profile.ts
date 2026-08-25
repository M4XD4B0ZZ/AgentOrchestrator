/**
 * The identity of *what was run* when a verification verdict was produced.
 *
 * ── Why a verdict without this is not a fact ───────────────────────────────
 *
 * `run-verification.ts` answers `PASSED` for a commit. Stored on its own, that
 * sentence is missing its subject's other half: **which contract** the commit
 * satisfied. A repository profile is an ordinary file — a phase can be added,
 * a command can be rewritten, `npm run verify` can grow a step — and a reader
 * finding a stored `PASSED` months later has no way to tell whether it was
 * produced by the gate they are about to trust or by an earlier, weaker one.
 *
 * So a durable verification result names a digest of the phases it ran, and a
 * later reader compares that digest against the profile resolved *now*. Equal
 * means the stored verdict is about this contract. Different means it is about
 * a contract this build no longer has — which is a structural reason the old
 * result does not answer the new question, and the only kind of reason this
 * build accepts. **Age is not one.** A result does not become wrong by getting
 * old, and a TTL here would silently discard evidence that is still exactly as
 * true as the day it was written.
 *
 * ── What it covers, and what it deliberately does not ──────────────────────
 *
 * Exactly {@link ResolvedVerificationPolicy} — the ordered phase list, each
 * phase's name and each phase's argument vector, token by token. That is the
 * whole of what `runVerification` executes, and nothing else in the resolved
 * repository can change what a phase does.
 *
 * It does **not** cover the toolchain: the Node version, the contents of
 * `node_modules`, the state of `dist/`, `PATH`, or anything else about the
 * machine. That is not an oversight and not a gap to be closed later by adding
 * fields. A digest that claimed to identify the toolchain would be a promise
 * this process cannot keep — `npm run verify` reaches an arbitrary tree of
 * scripts and dependencies, and any summary of that is either a lie or a
 * re-implementation of a package manager. The honest boundary is: this digest
 * identifies **the contract**, and a stored result is evidence about *one run*
 * of that contract at *one instant*, never about the machine.
 *
 * ── Ordered, and separately typed ──────────────────────────────────────────
 *
 * Phase order is part of the identity because it is part of the contract:
 * `run-verification.ts` stops at the first phase that does not pass, so
 * `[BUILD, TEST]` and `[TEST, BUILD]` are different gates that can disagree.
 * The digest is computed over the phases *in order*, and reordering them
 * changes it.
 */

import { createHash } from 'node:crypto';

import type { ResolvedVerificationPolicy } from '../repo/resolve-repository.js';

/**
 * Domain separation, so this digest can never collide with another one.
 *
 * The same discipline `merge-reconciliation.ts` applies to its binding digest,
 * and for the same reason: two sha256 values computed from different questions
 * must not be comparable by accident.
 */
const PROFILE_LABEL = 'agent-orchestrator/verification-profile/v1';

/**
 * A stable identity for one resolved verification policy.
 *
 * The inputs are enumerated field by field rather than serialised from the
 * object, following {@link mergeReconciliationBinding}'s convention and for the
 * reason it states: `JSON.stringify(policy)` would make the digest depend on
 * key order, and would silently start covering — or stop covering — a field
 * added to `ResolvedVerificationPolicy` without anybody deciding it should.
 *
 * `ResolvedVerificationPolicy` has exactly one field today, and both of that
 * field's members are here. A field added to it without being added here leaves
 * that field unidentified, which is why the test file asserts that a change to
 * every governed part moves the digest.
 */
export function verificationProfileDigest(policy: ResolvedVerificationPolicy): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        PROFILE_LABEL,
        // Ordered, and each phase as a pair, so that a phase name moving
        // between two commands cannot produce the same digest as the two
        // commands moving between the names.
        policy.phases.map((entry) => [entry.phase, [...entry.command]]),
      ]),
    )
    .digest('hex');
}
