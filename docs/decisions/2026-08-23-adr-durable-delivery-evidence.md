# ADR — Durable delivery evidence (V4 slice 3)

- Date: 2026-08-23
- Status: **Accepted.** Implemented as V4 slice 3.
- Extends `2026-08-23-adr-delivery-observation-seam.md`. Adds a durability
  boundary and no authority whatsoever.

## Context

Slice 2 can answer, for one repository identity and one exact commit object
name: is there exactly one open pull request whose head is this commit, and what
is the check state of this commit. Then the process ends and the answer is gone.

A later merge-policy slice needs to distinguish two situations that are
currently indistinguishable:

```
"AO has never observed this"
"AO observed this exact pull request, head and check state at time T"
```

This slice builds that distinction and stops there. It does **not** decide that
the evidence is sufficient for anything.

## The rule the whole slice hangs on

**A durable observation is a historical snapshot. Persistence does not freeze
GitHub.**

At 14:00 the record may say `checks SUCCESS`. At 14:01 a new check can start, an
existing one can fail, the pull request can close, the head can move, a
force-push can land, or the repository's review requirements can change. The
bytes on disk know none of it.

```
STORED SUCCESS      is not  CURRENT SUCCESS
STORED PR MATCH     is not  CURRENT PR MATCH
A RECENT TIMESTAMP  is not  FRESHNESS
```

`observedAt` is evidence of **when** the forge was asked. It is not evidence
that the answer remains true.

### There is no TTL, and that is a decision

A time-to-live would be an invented number presented as safety. It would license
acting on a stale answer for as long as somebody guessed, and refuse a
still-correct answer the moment the guess expired. Neither behaviour is
derivable from anything GitHub tells us. Nothing in this build compares
`observedAt` against a threshold, and a test asserts the code contains no such
comparison — scanned with comments stripped, so this paragraph can go on
existing.

### Three states, and only two are decidable from bytes

| | Decided how |
| --- | --- |
| **A. Structurally valid historical evidence** — parses, known version, belongs to this task, names the expected target and exact subject, internally consistent | offline, from bytes |
| **B. Locally stale or mismatched** — the task moved, the target re-resolves elsewhere, the version is unknown, the record contradicts itself | offline, from bytes |
| **C. Remote freshness unknown** — AO has not freshly asked GitHub | not decidable at all |

**C is deliberately not a member of the reading vocabulary.** It is not a
reading a file can produce: it is true of *every* reading, always, including the
good one. Making it a member would let a caller `switch` past it and would imply
some other reading has freshness. None does. It is a sentence in the operator
report instead (`REMOTE_FRESHNESS_SENTENCE`), printed whenever historical
evidence is shown.

The good reading is named `HISTORICAL_VALID` — never `VALID`, never `CURRENT`.
No exported function is named or documented as answering "what is true now", and
a test refuses any export matching `current|fresh|isGreen|isPassing|approved`.

## Where the record lives

`<repositoryRoot>/.agent-orchestrator/runtime/<taskId>.delivery.json`

A companion beside the task-state file it is bound to, published through the same
crash-safe primitive: stage in the same directory, flush, close, one `rename`
(`state/atomic-file.ts`). One latest snapshot per task; a later observation
replaces it.

### Rejected alternatives

| Alternative | Why not, from the code |
| --- | --- |
| **A field on `TaskState`** | Writing it needs `advanceTaskState`, which requires a **held execution lease re-proved at the moment of the write** (`state/advance-state.ts`). `delivery` holds no lease, and taking one would turn a read-only command into an executing one that contends with a run for the repository. The schema is also `.strict()` with a shared 1 MiB budget, and a `READY_FOR_PR` write must satisfy that state's whole invariant block. |
| **Inside the execution lease, or either lease companion** | Wrong key. The lease is per *Git administrative identity* (`git-common-dir`), not per task, and both companions bind to `ownerNonce`/`runId`, which a delivery observation has no relationship to. `execution-lease.ts` already refuses adding a second contract to an existing companion for this reason. |
| **A third file in the Git common directory** | Same key mismatch, and `.git/` does not travel when a repository is copied or archived. |
| **The block ledger** | Keyed on `runId`; its entry shape is closed and evidence-gated field by field; a delivery fact has no disposition to prove. |
| **`~/.agent-orchestrator/`** | Per machine, not per repository. `state/state-location.ts` states the opposite requirement: copy the repository and the record comes with it, delete it and it goes, and two checkouts never share one. |
| **A doctor-style per-run directory** | Append-only with no retention policy and nothing ever deleted. It answers "what happened in run X", not "what does AO know about task T". |
| **An append-only event store** | Nothing asks a question it would answer. A superseded observation about a commit that has moved reads `LOCAL_BINDING_MISMATCH` whether it is one record or the newest of fifty, and a log would add retention, compaction and a size budget to answer nobody's question. |

