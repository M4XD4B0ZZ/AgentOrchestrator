# ADR — the delivery lifecycle driver, above the primitives rather than beside them

**Date** 2026-08-26
**Status** accepted
**Slice** V4 slice 11
**Supersedes** nothing. **Superseded by** nothing.

## The decision

AO gains one new capability: **work out where a task's delivery currently
stands, and run the acts that stand between it and a conclusion.**

One new flag, `delivery --drive`. One new production module,
`src/cli/delivery-driver.ts`. No new durable record, no new authority, no new
act, and no second implementation of anything slices 1 to 10 already do.

The driver adds no capability to this build. Everything it can do, an operator
could already do by naming an act's own flag. What it removes is the
requirement that the operator know **which** act comes next, and in what order.

`TaskState` is not extended. `READY_FOR_PR` stays terminal, the transition
table is unchanged, `currentCommit` stays the implementation head **H**, and the
block ledger is not written.

## The three sentences the contract rests on

> **Position is derived on every invocation, and stored nowhere.**

> **At most one forge mutation is attempted per invocation.**

> **Every act still requires its own flag and `--attended`, separately.**

Everything below is those three, argued.

## 1. Driver state: derived, not durable

`concludeDeliveryForTask` (`src/deliver/conclude-delivery.ts:443`) is the
position oracle. It can be, because of three properties it already had:

- its whole seam list is **a clock** — no forge seam, no Git seam, no
  verification seam — so asking it contacts nothing, starts no process and takes
  no lease. Not free: it reads up to three documents from disk. An earlier
  draft of this line said "pure" and "reaches nothing", which a review measured
  as overstating exactly that;
- it **writes nothing**. The caller records, and only on the one member that
  says there is something to record;
- its refusals **name the missing stage**. `RECEIPT_ABSENT` means no merge has
  been reconciled. `VERIFICATION_ABSENT` and `PROFILE_NOT_VERIFIED` mean M has
  no standing verdict under this profile. `VERIFICATION_NOT_PASSING` means the
  repository answered and said no. Each is exactly one existing act away.

So the driver asks it first, on every invocation, and branches on the answer.

A durable `DeliveryState` was considered and rejected. It could hold only two
kinds of thing, and both are wrong:

1. **facts already on disk** — the receipt, the verification history, the
   conclusion. A second copy is a second answer, and the store that holds the
   first already refuses to choose between two;
2. **where the last invocation got to** — which is the one thing that must never
   be trusted. Every module on this surface says the same sentence about its own
   uncertain outcome: *a retry must begin with a reading, never with a second
   request.* A note saying "I was mid-push" is precisely the input that would
   let a driver push again.

## 2. Terminal condition: the conclusion is consumed, and authorises nothing

`ALREADY_CONCLUDED` ends the driver, with `DELIVERY_CONCLUDED`.

That answer costs **no forge request, no execution lease and no verification**,
and it is a consequence of Slice 10's own ordering rather than a check added
here: the conclusion is read ahead of the receipt and ahead of every
verification question, which was itself a correction after a review. A delivery
that was concluded therefore stays concluded when the receipt is deleted, when
the history is rewritten, or when the profile changes — and the driver inherits
that without asking for it.

What the conclusion is **not** is permission. It ends this driver; it authorises
nothing, and nothing downstream reads it as a licence. `L-V4-10-1` said "the
conclusion is not authority, and nothing reads it". Half of that is now false —
the record has a reader — and the residual is rewritten rather than carried
forward unchanged. The half that matters is unchanged and is now measured: the
reader treats it as a full stop.

## 3. Attended authority: the same three, unchanged and non-substitutable

`--drive` reuses the existing act flags. There is no drive-shaped authority.

| invocation | may mutate github.com |
| --- | --- |
| `delivery --drive` | nothing |
| `delivery --drive --attended` | **nothing** |
| `delivery --drive --publish-head --attended` | the branch push |
| `delivery --drive --create-pr --attended` | the pull request |
| `delivery --drive --merge-pr --attended` | the merge |

