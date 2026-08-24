/**
 * The authority to publish ONE delivery head, and nothing else.
 *
 * V4 slice 5 is the first slice in this build permitted to change something
 * outside the machine. Everything before it reported: slice 1 named the
 * delivery target, slice 2 asked github.com two read-only questions, slice 3
 * stored an answer beside the task, slice 4 graded two answers into one word.
 * None of them could alter a byte on a forge. This one can create a remote ref.
 *
 * ── Why an artefact rather than a flag ────────────────────────────────────
 *
 * The rule the slice hangs on is that knowing a thing is required is not
 * permission to do it. `PULL_REQUEST_REQUIRED` is a *finding*; publishing a
 * head is an *act*; opening a pull request is a different act; merging is a
 * third. A boolean parameter cannot hold that distinction — it is one bit, and
 * every caller who can reach the function can set it. A named type can: the
 * publisher's signature demands this class and no other, so a caller who has
 * not been through the mint cannot construct an argument that type-checks, and
 * one who forges the shape cannot get past the registry.
 *
 * The same reasoning, and the same three-layer shape, as
 * `internal/delivery-observation-proof.ts` and `core/internal/
 * interruption-checkpoint.ts`. It is copied deliberately: the history of the
 * weaker gates is recorded in `core/internal/execution-lease-evidence.ts`, and
 * both of the forgeries reproduced there — a prototype borrowed through
 * `Object.create`, and a constructor reached through
 * `Object.getPrototypeOf(value).constructor` — defeated an `instanceof` check
 * and a `#field in value` check respectively, with no import of the mint.
 *
 * ── Why it is one-shot, and why that is structural too ────────────────────
 *
 * A grant that could be read twice is a grant that could publish twice. The
 * facts are therefore not readable at all except by {@link HeadPublicationGrant.claim},
 * which moves the artefact into a spent registry in the same statement that
 * returns them. There is no accessor that reads without spending, so "use it
 * once" is not a rule a caller has to remember — it is the only thing the type
 * offers. A second call answers `null`, which the publisher grades as a
 * refusal rather than as a missing subject.
 *
 * ── What it binds, and why each part ──────────────────────────────────────
 *
 * `{host, owner, name}` — the exact repository. A grant minted for one target
 * cannot authorise a push to another; the same reason slice 2 refuses to reuse
 * an answer about repository A for a question about repository B.
 *
 * `remoteName` — the *local* name of the remote to push to. The identity above
 * is what slice 1 read out of that remote's push URL, and the push has to name
 * the remote, not the URL: a URL in an argument vector is the value most likely
 * to carry a credential, which is why `delivery-target.ts` refuses to record
 * one at all.
 *
 * `ref` — the full ref name to create, `refs/heads/<workBranch>`. Publishing is
 * about a ref; observing is about a commit. Both are bound because a ref alone
 * says nothing about content and a commit alone says nothing about where.
 *
 * `commit` — the exact forty-hex object name. The push is written as
 * `<commit>:<ref>`, never `<branch>:<ref>`, so a local branch that moves after
 * this grant was minted cannot change what gets published.
 *
 * ── What it does NOT grant ────────────────────────────────────────────────
 *
 * Opening a pull request, updating one, closing one, commenting, labelling,
 * requesting review, merging, enabling auto-merge, deleting a ref, moving a ref
 * that already exists, or pushing any other ref. Those are not refused by a
 * check inside the publisher — they are absent from the build. This artefact is
 * the only forge-mutation authority that exists, and the only function that
 * accepts it publishes exactly one ref, create-only.
 */

import type { ObservationSubject } from '../forge-observation.js';

/**
 * The four facts a publication is about, plus the two that say where.
 *
 * Note what is not here: no URL, no credential, no task title, no branch
 * description, no free text of any kind. The push vector can only carry what
 * this holds, so the rule that no repository-authored prose reaches the network
 * is enforced by the shape rather than by a filtering step somebody has to
 * remember to run. Slice 3 arrived at the same conclusion for the same reason.
 */
export interface HeadPublicationSubject {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** The local name of the remote, as the repository profile declared it. */
  readonly remoteName: string;
  /** Full ref name, `refs/heads/<branch>`. */
  readonly ref: string;
  /** Forty lowercase hex digits. */
  readonly commit: string;
}

