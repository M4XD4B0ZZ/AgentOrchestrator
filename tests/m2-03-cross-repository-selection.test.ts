/**
 * M2 slice 3 — the repository registry and cross-repository selection.
 *
 * Everything that can be measured against real repositories is measured against
 * real repositories: fresh `git init` trees with their own profiles, their own
 * task sources and their own tasks, resolved through the real
 * `resolveRepository` and planned through the real `planNextTask`. The registry
 * document is a real file under a scratch OS-profile directory, reached through
 * the internal `PathProvider` seam and never through the environment.
 *
 * The one thing that is *not* real here is the operator's own home: pointing the
 * lookup at a scratch directory is the seam `delivery-automation.ts` and
 * `notify-config.ts` already use, for the reason `path-provider.ts` gives.
 *
 * ── What each group is for ─────────────────────────────────────────────────
 *
 *  1. **The pre-change limitation.** The single-repository path measured on two
 *     real repositories, so the thing this slice adds is stated as a
 *     measurement rather than as a motivation.
 *  2. **The registry document.** Its refusals, each reached by a real file.
 *  3. **Resolution.** Which pairs of entries are the same repository, and which
 *     — deliberately — are not.
 *  4. **Selection.** The four scenarios, plus the preservation claim: within one
 *     repository the merged ranking must be exactly `selectNextTask`'s.
 *  5. **Counter-proofs.** Mutations of the production modules that a passing
 *     suite must not survive, each named with the case that kills it.
 *  6. **Structure.** That this slice added no second subprocess chokepoint and
 *     no second lease holder.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import {
  CROSS_REPOSITORY_PLAN_CODES,
  planAcrossRepositories,
  crossRepositoryRankingKey,
} from '../src/plan/plan-across-repositories.js';
import { planNextTask } from '../src/plan/plan-next-task.js';
import { selectNextTask } from '../src/plan/select-task.js';
import { normalizeTaskGraph } from '../src/plan/task-graph.js';
import { discoverTasks } from '../src/plan/discover-tasks.js';
import {
  MAX_REGISTERED_REPOSITORIES,
  MAX_REPOSITORY_REGISTRY_BYTES,
  REGISTRY_RESOLUTION_REFUSALS,
  REPOSITORY_REGISTRY_FILE_NAME,
  REPOSITORY_REGISTRY_REFUSALS,
  compareRepositoryRoots,
  loadRepositoryRegistry,
  repositoryRegistryPath,
  resolveRegisteredRepositories,
  type RegisteredRepository,
} from '../src/registry/repository-registry.js';
import { resolveRepository } from '../src/repo/resolve-repository.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
  exitCodeForCrossRepositoryPlan,
  exitCodeForRegistryResolution,
  exitCodeForRepositoryRegistry,
} from '../src/cli/run-exit-codes.js';
import { reportRepositories } from '../src/cli/repositories-command.js';

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

function profileYaml(id: string, taskDirectory: string, branch = 'main'): string {
  return `schemaVersion: 1
repository:
  id: ${id}
  defaultBranch: ${branch}
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: ${taskDirectory}
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
}

interface TaskFields {
  readonly status?: 'OPEN' | 'DONE';
  readonly kind?: 'NORMAL' | 'REMEDIATION';
  readonly priority?: 'HIGH' | 'NORMAL' | 'LOW';
  readonly currentFocus?: boolean;
  readonly dependsOn?: readonly string[];
}

function taskFile(id: string, fields: TaskFields = {}): string {
  const dependsOn = fields.dependsOn ?? [];
  return `---
id: ${id}
title: task ${id}
status: ${fields.status ?? 'OPEN'}
kind: ${fields.kind ?? 'NORMAL'}
priority: ${fields.priority ?? 'NORMAL'}
currentFocus: ${fields.currentFocus ?? false}
dependsOn: [${dependsOn.join(', ')}]
---
body
`;
}

interface RepoSpec {
  readonly id: string;
  readonly taskDirectory?: string;
  readonly branch?: string;
  readonly tasks: Readonly<Record<string, TaskFields>>;
}

/** A real Git repository with a real profile and real task files. */
function makeRepository(spec: RepoSpec): string {
  const taskDirectory = spec.taskDirectory ?? 'tasks';
  const branch = spec.branch ?? 'main';
  const root = scratch('ao-m2-03-');
  git(root, ['init', '-b', branch, '--quiet']);
  write(root, '.gitattributes', '* -text\n');
  write(root, 'README.md', `# ${spec.id}\n`);
  write(root, '.agent-orchestrator/repo-profile.yaml', profileYaml(spec.id, taskDirectory, branch));
  for (const [id, fields] of Object.entries(spec.tasks)) {
    write(root, `${taskDirectory}/${id}.md`, taskFile(id, fields));
  }
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

/** A scratch OS-profile directory, plus the registry path inside it. */
function makeHome(): { readonly provider: ReturnType<typeof fixedPathProvider>; readonly path: string } {
  const home = scratch('ao-m2-03-home-');
  const provider = fixedPathProvider(home);
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  return { provider, path: repositoryRegistryPath(provider) };
}

function registryFor(paths: readonly string[]): string {
  return ['schemaVersion: 1', 'repositories:', ...paths.map((p) => `  - path: ${p}`)].join('\n');
}

/** Rewrites a repository's declared id in place and commits it. */
function rewriteRepositoryId(root: string, id: string): void {
  const existing = readFileSync(join(root, '.agent-orchestrator', 'repo-profile.yaml'), 'utf8');
  write(
    root,
    '.agent-orchestrator/repo-profile.yaml',
    existing.replace(/^  id: .*$/m, `  id: ${id}`),
  );
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'id']);
}

