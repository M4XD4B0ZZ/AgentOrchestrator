# ADR — post-merge reconciliation, beside the task rather than inside it

**Date** 2026-08-25
**Status** accepted
**Slice** V4 slice 8
**Supersedes** nothing. **Superseded by** nothing.

## The decision

AO gains one new durable record: **a merge receipt**, written to
`.agent-orchestrator/runtime/delivery-merge/<taskId>.json`, which says exactly
one thing —

> pull request #N was observed merged, from head H, into base B, producing
> commit M.

`TaskState` is **not** extended. `READY_FOR_PR` stays terminal, the transition
table is unchanged, and no task-state byte is written on any reconciliation
path. The mismatch slice 7 documented — GitHub says merged, AO says
`READY_FOR_PR` — is resolved by making the *delivery* side answerable, not by
teaching the execution lifecycle about delivery.

## The architecture question, and why it did not go the other way

The handoff for this slice asked, correctly, not to assume `READY_FOR_PR` must
gain an outgoing transition. Four options were compared against the code.

### Option A — extend `TaskState` (`READY_FOR_PR → MERGED → …`)

**Rejected, and not on taste.** It is refused by an invariant that is already
load-bearing elsewhere.

A block-ledger entry with disposition `SETTLED` is not a stored fact. It is a
standing claim, re-proved from the live task-state file on **every ledger
write** (`src/block/block-store.ts`, which re-proves *every* entry whenever any
disposition moves or a progress-claiming stop reason is recorded). Its proof has
four conditions, and this slice's design turns on the second:

| condition | where | code when it fails |
| --- | --- | --- |
| `record.state === 'READY_FOR_PR'` | `src/block/block-evidence.ts` (`disposition` prover) | `TASK_STATE_DOES_NOT_PROVE_IT` |
| `entry.evidenceRevision === <current state revision>` | same file (`evidenceRevision` prover) | `EVIDENCE_NOT_CURRENT` |
| `entry.baseCommit === record.basePinnedCommit` | same file (`baseCommit` prover) | `COMMIT_NOT_PROVEN_BY_STATE` |
| `entry.resultCommit === record.currentCommit` | same file (`resultCommit` prover) | `COMMIT_NOT_PROVEN_BY_STATE` |

The second is stronger than it looks, and it is the decisive one.
`StateLoadSuccess.revision` is **a SHA-256 over the raw bytes of the task-state
file** (`src/state/state-store.ts`). So the condition is not "the state name did
not change" — it is "the file did not change". *Any* post-delivery write to that
file falsifies it, including a same-state checkpoint that only added a field.

Therefore `READY_FOR_PR → MERGED` is not an incremental change with a test
consequence. It would make every legitimately settled entry for that task
unprovable, and the ledger has no repair path: `SETTLED` has no legal successor
disposition, an entry that changes without moving is refused as
`RECORDED_ENTRY_CHANGED`, a stopped run's only legal successor is the identical
document, and the ledger schema is deliberately non-migratable. A block
containing a delivered task could never afterwards be recorded `COMPLETE`.

There is a second, independent refusal. Every durable `TaskState` mutation goes
through `advanceTaskState`, which **requires a repository execution lease,
re-proved from disk at the moment of the write**. `delivery` holds no lease by
design. Extending `TaskState` therefore forces one of two things, and both are
worse than a separate record: either the delivery command acquires the
repository-wide execution lease — turning a read-only bookkeeping command into
an executing one that contends with runs of *other* tasks in the same repository
— or a second write path bypasses `advanceTaskState`, destroying the single
choke point whose whole justification is that a rule enforced by remembering is
a rule the next call site will break.

And a third, which is the one that would have hurt most in practice. Adding an
outgoing edge from `READY_FOR_PR` re-opens a path nothing else guards:
`recordAgentInterruption` applies no phase guard to a terminal state, so today
it is refused **only** by `canTransition`. One new edge to a blocking state makes
a caller-supplied `blockedAgent` / `resumeFrom` / `reportedResetAt` writable onto
a finished task — and from `BLOCKED_USAGE_LIMIT`, `evaluateAutomaticResume` can
then grant an **unattended** resume back into `IMPLEMENTING`. That is full
re-entry into implementation on a task that has already been merged.

### Option B — a separate durable delivery record

