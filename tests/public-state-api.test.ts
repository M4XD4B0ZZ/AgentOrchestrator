/**
 * AO-009-R1: the public state runtime entry exports exactly three values.
 *
 * These tests pin the surface rather than merely forbidding one bad export.
 * Before the remediation, `src/core/task-state.ts` also re-exported
 * `FindingRecordSchema`, `GitShaSchema`, `IsoDateTimeSchema`,
 * `ResumePointSchema`, `MAX_ROUND`, the contract-version constant and an
 * internal evidence helper — every one of which would have become a promise
 * the package could never take back, and three of which are *weaker*
 * validators that bypass the contract's cross-field invariants.
 *
 * The exact-equality assertion below is the point: adding anything new to the
 * public entry fails this test until the addition is a deliberate decision.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_ROOT } from '../src/config/paths.js';
import * as publicStateApi from '../src/core/task-state.js';

/** The complete, closed list of public runtime exports. */
const ALLOWED_RUNTIME_EXPORTS = ['TaskStateSchema', 'parseTaskState', 'safeParseTaskState'].sort();

/** Values that used to be re-exported here and must not come back. */
const FORBIDDEN_EXPORTS = [
  'FindingRecordSchema',
  'GitShaSchema',
  'IsoDateTimeSchema',
  'ResumePointSchema',
  'RoundSchema',
  'MAX_ROUND',
  'TASK_STATE_SCHEMA_VERSION',
  'TaskStateObjectSchema',
  'NonBlankString',
  'GIT_SHA_PATTERN',
  'listMissingPreferredEvidence',
] as const;

describe('public state runtime API', () => {
  it('exports exactly TaskStateSchema, parseTaskState and safeParseTaskState', () => {
    expect(Object.keys(publicStateApi).sort()).toEqual(ALLOWED_RUNTIME_EXPORTS);
  });

  it('exposes the three entries as usable values', () => {
    expect(publicStateApi.TaskStateSchema).toBeDefined();
    expect(typeof publicStateApi.parseTaskState).toBe('function');
    expect(typeof publicStateApi.safeParseTaskState).toBe('function');
  });

  it.each(FORBIDDEN_EXPORTS)('does not export %s', (name) => {
    expect(publicStateApi).not.toHaveProperty(name);
  });

  it('names none of the withdrawn values in an export clause of the module', () => {
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'core', 'task-state.ts'), 'utf8');
    const exportClauses = source.match(/export\s*(?:type\s*)?\{[^}]*\}/g) ?? [];
    for (const clause of exportClauses) {
      for (const forbidden of FORBIDDEN_EXPORTS) {
        expect(clause).not.toContain(forbidden);
      }
    }
  });

  it('re-exports nothing from another module at all', () => {
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'core', 'task-state.ts'), 'utf8');
    expect(source).not.toMatch(/export\s*(?:type\s*)?\{[^}]*\}\s*from\s*['"]/);
    expect(source).not.toMatch(/export\s+\*\s+from/);
  });
});

describe('the built package offers no other way in', () => {
  it('exposes only the CLI entry and the generated schema in package exports', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(
      ['.', './schemas/task-state.schema.json'].sort(),
    );
  });

  it('publishes no wildcard subpath that would expose dist/core/**', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    for (const subpath of Object.keys(manifest.exports ?? {})) {
      expect(subpath).not.toContain('*');
      expect(subpath).not.toContain('core');
      expect(subpath).not.toContain('internal');
    }
  });
});
