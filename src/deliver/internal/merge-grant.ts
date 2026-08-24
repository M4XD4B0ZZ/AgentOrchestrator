/**
 * The authority to merge ONE pull request, and nothing else.
 *
 * The third forge mutation this build has, and the third artefact for it. Slice
 * 5 publishes a ref, slice 6 opens a pull request, and this one merges exactly
 * one. They are deliberately not one capability and there is deliberately no
 * supertype: a publication is additive and a pull request is a request, while a
 * merge writes to the base branch — the one ref this build otherwise never
 * touches — and its undo is a revert commit rather than a deletion. An operator
 * who authorised either of the smaller acts must not thereby have authorised
 * this one.
 *
 * ── Why a third artefact rather than a wider one ──────────────────────────
 *
 * The rule slice 6 states holds in all three directions here. Each class
 * carries a private field, so TypeScript compares them nominally:
 *
 *  - a `HeadPublicationGrant` or a `PullRequestCreationGrant` handed to
 *    `mergePullRequest` is a **type error**, not a runtime refusal;
 *  - a `MergeGrant` handed to `publishDeliveryHead` or `createPullRequest` is a
 *    type error too;
 *  - there is no supertype, no interface any two satisfy, no union and no
 *    conversion.
 *
 * `tests/v4-07-explicit-merge-effect.test.ts` pins every direction with
 * `@ts-expect-error`, which `tsc --noEmit` checks inside the canonical gate. And
 * each mint owns its own registry, so a value cast past the compiler is refused
 * at runtime as well: the two gates are independent.
 *
 * ── Why it is one-shot ────────────────────────────────────────────────────
 *
 * The same reasoning and the same implementation as its two siblings: the facts
 * are unreadable except through {@link MergeGrant.claim}, which moves the
 * artefact into a spent registry in the statement that returns them. There is
 * no accessor that reads without spending, so "merge at most once per
 * authority" is a property of the type rather than a rule a caller has to
 * remember. A second claim answers `null`, which the merger grades as a refusal.
 *
 * It matters more here than it did for either sibling. **Measured against
 * github.com**: a merge request against an already-merged pull request answers
 * `200 {"merged":true}` and replays the *original* merge commit, ignoring both
 * the `sha` this build sends and the `merge_method`. A build that could spend
 * one authority twice would therefore get a success-shaped answer the second
 * time and have no way, from the response alone, to tell it apart from the
 * first.
 *
 * ── What it binds, and why each part ──────────────────────────────────────
 *
 * `taskId` — the identity the merge is a delivery of. Bound for slice 6's
 * reason: the act is about a task, and the identity it is about must be part of
 * what was authorised rather than something the merger looks up later.
 *
 * `{host, owner, name}` — the exact repository.
 * `PUT /repos/{owner}/{repo}/pulls/{n}/merge` puts two of these in the path;
 * the host is `--hostname github.com` and is re-tested here against the frozen
 * list `forge-observation.ts` owns.
 *
 * `pullRequestNumber` — **the object of the act**, and the only way this build
 * addresses it. It is not derived from a branch name or remembered from an
 * earlier run: it comes from *this invocation's own* observation proof, which
 * is the only thing that can produce one. Bound because the request path is
 * made of it and because the postcondition is read back by it.
 *
 * `expectedHeadCommit` — forty lowercase hex digits, and the field this slice
 * turns on. Unlike slice 6's head, this one **is sent**: GitHub's merge endpoint
 * accepts a `sha` documented as "SHA that pull request head must match to allow
 * merge", and — measured — answers
 * `409 "Head branch was modified. Review and try the merge again."` and merges
 * nothing when it does not match. That is a compare-and-swap the *server*
 * evaluates, which is what `--force-with-lease` is for slice 5 and what slice 6
 * had no equivalent of. Forty, not forty-or-sixty-four: measured, the endpoint
 * answers `422 "The sha parameter must be exactly 40 characters and contain
 * only [0-9a-f]."` for an abbreviation and for anything else.
 *
 * `baseRef` — the branch the pull request must be targeting. A name, never an
 * object name. It is **not** sent: the endpoint takes no base, and the merge
 * happens against whatever GitHub's base ref holds at that moment. It is bound
 * so that the reading taken immediately before can refuse a pull request whose
 * base is not the intended one, and so that the reading taken afterwards can
 * say the merge landed where it was meant to. This build does not claim to have
 * frozen the base; see the merger's header.
 *
 * `mergeMethod` — stated, never defaulted. The REST schema declares no default
 * for `merge_method`, so a request that omitted it would take whatever GitHub
 * chooses. This repository's convention is squash — measured: every merge on
 * `main` from `#56` to `#59` is a single-parent commit whose parent is the
 * previous pull request's `merge_commit_sha` — and {@link MERGE_METHODS} has
 * exactly one member for that reason. A slice that wants another one adds it
 * here, deliberately.
 *
 * ── What it does NOT grant ────────────────────────────────────────────────
 *
 * Pushing a ref, opening a pull request, updating, closing or reopening one,
 * marking it ready or back to draft, commenting, labelling, requesting or
 * submitting a review, enabling auto-merge, entering a merge queue, deleting a
 * branch, or merging a second pull request. Those are not refused by a check
 * inside the merger — they are absent from the build.
 */

