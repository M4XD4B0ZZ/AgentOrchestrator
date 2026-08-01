/**
 * AO-002 / AO-007 / AO-010, end to end.
 *
 * Runs the real doctor into a temporary application-data root and asserts that
 * the persisted report and the console summary contain no raw CLI output, no
 * exception text and no credential-shaped strings — and that the artefacts land
 * where they are supposed to, atomically, without leftovers.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTH_REASON_TEXT,
  evaluateClaudeAuthStatus,
  evaluateCodexLoginStatus,
} from '../src/auth/auth-preflight.js';
import { doctorDiagnosticsDir } from '../src/config/paths.js';
import { renderReportSummary } from '../src/doctor/render.js';
import { runDoctor } from '../src/doctor/run-doctor.js';
import {
  DOCTOR_REPORT_KIND,
  type DoctorReport,
  type DoctorCheck,
} from '../src/doctor/report.js';
import { commandResult, SENSITIVE_MARKER } from './fixtures.js';

let home: string;
let diagDir: string;
let report: DoctorReport;
let summary: string;
let reportJson: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'agent-loop-home-'));
  const env = { ...process.env, AGENT_LOOP_HOME: home };
  diagDir = doctorDiagnosticsDir(env);

  report = await runDoctor({ env, commandTimeoutMs: 25_000 });
  summary = renderReportSummary(report);
  reportJson = existsSync(join(diagDir, 'doctor-report.json'))
    ? readFileSync(join(diagDir, 'doctor-report.json'), 'utf8')
    : '';
}, 180_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('diagnostics land in the global application-data root', () => {
  it('writes both artefacts into the configured home, not the working directory', () => {
    expect(report.diagnosticsDirectory).toBe(diagDir);
    expect(diagDir.startsWith(home)).toBe(true);
    expect(existsSync(join(diagDir, 'doctor-report.json'))).toBe(true);
    expect(existsSync(join(diagDir, 'cli-capabilities.txt'))).toBe(true);
    expect(existsSync(join(process.cwd(), '.diagnostics'))).toBe(false);
  });

  it('reports every artefact with its real absolute path', () => {
    for (const artefact of report.diagnosticFiles) {
      expect(artefact.path.startsWith(diagDir)).toBe(true);
      expect(artefact.writeCode).toBe('WRITTEN');
      expect(artefact.temporaryFileRemoved).toBe(true);
    }
  });

  it('names the real report path on the console', () => {
    expect(summary).toContain(diagDir);
    expect(summary).toContain('doctor-report.json');
  });

  it('leaves no temporary write file behind', () => {
    const leftovers = readdirSync(diagDir).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(readdirSync(diagDir).sort()).toEqual(['cli-capabilities.txt', 'doctor-report.json']);
  });

  it('is replaceable: a second run overwrites its own report atomically', async () => {
    const env = { ...process.env, AGENT_LOOP_HOME: home };
    const second = await runDoctor({ env, commandTimeoutMs: 25_000 });
    expect(second.diagnosticFiles.every((a) => a.writeCode === 'WRITTEN')).toBe(true);
    expect(readdirSync(diagDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  }, 180_000);
});

describe('the persisted report carries no raw output', () => {
  it('is valid JSON carrying the ownership marker', () => {
    const parsed = JSON.parse(reportJson) as DoctorReport;
    expect(parsed.reportKind).toBe(DOCTOR_REPORT_KIND);
  });

  it('has no field that could hold raw stdout, stderr or a redacted blob', () => {
    for (const forbidden of ['redactedOutput', '"stdout"', '"stderr"', 'spawnError']) {
      expect(reportJson).not.toContain(forbidden);
    }
  });

  it('restricts every auth check to the allow-listed shape', () => {
    for (const check of report.authAssessment.checks) {
      expect(Object.keys(check).sort()).toEqual([
        'agent',
        'evidence',
        'exitCode',
        'passed',
        'reason',
        'reasonCode',
        'status',
        'statusCommand',
      ]);
      // Every sentence is looked up from the static table.
      expect(check.reason).toBe(AUTH_REASON_TEXT[check.reasonCode]);

      if (check.evidence === null) continue;
      const keys = Object.keys(check.evidence).sort();
      expect([
        ['apiProvider', 'authMethod', 'loggedIn', 'subscriptionType'],
        ['loginMethod'],
      ]).toContainEqual(keys);
    }
  });

  it('contains no credential-shaped string', () => {
    expect(reportJson).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(reportJson).not.toMatch(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
    );
    expect(reportJson).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
    expect(reportJson).not.toMatch(/\beyJ[A-Za-z0-9._-]{20,}/);
    expect(reportJson).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{8,}/);
  });

  it('reports only extracted version numbers, never whole CLI lines', () => {
    for (const version of report.cliVersions) {
      if (version.version === null) continue;
      expect(version.version).toMatch(/^\d{1,6}(\.\d{1,6}){1,3}(-[A-Za-z0-9.]{1,32})?$/);
    }
  });

  it('never records an environment variable value', () => {
    for (const observation of report.environmentAssessment.forbiddenVars) {
      expect(['SET', 'NOT_SET']).toContain(observation.presence);
    }
    expect(JSON.stringify(report.environmentAssessment)).not.toMatch(/"value"\s*:/);
  });

  it('carries only errno identifiers on write-access failures', () => {
    for (const probe of report.writeAccessAssessment) {
      if (probe.errnoCode === null) continue;
      expect(probe.errnoCode).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    }
  });
});

describe('an arbitrary sensitive marker never reaches the report or the console', () => {
  /**
   * Builds the doctor's auth checks from marker-laden CLI output, exactly as
   * `runDoctor` does, and renders them the same way. The marker is not
   * token-shaped, so the redactor does not recognise it: if it survived, it
   * would be because raw output was copied.
   */
  function checksFromPoisonedOutput(): DoctorCheck[] {
    const claude = evaluateClaudeAuthStatus(
      commandResult({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: SENSITIVE_MARKER,
          email: `${SENSITIVE_MARKER}@example.com`,
          orgName: SENSITIVE_MARKER,
        }),
        stderr: `warning ${SENSITIVE_MARKER}`,
      }),
    );
    const codex = evaluateCodexLoginStatus(
      commandResult({
        display: 'codex login status',
        stdout: `Logged in using ChatGPT ${SENSITIVE_MARKER}`,
        stderr: SENSITIVE_MARKER,
      }),
    );

    return [claude, codex].map((check) => ({
      id: `auth:${check.agent}`,
      title: `${check.agent} subscription login`,
      status: check.passed ? ('PASS' as const) : ('FAIL' as const),
      mandatory: true,
      detail: `${check.status} [${check.reasonCode}] — ${check.reason}`,
    }));
  }

  it('keeps the marker out of the assembled checks', () => {
    expect(JSON.stringify(checksFromPoisonedOutput())).not.toContain(SENSITIVE_MARKER);
  });

  it('keeps the marker out of the rendered console summary', () => {
    const poisoned: DoctorReport = { ...report, checks: checksFromPoisonedOutput() };
    expect(renderReportSummary(poisoned)).not.toContain(SENSITIVE_MARKER);
  });

  it('keeps the marker out of the serialised report', () => {
    const claude = evaluateClaudeAuthStatus(
      commandResult({ stdout: `garbage ${SENSITIVE_MARKER}`, stderr: SENSITIVE_MARKER }),
    );
    const poisoned: DoctorReport = {
      ...report,
      authAssessment: { checks: [claude], allPassed: false },
      checks: checksFromPoisonedOutput(),
    };
    expect(JSON.stringify(poisoned)).not.toContain(SENSITIVE_MARKER);
  });
});

describe('the doctor still fails closed on real problems', () => {
  it('blocks when a provider override is configured', async () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'agent-loop-home-blocked-'));
    try {
      const blocked = await runDoctor({
        env: { ...process.env, AGENT_LOOP_HOME: otherHome, CLAUDE_CODE_USE_BEDROCK: '1' },
        commandTimeoutMs: 25_000,
      });
      expect(blocked.overallStatus).toBe('FAIL');
      expect(
        blocked.checks.find((c) => c.id === 'env:provider-flags')?.status,
      ).toBe('FAIL');
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  }, 180_000);
});
