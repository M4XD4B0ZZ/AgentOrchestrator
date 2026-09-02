/**
 * M3 slice 2 — actionable notifications, in process.
 *
 * ── The rule this file measures ────────────────────────────────────────────
 *
 *     an item exists  ⟺  no machine can move this task
 *                          AND there is something a person can go and do
 *
 * Three layers, and each is measured where it lives:
 *
 *  - `core/task-attention.ts` judges one durable record. Pure, so every case is
 *    a value in and a value out, and the table is asserted total at runtime as
 *    well as by `satisfies`;
 *  - `notify/attention-store.ts` writes and reads records on a real scratch
 *    directory. The de-duplication is a kernel call, so it is measured against a
 *    real filesystem rather than a stub — a mock of `openSync` would prove that
 *    a mock refuses twice;
 *  - `notify/attention-outbox.ts` reconciles the two, over real task state files
 *    in real repository runtime directories.
 *
 * What is deliberately not here: that a **different process** finds the same
 * items and stays quiet about them. Calling `settleAttention` twice in one
 * vitest worker proves that a function is idempotent, not that a restart is
 * silent. That is
 * `tests/dist-artifact/recurring-operation-dist-artifact.mjs`, which stops the
 * shipped CLI and starts another one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';

import { registerRepositoriesCommand } from '../src/cli/repositories-command.js';
import {
  loadRepositoryRegistry,
  repositoryRegistryPath,
} from '../src/registry/repository-registry.js';

import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { ALL_STATES, type TaskStateName } from '../src/core/states.js';
import {
  ATTENTION_ACTIONS,
  ATTENTION_REASONS,
  attentionForTaskState,
  STATE_ATTENTION_RULES,
  type AttentionReason,
} from '../src/core/task-attention.js';
import type { TaskState } from '../src/core/task-state.js';
import {
  ATTENTION_PUSH_OUTCOMES,
  attentionPushFor,
  createAttentionNotifier,
  pushAttentionItems,
  type AttentionNotifier,
  type AttentionPush,
} from '../src/notify/attention-notification.js';
import {
  ATTENTION_SCAN_NOTES,
  scanAttention,
  settleAttention,
  type AttentionSettlement,
} from '../src/notify/attention-outbox.js';
import {
  ATTENTION_PUSH_SENTENCES,
  ATTENTION_SCAN_NOTE_SENTENCES,
  renderAttention,
  type AttentionReport,
} from '../src/cli/render-attention.js';
import {
  listAttentionRecords,
  removeAttentionRecord,
  writeAttentionRecord,
  type AttentionRecord,
} from '../src/notify/attention-store.js';
import {
  attentionIdFor,
  attentionStagingName,
  isAttentionFileName,
  operatorAttentionRoot,
} from '../src/notify/internal/attention-location.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';

const created: string[] = [];

afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked file on Windows must not fail an otherwise passing suite.
    }
  }
});

const NOW = '2026-09-02T12:00:00.000Z';
const PAST = '2026-09-02T11:00:00.000Z';
const AHEAD = '2026-09-02T13:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function home(): string {
  const dir = makeCanonicalTempDir('ao-m3s2-home-');
  created.push(dir);
  return dir;
}

/** A durable record, defaulting to a shape that needs nobody. */
function state(overrides: Partial<TaskState> = {}): TaskState {
  return Object.freeze({
    schemaVersion: 1,
    taskId: 'T-1',
    repositoryId: 'fixture',
    repositoryRoot: 'C:\\repo',
    worktreePath: 'C:\\repo.worktrees\\T-1',
    state: 'IMPLEMENTING',
    stateEnteredAt: '2026-09-01T00:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: SHA_A,
    scopeAuthorityCommit: null,
    workBranch: 'ao/task/T-1',
    currentCommit: SHA_B,
    reviewRound: 0,
    maxReviewRounds: 1,
    blockedAgent: null,
    resumeFrom: null,
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: true,
    findingHistory: [],
    ...overrides,
  }) as unknown as TaskState;
}

/** A blocked record the state contract would accept for that state. */
function blocked(name: TaskStateName, overrides: Partial<TaskState> = {}): TaskState {
  const base: Partial<TaskState> = {
    state: name,
    blockedAgent: name === 'BLOCKED_VERIFY' ? null : ('claude' as const),
    resumeFrom:
      name === 'SCOPE_VIOLATION' || name === 'RESUME_STATE_DIVERGED'
        ? null
        : ({ phase: name === 'BLOCKED_VERIFY' ? 'REMEDIATE' : 'IMPLEMENT', round: 1 } as never),
  };
  return state({ ...base, ...overrides });
}

/* ══════════════════ 1. which records need a person ═════════════════════════ */

