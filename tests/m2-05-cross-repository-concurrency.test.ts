/**
 * M2 slice 5 — bounded cross-repository concurrency.
 *
 * Three sentences are on trial here, and each one has its own section below:
 *
 *   > Different repositories may execute concurrently.
 *   > The same repository must never receive overlapping owned task execution.
 *   > Global concurrency must be bounded and deterministic.
 *
 * ── How overlap is proved, and how it is deliberately not ─────────────────
 *
 * Never by wall-clock time. Two things that finished quickly are not two things
 * that ran at once, and a suite that inferred concurrency from a duration would
 * pass on a fast machine and lie on a slow one.
 *
 * Two instruments are used instead, and they are independent:
 *
 *  - **barriers.** A driven repository blocks on a promise this file resolves,
 *    so "A had not finished when B started" is a fact about program order rather
 *    than about a clock. Every overlap assertion is gated on a barrier;
 *  - **the product's own count.** `AdmissionRecord.concurrencyAtAdmission` is
 *    written by the coordinator at the instant it admits, so `2` is the
 *    coordinator saying two repositories were admitted and neither had settled.
 *
 * ── And the real thing is measured too ────────────────────────────────────
 *
 * A seam proves how a module *classifies* an answer and never that a lease was
 * taken, so two cases use nothing but production code:
 *
 *  - two **real** Git repositories driven through the production
 *    `driveLifecycle` by the coordinator, with both lease documents read off
 *    disk from inside the auth preflight while both are held;
 *  - the defect this slice exists to close, measured directly: two real leases
 *    held at once in two execution domains, one real owned subprocess, and the
 *    two durable registers read from disk. It **runs twice** — once with the
 *    leases taken inside domains and once without — and the undomained half is
 *    required to reproduce the contamination. An instrument that cannot see the
 *    defect cannot be trusted to report its absence, and that control is what
 *    makes the other reading mean something.
 */

import { noMcpPreflight, noMcpPreflightFactory } from './helpers/mcp-capability.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';

import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { registerRepositoriesCommand } from '../src/cli/repositories-command.js';

import {
  createOwnedLaunchDomain,
  currentOwnedLaunchDomain,
  installOwnedLaunchAccountant,
  installedOwnedLaunchAccountants,
  openOwnedLaunch,
  runInOwnedLaunchDomain,
  type OwnedLaunchOpening,
  type OwnedLaunchRecord,
} from '../src/boundary/owned-launch-accounting.js';
import { runCommand } from '../src/doctor/exec.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
} from '../src/lease/execution-lease.js';
import type { CrossRepositoryPlan } from '../src/plan/plan-across-repositories.js';
import { planAcrossRepositories } from '../src/plan/plan-across-repositories.js';
import {
  DEFAULT_MAX_CONCURRENT_REPOSITORIES,
  loadRepositoryRegistry,
  MAX_CONCURRENT_REPOSITORIES,
  REPOSITORY_REGISTRY_SCHEMA_VERSION,
  type RegisteredRepository,
} from '../src/registry/repository-registry.js';
import { resolveRepository, type ResolvedRepository } from '../src/repo/resolve-repository.js';
import { driveLifecycle, type LifecycleResult } from '../src/run/lifecycle-driver.js';
import {
  driveRepositories,
  MAX_COORDINATOR_ADMISSIONS,
  type CrossRepositoryRunResult,
} from '../src/run/repository-coordinator.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { onceOnlyPreflight } from '../src/cli/run-command.js';
import { renderCrossRepositoryRun } from '../src/cli/render-repositories.js';
import {
  EXIT_CODE_SEVERITY,
  EXIT_RUN_CALL_AGAIN,
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  EXIT_RUNTIME_UNSUPPORTED,
  exitCodeForCrossRepositoryRun,
} from '../src/cli/run-exit-codes.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';

/* ─────────────────────────── fixtures ───────────────────────────────────── */

const created: string[] = [];

/** Comment strippers, so a structural pin measures code rather than prose. */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:])\/\/.*$/gm;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(root: string, relativePath: string, contents: string): void {
  const target = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
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

function taskFile(id: string, priority: 'HIGH' | 'NORMAL' | 'LOW' = 'NORMAL'): string {
  return `---
id: ${id}
title: task ${id}
status: OPEN
kind: NORMAL
priority: ${priority}
currentFocus: false
dependsOn: []
---
body
`;
}

/** A real Git repository with a profile and the named tasks. */
function makeRepository(id: string, tasks: readonly string[]): string {
  const root = makeCanonicalTempDir('ao-m2s5-');
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

/* ─────────────────────────── instruments ────────────────────────────────── */

/** Where a repository's lease document lives. The lease's own key is `.git`. */
function leasePathOf(root: string): string {
  return join(root, '.git', 'agent-orchestrator-execution-lease.json');
}

/** The owned launches open right now under a repository's lease, read from disk. */
function openSlots(root: string): unknown[] {
  const path = join(root, '.git', 'agent-orchestrator-execution-lease.launches.json');
  if (!existsSync(path)) return [];
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A read that caught the atomic publish mid-rename is not a slot count.
    return [];
  }
  const open = (document as { open?: unknown[] }).open;
  return Array.isArray(open) ? open : [];
}

/**
 * Whether a repository's launch document exists and parses.
 *
 * The other half of every "nothing leaked" assertion. {@link openSlots} answers
 * `[]` for three different worlds - no document, an unparseable one, and an
 * empty one - and only the third is the healthy state a leak check means.
 */
function registerIsReadable(root: string): boolean {
  const path = join(root, '.git', 'agent-orchestrator-execution-lease.launches.json');
  if (!existsSync(path)) return false;
  try {
    const document: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray((document as { open?: unknown }).open);
  } catch {
    return false;
  }
}

/** A promise plus the function that settles it. The barrier every proof uses. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

/** A lifecycle result with only the fields this file reads. */
function lifecycleResult(outcome: LifecycleResult['outcome'] = 'COMPLETED'): LifecycleResult {
  return Object.freeze({
    outcome,
    taskId: 'unused',
    acquire: null,
    recovery: null,
    release: null,
    start: null,
    runs: Object.freeze([]),
    invocations: 0,
    steps: 0,
    reasonCodes: Object.freeze([]),
    permissionDenials: Object.freeze({ observed: false, denials: Object.freeze([]) }),
  }) as unknown as LifecycleResult;
}

/** The dependencies every coordinator test passes, minus its own seams. */
const BASE_DEPS = {
  now: (): string => new Date().toISOString(),
  git: runGitCommand,
  authPreflight: async (): Promise<ReturnType<typeof provenAuthEvidence>> => provenAuthEvidence(),
};

/**
 * A `driveLifecycle` seam that records overlap and can be held open.
 *
 * `live` is the set of repository roots currently inside the seam, so `peak` is
 * measured where the work is rather than where the admission is — an independent
 * witness to `concurrencyAtAdmission`, which the coordinator writes itself.
 */
function recordingDrive(options: {
  readonly hold?: (root: string, taskId: string) => Promise<void>;
  readonly answer?: (root: string, taskId: string) => LifecycleResult | Error;
} = {}): {
  readonly drive: typeof driveLifecycle;
  readonly started: string[];
  readonly live: Set<string>;
  peak: () => number;
} {
  const started: string[] = [];
  const live = new Set<string>();
  let peak = 0;
  const drive = (async (request: Parameters<typeof driveLifecycle>[0]) => {
    const key = `${request.repository.root}::${request.taskId}`;
    started.push(key);
    live.add(request.repository.root);
    peak = Math.max(peak, live.size);
    try {
      if (options.hold !== undefined) await options.hold(request.repository.root, request.taskId);
      const answer = options.answer?.(request.repository.root, request.taskId);
      if (answer instanceof Error) throw answer;
      return answer ?? lifecycleResult();
    } finally {
      live.delete(request.repository.root);
    }
  }) as unknown as typeof driveLifecycle;
  return { drive, started, live, peak: () => peak };
}

/* ─────────────────── 1. the announcement has a subject ──────────────────── */

describe('M2 slice 5 — an owned launch is announced to its own execution domain', () => {
  /** An accountant that records every opening it is asked for. */
  function recorder(): { readonly accountant: { open: () => OwnedLaunchOpening }; opened: number } {
    const state = { opened: 0 };
    return {
      accountant: {
        open: (): OwnedLaunchOpening => {
          state.opened += 1;
          const record: OwnedLaunchRecord = { established: () => {}, ended: () => {} };
          return { opening: 'RECORDED', record };
        },
      },
      get opened(): number {
        return state.opened;
      },
    } as unknown as { readonly accountant: { open: () => OwnedLaunchOpening }; opened: number };
  }

  it('announces a launch only to the accountants of its own domain', () => {
    const a = createOwnedLaunchDomain();
    const b = createOwnedLaunchDomain();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const disposeA = installOwnedLaunchAccountant(
      {
        open: (): OwnedLaunchOpening => {
          seenA.push('launch');
          return { opening: 'RECORDED', record: { established: () => {}, ended: () => {} } };
        },
      },
      a,
    );
    const disposeB = installOwnedLaunchAccountant(
      {
        open: (): OwnedLaunchOpening => {
          seenB.push('launch');
          return { opening: 'RECORDED', record: { established: () => {}, ended: () => {} } };
        },
      },
      b,
    );

    // The whole of the defect this slice closes, in one assertion: a launch of
    // A's reaches A's accountant and nothing of B's.
    const opened = runInOwnedLaunchDomain(a, () => openOwnedLaunch());
    expect(opened.refusal).toBeNull();
    expect(seenA).toEqual(['launch']);
    expect(seenB).toEqual([]);
    expect(opened.records).toHaveLength(1);

    runInOwnedLaunchDomain(b, () => openOwnedLaunch());
    expect(seenA).toEqual(['launch']);
    expect(seenB).toEqual(['launch']);

    disposeA();
    disposeB();
  });

  it('announces an undomained launch only to undomained accountants', () => {
    const domain = createOwnedLaunchDomain();
    const seenDomained: string[] = [];
    const seenPlain: string[] = [];
    const disposeDomained = installOwnedLaunchAccountant(
      {
        open: (): OwnedLaunchOpening => {
          seenDomained.push('launch');
          return { opening: 'RECORDED', record: { established: () => {}, ended: () => {} } };
        },
      },
      domain,
    );
    const disposePlain = installOwnedLaunchAccountant(
      {
        open: (): OwnedLaunchOpening => {
          seenPlain.push('launch');
          return { opening: 'RECORDED', record: { established: () => {}, ended: () => {} } };
        },
      },
      null,
    );

    // Outside every domain — which is where every pre-existing command runs.
    openOwnedLaunch();
    expect(seenPlain).toEqual(['launch']);
    expect(seenDomained).toEqual([]);

    // And the other direction: a domained launch does not reach the undomained
    // accountant either. The rule is identity, not a fallback.
    runInOwnedLaunchDomain(domain, () => openOwnedLaunch());
    expect(seenPlain).toEqual(['launch']);
    expect(seenDomained).toEqual(['launch']);

    disposeDomained();
    disposePlain();
  });

  it('does not let a foreign domain refuse a launch', () => {
    // The live half of the pre-change defect: a refusal from ANY installed
    // accountant refused the launch for ALL of them, so one repository's
    // transient disk trouble killed another repository's next subprocess.
    const mine = createOwnedLaunchDomain();
    const theirs = createOwnedLaunchDomain();
    const disposeMine = installOwnedLaunchAccountant(
      { open: (): OwnedLaunchOpening => ({ opening: 'RECORDED', record: { established: () => {}, ended: () => {} } }) },
      mine,
    );
    const disposeTheirs = installOwnedLaunchAccountant(
      { open: (): OwnedLaunchOpening => ({ opening: 'LAUNCH_MUST_NOT_START', detail: 'THEIR_DISK' }) },
      theirs,
    );

    const opened = runInOwnedLaunchDomain(mine, () => openOwnedLaunch());
    expect(opened.refusal).toBeNull();
    expect(opened.records).toHaveLength(1);

    // The positive control, in the same test and against the same accountant:
    // inside *their* domain that refusal really does fire, so the pass above is
    // attributable to the domain and not to a refusal that never worked.
    const refused = runInOwnedLaunchDomain(theirs, () => openOwnedLaunch());
    expect(refused.refusal).toBe('THEIR_DISK');

    disposeMine();
    disposeTheirs();
  });

  it('carries the domain across awaits', async () => {
    const domain = createOwnedLaunchDomain();
    expect(currentOwnedLaunchDomain()).toBeNull();
    const observed = await runInOwnedLaunchDomain(domain, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentOwnedLaunchDomain();
    });
    // The property the whole design rests on: a launch twelve frames below the
    // wrap is still that domain's. If this were false the accounting would be
    // scoped to the synchronous prefix of a run and nothing else.
    expect(observed).toBe(domain);
    expect(currentOwnedLaunchDomain()).toBeNull();
  });

  it('mints a distinct domain every time', () => {
    const first = createOwnedLaunchDomain();
    const second = createOwnedLaunchDomain();
    expect(first).not.toBe(second);
    const seen: string[] = [];
    const dispose = installOwnedLaunchAccountant(
      {
        open: (): OwnedLaunchOpening => {
          seen.push('launch');
          return { opening: 'RECORDED', record: { established: () => {}, ended: () => {} } };
        },
      },
      first,
    );
    runInOwnedLaunchDomain(second, () => openOwnedLaunch());
    expect(seen).toEqual([]);
    dispose();
  });

  it('counts installed accountants across every domain', () => {
    // The count answers "did an install and a disposal happen", which is a
    // question about the registry. Filtered by the ambient domain it would read
    // zero from outside and hide a leak.
    const before = installedOwnedLaunchAccountants();
    const dispose = installOwnedLaunchAccountant(
      { open: (): OwnedLaunchOpening => ({ opening: 'EPOCH_ENDED' }) },
      createOwnedLaunchDomain(),
    );
    expect(installedOwnedLaunchAccountants()).toBe(before + 1);
    dispose();
    expect(installedOwnedLaunchAccountants()).toBe(before);
  });
});

