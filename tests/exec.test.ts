/**
 * AO-008: bounded, tree-killing, fail-closed child-process execution.
 *
 * The Windows-specific cases (`.cmd` shims, `taskkill /T`, paths with spaces)
 * are skipped elsewhere but really run on Windows, which is the target
 * platform.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  runCommand,
  UnsafeArgumentError,
  type CommandResult,
} from '../src/doctor/exec.js';
import { SENSITIVE_MARKER } from './fixtures.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { ExecArtifactRegistry } from './helpers/exec-cleanup.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Every scratch directory, PID file and PID this file creates. The registry
 * owns both the claiming rules and the exhaustive teardown; its own contract is
 * proven in `tests/exec-cleanup.test.ts`.
 */
const artifacts = new ExecArtifactRegistry();

function makeTempDir(prefix = 'agent-loop-exec-'): string {
  return artifacts.registerTempDir(makeCanonicalTempDir(prefix));
}

/**
 * Names the file a helper will record its own PID in, and registers that path
 * for the teardown sweep at the moment it is named — before the helper even
 * starts. The sweep therefore reaches the helper on paths the test body never
 * gets to run: a test timeout inside `runCommand`, or an early return.
 */
function helperPidFile(dir: string, name: string): string {
  return artifacts.registerPidFile(join(dir, name));
}

/**
 * Reads a helper's PID file and registers the PID for cleanup.
 *
 * Call this *before* any assertion about the command's result. A wrong outcome
 * must never strand the helper: while the registration sat after the first
 * expectation, a failing assertion threw past it and left a live `sleep.cjs`
 * behind that teardown had no PID for.
 *
 * Only a PID read from this test's own PID file, whose contents are entirely a
 * positive decimal integer, is ever registered — never a PID parsed out of a
 * child's stdout, and never anything matched by process name.
 */
function claimHelperPid(pidFile: string): number | null {
  return artifacts.claimPid(pidFile);
}

/** A CommonJS script that runs until it is killed. */
function writeSleepScript(dir: string, pidFile?: string): string {
  const path = join(dir, 'sleep.cjs');
  const record =
    pidFile === undefined
      ? ''
      : `require('fs').writeFileSync(${JSON.stringify(pidFile.replace(/\\/g, '/'))}, String(process.pid));\n`;
  writeFileSync(path, `${record}setInterval(function () {}, 1000);\n`, 'utf8');
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, budgetMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

afterEach(async () => {
  // Sweeps the registered PID files a last time (covering a test that threw
  // before its own in-body claim), kills this run's own helpers, then removes
  // every scratch directory. Every artefact is attempted even if an earlier one
  // failed; anything unexpected is reported once the sweep is complete.
  await artifacts.cleanUp();
});

describe('argument validation stays conservative', () => {
  it.each([
    '--version && whoami',
    '$(id)',
    '`id`',
    'a|b',
    'a;b',
    'a>b',
    'a<b',
    'a^b',
    '%PATH%',
    'has space',
    'quote"inside',
    "single'quote",
    '(paren)',
    'new\nline',
    'tab\there',
  ])('refuses the argument %j', async (arg) => {
    await expect(runCommand('node', [arg], { env: process.env })).rejects.toThrow(
      UnsafeArgumentError,
    );
  });

  it('still accepts the inert arguments the diagnostics actually use', async () => {
    const res = await runCommand('node', ['--version'], { env: process.env });
    expect(res.outcome).toBe('COMPLETED');
  });
});

describe('normal execution', () => {
  it('runs a real command and records full timing metadata', async () => {
    const res = await runCommand('node', ['--version'], { env: process.env });
    expect(res.started).toBe(true);
    expect(res.outcome).toBe('COMPLETED');
    expect(res.exitCode).toBe(0);
    expect(res.failureCode).toBeNull();
    expect(res.errnoCode).toBeNull();
    expect(res.stdoutTruncated).toBe(false);
    expect(res.stdout).toMatch(/^v\d+\./);
    expect(Date.parse(res.startedAt)).not.toBeNaN();
    expect(Date.parse(res.finishedAt)).not.toBeNaN();
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a non-zero exit code as data rather than throwing', async () => {
    const res = await runCommand('node', ['--definitely-not-a-node-flag'], { env: process.env });
    expect(res.started).toBe(true);
    expect(res.outcome).toBe('COMPLETED');
    expect(res.exitCode).not.toBe(0);
    expect(res.failureCode).toBeNull();
  });

  it('uses a generous but finite default output budget', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_OUTPUT_BYTES)).toBe(true);
  });
});

