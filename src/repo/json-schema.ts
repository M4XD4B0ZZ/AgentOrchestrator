/**
 * Deterministic JSON Schema generation for the repository-profile contract.
 *
 * Same principle as `core/json-schema.ts`: Zod 4's native `z.toJSONSchema()`,
 * no third-party converter, one canonical Zod source, and a checked-in document
 * that a drift test compares byte for byte.
 */

import { z } from 'zod';

// The *internal* structural schema is imported deliberately: JSON Schema cannot
// express the cross-field invariants, so the document is generated from the
// plain shape. This module is the only consumer outside `repo-profile.ts` — the
// weaker schema stays unreachable from the public API.
import {
  REPO_PROFILE_SCHEMA_VERSION,
  RepoProfileObjectSchema,
} from './internal/repo-profile-object-schema.js';

export const REPO_PROFILE_SCHEMA_ID =
  'https://agent-orchestrator.local/schemas/repo-profile.schema.json';

export function buildRepoProfileJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(RepoProfileObjectSchema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  // Strip the generated `$schema` so we control key order deterministically.
  const { $schema: _ignored, ...rest } = generated;

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: REPO_PROFILE_SCHEMA_ID,
    title: 'AgentOrchestrator repository profile',
    description:
      `Declarative contract between a target repository and the orchestrator (contract version ${REPO_PROFILE_SCHEMA_VERSION}). ` +
      'Lives at .agent-orchestrator/repo-profile.yaml inside the repository. ' +
      'Generated from the Zod schema in src/repo/repo-profile.ts by `npm run schema:generate` — do not edit by hand. ' +
      'Cross-field invariants (supported schemaVersion, distinct verification phases, a mandatory VERIFY ' +
      'phase, duplicate-free path lists) are NOT expressible in JSON Schema and are enforced only by ' +
      'RepoProfileSchema at runtime. Path containment against the canonical repository root, branch-name ' +
      'grammar and branch existence are enforced by the repository resolver.',
    ...rest,
  };
}

/** The exact bytes that must be on disk at `schemas/repo-profile.schema.json`. */
export function renderRepoProfileJsonSchema(): string {
  return `${JSON.stringify(buildRepoProfileJsonSchema(), null, 2)}\n`;
}
