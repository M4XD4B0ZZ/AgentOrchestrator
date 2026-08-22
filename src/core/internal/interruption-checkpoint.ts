/**
 * The interruption checkpoint — the mint, and the only place one can be made
 * (V3-10 / F-10).
 *
 * ── What this artefact says, and what it emphatically does not ─────────────
 *
 * It says: *after an interrupted writer had stopped, this process observed the
 * task's worktree at exactly this commit, with no uncommitted change.* One
 * moment, two facts, both measured.
 *
 * It does **not** say that a writing pass completed, that the work is right,
 * that verification ran, or that anything may advance. The state it is recorded
 * on is a block, and it stays one. A checkpoint is the answer to "what did the
 * repository look like when we stopped", so that a later run can ask "is it
 * still that" — nothing more.
 *
 * ── Why the artefact exists at all ─────────────────────────────────────────
 *
 * `evaluateAutomaticResume` grants an unattended resume only when the durable
 * state records an exact `currentCommit` **and** `worktreeCleanAtCheckpoint ===
 * true`, and only when a fresh observation still agrees with both. Until V3-10 a
 * mutating phase interrupted by a usage limit could record neither: the writer
 * may have moved HEAD or dirtied the tree, so `withdrawnCheckpointFor` withdrew
 * the old claims and put nothing in their place. That was correct, and it made
 * every production quota block permanently non-resumable — F-10.
 *
 * The fix is to *establish* the two facts rather than to stop requiring them.
 * This is what carries them from the code that established them to the one
 * durable write that records them.
 *
 * ── Why it is opaque, and why that is not decoration ───────────────────────
 *
 * `recordAgentInterruption` is exported and has several callers. A pair of
 * plain parameters there — `currentCommit`, `clean` — would let any of them mint
 * unattended execution authority for a repository nobody looked at, which is the
 * single highest-value claim in this codebase. A structural type cannot carry
 * the requirement either: `{ commit: string; clean: true }` is a shape any
 * caller can write down, and a richer shape is only a longer thing to write
 * down.
 *
 * So the gate is membership of a registry only {@link mintInterruptionCheckpoint}
 * writes to. It is deliberately **not**:
 *
 *  - `instanceof`, because `Object.create` hands anybody the prototype;
 *  - a private-field probe (`#commit in value`), because the class is reachable
 *    from any genuine artefact as `Object.getPrototypeOf(value).constructor`
 *    with no import at all, and calling it installs a real private field.
 *
 * Neither route is hypothetical: `core/internal/containment-attestation.ts`
 * records that both were used against this codebase's earlier opaque artefacts,
 * in that order. This one is built at the end state rather than walking the same
 * path again, and it is deliberately the same shape as its two siblings so that
 * a reader who knows one knows all three.
 *
 * ── The mint re-derives; it does not take the caller's word ────────────────
 *
 * Both inputs are re-checked here even though the single production caller has
 * already checked them. The one function that can produce the artefact is the
 * wrong place to trust anything: a caller that becomes wrong should mint
 * nothing, not mint something wrong.
 */

import { GIT_SHA_PATTERN } from './task-state-object-schema.js';

/**
 * The registry. A `WeakSet` a value cannot be reached from — an instance can
 * hand out its prototype and its constructor, and neither of those is this.
 */
const MINTED = new WeakSet<object>();

function isMinted(value: object): boolean {
  return MINTED.has(value);
}

/**
 * The two facts a settlement must have established, as the caller observed
 * them.
 *
 * Both are nullable because both questions can go unanswered, and an unanswered
 * question has never been permission here: `worktreeClean === null` means Git
 * was not asked, which the mint treats exactly as it treats a dirty tree.
 */
export interface SettledWorktreeObservation {
  /** HEAD as Git printed it, or `null` when it could not be resolved. */
  readonly observedCommit: string | null;
  /** `true` only when Git reported no uncommitted change. `null` is "unasked". */
  readonly worktreeClean: boolean | null;
}

export class InterruptionCheckpointProof {
  readonly #commit: string;

  constructor(commit: string) {
    this.#commit = commit;
  }

  /** Whether the mint built this value. See the header for what this is not. */
  static holds(value: unknown): value is InterruptionCheckpointProof {
    return typeof value === 'object' && value !== null && isMinted(value as object);
  }

  /**
   * The commit HEAD was observed at.
   *
   * A static reading a private field rather than a getter, for the reason the
   * containment proof gives: an own property shadows a prototype getter, so a
   * getter would be a member a forgery can define and the private field would
   * never be read.
   */
  static commitOf(proof: InterruptionCheckpointProof): string {
    return proof.#commit;
  }
}

/**
 * Mints a checkpoint for a worktree that was observed settled, or `null`.
 *
 * `null` for every input this cannot vouch for, and each refusal is a way the
 * calling module could come to hold a value it did not establish:
 *
 *  - `worktreeClean` other than `true` — the tree held uncommitted work, or Git
 *    was never asked. Two different truths, one denial, and the second is the
 *    one that matters: an unasked question must never read as a clean tree.
 *  - an absent `observedCommit` — a HEAD nobody read. The commit a settlement
 *    *made* is not the same value as the HEAD somebody *observed* afterwards,
 *    and only the second is evidence about the repository as it now stands.
 *  - a commit that is not a full lowercase object name. Refused **here** rather
 *    than at the state contract: an abbreviated or decorated value would
 *    otherwise travel as evidence all the way to `advanceTaskState` and come
 *    back as `STATE_CONTRACT_VIOLATION`, which names the wrong cause and names
 *    it after the settlement already believed it had succeeded.
 */
export function mintInterruptionCheckpoint(
  observation: SettledWorktreeObservation,
): InterruptionCheckpointProof | null {
  if (observation.worktreeClean !== true) return null;
  const commit = observation.observedCommit;
  if (typeof commit !== 'string' || !GIT_SHA_PATTERN.test(commit)) return null;
  const proof = new InterruptionCheckpointProof(commit);
  MINTED.add(proof);
  return proof;
}
