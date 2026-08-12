/**
 * V2-07 — the block-run ledger.
 *
 * One principle, and every test here is written against a way of breaking it:
 *
 * > The ledger is durable orchestration truth, and never the primary truth
 * > about a single task.
 *
 * So the load-bearing cases are not "can it store a block". They are:
 *
 *  - a hand-edited ledger claiming `A = SETTLED` while A never finished must
 *    **not** make B runnable — the shape that would, once V2-09 chains bases,
 *    unlock a dependency edge on work that does not exist;
 *  - `settleBlockTask` must refuse a task whose own record does not prove it;
 *  - a roadmap edited under a running block must be reported, never adopted;
 *  - the compare-and-swap must behave exactly as the task store's does.
 *
 * Real repositories and real state files throughout: the refusals asserted here
 * are reproducible on real files, and asserting them against a fake would prove
 * only that the fake agreed.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  defineBlock,
  fingerprintBlockDefinition,
  fingerprintFrozenMembership,
} from '../src/block/block-definition.js';
import {
  BLOCK_LEDGER_SCHEMA_VERSION,
  safeParseBlockRunLedger,
} from '../src/block/block-ledger.js';
import {
  activateBlockTask,
  parkBlockTask,
  settleBlockTask,
  startBlockRun,
  stopBlockRun,
} from '../src/block/block-progress.js';
import { createBlockLedger, loadBlockLedger } from '../src/block/block-store.js';
import { reconcileBlockRun } from '../src/block/reconcile-block.js';
import { startTask } from '../src/run/start-task.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, removeRepoFixtures, writeRepoFile } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } from './helpers/worktree-fixtures.js';
import { e2eProfile, taskFile, tickingClock } from './helpers/e2e-fixtures.js';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const RUN_ID = 'run-0001';
const BLOCK_ID = 'V2';
const NOW = '2026-08-11T09:00:00.000Z';

function block(taskIds: readonly string[] = ['A-001', 'B-001']) {
  const defined = defineBlock(BLOCK_ID, taskIds);
  if (!defined.ok) throw new Error(`fixture block is not a block: ${defined.code}`);
  return defined.definition;
}

interface Fixture {
  readonly repository: ResolvedRepository;
  readonly root: string;
}

async function repoWithTasks(taskIds: readonly string[] = ['A-001', 'B-001']): Promise<Fixture> {
  const files: Record<string, string> = { '.gitignore': '.agent-orchestrator/runtime/\n' };
  for (const taskId of taskIds) files[`tasks/${taskId}.md`] = taskFile(taskId);

  const root = createRepoFixture({ defaultBranch: 'main', profile: e2eProfile(), files });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return { repository, root };
}

function started(fixture: Fixture, taskIds?: readonly string[]) {
  return startBlockRun({
    definition: block(taskIds),
    repositoryId: fixture.repository.id,
    repositoryRoot: fixture.root,
    runId: RUN_ID,
    now: NOW,
  });
}

function reload(root: string) {
  const loaded = loadBlockLedger(root, RUN_ID);
  if (!loaded.ok) throw new Error(`ledger did not load: ${loaded.code}`);
  return loaded;
}

/** Starts a real task through production code, so its state is a real one. */
async function realTask(fixture: Fixture, taskId: string) {
  const result = await startTask(
    { repository: fixture.repository, taskId },
    { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: leaseFor(fixture.repository) },
  );
  expect(result.outcome).toBe('STARTED');
}

/** Moves a real task's durable state to `READY_FOR_PR`, the settlement proof. */
function driveToReadyForPr(fixture: Fixture, taskId: string): void {
  const loaded = loadTaskState(fixture.root, taskId);
  if (!loaded.ok) throw new Error('task did not start');
  const saved = saveTaskState(
    {
      ...loaded.state,
      state: 'READY_FOR_PR',
      stateEnteredAt: '2026-08-11T10:00:00.000Z',
      reviewRound: 1,
      worktreeCleanAtCheckpoint: true,
    },
    { repositoryRoot: fixture.root, expectedRevision: loaded.revision },
  );
  if (!saved.ok) throw new Error(`could not drive to READY_FOR_PR: ${saved.code}`);
}

