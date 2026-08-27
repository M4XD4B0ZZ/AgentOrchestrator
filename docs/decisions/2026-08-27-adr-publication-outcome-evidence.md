# ADR — the record written after nobody publishes anything

**Date** 2026-08-27
**Status** accepted
**Slice** V4 slice 16
**Supersedes** nothing. **Superseded by** nothing.
**Amends** two. **Amended by** nothing.

`2026-08-27-adr-unattended-publication-audit.md` §11, "Why there is no second
record", and §13, which names "a post-effect outcome record" as an explicit
non-goal. Both are reversed here, deliberately and with the reasons answered one
at a time in §0 below rather than set aside.

`2026-08-27-adr-publication-authorisation-listing.md`, whose command now reports
a second document beside each record it reads. Its own claims are unchanged: the
listing still contacts no forge, starts no Git, takes no lease, reads no
declaration and creates nothing.

## The decision

**An unattended head publication writes down what it went on to do, in a second
immutable document beside the authorisation that permitted it, created once and
never written over.**

One new file name inside the existing event directory, `outcome.json`. Two new
production modules — a contract and a store. Two new closed vocabularies, one
new driver member and one new exit-code table. No new flag, no new grant, no new
forge act, no change to the push vector, no change to the publication grader and
no change to the attended path.

## The three sentences the contract rests on

> **The outcome says what this invocation called and what its last reading
> established, and nothing else.** Not that this build put the commit on the
> delivery remote, not that the ref holds it now, and not that bytes reached
> github.com.

> **An authorisation with no outcome beside it means no durable outcome was
> established. It does not mean no effect happened.**

> **A failure to write it is reported as itself.** It happens after an act that
> cannot be undone, so it may not be hidden behind that act's own result, and it
> may not be answered with "ask again".

## 0. Why slice 14's §11 is reversed

Slice 14 refused this record for three reasons. Each is answered, and the third
is accepted rather than rebutted.

**"It is not the prerequisite this slice closes."** Correct then, and it is the
prerequisite *this* slice closes. Slice 15 shipped the read and left the gap in
plain sight: rows 4 to 7 of slice 14's own crash table are locally
indistinguishable, so an operator reading a record could not tell a run that sent
nothing from one that may have created a branch. The evidence answered "what was
AO permitted to attempt?" and structurally could not answer "what happened?".

**"A post-effect record cannot be a precondition of anything, and must not be
best-effort either. It would need its own rule about what a failed write
means."** It has one, and it is written down in §10 rather than left implicit: a
failed outcome write changes the invocation's grade and nothing else. It never
refuses, never retries, never compensates and never touches the remote a second
time. The objection was that no such rule existed, not that none could.

**"Two durable records are not a transaction and would be read as one. The
honest reading of `(record, no outcome)` is 'this build cannot say what
happened', which is exactly what `(record)` alone already says."** The second
sentence is accepted in full and is §11 of this ADR, load-bearing in the code,
the report and the suite. What it misses is the *other* pair. Today `(record)` is
the only shape there is, so "sent nothing" and "may have created a branch" are
one state. With the sibling, `(record, outcome)` is a third shape and it is the
ordinary one — an outcome is written on **every** path where an authorisation was
written, including the paths that sent nothing. That totality is what makes the
absence mean one thing.

**"What an outcome record would add over the remote itself is the transport's own
report, which is weaker evidence than a reading."** This is the one that shaped
the design. The outcome does **not** rest on the transport's report: its
principal field is built from the same two `ls-remote` readings the grader uses,
and the transport's own report is carried in a second field, apart, under a
vocabulary that says it is evidence about a process rather than about a network.

## 1. The exact claim, and the sentences it refuses

> At `recordedAt`, the invocation that wrote authorisation event `eventId` had
> finished its publication processing, and these are the calls it made and the
> readings it took: `outcome` says whether the create-only publication command
> was handed to the process boundary and what the last reading of the ref
> established, and `commandReport` says what the process boundary reported about
> that one command.