/* ─────────────── 2. same-repository exclusion (Phase E) ─────────────────── */

describe('M2 slice 5 — the same repository never overlaps itself', () => {
  it('serialises two eligible tasks of one repository even with a free slot', async () => {
    const root = makeRepository('solo', ['T1', 'T2']);
    const repositories = [await registered(root)];
    const first = gate();
    const seam = recordingDrive({
      hold: async (_root, taskId) => {
        if (taskId === 'T1') await first.wait;
      },
    });

    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );

    // Program order, not elapsed time: T1 is inside the seam and held there, and
    // the assertion is made before anything releases it.
    await waitFor(() => seam.started.length >= 1);
    await settleMicrotasks();
    expect(seam.started).toEqual([`${root}::T1`]);
    expect(seam.live.size).toBe(1);

    first.open();
    const result = await run;

    expect(seam.peak()).toBe(1);
    expect(result.maxObservedConcurrency).toBe(1);
    expect(result.admissions.map((entry) => entry.taskId)).toEqual(['T1', 'T2']);
    expect(result.admissions.every((entry) => entry.concurrencyAtAdmission === 1)).toBe(true);
  });

  it.each([
    ['a refusal', (): LifecycleResult => lifecycleResult('LIVE_OWNER_PRESENT')],
    ['a failure', (): LifecycleResult => lifecycleResult('BLOCKED_VERIFY')],
    ['a lease release failure', (): LifecycleResult => lifecycleResult('LEASE_RELEASE_FAILED')],
  ])('keeps one repository serial when its first task ends in %s', async (_name, answer) => {
    const root = makeRepository('solo', ['T1', 'T2']);
    const repositories = [await registered(root)];
    const seam = recordingDrive({ answer: () => answer() });
    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 4, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    expect(seam.peak()).toBe(1);
    expect(result.maxObservedConcurrency).toBe(1);
    expect(result.admissions).toHaveLength(2);
  });

  it('keeps one repository serial when its first task throws', async () => {
    const root = makeRepository('solo', ['T1', 'T2']);
    const repositories = [await registered(root)];
    const seam = recordingDrive({
      answer: (_root, taskId) => (taskId === 'T1' ? new Error('driving threw') : lifecycleResult()),
    });
    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 4, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    expect(seam.peak()).toBe(1);
    // A throw is not an outcome. It is reported as one and graded as a defect.
    const thrown = result.admissions.find((entry) => entry.taskId === 'T1');
    expect(thrown?.threw).toBe(true);
    expect(thrown?.lifecycle).toBeNull();
    expect(result.admissions).toHaveLength(2);
    expect(exitCodeForCrossRepositoryRun(result)).toBe(1);
  });

  it('admits at most one task per repository in a single pass', async () => {
    // Three eligible tasks, three free slots, one repository. The exclusion is
    // the only thing that can stop all three going out together.
    const root = makeRepository('solo', ['T1', 'T2', 'T3']);
    const repositories = [await registered(root)];
    const held = gate();
    const seam = recordingDrive({ hold: async () => held.wait });
    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 3, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    await waitFor(() => seam.started.length >= 1);
    await settleMicrotasks();
    expect(seam.started).toHaveLength(1);
    held.open();
    const result = await run;
    expect(result.maxObservedConcurrency).toBe(1);
    expect(result.admissions).toHaveLength(3);
  });

  it('is not the guarantee: the lease refuses a second concurrent task of one repository', async () => {
    // The counter-proof for the whole section. The coordinator's active set is a
    // policy that avoids wasting a slot; the authority is the lease. This
    // bypasses the coordinator entirely and drives one real repository twice at
    // once through the production `driveLifecycle`.
    const root = makeRepository('solo', ['T1', 'T2']);
    const repository = (await registered(root)).repository;
    const held = gate();
    let insideFirst = 0;

    const deps = {
      now: (): string => new Date().toISOString(),
      git: runGitCommand,
      authPreflight: async () => {
        // Reached only under a held lease, so this holds the lease open.
        insideFirst += 1;
        await held.wait;
        return null;
      },
      // Never reached: this case never gets past the auth gate above.
      mcpPreflight: noMcpPreflight,
    };

    const firstRun = driveLifecycle(
      { repository, taskId: 'T1', continuationGrant: 'ATTENDED', recoverStaleLease: false, maxSteps: 1, maxInvocations: 1 },
      deps,
    );
    await waitFor(() => insideFirst >= 1);

    const second = await driveLifecycle(
      { repository, taskId: 'T2', continuationGrant: 'ATTENDED', recoverStaleLease: false, maxSteps: 1, maxInvocations: 1 },
      { ...deps, authPreflight: async () => provenAuthEvidence() },
    );

    // The second never reached a preflight, a workspace or a task state: the
    // lease file the first created is there and its owner — this very process —
    // is alive.
    expect(second.outcome).toBe('LIVE_OWNER_PRESENT');
    expect(second.acquire).toBe('LEASE_HELD');
    expect(second.start).toBeNull();

    held.open();
    await firstRun;
  });
});