/* ══════════════════ the definition, and what a run freezes ══════════════ */

describe('the block definition', () => {
  it('refuses an empty block, a repeated task and an unusable id', () => {
    expect(defineBlock(BLOCK_ID, []).ok).toBe(false);
    const repeated = defineBlock(BLOCK_ID, ['A-001', 'A-001']);
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.code).toBe('TASK_REPEATED');
    expect(defineBlock('not a block id', ['A-001']).ok).toBe(false);
  });

  it('fingerprints identity and order, and nothing else', () => {
    const a = fingerprintBlockDefinition(block(['A-001', 'B-001']));
    const reordered = fingerprintBlockDefinition(block(['B-001', 'A-001']));
    const same = fingerprintBlockDefinition(block(['A-001', 'B-001']));

    expect(a).toBe(same);
    // Order is part of the identity a run freezes.
    expect(a).not.toBe(reordered);
  });
});

/* ════════════════════════ persistence and the CAS ═══════════════════════ */

describe('the ledger store', () => {
  it('writes the first ledger with every task planned and nothing active', async () => {
    const fixture = await repoWithTasks();

    const saved = started(fixture);

    expect(saved.ok).toBe(true);
    const ledger = reload(fixture.root).ledger;
    expect(ledger.schemaVersion).toBe(BLOCK_LEDGER_SCHEMA_VERSION);
    expect(ledger.blockId).toBe(BLOCK_ID);
    expect(ledger.runId).toBe(RUN_ID);
    expect(ledger.frozenTaskIds).toEqual(['A-001', 'B-001']);
    expect(ledger.activeTaskId).toBeNull();
    expect(ledger.stopReason).toBeNull();
    expect(ledger.tasks.map((task) => task.disposition)).toEqual(['PLANNED', 'PLANNED']);
  });

  it('refuses a second run under the same run id rather than overwriting it', async () => {
    const fixture = await repoWithTasks();
    expect(started(fixture).ok).toBe(true);

    const again = started(fixture);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('LEDGER_CONFLICT');
  });

  it('lets the same block start again under a different run id', async () => {
    const fixture = await repoWithTasks();
    expect(started(fixture).ok).toBe(true);

    const second = startBlockRun({
      definition: block(),
      repositoryId: fixture.repository.id,
      repositoryRoot: fixture.root,
      runId: 'run-0002',
      now: NOW,
    });

    // A block is not a run. Starting it again must not destroy the evidence of
    // what happened last time.
    expect(second.ok).toBe(true);
    expect(loadBlockLedger(fixture.root, RUN_ID).ok).toBe(true);
    expect(loadBlockLedger(fixture.root, 'run-0002').ok).toBe(true);
  });

  it('refuses a stale writer', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    const current = reload(fixture.root);
    await realTask(fixture, 'A-001');
    // Somebody else moves it on.
    expect(activateBlockTask(current, 'A-001', { repositoryRoot: fixture.root }).outcome).toBe(
      'RECORDED',
    );

    // The first reader writes on the revision it read.
    const stale = stopBlockRun(current, 'OPERATOR_STOPPED', { repositoryRoot: fixture.root });

    expect(stale.outcome).toBe('NOT_RECORDED');
    expect(stale.save?.ok).toBe(false);
    if (stale.save?.ok === false) expect(stale.save.code).toBe('LEDGER_CONFLICT');
  });

  it('keeps a ledger belonging to another checkout out of this one', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    const ledger = reload(fixture.root).ledger;

    const elsewhere = createBlockLedger(
      { ...ledger, repositoryRoot: join(fixture.root, 'elsewhere') },
      { repositoryRoot: fixture.root },
    );

    expect(elsewhere.ok).toBe(false);
    if (elsewhere.ok) return;
    expect(elsewhere.code).toBe('REPOSITORY_ROOT_MISMATCH');
  });
});

