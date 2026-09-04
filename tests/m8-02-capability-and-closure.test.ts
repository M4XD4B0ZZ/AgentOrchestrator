/**
 * M8-02 — the tree a capability is judged in, and the ending an operator owns.
 *
 * ── Two defects, one task ──────────────────────────────────────────────────
 *
 * `RESOLVER-V3-054` was blocked by both.
 *
 * **The wrong working copy.** AO judged `codegraph: REQUIRED` satisfied by
 * probing the canonical repository root, where an index really was. The writer
 * works in a *task worktree* — a sibling directory — which never has one:
 * `.codegraph/` is ignored through `.git/info/exclude`, a file in the common Git
 * directory, so every linked worktree inherits the rule and none inherits the
 * directory. The reviewer reported the missing index correctly, round after
 * round, and the writer could not create one — nor should it be able to, because
 * the index is the *evidence* for the capability and an agent that could make it
 * would be minting its own authority.
 *
 * **No way to end a task.** Nothing in `src/` writes `ABORTED`, and
 * `READY_FOR_PR` is deliberately withheld from `HUMAN_DECISION_REQUIRED`. So a
 * task an operator finished by hand stayed blocked for ever and its attention
 * item stayed open for ever.
 *
 * ── The traps these cases are built to catch ───────────────────────────────
 *
 *  - a fixture whose root and worktree agree, which would make every
 *    "the right tree was inspected" assertion a comparison of two equal strings;
 *  - a gate at one entry point, which every resume walks past;
 *  - a provisioning that reports success from an exit code rather than from the
 *    index appearing;
 *  - a closure that empties the outbox by deleting the state file;
 *  - and the one the design's own reviewer found: a closure that leaves a block
 *    ledger unable to write anything ever again.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { getAllowedTransitions } from '../src/core/transitions.js';
import { parseTaskState, safeParseTaskState } from '../src/core/task-state.js';
import { listAttentionRecords } from '../src/notify/attention-store.js';
import { settleAttention } from '../src/notify/attention-outbox.js';
import { probeCodegraphCapability } from '../src/repo/capabilities.js';
import { provisionCodegraphIndex } from '../src/repo/codegraph-index.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';
import { runContextLoadingStep, runImplementStep, runReviewStep } from '../src/loop/loop-step.js';
import type { LoopDependencies } from '../src/loop/loop-step.js';
import { resolveTaskByOperator } from '../src/run/resolve-task.js';
import { defineBlock } from '../src/block/block-definition.js';
import { loadBlockLedger } from '../src/block/block-store.js';
import {
  abandonBlockTask,
  activateBlockTask,
  parkBlockTask,
  resolveBlockTask,
  settleBlockTask,
  startBlockRun,
  stopBlockRun,
} from '../src/block/block-progress.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { reload, seedDeliveredState, startTask } from './helpers/e2e-fixtures.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';

const HOMES: string[] = [];

afterEach(() => {
  releaseTestLeases();
  for (const home of HOMES.splice(0)) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // A home that cannot be removed is a test-machine condition, not a result.
    }
  }
});

function operatorHome(): ReturnType<typeof fixedPathProvider> {
  const home = mkdtempSync(join(tmpdir(), 'ao-m8-home-'));
  HOMES.push(home);
  return fixedPathProvider(home);
}

/** A repository whose ROOT carries an index and whose worktrees cannot. */
async function withDivergentIndex(taskId: string, requirement: 'REQUIRED' | 'OPTIONAL') {
  return await startTask({
    taskId,
    profile: profileWithCodegraph(requirement),
    // The index is created at the root before the fixture's commit, and the
    // ignore rule keeps it out of that commit — so no worktree can inherit it.
    // That asymmetry is the machine's real shape, and the control below measures
    // it rather than assuming it.
    codegraphIndex: true,
    files: { '.gitignore': '.agent-orchestrator/runtime/\n.codegraph/\n' },
  });
}

function profileWithCodegraph(requirement: 'REQUIRED' | 'OPTIONAL'): string {
  return `schemaVersion: 1
repository:
  id: e2e-alpha
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: ${requirement}
verification:
  phases:
    - phase: VERIFY
      command: [git, --version]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: 2
remote:
  required: false
`;
}

/* ═════════ A. Which working copy the capability is judged in ══════════════ */

