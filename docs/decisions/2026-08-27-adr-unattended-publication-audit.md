# ADR — the record that has to exist before nobody publishes anything

**Date** 2026-08-27
**Status** accepted
**Slice** V4 slice 14
**Supersedes** nothing. **Superseded by** nothing.
**Amends** one. **Amended by** `2026-08-27-adr-publication-authorisation-listing.md`,
which takes up this ADR's own non-goal of an operator-facing command that lists
the store (§13), and narrows `L-V4-14-3`; and by
`2026-08-27-adr-publication-outcome-evidence.md`, which reverses §11 and takes up
the other non-goal in §13, a post-effect outcome record. That ADR answers §11's
three arguments one at a time and accepts the third: `(record, no outcome)` says
exactly what `(record)` alone says, and it is now the uncommon shape rather than
the only one. And by `2026-08-27-adr-publication-branch-lookup.md`, which splits
§13's "searching, filtering and indexing the store" into its three words, taking
up one exact-identity filter and leaving searching and indexing outside. It
narrows `L-V4-14-3` a second time and does not close it.

`2026-08-26-adr-unattended-head-publication.md` §12, whose first sentence reads
"**The publication writes nothing.**" That stops being true for the automatic
path, in one bounded way: an unattended publication now writes exactly one
immutable record, under the operator's own profile, before it contacts the
delivery remote. That section's list of six things the publication does not write
loses exactly one member — "no publication record" — and keeps the other five: no
task state, no block ledger, no delivery record, no selection record, no cached
permission. Nothing about the grant survives the process, and the attended path
is unchanged in every observable way, including that it still writes nothing at
all.

## The decision

**AO may not perform an unattended head publication unless it has first written,
and read back, a durable record of the permission it is acting under and the
subject it is about to act on.**

One new operator-owned directory,
`<OS user profile>/.agent-orchestrator/head-publication-authorisations/`. One
immutable file per invocation that establishes the permission and the subject —
which is not the same as per attempt, and §1 row D is where that difference is
spelled out. Two new production modules. One new member in the publication
vocabulary and one in the driver's. No new flag, no new grant, no new effect, no
change to the push, and no change to the attended path.

## The three sentences the contract rests on

> **The record is a precondition of the act, not a note about it.** If it cannot
> be written and read back, nothing is read from the delivery remote and nothing
> is attempted.

> **It says what was established before anything was contacted, and nothing
> after.** Not that a publication was attempted, not that a ref exists, and above
> all not that this build created one.

> **It is evidence for a person and never an input to an authority.** No future
> publication is closer to happening because a record exists.

## 1. The exact claim, and the three it refuses to make

The record asserts exactly this:

> At `authorisedAt`, an invocation of this build established — from the trusted
> operator declaration whose exact bytes are `declarationDigest` — that automatic
> head publication was permitted for `{host, owner, name}`, and resolved
> `{taskId, repositoryRoot, declaredRemote, ref, commit}` as the subject of the
> one create-only publication it was then authorised to attempt. These bytes were
> written before this invocation contacted the delivery remote at all.

Six candidate claims were separated before anything was written, and only three
of them are made:

| | Claim | In the record? |
| --- | --- | --- |
| A | the declaration permitted automatic publication for this exact identity | **yes** |
| B | the publication subject was exactly this task, repository, remote, ref and commit | **yes**, and enforced rather than assumed — see §7a |
| C | the invocation had reached the point where an attempt was permitted | **yes** — that is what "was then authorised to attempt" says, and no more |
| D | the effect function was entered | **no.** The record is written before the URL agreement, before the pre-reading and before the push. A run that finds the ref already at this commit, or holding another one, or a remote whose two URLs disagree, or one whose ref cannot be read at all, sends nothing and leaves this record behind |
| E | the remote ref afterwards holds this commit | **no.** Nothing is written after the effect |
| F | AO created the ref | **no, and it could not be.** `L-V4-13-5` measures the case: a create of a commit a ref already holds exits zero and reports the remote up to date without the empty lease being evaluated, so a publisher that changed nothing is graded `PUBLISHED`. The transport's `--porcelain` output does distinguish `*` from `=`, and this build deliberately does not read it — the postcondition comes from a second `ls-remote`, which cannot tell who moved the ref either |

