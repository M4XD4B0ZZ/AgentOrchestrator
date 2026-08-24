/**
 * Observe, mutate at most once, observe again — for a pull request this time.
 *
 * The second function in this build that can change something on a forge. It is
 * `publish-delivery-head.ts`'s shape with one step more: that one has six, and
 * this one has seven, because the act it performs has a precondition a ref
 * update does not — the head must already be on the remote, at exactly the
 * intended commit, before a pull request can name it. Where it differs beyond
 * that, it differs because the far side does, and each difference is named
 * below.
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
 *    read a moment ago. Another process holding this repository's execution
 *    lease can advance a task while this command runs, so the facts are read
 *    again and compared in full — including the base branch and the composed
 *    text, because those are part of what was authorised.
 *
 * 3. **Establish that the remote is one repository.** `ls-remote` reads the
 *    fetch URL; the identity this build POSTs to comes from the push URL. When
 *    they differ, the head-ref reading below would be about a repository other
 *    than the one the pull request would be opened in. Two local questions, no
 *    request, and a refusal if they disagree — `UNKNOWN` counts as
 *    disagreement, because this is a precondition and not a diagnosis.
 *
 * 4. **Read the remote head ref.** Measured: GitHub refuses an object name in
 *    the `head` field — a full SHA of a commit that exists answers
 *    `422 {"field":"head","code":"invalid"}`, exactly as a missing branch does.
 *    So the request can only name a *branch*, and the only way this build can
 *    tie the pull request to the intended commit is to establish, immediately
 *    beforehand, that the branch holds it. This step is what makes the exact
 *    commit load-bearing at all, and it is the reason slice 5 had to exist
 *    first.
 *
 * 5. **Read the forge.** Which pull requests already carry this exact commit as
 *    their head, open or not. Not an optimisation: without it, `CREATED` and
 *    `ALREADY_EXISTS` are indistinguishable afterwards, and a second invocation
 *    would send a second request for a state that was already true.
 *
 * 6. **Send, at most once.** Only when nothing has this head. There is no retry
 *    loop, no backoff and no second attempt on any outcome. A creation is not
 *    idempotent in the transport, and re-sending one whose result was lost is
 *    how a build ends up having done a thing twice while reporting it once.
 *
 * 7. **Read the forge again, whatever the transport said.** Including after an
 *    apparent success, and especially after a failure: the case this exists for
 *    is the one where GitHub committed the effect and the answer never arrived.
 *
 * ── The step this refuses to take ─────────────────────────────────────────
 *
 * There is no compensating action. If the postcondition is not what was
 * intended, nothing is closed, retargeted, edited or retried — the outcome is
 * named and handed back. Each of those would be a further forge mutation, they
 * would run at exactly the moment least is known, and undo paths are where the
 * most destructive defects in this codebase have lived.
 *
 * ── What fences a concurrent creator, and what does not ───────────────────
 *
 * Less than slice 5 has, and this module says so rather than implying
 * otherwise. Publishing a ref is fenced by the ref update itself:
 * `--force-with-lease=<ref>:` is a compare-and-swap the *server* evaluates, so
 * two publishers racing cannot both win. **There is no documented equivalent
 * here.** What is established about GitHub is weaker and is measured rather
 * than assumed:
 *
 *  - uniqueness among *open* pull requests for one head and base is enforced
 *    somewhere server-side — `withastro/astro` carries 928 pull requests on one
 *    such pair with exactly one open;
 *  - it is delivered as a **validation error** (`422`, `resource: PullRequest`,
 *    `code: custom`), through the same layer that produces "No commits
 *    between". Nothing documents that layer's read and write as one
 *    transaction;
 *  - `gh pr create` does not rely on the server for this at all: it performs
 *    its own open-pull-request lookup first and fails locally, which is a plain
 *    check-then-act race and is what the mainstream client ships.
 *
 * So this build does **not** claim GitHub guarantees at most one pull request
 * is created. Its idempotency claim rests on four things it can point at: a
 * reading before, at most one request, a reading after, and a later invocation
 * that begins with a reading again. Two AO processes racing on one machine, or
 * on two clones, are a residual and are recorded as one — an execution lease
 * would not fence them either, because the object being raced for is on the
 * far side of the network.
 */