import {
  isAddressableSubject,
  supportedForgeHost,
  type ObservationSubject,
} from '../forge-observation.js';
import { isValidTaskId } from '../../plan/task-id.js';
// From the shared grammar module, not from slice 6's authority. That module
// exists for exactly this: `internal/pull-request-creation-grant.ts` declares an
// authority, the suite pins which four files may import it, and a third
// authority importing it *for a predicate* would widen that set without
// widening what anybody can do. `isSendableBranchName` moved here for the same
// reason `PUBLISHABLE_REF` did in slice 6, and slice 6's own callers are
// unchanged because its old home re-exports it.
import { isSendableBranchName } from './delivery-ref-grammar.js';

/**
 * The merge methods this build will ask for.
 *
 * One member. GitHub's endpoint accepts three — measured: `merge_method` outside
 * `["merge","squash","rebase"]` answers `422` naming the set — and this build
 * asks for one of them, because this repository merges by squash and a delivery
 * command that could choose would be a delivery command making a repository
 * policy decision nobody gave it.
 *
 * A closed set rather than a bare string literal so the mint has something to
 * test at runtime: a field typed as the literal `'squash'` would make "the
 * wrong method is refused" a compile error and nothing else, and the compile
 * error is not reachable from a caller that has already been cast past.
 */
export const MERGE_METHODS = ['squash'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** The repository's convention, named once. */
export const DELIVERY_MERGE_METHOD: MergeMethod = 'squash';

/**
 * Everything one merge is about.
 *
 * Eight fields, and every one of them is an identity, a number this build read
 * off a forge, an object name, a ref name, or a constant this build chose.
 * Nothing here came out of a repository as prose, and unlike slice 6's subject
 * there is no free text at all: the merge request carries two fields and both
 * are bounded by a grammar.
 */
export interface MergeSubject {
  /** The task whose delivery this is. Canonical task-id grammar. */
  readonly taskId: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** The pull request to merge. A positive safe integer, from an observation. */
  readonly pullRequestNumber: number;
  /**
   * Forty lowercase hex digits. GitHub must find exactly this at the head.
   *
   * Sent as the request's `sha`, and compared again by the readings taken
   * before and after. The send is what makes the comparison atomic with the
   * merge; the readings are what let this build say what happened.
   */
  readonly expectedHeadCommit: string;
  /** The branch the pull request must target. A name; never an object name. */
  readonly baseRef: string;
  /** The method this build asks for. Stated in the request, never defaulted. */
  readonly mergeMethod: MergeMethod;
}

const MINTED = new WeakSet<object>();
const SPENT = new WeakSet<object>();

/**
 * Captured at module load, before any other module has run.
 *
 * The argument both siblings make: `WeakSet.prototype.has` is a mutable
 * property of a global object, and reading it through the instance at call time
 * would let a caller who can assign to that prototype decide the answer for
 * every artefact in the process.
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

export class MergeGrant {
  readonly #subject: MergeSubject;

  constructor(subject: MergeSubject) {
    this.#subject = subject;
  }

  /**
   * Registry membership, not `instanceof` and not "has the private field".
   *
   * A value that reached the prototype some other way is not a grant, however
   * exactly it is shaped.
   */
  static holds(value: unknown): value is MergeGrant {
    return typeof value === 'object' && value !== null && isMinted(value as object);
  }

  /**
   * Reads the facts once, and marks the grant spent in the same call.
   *
   * `null` for a value this build did not mint, and `null` for one it did mint
   * and has already handed over. There is deliberately no way to ask which:
   * both mean "this is not an authority you may act on now".
   *
   * The private-field read is guarded because a value can pass the registry
   * gate without carrying the field — a caller who captures the registry itself
   * can add an arbitrary object to it.
   *
   * **Which of the two lines actually refuses a forgery was measured, and it is
   * not the one a reader expects.** Replacing the registry gate below with
   * `if (false)` kills no case in the suite: every value an outside caller can
   * construct — a plain object with the right shape, or
   * `Object.create(prototype)` — has no private field, so the read throws and
   * the `catch` answers `null` anyway. The registry gate is what refuses a
   * value that *has* the field and was not minted, which nothing outside this
   * module can build, since the constructor is deleted and the class frozen.
   *
   * Both stay. They refuse different things, the pair is what
   * {@link isMergeGrant} and this accessor are documented to mean together, and
   * a gate that is unreachable today is not the same as one that is wrong — the
   * argument the transport makes about re-testing a capability at the point of
   * use. What is not claimed is that removing either would be caught.
   */
  static claim(grant: MergeGrant): MergeSubject | null {
    if (!MergeGrant.holds(grant)) return null;
    if (isSpent(grant as object)) return null;
    markSpent(grant as object);
    try {
      return grant.#subject;
    } catch {
      return null;
    }
  }
}

