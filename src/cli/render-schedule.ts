/**
 * The scheduler's report (M3-01).
 *
 * ── Why the reported instant is printed, and printed verbatim ──────────────
 *
 * No renderer in this build has ever printed `reportedResetAt`. The read-only
 * plan says `RESET_TIME_NOT_REACHED` among its reasons, which tells an operator
 * *that* a task is waiting and never *until when*. For a scheduler that is not
 * enough: the whole claim of this slice is that a **fresh process reconstructed
 * a wait from disk**, and the only way to show that rather than assert it is to
 * print the instant it read and the repository and task it read it from.
 *
 * It is printed exactly as the durable record spells it — no reformatting, no
 * local rendering, no "in 3 hours". A local wall-clock rendering of a stored
 * instant is precisely the thing `codex-quota-signal.ts` refuses to let into the
 * durable contract, and a report that invented one would put it back in front of
 * the operator instead.
 *
 * ── What the report is answerable for ──────────────────────────────────────
 *
 * Three questions, in order: what did each pass do, what did the scheduler then
 * read from disk, and what did it do about it. The first is
 * `renderCrossRepositoryRun`'s and is reused rather than restated — a second
 * spelling of an admission row would be a second thing to keep true.
 */

import type {
  SchedulerCycle,
  SchedulerDisposition,
  SchedulerResult,
} from '../schedule/scheduler.js';
import type { WakeScanNote } from '../schedule/durable-wake.js';
import { renderCrossRepositoryRun } from './render-repositories.js';

/**
 * One sentence per disposition. Total; pinned by test.
 *
 * Each says what happened and, where an operator can act, what to do. None
 * claims anything about a quota window: this build reports what an agent CLI
 * recorded and never asserts when an allowance actually returns.
 */
export const SCHEDULER_DISPOSITION_SENTENCES = {
  NOT_REQUESTED:
    'Waiting was not requested, so this invocation made a single pass and stopped. Add ' +
    '--wait-for-reset with --max-wait-ms and --max-cycles to have it wait out a recorded quota ' +
    'reset and plan again.',
  NO_FUTURE_WAKE:
    'No enlisted repository records a quota reset still ahead, so there was nothing to wait ' +
    'for and nothing slept. That covers three cases this report does NOT tell apart, because ' +
    'each is an ordinary record rather than a problem and none produces a note: nothing is ' +
    'blocked, a block records no reset time, and a recorded reset has already passed. ' +
    '`agent-loop repositories` names the blocked tasks. A note above, if there is one, is a ' +
    'fourth possibility — a scan that could not read everything may have missed a nearer wake.',
  BOUND_EXCEEDED:
    'The earliest recorded reset is further away than --max-wait-ms permitted, so nothing ' +
    'slept. Invoke again nearer the time, or raise the bound. The wait itself is unchanged and ' +
    'still on disk: nothing here consumed it.',
  // Two shapes end here, and the sentence has to cover both: a recorded reset
  // still ahead, and — with --idle-poll-ms — an interval that would have looked
  // again. The first spelling asserted the reset, which is a sentence an idle
  // run makes false every time it ends normally.
  CYCLE_BUDGET_SPENT:
    '--max-cycles was spent while there was still something to come back for: a recorded reset ' +
    'still ahead, or the idle interval you asked for. Nothing was lost — a recorded wait is ' +
    'durable — and invoking again reconstructs it from the same state.',
  SHUTDOWN_REQUESTED:
    'A shutdown was requested and the scheduler stopped without planning further. No execution ' +
    'lease was held while it waited, so the durable state is exactly what the last completed ' +
    'pass left; invoking again reconstructs the wait.',
  CURRENT_TIME_UNPARSEABLE:
    'The system clock produced something this build could not read as a timestamp, so no wait ' +
    'was computed. Nothing was held and nothing was written.',
  SLEEP_BUDGET_SPENT:
    'The wait outlived the number of intervals it was budgeted, which happens when the system ' +
    'clock advances more slowly than the sleeps this build asked for — stopped, slewed, or ' +
    'stepped backwards. Nothing was held and nothing was written; invoking again re-reads the ' +
    'same durable state.',
  REGISTRY_UNUSABLE_AFTER_WAIT:
    'The wait completed and the repository registry could not be read again afterwards, so no ' +
    'further pass was made. The registry is read fresh after every wait on purpose: a ' +
    'repository may be enlisted, withdrawn or moved while this process is asleep.',
  LEASE_RELEASE_UNPROVEN:
    'A pass ended without showing that every repository it drove had been given back, so ' +
    'nothing slept. Sleeping on that would make this process a possible writer of that ' +
    'repository for as long as the wait lasts, with a living owner in its lease document — ' +
    'which refuses every other invocation and refuses stale recovery too. The admission that ' +
    'could not be shown to have released is named above; `agent-loop lease status` in that ' +
    'repository says what is there.',
  WAITED:
    'The scheduler was still waiting when this report was produced, which it should never be. ' +
    'Treat it as a defect in the scheduler rather than as a statement about the work.',
  MATURED_DURING_PASS:
    'The scheduler was still mid-cycle when this report was produced, which it should never be. ' +
    'Treat it as a defect in the scheduler rather than as a statement about the work.',
  WAIT_BOUND_UNUSABLE:
    '--max-wait-ms is not a bound this build will sleep on, so nothing was planned and nothing ' +
    'ran. Invoking again with the same value repeats exactly.',
  CYCLE_BOUND_UNUSABLE:
    '--max-cycles is not a bound this build will schedule on, so nothing was planned and ' +
    'nothing ran. Invoking again with the same value repeats exactly.',
  IDLE_POLLED:
    'The scheduler was still between idle passes when this report was produced, which it ' +
    'should never be. Treat it as a defect in the scheduler rather than as a statement about ' +
    'the work.',
  IDLE_POLL_BOUND_UNUSABLE:
    '--idle-poll-ms is not an interval this build will sleep on, so nothing was planned and ' +
    'nothing ran. Invoking again with the same value repeats exactly.',
} as const satisfies Record<SchedulerDisposition, string>;

