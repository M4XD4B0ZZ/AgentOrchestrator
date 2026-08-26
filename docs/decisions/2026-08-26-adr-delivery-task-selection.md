# ADR — delivery task selection: routing over the plan, not a queue beside it

**Date** 2026-08-26
**Status** accepted
**Slice** V4 slice 12
**Supersedes** nothing. **Superseded by** nothing.
**Amends** `2026-08-26-adr-delivery-lifecycle-driver.md` §10, which named
"automatic task selection" a non-goal of slice 11. It was one. This slice takes
it on, bounded to the single question below, and nothing else on that non-goal
list moves: there is still no scheduler, no daemon, no cross-project
orchestration and no unattended forge mutation.

## The decision

AO gains one new capability: **given one named repository, work out which
delivery-ready task is the next legitimate subject for the delivery driver.**

One new flag, `delivery --select-task`. One new production module,
`src/deliver/select-delivery-task.ts`. No new durable record, no new authority,
no new act, no new opaque artefact, and no second ordering rule.

`--task <id>` stays, and stays the direct way to name a delivery. What is
removed is the requirement that an operator know **which** delivery is next.

`TaskState` is not extended. `READY_FOR_PR` stays terminal, the transition table
is unchanged, no task markdown is written, and the block ledger is not touched.

## The three sentences the contract rests on

> **The candidates are the tasks the repository declares, walked in the plan's
> own dependency order.**

> **A selection is routing. It authorises nothing.**

> **A candidate whose records cannot be read stops the walk. It is never
> stepped over.**

Everything below is those three, argued.

## 1. The input set: the plan, because it is the only discoverable one

`discoverTasks` (`src/plan/discover-tasks.ts:262`) is the only task enumerator
in this build. Every `readdir` in `src/` is one of three sites — the markdown
task source, the doctor's run directories, and a worktree — and none of them is
the runtime directory.

That is not an omission to be corrected here. The state layer states it twice as
a property, once on each side of the disk. The reader's side: "The state file is
opened by its derived name. The directory is never enumerated, so a temporary
file a crashed run left behind is invisible here" (`src/state/state-store.ts`).
The writer's side, in its own words: readers "open the target by name and never
enumerate the directory" (`src/state/atomic-file.ts`). An earlier draft of this
paragraph put the second sentence in the first file's mouth — one quotation used
twice, one of them misattributed, which is the defect a review already recorded
about a specified string matched against a paraphrase. The reason for the
property is the same on both sides: a crashed run's staging file is invisible to
a lookup and would be a candidate to a listing.

So the candidate set is the declared plan, and each candidate is then probed by
name. Two consequences are accepted rather than hidden:

- a task whose markdown file has been deleted, but whose runtime record still
  says `READY_FOR_PR`, is not selectable. The repository stopped declaring it.
  `--task` still reaches it;
- `discoverTasks` refuses the **whole** discovery on one malformed task file, so
  an unrelated bad file makes every delivery unselectable. That is `L-V4-12-2`,
  and it is the same all-or-nothing rule the run path already lives under.

## 2. The order: `topologicalOrder`, reused rather than invented

`NormalizedTaskGraph.topologicalOrder` (`src/plan/task-graph.ts:116`) is
dependency-respecting, breaks every tie by the smallest id — Kahn with the ready
set re-sorted at every step (`:214-233`) — and covers **every** task whatever its
`status`. It was computed and frozen on every `normalizeTaskGraph` call before
this slice and had no production consumer at all.

### Why not `selectNextTask`'s ranking tuple

Because its eligibility predicate excludes exactly the tasks that matter here. A
task is eligible when it is `status: OPEN` **and** every dependency is `DONE`
(`src/plan/select-task.ts:199-220`). A task a human marked `DONE` in the
markdown — so the next one could start — while its pull request was never merged
is `ALREADY_DONE`, absent from the ranking, and invisible to that selector for
ever. Selecting deliveries with it would starve precisely the delivery that
needs attention.

