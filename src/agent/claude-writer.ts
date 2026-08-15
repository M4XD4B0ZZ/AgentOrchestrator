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
 *  1. nothing was spawned                  → `AGENT_ARGUMENT_REFUSED`
 *  2. the process never reached its own end → `AGENT_PROCESS_UNAVAILABLE`
 *  3. the envelope says quota exhausted    → `AGENT_USAGE_LIMIT`
 *  4. the exit code is non-zero            → `AGENT_NONZERO_EXIT`
 *  5. the envelope is not recognised       → `AGENT_RESULT_MALFORMED`
 *  6. the envelope positively says success → completed
 *
 * Step 2 subsumes truncation, which matters more than it looks: a stream cut
 * at its byte budget can still end on a closing brace and parse perfectly.
 * Parsing before checking would turn a cut-off transcript into a verdict.
 *
 * Step 2 also subsumes **termination by a signal**, and that is the whole of
 * V1-05-RR-F1. It used to be asked at step 4, below the envelope — so a child
 * SIGKILLed mid-sentence, which `runCommand` reports as an ordinary completion
 * because nothing here issued the termination, could still have its partial
 * bytes read as a quota refusal and park the task on `BLOCKED_USAGE_LIMIT`.
 * The invariant that closes it is unconditional: *a process terminated by a
 * signal is never classified from its own output* — not as a success, and not
 * as a usage limit.
 *
 * Step 3 sits above step 4 because a quota refusal is reported *with* a
 * non-zero exit; reading the exit code first would collapse every quota block
 * into an ordinary failure and lose the one outcome the run driver is supposed
 * to pause on. This is why step 2 asks `endedUnderOwnControl` and not
 * `ranCleanly`: the stronger predicate would swallow exactly those refusals.
 */

import { isComparablePath } from '../core/path-identity.js';
import type { ResumePhase } from '../core/states.js';
import { isShellInertArgument } from '../doctor/exec.js';
import type { AgentRunner } from './agent-command.js';
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
import { readClaudeResultEnvelope } from './internal/claude-result-envelope.js';

/**
 * The argument vector for a writing run. A frozen compile-time constant, in
 * the spirit of `doctor/capabilities.ts`'s probe table: there is no way to
 * hand this boundary a command or an extra flag, because a repository-supplied
 * argument is a repository-supplied piece of a command line.
 *
 * Every token below is bound to a measurement on CLI **2.1.233**, taken through
 * the production adapter against throwaway repositories. Reproduce them with
 * `npm run verify:writer-authority` before trusting any of this comment. **Do
 * not substitute a remembered flag for a measured one** — three of the four
 * decisions here contradict what the flag names suggest.
 *
 * `--print` is the non-interactive mode; `--output-format json` is what makes
 * the result a structured document rather than prose to be scraped. The prompt
 * is not here — it goes on stdin, because it could not be an argv token even
 * if we wanted it to be.
 *
 * ── `--permission-mode acceptEdits`, and why its absence was a defect ───────
 *
 * This comment used to record that `--permission-mode` was *deliberately*
 * absent, because choosing how much a writing agent may do without asking is a
 * policy decision with a blast radius beyond that slice, and defaulting it
 * silently is how such a decision gets made by accident. That reasoning is
 * correct, and it is exactly what indicts the silence: leaving the mode unset
 * did not defer the decision, it *made* it. Measured, and reproduced as the
 * first dogfood run's root cause — with no mode, **every write is denied**, the
 * seam still reports `RAN` / exit 0, the envelope still says
 * `subtype: "success"`, and the only trace is `permission_denials: [Write,
 * Bash]`. The product reported a delivered task and delivered nothing. So the
 * grant is explicit now, and the decision is recorded rather than defaulted.
 *
 * `acceptEdits` is cwd-confined on its own — measured: both the escape to a
 * sibling directory and the tamper of the main checkout were blocked, the
 * latter even for a read.
 *
 * **No settings file carrying authorisation rules.** Rule-scoped permissions
 * are only expressible through a settings file, and that route measured
 * treacherous: an *unqualified* `Write`/`Edit` allow-rule grants unbounded
 * write authority — the writer left the worktree and overwrote a tracked file
 * in the sibling main checkout — while `Write(**)`/`Edit(**)` happens to
 * restore containment. A semantics whose safe and unsafe spellings differ by
 * two characters is not one to build a security boundary on when a flag will do.
 *
 * ── The two flags refused, each for a measured reason ───────────────────────
 *
 * `--bare` is refused. It would be hermetic, and it would break authentication:
 * the installed binary's own help states its auth is strictly
 * `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`, with OAuth and the
 * keychain never read. AO runs on the subscription login that `auth:claude`
 * preflights.
 *
 * `--safe-mode` is refused as the hermeticity mechanism. Measured: it
 * suppressed user-scope configuration but the *project* `CLAUDE.md` still took
 * effect — contradicting its own help text, which lists `CLAUDE.md` among what
 * it disables. A flag whose documented and measured behaviour disagree is not a
 * boundary.
 *
 * ── `--strict-mcp-config` is load-bearing and non-obvious ───────────────────
 *
 * `--tools` does **not** bound MCP authority. Measured: with the tool list
 * below and no `--strict-mcp-config`, the writer held the *operator's* MCP
 * tools and attempted one (`permission_denials:
 * ["mcp__claude_ai_Gmail__list_labels"]`). With it, the tool set is exactly
 * `Edit, Glob, Grep, Read, Write` and MCP is absent. Removing this flag widens
 * authority to whatever the operator happens to have connected, which is not a
 * property of this repository at all.
 *
 * ── The tool list, and why it is last ───────────────────────────────────────
 *
 * `Read Edit Write Glob Grep` — enough to change files, and no shell. There is
 * no `Bash`, so the writer cannot commit, push or run anything: AO owns the
 * commit (see `commitTaskWork`), and the writer's authority stops at the file
 * contents. `--tools` is variadic, so it must come last or be followed by a
 * `-`-prefixed token; it comes last, and `tests/dogfood-rem-001.test.ts` pins
 * that by slicing the vector from `--tools` to its end.
 *
 * ── The cost of hermeticity, paid deliberately ─────────────────────────────
 *
 * `--setting-sources ''` (the empty string is shell-inert: `SAFE_ARG_PATTERN`
 * is `*`-quantified) suppresses the target repository's own `CLAUDE.md` along
 * with user-scope configuration. That is the point — the operator's machine
 * must not decide the writer's behaviour — but those conventions are often
 * genuinely useful. Where a repository wants them, the `CLAUDE.md` **path**
 * travels in the payload's `CONTEXT SOURCES` section and the writer `Read`s it.
 * The channel becomes explicit and AO-controlled instead of ambient. Paths
 * only, never contents.
 */