/* ──────────── 3. cross-repository overlap, seam and real (Phase F) ───────── */

describe('M2 slice 5 — different repositories execute concurrently', () => {
  it('has two repositories inside the driver at the same time', async () => {
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const repositories = [await registered(alpha), await registered(beta)];
    const held = gate();
    const seam = recordingDrive({ hold: async () => held.wait });

    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );

    // Both are inside the seam, and neither has been allowed to leave. This is
    // the overlap, asserted on program order.
    await waitFor(() => seam.live.size >= 2);
    expect(seam.live.size).toBe(2);
    expect([...seam.live].sort()).toEqual([alpha, beta].sort());

    held.open();
    const result = await run;
    expect(seam.peak()).toBe(2);
    expect(result.maxObservedConcurrency).toBe(2);
    // The product's own count, independent of the seam's.
    expect(result.admissions.some((entry) => entry.concurrencyAtAdmission === 2)).toBe(true);
    expect(result.outcome).toBe('RUN_COMPLETE');
  });

  it('holds two real leases at once, through the production driver', async () => {
    // The real measurement of the overlap itself, through the production
    // `driveLifecycle`: two real Git repositories, two real lease files, both on
    // disk at one instant, taken by two concurrent epochs of one process.
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const repositories = [await registered(alpha), await registered(beta)];

    const observation: { leases?: { alpha: boolean; beta: boolean } } = {};
    let reached = 0;

    const run = await driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory,
        now: (): string => new Date().toISOString(),
        git: runGitCommand,
        // Reached under a held lease — that is what makes this the window. The
        // reading is taken on the first entry and not repeated: what is being
        // established is that the two leases coexisted, and once is enough for
        // that.
        authPreflight: async () => {
          reached += 1;
          if (observation.leases === undefined) {
            observation.leases = {
              alpha: existsSync(leasePathOf(alpha)),
              beta: existsSync(leasePathOf(beta)),
            };
          }
          return provenAuthEvidence();
        },
      },
    );

    expect(reached).toBeGreaterThan(0);
    expect(observation.leases).toEqual({ alpha: true, beta: true });

    // Nothing leaked. Both leases are gone, and both registers are still there
    // and still readable and hold nothing open.
    //
    // The two halves are asserted separately on purpose: `openSlots` answers
    // `[]` for a register that is absent or will not parse as well as for one
    // that is genuinely empty, so `toEqual([])` alone would grade a document
    // this build failed to write as the healthy state.
    expect(existsSync(leasePathOf(alpha))).toBe(false);
    expect(existsSync(leasePathOf(beta))).toBe(false);
    expect(registerIsReadable(alpha)).toBe(true);
    expect(registerIsReadable(beta)).toBe(true);
    expect(openSlots(alpha)).toEqual([]);
    expect(openSlots(beta)).toEqual([]);
    expect(run.maxObservedConcurrency).toBe(2);
    expect(run.admissions).toHaveLength(2);
  }, 180_000);

  it('keeps a real owned launch out of the other repository’s register', async () => {
    // The defect this slice exists to close, measured end to end on disk, with
    // its own control beside it.
    //
    // Two real repositories, two real leases held at once in one process, and
    // one real owned subprocess started inside one of the two execution
    // domains. Deterministic: no coordinator, no lifecycle, no other work
    // running, so exactly one owned launch exists in the process while the
    // registers are read.
    //
    // The `undomained` half is the control, and without it this measurement
    // proves nothing: it repeats the whole thing with both leases taken outside
    // every domain — which is the pre-change behaviour, and what every other
    // command in this build still does — and REQUIRES the contamination to
    // appear. An instrument that cannot see the defect cannot be trusted to
    // report its absence.
    // `makeCanonicalTempDir` and not a bare `mkdtempSync`, and the helper exists
    // for exactly the failure this line caused on CI: a GitHub Actions Windows
    // runner reports an 8.3 alias for the profile directory (`RUNNER~1`), and
    // `SAFE_ARG_PATTERN` deliberately excludes `~` — so the product refused the
    // sleeper's path as an argument, correctly, before this test's own subject
    // was reached. It passed on a developer machine whose profile name is short.
    const scratch = makeCanonicalTempDir('ao-m2s5-sleeper-');
    created.push(scratch);
    const sleeper = join(scratch, 'sleeper.cjs');
    writeFileSync(sleeper, 'setTimeout(function () {}, 2500);\n', 'utf8');

    async function measure(scoped: boolean): Promise<{ own: number; other: number }> {
      const alpha = makeRepository('alpha', ['A1']);
      const beta = makeRepository('beta', ['B1']);
      const a = (await registered(alpha)).repository;
      const b = (await registered(beta)).repository;
      const now = (): string => new Date().toISOString();

      const domainA = createOwnedLaunchDomain();
      const domainB = createOwnedLaunchDomain();
      const take = (
        repository: ResolvedRepository,
        domain: ReturnType<typeof createOwnedLaunchDomain>,
      ): ReturnType<typeof acquireRepositoryExecutionLease> =>
        scoped
          ? runInOwnedLaunchDomain(domain, () =>
              acquireRepositoryExecutionLease(repository, { runId: null, blockId: null }, { now }),
            )
          : acquireRepositoryExecutionLease(repository, { runId: null, blockId: null }, { now });

      const leaseA = take(a, domainA);
      const leaseB = take(b, domainB);
      expect(leaseA.ok).toBe(true);
      expect(leaseB.ok).toBe(true);

      const observe = async (): Promise<{ own: number; other: number }> => {
        const command = runCommand(process.execPath, [sleeper], {
          env: process.env,
          cwd: scratch,
          timeoutMs: 20_000,
        });
        await waitFor(() => openSlots(alpha).length > 0, 10_000);
        const reading = { own: openSlots(alpha).length, other: openSlots(beta).length };
        await command;
        return reading;
      };

      const reading = scoped
        ? await runInOwnedLaunchDomain(domainA, observe)
        : await observe();

      if (leaseA.ok) releaseRepositoryExecutionLease(leaseA.evidence);
      if (leaseB.ok) releaseRepositoryExecutionLease(leaseB.evidence);
      // Readable first, then empty - see the sibling case: `[]` also means
      // "there is no document", which is not the thing being asserted.
      expect(registerIsReadable(alpha)).toBe(true);
      expect(registerIsReadable(beta)).toBe(true);
      expect(openSlots(alpha)).toEqual([]);
      expect(openSlots(beta)).toEqual([]);
      return reading;
    }

    // The control first, so a failure here is read as "the instrument is blind"
    // rather than as "the fix regressed".
    const undomained = await measure(false);
    expect(undomained).toEqual({ own: 1, other: 1 });

    // And the property. Repository A's launch is in repository A's register and
    // in no other, with both leases held at the same moment.
    const domained = await measure(true);
    expect(domained).toEqual({ own: 1, other: 0 });
  }, 240_000);

  it('binds each admission to its own repository', async () => {
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const repositories = [await registered(alpha), await registered(beta)];
    const seen: Array<{ root: string; taskId: string; grants: unknown }> = [];
    const drive = (async (request: Parameters<typeof driveLifecycle>[0]) => {
      seen.push({
        root: request.repository.root,
        taskId: request.taskId,
        grants: {
          continuationGrant: request.continuationGrant,
          recoverStaleLease: request.recoverStaleLease,
          remediateVerifyFailure: request.remediateVerifyFailure,
          continueHumanDecision: request.continueHumanDecision,
          continueUsageLimit: request.continueUsageLimit,
        },
      });
      return lifecycleResult();
    }) as unknown as typeof driveLifecycle;

    await driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 3, maxInvocations: 2 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: drive },
    );

    expect(seen.map((entry) => `${entry.root}::${entry.taskId}`).sort()).toEqual(
      [`${alpha}::A1`, `${beta}::B1`].sort(),
    );
    // The rule the command's help states: only the ordinary attended grant, and
    // every decision that departs from the record refused on every admission.
    //
    // `continueUsageLimit` is here because it was NOT, and a counter-proof
    // measured the cost. M2 slice 6 added that flag and this list was not
    // widened with it, so setting it `true` in the coordinator survived the
    // whole suite — a selector spending an operator's quota decision, on a task
    // nobody named, with nothing turning red. M3 slice 2 made that worse in
    // principle rather than in code: the coordinator now runs unattended across
    // days rather than for one invocation. An exhaustive list only measures
    // while it stays exhaustive.
    //
    // `recoverStaleLease` moved to `true` in the M4 completion slice and is the
    // one member of this object that is *not* of that shape. The other three
    // depart from what the record says; recovery removes an object proven dead
    // and departs from nothing, and refusing it left a recurring run skipping
    // its own predecessor's repository on every cycle (`L-M3-F-1`). It is
    // asserted by value here, beside the three that must stay `false`, so that
    // flipping any of *them* still turns this red.
    for (const entry of seen) {
      expect(entry.grants).toEqual({
        continuationGrant: 'ATTENDED',
        recoverStaleLease: true,
        remediateVerifyFailure: false,
        continueHumanDecision: false,
        continueUsageLimit: false,
      });
    }
  });
});

