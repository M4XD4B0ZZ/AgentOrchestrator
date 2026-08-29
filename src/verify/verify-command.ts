/**
 * The execution seam for a repository's own verification commands — the one
 * place in V1-06 that starts a project process.
 *
 * ── Why this is neither the agent seam nor the Git seam ────────────────────
 *
 * `agent/agent-command.ts` and `worktree/git-command.ts` both wrap
 * `doctor/exec.ts` rather than re-implementing a spawn, and this module is the
 * third instance of that same shape for the same reasons: the bounded sinks,
 * the two-stage process-tree termination, the `.cmd` codec and the in-process
 * PATH resolver exist once, are audited once, and a parallel copy of them is
 * precisely what those modules were written to prevent.
 *
 * What differs is the meaning of what comes back, and it differs in one
 * decisive way. For an agent, **the output is the result**: a stream cut off at
 * its byte budget can still end on a closing brace and parse perfectly, so
 * `agent-command.ts` folds truncation into `UNAVAILABLE`. For verification, the
 * **exit code** is the result and the output is only diagnostics. A test suite
 * that failed and printed four megabytes doing so still failed, and discarding
 * that verdict would convert a real failure into "we learned nothing" — the
 * fail-*open* direction, since `VERIFICATION_FAILED` stops the loop while an
 * infrastructure failure is what a human is asked about.
 *
 * The converse divergence is from `git-command.ts`, which discards stdout on a
 * non-zero exit. Here the output of a failing run is exactly the evidence a
 * human needs, so it is kept — bounded, and never persisted raw.
 *
 * ── What this seam does not do ─────────────────────────────────────────────
 *
 * It does not classify a phase, sequence phases, or decide a state. It reports
 * how one process ended, in a closed vocabulary. `run-verification.ts` decides
 * what a sequence of those endings means.
 */

import { createProbeEnv } from '../auth/env-guard.js';
import {
  runCommand,
  UnsafeArgumentError,
  type CommandFailureCode,
  type CommandResult,
} from '../doctor/exec.js';

/**
 * Wall-clock ceiling for one verification command.
 *
 * Sized like an agent run rather than like a probe: a cold `npm run verify` on
 * Windows genuinely takes minutes, and a build is not a question with a fast
 * answer. It is emphatically still a bound — and, as everywhere else in this
 * repository, hitting it is a terminal fact about that run and never the start
 * of a retry.
 */
export const VERIFICATION_COMMAND_TIMEOUT_MS = 1_800_000;

/**
 * Per-stream byte budget for one verification command.
 *
 * Test runners are verbose, and the budget is what stops a runaway one from
 * deciding how much memory this process uses. Exceeding it terminates the run,
 * which `runCommand` reports as `OUTPUT_LIMIT_EXCEEDED` — an ending, not a
 * verdict.
 */
export const VERIFICATION_COMMAND_MAX_OUTPUT_BYTES = 8_388_608;

/** How one verification command ended, in a closed vocabulary. Never a message. */
export type VerificationCommandOutcome =
  /** The process ran to completion under its own control. `exitCode` is meaningful. */
  | 'RAN'
  /**
   * The process never started, was terminated, flooded its output budget, or
   * was killed by something outside this process. It reached no verdict, so
   * nothing it printed is evidence of one.
   */
  | 'UNAVAILABLE'
  /** An argument was not shell-inert, so nothing was spawned at all. */
  | 'REFUSED_UNSAFE_ARGUMENT';

/**
 * What one verification command produced.
 *
 * `stdout` and `stderr` are the project's own output. They are untrusted text —
 * a repository's test runner may print anything at all, including a secret it
 * read — so they are redacted before they are shown, and **the raw text is
 * never persisted anywhere by this build**. `TaskStateObjectSchema` is
 * `.strict()` and has no field for them, and neither has the verification-attempt
 * record V4 added: that store's schema accepts only an excerpt that has already
 * been through `agentDiagnostics()` and then through line-safety, so there is no
 * route by which these two strings reach a file.
 */
