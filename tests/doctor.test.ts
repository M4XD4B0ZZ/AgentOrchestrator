import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { redact, redactAndClamp } from '../src/auth/redaction.js';
import { classifyProbe, renderCapabilityDump } from '../src/doctor/capabilities.js';
import { runCommand, UnsafeArgumentError } from '../src/doctor/exec.js';
import { computeOverallStatus, exitCodeFor, type DoctorCheck } from '../src/doctor/report.js';
import { renderChecksTable } from '../src/doctor/render.js';
import { probeWriteAccess } from '../src/doctor/write-access.js';
import type { CommandResult } from '../src/doctor/exec.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('redaction', () => {
  it('masks email addresses', () => {
    expect(redact('user: person@example.com')).toBe('user: <redacted:email>');
  });

  it('masks UUIDs', () => {
    expect(redact('org 78042180-604a-4d93-9696-e8a9c68e2e7c')).toBe('org <redacted:uuid>');
  });

  it.each([
    'sk-ant-api03-AbCdEfGhIjKlMnOp',
    'sk-proj-AbCdEfGhIjKlMnOpQrSt',
    'Bearer abcdefghijklmnopqrst',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  ])('masks the token-shaped string %j', (token) => {
    expect(redact(`value=${token}`)).not.toContain(token);
  });

  it('leaves harmless text alone', () => {
    expect(redact('codex-cli 0.146.0')).toBe('codex-cli 0.146.0');
    expect(redact('2.1.220 (Claude Code)')).toBe('2.1.220 (Claude Code)');
  });

  it('is safe to apply twice', () => {
    const once = redact('a@b.com');
    expect(redact(once)).toBe(once);
  });

  it('clamps runaway output', () => {
    const clamped = redactAndClamp('x'.repeat(10_000), 100);
    expect(clamped.length).toBeLessThan(200);
    expect(clamped).toContain('truncated');
  });
});

describe('safe child process execution', () => {
  it('refuses arguments containing shell metacharacters', async () => {
    await expect(
      runCommand('node', ['--version && whoami'], { env: process.env }),
    ).rejects.toThrow(UnsafeArgumentError);

    await expect(runCommand('node', ['$(id)'], { env: process.env })).rejects.toThrow(
      UnsafeArgumentError,
    );
  });

  it('runs a real command and records full timing metadata', async () => {
    const res = await runCommand('node', ['--version'], { env: process.env });
    expect(res.started).toBe(true);
    expect(res.outcome).toBe('COMPLETED');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^v\d+\./);
    expect(Date.parse(res.startedAt)).not.toBeNaN();
    expect(Date.parse(res.finishedAt)).not.toBeNaN();
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs a CLI whose resolved path contains spaces', async () => {
    // Regression guard: on Windows `npm` resolves to a `.cmd` shim under
    // "C:\Program Files\nodejs", which a naive cmd.exe invocation splits at
    // the space.
    const res = await runCommand('npm', ['--version'], { env: process.env });
    expect(res.started).toBe(true);
    expect(res.outcome).toBe('COMPLETED');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports a missing executable as data rather than throwing', async () => {
    const res = await runCommand('definitely-not-a-real-binary-xyz', ['--version'], {
      env: process.env,
    });
    expect(res.started).toBe(false);
    expect(res.outcome).toBe('NOT_FOUND');
    expect(res.exitCode).toBeNull();
  });

  it('records a non-zero exit code as data rather than throwing', async () => {
    const res = await runCommand('node', ['--definitely-not-a-node-flag'], { env: process.env });
    expect(res.started).toBe(true);
    expect(res.outcome).toBe('COMPLETED');
    expect(res.exitCode).not.toBe(0);
  });
});