/* ────────────── 4. bounded and deterministic admission (Phase G) ─────────── */

describe('M2 slice 5 — global concurrency is bounded and admission is deterministic', () => {
  async function threeRepositories(): Promise<{
    readonly roots: readonly string[];
    readonly repositories: readonly RegisteredRepository[];
  }> {
    // Distinct task ids, so the ranking is decided by priority and task id and
    // never by the root tie-break — a fixture whose order came from the temp
    // directory names would make the determinism assertions accidental.
    const first = makeRepository('one', ['T1']);
    const second = makeRepository('two', ['T2']);
    const third = makeRepository('three', ['T3']);
    const repositories = [
      await registered(first),
      await registered(second),
      await registered(third),
    ];
    return { roots: [first, second, third], repositories };
  }

  it('never exceeds the capacity, and the third waits for a slot', async () => {
    const { repositories } = await threeRepositories();
    const held = gate();
    const releaseFirst = gate();
    let holdingFirstTwo = 0;
    const seam = recordingDrive({
      hold: async () => {
        holdingFirstTwo += 1;
        if (holdingFirstTwo <= 1) {
          await releaseFirst.wait;
          return;
        }
        await held.wait;
      },
    });

    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );

    await waitFor(() => seam.live.size >= 2);
    await settleMicrotasks();
    // Two, and only two, with a third repository sitting there eligible.
    expect(seam.live.size).toBe(2);
    expect(seam.started).toHaveLength(2);

    releaseFirst.open();
    await waitFor(() => seam.started.length >= 3);
    held.open();
    const result = await run;

    expect(seam.peak()).toBe(2);
    expect(result.maxObservedConcurrency).toBe(2);
    expect(result.capacity).toBe(2);
    expect(result.admissions).toHaveLength(3);
    // Every admission's own count is inside the bound too.
    expect(result.admissions.every((entry) => entry.concurrencyAtAdmission <= 2)).toBe(true);
  });

  it('admits the same first pair every time, in the same order', async () => {
    const { repositories } = await threeRepositories();
    const orders: string[][] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const seam = recordingDrive();
      const result = await driveRepositories(
        { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
        { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
      );
      orders.push(result.admissions.map((entry) => `${entry.repositoryId}::${entry.taskId}`));
    }
    // Same starting state, same document. Four runs, one answer.
    expect(new Set(orders.map((order) => order.join('|'))).size).toBe(1);
    // And it is the ranking's own order: T1, T2, T3 by task id at equal priority.
    expect(orders[0]).toEqual(['one::T1', 'two::T2', 'three::T3']);
  });

  it('lets an idle repository use a slot the top-ranked repository cannot', async () => {
    // Scenario 4. `high` owns the globally best candidate and a second task; it
    // is admitted first and held. `low` ranks below both of them and must still
    // get the free slot rather than waiting behind `high`'s next task.
    const high = makeRepository('high', ['A1', 'A2']);
    const low = makeRepository('low', ['Z9']);
    write(high, '.agent-orchestrator/tasks/A1.md', taskFile('A1', 'HIGH'));
    write(high, '.agent-orchestrator/tasks/A2.md', taskFile('A2', 'HIGH'));
    git(high, ['add', '--all']);
    git(high, ['commit', '--quiet', '-m', 'priorities']);
    const repositories = [await registered(high), await registered(low)];

    // The ranking really does put both of `high`'s tasks above `low`'s: without
    // that this scenario is not the one it claims to be.
    const ranking = planAcrossRepositories(repositories).ranking.map((entry) => entry.taskId);
    expect(ranking).toEqual(['A1', 'A2', 'Z9']);

    const held = gate();
    const seam = recordingDrive({
      hold: async (_root, taskId) => {
        if (taskId === 'A1') await held.wait;
      },
    });
    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );

    await waitFor(() => seam.live.size >= 2);
    // A2 outranks Z9 and belongs to a repository that is busy, so the slot goes
    // to Z9. Nothing about `high`'s own order changed: A2 is still ahead of
    // nothing it was behind, and it runs next.
    expect(seam.started).toEqual([`${high}::A1`, `${low}::Z9`]);

    held.open();
    const result = await run;
    expect(result.admissions.map((entry) => entry.taskId)).toEqual(['A1', 'Z9', 'A2']);
    expect(result.maxObservedConcurrency).toBe(2);
  });

  it('frees a slot only when the previous execution has ended', async () => {
    // Phase E's sharpest case and Phase J's: the slot may not be released at
    // launch. `alpha` is held open; `gamma` must not start while it is.
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const gamma = makeRepository('gamma', ['C1']);
    const repositories = [
      await registered(alpha),
      await registered(beta),
      await registered(gamma),
    ];
    const holdAlpha = gate();
    const seam = recordingDrive({
      hold: async (root) => {
        if (root === alpha) await holdAlpha.wait;
      },
    });
    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );

    await waitFor(() => seam.started.length >= 3);
    await settleMicrotasks();
    // beta finished and freed the second slot; gamma took it. alpha is still
    // inside, so the peak is two and never three.
    expect(seam.peak()).toBe(2);
    expect(seam.live.has(alpha)).toBe(true);

    holdAlpha.open();
    const result = await run;
    expect(result.maxObservedConcurrency).toBe(2);
    expect(result.admissions).toHaveLength(3);
  });

  it('frees every settled slot, not only the one the race named', async () => {
    // The number this run reports as its concurrency is `active.length`, and an
    // execution that has finished must not still be occupying a slot when the
    // next admission counts them.
    //
    // Three repositories, capacity 2, nothing held: A and B are admitted
    // together and both settle before the first reap returns. C is admitted on
    // the next pass, and by then **both** slots are free — so C's own record
    // must say `1`. Freeing only the race's winner leaves one settled execution
    // in the set and C reads `2`, which is the report claiming an overlap that
    // was over.
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const gamma = makeRepository('gamma', ['C1']);
    const repositories = [
      await registered(alpha),
      await registered(beta),
      await registered(gamma),
    ];
    const seam = recordingDrive();
    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );

    expect(result.admissions).toHaveLength(3);
    const third = result.admissions.find((entry) => entry.sequence === 3);
    expect(third?.repositoryRoot).toBe(gamma);
    expect(third?.concurrencyAtAdmission).toBe(1);
    // And the first two really were admitted together, so this is not passing
    // because nothing ever overlapped.
    expect(result.admissions.find((entry) => entry.sequence === 2)?.concurrencyAtAdmission).toBe(2);
  });

  it('capacity 1 is the default and never overlaps', async () => {
    expect(DEFAULT_MAX_CONCURRENT_REPOSITORIES).toBe(1);
    const { repositories } = await threeRepositories();
    const seam = recordingDrive({ hold: async () => settleMicrotasks() });
    const result = await driveRepositories(
      {
        repositories,
        maxConcurrentRepositories: DEFAULT_MAX_CONCURRENT_REPOSITORIES,
        maxSteps: 1,
        maxInvocations: 1,
      },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    expect(seam.peak()).toBe(1);
    expect(result.maxObservedConcurrency).toBe(1);
    expect(result.admissions).toHaveLength(3);
  });
});

/* ─────────────────────── 5. negative paths (Phase J) ─────────────────────── */

