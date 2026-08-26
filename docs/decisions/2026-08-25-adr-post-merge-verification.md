# ADR — post-merge verification of the exact reconciled merge commit

**Date** 2026-08-25
**Status** accepted
**Slice** V4 slice 9
**Supersedes** nothing. **Superseded by** nothing.

## The decision

AO gains one new capability: **run the repository's canonical verification
profile against the exact merge commit a task's slice-8 merge receipt names, and
durably classify the result.**

The subject is `receipt.mergeCommit` — call it **M** — and there is no other
route to it. Not a commit an operator names, not the tip of the base branch, not
`origin/main`, and not the task's own `currentCommit`.

One new durable record, written to

```
.agent-orchestrator/runtime/delivery-verification/<taskId>.json
```

`TaskState` is not extended. `READY_FOR_PR` stays terminal. The transition table
is unchanged. The block ledger is not written. The slice-8 merge receipt is not
modified. Nothing is sent to github.com.

The sentence the record carries is:

> At time T, commit M completed verification profile P, with result R.

## H, S and M are three different objects, and this was measured

The reason this slice exists at all is that a green pull-request check is not
evidence about the commit a merge produced. That is usually argued from first
principles. It was instead **measured on this repository**, on pull request #63 —
the one that delivered slice 8 — immediately before this slice was written.

| | object name | what it is |
| --- | --- | --- |
| **H** | `735eab7edf58dc04d980b0242bcf485085d36d6a` | the implementation head |
| **S** | `c51d4425cf9f91fb8c88ca2c6a3792ab2b5f27d3` | GitHub's synthetic pull-request merge commit |
| **M** | `e20314367faa9cb66eec4ba4ca326ebc9f32672a` | the squash merge commit |

`.github/workflows/verify.yml` runs `actions/checkout@v4` with no `with:` block
at all, so the repository itself says nothing about what a run checks out. The
runner's own log for the check-run associated with head H says it exactly:

```
git fetch … origin +c51d4425…:refs/remotes/pull/63/merge
git checkout --progress --force refs/remotes/pull/63/merge
HEAD is now at c51d442 Merge 735eab7… into 309e5e6…
```

Meanwhile the check-run API reports, for those same two jobs:

```
{"name":"verify (windows, node 22)","conclusion":"success",
 "head_sha":"735eab7edf58dc04d980b0242bcf485085d36d6a"}
```

So the forge **attached** the run to H while the runner **built** S. Neither is
M. And after the merge, `git fetch origin refs/pull/63/merge` answers
`couldn't find remote ref` — S is not retrievable at all, so a claim resting on
it could not even be re-checked.

The general statement, which is what the code depends on: **`head_sha` is what
the forge attached to a run, and nothing AO reads reports what a runner actually
checked out.** Association is self-declared.

Two consequences are written into the code rather than into this document:

- `deliver/verify-merge.ts` runs the gate itself and reads no check state. A
  test asserts that it, and every module beside it, contains none of
  `statusCheckRollup`, `check-runs`, `workflow`, `conclusion`, `head_sha` or a
  forge runner type **in its code** — the scan strips comments first, which is
  what lets this document's own measurement be quoted inside those files. A
  positive control on file length stops an emptied file passing by silence;
- the proof artefact cannot be minted unless the **proved workspace HEAD equals
  the commit being attested**, so a verdict produced anywhere else has no
  representation.

A caution worth stating, because it is the trap: for pull request #63,
`tree(H) == tree(M)`. That is a property of *this* merge — the base had not
moved — and not of merges. A squash onto an advanced base produces a different
tree, and that is precisely the case post-merge verification exists for.

## What was reused, and what had to be built

The rebaseline found the verification engine already fully parameterised, and
the workspace primitives not.

**Reused unchanged.** `verify/run-verification.ts` takes
`{ worktreePath, verification }` and a **required** runner. It is coupled to no
task, no branch, no commit, no lease and no `TaskState` — `grep currentCommit
src/verify/` returns nothing. So slice 9 adds no second verification engine; it
calls the existing one with a different directory. Likewise
`worktree/commit-probes.ts` already answers "is this object here", and
`deliver/merge-reconciliation-store.ts` already loads and validates the receipt.

