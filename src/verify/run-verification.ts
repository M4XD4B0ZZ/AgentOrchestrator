/**
 * Running a repository's declared verification phases, once, in order.
 *
 * ── What a verdict may be, and what it may never be ────────────────────────
 *
 * Three answers, and the separation between the last two is the reason this
 * module exists:
 *
 *  - `PASSED` — every declared phase ran to its own end and exited 0.
 *  - `FAILED` — a phase ran to its own end and said no. This is the repository
 *    answering the question it was asked, and it sends the task to
 *    `BLOCKED_VERIFY`.
 *  - `UNAVAILABLE` — a phase never reached a verdict: it could not be started,
 *    it timed out, it flooded its output budget, it was killed from outside, or
 *    its argv was refused. **Nothing was learned.** It sends the task to
 *    `HUMAN_DECISION_REQUIRED`, because "the build is broken" and "we could not
 *    run the build" are different sentences and an operator acting on the wrong
 *    one wastes their time on a repository that is fine.
 *
 * `PASSED` is a positive conjunction over phases that *ran*. It is never what a
 * missing phase list, a skipped phase or an unreadable ending degrades into —
 * an empty phase list is `UNAVAILABLE`, not a vacuous pass, even though
 * `VerificationPolicySchema` already makes one unrepresentable. A gate that can
 * be satisfied by the absence of evidence is not a gate.
 *
 * ── Ordering, and stopping ─────────────────────────────────────────────────
 *
 * Phases run in the order the profile declares them, and the run stops at the
 * first phase that does not pass. Declaration order is the profile's own
 * statement of dependency — `BUILD` before `TEST` before `VERIFY` in the
 * documented example — and running `TEST` after `BUILD` failed would measure a
 * tree that was never built. There is no parallelism and no reordering: a
 * verification result must be reproducible by a human typing the same commands.
 *
 * ── No retries, ever ───────────────────────────────────────────────────────
 *
 * One process per phase, one result. A flaky suite that passes on the second
 * attempt has not passed; it has told us something we are not entitled to
 * average away, and `AGENT_COMMAND_TIMEOUT_MS`'s comment makes the same point
 * for agents. A caller that wants another attempt makes another call, having
 * decided to.
 */

import { agentDiagnostics, type AgentDiagnostics } from '../agent/agent-outcome.js';
import { isComparablePath } from '../core/path-identity.js';
import { isShellInertArgument } from '../doctor/exec.js';
import type { ResolvedVerificationPolicy } from '../repo/resolve-repository.js';
import { type VerificationCommandOutcome, type VerificationCommandResult, type VerificationRunner } from './verify-command.js';

/** The three answers a verification run may produce. Never a message. */
export type VerificationVerdict = 'PASSED' | 'FAILED' | 'UNAVAILABLE';

/** The declared phase names, as the repository profile spells them. */
export type VerificationPhaseName = ResolvedVerificationPolicy['phases'][number]['phase'];

/** What one phase did. Closed facts only — no repository text. */
export interface VerificationPhaseReport {
  readonly phase: VerificationPhaseName;
  readonly outcome: VerificationCommandOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
}

export interface VerificationReport {
  readonly verdict: VerificationVerdict;
  /** One entry per phase actually run, in order. Stops at the first non-pass. */
  readonly phases: readonly VerificationPhaseReport[];
  /** The phase that failed or could not be run, or `null` on `PASSED`. */
  readonly stoppedAt: VerificationPhaseName | null;
  /**
   * The failing phase's own output, bounded and redacted, or empty on `PASSED`.
   *
   * Carried for a human reading a blocked task and **never persisted**:
   * `TaskStateObjectSchema` is `.strict()` and has no field for it, which is the
   * design rather than an obstacle. `trusted: false` is a field, not a comment.
   */
  readonly diagnostics: AgentDiagnostics;
}

export interface VerificationRequest {
  /** The directory the commands run in — the task's recorded worktree. */
  readonly worktreePath: string;
  /** The repository's resolved verification policy. Never the raw profile. */
  readonly verification: ResolvedVerificationPolicy;
}

