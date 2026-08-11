/**
 * V2-07 remediation — the counter-proofs, conserved.
 *
 * Every case in this file was first reproduced as an exploratory probe against
 * the unmodified V2-07 ledger (`main` @ 8db11d7), in a real repository fixture,
 * through the ordinary public API — no hand-editing where the attack did not
 * need it, no crash, no corruption. What is written down here is the *attack*,
 * not the probe: each one asserts the contract the ledger is supposed to hold,
 * so that it fails while the gap is open and pins the gap shut once it is
 * closed.
 *
 * ── The two sentences the whole file is measured against ───────────────────
 *
 * > The ledger is durable orchestration truth, and never the primary truth
 * > about a single task.
 *
 * > A compare-and-swap answers "has anybody written since my revision?" It does
 * > not answer "may this successor change these fields at all?" — and V2-07
 * > read the first answer as though it were the second.
 *
 * ── The four contract clusters ─────────────────────────────────────────────
 *
 *   1. loaded identity and successor authority — a revision is not a licence
 *      to rewrite the run's identity, its frozen plan, or progress already
 *      recorded; and a ledger read under one run id is not another run's.
 *   2. progress only from external evidence — no mutating call may persist
 *      progress that an optional later reconciler would be the first to call
 *      false.
 *   3. a terminal reason is history — not a label a later call may relabel.
 *   4. the commit fields must stay provable after the fact, not merely at the
 *      moment they were written.
 *
 * The two cross-run cases are deliberately **not** here as defects. That two
 * separate run ledgers can each hold the same task `ACTIVE` is not a ledger
 * fault: V2-07's guarantee is one active task *per ledger*, and repository-wide
 * execution ownership belongs to the execution lease that does not exist yet.
 * It is pinned below as a boundary so that the ledger never grows a half-lease
 * and never claims a guarantee it does not have.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  defineBlock,
  fingerprintBlockDefinition,
  fingerprintFrozenMembership,
} from '../src/block/block-definition.js';
import { safeParseBlockRunLedger } from '../src/block/block-ledger.js';
import {
  abandonBlockTask,
  activateBlockTask,
  parkBlockTask,
  settleBlockTask,
  startBlockRun,
  stopBlockRun,
} from '../src/block/block-progress.js';
import { loadBlockLedger, updateBlockLedger } from '../src/block/block-store.js';
import { reconcileBlockRun } from '../src/block/reconcile-block.js';
import { startTask } from '../src/run/start-task.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';
import { e2eProfile, taskFile, tickingClock } from './helpers/e2e-fixtures.js';

afterEach(() => {
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const RUN_ID = 'run-0001';
const BLOCK_ID = 'V2';
const NOW = '2026-08-11T09:00:00.000Z';

/** A digest-shaped value that is no task state's revision. */
const FORGED_REVISION = 'a'.repeat(64);
/** A syntactically perfect object name that names nothing in the fixture. */
const FORGED_SHA = 'c'.repeat(40);

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

function block(taskIds: readonly string[]) {
  const defined = defineBlock(BLOCK_ID, taskIds);
  if (!defined.ok) throw new Error(`fixture block is not a block: ${defined.code}`);
  return defined.definition;
}

function ledgerPath(root: string, runId: string = RUN_ID): string {
  return join(root, '.agent-orchestrator', 'runtime', 'blocks', `${runId}.json`);
}

function onDisk(root: string, runId: string = RUN_ID): Record<string, unknown> {
  return JSON.parse(readFileSync(ledgerPath(root, runId), 'utf8')) as Record<string, unknown>;
}

/** The ledger as the store gives it back, or a thrown fixture failure. */
function reload(root: string, runId: string = RUN_ID) {
  const loaded = loadBlockLedger(root, runId);
  if (!loaded.ok) throw new Error(`fixture could not reload the ledger: ${loaded.code}`);
  return loaded;
}

function startRun(fixture: Fixture, taskIds: readonly string[], runId: string = RUN_ID) {
  const started = startBlockRun({
    definition: block(taskIds),
    repositoryId: fixture.repository.id,
    repositoryRoot: fixture.root,
    runId,
    now: NOW,
  });
  if (!started.ok) throw new Error(`fixture could not start the run: ${started.code}`);
  return started;
}

/** Starts a task for real, so a durable task state exists to be read. */
async function reallyStart(fixture: Fixture, taskId: string): Promise<void> {
  const started = await startTask(
    { repository: fixture.repository, taskId },
    { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses },
  );
  expect(started.outcome).toBe('STARTED');
}

