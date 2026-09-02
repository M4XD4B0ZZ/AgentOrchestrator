# Actionable notifications, recurring operation, and the last unrecoverable quota block

**Date:** 2026-09-02 · **Status:** accepted, implemented by M3 slice 2.

M3 slice 1 gave AgentOrchestrator a scheduler that can wait out a recorded quota
reset and reconstruct that wait after a restart. It left two things a person
still had to do by hand — re-invoke the command once nothing was recorded to wait
for, and go and look at whether anything needed them — and one task shape that
nothing could move at all.

## The sentence this slice is answerable for

> AgentOrchestrator may keep operating unattended when work is machine-actionable,
> and must surface clear, actionable operator notifications when human
> intervention is genuinely required.

Both halves are conditional, and the conditions are the design. "Keep operating"
only where the operator asked it to; "notify" only where no machine can make
progress *and* there is something a person can go and do.

## 1. The unrecoverable quota block

### The defect, measured before anything was changed

A `BLOCKED_USAGE_LIMIT` task whose interruption checkpoint was **withdrawn** —
`currentCommit: null`, `worktreeCleanAtCheckpoint: false`, which is what
`recordAgentInterruption` writes whenever the settlement could not be established
— records a reset instant all the same. `evaluateAutomaticResume` denies on both
withdrawn facts, and both are properties of the *document*, so no passage of time
and no repair to the repository changes them. `--continue-usage-limit` refused
too, because its guard was `state.reportedResetAt === null`.

Reproduced against the shipped CLI at `fdbe999` on 2026-09-02, with a real Git
repository, a real worktree and a hand-written state file validated on the way
back in by `loadTaskState`:

| Command | Result | State file afterwards |
| --- | --- | --- |
| `run --attended` | `BLOCKED_USAGE_LIMIT` / `AUTOMATIC_RESUME_REFUSED`, reasons `CURRENT_COMMIT_MISMATCH, WORKTREE_NOT_CLEAN`, 0 steps | byte-identical |
| `run --attended --continue-usage-limit` | identical output | byte-identical |
| `run --automatic-resume-only` | same refusal; `Wait: NOT_REQUESTED` | byte-identical |
| `repositories --attended --wait-for-reset` | admitted, same refusal, `NO_FUTURE_WAKE`, `Durable wakes: 0` | byte-identical |

Carried in `README.md` as **L-M3-01-1**, which handed the stuck state to
"whoever reopens that guard".

### The decision

`--continue-usage-limit` continues a quota block **exactly when the record
itself, and not the world, is what makes an automatic resume impossible.**

The guard is now `usageLimitContinuation(state, now).permitted`
(`src/core/usage-limit-continuation.ts`), and the important part is how it
decides. It does **not** restate which of `evaluateAutomaticResume`'s checks are
record-only. It calls that function with evidence stipulated to agree with the
record on every observable fact, and reads what still denies
(`recordOnlyResumeRefusals`). L-M3-01-1 declined to narrow the wake scan by those
two fields precisely because doing so would have been "a second reading of
another module's policy, correct only for as long as that policy keeps those two
checks record-only". A call is not a second reading: a later slice that makes
either check consult the world moves this answer with it.

Two obligations follow, and both are tests rather than comments:

- a record with nothing wrong with it must produce **no** record-only refusal, so
  a world check added later that denies under a perfect world fails the suite
  instead of silently widening an escape;
- the set subtracted as world-dependent must be **exactly** what a pure function
  cannot satisfy — one member, `AUTH_PREFLIGHT_NOT_PASSED`, because
  `authEvidence` is an opaque minted artefact — measured by evaluating the policy
  on a healthy record and comparing.

### What it refuses, and why each refusal is kept

| Reading | Permitted | Why |
| --- | --- | --- |
| `RESET_AHEAD` | no | The machine knows when the quota returns. An escape past this would start an agent before its window, which is the waste M2 slice 6 exists to stop. |
| `MACHINE_MAY_STILL_RESUME` | no | The automatic path grants it unless the *world* denies, and this decision carries no evidence about the world. Fix the repository, not this. |
| `RECORD_REFUSAL_UNRECOGNISED` | no | The record refuses for a reason this build has no sentence for. Fail-closed. |
| `RESUME_POINT_MISSING` | no | Nowhere to go. Unreachable through the state contract; answered anyway. |
| `CURRENT_TIME_UNREADABLE` | no | Fail-closed on a clock that is not a timestamp. |
| `RESET_UNRECORDED` | **yes** | M2 slice 6's case, unchanged. |
| `RESET_UNREADABLE` | **yes** | The same dead end as an absent instant. |
| `RESUME_RECORD_WITHDRAWN` | **yes** | The shape this slice exists for. |

