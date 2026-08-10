/**
 * Moving a task from one state to the next, durably.
 *
 * This is the persistence primitive the runtime loop will call. It is not the
 * loop: nothing here decides *which* state comes next, runs an agent, or reads a
 * repository. It takes a state a caller has already decided on and persists it,
 * refusing every move the state machine does not declare.
 *
 * ── Why this exists next to `saveTaskState()` ──────────────────────────────
 *
 * `saveTaskState()` validates a state *in isolation*. That is the right
 * contract for it — the first state a task ever has must be writable, and there
 * is no previous state to relate it to — but it means the contract cannot see
 * the one thing that makes a move legal or not: the state it came from.
 * `TaskStateSchema` will happily accept a `CREATED` document and an
 * `IMPLEMENTING` document; only `transitions.ts` knows that the second may not
 * directly follow the first.
 *
 * So the two are deliberately separate:
 *
 *  - {@link saveTaskState} — *creation*. Writes a state that has no predecessor.
 *  - {@link advanceTaskState} — *movement*. Requires the state that was read,
 *    and consults the transition table before writing anything.
 *
 * The table is consulted, never restated. `canTransition()` is the single
 * authority on which state follows which, exactly as it is for the resume
 * policy, and a new edge is added there or nowhere.
 *
 * ── A checkpoint is not a move ─────────────────────────────────────────────
 *
 * Re-persisting the *same* state — a new `stateEnteredAt`, an appended finding,
 * an updated `currentCommit` — is a checkpoint, not a transition, and the table
 * does not describe it: no state lists itself as its own successor. Requiring a
 * declared edge for it would make the ordinary act of recording progress
 * impossible, so an unchanged state name is allowed through and only a genuine
 * change is checked.
 *
 * Stale-writer protection is not re-implemented either: the revision the caller
 * read is threaded straight into {@link saveTaskState}, so a task that moved on
 * underneath this writer is refused with `STATE_CONFLICT` as it is everywhere
 * else.
 */

import { canTransition } from '../core/transitions.js';
import { safeParseTaskState } from '../core/task-state.js';
import {
  saveTaskState,
  type StateLoadSuccess,
  type StateSaveResult,
  type StateStoreOptions,
} from './state-store.js';

/**
 * Options for a move. `expectedRevision` is not among them: it is taken from
 * the state that was read, so a caller cannot advance a task while claiming to
 * have read something else.
 */
export type AdvanceOptions = Omit<StateStoreOptions, 'expectedRevision'>;

/**
 * Persists `next` as the successor of the state in `current`.
 *
 * Refuses with `ILLEGAL_TRANSITION` when the move is not declared by the
 * transition table, `STATE_CONTRACT_VIOLATION` when `next` is not a valid state
 * at all, and `STATE_CONFLICT` when another writer got there first. Every
 * refusal writes nothing.
 */
export function advanceTaskState(
  current: StateLoadSuccess,
  next: unknown,
  options: AdvanceOptions,
): StateSaveResult {
  const parsed = safeParseTaskState(next);
  if (!parsed.success) {
    return Object.freeze({
      ok: false as const,
      code: 'STATE_CONTRACT_VIOLATION' as const,
      path: null,
      detail: parsed.error.issues[0]?.code ?? null,
      errnoCode: null,
    });
  }

  const from = current.state.state;
  const to = parsed.data.state;

  // Only a genuine change is a transition. See the module comment.
  if (from !== to && !canTransition(from, to)) {
    return Object.freeze({
      ok: false as const,
      code: 'ILLEGAL_TRANSITION' as const,
      path: null,
      // The states themselves, not a rendered sentence: this is a code path,
      // and the caller already holds both values.
      detail: `${from}->${to}`,
      errnoCode: null,
    });
  }

  return saveTaskState(parsed.data, { ...options, expectedRevision: current.revision });
}
