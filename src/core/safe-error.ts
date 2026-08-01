/**
 * The single, central formatter for every error text that reaches a user, a
 * console, a diagnostics file or a report (AO-002).
 *
 * Why this exists: exception messages are the classic side channel for
 * untrusted data. `JSON.parse` echoes the offending input, `fs` echoes full
 * paths, a child-process wrapper echoes the command line, and a CLI's own
 * error text can contain whatever that CLI decided to print. A global handler
 * that writes `error.message` republishes all of it.
 *
 * The rule enforced here is a positive allow-list, exactly like the auth
 * checks:
 *
 *  - An {@link OrchestratorError} carries an explicit `safeMessage` that its
 *    author guaranteed is built only from the orchestrator's own vocabulary.
 *    That text — and only that text — is shown.
 *  - Everything else yields a fixed sentence plus, at most, the error's
 *    constructor name, and only when that name is a plain identifier.
 *
 * Redaction is *not* used as the boundary here. It is defence in depth
 * elsewhere; the boundary is that unknown text is never emitted at all.
 */

import { OrchestratorError, SAFE_MESSAGE } from './errors.js';

/** Shown whenever an error is not positively recognised as safe to display. */
export const WITHHELD_ERROR_TEXT =
  'An unexpected internal error occurred. Details are withheld because they may ' +
  'contain untrusted command output.';

/** A constructor name is only echoed when it is a plain JS identifier. */
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isOrchestratorError(error: unknown): error is OrchestratorError {
  if (error instanceof OrchestratorError) return true;
  // Survives duplicate module instances (e.g. a test importing both `src` and
  // `dist`): the marker symbol is registered globally.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<PropertyKey, unknown>)[SAFE_MESSAGE] === true &&
    typeof (error as { safeMessage?: unknown }).safeMessage === 'string'
  );
}

/** The error class name, if it is a plain identifier; otherwise `null`. */
export function safeErrorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const name = (error as { name?: unknown }).name;
  if (typeof name !== 'string' || !SAFE_ERROR_NAME_PATTERN.test(name)) return null;
  return name;
}

/**
 * Formats any thrown value into text that is safe to print or persist.
 *
 * Never throws, never returns untrusted content, and never returns an empty
 * string.
 */
export function formatSafeError(error: unknown): string {
  if (isOrchestratorError(error)) {
    const safe = (error as OrchestratorError).safeMessage;
    if (typeof safe === 'string' && safe.trim().length > 0) return safe;
  }

  const name = safeErrorName(error);
  return name === null ? WITHHELD_ERROR_TEXT : `${WITHHELD_ERROR_TEXT} (${name})`;
}

/**
 * A short, allow-listed error *code* for structured reports.
 *
 * Node's `ErrnoException.code` values (`ENOENT`, `EACCES`, `EPERM`, …) are
 * screaming-snake identifiers and carry no payload, which makes them the one
 * piece of an exception that can be persisted. Anything that does not look like
 * such a code is reduced to `UNKNOWN`.
 */
export const UNKNOWN_ERRNO_CODE = 'UNKNOWN';

const ERRNO_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export function safeErrnoCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return UNKNOWN_ERRNO_CODE;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code !== 'string' || !ERRNO_CODE_PATTERN.test(code)) return UNKNOWN_ERRNO_CODE;
  return code;
}
