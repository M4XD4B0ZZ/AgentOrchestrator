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
  /** Quota exhaustion, positively recognised. See `internal/claude-result-stream.ts`. */
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
 * Clamped and passed through the redactor, and kept in memory for a human
 * reading a failure. `trusted: false` is a field, not a comment, so a caller
 * that serialises this cannot claim it did not know.
 *
 * **No agent's diagnostics are persisted, and `TaskState` holds none at all.**
 * `TaskStateObjectSchema` is `.strict()`, so there is nowhere in the task's own
 * durable contract for an excerpt to go, and that is still the design.
 *
 * The sentence used to be "never persisted", full stop, and V4's
 * verification-attempt evidence made that half false rather than false: the
 * *verification* seam's excerpt is now the input to
 * `verify/verification-attempt.ts`, which stores a line-safe transformation of
 * it in its own record — outside `TaskState`, under the repository root, with
 * its own byte budget and its own bounded history. No claude/codex boundary has
 * such a store, and this type is still not a persistable shape: that record has
 * no `trusted` field, holds its excerpt as an array of lines, and reconstitutes
 * this type on read rather than parsing one off the disk.
 */
export interface AgentDiagnostics {
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
  readonly trusted: false;
}

/**
 * What authority the agent reached for and was refused.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * The first dogfood run reported a delivered task and delivered nothing. The
 * evidence was in the envelope the whole time: `subtype: "success"`,
 * `is_error: false`, exit 0 — and `permission_denials: [Write, Bash]`. Nothing
 * read that field, so a writer with no authority to write looked exactly like a
 * writer that had nothing left to do.
 *
 * ── Evidence, never a verdict (G6) ─────────────────────────────────────────
 *
 * A denial does **not** make a run a failure, and this observation must never
 * be turned into one. An agent may legitimately reach for a tool it does not
 * need, be refused, and finish the work by another route; treating that as a
 * failure would park healthy tasks. What decides whether a pass really did
 * something is the measured delta, not this. This field's job is to make the
 * refusal *visible to an operator*, which is the thing that was missing.
 *
 * ── The two numbers say different things, deliberately ─────────────────────
 *
 * `count` is how many denials the envelope reported — every entry, including
 * one whose shape this reader does not recognise. `tools` is the distinct tool
 * names it could actually read, in the order they first appeared. They differ
 * exactly when the CLI reports a denial in an unfamiliar shape, and the split
 * is the fail-loud direction: an unreadable entry still raises the count rather
 * than disappearing. Under-reporting is the failure mode this whole observation
 * exists to remove, so it is the one that must not be reintroduced by a
 * permissive parse.
 *
 * Nothing else from an entry is carried. `tool_input` holds file paths and
 * command lines — foreign free text — and this is reported to an operator.
 */
export interface PermissionDenialObservation {
  /** How many denials the envelope reported, readable or not. */
  readonly count: number;
  /** The distinct tool names that could be read, in first-appearance order. */
  readonly tools: readonly string[];
}

/** No denials, and the value for "nothing was asked". */
export const NO_PERMISSION_DENIALS: PermissionDenialObservation = Object.freeze({
  count: 0,
  tools: Object.freeze([]),
});

/**
 * Two observations as one, for a run that made several writing passes.
 *
 * **Aggregating, never last-writer-wins.** Round 1 denied and round 2 clean
 * must still report round 1: the operator is being told what authority the
 * writer reached for *during this run*, and a second pass that happened not to
 * need the tool is not evidence that the first pass had it. Counts add; names
 * are unioned in first-appearance order, so a tool refused in three rounds is
 * named once and counted three times.
 */