/** Moves a really-started task to the one state that proves settlement. */
function driveToReadyForPr(fixture: Fixture, taskId: string): void {
  const loaded = loadTaskState(fixture.root, taskId);
  if (!loaded.ok) throw new Error('fixture: the task never started');
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
  if (!saved.ok) throw new Error(`fixture could not reach READY_FOR_PR: ${saved.code}`);
}

/** Gives a really-started task up, deliberately and irreversibly. */
function driveToAborted(fixture: Fixture, taskId: string): void {
  const loaded = loadTaskState(fixture.root, taskId);
  if (!loaded.ok) throw new Error('fixture: the task never started');
  const saved = saveTaskState(
    { ...loaded.state, state: 'ABORTED', stateEnteredAt: '2026-08-11T11:00:00.000Z' },
    { repositoryRoot: fixture.root, expectedRevision: loaded.revision },
  );
  if (!saved.ok) throw new Error(`fixture could not reach ABORTED: ${saved.code}`);
}

/* ───────────────── cluster 1 — identity and successor authority ─────────── */

describe('cluster 1 — a revision is not a licence to rewrite the run', () => {
  it('refuses a successor that rewrites the frozen plan it inherited', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001', 'C-001']);
    startRun(fixture, ['A-001', 'B-001', 'C-001']);

    const current = reload(fixture.root);

    // A caller holding nothing but the current revision — the ordinary,
    // sanctioned way to write. It shrinks the block to one task, renames the
    // block, backdates the run, forges a settlement, and declares the whole
    // thing COMPLETE. Every field it touches is one the module header calls
    // written once and never changed.
    //
    // It is deliberately *internally consistent*: its fingerprint describes the
    // plan it lists, so no self-contradiction refuses it. The only thing that
    // can is the question a compare-and-swap never asked — may this successor
    // change these fields at all?
    const usurper = {
      ...current.ledger,
      blockId: 'V9',
      startedAt: '2020-01-01T00:00:00.000Z',
      frozenTaskIds: ['A-001'],
      planFingerprint: fingerprintFrozenMembership('V9', ['A-001']),
      tasks: [
        {
          taskId: 'A-001',
          disposition: 'SETTLED' as const,
          evidenceRevision: FORGED_REVISION,
          baseCommit: null,
          resultCommit: FORGED_SHA,
        },
      ],
      stopReason: 'COMPLETE' as const,
    };
    expect(safeParseBlockRunLedger(usurper).success).toBe(true);

    const saved = updateBlockLedger(usurper, {
      repositoryRoot: fixture.root,
      expectedRevision: current.revision,
    });

    expect(saved.ok).toBe(false);
    expect(saved.ok ? null : saved.code).toBe('LEDGER_SUCCESSION_REFUSED');
    expect(saved.ok ? '' : (saved.detail ?? '')).toContain('RUN_IDENTITY_CHANGED');
    expect(saved.ok ? '' : (saved.detail ?? '')).toContain('FROZEN_PLAN_CHANGED');

    // Refused means nothing moved: the frozen plan is still the frozen plan.
    const after = onDisk(fixture.root);
    expect(after['blockId']).toBe(BLOCK_ID);
    expect(after['frozenTaskIds']).toEqual(['A-001', 'B-001', 'C-001']);
    expect(after['startedAt']).toBe(NOW);
    expect(after['stopReason']).toBeNull();
  }, 180_000);

  it('refuses a ledger whose planFingerprint does not describe its own membership', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001', 'C-001']);
    startRun(fixture, ['A-001', 'B-001', 'C-001']);
    const current = reload(fixture.root);

    const honest = block(['A-001', 'B-001', 'C-001']);
    const reordered = block(['A-001', 'C-001', 'B-001']);

    // Drift detection, before the attack: it answers about the definition.
    expect(
      reconcileBlockRun(current.ledger, { repositoryRoot: fixture.root, definition: honest })
        .findings,
    ).toEqual([]);
    expect(
      reconcileBlockRun(current.ledger, { repositoryRoot: fixture.root, definition: reordered })
        .findings.map((entry) => entry.finding),
    ).toEqual(['DEFINITION_DRIFTED']);

    // The attack is one field. `planFingerprint` is stored rather than derived,
    // so a ledger may carry a digest of a plan that is not the plan it lists —
    // and every later drift answer is then computed against the lie. Reversing
    // drift detection is worse than losing it: the honest roadmap reports as
    // drifted and the edited one reports as clean.
    const lying = {
      ...current.ledger,
      planFingerprint: fingerprintBlockDefinition(reordered),
    };
    const saved = updateBlockLedger(lying, {
      repositoryRoot: fixture.root,
      expectedRevision: current.revision,
    });

    expect(saved.ok).toBe(false);
    expect(saved.ok ? null : saved.code).toBe('LEDGER_CONTRACT_VIOLATION');

    // And the ledger on disk still answers drift the one honest way.
    const back = reload(fixture.root);
    expect(back.ledger.planFingerprint).toBe(current.ledger.planFingerprint);
    expect(
      reconcileBlockRun(back.ledger, { repositoryRoot: fixture.root, definition: honest }).findings,
    ).toEqual([]);
  }, 180_000);

  it('refuses a successor that rewinds a mid-flight task and erases its evidence', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001', 'C-001']);
    startRun(fixture, ['A-001', 'B-001', 'C-001']);
    await reallyStart(fixture, 'A-001');
    expect(activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');

    const current = reload(fixture.root);

    // Not a forward claim — a *rewind*. Every entry goes back to PLANNED, the
    // active task is cleared and the recorded base pin is dropped. Nothing here
    // is caught by the reconciler afterwards either: a PLANNED entry over a
    // task that has not finished is exactly the benign shape, so a run that
    // has been quietly un-progressed reconciles CONSISTENT.
    const rewound = {
      ...current.ledger,
      activeTaskId: null,
      tasks: current.ledger.tasks.map((task) => ({
        ...task,
        disposition: 'PLANNED' as const,
        evidenceRevision: null,
        baseCommit: null,
        resultCommit: null,
      })),
    };
    const saved = updateBlockLedger(rewound, {
      repositoryRoot: fixture.root,
      expectedRevision: current.revision,
    });

    expect(saved.ok).toBe(false);
    expect(saved.ok ? null : saved.code).toBe('LEDGER_SUCCESSION_REFUSED');
    expect(saved.ok ? '' : (saved.detail ?? '')).toContain('DISPOSITION_REWOUND');

    const after = reload(fixture.root);
    expect(after.ledger.activeTaskId).toBe('A-001');
    expect(after.ledger.tasks[0]?.disposition).toBe('ACTIVE');
  }, 180_000);

  it('refuses a ledger read under a run id that is not its own', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001'], 'run-0001');

    const fileA = ledgerPath(fixture.root, 'run-0001');
    const fileB = ledgerPath(fixture.root, 'run-0002');

    // The crash/backup/copy shape the store's own header names as its threat
    // model: run-0001's ledger, sitting where run-0002's belongs.
    writeFileSync(fileB, readFileSync(fileA), { flag: 'w' });

    const asB = loadBlockLedger(fixture.root, 'run-0002');

    // A document found *by* an identity that contradicts the identity it
    // carries is not that run's ledger — the same refusal the task store makes
    // as TASK_ID_MISMATCH, for the same reason.
    expect(asB.ok).toBe(false);
    expect(asB.ok ? null : asB.code).toBe('RUN_ID_MISMATCH');

    // The consequence that makes it load-bearing: a write made through such a
    // load lands in the *other* run's file. Settling A-001 "in run-0002" would
    // otherwise record settlement into run-0001.json, a run the caller never
    // opened, under a revision it never read.
    await reallyStart(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');

    const beforeA = readFileSync(fileA, 'utf8');
    if (asB.ok) {
      settleBlockTask(asB, 'A-001', { repositoryRoot: fixture.root });
    }
    expect(readFileSync(fileA, 'utf8')).toBe(beforeA);
  }, 180_000);
});

