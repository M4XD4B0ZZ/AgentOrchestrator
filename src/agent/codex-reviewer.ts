/**
 * The Codex reviewer boundary — the governed way to run the reviewing agent.
 *
 * ── Findings are not failures ──────────────────────────────────────────────
 *
 * The distinction this module exists to enforce is between "the reviewer did
 * its job and reported problems" and "the reviewer did not do its job". Those
 * are opposite facts that a naive implementation collapses into one non-zero
 * exit code, and collapsing them is how a broken reviewer comes to look like a
 * clean review, or a clean review like a broken reviewer.
 *
 * So they live on different members of the result union. `findings` exists
 * only on {@link CodexReviewCompleted}; a caller cannot read it without first
 * narrowing on `ok === true`. There is no `findings: []` on the failure
 * member, because an empty list there would be indistinguishable from a review
 * that genuinely found nothing — which is exactly the confusion.
 *
 * ── PASS is never inferred ─────────────────────────────────────────────────
 *
 * None of these is a pass, and each has its own test: an empty stdout, a zero
 * exit code on its own, a missing review document, a document that fails to
 * parse, a truncated transcript, a transcript without a completed turn, a
 * document whose verdict and finding list disagree. A pass is one thing only —
 * a positively validated document that said so.
 *
 * ── What this slice does not decide ────────────────────────────────────────
 *
 * Whether findings mean `REMEDIATING` or whether their absence means
 * `READY_FOR_PR` is not answered here. `READY_FOR_PR` is terminal and its
 * contract demands settled commits and a clean worktree that no reviewer can
 * attest to; choosing it is the run driver's decision on evidence wider than
 * one review. This boundary reports what the review said and stops.
 */

import { isComparablePath } from '../core/path-identity.js';
import type { ResumePhase } from '../core/states.js';
import { isShellInertArgument } from '../doctor/exec.js';
import { runAgentCommand, type AgentRunner } from './agent-command.js';
import {
  agentDiagnostics,
  agentProcessEvidence,
  AGENT_FAILURE_DISPOSITION,
  AGENT_FAILURE_TEXT,
  endedUnderOwnControl,
  interruptedResumePoint,
  ranCleanly,
  type AgentBlockEvidence,
  type AgentDiagnostics,
  type AgentDisposition,
  type AgentFailureCode,
  type AgentProcessEvidence,
} from './agent-outcome.js';
import { readCodexTranscript, type ReviewFinding } from './internal/codex-review-transcript.js';

export type { ReviewFinding } from './internal/codex-review-transcript.js';

/**
 * The argument vector for a reviewing run. Frozen and complete.
 *
 * `exec` is the non-interactive subcommand and `--json` makes its transcript a
 * stream of events rather than prose. `--sandbox read-only` is the load-bearing
 * one: the reviewer is contractually read-only, and `transitions.ts` makes
 * `REVIEWING → SCOPE_VIOLATION` a legal edge precisely because a reviewer that
 * writes has broken its contract. Asking the CLI to enforce that itself is
 * cheaper and more reliable than detecting the breach afterwards.
 *
 * The prompt is absent, so the CLI reads it from stdin — the documented
 * behaviour at the observed version, and the only channel available.
 */
export const CODEX_REVIEWER_ARGS: readonly string[] = Object.freeze([
  'exec',
  '--json',
  '--sandbox',
  'read-only',
]);

export interface CodexReviewRequest {
  /** The worktree to review, canonical and absolute. Passed straight to the seam. */
  readonly worktreePath: string;
  /** The review round this run performs. */
  readonly round: number;
  /** The review instructions, delivered on stdin. */
  readonly payload: string;
}

export interface CodexReviewOptions {
  readonly agent?: AgentRunner;
}

interface CodexReviewOutcomeBase {
  readonly agent: 'codex';
  readonly phase: ResumePhase;
  readonly round: number;
  readonly process: AgentProcessEvidence;
  readonly diagnostics: AgentDiagnostics;
}

export interface CodexReviewCompleted extends CodexReviewOutcomeBase {
  readonly ok: true;
  readonly disposition: 'AGENT_COMPLETED';
  /** Positively parsed. Empty means the review found nothing, and only that. */
  readonly findings: readonly ReviewFinding[];
}

export interface CodexReviewFailed extends CodexReviewOutcomeBase {
  readonly ok: false;
  readonly code: AgentFailureCode;
  readonly disposition: Exclude<AgentDisposition, 'AGENT_COMPLETED'>;
  readonly detail: string;
  readonly block: AgentBlockEvidence | null;
}

export type CodexReviewResult = CodexReviewCompleted | CodexReviewFailed;

