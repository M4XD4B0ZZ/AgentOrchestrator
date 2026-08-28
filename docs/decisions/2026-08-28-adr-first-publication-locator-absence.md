# ADR — the first publication, and the one forge answer that unlocks it

**Status:** accepted, 2026-08-28
**Slice:** V4 slice 18R — a blocker fix, not a feature
**Supersedes nothing.** Narrows `docs/decisions/2026-08-23-adr-delivery-observation-seam.md`
and `docs/decisions/2026-08-26-adr-delivery-lifecycle-driver.md` in one place each.

---

## 1. The dogfood defect

V4 slice 18 ran the complete M1 delivery chain against this repository with the
product driving itself. It found exactly one remaining blocker, and this is it.

Task `M1-DOGFOOD-002`, at `READY_FOR_PR`, head
`8eb54f18efd513cb84a8be459619b43ef6acb3c1`, never sent anywhere. Invoked as

```
delivery --drive --publish-head --automatic-publish-head-only
```

the observed trace was:

1. the conclusion oracle answers `RECEIPT_ABSENT` — a stage, not a stop;
2. the driver runs the **reconciliation first**, deliberately, so that a
   delivery already merged and closed is not staged as "needs a pull request";
3. reconciliation asks the locator, `GET repos/{o}/{n}/commits/{H}/pulls`;
4. github.com cannot address `H` and answers **HTTP 422**, `gh` exits 1;
5. `request(...)` in `github-observer.ts` mapped every completed non-zero exit
   to `REQUEST_FAILED`;
6. `observeMergeForDelivery` mapped every locator refusal to `FORGE_UNREADABLE`;
7. the driver mapped that to `FORGE_STATE_UNKNOWN` and returned.

`performPublication` was never reached. The publication is **create-only**, so
the one act whose entire purpose is to put `H` on the forge was unreachable
*exactly while `H` was not on the forge*. A genuine circular precondition.

Reproduced in-repo before any fix, through the real CLI:
`FORGE_STATE_UNKNOWN`, exit 4, publication calls **0**.

## 2. Root cause

Not the ordering, and not the publication. **The transport had one word for two
different things**: a request that could not be answered, and a request the far
side answered by declining to be asked about that subject. Everything above
step 5 is a faithful propagation of that one conflation.

## 3. The exact GitHub measurement

Taken with the installed `gh` 2.97.0 on 2026-08-28, read-only, `-X GET` only.
Nothing was created, pushed or merged.

| endpoint | subject | exit | stdout |
| --- | --- | --- | --- |
| `commits/{H}/pulls` | a 40-hex name the repo cannot resolve | 1 | `{"message":"No commit found for SHA: <H>","documentation_url":"…#list-pull-requests-associated-with-a-commit","status":"422"}` — 205 bytes, no trailing newline |
| `commits/{H}/pulls` | the same name in **UPPER CASE** | 1 | the message echoes it uppercase, **verbatim** |
| `commits/{H}/pulls` | a 7-hex abbreviation | 1 | the message echoes `deadbee` |
| `commits/{H}/pulls` | `nosuchbranchxyz` | 1 | the message echoes it, and still says "SHA" |
| `commits/{H}/pulls` | a **tree** object that exists here | 1 | the identical 422 document |
| `commits/{H}/pulls` | a **blob** object that exists here | 1 | the identical 422 document |
| `commits/{H}/pulls` | a real commit from another repository | 1 | the identical 422 document |
| `commits/{H}/pulls` | a repository that does not exist | 1 | `{"message":"Not Found",…,"status":"404"}` |
| `commits/{H}/pulls` | an **empty** repository | 1 | `{"message":"Git Repository is empty.",…,"status":"409"}` |
| `commits/{H}/pulls` | with a bad credential | **1** | `{"message":"Bad credentials",…,"status":"401"}` — note: **not** exit 4 |
| `commits/{H}/check-runs` | the same missing name | 1 | the same message, with the **checks** documentation url |
| `commits/{H}/status` | the same missing name | **0** | HTTP 200, `state:"pending"`, `total_count:0`, the requested sha echoed back |
| `commits/{H}/pulls` | the initial commit, which no PR ever carried | 0 | `[]` |
| `commits/{H}/pulls` | PR #74's head, **branch deleted** | 0 | the candidate, `state:"closed"` |
| `search/issues` with an empty query | — | 1 | a 422 carrying a fourth member, `errors: [...]` |

`status` is a JSON **string** in every error document measured. The three
members present in all of them are `message`, `documentation_url`, `status`.

## 4. Answer-bound evidence, and its honest limit

