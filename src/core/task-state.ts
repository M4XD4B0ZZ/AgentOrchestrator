/**
 * The binding single-task state contract — the public runtime entry point.
 *
 * Zod is the single source of truth. `schemas/task-state.schema.json` is
 * *generated* from the internal structural schema by `npm run schema:generate`
 * and must never be edited by hand — a test fails if the two drift apart.
 *
 * ── The public runtime surface (AO-009-R1) ─────────────────────────────────
 *
 * This module exports exactly three runtime values:
 *
 *   - {@link TaskStateSchema}      — the shape *plus* every state-dependent
 *                                    invariant. The only schema callers may
 *                                    validate against.
 *   - {@link parseTaskState}       — throwing validator.
 *   - {@link safeParseTaskState}   — non-throwing validator.
 *
 * …plus the two TypeScript types a caller needs to *use* those three:
 * {@link TaskState} (what comes out) and {@link TaskStateInput} (what goes in).
 * Types are erased at build time and add nothing to the runtime surface.
 *
 * Everything else stays internal and is not re-exported from here: the weaker
 * structural schema, the field-level schemas (`GitShaSchema`,
 * `IsoDateTimeSchema`, `FindingRecordSchema`), `ResumePointSchema`,
 * `MAX_ROUND`, the contract-version constant and the evidence helper.
 * Internal modules import them from their own modules directly.
 *
 * The reason is not tidiness. Every value exported here becomes a promise:
 * a caller that validates with a *field* schema, or with the structural schema,
 * bypasses the cross-field invariants that make a state trustworthy — and once
 * that is public API it can never be changed. `tests/public-state-api.test.ts`
 * pins the exact export set.
 */

import { z } from 'zod';

import { getStateKind, isBlockingState, isWorkLoopState } from './states.js';
import {
  TASK_STATE_SCHEMA_VERSION,
  TaskStateObjectSchema,
} from './internal/task-state-object-schema.js';
import { BLOCKED_STATE_POLICIES } from './resume-policy.js';

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

  // --- 3b. OPERATOR_RESOLVED carries its own provenance, and only it does --
  //
  // A biconditional, in both directions, and it is the whole of what keeps this
  // state from being a force-complete switch. The state may not exist without
  // naming the refusal it overrode, and the provenance may not be attached to
  // any other state as decoration — a record carrying `operatorResolution` while
  // claiming to be `READY_FOR_PR` would be a machine success wearing an
  // operator's authority.
  //
  // What is deliberately NOT required here, and why: a resolved `currentCommit`,
  // a clean checkpoint and a completed review round. Those are `READY_FOR_PR`'s
  // demands because that state is this build's own claim that the work is
  // finished and provable. This state claims only that a person ended the task,
  // and requiring evidence of success would either force the operator to forge
  // it or make the state unreachable in exactly the cases that need it most.
  if (value.state === 'OPERATOR_RESOLVED') {
    if (value.operatorResolution === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['operatorResolution'],
        message:
          'OPERATOR_RESOLVED requires operatorResolution: the state must name the refusal an ' +
          'operator overrode.',
      });
    }
    if (value.resumeFrom !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['resumeFrom'],
        message: 'OPERATOR_RESOLVED is terminal and must not carry a pending resumeFrom.',
      });
    }
    if (value.reportedResetAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reportedResetAt'],
        message: 'OPERATOR_RESOLVED is terminal and must not carry a pending quota reset time.',
      });
    }
  } else if (value.operatorResolution !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['operatorResolution'],
      message:
        `State ${value.state} must not carry operatorResolution: only OPERATOR_RESOLVED records ` +
        'an operator ending the task.',
    });
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

    // --- 7. Resume-only evidence does not survive into the work loop -------
    // A `resumeFrom` point says where to continue *after a pause*, and a
    // `reportedResetAt` says when a quota pause ends. A task recorded in one of
    // the four work-loop states is executing, not paused: reaching the state a
    // resume point names *is* the continuation it asked for, so the point has
    // been spent, and a running task is not waiting on anyone's quota.
    //
    // Nothing but a schema rule would catch a stale one. Every write in this
    // codebase is a `{ ...state, … }` spread, and three of the loop's own
    // writes name neither field; without this, a point left over from an
    // earlier block rides `REMEDIATING → VERIFYING → REVIEWING → REMEDIATING`
    // indefinitely, and an elapsed reset time sits on a running task waiting to
    // be read as "the quota has cleared" by the next resume decision. Both are
    // records of a continuation that has already happened.
    //
    // Deliberately scoped to the work loop rather than to every non-blocking
    // state: `BLOCKED_AUTH → AUTH_PREFLIGHT → GIT_PREFLIGHT → WORKTREE_READY →
    // CONTEXT_LOADING` is the declared path a re-authenticated task walks, and
    // `resume-policy.ts` requires the stored point to survive it. `reconcile.ts`
    // additionally reads it there as evidence that work precedes this phase.
    if (isWorkLoopState(stateName)) {
      if (value.resumeFrom !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['resumeFrom'],
          message:
            `State ${stateName} is a work-loop state, and reaching it consumes the resume point ` +
            'that led there, so resumeFrom must be null.',
        });
      }
      if (value.reportedResetAt !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['reportedResetAt'],
          message:
            `State ${stateName} is running rather than waiting on a quota, ` +
            'so it must not carry a reported quota reset time.',
        });
      }
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