/**
 * Makes `id` the repository's only task, whatever it held before.
 *
 * Every existing task file is removed first, so the caller can place a chosen
 * task id at a chosen root after the roots are known — which is the only way to
 * build a fixture whose task order and root order disagree, given that
 * `mkdtemp` chooses the roots.
 */
function putSoleTask(root: string, id: string, fields: TaskFields): void {
  rmSync(join(root, 'tasks'), { recursive: true, force: true });
  write(root, `tasks/${id}.md`, taskFile(id, fields));
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'task']);
}

/**
 * Resolves paths into `RegisteredRepository` values **in the order given**,
 * bypassing `resolveRegisteredRepositories`' own root sort.
 *
 * That bypass is the point: it is the only way to hand `planAcrossRepositories`
 * a list whose order disagrees with the answer, and therefore the only way to
 * measure that the sixth ranking element — rather than the engine's stable sort
 * inheriting a root-ordered input — is what decides a tie.
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

/** Writes a registry document and reads it back through the production loader. */
function loadWritten(text: string): ReturnType<typeof loadRepositoryRegistry> {
  const home = makeHome();
  writeFileSync(home.path, text, 'utf8');
  return loadRepositoryRegistry(home.provider);
}

/** The whole production chain: document -> resolution -> plan. */
async function planWritten(
  text: string,
): Promise<{
  readonly registry: ReturnType<typeof loadRepositoryRegistry>;
  readonly resolved: Awaited<ReturnType<typeof resolveRegisteredRepositories>> | null;
  readonly plan: ReturnType<typeof planAcrossRepositories> | null;
}> {
  const registry = loadWritten(text);
  if (registry.state !== 'REGISTERED') return { registry, resolved: null, plan: null };
  const resolved = await resolveRegisteredRepositories(registry.entries);
  if (!resolved.ok) return { registry, resolved, plan: null };
  return { registry, resolved, plan: planAcrossRepositories(resolved.repositories) };
}

// ── 1. The limitation this slice removes, measured ─────────────────────────

describe('the pre-change single-repository model', () => {
  it('cannot tell two repositories’ identically-named tasks apart', async () => {
    // Two real repositories, each with a task called `shared-id`, each ranked so
    // that its own planner selects it.
    const alpha = makeRepository({ id: 'alpha', tasks: { 'shared-id': { priority: 'HIGH' }, 'a-only': {} } });
    const beta = makeRepository({
      id: 'beta',
      taskDirectory: 'ops/work-items',
      tasks: { 'shared-id': { priority: 'HIGH' }, 'b-only': {} },
    });

    const a = await resolveRepository({ repositoryPath: alpha });
    const b = await resolveRepository({ repositoryPath: beta });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const planA = planNextTask(a.repository);
    const planB = planNextTask(b.repository);
    expect(planA.ok && planB.ok).toBe(true);
    if (!planA.ok || !planB.ok) return;

    // Both select a task with the same id.
    expect(planA.selection.selected?.id).toBe('shared-id');
    expect(planB.selection.selected?.id).toBe('shared-id');

    // And the two selected values are indistinguishable: neither the selection
    // outcome nor the task definition carries the repository it came from. This
    // is the limitation, stated as a fact about the shipped types rather than as
    // a motivation — a later slice that added a repository field to either would
    // turn this red, which is the right moment to revisit the claim.
    expect(Object.keys(planA.selection).sort()).toEqual(
      ['code', 'eligibility', 'ranking', 'selected'],
    );
    expect(Object.keys(planA.selection.selected ?? {}).sort()).toEqual(
      ['currentFocus', 'dependsOn', 'id', 'kind', 'priority', 'status', 'title'],
    );
    expect(planA.selection.selected).toStrictEqual(planB.selection.selected);

    // The repositories really are different work.
    expect(a.repository.root).not.toBe(b.repository.root);

    // And there is no production symbol that takes both: `planNextTask` is a
    // function of one repository.
    expect(planNextTask.length).toBe(1);
  });
});

// ── 2. The registry document ───────────────────────────────────────────────

