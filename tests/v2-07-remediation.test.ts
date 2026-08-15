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

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  defineBlock,
  fingerprintBlockDefinition,
  fingerprintFrozenMembership,
  isValidBlockId,
} from '../src/block/block-definition.js';
import {
  assessLedgerSuccession,
  BlockRunLedgerObjectSchema,
  safeParseBlockRunLedger,
} from '../src/block/block-ledger.js';
import {
  abandonBlockTask,
  activateBlockTask,
  parkBlockTask,
  settleBlockTask,
  startBlockRun,
  stopBlockRun,
} from '../src/block/block-progress.js';
import {
  createBlockLedger,
  loadBlockLedger,
  updateBlockLedger,
} from '../src/block/block-store.js';
import { reconcileBlockRun } from '../src/block/reconcile-block.js';
import { startTask } from '../src/run/start-task.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';
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
    { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: leaseFor(fixture.repository) },
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
      frozenDependencies: [{ taskId: 'A-001', dependsOn: [] }],
      planFingerprint: fingerprintFrozenMembership('V9', ['A-001'], [
        { taskId: 'A-001', dependsOn: [] },
      ]),
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

/* ───────────────── gaps the remediation itself opened ──────────────────── */

describe('the doors the remediation had to close behind itself', () => {
  it('refuses a first ledger that claims progress before the run has started', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001'], 'run-0001');
    const honest = reload(fixture.root, 'run-0001').ledger;

    // Splitting the store gave `updateBlockLedger` a predecessor to be held
    // against — and left creation with none. Under a run id nothing has
    // written, a first ledger needs no predecessor and no revision, so an
    // unguarded creation is the same forged `COMPLETE` through a door the
    // update path had just been taught to refuse.
    const forgedFirst = {
      ...honest,
      runId: 'run-0002',
      activeTaskId: null,
      tasks: honest.tasks.map((task) => ({
        ...task,
        disposition: 'SETTLED' as const,
        evidenceRevision: FORGED_REVISION,
        baseCommit: FORGED_SHA,
        resultCommit: FORGED_SHA,
      })),
      stopReason: 'COMPLETE' as const,
    };
    // It is a perfectly valid ledger; what it is not is a valid *creation*.
    expect(safeParseBlockRunLedger(forgedFirst).success).toBe(true);

    const created = createBlockLedger(forgedFirst, { repositoryRoot: fixture.root });

    expect(created.ok).toBe(false);
    expect(created.ok ? null : created.detail).toBe('CREATION_MUST_CLAIM_NO_PROGRESS');
    expect(existsSync(ledgerPath(fixture.root, 'run-0002'))).toBe(false);
  }, 180_000);

  it('will not carry a forged sibling entry forward on a legitimate step', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);

    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToReadyForPr(fixture, 'A-001');
    expect(settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');

    // A-001's settlement is honest. It is then forged on disk, by hand.
    const tampered = onDisk(fixture.root) as { tasks: Record<string, unknown>[] };
    tampered.tasks[0]!['resultCommit'] = FORGED_SHA;
    writeFileSync(ledgerPath(fixture.root), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    // Proving only the entry a write *moves* looks sufficient and is not: a
    // write re-serialises the whole document, so the forgery would ride out on
    // the next legitimate activation, carried forward under the store's
    // signature having been examined by nothing. There is also no such thing as
    // progressing a run whose record is already unsupported.
    await reallyStart(fixture, 'B-001');
    const activated = activateBlockTask(reload(fixture.root), 'B-001', {
      repositoryRoot: fixture.root,
    });
    expect(activated.outcome).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
    expect(activated.save?.ok === false ? activated.save.code : null).toBe('ENTRY_NOT_PROVEN');
    expect((onDisk(fixture.root) as { tasks: Record<string, unknown>[] }).tasks[1]!['disposition'])
      .toBe('PLANNED');

    // And the escape hatch is open, which is the whole reason the rule is not
    // "prove everything, always": the one move a run with an unsupported
    // ledger must always have is saying so.
    const stopped = stopBlockRun(reload(fixture.root), 'LEDGER_DIVERGED', {
      repositoryRoot: fixture.root,
    });
    expect(stopped.outcome).toBe('RECORDED');
    expect(onDisk(fixture.root)['stopReason']).toBe('LEDGER_DIVERGED');
  }, 180_000);

  it('reconciles nothing against a repository the ledger does not describe', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    const honest = reload(fixture.root).ledger;

    // `loadBlockLedger` holds `repositoryId` against the profile, but
    // `reconcileBlockRun` takes a ledger *value* and a root — and a value did
    // not have to come through the store to get here. Every task record it
    // would read is looked up under that root, so a ledger describing another
    // project is not slightly wrong, it is asking about somebody else's tasks.
    const foreign = reconcileBlockRun(
      { ...honest, repositoryId: 'a-different-project' },
      { repositoryRoot: fixture.root },
    );

    expect(foreign.verdict).toBe('DIVERGED');
    expect(foreign.findings).toContainEqual({
      taskId: BLOCK_ID,
      finding: 'REPOSITORY_IDENTITY_DRIFTED',
    });

    // And the honest one still answers about this repository.
    expect(reconcileBlockRun(honest, { repositoryRoot: fixture.root }).verdict).toBe('CONSISTENT');
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

  it('records a genuinely blocked task, and leaves the run open', async () => {
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
    // V2-08 reversed this. The park used to write TASK_BLOCKED, which ended the
    // run; the disposition and its evidence are unchanged, and only the run's
    // reaction to them moved. The continuation case itself lives in
    // tests/v2-08-attended-block-runner.test.ts, beside the policy it belongs to.
    expect(onDisk(fixture.root)['stopReason']).toBeNull();
  }, 180_000);
});

