/**
 * What happened to the pull request, decided from observations rather than from
 * the transport's opinion of itself.
 *
 * This module is pure. It imports no filesystem, no clock, no process, no task
 * state and no lease. It takes two readings of one pull request — one from
 * before the attempt and one from after — plus what the transport reported, and
 * returns one word. That shape is slices 5 and 6's, for the same reason: the
 * postcondition is established by looking, and the transport's exit code is
 * only allowed to choose between explanations the readings cannot separate.
 *
 * ── Why the response body is not read at all, and why it matters more here ─
 *
 * `PUT /repos/{owner}/{repo}/pulls/{n}/merge` answers `200` with three fields —
 * `{sha, merged, message}` — and `sha` is the resulting commit. Reading it and
 * reporting it would be the obvious thing and it would be wrong, for a reason
 * that is **measured against github.com** rather than argued:
 *
 *   a merge request against an ALREADY-MERGED pull request answers
 *   `200 {"merged":true,"message":"Pull Request successfully merged"}`
 *   and replays the ORIGINAL merge commit — ignoring the `sha` this build
 *   sends and ignoring the `merge_method`.
 *
 * So `merged: true` on the wire means "this pull request is merged", never
 * "this request merged it", never "the head you named is what merged", and
 * never "your method was used". A build that reported the response's `sha` as
 * its own result would claim a merge it may not have performed, at a head it
 * may not have merged. Every positive answer below is therefore established by
 * the reading taken afterwards, and the commit this build reports is the one it
 * *observed*, never the one it was told.
 *
 * The same measurement is why {@link MERGE_OUTCOMES} has both `MERGED` and
 * `ALREADY_MERGED`, and why the pre-reading is a precondition rather than an
 * optimisation: without it the two are indistinguishable afterwards.
 *
 * ── What the exit code can and cannot say ─────────────────────────────────
 *
 * Measured against github.com with the vector this build uses:
 *
 *   head moved / sha unknown -> 409 "Head branch was modified…"        exit 1
 *   pull request is a draft  -> 405 "Pull Request is still a draft"    exit 1
 *   sha not 40 lowercase hex -> 422 "The sha parameter must be…"       exit 1
 *   method outside the three -> 422 "cherry-pick is not a member of…"  exit 1
 *   no such pull request     -> 404 "Not Found"                        exit 1
 *   already merged           -> 200 (a replay)                         exit 0
 *
 * Every refusal is a non-zero exit. That does **not** make exit 0 a proof of a
 * merge, and this ladder does not treat it as one — the last line of that table
 * is a zero exit for a request that changed nothing.
 *
 * ── One refusal GitHub does not make ──────────────────────────────────────
 *
 * **Measured: a CLOSED, unmerged pull request is merged by this endpoint.** It
 * answers `200 merged=true` and moves the base branch. "The pull request is
 * open" is therefore not a server-side precondition, and a build that assumed
 * it was would re-open, by merging, a delivery a human had closed. This ladder
 * refuses it by name — `PULL_REQUEST_NOT_OPEN` — from the reading taken before,
 * and the refusal is this build's own.
 *
 * ── What this decides, and what it does not ───────────────────────────────
 *
 * It decides whether the intended pull request is now merged, at the head this
 * build named, into the base it intended, and which commit resulted. That is
 * all. It is not a claim that the merge was eligible under this repository's
 * rules, that reviews were satisfied, that required checks passed, that the
 * base branch is where it was a moment ago, or that anything local was updated
 * to match. The operator's explicit authorisation is the policy decision this
 * slice acts on, and GitHub is the remote policy enforcer.
 */

/**
 * What the transport reported about its own attempt.
 *
 * Deliberately three words and not an exit code: a number invites arithmetic,
 * and the only thing this layer is allowed to do with the transport's opinion
 * is choose between two readings-consistent explanations.
 *
 * `NOT_ATTEMPTED` is what the orchestration passes when it decided, from the
 * pre-reading alone, that there was nothing to do or nothing it was willing to
 * do. `COMPLETED` means the request ran and exited zero. `FAILED` means it ran
 * and exited non-zero, or did not run, or was killed, or exceeded a bound, or
 * had its body only partly delivered — every one of which leaves the forge in a
 * state only a reading can settle.
 */
