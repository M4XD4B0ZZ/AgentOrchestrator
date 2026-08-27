# ADR — reading the evidence nobody could read

**Date** 2026-08-27
**Status** accepted
**Slice** V4 slice 15
**Supersedes** nothing. **Superseded by** nothing.
**Amends** one.

`2026-08-27-adr-unattended-publication-audit.md`, in three places. §13 lists "an
operator-facing command that lists or searches the store" among that slice's
non-goals, each of which "needs its own decision" — this is that decision, and
it takes up the *listing* half only. §14's `L-V4-14-3` says "there is no command
that does the reading", which stops being true. And §10's crash table says "a
reader opens by name and never enumerates", which becomes the narrower sentence
that is still true: the record is opened by name inside an event directory that
is never enumerated, and it is the store **root** that this slice enumerates.

## The decision

**The unattended-publication authorisation store gets exactly one operator-facing
read: `agent-loop publication authorisations`. It lists every entry in the store,
grades each one with the contract that wrote it, changes nothing, and asks
nothing outside that one directory.**

One new command group with one subcommand, no options at all. One new reader
module, one new renderer, one location module extracted from the writer. No new
record, no new field, no new flag on any existing command, no change to the
publication path.

## The three sentences the contract rests on

> **It reports what is in the store now, and never what happened.** Every record
> was written before an invocation contacted a delivery remote, so no reading of
> one can say a publication was attempted, that a ref exists, or that this build
> created it.

> **It could not establish what is recorded is not nothing is recorded.** Those
> are two reports, two vocabulary members and — where it matters — two exit
> grades, and neither is ever printed as the other.

> **Reading evidence grants nothing.** No record is closer to authorising a
> publication for having been read, and the type this reader hands out is
> measurably not an argument the publication mint accepts.

## 1. Command scope

Exactly the store at
`<OS user profile>/.agent-orchestrator/head-publication-authorisations/`, and
nothing else. Not the delivery observation, not the merge receipt, not the
verification history, not the conclusion — those live inside the repositories
they describe and have their own reports. Not a general audit surface: there is
one audited act (`AUDITED_FORGE_ACTS` has one member) performed in one mode
(`AUDITED_INVOCATION_MODES` has one), and a command promising more than that
would be a name promising a surface this build does not have.

## 2. The name, and why not the three obvious alternatives

`agent-loop publication authorisations` — a group with one subcommand, the shape
`lease` already ships.

**Not a flag or a subcommand on `delivery`**, and this is measured rather than
argued. `delivery` carries `--repository` as a `requiredOption`, and on the
Commander this build ships **a parent's required option is enforced even when a
subcommand is the one running**: `delivery authorisations` fails with
`commander.missingMandatoryOptionValue` before the child's action is reached.
Making room would mean removing `--repository` from `delivery` — a change to a
contract five other commands state in the same words. `delivery` is also the
wrong home on meaning: everything it does is about one task's delivery in one
repository, and this store is deliberately outside every repository.

**Not `agent-loop audit`.** One act, one mode, and a docstring on each saying a
second member needs its own decision. This repository already treats a
registered name as a promise — the suite refuses any registered option whose
name contains `force`, `unattended`, `adopt`, `takeover` or `steal` on exactly
that ground.

**Not a bare top-level `authorisations`.** It would be the first top-level name
here needing a qualifier it cannot have; `doctor`, `run`, `block`, `release`,
`lease` and `delivery` are all single unqualified words. The two-word form
carries the qualifier the store's own directory name carries, and for the same
reason: the directory is `head-publication-authorisations` and not
`head-publications`, because a directory called the latter "would make its own
existence a claim that things were published".

The group is inert by construction: it registers no action of its own, its one
subcommand registers no option, and the suite pins the subcommand list to
exactly `['authorisations']` so a second one is a decision rather than an
accident.

## 3. Repository requirement: none, and it must be none

The command takes **no `--repository`** and no options at all.

