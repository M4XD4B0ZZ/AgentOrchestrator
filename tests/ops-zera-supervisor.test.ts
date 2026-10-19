/**
 * The Zera supervisor's source, versioned (ADR 2026-10-19, decision D6 = A).
 *
 * `ops/zera-supervisor/` holds a byte-for-byte copy of the files the scheduled
 * task `\Zera\Zera unattended supervisor` runs from `C:\Users\Max\AO-runs`. The
 * copy is not executed by anything in this repository and not deployed by this
 * change. These checks guard it in CI until a deployment exists:
 *
 *  - the set of files is exactly the versioned one (no transcript, no state
 *    file, no historical folder slips in: nine transcripts hold the ntfy topic);
 *  - every PowerShell file keeps its UTF-8 BOM and every file its LF line ends
 *    (measured on the production copy, 2026-10-19) — Windows PowerShell 5.1
 *    misreads an em-dash in a BOM-less script, and a deployed copy must stay
 *    byte-equal to a commit;
 *  - no credential is in any file;
 *  - every AO module the supervisor imports from `dist/` still has its source
 *    in `src/`, so a refactor of AO cannot silently break the supervisor;
 *  - on Windows, the supervisor passes its own wiring test (each grant flag is
 *    reachable only through the lane that proved it).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OPS = join(REPO_ROOT, 'ops', 'zera-supervisor');

const VERSIONED_FILES = [
  'README.md',
  'ao-classify.mjs',
  'zera-delivery-gate.mjs',
  'zera-grant-lab.mjs',
  'zera-operator-repair-grant.mjs',
  'zera-quota-grant.mjs',
  'zera-register-task.ps1',
  'zera-supervisor.ps1',
  'zera-wiring-test.ps1',
  'zera-writer-death-grant.mjs',
] as const;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /ntfy\.sh\/[A-Za-z0-9_-]{6,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const bytesOf = (name: string): Buffer => readFileSync(join(OPS, name));

describe('ops/zera-supervisor (ADR 2026-10-19, D6 = A)', () => {
  it('holds exactly the versioned source, test and guide files', () => {
    expect(readdirSync(OPS).sort()).toEqual([...VERSIONED_FILES].sort());
  });

  it('keeps the UTF-8 BOM on every PowerShell file', () => {
    const scripts = VERSIONED_FILES.filter((name) => name.endsWith('.ps1'));
    expect(scripts.length).toBe(3);
    for (const name of scripts) {
      expect([...bytesOf(name).subarray(0, 3)], name).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it('keeps the LF line ends it runs with today', () => {
    for (const name of VERSIONED_FILES) {
      const text = bytesOf(name).toString('latin1');
      expect(text.includes('\n'), name).toBe(true);
      expect(text.includes('\r'), name).toBe(false);
    }
  });

  it('holds no credential', () => {
    for (const name of VERSIONED_FILES) {
      const text = bytesOf(name).toString('utf8');
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(pattern.test(text), `${name} matches ${pattern}`).toBe(false);
      }
    }
  });

  it('imports only AO modules whose source still exists', () => {
    const modules = new Set<string>();
    for (const name of VERSIONED_FILES.filter((file) => file.endsWith('.mjs'))) {
      // Written as `join(AO_ROOT, 'dist', 'core', 'task-state.js')`.
      const text = bytesOf(name).toString('utf8');
      for (const match of text.matchAll(/'dist'((?:,\s*'[A-Za-z0-9._-]+')+)\)/g)) {
        const segments = [...(match[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1]);
        modules.add(segments.join('/').replace(/\.js$/, ''));
      }
    }
    expect(modules.size).toBeGreaterThan(0);
    for (const module of modules) {
      expect(existsSync(join(REPO_ROOT, 'src', `${module}.ts`)), module).toBe(true);
    }
  });

  it.runIf(process.platform === 'win32')('passes its own wiring test', () => {
    const run = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(OPS, 'zera-wiring-test.ps1'),
        join(OPS, 'zera-supervisor.ps1'),
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/WIRING_VERDICT = ALL_PASS/);
    expect(run.stdout).toMatch(/WIRING_FAILED = 0/);
  }, 150_000);
});
