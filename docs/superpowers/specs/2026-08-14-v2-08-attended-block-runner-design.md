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
| durability | recorded in the ledger, with evidence | recorded as a stop claiming no progress — or, where the run cannot honestly write at all, reported without touching the ledger (section 3) |
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

## 3. Stop reasons, and what a stop reason may not claim

Existing `BLOCK_STOP_REASONS`, sorted into the two classes:

- **class 1, end-of-run summaries** — `COMPLETE`, `TASK_BLOCKED`,
  `TASK_ABANDONED`
- **class 2, run cannot continue** — `OPERATOR_STOPPED`, `LEDGER_DIVERGED`,
  `STATE_UNUSABLE`, `DEFINITION_DRIFTED`
- **an end-of-run reason of last resort** — `NO_ELIGIBLE_TASK`, placed in
  section 6

The decided class-2 list is not fully expressible today, and the reason it
cannot simply be *made* expressible is the load-bearing insight of this slice:

> **A ledger `stopReason` is itself a durable claim.** When the condition *is*
> that the run has no write authority, or no durable write capability at all,
> the runner must not pretend the cause still has to be written into the ledger.

So class 2 splits by **representability**, not by severity. A condition is a
persisted `stopReason` only if writing it is something the run can still
honestly do:

| condition | representation | ledger write |
| --- | --- | --- |
| operator stops | `OPERATOR_STOPPED` | yes |
| ledger and records disagree | `LEDGER_DIVERGED` | yes |
| a task record is broken or somebody else's | `STATE_UNUSABLE` | yes |
| frozen plan no longer matches the definition | `DEFINITION_DRIFTED` | yes |
| an unresolved `ACTIVE` cannot be safely concluded | **`ACTIVE_TASK_UNRESOLVED`** — new reason | yes |
| lease/ownership no longer certain | **`LEASE_AUTHORITY_UNCERTAIN`** — runner outcome | **no** |
| a durable write is not possible | **`DURABLE_WRITE_FAILED`** — runner outcome | **no** |
| a repository/auth/runtime-wide gate fails | **runner outcome**, gate code in its detail | **no** |

### `ACTIVE_TASK_UNRESOLVED` — the one new persisted reason

`STATE_UNUSABLE` says something about the task *state*: damaged, foreign, not
trustworthy. A task can hold entirely legitimate prior evidence and still end in
a condition whose outcome cannot be determined after an interruption. That is a
**different fact**, and folding it into `STATE_UNUSABLE` is exactly the
misdescription class V2-07P spent three review rounds deleting.

Its contract:

- class 2, non-progress-claiming;
- it **may coexist** with `ACTIVE` and an unchanged `activeTaskId` — it does not
  require the run to first invent a disposition for the task it could not
  conclude;
- it drags **no** task disposition and **no** commit evidence with it;
- it means one thing only: *the run must end, because the outcome of the active
  task cannot be safely established.*

### Three runner outcomes, deliberately not three reasons

`LEASE_AUTHORITY_UNCERTAIN`, `DURABLE_WRITE_FAILED` and the repository/auth/
runtime-wide gate failure are **terminal runner outcomes**, reported through the
runner's result and the CLI. None of them writes the ledger.

They stay three, not one generic `RUN_UNSAFE`, because they demand three
different operator reactions: find out who else holds the lease, fix the disk or
permissions, satisfy the gate. A single code would make the runner's report as
imprecise as the refusal codes V2-07P split apart.

For the first two the no-write rule is not a preference but a consequence:

- `LEASE_AUTHORITY_UNCERTAIN` — the run may no longer be the writer, so any
  further ledger mutation is precisely the act it has lost the authority for;
- `DURABLE_WRITE_FAILED` — the run cannot presuppose a successful stop write,
  because the failed write is the condition being reported.

In both cases **the ledger stays at its last provably durable state**, and the
truth reaches the operator through the runner's report instead. A "best effort"
stop write here would be the run's least trustworthy claim made at its least
trustworthy moment.

