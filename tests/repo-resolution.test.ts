/**
 * V1-01: repository resolution against arbitrary target repositories.
 *
 * Every repository here is a real, throwaway `git init` in the OS temp
 * directory. None of them is this checkout, and the two reference fixtures
 * disagree on every policy the profile can express — which is the point: if the
 * resolver carried project-specific knowledge, one of them would have to be
 * wrong.
 *
 * The failure cases matter as much as the successes. A profile is a *policy*
 * document: it says which paths a writer agent may touch and which capabilities
 * are mandatory. Every way of getting a policy other than "the reviewed file at
 * the one canonical path" is a way of getting a policy nobody reviewed, so each
 * one is pinned to a closed failure code below.
 */

import { mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { PACKAGE_ROOT } from '../src/config/paths.js';
import {
  createRepoFixture,
  FIXTURE_A_PROFILE,
  FIXTURE_B_PROFILE,
  FIXTURE_PROFILE_RELATIVE_PATH,
  removeRepoFixtures,
  writeRepoFile,
} from './helpers/repo-fixtures.js';
import {
  resolveRepository,
  type RepositoryResolutionResult,
  type ResolvedRepository,
} from '../src/repo/resolve-repository.js';
import { REPO_PROFILE_RELATIVE_PATH } from '../src/repo/profile-location.js';

afterAll(removeRepoFixtures);

const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
});

/** Unwraps a result that is expected to have resolved. */
function resolved(result: RepositoryResolutionResult): ResolvedRepository {
  if (!result.ok) {
    throw new Error(`expected a resolved repository, got ${result.code}: ${result.detail}`);
  }
  return result.repository;
}

/** A profile that is valid apart from the one line a test wants to break. */
function profileWith(overrides: {
  readonly id?: string;
  readonly defaultBranch?: string;
  readonly codegraph?: string;
  readonly taskPath?: string;
  readonly remoteRequired?: boolean;
  readonly extraKey?: string;
}): string {
  return `schemaVersion: 1
repository:
  id: ${overrides.id ?? 'fixture-alpha'}
  defaultBranch: ${overrides.defaultBranch ?? 'main'}
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: ${overrides.taskPath ?? 'tasks'}
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: ${overrides.codegraph ?? 'OPTIONAL'}
verification:
  phases:
    - phase: VERIFY
      command: [npm, run, verify]
scope:
  allowedPaths:
    - src
  protectedPaths:
    - dist
completion:
  maxReviewRounds: 3
remote:
  required: ${overrides.remoteRequired ?? false}
${overrides.extraKey ?? ''}`;
}

// ── Multi-repository acceptance ────────────────────────────────────────────