`--drive --attended` on its own authorises no mutation at all, and that is
deliberate: `--attended` has never been the authority, only the operator's
presence. The act is named by its own flag.

The three grants stay where they were. The driver **mints nothing** — measured
by a source scan, and by the pre-existing tree walks that pin each mint to
exactly one module. It calls the act ladders, each of which mints its own grant
from facts read at its own point and spends it by claiming it. No grant is ever
held by this module, so none can be reused, and none can substitute for another.

### Why the mints had to move

They could not stay in `delivery-command.ts`, because the driver needed a second
caller for the ladders and copying a ladder means copying its mint. So the six
act ladders moved, unchanged, into `src/cli/delivery-steps.ts`, and both the
command and the driver call them. That module is now the sole minter and the
sole lease acquirer on the delivery surface; the two tree-walk pins follow the
code and their guarantees are word-for-word what they were.

`src/deliver/` was the obvious home and is the wrong one: a pre-existing pin
requires that **nothing under `src/deliver/` acquires an execution lease**, and
`performVerification` does. The pin is stronger than the layering preference, so
the steps live one level up with it.

## 4. External wait: why it returns instead of polling

Slice 11 is not a scheduler and does not become one.

There is no sleep, no loop, no timer and no background work in the driver —
measured by a source scan that also carries its own positive control. A
condition that is not ready is a **result**, not a wait:

- `CHECKS_PENDING` — a check is still running;
- `PULL_REQUEST_REQUIRED` — no open pull request has this head;
- `ATTENDED_AUTHORITY_REQUIRED` — the next act needs an authority this
  invocation was not given;
- `EFFECT_ATTEMPTED` — an act ran, and the next invocation reads what happened.

Two of those grade `EXIT_RUN_CALL_AGAIN`, and both times the words are literal.
**Nothing in this build calls again by itself.** A caller may loop on 5; that
caller is a scheduler and this build is not it.

The alternative — waiting for CI inside the invocation — was rejected on the
same grounds V3-06 rejected the quota wait: a wait needs an authority the
product has not granted, and a process that sleeps holds whatever it is holding
while it sleeps.

## 5. One mutation per invocation, and the theorem that rests on it

**The driver stops at the first act that reports an attempt.**

Not at the first act it *calls*: a publication answering `ALREADY_PUBLISHED`
sent nothing and is a reading, so the driver may go on to the creation. But the
moment a ladder's `attempt` is anything other than `NOT_ATTEMPTED`, the
invocation is over.

Three properties follow, and they are the whole safety argument:

1. **at most one irreversible forge effect per invocation** — never three behind
   one `--attended`, though the flag surface has permitted that since slice 7
   and still does;
2. **no observation proof is consumed after a mutation.** The merge is the only
   act that reads the proof, and it is reachable only in an invocation where
   nothing was pushed and nothing was created. So the proof authorising a merge
   grant is exactly as fresh as it is under `--merge-pr` alone;
3. **no grant outlives its act**, and no invocation mints two grants of one kind.

Property 2 is the one that mattered. Without the rule, the driver would have
been the first caller in this build to decide a merge from an observation taken
before its own pull request existed — and the check state is measured never to
be re-read at the merge, so a stale `PULL_REQUEST_MATCHED_CHECKS_SUCCESS` would
have carried it.

### What this costs, stated

`L-V4-06-10` and `L-V4-07-1` are **not closed**. Publish-then-create and
create-then-merge still do not compose in one invocation, and the driver does
not try to make them. What changes is that an operator no longer has to know
which of the ten acts comes next: the driver names it, with the flag that would
authorise it.

The alternative — re-observe between acts and compose the whole way in — was
considered and rejected. It is buildable, and it would trade a bounded
invocation for one that mints three grants, mutates three times, and has to
justify each re-observation against a world it changed itself. That is a larger
authority than "run the next act", and it is not what this slice is for.

## 6. Unknown mutation outcome: no blind retry, and no note to carry one