/* ────────── the contract the second adversarial review settled ─────────── */

/** Where a task's own durable record lives, so a probe can take it away. */
function taskStatePath(root: string, taskId: string): string {
  return join(root, '.agent-orchestrator', 'runtime', `${taskId}.json`);
}

describe('a run may record that it stopped while a task was still unresolved', () => {
  it('records STATE_UNUSABLE over an active task whose record has gone, and moves nothing else', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    expect(activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');

    const before = reload(fixture.root).ledger;

    // The task's own record disappears. No forgery, no adversary: a crash
    // mid-write, or `git clean -xfd` over the gitignored runtime directory.
    // Nothing in the ledger is touched.
    rmSync(taskStatePath(fixture.root, 'A-001'));

    // Every outcome-bearing move is now correctly unprovable — no record proves
    // settlement, blocking or abandonment.
    for (const move of [settleBlockTask, parkBlockTask, abandonBlockTask]) {
      expect(move(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
        .toBe('TASK_NOT_STARTED');
    }

    // Which is precisely the situation `STATE_UNUSABLE` is a stop reason for.
    // While clearing `activeTaskId` first was required, no call could move the
    // entry off ACTIVE, so this stop could never be written: the run could see
    // the fault and never record it, and the only move left was to edit the
    // ledger by hand — the one thing this module exists to prevent.
    const stopped = stopBlockRun(reload(fixture.root), 'STATE_UNUSABLE', {
      repositoryRoot: fixture.root,
    });
    expect(stopped.outcome).toBe('RECORDED');

    const after = reload(fixture.root).ledger;
    expect(after.stopReason).toBe('STATE_UNUSABLE');
    // The honest record, and only it: the block stopped, and this task was
    // still unresolved when it did. Not rewound to PLANNED — which would claim
    // it was never started — and not given an outcome nothing proved.
    expect(after.activeTaskId).toBe('A-001');
    expect(after.tasks[0]?.disposition).toBe('ACTIVE');
    expect(after.tasks).toEqual(before.tasks);

    // And the stop does not launder the fault. The reconciler still names it.
    const reconciled = reconcileBlockRun(after, { repositoryRoot: fixture.root });
    expect(reconciled.verdict).toBe('DIVERGED');
    expect(reconciled.findings).toContainEqual({
      taskId: 'A-001',
      finding: 'ACTIVE_WITHOUT_TASK_STATE',
    });
  }, 180_000);

  it('holds that stop to saying only that the run stopped', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    await reallyStart(fixture, 'B-001');
    driveToReadyForPr(fixture, 'B-001');

    const current = reload(fixture.root);
    const before = readFileSync(ledgerPath(fixture.root));

    // This write is the one exempt from the evidence proof, because the whole
    // point is that no evidence is available. An exempt write that could also
    // carry a commit, a disposition or a rewritten identity would be the widest
    // hole in the module rather than its narrowest allowance. Each successor
    // below stops the run *and* smuggles one extra thing, keeping the task
    // active so the exemption is the rule being tested.
    const smuggles: Record<string, unknown> = {
      'a base commit onto the unresolved task': {
        ...current.ledger,
        stopReason: 'LEDGER_DIVERGED' as const,
        tasks: current.ledger.tasks.map((task) =>
          task.taskId === 'A-001' ? { ...task, baseCommit: FORGED_SHA } : task,
        ),
      },
      'a genuinely provable settlement of the neighbour': {
        ...current.ledger,
        stopReason: 'LEDGER_DIVERGED' as const,
        tasks: current.ledger.tasks.map((task) =>
          task.taskId === 'B-001'
            ? {
                ...task,
                disposition: 'SETTLED' as const,
                evidenceRevision: (() => {
                  const state = loadTaskState(fixture.root, 'B-001');
                  return state.ok ? state.revision : FORGED_REVISION;
                })(),
                baseCommit: (() => {
                  const state = loadTaskState(fixture.root, 'B-001');
                  return state.ok ? state.state.basePinnedCommit : FORGED_SHA;
                })(),
                resultCommit: (() => {
                  const state = loadTaskState(fixture.root, 'B-001');
                  return state.ok ? state.state.currentCommit : FORGED_SHA;
                })(),
              }
            : task,
        ),
      },
      'a backdated start': {
        ...current.ledger,
        stopReason: 'LEDGER_DIVERGED' as const,
        startedAt: '2020-01-01T00:00:00.000Z',
      },
    };

    for (const [what, successor] of Object.entries(smuggles)) {
      const saved = updateBlockLedger(successor, {
        repositoryRoot: fixture.root,
        expectedRevision: current.revision,
      });

      expect(saved.ok, what).toBe(false);
      expect(saved.ok ? null : saved.code, what).toBe('LEDGER_SUCCESSION_REFUSED');
      expect(saved.ok ? '' : (saved.detail ?? ''), what).toContain('UNRESOLVED_STOP_CARRIED_MORE');
      expect(readFileSync(ledgerPath(fixture.root)).equals(before), what).toBe(true);
    }

    // The bare stop, by contrast, lands.
    expect(stopBlockRun(reload(fixture.root), 'LEDGER_DIVERGED', { repositoryRoot: fixture.root })
      .outcome).toBe('RECORDED');
    expect(onDisk(fixture.root)['stopReason']).toBe('LEDGER_DIVERGED');
  }, 180_000);

  it('still refuses to claim an outcome for the tasks while one is unresolved', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });

    // The relaxation is for reasons that claim nothing about the tasks. A
    // reason that does claim something is still an outcome for a task nobody
    // looked at, and the contract refuses the document outright.
    for (const reason of ['COMPLETE', 'TASK_BLOCKED', 'TASK_ABANDONED'] as const) {
      expect(stopBlockRun(reload(fixture.root), reason, { repositoryRoot: fixture.root }).outcome)
        .toBe('ANOTHER_TASK_ACTIVE');
      expect(
        safeParseBlockRunLedger({ ...reload(fixture.root).ledger, stopReason: reason }).success,
      ).toBe(false);
    }
    expect(onDisk(fixture.root)['stopReason']).toBeNull();
  }, 180_000);
});

