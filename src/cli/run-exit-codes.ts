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
 * | 5    | Nothing is wrong and this invocation is over; calling again      |
 * |      | continues. Two shapes produce it: a step budget exhausted        |
 * |      | mid-run, and a delivery whose next move is another invocation.   |
 *
 * `NO_PROGRESS` remains one outcome for more than one situation (the V1-07
 * followup recorded as R-2/R-3); its exit code is uniformly 4, and the finer
 * distinction stays where it already lives — in `reasonCodes`. Splitting the
 * outcome itself is the execution slice's decision, not this table's.
 */

import type { BlockStopReason } from '../block/block-ledger.js';
import type { DeliveryConclusionRecordCode } from '../deliver/delivery-conclusion-store.js';
import type { MergeReconciliationRecordCode } from '../deliver/merge-reconciliation-store.js';
import type { HeadPublicationOutcomeCode } from '../deliver/head-publication-outcome-store.js';
import type { DeliveryTaskSelection } from '../deliver/select-delivery-task.js';
import type { DeliveryDrive } from './delivery-driver.js';
import type { AttendedBlockResult, BlockRunOutcome } from '../block/block-runner.js';
import type { ReleaseOutcome } from '../run/release-workspace.js';
import type { LeaseReleaseResult } from '../lease/execution-lease.js';
import type { LifecycleOutcome } from '../run/lifecycle-driver.js';
import type { RunOutcome } from '../run/run-driver.js';
import type { CrossRepositoryPlanCode } from '../plan/plan-across-repositories.js';
import type { CrossRepositoryRunOutcome } from '../run/repository-coordinator.js';
import type {
  RegistryResolutionRefusal,
  RepositoryRegistryRefusal,
} from '../registry/repository-registry.js';
import type { RunPlanConclusion } from '../run/run-plan.js';
import type { StartTaskOutcome } from '../run/start-task.js';
import type { UnattendedResumeResult } from '../run/unattended-resume.js';

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
 * which calling again continues anything. `block` simply never produces it.
 *
 * `EXIT_RUN_CALL_AGAIN` was `run --attended`'s answer for one task and nothing
 * else until V4 slice 11, which gave `delivery --drive` two members that mean
 * the same thing about a delivery rather than about a step budget — an act was
 * attempted and the next invocation reads what happened, or a check is still
 * running. The gloss in this file's header was widened with them; a review
 * measured it still saying "budget" for a code two other shapes now produce.
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

  // The lease phase, split across two codes, and the split is the point.
  // `LIVE_OWNER_PRESENT` is somebody else working: a refusal, code 4, and it
  // clears itself. Every other lease condition is an operator condition, code 3,
  // because a failed recovery, a displaced lease and an unproven release each
  // leave something in `.git` that only a human resolves. (This comment read
  // "every one of these is an operator condition rather than a refusal" directly
  // above the one member that is a refusal.)
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

  // The bound itself was unusable, so nothing was taken and nothing ran. Code 2
  // rather than 5: re-invoking with the same argument repeats forever, which is
  // the opposite of what "call again" tells a scheduler.
  INVOCATION_BUDGET_INVALID: EXIT_RUN_INPUT_UNUSABLE,
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

/**
 * Exit code for a whole unattended automatic-resume run (V3-08).
 *
 * **No new codes, and deliberately none.** Every ending this mode can reach is
 * an ending the lifecycle already had — a quota block is still `3`, another
 * writer is still `4`, an unusable bound is still `2` — and the wait adds no
 * shell-level instruction of its own. A run that waited and then completed did
 * not complete differently for having waited.
 *
 * The code comes from the **last epoch that ran**, because that is the attempt
 * whose result the operator is being told about: a run that slept and then met a
 * live owner exits on the live owner, not on the quota block it slept for. When
 * no epoch ran at all — an unusable wait bound, a budget too small to cover a
 * wait — there is no epoch to ask, and the controller's own outcome answers.
 */
export function exitCodeForUnattendedResume(result: UnattendedResumeResult): CliExitCode {
  const last = result.epochs.at(-1);
  return last === undefined ? LIFECYCLE_EXIT_CODES[result.outcome] : exitCodeForLifecycleRun(last);
}

/**
 * The exit code a command may keep once it has tried to give the lease back.
 *
 * The precedence rule, and it is a rule about *authority*, not about severity:
 * an invocation that took this repository's only writer slot and cannot prove it
 * gave the slot back has left something behind, and it may not exit nominal
 * however well its own work went. `RELEASED` is the only proof there is - not an
 * absent lease file, not a successful primary operation, not the command having
 * reached its `finally`, and not another process apparently owning the
 * repository. `null` means the release was attempted and produced nothing to
 * read, which proves the same amount as a failure: nothing.
 *
 * The primary result is **not** rewritten. This function decides one number, and
 * every caller prints the primary outcome and the release code as two separate
 * facts beside it, because "the block completed and the lease is stuck" and "the
 * block failed" are two different things to be told.
 *
 * **No primary code is exempt**, including `EXIT_RUN_UNEXPECTED`. An earlier
 * version of this function let a primary 1 through on the argument that an
 * unexpected failure is the more serious fact - which is true of a *thrown*
 * operation, and a thrown operation never reaches this function: both commands'
 * `catch` blocks set code 1 directly, and say so where they set it. The only
 * caller that can hand this function a 1 is `exitCodeForBlockRun`, for a block
 * that ended without a stop reason - a defect floor in that module. In that
 * state the block really ran, the lease really is stuck, and answering 1
 * ("something is wrong inside the tool") instead of 3 ("go and look at `lease
 * status`") is precisely the substitution this slice exists to prevent, on the
 * one code the exemption covered.
 */