/* ───────────────── cluster 2 — progress needs external evidence ─────────── */

describe('cluster 2 — no mutating call may persist unproven progress', () => {
  it('refuses COMPLETE over hand-forged settlements no task ever supported', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);

    // No task was ever started; no task state exists anywhere in this
    // repository. The ledger file is edited into internal schema consistency,
    // which is all the contract asks of a document at rest.
    const path = ledgerPath(fixture.root);
    const forged = JSON.parse(readFileSync(path, 'utf8')) as {
      tasks: Record<string, unknown>[];
    };
    for (const entry of forged.tasks) {
      entry['disposition'] = 'SETTLED';
      entry['evidenceRevision'] = FORGED_REVISION;
      entry['baseCommit'] = FORGED_SHA;
      entry['resultCommit'] = FORGED_SHA;
    }
    writeFileSync(path, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');

    const loaded = loadBlockLedger(fixture.root, RUN_ID);
    // Loading it is right: a hand-edited ledger is the threat model, not an
    // error. What must not happen is a *write* that believes it.
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const stopped = stopBlockRun(loaded, 'COMPLETE', { repositoryRoot: fixture.root });

    // `COMPLETE` is a claim about every task in the run. Checking it against
    // the ledger's own entries only asks the liar whether it lied; the proof
    // has to come from the task records, at the moment the claim is written —
    // not from a reconciler somebody may or may not run afterwards.
    expect(stopped.outcome).toBe('TASK_NOT_STARTED');
    expect(stopped.save?.ok).toBe(false);
    expect(stopped.save?.ok === false ? stopped.save.code : null).toBe('ENTRY_NOT_PROVEN');
    expect(onDisk(fixture.root)['stopReason']).toBeNull();
  }, 180_000);

  it('lets a run stop after its active task is given up on', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    expect(activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');

    driveToAborted(fixture, 'A-001');

    // Both refusals are correct: the task is neither finished nor blocked, and
    // `ABORTED` is terminal rather than blocking — nothing continues from it.
    expect(settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('TASK_STATE_DOES_NOT_PROVE_IT');
    expect(parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('TASK_STATE_DOES_NOT_PROVE_IT');

    // What must not follow is that the run is wedged. `stopBlockRun` refuses
    // while a task is ACTIVE, and if no call can move that task off ACTIVE the
    // run can never be stopped, never be completed and never be handed to an
    // operator with a reason. A block whose only remaining move is to falsify
    // one of its own records has been driven into a corner by its contract.
    //
    // The way out records what actually happened and nothing more: the task was
    // given up on, proven by its own `ABORTED` record and carrying the revision
    // that proved it.
    const abandoned = abandonBlockTask(reload(fixture.root), 'A-001', {
      repositoryRoot: fixture.root,
    });
    expect(abandoned.outcome).toBe('RECORDED');

    const truth = loadTaskState(fixture.root, 'A-001');
    if (!truth.ok) throw new Error('fixture: the task state vanished');
    const entry = reload(fixture.root).ledger.tasks.find((task) => task.taskId === 'A-001');
    expect(entry?.disposition).toBe('ABANDONED');
    expect(entry?.evidenceRevision).toBe(truth.revision);
    expect(entry?.resultCommit).toBeNull();

    const stopped = stopBlockRun(reload(fixture.root), 'TASK_ABANDONED', {
      repositoryRoot: fixture.root,
    });
    expect(stopped.outcome).toBe('RECORDED');
    expect(onDisk(fixture.root)['stopReason']).toBe('TASK_ABANDONED');

    // And abandoning is not a back door to completion: a block with a task
    // nobody finished cannot be recorded as finished.
    expect(reconcileBlockRun(reload(fixture.root).ledger, { repositoryRoot: fixture.root }).verdict)
      .toBe('CONSISTENT');
  }, 180_000);
});

/* ───────────────── cluster 3 — a terminal reason is history ─────────────── */

describe('cluster 3 — why a run stopped is not a label a later call may edit', () => {
  it('refuses to relabel a divergence as an operator decision', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);

    const first = stopBlockRun(reload(fixture.root), 'LEDGER_DIVERGED', {
      repositoryRoot: fixture.root,
    });
    expect(first.outcome).toBe('RECORDED');
    expect(onDisk(fixture.root)['stopReason']).toBe('LEDGER_DIVERGED');

    // `LEDGER_DIVERGED` is the most expensive thing a run can record about
    // itself: the ledger and the task records disagreed and the run must not
    // continue. Overwriting it with `OPERATOR_STOPPED` destroys the only
    // durable trace that a divergence was ever detected, and leaves an operator
    // reading a run that looks deliberately ended.
    const second = stopBlockRun(reload(fixture.root), 'OPERATOR_STOPPED', {
      repositoryRoot: fixture.root,
    });
    expect(second.outcome).toBe('RUN_ALREADY_STOPPED');
    expect(onDisk(fixture.root)['stopReason']).toBe('LEDGER_DIVERGED');

    // Refused at the gate too, not only by the caller's manners: a writer going
    // straight to the store with a current revision gets the same answer.
    const current = reload(fixture.root);
    const relabelled = updateBlockLedger(
      { ...current.ledger, stopReason: 'OPERATOR_STOPPED' as const },
      { repositoryRoot: fixture.root, expectedRevision: current.revision },
    );
    expect(relabelled.ok).toBe(false);
    expect(relabelled.ok ? '' : (relabelled.detail ?? '')).toContain('STOP_REASON_RELABELLED');
  }, 180_000);
});

