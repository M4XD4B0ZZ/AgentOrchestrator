# ADR — The delivery decision (V4 slice 4)

- Date: 2026-08-23
- Status: **Accepted.** Implemented as V4 slice 4.
- Extends `2026-08-23-adr-durable-delivery-evidence.md`. Adds a classification
  and no authority whatsoever. `READY_FOR_PR` remains terminal.

## Context

Slices 1–3 report facts. Slice 1 resolves a delivery target, slice 2 asks
github.com two read-only questions about one exact commit, and slice 3 stores
one answer as a historical snapshot. Nothing so far combines them, on purpose:
`observe-delivery.ts` says in its header that no value in it means "ready to
merge", and that a caller wanting one would have to write that policy itself.

This slice writes that policy, in the smallest truthful form. It is the first
place in the product where two facts become one word.

## What this slice is called, and why it is not called merge eligibility

The brief that commissioned this slice named it "delivery decision /
merge-eligibility foundation" and instructed that the name be narrowed to
whatever turned out to be true. It was measured, and it is narrower.

**AO cannot establish merge eligibility, and the obstacle is not effort.** To
claim "every required check passed" a caller must be able to enumerate the
required checks. Measured, read-only, against `github.com` on 2026-08-23:

| Surface | This repository (viewer is admin) | Five foreign repositories |
| --- | --- | --- |
| `repos/{o}/{n}/branches/{b}/protection` | **404** `"Branch not protected"` | **404** `"Not Found"` — all five |
| `repos/{o}/{n}/rulesets` | **200 `[]`** (genuinely none) | **200 `[]`** — including two that demonstrably *have* rulesets |
| `repos/{o}/{n}/rules/branches/{b}` | **200 `[]`** | **200 `[]`** for two repositories whose pull requests are measurably `BLOCKED` under classic protection this endpoint cannot see |
| GraphQL `baseRef.branchProtectionRule` | `null` | `null` |

Every surface answers "there are no rules" and "you may not read the rules" with
the same value. The negative is therefore not provable, and a decision resting
on it would be asserting a property of a set AO cannot enumerate.

Three further measurements point the same way:

- **`mergeStateStatus: CLEAN` is not "rules satisfied".** PR #57 is `CLEAN` and
  has *zero* required checks — corroborated by `gh pr checks --required` exiting
  1 with "no required checks" and by GraphQL `isRequired` returning `false` for
  both runs. `CLEAN` there means "nothing to satisfy".
- **`reviewDecision: ""` is a rendered `null`**, not a fourth enum value, and it
  is what every pull request in this repository returns. It cannot be read as
  "no review is required" while the rules that would say so are unreadable.
- **`mergeable: UNKNOWN` is transient.** Three of sixty sampled open pull
  requests answered `UNKNOWN` and all three answered a real value on the very
  next read. One poll of that field establishes nothing.

So the decision is named for the two facts it actually has, and
{@link MERGE_ELIGIBILITY_SENTENCE} states the limit in the operator's own words
on every decision, including the good one.

## What is deliberately not observed

Draft status, mergeability, merge-state, review verdict and `archived` are not
read. Draft is the interesting one: it rides on the locator endpoint slice 2
already calls, so it is free on the wire — and it is still not read, because
carrying it would put a new field in the durable evidence record and bump that
record's version. That is a slice-3 contract change with its own back-compat
question, and it belongs to whoever takes it deliberately.

The consequence is stated rather than hidden, in the module header and in the
positive decision's own sentence: **a positive decision can be true of a draft
pull request.** It claims two things and neither of them is "mergeable".

## The rule the whole slice hangs on

**A positive decision requires an observation this process made.**

Not a recent one. Not a valid one. One that happened, here, for this question.

```
historical SUCCESS   + no fresh observation  =  NOT ENOUGH
historical PR match  + no fresh observation  =  NOT ENOUGH
```

### It is enforced by the parameter type, not by a rule

`decideDelivery` takes a `DeliveryObservationProof` — slice 3's opaque artefact,
mintable only from the recognised observation boundary and only for an
observation that settled both questions. `readDeliveryEvidence` returns plain
fields; there is no overload that accepts them, no `fromRecord`, and no shape a
caller can write down instead. The one way to a positive decision is to have
just asked.

Counter-proved rather than asserted: a forgery carrying every correct field,
driven through the real argument, is refused into `OBSERVATION_UNSETTLED`; the
same facts through the real mint decide positively. Mutants that let a `null`
proof or unreadable facts decide are both killed.