describe('a run that has ended has a past, not a present', () => {
  it('refuses later progress at the store, not only at the layer above it', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToReadyForPr(fixture, 'A-001');

    // The run ends while still holding A-001 — the write the rule above makes
    // possible.
    expect(stopBlockRun(reload(fixture.root), 'LEDGER_DIVERGED', { repositoryRoot: fixture.root })
      .outcome).toBe('RECORDED');

    const current = reload(fixture.root);
    const before = readFileSync(ledgerPath(fixture.root));

    // The progress API refuses, as it always did. That is manners, and manners
    // are walked around by going one layer down.
    expect(settleBlockTask(current, 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RUN_ALREADY_STOPPED');

    // The successor below is entirely honest: A-001 really is READY_FOR_PR, and
    // the evidence is its own current revision, so the proof at the gate would
    // pass it. It is refused anyway — because a run that has recorded why it is
    // not continuing does not then continue, and that has to be a rule of the
    // contract rather than a habit of one caller.
    const truth = loadTaskState(fixture.root, 'A-001');
    if (!truth.ok) throw new Error('fixture: the task state vanished');
    const progressed = updateBlockLedger(
      {
        ...current.ledger,
        activeTaskId: null,
        tasks: current.ledger.tasks.map((task) =>
          task.taskId === 'A-001'
            ? {
                ...task,
                disposition: 'SETTLED' as const,
                evidenceRevision: truth.revision,
                baseCommit: truth.state.basePinnedCommit,
                resultCommit: truth.state.currentCommit,
              }
            : task,
        ),
      },
      { repositoryRoot: fixture.root, expectedRevision: current.revision },
    );

    expect(progressed.ok).toBe(false);
    expect(progressed.ok ? null : progressed.code).toBe('LEDGER_SUCCESSION_REFUSED');
    expect(progressed.ok ? '' : (progressed.detail ?? '')).toContain('STOPPED_RUN_PROGRESSED');
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);
  }, 180_000);
});

describe('drift is answered against a fingerprint the reconciler derives itself', () => {
  it('cannot be inverted by a ledger value carrying a foreign fingerprint', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001', 'C-001']);
    startRun(fixture, ['A-001', 'B-001', 'C-001']);
    const persisted = reload(fixture.root).ledger;

    const honest = block(['A-001', 'B-001', 'C-001']);
    const edited = block(['A-001', 'C-001', 'B-001']);

    // A ledger *value* that never came through the store: it lists the honest
    // plan and carries the digest of the edited one. `reconcileBlockRun` takes
    // a value, so nothing forced it through the schema that re-derives the
    // field — which is exactly the door the store does not stand in.
    const lying = { ...persisted, planFingerprint: fingerprintBlockDefinition(edited) };
    expect(safeParseBlockRunLedger(lying).success).toBe(false);

    const findingsOf = (ledger: typeof persisted, definition: typeof honest): string[] =>
      reconcileBlockRun(ledger, { repositoryRoot: fixture.root, definition }).findings.map(
        (entry) => entry.finding,
      );

    // Believing the stored field inverts both answers: the edited roadmap
    // reports clean and the honest one reports drifted. Deriving the frozen
    // membership from the document's own two plan fields is what makes the
    // stored digest unable to decide anything.
    expect(findingsOf(lying, edited)).toContain('DEFINITION_DRIFTED');
    expect(findingsOf(lying, honest)).not.toContain('DEFINITION_DRIFTED');

    // And the unsound field is reported in its own right, rather than silently
    // ignored: a ledger whose stored digest does not describe its own plan did
    // not come through the store, and that is worth saying.
    expect(findingsOf(lying, honest)).toContain('PLAN_FINGERPRINT_UNSOUND');
    expect(reconcileBlockRun(lying, { repositoryRoot: fixture.root }).verdict).toBe('DIVERGED');

    // The persisted ledger still answers drift the one honest way.
    expect(findingsOf(persisted, honest)).toEqual([]);
    expect(findingsOf(persisted, edited)).toEqual(['DEFINITION_DRIFTED']);
  }, 180_000);
});

