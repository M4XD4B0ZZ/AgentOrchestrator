/**
 * Pure policy layer describing what each blocking state *means* for resuming.
 *
 * This module answers, per blocking state:
 *   1. which agent may be recorded as the blocked one,
 *   2. whether a `resumeFrom` point is required,
 *   3. **which resume phases are legitimate**,
 *   4. whether an automatic (unattended) resume is even eligible for
 *      consideration,
 *   5. whether a human decision is required first.
 *
 * There is deliberately **no resume runner here** — this module only describes
 * and validates. Executing a resume is out of scope for the foundation.
 *
 * ── Single source of truth for resume phases (AO-004) ──────────────────────
 *
 * `allowedResumePhases` is **derived from the transition table**, never
 * hand-maintained. Each policy declares only *how* the state re-enters the work
 * loop ({@link ResumeReentry}); the concrete phase set follows from
 * `TRANSITION_TABLE`:
 *
 *  - `DIRECT`              — the loop transitions straight to the resume
 *                            target, so a phase is legitimate exactly when its
 *                            work state is a declared successor of the blocking
 *                            state.
 *  - `VIA_AUTH_PREFLIGHT`  — the operator re-authenticates first, so the loop
 *                            re-enters at `AUTH_PREFLIGHT` and carries the
 *                            *stored* resume point through. A phase is
 *                            legitimate exactly when its work state can enter
 *                            the blocking state, i.e. when that phase could
 *                            actually have been the interrupted one.
 *  - `NONE`                — the state is not resumable, so no resume point is
 *                            legitimate at all.
 *
 * The schema (`task-state.ts`) and the tests consume this same derived set, so
 * the contract can no longer accept a resume point the loop could never reach.
 */

import {
  RESUME_PHASES,
  RESUME_PHASE_STATES,
  isBlockingState,
  type AgentId,
  type BlockingState,
  type ResumePhase,
  type TaskStateName,
} from './states.js';
import { canTransition } from './transitions.js';
import { InvalidResumePointError } from './errors.js';
import {
  RESUME_POINT_DISPLAY_PATTERN,
  ResumePointSchema,
  type ResumePoint,
} from './resume-point.js';

export type { ResumePoint } from './resume-point.js';

/**
 * The regular state a resume point re-enters.
 *
 * Taken from `states.ts` rather than restated here, so the state contract's
 * work-loop set and this policy's phase mapping cannot disagree about what a
 * phase means. Note that a mapped state is *not* automatically a legal
 * transition from wherever the task currently is — callers must still run
 * `assertTransition`.
 */
const PHASE_TO_STATE: Readonly<Record<ResumePhase, TaskStateName>> = RESUME_PHASE_STATES;

/** How a blocking state re-enters the work loop when it is continued. */
export type ResumeReentry = 'DIRECT' | 'VIA_AUTH_PREFLIGHT' | 'NONE';

/** The state a `VIA_AUTH_PREFLIGHT` resume must pass through first. */
export const AUTH_REENTRY_STATE: TaskStateName = 'AUTH_PREFLIGHT';

/** How strongly a piece of evidence is required for a blocking state. */
export type EvidenceRequirement = 'REQUIRED' | 'PREFERRED' | 'NOT_APPLICABLE';