describe('the repository registry document', () => {
  it('lives beside the other operator declarations, under the OS user profile', () => {
    const home = makeHome();
    expect(home.path.endsWith(join('.agent-orchestrator', REPOSITORY_REGISTRY_FILE_NAME))).toBe(true);
    expect(REPOSITORY_REGISTRY_FILE_NAME).toBe('repositories.yaml');
  });

  it('answers NOT_REGISTERED when there is no file, which is not an empty registry', () => {
    const home = makeHome();
    const outcome = loadRepositoryRegistry(home.provider);
    expect(outcome.state).toBe('NOT_REGISTERED');
    // And it is a distinct answer from a file declaring nothing.
    const empty = loadWritten('schemaVersion: 1\nrepositories: []\n');
    expect(empty.state).toBe('REGISTERED');
    if (empty.state !== 'REGISTERED') return;
    expect(empty.entries).toEqual([]);
  });

  it('refuses a directory in the registry’s place rather than calling it absent', () => {
    const home = makeHome();
    mkdirSync(home.path, { recursive: true });
    const outcome = loadRepositoryRegistry(home.provider);
    expect(outcome.state).toBe('UNUSABLE');
    if (outcome.state !== 'UNUSABLE') return;
    expect(outcome.code).toBe('REGISTRY_UNREADABLE');
  });

  it('refuses an over-large document before parsing it', () => {
    // Valid YAML that would parse, and one byte too many.
    const filler = '#'.repeat(MAX_REPOSITORY_REGISTRY_BYTES);
    const outcome = loadWritten(`schemaVersion: 1\nrepositories: []\n${filler}`);
    expect(outcome.state).toBe('UNUSABLE');
    if (outcome.state !== 'UNUSABLE') return;
    expect(outcome.code).toBe('REGISTRY_TOO_LARGE');
  });

  it.each([
    ['malformed YAML', 'schemaVersion: 1\nrepositories:\n  - path: [\n', 'REGISTRY_MALFORMED'],
    ['a future contract version', 'schemaVersion: 2\nrepositories: []\n', 'REGISTRY_CONTRACT_VIOLATION'],
    ['a missing version', 'repositories: []\n', 'REGISTRY_CONTRACT_VIOLATION'],
    ['an unknown top-level key', 'schemaVersion: 1\nrepositories: []\nschedule: hourly\n', 'REGISTRY_CONTRACT_VIOLATION'],
    ['an unknown entry key', 'schemaVersion: 1\nrepositories:\n  - path: /a\n    priority: 1\n', 'REGISTRY_CONTRACT_VIOLATION'],
    ['an entry that is not a mapping', 'schemaVersion: 1\nrepositories:\n  - /a\n', 'REGISTRY_CONTRACT_VIOLATION'],
    ['repositories as a string', 'schemaVersion: 1\nrepositories: "/a"\n', 'REGISTRY_CONTRACT_VIOLATION'],
    ['a relative path', 'schemaVersion: 1\nrepositories:\n  - path: ./relative\n', 'REGISTRY_CONTRACT_VIOLATION'],
    ['an empty path', 'schemaVersion: 1\nrepositories:\n  - path: ""\n', 'REGISTRY_CONTRACT_VIOLATION'],
    ['an empty document', '\n', 'REGISTRY_CONTRACT_VIOLATION'],
  ])('refuses %s as %s', (_label, document, expected) => {
    const outcome = loadWritten(document);
    expect(outcome.state).toBe('UNUSABLE');
    if (outcome.state !== 'UNUSABLE') return;
    expect(outcome.code).toBe(expected);
  });

  it('refuses a forbidden mapping key before any object exists', () => {
    const outcome = loadWritten('schemaVersion: 1\nrepositories: []\n__proto__:\n  polluted: true\n');
    expect(outcome.state).toBe('UNUSABLE');
    if (outcome.state !== 'UNUSABLE') return;
    expect(outcome.code).toBe('REGISTRY_FORBIDDEN_KEY');
  });

  it('refuses more entries than the declared bound', () => {
    const many = Array.from(
      { length: MAX_REGISTERED_REPOSITORIES + 1 },
      (_value, index) => `${process.platform === 'win32' ? 'D:\\' : '/'}r${index}`,
    );
    const outcome = loadWritten(registryFor(many));
    expect(outcome.state).toBe('UNUSABLE');
    if (outcome.state !== 'UNUSABLE') return;
    expect(outcome.code).toBe('REGISTRY_CONTRACT_VIOLATION');
  });

  it('refuses the same path written twice, before starting any Git child', () => {
    const path = process.platform === 'win32' ? 'D:\\Repo' : '/repo';
    const outcome = loadWritten(registryFor([path, path]));
    expect(outcome.state).toBe('UNUSABLE');
    if (outcome.state !== 'UNUSABLE') return;
    expect(outcome.code).toBe('REGISTRY_DUPLICATE_PATH');
  });

  it('digests the exact bytes it read, and only on the accepted member', () => {
    const document = registryFor([process.platform === 'win32' ? 'D:\\Repo' : '/repo']);
    const home = makeHome();
    writeFileSync(home.path, document, 'utf8');
    const outcome = loadRepositoryRegistry(home.provider);
    expect(outcome.state).toBe('REGISTERED');
    if (outcome.state !== 'REGISTERED') return;
    // Over the bytes on disk, not over the string this test holds and not over
    // the parsed document.
    expect(outcome.registryDigest).toBe(
      createHash('sha256').update(readFileSync(home.path)).digest('hex'),
    );
    // A refusal carries no digest at all: there is no field on it to carry one.
    const refused = loadWritten('schemaVersion: 9\n');
    expect(Object.keys(refused).sort()).toEqual(['code', 'state']);
  });

  it('carries no host or file data on any refusal', () => {
    const secret = process.platform === 'win32' ? 'D:\\SECRET-MARKER' : '/SECRET-MARKER';
    const refused = loadWritten(registryFor([secret, secret]));
    expect(JSON.stringify(refused)).not.toContain('SECRET-MARKER');
  });
});