/** One sentence per scan note. Total; pinned by test. */
export const WAKE_SCAN_NOTE_SENTENCES = {
  CURRENT_TIME_UNPARSEABLE:
    'the clock did not produce a timestamp, so no durable state was read at all',
  RUNTIME_DIRECTORY_ABSENT:
    'a repository has no runtime directory, which is ordinary — nothing has run there yet',
  RUNTIME_DIRECTORY_UNREADABLE:
    'a runtime directory exists and could not be read, so any wait recorded in it is invisible here',
  STATE_UNREADABLE:
    'a task state file could not be read as a task state, so it contributed no wait',
  RESET_TIME_UNPARSEABLE:
    'a recorded reset time is not a timestamp this build can read, so it contributed no wait',
  SCAN_TRUNCATED:
    'a repository holds more task state files than one scan reads, so a nearer wait may not have been seen',
} as const satisfies Record<WakeScanNote, string>;

function line(label: string, value: string): string {
  return `${label.padEnd(16)}: ${value}`;
}

/**
 * The most future wakes listed before the report summarises the rest.
 *
 * A bound of the same kind `render-repositories.ts` applies to blocked tasks,
 * and for the same reason: a large registry would otherwise turn one line of
 * information into hundreds. What is dropped is counted out loud.
 */
export const MAX_REPORTED_WAKES = 8;

function renderCycle(entry: SchedulerCycle, total: number): string {
  const rows: string[] = [
    '',
    `── cycle ${String(entry.sequence)} of ${String(total)} ──`,
    renderCrossRepositoryRun(entry.run).replace(/\n+$/, ''),
    '',
    line('Durable wakes', String(entry.scan.future.length)),
    line('States read', String(entry.scan.statesRead)),
  ];

  for (const wake of entry.scan.future.slice(0, MAX_REPORTED_WAKES)) {
    rows.push(
      `    ${line('waits until', wake.resetAt)}`,
      `    ${line('task', wake.taskId)}`,
      `    ${line('root', wake.repositoryRoot)}`,
      '',
    );
  }
  if (entry.scan.future.length > MAX_REPORTED_WAKES) {
    rows.push(
      `    … and ${String(entry.scan.future.length - MAX_REPORTED_WAKES)} more, not listed`,
      '',
    );
  }

  for (const note of entry.scan.notes) {
    rows.push(`    note            : ${note} — ${WAKE_SCAN_NOTE_SENTENCES[note]}`);
  }

  rows.push(line('Scheduler', entry.disposition));
  if (entry.wake !== null) {
    rows.push(line('Earliest wake', `${entry.wake.resetAt}  (${entry.wake.taskId})`));
  }
  if (entry.waitedMs !== null) {
    // "wall clock" is not decoration. This is the difference between two
    // readings of the same clock, so a clock that moved during the wait moves
    // this number with it — a backward step deflates it and can make it
    // negative. An earlier comment claimed a step "shows up here rather than
    // being hidden"; on the successful path it is hidden, which is why the
    // number now says what it is rather than being read as elapsed time.
    rows.push(line('Waited', `${String(entry.waitedMs)} ms of wall clock`));
  }
  return rows.join('\n');
}

/**
 * The scheduler's whole report.
 *
 * The registry head is the caller's — this renderer is handed the run and says
 * nothing about where the registry lives.
 */
export function renderScheduler(result: SchedulerResult): string {
  const rows: string[] = [];
  for (const entry of result.cycles) rows.push(renderCycle(entry, result.cycles.length));

  rows.push('', line('Ending', result.ending));
  if (result.registryRefusal !== null) {
    rows.push(line('Registry', result.registryRefusal));
  }
  rows.push('', SCHEDULER_DISPOSITION_SENTENCES[result.ending], '', SCHEDULER_TRAILER, '');
  return rows.join('\n');
}

/**
 * What the scheduler is answerable for, stated once.
 *
 * Every clause here is a property the build holds structurally, not a promise
 * about behaviour: the lease claim is true because a coordinator pass returns
 * only after every admission has settled and released, and the durability claim
 * is true because the wake is recomputed from disk at every wait.
 */
export const SCHEDULER_TRAILER =
  'While it waits, this invocation holds no execution lease, runs no agent, prepares no ' +
  'workspace and writes no task state: the wait sits entirely between coordinator passes, and ' +
  'nothing sleeps until every repository the pass drove has been SHOWN to have given its ' +
  'lease back — an admission that threw, or that ends unable to say it released, stops the ' +
  'invocation instead. The wait ' +
  'itself is not stored anywhere — it is re-read from each task’s own durable state before ' +
  'every sleep — so stopping this process loses nothing, and invoking it again reconstructs ' +
  'the same wait without being told which task or which instant. A quota block the machine ' +
  'cannot wait out — one that records NO reset time, or one whose reset has passed over a ' +
  'withdrawn resume record — is never scheduled here and stays the operator’s: `agent-loop run ' +
  '--repository <path> --task <id> --attended --continue-usage-limit`. Any such block found ' +
  'while waiting is written into the operator-attention outbox, which the section below this ' +
  'report prints when there is one.';