The tuple is also the wrong *question*. `unlockCount` ranks by how much blocked
work a task releases; a finished task releases none. `REMEDIATION` before
`NORMAL` is a statement about which work to do next, not about which finished
work to merge first.

### Why the order is load-bearing and not decoration

`F-C4` (README) records that a block produces a **stack**: `B`'s branch contains
`A`'s commits, so a pull request for `B` carries `A`'s work, and "merging out of
order is an operator decision this build does not model". Walking the
topological order means the selector never hands `B` to the driver while `A`'s
delivery is still pending.

This **narrows** `F-C4`; it does not close it, and two limits are stated rather
than implied:

- `--task B` does exactly what it always did;
- the order is read from the plan **as it is now**, which is not the frozen
  relation a block run was started against. Blocks are also undiscoverable —
  `loadBlockLedger` is lookup-by-`runId` and nothing enumerates
  `<runtime>/blocks/` — so the plan's own order is the only in-build proxy for
  that ordering, and the selector has no block concept at all.

## 3. The concluded-task problem, and the one read that solves it

`READY_FOR_PR` is terminal and stays terminal after a merge, after verification
and after conclusion. There is no `COMPLETE` state, refused on three measured
grounds in slice 10's ADR. So a scan for `state === 'READY_FOR_PR'` would hand
the same concluded task to the driver for ever.

The distinguishing read is one call:

```
loadDeliveryConclusion(repositoryRoot, taskId, { taskId, repositoryRoot })
```

`DeliveryConclusionSubject` is `{ taskId, repositoryRoot }` and nothing else
(`src/deliver/delivery-conclusion.ts:295`). No delivery target, no profile
digest, no `currentCommit`, no merge receipt, no verification history. That is
what makes slice 10's guarantee hold here without restating it: a conclusion
survives the deletion **and** the corruption of the receipt and the verification
history because this read does not touch either.

The conclusion is therefore read **first**, ahead of the task state. A concluded
task is answered and skipped without its state file being opened at all — which
also means a concluded task whose state has since become unreadable does not
block the walk. That ordering is the whole of "do not un-conclude a task whose
upstream artefacts are gone", and the test that measures it counts the state
reads.

## 4. Broken evidence is surfaced, never skipped

The default safety hypothesis was that a selector must not silently skip an
earlier canonical task whose delivery is broken, because that converts a visible
configuration failure into starvation. It survives, and the repository's own
precedent decides it:

- `discoverTasks` returns on the **first** failing candidate. One malformed task
  file makes the repository unplannable rather than dropping that task;
- `TASK_SOURCE_EMPTY` is never read as `ALL_TASKS_COMPLETE`, because "the
  alternative reading would turn a mistyped path into a confident report that
  the work is done". Skipping an unreadable delivery record is the same error in
  the same direction;
- `independenceIsEstablished` refuses the whole block rather than improvising a
  partial schedule, and `chainShapeOf` refuses the whole block at freeze rather
  than dropping the member.

The apparent counter-example does not generalise. `block-runner`'s `chooseTask`
does `continue` past a member it cannot evaluate — but over an already-frozen
membership an operator typed, where every member is enumerated in the report and
the run still ends with an explicit `endReasonFor`.

The refusal is affordable because `--task` remains the operator's way past a
blocker. That is the other half of why `--task` was not removed.

### What "broken" does *not* mean here

Deliverability is not assessed. No delivery target is resolved, no subject is
reconstructed, no profile is read. A task with no declared target is still
selected, and the **driver** answers `SUBJECT_NOT_ESTABLISHED` about it, by name.

Pre-screening it would force one of two bad choices: skip the tasks that fail —
the bypass above — or duplicate the driver's ladder, which is a second opinion
about what a deliverable task is. Only records the selector actually reads can
block it: the conclusion, and the task state.

## 5. Selection is not authority, and there is no `SelectionProof`

`mayPerform` (`src/cli/delivery-driver.ts:491`) reads `options.attended` and the
act's own flag. Nothing else. `--publish-head`, `--create-pr`, `--merge-pr` and
`--attended` authorise exactly what they authorised before, and
`delivery --drive --select-task --attended` changes nothing on github.com.