**Selected.** It costs the block ledger nothing, because the ledger's digest is
over the task-state file and never sees this record. It needs no lease, no
transition, no schema-version bump anywhere else, and it breaks none of the
tests that pin `READY_FOR_PR`'s terminality.

### Option C — change block-evidence semantics

A real option, and a major redesign: projection-based evidence revisions, a
separate execution revision, a broader `SETTLED` proof vocabulary, and a
migration for existing ledgers. It is what Option A would *require* rather than
an alternative to it. Out of scope for a reconciliation slice, and it should not
be reached for as a side effect of one.

### Option D — an existing, smaller pattern

This is really what was chosen, and it is worth naming as such rather than
claiming novelty. Slice 3 already argued this exact case for delivery evidence
and wrote the reason down:

> Writing this into `TaskState` would need `advanceTaskState`, which requires a
> held execution lease re-proved at the moment of the write — and this is a
> read-only command that holds no lease. […] a companion also keeps
> `READY_FOR_PR` terminal without argument, because no transition is involved at
> all.

Slice 8 is the same pattern applied to a second, differently-shaped fact.

## Why a new directory and not slice 3's record

Two reasons, and the second is the one that decided it.

**Naming.** The task-id grammar admits `.`, so any scheme that separates two
kinds of record by a *suffix inside one directory* lets a legitimately-named
task alias another task's file. A review reproduced that against
`<taskId>.delivery.json`. `runtime/delivery-merge/<taskId>.json` closes it
structurally, following `runtime/blocks/` and `runtime/delivery/`.

**Lifetime.** Slice 3's record is a *latest snapshot* — a later observation
replaces it, deliberately, because the question it answers is "what does AO know
about this task's current subject". A merge receipt is the opposite: a monotonic
event that must survive every later observation. Folding them into one file
would mean the next `--observe --record` erased the merge, which is the one fact
the next slice needs.

## Why this record has no staleness reading

`delivery-evidence.ts` downgrades to `LOCAL_BINDING_MISMATCH` the moment the
task's bytes change, and that is right *there*: it stores a snapshot of a
mutable situation about the task's current subject.

A merge event is not a situation. "Pull request #N was merged from head H and
produced M" was true the instant the forge said so and stays true afterwards.
A reading vocabulary that expired it would not be qualifying a fact; it would be
discarding one. So the record carries no `stateRevision` and has no reading
derived from one.

What replaces it is *stricter*, not laxer: a stored receipt is never merged with
a new observation and never silently replaced. Agreement writes nothing
(`ALREADY_RECORDED`, `writeAttempt: NOT_ATTEMPTED`); disagreement writes nothing
and says so (`CONFLICTING_RECEIPT`).

## The measurements this slice is built on

All read-only. **No successful external mutation was performed for this slice's
research**, which is a constraint slice 7 violated and this one did not.

### 1. Head-branch deletion changes nothing about a merged pull request

Measured on this repository, on pull requests whose head branches are absent
from `origin`: `head.sha`, `head.ref`, `base.ref`, `merge_commit_sha` and
`merged_at` are all still returned. GitHub's own schema says so — `headRefOid`
is documented as identifying the head "even if the ref has been deleted".

That is why the locator can still find a merged pull request from its head
object name after a squash merge has left that object on no branch at all, and
why branch names are never used as identity here.

### 2. A merged pull request can be merged and reachable from nothing

Pull request 61 in this repository — the scratch pull request slice 7's fence
measurements were taken on — reads `merged: true` with its resulting commit,
while its base branch answers `404` and the merge commit is an ancestor of
nothing. Merged forever; reachable from nowhere.

This is the single strongest argument for keeping *the merge event* and *the
commit's presence on the base* apart, and it is not hypothetical.

### 3. `merge_commit_sha` is mutable before the merge and set at it

Documented and measured: while a pull request is open, that field holds an
ephemeral two-parent **test** merge commit that is on no branch. The mint reads
it **only** after re-deriving `merged` from the reading, which is a correctness
gate rather than tidiness.

### 4. A revert does not unmerge anything

GitHub's revert is documented as *creating a new pull request*. The original
stays `MERGED`, with the same `merge_commit_sha`. What becomes false is "the
change is in the base tree" — a claim about the tree now, which this record does
not make.

## What `RECONCILED` proves, and the four things it does not

