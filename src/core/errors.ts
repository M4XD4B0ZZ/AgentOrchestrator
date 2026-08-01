/**
 * The closed domain-error hierarchy of the orchestrator.
 *
 * Every error the orchestrator raises on purpose is an instance of
 * {@link OrchestratorError} and carries two things:
 *
 *  - `message`        — the full developer-facing text. It may quote the
 *                       offending input, so it is only ever seen by a developer
 *                       reading a stack trace or a test assertion. It is never
 *                       displayed, persisted or reported.
 *  - `domainErrorId`  — a value from the closed set {@link DOMAIN_ERROR_IDS}.
 *                       It is the *only* thing an error contributes to user
 *                       facing output: `src/core/safe-error.ts` maps it through
 *                       a static table to a sentence written in this repository.
 *
 * ── Why there is no `safeMessage` any more (AO-002-R2-RR1) ─────────────────
 *
 * The previous design carried a per-error `safeMessage` string and recognised
 * "our" errors by an `instanceof` check *or* a `Symbol.for('agent-loop.…')`
 * marker property. Both halves were forgeable:
 *
 *  - `Symbol.for` keys are global by definition. Any object anywhere in the
 *    process could set that exact symbol on itself and be accepted as an
 *    internal error;
 *  - once accepted, its `safeMessage` — an arbitrary string it chose — was
 *    printed verbatim.
 *
 * So a foreign object could pick the text the CLI displayed. Recognition is now
 * `instanceof` and nothing else, and the displayed text comes from a static
 * table keyed by a closed id, never from the error object. A duplicate copy of
 * this package therefore fails closed to `UNEXPECTED_ERROR`, which is the
 * intended trade: an unrecognised internal error is a cosmetic loss, an
 * attacker-chosen error text is not.
 */

/**
 * The closed set of internal error identities.
 *
 * Adding a member here is a deliberate act: it also requires a sentence in
 * `DOMAIN_ERROR_TEXT` (`src/core/safe-error.ts`), and the type system enforces
 * that the table stays exhaustive.
 */
export const DOMAIN_ERROR_IDS = [
  'ORCHESTRATOR_INVARIANT_VIOLATED',
  'ILLEGAL_TRANSITION',
  'INVALID_RESUME_POINT',
  'TRUSTED_PROFILE_UNAVAILABLE',
] as const;

export type DomainErrorId = (typeof DOMAIN_ERROR_IDS)[number];

const DOMAIN_ERROR_ID_SET: ReadonlySet<string> = new Set<string>(DOMAIN_ERROR_IDS);

/** `true` only for a member of the closed set. Never a shape test. */
export function isDomainErrorId(value: unknown): value is DomainErrorId {
  return typeof value === 'string' && DOMAIN_ERROR_ID_SET.has(value);
}

/**
 * Base class of every intentional orchestrator error.
 *
 * The id is captured into a private field at construction time, so a later
 * write to a public `domainErrorId` property cannot change what the formatter
 * resolves — and a foreign object cannot acquire the private field at all.
 */
export class OrchestratorError extends Error {
  readonly #domainErrorId: DomainErrorId;

  constructor(message: string, domainErrorId: DomainErrorId = 'ORCHESTRATOR_INVARIANT_VIOLATED') {
    super(message);
    this.name = new.target.name;
    // Fail closed: an id outside the closed set degrades to the base identity
    // rather than being carried through to the formatter.
    this.#domainErrorId = isDomainErrorId(domainErrorId)
      ? domainErrorId
      : 'ORCHESTRATOR_INVARIANT_VIOLATED';
  }

  /** The closed identity of this error. Read-only, and not settable. */
  get domainErrorId(): DomainErrorId {
    return this.#domainErrorId;
  }
}

/** Thrown by `assertTransition` when a state transition is not in the table. */
export class IllegalTransitionError extends OrchestratorError {
  readonly from: string;
  readonly to: string;
  readonly allowed: readonly string[];

  constructor(from: string, to: string, allowed: readonly string[], reason: string) {
    const allowedText = allowed.length > 0 ? allowed.join(', ') : '<none: terminal state>';
    super(
      `Illegal task-state transition ${from} -> ${to}: ${reason}. ` +
        `Allowed transitions from ${from}: ${allowedText}.`,
      'ILLEGAL_TRANSITION',
    );
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

/** Thrown when a resume point is structurally valid but semantically wrong. */
export class InvalidResumePointError extends OrchestratorError {
  constructor(message: string) {
    super(message, 'INVALID_RESUME_POINT');
  }
}

/**
 * Thrown when the trusted OS user profile directory could not be established.
 *
 * There is no environment fallback: without a trustworthy profile path there is
 * no trustworthy write root, so path resolution fails (AO-007-R1-RR1).
 */
export class TrustedProfileUnavailableError extends OrchestratorError {
  constructor(message: string) {
    super(message, 'TRUSTED_PROFILE_UNAVAILABLE');
  }
}
