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
  if (text.length <= MAX_AGENT_PAYLOAD_CHARS) return text;
  return `${text.slice(0, MAX_AGENT_PAYLOAD_CHARS - marker.length)}${marker}`;
}
