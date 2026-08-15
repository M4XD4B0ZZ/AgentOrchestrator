# V2-08 Attended Block Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a block of independent tasks to its end in one attended invocation under one lease, recording each task's outcome with its evidence, continuing after a task-local failure and stopping immediately — and honestly — on every condition that means the run can no longer make a durable claim.

**Architecture:** Four layers, kept apart on purpose. The **frozen plan** (`block-definition.ts`) grows the dependency relation and binds it into the fingerprint; the **projection** (`block-dependencies.ts`) computes that relation once, at freeze time, from the whole normalised repository DAG. A **pure decision layer** (`block-conclusion.ts`) maps a run outcome onto what the ledger may be told, and chooses the end reason by cause rather than consequence. The **runner** (`block-runner.ts`) sequences the existing primitives — lease, `startTask`, `runTask`, `activate`/`settle`/`park`/`abandon`/`stop` — and owns the two distinct exits: recordable conditions end the run *in the ledger*, unrecordable ones end it *in the report* with the ledger untouched. The CLI is a fifth, thin layer that freezes the plan, takes the lease, and renders.

**Tech Stack:** TypeScript 7 (ESM, `nodenext`), Zod 4, Commander 15, vitest 4, GitHub Actions on `windows-latest`, Node 22 and 24.

**Spec:** `docs/superpowers/specs/2026-08-14-v2-08-attended-block-runner-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **The transitive projection is computed at freeze time and nowhere else.** `projectBlockDependencies` is called by the CLI when a block is frozen. `src/block/block-runner.ts` must never import `src/block/block-dependencies.ts`; Task 7 verifies that with `git grep`. A runner that recomputed the relation would answer "may B continue after A?" from a roadmap that can be edited mid-run, which is the opposite of frozen-plan authority.
- **One canonical truth is persisted.** The ledger stores `frozenDependencies` and nothing else about the relation. No second `dependents` image, no derived `independent` flag. The fingerprint covers `blockId + frozenTaskIds + frozenDependencies`.
- **External-only blockers are not independence.** A member with no frozen block-member dependency is *not* thereby eligible: it may still wait on a non-member. Eligibility comes from the repository's own selector (`planNextTask` → `selection.eligibility`), and a block with nothing eligible and no disposition to explain it ends `NO_ELIGIBLE_TASK`.
- **A block run does not outlive its invocation.** One run id, one attended
  invocation, one lease — literally, as `README.md:3789` states it: *"V2-08 must
  hold one lease across a whole block run and perform its ledger writes
  underneath it."* So there is **no cross-invocation resume**, a run id that
  already has a ledger is refused rather than continued, and a step budget is
  absorbed inside the invocation instead of ending it. See "The contradiction
  this plan had to resolve" below.
- **The roadmap is read exactly once, under the lease, and every later gate
  consults that one reading.** The order is `resolve → lease → planNextTask →
  project → define → run → release`. One `planNextTask` result feeds all four
  consumers — the transitive projection, the frozen definition, the eligibility
  snapshot and the **start path** — so no two of them can disagree, and no edit
  between them can change what runs.

  Structural rather than disciplinary, in two places. `src/block/` never calls
  `planNextTask` (Task 7 greps for it), and the start path the runner uses is
  `startPlannedTask`, which *takes* a planning result and has no way to produce
  one (Task 6B). A runner that re-read the plan between tasks — or that called a
  primitive which did — would let a mid-run edit change which task runs next,
  even though no fingerprint was recomputed.

  Measured, so the size of the fix is not guessed: `planNextTask` has three call
  sites in `src/` besides its own definition — `release-workspace.ts:225`,
  `run-driver.ts:938` (inside `selectRunTask`) and `start-task.ts:373`. Only
  `start-task.ts:373` is reachable from a block run; `runTask` does not read the
  plan at all. That one surface is the whole of Task 6B.
- **One schema bump for the whole slice.** `BLOCK_LEDGER_SCHEMA_VERSION: 1 → 2`, once, covering both `frozenDependencies` and `ACTIVE_TASK_UNRESOLVED`. A version-1 document is **refused, never migrated**, under its own load code.
- **Four runner outcomes are not recorded as an ending.**
  `LEASE_AUTHORITY_UNCERTAIN`, `DURABLE_WRITE_FAILED`, `RUN_GATE_REFUSED` and
  `RECONCILIATION_UNRESOLVED` reach the operator through the report, and the
  ledger is left byte-identical **across the condition**: it stands at its last
  provably durable state.

  That is deliberately not the sentence *"nothing was written"*. **All four are
  reachable after the ledger exists and after earlier tasks have been recorded in
  it** — a run that settled A and then met one of them wrote A's settlement, and
  is right to keep it. Two of them are *also* reachable with no ledger at all
  (`RUN_GATE_REFUSED` from the auth gate ahead of `openRun`, and
  `DURABLE_WRITE_FAILED` when the failure strikes the creation), which is a fact
  about where the condition arose and never about the outcome. So "nothing was
  written" is true of no outcome in general, and the two cases where it happens
  to hold are asserted as `existsSync(...) === false` at their own sites rather
  than promoted into the vocabulary's meaning.

  What none of the four may do is add a stop claim, so there is no best-effort
  stop write on any of them; and the byte-identity controls therefore compare the
  ledger immediately **before and after** the condition rather than against an
  empty file.
- **`ACTIVE_TASK_UNRESOLVED` stays out of `PROGRESS_CLAIMING_STOP_REASONS`,** and the sorting is pinned by a hand-written correctness test plus an effect test (it must be writable over a ledger whose entries are not supported).
- **V2-08 opens no new platform, ownership or recovery surface.** No unattended mode, no stale-lease recovery, no process containment, no parallel task execution, no commit chain, no outgoing transition from `READY_FOR_PR`.
- Repository delivery policy is `PR_REQUIRED` + `CI_REQUIRED` (`CLAUDE.md`). Never commit to `main`. The branch is `feat/v2-08-attended-block-runner`, which already exists and already carries the three design commits.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BaE9b5RWjuCCPZqapWPSXK
  ```
- Run `npm run typecheck` before every commit, and **every commit compiles.**
  Tasks 1–3 are therefore one commit rather than three: the three-argument
  definition API cannot be introduced and its call sites repaired in the same
  step without patching them with an empty relation, which is the one default
  this slice exists to make impossible. So they stay three implementation steps
  and become one commit, taken at Task 3. A deliberately red commit is not the
  price — bisect and `git log -S` are worth more than three commit boundaries.
  The canonical gate is `npm run verify`; run it at Task 12 and before opening
  the PR.

## The contradiction this plan had to resolve

An earlier draft had a block run survive its invocation: the driver's step
budget ran out, the invocation exited 5, and a later invocation picked the same
run up. Three statements were then asserted at once, and they cannot all be
true:

```
the same durable block run survives
+ the CLI invocation terminates
+ one lease spans the whole block run
```

A terminating invocation must give the lease back, so between two invocations
the run would be open with no holder. Leaving the lease behind on purpose is not
available either — that is exactly the stale-lease surface this slice is
forbidden to reopen, and a lease whose owner is gone is never taken over
automatically.

**Decided: a block run's lifetime is its invocation's lifetime.**

- `startBlockRun` already refuses a run id that has a ledger. The runner adds no
  resume path, so that refusal *is* the answer: an operator continues by
  starting a new run id, and the interrupted run stays as a durable record of
  what it did.
- The driver's `STEP_BUDGET_EXHAUSTED` is **absorbed**: the runner drives the
  same task again under the same lease. `maxSteps` bounds one `runTask` call so a
  driver cannot run away; it says nothing about a task's outcome, and turning it
  into `ACTIVE_TASK_UNRESOLVED` would make a scheduling limit into a claim about
  a task. The continuation terminates, because every `STEP_BUDGET_EXHAUSTED`
  carries durable progress by its own definition, the task's state machine is
  bounded by the repository's `maxReviewRounds`, and a continuation that lands
  zero durable steps is refused rather than tried again.
- `STEP_BUDGET_EXHAUSTED` is therefore not a block-run outcome, and `block` never
  exits 5.

Two things this costs, both recorded in the follow-up register rather than
argued away:

- **`DEFINITION_DRIFTED` has no producer in V2-08.** Drift is a comparison
  between a frozen plan and a current one, and with no resume there is no
  persisted predecessor to compare against — the plan is frozen and the ledger
  is created from it inside one invocation. The reason stays in the vocabulary,
  stays graded in the exit table, and is unproduced. `reconcileBlockRun` still
  reports it to a caller that supplies a definition.
- **An interrupted invocation leaves an open ledger nothing can continue.** Fail
  closed, and honest: the record says which task was `ACTIVE` when the run
  stopped being driven, and no later process claims authority over it.

## The second contradiction: a snapshot that was not frozen

A review of this plan found the same shape of defect one layer down, and it is
recorded here because the fix — Task 6B — exists for no other reason.

The plan asserted that the runner acts on one snapshot of the roadmap, and it
made that structural on the runner's own side: `block-runner.ts` imports no
planner. But the runner starts each task through `startTask`, and `startTask`
calls `planNextTask` itself (`src/run/start-task.ts:373`) and refuses
`TASK_INELIGIBLE` from *that* reading. So:

```
freeze:  B is eligible
A runs
the roadmap is edited; B is now ineligible
the runner picks B from the snapshot
        ↓
startTask plans again
        ↓
TASK_INELIGIBLE  →  GATE_REFUSED  →  RUN_GATE_REFUSED
```

The mid-run edit changed the run's behaviour after all — it just did it behind a
primitive instead of in the loop. The plan already carried the counter-proof
that would have caught it: *"does not let a mid-run roadmap edit change what runs
next"* (Task 7, Step 5) edits `B-001` to depend on an unfinished task and expects
the block to reach `COMPLETE`. Against the code as planned, that case fails with
`RUN_GATE_REFUSED`. The test was right and the implementation contradicted it.

A second window sat above it: the CLI froze the plan **before** taking the
execution lease, so a legitimate other writer could edit the roadmap between the
reading the block was frozen from and the moment this invocation became the
writer.

**Decided: one reading of the roadmap, taken under the lease, consulted by every
gate.**

- The lease is acquired first, and `planNextTask` runs under it —
  `run-command.ts:205-217` already does exactly this for the single-task path,
  so the block command was the anomaly, not the correction. The cost is that an
  unusable `--tasks` argument is now refused while holding the lease for a few
  milliseconds; that is cheaper than freezing a plan nobody was yet the writer
  of.
- `startTask` splits (Task 6B). `startPlannedTask` takes the planning result and
  cannot produce one; `startTask` keeps its signature, reads the plan once and
  delegates. The block runner uses only the former, so the second planner read
  is not hidden — it is absent.
- The runner takes the whole `TaskPlanningSuccess` rather than a list of
  eligible ids, so the list it filters by and the reading `startPlannedTask`
  gates against are the same object. There is no second list that could widen or
  narrow the first.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/block/block-definition.ts` *(modify)* | `FrozenTaskDependency`; `BlockDefinition.dependencies`; canonicalisation in `defineBlock`; the fingerprint over all three parts. |
| `src/block/block-dependencies.ts` *(create)* | The transitive projection over the whole normalised DAG, restricted to members. Freeze time only. |
| `src/block/block-ledger.ts` *(modify)* | Schema version 2; `frozenDependencies` and its invariants; `ACTIVE_TASK_UNRESOLVED`; `FIELD_AUTHORITY` classification; the reversed `TASK_DISPOSITIONS` prose. |
| `src/block/block-store.ts` *(modify)* | `LEDGER_SCHEMA_UNSUPPORTED` on load; a predecessor-version detail on update. |
| `src/block/block-progress.ts` *(modify)* | `startBlockRun` freezes the relation; `parkBlockTask` stops writing a stop reason. |
| `src/block/block-conclusion.ts` *(create)* | Pure: run outcome → what may be recorded; progress outcome → recorded/unresolved/write-failed; the end-reason table; the independence question. |
| `src/run/start-task.ts` *(modify)* | `startPlannedTask`, which starts against a planning result it is given; `startTask` keeps its signature and becomes the one caller that reads a plan. |
| `src/block/block-runner.ts` *(create)* | The attended block run. Sequences primitives; owns the two exits. |
| `src/cli/block-command.ts` *(create)* | `agent-loop block`: freeze, lease, run, render. |
| `src/cli/render-block-run.ts` *(create)* | The report, and one sentence per outcome and per stop reason. |
| `src/cli/run-exit-codes.ts` *(modify)* | `exitCodeForBlockRun`, two total tables. |
| `src/cli/index.ts` *(modify)* | Registers the command; the description gains the block runner. |
| `tests/v2-08-attended-block-runner.test.ts` *(create)* | Every control in design §8. |
| `tests/v2-07-block-ledger.test.ts` *(modify)* | Re-based onto the three-argument definition API. |
| `tests/v2-07-remediation.test.ts` *(modify)* | Re-based; the "blocked stops the run" case is inverted here, where it lives. |
| `README.md` *(modify)* | The V2-08 narrative, the roadmap, and the follow-up register. |

---

### Task 1: The frozen plan carries the dependency relation

**Files:**
- Modify: `src/block/block-definition.ts` (lines 55–72, 90–122, 124–165)
- Create: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Produces: `type FrozenTaskDependency = { readonly taskId: string; readonly dependsOn: readonly string[] }`; `BlockDefinition.dependencies: readonly FrozenTaskDependency[]`; `defineBlock(blockId: string, taskIds: readonly string[], dependencies: readonly FrozenTaskDependency[]): BlockDefinitionResult`; `fingerprintBlockDefinition(definition: BlockDefinition): string`; `fingerprintFrozenMembership(blockId: string, taskIds: readonly string[], dependencies: readonly FrozenTaskDependency[]): string`; the five new members of `BLOCK_DEFINITION_FAILURE_CODES`.
- Consumes: `compareTaskIds` from `src/plan/task-id.ts`.

> **Measured premise.** `BlockDefinition` is `blockId` + `taskIds` today (`src/block/block-definition.ts:68-72`) and `fingerprintBlockDefinition` covers exactly those two (line 146). So the slice's headline behaviour — continue after a task-local failure — is unreachable in *every* block until this task lands.

- [ ] **Step 1: Write the failing test**

Create `tests/v2-08-attended-block-runner.test.ts`:

```ts
/**
 * V2-08 — the attended block runner.
 *
 * The controls are written against the two things this slice can get wrong in a
 * way nothing else would catch:
 *
 *  - confusing a *task* failure with a failure of the *run's ability to make a
 *    durable claim*, and
 *  - answering "may B continue after A?" from anything other than the frozen
 *    plan.
 *
 * So every case here is driven by effect. A stop is asserted on the persisted
 * ledger, never on an in-memory value; an outcome that is *not* recorded is
 * asserted by comparing the file byte for byte **across the condition** — not
 * against an empty file, because a run that settled a task before meeting one
 * of those outcomes wrote that settlement and is right to keep it; and the
 * independence cases include the one shape a direct intra-block edge check
 * cannot see.
 */

import { describe, expect, it } from 'vitest';

import {
  defineBlock,
  fingerprintBlockDefinition,
  type FrozenTaskDependency,
} from '../src/block/block-definition.js';

/** Rows for a block whose members depend on nothing. */
function independentRows(taskIds: readonly string[]): readonly FrozenTaskDependency[] {
  return taskIds.map((taskId) => ({ taskId, dependsOn: [] }));
}

