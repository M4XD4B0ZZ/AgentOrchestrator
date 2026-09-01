/**
 * Task discovery: reading a repository's `MARKDOWN_DIRECTORY` task source.
 *
 * Everything here runs against **real, throwaway Git repositories** with real
 * profiles, resolved through the real `resolveRepository`. Nothing is stubbed,
 * because the properties under test are filesystem properties: that the source
 * directory is located from the canonical repository root and never from
 * `process.cwd()`, that a link out of the repository is refused rather than
 * followed, that discovery does not recurse, and that an empty directory is
 * reported as an empty directory rather than as finished work.
 *
 * Two fixtures that disagree on every policy — including where their tasks live
 * — are the evidence that none of this is specific to one repository.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  TASK_DISCOVERY_FAILURE_CODES,
  discoverTasks,
} from '../src/plan/discover-tasks.js';
import { planNextTask } from '../src/plan/plan-next-task.js';
import { resolveRepository, type ResolvedRepository } from '../src/repo/resolve-repository.js';
import {
  FIXTURE_A_PROFILE,
  FIXTURE_B_PROFILE,
  createRepoFixture,
  removeRepoFixtures,
} from './helpers/repo-fixtures.js';

afterAll(() => {
  removeRepoFixtures();
});

interface TaskFields {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly kind?: string;
  readonly priority?: string;
  readonly currentFocus?: boolean;
  readonly dependsOn?: readonly string[];
  readonly body?: string;
}

/** A canonical, well-formed task file. */
function taskFile(fields: TaskFields): string {
  const dependsOn = fields.dependsOn ?? [];
  const lines = [
    '---',
    `id: ${fields.id}`,
    `title: ${fields.title ?? `Task ${fields.id}`}`,
    `status: ${fields.status ?? 'OPEN'}`,
    `kind: ${fields.kind ?? 'NORMAL'}`,
    `priority: ${fields.priority ?? 'NORMAL'}`,
    `currentFocus: ${fields.currentFocus ?? false}`,
    dependsOn.length === 0 ? 'dependsOn: []' : 'dependsOn:',
    ...dependsOn.map((id) => `  - ${id}`),
    '---',
    '',
    fields.body ?? 'Human-readable description.',
    '',
  ];
  return lines.join('\n');
}

/** Resolves a fixture repository, requiring success. */
async function resolved(root: string): Promise<ResolvedRepository> {
  const result = await resolveRepository({ repositoryPath: root });
  if (!result.ok) throw new Error(`fixture did not resolve: ${result.code}`);
  return result.repository;
}

/** A fixture whose task source is `tasks/`, pre-populated. */
async function fixtureWithTasks(
  files: Readonly<Record<string, string>>,
): Promise<ResolvedRepository> {
  const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE, files });
  return resolved(root);
}

describe('discovery: the happy path', () => {
  it('reads every task file in the declared directory', async () => {
    const repository = await fixtureWithTasks({
      'tasks/V1-01.md': taskFile({ id: 'V1-01', status: 'DONE' }),
      'tasks/V1-02.md': taskFile({ id: 'V1-02', dependsOn: ['V1-01'] }),
    });

    const result = discoverTasks(repository);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks.map((task) => task.id)).toEqual(['V1-01', 'V1-02']);
    expect(result.tasks[1]?.dependsOn).toEqual(['V1-01']);
  });

  it('returns tasks in canonical id order, not in directory order', async () => {
    const repository = await fixtureWithTasks({
      'tasks/zeta.md': taskFile({ id: 'zeta' }),
      'tasks/alpha.md': taskFile({ id: 'alpha' }),
      'tasks/Beta.md': taskFile({ id: 'Beta' }),
    });

    const result = discoverTasks(repository);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks.map((task) => task.id)).toEqual(['Beta', 'alpha', 'zeta']);
  });

  it('ignores entries that are not lowercase .md files', async () => {
    const repository = await fixtureWithTasks({
      'tasks/V1-01.md': taskFile({ id: 'V1-01' }),
      'tasks/notes.txt': 'not a task',
      'tasks/README': 'not a task either',
      'tasks/archive.md.bak': 'not a task either',
    });

    const result = discoverTasks(repository);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks.map((task) => task.id)).toEqual(['V1-01']);
  });

  it('does not recurse into subdirectories', async () => {
    const repository = await fixtureWithTasks({
      'tasks/V1-01.md': taskFile({ id: 'V1-01' }),
      'tasks/archive/V0-99.md': taskFile({ id: 'V0-99' }),
      'tasks/archive/deeper/V0-98.md': taskFile({ id: 'V0-98' }),
    });

    const result = discoverTasks(repository);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks.map((task) => task.id)).toEqual(['V1-01']);
  });

  it('reads the markdown body without letting it say anything', async () => {
    const repository = await fixtureWithTasks({
      'tasks/A.md': taskFile({
        id: 'A',
        priority: 'LOW',
        body: [
          '## Depends on B and C',
          '',
          '- [ ] priority: HIGH',
          '- currentFocus: true',
          '',
          'dependsOn: [B, C]',
        ].join('\n'),
      }),
    });

    const result = discoverTasks(repository);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks[0]).toEqual({
      id: 'A',
      title: 'Task A',
      status: 'OPEN',
      kind: 'NORMAL',
      priority: 'LOW',
      currentFocus: false,
      dependsOn: [],
    });
  });
});

