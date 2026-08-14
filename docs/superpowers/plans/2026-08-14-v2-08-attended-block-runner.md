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
- **One schema bump for the whole slice.** `BLOCK_LEDGER_SCHEMA_VERSION: 1 → 2`, once, covering both `frozenDependencies` and `ACTIVE_TASK_UNRESOLVED`. A version-1 document is **refused, never migrated**, under its own load code.
- **Three runner outcomes write nothing.** `LEASE_AUTHORITY_UNCERTAIN`, `DURABLE_WRITE_FAILED` and `RUN_GATE_REFUSED` leave the ledger byte-identical and reach the operator through the report. No best-effort stop write on any of the three.
- **`ACTIVE_TASK_UNRESOLVED` stays out of `PROGRESS_CLAIMING_STOP_REASONS`,** and the sorting is pinned by a hand-written correctness test plus an effect test (it must be writable over a ledger whose entries are not supported).
- **V2-08 opens no new platform, ownership or recovery surface.** No unattended mode, no stale-lease recovery, no process containment, no parallel task execution, no commit chain, no outgoing transition from `READY_FOR_PR`.
- Repository delivery policy is `PR_REQUIRED` + `CI_REQUIRED` (`CLAUDE.md`). Never commit to `main`. The branch is `feat/v2-08-attended-block-runner`, which already exists and already carries the three design commits.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BaE9b5RWjuCCPZqapWPSXK
  ```
- Run `npm run typecheck` before every commit. The canonical gate is `npm run verify`; run it at Task 12 and before opening the PR.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/block/block-definition.ts` *(modify)* | `FrozenTaskDependency`; `BlockDefinition.dependencies`; canonicalisation in `defineBlock`; the fingerprint over all three parts. |
| `src/block/block-dependencies.ts` *(create)* | The transitive projection over the whole normalised DAG, restricted to members. Freeze time only. |
| `src/block/block-ledger.ts` *(modify)* | Schema version 2; `frozenDependencies` and its invariants; `ACTIVE_TASK_UNRESOLVED`; `FIELD_AUTHORITY` classification; the reversed `TASK_DISPOSITIONS` prose. |
| `src/block/block-store.ts` *(modify)* | `LEDGER_SCHEMA_UNSUPPORTED` on load; a predecessor-version detail on update. |
| `src/block/block-progress.ts` *(modify)* | `startBlockRun` freezes the relation; `parkBlockTask` stops writing a stop reason. |
| `src/block/block-conclusion.ts` *(create)* | Pure: run outcome → what may be recorded; progress outcome → recorded/unresolved/write-failed; the end-reason table; the independence question. |
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
 * ledger, never on an in-memory value; a no-write outcome is asserted by
 * comparing the file byte for byte; and the independence cases include the one
 * shape a direct intra-block edge check cannot see.
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

- [ ] **Step 7: Commit**

```bash
git add src/block/block-definition.ts tests/v2-08-attended-block-runner.test.ts
git commit
```

Message:

```
feat: the frozen block plan carries its dependency relation (V2-08)

BlockDefinition was blockId plus taskIds, and the fingerprint covered exactly
those, so V2-08 could not prove independence from its own authoritative input
and continue-on-task-local-failure would have been dead code in every block.

The relation is frozen as evidence rather than as an `independent: true`
judgement: a flag would freeze the conclusion while leaving what it came from
free to move. It is bound into the fingerprint, so an edge added or removed
under a running block is drift rather than a silent change of authority — the
canonical encoding needs three separators rather than one, because with a
single separator {A:[B],B:[]} and {A:[],B:[A]} are permutations of one token
list.

Five failure codes rather than one: a missing row, a row for a stranger, two
rows for one member, an edge to a non-member and a self-edge are five different
mistakes with five different fixes.

This commit deliberately leaves `npm run typecheck` failing at the three call
sites that build or re-derive a fingerprint. Patching them with an empty
relation would default to "everything is independent", which is the claim this
slice exists to stop assuming.
```

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

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS.

`npm run typecheck` still fails at the three Task 3 call sites. That is expected and is not this task's to fix.

- [ ] **Step 5: Commit**

```bash
git add src/block/block-dependencies.ts tests/v2-08-attended-block-runner.test.ts
git commit
```

Message:

```
feat: project the block's dependency relation transitively (V2-08)

Measured against task-graph.ts: normalizeTaskGraph stores each definition's own
edge list and its direct reverse and computes no transitive closure anywhere,
over the whole discovered task set. A block is an arbitrary subset of that DAG,
so A <- X <- B with X outside the block has no intra-block edge while B still
depends on A. The walk therefore goes up the whole graph and restricts to
members at the end.

An unknown member is refused rather than projected as an empty row: "independent
of everything" is the worst possible answer about a task nobody can find.

Called at freeze time and nowhere else. The runner must never import this
module; a run that recomputed the relation would take its continuation
authority from a roadmap an operator can edit mid-run.
```

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

- [ ] **Step 10: Commit**

```bash
git add src/block tests/v2-07-block-ledger.test.ts tests/v2-07-remediation.test.ts tests/v2-08-attended-block-runner.test.ts
git commit
```

Message:

```
feat: ledger schema 2 - the frozen relation, and no migration (V2-08)

frozenDependencies is the single persisted image of the relation. No dependents
copy sits beside it: two spellings of one fact are two facts that can disagree,
and the one a continuation decision reads would be whichever the caller looked
at. It is classified FROZEN_PLAN in FIELD_AUTHORITY, so succession refuses an
edit to it by derivation rather than by a new rule, and planFingerprint is
re-derived from all three parts on every create, update and load.

A version-1 document is refused under LEDGER_SCHEMA_UNSUPPORTED and never
migrated. It carries no relation, and the only way to give it one is to invent
it - handing the run authority to continue after a task-local failure on a
relation nobody froze. Refusing costs an operator one new run id.

One bump for the slice, covering this field and the stop reason that follows.
A version-1 reader genuinely cannot read a version-2 document, so "the enum
grew but the version stayed" was not available.
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
    // Durable progress happened and the budget ran out: the one outcome that
    // means "call again", and the one that must NOT end the block run — a stop
    // is final, and writing one here would make the work unresumable.
    STEP_BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
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
   * Durable progress was made and the invocation's step budget ran out.
   *
   * Deliberately **not** an ending. A stop reason is written once and a stopped
   * run has no successor but itself, so recording one here would make work that
   * is merely unfinished permanently unresumable. The invocation ends; the run
   * stays open; the operator calls again.
   */
  'BUDGET_EXHAUSTED',
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

  STEP_BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',

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

Two grades are worth naming. STEP_BUDGET_EXHAUSTED is not an ending: a stop
reason is written once and a stopped run has no successor but itself, so
recording one would make merely-unfinished work permanently unresumable. And
independence is answered for the whole block rather than per pair, because
"these two are unrelated, run them and skip the rest" is the improvised
scheduling this slice refuses.
```

---

### Task 7: The runner

**Files:**
- Create: `src/block/block-runner.ts`
- Modify: `src/block/block-conclusion.ts` (one map added)
- Modify: `tests/v2-08-attended-block-runner.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6; `startTask`/`StartTaskOutcome`; `runTask`/`RunResult`; `verifyExecutionLeaseHeldFor`; `planNextTask`; `reconcileBlockRun`.
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
    const projected = projectBlockDependencies(
      graphOfRepository(fixture),
      ['A-001', 'B-001'],
    );
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

Add the two helpers this suite now needs:

```ts
import { acquireRepositoryExecutionLease } from '../src/lease/execution-lease.js';
import { planNextTask } from '../src/plan/plan-next-task.js';
import { agentCommandResult } from './fixtures.js';

/** The repository's own normalised graph, for a freeze-time projection. */
function graphOfRepository(fixture: Fixture) {
  const planned = planNextTask(fixture.repository);
  if (!planned.ok) throw new Error(`fixture repository does not plan: ${planned.code}`);
  return planned.graph;
}

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
 *                 which is a run abort and not task progress
 *                 -> the ledger is left on its last provably durable state and
 *                 the truth reaches the operator through the report
 *
 * A runner that funnelled both through `stopBlockRun` would, in exactly the
 * cases where writing is what it cannot do, either fail loudly at the worst
 * moment or emit a claim it had no authority to make.
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
 * One consequence, stated rather than left to be discovered: **drift is checked
 * when an invocation opens a run, and not between tasks.** The caller freezes a
 * definition from the repository as it is now, and a resumed run compares that
 * fingerprint with the persisted one. Inside one invocation nothing re-reads the
 * roadmap, so a mid-run edit is not noticed until the next invocation. That is
 * the cost of the rule above and it is recorded in the follow-up register.
 */

