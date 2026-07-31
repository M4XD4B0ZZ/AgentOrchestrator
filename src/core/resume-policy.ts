/**
 * Pure policy layer describing what each blocking state *means* for resuming.
 *
 * This module answers four questions per blocking state:
 *   1. which agent may be recorded as the blocked one,
 *   2. whether a `resumeFrom` point is required,
 *   3. whether an automatic (unattended) resume is permissible at all,
 *   4. whether a human decision is required first.
 *
 * There is deliberately **no resume runner here** — this module only describes
 * and validates. Executing a resume is out of scope for the foundation.
 */

import {
  isBlockingState,
  type AgentId,
  type BlockingState,
  type ResumePhase,
  type TaskStateName,
} from './states.js';
import { InvalidResumePointError } from './errors.js';

/** A structured re-entry point: phase plus 1-based review round. */
export interface ResumePoint {
  readonly phase: ResumePhase;
  readonly round: number;
}

/** How strongly a piece of evidence is required for a blocking state. */
export type EvidenceRequirement = 'REQUIRED' | 'PREFERRED' | 'NOT_APPLICABLE';

export interface BlockedStatePolicy {
  readonly state: BlockingState;
  /** Can this state, in principle, ever be continued? */
  readonly resumable: boolean;
  /** May the orchestrator resume without asking a human? */
  readonly automaticResumeAllowed: boolean;
  /** Must a human make a decision before anything continues? */
  readonly requiresHumanDecision: boolean;
  /** Agents that may legitimately be recorded as blocked in this state. */
  readonly allowedBlockedAgents: readonly (AgentId | null)[];
  /** Must `blockedAgent` be non-null? */
  readonly blockedAgentRequirement: EvidenceRequirement;
  /** Must `resumeFrom` be non-null? */
  readonly resumeFromRequirement: EvidenceRequirement;
  /** Must `reportedResetAt` be non-null? */
  readonly reportedResetAtRequirement: EvidenceRequirement;
  readonly rationale: string;
}

export const BLOCKED_STATE_POLICIES: Readonly<Record<BlockingState, BlockedStatePolicy>> =
  Object.freeze({
    BLOCKED_AUTH: {
      state: 'BLOCKED_AUTH',
      resumable: true,
      // A human has to re-authenticate; the orchestrator must never attempt a
      // login itself, so it can never clear this state on its own.
      automaticResumeAllowed: false,
      requiresHumanDecision: true,
      allowedBlockedAgents: ['claude', 'codex'],
      blockedAgentRequirement: 'REQUIRED',
      resumeFromRequirement: 'REQUIRED',
      reportedResetAtRequirement: 'NOT_APPLICABLE',
      rationale:
        'Credentials for a specific agent are missing, expired or of a rejected kind. ' +
        'Only a human can restore a subscription login, so the loop must stop and wait.',
    },
    BLOCKED_USAGE_LIMIT: {
      state: 'BLOCKED_USAGE_LIMIT',
      resumable: true,
      // The only state that may resume unattended: the block clears by itself
      // once the reported reset time passes.
      automaticResumeAllowed: true,
      requiresHumanDecision: false,
      allowedBlockedAgents: ['claude', 'codex'],
      blockedAgentRequirement: 'REQUIRED',
      resumeFromRequirement: 'REQUIRED',
      // Preferred, not required: not every CLI reports a reset timestamp, and
      // fabricating one would be worse than not having it.
      reportedResetAtRequirement: 'PREFERRED',
      rationale:
        'A subscription quota was exhausted. The block is time-based and clears on its own, ' +
        'so an unattended resume at the recorded phase is safe.',
    },
    BLOCKED_VERIFY: {
      state: 'BLOCKED_VERIFY',
      resumable: true,
      // Resuming means handing the failure to the writing agent for
      // remediation, which is a decision, not an automatic retry.
      automaticResumeAllowed: false,
      requiresHumanDecision: true,
      // Verification runs local commands, not an agent — so no agent is blocked.
      allowedBlockedAgents: [null],
      blockedAgentRequirement: 'NOT_APPLICABLE',
      resumeFromRequirement: 'REQUIRED',
      reportedResetAtRequirement: 'NOT_APPLICABLE',
      rationale:
        'The project verification commands failed in a way the loop could not resolve. ' +
        'Blindly re-running them would just fail again, so a human decides how to proceed.',
    },
    SCOPE_VIOLATION: {
      state: 'SCOPE_VIOLATION',
      // Not resumable: an agent left its sandbox. Continuing would compound the
      // problem before anyone has inspected it.
      resumable: false,
      automaticResumeAllowed: false,
      requiresHumanDecision: true,
      allowedBlockedAgents: ['claude', 'codex', null],
      blockedAgentRequirement: 'PREFERRED',
      resumeFromRequirement: 'NOT_APPLICABLE',
      reportedResetAtRequirement: 'NOT_APPLICABLE',
      rationale:
        'An agent wrote outside its allowed scope, or the resolved repository is not the ' +
        'configured one. The run is not trustworthy until a human has inspected it.',
    },
    RESUME_STATE_DIVERGED: {
      state: 'RESUME_STATE_DIVERGED',
      // Not resumable: persisted state and the real worktree disagree, and
      // guessing which one is authoritative is exactly the wrong move.
      resumable: false,
      automaticResumeAllowed: false,
      requiresHumanDecision: true,
      allowedBlockedAgents: [null],
      blockedAgentRequirement: 'NOT_APPLICABLE',
      resumeFromRequirement: 'NOT_APPLICABLE',
      reportedResetAtRequirement: 'NOT_APPLICABLE',
      rationale:
        'The persisted task state no longer matches the repository/worktree on disk. ' +
        'Reconciliation is a human judgement call, never an automatic one.',
    },
    HUMAN_DECISION_REQUIRED: {
      state: 'HUMAN_DECISION_REQUIRED',
      resumable: true,
      automaticResumeAllowed: false,
      requiresHumanDecision: true,
      allowedBlockedAgents: ['claude', 'codex', null],
      blockedAgentRequirement: 'NOT_APPLICABLE',
      resumeFromRequirement: 'REQUIRED',
      reportedResetAtRequirement: 'NOT_APPLICABLE',
      rationale:
        'The loop reached an ambiguous situation (for example an unresolvable review finding ' +
        'or an exhausted review budget) and explicitly escalated to the operator.',
    },
  } satisfies Record<BlockingState, BlockedStatePolicy>);

