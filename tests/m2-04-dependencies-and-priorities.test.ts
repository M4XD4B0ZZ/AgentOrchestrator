/**
 * M2 slice 4 — prerequisites and priority, across repositories.
 *
 * ── What this slice found, before it changed anything ──────────────────────
 *
 * The ordering model this slice was asked to build already existed. V1-02 gave
 * the single-repository path a dependency DAG, an eligibility rule and a
 * five-element ranking tuple; M2 slice 3 merged that answer across repositories
 * with a sixth element. Measured on the pre-change build, every scenario came
 * out right: a blocked task was not selected, a `DONE` dependency released its
 * dependent, priority ranked the runnable set, a cycle refused, an unknown
 * dependency refused, and the answer did not depend on input order.
 *
 * So the honest subject of this file is not "does the new model work". It is
 * the set of sentences that were **true and unpinned** — a true sentence with
 * no test is a sentence the next slice may delete by accident — plus the two
 * places where the model was genuinely incomplete.
 *
 * ── The three things that were actually missing ────────────────────────────
 *
 *  1. **Priority never had to lose to a prerequisite.** No test anywhere made a
 *     blocked task the *would-be winner*. There was one blocked `HIGH` fixture
 *     — `tests/task-selection.test.ts:274` — and it lost anyway on element 0 to
 *     a `REMEDIATION` task, so deleting the eligibility filter changed no
 *     assertion in the suite. (An earlier version of this paragraph said every
 *     blocked fixture was `NORMAL`; a review measured that false. The
 *     conclusion is unchanged and the reason is now the right one.) Group 1 and
 *     group 3 fix it, single-repository and merged: in each, removing the
 *     filter changes the selected task.
 *  2. **The merged ranking's filter was unmeasured.** Cross-repository, the only
 *     ineligible task in any fixture was `ALREADY_DONE`. A mutant narrowing
 *     `if (!eligibility.eligible) continue` to "skip only the finished ones"
 *     survived the whole slice-3 suite. Case 3.1 kills it.
 *  3. **Repository-locality of a dependency was never stated.** That a
 *     `dependsOn` entry resolves inside its own repository's graph and nowhere
 *     else is a *contract*, and it was an emergent property of calling
 *     `planNextTask` once per repository. Group 3 pins it from both sides — a
 *     `DONE` task in one repository does not satisfy a same-named prerequisite
 *     in another, and a reference to a task that exists only next door refuses.
 *
 * ── And the one refusal that could not be read ─────────────────────────────
 *
 * A qualified reference — `dependsOn: [beta:auth-1]` — was already refused, by
 * the id grammar, and it was refused *anonymously*: it produced
 * `TASK_DEFINITION_INVALID`, the same code as a mistyped `priority`. An
 * operator could not tell a policy this product does not offer from a typo.
 * Group 4 pins the new `TASK_DEPENDENCY_CROSS_PROJECT`, and — the case that
 * matters more — pins that it does **not** fire for an ordinary contract
 * violation, which is what makes it a narrowing rather than a catch-all.
 *
 * ── Fixtures are real repositories wherever a repository is the subject ────
 *
 * Groups 3, 4 and 5 build real `git init` trees with real profiles, real task
 * files and a real registry document under a scratch OS-profile directory,
 * reached through the internal `PathProvider` seam. In-memory definitions are
 * used only where the subject is the comparator itself, which is a pure
 * function of a graph and has no repository in it.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';

import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import {
  TASK_DISCOVERY_FAILURE_CODES,
  discoverTasks,
  type TaskDiscoveryFailureCode,
} from '../src/plan/discover-tasks.js';
import { planNextTask } from '../src/plan/plan-next-task.js';
import { planAcrossRepositories } from '../src/plan/plan-across-repositories.js';
import {
  evaluateTaskEligibility,
  selectNextTask,
  taskRankingKey,
} from '../src/plan/select-task.js';
import { normalizeTaskGraph, type NormalizedTaskGraph } from '../src/plan/task-graph.js';
import type { TaskDefinition } from '../src/plan/task-definition.js';
import {
  loadRepositoryRegistry,
  repositoryRegistryPath,
  resolveRegisteredRepositories,
  type RegisteredRepository,
} from '../src/registry/repository-registry.js';
import { resolveRepository } from '../src/repo/resolve-repository.js';
import {
  MAX_REPORTED_BLOCKED_TASKS,
  MAX_REPORTED_PREREQUISITES,
  renderCrossRepositoryPlan,
} from '../src/cli/render-repositories.js';
import { registerRepositoriesCommand } from '../src/cli/repositories-command.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const created: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return realpathSync.native(dir);
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

const PROFILE = `schemaVersion: 1
repository:
  id: ID
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: VERIFY
      command: [npm, run, verify]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: 3
remote:
  required: false
`;

interface TaskFields {
  readonly status?: 'OPEN' | 'DONE';
  readonly kind?: 'NORMAL' | 'REMEDIATION';
  readonly priority?: 'HIGH' | 'NORMAL' | 'LOW';
  readonly currentFocus?: boolean;
  readonly dependsOn?: readonly string[];
}

/**
 * One task file.
 *
 * `dependsOn` is written as a **block sequence of JSON-quoted scalars**, unlike
 * the slice-3 helper's flow sequence, so that every character in a reference
 * reaches the parser as written. `JSON.stringify` is what makes that true for a
 * backslash: `"beta\auth-1"` in YAML is `beta` + BELL, because `\a` is an escape
 * — measured, and the reason `docs/OPERATOR-GUIDE.md` now warns about it.
 *
 * An earlier version of this comment justified the block form by claiming
 * `[beta:auth-1]` in flow context is "ambiguous between a scalar and a
 * single-pair mapping". That was reasoned rather than measured, and it is
 * false: it resolves to the scalar `beta:auth-1`. The flow spelling is the one
 * the documentation uses, so `flowTaskFile` below feeds it verbatim rather than
 * leaving the documented form untested.
 */