describe('the limits this slice does not claim', () => {
  it('loses a ledger write to a concurrent writer, which is why the lease comes first', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);

    // Two writers read the same ledger and each hold a current revision.
    const first = reload(fixture.root);
    const second = reload(fixture.root);
    expect(first.revision).toBe(second.revision);

    // The second lands entirely while the first is between its revision check
    // and its rename. `replace` is the store's own seam and is used here to
    // make the interleaving deterministic — it does not create the window,
    // which is in the ordering of the real code path: read, compare, stage,
    // flush, then an unconditional move.
    const winner = updateBlockLedger(
      { ...first.ledger, stopReason: 'OPERATOR_STOPPED' as const },
      {
        repositoryRoot: fixture.root,
        expectedRevision: first.revision,
        replace: (from, to) => {
          const loser = updateBlockLedger(
            { ...second.ledger, stopReason: 'LEDGER_DIVERGED' as const },
            { repositoryRoot: fixture.root, expectedRevision: second.revision },
          );
          expect(loser.ok).toBe(true);
          renameSync(from, to);
        },
      },
    );

    // Both writers were told they had succeeded, and the divergence one of them
    // recorded is gone. This is the known single-writer limitation, pinned so
    // that it stays known: a compare-and-swap answers "has anybody written
    // since my revision?", and answering it is not the same as holding the
    // file. Closing it needs a repository-wide owner — the execution lease,
    // which is why that now comes before the block runner rather than after it.
    expect(winner.ok).toBe(true);
    expect(onDisk(fixture.root)['stopReason']).toBe('OPERATOR_STOPPED');
  }, 180_000);
});

/* ───────────────── gaps the counter-proofs had left ─────────────────────── */

describe('rules that were contract but not yet counter-proved', () => {
  it('refuses an edit to an entry whose disposition did not move', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToReadyForPr(fixture, 'A-001');
    expect(settleBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root }).outcome)
      .toBe('RECORDED');

    const current = reload(fixture.root);
    const before = readFileSync(ledgerPath(fixture.root));

    // Nothing re-proves an entry whose disposition does not move, which is
    // exactly why "a record that did not move did not change" has to be its own
    // rule. The field being rewritten here is the one V2-09 intends to make a
    // successor's base.
    const edited = {
      ...current.ledger,
      tasks: current.ledger.tasks.map((task) =>
        task.taskId === 'A-001' ? { ...task, resultCommit: FORGED_SHA } : task,
      ),
    };
    const saved = updateBlockLedger(edited, {
      repositoryRoot: fixture.root,
      expectedRevision: current.revision,
    });

    expect(saved.ok).toBe(false);
    expect(saved.ok ? null : saved.code).toBe('LEDGER_SUCCESSION_REFUSED');
    expect(saved.ok ? '' : (saved.detail ?? '')).toContain('RECORDED_ENTRY_CHANGED');
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);
  }, 180_000);

  it('reports an abandoned entry whose record never reached ABORTED', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    driveToReadyForPr(fixture, 'A-001');

    const truth = loadTaskState(fixture.root, 'A-001');
    if (!truth.ok) throw new Error('fixture: the task state vanished');

    // A-001 finished. The ledger is edited to say it was given up on instead,
    // carrying the revision that is genuinely current — so the evidence check
    // passes it and only the *state it points at* can refuse the claim.
    const forged = onDisk(fixture.root) as { tasks: Record<string, unknown>[] };
    forged.tasks[0]!['disposition'] = 'ABANDONED';
    forged.tasks[0]!['evidenceRevision'] = truth.revision;
    forged.tasks[0]!['baseCommit'] = truth.state.basePinnedCommit;
    writeFileSync(ledgerPath(fixture.root), `${JSON.stringify(forged, null, 2)}\n`, 'utf8');

    const loaded = loadBlockLedger(fixture.root, RUN_ID);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const reconciled = reconcileBlockRun(loaded.ledger, { repositoryRoot: fixture.root });

    // Settling and abandoning must never be reachable from one record:
    // READY_FOR_PR is terminal too, and a run that claims it gave up on work
    // that actually finished is as wrong as the reverse.
    expect(reconciled.verdict).toBe('DIVERGED');
    expect(reconciled.findings).toContainEqual({
      taskId: 'A-001',
      finding: 'ABANDONED_WITHOUT_ABORTED_STATE',
    });
  }, 180_000);

  it('refuses a block whose id is also one of its own tasks', () => {
    const defined = defineBlock('A-001', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: [] },
    ]);

    expect(defined.ok).toBe(false);
    expect(defined.ok ? null : defined.code).toBe('BLOCK_ID_COLLIDES_WITH_TASK');

    // The two grammars are deliberately one rule, so an id alone never says
    // which of the two it names — and a reconciliation files findings about the
    // block under the same field it uses for findings about a task.
    expect(isValidBlockId('A-001')).toBe(true);
  });
});

/* ────────── the successor contract's own completeness ──────────────────── */

/**
 * A run mid-flight on A-001, built here rather than persisted: these cases ask
 * about the *relation* between two documents, which is what
 * `assessLedgerSuccession` answers, and the hostile inputs below could not
 * survive the store on their way in.
 */