| # | Refused sentence | Why |
| --- | --- | --- |
| A | "this build put the commit on the delivery remote" | Measured false. A push of a commit a ref already holds exits zero and reports the remote up to date **without the lease being evaluated**, so a publisher that changed nothing reaches the strongest reading here. `L-V4-13-5` |
| B | "the ref holds this now" | Every reading is one reading at one instant. The listing contacts nothing, so a later deletion or force-update does not revise a word of it |
| C | "bytes reached the delivery remote" | Nothing on this machine can establish it. `outcome` separates *dispatch* — the command was handed to the process boundary — from every stronger claim |
| D | "nothing happened", from a ref read absent afterwards | One reading afterwards does not establish that nothing existed in between |
| E | "no effect happened", from an absent outcome | §11 |
| F | "this may be attempted again" | §15 |

## 2. The vocabulary, and why it is two of them

**`PUBLICATION_OUTCOMES`** — nine members, each naming a call this build made and
a reading it took. The first word is the dispatch fact and is decided by control
flow alone.

| Member | The fact established | Mutation possible? | Final ref state known? | Authorship known? |
| --- | --- | --- | --- | --- |
| `NOT_DISPATCHED_REMOTE_NOT_ASKED` | no command was handed over, and nothing was asked of the delivery remote for this publication | **no** | no | n/a |
| `NOT_DISPATCHED_REF_NOT_READ` | a reading was taken and did not establish what the ref held; no command was handed over | **no** | no | n/a |
| `NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT` | a reading found the ref holding exactly the authorised commit; no command was handed over | **no** | at that instant | **no** |
| `NOT_DISPATCHED_REF_AT_OTHER_COMMIT` | a reading found another commit; no command was handed over | **no** | at that instant | **no** |
| `NOT_DISPATCHED_REF_ABSENT` | a reading found the ref absent; no command was handed over | **no** | at that instant | n/a |
| `DISPATCHED_REF_NOT_READ_AFTER` | one command was handed over and the reading afterwards did not answer | **yes** | **no** | **no** |
| `DISPATCHED_REF_ABSENT_AFTER` | one command was handed over and the ref was read absent afterwards | **yes** | at that instant | **no** |
| `DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER` | one command was handed over and the ref was read at the authorised commit afterwards | **yes** | at that instant | **no** |
| `DISPATCHED_REF_AT_OTHER_COMMIT_AFTER` | one command was handed over and the ref was read at another commit afterwards | **yes** | at that instant | **no** |

`DISPATCHED_REF_NOT_READ_AFTER` is the first-class unknown. It is not a failure,
it is not "not published", and the answer to it is a reading rather than a second
command.

**`PUBLICATION_COMMAND_REPORTS`** — five members, evidence about a process rather
than about a network.

| Member | From | Establishes |
| --- | --- | --- |
| `NOT_CALLED` | no command was handed over | nothing about a process, because there was none to have |
| `NO_PROCESS` | the boundary answered that there was nothing to run | **a negative**: no process for this command existed |
| `RAN_TO_EXIT_ZERO` | a completion with status zero | a process ran and ended with status zero |
| `RAN_TO_ANOTHER_ENDING` | a completion with another status, or a byte budget | a process ran and did not end with status zero |
| `ENDING_NOT_ESTABLISHED` | a refused launch, a deadline, a lost boundary, an unrecognised report, an absent one | nothing |

Three of the boundary's six outcomes fold into the weakest member, and each was
measured rather than assumed:

- a **refused launch** does not prove the target never ran. `doctor/exec.ts`
  answers `started` "`false` only where the boundary proved the target never ran,
  and `true` for `YES` and for `UNKNOWN` alike";
- a **deadline** does not prove a start either, and this is the subtle one: one
  of its two producers is a boundary that was never established in time, which
  carries the refusal's own answer about the target and may be "no";
- a **lost boundary** is by definition one this side cannot account for.

The honest limit, stated in the module: this is a statement about what the
process boundary *reported*. A substituted runner can report a completion having
created nothing — the same bound the publication grade already has.

## 3. Where it lives

```
<OS user profile>/.agent-orchestrator/head-publication-authorisations/
  <UTC instant>-<uuid v4>/
    authorisation.json   ← written before the delivery remote was contacted
    outcome.json         ← written after the publication processing ended
```

One event identity, two propositions, two documents. The alternatives were each
attacked and each lost something:

