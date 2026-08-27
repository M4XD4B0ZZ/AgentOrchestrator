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
 * ── Asking about one branch (V4 slice 17) ──────────────────────────────────
 *
 * Four flags, all four or none: `--forge-host`, `--forge-owner`, `--forge-name`
 * and `--ref`. Given together they narrow **what is printed** to the records
 * naming that one branch, compared character for character on those four values
 * and on no other. Given in part they are refused, with exit 2 and nothing read.
 *
 * Three fields for the repository and not one string. There is no parser in
 * this build that turns `host/owner/name` into an identity — the one that
 * exists is URL-shaped and refuses that exact spelling — so a single argument
 * would need a third identity grammar and would ship a separator trap. The
 * operator already types these as three keys in the declaration this store's
 * records were written under, and the permission path already compares them as
 * three exact fields.
 *
 * The commit, the task, the checkout and the local remote name are **not** part
 * of the query, and each exclusion is a decision recorded where the query type
 * is declared. Two publications of one branch differ in all four, and a query
 * using any of them would answer with part of a branch's history and print it
 * as the whole.
 *
 * It is a filter and not an index, and the report says so in as many words.
 * Every entry in the store is still opened and graded to answer the question;
 * what the query changes is which of them are printed. `L-V4-14-3` is narrowed
 * again and is not closed.
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
  type HeadPublicationBranchQuery,
} from '../deliver/head-publication-authorisation-listing.js';
import { PUBLISHABLE_REF } from '../deliver/internal/delivery-ref-grammar.js';
import {
  isForgeHost,
  isForgeOwner,
  isForgeRepositoryName,
} from '../deliver/internal/forge-identity-grammar.js';
import { line } from './render-attended-run.js';
import { renderPublicationAuthorisations } from './render-publication-authorisations.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
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

/* ── Asking about one branch (V4 slice 17) ──────────────────────────────── */

/**
 * The four flags, as Commander hands them over.
 *
 * Four `option`s and never `requiredOption`s. Their absence has a meaning — it
 * is the whole-store listing this command shipped with — and a `requiredOption`
 * would let Commander refuse a missing one with exit **1**, this build's code
 * for a defect inside the tool, on a bare stderr line that never passes through
 * the safe formatter. Measured against the shipped artefact. V4 slice 12 made
 * the same demotion for `--task` and for the same reason.
 */
export interface AuthorisationsOptions {
  readonly forgeHost?: string | undefined;
  readonly forgeOwner?: string | undefined;
  readonly forgeName?: string | undefined;
  readonly ref?: string | undefined;
}

/**
 * Why a query was not usable as written. A closed set of five.
 *
 * Every member is refused before anything is read, so none of them is a
 * statement about the store — and none may be graded like one.
 */
export const BRANCH_QUERY_REFUSALS = [
  /**
   * One, two or three of the four were given.
   *
   * There is no partial query and there must not be one: three of the four
   * fields name a repository and every branch in it, and the fourth names a ref
   * in every repository. Either is a question this command would have to answer
   * with somebody else's history.
   */
  'QUERY_FIELDS_MISSING',
  'FORGE_HOST_UNUSABLE',
  'FORGE_OWNER_UNUSABLE',
  'FORGE_NAME_UNUSABLE',
  /** Not `refs/heads/<branch>` under the grammar this build publishes with. */
  'REF_UNUSABLE',
] as const;

export type BranchQueryRefusal = (typeof BRANCH_QUERY_REFUSALS)[number];

/**
 * One sentence per refusal, total by type.
 *
 * Each says what was wanted rather than what was wrong with what was given: the
 * value an operator typed is not echoed back, because AO-002 keeps operator
 * input out of refusals and because a refused value has been established to be
 * nothing.
 */
export const BRANCH_QUERY_REFUSAL_DETAIL: Readonly<Record<BranchQueryRefusal, string>> =
  Object.freeze({
    QUERY_FIELDS_MISSING:
      'A branch is named by four values together - --forge-host, --forge-owner, --forge-name\n' +
      '  and --ref - or by none of them, which lists the whole store. Three of them name a\n' +
      '  repository and every branch in it; the fourth names a ref in every repository. Neither\n' +
      '  is the question this command answers.',
    FORGE_HOST_UNUSABLE:
      'A host here is a lowercase dotted name of at least two labels, with no port, no scheme\n' +
      '  and no path - the spelling every identity this build resolves is carried in. Nothing\n' +
      '  is folded to reach it: a record is compared against what you typed.',
    FORGE_OWNER_UNUSABLE:
      'An owner here is letters, digits and hyphens, at most thirty-nine of them, and neither\n' +
      '  the first nor the last may be a hyphen. That is the rule this build applies to an\n' +
      '  owner it resolves, applied to the one you asked about.',
    FORGE_NAME_UNUSABLE:
      'A repository name here is letters, digits, dots, underscores and hyphens, at most one\n' +
      '  hundred of them, not beginning with a hyphen and not made only of dots. That is the\n' +
      '  rule this build applies to a name it resolves, applied to the one you asked about.',
    REF_UNUSABLE:
      'A ref here is the whole ref this build would record - refs/heads/ followed by a branch\n' +
      '  name - and never a bare branch name. A bare name would have to be turned into a ref\n' +
      '  by this command guessing, and refs/heads/ is itself a branch name a ref may contain,\n' +
      '  so one guess would stand for two different stored values.',
  });

