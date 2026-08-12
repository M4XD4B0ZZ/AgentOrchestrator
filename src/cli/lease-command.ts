/**
 * `agent-loop lease` — reading, and deliberately breaking, the execution lease.
 *
 * ── Why a break command exists at all ──────────────────────────────────────
 *
 * Because the acquire contract refuses to guess. A lease whose owner cannot be
 * shown to be running is never taken over automatically — `lease/execution-lease.ts`
 * sets out what was measured and why a dead owner proves nothing about the agent
 * processes it started. That is the right refusal, and on its own it would make
 * the first crash brick a repository until somebody deleted a file inside `.git`
 * by hand.
 *
 * An undocumented manual edit is not a recovery story; it is the pressure that
 * eventually produces an unsafe automatic takeover. So the way out is a command,
 * and it is shaped so that using it is a *decision* rather than a shrug.
 *
 * ── What the operator has to have done ─────────────────────────────────────
 *
 * Three things, and none of them is a flag that means "I know what I'm doing":
 *
 *  1. `--attended`, the same operator grant `release --attended` requires. There
 *     is no unattended break, so no scheduled job can clear a lease;
 *  2. `--expected-revision`, the digest of the exact bytes `lease status`
 *     printed. A break therefore acts on *the lease that was looked at* — an
 *     operator who read a report, went away to think, and came back cannot
 *     remove a lease a legitimate new run has taken in the meantime;
 *  3. `--owner-pid`, the owner that report named — required when the lease is
 *     readable, and refused when it is not, so the claim always matches what was
 *     actually observable.
 *
 * And one thing they cannot do at all: break a lease whose owner is running.
 * That is refused on the liveness probe, and no flag overrides it. **There is no
 * `--force`**, here or anywhere near it, for the reason `release-workspace.ts`
 * gives about its own destructive path: a laxer notion of ownership on the
 * destructive side is the one that always drifts.
 *
 * ── What this command is not ───────────────────────────────────────────────
 *
 * It is not a way to *take* a lease. Breaking one leaves the repository with no
 * owner; the next ordinary invocation acquires in the ordinary way, through the
 * ordinary exclusive create. Nothing here hands anybody authority.
 */

import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import {
  breakRepositoryExecutionLease,
  inspectRepositoryExecutionLease,
  type LeaseBreakCode,
} from '../lease/execution-lease.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { LEASE_BREAK_SENTENCES, renderLeaseStatus } from './render-lease.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  type CliExitCode,
} from './run-exit-codes.js';

interface LeaseStatusOptions {
  readonly repository: string;
}

interface LeaseBreakOptions extends LeaseStatusOptions {
  readonly attended?: boolean;
  readonly expectedRevision?: string;
  readonly ownerPid?: string;
}

/**
 * Exit code for every break outcome. Total; a new code fails the build here.
 *
 * `BROKEN` is 0. Everything else is a refusal (4) except the two that say an
 * operator has to look at something else first: a live owner is not a situation
 * a retry improves, and a failed removal leaves a lease in place that somebody
 * has to deal with.
 */
