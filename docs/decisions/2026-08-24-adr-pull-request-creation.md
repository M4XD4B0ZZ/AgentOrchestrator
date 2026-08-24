# V4 slice 6 — creating the pull request

Date: 2026-08-24
Status: accepted

## What this slice is

`delivery --observe --decide --create-pr --attended` opens **one** pull request
on github.com, from the task's work branch to its base branch, at exactly the
task's pinned commit. It is the second forge mutation this build can perform and
the second it can be asked for by name.

It does not push, does not update, close, reopen, mark ready or draft, comment,
label, request review, review, merge or enable auto-merge. It writes no task
state, takes no execution lease, and `READY_FOR_PR` remains terminal.

Slice 5 was going to be this slice, and the measurements refused it because
nothing in the build published a branch. That prerequisite now exists, so this
one is the act it was always meant to be.

## What was measured, and how

Every external behaviour below was measured against `github.com` before the code
was written. The mutating probes were chosen so that **GitHub provably cannot
create anything from them**, so none of them left a disposable pull request
behind: a head equal to the base, a head branch that does not exist, a base
branch that does not exist, a repository that does not exist, and an object name
in a field that does not take one. The repository's open pull requests were
counted before and after and were unchanged at zero.

### The transport, and why it is not `gh pr create`

`gh pr create --help`, gh 2.97.0, verbatim:

> When the current branch isn't fully pushed to a git remote, a prompt will ask
> where to push the branch and offer an option to fork the base repository.

and its dry run: *"Print details instead of creating the PR. **May still push
git changes.**"* Its flag set carries `--editor`, `--web`, `--fill`,
`--fill-first`, `--fill-verbose` and `--template`. Reading its source confirms
what the help implies: only the `--head`-supplied path is push-free, and the
other paths can fork the base repository, rename `origin` to `upstream` and add
a remote. It also performs its own open-pull-request lookup and fails locally on
a duplicate, so its idempotency is a client-side check-then-act race rather than
anything the server promises.

A command whose *non-creating* mode is documented as possibly pushing is not a
command a slice named after one mutation can use. The transport is:

```
gh api --hostname github.com -X POST repos/{owner}/{repo}/pulls --input -
```

with the body as JSON on **stdin**. `runCommand` already carries a payload to a
child and reports whether the whole of it was handed over, so no text goes into
an argument vector and no shell is involved.

**`-X POST` is not decoration.** `gh api` documents its default method as "GET
normally and POST if any parameters were added", and reading its source shows the
same switch fires on `--input`: with a body and no `-X`, the method becomes POST
on its own. The observation transport pins `-X GET` for the mirror image of this
reason. The method must never be a consequence of which other flags are present,
so it is written out and the whole vector is pinned by exact equality.

### `head` is a ref name. An object name is refused.

Measured, each a real request:

| `head` sent | answer |
| --- | --- |
| `main` | resolved (`422 "No commits between main and main"`) |
| `M4XD4B0ZZ:main` | resolved (same) |
| `refs/heads/main` | resolved (same) |
| `someone-else:main` | `422 {"field":"head","code":"invalid"}` |
| `5874deed…` (a commit that exists) | `422 {"field":"head","code":"invalid"}` |

**A full object name of a commit that exists is `invalid`, exactly as a missing
branch is.** So the exact commit cannot be sent. It can only be *checked*, and
that is what makes slice 5 a prerequisite rather than a convenience: this build
reads the delivery remote's head ref immediately before the request and refuses
unless it holds exactly `task.currentCommit`.

`base` is a ref name too: a full SHA there answers
`422 {"field":"base","code":"invalid"}`. This build therefore does **not** claim
to pin the base to a commit, because the API does not offer it.

The owner-qualified form `owner:branch` is used, because it is the one that names
a repository.

### The other refusals

