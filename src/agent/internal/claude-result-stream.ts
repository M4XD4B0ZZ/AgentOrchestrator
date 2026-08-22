/**
 * The JSONL stream Claude Code prints under
 * `--print --output-format stream-json --verbose`.
 *
 * INTERNAL. This is a *permissive* reader of foreign text: it answers "did a
 * complete stream arrive, and what did it say", and it is deliberately not
 * reachable as API. A caller holding it could ask whether some string looks
 * like a success without any of the process-level conditions that make the
 * question meaningful — the run having completed, the exit code, the signal,
 * the truncation flags — and that is exactly the shortcut the writer boundary
 * exists to prevent.
 *
 * ── Why this replaced a whole-document reader ──────────────────────────────
 *
 * Until V3-11 the writer ran `--output-format json`, which prints one object:
 * the terminal `result`. That object carries no reset instant on either of its
 * variants, so `reportedResetAt` was `null` on every real quota block,
 * `evaluateAutomaticResume` denied `RESET_TIME_MISSING`, and no quota pause
 * could ever end without a human. That was L-V3-08-1, and it was the last lock
 * on unattended quota resume.
 *
 * The instant exists one output mode away. `rate_limit_event` is a *stream*
 * message: under `--output-format json` the CLI builds it, enqueues it, and
 * never writes it. So closing L-V3-08-1 is an output-mode migration, and this
 * module is the new contract.
 *
 * ── Evidence baseline (measured on this machine, 2026-08-22) ───────────────
 *
 * `claude --version` gave `2.1.239 (Claude Code)`.
 *
 * The production vector — every token of `CLAUDE_WRITER_ARGS` — run in a
 * throwaway directory with `Reply with exactly the word: ok` on stdin, printed
 * **four lines and 4741 bytes** on stdout and **nothing** on stderr, exit 0:
 *
 *     {"type":"system","subtype":"init", …}            1741 B
 *     {"type":"rate_limit_event", …}                    305 B
 *     {"type":"assistant", …}                           733 B
 *     {"type":"result","subtype":"success", …}         1958 B
 *
 * and the stream ended with a newline. Three facts in that capture are
 * load-bearing and none of them could be read off the shipped schema alone:
 *
 *  1. **A `rate_limit_event` arrives on a healthy run**, carrying
 *     `{"status":"allowed","resetsAt":1787418000,"rateLimitType":"five_hour", …}`.
 *     `1787418000` renders as `2026-08-22T17:00:00.000Z` against a capture at
 *     `12:19Z` — a five-hour window resetting on the hour, which is what an
 *     epoch-**seconds** reading predicts and what any other unit does not. The
 *     bundle's two arithmetic derivations said the same thing; this is the
 *     first observation that agrees with them.
 *  2. So `resetsAt` is **not** by itself evidence that anything was refused.
 *     A reader that took the last one it saw would attach a reset instant to
 *     every completed run and, worse, to a refusal that the five-hour window
 *     did not cause. `readReportedResetAt` therefore reads only a `rejected`
 *     event, and the classification below attaches it only to a positively
 *     recognised quota refusal — two independent guards, because either one
 *     alone is one edit away from granting a timer-based resume.
 *  3. The `init` message reports the authority the CLI actually granted:
 *     `tools: ["Edit","Glob","Grep","Read","Write"]`, `mcp_servers: []`,
 *     `permissionMode: "acceptEdits"`. The vector's three hermeticity claims
 *     were behavioural measurements until now; the CLI states them. Nothing
 *     here reads that message — see the last note in this comment.
 *
 * `rate_limit_info` carried three fields the shipped schema quote did not
 * mention (`overageStatus`, `overageDisabledReason`, `isUsingOverage`), which
 * is exactly why this reader ignores what it does not name.
 *
 * ── Three layers, and the order they must be asked in ──────────────────────
 *
 *  1. **Transport** — `readStreamObjects`. Did syntactically valid JSON
 *     objects arrive, and which? It knows nothing about Claude.
 *  2. **Event parsing** — `partitionStreamEvents`. Which *known* event types
 *     were delivered? It knows nothing about what they mean.
 *  3. **Semantic classification** — {@link readClaudeResultStream}. What does
 *     that mean for AO?
 *
 * ── Truncation, and why the terminator is the proof ────────────────────────
 *
 * A JSONL stream can die in the middle of an object, and a reader that
 * accepted what it had would turn half a transcript into a verdict. The rule
 * that prevents it is not a truncation heuristic, it is a **positive
 * terminator in a fixed position**: the stream is readable only when its
 * **last non-empty line** is the one and only `result` message. A cut tail
 * leaves a fragment that does not parse, so the terminator is not in that
 * position and the whole stream is `UNRECOGNISED` — the same answer as an
 * empty one.
 *
 * That is why an unparseable line elsewhere is *skipped* rather than fatal, as
 * in `codex-review-transcript.ts`, whose `turn.completed` plays the same role.
 * The CLI is entitled to emit message kinds this reader has never seen, and
 * refusing them would break the writer on the next release for no safety
 * benefit. Completeness is not inferred from the lines; it is asserted by the
 * last of them.
 *
 * ── The position is what replaced "stdout *is* the envelope" ───────────────
 *
 * The whole-document reader required the entire trimmed stdout to be the
 * envelope, so a success envelope *quoted inside* a larger document — this
 * repository's own reviewer reading this repository's own tests is an ordinary
 * event, not an attack scenario — could never be read as a verdict. Scanning
 * lines gives that guarantee up, and the terminator's position is what buys it
 * back: prose wrapped around a stream does not end on the `result` line, so it
 * is refused exactly as before. `tests/claude-writer.test.ts` keeps the case.
 *
 * Under the production vector the transport is the CLI's own JSONL writer and
 * nothing else — the writer holds `Read Edit Write Glob Grep`, so it has no
 * shell with which to print anything, and `--setting-sources ''` leaves no
 * hook that could. This rule does not depend on that being true; it is what
 * makes the reader correct even when it is not.
 *
 * Two further guards stand *above* this module and neither may be removed on
 * the strength of the rule above: `runCommand` reports a stream that hit its
 * byte budget as truncated, which the seam turns into `UNAVAILABLE`, and
 * `endedUnderOwnControl` refuses to read a single byte from a process ended by
 * a signal. This module is the third answer to the same question, not the
 * first.
 *
 * ── Exactly one result, deliberately ───────────────────────────────────────
 *
 * Two `result` messages would mean the document type is not what this reader
 * believes it is, and the terminator is what grants a block its authority. A
 * second one is refused rather than resolved by taking the last: there is no
 * basis for preferring either, and the cost of guessing is a task parked — or
 * resumed — on the wrong one.
 *
 * ── One line is one message, and that is what makes this safe ──────────────
 *
 * The agent's own words travel inside a JSON string, so a writer that quotes a
 * result object in its answer emits it *escaped*, inside an `assistant`
 * message, and cannot forge a top-level line. This repository has a reviewer
 * whose job is to read this repository, so that property is load-bearing
 * rather than incidental: it is why the reader may scan lines at all instead
 * of hunting for an object inside a larger document.
 *
 * ── Why `api_error_status` is the usage-limit signal ───────────────────────
 *
 * Unchanged from the whole-document reader, and unchanged on purpose: this
 * slice migrated the transport, not the verdict. It is a structured field with
 * a standardised vocabulary — an HTTP status — observed as `null` on a healthy
 * run. `429 Too Many Requests` is *the* standard rate/quota refusal, and
 * reading it from a field named `api_error_status` is reading a status code,
 * not pattern-matching English prose.
 *
 * ── The measured envelope of the first dogfood run (2.1.233) ───────────────
 *
 * The run that reported a delivered task and delivered nothing printed this,
 * and every field in it is why the denial observation exists:
 *
 *     "type": "result"
 *     "subtype": "success"
 *     "is_error": false          ← co-occurred with two denials …
 *     "api_error_status": null
 *     "permission_denials": [ { "tool_name": "Write", … },
 *                             { "tool_name": "Bash",  … } ]
 *     "result": "I could not do it. …"   ← … and with no effect on disk
 *
 * So a successful result is not evidence that anything was permitted, and
 * `COMPLETED` still means only "the CLI says the turn completed". Whether the
 * pass achieved anything is answered by a measured delta elsewhere.
 *
 * ── What this module deliberately does not read ────────────────────────────
 *
 * The `init` message's `tools`, `mcp_servers` and `permissionMode` would let AO
 * *verify* the authority it asked for instead of asserting it, which is this
 * repository's whole method. It is not done here: every arm added to a
 * classifier is a new way for a healthy run to be refused, and turning the
 * writer's hermeticity claims into a runtime gate is a product decision with
 * its own failure modes. Carried as L-V3-11-1, with the measurement above as
 * its starting evidence.
 */