describe('the capability is judged in the tree the agents open', () => {
  it('the two directories really do disagree — the control', async () => {
    // Load-bearing, and not a product claim. Without it every assertion below
    // compares two identical strings and holds whichever directory was probed.
    const started = await withDivergentIndex('M8-02-CTRL', 'OPTIONAL');
    expect(probeCodegraphCapability(started.root)).toBe('INDEX_PRESENT');
    expect(probeCodegraphCapability(started.workspace.worktreePath)).toBe('UNAVAILABLE');
  });

  it('the execution brief reports the worktree, not the root', async () => {
    const started = await withDivergentIndex('M8-02-BRIEF', 'REQUIRED');
    const brief = readExecutionBrief(
      started.repository,
      started.taskId,
      started.workspace.worktreePath,
    );
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    // The repository resolved — the root probe admitted it — and the tree the
    // writer would open still cannot satisfy the requirement.
    expect(started.repository.capabilities.codegraph.status).toBe('INDEX_PRESENT');
    expect(brief.brief.codegraph.status).toBe('UNAVAILABLE');
    expect(brief.brief.capabilitiesSatisfied).toBe(false);
  });

  it('parks at every entry point, not only the first', async () => {
    // `HUMAN_DECISION_REQUIRED -> IMPLEMENTING` is a declared edge and a resume
    // takes it directly, so a gate that stood only in CONTEXT_LOADING would be
    // walked past by the very path a human takes after being asked to fix this.
    const deps = (started: Awaited<ReturnType<typeof withDivergentIndex>>): LoopDependencies => ({
      now: '2026-09-04T10:00:00.000Z',
      authorisedWorktreePath: started.workspace.worktreePath,
      verification: started.repository.verification,
      writerMcp: null,
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
      git: runGitCommand,
      brief: readExecutionBrief(
        started.repository,
        started.taskId,
        started.workspace.worktreePath,
      ),
      agent: () => {
        throw new Error('no agent may start while a required capability is unsatisfied');
      },
    });

    for (const [state, step] of [
      ['CONTEXT_LOADING', runContextLoadingStep],
      ['IMPLEMENTING', runImplementStep],
      ['REVIEWING', runReviewStep],
    ] as const) {
      // One fixture per entry point. Seeding three states over one repository
      // would need three commits of the same content, and the second has
      // nothing to commit — a fixture failure that would look like a product
      // one.
      const started = await withDivergentIndex(`M8-02-GATE-${state}`, 'REQUIRED');
      const current = seedDeliveredState(started, { state, reviewRound: 0 });
      const result = await step(current, deps(started));
      expect(result.outcome).toBe('BLOCKED');
      expect(result.state).toBe('HUMAN_DECISION_REQUIRED');
    }
  });

  it('lets an OPTIONAL repository through untouched', async () => {
    const started = await withDivergentIndex('M8-02-OPT', 'OPTIONAL');
    const brief = readExecutionBrief(
      started.repository,
      started.taskId,
      started.workspace.worktreePath,
    );
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.brief.codegraph.status).toBe('UNAVAILABLE');
    expect(brief.brief.capabilitiesSatisfied).toBe(true);
  });
});

/* ═════════ B. Who may make the capability true, and how it is judged ══════ */

