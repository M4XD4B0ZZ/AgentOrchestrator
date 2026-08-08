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
import { capabilitySatisfied, probeCodegraphCapability } from '../src/repo/capabilities.js';
import { buildRepoProfileJsonSchema } from '../src/repo/json-schema.js';
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
    expect(b.capabilities.codegraph.status).toBe('INDEX_PRESENT');
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
      status: 'INDEX_PRESENT',
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

  // Each of these is refused by exactly one layer, and *which* layer is part of
  // the contract rather than an implementation detail. The profile schema owns
  // the character grammar — the shell-inert argument vocabulary the execution
  // layer accepts — so a name carrying a character outside it never reaches the
  // branch rules at all. The branch grammar owns the shape rules that apply to
  // names built from otherwise legal characters. Pinning one code per case means
  // a rule silently migrating between the two layers fails this test instead of
  // passing it, which an `either code is fine` assertion could not detect.
  it.each([
    ['a leading dash', '-force', 'DEFAULT_BRANCH_INVALID'],
    ['a .lock suffix', 'feature.lock', 'DEFAULT_BRANCH_INVALID'],
    ['a leading dot component', 'feature/.hidden', 'DEFAULT_BRANCH_INVALID'],
    ['a double dot', 'feature..old', 'DEFAULT_BRANCH_INVALID'],
    ['a trailing slash', 'feature/', 'DEFAULT_BRANCH_INVALID'],
    // `{` and `}` are outside the schema's shell-inert character set, so the
    // reflog expression is refused before the branch grammar sees it.
    ['a reflog expression', 'main@{upstream}', 'PROFILE_SCHEMA_INVALID'],
  ])('refuses a default branch with %s', async (_label, branch, expected) => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ defaultBranch: branch }),
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(expected);
  });

  it.each([
    ['an accented segment', 'feature/café'],
    ['a non-ASCII first character', 'Ünicode'],
  ])('refuses %s Git itself would accept', async (_label, branch) => {
    // Git accepts these names. This build does not, and the reason is the
    // execution layer rather than Git: `runCommand` accepts only the ASCII-inert
    // argument grammar (AO-008), and the profile schema enforces that grammar on
    // every value that becomes a process argument. The limit is recorded here so
    // that widening it later is a deliberate change to a pinned expectation.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ defaultBranch: branch }),
    });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('PROFILE_SCHEMA_INVALID');
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

// ── Prototype-special mapping keys ─────────────────────────────────────────
//
// These profiles are written as *text*, never as object literals: the whole
// question is what the YAML parser and the JavaScript object model do with a
// key named `__proto__`, and an object literal in a test would have already
// answered it. On the pre-fix build every case below resolved successfully —
// Zod's `.strict()` drops `__proto__` instead of reporting it as unknown, while
// the generated JSON Schema refuses it like any other additional property.

describe('prototype-special mapping keys', () => {
  it('refuses a top-level __proto__ key', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ extraKey: '__proto__:\n  aoPollutionMarker: true\n' }),
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROFILE_SCHEMA_INVALID');
    expect(result.ok === false && result.issueCount).toBeGreaterThan(0);
  });

  it('refuses a nested repository.__proto__ key', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({}).replace(
        '  defaultBranch: main\n',
        '  defaultBranch: main\n  __proto__:\n    aoPollutionMarker: true\n',
      ),
    });

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROFILE_SCHEMA_INVALID');
  });

  it('refuses a __proto__ key nested two levels down', async () => {
    // The check walks the parsed document tree, so depth is not a special case.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({}).replace(
        '      command: [npm, run, verify]\n',
        '      command: [npm, run, verify]\n      __proto__:\n        aoPollutionMarker: true\n',
      ),
    });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('PROFILE_SCHEMA_INVALID');
  });

  it('still refuses an ordinary unknown nested key the same way', async () => {
    // The contrast is the point: a normal unknown key was already fail-closed,
    // and tightening `__proto__` did not move it to a different code.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({}).replace(
        '  defaultBranch: main\n',
        '  defaultBranch: main\n  upstream: origin\n',
      ),
    });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('PROFILE_SCHEMA_INVALID');
  });

  it('leaves Object.prototype untouched', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ extraKey: '__proto__:\n  aoPollutionMarker: true\n' }),
    });

    await resolveRepository({ repositoryPath: root });

    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('aoPollutionMarker');
    expect(({} as Record<string, unknown>)['aoPollutionMarker']).toBeUndefined();
  });

  it('refuses the same document the generated JSON Schema refuses', async () => {
    // Runtime and shipped schema must agree about this class of key: the schema
    // forbids additional properties at every level, so `__proto__` is an
    // additional property there, and `PROFILE_SCHEMA_INVALID` is the runtime's
    // word for exactly that.
    const schema = buildRepoProfileJsonSchema() as { additionalProperties: unknown };
    expect(schema.additionalProperties).toBe(false);

    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ extraKey: '__proto__:\n  aoPollutionMarker: true\n' }),
    });
    const withOrdinaryKey = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ extraKey: 'aoUnknownSection:\n  value: true\n' }),
    });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe(
      (await resolveRepository({ repositoryPath: withOrdinaryKey })).code,
    );
  });
});

