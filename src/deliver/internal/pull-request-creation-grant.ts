/**
 * The authority to create ONE pull request, and nothing else.
 *
 * V4 slice 5 gave this build its first forge mutation: creating a remote ref.
 * This slice adds the second, and the two are deliberately not one capability.
 * A publication puts a commit somewhere; a pull request asks a repository's
 * humans to take it. They have different blast radii, different audiences and
 * different undo costs, and a build that held one artefact for both would let
 * an operator who authorised the smaller act perform the larger one.
 *
 * ── Why a second artefact rather than a wider one ─────────────────────────
 *
 * `HeadPublicationGrant` already exists and already binds a repository, a
 * remote name, a ref and a commit — six of the eleven fields below. Widening
 * it would have been
 * fewer lines and would have destroyed the property the slice is for. The rule
 * is stated in that module and holds in both directions here:
 *
 *  - a `HeadPublicationGrant` handed to `createPullRequest` is a **type
 *    error**, not a runtime refusal;
 *  - a `PullRequestCreationGrant` handed to `publishDeliveryHead` is a type
 *    error too;
 *  - there is no supertype, no interface both satisfy, no union and no
 *    conversion. Each class carries a private field, so TypeScript compares
 *    them nominally: nothing that was not declared here can be one of these,
 *    whatever shape it has.
 *
 * `tests/v4-06-pull-request-creation.test.ts` pins both directions with
 * `@ts-expect-error`, which `tsc --noEmit` checks inside the canonical gate, so
 * "cannot substitute" is compiled rather than reviewed.
 *
 * ── Why it is one-shot, and why that is structural ────────────────────────
 *
 * The same reasoning as slice 5's, and the same implementation: the facts are
 * unreadable except through {@link PullRequestCreationGrant.claim}, which moves
 * the artefact into a spent registry in the statement that returns them. There
 * is no accessor that reads without spending, so "create at most one pull
 * request per authority" is the only thing the type offers rather than a rule a
 * caller has to remember. A second claim answers `null`, which the creator
 * grades as a refusal.
 *
 * ── What it binds, and why each part ──────────────────────────────────────
 *
 * `taskId` — bound here and not in slice 5's artefact, because a pull request
 * carries text that names the task, and the identity that text is about must be
 * part of what was authorised rather than something the creator looks up later.
 *
 * `{host, owner, name}` — the exact repository. `POST /repos/{owner}/{repo}/pulls`
 * puts two of these in the path; the host is `--hostname github.com` and is
 * re-tested here against the frozen list `forge-observation.ts` owns.
 *
 * `remoteName` — the local name of the delivery remote. It never reaches
 * GitHub; it is bound because the two questions asked before the request is
 * sent are local Git ones about that remote, and a precondition checked
 * against something the authority did not name is a precondition about
 * something else.
 *
 * `headRef` — the full ref name, `refs/heads/<workBranch>`. Bound in full
 * because this build reads that exact ref off the remote before it asks GitHub
 * to open anything, and a partial ref is resolved against a search order.
 *
 * `headCommit` — the exact object name the head ref must hold. Forty lowercase
 * hex digits, because that is what `forge-observation.ts` accepts and every
 * reading on this path goes through it. This line said "forty-hex", then said
 * "forty or sixty-four", and both were read off a private regex that this mint
 * no longer has: it asks `isAddressableSubject` instead, which is the predicate
 * the observation and the transport already apply.
 * **Measured, GitHub will not accept an object name as `head`**: a full SHA of a
 * commit that exists answers `422 {"field":"head","code":"invalid"}`, exactly as
 * a missing branch does. So the commit cannot be sent; it can only be *checked*,
 * before and after, and that is what the creator does with it.
 *
 * `baseRef` — the branch the pull request targets. A name, not an object name,
 * for the same measured reason: a full SHA as `base` answers
 * `422 {"field":"base","code":"invalid"}`. This build therefore does not claim
 * to pin the base to a commit, because the API does not offer that.
 *
 * `draft` — the pull request's draft state, stated rather than defaulted. This
 * build never marks a pull request ready or back to draft, so the state chosen
 * at creation is the only one it will ever set, and an authority that did not
 * name it would be authorising a property nobody decided.
 *
 * `title` and `body` — the exact bytes that will be sent. Slice 5's artefact
 * could promise that no free text reaches the network because a push vector has
 * nowhere to put any. A pull request does, so the promise here is different and
 * weaker on purpose: the text is bound *in the authority*, so the request can
 * carry only what was authorised, and what is authorised is composed by
 * `composePullRequestContent` out of identifiers and object names alone.
 *
 * ── What it does NOT grant ────────────────────────────────────────────────
 *
 * Pushing a ref, updating a pull request, closing or reopening one, marking it
 * ready or back to draft after creation, commenting, labelling, requesting
 * review, submitting a review, merging, enabling auto-merge, or creating a
 * second pull request. Those are not refused by a check inside the creator —
 * they are absent from the build.
 */