describe('M3 slice 2 — the attention judgement', () => {
  it('has a rule for every state in the vocabulary, at runtime', () => {
    // `satisfies Record<TaskStateName, …>` is a claim about a literal that the
    // type checker makes. This is the same claim made where a test can see it,
    // so a state added to the vocabulary and forgotten here fails.
    for (const name of ALL_STATES) {
      expect(Object.hasOwn(STATE_ATTENTION_RULES, name)).toBe(true);
    }
    expect(Object.keys(STATE_ATTENTION_RULES).sort()).toEqual([...ALL_STATES].sort());
  });

  const SILENT: readonly TaskStateName[] = [
    'CREATED',
    'REPOSITORY_RESOLVED',
    'CONFIG_VALIDATED',
    'AUTH_PREFLIGHT',
    'GIT_PREFLIGHT',
    'WORKTREE_READY',
    'CONTEXT_LOADING',
    'IMPLEMENTING',
    'VERIFYING',
    'REVIEWING',
    'REMEDIATING',
    'READY_FOR_PR',
    'ABORTED',
  ];

  for (const name of SILENT) {
    it(`says nothing about ${name}`, () => {
      const judgement = attentionForTaskState(state({ state: name }), NOW);
      expect(judgement.attention).toBe(false);
      expect(judgement.action).toBeNull();
    });
  }

  const ATTENDED: readonly (readonly [TaskStateName, AttentionReason])[] = [
    ['BLOCKED_AUTH', 'AGENT_LOGIN_REQUIRED'],
    ['BLOCKED_VERIFY', 'VERIFICATION_REMEDIATION_REQUIRED'],
    ['SCOPE_VIOLATION', 'SCOPE_REVIEW_REQUIRED'],
    ['RESUME_STATE_DIVERGED', 'DIVERGENCE_REVIEW_REQUIRED'],
    ['HUMAN_DECISION_REQUIRED', 'ESCALATED_DECISION_REQUIRED'],
  ];

  for (const [name, reason] of ATTENDED) {
    it(`asks for a person on ${name}, naming ${reason}`, () => {
      const judgement = attentionForTaskState(blocked(name), NOW);
      expect(judgement.attention).toBe(true);
      expect(judgement.reason).toBe(reason);
      expect(judgement.action).toBe(ATTENTION_ACTIONS[reason]);
    });
  }

  /**
   * The quota block, which is the one state whose answer is not a property of
   * its name.
   *
   * The four shapes and the four answers, and the pairing is the whole design:
   * the notification and the permission are the same question asked once, so a
   * block an operator may continue is exactly a block that needs one. A table
   * that answered these independently could produce a notification naming a
   * command that would refuse.
   */
  const QUOTA: readonly (readonly [string, Partial<TaskState>, boolean])[] = [
    ['a reset still ahead — the scheduler will wake for it', { reportedResetAt: AHEAD }, false],
    ['a reset passed over an intact record — the automatic path’s', { reportedResetAt: PAST }, false],
    ['no reset recorded at all', { reportedResetAt: null }, true],
    [
      'a reset passed over a withdrawn record',
      { reportedResetAt: PAST, currentCommit: null, worktreeCleanAtCheckpoint: false },
      true,
    ],
  ];

  for (const [name, overrides, needsPerson] of QUOTA) {
    it(`${needsPerson ? 'asks for a person' : 'stays silent'} on ${name}`, () => {
      const judgement = attentionForTaskState(blocked('BLOCKED_USAGE_LIMIT', overrides), NOW);
      expect(judgement.attention).toBe(needsPerson);
      if (judgement.attention) {
        expect(judgement.reason).toBe('QUOTA_CONTINUATION_REQUIRED');
        expect(judgement.detail).not.toBeNull();
      }
    });
  }

  it('has an action for every reason, and no two are interchangeable', () => {
    const TOKENS: Readonly<Record<AttentionReason, string>> = {
      AGENT_LOGIN_REQUIRED: 'restore a subscription login',
      QUOTA_CONTINUATION_REQUIRED: '--continue-usage-limit',
      VERIFICATION_REMEDIATION_REQUIRED: '--remediate-verify-failure',
      SCOPE_REVIEW_REQUIRED: 'outside the scope this repository declares',
      DIVERGENCE_REVIEW_REQUIRED: 'disagreed about where this task stood',
      ESCALATED_DECISION_REQUIRED: '--continue-human-decision',
    };
    for (const reason of ATTENTION_REASONS) {
      expect(ATTENTION_ACTIONS[reason]).toContain(TOKENS[reason]);
      for (const other of ATTENTION_REASONS) {
        if (other === reason) continue;
        expect(ATTENTION_ACTIONS[other]).not.toContain(TOKENS[reason]);
      }
    }
  });

  /**
   * The three states no flag in this build continues must say so.
   *
   * Measured because the first draft of the `BLOCKED_AUTH` sentence said "log
   * in, then re-run", which the transition table appears to promise and no code
   * delivers: nothing in `src/` writes `AUTH_PREFLIGHT`, so the declared edge has
   * no executor. A notification naming a command that changes nothing is worse
   * than one that admits there is none.
   */
  it('admits, on the states nothing continues, that no command continues them', () => {
    for (const reason of [
      'AGENT_LOGIN_REQUIRED',
      'SCOPE_REVIEW_REQUIRED',
      'DIVERGENCE_REVIEW_REQUIRED',
    ] as const) {
      expect(ATTENTION_ACTIONS[reason]).toMatch(/[Nn]o flag (in this build )?continues/);
    }
  });

  it('names an exact command on every state one exists for', () => {
    for (const reason of [
      'QUOTA_CONTINUATION_REQUIRED',
      'VERIFICATION_REMEDIATION_REQUIRED',
      'ESCALATED_DECISION_REQUIRED',
    ] as const) {
      expect(ATTENTION_ACTIONS[reason]).toContain('agent-loop run --repository <path> --task <id>');
    }
  });
});