const midFlight = {
  schemaVersion: 2,
  repositoryId: 'fixture',
  repositoryRoot: 'D:\\repo',
  blockId: BLOCK_ID,
  runId: RUN_ID,
  startedAt: NOW,
  frozenTaskIds: ['A-001', 'B-001'],
  frozenDependencies: [
    { taskId: 'A-001', dependsOn: [] },
    { taskId: 'B-001', dependsOn: [] },
  ],
  planFingerprint: fingerprintFrozenMembership(BLOCK_ID, ['A-001', 'B-001'], [
    { taskId: 'A-001', dependsOn: [] },
    { taskId: 'B-001', dependsOn: [] },
  ]),
  activeTaskId: 'A-001',
  tasks: [
    {
      taskId: 'A-001',
      disposition: 'ACTIVE' as const,
      evidenceRevision: null,
      baseCommit: 'a'.repeat(40),
      resultCommit: null,
    },
    {
      taskId: 'B-001',
      disposition: 'PLANNED' as const,
      evidenceRevision: null,
      baseCommit: null,
      resultCommit: null,
    },
  ],
  stopReason: null,
};

/** The same run after it ended, with nothing left unresolved. */
const stoppedRun = {
  ...midFlight,
  activeTaskId: null,
  tasks: midFlight.tasks.map((task) => ({
    ...task,
    disposition: 'PLANNED' as const,
    baseCommit: null,
  })),
  stopReason: 'NO_ELIGIBLE_TASK' as const,
};

describe('the successor contract is complete by construction, not by memory', () => {
  it('permits the unresolved stop it exists to allow', () => {
    // The control. Without it the two refusals below could both be passing
    // because the fixture is malformed rather than because the rule works.
    expect(safeParseBlockRunLedger(midFlight).success).toBe(true);
    expect(assessLedgerSuccession(midFlight, { ...midFlight, stopReason: 'STATE_UNUSABLE' }))
      .toEqual([]);
  });

  it('refuses a field the contract has never been told about, on the exempt stop', () => {
    // Both documents carry a field the schema does not declare, and succession
    // is called directly. That is deliberate, and it is the only way to ask the
    // question: `.strict()` keeps an unknown key out of every document today, so
    // this does not stand for a hostile caller. It stands for the day a field is
    // added to the schema and this gate is not updated with it.
    //
    // The write it guards is the one exempt from the evidence proof, because no
    // evidence is available for it — so nothing downstream will ever examine
    // what it carried. A gate that is complete only by somebody remembering to
    // keep it complete fails open exactly where nobody is looking, which is the
    // same defect class the rest of this file exists to close.
    const previous = { ...midFlight, ownerLeaseId: 'lease-1' };
    const next = {
      ...midFlight,
      stopReason: 'STATE_UNUSABLE' as const,
      ownerLeaseId: 'lease-2-stolen',
    };

    expect(assessLedgerSuccession(previous, next)).toContain('UNRESOLVED_STOP_CARRIED_MORE');
  });

  it('refuses an unknown field on an entry whose disposition did not move', () => {
    // The same argument one level down: "a record that did not move did not
    // change" has to mean the whole record, not the fields somebody listed.
    const previous = {
      ...midFlight,
      tasks: midFlight.tasks.map((task) => ({ ...task, ownerLeaseId: 'lease-1' })),
    };
    const next = {
      ...previous,
      tasks: previous.tasks.map((task, index) =>
        index === 0 ? { ...task, ownerLeaseId: 'lease-2-stolen' } : task,
      ),
    };

    expect(assessLedgerSuccession(previous, next)).toContain('RECORDED_ENTRY_CHANGED');
  });

  it('refuses a new entry field that rides out on a legal disposition move', () => {
    // The gap the two cases above leave, and the reason "one level down" was
    // not finished by making `sameEntry` structural. That comparison is only
    // reached when the disposition did *not* move. When it does move, the entry
    // legitimately changes — so the question is not "did it change" but "did it
    // change in more than the fields something re-derives from the task record".
    //
    // Without that distinction a new entry field mutates freely on every
    // legitimate step: succession looks only at the disposition, and
    // `proveBlockTaskEntry` reads five fields by name, so neither gate sees it.
    const previous = {
      ...midFlight,
      tasks: midFlight.tasks.map((task) => ({ ...task, ownerLeaseId: 'lease-1' })),
    };
    const settled = {
      ...previous,
      activeTaskId: null,
      tasks: previous.tasks.map((task, index) =>
        index === 0
          ? {
              ...task,
              disposition: 'SETTLED' as const,
              evidenceRevision: 'c'.repeat(64),
              resultCommit: 'd'.repeat(40),
            }
          : task,
      ),
    };

    // The control: ACTIVE → SETTLED is legal, and the three fields it rewrites
    // are each re-derived at the write gate, so the move on its own is allowed.
    expect(assessLedgerSuccession(previous, settled)).toEqual([]);

    // The same move, carrying one field nothing re-derives.
    const withRider = {
      ...settled,
      tasks: settled.tasks.map((task, index) =>
        index === 0 ? { ...task, ownerLeaseId: 'lease-2-stolen' } : task,
      ),
    };
    expect(assessLedgerSuccession(previous, withRider)).toContain('MOVED_ENTRY_CARRIED_MORE');
  });

  it('permits a stopped run no successor but the one identical to it', () => {
    // A run that has ended has a past, not a present — and until now that was
    // enforced by naming the entries and `activeTaskId`, which is the same
    // hand-maintained list this file exists to remove, sited at the strictest
    // state in the contract.
    expect(safeParseBlockRunLedger(stoppedRun).success).toBe(true);
    expect(assessLedgerSuccession(stoppedRun, { ...stoppedRun })).toEqual([]);

    const previous = { ...stoppedRun, ownerLeaseId: 'lease-1' };
    const next = { ...stoppedRun, ownerLeaseId: 'lease-2-stolen' };
    expect(assessLedgerSuccession(previous, next)).toContain('STOPPED_RUN_PROGRESSED');
  });
});