Every uncertain member of every act's vocabulary is a full stop:
`OUTCOME_UNCERTAIN` (publish, create), `REMOTE_STATE_UNKNOWN`,
`PULL_REQUEST_STATE_UNKNOWN`, `POSTCONDITION_MISMATCH`, `OUTCOME_AMBIGUOUS`,
`OBSERVATION_UNAVAILABLE`, `EFFECT_NOT_ESTABLISHED`.

The driver reports each and returns. It never re-issues the request, because it
cannot: the stop-on-attempt rule means the invocation is already over by the
time the outcome is known. Asking again is a **later invocation**, which begins
with a reading — which is what every one of those modules asks for by name.

## 7. Verification: the driver may run it, under the primitive's own lease

The driver invokes `--verify-merge`'s ladder, once per invocation, and does not
take a lease itself. `performVerification` acquires the repository execution
lease, releases it in a `finally`, and reports both the outcome and the release;
the driver carries that through and the command applies the lease rule last.

**One attempt per invocation**, deliberately. A second would be this build's
first retry of a gate; a fail is terminal for the commit/profile pair anyway
(`L-V4-09-2`), so a loop could only re-pay a ten-minute gate to be told the same
thing.

## 8. Failure classification

Four kinds, kept apart:

| kind | members | exit |
| --- | --- | --- |
| **code** | `VERIFICATION_FAILED` | 3 |
| **infrastructure** | `VERIFICATION_NOT_ESTABLISHED` | 3 |
| **external not ready** | `CHECKS_PENDING`, `EFFECT_ATTEMPTED` | 5 |
| | `PULL_REQUEST_REQUIRED`, `FORGE_STATE_UNKNOWN`, `OBSERVATION_UNSETTLED`, `SUBJECT_CHANGED` | 4 |
| **authority** | `ATTENDED_AUTHORITY_REQUIRED` | 4 |
| **a person** | `HUMAN_DECISION_REQUIRED`, `CHECKS_FAILED`, `CHECKS_ABSENT`, `PULL_REQUEST_AMBIGUOUS`, `DELIVERY_EVIDENCE_UNUSABLE`, `CONCLUSION_NOT_ATTESTED` | 3 |
| **a record that did not land** | `CONCLUSION_NOT_DURABLE`, `RECEIPT_NOT_DURABLE` | the store's own grade |

This table is a **slice-11 snapshot** and is not maintained as the vocabulary
grows: it already omitted `PUBLICATION_AUDIT_NOT_DURABLE` and
`PUBLICATION_OUTCOME_NOT_DURABLE` (V4 slices 14 and 16), and V4 slice 18R adds
`FORGE_READINGS_DISAGREE` — two readings that answered and disagreed, graded 4
with the other "achieved nothing and nothing durable is wrong" members. The
source of truth is `DRIVE_EXIT_CODES` in `src/cli/run-exit-codes.ts`, which is
total over the vocabulary by type and pinned by a hand-written table in the
slice's test file. Recorded here rather than silently extended, because a
snapshot that is quietly kept current stops being a record of what was decided
when.

`VERIFICATION_NOT_ESTABLISHED` is graded 3 rather than 4, and the trade-off is
stated rather than absorbed: two of its causes clear on their own — a lease
another run holds, a workspace that could not be made — and 4 would be right for
those. The third does not, because `MERGE_COMMIT_UNAVAILABLE` is terminal
(`L-V4-09-3`). One code cannot say both, and telling an operator "try again"
about a condition that never clears is the worse of the two errors.

The lease rule is applied **last**, over the driver's grade, because
`run-exit-codes.ts` states it as a rule about authority: no primary code is
exempt.

### What `$?` still does not mean

Five residuals record, from five angles, that `delivery`'s exit code answers the
observation question and never an act's verdict. That is unchanged for every
flag but this one. Under `--drive` the code grades the **driver's** member, and
no member of that vocabulary says "the merge is warranted":
`ATTENDED_AUTHORITY_REQUIRED` says an act has not been authorised, not that it
should be, and the nominal member is about a delivery that is already finished.

