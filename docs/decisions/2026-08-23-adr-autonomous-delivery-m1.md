# ADR — Autonomous delivery, milestone 1: the contract, and the first slice

- Date: 2026-08-23
- Status: **Accepted.** The contract below is binding for M1; slice 1 is
  implemented (V4 slice 1, "the delivery target").
- Supersedes nothing. Extends the scope statement in `README.md` §"Not
  implemented yet" and the boundary in `CLAUDE.md` §"CI is development
  infrastructure, not product semantics" — see "What this ADR does and does not
  change about that boundary", below.

## Context

The execution and safety substrate is built. AO can select a task, resolve a
repository, take an execution lease, prepare a workspace, run a contained
writing agent, enforce scope, verify, review, remediate, checkpoint a quota
interruption and resume — attended, and in a bounded automatic form.

It then stops. `READY_FOR_PR` is terminal (`src/core/states.ts`,
`src/core/transitions.ts`: `READY_FOR_PR: []`), and the finished work is handed
to a human, who pushes the branch, opens the pull request, watches CI, and
merges. That hand-off is the last large gap in the single-task lifecycle.

**Autonomous delivery** is the capability that closes it:

```
task work -> verify -> review/remediate -> delivery ready
          -> PR -> CI -> remediation if required
          -> merge -> post-merge observation -> COMPLETE
```

**Amended 2026-08-29, by the M1 release gate
(`2026-08-29-adr-m1-release-gate.md` §8).** This arrow originally read
`-> CI -> review state -> remediation if required`. No slice built a review
state and none was going to: reading a forge's review requirements means reading
branch protection and repository rulesets, and those endpoints answer
identically for "there are none" and "you may not read them". A value derived
from them could not distinguish absence from refusal, which would make invariant
4 below false in the worst way — by giving "review requirements passed" a
representation that is sometimes a permission error wearing a green label. The
arrow is struck rather than left standing as a plan nobody intends to execute.

This ADR does not build that. It writes down the contract the eventual
capability must satisfy, states the non-goals, and records why the first slice
is the one it is.

## What today's record can and cannot say

Established from the code at `c89ef60`, not from plans:

| Question | Answer today |
| --- | --- |
| Is the produced commit durable at `READY_FOR_PR`? | **Yes** — `TaskState.currentCommit`, a full object name, required non-null at that state. |
| The base it was built on? | **Yes** — `basePinnedCommit`, likewise required. |
| The branch? | **Yes** — `workBranch` and `baseBranch`. |
| The repository? | **A declared slug** (`repositoryId`) and a local path (`repositoryRoot`). Neither names a repository on a forge. |
| A remote? | **A boolean.** `ResolvedRemote` carries `present`, and says in so many words that it will not carry a name or a URL — "which would put a host and possibly a credential into a value that gets logged". |
| A pull request, a check, a merge? | **Nothing.** No product module carries a forge concept — the one occurrence of the word in `src/` is a comment naming this repository's own CI workflow — and the only `git remote` call in `src/` computes that boolean. |
| Is `gh` a runtime dependency? | **No.** `KNOWN_PROGRAMS` is `node, npm, git, claude, codex`; the product spawns those and the repository's own verification vector, and nothing else. |
| Network egress? | **One path**, opt-in: the ntfy notification, off unless `~/.agent-orchestrator/notify.yaml` exists. |

So the work is durably identified — the *commit* is unambiguous — and the
delivery *target* is not identified at all.

## The eventual contract

### States

M1 does **not** add task states, and in particular does not give
`READY_FOR_PR` an outgoing transition. That is a product-contract change and it
needs its own decision, taken when there is a delivery step to transition to.

When the vocabulary does grow, the distinctions it must be able to draw are:
work ready for delivery; a pull request's identity; that pull request's **exact
head commit**; the check state **of that exact head**; remediation required;
merge eligibility; the **merged commit's** identity; post-merge verification;
completion. Whether each becomes a state, a field, or an observation is a later
decision — the smallest coherent addition consistent with the existing model
wins, not the longest list.

**Amended 2026-08-29, by the M1 release gate
(`2026-08-29-adr-m1-release-gate.md` §8).** This list originally also required
"a review state where the repository requires one". It is struck for the reason
given at the pipeline diagram above, and invariant 4 is unchanged: it is held
because **no review state is read, and none is implied** — which is a stronger
position than holding it with a state that cannot tell absence from refusal.

