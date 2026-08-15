# V2-09 Dependent Execution / Controlled Commit Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a block whose members depend on each other: a settled predecessor's result commit becomes its successor's execution base, proved fit against real Git at the moment it is used, while the scope that governs every member stays the one frozen at the block base.

**Architecture:** Four additions and one split, all of them sited so that nothing new decides anything a durable record cannot answer for. A **pure shape layer** (`chain-shape.ts`) reads `frozenDependencies` and answers *which* predecessor a member chains onto — the unique maximum of its required set — or refuses the block. A **pure runnability rule** (`block-conclusion.ts`) says when a frozen-ineligible member becomes runnable inside this run, from the ledger's own settlements and from nothing else. An **effect-time proof** (`chain-fitness.ts`) asks Git whether that predecessor's result is actually fit to be a base. The **base becomes a parameter** of workspace preparation instead of being re-derived from the default branch inside it, and the **scope authority is split from the execution base** so an agent can hand its successor code but never additional authority. The runner and the CLI freeze site are wired to those four; no new ledger field, no new stop reason, no schema bump.

**Tech Stack:** TypeScript 7 (ESM, `nodenext`), Zod 4, Commander 15, vitest 4, GitHub Actions on `windows-latest`, Node 22 and 24.

**Design:** `Prompt.md` of 2026-08-15 (decisions E1–E3, accepted) and the V2-09 design read of the same day. There is no separate `docs/superpowers/specs/` document for this slice: the design read and the decision reply *are* the spec, and their content is reproduced in the Global Constraints below rather than referenced, so this plan is self-contained.

## Global Constraints

Every task's requirements implicitly include this section. The first three are the settled decisions and outrank anything a task says.

- **G1 — E1: the chain shape comes from `frozenDependencies`, and only from it.**

  ```text
  frozen member dependencies empty
  → base(T) = blockBaseCommit

  frozen member dependencies non-empty
  → there must be exactly one unique maximum M in the frozen transitive
    member relation
  → base(T) = resultCommit(M)

  no unique maximum
  → unsupported block input, refused at freeze
  ```

  `A1 → A2 → B` gives `base(B) = resultCommit(A2)`. `A1 → B ← A2` with `A1` and
  `A2` incomparable has no unique maximum and the **whole block** is refused
  before anything durable happens. **No implicit linearisation:** independent
  members are never stacked on one another to manufacture an order. The relation
  is read from the ledger's `frozenDependencies`, never recomputed from the
  current graph — `src/block/` must still not import `block-dependencies.ts`,
  and the V2-08 import pins stay green.

- **G2 — E2: two commit roles, and only one of them can be handed forward.**

  ```text
  executionBaseCommit    what the task's code is built on
                         = blockBaseCommit for a root member
                         = resultCommit(M) for a chained member

  scopeAuthorityCommit   which commit's profile decides the allowed scope
                         = blockBaseCommit for EVERY member of the block
  ```

  A predecessor may pass its successor code. It may never pass it authority: if
  `A` commits a profile widening `allowedPaths` to `/**`, `B` is still judged
  against the profile at `blockBaseCommit`. A legitimate profile change becomes
  authority only in a later, newly frozen invocation. **No copied profile object
  is stored anywhere.** The load-bearing value is the immutable
  `blockBaseCommit`, and scope resolution must be handed that commit explicitly:
  `readPinnedScope` may never fall back to `basePinnedCommit` on the block path.

  **And the invariant outlives the invocation, or it is not one.** A chained
  task's durable `TaskState` is an ordinary task state: it pins
  `basePinnedCommit = A.resultCommit`, and nothing in it says that some *other*
  commit governs its scope. So an invocation-scoped answer — the block runner
  handing the authority to the driver it starts — protects the run and nothing
  after it. The counter-example is representable and is not exotic:

  ```text
  block run:   blockBase = M0,  A settles at A1 (A1 widens the profile),
               B is started chained at A1 and the invocation then dies

  later:       the roadmap says A is DONE, but the authoritative default branch
               does not contain A1 - A was squash-merged, reworked, or the
               status was simply written by hand

  standalone:  agent-loop run --attended --task B
               eligibility now passes, B's existing state is used,
               the scope is read from B.basePinnedCommit = A1
               -> agent A decides B's scope after all
  ```

  So the two roles are separated **in the durable record**: `TaskState` gains
  `scopeAuthorityCommit`, written once at start, `null` meaning *this task's own
  base pin governs*. Task 6 establishes it and states why it needs no schema
  version bump. Roadmap `DONE` is **not** evidence about Git and is nowhere
  treated as such: an earlier draft of this plan argued that a human marking `A`
  done had thereby accepted `A`'s profile change, and that inference is
  unsupported — `status: DONE` is a markdown field, and it says nothing about
  which commits reached the default branch or in what shape.

- **G3 — E3: `SETTLED` is a disposition; `SETTLED + chain-fit` is a satisfied dependency.**

  ```text
  runnable(T) :=
      frozenEligible(T)
    OR (
      frozen ineligibility of T is BLOCKED_BY_DEPENDENCIES
      AND every unsatisfied dependency of T is a block member
      AND every such member is SETTLED in this ledger
      AND the selected successor base is chain-fit
    )
  ```

  A dependency on a **non-member** stays a hard dead end — the ledger cannot
  satisfy what it does not hold — and ends the run `NO_ELIGIBLE_TASK` as before.
  **No roadmap file is ever written.** The two conditions do not subsume one
  another and both are required: runnability is answered from the planner's
  *direct* `unsatisfiedDependencies`, chain fitness from the frozen *transitive*
  required set, and Task 7's controls include the case where one holds and the
  other does not.

- **G4 — chain fitness is proved at the effect, against real Git, in this order.**
  For a chained member `T` with unique maximum `M` and required predecessor set
  `R`:

  ```text
  1. every P in R is SETTLED in this ledger        else PREDECESSOR_NOT_SETTLED
  2. M's entry carries a resultCommit              else PREDECESSOR_RESULT_ABSENT
  3. that commit exists as a commit object         else BASE_OBJECT_ABSENT
                                                    / BASE_OBJECT_UNREADABLE
  4. some ref contains it                          else BASE_NOT_REFERENCED
  5. blockBaseCommit is ancestor-or-equal of it    else BASE_NOT_DESCENDED_FROM_BLOCK_BASE
  6. every P in R has its resultCommit
     ancestor-or-equal of it                       else BASE_MISSING_REQUIRED_PREDECESSOR
  7. the empty-row members of this ledger that
     carry a baseCommit at all carry exactly ONE
     distinct value, and it is blockBaseCommit     else CHAIN_ANCHOR_MISSING
                                                    / CHAIN_ANCHOR_AMBIGUOUS
  ```

  Rule 6 is the general form of the sharpening: *the result commit of the unique
  maximum must actually contain every settled member predecessor required for
  `T`.* It is what excludes a `READY_FOR_PR` record from an older run, which
  `applyForcedProgress` may legitimately settle and which does not thereby
  authorise this chain.

  Rule 7 is the **chain anchor**, and it is a cardinality rule rather than an
  existence one. Existence alone does not make `blockBaseCommit` *derivable* from
  the ledger, which was the point of having it:

  ```text
  R1  frozen row []   baseCommit = M0     started by this run
  R2  frozen row []   baseCommit = M1     forced-settled from an older run

  reader of the durable document alone:
    "blockBase := the baseCommit of an empty-row member"  ->  M0 or M1
  ```

  Two answers is no answer. So the set

  ```text
  { entry.baseCommit | empty frozen row, baseCommit != null }
  ```

  must have cardinality exactly 1 before any chained start proceeds, and its one
  element must be the `blockBaseCommit` this invocation is running under. More
  than one distinct value is `CHAIN_ANCHOR_AMBIGUOUS` — a document with two
  answers. No value, or one value that is not this invocation's base, is
  `CHAIN_ANCHOR_MISSING` — a document with no answer of ours, and the same
  instruction to the operator: start this block from its root. Both are refusals,
  never repairs. The rule is evaluated only on a chained start, so a wholly
  independent block is unaffected by it.

- **G5 — no new ledger field, no new stop reason, no ledger schema bump; exactly
  one new task-state field, and no task-state version bump either.** A chain
  refusal is a start-gate refusal: `RUN_GATE_REFUSED`, detail = the fitness
  code, entry stays `PLANNED`, ledger byte-identical across it. The chain is
  read out of `frozenDependencies` plus `entry.baseCommit` plus
  `entry.resultCommit` plus the anchor, and that side of the hypothesis holds in
  full.

  The one addition is `TaskState.scopeAuthorityCommit`, and it is the minimal
  state change G2 forces: there is no existing durable authority that preserves
  the governing scope commit past the block invocation, and the alternatives were
  checked one by one rather than assumed away (see the counter-proof below). It
  is **additive, nullable and defaulted**, so a state written before this slice
  parses unchanged and means exactly what it meant — `null` is *"this task's own
  base pin governs"*, which is true of every pre-V2-09 task by construction,
  since no pre-V2-09 task has a base authored by a sibling. Nothing is invented
  for an old document, which is the whole reason the ledger's version-1 refusal
  was right and a version bump here would be theatre. The other direction fails
  closed on its own: an older build meeting a state that carries the field
  refuses it at its `.strict()` boundary.

  If any task finds a further decision that cannot be reconstructed from durable
  evidence, the plan stops for a decision — it does not pre-emptively grow a
  second field.

- **G6 — every control addresses both directions.** For each new guard, a
  sensitivity case (the unsafe mutant must turn it red) *and* a specificity case
  (the nearest semantically permitted variant must keep it green). A guard that
  only ever refuses is satisfiable by refusing everything, and the chain guard is
  exactly that shape.

- **G7 — operator-facing truth is derived from the same authoritative state that
  determines the outcome.** Renderer controls assert what a sentence *claims*
  against the persisted reason, including negative assertions. Measured
  precondition: the V2-08 controls accept a table in which `TASK_BLOCKED` and
  `NO_ELIGIBLE_TASK` have exchanged sentences — non-empty, distinct, ASCII, no
  forbidden phrase — so an operator reads "no frozen member was eligible to run"
  for a run whose ledger holds a `BLOCKED` task. Task 8 kills that mutant.

- **G8 — test budget, and it is part of the design.** Baseline measured before
  planning, on this machine, canonical gate green:

  ```text
  npm run verify              289.4 s
    test:foundation-safe      261.7 s   79 files, 2928 tests
    everything else            27.7 s

  inside tests/v2-08-attended-block-runner.test.ts (142 tests):
    100 tests < 100 ms        0.14 s total
     23 tests >   2 s       129.2 s total   = 85 % of the file
  ```

  So the budget is a *count*, not a second limit: **pure tests unlimited; at most
  8 new tests over 2 s, each carrying the defect it proves that a cheaper test
  cannot; exactly 2 full driver E2E controls.** No load-bearing control is
  deleted for speed. Task 11 re-measures with the same script —
  `scripts/measure-verify.sh`, committed with this plan for exactly that reason,
  since a comparison is only worth making if both sides were measured the same
  way — and attributes any material increase to named controls.

- **G9 — V2-09 opens no new platform, ownership or recovery surface.** Attended
  only. Sequential only. No unattended mode, no stale-lease recovery, no process
  containment, no parallel execution, no resume across invocations, no outgoing
  transition from `READY_FOR_PR`, and no product-side PR/CI/merge concept.

