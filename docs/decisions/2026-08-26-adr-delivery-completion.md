# ADR — delivery completion from a reconciled merge and exact-commit verification

**Date** 2026-08-26
**Status** accepted
**Slice** V4 slice 10
**Supersedes** nothing. **Superseded by** nothing.

## The decision

AO gains one new capability: **join a task's slice-8 merge receipt to its
slice-9 post-merge verification history, and durably record that this task's
delivery is concluded.**

Both documents are read in one invocation and required to describe **one
delivery**. The verification must carry a *standing pass* for the receipt's
merge commit under the verification profile resolved now.

One new durable record, written to

```
.agent-orchestrator/runtime/delivery-conclusion/<taskId>.json
```

One new flag, `delivery --conclude-delivery`.

`TaskState` is **not** extended. There is no `COMPLETE` state. `READY_FOR_PR`
stays terminal, the transition table is unchanged, `currentCommit` stays the
implementation head **H**, the block ledger is not written, no execution lease
is taken, no agent is started, no verification is run, no Git history is read
and nothing is sent to github.com.

The sentence the record carries is:

> At time T, this task's delivery was concluded: its implementation head H was
> merged as pull request #N on that target, producing merge commit M, and M
> stood at a pass under verification profile P.

## Commit claim versus delivery claim

The two are different, and separating them is the whole of this slice.

`post-merge-verification.ts` records a claim about a **commit**: *at time T,
commit M completed profile P with result R.* That sentence is true of M no
matter which task, receipt or pull request it came from; the record's own header
says the subject is a commit, "emphatically not the delivery".

A **delivery** claim needs the join, and **nothing before this slice made it**.
Measured by reading the code at `ff1cf0a`:

- `verify-merge.ts:446-457` compares the history's `mergeCommit` against the
  receipt's, and nothing else, on its convergence path;
- `post-merge-verification-store.ts:238-251` (`sameDelivery`) compares the rest
   — `subjectCommit`, target, pull-request number — but only on the write path,
  which a converged run never reaches;
- no other module in `src/` reads the verification record at all.

So a verification history filed under a task, recording a genuine pass of a
genuine commit, could carry a **different pull-request number, a different fork
or a different implementation head** and be indistinguishable from a correct one
to every existing reader. `internal/delivery-conclusion-proof.ts`'s
`describesSameDelivery` closes that with six comparisons, and the ladder reports
it as `VERIFICATION_NOT_THIS_DELIVERY` — a member no existing code path could
ever have produced.

## The four propositions, and which two are required

| | proposition | required? |
| --- | --- | --- |
| **P1** | commit M has a `VERIFIED_PASS` standing under profile P | **yes** |
| **P2** | M is reachable from the configured delivery base | **no** — see below |
| **P3** | the merge receipt still reconciles *this task* to M | **yes** |
| **P4** | this task's delivery may be concluded | `P1 ∧ P3` |

They are not collapsed into one boolean, and P2 is not merely omitted for
simplicity — it is refused on measurement.

## Why base membership is not asked

Four measurements, three of them made against real Git fixtures built for this
slice (Git 2.55.0.windows.3, Windows 10 19045, local repositories).

### 1. Ancestry is not a claim about content, in either direction

Two fixtures, identical on the predicate a membership gate would be built on:

| fixture | `merge-base --is-ancestor M main` | M's content in base |
| --- | --- | --- |
| base advanced linearly past M | exit **0** | present |
| M reverted by `git revert -m 1` | exit **0** | **gone** — `git diff --stat M main` reports `f.txt \| 1 -` |

And the converse: a fixture whose base carries M's tree byte-identically under a
squashed object name answers `--is-ancestor` with exit **1** while
`git diff --stat M main` is **empty** and `tree(M) == tree(base)`.

A content command **does** separate them — `git diff --stat M main` reports
`f.txt | 1 -` for the reverted fixture and nothing of the sort for the advanced
one, and this ADR runs exactly that to prove the content is gone. So the claim
is about the *graph* predicate, not about every Git command, and an earlier
version of this section said "identical on every predicate" while running the
counterexample two paragraphs later. A review measured it.

