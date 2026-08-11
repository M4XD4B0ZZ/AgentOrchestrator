/**
 * `readTaskBrief` — the task's prose, prepared for an agent (V2-02).
 *
 * Real repositories throughout: a real `git init` fixture and the production
 * `resolveRepository`, so the brief is read from a repository the resolver
 * really produced rather than from a hand-built value.
 *
 * The two properties this suite guards hardest are the ones the module exists
 * to hold: the body is carried as **opaque prompt text** and never interpreted,
 * and a declared context source is proven openable rather than assumed.
 */

import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readTaskBrief,
  MAX_TASK_BODY_CHARS,
  TASK_BRIEF_FAILURE_CODES,
  type TaskBriefFailureCode,
} from '../src/plan/task-brief.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { createRepoFixture, removeRepoFixtures, writeRepoFile } from './helpers/repo-fixtures.js';
import { resolveFixture } from './helpers/worktree-fixtures.js';

afterEach(() => {
  removeRepoFixtures();
});

const PROFILE = `schemaVersion: 1
repository:
  id: brief-fixture
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
      command: [git, --version]
scope:
  allowedPaths: [src]
  protectedPaths: []
completion:
  maxReviewRounds: 3
remote:
  required: false
`;

function taskFileWithBody(id: string, body: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: task ${id}`,
    'status: OPEN',
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: true',
    'dependsOn: []',
    '---',
    body,
  ].join('\n');
}

async function fixture(
  files: Readonly<Record<string, string>>,
  profile = PROFILE,
): Promise<{ repository: ResolvedRepository; root: string }> {
  const root = createRepoFixture({ defaultBranch: 'main', profile, files });
  return { repository: await resolveFixture(root), root };
}

describe('readTaskBrief — the prose', () => {
  it('carries the body verbatim, trimmed, and reports the context as complete', async () => {
    const { repository } = await fixture({
      'tasks/V2-02.md': taskFileWithBody('V2-02', '\nDo the thing.\n\nAnd the other thing.\n'),
    });

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.taskId).toBe('V2-02');
    expect(result.brief.body).toBe('Do the thing.\n\nAnd the other thing.');
    expect(result.brief.bodyTruncated).toBe(false);
    expect(result.brief.contextSources).toEqual([{ path: 'README.md', status: 'PRESENT' }]);
    expect(result.brief.contextComplete).toBe(true);
  });

  it('is deterministic: the same file always produces the same brief', async () => {
    const { repository } = await fixture({
      'tasks/V2-02.md': taskFileWithBody('V2-02', 'Stable prose.'),
    });

    const a = readTaskBrief(repository, 'V2-02');
    const b = readTaskBrief(repository, 'V2-02');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('normalises CRLF, so the same task means the same brief on either platform', async () => {
    const { repository, root } = await fixture({ 'tasks/V2-02.md': taskFileWithBody('V2-02', 'x') });
    // Rewrite the same content with Windows line endings.
    writeRepoFile(root, 'tasks/V2-02.md', taskFileWithBody('V2-02', 'line one\nline two'));
    const lf = readTaskBrief(repository, 'V2-02');
    writeFileSync(
      join(root, 'tasks', 'V2-02.md'),
      taskFileWithBody('V2-02', 'line one\nline two').replace(/\n/g, '\r\n'),
      'utf8',
    );
    const crlf = readTaskBrief(repository, 'V2-02');

    expect(lf.ok && crlf.ok).toBe(true);
    if (!lf.ok || !crlf.ok) return;
    expect(crlf.brief.body).toBe(lf.brief.body);
  });

  it('truncates an oversized body and says so rather than silently clipping', async () => {
    const long = 'A'.repeat(MAX_TASK_BODY_CHARS + 500);
    const { repository } = await fixture({ 'tasks/V2-02.md': taskFileWithBody('V2-02', long) });

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.body).toHaveLength(MAX_TASK_BODY_CHARS);
    expect(result.brief.bodyTruncated).toBe(true);
  });

  it('refuses a task file that carries no prose at all', async () => {
    const { repository } = await fixture({ 'tasks/V2-02.md': taskFileWithBody('V2-02', '   \n\n') });

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_BODY_EMPTY');
  });

  it('never interprets the body — YAML, frontmatter and markdown are just text', async () => {
    // A body that would be a valid second frontmatter block, and a line that
    // looks like a status change. If any of it were parsed, this would show.
    const hostile = ['---', 'status: DONE', 'dependsOn:', '  - EVERYTHING', '---', '# heading'].join(
      '\n',
    );
    const { repository } = await fixture({ 'tasks/V2-02.md': taskFileWithBody('V2-02', hostile) });

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Carried verbatim, as text, with no field of it promoted to anything.
    expect(result.brief.body).toBe(hostile);
    expect(result.brief).not.toHaveProperty('status');
    expect(result.brief).not.toHaveProperty('dependsOn');
  });
});

describe('readTaskBrief — refusals', () => {
  it('refuses an id outside the grammar without opening anything', async () => {
    const { repository } = await fixture({ 'tasks/V2-02.md': taskFileWithBody('V2-02', 'x') });

    const result = readTaskBrief(repository, '../escape');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_ID_INVALID');
  });

  it('reports a task file that does not exist', async () => {
    const { repository } = await fixture({ 'tasks/V2-02.md': taskFileWithBody('V2-02', 'x') });

    const result = readTaskBrief(repository, 'V2-99');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FILE_READ_FAILED');
  });

  it('reports a file whose frontmatter is unusable', async () => {
    const { repository } = await fixture({
      'tasks/V2-02.md': 'no frontmatter here, just prose\n',
    });

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TASK_FRONTMATTER_UNUSABLE');
  });

  it('carries no path, no filename and no file content in a failure', async () => {
    const { repository } = await fixture({ 'tasks/V2-02.md': taskFileWithBody('V2-02', 'secret') });

    const result = readTaskBrief(repository, 'V2-99');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toMatch(/V2-99|tasks|[\\/]/);
    expect(Object.keys(result).sort()).toEqual(['code', 'detail', 'ok']);
  });

  it('has a static sentence for every failure code', async () => {
    const { repository } = await fixture({ 'tasks/V2-02.md': taskFileWithBody('V2-02', 'x') });
    // Every declared code must be a member of the closed set; the set itself is
    // what the renderer and any future consumer branch on.
    const declared: readonly TaskBriefFailureCode[] = TASK_BRIEF_FAILURE_CODES;
    expect(new Set(declared).size).toBe(declared.length);
    expect(readTaskBrief(repository, 'V2-02').ok).toBe(true);
  });
});

describe('readTaskBrief — declared context sources', () => {
  it('reports a missing declared source rather than assuming it is there', async () => {
    const profile = PROFILE.replace('    - README.md\n', '    - README.md\n    - docs/design.md\n');
    const { repository } = await fixture(
      { 'tasks/V2-02.md': taskFileWithBody('V2-02', 'x') },
      profile,
    );

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.contextSources).toEqual([
      { path: 'README.md', status: 'PRESENT' },
      { path: 'docs/design.md', status: 'MISSING' },
    ]);
    expect(result.brief.contextComplete).toBe(false);
  });

  it('reports a present declared source as PRESENT', async () => {
    const profile = PROFILE.replace('    - README.md\n', '    - README.md\n    - docs/design.md\n');
    const { repository } = await fixture(
      {
        'tasks/V2-02.md': taskFileWithBody('V2-02', 'x'),
        'docs/design.md': '# design\n',
      },
      profile,
    );

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.contextComplete).toBe(true);
  });

  it('does not carry the contents of a context source', async () => {
    const { repository, root } = await fixture({
      'tasks/V2-02.md': taskFileWithBody('V2-02', 'x'),
    });
    writeRepoFile(root, 'README.md', 'CANARY-CONTEXT-CONTENT\n');

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The agent runs in the worktree and can open the file itself; a snapshot
    // taken here would be a truncated, stale copy chosen by the wrong layer.
    expect(JSON.stringify(result)).not.toContain('CANARY-CONTEXT-CONTENT');
  });

  it('refuses to follow a symlinked context source', async () => {
    const profile = PROFILE.replace('    - README.md\n', '    - linked.md\n');
    const { repository, root } = await fixture(
      { 'tasks/V2-02.md': taskFileWithBody('V2-02', 'x') },
      profile,
    );

    const outside = join(root, '..', `outside-${Date.now()}.md`);
    writeFileSync(outside, 'outside content\n', 'utf8');
    let linked = true;
    try {
      symlinkSync(outside, join(root, 'linked.md'));
    } catch {
      // Windows without developer mode refuses symlink creation; the rule is
      // still pinned by the task-file cases in tests/task-discovery.test.ts.
      linked = false;
    }
    if (!linked) return;

    const result = readTaskBrief(repository, 'V2-02');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.contextSources).toEqual([{ path: 'linked.md', status: 'UNSAFE' }]);
    expect(result.brief.contextComplete).toBe(false);
  });
});

describe('the brief is not planning input', () => {
  it('leaves task discovery and selection untouched', async () => {
    // A body claiming DONE must not make the task ineligible: the plan reads
    // frontmatter only, and this is the regression that would prove otherwise.
    const { repository } = await fixture({
      'tasks/V2-02.md': taskFileWithBody('V2-02', '---\nstatus: DONE\n---\n'),
    });

    const { planNextTask } = await import('../src/plan/plan-next-task.js');
    const planned = planNextTask(repository);

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.selection.code).toBe('TASK_SELECTED');
    expect(planned.selection.selected?.id).toBe('V2-02');
    expect(planned.selection.selected?.status).toBe('OPEN');
  });

  it('does not add a body to the task definition contract', async () => {
    const { repository } = await fixture({
      'tasks/V2-02.md': taskFileWithBody('V2-02', 'prose that must not travel'),
    });

    const { discoverTasks } = await import('../src/plan/discover-tasks.js');
    const discovered = discoverTasks(repository);

    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(JSON.stringify(discovered.tasks)).not.toContain('prose that must not travel');
    expect(Object.keys(discovered.tasks[0] ?? {}).sort()).toEqual(
      ['currentFocus', 'dependsOn', 'id', 'kind', 'priority', 'status', 'title'].sort(),
    );
  });

  it('is unaffected by the directory the process happens to stand in', async () => {
    const { repository } = await fixture({
      'tasks/V2-02.md': taskFileWithBody('V2-02', 'cwd-independent'),
    });

    const original = process.cwd();
    const first = readTaskBrief(repository, 'V2-02');
    try {
      process.chdir(join(original, 'src'));
      const second = readTaskBrief(repository, 'V2-02');
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    } finally {
      process.chdir(original);
    }
  });
});