- **G10 — delivery.** `PR_REQUIRED` + `CI_REQUIRED` (`CLAUDE.md`). Never commit
  to `main`. Branch: `feat/v2-09-dependent-commit-chain`. Run `npm run typecheck`
  before every commit and **every commit compiles**. The canonical gate is
  `npm run verify`; run it at Task 11 and before opening the PR. Every commit
  message ends with:

  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BaE9b5RWjuCCPZqapWPSXK
  ```

## The deadlock this plan exists to remove

A dependent member is not merely unscheduled today — it is **unreachable**.
`chooseTask` filters candidates against the frozen snapshot
`planning.selection.eligibility` (`src/block/block-runner.ts:351`, `:733`), and
`startPlannedTask` gates each start against the same reading
(`src/run/start-task.ts:422`). The planner calls a task eligible only when every
direct dependency has roadmap status `DONE` (`src/plan/select-task.ts:209`). For
a block containing `A → B`, `A` must be `OPEN` at freeze — otherwise `A` itself
is `ALREADY_DONE` and cannot run — so `B` is `BLOCKED_BY_DEPENDENCIES` at freeze
and there is no second reading (F-B1, deliberate). `B` therefore never runs, in
any block, and the run ends `NO_ELIGIBLE_TASK`.

That is stronger than what F-B2 and F-B4 record, and the README understates it:
F-B4 reserves `NO_ELIGIBLE_TASK` for "a member whose path to eligibility runs
through a **non-member**". Before V2-09 a **member** dependency ends the same
way. Task 10 corrects that sentence, and it is a correction about V2-08's
behaviour — it must not be re-told as though V2-09 introduced the case.

The fix keeps F-B1 exactly as it is: no second roadmap reading is taken. What is
added is the run's own durable evidence, which is monotone (`PLANNED → SETTLED`)
and already proved against each task's record before it is written.

## The B-6 counter-proof, run

> Can the whole chain authority be proved from `frozenDependencies` +
> `entry.baseCommit` + `entry.resultCommit` + `SETTLED` + effect-time Git proofs
> + the invocation's `blockBaseCommit`?

Answered per decision, before any code:

| Decision | Reconstructible from | Verdict |
| --- | --- | --- |
| which predecessor `T` chains onto | `frozenDependencies` (pure) | yes |
| `T`'s execution base | `entry(M).resultCommit`, itself re-proved against `M`'s task record on every write | yes |
| the base is real, referenced, descended, containing | Git, re-runnable later from the same inputs | yes — a gate, never a stored answer |
| `blockBaseCommit`, from the ledger | the empty-row entries' `baseCommit` | only under rule 7's **cardinality** form |
| the scope authority of a chained task, after the run | nothing | **no — the hypothesis falls here** |

The first gap is closed by rule 7 as G4 now states it. Existence was not enough:
one empty-row member started by this run and one forced-settled from an older run
give a later reader two candidate values and therefore no answer. Cardinality one
makes the value *derivable*; the price is a refusal in the mixed case, carried as
F-C1.

**The second gap is real and no existing durable authority closes it.** Checked
one by one before proposing anything:

| Candidate authority | Why it does not answer |
| --- | --- |
| `TaskState` fields | the only commits it holds are `basePinnedCommit` and `currentCommit`; neither is the scope authority for a chained task, and `baseBranch` is a branch name |
| the block ledger | orchestration truth a task path may not consult; not findable from a task id; and two runs may legitimately hold the same task, so it can give two answers |
| Git refs | nothing names the block base; `merge-base(pin, defaultBranch)` is an inference that moves whenever the default branch moves or is rewritten, and it would silently *change* the governing profile over time |
| the roadmap | `status: DONE` is a markdown field. It is not evidence about Git, about what reached the default branch, or about the shape it arrived in |

The last row is where the previous draft of this plan was wrong, and it is worth
naming as an error rather than quietly replacing: it argued that once `A` is
roadmap-`DONE` a human has accepted `A`'s commits, so `A`'s widened profile is no
longer self-authorisation. That inference is unsupported. `A` can be squash-merged
without the profile hunk, reworked before merge, or simply marked done by hand,
and `B`'s durable state still pins `A1`. The gate ordering in `start-task.ts`
(eligibility at `:422` ahead of `ALREADY_STARTED` at `:443`) does close the window
*while* `A` is not `DONE` — that part stands and is still worth a control — but it
buys invocation safety, not the durable invariant G2 requires.

So the minimal state change is taken exactly there, and nowhere else:
`TaskState.scopeAuthorityCommit`, additive, nullable, defaulted, no version bump
(G5). With it, the scope authority of every task is answerable from the task's own
durable record, by the module that already reads that record, forever — and no
ledger field, stop reason or ledger version was needed for any of it.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/block/chain-shape.ts` *(create)* | Pure. The unique maximum of a member's frozen required set; the whole-block shape verdict. Freeze-time and run-time readers share it; it computes no relation of its own. |
| `src/worktree/commit-probes.ts` *(create)* | The two Git exit-status protocols in one place — object presence and ancestry — plus "is this commit contained in any ref". Extracted from `observe-runtime.ts` so there is one implementation, not two. |
| `src/block/chain-fitness.ts` *(create)* | Effect-time proof that a predecessor's result is fit to be this member's base. The eight refusals of G4, in that precedence order. |
| `src/worktree/prepare-workspace.ts` *(modify)* | `WorkspaceBase` as a required option; `proveSourcePreflight` splits checkout proof from base resolution; two new refusals for a pinned base that does not resolve. |
| `src/worktree/adopt-workspace.ts` *(modify)* | Adoption is assessed against the base it was *told*, never against a re-derived default-branch tip. |
| `src/run/start-task.ts` *(modify)* | `PlannedStartRequest` carries `base`, `scopeAuthorityCommit` and `satisfiedDependencies`; `firstState` writes the authority into the first durable record; the eligibility gate accepts a frozen-ineligible member exactly on G3's terms. `startTask` keeps today's behaviour and passes `null`. |
| `src/core/internal/task-state-object-schema.ts` *(modify)* | `scopeAuthorityCommit`: a full Git object name, nullable, defaulted to `null`. No version bump — see G5. |
| `schemas/task-state.schema.json` *(regenerate)* | `npm run schema:generate`. Never hand-edited; a test fails if it drifts. |
| `src/block/block-conclusion.ts` *(modify)* | `memberRunnability` — the pure G3 rule over the planner's eligibility report and the ledger's entries. |
| `src/block/block-runner.ts` *(modify)* | `blockBaseCommit` in the request; the runnable set recomputed per iteration; the chained base chosen, proved, and handed to the start path together with the scope authority. |
| `src/scope/assess-scope.ts` *(modify)* | Two commits, not one: the delta is measured from the base pin, the declaration is read from the scope authority. |
| `src/loop/loop-step.ts` *(modify)* | The scope gate passes `state.scopeAuthorityCommit`, falling back to the base pin in exactly one place. |
| `src/cli/block-command.ts` *(modify)* | Captures `blockBaseCommit` under the lease at the same instant as the plan; refuses a block with no chain shape; reports both. |
| `src/cli/render-block-run.ts` *(modify)* | Sentences for the new refusal detail; the semantic renderer controls' subject. |
| `tests/v2-09-dependent-commit-chain.test.ts` *(create)* | Every control of this slice. |
| `tests/v2-08-attended-block-runner.test.ts` *(modify)* | Re-based onto the new request and start signatures; the import pins stay. |
| `tests/start-task.test.ts`, `tests/worktree-lifecycle.test.ts`, `tests/worktree-races.test.ts`, `tests/v2-06-scope-enforcement.test.ts`, `tests/v2-06a-workspace-adoption.test.ts`, `tests/helpers/e2e-fixtures.ts` *(modify)* | Mechanical: the new required arguments. |
| `tests/task-state.test.ts`, `tests/public-state-api.test.ts`, `tests/schema-generation.test.ts` *(modify)* | The new state field: its contract, that it is not a new public export, and that the generated JSON schema matches. |
| `README.md` *(modify)* | The V2-09 narrative, the F-B4 correction, the follow-up register, the roadmap. |

---

### Task 1: The chain shape, pure

**Files:**
- Create: `src/block/chain-shape.ts`
- Create: `tests/v2-09-dependent-commit-chain.test.ts`

**Interfaces:**
- Consumes: `FrozenTaskDependency` from `src/block/block-definition.ts`.
- Produces: `uniqueMaximumOf(dependencies, taskId): UniqueMaximumResult`,
  `chainShapeOf(dependencies): ChainShapeResult`, `CHAIN_SHAPE_REFUSALS`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { chainShapeOf, uniqueMaximumOf } from '../src/block/chain-shape.js';

const rows = (spec: Record<string, readonly string[]>) =>
  Object.entries(spec).map(([taskId, dependsOn]) => ({ taskId, dependsOn }));

