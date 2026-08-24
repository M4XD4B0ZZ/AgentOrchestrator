# ADR — the explicit merge effect, under attended authority

**Date** 2026-08-24
**Status** accepted
**Slice** V4 slice 7
**Supersedes** nothing. **Superseded by** nothing.

## The decision

AO gains one new mutation class: **merge exactly one pull request**, by squash,
into the base branch the task names, when an operator explicitly asks this
invocation for it.

It does **not** gain a finding that a pull request *may* be merged. The truthful
name of the slice is *explicit merge effect under attended authority*, and every
sentence in it is written to keep the difference visible.

## What authorises a merge, exactly

Five things, and all five must hold in the same invocation:

1. the task is at `READY_FOR_PR` and its pinned commit resolves;
2. the delivery target re-resolves to the same `host/owner/name`;
3. `--observe` and `--decide` were both given and **this invocation's own**
   decision is `PULL_REQUEST_MATCHED_CHECKS_SUCCESS` — exactly one open pull
   request whose head is this exact commit, and no check on this commit failed
   or is still running;
4. `--merge-pr` was given;
5. `--attended` was given.

The pull-request number is taken from that invocation's own observation proof
and from nowhere else. There is no flag that names a pull request, no field in
the task state that holds one, and slice 3's durable store has no path into the
mint. **An operator cannot name a pull request to merge; they can only authorise
the one this invocation just looked at.**

## What this build does not claim

`MERGE_ELIGIBILITY_SENTENCE` is unchanged and is the sentence this slice rests
on. AO does not observe reviews, branch protection or repository rules, and
measured, their surfaces cannot be told apart from "you may not read them".
Slice 4's decision is not turned into a stronger claim by being consumed here.

So: **the operator is the policy decision, and GitHub is the policy enforcer.**
What AO adds is that the commit an operator authorises is the one this
invocation just observed, and that the request cannot land on a different one.

## The measurements this slice is built on

Taken against github.com on 2026-08-24, on a disposable pull request whose base
was a scratch branch. `main` was never a base of any probe and never moved.

| Condition | Result |
|---|---|
| open PR, stale `sha` | **409** `Head branch was modified. Review and try the merge again.` Nothing merged. |
| open PR, 40-hex `sha` that exists nowhere | the same 409 — stale and unknown are not distinguished |
| `sha` abbreviated or not hex | **422** `The sha parameter must be exactly 40 characters and contain only [0-9a-f].` |
| `merge_method` outside the three | **422** naming `["merge","squash","rebase"]` |
| draft PR, either `sha` | **405** `Pull Request is still a draft` — the draft check fires before the sha check |
| **closed, unmerged PR** | **200 `merged=true`. GitHub merged it.** |
| **already-merged PR, stale `sha`** | **200**, replaying the ORIGINAL merge commit — `sha` ignored |
| **already-merged PR, different method** | **200**, same original commit — `merge_method` ignored |
| nonexistent PR number | 404, `gh` exit 1 |

Three of these decided the design.

### 1. The fence is real, and it is what makes the slice safe

`sha` is documented as "SHA that pull request head must match to allow merge",
and 409 is documented as "Conflict if sha was provided and pull request head did
not match". Measured, it refuses and merges nothing. That is a compare-and-swap
the *server* evaluates — the same property `--force-with-lease` gives slice 5 and
the one slice 6 had no equivalent of. Without it this slice would have been
stopped: a pre-request observation alone is a check-then-act race, and this
build does not simulate atomicity locally.

**The fence is opt-in and its absence is silent.** Omitting `sha` does not weaken
it, it removes it — the sibling asynchronous endpoint documents the consequence
in words: "If not provided, the current head of the PR at the time of the request
will be used." So the field is bound in the authority, written by the transport
from that binding, and a counter-proof that removes it must fail.

### 2. GitHub does not refuse a closed pull request

