/**
 * What happened to the pull request, decided from observations rather than from
 * the transport's opinion of itself.
 *
 * This module is pure. It imports no filesystem, no clock, no process, no task
 * state and no lease. It takes two readings of the forge — one from before the
 * attempt and one from after — plus what the transport reported, and returns
 * one word. That shape is deliberate and is slice 5's, for the same reason: the
 * postcondition is established by looking, and the transport's exit code is
 * only allowed to choose between explanations the readings cannot separate.
 *
 * ── Why the response body is not read at all ──────────────────────────────
 *
 * `POST /repos/{owner}/{repo}/pulls` answers `201` with the whole pull request,
 * number and all. Reading that number and reporting it would be the obvious
 * thing and would make the result a claim about a document this process never
 * verified. Worse, it would make the *success* claim rest on the response,
 * which is exactly the failure mode this ladder exists to prevent: a response
 * can be truncated, a process can be killed after the far side committed, and
 * an unknown enum in a body must never fall through into success.
 *
 * So `attempt` carries three words and no payload, and every positive answer
 * below is established by the reading taken afterwards. The pull request number
 * this build reports is the one it *observed*, never the one it was told.
 *
 * ── What the exit code can and cannot say ─────────────────────────────────
 *
 * Measured against github.com with the vector this build uses:
 *
 *   head branch missing   -> 422 `{"field":"head","code":"invalid"}`   exit 1
 *   base branch missing   -> 422 `{"field":"base","code":"invalid"}`   exit 1
 *   head == base          -> 422 `"No commits between main and main"`  exit 1
 *   repository missing    -> 404 `"Not Found"`                          exit 1
 *   head given as a SHA   -> 422 `{"field":"head","code":"invalid"}`   exit 1
 *
 * Every refusal is a non-zero exit, so unlike `git push` there is no measured
 * case where exit 0 means "nothing changed". That does **not** make exit 0 a
 * proof of creation, and this ladder does not treat it as one: a zero exit with
 * no pull request afterwards is `OUTCOME_UNCERTAIN`, not success, because the
 * reading is the authority and the exit code is not.
 *
 * ── What this decides, and what it does not ───────────────────────────────
 *
 * It decides whether the forge now holds exactly one open pull request whose
 * head object name is this commit and whose base is the intended branch. That
 * is all. It is not a claim that the pull request is mergeable, that its checks
 * have run or passed, that anybody has reviewed it, that the base branch is
 * where it was a moment ago, or that this build may merge it. This build
 * performs one mutation class and does not perform any other.
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
export const PULL_REQUEST_ATTEMPTS = ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const;
export type PullRequestAttempt = (typeof PULL_REQUEST_ATTEMPTS)[number];

/**
 * The one open pull request a reading found at the intended head.
 *
 * `baseRef` and `draft` are here because the intended pull request is not
 * identified by its head alone. Two pull requests can carry the same head
 * commit and target different branches, and converging on the wrong one would
 * report a delivery into a branch nobody asked for.
 */
export interface OpenPullRequest {
  readonly number: number;
  /** The branch it targets, as the forge reported it. A name, never a SHA. */
  readonly baseRef: string;
  readonly draft: boolean;
}

/**
 * What one reading of the forge established about this exact head commit.
 *
 * `UNKNOWN` is a first-class member, not an error to be smoothed over. A read
 * that could not be completed is the case in which a mutation's outcome is
 * genuinely uncertain, and collapsing it into `NONE` would turn "I could not
 * look" into "there is none" — the shape of every false negative this build has
 * had to unpick before.
 *
 * `CLOSED_ONLY` is separate from `NONE` for the same reason. A closed or merged
 * pull request at this exact commit is not the absence of one: somebody made a
 * decision about this delivery already, and opening a second pull request over
 * the top of it would overrule a human without saying so.
 */
export const PULL_REQUEST_SITUATIONS = [
  'NONE',
  'OPEN_ONE',
  'OPEN_MANY',
  'CLOSED_ONLY',
  'UNKNOWN',
] as const;
export type PullRequestSituationOutcome = (typeof PULL_REQUEST_SITUATIONS)[number];