So ancestry is neither sufficient nor necessary for "the delivery's changes are
present". A third fixture — revert, then revert the revert — answers 0
throughout, confirming that ancestry is invariant under content churn and
therefore carries no content information at all.

**No Git predicate proves "M's changes are still present in base."** That is
stated as a bounded claim: none of the predicates measured does, and `git cherry`
/ `patch-id` were **not** measured and are not claimed either way.

### 2. The predicate can answer "no" when the truth is "yes", silently

Measured in a repository cloned `--depth 1` where M was fetched afterwards, so
the object is present but the walk from the base stops at a graft boundary:

```
GROUND TRUTH (origin):  git merge-base --is-ancestor M main  -> exit 0
SHALLOW REPO:           git merge-base --is-ancestor M main  -> exit 1   (stderr EMPTY)
```

`cat-file -t M` answers `commit`; `rev-parse --verify M^{commit}` exits 0. Every
existence check passes. The wrong answer is byte-identical to the genuine "no"
of a force-push, with nothing on stderr.

A second, independent vector: a tag `refs/tags/main` beside branch
`refs/heads/main` makes the bare name `main` resolve to the **tag**. What
follows depends on where the tag points, and an earlier version of this
paragraph did not say so — a review measured both:

```
tag main at an OLDER commit:  merge-base --is-ancestor <branch-tip> main  -> exit 1
tag main at the branch tip:   merge-base --is-ancestor <branch-tip> main  -> exit 0
both:                         stderr: warning: refname 'main' is ambiguous.
```

The ambiguity and the warning are unconditional; the wrong `1` is not.
`--is-ancestor <tip-of-branch> refs/heads/main` exits 0 in both. The only tell
is that stderr `warning:`, and **neither of this build's Git runners surfaces
stderr**
(`repo/git-query.ts` drops it and the exit code with it; `worktree/git-command.ts`
keeps the exit code and drops stderr).

A completion gate that read exit 1 as "your delivery is not on the branch" would
be wrong in both states and unable to know it.

### 3. The base AO can see is local, and AO does not fetch

`TaskState.baseBranch` comes from the repository profile's
`repository.defaultBranch` and is existence-checked as a **local** ref
`refs/heads/<name>` (`repo/resolve-repository.ts:539-550`). There is no `git
fetch` anywhere in `src/` — that is L-V4-09-3 and it is unchanged by this slice.
So the local base is a snapshot of whatever the operator last pulled.

Measured on **this repository, while this slice was being written**, and
verifiable from its own reflog. Pull request #64 was merged producing
`ff1cf0a` (committer date 07:13:56 UTC). `git reflog show origin/main` records
the fetch that moved `refs/remotes/origin/main` to it; `git reflog show main`
records the fast-forward of the **local** branch — the ref
`TaskState.baseBranch` resolves to — as a separate, later entry at 07:14:32 UTC.

In the 36 seconds between them the object was in the clone and
`refs/heads/main` still pointed at `e203143`, the previous delivery's merge
commit. A gate on the local base would have answered exit **1** — the genuine-no
code — for a merge that had just succeeded. Before the fetch it would have
answered 128 instead, which is not an answer either.

An earlier version of this paragraph said "minutes earlier". A review measured
the reflog and it is 36 seconds; the window is real and the adjective was not.
The window is also not bounded by anything: nothing obliges an operator to
fast-forward at all, and an operator working on a branch may never do so.

### 4. The record this is drawn from already disclaims the property

`post-merge-verification.ts:18-25` lists "currently on the base branch" and
"currently reachable from the base" among the four things a pass does **not**
say. Adding the property to the conclusion would contradict the document it is
drawn from rather than extend it.

### What is therefore true, and what is not