describe('provisioning the worktree index', () => {
  const grant = (prepare: { command: string; args: readonly string[] } | null) =>
    Object.freeze({
      capability: 'codegraph' as const,
      command: 'codegraph',
      args: Object.freeze(['serve', '--mcp']),
      tool: 'mcp__codegraph__codegraph_explore',
      prepare: prepare === null ? null : Object.freeze(prepare),
    });

  it('does nothing at all for a repository that did not ask', async () => {
    const started = await withDivergentIndex('M8-02-PROV-OPT', 'OPTIONAL');
    const result = await provisionCodegraphIndex({
      worktreePath: started.workspace.worktreePath,
      requirement: 'OPTIONAL',
      grant: grant({ command: 'git', args: ['init', '.codegraph'] }),
      git: runGitCommand,
    });
    expect(result.outcome).toBe('NOT_REQUIRED');
    expect(result.commandRan).toBe(false);
  });

  it('refuses when the operator has named no command', async () => {
    const started = await withDivergentIndex('M8-02-PROV-NONE', 'REQUIRED');
    const result = await provisionCodegraphIndex({
      worktreePath: started.workspace.worktreePath,
      requirement: 'REQUIRED',
      grant: grant(null),
      git: runGitCommand,
    });
    expect(result.outcome).toBe('NO_OPERATOR_COMMAND');
    expect(result.commandRan).toBe(false);
  });

  it('refuses before starting anything where Git does not ignore the index', async () => {
    // An index is tens of megabytes and `commitTaskWork` stages what the scope
    // guard approved. An unignored one is either a binary dump in the task's
    // commit or a scope violation, and both are worse than not preparing.
    // The repository declares the capability OPTIONAL, so it resolves without a
    // root index and its `.gitignore` says nothing about `.codegraph/`. The
    // REQUIRED question is then put to the provisioner directly, which is the
    // shape a repository gets by declaring the capability without arranging for
    // the artefact to be ignored.
    const started = await startTask({ taskId: 'M8-02-PROV-VIS' });
    const result = await provisionCodegraphIndex({
      worktreePath: started.workspace.worktreePath,
      requirement: 'REQUIRED',
      grant: grant({ command: 'git', args: ['init', '.codegraph'] }),
      git: runGitCommand,
    });
    expect(result.outcome).toBe('INDEX_PATH_NOT_IGNORED');
    expect(result.commandRan).toBe(false);
    expect(probeCodegraphCapability(started.workspace.worktreePath)).toBe('UNAVAILABLE');
  });

  it('prepares the worktree with the operator’s own command, and measures the effect', async () => {
    const started = await withDivergentIndex('M8-02-PROV-OK', 'REQUIRED');
    const result = await provisionCodegraphIndex({
      worktreePath: started.workspace.worktreePath,
      requirement: 'REQUIRED',
      // A real process, and one that really creates the directory. The command
      // is the operator's in production; here it is a Git subcommand, because
      // this suite may not depend on an indexer being installed.
      grant: grant({ command: 'git', args: ['init', '.codegraph'] }),
      git: runGitCommand,
    });
    expect(result.outcome).toBe('PREPARED');
    expect(result.commandRan).toBe(true);
    expect(result.status).toBe('INDEX_PRESENT');
    expect(probeCodegraphCapability(started.workspace.worktreePath)).toBe('INDEX_PRESENT');

    // And the brief now says the capability is satisfied, in that tree.
    const brief = readExecutionBrief(
      started.repository,
      started.taskId,
      started.workspace.worktreePath,
    );
    expect(brief.ok && brief.brief.capabilitiesSatisfied).toBe(true);

    // Idempotent: a second call measures the index and starts nothing.
    const again = await provisionCodegraphIndex({
      worktreePath: started.workspace.worktreePath,
      requirement: 'REQUIRED',
      grant: grant({ command: 'git', args: ['init', '.codegraph'] }),
      git: runGitCommand,
    });
    expect(again.outcome).toBe('ALREADY_PRESENT');
    expect(again.commandRan).toBe(false);
  });

  it('calls a command that exits 0 and leaves nothing behind a failure', async () => {
    // The effect is the measurement. A build that reported the exit code would
    // announce a capability that is not there — reconstructed evidence, which
    // this repository refuses.
    const started = await withDivergentIndex('M8-02-PROV-NOOP', 'REQUIRED');
    const result = await provisionCodegraphIndex({
      worktreePath: started.workspace.worktreePath,
      requirement: 'REQUIRED',
      grant: grant({ command: 'git', args: ['--version'] }),
      git: runGitCommand,
    });
    expect(result.outcome).toBe('STILL_ABSENT');
    expect(result.commandRan).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('UNAVAILABLE');
  });
});

/* ═════════ C. The ending an operator owns ═════════════════════════════════ */