function taskFile(id: string, fields: TaskFields = {}): string {
  const dependsOn = fields.dependsOn ?? [];
  const dependsOnBlock =
    dependsOn.length === 0
      ? 'dependsOn: []'
      : ['dependsOn:', ...dependsOn.map((entry) => `  - ${JSON.stringify(entry)}`)].join('\n');
  return `---
id: ${id}
title: task ${id}
status: ${fields.status ?? 'OPEN'}
kind: ${fields.kind ?? 'NORMAL'}
priority: ${fields.priority ?? 'NORMAL'}
currentFocus: ${fields.currentFocus ?? false}
${dependsOnBlock}
---
body
`;
}

/**
 * One task file whose `dependsOn` is a YAML **flow** sequence, written exactly
 * as the documentation writes it — unquoted, inside brackets.
 *
 * This is the spelling `discover-tasks.ts`, the README, the ADR and the operator
 * guide all use as the worked example, and it was the one spelling no fixture
 * fed. A documented example nothing measures is the shape of claim this
 * repository has been wrong about before.
 */
function flowTaskFile(id: string, dependsOn: readonly string[]): string {
  return `---
id: ${id}
title: task ${id}
status: OPEN
kind: NORMAL
priority: NORMAL
currentFocus: false
dependsOn: [${dependsOn.join(', ')}]
---
body
`;
}

/** A real Git repository with a real profile and real task files. */
function makeRepository(id: string, tasks: Readonly<Record<string, TaskFields>>): string {
  const root = scratch('ao-m2-04-');
  git(root, ['init', '-b', 'main', '--quiet']);
  write(root, '.gitattributes', '* -text\n');
  write(root, 'README.md', `# ${id}\n`);
  write(root, '.agent-orchestrator/repo-profile.yaml', PROFILE.replace('id: ID', `id: ${id}`));
  for (const [taskId, fields] of Object.entries(tasks)) {
    write(root, `tasks/${taskId}.md`, taskFile(taskId, fields));
  }
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

/** Replaces one task file in place and commits it. */
function rewriteTask(root: string, taskId: string, fields: TaskFields): void {
  write(root, `tasks/${taskId}.md`, taskFile(taskId, fields));
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'rewrite']);
}

/** Writes one raw task file, bypassing the field helper. */
function writeRawTask(root: string, taskId: string, body: string): void {
  write(root, `tasks/${taskId}.md`, body);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'raw']);
}

function makeHome(): { readonly provider: ReturnType<typeof fixedPathProvider>; readonly path: string } {
  const home = scratch('ao-m2-04-home-');
  const provider = fixedPathProvider(home);
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  return { provider, path: repositoryRegistryPath(provider) };
}

function registryFor(paths: readonly string[]): string {
  return ['schemaVersion: 1', 'repositories:', ...paths.map((p) => `  - path: ${p}`)].join('\n');
}

/**
 * Resolves paths into `RegisteredRepository` values **in the order given**,
 * bypassing `resolveRegisteredRepositories`' own root sort.
 *
 * The bypass is the point, for the reason slice 3 records: the production
 * resolver hands `planAcrossRepositories` an already root-sorted list, and
 * `Array.prototype.sort` is stable, so a root-ordered fixture cannot tell a
 * working comparator from one that returns zero.
 */
async function registeredInOrder(paths: readonly string[]): Promise<RegisteredRepository[]> {
  const out: RegisteredRepository[] = [];
  for (const path of paths) {
    const resolved = await resolveRepository({ repositoryPath: path });
    if (!resolved.ok) throw new Error(`fixture did not resolve: ${resolved.code}`);
    out.push(Object.freeze({ declaredPath: path, repository: resolved.repository }));
  }
  return out;
}

/** The whole production chain: registry document -> resolution -> merged plan. */
async function planWritten(
  paths: readonly string[],
): Promise<ReturnType<typeof planAcrossRepositories>> {
  const home = makeHome();
  writeFileSync(home.path, registryFor(paths), 'utf8');
  const registry = loadRepositoryRegistry(home.provider);
  if (registry.state !== 'REGISTERED') throw new Error(`registry not usable: ${registry.state}`);
  const resolved = await resolveRegisteredRepositories(registry.entries);
  if (!resolved.ok) throw new Error(`resolution refused: ${resolved.code}`);
  return planAcrossRepositories(resolved.repositories);
}

/** One resolved repository, planned through the real single-repository path. */
async function planOne(root: string): Promise<ReturnType<typeof planNextTask>> {
  const resolved = await resolveRepository({ repositoryPath: root });
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${resolved.code}`);
  return planNextTask(resolved.repository);
}

/** The discovery answer for one real repository. */
async function discoverOne(root: string): Promise<ReturnType<typeof discoverTasks>> {
  const resolved = await resolveRepository({ repositoryPath: root });
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${resolved.code}`);
  return discoverTasks(resolved.repository);
}

/**
 * One repository, resolved once, whose single probe task file is rewritten per
 * case.
 *
 * Every case that asks "what does discovery answer for *this* frontmatter" needs
 * a real repository and does not need a *different* one. Building thirty-odd of
 * them made this file heavier than `tests/v4-09-post-merge-verification.test.ts`
 * — the file this repository had to pull out of the parallel gate for exactly
 * that reason — so the ones that can share do.
 *
 * `keep.md` is a valid task, so the source is never empty; it sorts before
 * `probe`, so a refusal always names `probe` rather than being decided by which
 * file discovery happened to open first. Nothing is committed per probe:
 * `discoverTasks` reads the working tree, and the repository was resolved once
 * up front.
 */
