/**
 * `agent-loop lease` — reading the execution lease. Read-only, and only read-only.
 *
 * ── `status` ───────────────────────────────────────────────────────────────
 *
 * It changes nothing and cannot fail a script: a held lease is a normal
 * condition, not an error. It reports what is at the lease path and stops there.
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
 * So this command does not offer recovery, and — the part the last withdrawal got
 * wrong — `status` no longer prints a procedure for doing it by hand either. A
 * printed procedure is the same destructive operation with the tool's help
 * removed, and the previous renderer went further and printed a ready-made
 * command line with the constant digest already filled in, under the heading
 * "This lease is recoverable". That made the unsafe contract the *normal*
 * operator path rather than a hand-built misuse.
 *
 * What replaces it is not a smaller version of it. `lease-recovery.ts` states the
 * reasoning; a real recovery — quarantine-and-report, which never unlinks — is a
 * product decision of its own.
 *
 * **No `--force`, no unattended break, no environment variable, no API back
 * door.** There is nothing in this build that removes a lease it did not create.
 */

import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { assessLeaseRecovery } from '../lease/lease-recovery.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { renderLeaseStatus } from './render-lease.js';
import { EXIT_RUN_INPUT_UNUSABLE, EXIT_RUN_OK, EXIT_RUN_UNEXPECTED } from './run-exit-codes.js';

interface LeaseStatusOptions {
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
        'orchestrator invocation its writer at a time. Read-only: this build has no command ' +
        'that removes a lease it did not create.',
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

        process.stdout.write(renderLeaseStatus(assessLeaseRecovery(resolution.repository).inspection));
        // Reporting always succeeded, whatever it found. A held lease is not an
        // error condition, and a status command that exited non-zero for one
        // would be unusable in exactly the scripts that need it.
        process.exitCode = EXIT_RUN_OK;
      } catch (error) {
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