export const CLAUDE_WRITER_ARGS: readonly string[] = Object.freeze([
  '--print',
  '--output-format',
  'json',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--permission-mode',
  'acceptEdits',
  '--tools',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
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
  /**
   * The runner this call starts its process with. **Required, deliberately.**
   *
   * It was optional, defaulting to the raw command runner. That made the
   * unfenced spawn the *default* behaviour, so a new call site that simply
   * forgot the seam got a real subprocess with no authority behind it — which is
   * exactly the route an adversarial review took. A required argument turns that
   * mistake into a compile error instead of a silent one.
   */
  readonly agent: AgentRunner;
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
  options: ClaudeWriterOptions,
): Promise<ClaudeWriterResult> {
  const run = options.agent;

  const base = {
    agent: 'claude' as const,
    phase: request.phase,
    round: request.round,
  };

  // Checked here rather than left to the seam so the refusal is a diagnosis
  // about *this* run, and so nothing is spawned to find it out. The worktree
  // path is repository-derived: a checkout under a path containing a space is
  // a real condition, not a programming error.
  //
  // Absoluteness is checked alongside inertness, and the two are independent:
  // `SAFE_ARG_PATTERN` is a *character* allow-list, so `.` and `..` pass it
  // cleanly. A relative `cwd` reaches `spawn` verbatim and resolves against
  // `process.cwd()` — so the seam's promise never to fall back to the working
  // directory holds only for an absolute path, and a writing agent started in
  // the wrong tree writes to the wrong tree. The persisted `worktreePath` is
  // `NonBlankString` and this repository treats a state file as something
  // anything may have edited, so the guarantee has to be re-established here
  // rather than assumed from the producer (V1-05 followup NEW-2).
  if (!isComparablePath(request.worktreePath) || !isShellInertArgument(request.worktreePath)) {
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

  // Truncation is folded into the seam's `UNAVAILABLE`, and a signal is asked
  // about here rather than after the envelope, so this one check covers "never
  // started", "killed by this module", "killed from outside", "timed out" and
  // "cut off" alike — every way a process can fail to reach its own end.
  //
  // It stands above the parse deliberately: nothing below may read a byte the
  // process printed before this returns true.
  if (!endedUnderOwnControl(result)) return frozenFailure(evidence, 'AGENT_PROCESS_UNAVAILABLE');

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

  // Only the exit code is still open here: the guard above already established
  // that the process ended under its own control. `ranCleanly` is asked in full
  // rather than narrowed to `exitCode !== 0`, so that the two rules cannot drift
  // apart — this stays correct even if a third condition joins it.
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