describe('the frozen plan carries the dependency relation', () => {
  it('requires exactly one row per member', () => {
    const missing = defineBlock('V2', ['A-001', 'B-001'], [{ taskId: 'A-001', dependsOn: [] }]);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('DEPENDENCY_ROW_MISSING');
  });

  it('refuses a row for a task the block does not hold', () => {
    const foreign = defineBlock('V2', ['A-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.code).toBe('DEPENDENCY_ROW_UNKNOWN');
  });

  it('refuses two rows for one member', () => {
    const twice = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(twice.ok).toBe(false);
    if (twice.ok) return;
    expect(twice.code).toBe('DEPENDENCY_ROW_REPEATED');
  });

  it('refuses a dependency on a non-member and on itself', () => {
    const unknown = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['X-001'] },
    ]);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe('DEPENDENCY_UNKNOWN');

    const itself = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: ['A-001'] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(itself.ok).toBe(false);
    if (itself.ok) return;
    expect(itself.code).toBe('DEPENDENCY_SELF');
  });

  it('canonicalises the rows: member order, deduplicated and sorted edges', () => {
    const defined = defineBlock('V2', ['B-001', 'A-001', 'C-001'], [
      { taskId: 'C-001', dependsOn: ['B-001', 'A-001', 'B-001'] },
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    // Rows mirror `taskIds`, which is the operator's order and is identity.
    expect(defined.definition.dependencies.map((row) => row.taskId)).toEqual([
      'B-001',
      'A-001',
      'C-001',
    ]);
    expect(defined.definition.dependencies[2]?.dependsOn).toEqual(['A-001', 'B-001']);
  });

  // The control design §8.3e names. Without it the new authority is modelled
  // and not frozen, which is the whole point of putting it in the plan.
  it('binds the relation into the fingerprint', () => {
    const withoutEdge = defineBlock('V2', ['A-001', 'B-001'], independentRows(['A-001', 'B-001']));
    const withEdge = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    expect(withoutEdge.ok && withEdge.ok).toBe(true);
    if (!withoutEdge.ok || !withEdge.ok) return;

    // Same blockId, same taskIds, one edge added.
    expect(withEdge.definition.blockId).toBe(withoutEdge.definition.blockId);
    expect(withEdge.definition.taskIds).toEqual(withoutEdge.definition.taskIds);
    expect(fingerprintBlockDefinition(withEdge.definition)).not.toBe(
      fingerprintBlockDefinition(withoutEdge.definition),
    );
  });

  it('gives one relation one digest, however the caller spelled it', () => {
    const a = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'B-001', dependsOn: ['A-001', 'A-001'] },
      { taskId: 'A-001', dependsOn: [] },
    ]);
    const b = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(fingerprintBlockDefinition(a.definition)).toBe(
      fingerprintBlockDefinition(b.definition),
    );
  });

  it('cannot encode two different plans to one string', () => {
    // The separators are the whole reason a collision is impossible, so the
    // shapes that would collide under a single separator are named.
    const one = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: ['B-001'] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    const other = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    expect(one.ok && other.ok).toBe(true);
    if (!one.ok || !other.ok) return;
    expect(fingerprintBlockDefinition(one.definition)).not.toBe(
      fingerprintBlockDefinition(other.definition),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — `defineBlock` takes two arguments, `FrozenTaskDependency` is not exported.

- [ ] **Step 3: Add the type and the failure codes**

In `src/block/block-definition.ts`, replace `BLOCK_DEFINITION_FAILURE_CODES` (lines 56–63) with:

```ts
export const BLOCK_DEFINITION_FAILURE_CODES = [
  'BLOCK_ID_INVALID',
  'BLOCK_EMPTY',
  'BLOCK_TOO_LARGE',
  'TASK_ID_INVALID',
  'TASK_REPEATED',
  'BLOCK_ID_COLLIDES_WITH_TASK',
  /**
   * A member has no dependency row.
   *
   * Five codes rather than one `DEPENDENCIES_INVALID`, for the reason this
   * repository has recorded twice already: a refusal that misdescribes itself
   * sends an operator to the wrong fix. "You forgot a row", "you sent a row for
   * a task that is not in this block" and "your row points at a stranger" are
   * three different mistakes.
   */
  'DEPENDENCY_ROW_MISSING',
  /** A row names a task this block does not hold. */
  'DEPENDENCY_ROW_UNKNOWN',
  /** Two rows claim one member, so the relation has two answers for it. */
  'DEPENDENCY_ROW_REPEATED',
  /** A dependency names a task this block does not hold. */
  'DEPENDENCY_UNKNOWN',
  /** A row lists its own task. */
  'DEPENDENCY_SELF',
] as const;
```

Replace the `BlockDefinition` interface (lines 67–72) with:

```ts
/**
 * What one member of a block waits for, **restricted to members of that block**.
 *
 * `dependsOn` is the *transitive* projection — the set of block members this
 * task depends on through any path, member or not — computed once at freeze
 * time by `block-dependencies.ts`. A direct intra-block edge check is not sound:
 * a block is an arbitrary subset of a repository-wide DAG, so `A ← X ← B` with
 * `X` outside the block has no intra-block edge and B still depends on A.
 *
 * The relation is frozen rather than derived live, and the *evidence* is frozen
 * rather than a `independent: true` judgement, so that what a run's continuation
 * decision rests on is inspectable and cannot move under it.
 */
export type FrozenTaskDependency = {
  readonly taskId: string;
  readonly dependsOn: readonly string[];
};

/** One block of work, exactly as an operator asked for it. Frozen once made. */
export interface BlockDefinition {
  readonly blockId: string;
  /** Ordered, unique, every one a canonical task id. */
  readonly taskIds: readonly string[];
  /**
   * Exactly one row per member, in {@link taskIds} order.
   *
   * Row order carries no information of its own — it is a function of
   * `taskIds` — so two spellings of one relation cannot produce two
   * fingerprints.
   */
  readonly dependencies: readonly FrozenTaskDependency[];
}
```

- [ ] **Step 4: Canonicalise in `defineBlock`**

Add to the import block at the top of the file:

```ts
import { compareTaskIds, isValidTaskId } from '../plan/task-id.js';
```

(replacing the existing single-name import on line 35).

Replace the signature and the tail of `defineBlock` (lines 97–122) with:

```ts
export function defineBlock(
  blockId: string,
  taskIds: readonly string[],
  dependencies: readonly FrozenTaskDependency[],
): BlockDefinitionResult {
  if (!isValidBlockId(blockId)) return definitionFailure('BLOCK_ID_INVALID');
  if (taskIds.length === 0) return definitionFailure('BLOCK_EMPTY');
  if (taskIds.length > MAX_BLOCK_TASKS) return definitionFailure('BLOCK_TOO_LARGE');

  const seen = new Set<string>();
  for (const taskId of taskIds) {
    if (!isValidTaskId(taskId)) return definitionFailure('TASK_ID_INVALID');
    // A repeated task is not harmless noise: it would give one task two entries
    // in the ledger, and two dispositions that can disagree.
    if (seen.has(taskId)) return definitionFailure('TASK_REPEATED');
    // Nor is a block that is also one of its own tasks. The block-id grammar is
    // the task-id grammar on purpose — see `isValidBlockId` — so an id alone
    // never says which of the two it names. A reconciliation reports findings
    // about the block under the same field it reports findings about a task, and
    // where the two ids are equal a consumer keying on that field cannot tell
    // "this plan drifted" from "this task's record does not support it".
    if (taskId === blockId) return definitionFailure('BLOCK_ID_COLLIDES_WITH_TASK');
    seen.add(taskId);
  }

  // The relation, canonicalised rather than believed. There is no default and
  // no optional argument: a caller that omitted the relation would be asserting
  // that every member is independent, which is precisely the claim this slice
  // exists to make provable rather than assumable.
  const rows = new Map<string, readonly string[]>();
  for (const row of dependencies) {
    if (!seen.has(row.taskId)) return definitionFailure('DEPENDENCY_ROW_UNKNOWN');
    if (rows.has(row.taskId)) return definitionFailure('DEPENDENCY_ROW_REPEATED');
    const deduplicated = new Set<string>();
    for (const dependency of row.dependsOn) {
      if (dependency === row.taskId) return definitionFailure('DEPENDENCY_SELF');
      if (!seen.has(dependency)) return definitionFailure('DEPENDENCY_UNKNOWN');
      deduplicated.add(dependency);
    }
    rows.set(row.taskId, Object.freeze([...deduplicated].sort(compareTaskIds)));
  }
  for (const taskId of taskIds) {
    if (!rows.has(taskId)) return definitionFailure('DEPENDENCY_ROW_MISSING');
  }

  return Object.freeze({
    ok: true as const,
    definition: Object.freeze({
      blockId,
      taskIds: Object.freeze([...taskIds]),
      dependencies: Object.freeze(
        taskIds.map((taskId) =>
          Object.freeze({ taskId, dependsOn: rows.get(taskId) as readonly string[] }),
        ),
      ),
    }),
  });
}
```

- [ ] **Step 5: Extend the canonical encoding**

Replace the separator constant and both fingerprint functions (lines 124–165) with:

```ts
/**
 * The separators of the canonical encoding below.
 *
 * Three bytes that cannot occur inside a block id or a task id, so no two
 * different plans can encode to one string. Written as escapes rather than as
 * the bytes themselves: the value is identical, and a raw control character is
 * invisible in an editor, in a diff and in a review — while these are
 * load-bearing, because they are the whole reason two plans cannot collide.
 *
 * Three, not one. With a single separator the plan `{A: [B], B: []}` and the
 * plan `{A: [], B: [A]}` encode to permutations of the same token list, and a
 * digest that could not tell those apart would be a frozen relation that is not
 * frozen at all.
 */
const CANONICAL_SEPARATOR = '\u0000';
const DEPENDENCY_ROW_SEPARATOR = '\u0001';
const CANONICAL_SECTION_SEPARATOR = '\u0002';

/**
 * A digest of the identity a run is started against.
 *
 * Over the block id, the ordered task ids **and the frozen dependency
 * relation** — see the module header for why the task *content* is deliberately
 * excluded. The relation is included because a run's continuation decision
 * rests on it: a plan that could gain or lose an edge without moving the
 * fingerprint would be a plan whose authority a mid-run roadmap edit could
 * change.
 *
 * Computed from a canonical encoding rather than `JSON.stringify` of the
 * object, so a change in field order or in how the value was constructed cannot
 * change the digest.
 */
export function fingerprintBlockDefinition(definition: BlockDefinition): string {
  return fingerprintFrozenMembership(
    definition.blockId,
    definition.taskIds,
    definition.dependencies,
  );
}

/**
 * The fingerprint a ledger's own frozen plan must carry.
 *
 * The same digest as {@link fingerprintBlockDefinition}, reached from the three
 * fields a ledger stores rather than from a {@link BlockDefinition} object. It
 * exists so that `planFingerprint` can be *re-derived* from the document that
 * carries it rather than believed: a stored digest of a plan the document does
 * not list would make every later drift answer a comparison against a lie.
 */
export function fingerprintFrozenMembership(
  blockId: string,
  taskIds: readonly string[],
  dependencies: readonly FrozenTaskDependency[],
): string {
  const membership = [blockId, ...taskIds].join(CANONICAL_SEPARATOR);
  const relation = dependencies
    .map((row) => [row.taskId, ...row.dependsOn].join(CANONICAL_SEPARATOR))
    .join(DEPENDENCY_ROW_SEPARATOR);
  return createHash('sha256')
    .update(`${membership}${CANONICAL_SECTION_SEPARATOR}${relation}`, 'utf8')
    .digest('hex');
}
```

- [ ] **Step 6: Run the new test**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: FAIL, in exactly three places — `src/block/block-ledger.ts:264` and `src/block/reconcile-block.ts:223,229` call the two-argument `fingerprintFrozenMembership`, and `src/block/block-progress.ts:186` builds a definition without a relation. Those are Task 3's. Leave them failing; do not patch them here with a `[]` third argument, which would freeze "everything is independent" as a default and is the one shape this task exists to make impossible.

- [ ] **Step 7: Do not commit yet**

The tree does not compile, and this repository does not take deliberately red
commits — see Global Constraints. The three call sites above cannot be repaired
without either this task's type or an empty-relation default, so Tasks 1–3 are
one commit, taken at **Task 3, Step 10**, whose message covers all three.

Leave the work in the tree and go on to Task 2. Nothing here is staged, so
nothing has to be unstaged if Task 2 or Task 3 sends you back.

---

### Task 2: The transitive projection, computed once

**Files:**
- Create: `src/block/block-dependencies.ts`
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Consumes: `FrozenTaskDependency` (Task 1); `NormalizedTaskGraph`, `normalizeTaskGraph` from `src/plan/task-graph.ts`; `compareTaskIds`.
- Produces: `BLOCK_PROJECTION_FAILURE_CODES`; `type BlockProjectionFailureCode`; `type BlockProjectionResult`; `projectBlockDependencies(graph: NormalizedTaskGraph, taskIds: readonly string[]): BlockProjectionResult`.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import { projectBlockDependencies } from '../src/block/block-dependencies.js';
import { normalizeTaskGraph } from '../src/plan/task-graph.js';
import type { TaskDefinition } from '../src/plan/task-definition.js';

/** A definition with only the fields the graph reads. */
function task(id: string, dependsOn: readonly string[] = []): TaskDefinition {
  return {
    id,
    title: `task ${id}`,
    status: 'OPEN',
    kind: 'NORMAL',
    priority: 'NORMAL',
    currentFocus: false,
    dependsOn,
  };
}

function graphOf(definitions: readonly TaskDefinition[]) {
  const normalized = normalizeTaskGraph(definitions);
  if (!normalized.ok) throw new Error(`fixture graph is not a graph: ${normalized.code}`);
  return normalized.graph;
}

describe('the projection is transitive, and restricted to members', () => {
  // The control design §8.3f names, and the one that distinguishes the correct
  // projection from the seductive, wrong, direct intra-block check. X is not a
  // member, so no intra-block edge exists at all — and B still depends on A.
  it('sees a dependency that runs through a non-member', () => {
    const graph = graphOf([task('A-001'), task('X-001', ['A-001']), task('B-001', ['X-001'])]);

    const projected = projectBlockDependencies(graph, ['A-001', 'B-001']);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.dependencies).toEqual([
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
  });

  it('does not record a dependency on a non-member', () => {
    // The consequence stated in the design: a member whose path to eligibility
    // runs through a non-member is not recorded as dependent on anything. That
    // block can be frozen and that member can never become eligible, which ends
    // the run NO_ELIGIBLE_TASK rather than pretending it is blocked by a sibling.
    const graph = graphOf([task('A-001'), task('X-001'), task('B-001', ['X-001'])]);

    const projected = projectBlockDependencies(graph, ['A-001', 'B-001']);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.dependencies).toEqual([
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
  });

  it('collapses a diamond and sorts what it found', () => {
    const graph = graphOf([
      task('A-001'),
      task('M-001', ['A-001']),
      task('N-001', ['A-001']),
      task('Z-001', ['M-001', 'N-001']),
    ]);

    const projected = projectBlockDependencies(graph, ['Z-001', 'A-001', 'M-001']);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    // Rows follow the caller's member order; edges are sorted canonically.
    expect(projected.dependencies).toEqual([
      { taskId: 'Z-001', dependsOn: ['A-001', 'M-001'] },
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'M-001', dependsOn: ['A-001'] },
    ]);
  });

  it('refuses a member the repository does not declare', () => {
    const graph = graphOf([task('A-001')]);

    const projected = projectBlockDependencies(graph, ['A-001', 'GHOST-001']);

    expect(projected.ok).toBe(false);
    if (projected.ok) return;
    expect(projected.code).toBe('TASK_NOT_IN_GRAPH');
    expect(projected.taskId).toBe('GHOST-001');
  });

  it('feeds a definition that `defineBlock` accepts unchanged', () => {
    // The projection's output is the definition's input, so the two
    // canonicalisations must already agree. If `defineBlock` had to reorder or
    // deduplicate anything here, the fingerprint would depend on which of the
    // two ran last.
    const graph = graphOf([task('A-001'), task('X-001', ['A-001']), task('B-001', ['X-001'])]);
    const projected = projectBlockDependencies(graph, ['A-001', 'B-001']);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const defined = defineBlock('V2', ['A-001', 'B-001'], projected.dependencies);
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    expect(defined.definition.dependencies).toEqual(projected.dependencies);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — cannot resolve `../src/block/block-dependencies.js`.

- [ ] **Step 3: Write the projection**

Create `src/block/block-dependencies.ts`:

```ts
/**
 * The block's dependency relation, projected out of the repository's whole DAG.
 *
 * ── Called once, when a block is frozen ────────────────────────────────────
 *
 * This is the *only* place the relation is computed. The runner never calls it:
 * a run that re-derived the relation between tasks would answer "may B continue
 * after A?" from a roadmap that an operator can edit while the run is in
 * flight, which is the opposite of frozen-plan authority. The result is written
 * into the ledger, bound into the fingerprint, and read from there afterwards.
 *
 * ── Why the obvious version is wrong ───────────────────────────────────────
 *
 * The seductive implementation asks each member for its own `dependsOn` and
 * keeps the entries that are also members. Measured against
 * `src/plan/task-graph.ts`, that is unsound: `normalizeTaskGraph` stores each
 * definition's own edge list and its direct reverse and computes **no
 * transitive closure anywhere**, while normalising over the whole discovered
 * task set. A block is therefore an arbitrary subset of a repository-wide DAG,
 * and this is representable:
 *
 *     A: dependsOn []
 *     X: dependsOn [A]      <- not a block member
 *     B: dependsOn [X]
 *
 *     block = {A, B}   ->   no direct intra-block edge exists,
 *                           yet B transitively depends on A through X
 *
 * So the walk goes up the whole graph and the restriction to members happens at
 * the end, never at each hop.
 *
 * ── What a member's empty row does and does not say ────────────────────────
 *
 * It says: no *member* of this block stands between this task and eligibility.
 * It does **not** say the task is eligible. A member may wait on a non-member
 * that is not `DONE`, and nothing here records that — eligibility is the
 * repository selector's question, asked live, and a block frozen in that state
 * can end with nothing runnable and no disposition to explain it, which is what
 * `NO_ELIGIBLE_TASK` is reserved for.
 */

import { compareTaskIds } from '../plan/task-id.js';
import type { NormalizedTaskGraph } from '../plan/task-graph.js';
import type { FrozenTaskDependency } from './block-definition.js';

/** Every way a projection can fail. A closed set. */
export const BLOCK_PROJECTION_FAILURE_CODES = [
  /**
   * A requested member is not a task of this repository.
   *
   * Refused rather than projected as an empty row. An unknown member with no
   * edges would be frozen as "independent of everything", which is the most
   * dangerous possible answer to give about a task nobody can find.
   */
  'TASK_NOT_IN_GRAPH',
] as const;

export type BlockProjectionFailureCode = (typeof BLOCK_PROJECTION_FAILURE_CODES)[number];

export interface BlockProjectionSuccess {
  readonly ok: true;
  /** One row per member, in the caller's member order. */
  readonly dependencies: readonly FrozenTaskDependency[];
}

export interface BlockProjectionFailure {
  readonly ok: false;
  readonly code: BlockProjectionFailureCode;
  /** The member the failure is about. A validated id, never prose. */
  readonly taskId: string;
}

export type BlockProjectionResult = BlockProjectionSuccess | BlockProjectionFailure;

/**
 * The members each member transitively depends on.
 *
 * Pure: no clock, no filesystem, no Git. The graph is already acyclic — that is
 * what `normalizeTaskGraph` returns — so the visited set is about not walking a
 * diamond's shared ancestor twice rather than about termination.
 */
export function projectBlockDependencies(
  graph: NormalizedTaskGraph,
  taskIds: readonly string[],
): BlockProjectionResult {
  for (const taskId of taskIds) {
    if (!graph.has(taskId)) {
      return Object.freeze({ ok: false as const, code: 'TASK_NOT_IN_GRAPH' as const, taskId });
    }
  }

  const members = new Set(taskIds);

  const dependencies = taskIds.map((taskId) => {
    const reached = new Set<string>();
    const queue = [...(graph.node(taskId)?.dependsOn ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (reached.has(current)) continue;
      reached.add(current);
      for (const next of graph.node(current)?.dependsOn ?? []) queue.push(next);
    }

    // The restriction, applied once and at the end. `taskId` itself is excluded
    // defensively: an acyclic graph cannot reach it, and a relation that could
    // say "A depends on A" would be refused by `defineBlock` anyway.
    const projected = [...reached]
      .filter((id) => members.has(id) && id !== taskId)
      .sort(compareTaskIds);

    return Object.freeze({ taskId, dependsOn: Object.freeze(projected) });
  });

  return Object.freeze({ ok: true as const, dependencies: Object.freeze(dependencies) });
}
```

- [ ] **Step 4: Pin who may call it**

"The runner does not recompute the relation" is a property of the module graph,
which no runtime assertion can see — and an import check on `block-runner.ts`
alone is not enough, because `helper.ts` importing the projection and
`block-runner.ts` importing `helper.ts` walks straight past it. So the *call
sites* are pinned, not one import edge.

`tests/v2-07l-execution-lease.test.ts:1195` already owns the instrument:
`productionImportersOf` scans every file under `src/` and catches a named
import, a namespace import, a dynamic import and a re-export. Copy it into this
suite with its module pattern retargeted from `block-(store|progress)` to
`block-dependencies` — copied rather than shared, because a helper shared
between two suites is a helper neither can retarget.

Append:

```ts
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory = join(PACKAGE_ROOT, 'src')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

/** Every production module that can reach `projectBlockDependencies` statically. */
function projectionCallSites(): string[] {
  const declaring = join(PACKAGE_ROOT, 'src', 'block', 'block-dependencies.ts');
  const reached: string[] = [];
  for (const file of sourceFiles()) {
    if (file === declaring) continue;
    const text = readFileSync(file, 'utf8');
    const namesTheModule = /['"][^'"]*block-dependencies\.js['"]/.test(text);
    const named =
      namesTheModule &&
      /import[\s\S]{0,400}?\{[\s\S]{0,400}?\bprojectBlockDependencies\b[\s\S]{0,400}?\}/.test(text);
    const indirect =
      namesTheModule &&
      (/import\s*\*\s*as\s+\w+/.test(text) ||
        /import\s*\(/.test(text) ||
        /export\s*(\*|\{[^}]*\})\s*from/.test(text));
    if (named || indirect) reached.push(relative(PACKAGE_ROOT, file));
  }
  return reached.sort();
}

describe('the projection is computed at freeze time and nowhere else', () => {
  it('is reachable from exactly one production module', () => {
    // The freeze site, and nothing else. Not a style rule: a second caller is a
    // second moment at which "may B continue after A?" could be answered, and
    // the whole authority argument is that it is answered once, before the run,
    // and then frozen.
    //
    // Until Task 11 lands this list is empty, which is also correct — nothing
    // in src/ freezes a block yet. Change the expectation in the same commit
    // that adds the caller, never afterwards.
    expect(projectionCallSites()).toEqual([join('src', 'cli', 'block-command.ts')]);
  });

  it('is not reachable from the runner, by any route', () => {
    // Stated separately from the list above, because this is the claim the
    // runner's module header makes and a reader should be able to find it here
    // under its own name.
    expect(projectionCallSites()).not.toContain(join('src', 'block', 'block-runner.ts'));
  });
});
```

Until Task 11 exists the first expectation is `[]`. Write it as `[]` now and
change it to the CLI path **in Task 11's commit**, so gaining a caller is a
visible decision rather than a test edited to match.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS.

`npm run typecheck` still fails at the three Task 3 call sites. That is expected and is not this task's to fix.

- [ ] **Step 6: Do not commit yet**

Same reason as Task 1, Step 7: the tree still does not compile, and Task 3 is
what makes it compile again. Tasks 1–3 land as one commit at **Task 3, Step
10**.

---

### Task 3: Schema version 2 — the ledger freezes the relation, and refuses version 1

**Files:**
- Modify: `src/block/block-ledger.ts` (lines 76, 166–218, 235–269, 488–503)
- Modify: `src/block/block-progress.ts` (lines 174–203)
- Modify: `src/block/reconcile-block.ts` (line 223)
- Modify: `src/block/block-store.ts` (lines 99, 435–442, 505–527, 577–585)
- Modify: `tests/v2-07-block-ledger.test.ts` (lines 68–72, 134–152, 244–280)
- Modify: `tests/v2-07-remediation.test.ts` (lines 119–123, 205–225, 1150–1180)
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Consumes: `FrozenTaskDependency`, `fingerprintFrozenMembership` (Task 1).
- Produces: `BLOCK_LEDGER_SCHEMA_VERSION = 2`; `BlockRunLedger.frozenDependencies: FrozenTaskDependency[]`; the load code `LEDGER_SCHEMA_UNSUPPORTED`.

> **The contract this task fixes, stated before it is written.** A version-1
> ledger is **refused, never migrated**. It carries no dependency relation, and
> the only way to give it one is to invent it — which would hand a run the
> authority to continue after a task-local failure on a relation nobody froze.
> The refusal has its own load code so an operator learns "an older build wrote
> this" rather than "this file is malformed".

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach } from 'vitest';

import {
  BLOCK_LEDGER_SCHEMA_VERSION,
  safeParseBlockRunLedger,
} from '../src/block/block-ledger.js';
import { startBlockRun } from '../src/block/block-progress.js';
import { loadBlockLedger } from '../src/block/block-store.js';
import { fingerprintFrozenMembership } from '../src/block/block-definition.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';
import { e2eProfile, taskFile } from './helpers/e2e-fixtures.js';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const RUN_ID = 'run-0001';
const BLOCK_ID = 'V2';
const NOW = '2026-08-14T09:00:00.000Z';

interface Fixture {
  readonly repository: ResolvedRepository;
  readonly root: string;
}

/**
 * A real repository whose task files carry the dependencies asked for.
 *
 * Real throughout: the projection is taken from the repository's own graph, so
 * a fixture that wrote the relation by hand would prove only that the fixture
 * agreed with itself.
 */
async function repoWith(tasks: Readonly<Record<string, readonly string[]>>): Promise<Fixture> {
  const files: Record<string, string> = { '.gitignore': '.agent-orchestrator/runtime/\n' };
  for (const [taskId, dependsOn] of Object.entries(tasks)) {
    files[`tasks/${taskId}.md`] = taskFile(taskId, { dependsOn });
  }
  const root = createRepoFixture({ defaultBranch: 'main', profile: e2eProfile(), files });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return { repository, root };
}

function ledgerPath(root: string, runId = RUN_ID): string {
  return join(root, '.agent-orchestrator', 'runtime', 'blocks', `${runId}.json`);
}

/** A frozen, independent block over `taskIds`. */
function independentBlock(taskIds: readonly string[]) {
  const defined = defineBlock(BLOCK_ID, taskIds, independentRows(taskIds));
  if (!defined.ok) throw new Error(`fixture block is not a block: ${defined.code}`);
  return defined.definition;
}

function startRun(fixture: Fixture, definition = independentBlock(['A-001', 'B-001'])) {
  return startBlockRun({
    definition,
    repositoryId: fixture.repository.id,
    repositoryRoot: fixture.root,
    runId: RUN_ID,
    now: NOW,
  });
}

function reload(root: string, runId = RUN_ID) {
  const loaded = loadBlockLedger(root, runId);
  if (!loaded.ok) throw new Error(`ledger did not load: ${loaded.code}`);
  return loaded;
}

describe('the ledger freezes the relation, and version 1 is refused', () => {
  it('writes the relation into the first ledger and fingerprints all three parts', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    expect(startRun(fixture).ok).toBe(true);

    const ledger = reload(fixture.root).ledger;
    expect(ledger.schemaVersion).toBe(2);
    expect(ledger.frozenDependencies).toEqual([
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);
    expect(ledger.planFingerprint).toBe(
      fingerprintFrozenMembership(BLOCK_ID, ['A-001', 'B-001'], ledger.frozenDependencies),
    );
  });

  it('refuses a document whose fingerprint describes a different relation', () => {
    const honest = independentBlock(['A-001', 'B-001']);
    const edged = defineBlock(BLOCK_ID, ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    if (!edged.ok) throw new Error('fixture block is not a block');

    const lying = {
      schemaVersion: 2,
      repositoryId: 'fixture',
      repositoryRoot: 'D:\\repo',
      blockId: BLOCK_ID,
      runId: RUN_ID,
      startedAt: NOW,
      frozenTaskIds: ['A-001', 'B-001'],
      frozenDependencies: honest.dependencies,
      // The digest of a relation this document does not list. Stored and
      // believed, this inverts drift detection rather than losing it.
      planFingerprint: fingerprintFrozenMembership(
        BLOCK_ID,
        ['A-001', 'B-001'],
        edged.definition.dependencies,
      ),
      activeTaskId: null,
      tasks: [
        { taskId: 'A-001', disposition: 'PLANNED' as const, evidenceRevision: null, baseCommit: null, resultCommit: null },
        { taskId: 'B-001', disposition: 'PLANNED' as const, evidenceRevision: null, baseCommit: null, resultCommit: null },
      ],
      stopReason: null,
    };

    expect(safeParseBlockRunLedger(lying).success).toBe(false);
  });

  it('refuses a relation that is not one canonical row per member, in order', () => {
    const base = {
      schemaVersion: 2,
      repositoryId: 'fixture',
      repositoryRoot: 'D:\\repo',
      blockId: BLOCK_ID,
      runId: RUN_ID,
      startedAt: NOW,
      frozenTaskIds: ['A-001', 'B-001'],
      activeTaskId: null,
      tasks: [
        { taskId: 'A-001', disposition: 'PLANNED' as const, evidenceRevision: null, baseCommit: null, resultCommit: null },
        { taskId: 'B-001', disposition: 'PLANNED' as const, evidenceRevision: null, baseCommit: null, resultCommit: null },
      ],
      stopReason: null,
    };
    // The fingerprint is recomputed for each candidate, so every refusal below
    // is the relation rule refusing — not the digest disagreeing by accident.
    const withRelation = (dependencies: readonly FrozenTaskDependency[]) => ({
      ...base,
      frozenDependencies: dependencies,
      planFingerprint: fingerprintFrozenMembership(BLOCK_ID, ['A-001', 'B-001'], dependencies),
    });

    const refused: readonly (readonly FrozenTaskDependency[])[] = [
      // Short by one row.
      [{ taskId: 'A-001', dependsOn: [] }],
      // Reordered against `frozenTaskIds`.
      [
        { taskId: 'B-001', dependsOn: [] },
        { taskId: 'A-001', dependsOn: [] },
      ],
      // An edge to a stranger.
      [
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: ['X-001'] },
      ],
      // A self-edge.
      [
        { taskId: 'A-001', dependsOn: ['A-001'] },
        { taskId: 'B-001', dependsOn: [] },
      ],
      // Repeated, so one relation would have two encodings.
      [
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: ['A-001', 'A-001'] },
      ],
    ];

    for (const dependencies of refused) {
      expect(safeParseBlockRunLedger(withRelation(dependencies)).success).toBe(false);
    }

    // The control: a canonical relation over the same members is accepted, so
    // the rule above is not simply refusing everything.
    expect(
      safeParseBlockRunLedger(
        withRelation([
          { taskId: 'A-001', dependsOn: [] },
          { taskId: 'B-001', dependsOn: ['A-001'] },
        ]),
      ).success,
    ).toBe(true);
  });

  it('refuses a version-1 document under its own code, and migrates nothing', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);

    // A document exactly as the shipped version-1 build wrote them: no
    // `frozenDependencies`, and a fingerprint over two parts.
    const path = ledgerPath(fixture.root);
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const { frozenDependencies: _dropped, ...version1 } = current;
    writeFileSync(path, `${JSON.stringify({ ...version1, schemaVersion: 1 }, null, 2)}\n`, 'utf8');
    const before = readFileSync(path);

    const loaded = loadBlockLedger(fixture.root, RUN_ID);

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    // Its own code. `LEDGER_CONTRACT_VIOLATION` would tell an operator their
    // file is broken, when what happened is that an older build wrote it.
    expect(loaded.code).toBe('LEDGER_SCHEMA_UNSUPPORTED');
    // And nothing was rewritten on the way to saying so.
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('states the version this build writes', () => {
    expect(BLOCK_LEDGER_SCHEMA_VERSION).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — the schema version is 1, `frozenDependencies` is not a field, `LEDGER_SCHEMA_UNSUPPORTED` does not exist.

- [ ] **Step 3: Bump the version and add the field**

In `src/block/block-ledger.ts`, replace line 75–76:

```ts
/**
 * Contract version of the ledger document. Bump on any breaking shape change.
 *
 * **2 (V2-08).** Two changes land under one bump, deliberately: the frozen plan
 * gained `frozenDependencies`, and `BLOCK_STOP_REASONS` gained
 * `ACTIVE_TASK_UNRESOLVED`. Not one bump per value — and, equally deliberately,
 * no "the enum grew but the version stayed" exception. A reader of version 1
 * genuinely cannot understand a version-2 document: it would meet a stop reason
 * outside its closed vocabulary and a field its `.strict()` schema refuses.
 * Pretending otherwise is the kind of convenient untruth this repository keeps
 * removing.
 *
 * A version-1 document is refused on load and **never migrated**. See
 * `LEDGER_SCHEMA_UNSUPPORTED` in `block-store.ts` for why inventing the missing
 * relation would be worse than refusing.
 */
export const BLOCK_LEDGER_SCHEMA_VERSION = 2;
```

Replace the two imports at lines 68–73 with:

```ts
import { compareTaskIds, isValidTaskId } from '../plan/task-id.js';
import {
  fingerprintFrozenMembership,
  isValidBlockId,
  MAX_BLOCK_TASKS,
  type FrozenTaskDependency,
} from './block-definition.js';
```

Before `BlockTaskEntrySchema` (line 173), add:

```ts
const FrozenTaskDependencySchema = z
  .object({
    taskId: TaskIdSchema,
    /** Members this task transitively depends on. Deduplicated and sorted. */
    dependsOn: z.array(TaskIdSchema).max(MAX_BLOCK_TASKS),
  })
  .strict();
```

In `BlockRunLedgerObjectSchema`, after `frozenTaskIds` (line 208), add:

```ts
    /**
     * The dependency relation as frozen at start. Never edited afterwards.
     *
     * The **only** persisted image of the relation. No `dependents` copy sits
     * beside it: two spellings of one fact are two facts that can disagree, and
     * the one a run's continuation decision reads would then be a matter of
     * which the caller happened to look at.
     */
    frozenDependencies: z.array(FrozenTaskDependencySchema).min(1).max(MAX_BLOCK_TASKS),
```

- [ ] **Step 4: Add the invariants**

In the `superRefine` block, immediately after rule 1's `blockId` check (line 255), add:

```ts
  // --- 1a. The relation is one row per frozen task, in the same order -------
  // The same shape as rule 1, for the same reason: the frozen plan is the run's
  // identity, and a relation that drifted from the membership would make "what
  // does this run consider independent" a question with two answers. Row order
  // mirrors `frozenTaskIds`, so row order carries no information of its own and
  // one relation cannot have two fingerprints.
  const relationIds = value.frozenDependencies.map((row) => row.taskId);
  if (
    relationIds.length !== value.frozenTaskIds.length ||
    relationIds.some((id, index) => id !== value.frozenTaskIds[index])
  ) {
    issue(
      ['frozenDependencies'],
      'frozenDependencies must carry exactly one row per frozen task, in the same order.',
    );
  }
  const frozenMembers = new Set(value.frozenTaskIds);
  value.frozenDependencies.forEach((row, index) => {
    for (const dependency of row.dependsOn) {
      if (dependency === row.taskId) {
        issue(['frozenDependencies', index, 'dependsOn'], 'A task may not depend on itself.');
      } else if (!frozenMembers.has(dependency)) {
        // The relation is the *projection* onto this block's members. An edge
        // to a non-member is not a stricter relation, it is a different one —
        // and a runner reading it would answer independence from a task the
        // ledger says nothing else about.
        issue(
          ['frozenDependencies', index, 'dependsOn'],
          'A frozen dependency must name a task of this block.',
        );
      }
    }
    const canonical = [...new Set(row.dependsOn)].sort(compareTaskIds);
    if (
      row.dependsOn.length !== canonical.length ||
      row.dependsOn.some((id, position) => id !== canonical[position])
    ) {
      issue(
        ['frozenDependencies', index, 'dependsOn'],
        'dependsOn must be deduplicated and canonically sorted.',
      );
    }
  });
```

Replace the fingerprint re-derivation (lines 264–269) with:

```ts
  if (
    value.planFingerprint !==
    fingerprintFrozenMembership(value.blockId, value.frozenTaskIds, value.frozenDependencies)
  ) {
    issue(
      ['planFingerprint'],
      'planFingerprint must be the fingerprint of this document’s own blockId, frozenTaskIds and frozenDependencies.',
    );
  }
```

In `FIELD_AUTHORITY` (line 488), after `frozenTaskIds`, add:

```ts
  frozenDependencies: 'FROZEN_PLAN',
```

The `satisfies Record<keyof BlockRunLedger, …>` is what forced this line to exist; classifying it `FROZEN_PLAN` is what enforces it. `FROZEN_PLAN_FIELDS` is derived from the map, so a successor that edits the relation is refused as `FROZEN_PLAN_CHANGED` without a second rule being written anywhere.

- [ ] **Step 5: Freeze the relation at start**

In `src/block/block-progress.ts`, inside `startBlockRun`, add after the `frozenTaskIds` line (185):

```ts
    frozenDependencies: request.definition.dependencies.map((row) => ({
      taskId: row.taskId,
      dependsOn: [...row.dependsOn],
    })),
```

The rows are copied rather than referenced, for the reason the membership already is: a ledger sharing a frozen array with the caller's definition object is a ledger the caller can edit after the write.

- [ ] **Step 6: Give the reconciler the third part**

In `src/block/reconcile-block.ts`, replace line 223:

```ts
  const frozen = fingerprintFrozenMembership(
    ledger.blockId,
    ledger.frozenTaskIds,
    ledger.frozenDependencies,
  );
```

Nothing else in that module changes: it already holds a *current* definition's fingerprint against this value, so a definition whose relation differs now reports `DEFINITION_DRIFTED`. That widening is intended — an edge added under a running block is exactly the drift the frozen plan exists to notice.

- [ ] **Step 7: Refuse version 1 by its own name**

In `src/block/block-store.ts`, add to `LEDGER_LOAD_FAILURE_CODES` after `'LEDGER_CONTRACT_VIOLATION'` (line 510):

```ts
  /**
   * The document declares a schema version this build does not read.
   *
   * Kept apart from `LEDGER_CONTRACT_VIOLATION`, which says the document is not
   * a ledger. This one says it *is* one, written by a different build, and the
   * two send an operator to different places: a broken file, or a version
   * boundary.
   *
   * There is no migration, and that is a decision rather than an omission. A
   * version-1 ledger carries no `frozenDependencies`, and the only way to give
   * it one is to invent it — which would hand the run authority to continue
   * after a task-local failure on a relation nobody froze. Refusing costs an
   * operator one new run id; migrating would cost them a guarantee.
   */
  'LEDGER_SCHEMA_UNSUPPORTED',
```

Add `BLOCK_LEDGER_SCHEMA_VERSION` to the import from `./block-ledger.js` (line 99).

In `loadBlockLedger`, replace lines 584–585 with:

```ts
  // The version, before the contract. A version-1 document fails the contract
  // too — the `superRefine` refuses any other version and `.strict()` refuses
  // the field it lacks — but it would fail as `LEDGER_CONTRACT_VIOLATION`,
  // which describes a broken file rather than an older one.
  const declaredVersion = (document as { readonly schemaVersion?: unknown }).schemaVersion;
  if (
    typeof declaredVersion === 'number' &&
    Number.isSafeInteger(declaredVersion) &&
    declaredVersion > 0 &&
    declaredVersion !== BLOCK_LEDGER_SCHEMA_VERSION
  ) {
    return loadFailure('LEDGER_SCHEMA_UNSUPPORTED');
  }

  const parsed = safeParseBlockRunLedger(document);
  if (!parsed.success) return loadFailure('LEDGER_CONTRACT_VIOLATION');
```

In `updateBlockLedger`, replace line 442 with:

```ts
  const previous = safeParseBlockRunLedger(document);
  if (!previous.success) {
    // The same distinction the load path draws, at the one other place a
    // persisted ledger is read. A predecessor written by an older build is not
    // an invalid predecessor, and a caller told `PREDECESSOR_INVALID` would go
    // looking for corruption that is not there.
    const declared = (document as { readonly schemaVersion?: unknown }).schemaVersion;
    return saveFailure(
      'LEDGER_CONFLICT',
      declared !== BLOCK_LEDGER_SCHEMA_VERSION
        ? 'PREDECESSOR_SCHEMA_UNSUPPORTED'
        : 'PREDECESSOR_INVALID',
    );
  }
```

- [ ] **Step 8: Re-base the two V2-07 suites**

Neither suite is being weakened; both are being told about a field that did not exist. The changes are mechanical.

In `tests/v2-07-block-ledger.test.ts`, replace the `block` helper (lines 69–73):

```ts
function block(taskIds: readonly string[] = ['A-001', 'B-001']) {
  // Independent by construction, which is what these fixtures always meant.
  // Written out rather than defaulted inside `defineBlock`, because a default
  // would let a caller freeze "everything is independent" without saying so.
  const defined = defineBlock(
    BLOCK_ID,
    taskIds,
    taskIds.map((taskId) => ({ taskId, dependsOn: [] })),
  );
  if (!defined.ok) throw new Error(`fixture block is not a block: ${defined.code}`);
  return defined.definition;
}
```

The four direct `defineBlock` calls in the definition case (lines 136–140) each gain a third argument. Every literal ledger object (lines ~244–280) gains `frozenDependencies` and a three-argument `fingerprintFrozenMembership`.

In `tests/v2-07-remediation.test.ts`, apply the same helper change at lines 119–123; add `frozenDependencies` to the `midFlight` literal (line ~1155) and to the `usurper` literal (line ~208, whose `frozenTaskIds` is `['A-001']`, so its relation is `[{ taskId: 'A-001', dependsOn: [] }]`); and give the `defineBlock('A-001', ['A-001', 'B-001'])` case at line 1135 its rows.

Do not hunt for the rest by hand: `npm run typecheck` names every call site and `safeParseBlockRunLedger` names every literal missing the field. Work both lists until they are quiet.

- [ ] **Step 9: Run everything that touches a ledger**

Run: `npm run typecheck`
Expected: clean — this is what proves no call site still builds a two-part fingerprint.

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts tests/v2-07-block-ledger.test.ts tests/v2-07-remediation.test.ts`
Expected: PASS. One case still asserts V2-07's policy and still passes here — `tests/v2-07-remediation.test.ts:741` ("records a genuinely blocked task, and then refuses to progress the run"). Task 5 inverts it; leave it alone now.

- [ ] **Step 10: Commit — Tasks 1, 2 and 3 together**

This is the first commit of the slice, and it is the first moment the tree
compiles. Tasks 1 and 2 introduced the three-argument definition API and the
projection that fills it; this task repaired every call site without ever
defaulting one to an empty relation.

```bash
git add src/block tests/v2-07-block-ledger.test.ts tests/v2-07-remediation.test.ts tests/v2-08-attended-block-runner.test.ts
git commit
```

Check `git status` before committing: `src/block/block-definition.ts` and
`src/block/block-dependencies.ts` from Tasks 1 and 2 must be in this commit. A
run of `npm run typecheck` that is clean is what says the set is complete.

Message:

```
feat: the frozen block plan carries its dependency relation (V2-08)

BlockDefinition was blockId plus taskIds, and the fingerprint covered exactly
those, so V2-08 could not prove independence from its own authoritative input
and continue-on-task-local-failure would have been dead code in every block.

The relation is frozen as evidence rather than as an `independent: true`
judgement: a flag would freeze the conclusion while leaving what it came from
free to move. It is bound into the fingerprint, so an edge added or removed
under a running block is drift rather than a silent change of authority - the
canonical encoding needs three separators rather than one, because with a
single separator {A:[B],B:[]} and {A:[],B:[A]} are permutations of one token
list. Five failure codes rather than one: a missing row, a row for a stranger,
two rows for one member, an edge to a non-member and a self-edge are five
different mistakes with five different fixes.

The relation is the transitive projection, computed once at freeze time.
Measured against task-graph.ts: normalizeTaskGraph stores each definition's own
edge list and its direct reverse and computes no transitive closure anywhere. A
block is an arbitrary subset of that DAG, so A <- X <- B with X outside the
block has no intra-block edge while B still depends on A. The walk goes up the
whole graph and restricts to members at the end, and an unknown member is
refused rather than projected as an empty row - "independent of everything" is
the worst possible answer about a task nobody can find. Freeze-time-only is
pinned by the call sites rather than by one import edge, because a helper
importing the projection and a runner importing the helper would walk past an
import check.

frozenDependencies is the single persisted image of it. No dependents copy sits
beside it: two spellings of one fact are two facts that can disagree, and the
one a continuation decision reads would be whichever the caller looked at. It is
classified FROZEN_PLAN in FIELD_AUTHORITY, so succession refuses an edit to it
by derivation rather than by a new rule, and planFingerprint is re-derived from
all three parts on every create, update and load.

A version-1 document is refused under LEDGER_SCHEMA_UNSUPPORTED and never
migrated. It carries no relation, and the only way to give it one is to invent
it - handing the run authority to continue after a task-local failure on a
relation nobody froze. Refusing costs an operator one new run id. One bump for
the slice, covering this field and the stop reason that follows; a version-1
reader genuinely cannot read a version-2 document, so "the enum grew but the
version stayed" was not available.

Three implementation steps, one commit: the new definition API and its call
sites cannot be separated without patching the sites with an empty relation,
which would default to "everything is independent" - the claim this slice exists
to stop assuming.
```

---

### Task 4: `ACTIVE_TASK_UNRESOLVED`, and a sorting that must be correct rather than total

**Files:**
- Modify: `src/block/block-ledger.ts` (lines 128–164)
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Produces: `'ACTIVE_TASK_UNRESOLVED'` as a member of `BLOCK_STOP_REASONS`, deliberately absent from `PROGRESS_CLAIMING_STOP_REASONS`.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import {
  BLOCK_STOP_REASONS,
  PROGRESS_CLAIMING_STOP_REASONS,
  type BlockStopReason,
} from '../src/block/block-ledger.js';

describe('the stop-reason vocabulary is sorted correctly, not merely totally', () => {
  /**
   * Written by hand, reason by reason, and deliberately not derived from the
   * production set.
   *
   * `satisfies Record<keyof T>` proves every member was *considered*; it proves
   * nothing about whether each landed on the right side. A table generated from
   * the module under test would agree with it by construction and could never
   * disagree, which is the only thing a correctness test is for.
   */
  const CLAIMS_PROGRESS: Readonly<Record<BlockStopReason, boolean>> = {
    // These three assert what the *tasks* did, and are proved against every
    // task record before they are written.
    COMPLETE: true,
    TASK_BLOCKED: true,
    TASK_ABANDONED: true,
    // These assert only that the run cannot continue, and must stay writable
    // over a ledger whose entries are not supported.
    NO_ELIGIBLE_TASK: false,
    OPERATOR_STOPPED: false,
    LEDGER_DIVERGED: false,
    STATE_UNUSABLE: false,
    DEFINITION_DRIFTED: false,
    ACTIVE_TASK_UNRESOLVED: false,
  };

  it('knows exactly these reasons', () => {
    expect([...BLOCK_STOP_REASONS].sort()).toEqual(Object.keys(CLAIMS_PROGRESS).sort());
  });

  for (const [reason, claims] of Object.entries(CLAIMS_PROGRESS)) {
    it(`${reason} ${claims ? 'claims' : 'does not claim'} progress`, () => {
      expect(PROGRESS_CLAIMING_STOP_REASONS.has(reason as BlockStopReason)).toBe(claims);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — `ACTIVE_TASK_UNRESOLVED` is not a member, so the key-set comparison fails and its own case fails with it.

- [ ] **Step 3: Add the reason**

In `src/block/block-ledger.ts`, add to `BLOCK_STOP_REASONS` after `'DEFINITION_DRIFTED'`:

```ts
  /**
   * An active task's outcome could not be safely established, so the run ends.
   *
   * ── Why this is not `STATE_UNUSABLE` ───────────────────────────────────────
   *
   * `STATE_UNUSABLE` says something about the task *state*: damaged, foreign,
   * not trustworthy. A task can hold entirely legitimate prior evidence and
   * still end in a condition whose outcome cannot be determined — a driver that
   * made no progress, a settlement whose proof no longer holds, an interruption
   * nothing can conclude. That is a **different fact**, and folding it into
   * `STATE_UNUSABLE` is exactly the misdescription class V2-07P spent three
   * review rounds deleting.
   *
   * ── What it may and may not carry ──────────────────────────────────────────
   *
   * It **may coexist** with `ACTIVE` and an unchanged `activeTaskId`: it does
   * not require the run to first invent a disposition for the task it could not
   * conclude. It drags **no** task disposition and **no** commit evidence with
   * it — `assessLedgerSuccession`'s `UNRESOLVED_STOP_CARRIED_MORE` already holds
   * that write to saying one thing.
   *
   * It is deliberately **not** required to have an active task. The design says
   * where it may coexist with one, never that it may only be written with one,
   * and a class-2 reason that quietly acquired a precondition is the shape that
   * wedges a run in the case the reason was added for.
   */
  'ACTIVE_TASK_UNRESOLVED',
```

Extend the doc comment above `PROGRESS_CLAIMING_STOP_REASONS` with:

```ts
 * `ACTIVE_TASK_UNRESOLVED` is deliberately not a member, and the omission is
 * load-bearing rather than incidental. Sorted in, it would be proved against
 * every task record before it could be written — and it exists precisely for
 * the case where one of those records cannot be judged. It would be unwritable
 * exactly when it is true.
```

The set itself does not change, and that is the point: a reason joins the vocabulary without joining the proved set, and the test above is what says the omission was a decision rather than an oversight.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean. Note what did *not* break: nothing maps over `BlockStopReason` exhaustively yet. Task 11 adds the first such table, and from then on a new reason fails the build until somebody grades it.

- [ ] **Step 5: Prove the reason is writable over an unproved ledger, and carries nothing**

Design §8.7 and §8.3b in one case: the wedge the non-progress-claiming set exists to prevent, and the coexistence contract. Append:

```ts
import { activateBlockTask, stopBlockRun } from '../src/block/block-progress.js';
import { startTask } from '../src/run/start-task.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { leaseFor } from './helpers/lease.js';
import { tickingClock } from './helpers/e2e-fixtures.js';

/** A real task, started through production code, so its state is a real one. */
async function reallyStart(fixture: Fixture, taskId: string): Promise<void> {
  const started = await startTask(
    { repository: fixture.repository, taskId },
    {
      git: runGitCommand,
      now: tickingClock(),
      authPreflight: authPreflightPasses,
      lease: leaseFor(fixture.repository),
    },
  );
  expect(started.outcome).toBe('STARTED');
}

/** The ledger as JSON, read from disk. Assertions are on what persisted. */
function onDisk(root: string, runId = RUN_ID): Record<string, unknown> {
  return JSON.parse(readFileSync(ledgerPath(root, runId), 'utf8')) as Record<string, unknown>;
}

describe('a class-2 stop is writable over a ledger whose entries are not proved', () => {
  it('records ACTIVE_TASK_UNRESOLVED while the task it cannot judge is still ACTIVE', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    expect(
      activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');

    const stopped = stopBlockRun(reload(fixture.root), 'ACTIVE_TASK_UNRESOLVED', {
      repositoryRoot: fixture.root,
    });

    expect(stopped.outcome).toBe('RECORDED');
    const after = onDisk(fixture.root);
    expect(after['stopReason']).toBe('ACTIVE_TASK_UNRESOLVED');
    // The entry is still ACTIVE, under the same activeTaskId, and nothing was
    // invented for the task that could not be concluded.
    expect(after['activeTaskId']).toBe('A-001');
    const entries = after['tasks'] as readonly Record<string, unknown>[];
    expect(entries[0]?.['disposition']).toBe('ACTIVE');
    expect(entries[0]?.['evidenceRevision']).toBeNull();
    expect(entries[0]?.['resultCommit']).toBeNull();
  }, 180_000);
});
```

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS. A failure here reading `ANOTHER_TASK_ACTIVE` means the reason was sorted into `PROGRESS_CLAIMING_STOP_REASONS` — which is the wedge this case exists to catch.

- [ ] **Step 6: Commit**

```bash
git add src/block/block-ledger.ts tests/v2-08-attended-block-runner.test.ts
git commit
```

Message:

```
feat: ACTIVE_TASK_UNRESOLVED, the one new persisted stop reason (V2-08)

STATE_UNUSABLE says the task state is damaged, foreign or untrustworthy. A task
can hold entirely legitimate prior evidence and still end in a condition whose
outcome cannot be determined. Folding the second into the first is the
misdescription class V2-07P spent three review rounds deleting.

It stays out of PROGRESS_CLAIMING_STOP_REASONS, and the omission is the
decision: sorted in, it would be proved against every task record before it
could be written, and it exists for the case where one of those records cannot
be judged. It would be unwritable exactly when it is true.

The sorting is pinned by a hand-written table rather than by `satisfies`, which
proves every member was considered and nothing about whether each landed on the
right side. The effect is pinned too: the reason is recorded over a still-ACTIVE
task, and the entry keeps its disposition, its null evidence and its null result
commit.
```

---

### Task 5: The policy reversal — a blocked task no longer stops the run

**Files:**
- Modify: `src/block/block-ledger.ts` (lines 84–103)
- Modify: `src/block/block-progress.ts` (lines 296–341)
- Modify: `tests/v2-07-remediation.test.ts` (lines 741–773)
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Produces: `parkBlockTask` records `BLOCKED` and **no** stop reason. Its result shape, outcomes and evidence rules are unchanged.

> **The premise, measured.** `src/block/block-progress.ts:332` writes
> `stopReason: 'TASK_BLOCKED'` into the same successor that records the
> disposition, and `src/block/block-ledger.ts:92-93` documents `BLOCKED` as "a
> blocked task is waiting for a human and **stops the run as a matter of
> policy**". This task reverses a shipped, proved contract statement, so it is a
> task of its own with its own control rather than a comment edited in passing.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import { parkBlockTask } from '../src/block/block-progress.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';

/** Drives a real task's durable state into a blocking one. */
function driveToBlocking(fixture: Fixture, taskId: string): void {
  const loaded = loadTaskState(fixture.root, taskId);
  if (!loaded.ok) throw new Error('fixture: the task never started');
  // `SCOPE_VIOLATION` rather than one of the resumable blocks: it is blocking
  // by the state contract's own classification and carries no resume point, so
  // the fixture states one fact and not three.
  const saved = saveTaskState(
    {
      ...loaded.state,
      state: 'SCOPE_VIOLATION',
      stateEnteredAt: '2026-08-14T12:00:00.000Z',
      blockedAgent: 'claude',
    },
    { repositoryRoot: fixture.root, expectedRevision: loaded.revision },
  );
  if (!saved.ok) throw new Error(`fixture could not reach a blocking state: ${saved.code}`);
}

describe('a task-local failure is recorded and does not end the run', () => {
  it('parks a task without writing a stop reason', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    expect(
      activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');
    driveToBlocking(fixture, 'A-001');

    expect(
      parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');

    const after = onDisk(fixture.root);
    // The evidence-backed disposition is unchanged. Only the run's reaction to
    // it is what V2-08 reverses.
    expect((after['tasks'] as readonly Record<string, unknown>[])[0]?.['disposition']).toBe('BLOCKED');
    expect((after['tasks'] as readonly Record<string, unknown>[])[0]?.['evidenceRevision']).not.toBeNull();
    expect(after['stopReason']).toBeNull();
    expect(after['activeTaskId']).toBeNull();
  }, 180_000);

  it('lets the next task be activated afterwards', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToBlocking(fixture, 'A-001');
    parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    await reallyStart(fixture, 'B-001');

    // This is the assertion that fails against V2-07's policy, so it is the one
    // that proves the reversal actually happened. Under V2-07 the park wrote
    // TASK_BLOCKED and this answered RUN_ALREADY_STOPPED.
    expect(
      activateBlockTask(reload(fixture.root), 'B-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');
  }, 180_000);

  it('still refuses to park a task whose record does not prove it', async () => {
    // The reversal changes the run's reaction, never the evidence rule.
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');

    expect(
      parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
  }, 180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — the first case reads `stopReason: 'TASK_BLOCKED'`, the second answers `RUN_ALREADY_STOPPED`. The third already passes; it is the control that the evidence rule is untouched.

- [ ] **Step 3: Stop writing the stop reason**

In `src/block/block-progress.ts`, in `parkBlockTask`, delete line 332:

```ts
    stopReason: 'TASK_BLOCKED',
```

and replace the function's doc comment (lines 298–304) with:

```ts
/**
 * Records that a task stopped on something a human must resolve.
 *
 * Evidence-backed in the same way settlement is, and for the same reason: a
 * ledger that could declare a task blocked without its record saying so would
 * be able to stall a run on a fact nobody established.
 *
 * ── What this deliberately no longer does ──────────────────────────────────
 *
 * It used to write `stopReason: 'TASK_BLOCKED'` into the same successor, so
 * parking a task *was* ending the run. V2-08 separates the two: a task's own
 * failure is one fact, and whether the run can continue is another.
 *
 * Continuing is safe here — and only here — because every continuation is still
 * gated by the same proof. `settleBlockTask` will not record a settlement the
 * next task's own state does not support, whatever happened to a sibling, so a
 * blocked A cannot make a false claim about B possible. What ends a run instead
 * is a condition that puts *the machinery which would catch a false claim* in
 * doubt, and those are the runner's to detect.
 *
 * `TASK_BLOCKED` survives as an end-of-run reason with its meaning narrowed
 * from "abort now" to "this run ended without completing, and a task outcome is
 * why". The runner writes it once, at the end, when nothing runnable is left —
 * see `block-conclusion.ts` for why that reason beats `NO_ELIGIBLE_TASK`.
 */
```

- [ ] **Step 4: Reverse the documented policy**

In `src/block/block-ledger.ts`, replace the `BLOCKED` and `ABANDONED` entries of `TASK_DISPOSITIONS` (lines 86–103) with:

```ts
  /**
   * Stopped on something a human must resolve. Also evidence-backed.
   *
   * Terminal for this task and **not** for the run. Until V2-08 this was
   * documented the other way round — "a blocked task is waiting for a human and
   * stops the run as a matter of policy" — and `parkBlockTask` implemented it by
   * writing a stop reason. Both are gone. A block of independent tasks in which
   * one fails locally is not a wasted run: the remaining tasks are still
   * provable on their own records, and stopping would have thrown away work
   * nothing was wrong with.
   *
   * What did not change: this disposition is still `EVIDENCE_BACKED`, still
   * terminal for the task, and still unrecordable without the task state that
   * proves it.
   */
  'BLOCKED',
  /**
   * Given up on, on the strength of a task state that reached `ABORTED`.
   *
   * Terminal, and deliberately **not** `BLOCKED`. The two look similar and are
   * opposite: a blocked task is waiting for a human, while an abandoned one is
   * over — nothing continues from `ABORTED`, and there is nothing for a human to
   * resolve.
   *
   * Without it the run has no legal move at all when its active task aborts:
   * settling would claim work that did not finish, parking would claim a block
   * that does not exist, and `stopBlockRun` refuses a progress-claiming reason
   * while a task is `ACTIVE`. A contract whose only remaining move is to falsify
   * one of its own records has wedged the run, and inventing progress to escape
   * is exactly what this ledger exists to prevent.
   *
   * Like `BLOCKED`, it no longer ends the run by itself (V2-08). `COMPLETE`
   * still requires every task `SETTLED`, so an abandoned task correctly makes
   * the block uncompletable rather than silently forgivable.
   */
  'ABANDONED',
```

- [ ] **Step 5: Invert the V2-07 case that asserted the old policy**

In `tests/v2-07-remediation.test.ts`, replace the last two assertions of "records a genuinely blocked task, and then refuses to progress the run" (lines 764–772) with:

```ts
    expect(parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');
    // V2-08 reversed this. The park used to write TASK_BLOCKED, which ended the
    // run; the disposition and its evidence are unchanged, and only the run's
    // reaction to them moved. The continuation case itself lives in
    // tests/v2-08-attended-block-runner.test.ts, beside the policy it belongs to.
    expect(onDisk(fixture.root)['stopReason']).toBeNull();
```

Rename the case to `'records a genuinely blocked task, and leaves the run open'`.

Do not delete the case. It is the only place a *real* blocking state is driven through `parkBlockTask` against a real repository in that suite, and deleting it would take that instrument with it.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts tests/v2-07-remediation.test.ts tests/v2-07-block-ledger.test.ts`
Expected: PASS.

Run: `git grep -n "stops the run as a matter of policy" -- src/`
Expected: no matches. Design §8.8 is that assertion, made against the tree rather than against a rendering of it.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/block/block-ledger.ts src/block/block-progress.ts tests/v2-07-remediation.test.ts tests/v2-08-attended-block-runner.test.ts
git commit
```

Message:

```
feat: a blocked task no longer ends the block run (V2-08)

parkBlockTask wrote stopReason: TASK_BLOCKED into the same successor that
recorded the disposition, so parking a task *was* ending the run, and
TASK_DISPOSITIONS said so as contract. Both are reversed here rather than
edited in passing, because both were shipped and proved.

Continuing is safe here and only here: every continuation is still gated by the
same proof, so a blocked A cannot make a false claim about B possible. What
ends a run instead is a condition that puts the machinery which would catch a
false claim in doubt.

BLOCKED and ABANDONED keep everything else - evidence-backed, terminal for the
task, unrecordable without the state that proves them. TASK_BLOCKED survives as
an end-of-run reason with its meaning narrowed from "abort now" to "this run
ended without completing, and a task outcome is why".

The V2-07 case that asserted the old policy is inverted rather than deleted: it
is the only place that suite drives a real blocking state through parkBlockTask
against a real repository.
```

---

### Task 6: The pure decision layer

**Files:**
- Create: `src/block/block-conclusion.ts`
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Consumes: `RunOutcome` from `src/run/run-driver.ts`; `BlockProgressOutcome` from `src/block/block-progress.ts`; `BlockStopReason`, `BlockTaskEntry` from `src/block/block-ledger.ts`; `FrozenTaskDependency` from `src/block/block-definition.ts`.
- Produces: `TASK_CONCLUSIONS`; `type TaskConclusion`; `conclusionForRunOutcome(outcome: RunOutcome): TaskConclusion`; `RECORDING_RESULTS`; `type RecordingResult`; `recordingResultFor(outcome: BlockProgressOutcome): RecordingResult`; `endReasonFor(entries: readonly BlockTaskEntry[]): BlockStopReason`; `independenceIsEstablished(dependencies: readonly FrozenTaskDependency[]): boolean`.

This task holds every decision the runner makes that is not I/O. It is separated so that the four judgements below can be reviewed, and broken, without a repository, a lease or a subprocess in the way.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import {
  conclusionForRunOutcome,
  endReasonFor,
  independenceIsEstablished,
  recordingResultFor,
} from '../src/block/block-conclusion.js';
import { BLOCK_PROGRESS_OUTCOMES, type BlockProgressOutcome } from '../src/block/block-progress.js';
import { RUN_OUTCOMES, type RunOutcome } from '../src/run/run-driver.js';
import type { BlockTaskEntry, TaskDisposition } from '../src/block/block-ledger.js';

describe('a run outcome decides what the ledger may be told', () => {
  /**
   * Hand-written, outcome by outcome. Derived from the production map this
   * would be a copy that cannot disagree; the point of the table is that a
   * reviewer graded each row and a future member cannot inherit a grade.
   */
  const EXPECTED: Readonly<Record<RunOutcome, string>> = {
    // The task's own record proves an outcome.
    TASK_COMPLETED: 'SETTLE',
    TASK_ABORTED: 'ABANDON',
    BLOCKED_USAGE_LIMIT: 'PARK',
    BLOCKED_VERIFY: 'PARK',
    BLOCKED_AUTH: 'PARK',
    SCOPE_VIOLATION: 'PARK',
    RESUME_STATE_DIVERGED: 'PARK',
    HUMAN_DECISION_REQUIRED: 'PARK',
    // The run's authority is in doubt. Nothing may be written at all.
    EXECUTION_LEASE_NOT_HELD: 'LEASE_UNCERTAIN',
    EXECUTION_LEASE_LOST: 'LEASE_UNCERTAIN',
    // A task record exists and cannot be used. That is its own class-2 reason.
    STATE_UNUSABLE: 'STATE_UNUSABLE',
    // Durable progress happened and the driver's per-call bound was reached.
    // The one grade that is not an ending at all: the runner drives the same
    // task again under the same lease. Graded any other way, a scheduling limit
    // becomes a claim about a task's outcome — and graded as an ending of the
    // invocation it would need a block run that outlives its lease holder.
    STEP_BUDGET_EXHAUSTED: 'CONTINUE',
    // Everything else leaves the task's outcome undetermined. Each is a real
    // situation and none of them proves settle, park or abandon.
    STATE_DIVERGED: 'UNRESOLVED',
    STATE_UNOBSERVABLE: 'UNRESOLVED',
    TASK_NOT_STARTED: 'UNRESOLVED',
    STATE_CONFLICT: 'UNRESOLVED',
    STATE_NOT_RECORDED: 'UNRESOLVED',
    CONTINUATION_NOT_AUTHORISED: 'UNRESOLVED',
    EXECUTION_UNAUTHORISED: 'UNRESOLVED',
    NO_PROGRESS: 'UNRESOLVED',
  };

  it('grades every run outcome, and only the run outcomes', () => {
    expect([...RUN_OUTCOMES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [outcome, conclusion] of Object.entries(EXPECTED)) {
    it(`${outcome} -> ${conclusion}`, () => {
      expect(conclusionForRunOutcome(outcome as RunOutcome)).toBe(conclusion);
    });
  }
});

describe('a progress outcome decides whether anything landed', () => {
  const EXPECTED: Readonly<Record<BlockProgressOutcome, string>> = {
    RECORDED: 'RECORDED',
    // The write itself could not be made. The run cannot presuppose a
    // successful stop write either, so this is the no-write exit.
    NOT_RECORDED: 'WRITE_FAILED',
    // Every refusal that is *about the claim* rather than about the write. The
    // task's outcome is not established, and the honest end is a stop that says
    // so rather than a second attempt at a claim the records refuse.
    TASK_NOT_IN_RUN: 'UNRESOLVED',
    DISPOSITION_UNCHANGED: 'UNRESOLVED',
    ANOTHER_TASK_ACTIVE: 'UNRESOLVED',
    TASK_STATE_DOES_NOT_PROVE_IT: 'UNRESOLVED',
    TASK_NOT_STARTED: 'UNRESOLVED',
    TASK_STATE_UNUSABLE: 'STATE_UNUSABLE',
    RUN_ALREADY_STOPPED: 'UNRESOLVED',
  };

  it('grades every progress outcome', () => {
    expect([...BLOCK_PROGRESS_OUTCOMES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [outcome, result] of Object.entries(EXPECTED)) {
    it(`${outcome} -> ${result}`, () => {
      expect(recordingResultFor(outcome as BlockProgressOutcome)).toBe(result);
    });
  }
});

describe('the end reason names the cause, not the consequence', () => {
  const entry = (taskId: string, disposition: TaskDisposition): BlockTaskEntry => ({
    taskId,
    disposition,
    evidenceRevision: disposition === 'PLANNED' || disposition === 'ACTIVE' ? null : 'f'.repeat(64),
    baseCommit: null,
    resultCommit: null,
  });

  it('is COMPLETE when every task settled', () => {
    expect(endReasonFor([entry('A-001', 'SETTLED'), entry('B-001', 'SETTLED')])).toBe('COMPLETE');
  });

  // The worked example from the design. A block that did as much as could
  // honestly be done ends naming the task outcome that explains the remainder.
  it('is TASK_BLOCKED when a task is blocked and nothing runnable is left', () => {
    expect(
      endReasonFor([
        entry('A-001', 'BLOCKED'),
        entry('B-001', 'SETTLED'),
        entry('C-001', 'SETTLED'),
      ]),
    ).toBe('TASK_BLOCKED');
  });

  it('prefers BLOCKED over ABANDONED when both are present', () => {
    // Ordered, not arbitrary: a human can act on a blocked task, and nobody can
    // act on an abandoned one. The reason should send them to the one that has
    // a next step.
    expect(endReasonFor([entry('A-001', 'BLOCKED'), entry('B-001', 'ABANDONED')])).toBe(
      'TASK_BLOCKED',
    );
  });

  it('is TASK_ABANDONED when only an abandonment explains the ending', () => {
    expect(endReasonFor([entry('A-001', 'ABANDONED'), entry('B-001', 'SETTLED')])).toBe(
      'TASK_ABANDONED',
    );
  });

  // The other half of the pair. Only both cases together prove an ordering
  // rather than a constant.
  it('is NO_ELIGIBLE_TASK when no disposition explains why nothing is eligible', () => {
    expect(endReasonFor([entry('A-001', 'PLANNED'), entry('B-001', 'SETTLED')])).toBe(
      'NO_ELIGIBLE_TASK',
    );
  });
});

describe('independence is read from the frozen plan', () => {
  it('is established only when no member depends on a member', () => {
    expect(
      independenceIsEstablished([
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: [] },
      ]),
    ).toBe(true);
    expect(
      independenceIsEstablished([
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: ['A-001'] },
      ]),
    ).toBe(false);
  });

  it('does not care which member the edge is on', () => {
    // A relation with any edge at all is dependent execution, which is V2-09.
    // There is no partial answer here and deliberately no per-pair one: "these
    // two are independent, so run them and skip the rest" is the improvised
    // scheduling this slice refuses.
    expect(
      independenceIsEstablished([
        { taskId: 'A-001', dependsOn: ['C-001'] },
        { taskId: 'B-001', dependsOn: [] },
        { taskId: 'C-001', dependsOn: [] },
      ]),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — cannot resolve `../src/block/block-conclusion.js`.

- [ ] **Step 3: Write the decision layer**

Create `src/block/block-conclusion.ts`:

```ts
/**
 * Every decision the block runner makes that is not I/O.
 *
 * Four judgements live here, kept apart from the sequencing so that each can be
 * reviewed — and broken — without a repository, a lease or a subprocess in the
 * way:
 *
 *   1. what a task's run outcome entitles the ledger to be told;
 *   2. whether a recording attempt landed, was refused, or could not be written
 *      at all;
 *   3. which reason a run ends under;
 *   4. whether the frozen plan establishes independence.
 *
 * ── Total by type, correct by test ─────────────────────────────────────────
 *
 * Both maps are written `satisfies Record<…>` over a vocabulary owned
 * elsewhere, so a new run outcome or progress outcome fails the build here
 * until somebody grades it. That is completeness and it is all a type can do:
 * nothing in the compiler objects to `TASK_ABORTED` being graded `SETTLE`. The
 * grades themselves are pinned by hand-written tables in
 * `tests/v2-08-attended-block-runner.test.ts`, which are deliberately not
 * derived from these maps — a table generated from the module under test agrees
 * with it by construction and can never disagree.
 */

import type { FrozenTaskDependency } from './block-definition.js';
import type { BlockStopReason, BlockTaskEntry } from './block-ledger.js';
import type { BlockProgressOutcome } from './block-progress.js';
import type { RunOutcome } from '../run/run-driver.js';

/* ─────────────────── 1. what a run outcome entitles ──────────────────────── */

/** What a driven task's outcome entitles this run to record. A closed set. */
export const TASK_CONCLUSIONS = [
  /** The record proves `READY_FOR_PR`. */
  'SETTLE',
  /** The record proves a blocking state. */
  'PARK',
  /** The record proves `ABORTED`. */
  'ABANDON',
  /**
   * The task's outcome cannot be established, and re-driving would do the same
   * thing again. The run ends with `ACTIVE_TASK_UNRESOLVED`.
   */
  'UNRESOLVED',
  /** A task record exists and cannot be used. The run ends `STATE_UNUSABLE`. */
  'STATE_UNUSABLE',
  /**
   * This run may no longer be the repository's writer.
   *
   * Kept apart from every other conclusion because it is the one that forbids
   * the *write*, not merely the claim: any further ledger mutation is precisely
   * the act the run has lost the authority for.
   */
  'LEASE_UNCERTAIN',
  /**
   * The driver's own per-call step budget ran out, with durable progress made.
   *
   * **Drive the same task again, under the same lease.** Not an ending of any
   * kind: `maxSteps` bounds one `runTask` call so a driver cannot run away, and
   * reaching it says nothing about the task's outcome. Graded as an ending it
   * would turn a scheduling limit into `ACTIVE_TASK_UNRESOLVED`, a claim about a
   * task; graded as an ending of the *invocation* it would need a block run
   * that outlives its holder, which the lease guarantee does not allow.
   *
   * The continuation terminates: every `STEP_BUDGET_EXHAUSTED` carries durable
   * progress by its own definition, the task's state machine is bounded by the
   * repository's `maxReviewRounds`, and a continuation that lands zero durable
   * steps is refused as unresolved rather than tried again.
   */
  'CONTINUE',
] as const;

export type TaskConclusion = (typeof TASK_CONCLUSIONS)[number];

const CONCLUSION_FOR_RUN_OUTCOME = Object.freeze({
  TASK_COMPLETED: 'SETTLE',
  TASK_ABORTED: 'ABANDON',

  // The six blocking states, each of which the task's own record now carries.
  // `parkBlockTask` re-reads that record and refuses if it does not classify as
  // BLOCKING, so this map proposes and the evidence disposes.
  BLOCKED_USAGE_LIMIT: 'PARK',
  BLOCKED_VERIFY: 'PARK',
  BLOCKED_AUTH: 'PARK',
  SCOPE_VIOLATION: 'PARK',
  RESUME_STATE_DIVERGED: 'PARK',
  HUMAN_DECISION_REQUIRED: 'PARK',

  // Authority, not outcome. `EXECUTION_LEASE_NOT_HELD` means this invocation
  // never was the writer and `EXECUTION_LEASE_LOST` means it has stopped being
  // one; the operator's next move differs, which is why the driver keeps two
  // outcomes, and the *ledger's* answer is identical: write nothing.
  EXECUTION_LEASE_NOT_HELD: 'LEASE_UNCERTAIN',
  EXECUTION_LEASE_LOST: 'LEASE_UNCERTAIN',

  // A record that exists and cannot be used is a fact about the record, and the
  // ledger has a reason for exactly that.
  STATE_UNUSABLE: 'STATE_UNUSABLE',

  STEP_BUDGET_EXHAUSTED: 'CONTINUE',

  // Everything left. None of these proves settle, park or abandon, and none of
  // them is improved by trying again inside this invocation:
  //   - the record and the world disagree, or the world could not be read;
  //   - no state was ever persisted for a task this run just started;
  //   - a write was refused, by a conflict or otherwise;
  //   - continuation or execution was not authorised;
  //   - an iteration left the durable state exactly as it found it.
  // Graded one by one rather than by a default arm, because a `default` is how
  // a vocabulary grows a member nobody classified.
  STATE_DIVERGED: 'UNRESOLVED',
  STATE_UNOBSERVABLE: 'UNRESOLVED',
  TASK_NOT_STARTED: 'UNRESOLVED',
  STATE_CONFLICT: 'UNRESOLVED',
  STATE_NOT_RECORDED: 'UNRESOLVED',
  CONTINUATION_NOT_AUTHORISED: 'UNRESOLVED',
  EXECUTION_UNAUTHORISED: 'UNRESOLVED',
  NO_PROGRESS: 'UNRESOLVED',
}) satisfies Record<RunOutcome, TaskConclusion>;

/** What the ledger may be told about a task the driver has just stopped on. */
export function conclusionForRunOutcome(outcome: RunOutcome): TaskConclusion {
  return CONCLUSION_FOR_RUN_OUTCOME[outcome];
}

/* ──────────────── 2. whether a recording attempt landed ──────────────────── */

/** What a `block-progress` call means for the run. A closed set. */
export const RECORDING_RESULTS = ['RECORDED', 'UNRESOLVED', 'STATE_UNUSABLE', 'WRITE_FAILED'] as const;

export type RecordingResult = (typeof RECORDING_RESULTS)[number];

const RECORDING_RESULT_FOR = Object.freeze({
  RECORDED: 'RECORDED',

  // The store could not write. `NOT_RECORDED` is the outcome `block-progress`
  // uses for every save failure that is not a refused proof, so it is the only
  // one that means "the durable write did not happen".
  NOT_RECORDED: 'WRITE_FAILED',

  // A record exists and cannot be used, which has its own stop reason.
  TASK_STATE_UNUSABLE: 'STATE_UNUSABLE',

  // Every remaining refusal is about the *claim*. The run does not retry and
  // does not soften: the task's outcome is not established, and the honest end
  // is a stop that says exactly that.
  //
  // `RUN_ALREADY_STOPPED` is in here rather than in a class of its own on
  // purpose. It is unreachable through the runner — nothing drives a stopped
  // run — so a grade for it is a fail-closed floor, and the floor that says
  // "nothing was recorded" is the safe one.
  TASK_NOT_IN_RUN: 'UNRESOLVED',
  DISPOSITION_UNCHANGED: 'UNRESOLVED',
  ANOTHER_TASK_ACTIVE: 'UNRESOLVED',
  TASK_STATE_DOES_NOT_PROVE_IT: 'UNRESOLVED',
  TASK_NOT_STARTED: 'UNRESOLVED',
  RUN_ALREADY_STOPPED: 'UNRESOLVED',
}) satisfies Record<BlockProgressOutcome, RecordingResult>;

export function recordingResultFor(outcome: BlockProgressOutcome): RecordingResult {
  return RECORDING_RESULT_FOR[outcome];
}

/* ───────────────────────── 3. how a run ends ─────────────────────────────── */

/**
 * The reason a run ends when nothing runnable is left.
 *
 * **Cause beats consequence.** `NO_ELIGIBLE_TASK` became reachable in a new way
 * once a task-local failure stopped ending the run: after A fails and B and C
 * settle, a block with nothing left to run is *finished*, not obstructed. If it
 * became the generic "the loop ended" code, an operator would be told the
 * consequence and never the cause.
 *
 * So the most specific task disposition that explains the ending wins, and
 * `NO_ELIGIBLE_TASK` is reserved for a genuine eligibility dead end that no
 * disposition accounts for — a member whose path to eligibility runs through a
 * non-member, which the frozen relation deliberately does not record.
 *
 * Order matters between the two failures: a human can act on a blocked task and
 * nobody can act on an abandoned one, so the reason names the one with a next
 * step.
 */
export function endReasonFor(entries: readonly BlockTaskEntry[]): BlockStopReason {
  if (entries.every((entry) => entry.disposition === 'SETTLED')) return 'COMPLETE';
  if (entries.some((entry) => entry.disposition === 'BLOCKED')) return 'TASK_BLOCKED';
  if (entries.some((entry) => entry.disposition === 'ABANDONED')) return 'TASK_ABANDONED';
  return 'NO_ELIGIBLE_TASK';
}

/* ─────────────────────── 4. established independence ─────────────────────── */

/**
 * Whether the frozen plan establishes that its members are independent.
 *
 * Read, never derived. The relation was projected once, at freeze time, from
 * the whole normalised DAG and bound into the fingerprint; this function asks
 * it a question and computes nothing.
 *
 * ── Why the answer is about the block and not about a pair ─────────────────
 *
 * It is tempting to ask "may B continue after A?" per pair and keep going with
 * whatever is still unrelated. That is a dependency scheduler, and V2-08 does
 * not get one: as soon as any dependency relation holds between members the
 * block still has to process, the block is **not supported input** for this
 * runner. No improvised ordering, no partial scheduling. Dependent execution —
 * where one task's result commit becomes another's base — is V2-09, and it must
 * earn a claim V2-07 explicitly refused to make.
 *
 * A block that fails this does not fail the *run*: it simply stops at the first
 * task-local failure, exactly as V2-07 does today. That degradation is the
 * correct one, because it is the behaviour that is already proved.
 */
export function independenceIsEstablished(
  dependencies: readonly FrozenTaskDependency[],
): boolean {
  return dependencies.every((row) => row.dependsOn.length === 0);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Prove the maps are enforced, not decorative**

A completeness claim that nothing tests is a claim. Verify it by hand, once:

Temporarily add a member to `RUN_OUTCOMES` in `src/run/run-driver.ts` (for example `'PROBE_ONLY'` after `NO_PROGRESS`) and run `npm run typecheck`.
Expected: FAIL in `src/block/block-conclusion.ts` — `CONCLUSION_FOR_RUN_OUTCOME` no longer satisfies `Record<RunOutcome, TaskConclusion>`.

Remove the probe. Run `npm run typecheck` again.
Expected: clean.

Record the result in the commit message. Do not leave the probe in the tree — and check `git diff` before committing, because a probe left behind is a vocabulary member nothing produces.

- [ ] **Step 6: Commit**

```bash
git add src/block/block-conclusion.ts tests/v2-08-attended-block-runner.test.ts
git commit
```

Message:

```
feat: the block runner's decisions, as pure functions (V2-08)

Four judgements, sited where they can be broken without a repository, a lease
or a subprocess in the way: what a run outcome entitles the ledger to be told,
whether a recording attempt landed, which reason a run ends under, and whether
the frozen plan establishes independence.

Both maps are `satisfies Record<...>` over vocabularies owned elsewhere, so a
new run outcome fails the build here until it is graded - measured by adding a
probe member and watching typecheck fail in this file. That is completeness and
it is all a type can do; the grades are pinned by hand-written tables in the
suite, deliberately not derived from these maps.

Two grades are worth naming. STEP_BUDGET_EXHAUSTED is not an ending of any kind
but an instruction to drive the same task again under the same lease: maxSteps
bounds one runTask call so a driver cannot run away, and it says nothing about
a task's outcome. Graded as an ending it would make a scheduling limit into a
claim about a task, and graded as an ending of the invocation it would need a
block run that outlives the lease that authorised it. And independence is
answered for the whole block rather than per pair, because "these two are
unrelated, run them and skip the rest" is the improvised scheduling this slice
refuses.
```

---

### Task 6B: A start path that cannot read the roadmap

**Files:**
- Modify: `src/run/start-task.ts` (lines 340–392, and the module header)
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Produces: `startPlannedTask(request: PlannedStartRequest, deps: StartTaskDependencies): Promise<StartTaskResult>`; `type PlannedStartRequest = StartTaskRequest & { readonly planning: TaskPlanningSuccess }`.
- Consumes: `TaskPlanningSuccess` from `src/plan/plan-next-task.ts`.

> **Measured premise.** `startTask` calls `planNextTask(repository)` at
> `src/run/start-task.ts:373` and refuses `TASK_INELIGIBLE` from *that* reading
> (line 380). A runner that took its eligibility from a frozen snapshot and then
> started through `startTask` would still be re-reading the roadmap, one layer
> down — see "The second contradiction" above. `planNextTask` has three call
> sites in `src/` outside its own module (`release-workspace.ts:225`,
> `run-driver.ts:938`, `start-task.ts:373`) and only the last is reachable from
> a block run, so this task is the whole of the fix.

This task exists to make the frozen snapshot **true**, not merely asserted. It
adds no capability: the same gates run, in the same order, against a planning
result that was read once instead of once per task.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import { planNextTask, type TaskPlanningSuccess } from '../src/plan/plan-next-task.js';
import { startPlannedTask } from '../src/run/start-task.js';

describe('a start may be authorised by a planning result it did not take', () => {
  it('starts a task the roadmap has since made ineligible', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const frozen = planningOf(fixture);
    // The premise: B-001 is eligible in the frozen reading.
    expect(frozen.selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible).toBe(true);

    // The roadmap moves underneath. A fresh planning now refuses B-001.
    writeRepoFile(fixture.root, 'tasks/GATE-001.md', taskFile('GATE-001'));
    writeRepoFile(fixture.root, 'tasks/B-001.md', taskFile('B-001', { dependsOn: ['GATE-001'] }));
    expect(planningOf(fixture).selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible)
      .toBe(false);

    const started = await startPlannedTask(
      { repository: fixture.repository, taskId: 'B-001', planning: frozen },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: leaseFor(fixture.repository) },
    );

    // The frozen reading is the authority. A path that planned again would
    // answer TASK_INELIGIBLE here, which is exactly the hidden second read.
    expect(started.outcome).toBe('STARTED');
  }, 600_000);

  it('still refuses a task the frozen reading itself calls ineligible', async () => {
    // The other half, and without it the case above passes against a function
    // that skipped the eligibility gate altogether rather than moving it.
    const fixture = await repoWith({ 'A-001': [], 'B-001': ['A-001'] });
    const frozen = planningOf(fixture);
    expect(frozen.selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible).toBe(false);

    const started = await startPlannedTask(
      { repository: fixture.repository, taskId: 'B-001', planning: frozen },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: leaseFor(fixture.repository) },
    );

    expect(started.outcome).toBe('TASK_INELIGIBLE');
  }, 600_000);

  it('prepares the workspace from the frozen definition, not the current file', async () => {
    // The consequence worth stating: the task definition the workspace is built
    // from comes out of the same graph the eligibility answer did. One instant,
    // one plan — a start that gated on the frozen reading and then built from an
    // edited file would be the same split authority in a quieter place.
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const frozen = planningOf(fixture);
    expect(frozen.graph.node('B-001')?.definition).toBeDefined();
  });
});
```

with the snapshot helper the rest of the suite now uses:

```ts
/**
 * One reading of the roadmap, exactly as `block-command.ts` takes it.
 *
 * The whole `TaskPlanningSuccess`, not a list of eligible ids: the runner filters
 * by it *and* hands it to the start path, so a suite that produced two values
 * would be testing a shape production does not have.
 */
function planningOf(fixture: Fixture): TaskPlanningSuccess {
  const planned = planNextTask(fixture.repository);
  if (!planned.ok) throw new Error(`fixture repository does not plan: ${planned.code}`);
  return planned;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — `startPlannedTask` is not exported.

- [ ] **Step 3: Split the start path**

In `src/run/start-task.ts`, factor the body so that the planning read sits in
exactly one of the two entry points. The shape:

```ts
/**
 * Starts one task against a planning result **the caller already took**.
 *
 * Same gates, same order, same refusals as {@link startTask} — the single
 * difference is where the plan came from. It exists because a block run freezes
 * one reading of the roadmap under its lease and every gate below that must
 * consult *that* reading: a start that planned again would answer
 * `TASK_INELIGIBLE` from a roadmap edited after the block was frozen, and the
 * frozen plan would be an assertion rather than an authority.
 *
 * `PLANNING_FAILED` is unreachable here by construction — the caller holds a
 * `TaskPlanningSuccess`, so the planning already succeeded. The outcome stays in
 * the shared vocabulary, which is what keeps `startConclusionFor` total.
 */
export async function startPlannedTask(
  request: PlannedStartRequest,
  deps: StartTaskDependencies,
): Promise<StartTaskResult> {
  const repository = snapshotRepositoryRecord(request.repository);
  const gated = gateStart(repository, request.taskId, deps);
  if (gated !== null) return gated;
  return startAgainstPlan(repository, request.taskId, request.planning, deps);
}

export async function startTask(
  request: StartTaskRequest,
  deps: StartTaskDependencies,
): Promise<StartTaskResult> {
  const repository = snapshotRepositoryRecord(request.repository);
  const gated = gateStart(repository, request.taskId, deps);
  if (gated !== null) return gated;

  const planning = planNextTask(repository);
  if (!planning.ok) {
    return result({ taskId: request.taskId, outcome: 'PLANNING_FAILED', reasonCodes: Object.freeze([planning.code]) });
  }
  return startAgainstPlan(repository, request.taskId, planning, deps);
}
```

Four constraints on the refactor, each of which the existing file already earned
the hard way:

1. **`gateStart` holds steps 0 and 1 unchanged** — the lease proof against the
   file, then `isValidTaskId`. The lease stays *ahead* of the plan read on the
   `startTask` path, so an invocation that is not the writer still hears
   `EXECUTION_LEASE_NOT_HELD` rather than `PLANNING_FAILED`. Moving the plan read
   in front of the gate would be a behaviour change nobody asked for.
2. **`snapshotRepositoryRecord` is taken once per entry point** and the snapshot
   — never `request.repository` — is what flows onward. The comment at line 345
   says why: a record whose `root` is an accessor can name one repository at each
   gate and another at each effect.
3. **`startAgainstPlan` is private and takes the plan as a value.** It must not
   import or call `planNextTask`. It is the whole of the old body from the
   eligibility lookup (line 378) down, including the second lease proof before
   `prepareTaskWorkspace`, which stays exactly where it is.
4. **`startTask` keeps its signature and its behaviour.** Its one existing caller
   (`src/cli/run-command.ts:261`) is not touched by this task, and
   `tests/` must show that.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts tests/v2-05-attended-cli.test.ts tests/run-command.test.ts`
Expected: PASS. The two existing suites are the control on constraint 4: `startTask`'s behaviour is unchanged, so a failure there is a refactor defect and not a new decision.

Run: `npm run test:foundation-safe`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/run/start-task.ts tests/v2-08-attended-block-runner.test.ts
git commit
```

Message:

```
feat: a start path authorised by a planning result it did not take (V2-08)

startTask read the roadmap itself and refused TASK_INELIGIBLE from that reading.
A block run freezes one reading under its lease and starts every member through
this path, so the frozen snapshot would have been overruled by a mid-run edit
one layer below the runner - and the runner's own counter-proof, "does not let a
mid-run roadmap edit change what runs next", would have failed with
RUN_GATE_REFUSED.

startPlannedTask takes the planning result; startTask keeps its signature, reads
the plan once and delegates. Same gates, same order, same refusals - the lease is
still proved before the plan is read and again before the workspace is created.
PLANNING_FAILED becomes unreachable through the new entry point by construction,
and stays in the shared vocabulary so the block runner's grading stays total.

Measured: planNextTask has three call sites in src/ outside its own module and
only this one is reachable from a block run, so this is the whole of the second
read rather than the first of several.
```

---

### Task 7: The runner

**Files:**
- Create: `src/block/block-runner.ts`
- Modify: `src/block/block-conclusion.ts` (one map added)
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6B; `startPlannedTask`/`StartTaskOutcome`; `runTask`/`RunResult`; `verifyExecutionLeaseHeldFor`; `TaskPlanningSuccess` (as a type, never as a call); `reconcileBlockRun`.
- Produces: `BLOCK_RUN_OUTCOMES`; `type BlockRunOutcome`; `interface BlockTaskReport`; `interface AttendedBlockResult`; `interface AttendedBlockRequest`; `interface AttendedBlockDependencies`; `runAttendedBlock(request, deps): Promise<AttendedBlockResult>`; and in `block-conclusion.ts`, `START_CONCLUSIONS` / `startConclusionFor`.

- [ ] **Step 1: Grade the start outcomes**

Append to `src/block/block-conclusion.ts`:

```ts
/* ─────────────────── 5. what a start attempt entitles ────────────────────── */

/** What `startTask`'s answer means for a block run. A closed set. */
export const START_CONCLUSIONS = [
  /** A durable state exists and the task may be driven. */
  'DRIVE',
  /** This run may no longer be the repository's writer. Write nothing. */
  'LEASE_UNCERTAIN',
  /** A state exists and cannot be used. The run ends `STATE_UNUSABLE`. */
  'STATE_UNUSABLE',
  /**
   * A repository, auth or workspace gate refused the start.
   *
   * The run ends **in the report**, not in the ledger, and the entry stays
   * `PLANNED` — which is true: nothing was started for it. None of these
   * refusals is a claim about the task's *outcome*, so none of them may be
   * recorded as one, and `ACTIVE_TASK_UNRESOLVED` would misdescribe a task that
   * was never active.
   */
  'GATE_REFUSED',
] as const;

export type StartConclusion = (typeof START_CONCLUSIONS)[number];

const START_CONCLUSION_FOR = Object.freeze({
  STARTED: 'DRIVE',
  ADOPTED: 'DRIVE',
  ALREADY_STARTED: 'DRIVE',

  EXECUTION_LEASE_NOT_HELD: 'LEASE_UNCERTAIN',
  EXECUTION_LEASE_LOST: 'LEASE_UNCERTAIN',

  STATE_UNUSABLE: 'STATE_UNUSABLE',

  // Gates, listed one by one rather than caught by a default arm. Each is a
  // condition an operator fixes outside this run: a plan that cannot be read, a
  // task that is not eligible, a runtime directory the repository does not
  // ignore, credentials that are not there, a workspace that is occupied, or a
  // first durable write that was refused after the workspace was made.
  //
  // Two of these are graded rather than reached. `PLANNING_FAILED` cannot come
  // back from `startPlannedTask` at all — its caller holds a planning result, so
  // the planning already succeeded — and `TASK_INELIGIBLE` cannot come back for
  // a task this runner chose, because `chooseTask` filters by the same frozen
  // reading the start path gates against. Both stay graded: a vocabulary member
  // left ungraded because "it cannot happen" is how a fail-open arm gets added
  // the day it does.
  TASK_ID_INVALID: 'GATE_REFUSED',
  PLANNING_FAILED: 'GATE_REFUSED',
  TASK_UNKNOWN: 'GATE_REFUSED',
  TASK_INELIGIBLE: 'GATE_REFUSED',
  RUNTIME_NOT_IGNORED: 'GATE_REFUSED',
  RUNTIME_IGNORE_UNDETERMINED: 'GATE_REFUSED',
  AUTH_PREFLIGHT_FAILED: 'GATE_REFUSED',
  WORKSPACE_COLLISION: 'GATE_REFUSED',
  WORKSPACE_REFUSED: 'GATE_REFUSED',
  STATE_NOT_RECORDED: 'GATE_REFUSED',
}) satisfies Record<StartTaskOutcome, StartConclusion>;

export function startConclusionFor(outcome: StartTaskOutcome): StartConclusion {
  return START_CONCLUSION_FOR[outcome];
}
```

with `import type { StartTaskOutcome } from '../run/start-task.js';` added to its imports.

Append the matching hand-written table to the suite, in the shape the two existing ones use — `expect([...START_TASK_OUTCOMES].sort()).toEqual(Object.keys(EXPECTED).sort())` plus one case per row, with `WORKSPACE_COLLISION`, `AUTH_PREFLIGHT_FAILED` and `TASK_INELIGIBLE` graded `GATE_REFUSED`, the two lease outcomes `LEASE_UNCERTAIN`, `STATE_UNUSABLE` itself, and the three start successes `DRIVE`.

- [ ] **Step 2: Write the failing test**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import { runAttendedBlock } from '../src/block/block-runner.js';
import { passingReview } from './fixtures.js';
import { recordedAgent, recordedVerify, reviewResult, writerSuccess } from './helpers/e2e-fixtures.js';

/** Seams that drive a task all the way to `READY_FOR_PR`. */
function drivingSeams() {
  const agent = recordedAgent({
    claude: () => writerSuccess(),
    codex: () => reviewResult(passingReview()),
  });
  const verify = recordedVerify();
  return { agent: agent.runner, verify: verify.runner, agentCalls: agent };
}

/**
 * `planningOf` — added in Task 6B — is the one reading of the roadmap every case
 * below hands to the runner.
 *
 * There is deliberately no second helper producing a list of eligible ids: the
 * runner derives that list from the snapshot itself, so a suite that built one
 * separately would be exercising a shape production does not have.
 */

async function runBlock(
  fixture: Fixture,
  definition = independentBlock(['A-001', 'B-001']),
  overrides: Partial<Parameters<typeof runAttendedBlock>[1]> = {},
) {
  const seams = drivingSeams();
  return runAttendedBlock(
    {
      repository: fixture.repository,
      definition,
      runId: RUN_ID,
      lease: leaseFor(fixture.repository),
      maxStepsPerTask: 8,
      planning: planningOf(fixture),
    },
    {
      now: tickingClock(),
      git: runGitCommand,
      authPreflight: authPreflightPasses,
      agent: seams.agent,
      verify: seams.verify,
      ...overrides,
    },
  );
}

describe('the attended block runner', () => {
  it('runs a block of independent tasks to the end under one lease', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    const result = await runBlock(fixture);

    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('COMPLETE');
    const after = onDisk(fixture.root);
    expect((after['tasks'] as readonly Record<string, unknown>[]).map((t) => t['disposition']))
      .toEqual(['SETTLED', 'SETTLED']);
    expect(after['stopReason']).toBe('COMPLETE');
  }, 600_000);

  // Design §8.1 — the control that fails against V2-07's policy, driven through
  // the runner rather than through the primitives.
  it('does not stop when one task fails locally', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    const definition = independentBlock(['A-001', 'B-001', 'C-001']);
    const seams = drivingSeams();
    // A-001's writer refuses for scope, which is blocking and carries no resume
    // point. B-001 and C-001 are driven normally.
    const agent = recordedAgent({
      claude: (call) => (call.cwd.includes('A-001') ? scopeViolatingWriter() : writerSuccess()),
      codex: () => reviewResult(passingReview()),
    });

    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition,
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: seams.verify,
      },
    );

    const after = onDisk(fixture.root);
    const dispositions = (after['tasks'] as readonly Record<string, unknown>[]).map(
      (task) => task['disposition'],
    );
    // Design §8.4: asserted on the persisted ledger, not on an in-memory value.
    expect(dispositions).toEqual(['BLOCKED', 'SETTLED', 'SETTLED']);
    expect(after['stopReason']).not.toBe('COMPLETE');
    // Design §8.3c: the end reason names the cause.
    expect(after['stopReason']).toBe('TASK_BLOCKED');
    expect(result.stopReason).toBe('TASK_BLOCKED');
  }, 900_000);

  // Design §8.5.
  it('stops at the first local failure when independence is not established', async () => {
    const fixture = await repoWith({ 'A-001': [], 'X-001': ['A-001'], 'B-001': ['X-001'] });
    // One reading, projected from and run against — exactly as the CLI does it.
    const frozen = planningOf(fixture);
    const projected = projectBlockDependencies(frozen.graph, ['A-001', 'B-001']);
    if (!projected.ok) throw new Error('fixture projection failed');
    const defined = defineBlock(BLOCK_ID, ['A-001', 'B-001'], projected.dependencies);
    if (!defined.ok) throw new Error('fixture block is not a block');
    // The premise: the projection saw the dependency through the non-member.
    expect(defined.definition.dependencies[1]?.dependsOn).toEqual(['A-001']);

    const agent = recordedAgent({
      claude: () => scopeViolatingWriter(),
      codex: () => reviewResult(passingReview()),
    });
    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: defined.definition,
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: frozen,
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: recordedVerify().runner,
      },
    );

    expect(result.stopReason).toBe('TASK_BLOCKED');
    const dispositions = (onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[]).map(
      (task) => task['disposition'],
    );
    // B-001 was never touched. Without established independence the run stops
    // at the first local failure, exactly as V2-07 does.
    expect(dispositions).toEqual(['BLOCKED', 'PLANNED']);
  }, 600_000);

  // Design §8.6, measured by effect rather than by reading the code.
  it('holds one lease for the whole run, not one per task', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const attempts: string[] = [];
    const agent = recordedAgent({
      claude: () => {
        // A second acquirer, inside the drive of *each* task. A per-task lease
        // would leave a window between tasks; this measures the answer during
        // both of them.
        const second = acquireRepositoryExecutionLease(
          fixture.repository,
          { runId: 'run-0002', blockId: BLOCK_ID },
          { now: () => new Date().toISOString() },
        );
        attempts.push(second.ok ? 'ACQUIRED' : second.code);
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });

    await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: recordedVerify().runner,
      },
    );

    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts)).toEqual(new Set(['LEASE_HELD']));
  }, 600_000);
});
```

Add the helper this suite now needs. The graph a projection is taken from comes
out of `planningOf(fixture).graph` — the same reading the run is handed — rather
than from a second helper of its own, because two readings in one case is the
defect the case is about:

```ts
import { acquireRepositoryExecutionLease } from '../src/lease/execution-lease.js';
import { agentCommandResult } from './fixtures.js';