let probeRepository: ResolvedRepositoryValue | null = null;

type ResolvedRepositoryValue = Awaited<ReturnType<typeof resolveRepository>> extends infer R
  ? R extends { ok: true; repository: infer P }
    ? P
    : never
  : never;

async function probe(frontmatter: string): Promise<ReturnType<typeof discoverTasks>> {
  if (probeRepository === null) {
    const root = makeRepository('probe-host', { keep: {} });
    const resolved = await resolveRepository({ repositoryPath: root });
    if (!resolved.ok) throw new Error(`probe repository did not resolve: ${resolved.code}`);
    probeRepository = resolved.repository;
  }
  write(probeRepository.root, 'tasks/probe.md', frontmatter);
  return discoverTasks(probeRepository);
}

/** A frontmatter document, field by field, with nothing defaulted. */
function frontmatter(fields: Readonly<Record<string, string>>): string {
  return ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', 'body', ''].join('\n');
}

// ── In-memory definitions, for the cases whose subject is the comparator ───

function def(id: string, overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id,
    title: `Task ${id}`,
    status: 'OPEN',
    kind: 'NORMAL',
    priority: 'NORMAL',
    currentFocus: false,
    dependsOn: [],
    ...overrides,
  };
}

function graphOf(definitions: readonly TaskDefinition[]): NormalizedTaskGraph {
  const result = normalizeTaskGraph(definitions);
  if (!result.ok) throw new Error(`expected a graph, got ${result.code}`);
  return result.graph;
}

function eligibilityOf(graph: NormalizedTaskGraph, taskId: string) {
  const entry = evaluateTaskEligibility(graph).find((item) => item.taskId === taskId);
  if (entry === undefined) throw new Error(`no eligibility entry for ${taskId}`);
  return entry;
}

// ── 1. A prerequisite outranks priority, and now it has to ─────────────────

describe('a prerequisite is not something priority can outrank', () => {
  /**
   * The plan every case in this group is built on.
   *
   *   gate      LOW,  runnable
   *   aaa-high  HIGH, waiting on `gate`
   *
   * `aaa-high` beats `gate` on priority (element 2) *and* on the id (element 4),
   * so it is the head of the ranking the comparator alone would produce. The
   * only thing standing between it and selection is the eligibility filter, and
   * that is exactly what makes this fixture a measurement: with
   * `.filter((entry) => entry.eligible)` removed from `selectNextTask`, the
   * selected task changes from `gate` to `aaa-high`.
   *
   * No fixture in the pre-existing suite had that property — every blocked task
   * in it was `NORMAL` and lost on another element anyway.
   */
  const PLAN: readonly TaskDefinition[] = [
    def('gate', { priority: 'LOW' }),
    def('aaa-high', { priority: 'HIGH', dependsOn: ['gate'] }),
  ];

  it('selects the runnable LOW task over the blocked HIGH one', () => {
    const outcome = selectNextTask(graphOf(PLAN));
    expect(outcome.code).toBe('TASK_SELECTED');
    expect(outcome.selected?.id).toBe('gate');
    expect([...outcome.ranking]).toEqual(['gate']);
  });

  it('and the blocked task really would have won the comparator', () => {
    // Stated as a measurement rather than as an assumption: both keys are
    // computed and compared here, so the case above cannot quietly become a
    // tautology if the tuple is reordered later.
    const graph = graphOf(PLAN);
    const blocked = taskRankingKey(eligibilityOf(graph, 'aaa-high'), graph);
    const runnable = taskRankingKey(eligibilityOf(graph, 'gate'), graph);
    expect(blocked[2]).toBeLessThan(runnable[2]); // priority: HIGH beats LOW
    expect(blocked[4] < runnable[4]).toBe(true); // id: `aaa-high` sorts first
  });

  it('names the prerequisite rather than only refusing', () => {
    const entry = eligibilityOf(graphOf(PLAN), 'aaa-high');
    expect(entry.eligible).toBe(false);
    expect(entry.reason).toBe('BLOCKED_BY_DEPENDENCIES');
    expect([...entry.unsatisfiedDependencies]).toEqual(['gate']);
  });

  it('releases it the moment the prerequisite is DONE, and then it does win', () => {
    // The control for the case above. Without it, "gate was selected" would be
    // satisfied by an implementation that never selects a HIGH task at all.
    const released = graphOf([
      def('gate', { priority: 'LOW', status: 'DONE' }),
      def('aaa-high', { priority: 'HIGH', dependsOn: ['gate'] }),
    ]);
    const outcome = selectNextTask(released);
    expect(outcome.selected?.id).toBe('aaa-high');
    expect([...outcome.ranking]).toEqual(['aaa-high']);
  });

  it('loses even when it leads on every element the tuple compares first', () => {
    // The strongest form: the blocked task is REMEDIATION, focused, HIGH and
    // first by id — it wins elements 0, 1, 2 and 4 — and is still not selected.
    // A filter applied to some elements and not others cannot pass this.
    const outcome = selectNextTask(
      graphOf([
        def('zzz-plain'),
        def('aaa-everything', {
          kind: 'REMEDIATION',
          currentFocus: true,
          priority: 'HIGH',
          dependsOn: ['zzz-plain'],
        }),
      ]),
    );
    expect(outcome.selected?.id).toBe('zzz-plain');
    expect([...outcome.ranking]).toEqual(['zzz-plain']);
  });

  it('keeps priority working among the tasks that ARE runnable', () => {
    // The other half of "priority ranks only the eligible set": having proved
    // it cannot cross the filter, prove it still decides inside it.
    const outcome = selectNextTask(
      graphOf([
        def('gate'),
        def('zzz-high', { priority: 'HIGH' }),
        def('aaa-low', { priority: 'LOW' }),
        def('blocked-high', { priority: 'HIGH', dependsOn: ['gate'] }),
      ]),
    );
    expect(outcome.selected?.id).toBe('zzz-high');
    expect([...outcome.ranking]).toEqual(['zzz-high', 'gate', 'aaa-low']);
  });
});