### Invariants

These bind every delivery slice. Marked `[held]` where this slice already
discharges them, `[open]` where a later slice must.

1. **A green check for an old head never authorises the current head.** Check
   evidence is bound to a commit object name, never to a branch or a pull
   request number. `[open]`
2. **"A pull request exists" is not "a pull request is mergeable".** `[open]`
3. **"Mergeable" is not "CI passed".** `[open]`
4. **"CI passed" is not "review requirements passed".** `[open]`
5. **A moved head invalidates every piece of evidence attached to the previous
   head.** `[open]`
6. **Ambiguous or unavailable forge state fails closed.** It is never read as
   permission, and never as absence. `[open]`
7. **A merge observes the exact resulting commit identity**, returned by the
   operation and confirmed against the repository. `[open]`
8. **A successful merge API call is not completion.** Post-merge verification is
   its own observation. `[open]`
9. **Delivery authority is separate from execution authority.** Being allowed to
   run a task in a repository is not being allowed to deliver from it. `[held]`
   — a repository declares its delivery target in its own profile, and a profile
   that declares none has nothing asked of Git on its behalf.
10. **No repository gains delivery merely because AO can technically perform
    it.** Capability is not permission; the declaration is. `[held]` for naming
    the target, `[open]` for every action. One honest qualification: because a
    declaration that fails to resolve is data rather than a resolution failure,
    and only the read-only plan renders it, a *misdeclared* target is checkable
    on exactly one surface today (`L-V4-01-5`). The invariant holds — nothing is
    granted — but the declaration's own correctness is not yet enforced anywhere
    a run would notice.
11. **Existing attended/unattended execution guarantees do not widen.** No
    delivery slice may relax the lease, the scope gate, the containment
    boundary or the resume policy. `[held]` — this slice adds one read-only
    local Git query and changes no gate.
12. **Delivery state survives a process restart wherever the architecture calls
    it durable.** The corollary this slice takes: *do not call it durable.* A
    delivery target is re-derived from Git where it is needed, because a pinned
    copy is a claim about a configuration that can change underneath it, and a
    stale delivery target is worse than none. `[held]`

### Non-goals for M1

Automatic merge as a first capability; unattended pull-request creation; a
general risk engine; cross-project scheduling; a recurring scheduler;
notification redesign; POSIX containment; any widening of the writer's
authority. None of these is a prerequisite for naming a delivery target or for
observing one.

## Why the first slice is identity, not observation

The obvious first slice is "read the pull request and its checks". It is not
first, for two reasons, and both are facts about this repository rather than
preferences.

**A read needs a subject.** Every observation of a pull request has to name a
repository on a forge, and no value in this product can. An observation slice
built today would have to *infer* its subject — from the process working
directory, from whichever remote happens to be called `origin`, or from a tool's
own guess — and "wrong repository" is precisely the failure a delivery
controller exists not to have. Identity is not a smaller version of observation;
it is its precondition.

**Observation is a second egress path, and this product has exactly one.** The
opt-in notifier is a documented contract with its own gate, its own bounded
payload and its own real-process test that proves nothing is opened without the
opt-in. Talking to a forge means a second one, and it also means:

- a **new product dependency** (`gh`, or an HTTP client and a token policy) — the
  program allow-list is closed and does not contain one;
- a **new environment policy**, because every existing policy forwards `PATH`
  and `PATHEXT`, plus a profile root for the two probes that read a login. A
  forge client needs credentials, and which variables it may see is an auth
  decision, not a plumbing detail;
- a **new failure surface**: rate limits, partial JSON, an authenticated-as-
  someone-else answer.

Each of those is a decision that deserves to be reviewable on its own. Bundling
them with the identity question would make one slice in which the interesting
part — is this the right repository? — is the part nobody reads.

## Slice 1, as delivered

**The delivery target.** A repository profile may declare `delivery.remote`: the
remote whose **push** URL names where a finished task would be delivered. AO
resolves that remote's URL through the read-only Git seam and turns it into a
`{ host, owner, name }` identity, or into one of a closed set of refusals. The
identity is reported in the read-only run plan. Nothing is pushed, no network is
contacted, and no state is written.

The remote is declared rather than assumed, because `origin` is what `git clone`
happens to call the remote it cloned from — a convention, not a fact about a
checkout, and a checkout may have several remotes, none, or an `origin` pointing
at a fork.

### The measurements it rests on