/**
 * A writer that reports success while having written outside its scope.
 *
 * Produces a real `SCOPE_VIOLATION`, through the real scope check, rather than
 * a state file edited into place: the task-local failure this suite is about
 * has to be one the product itself produced.
 */
function scopeViolatingWriter() {
  return (call: { readonly cwd: string }) => {
    writeRepoFile(call.cwd, 'outside-scope.txt', 'written where the profile does not allow');
    return writerSuccess();
  };
}
```

> **A note for whoever writes these fixtures.** `scopeViolatingWriter` above is
> a *sketch* — check `src/scope` and `tests/v2-06-scope-enforcement.test.ts` for
> the shape the enforcement actually reacts to, and use whichever real
> mechanism that suite already drives. What must not happen is a fixture that
> writes `state: 'SCOPE_VIOLATION'` into the task state directly: the control is
> "the run survives a task the *product* failed", and a hand-written state would
> prove only that the runner reads a file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — cannot resolve `../src/block/block-runner.js`.

- [ ] **Step 4: Write the runner**

Create `src/block/block-runner.ts`:

```ts
/**
 * The attended block run: something that actually runs a block.
 *
 * ── What this module is, and what it deliberately is not ───────────────────
 *
 * It composes primitives that already exist and invents no orchestration truth
 * of its own. The lease makes this invocation the repository's writer; `startTask`
 * prepares a workspace; `runTask` drives one task; `block-progress.ts` records
 * each outcome against the task's own durable record and refuses anything the
 * record does not prove. This module decides *sequence*, and `block-conclusion.ts`
 * decides *meaning*. Nothing here writes the ledger directly.
 *
 * ── Two exits, and why one of them writes nothing ──────────────────────────
 *
 * A run distinguishes two classes of bad news:
 *
 *   class 1  a task failed          one task's own outcome, recorded with its
 *                                   evidence; the run continues with tasks
 *                                   already known to be independent
 *   class 2  the run cannot safely  the whole block stops immediately
 *            continue
 *
 * Class 2 then splits again, by **representability**. A ledger `stopReason` is
 * itself a durable claim, so a condition whose content is *this run can no
 * longer make durable claims* must not be expressed as one:
 *
 *   recordable    OPERATOR_STOPPED, LEDGER_DIVERGED, STATE_UNUSABLE,
 *                 DEFINITION_DRIFTED, ACTIVE_TASK_UNRESOLVED
 *                 -> `stopBlockRun`, and the ledger carries the ending
 *
 *   unrecordable  LEASE_AUTHORITY_UNCERTAIN — the run may no longer be the
 *                 writer, so any further mutation is exactly the act it has
 *                 lost the authority for;
 *                 DURABLE_WRITE_FAILED — the run cannot presuppose a successful
 *                 stop write, because the failed write is the condition;
 *                 RUN_GATE_REFUSED — a repository, auth or runtime gate refused,
 *                 which is a run abort and not task progress;
 *                 RECONCILIATION_UNRESOLVED — a forced reconciliation was no
 *                 longer forced when the primitive checked it
 *                 -> the ledger is left on its last provably durable state and
 *                 the truth reaches the operator through the report
 *
 * A runner that funnelled both through `stopBlockRun` would, in exactly the
 * cases where writing is what it cannot do, either fail loudly at the worst
 * moment or emit a claim it had no authority to make.
 *
 * "Left on its last provably durable state" is the exact claim, and it is
 * weaker than "nothing was written" on purpose. Every one of the four can strike
 * after this run has already recorded settlements — those are true and they
 * stay. What is missing from the ledger is only the ending. Two of them can
 * additionally strike before any ledger exists, which is a fact about where the
 * condition arose and not about what the outcome means.
 *
 * ── Attended only, and one task at a time ──────────────────────────────────
 *
 * Unattended running needs *owned process containment* — a Job Object, a
 * supervised process group — rather than merely the lease, and automatic
 * recovery of a stale lease stays refused until the orchestrator creates that
 * containment itself. Staying attended is what keeps that surface closed, and
 * it is the single most important scope line in this slice.
 *
 * The ledger enforces one `ACTIVE` task and this runner is sequential. "Several
 * independent tasks" is about surviving a sibling's failure, never about
 * concurrency.
 *
 * ── What this module may not compute ───────────────────────────────────────
 *
 * The dependency relation. It is projected once, at freeze time, by
 * `block-dependencies.ts` — which this module does not import, and must not. A
 * runner that re-derived the relation would answer "may B continue after A?"
 * from a roadmap an operator can edit while the run is in flight, which is the
 * opposite of frozen-plan authority. It reads `ledger.frozenDependencies` and
 * asks `independenceIsEstablished` a question.
 *
 * The plan, either. This module never calls `planNextTask`; it receives the
 * caller's single reading as {@link AttendedBlockRequest.planning} and both
 * filters by it and hands it to `startPlannedTask`, so there is no gate below
 * here that could consult a second reading. Forbidding the import is not enough
 * on its own — the reason `startPlannedTask` exists is that `startTask` planned
 * again on its own account, which put a mid-run roadmap edit back in charge of
 * what runs while every module in `src/block/` looked innocent.
 *
 * One consequence, stated rather than left to be discovered: **a mid-run edit is
 * invisible to this invocation, in both directions.** It cannot stop a member
 * that was eligible when the operator asked, and it cannot make one runnable
 * that was not. There is no drift check between tasks, and none when the run
 * opens either: the ledger is created from the plan the caller just froze, so
 * there is nothing to compare it against. That is the cost of the rule above and
 * it is recorded in the follow-up register as F-B1.
 */