**The root is not a function of any repository.** It is
`join(orchestratorHome(provider), 'head-publication-authorisations')`, and
`orchestratorHome` resolves through `os.userInfo()` — no environment block, no
parameter, no flag. A `--repository` here would be an argument an operator would
reasonably read as scoping and that would scope nothing.

**Each record already names its own subject**, byte-exact: `repositoryRoot`,
`host`, `owner`, `name`, `declaredRemote`, `ref`, `commit`, `taskId`.

**Requiring one would defeat the case the store exists for.** The record outlives
the checkout — slice 14 drives a case that deletes the whole repository and reads
the record back unchanged — so a command demanding a resolvable repository could
not read the records for a repository that is gone. That is not hypothetical: on
the machine this slice was written on, the store holds sixteen records and **not
one** of their `repositoryRoot` paths still exists.

**And it is what makes "starts no program" structural.** `resolveRepository`
starts Git children; its value-import closure carries a process spawner. Not
taking a repository is why this command's closure does not.

`doctor` is the precedent and it is the oldest command here: zero options, reads
the operator profile, never sees a repository.

## 4. Enumeration root

`headPublicationAuditRoot(provider)`, the same pure function the writer uses,
moved into `deliver/internal/head-publication-audit-location.ts` together with
the two names, and re-exported from the store so no slice-14 caller changes.

The move is not tidiness. The store module is the **writer**: its value-import
closure carries the exclusive `mkdir`, the crash-safe staging write and the
`rename` that publishes bytes. A read-only listing that had to import it to learn
a directory name would have carried all of that, and "this command creates
nothing" would have stopped being a fact about the import graph. This repository
has already made exactly this move once and written down why —
`internal/delivery-ref-grammar.ts`: "a second authority importing it *for a
regular expression* would have widened that set without widening what anybody can
do — the pin would have had to be loosened, and a loosened pin measures less."

Not moved: `isValidRunId`, which ships beside the exclusive `mkdir` in
`doctor/run-directory.ts`. The reader imports it, because the name grammar must
be the producer's own and a second spelling could only drift. The cost is stated
rather than claimed away: that module and `doctor/safe-write.ts` are in the
reader's closure and both contain writers. The guarantee is therefore carried by
a source sweep — the reader names no `mkdirSync`, `writeFileSync`, `renameSync`,
`createRunDirectory` or `writeFileAtomically` — and by a measurement, which is
the stronger of the two: the suite hashes every path and every byte under the
profile before and after a listing and requires them identical, including for a
store containing damaged entries.

## 5. Entry discovery

Direct children of the root, and only those. Never a grandchild: the event
directory is **never enumerated**, and the record is opened by name inside it.
That is slice 14's own rule and it is why a staging file left by a crash is not
mistaken for a record — a file called `authorisation.json` is only ever created
by the rename that completes a write, so it is never a prefix of one.

Each child is classified by one `lstat`, in this order, and the order is the
contract:

1. `lstat` fails → `UNRECOGNISED_ENTRY`. This build does not read an entry it
   could not classify. It is the fail-closed direction, and it is the one arm no
   fixture here drives: an `lstat` that fails on a name `readdir` just returned
   needs a race. It is **not** unreachable, which was measured rather than
   supposed — a review reached it 189 times in six seconds by churning the store
   from a worker thread while listing it, with the listing throwing zero times
   and never leaving its two `READ` outcomes. It is not driven here because a
   race is not a fixture, and `L-V4-15-2` says so.
2. a symbolic link or a Windows junction → `UNRECOGNISED_ENTRY`, never followed.
   Measured: both answer `isSymbolicLink()` true and `isDirectory()` false, and
   `mklink /J` needs no elevation.
3. not a directory → `UNRECOGNISED_ENTRY`. A **file** whose name is a perfectly
   valid event id is refused here and nowhere else.
4. a name failing `isValidRunId` → `UNRECOGNISED_ENTRY`.
5. otherwise an event directory, and the record is read.