The message echoes the ref segment the URL carried, **unnormalised**. So the
equality against `H` is *not* the binding `SUBJECT_MISMATCH` has: that member
compares our subject against `head_sha` and `sha`, values GitHub computed from
records it holds. This one compares our subject against a string GitHub copied
out of our own URL. **It is a parrot, not a witness**, and the code says so.

It is still required, and it is worth three specific things:

- it refuses a body belonging to a **different request** — a crossed, cached or
  replayed answer cannot pass;
- it refuses every **generic** 422 this repository already documents:
  `"The sha parameter must be exactly 40 characters…"`, `"Validation Failed"`,
  `"No commits between main and main"`;
- if GitHub ever starts canonicalising the ref it echoes, the classifier stops
  firing and the build returns to `REQUEST_FAILED`. Fail-closed by drift.

The one member of the document GitHub *chooses* rather than echoes is
`documentation_url`, and it is required too. It is the only field that binds the
answer to an **endpoint**: the same missing-commit message arrives from
`commits/{sha}` with `#get-a-commit` and from `check-runs` with the checks url,
and requiring the locator's own constant makes both unclassifiable here even if a
later caller wires the reader to the wrong endpoint.

## 5. The error-body parsing boundary

`locatorReportsNoCommit(stdout, commit)` is the **only** place in this build
where a body that arrived with a failing exit code is read at all, and it reads
it as an *error document*. It never hands anything to `parsePullCandidates`,
which is the parser that turns a response into evidence. Its whole output is a
boolean.

It is called from one place, on one endpoint, and `request(...)` takes the
reader as a **required parameter with no default** — the three other call sites
pass `null` explicitly, which is what makes "the check endpoints' error
documents are never read" a property of the file rather than a sentence in it.
TypeScript infers the extra member as `never` for those three, so their results
carry exactly `ObservationRefusal`.

The grammar accepts only: a JSON object (not `null`, not an array); `message`,
`documentation_url` and `status` all `string`; `status === "422"`;
`documentation_url === ` the locator's own constant; **no** `errors` member; the
message beginning `No commit found for SHA: ` and ending in exactly `commit`.
Everything else is `false`, and `false` is today's `REQUEST_FAILED`.

**A document naming a different object name falls through to `REQUEST_FAILED`.**
It is deliberately *not* mapped to `SUBJECT_MISMATCH`: that member's contract is
about the far side naming another commit *out of its own records*, and promoting
a parrot to a witness would make its own docstring an incomplete enumeration on
its first reading. Both refuse; neither buys behaviour; the narrower option wins.

## 6. The new semantic members

Three, and no more.

**`COMMIT_UNRESOLVED`** (`forge-observation.ts`) — the locator's reading.
Deliberately **not** a member of `OBSERVATION_REFUSALS`, which documents itself
as *the refusals both questions share*. Only the locator can produce this one.
Adding it there would make that sentence false, would widen `CheckStateOutcome`
with a value the check path can never hold, and would put a new word in front of
the settled-check allow-list — the exact direction the check-runs guard exists to
prevent.

**`DELIVERY_COMMIT_UNRESOLVED`** (`reconcile-merge.ts`) — the reconciliation
outcome, inserted between `FORGE_UNREADABLE` and `NO_PULL_REQUEST_AT_HEAD`,
which is where the vocabulary's own "weakest claim first" ordering puts it. The
position is pinned by a test, because the report-shape table is built from the
array and would otherwise silently encode any order.

**`FORGE_READINGS_DISAGREE`** (`delivery-driver.ts`) — see §12.

The word is `UNRESOLVED` and not `ABSENT`, and the measurement is why: a tree and
a blob that both exist here produce the identical answer. The claim is about
**resolution**, in **one repository**, at **one instant**.

## 7. What reconciliation now means

Old: every locator refusal → `FORGE_UNREADABLE`.
New: the one measured missing-commit answer for exactly this subject →
`DELIVERY_COMMIT_UNRESOLVED`; **everything else unchanged**.

`contacted` is `true` either way — a process ran and github.com replied.

The operator sentence, pinned by literal:

> Asked which pull requests carry this task's delivery commit, the forge answered
> that it found no commit with that object name in this repository. Nothing about
> a pull request, about a merge, or about where this commit has been is
> established.

It **attributes** rather than adopts, and a test pins that it contains none of
"does not exist", "never", "not merged", "was not published", "no pull request
has", "nowhere".

Distinct from `NO_PULL_REQUEST_AT_HEAD` by two different answers on the wire:
that one is HTTP 200 with an empty array — the candidate set read in full — and
this one is the refusal to produce a candidate set at all.