The gate failure follows the same model boundary: it is a run abort, not task
progress, and the specific underlying gate code belongs in the runner outcome's
detail rather than growing an ever-larger persisted stop vocabulary.

### Schema version

`ACTIVE_TASK_UNRESOLVED` is a new member of a persisted, closed-validated
vocabulary, so it is a schema change: **`BLOCK_LEDGER_SCHEMA_VERSION` is bumped
once for this slice.** Not once per new value, and with no "the enum grew but
the version stayed" exception — a reader of the old version genuinely cannot
understand the new document, and pretending otherwise is the kind of convenient
untruth this repository keeps removing. The three runner outcomes do not touch
the persisted schema and trigger no further bump.

Two constraints the plan must carry regardless:

1. the new reason must be sorted into `PROGRESS_CLAIMING_STOP_REASONS` or
   deliberately kept out, and **the sorting needs a correctness test, not a
   completeness test** — `satisfies Record<keyof T>` proves every member was
   considered and proves nothing about whether each landed on the right side;
2. every persisted class-2 reason must stay writable over a ledger whose entries
   are *not* supported, because a run that has just detected that it cannot trust
   the ledger has to be able to say so. That is why the non-progress-claiming set
   exists, and a new reason that quietly acquired a proof obligation would wedge
   the run in the case it was added for.

## 4. Independence is consumed, never inferred

**V2-08 does not interpret dependencies.** Only tasks *already established* as
independent may continue after a sibling's local failure. The runner reads that
property; it does not derive, infer or relax it.

This is the boundary that keeps V2-08 from becoming V2-09. The controlled commit
chain — where one task's result commit becomes another's base — is V2-09's
subject, and it must earn a claim V2-07 explicitly refused to make: that a
`READY_FOR_PR` task has a commit fit to be a successor's base. `block-ledger.ts`
already records the distinction and warns against collapsing it.

### The frozen plan must carry the dependency relation, because today it cannot

`BlockDefinition` is `blockId` + ordered `taskIds` and nothing else, and
`fingerprintBlockDefinition` covers exactly those. So V2-08 cannot prove
independence from its own authoritative frozen input, and the clause above would
make continue-on-task-local-failure unreachable in **every** block — the slice's
headline behaviour as dead code.

**Decided:** V2-08 extends the frozen block plan with the dependency relation and
binds it into the fingerprint. Not derived live from `task-graph.ts` during the
run — a roadmap edit mid-run could then change the answer to "may B continue
after A?", which is the opposite of frozen-plan authority. Not deferred to V2-09
either, because without it this slice cannot prove its own core decision. And
not a bare `independent: true` flag, which would freeze the *judgement* while
leaving the *evidence* it came from unfrozen.

```ts
type FrozenTaskDependency = {
  readonly taskId: string;
  readonly dependsOn: readonly string[];
};
// BlockDefinition gains: readonly dependencies: readonly FrozenTaskDependency[]
```

Canonicalisation is binding: exactly one row per member `taskId`, no unknown or
duplicated ids, `dependsOn` deduplicated and deterministically sorted, rows
deterministically ordered, and `fingerprintBlockDefinition` covering
`blockId + taskIds + dependencies`.

### `dependsOn` here is the transitive projection, and that is a measured result

**A direct intra-block edge check is not sound.** Measured against
`src/plan/task-graph.ts`: `normalizeTaskGraph` stores only each definition's own
edge list and its direct reverse (step 5) — there is no transitive closure
anywhere — and it normalises over the *whole* discovered task set, with every
edge required to resolve inside it (`TASK_DEPENDENCY_UNKNOWN`). A block is
therefore an arbitrary subset of a repository-wide DAG, and this is
representable:

```
A: dependsOn []
X: dependsOn [A]      <- not a block member
B: dependsOn [X]

block = {A, B}   ->   no direct intra-block edge exists,
                      yet B transitively depends on A through X
```

