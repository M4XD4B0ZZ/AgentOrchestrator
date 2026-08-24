/**
 * The two grammars every delivery mutation shares.
 *
 * They lived in `internal/head-publication-grant.ts` until V4 slice 6 needed
 * them too, and they were moved rather than copied. The reason is a property
 * the suite measures and would otherwise have lost: exactly three modules in
 * `src/` may import `internal/head-publication-grant.js`, because that module
 * declares an authority and the set of files that can reach a mint is a fact
 * worth pinning. A second authority importing it *for a regular expression*
 * would have widened that set without widening what anybody can do — the pin
 * would have had to be loosened, and a loosened pin measures less.
 *
 * So the grammars sit here, in a module that declares no authority and can be
 * imported by anything. `internal/head-publication-grant.ts` re-exports
 * {@link PUBLISHABLE_REF} so slice 5's callers are unchanged.
 */

/**
 * `refs/heads/` followed by a branch name this build will put in an argument
 * vector. The character class is `repo/branch-name.ts`'s, narrowed further by
 * `doctor/exec.ts`'s shell-inert grammar: no space, no quote, no metacharacter.
 * A leading `-` is impossible because `refs/heads/` precedes it.
 *
 * Shared because the command ladder needs the same rule to decide whether a
 * work branch can become a ref *before* it asks for an authority. A second copy
 * there would be free to drift from this one — the argument `doctor/exec.ts`
 * makes about `SAFE_ARG_PATTERN`, and a review found the second copy.
 */
export const PUBLISHABLE_REF = /^refs\/heads\/[A-Za-z0-9._+=@/-]+$/;

/**
 * Names this build will put in an argument vector as a remote.
 *
 * Both delivery mutations ask local Git questions about a named remote before
 * they act, and the remote name is the one place a URL could enter the vector —
 * which is the value most likely to carry a credential.
 */
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