export interface VerificationCommandResult {
  readonly outcome: VerificationCommandOutcome;
  /** The exit code, or `null` when no process ran to completion. */
  readonly exitCode: number | null;
  /**
   * The signal that killed the process, when one did.
   *
   * Load-bearing for the same reason as in `agent-command.ts` (V1-05-RR-F1):
   * `runCommand` reports a child killed by something *outside* this process as
   * an ordinary completion, because nothing here issued the termination. A rule
   * that read the exit code alone would read a killed run as a verdict.
   */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Whether either stream hit its byte budget. Diagnostic only — see the module note. */
  readonly outputTruncated: boolean;
  readonly failureCode: CommandFailureCode | null;
  readonly errnoCode: string | null;
  readonly durationMs: number;
}

/**
 * Runs one verification command inside `cwd`.
 *
 * `cwd` must already be a canonical, absolute, existing directory: this seam
 * does not canonicalise and never falls back to `process.cwd()`. Production
 * passes {@link runVerificationCommand}; a test passes its own function to
 * drive an ending a real command cannot be made to produce on demand.
 */
export type VerificationRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<VerificationCommandResult>;

function unavailable(from: Partial<VerificationCommandResult> = {}): VerificationCommandResult {
  return Object.freeze({
    outcome: 'UNAVAILABLE' as const,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    failureCode: null,
    errnoCode: null,
    durationMs: 0,
    ...from,
  });
}

const RESULT_REFUSED: VerificationCommandResult = Object.freeze({
  outcome: 'REFUSED_UNSAFE_ARGUMENT' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});

/** Translates one `CommandResult` into this seam's vocabulary. Exported for tests. */
export function toVerificationCommandResult(result: CommandResult): VerificationCommandResult {
  // Two conditions, and both must hold before the exit code means anything:
  // the process reached its own end, and nothing terminated it. The second is
  // the one that is easy to forget and expensive to get wrong — see `signal`.
  const endedUnderOwnControl = result.outcome === 'COMPLETED' && result.signal === null;

  if (!endedUnderOwnControl) {
    return unavailable({
      exitCode: result.exitCode,
      signal: result.signal,
      outputTruncated: result.stdoutTruncated || result.stderrTruncated,
      failureCode: result.failureCode,
      errnoCode: result.errnoCode,
      durationMs: result.durationMs,
    });
  }

  return Object.freeze({
    outcome: 'RAN' as const,
    exitCode: result.exitCode,
    signal: null,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.stdoutTruncated || result.stderrTruncated,
    failureCode: null,
    errnoCode: null,
    durationMs: result.durationMs,
  });
}

/**
 * The production {@link VerificationRunner}.
 *
 * The environment policy is `capability:generic` — `PATH` and `PATHEXT` and
 * nothing else. That is the same policy `worktree/git-command.ts` uses to
 * *mutate* a repository, so it is well precedented for a process that only has
 * to be startable; a verification command that needed a credential to run would
 * be a repository asking this orchestrator to leak one.
 */
export const runVerificationCommand: VerificationRunner = async (command, args, cwd) => {
  let result: CommandResult;
  try {
    result = await runCommand(command, args, {
      env: createProbeEnv('capability:generic', process.env),
      // Always explicit. `runCommand` falls back to `process.cwd()` when this is
      // absent, and the directory a repository's own commands run in must come
      // from the task's recorded worktree, never from wherever this process
      // happens to have been started.
      cwd,
      timeoutMs: VERIFICATION_COMMAND_TIMEOUT_MS,
      maxStdoutBytes: VERIFICATION_COMMAND_MAX_OUTPUT_BYTES,
      maxStderrBytes: VERIFICATION_COMMAND_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    // The one thrown condition `runCommand` documents. Translated into this
    // module's closed vocabulary so a caller never has to catch.
    if (error instanceof UnsafeArgumentError) return RESULT_REFUSED;
    throw error;
  }

  return toVerificationCommandResult(result);
};
