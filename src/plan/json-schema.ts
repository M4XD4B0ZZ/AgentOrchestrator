/**
 * Deterministic JSON Schema generation for the task-definition contract.
 *
 * Uses Zod 4's native `z.toJSONSchema()`, exactly as the task-state and
 * repository-profile documents do, so the emitted document can never drift from
 * the Zod version in use. The shipped document lets an editor, a CI lint step
 * or a human validate a task file's frontmatter without running this
 * orchestrator.
 *
 * The document is generated from the *internal object* schema rather than from
 * the refined one, for the same reason as everywhere else: the cross-field
 * invariants — a `dependsOn` list that repeats an entry, a task that depends on
 * itself — are not expressible in JSON Schema. They stay in Zod and are only
 * described in prose below. A document that silently *appeared* to enforce them
 * would be worse than one that says it does not.
 */

import { z } from 'zod';

// The *internal* structural schema is imported deliberately, mirroring
// `core/json-schema.ts` and `repo/json-schema.ts`. This module is the only
// consumer outside `task-definition.ts` — the weaker schema stays unreachable
// from the validating API.
import { TaskDefinitionObjectSchema } from './internal/task-definition-object-schema.js';

export const TASK_DEFINITION_SCHEMA_ID =
  'https://agent-orchestrator.local/schemas/task-definition.schema.json';

/** Builds the JSON Schema document for one task file's frontmatter. */
export function buildTaskDefinitionJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(TaskDefinitionObjectSchema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  // Strip the generated `$schema` so we control key order deterministically.
  const { $schema: _ignored, ...rest } = generated;

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: TASK_DEFINITION_SCHEMA_ID,
    title: 'AgentOrchestrator task definition',
    description:
      'Structural contract for the YAML frontmatter of one task file in a repository’s ' +
      'MARKDOWN_DIRECTORY task source. Generated from the Zod schema in src/plan/task-definition.ts ' +
      'by `npm run schema:generate` — do not edit by hand. This is the *static plan*, not the ' +
      'runtime state: it is deliberately unrelated to task-state.schema.json, shares no field with ' +
      'it, and carries no schema version because it is read from a repository rather than persisted ' +
      'by the orchestrator. Cross-field invariants (a duplicate-free dependsOn list, no ' +
      'self-dependency) and the task-id grammar beyond "a string" are NOT expressible in JSON Schema ' +
      'and are enforced only by TaskDefinitionSchema at runtime. Graph-wide rules — unique ids, ' +
      'dependencies that resolve, no cycles — belong to src/plan/task-graph.ts and are not ' +
      'properties of a single document at all.',
    ...rest,
  };
}

/** The exact bytes that must be on disk at `schemas/task-definition.schema.json`. */
export function renderTaskDefinitionJsonSchema(): string {
  return `${JSON.stringify(buildTaskDefinitionJsonSchema(), null, 2)}\n`;
}
