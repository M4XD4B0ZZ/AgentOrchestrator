/**
 * The public face of the one forge-mutation authority this build has.
 *
 * Everything outside `internal/` sees a type it cannot construct, a guard, and
 * a single-use accessor. The mint is not re-exported here, and a test walks the
 * tree to prove that exactly one module *calls* it — the same reachability pin
 * slice 3 put on the observation proof, for the same reason. An artefact whose
 * mint is callable from anywhere is a shape, not an authority.
 *
 * The same walk pins the smaller fact underneath: three modules may import the
 * declaring one. This sentence claimed one until a review counted them.
 *
 * The distinction the slice exists to hold is visible in what this file does
 * *not* export. There is no `MergeGrant`, no widening conversion, and no common
 * supertype with the pull-request authority V4 slice 6 added.
 * `CREATE_AUTHORIZED != MERGE_AUTHORIZED` is therefore a compile error and not
 * a comment, and so is passing this artefact where that one is demanded — which
 * is why slice 6 minted its own rather than widening this one.
 */

import {
  HeadPublicationGrant as HeadPublicationGrantClass,
  type HeadPublicationSubject,
} from './internal/head-publication-grant.js';

/**
 * The authority to publish exactly one delivery head.
 *
 * Exported as a type alias rather than as the class: a caller can name it, hold
 * it and pass it, and cannot call `new` on it or reach its constructor through
 * this module.
 */
export type HeadPublicationGrant = HeadPublicationGrantClass;

export type { HeadPublicationSubject };

/** Whether this build minted the value. Registry membership, not shape. */
export function isHeadPublicationGrant(value: unknown): value is HeadPublicationGrant {
  return HeadPublicationGrantClass.holds(value);
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
export function claimHeadPublication(
  grant: HeadPublicationGrant,
): HeadPublicationSubject | null {
  return HeadPublicationGrantClass.claim(grant);
}