/* ────────── the entry contract's escape hatch, held to its minimum ─────── */

describe('a re-proved entry field is really re-proved', () => {
  /**
   * `REPROVED` is the entry contract's one exemption: those fields *may* change
   * on a legal disposition move, because something else on the same write
   * decides what they are allowed to become. That is an assertion about a rule
   * kept in another module — and an assertion nobody checks is exactly how an
   * escape hatch becomes the widest hole in a contract rather than its narrowest
   * allowance.
   *
   * `PINNED` needs no test like this: it is enforced by derivation, by not
   * appearing in the projection. This is the other class paying its way.
   */
  it('refuses a forged value for every field a move is allowed to rewrite', async () => {
    const fixture = await repoWithTasks(['A-001', 'B-001']);
    startRun(fixture, ['A-001', 'B-001']);
    await reallyStart(fixture, 'A-001');
    activateBlockTask(reload(fixture.root), 'A-001', { repositoryRoot: fixture.root });
    driveToReadyForPr(fixture, 'A-001');

    const current = reload(fixture.root);
    const before = readFileSync(ledgerPath(fixture.root));
    const truth = loadTaskState(fixture.root, 'A-001');
    expect(truth.ok).toBe(true);
    if (!truth.ok) return;

    // ACTIVE → SETTLED is legal, and rewrites all three non-disposition
    // REPROVED fields at once. Every value below is the task record's own.
    const proven = {
      taskId: 'A-001',
      disposition: 'SETTLED' as const,
      evidenceRevision: truth.revision,
      baseCommit: truth.state.basePinnedCommit,
      resultCommit: truth.state.currentCommit,
    };
    const settledWith = (over: Record<string, unknown>) => ({
      ...current.ledger,
      activeTaskId: null,
      tasks: current.ledger.tasks.map((task) =>
        task.taskId === 'A-001' ? { ...proven, ...over } : task,
      ),
    });
    const attempt = (over: Record<string, unknown>) =>
      updateBlockLedger(settledWith(over), {
        repositoryRoot: fixture.root,
        expectedRevision: current.revision,
      });

    // One forgery per field, each riding a move that is otherwise entirely
    // honest — so nothing but that field's own re-derivation can refuse it.
    for (const [field, forged] of [
      ['evidenceRevision', 'c'.repeat(64)],
      ['baseCommit', FORGED_SHA],
      ['resultCommit', FORGED_SHA],
    ] as const) {
      const saved = attempt({ [field]: forged });
      expect(saved.ok, field).toBe(false);
      expect(saved.ok ? null : saved.code, field).toBe('ENTRY_NOT_PROVEN');
      expect(readFileSync(ledgerPath(fixture.root)).equals(before), field).toBe(true);
    }

    // The fourth prover, which cannot be reached by editing a field of the
    // settlement: forging `disposition` *is* choosing a different move. A-001's
    // record proves READY_FOR_PR, so ABANDONED is a legal edge out of ACTIVE
    // that the record does not support — and it must be the disposition prover
    // that says so, not the schema, which accepts this document.
    const abandoned = {
      ...current.ledger,
      activeTaskId: null,
      tasks: current.ledger.tasks.map((task) =>
        task.taskId === 'A-001'
          ? {
              taskId: 'A-001',
              disposition: 'ABANDONED' as const,
              evidenceRevision: truth.revision,
              baseCommit: truth.state.basePinnedCommit,
              resultCommit: null,
            }
          : task,
      ),
    };
    expect(safeParseBlockRunLedger(abandoned).success).toBe(true);
    const forgedMove = updateBlockLedger(abandoned, {
      repositoryRoot: fixture.root,
      expectedRevision: current.revision,
    });
    expect(forgedMove.ok).toBe(false);
    expect(forgedMove.ok ? null : forgedMove.code).toBe('ENTRY_NOT_PROVEN');
    expect(readFileSync(ledgerPath(fixture.root)).equals(before)).toBe(true);

    // The control, last because it is the one that writes: the same move with
    // nothing forged is accepted. Without it the refusals above could all be
    // passing because the move itself was malformed.
    const honest = attempt({});
    expect(honest.ok).toBe(true);
  }, 180_000);
});

/* ────────── schema growth cannot land without a counter-proof ──────────── */

