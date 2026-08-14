# V2-08 — Attended block runner: execute a block of independent tasks

**Status:** design, not yet planned into tasks.
**Predecessors:** V2-07 (block ledger), V2-07L (execution lease), V2-07P (platform contract).
**Successor:** V2-09 (dependent tasks / controlled commit chain).

## Why this slice exists

Everything needed to *record* a block run exists and is proved. `block-progress.ts`
already offers `startBlockRun`, `activateBlockTask`, `settleBlockTask`,
`parkBlockTask`, `abandonBlockTask` and `stopBlockRun`, each of which reads the
task's durable state before recording an outcome and refuses when the state does
not prove the claim. `execution-lease.ts` makes at most one invocation the writer
of a repository.

What does not exist is the thing the product is for: **something that actually
runs a block.** V2-08 adds that driver and nothing else. It composes primitives
that are already there; it does not invent new orchestration truth.

This is deliberately the first slice in a long while whose subject is the
product rather than the platform underneath it. Its scope discipline is
therefore stated as a negative up front: **V2-08 opens no new platform,
ownership or recovery surface.** Where it meets one, it stops rather than
extends.

## 1. The decision this slice is built on

A block run distinguishes **two classes of bad news**, and confusing them is the
defect this design exists to prevent.

| | class 1 — *a task failed* | class 2 — *the run cannot safely continue* |
| --- | --- | --- |
| what it is about | one task's own outcome | the run's ability to make any further durable claim |
| durability | recorded in the ledger, with evidence | recorded as a stop, claiming no progress |
| effect on the block | the run continues with tasks already known to be independent | the whole block stops immediately |
| example | the agent could not finish task A; a human must resolve it | the lease is no longer certainly held |

A block of `A, B, C` where `A` fails locally and `B` and `C` are independent
ends as:

```
A = BLOCKED          B = READY_FOR_PR          C = READY_FOR_PR
```

That block is **not `COMPLETE`**. The run did as much as could honestly be done
and reports the remainder plainly. "Not complete" and "wasted run" are different
statements, and the ledger already has the vocabulary to say the first.

### Why continuing is the safe direction here, and only here

Continuing after a task-local failure is safe **because every continuation is
still gated by the same proof**: `settleBlockTask` will not record a settlement
the task's own state does not support, whatever happened to a sibling. A failed
A cannot make a false claim about B possible. What a failed A *could* do is
consume the operator's attention — which is why the run stops for class 2, where
the machinery that would catch a false claim is itself in doubt.

## 2. The policy this reverses, stated rather than slipped in

`TASK_DISPOSITIONS` in `src/block/block-ledger.ts` documents `BLOCKED` as:

> a blocked task is waiting for a human and **stops the run as a matter of
> policy**

That sentence is V2-07's policy and V2-08 reverses it. It is a documented
contract statement in a shipped, proved artefact, so amending it is a task of
this slice with its own control — not a comment edited in passing. The same
applies to `TASK_ABANDONED`.

What does **not** change: `BLOCKED` and `ABANDONED` remain evidence-backed
(`EVIDENCE_BACKED`), remain terminal for that task, and remain unable to be
recorded without the task state that proves them. Only the *run's reaction* to
them changes.

`TASK_BLOCKED` and `TASK_ABANDONED` survive as stop reasons, with their meaning
narrowed from **"abort now"** to **"this run ended without completing, and a
task outcome is why"**. They stay in `PROGRESS_CLAIMING_STOP_REASONS`, because
they still assert something about the tasks and must still be proved against
every task record before being written.

## 3. Stop reasons: what exists, and the gap

Existing `BLOCK_STOP_REASONS`, sorted into the two classes:

- **class 1, end-of-run summaries** — `COMPLETE`, `TASK_BLOCKED`,
  `TASK_ABANDONED`
- **class 2, run cannot continue** — `OPERATOR_STOPPED`, `LEDGER_DIVERGED`,
  `STATE_UNUSABLE`, `DEFINITION_DRIFTED`
- **neither, and needs a decision** — `NO_ELIGIBLE_TASK`