/* ───────────────── cluster 4 — the commit fields stay provable ──────────── */

describe('cluster 4 — a commit field is re-derived, never taken on trust', () => {
  it('never reconciles CONSISTENT over a hand-edited result commit', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    const definition = block(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToReadyForPr(fixture, 'A-001');
    expect(settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');

    // Settlement-time provenance is sound: the entry records what the task's own
    // record says it ended at.
    const truth = loadTaskState(fixture.root, 'A-001');
    if (!truth.ok) throw new Error('fixture: the task state vanished');
    const honest = onDisk(fixture.root) as { tasks: Record<string, unknown>[] };
    expect(honest.tasks[0]?.['resultCommit']).toBe(truth.state.currentCommit);

    // The gap is afterwards. `evidenceRevision` is re-checked on every
    // reconciliation and the commit fields are not, so a forged chain base — a
    // perfectly-shaped object name that is not this task's and names nothing in
    // this repository — survives every later check. That is precisely the field
    // V2-09 intends to make a successor's base.
    honest.tasks[0]!['resultCommit'] = FORGED_SHA;
    honest.tasks[0]!['baseCommit'] = FORGED_SHA;
    writeFileSync(ledgerPath(fixture.root), `${JSON.stringify(honest, null, 2)}\n`, 'utf8');

    const loaded = loadBlockLedger(fixture.root, RUN_ID);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const before = readFileSync(ledgerPath(fixture.root));
    const beforeMtime = statSync(ledgerPath(fixture.root)).mtimeMs;
    const reconciled = reconcileBlockRun(loaded.ledger, {
      repositoryRoot: fixture.root,
      definition,
    });

    expect(reconciled.verdict).toBe('DIVERGED');
    expect(reconciled.findings).toEqual([
      { taskId: 'A-001', finding: 'COMMIT_NOT_PROVEN_BY_STATE' },
    ]);

    // And reconciliation still only reports: the observation half writes
    // nothing, however wrong the document it was handed.
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);
    expect(statSync(ledgerPath(fixture.root)).mtimeMs).toBe(beforeMtime);
  }, 180_000);
});

