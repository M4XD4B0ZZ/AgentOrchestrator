/**
 * Console rendering for an unattended lifecycle run.
 *
 * Same discipline as `render-attended-run.ts`, which it builds on: only values
 * that have already passed a validating boundary may appear — closed vocabulary
 * codes, counts, task ids, the canonical repository identity, and the workspace
 * paths and commits a `TaskWorkspace` receipt carries. Paths belong on that list
 * and an earlier version of this sentence left them off: `repository.root` is
 * printed here, and `renderStartResult` prints the worktree path, work branch
 * and base commit.
 *
 * What is excluded is what a caller does not control: a `LifecycleResult` cannot
 * carry agent output, verifier output or exception text, so none can be printed.
 * `permissionDenials` carries a count and tool names, never `tool_input`.
 *
 * What this renderer adds over the attended one is the *shape of a run that
 * repeated*: how many invocations it took, how the lease was obtained, and —
 * the line that did not exist anywhere before V3-06 — whether the lease was
 * actually given back.
 */

import type {
  LifecycleOutcome,
  LifecycleResult,
} from '../run/lifecycle-driver.js';
import {
  ATTENDED_TRAILER,
  line,
  renderRunResult,
  renderStartResult,
} from './render-attended-run.js';
import { LEASE_ACQUIRE_SENTENCES, STALE_RECOVERY_SENTENCES } from './render-lease.js';

/**
 * The closing sentence of a run that took more than one invocation.
 *
 * It states the scope of the grant, because that is the question a repeated run
 * raises, and it states what the run will *not* do without a human, because an
 * operator reading "unattended" needs to know where that stops.
 */
export const LIFECYCLE_TRAILER =
  'This run continued past its first invocation, in one foreground process and under one\n' +
  'grant -- the same scope `block --attended` has always had. It never waits: a task parked\n' +
  'on a quota limit stops the run, because continuing with nobody present is an authority\n' +
  'this build does not grant.';

