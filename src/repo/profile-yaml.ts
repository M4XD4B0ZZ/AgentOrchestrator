/**
 * The boundary where repository-supplied profile *text* becomes profile *data*.
 *
 * Everything the orchestrator later believes about a repository is derived from
 * this one conversion, so it is the last place where the raw document is still
 * inspectable and the first place where a hostile document could gain an
 * advantage. Two properties are therefore established here rather than left to
 * the validator downstream:
 *
 * ── 1. The runtime refuses exactly what the shipped JSON Schema refuses ─────
 *
 * `schemas/repo-profile.schema.json` is generated with
 * `additionalProperties: false` at every level, so an editor validating a
 * profile against it rejects a `__proto__` key like any other unknown property.
 * Zod does not agree: `.strict()` treats `__proto__` as *not a key at all* and
 * drops it silently, so the same document passes at runtime. No prototype was
 * polluted by that — Zod discards the value and the resolver rebuilds its result
 * field by field — but a contract that means one thing to the schema and another
 * to the runtime is not a contract, and V1-02+ would build on the weaker half.
 *
 * The scan below therefore runs on the YAML document tree, over the mapping keys
 * the parser actually read, *before* any JavaScript object exists. That ordering
 * is the point: a check performed after the conversion can only see keys the
 * conversion chose to keep, and `__proto__` is precisely the key a conversion is
 * entitled to treat specially. Nesting makes no difference to a tree walk, so
 * `repository.__proto__` is caught by the same clause as a top-level one.
 *
 * ── 2. No fragment of the document reaches the process ──────────────────────
 *
 * `YAML.parse()` routes every parser warning to `process.emitWarning`, and those
 * warnings quote the offending source line — an unknown tag on a profile field
 * printed the field's own text to stderr, past every containment rule the
 * resolver observes for its return value. This module never hands a warning to
 * the library's logger, so the leak has no path to occur; `logLevel: 'silent'`
 * is passed as well, to state the intent at the call site.
 *
 * Suppression alone would have been the wrong fix: a warning marks a construct
 * outside the plain YAML 1.2 core schema this contract is written in — an
 * unresolved tag, an ambiguous anchor or alias, a bad directive — and a silenced
 * warning would have made such a document *quietly acceptable*. A warned
 * document is refused instead, which is both fail-closed and what the format
 * rule already claimed.
 *
 * Errors are read from the document rather than caught as exceptions, because
 * `YAML.parse()` under `logLevel: 'silent'` discards `doc.errors` instead of
 * throwing — silencing the logger there would have turned malformed YAML into
 * accepted YAML.
 */

import { isScalar, parseAllDocuments, visit } from 'yaml';

/**
 * Mapping keys refused outright, wherever they appear.
 *
 * `__proto__` is the whole set: it is the one key whose meaning depends on the
 * object model rather than on the contract, and therefore the one key on which a
 * schema validator and a runtime validator can disagree while both believe they
 * are being strict. Every other unknown key is an ordinary own property and is
 * refused by the profile schema itself.
 */
export const FORBIDDEN_PROFILE_MAPPING_KEYS: readonly string[] = Object.freeze(['__proto__']);

/**
 * The parse options this contract is defined in: plain YAML 1.2 core schema, no
 * merge keys, and no warning routed to the process.
 */
const PROFILE_PARSE_OPTIONS = Object.freeze({
  version: '1.2' as const,
  merge: false,
  logLevel: 'silent' as const,
  // The prettifier splices the offending source line into an error or warning
  // message. Neither is ever surfaced, but a message that never carries profile
  // text cannot leak it through a later change either.
  prettyErrors: false,
});

export type ProfileDocumentOutcome =
  /** A single well-formed document, converted to the JSON data model. */
  | { readonly outcome: 'DOCUMENT'; readonly document: unknown }
  /** Not one well-formed, warning-free YAML 1.2 document. */
  | { readonly outcome: 'MALFORMED' }
  /** Well-formed, but carries mapping keys this contract refuses by name. */
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
        FORBIDDEN_PROFILE_MAPPING_KEYS.includes(key.value)
      ) {
        found += 1;
      }
    },
  });
  return found;
}

/**
 * Turns profile text into the JSON data model, or says why it could not.
 *
 * Never throws and never emits: an unparsable document, an excessive alias
 * expansion and a refused key are all return values.
 */
export function loadProfileDocument(text: string): ProfileDocumentOutcome {
  let documents;
  try {
    documents = parseAllDocuments(text, PROFILE_PARSE_OPTIONS);
  } catch {
    return { outcome: 'MALFORMED' };
  }

  // A profile is one document. A stream of several is refused here rather than
  // silently reduced to its first, which is what a single-document parse would
  // do once the logger is silent.
  if (documents.length > 1) return { outcome: 'MALFORMED' };

  // An empty stream carries no document. That is well-formed YAML which simply
  // is not a profile, so it is handed on as `null` for the contract to refuse —
  // the same answer an empty mapping would get.
  const document = documents[0];
  if (document === undefined) return { outcome: 'DOCUMENT', document: null };

  if (document.errors.length > 0) return { outcome: 'MALFORMED' };
  if (document.warnings.length > 0) return { outcome: 'MALFORMED' };

  const forbidden = countForbiddenKeys(document);
  if (forbidden > 0) return { outcome: 'FORBIDDEN_KEY', count: forbidden };

  try {
    // The library's own alias ceiling applies inside `toJS`; an expansion that
    // exceeds it throws rather than materialising.
    return { outcome: 'DOCUMENT', document: document.toJS() };
  } catch {
    return { outcome: 'MALFORMED' };
  }
}
