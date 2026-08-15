/**
 * The message, and the act of sending it (V2-10).
 *
 * ── A consequence, never a truth ───────────────────────────────────────────
 *
 * Everything here happens after a run is over and its result is authoritative.
 * The payload is *derived* from that result and from the repository's declared
 * identity — nothing is re-read, re-decided or reconstructed, and in particular
 * nothing is written first. Two of the endings this module reports
 * (`DURABLE_WRITE_FAILED`, `LEASE_AUTHORITY_UNCERTAIN`) exist precisely because
 * the ledger may not be made to carry them, so a notification path that needed a
 * durable write to happen first would be unavailable exactly when it matters.
 *
 * A failed send changes nothing: not the stop reason, not a task disposition,
 * not the ledger, not the process exit code. It is printed and that is all.
 *
 * ── Total by construction ──────────────────────────────────────────────────
 *
 * {@link notifyBlockRun} never rejects and never throws. That is not politeness:
 * it is called after the `finally` that gives the execution lease back, outside
 * the block whose `catch` maps an exception to `EXIT_RUN_UNEXPECTED`. A notifier
 * that threw would turn a clean `COMPLETE` into a reported internal failure —
 * the notifier rewriting the run's own answer, which is the one thing it may
 * never do.
 *
 * ── What may be put on the wire ────────────────────────────────────────────
 *
 * Ids that have passed a validating boundary (the repository's declared
 * identity, the block id, the run id, task ids — all of them already constrained
 * by the ledger's schema), closed-vocabulary codes, a step count, and one static
 * sentence chosen by `attention.ts`. No prompt, no agent output, no verifier
 * output, no exception text, no path: none of those is representable in an
 * `AttendedBlockResult` in the first place.
 *
 * The exception is {@link AttendedBlockResult.detail}, and it gets a gate of its
 * own — see {@link SAFE_DETAIL}. The repository *root* is deliberately not a
 * parameter of this module: only the declared id is passed in, so there is no
 * value here that could carry a filesystem layout off the machine.
 */

import type { BlockStopReason, TaskDisposition } from '../block/block-ledger.js';
import type { AttendedBlockResult, BlockRunOutcome } from '../block/block-runner.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { judgeBlockRun } from './attention.js';
import { loadNotificationConfig, type NotificationConfig } from './notify-config.js';
import { createNtfyTransport } from './ntfy-transport.js';

/**
 * The shape a `detail` must have to leave the machine.
 *
 * `AttendedBlockResult.detail` is documented as an allow-listed code from
 * another module's closed vocabulary, and for the console that is good enough.
 * It is not quite true: `block-store.ts` builds
 * `LEDGER_CONTRACT_VIOLATION:<message>` out of a Zod issue, so one producer's
 * text is authored by a dependency's formatter rather than by this repository.
 * Every value that reaches it today is in fact code-shaped, by a chain of
 * upstream validations — and a chain of upstream validations is exactly the kind
 * of claim one should not export over a network on somebody else's behalf.
 *
 * So the shape is checked here, at the boundary that does the exporting. What
 * this proves is narrow and worth stating narrowly: **not** that `detail` is a
 * globally closed vocabulary, only that unbounded free text does not leave the
 * machine. A value that fails becomes {@link DETAIL_WITHHELD}, which is itself
 * information — an operator who sees it knows the run produced a detail this
 * boundary would not send, and the console beside it still has the original.
 */
export const SAFE_DETAIL = /^[A-Z][A-Z0-9_]*(?::[A-Z][A-Z0-9_,]*)?$/;

/** What a `detail` becomes when it is not code-shaped. */
export const DETAIL_WITHHELD = 'DETAIL_WITHHELD';

export interface NotificationTask {
  readonly taskId: string;
  readonly disposition: TaskDisposition;
}

/** Everything that goes on the wire. Nothing else is sent, ever. */
export interface OperatorNotification {
  /** The repository's *declared* identity. Never its root, never a path. */
  readonly repositoryId: string;
  readonly blockId: string;
  readonly runId: string;
  readonly outcome: BlockRunOutcome;
  readonly stopReason: BlockStopReason | null;
  /** Code-shaped, {@link DETAIL_WITHHELD}, or absent. */
  readonly detail: string | null;
  readonly steps: number;
  readonly tasks: readonly NotificationTask[];
  /** The one sentence saying what the operator has to do. From `attention.ts`. */
  readonly action: string;
}

export const TRANSPORT_FAILURES = [
  'TIMEOUT',
  'REJECTED_UNAUTHORISED',
  'REJECTED_BY_SERVER',
  'TRANSPORT_FAILED',
] as const;

export type TransportFailure = (typeof TRANSPORT_FAILURES)[number];

export type TransportResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: TransportFailure };

/**
 * The port. One function, one payload, one bounded attempt.
 *
 * Deliberately not an object with configuration on it: a transport is handed a
 * finished payload and has no say in what is in it.
 */