The vocabulary is swept for F rather than trusted to stay away from it: the suite
requires the record to carry no field named `published`, `attempted`, `created`,
`createdBy`, `state`, `phase`, `status`, `expiresAt`, `retryAfter` or `pending`,
and to contain no member of `HEAD_PUBLICATIONS` anywhere in its bytes.

## 2. Where it lives, and why not where every other record does

    <OS user profile>/.agent-orchestrator/head-publication-authorisations/
        <event id>/
            authorisation.json

Every other durable delivery record in this build sits inside the repository it
describes, and `state/state-location.ts` gives the reason well: state belongs to
the repository it describes. That reason **inverts** here.

**The subject outlives the checkout.** What this record is about is a ref on a
forge. The checkout is the most deletable thing in the system, and "delete the
repository and the record of what you were authorised to publish goes with it" is
not a property anyone would choose for an accountability record. A case drives
this: the repository is deleted after a publication and the record is read back
unchanged.

**The audited party must not own the store.** `--repository` is a path, and a
linked worktree answers `rev-parse --show-toplevel` with itself, so it resolves as
a repository in its own right. Point the command at ground the writing agent can
edit and every in-repository store is inside that agent's sandbox. The operator
profile is the one root immune to that, and the immunity is structural:
`orchestratorHome()` resolves through `config/internal/trusted-profile.ts`, which
reads `os.userInfo()`, consults no environment block and takes no parameter.

**It is where the authority already lives.** The declaration this record names is
a file in that same directory. One trust argument governs both, and no repository
operation can separate them.

There is a fourth reason, and it is about *order* rather than place. An
in-repository record must ask Git whether its own path is ignored before it may
be written — an un-ignored file under the runtime directory makes the checkout
dirty and the next run refuses. Under this slice the record is a precondition of
a forge mutation, so that question would put the target repository's `.gitignore`
and two more child processes on the critical path of an authority record. A case
drives an invocation whose ignore probe can only answer `UNDETERMINED` and
requires it to record and publish anyway.

The cost is stated rather than hidden. The record is not repository-reviewable
and travels with the machine rather than with the code: `L-V4-13-2`'s trade,
taken a second time, deliberately, for an artefact whose whole point is that the
audited party cannot reach it.

## 3. What can forge it, exactly

**Any process running as this OS user can write a byte-identical record having
authorised nothing, and can delete any record without trace.** That is stated
first because the reassuring reading is wrong.

`binding` is an **integrity binding, not a message authentication code**. Every
input to it is plain text sitting beside it, so an author who can create the file
can also recompute the digest. There is no key material anywhere in this build —
measured: zero `createHmac`, no key derivation, no key store — and introducing
some would be a decision about key storage, permissions, rotation and compromise
that is larger than this slice.

What the digest does catch is the realistic damage, and each of those is driven:
a record copied out of one event directory into another, any single field edited
in place without recomputation, and a record read under a substituted event, task
or repository.

**Deletion is not caught at all.** An absent record and a record that never
existed are the same bytes.

**File modes are not a defence.** `mode: 0o600` and `0o700` were measured on this
NTFS volume to yield `0o666`; access is governed by inherited ACLs on the profile
directory.

`L-V4-13-1` is unchanged and now covers a second file: an agent that could execute
arbitrary commands as this OS user could write or delete both the declaration and
the record.

## 4. The record's shape, and what is deliberately absent

```
authorisationVersion      1, a literal
eventId                   the directory's own name; binds the record to where it sits
act                       HEAD_PUBLICATION
invocationMode            AUTOMATIC
taskId
repositoryRoot            the canonical local root; two clones are two of these
host / owner / name       the exact forge identity that was graded
declaredRemote            the local remote NAME, never a URL
ref                       refs/heads/<workBranch>
commit                    the exact object name
declarationSchemaVersion  1
declaredPermission        AUTOMATIC_ALLOWED
declarationDigest         SHA-256 of the exact declaration bytes
authorisedAt              the instant the record was built, immediately after
                          the permission was graded and the subject checked
binding                   SHA-256 over all of the above, under its own label
```

