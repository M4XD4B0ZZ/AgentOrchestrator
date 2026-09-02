/**
 * The only module in this repository that opens a network connection (V2-10).
 *
 * ── Why that sentence is a design element ──────────────────────────────────
 *
 * Until this slice, `src/` contained no `fetch`, no `node:http`, no `node:net`.
 * The property worth keeping is not "egress is careful" but "egress happens in
 * one file", because that is a property a test can measure over the tree rather
 * than a habit a reviewer has to maintain. `tests/v2-10-operator-notification`
 * pins this module as the sole importer of the platform's network surface.
 *
 * ── JSON body, not ntfy headers ────────────────────────────────────────────
 *
 * ntfy accepts the title, priority and tags either as HTTP headers or as fields
 * of a JSON document posted to the base URL. This build uses the JSON form and
 * would use it even if it were less convenient: a header value is a line in a
 * request, and no value derived from a run — a run id an operator typed, a task
 * id a repository declared, a store code — should ever be one. The JSON body is
 * produced by `JSON.stringify`, which encodes a stray control character instead
 * of ending a line.
 *
 * The one dynamic header is `Authorization`, and it carries the operator's own
 * configured token — nothing derived from the run, the repository or the
 * payload. `notify-config.ts` has already refused a token that is not
 * header-safe, so the value here cannot introduce a second line either.
 *
 * ── One bounded attempt ────────────────────────────────────────────────────
 *
 * A timeout, no retry, no redirect. `redirect: 'error'` matters: an endpoint
 * inside the validated boundary could otherwise answer 302 and move the request
 * outside it, which would make the validation a statement about the first hop
 * only. No response body is read; the answer is its status class, and the
 * server's own text is not something this process needs or should hold.
 *
 * There is no retry because a retry is a second decision, and the run it would
 * be describing has already ended. A dropped notification is reported to the
 * console, and that is the honest failure mode.
 */

import type { NotificationConfig } from './notify-config.js';
import type {
  NotificationTransport,
  OperatorNotification,
  TransportResult,
} from './notification.js';
import type { AttentionPush, AttentionTransport } from './attention-notification.js';

/** The whole budget for one attempt, connection included. */
export const NOTIFICATION_TIMEOUT_MS = 10_000;

/**
 * ntfy's priority scale, fixed at "high".
 *
 * A constant rather than a mapping from the ending: every notification this
 * build sends means the orchestrator has stopped doing useful work on its own,
 * and grading that into levels would invite the quiet ones to be missed.
 */
const PRIORITY = 4;

/** Fixed, so no repository content can choose how a message is labelled. */
const TAGS = Object.freeze(['warning']);

/** The human-readable half. Built from validated ids and closed codes only. */
function messageFor(notification: OperatorNotification): string {
  const ending =
    notification.stopReason === null
      ? notification.outcome
      : `${notification.outcome} / ${notification.stopReason}`;

  const lines = [
    notification.action,
    '',
    `ending: ${ending}`,
    ...(notification.detail === null ? [] : [`detail: ${notification.detail}`]),
    `run:    ${notification.runId}`,
    `steps:  ${String(notification.steps)}`,
    ...(notification.tasks.length === 0
      ? ['tasks:  none recorded']
      : ['tasks:', ...notification.tasks.map((task) => `  ${task.taskId} ${task.disposition}`)]),
  ];
  return lines.join('\n');
}

/** The document posted to ntfy. Every field is a value this build produced. */
function bodyFor(topic: string, notification: OperatorNotification): string {
  return JSON.stringify({
    topic,
    title: `${notification.repositoryId} / ${notification.blockId} needs an operator`,
    message: messageFor(notification),
    priority: PRIORITY,
    tags: TAGS,
  });
}

/** `TIMEOUT` for the deadline, `TRANSPORT_FAILED` for everything else. */
function failureFor(error: unknown): TransportResult {
  const name = error instanceof Error ? error.name : '';
  const timedOut = name === 'TimeoutError' || name === 'AbortError';
  return { ok: false, code: timedOut ? 'TIMEOUT' : 'TRANSPORT_FAILED' };
}