import {
  NO_PERMISSION_DENIALS,
  type PermissionDenialObservation,
} from '../agent-outcome.js';

/** The HTTP status that means "rate/quota refused". The one recognised value. */
const RATE_LIMIT_STATUS = 429;

/**
 * The one `rate_limit_info.status` that reports a refusal.
 *
 * The field's vocabulary is `allowed | allowed_warning | rejected`, and the
 * first of those was observed carrying a `resetsAt` — see finding 1 in the
 * module note. Only `rejected` describes the window that refused *this* run:
 * an `allowed` event's `resetsAt` belongs to whichever window was still open,
 * and the `rateLimitType` enum has six members, so pairing a five-hour
 * window's reset with a seven-day exhaustion is not a near miss — it is a
 * resume authorised days early.
 */
const REJECTED_STATUS = 'rejected';

/**
 * The largest epoch-seconds value this build can carry into a `TaskState`.
 *
 * `9999-12-31T23:59:59Z`, and the year is the reason. The obvious bound is
 * `Date`'s own range — ±8.64e15 ms, so 8.64e12 seconds — and it is **wrong**:
 * `new Date(8_640_000_000_000 * 1000).toISOString()` renders
 * `+275760-09-13T00:00:00.000Z`, which `Date.parse` accepts and
 * `TaskStateObjectSchema`'s `z.iso.datetime({ offset: true })` refuses. A
 * reader bounded that way would hand `recordAgentInterruption` a value the
 * durable contract rejects, and the block would fail to be *written* — losing
 * the record of why the task stopped, which is strictly worse than reporting no
 * instant at all. Measured against the shipped schema, not reasoned about:
 * `253402300799` parses, `253402300800` does not.
 *
 * It is deliberately *not* a plausibility bound. Judging whether an instant is
 * too far away needs a clock, this module has none by design, and
 * `evaluateAutomaticResume` — which does have one — already denies
 * `RESET_TIME_NOT_REACHED` for anything that has not arrived.
 */