import type { AgentRunner } from '../agent/agent-command.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import { verifyExecutionLeaseHeldFor } from '../lease/execution-lease.js';
import { planNextTask } from '../plan/plan-next-task.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { runTask, type RunOutcome } from '../run/run-driver.js';
import { startTask } from '../run/start-task.js';
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
import { fingerprintBlockDefinition, type BlockDefinition } from './block-definition.js';
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

/** How an attended block run ended. A closed set. */
export const BLOCK_RUN_OUTCOMES = [
  /** The ledger carries the ending. {@link AttendedBlockResult.stopReason} says which. */
  'BLOCK_RUN_ENDED',
  /**
   * Durable progress was made and this invocation's budget ran out.
   *
   * The run stays **open**: no stop reason is written, the ledger says which
   * task is still `ACTIVE`, and a further invocation under the same run id
   * picks it up. The one outcome that means "call again".
   */
  'STEP_BUDGET_EXHAUSTED',
  /** This run may no longer be the repository's writer. Nothing was written. */
  'LEASE_AUTHORITY_UNCERTAIN',
  /** A durable write was not possible. Nothing was written. */
  'DURABLE_WRITE_FAILED',
  /** A repository, auth or runtime gate refused. Nothing was written. */
  'RUN_GATE_REFUSED',
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
   * On a resumed run its fingerprint is compared with the persisted one, and a
   * difference is drift.
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
  /** The bound on durable steps per task, forwarded to `runTask`. */
  readonly maxStepsPerTask: number;
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
  if (opened.kind === 'ENDED' || opened.kind === 'STOPPED') return state.from(opened);
  if (opened.kind === 'DRIFTED') {
    // The plan this invocation froze is not the plan the run was started
    // against. Recordable — the reason claims no progress — so it ends in the
    // ledger, and nothing is driven first.
    state.seen(opened.ledger.ledger);
    return state.stop(opened.ledger, 'DEFINITION_DRIFTED', ledgerOptions);
  }

  let current = opened.ledger;
  state.seen(current.ledger);

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

    const next = chooseTask(current.ledger, repository);
    if (next.kind === 'GATE_REFUSED') return state.gateRefused(next.detail);
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
  | { readonly kind: 'DRIFTED'; readonly ledger: LedgerLoadSuccess }
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

type OpenStep = Extract<RunStep, { kind: 'OPEN' }>;

/**
 * What a helper below returns: the run continues, or it is over.
 *
 * Narrower than `RunStep` by exactly `DRIFTED`, and the difference is
 * load-bearing rather than tidy: drift is answered once, when a run is opened,
 * and a helper that could return it would be a helper able to re-answer it
 * mid-run — which is the authority inversion this module is built to avoid.
 */
type StepResult = OpenStep | FinishedStep;

interface DrivenStep {
  readonly step: StepResult;
  /** The driver's answer, when it got as far as driving. */
  readonly runOutcome: RunOutcome | null;
  readonly steps: number;
}

type TaskChoice =
  | { readonly kind: 'TASK'; readonly taskId: string }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'GATE_REFUSED'; readonly detail: string };

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

  budgetExhausted(): AttendedBlockResult {
    return this.result('STEP_BUDGET_EXHAUSTED', null, null);
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
 * Creates the first ledger of this run, or resumes the one already there.
 *
 * Drift is answered here, and only here. The caller froze a definition from the
 * repository as it is *now*; if a persisted run carries a different fingerprint,
 * the roadmap this run was started against is not the one in front of us. That
 * is recordable — `DEFINITION_DRIFTED` claims no progress — so the caller ends
 * the run in the ledger rather than in the report.
 *
 * A ledger that exists and cannot be *read* ends the run in the report instead:
 * a document this build cannot load is a document it must not write either, so
 * there is nowhere honest to record the condition.
 */
function openRun(
  request: AttendedBlockRequest,
  now: () => string,
  options: BlockProgressOptions,
): RunStep {
  const { repository, definition, runId } = request;

  const loaded = loadBlockLedger(repository.root, runId);
  if (loaded.ok) {
    if (loaded.ledger.stopReason !== null) {
      // A stopped run has no successor but itself. Reported rather than
      // silently restarted: the operator asked to continue a run that is over,
      // and starting a fresh one under their run id would destroy its record.
      return ended('RUN_GATE_REFUSED', 'RUN_ALREADY_STOPPED');
    }
    if (loaded.ledger.planFingerprint !== fingerprintBlockDefinition(definition)) {
      return Object.freeze({ kind: 'DRIFTED' as const, ledger: loaded });
    }
    return Object.freeze({ kind: 'OPEN' as const, ledger: loaded });
  }

  if (loaded.code !== 'LEDGER_MISSING') return ended('RUN_GATE_REFUSED', loaded.code);

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
    // The first durable write of the run. Failing it is exactly the condition
    // `DURABLE_WRITE_FAILED` names, and there is no ledger to record it in.
    return ended('DURABLE_WRITE_FAILED', created.detail === null ? created.code : `${created.code}:${created.detail}`);
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
): StepResult {
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
    if (graded === 'WRITE_FAILED') return ended('DURABLE_WRITE_FAILED', saveDetail(settled));
    if (graded !== 'RECORDED') {
      // The reconciliation looked forced and the primitive disagreed, which
      // means the evidence moved between the two reads. Do not repair, and do
      // not try again: the caller stops the block.
      return ended('DURABLE_WRITE_FAILED', settled.outcome);
    }

    const reloaded = loadBlockLedger(repositoryRoot, ledger.ledger.runId);
    if (!reloaded.ok) return ended('RUN_GATE_REFUSED', reloaded.code);
    ledger = reloaded;
  }
}