| case | answer |
| --- | --- |
| head branch missing | `422 {"field":"head","code":"invalid"}`, exit 1 |
| base branch missing | `422 {"field":"base","code":"invalid"}`, exit 1 |
| head equals base | `422 "No commits between main and main"`, exit 1 |
| repository missing | `404 "Not Found"`, exit 1 |
| malformed body | `400`, documented |

Every refusal is a non-zero exit. Unlike `git push`, there is no measured case
where exit 0 means "nothing changed". That does **not** make exit 0 a proof of
creation, and the ladder does not treat it as one — see below.

**A duplicate is only distinguishable by prose, and this one is measured.** A
request for a head that already has an open pull request answers, verbatim:

```
422 {"message":"Validation Failed","errors":[{"resource":"PullRequest",
     "code":"custom","message":"A pull request already exists for
     M4XD4B0ZZ:v4-slice-6-pull-request-creation."}]}
```

exit 1, and nothing was created — the repository's open pull requests were one
before and one after. There is no structural discriminator: GitHub's own
error-code table reserves `already_exists` for other resources, and a
third-party production client matches this message with a regular expression.
This build parses **nothing** from the response, so the question never arises
for it.

The measurement also fixed the order of GitHub's own checks: the duplicate check
runs **before** the base check. A second probe in the same batch, sending
`base: "refs/heads/main"`, never reached the base validation for that reason.

### Closed and merged pull requests do not block a new one

Measured on live third-party data, read-only: `withastro/astro` carries **928**
pull requests on the single head branch `changeset-release/main` into `main`,
each with a different head commit, almost all merged — and exactly **one** open
at a time. `renovatebot/renovate`'s `renovate/lock-file-maintenance` shows the same shape
with zero open.

So GitHub's uniqueness constraint is scoped to *open* pull requests, and a
closed or merged one on the same pair does not prevent another.

**This build refuses anyway**, and the refusal is its own narrowing rather than
the API's: if a closed or merged pull request carries this **exact commit** as
its head and no open one does, the answer is `PRIOR_PULL_REQUEST_CLOSED` and
nothing is sent. Somebody decided about this delivery already; re-opening that
question is theirs, not a delivery command's. The rule is narrow — it keys on
the exact object name, not on the branch — so an ordinary sequence of commits on
one branch is unaffected.

### Concurrency is not guaranteed, and this build does not claim it is

No documentation states that GitHub's duplicate check and its write are one
transaction. The refusal arrives through the validation layer — the same layer
that produces "No commits between" — and `gh pr create` does not rely on the
server for it at all. The uniqueness *is* enforced, measurably; its
**atomicity** is unestablished.

So the idempotency claim rests on four things this build can point at, and not
on a fifth it cannot: a reading before, at most one request, a reading after,
and a later invocation that begins with a reading again.

### The endpoint this build does not use

There is a shorter-looking query, `GET /repos/{o}/{r}/pulls?head=OWNER:BRANCH`,
and it has a **measured fail-open defect**: an unqualified `head` is silently
ignored.

```
?head=M4XD4B0ZZ:v4-slice-4-delivery-decision&state=all  ->  1 result
?head=v4-slice-4-delivery-decision&state=all            -> 30 results
?head=zzz-no-such-branch-at-all&state=all               -> 30 results
(no head parameter at all)&state=all                    -> 30 results
```

A nonsense unqualified head returns byte-identical results to sending no filter.
A duplicate check written that way would read every open pull request in the
repository as a match, and the failure is silent rather than an error. This build
keeps slice 2's commit-keyed locator, `commits/{sha}/pulls`, which is asked about
one object name and whose every candidate is re-tested against its own head.

### Draft

`draft` is optional in the request schema **with no declared default**, and it
is not in the response schema's required list either. Measured on this
repository: all 59 pull requests it has ever carried report `isDraft: false`.

So the value is `false`, it is written into the request explicitly, and it is
bound into the authority. This build never marks a pull request ready or back to
draft, so the state chosen at creation is the only one it will ever set.

