/**
 * DASHBOARD-001 slice 1 — the two extractions the read model needs.
 *
 * ── Why these pins live together ───────────────────────────────────────────
 *
 * A read-only dashboard polls AO's durable state every few seconds. Slice 0
 * measured, on this NTFS volume, that this is only safe under two conditions: a
 * reader that HOLDS a file handle makes AO's `renameSync` fail with `EPERM`
 * 50/50, while open-read-close survives 2000 replacements with zero failures and
 * zero torn documents. So the read model may only call functions that open, read
 * and close in one bounded operation — and it may start **no subprocess at all**,
 * because a poll that spawned git would cost five to six children per repository.
 *
 * That last constraint is what these two extractions are for. Both are
 * *narrowings of what a caller must supply*, not new logic, and neither adds a
 * second parser or a second source of truth.
 *
 * 1. `discoverTasks` already spawns nothing — its only I/O is `readdirSync` plus
 *    a bounded read per file, and its `ResolvedRepository` import is `import
 *    type`, erased at compile time. It reads exactly two fields of the value it
 *    is handed. What blocked a dashboard was the *type*: the only production
 *    producer of a `ResolvedRepository` runs five `git` children, and a dashboard
 *    cannot honestly produce one (`gitCommonDir` is a question only git answers)
 *    and must not fabricate and cast one.
 *
 * 2. `readDeclaredRepositoryId` already reads and validates the WHOLE profile
 *    through the shared chain and then returns one field of it. The task source
 *    path is parsed and discarded three lines before the return. Widening it in
 *    place keeps exactly one git-free profile reader and exactly one parse; a
 *    second reader would be the second opinion `declared-identity.ts`'s own
 *    header refuses.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { discoverTasks } from '../src/plan/discover-tasks.js';
import {
  readDeclaredProfile,
  readDeclaredRepositoryId,
} from '../src/repo/declared-identity.js';
import { resolveRepository } from '../src/repo/resolve-repository.js';
import {
  FIXTURE_A_PROFILE,
  createRepoFixture,
  removeRepoFixtures,
} from './helpers/repo-fixtures.js';

afterAll(() => {
  removeRepoFixtures();
});

/** A well-formed task file, matching the fixture contract. */
function taskFile(id: string, status = 'OPEN'): string {
  return [
    '---',
    `id: ${id}`,
    `title: Task ${id}`,
    `status: ${status}`,
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: false',
    'dependsOn: []',
    '---',
    '',
    'Human-readable description.',
    '',
  ].join('\n');
}

describe('the profile is readable without git, whole', () => {
  it('returns the parsed profile, including the task source the dashboard needs', () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'tasks/D1-01.md': taskFile('D1-01') },
    });

    const read = readDeclaredProfile(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // The two fields the dashboard actually needs, and nothing is inferred.
    expect(read.profile.repository.id).toBe('fixture-alpha');
    expect(read.profile.taskSource.path).toBe('tasks');
    // The whole contract came back, not a projection of it: these are the
    // fields a second reader would otherwise have had to re-parse.
    expect(read.profile.repository.defaultBranch).toBe('main');
    expect(read.profile.verification.phases.length).toBeGreaterThan(0);
  });

  it('agrees with the narrower reader, because there is one parse and not two', () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'tasks/D1-01.md': taskFile('D1-01') },
    });

    const whole = readDeclaredProfile(root);
    const idOnly = readDeclaredRepositoryId(root);
    expect(whole.ok).toBe(true);
    expect(idOnly.ok).toBe(true);
    if (!whole.ok || !idOnly.ok) return;

    // If these ever disagree, two readers have grown two opinions about one file.
    expect(idOnly.id).toBe(whole.profile.repository.id);
  });

  it('refuses a checkout with no profile, with the one code, from both readers', () => {
    // A directory that is not an AO repository at all.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: {},
    });
    const notARepository = `${root}-absent`;

    const whole = readDeclaredProfile(notARepository);
    const idOnly = readDeclaredRepositoryId(notARepository);
    expect(whole).toMatchObject({ ok: false, code: 'REPOSITORY_PROFILE_UNUSABLE' });
    expect(idOnly).toMatchObject({ ok: false, code: 'REPOSITORY_PROFILE_UNUSABLE' });
  });
});

describe('declared tasks are discoverable without resolving the repository', () => {
  it('accepts the two fields it actually reads, with no ResolvedRepository at all', () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: {
        'tasks/D1-01.md': taskFile('D1-01'),
        'tasks/D1-02.md': taskFile('D1-02', 'DONE'),
      },
    });

    const profile = readDeclaredProfile(root);
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;

    // THE PIN. This object literal is everything the dashboard can honestly
    // produce: a canonical root and a declared task-source path, both read from
    // a file. No git ran. If this stops type-checking, the extraction is gone.
    const discovered = discoverTasks({
      root,
      taskSource: { path: profile.profile.taskSource.path },
    });

    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.tasks.map((task) => task.id)).toEqual(['D1-01', 'D1-02']);
  });

  it('answers identically whether it is handed a resolved repository or the subset', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: {
        'tasks/D1-01.md': taskFile('D1-01'),
        'tasks/D1-02.md': taskFile('D1-02'),
      },
    });

    const resolution = await resolveRepository({ repositoryPath: root });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // The resolver's own value still satisfies the narrowed parameter, so every
    // existing caller keeps working. This is the half that proves the narrowing
    // took nothing away.
    const viaResolved = discoverTasks(resolution.repository);
    const viaSubset = discoverTasks({
      root: resolution.repository.root,
      taskSource: { path: resolution.repository.taskSource.path },
    });

    expect(viaResolved).toEqual(viaSubset);
  });

  it('reports a declared task whose file says OPEN without claiming a runtime state', () => {
    // `status` is the DEPENDENCY contract (select-task.ts reads it to decide
    // whether a dependency is satisfied) and is not, and never was, AO's runtime
    // state. A task file may say OPEN while its durable state says READY_FOR_PR,
    // because the file flip lands in the delivery pull request. The dashboard
    // must therefore derive "declared but never started" from the ABSENCE of a
    // durable state file — never from this field.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'tasks/D1-09.md': taskFile('D1-09', 'OPEN') },
    });

    const profile = readDeclaredProfile(root);
    if (!profile.ok) throw new Error('fixture profile unreadable');
    const discovered = discoverTasks({
      root,
      taskSource: { path: profile.profile.taskSource.path },
    });

    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    const [task] = discovered.tasks;
    expect(task?.id).toBe('D1-09');
    expect(task?.status).toBe('OPEN');
    // A TaskDefinition carries no runtime state, and the dashboard must not
    // invent one. There is no `state` on this contract at all.
    expect(task).not.toHaveProperty('state');
  });
});
