/**
 * Domain-specific error types for the orchestrator core.
 *
 * Every orchestrator error carries two texts:
 *
 *  - `message`     — the full developer-facing text. It may quote the offending
 *                    input, so it is only ever seen by a developer reading a
 *                    stack trace or a test assertion.
 *  - `safeMessage`  — a text built exclusively from the orchestrator's own
 *                    vocabulary. This is the only variant that may reach a
 *                    console, a diagnostics file or a report (AO-002).
 *
 * The distinction exists because untrusted CLI output and untrusted file
 * content routinely end up in exception messages, and a global error handler
 * that prints `error.message` would republish them verbatim.
 */

/** Marker for errors whose {@link OrchestratorError.safeMessage} may be shown. */
export const SAFE_MESSAGE = Symbol.for('agent-loop.safeMessage');

export class OrchestratorError extends Error {
  /** Text safe to display: no untrusted input is interpolated into it. */
  readonly safeMessage: string;
  readonly [SAFE_MESSAGE] = true;

  constructor(message: string, safeMessage?: string) {
    super(message);
    this.name = new.target.name;
    this.safeMessage = safeMessage ?? `${new.target.name}: an orchestrator invariant was violated.`;
  }
}

/** Thrown by `assertTransition` when a state transition is not in the table. */
export class IllegalTransitionError extends OrchestratorError {
  readonly from: string;
  readonly to: string;
  readonly allowed: readonly string[];

  constructor(from: string, to: string, allowed: readonly string[], reason: string) {
    const allowedText = allowed.length > 0 ? allowed.join(', ') : '<none: terminal state>';
    const text =
      `Illegal task-state transition ${from} -> ${to}: ${reason}. ` +
      `Allowed transitions from ${from}: ${allowedText}.`;
    // Both texts are built from the closed state vocabulary, so the full text
    // is also safe to display.
    super(text, text);
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

/**
 * Thrown when a resume point is structurally valid but semantically wrong.
 *
 * The developer-facing message quotes the rejected input, so the safe variant
 * deliberately says nothing about it.
 */
export class InvalidResumePointError extends OrchestratorError {
  constructor(message: string) {
    super(
      message,
      'A resume point could not be parsed, or it violates the resume-point contract.',
    );
  }
}