export function exitCodeWithLeaseRelease(
  primary: CliExitCode,
  release: LeaseReleaseResult | null,
): CliExitCode {
  return release !== null && release.code === 'RELEASED' ? primary : EXIT_RUN_NEEDS_OPERATOR;
}

/**
 * The exit code a run that **concluded a delivery** may keep, given what the
 * conclusion store did with it.
 *
 * `delivery`'s exit code otherwise answers one question — was the observation
 * settled — and `--record`, `--reconcile-merge` and `--verify-merge` all report
 * their store code in the report and leave `$?` alone. Every *refusal* of the
 * conclusion ladder keeps that convention, because a refusal is an **answer**.
 *
 * This is the one departure, and it is narrow: the ladder decided the delivery
 * was concluded and the claim is not on disk afterwards. That run has told a
 * caller yes about something that did not happen, and `--conclude-delivery` is
 * the one flag whose whole purpose is to answer "is this delivery concluded?".
 *
 * The two codes the conclusion is durable under return `null`, meaning "keep
 * the primary": `ALREADY_CONCLUDED` filed nothing and the claim is on disk all
 * the same, which is why this is graded on durability rather than on `recorded`.
 *
 * The rest are graded **one by one**, against this file's own definitions,
 * rather than collapsed onto one number. A review measured the first version
 * doing exactly that and named two codes it mis-classified: an honest
 * concurrent `--verify-merge` that moves the history is `EVIDENCE_MOVED`, where
 * the next invocation may well succeed — the definition of code 4. The
 * identical condition is already graded in this file: `START_TASK_EXIT_CODES`
 * gives `RUNTIME_IGNORE_UNDETERMINED` a 4 and `RUNTIME_NOT_IGNORED` a 2, three
 * lines apart, with the comment "Git could not answer … the next invocation may
 * well succeed: the definition of code 4". (An earlier version of this
 * paragraph said "twelve lines above", which a review measured as pointing at
 * this table's own entry rather than at that one.)
 * "Does not exit nominal" does not require "needs an operator".
 */
const CONCLUSION_RECORD_EXIT_CODES = Object.freeze({
  // On disk. Nothing to override — the primary answers.
  CONCLUSION_RECORDED: null,
  ALREADY_CONCLUDED: null,

  // Nothing is wrong and the next invocation may well succeed.
  EVIDENCE_MOVED: EXIT_RUN_REFUSED,
  RUNTIME_IGNORE_UNDETERMINED: EXIT_RUN_REFUSED,

  // The input situation is unusable and is fixed by editing the repository.
  RUNTIME_PATH_NOT_IGNORED: EXIT_RUN_INPUT_UNUSABLE,
  LOCATION_UNSUITABLE: EXIT_RUN_INPUT_UNUSABLE,
  RECORD_TOO_LARGE: EXIT_RUN_INPUT_UNUSABLE,

  // Durable state an operator has to look at before anything else happens: a
  // second contradictory answer, a document this build cannot read, a receipt
  // this build would not accept its own record from, or a write that got far
  // enough to leave a directory and a staging file behind.
  CONFLICTING_CONCLUSION: EXIT_RUN_NEEDS_OPERATOR,
  EXISTING_CONCLUSION_UNREADABLE: EXIT_RUN_NEEDS_OPERATOR,
  RECORD_CONTRACT_VIOLATION: EXIT_RUN_NEEDS_OPERATOR,
  DIRECTORY_CREATE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  WRITE_FAILED: EXIT_RUN_NEEDS_OPERATOR,

  // Something is wrong inside the tool. Both are floors: the command builds the
  // proof and the expectations from one reading of one receipt, so neither can
  // be reached by an operator doing anything at all.
  CONCLUSION_NOT_PROVEN: EXIT_RUN_UNEXPECTED,
  SUBJECT_MISMATCH: EXIT_RUN_UNEXPECTED,
}) satisfies Record<DeliveryConclusionRecordCode, CliExitCode | null>;

/**
 * The override for one conclusion record code, or `null` to keep the primary.
 *
 * Total by type over {@link DeliveryConclusionRecordCode}, so a new store code
 * fails the build here until somebody grades it — the discipline
 * `block/block-conclusion.ts` states for its own maps. The grades themselves
 * are pinned by a hand-written table in the slice's test file, which is
 * deliberately not derived from this one.
 */
