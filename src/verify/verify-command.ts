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
  /**
   * Total bytes the command wrote across both streams, retained and discarded.
   *
   * The companion to {@link outputTruncated}, and the reason it is worth
   * carrying: since M6 a gate is no longer killed for exceeding the retention
   * budget, so "truncated" on its own leaves an operator unable to tell a run
   * that went slightly over from one that went 7.5x over. Zero where nothing
   * ran.
   */
  readonly outputBytesObserved: number;
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
    outputBytesObserved: 0,
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
  outputBytesObserved: 0,
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
      outputBytesObserved: result.stdoutBytesObserved + result.stderrBytesObserved,
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
    outputBytesObserved: result.stdoutBytesObserved + result.stderrBytesObserved,
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
      // **The only place in this build that asks for this** (M6).
      //
      // The budget above is unchanged and still enforced: past it the sink
      // retains nothing and reports the excerpt as truncated. What is switched
      // off here is the second effect the budget used to carry, killing the
      // command for being verbose -- which for a *gate* destroys the one thing
      // a gate exists to produce.
      //
      // Measured, in a real target repository rather than argued: Zera's
      // canonical `npm run verify` exits 0 and writes 62.8 MiB to stderr,
      // 7.5x this budget and almost all of it the test suite's own
      // `console.log`. Under the coupled policy AO terminated a passing gate
      // and recorded `OUTPUT_LIMIT_STDERR` -- an ending, not a verdict -- with
      // both excerpts empty, because what would have been recorded was exactly
      // what overflowed. Every retry produced the same ending, so no task in
      // that repository could reach `READY_FOR_PR`, and the closer a task came
      // to passing the less classifiable it became.
      //
      // What still bounds this call: the 30-minute timeout above, the job
      // object that owns the process tree, and the retention budget itself. A
      // failing gate still exits non-zero and is still `BLOCKED_VERIFY` --
      // truncation cannot turn a failure into a success, because the verdict is
      // the exit code and truncation does not touch it.
      terminateOnOutputLimit: false,
    });
  } catch (error) {
    // The one thrown condition `runCommand` documents. Translated into this
    // module's closed vocabulary so a caller never has to catch.
    if (error instanceof UnsafeArgumentError) return RESULT_REFUSED;
    throw error;
  }

  return toVerificationCommandResult(result);
};
