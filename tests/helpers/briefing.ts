/**
 * Fixtures for the two values M8 added to what an agent is briefed with.
 *
 * Both defaults are the *quiet* ones on purpose. A brief whose capability is
 * `OPTIONAL` and satisfied keeps every existing case measuring what it was
 * written to measure, and a briefing whose verification statement is
 * `NOT_MEASURED` says exactly what is true of a fixture nobody verified — so a
 * test that wants a pass in the payload has to build one, and cannot get it by
 * accident from a default.
 */

import type { CapabilityAssessment } from '../../src/repo/capabilities.js';
import type { OrchestratorBriefing } from '../../src/loop/orchestrator-briefing.js';
import type { VerificationStatement } from '../../src/verify/verification-statement.js';

/** A satisfied, optional capability — the shape of a repository that asks for nothing. */
export function optionalCapability(
  overrides: Partial<CapabilityAssessment> = {},
): CapabilityAssessment {
  return Object.freeze({
    capability: 'codegraph' as const,
    requirement: 'OPTIONAL' as const,
    status: 'UNAVAILABLE' as const,
    satisfied: true,
    ...overrides,
  });
}

/** The two fields `readExecutionBrief` now produces, for a hand-built brief. */
export function briefCapabilityFields(overrides: Partial<CapabilityAssessment> = {}): {
  readonly codegraph: CapabilityAssessment;
  readonly capabilitiesSatisfied: boolean;
} {
  const codegraph = optionalCapability(overrides);
  return { codegraph, capabilitiesSatisfied: codegraph.satisfied };
}

/** A verification statement that claims nothing. */
export function notMeasured(
  overrides: Partial<VerificationStatement> = {},
): VerificationStatement {
  return Object.freeze({
    reading: 'NOT_MEASURED' as const,
    measuredAt: null,
    subjectCommit: null,
    observedCommit: null,
    phases: Object.freeze([]),
    differs: null,
    failureVerdict: null,
    failureStoppedAt: null,
    uncommittedChanges: null,
    ...overrides,
  });
}

/** A briefing that says nothing was measured and no capability was required. */
export function briefingFixture(
  overrides: Partial<OrchestratorBriefing> = {},
): OrchestratorBriefing {
  return Object.freeze({
    verification: notMeasured(),
    codegraph: null,
    changedPaths: null,
    ...overrides,
  });
}