export function exitCodeForConclusionRecord(
  code: DeliveryConclusionRecordCode,
): CliExitCode | null {
  return CONCLUSION_RECORD_EXIT_CODES[code];
}

/**
 * Exit code for every driver outcome. Total; pinned by test.
 *
 * ── What this table does and does not make `$?` mean ───────────────────────
 *
 * Without `--drive`, `delivery`'s exit code answers one question — was the
 * observation settled — and five residuals (`L-V4-05-8`, `L-V4-06-8`,
 * `L-V4-08-8`, `L-V4-09-8`, `L-V4-10-9`) each record, from a different angle,
 * that no act's verdict reaches `$?`. **That is unchanged.** This table is
 * consulted only on an invocation that asked for the driver, and it grades the
 * driver's own member.
 *
 * What it deliberately does **not** encode is "the merge is warranted".
 * `ATTENDED_AUTHORITY_REQUIRED` says an act has not been authorised, not that it
 * should be; which act is in the report, and whether it ought to happen is a
 * person's judgement that no code in this file makes. The positive member is
 * about a delivery that is already **finished**, which is a fact about the past.
 *
 * `EXIT_RUN_CALL_AGAIN` appears exactly twice, and both times the instruction is
 * literal: an act was attempted and the next invocation has to read what
 * happened, or a check is still running. **Nothing in this build calls again by
 * itself.** `run-driver.ts`'s loop is over `runTask`, and no path from it
 * reaches this command.
 */
const DRIVE_EXIT_CODES = Object.freeze({
  // Nominal: the lifecycle is over and its evidence is on disk.
  DELIVERY_CONCLUDED: EXIT_RUN_OK,

  // The invocation cannot be carried out as written, and editing it fixes that.
  SUBJECT_NOT_ESTABLISHED: EXIT_RUN_INPUT_UNUSABLE,
  TASK_NOT_READY: EXIT_RUN_INPUT_UNUSABLE,
  DRIVE_NOT_COMBINABLE: EXIT_RUN_INPUT_UNUSABLE,

  // A person has to look before anything else happens: a record that cannot be
  // read, a verdict that says the code failed, a machine that could not answer,
  // a commit nothing has succeeded on, or a state somebody put this delivery in.
  //
  // "An act nobody authorised" used to be on that list and is not: a review
  // moved `ATTENDED_AUTHORITY_REQUIRED` to 4, where this file grades every
  // sibling authority refusal, and the clause went with it.
  DELIVERY_EVIDENCE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  CONCLUSION_NOT_ATTESTED: EXIT_RUN_NEEDS_OPERATOR,
  VERIFICATION_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  // Graded 3 rather than 4 on purpose, and the trade-off is stated rather than
  // absorbed. Two of its causes clear on their own — a lease another run holds,
  // a workspace that could not be made — and 4 would be right for those. The
  // third does not: `MERGE_COMMIT_UNAVAILABLE` is terminal, because this build
  // will not fetch a merge commit it does not have (`L-V4-09-3`). One code
  // cannot say both, and telling an operator "try again" about a condition that
  // never clears is the worse of the two errors.
  VERIFICATION_NOT_ESTABLISHED: EXIT_RUN_NEEDS_OPERATOR,
  PULL_REQUEST_AMBIGUOUS: EXIT_RUN_NEEDS_OPERATOR,
  CHECKS_ABSENT: EXIT_RUN_NEEDS_OPERATOR,
  CHECKS_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  HUMAN_DECISION_REQUIRED: EXIT_RUN_NEEDS_OPERATOR,
  // Graded 3 and not overridden one store code at a time, unlike the two
  // `_NOT_DURABLE` members below it — and the difference is the effect, not the
  // store. Those two are written *after* something happened, so a failed write
  // means a caller was told yes about a thing that is not on disk, and which
  // code that becomes depends on what the store found. This one is written
  // *before* anything is contacted, so nothing on the remote is in question and
  // there is no such asymmetry to grade. The rule rather than a list, because a
  // list beside a closed vocabulary goes stale: what failed is local — the store
  // under the operator's profile, or a subject this record's contract will not
  // hold — and a person has to look at one of the two.
  //
  // Graded 3 rather than 5, and the reason is the majority rather than all of
  // them: one member does clear on its own, because an event name already taken
  // carries a fresh identity on the next invocation, and the rest need somebody.
  // Telling an operator "call again" about a store that cannot be written is the
  // worse of the two errors.
  PUBLICATION_AUDIT_NOT_DURABLE: EXIT_RUN_NEEDS_OPERATOR,
  // A floor, and the first member on the publication path whose write happens
  // *after* the ladder has run to the end. That is the asymmetry the paragraph
  // above says the member beside it does not have, so this one is graded the way
  // the two other post-write stores are: the store's own code replaces this
  // number whenever there is one — see {@link exitCodeForDrive}.
  //
  // The floor is 3 rather than 4, and 4 is what it would be if the rule for it
  // ("refused or achieved nothing; the state may be fine") held. It does not, on
  // either half of this member's producers: a record an operator's own
  // declaration asked for was not established and nothing will ever write it,
  // and on the half that sent something a ref may have been created with no
  // established record of it. It is emphatically not 5 either — calling again
  // reads the remote, and no invocation of anything can write this event's
  // outcome now.
  //
  // "Not established" and not "missing": three of the store's codes leave a
  // whole document at the name and refuse because the write was not carried to a
  // confirmed end or could not be read back. Which it was is the store's own
  // code, one row at a time, below.
  PUBLICATION_OUTCOME_NOT_DURABLE: EXIT_RUN_NEEDS_OPERATOR,

  // This invocation achieved nothing and nothing durable is wrong: a reading
  // could not be taken, the local subject moved under it, or no pull request has
  // this head and this run did not open one.
  //
  // `ATTENDED_AUTHORITY_REQUIRED` is here rather than at 3, and a review moved
  // it: code 4 is defined above as "refused or achieved nothing; the state may
  // be fine; re-invoking under other conditions can differ", which is exactly
  // an act nobody named — and this file already grades every sibling authority
  // refusal 4 (`EXECUTION_UNAUTHORISED`, `CONTINUATION_NOT_AUTHORISED`,
  // `RUN_GATE_REFUSED`). At 3 it would have put "you did not pass --merge-pr"
  // under the same shell answer as "the checks failed".
  ATTENDED_AUTHORITY_REQUIRED: EXIT_RUN_REFUSED,
  FORGE_STATE_UNKNOWN: EXIT_RUN_REFUSED,
  // Two readings that answered and disagreed. No mutation was sent, nothing is
  // durably wrong, and re-invoking against a world that has moved on can differ
  // — which is what 4 is defined as above.
  //
  // Not 5, and the difference is not a preference. 5 means an act was attempted
  // and the next invocation must read what happened; here nothing was attempted,
  // and the count in this table's own header — "`EXIT_RUN_CALL_AGAIN` appears
  // exactly twice, and both times the instruction is literal" — would have
  // become false as well as wrong.
  FORGE_READINGS_DISAGREE: EXIT_RUN_REFUSED,
  OBSERVATION_UNSETTLED: EXIT_RUN_REFUSED,
  SUBJECT_CHANGED: EXIT_RUN_REFUSED,
  PULL_REQUEST_REQUIRED: EXIT_RUN_REFUSED,
  // A floor. The command replaces it with the store's own grade whenever a
  // record exists, one code at a time, exactly as `--conclude-delivery` does —
  // see {@link exitCodeForDrive}. It is reachable only when the ladder concluded
  // and no record came back at all, which is the second receipt read disagreeing
  // with the ladder's: a race, not a floor to be graded harder.
  CONCLUSION_NOT_DURABLE: EXIT_RUN_REFUSED,
  // The same floor, for the same reason, on the receipt. Replaced by the
  // receipt store's own grade whenever a record exists — see
  // {@link exitCodeForDrive}. A review measured the earlier version folding
  // this into "nothing durable is wrong", which is false of a contradictory
  // receipt already on disk and of a write that left a staging file behind.
  RECEIPT_NOT_DURABLE: EXIT_RUN_REFUSED,

  // Call again, and both times the words mean what they say.
  EFFECT_ATTEMPTED: EXIT_RUN_CALL_AGAIN,
  CHECKS_PENDING: EXIT_RUN_CALL_AGAIN,
}) satisfies Record<DeliveryDrive, CliExitCode>;