describe('repository resolution', () => {
  it('resolves a valid repository and its profile', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.code).toBe('RESOLVED');
    const repository = resolved(result);
    expect(repository.root).toBe(root);
    expect(repository.id).toBe('fixture-alpha');
    expect(repository.defaultBranch).toBe('main');
    expect(repository.profilePath).toBe(join(root, ...REPO_PROFILE_RELATIVE_PATH.split('/')));
  });

  it('resolves two different repositories to two different policies', async () => {
    const rootA = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    const rootB = createRepoFixture({
      defaultBranch: 'develop',
      profile: FIXTURE_B_PROFILE,
      codegraphIndex: true,
    });

    const a = resolved(await resolveRepository({ repositoryPath: rootA }));
    const b = resolved(await resolveRepository({ repositoryPath: rootB }));

    expect(a.root).not.toBe(b.root);
    expect(a.id).toBe('fixture-alpha');
    expect(b.id).toBe('fixture-beta');
    expect(a.defaultBranch).toBe('main');
    expect(b.defaultBranch).toBe('develop');
    expect(a.capabilities.codegraph.requirement).toBe('OPTIONAL');
    expect(b.capabilities.codegraph.requirement).toBe('REQUIRED');
    expect(a.capabilities.codegraph.status).toBe('UNAVAILABLE');
    expect(b.capabilities.codegraph.status).toBe('AVAILABLE');
    expect(a.taskSource.path).toBe('tasks');
    expect(b.taskSource.path).toBe('ops/work-items');
    expect(a.context.canonicalSources).toEqual(['README.md']);
    expect(b.context.canonicalSources).toEqual(['docs/architecture.md', 'docs/security.md']);
    expect(a.verification.phases).toEqual([
      { phase: 'BUILD', command: ['npm', 'run', 'build'] },
      { phase: 'VERIFY', command: ['npm', 'run', 'verify'] },
    ]);
    expect(b.verification.phases).toEqual([
      { phase: 'TEST', command: ['pnpm', 'run', 'test'] },
      { phase: 'VERIFY', command: ['pnpm', 'run', 'check'] },
    ]);
    expect(a.scope.allowedPaths).toEqual(['src', 'tests']);
    expect(b.scope.allowedPaths).toEqual(['app']);
    expect(a.scope.protectedPaths).toEqual(['dist']);
    expect(b.scope.protectedPaths).toEqual(['app/generated', 'vendor']);
    expect(a.completion.maxReviewRounds).toBe(3);
    expect(b.completion.maxReviewRounds).toBe(5);
  });

  it('carries nothing from the orchestrator’s own checkout', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    const repository = resolved(await resolveRepository({ repositoryPath: root }));

    expect(repository.root).not.toBe(PACKAGE_ROOT);
    expect(repository.profilePath.startsWith(PACKAGE_ROOT)).toBe(false);
  });

  it('has no repo module that reads the orchestrator installation paths', () => {
    // `src/config/paths.ts` describes where *this package* lives. A resolver
    // that consulted it would be deriving a target repository's contract from
    // the orchestrator's own checkout, which is the exact coupling V1-01 exists
    // to prevent. `json-schema.ts` is exempt only because it generates this
    // package's shipped schema, not a target repository's anything.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith('.ts')) {
          if (/from\s+['"][^'"]*config\/paths\.js['"]/.test(readFileSync(full, 'utf8'))) {
            offenders.push(relative(PACKAGE_ROOT, full));
          }
        }
      }
    };
    walk(join(PACKAGE_ROOT, 'src', 'repo'));
    expect(offenders).toEqual([]);
  });

  it('returns a deeply frozen value', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    const repository = resolved(await resolveRepository({ repositoryPath: root }));

    expect(Object.isFrozen(repository)).toBe(true);
    expect(Object.isFrozen(repository.scope)).toBe(true);
    expect(Object.isFrozen(repository.scope.protectedPaths)).toBe(true);
    expect(Object.isFrozen(repository.verification.phases)).toBe(true);
    expect(Object.isFrozen(repository.capabilities.codegraph)).toBe(true);
  });
});

// ── Remote is optional ─────────────────────────────────────────────────────

describe('remote expectation', () => {
  it('resolves a repository that has no remote at all', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    const repository = resolved(await resolveRepository({ repositoryPath: root }));

    expect(repository.remote).toEqual({ required: false, present: false });
  });

  it('records a configured remote without naming it', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      remote: true,
    });

    const repository = resolved(await resolveRepository({ repositoryPath: root }));

    expect(repository.remote).toEqual({ required: false, present: true });
    expect(JSON.stringify(repository)).not.toContain('origin');
  });

  it('refuses a repository whose profile requires a remote it does not have', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ remoteRequired: true }),
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('REMOTE_REQUIRED_BUT_ABSENT');
  });
});

// ── CodeGraph capability ───────────────────────────────────────────────────

describe('CodeGraph capability preflight', () => {
  it('refuses a repository that requires CodeGraph without an index', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ codegraph: 'REQUIRED' }),
      codegraphIndex: false,
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('REQUIRED_CAPABILITY_UNAVAILABLE');
  });

  it('resolves a repository that requires CodeGraph and has an index', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ codegraph: 'REQUIRED' }),
      codegraphIndex: true,
    });

    const repository = resolved(await resolveRepository({ repositoryPath: root }));

    expect(repository.capabilities.codegraph).toEqual({
      capability: 'codegraph',
      requirement: 'REQUIRED',
      status: 'AVAILABLE',
      satisfied: true,
    });
  });

  it('resolves a repository whose optional CodeGraph is unavailable', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ codegraph: 'OPTIONAL' }),
      codegraphIndex: false,
    });

    const repository = resolved(await resolveRepository({ repositoryPath: root }));

    expect(repository.capabilities.codegraph).toEqual({
      capability: 'codegraph',
      requirement: 'OPTIONAL',
      status: 'UNAVAILABLE',
      satisfied: true,
    });
  });

  it('does not accept a file named .codegraph as an index', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ codegraph: 'REQUIRED' }),
      files: { '.codegraph': 'not a directory' },
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.code).toBe('REQUIRED_CAPABILITY_UNAVAILABLE');
  });
});

// ── Default branch ─────────────────────────────────────────────────────────

