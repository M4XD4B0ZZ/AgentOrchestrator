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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AUTH_REASON_TEXT,
  evaluateClaudeAuthStatus,
  evaluateCodexLoginStatus,
} from '../src/auth/auth-preflight.js';
import { FORBIDDEN_CHILD_ENV_VARS, OBSERVED_PROVIDER_ENV_VARS } from '../src/auth/env-guard.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { doctorDiagnosticsDir, doctorRunsRoot } from '../src/config/paths.js';
import type { CommandResult } from '../src/doctor/exec.js';
import { renderReportSummary } from '../src/doctor/render.js';
import {
  COMPLETION_MARKER_FILE_NAME,
  inspectRun,
  listCompletedRuns,
  RUN_PROTOCOL_VERSION,
} from '../src/doctor/run-completion.js';
import { RUN_ID_PATTERN } from '../src/doctor/run-directory.js';
import { runDoctor } from '../src/doctor/run-doctor.js';
import {
  DOCTOR_REPORT_KIND,
  DOCTOR_REPORT_SCHEMA_VERSION,
  type DoctorReport,
  type DoctorCheck,
} from '../src/doctor/report.js';
import { commandResult, SENSITIVE_MARKER } from './fixtures.js';

/**
 * AO-FOUNDATION-REM-002C4-FINAL-02.
 *
 * This suite's `overallStatus === 'PASS'` assertions used to depend on real,
 * unstated host state: `runDoctor` shells out for real to `node`/`npm`/`git`
 * `--version` and to `claude`/`codex`'s own auth status commands, so the run
 * only came back PASS on a machine that happened to have all five CLIs
 * installed *and* both agents logged into an accepted subscription. On any
 * other machine — a fresh checkout, a sandboxed reviewer, CI without those
 * CLIs — the same assertions fail for a reason that has nothing to do with
 * the property under test (report safety, redaction, persistence,
 * completion).
 *
 * The fix is not to mock `runDoctor` — that would stop exercising the real
 * report-assembly, redaction, artefact-write and completion-protocol code
 * this suite exists to check. Instead, only the one real I/O boundary those
 * probes ultimately go through — `runCommand` in `../src/doctor/exec.js` — is
 * replaced with deterministic, fixed fixtures below. Every module built on
 * top of it (`capabilities.ts`'s `runCapabilityDump`/`deriveCapabilityFacts`,
 * `auth-preflight.ts`'s `runAuthPreflight`/`evaluateClaudeAuthStatus`/
 * `evaluateCodexLoginStatus`, and `run-doctor.ts` itself) still runs for
 * real, against these fixed inputs instead of whatever this host happens to
 * have installed.
 *
 * The fixture shapes are exactly the ones `capabilities.ts` and
 * `auth-preflight.ts` document as having been observed locally (see their
 * module doc comments), so this is not a fabricated success path — it is the
 * one real success path, pinned instead of left to chance.
 */
const commandFixtures = vi.hoisted(() => {
  const outputs = new Map<string, { stdout?: string; stderr?: string }>([
    ['node --version', { stdout: 'v24.18.1\n' }],
    ['npm --version', { stdout: '11.12.1\n' }],
    ['git --version', { stdout: 'git version 2.55.0.windows.3\n' }],

    ['claude --version', { stdout: '2.1.220 (Claude Code)\n' }],
    ['claude --help', { stdout: 'Commands:\n  auth\n  config\n  doctor\n  mcp\n  update\n' }],
    ['claude auth --help', { stdout: 'Commands:\n  login\n  logout\n  status\n' }],
    ['claude auth login --help', { stdout: 'Usage: claude auth login [--claudeai] [--console]\n' }],
    ['claude auth status --help', { stdout: 'Usage: claude auth status [--json]\n' }],
    [
      'claude auth status --json',
      {
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'pro',
        }),
      },
    ],

    ['codex --version', { stdout: 'codex-cli 0.146.0\n' }],
    ['codex --help', { stdout: 'Commands:\n  login\n  exec\n  mcp\n  resume\n  update\n' }],
    ['codex login --help', { stdout: 'Usage: codex login [--with-api-key]\n' }],
    [
      'codex login status --help',
      { stdout: 'Usage: codex login status [-c/--config] [--enable] [--disable]\n' },
    ],
    ['codex login status', { stderr: 'Logged in using ChatGPT\n' }],
  ]);
  return { outputs };
});