Absent, and named as absent: no URL as such — `host`, `owner` and `name` are the
forge identity the delivery target parsed out of the remote's URL, and they are
the whole of what this record takes from it, with no scheme, no userinfo, no
port, no path and no query — no credential, no bytes of the declaration, no entry
of it other than the one that matched, no subprocess output, no foreign exception
message, no repository-authored prose, no path to the declaration, and no field
with a state machine in it. **Not** absent, and
said so: an operator user name, which `repositoryRoot` carries whenever the
checkout sits under a Windows user profile. That is a local path in a file under
that same user's profile, and claiming it away would be the kind of stated
absence a later slice builds on.

Two of those are driven rather than asserted. The publication runner in the suite
answers both `git remote get-url` calls with a URL carrying a user name and a
token, so "no credential reaches the record" is measured against a credential
that really was in reach; and a declaration naming a second, unrelated repository
is used, so "no unrelated entry is copied" is measured against one that existed.

`declaredPermission` is written as a constant, and the constant is true for a
reason about the code rather than about the writer's care:
`permitsUnattendedHeadPublication` decides on an exhaustive switch over the
declaration vocabulary in which exactly one arm answers `ALLOWED`, so an
`ALLOWED` answer *is* that member. A case drives the
grader over the whole declaration vocabulary and requires exactly one member to
grade `ALLOWED`.

## 5. What `declarationDigest` means

It means **these bytes**, and never "this meaning".

The digest is taken over the `Buffer` `readFileSync` returned, before any
decoding, and it is carried out of the same read that produced the permission —
never from a second read, which would be a second file. It is present only on the
`DECLARED` outcome: a refusal may carry nothing derived from the file it refused,
which is the rule that module already applies to itself.

The consequence is stated exactly rather than softened. A comment, a trailing
newline, CRLF line endings and a change to an entry naming some other repository
all produce a different digest, and all four parse to the same permission. A case
drives all four and requires four different digests. This build cannot claim
those edits did not matter, because it did not read the file that way.

The one place where "over the bytes" is more than pedantry is measured too: a
declaration whose trailing comment carries two bytes that are not valid UTF-8
parses and permits, and a digest taken after a decode is a different number,
because decoding replaces them. The record carries the digest of the bytes.

## 6. Where it is written, and why exactly there

```
--drive: conclusion, receipt, verification read from disk
        ↓
fresh observation of github.com, fresh decision -> PULL_REQUEST_REQUIRED
   (skipped where the forge will not resolve the delivery commit: V4 slice 18R)
        ↓
mayPerform(PUBLISH_HEAD)
        ↓
performPublication ladder: subject -> READY_FOR_PR -> AUTHORITY (declaration read)
        ↓
mintHeadPublicationGrant  (unchanged)
        ↓
publishDeliveryHead       (unchanged)
   claim
   recheck ─┬─ repository, task record, subject, work branch, all re-resolved
            ├─ AUTHORITY RE-PROVED against the identity this pass resolved
            ├─ SUBJECT EQUALITY: the six fields the grant was minted from, plus
            │    the repository root — or the closure refuses (§7a)
            ├─ ★ THE RECORD: built, judged, one exclusive directory, staged,
            │    flushed where the filesystem allows, renamed, read back —
            │    or the closure refuses
            └─ returns the subject
   two `git remote get-url`      ← nothing is consulted in this window
   one `ls-remote`               ← network, 120 s ceiling
   at most one push
   one `ls-remote`
        ↓
STOP
```

Four other placements were considered and each loses something this one keeps.

**Before the mint**, in the ladder body: cheapest, and it audits a permission
that the re-proof may withdraw a moment later. A case drives exactly that — the
declaration is removed on the resolve the re-proof performs — and requires **no
record**.

