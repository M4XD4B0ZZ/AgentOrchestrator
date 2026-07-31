/** Domain-specific error types for the orchestrator core. */

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
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
    );
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

/** Thrown when a resume point is structurally valid but semantically wrong. */
export class InvalidResumePointError extends OrchestratorError {}