import type { AgentRunner } from '../agent/agent-command.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import { verifyExecutionLeaseHeldFor } from '../lease/execution-lease.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import type { TaskPlanningSuccess } from '../plan/plan-next-task.js';
import { runTask, type RunOutcome, type RunResult } from '../run/run-driver.js';
import { startPlannedTask } from '../run/start-task.js';
import type { ReplaceFn, TempSuffixFn } from '../state/atomic-file.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import type { GitRunner } from '../worktree/git-command.js';
import {
  conclusionForRunOutcome,
  endReasonFor,
  independenceIsEstablished,
  recordingResultFor,
  startConclusionFor,
} from './block-conclusion.js';
import type { BlockDefinition } from './block-definition.js';
import {
  entryFor,
  type BlockRunLedger,
  type BlockStopReason,
  type TaskDisposition,
} from './block-ledger.js';
import {
  abandonBlockTask,
  activateBlockTask,
  parkBlockTask,
  settleBlockTask,
  startBlockRun,
  stopBlockRun,
  type BlockProgressOptions,
  type BlockProgressResult,
} from './block-progress.js';
import { loadBlockLedger, type LedgerLoadSuccess } from './block-store.js';
import { reconcileBlockRun } from './reconcile-block.js';

/**
 * How an attended block run ended. A closed set.
 *
 * One outcome is recorded in the ledger and four are not. **"Not recorded" is
 * not "nothing was written":** every one of the four is reachable after tasks
 * have already been settled, parked or abandoned in this run, and those records
 * are true and stay. What none of the four does is add a stop claim — the ledger
 * is left at its last provably durable state, byte for byte across the
 * condition, and the ending reaches the operator through the report instead.
 */