## The design

### Observe, mutate at most once, observe again

Slice 5's six steps in the same order, with one more — a pull request needs its
head on the remote already, and a ref update does not:

1. **spend the authority** — first, before anything is read or contacted;
2. **re-establish the local subject** — all eleven bound facts, compared. Ten
   of them were, until a review counted: `remoteName` was missing, and it is the
   one the two local preconditions are asked about;
3. **establish that the remote is one repository** — `ls-remote` reads the fetch
   URL and the identity this build POSTs to comes from the push URL;
4. **read the remote head ref** — it must exist and hold exactly the intended
   commit, because `head` is a ref name and GitHub resolves it on its side;
5. **read the forge** — which pull requests already carry this exact commit;
6. **send, at most once** — only when nothing has this head, with no retry on
   any outcome;
7. **read the forge again**, whatever the transport said.

There is no compensating action. If the postcondition is not what was intended,
nothing is closed, retargeted, edited or retried.

### The response body is never read

`POST /pulls` answers `201` with the whole pull request, number and all. Reading
that number and reporting it would make the result a claim about a document this
process never verified, and would make the *success* claim rest on the response.
So the transport returns one of three words about the **attempt** and no payload,
and every positive answer is established by the reading taken afterwards. The
pull-request number this build reports is the one it observed.

`COMPLETED` requires three independent conditions: the process ran to a regular
completion, it exited zero, **and** the request body was delivered in full.
`runCommand` reports the last of those separately, and a body only partly handed
over is graded `FAILED` — which does not mean "no effect", it means "not
established".

### The authority

`PullRequestCreationGrant` — opaque, one-shot, minted in exactly one place.
Same three-layer shape as slice 5's and slice 3's: a class whose constructor is
deleted from its frozen prototype, membership in a module-private `WeakSet`
rather than `instanceof`, and a single accessor that spends the grant in the
statement that returns its facts.

It binds eleven facts: `taskId`, `host`, `owner`, `name`, `remoteName`,
`headRef`, `headCommit`, `baseRef`, `draft`, `title`, `body`.

`remoteName` is bound because the two questions asked before the request is sent
are local Git ones about that remote. `title` and `body` are bound because a
pull request carries text, so the promise slice 5 could make — that no free text
reaches the network — cannot be made here. The weaker promise that replaces it is
checkable: the request can carry only what the grant holds, and what the grant
holds was composed from four identifiers.

**It cannot substitute for the publication authority in either direction, and
that is a compile error.** Each class carries a private field, so TypeScript
compares them nominally; `tests/v4-06-…` pins both directions with
`@ts-expect-error`, which `tsc --noEmit` checks inside the canonical gate. There
is no supertype, no shared interface, no union and no conversion. There is no
merge authority at all.

### Who may mint it

A fresh delivery decision is **necessary and not sufficient**. The mint is
reached only after: the task is at `READY_FOR_PR`; a publishable head ref and a
sendable base branch exist; `--attended` was given; and *this invocation's own*
`--observe --decide` produced a decision in `ADMITS_CREATION_LADDER`. A stored
slice-3 record has no path into the ladder — the store is read for the report
and is never an input to an authority.

**The gate is a set of five decisions and not the single member
`PULL_REQUEST_REQUIRED`, and that is a deliberate departure from the slice's own
brief.** The brief said to mint only on that member; a review measured what it
produces. `decideDelivery` answers `PULL_REQUEST_REQUIRED` only while no open
pull request has this head, so the moment one exists — the moment after a
successful creation — the second invocation is refused `DECISION_NOT_ESTABLISHED`
and advised to pass the two flags it just passed. `ALREADY_EXISTS`,
`WRONG_BASE_CONFLICT`, `DRAFT_STATE_CONFLICT` and the pre-attempt
`PULL_REQUEST_AMBIGUOUS` were all unreachable from the command: the four answers
an operator most needs, and three operator-facing texts claimed the first of
them was what a second run answers.