- **a second event directory** gives one publication two identities and needs a
  lookup to pair them — a global index this store does not have (`L-V4-14-3`);
- **a global outcome store keyed by event id** is that index, plus a second root,
  plus a second retention question;
- **a field on `authorisation.json`** rewrites the one document this build writes
  before contacting a remote. Every sentence in its header about "these bytes
  were written before" would stop being true of the bytes on disk;
- **an append-only history file** makes one event's evidence a sequence, and a
  sequence has a last element somebody will call the current state.

## 4. How the two documents bind

The outcome's digest is taken over a **subject** and a **payload**, listed field
by field, exactly as the authorisation's is. The subject is four values and
**none of them comes out of the outcome document**:

| Subject field | Where the reader gets it |
| --- | --- |
| `eventId` | the event directory's own name |
| `taskId` | the authorisation record |
| `repositoryRoot` | the authorisation record |
| `authorisationBinding` | the authorisation record's own `binding` |

The fourth is the anchor, and it is not merely read: on the good arm the
authorisation's grader has just *recomputed* that digest and found it equal, so
using it is not a tautology. An outcome moved into another event directory
carries the wrong anchor and fails to recompute.

**What is bound without being carried.** The act, the forge identity, the
declared remote, the ref and the commit are all inputs to the authorisation's own
digest, so binding to that digest binds them transitively. Duplicating them into
this document would add a second place for them to be edited and a second place
for them to disagree, and would buy nothing the anchor does not already buy. The
cost is stated: an outcome document read on its own, outside its directory, names
no task, no repository and no ref.

`eventId` is in both the subject and the payload, and is compared as well as
digested — because a digest recomputed over a *pair* that disagrees is
self-consistent. The authorisation's grader learned that in review; this one has
it from the start.

## 5. Immutability

Create-once, by the kernel. The authorisation store gets its exclusivity from the
event directory's `mkdir`; that is not available here, because this invocation's
own directory already exists, so the exclusivity moves down to the file:
`writeRunArtifact` opens the final name with `wx`, and `EEXIST` is answered in the
same syscall that would have created it. There is no existence check, no rename
and no replace.

**`writeFileAtomically` is deliberately not used.** Its rename would *overwrite*
an existing outcome, which is the one thing this store may never do.

What that costs: `writeRunArtifact` writes into the final name, so a crash
mid-write can leave a **prefix** on disk, which the crash-safe primitive would
not. Accepted here and not for the authorisation, because a prefix of this
document provably cannot read as an outcome — unbalanced JSON, a `.strict()`
schema, and a binding over the whole payload — so it grades as unreadable and an
operator is told a document is there and cannot be read. A prefix that read as a
*valid* outcome would be another matter, and there is none.

**An outcome already at the name is a refusal, and not for slice 14's reason.**
There, an existing record is refused because a record that licensed the effect
would be a replay. No outcome ever licenses anything, so that argument does not
transfer. The argument that does: the event name carries a version-4 UUID this
process minted, the directory was created by an exclusive `mkdir` in this
process, and this call is its first and only write — so anything already at the
name was written by something else, and reporting it as recorded would attribute
a foreign document to this run. The existing file is never opened, never compared
and never replaced.

## 6. Dispatch semantics

`DISPATCHED` means exactly this: **the create-only publication command was handed
to the process boundary.** It is decided by control flow — one call site, one
branch, no loop, no retry — and it is the one certain thing on the record.

It is deliberately *not* derived from a publication result member, because two of
those are reachable from the pre-observation as well. And it is deliberately not
"a process was created", "bytes were sent" or "the remote was mutated": each of
those is a stronger claim than the boundary's own report supports, and the report
is carried separately so that the weaker fact cannot be read as the stronger.

`NOT_DISPATCHED_REF_ABSENT` is reachable by argument and not by this build's own
ladder, which pushes on exactly that reading. It exists because the classifier is
total over its inputs and a total function with an unanswered arm is a function
with a default. The suite drives it directly rather than calling it unreachable —
a word this repository has had measured false three times.

## 7. The result vocabulary of the store

