/**
 * M4 completion slice — the four unattended blockers, measured.
 *
 * The closing audit classified `U1`–`U4` as `UNATTENDED_BLOCKER` and said the
 * thing they have in common: *the run's ending, and the machine's state after
 * it, depend on a human being there*. This file is where each closure is
 * measured rather than argued, and it is organised by blocker so that a reader
 * who wants to know whether `U2` is really closed reads one section.
 *
 * ── The rule this file holds itself to ────────────────────────────────────
 *
 * A seam proves how a module *classifies* an answer, never that an effect
 * happened. Every claim below that is about an effect — a lease removed, a
 * record written, a signal handled — is measured against production code and
 * real files on disk. Where a case genuinely cannot be staged inside a vitest
 * worker, it says so and names the artefact harness that does stage it, rather
 * than substituting a seam and calling the substitution a proof.
 *
 * ── Section 1: U1, the lease a dead predecessor left ──────────────────────
 *
 * `L-M3-F-1` recorded the open half of `U1`: `agent-loop lease recover` clears
 * the ordinary crash with no operator input, and *nothing in AgentOrchestrator
 * calls it*, so a recurring invocation whose predecessor died inside a pass
 * refused that repository on every cycle for as long as its budget lasted.
 *
 * The closure is one field — the coordinator now admits with
 * `recoverStaleLease: true` — and the whole question is whether that field is
 * safe. It is safe because `recoverStaleLease` is fail-closed and stays so, and
 * the two cases below are the two halves of that sentence:
 *
 *  - a stale lease is now **attempted**, where before the driver short-circuited
 *    without looking. Observable as an outcome change, through production code
 *    from the coordinator down, with no seam anywhere in the lease path;
 *  - and an attempt that cannot prove the world safe **removes nothing**,
 *    measured on the bytes.
 *
 * The lease fixture here has no writer-launch ledger, so the recovery refuses
 * `LAUNCH_HISTORY_ABSENT` — which is exactly what makes it the right instrument
 * for the second half. The *successful* removal needs a real owner that really
 * dies with a real contained launch under it, which a vitest worker cannot
 * stage; `tests/dist-artifact/lifecycle-restart-dist-artifact.mjs` measures that
 * against the shipped artefact, and this file does not pretend to.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';

import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { passingReview } from './fixtures.js';
import {
  recordedAgent,
  recordedVerify,
  reload,
  reviewResult,
  seedDeliveredState,
  startTask,
  writerSuccess,
  type StartedTask,
} from './helpers/e2e-fixtures.js';

import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { ALL_STATES } from '../src/core/states.js';
import {
  attentionForRunCondition,
  RUN_ATTENTION_ACTIONS,
  RUN_ATTENTION_JUDGED_CONDITIONS,
  RUN_THREW,
  type RunCondition,
} from '../src/core/run-attention.js';
import {
  deriveExecutionLeaseLocation,
  releaseRepositoryExecutionLease,
  type LeaseRepository,
} from '../src/lease/execution-lease.js';
import {
  pushAttentionItems,
  type AttentionNotifier,
} from '../src/notify/attention-notification.js';
import {
  MAX_ANNOUNCED_ITEMS_PER_SETTLE,
  settleAttention,
} from '../src/notify/attention-outbox.js';
import { listAttentionRecords } from '../src/notify/attention-store.js';
import {
  ATTENTION_STORE_SENTENCES,
  attentionStoreReading,
  renderAttentionStore,
} from '../src/cli/render-attention.js';
import { resolveRepository } from '../src/repo/resolve-repository.js';
import type { RegisteredRepository } from '../src/registry/repository-registry.js';
import { LIFECYCLE_OUTCOMES, type LifecycleResult } from '../src/run/lifecycle-driver.js';
import {
  driveRepositories,
  type CrossRepositoryRunResult,
} from '../src/run/repository-coordinator.js';
import { registerRepositoriesCommand } from '../src/cli/repositories-command.js';
import {
  loadRepositoryRegistry,
  repositoryRegistryPath,
} from '../src/registry/repository-registry.js';
import { runGitCommand } from '../src/worktree/git-command.js';

/* ─────────────────────────────── fixtures ───────────────────────────────── */

const created: string[] = [];

function git(root: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd: root, stdio: 'pipe' });
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function profileYaml(id: string): string {
  return `schemaVersion: 1
repository:
  id: ${id}
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: .agent-orchestrator/tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: VERIFY
      command: [node, --version]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: 1
remote:
  required: false
`;
}

function taskFile(id: string): string {
  return `---
id: ${id}
title: task ${id}
status: OPEN
kind: NORMAL
priority: NORMAL
currentFocus: false
dependsOn: []
---
body
`;
}

/** A real Git repository with a profile and one open task. */
function makeRepository(id: string, tasks: readonly string[]): string {
  const root = makeCanonicalTempDir('ao-m4-01-');
  created.push(root);
  git(root, ['init', '-b', 'main', '--quiet']);
  write(root, '.gitattributes', '* -text\n');
  write(root, '.gitignore', '.agent-orchestrator/runtime/\n');
  write(root, 'README.md', `# ${id}\n`);
  write(root, '.agent-orchestrator/repo-profile.yaml', profileYaml(id));
  for (const task of tasks) write(root, `.agent-orchestrator/tasks/${task}.md`, taskFile(task));
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

async function registered(root: string): Promise<RegisteredRepository> {
  const resolution = await resolveRepository({ repositoryPath: root });
  if (!resolution.ok) throw new Error(`fixture did not resolve: ${resolution.code}`);
  return Object.freeze({ declaredPath: root, repository: resolution.repository });
}

afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked Git file on Windows must not fail an otherwise passing suite.
    }
  }
});

/* ────────────────────────────── instruments ─────────────────────────────── */

function leasePathOf(repository: LeaseRepository): string {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return location.path;
}

/**
 * A lease whose recorded owner is a process id nothing is running under.
 *
 * Built the way `tests/v3-06-lifecycle-driver.test.ts` builds one: take the real
 * lease through the real entry point, keep its bytes, give it back, and write
 * them again with a dead owner. One field is fabricated, and it is the one field
 * a crashed run leaves genuinely stale.
 */