So the set admits every decision meaning *this invocation freshly observed this
exact commit's pull-request situation and found no failing check*. Only
`PULL_REQUEST_REQUIRED` means a pull request is needed; the other four mean one
claimed this head at the moment of the observation.

The rule is the same on all five and it is stated once: **a request is issued
only when the ladder's own fresh reading says `NONE`.** That is stronger than
any decision could be, because the decision is one observation older — so on
those four a request normally is not sent, and if the pull request has gone in
between, sending is correct. An earlier version of this paragraph said "nothing
is sent" without the condition, and a confirmation pass found the same
unconditional sentence in three other places.

`CHECKS_FAILED` stays out: a commit whose checks have failed gets no pull
request from this build. So does every decision meaning no fresh, subject-matched
observation exists. That is the smaller rule, and it is deliberate.

### The content

Composed from four identifiers and literals in one file:

```
title: <taskId>: <branch>
body:  Task        : <taskId>
       Head ref    : refs/heads/<branch>
       Head commit : <40-hex>
       Base ref    : <baseBranch>

       Opened by AgentOrchestrator. AO created this pull request and will not
       update, close, reopen, review, comment on, label or merge it. …
```

**The intentional egress is exactly six repository-derived values.** Four are in
the text — the task id, the work-branch name, the base-branch name and the head
object name — and two are in the address: the owner and the repository name,
which slice 1 parsed out of the delivery remote's push URL and which appear in
`repos/{owner}/{name}/pulls` and in the `head` field as `owner:branch`. This
paragraph said "exactly four" until a review counted the wire rather than the
composing module. There is no diff, no `git log`, no commit message, no local
path, no environment, no agent transcript, no finding, no test output. The
task-state record has no title or description field, which is why this is an
identity block rather than a summary.

All six pass a grammar **at the mint**, which runs after the text is composed,
so the text is ASCII by construction once the grant exists. The branch and the
base additionally pass `repo/branch-name.ts` — Git's own `check-ref-format`
rules, capped at 255 characters. That cap is what bounds the body: without it
the two names were unbounded and a long branch composed a body the mint then
refused. The title is cut to 256 bytes with a marked `...` when a long task id
and a long branch compose one over budget; the body budget is 4096 bytes and the
longest composable body is 991 bytes, measured.

### The outcome vocabulary

Closed, twenty-one members, ordered weakest claim first:

`SUBJECT_NOT_ESTABLISHED`, `TASK_NOT_READY`, `OPERATOR_ABSENT`,
`DECISION_NOT_ESTABLISHED`, `AUTHORITY_REFUSED`, `SUBJECT_CHANGED`,
`REMOTE_URLS_DIVERGE`, `REMOTE_STATE_UNKNOWN`, `HEAD_NOT_PUBLISHED`,
`HEAD_SHA_MISMATCH`, `PULL_REQUEST_STATE_UNKNOWN`, `PULL_REQUEST_AMBIGUOUS`,
`PRIOR_PULL_REQUEST_CLOSED`, `WRONG_BASE_CONFLICT`, `DRAFT_STATE_CONFLICT`,
`CREATION_REFUSED`, `OUTCOME_UNCERTAIN`, `POSTCONDITION_MISMATCH`,
`ALREADY_EXISTS`, `CONVERGED_AFTER_UNCERTAIN_EFFECT`, `CREATED`.

Three of them mean the intended pull request is open — one established state
with three provenances — and `pullRequestIsEstablished` is the predicate to ask,
because comparing against `CREATED` alone would send a second request for no
reason.

There is no `else => CREATED`. Every arm returns a named member, and the suite
drives the whole cross-product of readings and attempts to prove the grader is
total.

### The head-ref race, and what this build can and cannot say

