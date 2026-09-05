/**
 * An operator ending a task this orchestrator escalated to them.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * A task parks in `HUMAN_DECISION_REQUIRED` or `BLOCKED_VERIFY`. The operator
 * looks at it, finishes the work by hand, or decides it is no longer wanted, and
 * then has **nowhere to put that fact**. Nothing in this build writes `ABORTED`
 * — a grep over `src/` finds only readers — and `READY_FOR_PR` is withheld from
 * both states on purpose, because approving work must go through a real review
 * pass. So the record stays blocked for ever, and the attention item raised on
 * it stays open for ever: measured on `RESOLVER-V3-054`, whose work was
 * delivered and merged while its state sat unchanged.
 *
 * ── Why this is not a force-complete switch ────────────────────────────────
 *
 * Because the authority is narrow in four ways at once, and none of them is a
 * flag name:
 *
 *  1. **two source states, not six.** Only `HUMAN_DECISION_REQUIRED` and
 *     `BLOCKED_VERIFY` — the states in which the loop stopped and asked the
 *     person driving it for a decision. A `SCOPE_VIOLATION` says an agent left
 *     its sandbox and the run is not trustworthy until somebody has looked; a
 *     `RESUME_STATE_DIVERGED` says the record and the repository disagree.
 *     Ending those from a command line is exactly the escape hatch this design
 *     refuses, and the enum on `operatorResolution.closedFrom` makes the refusal
 *     structural;
 *  2. **its own terminal state.** `OPERATOR_RESOLVED` asserts that a person
 *     ended the task and nothing else. No pull request is opened from it —
 *     `select-delivery-task.ts` gates on `READY_FOR_PR` alone — no verification
 *     is claimed, and no scope cleanliness is implied;
 *  3. **provenance, taken from the record and not from an argument.**
 *     `closedFrom` is whatever the state actually was, so an operator cannot
 *     name a softer refusal than the one they overrode, and a later reader can
 *     count hand-ended tasks and see which gate each one walked away from;
 *  4. **`--attended` and an explicit `--task`.** The same pair every other
 *     operator grant in this build requires: a run that claims nobody is present
 *     may not decide it, and letting a selector choose the task would make an
 *     operator authorise one they never named.
 *
 * There is deliberately **no commit argument**. Requiring one looks like
 * evidence and is not: `rev-parse --verify` exits 0 for any 40-hex string, the
 * spelling that would peel to a commit cannot be spawned by this build at all
 * (`SAFE_ARG_PATTERN` excludes `^`, `{` and `}`, measured in `commit-probes.ts`),
 * and this build does not fetch — so an operator whose work was merged on the
 * forge usually has no locally-resolving commit to name. A guard that refuses
 * honest closures and admits fabricated ones is worse than no guard, and its
 * presence would invite the reader to believe the record says more than it does.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It runs no agent, starts no verification, reconciles nothing and touches no
 * worktree. That is the whole reason it is not a flag on `run`: `run`'s ladder
 * puts an auth preflight, an MCP capability preflight and a full reconciliation
 * in front of the write, and each of those refuses in exactly the situation this
 * exists for — the login is broken, the repository requires a capability, or the
 * worktree has been removed after the work was delivered. A paperwork write must
 * not inherit an agent's preconditions.
 */

import { attentionForTaskState } from '../core/task-attention.js';
import type { TaskState } from '../core/task-state.js';
import { attentionIdFor } from '../notify/internal/attention-location.js';
import {
  removeAttentionRecord,
  type AttentionRemovalCode,
} from '../notify/attention-store.js';
import type { PathProvider } from '../config/internal/path-provider.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { advanceTaskState, type AdvanceOptions } from '../state/advance-state.js';
import { loadTaskState, type StateSaveResult } from '../state/state-store.js';

/** The two states an operator may end a task from. Narrow entry is the guard. */
export const OPERATOR_RESOLVABLE_STATES = ['HUMAN_DECISION_REQUIRED', 'BLOCKED_VERIFY'] as const;

export type OperatorResolvableState = (typeof OPERATOR_RESOLVABLE_STATES)[number];

const RESOLVABLE: ReadonlySet<string> = new Set<string>(OPERATOR_RESOLVABLE_STATES);

/** Every way this command can end. A closed set; one of them wrote. */
export const RESOLVE_TASK_OUTCOMES = [
  /** The record now reads `OPERATOR_RESOLVED`. */
  'RESOLVED',
  /** It already did. Nothing was written, and that is a success. */
  'ALREADY_RESOLVED',
  /** No durable state exists for this task. */
  'TASK_NOT_STARTED',
  /** A record exists and this build cannot read it. Nothing was written. */
  'STATE_UNUSABLE',
  /**
   * The record is in a state an operator may not end from here. Named rather
   * than folded into a generic refusal: the state is the reason.
   */
  'STATE_NOT_RESOLVABLE',
  /** The write was refused. `save` says by what. */
  'STATE_NOT_RECORDED',
] as const;

