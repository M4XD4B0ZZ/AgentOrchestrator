/**
 * Console rendering for the operator-attention outbox (M3-02).
 *
 * Same discipline as every other renderer here: only values that have already
 * passed a validating boundary appear. Task ids, the repository's declared
 * identity, closed vocabulary codes, ISO instants the state contract validated,
 * and one action sentence out of `core/task-attention.ts`'s fixed table. No
 * agent output, no verifier output, no exception text.
 *
 * ── Two things are printed, and they are different claims ──────────────────
 *
 * *Open* is what this invocation's **last pass found**: every condition, across
 * the repositories it read, that needs a person. It is derived from durable
 * state rather than listed from the store, so it is neither more nor less than
 * what is true right now about those repositories — and it deliberately says
 * nothing about a repository this invocation did not look at, or could not read,
 * whose items are still in the store and are neither shown nor removed.
 *
 * *Raised* is what this invocation newly wrote down and, where a notification
 * endpoint was configured, said out loud. It is a subset of the open set and it
 * is what makes repeated passes quiet: the second pass over an unchanged
 * repository raises nothing and prints the same open list.
 *
 * The delivery line is deliberately explicit about what "notification" means
 * here, because the honest answer is layered: a durable file always, a push only
 * where an operator configured one. A report that said "notified" without saying
 * which would be claiming a delivery that may not have happened.
 */

import { USAGE_LIMIT_CONTINUATION_SENTENCES } from '../core/usage-limit-continuation.js';
import type { AttentionPushResult } from '../notify/attention-notification.js';
import type { AttentionSettlement } from '../notify/attention-outbox.js';
import type { AttentionRecord } from '../notify/attention-store.js';
import { line } from './render-attended-run.js';

/** What one settle-and-announce produced. Accumulated per cycle by the command. */
export interface AttentionReport {
  readonly settlement: AttentionSettlement;
  readonly push: AttentionPushResult;
}

/** One sentence per scan note. Total; pinned by test. */
export const ATTENTION_SCAN_NOTE_SENTENCES = {
  RUNTIME_DIRECTORY_ABSENT:
    'a repository has no runtime directory, which is ordinary — nothing has run there yet',
  RUNTIME_DIRECTORY_UNREADABLE:
    'a runtime directory exists and could not be read, so anything needing you in it is ' +
    'invisible here',
  STATE_UNREADABLE:
    'a task state file could not be read as a task state, so it was not judged at all',
  SCAN_TRUNCATED:
    'a repository holds more task state files than one scan reads, so the tail was not judged',
} as const;

/** One sentence per push outcome. Total; pinned by test. */
export const ATTENTION_PUSH_SENTENCES = {
  NOTHING_TO_SEND: 'Nothing new was raised, so nothing was sent.',
  NOT_CONFIGURED:
    'No notification endpoint is configured on this machine, so the items above are recorded ' +
    'and were not sent anywhere. That is the default: nothing leaves this machine without a ' +
    'notify.yaml under your orchestrator home.',
  CONFIG_UNUSABLE:
    'A notification configuration exists and could not be used, so nothing was sent. The items ' +
    'above are recorded either way.',
  DELIVERED: 'Every newly raised item was also sent to the configured endpoint.',
  PARTIALLY_DELIVERED:
    'Some newly raised items reached the configured endpoint and some did not. All of them are ' +
    'recorded; a send is never retried, so the ones that failed were said once and only here.',
  FAILED:
    'Nothing reached the configured endpoint. The items above are recorded and discoverable; ' +
    'a send is never retried.',
} as const;

/**
 * One item, printed.
 *
 * Two shapes, because the two subjects are two different things to say. A
 * repository item is headed by the repository alone and has no `state` and no
 * `since`: it is a condition of the repository *now*, and there is no instant it
 * entered — inventing one out of `observedAt` would print the time this
 * invocation looked as though it were the time the condition began.
 *
 * The tail rows are shared and in the same order in both, because `item` and
 * `do` are what an operator acts on and they must not move depending on which
 * kind of item they are reading.
 */
function renderRecord(record: AttentionRecord): string {
  const rows: string[] =
    record.subject === 'REPOSITORY'
      ? [
          `  ${record.repositoryId}`,
          `    condition       : ${record.condition}`,
          `    reason          : ${record.reason}`,
        ]
      : [
          `  ${record.repositoryId} / ${record.taskId}`,
          `    state           : ${record.state}`,
          `    reason          : ${record.reason}`,
        ];

  if (record.subject === 'TASK') {
    if (record.detail !== null) {
      rows.push(
        `    reading         : ${record.detail}`,
        `      ${USAGE_LIMIT_CONTINUATION_SENTENCES[record.detail]}`,
      );
    }
    if (record.reportedResetAt !== null) {
      rows.push(`    reported reset  : ${record.reportedResetAt}`);
    }
    rows.push(`    since           : ${record.stateEnteredAt}`);
  }

  rows.push(
    `    item            : ${record.attentionId}`,
    `    do              : ${record.action}`,
  );
  return rows.join('\n');
}