export interface BlockedStatePolicy {
  readonly state: BlockingState;
  /** Can this state, in principle, ever be continued? */
  readonly resumable: boolean;
  /**
   * May an unattended resume even be *considered* for this state?
   *
   * This is a static eligibility gate, never a permission. The actual decision
   * is made per task by `evaluateAutomaticResume()` in `automatic-resume.ts`,
   * which requires positive evidence (reset time passed, auth re-proven,
   * repository/worktree/commits unchanged, clean tree, no divergence). See
   * AO-005: a statically true "automatic resume allowed" flag is not a
   * sufficient basis for acting unattended.
   */
  readonly automaticResumeEligible: boolean;
  /** Must a human make a decision before anything continues? */
  readonly requiresHumanDecision: boolean;
  /** How this state re-enters the work loop. Drives {@link allowedResumePhases}. */
  readonly resumeReentry: ResumeReentry;
  /** Derived from the transition table — see the module header. */
  readonly allowedResumePhases: readonly ResumePhase[];
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

/** Phases whose work state is a declared successor of `state`. */
function directResumePhases(state: BlockingState): readonly ResumePhase[] {
  return RESUME_PHASES.filter((phase) => canTransition(state, PHASE_TO_STATE[phase]));
}

/** Phases whose work state can enter `state`, i.e. could have been interrupted. */
function interruptedResumePhases(state: BlockingState): readonly ResumePhase[] {
  return RESUME_PHASES.filter((phase) => canTransition(PHASE_TO_STATE[phase], state));
}

function deriveAllowedResumePhases(
  state: BlockingState,
  reentry: ResumeReentry,
): readonly ResumePhase[] {
  switch (reentry) {
    case 'DIRECT':
      return Object.freeze(directResumePhases(state));
    case 'VIA_AUTH_PREFLIGHT':
      // The re-entry edge itself must exist, otherwise the declaration is a lie.
      if (!canTransition(state, AUTH_REENTRY_STATE)) return Object.freeze([]);
      return Object.freeze(interruptedResumePhases(state));
    case 'NONE':
      return Object.freeze([]);
  }
}

type PolicyDeclaration = Omit<BlockedStatePolicy, 'allowedResumePhases'>;

const POLICY_DECLARATIONS: Readonly<Record<BlockingState, PolicyDeclaration>> = Object.freeze({
  BLOCKED_AUTH: {
    state: 'BLOCKED_AUTH',
    resumable: true,
    // A human has to re-authenticate; the orchestrator must never attempt a
    // login itself, so it can never clear this state on its own.
    automaticResumeEligible: false,
    requiresHumanDecision: true,
    // The stored resume point survives re-authentication. The loop re-proves
    // auth from scratch and then continues at the phase that was interrupted —
    // it must not assume IMPLEMENTING (AO-004).
    resumeReentry: 'VIA_AUTH_PREFLIGHT',
    allowedBlockedAgents: ['claude', 'codex'],
    blockedAgentRequirement: 'REQUIRED',
    resumeFromRequirement: 'REQUIRED',
    reportedResetAtRequirement: 'NOT_APPLICABLE',
    rationale:
      'Credentials for a specific agent are missing, expired or of a rejected kind. ' +
      'Only a human can restore a subscription login, so the loop must stop and wait. ' +
      'The originally recorded resume point is preserved across the re-authentication.',
  },
  BLOCKED_USAGE_LIMIT: {
    state: 'BLOCKED_USAGE_LIMIT',
    resumable: true,
    // The only state eligible for an unattended resume: the block clears by
    // itself once the reported reset time passes. Eligibility is not permission
    // — see evaluateAutomaticResume().
    automaticResumeEligible: true,
    requiresHumanDecision: false,
    resumeReentry: 'DIRECT',
    allowedBlockedAgents: ['claude', 'codex'],
    blockedAgentRequirement: 'REQUIRED',
    resumeFromRequirement: 'REQUIRED',
    // Preferred, not required: not every CLI reports a reset timestamp, and
    // fabricating one would be worse than not having it. Without one, no
    // unattended resume is ever granted.
    reportedResetAtRequirement: 'PREFERRED',
    rationale:
      'A subscription quota was exhausted. The block is time-based and clears on its own, ' +
      'so an unattended resume at the recorded phase may be considered once the reported ' +
      'reset time has demonstrably passed and the worktree is provably unchanged.',
  },
  BLOCKED_VERIFY: {
    state: 'BLOCKED_VERIFY',
    resumable: true,
    // Resuming means handing the failure to the writing agent for
    // remediation, which is a decision, not an automatic retry.
    automaticResumeEligible: false,
    requiresHumanDecision: true,
    resumeReentry: 'DIRECT',
    // Verification runs local commands, not an agent — so no agent is blocked.
    allowedBlockedAgents: [null],
    blockedAgentRequirement: 'NOT_APPLICABLE',
    resumeFromRequirement: 'REQUIRED',
    reportedResetAtRequirement: 'NOT_APPLICABLE',
    rationale:
      'The project verification commands failed in a way the loop could not resolve. ' +
      'Blindly re-running them would just fail again, so the only continuation is ' +
      'remediation by the writing agent, or an operator decision.',
  },
  SCOPE_VIOLATION: {
    state: 'SCOPE_VIOLATION',
    // Not resumable: an agent left its sandbox. Continuing would compound the
    // problem before anyone has inspected it.
    resumable: false,
    automaticResumeEligible: false,
    requiresHumanDecision: true,
    resumeReentry: 'NONE',
    allowedBlockedAgents: ['claude', 'codex', null],
    blockedAgentRequirement: 'PREFERRED',
    resumeFromRequirement: 'NOT_APPLICABLE',
    reportedResetAtRequirement: 'NOT_APPLICABLE',
    rationale:
      'An agent wrote outside its allowed scope, or the resolved repository is not the ' +
      'configured one. The run is not trustworthy until a human has inspected it, so the ' +
      'state must not carry a resume point that suggests otherwise.',
  },
  RESUME_STATE_DIVERGED: {
    state: 'RESUME_STATE_DIVERGED',
    // Not resumable: persisted state and the real worktree disagree, and
    // guessing which one is authoritative is exactly the wrong move.
    resumable: false,
    automaticResumeEligible: false,
    requiresHumanDecision: true,
    resumeReentry: 'NONE',
    allowedBlockedAgents: [null],
    blockedAgentRequirement: 'NOT_APPLICABLE',
    resumeFromRequirement: 'NOT_APPLICABLE',
    reportedResetAtRequirement: 'NOT_APPLICABLE',
    rationale:
      'The persisted task state no longer matches the repository/worktree on disk. ' +
      'Reconciliation is a human judgement call, never an automatic one, and no resume ' +
      'point may be carried forward.',
  },
  HUMAN_DECISION_REQUIRED: {
    state: 'HUMAN_DECISION_REQUIRED',
    resumable: true,
    automaticResumeEligible: false,
    requiresHumanDecision: true,
    resumeReentry: 'DIRECT',
    allowedBlockedAgents: ['claude', 'codex', null],
    blockedAgentRequirement: 'NOT_APPLICABLE',
    resumeFromRequirement: 'REQUIRED',
    reportedResetAtRequirement: 'NOT_APPLICABLE',
    rationale:
      'The loop reached an ambiguous situation (for example an unresolvable review finding ' +
      'or an exhausted review budget) and explicitly escalated to the operator, who picks ' +
      'any of the four work phases to continue at.',
  },
} satisfies Record<BlockingState, PolicyDeclaration>);

export const BLOCKED_STATE_POLICIES: Readonly<Record<BlockingState, BlockedStatePolicy>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(POLICY_DECLARATIONS).map(([state, declaration]) => [
        state,
        Object.freeze({
          ...declaration,
          allowedResumePhases: deriveAllowedResumePhases(
            state as BlockingState,
            declaration.resumeReentry,
          ),
        }),
      ]),
    ) as Record<BlockingState, BlockedStatePolicy>,
  );