`RECORD_REFUSAL_UNRECOGNISED` is not decoration and it was not in the first
draft. `repositoryRoot` and `worktreePath` are `NonBlankString` in the state
contract, so a relative path is schema-valid, and `canonicalPathsEqual` refuses
one — a genuinely record-only refusal that is not a withdrawn checkpoint. A
catch-all would have permitted it under a sentence about commits and worktrees,
which is a report lying. The permitted set is therefore an explicit list of
record faults an operator may override, and **every** surviving refusal must be
in it: a record that is both withdrawn and otherwise unusable is refused, because
the operator would otherwise be shown a sentence describing half of what is
wrong.

### What the permission is not

It is not a quota override and asserts nothing about the allowance. It does not
skip the lease, the plan, the scope gates or any lifecycle transition: the driver
conjoins it with the attended grant, with a resume point the loop can drive, and
with the one-use bound, and the resume it authorises is `resumeBlockedTask`
unchanged — the same write the automatic path makes. A tree the withdrawal was
recorded for is met again by PRE-SCOPE before any writer runs in it, which is
`loop-step.ts`'s own stated reason for withdrawing rather than escalating.

## 2. Actionable notifications

### The rule

    an item exists  ⟹  no machine can move this task
                        AND there is something a person can go and do

An implication, **not** a biconditional. Everything raised genuinely needs a
person; not everything that needs one is raised. The first draft of this section
wrote a biconditional and three reviewers correctly called it false.

`core/task-attention.ts` judges one durable `TaskState` and nothing else. That
purity is a design constraint rather than an economy: it is what makes the crash
window closeable. A notification derived from something a *pass* observed dies
with the process that observed it; a judgement that is a function of a document
can be re-derived by any later process from the same document.

The price is what makes the rule an implication, and it has two halves.
Conditions that are not in a task record at all — a profile that stopped
parsing, a lease whose owner cannot be proven dead, an auth preflight that
failed — halt a pass and are reported by the pass; they are out of this module's
subject rather than overlooked by it. And a task the **world** refuses is
invisible to it: a quota block whose reset has passed over an *intact* record
reads `MACHINE_MAY_STILL_RESUME` and is silent, because as far as the document
is concerned the automatic path owns it. If the repository is what keeps
denying, nobody is told by the outbox and the wake scan stops offering the
instant once it is behind, so the task sits. Carried as **L-M3-02-9**; closing
it needs an attention judgement that can run Git and an auth preflight, which is
a different and much larger thing than a pure function of a record.

### The two judgements that took an argument

**`READY_FOR_PR` is silent.** It is terminal, it has a real operator action, and
an earlier design note asked for one closing message on it. The outbox settles by
*removal*, so an item on a terminal state could never be resolved by the task
moving, and every finished task would leave one open for ever. That needs an
acknowledgement the operator gives back, which is a second mechanism and is not
in this slice. `notify/attention.ts` already grades the corresponding block-run
ending `COMPLETE: silent`.

**`BLOCKED_AUTH`, `SCOPE_VIOLATION` and `RESUME_STATE_DIVERGED` do get an item**
even though no flag in this build continues any of them, and their sentences say
so in as many words. An unattended orchestrator that met a scope violation and
said nothing is the failure this capability exists to prevent, and "there is no
command; look at this, then abandon or repair it by hand" is a specific
instruction. `BLOCKED_AUTH`'s sentence was measured rather than assumed, and the
first draft was wrong: it said "log in, then re-run", which the transition table
appears to promise and no code delivers, because nothing in `src/` ever writes
`AUTH_PREFLIGHT`.

### The sink, and what "notification" means here

Two layers, and the report is explicit about which is which.

**A durable outbox, always.** One file per open condition under
`<orchestrator home>/operator-attention/`, named after a digest of what the
notification is *about*. It sits outside every repository for three reasons: the
consumer is cross-repository and the registry already lives there; the outbox is
settled between passes holding no lease, which is exactly when a
repository-scoped write has no authority behind it; and a repository AO drives
ignores `.agent-orchestrator/runtime/` and nothing else, so a new directory
beside the profile would show up as untracked work in every `git status`.

**A push, only where the operator already configured one.** `notify.yaml` is
opt-in by absence, and the shipped-artefact harness proves that a scheduler with
no configuration in front of it opens no socket at all. The push carries strictly
less than the record: no repository root, no worktree path.