describe('discovery: the task source itself', () => {
  it('publishes its failure codes as a closed set', () => {
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
      // M2 slice 4. A narrowing of the code above it, never a new admission:
      // it is reported only on the branch where the contract has already
      // refused the document. See
      // `tests/m2-04-dependencies-and-priorities.test.ts` for the case that
      // pins it does not fire for an ordinary contract violation.
      'TASK_DEPENDENCY_CROSS_PROJECT',
      'TASK_ID_FILENAME_MISMATCH',
    ]);
  });

  it('refuses a declared task source that does not exist', async () => {
    const repository = await fixtureWithTasks({});
    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_SOURCE_NOT_FOUND');
  });

  it('refuses a task source that is a file', async () => {
    const repository = await fixtureWithTasks({ tasks: 'I am not a directory' });
    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_SOURCE_NOT_DIRECTORY');
  });

  it('reports an empty task source as empty, never as finished work', async () => {
    const repository = await fixtureWithTasks({ 'tasks/.gitkeep': '' });
    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_SOURCE_EMPTY');
  });

  it('refuses a task source that is a link out of the repository', async () => {
    const elsewhere = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'tasks/V1-01.md': taskFile({ id: 'V1-01' }) },
    });
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    try {
      symlinkSync(join(elsewhere, 'tasks'), join(root, 'tasks'), 'junction');
    } catch {
      // Link creation is privileged on some hosts. The check it exercises is
      // unconditional in the product; only this probe is not.
      return;
    }

    const result = discoverTasks(await resolved(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_SOURCE_PATH_UNSAFE');
  });

  it('refuses a task file that is a link out of the repository', async () => {
    const elsewhere = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'tasks/V1-01.md': taskFile({ id: 'V1-01' }) },
    });
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'tasks/V1-02.md': taskFile({ id: 'V1-02' }) },
    });

    try {
      symlinkSync(join(elsewhere, 'tasks', 'V1-01.md'), join(root, 'tasks', 'V1-01.md'), 'file');
    } catch {
      return;
    }

    const result = discoverTasks(await resolved(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FILE_UNSAFE');
  });

  it('refuses a directory that merely ends in .md', async () => {
    const repository = await fixtureWithTasks({ 'tasks/V1-01.md': taskFile({ id: 'V1-01' }) });
    mkdirSync(join(repository.root, 'tasks', 'V1-02.md'), { recursive: true });

    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FILE_UNSAFE');
  });
});