import {
  claimPullRequestCreation,
  type PullRequestCreationGrant,
} from './pull-request-creation-grant.js';
import type { PullRequestCreationSubject } from './internal/pull-request-creation-grant.js';
import {
  gradePullRequestCreation,
  type PullRequestAttempt,
  type PullRequestCreation,
  type PullRequestSituation,
} from './pull-request-creation.js';
import {
  classifyPullRequestSituation,
  SITUATION_UNKNOWN,
} from './pull-request-situation.js';
import {
  createPullRequestVia,
  type ForgeMutationRunner,
} from './github-pull-request-creator.js';
import { readPullCandidatesAtHead, type ForgeCommandRunner } from './github-observer.js';
import { createObservationSubject } from './forge-observation.js';
import {
  readRemoteRef,
  readUrlAgreement,
  type GitPublicationRunner,
} from './git-head-publisher.js';
import type { RemoteRefReading } from './head-publication.js';

/**
 * What the local subject still says, read again at the moment of acting.
 *
 * `null` means it could not be re-established, which is graded the same as "it
 * moved": both mean this invocation cannot show that what it is about to ask
 * for is still the task's delivery.
 */
export type CreationSubjectRecheck = () => Promise<PullRequestCreationSubject | null>;

export interface CreationSeams {
  readonly recheck: CreationSubjectRecheck;
  /** The Git seam, for the two local URL questions and the remote ref reading. */
  readonly gitRunner?: GitPublicationRunner | undefined;
  /** The forge **reading** seam. Slice 2's, unchanged. */
  readonly reader: ForgeCommandRunner;
  /** The forge **mutation** seam. Deliberately not the same one. */
  readonly mutator: ForgeMutationRunner;
  readonly envSource: NodeJS.ProcessEnv;
}

/** Everything the caller learned, including the readings the grade came from. */
export interface CreationResult {
  readonly creation: PullRequestCreation;
  /** What the delivery remote's head ref held, or `null` if it was never read. */
  readonly remoteHead: RemoteRefReading | null;
  readonly before: PullRequestSituation | null;
  readonly attempt: PullRequestAttempt;
  readonly after: PullRequestSituation | null;
}

function result(
  creation: PullRequestCreation,
  remoteHead: RemoteRefReading | null,
  before: PullRequestSituation | null,
  attempt: PullRequestAttempt,
  after: PullRequestSituation | null,
): CreationResult {
  return Object.freeze({ creation, remoteHead, before, attempt, after });
}

/**
 * Every field, compared. A subject that agrees on ten of eleven is a different
 * subject, and the eleventh is the one that would have been acted on.
 *
 * `remoteName` was missing from this list and a review found it. It is not a
 * decoration: it is the field the two *local* preconditions below are asked
 * about — `readUrlAgreement` and `readRemoteRef` both run against
 * `authorised.remoteName` — so a delivery remote repointed between the mint and
 * this check would have had the head-ref proof taken against one repository
 * while the request went to another. That is the hazard `REMOTE_URLS_DIVERGE`
 * exists to close, reached by the other route. The count in the sentence above
 * was wrong too, which is how the omission survived being read.
 */
function sameSubject(a: PullRequestCreationSubject, b: PullRequestCreationSubject): boolean {
  return (
    a.taskId === b.taskId &&
    a.host === b.host &&
    a.owner === b.owner &&
    a.name === b.name &&
    a.remoteName === b.remoteName &&
    a.headRef === b.headRef &&
    a.headCommit === b.headCommit &&
    a.baseRef === b.baseRef &&
    a.draft === b.draft &&
    a.title === b.title &&
    a.body === b.body
  );
}