describe('a new persisted field cannot arrive without one of these tests moving', () => {
  /**
   * The half a classification map cannot cover.
   *
   * `FIELD_AUTHORITY` and `ENTRY_FIELD_AUTHORITY` force a *decision* about any
   * field added to the schema — that is a compile error, and it works. Neither
   * forces that decision to be **right**, and two of the four top-level classes
   * (`RECORD`, `STOP_REASON`) plus one of the two entry classes (`REPROVED`)
   * derive no rule at all: a new field placed in any of them compiles, and on an
   * ordinary update nothing looks at it again.
   *
   * That division is deliberate and documented — those classes name authority
   * kept elsewhere rather than pretending to hold it here. What must not happen
   * is a field arriving in one of them because it was the quiet option. So the
   * declared field lists are pinned, and growing either one turns this red with
   * the obligation written out.
   *
   * Read from the schema object rather than from a parsed fixture. A fixture
   * stops parsing the moment the schema grows a required field, so a document
   * would make this fail with "the fixture is invalid" — true, useless, and
   * pointing at the wrong file. The schema always knows its own keys.
   */
  const shapeOf = (schema: unknown): string[] =>
    Object.keys((schema as { shape: Record<string, unknown> }).shape);
  const entrySchema = (BlockRunLedgerObjectSchema.shape.tasks as unknown as {
    element: unknown;
  }).element;

  it('pins the persisted top-level fields', () => {
    // Grew a top-level field? `FIELD_AUTHORITY` already made you classify it.
    // If you chose IDENTITY or FROZEN_PLAN it is enforced by that choice — add
    // it here and to the per-field mutation cases below. If you chose RECORD or
    // STOP_REASON you have said its authority lives somewhere else: name that
    // rule in the map's comment and counter-prove it, because succession will
    // not look at this field again on an ordinary update.
    expect(shapeOf(BlockRunLedgerObjectSchema)).toEqual([
      'schemaVersion',
      'repositoryId',
      'repositoryRoot',
      'blockId',
      'runId',
      'startedAt',
      'frozenTaskIds',
      'frozenDependencies',
      'planFingerprint',
      'activeTaskId',
      'tasks',
      'stopReason',
    ]);
  });

  it('pins the persisted entry fields', () => {
    // Grew an entry field? PINNED needs nothing but this line: the projection
    // in `onlyReprovedFieldsChanged` covers it by not mentioning it. REPROVED
    // needs a counter-proof in the suite above, because that class is an
    // assertion that another gate re-derives the field — and a REPROVED field
    // nothing re-derives is persistable, forged, on any legitimate step.
    expect(shapeOf(entrySchema)).toEqual([
      'taskId',
      'disposition',
      'evidenceRevision',
      'baseCommit',
      'resultCommit',
    ]);
  });
});

/* ────────── each classification pinned by its own mutation ─────────────── */

describe('every persisted field’s authority is pinned by its own mutation', () => {
  /**
   * One mutation per persisted field, each with the verdict it must produce
   * written out by hand from the documented meaning of the violation codes.
   *
   * Nothing here reads `FIELD_AUTHORITY`. The module does not export it, and
   * reconstructing it would make this file the same map a second time and leave
   * it unable to catch the one thing the map cannot catch itself. That division
   * is the point: `satisfies Record<keyof BlockRunLedger, …>` proves every field
   * was *classified*, and only these cases prove each was classified
   * **correctly**. Before they existed, moving `startedAt` from `IDENTITY` to
   * `RECORD` typechecked clean, left the whole suite green, and permitted a run
   * to be backdated.
   *
   * `toEqual` rather than `toContain`, deliberately, and in both directions: a
   * field demoted to a weaker class loses its code, one promoted to a stronger
   * class gains an extra one, and only an exact comparison fails for both.
   *
   * Several single-field successors are not documents the schema would accept —
   * the fingerprint is re-derived, the entries mirror the frozen plan, the
   * version is pinned. Those ask succession directly, which is what it
   * documents itself to answer, and assert the schema's refusal beside it so
   * the two gates stay visibly distinct.
   */

  it('pins schemaVersion to run identity', () => {
    // Any version other than the one this build writes — `midFlight` is 2.
    const next = { ...midFlight, schemaVersion: 3 };
    expect(safeParseBlockRunLedger(next).success).toBe(false);
    expect(assessLedgerSuccession(midFlight, next)).toEqual(['RUN_IDENTITY_CHANGED']);
  });

  it('pins repositoryId to run identity', () => {
    expect(assessLedgerSuccession(midFlight, { ...midFlight, repositoryId: 'other' }))
      .toEqual(['RUN_IDENTITY_CHANGED']);
  });

  it('pins repositoryRoot to run identity', () => {
    expect(assessLedgerSuccession(midFlight, { ...midFlight, repositoryRoot: 'D:\\elsewhere' }))
      .toEqual(['RUN_IDENTITY_CHANGED']);
  });

  it('pins blockId to run identity', () => {
    // Not a document the schema accepts on its own: rule 1b re-derives the
    // fingerprint from `blockId`, so a rename alone contradicts it.
    const next = { ...midFlight, blockId: 'V9' };
    expect(safeParseBlockRunLedger(next).success).toBe(false);
    expect(assessLedgerSuccession(midFlight, next)).toEqual(['RUN_IDENTITY_CHANGED']);
  });

  it('pins runId to run identity', () => {
    expect(assessLedgerSuccession(midFlight, { ...midFlight, runId: 'run-0002' }))
      .toEqual(['RUN_IDENTITY_CHANGED']);
  });

  it('pins startedAt to run identity, so the run cannot be backdated', () => {
    // Called out separately because `startedAt` is the only identity field with
    // no second gate anywhere: `repositoryId` and `repositoryRoot` are re-checked
    // against the checkout in `checkRecordedIdentity`, `runId` decides which file
    // the write lands in, `schemaVersion` is pinned by the contract, and
    // `blockId` is tied to the fingerprint. If this classification is ever wrong,
    // this assertion is the only thing in the repository that says so.
    expect(assessLedgerSuccession(midFlight, { ...midFlight, startedAt: '2020-01-01T00:00:00.000Z' }))
      .toEqual(['RUN_IDENTITY_CHANGED']);
  });

  it('pins frozenTaskIds to the frozen plan', () => {
    // Alone it contradicts both the mirror rule and the fingerprint.
    const next = { ...midFlight, frozenTaskIds: ['A-001', 'C-001'] };
    expect(safeParseBlockRunLedger(next).success).toBe(false);
    expect(assessLedgerSuccession(midFlight, next)).toEqual(['FROZEN_PLAN_CHANGED']);
  });

  it('pins frozenDependencies to the frozen plan', () => {
    // Demoting this field to RECORD would typecheck clean and leave the rest of
    // this suite green — succession would then let a successor change the
    // relation *and* its own fingerprint consistently, which is exactly the
    // authority this classification exists to deny. Alone (fingerprint
    // untouched) it also contradicts rule 1b, so the schema refuses it too.
    const next = {
      ...midFlight,
      frozenDependencies: [
        { taskId: 'A-001', dependsOn: [] },
        { taskId: 'B-001', dependsOn: ['A-001'] },
      ],
    };
    expect(safeParseBlockRunLedger(next).success).toBe(false);
    expect(assessLedgerSuccession(midFlight, next)).toEqual(['FROZEN_PLAN_CHANGED']);
  });

  it('pins planFingerprint to the frozen plan', () => {
    const next = { ...midFlight, planFingerprint: 'f'.repeat(64) };
    expect(safeParseBlockRunLedger(next).success).toBe(false);
    expect(assessLedgerSuccession(midFlight, next)).toEqual(['FROZEN_PLAN_CHANGED']);
  });

  it('leaves activeTaskId to the contract that already determines it', () => {
    // Classified as a record field, and succession says nothing about it on an
    // ordinary update — deliberately, because it carries no freedom the
    // dispositions do not already carry: rules 2 and 3 admit exactly one value.
    // Pinning that division is what keeps the classification honest; claiming
    // succession holds this field would be the token-without-an-effect the
    // header warns about.
    const cleared = { ...midFlight, activeTaskId: null };
    expect(assessLedgerSuccession(midFlight, cleared)).toEqual([]);
    expect(safeParseBlockRunLedger(cleared).success).toBe(false);

    const misnamed = { ...midFlight, activeTaskId: 'B-001' };
    expect(assessLedgerSuccession(midFlight, misnamed)).toEqual([]);
    expect(safeParseBlockRunLedger(misnamed).success).toBe(false);
  });

  it('pins tasks to the record rules', () => {
    const next = {
      ...midFlight,
      tasks: midFlight.tasks.map((task, index) =>
        index === 0 ? { ...task, baseCommit: 'b'.repeat(40) } : task,
      ),
    };
    expect(safeParseBlockRunLedger(next).success).toBe(true);
    expect(assessLedgerSuccession(midFlight, next)).toEqual(['RECORDED_ENTRY_CHANGED']);
  });

  it('pins stopReason to write-once', () => {
    expect(assessLedgerSuccession(stoppedRun, { ...stoppedRun, stopReason: 'OPERATOR_STOPPED' }))
      .toEqual(['STOP_REASON_RELABELLED']);
  });
});