### The ignore hazard this location creates, and how it is closed

The runtime directory is inside the target repository, so an un-ignored file
written there makes the checkout dirty and the *next* run refuses with
`SOURCE_WORKTREE_DIRTY`. `state/runtime-ignored.ts` exists for exactly that, and
runs before the first task-state write — but it asks about two names,
`<taskId>.json` and its staging probe, and this slice creates two more.

Most rules covering those two cover these. Not all: a rule written as
`.agent-orchestrator/runtime/<taskId>.json*` ignores both names the existing
check asks about and neither of the names here. Narrow, constructible, and the
cost of being wrong is a repository that stops being runnable for a reason
nothing points at.

So the record asks, about the names it really writes, before writing anything —
through `askRuntimeIgnored`, a partial application of the existing check rather
than a second opinion about Git's rules. Two calls rather than two arguments,
because `check-ignore` ORs its arguments. `NOT_IGNORED` and `UNDETERMINED` are
kept apart and both refuse.

## Provenance

`DeliveryObservationProof` — a `WeakSet`-registry mint, the pattern this
codebase already carries four times, built at the end state rather than walking
the path that defeated the earlier ones: registry membership rather than
`instanceof`, `WeakSet.prototype.has` captured and bound at module load, one
`#private` field, `constructor` deleted from the prototype, class and prototype
frozen, and a safe accessor that returns `null` rather than throwing.

Minted in one place, from one call site (`attestDeliveryObservation` in
`observe-delivery.ts`), and only for an observation that settled **both**
questions. The mint re-derives settledness itself rather than believing its
caller.

**What it proves:** ordinary product code cannot manufacture a successful
forge-observation claim without going through the recognised observation
boundary.

**What it does not prove**, stated without flinching:

- nothing against a caller that imports the mint — anyone who can import it can
  call it;
- nothing against the filesystem. The binding digest is an **integrity binding,
  not a MAC**: every input to it is derivable by anyone who can read the
  repository, so **anyone who can create a file in the runtime directory can
  write a record that reads `HISTORICAL_VALID`**, having observed nothing. What
  the digest catches is a record copied between tasks, a field edited without
  recomputation, and a record written by a build that disagrees about the
  payload;
- nothing about freshness, at any age.

This is exactly why the record may never be read as authority.

## The record contract, version 1

Bound to the task, the target and the exact subject. Its own
`DELIVERY_EVIDENCE_VERSION`, separate from the task-state version, because an
unknown evidence version must still leave the *task* readable.

- **task/local subject** — `taskId`, `repositoryRoot`, `taskState`,
  `stateRevision`, `subjectCommit`, `basePinnedCommit`
- **target** — `provider: 'github'` (a literal), `host`, `owner`, `name`,
  `declaredRemote`
- **pull request** — `pullRequestOutcome`, `pullRequestNumber`,
  `pullRequestHeadSha`
- **checks** — `checkQueriedCommit`, `checkOutcome`, six counts
- **provenance** — `evidenceVersion`, `observedAt`, `recordedAt`, `binding`

`stateRevision` is the strongest local invalidator this repository ships: a
SHA-256 over the exact task-state bytes, used the way `block/block-evidence.ts`
uses `evidenceRevision`. *Any* change to the task's durable record invalidates
evidence derived from it, without this module having to enumerate which fields
would have mattered.

Three cross-field invariants are enforced, because a schema that accepted each
field individually would accept a record describing something that cannot have
happened: a `MATCHED` record must name a pull request and its head must be the
subject commit; a non-matched record must carry neither; and the check answer
must be about the subject commit.

### What is deliberately absent

No token, no `Authorization` header, no raw `gh` output, no stderr, no exit code,
no URL of any kind, no environment snapshot, no arbitrary GitHub JSON. Not
enforced by a filter but by the shape: the only way to build the payload is from
the proof's facts, which have no field any of those could travel in.

No branch name either. A branch is a mutable pointer, and a record identifying
its subject by one would make exactly the claim slice 2 was built to refuse.

## Negative observations — the decision

**Persist exactly the settled observations**, whatever the answers were:
`MATCHED`, `NO_MATCHING_PULL_REQUEST`, `AMBIGUOUS`, and `SUCCESS`, `PENDING`,
`FAILED`, `NO_CHECKS`. Each is an answer — the forge was reached and the
question was settled.

