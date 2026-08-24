/**
 * What happened to the delivery head, decided from observations rather than
 * from the transport's opinion of itself.
 *
 * This module is pure. It imports no filesystem, no clock, no process, no task
 * state and no lease. It takes two readings of a remote ref — one from before
 * the attempt and one from after — plus what the transport reported, and
 * returns one word. That shape is the point: the postcondition is established
 * by looking, and the transport's exit code is only allowed to distinguish
 * between two cases that looking cannot tell apart.
 *
 * ── Why the exit code cannot be the answer ────────────────────────────────
 *
 * Measured, on git 2.x against github.com, with the vector this build uses:
 *
 *   ref absent          -> `*  [new branch]`          exit 0
 *   ref already at SHA  -> `=  [up to date]`          exit 0
 *   ref at another SHA  -> `!  [rejected] (stale info)` exit 1
 *
 * The first two are both exit 0 and they are not the same event: one changed
 * the remote and one did not. A build that reported "published" for exit 0
 * would claim an effect it may not have had, and — worse — would claim it
 * *first*, on the run that actually did nothing. The distinction is only
 * visible in the *pre*-reading, which is why one is taken.
 *
 * The second measured surprise is subtler and is the reason the pre-reading is
 * not merely an optimisation: when the pushed object name already equals the
 * remote ref's, git answers `Everything up-to-date` **without evaluating the
 * lease at all**. The compare-and-swap that protects every other case is simply
 * not consulted. Nothing is wrong with that — there is no update to protect —
 * but it means the safety argument for this slice cannot be "the lease decides
 * everything", and the code should not imply it does.
 *
 * ── Why the lease is the empty one, always ────────────────────────────────
 *
 * The push is written `--force-with-lease=<ref>:` with no expected value.
 * Measured, that means *this ref must not exist*: it accepts a create, and
 * rejects an existing ref with `(stale info)` even when the update would be a
 * clean fast-forward. That is a compare-and-swap evaluated during the ref
 * update, on the server, not a check this process performs and then hopes
 * holds.
 *
 * A non-empty expected value was measured too, and it is exactly what this
 * build must never send: with the correct current value the same command
 * performs a **forced update** and rewrites the branch. There is no input under
 * which this slice wants that, so the expected value is not a parameter, not a
 * variable and not derived from anything — it is absent from the vector's
 * construction, and a test reads the vector to prove it.
 *
 * ── What this decides, and what it does not ───────────────────────────────
 *
 * It decides whether the delivery remote now holds this exact commit under this
 * exact ref. That is all. It is not a claim that a pull request exists, that
 * one could be opened, that the base branch is where anyone thinks it is, that
 * checks have run, or that anything is mergeable. Publishing a head is the
 * prerequisite for opening a pull request and is not the same act; this build
 * performs the first and does not perform the second.
 */

/**
 * What a single read of the remote ref established.
 *
 * `UNKNOWN` is a first-class member, not an error to be smoothed over. A read
 * that could not be completed is the case in which a mutation's outcome is
 * genuinely uncertain, and collapsing it into "absent" would turn "I could not
 * look" into "it is not there" — which is the shape of every false negative
 * this build has had to unpick before.
 */
export const REMOTE_REF_READINGS = ['ABSENT', 'AT_COMMIT', 'UNKNOWN'] as const;
export type RemoteRefReadingOutcome = (typeof REMOTE_REF_READINGS)[number];

export interface RemoteRefReading {
  readonly outcome: RemoteRefReadingOutcome;
  /** The object name the ref holds; non-null only for `AT_COMMIT`. */
  readonly commit: string | null;
}

/**
 * What the transport reported about its own attempt.
 *
 * Deliberately three words and not an exit code: a number invites arithmetic,
 * and the only thing this layer is allowed to do with the transport's opinion
 * is choose between two readings-consistent explanations.
 *
 * `NOT_ATTEMPTED` is what the orchestration passes when it decided, from the
 * pre-reading alone, that there was nothing to do or nothing it was willing to
 * do. `COMPLETED` means the command ran and exited zero. `FAILED` means it ran
 * and exited non-zero, or did not run, or was killed, or exceeded a bound —
 * every one of which leaves the remote in a state only a reading can settle.
 */
export const PUBLICATION_ATTEMPTS = ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const;
export type PublicationAttempt = (typeof PUBLICATION_ATTEMPTS)[number];

/**
 * The closed vocabulary. Ordered as the ladder decides, weakest claim first.
 *
 * Every member is a statement about the remote ref, and each one says why it is
 * not the member beside it.
 */
