/**
 * Saying an open attention item out loud, when the operator asked to be told
 * (M3-02).
 *
 * ── The durable record is the notification; this is the doorbell ───────────
 *
 * `notify/attention-store.ts` is the sink. It is always written, it survives a
 * restart, and an operator can read it whether or not anything was configured.
 * This module is the optional second thing: one bounded POST to the operator's
 * own ntfy topic, so that somebody who is not watching a terminal finds out
 * while it still matters.
 *
 * The ordering follows from which of the two is load-bearing. The record is
 * written **first**, and the push follows it. A process that dies in between
 * leaves an item that is discoverable and was never announced, which is a delay
 * rather than a loss.
 *
 * ── What M4 changed, and why it had to (`U2`) ──────────────────────────────
 *
 * Until M4 only a record this call had just *created* was ever pushed, and this
 * header recorded the consequence as a stated limit: a send that failed was said
 * once, into nothing, and no later pass re-announced it because the name was
 * already taken. The closing audit called that `U2` — "a failed notification is
 * indistinguishable from a silent run" — and marked it fatal to unsupervised
 * running, because for an operator who is not watching a console, a quiet phone
 * then carries no information at all.
 *
 * The repair is a second exclusive create. A successful send writes a **delivery
 * receipt** beside the record, and what a pass pushes is now every open item
 * that has no receipt — not every item it newly raised. So:
 *
 *  - a send that failed is retried on the next cycle, and the one after, for as
 *    long as the condition stands;
 *  - and the set of items that were written down and never acknowledged is a
 *    fact on disk that `agent-loop attention` prints, rather than the absence of
 *    a fact.
 *
 * That is what makes silence mean something. It is deliberately **not** an
 * acknowledgement by a person: a receipt says an endpoint accepted the message,
 * and nothing in this build claims anybody read it.
 *
 * The receipt is written the instant the endpoint answers, inside the loop
 * rather than after it, so a crash mid-batch loses at most the one item in
 * flight. A mark that fails is not reported and not retried: it costs one
 * duplicate push next cycle, and the alternative — treating a failed mark as a
 * failed delivery — would be an item recorded as undelivered that had arrived.
 *
 * ── A consequence, never a truth ───────────────────────────────────────────
 *
 * Nothing here decides anything. A failed send changes no task, no record, no
 * scheduler disposition and no exit code — it is counted, reported to the
 * console and dropped. {@link pushAttentionItems} never rejects and never
 * throws, because it is called from inside a scheduler loop and a notifier that
 * threw would rewrite the run's own answer.
 *
 * ── What may be put on the wire ────────────────────────────────────────────
 *
 * Strictly less than the durable record holds: the identity digest, the declared
 * repository id, the task id, the state name, the reason, the quota reading when
 * there is one, the reset instant the diagnosis mentions, and one sentence
 * chosen from `core/task-attention.ts`'s fixed table. {@link AttentionPush}'s
 * own fields are that list, and {@link attentionPushFor} builds it field by
 * field rather than by spread, so a field added to the record has to be added
 * here deliberately before it can leave the machine.
 *
 * **No repository root and no worktree path**: the record needs one because it
 * lives outside every repository, and a wire payload does not, so it does not
 * get one. That is the rule `notify/notification.ts` already states about its
 * own payload, kept rather than restated loosely, and it is asserted rather than
 * promised — the suite serialises a push and requires no path in it.
 */

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import type { RunAttentionReason } from '../core/run-attention.js';
import type { AttentionReason } from '../core/task-attention.js';
import type { TaskStateName } from '../core/states.js';
import type { UsageLimitContinuationReading } from '../core/usage-limit-continuation.js';
import { markAttentionDelivered, type AttentionRecord } from './attention-store.js';
import { loadNotificationConfig, type NotificationConfig } from './notify-config.js';
import type { TransportResult } from './notification.js';
import { createNtfyAttentionTransport } from './ntfy-transport.js';

/**
 * Everything that goes on the wire for one open item. Nothing else, ever.
 *
 * The two subjects are one payload shape rather than two, and the fields that
 * belong to only one of them are `null` on the other. A transport that had to
 * branch on the subject to know which fields exist would be a second place the
 * record's shape is encoded; keeping one shape means a new subject is a value
 * change here and not a new code path in every notifier.
 *
 * `subject` is on the wire because the reader needs it: "no task id" is not a
 * self-describing statement about a repository-wide condition, and a message
 * that simply omitted the field would read as a truncated task message.
 */
