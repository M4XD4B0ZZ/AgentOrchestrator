/**
 * The containment attestation — the mint, and the only place one can be made.
 *
 * ── What this artefact says, and what it emphatically does not ─────────────
 *
 * It says: *a process was created inside a Job Object this process owns, the
 * kernel confirmed its membership, and it never existed outside that job.* That
 * is a
 * statement about **lifetime** — when the owner dies, the job dies, and
 * everything in it goes — and the ADR for the native launch boundary is explicit
 * that a job bounds process lifetime and nothing else.
 *
 * It is therefore **not** writer authority. Nothing in this file, and nothing
 * derived from it, may decide who is allowed to produce effects in a repository.
 * That decision belongs to the execution lease and to nothing else; containment
 * evidence exists so that a *later* slice can ask the separate question "did this
 * dead owner's writer tree die with it", which lease fencing cannot answer.
 *
 * ── Why it is opaque, and why that is not decoration ───────────────────────
 *
 * The requirement this artefact carries is that evidence may only come from a
 * containment path that was actually established. A structural type cannot carry
 * that: `{ helperPid: number, childPid: number, … }` is a shape any caller can
 * write down, and a richer shape is only a longer thing to write down. The same
 * lesson `core/internal/execution-lease-evidence.ts` records at length, reached
 * there by an adversarial review that forged working lease evidence twice.
 *
 * So the gate is membership of a registry only {@link mintContainmentAttestation}
 * writes to. It is deliberately **not**:
 *
 *  - `instanceof`, because `Object.create` hands anybody the prototype;
 *  - a private-field probe (`#facts in value`), because the class is reachable
 *    from any genuine artefact as `Object.getPrototypeOf(value).constructor`
 *    with no import at all, and calling it installs a real private field.
 *
 * Those two routes are not hypothetical here — they are the two that were used
 * against this codebase's other opaque artefact, in that order. This one is built
 * at the end state rather than walking the same path again.
 *
 * ── The mint re-derives; it does not take the caller's word ────────────────
 *
 * Every input is re-checked below even though the single production caller has
 * already checked it. The one function that can produce the artefact is the
 * wrong place to trust anything: a caller that becomes wrong should mint
 * nothing, not mint something wrong.
 */

import { createHash } from 'node:crypto';

/**
 * The registry. A `WeakSet` a value cannot be reached from — an instance can
 * hand out its prototype and its constructor, and neither of those is this.
 */
const MINTED = new WeakSet<object>();

function isMinted(value: object): boolean {
  return MINTED.has(value);
}

/** Domain separation for the launch digest. Never the empty string. */
const LAUNCH_DIGEST_LABEL = 'agent-orchestrator/containment-launch/v1';

/**
 * A plausible boundary launch nonce.
 *
 * A *presence and sanity* check, and deliberately not a format claim. The
 * authority on the shape is `boundary/start-owned-process.ts`, which uses
 * `randomUUID()` — an earlier version of this pattern was written from a
 * remembered hex nonce, matched nothing that module produces, and silently
 * refused to attest every real launch. Inferring a format from what a value
 * looked like somewhere is the mistake; asking the component that owns it is the
 * fix, and the honest check here is "somebody gave us an identifier".
 *
 * It does not need to be more: the status this nonce came from has already been
 * refused as foreign unless it carried *this* launch's nonce
 * (`BoundaryEndingObservation.expect`), and the value is only ever hashed.
 */
const LAUNCH_NONCE = /^[!-~]{8,128}$/;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * What one established containment looked like, in plain values.
 *
 * These are the facts a durable record is built from. They are readable — the
 * artefact hides its *constructibility*, not its content, because a reader
 * learning which pids were contained gains nothing while a writer minting a
 * fact that never happened gains everything.
 */
export interface ContainmentFacts {
  /** The process the job is coupled to: the one whose death destroys it. */
  readonly ownerPid: number;
  /** The helper holding the only handle to the job. */
  readonly helperPid: number;
  /** The contained target. */
  readonly childPid: number;
  /** `JOBLIST` or `SUSPENDED`, as the boundary reported it. */
  readonly mode: string;
  /** Whether the kernel placed the process in the job at creation time. */
  readonly assignedAtCreation: boolean | null;
  /**
   * A digest of the launch nonce, and deliberately not the nonce.
   *
   * The nonce authenticates the boundary's status file for the duration of one
   * launch. This value is written into a durable record in the repository's Git
   * directory, which is readable by anyone who can read the repository and
   * outlives the launch — so the identifier that goes there is a one-way
   * function of the nonce. It still distinguishes two launches, which is the
   * only thing a durable record needs it for.
   */
  readonly launchDigest: string;
  /**
   * When this attestation was made, ISO-8601.
   *
   * Named for what it is rather than for what a reader would like it to be. The
   * kernel confirmed job membership back in the boundary's establish loop, and
   * `startOwnedProcess` does not report when — so this is the moment the run was
   * classified, which for an agent is minutes later. It was called `observedAt`
   * and documented as "when the containment was observed", which is a claim the
   * value does not support and precisely the kind a later recovery slice would
   * reason about lifetimes from.
   *
   * Making it the establishment instant needs the boundary to report one, which
   * is a change to slice 1's result shape and not this slice's to make.
   */
  readonly attestedAt: string;
}