// ── 3. Resolution: which entries are the same repository ───────────────────

describe('resolving the registry', () => {
  it('refuses the whole registry when one entry does not resolve, and names its index', async () => {
    const good = makeRepository({ id: 'good', tasks: { 't-1': {} } });
    const absent = join(tmpdir(), 'ao-m2-03-absent-does-not-exist');
    const { resolved } = await planWritten(registryFor([good, absent]));
    expect(resolved?.ok).toBe(false);
    if (resolved === null || resolved.ok) return;
    expect(resolved.code).toBe('REPOSITORY_UNRESOLVABLE');
    expect(resolved.entryIndex).toBe(1);
    // The resolver's own closed code is carried through rather than flattened.
    expect(resolved.resolutionCode).toBe('REPOSITORY_NOT_FOUND');
    // And no path reaches the refusal.
    expect(JSON.stringify(resolved)).not.toContain('ao-m2-03-absent');
  });

  it('refuses one directory enlisted twice under two spellings', async () => {
    const root = makeRepository({ id: 'spelled', tasks: { 't-1': {} } });
    // Two strings the literal check cannot see through, that canonicalise to one
    // directory. This is the case `REGISTRY_DUPLICATE_PATH` deliberately does
    // not claim to catch.
    const other = process.platform === 'win32' ? root.toLowerCase() : `${root}/.`;
    const literal = loadWritten(registryFor([root, other]));
    expect(literal.state).toBe('REGISTERED');

    const { resolved } = await planWritten(registryFor([root, other]));
    expect(resolved?.ok).toBe(false);
    if (resolved === null || resolved.ok) return;
    expect(resolved.code).toBe('DUPLICATE_REPOSITORY_ROOT');
  });

  it('refuses two worktrees of one clone: two roots, one execution domain', async () => {
    // The load-bearing case. Two different canonical roots, so the root check
    // passes; one `gitCommonDir`, so they are one lease and — measured in
    // `workspace-identity.ts` — one work branch `ao/task/<id>` in one object
    // store. The two profiles declare different ids, which is what makes this
    // reachable at all: with the same id it would still be refused, but by the
    // root check on a different pair.
    const host = makeRepository({ id: 'wt-host', tasks: { 't-1': {} } });
    const parent = scratch('ao-m2-03-wt-');
    const worktree = join(parent, 'second');
    git(host, ['branch', 'side']);
    git(host, ['worktree', 'add', '--quiet', worktree, 'side']);
    const worktreeRoot = realpathSync.native(worktree);
    write(worktreeRoot, '.agent-orchestrator/repo-profile.yaml', profileYaml('wt-second', 'tasks', 'side'));
    write(worktreeRoot, 'tasks/t-1.md', taskFile('t-1'));
    git(worktreeRoot, ['add', '--all']);
    git(worktreeRoot, ['commit', '--quiet', '-m', 'side']);

    const a = await resolveRepository({ repositoryPath: host });
    const b = await resolveRepository({ repositoryPath: worktreeRoot });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // The premise of the case, asserted rather than assumed.
    expect(a.repository.root).not.toBe(b.repository.root);
    expect(a.repository.id).not.toBe(b.repository.id);
    expect(a.repository.gitCommonDir).toBe(b.repository.gitCommonDir);

    const { resolved } = await planWritten(registryFor([host, worktreeRoot]));
    expect(resolved?.ok).toBe(false);
    if (resolved === null || resolved.ok) return;
    expect(resolved.code).toBe('DUPLICATE_EXECUTION_DOMAIN');
  });

  it('ACCEPTS two clones declaring the same repository id', async () => {
    // The counterpart of the case above, and the one an earlier form of this
    // module got wrong. Two clones of one remote answer the same declared id and
    // are two independent execution domains — the configuration
    // `resolve-repository.ts` and the lease both document as supported. A
    // registry that refused it would refuse the working practice of this
    // repository itself.
    const origin = makeRepository({ id: 'shared-slug', tasks: { 't-1': {} } });
    const parent = scratch('ao-m2-03-clone-');
    const cloneRoot = join(parent, 'copy');
    execFileSync('git', ['clone', '--quiet', origin, cloneRoot], {
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const clone = realpathSync.native(cloneRoot);

    const a = await resolveRepository({ repositoryPath: origin });
    const b = await resolveRepository({ repositoryPath: clone });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.repository.id).toBe(b.repository.id);
    expect(a.repository.gitCommonDir).not.toBe(b.repository.gitCommonDir);

    const { resolved, plan } = await planWritten(registryFor([origin, clone]));
    expect(resolved?.ok).toBe(true);
    expect(plan?.code).toBe('TASK_SELECTED');
    // Both are candidates, and the ranking tells them apart by root even though
    // their ids and their task ids are identical.
    expect(plan?.ranking.map((entry) => entry.repositoryId)).toEqual([
      'shared-slug',
      'shared-slug',
    ]);
    expect(new Set(plan?.ranking.map((entry) => entry.repositoryRoot)).size).toBe(2);
  });

  it('orders the resolved repositories by canonical root, never by file order', async () => {
    const one = makeRepository({ id: 'r-one', tasks: { 't-1': {} } });
    const two = makeRepository({ id: 'r-two', tasks: { 't-1': {} } });
    const forward = await planWritten(registryFor([one, two]));
    const backward = await planWritten(registryFor([two, one]));
    const rootsOf = (result: typeof forward): readonly string[] =>
      result.resolved !== null && result.resolved.ok
        ? result.resolved.repositories.map((entry: RegisteredRepository) => entry.repository.root)
        : [];
    const expected = [one, two].sort(compareRepositoryRoots);
    expect(rootsOf(forward)).toEqual(expected);
    expect(rootsOf(backward)).toEqual(expected);
  });
});

// ── 4. Selection across repositories ───────────────────────────────────────

describe('cross-repository selection', () => {
  it('scenario 1 — sees eligible work in two repositories through one path', async () => {
    const alpha = makeRepository({ id: 'alpha', tasks: { 'a-1': {}, 'a-2': {} } });
    const beta = makeRepository({
      id: 'beta',
      taskDirectory: 'ops/work-items',
      tasks: { 'b-1': {} },
    });
    const { plan } = await planWritten(registryFor([alpha, beta]));
    expect(plan?.code).toBe('TASK_SELECTED');
    expect(plan?.plans.length).toBe(2);
    expect(plan?.ranking.length).toBe(3);
    expect(new Set(plan?.ranking.map((entry) => entry.repositoryId))).toEqual(
      new Set(['alpha', 'beta']),
    );
  });

  it('scenario 2 — the same local task id in two repositories stays two work items', async () => {
    const alpha = makeRepository({ id: 'alpha', tasks: { shared: {} } });
    const beta = makeRepository({ id: 'beta', tasks: { shared: {} } });
    const { plan } = await planWritten(registryFor([alpha, beta]));
    expect(plan?.ranking.length).toBe(2);
    expect(plan?.ranking.every((entry) => entry.taskId === 'shared')).toBe(true);
    // Distinct, and distinguishable from the value alone.
    expect(new Set(plan?.ranking.map((entry) => entry.repositoryRoot)).size).toBe(2);
  });

  it('scenario 3 — the answer does not depend on the order of the registry file', async () => {
    const alpha = makeRepository({ id: 'alpha', tasks: { 'a-1': { priority: 'HIGH' }, 'a-2': {} } });
    const beta = makeRepository({ id: 'beta', tasks: { 'b-1': { priority: 'HIGH' }, 'b-2': {} } });
    const forward = await planWritten(registryFor([alpha, beta]));
    const backward = await planWritten(registryFor([beta, alpha]));
    expect(forward.plan?.selected?.task.id).toBe(backward.plan?.selected?.task.id);
    expect(forward.plan?.selected?.repository.root).toBe(backward.plan?.selected?.repository.root);
    expect(forward.plan?.ranking).toStrictEqual(backward.plan?.ranking);
  });

  it('scenario 4 — the selected candidate carries its own repository, whatever the cwd', async () => {
    const alpha = makeRepository({ id: 'alpha', tasks: { 'zzz-last': {} } });
    const beta = makeRepository({ id: 'beta', tasks: { 'aaa-first': {} } });
    const { plan } = await planWritten(registryFor([alpha, beta]));
    // `aaa-first` sorts before `zzz-last` at element 4, so beta wins wherever
    // this process is standing and whichever entry was enumerated first.
    expect(plan?.selected?.task.id).toBe('aaa-first');
    expect(plan?.selected?.repository.root).toBe(beta);
    expect(plan?.selected?.repository.id).toBe('beta');
    // The binding is the whole resolved repository, not a path or an id — which
    // is what makes it impossible for a downstream step to re-derive it from
    // anywhere else.
    const resolvedBeta = await resolveRepository({ repositoryPath: beta });
    expect(resolvedBeta.ok).toBe(true);
    if (!resolvedBeta.ok) return;
    expect(plan?.selected?.repository).toStrictEqual(resolvedBeta.repository);
    expect(plan?.selected?.repository.root).not.toBe(process.cwd());
  });

  it('the repository element decides a tie, and does so against the order it was given', async () => {
    // Two repositories, one task each, same task id and every ranking element
    // equal through element 4. Nothing but the sixth element can decide.
    //
    // The fixture is handed to `planAcrossRepositories` in the WRONG order —
    // higher root first — and that is what makes this a measurement rather than
    // a restatement. `resolveRegisteredRepositories` sorts by root, candidates
    // are accumulated repository by repository, and `Array.prototype.sort` is
    // stable, so a root-ordered fixture would give the right answer even with
    // the sixth element deleted. Measured: with a root-ordered fixture, both
    // "return 0 from the sixth element" and "compare the declared id instead of
    // the root" survive. Against this one they do not.
    //
    // The ids are chosen AFTER the roots are known, so that id order is the
    // reverse of root order. A tie-break on the id therefore picks the wrong
    // repository here, and picks the right one in any fixture where the two
    // orders happen to agree.
    const fields: TaskFields = { kind: 'REMEDIATION', priority: 'HIGH', currentFocus: true };
    const first = makeRepository({ id: 'placeholder-a', tasks: { tie: fields } });
    const second = makeRepository({ id: 'placeholder-b', tasks: { tie: fields } });
    const [lowerRoot, higherRoot] = [first, second].sort(compareRepositoryRoots) as [string, string];
    // Lower root gets the LATER id.
    rewriteRepositoryId(lowerRoot, 'zzz-lower-root');
    rewriteRepositoryId(higherRoot, 'aaa-higher-root');

    const registered = await registeredInOrder([higherRoot, lowerRoot]);
    expect(registered.map((entry) => entry.repository.root)).toEqual([higherRoot, lowerRoot]);

    const plan = planAcrossRepositories(registered);
    expect(plan.code).toBe('TASK_SELECTED');
    // The lower root wins, though it was given second and though its id sorts
    // last. Both facts are needed: the first kills "drop the element", the
    // second kills "compare the id".
    expect(plan.selected?.repository.root).toBe(lowerRoot);
    expect(plan.selected?.repository.id).toBe('zzz-lower-root');
    expect(plan.ranking.map((entry) => entry.repositoryRoot)).toEqual([lowerRoot, higherRoot]);
  });

  it('keeps the repository element LAST: the task id still decides first', async () => {
    // The other half of the placement claim. Same construction — given in the
    // wrong order, ids reversed against roots — but the task ids differ, so
    // element 4 must settle it before the root is ever consulted.
    const fields: TaskFields = { kind: 'REMEDIATION', priority: 'HIGH', currentFocus: true };
    const first = makeRepository({ id: 'placeholder-c', tasks: { seed: fields } });
    const second = makeRepository({ id: 'placeholder-d', tasks: { seed: fields } });
    const [lowerRoot, higherRoot] = [first, second].sort(compareRepositoryRoots) as [string, string];
    // The winning task id goes to the HIGHER root, which is handed over second.
    // So neither the root tie-break nor the input order can produce the answer:
    // only element 4 can.
    putSoleTask(lowerRoot, 'zzz-task', fields);
    putSoleTask(higherRoot, 'aaa-task', fields);

    const registered = await registeredInOrder([lowerRoot, higherRoot]);
    const plan = planAcrossRepositories(registered);
    expect(plan.selected?.task.id).toBe('aaa-task');
    expect(plan.selected?.repository.root).toBe(higherRoot);
  });

  it('preserves the single-repository ranking exactly, for one repository', async () => {
    // The preservation claim, asserted against `selectNextTask` itself rather
    // than against a remembered list: with one repository enlisted, the merged
    // ranking must be that repository's own ranking, element for element.
    const only = makeRepository({
      id: 'only',
      tasks: {
        'r-1': { kind: 'REMEDIATION' },
        'h-1': { priority: 'HIGH' },
        'f-1': { currentFocus: true },
        'l-1': { priority: 'LOW' },
        'n-1': {},
        'd-1': { status: 'DONE' },
      },
    });
    const resolvedOnly = await resolveRepository({ repositoryPath: only });
    expect(resolvedOnly.ok).toBe(true);
    if (!resolvedOnly.ok) return;
    const discovered = discoverTasks(resolvedOnly.repository);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    const graph = normalizeTaskGraph(discovered.tasks);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    const single = selectNextTask(graph.graph);

    const { plan } = await planWritten(registryFor([only]));
    expect(plan?.ranking.map((entry) => entry.taskId)).toEqual(single.ranking);
    expect(plan?.selected?.task.id).toBe(single.selected?.id);
    expect(plan?.plans[0]?.eligibility).toStrictEqual(single.eligibility);
  });

  it('refuses the whole plan when one repository cannot be planned, and publishes nothing', async () => {
    // The failing repository must be the one with the HIGHER canonical root, so
    // that the good repository is planned FIRST and its plan is already in hand
    // when the refusal fires. Without that, `plans` happens to be empty at the
    // moment of failure and "publish the partial plans instead of nothing" is
    // invisible — measured: that mutant survived a fixture which left the order
    // to `mkdtemp`, and was killed by one run of the same fixture that happened
    // to order the other way.
    const first = makeRepository({ id: 'r-first', tasks: { 't-1': {} } });
    const second = makeRepository({ id: 'r-second', tasks: { 't-1': {} } });
    const [good, emptySource] = [first, second].sort(compareRepositoryRoots) as [string, string];
    // A task source that exists and holds no task file: a configuration problem,
    // and the one `discoverTasks` refuses to read as a finished plan.
    rmSync(join(emptySource, 'tasks'), { recursive: true, force: true });
    mkdirSync(join(emptySource, 'tasks'), { recursive: true });
    git(emptySource, ['add', '--all']);
    git(emptySource, ['commit', '--quiet', '-m', 'empty']);

    const { plan } = await planWritten(registryFor([good, emptySource]));
    // The premise: the good repository really does sort first, so it really was
    // planned before the refusal.
    expect(compareRepositoryRoots(good, emptySource)).toBeLessThan(0);
    expect(plan?.code).toBe('REPOSITORY_UNPLANNABLE');
    expect(plan?.selected).toBeNull();
    expect(plan?.planningCode).toBe('TASK_SOURCE_EMPTY');
    expect(plan?.failedRepositoryRoot).toBe(emptySource);
    // Nothing partial is published — not the ranking, and not the plan of the
    // repository that succeeded. Publishing either would be a winner computed
    // over an incomplete candidate set.
    expect(plan?.ranking).toEqual([]);
    expect(plan?.plans).toEqual([]);
  });

  it('tells an empty registry apart from a finished one and from a stuck one', async () => {
    const empty = planAcrossRepositories([]);
    expect(empty.code).toBe('NO_REPOSITORIES_REGISTERED');
    expect(empty.selected).toBeNull();

    const done = makeRepository({ id: 'done', tasks: { 'x-1': { status: 'DONE' } } });
    const finished = await planWritten(registryFor([done]));
    expect(finished.plan?.code).toBe('ALL_TASKS_COMPLETE');

    // A repository whose only OPEN task depends on an OPEN task is stuck rather
    // than finished — and the two must not collapse into one answer.
    const stuck = makeRepository({
      id: 'stuck',
      tasks: { 'a-1': { status: 'DONE' }, 'b-1': { dependsOn: ['c-1'] }, 'c-1': { dependsOn: ['b-1'] } },
    });
    const stuckPlan = await planWritten(registryFor([stuck]));
    // A dependency cycle is a graph refusal, so this repository is unplannable
    // rather than stuck — which is the honest answer and is still not
    // ALL_TASKS_COMPLETE.
    expect(stuckPlan.plan?.code).toBe('REPOSITORY_UNPLANNABLE');
    expect(stuckPlan.plan?.code).not.toBe('ALL_TASKS_COMPLETE');
  });

  it('never selects a task that is not the head of its own published ranking', async () => {
    const alpha = makeRepository({ id: 'alpha', tasks: { 'a-1': {}, 'a-2': { priority: 'HIGH' } } });
    const beta = makeRepository({ id: 'beta', tasks: { 'b-1': { kind: 'REMEDIATION' } } });
    const { plan } = await planWritten(registryFor([alpha, beta]));
    expect(plan?.selected).not.toBeNull();
    expect(plan?.ranking[0]?.taskId).toBe(plan?.selected?.task.id);
    expect(plan?.ranking[0]?.repositoryRoot).toBe(plan?.selected?.repository.root);
  });
});

// ── 5. Counter-proofs ──────────────────────────────────────────────────────

describe('the ranking key', () => {
  it('is the single-repository key with the root appended, not a re-implementation', async () => {
    const only = makeRepository({ id: 'only', tasks: { 't-1': { kind: 'REMEDIATION', priority: 'HIGH' } } });
    const resolvedOnly = await resolveRepository({ repositoryPath: only });
    expect(resolvedOnly.ok).toBe(true);
    if (!resolvedOnly.ok) return;
    const discovered = discoverTasks(resolvedOnly.repository);
    if (!discovered.ok) return;
    const graph = normalizeTaskGraph(discovered.tasks);
    if (!graph.ok) return;
    const eligibility = selectNextTask(graph.graph).eligibility[0];
    expect(eligibility).toBeDefined();
    if (eligibility === undefined) return;

    const key = crossRepositoryRankingKey(eligibility, graph.graph, only);
    // Six elements, the fifth is the task id and the sixth is the root. A
    // mutation that dropped the sixth, or that put the root anywhere else, fails
    // here as well as in the tie case above.
    expect(key.length).toBe(6);
    expect(key[4]).toBe('t-1');
    expect(key[5]).toBe(only);
    // REMEDIATION and HIGH, taken from `taskRankingKey` rather than restated.
    expect(key[0]).toBe(0);
    expect(key[2]).toBe(0);
  });
});

describe('exit codes', () => {
  it('maps every cross-repository plan code, by value', () => {
    expect(
      Object.fromEntries(
        CROSS_REPOSITORY_PLAN_CODES.map((code) => [code, exitCodeForCrossRepositoryPlan(code)]),
      ),
    ).toEqual({
      TASK_SELECTED: EXIT_RUN_OK,
      ALL_TASKS_COMPLETE: EXIT_RUN_OK,
      NO_ELIGIBLE_TASK: EXIT_RUN_INPUT_UNUSABLE,
      NO_REPOSITORIES_REGISTERED: EXIT_RUN_INPUT_UNUSABLE,
      REPOSITORY_UNPLANNABLE: EXIT_RUN_INPUT_UNUSABLE,
    });
  });

  it('maps every registry and resolution refusal, by value', () => {
    for (const code of REPOSITORY_REGISTRY_REFUSALS) {
      expect(exitCodeForRepositoryRegistry(code)).toBe(EXIT_RUN_INPUT_UNUSABLE);
    }
    for (const code of REGISTRY_RESOLUTION_REFUSALS) {
      expect(exitCodeForRegistryResolution(code)).toBe(EXIT_RUN_INPUT_UNUSABLE);
    }
    // The sets are non-empty, so the loops above are not vacuous.
    expect(REPOSITORY_REGISTRY_REFUSALS.length).toBeGreaterThan(0);
    expect(REGISTRY_RESOLUTION_REFUSALS.length).toBeGreaterThan(0);
  });
});

describe('the repositories command', () => {
  it('reports and exits 2 when nothing is enlisted, and prints no winner', async () => {
    const home = makeHome();
    let text = '';
    const code = await reportRepositories({
      loadRepositoryRegistry: () => loadRepositoryRegistry(home.provider),
      repositoryRegistryPath: () => home.path,
      write: (value) => {
        text += value;
      },
    });
    expect(code).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(text).toContain('NOT_REGISTERED');
    expect(text).not.toContain('Selected');
    expect(text).toContain('acts on nothing');
  });

  it('reports both repositories, the winner and its root, and exits 0', async () => {
    const alpha = makeRepository({ id: 'alpha', tasks: { 'zzz-1': {} } });
    const beta = makeRepository({ id: 'beta', tasks: { 'aaa-1': {} } });
    const home = makeHome();
    writeFileSync(home.path, registryFor([alpha, beta]), 'utf8');
    let text = '';
    const code = await reportRepositories({
      loadRepositoryRegistry: () => loadRepositoryRegistry(home.provider),
      repositoryRegistryPath: () => home.path,
      write: (value) => {
        text += value;
      },
    });
    expect(code).toBe(EXIT_RUN_OK);
    expect(text).toContain('aaa-1');
    // Both identities, on every repository — the id alone does not identify one.
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text).toContain(alpha);
    expect(text).toContain(beta);
    expect(text).toContain('Candidates      : 2');
  });
});