## 6. Entry validation, and the one thing an enumerating reader cannot do

The record is graded by slice 14's contract, refactored so there is one parser,
one version gate and one binding comparison in the build. The listing reaches it
through a second entry point, and the difference between the two is the whole of
what this section is about.

Slice 14's reader takes a subject "supplied by the reader and never taken from
the record", because "reading the identity out of the record and then checking it
against itself would make the check a tautology". **An enumerating reader has no
such subject.** It holds exactly one fact about an entry that did not come out of
the bytes: the directory's own name. `taskId` and `repositoryRoot` can only come
from the document.

So the listing grades under `{eventId: <directory name>, taskId: <from the
record>, repositoryRoot: <from the record>}`, and what that still catches was
measured rather than reasoned:

| planted | reading |
| --- | --- |
| any single field edited without recomputing the digest — including `taskId` and `repositoryRoot` themselves | `NOT_THIS_EVENT` |
| a record copied out of another event directory | `NOT_THIS_EVENT` |
| a self-consistent record sealed for a different event name | `NOT_THIS_EVENT` |

The first survives because every field is *also* a digest input in its own right,
so rebuilding the subject from an edited document does not rebuild the digest.
What is lost is the sentence: the binding proves the payload is bound **to the
name of the directory it sits in**, not "to this event, task and repository". The
report says the former and never the latter.

It also catches one thing the binding alone could not, and this was found only
after four independent lenses had walked past it. The digest covers **both**
event identities — the directory's name and the one inside the document — as
separate inputs, so a digest recomputed over a *pair that disagrees* is
self-consistent and recomputes cleanly. The writer never produces such a pair: it
sets both from one value, and the exclusive `mkdir` refuses any name but that
one. **So a record whose own `eventId` is not the directory it sits in cannot
have come from this build's writer**, and it used to read
`HISTORICAL_AUTHORISATION` while carrying 128 characters of chosen text in the
one field the report held back. The grader now compares the two before it
compares the digest, and answers `NOT_THIS_EVENT`, which is already exactly that
meaning. A first fix had papered the symptom over with a longer sentence; this is
the cause.

What it never caught and still does not: a whole record recomputed by somebody
who can write in the store. There is no key material in this build. `L-V4-14-2`.

## 6a. A forged record does not get to choose what the report says

Two consequences of the contract that nobody had stated, both measured here:

**`eventId` inside the document is unvalidated text.** The schema bounds it at
128 characters and checks no grammar, and the binding covers both it and the
directory name — so a forged record can read `HISTORICAL_AUTHORISATION` while
claiming any identity it likes. The report therefore prints **the directory
name** as the entry's identity and never the record's own field. A driven case
plants 128 characters of chosen text and requires it absent from the output.

**Nine fields are bounded in length and in nothing else**, so a record can carry
a newline, an escape sequence or a bidirectional override. Left alone, one forged
record would print itself as several plausible entries, or reverse one without
changing a byte — a forgery misrepresenting the *reading*, which is worse than
the forgery this build already concedes. Every recorded value is therefore
printed with each character of one closed class replaced by `<U+XXXX>`: the C0
and C1 controls, the twelve bidirectional formatting characters, and the line and
paragraph separators. Most of those are not control characters, and no sentence
anywhere calls the class that any more, because one did and it was false the
moment the class widened. **Nothing outside the class is changed**: a path with
an umlaut, a hundred-character owner and a hyphenated branch all print exactly as
recorded.

## 7. Broken-entry policy: surface, count, name, continue

Events are independent. One damaged directory says nothing about the twenty
beside it, so a listing that stopped at the first would hide unrelated evidence
for no gain, and one that skipped it would look complete and would not be.

Every entry is listed. A damaged one is named, counted in the `Entries` line as
"not read", and carries a sentence saying what it turned out to be. Nothing is
repaired, moved, cleaned up or normalised.