export const MERGE_ATTEMPTS = ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const;
export type MergeAttempt = (typeof MERGE_ATTEMPTS)[number];

/**
 * What one reading established about the pull request this build named.
 *
 * `UNKNOWN` is a first-class member, not an error to be smoothed over. A read
 * that could not be completed is the case in which a mutation's outcome is
 * genuinely uncertain, and collapsing it into anything else would turn "I could
 * not look" into a fact.
 *
 * The four settled members are the states the endpoint distinguishes, and they
 * are kept apart because this build acts differently on each: `OPEN` may be
 * merged, `MERGED` must not be merged again, and `CLOSED_UNMERGED` — which
 * GitHub itself would merge — is refused.
 */
export const MERGE_READINGS = ['UNKNOWN', 'OPEN', 'CLOSED_UNMERGED', 'MERGED'] as const;
export type MergeReadingOutcome = (typeof MERGE_READINGS)[number];

/**
 * One pull request, as one reading found it.
 *
 * `mergeCommit` is non-null only for `MERGED`, and that is a correctness
 * property rather than a convention. **Measured:** on an *open* pull request
 * GitHub's `merge_commit_sha` is an ephemeral two-parent *test* merge commit
 * that is on no branch — for pull request 60 it read `ecae16f…`, whose parents
 * are the base tip and the head, and `main` was *behind* it. Reading that field
 * without first establishing `merged` would report a commit that does not exist
 * on the base branch as the result of a merge.
 */
export interface MergeReading {
  readonly outcome: MergeReadingOutcome;
  /** The number the reading was about, or `null` when nothing was established. */
  readonly number: number | null;
  /** The head object name the forge reported, or `null`. */
  readonly headSha: string | null;
  /** The base branch name the forge reported, or `null`. Never an object name. */
  readonly baseRef: string | null;
  /** Draft state as the forge reported it, or `null` if it did not report one. */
  readonly draft: boolean | null;
  /** The resulting commit. Non-null only when `outcome` is `MERGED`. */
  readonly mergeCommit: string | null;
}

/** The reading that says nothing could be established. */
export const MERGE_READING_UNKNOWN: MergeReading = Object.freeze({
  outcome: 'UNKNOWN' as const,
  number: null,
  headSha: null,
  baseRef: null,
  draft: null,
  mergeCommit: null,
});

/** What the caller intends the merge to be about. Every field is compared. */
export interface IntendedMerge {
  readonly pullRequestNumber: number;
  readonly expectedHeadCommit: string;
  readonly baseRef: string;
}

/**
 * The closed vocabulary. Ordered as the ladder decides, weakest claim first.
 *
 * Every member is a statement about the forge, and each one says why it is not
 * the member beside it.
 */