## 8. Where the driver acts

One new branch, immediately after the reconciliation's `FORGE_UNREADABLE` arm
and **before** the observation. Publication is *not* moved globally ahead of
reconciliation: reconciliation still runs first on every path, and this branch is
reachable only from one of its outcomes.

```
if (reconciled === 'DELIVERY_COMMIT_UNRESOLVED') {
  if (!mayPerform(options, 'PUBLISH_HEAD')) → ATTENDED_AUTHORITY_REQUIRED / PUBLISH_HEAD
  const stopped = await publishOnce();      // the same closure the ordinary path calls
  if (stopped !== null) return stopped;
  return settle('FORGE_READINGS_DISAGREE', stage);
}
```

The publication ladder was **factored into one closure with one call site**,
called from two places. That is not tidiness: `tests/v4-11-…` reads this file's
own source and asserts each act's step function occurs exactly once, so an act
reachable from two branches has to be a helper. It also removes the possibility
of two copies of a nine-arm mapping drifting apart.

The `if`-chain over the reconciliation vocabulary is now **exhaustive**: the tail
assigns `reconciled` to a three-member union, so a twelfth member added later is
a compile error rather than a silent fall-through into the acts.

`stage` at the insertion point is provably `RECEIPT_ABSENT` — the only remaining
`null` entry in `CONCLUSION_MEANING` at that line — so no new conclusion outcome
and no new `settle` argument were needed.

## 9. Why the observation is skipped in this one world

Not as a shortcut. **It cannot answer.**

`commits/{sha}/check-runs` returns the same missing-commit refusal for the same
subject, so `concludeObservation` would answer `OBSERVATION_INCOMPLETE`, the
decision would be `OBSERVATION_UNSETTLED`, and the driver would stop one branch
further down having sent two more requests and learned nothing. Running it would
not be caution; it would be a longer road to the same stop.

And the alternative is worse than useless. `commits/{sha}/status` answers **HTTP
200 `pending`, zero statuses, echoing a sha it does not have** — so any reader
that consulted it alone would invent a `PENDING` an operator would sit and wait
on for ever. **No check evidence is synthesised for a commit the forge will not
resolve**: not `NO_CHECKS`, not `PENDING`, not `SUCCESS`, not any other settled
word. A test asserts the report carries no such line.

## 10. Why generic failures still fail closed

The transport's fail-closed treatment of arbitrary non-zero exits is untouched:
the classifier runs *after* `NOT_FOUND`, after every non-`COMPLETED` outcome, and
after `exitCode === 4`, and it returns `false` for everything that is not the one
measured shape. Twenty-two adversarial bodies are pinned, including a 404, a 409,
a 401 (which measurably arrives on exit **1**, not 4), a 403, a validation 422
with an `errors` array, the same message from two other endpoints, a numeric
`status`, an array, a JSON null and a body that is not JSON.

"We sent a request for `H`, therefore an arbitrary 422 must have meant `H`" is
the reasoning this design refuses, and the wrong-subject test is what keeps it
refused.

## 11. Merged, with the branch deleted, still recovers

Measured three times on this repository and once more on 2026-08-28: the locator
**still resolves** a merged pull request from its head object name after the head
branch is deleted, and after a squash merge has left that head on no branch at
all (PRs 49, 50, 74). So the missing-commit answer never arises for that world,
the exit code is 0, the classifier is never reached, and reconciliation wins.
Nothing is republished. Pinned by a test in both the ladder and the driver.

## 12. The same-`H` race

The locator says the forge will not resolve `H`; a moment later the publication's
own fresh reading of the delivery remote finds the ref already holding exactly
`H`. Somebody else published it in between, or the forge's two surfaces had not
caught up with each other. AO sent nothing.

No existing driver member is truthful here. `EFFECT_ATTEMPTED` claims an act;
`FORGE_STATE_UNKNOWN` says a reading could not be taken, when in fact both were
taken and answered; `PULL_REQUEST_REQUIRED` asserts a pull-request fact this run
never read. So one member was added — **`FORGE_READINGS_DISAGREE`**, graded
`EXIT_RUN_REFUSED` (4): this invocation achieved nothing, nothing durable is
wrong, and a later invocation reads a world that has moved on. Grading it 5 would
have made that table's own "`EXIT_RUN_CALL_AGAIN` appears exactly twice" false as
well as wrong.

**The invocation stops there and does not continue into pull-request creation**,
even under `--create-pr --attended`, because it holds **no observation**: the
questions were deliberately not asked. Opening a pull request from a decision
nobody took is precisely the fabrication this driver's one-mutation property
exists to prevent. Pinned by a test that passes `--create-pr --attended` and
asserts zero creation calls.