export interface AttentionPush {
  /** The identity of the item, so two messages about one thing are recognisable. */
  readonly attentionId: string;
  /** Which kind of thing this item is about. */
  readonly subject: AttentionRecord['subject'];
  /** The repository's *declared* identity. Never its root, never a path. */
  readonly repositoryId: string;
  /** The task, or `null` for a condition that belongs to the repository. */
  readonly taskId: string | null;
  /** The task's state, or `null` for a repository condition. */
  readonly state: TaskStateName | null;
  /**
   * The lifecycle outcome, or `null` for a task item.
   *
   * Closed vocabulary in both directions: a `RunCondition` is a member of a
   * fixed list, and `RUN_THREW` is the *name* of a throw rather than anything
   * the throw said. No exception text reaches this payload.
   */
  readonly condition: string | null;
  readonly reason: AttentionReason | RunAttentionReason;
  readonly detail: UsageLimitContinuationReading | null;
  readonly reportedResetAt: string | null;
  /** The one sentence saying what the operator has to do. */
  readonly action: string;
}

/** The port. One payload, one bounded attempt, no configuration visible to it. */
export type AttentionTransport = (notification: AttentionPush) => Promise<TransportResult>;

/**
 * The wire payload for a stored record.
 *
 * Field by field rather than a spread, so that a field added to the record has
 * to be added here deliberately before it can leave the machine. A spread would
 * make the next durable field an egress decision nobody made.
 */
export function attentionPushFor(record: AttentionRecord): AttentionPush {
  // Switched on the discriminant rather than read with `?.`, so that a field
  // added to one subject and not the other is a compile error here instead of
  // an `undefined` on the wire.
  if (record.subject === 'REPOSITORY') {
    return Object.freeze({
      attentionId: record.attentionId,
      subject: record.subject,
      repositoryId: record.repositoryId,
      taskId: null,
      state: null,
      condition: record.condition,
      reason: record.reason,
      detail: null,
      reportedResetAt: null,
      action: record.action,
    });
  }
  return Object.freeze({
    attentionId: record.attentionId,
    subject: record.subject,
    repositoryId: record.repositoryId,
    taskId: record.taskId,
    state: record.state,
    condition: null,
    reason: record.reason,
    detail: record.detail,
    reportedResetAt: record.reportedResetAt,
    action: record.action,
  });
}

/** Whether this machine is set up to be told. Decided before anything is sent. */
export type AttentionNotifierState = 'ARMED' | 'NOT_CONFIGURED' | 'CONFIG_UNUSABLE';

export interface AttentionNotifier {
  readonly state: AttentionNotifierState;
  /** The refusal code when `state` is `CONFIG_UNUSABLE`, else `null`. */
  readonly configCode: string | null;
  /** Present only when armed. Nothing to call is what "off" means. */
  readonly transport: AttentionTransport | null;
}

/**
 * Builds the notifier for this invocation, reading the operator's configuration.
 *
 * Called **before** the loop — the placement `notification.ts` chose for the
 * same reason.
 *
 * Being called early is not by itself being *told*, and this comment used to
 * claim it was. A recurring invocation prints nothing until it ends, so a
 * notifier built at minute zero and reported at hour eight told nobody anything
 * while they were still standing there. What closes the gap is the caller:
 * `cli/repositories-command.ts` writes `renderNotificationReadiness(...)` before
 * it enters the loop, and this factory's state is what that line reads.
 *
 * The transport factory is an internal seam and grants nothing: an unconfigured
 * machine produces `NOT_CONFIGURED` whatever is passed here, because the state
 * comes from the configuration file and not from the seam. That no egress
 * happens without the file is therefore not a property of this factory's
 * callers, and it is measured against the shipped artefact in a process where no
 * seam exists at all.
 */
export function createAttentionNotifier(
  provider: PathProvider = OS_PATH_PROVIDER,
  transportFor: (config: NotificationConfig) => AttentionTransport = createNtfyAttentionTransport,
): AttentionNotifier {
  const loaded = loadNotificationConfig(provider);
  if (loaded.state === 'NOT_CONFIGURED') {
    return Object.freeze({ state: 'NOT_CONFIGURED' as const, configCode: null, transport: null });
  }
  if (loaded.state === 'UNUSABLE') {
    return Object.freeze({
      state: 'CONFIG_UNUSABLE' as const,
      configCode: loaded.code,
      transport: null,
    });
  }
  return Object.freeze({
    state: 'ARMED' as const,
    configCode: null,
    transport: transportFor(loaded.config),
  });
}