So the frozen `dependsOn` of a member is **the set of block members it
transitively depends on**, computed over the full normalised graph at freeze
time and then restricted to members. Freeze time, never run time.

A consequence worth stating: a member whose path to eligibility runs through a
non-member is not recorded as dependent on anything, and the block can be
frozen while that member can never become eligible. That run ends
`NO_ELIGIBLE_TASK` — a genuine eligibility dead end that no task disposition
explains, which is exactly what section 6 reserves it for.

### What V2-08 may do with the relation, and what it may not

V2-08 gets **no dependency scheduler**. It uses the relation for one question
only: *may A's failure leave B untouched?* The answer must be an unambiguous yes
from the frozen plan. As soon as any dependency relation holds between two tasks
the block still has to process, that block is **not supported input** for the
V2-08 runner — no improvised ordering, no partial scheduling. Dependent
execution stays V2-09.

If a block is not independent, the run stops at the first task-local failure
exactly as V2-07 does today. That degradation is the correct one — it is V2-07's
behaviour, which is proved.

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
    settle / park / abandon, from its durable state   <- a task-local failure ends here
    recordable class-2 condition   -> stopBlockRun(reason), return
    unrecordable class-2 condition -> return the runner outcome, WRITING NOTHING
  stopBlockRun with the end reason chosen by the table in section 6
  release the lease
