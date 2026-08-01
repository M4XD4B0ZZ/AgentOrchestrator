/**
 * The binding single-task state contract — the public runtime entry point.
 *
 * Zod is the single source of truth. `schemas/task-state.schema.json` is
 * *generated* from the internal structural schema by `npm run schema:generate`
 * and must never be edited by hand — a test fails if the two drift apart.
 *
 * Public runtime API of this module:
 *   - {@link TaskStateSchema}      — the shape *plus* every state-dependent
 *                                    invariant. The only schema callers may
 *                                    validate against.
 *   - {@link parseTaskState}       — throwing validator.
 *   - {@link safeParseTaskState}   — non-throwing validator.
 *
 * The weaker structural schema is deliberately **not** exported from here; it
 * lives in `core/internal/task-state-object-schema.ts` and is reachable only by
 * the JSON-Schema generator (AO-009).
 */

import { z } from 'zod';

import { getStateKind, isBlockingState } from './states.js';
import { TaskStateObjectSchema } from './internal/task-state-object-schema.js';
import { BLOCKED_STATE_POLICIES } from './resume-policy.js';

export {
  FindingRecordSchema,
  GitShaSchema,
  IsoDateTimeSchema,
} from './internal/task-state-object-schema.js';
export { MAX_ROUND, ResumePointSchema } from './resume-point.js';
export type { ResumePoint } from './resume-point.js';

/** Current version of this contract. Bump on any breaking shape change. */
export const TASK_STATE_SCHEMA_VERSION = 1;

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

  // --- 3. READY_FOR_PR is a terminal *success* state ----------------------
  // Everything a pull request needs must already be settled and provable; a
  // task that still carries block evidence or an unresolved pin never reached
  // this state legitimately (AO-006).
  if (value.state === 'READY_FOR_PR') {
    if (value.basePinnedCommit === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['basePinnedCommit'],
        message: 'READY_FOR_PR requires a resolved basePinnedCommit (full Git object name).',
      });
    }
    if (value.currentCommit === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentCommit'],
        message: 'READY_FOR_PR requires a resolved currentCommit (full Git object name).',
      });
    }
    if (value.worktreeCleanAtCheckpoint !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['worktreeCleanAtCheckpoint'],
        message:
          'READY_FOR_PR requires worktreeCleanAtCheckpoint === true: uncommitted work must not be ' +
          'declared ready for a pull request.',
      });
    }
    if (value.blockedAgent !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['blockedAgent'],
        message: 'READY_FOR_PR is terminal and must not record a blocked agent.',
      });
    }
    if (value.resumeFrom !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['resumeFrom'],
        message: 'READY_FOR_PR is terminal and must not carry a pending resumeFrom.',
      });
    }
    if (value.reportedResetAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reportedResetAt'],
        message: 'READY_FOR_PR is terminal and must not carry a pending quota reset time.',
      });
    }
    if (value.reviewRound < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewRound'],
        message:
          `READY_FOR_PR requires at least one completed review round (got ${value.reviewRound}); ` +
          'the state is only reachable through REVIEWING.',
      });
    }
  }

  // --- 4 + 5. blockedAgent may only appear in blocking states, and each
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

    // --- 6. The resume point must be one the loop can actually reach ------
    // `allowedResumePhases` is derived from the transition table, so the
    // contract and the transition model cannot drift apart (AO-004).
    if (value.resumeFrom !== null) {
      const allowed = policy.allowedResumePhases;
      if (allowed.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['resumeFrom'],
          message:
            `State ${value.state} cannot be continued, so it must not carry a resumeFrom point: ` +
            'a stored re-entry point there would be misleading.',
        });
      } else if (!allowed.includes(value.resumeFrom.phase)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resumeFrom', 'phase'],
          message:
            `resumeFrom.phase "${value.resumeFrom.phase}" is not reachable from ${value.state}. ` +
            `Allowed phases: ${allowed.join(', ')}.`,
        });
      }
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
 *
 * Note that a missing `reportedResetAt` does make an *unattended* resume
 * impossible — see `evaluateAutomaticResume()`.
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