export const BLOCK_RUN_OUTCOMES = [
  /** The ledger carries the ending. {@link AttendedBlockResult.stopReason} says which. */
  'BLOCK_RUN_ENDED',
  /**
   * This run may no longer be the repository's writer.
   *
   * Not recorded: any further mutation is precisely the act the run has lost the
   * authority for. Whatever it recorded while it *was* the writer stands.
   */
  'LEASE_AUTHORITY_UNCERTAIN',
  /**
   * A durable write was not possible.
   *
   * Not recorded, and it could not be: the failed write is the condition. The
   * ledger is whatever last landed — possibly nothing at all, if the failure
   * struck the creation.
   */
  'DURABLE_WRITE_FAILED',
  /**
   * A repository, auth or runtime gate refused.
   *
   * Not recorded, because a gate refusal is a run abort and not task progress —
   * and not a claim about the outcome of the task it refused to start, which
   * stays `PLANNED`. Reachable both before the ledger exists (the auth preflight,
   * ahead of `openRun`) and after it (a workspace, runtime or auth gate met
   * between two tasks), so it says nothing about how much this run wrote — only
   * that the refusal itself was not written down as an ending.
   */
  'RUN_GATE_REFUSED',
  /**
   * A reconciliation that was forced when it was read was not forced when it was
   * applied.
   *
   * The evidence moved between the reconciliation read and the authoritative
   * primitive's own check: the primitive refused the claim the reconciliation had
   * established. Nothing is repaired and nothing is retried — a second read and a
   * second decision is how a refusal gets laundered.
   *
   * Its own outcome rather than `DURABLE_WRITE_FAILED`, which would tell an
   * operator to go and fix a disk that is working, and rather than
   * `ACTIVE_TASK_UNRESOLVED`, which is a persisted claim about an `ACTIVE` task
   * while forced reconciliation only ever touches `PLANNED` ones. Not persisted,
   * so it needs no ledger schema change.
   */
  'RECONCILIATION_UNRESOLVED',
] as const;

export type BlockRunOutcome = (typeof BLOCK_RUN_OUTCOMES)[number];

export interface BlockTaskReport {
  readonly taskId: string;
  /** As persisted when the run ended. */
  readonly disposition: TaskDisposition;
  /** The driver's answer for this task, or `null` if it was never driven. */
  readonly runOutcome: RunOutcome | null;
}

export interface AttendedBlockResult {
  readonly outcome: BlockRunOutcome;
  /** The reason recorded in the ledger, or `null` when none was written. */
  readonly stopReason: BlockStopReason | null;
  /**
   * The gate, save or load code behind the outcome.
   *
   * An allow-listed code from another module's closed vocabulary. Never a
   * message, never a path.
   */
  readonly detail: string | null;
  readonly runId: string;
  readonly blockId: string;
  readonly tasks: readonly BlockTaskReport[];
  /** Durable task steps this invocation landed, across every task. */
  readonly steps: number;
}

export interface AttendedBlockRequest {
  readonly repository: ResolvedRepository;
  /**
   * The plan, **already frozen**. This module never projects one.
   *
   * Frozen by the caller from {@link planning}, under the same lease, before the
   * run opened. It is not compared against anything here: there is no resume, so
   * there is no persisted predecessor a fingerprint could differ from.
   */
  readonly definition: BlockDefinition;
  /** Identity of this run. A previous run's record is never overwritten. */
  readonly runId: string;
  /**
   * Proof that this invocation holds the repository's execution lease.
   *
   * Required and never nullable, for the reason `RunRequest.lease` states: a
   * run that is not the repository's writer must not drive a task at all, so
   * "no lease" is not a weaker mode of running. Taken by the caller and held
   * across the whole block — never per task, which would leave a window between
   * tasks that an execution lease exists to close.
   */
  readonly lease: ExecutionLeaseEvidence;
  /**
   * The bound on durable steps per **one `runTask` call**, forwarded as-is.
   *
   * Not a bound on the task and not a bound on the run. Reaching it means the
   * driver stopped after durable progress, and the runner drives the same task
   * again under the same lease — see `TASK_CONCLUSIONS`' `CONTINUE`.
   */
  readonly maxStepsPerTask: number;
  /**
   * The caller's **one** reading of the roadmap, taken under the lease.
   *
   * The whole `TaskPlanningSuccess`, not a list of eligible ids. Two things come
   * out of it and they must come out of the same object: the set this runner
   * filters candidates by, and the authority `startPlannedTask` gates each start
   * against. A list handed in beside a plan read somewhere else is two readings
   * that can disagree, and the disagreement would surface as `TASK_INELIGIBLE`
   * for a task this run had already chosen.
   *
   * Handed in rather than computed, which is what makes "the runner does not
   * re-read the plan" structural instead of disciplinary: this module imports no
   * planner, and the start path it uses cannot take a reading of its own. The
   * caller projects the frozen relation from this same result, so plan,
   * relation, eligibility and every start gate are one snapshot at one instant.
   *
   * A caller cannot widen it in any useful way either. Eligibility is read from
   * `planning.selection.eligibility` here and again inside `startPlannedTask`,
   * and the workspace is prepared from `planning.graph`'s definition — so a
   * forged snapshot is not a task started against the repository's plan, it is a
   * task started against a plan the caller wrote, which the lease and the
   * repository's own files still bound.
   */
  readonly planning: TaskPlanningSuccess;
}

export interface AttendedBlockDependencies {
  readonly now: () => string;
  readonly git: GitRunner;
  /**
   * The auth preflight, run at most once per invocation by the caller's
   * memoising seam. Returning `null` is a gate refusal for the whole run.
   */
  readonly authPreflight: () => Promise<AuthPreflightEvidence | null>;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
  /**
   * Write seams for the **ledger**, kept apart from the task-state ones below.
   *
   * Deliberately two pairs rather than one. A single pair would make a test of
   * `DURABLE_WRITE_FAILED` unable to fail the ledger write without also failing
   * every task-state write, so the case would prove that a broken disk breaks
   * everything rather than that a failed ledger write is reported honestly.
   * Neither seam can make a write *succeed* that would not have.
   */
  readonly ledgerReplace?: ReplaceFn;
  readonly ledgerTempSuffix?: TempSuffixFn;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

/* ─────────────────────────── the run ────────────────────────────────────── */

export async function runAttendedBlock(
  request: AttendedBlockRequest,
  deps: AttendedBlockDependencies,
): Promise<AttendedBlockResult> {
  const { repository, definition, runId } = request;
  const ledgerOptions: BlockProgressOptions = {
    repositoryRoot: repository.root,
    ...(deps.ledgerReplace !== undefined ? { replace: deps.ledgerReplace } : {}),
    ...(deps.ledgerTempSuffix !== undefined ? { tempSuffix: deps.ledgerTempSuffix } : {}),
  };

  const state = new RunState(runId, definition.blockId);

  // The gates, before anything durable. Auth is a statement about the machine
  // and the lease is a statement about who may write; neither implies the other
  // and neither is a task outcome, so both refuse through the report.
  const evidence = await deps.authPreflight();
  if (evidence === null) return state.gateRefused('AUTH_PREFLIGHT_FAILED');

  const opened = openRun(request, deps.now, ledgerOptions);
  if (opened.kind !== 'OPEN') return state.from(opened);

  let current = opened.ledger;
  state.seen(current.ledger);

  // The eligibility snapshot, derived from the caller's one reading and not
  // re-read here — nor taken as a second argument that could disagree with it.
  const eligible = new Set(
    request.planning.selection.eligibility
      .filter((entry) => entry.eligible)
      .map((entry) => entry.taskId),
  );

  for (;;) {
    // The lease, re-proved every iteration rather than trusted once. A step is
    // a subprocess that took minutes, and a lease taken before it is not a
    // lease held after it.
    const held = verifyExecutionLeaseHeldFor(repository, request.lease);
    if (held.code !== 'HELD') return state.leaseUncertain(held.code);

    // The ledger against the records, every iteration. This is what stops a run
    // adding a well-proved step to a record that is already unsupported.
    const checked = checkRecords(current.ledger, repository.root);
    if (checked !== null) return state.stop(current, checked, ledgerOptions);

    // Progress the ledger has not caught up with, applied only where it is
    // forced — see `applyForcedProgress`.
    const reconciled = applyForcedProgress(current, repository.root, ledgerOptions);
    if (reconciled.kind !== 'OPEN') return state.from(reconciled);
    current = reconciled.ledger;
    state.seen(current.ledger);

    const next = chooseTask(current.ledger, eligible);
    if (next.kind === 'NONE') {
      return state.stop(current, endReasonFor(current.ledger.tasks), ledgerOptions);
    }

    const driven = await driveOneTask(next.taskId, current, request, deps, ledgerOptions, evidence);
    // Recorded before the exit is taken, so a run that ends on this task still
    // reports what the driver said about it and what it cost.
    state.record(next.taskId, driven.runOutcome, driven.steps);
    if (driven.step.kind !== 'OPEN') return state.from(driven.step);
    current = driven.step.ledger;
    state.seen(current.ledger);

    // A task-local failure ends the task, not the run — but only where the
    // frozen plan says the rest are independent. Read, never derived.
    const entry = entryFor(current.ledger, next.taskId);
    const failedLocally = entry?.disposition === 'BLOCKED' || entry?.disposition === 'ABANDONED';
    if (failedLocally && !independenceIsEstablished(current.ledger.frozenDependencies)) {
      // The V2-07 behaviour, which is proved. Not an improvised ordering.
      return state.stop(current, endReasonFor(current.ledger.tasks), ledgerOptions);
    }
  }
}
```

Then, in the same file, the vocabulary of a step and the helpers the loop names:

```ts
/* ────────────────────── the small vocabulary of a step ───────────────────── */

/**
 * Either the run is still open on a ledger, or it is over and this is how.
 *
 * `STOPPED` and `ENDED` are two kinds rather than one because they differ in
 * exactly the thing an operator needs: a stop landed in the ledger and carries
 * the reason it recorded, while an end happened in the report and carries the
 * code that caused it. A single kind would let a helper end a run without
 * naming why, which is the one thing this vocabulary exists to prevent.
 */
type RunStep =
  | { readonly kind: 'OPEN'; readonly ledger: LedgerLoadSuccess }
  | {
      readonly kind: 'STOPPED';
      readonly reason: BlockStopReason;
      /** The ledger as written, so the report reads dispositions from it. */
      readonly ledger: BlockRunLedger | null;
    }
  | {
      readonly kind: 'ENDED';
      readonly outcome: BlockRunOutcome;
      readonly detail: string | null;
    };

/** The two kinds that mean the run is over, however it got there. */
type FinishedStep = Extract<RunStep, { kind: 'STOPPED' } | { kind: 'ENDED' }>;

interface DrivenStep {
  readonly step: RunStep;
  /** The driver's answer, when it got as far as driving. */
  readonly runOutcome: RunOutcome | null;
  readonly steps: number;
}

type TaskChoice =
  | { readonly kind: 'TASK'; readonly taskId: string }
  | { readonly kind: 'NONE' };

const ended = (outcome: BlockRunOutcome, detail: string | null): FinishedStep =>
  Object.freeze({ kind: 'ENDED' as const, outcome, detail });

/** The store's code behind a refused progress call, or `null`. */
function saveDetail(progress: BlockProgressResult): string | null {
  if (progress.save === null || progress.save.ok) return null;
  return progress.save.detail === null ? progress.save.code : `${progress.save.code}:${progress.save.detail}`;
}

/* ────────────────────────── what the run accumulates ─────────────────────── */

/**
 * What this invocation has seen, and how it renders an ending.
 *
 * Deliberately not a place where anything is decided: it holds the last ledger
 * it was shown and the driver's answer per task, so that every exit produces the
 * same report shape. The dispositions come from the ledger rather than from
 * anything remembered here — the persisted record is the answer, and a report
 * built from a runner's memory could disagree with it.
 */
class RunState {
  private readonly runOutcomes = new Map<string, RunOutcome>();
  private ledger: BlockRunLedger | null = null;
  private stepsTaken = 0;

  constructor(
    private readonly runId: string,
    private readonly blockId: string,
  ) {}

  seen(ledger: BlockRunLedger): void {
    this.ledger = ledger;
  }

  record(taskId: string, outcome: RunOutcome | null, steps: number): void {
    if (outcome !== null) this.runOutcomes.set(taskId, outcome);
    this.stepsTaken += steps;
  }

  private result(
    outcome: BlockRunOutcome,
    stopReason: BlockStopReason | null,
    detail: string | null,
  ): AttendedBlockResult {
    return Object.freeze({
      outcome,
      stopReason,
      detail,
      runId: this.runId,
      blockId: this.blockId,
      steps: this.stepsTaken,
      tasks: Object.freeze(
        (this.ledger?.tasks ?? []).map((entry) =>
          Object.freeze({
            taskId: entry.taskId,
            disposition: entry.disposition,
            runOutcome: this.runOutcomes.get(entry.taskId) ?? null,
          }),
        ),
      ),
    });
  }

  gateRefused(detail: string | null): AttendedBlockResult {
    return this.result('RUN_GATE_REFUSED', null, detail);
  }

  leaseUncertain(detail: string): AttendedBlockResult {
    return this.result('LEASE_AUTHORITY_UNCERTAIN', null, detail);
  }

  writeFailed(detail: string | null): AttendedBlockResult {
    return this.result('DURABLE_WRITE_FAILED', null, detail);
  }

  /** A finished step, rendered. Never called with an open or drifted one. */
  from(step: FinishedStep): AttendedBlockResult {
    if (step.kind === 'STOPPED') {
      if (step.ledger !== null) this.seen(step.ledger);
      return this.result('BLOCK_RUN_ENDED', step.reason, null);
    }
    return this.result(step.outcome, null, step.detail);
  }