/* ───────────────────────────── choosing a task ───────────────────────────── */

/**
 * The next task to drive, or why there is not one.
 *
 * An `ACTIVE` member comes first: that is a resume, and re-driving a task the
 * ledger already holds needs no ledger write at all — which is what lets an
 * interrupted invocation continue under the same run id.
 *
 * Otherwise the candidates are the `PLANNED` members, in frozen order, filtered
 * by the repository's **own** eligibility report. That filter is the
 * external-blocker question and it is deliberately not answered from
 * `frozenDependencies`: a member with no frozen block-member dependency may
 * still be waiting on a non-member, and a runner reading "no frozen edge" as
 * "eligible" would start a task the repository says cannot run.
 */
function chooseTask(ledger: BlockRunLedger, repository: ResolvedRepository): TaskChoice {
  if (ledger.activeTaskId !== null) {
    return Object.freeze({ kind: 'TASK' as const, taskId: ledger.activeTaskId });
  }

  const planned = planNextTask(repository);
  if (!planned.ok) {
    // The repository's plan cannot be read. Not task progress and not something
    // the ledger has a reason for: a run abort, reported with the planner's own
    // code as its detail.
    return Object.freeze({ kind: 'GATE_REFUSED' as const, detail: planned.code });
  }

  const eligible = new Set(
    planned.selection.eligibility.filter((entry) => entry.eligible).map((entry) => entry.taskId),
  );

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

  const start = await startTask(
    { repository, taskId },
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

  // Activation, unless this is a resume of a task the ledger already holds.
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

  const run = await runTask(
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

  const driven = (step: RunStep): DrivenStep => ({ step, runOutcome: run.outcome, steps: run.steps });
  const conclusion = conclusionForRunOutcome(run.outcome);

  if (conclusion === 'LEASE_UNCERTAIN') {
    return driven(ended('LEASE_AUTHORITY_UNCERTAIN', run.outcome));
  }
  if (conclusion === 'BUDGET_EXHAUSTED') {
    // No stop reason. The run stays open on an ACTIVE task, which is what
    // actually happened, and a further invocation continues it.
    return driven(ended('STEP_BUDGET_EXHAUSTED', null));
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
  return { step: Object.freeze({ kind: 'OPEN' as const, ledger: reloaded }), runOutcome: run.outcome, steps: run.steps };
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


- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS. These cases start real worktrees and drive real state machines; the timeouts above are deliberate.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Prove the runner does not compute the relation**

Run: `git grep -n "block-dependencies" -- src/`
Expected: exactly one match, in `src/cli/block-command.ts` once Task 11 lands — and **none** in `src/block/block-runner.ts`. Until then, no match in `src/` at all.

This is the structural form of the rule. It is checked with a grep rather than a test because the property is "this module does not depend on that one", which a runtime assertion cannot see.

- [ ] **Step 7: Commit**

```bash
git add src/block/block-runner.ts src/block/block-conclusion.ts tests/v2-08-attended-block-runner.test.ts
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
expressed as one, so lease uncertainty, a failed durable write and a refused
gate end the run in the report with the ledger left on its last provably
durable state.

Independence is read from the frozen plan and never derived: this module does
not import block-dependencies.ts, and the grep that says so is in the plan. The
cost is stated rather than hidden - drift is answered when an invocation opens
a run, not between tasks, so a mid-run roadmap edit waits for the next
invocation.

The lease is re-proved every iteration. A step is a subprocess that took
minutes, and a lease taken before it is not a lease held after it.
```

---

### Task 8: Each class-2 condition, separately — and the ledger left byte-identical

**Files:**
- Modify: `tests/v2-08-attended-block-runner.test.ts`
- Modify: `src/block/block-runner.ts` (only if a case exposes a wiring defect)

**Interfaces:**
- Consumes: `runAttendedBlock` (Task 7). Produces no new API.

Design §8.3 says it plainly: *one case per reason and per runner outcome*. A shared parametrised case passes against a runner that maps every condition to one reason, which is the misdescription defect in its natural habitat. So the cases below are separate by construction, and each drives its condition **at a point where further tasks are still eligible**, so that "the run stopped" is distinguishable from "the block happened to end".

- [ ] **Step 1: Write the failing tests**

Append to `tests/v2-08-attended-block-runner.test.ts`:

```ts
import { existsSync, rmSync } from 'node:fs';

import { releaseRepositoryExecutionLease, deriveExecutionLeaseLocation } from '../src/lease/execution-lease.js';

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
    },
    {
      now: tickingClock(),
      git: runGitCommand,
      authPreflight: authPreflightPasses,
      agent: agent.runner,
      verify: recordedVerify().runner,
    },
  );
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

  it('DEFINITION_DRIFTED — the frozen plan is not the plan in front of us', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);

    // A second invocation under the same run id, freezing a plan with an edge
    // the first did not have. Same blockId, same taskIds.
    const drifted = defineBlock(BLOCK_ID, ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    if (!drifted.ok) throw new Error('fixture block is not a block');

    const result = await runBlock(fixture, drifted.definition);

    expect(result.stopReason).toBe('DEFINITION_DRIFTED');
    expect(onDisk(fixture.root)['stopReason']).toBe('DEFINITION_DRIFTED');
    // Nothing was driven. Drift is answered before any task is started.
    expect(result.steps).toBe(0);
  }, 600_000);

  it('ACTIVE_TASK_UNRESOLVED — the active task’s outcome cannot be established', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    // A second writer moves the task on while it is being driven, so the
    // driver's own next write meets a revision that is no longer the one it
    // read. `STATE_CONFLICT` is graded UNRESOLVED: nothing was written, the
    // task's outcome is not established, and re-reading and deciding again is
    // exactly how a stale-writer refusal gets laundered.
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

  it('RUN_GATE_REFUSED — auth is not there, and nothing is written', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });

    const result = await runBlock(fixture, independentBlock(['A-001', 'B-001']), {
      authPreflight: authPreflightFails,
    });

    expect(result.outcome).toBe('RUN_GATE_REFUSED');
    expect(result.stopReason).toBeNull();
    expect(result.detail).toBe('AUTH_PREFLIGHT_FAILED');
    // The gate is answered before the first ledger is created, so there is not
    // even a file to be byte-identical with.
    expect(existsSync(ledgerPath(fixture.root))).toBe(false);
  }, 600_000);
});

// Design §8.3a. Asserting "no stop reason was written" is weaker: it passes
// against a run that mutated the ledger some other way.
describe('a no-write outcome leaves the ledger byte-identical', () => {
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

Add the three fixture helpers, each of which produces its condition through a real file rather than a stub:

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

Add `import { renameSync } from 'node:fs';` and `import type { ReplaceFn } from '../src/state/atomic-file.js';`.

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
    startRun(fixture);
    // B-001 reaches READY_FOR_PR outside this run — a real state, driven the
    // way the suite drives every other one.
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

  it('changes nothing when applied twice', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');
    await reallyStart(fixture, 'B-001');
    driveToReadyForPr(fixture, 'B-001');

    // Everything is already finished, so the whole run is one reconciliation.
    const first = await runBlock(fixture);
    expect(first.stopReason).toBe('COMPLETE');
    const after = readFileSync(ledgerPath(fixture.root));

    // A second invocation under the same run id meets a stopped run and
    // refuses; the bytes do not move.
    const second = await runBlock(fixture);
    expect(second.outcome).toBe('RUN_GATE_REFUSED');
    expect(second.detail).toBe('RUN_ALREADY_STOPPED');
    expect(readFileSync(ledgerPath(fixture.root)).equals(after)).toBe(true);
  }, 600_000);

  it('does not repair an ACTIVE task, even when its record looks finished', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [] });
    startRun(fixture);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToReadyForPr(fixture, 'A-001');
    const before = readFileSync(ledgerPath(fixture.root));

    // The task is ACTIVE and its record says READY_FOR_PR. Declaring it settled
    // from a reconciliation would be choosing between "drive it" and "call it
    // done", which is the moment the six conditions stop holding. It is driven
    // instead, and the driver's answer decides.
    const result = await runBlock(fixture);

    const entries = onDisk(fixture.root)['tasks'] as readonly Record<string, unknown>[];
    expect(entries[0]?.['disposition']).toBe('SETTLED');
    // The proof that it was driven rather than reconciled: the run reports a
    // driver outcome for it.
    expect(result.tasks[0]?.runOutcome).toBe('TASK_COMPLETED');
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(false);
  }, 600_000);

  it('stops rather than choosing when the evidence supports no single successor', async () => {
    const fixture = await repoWith({ 'A-001': [], 'B-001': [], 'C-001': [] });
    startRun(fixture, independentBlock(['A-001', 'B-001', 'C-001']));
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
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

Add the state helper (`movedByAnotherWriter` is already in the file from Task 8):

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

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/v2-08-attended-block-runner.test.ts`
Expected: PASS. A failure in the third case — an `ACTIVE` entry settled without a driver outcome — means `applyForcedProgress` is not restricted to `PLANNED` entries, which is the repair-versus-choice line.

Run: `npm run test:foundation-safe`
Expected: PASS.

- [ ] **Step 3: Commit**

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
business, and choosing between "drive it" and "call it done" is a choice. It is
driven, and the driver's answer decides - pinned by asserting that the report
carries a driver outcome for it.

Where the evidence supports no single successor the block stops with
ACTIVE_TASK_UNRESOLVED and invents nothing.
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

  it('grades the three no-write outcomes by what the operator must do', () => {
    // Lease and gate: nothing durable is wrong and re-invoking under other
    // conditions can differ. A failed durable write is not like that — a disk
    // or a permission has to be fixed before anything will ever run.
    expect(code('LEASE_AUTHORITY_UNCERTAIN', null)).toBe(EXIT_RUN_REFUSED);
    expect(code('RUN_GATE_REFUSED', null)).toBe(EXIT_RUN_REFUSED);
    expect(code('DURABLE_WRITE_FAILED', null)).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('is the only outcome that means call again', () => {
    expect(code('STEP_BUDGET_EXHAUSTED', null)).toBe(EXIT_RUN_CALL_AGAIN);
  });
});

describe('every outcome and every reason has its own sentence', () => {
  it('covers the outcome vocabulary, distinctly', () => {
    const sentences = BLOCK_RUN_OUTCOMES.map((outcome) => BLOCK_OUTCOME_SENTENCES[outcome]);
    expect(sentences.every((sentence) => sentence.length > 0)).toBe(true);
    // Distinct, because three no-write outcomes that read alike are three
    // outcomes an operator cannot act on differently — which is the whole
    // reason they are three and not one generic RUN_UNSAFE.
    expect(new Set(sentences).size).toBe(BLOCK_RUN_OUTCOMES.length);
  });

  it('covers the stop-reason vocabulary, distinctly', () => {
    const sentences = BLOCK_STOP_REASONS.map((reason) => BLOCK_STOP_SENTENCES[reason]);
    expect(new Set(sentences).size).toBe(BLOCK_STOP_REASONS.length);
  });

  it('tells an operator which of the three no-write outcomes they met', () => {
    expect(BLOCK_OUTCOME_SENTENCES.LEASE_AUTHORITY_UNCERTAIN).toMatch(/lease|writer/i);
    expect(BLOCK_OUTCOME_SENTENCES.DURABLE_WRITE_FAILED).toMatch(/write|disk|permission/i);
    expect(BLOCK_OUTCOME_SENTENCES.RUN_GATE_REFUSED).toMatch(/gate|refused/i);
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
  }, 600_000);

  it('refuses a member the repository does not declare, before taking a lease', async () => {
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
 * `DURABLE_WRITE_FAILED` is 3 while the other two no-write outcomes are 4. Code
 * 4 says "nothing durable is wrong, and re-invoking under other conditions can
 * differ", which is true of a lease somebody else holds and of a gate that was
 * not satisfied. It is not true of a disk or a permission that refused a write:
 * an operator has to go and fix something, and a scheduler told 4 would retry
 * into the same refusal forever.
 *
 * `ACTIVE_TASK_UNRESOLVED` is 3 rather than 5. The run is over — a stop reason
 * is written once — so "call again" would be advice that cannot be taken.
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
  STEP_BUDGET_EXHAUSTED: EXIT_RUN_CALL_AGAIN,
  LEASE_AUTHORITY_UNCERTAIN: EXIT_RUN_REFUSED,
  DURABLE_WRITE_FAILED: EXIT_RUN_NEEDS_OPERATOR,
  RUN_GATE_REFUSED: EXIT_RUN_REFUSED,
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

1. every outcome and every reason gets its own, and no two are equal — three no-write outcomes that read alike are three outcomes an operator cannot act on differently, which is the whole reason they are three rather than one generic `RUN_UNSAFE`;
2. the no-write ones say **that nothing was written**, because an operator who cannot tell whether the ledger moved will go looking for state that is not there;
3. no path, no exception message, no untrusted text (AO-002). The detail is an allow-listed code from another module's closed vocabulary and is printed as one.

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
 * This is the one place `projectBlockDependencies` is called. The runner never
 * computes the relation — see its module header — so freezing is the caller's
 * job, and doing it here means the relation is taken from the repository as it
 * is at the moment the operator asked, once, and then bound into the
 * fingerprint.
 *
 * The order is: resolve → plan → project → define → **lease** → run → release.
 * Every refusal above the lease line happens before anything is taken, so an
 * unusable input never costs another invocation its turn as writer.
 */
```

The action body:

```ts
const resolution = await resolveRepository({ repositoryPath: options.repository });
// ... the same refusal shape run-command.ts uses, exit EXIT_RUN_INPUT_UNUSABLE

const planned = planNextTask(repository);
if (!planned.ok) { /* print planned.code + planned.detail; exit EXIT_RUN_INPUT_UNUSABLE */ }

const projected = projectBlockDependencies(planned.graph, options.tasks);
if (!projected.ok) { /* print projected.code and projected.taskId; exit EXIT_RUN_INPUT_UNUSABLE */ }

const defined = defineBlock(options.block, options.tasks, projected.dependencies);
if (!defined.ok) { /* print defined.code; exit EXIT_RUN_INPUT_UNUSABLE */ }

if (options.attended !== true) {
  process.stdout.write(renderFrozenPlan(repository, defined.definition));
  process.exitCode = EXIT_RUN_OK;
  return;
}

const acquired = acquireRepositoryExecutionLease(repository, { runId: options.run, blockId: options.block }, { now: () => new Date().toISOString() });
if (!acquired.ok) {
  process.stdout.write(renderLeaseRefusal(acquired.code));
  process.exitCode = EXIT_RUN_REFUSED;
  return;
}
try {
  const result = await runAttendedBlock(
    { repository, definition: defined.definition, runId: options.run, lease: acquired.evidence, maxStepsPerTask: maxSteps },
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
  // Released on every path out, including a throw. The lease is taken once for
  // the whole block run and given back once — never per task, which would leave
  // a window between tasks that a second writer fits into perfectly.
  releaseRepositoryExecutionLease(acquired.evidence);
}
```

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
independent, and writes nothing.

This is the one place the dependency relation is projected. The runner never
computes it, so freezing is the caller's job, and doing it here takes the
relation from the repository as it is at the moment the operator asked - once -
and binds it into the fingerprint.

The lease is taken after every input refusal and released on every path out,
including a throw. Taken once for the whole run: a per-task lease would leave a
window between tasks that a second writer fits into perfectly.

Two exit tables, both total. DURABLE_WRITE_FAILED exits 3 while the other two
no-write outcomes exit 4 - code 4 says nothing durable is wrong and re-invoking
can differ, which is true of a lease somebody else holds and false of a disk
that refused a write.
```

---

### Task 12: The record, and the canonical gate

**Files:**
- Modify: `README.md` (the "Not implemented yet" roadmap at ~4215; a new V2-08 section; the follow-up register)
- Modify: `docs/superpowers/specs/2026-08-14-v2-08-attended-block-runner-design.md` (status line only)

- [ ] **Step 1: Write the V2-08 section**

Add a `## The attended block runner (V2-08)` section to `README.md`, after the V2-07P material and before "Not implemented yet". It must state, in the repository's own voice:

- **the two classes of bad news**, and that confusing them is the defect the design exists to prevent — with the worked example (`A = BLOCKED`, `B` and `C` `SETTLED`, ending `TASK_BLOCKED`, and *not* `COMPLETE`);
- **why continuing is safe here and only here**: every continuation is still gated by the same proof, so a failed A cannot make a false claim about B possible;
- **the policy V2-07 documented and this slice reversed**, named as a reversal;
- **that a `stopReason` is itself a durable claim**, which is why lease uncertainty and a failed durable write are runner outcomes rather than reasons, and why the ledger is left byte-identical for both;
- **`ACTIVE_TASK_UNRESOLVED`**, and why it is not `STATE_UNUSABLE`;
- **the frozen dependency relation**: that `BlockDefinition` could not previously express independence at all, that the relation is the *transitive projection* over the whole normalised DAG, and the `A ← X ← B` case that makes a direct intra-block check unsound;
- **cause beats consequence** for the end reason, and what `NO_ELIGIBLE_TASK` is now reserved for;
- **schema version 2 and the refusal of version 1**, with no migration;
- **the scope lines**: attended only, sequential only, no commit chain, no dependency scheduler, no new platform or ownership surface.

- [ ] **Step 2: Record what this slice carried forward**

Add a `### Carried forward from V2-08, deliberately` block to the follow-up register (the "Carried forward, deliberately" convention at `README.md:2961` and `README.md:3645`):

- **F-B1 — drift is answered when an invocation opens a run, not between tasks.** The runner is forbidden to project the dependency relation, so it cannot re-derive a current fingerprint mid-run; the comparison happens when a run is opened or resumed. A roadmap edited while an attended invocation is in flight is therefore noticed by the *next* invocation. Accepted: the alternative is a runner that recomputes the relation, which is the authority inversion the slice exists to prevent.
- **F-B2 — `independenceIsEstablished` is all-or-nothing.** A block with any frozen edge degrades to V2-07's behaviour — stop at the first task-local failure — even where the remaining members happen to be mutually independent. Accepted: the finer answer is a dependency scheduler, and V2-09 owns it.
- **F-B3 — `OPERATOR_STOPPED` has no producer.** The runner has no signal handling, so the reason stays in the vocabulary unproduced. Either a later slice gives it one or the member is withdrawn; it is not graded as reachable in the meantime.
- **F-B4 — a member blocked only by a non-member ends the run `NO_ELIGIBLE_TASK`.** The frozen relation deliberately records nothing about non-members, so the block can be frozen while that member can never become eligible. That is the honest dead end rather than a defect, and it is why the reason is reserved rather than generic.

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

- [ ] **Step 4: Mark the design closed**

In the design spec, change the status line from

```
**Status:** design, not yet planned into tasks.
```

to

```
**Status:** planned and implemented. Plan: `docs/superpowers/plans/2026-08-14-v2-08-attended-block-runner.md`.
```

- [ ] **Step 5: Run the canonical gate**

Run: `npm run verify`
Expected: PASS, end to end. This is the gate `CLAUDE.md` calls canonical — schema generation, typecheck, build, four dist-artefact harnesses, the in-process suite and the serial tree-kill probe. Nothing in this slice touches the dist harnesses, so a failure there is a regression rather than an expected consequence.

If the block cases make the in-process suite meaningfully slower, say so with the measured before/after rather than trimming a case.

- [ ] **Step 6: Commit and open the pull request**

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
one.

Four items carried forward as decisions rather than defects, the first two of
them costs of rules the slice chose deliberately: drift is answered when an
invocation opens a run rather than between tasks, because the runner is
forbidden to recompute the relation; and independence is all-or-nothing,
because the finer answer is the dependency scheduler V2-09 owns.
```

The pull request body should carry the same four decisions and the control map below, so a reviewer can check the claims against the cases without reading the plan.

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
| 3. each class-2 condition, separately | 8 |
| 3a. the two no-write outcomes leave the ledger byte-identical | 8 (lease), 9 (durable write) |
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

Two constraints the design attached to the schema change, and where they live:
the sorting of the new reason is a **correctness** test in Task 4, and the
"writable over an unsupported ledger" obligation is the effect case in the same
task. The four control points the design's decisions turned on — freeze-time
projection only, one persisted truth, external-only blockers kept apart from
independence, and an explicit load contract for old documents — are the first
four bullets of Global Constraints, and are pinned by Tasks 2, 3, 7 and 3
respectively.

## Execution

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration.
2. **Inline Execution** — executed in this session with checkpoints for review.