/* ═══════════════ the contract refuses self-contradiction ════════════════ */

describe('the ledger contract', () => {
  const base = {
    schemaVersion: BLOCK_LEDGER_SCHEMA_VERSION,
    repositoryId: 'fixture',
    repositoryRoot: 'D:\\repo',
    blockId: BLOCK_ID,
    runId: RUN_ID,
    startedAt: NOW,
    frozenTaskIds: ['A-001', 'B-001'],
    planFingerprint: fingerprintFrozenMembership(BLOCK_ID, ['A-001', 'B-001']),
    activeTaskId: null,
    tasks: [
      { taskId: 'A-001', disposition: 'PLANNED', evidenceRevision: null, baseCommit: null, resultCommit: null },
      { taskId: 'B-001', disposition: 'PLANNED', evidenceRevision: null, baseCommit: null, resultCommit: null },
    ],
    stopReason: null,
  };

  // The control every other case in this block leans on. Each of them asserts
  // only that a forgery is *refused*, and a `base` that had stopped being valid
  // would satisfy all of them for the wrong reason. That is not hypothetical:
  // `base` once carried a hand-written `planFingerprint`, which the
  // re-derivation rule would have made invalid — and five tests would have gone
  // on passing while proving nothing.
  it('starts from a base document the contract actually accepts', () => {
    expect(safeParseBlockRunLedger(base).success).toBe(true);
  });

  it('refuses a block whose id is also one of its own tasks', () => {
    // The fingerprint is recomputed for the colliding id, so the only thing
    // left to refuse this document is the collision itself.
    const collided = {
      ...base,
      blockId: 'A-001',
      planFingerprint: fingerprintFrozenMembership('A-001', ['A-001', 'B-001']),
    };

    expect(safeParseBlockRunLedger(collided).success).toBe(false);
  });

  it('refuses a settled entry with no evidence behind it', () => {
    const forged = {
      ...base,
      tasks: [{ ...base.tasks[0], disposition: 'SETTLED' }, base.tasks[1]],
    };

    // The cheapest forgery there is, and the contract refuses it before any
    // reconciliation looks at a task record.
    expect(safeParseBlockRunLedger(forged).success).toBe(false);
  });

  it('refuses two active tasks', () => {
    const forged = {
      ...base,
      activeTaskId: 'A-001',
      tasks: base.tasks.map((task) => ({ ...task, disposition: 'ACTIVE' })),
    };

    expect(safeParseBlockRunLedger(forged).success).toBe(false);
  });

  it('refuses entries that do not mirror the frozen membership', () => {
    expect(
      safeParseBlockRunLedger({ ...base, tasks: [base.tasks[1], base.tasks[0]] }).success,
    ).toBe(false);
    expect(safeParseBlockRunLedger({ ...base, tasks: [base.tasks[0]] }).success).toBe(false);
  });

  it('refuses COMPLETE over unfinished work', () => {
    expect(safeParseBlockRunLedger({ ...base, stopReason: 'COMPLETE' }).success).toBe(false);
  });

  it('refuses a result commit on a task that has not settled', () => {
    const forged = {
      ...base,
      tasks: [{ ...base.tasks[0], resultCommit: 'a'.repeat(40) }, base.tasks[1]],
    };

    expect(safeParseBlockRunLedger(forged).success).toBe(false);
  });
});

/* ══════════════════ progress is backed by the task record ═══════════════ */