  /**
   * Writes the ending, and grades the write.
   *
   * The only path in this module that writes a stop reason. A stop write that
   * did not land is not an ending: reporting `BLOCK_RUN_ENDED` for it would be
   * the run claiming an ending it failed to record.
   */
  stop(
    current: LedgerLoadSuccess,
    reason: BlockStopReason,
    options: BlockProgressOptions,
  ): AttendedBlockResult {
    const stopped = stopBlockRun(current, reason, options);
    if (stopped.outcome !== 'RECORDED') {
      return this.writeFailed(saveDetail(stopped) ?? stopped.outcome);
    }
    if (stopped.ledger !== null) this.seen(stopped.ledger);
    return this.result('BLOCK_RUN_ENDED', reason, null);
  }
}

/* ─────────────────────────────── opening ─────────────────────────────────── */

/**
 * Creates the ledger of this run. There is **no resume**.
 *
 * A block run's lifetime is its invocation's lifetime, because the lease
 * guarantee is stated over a whole block run: an open run that outlived the
 * process holding its lease would be a durable run with no holder, and the only
 * ways to avoid that are to leave a lease behind — the stale-lease surface this
 * slice may not reopen — or to let a later invocation adopt a run it never
 * started.
 *
 * So `startBlockRun`'s existing refusal *is* the answer: a run id that already
 * has a ledger belongs to an invocation that is over, whether it stopped
 * cleanly or was interrupted, and that record is not overwritten. An operator
 * continues by starting a new run id.
 *
 * One consequence, stated because it removes a reason from this runner's reach:
 * `DEFINITION_DRIFTED` has no producer here. Drift compares a frozen plan with a
 * current one, and inside a single invocation the ledger is created from the
 * plan the caller just froze. `reconcileBlockRun` still reports it to a caller
 * that supplies a definition.
 */
function openRun(
  request: AttendedBlockRequest,
  now: () => string,
  options: BlockProgressOptions,
): RunStep {
  const { repository, definition, runId } = request;

  const created = startBlockRun(
    {
      definition,
      repositoryId: repository.id,
      repositoryRoot: repository.root,
      runId,
      now: now(),
    },
    options,
  );
  if (!created.ok) {
    const detail = created.detail === null ? created.code : `${created.code}:${created.detail}`;
    // A write that could not be made is the condition `DURABLE_WRITE_FAILED`
    // names, and there is no ledger to record it in.
    if (created.code === 'WRITE_FAILED' || created.code === 'DIRECTORY_CREATE_FAILED') {
      return ended('DURABLE_WRITE_FAILED', detail);
    }
    // Everything else is a gate: this run id already has a record, or the
    // document does not name this checkout. Reported under the run id's own
    // token, because "that id is taken" is what the operator has to act on.
    return ended(
      'RUN_GATE_REFUSED',
      created.code === 'LEDGER_CONFLICT' ? 'RUN_ID_ALREADY_USED' : detail,
    );
  }

  const reloaded = loadBlockLedger(repository.root, runId);
  if (!reloaded.ok) return ended('RUN_GATE_REFUSED', reloaded.code);
  return Object.freeze({ kind: 'OPEN' as const, ledger: reloaded });
}

/* ───────────────────────── the records, every iteration ──────────────────── */

/**
 * The stop reason the task records force, or `null` when they support the
 * ledger.
 *
 * `STATE_UNUSABLE` beats `LEDGER_DIVERGED` where both apply. "A record cannot be
 * read" is a more specific fact than "the ledger and the records disagree", and
 * the two send an operator to different places — which is the same
 * cause-beats-consequence rule the end reason follows.
 */
function checkRecords(ledger: BlockRunLedger, repositoryRoot: string): BlockStopReason | null {
  const reconciliation = reconcileBlockRun(ledger, { repositoryRoot });
  if (reconciliation.verdict !== 'DIVERGED') return null;
  return reconciliation.findings.some((entry) => entry.finding === 'TASK_STATE_UNUSABLE')
    ? 'STATE_UNUSABLE'
    : 'LEDGER_DIVERGED';
}

/* ──────────────────────── forced positive reconciliation ─────────────────── */

/**
 * Records progress the ledger has not caught up with — and only where it is
 * forced.
 *
 * Permitted for a **`PLANNED`** entry whose own record has reached
 * `READY_FOR_PR`, and nothing else. All six conditions hold there: the change is
 * determined by durable evidence that already exists, there is exactly one
 * admissible successor, it is monotone, it invents no evidence, the ordinary
 * primitive accepts it on its existing proofs, and applying it twice changes
 * nothing (`settleBlockTask` answers `DISPOSITION_UNCHANGED` the second time).
 *
 * An `ACTIVE` entry is deliberately excluded even when its record says
 * `READY_FOR_PR`. That task is this run's own business, and choosing between
 * "drive it" and "declare it finished" is a *choice* — the moment the six
 * conditions stop holding. It is driven instead, and the driver's answer decides.
 *
 * Applied through `settleBlockTask` rather than by writing the ledger. A repair
 * path that bypassed the primitive would be a second, weaker way to assert
 * progress: the one thing the ledger exists to prevent.
 */
function applyForcedProgress(
  current: LedgerLoadSuccess,
  repositoryRoot: string,
  options: BlockProgressOptions,
): RunStep {
  let ledger = current;

  for (;;) {
    const reconciliation = reconcileBlockRun(ledger.ledger, { repositoryRoot });
    if (!reconciliation.progressAvailable) {
      return Object.freeze({ kind: 'OPEN' as const, ledger });
    }

    const forced = reconciliation.findings.find(
      (finding) =>
        finding.finding === 'TASK_AHEAD_OF_LEDGER' &&
        entryFor(ledger.ledger, finding.taskId)?.disposition === 'PLANNED',
    );
    if (forced === undefined) return Object.freeze({ kind: 'OPEN' as const, ledger });

    const settled = settleBlockTask(ledger, forced.taskId, options);
    const graded = recordingResultFor(settled.outcome);
    // Four grades, four endings. Collapsing the last three into one would report
    // a proof race as a broken disk, which is the misdescription class this
    // whole slice is organised against — an operator told DURABLE_WRITE_FAILED
    // goes to look at permissions, and there is nothing wrong with the disk.
    if (graded === 'WRITE_FAILED') return ended('DURABLE_WRITE_FAILED', saveDetail(settled));
    // A record that exists and cannot be used is a fact about the record, and
    // the ledger has a persisted reason for exactly that.
    if (graded === 'STATE_UNUSABLE') return stopStep(ledger, 'STATE_UNUSABLE', options);
    if (graded !== 'RECORDED') {
      // The reconciliation was forced when it was read and the authoritative
      // primitive did not confirm it at the commit: the evidence moved between
      // the two reads. Do not repair, and do not try again — a second read and a
      // second decision is how a refusal gets laundered.
      //
      // Reported rather than recorded, and under its own name.
      // `ACTIVE_TASK_UNRESOLVED` would be wrong twice over: this entry is
      // `PLANNED`, never `ACTIVE` — `applyForcedProgress` refuses `ACTIVE`
      // entries by construction — and it is a persisted claim, which is the one
      // thing a run whose evidence just moved under it should not be making.
      return ended('RECONCILIATION_UNRESOLVED', settled.outcome);
    }

    const reloaded = loadBlockLedger(repositoryRoot, ledger.ledger.runId);
    if (!reloaded.ok) return ended('RUN_GATE_REFUSED', reloaded.code);
    ledger = reloaded;
  }
}

/* ───────────────────────────── choosing a task ───────────────────────────── */

/**
 * The next task to drive, or that there is not one.
 *
 * The candidates are the `PLANNED` members, in frozen order, filtered by the
 * **snapshot** of the repository's own eligibility report that the caller took
 * before the run. Two properties, and both are deliberate:
 *
 * The filter is not answered from `frozenDependencies`. A member with no frozen
 * block-member dependency may still be waiting on a non-member, and a runner
 * reading "no frozen edge" as "eligible" would start a task the repository says
 * cannot run. The frozen relation answers independence; the planner answers
 * eligibility; folding either into the other loses one of the two.
 *
 * And it is a snapshot rather than a fresh reading. This module imports no
 * planner, and the task it picks is started through `startPlannedTask`, which
 * gates against the very same reading — so there is no moment at which an edited
 * roadmap could change which task runs next, in this function or below it. The
 * invocation acts on the plan as it was when the operator asked for it, which is
 * the same instant the relation was frozen at and the lease was taken.
 *
 * There is no `ACTIVE` arm, and there cannot be one: a task becomes `ACTIVE`
 * only when this loop activates it, and it is concluded before the next
 * iteration. An `ACTIVE` entry at the top of an iteration would mean a resumed
 * run, which this runner does not have.
 */
function chooseTask(ledger: BlockRunLedger, eligible: ReadonlySet<string>): TaskChoice {
  for (const entry of ledger.tasks) {
    if (entry.disposition !== 'PLANNED') continue;
    if (!eligible.has(entry.taskId)) continue;
    return Object.freeze({ kind: 'TASK' as const, taskId: entry.taskId });
  }

  return Object.freeze({ kind: 'NONE' as const });
}

/* ───────────────────────────── driving one task ──────────────────────────── */

/**
 * Starts the task if it needs starting, drives it, and records what its own
 * record proves.
 *
 * The order `startTask` → `activateBlockTask` → `runTask` → settle/park/abandon
 * is forced rather than chosen: activation copies the task state's own base pin
 * into the entry, so a durable state has to exist before the ledger can say the
 * run is working on it.
 *
 * Every recording attempt is graded through `recordingResultFor`, and the three
 * non-`RECORDED` grades are three different endings — a failed write is
 * reported, an unusable record and an unestablished outcome are recorded.
 */
async function driveOneTask(
  taskId: string,
  current: LedgerLoadSuccess,
  request: AttendedBlockRequest,
  deps: AttendedBlockDependencies,
  options: BlockProgressOptions,
  evidence: AuthPreflightEvidence,
): Promise<DrivenStep> {
  const { repository, lease, maxStepsPerTask } = request;
  const nothing = (step: RunStep): DrivenStep => ({ step, runOutcome: null, steps: 0 });

  // `startPlannedTask`, never `startTask`: the gates below this line are
  // answered from the reading the block was frozen against. A start that planned
  // again would refuse `TASK_INELIGIBLE` for a task this run legitimately chose,
  // and a roadmap edited mid-run would be back in charge of what runs.
  const start = await startPlannedTask(
    { repository, taskId, planning: request.planning },
    { git: deps.git, now: deps.now, authPreflight: deps.authPreflight, lease },
  );
  const startConclusion = startConclusionFor(start.outcome);
  if (startConclusion === 'LEASE_UNCERTAIN') {
    return nothing(ended('LEASE_AUTHORITY_UNCERTAIN', start.outcome));
  }
  if (startConclusion === 'STATE_UNUSABLE') {
    return nothing(stopStep(current, 'STATE_UNUSABLE', options));
  }
  if (startConclusion === 'GATE_REFUSED') {
    return nothing(ended('RUN_GATE_REFUSED', start.outcome));
  }

  // Activation. The guard is a fail-closed floor rather than a branch that runs:
  // `chooseTask` only ever returns a `PLANNED` entry, and a `PLANNED` entry is
  // never the active one. There is no resume, so there is no path on which this
  // run finds its own task already `ACTIVE`.
  let ledger = current;
  if (ledger.ledger.activeTaskId !== taskId) {
    const activated = activateBlockTask(ledger, taskId, options);
    const graded = recordingResultFor(activated.outcome);
    if (graded === 'WRITE_FAILED') {
      return nothing(ended('DURABLE_WRITE_FAILED', saveDetail(activated)));
    }
    if (graded === 'STATE_UNUSABLE') return nothing(stopStep(ledger, 'STATE_UNUSABLE', options));
    if (graded !== 'RECORDED') {
      return nothing(stopStep(ledger, 'ACTIVE_TASK_UNRESOLVED', options));
    }
    const reloaded = loadBlockLedger(repository.root, ledger.ledger.runId);
    if (!reloaded.ok) return nothing(ended('RUN_GATE_REFUSED', reloaded.code));
    ledger = reloaded;
  }

  const drive = (): Promise<RunResult> =>
    runTask(
      {
        repository,
        taskId,
        // The task id, which is all this module legitimately has. The prose the
        // agents receive is read inside the driver, from the worktree it
        // authorised, so nothing here authors a prompt.
        taskBrief: taskId,
        attendedContinuation: true,
        authEvidence: evidence,
        lease,
        maxSteps: maxStepsPerTask,
      },
      {
        now: deps.now,
        git: deps.git,
        ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
        ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
        ...(deps.replace !== undefined ? { replace: deps.replace } : {}),
        ...(deps.tempSuffix !== undefined ? { tempSuffix: deps.tempSuffix } : {}),
      },
    );

  // The drive, continued under the same lease for as long as the *driver's* own
  // per-call bound is what stopped it. `maxSteps` exists so one `runTask` call
  // cannot run away; it is not a statement about the task, and the block run
  // may not end on it — a run that ended here would either misdescribe a
  // scheduling limit as a task-outcome claim or need to outlive its lease.
  let run = await drive();
  let steps = run.steps;
  let conclusion = conclusionForRunOutcome(run.outcome);

  while (conclusion === 'CONTINUE') {
    // A continuation that landed nothing would repeat itself for ever, and the
    // task's outcome is then genuinely not established. This is the floor that
    // makes the loop terminate without a counter nobody can justify: every
    // other continuation carries durable progress, and the task's own state
    // machine is bounded by the repository's `maxReviewRounds`.
    if (run.steps === 0) {
      return { step: stopStep(ledger, 'ACTIVE_TASK_UNRESOLVED', options), runOutcome: run.outcome, steps };
    }
    // The lease, between continuations too. The call that just returned was
    // minutes of subprocess, and a lease taken before it is not a lease held
    // after it.
    const stillHeld = verifyExecutionLeaseHeldFor(repository, lease);
    if (stillHeld.code !== 'HELD') {
      return { step: ended('LEASE_AUTHORITY_UNCERTAIN', stillHeld.code), runOutcome: run.outcome, steps };
    }
    run = await drive();
    steps += run.steps;
    conclusion = conclusionForRunOutcome(run.outcome);
  }

  const driven = (step: RunStep): DrivenStep => ({ step, runOutcome: run.outcome, steps });

  if (conclusion === 'LEASE_UNCERTAIN') {
    return driven(ended('LEASE_AUTHORITY_UNCERTAIN', run.outcome));
  }
  if (conclusion === 'STATE_UNUSABLE') {
    return driven(stopStep(ledger, 'STATE_UNUSABLE', options));
  }
  if (conclusion === 'UNRESOLVED') {
    return driven(stopStep(ledger, 'ACTIVE_TASK_UNRESOLVED', options));
  }

  const record =
    conclusion === 'SETTLE'
      ? settleBlockTask(ledger, taskId, options)
      : conclusion === 'PARK'
        ? parkBlockTask(ledger, taskId, options)
        : abandonBlockTask(ledger, taskId, options);

  const graded = recordingResultFor(record.outcome);
  if (graded === 'WRITE_FAILED') return driven(ended('DURABLE_WRITE_FAILED', saveDetail(record)));
  if (graded === 'STATE_UNUSABLE') return driven(stopStep(ledger, 'STATE_UNUSABLE', options));
  if (graded !== 'RECORDED') return driven(stopStep(ledger, 'ACTIVE_TASK_UNRESOLVED', options));

  const reloaded = loadBlockLedger(repository.root, ledger.ledger.runId);
  if (!reloaded.ok) return driven(ended('RUN_GATE_REFUSED', reloaded.code));
  return { step: Object.freeze({ kind: 'OPEN' as const, ledger: reloaded }), runOutcome: run.outcome, steps };
}

/**
 * A stop, expressed as a step so the helpers above can end a run.
 *
 * It writes through `stopBlockRun` and grades the write exactly as
 * `RunState.stop` does; the duplication is one line and the alternative — a
 * helper that returns "please stop with this reason" and a caller that might
 * forget to — is the shape where an ending is decided and never recorded.
 */
function stopStep(
  current: LedgerLoadSuccess,
  reason: BlockStopReason,
  options: BlockProgressOptions,
): FinishedStep {
  const stopped = stopBlockRun(current, reason, options);
  if (stopped.outcome !== 'RECORDED') {
    return ended('DURABLE_WRITE_FAILED', saveDetail(stopped) ?? stopped.outcome);
  }
  return Object.freeze({ kind: 'STOPPED' as const, reason, ledger: stopped.ledger });
}
```

`RunState.stop` and `stopStep` write the same way and grade the same way, and
the one duplicated branch is deliberate. The alternative — a helper that returns
"please stop with this reason" and a caller that may forget to — is the shape
where an ending is decided and never recorded.


- [ ] **Step 5: Write the lifetime controls**

Three cases the lifetime decision needs, and none of them is implied by the
four above. Append:

```ts
describe('the invocation absorbs the driver’s budget rather than ending on it', () => {
  it('drives the same task again when only the per-call bound was reached', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    // maxStepsPerTask of 1 makes the driver stop after its first durable write
    // on every call, so a task that needs several reaches STEP_BUDGET_EXHAUSTED
    // repeatedly — the exact condition that used to end the invocation.
    const seams = drivingSeams();
    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 1,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: seams.agent,
        verify: seams.verify,
      },
    );

    // The block still finishes, under one lease, in one invocation.
    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('COMPLETE');
    // And a scheduling limit never became a claim about a task.
    expect(result.stopReason).not.toBe('ACTIVE_TASK_UNRESOLVED');
    expect(onDisk(fixture.root)['stopReason']).toBe('COMPLETE');
    // The bound really was reached, or this case proves nothing: several
    // durable steps landed for a budget of one per call.
    expect(result.steps).toBeGreaterThan(2);
  }, 900_000);

  it('is not a block-run outcome at all', () => {
    // The vocabulary itself, so a future edit that reintroduces the outcome
    // fails here rather than in a behaviour case somebody may not run.
    expect([...BLOCK_RUN_OUTCOMES]).not.toContain('STEP_BUDGET_EXHAUSTED');
  });
});

describe('the invocation acts on the plan as it was when it opened', () => {
  // The counter-proof for the snapshot rule, and the case that discriminates:
  // it fails with RUN_GATE_REFUSED against any implementation in which a start
  // path plans again — which is what `startTask` did before Task 6B, one layer
  // below a runner that imports no planner and looks correct.
  it('does not let a mid-run roadmap edit change what runs next', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const snapshot = planningOf(fixture);
    const seams = drivingSeams();
    let edited = false;
    const agent = recordedAgent({
      claude: () => {
        if (!edited) {
          edited = true;
          // B-001 gains a dependency on a task that is not DONE. Anything that
          // re-read the roadmap would now find it ineligible: a runner doing so
          // would end NO_ELIGIBLE_TASK, and a *start path* doing so would answer
          // TASK_INELIGIBLE and end the run RUN_GATE_REFUSED.
          writeRepoFile(fixture.root, 'tasks/GATE-001.md', taskFile('GATE-001'));
          writeRepoFile(fixture.root, 'tasks/B-001.md', taskFile('B-001', { dependsOn: ['GATE-001'] }));
        }
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });

    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: snapshot,
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: seams.verify,
      },
    );

    // The premise: the edit really did change what the planner would say.
    expect(planningOf(fixture).selection.eligibility.find((e) => e.taskId === 'B-001')?.eligible)
      .toBe(false);
    // And the run acted on the snapshot regardless. Asserted as COMPLETE and
    // *not* as "not RUN_GATE_REFUSED", because the two failure modes this
    // discriminates against produce two different wrong answers and only the
    // finished block excludes both.
    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('COMPLETE');
    expect((onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[])
      .map((task) => task['disposition'])).toEqual(['SETTLED', 'SETTLED']);
  }, 900_000);
});

describe('a run id is used once', () => {
  it('refuses a second invocation of the same run id rather than continuing it', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const first = await runBlock(fixture);
    expect(first.stopReason).toBe('COMPLETE');
    const after = readFileSync(ledgerPath(fixture.root));

    const second = await runBlock(fixture);

    // A block run's lifetime is its invocation's lifetime, so there is nothing
    // to continue — and the record of what the first one did is not overwritten.
    expect(second.outcome).toBe('RUN_GATE_REFUSED');
    expect(second.detail).toBe('RUN_ID_ALREADY_USED');
    expect(readFileSync(ledgerPath(fixture.root)).equals(after)).toBe(true);
  }, 900_000);
});
```

The first case needs a task that takes more than one durable step to finish,
which `drivingSeams` already produces — the writer/verify/review cycle is
several transitions. If it turns out to complete in one, raise the review round
count in the fixture profile rather than asserting a weaker `steps` bound.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS. These cases start real worktrees and drive real state machines; the timeouts above are deliberate.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Close the importer pin this task deliberately breaks**

`tests/v2-07l-execution-lease.test.ts:1240` asserts that **no** production
module imports `block-progress.ts`'s six mutating functions, and its own comment
says why: *"this fails the moment a runner appears, and closing it means
threading the lease through that runner rather than editing this list."* Task 7
is that runner, so the pin fails here by design.

Close it the way the comment demands — the lease is already threaded through
`AttendedBlockRequest.lease` and re-proved every iteration — and then name the
new importer:

```ts
    expect(
      productionImportersOf([
        'startBlockRun',
        'activateBlockTask',
        'settleBlockTask',
        'parkBlockTask',
        'abandonBlockTask',
        'stopBlockRun',
      ]),
    ).toEqual([join('src', 'block', 'block-runner.ts')]);
```

and rewrite the comment above it so it describes what is now true: the block
layer has exactly one productive caller, it holds a lease across the whole block
run, and a second caller is still a decision that breaks the build.

Run: `npx vitest run tests/v2-07l-execution-lease.test.ts`
Expected: PASS. If the pin reports a *second* importer, something reached the
progress layer from outside the runner — the CLI, a renderer, a helper — and the
fix is to route it through the runner, never to lengthen the list.

- [ ] **Step 8: Prove the runner computes neither the relation nor the plan**

Run: `git grep -n "block-dependencies" -- src/`
Expected: exactly one match, in `src/cli/block-command.ts` once Task 11 lands — and **none** in `src/block/block-runner.ts`. Until then, no match in `src/` at all.

Run: `git grep -n "planNextTask" -- src/block/`
Expected: **no match at all**, now and after Task 11. The runner receives a
`TaskPlanningSuccess` and imports the type; a call would mean the block layer had
taken a reading of its own, which is the authority inversion Task 6B exists to
close one layer down.

Both are checked with a grep rather than a test because the property is "this
module does not depend on that one", which a runtime assertion cannot see. What a
grep cannot see is the *reachable* second read — `startPlannedTask` is in a
module that still contains `planNextTask` for `startTask`'s sake — and that is
why the mid-run-edit case in Step 5 is an effect test rather than a comment.

- [ ] **Step 9: Commit**

```bash
git add src/block/block-runner.ts src/block/block-conclusion.ts tests/v2-08-attended-block-runner.test.ts tests/v2-07l-execution-lease.test.ts
git commit
```

Message:

```
feat: the attended block runner (V2-08)

Composes primitives that already exist and invents no orchestration truth. The
sequence is here; the meaning is in block-conclusion.ts; every durable claim
still goes through the primitive that re-proves it against the task's own
record.

Two exits, because a ledger stopReason is itself a durable claim. A condition
whose content is "this run can no longer make durable claims" must not be
expressed as one, so lease uncertainty, a failed durable write, a refused gate
and a reconciliation the primitive did not confirm end the run in the report
with the ledger left on its last provably durable state. That is not "nothing
was written": all four can strike after tasks have been settled in this
run, and those records stand. What is missing is only the ending.

Independence is read from the frozen plan and never derived: this module does
not import block-dependencies.ts, and the grep that says so is in the plan. The
plan itself is read the same way - the runner takes the caller's one
TaskPlanningSuccess, filters candidates by it and hands it to startPlannedTask,
so no gate below the runner can consult a second reading. The cost is stated
rather than hidden: a mid-run roadmap edit is invisible to this invocation in
both directions, and there is no drift check to notice it, because with no
resume there is no persisted predecessor to compare against.

The lease is re-proved every iteration, and between continuations of one task
too. A step is a subprocess that took minutes, and a lease taken before it is
not a lease held after it.

A block run's lifetime is its invocation's lifetime. There is no resume: the
lease guarantee is stated over a whole block run, so an open run that outlived
its holder would need a lease left behind or a later process adopting a run it
never started. The driver's step budget is absorbed - the same task is driven
again under the same lease - because ending on it would either misdescribe a
scheduling limit as a claim about a task or need exactly that outliving run.
This closes the block-progress importer pin in v2-07l, whose comment asked for
the lease to be threaded through the runner rather than for the list to be
edited.
```

---

### Task 8: Each class-2 condition, separately — and the ledger left byte-identical

**Files:**
- Modify: `tests/v2-08-attended-block-runner.test.ts`
- Modify: `src/block/block-runner.ts` (only if a case exposes a wiring defect)

**Interfaces:**
- Consumes: `runAttendedBlock` (Task 7). Produces no new API.

Design §8.3 says it plainly: *one case per reason and per runner outcome*. A shared parametrised case passes against a runner that maps every condition to one reason, which is the misdescription defect in its natural habitat. So the cases below are separate by construction, and each drives its condition **at a point where further tasks are still eligible**, so that "the run stopped" is distinguishable from "the block happened to end".

`RUN_GATE_REFUSED` gets **two** cases, not one, because the outcome is reachable
on both sides of the ledger's creation and the two are not the same claim: the
auth gate ahead of `openRun` leaves no ledger at all, while a start gate met
between two tasks leaves a ledger holding a settled task that must survive the
refusal untouched. One case for the convenient half is how "nothing was written"
became a sentence nobody had tested.

The fifth runner outcome, `RECONCILIATION_UNRESOLVED`, is pinned in Task 10 at
the function that produces it. It is named here so that a reader walking "one
case per runner outcome" does not conclude it was forgotten.

- [ ] **Step 1: Write the failing tests**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import { existsSync, renameSync, rmSync } from 'node:fs';

import { releaseRepositoryExecutionLease, deriveExecutionLeaseLocation } from '../src/lease/execution-lease.js';
import type { AttendedBlockDependencies } from '../src/block/block-runner.js';
import type { ReplaceFn } from '../src/state/atomic-file.js';

/**
 * A three-task block whose first task is driven, and a hook that fires while
 * the second is still eligible.
 *
 * The hook is what makes these cases mean anything: a class-2 condition
 * introduced after the block would have ended anyway proves nothing, so each
 * case below breaks something *between* two tasks and then asserts that the
 * untouched ones are untouched.
 */
async function runWithHookAfterFirstTask(
  fixture: Fixture,
  hook: () => void,
  overrides: Partial<AttendedBlockDependencies> = {},
): Promise<AttendedBlockResult> {
  let driven = 0;
  const agent = recordedAgent({
    claude: () => writerSuccess(),
    codex: () => {
      driven += 1;
      if (driven === 1) hook();
      return reviewResult(passingReview());
    },
  });
  return runAttendedBlock(
    {
      repository: fixture.repository,
      definition: independentBlock(['A-001', 'B-001', 'C-001']),
      runId: RUN_ID,
      lease: leaseFor(fixture.repository),
      maxStepsPerTask: 8,
      planning: planningOf(fixture),
    },
    {
      now: tickingClock(),
      git: runGitCommand,
      authPreflight: authPreflightPasses,
      agent: agent.runner,
      verify: recordedVerify().runner,
      ...overrides,
    },
  );
}

/**
 * A ledger replace seam that does the real rename and remembers what went past.
 *
 * Two questions need two records. `staged()` is every document the run *tried*
 * to write, which is how a best-effort stop write is caught even when it never
 * landed; `last()` is the bytes on disk after the last write that succeeded,
 * which is the only honest anchor for "the ledger did not move across this
 * condition" when the condition is reached some time after the last write.
 */
function recordingLedgerReplace(root: string) {
  const stagedDocuments: string[] = [];
  let landed: Buffer | null = null;
  return {
    replace: ((from, to) => {
      stagedDocuments.push(readFileSync(from, 'utf8'));
      renameSync(from, to);
      landed = readFileSync(ledgerPath(root));
    }) as ReplaceFn,
    staged: (): readonly string[] => stagedDocuments,
    last: (): Buffer | null => landed,
  };
}

describe('each class-2 condition ends the run under its own name', () => {
  it('LEDGER_DIVERGED — the ledger and the records disagree', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // Forge a settlement for a task that never finished, between two tasks.
    const result = await runWithHookAfterFirstTask(fixture, () => {
      forgeSettlement(fixture.root, 'C-001');
    });

    expect(result.outcome).toBe('BLOCK_RUN_ENDED');
    expect(result.stopReason).toBe('LEDGER_DIVERGED');
    expect(onDisk(fixture.root)['stopReason']).toBe('LEDGER_DIVERGED');
  }, 900_000);

  it('STATE_UNUSABLE — a task record exists and cannot be used', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    const result = await runWithHookAfterFirstTask(fixture, () => {
      corruptTaskState(fixture.root, 'A-001');
    });

    // Its own reason, not LEDGER_DIVERGED: "a record cannot be read" and "the
    // ledger and the records disagree" send an operator to different places.
    expect(result.stopReason).toBe('STATE_UNUSABLE');
    expect(onDisk(fixture.root)['stopReason']).toBe('STATE_UNUSABLE');
    // B-001 and C-001 were eligible and are untouched.
    const dispositions = (onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[]).map(
      (task) => task['disposition'],
    );
    expect(dispositions.slice(1)).toEqual(['PLANNED', 'PLANNED']);
  }, 900_000);

  it('names the two reasons this runner cannot produce, rather than pretending', () => {
    // `DEFINITION_DRIFTED` compares a frozen plan with a current one, and a block
    // run does not outlive its invocation — so there is never a persisted
    // predecessor to compare against, and the reason has no producer here.
    // `OPERATOR_STOPPED` has none either: this runner installs no signal
    // handling.
    //
    // Asserted rather than left implicit, and asserted on the *runner* rather
    // than on the vocabulary: both reasons are V2-07's, both stay graded in the
    // exit table, and `reconcileBlockRun` still reports drift to a caller that
    // supplies a definition. What must not happen is a later reader taking the
    // "one case per reason" rule above to mean these two were covered.
    expect(BLOCK_STOP_REASONS).toContain('DEFINITION_DRIFTED');
    expect(BLOCK_STOP_REASONS).toContain('OPERATOR_STOPPED');
    expect(UNPRODUCED_BY_THIS_RUNNER).toEqual(['DEFINITION_DRIFTED', 'OPERATOR_STOPPED']);
  });

  it('ACTIVE_TASK_UNRESOLVED — the active task’s outcome cannot be established', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // A second writer moves the task on while it is being driven, so the
    // driver's own next write meets a revision that is no longer the one it
    // read. `STATE_CONFLICT` is graded UNRESOLVED: the driver's write did not
    // land, the task's outcome is not established, and re-reading and deciding
    // again is exactly how a stale-writer refusal gets laundered.
    const agent = recordedAgent({
      claude: () => {
        movedByAnotherWriter(fixture, 'A-001');
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });

    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001', 'C-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: recordedVerify().runner,
      },
    );

    expect(result.stopReason).toBe('ACTIVE_TASK_UNRESOLVED');
    const after = onDisk(fixture.root);
    expect(after['stopReason']).toBe('ACTIVE_TASK_UNRESOLVED');
    // The coexistence contract, at the runner level this time.
    expect(after['activeTaskId']).toBe('A-001');
    const entries = after['tasks'] as readonly Record<string, unknown>[];
    expect(entries[0]?.['disposition']).toBe('ACTIVE');
    expect(entries[0]?.['evidenceRevision']).toBeNull();
    // B-001 and C-001 were eligible and are untouched.
    expect(entries.slice(1).map((task) => task['disposition'])).toEqual(['PLANNED', 'PLANNED']);
  }, 900_000);

  it('RUN_GATE_REFUSED — auth is not there, and no ledger is created', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    const result = await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      authPreflight: authPreflightFails,
    });

    expect(result.outcome).toBe('RUN_GATE_REFUSED');
    expect(result.stopReason).toBeNull();
    expect(result.detail).toBe('AUTH_PREFLIGHT_FAILED');
    // This gate is answered before the first ledger is created, so there is not
    // even a file to be byte-identical with. That is a property of *this* gate
    // and not of the outcome — see the case below, which is the same outcome
    // over a ledger that exists and carries a settled task.
    expect(existsSync(ledgerPath(fixture.root))).toBe(false);
  }, 600_000);

  // The case the outcome's own wording used to hide. `RUN_GATE_REFUSED` said
  // "nothing was written", and the only case pinning it met the gate ahead of
  // `openRun` — so the claim was true of the convenient half and untested on the
  // other. A start gate met *between two tasks* ends the run under the same
  // outcome with a ledger that exists, carries A-001's settlement, and must not
  // gain a stop claim about the refusal.
  it('RUN_GATE_REFUSED — a start gate refuses after the ledger exists', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // The anchor has to be the last write the run made, not a value read at hook
    // time: the hook fires while A-001 is still being driven, and A-001's
    // settlement lands after it. `landed` therefore holds the ledger exactly as
    // it stood when the gate was reached, because a gate refusal writes nothing.
    const landed = recordingLedgerReplace(fixture.root);

    const result = await runWithHookAfterFirstTask(
      fixture,
      () => {
        // The repository stops ignoring its own runtime directory, so the next
        // start refuses RUNTIME_NOT_IGNORED. A real misconfiguration an operator
        // fixes outside the run — not a stubbed refusal, and not a condition
        // that would have ended the block anyway: B-001 and C-001 are eligible.
        writeFileSync(join(fixture.root, '.gitignore'), '# nothing ignored\n', 'utf8');
      },
      { ledgerReplace: landed.replace },
    );

    expect(result.outcome).toBe('RUN_GATE_REFUSED');
    expect(result.detail).toBe('RUNTIME_NOT_IGNORED');
    expect(result.stopReason).toBeNull();

    // Byte for byte across the gate. Not "the file is empty" and not "no stop
    // reason was written": the ledger holds A-001's settlement, that record is
    // true, and it stays. What must not appear is an ending.
    const before = landed.last();
    if (before === null) throw new Error('the run never wrote a ledger, so nothing was measured');
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);

    const document = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
    expect(document['stopReason']).toBeNull();
    const entries = document['tasks'] as readonly Record<string, unknown>[];
    expect(entries.map((task) => task['disposition'])).toEqual(['SETTLED', 'PLANNED', 'PLANNED']);
    // Every document the run staged, not only the last: a best-effort stop write
    // that was attempted and lost would be invisible in the file.
    for (const staged of landed.staged()) {
      expect((JSON.parse(staged) as Record<string, unknown>)['stopReason']).toBeNull();
    }
    // And the report carries the ending the ledger deliberately does not.
    expect(result.tasks[0]?.disposition).toBe('SETTLED');
  }, 900_000);
});

// Design §8.3a. Asserting "no stop reason was written" is weaker: it passes
// against a run that mutated the ledger some other way.
//
// "Byte-identical" is always *across the condition* — the ledger before it and
// the ledger after it. Never "byte-identical with an empty file": a run that
// settled a task before meeting one of these outcomes wrote that settlement, and
// it is true.
describe('an unrecorded outcome leaves the ledger byte-identical across it', () => {
  it('LEASE_AUTHORITY_UNCERTAIN', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    let before: Buffer | null = null;

    const result = await runWithHookAfterFirstTask(fixture, () => {
      before = readFileSync(ledgerPath(fixture.root));
      // The lease removed underneath the run, which is what an operator
      // breaking a lease they believed stale actually does.
      const location = deriveExecutionLeaseLocation(fixture.repository);
      if (!location.ok) throw new Error('fixture: no lease location');
      rmSync(location.path, { force: true });
    });

    expect(result.outcome).toBe('LEASE_AUTHORITY_UNCERTAIN');
    expect(result.stopReason).toBeNull();
    if (before === null) throw new Error('the hook never ran, so nothing was measured');
    // Byte for byte. The run may no longer be the writer, so any mutation at
    // all is precisely the act it has lost the authority for.
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);
  }, 900_000);
});
```