import {
  isAddressableSubject,
  supportedForgeHost,
  type ObservationSubject,
} from '../forge-observation.js';
import { isValidBranchName } from '../../repo/branch-name.js';
import { isValidTaskId } from '../../plan/task-id.js';
import { PUBLISHABLE_REF, REMOTE_NAME } from './delivery-ref-grammar.js';
// The budgets live with the module that composes the text they bound, so a
// caller that needs them does not have to import this one. The set of files
// that can reach a mint is pinned by the suite, and it should stay a set of
// files that have business reaching it.
import { MAX_BODY_BYTES, MAX_TITLE_BYTES, byteLength } from '../pull-request-content.js';

/**
 * Everything one pull-request creation is about.
 *
 * Eleven fields, and every one of them is either an identity, a local remote
 * name, an object name, a ref name, a boolean this build chose, or text this
 * build composed from those. Nothing here came out of a repository as prose.
 */
export interface PullRequestCreationSubject {
  /** The task whose delivery this is. Canonical task-id grammar. */
  readonly taskId: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /**
   * The *local* name of the delivery remote.
   *
   * Not part of the request — a pull request is created over HTTP against the
   * identity above, and no remote name reaches GitHub. It is bound because the
   * two questions this build asks before sending anything are local Git ones:
   * do this remote's fetch and push URLs agree, and what does its copy of the
   * head ref hold. Both name a remote, both are preconditions of the mutation,
   * and an authority that did not carry the remote would be an authority whose
   * preconditions were checked against something it had not named.
   */
  readonly remoteName: string;
  /** Full ref name, `refs/heads/<workBranch>`. */
  readonly headRef: string;
  /** Forty or sixty-four lowercase hex digits. The ref must hold exactly this. */
  readonly headCommit: string;
  /** The branch the pull request targets. A name; never an object name. */
  readonly baseRef: string;
  /** The draft state to create with, stated explicitly in the request. */
  readonly draft: boolean;
  readonly title: string;
  readonly body: string;
}

/**
 * The base branch's grammar: the tail of `PUBLISHABLE_REF`, on its own.
 *
 * The base is sent as a branch **name** — `main`, not `refs/heads/main` — so it
 * cannot reuse the ref pattern directly. The character class is the same one,
 * for the same reason: this value ends up in a JSON body this build composes,
 * and a base that is not a plain branch name is a base this build cannot show
 * it understood. A leading `-` is refused explicitly, because unlike the head
 * ref there is no `refs/heads/` in front of it to make one impossible.
 *
 * The task-state schema constrains `baseBranch` to a non-blank string and no
 * further, so this is the first place the value meets a grammar at all.
 */
export const DELIVERY_BASE_REF = /^[A-Za-z0-9._+=@][A-Za-z0-9._+=@/-]*$/;

