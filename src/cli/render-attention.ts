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
 * *Raised* is what this invocation newly wrote down. It is a subset of the open
 * set and it is what makes repeated passes quiet: the second pass over an
 * unchanged repository raises nothing and prints the same open list.
 *
 * *Raised* is deliberately **not** what was sent. Since M4 a pass announces every
 * open item that carries no delivery receipt, which includes items an earlier
 * pass raised and failed to send — see `notify/attention-notification.ts` for
 * why `U2` required that. So the delivery lines below talk about items awaiting
 * delivery rather than about newly raised ones, and the two counts can differ.
 *
 * The delivery line is deliberately explicit about what "notification" means
 * here, because the honest answer is layered: a durable file always, a push only
 * where an operator configured one. A report that said "notified" without saying
 * which would be claiming a delivery that may not have happened.
 */

import { USAGE_LIMIT_CONTINUATION_SENTENCES } from '../core/usage-limit-continuation.js';
import type { AttentionPushResult } from '../notify/attention-notification.js';
import type { NotifyConfigRefusal } from '../notify/notify-config.js';
import type { AttentionSettlement } from '../notify/attention-outbox.js';
import type { AttentionListing, AttentionRecord } from '../notify/attention-store.js';
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
  DELIVERED: 'Every item still awaiting delivery reached the configured endpoint.',
  PARTIALLY_DELIVERED:
    'Some items awaiting delivery reached the configured endpoint and some did not. All of them ' +
    'are recorded either way, and the ones that did not are tried again on the next pass for as ' +
    'long as their condition stands.',
  FAILED:
    'Nothing reached the configured endpoint. The items above are recorded and discoverable ' +
    'with `agent-loop attention`, and are tried again on the next pass.',
} as const;

/**
 * What a failed send across the whole run means. Pinned by test.
 *
 * It says "attempts" rather than "items" on purpose: one item refused on three
 * cycles and accepted on the fourth is three failed attempts and no lost
 * notification, and the sentence must not read as though something never
 * arrived when the retry is exactly what this design relies on.
 */
export const DELIVERY_ACROSS_RUN_SENTENCE =
  'Some attempts during this run did not reach the endpoint. An item that arrived later carries ' +
  'a receipt and is not listed above; one that never arrived is still open above if its ' +
  'condition still holds, and was removed with its record if the condition cleared — so a run ' +
  'that ends here may have had something to say that nobody heard.';

/** What the per-pass announcement bound means. Pinned by test. */
export const DELIVERY_BOUND_SENTENCE =
  'One pass offers a bounded number of items to the endpoint, so a large backlog goes out over ' +
  'several passes. The remainder keeps its records and carries no receipt, and the next pass ' +
  'offers it — unless this was the last pass, in which case nobody was told about it at all.';

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
  rows.push('', line('Delivery', push.outcome), `  ${ATTENTION_PUSH_SENTENCES[push.outcome]}`);

  // Failures are accumulated over every pass, and the outcome above is the last
  // pass's. Both used to be read from `reports.at(-1)`, and that erased an
  // outage completely: an endpoint down for a whole night failed on every cycle,
  // then the last cycle found nothing left to send, so the report ended on
  // `NOTHING_TO_SEND` — "Nothing new was raised, so nothing was sent." — with no
  // failure row at all. If the conditions had cleared meanwhile their records
  // were gone too, so `agent-loop attention` said nothing either, and the run
  // that printed `Notifications: ARMED` at minute zero finished without one word
  // contradicting it. A report that cannot contradict the promise made before
  // the silence is worse than no report.
  const attempted = reports.reduce((total, report) => total + report.push.attempted, 0);
  const arrived = reports.reduce((total, report) => total + report.push.delivered, 0);
  if (attempted > arrived) {
    const codes = [...new Set(reports.flatMap((report) => [...report.push.failures]))].sort();
    rows.push(
      line('Failed sends', `${String(attempted - arrived)} of ${String(attempted)} this run`),
      `  ${DELIVERY_ACROSS_RUN_SENTENCE}`,
    );
    if (codes.length > 0) rows.push(line('Send failures', codes.join(', ')));
  }

  // The backlog one pass could not offer. `settleAttention` bounds a single
  // pass at `MAX_ANNOUNCED_ITEMS_PER_SETTLE` and records the true count beside
  // it, saying of that count that "the bound must never make that number look
  // smaller than it is" — and then no renderer printed it. Sixteen items pushed
  // out of twenty read as `DELIVERED`, "Every item still awaiting delivery
  // reached the configured endpoint", beside `Open : 20`. On any pass but the
  // last the remainder goes out next time; on the last one it never does.
  const backlog = last.settlement.undeliveredTotal;
  const offered = last.settlement.undelivered.length;
  if (backlog > offered) {
    rows.push(
      line('Not offered', `${String(backlog - offered)} of ${String(backlog)} awaiting delivery`),
      `  ${DELIVERY_BOUND_SENTENCE}`,
    );
  }

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

/* ═════════════════ the store as a reader sees it (M4, `U2`) ═══════════════ */

/**
 * One sentence per condition the store itself can be in.
 *
 * Separate from the item list because they are different claims. The items say
 * what is open; these say whether the list can be believed — and "the store
 * could not be read" must never render as "nothing is open", which is the one
 * confusion that would make this report worse than no report.
 */