export type ResolveTaskOutcome = (typeof RESOLVE_TASK_OUTCOMES)[number];

export interface ResolveTaskResult {
  readonly outcome: ResolveTaskOutcome;
  /** The state the record was in when this ran, or `null` when none loaded. */
  readonly from: TaskState['state'] | null;
  /** The write attempt, or `null` when none was made. */
  readonly save: StateSaveResult | null;
  /**
   * What became of the operator-attention item this task had raised.
   *
   * `null` when the record's state raised none, or when nothing was written.
   * Otherwise the store's own code: an item that was there and is now gone, one
   * that had already gone, or a removal that failed — which is reported rather
   * than swallowed, because a surviving item is the operator being asked again
   * for a decision they have just made.
   */
  readonly attentionRemoval: AttentionRemovalCode | null;
}

export interface ResolveTaskOptions extends AdvanceOptions {
  /** The instant the state is entered. Injected, never read from a clock here. */
  readonly now: string;
  /** Where the operator's attention store lives. Defaults to the real one. */
  readonly pathProvider?: PathProvider;
  /** The removal, as a seam. Defaults to the real store's. */
  readonly removeAttention?: (attentionId: string) => AttentionRemovalCode;
}

function result(
  from: Partial<ResolveTaskResult> & { readonly outcome: ResolveTaskOutcome },
): ResolveTaskResult {
  return Object.freeze({ from: null, save: null, attentionRemoval: null, ...from });
}

/**
 * Records that an operator ended one task themselves.
 *
 * Never throws for an expected condition. One durable write, and one targeted
 * removal from the operator's outbox afterwards.
 */
export function resolveTaskByOperator(
  repository: ResolvedRepository,
  taskId: string,
  options: ResolveTaskOptions,
): ResolveTaskResult {
  const loaded = loadTaskState(repository.root, taskId);
  if (!loaded.ok) {
    return result({
      outcome: loaded.classification === 'STATE_MISSING' ? 'TASK_NOT_STARTED' : 'STATE_UNUSABLE',
    });
  }

  const state = loaded.state;
  if (state.state === 'OPERATOR_RESOLVED') {
    return result({ outcome: 'ALREADY_RESOLVED', from: state.state });
  }
  if (!RESOLVABLE.has(state.state)) {
    return result({ outcome: 'STATE_NOT_RESOLVABLE', from: state.state });
  }
  const closedFrom = state.state as OperatorResolvableState;

  // The attention item's identity is derived from the record **as it stands
  // now**, before the write, because that is what the id digests: the
  // repository root, the task id, the reason, the detail and `stateEnteredAt`.
  // Computed first for that reason, and used only if the write lands.
  //
  // One item, by name. `settleAttention` would also have removed it, and would
  // additionally have scanned the whole repository and *raised* records for
  // every other attention-worthy task in it — in a repository the operator never
  // enlisted, records nothing would ever deliver or remove. It also settles only
  // where the scan could read the directory in full, so a single unreadable
  // neighbouring state file would silently leave this item behind after an
  // irreversible terminal write. A removal by id has neither property.
  const attention = attentionForTaskState(state, options.now);
  const attentionId = attention.attention
    ? attentionIdFor({
        repositoryRoot: repository.root,
        taskId,
        reason: attention.reason,
        detail: attention.detail,
        stateEnteredAt: state.stateEnteredAt,
      })
    : null;

  const save = advanceTaskState(
    loaded,
    {
      ...state,
      state: 'OPERATOR_RESOLVED' as const,
      stateEnteredAt: options.now,
      // Terminal: nothing is pending, and the contract refuses the state if any
      // of these three survive it.
      blockedAgent: null,
      resumeFrom: null,
      reportedResetAt: null,
      operatorResolution: { closedFrom },
    },
    options,
  );

  if (!save.ok) return result({ outcome: 'STATE_NOT_RECORDED', from: closedFrom, save });

  // Only after the durable write. An item removed for a state change that was
  // then refused would leave the operator with a blocked task and no notice of
  // it — the one failure the outbox's own header calls silence rather than
  // noise.
  const remove =
    options.removeAttention ??
    ((id: string) =>
      options.pathProvider === undefined
        ? removeAttentionRecord(id)
        : removeAttentionRecord(id, options.pathProvider));

  return result({
    outcome: 'RESOLVED',
    from: closedFrom,
    save,
    attentionRemoval: attentionId === null ? null : remove(attentionId),
  });
}
