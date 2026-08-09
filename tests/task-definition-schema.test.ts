/**
 * The generated `schemas/task-definition.schema.json`, and the boundary it must
 * not cross.
 *
 * Two things are pinned here. First, the usual generated-document contract:
 * one Zod source, deterministic bytes, and a drift check against the file on
 * disk. Second — and this is the reason the suite exists at all — that adding a
 * *planning* contract changed nothing about the *state* contract. V1-02 was
 * explicitly not allowed to turn `TaskState` into a task register, so the
 * evidence that it did not is a test rather than a promise.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  TASK_DEFINITION_SCHEMA_FILE,
  TASK_STATE_SCHEMA_FILE,
} from '../src/config/paths.js';
import {
  buildTaskDefinitionJsonSchema,
  renderTaskDefinitionJsonSchema,
} from '../src/plan/json-schema.js';
import { renderTaskStateJsonSchema } from '../src/core/json-schema.js';
import { TASK_STATE_SCHEMA_VERSION } from '../src/core/internal/task-state-object-schema.js';
import {
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '../src/plan/internal/task-definition-object-schema.js';

describe('generated task-definition JSON Schema', () => {
  it('is deterministic across runs', () => {
    expect(renderTaskDefinitionJsonSchema()).toBe(renderTaskDefinitionJsonSchema());
  });

  it('matches the file checked in at schemas/task-definition.schema.json', () => {
    expect(readFileSync(TASK_DEFINITION_SCHEMA_FILE, 'utf8')).toBe(
      renderTaskDefinitionJsonSchema(),
    );
  });

  it('declares exactly the seven frontmatter fields as required', () => {
    expect(buildTaskDefinitionJsonSchema()['required']).toEqual([
      'id',
      'title',
      'status',
      'kind',
      'priority',
      'currentFocus',
      'dependsOn',
    ]);
  });

  it('forbids unknown properties', () => {
    expect(buildTaskDefinitionJsonSchema()['additionalProperties']).toBe(false);
  });

  it('carries the closed vocabularies', () => {
    const schema = buildTaskDefinitionJsonSchema() as {
      properties: {
        status: { enum: string[] };
        kind: { enum: string[] };
        priority: { enum: string[] };
        currentFocus: { type: string };
      };
    };
    expect(schema.properties.status.enum).toEqual([...TASK_STATUSES]);
    expect(schema.properties.kind.enum).toEqual([...TASK_KINDS]);
    expect(schema.properties.priority.enum).toEqual([...TASK_PRIORITIES]);
    expect(schema.properties.currentFocus.type).toBe('boolean');
  });

  it('models dependsOn as an array of identifiers', () => {
    const schema = buildTaskDefinitionJsonSchema() as {
      properties: { dependsOn: { type: string; items: { type: string } } };
    };
    expect(schema.properties.dependsOn.type).toBe('array');
    expect(schema.properties.dependsOn.items.type).toBe('string');
  });

  it('has its own $id, distinct from the state contract', () => {
    const id = buildTaskDefinitionJsonSchema()['$id'];
    expect(typeof id).toBe('string');
    expect(id).toContain('task-definition');
    expect(id).not.toContain('task-state');
  });

  it('ends with a trailing newline so the file is diff-friendly', () => {
    expect(renderTaskDefinitionJsonSchema().endsWith('}\n')).toBe(true);
  });
});

describe('the task-state contract is untouched by V1-02', () => {
  it('still renders byte-for-byte the file on disk', () => {
    expect(readFileSync(TASK_STATE_SCHEMA_FILE, 'utf8')).toBe(renderTaskStateJsonSchema());
  });

  it('did not bump its schema version', () => {
    expect(TASK_STATE_SCHEMA_VERSION).toBe(1);
  });

  it('gained no planning field', () => {
    const state = JSON.parse(readFileSync(TASK_STATE_SCHEMA_FILE, 'utf8')) as {
      properties: Record<string, unknown>;
    };
    for (const planningField of ['dependsOn', 'priority', 'currentFocus', 'kind', 'title']) {
      expect(Object.keys(state.properties), planningField).not.toContain(planningField);
    }
  });

  it('and the definition contract gained no runtime field', () => {
    const definition = buildTaskDefinitionJsonSchema() as { properties: Record<string, unknown> };
    for (const runtimeField of [
      'state',
      'stateEnteredAt',
      'reviewRound',
      'maxReviewRounds',
      'resumeFrom',
      'worktreePath',
      'repositoryRoot',
      'findingHistory',
      'schemaVersion',
    ]) {
      expect(Object.keys(definition.properties), runtimeField).not.toContain(runtimeField);
    }
  });
});
