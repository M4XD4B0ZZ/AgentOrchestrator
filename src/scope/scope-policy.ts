/**
 * Whether one repository-relative path lies inside the scope a repository
 * declared for its writing agent.
 *
 * Pure: no Git, no filesystem, no clock. It answers one question about one
 * path. *Which* paths a task changed is a different question and belongs to
 * `task-delta.ts`, and where the declaration itself comes from belongs to
 * `pinned-scope.ts` — three separable facts that were one sentence in the
 * profile until V2-06 had to enforce it.
 *
 * ── Deny wins, and it wins by being asked first ────────────────────────────
 *
 * `protectedPaths` is not a second allow-list under another name. The profile
 * contract already states that it "wins over `allowedPaths`, so a carve-out
 * inside an allowed subtree is expressible" — and a carve-out only means
 * anything if it is consulted *before* the subtree containing it. So the
 * protected list is tested first and returns immediately. A path under
 * `app/generated` inside an allowed `app` is refused, and no ordering of the
 * two lists, and no relative specificity between two entries, can change that.
 *
 * A precedence rule expressed as "the more specific entry wins" would have been
 * the tempting alternative and is the wrong one: it makes the verdict depend on
 * comparing two declarations with each other, so a profile author widening an
 * allow entry could silently retract a protection they never touched.
 *
 * ── A declared path denotes a subtree, and the boundary is the separator ───
 *
 * `src` covers `src` itself and everything beneath it. The boundary is `/`:
 * `src/a.ts` is inside, `srcfoo.ts` is not. A bare `startsWith` would put
 * `srcfoo.ts` inside a scope of `src` — a prefix match on a string where the
 * contract is about a path, and one that hands a writer a whole family of
 * sibling names it was never granted.
 *
 * The declared entries cannot themselves carry a trailing slash, a `.` or `..`
 * segment, a drive letter or a backslash: `RepoRelativePathSchema` refused all
 * of those where the profile was read. This module therefore compares POSIX
 * paths to POSIX paths and does no normalisation of its own — normalising here
 * would be a second, quieter opinion about what a declared path means.
 *
 * ── Case is compared exactly ───────────────────────────────────────────────
 *
 * Git reports the path it recorded and this module compares it to the profile
 * as written. On a case-insensitive filesystem that means `SRC/a.ts` does not
 * match a declared `src`, and is refused.
 *
 * That is deliberately the fail-closed direction. Folding case so the two match
 * would *widen* a declared scope on exactly the platforms where a writer can
 * produce a spelling the profile author never wrote, and a scope that grows on
 * Windows and not on Linux is not a scope. A repository that genuinely wants
 * both spellings declares both.
 */

/**
 * The declaration a decision needs.
 *
 * Structural rather than an import of `ResolvedScopePolicy`, which satisfies it:
 * a scope read from a pinned commit is not a *resolved repository's* policy, and
 * making this module depend on the resolver would tie a pure comparison to the
 * whole repository-resolution contract.
 */
export interface DeclaredScope {
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
}

/** What a scope declaration says about one path. A closed vocabulary. */
export const SCOPE_DECISIONS = [
  /** Inside a declared allowed subtree and inside no protected one. */
  'ALLOWED',
  /** Inside a protected subtree. Refused whatever the allow list says. */
  'PROTECTED',
  /** Inside no declared allowed subtree at all. */
  'OUTSIDE_ALLOWED',
] as const;

export type ScopeDecision = (typeof SCOPE_DECISIONS)[number];

/** `true` when `path` is `declared` itself, or lies beneath it. */
function inside(path: string, declared: string): boolean {
  return path === declared || path.startsWith(`${declared}/`);
}

/**
 * Classifies one repository-relative POSIX path against a declared scope.
 *
 * Total: every path gets exactly one of the three decisions, and only
 * `ALLOWED` is permission. The two refusals are kept apart because they send an
 * operator to different places — "the writer touched a file you protected" and
 * "the writer touched a file outside anything you granted" are different
 * mistakes, and only the first implicates a carve-out.
 */
export function classifyPath(path: string, scope: DeclaredScope): ScopeDecision {
  if (scope.protectedPaths.some((declared) => inside(path, declared))) return 'PROTECTED';
  if (scope.allowedPaths.some((declared) => inside(path, declared))) return 'ALLOWED';
  return 'OUTSIDE_ALLOWED';
}
