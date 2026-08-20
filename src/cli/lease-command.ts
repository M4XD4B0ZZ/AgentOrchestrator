/**
 * `agent-loop lease` — reading the execution lease, and removing one that is
 * provably dead.
 *
 * ── `status` ───────────────────────────────────────────────────────────────
 *
 * It changes nothing and cannot fail a script: a held lease is a normal
 * condition, not an error. It reports what is at the lease path, and whether
 * this build can prove the lease removable, and stops there.
 *
 * ── `recover` ──────────────────────────────────────────────────────────────
 *
 * Removes a stale lease **and only one it has just proved dead**: the owner
 * process is gone *and* every writer launch under that lease is recorded as
 * having run inside a process job coupled to that owner, so the kernel destroyed
 * every one of those trees when the owner died. Anything else — a live owner, an
 * undecidable one, an unreadable lease, a lease from an older build, a launch
 * history that is missing, torn, foreign or has one unproved entry — is refused,
 * and the refusal says which fact is missing.
 *
 * It takes a repository and nothing else. There is no `--force`, no expected
 * revision to type back, and no environment variable. Read the next section for
 * why the *absence* of those arguments is the safety property rather than a
 * convenience.
 *
 * And it removes a lease. It does not acquire one, restart anything, or grant
 * any authority: `containment != authority`, so the run that follows takes its
 * own lease through the ordinary exclusive create like every other holder.
 *
 * ── There is no `break`, and this is the second withdrawal ─────────────────
 *
 * A `lease break` shipped here twice and was withdrawn twice. The first time,
 * three adversarial review rounds each found a fresh way for it to destroy an
 * authority somebody had legitimately acquired. It came back under a contract
 * written from what had defeated it — the operator naming the lease by the digest
 * of its bytes *and* by the filesystem object, both re-established on the record
 * the removal had already detached — and a sixth review broke that too, by
 * reproducing a removal of a **legitimately acquired** lease end to end.
 *
 * The argument that brought it back the first time was this: refusing to ship the
 * destructive operation does not remove the destructive operation, it only
 * removes the place where the race could be closed. That argument was wrong, and
 * saying so plainly is the point of this paragraph. **The race could not be
 * closed there either.** For the zero-byte crash artefact — the case that most
 * needs recovering — the digest is a constant every empty file shares, the record
 * names no owner so the pid check compares `null` with `null` and the liveness
 * re-check is skipped, and the object identity is a `(dev,ino)` pair on a module
 * that ships fallbacks for filesystems which reuse those. Every fact an operator
 * could be shown collapses at once. Closing it needs an atomic compare-and-delete
 * on a directory entry, which no portable primitive offers.
 *
 * So that command is gone, and — the part the last withdrawal got wrong — no
 * report prints a procedure for doing it by hand either. A printed procedure is
 * the same destructive operation with the tool's help removed, and the previous
 * renderer went further and printed a ready-made command line with the constant
 * digest already filled in, under the heading "This lease is recoverable". That
 * made the unsafe contract the *normal* operator path rather than a hand-built
 * misuse.
 *
 * ── `recover` is not that command with a better predicate ──────────────────
 *
 * Read this before concluding the withdrawal was reversed. `break` failed at
 * three specific points, and `recover` does not stand on any of them:
 *
 *  - **it refuses the case that defeated `break`.** The zero-byte crash artefact
 *    has no owner, no nonce and a digest every empty file shares. `recover`
 *    requires a lease document it *parsed*, so that artefact is refused as
 *    `LEASE_UNPARSEABLE` and stays refused. The gap the break existed to close
 *    is still open, deliberately, and is smaller than it was: a lease left by a
 *    crash *after* the record was written is now recoverable, and only the crash
 *    inside the claim itself is not;
 *  - **there is no window to carry a fact across.** `break` minted an
 *    authorisation, printed it, and acted on what an operator typed back. Here
 *    the whole predicate is evaluated inside the call that removes; the command
 *    accepts no verdict, no revision and no object id, because the *absence* of
 *    those parameters is what removes the window;
 *  - **and it has a fact `break` never had.** Owned process containment, plus a
 *    per-launch history poisoned before each writer starts, makes "no writer of
 *    this lease can still be running" provable. In V2 that was a hope, which is
 *    why the answer there was no.
 *
 * **No `--force`, no environment variable, no API back door.** Nothing in this
 * build removes a lease it cannot prove is dead.
 */