It proves: at `observedAt`, this process asked github.com about pull request #N
through the recognised reading boundary, and was told it is merged, at head H,
into base B, producing commit M — and H is this task's `currentCommit`.

It does **not** prove:

1. **that commit M is on the base branch now.** See measurement 2.
2. **that M passed any verification.** Nothing was run against it. That is the
   next slice.
3. **that the merge has not been reverted.** A revert is a later commit and does
   not reach these bytes.
4. **that AO performed the merge.** Nothing in a *reading* establishes an actor.
   A merge by a human in the web UI, by another authorised invocation, and by
   this build's own slice-7 effect produce the identical reading.

`MERGE_PRESENCE_SENTENCE` states all four in the operator report, and a
counter-proof mutant that weakens it into a presence claim is killed.

## Recovery is the point, which is why there is no grant

Reconciliation deliberately does **not** take a `MergeGrant`.

A grant authorises one *external merge attempt* and is spent by being claimed.
Requiring one here would be wrong three times over: there is no external
mutation to authorise; the grant is gone by the time there is anything to
reconcile; and — decisively — it would make recovery impossible. AO may crash
after GitHub merges. A human may merge in the web UI. Another authorised
invocation may merge. In every one of those cases there is no grant and there
never was one, and those are precisely the cases a reconciliation exists for.
A design that could only reconcile merges it had itself performed would reconcile
exactly the merges that need it least.

## The local write authority, stated exactly

Two things gate the write, and neither is `--attended`:

1. **the operator's explicit action** — `--reconcile-merge`, an argument nothing
   defaults and no other flag implies;
2. **a minted `MergeObservationProof`** — the store refuses anything that is not
   an artefact this process built at the reading boundary.

`--attended` is this build's marker that a person is present for an irreversible
effect **outside this machine**. This has none: it reads github.com and writes
one local file. Requiring it would make the marker mean two different things,
and would put a reconciliation — the thing you reach for *after* a crash — behind
the same gate as the merge that caused it.

That is the same footing `--record` already stands on, which is the precedent
rather than a new rule.

## The provenance boundary, and what it is not

`MergeObservationEvidence` is opaque: membership of a `WeakSet` only the mint
writes to, with the registry's `has` bound at module load, the constructor
deleted from the prototype, and both the prototype and the class frozen. The
three routes that defeated earlier artefacts here — shape, `Object.create` on
the prototype, and reaching the constructor through an instance — are each
closed and each pinned by a case.

State the guarantee exactly: **ordinary product code cannot manufacture a
merged-pull-request claim without going through the recognised reading
boundary.** It is an in-process provenance boundary and nothing more. It is not
a guarantee against a caller that imports the mint, and it is **not filesystem
authenticity**: anyone who can create a file in the repository's runtime
directory can write a receipt this build reads as genuine, having observed
nothing. The binding digest catches a receipt copied between tasks, a field
edited in place, and a record from a build that disagrees about the payload — and
it does not withstand an author who can recompute it.

## Cross-file atomicity: there is none, and none is claimed

This slice writes **one** durable file. That is deliberate and it is the reason
the design is defensible: several individually atomic renames are not one atomic
transaction, and AO has no transaction mechanism. A design that needed
`TaskState`, the block ledger and a receipt to move together would have to claim
one, and the honest thing would then be to reject the design rather than the
claim.

The one guarantee that *is* offered is read-before-write, and it is stated as
that rather than as mutual exclusion: two processes that both read `ABSENT` can
both go on to write, and nothing here stops the second. What is guaranteed is
that a receipt **already on disk when this process looked** is never silently
replaced by a different one. Two reconcilers of the same merge converge, because
they write the same event and differ only in `reconciledAt`.

## Residuals

- **L-V4-08-1 — read-before-write is not mutual exclusion.** Two concurrent
  reconcilers of *contradictory* merges for one task could both see `ABSENT`.
  Reaching that state requires two pull requests at one delivery head, which the
  ladder refuses upstream as `PULL_REQUEST_AMBIGUOUS`. Named rather than closed,
  because closing it needs a lock and a lock is a service.
- **L-V4-08-2 — the receipt is not authority.** A hand-written file in the
  runtime directory reads as genuine. The mint bounds product code, not the
  filesystem. Unchanged from slice 3 and stated for the same reason.
