/**
 * The vocabulary both agent boundaries answer in.
 *
 * ── Two levels, deliberately ───────────────────────────────────────────────
 *
 * A failure **code** is a diagnosis: what went wrong, at the granularity a
 * human reading a report needs. A **disposition** is the much smaller question
 * the state machine can actually act on: which of the edges leaving
 * `IMPLEMENTING` / `REVIEWING` / `REMEDIATING` this run permits.
 *
 * They are separate because the mapping is many-to-one and lossy in one
 * direction only. `src/core/transitions.ts` offers no "the agent ran and
 * produced nothing usable" state — `BLOCKED_VERIFY` is reachable from
 * `VERIFYING` alone, and inventing a new state is a product-contract change,
 * not something a runner slice is entitled to do. So four different diagnoses
 * all lead to `HUMAN_DECISION_REQUIRED`, and the code is what preserves the
 * difference between them for the person who has to make that decision.
 *
 * ── The fail-closed default ────────────────────────────────────────────────
 *
 * {@link AGENT_NEEDS_ATTENTION} is where anything unrecognised lands, and that
 * is the whole point of the design. A run that cannot be positively classified
 * is *not* evidence of a quota limit, and it is not evidence of success; it is
 * evidence that we do not know. `HUMAN_DECISION_REQUIRED` strictly reduces
 * autonomy, which is the correct direction to fail in.
 */

import { redact } from '../auth/redaction.js';
import type { AgentId, ResumePhase } from '../core/states.js';
import type { ResumePoint } from '../core/resume-point.js';
import type { AgentCommandResult } from './agent-command.js';

/** What an agent run is diagnosed as. A closed set; never a message. */
export const AGENT_FAILURE_CODES = [
  /** An argument was not shell-inert, so no process was started at all. */
  'AGENT_ARGUMENT_REFUSED',
  /**
   * The process did not run to completion under its own control: it could not
   * be started, it was terminated, it exceeded its output budget, or its
   * termination could not be confirmed. Includes a truncated stream, which is
   * an infrastructure fact and never a partial answer.
   */
  'AGENT_PROCESS_UNAVAILABLE',
  /** The process ran and exited non-zero without any recognised signal. */
  'AGENT_NONZERO_EXIT',
  /**
   * The process ran, but what it printed is not the structured result this
   * boundary requires. Covers absent, unparseable, unrecognised and
   * shape-violating output alike — all of which mean the same thing: there is
   * no result here to act on.
   */
  'AGENT_RESULT_MALFORMED',
  /** Quota or session exhaustion, positively recognised. See `internal/usage-limit.ts`. */
  'AGENT_USAGE_LIMIT',
  /** An authentication or session rejection, positively recognised. */
  'AGENT_SESSION_REJECTED',
] as const;

export type AgentFailureCode = (typeof AGENT_FAILURE_CODES)[number];

/**
 * The edge a caller may take. Exactly four, because the transition table
 * offers exactly four answers to "an agent run just ended".
 *
 * V1-05 does not perform the move — that is the run driver's job, and
 * `READY_FOR_PR` in particular is a decision this slice must not make. It
 * names the edge so that the driver never has to re-derive it from a string.
 */
export const AGENT_DISPOSITIONS = [
  /** The run finished. What it *achieved* is the caller's question, not this one's. */
  'AGENT_COMPLETED',
  /** → `BLOCKED_USAGE_LIMIT`. */
  'AGENT_BLOCKED_USAGE_LIMIT',
  /** → `BLOCKED_AUTH`. */
  'AGENT_BLOCKED_AUTH',
  /** → `HUMAN_DECISION_REQUIRED`. The fail-closed default. */
  'AGENT_NEEDS_ATTENTION',
] as const;

export type AgentDisposition = (typeof AGENT_DISPOSITIONS)[number];

