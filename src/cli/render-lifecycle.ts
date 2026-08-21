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
import type { InvocationGrant } from '../run/invocation-grant.js';
import type {
  ResetWaitDisposition,
  UnattendedResumeResult,
} from '../run/unattended-resume.js';
import {
  ATTENDED_TRAILER,
  line,
  renderRunResult,
  renderStartResult,
} from './render-attended-run.js';
import {
  LEASE_ACQUIRE_SENTENCES,
  STALE_RECOVERY_SENTENCES,
  leaseReleaseLine,
} from './render-lease.js';

/**
 * The closing sentence of a run that took more than one invocation.
 *
 * It states the scope of the grant, because that is the question a repeated run
 * raises, and it states what the run will *not* do without a human, because an
 * operator reading "unattended" needs to know where that stops.
 */
export const LIFECYCLE_TRAILER =
  'This run continued past its first invocation, in one foreground process and under one\n' +
  'grant -- the same scope `block --attended` has always had. A task parked on a quota limit\n' +
  'stops it: waiting for a reset is a separate authority that is never implied, and is asked\n' +
  'for by name with --automatic-resume-only --wait-for-reset.';

/**
 * The closing sentence of a run made under the unattended automatic-resume grant.
 *
 * It replaces `ATTENDED_TRAILER`, which claims an operator is present and would
 * be false here. Every clause is a property this build enforces rather than
 * intends: the grant passes `run-driver.ts`'s gate only on `AUTOMATIC_ALLOWED`,
 * `lifecycle-driver.ts` never reaches `startTask` under it, and
 * `unattended-resume.ts` fixes `recoverStaleLease` to false and builds one
 * once-only auth preflight per lifecycle epoch.
 */
export const UNATTENDED_AUTO_RESUME_TRAILER =
  'Unattended automatic resume. --automatic-resume-only was given, so this invocation could\n' +
  'enter ONE task that already had durable state, and only where the resume decision freshly\n' +
  'answered AUTOMATIC_ALLOWED. Having resumed it, the run then drives it like any other --\n' +
  'writer, verification, review, remediation -- up to --max-steps. It could not start a task,\n' +
  'could not pick up in-flight work it had not itself resumed, and could not remove a stale\n' +
  'lease. Auth is a separate requirement that this grant says nothing about: every attempt\n' +
  'that gets as far as driving proves it again, and one that stopped earlier -- on the lease,\n' +
  'or with nothing to continue -- never asked.';

/**
 * The closing sentence of a run made under no continuation grant at all.
 *
 * The third member existed from the start and had no sentence of its own, so it
 * printed `ATTENDED_TRAILER` — "--attended was given" — about a run whose grant
 * is precisely the absence of that claim. No production path renders it today;
 * it is written because this renderer's job is to be true for every value of a
 * closed type, not only for the values that happen to be reachable this week.
 */
