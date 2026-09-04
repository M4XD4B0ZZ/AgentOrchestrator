/**
 * Whether one durable task record needs a human, and what that human must do
 * (M3-02).
 *
 * ── The rule, stated once ──────────────────────────────────────────────────
 *
 *     attention(task)  ⟹  no machine can make this task progress
 *                          AND there is something a person can go and do
 *
 * An implication and **not** a biconditional, and the direction is the design.
 * Everything raised here genuinely needs a person; not everything that needs one
 * is raised, and the gap is named below rather than left for a reader to
 * discover.
 *
 * Not "something happened". A run that can keep going on its own — a quota block
 * with a reset the scheduler will wake for, a task mid-implementation, a task
 * waiting behind a dependency — is silent here, and that is the whole point of
 * having this module rather than notifying on endings. `notify/attention.ts`
 * grades *block runs*; this grades *durable task state*, and the two are
 * deliberately separate vocabularies over separate subjects.
 *
 * ── Why it reads the record and nothing else ───────────────────────────────
 *
 * Pure: a `TaskState` and an instant in, a judgement out. No filesystem, no Git,
 * no clock read, no lease.
 *
 * That is a design constraint rather than an economy, and it is what makes the
 * crash window in `notify/attention-outbox.ts` closeable. A notification derived
 * from something a *pass* observed could be lost with the process that observed
 * it — nobody could ever re-derive it, because the observation is gone. A
 * judgement that is a function of a durable document can be re-derived by any
 * later process from the same document, so a process that dies between reaching
 * a state and recording the notification costs nothing but a delay.
 *
 * The price is stated rather than hidden, and it is what makes the rule above an
 * implication.
 *
 * First, this module cannot see conditions that are not in a task record at all.
 * A repository whose profile stopped parsing, a lease whose owner cannot be
 * proven dead, an auth preflight that failed — those halt a pass and are
 * reported by the pass, and none of them is a task state. They are out of this
 * module's subject rather than overlooked by it.
 *
 * Second, and sharper, it cannot see a task the **world** refuses. A quota block
 * whose reset has passed over an intact record reads `MACHINE_MAY_STILL_RESUME`
 * and is silent, because as far as the document is concerned the automatic path
 * owns it. If the repository is what keeps denying — a worktree somebody dirtied,
 * a commit that moved, a login that stopped working — nobody is told by this
 * module, and the wake scan stops offering the instant once it is behind, so the
 * task sits. What an operator sees instead is the pass report, which names the
 * task and the refusing checks every time it is admitted. Closing it properly
 * means an attention judgement that can consult Git and an auth preflight, which
 * is a different and much larger thing than a pure function of a record;
 * `README.md` carries it as a residual rather than this comment pretending it is
 * covered.
 *
 * ── One table, total, and judged by hand ───────────────────────────────────
 *
 * Every member of the state vocabulary appears below with a rule, proven by
 * `satisfies`. What `satisfies` proves is that each state was *considered* and
 * nothing at all about whether any was judged correctly — the point
 * `notify/attention.ts` makes about its own table — so correctness is measured
 * separately: each action sentence carries a token that appears in no other, and
 * the suite asserts both directions.
 *
 * ── The two rules that took an argument ────────────────────────────────────
 *
 * `READY_FOR_PR` is **silent**, and this is the one judgement here a reasonable
 * person would make the other way. It is the intended successful end of a task,
 * it has a real operator action (`agent-loop delivery`), and an earlier design
 * note asked for one closing message on it. It is silent anyway, for a reason
 * that is about this store rather than about the state: `READY_FOR_PR` is
 * terminal, so an attention item raised on it could never be resolved by the
 * task moving, and the outbox settles by removal. Every finished task would
 * accumulate an open item for ever, and an inbox that only grows is one nobody
 * reads. Making that work needs an acknowledgement the operator gives back,
 * which is a second mechanism and is not in this slice. `notify/attention.ts`
 * already grades the corresponding block-run ending `COMPLETE: silent`, so this
 * agrees with the build rather than contradicting it.
 *
 * `BLOCKED_AUTH`, `SCOPE_VIOLATION` and `RESUME_STATE_DIVERGED` **do** get
 * attention even though no flag in this build continues any of them. Their
 * action sentences say so in as many words, and that is the honest answer rather
 * than a weaker one: an unattended orchestrator that met a scope violation and
 * said nothing is the failure this whole capability exists to prevent, and
 * "there is no command; look at this, then abandon or repair it by hand" is a
 * specific instruction. A notification whose action were merely "something is
 * wrong" would be the thing to refuse.
 *
 * `BLOCKED_AUTH`'s sentence was measured rather than assumed, and the first
 * draft of it was wrong. It said "log the agent in, then re-run", which is what
 * `cli/render-lifecycle.ts` implies and what the transition table appears to
 * promise — `BLOCKED_AUTH → AUTH_PREFLIGHT` is declared, and
 * `resume-policy.ts` gives the state `resumeReentry: 'VIA_AUTH_PREFLIGHT'`.
 * Nothing in `src/` ever *writes* `AUTH_PREFLIGHT`: the only resume writer
 * targets a work-loop phase, and the three operator conjuncts are pinned by
 * their first terms to other states. So the edge is declared and has no
 * executor, exactly as `BLOCKED_USAGE_LIMIT`'s was until M2 slice 6, and a
 * notification telling an operator to re-run would have named a command that
 * changes nothing. Closing that is a second decision and is not this slice's;
 * saying it plainly is.
 */