**Built, because it did not exist.** Three things, and each was checked against
the existing primitive before being written:

1. **a detached, exact-SHA workspace.** Before this slice, `git worktree add`
   appeared once in `src/`, with `-b`, and `--detach` appeared nowhere. (Stated
   in the past tense on purpose: in the tree that ships this document both are
   false, because this slice is what changed them. A review caught an earlier
   version asserting it in the present.) `prepareTaskWorkspace`
   cannot be borrowed: it aims at `ao/task/<taskId>` and
   `<root>.worktrees/<taskId>` — the branch and directory the delivered task
   already occupies — and requires the source checkout to be on the default
   branch and clean;
2. **a branch-free HEAD proof.** `verifyWorkspaceMatches` performs exactly the
   right four-fact check and then requires `symbolic-ref --short HEAD` to equal
   a task branch, so a detached HEAD is `BRANCH_MISMATCH` *by design*;
3. **a verification-profile identity.** No profile digest, revision or hash
   exists anywhere in `src/`; `schemaVersion` is the profile's only versioning
   and it does not change when a command does.

## The execution lease is required, and that was not a choice

Post-merge verification is the first delivery act that **starts the repository's
own build and test commands**. Two existing contracts settle its authority, and
neither of them left room for a preference:

- `loop/leased-spawns.ts` names `git worktree add`, `git worktree remove` and
  `git branch -d` as productive spawns fenced by `verifyExecutionLeaseHeldFor`
  *immediately before the effect*. A verification workspace is a worktree of the
  primary clone; its administrative state lives in the Git common directory,
  which is the lease key;
- `tests/v2-07l-execution-lease.test.ts` makes `loop/leased-spawns.ts` the
  **only** value importer of `verify/verify-command.js`. The only way to obtain
  a production `VerificationRunner` is `leasedVerify`, which demands an
  `ExecutionLeaseAuthority`. Running the gate without a lease would mean
  amending a structural pin, not skipping a formality.

So `delivery --verify-merge` takes the lease for the whole attempt and gives it
back once, in a `finally` covering every path out including a throw. Every other
`delivery` flag still takes none, and that asymmetry is now explainable in one
sentence: this is the only one that executes repository-controlled code.

It takes **no grant**. A grant authorises one irreversible effect and is spent by
claiming it. Running a gate is neither irreversible nor something a second run
would duplicate — and the re-run semantics below depend on being able to try
again.

`--attended` is *not* required, and that is deliberate rather than an omission.
`--attended` is this build's marker that a person is present for an irreversible
effect **outside this machine**, and this flag has none. Making it mean "a person
is present for anything expensive" would make the marker mean two things.

## Why the workspace is its own thing, and how it is owned

`<parent of root>/<basename>.verification/<taskId>`, a sibling of the repository
and deliberately **not** inside `.worktrees`. Sharing that directory would put
two kinds of workspace, with two lifetimes and two ownership proofs, under one
name — and the first cleanup to confuse them would delete a task's work.

`remove-workspace.ts` proves ownership from the branch: the registration at the
derived path must hold the derived branch, inside the reserved namespace. That
statement is unavailable here, and its absence is load-bearing rather than a
weakening. It is replaced by three parts, all required before anything is
deleted:

1. the path is **re-derived** from the repository root and the task id — there
   is no path parameter, so a caller cannot name one — and sits under the
   reserved suffix;
2. Git's own registry lists **that exact path**; a directory that merely looks
   like a checkout is not one;
3. the registration is **detached**. A worktree there holding a branch is not one
   this module made, and is refused rather than removed.

Creation refuses outright if anything occupies the path (`WORKSPACE_PATH_OCCUPIED`).
It is never adopted, cleaned or re-pointed, because each of those would mean
running a gate in a tree whose contents this call did not establish.

### `--force` is present here, and absent next door

This is the one place slice 9 relaxes something a sibling module refuses, so it
is argued rather than asserted, and it was **measured**:

| what is in the workspace | plain `git worktree remove` |
| --- | --- |
| nothing | removes |
| ignored build output (`node_modules/`, `dist/`) | **removes** |
| a modified tracked file | refused — `use --force to delete it` |
| an untracked, non-ignored file | refused — same |

`remove-workspace.ts` refuses force because a task workspace holds **an agent's
uncommitted work**. This directory holds nothing but what a gate this process
started produced minutes ago. And AO does not get to decide which column a
repository's declared gate lands in: this repository's own `npm run verify`
regenerates into the tracked `schemas/` directory.

So the alternatives were a forced removal or a full checkout leaked on disk after
every run. What bounds the force is not its absence but the proof in front of it,
and that proof is **re-run in full** before the forced attempt, because the plain
attempt was a subprocess. The two endings are reported apart: `REMOVED_FORCED` is
how an operator learns their gate dirties the tree it runs in.

## The result vocabulary, and the line that must not blur

Three outcomes, and they are `verify/run-verification.ts`'s own three renamed for
a durable record rather than a second opinion about them:

| record outcome | report verdict | means |
| --- | --- | --- |
| `VERIFIED_PASS` | `PASSED` | every declared phase ran and exited 0 |
| `VERIFIED_FAIL` | `FAILED` | a phase ran to its own end and said no |
| `VERIFICATION_NOT_ESTABLISHED` | `UNAVAILABLE` | no phase reached a verdict |

**An infrastructure failure is not a code failure.** A process that could not
start, a timeout, a flooded output budget, a kill from outside, a refused argv —
all of them are `VERIFICATION_NOT_ESTABLISHED`. Reporting any of them as
`VERIFIED_FAIL` would tell an operator their merge is broken when what broke was
the machine, and this repository has measured that failure mode more than once: a
busy workstation produces timeouts with zero assertion failures.

That list is exactly `runVerification`'s `UNAVAILABLE`, because that is the only
thing the outcome is derived from. A workspace that could not be created and a
lease that could not be taken are **not** on it: they never reach the mint, so
no record with any outcome is written for them. The run reports the ladder's
`WORKSPACE_NOT_ESTABLISHED` and writes nothing — a review measured an earlier
version of this paragraph describing a value the code cannot produce for those
two causes.

The timeout is the existing one — `VERIFICATION_COMMAND_TIMEOUT_MS`, 30 minutes
per command, sized for a cold `npm run verify` on Windows. Nothing here loosens
it, and hitting it is a terminal fact about that run rather than the start of a
retry.

## The profile identity

`verificationProfileDigest` is a domain-separated SHA-256 over
`ResolvedVerificationPolicy` — the ordered phase list, each phase's name and each
phase's argument vector, token by token, hashed as pairs so a phase name and a
command token cannot swap places and collide. Order is part of the identity
because `runVerification` stops at the first phase that does not pass, so
`[BUILD, TEST]` and `[TEST, BUILD]` are different gates that can disagree.

It identifies **the contract**, and deliberately not the toolchain. It does not
cover the Node version, `node_modules`, `dist/` or `PATH`. A digest claiming to
identify those would be a promise this process cannot keep: `npm run verify`
reaches an arbitrary tree of scripts, and any summary of that is either a lie or
a re-implementation of a package manager. The honest boundary is that a stored
result is evidence about **one run of one contract at one instant**, never about
the machine.

## Why the record is a history, and not one fact

The merge receipt is **monotonic**: "pull request #N was merged from H producing
M" was true the instant the forge said so and stays true, which is why slice 8
can refuse every contradictory rewrite and be right to. A verification verdict is
not like that. It is a measurement of a run.

Each of the three obvious shapes fails for its own reason:

