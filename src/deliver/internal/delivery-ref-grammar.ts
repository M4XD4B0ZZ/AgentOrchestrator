/**
 * The grammars every delivery mutation shares.
 *
 * The first two lived in `internal/head-publication-grant.ts` until V4 slice 6
 * needed them too, and they were moved rather than copied. The reason is a
 * property the suite measures and would otherwise have lost: exactly three
 * modules in `src/` may import `internal/head-publication-grant.js`, because
 * that module declares an authority and the set of files that can reach a mint
 * is a fact worth pinning. A second authority importing it *for a regular
 * expression* would have widened that set without widening what anybody can do
 * — the pin would have had to be loosened, and a loosened pin measures less.
 *
 * V4 slice 7 moved {@link DELIVERY_BASE_REF} and {@link isSendableBranchName}
 * here from `internal/pull-request-creation-grant.ts` for exactly the same
 * reason, one authority later: the merge authority needs the branch-name rule
 * and must not have to import slice 6's mint to get it.
 *
 * So the grammars sit here, in a module that declares no authority and can be
 * imported by anything. `internal/head-publication-grant.ts` re-exports
 * {@link PUBLISHABLE_REF} and `internal/pull-request-creation-grant.ts`
 * re-exports the branch-name pair, so neither slice's callers are changed.
 */

import { isValidBranchName } from '../../repo/branch-name.js';

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

/**
 * The base branch's grammar: the tail of `PUBLISHABLE_REF`, on its own.
 *
 * The base is sent as a branch **name** — `main`, not `refs/heads/main` — so it
 * cannot reuse the ref pattern directly. The character class is the same one,
 * for the same reason: this value ends up in a JSON body this build composes,
 * and a base that is not a plain branch name is a base this build cannot show
 * it understood. A leading `-` is refused explicitly, because unlike the head
 * ref there is no `refs/heads/` in front of it to make one impossible.
 *
 * The task-state schema constrains `baseBranch` to a non-blank string and no
 * further, so this is the first place the value meets a grammar at all.
 */
export const DELIVERY_BASE_REF = /^[A-Za-z0-9._+=@][A-Za-z0-9._+=@/-]*$/;

/**
 * The rule a base and a work branch must actually pass.
 *
 * {@link DELIVERY_BASE_REF} is the shell-inert character class and it is not
 * enough on its own: it accepts `@`, `a..b`, `a//b`, `main/`, `main.`, `a/.b`
 * and `x.lock`, and it has no length bound at all. Whichever mint applies it
 * was the loosest gate the value met and the one claiming to have understood it.
 *
 * So the names are additionally put through `repo/branch-name.ts`, which is
 * where this build already decides what a branch name is. Measured, that
 * refuses every value listed above and caps the length at 255, which is what
 * bounds slice 6's composed body; the body had no bound at all before it.
 *
 * **That rule is this build's, and it is not Git's**, which is stated here
 * because three review rounds in a row read it as Git's and wrote something
 * false on the strength of that. It implements the `check-ref-format --branch`
 * rules and — measured against real Git — it is not equivalent to them: there
 * is at least one name Git accepts that it refuses, and at least one it accepts
 * that Git refuses. What the rule is, is `repo/branch-name.ts`'s subject. This
 * docblock does not carry a second copy of the answer, because every copy of it
 * elsewhere has been wrong.
 *
 * The one difference that matters at this seam is stated, because a later
 * paragraph used to depend on it: `refs/heads/main` and `HEAD` both pass
 * `isValidBranchName` — measured — so both can reach a request.
 *
 * What GitHub would do with either as a `base` is deliberately not stated here,
 * and nothing rests on it. The safety comes from this build's own comparisons:
 * both `gradePullRequestCreation` and `gradeMerge` compare the base by exact
 * string equality against the bare name GitHub reports, so a run intending
 * `refs/heads/main` or `HEAD` fails closed rather than converging on a pull
 * request it did not mean. That property is readable in this repository; a
 * sentence about the far side's behaviour would not be, and four consecutive
 * batches of slice 6 broke on one.
 *
 * It is deliberately stricter than {@link PUBLISHABLE_REF}, which slice 5 uses
 * and which carries `L-V4-05-9` — a work branch that slice 5 will publish and
 * slice 6 will refuse is a real difference, and it is the safe direction. This
 * paragraph used to close by generalising that into a rule about Git, and the
 * rule was false: measured, Git refuses `HEAD` as a branch and this gate
 * accepts it. The comparison that is true is the one between the two gates in
 * this build, and it stops there.
 */
export function isSendableBranchName(name: string): boolean {
  return DELIVERY_BASE_REF.test(name) && isValidBranchName(name);
}
