/**
 * AO-FOUNDATION-REM-003B-R2/R3 — the Windows batch-argument codec.
 *
 * Pins the precise, empirically-proven contract of
 * `encodeWindowsBatchArgument` (src/doctor/internal/windows-batch-command.ts)
 * end to end: every roundtrip is verified by actually spawning the trusted
 * `cmd.exe` (exactly as `planSpawn` in `../src/doctor/exec.ts` does — same
 * `/d /s /c`, `shell: false`, `windowsVerbatimArguments: true`) against a
 * batch target this suite writes, and reading back what it received in a
 * machine-readable form — never a bare string-comparison of an expected
 * command line, per the task's own oracle-principle requirement.
 *
 * Nothing here kills a foreign process, and no real Claude/Codex auth command
 * runs.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  encodeWindowsBatchArgument,
  UnsupportedWindowsBatchArgumentError,
} from '../src/doctor/internal/windows-batch-command.js';
import { windowsSystemTool } from '../src/doctor/internal/windows-system-tools.js';

const IS_WINDOWS = process.platform === 'win32';

const tempDirs: string[] = [];
function makeTempDir(prefix = 'ao-batch-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const SENTINEL = 'AO_END_OF_ARGS_batchcodec_test_9f21';

/**
 * The oracle batch target: dumps every `%~N` argument it receives, one per
 * `AO_BEGIN_ARG`/`AO_END_ARG` block, until it sees the fixed sentinel — a
 * machine-readable roundtrip format, not a single opaque string.
 */
function writeOracleScript(dir: string, name = 'oracle.cmd'): string {
  const script = join(dir, name);
  writeFileSync(
    script,
    [
      '@echo off',
      'chcp 65001 >nul',
      'setlocal disabledelayedexpansion',
      ':loop',
      `if "%~1"=="${SENTINEL}" goto done`,
      'echo AO_BEGIN_ARG',
      'echo(%~1',
      'echo AO_END_ARG',
      'shift',
      'goto loop',
      ':done',
      'echo AO_ALL_DONE',
      '',
    ].join('\r\n'),
    'utf8',
  );
  return script;
}

function parseCaptured(stdout: string): string[] {
  const lines = stdout.split(/\r\n|\n/);
  const results: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === 'AO_BEGIN_ARG') {
      results.push(lines[i + 1] ?? '');
      i += 3;
    } else {
      i += 1;
    }
  }
  return results;
}

interface OracleRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Spawns the oracle exactly the way `planSpawn` spawns a `.cmd` target:
 * trusted `cmd.exe`, `shell: false`, `windowsVerbatimArguments: true`,
 * `/d /s /c`, with every argument passed through the real product encoder.
 * Never hangs indefinitely: a bounded timeout force-kills the tree via the
 * trusted `taskkill.exe`, mirroring `killProcessTree` in `exec.ts`.
 */
function runOracle(scriptPath: string, args: readonly string[], timeoutMs = 10_000): Promise<OracleRun> {
  return new Promise((resolvePromise) => {
    const comspec = windowsSystemTool('cmd.exe');
    const encodedArgs = args.map(encodeWindowsBatchArgument);
    const inner = [`"${scriptPath}"`, ...encodedArgs, SENTINEL].join(' ');
    const child = spawn(comspec, ['/d', '/s', '/c', `"${inner}"`], {
      shell: false,
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let settled = false;
    child.stdout?.on('data', (c: Buffer) => (out = Buffer.concat([out, c])));
    child.stderr?.on('data', (c: Buffer) => (err = Buffer.concat([err, c])));

    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout: out.toString('utf8'), stderr: err.toString('utf8'), timedOut });
    };

    const timer = setTimeout(() => {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          execFileSync(windowsSystemTool('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 5_000,
          });
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* best effort */
          }
        }
      }
      finish(true);
    }, timeoutMs);
    timer.unref?.();

    child.on('error', () => finish(false));
    child.on('close', () => finish(false));
  });
}

// ── The codec's own boundary: no experimental quote-escape, fail closed ────

describe('encodeWindowsBatchArgument', () => {
  it('wraps a plain argument in quotes unchanged', () => {
    expect(encodeWindowsBatchArgument('plain')).toBe('"plain"');
  });

  it('wraps an empty argument, producing a non-empty token', () => {
    expect(encodeWindowsBatchArgument('')).toBe('""');
  });

  it('caret-escapes every cmd.exe metacharacter', () => {
    expect(encodeWindowsBatchArgument('(a)')).toBe('"^(a^)"');
    expect(encodeWindowsBatchArgument('a&b')).toBe('"a^&b"');
    expect(encodeWindowsBatchArgument('a^b')).toBe('"a^^b"');
    expect(encodeWindowsBatchArgument('a%b')).toBe('"a^%b"');
    expect(encodeWindowsBatchArgument('a!b')).toBe('"a^!b"');
    expect(encodeWindowsBatchArgument('a|b')).toBe('"a^|b"');
    expect(encodeWindowsBatchArgument('a<b>c')).toBe('"a^<b^>c"');
  });

  it('leaves a trailing backslash untouched (no CRT-style doubling — %~N does not need it)', () => {
    expect(encodeWindowsBatchArgument('a\\')).toBe('"a\\"');
  });

  it('rejects an argument containing a literal double quote, deterministically, without guessing', () => {
    expect(() => encodeWindowsBatchArgument('a"b')).toThrow(UnsupportedWindowsBatchArgumentError);
    expect(() => encodeWindowsBatchArgument('"')).toThrow(UnsupportedWindowsBatchArgumentError);
  });

  it('the quote rejection never carries the argument content', () => {
    const SECRET = 'AO_SECRET_TOKEN_should_not_leak';
    let thrown: unknown;
    try {
      encodeWindowsBatchArgument(`${SECRET}"trailer`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedWindowsBatchArgumentError);
    const error = thrown as Error;
    expect(error.message).not.toContain(SECRET);
    expect(String(error)).not.toContain(SECRET);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET);
    expect(error.stack ?? '').not.toContain(SECRET);
  });
});