/**
 * Every option description this subcommand registers, and every refusal
 * sentence it can print, in one exported list.
 *
 * Exported because both are text an operator reads and neither was reached by
 * any vocabulary sweep for one commit — the report's sentences are swept through
 * `AUDIT_PRINTED_TEXT`, and these were simply outside it. A review found the
 * assertion that looked like it swept them applying the rule to the refusal's
 * *code* rather than to its sentence.
 *
 * Built from the map rather than listed, so a sixth refusal is swept without
 * anybody remembering to add it. The option descriptions are read off the
 * registered command by the suite, for the same reason.
 */
export const BRANCH_QUERY_PRINTED_TEXT: readonly string[] = Object.freeze(
  BRANCH_QUERY_REFUSALS.map((refusal) => BRANCH_QUERY_REFUSAL_DETAIL[refusal]),
);

/**
 * What an invocation asked for. Three answers and no fourth.
 *
 * `WHOLE_STORE` is the shipped command, unchanged. `ONE_BRANCH` carries the
 * query in {@link HeadPublicationBranchQuery}'s own field names rather than in
 * the flags' — the rename that keeps a value of this shape from being an
 * argument to the publication mint.
 */
export type BranchQueryReading =
  | { readonly kind: 'WHOLE_STORE' }
  | { readonly kind: 'ONE_BRANCH'; readonly query: HeadPublicationBranchQuery }
  | { readonly kind: 'REFUSED'; readonly refusal: BranchQueryRefusal };

/**
 * Reads the four flags, and nothing else.
 *
 * A pure function of four strings. It resolves no profile, builds no path and
 * opens nothing — which is what makes a ref that looks like a path a string
 * that names no record rather than a path anything walks. `refs/heads/../x` is
 * a ref the writer's own grammar admits, and it reaches nothing here but a
 * comparison.
 *
 * The grammars are the writer's, imported rather than restated: every identity
 * this build can put in a record passed exactly these rules on the way in, so a
 * query bounded by them can name any record this build wrote. A record carrying
 * a value outside them — which only something other than this build can write —
 * cannot be named by a query, is counted as naming another branch, and is shown
 * in full by the whole-store listing. That is `L-V4-17-2`.
 *
 * Deliberately **not** bounded by `SUPPORTED_FORGE_HOSTS`. That constant says
 * which hosts this build may publish to *now*; this store holds what was
 * recorded *then*, and a reader bounded by a current constant could not ask
 * about a record the current configuration can no longer produce. It is the
 * same reason this command does not open the declaration as it stands today.
 */
export function readBranchQuery(options: AuthorisationsOptions): BranchQueryReading {
  const { forgeHost, forgeOwner, forgeName, ref } = options;
  const supplied = [forgeHost, forgeOwner, forgeName, ref].filter(
    (value) => value !== undefined,
  ).length;

  if (supplied === 0) return { kind: 'WHOLE_STORE' };
  if (
    forgeHost === undefined ||
    forgeOwner === undefined ||
    forgeName === undefined ||
    ref === undefined
  ) {
    return { kind: 'REFUSED', refusal: 'QUERY_FIELDS_MISSING' };
  }

  // In a fixed order, so one invocation gets one answer. Each grammar refuses a
  // leading `-` by construction, which is what answers a measured Commander
  // shape: `--ref --forge-owner` binds the second flag as the first's value.
  if (!isForgeHost(forgeHost)) return { kind: 'REFUSED', refusal: 'FORGE_HOST_UNUSABLE' };
  if (!isForgeOwner(forgeOwner)) return { kind: 'REFUSED', refusal: 'FORGE_OWNER_UNUSABLE' };
  if (!isForgeRepositoryName(forgeName)) return { kind: 'REFUSED', refusal: 'FORGE_NAME_UNUSABLE' };
  if (!PUBLISHABLE_REF.test(ref)) return { kind: 'REFUSED', refusal: 'REF_UNUSABLE' };

  return {
    kind: 'ONE_BRANCH',
    query: Object.freeze({
      forgeHost,
      forgeOwner,
      forgeName,
      authorisedRef: ref,
    }),
  };
}

export const PUBLICATION_GROUP_DESCRIPTION =
  'Read what this build recorded about publications it was permitted to attempt with nobody ' +
  'present. Read-only, and local: nothing here contacts a forge, starts git, takes a lease or ' +
  'writes anything.';