/**
 * The rule the base and the work branch must actually pass.
 *
 * {@link DELIVERY_BASE_REF} is the shell-inert character class and it is not
 * enough on its own: it accepts `@`, `a..b`, `a//b`, `main/`, `main.`, `a/.b`
 * and `x.lock`, and it has no length bound at all. The mint was the loosest
 * gate this value met and the one claiming to have understood it.
 *
 * So both names are additionally put through `repo/branch-name.ts`, which is
 * where this build already decides what a branch name is — Git's own
 * `check-ref-format` rules. Measured, that refuses every value listed above and
 * caps the length at 255, which is what bounds the composed body; the body had
 * no bound at all before it.
 *
 * **It does not refuse everything a reviewer expected it to**, and the
 * difference is stated rather than assumed: `refs/heads/main` and `HEAD` both
 * pass `isValidBranchName` — measured — because Git does allow a branch called
 * `refs/heads/main`, and this build's grammar does not carry `check-ref-format`'s
 * special case for `HEAD`. Sending either as a `base` gets a `422` from GitHub
 * and creates nothing, which is the fail-closed direction; the claim here is
 * only what was measured.
 *
 * It is deliberately stricter than `PUBLISHABLE_REF`, which slice 5 uses and
 * which carries `L-V4-05-9` — a work branch that slice 5 will publish and this
 * slice will refuse is a real difference, and the safe direction: a name Git
 * would not accept as a branch cannot become a pull request either.
 */
export function isSendableBranchName(name: string): boolean {
  return DELIVERY_BASE_REF.test(name) && isValidBranchName(name);
}

const REFS_HEADS = 'refs/heads/';

const MINTED = new WeakSet<object>();
const SPENT = new WeakSet<object>();

/**
 * Captured at module load, before any other module has run.
 *
 * The same argument slice 5's artefact makes: `WeakSet.prototype.has` is a
 * mutable property of a global object, and reading it through the instance at
 * call time would let a caller who can assign to that prototype decide the
 * answer for every artefact in the process.
 */
const isMinted: (value: object) => boolean = WeakSet.prototype.has.bind(MINTED) as (
  value: object,
) => boolean;

const isSpent: (value: object) => boolean = WeakSet.prototype.has.bind(SPENT) as (
  value: object,
) => boolean;

const markSpent: (value: object) => WeakSet<object> = WeakSet.prototype.add.bind(SPENT) as (
  value: object,
) => WeakSet<object>;

export class PullRequestCreationGrant {
  readonly #subject: PullRequestCreationSubject;

  constructor(subject: PullRequestCreationSubject) {
    this.#subject = subject;
  }

  /**
   * Registry membership, not `instanceof` and not "has the private field".
   *
   * A value that reached the prototype some other way is not a grant, however
   * exactly it is shaped.
   */
  static holds(value: unknown): value is PullRequestCreationGrant {
    return typeof value === 'object' && value !== null && isMinted(value as object);
  }

  /**
   * Reads the facts once, and marks the grant spent in the same call.
   *
   * `null` for a value this build did not mint, and `null` for one it did mint
   * and has already handed over. There is deliberately no way to ask which:
   * both mean "this is not an authority you may act on now", and a caller that
   * could tell them apart would be a caller reasoning about someone else's
   * grant.
   *
   * The private-field read is guarded because a value can pass the registry
   * gate without carrying the field — a caller who captures the registry itself
   * can add an arbitrary object to it.
   */
  static claim(grant: PullRequestCreationGrant): PullRequestCreationSubject | null {
    if (!PullRequestCreationGrant.holds(grant)) return null;
    if (isSpent(grant as object)) return null;
    markSpent(grant as object);
    try {
      return grant.#subject;
    } catch {
      return null;
    }
  }
}

/** What {@link mintPullRequestCreationGrant} needs beside the observation subject. */
export interface PullRequestIntent {
  readonly taskId: string;
  readonly remoteName: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly draft: boolean;
  readonly title: string;
  readonly body: string;
}

