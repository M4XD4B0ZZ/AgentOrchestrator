/**
 * The execution seam for the two agent processes — the one place in V1-05 that
 * starts a Claude or a Codex run.
 *
 * ── Why this is not `doctor/exec.ts`, and not a second spawn ───────────────
 *
 * `doctor/exec.ts` opens by describing itself as execution *for diagnostics*,
 * and its callers are probes: short, argument-constant commands that ask a
 * question. An agent run is a different animal — minutes rather than seconds,
 * megabytes rather than kilobytes, and a payload of free-form instructions
 * that is not expressible as an argv token at all.
 *
 * None of that justifies a second spawn implementation. Bounded sinks, the
 * two-stage process-tree termination, the `.cmd` codec and the in-process PATH
 * resolver exist once, are audited once, and are hard to get right; a parallel
 * copy of them is precisely the outcome that module was written to prevent. So
 * this seam *wraps* `runCommand`, supplies budgets appropriate to an agent
 * run, and translates the one condition `runCommand` throws into this module's
 * closed vocabulary — exactly the shape `worktree/git-command.ts` established.
 *
 * ── The payload channel ────────────────────────────────────────────────────
 *
 * `SAFE_ARG_PATTERN` excludes spaces and quotes, so instructions cannot travel
 * as an argument, and they must not: an argv token is the one thing on this
 * path that a command processor ever looks at. They travel on **stdin**,
 * which is where both installed CLIs say they read them from, and which no
 * shell parses.
 *
 * Evidence baseline, captured on this machine while implementing:
 *
 *  - `codex exec --help` (codex-cli 0.146.0) — "Initial instructions for the
 *    agent. If not provided as an argument (or if `-` is used), instructions
 *    are read from stdin." A run started without a PROMPT argument printed
 *    `Reading additional input from stdin...` and consumed it.
 *  - `claude --help` (Claude Code 2.1.226) — "-p, --print  Print response and
 *    exit (useful for pipes)", with `--input-format text` (the default)
 *    documented as working only together with `--print`.
 *
 * ── What this seam does not do ─────────────────────────────────────────────
 *
 * It does not classify. It reports how a process ended, in the same closed
 * vocabulary for both agents, and hands the bytes on. Deciding what a run
 * *meant* — succeeded, hit a quota, produced findings — belongs to the writer
 * and reviewer boundaries, which own their own CLI's contract.
 */

import { createProbeEnv } from '../auth/env-guard.js';
import type { AgentId } from '../core/states.js';
import {
  runCommand,
  UnsafeArgumentError,
  type CommandFailureCode,
  type CommandResult,
} from '../doctor/exec.js';

/**
 * Wall-clock ceiling for one agent run.
 *
 * An agent is not a probe: thirty minutes is a hang guard for a process that
 * legitimately thinks for a long time, not a service-level expectation. It is
 * emphatically still a bound — an orchestrator that waits forever has no way
 * to report anything at all — and, as in `doctor/exec.ts`, hitting it is a
 * terminal fact about that run and never the start of a retry.
 */
export const AGENT_COMMAND_TIMEOUT_MS = 1_800_000;

/**
 * Per-stream byte budget for one agent run.
 *
 * Larger than the diagnostic default because `--json`/JSONL transcripts are
 * genuinely large, and still a hard ceiling. Exceeding it is reported, never
 * silently absorbed: a truncated stream is the one thing that must never be
 * parsed into a verdict.
 */
export const AGENT_COMMAND_MAX_OUTPUT_BYTES = 8_388_608;

/** How one agent run ended, in a closed vocabulary. Never a message. */
export type AgentCommandOutcome =
  /** The process ran to completion under its own control. `exitCode` is meaningful. */
  | 'RAN'
  /**
   * The process never started, was terminated by this module, flooded its
   * output budget, or could not be confirmed gone. Nothing it printed is
   * usable as evidence of anything.
   */
  | 'UNAVAILABLE'
  /**
   * An argument was not shell-inert, so nothing was spawned at all.
   *
   * Data rather than an exception for the reason `git-command.ts` gives: the
   * arguments here are derived from a repository-supplied worktree path, so an
   * unacceptable one is a runtime fact about the target repository — a
   * checkout under a path containing a space — and not the programming error
   * `UnsafeArgumentError` denotes inside `doctor/exec.ts`.
   */
  | 'REFUSED_UNSAFE_ARGUMENT';