**Refusals are never persisted.** `NOT_AUTHENTICATED`, `REQUEST_FAILED`,
`RESPONSE_MALFORMED` and the rest have no representation in the schema at all. A
refusal is not a weaker observation to be written down with a caveat; it is the
absence of one, and its honest durable form is no record.

That line is the natural boundary — "an observation happened and was answered" —
rather than symmetry for its own sake. And every stored negative is labelled
historical by the same vocabulary as every stored positive: `NO_CHECKS at T` is
not `NO_CHECKS now`, and the report says so in the same sentence it says it
about `SUCCESS`.

## Write authority

```
agent-loop delivery --repository <path> --task <id> [--observe] [--record]
```

- plain `delivery` stays local and writes nothing;
- **`delivery --observe` stays read-only** — slice 2's contract had to remain
  literally true;
- `--record` without `--observe` refuses, contacts nothing and writes nothing;
- `--record` with an unsettled observation refuses and writes nothing;
- the writer takes the **minted proof**, not the observation, so a caller cannot
  manufacture evidence by handing over a plain object;
- the writer compares the proof's subject against the task's own, so a *real*
  observation of one commit cannot be filed against a task pinning another.

The invocation grant (`--attended` / `--automatic-resume-only`) is deliberately
**not** reused. Its semantics are execution authority, which is broader than
"record delivery evidence", and reusing it would tie a local write to a lease
this command does not hold. `--record` is a legal option name under the
repository-wide ban on `force|unattended|adopt|takeover|steal`.

Reading needs no proof at all, and that is correct: a fresh process has an empty
registry, and requiring a mint to *read* would make every record unreadable
after the process that wrote it exits.

## Invariants, against M1

Nothing moves from `[open]` to `[held]` here, because nothing acts. Two are
worth restating:

| # | Invariant | Status |
| --- | --- | --- |
| 1 | A green check for an old head never authorises the current head | `[held]`, and now durably: a record binds to a commit object name in four places, and a task whose commit moved reads `LOCAL_BINDING_MISMATCH` |
| 5 | A moved head invalidates evidence attached to the previous head | `[held]` — and this is the first slice where there *is* attached evidence to invalidate |
| 6 | Ambiguous or unavailable forge state fails closed | `[held]` — a refusal has no durable representation, and every unreadable record reaches a refusal rather than absence |
| 12 | Delivery state survives restart where called durable | `[held]` — this is the first thing called durable, and it is called a historical snapshot rather than state |

`READY_FOR_PR: []` is unchanged. No transition was added, no lease is taken, no
agent is dispatched, and nothing in `src/` merges anything.

## Residuals

- `L-V4-03-1` — **the record is not tamper-proof and is not offered as such.**
  Anyone who can create a file in the repository's runtime directory can write
  one that reads `HISTORICAL_VALID`. The mint bounds *product code*, not the
  filesystem. A later slice that needs more needs a different mechanism, not a
  stronger reading of this one.
- `L-V4-03-2` — **one snapshot per task, so nothing counts observations.** "AO
  has observed this task three times" is not a question this record can answer,
  and a failed write leaves the previous record standing with no reader able to
  tell that from a record deliberately kept. The same residue class the
  containment record carries.
- `L-V4-03-3` — **the ignore check is asked at record time, not at run start.**
  A repository whose ignore rules change between the record and the next run is
  not re-checked, and the record already written is not removed.
- `L-V4-03-4` — **`AMBIGUOUS` is stored without its claimants.** The outcome is
  durable; which pull requests claimed the head is not. Nothing needs them yet,
  and an array in the payload is the one field that could grow unbounded.
- `L-V4-03-5` — **the non-`ENOENT` open branch is proved through an injected
  seam, not a real failure.** Measured on Windows: `openSync` on a *directory*
  succeeds and reports size 0, so the obvious fixture never reaches that branch.
  A real `EACCES` cannot be provoked on demand here.
- `L-V4-03-6` — **`recordedAt` is not compared with `observedAt`.** A record
  whose write instant precedes its observation instant is accepted. Both are
  written by the same invocation from the same clock, so the disagreement would
  mean a clock that moved backwards, and this build has no answer for that
  better than storing what it was told.

## The next slice, named only

**Delivery state, or merge eligibility** — the first slice that would *decide*
something from evidence rather than record it, and the first that would need
`READY_FOR_PR` to gain an outgoing transition. It is not started, and it needs
its own decision: what a fresh observation must establish, what a stored one may
contribute, and what a human still has to say. This slice deliberately makes
none of those easier to skip.