export interface VerificationOptions {
  /**
   * The runner this call starts its process with. **Required, deliberately.**
   *
   * It was optional, defaulting to the raw command runner. That made the
   * unfenced spawn the *default* behaviour, so a new call site that simply
   * forgot the seam got a real subprocess with no authority behind it — which is
   * exactly the route an adversarial review took. A required argument turns that
   * mistake into a compile error instead of a silent one.
   */
  readonly verify: VerificationRunner;
}

const NO_DIAGNOSTICS: AgentDiagnostics = Object.freeze({
  stdoutExcerpt: '',
  stderrExcerpt: '',
  trusted: false as const,
});

function phaseReport(
  phase: VerificationPhaseName,
  result: VerificationCommandResult,
): VerificationPhaseReport {
  return Object.freeze({
    phase,
    outcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    outputTruncated: result.outputTruncated,
    durationMs: result.durationMs,
  });
}

/**
 * Runs every declared phase in order, stopping at the first that does not pass.
 */
export async function runVerification(
  request: VerificationRequest,
  options: VerificationOptions,
): Promise<VerificationReport> {
  const run = options.verify;
  const declared = request.verification.phases;

  // Unrepresentable through the schema, and still not treated as a pass. See
  // the module note: a gate satisfied by the absence of evidence is not a gate.
  if (declared.length === 0) {
    return Object.freeze({
      verdict: 'UNAVAILABLE' as const,
      phases: Object.freeze([]) as readonly VerificationPhaseReport[],
      stoppedAt: null,
      diagnostics: NO_DIAGNOSTICS,
    });
  }

  const reports: VerificationPhaseReport[] = [];

  for (const declaredPhase of declared) {
    const [program, ...args] = declaredPhase.command;

    // Checked here rather than left to the seam so that nothing is spawned to
    // find it out, and so the refusal names the phase. The profile schema
    // already guarantees every token is shell-inert; the worktree path is
    // repository-derived and does not carry that guarantee, and `runCommand`
    // checks only `args`, never the program name.
    //
    // The path must additionally be *absolute*: a relative `cwd` reaches
    // `spawn` verbatim and resolves against `process.cwd()`, which would run a
    // repository's own build and test commands in whatever tree this process
    // happens to sit in — including this orchestrator's own checkout
    // (V1-05 followup NEW-2).
    if (
      program === undefined ||
      !isShellInertArgument(program) ||
      !args.every(isShellInertArgument) ||
      !isComparablePath(request.worktreePath) ||
      !isShellInertArgument(request.worktreePath)
    ) {
      reports.push(
        phaseReport(declaredPhase.phase, {
          outcome: 'REFUSED_UNSAFE_ARGUMENT',
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          outputTruncated: false,
          failureCode: null,
          errnoCode: null,
          durationMs: 0,
        }),
      );
      return Object.freeze({
        verdict: 'UNAVAILABLE' as const,
        phases: Object.freeze(reports),
        stoppedAt: declaredPhase.phase,
        diagnostics: NO_DIAGNOSTICS,
      });
    }

    const result = await run(program, args, request.worktreePath);
    reports.push(phaseReport(declaredPhase.phase, result));

    // The process never reached its own end: no verdict was produced, and its
    // bytes are the middle of one rather than an answer.
    if (result.outcome !== 'RAN') {
      return Object.freeze({
        verdict: 'UNAVAILABLE' as const,
        phases: Object.freeze(reports),
        stoppedAt: declaredPhase.phase,
        diagnostics: agentDiagnostics(result),
      });
    }

    // It ran and said no. That is the repository answering, and it is the one
    // outcome whose output a human genuinely needs to read.
    if (result.exitCode !== 0) {
      return Object.freeze({
        verdict: 'FAILED' as const,
        phases: Object.freeze(reports),
        stoppedAt: declaredPhase.phase,
        diagnostics: agentDiagnostics(result),
      });
    }
  }

  return Object.freeze({
    verdict: 'PASSED' as const,
    phases: Object.freeze(reports),
    stoppedAt: null,
    diagnostics: NO_DIAGNOSTICS,
  });
}
