/**
 * What the three parts of a forge repository identity may be.
 *
 * These rules lived as private constants in `deliver/delivery-target.ts` until
 * V4 slice 17 needed them a second time, and they were moved rather than
 * copied. That is the move `internal/delivery-ref-grammar.ts` already records
 * for the ref grammar, made for the same reason and with the same limit in
 * mind: a second copy is free to drift from the first, and a review has already
 * found one in this repository.
 *
 * The second consumer is a **reader**. `publication-command.ts` bounds the
 * identity an operator types before comparing it with a stored one, and the
 * only bound that cannot disagree with the writer's is the writer's own. What
 * it may not do is reach the writer to get it: `delivery-target.ts` carries a
 * type edge to `repo/git-query.ts`, which reaches `doctor/exec.ts`, and the
 * suite's closure sweep follows type edges — so importing that module for a
 * regular expression would put `spawn` in a read-only command's swept graph.
 * This module imports nothing at all.
 *
 * They are exported as **predicates and not as patterns**, which is the one
 * thing this module adds. A repository name is two rules and not one — the
 * character class, and a separate refusal of a name made only of dots — and a
 * second caller handed the character class alone would have been free to apply
 * one without the other. There is nothing here to forget.
 */

/**
 * A dotted host name. Refuses `:` and `[` by omission, which is why no separate
 * port or IPv6 check exists: an earlier version had one, and no input could
 * reach it — both spellings die here, with the same code.
 *
 * At least two labels, so a bare hostname is refused — a delivery target must
 * be named by a fully qualified host, and requiring the dot is also what keeps
 * a Windows drive letter out of the scp-like branch of the URL parser:
 * `D:/work/repo` would otherwise present `D` as a host.
 *
 * **Lowercase only**, and that is a bound rather than a folding rule. The URL
 * parser lowercases once, before it asks, so every identity this build resolves
 * is carried in this spelling; nothing here changes a value, and a caller
 * comparing what it was handed is comparing what it was handed.
 */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * An owning user or organisation.
 *
 * GitHub's published account-name grammar: alphanumerics and hyphens, no
 * leading or trailing hyphen, at most 39 characters. Enforced rather than
 * assumed because these characters become an argument to another program later;
 * being stricter than a forge needs is the safe direction, and a name this
 * refuses is reported as a refusal rather than passed on.
 */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * A repository name's character class.
 *
 * Alphanumerics, dot, underscore and hyphen — but **not a leading hyphen**, for
 * the reason given for the owner: a repository name reaches an argument vector
 * on exactly the same paths, and `-oProxyCommand` is not a name to hand onward.
 * A leading dot *is* allowed, because `.github` is an ordinary repository name,
 * which is why a name made only of dots is refused by the second rule below.
 */
const NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

/** A name that is only dots — `.`, `..`, `...` — is never a repository. */
const ALL_DOTS = /^\.+$/;

export function isForgeHost(value: string): boolean {
  return HOST_PATTERN.test(value);
}

export function isForgeOwner(value: string): boolean {
  return OWNER_PATTERN.test(value);
}

/** Both halves of the rule, so no caller can apply one without the other. */
export function isForgeRepositoryName(value: string): boolean {
  return NAME_PATTERN.test(value) && !ALL_DOTS.test(value);
}