/* ═══════════════════════ 2. the durable store ══════════════════════════════ */

function record(overrides: Partial<AttentionRecord> = {}): AttentionRecord {
  const base = {
    repositoryRoot: 'C:\\repo',
    taskId: 'T-1',
    reason: 'ESCALATED_DECISION_REQUIRED' as const,
    detail: null,
    stateEnteredAt: '2026-09-01T00:00:00.000Z',
  };
  const merged = { ...base, ...overrides };
  return Object.freeze({
    attentionVersion: 1 as const,
    attentionId: attentionIdFor({
      repositoryRoot: merged.repositoryRoot,
      taskId: merged.taskId,
      reason: merged.reason,
      detail: merged.detail,
      stateEnteredAt: merged.stateEnteredAt,
    }),
    repositoryId: 'fixture',
    repositoryRoot: merged.repositoryRoot,
    taskId: merged.taskId,
    state: 'HUMAN_DECISION_REQUIRED' as const,
    reason: merged.reason,
    detail: merged.detail,
    stateEnteredAt: merged.stateEnteredAt,
    reportedResetAt: null,
    observedAt: NOW,
    action: ATTENTION_ACTIONS[merged.reason],
    ...overrides,
  }) as AttentionRecord;
}

describe('M3 slice 2 — the durable outbox store', () => {
  it('creates a record, and the second write of the same condition is refused', () => {
    const provider = fixedPathProvider(home());
    const item = record();

    expect(writeAttentionRecord(item, provider).code).toBe('RECORDED');
    // The whole concurrency design in one assertion. Two processes deriving the
    // same condition derive the same name; the kernel gives the file to one of
    // them and tells the other. "Already recorded" and "somebody else recorded
    // it" are the same answer because they are the same fact.
    expect(writeAttentionRecord(item, provider).code).toBe('ALREADY_RECORDED');

    const listing = listAttentionRecords(provider);
    expect(listing.records).toHaveLength(1);
    expect(listing.records[0]?.attentionId).toBe(item.attentionId);
  });

  it('reads back exactly what it wrote', () => {
    const provider = fixedPathProvider(home());
    const item = record({ reportedResetAt: PAST, detail: 'RESUME_RECORD_WITHDRAWN' });
    expect(writeAttentionRecord(item, provider).code).toBe('RECORDED');
    expect(listAttentionRecords(provider).records[0]).toEqual(item);
  });

  it('reports an absent store as absent rather than as a failure', () => {
    const listing = listAttentionRecords(fixedPathProvider(home()));
    expect(listing.absent).toBe(true);
    expect(listing.unreadableRoot).toBe(false);
    expect(listing.records).toHaveLength(0);
  });

  it('leaves alone what it did not write, and counts it', () => {
    const provider = fixedPathProvider(home());
    expect(writeAttentionRecord(record(), provider).code).toBe('RECORDED');
    const root = operatorAttentionRoot(provider);
    writeFileSync(join(root, 'notes.txt'), 'somebody else\n', 'utf8');
    writeFileSync(join(root, `${'f'.repeat(32)}.json`), 'not json at all', 'utf8');

    const listing = listAttentionRecords(provider);
    expect(listing.records).toHaveLength(1);
    expect(listing.foreignNames).toBe(1);
    expect(listing.unreadable).toBe(1);
    // Nothing was removed. This store deletes only records whose condition it
    // has positively re-derived; guessing whose a foreign file is is what this
    // build does not do.
    expect(readdirSync(root)).toHaveLength(3);
  });

  it('refuses a record whose own id disagrees with the file it is in', () => {
    const provider = fixedPathProvider(home());
    const item = record();
    expect(writeAttentionRecord(item, provider).code).toBe('RECORDED');
    const path = join(operatorAttentionRoot(provider), `${item.attentionId}.json`);
    const edited = { ...JSON.parse(readFileSync(path, 'utf8')), attentionId: '0'.repeat(32) };
    writeFileSync(path, JSON.stringify(edited, null, 2), 'utf8');

    // The name is the identity. A document that has been moved or edited is not
    // this record, and it is counted rather than believed.
    const listing = listAttentionRecords(provider);
    expect(listing.records).toHaveLength(0);
    expect(listing.unreadable).toBe(1);
  });

  /**
   * The hole the exclusive-open design had, and the reason the write goes
   * through a hard link.
   *
   * `openSync(target, 'wx')` takes the record's own name **before** the bytes
   * are written, so a process that died in between left a zero-byte file at that
   * name: the listing counted it unreadable and every later pass was told
   * `ALREADY_RECORDED`, suppressing that one notification for ever. Writing the
   * whole record under a staging name and then `link`ing it closes that, because
   * `link` is atomic and refuses an existing target.
   *
   * Structural, on the code with its prose removed, because the window is
   * microseconds wide and no in-process test can land inside it. What can be
   * measured is that the target name is never opened for writing at all.
   */
  it('never opens the record’s own name for writing', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'notify', 'attention-store.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(source).toContain('linkSync(staging, target)');
    // Exactly one `openSync`, and its subject is the staging name.
    expect([...source.matchAll(/openSync\(/g)]).toHaveLength(1);
    expect(source).toContain("openSync(staging, 'wx'");
  });

  it('leaves nothing behind on a successful write', () => {
    const provider = fixedPathProvider(home());
    const item = record();
    expect(writeAttentionRecord(item, provider).code).toBe('RECORDED');
    // The staging file is this call's own and is discarded. One name, one file.
    expect(readdirSync(operatorAttentionRoot(provider))).toEqual([`${item.attentionId}.json`]);
  });

  it('ignores its own staging leftover, and still records the condition', () => {
    const provider = fixedPathProvider(home());
    const item = record();
    // A crash between writing the content and giving it its name leaves exactly
    // this: a complete record under a name nothing reads, and no record.
    expect(writeAttentionRecord(record({ taskId: 'OTHER' }), provider).code).toBe('RECORDED');
    const orphan = join(
      operatorAttentionRoot(provider),
      attentionStagingName(item.attentionId, 'abc-0123456789ab'),
    );
    writeFileSync(orphan, `${JSON.stringify(item, null, 2)}\n`, 'utf8');

    const listing = listAttentionRecords(provider);
    // Neither a record nor foreign: this build's own, and inert.
    expect(listing.staging).toBe(1);
    expect(listing.foreignNames).toBe(0);
    expect(listing.unreadable).toBe(0);
    expect(listing.records.map((entry) => entry.taskId)).toEqual(['OTHER']);

    // And the condition the dead process never named is written by the next
    // pass, which is the direction this design fails in: a delay, not a loss.
    expect(writeAttentionRecord(item, provider).code).toBe('RECORDED');
    expect(listAttentionRecords(provider).records).toHaveLength(2);
  });

  it('removes one record by id, and a second removal is not a failure', () => {
    const provider = fixedPathProvider(home());
    const item = record();
    writeAttentionRecord(item, provider);
    expect(removeAttentionRecord(item.attentionId, provider)).toBe('REMOVED');
    expect(removeAttentionRecord(item.attentionId, provider)).toBe('ALREADY_GONE');
    expect(listAttentionRecords(provider).records).toHaveLength(0);
  });
});

