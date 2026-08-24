/**
 * The public face of the second forge-mutation authority this build has.
 *
 * Everything outside `internal/` sees a type it cannot construct, a guard, and
 * a single-use accessor. The mint is not re-exported here, and a test walks the
 * tree to prove exactly one module imports it — the same reachability pin slice
 * 3 put on the observation proof and slice 5 put on the publication grant, for
 * the same reason. An artefact whose mint is importable from anywhere is a
 * shape, not an authority.
 *
 * The distinction this slice exists to hold is visible in what this file does
 * *not* export. There is no `MergeGrant`, no `PullRequestUpdateGrant`, no
 * widening conversion to or from `HeadPublicationGrant`, and no common
 * supertype. `CREATE_PR_AUTHORIZED != PUBLISH_AUTHORIZED` and
 * `CREATE_PR_AUTHORIZED != MERGE_AUTHORIZED` are therefore compile errors and
 * not comments: a future slice that wants to merge will have to mint its own
 * artefact and say so, and it cannot pass this one where its own is demanded.
 */

import {
  PullRequestCreationGrant as PullRequestCreationGrantClass,
  type PullRequestCreationSubject,
} from './internal/pull-request-creation-grant.js';

/**
 * The authority to create exactly one pull request.
 *
 * Exported as a type alias rather than as the class: a caller can name it, hold
 * it and pass it, and cannot call `new` on it or reach its constructor through
 * this module.
 */
export type PullRequestCreationGrant = PullRequestCreationGrantClass;

export type { PullRequestCreationSubject };

/** Whether this build minted the value. Registry membership, not shape. */
export function isPullRequestCreationGrant(
  value: unknown,
): value is PullRequestCreationGrant {
  return PullRequestCreationGrantClass.holds(value);
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
export function claimPullRequestCreation(
  grant: PullRequestCreationGrant,
): PullRequestCreationSubject | null {
  return PullRequestCreationGrantClass.claim(grant);
}
