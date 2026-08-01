/**
 * Deterministic JSON Schema generation for the task-state contract.
 *
 * Uses Zod 4's native `z.toJSONSchema()`. No third-party zod-to-json-schema
 * package is involved, so the emitted document can never drift from the Zod
 * version in use.
 */

import { z } from 'zod';

// The *internal* structural schema is imported deliberately: JSON Schema
// cannot express the cross-field invariants, so the document is generated from
// the plain shape. This module is the only consumer outside `task-state.ts`
// (AO-009) — the weaker schema stays unreachable from the public API.
import {
  TASK_STATE_SCHEMA_VERSION,
  TaskStateObjectSchema,
} from './internal/task-state-object-schema.js';

export const TASK_STATE_SCHEMA_ID =
  'https://agent-orchestrator.local/schemas/task-state.schema.json';

/**
 * Builds the JSON Schema document for the task state.
 *
 * The document is generated from the *object* schema, not the refined one:
 * cross-field invariants (for example "BLOCKED_USAGE_LIMIT requires a
 * resumeFrom") are not expressible in JSON Schema, so they stay in Zod and are
 * only described in prose here.
 */
export function buildTaskStateJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(TaskStateObjectSchema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  // Strip the generated `$schema` so we control key order deterministically.
  const { $schema: _ignored, ...rest } = generated;

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: TASK_STATE_SCHEMA_ID,
    title: 'AgentOrchestrator single-task state',
    description:
      `Structural contract for a single orchestrated task (contract version ${TASK_STATE_SCHEMA_VERSION}). ` +
      'Generated from the Zod schema in src/core/task-state.ts by `npm run schema:generate` — do not edit by hand. ' +
      'State-dependent invariants (blockedAgent/resumeFrom consistency, review-budget bounds, ' +
      'terminal-state settlement) are NOT expressible in JSON Schema and are enforced only by ' +
      'TaskStateSchema at runtime.',
    ...rest,
  };
}

/** The exact bytes that must be on disk at `schemas/task-state.schema.json`. */
export function renderTaskStateJsonSchema(): string {
  return `${JSON.stringify(buildTaskStateJsonSchema(), null, 2)}\n`;
}