The vocabulary is closed and eight members wide, from two places. **Four** are
the store's own reading vocabulary under a `RECORD_` prefix, mapped one for one:
they are answers about a *document*. **Four** are established by the listing,
because they are answers about an *entry* and the grader never sees one — it is
only ever reached with bytes in hand. `HISTORICAL_AUTHORISATION` is the good
answer and carries no prefix; `RECORD_ABSENT` and `RECORD_UNREADABLE` are settled
from an errno and a file test before any bytes exist; `UNRECOGNISED_ENTRY` is
settled before the record is looked for at all:

| member | meaning |
| --- | --- |
| `HISTORICAL_AUTHORISATION` | a record this build read, bound to the name of the directory it sits in |
| `RECORD_ABSENT` | an event directory with nothing at the record's name |
| `RECORD_EMPTY` | a file at the record's name holding no bytes |
| `RECORD_UNREADABLE` | a link, a non-file, or a read that did not complete |
| `RECORD_MALFORMED` | bytes that are not a record this build declares — including one past the size bound |
| `RECORD_UNSUPPORTED_VERSION` | a contract version this build does not read |
| `RECORD_NOT_THIS_EVENT` | the digest does not recompute for this directory |
| `UNRECOGNISED_ENTRY` | not an event directory: a link, a non-directory, or a name this build would not mint |

Three of those distinctions are deliberate and each was argued for:

**`RECORD_ABSENT` apart from `RECORD_EMPTY`.** The write protocol publishes by
renaming a *complete* staging file, so it cannot leave an empty one behind.
Something made it. Folding the two would say the same thing about a crash and
about a file somebody wrote.

**`RECORD_UNREADABLE` apart from `RECORD_MALFORMED`.** A permission problem and
a document problem send a person to different places.

**`RECORD_UNSUPPORTED_VERSION` apart from both.** A record from a later build is
refused rather than guessed at, and none of its fields is shown, because none of
them has been checked.

None of the eight is named `VALID`, `CURRENT`, `AUTHORISED`, `OK` or `PERMITTED`,
for the reason slice 14 gives about its own: a member named `AUTHORISED` is one
somebody switches on.

## 8. Deterministic order

**Sorted by entry name, by code-unit comparison, in two tiers.** Tier one is
every entry this build reads as an event directory; tier two is everything else.
Within each, ascending by name. Names in one directory are unique, so the order
is total with no tie-break.

**Not the filesystem's order.** Measured on this NTFS volume: `readdir` answers
in the directory index's own case-folded collation — `a-entry`, `B-entry`,
`_under` — which is not the order this build prints, and is not an order any
filesystem promises. The fixture that pins the sort contains exactly such names,
so the sort is load-bearing rather than incidental.

**Not `authorisedAt`.** Four of the eight readings do not have one, and the
contract bounds it as a string of at most 64 characters with no calendar check —
measured: a record grading `HISTORICAL_AUTHORISATION` can carry `yesterday-ish`,
or an instant contradicting its own directory name. It is displayed and never
computed with.

**Two tiers rather than one list**, because a name this build minted carries the
instant the writing invocation's clock reported and a name anything else chose
carries no instant at all; interleaving them would place an entry at a time
nothing measured.

The report says all of this in its own words, because the sort key and the
printed instant are different values that can disagree. It also says what a
sorted list cannot show: a gap. Deletion is caught not at all.

## 9. Output fields

Per readable record: the entry name, the reading, `authorisedAt` exactly as
recorded, the act and invocation mode, the task id, the checkout, the local
remote with the forge identity, the full ref, the **whole** object name and the
**whole** declaration digest. An abbreviated identity is a different fact, so
neither is abbreviated.

`repositoryRoot` **is** printed, deliberately. It is the only thing that
separates two clones of one project, which the store's own design says are two
different subjects; it is a local path under the profile of the user who ran the
command; and nothing here resolves it, stats it or follows it. The store path is
printed for the same reason `lease status` prints the lease path: the one place
an operator has explicitly asked *where* something is and cannot act without it.

