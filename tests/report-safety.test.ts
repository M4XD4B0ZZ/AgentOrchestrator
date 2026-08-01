/**
 * AO-002 / AO-007 / AO-010, end to end.
 *
 * Runs the real doctor against a scratch application-data root — injected, not
 * environment-driven (AO-007-R1) — and asserts that the persisted report and
 * the console summary contain no raw CLI output, no exception text and no
 * credential-shaped strings, and that the artefacts land in a fresh per-run
 * directory, exclusively created, without leftovers.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTH_REASON_TEXT,
  evaluateClaudeAuthStatus,
  evaluateCodexLoginStatus,
} from '../src/auth/auth-preflight.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { doctorDiagnosticsDir, doctorRunsRoot } from '../src/config/paths.js';
import { renderReportSummary } from '../src/doctor/render.js';
import { RUN_ID_PATTERN } from '../src/doctor/run-directory.js';
import { runDoctor } from '../src/doctor/run-doctor.js';
import { DOCTOR_REPORT_KIND, type DoctorReport, type DoctorCheck } from '../src/doctor/report.js';
import { commandResult, SENSITIVE_MARKER } from './fixtures.js';

const DOCTOR_TIMEOUT_MS = 25_000;

let home: string;
let runsRoot: string;
let report: DoctorReport;
let summary: string;
let reportJson: string;

/** A scratch root reached only through internal injection. */
function scratchProvider(dir: string): { pathProvider: ReturnType<typeof fixedPathProvider> } {
  return { pathProvider: fixedPathProvider(dir) };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'agent-loop-home-'));
  runsRoot = doctorRunsRoot(fixedPathProvider(home));

  report = await runDoctor({
    env: process.env,
    commandTimeoutMs: DOCTOR_TIMEOUT_MS,
    ...scratchProvider(home),
  });
  summary = renderReportSummary(report);
  const reportPath = join(report.runDirectory, 'doctor-report.json');
  reportJson = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
}, 180_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('diagnostics land in a fresh per-run directory', () => {
  it('writes both artefacts into this run\'s own directory', () => {
    expect(report.diagnosticsDirectory).toBe(doctorDiagnosticsDir(fixedPathProvider(home)));
    expect(report.runDirectory).toBe(join(runsRoot, report.runId));
    expect(report.runDirectory.startsWith(home)).toBe(true);
    expect(RUN_ID_PATTERN.test(report.runId)).toBe(true);

    expect(existsSync(join(report.runDirectory, 'doctor-report.json'))).toBe(true);
    expect(existsSync(join(report.runDirectory, 'cli-capabilities.txt'))).toBe(true);
    expect(existsSync(join(process.cwd(), '.diagnostics'))).toBe(false);
  });

  it('reports every artefact with its real absolute path', () => {
    expect(report.diagnosticFiles.length).toBe(2);
    for (const artefact of report.diagnosticFiles) {
      expect(artefact.path.startsWith(report.runDirectory)).toBe(true);
      expect(artefact.writeCode).toBe('WRITTEN');
      expect(artefact.temporaryFileRemoved).toBe(true);
    }
  });

  it('names the exact run path on the console and in the report itself', () => {
    expect(summary).toContain(report.runDirectory);
    expect(summary).toContain(report.runId);
    expect(summary).toContain('doctor-report.json');

    const parsed = JSON.parse(reportJson) as DoctorReport;
    expect(parsed.runId).toBe(report.runId);
    expect(parsed.runDirectory).toBe(report.runDirectory);
  });

  it('leaves no temporary write file behind', () => {
    expect(readdirSync(report.runDirectory).sort()).toEqual([
      'cli-capabilities.txt',
      'doctor-report.json',
    ]);
  });

  it('gives a second run a different directory and touches neither file of the first', () => {
    const firstReport = readFileSync(join(report.runDirectory, 'doctor-report.json'), 'utf8');
    return runDoctor({
      env: process.env,
      commandTimeoutMs: DOCTOR_TIMEOUT_MS,
      ...scratchProvider(home),
    }).then((second) => {
      expect(second.runId).not.toBe(report.runId);
      expect(second.runDirectory).not.toBe(report.runDirectory);
      expect(second.diagnosticFiles.every((a) => a.writeCode === 'WRITTEN')).toBe(true);

      // The first run's artefacts are untouched, byte for byte.
      expect(readFileSync(join(report.runDirectory, 'doctor-report.json'), 'utf8')).toBe(
        firstReport,
      );
      expect(readdirSync(runsRoot).length).toBeGreaterThanOrEqual(2);
      expect(readdirSync(second.runDirectory).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });
  }, 180_000);

  it('never replaces a foreign file, whatever marker it carries', async () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'agent-loop-home-foreign-'));
    try {
      const third = await runDoctor({
        env: process.env,
        commandTimeoutMs: DOCTOR_TIMEOUT_MS,
        ...scratchProvider(otherHome),
      });
      // Plant a file carrying the old public "ownership" marker in the run
      // directory, then prove a later run cannot be steered onto it.
      const planted = join(third.runDirectory, 'planted.json');
      writeFileSync(planted, `{"reportKind":"${DOCTOR_REPORT_KIND}"}\n`, 'utf8');

      const fourth = await runDoctor({
        env: process.env,
        commandTimeoutMs: DOCTOR_TIMEOUT_MS,
        ...scratchProvider(otherHome),
      });
      expect(fourth.runDirectory).not.toBe(third.runDirectory);
      expect(readFileSync(planted, 'utf8')).toBe(`{"reportKind":"${DOCTOR_REPORT_KIND}"}\n`);
      expect(existsSync(join(third.runDirectory, 'doctor-report.json'))).toBe(true);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('AGENT_LOOP_HOME does not steer the real run', () => {
  it('ignores the variable and reports the ignore as a fixed code', async () => {
    const realHome = mkdtempSync(join(tmpdir(), 'agent-loop-home-real-'));
    const decoy = mkdtempSync(join(tmpdir(), 'agent-loop-home-decoy-'));
    try {
      const run = await runDoctor({
        env: { ...process.env, AGENT_LOOP_HOME: decoy },
        commandTimeoutMs: DOCTOR_TIMEOUT_MS,
        ...scratchProvider(realHome),
      });

      expect(run.runDirectory.startsWith(realHome)).toBe(true);
      expect(run.runDirectory.startsWith(decoy)).toBe(false);
      // The decoy stays completely untouched.
      expect(readdirSync(decoy)).toEqual([]);

      const warning = run.checks.find((c) => c.id === 'env:home-override');
      expect(warning?.status).toBe('WARN');
      expect(warning?.detail).toContain('UNSUPPORTED_HOME_OVERRIDE_IGNORED');
      // The value is never echoed.
      expect(JSON.stringify(run)).not.toContain(decoy);
    } finally {
      rmSync(realHome, { recursive: true, force: true });
      rmSync(decoy, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('the persisted report carries no raw output', () => {
  it('is valid JSON carrying the document type', () => {
    const parsed = JSON.parse(reportJson) as DoctorReport;
    expect(parsed.reportKind).toBe(DOCTOR_REPORT_KIND);
  });

  it('has no field that could hold raw stdout, stderr or a redacted blob', () => {
    for (const forbidden of ['redactedOutput', '"stdout"', '"stderr"', 'spawnError']) {
      expect(reportJson).not.toContain(forbidden);
    }
  });

  it('marks every capability probe as having discarded its raw output', () => {
    expect(report.capabilityFacts.length).toBeGreaterThan(0);
    for (const facts of report.capabilityFacts) {
      expect(facts.rawOutputDiscarded).toBe(true);
      for (const flag of facts.flags) expect(flag.startsWith('--')).toBe(true);
      for (const name of facts.subcommands) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
      if (facts.version !== null) {
        expect(facts.version).toMatch(/^\d{1,6}(\.\d{1,6}){1,3}(-[A-Za-z0-9.]{1,32})?$/);
      }
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
    // The run id is the report's own identifier and contains a UUID this
    // process generated. It is replaced first so the UUID probe still means
    // "no UUID came from anywhere else".
    const scrubbed = reportJson.split(report.runId).join('<run-id>');
    expect(scrubbed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(scrubbed).not.toMatch(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
    );
    expect(scrubbed).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
    expect(scrubbed).not.toMatch(/\beyJ[A-Za-z0-9._-]{20,}/);
    expect(scrubbed).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{8,}/);
  });

  it('keeps the capability artefact free of credential-shaped strings too', () => {
    const capabilities = readFileSync(join(report.runDirectory, 'cli-capabilities.txt'), 'utf8');
    const scrubbed = capabilities.split(report.runId).join('<run-id>');
    expect(scrubbed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(scrubbed).not.toMatch(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
    );
    expect(scrubbed).not.toContain('--- stdout ---');
    expect(scrubbed).toContain('RAW OUTPUT  : discarded');
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

  it('is absent from the real persisted artefacts as well', () => {
    const capabilities = readFileSync(join(report.runDirectory, 'cli-capabilities.txt'), 'utf8');
    expect(reportJson).not.toContain(SENSITIVE_MARKER);
    expect(capabilities).not.toContain(SENSITIVE_MARKER);
    expect(summary).not.toContain(SENSITIVE_MARKER);
  });
});

describe('the doctor still fails closed on real problems', () => {
  it('blocks when a provider override is configured', async () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'agent-loop-home-blocked-'));
    try {
      const blocked = await runDoctor({
        env: { ...process.env, CLAUDE_CODE_USE_BEDROCK: '1' },
        commandTimeoutMs: DOCTOR_TIMEOUT_MS,
        ...scratchProvider(otherHome),
      });
      expect(blocked.overallStatus).toBe('FAIL');
      expect(blocked.checks.find((c) => c.id === 'env:provider-flags')?.status).toBe('FAIL');
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  }, 180_000);
});