describe('an operator ends a task this orchestrator escalated', () => {
  async function parked(taskId: string, state: 'HUMAN_DECISION_REQUIRED' | 'BLOCKED_VERIFY') {
    const started = await startTask({ taskId });
    seedDeliveredState(started, {
      state,
      reviewRound: 1,
      resumeFrom: { phase: 'REMEDIATE', round: 1 },
    });
    return started;
  }

  it('records the decision, and names what it overrode', async () => {
    const started = await parked('M8-02-RES-HDR', 'HUMAN_DECISION_REQUIRED');
    const result = resolveTaskByOperator(started.repository, started.taskId, {
      now: '2026-09-04T12:00:00.000Z',
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
      pathProvider: operatorHome(),
    });

    expect(result.outcome).toBe('RESOLVED');
    const after = reload(started.root, started.taskId).state;
    expect(after.state).toBe('OPERATOR_RESOLVED');
    expect(after.operatorResolution).toEqual({ closedFrom: 'HUMAN_DECISION_REQUIRED' });
    // Terminal, and nothing pending survived it.
    expect(after.resumeFrom).toBeNull();
    expect(getAllowedTransitions('OPERATOR_RESOLVED')).toEqual([]);
  });

  it('works out of a verification block too, and names that state', async () => {
    const started = await parked('M8-02-RES-BV', 'BLOCKED_VERIFY');
    const result = resolveTaskByOperator(started.repository, started.taskId, {
      now: '2026-09-04T12:00:00.000Z',
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
      pathProvider: operatorHome(),
    });
    expect(result.outcome).toBe('RESOLVED');
    expect(reload(started.root, started.taskId).state.operatorResolution).toEqual({
      closedFrom: 'BLOCKED_VERIFY',
    });
  });

  it('refuses every state the operator was not asked about', async () => {
    // The narrow entry IS the guard. A scope violation says an agent left its
    // sandbox; a diverged record says the record and the repository disagree.
    // Neither is a decision that can be taken from a command line.
    for (const state of ['SCOPE_VIOLATION', 'RESUME_STATE_DIVERGED', 'READY_FOR_PR'] as const) {
      const started = await startTask({ taskId: `M8-02-RES-${state}` });
      seedDeliveredState(started, {
        state,
        reviewRound: 1,
        ...(state === 'READY_FOR_PR' ? { worktreeCleanAtCheckpoint: true } : {}),
      });
      const result = resolveTaskByOperator(started.repository, started.taskId, {
        now: '2026-09-04T12:00:00.000Z',
        lease: { repository: started.repository, evidence: leaseFor(started.repository) },
        pathProvider: operatorHome(),
      });
      expect(result.outcome).toBe('STATE_NOT_RESOLVABLE');
      expect(reload(started.root, started.taskId).state.state).toBe(state);
    }
  });

  it('is idempotent, and says so rather than writing again', async () => {
    const started = await parked('M8-02-RES-TWICE', 'HUMAN_DECISION_REQUIRED');
    const options = {
      now: '2026-09-04T12:00:00.000Z',
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
      pathProvider: operatorHome(),
    };
    expect(resolveTaskByOperator(started.repository, started.taskId, options).outcome).toBe(
      'RESOLVED',
    );
    expect(resolveTaskByOperator(started.repository, started.taskId, options).outcome).toBe(
      'ALREADY_RESOLVED',
    );
  });

  it('takes the attention item with it, and leaves the record standing', async () => {
    const started = await parked('M8-02-RES-ATT', 'HUMAN_DECISION_REQUIRED');
    const provider = operatorHome();
    const subject = {
      repositoryId: started.repository.id,
      repositoryRoot: started.root,
      conditions: [] as const,
    };

    // The item, raised by the product's own pass over the repository.
    const before = settleAttention([subject], '2026-09-04T11:00:00.000Z', {
      pathProvider: provider,
    });
    expect(before.raised).toHaveLength(1);
    expect(listAttentionRecords(provider).records).toHaveLength(1);

    const result = resolveTaskByOperator(started.repository, started.taskId, {
      now: '2026-09-04T12:00:00.000Z',
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
      pathProvider: provider,
    });

    expect(result.outcome).toBe('RESOLVED');
    expect(result.attentionRemoval).toBe('REMOVED');
    expect(listAttentionRecords(provider).records).toHaveLength(0);
    // And the outbox is empty because the condition is gone, not because the
    // state file is: a closure that deleted the record would empty it just as
    // well, and would be a different thing entirely.
    expect(reload(started.root, started.taskId).state.state).toBe('OPERATOR_RESOLVED');
    // A second pass raises nothing: the state is silent, by its row in the table.
    const after = settleAttention([subject], '2026-09-04T13:00:00.000Z', {
      pathProvider: provider,
    });
    expect(after.raised).toHaveLength(0);
    expect(listAttentionRecords(provider).records).toHaveLength(0);
  });
});

/* ═════════ D. The contract keeps the two halves together ══════════════════ */