**Inside `publish-delivery-head.ts`**, between the recheck and the pre-reading,
or immediately before the push: the second narrows the window to nearly nothing,
and both cost the module's stated invariant. That module is not taught what a
declaration is, it says so in the code, and its whole documented design is "the
order of six steps and the refusal to take a seventh". Neither placement can
condition on which grant was minted, because the grant deliberately carries no
notion of attendedness — so both would change the attended path.

**In `git-head-publisher.ts`**: refused. That module holds identities and object
names and nothing else, and its vectors are pinned by exact equality.

The chosen point is the only one that is both inside the module that owns the
authority and strictly after the last time this build reads anything of its own.

**It does not narrow `L-V4-13-4`, and this ADR does not pretend otherwise.** Two
local `git remote get-url` calls and one `ls-remote` — a network round trip with
a 120-second ceiling — still run between the record and the push, and nothing is
consulted inside that window. What the record's claim says is bounded to match.

## 7. Why the refusal cannot describe an effect

The closure returns `null`, which `publishDeliveryHead` grades `SUBJECT_CHANGED`
with nothing attempted, and `performPublication` renames that into
`PUBLICATION_AUDIT_UNWRITTEN`. The rename is the channel slice 13 already built
for the withdrawn-permission case, guarded three ways: only on that exact member,
only when the closure recorded a reason, and only into a member that asserts the
same thing — nothing read, nothing attempted.

That third guard is a property of the ladder rather than a hope. `recheck` runs
second, before the URL agreement, before the pre-reading and before the push, so
a result carrying this member cannot describe an effect. A record written *after*
the remote had been contacted could not be renamed into a refusal at all, which is
why the placement and the vocabulary are one decision rather than two.

One variable carries both reasons, because they cannot both happen within one
execution of the closure and the closure runs at most once: `publishDeliveryHead`
awaits `recheck` at exactly one call site, with no loop and no retry.

## 7a. The record may not name a subject the grant does not authorise

The record is built from the facts *this* pass resolved, and the authority to
publish was minted from the facts the ladder resolved a moment earlier. Those can
differ — another process holding this repository's execution lease can advance a
task while this command runs, which is the reason `recheck` exists at all.

`publishDeliveryHead` compares the two, over six fields, and refuses
`SUBJECT_CHANGED` with nothing attempted. But it does that *after* the closure
returns, so an earlier draft of this slice wrote the record first: a durable
record naming a remote, ref and commit no grant in this build had authorised, for
a publication that was refused one step later. A review reproduced it two ways —
by moving the declared remote on the re-check's own resolution, and by advancing
the task's commit — and in both runs the only durable artefact of the invocation
asserted an authorisation that never existed.

So the closure asks first, and refuses before it writes. It asks over seven
fields rather than six: the six `sameSubject` will compare, plus the repository
root, which it will not — the record names the root *this* pass resolved while
the push runs Git in the root the ladder resolved, and a record naming a checkout
the publication was never run in would be the same defect wearing a different
hat.

**Two outcomes change, and both are stated rather than glossed.** An earlier
draft of this paragraph said one, and a confirmation pass counted them.

The first is on the six fields `sameSubject` also compares. A run whose subject
moved *and* whose record could not have been written used to reach the write,
fail it, and be renamed `PUBLICATION_AUDIT_UNWRITTEN` by §7's arm; it now reports
the `SUBJECT_CHANGED` it always was, and settles and exits accordingly. That is
the more truthful of the two: nothing about the store is what stopped it.

The second is the seventh comparison. `sameSubject` does not compare the
repository root, so a run whose six subject fields matched but whose re-check
resolved a different root used to **publish**; it now reports `SUBJECT_CHANGED`
and sends nothing. That is a real narrowing rather than a no-op, and it is the
fail-closed direction: publishing there would leave a record naming a checkout
the publication was never run in. A case drives it, opening with a control on the
same fixture that publishes.

Row B of §1 is enforced rather than hoped for. It does **not** make row D's
enumeration exhaustive — a pre-reading that cannot be taken at all still leaves a
record behind with nothing attempted, and row D names that shape too.

## 8. Why an unaudited automatic publication is unconstructable

The authority answer is three shapes, not one shape with an optional half:

```
{ outcome: 'AUTHORISED'; grant: 'OPERATOR_PRESENT' }
{ outcome: 'AUTHORISED'; grant: 'OPERATOR_DECLARATION'; declarationDigest: string }
{ outcome: HeadPublication }
```

An authority graded from a declaration **carries** the digest, so it cannot be
constructed without naming the bytes it was graded from, and the gate downstream
is which grant answered rather than which flag was passed. The two cannot drift
apart, because there is exactly one place that decides which arm ran.

This shape was chosen after a counter-proof: the earlier one carried
`automatic: Permission | null`, and a mutant that widened the `null` case
survived the whole suite. It is now a compile error.

## 9. Concurrency

Two unattended invocations may run at once on one repository and one task.
Nothing local fences them — the publication takes no execution lease, and
deliberately, because a local lock cannot fence a second clone, another machine
or a person with a terminal.

So the identity is per **event**, not per task, and the fence is the kernel's: the
event directory is created with a non-recursive `mkdir`, which either creates it
or fails `EEXIST` in one step. A name already taken is a refusal, never a reuse,
and a case drives it and requires the first record to be byte-identical
afterwards.

Every existing per-task store here would have been wrong. They are file-per-task
and published by replacement, and a rename overwrites: two invocations would
produce one record and the survivor would be whichever finished second. A mutant
that writes into a shared name instead of an event directory does not survive the
suite.

The name is a UTC instant plus a version-4 UUID. Neither part is trusted on its
own — equal timestamps collide by construction and a process id is reused after
exit — so the guarantee comes from the exclusive `mkdir` and the name only has to
be unlikely to repeat. A case mints 64 identities at one pinned instant and
requires 64 distinct names, and a mutant that weakens the identity to the instant
alone does not survive it.

**Nothing from the repository, the task, the forge identity, the environment or
the command line enters the path.** Two measurements decided that. Owner and
repository names admit Windows device names, trailing dots and a hundred
characters, and the declaration's own schema admits arbitrary text of the same
length because it is only ever compared exactly. And identity is compared
case-sensitively while NTFS folds case, so two entries differing only in
capitalisation are two different permissions that would file into one directory —
two authorities, one trail, and the trail unable to say which authority it was
about. A case records under both spellings and requires two directories.

## 10. Crash semantics

| # | Crash point | Local evidence | Possible remote state | What may be claimed | Another attempt automatically allowed? |
| --- | --- | --- | --- | --- | --- |
| 1 | before the declaration is read | none | untouched by this run | nothing | **no** — a fresh invocation, a fresh declaration read, a fresh grant |
| 2 | after the declaration is read, before the record | none; the permission was never stored | untouched | nothing | **no**, same |
| 3 | while the record is staged | the event directory, and inside it a staging file or nothing at all; the record's own name is absent | untouched | nothing — the record is opened **by name** inside the event directory, which is never enumerated, so an event directory holding only a staging file is not a record. V4 slice 15's operator-facing reader enumerates the store **root** and is bound by the same rule one level down: it lists event directories and opens `authorisation.json` by name, and reports this shape as `RECORD_ABSENT` | **no**, same |
| 4 | after the record, before the effect | the record | untouched | permission and subject, established at that instant; nothing attempted | **no**, same |
| 5 | immediately before the push process starts | the record | untouched | the same as 4, and the record cannot distinguish itself from 4 | **no**, same |
| 6 | the push starts and this process dies | the record | **unknown** — the server may have committed the ref | the same as 4. Nothing about the ref | **no**, and safely: the next run's pre-reading answers `ALREADY_PUBLISHED` and sends nothing |
| 7 | the push succeeds and this process dies before returning | the record | ref at H | the same as 4. **Not** that this build created it | **no**, same |
| 8 | the push succeeds, the reading afterwards fails | the record; `OUTCOME_UNCERTAIN` reported | ref at H, unreadable | one attempt was made and the ref could not be read afterwards | **no** — and a retry begins with a reading, never a second push |
| 9 | the push loses the race to the same commit | the record; `PUBLISHED` reported | ref at H, created by somebody else | the remote holds H. **Not** who put it there. `L-V4-13-5` | **no** |
| 10 | the push loses the race to another commit | the record; `REF_HOLDS_ANOTHER_COMMIT` | ref at G, unchanged by this build | an attempt was made and refused | **no**, and it structurally cannot push: the pre-reading refuses |
| 11 | the transport returns an outcome this build cannot classify | the record; the grader's own uncertain member | anything | the transport did not report success | **no**, and nothing is retried inside the call |
| 12 | the record is written and the permission is revoked before the push | the record, naming bytes that were current at that instant | possibly changed | permission at that instant. **Not** "the operator permits this now" | **no** — and the next invocation re-reads the file twice |
| 13 | a record exists and the next invocation starts | a record from a previous invocation | unknown from the record | **nothing about the current invocation** | **no.** This row is the whole of "audit is never authority" |