Nothing of a record this build refused is shown. That is a property of the type
rather than of care: the record is present on exactly one member of the entry
union and `null` on every other, so there is no path along which an unreadable
entry's values could be rendered as though established.

**No `--json`, and no machine-readable output.** There is no such convention in
this CLI — measured: zero `JSON.stringify` anywhere under `src/cli/`, zero
registered `--json`, `--format` or `--output` — and there is an explicit refusal
on record for the delivery report: "the decision is in the report, where a person
reads the sentence that comes with it". That applies with more force to a store
that is evidence for a person and never an input to an authority.

## 10. The non-claims

The report never says a publication was attempted, that a ref exists, that this
build created one, that anything succeeded, or that the declaration still
permits any of it. It never says the store is tamper-proof, non-repudiable,
authenticated, signed or a complete history, and it never says an empty store
means nothing was ever authorised.

That is enforced three ways rather than trusted: every line that carries a value
is swept for the words that would widen the claim; the whole printed text is
swept for the phrases that are untrue even inside a denial, and for every member
of the publication vocabulary; and the denials themselves are pinned as text that
must be **present**, because a report that simply omitted them would leave the
comfortable reading standing.

## 11. Exit contract, and the grade this command deliberately does not give

| Situation | Code |
| --- | --- |
| a listing was produced — including one containing entries this build could not read | `0` |
| the store is absent, or present and empty | `0` |
| the root could not be enumerated, **any component of its path is not a directory**, a link sits on that path, or the profile could not be resolved | `3` |
| an unexpected throw | `1` |

The first draft graded a damaged entry `3`, and three measured facts say that is
wrong.

**Code 3 means "the durable state needs an operator before anything may run", and
a damaged record blocks nothing.** No stored record is ever an input that permits
a publication — the one place the effect path reads one is the write it has just
made, read back before the remote is contacted, and that read can only refuse —
and the next unattended publication mints a fresh random event identity, so a
damaged neighbour cannot even collide with it.

**`RECORD_ABSENT` is an ordinary, permanent shape of this store.** It is what a
crash between the `mkdir` and the rename leaves, and what *every* refusal after
the `mkdir` leaves, because that protocol deletes nothing ever.

**Nothing prunes the store.** `L-V4-14-1` is open, so one unreadable directory
would pin this command non-zero forever, with no way inside this tool to clear it
— a signal nobody can act on and everybody learns to ignore.

So the finding goes in the report and the exit stays 0. That is also the shipped
precedent: `lease status` sets `EXIT_RUN_OK` unconditionally, including for a
lease it cannot parse, because a status command that exited non-zero would be
unusable in exactly the scripts that need it.

The store-level grade is 3 for a different reason than "a record is unreadable":
a store whose root cannot be read is the store the **next** authorised
publication cannot write into, which is the same durable condition the writer
already grades 3 as `PUBLICATION_AUDIT_NOT_DURABLE`.

Never 4 and never 5: a read that produced an answer was neither refused nor a
step in something to call again. **It can exit 6**, and that is not this
command's doing — the runtime gate at the CLI entry runs before every action, is
inherited by nested subcommands, and terminates on a machine outside the support
contract before this report is built. An operator inspecting an audit store on
such a machine sees the gate's message and no listing. Stated because it is a
plausible case rather than a theoretical one.

## 11a. Two things this decision got wrong first, and what they cost

Both were found by an independent review reproducing them, and both are stated
here rather than quietly repaired, because each is a shape that will recur.

**The store's absence was read off the wrong signal.** The listing decided
`STORE_ABSENT` from `readdir`'s errno, on the stated premise that "`ENOTDIR` from
a file sitting at the path" is the other answer. Measured false on the platform
this build declares primary: Windows collapses "a component of the path is not a
directory" into `ENOENT`, and `ENOTDIR` reaches the caller only when the *root
itself* is the non-directory — which was the one shape a test covered. So a
profile whose `.agent-orchestrator` is a file reported "there is no store under
this user profile" and exited 0, while the writer on the same profile at the same
instant answered `STORE_UNAVAILABLE` and the drive graded it 3. Two commands, one
condition, opposite answers, and the reassuring one was the read. Absence is now
established from the path — every existing component must be a directory —
before `readdir` is asked anything.