and the list the case above holds itself to, written beside the cases so it
cannot drift from them:

```ts
/**
 * The persisted reasons `runAttendedBlock` cannot reach, and why.
 *
 * A list rather than a comment, because "we decided not to cover these" and "we
 * forgot to cover these" look identical in a suite otherwise organised as one
 * case per reason. Every other member of `BLOCK_STOP_REASONS` has a case above.
 */
const UNPRODUCED_BY_THIS_RUNNER = ['DEFINITION_DRIFTED', 'OPERATOR_STOPPED'] as const;
```

Add the fixture helpers, each of which produces its condition through a real file rather than a stub:

```ts
/** A `SETTLED` entry for a task that never finished. A hand-edit, as on disk. */
function forgeSettlement(root: string, taskId: string): void {
  const document = onDisk(root);
  const tasks = (document['tasks'] as Record<string, unknown>[]).map((entry) =>
    entry['taskId'] === taskId
      ? { ...entry, disposition: 'SETTLED', evidenceRevision: 'f'.repeat(64), resultCommit: 'a'.repeat(40) }
      : entry,
  );
  writeFileSync(
    ledgerPath(root),
    `${JSON.stringify({ ...document, tasks }, null, 2)}\n`,
    'utf8',
  );
}

/** A task record that exists and cannot be parsed. */
function corruptTaskState(root: string, taskId: string): void {
  writeFileSync(join(root, '.agent-orchestrator', 'runtime', `${taskId}.json`), '{ not json', 'utf8');
}

/**
 * A legitimate write by somebody who is not this run, landed mid-drive.
 *
 * Through the production store, at the current revision, so it succeeds exactly
 * as a second writer's would — and the driver's own next write then meets a
 * revision that is no longer the one it read. That is a real `STATE_CONFLICT`
 * rather than a state file edited into a shape.
 */
function movedByAnotherWriter(fixture: Fixture, taskId: string): void {
  const loaded = loadTaskState(fixture.root, taskId);
  if (!loaded.ok) throw new Error('fixture: the task never started');
  const saved = saveTaskState(
    { ...loaded.state, stateEnteredAt: '2026-08-14T11:30:00.000Z' },
    { repositoryRoot: fixture.root, expectedRevision: loaded.revision },
  );
  if (!saved.ok) throw new Error(`fixture could not move the task on: ${saved.code}`);
}
```

> **If `STATE_CONFLICT` turns out not to be reachable this way**, the mechanism
> is wrong but the requirement is not: `ACTIVE_TASK_UNRESOLVED` must be driven
> through a *real* driver answer that `conclusionForRunOutcome` grades
> `UNRESOLVED`, and the control is that the **runner** classified it. Pick
> another such outcome — `STATE_DIVERGED` and `STATE_UNOBSERVABLE` are both
> drivable by disturbing the worktree — and record which one, and why, in the
> commit message. Do **not** reach it by writing `stopReason` or a disposition
> into the ledger by hand; that would prove only that the assertions can read a
> file somebody wrote.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: some will already pass — Task 7 wired every branch — and each failure is a wiring defect in `block-runner.ts`, not a missing feature. Fix the runner, never the assertion. In particular:

- a case ending under the *wrong* reason means a grade in `block-conclusion.ts` is wrong, and its hand-written table in Task 6 must be corrected first, with a note of why;
- the byte-identity case failing means a write happened after the lease check, which is the defect §8.3a exists to catch.

- [ ] **Step 3: Run the whole in-process suite**

Run: `npm run test:foundation-safe`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/v2-08-attended-block-runner.test.ts src/block/block-runner.ts
git commit
```

Message:

```
test: every class-2 condition, separately, and by effect (V2-08)

One case per persisted reason and per runner outcome. A shared parametrised
case passes against a runner that maps every condition to one reason, which is
the misdescription defect in its natural habitat.

Each condition is driven between two tasks, while further tasks are still
eligible, and the untouched ones are asserted untouched. A stop that coincides
with the end of the block proves nothing.

The lease case compares the persisted ledger byte for byte before and after.
"No stop reason was written" is weaker: it passes against a run that mutated
the ledger some other way.
```

---

### Task 9: `DURABLE_WRITE_FAILED`

**Files:**
- Modify: `tests/v2-08-attended-block-runner.test.ts`
- Modify: `src/block/block-runner.ts` (only if a case exposes a defect)

**Interfaces:** consumes `AttendedBlockDependencies.ledgerReplace` (Task 7). Produces no new API.

Its own task, on the design's explicit instruction: it is the only one of the three runner outcomes that can strike **the stop write itself**, so it needs a reporting path that stays honest with no durable write available at all. The other two can always fall back on "write nothing and report"; this one has to prove that it did not first try to write a stop reason about a failed write.

- [ ] **Step 1: Write the failing tests**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
/** A replace seam that fails every time, so no ledger write can land. */
function alwaysFailingReplace(): ReplaceFn {
  return () => {
    const error = new Error('replace refused by the test seam') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  };
}

/** A replace seam that works `n` times and then fails. */
function replaceFailingAfter(n: number): ReplaceFn {
  let seen = 0;
  return (from, to) => {
    seen += 1;
    if (seen > n) {
      const error = new Error('replace refused by the test seam') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    renameSync(from, to);
  };
}

describe('a durable write that is not possible is reported, never claimed', () => {
  it('reports the failure of the very first write, with no ledger on disk', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    const result = await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      ledgerReplace: alwaysFailingReplace(),
    });

    expect(result.outcome).toBe('DURABLE_WRITE_FAILED');
    expect(result.stopReason).toBeNull();
    // The condition is that the run cannot write. There is no ledger, and the
    // runner did not manufacture one to record that it could not write.
    expect(existsSync(ledgerPath(fixture.root))).toBe(false);
    // The detail names the failure rather than describing it.
    expect(result.detail).toContain('WRITE_FAILED');
  }, 600_000);

  it('leaves the ledger byte-identical when a later write fails', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    // One successful write — the creation — and every later one refused.
    const result = await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      ledgerReplace: replaceFailingAfter(1),
    });
    const after = readFileSync(ledgerPath(fixture.root));

    expect(result.outcome).toBe('DURABLE_WRITE_FAILED');
    expect(result.stopReason).toBeNull();
    // The activation failed, so the ledger is still the creation. Byte for
    // byte, and with no stop reason: the run cannot presuppose a successful
    // stop write, because the failed write is the condition being reported.
    const document = JSON.parse(after.toString('utf8')) as Record<string, unknown>;
    expect(document['stopReason']).toBeNull();
    expect(document['activeTaskId']).toBeNull();
    expect((document['tasks'] as readonly Record<string, unknown>[]).map((t) => t['disposition']))
      .toEqual(['PLANNED', 'PLANNED']);
  }, 600_000);

  it('does not try to record a stop reason about a write it could not make', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const attempted: string[] = [];

    await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      ledgerReplace: (from, to) => {
        attempted.push(readFileSync(from, 'utf8'));
        const error = new Error('refused') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
    });

    // Every document the run staged is inspected. A best-effort stop write
    // would appear here as a staged document carrying a stopReason — the run's
    // least trustworthy claim, made at its least trustworthy moment.
    for (const staged of attempted) {
      const document = JSON.parse(staged) as Record<string, unknown>;
      expect(document['stopReason']).toBeNull();
    }
    expect(attempted.length).toBeGreaterThan(0);
  }, 600_000);
});
```

`renameSync` and `ReplaceFn` are already imported — Task 8's post-open gate case
brought both in.

Note what the third case measures that the second cannot: the second asserts the *file* has no stop reason, which is also true of a run that staged one and failed to move it. The third reads what was staged, so a best-effort stop write is visible even when it never landed.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS if Task 7's grading is right. A failure in the third case means some path calls `stopBlockRun` after a `WRITE_FAILED` grade — fix `block-runner.ts` so that grade returns immediately.

- [ ] **Step 3: Commit**

```bash
git add tests/v2-08-attended-block-runner.test.ts src/block/block-runner.ts
git commit
```

Message:

```
test: a durable write that is not possible is reported, never claimed (V2-08)

Its own task, because DURABLE_WRITE_FAILED is the only one of the three runner
outcomes that can strike the stop write itself. It cannot presuppose a
successful stop write, because the failed write is the condition being
reported.

Three cases, and the third is the one that matters: the second asserts the file
carries no stop reason, which is also true of a run that staged one and failed
to move it. The third reads every staged document, so a best-effort stop write
is visible even when it never landed.

The ledger seams are separate from the task-state ones on purpose. A single
pair would make this case unable to fail a ledger write without failing every
task-state write, and it would then prove that a broken disk breaks everything.
```

---

### Task 10: Positive reconciliation — forced, monotone, idempotent, and refused otherwise

**Files:**
- Modify: `tests/v2-08-attended-block-runner.test.ts`
- Modify: `src/block/block-runner.ts` (only if a case exposes a defect)

**Interfaces:** consumes `applyForcedProgress` (Task 7). Produces no new API.

`README.md:3588` assigns this slice the decision of which positive reconciliations may be applied on their own. The decision is recorded in `applyForcedProgress`' doc comment and pinned here:

> A reconciliation is permitted only when **all six** hold — it is fully
> determined by durable authoritative evidence that already exists; there is
> exactly one admissible successor state; the change is monotone; no new
> evidence is invented; the ordinary primitive accepts the same change on its
> existing proofs; and applying it repeatedly is idempotent. The moment any
> selection, interpretation, or choice between competing plausible truths would
> be required: **do not repair — stop the block and report.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
describe('positive reconciliation is applied only where it is forced', () => {
  it('recognises a PLANNED task that already finished, through the primitive', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    // B-001 reaches READY_FOR_PR before the run exists — a real state, driven
    // the way the suite drives every other one. The ledger is created by the
    // run itself: a block run does not adopt a ledger somebody else started.
    await reallyStart(fixture, 'B-001');
    driveToReadyForPr(fixture, 'B-001');

    const result = await runBlock(fixture);

    // Both settled: A-001 by being driven, B-001 by being recognised.
    expect(result.stopReason).toBe('COMPLETE');
    const entries = onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[];
    expect(entries.map((task) => task['disposition'])).toEqual(['SETTLED', 'SETTLED']);
    // And it is evidence-backed, because it went through settleBlockTask rather
    // than through a direct write. A reconciliation that bypassed the primitive
    // would be a second, weaker way to assert progress.
    expect(entries[1]?.['evidenceRevision']).not.toBeNull();
    expect(entries[1]?.['resultCommit']).not.toBeNull();
  }, 600_000);

  it('terminates when every member is already finished, having driven nothing', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    await reallyStart(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');
    await reallyStart(fixture, 'B-001');
    driveToReadyForPr(fixture, 'B-001');

    // The whole run is reconciliation: two entries recognised, nothing driven.
    // That the loop *ends* is the idempotence property doing its work — a
    // reconciliation that re-applied itself would never stop finding progress.
    const result = await runBlock(fixture);

    expect(result.stopReason).toBe('COMPLETE');
    expect(result.steps).toBe(0);
    expect(result.tasks.every((task) => task.runOutcome === null)).toBe(true);
  }, 600_000);

  it('changes nothing when the same settlement is recorded twice', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');
    expect(
      settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome,
    ).toBe('RECORDED');
    const after = readFileSync(ledgerPath(fixture.root));

    // Condition six, at the primitive that enforces it. Asserted on the bytes
    // and not only on the outcome: "it answered DISPOSITION_UNCHANGED" is
    // compatible with a write that changed a timestamp.
    const again = settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });

    expect(again.outcome).toBe('DISPOSITION_UNCHANGED');
    expect(readFileSync(ledgerPath(fixture.root)).equals(after)).toBe(true);
  }, 600_000);

  it('does not repair an ACTIVE task, even when its record looks finished', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToReadyForPr(fixture, 'A-001');
    const before = readFileSync(ledgerPath(fixture.root));

    // Asked of the function that draws the line, because the runner reaches
    // this state only through its own activation and would conclude the task in
    // the same iteration — the run-level path cannot hold the two apart.
    //
    // The entry is ACTIVE and the record says READY_FOR_PR. Declaring it
    // settled from a reconciliation would be choosing between "drive it" and
    // "call it done", which is the moment the six conditions stop holding.
    const step = applyForcedProgress(reload(fixture.root), fixture.root, {
      repositoryRoot: fixture.root,
    });

    expect(step.kind).toBe('OPEN');
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);
  }, 600_000);

  it('applies the forced case at the same function, so the refusal above is not blanket', async () => {
    // The control. Without it, an implementation that reconciles nothing at all
    // passes the case above.
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');

    const step = applyForcedProgress(reload(fixture.root), fixture.root, {
      repositoryRoot: fixture.root,
    });

    expect(step.kind).toBe('OPEN');
    const entries = onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[];
    expect(entries[0]?.['disposition']).toBe('SETTLED');
    // Through the primitive, so it carries the evidence a direct write could
    // not have produced.
    expect(entries[0]?.['evidenceRevision']).not.toBeNull();
  }, 600_000);

  // The classification that Task 7's first draft got wrong: every non-RECORDED
  // grade was reported as DURABLE_WRITE_FAILED, which sends an operator to look
  // at a disk that is working. `recordingResultFor` distinguishes four classes
  // and `applyForcedProgress` must keep all four apart.
  it('reports a reconciliation the primitive did not confirm under its own name', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');
    // The ledger stops, so the reconciliation still reads as forced — A-001 is
    // PLANNED and its record says READY_FOR_PR — while the primitive refuses it
    // (`RUN_ALREADY_STOPPED`, graded UNRESOLVED).
    stopBlockRun(reload(fixture.root), 'OPERATOR_STOPPED', { repositoryRoot: fixture.root });
    const before = readFileSync(ledgerPath(fixture.root));

    const step = applyForcedProgress(reload(fixture.root), fixture.root, {
      repositoryRoot: fixture.root,
    });

    expect(step.kind).toBe('ENDED');
    if (step.kind !== 'ENDED') return;
    // Its own outcome. Not DURABLE_WRITE_FAILED — nothing is wrong with the
    // disk — and not ACTIVE_TASK_UNRESOLVED, which is a persisted claim about an
    // ACTIVE task while this entry is PLANNED.
    expect(step.outcome).toBe('RECONCILIATION_UNRESOLVED');
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);
  }, 600_000);
});

// What the case above does and does not establish, written down rather than
// assumed: it pins the *classification* — an UNRESOLVED grade from the forced
// path is reported as RECONCILIATION_UNRESOLVED and nothing is repaired or
// retried. It does not reproduce the condition an operator will actually meet,
// which is evidence moving between the reconciliation read and the primitive's
// own check (`TASK_STATE_DOES_NOT_PROVE_IT`). That is a race, and a case that
// tried to arrange it deterministically would need a seam inside
// `applyForcedProgress` — a seam whose only purpose is to make a test pass is
// a hole in the function it is testing. The stopped-ledger route reaches the
// same branch through a condition the runner grades as a fail-closed floor.

describe('positive reconciliation stops rather than guessing', () => {
  it('stops rather than choosing when the evidence supports no single successor', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // A second writer moves the task on mid-drive, so this run's own write is
    // refused and the task ends neither finished, nor blocked, nor aborted.
    // Nothing may be recorded for it, and there is no repair that is not a
    // guess — so the block stops and invents nothing.
    const agent = recordedAgent({
      claude: () => {
        movedByAnotherWriter(fixture, 'A-001');
        return writerSuccess();
      },
      codex: () => reviewResult(passingReview()),
    });
    const result = await runAttendedBlock(
      {
        repository: fixture.repository,
        definition: independentBlock(['A-001', 'B-001', 'C-001']),
        runId: RUN_ID,
        lease: leaseFor(fixture.repository),
        maxStepsPerTask: 8,
        planning: planningOf(fixture),
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        authPreflight: authPreflightPasses,
        agent: agent.runner,
        verify: recordedVerify().runner,
      },
    );

    expect(result.stopReason).toBe('ACTIVE_TASK_UNRESOLVED');
    const entries = onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[];
    // Nothing was invented for it, and the block stopped rather than guessing.
    expect(entries[0]?.['disposition']).toBe('ACTIVE');
    expect(entries[0]?.['evidenceRevision']).toBeNull();
  }, 900_000);
});
```

The cases above call `applyForcedProgress`, `settleBlockTask`, `activateBlockTask`
and `stopBlockRun` directly; add whichever of those four the file does not import
yet. Add the state helper (`movedByAnotherWriter` is already in the file from
Task 8):

```ts
/** Moves a real task's durable state to `READY_FOR_PR`, the settlement proof. */
function driveToReadyForPr(fixture: Fixture, taskId: string): void {
  const loaded = loadTaskState(fixture.root, taskId);
  if (!loaded.ok) throw new Error('fixture: the task never started');
  const saved = saveTaskState(
    {
      ...loaded.state,
      state: 'READY_FOR_PR',
      stateEnteredAt: '2026-08-14T10:00:00.000Z',
      reviewRound: 1,
      worktreeCleanAtCheckpoint: true,
    },
    { repositoryRoot: fixture.root, expectedRevision: loaded.revision },
  );
  if (!saved.ok) throw new Error(`could not drive to READY_FOR_PR: ${saved.code}`);
}
```

`driveToReadyForPr` is the same helper `tests/v2-07-block-ledger.test.ts:112` already uses; it is repeated here rather than shared, because a fixture shared between two suites is a fixture neither suite can change.

- [ ] **Step 2: Export the function the line lives in**

In `src/block/block-runner.ts`, export `applyForcedProgress` and say why:

```ts
/**
 * …
 *
 * Exported for one reason: the repair-versus-choice line is the whole of this
 * slice's answer to "which positive reconciliations may be applied alone", and
 * the runner reaches an `ACTIVE` entry only through its own activation — which
 * it then concludes in the same iteration. So the run-level path cannot hold
 * "applied because forced" and "refused because it would be a choice" apart,
 * and a decision that cannot be inspected cannot be reviewed.
 *
 * It is not part of any consumer's API. `block-command.ts` calls
 * `runAttendedBlock` and nothing else.
 */
