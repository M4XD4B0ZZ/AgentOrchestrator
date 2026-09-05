/**
 * The repository-profile contract: the declarative agreement between a target
 * repository and the orchestrator.
 *
 * A profile answers, for one repository and without any project-specific code
 * in the orchestrator: who this repository is, which branch it works from,
 * where its tasks come from, which documents count as canonical context, which
 * capabilities it needs, how it is verified, which paths may be written and
 * which must not be, how many review rounds it grants, and whether it expects a
 * remote at all.
 *
 * Nothing here *acts* on any of that. V1-01 loads, validates and freezes the
 * contract; discovery, context loading, verification and scope enforcement are
 * later steps that read the value produced here.
 *
 * Source of truth: this module. `schemas/repo-profile.schema.json` is generated
 * from it (`npm run schema:generate`) and is never edited by hand.
 */

import { z } from 'zod';

import {
  REPO_PROFILE_SCHEMA_VERSION,
  RepoProfileObjectSchema,
  VERIFICATION_PHASES,
} from './internal/repo-profile-object-schema.js';

export { REPO_PROFILE_SCHEMA_VERSION };

/**
 * The phase names a profile may declare, re-exported as this module's own.
 *
 * Modules outside `repo/` read the vocabulary from here rather than reaching
 * into `internal/`, and they read it rather than restating it: a second copy of
 * a closed vocabulary is a copy that can drift from the schema that enforces
 * it, and `verify/verification-pass.ts` stores this value in a document it
 * later prints into an agent's prompt.
 */
export { VERIFICATION_PHASES };

export type RepoProfileInput = z.input<typeof RepoProfileObjectSchema>;
export type RepoProfile = z.infer<typeof RepoProfileObjectSchema>;

/** Reports the first duplicate in `values`, or `null` when all are distinct. */
function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/**
 * The invariants JSON Schema cannot express.
 *
 * Each one closes a way a structurally valid profile could still be
 * self-contradictory, and therefore a way the orchestrator could act on a
 * contract that does not mean what it appears to mean.
 */
export const RepoProfileSchema = RepoProfileObjectSchema.superRefine((value, ctx) => {
  // --- 1. Contract version ------------------------------------------------
  // A profile written against a future contract is refused, never reinterpreted
  // under this build's field meanings.
  if (value.schemaVersion !== REPO_PROFILE_SCHEMA_VERSION) {
    ctx.addIssue({
      code: 'custom',
      path: ['schemaVersion'],
      message:
        `Unsupported schemaVersion ${value.schemaVersion}; ` +
        `this build understands version ${REPO_PROFILE_SCHEMA_VERSION}.`,
    });
  }

  // --- 2. Verification is a set of distinct phases, and VERIFY is the gate --
  const phases = value.verification.phases.map((entry) => entry.phase);
  const duplicatePhase = firstDuplicate(phases);
  if (duplicatePhase !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['verification', 'phases'],
      message: `Verification phase ${duplicatePhase} is declared more than once.`,
    });
  }
  if (!phases.includes('VERIFY')) {
    ctx.addIssue({
      code: 'custom',
      path: ['verification', 'phases'],
      message:
        'verification.phases must declare a VERIFY phase: it is the canonical gate a task is ' +
        'measured against, and a repository without one cannot be completed.',
    });
  }

  // --- 3. Path lists are sets ---------------------------------------------
  // A repeated path is not harmless: it is a sign the profile was assembled
  // from two disagreeing sources, and a later scope decision would depend on
  // which entry it happened to read first.
  const pathLists: ReadonlyArray<readonly [readonly string[], readonly (string | number)[]]> = [
    [value.context.canonicalSources, ['context', 'canonicalSources']],
    [value.scope.allowedPaths, ['scope', 'allowedPaths']],
    [value.scope.protectedPaths, ['scope', 'protectedPaths']],
  ];
  for (const [list, path] of pathLists) {
    const duplicate = firstDuplicate(list);
    if (duplicate !== null) {
      ctx.addIssue({
        code: 'custom',
        path: [...path],
        message: `Path ${JSON.stringify(duplicate)} is declared more than once.`,
      });
    }
  }
});

/** Throwing validator. */
export function parseRepoProfile(value: unknown): RepoProfile {
  return RepoProfileSchema.parse(value);
}

/** Non-throwing validator. */
export function safeParseRepoProfile(
  value: unknown,
): z.ZodSafeParseResult<RepoProfile> {
  return RepoProfileSchema.safeParse(value);
}