Rows 4 to 7 are **locally indistinguishable**, and this ADR says so rather than
implying otherwise. Distinguishing them would need a second record written after
the effect, which is §11.

None of the safety in the last column comes from the record. It comes from the
push happening only on a freshly confirmed absence, which this slice does not
touch.

## 11. Why there is no second record

> **Reversed by V4 slice 16.** This section decided, at this date, that the pair
> was refused; the pair shipped, and
> `2026-08-27-adr-publication-outcome-evidence.md` §0 answers each of the three
> arguments below one at a time — accepting the third in full and rebutting the
> fourth paragraph's premise, which is the one that shaped the replacement's
> design. What follows is left as it was written.

Both independent investigations recommended a pair — an authorisation record
before and an outcome record after — on the ground that only the *arity* of the
local evidence separates "authorised and nothing happened" from "authorised and
something may have landed". That argument is correct and the pair is still
refused, for three reasons.

**It is not the prerequisite this slice closes.** The gap slice 13 left is that an
unattended act had no durable explanation *of what authorised it*. An outcome
record answers a different question.

**A post-effect record cannot be a precondition of anything, and must not be
best-effort either.** It would need its own rule about what a failed write means,
at the one moment when the effect has already happened and nothing can be undone.

**Two durable records are not a transaction and would be read as one.** The
honest reading of `(record, no outcome)` is "this build cannot say what happened",
which is exactly what `(record)` alone already says.

What an outcome record would add over the remote itself is the transport's own
report, which is weaker evidence than a reading and cannot establish authorship
either. It is named as a non-goal rather than deferred silently.

## 12. Retention

**Unbounded, and stated as a decision.** One directory per authorised unattended
publication attempt, forever, holding one small JSON document — and, since V4
slice 16, a second one beside it. Nothing deletes any of it.

That is the same absence `doctor/run-directory.ts` already declares, for another
directory under the same profile, in the same words: retention is out of scope until there is a
policy, and an incomplete artefact is left exactly as it is rather than cleaned
up. The bound in practice is operator invocations of a command that requires
three flags and a standing declaration.

`L-V4-14-1`.

## 13. Non-goals

Explicitly outside this slice, and each needs its own decision:

a post-effect outcome record; unattended pull-request creation; unattended merge;
autonomous merge eligibility; review-policy evaluation; CI polling; a scheduler; a
daemon; recurring execution; draining more than one task per invocation;
cross-project orchestration; a generic audit framework for every AO action;
cryptographic non-repudiation; a retention policy; an operator-facing command that
searches the store; and auditing the local acts a `--drive` performs.

**Two of these were taken up.** "An operator-facing command that lists the store"
is no longer a non-goal: V4 slice 15 shipped `agent-loop publication
authorisations` under its own decision, as this section requires. See
`2026-08-27-adr-publication-authorisation-listing.md`. **"A post-effect outcome
record" is no longer one either:** V4 slice 16 shipped `outcome.json` beside each
authorisation, under its own decision and answering §11's three arguments one at
a time. See `2026-08-27-adr-publication-outcome-evidence.md`.

