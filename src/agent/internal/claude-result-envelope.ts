/**
 * The structured result Claude Code prints under `--print --output-format json`.
 *
 * INTERNAL. This is a *permissive* reader of foreign text: it answers "is this
 * the envelope, and what does it say", and it is deliberately not reachable as
 * API. A caller holding it could ask whether some string looks like a success
 * without any of the process-level conditions that make the question
 * meaningful — the run having completed, the exit code, the signal, the
 * truncation flags — and that is exactly the shortcut this slice exists to
 * prevent.
 *
 * ── Evidence baseline (captured on this machine while implementing) ────────
 *
 * `claude --version` → `2.1.226 (Claude Code)`.
 *
 * `echo hi | claude -p --output-format json --model haiku` printed one JSON
 * object on stdout whose fields included, verbatim:
 *
 *     "type": "result"
 *     "subtype": "success"
 *     "is_error": false
 *     "api_error_status": null
 *     "stop_reason": "end_turn"
 *     "terminal_reason": "completed"
 *     "result": "Hi! 👋 What can I help you with today?"
 *
 * Four of those are read here and the rest are ignored: an envelope is allowed
 * to grow fields, and a reader that failed on unknown ones would break on the
 * next CLI release for no safety benefit. What is *not* allowed is for a
 * missing or unrecognised value in the four to be treated as benign.
 *
 * ── Why `api_error_status` is the usage-limit signal ───────────────────────
 *
 * It is a structured field with a standardised vocabulary — an HTTP status —
 * observed as `null` on a healthy run. `429 Too Many Requests` is *the*
 * standard rate/quota refusal, and reading it from a field named
 * `api_error_status` is reading a status code, not pattern-matching English
 * prose. That distinction is the whole of the design: this repository has a
 * reviewer whose job is to read this repository, so any sentinel phrase
 * matched against free text would sooner or later be matched against a review
 * that quotes the sentinel's own source file.
 *
 * No reset timestamp was observed in the envelope at this version, so none is
 * read. `reportedResetAt` stays `null`, `evaluateAutomaticResume` refuses with
 * `RESET_TIME_MISSING`, and the block waits for a human. That is the correct
 * outcome for evidence we do not have.
 *
 * ── The measured envelope of the first dogfood run (2.1.233) ───────────────
 *
 * The run that reported a delivered task and delivered nothing printed this,
 * and every field in it is why the denial observation was added:
 *
 *     "type": "result"
 *     "subtype": "success"
 *     "is_error": false          ← co-occurred with two denials …
 *     "api_error_status": null
 *     "permission_denials": [ { "tool_name": "Write", … },
 *                             { "tool_name": "Bash",  … } ]
 *     "result": "I could not do it. …"   ← … and with no effect on disk
 *
 * So a successful envelope is not evidence that anything was permitted, and the
 * verdict logic below is deliberately unchanged by the addition: `COMPLETED`
 * still means "the CLI says the turn completed", because that is what it says.
 * The denials are reported beside it, and whether the pass achieved anything is
 * answered by a measured delta elsewhere — never here.
 */

import {
  NO_PERMISSION_DENIALS,
  type PermissionDenialObservation,
} from '../agent-outcome.js';

/** The HTTP status that means "rate/quota refused". The one recognised value. */
const RATE_LIMIT_STATUS = 429;

/** What the envelope said, in a closed vocabulary. */
export type ClaudeEnvelopeVerdict =
  /** A positively recognised successful turn. */
  | 'COMPLETED'
  /** A positively recognised quota refusal. */
  | 'USAGE_LIMIT'
  /**
   * Anything else: absent, unparseable, not the envelope, an error whose
   * status is not recognised, or a combination of fields that contradict each
   * other. All one verdict because they all mean "no result to act on".
   */
  | 'UNRECOGNISED';

export interface ClaudeEnvelopeReading {
  readonly verdict: ClaudeEnvelopeVerdict;
  /** Always `null` at the observed version; see the module note. */
  readonly reportedResetAt: string | null;
  /**
   * What the agent was refused, when the document said so.
   *
   * Read on every path that produces a reading, including `UNRECOGNISED`, where
   * it is empty because there is no document to read it from.
   */
  readonly permissionDenials: PermissionDenialObservation;
}

const UNRECOGNISED: ClaudeEnvelopeReading = Object.freeze({
  verdict: 'UNRECOGNISED' as const,
  reportedResetAt: null,
  permissionDenials: NO_PERMISSION_DENIALS,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Reads the envelope out of `stdout`.
 *
 * The *whole trimmed stdout* must be the envelope. It is not searched for an
 * embedded object and it is not scanned for a last JSON-looking span: the CLI
 * prints exactly one object in this mode, and a reader that went hunting for
 * one inside a larger document would happily find the object an agent quoted
 * in its own answer.
 */
export function readClaudeResultEnvelope(stdout: string): ClaudeEnvelopeReading {
  const text = stdout.trim();
  if (text.length === 0) return UNRECOGNISED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The exception text quotes the offending input, so it is discarded
    // rather than carried.
    return UNRECOGNISED;
  }

  if (!isPlainObject(parsed)) return UNRECOGNISED;
  if (parsed['type'] !== 'result') return UNRECOGNISED;

  // Read once, before the verdict logic, and attached to whichever reading that
  // logic produces. It is an observation about the document, not a step in
  // classifying it: nothing below branches on it, which is what keeps a denial
  // from becoming a verdict (G6).
  const permissionDenials = readPermissionDenials(parsed['permission_denials']);

  const isError = parsed['is_error'];
  if (typeof isError !== 'boolean') return UNRECOGNISED;

  const status = parsed['api_error_status'];
  const isRateLimited =
    status === RATE_LIMIT_STATUS || status === String(RATE_LIMIT_STATUS);

  if (isRateLimited) {
    // Recognised as a quota refusal only when the envelope also admits to
    // being an error. A success that carries a 429 is a contradiction, and a
    // contradiction is not evidence.
    return isError
      ? Object.freeze({
          verdict: 'USAGE_LIMIT' as const,
          reportedResetAt: null,
          permissionDenials,
        })
      : UNRECOGNISED;
  }

  if (isError) return UNRECOGNISED;
  // Success is a positive match on the observed subtype, and on nothing else.
  // An unknown subtype is not a new kind of success; it is a subtype we have
  // never seen, which is the definition of unrecognised.
  if (parsed['subtype'] !== 'success') return UNRECOGNISED;
  if (status !== null && status !== undefined) return UNRECOGNISED;

  return Object.freeze({ verdict: 'COMPLETED' as const, reportedResetAt: null, permissionDenials });
}
