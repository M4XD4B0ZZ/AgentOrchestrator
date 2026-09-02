# A persistent scheduler, and a wait that outlives the process that made it

Date: 2026-09-02
Status: accepted
Slice: M3 slice 1

## The gap, measured before anything was written

M2 finished with every quota pause on disk, carrying the instant it ends, and
with nothing in the build that could act on one.

Measured against `main @ baba91d`, through the shipped CLI, with a real Git
repository whose single task was durably `BLOCKED_USAGE_LIMIT` with a reset
**three hours away**:

```
[1b] `repositories --attended`  exit=3  elapsed=4769ms
  #1 sched-fixture-a
    task            : SCHED-1
    outcome         : BLOCKED_USAGE_LIMIT
    reasons         : RESET_TIME_NOT_REACHED

state bytes unchanged after the attended run: true
```

Four point eight seconds, for a wait of three hours. The one thing in the build
that waits at all is `run --repository <path> --task <id>
--automatic-resume-only --wait-for-reset`, and its own help text says the rest:
*"nothing schedules it"*. It waits **once**, for **one task named on its own
command line**, and the instant it is waiting for exists only in that
invocation's arguments — so a machine rebooting at hour three of a five-hour
window leaves a task parked until a human types the command again, having first
worked out which task and until when.

## The sentence this slice is answerable for

> If AgentOrchestrator stops while a task is waiting for a machine-understandable
> future condition, a later AgentOrchestrator process can reconstruct that wait
> from durable state and resume the task when the condition is satisfied, without
> requiring a human to manually rediscover or re-enter the wait.

## What was already true, and was measured rather than assumed

- **The wait is already durable.** `TaskState.reportedResetAt` — ISO-8601 with an
  explicit zone, refused by the schema when it carries none — is the only durable
  "wake me at" value in the build, and it is written only from what an agent CLI
  reported (`agent/record-interruption.ts`). Nothing invents one.
- **A fresh process can already read it.** `loadTaskState` is a lease-free,
  preflight-free read, and the read-only plan already publishes
  `RESET_TIME_NOT_REACHED` among its reasons. What no reader could do is ask
  *which* tasks are waiting: `state-store.ts` never enumerates the runtime
  directory, so every reader had to know the task id first.
- **The planner does not see the block at all.** Eligibility is `status: OPEN`
  plus satisfied dependencies, read from the task's markdown; the quota block is
  discovered inside `runTask`, after selection. So a blocked repository has always
  cost exactly one wasted admission per invocation and has never stalled another.
- **The exclusion already exists and is not the scheduler's.**
  `acquireRepositoryExecutionLease` is an atomic `linkSync` onto the lease name,
  keyed on the canonical Git common directory. Two processes deciding the same
  task is due has always been harmless; only one can execute it.

## The decision

### 1. The durable task state stays the only authority, and gains a reader

`schedule/durable-wake.ts` enumerates each enlisted repository's
`.agent-orchestrator/runtime/`, loads every state file through the ordinary
`loadTaskState`, and reports the earliest `reportedResetAt` that is **strictly
in the future**.

**No second persisted queue, and the reason is not economy.** A due-date index
would be a second answer to a question the task state already answers, and the
two would be free to disagree — the failure shape this build has paid for before,
where a gate proves one document and the effect lands against another. The scan
indexes nothing and caches nothing; every call is a fresh read.

**Strictly future is load-bearing.** An instant that has already passed is not a
wake: the coordinator pass that just ran has already had its chance to act on it,
and reporting it would produce a sleep of zero followed by a pass that admits the
same nothing — a hot loop dressed as a schedule. Requiring the future is also the
termination argument: every wake moves the clock past at least one recorded
instant, and a passed instant is never reported again.

**Fail-closed means fewer wakes, never more.** An unreadable runtime directory,
a state this build cannot parse, a reset `Date.parse` will not take, a clock
reading that is not a timestamp — each contributes no wake and is reported as a
closed-vocabulary note. The cost of that direction is a scheduler that stops
early and says why.

### 2. Due is not this layer's opinion

The scheduler computes a **time to look again**, never a permission.

`evaluateAutomaticResume` denies while `now <= reportedResetAt` — strictly — so
the scheduler aims at `reportedResetAt + 1 ms`, the earliest moment that
authority can possibly allow. It is still only *possibly*: the policy is re-run
from a fresh clock inside the ordinary lifecycle after the wake and is the
authority, whatever the arithmetic aimed at.

This is why the brief's `due := now >= reportedResetAt` is implemented as
`now > reportedResetAt`. A scheduler with the looser opinion would wake into a
guaranteed refusal, and — because the instant would then no longer be strictly
future — would never try again. The `+ 1` is inherited from
`run/unattended-resume.ts`, which derived it from the same `<=` for the same
reason.

**A block recording no reset is never scheduled.** It has no
machine-understandable wake, contributes nothing to the horizon, and stays the
operator's through `run --attended --continue-usage-limit`. Inventing a retry
interval here would be this layer deciding the one thing the product says nothing
may decide.

### 3. A loop above the coordinator, not a change to it

`schedule/scheduler.ts` runs `driveRepositories`, reads the horizon, sleeps, and
plans again. `run/repository-coordinator.ts` is untouched: it is still not
persistent, still has no queue, still has no timers and still polls nothing.

