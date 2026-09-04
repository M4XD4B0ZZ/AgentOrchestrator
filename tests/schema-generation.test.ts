import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TASK_STATE_SCHEMA_FILE } from '../src/config/paths.js';
import {
  buildTaskStateJsonSchema,
  renderTaskStateJsonSchema,
} from '../src/core/json-schema.js';
import { ALL_STATES, FINDING_SEVERITIES, RESUME_PHASES } from '../src/core/states.js';

describe('generated JSON Schema', () => {
  it('is deterministic across runs', () => {
    expect(renderTaskStateJsonSchema()).toBe(renderTaskStateJsonSchema());
  });

  it('matches the file checked in at schemas/task-state.schema.json', () => {
    const onDisk = readFileSync(TASK_STATE_SCHEMA_FILE, 'utf8');
    expect(onDisk).toBe(renderTaskStateJsonSchema());
  });

  it('declares every mandatory field as required', () => {
    const schema = buildTaskStateJsonSchema();
    // `scopeAuthorityCommit` is defaulted on the *input* side and therefore
    // required here, because this document is generated with `io: 'output'` and
    // describes a state after parsing. The two are not in tension: a state
    // written before the field existed still parses, and parsing is what fills
    // it in with the `null` that means "this task's own base pin governs".
    expect(schema['required']).toEqual([
      'schemaVersion',
      'taskId',
      'repositoryId',
      'repositoryRoot',
      'worktreePath',
      'state',
      'stateEnteredAt',
      'baseBranch',
      'basePinnedCommit',
      'scopeAuthorityCommit',
      'workBranch',
      'currentCommit',
      'reviewRound',
      'maxReviewRounds',
      'blockedAgent',
      'resumeFrom',
      'reportedResetAt',
      'worktreeCleanAtCheckpoint',
      // M8's provenance field, required here for the same reason the field
      // above it is: defaulted on the input side, so a state written before it
      // existed still parses, and parsing fills it with the `null` that means
      // no operator ever ended this task.
      'operatorResolution',
      'findingHistory',
    ]);
  });

  it('forbids unknown properties', () => {
    expect(buildTaskStateJsonSchema()['additionalProperties']).toBe(false);
  });

  it('carries the full state vocabulary', () => {
    const schema = buildTaskStateJsonSchema() as {
      properties: { state: { enum: string[] } };
    };
    expect(schema.properties.state.enum).toEqual([...ALL_STATES]);
  });

  it('models resumeFrom structurally, not as a free-form string', () => {
    const schema = buildTaskStateJsonSchema() as {
      properties: { resumeFrom: { anyOf: Array<Record<string, unknown>> } };
    };
    const objectVariant = schema.properties.resumeFrom.anyOf.find((v) => v['type'] === 'object') as
      | { properties: { phase: { enum: string[] }; round: { minimum: number } } }
      | undefined;

    expect(objectVariant).toBeDefined();
    expect(objectVariant?.properties.phase.enum).toEqual([...RESUME_PHASES]);
    expect(objectVariant?.properties.round.minimum).toBe(1);
    expect(schema.properties.resumeFrom.anyOf.some((v) => v['type'] === 'null')).toBe(true);
  });

  it('constrains findingHistory entries', () => {
    const schema = buildTaskStateJsonSchema() as {
      properties: {
        findingHistory: {
          items: { required: string[]; properties: { severity: { enum: string[] } } };
        };
      };
    };
    expect(schema.properties.findingHistory.items.required.sort()).toEqual([
      'fingerprint',
      'round',
      'severity',
    ]);
    expect(schema.properties.findingHistory.items.properties.severity.enum).toEqual([
      ...FINDING_SEVERITIES,
    ]);
  });

  it('ends with a trailing newline so the file is diff-friendly', () => {
    expect(renderTaskStateJsonSchema().endsWith('}\n')).toBe(true);
  });
});