describe('M2 slice 5 — refusals and endings', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2.5],
    ['not a number', Number.NaN],
    ['above the ceiling', MAX_CONCURRENT_REPOSITORIES + 1],
  ])('refuses capacity that is %s, and drives nothing', async (_name, capacity) => {
    const root = makeRepository('solo', ['T1']);
    const repositories = [await registered(root)];
    const seam = recordingDrive();
    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: capacity, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    expect(result.outcome).toBe('CAPACITY_INVALID');
    expect(result.reasonCodes).toEqual(['MAX_CONCURRENT_REPOSITORIES_INVALID']);
    // Nothing was planned either: the refusal is before the first pass.
    expect(result.passes).toBe(0);
    expect(result.planCode).toBeNull();
    expect(seam.started).toEqual([]);
    expect(exitCodeForCrossRepositoryRun(result)).toBe(2);
  });

  it('accepts the ceiling itself', async () => {
    const root = makeRepository('solo', ['T1']);
    const repositories = [await registered(root)];
    const seam = recordingDrive();
    const result = await driveRepositories(
      {
        repositories,
        maxConcurrentRepositories: MAX_CONCURRENT_REPOSITORIES,
        maxSteps: 1,
        maxInvocations: 1,
      },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    expect(result.outcome).toBe('RUN_COMPLETE');
    expect(result.capacity).toBe(MAX_CONCURRENT_REPOSITORIES);
  });

  it('admits nothing when the registry is empty, and says why in the planner’s words', async () => {
    const seam = recordingDrive();
    const result = await driveRepositories(
      { repositories: [], maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    expect(result.outcome).toBe('NOTHING_ADMITTED');
    expect(result.planCode).toBe('NO_REPOSITORIES_REGISTERED');
    expect(seam.started).toEqual([]);
    expect(exitCodeForCrossRepositoryRun(result)).toBe(2);
  });

  it('admits nothing when every task is done', async () => {
    const root = makeRepository('solo', []);
    write(
      root,
      '.agent-orchestrator/tasks/T1.md',
      taskFile('T1').replace('status: OPEN', 'status: DONE'),
    );
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'done']);
    const repositories = [await registered(root)];
    const seam = recordingDrive();
    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    expect(result.outcome).toBe('NOTHING_ADMITTED');
    expect(result.planCode).toBe('ALL_TASKS_COMPLETE');
    expect(seam.started).toEqual([]);
    expect(exitCodeForCrossRepositoryRun(result)).toBe(0);
  });

  it('stops admitting when planning refuses mid-run, and still awaits what it started', async () => {
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const repositories = [await registered(alpha), await registered(beta)];
    const real = planAcrossRepositories(repositories);
    let passes = 0;
    const held = gate();
    const seam = recordingDrive({ hold: async () => held.wait });

    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory,
        ...BASE_DEPS,
        driveLifecycle: seam.drive,
        planAcrossRepositories: (): CrossRepositoryPlan => {
          passes += 1;
          if (passes === 1) return real;
          return Object.freeze({
            ...real,
            code: 'REPOSITORY_UNPLANNABLE' as const,
            selected: null,
            plans: Object.freeze([]),
            ranking: Object.freeze([]),
            failedRepositoryRoot: beta,
          });
        },
      },
    );

    await waitFor(() => seam.live.size >= 2);
    held.open();
    const result = await run;

    // Both were admitted before the refusal and both were awaited: abandoning a
    // live epoch would leave a lease held by a process that stopped looking.
    expect(result.outcome).toBe('PLANNING_REFUSED_MIDRUN');
    expect(result.admissions).toHaveLength(2);
    expect(result.reasonCodes).toEqual(['REPOSITORY_UNPLANNABLE']);
    expect(seam.live.size).toBe(0);
    expect(exitCodeForCrossRepositoryRun(result)).toBe(2);
  });

  it('refuses on the first pass without admitting anything', async () => {
    const root = makeRepository('solo', ['T1']);
    const repositories = [await registered(root)];
    const real = planAcrossRepositories(repositories);
    const seam = recordingDrive();
    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory,
        ...BASE_DEPS,
        driveLifecycle: seam.drive,
        planAcrossRepositories: (): CrossRepositoryPlan =>
          Object.freeze({
            ...real,
            code: 'REPOSITORY_UNPLANNABLE' as const,
            selected: null,
            plans: Object.freeze([]),
            ranking: Object.freeze([]),
          }),
      },
    );
    // Nothing had been admitted, so this is not the mid-run member.
    expect(result.outcome).toBe('NOTHING_ADMITTED');
    expect(result.planCode).toBe('REPOSITORY_UNPLANNABLE');
    expect(seam.started).toEqual([]);
  });

  it('admits a repository’s next task only after the previous one settled', async () => {
    // No double release, and no slot left behind: a run over one repository with
    // several tasks admits exactly as many times as there are tasks.
    const root = makeRepository('solo', ['T1', 'T2', 'T3', 'T4']);
    const repositories = [await registered(root)];
    const seam = recordingDrive();
    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 3, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive },
    );
    expect(result.admissions.map((entry) => entry.taskId)).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(new Set(seam.started).size).toBe(4);
    expect(seam.peak()).toBe(1);
  });

  it('awaits everything in flight before letting a planner’s throw out', async () => {
    // The header's promise, on the one path that could break it: a throw out of
    // the planner must not abandon the epochs already running. If it did, the
    // process would leave this function with leases held and subprocesses alive
    // and nothing left watching them.
    //
    // A first version of this case asserted only that the message came out and
    // that nothing was live *afterwards*, and a mutant that rethrows
    // immediately survived it: by the time the rejection was awaited, the gate
    // had been opened and both epochs had left anyway. What discriminates is
    // **when** the rejection arrives — while an epoch is still inside the
    // driver, or after it has left — so this case keeps one epoch inside and
    // asserts that nothing has rejected yet.
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const repositories = [await registered(alpha), await registered(beta)];
    const real = planAcrossRepositories(repositories);
    let passes = 0;
    const held = gate();
    // `beta` finishes on its own; `alpha` stays inside the driver until the gate
    // is opened, which is what makes "still in flight" observable.
    const seam = recordingDrive({
      hold: async (root) => {
        if (root === alpha) await held.wait;
      },
    });

    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory,
        ...BASE_DEPS,
        driveLifecycle: seam.drive,
        planAcrossRepositories: (): CrossRepositoryPlan => {
          passes += 1;
          if (passes === 1) return real;
          throw new Error('the planner threw');
        },
      },
    );
    // Attached now, and it records what was still live at the instant of the
    // rejection. The rejection handler is on the promise from the first turn, so
    // nothing here can pass by the promise never being awaited.
    const liveAtRejection: number[] = [];
    const settled = run.then(
      () => 'resolved',
      (error: unknown) => {
        liveAtRejection.push(seam.live.size);
        return error instanceof Error ? error.message : 'unknown';
      },
    );

    await waitFor(() => seam.started.length >= 2, 30_000, 'both admissions to start');
    // `beta` has left, `alpha` is held, and the planner has thrown on pass 2.
    await waitFor(() => passes >= 2, 30_000, 'the second planning pass');
    await settleMicrotasks();
    await settleMicrotasks();

    // The discriminator. With the drain, the throw is still being held back
    // because `alpha` has not finished; without it, this is already `[1]`.
    expect(seam.live.has(alpha)).toBe(true);
    expect(liveAtRejection).toEqual([]);

    held.open();
    expect(await settled).toBe('the planner threw');
    // And when it did come out, nothing was left running.
    expect(liveAtRejection).toEqual([0]);
    expect(seam.live.size).toBe(0);
  });

  it('turns a driver that throws synchronously into a settled record', async () => {
    // `driveLifecycle` is an async function and cannot do this; the injected
    // seam can, and a synchronous throw out of the admission loop would abandon
    // every sibling epoch.
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const repositories = [await registered(alpha), await registered(beta)];
    const drive = ((request: Parameters<typeof driveLifecycle>[0]) => {
      if (request.repository.root === alpha) throw new Error('synchronous');
      return Promise.resolve(lifecycleResult());
    }) as unknown as typeof driveLifecycle;

    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: drive },
    );

    expect(result.outcome).toBe('RUN_COMPLETE');
    expect(result.admissions).toHaveLength(2);
    const failed = result.admissions.find((entry) => entry.repositoryRoot === alpha);
    expect(failed?.threw).toBe(true);
    expect(failed?.lifecycle).toBeNull();
    // And the sibling still ran and still reported.
    const ok = result.admissions.find((entry) => entry.repositoryRoot === beta);
    expect(ok?.threw).toBe(false);
    expect(ok?.lifecycle?.outcome).toBe('COMPLETED');
  });

  it('has an admission ceiling that is a floor under the termination argument', () => {
    // Not exercised by driving 4096 tasks — that would be a test of patience.
    // What is worth pinning is that the ceiling exists, is a whole number, and
    // is far above what a legitimate registry can reach in one pass.
    expect(Number.isSafeInteger(MAX_COORDINATOR_ADMISSIONS)).toBe(true);
    expect(MAX_COORDINATOR_ADMISSIONS).toBeGreaterThan(256);
  });
});

/* ───────────── 6. the registry bound and the command surface ────────────── */

describe('M2 slice 5 — the capacity the operator writes down', () => {
  function profileDir(): string {
    const dir = makeCanonicalTempDir('ao-m2s5-profile-');
    created.push(dir);
    return dir;
  }

  function readRegistry(body: string): ReturnType<typeof loadRepositoryRegistry> {
    const dir = profileDir();
    mkdirSync(join(dir, '.agent-orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.agent-orchestrator', 'repositories.yaml'), body, 'utf8');
    return loadRepositoryRegistry(fixedPathProvider(dir));
  }

  it('defaults to one when the field is absent, which is what every earlier build did', () => {
    const outcome = readRegistry('schemaVersion: 1\nrepositories: []\n');
    expect(outcome.state).toBe('REGISTERED');
    if (outcome.state !== 'REGISTERED') return;
    expect(outcome.maxConcurrentRepositories).toBe(DEFAULT_MAX_CONCURRENT_REPOSITORIES);
  });

  it('reads the field when it is there', () => {
    const outcome = readRegistry(
      'schemaVersion: 1\nmaxConcurrentRepositories: 3\nrepositories: []\n',
    );
    expect(outcome.state).toBe('REGISTERED');
    if (outcome.state !== 'REGISTERED') return;
    expect(outcome.maxConcurrentRepositories).toBe(3);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '2.5'],
    ['a string', 'two'],
    ['above the ceiling', String(MAX_CONCURRENT_REPOSITORIES + 1)],
    ['null', 'null'],
  ])('refuses a capacity that is %s rather than repairing it', (_name, written) => {
    // Refused at the contract boundary and not clamped. A clamp would turn
    // `maxConcurrentRepositories: 0` — which says *run nothing*, and is a thing
    // an operator might have meant — into a silent 1, and `-1` and `2.5` into
    // the same.
    const outcome = readRegistry(
      `schemaVersion: 1\nmaxConcurrentRepositories: ${written}\nrepositories: []\n`,
    );
    expect(outcome.state).toBe('UNUSABLE');
    if (outcome.state !== 'UNUSABLE') return;
    expect(outcome.code).toBe('REGISTRY_CONTRACT_VIOLATION');
  });

  it('accepts the ceiling itself', () => {
    const outcome = readRegistry(
      `schemaVersion: 1\nmaxConcurrentRepositories: ${String(MAX_CONCURRENT_REPOSITORIES)}\nrepositories: []\n`,
    );
    expect(outcome.state).toBe('REGISTERED');
    if (outcome.state !== 'REGISTERED') return;
    expect(outcome.maxConcurrentRepositories).toBe(MAX_CONCURRENT_REPOSITORIES);
  });

  it('keeps the schema version, so documents written before the field still read', () => {
    // The field is optional at version 1 deliberately: bumping the version would
    // invalidate every registry already on disk to add one optional key.
    expect(REPOSITORY_REGISTRY_SCHEMA_VERSION).toBe(1);
  });
});