function staleLeaseAt(repository: LeaseRepository): void {
  const path = leasePathOf(repository);
  const evidence = leaseFor(repository);
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  releaseRepositoryExecutionLease(evidence);
  writeFileSync(
    path,
    `${JSON.stringify({ ...document, ownerPid: deadProcessId() }, null, 2)}\n`,
    'utf8',
  );
}

/** A process id that is not running. Verified, never assumed. */
function deadProcessId(): number {
  for (let candidate = 60_000; candidate < 65_000; candidate += 7) {
    try {
      process.kill(candidate, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('no dead process id could be established');
}

/** Two instants, so a second pass can be told apart from the first. */
const NOW = '2026-09-02T12:00:00.000Z';
const LATER = '2026-09-02T13:00:00.000Z';

/**
 * A scratch orchestrator home for the attention store.
 *
 * Per test rather than shared. The store's whole concurrency design is one file
 * name per condition, so two tests sharing a root would deduplicate against each
 * other and the second would measure the first's record.
 */
function store(): string {
  const dir = makeCanonicalTempDir('ao-m4-store-');
  created.push(dir);
  return dir;
}

/** The dependencies a coordinator run needs. No seam touches the lease path. */
const DEPS = {
  now: (): string => new Date().toISOString(),
  git: runGitCommand,
  authPreflight: async (): Promise<ReturnType<typeof provenAuthEvidence>> =>
    provenAuthEvidence(),
};

/* ═══════════ 1. U1 — the recurring loop looks at a stale lease ════════════ */

describe('M4 / U1 — a recurring invocation attempts the lease its predecessor left', () => {
  it('reaches the recovery assessment instead of short-circuiting', async () => {
    const root = makeRepository('u1-attempted', ['T1']);
    const entry = await registered(root);
    staleLeaseAt(entry.repository);

    const result = await driveRepositories(
      { repositories: [entry], maxConcurrentRepositories: 1, maxSteps: 1, maxInvocations: 1 },
      DEPS,
    );

    // The whole closure, in one value. `STALE_LEASE_PRESENT` is the outcome the
    // driver produces when it was *not permitted to look* — it short-circuits
    // before `recoverStaleLease` is called at all, and carries the reason code
    // `STALE_RECOVERY_NOT_PERMITTED`. That is what a recurring invocation got on
    // every cycle before this slice, and it is what `L-M3-F-1` recorded.
    //
    // `RECOVERY_UNSAFE` is the opposite condition: the assessment ran, looked at
    // this repository's actual world, and refused it. The distinction is the
    // measurement — not that recovery succeeded, but that it was *attempted*
    // through production code with no seam in the lease path.
    const [admission] = result.admissions;
    expect(admission).toBeDefined();
    expect(admission?.lifecycle?.outcome).toBe('RECOVERY_UNSAFE');
    expect(admission?.lifecycle?.outcome).not.toBe('STALE_LEASE_PRESENT');
    expect(admission?.lifecycle?.reasonCodes ?? []).not.toContain(
      'STALE_RECOVERY_NOT_PERMITTED',
    );
  });

  it('removes nothing when the assessment cannot prove the world safe', async () => {
    const root = makeRepository('u1-fail-closed', ['T1']);
    const entry = await registered(root);
    staleLeaseAt(entry.repository);
    const before = readFileSync(leasePathOf(entry.repository), 'utf8');

    const result = await driveRepositories(
      { repositories: [entry], maxConcurrentRepositories: 1, maxSteps: 1, maxInvocations: 1 },
      DEPS,
    );

    // The other half of "safe because it is fail-closed". This fixture has no
    // writer-launch ledger, so the assessment cannot account for what the dead
    // owner launched and must refuse. Asserted on the bytes rather than on the
    // report: a recovery that reported a refusal and had already unlinked the
    // file would satisfy every code-level assertion and none of this one.
    expect(result.admissions[0]?.lifecycle?.outcome).toBe('RECOVERY_UNSAFE');
    expect(readFileSync(leasePathOf(entry.repository), 'utf8')).toBe(before);
  });
});

/* ═══════ 2. U3 — an ending that leaves no task state still reaches you ════ */

describe('M4 / U3 — the judgement table over run conditions', () => {
  it('has a rule for every lifecycle outcome, at runtime', () => {
    // `satisfies Record<RunCondition, …>` is a claim about a literal that the
    // type checker makes. This is the same claim made where a test can see it,
    // so an outcome added to `LIFECYCLE_OUTCOMES` and forgotten in the table
    // fails here rather than being judged by whatever `undefined` does.
    for (const outcome of LIFECYCLE_OUTCOMES) {
      expect(RUN_ATTENTION_JUDGED_CONDITIONS).toContain(outcome);
    }
    expect([...RUN_ATTENTION_JUDGED_CONDITIONS].sort()).toEqual(
      [...LIFECYCLE_OUTCOMES, RUN_THREW].sort(),
    );
  });

  it('says nothing about an ending the task scan already judges', () => {
    // The rule, in the direction that matters most. Every lifecycle outcome
    // whose *name* is also a task state leaves a durable record, and
    // `attentionForTaskState` judges that record — so judging it here as well
    // would put two items in one operator's inbox for one condition, each
    // needing its own resolution.
    //
    // Derived from `ALL_STATES` rather than listed, so a state added to the
    // vocabulary later cannot quietly acquire a second opinion.
    const alsoAState = LIFECYCLE_OUTCOMES.filter((outcome) =>
      (ALL_STATES as readonly string[]).includes(outcome),
    );
    // The control: if this set were empty the assertion below would hold
    // vacuously and would measure nothing at all.
    expect(alsoAState.length).toBeGreaterThan(5);
    for (const outcome of alsoAState) {
      expect({ outcome, attention: attentionForRunCondition(outcome).attention }).toEqual({
        outcome,
        attention: false,
      });
    }
  });

  /**
   * Every silent condition, by value, with the reason it is silent.
   *
   * Listed rather than derived, and the first draft of this file derived it —
   * "silent iff the outcome's name is also a state name" — which was wrong on
   * its first run and wrong in the direction that hides a defect. `TASK_ABORTED`
   * is a lifecycle outcome whose durable state is `ABORTED`: the names differ by
   * a prefix, so a name-matching rule called it "not a state" and demanded an
   * item for a task somebody had already deliberately ended.
   *
   * A derived rule that is nearly right is worse than a list, because it keeps
   * being nearly right as the vocabulary grows. The list is exhaustive over the
   * silent half and the assertion below is exhaustive over the whole table, so a
   * condition added to either side without a decision fails here.
   */
  const SILENT: readonly (readonly [RunCondition, string])[] = [
    ['LIVE_OWNER_PRESENT', 'another owner holds the lease: the lease working, not failing'],
    ['COMPLETED', 'the intended end'],
    ['INVOCATION_BUDGET_EXHAUSTED', 'the operator’s own bound, reached'],
    ['TASK_ABORTED', 'leaves ABORTED, which the task table calls silent: an end somebody chose'],
    ['BLOCKED_USAGE_LIMIT', 'leaves BLOCKED_USAGE_LIMIT, judged against the clock by the scan'],
    ['BLOCKED_VERIFY', 'leaves BLOCKED_VERIFY, which the task table raises'],
    ['BLOCKED_AUTH', 'leaves BLOCKED_AUTH, which the task table raises'],
    ['SCOPE_VIOLATION', 'leaves SCOPE_VIOLATION, which the task table raises'],
    ['RESUME_STATE_DIVERGED', 'leaves RESUME_STATE_DIVERGED, which the task table raises'],
    ['HUMAN_DECISION_REQUIRED', 'leaves HUMAN_DECISION_REQUIRED, which the task table raises'],
  ];

  it('asks for a person on every ending that leaves no task state', () => {
    // Exhaustive over the table in both directions at once: every condition is
    // judged, and its answer is compared against the list above. An outcome that
    // is silent and is not in the list fails; one that is in the list and is
    // loud fails; and a condition added to the vocabulary is neither, so it
    // fails too.
    const silent = new Set(SILENT.map(([condition]) => condition));
    const observed = RUN_ATTENTION_JUDGED_CONDITIONS.map((condition) => ({
      condition,
      attention: attentionForRunCondition(condition).attention,
    }));
    expect(observed).toEqual(
      RUN_ATTENTION_JUDGED_CONDITIONS.map((condition) => ({
        condition,
        attention: !silent.has(condition),
      })),
    );
    // The control on the list itself: every silent member that names a durable
    // state must really name one, so a future rename cannot leave a stale
    // justification standing beside a member that is now silent for no reason.
    for (const [condition, why] of SILENT) {
      if (!why.startsWith('leaves ')) continue;
      const named = why.slice('leaves '.length).split(',')[0] ?? '';
      expect(ALL_STATES as readonly string[]).toContain(named);
    }
  });

  it('gives every attention condition a sentence out of the fixed table', () => {
    for (const condition of RUN_ATTENTION_JUDGED_CONDITIONS) {
      const judgement = attentionForRunCondition(condition);
      if (!judgement.attention) {
        expect(judgement.action).toBeNull();
        continue;
      }
      // The sentence comes from the table keyed by the reason, and from nowhere
      // else. A judgement that built its own string would be a second place the
      // advice lives, and the two would drift.
      expect(judgement.action).toBe(RUN_ATTENTION_ACTIONS[judgement.reason]);
    }
  });
});

describe('M4 / U3 — the condition reaches the durable outbox', () => {
  it('raises a repository item for a repository that has never run', () => {
    // The case `U3` is actually about, and the one a scan of task states can
    // never reach: first cycle, first day, the lease unreachable, and **no
    // runtime directory anywhere** because nothing has ever run there. Before
    // this slice the scan met `ENOENT`, recorded `RUNTIME_DIRECTORY_ABSENT`,
    // settled the repository as "nothing stands", and said nothing at all.
    const provider = fixedPathProvider(store());
    const root = makeRepository('u3-never-ran', ['T1']);

    const settlement = settleAttention(
      [{ repositoryId: 'u3-never-ran', repositoryRoot: root, conditions: ['RECOVERY_UNSAFE'] }],
      NOW,
      { pathProvider: provider },
    );

    expect(settlement.scan.notes).toContain('RUNTIME_DIRECTORY_ABSENT');
    expect(settlement.raised).toHaveLength(1);
    const item = settlement.raised[0];
    expect(item?.subject).toBe('REPOSITORY');
    expect(item?.repositoryRoot).toBe(root);
    expect(item !== undefined && item.subject === 'REPOSITORY' ? item.condition : null).toBe(
      'RECOVERY_UNSAFE',
    );
    expect(item?.reason).toBe('REPOSITORY_LEASE_UNRESOLVED');
    // On disk, not merely in the return value. A record nobody can read back is
    // not an outbox item, and the whole point of the durable half is that the
    // file outlives the process that wrote it.
    expect(listAttentionRecords(provider).records.map((entry) => entry.attentionId)).toEqual([
      item?.attentionId,
    ]);
  });

  it('says the same condition once however many cycles meet it', () => {
    // The deduplication, which is what makes this safe to run at scheduler
    // cadence. A condition that held for a week would otherwise be a file and a
    // push per repository per cycle — the spam this store exists to prevent, and
    // the reason a repository identity carries no instant.
    const provider = fixedPathProvider(store());
    const root = makeRepository('u3-once', ['T1']);
    const subject = {
      repositoryId: 'u3-once',
      repositoryRoot: root,
      conditions: ['RECOVERY_UNSAFE'] as const,
    };

    const first = settleAttention([subject], NOW, { pathProvider: provider });
    const second = settleAttention([subject], LATER, { pathProvider: provider });

    expect(first.raised).toHaveLength(1);
    expect(second.raised).toHaveLength(0);
    expect(second.alreadyOpen).toBe(1);
    // And the record still standing is the first one, unchanged: the second pass
    // observed the same condition and did not rewrite its `observedAt`.
    expect(listAttentionRecords(provider).records[0]?.observedAt).toBe(NOW);
  });

  it('removes the item when the condition stops', () => {
    // Settlement by removal, on the subject that did not exist when the removal
    // was written. An outbox that only ever grew would need an operator to empty
    // it, which is the attendance this slice exists to remove.
    const provider = fixedPathProvider(store());
    const root = makeRepository('u3-cleared', ['T1']);

    settleAttention(
      [{ repositoryId: 'u3-cleared', repositoryRoot: root, conditions: ['RECOVERY_UNSAFE'] }],
      NOW,
      { pathProvider: provider },
    );
    const cleared = settleAttention(
      [{ repositoryId: 'u3-cleared', repositoryRoot: root, conditions: ['COMPLETED'] }],
      LATER,
      { pathProvider: provider },
    );

    expect(cleared.resolved).toBe(1);
    expect(listAttentionRecords(provider).records).toEqual([]);
  });

  it('raises nothing for a caller that passes no conditions at all', () => {
    // The M3-02 behaviour, unchanged and measured rather than promised. Absent
    // is not empty: a caller that is not a coordinator pass gets exactly the
    // task scan it always got, and nothing this slice added.
    const provider = fixedPathProvider(store());
    const root = makeRepository('u3-untouched', ['T1']);

    const settlement = settleAttention(
      [{ repositoryId: 'u3-untouched', repositoryRoot: root }],
      NOW,
      { pathProvider: provider },
    );

    expect(settlement.raised).toEqual([]);
    expect(listAttentionRecords(provider).records).toEqual([]);
  });

  it('writes one item for two admissions that ended the same way', () => {
    // One repository can be admitted more than once in a pass, so two identical
    // endings are two members of the list. They are one *condition*, so they are
    // one record — and without the de-duplication in the scan they would derive
    // the same file name twice and the second would be reported as a refusal
    // that nothing had refused.
    const provider = fixedPathProvider(store());
    const root = makeRepository('u3-twice', ['T1', 'T2']);

    const settlement = settleAttention(
      [
        {
          repositoryId: 'u3-twice',
          repositoryRoot: root,
          conditions: ['RECOVERY_UNSAFE', 'RECOVERY_UNSAFE'],
        },
      ],
      NOW,
      { pathProvider: provider },
    );

    expect(settlement.scan.items).toHaveLength(1);
    expect(settlement.raised).toHaveLength(1);
    expect(settlement.refusals).toEqual([]);
  });
});

/* ═════════ 3. U2 — a failed notification is no longer silence ═════════════ */

/** A notifier whose transport answers however the test says, and counts. */
function notifier(answers: readonly boolean[]): {
  readonly notifier: AttentionNotifier;
  readonly sent: string[];
} {
  const sent: string[] = [];
  let call = 0;
  return {
    sent,
    notifier: {
      state: 'ARMED',
      configCode: null,
      transport: async (push) => {
        const ok = answers[Math.min(call, answers.length - 1)] ?? true;
        call += 1;
        sent.push(push.attentionId);
        return ok ? { ok: true } : { ok: false, code: 'REJECTED_BY_SERVER' };
      },
    },
  };
}

describe('M4 / U2 — a send that failed is tried again', () => {
  it('offers the item again on the next pass when the endpoint refused', async () => {
    // The defect, and its repair, in one case. Before this slice a pass pushed
    // `settlement.raised`, which is what the *exclusive create* returned — so an
    // item whose send failed had its name taken for ever, and no later pass
    // could ever try it again. A dropped message was permanent.
    const provider = fixedPathProvider(store());
    const root = makeRepository('u2-retry', ['T1']);
    const subject = {
      repositoryId: 'u2-retry',
      repositoryRoot: root,
      conditions: ['RECOVERY_UNSAFE'] as const,
    };

    const refusing = notifier([false]);
    const first = settleAttention([subject], NOW, { pathProvider: provider });
    await pushAttentionItems(refusing.notifier, first.undelivered, { pathProvider: provider });

    const second = settleAttention([subject], LATER, { pathProvider: provider });

    // The store deduplicated the *record* — that half is unchanged and must be.
    expect(second.raised).toEqual([]);
    expect(second.alreadyOpen).toBe(1);
    // And the item is still offered, because nobody ever acknowledged it.
    expect(second.undelivered.map((entry) => entry.attentionId)).toEqual([
      first.undelivered[0]?.attentionId,
    ]);
    expect(second.undeliveredTotal).toBe(1);
  });

  it('stops offering it once an endpoint has acknowledged it', async () => {
    // The other half, and the one that keeps repeated passes quiet. A retry that
    // never stopped would be the notification spam this store exists to prevent,
    // arriving once per cycle for as long as the condition stood.
    const provider = fixedPathProvider(store());
    const root = makeRepository('u2-once', ['T1']);
    const subject = {
      repositoryId: 'u2-once',
      repositoryRoot: root,
      conditions: ['RECOVERY_UNSAFE'] as const,
    };

    const accepting = notifier([true]);
    const first = settleAttention([subject], NOW, { pathProvider: provider });
    const push = await pushAttentionItems(accepting.notifier, first.undelivered, {
      pathProvider: provider,
    });

    expect(push.outcome).toBe('DELIVERED');
    expect(accepting.sent).toHaveLength(1);

    const second = settleAttention([subject], LATER, { pathProvider: provider });
    expect(second.undelivered).toEqual([]);
    expect(second.undeliveredTotal).toBe(0);

    // Nothing is sent on the second pass, measured on the transport rather than
    // on the offer: a set that was empty and a transport that was called anyway
    // would be the same defect wearing a different value.
    await pushAttentionItems(accepting.notifier, second.undelivered, { pathProvider: provider });
    expect(accepting.sent).toHaveLength(1);
  });

  it('writes the receipt where a reader can find it, and takes it away with the record', async () => {
    // The receipt is a file, and the whole of `U2`'s readable half rests on the
    // listing seeing it. It must also not outlive its record: an orphan receipt
    // would make a recurrence of the same condition — which re-uses the same
    // identity — be born already acknowledged and never sent.
    const provider = fixedPathProvider(store());
    const root = makeRepository('u2-receipt', ['T1']);
    const subject = {
      repositoryId: 'u2-receipt',
      repositoryRoot: root,
      conditions: ['RECOVERY_UNSAFE'] as const,
    };

    const accepting = notifier([true]);
    const first = settleAttention([subject], NOW, { pathProvider: provider });
    await pushAttentionItems(accepting.notifier, first.undelivered, { pathProvider: provider });

    const id = first.undelivered[0]?.attentionId ?? '';
    expect(listAttentionRecords(provider).delivered).toEqual([id]);

    // The condition clears, so the record is removed — and the receipt with it.
    settleAttention(
      [{ repositoryId: 'u2-receipt', repositoryRoot: root, conditions: ['COMPLETED'] }],
      LATER,
      { pathProvider: provider },
    );
    const after = listAttentionRecords(provider);
    expect(after.records).toEqual([]);
    expect(after.delivered).toEqual([]);

    // And the same condition, recurring, is announced again rather than being
    // silently treated as already delivered.
    const again = settleAttention([subject], LATER, { pathProvider: provider });
    expect(again.raised).toHaveLength(1);
    expect(again.undelivered).toHaveLength(1);
  });

  it('bounds one pass and still reports the true backlog', () => {
    // The bound exists so that a large inherited store cannot turn one pass into
    // an unbounded run of ten-second network attempts. What it must not do is
    // make the *number* look smaller than it is: an operator reading "16" when
    // 20 things are unacknowledged would be told a comforting lie.
    const provider = fixedPathProvider(store());
    const roots = Array.from({ length: MAX_ANNOUNCED_ITEMS_PER_SETTLE + 4 }, (_, index) =>
      makeRepository(`u2-many-${String(index)}`, ['T1']),
    );

    const settlement = settleAttention(
      roots.map((root, index) => ({
        repositoryId: `u2-many-${String(index)}`,
        repositoryRoot: root,
        conditions: ['RECOVERY_UNSAFE'] as const,
      })),
      NOW,
      { pathProvider: provider },
    );

    expect(settlement.undelivered).toHaveLength(MAX_ANNOUNCED_ITEMS_PER_SETTLE);
    expect(settlement.undeliveredTotal).toBe(MAX_ANNOUNCED_ITEMS_PER_SETTLE + 4);
  });
});

describe('M4 / U2 — the outbox can be read without a notification endpoint', () => {
  it('prints the open items and which of them nobody was told about', async () => {
    // The second channel, which is what makes the first one's silence readable.
    // A machine with no `notify.yaml` at all still has this, and it is the only
    // thing that distinguishes "quiet because nothing is wrong" from "quiet
    // because the endpoint has been refusing since Tuesday".
    const provider = fixedPathProvider(store());
    const quiet = makeRepository('u2-read-quiet', ['T1']);
    const loud = makeRepository('u2-read-loud', ['T1']);

    const settlement = settleAttention(
      [
        { repositoryId: 'u2-read-quiet', repositoryRoot: quiet, conditions: ['RECOVERY_UNSAFE'] },
        { repositoryId: 'u2-read-loud', repositoryRoot: loud, conditions: ['NO_PROGRESS'] },
      ],
      NOW,
      { pathProvider: provider },
    );
    // Exactly one of the two is acknowledged, so the report has to separate them.
    const partial = notifier([true, false]);
    await pushAttentionItems(partial.notifier, settlement.undelivered, { pathProvider: provider });

    const report = renderAttentionStore(listAttentionRecords(provider));

    expect(report).toContain('Outbox       : READ');
    expect(report).toContain('Open         : 2');
    expect(report).toContain('Not delivered: 1');
    expect(report).toContain('Not delivered to any endpoint');
    // The one that got through is in the open list and not in the undelivered
    // one. Asserted by counting the item ids rather than by eye: both records
    // appear once under "Open items", and only the unacknowledged one appears a
    // second time.
    const ids = settlement.undelivered.map((entry) => entry.attentionId);
    const occurrences = ids.map((id) => report.split(id).length - 1);
    expect(occurrences.filter((count) => count === 2)).toHaveLength(1);
    expect(occurrences.filter((count) => count === 1)).toHaveLength(1);
  });

  it('never reports an unreadable store as an empty one', () => {
    // The one confusion that would make this report worse than no report. "I
    // could not look" and "nothing is open" both produce an empty record list,
    // and only one of them is an answer.
    const listing = {
      records: [],
      delivered: [],
      foreignNames: 0,
      unreadable: 0,
      staging: 0,
      absent: false,
      unreadableRoot: true,
    } as const;

    const report = renderAttentionStore(listing);
    expect(attentionStoreReading(listing)).toBe('UNREADABLE_ROOT');
    expect(report).toContain('Outbox       : UNREADABLE_ROOT');
    expect(report).toContain('is not an answer about what is open');
  });

  it('has a sentence for every reading the store can be in', () => {
    // Total at runtime as well as by type, the way every other table here is
    // measured: a reading added without a sentence would print `undefined` to an
    // operator who came here to be told something.
    for (const reading of ['ABSENT', 'UNREADABLE_ROOT', 'READ'] as const) {
      expect(ATTENTION_STORE_SENTENCES[reading].length).toBeGreaterThan(0);
    }
    expect(Object.keys(ATTENTION_STORE_SENTENCES).sort()).toEqual([
      'ABSENT',
      'READ',
      'UNREADABLE_ROOT',
    ]);
  });
});

/* ══ 4. U4 — an interrupted task is reconciled and driven on the next cycle ══ */

/**
 * A repository whose task was **interrupted mid-work**.
 *
 * Not a simulation of a crash's *cause* — no signal is sent and no process is
 * killed — but a faithful reproduction of what a crash **leaves**: a real
 * worktree on a real branch, a real commit the writing agent made, and a durable
 * state parked in a work-loop phase with no ending recorded. That is exactly the
 * disk an orchestrator killed inside `IMPLEMENTING` leaves behind, and it is the
 * disk the next cycle has to deal with.
 *
 * The fixture lease is given back afterwards, because a crashed orchestrator
 * does not keep holding one — and if it did, `U1` is the blocker that covers it
 * and section 1 is where that is measured.
 */
async function interruptedTask(taskId: string): Promise<StartedTask> {
  const started = await startTask({ taskId });
  seedDeliveredState(started, { state: 'IMPLEMENTING', stateEnteredAt: NOW });
  releaseTestLeases();
  return started;
}

describe('M4 / U4 — the next cycle continues what the last one left', () => {
  it('drives an interrupted task instead of refusing it, with nobody present', async () => {
    // The claim `U4` makes about unattended running, measured end to end through
    // the recurring loop's own entry point: "there is no retry an automation
    // could perform."
    //
    // Every layer here is production code. The coordinator plans, admits, takes
    // the real lease, and runs the real `driveLifecycle`; the only seams are the
    // two subprocess boundaries, which is where a test must stop — a real
    // `claude` invocation is not something a suite may make.
    const started = await interruptedTask('T1');
    const entry = Object.freeze({
      declaredPath: started.root,
      repository: started.repository,
    });

    const agent = recordedAgent({
      claude: () => writerSuccess(),
      codex: () => reviewResult(passingReview()),
    });
    const verify = recordedVerify();

    const result = await driveRepositories(
      { repositories: [entry], maxConcurrentRepositories: 1, maxSteps: 8, maxInvocations: 1 },
      { ...DEPS, agent: agent.runner, verify: verify.runner },
    );

    // Admitted at all, which is the first thing a refusal would have prevented.
    expect(result.admissions.map((admission) => admission.taskId)).toEqual(['T1']);
    const lifecycle = result.admissions[0]?.lifecycle;

    // The task was *driven*, not merely accepted. `TASK_NOT_STARTED` and
    // `TASK_START_REFUSED` are the two refusals this case would have produced if
    // an existing durable state were treated as an obstacle, and
    // `CONTINUATION_NOT_AUTHORISED` is the one it would produce if the grant did
    // not reach a reconciled in-flight task.
    expect(lifecycle?.outcome).not.toBe('TASK_NOT_STARTED');
    expect(lifecycle?.outcome).not.toBe('TASK_START_REFUSED');
    expect(lifecycle?.outcome).not.toBe('CONTINUATION_NOT_AUTHORISED');
    expect(lifecycle?.invocations).toBeGreaterThan(0);

    // And the strongest evidence available, which is not an outcome code: the
    // writing agent really ran, inside the task's own worktree. A run that
    // classified the task as continuable and drove nothing would satisfy every
    // assertion above and none of this one.
    expect(agent.countFor('claude')).toBeGreaterThan(0);
    // Separators normalised on both sides, and only the separators. The runner
    // is handed a `cwd` in the spelling the boundary uses, and this assertion is
    // about *which directory* the writer ran in — not about which of Windows's
    // two spellings of it a seam happened to receive. Comparing the raw strings
    // failed on that difference alone, which would have been a fixture detail
    // masquerading as a finding.
    const sameDirectory = (path: string): string => path.replace(/\\/g, '/');
    expect(sameDirectory(agent.calls[0]?.cwd ?? '')).toBe(
      sameDirectory(started.workspace.worktreePath),
    );

    // The record moved. `IMPLEMENTING` is where the interruption left it, so a
    // state still reading `IMPLEMENTING` afterwards would mean the cycle
    // reported progress it had not made.
    expect(reload(started.root, 'T1').state.state).not.toBe('IMPLEMENTING');
  });

  it('keeps the interrupted attempt’s work rather than starting over', async () => {
    // The half that distinguishes "reconcile and re-offer" from "settle and
    // release". A mechanism that freed the task — removing the worktree, the
    // branch and the id, and starting clean — would also satisfy "the next cycle
    // does something", and it would silently throw away every commit the
    // interrupted writer made.
    //
    // Measured on the commit itself: the base pin, the work branch and the
    // commit the seeded work produced all survive the continuation.
    const started = await interruptedTask('T2');
    const before = reload(started.root, 'T2').state;
    const entry = Object.freeze({
      declaredPath: started.root,
      repository: started.repository,
    });

    await driveRepositories(
      { repositories: [entry], maxConcurrentRepositories: 1, maxSteps: 8, maxInvocations: 1 },
      {
        ...DEPS,
        agent: recordedAgent({
          claude: () => writerSuccess(),
          codex: () => reviewResult(passingReview()),
        }).runner,
        verify: recordedVerify().runner,
      },
    );

    const after = reload(started.root, 'T2').state;
    expect(after.workBranch).toBe(before.workBranch);
    expect(after.basePinnedCommit).toBe(before.basePinnedCommit);
    expect(after.worktreePath).toBe(before.worktreePath);
    // The interrupted attempt's commit is still reachable from the task's own
    // branch — the work was continued from, not discarded and redone.
    const reachable = execFileSync(
      'git',
      ['merge-base', '--is-ancestor', before.currentCommit ?? '', 'HEAD'],
      { cwd: before.worktreePath, stdio: 'pipe' },
    );
    expect(reachable.toString()).toBe('');
  });

  it('needs no attendance flag and no operator input to do it', () => {
    // What actually makes this unattended, held structurally rather than
    // promised. The path from a scheduler cycle to a continued task passes
    // through the coordinator, and the coordinator offers exactly one grant with
    // every decision that departs from a durable record refused.
    //
    // A future change that continued an interrupted task by turning one of these
    // on would be buying the same behaviour with an authority a selector may not
    // have, and this turns red rather than the behaviour quietly changing
    // meaning. The positive half — `recoverStaleLease: true` — is asserted in
    // `tests/m2-05-cross-repository-concurrency.test.ts` beside the three that
    // must stay false, so it cannot be flipped here without that failing too.
    const source = readFileSync(
      join(process.cwd(), 'src', 'run', 'repository-coordinator.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(source).toContain('remediateVerifyFailure: false');
    expect(source).toContain('continueHumanDecision: false');
    expect(source).toContain('continueUsageLimit: false');
    // And no interactive input of any kind reaches this path.
    expect(source).not.toContain('process.stdin');
    expect(source).not.toContain('readline');
  });
});

describe('M4 / U4 — the crash shape that cannot be continued says so out loud', () => {
  it('refuses a record the world no longer matches, and raises it for a person', async () => {
    // The harder crash, and the one an argument would skip. An orchestrator
    // killed mid-writer usually leaves the worktree *dirty* — the agent had
    // edited files and nothing had committed them — so the durable state's
    // `worktreeCleanAtCheckpoint: true` is no longer true of the disk.
    //
    // Continuing that automatically is precisely what this build must not do:
    // the record and the repository disagree, and guessing which is right is how
    // an unattended loop destroys work. So the closure of `U4` is not "every
    // interruption is resumed"; it is "every interruption is either resumed or
    // reported", and this is the second half.
    const started = await interruptedTask('T3');
    writeFileSync(
      join(started.workspace.worktreePath, 'src', 'uncommitted.ts'),
      'export const halfWritten = true;\n',
      'utf8',
    );
    const entry = Object.freeze({
      declaredPath: started.root,
      repository: started.repository,
    });

    const agent = recordedAgent({});
    const result = await driveRepositories(
      { repositories: [entry], maxConcurrentRepositories: 1, maxSteps: 8, maxInvocations: 1 },
      { ...DEPS, agent: agent.runner, verify: recordedVerify().runner },
    );

    const lifecycle = result.admissions[0]?.lifecycle;
    // Nothing ran. Asserted on the seam rather than on the outcome, because the
    // failure that matters here is a writer that started on a worktree whose
    // contents nobody has accounted for.
    expect(agent.calls).toEqual([]);
    expect(lifecycle?.outcome).toBe('RECONCILIATION_DIVERGED');

    // `RECONCILIATION_DIVERGED`, and it was written here from a measurement
    // rather than from a prediction — the first draft of this case expected
    // `RESUME_STATE_DIVERGED`, which is the *state* a task is parked in when a
    // resume finds divergence, and not what a reconciliation under a held lease
    // produces. The difference is the whole point of the case:
    //
    //   `RESUME_STATE_DIVERGED` is a durable task state, and the task scan
    //   raises it. `RECONCILIATION_DIVERGED` is **not a state at all**. The
    //   task stays where the interruption left it — `IMPLEMENTING`, which the
    //   state table calls silent, correctly, because a running task needs
    //   nobody.
    //
    // So before this slice this exact repository — the most ordinary crash there
    // is, an orchestrator killed while its writer had files open — produced a
    // condition that stopped all work and raised **nothing** in any channel. It
    // is the plainest instance of `U3` in the whole product, and it is reached
    // through `U4`'s own path.
    expect(ALL_STATES as readonly string[]).not.toContain(lifecycle?.outcome ?? '');
    expect(reload(started.root, 'T3').state.state).toBe('IMPLEMENTING');

    const provider = fixedPathProvider(store());
    const settlement = settleAttention(
      [
        {
          repositoryId: started.repository.id,
          repositoryRoot: started.root,
          conditions: [lifecycle?.outcome ?? 'COMPLETED'],
        },
      ],
      NOW,
      { pathProvider: provider },
    );

    // One item, and it is a repository item, because no task record could carry
    // this. That is `U3`'s closure doing the work `U4` needs: an interruption
    // this build will not continue is one it reports instead.
    expect(settlement.raised).toHaveLength(1);
    expect(settlement.raised[0]?.subject).toBe('REPOSITORY');
    expect(settlement.raised[0]?.reason).toBe('REPOSITORY_RECORD_UNUSABLE');
  });
});

/* ════ 5. the wiring, driven through the command that actually does it ═════ */

/**
 * A coordinator result with one admission, ended however the case says.
 *
 * Only the fields the outbox path reads are real; the rest is filler. That is
 * deliberate and is the one seam these cases use — what is on trial here is the
 * **command's** wiring between a finished pass and the store, and a real
 * coordinator would make the case about lease timing instead.
 */
function passWith(
  repositoryId: string,
  repositoryRoot: string,
  ending: { readonly outcome?: RunCondition; readonly threw?: boolean },
): CrossRepositoryRunResult {
  return Object.freeze({
    outcome: 'RUN_COMPLETE' as const,
    planCode: 'TASK_SELECTED',
    passes: 1,
    maxObservedConcurrency: 1,
    capacity: 1,
    reasonCodes: Object.freeze([]),
    admissions: Object.freeze([
      Object.freeze({
        repositoryId,
        repositoryRoot,
        taskId: 'T1',
        sequence: 1,
        concurrencyAtAdmission: 1,
        threw: ending.threw === true,
        lifecycle:
          ending.outcome === undefined
            ? null
            : (Object.freeze({
                outcome: ending.outcome,
                taskId: 'T1',
                acquire: null,
                recovery: null,
                release: null,
                start: null,
                runs: Object.freeze([]),
                invocations: 0,
                steps: 0,
                reasonCodes: Object.freeze([]),
                permissionDenials: Object.freeze({
                  observed: false,
                  denials: Object.freeze([]),
                }),
              }) as unknown as LifecycleResult),
      }),
    ]),
  }) as unknown as CrossRepositoryRunResult;
}

/**
 * Runs the real `repositories --attended --wait-for-reset` for one cycle.
 *
 * The store is real and the settle is real — only its *location* is redirected,
 * through the one seam the command threads into both halves of the outbox. A
 * test that could point the settle and the push at two directories would be able
 * to make a retry look like it worked when it had not, which is why there is one
 * seam and not two.
 */
async function oneCycle(options: {
  readonly home: string;
  readonly repositoryRoot: string;
  readonly notifier: AttentionNotifier;
  readonly run: CrossRepositoryRunResult;
}): Promise<void> {
  const provider = fixedPathProvider(options.home);
  mkdirSync(join(options.home, '.agent-orchestrator'), { recursive: true });
  writeFileSync(
    join(options.home, '.agent-orchestrator', 'repositories.yaml'),
    `schemaVersion: 1\nrepositories:\n  - path: ${JSON.stringify(options.repositoryRoot)}\n`,
    'utf8',
  );

  const program = new Command();
  program.exitOverride();
  registerRepositoriesCommand(program, {
    write: () => {},
    loadRepositoryRegistry: () => loadRepositoryRegistry(provider),
    repositoryRegistryPath: () => repositoryRegistryPath(provider),
    pathProvider: provider,
    attentionNotifier: options.notifier,
    driveRepositories: async () => options.run,
  });

  const previous = process.exitCode;
  try {
    await program.parseAsync([
      'node',
      'agent-loop',
      'repositories',
      '--attended',
      '--wait-for-reset',
      // Required, and deliberately so: `--wait-for-reset` refuses to invent how
      // long it may sleep. One cycle never reaches a sleep, and the bound is
      // still supplied rather than the flag being dropped, because dropping it
      // would test a different invocation than an operator runs.
      '--max-wait-ms',
      '1000',
      // Two, because that is the floor the command enforces: "the first cycle is
      // the pass that meets the block, so a wait needs at least two". Only one
      // pass actually runs here — nothing records a reset to wait for, so the
      // loop ends after the first — and the bound is written as the command
      // demands rather than as the test would prefer.
      '--max-cycles',
      '2',
    ]);
  } finally {
    process.exitCode = previous;
  }
}

describe('M4 — the command really announces what the store says is unannounced', () => {
  it('sends the same item again on a second invocation after a refusal', async () => {
    // The counter-proof that reaches the effect. Every other `U2` case in this
    // file measures `settleAttention` and `pushAttentionItems` directly, and a
    // mutation campaign found what that leaves uncovered: changing the one line
    // in `repositories-command.ts` back to `settlement.raised` — which is the
    // whole of the defect `U2` names — survived the entire suite.
    //
    // So this drives the command. Two separate invocations, because "a later
    // pass tries again" is a claim about a *new process reading the store*, and
    // calling one function twice would not have been one.
    const scratch = store();
    const root = makeRepository('u2-wired', ['T1']);
    const refusing = notifier([false, false]);
    const run = passWith('u2-wired', root, { outcome: 'RECOVERY_UNSAFE' });

    await oneCycle({ home: scratch, repositoryRoot: root, notifier: refusing.notifier, run });
    expect(refusing.sent).toHaveLength(1);

    await oneCycle({ home: scratch, repositoryRoot: root, notifier: refusing.notifier, run });

    // Two attempts, and both about the same item. Under the old wiring the
    // second invocation raised nothing — the name was already taken — and
    // therefore sent nothing, for ever.
    expect(refusing.sent).toHaveLength(2);
    expect(refusing.sent[0]).toBe(refusing.sent[1]);
  });

  it('stops once the endpoint takes it, measured across two invocations', async () => {
    // The bound on the retry, measured the same way. A retry that never stopped
    // would send one message per cycle for as long as the condition stood.
    const scratch = store();
    const root = makeRepository('u2-wired-ok', ['T1']);
    const accepting = notifier([true]);
    const run = passWith('u2-wired-ok', root, { outcome: 'RECOVERY_UNSAFE' });

    await oneCycle({ home: scratch, repositoryRoot: root, notifier: accepting.notifier, run });
    await oneCycle({ home: scratch, repositoryRoot: root, notifier: accepting.notifier, run });

    expect(accepting.sent).toHaveLength(1);
  });

  it('announces a pass that threw, which has no outcome to read at all', async () => {
    // The other half of `U3`, end to end. The coordinator turns a rejected
    // driver into `threw: true` with a null lifecycle — correctly, because a
    // rejection escaping that loop would abandon its siblings — and until this
    // slice that null was the end of it: no outcome, so nothing judged, so
    // nothing said, and a repository could fail this way on every cycle in
    // complete silence.
    //
    // Driven through the command because the translation from `threw` to a
    // condition lives there, and a test of `attentionForRunCondition('RUN_THREW')`
    // would measure the table while leaving that translation unmeasured.
    const scratch = store();
    const root = makeRepository('u3-threw', ['T1']);
    const listening = notifier([true]);

    await oneCycle({
      home: scratch,
      repositoryRoot: root,
      notifier: listening.notifier,
      run: passWith('u3-threw', root, { threw: true }),
    });

    const provider = fixedPathProvider(scratch);
    const records = listAttentionRecords(provider).records;
    expect(records).toHaveLength(1);
    expect(records[0]?.subject).toBe('REPOSITORY');
    expect(records[0] !== undefined && records[0].subject === 'REPOSITORY' ? records[0].condition : null).toBe(
      'RUN_THREW',
    );
    expect(records[0]?.reason).toBe('REPOSITORY_RUN_THREW');
    // And it left the machine, so an absent operator hears about it.
    expect(listening.sent).toEqual([records[0]?.attentionId]);
  });

  it('reads the ending before the outcome, so a throw is never lost to a null', () => {
    // `threw` is checked first in the command, and the order is load-bearing
    // rather than stylistic: an admission that threw carries `lifecycle: null`,
    // so a translation that read the outcome first would find nothing, skip the
    // admission, and reproduce exactly the silence this case exists to close.
    //
    // Structural, because the alternative ordering is not observably different
    // in any *other* way — both spellings compile, both pass every type check,
    // and only this pins which one is there.
    const source = readFileSync(
      join(process.cwd(), 'src', 'cli', 'repositories-command.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const threwAt = source.indexOf('admission.threw');
    const outcomeAt = source.indexOf('admission.lifecycle?.outcome');
    expect(threwAt).toBeGreaterThan(-1);
    expect(outcomeAt).toBeGreaterThan(-1);
    expect(threwAt).toBeLessThan(outcomeAt);
  });
});