- **one immutable record** (slice 8's shape) lets the first infrastructure
  failure poison the task permanently: every honest re-run afterwards is refused
  as conflicting, and the operator has a durable `VERIFICATION_NOT_ESTABLISHED`
  they can clear only by deleting the file by hand;
- **latest wins** (slice 3's shape, and it says so) lets a later pass silently
  replace an earlier fail at the same commit under the same profile — exactly the
  contradictory overwrite this slice must not perform;
- **attempt files plus a pointer** needs two files to move together, and
  `state/atomic-file.ts` replaces one file atomically and claims nothing about
  two. A design needing a transaction AO does not have is wrong on the first
  interruption.

What is left is a **bounded append-only history in one file**. Every attempt is
kept, in order; the existing attempts are carried forward and exactly one is
appended; the file is replaced atomically as a whole. Nothing is overwritten and
nothing is silently dropped — when the history reaches
`MAX_VERIFICATION_ATTEMPTS` the next attempt is **refused** with
`ATTEMPT_HISTORY_FULL`, because making room means deleting the evidence most
likely to disagree with the newest.

Stated as what it is and not more: this is **read-before-write, not a
transaction**. Two invocations racing on one task can both read and both append,
and the second replace wins — losing a record of a run. It is bounded by the
lease each of them must hold to have run anything at all.

## Re-runs, and why a stored pass is not a current one

A successful attempt for **exactly this commit under exactly this profile
digest** converges without running the gate again, and is reported as
`ALREADY_VERIFIED`.

The name is the argument. It means *a historical successful verification record
exists*, and never *M is verified now* — the same distinction slice 3 draws about
its own stored observation. A different profile digest is a different question
and **is** run.

There is **no TTL**, and age is never a reason to set a result aside. A
verification does not become wrong by getting old. A profile mismatch is a
*structural* reason the old result does not answer the new question, and this
build accepts only structural reasons.

The stated limit: this build offers no way to force a fresh run for a commit and
profile that already passed. That is a deliberate v1 boundary, not an oversight —
adding one is a flag with its own authority question, and it belongs to whichever
slice needs it.

## What a pass does not mean

Four sentences, carried in the record's own header and printed beside every
result:

1. **not** that M is currently on the base branch. Pull request #61 in this
   repository is merged forever, its base branch answers `404`, and its merge
   commit is an ancestor of nothing;
2. **not** that M is currently reachable from the base. A revert, a force push or
   a reset changes reachability and changes nothing here;
3. **not** that the merge is unreverted;
4. **not** that the base branch passes today. A later commit is a different
   subject and needs its own run.

And a fifth that belongs to the task rather than the commit: a pass does not make
the task complete. `currentCommit` stays **H**, `resultCommit` stays **H**, and
the verification result attaches to **M**. Those are three distinct concepts and
the test file pins all three against a real task-state file with a really settled
block-ledger entry, byte for byte, with negative controls beside each so the
assertions are instruments rather than restatements of a default.

## What a failure does not do

Nothing. A `VERIFIED_FAIL` is reported and recorded. It does not revert, reopen a
pull request, create a repair branch, start an agent, open an issue, create a
follow-up task, merge anything or modify the base branch.

A post-merge failure has serious policy implications and deserves a decision of
its own. This slice deliberately does not make it.

## Commit availability

If M is not in the local object database the run stops with
`MERGE_COMMIT_UNAVAILABLE` and **nothing is fetched**.

There is no `git fetch` anywhere in `src/` today. Introducing the first one would
be a new network egress surface with its own authority question — this command
already has an explicit gate saying that contacting a forge is never implicit —
and it is a slice of its own rather than a step inside this one. The smallest
honest answer is to stop and say the object could not be confirmed — not that it
is absent, which is more than the probe establishes and is what `L-V4-09-11`
records. The operator fetches and runs again.

What it must never do, and does not: substitute `origin/main`, the latest remote
head, or anything else for the object it was asked about.

## Alternatives considered and rejected

**Read the pull request's check state and record that.** Rejected on the
measurement above: the association is self-declared, the run built S, and S is
unretrievable afterwards. It would put AO's strongest verification sentence on
top of a claim nothing can re-check.

**Run GitHub Actions on M and read the result.** Not chosen. It would require
proving a remote run's own checked-out SHA, which nothing this build reads
reports, and it would make the product's verification depend on a forge. Left
open as a possible transport for a later slice, on the condition that the run's
own checkout is proved rather than associated.

**Accept `--commit <sha>`.** Rejected. It changes the contract from *verify this
task's reconciled delivery* to *execute an arbitrary repository commit an
operator supplied*, which is a different authority surface entirely.

**Extend the merge receipt with verification fields.** Rejected. Reconciliation
and verification are two facts with different failure and retry semantics: the
first may exist while the second has never run, failed, been interrupted, or
later passed under another profile. Forcing those histories into one replaceable
document would also make slice 8's immutable record mutable.

**Verify `main` after the merge.** Rejected, and it has its own invariant in the
code. The base moves: after the receipt records M it may advance to X and then Y,
or be force-pushed away from M entirely. A verdict about Y says nothing about
whether M passed.

## Live dogfood: why there was none

Slice 9 was **not** dogfooded against the real merge commit of pull request #63,
and the reason is a product one rather than a limitation.

The verification subject must come from a legitimate slice-8 merge receipt, and
no receipt exists for that delivery: `.agent-orchestrator/runtime/` in this
repository is empty and `.agent-orchestrator/tasks/` holds no task. Pull request
#63 was merged by a human under this repository's own pull-request policy, from
no AO task and no `TaskState` at `READY_FOR_PR`. Manufacturing a `TaskState` and
a receipt to enable a demonstration would be fabricating exactly the evidence the
slice exists to require, so it was not done.

What was measured instead is the whole mechanism against real Git: the test file
builds real repositories, takes real execution leases, creates real detached
worktrees, and asserts HEAD from inside the running gate's own working directory
— including the case where the base has advanced twice past M since the receipt
was written.

**Zero GitHub mutations were performed for this slice's research.** Every
measurement of the CI model above is a read.

## The counter-proof, and why fifteen mutants survive

67 mutants against a baseline the lab proves green before applying anything —
a red baseline reports every mutant killed and measures nothing. 52 killed, 15
survived, **0 harness failures**, and every survivor is classified rather than
counted.

Nothing here is an unkilled defect. Each survivor is a guard that is unreachable
while something else stands, and five of them are **demonstrated** to be pairs by
a companion mutant that removes both halves and dies:

| survivors | why unreachable alone | companion that dies |
| --- | --- | --- |
| `M05`, `M06` — the store's two subject comparisons | the mint guarantees `workspaceHeadCommit === mergeCommit`, so either line refuses everything the other would | `M05b` removes both |
| `M27`, `M27b` — the two version gates | the parse-time gate refuses a foreign contract before the post-parse one is reached | `M27c` removes both |
| `M34`, `M34b` — the two `check-ignore` gates | the staging-name gate fires first and hides the record-name gate | `M34c` removes both |
| `M38` — the lease read before the destructive spawn | the classifying read one line earlier already refused | `M38c` removes both |
| `M57`, `M58`, `M59` — the workspace and ladder passing `observedHead` | on the success path the proof has *already* established equality, so substituting the expectation is unobservable | `M59b` — the same substitution on the **mismatch** path, where the two differ, and it dies |

The last row is the one worth reading twice, because it is the fix three review
lenses found. The mint's refusal is not decoration and is not a tautology: the
value it compares is Git's own `rev-parse` answer, and `M59b` proves that by
substituting the expectation on the one path where the two are different. What
is *unobservable* is the substitution on a path the proof has already gated —
which is what defence in depth looks like from a mutation harness.

The rest are unreachable by construction, and each says so in place:

- **`M09`** — the ladder's `stored.reading !== 'HISTORICAL_MERGE'` test.
  `loadMergeReconciliation` returns a non-null receipt on that reading and no
  other, so the `receipt === null` half already refuses everything;
- **`M36`** — the store's read-back-before-write. The document is assembled from
  values that have just been validated, so this build cannot construct one it
  would refuse;
- **`M48`** — the containment test on the derived workspace path. No fixture
  uses a repository root for which it fires. It is **not** true that the path is
  outside the repository by construction, and an earlier version of this bullet
  said so: measured at this head, a root of `C:\a\.` derives
  `C:\a\..verification\<taskId>`, which the imported `isContained` reports as
  contained — which is the gate doing its job on a root a person could plausibly
  pass;
- **`M46`, `M60`** — the ownership and lease re-proofs in front of the *forced*
  removal. Both exist for a window between two subprocesses, and no fixture can
  change the world inside it.

Two things the lab does that a count alone would not:

- it proves **each edit landed** before running the suite, so a mutation that did
  not take cannot score a free kill;
- it runs a **wider control set** on every survivor, so a mutant caught only by
  an unrelated gate is reported as `KILLED_ELSEWHERE` rather than as this
  slice's mechanism working. That column is zero here.


## Residuals

- **L-V4-09-1** — the store is read-before-write, not a transaction. Two
  invocations racing on one task can each append and the second wins, losing a
  record of a run. Bounded by the lease; documented rather than fixed.
- **L-V4-09-2** — no way to force a fresh run for a commit and profile that
  already passed. `ALREADY_VERIFIED` is terminal for that pair.
- **L-V4-09-3** — `MERGE_COMMIT_UNAVAILABLE` is terminal. AO will not fetch the
  object; there is no fetch in `src/` and adding one is a separate authority
  question.
- **L-V4-09-4** — the profile digest identifies the contract, not the toolchain.
  Two runs of the same profile on differently-provisioned machines are
  indistinguishable in the record.
- **L-V4-09-5** — a repository whose declared gate needs an install step will
  report `VERIFIED_FAIL` in a fresh workspace, because the gate really did run
  and really did exit non-zero. That is truthful under this slice's contract and
  is a property of the *profile*, which should declare the step it needs. This
  repository's own single `VERIFY` phase presupposes an installed
  `node_modules`.
- **L-V4-09-6** — `ATTEMPT_HISTORY_FULL` is terminal for a task. There is no
  archive and no rotation.
- **L-V4-09-7** — no live product dogfood was possible; see above.
- **L-V4-09-8 — the exit code does not report the verification verdict.** It is
  computed from the observation conclusion, so a `VERIFIED_FAIL`, a refused
  write and a leaked workspace are none of them visible in `$?`. The one thing
  that *can* override it is the execution lease, under the repository-wide rule
  in `run-exit-codes.ts`. This entry was missing from this list while
  `README.md` carried it — a numbering gap a review found.
- **L-V4-09-9 — on Windows a verification killed from outside is recorded as
  `VERIFIED_FAIL`.** The classification follows `runVerification` exactly, and
  that reaches `UNAVAILABLE` for a termination only when the runner reports a
  *signal*. A review measured a `taskkill /F`-ed phase arriving as `COMPLETED`
  with `exitCode: 1` and `signal: null` — indistinguishable from a suite that
  ran and said no. It is an accepted limit of what the platform reports, not a
  choice this slice made, and it is not papered over: a heuristic that guessed
  "exit 1 might be a kill" would misread real failures as infrastructure, which
  is the more expensive mistake.
- **L-V4-09-10 — the workspace ownership proof establishes shape and location,
  not authorship.** Re-derived path, registered by Git, detached. A detached
  worktree an operator registered at `<repo>.verification/<taskId>` themselves
  satisfies all three and would be removed. Nothing outside that reserved,
  derived path is reachable — there is no path parameter — which is the
  guarantee that matters; establishing authorship would need a marker inside a
  directory the removal is about to delete.
- **L-V4-09-11 — `MERGE_COMMIT_UNAVAILABLE` covers "could not tell".**
  `commitObjectPresent` answers `null` both for an object Git says is gone and
  for a question it refused to evaluate. This build reports one member for both,
  because what follows is the same either way; it deliberately does not assert
  the object is absent.
- **L-V4-09-12 — a repository whose path is not shell-inert cannot be verified.**
  The derived workspace path is handed to Git as an argument, so it must satisfy
  `doctor/exec.ts`'s allow-list — the same rule `workspace-identity.ts` already
  applies to task workspaces. A root containing a space, or a Windows 8.3 short
  name, yields `IDENTITY_UNDERIVABLE` and no verification is possible. Measured
  rather than reasoned about: `C:/Users/RUNNER~1/AppData/Local/Temp/…` — what
  `os.tmpdir()` answers on the GitHub Windows runner — is refused, and its long
  form `C:/Users/runneradmin/…` is accepted. It is inherited and consistent, not
  new, and it is named here because it is invisible until a host hands back a
  short path.
