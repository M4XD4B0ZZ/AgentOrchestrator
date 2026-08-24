/**
 * The title and body of the pull request AO opens, composed from four
 * identifiers and nothing else.
 *
 * Pure and deterministic: the same task, branch, base and commit produce
 * byte-identical text every time. No clock, no counter, no environment, no
 * locale.
 *
 * ── What reaches the network, stated plainly ──────────────────────────────
 *
 * Slice 5 could promise that no repository-authored text left the machine,
 * because a `git push` vector has nowhere to put any. A pull request has a
 * title and a body, so this slice cannot make that promise and does not. What
 * it makes instead is a smaller, checkable one: **the only repository-derived
 * values that reach GitHub are the task id, the work-branch name, the base-branch
 * name and the head object name.** Every other byte below is a literal in this
 * file.
 *
 * Each of those four is bounded before it gets here:
 *
 *  - the task id passes `isValidTaskId` at the mint — letters, digits, `.`, `_`
 *    and `-`, bounded length. The task-state schema itself requires only a
 *    non-blank string, so the mint is where the grammar is actually applied;
 *  - the branch and base names pass the shell-inert grammar at the mint;
 *  - the commit is forty or sixty-four lowercase hex digits.
 *
 * So the text is ASCII by construction. There is no normalisation step here
 * because there is nothing to normalise: no input can carry a combining mark, a
 * bidirectional control, a zero-width joiner or a non-ASCII digit and still
 * reach this function.
 *
 * ── What is deliberately not in it ────────────────────────────────────────
 *
 * No diff, no `git log`, no commit messages, no local paths, no environment, no
 * agent transcript, no review findings, no test output, no check results, no
 * task title or description — the task-state record has no such field, which is
 * why this composes an identity line rather than a summary. Nothing here reads
 * a file.
 *
 * The result is a pull request that says what it is about and claims nothing
 * about whether the work is any good. That is the honest thing for it to say:
 * AO opens it and stops, and the reviewing is a human's.
 */

/**
 * The byte budgets for the two text fields.
 *
 * Enforced at the mint rather than at the transport, so an over-long value is
 * refused before an authority exists rather than truncated into one. Declared
 * here, beside the function that composes the text, because that is what they
 * bound — and because the module that enforces them declares an authority, and
 * the set of files allowed to import that one is pinned by the suite.
 *
 * Both are measured in UTF-8 bytes, not code units: the transport writes bytes,
 * and a limit counted in JavaScript characters would be a different limit.
 *
 * Neither budget is close to what this build composes — the longest content it
 * can produce is a few hundred bytes — and that is the point. A generous
 * ceiling on a field nobody fills is a ceiling that invites somebody to fill it.
 */
export const MAX_TITLE_BYTES = 256;
export const MAX_BODY_BYTES = 4096;

const UTF8 = new TextEncoder();

/** UTF-8 length, which is what the transport will actually write. */
export function byteLength(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * The draft state AO creates with. Chosen, measured, and never changed after.
 *
 * `false`, because this repository has never had a draft pull request: all 59
 * pull requests it has ever carried report `isDraft: false` — measured, not
 * assumed. A slice-6 default of `true` would have made AO's own delivery the
 * first draft in the repository's history.
 *
 * It is written into the request explicitly rather than omitted. GitHub's
 * schema declares `draft` optional **with no default**, so leaving it out would
 * make the resulting state a property of whatever the API happens to do that
 * day. And this build never marks a pull request ready or back to draft
 * afterwards — that is a different mutation, and it is not in this slice — so
 * the value chosen here is the only one AO will ever set.
 *
 * A constant rather than an option, for the reason `--publish-head`'s lease
 * value is not a parameter: a caller who can choose it is a caller who can
 * choose the one this build has no way to correct.
 */
export const AO_PULL_REQUEST_DRAFT = false;

/** Everything the content is composed from. All four are already validated. */
export interface PullRequestContentInputs {
  readonly taskId: string;
  /** Full ref name, `refs/heads/<workBranch>`. */
  readonly headRef: string;
  readonly headCommit: string;
  readonly baseRef: string;
}

export interface PullRequestContent {
  readonly title: string;
  readonly body: string;
}

const REFS_HEADS = 'refs/heads/';

/** The work branch, from the full ref. The ref's grammar guarantees the prefix. */
export function branchOf(headRef: string): string {
  return headRef.startsWith(REFS_HEADS) ? headRef.slice(REFS_HEADS.length) : headRef;
}

/**
 * The sentence that says who opened this and what it does not mean.
 *
 * Exported so the suite can pin it by literal. It is the one paragraph a human
 * reviewer reads before deciding what the pull request is worth, and every
 * clause is a claim this build has to keep true: it opened this, it will not
 * touch it again, and its existence is not evidence about the work.
 */
export const PULL_REQUEST_PROVENANCE =
  'Opened by AgentOrchestrator. AO created this pull request and will not update, close, ' +
  'reopen, review, comment on, label or merge it. Its existence establishes nothing about the ' +
  'work: no review, no verification result and no merge authority.';

/**
 * The title, cut to the budget the mint enforces.
 *
 * Needed because the two parts are independently bounded and their sum is not:
 * a task id at its own limit beside a long-but-legal branch name composes a
 * title over budget, and the mint would then refuse the grant. Refusing to open
 * a pull request because a branch name is long would be a bad failure for a
 * good reason nobody could act on.
 *
 * The cut is deterministic, marked, and counted in bytes because that is what
 * the budget is in. Every input the mint accepts is ASCII — the task-id and
 * ref grammars admit nothing else — so a byte cut cannot land inside a
 * character; the marker is three full stops rather than an ellipsis for the
 * same reason.
 *
 * The full ref is in the body either way, so nothing is lost, only shortened.
 */
export function boundedTitle(title: string): string {
  if (byteLength(title) <= MAX_TITLE_BYTES) return title;
  return `${title.slice(0, MAX_TITLE_BYTES - 3)}...`;
}

/**
 * Composes the title and body.
 *
 * The title is `<taskId>: <branch>` — the identity an operator tracks, then the
 * branch it is on, cut to the budget by {@link boundedTitle} if the pair is
 * longer than one. Both parts are bounded on their own and their sum is not,
 * which is the whole reason that function exists.
 *
 * The body states the four identities on their own lines and then the
 * provenance paragraph. The head object name is in it because a pull request's
 * `head` is a *branch*, which moves: the commit this pull request was opened for
 * is a fact that would otherwise be unrecoverable once the branch advances.
 */
export function composePullRequestContent(
  inputs: PullRequestContentInputs,
): PullRequestContent {
  const branch = branchOf(inputs.headRef);
  return Object.freeze({
    title: boundedTitle(`${inputs.taskId}: ${branch}`),
    body:
      `Task        : ${inputs.taskId}\n` +
      `Head ref    : ${inputs.headRef}\n` +
      `Head commit : ${inputs.headCommit}\n` +
      `Base ref    : ${inputs.baseRef}\n` +
      `\n` +
      `${PULL_REQUEST_PROVENANCE}\n`,
  });
}
