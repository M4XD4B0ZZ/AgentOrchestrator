# ADR — asking the publication audit store about one branch

**Date** 2026-08-27
**Status** accepted
**Slice** V4 slice 17
**Supersedes** nothing. **Superseded by** nothing.
**Amends** two. **Amended by** nothing.

`2026-08-27-adr-unattended-publication-audit.md` §17, which lists "searching,
filtering or indexing the store" as one non-goal. It is split here: **one exact
filter is carved out and decided; searching and indexing stay non-goals.**

`2026-08-27-adr-publication-authorisation-listing.md` §15 and §17, whose command
now takes four flags. Its own claims are unchanged: the listing still contacts
no forge, starts no Git, takes no lease, reads no declaration and creates
nothing, and it still prints every entry when nothing is asked.

## The decision

**An operator can narrow the report to one branch, by naming that branch
exactly: host, owner, repository name and ref, all four or none.**

Four flags on the existing subcommand, one new grammar module holding rules that
were already in this build, and one pure projection over a listing that has
already happened. No new command, no new store, no new file in the store, no
index, no limit, no page, no retention rule, and no change to the enumeration.

## The three sentences the contract rests on

> **A branch is four values, not one.** `refs/heads/main` in one repository is
> not the branch of that name in another, and the record's own schema admits any
> host and any owner rather than an enum.

> **Everything this build did not read in full is still shown.** An entry it
> read no record for carries no host, owner, name or ref at all, so it can be
> neither matched nor ruled out; and an entry whose record it read beside a
> document it could not is one the store's own grade already counts against it.
> Hiding either would turn "I could not read all of this" into "there is no
> record for this branch".

> **This is a filter and not an index.** Every entry in the store is still opened
> and graded to answer the question. `L-V4-14-3` is narrowed again and is not
> closed.

## 1. The branch key

Exactly four fields, in `AuthorisedPublicationRecord`'s own renamed spelling:

```
{ forgeHost, forgeOwner, forgeName, authorisedRef }
```

**Why each is in.** Traced from `parseRemoteUrlIdentity`
(`deliver/delivery-target.ts`) through `mintHeadPublicationGrant` and the ladder's
re-check closure to `recordHeadPublicationAuthorisation`, which normalises
nothing and writes the caller's values verbatim. Dropping any one admits a false
match on a record the store already accepts: drop `authorisedRef` and every
branch of the repository matches; drop `forgeName` and `owner/a` collides with
`owner/b`; drop `forgeOwner` and a fork collides with its upstream; drop
`forgeHost` and any record carrying another host collides with a github.com one
— the schema bounds `host` as a string of at most 253 characters and not as an
enum, so that is a property of the contract rather than of today's one-member
`SUPPORTED_FORGE_HOSTS`.

**Why `authorisedCommit` is out.** It is what the branch pointed at, not which
branch it is. Two publications of one branch at two commits are two events of one
branch's history, and that is the set the operator asked for. Measured on a real
fixture: four records differing in commit, remote and checkout are one branch.

**Why `declaredRemote` is out.** It is the **local** name of the pointer the
identity was read through. `{host, owner, name}` was parsed out of that remote's
push URL, so two records agreeing on those three name one repository whatever
the local remote is called. Including it would split one branch's history
between `origin` and `upstream`, and would force a value the contract admits a
credential in (`L-V4-15-7`) into a query argument.

**Why `repositoryRoot` is out.** It is a checkout — "two clones of one project
are two of these" — and both clones publishing one branch changed one forge
branch. Including it would defeat the store's own point that a record outlives
the checkout it was about.

**Why `taskId` is out.** An orchestrator label with no counterpart on the forge.
It cannot separate two forge branches, so excluding it cannot admit one.

**Why the rest is out.** `authorisedAt`, `recordedEventId`, `binding` and
`declarationDigest` are per-event values: they are what make two records
*different events on one branch*, which is the answer rather than a filter.
`act`, `invocationMode`, `authorisationVersion`, `declarationSchemaVersion` and
`declaredPermission` each have exactly one admissible value in the schema, so
they discriminate nothing.

**Why the renamed spelling.** A value carrying `host`, `owner`, `name`,
`commit`, `ref` or `remoteName` is structurally an argument to
`mintHeadPublicationGrant` and to the publication re-check seam. The record view
was renamed for exactly that reason, and a query object is a second place the
same hole can open.

Measured with the compiler rather than argued, by writing the calls and reading
what `tsc` said:

- `mintHeadPublicationGrant(query, 'origin', ref)` with the query this build
  builds → **TS2739**, "missing the following properties from type
  `ObservationSubject`: host, owner, name, commit". Four fields deep;