/**
 * Reads which pull requests carry this exact commit as their head.
 *
 * A refusal of any kind becomes `UNKNOWN`. The refusal vocabulary is slice 2's
 * and is rich, but every member of it means the same thing here — this build
 * did not establish what is on the forge — and a mutation ladder that branched
 * on *why* it could not see would be a ladder deciding whether to act on the
 * shape of an error.
 */
async function readSituation(
  subject: PullRequestCreationSubject,
  seams: CreationSeams,
): Promise<PullRequestSituation> {
  const observation = createObservationSubject(
    { host: subject.host, owner: subject.owner, name: subject.name },
    subject.headCommit,
  );
  if (!observation.ok) return SITUATION_UNKNOWN;

  const read = await readPullCandidatesAtHead(observation.subject, {
    runner: seams.reader,
    envSource: seams.envSource,
  });
  if (!read.ok) return SITUATION_UNKNOWN;

  return classifyPullRequestSituation(read.candidates, subject.headCommit);
}

/**
 * Creates one pull request, or explains why it did not.
 *
 * The grant is the only way in. Its type cannot be constructed outside the
 * mint, so there is no boolean, no option object and no configuration value
 * that turns this function on — a caller either went through the mint or cannot
 * form an argument that type-checks. A `HeadPublicationGrant` does not
 * type-check here, and this grant does not type-check at `publishDeliveryHead`.
 *
 * `repositoryRoot` is where Git is run, and it comes from the resolved
 * repository rather than from the grant: the grant carries the *forge* identity
 * and must not also be the authority for which directory this build executes
 * in.
 */
export async function createPullRequest(
  grant: PullRequestCreationGrant,
  repositoryRoot: string,
  seams: CreationSeams,
): Promise<CreationResult> {
  const authorised = claimPullRequestCreation(grant);
  if (authorised === null) {
    return result('AUTHORITY_REFUSED', null, null, 'NOT_ATTEMPTED', null);
  }

  const still = await seams.recheck();
  if (still === null || !sameSubject(authorised, still)) {
    return result('SUBJECT_CHANGED', null, null, 'NOT_ATTEMPTED', null);
  }

  // One remote name must be one repository. `ls-remote` reads the fetch URL and
  // slice 1's delivery identity — the `owner/repo` in the request path — comes
  // from the push URL, so a remote whose two URLs differ would have the head
  // reading below describe a repository other than the one about to gain a pull
  // request. Both questions are local, and they are asked before anything is
  // contacted.
  const agreement = await readUrlAgreement(repositoryRoot, authorised.remoteName, seams.gitRunner);
  if (agreement !== 'AGREE') {
    return result('REMOTE_URLS_DIVERGE', null, null, 'NOT_ATTEMPTED', null);
  }

  const remoteHead = await readRemoteRef(
    repositoryRoot,
    authorised.remoteName,
    authorised.headRef,
    seams.gitRunner,
  );
  if (remoteHead.outcome === 'UNKNOWN') {
    return result('REMOTE_STATE_UNKNOWN', remoteHead, null, 'NOT_ATTEMPTED', null);
  }
  if (remoteHead.outcome === 'ABSENT') {
    return result('HEAD_NOT_PUBLISHED', remoteHead, null, 'NOT_ATTEMPTED', null);
  }
  if (remoteHead.commit !== authorised.headCommit) {
    return result('HEAD_SHA_MISMATCH', remoteHead, null, 'NOT_ATTEMPTED', null);
  }

  const before = await readSituation(authorised, seams);
  if (before.outcome !== 'NONE') {
    return result(
      gradePullRequestCreation(authorised, before, 'NOT_ATTEMPTED', null),
      remoteHead,
      before,
      'NOT_ATTEMPTED',
      null,
    );
  }

  const attempt = await createPullRequestVia(authorised, {
    runner: seams.mutator,
    envSource: seams.envSource,
  });

  const after = await readSituation(authorised, seams);

  return result(
    gradePullRequestCreation(authorised, before, attempt, after),
    remoteHead,
    before,
    attempt,
    after,
  );
}
