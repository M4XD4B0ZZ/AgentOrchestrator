/**
 * The exit-code contract of `agent-loop run`.
 *
 * One small closed set of codes, and two total mappings onto it: one for the
 * plan conclusions the command produces today, one for the run outcomes the
 * execution mode will produce when it exists. The second table is defined and
 * pinned now, deliberately: the vocabulary of `run-driver.ts` insists that
 * "the quota ran out", "a human must decide" and "another writer got there
 * first" send an operator to different places, and an exit-code scheme bolted
 * on later would be designed under pressure to collapse them. Fixing the
 * mapping while nothing depends on it is the cheap moment to fix it.
 *
 * ── The codes ──────────────────────────────────────────────────────────────
 *
 * | Code | Meaning |
 * | ---- | ------- |
 * | 0    | Nominal. The answer is actionable or the work is finished.       |
 * | 1    | Unexpected failure inside the tool. Global convention (AO-002).  |
 * | 2    | The input situation is unusable: repository, plan or named task. |
 * | 3    | The durable state needs an operator before anything may run.     |
 * | 4    | This invocation was refused or achieved nothing; the state may   |
 * |      | be fine. Re-invoking under other conditions can differ.          |
 * | 5    | Budget exhausted mid-drive: call again to continue.              |
 *
 * `NO_PROGRESS` remains one outcome for more than one situation (the V1-07
 * followup recorded as R-2/R-3); its exit code is uniformly 4, and the finer
 * distinction stays where it already lives — in `reasonCodes`. Splitting the
 * outcome itself is the execution slice's decision, not this table's.
 */

import type { BlockStopReason } from '../block/block-ledger.js';
import type { AttendedBlockResult, BlockRunOutcome } from '../block/block-runner.js';
import type { ReleaseOutcome } from '../run/release-workspace.js';
import type { LifecycleOutcome } from '../run/lifecycle-driver.js';
import type { RunOutcome } from '../run/run-driver.js';
import type { RunPlanConclusion } from '../run/run-plan.js';
import type { StartTaskOutcome } from '../run/start-task.js';

export const EXIT_RUN_OK = 0;
export const EXIT_RUN_UNEXPECTED = 1;
export const EXIT_RUN_INPUT_UNUSABLE = 2;
export const EXIT_RUN_NEEDS_OPERATOR = 3;
export const EXIT_RUN_REFUSED = 4;
export const EXIT_RUN_CALL_AGAIN = 5;

/**
 * The runtime is outside the V2 support contract, so no command ran.
 *
 * Housed here because this is where every exit code this binary can produce
 * lives, and a code allocated anywhere else is a code that eventually collides.
 *
 * **Deliberately not a member of {@link CliExitCode}.** That union is the
 * exit-code contract of `agent-loop run` — the codomain of three total mappings
 * from run outcomes — and this is not a run outcome. It is a refusal that
 * happens *before* any command begins, on a machine where no run is possible at
 * all. Folding it into the union would invite a future outcome to be mapped
 * onto it, which would tell an operator their task failed when in fact their
 * runtime was never supported.
 */
export const EXIT_RUNTIME_UNSUPPORTED = 6;

/**
 * The closed set of codes this command may exit with.
 *
 * Named as a type so the three tables below can be written with `satisfies`,
 * which is what makes each of them *total* at compile time: a new member of any
 * outcome vocabulary fails the build in this file rather than silently reaching
 * a `default` clause. There is no `default` clause anywhere here, deliberately —
 * an "unknown outcome → generic failure" arm is how a vocabulary grows a member
 * nobody classified.
 */
export type CliExitCode =
  | typeof EXIT_RUN_OK
  | typeof EXIT_RUN_UNEXPECTED
  | typeof EXIT_RUN_INPUT_UNUSABLE
  | typeof EXIT_RUN_NEEDS_OPERATOR
  | typeof EXIT_RUN_REFUSED
  | typeof EXIT_RUN_CALL_AGAIN;

