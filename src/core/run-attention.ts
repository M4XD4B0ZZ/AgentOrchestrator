/**
 * What a *run's own ending* means for the operator who is not watching (M4).
 *
 * ── The blindness this closes ──────────────────────────────────────────────
 *
 * `core/task-attention.ts` judges a **task state**, and `notify/attention-outbox.ts`
 * finds those states by enumerating durable records on disk. That instrument can
 * only see conditions a task record was written for, and `L-M3-F-3` recorded the
 * consequence exactly:
 *
 *   > `notify/attention-outbox.ts` scans durable task states and judges them
 *   > with `attentionForTaskState`, which is keyed on `state.state`. No lifecycle
 *   > or run outcome reaches it, so `STALE_LEASE_PRESENT`,
 *   > `LEASE_ACQUISITION_REFUSED`, `LEASE_RELEASE_UNPROVEN`,
 *   > `REPOSITORY_UNPLANNABLE` and `REPOSITORY_UNRESOLVABLE` raise no durable
 *   > item and send no push.
 *
 * That is `U3`, and the reason `U3` is fatal to unsupervised running is not that
 * one message is missing. It is that **the absence of a message stops proving
 * anything**: a repository that has been unreachable since the first cycle looks
 * exactly like a repository with nothing to say.
 *
 * ── The rule, and it is a rule rather than 31 opinions ─────────────────────
 *
 * A lifecycle outcome raises an item here **iff it leaves no durable task state
 * that the task scan will judge for itself**.
 *
 * Both halves matter. Without the first, endings that already reach an operator
 * through the task scan would be announced twice, from two records, for one
 * condition — and the second copy would then have to be resolved separately.
 * Without the second, exactly the conditions that are invisible stay invisible.
 *
 * So every outcome that *is* a task state — `BLOCKED_VERIFY`, `SCOPE_VIOLATION`,
 * `HUMAN_DECISION_REQUIRED` and the rest — is `SILENT` **here** and loud
 * **there**, and the suite measures that correspondence in both directions
 * rather than trusting this sentence.
 *
 * ── Why a throw is a member of the same vocabulary ─────────────────────────
 *
 * `run/repository-coordinator.ts` wraps every admission so that a rejection
 * becomes a settled record carrying `threw: true`, because a rejection escaping
 * that loop would abandon its siblings unawaited. That is the right containment
 * and it produced the other half of `U3`: a throw leaves `lifecycle` null, so
 * there is no outcome to judge and nothing was ever said about it.
 *
 * {@link RUN_THREW} is that case given a name in this vocabulary. It is
 * deliberately **not** an exception message: no text from a throw reaches a
 * record, because a record is a bounded document with a closed grammar and an
 * exception is neither.
 */

import type { LifecycleOutcome } from '../run/lifecycle-driver.js';

/**
 * The pseudo-outcome for an admission whose driver rejected.
 *
 * Not a `LifecycleOutcome` — the driver produced none, which is the whole point
 * — so it is a distinct constant and the judged vocabulary is the union.
 */
export const RUN_THREW = 'RUN_THREW' as const;

export type RunCondition = LifecycleOutcome | typeof RUN_THREW;

/**
 * Why a *repository* needs a person. A closed set, one member per genuinely
 * different thing to go and do.
 *
 * Deliberately five rather than one per condition. Twenty-one sentences that
 * differ only in the code they quote would be twenty-one chances for one of them
 * to name a command that does not exist; grouping by the operator's next action
 * keeps each sentence answerable. The exact condition is not lost — the record
 * carries it verbatim in its own field — so precision lives in the data and
 * advice lives in the table.
 */
export const RUN_ATTENTION_REASONS = [
  /**
   * The execution lease could not be settled: not taken, not recovered, changed
   * under the run, or not provably given back. Nothing ran, or nothing can be
   * said about what did.
   */
  'REPOSITORY_LEASE_UNRESOLVED',
  /**
   * A durable record could not be used, could not be written, or disagreed with
   * the repository. The machine must not guess which side is right.
   */
  'REPOSITORY_RECORD_UNUSABLE',
  /** A gate refused before any work happened. The input or the world is wrong. */
  'REPOSITORY_RUN_REFUSED',
  /** The run held everything it needed and still moved nothing. */
  'REPOSITORY_NO_PROGRESS',
  /** The driver threw. There is no ending to report, only the absence of one. */
  'REPOSITORY_RUN_THREW',
] as const;