/**
 * What one agent run produced.
 *
 * `stdout` and `stderr` are carried deliberately and are **untrusted**: they
 * are the agent's own words, they are the only place a structured result can
 * come from, and no classifier in this slice may treat any of it as authority
 * except through a positive, exact, structural match. They are never persisted.
 */
export interface AgentCommandResult {
  readonly outcome: AgentCommandOutcome;
  /** The exit code, or `null` when no process ran to completion. */
  readonly exitCode: number | null;
  /**
   * The signal that killed the child, when one did.
   *
   * Load-bearing, not decorative. `runCommand` reports `outcome: 'RAN'` for a
   * child killed by something *outside* this process — nothing here issued a
   * termination, so from this module's point of view the child simply ended —
   * and in that case `exitCode` is `null` and this is set. A success rule that
   * reads the exit code alone would accept a killed agent's partial output.
   */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Whether either stream hit its byte budget.
   *
   * One flag for both, because the consequence is identical and total: a
   * result assembled from a stream that was cut off is not a result.
   */
  readonly outputTruncated: boolean;
  readonly failureCode: CommandFailureCode | null;
  readonly errnoCode: string | null;
  readonly durationMs: number;
}

/**
 * Runs one agent process inside `cwd`, handing it `payload` on stdin.
 *
 * `cwd` must already be a canonical, existing directory: this seam does not
 * canonicalise and never falls back to `process.cwd()`. Production passes
 * {@link runAgentCommand}; a test passes its own function to drive an ending a
 * real CLI cannot be made to produce on demand — a quota refusal, a truncated
 * transcript, a process killed mid-sentence. The boundaries take a runner and
 * never reach for the real one implicitly, so nothing in this slice can start
 * a real agent by accident.
 */
export type AgentRunner = (
  agent: AgentId,
  args: readonly string[],
  cwd: string,
  payload: string,
) => Promise<AgentCommandResult>;

function unavailable(from: Partial<AgentCommandResult> = {}): AgentCommandResult {
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

const RESULT_REFUSED: AgentCommandResult = Object.freeze({
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
export function toAgentCommandResult(result: CommandResult): AgentCommandResult {
  const outputTruncated = result.stdoutTruncated || result.stderrTruncated;

  // Anything other than a process that ended under its own control is
  // UNAVAILABLE, and carries no output: a timed-out or budget-killed run has
  // said nothing this slice is entitled to read. Truncation is folded in here
  // rather than left for each caller to remember, because forgetting it is the
  // single cheapest way to turn a cut-off stream into a verdict.
  if (result.outcome !== 'COMPLETED' || outputTruncated) {
    return unavailable({
      exitCode: result.exitCode,
      signal: result.signal,
      outputTruncated,
      failureCode: result.failureCode,
      errnoCode: result.errnoCode,
      durationMs: result.durationMs,
    });
  }

  return Object.freeze({
    outcome: 'RAN' as const,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: false,
    failureCode: null,
    errnoCode: null,
    durationMs: result.durationMs,
  });
}

/** The production {@link AgentRunner}. */
export const runAgentCommand: AgentRunner = async (agent, args, cwd, payload) => {
  let result: CommandResult;
  try {
    result = await runCommand(agent, args, {
      env: createProbeEnv(agent === 'claude' ? 'agent:claude' : 'agent:codex', process.env),
      // Always explicit. `runCommand` falls back to `process.cwd()` when this
      // is absent, and the directory an agent writes in must come from the
      // task's recorded worktree, never from wherever the process happens to
      // have been started.
      cwd,
      timeoutMs: AGENT_COMMAND_TIMEOUT_MS,
      maxStdoutBytes: AGENT_COMMAND_MAX_OUTPUT_BYTES,
      maxStderrBytes: AGENT_COMMAND_MAX_OUTPUT_BYTES,
      stdin: payload,
    });
  } catch (error) {
    // The one thrown condition `runCommand` documents. Translated into this
    // module's closed vocabulary so a caller never has to catch.
    if (error instanceof UnsafeArgumentError) return RESULT_REFUSED;
    throw error;
  }

  return toAgentCommandResult(result);
};