- the same call with a hypothetical `{host, owner, name, ref}` query → **TS2741**,
  and it names exactly one missing property, `commit`. So that spelling is one
  field short of the mint's parameter — an accident, not a defence;
- and adding `commit` to it compiles with no error at all.

The suite pins the query's keys, and pins them off the value `readBranchQuery`
returns rather than off a fixture.

## 2. Match semantics: exact, and only exact

Four `===` and nothing else. No case folding, no prefix added, no suffix
trimmed, no substring, no glob, no regex, no Unicode normalisation.

**Case is not folded, deliberately.** `permitsUnattendedHeadPublication` compares
owner and name exactly and answers `NOT_DECLARED` for a differently capitalised
entry; that is `L-V4-13-3`, and it is a fail-closed decision rather than an
oversight. A reader that folded would put a second, disagreeing definition of
"the same repository" into one build: an operator who found records under
`Owner/Repo` would reasonably conclude the declaration matches that way, and it
does not. Folding would also apply one forge's casing convention to records whose
`host` field admits any string. **`L-V4-13-3` is not fixed here, and must not be
fixed here by accident.**

The host arrives already lowercased from the one place in this build that folds
it, at parse time. Nothing folds it a second time.

## 3. Multiple events: all of them, in the listing's own order

An exact branch lookup returns **every** matching event. There is no
latest-wins, no collapsing by commit, no de-duplication by ref, and no merging of
outcomes. Measured rather than argued: a store with two events for one branch at
one commit keeps both, and a store with four events across three commits, two
remotes and two checkouts keeps all four.

Nothing in the code establishes that two events could be duplicates of one
another. Each carries its own instant, its own event identity, its own
declaration digest and its own outcome, so collapsing any two would lose a
historical fact.

The order is the listing's, unchanged: entries read as event directories first,
then everything else, each group in code-unit order by name. A query removes
entries from that order and never reorders it.

## 4. Broken evidence: `unestablished`, and it is structural

The listing's entry type carries the record on the `HISTORICAL_AUTHORISATION`
arm and `null` on the other seven. The only other field those arms carry is the
directory's name, which is an instant plus a random identifier and encodes no
ref, no task and no repository. **So for seven of the eight readings there is
nothing to compare** — this is not a policy about broken evidence, it is the
absence of anything to have a policy about.

Of the four candidate contracts, **B** was chosen: broken entries are surfaced
alongside the matches, as evidence that could not be classified against the
query. The selection counts them as `unestablished` and the reading
`NO_NAMED_RECORD_AND_EVIDENCE_UNREAD` is what a negative over such a store says.

**And the rule for what is shown is wider than that count.** Exactly one class
is left off the page: an entry this build read **in full** — `entryWasRead`, the
record *and* whatever sits beside it — whose record names a different branch.
Everything else is printed, including a record naming another branch when the
outcome document beside it could not be read.

That second half was a shipped defect for one commit and three independent
reviews reproduced it. The first version hid on "a record was read", while the
store's grade and the report's tally are `entryWasRead`. The two disagree on
exactly one class, so a store holding one such entry printed
`Entries : 1 (0 read, 1 not read)`, printed "each one is listed above with what
it turned out to be", and listed nothing. One predicate, one question — the rule
V4 slice 16 already learned once, applied here by removing a second spelling
rather than adding one.

- **A — exclude every broken event** was rejected. A malformed record could be
  the record for the branch being asked about, and nothing can say it is not.
- **C — fail the whole lookup** was rejected. A store nothing prunes would then
  have a permanent failure mode with no way inside this tool to clear it, which
  is the argument slice 15 already made about its exit grade.
- **D** — none found better.

`RECORD_NOT_THIS_EVENT` is the subtle one and is treated as unjudgeable rather
than as a non-match. Its payload is well-formed and its digest does not
recompute; the grader reports one reading for a divergence in any of nineteen
digest inputs, so it cannot say which field diverged and `ref` is a candidate
every time. Reading it to answer a branch question would be this build's
strongest sentence about a document it can prove it did not write. Measured: a
record whose `ref` is edited in place to the queried value is counted as
unjudgeable and shown, never as a match and never as naming another branch.

The other direction is conceded rather than defended. A **re-sealed** record —
one whose binding was recomputed over an edited payload — reads as this build's
own and is named by the query. There is no key material here (`L-V4-14-2`), so a
binding is an integrity statement and never an authentication one.

## 5. Completeness: four distinguishable answers

