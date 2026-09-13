/**
 * A notifier that cannot reach anyone, for every test that drives the block CLI.
 *
 * ── The incident this exists for, measured ─────────────────────────────────
 *
 * On 2026-09-13 a push arrived on the operator's phone reading
 * `A-001 BLOCKED / B-001 PLANNED / run-1 / BLOCK_RUN_ENDED / TASK_BLOCKED`. It
 * was not the orchestrator driving anything. It was `npm run verify`.
 *
 * `cli/block-command.ts` falls back to `createOperatorNotifier()` when no seam
 * is supplied, and that default reads the **real** operator home —
 * `~/.agent-orchestrator/notify.yaml`, which on that machine names `ntfy.sh` and
 * a live topic. `tests/v2-09-dependent-commit-chain.test.ts` drives that CLI six
 * times and supplied no seam, so the suite sent six real notifications, with
 * fixture task ids, to a person who was not running anything.
 *
 * Two things make it worth a shared helper rather than six local objects.
 * A suite that can reach a real notification endpoint can reach whatever else
 * the operator profile configures; and a real push that looks exactly like a
 * real block teaches the operator to ignore the ones that are.
 *
 * ── Why NOT_CONFIGURED rather than a recording fake ────────────────────────
 *
 * `transport: null` is structural: there is no function to call, so a test
 * cannot send by accident even if the code under test decides to. A recording
 * fake would be the right tool for asserting *what* was sent, and
 * `v2-10-operator-notification.ts` builds one for exactly that — this is for the
 * many suites whose subject is not notification at all and which simply must
 * not touch the operator's real configuration.
 *
 * It is deliberately not a global switch. Production behaviour is untouched:
 * the fallback in `block-command.ts` is still the real notifier, because a
 * machine that reports its endings is the point of the feature.
 */

import type { OperatorNotifier } from '../../src/notify/notification.js';

/**
 * A notifier with no transport and nothing to configure.
 *
 * Frozen and shared: it holds no state, so every caller may have the same one.
 */
export const SILENT_NOTIFIER: OperatorNotifier = Object.freeze({
  state: 'NOT_CONFIGURED' as const,
  configCode: null,
  transport: null,
});

/** The same value, as a call, for seams that read better with one. */
export function silentNotifier(): OperatorNotifier {
  return SILENT_NOTIFIER;
}