vi.mock('../src/doctor/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doctor/exec.js')>();
  return {
    ...actual,
    async runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
      const key = [command, ...args].join(' ');
      const fixture = commandFixtures.outputs.get(key);
      if (fixture === undefined) {
        throw new Error(
          `report-safety.test.ts: no hermetic command fixture registered for "${key}". ` +
            'Every argv runDoctor can issue must be listed in commandFixtures.',
        );
      }
      return {
        display: key,
        executable: command,
        args,
        started: true,
        outcome: 'COMPLETED',
        exitCode: 0,
        signal: null,
        stdout: fixture.stdout ?? '',
        stderr: fixture.stderr ?? '',
        startedAt: '2026-08-01T00:00:00.000Z',
        finishedAt: '2026-08-01T00:00:00.010Z',
        durationMs: 10,
        failureCode: null,
        errnoCode: null,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdinDelivery: 'NOT_REQUESTED',
        processTreeKilled: false,
      };
    },
  };
});

const DOCTOR_TIMEOUT_MS = 25_000;

/**
 * A real environment with this repository's own credential/provider
 * variables (see `env-guard.ts`) removed, so a report this suite expects to
 * come back `PASS` can never silently depend on whether this machine's shell
 * happens to export one of them. Everything else about the host environment
 * passes through unchanged.
 */
