/**
 * INTERNAL — evidence helpers over a parsed task state (AO-009-R1).
 *
 * This used to live on the public state entry point. It is an *internal*
 * convenience for the loop's own reporting: it describes evidence a blocking
 * state would ideally carry, which is a policy question, not part of the state
 * contract. Publishing it from `core/task-state.ts` would freeze a policy
 * detail into the package's API for no consumer benefit.
 */

import { isBlockingState } from '../states.js';
import { BLOCKED_STATE_POLICIES } from '../resume-policy.js';
import type { TaskState } from '../task-state.js';

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