/** One static sentence per lifecycle outcome. Closed, and pinned by test. */
export const LIFECYCLE_OUTCOME_SENTENCES: Readonly<Record<LifecycleOutcome, string>> =
  Object.freeze({
    LIVE_OWNER_PRESENT:
      'Another invocation holds this repository\'s execution lease and its process is alive.\n' +
      '  Nothing was run, nothing was recovered and nothing waited for it. This clears itself\n' +
      '  when the other run finishes. Do not stop that process on the strength of this: process\n' +
      '  ids are reused, so the one running now need not be the owner that took the lease.',
    STALE_LEASE_PRESENT:
      'A lease is present, its holder did not answer as alive, and this run was not permitted\n' +
      '  to remove it. The lease is untouched. `agent-loop lease status` reports what is there;\n' +
      '  --recover-stale-lease permits removing one that can be proven dead.',
    RECOVERY_UNSAFE:
      'Removal was refused: this build could not prove the lease dead and safely removable.\n' +
      '  The refusal code below names which proof failed, and `agent-loop lease recover` prints\n' +
      '  a sentence for it. Nothing was removed, and there is no override - a lease is never\n' +
      '  removed on a guess.',
    LEASE_CHANGED:
      'The lease changed while the removal was being proven, so nothing was removed. Something\n' +
      '  else acted on it in between - another invocation took it, or it went away entirely.\n' +
      '  Read `agent-loop lease status` rather than assuming which.',
    LEASE_DISPLACED:
      'The removal displaced something: a successor lease, or a record detached and quarantined\n' +
      '  inside .git. An operator condition, never a retry - look before invoking again.',
    RECOVERY_FAILED:
      'Removal was permitted, was attempted and did not complete. The detail below says how it\n' +
      '  ended: the lease may still be at its path, or the name may be free with a detached,\n' +
      '  unreadable record left inside .git - which means this repository currently has no\n' +
      '  owner. Those send you to different places, so read it rather than assuming. An\n' +
      '  operator condition either way.',
    LEASE_ACQUISITION_REFUSED:
      'The lease could not be claimed, and not because a live owner holds it: the location is\n' +
      '  unusable, the repository record is incoherent, the filesystem cannot support the claim,\n' +
      '  or a successor won the race after a removal. Nothing was run.',
    TASK_START_REFUSED:
      'The task could not be started or adopted, so there was nothing to drive. The start\n' +
      '  outcome above says why.',
    AUTH_PREFLIGHT_FAILED:
      'The auth preflight produced no evidence, so no agent could have run. Nothing was driven.\n' +
      '  It runs once per invocation of this command and a failure is not retried inside one, so\n' +
      '  log the agent CLIs in and invoke again.',
    COMPLETED:
      'The task reached READY_FOR_PR. Terminal: a human opens the pull request from here.',
    TASK_ABORTED: 'The task was already ABORTED. Nothing was run.',
    BLOCKED_USAGE_LIMIT:
      'A subscription quota is exhausted. A pause rather than a failure, and this run stops on\n' +
      '  it: nothing here waits for a reset, because continuing afterwards would need a grant of\n' +
      '  operator presence made hours earlier. Invoke again once the quota has returned.',
    BLOCKED_VERIFY:
      'The repository\'s verification commands failed and were not retried. The only\n' +
      '  continuation is remediation, which is a decision.',
    BLOCKED_AUTH: 'An agent\'s credentials are missing or expired. Only a human restores them.',
    SCOPE_VIOLATION: 'An agent wrote outside its allowed scope. Not resumable at all.',
    RESUME_STATE_DIVERGED:
      'The durable state records that the record and reality disagreed. Not resumable.',
    HUMAN_DECISION_REQUIRED:
      'The loop escalated to an operator, or found one already waiting. A review budget that\n' +
      '  ran out arrives here, and a new invocation does not refill it.',
    RECONCILIATION_DIVERGED:
      'The world contradicts the durable record. Nothing was run, and nothing was repaired.',
    RECONCILIATION_UNOBSERVABLE:
      'The world could not be read, which is not the same as it disagreeing. Nothing was run.\n' +
      '  Check that Git is available and the worktree is reachable.',
    STATE_UNUSABLE:
      'A durable record exists and cannot be used: broken, oversized, written to a contract\n' +
      '  version this build does not know, or an intact record of somewhere else.',
    TASK_NOT_STARTED: 'No durable state has ever been persisted for this task.',
    STATE_CONFLICT:
      'A write was refused because another writer moved the task on. Nothing was written, and\n' +
      '  this run stopped rather than re-reading and deciding again.',
    STATE_NOT_RECORDED:
      'A write was refused for some other reason, so durable state may still claim the task is\n' +
      '  running. Distinct from a block, and worse: an unrecorded block is not a parked task.',
    CONTINUATION_NOT_AUTHORISED:
      'The record and the world agree and still nothing may continue: an unattended resume was\n' +
      '  refused, or continuing this task was not authorised for this run. The reasons say which.',
    EXECUTION_UNAUTHORISED:
      'Git authorised no worktree for this task, so nothing was spawned.',
    EXECUTION_LEASE_NOT_HELD:
      'This invocation never held this repository\'s execution lease.',
    EXECUTION_LEASE_LOST:
      'The lease this run took stopped being this run\'s while it was working, so the durable\n' +
      '  write did not land. An agent already running may still have changed the worktree.',
    NO_PROGRESS:
      'An invocation reported durable progress and the state file did not move, or the task is\n' +
      '  in a state this build does not drive. Repeating would do the same thing, so it stopped.',
    INVOCATION_BUDGET_INVALID:
      'The --max-invocations bound is not a positive whole number, so nothing was taken and\n' +
      '  nothing ran. Invoking again with the same value repeats this exactly.',
    INVOCATION_BUDGET_EXHAUSTED:
      'Durable progress was still being made when this run\'s invocation budget ran out.\n' +
      '  Everything is on disk; invoke again to continue, or raise --max-invocations.',
    LEASE_RELEASE_FAILED:
      'The run finished and the execution lease could not be given back provably. The release\n' +
      '  code below says what was found: the lease may still be held at its path, or it may have\n' +
      '  gone while this run was working - only RELEASED proves this run gave back what it took,\n' +
      '  so anything else is reported rather than called a clean shutdown. A quarantined record\n' +
      '  can be left inside .git even when the lease name itself is free. The outcome this run\n' +
      '  had actually reached is the first reason code below.',
  });