describe('M2 slice 5 — the command surface', () => {
  function commandFor(seams: Parameters<typeof registerRepositoriesCommand>[1]): Command {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerRepositoriesCommand(program, seams);
    return program;
  }

  /** Runs `argv` with stdout captured, and restores it however that ends. */
  async function runCli(program: Command, argv: readonly string[]): Promise<string> {
    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((text: string): boolean => {
      out.push(String(text));
      return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync([...argv], { from: 'user' });
    } finally {
      process.stdout.write = original;
    }
    return out.join('');
  }

  it('writes nothing without the grant', async () => {
    // The registry must be USABLE here, and that is not a detail: a first draft
    // of this case answered `NOT_REGISTERED`, which returns long before the
    // grant is consulted, so removing the grant check entirely left it green.
    // A mutation campaign found that — `M28-read-only-default-executes`
    // survived — and the fix is to make the case actually reach the branch it
    // claims to be about.
    let drove = 0;
    const program = commandFor({
      loadRepositoryRegistry: () =>
        Object.freeze({
          state: 'REGISTERED' as const,
          registryDigest: 'a'.repeat(64),
          entries: Object.freeze([]),
          maxConcurrentRepositories: 2,
        }),
      resolveRegisteredRepositories: async () =>
        Object.freeze({ ok: true as const, repositories: Object.freeze([]) }),
      driveRepositories: (async () => {
        drove += 1;
        throw new Error('the read-only default must not reach the coordinator');
      }) as unknown as typeof driveRepositories,
    });
    const output = await runCli(program, ['repositories']);
    expect(drove).toBe(0);
    // The read-only report, and its own trailer — not the run one.
    expect(output).toContain('NO_REPOSITORIES_REGISTERED');
    expect(output).toContain('acts on nothing');
    expect(output).not.toContain('Peak concurrency');
    process.exitCode = 0;
  });

  it.each([
    ['--max-steps', ['repositories', '--max-steps', '3']],
    ['--max-invocations', ['repositories', '--max-invocations', '2']],
  ])('refuses %s without the grant, before anything is read', async (_name, argv) => {
    let read = 0;
    const program = commandFor({
      loadRepositoryRegistry: () => {
        read += 1;
        return Object.freeze({ state: 'NOT_REGISTERED' as const });
      },
    });
    const output = await runCli(program, argv);
    expect(output).toContain('BOUND_WITHOUT_GRANT');
    // The refusal is before the registry is even opened.
    expect(read).toBe(0);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it.each([
    ['--max-steps', ['repositories', '--attended', '--max-steps', 'x'], 'MAX_STEPS_INVALID'],
    ['--max-steps zero', ['repositories', '--attended', '--max-steps', '0'], 'MAX_STEPS_INVALID'],
    [
      '--max-invocations',
      ['repositories', '--attended', '--max-invocations', '-2'],
      'MAX_INVOCATIONS_INVALID',
    ],
  ])('refuses %s when it is not a usable bound', async (_name, argv, code) => {
    let read = 0;
    const program = commandFor({
      loadRepositoryRegistry: () => {
        read += 1;
        return Object.freeze({ state: 'NOT_REGISTERED' as const });
      },
    });
    const output = await runCli(program, argv);
    expect(output).toContain(code);
    expect(read).toBe(0);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it('hands the registry’s own capacity to the coordinator, and never an option', async () => {
    const seen: Array<{ capacity: number; maxSteps: number; maxInvocations: number }> = [];
    const program = commandFor({
      loadRepositoryRegistry: () =>
        Object.freeze({
          state: 'REGISTERED' as const,
          registryDigest: 'f'.repeat(64),
          entries: Object.freeze([]),
          maxConcurrentRepositories: 4,
        }),
      resolveRegisteredRepositories: async () =>
        Object.freeze({ ok: true as const, repositories: Object.freeze([]) }),
      driveRepositories: (async (request: {
        maxConcurrentRepositories: number;
        maxSteps: number;
        maxInvocations: number;
      }) => {
        seen.push({
          capacity: request.maxConcurrentRepositories,
          maxSteps: request.maxSteps,
          maxInvocations: request.maxInvocations,
        });
        return Object.freeze({
          outcome: 'NOTHING_ADMITTED' as const,
          planCode: 'NO_REPOSITORIES_REGISTERED' as const,
          admissions: Object.freeze([]),
          passes: 1,
          maxObservedConcurrency: 0,
          capacity: request.maxConcurrentRepositories,
          reasonCodes: Object.freeze([]),
        });
      }) as unknown as typeof driveRepositories,
    });
    await runCli(program, [
      'repositories',
      '--attended',
      '--max-steps',
      '5',
      '--max-invocations',
      '2',
    ]);
    // The capacity comes from the registry document and from nowhere else: there
    // is no option for it, so a scheduler cannot raise it without somebody
    // editing the operator's own file.
    expect(seen).toEqual([{ capacity: 4, maxSteps: 5, maxInvocations: 2 }]);
    process.exitCode = 0;
  });

  it('offers no destructive grant', () => {
    // The rule the header states, held structurally rather than promised. If a
    // later change registers one of these, this turns red and the argument has
    // to be made again.
    const program = new Command();
    registerRepositoriesCommand(program);
    const repositories = program.commands.find((entry) => entry.name() === 'repositories');
    const flags = (repositories?.options ?? []).map((option) => option.long);
    // M3 slice 1 appended three and M3 slice 2 a fourth, and every one of them
    // bounds *when* a pass happens rather than what a pass may do. The
    // exhaustive list is kept — it is what makes a quietly destructive one turn
    // this red, and it did its job on the slice-2 gate — and the named negatives
    // below are kept beside it for the same reason they were written: an
    // exhaustive list says which options exist, and those say which authorities
    // may never appear whatever the list grows to.
    expect(flags).toEqual([
      '--attended',
      '--max-steps',
      '--max-invocations',
      '--wait-for-reset',
      '--max-wait-ms',
      '--max-cycles',
      '--idle-poll-ms',
    ]);
    expect(flags).not.toContain('--recover-stale-lease');
    expect(flags).not.toContain('--remediate-verify-failure');
    expect(flags).not.toContain('--continue-human-decision');
    expect(flags).not.toContain('--continue-usage-limit');
    expect(flags).not.toContain('--repository');
  });
});

/* ────────────────────── 6. what the slice did not do ─────────────────────── */

describe('M2 slice 5 — scope', () => {
  /**
   * The coordinator's **code**, with every comment removed.
   *
   * Stripped rather than read whole, and the reason is a failure this file had
   * on its first run: the module's header explains why the lease refuses a
   * second concurrent task of one repository, and naming
   * `acquireRepositoryExecutionLease` in that sentence turned a structural pin
   * red. A pin that reads prose measures the prose. Every assertion below is
   * about what the module *does*.
   */
  const coordinator = readFileSync(
    join(process.cwd(), 'src', 'run', 'repository-coordinator.ts'),
    'utf8',
  )
    .replace(BLOCK_COMMENT, ' ')
    .replace(LINE_COMMENT, '$1');

  it('adds no scheduler, no persistence, no notification and no quota handling', () => {
    // Each of these is a later slice or an explicit non-goal. A structural pin
    // rather than a promise, because the promise is what goes stale.
    for (const forbidden of [
      // Timers, in every spelling this runtime offers. A first draft banned
      // three, and a review pointed out that `setImmediate` and
      // `node:fs/promises` are the natural way to add the two banned things to
      // an async module - so the pin measured less than its own title claimed.
      'setInterval',
      'setTimeout',
      'setImmediate',
      'node:timers',
      'node:fs',
      'writeFile',
      'readFile',
      'notify',
      'cron',
      'quota',
      'backoff',
      'retry',
    ]) {
      expect(coordinator).not.toContain(forbidden);
    }
  });

  it('does not fan out without a bound', () => {
    // The shape the slice was told not to have. `Promise.race` is present and is
    // the opposite thing: it waits for one of a bounded set.
    expect(coordinator).not.toContain('Promise.all');
    expect(coordinator).not.toContain('Promise.allSettled');
    expect(coordinator).toContain('Promise.race');
  });

  it('takes no lease and starts no process itself', () => {
    // `runCommand` included, and that is the pin a review found missing on both
    // this module and `repositories-command.ts`: a second execution chokepoint
    // beside `driveLifecycle` is exactly the shape both headers forbid, and
    // nothing anywhere turned red for it.
    for (const forbidden of [
      'acquireRepositoryExecutionLease',
      'releaseRepositoryExecutionLease',
      'child_process',
      'start-owned-process',
      'runCommand',
    ]) {
      expect(coordinator).not.toContain(forbidden);
    }
    const command = readFileSync(
      join(process.cwd(), 'src', 'cli', 'repositories-command.ts'),
      'utf8',
    )
      .replace(BLOCK_COMMENT, ' ')
      .replace(LINE_COMMENT, '$1');
    expect(command).not.toContain('runCommand');
    expect(command).not.toContain('child_process');
  });

  it('leaves READY_FOR_PR terminal', async () => {
    const { getAllowedTransitions } = await import('../src/core/transitions.js');
    expect(getAllowedTransitions('READY_FOR_PR')).toEqual([]);
  });
});

/* ─────────── 7. what the first round of review found missing ────────────── */

describe('M2 slice 5 — the shared auth preflight is single-flight', () => {
  it('gives every concurrent caller the one attempt’s answer, not null', async () => {
    // The defect this case exists for was a BLOCKER, and it defeated the slice's
    // first headline sentence on the only path an operator uses. The memo held a
    // flag and a value and flipped the flag *before* awaiting, so a second
    // caller arriving while the first was still in flight took the early return
    // and got `null` — which this seam's contract reads as "the preflight
    // produced no evidence". With capacity 2 exactly one repository ran; the
    // other reported AUTH_PREFLIGHT_FAILED after taking and releasing a lease,
    // and the report still said two were admitted.
    let runs = 0;
    const release = gate();
    const preflight = onceOnlyPreflight(async () => {
      runs += 1;
      await release.wait;
      return provenAuthEvidence();
    });

    // Three callers, all inside the one attempt's window.
    const first = preflight();
    const second = preflight();
    const third = preflight();
    release.open();
    const answers = await Promise.all([first, second, third]);

    expect(runs).toBe(1);
    for (const answer of answers) expect(answer).not.toBeNull();
    // And the same artefact, not three equal ones.
    expect(answers[1]).toBe(answers[0]);
    expect(answers[2]).toBe(answers[0]);

    // The sequential contract is unchanged: a later call still gets the same
    // answer and still starts nothing.
    expect(await preflight()).toBe(answers[0]);
    expect(runs).toBe(1);
  });

  it('remembers a failure rather than retrying it, for concurrent callers too', async () => {
    let runs = 0;
    const release = gate();
    const preflight = onceOnlyPreflight(async () => {
      runs += 1;
      await release.wait;
      return null;
    });
    const both = Promise.all([preflight(), preflight()]);
    release.open();
    expect(await both).toEqual([null, null]);
    expect(await preflight()).toBeNull();
    expect(runs).toBe(1);
  });

  it('drives every admitted repository when the real memo is in the way', async () => {
    // The end-to-end shape of the blocker, through the coordinator with the
    // production memo wired exactly as `repositories-command.ts` wires it.
    // Before the fix this ended with one COMPLETED and one AUTH_PREFLIGHT_FAILED.
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const repositories = [await registered(alpha), await registered(beta)];
    let runs = 0;
    const release = gate();
    const seen: Array<ReturnType<typeof provenAuthEvidence> | null> = [];
    const drive = (async (
      _request: Parameters<typeof driveLifecycle>[0],
      dependencies: Parameters<typeof driveLifecycle>[1],
    ) => {
      seen.push(await dependencies.authPreflight());
      return lifecycleResult();
    }) as unknown as typeof driveLifecycle;

    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory,
        now: (): string => new Date().toISOString(),
        git: runGitCommand,
        authPreflight: onceOnlyPreflight(async () => {
          runs += 1;
          await release.wait;
          return provenAuthEvidence();
        }),
        driveLifecycle: drive,
      },
    );
    // Both admissions are inside the memo before it answers.
    await waitFor(() => seen.length === 0 && runs === 1, 10_000, 'the memo to be entered once');
    release.open();
    const result = await run;

    expect(runs).toBe(1);
    expect(seen).toHaveLength(2);
    for (const evidence of seen) expect(evidence).not.toBeNull();
    expect(result.admissions.every((entry) => entry.lifecycle?.outcome === 'COMPLETED')).toBe(true);
  });
});

describe('M2 slice 5 — the coordinator establishes a domain per admission', () => {
  it('gives each admitted lifecycle its own non-null execution domain', async () => {
    // The single production line that closes the measured defect, pinned. A
    // review found it covered by nothing: the register measurement above calls
    // `runInOwnedLaunchDomain` itself, so dropping the wrap in `admit` would not
    // have failed anything.
    //
    // Read at the driver, which is where a launch would be announced from.
    const alpha = makeRepository('alpha', ['A1']);
    const beta = makeRepository('beta', ['B1']);
    const repositories = [await registered(alpha), await registered(beta)];
    const domains: Array<object | null> = [];
    const held = gate();
    const drive = (async () => {
      domains.push(currentOwnedLaunchDomain());
      await held.wait;
      return lifecycleResult();
    }) as unknown as typeof driveLifecycle;

    const run = driveRepositories(
      { repositories, maxConcurrentRepositories: 2, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: drive },
    );
    await waitFor(() => domains.length >= 2, 10_000, 'both admissions to enter the driver');
    held.open();
    await run;

    expect(domains).toHaveLength(2);
    // Non-null: the wrap happened at all.
    for (const domain of domains) expect(domain).not.toBeNull();
    // Distinct: it happened per admission rather than once for the run. One
    // shared domain would put both repositories' launches in both registers,
    // which is the defect with an extra step.
    expect(domains[0]).not.toBe(domains[1]);
    // And the domain does not leak out of the coordinator.
    expect(currentOwnedLaunchDomain()).toBeNull();
  });

  it('carries the domain into a lifecycle that awaits before launching', async () => {
    // The property `AsyncLocalStorage` is here for: a launch twelve frames and
    // several awaits below the wrap is still that admission's.
    const alpha = makeRepository('alpha', ['A1']);
    const repositories = [await registered(alpha)];
    let deep: object | null = null;
    const drive = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await Promise.resolve();
      deep = await (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentOwnedLaunchDomain();
      })();
      return lifecycleResult();
    }) as unknown as typeof driveLifecycle;

    await driveRepositories(
      { repositories, maxConcurrentRepositories: 1, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: drive },
    );
    expect(deep).not.toBeNull();
  });
});