/**
 * The override for one merge-receipt record code, or `null` to keep the primary.
 *
 * The receipt's counterpart of {@link exitCodeForConclusionRecord}, and graded
 * one code at a time for the same reason: a review measured the driver folding
 * every failed receipt write into "nothing durable is wrong", which is false of
 * a contradictory receipt already on disk — the conclusion store's analogue,
 * `CONFLICTING_CONCLUSION`, is graded 3 in this file — and of a write that got
 * far enough to leave a directory and a staging file behind.
 *
 * Total by type over {@link MergeReconciliationRecordCode}, so a new store code
 * fails the build here until somebody grades it.
 */
const RECEIPT_RECORD_EXIT_CODES = Object.freeze({
  // On disk. Nothing to override — the primary answers. Unreachable through
  // `RECEIPT_NOT_DURABLE`, whose whole condition is that neither holds.
  RECORDED: null,
  ALREADY_RECORDED: null,

  // Nothing is wrong and the next invocation may well succeed.
  RUNTIME_IGNORE_UNDETERMINED: EXIT_RUN_REFUSED,

  // The input situation is unusable and is fixed by editing the repository.
  RUNTIME_PATH_NOT_IGNORED: EXIT_RUN_INPUT_UNUSABLE,
  LOCATION_UNSUITABLE: EXIT_RUN_INPUT_UNUSABLE,
  RECEIPT_TOO_LARGE: EXIT_RUN_INPUT_UNUSABLE,

  // Durable state an operator has to look at: a second contradictory receipt, a
  // document this build cannot read, a receipt it would not accept back, or a
  // write that got far enough to leave something behind.
  CONFLICTING_RECEIPT: EXIT_RUN_NEEDS_OPERATOR,
  EXISTING_RECEIPT_UNREADABLE: EXIT_RUN_NEEDS_OPERATOR,
  RECEIPT_CONTRACT_VIOLATION: EXIT_RUN_NEEDS_OPERATOR,
  DIRECTORY_CREATE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  WRITE_FAILED: EXIT_RUN_NEEDS_OPERATOR,

  // Something is wrong inside the tool. Both are floors: the reconciliation
  // builds the proof and the expectations from its own readings.
  MERGE_NOT_PROVEN: EXIT_RUN_UNEXPECTED,
  SUBJECT_MISMATCH: EXIT_RUN_UNEXPECTED,
}) satisfies Record<MergeReconciliationRecordCode, CliExitCode | null>;