export type RunAttentionReason = (typeof RUN_ATTENTION_REASONS)[number];

/**
 * What an operator has to do, one sentence per reason.
 *
 * `<path>` is a placeholder for the same reason the task table's placeholders
 * are: the record beside the sentence carries the real repository root, and a
 * sentence with it substituted in would be a different string per repository and
 * could not be pinned.
 */
export const RUN_ATTENTION_ACTIONS = Object.freeze({
  REPOSITORY_LEASE_UNRESOLVED:
    'This repository’s execution lease could not be settled, so no work can start there and ' +
    'a recurring invocation will skip it on every cycle. Read the lease with `agent-loop ' +
    'lease status --repository <path>`. A lease this build can prove dead is cleared by ' +
    '`agent-loop lease recover --repository <path>`; one it cannot prove dead is refusing on ' +
    'purpose, and the refusal names what it could not establish.',
  REPOSITORY_RECORD_UNUSABLE:
    'A durable record in this repository could not be used, could not be written, or ' +
    'disagreed with the repository itself. Nothing was repaired and nothing was overwritten. ' +
    'Read the task record and the worktree the condition names, decide which one is right, ' +
    'and repair it by hand.',
  REPOSITORY_RUN_REFUSED:
    'A gate refused before any work happened in this repository, so nothing was started and ' +
    'nothing is half-done. The condition names which gate it was. Fix the input or the ' +
    'world it complained about; a recurring invocation will keep meeting the same refusal ' +
    'until you do.',
  REPOSITORY_NO_PROGRESS:
    'A run in this repository held its lease and its budget and moved nothing. Repeating it ' +
    'unchanged will do the same. Read the task with `agent-loop run --repository <path> ' +
    '--task <id>` and decide whether the task, the plan or the agent is the thing that has ' +
    'to change.',
  REPOSITORY_RUN_THREW:
    'A run in this repository ended in an exception rather than in an outcome, so there is ' +
    'no ending recorded for it and this item is the only trace. The lease was still given ' +
    'back. Nothing here reconstructs what happened: re-run that repository attended and read ' +
    'the console, which is the only place the detail exists.',
}) satisfies Record<RunAttentionReason, string>;

/**
 * How one condition is judged.
 *
 * The same discriminated shape `core/task-attention.ts` uses, and for the same
 * reason: it removes "a condition with a disposition and no action" as a value
 * anybody can build.
 */
export type RunAttention =
  | { readonly attention: false; readonly reason: null; readonly action: null }
  | {
      readonly attention: true;
      readonly reason: RunAttentionReason;
      readonly action: string;
    };

const SILENT: RunAttention = Object.freeze({
  attention: false as const,
  reason: null,
  action: null,
});

type RunConditionRule =
  | { readonly kind: 'SILENT' }
  | { readonly kind: 'ALWAYS'; readonly reason: RunAttentionReason };

const silent: RunConditionRule = Object.freeze({ kind: 'SILENT' as const });
const always = (reason: RunAttentionReason): RunConditionRule =>
  Object.freeze({ kind: 'ALWAYS' as const, reason });

/**
 * Every condition, judged. Total by `satisfies`; correctness measured by suite.
 *
 * The `SILENT` rows are silent for exactly two reasons and the comment on each
 * says which, because "silent" is the answer that hides a defect if it is wrong:
 *
 *  - **already judged elsewhere** — the run left a durable task state, and
 *    `attentionForTaskState` judges that state. Saying it here as well would put
 *    two records in one operator's inbox for one condition;
 *  - **ordinary** — nothing is wrong and nobody is needed.
 */