export function mergePermissionDenials(
  left: PermissionDenialObservation,
  right: PermissionDenialObservation,
): PermissionDenialObservation {
  if (right.count === 0 && right.tools.length === 0) return left;
  const tools = [...left.tools];
  for (const tool of right.tools) if (!tools.includes(tool)) tools.push(tool);
  return Object.freeze({ count: left.count + right.count, tools: Object.freeze(tools) });
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

/**
 * The hard ceiling on one diagnostic excerpt, in characters.
 *
 * A **total**, not a body size: the notice saying where the cut fell is counted
 * inside it. Exported because it is the contract — a bound stated only in a
 * private constant is a bound no caller and no test can check, and the version
 * of this that measured only the pre-redaction text was how V1-05-RR-F6 came
 * about.
 */
export const DIAGNOSTIC_EXCERPT_LIMIT = 4_000;

/**
 * Raw characters redacted *beyond* the budget and then thrown away.
 *
 * This margin is the whole mechanism. Redacting exactly as much text as the
 * excerpt may contain puts the cut inside the redactor's field of view, and a
 * secret lying across that cut loses the suffix its rule anchors on — a TLD, an
 * `{8,}` token body — so the surviving prefix matches nothing and is emitted in
 * the clear. Redacting a wider window and then discarding its tail means any
 * entity within the margin is seen whole, or not at all.
 *
 * "And then thrown away" is the load-bearing half, and the half V1-05-RR-F6 /
 * NEW-1 found was not actually true: the margin was discarded only when
 * redaction left enough text behind for the final clamp to reach it. Redaction
 * *shrinks* — a JWT collapses from thousands of characters to fourteen — and a
 * window that shrinks below the budget is returned entire, margin and all,
 * with the raw cut as its last character. {@link redactedPrefix} is what makes
 * the margin unconditionally unreachable.
 */
export const REDACTION_OVERLAP = 1_024;

/**
 * Says that the excerpt is not the whole thing, and how big the thing was.
 *
 * Fixed shape, bounded length, and no arithmetic a reader has to trust: the raw
 * total is a fact, whereas "how much was dropped" stops being one once
 * redaction has rewritten what was kept.
 *
 * **Read the wording carefully, because it is narrower than it looks.** The
 * number is `text.length` for whatever `text` this function was handed, and
 * since V3-11 the writer hands it the terminal `result` *line*, not stdout. So
 * "in the original stream" is a fact about the substring on that path. Measured
 * on a 1,166,705-character stream whose result line was 9,138: the operator is
 * told 9,138. That is not corrected here — the honest fix is to pass the real
 * total alongside the excerpted text, which changes this function's signature
 * and every caller — and it is carried as **L-V3-11-11**. Nothing in `src/`
 * renders `stdoutExcerpt` today, so no operator reads either number yet.
 */
function truncationNotice(totalLength: number): string {
  return `\n… [truncated; ${totalLength} characters in the original stream]`;
}

/**
 * The agent's own words, bounded and redacted, in that order of guarantees.
 *
 * ── Two properties, and neither may be traded for the other ────────────────
 *
 * **Cost is bounded.** The redaction rules never see more than
 * `DIAGNOSTIC_EXCERPT_LIMIT + REDACTION_OVERLAP` characters, whatever the
 * stream contains. That matters against a 64 MiB stdout budget — the figure was
 * 8 MiB when this paragraph was written and the stale number understated the
 * hazard it exists to bound by eight times: running the
 * rules over a multi-megabyte stream to then discard all but four thousand
 * characters was
 * measured at roughly thirty seconds for a 200 KB input on this machine, and a
 * failing agent run must not cost half a minute of CPU to *describe*. This is
 * why `redactAndClamp` is not used here.
 *
 * **The size bound holds after redaction, not before it.** Redaction expands:
 * `a@b.co` (6 characters) becomes `<redacted:email>` (16), so a clamp applied
 * only to the raw text bounds nothing. An e-mail-dense stream measured 9 745
 * characters against a 4 000-character budget before V1-05-RR-F6 — 2.4× — and
 * that is the number the ceiling exists to prevent. The clamp is therefore
 * applied last, to the redacted text, with the notice counted inside it.
 *
 * Slicing *redacted* text is safe in a way slicing raw text is not: the worst a
 * cut can bisect is a `<redacted:…>` marker, which carries nothing. The one
 * remaining exposure — an entity straddling the far edge of the raw window —
 * is removed by {@link redactedPrefix}, which never returns text that reaches
 * that edge.
 */
function diagnosticExcerpt(text: string): string {
  const overflowed = text.length > DIAGNOSTIC_EXCERPT_LIMIT;
  const redacted = redactedPrefix(text);

  // The common case by far: a short stream that redaction did not push over the
  // ceiling. Returned whole, with no notice, because nothing was left out.
  if (!overflowed && redacted.length <= DIAGNOSTIC_EXCERPT_LIMIT) return redacted;

  const notice = truncationNotice(text.length);
  const body = redacted.slice(0, Math.max(0, DIAGNOSTIC_EXCERPT_LIMIT - notice.length));
  return `${withoutTrailingPartialRun(body)}${notice}`;
}

/**
 * Redacted text the raw cut cannot have altered.
 *
 * A stream shorter than the window was never cut, so its redaction is trusted
 * end to end. Anything longer was cut at `LIMIT + OVERLAP`, and that cut can
 * amputate the suffix a rule anchors on: `m4xd4b0zz@googlemail.com` becomes
 * `m4xd4b0zz@googlemail.`, matches nothing without its TLD, and is emitted in
 * the clear. So the answer must be the redaction of the first
 * `DIAGNOSTIC_EXCERPT_LIMIT` characters — the margin exists to be discarded —
 * except that *that* cut has exactly the same defect one kilobyte earlier.
 *
 * Redacting both and keeping the prefix on which they agree resolves it
 * without a character-offset map. The rules use no lookaround and no
 * backreferences, so the two runs can only differ from the first entity whose
 * treatment the extra kilobyte changed — a credential bisected at `LIMIT` that
 * the wider window sees whole. Everything before that point was produced twice,
 * from two different amounts of input, and is therefore not an artefact of
 * either cut. It is deliberately the *wider* run that is sliced: where the two
 * disagree it is the better-informed one, and it never contributes text beyond
 * the agreement.
 *
 * The margin is now unreachable by construction rather than by arithmetic, so
 * shrinkage cannot drag it back into view. What this costs is the margin's
 * worth of diagnostics in exactly the streams where redaction shrank — text
 * that was never safe to show. Cost stays bounded: two passes over at most
 * `LIMIT + OVERLAP` characters, both fixed-size whatever the stream contains.
 */
function redactedPrefix(text: string): string {
  const window = DIAGNOSTIC_EXCERPT_LIMIT + REDACTION_OVERLAP;
  if (text.length <= window) return redact(text);

  const wide = redact(text.slice(0, window));
  const narrow = redact(text.slice(0, DIAGNOSTIC_EXCERPT_LIMIT));
  return wide.slice(0, agreedLength(wide, narrow));
}

/** How far two strings are the same string. */
function agreedLength(a: string, b: string): number {
  const bound = Math.min(a.length, b.length);
  let index = 0;
  while (index < bound && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

/**
 * Drops a trailing run of non-whitespace characters, so the excerpt never ends
 * in the middle of one.
 *
 * The redaction rules that match a credential — e-mail, UUID, `sk-`/`pk-`
 * token, JWT — all match whitespace-free runs, so a fragment of one can only
 * ever be at the very end of the clamped text. Cutting back to the last
 * whitespace removes it.
 *
 * The backward scan is bounded by {@link REDACTION_OVERLAP}: an unbroken run
 * longer than the margin is left alone, because eating it would empty the
 * excerpt of a stream that legitimately has no whitespace in it at all —
 * minified output is the ordinary case, not a pathological one.
 *
 * That bound is why this is no longer the boundary guarantee. It is stated on
 * the length of the *run*, while the reasoning behind it — no credential these
 * rules recognise approaches a kilobyte — is about the length of the
 * *credential*, and V1-05-RR-F6 / NEW-1 is precisely where the two diverge: an
 * ordinary 24-character e-mail inside a 3 000-character minified run. The cut
 * that could produce such a fragment is now closed in {@link redactedPrefix},
 * upstream of this; what remains here is tidiness — an excerpt that does not
 * end mid-word — with the tail of a bisected marker as its worst case.
 */
function withoutTrailingPartialRun(body: string): string {
  const floor = body.length - REDACTION_OVERLAP;
  for (let index = body.length - 1; index >= 0 && index >= floor; index -= 1) {
    if (/\s/.test(body.charAt(index))) return body.slice(0, index);
  }
  return body;
}

/**
 * The two streams this excerpting needs, and deliberately nothing else.
 *
 * Stated structurally rather than as `AgentCommandResult` because the property
 * being provided — bounded, redacted, clamped-after-redaction, with the raw cut
 * held outside the redactor's field of view — is a property of *untrusted
 * process output*, not of agents. V1-06's verification seam carries a
 * repository's own test-runner output, which is untrusted in exactly the same
 * way and for exactly the same reasons. A second copy of {@link redactedPrefix}
 * for it would be a second copy of V1-05-RR-F6's fix, free to drift from this
 * one, which is the outcome the whole design refuses.
 */
export interface DiagnosticStreams {
  readonly stdout: string;
  readonly stderr: string;
}

export function agentDiagnostics(result: DiagnosticStreams): AgentDiagnostics {
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
  return endedUnderOwnControl(result) && result.exitCode === 0;
}

/**
 * `true` when the process reached its own end — it was not prevented from
 * running, and nothing terminated it.
 *
 * The separate, weaker predicate exists because it is the one that has to be
 * asked *before* anything the process printed is read (V1-05-RR-F1).
 * `ranCleanly` cannot serve that purpose: it also asks for a zero exit code,
 * and a quota refusal legitimately exits non-zero, so a boundary that gated
 * parsing on `ranCleanly` would lose every usage limit. Splitting the question
 * is what lets both rules hold at once — a signalled run is never classified
 * from its output, and a non-zero exit still gets to carry a recognised
 * refusal.
 *
 * The `signal` half is the load-bearing one. `runCommand` reports a child
 * killed by something *outside* this process as an ordinary completion —
 * nothing here issued the termination — so a SIGKILLed agent arrives as
 * `outcome: 'RAN'` with whatever bytes it had already written. Those bytes are
 * not a result: they are the middle of one.
 */
export function endedUnderOwnControl(result: AgentCommandResult): boolean {
  return result.outcome === 'RAN' && result.signal === null;
}

/*
 * There is still deliberately no reset-timestamp recogniser *here*, and since
 * V3-11 that is a placement decision rather than an absence.
 *
 * One existed and was removed in V1-05-RR-F7: exported, never called, never
 * tested — a validator on a path with no input, which is not a safety measure
 * but a claim that reset times are handled, standing where the reader expects
 * to find the code that handles them. That note said the function would come
 * back "together with the producer that feeds it and the tests that pin both".
 *
 * The producer exists now. It is `readReportedResetAt` in
 * `internal/claude-result-stream.ts`, and it lives there rather than here for
 * the reason that module is internal at all: recognising a reset instant is
 * reading one CLI's document in one output mode, and the value is only
 * meaningful attached to that CLI's positively recognised refusal. A
 * general-purpose recogniser exported from this module would be callable
 * against any string by any caller, which is the shortcut both readers exist
 * to prevent. Since M2 slice 6 the Codex boundary recognises one too, from a
 * different channel: `internal/codex-quota-signal.ts` reads a `turn.failed`
 * message, because `codex exec --json` carries no structured error category.
 */

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