export const NO_CONTINUATION_TRAILER =
  'No continuation grant. Neither --attended nor --automatic-resume-only was given, so this\n' +
  'invocation was not permitted to continue anything: no agent was started, and any task it\n' +
  'reached was left exactly as it was found. Pass --attended to execute with an operator\n' +
  'present, or --automatic-resume-only to continue one already-durable task without one.';

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
      '  It runs once per attempt -- an ordinary run makes one, and a run that waited for a quota\n' +
      '  reset proves auth again afterwards rather than trusting the artefact it minted before --\n' +
      '  and a failure is never retried inside an attempt. Log the agent CLIs in and invoke again.',
    COMPLETED:
      'The task reached READY_FOR_PR. Terminal: a human opens the pull request from here.',
    TASK_ABORTED: 'The task was already ABORTED. Nothing was run.',
    BLOCKED_USAGE_LIMIT:
      'A subscription quota is exhausted. A pause rather than a failure, and this run stops on\n' +
      '  it. Waiting for the reset is a separate authority and is never implied by the block: it\n' +
      '  happens only when --automatic-resume-only and --wait-for-reset were both given, and\n' +
      '  only while the reported reset time is the one check still refusing the resume.\n' +
      '  Otherwise, invoke again once the quota has returned.',
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
      'A bound this run was given cannot be used, so nothing was taken and nothing ran. The\n' +
      '  reasons below name which: --max-invocations is not a positive whole number, or a wait\n' +
      '  was requested and --max-invocations leaves no invocation for the attempt after it (one\n' +
      '  wait needs at least 2, because the first is spent meeting the block), or --max-wait-ms\n' +
      '  is not a usable number of milliseconds. Invoking again unchanged repeats this exactly.',
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
  /**
   * The grant this run was made under. **Required, and deliberately not
   * defaulted.**
   *
   * It had a default of `'ATTENDED'` for one round, and a review named the
   * problem: that is the value which asserts an operator was present, so a
   * future call site that forgot the argument would print "--attended was
   * given" about a run where it was not. Everywhere else in this slice the
   * grant has no default and cannot be inferred (`LifecycleRequest`,
   * `RunRequest`, the CLI); this is now the same rule, held by the compiler.
   */
  grant: InvocationGrant,
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
  // The same renderer `block --attended` and `release --attended` print, and
  // deliberately only its line: the per-code sentence those two print below it
  // is not added here, because this report's sentence already comes from
  // `LIFECYCLE_OUTCOME_SENTENCES` and a second one would say it twice.
  if (result.release !== null) {
    lines.push(leaseReleaseLine('Release', result.release));
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

  // The contract sentence for whichever grant this run was made under: an
  // operator is owed the same statement of what the grant permitted, whether the
  // run took one invocation or ten. `ATTENDED_TRAILER` says "--attended was
  // given", so it may not be printed for a run where it was not — the grant
  // decides which sentence is true, rather than one sentence being printed on
  // every path and being false on one of them.
  //
  // **Chosen by an exhaustive switch, not by `!== 'AUTOMATIC_RESUME_ONLY'`.**
  // That test was here for one round and it was wrong in the same way this
  // parameter's old default was: it folded `NO_CONTINUATION` in with `ATTENDED`
  // and printed an operator-presence claim for a run whose grant is precisely
  // the absence of one. Making the parameter required stopped a caller
  // *forgetting* the grant; it did nothing about a three-member value handled
  // two ways.
  //
  // The repeated-run sentence stays attended-only: it describes the scope
  // `block --attended` has, which is neither of the other two. The unattended
  // trailer states its own scope in full, and a run granted no continuation made
  // no invocations to describe.
  lines.push('', trailerFor(grant));
  if (grant === 'ATTENDED' && result.invocations > 1) lines.push('', LIFECYCLE_TRAILER);
  lines.push('');
  return lines.join('\n');
}

/**
 * The contract sentence for one grant. Total over {@link InvocationGrant}.
 *
 * No `default` clause, deliberately: a new grant member must be given a sentence
 * here rather than silently inheriting whichever one a boolean happened to fall
 * through to. That is the whole reason this is a switch.
 */
function trailerFor(grant: InvocationGrant): string {
  switch (grant) {
    case 'ATTENDED':
      return ATTENDED_TRAILER;
    case 'AUTOMATIC_RESUME_ONLY':
      return UNATTENDED_AUTO_RESUME_TRAILER;
    case 'NO_CONTINUATION':
      return NO_CONTINUATION_TRAILER;
  }
}

/* ────────────────────── the unattended automatic resume ─────────────────── */