describe('capability classification', () => {
  const base: CommandResult = {
    display: 'claude auth status --help',
    executable: 'claude',
    args: ['auth', 'status', '--help'],
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    signal: null,
    stdout: 'Usage: claude auth status',
    stderr: '',
    startedAt: '2026-07-31T10:00:00.000Z',
    finishedAt: '2026-07-31T10:00:00.100Z',
    durationMs: 100,
  };

  it('marks a zero exit with output as AVAILABLE', () => {
    expect(classifyProbe(base)).toBe('AVAILABLE');
  });

  it('marks a non-zero exit as unavailable in the installed version', () => {
    expect(classifyProbe({ ...base, exitCode: 1, stdout: '', stderr: 'unknown command' })).toBe(
      'UNAVAILABLE_IN_INSTALLED_VERSION',
    );
  });

  it('does not accept a silent success as proof of availability', () => {
    expect(classifyProbe({ ...base, stdout: '', stderr: '' })).toBe(
      'UNAVAILABLE_IN_INSTALLED_VERSION',
    );
  });

  it('distinguishes a missing executable from a missing subcommand', () => {
    expect(classifyProbe({ ...base, outcome: 'NOT_FOUND', started: false, exitCode: null })).toBe(
      'EXECUTABLE_NOT_FOUND',
    );
    expect(classifyProbe({ ...base, outcome: 'TIMED_OUT', exitCode: null })).toBe('PROBE_FAILED');
  });

  it('redacts the rendered dump', () => {
    const dump = renderCapabilityDump(
      [
        {
          probe: { id: 'claude.auth.status.help', command: 'claude', args: ['auth', 'status', '--help'], required: true },
          result: { ...base, stdout: 'account person@example.com' },
          availability: 'AVAILABLE',
        },
      ],
      '2026-07-31T10:00:00.000Z',
    );
    expect(dump).not.toContain('person@example.com');
    expect(dump).toContain('<redacted:email>');
    expect(dump).toContain('EXIT CODE  : 0');
    expect(dump).toContain('DURATION   : 100 ms');
  });
});

describe('write probes', () => {
  it('writes and immediately removes the probe file', () => {
    const dir = makeTempDir();
    const before = readdirSync(dir);
    const probe = probeWriteAccess({ label: 'temp', path: dir, createIfMissing: false });

    expect(probe.status).toBe('WRITABLE');
    expect(probe.probeFileRemoved).toBe(true);
    expect(readdirSync(dir)).toEqual(before);
  });

  it('reports a missing directory instead of creating it', () => {
    const dir = join(makeTempDir(), 'does-not-exist');
    const probe = probeWriteAccess({ label: 'missing', path: dir, createIfMissing: false });

    expect(probe.status).toBe('DIRECTORY_MISSING');
    expect(probe.directoryExisted).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('creates the directory only when explicitly allowed', () => {
    const dir = join(makeTempDir(), 'diagnostics');
    const probe = probeWriteAccess({ label: 'diagnostics', path: dir, createIfMissing: true });

    expect(probe.status).toBe('WRITABLE');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('uses a unique probe file name each time', () => {
    const dir = makeTempDir();
    for (let i = 0; i < 5; i += 1) {
      expect(probeWriteAccess({ label: 't', path: dir, createIfMissing: false }).status).toBe(
        'WRITABLE',
      );
    }
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('overall status and exit code', () => {
  const check = (overrides: Partial<DoctorCheck>): DoctorCheck => ({
    id: 'x',
    title: 'x',
    status: 'PASS',
    mandatory: true,
    detail: 'd',
    ...overrides,
  });

  it('passes when every check passes', () => {
    expect(computeOverallStatus([check({}), check({ id: 'y' })])).toBe('PASS');
    expect(exitCodeFor('PASS')).toBe(0);
  });

  it('fails on any FAIL', () => {
    expect(computeOverallStatus([check({}), check({ id: 'y', status: 'FAIL', mandatory: false })])).toBe(
      'FAIL',
    );
    expect(exitCodeFor('FAIL')).toBe(1);
  });

  it('fails when a mandatory check only warns', () => {
    expect(computeOverallStatus([check({ status: 'WARN', mandatory: true })])).toBe('FAIL');
  });

  it('still passes when a non-mandatory check warns', () => {
    expect(computeOverallStatus([check({}), check({ id: 'y', status: 'WARN', mandatory: false })])).toBe(
      'PASS',
    );
  });

  it('passes on an empty check list', () => {
    expect(computeOverallStatus([])).toBe('PASS');
  });
});

describe('console rendering', () => {
  it('renders a bordered table containing the status of each check', () => {
    const table = renderChecksTable([
      { id: 'a', title: 'Node.js >= 22', status: 'PASS', mandatory: true, detail: 'Detected 24.' },
      { id: 'b', title: 'API keys', status: 'WARN', mandatory: false, detail: 'One key present.' },
    ]);
    expect(table).toContain('PASS');
    expect(table).toContain('WARN');
    expect(table).toContain('Node.js >= 22');
    expect(table).toContain('(optional)');
    expect(table.split('\n').every((line) => line.startsWith('+') || line.startsWith('|'))).toBe(true);
  });
});
