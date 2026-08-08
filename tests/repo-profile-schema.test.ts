/**
 * The repository-profile contract and its generated JSON Schema.
 *
 * Same rules as the task-state contract: one canonical Zod source, a generated
 * document checked in, a drift test that compares it byte for byte, unknown
 * keys refused, and the weaker structural schema kept internal.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_ROOT, REPO_PROFILE_SCHEMA_FILE } from '../src/config/paths.js';
import {
  buildRepoProfileJsonSchema,
  renderRepoProfileJsonSchema,
} from '../src/repo/json-schema.js';
import {
  parseRepoProfile,
  REPO_PROFILE_SCHEMA_VERSION,
  safeParseRepoProfile,
} from '../src/repo/repo-profile.js';
import * as repoProfileModule from '../src/repo/repo-profile.js';
import * as repoJsonSchemaModule from '../src/repo/json-schema.js';
import * as resolveRepositoryModule from '../src/repo/resolve-repository.js';

/** A minimal profile every test below mutates a single field of. */
function validProfile(): Record<string, unknown> {
  return {
    schemaVersion: REPO_PROFILE_SCHEMA_VERSION,
    repository: { id: 'fixture-alpha', defaultBranch: 'main' },
    taskSource: { kind: 'MARKDOWN_DIRECTORY', path: 'tasks' },
    context: { canonicalSources: ['README.md'] },
    capabilities: { codegraph: 'OPTIONAL' },
    verification: { phases: [{ phase: 'VERIFY', command: ['npm', 'run', 'verify'] }] },
    scope: { allowedPaths: ['src'], protectedPaths: [] },
    completion: { maxReviewRounds: 3 },
    remote: { required: false },
  };
}

describe('repository-profile contract', () => {
  it('accepts a minimal valid profile', () => {
    expect(() => parseRepoProfile(validProfile())).not.toThrow();
  });

  it('refuses an unknown top-level key', () => {
    const profile = { ...validProfile(), pullRequests: { autoMerge: true } };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses an unknown nested key', () => {
    const profile = validProfile();
    profile['repository'] = { id: 'fixture-alpha', defaultBranch: 'main', upstream: 'origin' };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses a missing section', () => {
    const profile = validProfile();
    delete profile['scope'];
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses a schemaVersion this build does not understand', () => {
    const profile = { ...validProfile(), schemaVersion: REPO_PROFILE_SCHEMA_VERSION + 1 };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it.each([
    ['absolute', '/etc/passwd'],
    ['drive-qualified', 'C:/Windows'],
    ['parent-traversal', '../outside'],
    ['embedded traversal', 'src/../../outside'],
    ['backslash-separated', 'src\\nested'],
    ['UNC-shaped', '//host/share'],
    ['current-directory segment', './src'],
  ])('refuses a %s task-source path', (_label, path) => {
    const profile = validProfile();
    profile['taskSource'] = { kind: 'MARKDOWN_DIRECTORY', path };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses a verification command carrying a shell metacharacter', () => {
    const profile = validProfile();
    profile['verification'] = {
      phases: [{ phase: 'VERIFY', command: ['npm', 'run', 'verify && curl evil'] }],
    };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses a verification block with no VERIFY phase', () => {
    const profile = validProfile();
    profile['verification'] = { phases: [{ phase: 'BUILD', command: ['npm', 'run', 'build'] }] };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses a duplicated verification phase', () => {
    const profile = validProfile();
    profile['verification'] = {
      phases: [
        { phase: 'VERIFY', command: ['npm', 'run', 'verify'] },
        { phase: 'VERIFY', command: ['npm', 'run', 'other'] },
      ],
    };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses a duplicated allowed path', () => {
    const profile = validProfile();
    profile['scope'] = { allowedPaths: ['src', 'src'], protectedPaths: [] };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses an empty allowedPaths list', () => {
    const profile = validProfile();
    profile['scope'] = { allowedPaths: [], protectedPaths: ['dist'] };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it.each([
    ['uppercase', 'Fixture'],
    ['path-shaped', 'org/repo'],
    ['leading dash', '-fixture'],
  ])('refuses a %s repository id', (_label, id) => {
    const profile = validProfile();
    profile['repository'] = { id, defaultBranch: 'main' };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses a review budget below one', () => {
    const profile = { ...validProfile(), completion: { maxReviewRounds: 0 } };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it('refuses a non-boolean remote requirement', () => {
    const profile = { ...validProfile(), remote: { required: 'yes' } };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });
});

describe('generated repository-profile JSON Schema', () => {
  it('is deterministic across runs', () => {
    expect(renderRepoProfileJsonSchema()).toBe(renderRepoProfileJsonSchema());
  });

  it('matches the file checked in at schemas/repo-profile.schema.json', () => {
    const onDisk = readFileSync(REPO_PROFILE_SCHEMA_FILE, 'utf8');
    expect(onDisk).toBe(renderRepoProfileJsonSchema());
  });

  it('declares every section as required', () => {
    expect(buildRepoProfileJsonSchema()['required']).toEqual([
      'schemaVersion',
      'repository',
      'taskSource',
      'context',
      'capabilities',
      'verification',
      'scope',
      'completion',
      'remote',
    ]);
  });

  it('forbids unknown properties at the top level and inside every section', () => {
    const schema = buildRepoProfileJsonSchema() as {
      additionalProperties: unknown;
      properties: Record<string, { additionalProperties?: unknown }>;
    };
    expect(schema.additionalProperties).toBe(false);
    for (const [name, section] of Object.entries(schema.properties)) {
      if (name === 'schemaVersion') continue;
      expect(section.additionalProperties, `${name} must refuse unknown keys`).toBe(false);
    }
  });

  it('carries the capability and phase vocabularies', () => {
    const schema = buildRepoProfileJsonSchema() as {
      properties: {
        capabilities: { properties: { codegraph: { enum: string[] } } };
        verification: {
          properties: { phases: { items: { properties: { phase: { enum: string[] } } } } };
        };
      };
    };
    expect(schema.properties.capabilities.properties.codegraph.enum).toEqual([
      'REQUIRED',
      'OPTIONAL',
    ]);
    expect(schema.properties.verification.properties.phases.items.properties.phase.enum).toEqual([
      'BUILD',
      'TEST',
      'VERIFY',
    ]);
  });

  it('ends with a trailing newline so the file is diff-friendly', () => {
    expect(renderRepoProfileJsonSchema().endsWith('}\n')).toBe(true);
  });
});

describe('repository-profile internal API', () => {
  it('keeps the structural schema out of every public repo module', () => {
    for (const moduleNamespace of [
      repoProfileModule,
      repoJsonSchemaModule,
      resolveRepositoryModule,
    ]) {
      expect(moduleNamespace).not.toHaveProperty('RepoProfileObjectSchema');
    }
  });

  it('is re-exported from no module outside src/repo/internal', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith('.ts')) {
          if (full.includes(`${sep}internal${sep}`)) continue;
          if (/export\s*\{[^}]*RepoProfileObjectSchema/.test(readFileSync(full, 'utf8'))) {
            offenders.push(relative(PACKAGE_ROOT, full));
          }
        }
      }
    };
    walk(join(PACKAGE_ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