/** One static sentence per wait disposition. Closed, and pinned by test. */
export const RESET_WAIT_SENTENCES: Readonly<Record<ResetWaitDisposition, string>> =
  Object.freeze({
    NOT_A_QUOTA_BLOCK:
      'No wait was in question: this run did not stop on a subscription quota block, and a\n' +
      '  reset is the only thing this mode ever waits for.',
    NOT_REQUESTED:
      'The task is parked on a quota block and no wait was requested, so nothing slept. Waiting\n' +
      '  is opt-in: add --wait-for-reset with --max-wait-ms to permit exactly one bounded wait.',
    RESUME_DECISION_ABSENT:
      'The quota block this run stopped on is one it met after its last resume decision --\n' +
      '  typically one its own work ran into -- so nothing has judged that block yet and nothing\n' +
      '  slept. The task is durably parked and correct. Invoke again once the quota has\n' +
      '  returned, and the resume decision will be made about this block.',
    RESUME_DENIED_BY_OTHER_CHECKS:
      'The automatic resume was refused, and at least one of the reasons is something the\n' +
      '  passage of time does not fix, so nothing slept -- waiting would have delayed a refusal\n' +
      '  rather than cleared one. The reasons below name every check that denied it; the ones\n' +
      '  that are not about the reset time have to be resolved before any resume proceeds.',
    RESET_TIME_MISSING:
      'The durable state records no reported quota reset time, so there is nothing to wait for\n' +
      '  and nothing slept. A reset time is only ever recorded when an agent CLI reported one;\n' +
      '  this build never invents one.',
    RESET_TIME_UNPARSEABLE:
      'The recorded quota reset time is not a timestamp this build can read, so nothing slept.\n' +
      '  A human has to look at the durable state.',
    CURRENT_TIME_UNPARSEABLE:
      'The clock produced something that is not a timestamp, so no wait could be measured and\n' +
      '  nothing slept.',
    BOUND_EXCEEDED:
      'The wait this reset would need is longer than --max-wait-ms allowed, so nothing slept and\n' +
      '  the task stays parked. Raise the bound, or invoke again after the reset.',
    WAIT_BOUND_UNUSABLE:
      'The --max-wait-ms value is not a bound this build will sleep on, so no wait was possible\n' +
      '  and nothing ran -- not even a lease was taken. It must be a whole number of\n' +
      '  milliseconds between 1 and 86400000 (24 hours), and there is no default. Raising it is\n' +
      '  not the fix unless the value was simply too large.',
    LEASE_RELEASE_UNPROVEN:
      'The execution lease was not provably given back before the wait, so nothing slept. A\n' +
      '  waiter that cannot prove it released may still be this repository\'s writer, and it was\n' +
      '  about to be unreachable for hours. Read the release code beside the run above.',
    INVOCATION_BUDGET_SPENT:
      'There was no invocation left to spend on the attempt after the wait, so nothing slept.\n' +
      '  One wait needs at least --max-invocations 2: the first is spent meeting the block.',
    REPOSITORY_UNRESOLVED_AFTER_WAIT:
      'The wait completed and the repository could not be resolved again afterwards, so no lease\n' +
      '  was taken and nothing ran. Nothing before the wait is treated as proof that the\n' +
      '  repository is still there.',
    WAITED:
      'The reported reset time was the one check still refusing the resume, so this run slept\n' +
      '  once -- holding no execution lease, having proven the earlier one given back -- then\n' +
      '  resolved the repository again and started a fresh attempt. **How far that attempt got\n' +
      '  is its own report, above.** It carries nothing over from before the wait: whatever it\n' +
      '  reached, it reached from evidence gathered after waking. There is no second wait in\n' +
      '  one invocation.',
  });

/**
 * The whole report for one unattended automatic-resume run.
 *
 * Both epochs are printed when there are two, and labelled, because they are two
 * different attempts under two different leases and an operator reading "another
 * writer owns the repository" needs to know it happened *after* the wait. The
 * wait itself sits between them, which is where it happened.
 */
export function renderUnattendedResume(
  repository: { id: string; root: string },
  result: UnattendedResumeResult,
): string {
  const parts: string[] = [];
  const epochs = result.epochs;

  if (epochs.length === 0) {
    // Refused before any lifecycle epoch ran: an unusable wait bound, or a
    // budget that cannot cover a wait. There is no lease phase and no run to
    // report, so the report is the refusal and nothing else.
    parts.push(
      '',
      line('Repository', `${repository.id}  (${repository.root})`),
      line('Target', result.taskId),
      line('Lifecycle', result.outcome),
      `  ${LIFECYCLE_OUTCOME_SENTENCES[result.outcome]}`,
      '',
    );
  }

  epochs.forEach((epoch, index) => {
    if (epochs.length > 1) {
      parts.push(
        '',
        line('Attempt', `${String(index + 1)} of ${String(epochs.length)}`),
      );
    }
    parts.push(renderLifecycleRun(repository, epoch, 'AUTOMATIC_RESUME_ONLY'));
  });

  parts.push(
    line('Wait', waitLabel(result.wait.disposition, result.wait.waitedMs)),
    `  ${RESET_WAIT_SENTENCES[result.wait.disposition]}`,
    line('Wait reasons', codes(result.wait.reasonCodes)),
    '',
  );

  return parts.join('\n');
}

/**
 * The wait line's value: the disposition, and the measured duration when there
 * was one.
 *
 * The duration is a number this module computed from two validated timestamps,
 * so it is safe to print; there is no free text on this line and no path by
 * which any arrives.
 */
function waitLabel(disposition: ResetWaitDisposition, waitedMs: number | null): string {
  return waitedMs === null ? disposition : `${disposition}  (${String(waitedMs)} ms)`;
}