**No execution lease is held across a sleep, and that is structural rather than
asserted.** `driveRepositories` returns only after every admission it made has
settled, and a settled admission has released. The sleep sits strictly between
two passes, so there is no code path on which this loop could be holding one.

**Three things are re-established at every cycle boundary**, each a rule rather
than an optimisation:

1. **the registry**, because a repository can be unenlisted, moved or broken
   during a five-hour wait, and its capacity is re-bounded on the way back in;
2. **the auth preflight**, through a factory called once per cycle, because the
   evidence artefact carries no freshness and a login proven before a six-hour
   sleep must not authorise the work after it;
3. **the horizon**, read *after* the pass, so it describes the world the pass
   left behind.

The only thing carried across a sleep is the operator's bounds, and they are
spent rather than renewed.

### 4. Chunked sleeping, because the subject is an instant and the timer is a duration

`schedule/bounded-sleep.ts` sleeps in slices of at most one minute, re-reading
the clock between them.

Chunking is **not** about Node's 2 147 483 647 ms timer limit — 24 hours already
fits. It is about the clock. A timer sleeps for a *duration*; the thing being
waited for is an *instant*, and those are the same only while the wall clock runs
at one second per second. An NTP correction or a virtual machine resumed from a
snapshot breaks the identity; re-reading the clock bounds the error to one chunk
whatever the step was. The timer limit is respected for free: a chunk is four
orders of magnitude below the edge.

Re-reading the clock creates the opposite trap — a clock stepped *backwards*
makes the deadline recede — so the loop also counts chunks, a monotone quantity
no clock can move. Exceeding what the operator's bound could account for ends the
wait as `CHUNK_BUDGET_SPENT`, which is not a failure: nothing was held and
nothing was written, and the next act is to read durable state again.

The sleep takes a cancellation promise and clears its timer on it, so an
interrupted wait returns at once and leaves nothing holding the event loop.

### 5. The command, and the one signal handler in this build

`agent-loop repositories --attended --wait-for-reset --max-wait-ms <n>
--max-cycles <n>`.

Both bounds are **required and have no default**, for the reason
`run --wait-for-reset` gives about its own: a multi-hour sleep invented by a
default is a multi-hour sleep nobody asked for, and a cycle count invented by a
default is a machine kept busy on nobody's instruction. `--max-cycles` is at
least 2, because the first cycle is the pass that meets the block.

**No authority was added.** Every admission still runs under the ordinary
attended grant with all four destructive permissions `false`. The wait changes
*when* passes happen and nothing about what a pass may do.

**The invocation without the flags is unchanged, down to what it opens.** The
scheduler refuses the wait *before* it scans, so an ordinary
`repositories --attended` enumerates no runtime directory and prints the report
it always printed, graded by the same codes.

`src/` had no process-level signal handler anywhere, and that is not an
oversight: every command in this build dies at once on an interrupt, and every
durable guarantee is written to survive exactly that. So the handler is installed
**only** for an invocation that can sleep, and removed on every path out. The
first interrupt asks the scheduler to stop after what is already running; a
second removes the handler and re-raises, restoring the default. A hard kill at
any moment is safe: a wait holds nothing, and a death mid-pass is the ordinary
crash every lease recovery in this build already exists for.

## Competing schedulers

Two schedulers may both observe the same task as due. That is not prevented and
does not need to be: the decision is not the effect. Execution goes through the
ordinary lease acquisition, which is an atomic `linkSync`, and the loser is
refused `LIVE_OWNER_PRESENT` without ever reaching a recovery.

No scheduler-level global singleton was added. One would be a second exclusion
with a different key, and the first question about it would be what happens when
the two disagree.

## What this slice deliberately does not do

No notifications, no email, Slack or webhook. No recurring or cron jobs, no
user-authored schedules, no calendar semantics and no generic delayed jobs. No
periodic maintenance. No automatic PR merge. No provider account switching and no
billing. No cross-machine orchestration, distributed scheduler, remote queue or
worker cluster. No generalised workflow engine, event subscriptions or GitHub
webhook resume. No final M3 multi-project dogfood certification.

`READY_FOR_PR` remains terminal. Dependency and priority semantics, deterministic
cross-repository selection, one active task per repository, bounded global
concurrency, owned-launch accounting, lease and recovery, and the
`--continue-usage-limit` operator escape are all unchanged.

## The costs this buys, stated rather than discovered later

- **A wake costs a pass, even when the pass can do nothing.** The planner selects
  on the task file's `status`, so a repository whose task is still quota-blocked
  is admitted, takes the lease, pays one auth preflight and is refused. That was
  already true of every `repositories --attended` invocation; what is new is that
  a scheduler makes several of them. It is bounded: a wake happens only for an
  instant that genuinely passed, and one auth preflight is shared by every
  repository in a cycle.
- **A wake that leads nowhere costs one extra cycle.** A task whose reset passes
  and which still cannot resume — a withdrawn checkpoint, a dirty tree — is woken
  for once, planned, and then contributes no future wake because its instant is
  behind. One wasted pass, never a loop.
- **Idle waiting wakes once a minute** to compare two numbers. It opens no file,
  starts no process and takes no lease.
- **The longest wait this build will perform is 24 hours**, inherited unchanged
  from `MAX_WAIT_MS_CEILING`. Anything longer is a bound this build refuses
  rather than a sleep it attempts.