export const MERGE_OUTCOMES = [
  /**
   * No subject was established, so there is nothing this could be about.
   *
   * The delivery target did not resolve, the task state could not be read, the
   * task has no current commit, or the base branch is not a name this build
   * will compare. Ahead of every other member because a refusal about a subject
   * that does not exist would be describing nothing.
   */
  'SUBJECT_NOT_ESTABLISHED',
  /**
   * The task is not finished, so its head is not a delivery head.
   *
   * `READY_FOR_PR` is the state at which the work is settled and provable.
   * Merging a task still being worked on lands a moving target on the base
   * branch.
   */
  'TASK_NOT_READY',
  /**
   * `--merge-pr` was given and `--attended` was not.
   *
   * A member rather than a silence: the operator asked for the most consequential
   * mutation this build has and did not say they were present for it. There is
   * no unattended merge, no auto-merge, and no override.
   */
  'OPERATOR_ABSENT',
  /**
   * This invocation has no fresh decision that says this commit is ready.
   *
   * Stricter than slice 6's gate, and deliberately so. Creating a pull request
   * admits five decisions, because four of them mean one already exists and the
   * creation ladder's own reading can then answer usefully. A merge admits
   * exactly one — `PULL_REQUEST_MATCHED_CHECKS_SUCCESS` — because it is the only
   * one that says *both* that exactly one open pull request had this exact head
   * and that no check on this commit failed or is still running.
   *
   * Either `--observe` and `--decide` were not both given, or they were and the
   * answer was another member. A record read back from disk can never reach
   * here: slice 3's store has no path into this ladder at all.
   *
   * This is not merge eligibility, and this build does not claim it is. Reviews,
   * branch protection and repository rules are not observed, and — measured —
   * their surfaces cannot be told apart from "you may not read them". What
   * authorises the act is the operator; what this decision adds is that the
   * commit an operator is authorising is the one this invocation just looked at.
   */
  'DECISION_NOT_SUCCESS',
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
   * The task's pinned commit, its state, its base branch, or the delivery target
   * is no longer what the grant was minted for. Checked before the forge is
   * contacted by this path, so a subject that has already moved costs no request
   * and no effect.
   */
  'SUBJECT_CHANGED',
  /**
   * What the pull request is could not be established. Nothing was attempted.
   *
   * The forge was not reached, it answered in a shape this build will not draw a
   * conclusion from, or it answered about a different pull request than the one
   * asked for. Ahead of every attempt member: without a pre-reading, `MERGED`
   * and `ALREADY_MERGED` are indistinguishable afterwards, and this build would
   * not be able to say whether it changed anything.
   */
  'PULL_REQUEST_STATE_UNKNOWN',
  /**
   * The pull request is closed and was not merged. Nothing was attempted.
   *
   * **GitHub would merge it.** Measured: the endpoint answers `200 merged=true`
   * for a closed, unmerged pull request and moves the base branch. So this
   * refusal is this build's own narrowing and not one inherited from the API. A
   * human closed this delivery; merging it anyway would overrule that decision
   * without saying so, and reopening the question is theirs.
   */
  'PULL_REQUEST_NOT_OPEN',
  /**
   * The pull request is a draft. Nothing was attempted.
   *
   * GitHub refuses this too — measured, `405 "Pull Request is still a draft"`,
   * and the draft check fires before the head-sha check — but the refusal is
   * taken here, from the reading, for two reasons. It costs no request. And the
   * decision this ladder gates on does not observe draft state at all
   * (`L-V4-06-9`), so a positive decision can be true of a draft pull request
   * and something has to be the thing that notices.
   */
  'DRAFT_REFUSED',
  /**
   * The pull request's head is not the commit this build authorised.
   *
   * Nothing was attempted. Somebody pushed to the branch after this invocation
   * observed it, so merging would land work this invocation never looked at and
   * never decided about. The request would also have been refused server-side —
   * the `sha` field is a compare-and-swap GitHub evaluates — but this build
   * refuses first, because a refusal it can explain is better than one it has to
   * infer from an exit code.
   */
  'HEAD_MOVED',
  /**
   * The pull request targets a branch other than the intended base.
   *
   * Nothing was attempted. Merging would deliver this work into a branch nobody
   * asked for, and retargeting the pull request is an update this build does not
   * perform.
   */
  'WRONG_BASE',
  /**
   * No request of this invocation reported success, and the pull request is
   * still open and unmerged.
   *
   * Two provenances, one state: the transport ran and reported failure, or it
   * never started — an unsupported host, an unusable environment, an argument
   * the grammar refuses. Either way the reading afterwards agrees that nothing
   * was merged. This is the honest failure: an effect that did not happen and is
   * known not to have happened.
   *
   * Deliberately **not** called `MERGE_REFUSED`. This build cannot establish
   * that GitHub refused: it does not read the response, and a failed attempt is
   * indistinguishable from a process that never existed. The `Attempt` line in
   * the report is what separates the two, and it is printed beside this.
   */
  'EFFECT_NOT_ESTABLISHED',
  /**
   * The pull request is merged, and not as this invocation intended.
   *
   * The head that merged is not the one this build authorised, or the base is
   * not the intended one. **This is reachable even though the request carries an
   * expected head**, because the server-side comparison protects only the *open*
   * case: measured, an already-merged pull request answers `200` whatever `sha`
   * is sent. So a pull request merged by somebody else, at another head, between
   * the reading and the request lands here — merged, but not this delivery.
   *
   * Nothing is reverted, reopened or retried in response: each of those is a
   * further mutation, performed at the moment least is known, and undo paths are
   * where the most destructive defects in this codebase have lived.
   */
  'POSTCONDITION_MISMATCH',
  /**
   * The readings do not settle what happened.
   *
   * Either the transport reported success and the pull request is still open, or
   * the pull request is merged and the resulting commit could not be established
   * from the reading. **A retry must begin with a reading, never with a second
   * request.** A merge is not idempotent in the way this build needs — a second
   * request against an already-merged pull request answers success and proves
   * nothing — so idempotency here rests on the ladder re-deriving the state
   * every time, and a blind second attempt would step around that.
   */
  'OUTCOME_AMBIGUOUS',
  /**
   * The reading after the attempt could not be completed.
   *
   * The most important member of this vocabulary, and the reason the attempt is
   * never the authority: this is exactly the state in which GitHub may have
   * committed the merge and the answer never arrived. Nothing is retried and
   * nothing is claimed. Asking again begins with a reading.
   */
  'OBSERVATION_UNAVAILABLE',
  /**
   * The pull request was already merged before anything was attempted.
   *
   * Zero mutation. This is what a second invocation answers, and it is the whole
   * idempotency claim: the intended state was already true, so the intended act
   * was not performed.
   *
   * It says **this pull request is merged**, and not "AO merged it". Nothing in
   * a reading establishes who did, and the response that would seem to — a `200`
   * from a second request — is a replay this build refuses to send.
   */
  'ALREADY_MERGED',
  /**
   * No request of this invocation reported success, and the intended pull
   * request is now merged at the intended head and base.
   *
   * The effect reached the forge and the answer did not reach this process, or a
   * concurrent merger won the race. Either way the intended state is established,
   * and it is reported under its own name rather than as `MERGED` because this
   * process cannot claim to be the one that did it.
   */
  'CONVERGED_AFTER_UNCERTAIN_EFFECT',
  /**
   * The pull request was open at the authorised head, one request was made, it
   * reported success, and the pull request is now merged at that head, into the
   * intended base, with a resulting commit this build read back.
   *
   * The only member that claims this process changed the forge.
   */
  'MERGED',
] as const;