// ── End-to-end oracle roundtrip: real cmd.exe, real batch parameter parsing ─

describe.runIf(IS_WINDOWS)('encodeWindowsBatchArgument, end-to-end oracle roundtrip', () => {
  const cases: ReadonlyArray<{ name: string; args: readonly string[] }> = [
    { name: 'empty argument', args: [''] },
    { name: 'multiple consecutive empty arguments', args: ['', '', 'x', ''] },
    { name: 'space', args: ['a b'] },
    { name: 'parens', args: ['(a)'] },
    { name: 'ampersand', args: ['a&b'] },
    { name: 'caret', args: ['a^b'] },
    { name: 'percent', args: ['a%PATH%b'] },
    { name: 'exclamation', args: ['a!b!c'] },
    { name: 'pipe', args: ['a|b'] },
    { name: 'redirection', args: ['a>b<c'] },
    { name: 'unicode', args: ['héllo-Ünïcödé-🚀'] },
    { name: 'trailing backslash', args: ['a\\'] },
    { name: 'multiple trailing backslashes', args: ['a\\\\\\'] },
    { name: 'combination of the above (no embedded quote)', args: ['a b&c^d%e!f|g<h>i\\'] },
    { name: 'arguments before and after an empty one', args: ['first', '', 'last'] },
    { name: 'several distinct arguments in one call', args: ['one', '(two)', 'thr&ee', '', 'f^ive'] },
  ];

  it.each(cases)('$name round-trips exactly', async ({ args }) => {
    const dir = makeTempDir();
    const script = writeOracleScript(dir);
    const run = await runOracle(script, args);
    expect(run.timedOut).toBe(false);
    expect(parseCaptured(run.stdout)).toEqual(args);
  });

  it('a batch path containing spaces and Unicode still resolves and receives its arguments exactly', async () => {
    const dir = makeTempDir('ao-batch-Ünïcödé 🚀 spaced-');
    const script = writeOracleScript(dir);
    const run = await runOracle(script, ['a b', '', 'c&d']);
    expect(run.timedOut).toBe(false);
    expect(parseCaptured(run.stdout)).toEqual(['a b', '', 'c&d']);
  });

  it('the target script runs exactly once, with no second shell layer', async () => {
    const dir = makeTempDir();
    const counterFile = join(dir, 'run-count.txt');
    const script = join(dir, 'counter.cmd');
    writeFileSync(
      script,
      ['@echo off', `echo x >> "${counterFile}"`, 'echo AO_COUNTER_RAN', ''].join('\r\n'),
      'utf8',
    );
    const run = await runOracle(script, ['plain']);
    expect(run.timedOut).toBe(false);
    expect(run.stdout).toContain('AO_COUNTER_RAN');
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(counterFile, 'utf8').split(/\r\n|\n/).filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it('a specially prepared argument does not create an injection sentinel file', async () => {
    const dir = makeTempDir();
    const sentinelFile = join(dir, 'INJECTION_SENTINEL.txt');
    const script = writeOracleScript(dir, 'target.cmd');
    // Every metacharacter class this codec supports, chained together in one
    // argument, is exactly what a caret-escaping bug would most likely fail
    // to neutralise — an attempt to break out into a second command that
    // writes the sentinel. No embedded quote (that class is rejected
    // outright, tested separately above).
    const maliciousArg = `x & echo pwned > ${sentinelFile} & type nul > ${sentinelFile} & rem `;
    const secondArg = `y | type nul > ${sentinelFile}`;
    const run = await runOracle(script, [maliciousArg, secondArg]);
    expect(run.timedOut).toBe(false);
    expect(existsSync(sentinelFile)).toBe(false);
    expect(parseCaptured(run.stdout)).toEqual([maliciousArg, secondArg]);
  });

  it('a fake cmd.exe placed on PATH and a fake COMSPEC are never reached by the oracle run', async () => {
    const dir = makeTempDir();
    const script = writeOracleScript(dir);
    const fakeDir = makeTempDir('ao-batch-fakecmd-');
    const fakeSentinel = join(fakeDir, 'FAKE_CMD_RAN.txt');
    writeFileSync(join(fakeDir, 'cmd.exe'), 'not a real executable\n', 'utf8');
    const previousPath = process.env['PATH'];
    const previousComspec = process.env['COMSPEC'];
    process.env['PATH'] = `${fakeDir}${process.platform === 'win32' ? ';' : ':'}${previousPath ?? ''}`;
    process.env['COMSPEC'] = join(fakeDir, 'cmd.exe');
    try {
      const run = await runOracle(script, ['a&b', '']);
      expect(run.timedOut).toBe(false);
      expect(parseCaptured(run.stdout)).toEqual(['a&b', '']);
      expect(existsSync(fakeSentinel)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
      if (previousComspec === undefined) delete process.env['COMSPEC'];
      else process.env['COMSPEC'] = previousComspec;
    }
  });
});