export interface PullRequestSituation {
  readonly outcome: PullRequestSituationOutcome;
  /** The one open pull request at this head; non-null only for `OPEN_ONE`. */
  readonly open: OpenPullRequest | null;
  /** Every pull request number this reading saw at this head. Ascending, deduplicated. */
  readonly numbers: readonly number[];
}

/** What the caller intends the pull request to be. Both halves are compared. */
export interface IntendedPullRequest {
  readonly baseRef: string;
  readonly draft: boolean;
}

/**
 * The closed vocabulary. Ordered as the ladder decides, weakest claim first.
 *
 * Every member is a statement about the forge, and each one says why it is not
 * the member beside it.
 */
export const PULL_REQUEST_CREATIONS = [
  /**
   * No subject was established, so there is nothing this could be about.
   *
   * The delivery target did not resolve, the task state could not be read, the
   * task has no current commit, or the work branch or base branch is not a name
   * this build will send. Ahead of every other member because a refusal about a
   * subject that does not exist would be describing nothing.
   */
  'SUBJECT_NOT_ESTABLISHED',
  /**
   * The task is not finished, so its head is not a delivery head.
   *
   * `READY_FOR_PR` is the state at which the work is settled and provable. A
   * pull request for a task still being worked on asks humans to review a
   * moving target.
   */
  'TASK_NOT_READY',
  /**
   * `--create-pr` was given and `--attended` was not.
   *
   * A member rather than a silence: the operator asked for a mutation and did
   * not say they were present for it. The same shape `release` and
   * `--publish-head` use, for the same reason — there is no unattended
   * creation and no override.
   */
  'OPERATOR_ABSENT',
  /**
   * This invocation has no fresh decision that admits the creation ladder.
   *
   * Either `--observe` and `--decide` were not both given, or they were and the
   * answer was one this build will not create from: the observation did not
   * settle, the subject moved, the subject could not be re-read at all, or a
   * check on this commit failed. A review counted three where there are four —
   * `SUBJECT_REVALIDATION_FAILED` is its own decision and is outside the set.
   *
   * It is deliberately **not** "the decision was not `PULL_REQUEST_REQUIRED`".
   * Four other decisions mean a pull request already claims this head, and they
   * admit the ladder so that its own fresh reading can answer `ALREADY_EXISTS`,
   * `WRONG_BASE_CONFLICT`, `DRAFT_STATE_CONFLICT` or `PULL_REQUEST_AMBIGUOUS`
   * — the four answers an operator most needs and which, while this member
   * covered them all, were unreachable from the command. See
   * `ADMITS_CREATION_LADDER`.
   *
   * Knowing a pull request is needed is not permission to open one, so a
   * decision is necessary rather than sufficient; and it must be *this*
   * invocation's own. A record read back from disk is a statement about a past
   * moment and can never reach here — slice 3's store has no path into this
   * ladder at all.
   */
  'DECISION_NOT_ESTABLISHED',
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
   * The task's pinned commit, its state, its branches, or the delivery target
   * is no longer what the grant was minted for. Checked before the forge is
   * contacted by this path, so a subject that has already moved costs no
   * request and no effect.
   */
  'SUBJECT_CHANGED',
  /**
   * One remote name, two repositories: the fetch URL and the push URL differ.
   *
   * The head ref is read with `git ls-remote`, which reads the **fetch** URL,
   * while slice 1 binds the delivery identity — the `owner/repo` this build
   * POSTs to — to the **push** URL. When `remote.<name>.pushurl` points
   * somewhere else, the ref reading would be about a repository other than the
   * one the pull request would be opened in, and "the head is published" would
   * be established against the wrong remote. Refused rather than worked around,
   * and an unreadable answer is refused too: it is a precondition, not a
   * diagnosis.
   */
  'REMOTE_URLS_DIVERGE',
  /**
   * The remote head ref could not be read, so nothing was attempted.
   *
   * Ahead of the head members because this build does not ask a forge to open a
   * pull request from a ref it could not first look at.
   */
  'REMOTE_STATE_UNKNOWN',
  /**
   * The head ref does not exist on the delivery remote. Nothing was attempted.
   *
   * `head` is a branch name and GitHub resolves it on its side, so a pull
   * request cannot be created from a branch that is not there. This build
   * refuses rather than publishing one: publishing is a different act with its
   * own authority, and `--publish-head` is the flag that performs it.
   */
  'HEAD_NOT_PUBLISHED',
  /**
   * The head ref exists and holds a different commit. Nothing was attempted.
   *
   * The pull request would be opened from whatever that ref holds, because
   * `head` is a ref name and — measured — GitHub refuses an object name in that
   * field. So a ref at another commit is a pull request about other work, and
   * moving the ref is a destructive act this build does not perform.
   */
  'HEAD_SHA_MISMATCH',
  /**
   * What pull requests this commit already has could not be established.
   *
   * Not only "the forge could not be reached". It also covers a forge that
   * answered: a full page, which the parse refuses as truncated rather than
   * concluding from a prefix, and an open pull request at this head whose base
   * or draft the response did not report, which the classifier refuses rather
   * than reading past. The distinction the classifier keeps — "I cannot judge
   * the one that is there" is not "there is none" — was thrown away by the
   * sentence until a review read it back.
   *
   * Ahead of every attempt member: without a pre-reading, `CREATED` and
   * `ALREADY_EXISTS` are indistinguishable afterwards, and this build would not
   * be able to say whether it changed anything.
   */
  'PULL_REQUEST_STATE_UNKNOWN',
  /**
   * More than one open pull request already claims this exact head.
   *
   * Nothing was attempted. Which one is "the" delivery is not a question this
   * build can answer, and adding a third would make the ambiguity worse.
   */
  'PULL_REQUEST_AMBIGUOUS',
  /**
   * A closed or merged pull request already carries this exact head commit, and
   * no open one does. Nothing was attempted.
   *
   * GitHub itself **would permit** a new pull request here, and that is
   * measured rather than assumed: the uniqueness it enforces is scoped to
   * *open* pull requests, and `withastro/astro` carries 928 of them on one head
   * branch and base with exactly one open at a time. So this refusal is this
   * build's own narrowing, taken deliberately and not inherited from the API. A
   * human closed or merged the pull request that carried this exact commit;
   * re-opening that question is their decision, not a delivery command's.
   */
  'PRIOR_PULL_REQUEST_CLOSED',
  /**
   * An open pull request already has this exact head, and targets another base.
   *
   * Nothing was attempted, and nothing converges. Retargeting it would be an
   * update, creating a second one would leave two open pull requests for one
   * commit, and reporting it as the intended pull request would claim a
   * delivery into a branch nobody asked for.
   */
  'WRONG_BASE_CONFLICT',
  /**
   * An open pull request already has this exact head and base, and its draft
   * state is not the intended one.
   *
   * Nothing was attempted. Marking a pull request ready, or back to draft, is a
   * mutation this build does not perform, so there is no path from here to the
   * intended state and reporting `ALREADY_EXISTS` would claim one holds when it
   * does not.
   */
  'DRAFT_STATE_CONFLICT',
  /**
   * Nothing is at this head, and no request of this invocation is known to have
   * been sent.
   *
   * Two provenances, one state: the transport ran and reported failure, or it
   * never started — an unsupported host, an unusable environment, an argument
   * the grammar refuses. Either way the reading afterwards agrees that nothing
   * was created. This is the honest failure: an effect that did not happen and
   * is known not to have happened.
   *
   * The sentence used to open "The request was refused", which a review read
   * back on the paths where no process ever existed. The `Attempt` line in the
   * report is what distinguishes the two, and it is printed beside this.
   */
  'CREATION_REFUSED',
  /**
   * The attempt's outcome could not be established.
   *
   * Either the transport reported success and no intended pull request can be
   * found, or the reading afterwards could not be completed. **A retry must
   * begin with a reading, never with a second request.** The creation is not
   * idempotent in the transport; it is idempotent because the ladder above
   * re-derives the state every time, and a blind second attempt would step
   * around that.
   *
   * This is also where the head-ref race lands. GitHub resolves `head` on its
   * own side at the moment it creates, so a ref moved between this build's
   * reading and the request produces a pull request from another commit — which
   * the reading afterwards, keyed on the intended object name, does not find.
   * This build cannot tell that apart from a creation that did not happen, or
   * from a forge index that has not caught up yet, so it says so instead of
   * choosing.
   */
  'OUTCOME_UNCERTAIN',
   /**
   * Something exists at this head afterwards, and it is not the intended pull
   * request.
   *
   * The base is wrong, the draft state is wrong, what is there is closed, or
   * there is more than one. **This is the member for every unintended
   * postcondition**, including ambiguity: a review found the after-reading's
   * `OPEN_MANY` graded as `PULL_REQUEST_AMBIGUOUS`, whose sentence ends "and
   * nothing was attempted" — printed two lines under `Attempt : COMPLETED`, on
   * the run where this build had very likely just created one of the two.
   *
   * Nothing is edited, retargeted, closed or retried in response: each of those
   * is a further mutation, performed at the moment least is known, and undo
   * paths are where the most destructive defects in this codebase have lived.
   */
  'POSTCONDITION_MISMATCH',
  /**
   * Exactly one open pull request already had this head, this base and this
   * draft state before anything was attempted.
   *
   * Zero mutation. This is what a second invocation answers, and it is the
   * whole idempotency claim: the intended state was already true, so the
   * intended act was not performed.
   */
  'ALREADY_EXISTS',
  /**
   * No request of this invocation reported success, and the intended pull
   * request is now open.
   *
   * The effect reached the forge and the answer did not reach this process, or
   * a concurrent creator won the race. Either way the intended state is
   * established, and it is reported under its own name rather than as `CREATED`
   * because this process cannot claim to be the one that did it.
   */
  'CONVERGED_AFTER_UNCERTAIN_EFFECT',
  /**
   * No pull request had this head, one request was made, it reported success,
   * and exactly one open pull request now has this head, this base and this
   * draft state.
   *
   * The only member that claims this process changed the forge.
   */
  'CREATED',
] as const;