/** What {@link mintMergeGrant} needs beside the observation subject. */
export interface MergeIntent {
  readonly taskId: string;
  readonly pullRequestNumber: number;
  readonly baseRef: string;
  readonly mergeMethod: string;
}

/**
 * Mints the authority to merge one pull request, or refuses.
 *
 * `null` for every input this cannot vouch for. Each refusal is a way the
 * calling module could come to hold a value it did not establish:
 *
 *  - a task id outside the canonical grammar: the id is what the report and the
 *    authority are about, and the state schema requires the field to be
 *    non-blank and nothing more;
 *  - a pull-request number that is not a positive safe integer: it goes into
 *    the request path, and a number that is not one of those is a path segment
 *    this build did not compose;
 *  - a base that is not a plain branch name under `repo/branch-name.ts`: it is
 *    compared by exact equality against what GitHub reports, and the
 *    shell-inert character class alone accepts `refs/heads/main`, `HEAD`, `@`,
 *    `a..b` and `x.lock`, none of which Git accepts as a branch;
 *  - a merge method outside {@link MERGE_METHODS}: measured, GitHub answers
 *    `422` for a method outside its own three, and this build asks for one;
 *  - a subject that is not addressable — an owner or name that is not a path
 *    segment, or a commit that is not a forty-hex object name. One predicate,
 *    `isAddressableSubject`, and it is `forge-observation.ts`'s: the commit is
 *    sent as the request's `sha` and compared byte-for-byte against what the
 *    readings report, and the owner and name are two thirds of the request
 *    path;
 *  - a subject whose host is not supported: re-tested here through
 *    `supportedForgeHost` rather than trusted from the subject type, which is
 *    structural.
 *
 * There is no arm that mints a weaker grant from a partial input, and there is
 * no arm that mints one from a stored record: the number this takes can only
 * have come from an observation proof, and slice 3's store has no path here.
 */
export function mintMergeGrant(
  target: ObservationSubject,
  intent: MergeIntent,
): MergeGrant | null {
  if (!isValidTaskId(intent.taskId)) return null;
  if (typeof intent.pullRequestNumber !== 'number') return null;
  if (!Number.isSafeInteger(intent.pullRequestNumber)) return null;
  if (intent.pullRequestNumber <= 0) return null;
  if (typeof intent.baseRef !== 'string' || !isSendableBranchName(intent.baseRef)) return null;
  if (typeof intent.mergeMethod !== 'string') return null;
  if (!(MERGE_METHODS as readonly string[]).includes(intent.mergeMethod)) return null;

  // The three fields that make the request addressable, through the predicate
  // `forge-observation.ts` owns rather than a fourth private copy of its regex.
  // Slice 6 measured what a private copy costs: it admitted a sixty-four-hex
  // commit that `createObservationSubject` and the transport both refuse, so
  // the mint could issue a grant that could never be acted on. Here the cost
  // would be worse — the commit is *sent*, and the endpoint answers `422` for
  // anything that is not exactly forty lowercase hex digits.
  if (typeof target.commit !== 'string') return null;
  if (typeof target.owner !== 'string' || typeof target.name !== 'string') return null;
  if (!isAddressableSubject(target.owner, target.name, target.commit)) return null;
  if (supportedForgeHost(target.host) === null) return null;

  const grant = new MergeGrant(
    Object.freeze({
      taskId: intent.taskId,
      host: target.host,
      owner: target.owner,
      name: target.name,
      pullRequestNumber: intent.pullRequestNumber,
      expectedHeadCommit: target.commit,
      baseRef: intent.baseRef,
      mergeMethod: intent.mergeMethod as MergeMethod,
    }),
  );
  MINTED.add(grant);
  return grant;
}

// The constructor is reachable from any instance as
// `Object.getPrototypeOf(grant).constructor`, and that route produced a working
// forgery against an earlier artefact in this codebase. Removing the property
// closes it; freezing both objects stops it being put back.
Reflect.deleteProperty(MergeGrant.prototype, 'constructor');
Object.freeze(MergeGrant.prototype);
Object.freeze(MergeGrant);
