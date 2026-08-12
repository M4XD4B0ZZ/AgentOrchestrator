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
 *
 * ── Authority is proved *here*, at the write (V2-07L / B) ──────────────────
 *
 * A move is what a caller makes **after** something took time. `runLoopStep`
 * starts an agent that thinks for minutes, runs the repository's verification,
 * or drives a reviewer, and only then advances the state — so the run driver
 * proving the lease at the top of its iteration proves it about a world that no
 * longer exists. Measured, not inferred: a lease deleted during the writing
 * agent let that step finish and record `VERIFYING` before the run stopped.
 *
 * The guarantee this closes is exactly one sentence, and it is narrower than it
 * first looks:
 *
 * > After the lease is lost, no further orchestrator-owned durable state
 * > transition happens.
 *
 * It is deliberately **not** the wider claim that nothing else can happen. An
 * agent subprocess already started may still be writing in the worktree and may
 * still land a commit on the task branch; stopping *that* needs owned process
 * containment — a Windows Job Object, a supervised POSIX process group, and
 * cancellation semantics on top — which is a slice of its own and is not
 * pretended to be solved by a lease.
 *
 * ── Why the check is here and not at each call site ────────────────────────
 *
 * Because there are eighteen call sites in `loop-step.ts` alone, and a rule
 * enforced by remembering is a rule that a nineteenth will break. This is the
 * one function every durable transition passes through, so the requirement is a
 * required parameter of it: a caller with no lease to offer does not compile,
 * and the proof is re-taken from the file on every single move rather than
 * carried in a boolean somebody set earlier.
 *
 * Creation is `saveTaskState`'s, not this function's, and it is gated in
 * `start-task.ts` rather than here — immediately before the write, for the same
 * reason. An earlier version of this sentence dismissed that gap as "a handful
 * of Git commands rather than an agent"; it is nothing of the kind. Between
 * `startTask`'s entry gate and its first durable write sits the auth preflight,
 * which the CLI's own comment calls expensive and which starts two real
 * subscription CLIs — measured at 2552 ms for the capability dump alone. A
 * review created a branch, a worktree and a first state through the real entry
 * points with the lease demonstrably gone in that window.
 */

import { comparePathIdentity } from '../core/path-identity.js';
import { canTransition } from '../core/transitions.js';
import { safeParseTaskState } from '../core/task-state.js';
import {
  verifyExecutionLeaseHeldFor,
  type ExecutionLeaseAuthority,
} from '../lease/execution-lease.js';
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
export interface AdvanceOptions
  extends Omit<StateStoreOptions, 'expectedRevision' | 'repositoryRoot'> {
  /**
   * The execution lease this writer holds, re-proved here against the file.
   *
   * **Required, and deliberately not optional.** See the header: this is the
   * choke point every durable transition passes through, and a parameter is the
   * only form of the requirement that a nineteenth call site cannot forget.
   *
   * It is also where the write target comes from. `repositoryRoot` is
   * deliberately *not* an option here — see the derivation at the end of
   * {@link advanceTaskState} for why two values that must agree are two values
   * that can disagree.
   */
  readonly lease: ExecutionLeaseAuthority;
}

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

  // Last, and immediately before the write. Ordered after the cheap contract
  // checks deliberately: those are facts about the value the caller built and
  // cost nothing, while this one is a fact about *now* and is worth taking as
  // late as it can be taken.
  const held = verifyExecutionLeaseHeldFor(options.lease.repository, options.lease.evidence);
  if (held.code !== 'HELD') {
    return Object.freeze({
      ok: false as const,
      code: 'EXECUTION_LEASE_LOST' as const,
      path: null,
      detail: held.code,
      errnoCode: null,
    });
  }

  return saveTaskState(parsed.data, {
    ...options,
    // Derived from the authority, never taken beside it.
    //
    // This used to be a separate `repositoryRoot` option, and two independent
    // values that must agree are two values that can disagree: a review landed a
    // durable transition in repository B on the strength of A's lease, and the
    // guard added for it compared the wrong field — `root` is documented as
    // "recorded for diagnosis, never the key", while `gitCommonDir` is what
    // decides which lease is read. Comparing roots neither implies that
    // invariant nor follows from it, and it would additionally refuse the case
    // the design requires, since a linked worktree has a different root and the
    // same key.
    //
    // So there is no pair left to compare. The write goes to the root of the
    // repository whose lease was just proved, and a caller cannot name a
    // different one because there is nowhere to name it.
    repositoryRoot: options.lease.repository.root,
    expectedRevision: current.revision,
  });
}