export type PullRequestCreation = (typeof PULL_REQUEST_CREATIONS)[number];

/**
 * One static sentence per member.
 *
 * What the suite proves about them, measured rather than assumed, because this
 * paragraph claimed more than was there: it checks that a key exists for every
 * member of the vocabulary, and that no sentence is shorter than a floor.
 * Neither of those proves the words. The members its own case names as the ones
 * an operator acts on are additionally pinned by literal; the rest are not, so a
 * change to one of those is caught by review and not by the gate.
 */
export const PULL_REQUEST_CREATION_DETAIL: Readonly<Record<PullRequestCreation, string>> =
  Object.freeze({
    SUBJECT_NOT_ESTABLISHED:
      'There is no delivery target, exact commit, sendable work branch and sendable base branch to be about. Nothing was read from the forge by this path and nothing was attempted.',
    TASK_NOT_READY:
      'The task has not reached READY_FOR_PR. Only a finished task has a delivery head, so nothing was read from the forge by this path and nothing was attempted.',
    OPERATOR_ABSENT:
      'Creating a pull request asks this repository\'s humans to take the work, so it requires an operator to be present for this invocation. Nothing was read from the forge by this path and nothing was attempted. Pass --attended to create.',
    DECISION_NOT_ESTABLISHED:
      'This invocation has no fresh decision about this commit that admits the creation ladder. Either --observe and --decide were not both given, or they were and the answer was one this build will not create from: the observation did not settle, the subject moved, the subject could not be re-read, or a check on this commit failed. A stored record can never stand in for it. Nothing was read from the forge by this path and nothing was attempted.',
    AUTHORITY_REFUSED:
      'The authority for this creation was not one this build minted, or it had already been used. Nothing was attempted.',
    SUBJECT_CHANGED:
      'The pinned commit, the task state, the branches or the delivery target changed after this invocation established them, so the authority no longer describes what is in front of it. Nothing was attempted.',
    REMOTE_URLS_DIVERGE:
      'This remote could not be shown to read and write the same repository — either it reads from one and writes to another, or the two questions about it could not be answered. The head ref would then be read from a different repository than the one the pull request would be opened in, so nothing was attempted.',
    REMOTE_STATE_UNKNOWN:
      'The head ref on the delivery remote could not be read, so nothing was attempted: a pull request is created from a branch, and this build does not ask for one from a ref it could not look at.',
    HEAD_NOT_PUBLISHED:
      'The head ref does not exist on the delivery remote, so there is no branch to open a pull request from. Publish it first with --publish-head; this command does not push, and nothing was attempted.',
    HEAD_SHA_MISMATCH:
      'The head ref exists on the delivery remote and holds a different commit, so a pull request from it would be about other work. This build does not move a published ref, and nothing was attempted.',
    PULL_REQUEST_STATE_UNKNOWN:
      'What pull requests this commit already has could not be established — the forge was not reached, or it answered in a shape this build will not draw a conclusion from. Nothing was attempted: without knowing what was there first, a success afterwards could not be told from something that was already true.',
    PULL_REQUEST_AMBIGUOUS:
      'More than one open pull request already claims this exact head. Which of them is the delivery is not a question this build can answer, and nothing was attempted.',
    PRIOR_PULL_REQUEST_CLOSED:
      'A closed or merged pull request already carries this exact commit as its head, and no open one does. Somebody decided about this delivery already, so nothing was attempted.',
    WRONG_BASE_CONFLICT:
      'An open pull request already has this exact head and targets a different base branch. Retargeting it and opening a second one are both mutations this build does not perform, and nothing was attempted.',
    DRAFT_STATE_CONFLICT:
      'An open pull request already has this exact head and base, and its draft state is not the intended one. This build never marks a pull request ready or back to draft, so nothing was attempted.',
    CREATION_REFUSED:
      'No pull request with this head exists on the forge, and this invocation did not establish that it sent a request for one — either the request was refused, or none was sent. Nothing on the forge changed.',
    OUTCOME_UNCERTAIN:
      'Whether the forge created a pull request could not be established. Do not ask again to find out — ask again, and the answer will be read from the forge before anything is attempted.',
    POSTCONDITION_MISMATCH:
      'What is at this head afterwards is not the intended pull request — the base, the draft state or the open state is different, or there is more than one. If a request was sent, this build may have created one of them. Nothing was edited, retargeted, closed or retried in response.',
    ALREADY_EXISTS:
      'Exactly one open pull request already had this head, this base and this draft state. Nothing was sent, because the intended state was already true.',
    CONVERGED_AFTER_UNCERTAIN_EFFECT:
      'No request of this invocation reported success, and the intended pull request is now open. The intended state is established; this invocation cannot claim it is what established it.',
    CREATED:
      'No pull request had this head, one request was made, and exactly one open pull request now has this head, this base and this draft state.',
  });