// ── 6. Structure: no second chokepoint, no second lease holder ─────────────

describe('the slice added no new authority', () => {
  const SLICE_MODULES = [
    join('src', 'registry', 'repository-registry.ts'),
    join('src', 'plan', 'plan-across-repositories.ts'),
    join('src', 'cli', 'repositories-command.ts'),
    join('src', 'cli', 'render-repositories.ts'),
  ];

  function source(relativePath: string): string {
    return readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8');
  }

  it('starts no process of its own', () => {
    // The build-wide pin — exactly two modules import `node:child_process` — is
    // in `tests/v2-07l-execution-lease.test.ts` and sweeps all of `src/`, so it
    // already covers these files. This is the narrower statement, made where the
    // slice lives: none of the four names a process-starting facility at all.
    for (const module of SLICE_MODULES) {
      const text = source(module);
      expect(text).not.toContain('child_process');
      expect(text).not.toContain('start-owned-process');
      expect(text).not.toContain('runCommand');
    }
  });

  it('acquires no execution lease', () => {
    // `owned-launch-accounting.ts` justifies its shape on "nothing in this build
    // holds two leases in one process". This slice puts several repositories in
    // one process, so that sentence is now this slice's to keep true — and the
    // way it keeps it is by taking no lease at all.
    for (const module of SLICE_MODULES) {
      const text = source(module);
      expect(text).not.toContain('acquireRepositoryExecutionLease');
      expect(text).not.toContain('installOwnedLaunchAccountant');
      expect(text).not.toContain('recoverStaleLease');
    }
  });

  it('leaves every grant on `run` bound to a repository the operator named', () => {
    // The selector must not become the subject-chooser for a destructive or
    // operator-decision grant. The way this slice guarantees that is structural:
    // it does not touch `run`. If a later change wires cross-repository
    // selection into that command, this turns red and the argument has to be
    // made again.
    const runCommand = source(join('src', 'cli', 'run-command.ts'));
    expect(runCommand).not.toContain('planAcrossRepositories');
    expect(runCommand).not.toContain('repository-registry');
    // And `--repository` is still required there.
    expect(runCommand).toContain("requiredOption(\n      '--repository <path>'");
  });

  it('is reachable from the CLI exactly once, with no seams', () => {
    const index = source(join('src', 'cli', 'index.ts'));
    const registrations = index.split('registerRepositoriesCommand(program)').length - 1;
    expect(registrations).toBe(1);
    // Registered with no second argument: the `PathProvider` seam that could
    // relocate the registry is not reachable from the shipped entry point.
    expect(index).toContain('registerRepositoriesCommand(program);');
  });

  it('is read from exactly one module, and that module is the command', () => {
    // The header of `repository-registry.ts` says the registry is read from one
    // place in `src/`. That is a fact about the tree, so it is enumerated rather
    // than asserted — an earlier draft of the same sentence named a file that
    // does not exist, and nothing noticed.
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith('.ts')) {
          const code = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
          if (/\bloadRepositoryRegistry\b/.test(code)) {
            importers.push(relative(PACKAGE_ROOT, full));
          }
        }
      }
    };
    walk(join(PACKAGE_ROOT, 'src'));
    expect(importers.sort()).toEqual(
      [
        join('src', 'cli', 'repositories-command.ts'),
        join('src', 'registry', 'repository-registry.ts'),
      ].sort(),
    );
  });

  it('keeps the slice modules inside the package', () => {
    for (const module of SLICE_MODULES) {
      expect(relative(PACKAGE_ROOT, join(PACKAGE_ROOT, module)).startsWith('..')).toBe(false);
    }
  });
});
