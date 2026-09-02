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

import { afterAll, describe, expect, it } from 'vitest';

import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { leaseFor } from './helpers/lease.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';

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
import { LIFECYCLE_OUTCOMES } from '../src/run/lifecycle-driver.js';
import { driveRepositories } from '../src/run/repository-coordinator.js';
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