/* ───────────────── boundaries, pinned rather than moved ─────────────────── */

describe('the boundary V2-07 keeps, and the one it must not claim', () => {
  it('never lets one task’s record justify another task’s outcome', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);

    // B-001 is the only task that really ran, and it really finished.
    await reallyStart(fixture, 'B-001');
    driveToReadyForPr(fixture, 'B-001');

    // A-001 has no record at all. Its settlement must not be able to borrow
    // B-001's — asserted directly here rather than left to the incidental fact
    // that a state file is looked up by task id.
    expect(settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('TASK_NOT_STARTED');
    expect(parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('TASK_NOT_STARTED');

    const entryForA = reload(fixture.root).ledger.tasks.find((task) => task.taskId === 'A-001');
    expect(entryForA?.disposition).toBe('PLANNED');
    expect(entryForA?.evidenceRevision).toBeNull();

    // And the evidence B-001 does carry is B-001's own.
    expect(settleBlockTask(reload(fixture.root), 'B-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');
    const truth = loadTaskState(fixture.root, 'B-001');
    if (!truth.ok) throw new Error('fixture: the task state vanished');
    const entryForB = reload(fixture.root).ledger.tasks.find((task) => task.taskId === 'B-001');
    expect(entryForB?.evidenceRevision).toBe(truth.revision);
  }, 180_000);

  it('guarantees one active task per ledger, and does not pretend to guarantee one per repository', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001'], 'run-0001');
    startRun(fixture, ['A-001', 'B-001'], 'run-0002');
    await reallyStart(fixture, 'A-001');

    // Both runs activate the same task, and both are internally correct about
    // it. This is *not* a ledger defect and must not be fixed here: a ledger
    // knows only its own run, and two ledgers agreeing that a task is theirs is
    // exactly the absence of a repository-wide owner. Deciding which process
    // may produce effects for a task is the execution lease's contract, keyed
    // on the local Git identity rather than on the profile's repositoryId, and
    // it does not exist yet.
    for (const runId of ['run-0001', 'run-0002']) {
      expect(
        activateBlockTask(reload(fixture.root, runId), 'A-001', { repositoryRoot: fixture.root })
          .outcome,
      ).toBe('RECORDED');
    }

    for (const runId of ['run-0001', 'run-0002']) {
      const ledger = reload(fixture.root, runId).ledger;
      // The guarantee V2-07 does hold, stated exactly: at most one ACTIVE task
      // in this ledger, and it is the one activeTaskId names.
      expect(ledger.tasks.filter((task) => task.disposition === 'ACTIVE')).toHaveLength(1);
      expect(ledger.activeTaskId).toBe('A-001');
    }
  }, 180_000);

  it('leaves the checkout clean when it writes', async () => {
    const fixture = await repoWithTasks(['A-001']);
    startRun(fixture, ['A-001']);
    const status = await runGitCommand(fixture.root, ['status', '--porcelain']);
    expect(status.outcome).toBe('OK');
    expect(status.outcome === 'OK' ? status.stdout : 'not run').toBe('');
  }, 180_000);
});