Twelve codes, closed, each justified by a distinct remedy: `RECORDED`,
`PROFILE_UNAVAILABLE`, `EVENT_ID_UNSUITABLE`, `STORE_PATH_UNSAFE`,
`EVENT_DIRECTORY_UNUSABLE`, `OUTCOME_ALREADY_PRESENT`, `OUTCOME_TOO_LARGE`,
`OUTCOME_CONTRACT_VIOLATION`, `WRITE_REFUSED`, `WRITE_UNCONFIRMED`,
`READBACK_FAILED`, `READBACK_MISMATCH`.

`WRITE_REFUSED` and `WRITE_UNCONFIRMED` are apart because of the name: the first
leaves it free, the second leaves it consumed, and nothing will ever write this
event's outcome either way.

**What is at the consumed name is deliberately not claimed.** A first draft said
every later listing would show an outcome it could not read; a review measured
that false for two of the three producers — the primitive refuses a short write
before it flushes, so a failed flush and a failed close both leave the whole
document on disk and a later listing reads it as `HISTORICAL_OUTCOME`. The store
did not reach its read-back on that path, so it does not know, and the vocabulary
says so rather than picking the tidier half.

There is no `ALREADY_RECORDED`, no `RETRY`, and no member naming a branch.

## 8. Unknown-outcome semantics

`DISPATCHED_REF_NOT_READ_AFTER` is preserved as itself and may never become a
refusal or a "not published". It is the member under which a remote mutation is
most likely to have happened and to be unrecorded anywhere.

**An outcome record does not make a retry safe, and this build does not retry.**
The publication is idempotent only because the ladder re-derives the state from a
fresh reading every time; the record is historical evidence and is never an input
to that. Nothing in the effect path reads one — the suite pins that the ladder
imports the writer and neither grader.

## 9. Write order

Exactly one place, at the end of `performPublication`, after
`publishDeliveryHead` has returned and after the existing refusal rename, and
before anything is handed back to the driver.

- **Not earlier**: everything above it is either a question put to Git or the
  effect itself, so it is the first moment the answer exists.
- **Not later**: there is nothing after it, and the driver settles the invocation
  on what it is handed.
- **Not conditional on the grade**: it runs on every path where an authorisation
  record was written — which is what makes an absent outcome mean one thing.

The event identity and the anchor are carried out of the re-check closure that
wrote the authorisation, in one frozen value, rather than rebuilt at the tail.
The two documents are then anchored to each other by identity rather than by an
equality argument spanning a hundred lines.

## 10. Post-effect write failure

A new driver member, `PUBLICATION_OUTCOME_NOT_DURABLE`, declared and tested
**immediately before `EFFECT_ATTEMPTED`**.

That order is the finding rather than a preference. The driver settles
`EFFECT_ATTEMPTED` on the dispatch fact alone and never reads a publication
member, so a post-effect evidence failure carried in `HEAD_PUBLICATIONS` would
never be looked at, and one placed after that branch would be reported as "one
act was attempted, ask again" — an instruction no invocation can carry out,
because asking again reads the *remote* and cannot recover a moment that has
passed.

**It is not `PUBLICATION_AUDIT_NOT_DURABLE`.** That member is written before the
delivery remote is contacted, says in its own words that nothing was read and
nothing was attempted, and refuses the publication. This one is reachable only
after the ladder has run to the end, and on four of its five paths a reading of
the delivery remote has already been taken. Same store family, opposite
sentences, and they cannot both be reached.

**And its own sentence may not say that anything was attempted.** The outcome is
written on every path where an authorisation was — §9 — so this member is
reachable from the four that send nothing as well as from the one that may have
changed the remote. Three independent review lenses found a first draft of it
asserting "One publication was attempted with nobody present", which is the
overclaim this whole slice exists to prevent, pointing the other way. What
separates the producers is on the `Publication` line beside it, in that member's
own words — the pattern `ATTENDED_AUTHORITY_REQUIRED` already follows for its
three refusals — and the store's own code is on the `Outcome` line under it. The
suite pins both that the sentence does not carry the first member's words and
that it does not assert an attempt.

