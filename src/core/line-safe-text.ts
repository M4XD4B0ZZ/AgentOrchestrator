/**
 * Foreign text, made safe to put on a line — the one copy of that rule.
 *
 * ── Why this is a module and not a helper in a renderer ────────────────────
 *
 * The rule was written once, privately, inside
 * `cli/render-publication-authorisations.ts`, for a store of records that
 * `L-V4-14-2` concedes anything running as this OS user can write. V4's
 * verification-attempt evidence needs exactly the same rule for a strictly
 * worse input — a repository's own test runner may print anything at all — and
 * `doctor/exec.ts` states the standing objection to the alternative: a second
 * copy "would be free to drift from this one". So the class and the substitution
 * moved here, unchanged, and the renderer imports them.
 *
 * ── What the class is, and what it is not ──────────────────────────────────
 *
 * The C0 and C1 controls, because a newline splits one entry into two and an
 * escape sequence paints over the lines above it. The twelve Unicode
 * bidirectional formatting characters, because they do the same damage by
 * another route: an override reorders what a terminal shows without changing a
 * byte. And the line and paragraph separators, for the first reason.
 *
 * So the class is **not** "control characters" — most of what is in it is `Cf`,
 * not `Cc`. It is "what can forge a line or reorder one". Everything outside it
 * is left exactly as it arrived: a path with an umlaut, a German test name and a
 * hundred-character branch all pass through untouched.
 *
 * ── It is a rendering property, never a secrecy one ────────────────────────
 *
 * This says nothing about whether the text is safe to *disclose*. A credential
 * is made of perfectly printable characters and passes through unchanged.
 * Keeping secrets out is `auth/redaction.ts`'s job, and that module's own header
 * is candid that it is "a safety net, never the boundary". Two different
 * questions, two different modules, and a caller that needs both must ask both.
 */

/**
 * Every character class a foreign value may not put on a line unaltered.
 *
 * Sourced from the publication-authorisation renderer, where the reasoning for
 * each range is recorded, and widened by nothing.
 */
export const LINE_UNSAFE_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * `true` when `value` contains no character that could forge or reorder a line.
 *
 * The predicate the schema uses, stated from the same pattern the substitution
 * uses rather than as a second regular expression. A stored line that fails this
 * is refused on read: {@link lineSafe} is applied at the source, so a document
 * containing one was not written by this build.
 *
 * `LINE_UNSAFE_PATTERN` carries `g`, and a global regular expression keeps
 * `lastIndex` between calls, so `.test` on the shared object answers differently
 * for the same input depending on what was asked before it. A fresh, non-global
 * copy is built per call for that reason — the alternative, resetting
 * `lastIndex`, is a line that a later edit can drop without failing anything.
 */
export function isLineSafe(value: string): boolean {
  return !new RegExp(LINE_UNSAFE_PATTERN.source, 'u').test(value);
}

/**
 * A foreign value, made safe to put on a line of a report or a prompt.
 *
 * Every character in {@link LINE_UNSAFE_PATTERN} is replaced by its code point
 * in angle brackets, and **nothing outside that class is changed**.
 *
 * The replacement is eight characters wide, so this **expands**: a value made
 * entirely of controls grows eightfold. Every caller that stores the result must
 * bound it *after* this runs, never before — the same ordering
 * `agent/agent-outcome.ts` records for redaction, and for the same reason.
 */
export function lineSafe(value: string): string {
  return value.replace(LINE_UNSAFE_PATTERN, (character) => {
    const code = (character.codePointAt(0) ?? 0).toString(16).padStart(4, '0');
    return `<U+${code.toUpperCase()}>`;
  });
}