| The store | What is printed |
| --- | --- |
| matches exist | the matching entries, and `NAMED_RECORDS_PRESENT`'s sentence |
| no match, every entry read | `NO_NAMED_RECORD_PRESENT` |
| no match, some entries unread | `NO_NAMED_RECORD_AND_EVIDENCE_UNREAD` |
| store not readable | the store's own sentence, and `STORE_NOT_READ` |

The last row is load-bearing. On `STORE_ABSENT`, `STORE_UNREADABLE`,
`STORE_PATH_UNSAFE` and `PROFILE_UNAVAILABLE` the entries array is empty because
nothing was read, so a selection over it would answer "no record names that
branch" for a store this build could not open. No selection is computed there and
no `Matching` line is printed — but a **sentence** is, and that is the fourth
reading. The absence of a line is not a sentence, which is the rule the three
answers already follow; `STORE_ABSENT` needed it most, because it exits 0 exactly
as a clean negative does. The query is echoed on every outcome, so an operator
can always see what was asked.

The strongest claim any negative makes is about **records currently present in
the readable store**. None of the three sentences says a branch was never
authorised, was never published, or that this is a complete history; the suite
sweeps for each of those phrasings, and the existing sweep already forbids
"never authorised" outright.

## 6. The command line

```
agent-loop publication authorisations \
  --forge-host github.com \
  --forge-owner M4XD4B0ZZ \
  --forge-name AgentOrchestrator \
  --ref refs/heads/ao/task/V4-17
```

All four or none. None is the whole-store listing this command shipped with,
unchanged.

**Three fields and not one string.** There is no parser in this build that turns
`host/owner/name` into an identity: the one that exists is URL-shaped and refuses
that exact spelling. A single argument would need a third identity grammar and
would ship a separator trap. The operator already types these as three keys in
the declaration the records were written under, and the permission path already
compares them as three exact fields. `--repository` is spoken for on five
commands with an incompatible meaning — a filesystem path.

**Prefixed `--forge-`** rather than bare `--host --owner --name`, following the
record view's rename discipline and keeping the flags' spelling next to the
query type's.

**The ref is the whole ref.** A bare branch name is refused. Accepting one would
mean this command prepending `refs/heads/`, and `refs/heads/` is itself something
a branch name may contain — the writer's own grammar admits
`refs/heads/refs/heads/x` — so one guess would stand for two different stored
values.

**`--forge-host` has no default.** A default of `github.com` would assert that
every record in the store is about github.com, which the record schema does not
constrain and the report's own provenance paragraph disclaims.

**The grammars are the writer's own**, imported rather than restated:
`isForgeHost`, `isForgeOwner`, `isForgeRepositoryName` and `PUBLISHABLE_REF`.
Every identity this build can put in a record passed exactly those rules on the
way in, so a query bounded by them can name any record this build wrote.

It is deliberately **not** bounded by `SUPPORTED_FORGE_HOSTS`. That constant says
which hosts this build may publish to *now*, and this store holds what was
recorded *then*; a reader bounded by a current constant could not ask about a
record the current configuration can no longer produce. It is the same reason
this command does not open the declaration as it stands today.

**Exit grades.** A produced listing is 0, whatever it contains — including zero
matches, which is an answer and not a blocking condition. An unusable query is
**2**, `EXIT_RUN_INPUT_UNUSABLE`, printed with this command's own vocabulary
rather than commander's: measured against the shipped artefact, every parse
refusal commander gives exits **1**, this build's code for a defect inside the
tool, on a bare stderr line that never passes through the safe formatter. That is
why all four are `option` and none is `requiredOption`. A store that could not be
read stays **3**. 6 stays reachable through the runtime gate; 4 and 5 stay
unproduced.

**The refusal runs before anything is read.** Whether an invocation is refused for
how it was written must not depend on what is in the store — the V4 slice 12
defect in its own shape. The suite measures it as an equality between two worlds:
the same argv against an empty store and a full one must produce byte-identical
output and the same exit code.

## 7. The scan: Θ(N), and said so

The filter is a projection applied **after** `listHeadPublicationAuthorisations`
returns. The enumeration never learns there was a query.

Per store child the listing performs, **read from the code rather than
instrumented**: one `lstat` on the directory, one on `authorisation.json`, an
`open`+`fstat`+`read`+`close`, and on the good arm one `lstat` on `outcome.json`
and a second bounded read — between 1 and 11 file operations depending on what is
there, plus one `readdir` and two walks of the store's path. Θ(N) in the number
of store children, with the sort's O(N log N) comparisons on top.

Measured on this machine, with the real writers building the store and the real
listing reading it: **200 entries in 145 ms (0.73 ms/entry) and 800 entries in
564 ms (0.70 ms/entry)**, with an outcome document beside half of them. Linear
across that range. The selection itself is not the cost: it is 0.17 ms over 200
entries and 0.32 ms over 800, three orders of magnitude below the enumeration.
Nothing is claimed about a store larger than 800 entries, or about a volume other
than this one.

