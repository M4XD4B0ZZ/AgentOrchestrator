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
 *  3. the stream says quota exhausted      → `AGENT_USAGE_LIMIT`
 *  4. the exit code is non-zero            → `AGENT_NONZERO_EXIT`
 *  5. the stream is not recognised         → `AGENT_RESULT_MALFORMED`
 *  6. the stream positively says success   → completed
 *
 * Step 2 subsumes truncation, which matters more than it looks: a stream cut
 * at its byte budget can still end on a closing brace and parse perfectly.
 * Parsing before checking would turn a cut-off transcript into a verdict.
 * Since V3-11 the output is JSONL rather than one document, so this guard has
 * a sibling *inside* the reader — the terminal `result` message is the only
 * proof the stream reached its end — but the two are independent and neither
 * replaces the other: this one refuses to read the bytes at all, and it is the
 * only one of the two that also covers a stream cut in a place that happens to
 * leave a parseable prefix.
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
  type PermissionDenialObservation,
} from './agent-outcome.js';
import {
  diagnosticResultLine,
  readClaudeResultStream,
} from './internal/claude-result-stream.js';

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
 * The standing gate has since reproduced the split on **2.1.220** as well: the
 * writer edited inside its worktree, the escape to a sibling was blocked, no MCP
 * tool was reachable, and HEAD did not move — while the same gate's control,
 * driving the pre-fix vector, still produced an unchanged file and
 * `permission_denials: [Write]` under a `success` envelope. Two versions, the
 * same behaviour; the version numbers are recorded rather than merged, because
 * "measured somewhere" and "measured here" are different claims.
 *
 * `--print` is the non-interactive mode. The prompt is not here — it goes on
 * stdin, because it could not be an argv token even if we wanted it to be.
 *
 * ── `--output-format stream-json --verbose`, and what it bought (V3-11) ─────
 *
 * This was `--output-format json` until V3-11, and the change is the whole of
 * that slice. Both modes print a structured document rather than prose to be
 * scraped; the difference is that `json` prints **only** the terminal `result`
 * object, and that object carries no reset instant on either of its variants.
 * `stream-json` prints every message, including `rate_limit_event`, which is
 * where `resetsAt` lives. Under `json` the CLI builds that event, enqueues it
 * and never writes it — so `reportedResetAt` was `null` on every real quota
 * block and no quota pause could end without a human. That was L-V3-08-1.
 *
 * `--verbose` is not decorative and not a debugging aid: with `--print`, the
 * CLI **refuses** `--output-format stream-json` without it —
 * `Error: When using --print, --output-format=stream-json requires --verbose`.
 * It widens stdout to the whole transcript and, measured on 2.1.239, left
 * stderr empty. Removing it does not fall back to the old mode; it stops the
 * writer from starting at all.
 *
 * The cost is paid in `agent-command.ts`: stdout is now a transcript rather
 * than one object, so the byte budget had to be sized for one. See
 * `CLAUDE_WRITER_MAX_STDOUT_BYTES` — the writer's own constant, and only the
 * writer's. V3-11 raised a *shared* one and moved the Codex reviewer's
 * boundary with it, which the remediation undid.
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
/**
 * Everything before the tool list. Split out so the granted vector can be
 * composed without re-spelling it, and so {@link CLAUDE_WRITER_ARGS} keeps
 * being the literal thing the pins assert.
 */
const WRITER_HEAD: readonly string[] = Object.freeze([
  '--print',
  '--output-format',
  'stream-json',
  '--verbose',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--permission-mode',
  'acceptEdits',
]);

/**
 * The built-in tool list, and it stays last.
 *
 * `--tools` is variadic, so it must come last or be followed by a `-`-prefixed
 * token. Everything a capability grant adds is spliced in *before* it.
 */
const WRITER_TOOLS: readonly string[] = Object.freeze([
  '--tools',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
]);

/**
 * The vector when **no** capability is granted — the whole of what this build
 * shipped before M5, unchanged token for token.
 */
export const CLAUDE_WRITER_ARGS: readonly string[] = Object.freeze([
  ...WRITER_HEAD,
  ...WRITER_TOOLS,
]);

/**
 * What a resolved capability grant contributes to the writer's argv.
 *
 * Both members are AO-owned by construction: `mcpConfigPath` is a file this
 * process wrote from the operator's registry, and `allowedTools` are names that
 * registry already forced through {@link MCP_TOOL_NAME_PATTERN}. Neither can
 * originate in a repository — see `config/mcp-capability-registry.ts` for why
 * that is the whole safety argument.
 */
export interface WriterMcpGrant {
  /** Absolute path to the JSON this process wrote. Never a repository path. */
  readonly mcpConfigPath: string;
  /** The exact tool names the writer may call. Never a pattern, never a built-in. */
  readonly allowedTools: readonly string[];
}

