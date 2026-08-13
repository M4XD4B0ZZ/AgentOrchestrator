/**
 * `agent-loop lease` — reading the execution lease, and recovering from a dead one.
 *
 * ── `status`, which is read-only ───────────────────────────────────────────
 *
 * It changes nothing and cannot fail a script: a held lease is a normal
 * condition, not an error. Where a lease is recoverable it prints the break
 * command with the revision already filled in, and where it is not it prints no
 * command at all.
 *
 * ── `break`, and the history it is written from ────────────────────────────
 *
 * A `lease break` existed here before and was **withdrawn**. Three independent
 * adversarial review rounds each found a fresh way for it to destroy an
 * authority somebody had legitimately acquired: an ABA on the removal; then a
 * placeholder introduced to close it, which reintroduced the same defect one
 * level up; then the routes around the artefact's own machinery. A destructive
 * operator command that has never survived a review is worse than no command, so
 * the whole productive path went.
 *
 * What was left behind was not nothing, and that is why this exists. `status`
 * printed a manual procedure — establish nothing is running, re-read the
 * revision, delete the file inside `.git` yourself — and warned, correctly, that
 * a lease deleted by hand can have been legitimately re-acquired between the
 * reading and the deletion. That is the *same* ABA the command was withdrawn
 * for, handed to a human who has no way to win it. Refusing to ship the
 * destructive operation did not remove the destructive operation; it removed the
 * only place where the race could be closed.
 *
 * `lease-recovery.ts` carries the contract in full. The three things that make
 * this command different from the one that was withdrawn:
 *
 *  - the operator names the lease **by the digest of its bytes**, so the command
 *    acts on the lease that was inspected rather than on whatever is there now;
 *  - the removal re-establishes that identity on the bytes it has **already
 *    detached**, so the window between deciding and deleting cannot be used —
 *    the lease name is never touched again except through a `link`, which cannot
 *    overwrite;
 *  - every fact the gate established is re-established at the effect, and none
 *    of them is carried across as a permission.
 *
 * `--attended` is required for the reason `release --attended` requires it: an
 * operator states they are present for *this* invocation. There is no unattended
 * break, no `--force`, and nothing anywhere that breaks a lease automatically.
 */

import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { assessLeaseRecovery, breakInspectedLease, type LeaseBreakOutcome } from '../lease/lease-recovery.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { renderLeaseStatus } from './render-lease.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_UNEXPECTED,
  exitCodeForLeaseBreakOutcome,
} from './run-exit-codes.js';

interface LeaseStatusOptions {
  readonly repository: string;
}

interface LeaseBreakOptions extends LeaseStatusOptions {
  readonly attended?: boolean;
  readonly expectedRevision: string;
  readonly ownerPid?: string;
}

/**
 * One static sentence per break outcome. Closed, ASCII only, and pinned by test.
 *
 * Beside the command rather than in `render-lease.ts`, exactly as
 * `RELEASE_OUTCOME_SENTENCES` sits beside `release`: this vocabulary has one
 * consumer, and `render-lease.ts` is shared by three commands that must not
 * acquire a reason to import the recovery module.
 *
 * The distinction they carry is the one the outcome vocabulary exists for:
 * whether *this invocation* removed something. "It is gone" and "I removed it"
 * are the same end state and different facts, and an operator who has just run a
 * destructive command is entitled to know which one they caused.
 */
export const LEASE_BREAK_SENTENCES: Readonly<Record<LeaseBreakOutcome, string>> = Object.freeze({
  LEASE_REMOVED:
    'The lease you inspected was removed: it was still the same record, byte for byte, at the\n' +
    '  moment it was detached. This repository can be started again. Note what this did not\n' +
    '  do - if the run that left the lease still has an agent process alive somewhere, that\n' +
    '  process is alive now. Removing a lease stops nothing; it stops the lease refusing.',
  LEASE_ALREADY_GONE:
    'Nothing was at the lease path, so nothing was removed by this invocation. The repository\n' +
    '  is free either way; if you expected to remove something, somebody got there first.',
  // Two reachable end states behind one outcome, and the `Reason` line is what
  // separates them: RECORD_QUARANTINED means the record that was there could not
  // be put back and is now a file inside `.git` rather than the repository's
  // lease. Saying only "nothing was removed" was true and not the whole truth,
  // which an independent review reproduced.
  LEASE_CHANGED_SINCE_INSPECTION:
    'The lease is not the one you inspected, so nothing was removed. It may have been\n' +
    '  released and legitimately re-acquired by a new run, which is exactly the case this\n' +
    '  refusal exists for. Run `agent-loop lease status` again and decide about what is there\n' +
    '  now. Do not re-run this command with the revision you already had. If the reason line\n' +
    '  says RECORD_QUARANTINED, the record that was there could not be put back because the\n' +
    '  name had been taken in that instant: it is kept beside the lease path under a name\n' +
    '  ending in .breaking-, its run has lost authority and will stop at its next checkpoint,\n' +
    '  and nothing was deleted.',
  // "Nothing was removed" is the whole promise here, and it is stated without
  // the "and nothing was touched" it used to carry. Most of these refusals are
  // reached before anything is detached; two of them - a running owner, or an
  // owner the record does not name - can only be established *on the detached
  // bytes*, and claiming an untouched lease for those cases would be false in
  // exactly the rare situation an operator most needs a true report.
  LEASE_NOT_BREAKABLE:
    'The lease is there and this is not a lease that may be broken: its owner is running, its\n' +
    '  liveness could not be established, the authorisation describes a different lease, or the\n' +
    '  filesystem refused to detach the record. The reason code says which, and nothing was\n' +
    '  removed. Where the refusal could only be established after the record had been detached,\n' +
    '  it was put back - or, if the freed name had been taken in that instant, kept beside the\n' +
    '  lease path under a name ending in .breaking- rather than deleted.',
  // The sentence used to promise a quarantine file unconditionally. It is only
  // there on one of the two paths that reach this outcome, and on the other the
  // same call had already put the record back and deleted the quarantine — so an
  // operator was sent to inspect a file that did not exist. The reason line now
  // carries the difference, and the sentence states both.
  LEASE_BREAK_VERIFICATION_FAILED:
    'A record was detached from the lease path and could not be read back, so it was neither\n' +
    '  removed nor claimed to have been. UNREADABLE_AND_RESTORED means it was put back where it\n' +
    '  was and there is nothing to inspect: the repository is as you found it, and something\n' +
    '  other than this build is stopping the record being read. UNREADABLE_AND_QUARANTINED\n' +
    '  means it could not be put back and is kept beside the lease path under a name ending in\n' +
    '  .breaking-, inert and inspectable. Look at it before deleting anything by hand.',
});