// ── Parser warnings stay inside the resolver ───────────────────────────────

describe('YAML warning containment', () => {
  /** Runs `body` while recording everything the process reports as a warning. */
  async function recordingProcessWarnings<T>(
    body: () => Promise<T>,
  ): Promise<{ readonly value: T; readonly warnings: readonly string[] }> {
    // A listener is added and removed — nothing global is replaced, so a
    // parallel test file sharing this process is unaffected, and the assertions
    // below only ever ask whether a *specific* marker appeared.
    const warnings: string[] = [];
    const listener = (warning: Error): void => {
      warnings.push(`${warning.name}: ${warning.message}`);
    };
    process.on('warning', listener);
    try {
      const value = await body();
      // `process.emitWarning` delivers on a later tick.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return { value, warnings };
    } finally {
      process.off('warning', listener);
    }
  }

  /** A tag no schema resolves, carrying a token that could only come from the file. */
  const UNKNOWN_TAG_MARKER = 'AoProfileLeakMarker-4d19c7';

  it('refuses a profile carrying an unresolvable custom tag', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({}).replace(
        '  id: fixture-alpha\n',
        `  id: !${UNKNOWN_TAG_MARKER} fixture-alpha\n`,
      ),
    });

    const result = await resolveRepository({ repositoryPath: root });

    // The contract is plain YAML 1.2 core schema. A construct outside it is
    // refused rather than silently reinterpreted — suppressing the parser's
    // warning must not be what makes such a document acceptable.
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROFILE_PARSE_FAILED');
  });

  it('emits no process warning carrying profile text', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({}).replace(
        '  id: fixture-alpha\n',
        `  id: !${UNKNOWN_TAG_MARKER} fixture-alpha\n`,
      ),
    });

    const { value: result, warnings } = await recordingProcessWarnings(() =>
      resolveRepository({ repositoryPath: root }),
    );

    expect(result.code).toBe('PROFILE_PARSE_FAILED');
    expect(warnings.filter((warning) => warning.includes(UNKNOWN_TAG_MARKER))).toEqual([]);
    expect(warnings.filter((warning) => warning.includes('fixture-alpha'))).toEqual([]);
    expect(warnings.filter((warning) => warning.includes('YAMLWarning'))).toEqual([]);
  });

  it('keeps the failure detail static and free of the document', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({}).replace(
        '  id: fixture-alpha\n',
        `  id: !${UNKNOWN_TAG_MARKER} fixture-alpha\n`,
      ),
    });

    const result = await resolveRepository({ repositoryPath: root });

    if (result.ok) throw new Error('expected a failure');
    expect(result.detail).toBe('The repository profile is not well-formed YAML.');
    expect(result.detail).not.toContain(UNKNOWN_TAG_MARKER);
    expect(result.detail).not.toContain(root);
    expect(result.issueCount).toBeNull();
  });

  it('still classifies genuinely malformed YAML as a parse failure', async () => {
    // Silencing the library's logger must not be allowed to silence its errors:
    // `YAML.parse` under a silent log level *discards* them instead of throwing.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: 'schemaVersion: 1\nrepository: { id: fixture-alpha\n',
    });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('PROFILE_PARSE_FAILED');
  });

  it('refuses a multi-document profile stream', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: `${profileWith({})}---\n${profileWith({ id: 'fixture-beta' })}`,
    });

    expect((await resolveRepository({ repositoryPath: root })).code).toBe('PROFILE_PARSE_FAILED');
  });
});