import { ALL_STATES, type TaskStateName } from './states.js';
import type { TaskState } from './task-state.js';
import {
  usageLimitContinuation,
  type UsageLimitContinuationReading,
} from './usage-limit-continuation.js';

/**
 * Why a task needs a person. A closed set, one member per genuinely different
 * thing to go and do.
 */
export const ATTENTION_REASONS = [
  /** An agent's subscription login is gone. Only a human restores one. */
  'AGENT_LOGIN_REQUIRED',
  /**
   * A quota block the machine cannot wait out — no reset instant, or a reset
   * that has passed over a withdrawn resume record.
   */
  'QUOTA_CONTINUATION_REQUIRED',
  /** Verification failed and the only continuation is remediation, on a decision. */
  'VERIFICATION_REMEDIATION_REQUIRED',
  /** An agent wrote outside its declared scope. Nothing continues it. */
  'SCOPE_REVIEW_REQUIRED',
  /** The record and the repository disagreed. Nothing continues it. */
  'DIVERGENCE_REVIEW_REQUIRED',
  /** The loop escalated, or found an escalation already waiting. */
  'ESCALATED_DECISION_REQUIRED',
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/**
 * The judgement for one record.
 *
 * Discriminated, so a silent record carries no action and an attention record
 * cannot exist without one — the same construction `notify/attention.ts` uses,
 * and for the same reason: it removes "a state with a disposition and no action"
 * as a value anybody can build.
 *
 * `detail` is a closed code that qualifies the reason, or `null`. It exists for
 * the quota case, where three different readings send an operator to the same
 * command with different expectations, and it is deliberately not free text.
 */
export type TaskAttention =
  | { readonly attention: false; readonly reason: null; readonly action: null; readonly detail: null }
  | {
      readonly attention: true;
      readonly reason: AttentionReason;
      readonly action: string;
      readonly detail: UsageLimitContinuationReading | null;
    };

const SILENT: TaskAttention = Object.freeze({
  attention: false as const,
  reason: null,
  action: null,
  detail: null,
});

/**
 * What an operator has to do, one sentence per reason.
 *
 * Every sentence names either an exact command or, where this build offers none,
 * says that it offers none and what the decision is instead. `<path>` and `<id>`
 * are placeholders on purpose: the record beside the sentence carries the real
 * repository root and task id, and a sentence with them substituted in would be
 * a different string per task and could not be pinned.
 */
export const ATTENTION_ACTIONS = Object.freeze({
  AGENT_LOGIN_REQUIRED:
    'An agent’s credentials are missing, expired or of a rejected kind, and only a person ' +
    'can restore a subscription login. Restoring it is necessary and is not sufficient: no ' +
    'flag in this build continues a task out of this state, so once the login works the ' +
    'task still has to be abandoned and re-planned, or its record repaired by hand.',
  QUOTA_CONTINUATION_REQUIRED:
    'A subscription quota block this build cannot wait out: the record names no reset ' +
    'instant, or the reset has passed and the resume record was withdrawn. Nothing clears ' +
    'it on its own. Decide whether to try again with `agent-loop run --repository <path> ' +
    '--task <id> --attended --continue-usage-limit`, which buys exactly one departure and ' +
    'asserts nothing about the allowance.',
  VERIFICATION_REMEDIATION_REQUIRED:
    'The repository’s verification commands failed and were not retried, because re-running ' +
    'them unchanged would fail again. Hand the recorded failure to the writing agent with ' +
    '`agent-loop run --repository <path> --task <id> --attended --remediate-verify-failure`, ' +
    'or end the task yourself with `agent-loop resolve --repository <path> --task <id> ' +
    '--attended`.',
  SCOPE_REVIEW_REQUIRED:
    'An agent wrote outside the scope this repository declares. No flag in this build ' +
    'continues a scope violation, so the decision is yours: read the worktree the record ' +
    'names, then either repair it by hand or abandon the task.',
  DIVERGENCE_REVIEW_REQUIRED:
    'The durable record and the repository disagreed about where this task stood, and ' +
    'guessing which is right is what this build must not do. No flag continues it: compare ' +
    'the record against the worktree by hand and decide.',
  ESCALATED_DECISION_REQUIRED:
    'The loop ran out of ways to proceed on its own and escalated. A review budget that ran ' +
    'out arrives here, and continuing does not refill it. Read what was recorded with ' +
    '`agent-loop run --repository <path> --task <id>`, then continue with `--attended ' +
    '--continue-human-decision`, or — if you have finished or dropped this task yourself — ' +
    'end it with `agent-loop resolve --repository <path> --task <id> --attended`, which ' +
    'records your decision and asserts nothing about the work.',
}) satisfies Record<AttentionReason, string>;

/**
 * How one state is judged.
 *
 * `BY_QUOTA_READING` is its own kind rather than a hard-coded reason because
 * `BLOCKED_USAGE_LIMIT` is the one state whose answer depends on the *record*
 * and the clock: the same state name is the machine's while a reset is ahead and
 * the operator's once the record can no longer be resumed from. Folding that
 * into a constant would be this table holding a second, weaker opinion about a
 * question `core/usage-limit-continuation.ts` already answers.
 */
type StateAttentionRule =
  | { readonly kind: 'SILENT' }
  | { readonly kind: 'ALWAYS'; readonly reason: AttentionReason }
  | { readonly kind: 'BY_QUOTA_READING' };

const silent: StateAttentionRule = Object.freeze({ kind: 'SILENT' as const });
const always = (reason: AttentionReason): StateAttentionRule =>
  Object.freeze({ kind: 'ALWAYS' as const, reason });

/**
 * Every state, judged. Total by `satisfies`; correctness measured by the suite.
 *
 * The twelve regular states are silent because a task standing in one of them is
 * either in flight or finished, and in both cases the machine's. `ABORTED` is
 * silent because it is an end somebody already chose.
 */
const STATE_ATTENTION = Object.freeze({
  CREATED: silent,
  REPOSITORY_RESOLVED: silent,
  CONFIG_VALIDATED: silent,
  AUTH_PREFLIGHT: silent,
  GIT_PREFLIGHT: silent,
  WORKTREE_READY: silent,
  CONTEXT_LOADING: silent,
  IMPLEMENTING: silent,
  VERIFYING: silent,
  REVIEWING: silent,
  REMEDIATING: silent,
  // Terminal and successful. See the header for why this is not a closing push.
  READY_FOR_PR: silent,
  // Terminal and deliberate. Telling somebody about a decision they made is noise.
  ABORTED: silent,
  // Terminal, and closed by the very person the item was addressed to. Raising
  // one here would tell an operator about their own decision — and it is this
  // rule, not the command that writes the state, that makes the open item stop
  // being derived: `attentionForTaskState` reads the record and nothing else.
  OPERATOR_RESOLVED: silent,
  BLOCKED_AUTH: always('AGENT_LOGIN_REQUIRED'),
  BLOCKED_USAGE_LIMIT: Object.freeze({ kind: 'BY_QUOTA_READING' as const }),
  BLOCKED_VERIFY: always('VERIFICATION_REMEDIATION_REQUIRED'),
  SCOPE_VIOLATION: always('SCOPE_REVIEW_REQUIRED'),
  RESUME_STATE_DIVERGED: always('DIVERGENCE_REVIEW_REQUIRED'),
  HUMAN_DECISION_REQUIRED: always('ESCALATED_DECISION_REQUIRED'),
}) satisfies Record<TaskStateName, StateAttentionRule>;

/**
 * The state vocabulary as this table sees it, exported for the suite that proves
 * the table is total *at runtime* and not only to the type checker.
 *
 * `satisfies Record<TaskStateName, …>` is a compile-time claim about a literal.
 * It is worth having and it is not a measurement: this is what lets a test
 * enumerate `ALL_STATES` and assert a rule exists for every one of them.
 */
export const ATTENTION_JUDGED_STATES: readonly TaskStateName[] = ALL_STATES;

/** The rules, exported for the suite that measures them per member and pairwise. */
export const STATE_ATTENTION_RULES = STATE_ATTENTION;

/**
 * Whether this record needs a person right now, and what they must do.
 *
 * `now` is supplied rather than read, so a scan classifying fifty records
 * against one instant cannot give two of them contradictory answers about
 * whether the same reset has passed.
 */
export function attentionForTaskState(state: TaskState, now: string | Date): TaskAttention {
  const rule = STATE_ATTENTION[state.state];

  if (rule.kind === 'SILENT') return SILENT;

  if (rule.kind === 'ALWAYS') {
    return Object.freeze({
      attention: true as const,
      reason: rule.reason,
      action: ATTENTION_ACTIONS[rule.reason],
      detail: null,
    });
  }

  // `BY_QUOTA_READING`. The permission and the notification are the same
  // question asked once: a block an operator may continue is exactly a block
  // that needs one, and a block the machine still owns needs nobody. Deriving
  // both from `usageLimitContinuation` is what keeps them from drifting apart
  // into a notification naming a command that would refuse.
  const reading = usageLimitContinuation(state, now);
  if (!reading.permitted) return SILENT;

  return Object.freeze({
    attention: true as const,
    reason: 'QUOTA_CONTINUATION_REQUIRED' as const,
    action: ATTENTION_ACTIONS.QUOTA_CONTINUATION_REQUIRED,
    detail: reading.reading,
  });
}