Measured on `git 2.55.0.windows.3`; each one changes the answer.

| Measured | Consequence |
| --- | --- |
| A remote may carry a push URL distinct from its fetch URL, and a push goes to the push URL. | The vector carries `--push`. Reading the fetch URL names a repository the work never reaches. |
| Without `--all`, `git remote get-url` prints only the **first** of several URLs, exit 0. A push reaches **all** configured push URLs. | The vector carries `--all`, and more than one URL is `REMOTE_URL_AMBIGUOUS`. Dropping `--all` converts an ambiguity into a confident wrong answer. |
| With no push URL configured, `--push` falls back to the fetch URL. | The fallback is the documented behaviour, not an accident. |
| `git remote get-url` applies `url.<base>.insteadOf` / `pushInsteadOf`; it reports the URL Git **uses**, not the one that was typed. | The identity follows the rewrite. Reading `remote.<name>.url` out of the config would report `github.com` for a checkout whose pushes land elsewhere — wrong exactly when it is being lied to. **No host is judged in this build**, so the rewrite is reported rather than caught; carried open as `L-V4-01-2`. |
| A configured URL keeps a **trailing space** through `get-url`. | The reader parses the raw bytes. `.trim()` turns a URL the grammar must refuse into a confident wrong identity. |
| A remote URL preserves user information verbatim, including a bare token as the user name. | Only the literal user `git` is accepted; every other user information is refused, and no part of the URL is carried, logged or rendered. |
| `git-config(5)` lists `\n` among the recognised escapes, and a remote URL may contain one: `get-url --push --all` then prints a single URL across several lines. | **One line is not one URL.** Exactly one trailing terminator is removed and no blank line is filtered, so such a URL stays visible as the extra line it produces and is refused. The first version of this slice asserted the opposite and had a fail-open because of it — found by adversarial review, not by the suite. |
| `branch.<name>.pushRemote` and `remote.pushDefault` select a different *remote* for a push, before any URL is chosen. Measured with two local bare repositories: with `branch.main.pushRemote = fork`, a bare `git push` writes to `fork`. | The slice answers "the push URL of the remote the profile declared", which is narrower than "where a push would go", and says so (`L-V4-01-4`). |

### What it deliberately does not do

It does not push, open, read, merge or contact anything. It writes no durable
field, adds no task state and no transition, and grants no repository anything:
declaring a delivery target makes the target **nameable**, which is the half
that has to exist first.

## What this ADR does and does not change about that boundary

`CLAUDE.md` says that teaching the product to merge, or giving `READY_FOR_PR` an
outgoing transition, is a product-contract change needing its own decision. That
remains exactly true, and this ADR is not that decision: nothing here merges,
and `READY_FOR_PR: []` is unchanged. What this ADR does change is that
"autonomous delivery" is no longer only a direction — it has a written contract,
an invariant list, and a first slice that can be reviewed on its own.

## The next slice, named only

**The delivery observation seam** — a read-only forge client behind an explicit
capability and environment policy, answering, for a named repository and an
exact commit object name: does a pull request exist for this head, and what is
the check state *of that head*. It is the slice that discharges invariants 1–6.

**Delivered** as V4 slice 2 on 2026-08-23. Its own decision record —
`2026-08-23-adr-delivery-observation-seam.md` — carries the forge, egress and
credential contract, the measurements behind it, the restated invariant table
and its residuals `L-V4-02-1..9`. Two things it changed here are worth naming
at this level:

- invariants 1–6 move from `[open]` to `[held]` *for observation*. They remain
  open for every action, because nothing acts;
- slice 1's residual `L-V4-01-2` — "the host is carried, not judged" — is
  decided. The host is judged, against one name, and the judgement gates a
  network destination rather than merely labelling one.

`READY_FOR_PR: []` is still unchanged, and nothing in `src/` merges anything.

**V4 slice 3, durable delivery evidence**, followed on 2026-08-23 —
`2026-08-23-adr-durable-delivery-evidence.md`. It is the first slice to write
something this contract calls durable, and it is the reason invariant 12 above is
worth re-reading: slice 1's corollary was *do not call it durable*, and this
slice does, for one thing only and under a name that says what it is. A stored
observation is a **historical snapshot**, never current truth, and there is
deliberately no time-to-live to blur that. Invariants 1, 5 and 6 hold durably
now rather than only within one process; 7 and 8 remain open, because nothing
still acts.
