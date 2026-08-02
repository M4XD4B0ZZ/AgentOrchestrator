/**
 * INTERNAL — pure Windows batch-argument codec for the trusted `cmd.exe /d /s
 * /c` fallback in `../exec.ts` (AO-FOUNDATION-REM-003B-R2, part of closing
 * AO-FOUNDATION-FULL-REV-02).
 *
 * ── Why a codec is needed at all ────────────────────────────────────────────
 *
 * `planSpawn` builds one inner command-line string and hands it to `cmd.exe
 * /d /s /c "<inner>"` with `windowsVerbatimArguments: true` — Node performs no
 * quoting of its own, so whatever this module produces is exactly what
 * `cmd.exe` parses. That string is then read by three distinct layers, in
 * order, and each has its own rules:
 *
 *  1. **`/S` outer-quote stripping** — `cmd.exe` strips exactly the first and
 *     last character of the `/C` string if they are both `"`, nothing more.
 *     It does not look at how many quotes are in between.
 *  2. **cmd's own command-line tokenizer** — the remaining text is scanned to
 *     find the program to run. `&`, `|`, `<`, `>`, `^`, `(`, `)`, `%` and `!`
 *     are metacharacters at this layer, and — this is the counterintuitive
 *     part an unescaped implementation gets wrong — a matched pair of double
 *     quotes does **not** neutralise them. Only a `^` immediately before the
 *     character does.
 *  3. **batch-parameter extraction** — once the target is recognised as a
 *     `.cmd`/`.bat` file, `cmd.exe` re-enters itself as the batch
 *     interpreter and reads `%1`, `%2`, … off the *same already-scanned*
 *     text. Whitespace runs are token separators; an argument with no
 *     characters between two separators does not produce a token at all,
 *     which is what silently drops an empty argument and shifts every
 *     argument after it (AO-FOUNDATION-REM-003B-R2, R3 in the original
 *     review).
 *
 * ── What was proven, empirically, before this module existed ───────────────
 *
 * An isolated oracle probe (`cmd.exe /d /s /c`, `shell: false`,
 * `windowsVerbatimArguments: true` — the exact configuration `exec.ts` uses,
 * exercised outside this repository, not part of it) against a batch target
 * reading `%~1`/`SHIFT` proved:
 *
 *  - wrapping an argument in a matched quote pair and caret-escaping every
 *    metacharacter — `(`, `)`, `%`, `!`, `^`, `<`, `>`, `&`, `|` — **inside**
 *    those quotes round-trips byte-exact through all three layers above, for
 *    every one of those classes, empty arguments, multiple consecutive empty
 *    arguments, spaces, Unicode, trailing backslashes and combinations of all
 *    of the above;
 *  - a literal embedded `"` does **not** have a working encoding through this
 *    transport. Five distinct strategies were tried (caret before the quote
 *    in place, close-quote/caret/reopen, quadruple-quoting, a CRT-style
 *    backslash-quote pair, doubled carets) and every one of them left
 *    `cmd.exe`'s batch-parameter tokenizer in an unbalanced-quote state that
 *    **hung the process** rather than producing a parse error or wrong
 *    output. That is a materially worse failure mode than wrong data, so
 *    there is no supported encoding for it here — {@link
 *    encodeWindowsBatchArgument} refuses such an argument outright instead of
 *    guessing. `assertSafeArgs` in `../exec.ts` already forbids `"` in every
 *    argument that reaches this module in production, so this refusal is
 *    belt-and-suspenders on the codec's own boundary, not a new production
 *    restriction.
 */

/**
 * Thrown by {@link encodeWindowsBatchArgument} for the one argument class it
 * does not support. Carries no argument content — callers are expected to
 * translate this into their own static, safe error identity (see
 * `UnsafeArgumentError` in `../exec.ts`).
 */
export class UnsupportedWindowsBatchArgumentError extends Error {}

/** Metacharacters that are still special even inside a quoted cmd.exe token. */
const CMD_METACHARACTERS = /[()%!^<>&|]/g;

/**
 * Encodes one argument for the trusted `cmd.exe /d /s /c` batch fallback.
 *
 * Every argument — including an empty one — is wrapped in a matched pair of
 * double quotes so it always produces exactly one batch-parameter token, and
 * every cmd.exe metacharacter is caret-escaped so quoting alone (which does
 * not neutralise them at layer 2 above) is never relied on for safety.
 *
 * @throws UnsupportedWindowsBatchArgumentError if `arg` contains a literal
 *         `"`. See the module doc comment for why this class has no safe
 *         encoding through this transport.
 */
export function encodeWindowsBatchArgument(arg: string): string {
  if (arg.includes('"')) {
    throw new UnsupportedWindowsBatchArgumentError();
  }
  return `"${arg.replace(CMD_METACHARACTERS, '^$&')}"`;
}
