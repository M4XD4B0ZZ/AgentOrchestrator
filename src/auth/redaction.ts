/**
 * Redaction applied to every piece of CLI output that reaches a diagnostics
 * file or the console.
 *
 * This is a safety net, not the primary control. The primary control is that
 * the doctor only ever stores an explicit allow-list of fields from auth
 * status output (see `auth-preflight.ts`). Redaction catches whatever slips
 * through free-form text.
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