export const ATTENTION_PUSH_OUTCOMES = [
  /** Nothing new was raised, so nothing was said. */
  'NOTHING_TO_SEND',
  /** This machine has no notification configuration. No transport exists. */
  'NOT_CONFIGURED',
  /** It has one and it cannot be used. Reported, and off. */
  'CONFIG_UNUSABLE',
  /** Every newly raised item reached the endpoint. */
  'DELIVERED',
  /** At least one did not. The items are still in the store either way. */
  'PARTIALLY_DELIVERED',
  /** None of them did. */
  'FAILED',
] as const;

export type AttentionPushOutcome = (typeof ATTENTION_PUSH_OUTCOMES)[number];

/** INTERNAL seams. Production passes nothing; a test drives the receipt write. */
export interface AttentionPushDependencies {
  readonly pathProvider?: PathProvider;
  readonly markDelivered?: typeof markAttentionDelivered;
}

export interface AttentionPushResult {
  readonly outcome: AttentionPushOutcome;
  readonly attempted: number;
  readonly delivered: number;
  /** Closed codes, one per failure, in attempt order. Never a message. */
  readonly failures: readonly string[];
  /** The configuration refusal when `outcome` is `CONFIG_UNUSABLE`, else `null`. */
  readonly configCode: string | null;
}

const pushResult = (
  outcome: AttentionPushOutcome,
  attempted: number,
  delivered: number,
  failures: readonly string[],
  configCode: string | null = null,
): AttentionPushResult =>
  Object.freeze({ outcome, attempted, delivered, failures: Object.freeze([...failures]), configCode });

/**
 * Announces the items this pass newly raised.
 *
 * Total: a refusing server, a timeout, a transport that throws — every one of
 * them is a return value. Nothing propagates out, because the caller is a loop
 * whose next decision is about repositories and not about a socket.
 *
 * Sequential rather than concurrent, deliberately. The realistic count is one or
 * two per pass, an operator reading a phone wants them in a stable order, and a
 * fan-out that opened ten sockets at once would be this module deciding how hard
 * to lean on somebody's ntfy server.
 */
export async function pushAttentionItems(
  notifier: AttentionNotifier,
  records: readonly AttentionRecord[],
  deps: AttentionPushDependencies = {},
): Promise<AttentionPushResult> {
  const mark = deps.markDelivered ?? markAttentionDelivered;
  const provider = deps.pathProvider ?? OS_PATH_PROVIDER;
  if (records.length === 0) return pushResult('NOTHING_TO_SEND', 0, 0, []);
  if (notifier.state === 'NOT_CONFIGURED') return pushResult('NOT_CONFIGURED', 0, 0, []);
  if (notifier.state === 'CONFIG_UNUSABLE') {
    return pushResult('CONFIG_UNUSABLE', 0, 0, [], notifier.configCode);
  }
  // Armed without a transport cannot be built by `createAttentionNotifier`; it
  // is still refused rather than dereferenced, because a hand-made notifier is a
  // thing a caller can write and a crash here would be attributed to the run.
  const transport = notifier.transport;
  if (transport === null) return pushResult('FAILED', records.length, 0, ['TRANSPORT_ABSENT']);

  const failures: string[] = [];
  let delivered = 0;

  for (const record of records) {
    try {
      const sent = await transport(attentionPushFor(record));
      if (sent.ok) {
        delivered += 1;
        // The receipt, written the instant the endpoint acknowledged and not at
        // the end of the loop (`U2`, M4). A batch that marked its successes
        // after the last attempt would lose every receipt to a crash in the
        // middle of it, and the next cycle would re-send items that had already
        // arrived. Marking here bounds that loss to the one item in flight.
        //
        // Its own outcome is not reported. A mark that failed costs one
        // duplicate push next cycle; a *delivery* that failed is a different
        // fact and is the one this result is about.
        mark(record.attentionId, provider);
      } else failures.push(sent.code);
    } catch {
      // The thrown value is dropped rather than formatted: it comes from a
      // network stack and routinely carries hosts, ports and system messages.
      failures.push('TRANSPORT_THREW');
    }
  }

  const outcome: AttentionPushOutcome =
    delivered === records.length
      ? 'DELIVERED'
      : delivered === 0
        ? 'FAILED'
        : 'PARTIALLY_DELIVERED';

  return pushResult(outcome, records.length, delivered, failures);
}
