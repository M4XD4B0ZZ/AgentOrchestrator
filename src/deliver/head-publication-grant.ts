/**
 * The public face of the one forge-mutation authority this build has.
 *
 * Everything outside `internal/` sees a type it cannot construct, a guard, and
 * a single-use accessor. The mint is not re-exported here, and a test walks the
 * tree to prove exactly one module imports it — the same reachability pin slice
 * 3 put on the observation proof, for the same reason. An artefact whose mint
 * is importable from anywhere is a shape, not an authority.
 *
 * The distinction the slice exists to hold is visible in what this file does
 * *not* export. There is no `MergeGrant`, no `PullRequestGrant`, no widening
 * conversion, and no common supertype. `CREATE_AUTHORIZED != MERGE_AUTHORIZED`
 * is therefore a compile error and not a comment: a future slice that wants to
 * open a pull request will have to mint its own artefact and say so, and it
 * cannot pass this one where its own is demanded.
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
