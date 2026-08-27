/**
 * `agent-loop publication authorisations` — reading what this build recorded it
 * was permitted to do with nobody present (V4 slice 15).
 *
 * ── Why a group of its own, and not a flag on `delivery` ───────────────────
 *
 * Three reasons, and the first is measured rather than argued. `delivery`
 * carries `--repository` as a `requiredOption`, and on the Commander this build
 * ships a parent's required option is enforced **even when a subcommand is the
 * one running** — so `delivery authorisations` would demand the exact argument
 * this command must not have. Removing it from `delivery` to make room would
 * change a shipped contract that five other commands state in the same words.
 *
 * Second, on meaning: everything `delivery` does is about one task's delivery in
 * one repository, and this store is deliberately outside every repository.
 *
 * Third, on the name. There is no `audit` command here and there should not be:
 * `AUDITED_FORGE_ACTS` has one member and `AUDITED_INVOCATION_MODES` has one, so
 * a general audit noun would promise a surface over every AO act and deliver a
 * listing of one act performed in one mode. This repository already treats a
 * registered name as a promise. The group is named for the thing it is about and
 * the subcommand for what the store holds — authorisations, not publications,
 * the same distinction the directory's own name makes.
 *
 * ── No `--repository`, and that is the point ───────────────────────────────
 *
 * The store root is a pure function of the OS user identity, resolved through
 * `os.userInfo()`; no flag, environment value or repository file can move it. A
 * `--repository` here would be an argument an operator would reasonably read as
 * scoping and that would scope nothing. And it would defeat the case the store
 * exists for: a record outlives its checkout, so a command that demanded a
 * resolvable repository could not read the records for one that is gone.
 *
 * `doctor` is the precedent and it is the oldest command here: no options at
 * all, reads the operator profile, never sees a repository.
 *
 * The other half of that is what it buys. `resolveRepository` starts Git child
 * processes; not taking a repository is what makes "this command starts no
 * process" true by construction rather than by care.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *
 * It reads one directory under the operator's profile and grades what is in it.
 * It creates nothing — a store that is not there is a reading, not an invitation
 * to make one — writes nothing, removes nothing, and asks nothing outside that
 * root. It does not ask a forge what any ref holds now, and it does not open the
 * declaration as it stands today: a policy file edited this morning may not
 * change what a record from last week means.
 *
 * ── The exit contract, and the grade this command deliberately does not give ─
 *
 *  - **0** — a listing was produced. That includes a listing containing entries
 *    this build could not read: each one is named, counted and explained in the
 *    report, and the command answered the question it was asked;
 *  - **3** — no listing could be produced, because the store itself could not be
 *    read: the root is not a directory, could not be enumerated, has a link on
 *    its path, or the profile could not be resolved.
 *
 * The first draft of this graded a damaged entry non-zero, and three measured
 * facts say that is wrong.
 *
 * **Code 3 means "the durable state needs an operator before anything may run",
 * and a damaged record blocks nothing.** No stored record is ever an input that
 * permits a publication — the suite pins that, and the one place the effect path
 * reads a record at all is the write it has just made, read back before the
 * remote is contacted, which can only refuse. And the next unattended
 * publication mints a fresh random event identity, so a damaged neighbour cannot
 * even collide with it. Grading 3 would assert a blocking condition that does
 * not exist.
 *
 * **`RECORD_ABSENT` is an ordinary, permanent shape of this store.** An event
 * directory with nothing in it is what a crash between the `mkdir` and the
 * rename leaves, and what every refusal after the `mkdir` leaves, because that
 * protocol deletes nothing ever. A grade that went non-zero for one would go
 * non-zero for good.
 *
 * **Nothing prunes the store, so a non-zero grade is permanent.** `L-V4-14-1`
 * is open and retention is deferred, so one unreadable directory would pin this
 * command non-zero forever with no way inside this tool to clear it — a signal
 * nobody can act on and everybody learns to ignore.
 *
 * So the finding goes in the report and the exit stays 0. That is the shipped
 * precedent as well as the argument: `lease status` sets `EXIT_RUN_OK`
 * unconditionally, including for a lease it cannot parse, because a status
 * command that exited non-zero would be unusable in exactly the scripts that
 * need it — "the code in the report is what a caller reads".
 *
 * The store-level grade is 3 for a different reason than "a record is
 * unreadable": a store whose root cannot be read is a store the **next**
 * authorised publication cannot write into, and that is the same durable
 * condition the writer already grades 3 as `PUBLICATION_AUDIT_NOT_DURABLE`.
 *
 * Two codes this command never produces, and one it can. It never exits 4 or 5:
 * a read that produced an answer was neither refused nor is it a step in
 * something to be called again. It **can** exit 6, and that is not this
 * command's doing — the runtime gate at the CLI entry runs before every action,
 * is inherited by nested subcommands, and terminates on a machine outside the
 * support contract before this report is built. An operator inspecting an audit
 * store on such a machine sees the gate's message and no listing.
 */

import type { Command } from 'commander';

import type { PathProvider } from '../config/internal/path-provider.js';
import { formatSafeError } from '../core/safe-error.js';
import {
  listHeadPublicationAuthorisations,
  type HeadPublicationAuditListingOutcome,
} from '../deliver/head-publication-authorisation-listing.js';
import { renderPublicationAuthorisations } from './render-publication-authorisations.js';
import {
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_UNEXPECTED,
  type CliExitCode,
} from './run-exit-codes.js';