const ATTENDANCE_WITHHELD_SENTENCE =
  'Breaking a lease removes another invocation\'s authority over this repository, so it\n' +
  '  requires an operator to be present for this invocation. Nothing was inspected and\n' +
  '  nothing was removed. Pass --attended to break. There is no unattended break and no\n' +
  '  --force.';

const REVISION_UNUSABLE_SENTENCE =
  'The expected revision is not a lease revision. It is the digest `agent-loop lease status`\n' +
  '  prints under Revision, and it is how you name the lease you decided about. Nothing was\n' +
  '  inspected and nothing was removed.';

const OWNER_PID_UNUSABLE_SENTENCE =
  'The owner pid is not a process id. It is the number `agent-loop lease status` prints under\n' +
  '  Owner pid; omit the option entirely when it prints none. Nothing was removed.';

/** A lease revision is a sha-256 digest, and nothing else is accepted as one. */
const REVISION = /^[0-9a-f]{64}$/;

function report(lines: readonly string[]): void {
  process.stdout.write(`\n${lines.join('\n')}\n\n`);
}

export function registerLeaseCommand(program: Command): void {
  const lease = program
    .command('lease')
    .description(
      'Inspect the execution lease of this repository - the thing that makes at most one ' +
        'orchestrator invocation its writer at a time - and recover from one whose owner ' +
        'died. Breaking requires --attended and the revision of the lease you inspected.',
    );

  lease
    .command('status')
    .description(
      'Report the execution lease: whether one is held, by which process, for which run, ' +
        'and - when it is recoverable - the exact break command for it. Read-only.',
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

        // One assessment, rendered. The report never forms its own opinion about
        // whether a lease may be broken — see `renderLeaseStatus`.
        const assessed = assessLeaseRecovery(resolution.repository);
        process.stdout.write(renderLeaseStatus(assessed.inspection, assessed.breakable));
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
      'Remove a lease whose owner is gone, so a crashed run does not lock this repository ' +
        'forever. Removes exactly the lease named by --expected-revision, proved against the ' +
        'record it has detached, so a lease re-acquired in the meantime is left alone. ' +
        'Requires --attended. There is no --force.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .requiredOption(
      '--expected-revision <digest>',
      'The Revision printed by `agent-loop lease status` for the lease you decided about. ' +
        'Required: it is how this command knows which lease you mean.',
    )
    .option(
      '--owner-pid <pid>',
      'The Owner pid printed for that same lease. Required where one is recorded, and refused ' +
        'where none is - a crash-window lease names no process and is identified by its bytes.',
    )
    .option(
      '--attended',
      'Confirm an operator is present for this invocation. Required: this command removes ' +
        'another invocation\'s authority.',
    )
    .action(async (options: LeaseBreakOptions) => {
      try {
        // Checked before the repository is resolved, and before the lease is
        // even read: an invocation with no operator behind it should not begin
        // inspecting anything in order to say it was never going to act.
        if (options.attended !== true) {
          report(['Break        : not requested', '', ATTENDANCE_WITHHELD_SENTENCE]);
          process.exitCode = EXIT_RUN_NEEDS_OPERATOR;
          return;
        }

        if (!REVISION.test(options.expectedRevision)) {
          report(['Break        : refused', 'Reason       : EXPECTED_REVISION_UNUSABLE', '', REVISION_UNUSABLE_SENTENCE]);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        const expectedOwnerPid = parseOwnerPid(options.ownerPid);
        if (expectedOwnerPid === 'UNUSABLE') {
          report(['Break        : refused', 'Reason       : OWNER_PID_UNUSABLE', '', OWNER_PID_UNUSABLE_SENTENCE]);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
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

        const broken = breakInspectedLease(resolution.repository, {
          expectedRevision: options.expectedRevision,
          expectedOwnerPid,
        });

        report([
          `Break        : ${broken.outcome}`,
          ...(broken.detail === null ? [] : [`Reason       : ${broken.detail}`]),
          '',
          LEASE_BREAK_SENTENCES[broken.outcome],
        ]);
        process.exitCode = exitCodeForLeaseBreakOutcome(broken.outcome);
      } catch (error) {
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}

/**
 * The pid an operator typed, or `null` when they typed none.
 *
 * `UNUSABLE` rather than a silent `null`: an operator who typed `--owner-pid
 * 12x` meant to name a process, and treating that as "no pid was recorded"
 * would turn a typo into a break authorised for a *different class* of lease.
 */
function parseOwnerPid(given: string | undefined): number | null | 'UNUSABLE' {
  if (given === undefined) return null;
  if (!/^[1-9][0-9]{0,9}$/.test(given)) return 'UNUSABLE';
  const pid = Number.parseInt(given, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 'UNUSABLE';
}
