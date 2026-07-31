/**
 * The binding single-task state contract.
 *
 * Zod is the single source of truth. `schemas/task-state.schema.json` is
 * *generated* from this file by `npm run schema:generate` and must never be
 * edited by hand — a test fails if the two drift apart.
 *
 * Two schemas are exported:
 *   - {@link TaskStateObjectSchema} — the plain object shape. This is what the
 *     JSON Schema is generated from, because cross-field invariants are not
 *     expressible in JSON Schema.
 *   - {@link TaskStateSchema} — the object shape *plus* the state-dependent
 *     invariants. This is what runtime validation must use.
 */

import { z } from 'zod';

import {
  AGENT_IDS,
  ALL_STATES,
  FINDING_SEVERITIES,
  RESUME_PHASES,
  getStateKind,
  isBlockingState,
} from './states.js';
import { BLOCKED_STATE_POLICIES } from './resume-policy.js';

/** Current version of this contract. Bump on any breaking shape change. */
export const TASK_STATE_SCHEMA_VERSION = 1;

/**
 * A full Git object name. Accepts SHA-1 (40 hex) and SHA-256 (64 hex) so the
 * contract does not break on `objectFormat=sha256` repositories.
 * Abbreviated SHAs are rejected on purpose: pinning must be unambiguous.
 */
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const GitShaSchema = z
  .string()
  .regex(GIT_SHA_PATTERN, 'Must be a full lowercase hex Git object name (40 or 64 characters).');