export const HEAD_PUBLICATIONS = [
  /**
   * No subject was established, so there is nothing this could be about.
   *
   * The delivery target did not resolve, the task state could not be read, the
   * task has no current commit, or the work branch is not a name this build
   * will put in an argument vector. Ahead of every other member because a
   * refusal about a subject that does not exist would be describing nothing.
   */
  'SUBJECT_NOT_ESTABLISHED',
  /**
   * The task is not finished, so its head is not a delivery head.
   *
   * `READY_FOR_PR` is the state at which the work is settled and provable — a
   * resolved `currentCommit`, a clean worktree at the checkpoint, a completed
   * review round. Publishing the head of a task still being worked on would put
   * a moving target on a remote under a name that says it is finished.
   */
  'TASK_NOT_READY',
  /**
   * `--publish-head` was given and `--attended` was not.
   *
   * A member rather than a silence: the operator asked for a mutation and did
   * not say they were present for it, and answering nothing at all would hide a
   * refusal behind a default. The same shape `release` uses, for the same
   * reason — there is no unattended publication and no override.
   *
   * Behind the two subject members in the ladder, and the code agrees: this
   * build tells an operator that the task is not finished before it tells them
   * they did not declare themselves present, because the first is a fact about
   * the work and the second is a fact about the invocation.
   */
  'OPERATOR_ABSENT',
  /**
   * The authority was refused at the effect: not minted, or already spent.
   *
   * Reachable in production only through a second use of a one-shot grant,
   * which the orchestration does not do. It is a member rather than a thrown
   * error because a forge mutation that declines to happen should be reportable
   * in the same vocabulary as one that happened.
   */
  'AUTHORITY_REFUSED',
  /**
   * The local subject moved between establishing it and acting on it.
   *
   * The task's pinned commit, its state, or the delivery target is no longer
   * what the grant was minted for. Checked before the remote is contacted, so
   * a subject that has already moved costs no network request and no effect.
   * The window is narrow and it is real: another process holding this
   * repository's execution lease can advance a task while this command runs.
   */
  'SUBJECT_CHANGED',
  /**
   * One remote name, two repositories: the fetch URL and the push URL differ.
   *
   * `git ls-remote` reads the fetch URL and `git push` writes to the push URL,
   * and slice 1 binds the delivery identity to the push URL. So when
   * `remote.<name>.pushurl` is set to something else, every reading this build
   * takes would be about a repository other than the one it would change —
   * measured, and it produces a silent false `ALREADY_PUBLISHED` or a
   * permanent `OUTCOME_UNCERTAIN` depending on which side already holds the
   * ref.
   *
   * Refused rather than worked around: `ls-remote` has no `--push` (measured),
   * and passing the URL instead of the remote name would put the value most
   * likely to carry a credential into an argument vector. Checked before the
   * remote is contacted, so a divergent remote costs no request.
   */
  'REMOTE_URLS_DIVERGE',
  /**
   * The remote ref could not be read, so nothing was attempted.
   *
   * Ahead of the attempt members because this build does not push at a remote
   * it could not first look at. Without a pre-reading, `PUBLISHED` and
   * `ALREADY_PUBLISHED` are indistinguishable afterwards.
   */
  'REMOTE_STATE_UNKNOWN',
  /**
   * The ref exists and holds a different commit. Nothing was attempted.
   *
   * Not an error and not a success: somebody — an earlier run, a human, another
   * clone — put something else there, and moving it is a destructive act this
   * slice does not perform. There is no flag that makes it perform one.
   */
  'REF_HOLDS_ANOTHER_COMMIT',
  /**
   * The attempt ran and the ref still does not hold this commit.
   *
   * The transport refused, and the reading afterwards agrees that nothing
   * changed. This is the honest failure: an effect that did not happen and is
   * known not to have happened.
   */
  'PUBLICATION_REFUSED',
  /**
   * The attempt's outcome could not be established.
   *
   * Either the transport claimed success and the ref is not there, or the
   * reading afterwards could not be completed. **A retry must begin with a
   * reading, never with a second push.** The push is not idempotent in the
   * transport; it is idempotent because the ladder above re-derives the state
   * every time, and a blind second attempt would step around that.
   */
  'OUTCOME_UNCERTAIN',
  /**
   * The ref already held exactly this commit before anything was attempted.
   *
   * Zero mutation. This is what a second invocation answers, and it is the
   * whole idempotency claim: the intended state was already true, so the
   * intended act was not performed.
   */
  'ALREADY_PUBLISHED',
  /**
   * The attempt did not report success, and the ref now holds this commit.
   *
   * The effect reached the remote and the answer did not reach this process, or
   * a concurrent publisher of the same commit won the race. Either way the
   * intended state is established, and it is reported under its own name rather
   * than as `PUBLISHED` because this process cannot claim to be the one that
   * did it.
   */
  'CONVERGED_AFTER_UNCERTAIN_EFFECT',
  /**
   * The ref did not exist, one attempt was made, it reported success, and the
   * ref now holds exactly this commit.
   *
   * The only member that claims this process changed the remote.
   */
  'PUBLISHED',
] as const;

export type HeadPublication = (typeof HEAD_PUBLICATIONS)[number];

/**
 * One static sentence per member, pinned by literal in the suite rather than by
 * reading this map — a completeness check proves a key exists, only a literal
 * proves the sentence an operator reads.
 */