The decided class-2 list is not fully expressible today. Mapping each stated
condition to its reason:

| condition | reason today | verdict |
| --- | --- | --- |
| operator stops | `OPERATOR_STOPPED` | covered |
| ledger and records disagree | `LEDGER_DIVERGED` | covered |
| a task record is broken or somebody else's | `STATE_UNUSABLE` | covered |
| frozen plan no longer matches the definition | `DEFINITION_DRIFTED` | covered |
| **lease/ownership no longer certain** | — | **missing** |
| **a durable write is not possible** | — | **missing** |
| **a repository/auth/runtime-wide gate fails** | — | **missing** |
| **an unresolved `ACTIVE` cannot be safely concluded** | `STATE_UNUSABLE`? | **needs a decision** |

Adding members to `BLOCK_STOP_REASONS` is a change to a persisted schema
(`BLOCK_LEDGER_SCHEMA_VERSION = 1`) and to the classification set beside it. Two
constraints follow, and the plan must carry both:

1. a new reason must be sorted into `PROGRESS_CLAIMING_STOP_REASONS` or
   deliberately kept out, and **the sorting needs a correctness test, not a
   completeness test** — `satisfies Record<keyof T>` proves every member was
   considered and proves nothing about whether each landed on the right side;
2. every class-2 reason must stay writable over a ledger whose entries are *not*
   supported, because a run that has just detected that it cannot trust the
   ledger has to be able to say so. That is exactly why the non-progress-claiming
   set exists, and a new reason that quietly acquires a proof obligation would
   wedge the run in the case it was added for.

Whether the last row is `STATE_UNUSABLE` or its own reason is **left open for
the plan**, deliberately. "An `ACTIVE` task whose fate cannot be determined" is
not obviously "a task record that is broken or somebody else's", and rounding it
to a neighbouring code is the misdescription class V2-07P spent three review
rounds deleting.

## 4. Independence is consumed, never inferred

**V2-08 does not interpret dependencies.** Only tasks *already established* as
independent may continue after a sibling's local failure. The runner reads that
property; it does not derive, infer or relax it.

This is the boundary that keeps V2-08 from becoming V2-09. The controlled commit
chain — where one task's result commit becomes another's base — is V2-09's
subject, and it must earn a claim V2-07 explicitly refused to make: that a
`READY_FOR_PR` task has a commit fit to be a successor's base. `block-ledger.ts`
already records the distinction and warns against collapsing it.

Consequence for the frozen plan: if a block's definition does not establish
independence, **no task may continue after another's failure**, and the run stops
at the first task-local failure exactly as V2-07 does today. That degradation is
the correct one — it is V2-07's behaviour, which is proved.

## 5. The runner

One new module, driving the existing primitives. Shape, not final signature:

```
attended block run
  acquire the repository execution lease            <- once, for the whole run
  start or resume the block run ledger
  loop:
    choose the next eligible task
    activateBlockTask                               <- at most one ACTIVE, enforced
    drive that task to a terminal task state
    settle / park / abandon, from its durable state
    class 2 condition at any point -> stopBlockRun and return
  stopBlockRun with the end-of-run summary reason
  release the lease
```

Three properties this shape is chosen for:

**One lease across the whole run.** `README.md:3789` states the lease guarantee
is run-scoped and that V2-08 must hold one lease across a whole block run and
perform its ledger writes underneath it. A per-task lease would misstate the
guarantee and reopen the ownership question this slice is forbidden to touch.

**One `ACTIVE` task at a time.** The ledger already enforces it
(`ANOTHER_TASK_ACTIVE`). V2-08 runs a block *sequentially*; "several independent
tasks" is about surviving a sibling's failure, not concurrency. Parallel
execution is not in this slice and would need the process containment V2-08 does
not have.

**Attended only.** `README.md:4238` records that unattended running needs owned
process containment rather than merely the lease, and that automatic recovery of
a stale lease stays refused until the orchestrator creates that containment.
V2-08 is the *attended* block runner precisely so it needs none of that. This is
the single most important scope line in the slice: staying attended is what
keeps the recovery surface closed.