`src/deliver/internal/` holds **seven** such artefacts — four proofs and three
one-shot grants — and every one of them stands in front of an irreversible
effect or a durable write: a push, a pull-request POST, a merge, or a record
never overwritten. (The directory holds an eighth file, `delivery-ref-grammar.ts`,
which is not one of them and stands in front of nothing: its own header says it
"declares no authority and can be imported by anything", and it was extracted
precisely so that importing a regular expression would not widen the pinned set
of files that can reach a mint.) A selection is neither. The governing principle is that an opaque
artefact forces proof over assertion **where an authority is granted**; a router
grants none, and adding a proof would imply the selection carries a permission
it does not. So there is none — deliberately, and it is stated in the module
header rather than left as an absence.

The driver is pinned unable to see a selection at all: the token `select` does
not appear in `src/cli/delivery-driver.ts`, so no act can acquire a meaning from
having been selected into.

**What does change in substance**, and it is the one real semantic shift: the
*subject* of an authorised mutation becomes implicit. An operator authorises an
act without naming the task it lands on. That is why the shift is made visible
in the invocation — see §7 — and stated on the flag's own description.

## 6. Freshness: a snapshot, narrowed structurally, not locked

Almost all staleness is caught by the driver, which re-derives everything from
disk on every invocation:

| what changes in the window | what catches it |
| --- | --- |
| the task leaves `READY_FOR_PR` | `TASK_NOT_READY` |
| someone else concludes it | the conclusion is read first → `DELIVERY_CONCLUDED` |
| the target or state becomes unresolvable | `SUBJECT_NOT_ESTABLISHED` |
| the commit moves while the forge is being asked | `revalidateLocalSubject` → `SUBJECT_CHANGED` |

Two things are not caught, and both are stated rather than engineered around.

**The order.** The driver takes one task id and has no cross-task concept. It
cannot know that a canonically earlier task became pending. That is
`L-V4-12-1`. It is not closed with a lock, for the reason
`delivery-conclusion-store.ts` gives about its own read-before-write: a window
that cannot be closed without a lock is narrowed and stated, never described as
closed. The consequence is bounded — a later delivery advanced before an earlier
one, which the earlier one's own next invocation still finds waiting.

**The handed-in reading**, and this one *is* closed, structurally and for free.
The command reads the task state **once**, and that one reading supplies both the
subject and the revision the evidence binds to — its own comment says why reading
twice would be wrong. `driveDelivery` is handed that reading as a parameter.

Stated precisely, because an earlier draft of this paragraph said "`driveDelivery`
does not read the task state" and that is false: its signature also takes
`load: typeof loadTaskState`, and it passes that reader on to the act ladders,
which deliberately re-read through it to catch a subject that moved — which is
`revalidateLocalSubject → SUBJECT_CHANGED`, named in the table above. Those
re-reads are *fresher*, so they cannot be the hazard.

The hazard is a **staler** reading, and it is what a selector could have
introduced: had it read a state to make its choice and passed that
`StateLoadResult` through, the command's single read would have been replaced
rather than added to, and the evidence would bind to bytes read before the walk
instead of after it. Nothing downstream would notice. So **the selector yields a
task id only**. A test measures it as a differential — selecting adds exactly one
read to the same invocation named with `--task`, and no absolute count could
express that, because the ladders' own re-reads make the total whatever the drive
reached.

## 7. The CLI: a flag, where the sibling command needs none

`run` already registers an optional `--task <id>` — "Inspect this task instead of
the selector's choice" (`src/cli/run-command.ts:493`) — and omitting it means
"use the selector". That is the house pattern, and this slice deliberately does
**not** follow it.

`delivery` differs in what an omitted flag would cost. `run` is read-only by
default; `delivery --drive --merge-pr --attended` is not. If omitting `--task`
selected, a script that dropped the flag would merge a pull request on a task
nobody named. So omission stays refused, and selection is asked for:

