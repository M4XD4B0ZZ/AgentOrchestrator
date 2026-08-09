/**
 * AO-009: the weaker structural schema must stay internal.
 *
 * `TaskStateObjectSchema` validates the *shape* only. It happily accepts states
 * the contract rejects, so exporting it as runtime API would give callers a
 * validator that silently bypasses every cross-field invariant. These tests
 * fail if it ever becomes reachable from a public module or a barrel file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_ROOT } from '../src/config/paths.js';
import { TaskStateObjectSchema } from '../src/core/internal/task-state-object-schema.js';
import * as taskState from '../src/core/task-state.js';
import * as jsonSchema from '../src/core/json-schema.js';
import * as resumePolicy from '../src/core/resume-policy.js';
import * as automaticResume from '../src/core/automatic-resume.js';
import * as states from '../src/core/states.js';
import * as transitions from '../src/core/transitions.js';
import * as taskDefinition from '../src/plan/task-definition.js';
import { safeParseTaskState } from '../src/core/task-state.js';
import { validReadyForPrState } from './fixtures.js';

const INTERNAL_SEGMENT = `${sep}internal${sep}`;
const SRC_DIR = join(PACKAGE_ROOT, 'src');

/** Every `.ts` file under `src/`, via the checked-in file list. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
    }
  };
  walk(SRC_DIR);
  return files;
}

describe('public runtime API', () => {
  it('does not expose the structural schema from the public state module', () => {
    expect(taskState).not.toHaveProperty('TaskStateObjectSchema');
    expect(Object.keys(taskState)).not.toContain('TaskStateObjectSchema');
  });

  it.each([
    ['core/json-schema', jsonSchema],
    ['core/resume-policy', resumePolicy],
    ['core/automatic-resume', automaticResume],
    ['core/states', states],
    ['core/transitions', transitions],
  ])('does not expose the structural schema from %s', (_label, moduleNamespace) => {
    expect(moduleNamespace).not.toHaveProperty('TaskStateObjectSchema');
  });

  it('exposes the refined schema and the safe parse helpers instead', () => {
    expect(taskState).toHaveProperty('TaskStateSchema');
    expect(typeof taskState.parseTaskState).toBe('function');
    expect(typeof taskState.safeParseTaskState).toBe('function');
  });

  it('re-exports the structural schema from no module outside src/core/internal', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.includes(INTERNAL_SEGMENT)) continue;
      const text = readFileSync(file, 'utf8');
      // An `export { … TaskStateObjectSchema … }` or `export * from` of the
      // internal module would make the weaker schema publicly reachable.
      if (/export\s*\{[^}]*TaskStateObjectSchema/.test(text)) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
      if (/export\s+\*\s+from\s+['"][^'"]*internal\//.test(text)) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('re-exports the structural task-definition schema from no module outside an internal directory', () => {
    // Same rule, same reason, for the V1-02 planning contract:
    // `TaskDefinitionObjectSchema` accepts a task that depends on itself and a
    // `dependsOn` list that repeats an entry, both of which
    // `TaskDefinitionSchema` refuses.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.includes(INTERNAL_SEGMENT)) continue;
      if (/export\s*\{[^}]*TaskDefinitionObjectSchema/.test(readFileSync(file, 'utf8'))) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exposes the refined task-definition schema and its parse helpers instead', () => {
    expect(taskDefinition).not.toHaveProperty('TaskDefinitionObjectSchema');
    expect(taskDefinition).toHaveProperty('TaskDefinitionSchema');
    expect(typeof taskDefinition.parseTaskDefinition).toBe('function');
    expect(typeof taskDefinition.safeParseTaskDefinition).toBe('function');
  });

  it('has no barrel file that could re-export internals wholesale', () => {
    const barrels = sourceFiles().filter((file) => file.endsWith(`${sep}index.ts`));
    // The CLI entry point is the only `index.ts`, and it exports a program
    // builder, not schemas.
    expect(barrels.map((f) => relative(PACKAGE_ROOT, f))).toEqual([join('src', 'cli', 'index.ts')]);
  });

  it('offers no deep import path in package.json exports', () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { exports?: Record<string, unknown> };
    const paths = Object.keys(manifest.exports ?? {});
    expect(paths).not.toContain('./*');
    expect(paths.some((p) => p.includes('core'))).toBe(false);
    expect(paths.some((p) => p.includes('internal'))).toBe(false);
  });
});

describe('why the structural schema must stay internal', () => {
  it('accepts a READY_FOR_PR state that the contract rejects', () => {
    const unsettled = validReadyForPrState({ basePinnedCommit: null, currentCommit: null });

    // The structural schema is happy …
    expect(TaskStateObjectSchema.safeParse(unsettled).success).toBe(true);
    // … while the contract is not. That gap is exactly the hazard.
    expect(safeParseTaskState(unsettled).success).toBe(false);
  });

  it('accepts a resume point the loop can never reach', () => {
    const unreachable = validReadyForPrState({
      state: 'BLOCKED_USAGE_LIMIT',
      blockedAgent: 'claude',
      resumeFrom: { phase: 'VERIFY', round: 1 },
    });
    expect(TaskStateObjectSchema.safeParse(unreachable).success).toBe(true);
    expect(safeParseTaskState(unreachable).success).toBe(false);
  });
});
