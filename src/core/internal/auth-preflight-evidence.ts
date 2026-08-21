/**
 * The construction boundary for auth-preflight evidence (V2-05 / I4).
 *
 * ── What was wrong with a boolean ───────────────────────────────────────────
 *
 * `RunRequest.authPreflightPassed: boolean` claimed to be "evidence, never
 * assumed", and it was not. It was a caller assertion: three layers passed it
 * along unchanged and `evaluateAutomaticResume` compared it to `true`. Nothing
 * on that path ever called `runAuthPreflight`, so `runTask({ …,
 * authPreflightPassed: true })` was a complete, type-correct way to claim a
 * preflight that had never run.
 *
 * Replacing the boolean with a plain `AuthAssessment` object would not have
 * fixed it. TypeScript is structural, so `authPreflightPassed: true` would have
 * become `{ allPassed: true, checks: [] }` — the same assertion in a longer
 * spelling, and one that additionally reads as if it had been produced by
 * something.
 *
 * ── What replaces it ───────────────────────────────────────────────────────
 *
 * An opaque artefact whose only producer is the real preflight. `runTask` is no
 * longer told *whether* auth passed; it is handed the product of the check, and
 * a caller with nothing to hand it cannot describe a passing preflight at all.
 *
 * Three layers hold that, and they are deliberately of three different kinds:
 *
 * 1. **Nominal typing, enforced by the compiler.** {@link AuthPreflightProof}
 *    carries a `#private` field, so it is nominal rather than structural: no
 *    object literal, no other class and no structurally identical value is
 *    assignable to it. This is the layer that closes the hole a plain evidence
 *    *object* would have left open. `{ proven: true }` is not evidence and will
 *    not compile as evidence.
 *
 * 2. **A runtime check, so a cast fails closed.** No type system stops
 *    `x as unknown as AuthPreflightEvidence`, so the consumer never trusts the
 *    static type: `isAuthPreflightEvidence` is an `instanceof` test, and a
 *    forged value denies the resume exactly as an absent one does. Casting
 *    therefore buys a caller nothing, which is the point — see
 *    `core/auth-preflight-evidence.ts` for the predicate.
 *
 * 3. **Reachability, enforced by a test.** The mint lives here, under
 *    `internal/`, and `tests/auth-preflight-evidence.test.ts` walks `src/` and
 *    pins that exactly one module imports it: `auth/auth-preflight.ts`, the
 *    module that runs the checks. Same mechanism as AO-009's structural-schema
 *    boundary in `tests/internal-api.test.ts`.
 *
 * ── What this does not claim ────────────────────────────────────────────────
 *
 * That the evidence is *fresh*. It proves that this process ran the real
 * preflight and that every check passed, not that it did so recently: nothing
 * here stops a long-lived caller minting once and reusing the artefact, and a
 * timestamp would need a staleness threshold nobody has argued for yet. The
 * word "fresh" in the callers' documentation is therefore still a statement
 * about *when they call it*, and this module does not pretend to enforce it.
 *
 * Since V3-08 one caller really can outlive a preflight by hours:
 * `run/unattended-resume.ts` may sleep until a quota reset and then continue.
 * It does not reuse the artefact. It takes the preflight as a **factory** and
 * builds a new once-only preflight per lifecycle epoch, so the memoisation that
 * makes an attended run cheap ends at the sleep, and the post-wake attempt runs
 * the real checks again. That is a discipline in the caller, exactly as this
 * paragraph says it must be — not a property this artefact acquired.
 */

/**
 * The artefact. Minted only by {@link mintAuthPreflightEvidence}, and only for
 * a preflight in which every check passed.
 *
 * The `#proven` field is what makes the type nominal, and it is the whole
 * mechanism: remove it and this class becomes structurally equal to `{}`, which
 * every object satisfies.
 */
export class AuthPreflightProof {
  readonly #proven: true;

  constructor(proven: true) {
    this.#proven = proven;
  }

  /**
   * Always `true`.
   *
   * There is no "failed" proof to distinguish it from: a preflight that did not
   * pass mints nothing, so absence is the only way a failure is represented.
   */
  get proven(): true {
    return this.#proven;
  }
}

/** The one shape the mint needs from a check. Kept minimal on purpose. */
interface PassedCheck {
  readonly passed: boolean;
}

/**
 * Mints evidence from the results of a preflight that actually ran.
 *
 * Takes the check results rather than a summary flag, and re-derives the
 * verdict here, so that the artefact cannot be produced for an assessment whose
 * `allPassed` disagrees with its own checks.
 *
 * An **empty** check list mints nothing. That is a fail-closed floor with a
 * specific bug in mind: `[].every(…)` is `true`, so a preflight that ran no
 * checks at all — every status command unavailable, a capability dump that
 * produced nothing — would otherwise be indistinguishable from one that passed
 * everything.
 */
export function mintAuthPreflightEvidence(
  checks: readonly PassedCheck[],
): AuthPreflightProof | null {
  if (checks.length === 0) return null;
  if (!checks.every((check) => check.passed)) return null;
  return new AuthPreflightProof(true);
}