### Slice 3's record is not dead weight, and it is not an input

The record is used for exactly what it was built for — audit history, reported
beside the fresh answer and compared against it by the renderer, which already
owned that comparison before this slice. No second comparison was added: a
second implementation of "does the stored record agree" would be a second
opinion about one question.

What slice 4 *reuses* is slice 3's **mint**. It was built so that a
forge-observation claim cannot be manufactured without going through the
observation boundary. Slice 3 needed that to keep a record honest; slice 4 needs
it to keep a decision honest. Same artefact, second load-bearing use.

### The instant is carried and never judged

Nothing reads `observedAt`. An hour-old proof and a millisecond-old proof decide
identically, and a test pins it. There is no TTL in this build — slice 3's
reasoning is unchanged and applies with more force here, because a threshold on
a *decision* would be a licence rather than a report.

## The decision vocabulary

Eleven members, one positive. The precedence between them is the contract and is
asserted, not left to whoever reads the ladder:

1. `SUBJECT_NOT_ESTABLISHED` — nothing local to decide about;
2. `NOT_DECIDED` — nothing was contacted;
3. `OBSERVATION_UNSETTLED` — the forge did not answer both questions, or the
   proof cannot be read, or its two halves name different commits;
4. `SUBJECT_CHANGED` — the answers are about a different subject from the one in
   front of us now. Ahead of the next member: a review measured the code
   answering this when both were true while the list claimed the other, and the
   code is the better answer — "these answers are about something else" does not
   depend on the second look having succeeded;
5. `SUBJECT_REVALIDATION_FAILED` — the local subject could not be re-read;
6. `CHECKS_FAILED` — ahead of every pull-request answer, because a pull request
   at a red commit does not make the commit green;
7. `PULL_REQUEST_AMBIGUOUS` — AO cannot tell which pull request it would mean;
8. `PULL_REQUEST_REQUIRED` — ahead of a pending or absent check, because opening
   one is the next action and can be taken while checks run;
9. `CHECKS_PENDING`;
10. `CHECKS_ABSENT` — **not** a success. Zero checks is the absence of evidence;
11. `PULL_REQUEST_MATCHED_CHECKS_SUCCESS` — the only positive.

No member may contain a word that reads as permission. That is a test over the
*derived* vocabulary rather than a list of names, so a member added tomorrow is
covered without anybody remembering the rule.

### Unknown values fail closed, and the floors are labelled as floors

The slice-2 defect this slice must not reproduce one layer up is `else =>
success`. There is no trailing success arm: the positive answer requires
membership of a closed one-word set, and everything else refuses.

Three checks in `decideDelivery` are **floors rather than live gates**, and they
are labelled as such in the code because counter-proofs said so — removing any
of the three kills no test:

- the pull-request head comparison, and the queried-commit comparison. The mint
  writes both fields *from the subject*, so no proof this build can produce can
  differ. The premise is pinned by a test asserting that derivation, and a
  mutant that breaks the mint's derivation **is** killed — so a change there
  makes these live rather than leaving them quietly wrong;
- the closed success set. The three arms above it name every settled check word
  except `SUCCESS`.

This is written down rather than glossed because "defence in depth" is exactly
how an unreachable branch gets mistaken for a working one.

The third floor's justification took **two corrections** before it was true, and
both were found by counter-proof rather than by reading:

1. it first cited a partition assertion that "fails the moment the mint's settled
   set grows a fifth member" — while the assertion derived from
   `RECORDABLE_CHECK_OUTCOMES`, a hand-written array in another module that
   nothing tied to the mint. Adding `STALE` to the mint left every test green;
2. the repair probed the mint directly, but in one payload shape only. The mint
   refuses anything but `NO_CHECKS` that arrives without counts, so a widened
   settled set was still refused — by the *counts* gate — and the probe could
   not tell the two refusals apart. Two mutants survived it as well.

What is pinned now: the suite asks the mint, in **both** payload shapes, about
every word in the declared outcome union plus every raw GitHub check word this
build knows, upper-cased, and asserts the accepted set is exactly
`RECORDABLE_CHECK_OUTCOMES`. Three mutants are killed by it — mint accepts
`STALE`, mint accepts a refusal word, mint drops `NO_CHECKS`.

### The positive decision names slice 2's word, and does not gloss it