describe('the chain shape is read from the frozen relation', () => {
  it('gives a member with no frozen predecessor no maximum, and that is not a refusal', () => {
    const result = uniqueMaximumOf(rows({ 'task-a': [], 'task-b': [] }), 'task-a');
    expect(result).toEqual({ ok: true, maximum: null });
  });

  it('names the deepest predecessor of a path as the maximum', () => {
    // The relation is transitive by construction, so B's row lists both.
    const relation = rows({ 'task-a1': [], 'task-a2': ['task-a1'], 'task-b': ['task-a1', 'task-a2'] });
    expect(uniqueMaximumOf(relation, 'task-b')).toEqual({ ok: true, maximum: 'task-a2' });
    expect(uniqueMaximumOf(relation, 'task-a2')).toEqual({ ok: true, maximum: 'task-a1' });
  });

  it('refuses two incomparable predecessors rather than choosing one', () => {
    const relation = rows({ 'task-a1': [], 'task-a2': [], 'task-b': ['task-a1', 'task-a2'] });
    expect(uniqueMaximumOf(relation, 'task-b')).toEqual({ ok: false, code: 'NO_UNIQUE_MAXIMUM' });
  });

  it('refuses a member the relation does not hold a row for', () => {
    expect(uniqueMaximumOf(rows({ 'task-a': [] }), 'task-z')).toEqual({
      ok: false,
      code: 'TASK_NOT_IN_RELATION',
    });
  });

  it('judges the whole block, and names the first member that has no shape', () => {
    expect(chainShapeOf(rows({ 'task-a1': [], 'task-a2': ['task-a1'], 'task-b': ['task-a1', 'task-a2'] })))
      .toEqual({ ok: true });
    expect(chainShapeOf(rows({ 'task-a1': [], 'task-a2': [], 'task-b': ['task-a1', 'task-a2'] })))
      .toEqual({ ok: false, code: 'NO_UNIQUE_MAXIMUM', taskId: 'task-b' });
  });

  // Specificity (G6): the shape rule must not refuse the blocks V2-08 already runs.
  it('accepts a wholly independent block, which is the shape V2-08 supports', () => {
    expect(chainShapeOf(rows({ 'task-a': [], 'task-b': [], 'task-c': [] }))).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts`
Expected: FAIL — cannot resolve `../src/block/chain-shape.js`.

- [ ] **Step 3: Write the module**

```ts
/**
 * Which predecessor a member chains onto — read from the frozen relation.
 *
 * ── Why a maximum, and why it must be unique ───────────────────────────────
 *
 * A chained member is built on *one* commit. Its predecessors must therefore be
 * totally ordered among themselves, so that the last of them contains all the
 * others: `A1 → A2 → B` gives `base(B) = result(A2)`, and `A2`'s history already
 * contains `A1`'s. Two incomparable predecessors have no such commit, and the
 * only ways to invent one are to merge (a Git effect this slice does not make)
 * or to pick one and silently drop the other's work. Both are refused: the block
 * is unsupported input, exactly as V2-08 treats a relation its runner cannot
 * schedule.
 *
 * ── Pure, and reading a relation somebody else computed ────────────────────
 *
 * `dependsOn` is the **transitive** projection onto block members, computed once
 * at freeze time by `block-dependencies.ts` and bound into the fingerprint. That
 * is what makes the test below a set containment rather than a graph walk: `M`
 * dominates the required set exactly when every other required member appears in
 * `M`'s own row. This module walks nothing, asks Git nothing, and must never
 * import the projection — the relation arrives as data.
 */

import type { FrozenTaskDependency } from './block-definition.js';

/** Every way a shape question is refused. A closed set. */
export const CHAIN_SHAPE_REFUSALS = [
  /** The required predecessors are not totally ordered, so no commit holds all of them. */
  'NO_UNIQUE_MAXIMUM',
  /**
   * The relation has no row for the member asked about.
   *
   * Unreachable through a validated ledger — rule 1a requires one row per frozen
   * task — and answered rather than thrown, so a caller cannot receive a shape
   * for a member the relation is silent about.
   */
  'TASK_NOT_IN_RELATION',
] as const;

export type ChainShapeRefusal = (typeof CHAIN_SHAPE_REFUSALS)[number];

export type UniqueMaximumResult =
  /** `maximum` is `null` exactly when the member has no frozen member predecessor. */
  | { readonly ok: true; readonly maximum: string | null }
  | { readonly ok: false; readonly code: ChainShapeRefusal };

export type ChainShapeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ChainShapeRefusal; readonly taskId: string };

/** The one member of `taskId`'s required set that contains all the others. */
export function uniqueMaximumOf(
  dependencies: readonly FrozenTaskDependency[],
  taskId: string,
): UniqueMaximumResult {
  const row = dependencies.find((entry) => entry.taskId === taskId);
  if (row === undefined) return Object.freeze({ ok: false as const, code: 'TASK_NOT_IN_RELATION' as const });
  if (row.dependsOn.length === 0) return Object.freeze({ ok: true as const, maximum: null });

  const reach = new Map(dependencies.map((entry) => [entry.taskId, new Set(entry.dependsOn)]));
  const dominating = row.dependsOn.filter((candidate) => {
    const below = reach.get(candidate);
    // A required member the relation holds no row for cannot be shown to contain
    // anything, so it never dominates. Fail-closed rather than assumed empty.
    if (below === undefined) return false;
    return row.dependsOn.every((other) => other === candidate || below.has(other));
  });

  return dominating.length === 1
    ? Object.freeze({ ok: true as const, maximum: dominating[0] as string })
    : Object.freeze({ ok: false as const, code: 'NO_UNIQUE_MAXIMUM' as const });
}

/** Whether every member of the block has a chain shape. Freeze-time gate. */
export function chainShapeOf(dependencies: readonly FrozenTaskDependency[]): ChainShapeResult {
  for (const row of dependencies) {
    const maximum = uniqueMaximumOf(dependencies, row.taskId);
    if (!maximum.ok) {
      return Object.freeze({ ok: false as const, code: maximum.code, taskId: row.taskId });
    }
  }
  return Object.freeze({ ok: true as const });
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/block/chain-shape.ts tests/v2-09-dependent-commit-chain.test.ts
git commit -m "feat: the chain shape, read from the frozen relation (V2-09)"
```

---

### Task 2: One implementation of each Git exit-status protocol

**Files:**
- Create: `src/worktree/commit-probes.ts`
- Modify: `src/state/observe-runtime.ts` (lines 110–181, and the two call sites at 246 and 257)
- Test: `tests/v2-09-dependent-commit-chain.test.ts`

**Interfaces:**
- Produces: `classifyAncestry(git, cwd, ancestor, descendant): Promise<AncestryVerdict>`,
  `commitObjectPresent(git, cwd, commit): Promise<boolean | null>`,
  `commitIsReferenced(git, cwd, commit): Promise<boolean | null>`.

Why this task exists: `observe-runtime.ts` already implements both exit-status
protocols correctly and documents them (`:120`, `:148`). Task 3 needs both plus a
third. Writing them again would be a second opinion about what `merge-base
--is-ancestor` exit 128 means, and the two would drift.

- [ ] **Step 1: Write the failing test**

```ts
import { classifyAncestry, commitIsReferenced, commitObjectPresent } from '../src/worktree/commit-probes.js';

const gitReturning = (result: Partial<{ outcome: string; stdout: string; exitCode: number | null }>) =>
  async () => ({ outcome: 'OK', stdout: '', exitCode: 0, ...result }) as never;

describe('the commit probes separate an answer from a refusal to answer', () => {
  it('reads exit 1 as a genuine "no" and 128 as "could not evaluate"', async () => {
    expect(await classifyAncestry(gitReturning({ outcome: 'OK' }), 'C:/r', 'a', 'b')).toBe('ANCESTOR');
    expect(await classifyAncestry(gitReturning({ outcome: 'NONZERO_EXIT', exitCode: 1 }), 'C:/r', 'a', 'b'))
      .toBe('NOT_ANCESTOR');
    expect(await classifyAncestry(gitReturning({ outcome: 'NONZERO_EXIT', exitCode: 128 }), 'C:/r', 'a', 'b'))
      .toBe('INDETERMINATE');
    expect(await classifyAncestry(gitReturning({ outcome: 'UNAVAILABLE', exitCode: null }), 'C:/r', 'a', 'b'))
      .toBe('INDETERMINATE');
  });

  it('answers presence only on exit 0 and exit 1', async () => {
    expect(await commitObjectPresent(gitReturning({ outcome: 'OK' }), 'C:/r', 'a')).toBe(true);
    expect(await commitObjectPresent(gitReturning({ outcome: 'NONZERO_EXIT', exitCode: 1 }), 'C:/r', 'a')).toBe(false);
    expect(await commitObjectPresent(gitReturning({ outcome: 'NONZERO_EXIT', exitCode: 128 }), 'C:/r', 'a')).toBeNull();
  });

  it('calls a commit referenced when some ref contains it, and unknown when Git could not say', async () => {
    expect(await commitIsReferenced(gitReturning({ outcome: 'OK', stdout: 'refs/heads/agent/task-a' }), 'C:/r', 'a'))
      .toBe(true);
    expect(await commitIsReferenced(gitReturning({ outcome: 'OK', stdout: '' }), 'C:/r', 'a')).toBe(false);
    expect(await commitIsReferenced(gitReturning({ outcome: 'UNAVAILABLE', exitCode: null }), 'C:/r', 'a')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts -t 'commit probes'`
Expected: FAIL — cannot resolve `../src/worktree/commit-probes.js`.

- [ ] **Step 3: Write the module**

Move the two functions from `observe-runtime.ts` verbatim, generalising
`classifyAncestry` from the hardwired `HEAD` to a `descendant` argument, and add
the third probe:

```ts
/**
 * `true` when some ref contains `commit`.
 *
 * Existence and reachability are different facts and the chain needs both. An
 * object that exists but no ref contains is either about to be pruned or is the
 * discarded tip of a branch somebody deleted — chaining onto the second would
 * resurrect abandoned work into a successor's pull request, silently.
 *
 * `--count=1` because the question is existential; the ref that answers it is
 * not interesting and must not reach an operator-facing report.
 */
export async function commitIsReferenced(
  git: GitRunner,
  cwd: string,
  commit: string,
): Promise<boolean | null> {
  const probe = await git(cwd, ['for-each-ref', '--count=1', `--contains=${commit}`, '--format=%(refname)']);
  if (probe.outcome !== 'OK') return null;
  return probe.stdout.length > 0;
}
```

- [ ] **Step 4: Rebase `observe-runtime.ts` onto it**

Delete the two local functions, import the shared ones, and pass `'HEAD'` as the
descendant at `:246`. Nothing else changes; the ancestry semantics there are
identical.

- [ ] **Step 5: Prove the extraction changed no behaviour**

Run: `npx vitest run tests/state-reconciliation.test.ts tests/run-persistence.test.ts tests/v2-09-dependent-commit-chain.test.ts`
Expected: PASS. These are the suites that exercise `observeRuntime`'s ancestry
and presence answers; a changed protocol reddens them.

- [ ] **Step 6: Commit**

```bash
git add src/worktree/commit-probes.ts src/state/observe-runtime.ts tests/v2-09-dependent-commit-chain.test.ts
git commit -m "refactor: one implementation of each Git exit-status protocol (V2-09)"
```

---

### Task 3: Chain fitness, proved at the effect

**Files:**
- Create: `src/block/chain-fitness.ts`
- Test: `tests/v2-09-dependent-commit-chain.test.ts`

**Interfaces:**
- Consumes: `commit-probes.ts`; `BlockRunLedger`, `BlockTaskEntry`, `entryFor` from `block-ledger.ts`.
- Produces: `CHAIN_BASE_REFUSALS`, `proveChainBase(git, repositoryRoot, input): Promise<ChainBaseResult>` with
  `input: { ledger, taskId, maximum, blockBaseCommit }` and
  `ChainBaseResult = { ok: true; commit: string } | { ok: false; code: ChainBaseRefusal }`.

- [ ] **Step 1: Write the failing test**

Drive every branch with an injected `GitRunner` — no repository, milliseconds.
The ledger is built by a local helper that produces a schema-valid document.

```ts
describe('a predecessor result is proved fit before it becomes a base', () => {
  // git answers keyed by the first two argv words, so a case states only what it changes.
  const gitAnswering = (answers: Record<string, { outcome: string; stdout?: string; exitCode?: number }>) =>
    (async (_cwd: string, args: readonly string[]) => {
      const key = `${args[0]} ${args[1]}`;
      const answer = answers[key] ?? { outcome: 'OK', stdout: '', exitCode: 0 };
      return { stdout: '', exitCode: 0, ...answer };
    }) as never;

  it('proves a settled predecessor whose result is real, referenced and descended', async () => {
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedger({ a2: { disposition: 'SETTLED', resultCommit: RESULT } }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: true, commit: RESULT });
  });

  it.each([
    ['PREDECESSOR_NOT_SETTLED', { a2: { disposition: 'ACTIVE' } }, {}],
    ['PREDECESSOR_RESULT_ABSENT', { a2: { disposition: 'SETTLED', resultCommit: null } }, {}],
    ['BASE_OBJECT_ABSENT', {}, { 'rev-parse --verify': { outcome: 'NONZERO_EXIT', exitCode: 1 } }],
    ['BASE_OBJECT_UNREADABLE', {}, { 'rev-parse --verify': { outcome: 'NONZERO_EXIT', exitCode: 128 } }],
    ['BASE_NOT_REFERENCED', {}, { 'for-each-ref --count=1': { outcome: 'OK', stdout: '' } }],
    ['BASE_NOT_DESCENDED_FROM_BLOCK_BASE', {}, { 'merge-base --is-ancestor': { outcome: 'NONZERO_EXIT', exitCode: 1 } }],
  ])('refuses with %s', async (code, entries, answers) => {
    const result = await proveChainBase(gitAnswering(answers), 'C:/r', {
      ledger: chainLedger(entries),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: false, code });
  });

  it('refuses a maximum whose history does not contain a required predecessor', async () => {
    // A1 is settled from an older run: its result is not in A2's history.
    // Only the second ancestry probe answers "no", which is what separates this
    // refusal from BASE_NOT_DESCENDED_FROM_BLOCK_BASE.
    let call = 0;
    const git = (async (_cwd: string, args: readonly string[]) => {
      if (args[0] !== 'merge-base') return { outcome: 'OK', stdout: 'refs/heads/x', exitCode: 0 };
      call += 1;
      return call === 1
        ? { outcome: 'OK', stdout: '', exitCode: 0 }
        : { outcome: 'NONZERO_EXIT', stdout: '', exitCode: 1 };
    }) as never;
    const result = await proveChainBase(git, 'C:/r', {
      ledger: chainLedger({
        a1: { disposition: 'SETTLED', resultCommit: FOREIGN },
        a2: { disposition: 'SETTLED', resultCommit: RESULT },
      }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: false, code: 'BASE_MISSING_REQUIRED_PREDECESSOR' });
  });

  it('refuses when no member of this run is recorded at the block base', async () => {
    // Every root came from an older run, so nothing durable names this base.
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedger({ a1: { baseCommit: FOREIGN }, a2: { disposition: 'SETTLED', resultCommit: RESULT } }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: false, code: 'CHAIN_ANCHOR_MISSING' });
  });

  it('refuses when the empty-row members name two different bases', async () => {
    // R1 was started by this run at BASE; R2 was forced-settled from an older
    // run at FOREIGN. The anchor exists, and a later reader of this document
    // alone still cannot say which commit the block was frozen on.
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedgerWithRoots({ 'task-r1': BASE, 'task-r2': FOREIGN }, {
        a2: { disposition: 'SETTLED', resultCommit: RESULT },
      }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: false, code: 'CHAIN_ANCHOR_AMBIGUOUS' });
  });

  // Specificity (G6): the anchor must not refuse the ordinary chain.
  it('accepts several roots that all name the same base', async () => {
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedgerWithRoots({ 'task-r1': BASE, 'task-r2': BASE }, {
        a2: { disposition: 'SETTLED', resultCommit: RESULT },
      }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: true, commit: RESULT });
  });

  // An empty-row member that has not started yet carries no baseCommit, and a
  // PLANNED entry must not count against the cardinality.
  it('ignores an empty-row member that has not started', async () => {
    const result = await proveChainBase(gitAnswering({}), 'C:/r', {
      ledger: chainLedgerWithRoots({ 'task-r1': BASE, 'task-r2': null }, {
        a2: { disposition: 'SETTLED', resultCommit: RESULT },
      }),
      taskId: 'task-b',
      maximum: 'task-a2',
      blockBaseCommit: BASE,
    });
    expect(result).toEqual({ ok: true, commit: RESULT });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts -t 'proved fit'`
Expected: FAIL — cannot resolve `../src/block/chain-fitness.js`.

- [ ] **Step 3: Write the module**

Structure, with the precedence order of G4 and one comment per refusal saying
what an operator does about it:

```ts
export const CHAIN_BASE_REFUSALS = [
  'PREDECESSOR_NOT_SETTLED',
  'PREDECESSOR_RESULT_ABSENT',
  'BASE_OBJECT_ABSENT',
  'BASE_OBJECT_UNREADABLE',
  'BASE_NOT_REFERENCED',
  'BASE_NOT_DESCENDED_FROM_BLOCK_BASE',
  'BASE_MISSING_REQUIRED_PREDECESSOR',
  'CHAIN_ANCHOR_MISSING',
  'CHAIN_ANCHOR_AMBIGUOUS',
] as const;

export async function proveChainBase(
  git: GitRunner,
  repositoryRoot: string,
  input: {
    readonly ledger: BlockRunLedger;
    readonly taskId: string;
    readonly maximum: string;
    readonly blockBaseCommit: string;
  },
): Promise<ChainBaseResult> {
  const { ledger, taskId, maximum, blockBaseCommit } = input;
  const required = ledger.frozenDependencies.find((row) => row.taskId === taskId)?.dependsOn ?? [];

  // 1 + 2. What the ledger must already say, before Git is asked anything.
  for (const predecessor of required) {
    const entry = entryFor(ledger, predecessor);
    if (entry === null || entry.disposition !== 'SETTLED') return refuse('PREDECESSOR_NOT_SETTLED');
  }
  const candidate = entryFor(ledger, maximum)?.resultCommit ?? null;
  if (candidate === null) return refuse('PREDECESSOR_RESULT_ABSENT');

  // 3–4. The object, then its reachability. Existence is not enough: an
  // unreferenced tip is discarded work, and chaining onto it would resurrect it.
  const present = await commitObjectPresent(git, repositoryRoot, candidate);
  if (present === null) return refuse('BASE_OBJECT_UNREADABLE');
  if (!present) return refuse('BASE_OBJECT_ABSENT');
  const referenced = await commitIsReferenced(git, repositoryRoot, candidate);
  if (referenced === null) return refuse('BASE_OBJECT_UNREADABLE');
  if (!referenced) return refuse('BASE_NOT_REFERENCED');

  // 5. The chain has not left the line the block was frozen on.
  const fromBase = await classifyAncestry(git, repositoryRoot, blockBaseCommit, candidate);
  if (fromBase === 'INDETERMINATE') return refuse('BASE_OBJECT_UNREADABLE');
  if (fromBase === 'NOT_ANCESTOR') return refuse('BASE_NOT_DESCENDED_FROM_BLOCK_BASE');

  // 6. The maximum really contains every predecessor this member requires. This
  // is what a `READY_FOR_PR` record from an older run cannot satisfy.
  for (const predecessor of required) {
    if (predecessor === maximum) continue;
    const result = entryFor(ledger, predecessor)?.resultCommit;
    if (result === null || result === undefined) return refuse('PREDECESSOR_RESULT_ABSENT');
    const contained = await classifyAncestry(git, repositoryRoot, result, candidate);
    if (contained === 'INDETERMINATE') return refuse('BASE_OBJECT_UNREADABLE');
    if (contained === 'NOT_ANCESTOR') return refuse('BASE_MISSING_REQUIRED_PREDECESSOR');
  }

  // 7. The anchor, and it is a cardinality question rather than an existence
  // one. `blockBaseCommit` is an invocation input; what makes it *derivable*
  // from this document afterwards is that the empty-row members which have
  // started agree on one value. Two values — one root started here, one
  // forced-settled from an older run — leave a later reader with two candidate
  // block bases and therefore with none.
  const anchors = new Set(
    ledger.frozenDependencies
      .filter((row) => row.dependsOn.length === 0)
      .map((row) => entryFor(ledger, row.taskId)?.baseCommit ?? null)
      // A root that has not started carries no base and is not evidence either
      // way; only a recorded value can anchor or contradict.
      .filter((commit): commit is string => commit !== null),
  );
  //
  // Two codes, and each says exactly one thing. More than one distinct value is
  // a document with two answers. A single value that is not this invocation's
  // base — every root forced-settled from one older run — is a document with one
  // answer that is not ours, and it is the same operator instruction as no
  // anchor at all: start this block from its root.
  if (anchors.size > 1) return refuse('CHAIN_ANCHOR_AMBIGUOUS');
  if (!anchors.has(blockBaseCommit)) return refuse('CHAIN_ANCHOR_MISSING');

  return Object.freeze({ ok: true as const, commit: candidate });
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts`
Expected: PASS. Eleven cases, all under 100 ms.

- [ ] **Step 5: Commit**

```bash
git add src/block/chain-fitness.ts tests/v2-09-dependent-commit-chain.test.ts
git commit -m "feat: prove a predecessor result fit to be a base, at the effect (V2-09)"
```

---

### Task 4: The base becomes a parameter

**Files:**
- Modify: `src/worktree/prepare-workspace.ts` (lines 76–128, 207–224, 261–356, 360–424)
- Modify: `src/worktree/adopt-workspace.ts` (line 265 and its signature)
- Modify: `src/run/start-task.ts` (`PlannedStartRequest`, `startAgainstPlan`, `startTask`)
- Modify: `tests/worktree-lifecycle.test.ts`, `tests/v2-06a-workspace-adoption.test.ts`, `tests/start-task.test.ts`, `tests/helpers/*` (new required argument)
- Test: `tests/v2-09-dependent-commit-chain.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WorkspaceBase =
    | { readonly kind: 'DEFAULT_BRANCH_TIP' }
    | { readonly kind: 'PINNED_COMMIT'; readonly commit: string };
  ```
  `WorkspacePreparationOptions.base: WorkspaceBase` (required);
  `proveSourcePreflight(git, identity, base)`;
  `assessWorkspaceAdoption(repository, taskId, { git, base })`;
  `PlannedStartRequest.base: WorkspaceBase`.
- Consumes: `commitObjectPresent` from Task 2.

Two new failure codes on the preparation vocabulary, because a pinned base that
does not resolve is a different operator problem from a missing default branch:
`BASE_COMMIT_ABSENT` ("the commit this task was to be built on is not in this
repository") and `BASE_COMMIT_UNREADABLE`.

- [ ] **Step 1: Write the failing test — the frozen base survives a moving default branch**

This is git-tier control **G-6** of the budget. Justification: the effect is a
worktree created at a commit that is no longer the branch tip, and no cheaper
test can observe which commit `git worktree add` actually used.

```ts
it('pins a workspace at the base it was given, even after the default branch moves', async () => {
  const repo = await realRepository();            // helper from tests/helpers/repo-fixtures.ts
  const frozen = headOf(repo.root);
  await commitOnDefaultBranch(repo, 'later.txt'); // the branch tip is now elsewhere

  const prepared = await prepareTaskWorkspace(repo.repository, taskDefinition('task-a'), {
    git: runGitCommand,
    lease: repo.lease,
    base: { kind: 'PINNED_COMMIT', commit: frozen },
  });

  expect(prepared.ok).toBe(true);
  expect(prepared.ok && prepared.workspace.basePinnedCommit).toBe(frozen);
  expect(headOf(prepared.ok ? prepared.workspace.worktreePath : '')).toBe(frozen);
});

// Specificity (G6): the default-branch path is unchanged for every existing caller.
it('still resolves the declared default branch when told to', async () => {
  const repo = await realRepository();
  const tip = headOf(repo.root);
  const prepared = await prepareTaskWorkspace(repo.repository, taskDefinition('task-a'), {
    git: runGitCommand,
    lease: repo.lease,
    base: { kind: 'DEFAULT_BRANCH_TIP' },
  });
  expect(prepared.ok && prepared.workspace.basePinnedCommit).toBe(tip);
});

it('refuses a pinned base this repository does not have, and creates nothing', async () => {
  const repo = await realRepository();
  const prepared = await prepareTaskWorkspace(repo.repository, taskDefinition('task-a'), {
    git: runGitCommand,
    lease: repo.lease,
    base: { kind: 'PINNED_COMMIT', commit: 'f'.repeat(40) },
  });
  expect(prepared).toMatchObject({ ok: false, code: 'BASE_COMMIT_ABSENT', residue: false });
  expect(await branchExists(repo.root, 'agent/task-a')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts -t 'pins a workspace at the base'`
Expected: FAIL — `base` is not an accepted option; the workspace is pinned at the
new branch tip.

- [ ] **Step 3: Split the preflight**

In `prepare-workspace.ts`, `proveSourcePreflight` keeps its three checkout
questions — root identity, on the declared default branch, clean — and its
fourth question becomes a switch on `base`:

```ts
  // The checkout questions above are about the source repository and are asked
  // whatever the base is: a dirty or wandering checkout is the wrong place to
  // create anything from. What follows is the base itself, and it is now told
  // rather than assumed. The two were one question for as long as every task
  // started from the default branch; a chained task starts from its
  // predecessor's result, and folding that back into "read the branch" would
  // make the receipt name a commit the work is not based on.
  if (base.kind === 'PINNED_COMMIT') {
    const present = await commitObjectPresent(git, root, base.commit);
    if (present === null) return { ok: false, code: 'BASE_COMMIT_UNREADABLE' };
    if (!present) return { ok: false, code: 'BASE_COMMIT_ABSENT' };
    return { ok: true, basePinnedCommit: base.commit };
  }

  const resolved = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options',
    localBranchRef(identity.baseBranch)]);
  // … unchanged from here: BASE_BRANCH_NOT_FOUND / BASE_COMMIT_UNRESOLVED
```

Everything below step 2 of `prepareTaskWorkspace` is unchanged: the worktree is
still created *at the object name*, and `verifyWorkspaceMatches` still confirms
`HEAD` is exactly it. The property that made the receipt true by construction now
holds for a chained base for the same reason.

- [ ] **Step 4: Give adoption the same base**

`assessWorkspaceAdoption` takes `base: WorkspaceBase` and passes it to
`proveSourcePreflight` instead of letting it re-derive. An orphan of a chained
task is then assessed against the commit it was actually prepared at; with the
old code it is compared with the default-branch tip and refused — or, worse,
accepted when the two coincide.

- [ ] **Step 5: Thread it through the start path**

`PlannedStartRequest` gains `base: WorkspaceBase`; `startAgainstPlan` takes it as
a parameter and forwards it to both `prepareTaskWorkspace` and
`assessWorkspaceAdoption`. `startTask` passes `{ kind: 'DEFAULT_BRANCH_TIP' }`,
which is today's behaviour written down.

- [ ] **Step 6: Rebase the existing callers and suites**

`tests/worktree-lifecycle.test.ts`, `tests/worktree-races.test.ts`,
`tests/v2-06a-workspace-adoption.test.ts`, `tests/start-task.test.ts` and the
helpers in `tests/helpers/` gain `base: { kind: 'DEFAULT_BRANCH_TIP' }`. This is
mechanical and must change no expectation: if any of those tests needs a
different value to stay green, the split has changed behaviour and the task is
wrong.

- [ ] **Step 7: Run the workspace suites**

Run: `npx vitest run tests/worktree-lifecycle.test.ts tests/worktree-races.test.ts tests/v2-06a-workspace-adoption.test.ts tests/start-task.test.ts tests/v2-09-dependent-commit-chain.test.ts`
Expected: PASS, with no expectation edited.

- [ ] **Step 8: Commit**

```bash
git add src/worktree/prepare-workspace.ts src/worktree/adopt-workspace.ts src/run/start-task.ts tests/
git commit -m "feat: the workspace base is a parameter, not a re-derivation (V2-09)"
```

---

### Task 5: Run-local runnability

**Files:**
- Modify: `src/block/block-conclusion.ts` (new section 6)
- Modify: `src/run/start-task.ts` (`PlannedStartRequest.satisfiedDependencies`, the gate at `:422`)
- Test: `tests/v2-09-dependent-commit-chain.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MemberRunnability =
    | { readonly runnable: true; readonly satisfiedBy: readonly string[] }
    | { readonly runnable: false; readonly reason: 'FROZEN_INELIGIBLE' | 'DEPENDENCY_NOT_SETTLED' | 'DEPENDENCY_OUTSIDE_BLOCK' };
  export function memberRunnability(taskId, eligibility, entries): MemberRunnability
  ```
  `PlannedStartRequest.satisfiedDependencies: readonly string[]`.
- Consumes: `TaskEligibility` **as a type only** from `src/plan/select-task.ts`.
  The V2-08 import pins distinguish a value import from a type-only one; this
  must stay a `import type` or Task 7's pin reddens, correctly.

- [ ] **Step 1: Write the failing test**

```ts
describe('a settled member satisfies a dependency inside the run, and nothing else does', () => {
  const eligibility = (over: Partial<TaskEligibility>[]) => over.map((entry) => ({
    taskId: 'task-b', eligible: false, reason: 'BLOCKED_BY_DEPENDENCIES',
    unsatisfiedDependencies: [], unlockCount: 0, ...entry,
  })) as readonly TaskEligibility[];

  it('lets a member run when every unsatisfied dependency is a settled member', () => {
    expect(memberRunnability('task-b',
      eligibility([{ taskId: 'task-b', unsatisfiedDependencies: ['task-a'] }]),
      entries({ 'task-a': 'SETTLED', 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: true, satisfiedBy: ['task-a'] });
  });

  it.each(['PLANNED', 'ACTIVE', 'BLOCKED', 'ABANDONED'] as const)(
    'does not let it run when the dependency is %s', (disposition) => {
      expect(memberRunnability('task-b',
        eligibility([{ taskId: 'task-b', unsatisfiedDependencies: ['task-a'] }]),
        entries({ 'task-a': disposition, 'task-b': 'PLANNED' }),
      )).toEqual({ runnable: false, reason: 'DEPENDENCY_NOT_SETTLED' });
    });

  it('never satisfies a dependency the block does not hold', () => {
    expect(memberRunnability('task-b',
      eligibility([{ taskId: 'task-b', unsatisfiedDependencies: ['task-x'] }]),
      entries({ 'task-a': 'SETTLED', 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: false, reason: 'DEPENDENCY_OUTSIDE_BLOCK' });
  });

  it('does not resurrect a task the roadmap calls finished', () => {
    expect(memberRunnability('task-b',
      eligibility([{ taskId: 'task-b', reason: 'ALREADY_DONE' }]),
      entries({ 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: false, reason: 'FROZEN_INELIGIBLE' });
  });

  // Specificity (G6): the rule must not disturb the members V2-08 already runs.
  it('passes a frozen-eligible member through untouched, with nothing claimed as satisfied', () => {
    expect(memberRunnability('task-b',
      eligibility([{ taskId: 'task-b', eligible: true, reason: null }]),
      entries({ 'task-b': 'PLANNED' }),
    )).toEqual({ runnable: true, satisfiedBy: [] });
  });
});

describe('a start may be authorised for a dependency this run satisfied', () => {
  it('starts a frozen-ineligible member when the caller names the settled dependency', async () => {
    const start = await startPlannedTask(
      { repository, taskId: 'task-b', planning, base: { kind: 'PINNED_COMMIT', commit: result },
        satisfiedDependencies: ['task-a'] },
      deps);
    expect(start.outcome).toBe('STARTED');
  });

  it('still refuses when the caller names a different dependency than the one blocking it', async () => {
    const start = await startPlannedTask(
      { repository, taskId: 'task-b', planning, base: { kind: 'DEFAULT_BRANCH_TIP' },
        satisfiedDependencies: ['task-c'] },
      deps);
    expect(start).toMatchObject({ outcome: 'TASK_INELIGIBLE', reasonCodes: ['BLOCKED_BY_DEPENDENCIES'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts -t 'satisfies a dependency'`
Expected: FAIL — `memberRunnability` is not exported; `startPlannedTask` refuses
`TASK_INELIGIBLE` in the first start case.

- [ ] **Step 3: Write the rule**

```ts
/**
 * Whether a member may run *now*, given this run's own record.
 *
 * ── What this adds to the frozen snapshot, and what it must not ────────────
 *
 * The invocation reads the roadmap once (F-B1) and never again. Under that rule
 * a dependent member is not merely unscheduled, it is unreachable: `B` is
 * `BLOCKED_BY_DEPENDENCIES` at freeze because `A` is `OPEN`, and `A` must be
 * `OPEN` or it could not run either. So V2-09 adds exactly one thing to the
 * snapshot, and it is not a second reading of anything: the run's own
 * settlements, which are monotone and were each proved against the task's record
 * before they were written.
 *
 * A dependency on a **non-member** is never satisfied here. The ledger holds no
 * entry for it, so there is nothing this run could have proved about it, and the
 * honest end for such a block is still `NO_ELIGIBLE_TASK`.
 *
 * `SETTLED` alone is what this function answers. It is *not* the whole
 * dependency-satisfaction rule: the base that settlement offers must also be
 * proved fit against Git (`chain-fitness.ts`). The two are separate because they
 * fail separately — this one over the planner's *direct* dependencies, that one
 * over the frozen *transitive* required set — and neither implies the other.
 */
export function memberRunnability(
  taskId: string,
  eligibility: readonly TaskEligibility[],
  entries: readonly BlockTaskEntry[],
): MemberRunnability {
  const report = eligibility.find((entry) => entry.taskId === taskId);
  if (report === undefined) return notRunnable('FROZEN_INELIGIBLE');
  if (report.eligible) return Object.freeze({ runnable: true as const, satisfiedBy: Object.freeze([]) });
  if (report.reason !== 'BLOCKED_BY_DEPENDENCIES') return notRunnable('FROZEN_INELIGIBLE');

  const members = new Set(entries.map((entry) => entry.taskId));
  const settled = new Set(
    entries.filter((entry) => entry.disposition === 'SETTLED').map((entry) => entry.taskId),
  );
  for (const dependency of report.unsatisfiedDependencies) {
    if (!members.has(dependency)) return notRunnable('DEPENDENCY_OUTSIDE_BLOCK');
    if (!settled.has(dependency)) return notRunnable('DEPENDENCY_NOT_SETTLED');
  }
  return Object.freeze({
    runnable: true as const,
    satisfiedBy: Object.freeze([...report.unsatisfiedDependencies]),
  });
}
```

- [ ] **Step 4: Open the start gate exactly that far**

In `startAgainstPlan`, replace the bare `if (!eligibility.eligible)` refusal with:

```ts
  // The caller may overrule exactly one ineligibility, and only by naming the
  // dependencies it has itself satisfied. Everything else — `ALREADY_DONE`, an
  // unnamed dependency, a dependency outside the caller's list — refuses as
  // before. A caller cannot widen this usefully: naming a dependency does not
  // make a base, and the workspace it gets is still the one the caller pinned,
  // under the lease, in this repository.
  if (!eligibility.eligible) {
    const overruled =
      eligibility.reason === 'BLOCKED_BY_DEPENDENCIES' &&
      eligibility.unsatisfiedDependencies.every((dependency) =>
        satisfiedDependencies.includes(dependency));
    if (!overruled) {
      return stop({ outcome: 'TASK_INELIGIBLE', reasonCodes: … });   // unchanged
    }
  }
```

`startTask` passes `[]`, so the single-task path is byte-identical in behaviour.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts tests/start-task.test.ts`
Expected: PASS. `start-task.test.ts` must be green **unedited** except for the
new required fields — the non-block path did not change.

- [ ] **Step 6: Commit**

```bash
git add src/block/block-conclusion.ts src/run/start-task.ts tests/
git commit -m "feat: a settled member satisfies a dependency inside its own run (V2-09)"
```

---

### Task 6: The scope authority, durable and split from the execution base

**Files:**
- Modify: `src/core/internal/task-state-object-schema.ts` (the new field)
- Regenerate: `schemas/task-state.schema.json` (`npm run schema:generate`)
- Modify: `src/run/start-task.ts` (`PlannedStartRequest.scopeAuthorityCommit`, `firstState`)
- Modify: `src/scope/assess-scope.ts` (`ScopeAssessmentInput.scopeAuthorityCommit`)
- Modify: `src/loop/loop-step.ts` (the scope gate, line ~406)
- Modify: `tests/task-state.test.ts`, `tests/public-state-api.test.ts`
- Test: `tests/v2-09-dependent-commit-chain.test.ts`

**Interfaces:**
- Produces: `TaskState.scopeAuthorityCommit: string | null` — a full Git object
  name; `null` means *this task's own base pin governs*. Additive, nullable,
  `.default(null)`, **no `TASK_STATE_SCHEMA_VERSION` bump** (G5).
- `PlannedStartRequest.scopeAuthorityCommit: string | null` — **required**, so
  every caller states its answer. `startTask` passes `null`; the block runner
  passes `blockBaseCommit`. An omitted field is how the widened profile would
  sneak back in, which is why it is not optional.
- `ScopeAssessmentInput.scopeAuthorityCommit: string | null`. `readPinnedScope`
  is called with `scopeAuthorityCommit ?? basePinnedCommit`; the delta continues
  to be measured from `basePinnedCommit`. Two different commits on purpose: the
  delta is *what this task changed*, the scope is *what it was allowed to
  change*.
- **`RunRequest` gains nothing.** An earlier draft of this task threaded the
  authority through `runTask` as an invocation argument. That is the shape the
  review rejected: it protects the run and nothing after it. The value is written
  once, at start, into the record its consumer already reads.

- [ ] **Step 1: Write the failing durable counter-proof**

Git-tier control **G-5**, and it is the one the review demanded. Justification:
the claim is that the authority *survives the block invocation*, so nothing that
stays inside one invocation can prove it — the state has to be written by a real
chained start, the block run has to end, and a caller that knows nothing about
blocks has to drive the task afterwards.

```ts
it('judges a chained task against the block base even after the block run is over', async () => {
  // blockBase allows src/a/** only. A commits a profile allowing /**, and B is
  // started chained on A's result. The block run then ends with B unfinished.
  const repo = await realRepositoryWithChain({ allowedPaths: ['src/a/**'] });
  const blockBase = headOf(repo.root);
  await runAttendedBlock(request(repo, { blockBaseCommit: blockBase }), {
    ...seams,
    agent: recordedAgent({
      'task-a': writerThatCommits(REPO_PROFILE_RELATIVE_PATH, profileAllowing(['/**'])),
      'task-b': usageLimitResult(),          // B is started, then stops resumably
    }),
  });

  const b = reload(repo.root, 'task-b').state;
  expect(b.basePinnedCommit).toBe(entryFor(loadBlockLedger(repo.root, 'run-1').ledger, 'task-a')?.resultCommit);
  expect(b.scopeAuthorityCommit).toBe(blockBase);          // durable, not remembered

  // Now a caller that knows nothing about blocks. It supplies no authority of
  // any kind, and the roadmap has since been marked DONE for task-a — which is a
  // markdown field and proves nothing about Git.
  markTaskDone(repo, 'task-a');
  const run = await runTask(
    { repository: repo.repository, taskId: 'task-b', taskBrief: 'task-b',
      attendedContinuation: true, authEvidence, lease: repo.lease, maxSteps: 4 },
    { now, git: runGitCommand, agent: recordedAgent({ 'task-b': writerThatCommits('src/b/x.ts', 'work') }) },
  );

  // The widening A committed is not in force: src/b/** was never allowed by the
  // profile at the block base, and that is still the profile that governs.
  expect(run.outcome).toBe('SCOPE_VIOLATION');
  expect(reload(repo.root, 'task-b').state.state).toBe('SCOPE_VIOLATION');
});
```

Specificity (G6) for this guard is not a second expensive control: an ordinary
task is unaffected because its `scopeAuthorityCommit` is `null`, which is proved
by `tests/v2-06-scope-enforcement.test.ts` staying green **unedited**, plus one
pure assertion that the standalone start path writes `null`:

```ts
it('writes no scope authority for a task started outside a block', async () => {
  const start = await startTask({ repository, taskId: 'task-a' }, deps);
  expect(reload(repository.root, 'task-a').state.scopeAuthorityCommit).toBeNull();
});
```

- [ ] **Step 2: Write the failing scope-resolution controls**

Git-tier **G-2a** and **G-2b**, at the assessment boundary. Justification: the
effect is which committed tree the profile is read out of, and only a real
repository holding two different profiles in two commits can show it.

```ts
it('reads the declaration from the scope authority and the delta from the base pin', async () => {
  const repo = await realRepositoryWithProfile({ allowedPaths: ['src/a/**'] });
  const blockBase = headOf(repo.root);
  const widened = await commitOnBranch(repo, 'agent/task-a', profileAllowing(['/**']));
  const worktree = chainedWorktreeAt(repo, widened, { change: 'src/b/x.ts' });

  const assessment = await assessTaskScope({
    git: runGitCommand, authorisedWorktreePath: worktree,
    basePinnedCommit: widened, scopeAuthorityCommit: blockBase,
  });
  expect(assessment.verdict).toBe('VIOLATION');
  expect(assessment.offences.map((offence) => offence.path)).toEqual(['src/b/x.ts']);
});

// Specificity (G6): the frozen profile must still permit what it really permits,
// and the delta must still be measured from the chained base — a change to
// src/a/y.ts is inside the block-base scope and is not reported.
it('lets a chained task change what the block-base profile allows', async () => {
  const worktree = chainedWorktreeAt(repo, widened, { change: 'src/a/y.ts' });
  const assessment = await assessTaskScope({
    git: runGitCommand, authorisedWorktreePath: worktree,
    basePinnedCommit: widened, scopeAuthorityCommit: blockBase,
  });
  expect(assessment).toMatchObject({ verdict: 'WITHIN_SCOPE', offences: [] });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts -t 'scope authority'`
Expected: FAIL — `scopeAuthorityCommit` is neither a state field nor an
assessment input, and the assessment reads the widened profile.

- [ ] **Step 4: Add the field to the state contract**

In `src/core/internal/task-state-object-schema.ts`, beside `basePinnedCommit`:

```ts
  /**
   * The commit whose profile decides what this task is allowed to change.
   *
   * `null` — and `null` is the default — means *this task's own
   * `basePinnedCommit` governs*, which is the only answer that was ever needed
   * while every task started from the default branch.
   *
   * A chained task breaks that identity: its base pin is a commit its
   * predecessor's agent wrote, and reading a scope declaration out of that
   * commit would let one agent widen the next one's permissions. So the two
   * roles are separated here, in the durable record, rather than in whichever
   * invocation happens to be driving: a block run can end, crash or be killed,
   * and the successor's state is then an ordinary task state that any later
   * caller may continue. If the authority lived in that caller's arguments, the
   * guarantee would end with the invocation that made it.
   *
   * Additive and defaulted rather than versioned, deliberately. A state written
   * before this field existed means exactly `null`: no task before the chain had
   * a base authored by a sibling, so nothing is invented for an old document —
   * which is the test the ledger's version-1 refusal applied and failed. The
   * other direction fails closed on its own, because an older build meets an
   * unknown key at a `.strict()` boundary and refuses the state.
   */
  scopeAuthorityCommit: GitShaSchema.nullable().default(null),
```

- [ ] **Step 5: Regenerate the public schema and re-pin the surface**

Run: `npm run schema:generate`
Then confirm `tests/schema-generation.test.ts` and `tests/public-state-api.test.ts`
pass: the generated JSON schema must match, and the field must **not** add a new
runtime export to `src/core/task-state.ts` (AO-009 — the public surface stays the
three values and two types it already is).

- [ ] **Step 6: Write it at start, read it at the gate**

`start-task.ts`: `PlannedStartRequest` gains the required field, `startAgainstPlan`
takes it as a parameter, `firstState` writes it, and `startTask` passes `null`.
Task 5's two `startPlannedTask` cases gain `scopeAuthorityCommit: null` — they are
about the eligibility gate and nothing else, and stating `null` there is the same
"say what you mean" the required field exists to force.

```ts
    basePinnedCommit: workspace.basePinnedCommit,
    scopeAuthorityCommit,
```

`assess-scope.ts`:

```ts
  // Two commits, and the difference is the whole of E2. The *delta* is measured
  // from the base pin, because that is the tree this task's work sits on top of.
  // The *declaration* is read from the scope authority, because a predecessor
  // that hands its successor code must not thereby hand it permission. For an
  // ordinary task the two are the same commit and nothing changes; for a chained
  // one the authority is the commit the block was frozen at. This `??` is the one
  // place the fallback exists, so there is one answer to "which commit governed".
  const scope = await readPinnedScope(git, authorisedWorktreePath, scopeAuthorityCommit ?? basePinnedCommit);
  const delta = await observeTaskDelta(git, authorisedWorktreePath, basePinnedCommit);
```

`loop-step.ts` passes `state.scopeAuthorityCommit` into both assessment calls.

- [ ] **Step 7: Run the scope and state suites**

Run: `npx vitest run tests/v2-06-scope-enforcement.test.ts tests/task-state.test.ts tests/public-state-api.test.ts tests/schema-generation.test.ts tests/v2-09-dependent-commit-chain.test.ts`
Expected: PASS, with `v2-06` **unedited** — that is the specificity half of this
task, and an edit to it means the ordinary path changed.

- [ ] **Step 8: Prove the durable control is load-bearing**

Change the block runner (Task 7) to pass `scopeAuthorityCommit: null` on the
chained start, run the G-5 control, and confirm it goes **red** with
`WITHIN_SCOPE` — the widened profile in force. Revert. A durable-authority claim
whose control has never been seen to fail is a sentence, not a proof; record the
observed failure in the commit message.

- [ ] **Step 9: Commit**

```bash
git add src/core/internal/task-state-object-schema.ts schemas/task-state.schema.json \
        src/run/start-task.ts src/scope/assess-scope.ts src/loop/loop-step.ts tests/
git commit -m "feat: the scope authority is durable, and it is the block base (V2-09)"
```

---

### Task 7: The runner drives a chain

**Files:**
- Modify: `src/block/block-runner.ts` (`AttendedBlockRequest`, the loop at 357–397, `chooseTask` at 733, `driveOneTask` at 758)
- Test: `tests/v2-09-dependent-commit-chain.test.ts`

**Interfaces:**
- Consumes: `uniqueMaximumOf` (Task 1), `proveChainBase` (Task 3), `WorkspaceBase` (Task 4), `memberRunnability` (Task 5).
- Produces: `AttendedBlockRequest.blockBaseCommit: string`.

- [ ] **Step 1: Replace the frozen eligible set with a per-iteration question**

The `const eligible = new Set(…)` at `:351` goes. `chooseTask` becomes a pure
function of the current ledger plus the snapshot, and returns the base decision
with the choice:

```ts
type TaskChoice =
  | {
      readonly kind: 'TASK';
      readonly taskId: string;
      /** Empty for a frozen-eligible member; the settled members that unlocked it otherwise. */
      readonly satisfiedBy: readonly string[];
      /** `null` for a root member — its base is the block base. */
      readonly maximum: string | null;
    }
  | { readonly kind: 'NONE' };
```

```ts
function chooseTask(ledger: BlockRunLedger, planning: TaskPlanningSuccess): TaskChoice {
  for (const entry of ledger.tasks) {
    if (entry.disposition !== 'PLANNED') continue;
    const runnable = memberRunnability(entry.taskId, planning.selection.eligibility, ledger.tasks);
    if (!runnable.runnable) continue;
    const maximum = uniqueMaximumOf(ledger.frozenDependencies, entry.taskId);
    // A block with no chain shape is refused at freeze, so this is a fail-closed
    // floor rather than a branch that runs. Skipping the member is the safe
    // direction: it cannot be given a base, so it must not be started.
    if (!maximum.ok) continue;
    return Object.freeze({ kind: 'TASK', taskId: entry.taskId, satisfiedBy: runnable.satisfiedBy, maximum: maximum.maximum });
  }
  return Object.freeze({ kind: 'NONE' });
}
```

- [ ] **Step 2: Prove the base immediately before the start**

In `driveOneTask`, ahead of `startPlannedTask`:

```ts
  // The base, and the proof that it is one. A root member is pinned at the block
  // base — the same commit for every root, whatever the default branch has done
  // since the operator asked. A chained member is pinned at its unique maximum's
  // recorded result, and only after Git has confirmed the commit is real,
  // referenced, descended from the block base and containing every predecessor
  // this member requires.
  let base: WorkspaceBase = { kind: 'PINNED_COMMIT', commit: request.blockBaseCommit };
  if (choice.maximum !== null) {
    const proven = await proveChainBase(deps.git, repository.root, {
      ledger: current.ledger,
      taskId: choice.taskId,
      maximum: choice.maximum,
      blockBaseCommit: request.blockBaseCommit,
    });
    // A gate refusal, exactly like a refused workspace: the run ends in the
    // report, this member stays PLANNED — which is true, nothing was started for
    // it — and the ledger is byte-identical across the condition. It is not a
    // claim about the member's outcome, and it is not a durable-write problem.
    if (!proven.ok) return nothing(ended('RUN_GATE_REFUSED', proven.code));
    base = { kind: 'PINNED_COMMIT', commit: proven.commit };
  }

  const start = await startPlannedTask(
    { repository, taskId: choice.taskId, planning: request.planning, base,
      satisfiedDependencies: choice.satisfiedBy,
      // Every member of the block, chained or root, is judged against the commit
      // the block was frozen at — and it is written into the task's own record
      // here, once, so the answer outlives this invocation.
      scopeAuthorityCommit: request.blockBaseCommit },
    { git: deps.git, now: deps.now, authPreflight: deps.authPreflight, lease },
  );
```

`runTask` is called unchanged: the authority is a property of the task's record,
not of the call that drives it.

- [ ] **Step 3: Write the controls**

Git-tier **G-1** (the chain lands), **G-3** (an unreferenced base refuses),
**G-4** (an older run's result does not authorise the chain).

```ts
it('bases a dependent member on its predecessor\'s result commit', async () => {
  const repo = await realRepositoryWithChain();     // task-a, task-b dependsOn task-a
  const result = await runAttendedBlock(request(repo, { blockBaseCommit: headOf(repo.root) }), {
    ...seams, agent: recordedAgent({ writer: writerThatCommits('src/a/x.ts', 'work') }),
  });

  expect(result).toMatchObject({ outcome: 'BLOCK_RUN_ENDED', stopReason: 'COMPLETE' });
  const ledger = loadBlockLedger(repo.root, 'run-1');
  const a = entryFor(ledger.ledger, 'task-a');
  const b = entryFor(ledger.ledger, 'task-b');
  expect(b?.baseCommit).toBe(a?.resultCommit);                       // the ledger says so
  expect(reload(repo.root, 'task-b').state.basePinnedCommit).toBe(a?.resultCommit);  // and the task record
  expect(await isAncestor(repo.root, a?.resultCommit, headOf(worktreeOf(repo, 'task-b')))).toBe(true);
});

it('refuses to chain onto a result no ref contains any more', async () => {
  // A settles; the operator releases A's workspace, deleting the branch, before B runs.
  …
  expect(result).toMatchObject({ outcome: 'RUN_GATE_REFUSED', detail: 'BASE_NOT_REFERENCED' });
  expect(entryFor(loadBlockLedger(repo.root, 'run-1').ledger, 'task-b')?.disposition).toBe('PLANNED');
  expect(ledgerBytesBefore).toEqual(ledgerBytesAfter);
});

it('refuses a predecessor settled from an older run whose history does not carry the chain', async () => {
  // task-a1 is READY_FOR_PR from a previous run, off a commit that is not this
  // block's base; applyForcedProgress settles it, and the chain still refuses.
  expect(result).toMatchObject({ outcome: 'RUN_GATE_REFUSED', detail: 'BASE_NOT_DESCENDED_FROM_BLOCK_BASE' });
});
```

Plus two **pure** controls that need no repository, and that pin the two rules
against each other:

```ts
it('does not start a member whose dependency is settled but whose base is unfit', …);  // G3 holds, G4 refuses
it('does not start a member whose base would be fit but whose dependency is not settled', …);  // G4 would pass, G3 refuses
```

- [ ] **Step 4: Rebase `tests/v2-08-attended-block-runner.test.ts`**

Every `runAttendedBlock` request gains `blockBaseCommit`. No expectation changes:
an independent block pins every member at the block base, which for V2-08's
fixtures is the default-branch tip they already used.

- [ ] **Step 5: Prove the import pins still hold**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts -t 'takes no reading of the roadmap of its own'`
Expected: PASS. `block-conclusion.ts` imports `TaskEligibility` **as a type**;
`block-runner.ts` still imports no planner value and no projection.

- [ ] **Step 6: Run the block suites**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts tests/v2-07-block-ledger.test.ts tests/v2-07-remediation.test.ts tests/v2-09-dependent-commit-chain.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/block/block-runner.ts tests/
git commit -m "feat: the runner drives a dependent chain under one lease (V2-09)"
```

---

### Task 8: The freeze site, and sentences that mean what the state says

**Files:**
- Modify: `src/cli/block-command.ts` (the freeze path and the read-only report)
- Modify: `src/cli/render-block-run.ts`
- Test: `tests/v2-09-dependent-commit-chain.test.ts`

- [ ] **Step 1: Capture the block base under the lease**

In the attended path, immediately after the lease is acquired and beside the one
`planNextTask` call — same instant, same authority:

```ts
  // The block base, read once, under the lease, from the same instant as the
  // plan. Not re-read per task: a default branch that moves mid-run would
  // otherwise give two roots two different bases, and "the commit this block was
  // frozen on" would stop having one answer — which is exactly what the chain's
  // ancestry proof and the scope authority both rest on.
  const base = await runGitCommand(repository.root, [
    'rev-parse', '--verify', '--quiet', '--end-of-options', localBranchRef(repository.defaultBranch),
  ]);
  if (base.outcome !== 'OK' || !GIT_OBJECT_NAME_PATTERN.test(base.stdout)) {
    report([line('Failure', 'BLOCK_BASE_UNRESOLVED'), `  ${BLOCK_BASE_UNRESOLVED_SENTENCE}`]);
    return EXIT_RUN_REFUSED;
  }
```

- [ ] **Step 2: Refuse a block with no chain shape, in both modes**

After `defineBlock` succeeds:

```ts
  const shape = chainShapeOf(definition.dependencies);
  if (!shape.ok) {
    report([line('Failure', `${shape.code} (${shape.taskId})`), `  ${CHAIN_SHAPE_SENTENCE}`]);
    return EXIT_RUN_INPUT_UNUSABLE;
  }
```

The read-only report gains two lines beside the independence line it already
prints: the chain shape verdict and, for each dependent member, which member it
would chain onto. Eligibility, independence and chain shape are three different
questions and the report keeps saying so.

- [ ] **Step 3: Write the renderer-truth controls**

These are the G7 controls, and they are written so that the measured swap mutant
dies:

```ts
describe('an operator-facing sentence is bound to the state that produced it', () => {
  // Measured before this slice: the V2-08 controls accept a table in which
  // TASK_BLOCKED and NO_ELIGIBLE_TASK have exchanged sentences. Distinctness,
  // non-emptiness and ASCII are all preserved by the swap, so none of them
  // could see it. These assertions are about what each sentence *claims*.
  const claims: Record<BlockStopReason, { must: RegExp; mustNot: RegExp }> = {
    COMPLETE: { must: /every .*task .*settled|block is done/i, mustNot: /not eligible|no frozen member/i },
    TASK_BLOCKED: { must: /human must resolve/i, mustNot: /no frozen member was eligible/i },
    TASK_ABANDONED: { must: /given up on/i, mustNot: /human must resolve|no frozen member/i },
    NO_ELIGIBLE_TASK: { must: /no frozen member was eligible/i, mustNot: /human must resolve|given up on/i },
    OPERATOR_STOPPED: { must: /operator stopped/i, mustNot: /task/i },
    LEDGER_DIVERGED: { must: /disagree/i, mustNot: /cannot be used/i },
    STATE_UNUSABLE: { must: /cannot be used/i, mustNot: /disagree/i },
    DEFINITION_DRIFTED: { must: /no longer matches/i, mustNot: /disagree/i },
    ACTIVE_TASK_UNRESOLVED: { must: /could not be safely established/i, mustNot: /unusable/i },
  };

  it.each(BLOCK_STOP_REASONS)('%s explains itself and claims nothing another reason owns', (reason) => {
    expect(BLOCK_STOP_SENTENCES[reason]).toMatch(claims[reason].must);
    expect(BLOCK_STOP_SENTENCES[reason]).not.toMatch(claims[reason].mustNot);
  });

  it('renders, for a persisted TASK_BLOCKED, a sentence that does not deny the blocked task', () => {
    const printed = renderBlockRun(repository, {
      outcome: 'BLOCK_RUN_ENDED', stopReason: 'TASK_BLOCKED', detail: null, runId: 'run-1', blockId: 'block-1',
      steps: 3, tasks: [{ taskId: 'task-a', disposition: 'BLOCKED', runOutcome: 'BLOCKED_VERIFY' }],
    });
    expect(printed).toMatch(/human must resolve/i);
    expect(printed).not.toMatch(/no frozen member was eligible/i);
  });
});
```

- [ ] **Step 4: Prove the control kills the mutant**

Swap the two entries of `BLOCK_STOP_SENTENCES` in `src/cli/render-block-run.ts`,
run the suite, confirm **both** new tests fail, and revert the swap. Record the
observed failure in the commit message — an absence assertion that has never
been seen to fail is not a counter-proof.

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts -t 'operator-facing sentence'`

- [ ] **Step 5: Commit**

```bash
git add src/cli/block-command.ts src/cli/render-block-run.ts tests/
git commit -m "feat: freeze the block base, refuse a shapeless chain, bind sentences to state (V2-09)"
```

---

### Task 9: The two end-to-end controls

**Files:**
- Test: `tests/v2-09-dependent-commit-chain.test.ts`

Exactly two, per G8, each with the defect it proves that no cheaper control can:

- [ ] **Step 1: E2E-1 — the whole command, chained**

*Which defect only this can prove:* that the lease, the one plan snapshot, the
frozen relation, the ledger's successor contract, workspace preparation and the
scope authority are all satisfied **at the same time** for a chained member. Each
is proved alone one tier down; none of those shows they compose.

```ts
it('drives a dependent block end to end and exits on its reason', async () => {
  const repo = await realRepositoryWithChain();
  const exit = await runAgentLoop(['block', '--repository', repo.root, '--block', 'block-1',
    '--tasks', 'task-a', 'task-b', '--run', 'run-1', '--attended'], { agent: committingAgent });

  expect(exit.code).toBe(0);
  expect(exit.stdout).toContain('COMPLETE');
  const ledger = loadBlockLedger(repo.root, 'run-1').ledger;
  expect(entryFor(ledger, 'task-b')?.baseCommit).toBe(entryFor(ledger, 'task-a')?.resultCommit);
  expect(ledger.stopReason).toBe('COMPLETE');
});
```

- [ ] **Step 2: E2E-2 — the predecessor fails, and nothing is claimed**

*Which defect only this can prove:* that the widening rule of Task 5 does not
over-reach through the whole stack when the predecessor does **not** deliver —
the one direction in which a mistake becomes durable and false.

```ts
it('never starts the successor when the predecessor blocks, and claims nothing about it', async () => {
  const repo = await realRepositoryWithChain();
  const exit = await runAgentLoop([...same..., '--attended'], { agent: agentThatBlocksOn('task-a') });

  expect(exit.stdout).toContain('TASK_BLOCKED');
  const ledger = loadBlockLedger(repo.root, 'run-1').ledger;
  expect(entryFor(ledger, 'task-a')?.disposition).toBe('BLOCKED');
  expect(entryFor(ledger, 'task-b')).toMatchObject({ disposition: 'PLANNED', baseCommit: null, resultCommit: null });
  expect(existsSync(worktreePathOf(repo, 'task-b'))).toBe(false);
});
```

- [ ] **Step 3: Run and record their cost**

Run: `npx vitest run tests/v2-09-dependent-commit-chain.test.ts --reporter=verbose`
Record both durations; they are inputs to Task 11's accounting.

- [ ] **Step 4: Commit**

```bash
git add tests/v2-09-dependent-commit-chain.test.ts
git commit -m "test: the two load-bearing end-to-end controls of the chain (V2-09)"
```

---

### Task 10: The README, including a correction that is not about V2-09

**Files:**
- Modify: `README.md` (new `## The dependent commit chain (V2-09)` section before `## Not implemented yet`; the F-B4 bullet at `:4551`; the roadmap at `:4600`; `## Not implemented yet` at `:4586`)

- [ ] **Step 1: Correct F-B4 first, and as a correction**

The existing bullet says the dead end is "a member whose path to eligibility runs
through a non-member". Before V2-09 a **member** dependency ends the same way,
because the frozen snapshot is never revisited. Write it as a correction to what
V2-08 shipped, not as a description of new behaviour:

> **F-B4 — a member blocked by anything the run cannot finish ends the run
> `NO_ELIGIBLE_TASK`.** As shipped in V2-08 this covered *any* unfinished
> dependency, member or not: the eligibility snapshot is taken once and never
> revisited, so a member whose dependency is another member of the same block was
> equally unreachable. The sentence here previously named only non-members, which
> understated it. V2-09 removes the member half — see below — and leaves the
> non-member half exactly as it was, deliberately.

- [ ] **Step 2: Write the V2-09 section**

Sections, in this order, each stating the decision and what it cost:
`SETTLED is a disposition; SETTLED + chain-fit is a satisfied dependency` ·
`Two commit roles, and only one travels — and the authority is durable` ·
`Roadmap DONE is not evidence about Git` · `The unique maximum, and why a diamond
is refused` · `The chain anchor is a cardinality rule` ·
`A chain refusal is a gate refusal` · `What V2-09 is not`.

The third of those is the one to write carefully, because it corrects a claim
this plan itself made in an earlier draft: that a task marked `DONE` in the
roadmap has thereby had its commits accepted by a human. `status` is a markdown
field written by whoever edits the file, and a merge can squash, rework or drop
any hunk in it. Nothing in this build may treat it as evidence about what reached
the default branch.

- [ ] **Step 3: Carry the register forward**

New entries, each stating the accepted cost rather than a plan to fix it:

- **F-C1 — a ledger whose roots do not agree on one base cannot be chained onto
  (`CHAIN_ANCHOR_MISSING` / `CHAIN_ANCHOR_AMBIGUOUS`).** `blockBaseCommit` is an
  invocation input, and the anchor is what makes it *derivable* from the ledger
  afterwards — which needs one value, not merely one occurrence. A run whose
  roots were all forced-settled from an older run, or which holds roots pinned at
  two different bases, refuses rather than chaining onto a base the document
  cannot name. Accepted: an operator clears it by starting the block from its
  root, and the alternative is a durable answer nobody can reconstruct.
- **F-C2 — an unfit base ends the run rather than skipping the member.** A
  chain-fitness refusal is `RUN_GATE_REFUSED`, so independent members the run had
  not yet reached stay `PLANNED`. Accepted: it matches how every other start-gate
  refusal is graded, and continuing past a Git state nobody understands is the
  direction this repository does not take.
- **F-C3 — a chained member *can* be continued outside its block, and keeps the
  scope it was started under.** Its state is an ordinary `TaskState`, so any later
  caller may drive it; what travels with it is `scopeAuthorityCommit`, so the
  profile at the block base still governs however long afterwards that happens
  and whatever the roadmap has since been edited to say. Not a residue but the
  property G-5 exists to prove — recorded here because the *execution* base is
  still the predecessor's commit, so such a continuation extends a stack whose
  first half was never separately reviewed.
- **F-C4 — the block produces a stack.** `B`'s branch contains `A`'s commits, so
  a pull request for `B` carries `A`'s work. That is what "dependent execution"
  means here and the report says so; merging out of order is an operator
  decision this build does not model.

- [ ] **Step 4: Update the roadmap and "Not implemented yet"**

`V2-09` moves to `<- shipped`; the remaining line becomes the operator
notification (V2-10), the dogfood block and the closing audit. `READY_FOR_PR` is
still terminal and still says so.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: the dependent commit chain, and a correction to F-B4 (V2-09)"
```

---

### Task 11: The gate, the budget, and the pull request

- [ ] **Step 1: Run the canonical gate**

Run: `npm run verify`
Expected: every stage green.

- [ ] **Step 2: Re-measure with the same script**

Run the same per-stage baseline script that produced the numbers in G8 —
unchanged, on this machine, from a clean tree — and compare against
`289.4 s total / foundation-safe 261.7 s`. A different script, a different
machine or a warm/cold difference makes the comparison meaningless, which is why
the script rather than the number is what is held fixed.

- [ ] **Step 3: Account for the difference**

Produce the table the design demanded — every test over 2 s that this slice
added, with the defect it proves and why a cheaper control cannot:

| Control | s | Defect only this can prove |
| --- | --- | --- |
| G-1 chain lands | | the worktree is really at the predecessor's commit |
| G-2a authority read from the right commit | | which committed tree the profile came from |
| G-2b scope specificity | | the frozen profile still permits what it permits |
| G-3 unreferenced base refuses | | reachability is a Git fact, not a record fact |
| G-4 older-run result refused | | ancestry of two real commit histories |
| G-5 authority survives the block run | | the guarantee holds after the invocation that made it |
| G-6 frozen base beats a moving branch | | which commit `worktree add` used |
| E2E-1 | | lease + snapshot + ledger + workspace + scope, together |
| E2E-2 | | the widening rule does not over-reach end to end |

Budget: at most 8 git-tier, exactly 2 E2E. Seven git-tier rows are planned, one
slot unspent; the specificity half of G-5 costs nothing extra because it is
`tests/v2-06-scope-enforcement.test.ts` staying green unedited plus one pure
assertion. **If the count is exceeded, a control moves down a tier — none is
deleted.** Any material runtime increase not attributable to a row above is a
finding, not a rounding error.

- [ ] **Step 4: Open the pull request**

```bash
git push -u origin feat/v2-09-dependent-commit-chain
gh pr create --base main --title "feat: dependent execution and the controlled commit chain (V2-09)" --body …
```

Then wait for CI and merge **only** on a successful result, per `CLAUDE.md`. Zero
checks is `MERGE_BLOCKED_NO_CHECKS`, not permission to merge.

---

## Self-review against the decisions

- **E1** — Task 1 (`uniqueMaximumOf`, diamond refused), Task 8 Step 2 (refused at
  freeze, both modes), Task 7 Step 1 (read from `frozenDependencies`, never
  recomputed; the import pin is re-run in Step 5). No implicit linearisation:
  root members take the block base, never a sibling's result.
- **E2, and the durability blocker** — Task 6, and it is now a **durable** answer:
  `TaskState.scopeAuthorityCommit`, written at start, read by the module that
  already reads the record. Control G-5 drives the review's own counter-example —
  block run ends with `B` chained and unfinished, `A` marked `DONE`, `A`'s widened
  profile *not* on the authoritative line — and requires the widening to be
  refused; Step 8 makes the runner pass `null` and requires the control to go red.
  No profile object is copied anywhere, `readPinnedScope` is never handed
  `basePinnedCommit` for a chained task, and the roadmap-`DONE` inference the
  earlier draft relied on is retracted in three places (G2, the counter-proof
  section, Task 10 Step 2).
- **E3 + the B-4 sharpening** — Task 5 (`SETTLED`, run-local, non-member is a
  dead end, no roadmap write) *and* Task 3 (chain-fit), with Task 7 Step 3's two
  pure controls pinning that neither alone is sufficient. Rule 6 of G4 is the
  general containment statement; the older-run case is control G-4.
- **The anchor blocker** — G4 rule 7 is a cardinality rule, not an existence one:
  the empty-row entries that carry a base must carry exactly one distinct value
  and it must be this invocation's, so `blockBaseCommit` is *derivable* from the
  document rather than merely findable in it. `CHAIN_ANCHOR_AMBIGUOUS` is its own
  code, and Task 3 has three cases for it — two answers, no answer of ours, and
  the specificity case where several roots legitimately agree.
- **`startPlannedTask`** — no planner read is added; the widening arrives as an
  argument the runner computed from the ledger, and Task 7 Step 5 re-runs the
  pins that forbid a second reading.
- **B-6** — the counter-proof is run above and recorded honestly: it **holds on
  the ledger** (no field, no stop reason, no version bump) and **fails on the task
  state**, where the minimal change is taken — one additive, nullable, defaulted
  field, with the four candidate existing authorities named and rejected one by
  one before proposing it.
- **Test budget** — 7 git-tier rows planned of 8 allowed, 2 E2E rows, pure
  everywhere else; final measurement with the same script.
- **Renderer truth** — Task 8 Steps 3–4, including killing the measured mutant.
- **F-B4** — Task 10 Step 1, written as a correction to V2-08's behaviour.