```

Note the two distinct exits. A recordable class-2 condition ends the run *in the
ledger*; an unrecordable one ends it *in the report*, leaving the ledger on its
last provably durable state. A runner that funnelled both through
`stopBlockRun` would, in the two cases where writing is exactly what it cannot
do, either fail loudly at the wrong moment or emit a claim it had no authority
to make.

Four properties this shape is chosen for:

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

## 6. How a run ends: cause beats consequence

`NO_ELIGIBLE_TASK` — "no frozen task is currently eligible to run" — becomes
reachable under the new policy in a way it was not before: after A fails locally
and B and C settle, a block with nothing left to run is *finished*, not
obstructed. It must not become the generic "the loop ended" code, because an
operator told "no eligible task" learns the consequence and not the cause.

**The end reason is therefore the most specific task disposition that explains
the ending**, checked in this order:

| condition | reason |
| --- | --- |
| every required task settled | `COMPLETE` |
| at least one `BLOCKED`, nothing runnable left | `TASK_BLOCKED` |
| no `BLOCKED`, at least one `ABANDONED`, nothing runnable left | `TASK_ABANDONED` |
| no task disposition explains why nothing is eligible | `NO_ELIGIBLE_TASK` |

So the worked example — `A = BLOCKED`, `B = SETTLED`, `C = SETTLED`, nothing
left — ends as `TASK_BLOCKED`. `NO_ELIGIBLE_TASK` is reserved for a genuine
eligibility or selection dead end that no persisted disposition accounts for.

## 6a. Positive reconciliation: monotone, forced, and never a direct write

`README.md:3588` assigns this slice the decision of which positive
reconciliations may be applied on their own. Decided:

**V2-08 may apply a positive reconciliation only through the existing
authoritative primitive, never by writing the ledger directly.** The primitives
already refuse a claim the task's own state does not prove, and a reconciliation
path that bypassed them would be a second, weaker way to assert progress — the
one thing the ledger exists to prevent.

A reconciliation is permitted only when **all six** hold:

1. it is fully determined by durable authoritative evidence that already exists;
2. there is exactly one admissible successor state;
3. the change is monotone — no history is wound back;
4. no new evidence is invented;
5. the ordinary ledger/task-state primitive accepts the same change on its
   existing proofs;
6. applying it repeatedly is idempotent.

The moment any selection, interpretation, or choice between competing plausible
truths would be required: **do not repair — stop the block and report.**

This does permit recognising an already-present terminal task state as truth
even when this process did not produce it. It never permits the ledger to
reconstruct progress from mere plausibility.

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
3. **each class-2 condition, separately** — one case per reason *and* per runner
   outcome. A shared parametrised case passes against a runner that maps every
   condition to one reason, which is the misdescription defect in its natural
   habitat;
3a. **the two no-write outcomes leave the ledger byte-identical** — drive
   `LEASE_AUTHORITY_UNCERTAIN` and `DURABLE_WRITE_FAILED` and compare the
   persisted ledger before and after, byte for byte. Asserting "no stop reason
   was written" is weaker: it passes against a run that mutated the ledger some
   other way. This is the control that fails against a best-effort stop write;
3b. **`ACTIVE_TASK_UNRESOLVED` coexists with an unchanged `ACTIVE`** — after it,
   the entry is still `ACTIVE` with the same `activeTaskId`, and no disposition
   or commit evidence was invented for the task that could not be concluded;
3c. **the end reason names the cause, not the consequence** — the worked example
   ends `TASK_BLOCKED`, and a case with no explaining disposition ends
   `NO_ELIGIBLE_TASK`. Both are needed: only the pair proves the ordering rather
   than a constant;
3d. **reconciliation refuses where a choice would be required** — one case that
   is forced and monotone and is applied, one that is ambiguous and stops the
   block. Also that applying the permitted one twice changes nothing;
3e. **the fingerprint actually binds the dependency relation** — same `blockId`,
   same `taskIds`, one edge added or removed, and the old fingerprint must no
   longer match. Without this the new authority is modelled but not frozen,
   which is the whole point of putting it in the plan;
3f. **transitive dependency through a non-member defeats independence** — the
   `A ← X ← B` case from section 4, with `X` outside the block. A suite that
   only drives direct intra-block edges passes against the unsound projection
   this design rejected;
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
- every class-2 condition ends the run immediately, each under a reason or
  runner outcome that names it, and none of them claims progress;
- where the run cannot honestly write — lease authority uncertain, durable write
  failed — the ledger is left byte-identical and the truth reaches the operator
  through the report instead;
- the two classes are distinguishable in the ledger by an operator who was not
  present;
- `npm run verify` green, and CI green on Windows for both supported Node
  majors.

## 10. Decisions taken before planning

All four questions this design opened were decided deliberately, before the plan
was written, rather than left for a planner to settle implicitly.

| # | question | decision |
| --- | --- | --- |
| 1 | where does an unresolved `ACTIVE` belong? | its **own** reason, `ACTIVE_TASK_UNRESOLVED`. Not `STATE_UNUSABLE` — no semantic overloading of an existing code |
| 2 | blocked task, nothing runnable: which reason? | `TASK_BLOCKED`. Cause beats consequence; `NO_ELIGIBLE_TASK` is reserved for a real dead end no disposition explains |
| 3 | which positive reconciliations may be applied alone? | only monotone, forced, evidence-backed ones, through the existing primitive — the six conditions in section 6a. Anything else stops the block |
| 4 | how many new reasons, and a schema bump? | **one** new persisted reason and **three** runner outcomes that write nothing. One bump of `BLOCK_LEDGER_SCHEMA_VERSION` for the slice |
| 5 | where does established independence come from? | the **frozen plan**, extended with a canonical transitive dependency projection bound into the fingerprint (section 4). Not the live graph, not a bare flag, not deferred |

Question 5 was not in the original list. It surfaced while planning: `BlockDefinition`
carries no dependency information at all, so the slice could not have proved its
own core decision. It folds into the same schema bump as question 1 — one version
jump for the slice, not one per change.

The insight that reshaped question 4, and with it the runner's exit paths: a
ledger `stopReason` is itself a durable claim, so a condition asserting that the
run *cannot make durable claims* must not be represented as one. That is why
lease uncertainty and durable-write failure became runner outcomes rather than
reasons, and why the design has two distinct exits instead of one.

### Sequencing note for the plan

`DURABLE_WRITE_FAILED` is the only one of the three runner outcomes that can
also strike the stop write itself, so it needs a reporting path that stays
honest with no durable write available at all. It is a different animal from the
other two and **must not share a task with them.**