/**
 * The exit grade of each listing outcome. Total by type, and written out member
 * by member rather than derived, so a new outcome is a compile error and a
 * grading decision rather than a default.
 */
export const AUDIT_LISTING_EXIT: Readonly<
  Record<HeadPublicationAuditListingOutcome, CliExitCode>
> = Object.freeze({
  // A listing was produced. The three below are one answer to a caller and three
  // answers to a person, which is the split the header argues for: the finding
  // is in the report, and the report is what a person reads.
  READ: EXIT_RUN_OK,
  READ_WITH_UNUSABLE_ENTRIES: EXIT_RUN_OK,
  STORE_ABSENT: EXIT_RUN_OK,
  // No listing could be produced. Not because a record is unreadable, but
  // because the store itself is — which is also the store the next authorised
  // publication would have to write into.
  STORE_PATH_UNSAFE: EXIT_RUN_NEEDS_OPERATOR,
  STORE_UNREADABLE: EXIT_RUN_NEEDS_OPERATOR,
  PROFILE_UNAVAILABLE: EXIT_RUN_NEEDS_OPERATOR,
});

/**
 * The internal seam, and the only one.
 *
 * `fixedPathProvider` is test-only and unreachable from the CLI, and this build
 * has no productive path override at all — so a scratch profile is reached the
 * way `registerDeliveryCommand` already reaches one, through a parameter
 * `index.ts` never passes.
 */
export interface PublicationCommandSeams {
  readonly pathProvider?: PathProvider | undefined;
}

export const PUBLICATION_GROUP_DESCRIPTION =
  'Read what this build recorded about publications it was permitted to attempt with nobody ' +
  'present. Read-only, and local: nothing here contacts a forge, starts git, takes a lease or ' +
  'writes anything.';

export const AUTHORISATIONS_DESCRIPTION =
  'List the head-publication authorisation records under this user profile - one per ' +
  'publication this build was permitted to attempt with nobody present, each written before ' +
  'that invocation contacted a delivery remote and none written afterwards. It reports what ' +
  'each record says, and whether that record\'s own digest recomputes from the values it ' +
  'records and from the directory it sits in. It does not ask a forge what any ref holds now, ' +
  'and it does not compare anything against the declaration as it stands today. A record is ' +
  'evidence for a person and never an input to an authority: no stored record is ever an ' +
  'input that permits a publication. Any process running as this OS user can write a record that reads ' +
  'exactly like the rest, and can delete one without trace, so this is neither a complete ' +
  'history nor evidence of who wrote what - and an attended publication records nothing here ' +
  'at all. Takes no repository: the store is outside every repository, each record names its ' +
  'own, and a record outlives the checkout it was about.';

/**
 * Writes the report, and survives the reader going away.
 *
 * This is the first command in the build whose output is deliberately unbounded
 * — one block per event, forever, with no limit flag and no machine-readable
 * form — so it is the first whose operator has a reason to pipe it into `head`,
 * `more` or a pager they then close. Measured: past roughly ninety records the
 * report exceeds the pipe buffer, the reader's exit makes the next write raise
 * `EPIPE` on this stream, and **an unhandled `error` event on a stream is an
 * uncaught exception in this process** — a raw Node stack on stderr, outside the
 * safe formatter, and exit 1 telling an operator the build is defective for
 * doing exactly what this command's own exit contract says must work in a
 * script.
 *
 * The rule is not new here; this build states it twice, about the streams of the
 * processes it starts. It had never applied to its own stdout because no command
 * had produced enough output to reach it.
 *
 * A closed reader is a normal end, not a failure: the grade this invocation
 * already worked out stands, and nothing about the store is in question.
 *
 * Everything else is reported here rather than re-thrown, and that is the second
 * version of this listener. The first re-threw, with a comment saying the error
 * was "left to the caller's `catch`" — measured false: the event is emitted from
 * a tick, long after the action's `try` has closed, so a throw from inside the
 * listener is an uncaught exception producing exactly the raw stack this guard
 * exists to remove. It was behaviourally identical to having no listener at all.
 * So the other arm does the reporting itself, through the same safe formatter
 * (AO-002) and the same exit code the caller's own arm would have used.
 */
function writeReport(text: string): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') return;
    process.stderr.write(`${formatSafeError(error)}\n`);
    process.exitCode = EXIT_RUN_UNEXPECTED;
  });
  process.stdout.write(text);
}

export function registerPublicationCommand(
  program: Command,
  seams: PublicationCommandSeams = {},
): void {
  const publication = program.command('publication').description(PUBLICATION_GROUP_DESCRIPTION);

  publication
    .command('authorisations')
    .description(AUTHORISATIONS_DESCRIPTION)
    .action(() => {
      try {
        const listing = listHeadPublicationAuthorisations(seams.pathProvider);
        writeReport(renderPublicationAuthorisations(listing));
        process.exitCode = AUDIT_LISTING_EXIT[listing.outcome];
      } catch (error) {
        // The listing is total and does not throw, so reaching here is a defect
        // in this build rather than a state of the store. It is reported the way
        // every other command reports one: through the central safe formatter,
        // never as an exception message (AO-002).
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