Two consequences of that reuse are worth stating rather than leaving to be
discovered. The first is that an operator who configured `notify.yaml` for
`agent-loop block`'s run endings will now also receive attention items from
`repositories --wait-for-reset`, on the same topic. That is deliberate: the file
says *where to tell me things*, not *tell me about block runs specifically*, and
the design note this slice implements asked for exactly this class of message.
The second is that both halves are installed for **every** invocation carrying
the wait grant, not only ones that also pass `--idle-poll-ms` — the unattended
mode is what `--wait-for-reset` names, and the interval only changes how long it
stays in it. An invocation without the wait grant reads no configuration, opens
no runtime directory and touches no store, and that negative is measured rather
than promised.

### De-duplication is the filesystem

The whole concurrency design is one call: `openSync(path, 'wx')`. The name is a
digest of `(repositoryRoot, taskId, reason, detail, stateEnteredAt)`, so two
processes that find the same condition derive the same name; the kernel gives the
file to one of them and tells the other `EEXIST`. There is no read-then-write, no
lock, no counter and no lost update, and "already recorded" and "somebody else
recorded it" are the same answer because they are the same fact.

`stateEnteredAt` is what makes a *re-entry* a new notification. A task parked on
the same block across a hundred passes keeps the same instant and therefore the
same name; one that is continued, runs, and blocks again gets a fresh instant and
is said again, which is right.

`repositoryRoot` rather than the declared id, because two clones declare one id
and are two execution domains — the rule the execution lease already applies by
keying on the Git common directory.

### The one apparent contradiction, named rather than left to be found

`schedule/durable-wake.ts` argues that this build has **no second persisted
queue**: the durable authority for a wait is `TaskState.reportedResetAt` and
nothing else. The outbox does not weaken that. It answers a different question —
"was this operator already told?" — which no existing document answers, and it is
authority for nothing: no lifecycle decision reads it, no resume consults it, and
deleting the whole directory costs a re-notification on the next pass. The wait
is still not stored anywhere.

## 3. Recurring operation

One optional number, `--idle-poll-ms`. When a pass leaves nothing recorded to
wait for, the loop sleeps that interval and plans again instead of ending.

It exists because "no future wake" never meant "nothing will ever be runnable
again". The wake horizon is a horizon of *recorded quota resets*: work that
becomes runnable for any other reason — a task somebody writes, a dependency
another repository satisfies, a block an operator clears — is invisible to it.

**Optional, with no default.** Without it a pass that leaves nothing to wait for
ends the invocation, before the cycle budget is even consulted, which is what
this command has always done. A default would turn every existing scheduler
invocation into a process that no longer exits.

**It also takes over from a wake that is out of reach.** `--max-wait-ms 600000
--idle-poll-ms 60000` says two things — do not block more than ten minutes on a
recorded wait, and look again every minute — and the first spelling honoured only
the first: a quota reset five hours out in one repository ended a run that was
polling for work in every other, which is precisely the case the interval exists
for. `BOUND_EXCEEDED` now ends the invocation only when no interval was given. Termination is unaffected: an
idle cycle is still a cycle, `--max-cycles` still bounds them, and
`MAX_SCHEDULER_CYCLES` still caps that where the loop reads it. `MIN_IDLE_POLL_MS`
is a floor under one sleep, not a safety property; what bounds an idle loop is the
cycle budget.

### The scheduler still knows nothing about notification

`tests/m3-01-persistent-scheduler.test.ts` reads `src/schedule/scheduler.ts` with
its prose stripped and refuses the tokens for a notifier, a grant, a cron
expression and a persisted schedule. The pin is right, and this slice kept it
true rather than editing it: the loop gained a neutral `observeCycle` seam that
says "a cycle ended, here is what it drove", and
`src/cli/repositories-command.ts` — the layer that already owns every question
about the operator's own profile — decides what follows. An observer that throws
changes no disposition, because an outbox must never rewrite a run's answer about
the repositories.

## What this slice deliberately did not build

No cron and no cron syntax. No user-authored or persisted schedule. No calendar
job, delayed job or reminder. No Slack, no email, no webhook platform, no mobile
push. No distributed scheduler and no cross-machine coordination. No event bus,
no workflow engine. No automatic merge and no automatic approval of a human
decision. No provider account switching. No change to dependency, priority or
concurrency policy. No final multi-project dogfood.

## The residuals

Carried in `README.md` under "Carried forward, deliberately" as **L-M3-02-1**
through **L-M3-02-8**, and L-M3-01-1 is rewritten there: its stuck-state half is
closed and its wake-scan half stands, now for a measured reason rather than a
principled one.