describe('the state and its provenance are biconditional', () => {
  it('refuses the state without the provenance', () => {
    const base = parseTaskState(validState('HUMAN_DECISION_REQUIRED'));
    const parsed = safeParseTaskState({
      ...base,
      state: 'OPERATOR_RESOLVED',
      resumeFrom: null,
      reportedResetAt: null,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses the provenance without the state', () => {
    // Otherwise an operator's authority becomes decoration a machine success can
    // wear.
    const base = parseTaskState(validState('HUMAN_DECISION_REQUIRED'));
    const parsed = safeParseTaskState({
      ...base,
      operatorResolution: { closedFrom: 'HUMAN_DECISION_REQUIRED' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the pair', () => {
    const base = parseTaskState(validState('HUMAN_DECISION_REQUIRED'));
    const parsed = safeParseTaskState({
      ...base,
      state: 'OPERATOR_RESOLVED',
      resumeFrom: null,
      reportedResetAt: null,
      operatorResolution: { closedFrom: 'BLOCKED_VERIFY' },
    });
    expect(parsed.success).toBe(true);
  });
});

function validState(state: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: 'M8-02-CONTRACT',
    repositoryId: 'e2e-alpha',
    repositoryRoot: 'D:\\repo',
    worktreePath: 'D:\\repo.worktrees\\M8-02-CONTRACT',
    state,
    stateEnteredAt: '2026-09-04T10:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: '0'.repeat(40),
    workBranch: 'ao/task/M8-02-CONTRACT',
    currentCommit: '1'.repeat(40),
    reviewRound: 1,
    maxReviewRounds: 2,
    blockedAgent: null,
    resumeFrom: { phase: 'REMEDIATE', round: 1 },
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: false,
    findingHistory: [],
  };
}

/* ═════════ E. The ledger keeps writing after an operator's decision ═══════ */

describe('a block run survives a task an operator ended', () => {
  it('is frozen without the RESOLVED disposition, and writable with it', async () => {
    // The attack this case exists for, found by the design's own reviewer:
    // `firstUnprovenClaim` re-proves EVERY entry on any write that moves a
    // disposition, and a `BLOCKED` entry whose record has become terminal can
    // never be proven again. Without a disposition that accepts the record, one
    // operator decision leaves the whole run unable to write anything.
    const started = await startTask({ taskId: 'A-001' });
    seedDeliveredState(started, {
      state: 'HUMAN_DECISION_REQUIRED',
      reviewRound: 1,
      resumeFrom: { phase: 'REMEDIATE', round: 1 },
    });

    const definition = defineBlock('BLOCK-M8', ['A-001'], [{ taskId: 'A-001', dependsOn: [] }]);
    if (!definition.ok) throw new Error('the fixture block is not a block');
    const options = { repositoryRoot: started.root };

    const created = startBlockRun({
      definition: definition.definition,
      repositoryId: started.repository.id,
      repositoryRoot: started.root,
      runId: 'RUN-M8',
      now: '2026-09-04T10:00:00.000Z',
    });
    expect(created.ok).toBe(true);

    const load = () => {
      const loaded = loadBlockLedger(started.root, 'RUN-M8');
      if (!loaded.ok) throw new Error(`ledger did not load: ${loaded.code}`);
      return loaded;
    };

    expect(activateBlockTask(load(), 'A-001', options).outcome).toBe('RECORDED');
    expect(parkBlockTask(load(), 'A-001', options).outcome).toBe('RECORDED');

    // The operator ends it, outside the run.
    expect(
      resolveTaskByOperator(started.repository, 'A-001', {
        now: '2026-09-04T12:00:00.000Z',
        lease: { repository: started.repository, evidence: leaseFor(started.repository) },
        pathProvider: operatorHome(),
      }).outcome,
    ).toBe('RESOLVED');

    // No pre-M8 disposition accepts the record: each proves against exactly one
    // state, and `OPERATOR_RESOLVED` is none of them.
    expect(settleBlockTask(load(), 'A-001', options).outcome).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
    expect(abandonBlockTask(load(), 'A-001', options).outcome).toBe(
      'TASK_STATE_DOES_NOT_PROVE_IT',
    );

    // And the freeze is real, not theoretical. A stop whose reason claims the
    // tasks did something re-arms the proof over EVERY entry, so the run cannot
    // even record how it ended while `A-001` stands unproven.
    const frozen = stopBlockRun(load(), 'TASK_BLOCKED', options);
    // The store's own refusal, in the progress vocabulary: the ledger's claim
    // about `A-001` is no longer supported by `A-001`'s record.
    expect(frozen.outcome).toBe('TASK_STATE_DOES_NOT_PROVE_IT');
    expect(frozen.save?.ok === false ? frozen.save.code : null).toBe('ENTRY_NOT_PROVEN');

    // The disposition that accepts it lifts the freeze.
    expect(resolveBlockTask(load(), 'A-001', options).outcome).toBe('RECORDED');
    const entry = load().ledger.tasks.find((task) => task.taskId === 'A-001');
    expect(entry?.disposition).toBe('RESOLVED');
    // No result commit: this build has no commit it can prove finished the task.
    expect(entry?.resultCommit).toBeNull();

    // And the run can record its ending — as COMPLETE, which accepts a resolved
    // entry beside a settled one. A block whose every task is finished, some by
    // this orchestrator and some by the person it escalated to, has nothing left
    // to do, and refusing to say so would leave it permanently incomplete for
    // having asked a human and been answered.
    expect(stopBlockRun(load(), 'COMPLETE', options).outcome).toBe('RECORDED');
    expect(load().ledger.stopReason).toBe('COMPLETE');
  });
});