/** Forty or sixty-four lowercase hex digits, anchored. */
const COMMIT_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * `refs/heads/` followed by a branch name this build will put in an argument
 * vector. The character class is `repo/branch-name.ts`'s, narrowed further by
 * `doctor/exec.ts`'s shell-inert grammar: no space, no quote, no metacharacter.
 * A leading `-` is impossible because `refs/heads/` precedes it.
 */
const PUBLISHABLE_REF = /^refs\/heads\/[A-Za-z0-9._+=@/-]+$/;

/** Names this build will not put in an argument vector as a remote. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MINTED = new WeakSet<object>();
const SPENT = new WeakSet<object>();

/**
 * Captured at module load, before any other module has run.
 *
 * `WeakSet.prototype.has` is a mutable property of a global object. Reading it
 * through the instance at call time would let a caller who can assign to that
 * prototype decide the answer for every artefact in the process. Binding it
 * here means the gate holds the function it was defined with.
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

export class HeadPublicationGrant {
  readonly #subject: HeadPublicationSubject;

  constructor(subject: HeadPublicationSubject) {
    this.#subject = subject;
  }

  /**
   * Registry membership, not `instanceof` and not "has the private field".
   *
   * A value that reached the prototype some other way is not a grant, however
   * exactly it is shaped.
   */
  static holds(value: unknown): value is HeadPublicationGrant {
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
   * can add an arbitrary object to it. Such a value answers `null` here rather
   * than throwing, and the publisher refuses it by name.
   */
  static claim(grant: HeadPublicationGrant): HeadPublicationSubject | null {
    if (!HeadPublicationGrant.holds(grant)) return null;
    if (isSpent(grant as object)) return null;
    markSpent(grant as object);
    try {
      return grant.#subject;
    } catch {
      return null;
    }
  }
}

/**
 * Mints the authority to publish one head, or refuses.
 *
 * `null` for every input this cannot vouch for, and each refusal is a way the
 * calling module could come to hold a value it did not establish:
 *
 *  - a commit that is not an object name: the push writes `<commit>:<ref>`, and
 *    a value that is not forty hex digits is either a branch name in disguise
 *    — which would publish whatever that branch points at, later — or a token
 *    the argument grammar would refuse anyway;
 *  - a ref that is not `refs/heads/<name>` under the shell-inert grammar: a
 *    partial ref is resolved by Git against a search order, and this build does
 *    not push to a ref whose meaning depends on what else exists;
 *  - a remote name that is not a bare name: the remote is the one place a URL
 *    could enter the vector, and a URL is the value most likely to carry a
 *    credential;
 *  - a subject whose host is not the one the build supports, or whose owner or
 *    name is blank: an identity that cannot be checked against the observation
 *    is an identity the postcondition cannot be bound to.
 *
 * There is no arm that mints a weaker grant from a partial input. "The operator
 * asked, but the ref is odd" is not a smaller authority — it is not one.
 */
export function mintHeadPublicationGrant(
  target: ObservationSubject,
  remoteName: string,
  ref: string,
): HeadPublicationGrant | null {
  if (typeof remoteName !== 'string' || !REMOTE_NAME.test(remoteName)) return null;
  if (typeof ref !== 'string' || !PUBLISHABLE_REF.test(ref)) return null;
  if (typeof target.commit !== 'string' || !COMMIT_OBJECT_NAME.test(target.commit)) return null;
  if (typeof target.host !== 'string' || target.host.length === 0) return null;
  if (typeof target.owner !== 'string' || target.owner.length === 0) return null;
  if (typeof target.name !== 'string' || target.name.length === 0) return null;

  const grant = new HeadPublicationGrant(
    Object.freeze({
      host: target.host,
      owner: target.owner,
      name: target.name,
      remoteName,
      ref,
      commit: target.commit,
    }),
  );
  MINTED.add(grant);
  return grant;
}

// The constructor is reachable from any instance as
// `Object.getPrototypeOf(grant).constructor`, and that route produced a working
// forgery against an earlier artefact in this codebase. Removing the property
// closes it; freezing both objects stops it being put back.
Reflect.deleteProperty(HeadPublicationGrant.prototype, 'constructor');
Object.freeze(HeadPublicationGrant.prototype);
Object.freeze(HeadPublicationGrant);