const CONDITION_ATTENTION = Object.freeze({
  /* ── ordinary ─────────────────────────────────────────────────────────── */

  // Another owner holds the lease. This is the lease working, not failing: the
  // repository is skipped and the next cycle will find it free. A recurring
  // invocation that raised an item here would raise one every time two
  // repositories of one clone were enlisted.
  LIVE_OWNER_PRESENT: silent,
  // The intended end.
  COMPLETED: silent,
  // The operator's own bound, reached. The next cycle continues from here.
  INVOCATION_BUDGET_EXHAUSTED: silent,

  /* ── already judged by the task scan ──────────────────────────────────── */

  // `ABORTED`, which the state table calls silent because it is an end somebody
  // already chose.
  TASK_ABORTED: silent,
  BLOCKED_USAGE_LIMIT: silent,
  BLOCKED_VERIFY: silent,
  BLOCKED_AUTH: silent,
  SCOPE_VIOLATION: silent,
  RESUME_STATE_DIVERGED: silent,
  HUMAN_DECISION_REQUIRED: silent,

  /* ── the lease could not be settled ───────────────────────────────────── */

  STALE_LEASE_PRESENT: always('REPOSITORY_LEASE_UNRESOLVED'),
  RECOVERY_UNSAFE: always('REPOSITORY_LEASE_UNRESOLVED'),
  RECOVERY_FAILED: always('REPOSITORY_LEASE_UNRESOLVED'),
  LEASE_CHANGED: always('REPOSITORY_LEASE_UNRESOLVED'),
  LEASE_DISPLACED: always('REPOSITORY_LEASE_UNRESOLVED'),
  LEASE_ACQUISITION_REFUSED: always('REPOSITORY_LEASE_UNRESOLVED'),
  EXECUTION_LEASE_NOT_HELD: always('REPOSITORY_LEASE_UNRESOLVED'),
  EXECUTION_LEASE_LOST: always('REPOSITORY_LEASE_UNRESOLVED'),
  LEASE_RELEASE_FAILED: always('REPOSITORY_LEASE_UNRESOLVED'),

  /* ── a durable record could not be used ───────────────────────────────── */

  STATE_UNUSABLE: always('REPOSITORY_RECORD_UNUSABLE'),
  STATE_CONFLICT: always('REPOSITORY_RECORD_UNUSABLE'),
  STATE_NOT_RECORDED: always('REPOSITORY_RECORD_UNUSABLE'),
  RECONCILIATION_DIVERGED: always('REPOSITORY_RECORD_UNUSABLE'),
  RECONCILIATION_UNOBSERVABLE: always('REPOSITORY_RECORD_UNUSABLE'),

  /* ── a gate refused before any work ───────────────────────────────────── */

  TASK_START_REFUSED: always('REPOSITORY_RUN_REFUSED'),
  TASK_NOT_STARTED: always('REPOSITORY_RUN_REFUSED'),
  AUTH_PREFLIGHT_FAILED: always('REPOSITORY_RUN_REFUSED'),
  /**
   * A required MCP capability was not proven, so the repository was refused
   * before a task started (M5). It leaves no durable task state — nothing was
   * driven — so the task scan will never judge it, and by this table's own rule
   * that is exactly when a repository-subject item is raised.
   */
  REQUIRED_CAPABILITY_UNPROVEN: always('REPOSITORY_RUN_REFUSED'),
  CONTINUATION_NOT_AUTHORISED: always('REPOSITORY_RUN_REFUSED'),
  EXECUTION_UNAUTHORISED: always('REPOSITORY_RUN_REFUSED'),
  INVOCATION_BUDGET_INVALID: always('REPOSITORY_RUN_REFUSED'),

  /* ── everything was in place and nothing moved ────────────────────────── */

  NO_PROGRESS: always('REPOSITORY_NO_PROGRESS'),

  /* ── there is no ending at all ────────────────────────────────────────── */

  RUN_THREW: always('REPOSITORY_RUN_THREW'),
}) satisfies Record<RunCondition, RunConditionRule>;

/**
 * The condition vocabulary as this table sees it, exported for the suite that
 * proves the table is total *at runtime* and not only to the type checker.
 *
 * `satisfies Record<RunCondition, …>` is a compile-time claim about a literal.
 * It is worth having and it is not a measurement.
 */
export const RUN_ATTENTION_JUDGED_CONDITIONS: readonly RunCondition[] = Object.freeze(
  Object.keys(CONDITION_ATTENTION) as RunCondition[],
);

/** The rules, exported for the suite that measures them per member. */
export const RUN_CONDITION_ATTENTION_RULES = CONDITION_ATTENTION;

/** Whether this ending needs a person right now, and what they must do. */
export function attentionForRunCondition(condition: RunCondition): RunAttention {
  const rule = CONDITION_ATTENTION[condition];
  if (rule.kind === 'SILENT') return SILENT;
  return Object.freeze({
    attention: true as const,
    reason: rule.reason,
    action: RUN_ATTENTION_ACTIONS[rule.reason],
  });
}
