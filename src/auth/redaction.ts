/**
 * Pattern-based redaction of free-form text.
 *
 * This is a safety net, never the boundary — and as of AO-002-R1 it is applied
 * to **no persisted artefact at all**, because no persisted artefact contains
 * free-form text any more. The capability summary used to route raw probe
 * output through here; that dump was removed rather than redacted harder,
 * precisely because these rules can only mask the secret shapes they already
 * know (`tests/doctor.test.ts` asserts that an arbitrary marker survives
 * redaction untouched — that is the point).
 *
 * The real control is that the doctor stores only an explicit allow-list of
 * values: closed-vocabulary tokens from capability probes (`capabilities.ts`)
 * and typed evidence fields from auth status output (`auth-preflight.ts`).
 *
 * Kept for future free-form paths — a log line, an operator note — where a
 * safety net is better than nothing. Anything reaching for it should first ask
 * whether the text needs to be persisted at all.
 */

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const RULES: readonly RedactionRule[] = [
  // Email addresses (auth status output contains the account email).
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '<redacted:email>' },
  // UUIDs (organisation / account identifiers).
  {
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    replacement: '<redacted:uuid>',
  },
  // Bearer / OAuth / API key shaped tokens.
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, replacement: '<redacted:token>' },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replacement: '<redacted:token>' },
  { pattern: /\b(?:oauth|access|refresh|id)[_-]?token["'\s:=]+[A-Za-z0-9._-]{8,}/gi, replacement: '<redacted:token>' },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, replacement: 'Bearer <redacted:token>' },
  // Long opaque blobs that are almost certainly credentials.
  { pattern: /\beyJ[A-Za-z0-9._-]{20,}/g, replacement: '<redacted:jwt>' },
];

/** Applies every redaction rule. Safe to call on already-redacted text. */
export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/** Redacts and clamps, so a runaway CLI cannot bloat the report. */
export function redactAndClamp(text: string, maxLength = 4000): string {
  const redacted = redact(text);
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}\n… [truncated, ${redacted.length - maxLength} more characters]`;
}
