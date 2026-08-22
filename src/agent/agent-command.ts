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
import type { ContainmentAttestation } from '../core/containment-attestation.js';
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
 * Byte budget for the **Claude writer's** stdout, and for nothing else.
 *
 * Exceeding it is reported, never silently absorbed: a truncated stream is the
 * one thing that must never be parsed into a verdict.
 *
 * ── Why 64 MiB, and why it is the writer's alone ───────────────────────────
 *
 * Since V3-11 the writer runs `--output-format stream-json --verbose`, so its
 * stdout carries the whole transcript: every assistant message, and every tool
 * result. A `Read` of a large source file is a couple of hundred kilobytes of
 * that transcript, and a pass that reads several dozen files is an ordinary
 * pass. The pre-V3-11 ceiling stopped being a hang guard and became a limit
 * real work could reach — and reaching it is `UNAVAILABLE`, which is
 * `AGENT_PROCESS_UNAVAILABLE`, which is a human decision on a run that had
 * actually succeeded.
 *
 * 64 MiB is a headroom decision rather than a measurement, and it is recorded
 * as one: the transcript size of a real writing pass has not been measured on
 * this machine, only its lower bound (4741 bytes for a one-word answer).
 *
 * ── The memory arithmetic, corrected ───────────────────────────────────────
 *
 * This paragraph used to read "`BoundedSink` retains at most this many bytes,
 * concatenates them once and decodes once, so the transient peak is on the
 * order of three times this figure", and offered that as "the arithmetic that
 * bounds the cost". It bounds the *seam* only, and the reader above it is not
 * free: `readStreamObjects` retains every parsed object for the duration of the
 * classification, and `diagnosticResultLine` splits the same stream a second
 * time. Measured on Node v24.18.1 with a 64 MiB transcript, sampling
 * `maxRSS` rather than post-hoc `heapUsed`: **~290 MiB** peak for a one-byte
 * decode and **~372 MiB** when any character forces two bytes — 4.5x to 5.8x
 * this figure, not 3x.
 *
 * What did **not** reproduce is the consequence the finding attached to it: the
 * whole pipeline completed at a 576 MiB heap limit with ~1.6x headroom, so the
 * heap-abort story is unproven. The defect is that a wrong number was presented
 * as the basis for choosing the figure and for sizing any future raise.
 *
 * L-V3-11-2's deferral is also narrower than it was written. It says a
 * streaming reader "changes `doctor/exec.ts`'s sink contract and the
 * diagnostics excerpt"; that is true of the *sink* half and false of the
 * *retention* half — the sibling `internal/codex-review-transcript.ts` already
 * streams the same JSONL keeping only what it needs, retaining nothing and
 * touching no seam.
 *
 * ── The sentence this replaces was false, and the falsehood had a cost ─────
 *
 * V3-11 justified the raise with "8 MiB was sized against the writer's old
 * `--output-format json`, which prints exactly one `result` object — a few
 * kilobytes". The pre-V3-11 source says otherwise, verbatim
 * (`5dc386b:src/agent/agent-command.ts`):
 *
 *   > Per-stream byte budget for one agent run.
 *   > Larger than the diagnostic default because `--json`/JSONL transcripts
 *   > are genuinely large, and still a hard ceiling.
 *
 * `--json`/JSONL is **Codex**. The 8 MiB was sized for the reviewer's
 * transcript, not for the writer's one-object envelope, and the same doc block
 * kept saying so two lines above the sentence that denied it. Because one
 * constant fed both agents, raising it for the writer silently raised the
 * reviewer's reading window eightfold — and that moved a control boundary: a
 * `codex exec --json` transcript between 8 and 64 MiB used to be `UNAVAILABLE`
 * → `AGENT_PROCESS_UNAVAILABLE` → a human read the review, and afterwards it
 * was read in full and could advance a task toward `READY_FOR_PR` unattended.
 * An autonomy increase inherited from a renamed constant is exactly the kind
 * this repository requires to be argued. It was not argued, so it is undone:
 * see {@link CODEX_REVIEWER_MAX_STDOUT_BYTES}.
 *
 * The failure mode is unchanged and is still fail-closed. A run that floods
 * this budget is killed and reported unusable; it is never a partial result.
 */
export const CLAUDE_WRITER_MAX_STDOUT_BYTES = 67_108_864;