// ── 2. The priority contract, stated in literals ───────────────────────────

describe('the priority contract', () => {
  it('ranks HIGH before NORMAL before LOW, by value', () => {
    const rankOf = (priority: TaskDefinition['priority']): number => {
      const graph = graphOf([def('T', { priority })]);
      return taskRankingKey(eligibilityOf(graph, 'T'), graph)[2];
    };
    expect(rankOf('HIGH')).toBe(0);
    expect(rankOf('NORMAL')).toBe(1);
    expect(rankOf('LOW')).toBe(2);
  });

  it('sits at element 2, behind kind and focus and ahead of unlock and id', () => {
    // Asserted as the whole tuple, so a reordering of the elements cannot pass
    // by leaving priority's own three values in the right relative order.
    const graph = graphOf([
      def('A', { kind: 'REMEDIATION', currentFocus: true, priority: 'HIGH' }),
      def('B', { kind: 'NORMAL', currentFocus: false, priority: 'LOW', dependsOn: ['A'] }),
    ]);
    expect(taskRankingKey(eligibilityOf(graph, 'A'), graph)).toEqual([0, 0, 0, -1, 'A']);
    expect(taskRankingKey(eligibilityOf(graph, 'B'), graph)).toEqual([1, 1, 2, 0, 'B']);
  });

  it('is not defaulted: a task file that states no priority is refused', async () => {
    const discovered = await probe(
      frontmatter({
        id: 'probe',
        title: 't',
        status: 'OPEN',
        kind: 'NORMAL',
        currentFocus: 'false',
        dependsOn: '[]',
      }),
    );
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_DEFINITION_INVALID');
    expect(discovered.taskId).toBe('probe');
  });

  it('is a closed set: a value outside it never reaches the comparator', async () => {
    const discovered = await probe(
      frontmatter({
        id: 'probe',
        title: 't',
        status: 'OPEN',
        kind: 'NORMAL',
        priority: 'URGENT',
        currentFocus: 'false',
        dependsOn: '[]',
      }),
    );
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_DEFINITION_INVALID');
  });

  it('counts unfinished work downstream, and walks THROUGH a finished task to find it', () => {
    // The divergence, pinned so it is a decision rather than an accident.
    //
    //     zz-root (OPEN) ──▶ mid (DONE) ──▶ c1, c2 (OPEN)
    //
    // `c1` and `c2` are already eligible: their only dependency is `DONE`. So
    // finishing `zz-root` releases nothing, and yet `zz-root` is ranked first
    // on an unlock count of 2 and beats `aa-other`, which it would otherwise
    // lose to on the id.
    //
    // Both readings of the metric are defensible and the module used to state
    // both. This build ships the downstream one — `c1` and `c2` are not-DONE
    // tasks that transitively depend on `zz-root` — and the header now says so
    // instead of promising the other. The case is here because a sentence
    // nothing measures is a sentence the next slice may quietly re-break.
    const graph = graphOf([
      def('zz-root'),
      def('mid', { status: 'DONE', dependsOn: ['zz-root'] }),
      def('c1', { dependsOn: ['mid'] }),
      def('c2', { dependsOn: ['mid'] }),
      def('aa-other'),
    ]);

    // The premise: the downstream tasks really are already runnable.
    expect(eligibilityOf(graph, 'c1').eligible).toBe(true);
    expect(eligibilityOf(graph, 'c2').eligible).toBe(true);

    expect(eligibilityOf(graph, 'zz-root').unlockCount).toBe(2);
    expect(eligibilityOf(graph, 'aa-other').unlockCount).toBe(0);
    expect(selectNextTask(graph).selected?.id).toBe('zz-root');

    // And the same number reaches the merged ranking unchanged, because the
    // cross-repository key destructures this one rather than recomputing it.
    expect(taskRankingKey(eligibilityOf(graph, 'zz-root'), graph)[3]).toBe(-2);
  });

  it('breaks an exact tie on the unlock count, then on the id', () => {
    // Both elements asserted by value rather than by which task won, because a
    // shuffled *input* is canonicalised by `normalizeTaskGraph` before ranking:
    // a comparator mutated to `return 0` survives every input-order test in the
    // suite and is killed only by cases like this one.
    const graph = graphOf([def('A'), def('B'), def('C', { dependsOn: ['B'] })]);
    expect(taskRankingKey(eligibilityOf(graph, 'A'), graph)).toEqual([1, 1, 1, 0, 'A']);
    expect(taskRankingKey(eligibilityOf(graph, 'B'), graph)).toEqual([1, 1, 1, -1, 'B']);
    expect(selectNextTask(graph).selected?.id).toBe('B');
  });
});

// ── 3. A dependency is repository-local ────────────────────────────────────

