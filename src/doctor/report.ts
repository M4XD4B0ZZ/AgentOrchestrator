/** Shape of `.diagnostics/doctor-report.json` and its status algebra. */

import type { AuthAssessment } from '../auth/auth-preflight.js';
import type { EnvironmentAssessment } from '../auth/env-guard.js';
import type { WriteAccessResult } from './write-access.js';

export const DOCTOR_REPORT_SCHEMA_VERSION = 1;

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
  readonly version: string | null;
}

export interface DoctorReport {
  readonly schemaVersion: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly overallStatus: 'PASS' | 'FAIL';
  readonly checks: readonly DoctorCheck[];
  readonly cliVersions: readonly CliVersionInfo[];
  readonly authAssessment: AuthAssessment;
  readonly environmentAssessment: EnvironmentAssessment;
  readonly writeAccessAssessment: readonly WriteAccessResult[];
  readonly diagnosticFiles: readonly string[];
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
