/**
 * `agent-loop lease` — reading the execution lease, and nothing else.
 *
 * ── Why there is no command that clears one ────────────────────────────────
 *
 * There was one, and it was withdrawn. The acquire contract refuses to take a
 * lease whose owner cannot be shown to be running — `lease/execution-lease.ts`
 * sets out what was measured and why a dead owner proves nothing about the agent
 * processes it started — and an attended `lease break` existed here so that a
 * crash did not leave a repository locked forever.
 *
 * Three independent adversarial review rounds each found a fresh way for that
 * command to destroy an authority somebody had legitimately acquired: an
 * ABA/TOCTOU on the removal; then a placeholder introduced to close it, which
 * reintroduced the same defect one level up; then the routes around the
 * artefact's own machinery. Each fix was reproduced broken by the next round.
 *
 * A destructive operator command that has never survived a review is worse than
 * no command: it carries the authority of the tool, and it was wrong every time
 * it was inspected. So the whole productive path is gone — no subcommand, no
 * exported function, no exit-code contract, no half-live API left for a caller
 * to find. Recovery is a documented manual step, printed by `status`, and
 * explicitly outside what this build guarantees.
 *
 * A supported attended recovery flow is its own slice, and its first acceptance
 * condition is the one that defeated three attempts here: a stale or unreadable
 * lease must be removable by an explicit operator flow **without** any
 * possibility that a lease acquired in the meantime is destroyed by an ABA or
 * TOCTOU race.
 *
 * ── What remains ───────────────────────────────────────────────────────────
 *
 * `lease status`, which is read-only, changes nothing, and cannot fail a script:
 * a held lease is a normal condition, not an error.
 */

import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { inspectRepositoryExecutionLease } from '../lease/execution-lease.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { renderLeaseStatus } from './render-lease.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
  EXIT_RUN_UNEXPECTED,
} from './run-exit-codes.js';

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
        'orchestrator invocation its writer at a time. Read-only: this build ships no ' +
        'command that clears a lease.',
    );

  lease
    .command('status')
    .description(
      'Report the execution lease: whether one is held, by which process, for which run, ' +
        'and what clearing a stale one would require of an operator. Read-only.',
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

        process.stdout.write(
          renderLeaseStatus(inspectRepositoryExecutionLease(resolution.repository)),
        );
        // Reporting always succeeded, whatever it found. A held lease is not an
        // error condition, and a status command that exited non-zero for one
        // would be unusable in exactly the scripts that need it.
        process.exitCode = EXIT_RUN_OK;
      } catch (error) {
        process.stderr.write(`${formatSafeError(error)}
`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