- **L-V4-08-3 — `advanceTaskState` permits `from === to`.** A same-state
  `READY_FOR_PR` checkpoint that rewrote `currentCommit` is not refused by the
  write primitive, only by the upstream terminal gates, and no test asserts that
  refusal. This slice takes that door nowhere — it writes no task state at all,
  which is pinned behaviourally and by scan — but the door is open for a future
  slice that reaches for "just update `currentCommit`". Found by the state scout;
  closing it belongs to whichever slice owns `advance-state.ts`.
- **L-V4-08-4 — the merge commit is not confirmed locally.** Inherited from
  `L-V4-07-8` and unchanged: the resulting commit is established from the forge
  and not by fetching the base branch. That is the next slice's question.
- **L-V4-08-5 — a receipt is never deleted or superseded.** There is no path that
  removes one. A task whose delivery was reverted and re-merged at a new head
  would be a new task with a new commit, and a receipt naming the old merge stays
  true about the old merge.

## The counter-proof

A mutation lab was built for this slice in a scratch copy of `src/` carrying no
`.git`, with `node_modules` and `dist` junctioned. **The baseline is run first
and the lab refuses to report on a red one** — which earned its keep on the first
run: without `dist/native/ao-launch.exe` every Git-using fixture answered
`GIT_UNAVAILABLE`, and a lab that skipped the baseline would have reported thirty
free kills.

32 mutants. **29 killed, 3 equivalent, 0 harness failures.**

The three equivalents, and why none is a kill in disguise:

- **the second version gate.** `readMergeReconciliation` refuses an unknown
  version twice: once from the raw value before parsing, once from the parsed
  record. Removing either alone changes nothing, because the other still fires.
  Removing **both** is `M31`, and it is killed — so the pair is load-bearing and
  neither member is individually reachable. That is what "belt and braces" means
  when it is true.
- **the `taskId` / `repositoryRoot` agreement checks.** These are unreachable
  today, and the comment that used to sit above them said the opposite —
  "the digest covers the record's own identity, not the subject's" — which the
  counter-proof measured false: `mergeReconciliationBinding` takes the subject's
  identity as an input, so a receipt bound for another task fails the digest one
  line earlier and never reaches them. The comment was corrected rather than the
  code deleted: the redundancy is one-directional and cheap, and the digest's
  input list is exactly the kind of thing a refactor edits.
- **the size bound in the reader.** Every file over the budget also fails a later
  gate, so removing the check changes no verdict. It is retained as an
  *allocation* bound rather than a verdict, and the equivalence is now measured
  rather than argued: a test builds the largest receipt the schema admits — every
  field at its maximum — and asserts it is smaller than the budget.

Two mutants were found to be defects in the *lab* rather than in the product and
were repaired rather than counted: one named a variable the source does not use,
and one disabled a single clause of an eight-clause comparison and therefore did
not express the mutation it was named after.

### What the campaign found in the product

Three things, all fixed:

1. **the registry check in `mergeObservationFactsOf` was doing no work.** Removing
   it failed no test, because the private-field read independently throws for a
   value that never went through the constructor. The module's header claims the
   registry is the gate, so the gate was made measurable: a case now constructs a
   real `MergeObservationEvidence` directly, reads its facts through the private
   accessor to prove it is genuine, and requires the public accessor to refuse
   it. The mutant is killed.
2. **the short-read guard was unreachable.** `read !== size` defends against a
   partial read that no fixture could provoke, so it was removable with the suite
   green — the shape "an absence assertion is vacuous until the mutant dies"
   describes. A `readChunk` seam makes it reachable, and the case that uses it is
   one byte short *on purpose*: the receipt is JSON plus a trailing newline, so a
   read that stops one byte early yields a complete, valid, correctly bound
   document, and this guard is the only thing between it and `HISTORICAL_MERGE`.
   Every larger shortfall lands mid-JSON and would be refused anyway — which is
   why the first version of that case passed over a build with the guard removed.
3. **an over-claiming comment**, described above.

### One thing the campaign did not have to find

`M27` sets `TRANSITION_TABLE.READY_FOR_PR` to a non-empty list and is killed by
this slice's own suite, and `M26` weakens the block ledger's `SETTLED` proof and
is killed by the block suite. Both are the invariants this ADR's architecture
argument rests on, so both are pinned by a test rather than by this document.