## 13. Authority is unchanged

No new grant. No widened `HeadPublicationGrant`. No new trusted declaration key.
No unattended pull request. No unattended merge. No persisted grant. No retry
token.

The branch calls `performPublication` with **the same seven arguments** the
ordinary path uses, none of them derived from the locator. Every gate is a
function of the command line, local disk, the operator's declaration, Git and the
remote ref — and the locator's answer appears in none of their inputs. It changes
**when** the primitive runs and nothing about what it may do:

`refusePublicationGrants` on the command line → `mayPerform` → the work floors →
the operator declaration → the ref grammar and the one-shot grant mint → the
subject re-resolution and seven-field equality → the audit precondition → the
create-only server-side fence → the outcome record.

## 14. Audit is unchanged

`authorisation.json` is still written and read back **before** the delivery
remote is contacted; if it cannot be made durable, nothing is published.
`outcome.json` is still written **after** publication processing on every path
where an authorisation was written, including the ones that send nothing; if it
cannot be established, `PUBLICATION_OUTCOME_NOT_DURABLE` still stops the run and
still carries the store's own exit grade. Both are pinned on the new path.

## 15. One effect per invocation

Unchanged. The new branch reaches at most `performPublication`, and returns on
every one of its outcomes. No pull request is created and no merge is attempted
in an invocation that took the branch — asserted with all three act flags named.

## 16. Re-entry

The next invocation re-derives everything: conclusion, then reconciliation, then
— now that `H` is addressable — the ordinary observation and decision. Nothing is
remembered between invocations and nothing is retried inside one.

## 17. Non-goals

- **The standalone `--observe` surface is unchanged.** `observePullRequestAtHead`
  grades the new reading back down to `REQUEST_FAILED`, deliberately: that
  question's vocabulary is about pull requests, and "the forge would not resolve
  this object name" is the refusal to give such an answer, not one. A fourth
  non-refusal word would sit in front of the settled allow-list and the durable
  record contract for the sake of a report line.
- **The empty-repository world is not closed.** Measured: an empty repository
  answers the locator with **409 `"Git Repository is empty."`**, not 422, so a
  first publication into a repository with no commits at all still stops at
  `FORGE_STATE_UNKNOWN`. That is a different answer, about a different subject
  (the repository, not the commit), and closing it is a decision of its own.
  Carried as `L-V4-18R-1`.
- No product-side fetch, no retention or indexing, no scheduler or polling.
- The four other slice-18 dogfood findings are untouched and stay residuals:
  `stateEnteredAt` reflecting step start, repeat-fingerprint detection defeated
  by reviewer wording, the missing template-cleanup regression assertion, and the
  template-builder failure path that can leak a temporary repository.

## Residuals

- **`L-V4-18R-1` — an empty repository is not this answer.** See §17.
- **`L-V4-18R-2` — two GitHub strings are load-bearing.** The message prefix and
  the locator's `documentation_url` are strings GitHub owns. If either changes,
  the classifier stops firing and the build returns to the pre-slice behaviour:
  fail-closed, and the first publication becomes unreachable again until the
  constants are re-measured. This is the first place in this build where a forge
  message decides behaviour, and it is stated rather than absorbed.
- **`L-V4-18R-3` — the answer is one repository's, at one instant, for one
  login.** A delivery merged through a fork, a rename or a transfer answers
  exactly this way. `L-V4-08-1` already records that this ladder cannot refuse
  what it cannot see; this member inherits that limit rather than closing it.
  What bounds the damage is that the act it permits is create-only and fenced
  server-side: even where the answer is wrong, nothing can move a ref that is
  already there.
- **`L-V4-18R-4` — the report still advises `--observe` on this path.** With no
  observation taken, the renderer prints `not observed  (pass --observe to ask
  the forge about this commit)` — true, but on this one path the omission was
  deliberate and `--observe` would answer `OBSERVATION_UNSETTLED` for the same
  reason. A `--drive`-aware sentence is a renderer change this fix did not make.
- **`L-V4-18R-5` — a 401 arrives on exit 1, not 4.** Measured: a bad credential
  produces `{"message":"Bad credentials",…,"status":"401"}` and `gh` exits 1, so
  `NOT_AUTHENTICATED` under-fires and the reading is `REQUEST_FAILED`. Pre-existing,
  orthogonal to this blocker, and deliberately not repaired here. Both are
  refusals and both fail closed; only the operator sentence is less precise than
  it could be.

## What the reviews changed

Recorded after the fact, in this file, when the two bounded review rounds run.