describe('default branch validation', () => {
  it('refuses a profile whose default branch does not exist locally', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ defaultBranch: 'release' }),
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('DEFAULT_BRANCH_NOT_FOUND');
  });

  it('never falls back to main when the profile names another branch', async () => {
    // The repository *does* have `main`. That must not rescue a profile that
    // declares `trunk`: a silent fallback would pin work to a base the
    // repository never agreed to.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ defaultBranch: 'trunk' }),
    });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe(
      'DEFAULT_BRANCH_NOT_FOUND',
    );
  });

  it.each([
    ['a leading dash', '-force'],
    ['a .lock suffix', 'feature.lock'],
    ['a leading dot component', 'feature/.hidden'],
    ['a double dot', 'feature..old'],
    ['a reflog expression', 'main@{upstream}'],
    ['a trailing slash', 'feature/'],
  ])('refuses a default branch with %s', async (_label, branch) => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ defaultBranch: branch }),
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    // Either the profile schema refuses the characters outright or the branch
    // grammar does; both are fail-closed, and neither reaches Git.
    expect(['DEFAULT_BRANCH_INVALID', 'PROFILE_SCHEMA_INVALID']).toContain(result.code);
  });

  it('accepts a slash-separated branch name that exists', async () => {
    const root = createRepoFixture({
      defaultBranch: 'release/2026-08',
      profile: profileWith({ defaultBranch: 'release/2026-08' }),
    });

    expect(resolved(await resolveRepository({ repositoryPath: root })).defaultBranch).toBe(
      'release/2026-08',
    );
  });
});

// ── Profile discovery and parsing ──────────────────────────────────────────

describe('profile discovery', () => {
  it('fails closed when no profile exists', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: null });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROFILE_MISSING');
  });

  it.each([
    ['.agent-orchestrator/repo-profile.yml', 'a .yml spelling'],
    ['.agent-orchestrator.yaml', 'a root-level file'],
    ['agent-orchestrator.yaml', 'an undotted root-level file'],
    ['.agent-orchestrator/profile.yaml', 'another name in the right directory'],
  ])('does not discover %s (%s)', async (path) => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: null,
      files: { [path]: FIXTURE_A_PROFILE },
    });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('PROFILE_MISSING');
  });

  it('fails closed when the profile path holds a directory', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: null });
    mkdirSync(join(root, ...FIXTURE_PROFILE_RELATIVE_PATH.split('/')), { recursive: true });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.code).toBe('PROFILE_NOT_REGULAR_FILE');
  });

  it('refuses an oversized profile without reading it', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: null });
    writeRepoFile(root, FIXTURE_PROFILE_RELATIVE_PATH, 'x'.repeat(300_000));

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('PROFILE_TOO_LARGE');
  });

  it('classifies malformed YAML as a parse failure', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: 'schemaVersion: 1\nrepository: { id: fixture-alpha\n',
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROFILE_PARSE_FAILED');
  });

  it('classifies a YAML document that is not a mapping as contract-invalid', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: 'just-a-string\n' });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('PROFILE_SCHEMA_INVALID');
  });

  it('refuses an unknown key in the profile', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ extraKey: 'pullRequest:\n  autoMerge: true\n' }),
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROFILE_SCHEMA_INVALID');
    expect(result.ok === false && result.issueCount).toBeGreaterThan(0);
  });

  it('refuses a profile whose declared path escapes the repository', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ taskPath: '../../elsewhere' }),
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(['PROFILE_SCHEMA_INVALID', 'REPOSITORY_PATH_UNSAFE']).toContain(result.code);
  });

  it('never leaks a path, a branch name or an exception into the failure detail', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ defaultBranch: 'release' }),
    });

    const result = await resolveRepository({ repositoryPath: root });

    if (result.ok) throw new Error('expected a failure');
    expect(result.detail).not.toContain(root);
    expect(result.detail).not.toContain('release');
    expect(result.detail).not.toMatch(/[A-Za-z]:\\|\/tmp|\/var/);
  });
});

// ── Path safety and containment ────────────────────────────────────────────