This was measured because it was predicted wrong. A closed, unmerged pull request
is merged by this endpoint. "The pull request is open" is therefore **not** a
server-side precondition, and a build that assumed it was would silently re-open,
by merging, a delivery a human had closed. `PULL_REQUEST_NOT_OPEN` is this
build's own refusal, taken from the reading before, and costs no request.

### 3. A `200` is not a proof of anything this process did

An already-merged pull request answers `200 {"merged":true}` and replays the
original merge commit, with both `sha` and `merge_method` ignored. So on the wire:

- `merged: true` means "this pull request is merged" — never "this request merged
  it", never "the head you named is what merged", never "your method was used".

This is why the response body is never parsed, why the resulting commit is copied
out of the *reading afterwards* and never out of the response, why `MERGED` and
`ALREADY_MERGED` are different members, and why the reading *before* is a
precondition rather than an optimisation — without it the two are
indistinguishable afterwards.

## Why the postcondition is read by number and not by head

Slice 2's locator is keyed on a commit: `commits/{sha}/pulls`. Measured, it does
still return a squash-merged pull request under its original head, and its list
representation carries `merged_at` and `merge_commit_sha`. That is nearly enough,
and it is the wrong instrument anyway:

- under a squash merge the head object name lands on **no** branch, so a merge
  can never be confirmed by looking for it on the base;
- a pull request merged at *another* head is not returned for this one at all —
  so a build reading the postcondition by head could not see a merge it may
  itself have caused, and would report `EFFECT_NOT_ESTABLISHED` for a pull
  request that had just been merged out from under it.

The mutation is addressed by number. The reading has to be too. `GET
/repos/{o}/{n}/pulls/{number}` is added — the same request vector, environment
and budgets as every other reading, one new path and one new parse — and it is
also the only representation that carries the `merged` **boolean**. `state` alone
cannot separate merged from closed; both read `closed`.

`merge_commit_sha` is read **only when `merged` is true**. Measured: while a pull
request is open that field holds an ephemeral two-parent *test* merge commit that
is on no branch — for pull request 60 it read `ecae16f…`, and `main` was behind
it. GitHub's own description says so. Reading it unconditionally would report a
commit that is on no branch as the result of a merge.

## The method is bound, not inherited

The REST schema declares **no default** for `merge_method`. A request that
omitted it would take whatever GitHub chooses — a repository policy decision made
by silence. This repository merges by squash, measured: every merge on `main`
from #56 to #59 is a single-parent commit whose parent is the previous pull
request's `merge_commit_sha`, and #59 turned 7 branch commits into 1.

`MERGE_METHODS` has one member for that reason, and the mint tests membership at
runtime rather than typing the field as the literal — a compile error is not
reachable from a caller that has already been cast past.

## Why a third authority and not a wider one

`MergeGrant` is a third opaque artefact, not a widening of either sibling. A
publication is additive and create-only; a pull request is a request; a merge
writes to the base branch and its undo is a revert commit. An operator who
authorised either smaller act must not thereby have authorised this one, and the
refusal is a **type error** rather than a runtime check: each class carries a
private field, so TypeScript compares them nominally, and each mint owns its own
registry so a value cast past the compiler is refused at runtime as well.

It binds eight fields: `taskId`, `host`, `owner`, `name`, `pullRequestNumber`,
`expectedHeadCommit`, `baseRef`, `mergeMethod`. It deliberately does **not** bind
a remote name, because — unlike both siblings — this act asks no local Git
question at all. `mergePullRequest` takes no `repositoryRoot`, starts no local
process and reads no local file. A precondition reading `ls-remote` here would be
a precondition about a question this act does not ask.

## What is fenced, and what is not

- **the head**: fenced, server-side, by `sha`. A push landing between the reading
  and the request cannot be merged by this request.
- **the base**: not fenced. The endpoint takes no expected base commit and the
  merge happens against whatever the base ref holds. This build binds the base
  *name* and compares it; it does not claim to have frozen the branch.
- **a concurrent merge**: not fenced. The `sha` check does not apply once the
  pull request is merged. A merge by somebody else, at another head, between the
  reading and the request is not refused — it is *detected* afterwards as
  `POSTCONDITION_MISMATCH`.