**Outcome reads are not skipped for non-matching records, and that is the crux.**
`entryWasRead` is `HISTORICAL_AUTHORISATION` **and** a clean outcome reading, and
it is the sole input to both the store's grade and the report's tally. Five of
the seven outcome readings grade the store down and three are distinguishable
only after the bytes are parsed and the digest recomputed. Skipping them for
entries a query excludes would make `Listing : READ` a claim about a subset while
its own printed sentence goes on saying "every entry in the store". The saving
would be five syscalls per excluded entry; the cost is the one property this
command exists for. Measured as a mutant: filtering inside the enumeration is
killed by the store-grade case and by the tally case.

## 8. No index

None is added. A persistent index would bring write atomicity, index-versus-event
consistency, crash recovery, repair, concurrency, trust, backfill and migration,
and every one of those is a decision this slice does not make. Nothing measured
here says the lookup is unusable without one: the store is one directory per
unattended publication, and the scan is linear and fast.

So `L-V4-14-3` is **narrowed and not closed**, for the second time. What slice 15
removed was "no operator can read this store". What this removes is "finding the
record for one branch means reading every entry *yourself*". What remains is that
**the machine** still reads every entry, and that records are addressable only by
event identity on disk.

## 9. Order

Stable, total and deterministic: the listing's own two tiers, each in code-unit
order by name, with names unique inside one directory. Repeated invocations
produce byte-identical reports. A filter removes from that order and never
reorders it, and the filesystem's own enumeration order reaches nothing.

## 10. When outcome files are read

Exactly when they were read before: for every entry whose authorisation record
this build read, whichever branch it names. On the other seven arms the outcome
is not looked at at all, which is `L-V4-16-6` and is unchanged — and the report's
provenance paragraph, which discloses it, is printed under a query too.

## 11. Zero side effects

The query resolves no repository, starts no process, opens no network
connection, takes no lease, reads no task state and opens no declaration. It
builds no path from operator input: a ref that looks like a path —
`refs/heads/../x`, which the writer's own grammar admits — reaches nothing but a
string comparison. The suite measures a byte-identical store tree across a
matching query, a non-matching query and a refused one.

## 12. Authority

The filter is read-only routing and grants nothing. A match is not a permission,
not a retry authority and not evidence that a ref exists or that this build
created one — `L-V4-13-5` is untouched. The query type cannot be an argument to
any mint, the four source files name no mint, no grant and no publisher, and the
sweep that pins which modules may read the store is unchanged because the
enumeration still has exactly one caller.

## 13. Same-user forgery and deletion

Unchanged, and both reach the exact field a filter reads. Anything running as
this OS user can write a record that reads exactly like the rest — including one
naming any branch — and can delete one without trace. `L-V4-14-2` stands, and the
negative sentences are written against it.

## 14. Retention

Still deferred. `L-V4-14-1` is open, nothing prunes the store, and this slice adds
no rule that removes, truncates or ages anything. A filter is not a truncation:
it promises no selection over time, and it is kept visibly separate from the
`--limit`/`--page`/`--latest` family that §15 of the listing ADR refused on
retention grounds.

## 15. Non-goals

Unchanged from the two ADRs this amends, minus the one carve-out: generic search,
full-text search, task search, commit search, an index service, pagination,
compaction, retention, current forge lookup, outcome reconciliation, unattended
pull-request creation, unattended merge, a scheduler and cross-project
orchestration are all still outside this slice.

## 16. What is carried, and what it costs

- **`L-V4-17-1` — a filter is not an index.** Every entry in the store is still
  read and graded to answer a question about one branch. The report says so in as
  many words, and `L-V4-14-3` stays open for that reason.
- **`L-V4-17-2` — a record outside the writer's own grammar cannot be named.**
  The query is bounded by the rules every identity this build writes passed on
  the way in. A record carrying a host, owner, name or ref outside them — which
  only something other than this build can write — is counted as naming another
  branch and cannot be targeted. It is shown in full by the whole-store listing,
  which takes no query.
- **`L-V4-17-3` — a re-sealed record is named by the query.** There is no key
  material in this build, so a forged record naming the queried branch reads as
  this build's own. No filter can do better, and the report's provenance
  paragraph already says it.
- **`L-V4-17-4` — the negative is about the readable store and nothing more.**
  Same-user deletion is untraceable, an attended publication records nothing
  here, and another OS user has a store of their own. "No record here names that
  branch" is the strongest true sentence available.