const HERMETIC_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  for (const name of FORBIDDEN_CHILD_ENV_VARS) delete env[name];
  for (const name of OBSERVED_PROVIDER_ENV_VARS) delete env[name];
  return env;
})();

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
    env: HERMETIC_ENV,
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
      expect(artefact.written).toBe(true);
      expect(artefact.bytesWritten).toBeGreaterThan(0);
    }
  });

  it('names the exact run path on the console and in the report itself', () => {
    expect(summary).toContain(report.runDirectory);
    expect(summary).toContain(report.runId);
    expect(summary).toContain('doctor-report.json');

    const parsed = JSON.parse(reportJson) as DoctorReport;
    expect(parsed.runId).toBe(report.runId);
    expect(parsed.runDirectory).toBe(report.runDirectory);
    expect(parsed.reportPath).toBe(join(report.runDirectory, 'doctor-report.json'));
  });

  it('holds exactly the two artefacts plus the completion marker', () => {
    expect(readdirSync(report.runDirectory).sort()).toEqual([
      COMPLETION_MARKER_FILE_NAME,
      'cli-capabilities.txt',
      'doctor-report.json',
    ].sort());
  });

  /**
   * AO-007-R2-RR2. The persisted report is written *before* the marker, so it
   * cannot know whether the run finished — and must not pretend to. Before the
   * remediation it carried a self-reference claiming `written: true` for its
   * own file, which is a claim no document can make about itself.
   */
  it('makes no completion claim about itself in the persisted copy', () => {
    const parsed = JSON.parse(reportJson) as DoctorReport;

    // Its own file is not among the artefacts it reports as written.
    for (const artefact of parsed.diagnosticFiles) {
      expect(artefact.path).not.toBe(parsed.reportPath);
    }
    expect(parsed.diagnosticFiles.map((a) => a.path)).toEqual([
      join(report.runDirectory, 'cli-capabilities.txt'),
    ]);

    // No check inside the persisted copy asserts the report or the run itself
    // completed — those are decided after it is written.
    const ids = parsed.checks.map((c) => c.id);
    expect(ids).not.toContain('diagnostics:doctor-report');
    expect(ids).not.toContain('diagnostics:run-completed');

    // It does name the protocol and the marker a consumer must look for.
    expect(parsed.runProtocolVersion).toBe(RUN_PROTOCOL_VERSION);
    expect(parsed.completionMarkerFile).toBe(COMPLETION_MARKER_FILE_NAME);
  });

  it('is recognised as a completed, consumable run', () => {
    const inspection = inspectRun(runsRoot, report.runId);
    expect(inspection.code).toBe('COMPLETE');
    expect(inspection.consumable).toBe(true);
    expect(readFileSync(join(report.runDirectory, COMPLETION_MARKER_FILE_NAME), 'utf8').trim()).toBe(
      RUN_PROTOCOL_VERSION,
    );

    // The returned report — the one the console and the exit code use — does
    // carry the closing checks, and both pass.
    expect(report.checks.find((c) => c.id === 'diagnostics:doctor-report')?.status).toBe('PASS');
    expect(report.checks.find((c) => c.id === 'diagnostics:run-completed')?.status).toBe('PASS');
    expect(report.overallStatus).toBe('PASS');
    expect(summary).toContain('Run completed: yes');
  });

  it('gives a second run a different directory and touches neither file of the first', () => {
    const firstReport = readFileSync(join(report.runDirectory, 'doctor-report.json'), 'utf8');
    const firstMarker = readFileSync(
      join(report.runDirectory, COMPLETION_MARKER_FILE_NAME),
      'utf8',
    );
    return runDoctor({
      env: HERMETIC_ENV,
      commandTimeoutMs: DOCTOR_TIMEOUT_MS,
      ...scratchProvider(home),
    }).then((second) => {
      expect(second.runId).not.toBe(report.runId);
      expect(second.runDirectory).not.toBe(report.runDirectory);
      expect(second.diagnosticFiles.every((a) => a.writeCode === 'WRITTEN')).toBe(true);
      expect(inspectRun(runsRoot, second.runId).consumable).toBe(true);

      // The first run's artefacts and marker are untouched, byte for byte.
      expect(readFileSync(join(report.runDirectory, 'doctor-report.json'), 'utf8')).toBe(
        firstReport,
      );
      expect(readFileSync(join(report.runDirectory, COMPLETION_MARKER_FILE_NAME), 'utf8')).toBe(
        firstMarker,
      );
      expect(readdirSync(runsRoot).length).toBeGreaterThanOrEqual(2);
      expect(readdirSync(second.runDirectory).filter((n) => n.endsWith('.tmp'))).toEqual([]);

      // Both runs are complete, so both are offered to a consumer.
      expect(listCompletedRuns(runsRoot)).toEqual(
        expect.arrayContaining([report.runId, second.runId]),
      );
    });
  }, 180_000);

  it('never replaces a foreign file, whatever marker it carries', async () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'agent-loop-home-foreign-'));
    try {
      const third = await runDoctor({
        env: HERMETIC_ENV,
        commandTimeoutMs: DOCTOR_TIMEOUT_MS,
        ...scratchProvider(otherHome),
      });
      // Plant a file carrying the old public "ownership" marker in the run
      // directory, then prove a later run cannot be steered onto it.
      const planted = join(third.runDirectory, 'planted.json');
      writeFileSync(planted, `{"reportKind":"${DOCTOR_REPORT_KIND}"}\n`, 'utf8');

      const fourth = await runDoctor({
        env: HERMETIC_ENV,
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
        env: { ...HERMETIC_ENV, AGENT_LOOP_HOME: decoy },
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

/**
 * AO-007-R1-RR2: the doctor performs no environment-directed write probe.
 *
 * `AGENT_LOOP_WORKTREES_ROOT` used to name a directory that the doctor then
 * created a probe file in — an environment variable deciding where the tool
 * writes, which is the same class of defect as the removed `AGENT_LOOP_HOME`.
 * Before the remediation this test found a probe file's directory entry
 * created and removed, and a `write:worktrees-root` PASS in the report.
 */
describe('AGENT_LOOP_WORKTREES_ROOT triggers no write anywhere', () => {
  it('never touches the named directory and never reports a worktree write', async () => {
    const realHome = mkdtempSync(join(tmpdir(), 'agent-loop-home-wt-'));
    const decoy = mkdtempSync(join(tmpdir(), 'agent-loop-worktrees-decoy-'));
    const decoyBefore = readdirSync(decoy);
    try {
      const run = await runDoctor({
        env: { ...HERMETIC_ENV, AGENT_LOOP_WORKTREES_ROOT: decoy },
        commandTimeoutMs: DOCTOR_TIMEOUT_MS,
        ...scratchProvider(realHome),
      });

      // Nothing was created there — not a file, not a directory, not a probe
      // file that was created and removed again (which would still prove the
      // variable steered a write).
      expect(readdirSync(decoy)).toEqual(decoyBefore);
      expect(readdirSync(decoy)).toEqual([]);

      // No check claims to have probed a worktree root.
      const labels = run.writeAccessAssessment.map((p) => p.label);
      expect(labels).toEqual(['diagnostics directory', 'orchestrator home']);
      for (const probe of run.writeAccessAssessment) {
        expect(probe.path.startsWith(realHome)).toBe(true);
      }
      expect(run.checks.map((c) => c.id)).not.toContain('write:worktrees-root');
      for (const check of run.checks) {
        expect(check.title.toLowerCase()).not.toContain('worktree');
      }

      // The value is never echoed — not in the report, not on the console.
      const serialised = JSON.stringify(run);
      expect(serialised).not.toContain(decoy);
      expect(serialised).not.toContain('AGENT_LOOP_WORKTREES_ROOT');
      expect(renderReportSummary(run)).not.toContain(decoy);
    } finally {
      rmSync(realHome, { recursive: true, force: true });
      rmSync(decoy, { recursive: true, force: true });
    }
  }, 180_000);
});

/**
 * AO-FOUNDATION-REM-003A-RR-03 — the machine-readable report contract.
 *
 * v4 renamed two things that a v3 reader would not fail on, but would
 * misinterpret: `preservedAuthVars` became `withheldAuthVars`, and the check id
 * `env:oauth-token-preserved` became `env:oauth-token-withheld`. Both announce
 * the opposite of what they used to, so the structure and the version number
 * have to move together — a report carrying the new vocabulary under version 3
 * would tell a consumer that the OAuth token is forwarded.
 */
describe('the report states schema version 4 and the withhold vocabulary', () => {
  it('stamps version 4 on the returned and the persisted report alike', () => {
    expect(DOCTOR_REPORT_SCHEMA_VERSION).toBe(4);
    expect(report.schemaVersion).toBe(4);
    expect((JSON.parse(reportJson) as DoctorReport).schemaVersion).toBe(4);
    expect(reportJson).toContain('"schemaVersion": 4');
    expect(reportJson).not.toContain('"schemaVersion": 3');
  });

  it('carries withheldAuthVars and no preservedAuthVars anywhere', () => {
    const persisted = JSON.parse(reportJson) as DoctorReport;
    for (const assessment of [report.environmentAssessment, persisted.environmentAssessment]) {
      expect(assessment).toHaveProperty('withheldAuthVars');
      expect(assessment).not.toHaveProperty('preservedAuthVars');
      expect(assessment.withheldAuthVars.map((v) => v.name)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
      for (const observation of assessment.withheldAuthVars) {
        expect(['SET', 'NOT_SET']).toContain(observation.presence);
        // Presence only — never the value, and never a length or a hash.
        expect(Object.keys(observation).sort()).toEqual(['name', 'presence']);
      }
    }
    expect(reportJson).toContain('withheldAuthVars');
    expect(reportJson).not.toContain('preservedAuthVars');
  });

  it('uses the withheld check id and no longer the preserved one', () => {
    const ids = report.checks.map((c) => c.id);
    expect(ids).toContain('env:oauth-token-withheld');
    expect(ids).not.toContain('env:oauth-token-preserved');

    const persisted = JSON.parse(reportJson) as DoctorReport;
    expect(persisted.checks.map((c) => c.id)).toContain('env:oauth-token-withheld');
    expect(reportJson).not.toContain('env:oauth-token-preserved');
    expect(summary).not.toContain('env:oauth-token-preserved');

    const check = report.checks.find((c) => c.id === 'env:oauth-token-withheld');
    expect(check?.status).toBe('PASS');
    expect(check?.detail).not.toContain('preserved');
  });

  it('never emits the new structure under the old version number', () => {
    // The two are one decision: whichever way a future change goes, the
    // vocabulary and the version must not drift apart again.
    const persisted = JSON.parse(reportJson) as DoctorReport;
    const usesNewVocabulary =
      'withheldAuthVars' in persisted.environmentAssessment &&
      persisted.checks.some((c) => c.id === 'env:oauth-token-withheld');
    expect(usesNewVocabulary).toBe(true);
    expect(persisted.schemaVersion).toBeGreaterThanOrEqual(4);
  });
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
      // `evidence: null` is the only value this literal *can* carry: the
      // artefact has one producer and it is not reachable from a test fixture.
      // A failing assessment would mint nothing anyway.
      authAssessment: { checks: [claude], allPassed: false, evidence: null },
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
        env: { ...HERMETIC_ENV, CLAUDE_CODE_USE_BEDROCK: '1' },
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