import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { inspectWriterLaunchHistory, recoverStaleLease } from '../lease/execution-lease.js';
import { assessLeaseRecovery } from '../lease/lease-recovery.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import {
  renderLeaseRecovery,
  renderLeaseRecoveryResult,
  renderLeaseStatus,
} from './render-lease.js';
import { EXIT_RUN_INPUT_UNUSABLE, EXIT_RUN_OK, EXIT_RUN_UNEXPECTED } from './run-exit-codes.js';

interface LeaseStatusOptions {
  readonly repository: string;
}

interface LeaseRecoverOptions {
  readonly repository: string;
}

function report(lines: readonly string[]): void {
  process.stdout.write(`\n${lines.join('\n')}\n\n`);
}

export function registerLeaseCommand(program: Command): void {
  const lease = program
    .command('lease')
    .description(
      'Inspect the execution lease of this repository - the thing that makes at most one ' +
        'orchestrator invocation its writer at a time - and remove one that is provably dead. ' +
        'No lease is ever removed on a guess: `recover` refuses everything it cannot prove, ' +
        'and there is no way to override the refusal.',
    );

  lease
    .command('status')
    .description(
      'Report the execution lease: whether one is held, by which process, and for which run. ' +
        'Read-only.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .action(async (options: LeaseStatusOptions) => {
      try {
        const resolution = await resolveRepository({ repositoryPath: options.repository });
        if (!resolution.ok) {
          report([
            'Repository   : could not be resolved',
            `Failure      : ${resolution.code} - ${resolution.detail}`,
          ]);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        const assessment = assessLeaseRecovery(resolution.repository);
        process.stdout.write(renderLeaseStatus(assessment.inspection));
        // The launch history is read separately, and not taken from the
        // assessment: that one stops at its first refusal, so a repository with a
        // living owner carries no reading at all — and "is this run's bookkeeping
        // intact" is a question about a healthy repository too.
        process.stdout.write(
          renderLeaseRecovery(
            assessment.staleRecovery,
            inspectWriterLaunchHistory(resolution.repository),
          ),
        );
        // Reporting always succeeded, whatever it found. A held lease is not an
        // error condition, and a status command that exited non-zero for one
        // would be unusable in exactly the scripts that need it. The same is
        // true of a lease that cannot be recovered: that is the normal answer
        // for a healthy repository.
        process.exitCode = EXIT_RUN_OK;
      } catch (error) {
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });

  lease
    .command('recover')
    .description(
      'Remove a stale execution lease, and only one this build can prove is dead: its owner ' +
        'process is gone and every writer launch under it is proved to have run inside a ' +
        'process job coupled to that owner. Anything unproved, unreadable, unknown or from an ' +
        'older build is refused, and there is no override. Removes the lease and nothing else - ' +
        'it grants no authority, starts nothing, and the next run takes its own lease normally.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .action(async (options: LeaseRecoverOptions) => {
      try {
        const resolution = await resolveRepository({ repositoryPath: options.repository });
        if (!resolution.ok) {
          report([
            'Repository   : could not be resolved',
            `Failure      : ${resolution.code} - ${resolution.detail}`,
          ]);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        // The repository, and nothing else. There is deliberately no
        // `--expected-revision`, no `--expected-object` and no `--force`: the
        // withdrawn `lease break` took exactly those, and what defeated it was
        // that a fact an operator had been shown no longer named the same object
        // by the time the removal ran. `recoverStaleLease` proves everything for
        // itself, inside the call that removes, so there is nothing here for an
        // operator to carry across that window and nothing for them to get wrong.
        const result = recoverStaleLease(resolution.repository);
        process.stdout.write(renderLeaseRecoveryResult(result));
        // A refusal is not a failure of the command: "this lease cannot be
        // proved dead" is the correct and expected answer for most leases, and
        // a non-zero exit would make the command unusable in the scripts that
        // would ask it. The code in the report is what a caller reads.
        process.exitCode = EXIT_RUN_OK;
      } catch (error) {
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