export function getBlockedStatePolicy(state: BlockingState): BlockedStatePolicy {
  return BLOCKED_STATE_POLICIES[state];
}

/** `true` only for blocking states that may be continued without a human. */
export function isAutomaticResumeAllowed(state: TaskStateName): boolean {
  return isBlockingState(state) && BLOCKED_STATE_POLICIES[state].automaticResumeAllowed;
}

/** `true` for blocking states that need an operator decision before continuing. */
export function requiresHumanDecision(state: TaskStateName): boolean {
  return isBlockingState(state) && BLOCKED_STATE_POLICIES[state].requiresHumanDecision;
}

/** `true` for blocking states that can, in principle, ever be continued. */
export function isResumableState(state: TaskStateName): boolean {
  return isBlockingState(state) && BLOCKED_STATE_POLICIES[state].resumable;
}

/** Blocking states that must carry a `resumeFrom`. */
export function requiresResumePoint(state: TaskStateName): boolean {
  return isBlockingState(state) && BLOCKED_STATE_POLICIES[state].resumeFromRequirement === 'REQUIRED';
}

/** Blocking states that must name the blocked agent. */
export function requiresBlockedAgent(state: TaskStateName): boolean {
  return (
    isBlockingState(state) && BLOCKED_STATE_POLICIES[state].blockedAgentRequirement === 'REQUIRED'
  );
}

/**
 * The regular state a resume point re-enters.
 *
 * Note that this is *not* automatically a legal transition from wherever the
 * task currently is — callers must still run `assertTransition`.
 */
const PHASE_TO_STATE: Readonly<Record<ResumePhase, TaskStateName>> = Object.freeze({
  IMPLEMENT: 'IMPLEMENTING',
  VERIFY: 'VERIFYING',
  REVIEW: 'REVIEWING',
  REMEDIATE: 'REMEDIATING',
});

export function resumePointToState(point: ResumePoint): TaskStateName {
  const target = PHASE_TO_STATE[point.phase];
  if (target === undefined) {
    throw new InvalidResumePointError(`Unknown resume phase: ${String(point.phase)}`);
  }
  return target;
}

/**
 * Human-readable form of a resume point, e.g. `IMPLEMENT_ROUND_1`.
 * Presentation only — the persisted representation stays structured.
 */
export function formatResumePoint(point: ResumePoint): string {
  return `${point.phase}_ROUND_${point.round}`;
}

/** Parses the `PHASE_ROUND_N` display form back into a structured point. */
export function parseResumePoint(text: string): ResumePoint {
  const match = /^(IMPLEMENT|VERIFY|REVIEW|REMEDIATE)_ROUND_(\d+)$/.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new InvalidResumePointError(
      `Not a valid resume point: ${JSON.stringify(text)}. Expected e.g. "IMPLEMENT_ROUND_1".`,
    );
  }
  const round = Number.parseInt(match[2], 10);
  if (round < 1) {
    throw new InvalidResumePointError(`Resume round must be >= 1, got ${round}.`);
  }
  return { phase: match[1] as ResumePhase, round };
}