describe('a dependency resolves inside its own repository and nowhere else', () => {
  it('3.1 — a blocked task is absent from the merged ranking, and it would have won', async () => {
    // alpha: `gate` LOW runnable, `aaa-high` HIGH waiting on it.
    // beta:  `mmm-normal` NORMAL runnable.
    //
    // Eligible across both: {alpha/gate LOW, beta/mmm-normal NORMAL}, so beta
    // wins on priority. Admit `aaa-high` to the candidate set and it wins
    // instead — it is HIGH and first by id. The pre-change suite could not see
    // this: cross-repository, every ineligible task in every fixture was
    // ALREADY_DONE, so a filter narrowed to "skip only the finished ones"
    // survived it. This case is that mutant's counterexample.
    const alpha = makeRepository('alpha', {
      gate: { priority: 'LOW' },
      'aaa-high': { priority: 'HIGH', dependsOn: ['gate'] },
    });
    const beta = makeRepository('beta', { 'mmm-normal': { priority: 'NORMAL' } });

    const plan = await planWritten([alpha, beta]);
    expect(plan.code).toBe('TASK_SELECTED');
    expect(plan.selected?.task.id).toBe('mmm-normal');
    expect(plan.selected?.repository.root).toBe(beta);
    expect(plan.ranking.map((entry) => entry.taskId)).toEqual(['mmm-normal', 'gate']);
    expect(plan.ranking.some((entry) => entry.taskId === 'aaa-high')).toBe(false);

    // And the blocked task is reported as blocked, with its prerequisite named.
    const alphaPlan = plan.plans.find((entry) => entry.repository.root === alpha);
    const blocked = alphaPlan?.eligibility.find((entry) => entry.taskId === 'aaa-high');
    expect(blocked?.reason).toBe('BLOCKED_BY_DEPENDENCIES');
    expect([...(blocked?.unsatisfiedDependencies ?? [])]).toEqual(['gate']);
  });

  it('3.2 — a DONE task in one repository does not satisfy a same-named prerequisite in another', async () => {
    // Both repositories declare `shared`. In alpha it is DONE; in beta it is
    // open, and beta's `dependent` waits for it. If the two graphs were ever
    // merged — or if a dependency were resolved by bare id against a global
    // index — beta/dependent would become runnable on alpha's evidence.
    const alpha = makeRepository('alpha', {
      shared: { status: 'DONE' },
      'alpha-work': {},
    });
    const beta = makeRepository('beta', {
      shared: {},
      dependent: { dependsOn: ['shared'] },
    });

    const plan = await planWritten([alpha, beta]);
    const betaPlan = plan.plans.find((entry) => entry.repository.root === beta);
    const dependent = betaPlan?.eligibility.find((entry) => entry.taskId === 'dependent');
    expect(dependent?.eligible).toBe(false);
    expect(dependent?.reason).toBe('BLOCKED_BY_DEPENDENCIES');
    expect([...(dependent?.unsatisfiedDependencies ?? [])]).toEqual(['shared']);
    expect(plan.ranking.some((entry) => entry.taskId === 'dependent')).toBe(false);

    // The control: alpha's `shared` really is DONE, so the fixture does contain
    // the evidence that would have released it had the lookup been global.
    const alphaPlan = plan.plans.find((entry) => entry.repository.root === alpha);
    expect(alphaPlan?.eligibility.find((entry) => entry.taskId === 'shared')?.reason).toBe(
      'ALREADY_DONE',
    );
  });

  it('3.3 — and it is beta’s own `shared` that releases it', async () => {
    // The other direction of 3.2. Same two repositories; this time beta's own
    // `shared` is marked DONE and alpha's is left open. If the binding were to
    // the wrong repository the answer would be unchanged from 3.2.
    const alpha = makeRepository('alpha', { shared: {}, 'alpha-work': {} });
    const beta = makeRepository('beta', { shared: {}, dependent: { dependsOn: ['shared'] } });

    const before = await planWritten([alpha, beta]);
    expect(
      before.plans
        .find((entry) => entry.repository.root === beta)
        ?.eligibility.find((entry) => entry.taskId === 'dependent')?.eligible,
    ).toBe(false);

    rewriteTask(beta, 'shared', { status: 'DONE' });

    const after = await planWritten([alpha, beta]);
    const dependent = after.plans
      .find((entry) => entry.repository.root === beta)
      ?.eligibility.find((entry) => entry.taskId === 'dependent');
    expect(dependent?.eligible).toBe(true);
    expect(dependent?.reason).toBe(null);
    expect(after.ranking.some((entry) => entry.taskId === 'dependent')).toBe(true);
  });

  it('3.4 — a reference to a task that exists only in the other repository refuses', async () => {
    // `only-in-alpha` is a perfectly real task — next door. Beta's graph does
    // not contain it, so beta cannot be planned, and one unplannable repository
    // refuses the whole plan rather than naming a winner among the rest.
    const alpha = makeRepository('alpha', { 'only-in-alpha': {} });
    const beta = makeRepository('beta', { 'beta-1': { dependsOn: ['only-in-alpha'] } });

    const plan = await planWritten([alpha, beta]);
    expect(plan.code).toBe('REPOSITORY_UNPLANNABLE');
    expect(plan.planningCode).toBe('TASK_DEPENDENCY_UNKNOWN');
    expect(plan.failedRepositoryRoot).toBe(beta);
    expect(plan.selected).toBe(null);
    // Nothing partial is published — not the ranking, and not alpha's plan,
    // which had already succeeded.
    expect(plan.ranking).toEqual([]);
    expect(plan.plans).toEqual([]);
  });

  it('3.5 — a cycle in one repository refuses the whole plan, and says which failure it was', async () => {
    const alpha = makeRepository('alpha', { 'a-1': {} });
    const beta = makeRepository('beta', {
      x: { dependsOn: ['y'] },
      y: { dependsOn: ['x'] },
    });

    const plan = await planWritten([alpha, beta]);
    expect(plan.code).toBe('REPOSITORY_UNPLANNABLE');
    // The code as well as the outcome. Slice 3 pinned only the outcome here, so
    // a cycle reported as an empty task source would have passed.
    expect(plan.planningCode).toBe('TASK_GRAPH_CYCLE');
    expect(plan.failedRepositoryRoot).toBe(beta);
    expect(plan.selected).toBe(null);
  });

  it('3.6 — the answer does not depend on which repository was enumerated first', async () => {
    // Handed to `planAcrossRepositories` directly, in both orders, bypassing
    // the resolver's own root sort — otherwise this measures that sort.
    const alpha = makeRepository('alpha', {
      gate: { priority: 'LOW' },
      'aaa-high': { priority: 'HIGH', dependsOn: ['gate'] },
    });
    const beta = makeRepository('beta', { 'mmm-normal': {} });

    const forward = planAcrossRepositories(await registeredInOrder([alpha, beta]));
    const reverse = planAcrossRepositories(await registeredInOrder([beta, alpha]));

    expect(forward.code).toBe('TASK_SELECTED');
    expect(reverse.code).toBe('TASK_SELECTED');
    expect(forward.selected?.task.id).toBe(reverse.selected?.task.id);
    expect(forward.selected?.repository.root).toBe(reverse.selected?.repository.root);
    expect(forward.ranking).toStrictEqual(reverse.ranking);
    expect(forward.selected?.repository.root).toBe(beta);
  });

  it('3.7 — the winner carries its own repository, which is never the working directory', async () => {
    const alpha = makeRepository('alpha', { 'zzz-last': {} });
    const beta = makeRepository('beta', { 'aaa-first': { dependsOn: [] } });
    const plan = await planWritten([alpha, beta]);

    expect(plan.selected?.task.id).toBe('aaa-first');
    expect(plan.selected?.repository.root).toBe(beta);
    expect(plan.selected?.repository.id).toBe('beta');
    expect(plan.selected?.repository.root).not.toBe(process.cwd());

    // The binding is the whole resolved value, so no later step can re-derive
    // it from anywhere else.
    const resolvedBeta = await resolveRepository({ repositoryPath: beta });
    expect(resolvedBeta.ok).toBe(true);
    if (!resolvedBeta.ok) return;
    expect(plan.selected?.repository).toStrictEqual(resolvedBeta.repository);
  });
});

