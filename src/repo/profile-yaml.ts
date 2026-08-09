/**
 * The boundary where repository-supplied profile *text* becomes profile *data*.
 *
 * Everything the orchestrator later believes about a repository is derived from
 * this one conversion, so it is the last place where the raw document is still
 * inspectable and the first place where a hostile document could gain an
 * advantage. The rules that establish that — plain YAML 1.2 core schema, a
 * warned document refused, no warning routed to the process, errors read rather
 * than caught, one document rather than a silently-truncated stream, and
 * `__proto__` refused at any depth before any JavaScript object exists — are
 * stated once in `src/yaml/safe-yaml.ts` and are documented there in full.
 *
 * They live there rather than here because a second class of untrusted document
 * arrived in V1-02: a task file's frontmatter (`src/plan/task-frontmatter.ts`).
 * Two boundaries needing the same guarantees must not be able to drift into
 * having different ones. The extraction changed no behaviour of this module —
 * the parse options, the forbidden-key rule and the single-document rule are
 * exactly the ones V1-01 established.
 *
 * What stays here is the *profile's* vocabulary: its own outcome type and its
 * own name for the refused-key set, so that a caller of this module reads about
 * profiles rather than about YAML in general.
 */

import { FORBIDDEN_MAPPING_KEYS, loadSafeYamlDocument } from '../yaml/safe-yaml.js';

/**
 * Mapping keys refused outright, wherever they appear in a profile.
 *
 * The set is the shared one: `__proto__`, the single key whose meaning depends
 * on the object model rather than on the contract. Every other unknown key is
 * an ordinary own property and is refused by the profile schema itself.
 */
export const FORBIDDEN_PROFILE_MAPPING_KEYS: readonly string[] = FORBIDDEN_MAPPING_KEYS;

export type ProfileDocumentOutcome =
  /** A single well-formed document, converted to the JSON data model. */
  | { readonly outcome: 'DOCUMENT'; readonly document: unknown }
  /** Not one well-formed, warning-free YAML 1.2 document. */
  | { readonly outcome: 'MALFORMED' }
  /** Well-formed, but carries mapping keys this contract refuses by name. */
  | { readonly outcome: 'FORBIDDEN_KEY'; readonly count: number };

/**
 * Turns profile text into the JSON data model, or says why it could not.
 *
 * Never throws and never emits: an unparsable document, an excessive alias
 * expansion and a refused key are all return values. An empty stream is handed
 * on as `null` — well-formed YAML which simply is not a profile — for the
 * contract to refuse, which is the same answer an empty mapping would get.
 */
export function loadProfileDocument(text: string): ProfileDocumentOutcome {
  return loadSafeYamlDocument(text);
}