function codes(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

/**
 * The whole report for one lifecycle run.
 *
 * The lease lines come first because the lease phase happens first, and because
 * an operator whose run stopped there needs to read that before anything else.
 * `Release` is printed on every run that held a lease, including successful
 * ones: a line that appeared only on failure would be a line nobody learns to
 * look for.
 */
export function renderLifecycleRun(
  repository: { id: string; root: string },
  result: LifecycleResult,
): string {
  const lines: string[] = [
    '',
    line('Repository', `${repository.id}  (${repository.root})`),
    line('Target', result.taskId),
    line('Lifecycle', result.outcome),
    `  ${LIFECYCLE_OUTCOME_SENTENCES[result.outcome]}`,
  ];

  if (result.acquire !== null) {
    // The code *and* the acquire vocabulary's own sentence for it. Six of the
    // eight acquire refusals share one lifecycle outcome, so the outcome
    // sentence above can only hedge across them — "the location is unusable, the
    // record is incoherent, or the filesystem cannot support the claim" is four
    // different errands. `run --attended` printed these sentences before this
    // slice and briefly stopped; `lease status` and `block --attended` never
    // did stop, so two commands were answering one condition differently.
    lines.push(line('Lease', result.acquire), `  ${LEASE_ACQUIRE_SENTENCES[result.acquire]}`);
  }
  if (result.recovery !== null) {
    // `refusal` when the predicate refused, `detail` when it did not: those are
    // exclusive by contract, and `detail` is the only thing that separates a
    // `RECOVERY_FAILED` that left the lease in place from one that left the name
    // free and an unreadable record behind. Printing the bare code, which is
    // what this did first, tells an operator neither.
    const recovery = result.recovery;
    const qualifier = recovery.refusal ?? recovery.detail;
    lines.push(
      line('Recovery', qualifier !== null ? `${recovery.code}  (${qualifier})` : recovery.code),
    );
    if (recovery.refusal !== null) {
      lines.push(`  ${STALE_RECOVERY_SENTENCES[recovery.refusal]}`);
    }
  }
  if (result.release !== null) {
    lines.push(
      line(
        'Release',
        result.release.detail !== null
          ? `${result.release.code}  (${result.release.detail})`
          : result.release.code,
      ),
    );
  }

  lines.push(
    line('Invocations', String(result.invocations)),
    line('Steps', String(result.steps)),
  );
  if (result.start !== null) lines.push(renderStartResult(result.start));

  // The last run, which is the one the lifecycle outcome came from. Every
  // earlier one ended STEP_BUDGET_EXHAUSTED by construction — that is the only
  // outcome the loop continues on — so printing them all would print one line
  // repeatedly.
  const last = result.runs.at(-1);
  if (last !== undefined) lines.push(renderRunResult(last));

  // Labelled apart from the run's own `Reasons` line, which `renderRunResult`
  // prints just above it. Two lines under one label read as a repeat, and these
  // are different answers: one is why the last invocation stopped, the other is
  // why the lifecycle did.
  lines.push(line('Stopped by', codes(result.reasonCodes)));
  if (result.permissionDenials.count > 0) {
    lines.push(
      line(
        'Denials',
        `${result.permissionDenials.count}  (${codes(result.permissionDenials.tools)})`,
      ),
    );
  }

  // The attended contract sentence, unchanged and on every attended run: an
  // operator who passed --attended is owed the same statement of what the grant
  // permitted, whether the run took one invocation or ten. The lifecycle
  // sentence is added only when the run did something that sentence does not
  // describe — continued past its first invocation.
  lines.push('', ATTENDED_TRAILER);
  if (result.invocations > 1) lines.push('', LIFECYCLE_TRAILER);
  lines.push('');
  return lines.join('\n');
}
