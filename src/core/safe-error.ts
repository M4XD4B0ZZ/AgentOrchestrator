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
 * ── The rule (AO-002-R2-RR1) ───────────────────────────────────────────────
 *
 * Everything emitted from here is a **string literal written in this
 * repository**. There are exactly two sources:
 *
 *  1. {@link DOMAIN_ERROR_TEXT} — a static table from a closed
 *     {@link DomainErrorId} to a fixed sentence. The id is read from an
 *     {@link OrchestratorError} recognised **only** by `instanceof`.
 *  2. The fixed code {@link UNEXPECTED_ERROR_CODE} for everything else.
 *
 * Nothing is read off the error object except that id, and the id is only used
 * to *select* a literal from the table.
 *
 * What is deliberately **never** emitted, in any form:
 *
 *  - a `safeMessage` property. The concept is gone: the earlier design let an
 *    error supply its own display text, and recognised errors by a
 *    `Symbol.for('agent-loop.safeMessage')` marker — a global key any object
 *    can set on itself. Together those let a foreign object choose what the CLI
 *    printed;
 *  - a foreign `error.name` — including `TypeError`, `SyntaxError` and friends.
 *    A name is a writable string property, so "it looks like an identifier" is
 *    not evidence of anything. Shape is never the criterion here;
 *  - a foreign `error.code`, unless the exact string is on the errno
 *    allow-list;
 *  - a foreign `error.message`, ever.
 *
 * `instanceof` is the sole recognition test, with no duplicate-module fallback.
 * If two copies of this package are loaded and an error crosses between them,
 * it is reported as {@link UNEXPECTED_ERROR_CODE}. That is the intended
 * fail-closed behaviour.
 */

import { isDomainErrorId, OrchestratorError, type DomainErrorId } from './errors.js';

export type { DomainErrorId };

/** Shown whenever an error is not positively recognised as safe to display. */
export const WITHHELD_ERROR_TEXT =
  'An unexpected internal error occurred. Details are withheld because they may ' +
  'contain untrusted command output.';

/** The one code any unrecognised thrown value is reduced to. */
export const UNEXPECTED_ERROR_CODE = 'UNEXPECTED_ERROR';

/**
 * The static id → text table. This is the complete vocabulary of internal error
 * text the orchestrator can display.
 *
 * `Record<DomainErrorId, string>` makes the table exhaustive by construction:
 * a new id in `DOMAIN_ERROR_IDS` does not compile until a sentence is added
 * here, so there is no path to a missing entry at runtime.
 */
export const DOMAIN_ERROR_TEXT: Readonly<Record<DomainErrorId, string>> = Object.freeze({
  ORCHESTRATOR_INVARIANT_VIOLATED: 'An orchestrator invariant was violated.',
  ILLEGAL_TRANSITION: 'The requested task-state transition is not allowed by the transition table.',
  INVALID_RESUME_POINT:
    'A resume point could not be parsed, or it violates the resume-point contract.',
  TRUSTED_PROFILE_UNAVAILABLE:
    'The trusted operating-system user profile directory could not be established, so no ' +
    'persistent path could be resolved.',
});

/**
 * The closed identity of one of *our* domain errors, or `null`.
 *
 * A foreign value always yields `null`, whatever properties, symbols, names or
 * codes it carries: the only test is `instanceof OrchestratorError`, and the id
 * is read from a getter backed by a private field a foreign object cannot have.
 */
export function safeDomainErrorId(error: unknown): DomainErrorId | null {
  if (!(error instanceof OrchestratorError)) return null;
  const id: unknown = error.domainErrorId;
  return isDomainErrorId(id) ? id : null;
}

/**
 * Formats any thrown value into text that is safe to print or persist.
 *
 * Never throws, never returns untrusted content, and never returns an empty
 * string.
 */
export function formatSafeError(error: unknown): string {
  const id = safeDomainErrorId(error);
  if (id === null) return `${WITHHELD_ERROR_TEXT} [${UNEXPECTED_ERROR_CODE}]`;
  return `${DOMAIN_ERROR_TEXT[id]} [${id}]`;
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
 * `run-directory.ts`, `run-completion.ts` and `write-access.ts` (`mkdir`,
 * `open` with `wx`, `write`, `fsync`, `close`, `lstat`, `readdir`, `readFile`).
 * Group 2 comes from spawning diagnostic child processes, which happens in
 * `exec.ts` and nowhere else. In particular the trusted profile resolver is not
 * a producer here: it answers in-process and starts no child, and its failures
 * are reported as the `TRUSTED_PROFILE_UNAVAILABLE` domain error rather than as
 * an errno. Nothing else is expected, so nothing else is reportable.
 */
export const ALLOWED_ERRNO_CODES = [
  // Filesystem
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EINVAL',
  'EIO',
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
