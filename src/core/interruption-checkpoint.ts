/**
 * The interruption checkpoint: the public type, and the only ways to use one.
 *
 * This module is what the rest of the codebase sees. It can *name* the artefact,
 * *check* one and *read* one, and it cannot make one — the mint stays in
 * `internal/interruption-checkpoint.ts`, whose header carries the reasoning for
 * the whole arrangement.
 *
 * Same shape as `core/containment-attestation.ts` and
 * `core/execution-lease-evidence.ts`, deliberately: a reader who knows one knows
 * the others, and none of them can quietly become laxer than its siblings.
 */

import { InterruptionCheckpointProof } from './internal/interruption-checkpoint.js';

/**
 * Proof that this process observed a task's worktree settled — at an exact
 * commit, with no uncommitted change — after an interrupted writer had stopped.
 *
 * Opaque by construction. Callers hold it, forward it and hand it to
 * `recordAgentInterruption`; they never build one.
 *
 * Note what it does **not** assert. It is not a claim that a writing pass
 * completed, that verification ran, or that the task may advance — the state it
 * is recorded on is a block. It is a statement about one moment, which is
 * exactly why the value recorded from it is re-compared against a fresh
 * observation before anything is allowed to continue.
 */
export type InterruptionCheckpoint = InterruptionCheckpointProof;

/**
 * Whether this really is a minted checkpoint.
 *
 * Registry membership, not shape, not prototype, not a private-field probe. The
 * mint's header states which of those were defeated against this codebase's
 * other opaque artefacts and how.
 *
 * Accepts `unknown` so the check is meaningful at a boundary where the static
 * type has already been subverted — which is the only place it matters.
 */
export function isInterruptionCheckpoint(value: unknown): value is InterruptionCheckpoint {
  return InterruptionCheckpointProof.holds(value);
}

/**
 * The commit inside a checkpoint, or `null` for anything that is not one.
 *
 * The safe accessor, and the only one offered. `InterruptionCheckpointProof.commitOf`
 * reads a private field, so it *throws* for a value that passed the registry gate
 * without going through the constructor — reachable by capturing the registry
 * itself, as `core/containment-attestation.ts` records. A check that answers by
 * throwing is not answering, so this one asks safely and reports the refusal as
 * `null`, which withdraws the checkpoint exactly as an absent one does.
 */
export function interruptionCheckpointCommitOf(value: unknown): string | null {
  if (!isInterruptionCheckpoint(value)) return null;
  try {
    return InterruptionCheckpointProof.commitOf(value);
  } catch {
    return null;
  }
}
