/**
 * Console rendering for an attended run. Plain ASCII, no secrets, no colour deps.
 *
 * Same discipline as `render-run-plan.ts`, and for the same reason: only values
 * that have already passed a validating boundary may appear here — task ids,
 * closed vocabulary codes, the canonical repository identity, and ISO timestamps
 * the state contract validated. Agent output, verifier output, finding paths and
 * exception text are not representable in a `StartTaskResult` or a `RunResult`
 * and therefore cannot be printed.
 *
 * The one thing this renderer says that the plan renderer cannot is that
 * something *happened*. That sentence is as much a part of the contract as the
 * read-only one, and it is a single constant for the same reason: a promise
 * spelled twice can drift.
 */

import { USAGE_LIMIT_CONTINUATION_SENTENCES } from '../core/usage-limit-continuation.js';
import type { RunResult } from '../run/run-driver.js';
import type { StartTaskOutcome, StartTaskResult } from '../run/start-task.js';

/**
 * The closing sentence of an attended run.
 *
 * Deliberately the mirror image of `READ_ONLY_TRAILER`: an operator who sees
 * this text has been told, in the report itself, that this invocation was
 * allowed to write. It states the grant that allowed it, so that "why did this
 * change my repository?" is answered by the output rather than by the shell
 * history.
 */
export const ATTENDED_TRAILER =
  'Attended run. --attended was given, so this invocation was permitted to start agents,\n' +
  'write task state and prepare a workspace. Auth evidence was proven separately: the\n' +
  'grant states an operator is present, never that a login is valid.';

/**
 * The sentence for the case where the grant was withheld.
 *
 * Printed instead of executing, so that an operator who expected a run and got a
 * plan learns why from the report.
 */
export const GRANT_WITHHELD_SENTENCE =
  'Execution was not requested. `run` reports and changes nothing; pass --attended to\n' +
  'execute. This is the same read-only plan the command has always produced.';

/** One static sentence per start outcome. Closed, and pinned by test. */
export const START_OUTCOME_SENTENCES: Readonly<Record<StartTaskOutcome, string>> = Object.freeze({
  STARTED: 'A workspace was created and the first durable state was written.',
  ADOPTED:
    'An untouched workspace left behind by an earlier start of this same task was proven to\n' +
    '  be ours and reused. Nothing was created, and the durable state written is the one a\n' +
    '  fresh start writes.',
  ALREADY_STARTED: 'This task already had durable state. Nothing was started a second time.',
  TASK_ID_INVALID: 'The requested task id is not a valid task id. It was not looked up.',
  PLANNING_FAILED: 'The task source could not be read or normalised. Nothing was started.',
  TASK_UNKNOWN: 'The requested task id names no task in this plan.',
  TASK_INELIGIBLE: 'The requested task exists but is not eligible to run.',
  RUNTIME_NOT_IGNORED:
    'This repository does not ignore .agent-orchestrator/runtime/, so writing task state\n' +
    '  there would dirty the checkout and refuse the next task. Add it to .gitignore.',
  RUNTIME_IGNORE_UNDETERMINED:
    'Git could not say whether the runtime directory is ignored. Nothing was started.',
  AUTH_PREFLIGHT_FAILED:
    'A fresh auth preflight did not pass, so no agent could have run. Nothing was started\n' +
    '  and no branch was created. Log the agent CLIs in and invoke again.',
  WORKSPACE_COLLISION:
    'Something already occupies the branch, path or worktree registry entry for this task,\n' +
    '  and it was tested for adoption and refused. The second reason code says which proof\n' +
    '  failed: the workspace is not this task\'s own untouched leftovers.',
  WORKSPACE_REFUSED: 'Workspace preparation was refused. Nothing was started.',
  STATE_UNUSABLE:
    'A durable record exists but is unusable here: broken, or an intact record of somewhere else.',
  STATE_NOT_RECORDED:
    'The workspace was created and the first durable write was then refused, so a worktree\n' +
    '  exists that no task state accounts for. It is reported rather than deleted.',
  EXECUTION_LEASE_LOST:
    'This invocation held the execution lease when it began and does not hold it now, so\n' +
    '  the first durable state was not written. Whatever it created and had not already\n' +
    '  removed is still there and nothing records it - a worktree, a branch, or only the\n' +
    '  branch, which is the one most easily walked past. See Residue below, and look\n' +
    '  before deleting: another invocation may own these now.',
  EXECUTION_LEASE_NOT_HELD:
    'This invocation does not hold this repository\'s execution lease, so it may not create\n' +
    '  a branch, a worktree or a durable record here. Nothing was created and nothing was\n' +
    '  written. It may have read the plan and run the authentication preflight first: this\n' +
    '  is refused at the entrance and again immediately before anything would be created,\n' +
    '  and the second refusal is the one that matters, because the lease can go while the\n' +
    '  preflight runs. `agent-loop lease status` reports what is actually there.',
});

/** The one label/value shape every report line uses. Shared with the command. */
export function line(label: string, value: string): string {
  return `${label.padEnd(13)}: ${value}`;
}