const LEASE_BREAK_EXIT_CODES = Object.freeze({
  BROKEN: EXIT_RUN_OK,
  LEASE_ABSENT: EXIT_RUN_OK,
  LEASE_CHANGED: EXIT_RUN_REFUSED,
  LEASE_OWNER_ALIVE: EXIT_RUN_NEEDS_OPERATOR,
  LEASE_OWNER_LIVENESS_UNDETERMINED: EXIT_RUN_REFUSED,
  OWNER_PID_REQUIRED: EXIT_RUN_INPUT_UNUSABLE,
  OWNER_PID_MISMATCH: EXIT_RUN_INPUT_UNUSABLE,
  OWNER_PID_UNEXPECTED: EXIT_RUN_INPUT_UNUSABLE,
  LEASE_UNREADABLE: EXIT_RUN_NEEDS_OPERATOR,
  LEASE_LOCATION_UNSUITABLE: EXIT_RUN_INPUT_UNUSABLE,
  LEASE_REMOVE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<LeaseBreakCode, CliExitCode>;

/** The sentence printed when the operator grant is missing. */
export const BREAK_ATTENDANCE_WITHHELD_SENTENCE =
  'Breaking a lease removes another invocation\'s claim on this repository, so it needs an\n' +
  'operator: pass --attended. There is no unattended break and no --force.';

function report(lines: readonly string[]): void {
  process.stdout.write(`\n${lines.join('\n')}\n\n`);
}

export function registerLeaseCommand(program: Command): void {
  const lease = program
    .command('lease')
    .description(
      'Inspect, and where an operator decides so, clear the execution lease of this repository. ' +
        'The lease is what makes at most one orchestrator invocation the writer of one ' +
        'repository at a time.',
    );

  lease
    .command('status')
    .description(
      'Report the execution lease: whether one is held, by which process, for which run, ' +
        'and the revision a break would have to name. Read-only.',
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

        process.stdout.write(renderLeaseStatus(inspectRepositoryExecutionLease(resolution.repository)));
        // Reporting always succeeded, whatever it found. A held lease is not an
        // error condition, and a status command that exited non-zero for one
        // would be unusable in exactly the scripts that need it.
        process.exitCode = EXIT_RUN_OK;
      } catch (error) {
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });

  lease
    .command('break')
    .description(
      'Remove a lease an operator has established is stale. Attended only, and only for the ' +
        'exact lease named back by --expected-revision (and --owner-pid, where one is ' +
        'recorded). Refuses a lease whose owner is running. There is no --force.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .option(
      '--attended',
      'Confirm an operator is present for this invocation. Required: this command deletes.',
    )
    .option(
      '--expected-revision <sha256>',
      'The revision `lease status` printed. Required: it is what makes this act on the lease ' +
        'you inspected rather than on whatever is there now.',
    )
    .option(
      '--owner-pid <pid>',
      'The owner `lease status` printed. Required when the lease is readable, and refused ' +
        'when it is not.',
    )
    .action(async (options: LeaseBreakOptions) => {
      try {
        // Checked first, before the repository is resolved: an invocation with
        // no operator behind it should not start inspecting a repository in
        // order to say it was never going to do anything. Same ordering as
        // `release --attended`.
        if (options.attended !== true) {
          report(['Break        : not requested', '', BREAK_ATTENDANCE_WITHHELD_SENTENCE]);
          process.exitCode = EXIT_RUN_NEEDS_OPERATOR;
          return;
        }

        // Parsed here rather than by commander, so a bad value is refused in
        // this command's own vocabulary and before anything is opened.
        let ownerPid: number | null = null;
        if (options.ownerPid !== undefined) {
          ownerPid = Number(options.ownerPid);
          if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
            report([
              'Break        : refused',
              'Failure      : OWNER_PID_INVALID - --owner-pid must be a positive whole number.',
            ]);
            process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
            return;
          }
        }

        const resolution = await resolveRepository({ repositoryPath: options.repository });
        if (!resolution.ok) {
          report([
            'Repository   : could not be resolved',
            `Failure      : ${resolution.code} - ${resolution.detail}`,
          ]);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        const broken = breakRepositoryExecutionLease(resolution.repository, {
          // An omitted revision is `null`, which the store reads as "this does
          // not name the bytes on disk" and refuses. Absence is never a wildcard.
          expectedRevision: options.expectedRevision ?? null,
          ownerPid,
        });

        report([
          `Break        : ${broken.code}`,
          ...(broken.detail === null ? [] : [`Detail       : ${broken.detail}`]),
          '',
          LEASE_BREAK_SENTENCES[broken.code],
        ]);
        process.exitCode = LEASE_BREAK_EXIT_CODES[broken.code];
      } catch (error) {
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