/* ═══════════════════════ 3. the identity ═══════════════════════════════════ */

describe('M3 slice 2 — what makes two notifications the same notification', () => {
  const base = {
    repositoryRoot: 'C:\\repo',
    taskId: 'T-1',
    reason: 'ESCALATED_DECISION_REQUIRED',
    detail: null,
    stateEnteredAt: '2026-09-01T00:00:00.000Z',
  };

  it('is stable for an unchanged condition', () => {
    expect(attentionIdFor(base)).toBe(attentionIdFor({ ...base }));
  });

  it('produces a name this build recognises', () => {
    expect(isAttentionFileName(`${attentionIdFor(base)}.json`)).toBe(true);
  });

  for (const [field, changed] of [
    ['repositoryRoot', 'C:\\other'],
    ['taskId', 'T-2'],
    ['reason', 'SCOPE_REVIEW_REQUIRED'],
    ['detail', 'RESET_UNRECORDED'],
    ['stateEnteredAt', '2026-09-01T00:00:01.000Z'],
  ] as const) {
    it(`changes when ${field} changes`, () => {
      expect(attentionIdFor({ ...base, [field]: changed })).not.toBe(attentionIdFor(base));
    });
  }

  it('keys on the repository root rather than the declared id', () => {
    // Two clones declare one id and are two execution domains — the rule the
    // execution lease already applies by keying on the Git common directory. An
    // identity that used the declared id would deduplicate one clone's item
    // against the other's and tell the operator about only one of them.
    expect(attentionIdFor({ ...base, repositoryRoot: 'C:\\clone-a' })).not.toBe(
      attentionIdFor({ ...base, repositoryRoot: 'C:\\clone-b' }),
    );
  });

  it('separates an absent detail from an empty one', () => {
    expect(attentionIdFor({ ...base, detail: null })).not.toBe(
      attentionIdFor({ ...base, detail: '' }),
    );
  });
});

/* ═══════════════════ 4. settling against durable state ═════════════════════ */