The member was `…_CHECKS_PASSED`, and its sentence said "every check on this
commit had succeeded". A review showed that false using the product's own
grading: `aggregateCheckState` counts `neutral` and `skipped` as non-blocking,
so a commit whose *only* check run was `skipped` aggregates to `SUCCESS` with
`succeeded: 0`. A path-filtered or `if:`-guarded workflow job produces exactly
that, on this repository included — and the report contradicted itself, printing
`0 succeeded … 1 neutral/skipped` above the claim that every check had
succeeded.

The behaviour is slice 2's and is unchanged. What changed is that slice 4 stops
adding a second, stronger English definition on top of it: the member is
`PULL_REQUEST_MATCHED_CHECKS_SUCCESS`, it carries slice 2's own graded word, and
its sentence names the definition and points at the counts printed above it.
Pinned by a test that drives the skipped-only case to the positive decision and
asserts the sentence does not claim anything succeeded.

## The local race, and the honest limit of what is closed

The forge cannot be frozen while AO thinks. What can be protected is the local
half, and it is:

```
resolve subject → observe → RE-RESOLVE subject → compare → decide
```

The second pass repeats the whole resolution — resolve the repository again,
read the task record again, build the subject again — and compares the target
identity, the pinned commit and the task state name. The task state is part of
the comparison on purpose: a task aborted while the forge was being asked has
the same commit and the same target, and deciding for it would describe delivery
for something nobody intends to deliver.

`UNCHANGED` is **not** a claim that the answers are still true. Nothing can make
that claim. The remaining race is remote and unclosable: the pull request's head
can move, a check can start or fail, the pull request can close, all between the
response and the moment anybody reads the report. **A future merge slice must
observe again immediately before mutating anything**; a decision is never an
input to that observation.

There is no second look at the *repository root*: resolving the same absolute
path twice gives the same root, so a comparison there would be a branch nothing
can reach — the thing this slice's counter-proofs exist to find.

## Authority: there is none to take, and that is measured

**No task state is written, so no authority is needed.** That is not a
convenience; it is what the code forces, and the alternative was investigated
before it was rejected.

Any move out of `READY_FOR_PR` goes through `advanceTaskState`, which requires an
`ExecutionLeaseAuthority` as a *required parameter* (`state/advance-state.ts`).
Acquiring that lease from a command is mechanically possible — `release` and
`block` both do it, and the acquisition path spawns nothing. Slice 3's ADR said
taking it "would turn a read-only command into an executing one"; that sentence
is accurate about contention and classification and should not be read as
"acquiring the lease executes something". It does not. What it does is write two
files into the Git common directory, replace the writer-launch ledger, and lock
the whole clone against every other invocation for the duration.

None of that was the blocker. The blocker is downstream, and it is worse.

### Why `READY_FOR_PR` did not gain an outgoing transition

The brief permitted one ("added only if required"). It is not required, and it
would be actively destructive today. Measured:

- **`block/block-evidence.ts` re-proves a `SETTLED` ledger entry against
  `entry.evidenceRevision === revision`** — a digest of the exact task-state
  bytes — **and** against `record.state === 'READY_FOR_PR'`. So *any* write to a
  settled task's state file, whatever it changes, breaks both proofs at once:
  `SETTLED_WITHOUT_TERMINAL_STATE` and `EVIDENCE_STALE`, both divergent, which
  stops the whole block run with `LEDGER_DIVERGED`. **It fires cross-process**:
  a delivery advance in one terminal breaks a block running in another. A
  `READY_FOR_PR` task's state file is frozen by contract;
- **`block/block-progress.ts` can never settle a task that moved on** —
  `TASK_STATE_DOES_NOT_PROVE_IT`;
- **`block/reconcile-block.ts` stops detecting `TASK_AHEAD_OF_LEDGER`**;
- the transition table's terminal states are pinned to have no successors, so
  `READY_FOR_PR` would have to leave `TERMINAL_STATES`. Four separate
  hand-written `=== 'READY_FOR_PR' ? … : 'TASK_ABORTED'` ternaries would then
  report any new terminal state as **aborted**, and `run --attended` on a
  finished task would stop returning `TASK_COMPLETED` and start reconciling a
  worktree the product deliberately stopped judging;
- **`CLAUDE.md` says it outright**: giving `READY_FOR_PR` an outgoing transition
  "is a product-contract change and needs its own decision, not a
  delivery-infrastructure commit."

And the state would be unproductive: nothing can advance it until merge
authority exists, which is a later slice by construction. The rule against dead
enum members applies to states too.

### The decision is not durable, and that is the decision

No decision record is written. A future merge slice must re-observe immediately
before acting, so a stored decision would have no consumer — and a stored
*verdict* is a strictly more dangerous artefact than a stored observation,
because it already looks like a conclusion. Slice 3 learned that lesson about
facts; this slice declines to relearn it about judgements.