describe('recording progress', () => {
  it('refuses to settle a task whose own record does not prove it', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    const current = reload(fixture.root);

    // The task exists and is at WORKTREE_READY — started, not finished.
    const settled = settleBlockTask(current, 'A-001', { repositoryRoot: fixture.root });

    expect(settled.outcome).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
    expect(reload(fixture.root).ledger.tasks[0]?.disposition).toBe('PLANNED');
  });

  it('refuses to settle a task that was never started', async () => {
    const fixture = await repoWithTasks();
    started(fixture);

    const settled = settleBlockTask(reload(fixture.root), 'A-001', {
      repositoryRoot: fixture.root,
    });

    expect(settled.outcome).toBe('TASK_NOT_STARTED');
  });

  it('settles on READY_FOR_PR, and keeps the evidence that proved it', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');

    const settled = settleBlockTask(reload(fixture.root), 'A-001', {
      repositoryRoot: fixture.root,
    });

    expect(settled.outcome).toBe('RECORDED');
    const entry = reload(fixture.root).ledger.tasks[0];
    expect(entry?.disposition).toBe('SETTLED');
    // The revision of the state that justified the claim, so a later
    // reconciliation can tell a proven claim from a typed one.
    const state = loadTaskState(fixture.root, 'A-001');
    expect(entry?.evidenceRevision).toBe(state.ok ? state.revision : null);
    expect(entry?.baseCommit).toBe(state.ok ? state.state.basePinnedCommit : null);
    expect(entry?.resultCommit).toBe(state.ok ? state.state.currentCommit : null);
  });

  it('drives at most one task at a time', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    await realTask(fixture, 'B-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });

    const second = activateBlockTask(reload(fixture.root), 'B-001', {
      repositoryRoot: fixture.root,
    });

    expect(second.outcome).toBe('ANOTHER_TASK_ACTIVE');
  });

  it('refuses to park a task that is not in a blocking state', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');

    const parked = parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });

    expect(parked.outcome).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
  });

  it('will not claim an outcome for the run while a task is still active', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });

    // The three reasons that say what the *tasks* did. Claiming any of them
    // over a task the run is still holding would invent an outcome for a task
    // nothing looked at.
    for (const reason of ['COMPLETE', 'TASK_BLOCKED', 'TASK_ABANDONED'] as const) {
      expect(
        stopBlockRun(reload(fixture.root), reason, { repositoryRoot: fixture.root }).outcome,
      ).toBe('ANOTHER_TASK_ACTIVE');
    }
    expect(reload(fixture.root).ledger.stopReason).toBeNull();
  });

  it('records a no-progress stop over a task it never resolved, and changes nothing else', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    const before = reload(fixture.root).ledger;

    const stopped = stopBlockRun(reload(fixture.root), 'OPERATOR_STOPPED', {
      repositoryRoot: fixture.root,
    });

    // A reason that claims no progress needs no evidence, so it does not need
    // the active task resolved first — and requiring that was what once left a
    // run able to see a fault it could never record.
    expect(stopped.outcome).toBe('RECORDED');

    const after = reload(fixture.root).ledger;
    expect(after.stopReason).toBe('OPERATOR_STOPPED');
    // The honest record: the run stopped, and this task was unresolved when it
    // did. Nothing was rewound, nothing was invented, nothing else moved.
    expect(after.activeTaskId).toBe('A-001');
    expect(after.tasks).toEqual(before.tasks);
    expect({ ...after, stopReason: null }).toEqual({ ...before, stopReason: null });
  });
});

/* ══════════ the adversarial case: a ledger that claims false progress ═══ */

