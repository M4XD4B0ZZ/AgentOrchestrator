/**
 * The one budget every agent payload is held to, and the one clamp that holds
 * it there.
 *
 * Two builders now hand instructions to the writing agent — the remediation
 * brief and the implement brief — and both must be bounded, for the same
 * reason: a repository authors the text, and an agent payload is not allowed
 * to grow with it.
 *
 * They were briefly bounded *separately*, by two constants of the same value
 * and two private clamps, and the clamps did not agree: one reserved a
 * character for its trailing newline and stayed inside the budget, the other
 * appended a marker after slicing and overshot it. Two spellings of one rule
 * disagreeing on their first day is the argument for this module.
 */

/** Characters one agent payload may occupy, marker included. */
export const MAX_AGENT_PAYLOAD_CHARS = 16_384;

/**
 * Clamps `text` to {@link MAX_AGENT_PAYLOAD_CHARS}, marker and all.
 *
 * The marker is counted, not appended afterwards: a budget a result can exceed
 * is not a budget. A clamped payload is therefore always exactly at or under
 * the ceiling, and always ends with the marker so the agent — and anyone
 * reading the prompt — can see that it was cut.
 */
export function clampPayload(text: string, marker = '\n[truncated]'): string {
  return clampTo(text, MAX_AGENT_PAYLOAD_CHARS, marker);
}

/**
 * Clamps `text` to `maxChars`, marker and all.
 *
 * {@link clampPayload} is this with the whole budget, and remains the right
 * call for a payload that is one variable block. This is for the other shape: a
 * payload with a **fixed part it may not lose**, where the budget has to be
 * spent on the variable middle instead of on whatever happens to come last.
 *
 * The defect it exists for. `buildReviewPayload` ends with the reply schema —
 * the document shape the reviewer's answer is parsed against — and clamped the
 * whole payload, so the schema was the FIRST thing a long task body pushed off
 * the end. Measured on 2026-09-12 against the shipped build: a schema-legal
 * profile (a maximal 8 192-character body plus 64 canonical sources) produced a
 * payload ending in `[truncated]` with no `"reviewVersion": 1` in it at all. A
 * reviewer handed that cannot reply in a shape this repository can read, so
 * every round of that task parks at `HUMAN_DECISION_REQUIRED` having spent a
 * real reviewer call on nothing.
 *
 * Two degenerate cases, both stated because a small-budget caller meets them
 * first and neither returns what the paragraph above would lead you to expect:
 *
 * - `maxChars <= 0` yields the empty string rather than a marker. A caller with
 *   no room left is saying it has nothing to spend, and a marker would itself
 *   overrun the budget it was called to respect.
 * - `maxChars <= marker.length` yields a *fragment* of the marker — neither the
 *   text nor a complete marker. {@link clampPayload}'s promise that a clamped
 *   result always ends with the marker therefore holds for `clampPayload`,
 *   whose budget dwarfs every marker in use, and **not** for `clampTo` at a
 *   small budget. Anyone giving this a small `maxChars` is choosing that.
 */
export function clampTo(text: string, maxChars: number, marker = '\n[truncated]'): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${text.slice(0, maxChars - marker.length)}${marker}`;
}