/**
 * The writer's argv, with or without a granted MCP capability.
 *
 * ── Why `--allowedTools` and not `--tools` ─────────────────────────────────
 *
 * Measured, in four arms, against CLI 2.1.259 and the shipped head above:
 *
 * ```text
 * (shipped)                          mcp_servers []            call NO_TOOL
 * + --mcp-config                     codegraph connected       call DENIED
 * + --mcp-config, tool in --tools    codegraph connected       call DENIED
 * + --mcp-config, --allowedTools     codegraph connected       call OK
 * ```
 *
 * The third arm is the trap this comment exists for: naming the MCP tool in
 * `--tools` puts it in the session's `init.tools` list and the call is still
 * refused. A reader of the help text ("Specify the list of available tools")
 * or of the `init` message would have shipped that arm as working. Exposure is
 * not permission; `--allowedTools` is the permission.
 *
 * The fourth arm also wrote a real file, which is the control that matters for
 * the other direction: introducing an allow-list does **not** displace
 * `--permission-mode acceptEdits` for the built-in tools, so the grant costs
 * the writer none of its existing write authority.
 *
 * `--strict-mcp-config` stays in every arm. The operator of this machine has
 * four other MCP servers registered, and `init.mcp_servers` named only
 * `codegraph` in each arm that had a grant — so the grant adds exactly one
 * server rather than opening the door.
 *
 * The argument order below is the measured one, not a tidied one.
 */
export function claudeWriterArgs(grant: WriterMcpGrant | null): readonly string[] {
  if (grant === null) return CLAUDE_WRITER_ARGS;
  return Object.freeze([
    ...WRITER_HEAD,
    '--mcp-config',
    grant.mcpConfigPath,
    '--allowedTools',
    ...grant.allowedTools,
    ...WRITER_TOOLS,
  ]);
}

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
  /**
   * The MCP capability this invocation resolved, or `null` for none.
   *
   * Required and not optional, deliberately, for the reason
   * {@link ClaudeWriterOptions.agent} gives about the runner: a new call site
   * that simply forgets the field would otherwise get whichever authority the
   * default happened to be. Here the compiler makes the caller state which of
   * the two vectors it means.
   *
   * It is a resolved value carried in, never something read here — the same
   * arrangement `loop-step.ts` uses for the verification policy, and for the
   * same reason: what a writing agent is permitted to do is decided once, at
   * the top of the invocation, from the operator's registry, and cannot be
   * re-decided further down by anything a repository can influence.
   */
  readonly mcp: WriterMcpGrant | null;
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
  /**
   * What this run was refused, as the envelope reported it.
   *
   * On the completed member alone, and that is the point: a completed writer
   * that was denied `Write` is the shape the first dogfood run had, and it is
   * indistinguishable from a healthy pass by every other field here. A failed
   * run needs no such field — its diagnosis already says the run is unusable.
   *
   * Evidence, not a verdict (G6). Nothing in this module branches on it.
   */
  readonly permissionDenials: PermissionDenialObservation;
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

  // The vector is assembled here and then checked as a whole, rather than
  // trusted because its two halves were checked apart. `CLAUDE_WRITER_ARGS` is
  // a frozen literal and needs no check; a grant contributes a path this
  // process wrote and names the registry validated, and both still travel
  // through this boundary as argv. Re-establishing the property at the spawn
  // is the same rule the worktree path above is held to: a producer's promise
  // is not evidence at the point of use.
  const args = claudeWriterArgs(request.mcp);
  if (!args.every(isShellInertArgument)) {
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

  const result = await run('claude', args, request.worktreePath, request.payload);
  const process = agentProcessEvidence(result);
  // The excerpt is a redacted *prefix*, and since V3-11 the first four thousand
  // characters of stdout are the `init` message rather than anything about how
  // the run ended. So the terminal `result` line is excerpted where the stream
  // has one — which is what an operator saw before the migration — and the raw
  // stream where it does not.
  //
  // The fallback used to be justified as "the right answer for a cut stream:
  // there, the head *is* the evidence". That is **false** and the review
  // measured why: `toAgentCommandResult` folds `outputTruncated` into
  // `unavailable()`, which hard-codes `stdout: ''`, so a cut stream arrives here
  // with no bytes at all and gets an empty excerpt. The cases that really take
  // the fallback are *complete* streams with no terminator — reachable as
  // `AGENT_NONZERO_EXIT`, and equally as `AGENT_RESULT_MALFORMED` when a
  // trailing message follows the `result` on an exit-0 run — and for those the
  // head is the wrong end. Carried as L-V3-11-4.
  //
  // Diagnostics only: nothing below reads this, and the classification runs on
  // the whole stream either way.
  const diagnostics = agentDiagnostics({
    stdout: diagnosticResultLine(result.stdout) ?? result.stdout,
    stderr: result.stderr,
  });
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

  const envelope = readClaudeResultStream(result.stdout);

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

  return Object.freeze({
    ...evidence,
    ok: true as const,
    disposition: 'AGENT_COMPLETED' as const,
    permissionDenials: envelope.permissionDenials,
  });
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