`--conclude-delivery` means **the delivery happened and the commit it produced
was verified**. It does not mean the change is still there. `CONCLUSION_EVENT_SENTENCE`
says so on every run that produces a conclusion, and five real-Git fixtures pin
that the answer is identical when the base has advanced, when the merge has been
reverted, when the base has been force-moved off it, when the merge object is
absent from the repository entirely, and when the base branch does not exist —
each with a control asserting that Git really does answer differently in that
fixture.

## Why `TaskState` did not gain a `COMPLETE` state

Not taste. Three measured refusals, each already load-bearing:

1. **The ledger's byte digest.** A `SETTLED` block-ledger entry carries
   `evidenceRevision`, a SHA-256 over the **raw bytes** of the task-state file
   (`block/block-evidence.ts:180-187`). *Any* post-delivery write — a transition
   or a same-state checkpoint — falsifies every settled entry for that task, and
   the ledger has no repair path. A block containing a delivered task could
   never afterwards be recorded `COMPLETE`.
2. **The lease.** Every `TaskState` mutation goes through `advanceTaskState`,
   which requires a repository execution lease re-proved from disk at the write.
   `delivery` holds none except transiently under `--verify-merge`, and taking a
   repository-wide writer slot to file a judgement would make bookkeeping
   contend with runs of *other* tasks.
3. **The re-entry hazard.** `recordAgentInterruption` applies no phase guard to
   a terminal state — it is refused only by `canTransition`. One outgoing edge
   re-opens a path to `BLOCKED_USAGE_LIMIT`, from which `evaluateAutomaticResume`
   can grant an **unattended** resume into `IMPLEMENTING` on an already-merged
   task.

And it is already pinned by name: `tests/v4-08-post-merge-reconciliation.test.ts`
asserts `expect(ALL_STATES).not.toContain('COMPLETE')`. A slice-10 `COMPLETE`
state would have failed an existing test rather than needed a new argument.
`CLAUDE.md` says the same thing as governance: giving `READY_FOR_PR` an outgoing
transition "is a product-contract change and needs its own decision".

## Why a record at all, and not a derivation

The honest objection, and it is slice 4's own: *"a stored verdict is a strictly
more dangerous artefact than a stored observation, because it already looks like
a conclusion"* — which is why `--decide` writes nothing.

The answer is not that this record is safer. It is that it is a different kind
of thing:

- slice 4's decision is a **recommendation to act**, about a moving world (a
  pull request's state, its checks). Persisting it lets a stale recommendation
  authorise an action;
- this is a **judgement about two immutable events**, and it authorises nothing.
  Nothing in `src/` reads it. It is the end of the lifecycle, not a permission
  slip for the next step.

What persisting buys, and a fresh two-file read cannot:

- **monotonicity.** A derived answer would flip from "concluded" to "cannot
  tell" the moment the verification history became unreadable — a record from a
  newer build, a full attempt list, a corrupted byte — or the moment the profile
  was edited. The conclusion is a statement about an instant that has passed; it
  stays true whatever happens to its sources afterwards. `ALREADY_CONCLUDED` is
  therefore decided **before every other document is read**, and five fixtures
  pin it: the receipt deleted, the receipt rewritten by a newer build, the
  receipt corrupted, the history deleted, the history corrupted — each with a
  control asserting the same repository answered `ALREADY_CONCLUDED` before its
  source was broken, and each still answering it afterwards;
- **provenance.** The record names the exact documents it was drawn from, by
  their own binding digests, and the profile it was judged under.

### The ordering was wrong first, and a review measured it

The first version asked the merge receipt **before** it looked for a conclusion,
because the conclusion's identity was compared against the receipt. A review
drove it: delete the receipt, or let a newer build rewrite it, and a task whose
conclusion sat readable on disk answered `RECEIPT_ABSENT` — "No merge receipt
has been recorded for this task" — never mentioning the conclusion at all. The
monotonicity this record is sold on held against two of its three sources and
not the third, while this document claimed all three.

The fix is to ask the conclusion first, which is possible because the record
carries its own identity: the implementation head **H** and the delivery target.
Those are exactly what the receipt gate compares, so one predicate —
`aboutThisDelivery` — answers both questions and there is no second spelling to
drift.

