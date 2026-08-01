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
 * ── The rule (AO-002-R2) ───────────────────────────────────────────────────
 *
 * Everything emitted from here comes from a **closed allow-list defined in
 * this repository**. There are exactly three sources:
 *
 *  1. An {@link OrchestratorError} — one of *our own* domain error classes,
 *     recognised by `instanceof` (with a globally registered symbol as a
 *     fallback for duplicate module instances, e.g. a test importing both
 *     `src` and `dist`). Its `safeMessage` is built only from the
 *     orchestrator's own vocabulary, and its class name is mapped through
 *     {@link ORCHESTRATOR_ERROR_NAMES} rather than read from `error.name`.
 *  2. An errno identifier that appears verbatim in {@link ALLOWED_ERRNO_CODES}.
 *  3. The fixed code {@link UNEXPECTED_ERROR_CODE} for everything else.
 *
 * What is deliberately **never** emitted:
 *
 *  - a foreign `error.name` — including `TypeError`, `SyntaxError` and friends.
 *    A name is a writable string property, so "it looks like an identifier" is
 *    not evidence of anything. Shape is never the criterion here;
 *  - a foreign `error.code`, unless the exact string is on the errno
 *    allow-list;
 *  - a foreign `error.message`, ever, in any form.
 */

import { OrchestratorError, SAFE_MESSAGE } from './errors.js';

/** Shown whenever an error is not positively recognised as safe to display. */
export const WITHHELD_ERROR_TEXT =
  'An unexpected internal error occurred. Details are withheld because they may ' +
  'contain untrusted command output.';

/** The one code any unrecognised thrown value is reduced to. */
export const UNEXPECTED_ERROR_CODE = 'UNEXPECTED_ERROR';

/**
 * The closed set of our own domain error class names.
 *
 * Membership is decided by `instanceof`, never by comparing `error.name`
 * against this list: a foreign object may set any `name` it likes, but it
 * cannot make itself an instance of a class defined in this package.
 */
export const ORCHESTRATOR_ERROR_NAMES = [
  'OrchestratorError',
  'IllegalTransitionError',
  'InvalidResumePointError',
] as const;

export type OrchestratorErrorName = (typeof ORCHESTRATOR_ERROR_NAMES)[number];

function isOrchestratorErrorName(value: unknown): value is OrchestratorErrorName {
  return (
    typeof value === 'string' &&
    (ORCHESTRATOR_ERROR_NAMES as readonly string[]).includes(value)
  );
}

/**
 * `true` for our own domain errors.
 *
 * `instanceof` is the primary test. The symbol marker is a fallback for the one
 * case `instanceof` cannot cover — two copies of this package loaded at once —
 * and it is a `Symbol.for` key on the prototype chain of our own class, not a
 * value a plain thrown object is likely to carry by accident. Even when it
 * matches, nothing from the error is echoed except an allow-listed class name
 * and the author-provided `safeMessage`.
 */
function isOrchestratorError(error: unknown): error is OrchestratorError {
  if (error instanceof OrchestratorError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<PropertyKey, unknown>)[SAFE_MESSAGE] === true &&
    typeof (error as { safeMessage?: unknown }).safeMessage === 'string'
  );
}

/**
 * The allow-listed class name of one of *our* domain errors, or `null`.
 *
 * A foreign error always yields `null`, whatever its `name` looks like.
 */
export function safeErrorName(error: unknown): OrchestratorErrorName | null {
  if (!isOrchestratorError(error)) return null;
  const name = (error as { name?: unknown }).name;
  // The name is only used to *select* a literal from the closed list; an
  // unexpected value (a subclass we have not allow-listed, a tampered `name`)
  // degrades to the base class name rather than being echoed.
  return isOrchestratorErrorName(name) ? name : 'OrchestratorError';
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
    if (typeof safe === 'string' && safe.trim().length > 0) {
      const name = safeErrorName(error);
      return name === null ? safe : `[${name}] ${safe}`;
    }
  }

  return `${WITHHELD_ERROR_TEXT} [${UNEXPECTED_ERROR_CODE}]`;
}

/**
 * A short, allow-listed error *code* for structured reports.
 *
 * Node's `ErrnoException.code` values carry no payload, which makes them the
 * one piece of an exception that can be persisted — but only the ones we have
 * a reason to expect. Matching the screaming-snake *shape* is not enough: any
 * library may set `error.code` to any string it likes, so the value has to
 * appear in the list below verbatim. Anything else becomes `UNKNOWN`.
 */
export const UNKNOWN_ERRNO_CODE = 'UNKNOWN';

/**
 * Errno identifiers this tool can actually produce.
 *
 * Group 1 comes from the filesystem calls in `safe-write.ts`,
 * `run-directory.ts` and `write-access.ts` (`mkdir`, `open` with `wx`, `link`,
 * `rename`, `rm`, `lstat`, `readFile`). Group 2 comes from spawning diagnostic
 * child processes in `exec.ts`. Nothing else is expected, so nothing else is
 * reportable.
 */
export const ALLOWED_ERRNO_CODES = [
  // Filesystem
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EINVAL',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EROFS',
  'EXDEV',
  // Process spawn
  'E2BIG',
  'EAGAIN',
  'ENFILE',
  'ENOMEM',
  'ETIMEDOUT',
] as const;

export type AllowedErrnoCode = (typeof ALLOWED_ERRNO_CODES)[number];

const ALLOWED_ERRNO_SET: ReadonlySet<string> = new Set<string>(ALLOWED_ERRNO_CODES);

export function safeErrnoCode(error: unknown): AllowedErrnoCode | typeof UNKNOWN_ERRNO_CODE {
  if (typeof error !== 'object' || error === null) return UNKNOWN_ERRNO_CODE;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code !== 'string' || !ALLOWED_ERRNO_SET.has(code)) return UNKNOWN_ERRNO_CODE;
  return code as AllowedErrnoCode;
}
