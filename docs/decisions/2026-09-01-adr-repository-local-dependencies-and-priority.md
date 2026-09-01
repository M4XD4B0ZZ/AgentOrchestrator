# ADR — a dependency is repository-local, and priority may not cross the eligibility filter

*M2 slice 4. Supersedes nothing. It **completes** the ordering model V1-02 built
and `2026-08-31-adr-repository-registry-and-cross-repository-selection.md`
merged across repositories, by stating two contracts those slices left implicit
and correcting one sentence that was measurably false.*

## Why this needs a decision at all

The slice was asked for "explicit task dependency semantics across the
multi-repository task-selection path" and "explicit task priority semantics
sufficient to deterministically rank otherwise runnable work".

Measured first, on `main` at `37ced3e`, both already worked. That measurement is
the reason this is a decision rather than a feature: when the behaviour a slice
was asked to add is already shipped, the honest options are to add nothing, or to
say what is actually missing. What was missing was not behaviour. It was **a
stated contract, the tests that hold it, and a refusal an operator could read**.

## The measurement

Against the shipped selector and the shipped cross-repository planner, before any
change:

```text
== SINGLE REPOSITORY ==
S1 B dependsOn unfinished A -> selected            A
S1 B eligible?                                     false
S2 A DONE -> selected                              B
S3 HIGH vs LOW -> selected                         aHIGH
S4 blocked HIGH vs runnable LOW -> selected        A
S5 equal priority, input [B,A] -> selected         A
S5 equal priority, input [A,B] -> selected         A
S7 two-node cycle -> code                          TASK_GRAPH_CYCLE
S8 missing dependency -> code                      TASK_DEPENDENCY_UNKNOWN
self-dependency -> schema                          REFUSED
duplicate dependency -> schema                     REFUSED

== CROSS-PROJECT DEPENDENCY REFERENCE SPELLINGS ==
  dependsOn: ["beta:task-1"]                       REFUSED by TaskIdSchema
  dependsOn: ["beta/task-1"]                       REFUSED by TaskIdSchema
  dependsOn: ["../beta/task-1"]                    REFUSED by TaskIdSchema
  dependsOn: [<a real backslash>]                  REFUSED by TaskIdSchema
  dependsOn: ["task-1"]                            PARSED (the id grammar accepted it)

== CROSS REPOSITORY ==
X1 blocked a-2 in ranking?                         false
X2 blocked HIGH (alpha) vs runnable LOW (beta)     alpha/zzz-gate
X3 beta/dependent eligible?                        false   reason BLOCKED_BY_DEPENDENCIES
X4 cycle in one repository -> code                 REPOSITORY_UNPLANNABLE (TASK_GRAPH_CYCLE)
X5 forward winner == reverse winner                true
```

Nothing there is wrong. Every scenario the slice was asked to produce was
already produced.

## What was actually missing

**1. Priority never had to lose to a prerequisite.** No test in the suite made a
blocked task the *would-be winner*. There was exactly one blocked `HIGH` fixture
— `tests/task-selection.test.ts:274` — and it lost anyway at element 0 to a
`REMEDIATION` task, so deleting `selectNextTask`'s
`.filter((entry) => entry.eligible)` changed no assertion anywhere. The rule
held; nothing held the rule.

**2. The merged ranking's filter was unmeasured.** Cross-repository, the only
ineligible task in any fixture was `ALREADY_DONE`. A mutant narrowing
`if (!eligibility.eligible) continue` to "skip only the finished ones" survived
the entire slice-3 suite.

**3. Repository-locality was an emergent property, not a contract.** That a
`dependsOn` entry resolves inside its own repository's graph and nowhere else
followed from `planAcrossRepositories` calling `planNextTask` once per
repository. Nothing said it, and no test tried to break it.