/**
 * Static sentences, one per code.
 *
 * A `Record` over the closed set, so adding a code without adding a sentence
 * does not compile. The text carries no path, no exit code, no CLI output and
 * no task text — it is a fixed explanation of a fixed condition, which is what
 * makes it safe to display anywhere.
 */
export const AGENT_FAILURE_TEXT: Readonly<Record<AgentFailureCode, string>> = Object.freeze({
  AGENT_ARGUMENT_REFUSED:
    'The agent was not started: an argument derived for this run was not shell-inert.',
  AGENT_PROCESS_UNAVAILABLE:
    'The agent process did not run to completion, so nothing it produced can be read as a result.',
  AGENT_NONZERO_EXIT: 'The agent ran and exited with a non-zero status.',
  AGENT_RESULT_MALFORMED:
    'The agent ran but did not produce the structured result this boundary requires.',
  AGENT_USAGE_LIMIT: 'The agent reported that its usage allowance is exhausted.',
  AGENT_SESSION_REJECTED: 'The agent reported that it is not authenticated for this run.',
});

/**
 * The one mapping from diagnosis to edge.
 *
 * Stated once, as a total `Record`, rather than re-derived at each call site:
 * a second copy would be free to disagree, and the disagreement would be a
 * task advancing on evidence that does not support it.
 */
export const AGENT_FAILURE_DISPOSITION: Readonly<Record<AgentFailureCode, AgentDisposition>> =
  Object.freeze({
    AGENT_USAGE_LIMIT: 'AGENT_BLOCKED_USAGE_LIMIT',
    AGENT_SESSION_REJECTED: 'AGENT_BLOCKED_AUTH',
    // The remaining four are genuinely different diagnoses that the state
    // machine cannot tell apart: there is no state for "the agent misbehaved".
    AGENT_ARGUMENT_REFUSED: 'AGENT_NEEDS_ATTENTION',
    AGENT_PROCESS_UNAVAILABLE: 'AGENT_NEEDS_ATTENTION',
    AGENT_NONZERO_EXIT: 'AGENT_NEEDS_ATTENTION',
    AGENT_RESULT_MALFORMED: 'AGENT_NEEDS_ATTENTION',
  });

/**
 * Closed process facts. Every value here comes from a vocabulary defined by
 * `doctor/exec.ts` or is a plain number — nothing is foreign text.
 */
export interface AgentProcessEvidence {
  readonly outcome: AgentCommandResult['outcome'];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly outputTruncated: boolean;
  readonly failureCode: AgentCommandResult['failureCode'];
  readonly errnoCode: string | null;
  readonly durationMs: number;
}

/**
 * The agent's own words, quarantined.
 *
 * Clamped and passed through the redactor, kept in memory for a human reading
 * a failure, and **never persisted**: `TaskStateObjectSchema` is `.strict()`,
 * so there is nowhere in the durable contract for it to go, and that is the
 * design rather than an obstacle. `trusted: false` is a field, not a comment,
 * so a caller that serialises this cannot claim it did not know.
 */
export interface AgentDiagnostics {
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
  readonly trusted: false;
}

/**
 * Exactly what `TaskState` needs to record a block, spelled the same way it is
 * spelled there so the caller copies rather than derives.
 */
export interface AgentBlockEvidence {
  readonly blockedAgent: AgentId;
  readonly resumeFrom: ResumePoint;
  /**
   * A reset time the CLI *reported*, or `null`.
   *
   * Never computed, never estimated, never `now + something`. A fabricated
   * value here does not merely mislead a report: `evaluateAutomaticResume`
   * grants an unattended resume the moment a reported reset time has passed,
   * so inventing one converts a governed block into an automatic retry on a
   * timer. `null` is the honest answer and costs only a human decision.
   */
  readonly reportedResetAt: string | null;
}

/** How much of a stream is worth keeping for a human. Bounded; never persisted. */
const DIAGNOSTIC_EXCERPT_LIMIT = 4_000;