export const AUTHORISATIONS_DESCRIPTION =
  'List the head-publication authorisation records under this user profile - one per ' +
  'publication this build was permitted to attempt with nobody present, each written before ' +
  'that invocation contacted a delivery remote. Where the invocation that wrote one went on ' +
  'to finish its publication processing and could record what it had called and last read, ' +
  'that is shown beside it as a second, separate document; where no such document is there, ' +
  'the report says so and says what its absence does not mean. It reports what ' +
  'each record says, and whether that record\'s own digest recomputes from the values it ' +
  'records and from the directory it sits in. It does not ask a forge what any ref holds now, ' +
  'and it does not compare anything against the declaration as it stands today. A record is ' +
  'evidence for a person and never an input to an authority: no stored record is ever an ' +
  'input that permits a publication. Any process running as this OS user can write a record that reads ' +
  'exactly like the rest, and can delete one without trace, so this is neither a complete ' +
  'history nor evidence of who wrote what - and an attended publication records nothing here ' +
  'at all. Given --forge-host, --forge-owner, --forge-name and --ref together, it shows only ' +
  'the records naming that one branch, compared character for character on those four values ' +
  'and on no other; anything it did not read in full is shown whichever way you ask, because ' +
  'an entry it could not read all of is one this report may not leave out. It still reads ' +
  'every entry in the store to answer that, because there is no index. A value outside the ' +
  'rules this build records an identity under is refused rather than compared. Takes no ' +
  'repository checkout: the store is outside every ' +
  'repository, each record names its own, and a record outlives the checkout it was about.';

/**
 * Writes the report, and survives the reader going away.
 *
 * This is the first command in the build whose output is deliberately unbounded
 * — asked nothing, one block per event, forever, with no limit flag and no
 * machine-readable form; the V4 slice 17 branch filter narrows what is printed
 * and bounds nothing, because a store can hold any number of events for one
 * branch — so it is the first whose operator has a reason to pipe it into `head`,
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
let guarded = false;

function writeReport(text: string): void {
  // Attached at most once for the life of the process, and never removed. Both
  // halves are forced by the same fact: the event arrives from a tick, long
  // after this function has returned, so a listener removed after the write
  // would not be there when it is needed — and one attached per call is a leak.
  // The shipped CLI runs this action once, so the difference is invisible there;
  // it is the suite that drives it repeatedly, and a review measured Node's own
  // warning at the eleventh listener.
  if (!guarded) {
    guarded = true;
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return;
      process.stderr.write(`${formatSafeError(error)}\n`);
      process.exitCode = EXIT_RUN_UNEXPECTED;
    });
  }
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
    .option(
      '--forge-host <host>',
      'With the three below: show only the records naming that one branch. A host as this ' +
        'build records one it resolved - lowercase, dotted, no port and no scheme. Never ' +
        'defaulted: the record contract admits any host, so a default would assert something ' +
        'no record here is bound by. A value outside that rule is refused rather than ' +
        'compared, and a record carrying one cannot be named by any query.',
    )
    .option(
      '--forge-owner <owner>',
      'The owning user or organisation as this build records one it resolved. Compared ' +
        'character for character; case is not folded, because the permission this store is ' +
        'about does not fold it either.',
    )
    .option(
      '--forge-name <name>',
      'The repository name as this build records one it resolved. Compared character for ' +
        'character, and refused rather than compared if it is outside that rule.',
    )
    .option(
      '--ref <ref>',
      'The whole ref, refs/heads/ and all, as this build records one. A bare branch name is ' +
        'refused rather than turned into a ref, because refs/heads/ is itself something a ' +
        'branch name may contain and one guess would stand for two stored values.',
    )
    .action((options: AuthorisationsOptions) => {
      try {
        // The arguments first, and strictly before anything is read. Whether an
        // invocation is refused for how it was written must not depend on what
        // is in the store: the same argv against an absent store, an unreadable
        // one and a full one has to answer the same way, and V4 slice 12
        // measured the version of this defect where it did not.
        const asked = readBranchQuery(options);
        if (asked.kind === 'REFUSED') {
          writeReport(
            `\n${line('Query', asked.refusal)}\n  ${BRANCH_QUERY_REFUSAL_DETAIL[asked.refusal]}\n\n`,
          );
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        // The listing never learns there was a query. Its grade is over every
        // entry in the store, its tally counts every entry in the store, and
        // every readable record's outcome is read and graded whichever branch it
        // names — so `READ` goes on meaning what its own sentence says. The
        // query chooses what is printed from the result.
        const listing = listHeadPublicationAuthorisations(seams.pathProvider);
        writeReport(
          renderPublicationAuthorisations(listing, asked.kind === 'ONE_BRANCH' ? asked.query : null),
        );
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