**The report could not be piped.** This is the first command in the build whose
output is deliberately unbounded, and therefore the first with an operator who
has a reason to send it to `head` or a pager. Measured in a real process: past
roughly ninety records the report exceeds the pipe buffer, the reader's exit
raises `EPIPE` on stdout, and an unhandled `error` event on a stream is an
uncaught exception — 1,355 bytes of raw Node stack outside the safe formatter,
and exit 1, for the ordinary gesture §11 argues must work in a script. The rule
is not new: this build states it twice about the streams of the processes it
starts, and it had never applied to its own stdout because no command produced
enough output to reach it. A closed reader is now an ending.

The first version of that guard re-threw everything else, saying the error was
"left to the caller's `catch`". Measured false in a second round: the event is
emitted from a tick, long after the action's `try` has closed, so the throw was
an uncaught exception producing exactly the raw stack the guard removes — the
listener was behaviourally identical to having none. The other arm now reports
through the safe formatter itself.

## 12. Trust

**Any process running as this OS user can write a record that reads exactly like
the rest, and can delete one without trace.** The binding is integrity structure
and not a message authentication code; there is no key material in this build.
File modes are not a defence: `0o600` and `0o700` were measured on this NTFS
volume to yield `0o666`.

The report says this once, in its own words, rather than beside every record —
often enough to be honest, once so the report stays usable. The command's help
text says it too. Neither ever uses the word "verified" about a binding, and the
sentence about the digest says what it catches and then says "it catches nothing
else".

**An empty store is not evidence that nothing was authorised.** It is what is
present now. An attended publication records nothing here at all, another OS user
has another store, and deletion leaves nothing behind.

## 13. Authority separation

The dependency direction is one way: the effect path writes evidence, this
command reads it, and nothing runs the other way.

Three pins, and the second is the one that needed measuring:

**The reader is on no authority path**, pinned twice and in both directions. The
suite derives the set of modules that call `listHeadPublicationAuthorisations`
and requires it to be exactly two — an allow-list, so a third caller fails the
suite until somebody decides it may exist — and separately requires that no
module in that set is one that decides whether a publication may happen. A first
version of this dropped the allow-list for the deny-list alone, on the argument
that a literal goes stale; a review measured what that cost, which is that a
future authority module named anything outside the six-name pattern could read
the store with the whole suite green. A pin that goes stale by refusing is worth
more than one that goes stale by permitting, so both are kept. Slice 14's own
pin, which this slice had to touch, is repaired the same way.

**The type handed out cannot be an argument to the mint.**
`mintHeadPublicationGrant` takes a *structurally typed* `{host, owner, name,
commit}`, so a value carrying the record's own field names is an argument it
accepts. Measured against the real declarations: a `unique symbol` brand, a
branded `commit` string and a class with a `#private` field are each **no defence
at all** — excess properties do not break structural assignability from a
variable, and a private field is nominal only when the class is the target.
Renaming is what works, and renaming one field is provably enough. So the view
this reader hands out renames all six identity fields — `forgeHost`,
`forgeOwner`, `forgeName`, `authorisedRef`, `authorisedCommit`, and `eventId`
becomes `recordedEventId` — and the suite pins that none of `host`, `owner`,
`name`, `commit`, `ref` or `remoteName` is a field name on it. Completeness of
the rename is a compile error by construction; that the two sides carry the same
*values* is a separate question and a separate case asks it.

The map that expresses the rename is exported as a list of pairs rather than as
the object it is built from, and that is not cosmetic: a `Record` keyed by the
record's own field names is itself structurally a mint argument, so the module
whose whole point is not to export one was exporting one. It fails at runtime —
the values are field names, not a host and an object name — but the argument here
is structural, and a defence with a runtime hole in it is not the defence this
section claims.