function codes(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

/** How wide a wrapped sentence may be, indent included. */
const SENTENCE_WIDTH = 92;

/**
 * One sentence as indented console lines, wrapped on spaces.
 *
 * Every other sentence in this file is hand-wrapped inside its own constant, and
 * these are not, because they come from `core/usage-limit-continuation.ts` —
 * where they sit beside the readings they belong to, so that a reading and its
 * sentence cannot be edited apart. A table that has to be laid out for a
 * particular console width would be a table shaped by its renderer.
 *
 * Words longer than the budget are emitted on a line of their own rather than
 * broken: none of these sentences contains one, and a renderer that split a
 * closed code in half would be inventing a value.
 */
function wrapped(sentence: string): readonly string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of sentence.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length + 2 > SENTENCE_WIDTH && current !== '') {
      lines.push(`  ${current}`);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(`  ${current}`);
  return lines;
}

/**
 * Renders the start half of an attended run.
 *
 * `residue` is printed whenever it is set, and it is the reason this is a field
 * on the result rather than something a caller infers: an operator whose
 * repository now contains a worktree nothing accounts for has to be told by the
 * thing that made it.
 */
export function renderStartResult(result: StartTaskResult): string {
  const lines = [
    line('Start', result.outcome),
    `  ${START_OUTCOME_SENTENCES[result.outcome]}`,
  ];
  if (result.reasonCodes.length > 0) lines.push(line('Reasons', codes(result.reasonCodes)));
  if (result.workspace !== null) {
    lines.push(
      line('Worktree', result.workspace.worktreePath),
      line('Branch', `${result.workspace.workBranch}  (from ${result.workspace.baseBranch})`),
      line('Base commit', result.workspace.basePinnedCommit),
    );
  }
  if (result.residue) {
    lines.push(
      line('Residue', 'yes'),
      '  Something exists on disk that no durable state accounts for. Nothing was removed:',
      '  deleting a path this code has just failed to reason about is not what this build does.',
    );
  }
  return lines.join('\n');
}

/** Renders the drive half of an attended run. */
export function renderRunResult(result: RunResult): string {
  const lines = [
    line('Run', result.outcome),
    line('State', result.state ?? 'none reached'),
    line('Steps', String(result.steps)),
  ];
  if (result.reconciliation !== null) {
    lines.push(line('Reconcile', result.reconciliation.outcome));
  }
  if (result.resume !== null) {
    lines.push(line('Continuation', `${result.resume.continuation}  (${result.resume.classification})`));
  }
  lines.push(line('Reasons', codes(result.reasonCodes)));
  // How a quota block was read, and only for a run that met one.
  //
  // Two lines rather than a code, because the code alone answers the wrong
  // question. An operator standing in front of a `BLOCKED_USAGE_LIMIT` wants to
  // know whose task it is now — the scheduler's, the automatic path's, or
  // theirs — and `--continue-usage-limit`'s help promises that `run --task <id>`
  // says which. The sentence is the promise being kept; the reading beside it is
  // what a report can be grepped for.
  if (result.usageLimitContinuation !== null) {
    lines.push(
      line('Quota decision', result.usageLimitContinuation),
      ...wrapped(USAGE_LIMIT_CONTINUATION_SENTENCES[result.usageLimitContinuation]),
    );
  }
  // What became of this run's attempt to make a verification failure durable.
  //
  // Only on a run that produced one, so a clean run gains no line — and the
  // rendering is deliberately asymmetric. A *recorded* attempt gets one line
  // naming where it went, because the whole report of it is `run --task <id>`'s
  // to print, from the disk, on any later invocation. A **failed** recording
  // gets three, because it is the one condition an operator can never read
  // afterwards: the store code is not persisted anywhere — `TaskState` is
  // `.strict()` and has no field for it — so this run is the only place it is
  // ever said. Losing it here would reproduce, one level up, exactly the
  // silence this change exists to remove.
  const evidence = result.lastStep?.verificationEvidence ?? null;
  if (evidence !== null) {
    if (evidence.recorded) {
      lines.push(line('Verify log', `recorded  (${evidence.code})`));
      if (evidence.path !== null) lines.push(`  ${evidence.path}`);
    } else {
      lines.push(
        line('Verify log', `NOT recorded  (${evidence.code})`),
        '  The verification result was not durably explained, so this run did not write',
        '  BLOCKED_VERIFY on the strength of it. This code is reported here and nowhere',
        '  else — no later invocation can tell you what it was.',
      );
    }
  }
  // Only when there were any. A clean run must not gain a noise line, and an
  // operator who never sees this line has been told something by its absence.
  //
  // Count and distinct tool names, and nothing else: `tool_input` carries file
  // paths and command lines the agent chose, which is exactly the foreign free
  // text this renderer's opening rule excludes. What an operator needs is "the
  // writer reached for authority it did not have, and here is which" — the rest
  // is in the worktree.
  if (result.permissionDenials.count > 0) {
    lines.push(
      line(
        'Denials',
        `${result.permissionDenials.count}  (${codes(result.permissionDenials.tools)})`,
      ),
    );
  }
  return lines.join('\n');
}

/*
 * `renderAttendedRun` — the whole-report function — lived here until V3-06 and
 * was removed with the rewiring that orphaned it. `cli/run-command.ts` now goes
 * through `driveLifecycle` and reports with `renderLifecycleRun`, which composes
 * the three pieces above rather than replacing them.
 *
 * It had no tests of its own to lose. What covered it was, and still is,
 * `tests/v2-05-attended-cli.test.ts`, which drives the real command and asserts
 * on stdout — so it covered whichever renderer the command used, and it covers
 * the new one unchanged. (A note here briefly claimed the deletion would
 * otherwise have stranded "its tests, the secret- and path-discipline ones
 * included". `git grep renderAttendedRun` at the base commit returns four hits,
 * all in `src/`.)
 */