/* ───────────────── the run the contract exists to record ───────────────── */

describe('a tightened gate still passes an honest run', () => {
  it('records a block whose every task really finished as COMPLETE', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);

    // `COMPLETE` is now proved against every task's own record rather than
    // against the entries claiming it, and a proof strong enough to refuse a
    // forgery is a proof that could quietly make the honest case unreachable.
    // This is the case it must not: two tasks, really started, really finished.
    for (const taskId of ['A-001', 'B-001']) {
      await reallyStart(fixture, taskId);
      expect(
        activateBlockTask(reload(fixture.root), taskId, { repositoryRoot: fixture.root }).outcome,
      ).toBe('RECORDED');
      driveToReadyForPr(fixture, taskId);
      expect(
        settleBlockTask(reload(fixture.root), taskId, { repositoryRoot: fixture.root }).outcome,
      ).toBe('RECORDED');
    }

    const stopped = stopBlockRun(reload(fixture.root), 'COMPLETE', {
      repositoryRoot: fixture.root,
    });

    expect(stopped.outcome).toBe('RECORDED');
    expect(onDisk(fixture.root)['stopReason']).toBe('COMPLETE');
    expect(reconcileBlockRun(reload(fixture.root).ledger, { repositoryRoot: fixture.root }))
      .toEqual({ verdict: 'CONSISTENT', findings: [], progressAvailable: false });
  }, 180_000);

  it('records a genuinely blocked task, and then refuses to progress the run', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    expect(activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');

    const loaded = loadTaskState(fixture.root, 'A-001');
    if (!loaded.ok) throw new Error('fixture: the task never started');
    // `SCOPE_VIOLATION` rather than one of the resumable blocks: it is blocking
    // by the state contract's own classification and carries no resume point,
    // so the fixture states one fact and not three.
    const blocked = saveTaskState(
      {
        ...loaded.state,
        state: 'SCOPE_VIOLATION',
        stateEnteredAt: '2026-08-11T12:00:00.000Z',
        blockedAgent: 'claude',
      },
      { repositoryRoot: fixture.root, expectedRevision: loaded.revision },
    );
    if (!blocked.ok) throw new Error(`fixture could not reach a blocking state: ${blocked.code}`);

    expect(parkBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');
    expect(onDisk(fixture.root)['stopReason']).toBe('TASK_BLOCKED');

    // A stopped run does not quietly keep going. Refused as its own outcome,
    // because the task's disposition is not what stands in the way — the run's
    // own ending is, and an operator reading the two goes to different places.
    expect(activateBlockTask(reload(fixture.root), 'B-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RUN_ALREADY_STOPPED');
  }, 180_000);
});

/* ───────────────── the fingerprint separator ────────────────────────────── */

describe('the definition fingerprint separator', () => {
  it('is written as an escape, and still digests exactly what it used to', () => {
    const source = readFileSync(new URL('../src/block/block-definition.ts', import.meta.url));

    // A raw NUL byte in a source file is invisible in every editor, every diff
    // and every review — and this one is load-bearing: it is the separator that
    // makes two different definitions unable to encode to one string. Written
    // as an escape it is the same value and a readable one.
    expect(source.includes(0)).toBe(false);

    // Same value, proven rather than asserted: the digest is compared with one
    // computed here from an independently constructed NUL separator, so the
    // change cannot silently move any existing fingerprint.
    const definition = block(['A-001', 'B-001']);
    const separator = String.fromCharCode(0);
    const expected = createHash('sha256')
      .update(['V2', 'A-001', 'B-001'].join(separator), 'utf8')
      .digest('hex');
    expect(fingerprintBlockDefinition(definition)).toBe(expected);
  });
});