const MAX_EPOCH_SECONDS = 253_402_300_799;

/** What the stream said, in a closed vocabulary. */
export type ClaudeStreamVerdict =
  /** A positively recognised successful turn. */
  | 'COMPLETED'
  /** A positively recognised quota refusal. */
  | 'USAGE_LIMIT'
  /**
   * Anything else: absent, unparseable, no terminal `result`, more than one,
   * not the envelope, an error whose status is not recognised, or a
   * combination of fields that contradict each other. All one verdict because
   * they all mean "no result to act on".
   */
  | 'UNRECOGNISED';

export interface ClaudeStreamReading {
  readonly verdict: ClaudeStreamVerdict;
  /**
   * The reset instant the CLI reported, as an ISO-8601 timestamp, or `null`.
   *
   * Non-null **only** on `USAGE_LIMIT`, and only from a `rejected`
   * `rate_limit_event`. Never computed from a clock, never a duration turned
   * into an instant: `new Date(resetsAt * 1000).toISOString()` is
   * representation conversion, and it is the only arithmetic this module does.
   */
  readonly reportedResetAt: string | null;
  /**
   * What the agent was refused, when the document said so.
   *
   * Read on every path that produces a reading, including `UNRECOGNISED`,
   * where it is empty because there is no document to read it from.
   */
  readonly permissionDenials: PermissionDenialObservation;
}