/**
 * Clamps first, then redacts — deliberately the opposite order to
 * `redactAndClamp`, which redacts the whole string and slices afterwards.
 *
 * The reason is cost, and it is not marginal. An agent's stream budget here is
 * 8 MiB, against the few kilobytes a diagnostic probe emits, and running the
 * redaction rules over a multi-megabyte stream to then discard all but four
 * kilobytes of it was measured at roughly thirty seconds for a 200 KB input on
 * this machine. A failing agent run must not cost half a minute of CPU to
 * *describe*.
 *
 * The trade-off is stated rather than hidden: a secret straddling the cut
 * could be halved so that neither part matches a rule. That is acceptable
 * precisely here, because redaction in this repository is a safety net and not
 * a boundary — `auth/redaction.ts` says so itself — and nothing on this path is
 * persisted or reported. The property that keeps the excerpt safe is that it is
 * marked untrusted and never becomes an artefact, not that a pattern matched.
 */
function diagnosticExcerpt(text: string): string {
  if (text.length <= DIAGNOSTIC_EXCERPT_LIMIT) return redact(text);
  const kept = redact(text.slice(0, DIAGNOSTIC_EXCERPT_LIMIT));
  return `${kept}\n… [truncated, ${text.length - DIAGNOSTIC_EXCERPT_LIMIT} more characters]`;
}

export function agentDiagnostics(result: AgentCommandResult): AgentDiagnostics {
  return Object.freeze({
    stdoutExcerpt: diagnosticExcerpt(result.stdout),
    stderrExcerpt: diagnosticExcerpt(result.stderr),
    trusted: false as const,
  });
}

export function agentProcessEvidence(result: AgentCommandResult): AgentProcessEvidence {
  return Object.freeze({
    outcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    outputTruncated: result.outputTruncated,
    failureCode: result.failureCode,
    errnoCode: result.errnoCode,
    durationMs: result.durationMs,
  });
}

/**
 * `true` when the run is one whose output may be read at all.
 *
 * Three conditions, and every one of them has been a real defect somewhere:
 *
 *  - `outcome === 'RAN'` — the process ended under its own control. The seam
 *    already folds truncation into this.
 *  - `signal === null` — `runCommand` reports a child killed by something
 *    *outside* this process as a normal completion with a `null` exit code,
 *    because nothing here issued a termination. Reading the exit code alone
 *    would accept the partial output of a killed agent.
 *  - `exitCode === 0` — necessary, and on its own never sufficient. Every
 *    caller of this still has to positively recognise a structured result.
 */
export function ranCleanly(result: AgentCommandResult): boolean {
  return result.outcome === 'RAN' && result.signal === null && result.exitCode === 0;
}

/**
 * Accepts a reset timestamp only if it is one, and reports `null` otherwise.
 *
 * The gate exists because `TaskState.reportedResetAt` is validated as an
 * ISO-8601 instant *with an offset*, and a value that fails that validation
 * would be refused by `safeParseTaskState` at the moment the block is written —
 * which is to say, at the worst possible moment, after an agent run has
 * already been spent. Failing here instead costs nothing and loses nothing:
 * the timestamp is preferred evidence, never required.
 *
 * Deliberately narrow. It accepts a string that both parses as a finite
 * instant and carries an explicit offset; it does not coerce a number, does
 * not read `retry-after`-style durations, and does not fall back to a computed
 * value.
 */
export function recogniseReportedResetAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // The offset is not decoration: an instant without one is not a point in
  // time until someone guesses a zone, and guessing is how a block becomes an
  // early resume.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return value;
}

/**
 * The resume point for a run that was interrupted.
 *
 * The round is 1-based because `ResumePointSchema` requires it to be, while
 * `reviewRound` starts at 0 — a first pass interrupted before any review has
 * completed must resume at round 1, not at round 0, or the contract rejects
 * the state.
 */
export function interruptedResumePoint(phase: ResumePhase, round: number): ResumePoint {
  return Object.freeze({ phase, round: Math.max(1, round) });
}