export type MergeOutcome = (typeof MERGE_OUTCOMES)[number];

/**
 * One static sentence per member, pinned by literal in the suite rather than by
 * reading this map — a completeness check proves a key exists, only a literal
 * proves the sentence an operator reads.
 */
export const MERGE_OUTCOME_DETAIL: Readonly<Record<MergeOutcome, string>> = Object.freeze({
  SUBJECT_NOT_ESTABLISHED:
    'There is no delivery target, exact commit and sendable base branch to be about. Nothing was read from the forge by this path and nothing was attempted.',
  TASK_NOT_READY:
    'The task has not reached READY_FOR_PR. Only a finished task has a delivery head, so nothing was read from the forge by this path and nothing was attempted.',
  OPERATOR_ABSENT:
    'Merging changes this repository\'s base branch, so it requires an operator to be present for this invocation. There is no unattended merge and no auto-merge. Nothing was read from the forge by this path and nothing was attempted. Pass --attended to merge.',
  DECISION_NOT_SUCCESS:
    'This invocation has no fresh decision of PULL_REQUEST_MATCHED_CHECKS_SUCCESS about this commit. Either --observe and --decide were not both given, or they were and the answer was another member: a check failed or is still running, no check exists, the pull request did not match, the observation did not settle, or the subject moved. A stored record can never stand in for it. Nothing was read from the forge by this path and nothing was attempted.',
  AUTHORITY_REFUSED:
    'The authority for this merge was not one this build minted, or it had already been used. Nothing was attempted.',
  SUBJECT_CHANGED:
    'The pinned commit, the task state, the base branch or the delivery target changed after this invocation established them, so the authority no longer describes what is in front of it. Nothing was attempted.',
  PULL_REQUEST_STATE_UNKNOWN:
    'What this pull request is could not be established — the forge was not reached, it answered in a shape this build will not draw a conclusion from, or it answered about a different pull request. Nothing was attempted: without knowing the state first, a success afterwards could not be told from something that was already true.',
  PULL_REQUEST_NOT_OPEN:
    'This pull request is closed and was not merged. GitHub would merge it anyway; this build will not, because somebody decided about this delivery already. Nothing was attempted.',
  DRAFT_REFUSED:
    'This pull request is a draft. A draft is not offered for merging, and the fresh decision this build gates on does not observe draft state, so the refusal is taken here. Nothing was attempted.',
  HEAD_MOVED:
    'This pull request\'s head is no longer the commit that was authorised, so merging it would land work this invocation never observed and never decided about. Nothing was attempted, and nothing on the branch was touched.',
  WRONG_BASE:
    'This pull request targets a different base branch than the intended one. Merging would deliver into a branch nobody asked for, and retargeting is a mutation this build does not perform. Nothing was attempted.',
  EFFECT_NOT_ESTABLISHED:
    'This pull request is still open and unmerged, and this invocation did not establish that it sent a request that succeeded — either the request failed, or none was sent. Nothing on the forge changed.',
  POSTCONDITION_MISMATCH:
    'This pull request is merged, and not as this invocation intended: the head that merged, or the base it merged into, is not the one that was authorised. If a request was sent, this build cannot show it is what merged it. Nothing was reverted, reopened or retried in response.',
  OUTCOME_AMBIGUOUS:
    'What became of the merge could not be settled: a request reported success while the pull request is still open, or the pull request is merged and the resulting commit could not be read back. Do not ask again to find out — ask again, and the answer will be read from the forge before anything is attempted.',
  OBSERVATION_UNAVAILABLE:
    'The reading after the attempt could not be completed, so whether the forge merged this pull request is not established. A request may have taken effect. Nothing was retried; asking again begins with a reading.',
  ALREADY_MERGED:
    'This pull request was already merged before anything was attempted, so nothing was sent. That it is merged is what this says; who merged it is not something a reading can establish.',
  CONVERGED_AFTER_UNCERTAIN_EFFECT:
    'No request of this invocation reported success, and this pull request is now merged at the authorised head and into the intended base. The intended state is established; this invocation cannot claim it is what established it.',
  MERGED:
    'This pull request was open at the authorised head, one request was made, and it is now merged into the intended base at that head. The resulting commit below was read back from the forge, not taken from the response.',
});