Graded `EXIT_RUN_NEEDS_OPERATOR` as a floor, replaced by the store's own code one
code at a time — the treatment the two other post-effect stores get, for the
reason `run-exit-codes.ts` already states: a write that happens *after* something
means a caller was told yes about a thing that is not on disk, and which code
that becomes depends on what the store found. Never `EXIT_RUN_CALL_AGAIN`.

The rule for what a failed write means, in full: **it changes the invocation's
grade and nothing else.** It never refuses, never retries, never compensates,
never contacts the remote again and never touches the authorisation beside it.

**It does move one stop, and only one.** An unattended run whose ref is already
at the commit sends nothing, answers `ALREADY_PUBLISHED` and went on to the
creation in the same pass; if its outcome record cannot be established it now
stops instead. That is fail-closed and deliberate — a run that cannot say what it
did should not go on to do something else — and a confirmation pass found it
undocumented, which is why it is here.

## 11. Crash semantics

This slice does **not** close the window, and does not claim to. There is no
transaction between a ref update on github.com and a file on this machine's NTFS
volume.

| # | Crash point | Local evidence | Possible remote state | What may be claimed |
| --- | --- | --- | --- | --- |
| 1 | before the authorisation | none | untouched | nothing |
| 2 | after the authorisation, before the effect | the record | untouched | permission and subject, at that instant |
| 3 | the command goes out and this process dies | the record | **unknown** | the same as 2 |
| 4 | the command succeeds and this process dies before the outcome is written | the record | ref at H | the same as 2. **Not** that this build created it |
| 5 | the outcome is staged and the process dies | the record, and a prefix at the outcome's name | anything | the same as 2, and that a document is there and cannot be read |
| 6 | the outcome is written | both documents | as the outcome says it was read | §1 |

Rows 2 to 4 remain locally indistinguishable, exactly as before. What changed is
that rows 2 to 4 are now the *uncommon* shape rather than the only one.

**The load-bearing sentence:**

> An authorisation with no outcome beside it means **no durable outcome was
> established**. It does not mean no effect happened.

It is in the contract's header, in the store's own reading vocabulary, in the
operator's report and in the suite.

## 12. Legacy events

**Nothing is backfilled, migrated or guessed.** Every event written by slice 14
or 15 has no outcome and always will, and that is a legitimate historical shape
the reader supports for version 1 forever. No forge is consulted to fill one in.

`OUTCOME_ABSENT` therefore does **not** grade the listing down. A grade that is
permanent, that no invocation of this tool can clear and that everybody learns to
ignore is worse than no grade — which is the rule the publication command already
states about its own exit codes.

## 13. The operator-facing read

`agent-loop publication authorisations` gains one field on the arm that already
carries a record, and three value lines where an outcome was read.

**Outcome trust may never exceed its parent authorisation**, and that is a
property of the type rather than of care: the outcome fields sit on the
`HISTORICAL_AUTHORISATION` arm of the entry union alone, so the single return
that covers `RECORD_EMPTY`, `RECORD_MALFORMED`, `RECORD_UNSUPPORTED_VERSION` and
`RECORD_NOT_THIS_EVENT` cannot compile with an outcome on it. On those arms the
outcome file is not even looked at, so a readable outcome can sit beside a record
this build refused and no line of the report will name it.

That loss is stated in the report itself, and a review is why it is stated where
it is. A first draft said the entry's own sentence carried it; none of the eight
does, and none can — those sentences are about the *record*, and each has to hold
for every producer of its reading. So it is said once, in the paragraph the
report prints about the store, which is also where the same-user forgery and
deletion limits now name both documents rather than only "a record".

Seven entry readings, mirroring the record's own: `HISTORICAL_OUTCOME`,
`OUTCOME_ABSENT`, `OUTCOME_EMPTY`, `OUTCOME_UNREADABLE`, `OUTCOME_MALFORMED`,
`OUTCOME_UNSUPPORTED_VERSION`, `OUTCOME_NOT_THIS_EVENT`. Five are the contract's
own vocabulary mapped one for one; two are settled from an errno and a file test
before any bytes exist.

The report's existing discipline is unchanged and now covers four more labels:
no value line may carry an outcome word, and no printed sentence may use one
outside a denial. Every new member and every new sentence passes those sweeps as
written — which is why no member here contains `PUBLISHED`, `CREATED`, `SUCCESS`,
`FAILED`, `VALID` or `CURRENT`.