- **policy**: GitHub's. On a repository with no protection and no rules — which
  this one has, measured — nothing on the far side refuses.
- **another AO process**: not fenced, and an execution lease would not fence it
  either. The object being raced for is on the far side of the network, and two
  clones of one remote hold two different leases. Recorded as a residual.

## At most one request, and no blind retry

One invocation performs zero or one merge requests. There is no retry after a
timeout, a lost boundary, a network error, a malformed response or an unexpected
exit — and the reason is sharper here than in either sibling: a second request
against an already-merged pull request answers `200 merged=true`, so a blind
retry would not even be detectably wrong. It would return a success-shaped answer
to a question nobody asked.

After any attempted mutation the pull request is read again, whatever the
transport said. If it is merged at the authorised head and base,
`CONVERGED_AFTER_UNCERTAIN_EFFECT` says the state is established and this process
cannot claim to be what established it. If the reading cannot be completed,
`OBSERVATION_UNAVAILABLE` says so and nothing is retried. **A later retry begins
with a reading.**

## `READY_FOR_PR` stays terminal, and the mismatch is deliberate

No transition is added, no task-state byte is written, no execution lease is
taken, no agent is started. The delivery-surface code scan already forbids all
four and every slice-7 module is inside it.

So after a real merge this build reports:

    GitHub    : merged
    AO state  : READY_FOR_PR

That is a mismatch and it is left standing on purpose. Repairing it means a
durable post-merge state, a post-merge verification and a `COMPLETE` — three
decisions, none of which belongs in the slice that adds the effect. **It is the
next slice's subject.**

## Residuals

- **L-V4-07-1** — `--create-pr` and `--merge-pr` do not compose on a first
  delivery. The observation runs before the creation, so the decision this ladder
  requires cannot be true in the invocation that creates the pull request. The
  refusal is `DECISION_NOT_SUCCESS` and costs no request. Two invocations.
- **L-V4-07-2** — pull requests opened before this slice carry a provenance
  sentence saying AO will not merge them. The constant is corrected for future
  pull requests; this build does not edit an existing one, so the old bodies keep
  the old sentence.
- **L-V4-07-3** — the base branch is not fenced. See above.
- **L-V4-07-4** — two AO processes, or two clones, racing to merge one pull
  request are not fenced. The loser observes the merge and reports
  `ALREADY_MERGED` or `POSTCONDITION_MISMATCH`; neither is an error.
- **L-V4-07-5** — a merge and its resulting commit are reported and then
  forgotten. Nothing durable records that this delivery landed, which is why
  re-invoking answers `ALREADY_MERGED` from a fresh reading rather than from
  memory. Deliberate; the next slice's subject.
- **L-V4-07-6** — the `409` refusal does not distinguish a head that moved from a
  head that never existed. This build refuses both cases from its own reading
  before it sends, so the ambiguity is not reachable on the ordinary path.

## Which M1 invariants this discharges, and how far

`docs/decisions/2026-08-23-adr-autonomous-delivery-m1.md` lists eleven invariants
that bind every delivery slice. Its `[held]`/`[open]` markers describe **slice
1** and no later slice has rewritten them, so the state after this slice is
recorded here instead.

- **#2 "a pull request exists" is not "a pull request is mergeable"** — held, and
  this slice is where it would have been easiest to break. `--merge-pr` merges
  because an operator said so, not because a pull request exists; the vocabulary
  carries no member naming eligibility, and a case asserts that.
- **#3 "mergeable" is not "CI passed"** and **#4 "CI passed" is not "review
  requirements passed"** — held, unchanged. This build observes neither
  mergeability nor reviews, and `MERGE_ELIGIBILITY_SENTENCE` still says so.
- **#5 a moved head invalidates every piece of evidence attached to the previous
  head** — held, and now server-side as well: the request carries the exact head
  and GitHub refuses it if the pull request head has moved.