```
delivery --repository <path> --drive --select-task [--publish-head|--create-pr|--merge-pr] --attended
```

Three argument refusals, decided **above the resolver** because none of them
needs a repository and an invocation that cannot say which delivery it is about
should not cost a Git subprocess to find that out:

| refusal | when |
| --- | --- |
| `TASK_NOT_NAMED` | neither `--task` nor `--select-task` |
| `TASK_NAMED_AND_SELECTED` | both — two answers to one question |
| `SELECTION_REQUIRES_DRIVE` | `--select-task` without `--drive` |

`--task` stops being a `requiredOption` and keeps its meaning: the omission is
still refused, by this command instead of by commander. **That move is
observable and is not free**, so it is stated rather than left to be discovered:
commander wrote `error: required option '--task <id>' not specified` to *stderr*
and exited **1**; this command writes `Selection    : TASK_NOT_NAMED` and its
sentence to *stdout* and exits **2**. A caller that distinguished the argument
error by exit code or by reading stderr sees something different. Two is the
right code — it is this binary's "the invocation cannot be carried out as
written, and editing it fixes that" — and stdout is where every other refusal on
this surface is written; but the change is a change. `L-V4-12-7`. Making it optional pulls
it into the live pin at `tests/v4-09-post-merge-verification.test.ts:2940` —
every non-mandatory registered option must be named in
`DELIVERY_COMMAND_DESCRIPTION` — so the description gained clauses for both
`--task` and `--select-task`, which it owed anyway.

`--select-task` composes with `--drive` and with the three act flags, and with
nothing else: the six flags that name an act one at a time still meet
`DRIVE_NOT_COMBINABLE`, unchanged.

## 8. Failure classification

| outcome | exit | why |
| --- | --- | --- |
| `DELIVERY_TASK_SELECTED` | — | not a stop; the driver's own member decides |
| `NO_DELIVERY_PENDING` | 0 | an answer, not a failure — `ALL_TASKS_COMPLETE`'s grade |
| `DELIVERY_EVIDENCE_UNREADABLE` | 3 | durable state a person must look at, like `DELIVERY_EVIDENCE_UNUSABLE` |
| a planning failure | 2 | the planner's own vocabulary, graded as every other caller grades it |

A repository whose task source is missing or empty does **not** reach
`NO_DELIVERY_PENDING`. `discoverTasks` refuses first, and with the right code for
the right world: `TASK_SOURCE_NOT_FOUND` when nothing exists at the declared path
— the mistyped-path case — and `TASK_SOURCE_EMPTY` when the directory is there
and holds no task files. Both grade 2, exactly so that neither can arrive as
"nothing to deliver".

## 9. No new durable state

Every fact the selector needs is already durable — the markdown files, the
conclusion record, the task state — and the order is recomputed from the ids
alone. The only thing a durable selection record could hold is "which task I
picked last", which is the one class the driver's own ADR already rejected, and
which README names as "keeping its own list of attempted ids — inventing
completion semantics the repository has not defined".

## 10. Where it lives, and what it may not import

`src/deliver/select-delivery-task.ts`, with the wiring in
`src/cli/delivery-command.ts`. `src/plan` cannot see a runtime state at all and
structurally cannot host it; `src/block` is the wrong direction.

Two live pins govern the module, and both are inherited automatically because
the delivery surface is **derived from the tree**:

- no value import of `state/state-store.js` anywhere under `src/deliver/`
  (`tests/v4-03-delivery-evidence.test.ts:1597-1612`), with
  `delivery-command.ts`'s `loadTaskState` the single admitted exception. So the
  state reader is a **required seam with no default** — the same argument
  `recordDeliveryConclusion` makes about its own `readStateRevision`;
- no execution lease under `src/deliver/` (`tests/v4-09:3040-3062`).

The graph arrives as a parameter, typed-imported from `src/plan`, so the module
adds no value edge from `deliver` to `plan`. `planNextTask` is composed by the
command, exactly as `selectRunTask` composes it for the run path.

## 11. Non-goals