/**
 * Byte budget for the **Codex reviewer's** stdout, at the pre-V3-11 figure.
 *
 * Deliberately not raised with the writer's. The reviewer's verdict is a
 * control on whether work advances without a human, so the size of transcript
 * it will read is an autonomy boundary and moves only on purpose. A review
 * whose transcript exceeds this is `OUTPUT_LIMIT_EXCEEDED` → `UNAVAILABLE` →
 * `AGENT_PROCESS_UNAVAILABLE` → a human decision, which is the answer this
 * repository wants for a review too large to have been read.
 *
 * That an exceptionally large review then needs a person is the price of the
 * boundary, not a defect in it.
 */
export const CODEX_REVIEWER_MAX_STDOUT_BYTES = 8_388_608;

/**
 * The stdout budget for one agent, by which agent it is.
 *
 * A function rather than a shared constant, because the shared constant is the
 * defect: it made "the writer needs more room" and "the reviewer may read more
 * before a human must" the same sentence, and only one of them was ever
 * argued.
 */
export function maxStdoutBytesFor(agent: AgentId): number {
  return agent === 'claude' ? CLAUDE_WRITER_MAX_STDOUT_BYTES : CODEX_REVIEWER_MAX_STDOUT_BYTES;
}

/**
 * Byte budget for one agent run's **stderr**, kept at the pre-V3-11 figure.
 *
 * Split from stdout rather than raised with it because the two carry different
 * things. Neither installed CLI's *result* travels on stderr — Codex writes
 * routine diagnostics there on runs that succeed, and Claude wrote nothing
 * there at all when measured — so a larger budget would buy nothing except a
 * larger buffer for text no classifier is allowed to read as a verdict.
 */
export const AGENT_COMMAND_MAX_STDERR_BYTES = 8_388_608;

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
  /**
   * Proof that this agent's process was created inside a job this process owns,
   * or absent.
   *
   * Carried on `UNAVAILABLE` results as well as on `RAN` ones, and that is not
   * an oversight. Everything else on this shape is about what the run *said*,
   * and an unusable run says nothing — but containment is about what the run
   * *was*: a timed-out agent whose tree the boundary took down was contained,
   * and the record built from it is true. Withholding it on the unavailable
   * branch would drop the evidence for exactly the runs whose owner is most
   * likely to be about to die.
   *
   * Opaque and unconstructable outside its mint, so a substituted
   * {@link AgentRunner} cannot fabricate one. It is not authority — see
   * `lease/containment-evidence.ts`.
   */
  readonly containment?: ContainmentAttestation;
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
  // A payload was configured and this process could not be sure it handed it
  // over. Folded in beside truncation because it is the same kind of fact — the
  // *channel* failed, not the process — and has the same consequence: the run
  // answered a different question than the one that was asked, so its output is
  // not evidence about this task (V1-05-RR-F5).
  //
  // `UNCONFIRMED` counts too. The alternative is to read the output of a run we
  // cannot say received its instructions, which is the fail-open direction.
  const payloadDelivered =
    result.stdinDelivery === 'NOT_REQUESTED' || result.stdinDelivery === 'DELIVERED';

  // Anything other than a process that ended under its own control is
  // UNAVAILABLE, and carries no output: a timed-out or budget-killed run has
  // said nothing this slice is entitled to read. Truncation is folded in here
  // rather than left for each caller to remember, because forgetting it is the
  // single cheapest way to turn a cut-off stream into a verdict.
  // Absent stays absent: the spread carries the field only when there is one,
  // so neither branch below can invent an `undefined` that looks like a decision.
  const contained = result.containment === undefined ? {} : { containment: result.containment };

  if (result.outcome !== 'COMPLETED' || outputTruncated || !payloadDelivered) {
    return unavailable({
      ...contained,
      exitCode: result.exitCode,
      signal: result.signal,
      outputTruncated,
      failureCode: result.failureCode,
      errnoCode: result.errnoCode,
      durationMs: result.durationMs,
    });
  }

  return Object.freeze({
    ...contained,
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
      // By agent, not shared. See {@link maxStdoutBytesFor}.
      maxStdoutBytes: maxStdoutBytesFor(agent),
      maxStderrBytes: AGENT_COMMAND_MAX_STDERR_BYTES,
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