The price is stated rather than hidden. The ladder can no longer compare
`baseRef` or the pull-request number when it reports `ALREADY_CONCLUDED`,
because only the receipt carries those. A hand-written conclusion naming a
different **merge commit** for the same head therefore reads as
`ALREADY_CONCLUDED` rather than as a conflict — and the report prints the
*stored* merge commit, so the discrepancy is in front of the operator even
though this build does not call it one. That is `L-V4-10-11`, and a test drives
it. Slice 8's receipt is written-once and never superseded, so the shape does
not arise through the product.

## The standing verdict, and why `hasPassFor` is not reused

`post-merge-verification-store.ts:260-264` is `.some()` — *any* pass, at any
position, under the digest. That is right for the question it asks: "is a re-run
pointless?"

Completion asks a bigger question — "is the standing verdict a pass?" — and
`standingVerdictFor` answers it:

- only attempts under **this** profile are considered;
- `VERIFICATION_NOT_ESTABLISHED` attempts are **skipped, not counted**. Nothing
  was learned about the code, and a machine that could not answer is not the
  machine saying no. Counting one would let a busy workstation un-conclude a
  delivery;
- of what remains, the **last** stands. `attempts` is append-only and ordered
  oldest first, so array position is the order — no instant is compared, which
  matters because the clock can step backwards (slice 8 records the same about
  its own pair of instants).

The two predicates differ on exactly one shape: **a pass followed by a fail for
the same profile.** `hasPassFor` says yes; this says no. That shape is
**unreachable through this build's product path** — a pass converges
`--verify-merge` before it runs anything — and it becomes reachable the moment a
forced re-verification exists. Using the looser predicate would have baked in
the assumption that one never will. The test file constructs the history
directly and pins both answers, in both directions.

## The freshness gate, and what it is worth

The assessment reads three documents and only then writes. The last thing before
the write is a re-read of all three, compared against what the **proof** says was
assessed:

- the merge receipt's binding digest, and the verification history's, are
  re-read by the store **itself** — a store that took the caller's word for
  whether its own evidence had moved would be comparing a value with itself;
- the task-state revision comes from a **function** the caller supplies, because
  `tests/v4-03-…` pins that no module under `src/deliver/` takes a value import
  from `state/state-store.js`. A function rather than a second field, so a
  caller cannot satisfy it by handing the same number in twice.

Reached without any injection: `checkIgnored` is awaited a few lines earlier, so
a probe that moves a document exercises the real readers at the real moment.

What it is worth is stated rather than implied. It closes the window between the
assessment and the write — three file reads and a digest. It does **not** close
the window between the compare and the `rename`, which cannot be closed without
a lock, and a lock is a service. This is a *narrowing*, not mutual exclusion.

Note the honest case it catches: the verification history is append-only, so a
concurrent `--verify-merge` moves it **without anybody tampering**.
`EVIDENCE_MOVED` says exactly that and claims nothing about intent.

## The exit code, and the one narrow departure

`delivery`'s exit code answers one question — was the observation settled — and
`--record`, `--reconcile-merge` and `--verify-merge` all report their store code
in the report and leave `$?` alone. Every **refusal** of the conclusion ladder
keeps that convention: a refusal is an *answer*, and the report carries it.

One shape departs: the ladder reached `DELIVERY_CONCLUDED` and the conclusion is
not on disk afterwards. This is the one flag whose whole purpose is to answer
*"is this delivery concluded?"*, and a run that decided yes and wrote nothing has
told a caller yes about something that did not happen.

