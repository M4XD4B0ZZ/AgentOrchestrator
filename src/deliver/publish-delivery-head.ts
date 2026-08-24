/**
 * Observe, mutate at most once, observe again.
 *
 * This was the only function in the build that could change something on a
 * forge until V4 slice 6 added `create-pull-request.ts`, which does the same six
 * steps in the same order for a different act. The two are separate functions
 * taking separate authorities, and neither can perform the other's effect. The
 * whole of this one's design is still the order of six steps and the refusal to
 * take a seventh.
 *
 * ── The order, and why each step is where it is ───────────────────────────
 *
 * 1. **Spend the authority.** First, before anything is read or contacted, and
 *    it is spent rather than checked: the grant is one-shot, and the only
 *    accessor that reveals what it authorises consumes it in the same call. A
 *    caller holding a used grant reaches `AUTHORITY_REFUSED` having contacted
 *    nothing. It is first because an unauthorised caller should not be able to
 *    make this build emit a network request at all — not even a read.
 *
 * 2. **Re-establish the local subject.** The grant was minted from a task state
 *    read a moment ago by someone else. Another process holding this
 *    repository's execution lease can advance a task while this command runs,
 *    so the facts are read again and compared. This is before the remote is
 *    touched, so a subject that has already moved costs nothing.
 *
 * 3. **Establish that the remote is one repository.** `ls-remote` reads the
 *    fetch URL and `push` writes to the push URL. When they differ, every
 *    reading below would be about the wrong repository. Two local questions,
 *    no request, and a refusal if they disagree — `UNKNOWN` counts as
 *    disagreement, because this is a precondition and not a diagnosis.
 *
 * 4. **Read the remote ref.** Not an optimisation. Measured, `git push` exits 0
 *    both when it creates a ref and when the ref already held the pushed
 *    object, and those are different events. Only the reading taken *before*
 *    the attempt can tell them apart, so without it this build could not
 *    honestly say whether it changed anything.
 *
 * 5. **Push, at most once.** Only when the ref is absent. There is no retry
 *    loop, no exponential backoff and no second attempt on any outcome. A
 *    create is not idempotent in the transport, and re-sending one whose result
 *    was lost is how a build ends up having done a thing twice while reporting
 *    it once.
 *
 * 6. **Read the remote ref again, whatever the transport said.** Including
 *    after an apparent success, and especially after a failure: the case this
 *    exists for is the one where GitHub committed the effect and the answer
 *    never arrived.
 *
 * ── The step this refuses to take ─────────────────────────────────────────
 *
 * There is no compensating action. If the postcondition is not what was
 * intended, nothing is deleted, moved or retried — the outcome is named and
 * handed back. A cleanup path is another mutation, it runs at exactly the
 * moment least is known, and undo paths are where the most destructive defects
 * in this codebase have lived.
 *
 * ── What fences a concurrent publisher ────────────────────────────────────
 *
 * Not a lock in this process, and deliberately not this repository's execution
 * lease. The fence is the ref update itself: `--force-with-lease=<ref>:` is a
 * compare-and-swap the *server* evaluates, so two publishers racing to create
 * the same ref cannot both win, whichever order they arrive in and whatever
 * either of them believed a moment earlier. A local lock would add nothing
 * against the case that matters — a second clone, another machine, a human with
 * a terminal — and taking the execution lease would additionally make a
 * delivery command contend with a running task for the whole repository, which
 * is the coupling slice 3 refused for a weaker reason than this one.
 *
 * The honest residual: the loser of that race is told `REF_HOLDS_ANOTHER_COMMIT`
 * or `CONVERGED_AFTER_UNCERTAIN_EFFECT` depending on what the winner published,
 * and neither of those is an error. Nothing here prevents a human from moving
 * the ref a second later.
 */

import { claimHeadPublication, type HeadPublicationGrant } from './head-publication-grant.js';
import type { HeadPublicationSubject } from './internal/head-publication-grant.js';
import {
  gradeHeadPublication,
  type HeadPublication,
  type PublicationAttempt,
  type RemoteRefReading,
} from './head-publication.js';
import {
  pushDeliveryHead,
  readRemoteRef,
  readUrlAgreement,
  type GitPublicationRunner,
} from './git-head-publisher.js';