// ── 4. A qualified reference is refused, by name ───────────────────────────

describe('a cross-project dependency reference', () => {
  const SPELLINGS: readonly string[] = [
    'beta:auth-1', // a namespace
    'beta/auth-1', // a POSIX path
    'beta\\auth-1', // a Windows path
    '../beta/auth-1', // a path out of the repository
    'C:/beta/auth-1', // an absolute path
  ];

  it('is refused by name, in every spelling', async () => {
    // One case rather than five, and one repository rather than five: the
    // subject is the classifier, and the spelling is named in the assertion so
    // a failure still says which one.
    for (const spelling of SPELLINGS) {
      const discovered = await probe(taskFile('probe', { dependsOn: [spelling] }));
      expect(discovered.ok, spelling).toBe(false);
      if (discovered.ok) continue;
      expect(discovered.code, spelling).toBe('TASK_DEPENDENCY_CROSS_PROJECT');
      expect(discovered.taskId, spelling).toBe('probe');
    }
  });

  it('is refused by name in the unquoted flow spelling the documentation uses', async () => {
    // `dependsOn: [beta:auth-1]` — no quotes, no block sequence. YAML resolves
    // it to the scalar `beta:auth-1` rather than to a single-pair mapping, so
    // the classifier sees a string and the documented example gets the
    // documented code. Measured here rather than reasoned about: if it ever
    // resolved to a mapping, the entry would not be a string,
    // `declaresQualifiedDependency` would answer `false`, and the worked example
    // in four documents would quietly produce `TASK_DEFINITION_INVALID`.
    const discovered = await probe(flowTaskFile('probe', ['beta:auth-1']));
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_DEPENDENCY_CROSS_PROJECT');
    expect(discovered.taskId).toBe('probe');
  });

  it('names the cross-project cause when a document also violates the contract elsewhere', async () => {
    // The precedence, stated rather than left to be discovered. A document with
    // a qualified dependency AND a bad `priority` reports the cross-project
    // code, and the `priority` typo is never named — `issueCount` says there was
    // more than one violation and nothing says which. That is a consequence of
    // classifying on the already-refused branch, and it is the right way round:
    // a refused *feature* is the more actionable of the two, because fixing the
    // typo would not make the file valid.
    const discovered = await probe(
      frontmatter({
        id: 'probe',
        title: 't',
        status: 'OPEN',
        kind: 'NORMAL',
        priority: 'URGENT',
        currentFocus: 'false',
        dependsOn: '["beta:auth-1"]',
      }),
    );
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_DEPENDENCY_CROSS_PROJECT');
    expect(discovered.issueCount).toBeGreaterThan(1);
  });

  it('does not fire for an ordinary contract violation', async () => {
    // The case that makes the new code a *narrowing*. A classifier that
    // answered "cross-project" for every refused document would pass every case
    // above and fail this one — and it would be worse than the anonymous
    // refusal it replaced, because it would name a cause that is not there.
    const discovered = await probe(
      frontmatter({
        id: 'probe',
        title: 't',
        status: 'OPEN',
        kind: 'NORMAL',
        priority: 'URGENT',
        currentFocus: 'false',
        dependsOn: '[]',
      }),
    );
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_DEFINITION_INVALID');
  });

  it('does not fire for a refused document whose dependency list is legal', async () => {
    // A qualifier somewhere else in the document must not be read as one in
    // `dependsOn`. Here the *title* carries a colon and a slash, and the
    // refusal is caused by `status`.
    const discovered = await probe(
      frontmatter({
        id: 'probe',
        title: '"beta:auth-1 / see also"',
        status: 'WIP',
        kind: 'NORMAL',
        priority: 'NORMAL',
        currentFocus: 'false',
        dependsOn: '[]',
      }),
    );
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_DEFINITION_INVALID');
  });

  it('leaves a legal local dependency accepted, unchanged', async () => {
    // The admission control. The new branch runs only after the contract has
    // already refused, so a valid document cannot reach it — asserted rather
    // than reasoned about.
    const root = makeRepository('alpha', { gate: {}, later: { dependsOn: ['gate'] } });
    const discovered = await discoverOne(root);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.tasks.map((task) => task.id)).toEqual(['gate', 'later']);
  });

  it('reports an unqualified reference to another repository’s task as unknown, not cross-project', async () => {
    // Deliberate, and the honest answer: `auth-1` with no qualifier is
    // indistinguishable from a task this repository meant to declare and did
    // not. Claiming to know the author meant the repository next door would be
    // an inference, and this build does not make one.
    //
    // This one needs its own repository: the refusal is `normalizeTaskGraph`'s,
    // which needs a *whole* discovery to succeed first.
    const root = makeRepository('unqualified', { 'a-1': { dependsOn: ['auth-1'] } });
    const planned = await planOne(root);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.code).toBe('TASK_DEPENDENCY_UNKNOWN');
  });

  it('refuses a duplicated dependency entry through the real file path', async () => {
    // Pinned at the schema before this slice, and never through a task file.
    const discovered = await probe(taskFile('probe', { dependsOn: ['keep', 'keep'] }));
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_DEFINITION_INVALID');
  });

  it('refuses a self-dependency through the real file path', async () => {
    const discovered = await probe(taskFile('probe', { dependsOn: ['probe'] }));
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_DEFINITION_INVALID');
  });

  it('publishes its failure codes as a closed set, with the new one in it', () => {
    expect([...TASK_DISCOVERY_FAILURE_CODES]).toEqual([
      'TASK_SOURCE_NOT_FOUND',
      'TASK_SOURCE_NOT_DIRECTORY',
      'TASK_SOURCE_PATH_UNSAFE',
      'TASK_SOURCE_READ_FAILED',
      'TASK_SOURCE_EMPTY',
      'TASK_FILE_NAME_INVALID',
      'TASK_FILE_UNSAFE',
      'TASK_FILE_TOO_LARGE',
      'TASK_FILE_READ_FAILED',
      'TASK_FRONTMATTER_MISSING',
      'TASK_FRONTMATTER_MALFORMED',
      'TASK_FRONTMATTER_TOO_LARGE',
      'TASK_FRONTMATTER_FORBIDDEN_KEY',
      'TASK_DEFINITION_INVALID',
      'TASK_DEPENDENCY_CROSS_PROJECT',
      'TASK_ID_FILENAME_MISMATCH',
    ] satisfies readonly TaskDiscoveryFailureCode[]);
  });

  it('carries a static sentence and never the reference it refused', async () => {
    const discovered = await probe(taskFile('probe', { dependsOn: ['beta:auth-1'] }));
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.detail).toContain('repository-local');
    // The refused text, the repository root and the file name are all absent.
    expect(discovered.detail).not.toContain('beta:auth-1');
    expect(discovered.detail).not.toContain(probeRepository?.root ?? '<unset>');
    expect(discovered.detail).not.toContain('.md');
  });

  it('refuses the whole cross-repository plan, and states the policy in the report', async () => {
    // Two facts over one fixture. The second is the one M2 slice 4 added:
    // before it, this report forwarded `planningCode` alone, so the static
    // sentence — which for a dependency refusal IS the policy — was dropped
    // between the planner and the operator, and a code with no sentence names a
    // refusal without explaining it.
    const alpha = makeRepository('alpha', { 'a-1': {} });
    const beta = makeRepository('beta', {});
    writeRawTask(beta, 'b-1', taskFile('b-1', { dependsOn: ['alpha:a-1'] }));

    const plan = await planWritten([alpha, beta]);
    expect(plan.code).toBe('REPOSITORY_UNPLANNABLE');
    expect(plan.planningCode).toBe('TASK_DEPENDENCY_CROSS_PROJECT');
    expect(plan.failedRepositoryRoot).toBe(beta);
    expect(plan.selected).toBe(null);
    expect(plan.planningDetail).toContain('repository-local');

    const text = renderCrossRepositoryPlan(plan);
    expect(text).toContain('TASK_DEPENDENCY_CROSS_PROJECT — ');
    expect(text).toContain('repository-local');
    // Still no host data: the refused reference and the repository path are
    // absent from the sentence the report prints.
    const planningRow = text.split('\n').find((row) => row.startsWith('Planning')) ?? '';
    expect(planningRow).not.toContain('alpha:a-1');
    expect(planningRow).not.toContain(beta);
  });

  it('carries the sentence for an ordinary planning refusal too', async () => {
    // The control: `planningDetail` is not a special case for the new code.
    const alpha = makeRepository('alpha', { 'a-1': {} });
    const beta = makeRepository('beta', { x: { dependsOn: ['y'] }, y: { dependsOn: ['x'] } });
    const plan = await planWritten([alpha, beta]);
    expect(plan.planningCode).toBe('TASK_GRAPH_CYCLE');
    expect(plan.planningDetail).toContain('cycle');
    expect(renderCrossRepositoryPlan(plan)).toContain('TASK_GRAPH_CYCLE — ');
  });

  it('leaves the field null when nothing failed', async () => {
    const alpha = makeRepository('alpha', { 'a-1': {} });
    const plan = await planWritten([alpha]);
    expect(plan.code).toBe('TASK_SELECTED');
    expect(plan.planningCode).toBe(null);
    expect(plan.planningDetail).toBe(null);
    // And the report prints no `Planning` row at all for a plan that worked.
    expect(renderCrossRepositoryPlan(plan).split('\n').some((row) => row.startsWith('Planning'))).toBe(
      false,
    );
  });
});

