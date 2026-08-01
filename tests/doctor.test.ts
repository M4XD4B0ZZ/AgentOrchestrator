import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { redact, redactAndClamp } from '../src/auth/redaction.js';
import { computeOverallStatus, exitCodeFor, type DoctorCheck } from '../src/doctor/report.js';
import { renderChecksTable } from '../src/doctor/render.js';
import { probeWriteAccess } from '../src/doctor/write-access.js';
import { SENSITIVE_MARKER } from './fixtures.js';

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

  it('does not recognise an arbitrary marker — which is why it is not the boundary', () => {
    // Deliberate: redaction is defence in depth only. Nothing in the report
    // pipeline may *rely* on it, because it cannot know every secret shape.
    expect(redact(SENSITIVE_MARKER)).toBe(SENSITIVE_MARKER);
  });
});

// Capability classification, token extraction and the rendered summary are
// covered in `capabilities.test.ts` (AO-002-R1).

describe('write probes', () => {
  it('writes and immediately removes the probe file', () => {
    const dir = makeTempDir();
    const before = readdirSync(dir);
    const probe = probeWriteAccess({ label: 'temp', path: dir, createIfMissing: false });

    expect(probe.status).toBe('WRITABLE');
    expect(probe.reasonCode).toBe('WRITABLE');
    expect(probe.errnoCode).toBeNull();
    expect(probe.probeFileRemoved).toBe(true);
    expect(readdirSync(dir)).toEqual(before);
  });

  it('reports a missing directory instead of creating it', () => {
    const dir = join(makeTempDir(), 'does-not-exist');
    const probe = probeWriteAccess({ label: 'missing', path: dir, createIfMissing: false });

    expect(probe.status).toBe('DIRECTORY_MISSING');
    expect(probe.reasonCode).toBe('DIRECTORY_MISSING');
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

  it('reports a failure as a fixed code plus an errno identifier, never a message', () => {
    const base = makeTempDir();
    // A *file* where a directory must go: mkdir fails deterministically.
    const blocker = join(base, 'blocker');
    writeFileSync(blocker, 'not a directory\n', 'utf8');

    const probe = probeWriteAccess({
      label: 'blocked',
      path: join(blocker, 'child'),
      createIfMissing: true,
    });

    expect(probe.status).toBe('NOT_WRITABLE');
    expect(probe.reasonCode).toBe('DIRECTORY_CREATE_FAILED');
    expect(probe.errnoCode).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    // No OS message, no quoted path fragment from an exception.
    expect(probe.reason).toBe(
      'Directory does not exist and could not be created.',
    );
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
    expect(
      computeOverallStatus([check({}), check({ id: 'y', status: 'FAIL', mandatory: false })]),
    ).toBe('FAIL');
    expect(exitCodeFor('FAIL')).toBe(1);
  });

  it('fails when a mandatory check only warns', () => {
    expect(computeOverallStatus([check({ status: 'WARN', mandatory: true })])).toBe('FAIL');
  });

  it('still passes when a non-mandatory check warns', () => {
    expect(
      computeOverallStatus([check({}), check({ id: 'y', status: 'WARN', mandatory: false })]),
    ).toBe('PASS');
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
    expect(table.split('\n').every((line) => line.startsWith('+') || line.startsWith('|'))).toBe(
      true,
    );
  });
});