/**
 * Runs the reviewer once.
 *
 * The classification order matches the writer's, for the same reasons, with
 * one difference worth stating: no usage-limit signal has been observed from
 * this CLI, so there is no recognised quota verdict to check for. A Codex run
 * that fails because its allowance is exhausted therefore lands in
 * `AGENT_NEEDS_ATTENTION` — a human decision — rather than in a pause. That is
 * a deliberate consequence of having no evidence, not an oversight: guessing a
 * usage limit from an unrecognised failure would be the exact fabrication this
 * slice refuses everywhere else.
 */
export async function runCodexReviewer(
  request: CodexReviewRequest,
  options: CodexReviewOptions = {},
): Promise<CodexReviewResult> {
  const run = options.agent ?? runAgentCommand;

  const base = {
    agent: 'codex' as const,
    phase: 'REVIEW' as const,
    round: request.round,
  };

  // Absolute *and* shell-inert. See the equivalent guard in `claude-writer.ts`:
  // a relative `cwd` resolves against `process.cwd()` at `spawn`, which would
  // point the reviewer at whatever tree this process happens to sit in
  // (V1-05 followup NEW-2).
  if (!isComparablePath(request.worktreePath) || !isShellInertArgument(request.worktreePath)) {
    return Object.freeze({
      ...base,
      process: Object.freeze({
        outcome: 'REFUSED_UNSAFE_ARGUMENT' as const,
        exitCode: null,
        signal: null,
        outputTruncated: false,
        failureCode: null,
        errnoCode: null,
        durationMs: 0,
      }),
      diagnostics: Object.freeze({ stdoutExcerpt: '', stderrExcerpt: '', trusted: false as const }),
      ok: false as const,
      code: 'AGENT_ARGUMENT_REFUSED' as const,
      disposition: AGENT_FAILURE_DISPOSITION['AGENT_ARGUMENT_REFUSED'] as Exclude<
        AgentDisposition,
        'AGENT_COMPLETED'
      >,
      detail: AGENT_FAILURE_TEXT['AGENT_ARGUMENT_REFUSED'],
      block: null,
    });
  }

  const result = await run('codex', CODEX_REVIEWER_ARGS, request.worktreePath, request.payload);
  const evidence: CodexReviewOutcomeBase = {
    ...base,
    process: agentProcessEvidence(result),
    diagnostics: agentDiagnostics(result),
  };

  if (result.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return reviewFailure(evidence, 'AGENT_ARGUMENT_REFUSED');
  }
  // Same shape as the writer's, and for the same reason (V1-05-RR-F1/F3): a
  // process that did not reach its own end — including one killed from outside,
  // which arrives here as an ordinary completion — is never classified from the
  // bytes it managed to print, and is never labelled a "non-zero exit" when its
  // exit status was zero or absent.
  if (!endedUnderOwnControl(result)) return reviewFailure(evidence, 'AGENT_PROCESS_UNAVAILABLE');

  if (!ranCleanly(result)) {
    return reviewFailure(
      evidence,
      result.exitCode === null ? 'AGENT_PROCESS_UNAVAILABLE' : 'AGENT_NONZERO_EXIT',
    );
  }

  const transcript = readCodexTranscript(result.stdout);
  if (transcript.verdict !== 'REVIEWED') return reviewFailure(evidence, 'AGENT_RESULT_MALFORMED');

  return Object.freeze({
    ...evidence,
    ok: true as const,
    disposition: 'AGENT_COMPLETED' as const,
    findings: transcript.findings,
  });
}

function reviewFailure(
  evidence: CodexReviewOutcomeBase,
  code: AgentFailureCode,
  block: AgentBlockEvidence | null = null,
): CodexReviewFailed {
  return Object.freeze({
    ...evidence,
    ok: false as const,
    code,
    disposition: AGENT_FAILURE_DISPOSITION[code] as Exclude<AgentDisposition, 'AGENT_COMPLETED'>,
    detail: AGENT_FAILURE_TEXT[code],
    block: block === null ? null : Object.freeze(block),
  });
}

/**
 * The resume point a Codex review would record if it were interrupted.
 *
 * Exported because the run driver records the block, not this module, and it
 * must not have to know that `reviewRound` is 0-based while a resume round is
 * 1-based. Kept here so the two boundaries answer that question identically.
 */
export function codexReviewResumePoint(round: number): AgentBlockEvidence {
  return Object.freeze({
    blockedAgent: 'codex' as const,
    resumeFrom: interruptedResumePoint('REVIEW', round),
    reportedResetAt: null,
  });
}