/** A repository runtime directory holding hand-written state files. */
function runtimeRepository(id: string, states: Readonly<Record<string, TaskState>>): string {
  const root = makeCanonicalTempDir('ao-m3s2-repo-');
  created.push(root);
  for (const [taskId, value] of Object.entries(states)) {
    const path = join(root, '.agent-orchestrator', 'runtime', `${taskId}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ ...value, taskId, repositoryId: id, repositoryRoot: root }, null, 2)}\n`,
      'utf8',
    );
  }
  return root;
}

describe('M3 slice 2 — settling the outbox against durable state', () => {
  it('raises one item for a task that needs a person, and nothing for one that does not', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', {
      'NEEDS-1': blocked('HUMAN_DECISION_REQUIRED'),
      'FINE-1': state({ state: 'IMPLEMENTING' }),
    });

    const settlement = settleAttention(
      [{ repositoryId: 'fixture', repositoryRoot: root }],
      NOW,
      { pathProvider: provider },
    );

    expect(settlement.scan.statesRead).toBe(2);
    expect(settlement.raised).toHaveLength(1);
    expect(settlement.raised[0]?.taskId).toBe('NEEDS-1');
    expect(settlement.alreadyOpen).toBe(0);
    expect(listAttentionRecords(provider).records).toHaveLength(1);
  });

  it('raises nothing the second time over an unchanged repository', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('HUMAN_DECISION_REQUIRED') });
    const subjects = [{ repositoryId: 'fixture', repositoryRoot: root }];

    expect(settleAttention(subjects, NOW, { pathProvider: provider }).raised).toHaveLength(1);
    // The property that makes a forty-cycle scheduler quiet. `raised` is what
    // gets said out loud; `alreadyOpen` is the de-duplication, counted.
    const second = settleAttention(subjects, NOW, { pathProvider: provider });
    expect(second.raised).toHaveLength(0);
    expect(second.alreadyOpen).toBe(1);
    expect(listAttentionRecords(provider).records).toHaveLength(1);
  });

  it('removes an item whose condition is gone', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('HUMAN_DECISION_REQUIRED') });
    const subjects = [{ repositoryId: 'fixture', repositoryRoot: root }];
    settleAttention(subjects, NOW, { pathProvider: provider });
    expect(listAttentionRecords(provider).records).toHaveLength(1);

    // The operator acted: the task moved on.
    const path = join(root, '.agent-orchestrator', 'runtime', 'NEEDS-1.json');
    writeFileSync(
      path,
      `${JSON.stringify({ ...state({ state: 'IMPLEMENTING' }), taskId: 'NEEDS-1', repositoryId: 'fixture', repositoryRoot: root }, null, 2)}\n`,
      'utf8',
    );

    const settlement = settleAttention(subjects, NOW, { pathProvider: provider });
    expect(settlement.resolved).toBe(1);
    expect(settlement.raised).toHaveLength(0);
    expect(listAttentionRecords(provider).records).toHaveLength(0);
  });

  it('raises a new item when the same condition is re-entered through a new event', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('HUMAN_DECISION_REQUIRED') });
    const subjects = [{ repositoryId: 'fixture', repositoryRoot: root }];
    const first = settleAttention(subjects, NOW, { pathProvider: provider });

    // The task was continued, ran, and escalated again — a new event, and the
    // instant it entered the state is what says so.
    const path = join(root, '.agent-orchestrator', 'runtime', 'NEEDS-1.json');
    writeFileSync(
      path,
      `${JSON.stringify({ ...blocked('HUMAN_DECISION_REQUIRED', { stateEnteredAt: '2026-09-02T09:00:00.000Z' }), taskId: 'NEEDS-1', repositoryId: 'fixture', repositoryRoot: root }, null, 2)}\n`,
      'utf8',
    );

    const second = settleAttention(subjects, NOW, { pathProvider: provider });
    expect(second.raised).toHaveLength(1);
    expect(second.raised[0]?.attentionId).not.toBe(first.raised[0]?.attentionId);
    // The first item is resolved by the same pass: its condition — that exact
    // entry — is gone, and only one item stands against the task.
    expect(second.resolved).toBe(1);
    expect(listAttentionRecords(provider).records).toHaveLength(1);
  });

  it('does not empty the inbox of a repository it was not asked to look at', () => {
    const provider = fixedPathProvider(home());
    const a = runtimeRepository('a', { 'NEEDS-A': blocked('HUMAN_DECISION_REQUIRED') });
    const b = runtimeRepository('b', { 'NEEDS-B': blocked('SCOPE_VIOLATION') });

    settleAttention(
      [
        { repositoryId: 'a', repositoryRoot: a },
        { repositoryId: 'b', repositoryRoot: b },
      ],
      NOW,
      { pathProvider: provider },
    );
    expect(listAttentionRecords(provider).records).toHaveLength(2);

    // A scheduler run over half an operator's registry must not resolve away the
    // other half. Removal is scoped to the subjects actually scanned.
    const narrowed = settleAttention([{ repositoryId: 'a', repositoryRoot: a }], NOW, {
      pathProvider: provider,
    });
    expect(narrowed.resolved).toBe(0);
    expect(listAttentionRecords(provider).records).toHaveLength(2);
  });

  it('does not resolve a repository whose durable state it could not read', () => {
    // "I looked and found nothing" and "I could not look" are different answers,
    // and treating them alike would let a transient permission error dismiss a
    // scope violation. The item stays; the note says why the pass is short.
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('SCOPE_VIOLATION') });
    const subjects = [{ repositoryId: 'fixture', repositoryRoot: root }];
    expect(settleAttention(subjects, NOW, { pathProvider: provider }).raised).toHaveLength(1);

    // The record is still there and still says the same thing; this build just
    // cannot read it any more.
    writeFileSync(
      join(root, '.agent-orchestrator', 'runtime', 'NEEDS-1.json'),
      '{ half a document',
      'utf8',
    );

    const settlement = settleAttention(subjects, NOW, { pathProvider: provider });
    expect(settlement.scan.notes).toContain('STATE_UNREADABLE');
    expect(settlement.scan.items).toHaveLength(0);
    expect(settlement.resolved).toBe(0);
    expect(listAttentionRecords(provider).records).toHaveLength(1);
  });

  it('does not resolve a repository whose runtime directory would not open', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('SCOPE_VIOLATION') });
    const subjects = [{ repositoryId: 'fixture', repositoryRoot: root }];
    settleAttention(subjects, NOW, { pathProvider: provider });

    const settlement = settleAttention(subjects, NOW, {
      pathProvider: provider,
      readDirectory: () => {
        const error: NodeJS.ErrnoException = new Error('refused');
        error.code = 'EACCES';
        throw error;
      },
    });
    expect(settlement.scan.notes).toContain('RUNTIME_DIRECTORY_UNREADABLE');
    expect(settlement.scan.settled).toHaveLength(0);
    expect(settlement.resolved).toBe(0);
    expect(listAttentionRecords(provider).records).toHaveLength(1);
  });

  it('does resolve a repository whose runtime directory is simply gone', () => {
    // The control for the two cases above. An absent directory IS an answer:
    // nothing has ever run there, so nothing stands. Without this case, "it did
    // not remove anything" would be satisfied by an instrument that can never
    // remove anything.
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('SCOPE_VIOLATION') });
    const subjects = [{ repositoryId: 'fixture', repositoryRoot: root }];
    settleAttention(subjects, NOW, { pathProvider: provider });
    expect(listAttentionRecords(provider).records).toHaveLength(1);

    rmSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true, force: true });
    const settlement = settleAttention(subjects, NOW, { pathProvider: provider });
    expect(settlement.scan.notes).toContain('RUNTIME_DIRECTORY_ABSENT');
    expect(settlement.scan.settled).toEqual([root]);
    expect(settlement.resolved).toBe(1);
    expect(listAttentionRecords(provider).records).toHaveLength(0);
  });

  it('reports an absent runtime directory as ordinary', () => {
    const provider = fixedPathProvider(home());
    const root = makeCanonicalTempDir('ao-m3s2-empty-');
    created.push(root);
    const settlement = settleAttention([{ repositoryId: 'x', repositoryRoot: root }], NOW, {
      pathProvider: provider,
    });
    expect(settlement.scan.notes).toContain('RUNTIME_DIRECTORY_ABSENT');
    expect(settlement.raised).toHaveLength(0);
  });

  it('counts an unreadable state file rather than judging it', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('HUMAN_DECISION_REQUIRED') });
    const path = join(root, '.agent-orchestrator', 'runtime', 'BROKEN.json');
    writeFileSync(path, '{ not a state', 'utf8');

    const settlement = settleAttention([{ repositoryId: 'fixture', repositoryRoot: root }], NOW, {
      pathProvider: provider,
    });
    expect(settlement.scan.notes).toContain('STATE_UNREADABLE');
    expect(settlement.raised).toHaveLength(1);
  });

  it('orders items by repository then task, not by the filesystem', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', {
      'T.9': blocked('SCOPE_VIOLATION'),
      'T-1': blocked('HUMAN_DECISION_REQUIRED'),
    });
    const scan = scanAttention([{ repositoryId: 'fixture', repositoryRoot: root }], NOW);
    // `-` precedes `.` in a file-name sort while the id `T-1` also precedes
    // `T.9`; the comparator is asserted rather than the accident agreeing.
    expect(scan.items.map((item) => item.record.taskId)).toEqual(['T-1', 'T.9']);
  });

  it('survives a write the store refuses, without losing the condition', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('HUMAN_DECISION_REQUIRED') });
    const settlement = settleAttention([{ repositoryId: 'fixture', repositoryRoot: root }], NOW, {
      pathProvider: provider,
      writeRecord: () =>
        Object.freeze({ code: 'STORE_UNAVAILABLE' as const, attentionId: 'x', errnoCode: null }),
    });

    expect(settlement.raised).toHaveLength(0);
    expect(settlement.refusals).toEqual(['STORE_UNAVAILABLE']);
    // The condition is still in the task's own durable state, so the next pass
    // finds it again. That is why a refused write is counted and not fatal.
    expect(settlement.scan.items).toHaveLength(1);
  });
});