// ── 5. The report names the work that is waiting ───────────────────────────

describe('the cross-repository report', () => {
  it('names each blocked task and the prerequisite it waits for', async () => {
    const alpha = makeRepository('alpha', {
      gate: { priority: 'LOW' },
      'aaa-high': { priority: 'HIGH', dependsOn: ['gate'] },
    });
    const beta = makeRepository('beta', { 'mmm-normal': {} });
    const text = renderCrossRepositoryPlan(await planWritten([alpha, beta]));

    expect(text).toContain('blocked         : 1');
    expect(text).toContain('- aaa-high  [BLOCKED_BY_DEPENDENCIES; waiting on gate]');
    // And the repository with nothing waiting says so, rather than saying
    // nothing — an absent row reads as "not measured".
    expect(text).toContain('blocked         : 0');
  });

  it('does not report a finished task as blocked', async () => {
    // `ALREADY_DONE` and `BLOCKED_BY_DEPENDENCIES` mean opposite things, and a
    // report that listed both would put that distinction back together.
    const alpha = makeRepository('alpha', { done: { status: 'DONE' }, open: {} });
    const text = renderCrossRepositoryPlan(await planWritten([alpha]));
    expect(text).toContain('blocked         : 0');
    expect(text).not.toContain('- done');
  });

  it('bounds the list and counts what it did not print', async () => {
    const tasks: Record<string, TaskFields> = { gate: {} };
    const blockedCount = MAX_REPORTED_BLOCKED_TASKS + 3;
    for (let index = 0; index < blockedCount; index += 1) {
      tasks[`w${String(index).padStart(2, '0')}`] = { dependsOn: ['gate'] };
    }
    const alpha = makeRepository('alpha', tasks);
    const text = renderCrossRepositoryPlan(await planWritten([alpha]));

    expect(text).toContain(`blocked         : ${blockedCount}`);
    expect(text).toContain(`(and 3 more, not shown)`);
    // Exactly the cap is printed, no more.
    const named = text.split('\n').filter((row) => row.includes('[BLOCKED_BY_DEPENDENCIES'));
    expect(named.length).toBe(MAX_REPORTED_BLOCKED_TASKS);
  });

  it('bounds the prerequisites named on one row, and counts those too', async () => {
    // The other half of the bound, and the one a review had to find: capping
    // the rows without capping the ids on a row is a line-count bound, not a
    // size bound. A task may declare 64 dependencies of up to 128 characters,
    // so one unbounded row could reach kilobytes on its own.
    const tasks: Record<string, TaskFields> = {};
    const prerequisites: string[] = [];
    for (let index = 0; index < MAX_REPORTED_PREREQUISITES + 2; index += 1) {
      const id = `p${String(index).padStart(2, '0')}`;
      tasks[id] = {};
      prerequisites.push(id);
    }
    tasks['waiter'] = { dependsOn: prerequisites };
    const alpha = makeRepository('alpha', tasks);
    const text = renderCrossRepositoryPlan(await planWritten([alpha]));

    const row = text.split('\n').find((line) => line.includes('- waiter')) ?? '';
    expect(row).not.toBe('');
    expect(row).toContain('(+2 more)');
    // Exactly the cap is named, and the ones past it are not.
    for (const id of prerequisites.slice(0, MAX_REPORTED_PREREQUISITES)) {
      expect(row, id).toContain(id);
    }
    for (const id of prerequisites.slice(MAX_REPORTED_PREREQUISITES)) {
      expect(row, id).not.toContain(id);
    }
  });

  it('carries the blocked work out through the registered command surface', async () => {
    const alpha = makeRepository('alpha', {
      gate: { priority: 'LOW' },
      'aaa-high': { priority: 'HIGH', dependsOn: ['gate'] },
    });
    const home = makeHome();
    writeFileSync(home.path, registryFor([alpha]), 'utf8');

    let text = '';
    const program = new Command();
    program.exitOverride();
    registerRepositoriesCommand(program, {
      loadRepositoryRegistry: () => loadRepositoryRegistry(home.provider),
      repositoryRegistryPath: () => home.path,
      write: (value) => {
        text += value;
      },
    });
    await program.parseAsync(['repositories'], { from: 'user' });

    expect(text).toContain('- aaa-high  [BLOCKED_BY_DEPENDENCIES; waiting on gate]');
    expect(text).toContain('Selected');
    expect(text).toContain('gate');
  });
});