/**
 * The members under which the intended pull request is merged on the forge.
 *
 * Three provenances, one established state. A caller that needs to know whether
 * the delivery landed asks this and not `=== 'MERGED'`, because two of the three
 * say so without this process having done it.
 *
 * Held as a set rather than as a union of comparisons so there is one place to
 * read the answer from. What stops it widening silently is the suite's
 * enumerated equality against these three names, and that alone: `Object.freeze`
 * does not make a `Set` immutable — it does not touch internal slots, so `add`
 * still works on a value cast back to a mutable type. It is applied for the
 * properties it does freeze.
 */
export const ESTABLISHED_MERGES: ReadonlySet<MergeOutcome> = Object.freeze(
  new Set<MergeOutcome>(['MERGED', 'ALREADY_MERGED', 'CONVERGED_AFTER_UNCERTAIN_EFFECT']),
) as ReadonlySet<MergeOutcome>;

/** Whether the intended pull request is merged on the forge. */
export function mergeIsEstablished(outcome: MergeOutcome): boolean {
  return ESTABLISHED_MERGES.has(outcome);
}

/** Forty lowercase hex digits, for the commit a reading claims resulted. */
const RESULT_COMMIT = /^[0-9a-f]{40}$/;

/**
 * Grades the reading taken *before* anything is attempted.
 *
 * Returns the outcome this invocation must answer with, or `null` when the
 * reading establishes that the intended merge may be attempted. Every member it
 * can return carries "nothing was attempted", and the orchestration attempts
 * nothing on any of them — but this function is exported and must be total, so
 * the reading decides rather than trusting the caller to have obeyed.
 *
 * The order is the order of what would go most wrong. `MERGED` is answered
 * before the head is compared, because a pull request that is already merged
 * cannot be brought back to the authorised head and the truthful answer is that
 * it is merged, not that the head moved.
 */