/* ───────────────── the fingerprint separator ────────────────────────────── */

describe('the definition fingerprint separator', () => {
  it('is written as an escape, and the digest it produces can be reconstructed independently', () => {
    // Not a claim that the digest is stable across this slice — it is not.
    // Task 1 deliberately moved every existing fingerprint by binding the
    // dependency relation into it, and that is the point of the relation
    // being frozen evidence rather than a live judgement. What this proves is
    // narrower and does not depend on history: the *current* encoding is
    // exactly what `block-definition.ts` documents, reconstructed here from
    // first principles rather than by calling back into the code under test.
    const source = readFileSync(new URL('../src/block/block-definition.ts', import.meta.url));

    // Raw control bytes in a source file are invisible in every editor, every
    // diff and every review — and these are load-bearing: they are the
    // separators that make two different plans unable to encode to one string.
    // Written as escapes they are the same values and readable ones.
    expect(source.includes(0)).toBe(false);
    expect(source.includes(1)).toBe(false);
    expect(source.includes(2)).toBe(false);

    // Same value, proven rather than asserted: the digest is compared with one
    // computed here from independently constructed separators. The fixture
    // deliberately gives B-001 a non-empty `dependsOn`, so the reconstruction
    // exercises the membership separator *inside* a row (between a taskId and
    // its dependency) as well as between rows — with every row independent, as
    // an earlier revision of this test left it, a mutant that swapped the two
    // separators' roles within a row would go undetected, because there would
    // be nothing inside any row to separate.
    const definition = defineBlock('V2', ['A-001', 'B-001'], [
      { taskId: 'A-001', dependsOn: [] },
      { taskId: 'B-001', dependsOn: ['A-001'] },
    ]);
    if (!definition.ok) throw new Error('fixture block is not a block');

    const membershipSeparator = String.fromCharCode(0);
    const rowSeparator = String.fromCharCode(1);
    const sectionSeparator = String.fromCharCode(2);
    const membership = ['V2', 'A-001', 'B-001'].join(membershipSeparator);
    const relation = [
      ['A-001'].join(membershipSeparator),
      ['B-001', 'A-001'].join(membershipSeparator),
    ].join(rowSeparator);
    const expected = createHash('sha256')
      .update(`${membership}${sectionSeparator}${relation}`, 'utf8')
      .digest('hex');
    expect(fingerprintBlockDefinition(definition.definition)).toBe(expected);
  });
});