/**
 * The members under which the intended pull request is open on the forge.
 *
 * Three provenances, one established state. A caller that needs to know whether
 * the pull request exists asks this and not `=== 'CREATED'`, because two of the
 * three say so without this process having done it — and a caller that treats
 * `ALREADY_EXISTS` as a failure will send a second request for no reason.
 *
 * Held as a set rather than as a union of comparisons so there is one place to
 * read the answer from. What stops it widening silently is the suite's
 * enumerated equality against these three names, and that alone. A second case
 * asks the predicate and the set the same question for every member; it pins
 * the two to each other and cannot detect a widening, because both sides of it
 * move together — the suite says so beside it, and this sentence claimed
 * otherwise until a review read the two back against each other.
 */
export const ESTABLISHED_PULL_REQUEST_CREATIONS: ReadonlySet<PullRequestCreation> = Object.freeze(
  new Set<PullRequestCreation>(['CREATED', 'ALREADY_EXISTS', 'CONVERGED_AFTER_UNCERTAIN_EFFECT']),
) as ReadonlySet<PullRequestCreation>;
// `Object.freeze` does not make a `Set` immutable — it does not touch internal
// slots, so `add` still works on a value cast back to a mutable type. It is
// applied for the properties it does freeze and is **not** what stops this set
// widening; the suite's enumerated equality is. A review pointed out that the
// paragraph above used to claim otherwise, and a later one that the replacement
// credited a "partition" assertion that had by then been deleted for being a
// tautology.

