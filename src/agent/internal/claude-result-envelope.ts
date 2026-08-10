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
 */

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
}

const UNRECOGNISED: ClaudeEnvelopeReading = Object.freeze({
  verdict: 'UNRECOGNISED' as const,
  reportedResetAt: null,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      ? Object.freeze({ verdict: 'USAGE_LIMIT' as const, reportedResetAt: null })
      : UNRECOGNISED;
  }

  if (isError) return UNRECOGNISED;
  // Success is a positive match on the observed subtype, and on nothing else.
  // An unknown subtype is not a new kind of success; it is a subtype we have
  // never seen, which is the definition of unrecognised.
  if (parsed['subtype'] !== 'success') return UNRECOGNISED;
  if (status !== null && status !== undefined) return UNRECOGNISED;

  return Object.freeze({ verdict: 'COMPLETED' as const, reportedResetAt: null });
}