const UNRECOGNISED: ClaudeStreamReading = Object.freeze({
  verdict: 'UNRECOGNISED' as const,
  reportedResetAt: null,
  permissionDenials: NO_PERMISSION_DENIALS,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the transport layer saw. Nothing here is judged. */
interface ClaudeStreamTransport {
  /** Every line that was a syntactically valid JSON object, in order. */
  readonly objects: readonly Record<string, unknown>[];
  /**
   * Whether the **last non-empty line** was one of them.
   *
   * Reported separately because it is the only thing the layers above can use
   * to tell "the stream ended where it says it did" from "the stream stopped".
   * `false` for an empty stdout, for a cut final object, and for any trailing
   * text that is not an object.
   */
  readonly endsWithObject: boolean;
}

/**
 * Layer 1, transport: every line that is a syntactically valid JSON **object**,
 * in order, and whether the stream ended on one.
 *
 * Blank lines are skipped, and so is anything else that does not parse or does
 * not parse to an object — a fragment left by a cut stream, a stray line, an
 * array. `trim()` is what makes this correct on Windows, where the lines
 * arrive `\r\n`-terminated.
 *
 * This layer answers nothing about Claude and takes no view on completeness:
 * an empty result and a hundred objects are both valid transports.
 */
function readStreamObjects(stdout: string): ClaudeStreamTransport {
  const objects: Record<string, unknown>[] = [];
  let endsWithObject = false;

  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;

    const parsed = parseObjectLine(text);
    // Assigned unconditionally, from the same expression that decides whether
    // the line is kept. Written as two branches it needed the `false` twice —
    // once for a line that did not parse and once for a line that parsed to
    // something other than an object — and a mutation run found the second one
    // unpinned: a stream ending in a JSON *array* still looked complete,
    // because the flag was left true by the `result` line before it.
    endsWithObject = parsed !== null;
    if (parsed !== null) objects.push(parsed);
  }

  return { objects, endsWithObject };
}

/** One line as a JSON object, or `null` for anything else. */
function parseObjectLine(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The exception text quotes the offending input, so it is discarded rather
    // than carried.
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/** The known event types, separated. Neither array is judged here. */
interface ClaudeStreamEvents {
  /** Every `type: "result"` message. Plural so the count can be refused. */
  readonly results: readonly Record<string, unknown>[];
  /** Every `type: "rate_limit_event"` message's `rate_limit_info`, in order. */
  readonly rateLimits: readonly Record<string, unknown>[];
}

/**
 * Layer 2, event parsing: which known event types were delivered.
 *
 * `system`, `assistant`, `user` and everything this reader has never heard of
 * are dropped: they are the transcript, and the transcript is not evidence
 * about how the run ended.
 *
 * A `rate_limit_event` whose `rate_limit_info` is missing or is not an object
 * contributes nothing, because there is nothing in it to read.
 */
function partitionStreamEvents(
  objects: readonly Record<string, unknown>[],
): ClaudeStreamEvents {
  const results: Record<string, unknown>[] = [];
  const rateLimits: Record<string, unknown>[] = [];

  for (const object of objects) {
    const type = object['type'];
    if (type === 'result') {
      results.push(object);
      continue;
    }
    if (type !== 'rate_limit_event') continue;
    const info = object['rate_limit_info'];
    if (isPlainObject(info)) rateLimits.push(info);
  }

  return { results, rateLimits };
}

/**
 * The reset instant the CLI reported for the window that **refused**, or `null`.
 *
 * The last such event wins, because it is the CLI's most recent statement
 * about the window, and it is the value the CLI's own `retry-after`
 * derivation would have used at that moment. An earlier event naming a later
 * instant is therefore superseded rather than preferred — a resume granted too
 * early meets the refusal again and re-blocks, which costs an invocation; one
 * granted too late on a stale value costs an operator.
 *
 * Every rejection below returns `null`, which is `RESET_TIME_MISSING`, which
 * is a human decision. There is no branch here that guesses.
 */
function readReportedResetAt(rateLimits: readonly Record<string, unknown>[]): string | null {
  for (let index = rateLimits.length - 1; index >= 0; index -= 1) {
    const info = rateLimits[index];
    if (info === undefined || info['status'] !== REJECTED_STATUS) continue;

    const resetsAt = info['resetsAt'];
    // `Number.isInteger` rejects a string, a float, `NaN` and `Infinity` in one
    // predicate; the CLI's schema says integer, and a value that is not one is
    // not this field however it is spelled.
    if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt)) continue;
    if (resetsAt <= 0 || resetsAt > MAX_EPOCH_SECONDS) continue;

    return new Date(resetsAt * 1000).toISOString();
  }
  return null;
}

/**
 * The denials the envelope reported, in the shape 2.1.233 prints them:
 * `[{ tool_name, tool_use_id, tool_input }, …]`.
 *
 * Skipped, never refused. This module is documented as a *permissive* reader of
 * foreign text, and an entry whose shape is unfamiliar must not turn a real
 * result into `UNRECOGNISED` — that would convert an observation meant to
 * inform an operator into a way of losing the whole run. So an unreadable entry
 * contributes to `count` and contributes no name.
 *
 * `tool_input` is never carried: it holds file paths and command lines, and
 * this observation is printed.
 */
