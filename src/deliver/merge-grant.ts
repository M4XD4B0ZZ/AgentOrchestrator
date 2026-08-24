/**
 * The public face of the third forge-mutation authority this build has.
 *
 * Everything outside `internal/` sees a type it cannot construct, a guard, and
 * a single-use accessor. The mint is not re-exported here, and a test walks the
 * tree to prove that exactly one module *calls* it — the same reachability pin
 * slice 3 put on the observation proof, slice 5 on the publication grant and
 * slice 6 on the creation grant, for the same reason. An artefact whose mint is
 * callable from anywhere is a shape, not an authority.
 *
 * The same walk pins the smaller fact underneath: which modules may import the
 * declaring one at all. That set is four, not one, because three of them need
 * the subject type. Slice 6's copy of this sentence said "one" until a review
 * counted them, and the count is written here from the test rather than from
 * the intention.
 *
 * The distinction this slice exists to hold is visible in what this file does
 * *not* export. There is no `PullRequestUpdateGrant`, no `AutoMergeGrant`, no
 * `MergeQueueGrant`, no widening conversion to or from either sibling and no
 * common supertype. `MERGE_AUTHORIZED != PUBLISH_AUTHORIZED` and
 * `MERGE_AUTHORIZED != CREATE_PR_AUTHORIZED` are therefore compile errors and
 * not comments — slice 6's header predicted this artefact and said a future
 * slice that wanted to merge would have to mint its own and say so. This is
 * that artefact, and it is a third one rather than a widening of either.
 */

import {
  MergeGrant as MergeGrantClass,
  type MergeSubject,
} from './internal/merge-grant.js';

/**
 * The authority to merge exactly one pull request.
 *
 * Exported as a type alias rather than as the class: a caller can name it, hold
 * it and pass it, and cannot call `new` on it or reach its constructor through
 * this module.
 */
export type MergeGrant = MergeGrantClass;

export type { MergeSubject };

/** Whether this build minted the value. Registry membership, not shape. */
export function isMergeGrant(value: unknown): value is MergeGrant {
  return MergeGrantClass.holds(value);
}

/**
 * Spends the grant and returns what it authorises, or `null`.
 *
 * `null` covers three cases on purpose and distinguishes none of them: the
 * value was never minted, it was minted and has already been spent, or it
 * passed the registry gate without carrying the facts. All three mean the same
 * thing to a caller about to change something on a remote — you do not have
 * authority for this — and a caller able to tell them apart would be a caller
 * reasoning about an authority that is not its own.
 */
export function claimMerge(grant: MergeGrant): MergeSubject | null {
  return MergeGrantClass.claim(grant);
}