export const HEAD_PUBLICATION_DETAIL: Readonly<Record<HeadPublication, string>> = Object.freeze({
  SUBJECT_NOT_ESTABLISHED:
    'There is no delivery target, exact commit and publishable ref to be about, so nothing was read and nothing was attempted.',
  TASK_NOT_READY:
    'The task has not reached READY_FOR_PR. Only a finished task has a delivery head, so nothing was read and nothing was attempted.',
  OPERATOR_ABSENT:
    'Publishing creates a branch on the delivery remote, so it requires an operator to be present for this invocation. Nothing was read and nothing was attempted. Pass --attended to publish.',
  AUTHORITY_REFUSED:
    'The authority for this publication was not one this build minted, or it had already been used. Nothing was attempted.',
  SUBJECT_CHANGED:
    'The pinned commit, the task state or the delivery target changed after this invocation established them, so the authority no longer describes what is in front of it. Nothing was read and nothing was attempted.',
  REMOTE_URLS_DIVERGE:
    'This remote could not be shown to read and write the same repository — either it reads from one and writes to another, or the two questions about it could not be answered. Nothing read from it would describe what a push would change, so nothing was contacted and nothing was attempted.',
  REMOTE_STATE_UNKNOWN:
    'The remote ref could not be read, so nothing was attempted: without knowing what was there first, a success afterwards could not be told from something that was already true.',
  REF_HOLDS_ANOTHER_COMMIT:
    'The ref already exists on the delivery remote and holds a different commit. Moving it is not something this build does, and nothing was attempted.',
  PUBLICATION_REFUSED:
    'The push was refused and the ref still does not hold this commit. Nothing on the remote changed.',
  OUTCOME_UNCERTAIN:
    'Whether the remote changed could not be established. Do not push again to find out — ask again, and the answer will be read from the remote.',
  ALREADY_PUBLISHED:
    'The ref already held exactly this commit. Nothing was pushed, because the intended state was already true.',
  CONVERGED_AFTER_UNCERTAIN_EFFECT:
    'The push did not report success, and the ref now holds exactly this commit. The intended state is established; this invocation cannot claim it is what established it.',
  PUBLISHED: 'The ref did not exist, and it now holds exactly this commit on the delivery remote.',
});

/**
 * The members under which the delivery remote holds this exact commit.
 *
 * Three provenances, one established state. A caller that needs to know whether
 * the head is published asks this and not `=== 'PUBLISHED'`, because two of the
 * three say so without this process having done it — and a caller that treats
 * `ALREADY_PUBLISHED` as a failure will push again for no reason.
 *
 * Held as a set rather than as a union of comparisons so that adding a member
 * to the vocabulary cannot silently widen it: the suite partitions
 * `HEAD_PUBLICATIONS` against this set and fails on any member neither side
 * claims.
 */
export const ESTABLISHED_HEAD_PUBLICATIONS: ReadonlySet<HeadPublication> = Object.freeze(
  new Set<HeadPublication>(['PUBLISHED', 'ALREADY_PUBLISHED', 'CONVERGED_AFTER_UNCERTAIN_EFFECT']),
) as ReadonlySet<HeadPublication>;

/** Whether the delivery remote holds the intended commit under the intended ref. */
export function remoteHeadIsEstablished(publication: HeadPublication): boolean {
  return ESTABLISHED_HEAD_PUBLICATIONS.has(publication);
}

/**
 * Grades a pre-reading, an attempt and a post-reading into one word.
 *
 * The two readings are the authority; `attempt` is consulted exactly twice, and
 * both times only to choose between explanations the readings alone cannot
 * separate. Everything else is decided by what the remote said.
 *
 * `expectedCommit` is compared by exact string equality against what each
 * reading found. There is no prefix match and no case folding: a ref holding an
 * abbreviation of the intended commit is a ref holding something this build
 * cannot identify, and the mint has already refused anything that is not forty
 * or sixty-four lowercase hex digits.
 */
export function gradeHeadPublication(
  expectedCommit: string,
  before: RemoteRefReading,
  attempt: PublicationAttempt,
  after: RemoteRefReading | null,
): HeadPublication {
  if (before.outcome === 'UNKNOWN') return 'REMOTE_STATE_UNKNOWN';

  if (before.outcome === 'AT_COMMIT') {
    // The intended state was already true. Nothing should have been attempted,
    // and the orchestration does not attempt anything — but this function is
    // exported and must be total, so the reading decides rather than trusting
    // the caller to have obeyed.
    return before.commit === expectedCommit ? 'ALREADY_PUBLISHED' : 'REF_HOLDS_ANOTHER_COMMIT';
  }

  // The ref was absent. From here the answer depends on what happened next.
  if (attempt === 'NOT_ATTEMPTED') return 'PUBLICATION_REFUSED';
  if (after === null || after.outcome === 'UNKNOWN') return 'OUTCOME_UNCERTAIN';

  if (after.outcome === 'AT_COMMIT') {
    if (after.commit !== expectedCommit) return 'REF_HOLDS_ANOTHER_COMMIT';
    return attempt === 'COMPLETED' ? 'PUBLISHED' : 'CONVERGED_AFTER_UNCERTAIN_EFFECT';
  }

  // The ref is still absent afterwards. A transport that reported success and
  // left nothing behind is the one case where the two sources disagree, and the
  // disagreement itself is the finding.
  return attempt === 'COMPLETED' ? 'OUTCOME_UNCERTAIN' : 'PUBLICATION_REFUSED';
}