describe('M2 slice 5 — the admission ceiling', () => {
  it('stops at MAX_COORDINATOR_ADMISSIONS and awaits what it started', async () => {
    // Reachable without 4096 real tasks: the planner is a seam, so the ranking
    // is handed in. One real repository, and one ranking entry per admission the
    // ceiling allows plus one more.
    const root = makeRepository('solo', ['T1']);
    const only = await registered(root);
    const repositories = [only];
    const real = planAcrossRepositories(repositories);
    const ranking = Array.from({ length: MAX_COORDINATOR_ADMISSIONS + 1 }, (_, index) =>
      Object.freeze({
        repositoryId: only.repository.id,
        repositoryRoot: only.repository.root,
        taskId: `T${String(index)}`,
      }),
    );
    const plan: CrossRepositoryPlan = Object.freeze({ ...real, ranking: Object.freeze(ranking) });
    const seam = recordingDrive();

    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 1, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive, planAcrossRepositories: () => plan },
    );

    expect(result.outcome).toBe('ADMISSION_BUDGET_EXHAUSTED');
    expect(result.reasonCodes).toEqual(['MAX_COORDINATOR_ADMISSIONS_REACHED']);
    expect(result.admissions).toHaveLength(MAX_COORDINATOR_ADMISSIONS);
    // Everything it started was awaited, and the ceiling is what stopped it —
    // not an exception and not a silent end.
    expect(seam.live.size).toBe(0);
    // `EXIT_RUN_CALL_AGAIN`: progress was made and more may remain.
    expect(exitCodeForCrossRepositoryRun(result)).toBe(5);
  }, 120_000);

  it('does not report the ceiling for a run that merely walked past it', async () => {
    // The check sits **after** the `attempted` skip, so a candidate this run has
    // already driven consumes no budget.
    //
    // Discriminating on exactly the ceiling, not on a small number: with two
    // tasks the placement makes no difference at all, and a first version of
    // this case asserted that and let the reordering mutant live. Here the run
    // admits exactly `MAX_COORDINATOR_ADMISSIONS` and then takes one more pass
    // over a ranking whose every entry it has already driven. Checked before the
    // skip, that pass reports the ceiling; checked after it, there is no
    // candidate left to spend budget on and the run is simply complete.
    const root = makeRepository('solo', ['T1']);
    const only = await registered(root);
    const repositories = [only];
    const real = planAcrossRepositories(repositories);
    const ranking = Array.from({ length: MAX_COORDINATOR_ADMISSIONS }, (_, index) =>
      Object.freeze({
        repositoryId: only.repository.id,
        repositoryRoot: only.repository.root,
        taskId: `T${String(index)}`,
      }),
    );
    const plan: CrossRepositoryPlan = Object.freeze({ ...real, ranking: Object.freeze(ranking) });
    const seam = recordingDrive();

    const result = await driveRepositories(
      { repositories, maxConcurrentRepositories: 1, maxSteps: 1, maxInvocations: 1 },
      { mcpPreflight: noMcpPreflightFactory, ...BASE_DEPS, driveLifecycle: seam.drive, planAcrossRepositories: () => plan },
    );

    expect(result.admissions).toHaveLength(MAX_COORDINATOR_ADMISSIONS);
    expect(result.outcome).toBe('RUN_COMPLETE');
    expect(result.reasonCodes).toEqual([]);
    expect(exitCodeForCrossRepositoryRun(result)).toBe(0);
  }, 120_000);
});