export function getBlockedStatePolicy(state: BlockingState): BlockedStatePolicy {
  return BLOCKED_STATE_POLICIES[state];
}

/**
 * The resume phases a blocking state may legitimately carry.
 *
 * This is *the* source consumed by the schema, the policy helpers and the
 * tests. Non-blocking states carry no resume policy and yield an empty list.
 */
export function allowedResumePhases(state: TaskStateName): readonly ResumePhase[] {
  return isBlockingState(state) ? BLOCKED_STATE_POLICIES[state].allowedResumePhases : [];
}

/** `true` when `phase` is a legitimate resume phase for `state`. */
export function isAllowedResumePhase(state: TaskStateName, phase: ResumePhase): boolean {
  return allowedResumePhases(state).includes(phase);
}

/**
 * `true` only for blocking states an unattended resume may even be *considered*
 * for. This is not permission to resume — see `evaluateAutomaticResume()`.
 */
export function isAutomaticResumeEligible(state: TaskStateName): boolean {
  return isBlockingState(state) && BLOCKED_STATE_POLICIES[state].automaticResumeEligible;
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
  return (
    isBlockingState(state) && BLOCKED_STATE_POLICIES[state].resumeFromRequirement === 'REQUIRED'
  );
}

/** Blocking states that must name the blocked agent. */
export function requiresBlockedAgent(state: TaskStateName): boolean {
  return (
    isBlockingState(state) && BLOCKED_STATE_POLICIES[state].blockedAgentRequirement === 'REQUIRED'
  );
}

/**
 * `true` for blocking states that may not carry a resume point at all, because
 * nothing can ever continue from them.
 */
export function forbidsResumePoint(state: TaskStateName): boolean {
  return isBlockingState(state) && BLOCKED_STATE_POLICIES[state].allowedResumePhases.length === 0;
}

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

/**
 * Parses the `PHASE_ROUND_N` display form back into a structured point.
 *
 * Every produced value is validated against {@link ResumePointSchema} itself,
 * so the parser cannot emit anything the contract would later reject (AO-012).
 * The digit count is bounded by the pattern, so an absurdly long numeric
 * literal is rejected before `Number.parseInt` ever sees it — which is what
 * kept `Infinity`, `NaN` and unsafe integers out of reach.
 */
export function parseResumePoint(text: string): ResumePoint {
  const match = RESUME_POINT_DISPLAY_PATTERN.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new InvalidResumePointError(
      `Not a valid resume point: ${JSON.stringify(text)}. Expected e.g. "IMPLEMENT_ROUND_1".`,
    );
  }

  const round = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(round)) {
    throw new InvalidResumePointError('Resume round is not a safe integer.');
  }

  const parsed = ResumePointSchema.safeParse({ phase: match[1], round });
  if (!parsed.success) {
    throw new InvalidResumePointError(
      `Not a valid resume point: ${JSON.stringify(text)}. ` +
        `${parsed.error.issues.map((issue) => issue.message).join(' ')}`,
    );
  }
  return parsed.data;
}