**And "searching, filtering and indexing" is no longer one sentence:** V4 slice
17 took up one exact-identity branch filter, under
`2026-08-27-adr-publication-branch-lookup.md`. Searching and indexing are still
outside, and so is everything else in the list.

`READY_FOR_PR` remains terminal and the transition table is untouched.

## 14. What is carried, and what it costs

**`L-V4-14-1` — the store is unbounded.** See §12. Every authorised unattended
publication attempt adds one directory holding one small document — two since V4
slice 16 — and nothing removes any of it.

**`L-V4-14-2` — the record is not tamper-proof and its absence proves nothing.**
See §3. Same-user forgery and same-user deletion are both open, the binding is not
a MAC, and file modes do not restrict anything on NTFS.

**`L-V4-14-3` — the store is not indexed.** Records are addressable only by event
identity; the repository, task, ref and commit live in the body. Finding the
record for a branch means reading the directory. That is the price of putting no
identity in the path (§9). V4 slice 15 added the reading — one command that
lists the whole store — and V4 slice 17 added the asking: four flags naming one
branch exactly, so an operator no longer reads every entry to find one. What
remains after both is that **the machine** still does. There is no index and no
search; answering a question about one branch means opening and grading every
entry in the store.

**`L-V4-14-4` — hard links are not inspected.** The link check on the store's path
uses `lstat` and catches symbolic links and junctions, which is measured. A hard
link is not a reparse point and nothing counts links, so a record's name could be
made to alias another file. Other reparse-point classes — volume mount points,
cloud-file placeholders — were not measured and nothing is claimed about them.

**`L-V4-14-5` — "written and read back" is not "durable across power loss".** Two
gaps, both stated rather than rounded away. The staging handle is flushed only
where the filesystem supports flushing: the primitive treats an `EINVAL` from
`fsync` as "not supported here" and reports the write as done, and this store
does not refuse that, because refusing would make an unattended publication
depend on a filesystem property nothing else in this build depends on. And the
directory entry is never flushed at all, because nothing in this build flushes
one.

**`L-V4-14-6` — the record does not cover the local acts a drive performs.** The
grant requires `--drive`, and a drive can write the merge receipt, the
verification history and the delivery conclusion, take this repository's execution
lease and run the profile's verification commands. None of that is a forge
mutation and none of it is recorded here. `L-V4-13-9` unchanged, and now with a
sharper edge: an operator reading this store sees the forge act and not the local
ones.

**`L-V4-14-7` — a subject this build will not record cannot be published
unattended.** The record bounds a ref at 300 characters and a repository root at
4096, and nothing on the publication path bounds either: `PUBLISHABLE_REF`
carries no length and the task record bounds `workBranch` only as non-blank. A
work branch this build *derives* is bounded at 255 by `isValidBranchName`, so
`refs/heads/<name>` is at most 266 and fits; a task record carrying a branch
longer than 289 does not, and that delivery publishes attended and refuses
unattended under a member that says the refusal is local. Fail-closed, and stated
because it will look like a store problem to whoever hits it.

**`L-V4-13-4` is unchanged and now matters differently.** No *permission* is
re-read between the authority re-proof and the push, and no permission is
consulted inside that window. The window itself is not empty any more: the
record's own write and read-back happen there, before the two `git remote
get-url` calls and the `ls-remote`. What the record adds is that the fact proved
before the window is now durable; what it does not add is a narrower window.

**`L-V4-13-5` is unchanged and is the reason for §1's row F.** A publisher that
created nothing can report `PUBLISHED`, and no record this slice writes may be
read as evidence of authorship.

**`L-V4-13-8` — no live product dogfood was possible.** Unchanged. This
repository has no orchestrated task and no runtime state, so no legitimate
delivery could exercise the automatic path end to end. What is measured against
real bytes is the store — real directories under a real scratch profile, created
by the real exclusive `mkdir`, written by the real crash-safe primitive, read back
off the disk — and the declaration, and the fence.

**Not carried, because it was measured false:** the concern that the two readback
checks were both load-bearing. One of them could not fail while the other passed,
and a redundancy that reads as coverage is worse than none. There is one
comparison now, and removing it fails a case.