/** ISO-8601 timestamp; a UTC `Z` suffix or a numeric offset are both accepted. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Non-empty, non-blank identifier. */
const NonBlankString = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty.`)
    .refine((value) => value.trim().length > 0, `${label} must not be blank.`);

/**
 * A structured re-entry point. `IMPLEMENT_ROUND_1` and friends are expressible
 * as `{ phase: "IMPLEMENT", round: 1 }`; the round is a number, never a
 * substring, so it can be compared against `maxReviewRounds`.
 */
export const ResumePointSchema = z
  .object({
    phase: z.enum(RESUME_PHASES),
    round: z.int().min(1, 'Resume round must be at least 1.'),
  })
  .strict();

export const FindingRecordSchema = z
  .object({
    round: z.int().min(1, 'Finding round must be at least 1.'),
    severity: z.enum(FINDING_SEVERITIES),
    /**
     * Stable identity of a finding across review rounds, used later to detect
     * repeat findings. The actual fingerprint computation is intentionally not
     * part of this foundation — only the field contract is fixed here.
     */
    fingerprint: NonBlankString('fingerprint'),
  })
  .strict();

/** Plain object shape, without cross-field invariants. */
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

    reviewRound: z.int().min(0, 'reviewRound must be 0 or greater.'),
    maxReviewRounds: z.int().positive('maxReviewRounds must be a positive integer.'),

    blockedAgent: z.enum(AGENT_IDS).nullable(),
    resumeFrom: ResumePointSchema.nullable(),
    /** Quota reset time reported by an agent CLI, never invented by us. */
    reportedResetAt: IsoDateTimeSchema.nullable(),

    worktreeCleanAtCheckpoint: z.boolean(),

    findingHistory: z.array(FindingRecordSchema),
  })
  .strict();

export type TaskStateInput = z.input<typeof TaskStateObjectSchema>;
export type TaskState = z.infer<typeof TaskStateObjectSchema>;

/**
 * The state-dependent invariants that JSON Schema cannot express.
 *
 * Each rule below corresponds to a way the loop could otherwise persist a
 * self-contradictory state and then act on it.
 */
export const TaskStateSchema = TaskStateObjectSchema.superRefine((value, ctx) => {
  // --- 1. Contract version ------------------------------------------------
  if (value.schemaVersion !== TASK_STATE_SCHEMA_VERSION) {
    ctx.addIssue({
      code: 'custom',
      path: ['schemaVersion'],
      message:
        `Unsupported schemaVersion ${value.schemaVersion}; ` +
        `this build understands version ${TASK_STATE_SCHEMA_VERSION}.`,
    });
  }

  // --- 2. Review budget ---------------------------------------------------
  if (value.reviewRound > value.maxReviewRounds) {
    ctx.addIssue({
      code: 'custom',
      path: ['reviewRound'],
      message: `reviewRound (${value.reviewRound}) must not exceed maxReviewRounds (${value.maxReviewRounds}).`,
    });
  }

  if (value.resumeFrom !== null && value.resumeFrom.round > value.maxReviewRounds) {
    ctx.addIssue({
      code: 'custom',
      path: ['resumeFrom', 'round'],
      message:
        `resumeFrom.round (${value.resumeFrom.round}) must not exceed ` +
        `maxReviewRounds (${value.maxReviewRounds}).`,
    });
  }

  value.findingHistory.forEach((finding, index) => {
    if (finding.round > value.maxReviewRounds) {
      ctx.addIssue({
        code: 'custom',
        path: ['findingHistory', index, 'round'],
        message:
          `findingHistory[${index}].round (${finding.round}) must not exceed ` +
          `maxReviewRounds (${value.maxReviewRounds}).`,
      });
    }
  });

  // --- 4. Terminal success state must be fully settled --------------------
  if (value.state === 'READY_FOR_PR' && value.resumeFrom !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['resumeFrom'],
      message: 'READY_FOR_PR is terminal and must not carry a pending resumeFrom.',
    });
  }

  // --- 3 + 5. blockedAgent may only appear in blocking states, and each
  //            blocking state has its own evidence requirements.
  const stateName = value.state;
  if (!isBlockingState(stateName)) {
    if (value.blockedAgent !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['blockedAgent'],
        message:
          `State ${stateName} is ${getStateKind(stateName)} and not blocking, ` +
          `so blockedAgent must be null (got "${value.blockedAgent}").`,
      });
    }
  } else {
    const policy = BLOCKED_STATE_POLICIES[stateName];

    if (policy.blockedAgentRequirement === 'REQUIRED' && value.blockedAgent === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['blockedAgent'],
        message: `State ${value.state} requires blockedAgent to name the affected agent.`,
      });
    }

    if (!policy.allowedBlockedAgents.includes(value.blockedAgent)) {
      const allowed = policy.allowedBlockedAgents.map((a) => String(a)).join(', ');
      ctx.addIssue({
        code: 'custom',
        path: ['blockedAgent'],
        message:
          `blockedAgent "${String(value.blockedAgent)}" is not valid for state ${value.state}. ` +
          `Allowed: ${allowed}.`,
      });
    }

    // Every blocking state that can be continued must say where to continue.
    if (policy.resumeFromRequirement === 'REQUIRED' && value.resumeFrom === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['resumeFrom'],
        message:
          `State ${value.state} is resumable and therefore requires a resumeFrom point ` +
          `(e.g. { "phase": "IMPLEMENT", "round": 1 }).`,
      });
    }
  }
});

/** Throws a `ZodError` if the state object violates the contract. */
export function parseTaskState(value: unknown): TaskState {
  return TaskStateSchema.parse(value);
}

/** Non-throwing variant of {@link parseTaskState}. */
export function safeParseTaskState(value: unknown) {
  return TaskStateSchema.safeParse(value);
}

/**
 * `BLOCKED_USAGE_LIMIT` should carry a reported reset time, but not every CLI
 * reports one and we never invent timestamps. This helper surfaces such
 * "preferred but missing" evidence without making the state invalid.
 */
export function listMissingPreferredEvidence(state: TaskState): readonly string[] {
  const stateName = state.state;
  if (!isBlockingState(stateName)) return [];
  const policy = BLOCKED_STATE_POLICIES[stateName];
  const missing: string[] = [];

  if (policy.reportedResetAtRequirement !== 'NOT_APPLICABLE' && state.reportedResetAt === null) {
    missing.push('reportedResetAt');
  }
  if (policy.blockedAgentRequirement === 'PREFERRED' && state.blockedAgent === null) {
    missing.push('blockedAgent');
  }
  return missing;
}