/**
 * A transport bound to one validated configuration.
 *
 * The endpoint and the token are captured here and are not reachable from the
 * payload side of this slice: `notificationForBlockRun` never sees them, and no
 * report, log or error in this build can print them.
 */
export function createNtfyTransport(config: NotificationConfig): NotificationTransport {
  return async (notification: OperatorNotification): Promise<TransportResult> => {
    let response: Response;
    try {
      response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.token === null ? {} : { authorization: `Bearer ${config.token}` }),
        },
        body: bodyFor(config.topic, notification),
        redirect: 'error',
        signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      return failureFor(error);
    }

    // Not read, and not left dangling either: an unconsumed body keeps a socket
    // in play, and reading it would take in text this process has no use for.
    try {
      await response.body?.cancel();
    } catch {
      // A body that cannot be cancelled says nothing about whether the
      // notification arrived, which is the only question here.
    }

    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'REJECTED_UNAUTHORISED' };
    }
    return { ok: false, code: 'REJECTED_BY_SERVER' };
  };
}

/* ─────────────── the second payload: an open operator-attention item ─────── */

/**
 * The human-readable half of an attention push.
 *
 * Built from validated ids, closed codes and one sentence out of
 * `core/task-attention.ts`'s fixed table. Deliberately **less** than the durable
 * record beside it carries: the record names the repository root, because it
 * lives outside every repository and has to say which one it came from, and this
 * does not, because a filesystem layout is exactly the kind of thing that must
 * not leave the machine. The declared id identifies the repository on the wire,
 * which is the rule `notificationForBlockRun` already follows.
 */
function attentionMessageFor(notification: AttentionPush): string {
  const lines = [
    notification.action,
    '',
    `task:   ${notification.taskId}`,
    `state:  ${notification.state}`,
    `reason: ${notification.reason}`,
    ...(notification.detail === null ? [] : [`detail: ${notification.detail}`]),
    ...(notification.reportedResetAt === null
      ? []
      : [`reset:  ${notification.reportedResetAt}`]),
  ];
  return lines.join('\n');
}

/** The document posted for one attention item. */
function attentionBodyFor(topic: string, notification: AttentionPush): string {
  return JSON.stringify({
    topic,
    title: `${notification.repositoryId} / ${notification.taskId} needs an operator`,
    message: attentionMessageFor(notification),
    priority: PRIORITY,
    tags: TAGS,
  });
}

/**
 * A transport for attention items, bound to one validated configuration.
 *
 * A sibling of {@link createNtfyTransport} rather than a widening of it, and
 * that is the whole reason it is a second function in this file. The two
 * payloads answer different questions — "how did this block run end" and "what
 * is open against this task" — and `OperatorNotification` hard-carries a block
 * id, a run id and a stop reason that an attention item has none of. Making one
 * type cover both would have meant nullable halves and a `tests/v2-10` suite
 * asserting a shape that no longer describes anything.
 *
 * It lives **in this file** because the property worth keeping is not "one
 * transport" but "egress happens in one place", which is what
 * `tests/v2-10-operator-notification.test.ts` measures over the tree. A second
 * socket-opening module would have broken that whatever it was called.
 *
 * One bounded attempt, no retry, no redirect, no response body — identical to
 * its sibling, for the reasons this file's header gives.
 */
export function createNtfyAttentionTransport(config: NotificationConfig): AttentionTransport {
  return async (notification: AttentionPush): Promise<TransportResult> => {
    let response: Response;
    try {
      response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.token === null ? {} : { authorization: `Bearer ${config.token}` }),
        },
        body: attentionBodyFor(config.topic, notification),
        redirect: 'error',
        signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      return failureFor(error);
    }

    try {
      await response.body?.cancel();
    } catch {
      // A body that cannot be cancelled says nothing about whether the
      // notification arrived, which is the only question here.
    }

    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'REJECTED_UNAUTHORISED' };
    }
    return { ok: false, code: 'REJECTED_BY_SERVER' };
  };
}