describe('repository path safety', () => {
  it.each([
    ['an empty path', ''],
    ['a blank path', '   '],
    ['a relative path', 'some/repo'],
    ['a dot path', '.'],
  ])('refuses %s as repository input', async (_label, repositoryPath) => {
    expect((await resolveRepository({ repositoryPath })).code).toBe('REPOSITORY_PATH_INVALID');
  });

  it('refuses a path containing a NUL character', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    expect((await resolveRepository({ repositoryPath: `${root}\u0000/etc` })).code).toBe(
      'REPOSITORY_PATH_INVALID',
    );
  });

  it('refuses a path that does not exist', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    expect((await resolveRepository({ repositoryPath: join(root, 'no-such-dir') })).code).toBe(
      'REPOSITORY_NOT_FOUND',
    );
  });

  it('refuses a file where a repository root is required', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    expect((await resolveRepository({ repositoryPath: join(root, 'README.md') })).code).toBe(
      'REPOSITORY_NOT_DIRECTORY',
    );
  });

  it('refuses a subdirectory of a repository as its root', async () => {
    // Accepting this would resolve a profile that is not at *this* path's root
    // and pin work to a tree the caller did not name.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { 'src/keep.txt': 'x' },
    });

    const result = await resolveRepository({ repositoryPath: join(root, 'src') });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('REPOSITORY_ROOT_MISMATCH');
  });

  it('refuses a directory that is not a Git repository', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    const outside = join(root, '..', 'definitely-not-a-repo');
    mkdirSync(outside, { recursive: true });

    const result = await resolveRepository({ repositoryPath: outside });

    expect(result.ok).toBe(false);
    expect(['NOT_A_GIT_REPOSITORY', 'REPOSITORY_ROOT_MISMATCH']).toContain(result.code);
  });

  it('refuses a profile directory that is a link out of the repository', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: null });
    const elsewhere = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    const stash = join(elsewhere, '.agent-orchestrator');

    try {
      symlinkSync(stash, join(root, '.agent-orchestrator'), 'junction');
    } catch {
      // Link creation is a privileged operation on some hosts. The check it
      // exercises is unconditional in the resolver; only this probe is not.
      return;
    }

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('REPOSITORY_PATH_UNSAFE');
  });

  it('refuses a profile file that is a link', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: null });
    const elsewhere = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    mkdirSync(join(root, '.agent-orchestrator'), { recursive: true });

    try {
      symlinkSync(
        join(elsewhere, ...FIXTURE_PROFILE_RELATIVE_PATH.split('/')),
        join(root, ...FIXTURE_PROFILE_RELATIVE_PATH.split('/')),
        'file',
      );
    } catch {
      return;
    }

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('REPOSITORY_PATH_UNSAFE');
  });
});

// ── Independence from the working directory ────────────────────────────────

describe('working-directory independence', () => {
  it('resolves the named repository while standing in a different one', async () => {
    const rootA = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    const rootB = createRepoFixture({
      defaultBranch: 'develop',
      profile: FIXTURE_B_PROFILE,
      codegraphIndex: true,
    });

    process.chdir(rootB);
    const a = resolved(await resolveRepository({ repositoryPath: rootA }));

    expect(a.root).toBe(rootA);
    expect(a.id).toBe('fixture-alpha');
    expect(a.defaultBranch).toBe('main');
  });

  it('gives the identical answer from three different working directories', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    const other = createRepoFixture({ defaultBranch: 'main', profile: null });

    const answers: string[] = [];
    for (const cwd of [originalCwd, root, other]) {
      process.chdir(cwd);
      answers.push(JSON.stringify(resolved(await resolveRepository({ repositoryPath: root }))));
    }

    expect(new Set(answers).size).toBe(1);
  });

  it('does not adopt the working directory when the input is unusable', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    process.chdir(root);
    // Standing inside a perfectly valid repository must not make a relative or
    // empty input resolve to it.
    expect((await resolveRepository({ repositoryPath: '.' })).code).toBe('REPOSITORY_PATH_INVALID');
    expect((await resolveRepository({ repositoryPath: '' })).code).toBe('REPOSITORY_PATH_INVALID');
  });
});

// ── The one canonical location ─────────────────────────────────────────────

describe('canonical profile location', () => {
  it('is the single path the resolver and the fixtures agree on', () => {
    expect(REPO_PROFILE_RELATIVE_PATH).toBe(FIXTURE_PROFILE_RELATIVE_PATH);
    expect(REPO_PROFILE_RELATIVE_PATH).toBe('.agent-orchestrator/repo-profile.yaml');
  });

  it('is named by no module that could turn it into a second discovery rule', () => {
    // Exactly two modules may mention the file name: the location module, which
    // defines it, and the JSON-Schema generator, which quotes it in the
    // schema's human-readable `description`. A third would be a second place
    // deciding where a profile comes from — the fallback-candidate problem this
    // design exists to avoid.
    const referencing: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith('.ts')) {
          if (readFileSync(full, 'utf8').includes('repo-profile.yaml')) {
            referencing.push(relative(PACKAGE_ROOT, full));
          }
        }
      }
    };
    walk(join(PACKAGE_ROOT, 'src'));
    expect(referencing.sort()).toEqual([
      join('src', 'repo', 'json-schema.ts'),
      join('src', 'repo', 'profile-location.ts'),
    ]);
  });
});
