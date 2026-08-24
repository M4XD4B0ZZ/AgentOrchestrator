/**
 * Observe, mutate at most once, observe again — for a merge this time.
 *
 * The third function in this build that can change something on a forge, and it
 * is `publish-delivery-head.ts`'s and `create-pull-request.ts`'s shape with one
 * step *fewer*. Those two ask local Git questions first, because both act on a
 * ref this machine has a copy of. **This one asks none**: a merge is one HTTP
 * request against a pull-request number, the identity it goes to comes from the
 * delivery target the re-check re-resolves, and there is no local object whose
 * state could make the request mean something else. A precondition that read
 * `ls-remote` here would be a precondition about a question this act does not
 * ask, and the honest thing is to not ask it rather than to ask it for symmetry.
 *
 * ── The order, and why each step is where it is ───────────────────────────
 *
 * 1. **Spend the authority.** First, before anything is read or contacted, and
 *    it is spent rather than checked: the grant is one-shot, and the only
 *    accessor that reveals what it authorises consumes it in the same call. A
 *    caller holding a used grant reaches `AUTHORITY_REFUSED` having contacted
 *    nothing. It is first because an unauthorised caller should not be able to
 *    make this build emit a request at all — not even a read.
 *
 * 2. **Re-establish the local subject.** The grant was minted from a task state
 *    and a delivery target read a moment ago. Another process holding this
 *    repository's execution lease can advance a task while this command runs, so
 *    the facts are read again and compared in full.
 *
 * 3. **Read the pull request, by number.** Not by head commit, and that is a
 *    correction of instrument rather than a preference. Measured: after a squash
 *    merge the head object name is on no branch, and a pull request merged at
 *    *another* head no longer answers the commit-keyed locator for this one — so
 *    a build that read the postcondition by head could not see a merge it may
 *    itself have caused. The mutation is addressed by number; the reading has to
 *    be too.
 *
 * 4. **Refuse from that reading, or proceed.** Every refusal here costs no
 *    request. The list includes one GitHub does not make: a **closed, unmerged**
 *    pull request is merged by the endpoint — measured — so "it is open" is this
 *    build's precondition and not the server's.
 *
 * 5. **Send, at most once.** Only when the reading says the intended merge is
 *    still the thing in front of it. There is no retry loop, no backoff and no
 *    second attempt on any outcome. A second request against a merged pull
 *    request answers `200 merged=true` and proves nothing, so a blind retry
 *    would not even be *detectably* wrong — it would just be a success-shaped
 *    answer to a question nobody asked.
 *
 * 6. **Read again, whatever the transport said.** Including after an apparent
 *    success, and especially after a failure: the case this exists for is the one
 *    where GitHub committed the merge and the answer never arrived.
 *
 * ── The step this refuses to take ─────────────────────────────────────────
 *
 * There is no compensating action. If the postcondition is not what was
 * intended, nothing is reverted, reopened, retargeted or retried — the outcome
 * is named and handed back. A revert is a further mutation on the base branch,
 * it would run at exactly the moment least is known, and undo paths are where
 * the most destructive defects in this codebase have lived.
 *
 * There is also no local write. This function does not advance the task, does
 * not record anything and does not take the execution lease, so after a merge
 * this build's `READY_FOR_PR` and GitHub's `merged` disagree. That mismatch is
 * deliberate and is the next slice's subject; it is not repaired here by a state
 * write nobody reviewed.
 *
 * ── What fences a concurrent merger, and what does not ────────────────────
 *
 * More than slice 6 has and about as much as slice 5. The fence is the request's
 * own `sha`: GitHub is documented to refuse when the pull request head does not
 * match it, and — measured — answers `409 "Head branch was modified"` and merges
 * nothing. That is a compare-and-swap the *server* evaluates, so a push that
 * lands between step 3 and step 5 cannot be merged by this request.
 *
 * Three things it does **not** fence, stated rather than implied:
 *
 *  - **the base.** The endpoint takes no expected base commit, and the merge
 *    happens against whatever the base ref holds at that moment. This build
 *    binds the base *name* and compares it, and does not claim to have frozen
 *    the branch.
 *  - **a concurrent merge.** Measured, the fence does not apply once the pull
 *    request is merged: an already-merged pull request answers `200` whatever
 *    `sha` is sent. So a merge by somebody else, at another head, between the
 *    reading and the request is not refused — it is *detected*, afterwards, as
 *    `POSTCONDITION_MISMATCH`.
 *  - **policy.** Reviews, required checks and repository rules are GitHub's to
 *    enforce and this build does not observe them. On a repository with none,
 *    nothing on the far side will refuse this request, and the operator's
 *    explicit authorisation is the only policy decision there is.
 *
 * An execution lease would fence none of these, for slice 6's reason: the object
 * being raced for is on the far side of the network, and two clones of one
 * remote hold two different leases.
 */

import { claimMerge, type MergeGrant } from './merge-grant.js';
import type { MergeSubject } from './internal/merge-grant.js';
import {
  gradeMerge,
  gradeMergePrecondition,
  mergeIsEstablished,
  MERGE_READING_UNKNOWN,
  type MergeAttempt,
  type MergeOutcome,
  type MergeReading,
} from './pull-request-merge.js';
import { mergePullRequestVia, type ForgeMergeRunner } from './github-pull-request-merger.js';
import { readPullRequestByNumber, type ForgeCommandRunner } from './github-observer.js';
import { createObservationSubject } from './forge-observation.js';

/**
 * What the local subject still says, read again at the moment of acting.
 *
 * `null` means it could not be re-established, which is graded the same as "it
 * moved": both mean this invocation cannot show that what it is about to merge
 * is still the task's delivery.
 */
export type MergeSubjectRecheck = () => Promise<MergeSubject | null>;