**Which** code it becomes is decided one store code at a time, in
`run-exit-codes.ts`, and that was a correction. The first version collapsed all
twelve non-durable codes onto `EXIT_RUN_NEEDS_OPERATOR`, and a review measured
two it mis-classified against this repository's own definitions: an honest
concurrent `--verify-merge` moving the history is `EVIDENCE_MOVED`, where the
next invocation may well succeed — the definition of code 4, and the code
`RUNTIME_IGNORE_UNDETERMINED` is already graded for the identical condition —
while a path Git says is not ignored is a repository defect fixed by editing it,
which `RUNTIME_NOT_IGNORED` is graded 2 for twelve lines away. "Does not exit
nominal" does not require "needs an operator".

| store code | exit | why |
| --- | --- | --- |
| `CONCLUSION_RECORDED`, `ALREADY_CONCLUDED` | *keep the primary* | the claim is on disk |
| `EVIDENCE_MOVED`, `RUNTIME_IGNORE_UNDETERMINED` | 4 | nothing is wrong; try again |
| `RUNTIME_PATH_NOT_IGNORED`, `LOCATION_UNSUITABLE`, `RECORD_TOO_LARGE` | 2 | a repository defect, fixed by editing it |
| `CONFLICTING_CONCLUSION`, `EXISTING_CONCLUSION_UNREADABLE`, `RECORD_CONTRACT_VIOLATION`, `DIRECTORY_CREATE_FAILED`, `WRITE_FAILED` | 3 | durable state an operator must look at |
| `CONCLUSION_NOT_PROVEN`, `SUBJECT_MISMATCH` | 1 | floors; the command cannot reach them |

The table is total by type over `DeliveryConclusionRecordCode`, so a new store
code fails the build until somebody grades it, and the grades are pinned by a
hand-written table in the test file that is deliberately not derived from it.

It is graded on **durability**, not on `recorded`: `ALREADY_CONCLUDED` filed
nothing and the claim is on disk all the same.

One correction to what this section said before: "a refusal exits nominal" is
**false**, and a review measured it. The exit code answers whether the
*observation* settled, and a subject that could not be established is already a
2 — with or without this flag. The true sentence is the narrower one: no ladder
refusal *changes* the exit code.

## What was reused, and what had to be built

