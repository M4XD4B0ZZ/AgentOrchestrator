/**
 * `agent-loop attention` — what has been written down for you, and what nobody
 * has been told about (M4, `U2`).
 *
 * ── Why a command exists at all ────────────────────────────────────────────
 *
 * The closing audit's `U2` is not "a push can fail". It is that a failed push
 * and a quiet day are the same experience:
 *
 *   > **Unattended:** the notifier would be the only signal, and a best-effort
 *   > channel with no acknowledgement cannot be one.
 *
 * The durable outbox already made the *conditions* survive a lost message. What
 * it did not do is let anybody ask. A recurring invocation prints nothing until
 * it ends (`L-M3-02-10`), so between "the phone is quiet because nothing is
 * wrong" and "the phone is quiet because the endpoint has been refusing since
 * Tuesday" there was no observable difference on this machine.
 *
 * This command is that difference. It reads the store and prints two things: the
 * open items, and which of them carry no delivery receipt. An operator, a cron
 * job or a status page can ask at any time, on a machine with no notification
 * configuration at all.
 *
 * ── It reads, and that is the whole of it ──────────────────────────────────
 *
 * No repository is named, no lease is taken, no runtime directory is enumerated,
 * nothing is written and nothing is removed. `publication authorisations`
 * reached the same shape for the same reason: the store sits outside every
 * repository and each record says which one it came from, so there is nothing
 * for a `--repository` option to mean.
 *
 * In particular it does **not** settle the outbox. Settling requires reading
 * every enlisted repository's durable state, and a reader that removed items
 * would let `agent-loop attention` silently resolve a condition somebody was
 * about to act on. Removal belongs to the pass that can see the world; this can
 * only see the store.
 */

import type { Command } from 'commander';

import type { PathProvider } from '../config/internal/path-provider.js';
import { formatSafeError } from '../core/safe-error.js';
import { listAttentionRecords } from '../notify/attention-store.js';
import { renderAttentionStore } from './render-attention.js';
import { EXIT_RUN_OK, EXIT_RUN_UNEXPECTED } from './run-exit-codes.js';

/**
 * What the command is for, printed in `--help`.
 *
 * Deliberately says what an *empty* listing means, because that is the reading
 * an operator will do most often and the one they can get wrong. Nothing open is
 * a real answer here — it is not "the store could not be read", which prints as
 * its own line.
 */
export const ATTENTION_DESCRIPTION =
  'Show the operator-attention outbox: every condition this machine has written down that no ' +
  'run can move on its own, and which of them have not reached a notification endpoint. Reads ' +
  'only — it takes no lease, names no repository, writes nothing and removes nothing. An empty ' +
  'listing means nothing is open, which is an answer; a store that could not be read says so on ' +
  'its own line and is never reported as empty.';

export interface AttentionCommandSeams {
  readonly pathProvider?: PathProvider;
  readonly write?: (text: string) => void;
}

export function registerAttentionCommand(
  program: Command,
  seams: AttentionCommandSeams = {},
): void {
  program
    .command('attention')
    .description(ATTENTION_DESCRIPTION)
    .action(() => {
      const write = seams.write ?? ((text: string): void => void process.stdout.write(text));
      try {
        const listing = listAttentionRecords(seams.pathProvider);
        write(renderAttentionStore(listing));
        // Always 0, and that is a decision rather than an oversight. An open
        // item is a fact about a repository, not a failure of this command, and
        // a non-zero exit here would make a monitoring script treat "you have
        // three things to look at" as "the reader is broken". The report is the
        // answer; the exit code says the reader worked.
        process.exitCode = EXIT_RUN_OK;
      } catch (error) {
        // `listAttentionRecords` is total and does not throw, so reaching here
        // is a defect in this build rather than a state of the store. Reported
        // through the central safe formatter, never as an exception message
        // (AO-002).
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