describe('missing programs and spawn failures', () => {
  it('reports a missing executable with a distinct code', async () => {
    const res = await runCommand('definitely-not-a-real-binary-xyz', ['--version'], {
      env: process.env,
    });
    expect(res.started).toBe(false);
    expect(res.outcome).toBe('NOT_FOUND');
    expect(res.failureCode).toBe('EXECUTABLE_NOT_FOUND');
    expect(res.exitCode).toBeNull();
    expect(res).not.toHaveProperty('spawnError');
  });

  it('reports an absolute path that does not exist', async () => {
    const missing = join(makeTempDir(), 'nope.exe');
    const res = await runCommand(missing, [], { env: process.env });
    expect(res.started).toBe(false);
    expect(['NOT_FOUND', 'SPAWN_FAILED']).toContain(res.outcome);
    expect(['EXECUTABLE_NOT_FOUND', 'SPAWN_FAILED']).toContain(res.failureCode);
    if (res.errnoCode !== null) expect(res.errnoCode).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
  });
});

describe('timeout', () => {
  it('terminates a process that never ends and reports TIMED_OUT', async () => {
    const dir = makeTempDir();
    const script = writeSleepScript(dir);

    const started = Date.now();
    const res = await runCommand('node', [script], { env: process.env, timeoutMs: 1_500 });

    expect(res.started).toBe(true);
    expect(res.outcome).toBe('TIMED_OUT');
    expect(res.failureCode).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('leaves no live process behind after a timeout', async () => {
    const dir = makeTempDir();
    const pidFile = helperPidFile(dir, 'pid.txt');
    const script = writeSleepScript(dir, pidFile);

    const res = await runCommand('node', [script], { env: process.env, timeoutMs: 2_000 });

    // Before any assertion about `res`: an unexpected outcome must still leave
    // teardown able to reach this helper.
    const pid = claimHelperPid(pidFile);
    expect(pid).not.toBeNull();
    if (pid === null) return;

    expect(res.outcome).toBe('TIMED_OUT');
    expect(await waitUntilDead(pid)).toBe(true);
  });
});

describe('output limits', () => {
  it('cuts stdout off at the byte budget and kills the process', async () => {
    const res = await runCommand('node', ['--version'], {
      env: process.env,
      maxStdoutBytes: 2,
    });
    expect(res.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(res.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
    expect(res.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(2);
  });

  it('cuts stderr off at the byte budget', async () => {
    const res = await runCommand('node', ['--definitely-not-a-node-flag'], {
      env: process.env,
      maxStderrBytes: 4,
    });
    expect(res.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(res.failureCode).toBe('OUTPUT_LIMIT_STDERR');
    expect(res.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(res.stderr, 'utf8')).toBeLessThanOrEqual(4);
  });

  it('does not truncate output that fits the budget', async () => {
    const res = await runCommand('node', ['--version'], {
      env: process.env,
      maxStdoutBytes: 4096,
    });
    expect(res.outcome).toBe('COMPLETED');
    expect(res.stdoutTruncated).toBe(false);
  });

  it('bounds retained output even for an endlessly noisy process', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'noisy.cjs');
    writeFileSync(
      script,
      "const line = 'A'.repeat(1024) + '\\n';\nsetInterval(function () { for (let i = 0; i < 64; i += 1) process.stdout.write(line); }, 5);\n",
      'utf8',
    );

    const res = await runCommand('node', [script], {
      env: process.env,
      timeoutMs: 20_000,
      maxStdoutBytes: 8_192,
    });
    expect(res.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(res.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(8_192);
  });
});

describe('error paths carry no untrusted text', () => {
  /** Every string field of a result, for leak assertions. */
  function metadata(res: CommandResult): string {
    return JSON.stringify({
      display: res.display,
      executable: res.executable,
      args: res.args,
      outcome: res.outcome,
      failureCode: res.failureCode,
      errnoCode: res.errnoCode,
      signal: res.signal,
    });
  }

  it('keeps a marker printed by the child out of every status field', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'leaky.cjs');
    writeFileSync(
      script,
      `process.stderr.write(${JSON.stringify(SENSITIVE_MARKER)});\nsetInterval(function () {}, 1000);\n`,
      'utf8',
    );

    const res = await runCommand('node', [script], { env: process.env, timeoutMs: 1_500 });
    expect(res.outcome).toBe('TIMED_OUT');
    expect(metadata(res)).not.toContain(SENSITIVE_MARKER);
  });

  it('reports only fixed codes for a missing binary', async () => {
    const res = await runCommand('definitely-not-a-real-binary-xyz', [], { env: process.env });
    expect(metadata(res)).not.toMatch(/spawn .*ENOENT/);
    expect(res.failureCode).toBe('EXECUTABLE_NOT_FOUND');
  });
});

// ── Windows-specific hardening ─────────────────────────────────────────────

describe.runIf(IS_WINDOWS)('Windows .cmd shims', () => {
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

  it('runs a .cmd script from a directory whose name contains spaces', async () => {
    const dir = makeTempDir('agent loop spaced ');
    expect(dir).toContain(' ');
    const script = join(dir, 'hello.cmd');
    writeFileSync(script, '@echo off\r\necho HELLO-FROM-CMD\r\n', 'utf8');

    const res = await runCommand(script, [], { env: process.env, timeoutMs: 15_000 });
    expect(res.outcome).toBe('COMPLETED');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('HELLO-FROM-CMD');
  });

  it('passes the semantic value of an inert argument through the cmd.exe shim unchanged', async () => {
    // `%1` would echo the encoder's own quoting syntax (`"--json"`), not the
    // argument's semantic value. `%~1` strips that batch-parameter quoting,
    // which is the value a real .cmd shim's own logic would actually see —
    // matching the oracle convention in tests/windows-batch-command.test.ts.
    const dir = makeTempDir();
    const script = join(dir, 'echoarg.cmd');
    writeFileSync(script, '@echo off\r\necho ARG=%~1\r\n', 'utf8');

    const res = await runCommand(script, ['--json'], { env: process.env, timeoutMs: 15_000 });
    expect(res.outcome).toBe('COMPLETED');
    expect(res.stdout).toContain('ARG=--json');
  });

  it('kills the whole process tree, not just the cmd.exe shim', async () => {
    const dir = makeTempDir();
    const pidFile = helperPidFile(dir, 'grandchild-pid.txt');
    const child = writeSleepScript(dir, pidFile);
    const script = join(dir, 'tree.cmd');
    writeFileSync(script, `@echo off\r\nnode "${child.replace(/\\/g, '/')}"\r\n`, 'utf8');

    const res = await runCommand(script, [], { env: process.env, timeoutMs: 4_000 });

    // Claimed first: the outcome assertions below are exactly the ones that
    // used to throw past the registration and strand this grandchild.
    const grandchildPid = claimHelperPid(pidFile);
    expect(grandchildPid).not.toBeNull();
    if (grandchildPid === null) return;

    expect(res.outcome).toBe('TIMED_OUT');
    expect(res.failureCode).toBe('TIMEOUT');
    expect(res.processTreeKilled).toBe(true);

    // Without taskkill /T this grandchild would survive the "timeout" forever.
    expect(await waitUntilDead(grandchildPid)).toBe(true);
  });

  it('kills the tree when a shim floods stdout past the budget', async () => {
    const dir = makeTempDir();
    const pidFile = helperPidFile(dir, 'noisy-pid.txt');
    const child = join(dir, 'noisy.cjs');
    writeFileSync(
      child,
      `require('fs').writeFileSync(${JSON.stringify(pidFile.replace(/\\/g, '/'))}, String(process.pid));\n` +
        "const line = 'B'.repeat(1024) + '\\n';\nsetInterval(function () { for (let i = 0; i < 64; i += 1) process.stdout.write(line); }, 5);\n",
      'utf8',
    );
    const script = join(dir, 'noisy.cmd');
    writeFileSync(script, `@echo off\r\nnode "${child.replace(/\\/g, '/')}"\r\n`, 'utf8');

    const res = await runCommand(script, [], {
      env: process.env,
      timeoutMs: 30_000,
      maxStdoutBytes: 4_096,
    });

    // Claimed before the outcome assertions, so a wrong failure code cannot
    // leave the flooding helper running.
    const pid = claimHelperPid(pidFile);

    expect(res.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(res.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(4_096);

    if (pid !== null) expect(await waitUntilDead(pid)).toBe(true);
  });

  it('refuses a batch path containing a quote', async () => {
    // The quote check runs before any process starts.
    await expect(runCommand('C:\\tmp\\we"ird.cmd', [], { env: process.env })).rejects.toThrow(
      UnsafeArgumentError,
    );
  });

  it('writes stderr from a shim into the stderr stream only', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'onlyerr.cmd');
    writeFileSync(script, '@echo off\r\necho OOPS 1>&2\r\n', 'utf8');

    const res = await runCommand(script, [], { env: process.env, timeoutMs: 15_000 });
    expect(res.stderr).toContain('OOPS');
    expect(res.stdout).not.toContain('OOPS');
  });
});