/**
 * Mints the authority to create one pull request, or refuses.
 *
 * `null` for every input this cannot vouch for. Each refusal is a way the
 * calling module could come to hold a value it did not establish:
 *
 *  - a task id outside the canonical grammar: the id is written into the title
 *    and the body, and that grammar is what makes it a bounded identifier
 *    rather than arbitrary text out of a state file, whose schema requires the
 *    field to be non-blank and nothing more;
 *  - a remote name that is not a bare name: it is the one place a URL could
 *    enter a local Git argument vector, and a URL is the value most likely to
 *    carry a credential;
 *  - a head ref that is not `refs/heads/<name>` under the shell-inert grammar:
 *    the creator reads that exact ref off the remote before it asks for
 *    anything, and a partial ref is resolved against a search order;
 *  - a base, or a work branch, that is not a plain branch name under
 *    `repo/branch-name.ts`: both are sent or compared as branch names, and the
 *    shell-inert character class alone accepts `refs/heads/main`, `HEAD`, `@`,
 *    `a..b` and `x.lock`, none of which Git accepts as a branch. The
 *    255-character limit that comes with it is also what bounds the composed
 *    body, which otherwise had no bound at all;
 *  - a head ref whose branch is the base branch: measured, GitHub answers
 *    `422 "No commits between main and main"`. Asking for something the far
 *    side refuses every time is not a smaller authority, it is a mistake, and
 *    refusing here spends neither a request nor a grant on it;
 *  - a title or body that is empty or over budget: an unbounded field is the
 *    one place this design could leak, and a pull request with no title is one
 *    nobody can identify;
 *  - a subject that is not addressable — an owner or name that is not a path
 *    segment, or a commit that is not a forty-hex object name. One predicate,
 *    `isAddressableSubject`, and it is `forge-observation.ts`'s: the commit is
 *    compared byte-for-byte against what the remote ref holds, and the owner
 *    and name are two thirds of the request path;
 *  - a subject whose host is not supported: re-tested here through
 *    `supportedForgeHost` rather than trusted from the subject type, which is
 *    structural, and which a review has hand-cast straight past before.
 *
 * There is no arm that mints a weaker grant from a partial input.
 */
export function mintPullRequestCreationGrant(
  target: ObservationSubject,
  intent: PullRequestIntent,
): PullRequestCreationGrant | null {
  if (!isValidTaskId(intent.taskId)) return null;
  if (typeof intent.remoteName !== 'string' || !REMOTE_NAME.test(intent.remoteName)) return null;
  if (typeof intent.headRef !== 'string' || !PUBLISHABLE_REF.test(intent.headRef)) return null;
  if (!isSendableBranchName(intent.headRef.slice(REFS_HEADS.length))) return null;
  if (typeof intent.baseRef !== 'string' || !isSendableBranchName(intent.baseRef)) return null;
  if (typeof intent.draft !== 'boolean') return null;
  if (typeof intent.title !== 'string' || intent.title.length === 0) return null;
  if (typeof intent.body !== 'string' || intent.body.length === 0) return null;
  if (byteLength(intent.title) > MAX_TITLE_BYTES) return null;
  if (byteLength(intent.body) > MAX_BODY_BYTES) return null;
  if (intent.headRef === `refs/heads/${intent.baseRef}`) return null;

  // One predicate for the three fields that make the request addressable, and
  // it is `forge-observation.ts`'s own — the module that decides what this
  // build will put in a request path. A fourth private copy of the object-name
  // regex lived here and a review measured what it cost: it admitted a
  // sixty-four-hex commit that `createObservationSubject` and the transport
  // both refuse, so the mint could issue a grant that could never be acted on.
  // `isAddressableSubject` is exported precisely so a guard can be repeated at
  // the point of use rather than re-spelled.
  if (typeof target.commit !== 'string') return null;
  if (typeof target.owner !== 'string' || typeof target.name !== 'string') return null;
  if (!isAddressableSubject(target.owner, target.name, target.commit)) return null;
  if (supportedForgeHost(target.host) === null) return null;

  const grant = new PullRequestCreationGrant(
    Object.freeze({
      taskId: intent.taskId,
      host: target.host,
      owner: target.owner,
      name: target.name,
      remoteName: intent.remoteName,
      headRef: intent.headRef,
      headCommit: target.commit,
      baseRef: intent.baseRef,
      draft: intent.draft,
      title: intent.title,
      body: intent.body,
    }),
  );
  MINTED.add(grant);
  return grant;
}

// The constructor is reachable from any instance as
// `Object.getPrototypeOf(grant).constructor`, and that route produced a working
// forgery against an earlier artefact in this codebase. Removing the property
// closes it; freezing both objects stops it being put back.
Reflect.deleteProperty(PullRequestCreationGrant.prototype, 'constructor');
Object.freeze(PullRequestCreationGrant.prototype);
Object.freeze(PullRequestCreationGrant);