## 14. Concurrency

Two unattended invocations mint two event identities, create two directories
exclusively and write two outcomes. Neither can reach the other's name: the
outcome is written only into the directory this invocation created, under a name
only this invocation writes.

An outcome from event B is refused at event A by the subject comparison and by
the anchor, and the suite substitutes every binding input in turn.

Nothing here takes a lock, and nothing here needs one.

## 15. Authority

**An outcome grants nothing.** It cannot mint a `HeadPublicationGrant` — the
graders live in two modules and neither imports the mint, which the suite pins by
walking the source tree. It cannot satisfy a declaration, cannot trigger a retry,
cannot open a pull request and cannot merge one. The effect path writes one and
reads none.

The good reading is called `HISTORICAL_OUTCOME` for the reason slice 14 named its
own: a member called `SUCCESS` is one somebody switches on.

## 16. Network

The **writer** uses the publication path's existing network calls and adds none.
The **reader** makes none at all: the listing contacts no forge, starts no Git,
takes no lease, reads no declaration and creates nothing, and the suite sweeps
the whole read side for every one of those.

Current remote state is not historical outcome. A branch deleted tomorrow does
not rewrite what an invocation established today, and this report never asks.

## 17. Retention

**Still deferred, and now one file larger per event.** `L-V4-14-1` is unchanged
and `L-V4-16-1` records the increment. Nothing prunes this store.

## 18. Non-goals

Explicitly outside this slice, and each needs its own decision:

unattended pull-request creation; unattended merge; autonomous merge eligibility;
a scheduler; polling; automatic remediation of any kind; reconciliation of an
outcome against the forge; backfilling or migrating existing events; retention or
deletion; multi-task draining; cross-project orchestration; generic event
sourcing; and cryptographic non-repudiation — there is no key material in this
build and inventing some is a decision about key storage, permissions, rotation
and compromise that is larger than this slice.

## 19. What is carried, and what it costs

- **`L-V4-16-1` — one more file per event, forever.** The store was unbounded
  before and is unbounded now, with roughly a third more bytes in it.
- **`L-V4-16-2` — the outcome names no commit it saw.** `..._AT_OTHER_COMMIT`
  says the ref held something else and never which, so an operator answering
  "what is in the way?" reads the remote themselves. Carrying it would be one
  more value from outside this build in a document that already concedes it can
  be forged.
- **`L-V4-16-3` — a prefix can be left at the outcome's name.** §5. It reads as
  unreadable, never as valid, and nothing removes it.
- **`L-V4-16-4` — the command report is the boundary's word.** A substituted
  runner can report a completion having created nothing. The same bound the
  publication grade already carries, stated again because a member naming a
  process invites the stronger reading.
- **`L-V4-16-5` — the outcome document is meaningless outside its directory.**
  §4. That is the price of not duplicating six fields, and it is paid on purpose.
- **`L-V4-16-6` — an outcome beside a record the listing refused is never
  looked at.** §13. The outcome fields sit on one arm of the entry union, so a
  readable outcome next to a `RECORD_MALFORMED` — or a `RECORD_NOT_THIS_EVENT` —
  is not read, not graded and not named on any line about that entry. The report
  discloses the rule once, in the paragraph about the store. Repairing it means
  reading an outcome under an identity no authorisation established, which is
  the one thing an accountability listing may not do.
- **`L-V4-16-7` — one arm of the outcome reader is not reached by any test.**
  `OUTCOME_UNREADABLE` from an `lstat` that fails with something other than
  `ENOENT` is settled from the errno, exactly as the record's own absence is, and
  no fixture on NTFS can provoke that failure at a path inside a directory this
  build just made. The other producers of that member — a link, a non-file,
  bytes that would not come back — are measured. The record's twin arm has the
  same gap for the same reason, and slice 15 accepted it.
- **`L-V4-13-5` is unchanged and is the reason §1 row A exists.** A publisher
  that changed nothing still reaches the strongest reading in this vocabulary.
- **`L-V4-14-2` is unchanged and now matters twice.** Anything running as this OS
  user can write an outcome that reads exactly like the rest, and delete one
  without trace.