export interface MergeSeams {
  readonly recheck: MergeSubjectRecheck;
  /** The forge **reading** seam. Slice 2's, unchanged. */
  readonly reader: ForgeCommandRunner;
  /** The forge **merge** seam. Deliberately not slice 2's and not slice 6's. */
  readonly merger: ForgeMergeRunner;
  readonly envSource: NodeJS.ProcessEnv;
}

/** Everything the caller learned, including the readings the grade came from. */
export interface MergeResult {
  readonly outcome: MergeOutcome;
  readonly before: MergeReading | null;
  readonly attempt: MergeAttempt;
  readonly after: MergeReading | null;
  /**
   * The commit the merge produced, or `null`.
   *
   * Non-null only under a member of `ESTABLISHED_MERGES`, and only ever copied
   * out of the reading taken *afterwards*. It is never taken from the response,
   * never derived from the head, and never guessed from local history: under a
   * squash merge it is a commit that exists on the base branch and nowhere this
   * machine can compute it from.
   */
  readonly mergeCommit: string | null;
}

function result(
  outcome: MergeOutcome,
  before: MergeReading | null,
  attempt: MergeAttempt,
  after: MergeReading | null,
): MergeResult {
  // Gated on the OUTCOME and not on the reading, which is a correction a case in
  // the suite found. Reading `after.outcome === 'MERGED'` was enough to fill
  // this field under `POSTCONDITION_MISMATCH` — a pull request that really is
  // merged, at a head or into a base this invocation did not authorise — and
  // the report labels the field `Merge commit`, so it would have offered a
  // commit for somebody else's merge as this delivery's result.
  //
  // Nothing is hidden by the narrowing: the reading is carried whole, and the
  // renderer prints it as `Forge after : MERGED <sha>`, which is where a commit
  // this build did not attribute to itself belongs.
  const mergeCommit =
    mergeIsEstablished(outcome) && after !== null && after.outcome === 'MERGED'
      ? after.mergeCommit
      : null;
  return Object.freeze({ outcome, before, attempt, after, mergeCommit });
}

/**
 * Every field, compared. A subject that agrees on seven of eight is a different
 * subject, and the eighth is the one that would have been acted on.
 */
function sameSubject(a: MergeSubject, b: MergeSubject): boolean {
  return (
    a.taskId === b.taskId &&
    a.host === b.host &&
    a.owner === b.owner &&
    a.name === b.name &&
    a.pullRequestNumber === b.pullRequestNumber &&
    a.expectedHeadCommit === b.expectedHeadCommit &&
    a.baseRef === b.baseRef &&
    a.mergeMethod === b.mergeMethod
  );
}

/**
 * Reads the one pull request this merge is about.
 *
 * A refusal of any kind becomes `UNKNOWN`. The refusal vocabulary is slice 2's
 * and is rich, but every member of it means the same thing here — this build did
 * not establish what the pull request is — and a mutation ladder that branched
 * on *why* it could not see would be a ladder deciding whether to act on the
 * shape of an error.
 */
async function readPullRequest(
  subject: MergeSubject,
  seams: MergeSeams,
): Promise<MergeReading> {
  const observation = createObservationSubject(
    { host: subject.host, owner: subject.owner, name: subject.name },
    subject.expectedHeadCommit,
  );
  if (!observation.ok) return MERGE_READING_UNKNOWN;

  const read = await readPullRequestByNumber(observation.subject, subject.pullRequestNumber, {
    runner: seams.reader,
    envSource: seams.envSource,
  });
  if (!read.ok) return MERGE_READING_UNKNOWN;

  return read.reading;
}

/**
 * Merges one pull request, or explains why it did not.
 *
 * The grant is the only way in. Its type cannot be constructed outside the mint,
 * so there is no boolean, no option object and no configuration value that turns
 * this function on — a caller either went through the mint or cannot form an
 * argument that type-checks. Neither sibling authority type-checks here, and
 * this one type-checks at neither sibling's effect.
 *
 * There is no `repositoryRoot` parameter, and its absence is the point: this
 * function starts no local process and reads no local file. Where Git would run
 * is not a question a merge has.
 */
export async function mergePullRequest(
  grant: MergeGrant,
  seams: MergeSeams,
): Promise<MergeResult> {
  const authorised = claimMerge(grant);
  if (authorised === null) {
    return result('AUTHORITY_REFUSED', null, 'NOT_ATTEMPTED', null);
  }

  const still = await seams.recheck();
  if (still === null || !sameSubject(authorised, still)) {
    return result('SUBJECT_CHANGED', null, 'NOT_ATTEMPTED', null);
  }

  const intended = {
    pullRequestNumber: authorised.pullRequestNumber,
    expectedHeadCommit: authorised.expectedHeadCommit,
    baseRef: authorised.baseRef,
  };

  const before = await readPullRequest(authorised, seams);
  const refusal = gradeMergePrecondition(intended, before);
  if (refusal !== null) {
    // Every member this can return carries "nothing was attempted", and nothing
    // is. `ALREADY_MERGED` is among them, which is the whole idempotency claim:
    // a second invocation sends no request, because the state it would have
    // asked for is already true and asking would answer `200` either way.
    //
    // The resulting commit is still reported when the reading found one, so an
    // operator re-running this gets the commit identity without a mutation.
    return Object.freeze({
      outcome: refusal,
      before,
      attempt: 'NOT_ATTEMPTED' as const,
      after: null,
      mergeCommit: before.outcome === 'MERGED' ? before.mergeCommit : null,
    });
  }

  const attempt = await mergePullRequestVia(authorised, {
    runner: seams.merger,
    envSource: seams.envSource,
  });

  const after = await readPullRequest(authorised, seams);

  return result(gradeMerge(intended, before, attempt, after), before, attempt, after);
}