## 6. `NO_ELIGIBLE_TASK`, and the reconciliation question V2-08 inherits

`NO_ELIGIBLE_TASK` — "no frozen task is currently eligible to run" — sits
awkwardly between the two classes and V2-08 has to place it. Under the new
policy it is reachable in a way it was not before: after A fails locally and B
and C are settled, a block with no remaining eligible task is *finished*, not
obstructed. The plan must decide whether that end is `NO_ELIGIBLE_TASK` or the
task-outcome reason that actually explains it (`TASK_BLOCKED`), and the honest
answer is likely the latter — an operator told "no eligible task" learns nothing
about why.

Separately, `README.md:3588` records that **which positive reconciliations may
safely be applied on their own is V2-08's decision.** This slice therefore
inherits an open question rather than a settled one. It is named here so the
plan allocates a task to it instead of discovering it mid-implementation.

## 7. Explicitly out of scope

- **the controlled commit chain** — V2-09;
- **interpreting dependencies** — V2-09; V2-08 consumes independence only;
- **unattended running** — needs owned process containment;
- **automatic stale-lease recovery** — refused, and stays refused;
- **parallel task execution** — needs containment; the ledger permits one
  `ACTIVE`;
- **new platform, filesystem or ownership behaviour** — V2-07P closed that
  block and it is not reopened here;
- **`READY_FOR_PR` gaining an outgoing transition** — it is terminal, and the
  orchestrator still hands a finished task to a human and stops.

## 8. Controls

The suite must distinguish the two classes by *effect*, not by reading a label:

1. **a task-local failure does not stop the run** — a block of three independent
   tasks where the first parks: the ledger ends with one `BLOCKED` and two
   `SETTLED`, and the run's stop reason is not `COMPLETE`. This is the control
   that fails against V2-07's policy, so it is the one that proves the reversal
   actually happened;
2. **a class-2 condition stops the run immediately** — driven at a point where
   further tasks *are* eligible, so the assertion is that the remaining tasks
   are untouched. A stop that happens to coincide with the end of the block
   proves nothing;
3. **each class-2 condition, separately** — one case per reason. A shared
   parametrised case passes against a runner that maps every condition to one
   reason, which is the misdescription defect in its natural habitat;
4. **the block is not `COMPLETE` when a task is `BLOCKED`** — asserted on the
   persisted ledger, not on an in-memory value;
5. **no continuation without established independence** — a block whose
   definition does not establish it stops at the first local failure;
6. **one lease for the whole run** — measured by the effect: a second invocation
   is refused for the run's whole duration, not merely during one task;
7. **a class-2 stop is writable over an unsupported ledger** — the case the
   non-progress-claiming set exists for, and the one that wedges the run if a
   new reason is sorted wrongly;
8. **the reversed policy's documentation** — `TASK_DISPOSITIONS` must no longer
   state that a blocked task stops the run.

## 9. What "done" means

- a block of several independent tasks runs to the end in one attended
  invocation, under one lease;
- a task-local failure is recorded durably with its evidence and does not end
  the run;
- every class-2 condition ends the run immediately, each under a reason that
  names it, and none of them claims progress;
- the two classes are distinguishable in the ledger by an operator who was not
  present;
- `npm run verify` green, and CI green on Windows for both supported Node
  majors.

## 10. Open questions for the plan

1. Where does "an unresolved `ACTIVE` cannot be safely concluded" belong —
   `STATE_UNUSABLE`, or its own reason?
2. Which end-of-run reason does a block with a blocked task and no remaining
   eligible task carry: `TASK_BLOCKED` or `NO_ELIGIBLE_TASK`?
3. Which positive reconciliations may be applied on their own
   (`README.md:3588`)?
4. Do the three missing class-2 reasons (lease uncertainty, durable-write
   failure, repository-wide gate failure) need three reasons or fewer, and does
   adding any of them bump `BLOCK_LEDGER_SCHEMA_VERSION`?