**4. A qualified reference was refused anonymously.** `dependsOn: [beta:auth-1]`
failed because the task-id grammar admits no `:`, `/` or `\`, and surfaced as
`TASK_DEFINITION_INVALID` — the same code as a mistyped `priority`. The operator
could not tell a policy this product does not offer from a typo.

**5. The multi-repository report said less than the single-repository one.** It
printed `eligible: N` and never named blocked work, though
`RepositoryPlan.eligibility` already carried it; and `CrossRepositoryPlan`
forwarded a refusal's code without its sentence, so the explanation
`render-run-plan.ts` prints was computed and discarded.

## Decision

### Dependency identity is a bare task id, resolved locally

A `dependsOn` entry names a task **of the same repository**. There is no
cross-repository resolution, and this slice adds none. Cross-project references
are therefore **rejected fail-closed**, and the rejection is now named:

    TASK_DEPENDENCY_CROSS_PROJECT

It is a **narrowing of `TASK_DEFINITION_INVALID`, never a weakening of it**, and
the ordering is the whole safety argument: the classification runs only on the
branch where `safeParseTaskDefinition` has already refused, so both of its
outcomes are a refusal and there is nothing to continue to. A check placed
*before* the contract could be made to answer "not cross-project" about a
document the contract would also have refused, and the next edit would be
tempted to carry on.

Detection is on a **path or namespace separator** — `:`, `/`, `\` — in a
`dependsOn` entry that is not a legal task id. The `isValidTaskId` conjunct is
redundant today and is written out anyway, so that a later widening of the id
grammar cannot make a *legal* local dependency start reporting itself as a
cross-project reference.

An **unqualified** reference to a task that exists only next door stays
`TASK_DEPENDENCY_UNKNOWN`. `auth-1` with no qualifier is indistinguishable from
a task this repository meant to declare and did not, and naming the neighbour
would be an inference. The orchestrator does not make one.

### Satisfaction is unchanged, and that is deliberate

A dependency is satisfied by the depended-on task's `status: DONE` **in the
repository's own task file**. Not by a durable `TaskState`, and not by
`READY_FOR_PR`, which stays terminal. Making a runtime state satisfy a
prerequisite would let a plan assert a fact only the runtime knows, which is the
boundary `plan/task-definition.ts` exists to hold and the one
`run-driver.ts` states as a refusal rather than an omission.

The **block** path keeps its own, stronger rule — durable settlement plus proven
Git chain fitness (`block/chain-fitness.ts`) — and this slice does not touch it.
Two mechanisms, two questions; the distinction predates this decision.

### Priority ranks the eligible set and nothing else

Unchanged: a closed `HIGH`/`NORMAL`/`LOW` enum, never defaulted, ranked at
the third element of the tuple, behind `kind` and `currentFocus` — index 2 of
`taskRankingKey`, which is how the code and the tests spell it, and item 3 of the
README's one-based list. **No new semantics were
added and none are claimed.** What is added is the proof that priority cannot
cross the filter — in both paths, with a fixture whose blocked task wins every
element the comparator reaches before the filter would have stopped it.

### The unlock metric keeps its behaviour and loses a false sentence

`select-task.ts` carried two definitions of `unlockCount` and they disagree:

- *"distinct, not-yet-`DONE` tasks that transitively depend on this one"* — the
  implementation;
- *"the one whose completion releases more blocked work goes first"* — the
  rationale.

They come apart when a `DONE` task sits in the **middle** of a chain, because the
walk skips such a task from the count and still traverses *through* it. Measured:

```text
zz-root (OPEN) -> mid (DONE) -> c1, c2 (OPEN)     plus an unrelated aa-other

aa-other   eligible=true  unlock=0  key=[1,1,1,0,"aa-other"]
zz-root    eligible=true  unlock=2  key=[1,1,1,-2,"zz-root"]
selected : zz-root
```

`c1` and `c2` are already eligible, so finishing `zz-root` releases nothing — and
`zz-root` is ranked first on a claim that is false for this graph, beating
`aa-other`, which it would otherwise lose to on the id.

**The behaviour is left alone. The sentence is corrected.** Which of two
*runnable* tasks goes first is a preference, not a safety property: neither
reading can make a blocked task eligible, and nothing about repository binding,
containment, recovery or owned-launch accounting depends on it. The
downstream reading is what `tests/task-selection.test.ts` has pinned since V1-02
with a case written deliberately about the `DONE` walk, so changing it would flip
a decision an earlier slice made on purpose, and would re-rank plans repositories
have been written against. That is a scheduling change and deserves its own
slice. The divergent graph is now pinned by test, so the choice is stated rather
than accidental.

### Both reports tell the same amount of truth

The cross-repository report names blocked tasks and their prerequisites, in
`render-run-plan.ts`'s existing spelling, bounded at eight per repository and
counting what it did not print. Only `BLOCKED_BY_DEPENDENCIES` is listed:
`ALREADY_DONE` is finished work, not waiting work, and one heading over both
would undo the distinction `select-task.ts` keeps them apart for.

`CrossRepositoryPlan` gains `planningDetail`, forwarding the failing step's own
static sentence. For a dependency refusal that sentence *is* the policy —
`TASK_DEPENDENCY_CROSS_PROJECT` alone is a name.

## Consequences

- one new closed failure code, reachable only from a branch that already refused;
- one new nullable field on `CrossRepositoryPlan`, carrying a constant written in
  this repository and never host data;
- one report gains, **per enlisted repository**, a `blocked: N` row plus up to
  eight named rows plus an elision row — one to ten — and the existing
  `Planning` row gains the failing step's sentence;
- 41 new cases in one new suite, of which the load-bearing ones are the two that
  make a blocked task the would-be winner, single-repository and merged;
- one existing closed-set pin extended by one member
  (`tests/task-discovery.test.ts`);
- **five** sentences elsewhere that stated the refuted reading of `unlockCount`,
  corrected rather than left standing: `plan/select-task.ts`,
  `plan/task-graph.ts`, `deliver/select-delivery-task.ts`, the README's delivery
  section, and a case title in `tests/task-selection.test.ts`. A review found
  the last four; the first draft of this slice corrected one copy and called the
  sentence fixed.

Nothing else changed. No transition, no state, no lease, no boundary, no
accounting, no schema document.

## Non-goals

Explicitly not built, and none of them made harder: parallel execution, worker
pools, per-project concurrency, quotas, a persistent scheduler, recurring jobs,
timers, wake/resume machinery, notifications, reviewer-quota resilience,
automatic PR or merge, distributed orchestration, project fairness, weighted
round-robin, starvation prevention, dependency-triggered wakeups, cross-project
dependencies as a *feature*, and any general-purpose workflow or graph engine.

`unlockCount` is compared across repositories, so at equal kind, focus and
priority a larger repository's work tends to win. That is slice 3's stated
choice, restated here as a known preference rather than a defect. Fair or
weighted scheduling is a decision that needs its own slice.
