/**
 * Shape of `doctor-report.json` and its status algebra.
 *
 * Every field of this report is either a fixed vocabulary value, a number, a
 * timestamp, a path the orchestrator itself chose, or typed allow-list
 * evidence. No raw CLI stdout/stderr and no exception text is representable
 * here (AO-002).
 */

import type { AuthAssessment } from '../auth/auth-preflight.js';
import type { EnvironmentAssessment } from '../auth/env-guard.js';
import type { CapabilityAnswers, CapabilityFacts } from './capabilities.js';
import type { WriteAccessResult } from './write-access.js';
import type { RunArtifactResult } from './safe-write.js';

export const DOCTOR_REPORT_SCHEMA_VERSION = 2;

/**
 * Document type discriminator, so a reader can tell what it is looking at.
 *
 * It is **not** a proof of ownership and must never be used as one (AO-007-R2).
 * The value is published in every report, so anybody can put it in any file.
 * Ownership comes from the fact that each run writes into a directory it just
 * created exclusively — see `run-directory.ts`.
 */
export const DOCTOR_REPORT_KIND = 'agent-loop-doctor-report';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /**
   * A mandatory check must be `PASS` for the doctor to exit 0. Non-mandatory
   * checks may be `WARN`; every `WARN` carries a reason explaining why it is
   * neither a security nor an execution risk.
   */
  readonly mandatory: boolean;
  readonly detail: string;
}

export interface CliVersionInfo {
  readonly name: string;
  readonly found: boolean;
  /**
   * Dotted numeric version extracted from the `--version` line, or `null` when
   * the line did not contain a recognisable version. The raw line is never
   * copied here.
   */
  readonly version: string | null;
}

/** One persistent artefact and the outcome of writing it. */
export interface DiagnosticArtefact {
  readonly path: string;
  readonly writeCode: RunArtifactResult['code'];
  readonly written: boolean;
  readonly temporaryFileRemoved: boolean;
}

export interface DoctorReport {
  readonly reportKind: typeof DOCTOR_REPORT_KIND;
  readonly schemaVersion: number;
  /** Identifies this run and names its directory. Generated per run. */
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly overallStatus: 'PASS' | 'FAIL';
  readonly checks: readonly DoctorCheck[];
  readonly cliVersions: readonly CliVersionInfo[];
  /**
   * Allow-listed probe facts. Raw process output is not representable here:
   * see `capabilities.ts` (AO-002-R1).
   */
  readonly capabilityFacts: readonly CapabilityFacts[];
  readonly capabilityAnswers: CapabilityAnswers;
  readonly authAssessment: AuthAssessment;
  readonly environmentAssessment: EnvironmentAssessment;
  readonly writeAccessAssessment: readonly WriteAccessResult[];
  /** Absolute, containment-checked root of all doctor diagnostics. */
  readonly diagnosticsDirectory: string;
  /** Absolute path of *this* run's own, exclusively created directory. */
  readonly runDirectory: string;
  readonly diagnosticFiles: readonly DiagnosticArtefact[];
  readonly todos: readonly string[];
}

/**
 * Overall status.
 *
 * FAIL when any check failed, or when a mandatory check is anything other than
 * PASS. A `WARN` on a non-mandatory check does not fail the run.
 */
export function computeOverallStatus(checks: readonly DoctorCheck[]): 'PASS' | 'FAIL' {
  const hasFailure = checks.some((c) => c.status === 'FAIL');
  const mandatoryNotPassing = checks.some((c) => c.mandatory && c.status !== 'PASS');
  return hasFailure || mandatoryNotPassing ? 'FAIL' : 'PASS';
}

export const EXIT_OK = 0;
export const EXIT_DIAGNOSTIC_FAILURE = 1;

export function exitCodeFor(status: 'PASS' | 'FAIL'): number {
  return status === 'PASS' ? EXIT_OK : EXIT_DIAGNOSTIC_FAILURE;
}