/** Whether the intended pull request is open on the forge. */
export function pullRequestIsEstablished(creation: PullRequestCreation): boolean {
  return ESTABLISHED_PULL_REQUEST_CREATIONS.has(creation);
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
 *
 * The mint does not refuse *every* spelling that is not a bare name — measured,
 * it accepts `refs/heads/main` and `HEAD`, because Git accepts the first as a
 * branch and this build's grammar has no case for the second. The consequence
 * is stated rather than assumed: a run intending `refs/heads/main` never
 * matches GitHub's reported `main`, so it fails closed — into
 * `WRONG_BASE_CONFLICT`, `POSTCONDITION_MISMATCH` or `CREATION_REFUSED`
 * depending on what the readings find — rather than converging on the wrong
 * pull request. The list is the reachable set, not a promise of two.
 */
export function gradePullRequestCreation(
  intended: IntendedPullRequest,
  before: PullRequestSituation,
  attempt: PullRequestAttempt,
  after: PullRequestSituation | null,
): PullRequestCreation {
  if (before.outcome === 'UNKNOWN') return 'PULL_REQUEST_STATE_UNKNOWN';
  if (before.outcome === 'OPEN_MANY') return 'PULL_REQUEST_AMBIGUOUS';
  if (before.outcome === 'CLOSED_ONLY') return 'PRIOR_PULL_REQUEST_CLOSED';

  if (before.outcome === 'OPEN_ONE') {
    // The intended state may already be true. Nothing should have been
    // attempted, and the orchestration does not attempt anything — but this
    // function is exported and must be total, so the reading decides rather
    // than trusting the caller to have obeyed.
    const open = before.open;
    // A reading that says `OPEN_ONE` and carries no pull request is a reading
    // this build cannot act on. Graded as an unreadable state rather than as an
    // absence, because "I was told there is one and cannot see it" is not the
    // same fact as "there is none".
    if (open === null) return 'PULL_REQUEST_STATE_UNKNOWN';
    if (open.baseRef !== intended.baseRef) return 'WRONG_BASE_CONFLICT';
    if (open.draft !== intended.draft) return 'DRAFT_STATE_CONFLICT';
    return 'ALREADY_EXISTS';
  }

  if (before.outcome !== 'NONE') {
    // Not reachable while `PULL_REQUEST_SITUATIONS` holds five members, and
    // present for the reason `exitCodeFor` and `decideDelivery` give for
    // theirs: the strongest claim this build can make is two lines below, and
    // a sixth situation must not be able to arrive there by falling off the
    // end. A review found this floor missing and demonstrated the fall-through
    // with a widened vocabulary, which `tsc` accepted.
    const unreachable: never = before.outcome;
    void unreachable;
    return 'PULL_REQUEST_STATE_UNKNOWN';
  }

  // Nothing had this head. From here the answer depends on what happened next.
  //
  // `NOT_ATTEMPTED` is deliberately *not* short-circuited here, and that is a
  // correction. It used to answer `CREATION_REFUSED` immediately, which said
  // "The request was refused and no pull request with this head exists" on a
  // path where no request was ever made — the transport reports `NOT_ATTEMPTED`
  // for an unsupported host, an unusable environment and a refused argument,
  // all before a process exists — and, worse, it threw away a post-reading the
  // orchestration had already taken. A reading is the authority in this module;
  // an attempt word that overrules one is the defect this module exists to
  // avoid. So all three attempt words now go through the same ladder, and
  // `attempt` is consulted exactly twice, where the readings cannot separate
  // the cases on their own.
  if (after === null || after.outcome === 'UNKNOWN') return 'OUTCOME_UNCERTAIN';
  if (after.outcome === 'OPEN_MANY') return 'POSTCONDITION_MISMATCH';
  if (after.outcome === 'CLOSED_ONLY') return 'POSTCONDITION_MISMATCH';

  if (after.outcome === 'NONE') {
    // A transport that reported success and left nothing findable behind is the
    // one case where the two sources disagree, and the disagreement itself is
    // the finding. It is not graded as a failure: the forge may have created a
    // pull request from a ref that moved, or may not have indexed this one yet,
    // and neither is distinguishable from here.
    return attempt === 'COMPLETED' ? 'OUTCOME_UNCERTAIN' : 'CREATION_REFUSED';
  }

  const open = after.open;
  if (open === null) return 'OUTCOME_UNCERTAIN';
  if (open.baseRef !== intended.baseRef) return 'POSTCONDITION_MISMATCH';
  if (open.draft !== intended.draft) return 'POSTCONDITION_MISMATCH';
  return attempt === 'COMPLETED' ? 'CREATED' : 'CONVERGED_AFTER_UNCERTAIN_EFFECT';
}