/**
 * What the local subject still says, read again at the moment of acting.
 *
 * `null` means it could not be re-established, which is graded the same as
 * "it moved": both mean this invocation cannot show that what it is about to
 * publish is still the task's head.
 */
export type SubjectRecheck = () => Promise<HeadPublicationSubject | null>;

export interface PublicationSeams {
  readonly runner?: GitPublicationRunner | undefined;
  readonly recheck: SubjectRecheck;
}

/** Everything the caller learned, including the readings the grade came from. */
export interface PublicationResult {
  readonly publication: HeadPublication;
  readonly before: RemoteRefReading | null;
  readonly attempt: PublicationAttempt;
  readonly after: RemoteRefReading | null;
}

function result(
  publication: HeadPublication,
  before: RemoteRefReading | null,
  attempt: PublicationAttempt,
  after: RemoteRefReading | null,
): PublicationResult {
  return Object.freeze({ publication, before, attempt, after });
}

function sameSubject(a: HeadPublicationSubject, b: HeadPublicationSubject): boolean {
  return (
    a.host === b.host &&
    a.owner === b.owner &&
    a.name === b.name &&
    a.remoteName === b.remoteName &&
    a.ref === b.ref &&
    a.commit === b.commit
  );
}

/**
 * Publishes one delivery head, or explains why it did not.
 *
 * The grant is the only way in. Its type cannot be constructed outside the
 * mint, so there is no boolean, no option object and no configuration value
 * that turns this function on — a caller either went through the mint or cannot
 * form an argument that type-checks.
 *
 * `repositoryRoot` is where Git is run, and it comes from the resolved
 * repository rather than from the grant: the grant carries the *forge* identity
 * and must not also be the authority for which directory this build executes
 * in. It is the caller's own resolved root, the same one every other Git
 * command in this build uses.
 */
export async function publishDeliveryHead(
  grant: HeadPublicationGrant,
  repositoryRoot: string,
  seams: PublicationSeams,
): Promise<PublicationResult> {
  const authorised = claimHeadPublication(grant);
  if (authorised === null) return result('AUTHORITY_REFUSED', null, 'NOT_ATTEMPTED', null);

  const still = await seams.recheck();
  if (still === null || !sameSubject(authorised, still)) {
    return result('SUBJECT_CHANGED', null, 'NOT_ATTEMPTED', null);
  }

  // One remote name must be one repository. `ls-remote` reads the fetch URL
  // and `push` writes to the push URL, and slice 1's identity comes from the
  // push URL — so a remote whose two URLs differ would have every reading here
  // describe a repository other than the one about to change. Both questions
  // are local, and they are asked before anything is contacted.
  const agreement = await readUrlAgreement(repositoryRoot, authorised.remoteName, seams.runner);
  if (agreement !== 'AGREE') {
    return result('REMOTE_URLS_DIVERGE', null, 'NOT_ATTEMPTED', null);
  }

  const before = await readRemoteRef(
    repositoryRoot,
    authorised.remoteName,
    authorised.ref,
    seams.runner,
  );

  // Anything other than a confirmed absence ends here, with nothing attempted.
  // `gradeHeadPublication` decides which of the three it is, so the reading —
  // not this function's reading of the reading — is what the answer rests on.
  if (before.outcome !== 'ABSENT') {
    return result(
      gradeHeadPublication(authorised.commit, before, 'NOT_ATTEMPTED', null),
      before,
      'NOT_ATTEMPTED',
      null,
    );
  }

  const completed = await pushDeliveryHead(
    repositoryRoot,
    authorised.remoteName,
    authorised.ref,
    authorised.commit,
    seams.runner,
  );
  const attempt: PublicationAttempt = completed ? 'COMPLETED' : 'FAILED';

  const after = await readRemoteRef(
    repositoryRoot,
    authorised.remoteName,
    authorised.ref,
    seams.runner,
  );

  return result(gradeHeadPublication(authorised.commit, before, attempt, after), before, attempt, after);
}