- **#6 ambiguous or unavailable forge state fails closed** — held. A reading this
  build cannot classify carries no fields at all, an unreadable pre-reading
  attempts nothing, and an unreadable post-reading is `OBSERVATION_UNAVAILABLE`
  rather than a verdict.
- **#7 a merge observes the exact resulting commit identity, returned by the
  operation and confirmed against the repository** — **half held, and the half
  that is missing is stated.** The resulting commit is established, and
  deliberately *not* from the operation's response: measured, that response
  replays the original commit for an already-merged pull request, so it proves
  nothing. It comes from a fresh reading of the pull request. It is **not**
  confirmed against a local repository — doing so would mean fetching the base
  branch, which is a local Git act this slice does not perform, and no other
  invariant requires one. `L-V4-07-5` carries the gap.
- **#8 a successful merge API call is not completion** — held, and it is the
  point of the slice's shape. The API's answer is never the proof, no task state
  is written, and `READY_FOR_PR` stays terminal. Post-merge verification and
  `COMPLETE` are not built.
- **#9, #10, #11 delivery authority, declaration, and no widening of execution
  guarantees** — unchanged. A third authority was added and it is narrower than
  either sibling in what it can reach: no local process, no repository root, no
  free text.

## The counter-proof

Run in a scratch copy of the tree, against the seven V4 suites.

    BASELINE GREEN
    46 mutants -> 41 KILLED, 5 EQUIVALENT, 0 HARNESS_FAILURE

**The baseline check is load-bearing and it fired.** The first two runs stopped
on a red baseline: the lab was not copying `README.md`, which two suites read. A
red baseline reports every mutant KILLED, so the campaign was worth nothing until
that was fixed — and it said so rather than producing a number.

The 41 kills cover every guard the slice exists for: the authority (registry,
one-shot, method binding, number bounds, base grammar, addressability), the fence
(the `sha` field, the method field, `-X PUT`, the three attempt conditions), the
pre-reading (head moved, closed-unmerged, draft, wrong base, already merged,
wrong number), the post-reading (response trusted over reading, missing resulting
commit, merged at another head, merged into another base, both attempt arms), the
orchestration (authority not spent, subject not re-checked, either reading
skipped, a retry added, each field of `sameSubject`, the merge-commit gate), the
parse (`merge_commit_sha` read while open, an unknown state word read as open,
`merged` inferred from `state`, a malformed document read past) and the command
ladder (the attended gate, the decision gate, the task-state gate).

### The five equivalents, and why none is a kill in disguise

**A redundant pair in `MergeGrant.claim`.** Removing the registry gate survives,
and removing the `try`/`catch` survives — *separately*. Each is what makes the
other's removal invisible: every forgery constructible outside the module lacks
the private field, so either line refuses it. In unmutated code the gate is
first, so the `catch` is not reached at all. Both stay; neither is claimed to be
covered. Killing either would need a value that has the private field and was not
minted, or one that passed the registry without carrying the field — the second
is reachable only by capturing the registry before the first mint, which
`lease/execution-lease.ts` records a review doing, and which is not reachable
from this suite.

**Three floors in `performMerge`.** The proof-commit comparison, the head-sha
comparison and the `pullRequestNumber === null` arm all survive, because
`decideDelivery` answers the positive member only when the outcome is `MATCHED`,
the number is non-null and the head equals the commit — and because the proof is
minted by `attestDeliveryObservation` from the very subject the first of them
compares against. **A comment beside one of them argued it was not a floor.** That
was reasoning, not measurement, and the campaign refuted it; the comment now says
what was measured. All three stay, labelled, because each premise belongs to
another function's wiring rather than to this one.

### What the campaign found in the product

Two defects, both fixed before this ADR was written:

1. `MergeResult.mergeCommit` was filled whenever the reading afterwards said
   `MERGED`. Under `POSTCONDITION_MISMATCH` — a pull request merged at a head or
   into a base this invocation did not authorise — that offered somebody else's
   merge as this delivery's result, under a report line labelled `Merge commit`.
   It is now gated on the outcome, and the reading is still printed whole so
   nothing is hidden.
2. The floor comment above.