**The source names no authority artefact.** No mint, no grant type, no claim, no
publisher, no scheduler, no timer.

## 14. Network, processes, and current truth

Zero. No forge request, no `gh`, no Git child, no child process of any kind, no
execution lease, no task-state read, no notification. No repository is resolved.

And no current-policy comparison. The command does not open
`delivery-automation.yaml`, and a driven case edits it, breaks it and deletes it
and requires the report to come out byte-identical. **A policy file edited today
may not change what yesterday's record means**, and a listing that compared
against the current declaration would answer a different question — wrongly, for
every record older than the last edit.

The command may print `declarationDigest`. It may not say "this matches the
current policy", and measuring that is a decision of its own.

## 15. Store size

**The listing is unbounded and prints one block per event, forever.**

That is the accepted limit, stated rather than solved. There is no limit flag, no
page and no "most recent N", for a reason: a truncation rule has to promise a
selection, and while `L-V4-14-1` is open any such rule is a retention decision
wearing a display costume. Never silently truncating an accountability listing is
worth more than a short report.

There is also no pagination convention in this CLI to reuse — measured: no
`--limit`, no `--page`, no `.slice(` in any command. The one bounded-report
convention that exists is about printing counts instead of pasting identifiers
into a report whose purpose is one line; here the listing *is* the purpose.

The counts line is printed first and always carries both halves — how many were
read and how many were not — so a store with one damaged entry cannot be
mistaken for a clean one at a glance.

## 16. Retention: deferred, and deliberately

`L-V4-14-1` stays open. This slice deletes nothing, prunes nothing, compacts
nothing and offers no way to. It makes the unbounded store *visible*, which is
the honest order: an operator who can see what is accumulating is in a position
to decide what a retention policy should say, and one who cannot is not.

## 17. Non-goals

Explicitly outside, and each needs its own decision: reconciling a record against
what a forge holds now; searching, filtering or indexing the store; comparing a
record against the current declaration; deleting, pruning or compacting;
unattended pull-request creation; unattended merge; a scheduler; polling;
notification; a generic audit framework for every AO act; cryptographic signing;
and an outcome record written after the effect.

`READY_FOR_PR` remains terminal and the transition table is untouched.

## 18. What is carried, and what it costs

**`L-V4-15-1` — the listing is unbounded.** See §15. One block per event,
forever, and the store grows by one per authorised unattended publication with
nothing pruning it. `L-V4-14-1` is its cause and is unchanged.

**`L-V4-15-2` — `UNRECOGNISED_ENTRY` answers two different questions.** It is
"this build does not read this as an event directory" *and* "this build could not
describe this at all". The member's sentence names both, which it did not in the
first version of this slice — it stated a closed three-way disjunction and the
code had a fourth arm. The arm is reachable under concurrent churn (measured:
189 times in six seconds, listing throwing zero times) and is not driven here,
because a race is not a fixture.

**`L-V4-15-3` — the reader's import closure still contains writers.** It calls
`isValidRunId`, which ships beside the exclusive `mkdir`, and `inspectLinkChain`,
which ships beside the append-only artefact write. The two *writers* are never
called and never named, but they are in the closure. Measured: the closure is
eleven product modules and `zod`, static and runtime agreeing exactly, and those
two are the only members that can write — nothing in it can spawn, take a lease
or reach a forge. So "this command creates nothing" is carried by a source sweep
and by hashing every path and byte under the profile before and after a listing,
rather than by the import graph. Closing it means splitting two `doctor/`
modules, which is a change of its own.

**`L-V4-15-4` — a character able to forge a line or reorder one is not shown
verbatim.** It is replaced by `<U+XXXX>` so a forged record cannot forge report
lines. Everything outside that class is unchanged, and this is the one place the
report is not a byte-exact echo of what is stored.