describe('a forged ledger does not unlock a successor', () => {
  it('is not believed when it claims A settled and A never finished', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    await realTask(fixture, 'B-001');

    // Hand-edit the file into the dangerous shape: A settled, B active. The
    // evidence field is filled with a well-formed digest, so the *contract*
    // accepts the document — the lie is only visible against the task record.
    const current = reload(fixture.root);
    const forged = {
      ...current.ledger,
      activeTaskId: 'B-001',
      tasks: [
        { ...current.ledger.tasks[0], disposition: 'SETTLED', evidenceRevision: 'b'.repeat(64) },
        { ...current.ledger.tasks[1], disposition: 'ACTIVE' },
      ],
    };
    writeFileSync(
      join(fixture.root, '.agent-orchestrator', 'runtime', 'blocks', `${RUN_ID}.json`),
      `${JSON.stringify(forged, null, 2)}\n`,
      'utf8',
    );

    // It loads: it is a well-formed ledger. That is the point — the contract
    // alone cannot catch this, and reconciliation must.
    const reloaded = reload(fixture.root);
    expect(reloaded.ledger.tasks[0]?.disposition).toBe('SETTLED');

    const reconciliation = reconcileBlockRun(reloaded.ledger, { repositoryRoot: fixture.root });

    expect(reconciliation.verdict).toBe('DIVERGED');
    expect(reconciliation.findings).toContainEqual({
      taskId: 'A-001',
      finding: 'SETTLED_WITHOUT_TERMINAL_STATE',
    });
  });

  it('reports stale evidence when the task moved on after the claim', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');
    settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });

    // The claim was justified when it was made. Re-persisting the state gives
    // it new bytes, so the evidence no longer matches what is on disk.
    const state = loadTaskState(fixture.root, 'A-001');
    if (!state.ok) throw new Error('state did not load');
    saveTaskState(
      { ...state.state, stateEnteredAt: '2026-08-11T11:00:00.000Z' },
      { repositoryRoot: fixture.root, expectedRevision: state.revision },
    );

    const reconciliation = reconcileBlockRun(reload(fixture.root).ledger, {
      repositoryRoot: fixture.root,
    });

    expect(reconciliation.verdict).toBe('DIVERGED');
    expect(reconciliation.findings).toContainEqual({
      taskId: 'A-001',
      finding: 'EVIDENCE_STALE',
    });
  });
});

/* ═══════════════ the benign direction, reported and not written ═════════ */

describe('reconciliation reports rather than repairs', () => {
  it('sees a task that finished ahead of the ledger, and writes nothing', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToReadyForPr(fixture, 'A-001');

    const before = reload(fixture.root);
    const reconciliation = reconcileBlockRun(before.ledger, { repositoryRoot: fixture.root });

    // Nothing false is claimed, so this is not a divergence — it is progress
    // the ledger has not caught up with. Which of these may be applied
    // automatically is V2-08's decision, made with a runner in front of it.
    expect(reconciliation.verdict).toBe('CONSISTENT');
    expect(reconciliation.progressAvailable).toBe(true);
    expect(reconciliation.findings).toContainEqual({
      taskId: 'A-001',
      finding: 'TASK_AHEAD_OF_LEDGER',
    });
    // Read-only: the same bytes are still on disk.
    expect(reload(fixture.root).revision).toBe(before.revision);
  });

  it('is consistent for an honest ledger', async () => {
    const fixture = await repoWithTasks();
    started(fixture);
    await realTask(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');
    settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });

    const reconciliation = reconcileBlockRun(reload(fixture.root).ledger, {
      repositoryRoot: fixture.root,
      definition: block(),
    });

    expect(reconciliation.verdict).toBe('CONSISTENT');
    expect(reconciliation.findings).toEqual([]);
  });

  it('reports a roadmap edited under a running block, and does not adopt it', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    started(fixture, ['A-001', 'B-001']);
    writeRepoFile(fixture.root, 'tasks/C-001.md', taskFile('C-001'));

    const reconciliation = reconcileBlockRun(reload(fixture.root).ledger, {
      repositoryRoot: fixture.root,
      // The definition as the repository would state it now.
      definition: block(['A-001', 'B-001', 'C-001']),
    });

    expect(reconciliation.verdict).toBe('DIVERGED');
    expect(reconciliation.findings).toContainEqual({
      taskId: BLOCK_ID,
      finding: 'DEFINITION_DRIFTED',
    });
    // The frozen membership is untouched: task four is not swapped in while
    // tasks one to three have already gone.
    expect(reload(fixture.root).ledger.frozenTaskIds).toEqual(['A-001', 'B-001']);
  });
});