/** Exit code for every plan conclusion. Total; pinned by test. */
const PLAN_EXIT_CODES = Object.freeze({
  // Nominal answers: the operator got exactly what they asked for.
  ALL_TASKS_COMPLETE: EXIT_RUN_OK,
  TASK_NOT_STARTED: EXIT_RUN_OK,
  TASK_COMPLETED: EXIT_RUN_OK,
  RECONCILED_IN_FLIGHT: EXIT_RUN_OK,
  // The input cannot be planned or the named task cannot run.
  PLANNING_FAILED: EXIT_RUN_INPUT_UNUSABLE,
  NO_ELIGIBLE_TASK: EXIT_RUN_INPUT_UNUSABLE,
  TASK_ID_INVALID: EXIT_RUN_INPUT_UNUSABLE,
  TASK_UNKNOWN: EXIT_RUN_INPUT_UNUSABLE,
  TASK_INELIGIBLE: EXIT_RUN_INPUT_UNUSABLE,
  // The durable state needs an operator.
  TASK_ABORTED: EXIT_RUN_NEEDS_OPERATOR,
  TASK_PARKED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  STATE_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNOBSERVABLE: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<RunPlanConclusion, CliExitCode>;

export function exitCodeForPlan(conclusion: RunPlanConclusion): CliExitCode {
  return PLAN_EXIT_CODES[conclusion];
}

/**
 * Exit code for every run outcome. Total; pinned by test. Not consumed by any
 * command yet — the execution mode arrives in a later slice — but part of the
 * `run` command's documented contract from the start.
 */
const RUN_EXIT_CODES = Object.freeze({
  TASK_COMPLETED: EXIT_RUN_OK,
  // Durably parked, or a record an operator has to look at.
  TASK_ABORTED: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_USAGE_LIMIT: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_VERIFY: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_AUTH: EXIT_RUN_NEEDS_OPERATOR,
  SCOPE_VIOLATION: EXIT_RUN_NEEDS_OPERATOR,
  RESUME_STATE_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  HUMAN_DECISION_REQUIRED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNOBSERVABLE: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  // Nothing to continue: no state has ever been persisted for this task.
  TASK_NOT_STARTED: EXIT_RUN_INPUT_UNUSABLE,
  // This invocation was refused or achieved nothing; nothing durable is wrong.
  STATE_CONFLICT: EXIT_RUN_REFUSED,
  STATE_NOT_RECORDED: EXIT_RUN_REFUSED,
  CONTINUATION_NOT_AUTHORISED: EXIT_RUN_REFUSED,
  EXECUTION_UNAUTHORISED: EXIT_RUN_REFUSED,
  // Both lease outcomes are refusals rather than operator conditions, and for
  // the reason code 4 names: nothing durable is wrong, and re-invoking under
  // other conditions — once the other writer has finished, once the lease is
  // held again — really can differ. They keep their two outcomes because they
  // send an operator to different places; they share an exit code because the
  // shell-level answer to both is the same.
  EXECUTION_LEASE_NOT_HELD: EXIT_RUN_REFUSED,
  EXECUTION_LEASE_LOST: EXIT_RUN_REFUSED,
  NO_PROGRESS: EXIT_RUN_REFUSED,
  // The only outcome that means "call again".
  STEP_BUDGET_EXHAUSTED: EXIT_RUN_CALL_AGAIN,
}) satisfies Record<RunOutcome, CliExitCode>;

export function exitCodeForRunOutcome(outcome: RunOutcome): CliExitCode {
  return RUN_EXIT_CODES[outcome];
}

/**
 * Exit code for every way a *start* can end. Total; pinned by test.
 *
 * ── Why these codes and not fourteen new ones ──────────────────────────────
 *
 * `START_TASK_OUTCOMES` has sixteen members, and inventing sixteen process
 * codes for them would make the command's exit surface a restatement of one
 * module's vocabulary. The codes above already say the six things a caller can
 * act on, so a start outcome is *classified* into them rather than given its
 * own. Where a start outcome shares a spelling with a plan conclusion —
 * `TASK_ID_INVALID`, `PLANNING_FAILED`, `TASK_UNKNOWN`, `TASK_INELIGIBLE`,
 * `STATE_UNUSABLE` — it deliberately gets the same code: the same fact learned
 * on the way to executing is still the same fact.
 *
 * ── The two judgements worth stating ───────────────────────────────────────
 *
 * `AUTH_PREFLIGHT_FAILED` is 3, not 4. Code 4 says "the state may be fine, and
 * re-invoking under other conditions can differ", which is true of a failed
 * login and still reads as *quiet*. An operator whose agents are not logged in
 * must go and do something before anything will ever run, which is what 3 means
 * — and `BLOCKED_AUTH` already lands there in the run table above. The gloss for
 * code 3 is therefore "an operator must act before anything may run"; durable
 * state is the most common reason, not the only one.
 *
 * `STATE_NOT_RECORDED` is 3 here and 4 in the run table, and the difference is
 * real rather than an inconsistency. Mid-drive it means one write was refused
 * and nothing is out of place. During a *start* it means the workspace was
 * created and then the first durable write was refused, so a worktree exists
 * that no state accounts for — `startTask` reports exactly that as
 * `residue: true`. An operator has to clean that up, so it is not a 4.
 */
const START_TASK_EXIT_CODES = Object.freeze({
  // Nominal: a task is ready to be driven. Neither is terminal for the
  // attended command, which continues into the run and exits on *its* outcome.
  STARTED: EXIT_RUN_OK,
  // Adoption is a nominal start: the task now has the same durable state a
  // fresh one would, so the invocation continues exactly as it would have.
  ADOPTED: EXIT_RUN_OK,
  ALREADY_STARTED: EXIT_RUN_OK,
  // The input situation is unusable: the id, the plan, or the named task.
  TASK_ID_INVALID: EXIT_RUN_INPUT_UNUSABLE,
  PLANNING_FAILED: EXIT_RUN_INPUT_UNUSABLE,
  TASK_UNKNOWN: EXIT_RUN_INPUT_UNUSABLE,
  TASK_INELIGIBLE: EXIT_RUN_INPUT_UNUSABLE,
  // The repository is not configured to hold task state. A defect in the
  // repository, fixed by editing it — so it is an unusable input, not a refusal.
  RUNTIME_NOT_IGNORED: EXIT_RUN_INPUT_UNUSABLE,
  // Git could not answer. Nothing is wrong with the input or the state, and the
  // next invocation may well succeed: the definition of code 4.
  RUNTIME_IGNORE_UNDETERMINED: EXIT_RUN_REFUSED,
  // Somebody else is the repository's writer, or this invocation never was.
  // Nothing was created, nothing is out of place, and the next invocation may
  // well succeed — so a refusal, not an operator condition.
  EXECUTION_LEASE_NOT_HELD: EXIT_RUN_REFUSED,
  // Lost once something exists that no durable state accounts for — a worktree
  // and a branch, or only the branch when the rollback had already removed the
  // worktree. Same reasoning as `STATE_NOT_RECORDED`
  // below, and deliberately the same code: an operator has to clean it up, so it
  // is not a 4. A review found this case sharing 4 with the refusal above —
  // identical residue, opposite advice, and a scheduler that would retry
  // straight into a `WORKSPACE_COLLISION`.
  EXECUTION_LEASE_LOST: EXIT_RUN_NEEDS_OPERATOR,
  // An operator must act before anything may run.
  AUTH_PREFLIGHT_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  WORKSPACE_COLLISION: EXIT_RUN_NEEDS_OPERATOR,
  WORKSPACE_REFUSED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  STATE_NOT_RECORDED: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<StartTaskOutcome, CliExitCode>;

export function exitCodeForStartOutcome(outcome: StartTaskOutcome): CliExitCode {
  return START_TASK_EXIT_CODES[outcome];
}

/**
 * What `release` exits with (V2-06A).
 *
 * `NOT_RELEASABLE` is `EXIT_RUN_NEEDS_OPERATOR` rather than a refusal code, and
 * that is the whole point of the command: the workspace could not be proven to
 * be an untouched crash artefact, so a human has to look at it. Reporting it as
 * a plain refusal would invite a script to retry, and there is nothing to retry.
 */
const RELEASE_EXIT_CODES = Object.freeze({
  RELEASED: EXIT_RUN_OK,
  // The worktree is gone and a branch is not. Nominal enough to exit 0 — the
  // thing occupying the path is released — but the report says what remains.
  RELEASED_BRANCH_KEPT: EXIT_RUN_OK,
  TASK_ID_INVALID: EXIT_RUN_INPUT_UNUSABLE,
  PLANNING_FAILED: EXIT_RUN_INPUT_UNUSABLE,
  TASK_UNKNOWN: EXIT_RUN_INPUT_UNUSABLE,
  NOT_RELEASABLE: EXIT_RUN_NEEDS_OPERATOR,
  // Files exist that no proof looked at. A human decides, never a retry.
  HOLDS_IGNORED_CONTENT: EXIT_RUN_NEEDS_OPERATOR,
  // Git could not answer. Nothing is wrong with the workspace and the next
  // invocation may well succeed: the definition of code 4.
  IGNORED_CONTENT_UNDETERMINED: EXIT_RUN_REFUSED,
  // Somebody else is the repository's writer. Nothing was removed, and the
  // release is worth attempting again once they are done.
  EXECUTION_LEASE_NOT_HELD: EXIT_RUN_REFUSED,
  // Lost partway: the worktree is gone and the branch is not. Identical on disk
  // to `RELEASED_BRANCH_KEPT` above and deliberately not identical here — that
  // one exits 0 and invites a hand-deletion, while this left a residue that will
  // refuse the next start. An operator has to look, so 3.
  EXECUTION_LEASE_LOST: EXIT_RUN_NEEDS_OPERATOR,
  REMOVE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<ReleaseOutcome, CliExitCode>;

export function exitCodeForReleaseOutcome(outcome: ReleaseOutcome): CliExitCode {
  return RELEASE_EXIT_CODES[outcome];
}

/**
 * What a block run exits with (V2-08).
 *
 * Two tables rather than one, because a block run ends in two different ways
 * and only one of them has a reason. `BLOCK_RUN_ENDED` is graded by the reason
 * the ledger carries; the other four outcomes are graded on their own, and both
 * tables are total by `satisfies`, so a new reason or a new outcome fails the
 * build here until somebody decides what an operator should do about it.
 *
 * Three judgements worth stating:
 *
 * `NO_ELIGIBLE_TASK` is 2, matching `PLAN_EXIT_CODES` above. The same fact
 * learned on the way to executing is still the same fact.
 *
 * `DURABLE_WRITE_FAILED` and `RECONCILIATION_UNRESOLVED` are 3 while the other
 * two unrecorded outcomes are 4. Code 4 says "nothing durable is wrong, and
 * re-invoking under other conditions can differ", which is true of a lease
 * somebody else holds and of a gate that was not satisfied. It is not true of a
 * disk or a permission that refused a write — an operator has to go and fix
 * something, and a scheduler told 4 would retry into the same refusal forever —
 * and it is not true of a reconciliation the authoritative primitive refused
 * either: task state moved under a held execution lease, which is a fact about
 * this repository that another invocation will meet again.
 *
 * `ACTIVE_TASK_UNRESOLVED` is 3 rather than 5. The run is over — a stop reason
 * is written once — so "call again" would be advice that cannot be taken.
 *
 * Nothing here exits 5 at all, and that is the lifetime decision showing
 * through: a block run does not outlive its invocation, so there is no state in
 * which calling again continues anything. `EXIT_RUN_CALL_AGAIN` stays what it
 * is — `run --attended`'s answer for one task — and `block` simply never
 * produces it.
 */
const BLOCK_STOP_EXIT_CODES = Object.freeze({
  COMPLETE: EXIT_RUN_OK,
  TASK_BLOCKED: EXIT_RUN_NEEDS_OPERATOR,
  TASK_ABANDONED: EXIT_RUN_NEEDS_OPERATOR,
  NO_ELIGIBLE_TASK: EXIT_RUN_INPUT_UNUSABLE,
  OPERATOR_STOPPED: EXIT_RUN_REFUSED,
  LEDGER_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  DEFINITION_DRIFTED: EXIT_RUN_NEEDS_OPERATOR,
  ACTIVE_TASK_UNRESOLVED: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<BlockStopReason, CliExitCode>;

const BLOCK_OUTCOME_EXIT_CODES = Object.freeze({
  LEASE_AUTHORITY_UNCERTAIN: EXIT_RUN_REFUSED,
  DURABLE_WRITE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  RUN_GATE_REFUSED: EXIT_RUN_REFUSED,
  RECONCILIATION_UNRESOLVED: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<Exclude<BlockRunOutcome, 'BLOCK_RUN_ENDED'>, CliExitCode>;

export function exitCodeForBlockRun(result: AttendedBlockResult): CliExitCode {
  if (result.outcome !== 'BLOCK_RUN_ENDED') return BLOCK_OUTCOME_EXIT_CODES[result.outcome];
  // `BLOCK_RUN_ENDED` carries a reason by construction — `RunState.stop` is the
  // only producer and it always names one. A missing reason would be this
  // module's own defect rather than a run outcome, so it exits 1.
  return result.stopReason === null ? EXIT_RUN_UNEXPECTED : BLOCK_STOP_EXIT_CODES[result.stopReason];
}

/*
 * There is deliberately no `lease break` table here any more.
 *
 * It mapped five break outcomes onto exit codes, and it was the last place in
 * this file that named the recovery vocabulary. The break was withdrawn — see
 * `lease/lease-recovery.ts` for why the authorisation contract could not be
 * written — so the outcomes it graded no longer exist. `lease status` exits 0
 * whatever it finds, because a held lease is a condition and not an error.
 */

/**
 * Exit code for every lifecycle outcome. Total; pinned by test.
 *
 * The lifecycle driver's vocabulary is mostly the run driver's passed through,
 * and where a member appears in both tables it is given the same code here — a
 * task that ended `BLOCKED_VERIFY` did not end differently because an outer
 * loop was watching. What is new is the lease phase, which happens *before* any
 * run, and the two stops the outer loop owns.
 */
const LIFECYCLE_EXIT_CODES = Object.freeze({
  // The task finished.
  COMPLETED: EXIT_RUN_OK,

  // Durably parked, or a record an operator has to look at. Same codes as the
  // run table, deliberately.
  TASK_ABORTED: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_USAGE_LIMIT: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_VERIFY: EXIT_RUN_NEEDS_OPERATOR,
  BLOCKED_AUTH: EXIT_RUN_NEEDS_OPERATOR,
  SCOPE_VIOLATION: EXIT_RUN_NEEDS_OPERATOR,
  RESUME_STATE_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  HUMAN_DECISION_REQUIRED: EXIT_RUN_NEEDS_OPERATOR,
  RECONCILIATION_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  RECONCILIATION_UNOBSERVABLE: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,

  // The lease could not be taken, or could not be given back. Every one of
  // these is an operator condition rather than a refusal, and the split from
  // code 4 is the point: `LIVE_OWNER_PRESENT` is somebody else working and
  // clears itself, while a failed recovery, a displaced lease and an unproven
  // release each leave something in `.git` that only a human resolves.
  LIVE_OWNER_PRESENT: EXIT_RUN_REFUSED,
  STALE_LEASE_PRESENT: EXIT_RUN_NEEDS_OPERATOR,
  RECOVERY_UNSAFE: EXIT_RUN_NEEDS_OPERATOR,
  LEASE_CHANGED: EXIT_RUN_NEEDS_OPERATOR,
  LEASE_DISPLACED: EXIT_RUN_NEEDS_OPERATOR,
  RECOVERY_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  LEASE_ACQUISITION_REFUSED: EXIT_RUN_NEEDS_OPERATOR,
  LEASE_RELEASE_FAILED: EXIT_RUN_NEEDS_OPERATOR,

  // Nothing to continue.
  TASK_NOT_STARTED: EXIT_RUN_INPUT_UNUSABLE,
  // A floor, and normally unreachable: `exitCodeForLifecycleRun` delegates a
  // refused start to `START_TASK_EXIT_CODES`, because those refusals are not one
  // condition. `TASK_ID_INVALID` is a typo, `AUTH_PREFLIGHT_FAILED` is a login,
  // and `STATE_NOT_RECORDED` is a worktree nothing accounts for; answering all
  // three with "your input was unusable" is the collapse this vocabulary exists
  // to prevent. Reached only if a result carried the outcome without the start.
  TASK_START_REFUSED: EXIT_RUN_INPUT_UNUSABLE,

  // A human must log the agent CLIs in. Code 3 rather than 4, and taken from
  // `START_TASK_EXIT_CODES` rather than chosen again here: this is the same
  // condition `run --attended` has always reported, and an operator's answer to
  // it did not change because an outer loop asked the question.
  AUTH_PREFLIGHT_FAILED: EXIT_RUN_NEEDS_OPERATOR,

  // This run was refused or achieved nothing; nothing durable is wrong.
  STATE_CONFLICT: EXIT_RUN_REFUSED,
  STATE_NOT_RECORDED: EXIT_RUN_REFUSED,
  CONTINUATION_NOT_AUTHORISED: EXIT_RUN_REFUSED,
  EXECUTION_UNAUTHORISED: EXIT_RUN_REFUSED,
  EXECUTION_LEASE_NOT_HELD: EXIT_RUN_REFUSED,
  EXECUTION_LEASE_LOST: EXIT_RUN_REFUSED,
  NO_PROGRESS: EXIT_RUN_REFUSED,

  // Progress was still being made and this run's budget ran out. The lifecycle
  // spelling of "call again", and the only member that carries code 5.
  INVOCATION_BUDGET_EXHAUSTED: EXIT_RUN_CALL_AGAIN,
}) satisfies Record<LifecycleOutcome, CliExitCode>;

export function exitCodeForLifecycle(outcome: LifecycleOutcome): CliExitCode {
  return LIFECYCLE_EXIT_CODES[outcome];
}

/**
 * Exit code for a whole lifecycle result.
 *
 * The one place a lifecycle outcome is *not* enough on its own. A run stopped by
 * `startTask` keeps that half's exit code, taken from the table that already
 * owns it, so wrapping the attended path in an outer loop did not quietly
 * relabel a failed login as bad input. Everything else is the outcome's own
 * code.
 */
export function exitCodeForLifecycleRun(result: {
  readonly outcome: LifecycleOutcome;
  readonly start: { readonly outcome: StartTaskOutcome } | null;
}): CliExitCode {
  if (result.outcome === 'TASK_START_REFUSED' && result.start !== null) {
    return exitCodeForStartOutcome(result.start.outcome);
  }
  return LIFECYCLE_EXIT_CODES[result.outcome];
}