function readPermissionDenials(value: unknown): PermissionDenialObservation {
  if (!Array.isArray(value) || value.length === 0) return NO_PERMISSION_DENIALS;

  const tools: string[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const name = entry['tool_name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    if (!tools.includes(name)) tools.push(name);
  }
  return Object.freeze({ count: value.length, tools: Object.freeze(tools) });
}

/**
 * The terminal `result` line as it was printed, **for diagnostics only**, or
 * `null` when the stream did not end on one.
 *
 * ── Why this exists, and why it is not part of the reading ─────────────────
 *
 * `agentDiagnostics` keeps a redacted *prefix* of stdout for a human reading a
 * failure. Under `--output-format json` that prefix was the whole envelope, so
 * an operator saw what the agent actually said. Under `stream-json` the first
 * four kilobytes are the `init` message — a listing of tools, skills and slash
 * commands — and the run's outcome is at the far end, cut off. That is a
 * regression in exactly the two cases the excerpt exists for,
 * `AGENT_RESULT_MALFORMED` and `AGENT_NONZERO_EXIT`.
 *
 * So the writer excerpts *this* instead when it is available, which restores
 * the pre-V3-11 view, and falls back to the whole stream when it is not —
 * which is the right answer for a truncated stream, where the head is the
 * evidence.
 *
 * It is a separate function returning raw text rather than a field on
 * {@link ClaudeStreamReading}, because everything on that interface is a
 * *closed* value a caller may act on and this is untrusted foreign text that no
 * caller may branch on. It also does not share the transport layer's parse: the
 * value wanted here is the line as printed, not the object it decodes to.
 */
export function diagnosticResultLine(stdout: string): string | null {
  let last = '';
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.length > 0) last = text;
  }
  if (last.length === 0) return null;

  const parsed = parseObjectLine(last);
  return parsed !== null && parsed['type'] === 'result' ? last : null;
}

/**
 * Layer 3, semantic classification: reads the stream
 * `claude --print --output-format stream-json --verbose` prints on stdout.
 *
 * The verdict rules on the `result` object are the ones the whole-document
 * reader applied, unchanged, so this migration changed *where* the object comes
 * from and nothing about what it means. The one addition is the reset instant,
 * and it is attached on the `USAGE_LIMIT` branch alone.
 */
export function readClaudeResultStream(stdout: string): ClaudeStreamReading {
  const { objects, endsWithObject } = readStreamObjects(stdout);
  const { results, rateLimits } = partitionStreamEvents(objects);

  // The terminator, and the completeness proof, in three parts that are not
  // interchangeable. Zero results means the stream never reached its end; more
  // than one means this reader does not understand the document it is holding;
  // and a result that is not what the stream *ends* on means whatever produced
  // this stdout kept talking afterwards — prose around a quoted envelope, or a
  // transport that is not the CLI's JSONL writer at all.
  if (!endsWithObject) return UNRECOGNISED;
  if (results.length !== 1) return UNRECOGNISED;
  const result = results[0];
  if (result === undefined) return UNRECOGNISED;
  if (objects[objects.length - 1] !== result) return UNRECOGNISED;

  // Read once, before the verdict logic, and attached to whichever reading that
  // logic produces. It is an observation about the document, not a step in
  // classifying it: nothing below branches on it, which is what keeps a denial
  // from becoming a verdict (G6).
  const permissionDenials = readPermissionDenials(result['permission_denials']);

  const isError = result['is_error'];
  if (typeof isError !== 'boolean') return UNRECOGNISED;

  const status = result['api_error_status'];
  const isRateLimited =
    status === RATE_LIMIT_STATUS || status === String(RATE_LIMIT_STATUS);

  if (isRateLimited) {
    // Recognised as a quota refusal only when the envelope also admits to
    // being an error. A success that carries a 429 is a contradiction, and a
    // contradiction is not evidence.
    return isError
      ? Object.freeze({
          verdict: 'USAGE_LIMIT' as const,
          reportedResetAt: readReportedResetAt(rateLimits),
          permissionDenials,
        })
      : UNRECOGNISED;
  }

  if (isError) return UNRECOGNISED;
  // Success is a positive match on the observed subtype, and on nothing else.
  // An unknown subtype is not a new kind of success; it is a subtype we have
  // never seen, which is the definition of unrecognised.
  if (result['subtype'] !== 'success') return UNRECOGNISED;
  if (status !== null && status !== undefined) return UNRECOGNISED;

  // Deliberately `null` even when the stream carried a `rejected` event: a run
  // the CLI says completed is not a quota block, and a reset instant recorded
  // beside a completed pass is a value looking for a state to authorise. This
  // is the second of the two guards named in the module note; the first is
  // `REJECTED_STATUS`, and neither is redundant, because each is one edit away
  // from being the only thing standing between a healthy run and a timer.
  return Object.freeze({
    verdict: 'COMPLETED' as const,
    reportedResetAt: null,
    permissionDenials,
  });
}