export function gradeMergePrecondition(
  intended: IntendedMerge,
  before: MergeReading,
): MergeOutcome | null {
  if (before.outcome === 'UNKNOWN') return 'PULL_REQUEST_STATE_UNKNOWN';
  // A reading about another pull request is not a reading about this one. The
  // request is addressed by number, so this should be impossible — and it is
  // asked anyway, because "impossible" is a property of the transport and this
  // module is what the transport's answer is graded by.
  if (before.number !== intended.pullRequestNumber) return 'PULL_REQUEST_STATE_UNKNOWN';

  if (before.outcome === 'MERGED') return 'ALREADY_MERGED';
  if (before.outcome === 'CLOSED_UNMERGED') return 'PULL_REQUEST_NOT_OPEN';

  if (before.outcome === 'OPEN') {
    // A reading that says `OPEN` and cannot describe the pull request is a
    // reading this build cannot act on. Graded as an unreadable state rather
    // than as a refusal about the thing it could not read.
    if (before.draft === null || before.headSha === null || before.baseRef === null) {
      return 'PULL_REQUEST_STATE_UNKNOWN';
    }
    if (before.draft) return 'DRAFT_REFUSED';
    if (before.headSha !== intended.expectedHeadCommit) return 'HEAD_MOVED';
    if (before.baseRef !== intended.baseRef) return 'WRONG_BASE';
    return null;
  }

  // Not reachable while `MERGE_READINGS` holds four members, and present for
  // the reason `gradePullRequestCreation` gives for its floor: the strongest
  // claim this build can make is downstream of here, and a fifth reading must
  // not be able to arrive there by falling off the end.
  const unreachable: never = before.outcome;
  void unreachable;
  return 'PULL_REQUEST_STATE_UNKNOWN';
}

/**
 * Grades a pre-reading, an attempt and a post-reading into one word.
 *
 * The two readings are the authority; `attempt` is consulted exactly twice, and
 * both times only to choose between explanations the readings alone cannot
 * separate. Everything else is decided by what the forge said.
 *
 * `intended.baseRef` is compared by exact string equality against what each
 * reading found. There is no normalisation, no `refs/heads/` stripping and no
 * case folding: GitHub reports a pull request's base as a bare branch name, and
 * a comparison that "helpfully" massaged either side could pass on two
 * different branches.
 */
export function gradeMerge(
  intended: IntendedMerge,
  before: MergeReading,
  attempt: MergeAttempt,
  after: MergeReading | null,
): MergeOutcome {
  const refusal = gradeMergePrecondition(intended, before);
  if (refusal !== null) return refusal;

  // The pre-reading said the intended merge may be attempted. From here the
  // answer depends entirely on what the reading afterwards found.
  //
  // `NOT_ATTEMPTED` is deliberately not short-circuited: slice 6 had that arm
  // and a review measured what it cost — a refusal sentence printed over a path
  // where a post-reading had already been taken and thrown away. A reading is
  // the authority in this module; an attempt word that overrules one is the
  // defect this module exists to avoid.
  if (after === null || after.outcome === 'UNKNOWN') return 'OBSERVATION_UNAVAILABLE';
  if (after.number !== intended.pullRequestNumber) return 'OUTCOME_AMBIGUOUS';

  if (after.outcome === 'MERGED') {
    if (after.headSha !== intended.expectedHeadCommit) return 'POSTCONDITION_MISMATCH';
    if (after.baseRef !== intended.baseRef) return 'POSTCONDITION_MISMATCH';
    // The resulting commit is load-bearing and is the one field a caller cannot
    // recompute: under a squash merge it is a new commit that is on the base
    // branch and is reachable from neither the head nor anything local. A
    // reading that says merged and cannot name it has not established the thing
    // the next slice needs.
    if (after.mergeCommit === null || !RESULT_COMMIT.test(after.mergeCommit)) {
      return 'OUTCOME_AMBIGUOUS';
    }
    return attempt === 'COMPLETED' ? 'MERGED' : 'CONVERGED_AFTER_UNCERTAIN_EFFECT';
  }

  // Closed and not merged, afterwards, on a path that started open: something
  // else closed it, or a request this build sent did something it cannot see.
  if (after.outcome === 'CLOSED_UNMERGED') return 'POSTCONDITION_MISMATCH';

  if (after.outcome === 'OPEN') {
    // The one case where the two sources disagree, and the disagreement itself
    // is the finding. A transport that reported success over a pull request
    // that is still open has not been shown to have merged anything, and this
    // build will not call that a failure either — the forge may not have caught
    // up, and neither is distinguishable from here.
    return attempt === 'COMPLETED' ? 'OUTCOME_AMBIGUOUS' : 'EFFECT_NOT_ESTABLISHED';
  }

  const unreachable: never = after.outcome;
  void unreachable;
  return 'OBSERVATION_UNAVAILABLE';
}