Unchanged from slice 11 except the one line this ADR amends: no scheduler, no
polling, no sleep, no background work, no recurring execution, no cross-project
or cross-repository selection, no repository selection, no queue service, no
second delivery lifecycle, no second durable state machine, no remediation, no
unattended forge mutation, no risk-based auto-merge, and no prioritisation
invented from heuristics — the order is the plan's own and this slice defines
none.

## What was reused, and what had to be built

Reused with a **zero diff**: `planNextTask`, `normalizeTaskGraph` and its
`topologicalOrder`, `loadDeliveryConclusion`, `loadTaskState`, and
`driveDelivery` with every one of its authorities.

Extended: `render-delivery-observation.ts` — a `selection` field on the view, a
`Selected` line, a counts line, a second exported renderer for the refusals, and
a trailer. It is listed here rather than above because it is not unchanged, and
an earlier draft of this ADR put it in the line above while the paragraph below
said the slice built "one report block and one trailer" in it.

Built: one module, one flag, three closed vocabularies
(`DELIVERY_TASK_SELECTIONS`, `DELIVERY_CANDIDATE_POSITIONS`,
`TASK_NAMING_REFUSALS`), two total classification tables over vocabularies this
build already owned, one exit-code table, one report block and one trailer.

## Live dogfood: why there was none

Unchanged from `L-V4-09-7`, `L-V4-10-10` and `L-V4-11-8`: this repository has no
AO task at `READY_FOR_PR` carrying a delivery target, and fabricating one would
fabricate the evidence the driver exists to read. What *is* measured against real
bytes here is the selection itself — real task markdown read by the real
`discoverTasks`, real task-state files written by the real store, real conclusion
records with real bindings.

## Residuals

- `L-V4-12-1` — selection is not re-established before the driver acts. §6.
- `L-V4-12-2` — one malformed task file makes every delivery unselectable,
  because `discoverTasks` is all-or-nothing. `--task` is the way past it.
- `L-V4-12-3` — a task is passed over when the record that would place it is
  gone, and `ENOENT` cannot say whether it was ever there. Two shapes: the
  markdown file deleted, so the task leaves the plan and selection cannot see it
  at all (§1); and the *task state* deleted, so the task reads
  `NOT_ORCHESTRATED` and the walk goes past a delivery that may well be
  outstanding. `--task <id>` reaches the second; nothing reaches the first.
- `L-V4-12-4` — the examined list is a **prefix**, not a survey. The walk stops
  at the first pending or unreadable candidate, so the report cannot say how
  many deliveries are waiting in total, and does not claim to.
- `L-V4-12-5` — `F-C4` is narrowed, not closed. §2. And narrowed only over
  *pending* dependencies: a dependency with no task state at all is
  `NOT_ORCHESTRATED` and the walk goes past it, so a dependent stacked over a
  predecessor whose runtime record was deleted can still be handed over first.
- `L-V4-12-6` — a combinability refusal and a naming refusal print in the
  selection shape, with no subject block, because there is no task to report
  about. The `--task` path still prints the full report for the same condition.
  One condition, two shapes; both refuse, and neither depends on repository
  state, which is the property that matters.
- `L-V4-12-7` — omitting `--task` moved from commander's stderr/exit 1 to this
  command's stdout/exit 2. §7.
- `L-V4-12-8` — this slice corrected two false sentences on the CLI's own front
  page that predate it: `agent-loop --help` said "Opening pull requests is not in
  this build" (false since slice 6) and called `--publish-head` "the one thing
  any command in this build can change outside this machine" (false since slice
  6, and again since slice 7). Found by this slice's own sweep, fixed here rather
  than left standing, and named so the correction is visible rather than folded
  into an unrelated diff. A test **pinned** the first of
  those sentences (`tests/v4-05-…`, "still not in this build, and must still say
  so"), so from slice 6 onward the suite held a false claim in place — a pin
  guarding a lie, which is worse than no pin. That pin now asserts the rule
  instead: what this build refuses is *deciding* a merge is warranted.
- `L-V4-12-9` — no live product dogfood was possible. See the section above.
