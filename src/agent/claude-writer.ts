/**
 * The Claude writer boundary — the governed way to run the writing agent.
 *
 * ── What it decides, and what it refuses to decide ─────────────────────────
 *
 * It decides how a run *ended*: completed, out of quota, unauthenticated, or
 * unclassifiable. It does not decide what the task should do next. Nothing
 * here loads, writes or advances a `TaskState`; the caller holds the state it
 * read and performs the move, because a runner that both produced a result and
 * acted on it would be its own reviewer.
 *
 * That split is why the result carries `disposition` (the legal edge),
 * `block` (exactly the fields `TaskState` needs to record one) and `process`
 * (closed facts about how the process ended) as separate members. A caller
 * copies; it never re-derives.
 *
 * ── The order of classification is the contract ────────────────────────────
 *
 * Each step below can only ever reach a *worse* answer than the one after it,
 * and the order is what stops a later step from rescuing an earlier failure:
 *
 *  1. nothing was spawned                → `AGENT_ARGUMENT_REFUSED`
 *  2. the process did not run cleanly    → `AGENT_PROCESS_UNAVAILABLE`
 *  3. the envelope says quota exhausted  → `AGENT_USAGE_LIMIT`
 *  4. the exit code is non-zero          → `AGENT_NONZERO_EXIT`
 *  5. the envelope is not recognised     → `AGENT_RESULT_MALFORMED`
 *  6. the envelope positively says success → completed
 *
 * Step 2 subsumes truncation, which matters more than it looks: a stream cut
 * at its byte budget can still end on a closing brace and parse perfectly.
 * Parsing before checking would turn a cut-off transcript into a verdict.
 *
 * Step 3 sits above step 4 because a quota refusal is reported *with* a
 * non-zero exit; reading the exit code first would collapse every quota block
 * into an ordinary failure and lose the one outcome the run driver is supposed
 * to pause on.
 */

import type { ResumePhase } from '../core/states.js';
import { isShellInertArgument } from '../doctor/exec.js';
import { runAgentCommand, type AgentRunner } from './agent-command.js';
import {
  agentDiagnostics,
  agentProcessEvidence,
  AGENT_FAILURE_DISPOSITION,
  AGENT_FAILURE_TEXT,
  interruptedResumePoint,
  ranCleanly,
  type AgentBlockEvidence,
  type AgentDiagnostics,
  type AgentDisposition,
  type AgentFailureCode,
  type AgentProcessEvidence,
} from './agent-outcome.js';
import { readClaudeResultEnvelope } from './internal/claude-result-envelope.js';

/**
 * The argument vector for a writing run. A frozen compile-time constant, in
 * the spirit of `doctor/capabilities.ts`'s probe table: there is no way to
 * hand this boundary a command or an extra flag, because a repository-supplied
 * argument is a repository-supplied piece of a command line.
 *
 * `--print` is the non-interactive mode; `--output-format json` is what makes
 * the result a structured document rather than prose to be scraped. The prompt
 * is not here — it goes on stdin, because it could not be an argv token even
 * if we wanted it to be.
 *
 * `--permission-mode` is deliberately absent. Choosing how much a writing
 * agent may do without asking is a policy decision with a blast radius far
 * beyond this slice, and defaulting it silently is how such a decision gets
 * made by accident.
 */
export const CLAUDE_WRITER_ARGS: readonly string[] = Object.freeze([
  '--print',
  '--output-format',
  'json',
]);

/** What a caller must supply to run the writer once. */
export interface ClaudeWriterRequest {
  /**
   * The directory the agent works in. Must be the task's recorded worktree
   * path, canonical and absolute — this boundary passes it straight to the
   * seam, which never falls back to `process.cwd()`.
   */
  readonly worktreePath: string;
  /**
   * Which phase this run is. `IMPLEMENT` and `REMEDIATE` are the two the
   * writer serves, and they are the two whose states have an edge to
   * `BLOCKED_USAGE_LIMIT`; typing it this narrowly is what stops an
   * interrupted run from recording a resume point the contract would reject.
   */
  readonly phase: Extract<ResumePhase, 'IMPLEMENT' | 'REMEDIATE'>;
  /** The review round this run belongs to. */
  readonly round: number;
  /** The instructions, delivered on stdin. Never an argument. */
  readonly payload: string;
}

export interface ClaudeWriterOptions {
  /** The execution seam. Defaults to the real one; tests pass their own. */
  readonly agent?: AgentRunner;
}

interface ClaudeWriterOutcomeBase {
  readonly agent: 'claude';
  readonly phase: ResumePhase;
  readonly round: number;
  readonly process: AgentProcessEvidence;
  readonly diagnostics: AgentDiagnostics;
}