export function applyForcedProgress(
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS. A failure in the ACTIVE case — the entry settled — means `applyForcedProgress` is not restricted to `PLANNED` entries, which is the repair-versus-choice line. A `RECONCILIATION_UNRESOLVED` case reporting `DURABLE_WRITE_FAILED` means the four grades of `recordingResultFor` were collapsed on the way out; fix the classification in `block-runner.ts`, never the assertion.

Run: `npm run test:foundation-safe`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/v2-08-attended-block-runner.test.ts src/block/block-runner.ts
git commit
```

Message:

```
test: positive reconciliation, applied only where it is forced (V2-08)

README:3588 left this slice the decision of which positive reconciliations may
be applied alone. Decided: only through the existing authoritative primitive,
never by writing the ledger, and only when all six conditions hold - determined
by durable evidence, exactly one admissible successor, monotone, inventing
nothing, accepted by the ordinary primitive on its existing proofs, and
idempotent.

The line that makes it a rule rather than a preference: an ACTIVE entry is not
reconciled even when its record says READY_FOR_PR. That task is the run's own
business, and choosing between "drive it" and "call it done" is a choice.

Pinned at applyForcedProgress rather than through a run, and the function is
exported for that: the runner reaches an ACTIVE entry only through its own
activation and concludes it in the same iteration, so the run-level path cannot
hold "applied because forced" and "refused because it would be a choice" apart.
Both directions are asserted, because a refusal case alone passes against an
implementation that reconciles nothing.

Where the evidence supports no single successor the block stops with
ACTIVE_TASK_UNRESOLVED and invents nothing.

And the four grades a recording attempt can carry stay four on the way out. A
reconciliation that read as forced and was refused by the primitive is
RECONCILIATION_UNRESOLVED - the evidence moved between the two reads, nothing is
repaired and nothing is retried. Reporting it as DURABLE_WRITE_FAILED would send
an operator to look at a disk that is working, and ACTIVE_TASK_UNRESOLVED would
be a persisted claim about an ACTIVE task when forced reconciliation only ever
touches PLANNED ones.
```

---

### Task 11: `agent-loop block`, and the exit codes an operator sees

**Files:**
- Create: `src/cli/block-command.ts`
- Create: `src/cli/render-block-run.ts`
- Modify: `src/cli/run-exit-codes.ts` (after line 253)
- Modify: `src/cli/index.ts` (imports, `buildProgram`, `DESCRIPTION`)
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Consumes: `runAttendedBlock`, `BlockRunOutcome`, `AttendedBlockResult` (Task 7); `projectBlockDependencies` (Task 2); `defineBlock` (Task 1).
- Produces: `exitCodeForBlockRun(result: AttendedBlockResult): CliExitCode`; `registerBlockCommand(program: Command, seams?: BlockCommandSeams): void`; `renderBlockRun(repository, result): string`; `BLOCK_OUTCOME_SENTENCES`; `BLOCK_STOP_SENTENCES`.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import { Command } from 'commander';

import { registerBlockCommand, type BlockCommandSeams } from '../src/cli/block-command.js';
import { BLOCK_OUTCOME_SENTENCES, BLOCK_STOP_SENTENCES } from '../src/cli/render-block-run.js';
import {
  EXIT_RUN_CALL_AGAIN,
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  exitCodeForBlockRun,
} from '../src/cli/run-exit-codes.js';
import { BLOCK_RUN_OUTCOMES } from '../src/block/block-runner.js';

async function invokeBlock(args: readonly string[], seams: BlockCommandSeams = {}): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBlockCommand(program, seams);
  await program.parseAsync(['block', ...args], { from: 'user' });
}

describe('the exit code says what an operator should do next', () => {
  const code = (outcome: BlockRunOutcome, stopReason: BlockStopReason | null) =>
    exitCodeForBlockRun({
      outcome,
      stopReason,
      detail: null,
      runId: RUN_ID,
      blockId: BLOCK_ID,
      tasks: [],
      steps: 0,
    });

  it('grades a completed block nominal', () => {
    expect(code('BLOCK_RUN_ENDED', 'COMPLETE')).toBe(EXIT_RUN_OK);
  });

  it('sends every ending that needs a human to code 3', () => {
    for (const reason of ['TASK_BLOCKED', 'TASK_ABANDONED', 'LEDGER_DIVERGED', 'STATE_UNUSABLE', 'DEFINITION_DRIFTED', 'ACTIVE_TASK_UNRESOLVED'] as const) {
      expect(code('BLOCK_RUN_ENDED', reason)).toBe(EXIT_RUN_NEEDS_OPERATOR);
    }
  });

  it('keeps NO_ELIGIBLE_TASK an unusable input, as the plan table already does', () => {
    expect(code('BLOCK_RUN_ENDED', 'NO_ELIGIBLE_TASK')).toBe(EXIT_RUN_INPUT_UNUSABLE);
  });

  it('grades the four unrecorded outcomes by what the operator must do', () => {
    // Lease and gate: nothing durable is wrong and re-invoking under other
    // conditions can differ. The other two are not like that — a disk or a
    // permission has to be fixed before anything will ever run, and a
    // reconciliation the primitive refused means somebody or something moved
    // task state under a held lease.
    expect(code('LEASE_AUTHORITY_UNCERTAIN', null)).toBe(EXIT_RUN_REFUSED);
    expect(code('RUN_GATE_REFUSED', null)).toBe(EXIT_RUN_REFUSED);
    expect(code('DURABLE_WRITE_FAILED', null)).toBe(EXIT_RUN_NEEDS_OPERATOR);
    expect(code('RECONCILIATION_UNRESOLVED', null)).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('never tells an operator to call again, because nothing would continue', () => {
    // A block run does not outlive its invocation. Exit 5 means "everything is
    // on disk, call again to continue", and there is nothing here that a second
    // call would continue — the run id is spent. Written over the vocabularies
    // rather than over a hand-listed set, so a new outcome is graded here too.
    const everyCode = [
      ...BLOCK_STOP_REASONS.map((reason) => code('BLOCK_RUN_ENDED', reason)),
      ...BLOCK_RUN_OUTCOMES.filter((outcome) => outcome !== 'BLOCK_RUN_ENDED').map((outcome) =>
        code(outcome, null),
      ),
    ];
    expect(everyCode).not.toContain(EXIT_RUN_CALL_AGAIN);
  });
});

describe('every outcome and every reason has its own sentence', () => {
  it('covers the outcome vocabulary, distinctly', () => {
    const sentences = BLOCK_RUN_OUTCOMES.map((outcome) => BLOCK_OUTCOME_SENTENCES[outcome]);
    expect(sentences.every((sentence) => sentence.length > 0)).toBe(true);
    // Distinct, because four unrecorded outcomes that read alike are four
    // outcomes an operator cannot act on differently — which is the whole
    // reason they are four and not one generic RUN_UNSAFE.
    expect(new Set(sentences).size).toBe(BLOCK_RUN_OUTCOMES.length);
  });

  it('does not claim that nothing was written', () => {
    // The sentence that was wrong: every one of the four unrecorded outcomes is
    // reachable after this run has settled tasks, and telling an operator
    // "nothing was written" sends them looking for a ledger that is there, or
    // stops them looking at one that is. What the sentences may say is that the
    // *ending* was not recorded.
    for (const outcome of BLOCK_RUN_OUTCOMES) {
      expect(BLOCK_OUTCOME_SENTENCES[outcome]).not.toMatch(/nothing was written/i);
    }
  });

  it('covers the stop-reason vocabulary, distinctly', () => {
    const sentences = BLOCK_STOP_REASONS.map((reason) => BLOCK_STOP_SENTENCES[reason]);
    expect(new Set(sentences).size).toBe(BLOCK_STOP_REASONS.length);
  });

  it('tells an operator which of the four unrecorded outcomes they met', () => {
    expect(BLOCK_OUTCOME_SENTENCES.LEASE_AUTHORITY_UNCERTAIN).toMatch(/lease|writer/i);
    expect(BLOCK_OUTCOME_SENTENCES.DURABLE_WRITE_FAILED).toMatch(/write|disk|permission/i);
    expect(BLOCK_OUTCOME_SENTENCES.RUN_GATE_REFUSED).toMatch(/gate|refused/i);
    expect(BLOCK_OUTCOME_SENTENCES.RECONCILIATION_UNRESOLVED).toMatch(/evidence|record|moved/i);
  });
});

describe('the command', () => {
  it('reports without executing unless --attended is given', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    await invokeBlock([
      '--repository', fixture.root,
      '--block', BLOCK_ID,
      '--tasks', 'A-001', 'B-001',
      '--run', RUN_ID,
    ]);

    // The same contract `run` keeps: no ledger, no state, no workspace.
    expect(existsSync(ledgerPath(fixture.root))).toBe(false);
    expect(process.exitCode).toBe(EXIT_RUN_OK);
    // And it says what it *would* freeze, including whether the members are
    // independent — the property the whole slice turns on.
    expect(stdout.join('')).toMatch(/independent/i);
    // No lease either. A report is not a claim on the repository's turn as
    // writer, and the plan it printed authorises nothing.
    const free = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-0002', blockId: BLOCK_ID },
      { now: () => new Date().toISOString() },
    );
    expect(free.ok).toBe(true);
    if (free.ok) releaseRepositoryExecutionLease(free.evidence);
  }, 600_000);

  it('refuses a member the repository does not declare, and gives the lease back', async () => {
    const fixture = await repoWith({ 'A-001': [] });

    await invokeBlock([
      '--repository', fixture.root,
      '--block', BLOCK_ID,
      '--tasks', 'A-001', 'GHOST-001',
      '--run', RUN_ID,
      '--attended',
    ]);

    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(stdout.join('')).toContain('TASK_NOT_IN_GRAPH');
    expect(existsSync(ledgerPath(fixture.root))).toBe(false);
    // The refusal now happens *under* the lease, because the plan it refuses is
    // read under the lease. So the property that matters is not "no lease was
    // taken" but "the lease did not survive the refusal": the next invocation
    // must not find this one still holding it.
    const after = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-0002', blockId: BLOCK_ID },
      { now: () => new Date().toISOString() },
    );
    expect(after.ok).toBe(true);
    if (after.ok) releaseRepositoryExecutionLease(after.evidence);
  }, 600_000);

  it('drives a block end to end and exits on its reason', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    const seams = drivingSeams();

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001', 'B-001',
        '--run', RUN_ID,
        '--attended',
      ],
      { authPreflight: authPreflightPasses, agent: seams.agent, verify: seams.verify },
    );

    expect(process.exitCode).toBe(EXIT_RUN_OK);
    expect(onDisk(fixture.root)['stopReason']).toBe('COMPLETE');
    expect(stdout.join('')).toContain('COMPLETE');
  }, 900_000);
});
```

This suite needs the `stdout` capture the attended-CLI suite already uses — copy the `beforeEach`/`afterEach` block from `tests/v2-05-attended-cli.test.ts:60-80`, including the `process.exitCode = undefined` reset, which a fully passing run needs or vitest inherits the command's exit code.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: FAIL — neither CLI module exists and `exitCodeForBlockRun` is not exported.

- [ ] **Step 3: Add the exit-code tables**

Append to `src/cli/run-exit-codes.ts`:

```ts
/**
 * What a block run exits with (V2-08).
 *
 * Two tables rather than one, because a block run ends in two different ways
 * and only one of them has a reason. `BLOCK_RUN_ENDED` is graded by the reason
 * the ledger carries; the other four outcomes are graded on their own, and both
 * tables are total by `satisfies`, so a new reason or a new outcome fails the
 * build here until somebody decides what an operator should do about it.
 *
 * Three judgements worth stating:
 *
 * `NO_ELIGIBLE_TASK` is 2, matching `PLAN_EXIT_CODES` above. The same fact
 * learned on the way to executing is still the same fact.
 *
 * `DURABLE_WRITE_FAILED` and `RECONCILIATION_UNRESOLVED` are 3 while the other
 * two unrecorded outcomes are 4. Code 4 says "nothing durable is wrong, and
 * re-invoking under other conditions can differ", which is true of a lease
 * somebody else holds and of a gate that was not satisfied. It is not true of a
 * disk or a permission that refused a write — an operator has to go and fix
 * something, and a scheduler told 4 would retry into the same refusal forever —
 * and it is not true of a reconciliation the authoritative primitive refused
 * either: task state moved under a held execution lease, which is a fact about
 * this repository that another invocation will meet again.
 *
 * `ACTIVE_TASK_UNRESOLVED` is 3 rather than 5. The run is over — a stop reason
 * is written once — so "call again" would be advice that cannot be taken.
 *
 * Nothing here exits 5 at all, and that is the lifetime decision showing
 * through: a block run does not outlive its invocation, so there is no state in
 * which calling again continues anything. `EXIT_RUN_CALL_AGAIN` stays what it
 * is — `run --attended`'s answer for one task — and `block` simply never
 * produces it.
 */
const BLOCK_STOP_EXIT_CODES = Object.freeze({
  COMPLETE: EXIT_RUN_OK,
  TASK_BLOCKED: EXIT_RUN_NEEDS_OPERATOR,
  TASK_ABANDONED: EXIT_RUN_NEEDS_OPERATOR,
  NO_ELIGIBLE_TASK: EXIT_RUN_INPUT_UNUSABLE,
  OPERATOR_STOPPED: EXIT_RUN_REFUSED,
  LEDGER_DIVERGED: EXIT_RUN_NEEDS_OPERATOR,
  STATE_UNUSABLE: EXIT_RUN_NEEDS_OPERATOR,
  DEFINITION_DRIFTED: EXIT_RUN_NEEDS_OPERATOR,
  ACTIVE_TASK_UNRESOLVED: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<BlockStopReason, CliExitCode>;

const BLOCK_OUTCOME_EXIT_CODES = Object.freeze({
  LEASE_AUTHORITY_UNCERTAIN: EXIT_RUN_REFUSED,
  DURABLE_WRITE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  RUN_GATE_REFUSED: EXIT_RUN_REFUSED,
  RECONCILIATION_UNRESOLVED: EXIT_RUN_NEEDS_OPERATOR,
}) satisfies Record<Exclude<BlockRunOutcome, 'BLOCK_RUN_ENDED'>, CliExitCode>;

export function exitCodeForBlockRun(result: AttendedBlockResult): CliExitCode {
  if (result.outcome !== 'BLOCK_RUN_ENDED') return BLOCK_OUTCOME_EXIT_CODES[result.outcome];
  // `BLOCK_RUN_ENDED` carries a reason by construction — `RunState.stop` is the
  // only producer and it always names one. A missing reason would be this
  // module's own defect rather than a run outcome, so it exits 1.
  return result.stopReason === null ? EXIT_RUN_UNEXPECTED : BLOCK_STOP_EXIT_CODES[result.stopReason];
}
```

with the type-only imports it needs:

```ts
import type { BlockStopReason } from '../block/block-ledger.js';
import type { AttendedBlockResult, BlockRunOutcome } from '../block/block-runner.js';
```

- [ ] **Step 4: Write the report**

Create `src/cli/render-block-run.ts`, in the shape `render-attended-run.ts` already uses: two `Record<…, string>` sentence tables typed against the vocabularies (so a new member fails the build here), and one `renderBlockRun(repository, result)` that prints

```
Repository   : <root>
Block        : <blockId>   run <runId>
Outcome      : <outcome>   [reason <stopReason>]   [detail <detail>]
  <the sentence for whichever of the two names the ending>

Tasks
  A-001  SETTLED   TASK_COMPLETED
  B-001  BLOCKED   SCOPE_VIOLATION
  C-001  PLANNED   -

Steps        : <n>
```

Three rules for the sentences, each of which a test above pins:

1. every outcome and every reason gets its own, and no two are equal — four unrecorded outcomes that read alike are four outcomes an operator cannot act on differently, which is the whole reason they are four rather than one generic `RUN_UNSAFE`;
2. the unrecorded ones say **that the ending was not recorded and the ledger stands at its last durable state** — never that nothing was written. All four are reachable after tasks have been settled in this run, and an operator told "nothing was written" would go looking for a record that is there, or ignore one that is. The report is where the ending lives, and the sentence has to say so: *"the run ended here and the ledger does not carry that ending; what it does carry is every task outcome recorded before this point."* Whether a ledger exists at all is a fact about the individual run, and the report shows it by listing what the ledger holds — not by a sentence attached to the outcome.
3. no path, no exception message, no untrusted text (AO-002). The detail is an allow-listed code from another module's closed vocabulary and is printed as one.

Rule 2 is why the task table in the report is not decoration. For three of the
four unrecorded outcomes the ledger is the authority on what happened *up to* the
condition and silent about the condition itself, so the report is the only place
the two are visible together.

- [ ] **Step 5: Write the command**

Create `src/cli/block-command.ts`. It is the same two-mode shape as `run-command.ts`, and the ordering below is the contract:

```ts
/**
 * `agent-loop block` — run a block of independent tasks, attended.
 *
 * ── Two modes, and the default is still read-only ──────────────────────────
 *
 * Without `--attended` this command *freezes and reports*: it resolves the
 * repository, projects the dependency relation, and prints what a run would be
 * started against — including whether the members are established as
 * independent, which is the property the whole slice turns on. It starts no
 * agent, writes no ledger and prepares no workspace.
 *
 * ── Where the plan is frozen, and why it is here ───────────────────────────
 *
 * This is the one place `projectBlockDependencies` is called, and the one place
 * `planNextTask` is called for a block run. The runner computes neither — see
 * its module header — so freezing is the caller's job, and doing it here means
 * the roadmap is read once and everything downstream consults that reading: the
 * projection, the definition's fingerprint, the eligibility filter, and each
 * task's own start gate.
 *
 * ── The order, and why the lease comes first ───────────────────────────────
 *
 *   attended:  resolve → **lease** → plan → project → define → run → release
 *   default:   resolve → plan → project → define → report   (no lease, no writes)
 *
 * An earlier draft froze the plan before taking the lease, which left a window
 * in which a legitimate other writer could edit the roadmap between the reading
 * the block was frozen from and the moment this invocation became the writer —
 * a frozen plan that was never authoritative. `run-command.ts:205` already takes
 * the lease before it selects a task, for the same reason.
 *
 * The cost is that an unusable `--tasks` argument — a member the repository does
 * not declare — is now refused while the lease is held, for the few milliseconds
 * it takes to plan and project. Accepted: `finally` gives the lease back on
 * every path including a throw, and the alternative is freezing a plan on
 * authority this invocation did not yet have. Argument checks that need no
 * repository at all still happen above the lease line.
 *
 * Without `--attended` nothing is taken at all. The report is a report; a
 * command that wrote nothing and drove nothing has no claim on the repository's
 * turn as writer, and the snapshot it prints authorises nothing.
 */
```

The action body:

```ts
const resolution = await resolveRepository({ repositoryPath: options.repository });
// ... the same refusal shape run-command.ts uses, exit EXIT_RUN_INPUT_UNUSABLE

// The read-only mode. It takes no lease, so it freezes nothing that authorises
// anything — the plan it prints is a description of what a run *would* be
// started against, and the run that starts takes its own reading under its own
// lease.
if (options.attended !== true) {
  process.exitCode = reportFrozenPlan(repository, options);
  return;
}

const acquired = acquireRepositoryExecutionLease(repository, { runId: options.run, blockId: options.block }, { now: () => new Date().toISOString() });
if (!acquired.ok) {
  process.stdout.write(renderLeaseRefusal(acquired.code));
  process.exitCode = EXIT_RUN_REFUSED;
  return;
}
try {
  // Everything below is under the lease, including the input refusals. A plan
  // frozen before this line could be edited by a legitimate writer between the
  // reading and the acquisition, and this invocation would then run a block
  // frozen on a roadmap it was never the writer of.
  const planned = planNextTask(repository);
  if (!planned.ok) { /* print planned.code + planned.detail; exit EXIT_RUN_INPUT_UNUSABLE; return */ }

  const projected = projectBlockDependencies(planned.graph, options.tasks);
  if (!projected.ok) { /* print projected.code and projected.taskId; exit EXIT_RUN_INPUT_UNUSABLE; return */ }

  const defined = defineBlock(options.block, options.tasks, projected.dependencies);
  if (!defined.ok) { /* print defined.code; exit EXIT_RUN_INPUT_UNUSABLE; return */ }

  const result = await runAttendedBlock(
    {
      repository,
      definition: defined.definition,
      runId: options.run,
      lease: acquired.evidence,
      maxStepsPerTask: maxSteps,
      // The same `planned` the projection came from — handed on whole, so the
      // frozen relation, the eligibility filter and every task's start gate are
      // one reading of the roadmap at one instant, taken under this lease.
      planning: planned,
    },
    {
      now: () => new Date().toISOString(),
      git: runGitCommand,
      authPreflight: onceOnlyPreflight(seams.authPreflight),
      ...(seams.agent !== undefined ? { agent: seams.agent } : {}),
      ...(seams.verify !== undefined ? { verify: seams.verify } : {}),
    },
  );
  process.stdout.write(renderBlockRun(repository, result));
  process.exitCode = exitCodeForBlockRun(result);
} finally {
  // Released on every path out, including a throw and including the input
  // refusals above. The lease is taken once for the whole block run and given
  // back once — never per task, which would leave a window between tasks that a
  // second writer fits into perfectly.
  releaseRepositoryExecutionLease(acquired.evidence);
}
```

`reportFrozenPlan` is the read-only half, factored out so the two modes cannot
share a planning read by accident: it plans, projects, defines and prints, and
the value it prints never reaches `runAttendedBlock`. Two readings in one
invocation would be one reading too many, and the way to make that impossible is
for the read-only path to keep nothing.

`onceOnlyPreflight` is the memoising helper `run-command.ts:148` already owns. **Export it from there and import it** rather than writing a second one: two memoising preflights are two chances for one invocation to start the subscription CLIs twice.

Options: `--repository <path>` (required), `--block <id>` (required), `--tasks <ids...>` (required, variadic), `--run <id>` (required), `--attended`, `--max-steps <n>` defaulting to `DEFAULT_MAX_STEPS`. `--run` is required and never generated: a run id the tool invented would be a run an operator cannot name back when they want to continue it.

- [ ] **Step 6: Register it**

In `src/cli/index.ts`, add `import { registerBlockCommand } from './block-command.js';` and `registerBlockCommand(program);` after `registerRunCommand(program);`.

In `DESCRIPTION`, add to the ships list:

```
'  - attended execution of a block of independent tasks: `block --attended`',
```

and replace the closing line

```
'Unattended running, multi-task blocks and opening pull requests are not in',
'this build.',
```

with

```
'A block runs attended and sequentially: one lease for the whole run, one active',
'task at a time, and a task that fails locally is recorded and does not end the',
'run — provided the frozen plan establishes that the members are independent.',
'Dependent execution, unattended running and opening pull requests are not in',
'this build.',
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts tests/v2-05-attended-cli.test.ts tests/run-command.test.ts`
Expected: PASS. `run-command.test.ts` is included because Step 5 exports a helper from that module; if it fails, the export changed something it should not have.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/cli tests/v2-08-attended-block-runner.test.ts
git commit
```

Message:

```
feat: agent-loop block, the attended block runner's front door (V2-08)

Two modes, and the default is still read-only: without --attended the command
freezes a plan and reports it, including whether the members are established as
independent, and writes nothing and takes no lease.

This is the one place the dependency relation is projected and the one place a
block run reads the roadmap. The runner computes neither, so both are the
caller's job, and the same planNextTask result becomes the projection, the
fingerprint, the eligibility filter and every task's start gate.

The lease is taken before the plan is read, not after the input refusals - which
is where run-command.ts:205 already takes it. A plan frozen ahead of the
acquisition can be edited by a legitimate writer in between, and this invocation
would then run a block frozen on a roadmap it was never the writer of. The cost
is a few milliseconds of lease held over a refused --tasks argument; the finally
gives it back on every path, including a throw.

Two exit tables, both total. DURABLE_WRITE_FAILED and RECONCILIATION_UNRESOLVED
exit 3 while the other two unrecorded outcomes exit 4 - code 4 says nothing
durable is wrong and re-invoking can differ, which is true of a lease somebody
else holds and false of a disk that refused a write or of task state moving
under a held lease.
```

---

### Task 12: The record, and the canonical gate

**Files:**
- Modify: `README.md` (the "Not implemented yet" roadmap at ~4215; a new V2-08 section; the follow-up register)
- Modify: `docs/superpowers/specs/2026-08-14-v2-08-attended-block-runner-design.md` (the status line, and the three places the plan narrowed or corrected the design — §5, §6, §7)

- [ ] **Step 1: Write the V2-08 section**

Add a `## The attended block runner (V2-08)` section to `README.md`, after the V2-07P material and before "Not implemented yet". It must state, in the repository's own voice:

- **the two classes of bad news**, and that confusing them is the defect the design exists to prevent — with the worked example (`A = BLOCKED`, `B` and `C` `SETTLED`, ending `TASK_BLOCKED`, and *not* `COMPLETE`);
- **why continuing is safe here and only here**: every continuation is still gated by the same proof, so a failed A cannot make a false claim about B possible;
- **the policy V2-07 documented and this slice reversed**, named as a reversal;
- **that a `stopReason` is itself a durable claim**, which is why lease uncertainty, a failed durable write, a refused gate and an unconfirmed reconciliation are runner outcomes rather than reasons, and why the ledger is left byte-identical **across** each of them — stated in that form, not as "nothing was written", because all four are reachable after this run has already recorded task outcomes that are true and stay;
- **one reading of the roadmap, taken under the lease**, consulted by the projection, the fingerprint, the eligibility filter and every task's start gate — and why `startPlannedTask` had to exist for that to be true rather than asserted: the runner imports no planner, but the primitive it started tasks with did;
- **`ACTIVE_TASK_UNRESOLVED`**, and why it is not `STATE_UNUSABLE`;
- **the frozen dependency relation**: that `BlockDefinition` could not previously express independence at all, that the relation is the *transitive projection* over the whole normalised DAG, and the `A ← X ← B` case that makes a direct intra-block check unsound;
- **cause beats consequence** for the end reason, and what `NO_ELIGIBLE_TASK` is now reserved for;
- **schema version 2 and the refusal of version 1**, with no migration;
- **a block run's lifetime is its invocation's lifetime**, and why: the lease
  guarantee is stated over a whole block run, so a run that outlived its holder
  would need either a lease left behind or a later process adopting a run it
  never started. One run id, one invocation, one lease — and the driver's step
  budget is absorbed rather than allowed to end the invocation;
- **the scope lines**: attended only, sequential only, no commit chain, no dependency scheduler, no new platform or ownership surface.

- [ ] **Step 2: Record what this slice carried forward**

Add a `### Carried forward from V2-08, deliberately` block to the follow-up register (the "Carried forward, deliberately" convention at `README.md:2961` and `README.md:3645`):

- **F-B1 — an attended invocation acts on one snapshot of the roadmap.** One
  `planNextTask` result, taken under the lease, is the projection, the
  fingerprint, the eligibility filter and every task's start gate. So a roadmap
  edited while the invocation is in flight changes nothing about it in either
  direction: it cannot stop a member that was eligible when the operator asked,
  and it cannot make one runnable that was not. Accepted deliberately — the
  alternative is a run whose authority a mid-run edit can move, and the version
  of that which re-derives the relation is the inversion the whole slice exists
  to prevent. There is no drift check to notice the edit either, because with no
  resume there is no persisted predecessor to compare against. The edit is seen
  by the next invocation.

  What this cost, and it is worth naming: `startTask` read the plan itself, so
  the property was false one layer below a runner that looked correct. Closed by
  splitting the start path (Task 6B) rather than by documenting the exception.
- **F-B2 — `independenceIsEstablished` is all-or-nothing.** A block with any
  frozen edge degrades to V2-07's behaviour — stop at the first task-local
  failure — even where the remaining members happen to be mutually independent.
  Accepted: the finer answer is a dependency scheduler, and V2-09 owns it.
- **F-B3 — two persisted reasons have no producer in this runner.**
  `OPERATOR_STOPPED` has none because the runner installs no signal handling.
  `DEFINITION_DRIFTED` has none because a block run does not outlive its
  invocation, so there is never a persisted predecessor whose fingerprint could
  differ from the plan just frozen; `reconcileBlockRun` still reports drift to a
  caller that supplies a definition. Both stay in the vocabulary and stay graded
  in the exit table. Either a later slice gives them producers or the members are
  withdrawn — neither is treated as reachable in the meantime, and the suite says
  so in a list rather than by omission.
- **F-B4 — a member blocked only by a non-member ends the run
  `NO_ELIGIBLE_TASK`.** The frozen relation deliberately records nothing about
  non-members, so a block can be frozen while that member can never become
  eligible. The honest dead end rather than a defect, and the reason it is
  reserved rather than generic.
- **F-B5 — an interrupted invocation leaves a run nothing can continue.** A
  crashed or killed attended invocation leaves an open ledger, possibly with an
  `ACTIVE` entry, and no later invocation may adopt it: the run id is spent and
  `startBlockRun` refuses it. Accepted as the fail-closed side of the lifetime
  decision — the record still says what happened and which task was in flight,
  and `release --attended` still handles the workspace that task left behind.
  What is *not* offered is a continuation, because offering one would mean a
  durable run outliving the lease that authorised it.

- [ ] **Step 3: Update the roadmap**

In `README.md:4217`, replace

```
Still missing, deliberately: block execution (V2-08); the dependent commit chain
```

with

```
Still missing, deliberately: the dependent commit chain
```

and mark V2-08 shipped in the diagram at line ~4234, in the shape V2-07L already uses (`<- shipped`).

Leave the paragraph about unattended running and owned process containment exactly as it is. V2-08 needed none of it, which is the point of being attended, and editing it would suggest the boundary moved.

- [ ] **Step 4: Record where the plan narrowed the design**

The design's shape sketch (§5) reads `start or resume the block run ledger`.
This plan removed the resume, because the lease guarantee stated at
`README.md:3789` — one lease across a whole block run — cannot hold for a run
that outlives the invocation holding it. Add a short note to the design spec
under §5 saying so, and pointing at "The contradiction this plan had to resolve"
in the plan:

```
**Narrowed while planning.** "start or resume" became "start". A block run's
lifetime is its invocation's lifetime: the lease guarantee is stated over a
whole block run, so a resumable run would need a lease left behind — the
stale-lease surface this slice may not reopen — or a later process adopting a
run it never started. The driver's step budget is absorbed inside the
invocation instead of ending it.
```

A design a plan quietly departed from is a design that stops describing the
build. Written into the spec, not only into the plan, because the spec is what a
later slice will read first.

The same rule applies to the two places the plan review moved the design, so add
these as well — §7's ordering and §6's "Three runner outcomes" heading:

```
**Corrected while planning.** The order is `resolve → lease → plan → project →
define → run → release`. Freezing the plan before taking the lease left a window
in which another writer could edit the roadmap between the reading the block was
frozen from and the moment this invocation became the writer, so the frozen plan
was never authoritative. And the freeze reaches further down than "the runner
imports no planner": `startTask` read the plan itself, so a mid-run edit could
still refuse a task the snapshot had authorised. `startPlannedTask` takes the
frozen reading; the runner uses only that path.
```

```
**Four, not three.** `RECONCILIATION_UNRESOLVED` joined them: a positive
reconciliation that read as forced and was refused by the authoritative
primitive at the commit is a proof race, not a failed write, and reporting it as
`DURABLE_WRITE_FAILED` would send an operator to a working disk. It is not
persisted, so it needed no schema change.

The section's own sentence — *the ledger stays at its last provably durable
state* — is the exact one, and it is weaker than "nothing was written". All four
are reachable after tasks have been recorded in this run; those records are true
and they stay. What none of them adds is a stop claim.
```

- [ ] **Step 5: Mark the design closed**

In the design spec, change the status line from

```
**Status:** design, not yet planned into tasks.
```

to

```
**Status:** planned and implemented. Plan: `docs/superpowers/plans/2026-08-14-v2-08-attended-block-runner.md`.
```

- [ ] **Step 6: Run the canonical gate**

Run: `npm run verify`
Expected: PASS, end to end. This is the gate `CLAUDE.md` calls canonical — schema generation, typecheck, build, four dist-artefact harnesses, the in-process suite and the serial tree-kill probe. Nothing in this slice touches the dist harnesses, so a failure there is a regression rather than an expected consequence.

If the block cases make the in-process suite meaningfully slower, say so with the measured before/after rather than trimming a case.

- [ ] **Step 7: Commit and open the pull request**

```bash
git add README.md docs/superpowers/specs/2026-08-14-v2-08-attended-block-runner-design.md
git commit
git push -u origin feat/v2-08-attended-block-runner
gh pr create --base main --title "V2-08: the attended block runner" --body-file -
```

Commit message:

```
docs: what V2-08 decided, and what it carried forward (V2-08)

The two classes of bad news and why confusing them is the defect; the V2-07
policy this slice reversed, named as a reversal; and the insight that reshaped
the design - a ledger stopReason is itself a durable claim, so a condition
asserting that the run cannot make durable claims must not be represented as
one. Four outcomes are therefore reported rather than recorded, and the ledger
is left byte-identical across each of them, which is not the same as nothing
having been written: all four can strike after task outcomes this run recorded,
and those stay.

Five items carried forward as decisions rather than defects, the first two of
them costs of rules the slice chose deliberately: an invocation acts on one
reading of the roadmap, taken under its lease, so a mid-run edit changes nothing
about it in either direction and no drift check exists to notice - with no
resume there is no persisted predecessor to compare against; and independence is
all-or-nothing, because the finer answer is the dependency scheduler V2-09 owns.
```

The pull request body should carry the same five carried-forward items and the control map below, so a reviewer can check the claims against the cases without reading the plan.

**Then follow the delivery policy in `CLAUDE.md`:** `PR_REQUIRED` + `CI_REQUIRED`. Wait for CI. A pull request showing **zero** checks is a defect in the delivery setup, not permission to merge — classify the checks into `NO_CHECKS` / `PENDING` / `FAILED` / `SUCCESS` with `gh pr checks --json name,bucket,state` and `gh pr view --json statusCheckRollup`, and merge only on `SUCCESS`.

---

## Control coverage

Design §8, mapped onto the tasks that pin it. A reviewer checking this plan
against the design should be able to walk this table and find a case for every
row.

| Design control | Task |
| --- | --- |
| 1. a task-local failure does not stop the run | 5 (primitive), 8 → *"does not stop when one task fails locally"* in Task 7 |
| 2. a class-2 condition stops immediately, with tasks still eligible | 8 (every case drives its condition between two tasks) |
| 3. each class-2 condition, separately | 8, for every reason this runner can produce; `DEFINITION_DRIFTED` and `OPERATOR_STOPPED` have no producer and are named in a list rather than covered (F-B3) |
| 3a. the unrecorded outcomes leave the ledger byte-identical **across** the condition | 8 (lease, and the post-open gate refusal over a ledger holding a settled task), 9 (durable write), 10 (`RECONCILIATION_UNRESOLVED`) |
| 3b. `ACTIVE_TASK_UNRESOLVED` coexists with an unchanged `ACTIVE` | 4 (primitive), 8 (runner) |
| 3c. the end reason names the cause, not the consequence | 6 (both halves of the pair), 7 |
| 3d. reconciliation refuses where a choice would be required | 10 |
| 3e. the fingerprint binds the dependency relation | 1 |
| 3f. a transitive dependency through a non-member defeats independence | 2 (projection), 7 (run behaviour) |
| 4. the block is not `COMPLETE` when a task is `BLOCKED`, asserted on the persisted ledger | 7 |
| 5. no continuation without established independence | 7 |
| 6. one lease for the whole run, measured by effect | 7 |
| 7. a class-2 stop is writable over an unsupported ledger | 4 |
| 8. the reversed policy's documentation | 5 (`git grep`, against the tree) |

Three rows the lifetime decision added, which design §8 did not ask for because
the contradiction had not surfaced when it was written: the driver's budget is
absorbed rather than ending the invocation (Task 7), a run id is used once
(Task 7), and an invocation acts on one snapshot of the roadmap (Task 7, and —
after the plan review — Tasks 6B and 11, which is what makes that third row
true rather than asserted; see the table below).

Four rows the plan review added, for the same reason — each is a claim the plan
made that nothing in it would have caught:

| Control | Task |
| --- | --- |
| the frozen snapshot survives a start, not only the runner's own loop | 6B (both directions at the start path), 7 (the mid-run-edit case, which fails `RUN_GATE_REFUSED` against a start path that re-plans) |
| the plan is read once, **under** the lease | 11 (order, and the input refusal that now happens under it and gives the lease back) |
| an unrecorded outcome met *after* the ledger exists adds no stop claim | 8 (`RUN_GATE_REFUSED` post-open, bytes anchored at the last landed write) |
| a forced reconciliation the primitive refused is not a failed write | 10 (`RECONCILIATION_UNRESOLVED`) |

Two constraints the design attached to the schema change, and where they live:
the sorting of the new reason is a **correctness** test in Task 4, and the
"writable over an unsupported ledger" obligation is the effect case in the same
task. The four control points the design's decisions turned on — freeze-time
projection only, one persisted truth, external-only blockers kept apart from
independence, and an explicit load contract for old documents — are Global
Constraints rather than prose inside a task, and are pinned by Tasks 2, 3, 7 and
3 respectively.

### Corrected during execution

Executing this plan found **eleven instruments that would have passed without
exercising what they named**. Every one was found by mutation or by
implementation; none was found by reading the case.

- a `git grep` control defeated by the sentence it searched for being
  word-wrapped across two comment lines (5);
- a start-path fixture refused by `SOURCE_WORKTREE_DIRTY` at step 5, well past
  the eligibility gate it was written for, so it failed identically against a
  correct and an incorrect implementation (6B);
- design §8.5's case, whose member was ineligible in the frozen reading, so
  `chooseTask` skipped it for a reason unrelated to independence and the gate was
  never consulted (7);
- a byte anchor captured after every write, so a write it should have detected
  moved the anchor with it; what killed the mutant was the anchor's `stopReason`,
  not its bytes (8);
- a guard the brief claimed case 3 provided, whose fixture reaches only the
  pre-ledger write — no fallback stop write is constructible there, so the
  property was pinned by nothing (9);
- two reconciliation cases whose end state was identical whether the task was
  recognised or simply driven; only the per-task driver answer and the agent
  seam's call count discriminate (10);
- the `WRITE_FAILED` arm of `applyForcedProgress`, which collapsing into the
  `UNRESOLVED` arm reddened nothing (10);
- a `STATE_UNUSABLE` grade argued unreachable and withdrawn: a settled sibling
  whose record cannot be read refuses the write on a task the reconciliation
  never touched (10, after review);
- the runner's own header naming `planNextTask` in prose, which turned the
  zero-match grep meant to check it into a list a reader has to adjudicate (11);
- a path-scoped import scan defeated by a re-export laundering the planner
  through `src/run/`, naming no planner path under `src/block/` at all (11,
  after review).

For whoever plans V2-09: **a control's reachability must be proved separately
from its assertion, and only mutation does both at once.** A green case says
nothing about whether its fixture can reach the branch it names, and the two
questions are answered by different evidence.

And the sharpest case says why killing the mutant is not the whole bar. The first
path-scoped planner classifier was green on the tree *and* red on its
value-import mutant — the conventional standard, met — and was still wrong: a
forward window from the keyword read any nearby export as the declaration, so a
legitimate `import type` registered as a value reach. No amount of asking "does
the mutant die" reaches that. It was caught by driving the false-positive
direction, which is why both directions are required rather than one.

## Execution

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration.
2. **Inline Execution** — executed in this session with checkpoints for review.