The consequence is that the decision exists for the length of one invocation and
is reported to a person. That is the whole product effect.

## The surface

`agent-loop delivery --repository <path> --task <id> --observe --decide`

- `--decide` without `--observe` answers `NOT_DECIDED` and contacts nothing. It
  is not a separate refusal vocabulary: the member already says "pass --observe
  as well", and inventing a second word for it would be two names for one fact;
- the **exit code is unchanged** by `--decide`. It answers one question — was
  the observation settled — and always has. A caller that could read "deliver
  this" out of an exit status would have been handed the machine-consumable
  merge signal this slice exists not to give. Carried as `L-V4-04-2`;
- one mint per invocation, shared by `--record` and `--decide`, so a run that
  does both binds them to the same observed instant;
- `--record` semantics are untouched: it still refuses without `--observe`,
  still writes one snapshot, and still prints no decision.

## Invariants, against M1

- exact-SHA everywhere: the proof's subject is compared against the question's
  subject, and a green answer for commit A cannot satisfy a question about B;
- host restriction, credential isolation and scope protections are slice 2's and
  are untouched — every request in this slice's own tests is asserted to begin
  `api --hostname github.com -X GET`;
- no forge mutation exists **as of this slice**. The derived scan over the
  whole delivery surface bans `-X POST|PATCH|PUT|DELETE`, `gh pr merge`,
  `--auto`, `spawn(`, `runOwnedCommand(`, `advanceTaskState(`, `saveTaskState(`
  and `acquire*ExecutionLease(`. **Superseded by V4 slice 5**, which added a
  `git push` that creates one ref on the delivery remote. Every ban listed here
  still holds — none of them was what made the sentence true — and the claim
  that a scan can actually measure now lives in
  `2026-08-24-adr-delivery-head-publication.md`: one module, one create-only
  vector;
- no PR creation exists. `PULL_REQUEST_REQUIRED` is an answer, not a trigger.

## Residuals

- **`L-V4-04-1`** — draft status is not observed, so a positive decision can be
  true of a draft pull request. Free on the wire; costs an evidence-record
  version bump.
- **`L-V4-04-2`** — the decision is not machine-consumable. It is rendered for a
  person and the exit code does not carry it.
- **`L-V4-04-3`** — merge eligibility is not establishable at all with the
  surfaces measured above. This is a property of GitHub's permission model, not
  a gap to be closed by more requests.
- **`L-V4-04-4`** — `COMMIT_STATUS_STATES` omits `expected`, which GraphQL's
  `StatusState` declares. If REST ever emits it, `parseCommitStatuses` refuses
  the whole observation as malformed. Fail-closed, and worth a deliberate arm.
- **`L-V4-04-5`** — runless queued check suites remain invisible to both
  mechanisms (2 measured on PR #57), so `CHECKS_ABSENT` and a passing aggregate
  are both statements about the records that exist. Inherited from slice 2.
- **`L-V4-04-6`** — the decision is not recorded anywhere, so "AO decided X at
  time T" is not auditable after the process ends. Deliberate; revisit only if a
  consumer appears that a fresh observation cannot serve.
- **`L-V4-04-7`** — the positive decision is reachable for a commit on which
  **nothing succeeded**. Slice 2 grades `neutral`/`skipped` as non-blocking, so
  a commit whose only check run was `skipped` aggregates to `SUCCESS` with
  `succeeded: 0`. That grading is slice 2's decision and is unchanged here; what
  slice 4 owes is disclosure, which is in the member's sentence and pinned by
  test. A decision that distinguished "something ran and passed" from "nothing
  blocking ran" would need the counts in the vocabulary, and that is a wider
  contract than this slice takes.
- **`L-V4-04-8`** — `deliveryObservationFactsOf`'s `catch` — a value that passes
  the registry gate and throws on the private-field read — is unpinned by any
  test in this slice. It needs registry capture, which is slice 3's boundary.
  The prototype-derived forgery this suite drives is refused one step earlier,
  at the gate, and the test says so rather than claiming the `catch`.

## The next slice, named only

**Pull-request creation.** `PULL_REQUEST_REQUIRED` is now a truthful, reachable
answer with nothing behind it, and the honest way to close it is the first forge
*mutation* — which needs explicit GitHub write authority, a title and body
contract, base/head identity rules, idempotency against a moved head, and its
own audit evidence. It is a slice, not a flag.