/**
 * The facts as the boundary reports them, before anything is minted.
 *
 * Separate from {@link ContainmentFacts} because it carries the raw nonce, which
 * the artefact never does, and because `verifiedInJob` is a *precondition* here
 * rather than a recorded fact: an unverified launch mints nothing at all, so the
 * artefact has no way to express one.
 */
export interface ObservedContainment {
  readonly ownerPid: number;
  readonly helperPid: number;
  readonly childPid: number;
  readonly mode: string;
  readonly assignedAtCreation: boolean | null;
  readonly launchNonce: string;
  readonly attestedAt: string;
  /** The kernel's membership confirmation. Anything but `true` mints nothing. */
  readonly verifiedInJob: boolean;
}

export class ContainmentProof {
  readonly #facts: ContainmentFacts;

  constructor(facts: ContainmentFacts) {
    this.#facts = facts;
  }

  /**
   * Whether the mint built this value. See the header for what this is not.
   */
  static holds(value: unknown): value is ContainmentProof {
    return typeof value === 'object' && value !== null && isMinted(value as object);
  }

  /**
   * The facts this attestation carries.
   *
   * A static reading a private field rather than a getter, for the reason the
   * lease proof gives: an own property shadows a prototype getter, so a getter
   * would be a member a forgery can define and the private field would never be
   * read.
   */
  static factsOf(proof: ContainmentProof): ContainmentFacts {
    return proof.#facts;
  }
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Mints an attestation for a containment that was established, or `null`.
 *
 * `null` for every input this cannot vouch for, and the list is not defensive
 * padding — each entry is a way the calling module could come to hold a value it
 * did not verify:
 *
 *  - `verifiedInJob` other than `true`: the kernel never confirmed membership,
 *    so there is no containment to attest to;
 *  - a missing or malformed launch nonce: the boundary's status could not be
 *    tied to this launch, which is the one thing the nonce exists for;
 *  - a pid that is not a pid, a mode that is not a mode, an instant that is not
 *    one: a record built from them would be unreadable by the schema that has to
 *    accept it back.
 */
export function mintContainmentAttestation(observed: ObservedContainment): ContainmentProof | null {
  if (observed.verifiedInJob !== true) return null;
  if (!isPid(observed.ownerPid) || !isPid(observed.helperPid) || !isPid(observed.childPid)) {
    return null;
  }
  if (typeof observed.mode !== 'string' || observed.mode.length === 0 || observed.mode.length > 32) {
    return null;
  }
  if (
    observed.assignedAtCreation !== null &&
    typeof observed.assignedAtCreation !== 'boolean'
  ) {
    return null;
  }
  if (typeof observed.launchNonce !== 'string' || !LAUNCH_NONCE.test(observed.launchNonce)) {
    return null;
  }
  if (typeof observed.attestedAt !== 'string' || !ISO_8601.test(observed.attestedAt)) return null;

  const proof = new ContainmentProof(
    Object.freeze({
      ownerPid: observed.ownerPid,
      helperPid: observed.helperPid,
      childPid: observed.childPid,
      mode: observed.mode,
      assignedAtCreation: observed.assignedAtCreation,
      launchDigest: createHash('sha256')
        .update(LAUNCH_DIGEST_LABEL)
        // Written as an escape, not as the byte. A literal NUL in the source is
        // invisible in a diff, makes `grep` call the file binary and skip the
        // line, and would let an editor or a formatter swap it for a space —
        // changing every launch digest ever produced, with the whole suite
        // green. Same byte, and it can now be read.
        .update('\u0000')
        .update(observed.launchNonce)
        .digest('hex'),
      attestedAt: observed.attestedAt,
    }),
  );
  // The only line in the codebase that admits anything to the registry.
  MINTED.add(proof);
  return proof;
}

// Closed for the same two reasons the lease proof is closed: the constructor is
// reachable from any instance through its prototype, and a writable static is a
// process-wide off switch for the gate. Neither is what makes the type safe —
// the registry is — and both are cheap.
Reflect.deleteProperty(ContainmentProof.prototype, 'constructor');
Object.freeze(ContainmentProof.prototype);
Object.freeze(ContainmentProof);