export const ATTENTION_STORE_SENTENCES = {
  ABSENT:
    'no outbox exists on this machine yet, which is ordinary — nothing has ever needed you',
  UNREADABLE_ROOT:
    'the outbox directory exists and could not be read, so this list is not an answer about ' +
    'what is open',
  READ: 'the outbox was read in full',
} as const;

export type AttentionStoreReading = keyof typeof ATTENTION_STORE_SENTENCES;

/** Which of the three readings this listing is. Total, and derived not guessed. */
export function attentionStoreReading(listing: AttentionListing): AttentionStoreReading {
  if (listing.unreadableRoot) return 'UNREADABLE_ROOT';
  if (listing.absent) return 'ABSENT';
  return 'READ';
}

/**
 * The whole `agent-loop attention` report.
 *
 * Always a string, never `null`. The scheduler's section is omitted when there
 * is nothing to say because it is a *part* of a larger report; this one is the
 * whole answer to a question somebody asked, and answering "nothing" out loud is
 * the point of asking.
 *
 * The undelivered set is printed as its own list rather than as a flag on each
 * item, because it is the thing an operator came to find out and a flag column
 * is something they would have to scan for. An item can appear in both lists;
 * that is not duplication, it is one condition seen through two questions.
 */
export function renderAttentionStore(listing: AttentionListing): string {
  const reading = attentionStoreReading(listing);
  const delivered = new Set(listing.delivered);
  const undelivered = listing.records.filter((record) => !delivered.has(record.attentionId));

  const lines = [
    '',
    line('Outbox', reading),
    `  ${ATTENTION_STORE_SENTENCES[reading]}`,
    line('Open', String(listing.records.length)),
    line('Not delivered', String(undelivered.length)),
  ];

  if (listing.foreignNames > 0 || listing.unreadable > 0) {
    lines.push(
      line('Not ours', `${String(listing.foreignNames)} named, ${String(listing.unreadable)} unreadable`),
      '  files in the outbox this build did not write or could not read back. Left alone.',
    );
  }

  if (listing.records.length > 0) {
    lines.push('', 'Open items', ...listing.records.map(renderRecord));
  }

  if (undelivered.length > 0) {
    lines.push(
      '',
      'Not delivered to any endpoint',
      '  These were written down and no notification endpoint has acknowledged them. A recurring',
      '  invocation retries them on every pass, so this list emptying is the retry working, and',
      '  this list standing while a pass runs means the endpoint is refusing or none is set up.',
      ...undelivered.map(renderRecord),
    );
  }

  return `${lines.join('\n')}\n\n`;
}

/* ══════════ readiness, printed before a recurring run goes quiet ══════════ */

/**
 * One sentence per notification-readiness state. Total; pinned by test.
 *
 * These are about the *future* and the push sentences above are about the past,
 * which is why they are a second table rather than a reuse of the first. An
 * operator reading `NOT_CONFIGURED` here has not yet missed anything; the same
 * word in the push report means something already went unsent.
 */
export const NOTIFICATION_READINESS_SENTENCES = {
  ARMED:
    'a notification endpoint is configured, so anything that needs you during this run is sent ' +
    'to it as soon as the pass that found it ends',
  NOT_CONFIGURED:
    'no notify.yaml exists under your orchestrator home, so nothing will be sent anywhere. ' +
    'Items are still recorded and readable with `agent-loop attention`.',
  CONFIG_UNUSABLE:
    'a notification configuration exists and could not be used, so nothing will be sent ' +
    'anywhere. Items are still recorded and readable with `agent-loop attention`.',
} as const;

export type NotificationReadiness = keyof typeof NOTIFICATION_READINESS_SENTENCES;

/**
 * What a waiting invocation prints **before** its first pass.
 *
 * The reason this exists is a promise the code made and did not keep. Until this
 * function a recurring invocation printed nothing until it ended, and the only
 * place the notifier's state reached an operator was {@link renderAttention},
 * written after the scheduler returned — so on a run that waits, "an operator
 * with a broken notify.yaml is told while they are still standing there" was
 * true of the *construction* and false of the *telling*.
 *
 * "Told at the end" is the charitable reading of what it did, and it is not the
 * whole of it. {@link renderAttention} returns `null` when nothing was open,
 * raised, resolved, noted, refused, foreign or unreadable, so a run that needed
 * nobody printed the state **never**; and `pushAttentionItems` answers
 * `NOTHING_TO_SEND` before it looks at `notifier.state` at all, so even a
 * rendered section said nothing about the configuration on a pass with no
 * pending items. An operator could therefore run an unattended night against an
 * unusable `notify.yaml` and be told nothing, at any point, by anything.
 *
 * The refusal code is printed and nothing else is. `notify-config.ts` refuses a
 * file without ever carrying the file, the path, the endpoint or the token into
 * its refusal, and `NOTIFY_CONFIG_REFUSALS` is that closed vocabulary; printing
 * the code is therefore printing a word from a fixed list, not a fragment of
 * somebody's configuration.
 */
export function renderNotificationReadiness(notifier: {
  readonly state: NotificationReadiness;
  readonly configCode: NotifyConfigRefusal | null;
}): string {
  // The code is appended to the state rather than given its own row, so the one
  // thing an operator scans for — the word after `Notifications` — is on one
  // line whichever state they are in.
  const value =
    notifier.state === 'CONFIG_UNUSABLE' && notifier.configCode !== null
      ? `${notifier.state}  ${notifier.configCode}`
      : notifier.state;

  return `${line('Notifications', value)}\n  ${NOTIFICATION_READINESS_SENTENCES[notifier.state]}\n`;
}