// ── 6. What this slice did not do ──────────────────────────────────────────

describe('the slice added no new authority and no second scheduler', () => {
  it('left the ranking tuple exactly as long as it was', () => {
    const graph = graphOf([def('A')]);
    expect(taskRankingKey(eligibilityOf(graph, 'A'), graph).length).toBe(5);
    const key = taskRankingKey(eligibilityOf(graph, 'A'), graph);
    expect(typeof key[4]).toBe('string');
  });

  it('left `run` bound to a repository the operator named', () => {
    // The structural half of "this slice built no scheduler": the one command
    // that acts still takes its subject from the operator, and cannot reach the
    // registry or the merged planner.
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'cli', 'run-command.ts'), 'utf8');
    expect(source).not.toContain('planAcrossRepositories');
    expect(source).not.toContain('repository-registry');
  });

  it('added no concurrency, quota, scheduler or notification concept to any changed module', () => {
    // Every file this slice touched under `src/`, swept for the names of the
    // things the slice declared it was not building. A text sweep rather than an
    // import check, deliberately: a comment mentioning one of these would fail
    // too, which is the right sensitivity for a scope claim.
    const changed = [
      join('src', 'plan', 'discover-tasks.ts'),
      join('src', 'plan', 'select-task.ts'),
      join('src', 'plan', 'plan-across-repositories.ts'),
      join('src', 'cli', 'render-repositories.ts'),
    ];
    for (const relativePath of changed) {
      const text = readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8');
      for (const forbidden of [
        'child_process',
        'setTimeout',
        'setInterval',
        'worker_threads',
        'sendNotification',
        'acquireRepositoryExecutionLease',
      ]) {
        expect(text, `${relativePath} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

});