describe('M2 slice 5 — the exit code a shell branches on', () => {
  function admission(
    outcome: LifecycleResult['outcome'] | 'THREW',
  ): { threw: boolean; lifecycle: { outcome: LifecycleResult['outcome']; start: null } | null } {
    return outcome === 'THREW'
      ? { threw: true, lifecycle: null }
      : { threw: false, lifecycle: { outcome, start: null } };
  }

  const run = (
    outcome: CrossRepositoryRunResult['outcome'],
    planCode: CrossRepositoryRunResult['planCode'],
    admissions: ReturnType<typeof admission>[],
  ): Parameters<typeof exitCodeForCrossRepositoryRun>[0] => ({ outcome, planCode, admissions });

  it.each([
    ['every admission completed', 'RUN_COMPLETE', [admission('COMPLETED')], 0],
    ['one needs an operator', 'RUN_COMPLETE', [admission('BLOCKED_VERIFY')], 3],
    ['one was refused by a live owner', 'RUN_COMPLETE', [admission('LIVE_OWNER_PRESENT')], 4],
    ['one has budget left', 'RUN_COMPLETE', [admission('INVOCATION_BUDGET_EXHAUSTED')], 5],
    ['one threw', 'RUN_COMPLETE', [admission('THREW')], 1],
    ['a bad bound', 'RUN_COMPLETE', [admission('INVOCATION_BUDGET_INVALID')], 2],
  ] as const)('exits %s -> %i', (_name, outcome, admissions, code) => {
    expect(exitCodeForCrossRepositoryRun(run(outcome, 'TASK_SELECTED', [...admissions]))).toBe(code);
  });

  it('folds several answers to the most demanding one, in a stated order', () => {
    // The scenario a review named: repository A leaves a durable record a human
    // has to look at (3), repository B is refused because somebody else holds
    // its lease (4). Reporting 4 — "try later" — would leave A's record unread.
    expect(
      exitCodeForCrossRepositoryRun(
        run('RUN_COMPLETE', 'TASK_SELECTED', [
          admission('LIVE_OWNER_PRESENT'),
          admission('BLOCKED_VERIFY'),
        ]),
      ),
    ).toBe(3);
    // And the whole ranking, worst first, each pair asserted rather than the
    // list being asserted against itself.
    const pairs: ReadonlyArray<readonly [LifecycleResult['outcome'] | 'THREW', LifecycleResult['outcome'] | 'THREW', number]> = [
      ['THREW', 'BLOCKED_VERIFY', 1],
      ['BLOCKED_VERIFY', 'INVOCATION_BUDGET_INVALID', 3],
      ['INVOCATION_BUDGET_INVALID', 'LIVE_OWNER_PRESENT', 2],
      ['LIVE_OWNER_PRESENT', 'INVOCATION_BUDGET_EXHAUSTED', 4],
      ['INVOCATION_BUDGET_EXHAUSTED', 'COMPLETED', 5],
    ];
    for (const [worse, better, expected] of pairs) {
      expect(
        exitCodeForCrossRepositoryRun(
          run('RUN_COMPLETE', 'TASK_SELECTED', [admission(worse), admission(better)]),
        ),
      ).toBe(expected);
      // Order of the admissions must not decide it.
      expect(
        exitCodeForCrossRepositoryRun(
          run('RUN_COMPLETE', 'TASK_SELECTED', [admission(better), admission(worse)]),
        ),
      ).toBe(expected);
    }
  });

  it('ranks every exit code a run can produce, so the fail-closed floor is unreachable', () => {
    // `worseExitCode` ranks a code the list does not know **worst**, and that
    // branch cannot be reached by any run — which a mutation campaign confirmed
    // by inverting it and surviving. It is not dead code to delete: it is the
    // floor under the assertion below, and the assertion is what makes it
    // unreachable. Pinned as a set rather than left as a comment, because the
    // one way it becomes reachable is somebody adding a seventh code.
    expect([...EXIT_CODE_SEVERITY].sort((a, b) => a - b)).toEqual([
      EXIT_RUN_OK,
      EXIT_RUN_UNEXPECTED,
      EXIT_RUN_INPUT_UNUSABLE,
      EXIT_RUN_NEEDS_OPERATOR,
      EXIT_RUN_REFUSED,
      EXIT_RUN_CALL_AGAIN,
    ].sort((a, b) => a - b));
    // And the one code deliberately absent, with its reason: the runtime gate
    // terminates the process at the CLI entry before any command is dispatched,
    // so no run can produce it beside another code.
    expect([...EXIT_CODE_SEVERITY]).not.toContain(EXIT_RUNTIME_UNSUPPORTED);
  });

  it('grades a coordinator that admitted nothing and cannot say why as a defect', () => {
    // Not reachable — a run that planned at all records the code — and graded as
    // 1 rather than 0, because a coordinator with no answer has not answered.
    expect(exitCodeForCrossRepositoryRun(run('NOTHING_ADMITTED', null, []))).toBe(1);
  });
});

describe('M2 slice 5 — the operator’s report of a run', () => {
  it('renders every admission, in admission order, and names an unreported one', () => {
    const rendered = renderCrossRepositoryRun(
      Object.freeze({
        outcome: 'RUN_COMPLETE' as const,
        planCode: 'TASK_SELECTED' as const,
        capacity: 2,
        passes: 3,
        maxObservedConcurrency: 2,
        reasonCodes: Object.freeze([]),
        admissions: Object.freeze([
          Object.freeze({
            repositoryId: 'alpha',
            repositoryRoot: 'C:\\repos\\alpha',
            taskId: 'A1',
            sequence: 1,
            concurrencyAtAdmission: 1,
            threw: false,
            lifecycle: lifecycleResult('COMPLETED'),
          }),
          Object.freeze({
            repositoryId: 'beta',
            repositoryRoot: 'C:\\repos\\beta',
            taskId: 'B1',
            sequence: 2,
            concurrencyAtAdmission: 2,
            threw: true,
            lifecycle: null,
          }),
        ]),
      }) as unknown as CrossRepositoryRunResult,
    );

    expect(rendered).toContain('Capacity        : 2');
    expect(rendered).toContain('Peak concurrency: 2');
    expect(rendered).toContain('#1 alpha');
    expect(rendered).toContain('A1');
    expect(rendered).toContain('COMPLETED');
    expect(rendered).toContain('#2 beta');
    // An ending with no report is named as one rather than rendered as a dash.
    expect(rendered).toContain('UNREPORTED');
    expect(rendered).toContain('driving this task threw');
    // Admission order in the text, not completion order.
    expect(rendered.indexOf('#1 alpha')).toBeLessThan(rendered.indexOf('#2 beta'));
    // The run trailer, not the read-only one.
    expect(rendered).toContain('not offered here and were not taken');
    expect(rendered).not.toContain('This report acts on nothing');
  });

  it('prints the run report and the run’s exit code through the command', async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerRepositoriesCommand(program, {
      loadRepositoryRegistry: () =>
        Object.freeze({
          state: 'REGISTERED' as const,
          registryDigest: 'b'.repeat(64),
          entries: Object.freeze([]),
          maxConcurrentRepositories: 2,
        }),
      resolveRegisteredRepositories: async () =>
        Object.freeze({ ok: true as const, repositories: Object.freeze([]) }),
      driveRepositories: (async () =>
        Object.freeze({
          outcome: 'RUN_COMPLETE' as const,
          planCode: 'TASK_SELECTED' as const,
          capacity: 2,
          passes: 2,
          maxObservedConcurrency: 2,
          reasonCodes: Object.freeze([]),
          admissions: Object.freeze([
            Object.freeze({
              repositoryId: 'alpha',
              repositoryRoot: 'C:\\repos\\alpha',
              taskId: 'A1',
              sequence: 1,
              concurrencyAtAdmission: 2,
              threw: false,
              lifecycle: lifecycleResult('BLOCKED_VERIFY'),
            }),
          ]),
        })) as unknown as typeof driveRepositories,
    });

    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((text: string): boolean => {
      out.push(String(text));
      return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync(['repositories', '--attended'], { from: 'user' });
    } finally {
      process.stdout.write = original;
    }

    const output = out.join('');
    expect(output).toContain('Run             : RUN_COMPLETE');
    expect(output).toContain('BLOCKED_VERIFY');
    // The shell answer an unattended caller branches on. A run whose only
    // admission left a durable record for a human is 3, not 0.
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
  });
});

/* ─────────────────────────── small helpers ──────────────────────────────── */

/** Lets every pending microtask and one timer turn run. */
async function settleMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

/**
 * Waits until `condition` holds, or fails the test.
 *
 * A bounded wait for a **condition**, never a sleep standing in for one: every
 * assertion that follows one of these is about program order, and the timeout is
 * only here so a broken build fails instead of hanging.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 30_000,
  what = 'an unnamed condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) {
      // Named, because the alternative is a failure that says only "the budget
      // ran out" - and in the register measurement below, a reader following
      // this file's own comment would then diagnose "the instrument is blind"
      // when the truth was "this box is slow".
      throw new Error(`waited ${String(timeoutMs)}ms for ${what} and it did not hold`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