GitHub resolves `head` on its own side at the moment it creates. A ref moved
between this build's reading and the request therefore produces a pull request
from **another commit**, which the reading afterwards — keyed on the intended
object name — does not find.

That case is graded `OUTCOME_UNCERTAIN`, not `CREATED` and not a failure. This
build cannot tell it apart from a creation that did not happen, or from a forge
index that has not caught up. Reporting anything more definite would be
inventing a distinction it did not measure. What is guaranteed is the half that
matters: **a pull request whose head is not the intended commit can never be
reported as success.**

### The base-ref race, not overstated

The pull request targets a base **ref**, not a base commit, because the API
offers nothing else. The base branch can move a moment later and nothing here
would notice. Any future slice that acts on merge eligibility has to observe
again; this one makes no claim about it.

## What is not in this slice

No branch push or update, no pull-request update, close, reopen, draft
transition, comment, label, reviewer, review, CI remediation, merge, auto-merge
or merge queue. No task-state transition and no durable record of the creation.
No generic forge-write capability: there is no function taking a method, a URL
or a body from a caller.

## Carried forward, deliberately

- **L-V4-06-1 — two AO processes racing is a residual.** GitHub's uniqueness for
  open pull requests is measured but its atomicity is not documented, and a
  local fence would not help: the object being raced for is on the far side of
  the network, and two clones of one remote are two execution leases.
- **L-V4-06-2 — an uncertain effect stays uncertain until somebody asks again.**
  Timeout, lost boundary and index lag are indistinguishable from here. The
  recovery is an explicit second invocation, which begins with a reading.
- **L-V4-06-3 — the head-ref race can leave a pull request this build did not
  intend.** It is never reported as success and it is never closed or edited in
  response. An operator has to look.
- **L-V4-06-4 — `CHECKS_FAILED` blocks creation.** A red commit cannot get a
  pull request from this build, because checks are graded before the
  pull-request question and `CHECKS_FAILED` is deliberately outside
  `ADMITS_CREATION_LADDER`.
- **L-V4-06-5 — the creation is not recorded.** "AO opened this pull request" is
  not durable anywhere. It is observable from GitHub, and slice 3's record is a
  separate, explicit act.
- **L-V4-06-6 — the base is a ref, not a commit.** See above.
- **L-V4-06-7 — the live dogfood exercised the modules, not the CLI ladder.**
  The same limit as `L-V4-05-6`, for the same reason: driving the command needs
  a production `TaskState` for this repository, and fabricating one to make a
  dogfood pretty would be proving something about a file rather than about the
  product.
- **L-V4-06-8 — every creation outcome exits 0.** The exit code still answers
  only the observation question, as it has since slice 2.
- **L-V4-06-9 — draft is now read but still not decided on.** Slice 4's decision
  does not consider it, so a positive delivery decision can still be true of a
  draft pull request. Only slice 6's own ladder compares it.
- **L-V4-06-11 — this slice's branch grammar is stricter than slice 5's.** The
  mint applies `repo/branch-name.ts` to the work branch and the base as well as
  the shell-inert class, so a name slice 5 will publish can be one slice 6
  refuses. The safe direction, and it is what bounds the composed body — but the
  two gates differ, and `L-V4-05-9` is only half closed. The stricter gate still
  accepts `refs/heads/main` and `HEAD` as a base; GitHub answers `422` for both.
- **L-V4-06-10 — `--publish-head` and `--create-pr` do not compose in one
  invocation on a first delivery.** Measured: the observation runs before the
  publication, so the forge has never seen the commit,
  `commits/{sha}/pulls` answers `422 "No commit found for SHA"`, the decision is
  `OBSERVATION_UNSETTLED`, and the creation is refused *after* the branch has
  been created. The outcome is correct — a branch published and nothing else —
  and the route to it is unhelpful. Publish in one invocation, create in the
  next. Making the two compose would mean observing a second time, after the
  publication, which is a second attestation and a slice-4 contract change.