Reused unchanged: the merge receipt and its loader; the verification history and
its loader; `verificationProfileDigest`; `writeFileAtomically`; the runtime-ignore
probe; the opaque-artefact pattern; the ladder / `*_DETAIL` / store-code /
`WRITE_ATTEMPTS` / over-reading-sentence conventions; the record-location
discipline (own directory, `state-location.ts`'s own file-name grammar).

Built: `conclude-delivery.ts` (the ladder), `delivery-conclusion.ts` (the record
contract), `delivery-conclusion-store.ts` (location, load, write, freshness
gate), `delivery-conclusion-proof.ts` + `internal/delivery-conclusion-proof.ts`
(the mint and the join), one flag, one report block, one trailer.

Deliberately **not** built: a second verification engine; a second delivery state
machine; a `git fetch`; any Git-graph question; any forge call; a force /
re-verify flag; a policy for what to do about a failing merge.

## Alternatives considered and rejected

- **Extend `TaskState` with `COMPLETE`.** Rejected on the three measured grounds
  above, and it fails an existing test by name.
- **Require base membership.** Rejected on the four measurements above.
- **Derive on demand, persist nothing.** Rejected: a delivery would un-conclude
  when its evidence became unreadable or its profile changed. It is the smaller
  design and it is the wrong one for a monotonic fact.
- **Make `--verify-merge` conclude as a side effect.** Rejected. Verification and
  completion are different claims with different inputs, and folding them would
  mean a run that verified could not decline to conclude.
- **Reuse `hasPassFor`.** Rejected: it answers a different question, and the
  difference is exactly the pass-then-fail case.

## Live dogfood: why there was none

Unchanged from L-V4-09-7 and for the same reason. The subject must come from a
legitimate merge receipt, and none exists in this repository: every pull request
here has been merged by a human under the repository's own policy, from no AO
task. Fabricating a `TaskState`, a receipt and a verification history to enable a
demonstration would manufacture exactly the evidence this slice exists to
require.

What is measured instead: real repositories, real Git, real task-state files
saved through the production writer, and a really settled block-ledger entry
re-proved before and after — with negative controls beside each.

## The counter-proof, and why one mutant survives

66 mutants against a baseline the lab proves green before applying anything — a
red baseline reports every mutant killed and measures nothing, and this campaign
hit exactly that on its first run (an unsupported reporter flag) and refused to
continue. **65 killed, 1 survived, 0 harness failures, 0 `NOT_APPLIED`, and 0
`KILLED_ELSEWHERE`**: no mutant here is caught only by an unrelated gate.

The `NOT_APPLIED` column earned its place mid-slice. After the review fixes
moved seven guards, seven mutants stopped matching their target text and the
harness reported them as *not applied* rather than as killed — which is exactly
what a campaign that scored them as kills would have hidden. They were repointed
at the new code and all seven die.

The lab works on a copy of the tree with no `.git` and a junction to
`node_modules`. It proves each edit landed by reading the file back, and re-runs
every survivor against a wider control set.

Mutants that found **genuine coverage gaps** rather than confirming the design.
All are now killed by tests written because of them:

- **`M35`** removed the binding comparison in `readDeliveryConclusion` and
  survived. Every existing case reached that reading through a *recomputed*
  binding, so the comparison against the stored one was never the line that
  fired. The missing case is the naive tamper — flip a field, leave the digest —
  and it is the one an operator is most likely to attempt;
- **`M40`** removed the read-back-before-write and survived. The obvious
  classification was "unreachable: the document is assembled from values that
  have just been validated", which is what the sibling slice says about its own.
  It is **false here**. The merge receipt's schema requires
  `mergedHeadSha === subjectCommit` and says nothing about `mergeCommit`, so a
  hand-written receipt whose merge commit *is* its own head validates, passes the
  ladder and mints a proof — and the conclusion's own `superRefine` is what
  refuses it. The test drives exactly that, with a positive control asserting the
  ladder really did get all the way through first.

Three more came out of the review round rather than the first campaign:

- **`M54`** removes the byte budget on the **read** side. The first campaign had
  no mutant for it, and it is not the same as the write side: `repositoryRoot` is
  a plain `.min(1).max(4096)` string, so 4,096 characters that JSON escapes to
  six bytes each is schema-legal and far over 16,384. Without the guard such a
  file reads as a conclusion. It dies;
- **`M55`/`M56`** remove the target's own re-read before the write — the gate the
  review's second finding added. Both die;
- **`M60`** deletes the report line that names the profile the *stored*
  conclusion was drawn under, and it **survived** the first re-run: the result
  field was asserted and the rendered line was not, which is not what an operator
  reads. It dies now.

The one survivor is classified rather than counted:

| survivor | why it is not reachable | companion that dies |
| --- | --- | --- |
| `M41` — the byte budget **on write** | the write path builds the payload from a `repositoryRoot` that must be an absolute path this process can create a directory under, and the ladder reads the merge receipt first; measured over every combination of the shortest, production and longest ISO-8601 instants both records admit, this record is **189 to 230** bytes larger than the receipt and can reach **8,420** against a 16,384 budget — 7,964 of headroom | `M41b` lowers the budget to 400 and **dies** |

`M41b` is the point of that row. The gate is live — it refuses the moment
anything reaches it — and what makes `M41` unobservable is the *threshold*, not
a dead branch. The 189-to-230 range and the 8,420 worst case are recomputed by
the test file over three encodings and three instant lengths rather than
asserted.

An earlier version of this row said the delta was "exactly 200 bytes". A review
measured that it is not: both records carry two ISO-8601 instants, the regex
admits 20 to 35 characters, and the two documents' instants are independent —
the 200 came from a table in which all four happened to be the same length. The
operational conclusion survived; the stated measurement did not.

The **read** side of the same budget is a different matter, and the first
campaign did not have a mutant for it. It is reachable: `repositoryRoot` is a
plain `.min(1).max(4096)` string, so 4,096 characters that JSON escapes to six
bytes each is schema-legal and far over 16,384. Without the guard such a file
reads as a conclusion. `M54` removes it and dies.

## Residuals

- **L-V4-10-1 — the conclusion is not authority, and nothing reads it.** No code
  in `src/` consumes the record. It is an audit trail and the end of the
  lifecycle, not a permission for a later step.
- **L-V4-10-2 — the record is not evidence of authorship.** The binding is a
  keyless SHA-256 over public values and the function is exported. Anyone who
  can write into the runtime directory can write a conclusion that reads back
  clean — the same accepted limit as `L-V4-08-2` and the verification record's,
  inherited rather than new. The opaque mint is an in-process product-code
  provenance boundary only.
- **L-V4-10-3 — a conclusion drawn from a forged pass is a conclusion drawn from
  a forged pass.** This slice adds no way to tell one from the other, because
  there is none to add without a signed record.
- **L-V4-10-4 — base membership is never established.** Deliberate, measured, and
  the whole of "Why base membership is not asked". A reader who needs "the change
  is still on the branch" must ask Git themselves; AO will not answer it and does
  not pretend to.
- **L-V4-10-5 — read-before-write is not a transaction.** Two invocations racing
  on one task can both read `ABSENT` and both write; the second rename wins. Both
  would have written the same judgement about the same delivery, so the loser's
  bytes and the winner's differ only in `concludedAt`. The freshness gate narrows
  the window and does not close it. Same shape as `L-V4-08-1` and `L-V4-09-1`.
- **L-V4-10-6 — `CONCLUSION_CONFLICT` and `CONCLUSION_UNREADABLE` are terminal.**
  There is no repair path and no way to supersede a conclusion. Clearing one is
  deleting a file by hand, which is exactly the out-of-band editing the binding
  exists to detect.
- **L-V4-10-7 — the record's byte budget is a floor the product path cannot
  reach.** Measured: for any `repositoryRoot` this record is exactly 200 bytes
  larger than slice 8's receipt for the same root, and the ladder reads the
  receipt first — so a receipt small enough to be read leaves this record at most
  8,392 bytes against a 16,384 budget. `RECORD_TOO_LARGE` exists for a
  hand-written document.
- **L-V4-10-8 — the profile digest identifies the contract, not the toolchain.**
  Inherited unchanged from `L-V4-09-4`, and it bounds what "under profile P"
  means here too.
- **L-V4-10-9 — `--conclude-delivery` reports its verdict in the exit code in
  one direction only.** No ladder refusal *changes* the exit code, exactly as on
  every other flag here — which is not the same as "a refusal exits nominal", a
  sentence an earlier draft carried and a review measured false: the exit code
  answers whether the observation settled, so a subject that could not be
  established is a 2 regardless. The only override this slice adds is a
  conclusion that could not be made durable.
- **L-V4-10-11 — `ALREADY_CONCLUDED` cannot compare the merge commit.** The
  ladder reads the conclusion before the receipt, deliberately, so it compares
  the implementation head and the target — which it has from the task — and not
  `baseRef` or the pull-request number, which only the receipt carries. A
  hand-written conclusion naming a different merge for the same head therefore
  reads as already concluded. The report prints the *stored* merge commit, so
  the discrepancy is visible; this build does not flag it. Slice 8's receipt is
  written-once and never superseded, so the shape does not arise through the
  product.
- **L-V4-10-12 — the write-side byte budget is unreachable, and stays.** The
  read side is reachable and is driven; the write side builds its payload from a
  `repositoryRoot` that must be a directory this process can create, so no
  callable path can cross it. It is kept as a floor, with a companion mutant that
  lowers the threshold and dies to show the gate is live.
- **L-V4-10-13 — the `!stat.isFile()` guard is not observable.** Measured on
  Windows, opening a directory succeeds and reports size 0, so without the guard
  the empty read decodes to `MALFORMED` anyway. It is kept as a statement of
  intent about a platform answer this repository has been surprised by, and it is
  named here rather than defended as load-bearing.