export type NotificationTransport = (
  notification: OperatorNotification,
) => Promise<TransportResult>;

/** Whether this machine is set up to be told, decided before the run. */
export type NotifierState = 'ARMED' | 'NOT_CONFIGURED' | 'CONFIG_UNUSABLE';

export interface OperatorNotifier {
  readonly state: NotifierState;
  /** The refusal code when `state` is `CONFIG_UNUSABLE`, else `null`. */
  readonly configCode: string | null;
  /** Present only when armed. Nothing to call is what "off" means. */
  readonly transport: NotificationTransport | null;
}

/**
 * Builds the notifier for this invocation, reading the operator's configuration.
 *
 * Called **before** the run, above the lease line, so an operator with a broken
 * configuration is told while they are still standing there rather than forty
 * minutes later by the message that never arrives.
 *
 * The transport factory is an internal seam, and it grants nothing: an
 * unconfigured machine produces `NOT_CONFIGURED` whatever is passed here,
 * because the state comes from the configuration and not from the seam. The
 * property that no egress happens without the file is therefore not a property
 * of this factory's callers — it is measured against the shipped artefact, in a
 * process where no seam exists at all.
 */
export function createOperatorNotifier(
  provider: PathProvider = OS_PATH_PROVIDER,
  transportFor: (config: NotificationConfig) => NotificationTransport = createNtfyTransport,
): OperatorNotifier {
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

/** The `detail` as it may be sent. */
function detailFor(detail: string | null): string | null {
  if (detail === null) return null;
  return SAFE_DETAIL.test(detail) ? detail : DETAIL_WITHHELD;
}

/**
 * The payload for a run that needs an operator.
 *
 * `null` for a silent ending, which is how "there is nothing to send" is
 * expressed: no payload exists for a run nobody needs to hear about, rather than
 * a payload that a later caller might send by accident.
 */
export function notificationForBlockRun(
  repositoryId: string,
  result: AttendedBlockResult,
): OperatorNotification | null {
  const judgement = judgeBlockRun(result);
  if (judgement.disposition === 'SILENT') return null;

  return Object.freeze({
    repositoryId,
    blockId: result.blockId,
    runId: result.runId,
    outcome: result.outcome,
    stopReason: result.stopReason,
    detail: detailFor(result.detail),
    steps: result.steps,
    tasks: Object.freeze(
      result.tasks.map((task) =>
        Object.freeze({ taskId: task.taskId, disposition: task.disposition }),
      ),
    ),
    action: judgement.action,
  });
}

export const NOTIFICATION_OUTCOMES = [
  /** The ending does not need anybody. Nothing was built and nothing was sent. */
  'SILENT',
  /** This machine has no notification configuration. No transport exists. */
  'NOT_CONFIGURED',
  /** It has one and it cannot be used. Reported, and off. */
  'CONFIG_UNUSABLE',
  'DELIVERED',
  /** Armed, attempted, and it did not arrive. The run's own answer is unchanged. */
  'FAILED',
] as const;

export type NotificationOutcome = (typeof NOTIFICATION_OUTCOMES)[number];

export interface NotificationResult {
  readonly outcome: NotificationOutcome;
  /** A closed code: the transport failure, or the configuration refusal. */
  readonly code: string | null;
}

const result = (outcome: NotificationOutcome, code: string | null = null): NotificationResult =>
  Object.freeze({ outcome, code });

/**
 * Classifies a finished run, builds the payload if it needs one, and sends it.
 *
 * Total: every failure — a refusing server, a timeout, a transport that throws —
 * is a return value. Nothing propagates out of here, because the caller is past
 * the point where an exception could still mean anything about the run.
 */
export async function notifyBlockRun(
  notifier: OperatorNotifier,
  repositoryId: string,
  runResult: AttendedBlockResult,
): Promise<NotificationResult> {
  const notification = notificationForBlockRun(repositoryId, runResult);
  if (notification === null) return result('SILENT');
  if (notifier.state === 'NOT_CONFIGURED') return result('NOT_CONFIGURED');
  if (notifier.state === 'CONFIG_UNUSABLE') return result('CONFIG_UNUSABLE', notifier.configCode);
  // Armed without a transport cannot be built by `createOperatorNotifier`; it is
  // still refused rather than dereferenced, because a hand-made notifier is a
  // thing a caller can write and a crash here would be attributed to the run.
  if (notifier.transport === null) return result('FAILED', 'TRANSPORT_ABSENT');

  try {
    const sent = await notifier.transport(notification);
    return sent.ok ? result('DELIVERED') : result('FAILED', sent.code);
  } catch {
    // The thrown value is dropped rather than formatted: it comes from a network
    // stack and routinely carries hosts, ports and system messages.
    return result('FAILED', 'TRANSPORT_THREW');
  }
}