/* ═══════════════════════ 5. what an operator reads ═════════════════════════ */

describe('M3 slice 2 — the attention section', () => {
  function reportFor(settlement: AttentionSettlement): AttentionReport {
    return {
      settlement,
      push: Object.freeze({
        outcome: 'NOT_CONFIGURED' as const,
        attempted: 0,
        delivered: 0,
        failures: Object.freeze([]),
        configCode: null,
      }),
    };
  }

  it('has a sentence for every scan note and every push outcome', () => {
    for (const note of ATTENTION_SCAN_NOTES) {
      expect(ATTENTION_SCAN_NOTE_SENTENCES[note]).toBeTypeOf('string');
      expect(ATTENTION_SCAN_NOTE_SENTENCES[note].length).toBeGreaterThan(0);
    }
    for (const outcome of ATTENTION_PUSH_OUTCOMES) {
      expect(ATTENTION_PUSH_SENTENCES[outcome]).toBeTypeOf('string');
      expect(ATTENTION_PUSH_SENTENCES[outcome].length).toBeGreaterThan(0);
    }
  });

  it('prints nothing at all when nobody is needed', () => {
    // A run over repositories that all needed nobody must gain no section. An
    // operator who never sees this heading has been told something by its
    // absence, which is the same rule `renderRunResult` follows about denials.
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'FINE-1': state({ state: 'IMPLEMENTING' }) });
    const settlement = settleAttention([{ repositoryId: 'fixture', repositoryRoot: root }], NOW, {
      pathProvider: provider,
    });
    expect(renderAttention([reportFor(settlement)])).toBeNull();
    expect(renderAttention([])).toBeNull();
  });

  it('names the task, the reading and the exact command', () => {
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', {
      'STUCK-1': blocked('BLOCKED_USAGE_LIMIT', {
        reportedResetAt: PAST,
        currentCommit: null,
        worktreeCleanAtCheckpoint: false,
      }),
    });
    const settlement = settleAttention([{ repositoryId: 'fixture', repositoryRoot: root }], NOW, {
      pathProvider: provider,
    });
    const text = renderAttention([reportFor(settlement)]);

    expect(text).not.toBeNull();
    expect(text).toContain('Needs an operator');
    expect(text).toContain('fixture / STUCK-1');
    expect(text).toContain('QUOTA_CONTINUATION_REQUIRED');
    expect(text).toContain('RESUME_RECORD_WITHDRAWN');
    expect(text).toContain('--continue-usage-limit');
    expect(text).toContain(PAST);
    // The layered claim, stated rather than implied: recorded here, sent
    // nowhere, because nobody configured anywhere to send it.
    expect(text).toContain('NOT_CONFIGURED');
  });

  it('prints no filesystem path', () => {
    // The record carries the repository root, because the store sits outside
    // every repository and a record that could not say where it came from would
    // be useless. The *report* does not need one, and a console line is the
    // easiest place for a layout to leak into a log somebody pastes.
    const provider = fixedPathProvider(home());
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('SCOPE_VIOLATION') });
    const settlement = settleAttention([{ repositoryId: 'fixture', repositoryRoot: root }], NOW, {
      pathProvider: provider,
    });
    const text = renderAttention([reportFor(settlement)]) ?? '';
    expect(text).not.toContain(root);
  });
});

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 6. the invocation that asked for none of this \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */

describe('M3 slice 2 — without --wait-for-reset, nothing here is reached', () => {
  /**
   * The promise two module headers make, measured rather than asserted.
   *
   * `repositories --attended` without the wait grant must open exactly what it
   * always opened: no notification configuration, no runtime directory, no
   * store. It is the same promise the wake scan already keeps and it is kept the
   * same way — by not being reached — and an unmeasured "by not being reached"
   * is how a header stops describing its code.
   */
  it('creates no store and reads no notification configuration', async () => {
    const scratch = home();
    const provider = fixedPathProvider(scratch);
    // A configuration that would arm a push if anything read it. Nothing should.
    mkdirSync(join(scratch, '.agent-orchestrator'), { recursive: true });
    writeFileSync(
      join(scratch, '.agent-orchestrator', 'notify.yaml'),
      'schemaVersion: 1\nendpoint: https://ntfy.example.invalid\ntopic: ao\n',
      'utf8',
    );
    const root = runtimeRepository('fixture', { 'NEEDS-1': blocked('HUMAN_DECISION_REQUIRED') });
    writeFileSync(
      join(scratch, '.agent-orchestrator', 'repositories.yaml'),
      `schemaVersion: 1\\nrepositories:\\n  - path: ${JSON.stringify(root)}\\n`,
      'utf8',
    );

    let text = '';
    const program = new Command();
    program.exitOverride();
    registerRepositoriesCommand(program, {
      write: (chunk: string) => {
        text += chunk;
      },
      loadRepositoryRegistry: () => loadRepositoryRegistry(provider),
      repositoryRegistryPath: () => repositoryRegistryPath(provider),
      // The pass itself is substituted: the subject here is what the command
      // opens around it, not what a coordinator does.
      driveScheduler: async () =>
        Object.freeze({
          cycles: Object.freeze([]),
          ending: 'NOT_REQUESTED' as const,
          registryRefusal: null,
        }),
      // If this is reached, the invocation did something it promised not to. A
      // seam rather than a spy, for exactly that reason.
      settleAttention: () => {
        throw new Error('the outbox must not be settled without --wait-for-reset');
      },
    });

    const previous = process.exitCode;
    try {
      await program.parseAsync([
        'node',
        'agent-loop',
        'repositories',
        '--attended',
        '--max-steps',
        '1',
        '--max-invocations',
        '1',
      ]);
    } finally {
      process.exitCode = previous;
    }

    // No store, and no section in the report asking anybody for anything.
    expect(existsSync(operatorAttentionRoot(provider))).toBe(false);
    expect(text).not.toContain('Needs an operator');
    // …and the task that WOULD have raised one really is there, so this is
    // "it did not look" rather than "there was nothing to find".
    const wouldRaise = settleAttention([{ repositoryId: 'fixture', repositoryRoot: root }], NOW, {
      pathProvider: provider,
    });
    expect(wouldRaise.raised).toHaveLength(1);
  });
});

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 7. saying it out loud \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */

describe('M3 slice 2 — announcing what was raised', () => {
  function armed(sent: AttentionPush[]): AttentionNotifier {
    return Object.freeze({
      state: 'ARMED' as const,
      configCode: null,
      transport: async (notification: AttentionPush) => {
        sent.push(notification);
        return { ok: true as const };
      },
    });
  }

  it('sends nothing when nothing was newly raised', async () => {
    const sent: AttentionPush[] = [];
    const push = await pushAttentionItems(armed(sent), []);
    expect(push.outcome).toBe('NOTHING_TO_SEND');
    expect(sent).toHaveLength(0);
  });

  it('sends one message per newly raised item', async () => {
    const sent: AttentionPush[] = [];
    const push = await pushAttentionItems(armed(sent), [record(), record({ taskId: 'T-2' })]);
    expect(push.outcome).toBe('DELIVERED');
    expect(push.attempted).toBe(2);
    expect(sent.map((item) => item.taskId)).toEqual(['T-1', 'T-2']);
  });

  it('opens nothing on a machine with no configuration', async () => {
    // The default, and the property the shipped-artefact harness measures with
    // no seam at all: the state comes from the file, not from the factory, so an
    // unconfigured machine is `NOT_CONFIGURED` whatever a caller passes.
    const notifier = createAttentionNotifier(fixedPathProvider(home()));
    expect(notifier.state).toBe('NOT_CONFIGURED');
    expect(notifier.transport).toBeNull();
    const push = await pushAttentionItems(notifier, [record()]);
    expect(push.outcome).toBe('NOT_CONFIGURED');
    expect(push.attempted).toBe(0);
  });

  it('reports a failing endpoint and changes nothing', async () => {
    const notifier: AttentionNotifier = Object.freeze({
      state: 'ARMED' as const,
      configCode: null,
      transport: async () => ({ ok: false as const, code: 'REJECTED_BY_SERVER' as const }),
    });
    const push = await pushAttentionItems(notifier, [record()]);
    expect(push.outcome).toBe('FAILED');
    expect(push.failures).toEqual(['REJECTED_BY_SERVER']);
  });

  it('never lets a throwing transport escape', async () => {
    const notifier: AttentionNotifier = Object.freeze({
      state: 'ARMED' as const,
      configCode: null,
      transport: async () => {
        throw new Error('a network stack message with a host in it');
      },
    });
    const push = await pushAttentionItems(notifier, [record()]);
    expect(push.outcome).toBe('FAILED');
    expect(push.failures).toEqual(['TRANSPORT_THREW']);
  });

  it('puts no filesystem path on the wire', () => {
    const item = record({ reportedResetAt: PAST, detail: 'RESUME_RECORD_WITHDRAWN' });
    const wire = attentionPushFor(item);
    // Field by field, and the two paths the durable record carries are the two
    // that must not leave the machine. The declared id identifies the repository
    // on the wire, which is the rule `notify/notification.ts` already follows.
    expect(JSON.stringify(wire)).not.toContain('C:\\');
    expect(Object.keys(wire).sort()).toEqual([
      'action',
      'attentionId',
      'detail',
      'reason',
      'reportedResetAt',
      'repositoryId',
      'state',
      'taskId',
    ]);
  });
});