/**
 * The override for one publication-outcome store code, or `null` to keep the
 * primary.
 *
 * The third of these tables, and graded one code at a time for the reason the
 * other two are: a run that attempted a forge mutation and could not leave the
 * evidence of it on disk has a durable problem, and *which* problem it is
 * decides what a person does about it.
 *
 * Every member here is read against the same background: **a record an
 * operator's own declaration asked for was not established, and no invocation of
 * anything will ever write it.** Not "is missing" — three of these codes leave a
 * whole document at the name and refuse because the write was not carried to a
 * confirmed end or could not be read back, and telling them apart is the whole
 * reason this table grades one code at a time. On one of the member's producers
 * an act may also already have changed the delivery remote — which of them it
 * was is on the `Publication` line and deliberately not in this table, because a
 * number cannot carry two vocabularies. So nothing here is graded "nothing is
 * wrong" and nothing is graded "call again".
 *
 * Total by type over {@link HeadPublicationOutcomeCode}, so a new store code
 * fails the build here until somebody grades it. The grades themselves are
 * pinned by a hand-written table in the slice's test file, which is deliberately
 * not derived from this one.
 */
const PUBLICATION_OUTCOME_EXIT_CODES = Object.freeze({
  // On disk. Nothing to override — and unreachable through the member this
  // table serves, whose whole condition is that it is not.
  RECORDED: null,

  // The machine could not answer where the profile is, or something on the
  // store's path is not what it has to be, or this event's own directory is
  // gone. Durable local conditions, and each needs somebody to look.
  PROFILE_UNAVAILABLE: EXIT_RUN_NEEDS_OPERATOR,
  STORE_PATH_UNSAFE: EXIT_RUN_NEEDS_OPERATOR,
  EVENT_DIRECTORY_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  // Something else is at this event's outcome name. The store never opened it
  // and never replaced it, and a name in this store that this invocation did not
  // write is a store somebody has to look at.
  OUTCOME_ALREADY_PRESENT: EXIT_RUN_NEEDS_OPERATOR,
  // The name was created and the write did not reach a confirmed end, so the
  // name is consumed and what is at it was never read back. A later listing may
  // find a whole outcome there or something it cannot read; this build does not
  // know which, and says so rather than picking the tidier half.
  WRITE_UNCONFIRMED: EXIT_RUN_NEEDS_OPERATOR,
  // Nothing is at the name and nothing ever will be.
  WRITE_REFUSED: EXIT_RUN_NEEDS_OPERATOR,
  READBACK_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  // The disk holds bytes this invocation did not intend, which is the sharpest
  // signal in this vocabulary that something else writes in this store.
  READBACK_MISMATCH: EXIT_RUN_NEEDS_OPERATOR,

  // Something is wrong inside the tool: an event name this build minted and
  // would not accept back, or bytes it built and would not read. Floors, and
  // graded as such rather than blamed on the machine.
  EVENT_ID_UNSUITABLE: EXIT_RUN_UNEXPECTED,
  OUTCOME_TOO_LARGE: EXIT_RUN_UNEXPECTED,
  OUTCOME_CONTRACT_VIOLATION: EXIT_RUN_UNEXPECTED,
}) satisfies Record<HeadPublicationOutcomeCode, CliExitCode | null>;

/**
 * Exit code for each delivery-selection outcome. Total; pinned by test.
 *
 * Total over the vocabulary, which is what `satisfies Record<…>` buys and why
 * all three members are here — a member left out would be a member nobody
 * classified. Only two of the three are ever an exit: `DELIVERY_TASK_SELECTED`
 * does not end the invocation, because the run goes on to the driver and the
 * driver's own member decides the code. It is graded `EXIT_RUN_OK` anyway, which
 * is the honest grade: it is not a stop, and if it ever became the last word it
 * would be one about a selection that succeeded.
 */