## 9. Network

| driver path | requests |
| --- | --- |
| a conclusion already on disk | **none** |
| a record that cannot be read | **none** |
| a standing verdict, pass or fail | **none** |
| no receipt | the reconciliation's two questions, then the observation's two |
| no receipt, and the locator will not resolve the delivery commit | the reconciliation's **first** question only, then the publication's own local readings. V4 slice 18R: the observation is not asked, because neither of its questions can be answered about a commit the forge will not resolve |
| an act that mutates | that act's own readings, one request, one reading |

No path here runs `git fetch`, and the driver adds none — `L-V4-09-3` is the
standing statement, and it is measured over the whole of `src/` by
`tests/v4-09-post-merge-verification.test.ts`. (Not a claim that nothing in this
build opens a socket: `notify/ntfy-transport.ts` does, on a path no delivery
flag reaches.)

## 10. Non-goals

Not built, and each deliberately: a scheduler or daemon; cross-project
orchestration; automatic task selection; automatic remediation; review
ingestion; generic retry infrastructure; risk-based auto-merge; unattended
GitHub mutation; a second delivery state machine; a second verification engine.

## What was reused, and what had to be built

**Reused, unchanged:** every act ladder, every grant, every proof, every store,
the decision, the observation, the renderer, the lease, and the exit-code
discipline.

**Moved, unchanged:** the six act ladders and the observation sequence, from
`delivery-command.ts` into `delivery-steps.ts`. The observation sequence had
been inline in the commander action; it now has one spelling and two callers.

**Built:** `delivery-driver.ts` — a vocabulary, a classification of the
conclusion ladder's members, and the ordering. Plus `receiptIsOnDisk`, a total
table beside the receipt store's codes, matching the one the conclusion store
already had.

**Not built:** a durable record, an authority, an act, a wait, a retry.

## Live dogfood: why there was none

This repository has no AO task at `READY_FOR_PR` carrying a delivery target, a
merge receipt and a verification history. Fabricating one to demonstrate the
driver would fabricate the evidence the driver exists to read, so no live
end-to-end dogfood was performed and none is claimed. The suite drives real Git
repositories and real durable records through the real CLI, with the forge and
the three mutation vectors behind counted seams.

## Residuals

See "Carried forward from V4 slice 11, deliberately" in `README.md`.

## What Review 1 changed

Three lenses read the exact head this ADR was written against. What they moved,
and it is recorded here because each was a claim this document made:

- **the fall-throughs were not classifications.** The creation and the merge
  each ended in one word covering their whole remaining vocabulary, and two
  members were measurably mis-stated by it: `PULL_REQUEST_AMBIGUOUS` — *more*
  than one open pull request at this head — was reported as "no open pull
  request has this head", and a forge that could not be read was reported as "a
  person put it there". Both are now read member by member;
- **`MERGE_NOT_ESTABLISHED` covered two unrelated conditions** — a forge that
  would not answer and a receipt that would not reach the disk — and graded both
  "nothing durable is wrong". It is now `FORGE_STATE_UNKNOWN` and
  `RECEIPT_NOT_DURABLE`, and the second is graded by the receipt store's own
  codes, exactly as the conclusion's counterpart is;
- **the reported position was stale on the recovery path.** A run that had just
  filed a receipt printed `Position: RECEIPT_ABSENT`, three lines under a
  `Completion` line saying otherwise;
- **`ATTENDED_AUTHORITY_REQUIRED` was graded 3** where this repository grades
  every sibling authority refusal 4, putting "you did not pass `--merge-pr`"
  under the same shell answer as "the checks failed";
- **the classification of the conclusion ladder was a set with a fall-through**,
  claiming a completeness nothing enforced. It is a total map now, so a
  sixteenth member of that vocabulary fails the build;
- **and four assertions in the serial gate were red**, because they name the
  file the act ladders used to live in. The extraction had been run against the
  parallel gate only.
