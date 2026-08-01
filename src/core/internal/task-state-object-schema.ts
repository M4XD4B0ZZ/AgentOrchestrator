/**
 * INTERNAL — not part of the public runtime API.
 *
 * This module holds the *plain object shape* of the task state: field types
 * only, no cross-field invariants. It exists for exactly two consumers:
 *
 *  1. JSON Schema generation (`core/json-schema.ts`), because JSON Schema
 *     cannot express state-dependent invariants; and
 *  2. composition inside `core/task-state.ts`, which layers those invariants
 *     on top and exposes the result as `TaskStateSchema`.
 *
 * It must never be re-exported from a public module or a barrel file (AO-009).
 * `TaskStateObjectSchema.parse()` accepts states that the contract rejects — a
 * `READY_FOR_PR` with an unresolved base commit, a `BLOCKED_USAGE_LIMIT`
 * without a resume point, a resume point in a phase the loop cannot reach — so
 * handing it to callers as a validator would quietly bypass the contract.
 *
 * Use `TaskStateSchema`, `parseTaskState()` or `safeParseTaskState()` instead.
 * `tests/internal-api.test.ts` fails if this schema becomes publicly reachable.
 */

import { z } from 'zod';

import { AGENT_IDS, ALL_STATES, FINDING_SEVERITIES } from '../states.js';
import { ResumePointSchema, RoundSchema } from '../resume-point.js';

/**
 * A full Git object name. Accepts SHA-1 (40 hex) and SHA-256 (64 hex) so the
 * contract does not break on `objectFormat=sha256` repositories.
 * Abbreviated SHAs are rejected on purpose: pinning must be unambiguous.
 */
export const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const GitShaSchema = z
  .string()
  .regex(GIT_SHA_PATTERN, 'Must be a full lowercase hex Git object name (40 or 64 characters).');

/** ISO-8601 timestamp; a UTC `Z` suffix or a numeric offset are both accepted. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Non-empty, non-blank identifier. */
export const NonBlankString = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty.`)
    .refine((value) => value.trim().length > 0, `${label} must not be blank.`);

export const FindingRecordSchema = z
  .object({
    round: RoundSchema('Finding round', 1),
    severity: z.enum(FINDING_SEVERITIES),
    /**
     * Stable identity of a finding across review rounds, used later to detect
     * repeat findings. The actual fingerprint computation is intentionally not
     * part of this foundation — only the field contract is fixed here.
     */
    fingerprint: NonBlankString('fingerprint'),
  })
  .strict();

/** Plain object shape, without cross-field invariants. INTERNAL. */
export const TaskStateObjectSchema = z
  .object({
    schemaVersion: z.int().positive('schemaVersion must be a positive integer.'),

    taskId: NonBlankString('taskId'),
    repositoryId: NonBlankString('repositoryId'),

    /**
     * Filesystem locations. No drive letter, platform or existence assumption
     * is made here — existence is a preflight concern, not a schema concern.
     */
    repositoryRoot: NonBlankString('repositoryRoot'),
    worktreePath: NonBlankString('worktreePath'),

    state: z.enum(ALL_STATES),
    stateEnteredAt: IsoDateTimeSchema,

    baseBranch: NonBlankString('baseBranch'),
    /** Full SHA the work is pinned to, or `null` before it has been resolved. */
    basePinnedCommit: GitShaSchema.nullable(),
    workBranch: NonBlankString('workBranch'),
    /** Head of the work branch, or `null` before the first commit exists. */
    currentCommit: GitShaSchema.nullable(),

    reviewRound: RoundSchema('reviewRound', 0),
    maxReviewRounds: RoundSchema('maxReviewRounds', 1),

    blockedAgent: z.enum(AGENT_IDS).nullable(),
    resumeFrom: ResumePointSchema.nullable(),
    /** Quota reset time reported by an agent CLI, never invented by us. */
    reportedResetAt: IsoDateTimeSchema.nullable(),

    worktreeCleanAtCheckpoint: z.boolean(),

    findingHistory: z.array(FindingRecordSchema),
  })
  .strict();