const DELIVERY_SELECTION_EXIT_CODES = Object.freeze({
  DELIVERY_TASK_SELECTED: EXIT_RUN_OK,
  /**
   * Nominal. The plan was read, every declared task was examined, and none is
   * waiting for a delivery act — which is what a repository whose deliveries
   * are all concluded looks like, and equally what one whose tasks have not run
   * yet looks like. Graded 0 for the reason `ALL_TASKS_COMPLETE` is: an
   * operator asking "is there anything to deliver?" and being told "no"
   * received an answer, not a failure.
   *
   * The trade-off is stated rather than absorbed. A caller that loops on
   * exit 0 learns nothing new here, and a repository whose task source is
   * missing or empty does **not** reach this member: `discoverTasks` refuses
   * first — `TASK_SOURCE_NOT_FOUND` for a path with nothing at it, and
   * `TASK_SOURCE_EMPTY` for a directory holding no task files — and the command
   * grades every planning failure `EXIT_RUN_INPUT_UNUSABLE` itself, at
   * `delivery-command.ts`. Not in a table here, and deliberately: see the note
   * on {@link exitCodeForDeliverySelection} directly below. The point of the
   * split is that a mistyped path cannot arrive as "nothing to deliver".
   */
  NO_DELIVERY_PENDING: EXIT_RUN_OK,
  /**
   * A record beside an earlier task could not be read, so the walk stopped
   * there. Durable state a person has to look at, graded like every sibling
   * unreadable record on this surface — `DELIVERY_EVIDENCE_UNUSABLE` is 3, and
   * this is the same condition one layer earlier.
   */
  DELIVERY_EVIDENCE_UNREADABLE: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<DeliveryTaskSelection, CliExitCode>;

/**
 * The exit code for one delivery-selection outcome.
 *
 * A planning failure is deliberately **not** routed through here: it belongs to
 * the planner's vocabulary, not to selection's, and the two are kept apart for
 * the reason `plan-next-task.ts` gives about its own upstream sets. The command
 * grades it `EXIT_RUN_INPUT_UNUSABLE` directly, as every other caller of the
 * planner does.
 */
export function exitCodeForDeliverySelection(outcome: DeliveryTaskSelection): CliExitCode {
  return DELIVERY_SELECTION_EXIT_CODES[outcome];
}

/**
 * The store codes one driver result reached, or `null` where it reached none.
 *
 * One named field per store rather than one parameter, because they are three
 * different closed vocabularies and a parameter that took any of them would be a
 * parameter that could take the wrong one.
 */
export interface DriveRecordCodes {
  readonly conclusion?: DeliveryConclusionRecordCode | null;
  readonly receipt?: MergeReconciliationRecordCode | null;
  readonly publicationOutcome?: HeadPublicationOutcomeCode | null;
}

/**
 * The exit code for one driver result.
 *
 * The store codes are consulted for exactly three members, for the reason
 * {@link exitCodeForConclusionRecord} exists: a run that decided something was
 * filed and could not leave it on disk has told a caller yes about something
 * that did not happen, and *which* code that becomes is one store code at a
 * time rather than a single number chosen here.
 *
 * The execution lease is **not** applied here. It is applied by the caller, last
 * and over this, because `run-exit-codes.ts` states it as a rule about
 * authority: no primary code is exempt, and this is a primary code like any
 * other.
 */
export function exitCodeForDrive(
  outcome: DeliveryDrive,
  records: DriveRecordCodes = {},
): CliExitCode {
  const conclusion = records.conclusion ?? null;
  if (outcome === 'CONCLUSION_NOT_DURABLE' && conclusion !== null) {
    return exitCodeForConclusionRecord(conclusion) ?? DRIVE_EXIT_CODES.CONCLUSION_NOT_DURABLE;
  }
  const receipt = records.receipt ?? null;
  if (outcome === 'RECEIPT_NOT_DURABLE' && receipt !== null) {
    return RECEIPT_RECORD_EXIT_CODES[receipt] ?? DRIVE_EXIT_CODES.RECEIPT_NOT_DURABLE;
  }
  const publicationOutcome = records.publicationOutcome ?? null;
  if (outcome === 'PUBLICATION_OUTCOME_NOT_DURABLE' && publicationOutcome !== null) {
    return (
      PUBLICATION_OUTCOME_EXIT_CODES[publicationOutcome] ??
      DRIVE_EXIT_CODES.PUBLICATION_OUTCOME_NOT_DURABLE
    );
  }
  return DRIVE_EXIT_CODES[outcome];
}

// ── Cross-repository planning (M2 slice 3) ─────────────────────────────────

/**
 * Exit code for every cross-repository plan outcome. Total; pinned by test.
 *
 * Every value here mirrors the decision `PLAN_EXIT_CODES` already made for the
 * single-repository conclusion that means the same thing, and that is the whole
 * of the reasoning: an operator's shell must not have to learn a second set of
 * meanings because a report covered more than one repository.
 *
 *  - `TASK_SELECTED` and `ALL_TASKS_COMPLETE` are nominal answers — the operator
 *    got exactly what they asked for — as `ALL_TASKS_COMPLETE` is there;
 *  - `NO_ELIGIBLE_TASK` keeps its code 2 from there;
 *  - `REPOSITORY_UNPLANNABLE` is `PLANNING_FAILED` with a repository named, so
 *    it takes that code;
 *  - `NO_REPOSITORIES_REGISTERED` is the input not being planbable, which is
 *    what code 2 says. It is deliberately **not** 0: an operator who has
 *    enlisted nothing has a configuration to finish, and answering "success"
 *    would be the same false reading `discoverTasks` refuses for an empty task
 *    source.
 */
const CROSS_REPOSITORY_PLAN_EXIT_CODES = Object.freeze({
  TASK_SELECTED: EXIT_RUN_OK,
  ALL_TASKS_COMPLETE: EXIT_RUN_OK,
  NO_ELIGIBLE_TASK: EXIT_RUN_INPUT_UNUSABLE,
  NO_REPOSITORIES_REGISTERED: EXIT_RUN_INPUT_UNUSABLE,
  REPOSITORY_UNPLANNABLE: EXIT_RUN_INPUT_UNUSABLE,
}) satisfies Record<CrossRepositoryPlanCode, CliExitCode>;

export function exitCodeForCrossRepositoryPlan(code: CrossRepositoryPlanCode): CliExitCode {
  return CROSS_REPOSITORY_PLAN_EXIT_CODES[code];
}

/**
 * Exit code for every way the registry can be present and unusable. Total;
 * pinned by test.
 *
 * Uniformly 2. Not because the distinction does not matter — it very much does
 * to the person reading the report, which names the code — but because the
 * shell-level answer to every one of them is the same: this invocation could not
 * be planned, nothing durable is wrong, and the fix is to edit one file. A
 * refusal here is never `EXIT_RUN_NEEDS_OPERATOR`, which this build reserves for
 * a *durable record* that needs a human.
 *
 * `PROFILE_UNAVAILABLE` is the one that could argue for a different code, and it
 * gets 2 as well: the operating system declining to say where the user profile
 * is makes the registry path underivable, which is the input being unusable from
 * this command's point of view.
 */
const REPOSITORY_REGISTRY_EXIT_CODES = Object.freeze({
  PROFILE_UNAVAILABLE: EXIT_RUN_INPUT_UNUSABLE,
  REGISTRY_UNREADABLE: EXIT_RUN_INPUT_UNUSABLE,
  REGISTRY_TOO_LARGE: EXIT_RUN_INPUT_UNUSABLE,
  REGISTRY_MALFORMED: EXIT_RUN_INPUT_UNUSABLE,
  REGISTRY_FORBIDDEN_KEY: EXIT_RUN_INPUT_UNUSABLE,
  REGISTRY_CONTRACT_VIOLATION: EXIT_RUN_INPUT_UNUSABLE,
  REGISTRY_DUPLICATE_PATH: EXIT_RUN_INPUT_UNUSABLE,
}) satisfies Record<RepositoryRegistryRefusal, CliExitCode>;

export function exitCodeForRepositoryRegistry(code: RepositoryRegistryRefusal): CliExitCode {
  return REPOSITORY_REGISTRY_EXIT_CODES[code];
}

/**
 * Exit code for every way resolving the registry can be refused. Total; pinned
 * by test. Uniformly 2, for the reason above.
 */
const REGISTRY_RESOLUTION_EXIT_CODES = Object.freeze({
  REPOSITORY_UNRESOLVABLE: EXIT_RUN_INPUT_UNUSABLE,
  DUPLICATE_REPOSITORY_ROOT: EXIT_RUN_INPUT_UNUSABLE,
  DUPLICATE_EXECUTION_DOMAIN: EXIT_RUN_INPUT_UNUSABLE,
}) satisfies Record<RegistryResolutionRefusal, CliExitCode>;

export function exitCodeForRegistryResolution(code: RegistryResolutionRefusal): CliExitCode {
  return REGISTRY_RESOLUTION_EXIT_CODES[code];
}

/**
 * How the six exit codes rank when one report has to carry several answers
 * (M2 slice 5).
 *
 * A cross-repository run drives many repositories and gets many codes, and the
 * shell gets one. This is the order of *how much attention the ending demands*,
 * worst first, and every code is ranked so that no pair is undecided:
 *
 *  1. `EXIT_RUN_UNEXPECTED` — something threw. A defect outranks every answer,
 *     because the other answers were produced by code that was working;
 *  2. `EXIT_RUN_NEEDS_OPERATOR` — a durable record a human has to look at. It
 *     outranks bad input because the record is already on disk;
 *  3. `EXIT_RUN_INPUT_UNUSABLE` — a file to edit, nothing durable wrong;
 *  4. `EXIT_RUN_REFUSED` — somebody else is working. It clears itself, so it
 *     outranks only the endings that need nothing at all;
 *  5. `EXIT_RUN_CALL_AGAIN` — progress was made and more remains;
 *  6. `EXIT_RUN_OK`.
 *
 * `EXIT_RUNTIME_UNSUPPORTED` is deliberately absent: the runtime gate terminates
 * the process at the CLI entry before any command is dispatched, so no run can
 * produce it beside another code.
 */
const EXIT_CODE_SEVERITY: readonly CliExitCode[] = Object.freeze([
  EXIT_RUN_UNEXPECTED,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_REFUSED,
  EXIT_RUN_CALL_AGAIN,
  EXIT_RUN_OK,
]);

/**
 * The more demanding of two exit codes, by {@link EXIT_CODE_SEVERITY}.
 *
 * A code the ranking does not know ranks worst rather than best. That is the
 * fail-closed reading: an unrankable answer must not be able to make a run look
 * finished, and the only way to reach it is for somebody to add a seventh code
 * without adding it above.
 */
function worseExitCode(a: CliExitCode, b: CliExitCode): CliExitCode {
  const rankA = EXIT_CODE_SEVERITY.indexOf(a);
  const rankB = EXIT_CODE_SEVERITY.indexOf(b);
  if (rankA < 0) return a;
  if (rankB < 0) return b;
  return rankA <= rankB ? a : b;
}

/**
 * The coordinator's own endings. Total; pinned by test.
 *
 * Only the endings this layer decides. `RUN_COMPLETE` and `NOTHING_ADMITTED`
 * are absent because neither has an answer of its own: the first is the worst of
 * its admissions and the second is the planner's, and a code written here for
 * either would be a second, weaker copy of a decision another table already
 * makes.
 */
const CROSS_REPOSITORY_RUN_EXIT_CODES = Object.freeze({
  // Nothing was planned and nothing ran: a bound to edit, which is code 2 for
  // the same reason every registry refusal is.
  CAPACITY_INVALID: EXIT_RUN_INPUT_UNUSABLE,
  // Work was admitted and awaited, and the configuration then stopped being
  // readable. The planner's refusal is `EXIT_RUN_INPUT_UNUSABLE` and stays it —
  // what changed is that there are now results to read as well, and those are
  // folded in below rather than overridden here.
  PLANNING_REFUSED_MIDRUN: EXIT_RUN_INPUT_UNUSABLE,
  // Progress was made and more may remain: `EXIT_RUN_CALL_AGAIN`, the same
  // answer `INVOCATION_BUDGET_EXHAUSTED` gives for the same shape of ending.
  // Reaching it means 4096 distinct tasks were driven in one invocation, which
  // is a legitimate very large run as readily as it is a defect, and this build
  // cannot tell those apart from here.
  ADMISSION_BUDGET_EXHAUSTED: EXIT_RUN_CALL_AGAIN,
}) satisfies Record<
  Exclude<CrossRepositoryRunOutcome, 'RUN_COMPLETE' | 'NOTHING_ADMITTED'>,
  CliExitCode
>;

/**
 * Exit code for a whole cross-repository run (M2 slice 5).
 *
 * Three inputs, folded in one direction — worse wins:
 *
 *  - the coordinator's own ending, where it has one;
 *  - the planner's code, for a run that admitted nothing;
 *  - every admission's own `exitCodeForLifecycleRun`, unchanged. A task that
 *    ended `BLOCKED_VERIFY` did not end differently for having run beside
 *    another repository, which is the same rule the lifecycle table states about
 *    an outer loop.
 *
 * An admission that **threw** contributes `EXIT_RUN_UNEXPECTED`, which by the
 * ranking wins outright. It has no `LifecycleResult` to grade, and an ending
 * with no report may not be graded as the absence of a problem.
 */
export function exitCodeForCrossRepositoryRun(result: {
  readonly outcome: CrossRepositoryRunOutcome;
  readonly planCode: CrossRepositoryPlanCode | null;
  readonly admissions: readonly {
    readonly threw: boolean;
    readonly lifecycle: { readonly outcome: LifecycleOutcome; readonly start: { readonly outcome: StartTaskOutcome } | null } | null;
  }[];
}): CliExitCode {
  if (result.outcome === 'CAPACITY_INVALID') {
    return CROSS_REPOSITORY_RUN_EXIT_CODES.CAPACITY_INVALID;
  }

  let code: CliExitCode =
    result.outcome === 'NOTHING_ADMITTED'
      ? // The planner's own answer. `null` is not reachable — a run that planned
        // at all records the code — and is graded as a defect rather than as a
        // success, because a coordinator that admitted nothing and cannot say
        // why has not answered the question.
        result.planCode === null
        ? EXIT_RUN_UNEXPECTED
        : exitCodeForCrossRepositoryPlan(result.planCode)
      : EXIT_RUN_OK;

  if (result.outcome === 'PLANNING_REFUSED_MIDRUN') {
    code = worseExitCode(code, CROSS_REPOSITORY_RUN_EXIT_CODES.PLANNING_REFUSED_MIDRUN);
  }
  if (result.outcome === 'ADMISSION_BUDGET_EXHAUSTED') {
    code = worseExitCode(code, CROSS_REPOSITORY_RUN_EXIT_CODES.ADMISSION_BUDGET_EXHAUSTED);
  }

  for (const admission of result.admissions) {
    code = worseExitCode(
      code,
      admission.threw || admission.lifecycle === null
        ? EXIT_RUN_UNEXPECTED
        : exitCodeForLifecycleRun(admission.lifecycle),
    );
  }
  return code;
}