/**
 * The whole attention section, or `null` when there is nothing to say.
 *
 * `null` rather than an empty heading: a scheduler run over repositories that
 * all needed nothing must not gain a section announcing that, for the same
 * reason `renderRunResult` prints no denials line when there were none. An
 * operator who never sees this section has been told something by its absence.
 */
export function renderAttention(reports: readonly AttentionReport[]): string | null {
  const last = reports.at(-1);
  if (last === undefined) return null;

  // The open set is the *last* settle's view, because that is the state the
  // store is actually in now. Earlier cycles' views are history, and printing
  // them would show items a later cycle has already resolved.
  const open = last.settlement.scan.items.map((item) => item.record);

  // Raised is accumulated across every cycle, because an item raised in cycle 1
  // and resolved in cycle 3 still happened and the operator may have been sent
  // it. De-duplicated by identity: the same item cannot be raised twice, so a
  // repeat here would be a defect rather than a second event.
  const raisedById = new Map<string, AttentionRecord>();
  for (const report of reports) {
    for (const record of report.settlement.raised) raisedById.set(record.attentionId, record);
  }

  const resolved = reports.reduce((total, report) => total + report.settlement.resolved, 0);
  const notes = new Set(reports.flatMap((report) => [...report.settlement.scan.notes]));
  const refusals = reports.flatMap((report) => [...report.settlement.refusals]);
  const foreign = last.settlement.foreign;

  if (
    open.length === 0 &&
    raisedById.size === 0 &&
    resolved === 0 &&
    notes.size === 0 &&
    refusals.length === 0 &&
    foreign === 0 &&
    !last.settlement.storeUnreadable
  ) {
    return null;
  }

  const rows: string[] = ['', 'Needs an operator'];
  rows.push(
    line('Open', String(open.length)),
    line('Raised now', String(raisedById.size)),
    line('Resolved', String(resolved)),
  );

  for (const record of open) rows.push('', renderRecord(record));

  if (notes.size > 0) {
    rows.push('');
    for (const note of [...notes].sort()) {
      rows.push(`  note            : ${note} — ${ATTENTION_SCAN_NOTE_SENTENCES[note]}`);
    }
  }

  if (refusals.length > 0) {
    rows.push(
      '',
      line('Not recorded', refusals.join(', ')),
      '  An item was found and could not be written down. It is not lost: the condition is in',
      '  the task’s own durable state, so the next pass finds it again and tries again.',
    );
  }

  if (foreign > 0) {
    rows.push(
      '',
      line('Unreadable', String(foreign)),
      '  Files in the attention store this build did not write or cannot read. They were left',
      '  alone: this store removes only records whose condition it has positively re-derived.',
    );
  }

  if (last.settlement.storeUnreadable) {
    rows.push(
      '',
      line('Store', 'UNREADABLE'),
      '  The attention store could not be enumerated, so nothing could be resolved and the open',
      '  list above may be short. Items still needing you are in the task records themselves.',
    );
  }

  const push = last.push;
  rows.push(
    '',
    line('Delivery', push.outcome),
    `  ${ATTENTION_PUSH_SENTENCES[push.outcome]}`,
  );
  if (push.failures.length > 0) rows.push(line('Send failures', push.failures.join(', ')));
  if (push.configCode !== null) rows.push(line('Config', push.configCode));

  rows.push('', ATTENTION_TRAILER, '');
  return rows.join('\n');
}

/**
 * What the outbox is answerable for, stated once.
 *
 * Every clause is a property the build holds structurally rather than a promise
 * about behaviour: the durability claim is true because the record is a file
 * created before anything is sent, and the de-duplication claim is true because
 * the file's name is a digest of the condition and the create is exclusive.
 */
export const ATTENTION_TRAILER =
  'Each item above is a file under your orchestrator home, named after the condition it ' +
  'describes, and it is written before anything is sent anywhere — so an item exists whether ' +
  'or not a notification endpoint is configured, and it survives this process dying. Repeated ' +
  'passes over an unchanged task raise nothing: the name is already taken, and that is the ' +
  'whole of the de-duplication. An item is removed when the condition behind it is gone, which ' +
  'this invocation checks by re-reading the task’s own durable state — never by being told. A ' +
  'task that leaves a human-action state and later returns to one through a new event is a new ' +
  'item, deliberately.';
