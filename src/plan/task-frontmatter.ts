/**
 * The boundary where untrusted repository *markdown* becomes task *data*.
 *
 * A task file is one YAML frontmatter block followed by an optional markdown
 * body. Only the frontmatter is a contract; the body exists for a human reader
 * and is never interpreted:
 *
 *     ---
 *     id: V1-02
 *     title: Task source and deterministic selection
 *     status: OPEN
 *     kind: NORMAL
 *     priority: HIGH
 *     currentFocus: true
 *     dependsOn:
 *       - V1-01
 *     ---
 *
 *     Optional prose. Read by people, never by the planner.
 *
 * ── The body is not input ──────────────────────────────────────────────────
 *
 * Nothing below the closing delimiter contributes a dependency, a priority, a
 * focus flag or anything else. There is no markdown heuristic here, no
 * natural-language extraction, no second frontmatter block and no scan for
 * checkbox lists — a plan that could be changed by rewording a paragraph would
 * make the orchestrator's behaviour a function of prose. The body is not parsed
 * as YAML either: it is located, and returned as text.
 *
 * Returned, since V2-02, rather than discarded — and that is not a softening
 * of the rule. `task-brief.ts` hands the body to the *writing agent* as prompt
 * text; no planning decision reads it, and `TaskDefinition` still has no field
 * for it. The rule was never "prose must be destroyed", it was "prose must not
 * decide anything", and that still holds exactly.
 *
 * That also bounds what a hostile file can attempt. Everything a task file can
 * say to this orchestrator has to fit in a delimited, size-capped block at the
 * very top of the file, in plain YAML 1.2, under the shared safe-YAML rules in
 * `src/yaml/safe-yaml.ts`.
 *
 * ── Why the delimiters are exact ───────────────────────────────────────────
 *
 * The opening `---` must be the file's first line, and the closing delimiter
 * must be a line that is exactly `---`. Both rules exist to make the split
 * unambiguous rather than tidy: if a delimiter could be indented, trailed by
 * whitespace or spelled `...`, then where the frontmatter ends would depend on
 * which reader you asked, and the block that gets *validated* could differ from
 * the block a human sees. A file that does not meet the rules is refused, never
 * reinterpreted.
 *
 * A leading UTF-8 BOM is stripped first. Windows editors write one, and a file
 * whose frontmatter is invisible because of a byte-order mark is a support
 * ticket rather than a security decision.
 */

import { loadSafeYamlDocument } from '../yaml/safe-yaml.js';

/**
 * The largest frontmatter block that is parsed at all.
 *
 * A task's frontmatter is seven bounded fields; 8 KiB is already far more than
 * any legitimate one needs. The budget is measured on the *frontmatter*, not on
 * the file, so a long human-written body never costs a task its validity — the
 * file as a whole is bounded separately, where it is read from disk.
 */
export const MAX_TASK_FRONTMATTER_BYTES = 8_192;

/** The delimiter line, in its only accepted spelling. */
const DELIMITER = '---';

export type TaskFrontmatterOutcome =
  /**
   * A frontmatter block was found and converted to the JSON data model.
   *
   * `body` is everything after the closing delimiter, verbatim and
   * uninterpreted. It is carried because this function already knows where the
   * body begins — locating it a second time elsewhere would be a second
   * opinion about where frontmatter ends — and for exactly one purpose: prompt
   * text for the writing agent, assembled by `task-brief.ts`.
   *
   * It remains **not input**. Nothing in the planning path reads it: it
   * contributes no dependency, no priority, no focus and no status, and
   * `TaskDefinition` has no field for it. The rule that a plan cannot be
   * changed by rewording a paragraph is unaffected — what changes is that the
   * paragraph can now be *handed to an agent*, which is the one thing prose is
   * actually for.
   */
  | { readonly outcome: 'FRONTMATTER'; readonly data: unknown; readonly body: string }
  /** The file does not open with a frontmatter delimiter at all. */
  | { readonly outcome: 'MISSING' }
  /** A block was opened but is not one well-formed, warning-free document. */
  | { readonly outcome: 'MALFORMED' }
  /** The block exceeds {@link MAX_TASK_FRONTMATTER_BYTES}. */
  | { readonly outcome: 'TOO_LARGE' }
  /** Well-formed, but carries mapping keys the safe-YAML boundary refuses. */
  | { readonly outcome: 'FORBIDDEN_KEY'; readonly count: number };

/**
 * Splits `text` into lines, tolerating CRLF, LF and a lone CR.
 *
 * The line ending is not part of the contract: the same task file must mean the
 * same thing whether it was last written by a Windows editor, a POSIX one, or a
 * Git checkout that normalised it on the way in.
 */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Reads the frontmatter of a task file, and locates its body.
 *
 * Never throws: every malformed, oversized or hostile document is one of the
 * outcomes above. **No fragment of a *refused* document appears in the result**
 * — a caller learns *that* the file was refused and, for a refused key, how
 * many there were, which is exactly the shape V1-01 established for profiles.
 *
 * A successful read is the one case that does carry document text, and only
 * the body: see {@link TaskFrontmatterOutcome}. The narrower promise is stated
 * deliberately rather than left as the older, now-untrue blanket one.
 */
export function readTaskFrontmatter(text: string): TaskFrontmatterOutcome {
  // A byte-order mark is a transport artefact, not content.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const lines = splitLines(source);
  if (lines[0] !== DELIMITER) return { outcome: 'MISSING' };

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === DELIMITER) {
      closingIndex = index;
      break;
    }
  }
  // An opened block that is never closed is a broken file, not a file without
  // frontmatter: it stated an intent it did not complete, so it fails closed
  // rather than being read as a body-only document.
  if (closingIndex === -1) return { outcome: 'MALFORMED' };

  const block = lines.slice(1, closingIndex).join('\n');
  if (Buffer.byteLength(block, 'utf8') > MAX_TASK_FRONTMATTER_BYTES) {
    return { outcome: 'TOO_LARGE' };
  }

  const loaded = loadSafeYamlDocument(block);
  if (loaded.outcome === 'MALFORMED') return { outcome: 'MALFORMED' };
  if (loaded.outcome === 'FORBIDDEN_KEY') {
    return { outcome: 'FORBIDDEN_KEY', count: loaded.count };
  }
  // Joined with `\n` rather than preserved verbatim: the split above already
  // normalised CRLF and lone CR, and a prompt that differed byte for byte
  // depending on which editor last wrote the file would not be reproducible.
  return {
    outcome: 'FRONTMATTER',
    data: loaded.document,
    body: lines.slice(closingIndex + 1).join('\n'),
  };
}