describe('discovery: one file, one id', () => {
  it('refuses a .md filename that is not a legal task id', async () => {
    const repository = await fixtureWithTasks({ 'tasks/V1-01.md': taskFile({ id: 'V1-01' }) });
    writeFileSync(join(repository.root, 'tasks', 'a task.md'), taskFile({ id: 'A' }), 'utf8');

    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FILE_NAME_INVALID');
    expect(result.taskId).toBeNull();
  });

  it('refuses frontmatter whose id disagrees with the filename', async () => {
    const repository = await fixtureWithTasks({
      'tasks/V1-02.md': taskFile({ id: 'V1-03' }),
    });

    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_ID_FILENAME_MISMATCH');
    expect(result.taskId).toBe('V1-02');
  });

  it('refuses a mismatch that differs only in case', async () => {
    const repository = await fixtureWithTasks({ 'tasks/V1-02.md': taskFile({ id: 'v1-02' }) });
    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_ID_FILENAME_MISMATCH');
  });
});

describe('discovery: hostile task files', () => {
  async function withTaskFile(contents: string): Promise<ReturnType<typeof discoverTasks>> {
    const repository = await fixtureWithTasks({ 'tasks/A.md': contents });
    return discoverTasks(repository);
  }

  it('refuses a task file with no frontmatter', async () => {
    const result = await withTaskFile('# Just prose\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FRONTMATTER_MISSING');
    expect(result.taskId).toBe('A');
  });

  it('refuses malformed frontmatter', async () => {
    const result = await withTaskFile('---\nid: [A\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FRONTMATTER_MALFORMED');
  });

  it('refuses a custom YAML tag', async () => {
    const result = await withTaskFile('---\nid: !!python/object:os.system A\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FRONTMATTER_MALFORMED');
  });

  it('refuses a __proto__ key, and reports how many there were', async () => {
    const result = await withTaskFile('---\nid: A\n__proto__:\n  polluted: true\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FRONTMATTER_FORBIDDEN_KEY');
    expect(result.issueCount).toBe(1);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses oversized frontmatter before validating it', async () => {
    const result = await withTaskFile(`---\n${'k: v\n'.repeat(4000)}---\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FRONTMATTER_TOO_LARGE');
  });

  it('refuses an oversized file before reading it', async () => {
    const result = await withTaskFile(`---\nid: A\n---\n${'x'.repeat(300_000)}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FILE_TOO_LARGE');
  });

  it('refuses frontmatter that violates the definition contract', async () => {
    const result = await withTaskFile(
      '---\nid: A\ntitle: A\nstatus: CLOSED\nkind: NORMAL\npriority: HIGH\ncurrentFocus: false\ndependsOn: []\n---\n',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_DEFINITION_INVALID');
    expect(result.issueCount).toBeGreaterThan(0);
  });

  it('refuses an unknown frontmatter key', async () => {
    const result = await withTaskFile(
      '---\nid: A\ntitle: A\nstatus: OPEN\nkind: NORMAL\npriority: HIGH\ncurrentFocus: false\ndependsOn: []\nassignee: nobody\n---\n',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_DEFINITION_INVALID');
  });
});

describe('discovery: failures are data', () => {
  it('carries a static sentence with no host path and no repository text', async () => {
    const repository = await fixtureWithTasks({
      'tasks/A.md': '---\ntitle: zzQUARANTINEDzz\n---\n',
    });

    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('zzQUARANTINEDzz');
    expect(JSON.stringify(result)).not.toContain(repository.root.replace(/\\/g, '\\\\'));
    expect(result.detail).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('reports the first failing task in canonical order, not in directory order', async () => {
    const repository = await fixtureWithTasks({
      'tasks/zeta.md': '# broken\n',
      'tasks/alpha.md': '# broken\n',
    });

    const result = discoverTasks(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.taskId).toBe('alpha');
  });
});

describe('discovery follows the repository, not this checkout', () => {
  it('reads each repository’s own declared task source', async () => {
    const alpha = await fixtureWithTasks({
      'tasks/ALPHA-1.md': taskFile({ id: 'ALPHA-1' }),
    });
    const betaRoot = createRepoFixture({
      defaultBranch: 'develop',
      profile: FIXTURE_B_PROFILE,
      codegraphIndex: true,
      files: {
        'ops/work-items/BETA-1.md': taskFile({ id: 'BETA-1' }),
        'ops/work-items/BETA-2.md': taskFile({ id: 'BETA-2', dependsOn: ['BETA-1'] }),
        // A decoy in the *other* repository's task-source location.
        'tasks/ALPHA-1.md': taskFile({ id: 'ALPHA-1' }),
      },
    });
    const beta = await resolved(betaRoot);

    const alphaResult = discoverTasks(alpha);
    const betaResult = discoverTasks(beta);

    expect(alphaResult.ok && alphaResult.tasks.map((t) => t.id)).toEqual(['ALPHA-1']);
    expect(betaResult.ok && betaResult.tasks.map((t) => t.id)).toEqual(['BETA-1', 'BETA-2']);
  });

  it('gives the same answer from any working directory', async () => {
    const repository = await fixtureWithTasks({
      'tasks/A.md': taskFile({ id: 'A' }),
      'tasks/B.md': taskFile({ id: 'B', dependsOn: ['A'] }),
    });
    const original = process.cwd();
    const answers: string[] = [];

    try {
      for (const directory of [original, repository.root, join(repository.root, 'tasks')]) {
        process.chdir(directory);
        answers.push(JSON.stringify(discoverTasks(repository)));
      }
    } finally {
      process.chdir(original);
    }

    expect(new Set(answers).size).toBe(1);
  });
});

describe('planNextTask: discovery, graph and selection composed', () => {
  it('selects the next task of a real repository', async () => {
    const repository = await fixtureWithTasks({
      'tasks/V1-01.md': taskFile({ id: 'V1-01', status: 'DONE' }),
      'tasks/V1-02.md': taskFile({ id: 'V1-02', dependsOn: ['V1-01'], priority: 'HIGH' }),
      'tasks/V1-03.md': taskFile({ id: 'V1-03', dependsOn: ['V1-02'] }),
      'tasks/OPS-1.md': taskFile({ id: 'OPS-1', priority: 'LOW' }),
    });

    const result = planNextTask(repository);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.code).toBe('TASK_SELECTED');
    expect(result.selection.selected?.id).toBe('V1-02');
    expect(result.graph.taskIds).toEqual(['OPS-1', 'V1-01', 'V1-02', 'V1-03']);
  });

  it('reports a finished plan as complete', async () => {
    const repository = await fixtureWithTasks({
      'tasks/A.md': taskFile({ id: 'A', status: 'DONE' }),
    });

    const result = planNextTask(repository);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.code).toBe('ALL_TASKS_COMPLETE');
    expect(result.selection.selected).toBeNull();
  });

  it('surfaces a discovery failure without inventing a plan', async () => {
    const repository = await fixtureWithTasks({ 'tasks/.gitkeep': '' });
    const result = planNextTask(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_SOURCE_EMPTY');
  });

  it('surfaces a graph failure without inventing a plan', async () => {
    const repository = await fixtureWithTasks({
      'tasks/A.md': taskFile({ id: 'A', dependsOn: ['B'] }),
      'tasks/B.md': taskFile({ id: 'B', dependsOn: ['A'] }),
    });

    const result = planNextTask(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_GRAPH_CYCLE');
  });

  it('refuses a dependency on a task file that does not exist', async () => {
    const repository = await fixtureWithTasks({
      'tasks/A.md': taskFile({ id: 'A', dependsOn: ['GHOST'] }),
    });

    const result = planNextTask(repository);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_DEPENDENCY_UNKNOWN');
    expect(result.taskId).toBe('A');
  });

  it('is stable across repeated runs against the same repository', async () => {
    const repository = await fixtureWithTasks({
      'tasks/FIX-1.md': taskFile({ id: 'FIX-1', kind: 'REMEDIATION' }),
      'tasks/V1-02.md': taskFile({ id: 'V1-02', priority: 'HIGH', currentFocus: true }),
      'tasks/V1-03.md': taskFile({ id: 'V1-03', dependsOn: ['V1-02'] }),
    });

    const answers = new Set<string>();
    for (let run = 0; run < 100; run += 1) {
      const result = planNextTask(repository);
      answers.add(result.ok ? JSON.stringify(result.selection) : result.code);
    }

    expect(answers.size).toBe(1);
    const result = planNextTask(repository);
    expect(result.ok && result.selection.selected?.id).toBe('FIX-1');
  });
});