export interface ClaudeWriterCompleted extends ClaudeWriterOutcomeBase {
  readonly ok: true;
  readonly disposition: 'AGENT_COMPLETED';
}

export interface ClaudeWriterFailed extends ClaudeWriterOutcomeBase {
  readonly ok: false;
  readonly code: AgentFailureCode;
  readonly disposition: Exclude<AgentDisposition, 'AGENT_COMPLETED'>;
  /** A static sentence from {@link AGENT_FAILURE_TEXT}. Never CLI text. */
  readonly detail: string;
  /**
   * Present only for the two blocking dispositions, `null` otherwise.
   *
   * On one member rather than both so that a caller cannot read block
   * evidence off a run that was not blocked: the narrowing is the guard.
   */
  readonly block: AgentBlockEvidence | null;
}

export type ClaudeWriterResult = ClaudeWriterCompleted | ClaudeWriterFailed;

/**
 * Runs the writer once.
 *
 * Never throws for an expected condition, never retries, and never waits: one
 * process, one result. A caller that wants another attempt makes another call,
 * having decided to.
 */
export async function runClaudeWriter(
  request: ClaudeWriterRequest,
  options: ClaudeWriterOptions = {},
): Promise<ClaudeWriterResult> {
  const run = options.agent ?? runAgentCommand;

  const base = {
    agent: 'claude' as const,
    phase: request.phase,
    round: request.round,
  };

  // Checked here rather than left to the seam so the refusal is a diagnosis
  // about *this* run, and so nothing is spawned to find it out. The worktree
  // path is repository-derived: a checkout under a path containing a space is
  // a real condition, not a programming error.
  if (!isShellInertArgument(request.worktreePath)) {
    return failed(base, 'AGENT_ARGUMENT_REFUSED', {
      outcome: 'REFUSED_UNSAFE_ARGUMENT',
      exitCode: null,
      signal: null,
      outputTruncated: false,
      failureCode: null,
      errnoCode: null,
      durationMs: 0,
    });
  }

  const result = await run('claude', CLAUDE_WRITER_ARGS, request.worktreePath, request.payload);
  const process = agentProcessEvidence(result);
  const diagnostics = agentDiagnostics(result);
  const evidence = { ...base, process, diagnostics };

  if (result.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return frozenFailure(evidence, 'AGENT_ARGUMENT_REFUSED');
  }

  // Truncation is folded into the seam's `UNAVAILABLE`, so this one check
  // covers "never started", "killed", "timed out" and "cut off" alike.
  if (result.outcome !== 'RAN') return frozenFailure(evidence, 'AGENT_PROCESS_UNAVAILABLE');

  const envelope = readClaudeResultEnvelope(result.stdout);

  // Above the exit-code check on purpose: a quota refusal exits non-zero, and
  // reading the code first would bury it as an ordinary failure.
  if (envelope.verdict === 'USAGE_LIMIT') {
    return frozenFailure(evidence, 'AGENT_USAGE_LIMIT', {
      blockedAgent: 'claude' as const,
      resumeFrom: interruptedResumePoint(request.phase, request.round),
      reportedResetAt: envelope.reportedResetAt,
    });
  }

  // A child killed from outside is reported by `runCommand` as a normal
  // completion with a null exit code, so this asks about the signal too.
  if (!ranCleanly(result)) {
    return frozenFailure(
      evidence,
      result.exitCode === null ? 'AGENT_PROCESS_UNAVAILABLE' : 'AGENT_NONZERO_EXIT',
    );
  }

  if (envelope.verdict !== 'COMPLETED') return frozenFailure(evidence, 'AGENT_RESULT_MALFORMED');

  return Object.freeze({ ...evidence, ok: true as const, disposition: 'AGENT_COMPLETED' as const });
}

function frozenFailure(
  evidence: ClaudeWriterOutcomeBase,
  code: AgentFailureCode,
  block: AgentBlockEvidence | null = null,
): ClaudeWriterFailed {
  return Object.freeze({
    ...evidence,
    ok: false as const,
    code,
    disposition: AGENT_FAILURE_DISPOSITION[code] as Exclude<AgentDisposition, 'AGENT_COMPLETED'>,
    detail: AGENT_FAILURE_TEXT[code],
    block: block === null ? null : Object.freeze(block),
  });
}

function failed(
  base: { readonly agent: 'claude'; readonly phase: ResumePhase; readonly round: number },
  code: AgentFailureCode,
  process: AgentProcessEvidence,
): ClaudeWriterFailed {
  return frozenFailure(
    {
      ...base,
      process: Object.freeze(process),
      diagnostics: Object.freeze({ stdoutExcerpt: '', stderrExcerpt: '', trusted: false as const }),
    },
    code,
  );
}