// ── What the capability status is evidence of ──────────────────────────────

describe('CodeGraph capability status names its evidence', () => {
  it('reports INDEX_PRESENT for a real local index directory', () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      codegraphIndex: true,
    });

    expect(probeCodegraphCapability(root)).toBe('INDEX_PRESENT');
  });

  it('reports UNAVAILABLE when no index is there', () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });

    expect(probeCodegraphCapability(root)).toBe('UNAVAILABLE');
  });

  it('reports UNAVAILABLE for a file named .codegraph', () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      files: { '.codegraph': 'not a directory' },
    });

    expect(probeCodegraphCapability(root)).toBe('UNAVAILABLE');
  });

  it('reports UNKNOWN for a linked .codegraph rather than following it', () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    const elsewhere = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      codegraphIndex: true,
    });

    try {
      symlinkSync(join(elsewhere, '.codegraph'), join(root, '.codegraph'), 'junction');
    } catch {
      // Link creation is privileged on some hosts; the resolver's check is not.
      return;
    }

    expect(probeCodegraphCapability(root)).toBe('UNKNOWN');
  });

  it('satisfies REQUIRED from INDEX_PRESENT alone', () => {
    expect(capabilitySatisfied('REQUIRED', 'INDEX_PRESENT')).toBe(true);
    expect(capabilitySatisfied('REQUIRED', 'UNAVAILABLE')).toBe(false);
    // An unresolved probe is never rounded up to a pass.
    expect(capabilitySatisfied('REQUIRED', 'UNKNOWN')).toBe(false);
  });

  it('satisfies OPTIONAL from every status', () => {
    for (const status of ['INDEX_PRESENT', 'UNAVAILABLE', 'UNKNOWN'] as const) {
      expect(capabilitySatisfied('OPTIONAL', status)).toBe(true);
    }
  });

  it('refuses a REQUIRED capability whose index cannot be determined', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWith({ codegraph: 'REQUIRED' }),
    });
    const elsewhere = createRepoFixture({
      defaultBranch: 'main',
      profile: FIXTURE_A_PROFILE,
      codegraphIndex: true,
    });

    try {
      symlinkSync(join(elsewhere, '.codegraph'), join(root, '.codegraph'), 'junction');
    } catch {
      return;
    }

    expect((await resolveRepository({ repositoryPath: root })).code).toBe(
      'REQUIRED_CAPABILITY_UNAVAILABLE',
    );
  });

  it('claims nothing about tool or MCP reachability', () => {
    // The status vocabulary is the contract V1-02+ will read. It must not offer
    // a member a consumer could take as "a CodeGraph tool answered": the probe
    // performs one `lstat` and starts no process, so nothing in this build could
    // back such a claim. `INDEX_PRESENT` says only what was measured.
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'repo', 'capabilities.ts'), 'utf8');
    const declaration = /export type CapabilityStatus =([^;]+);/.exec(source)?.[1] ?? '';
    const members = declaration.split('|').map((member) => member.trim().replaceAll("'", ''));

    expect(members).toEqual(['INDEX_PRESENT', 'UNAVAILABLE', 'UNKNOWN']);
    // `AVAILABLE` read as "the capability can be used"; that is the reading the
    // evidence does not support. `UNAVAILABLE` stays: absence of a local index
    // is exactly what it is measured on.
    expect(members).not.toContain('AVAILABLE');
    expect(members).not.toContain('REACHABLE');
    // No probe in this module starts anything or talks to anything.
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('runCommand');
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
