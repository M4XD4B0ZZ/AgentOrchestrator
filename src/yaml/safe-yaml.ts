/**
 * The shared, hostile-input-safe YAML boundary.
 *
 * Two different kinds of repository-supplied document reach this orchestrator —
 * the repository profile (`src/repo/profile-yaml.ts`) and a task file's
 * frontmatter (`src/plan/task-frontmatter.ts`) — and both need the *same*
 * properties, for the same reasons. Those properties are stated once, here, so
 * that a hardening applied to one document class cannot silently fail to apply
 * to the other.
 *
 * This module was extracted from `profile-yaml.ts` without changing any of its
 * behaviour: the parse options, the forbidden-key rule and the single-document
 * rule are the ones V1-01 established and verified. What it adds is a second
 * caller, not a second policy.
 *
 * ── The properties ─────────────────────────────────────────────────────────
 *
 * **Plain YAML 1.2 core schema.** Version pinned, merge keys off. A document
 * may only produce the JSON data model, so nothing exotic reaches a validator.
 *
 * **A warned document is refused.** A parser warning marks a construct outside
 * that core schema — an unresolved tag, an ambiguous anchor or alias, a bad
 * directive. Refusing it is what the format rule already claimed, and silencing
 * the warning instead would have made such a document quietly acceptable.
 *
 * **No warning reaches the process.** `YAML.parse()` routes warnings to
 * `process.emitWarning`, and those messages quote the offending source line —
 * putting repository text on stderr, past every containment rule the callers
 * observe for their own return values. Nothing here hands a warning to the
 * library's logger, and `logLevel: 'silent'` states that at the call site.
 *
 * **Errors are read, not caught.** Under a silent log level `YAML.parse()`
 * *discards* `doc.errors` rather than throwing, so silencing the logger without
 * this care would have turned malformed YAML into accepted YAML. Documents are
 * therefore parsed with `parseAllDocuments` and inspected.
 *
 * **One document, or none.** A stream of several is refused rather than
 * silently reduced to its first, which is what a single-document parse would do
 * once the logger is silent.
 *
 * **`__proto__` is refused at any depth, before any JavaScript object exists.**
 * The generated JSON Schemas set `additionalProperties: false` everywhere and
 * so reject it like any other unknown property, while Zod's `.strict()` treats
 * `__proto__` as *not a key* and drops it silently — one document meaning two
 * different things to the shipped schema and to the runtime. The scan therefore
 * walks the parsed document *tree*, over the mapping keys the parser actually
 * read: a check performed after the conversion can only see keys the conversion
 * chose to keep, and `__proto__` is precisely the key a conversion is entitled
 * to treat specially.
 *
 * **The alias budget is stated, not inherited.** `maxAliasCount` is passed
 * explicitly at the value the library defaults to, so an expansion bomb is
 * refused by a number this repository chose rather than by one it happened to
 * receive. Exceeding it throws inside `toJS`, and that becomes `MALFORMED`.
 */

import { isScalar, parseAllDocuments, visit } from 'yaml';

/**
 * Mapping keys refused outright, wherever they appear.
 *
 * `__proto__` is the whole set: it is the one key whose meaning depends on the
 * object model rather than on a contract, and therefore the one key on which a
 * schema validator and a runtime validator can disagree while both believe they
 * are being strict. Every other unknown key is an ordinary own property and is
 * refused by the document's own schema.
 */
export const FORBIDDEN_MAPPING_KEYS: readonly string[] = Object.freeze(['__proto__']);

/**
 * The alias-expansion ceiling. The `yaml` library's own default, restated so
 * the budget is a decision on this side of the boundary.
 */
export const MAX_ALIAS_COUNT = 100;

/** The parse options every hostile-input document in this repository is read with. */
export const SAFE_YAML_PARSE_OPTIONS = Object.freeze({
  version: '1.2' as const,
  merge: false,
  logLevel: 'silent' as const,
  maxAliasCount: MAX_ALIAS_COUNT,
  // The prettifier splices the offending source line into an error or warning
  // message. Neither is ever surfaced, but a message that never carries
  // document text cannot leak it through a later change either.
  prettyErrors: false,
});

export type SafeYamlOutcome =
  /** A single well-formed document, converted to the JSON data model. */
  | { readonly outcome: 'DOCUMENT'; readonly document: unknown }
  /** Not one well-formed, warning-free YAML 1.2 document. */
  | { readonly outcome: 'MALFORMED' }
  /** Well-formed, but carries mapping keys this boundary refuses by name. */
  | { readonly outcome: 'FORBIDDEN_KEY'; readonly count: number };

/** Counts the refused mapping keys in a parsed document tree. */
function countForbiddenKeys(document: Parameters<typeof visit>[0]): number {
  let found = 0;
  visit(document, {
    Pair(_key, pair) {
      const key: unknown = pair.key;
      if (
        isScalar(key) &&
        typeof key.value === 'string' &&
        FORBIDDEN_MAPPING_KEYS.includes(key.value)
      ) {
        found += 1;
      }
    },
  });
  return found;
}

/**
 * Turns untrusted YAML text into the JSON data model, or says why it could not.
 *
 * Never throws and never emits: an unparsable document, an excessive alias
 * expansion and a refused key are all return values. An empty stream is handed
 * on as `null` — well-formed YAML that simply is not the expected document —
 * for the caller's own contract to refuse.
 */
export function loadSafeYamlDocument(text: string): SafeYamlOutcome {
  let documents;
  try {
    documents = parseAllDocuments(text, SAFE_YAML_PARSE_OPTIONS);
  } catch {
    return { outcome: 'MALFORMED' };
  }

  if (documents.length > 1) return { outcome: 'MALFORMED' };

  const document = documents[0];
  if (document === undefined) return { outcome: 'DOCUMENT', document: null };

  if (document.errors.length > 0) return { outcome: 'MALFORMED' };
  if (document.warnings.length > 0) return { outcome: 'MALFORMED' };

  const forbidden = countForbiddenKeys(document);
  if (forbidden > 0) return { outcome: 'FORBIDDEN_KEY', count: forbidden };

  try {
    // The alias ceiling applies inside `toJS`; an expansion that exceeds it
    // throws rather than materialising.
    return { outcome: 'DOCUMENT', document: document.toJS() };
  } catch {
    return { outcome: 'MALFORMED' };
  }
}