**`L-V4-15-5` — the binding proves less to this reader than to the writer.** See
§6. `taskId` and `repositoryRoot` are supplied from the document, so the
comparison establishes "bound to this directory name" rather than "bound to this
event, task and repository". The report's wording is bounded to match — including
that three of the binding's inputs are not shown at all: the two contract
versions, and the event identity the record claims for itself, which is held back
because §6a makes it unchecked text a forger chooses.

**`L-V4-15-10` — a path whose components do not exist at all reads as an absent
store.** The walk in §11a stops at the first component that is not there, because
nothing below an absent component can exist either — so a profile on a volume
that is not mounted reports "there is no store" rather than refusing. Not
productively reachable: the profile resolver requires the profile directory to
exist and to be a directory before this command has a root at all, so a
productive run fails earlier with `PROFILE_UNAVAILABLE`. Reachable through the
internal test seam, and named because "not reachable" is a claim.

**`L-V4-15-8` — the exit code cannot distinguish a clean store from a tampered
one.** §9 refuses machine-readable output, so the exit code is the only thing a
script reads, and §11 makes it 0 for a store that was listed however its entries
graded. `agent-loop publication authorisations || alert` therefore fires for a
permissions problem and never for a record whose binding no longer recomputes.
That is the accepted cost of the §11 decision rather than an oversight, and it
is named here because it is the reason the human-readable report is also the
only findings channel — which is what made the pipe defect in §11a worse than it
looked.

**`L-V4-15-9` — the suite imports the CLI entry, which runs `main()`.**
`src/cli/index.ts` calls `main()` at module scope, so importing `buildProgram`
from it parses this process's own argv, prints the front-page help and sets
`process.exitCode`. The exit-contract case here snapshots and restores that
value, so nothing is measured wrongly, and the noise on stderr is this build
reporting an unknown command to itself. Pre-existing and reproducible across
five delivery suites rather than introduced here; naming it is what this slice
adds. Fixing it means guarding the entry against being imported, which touches
every dist harness that drives the real CLI and is a change of its own.

**`L-V4-15-6` — a hard link at a record's name is read.** The refusal is on
reparse points, which is what `lstat` can see; a hard link is not one, nothing
counts links, and a hard-linked `authorisation.json` is opened and graded like
any other with its bytes living under another name outside the store. `mklink /H`
needs no elevation. This is `L-V4-14-4` — which says a record's name "could be
made to alias another file" — and this slice is the first code that reads through
the alias, so it is carried here as well rather than left as unchanged. No
privilege delta: planting the link already needs write access in the store, and
§12 concedes what a writer there can do.

**`L-V4-15-7` — a recorded value can be anything the length bound admits.** What
this build *writes* into `declaredRemote` is a local remote name, and into
`taskId` a task id; what the contract *admits* is text. So a record anything else
wrote can carry a URL with a credential in it, and a report that shows what is
recorded shows that. Redacting would be hiding evidence, so it is not done; the
only alteration is §6a's control-character escaping, and the record's own field
documentation says this rather than promising a grammar the schema does not
enforce.

**`L-V4-14-1`, `L-V4-14-2`, `L-V4-14-4`, `L-V4-14-5`, `L-V4-14-6`, `L-V4-14-7`
and `L-V4-13-5` are unchanged.** Two of them now matter *more*: this is the first
command that shows an operator a store nothing prunes, and the first place a
forged record would be displayed as `HISTORICAL_AUTHORISATION`.

**`L-V4-14-3` is narrowed rather than closed.** The store is read now. It is
still not indexed: records are addressable only by event identity, so finding the
record for one branch means reading every entry.

**No live product dogfood was possible, and this is `L-V4-13-8` unchanged.** This
repository has no orchestrated task and no runtime state, so no legitimate
delivery could exercise the automatic path end to end. What was measured against
real bytes is this slice's own subject: real records written by the real slice-14
writer into a real scratch profile, read back by the real command.
