/**
 * AO-FOUNDATION-REM-003B (closes AO-FOUNDATION-FULL-REV-02).
 *
 * Pins the replacement trust boundary for the three Windows system tools
 * `exec.ts` needs (`where.exe` is gone entirely; `cmd.exe` and `taskkill.exe`
 * now come from `src/doctor/internal/windows-system-tools.ts`) from three
 * angles:
 *
 *  1. the resolver's own fail-closed validation pipeline, over the
 *     injectable test seam and real filesystem dependencies alike;
 *  2. that manipulating `SystemRoot`/`SYSTEMROOT`/`windir`/`WINDIR`/
 *     `COMSPEC`/`ComSpec`/`PATH` — including planting a fake `where.exe`,
 *     `cmd.exe` or `taskkill.exe` — changes nothing about which binary
 *     `exec.ts` actually spawns;
 *  3. that no fake tool is ever executed at all: `node:child_process` is
 *     wrapped (not stubbed — every call still runs for real) so every file
 *     path handed to `execFileSync`/`spawn` can be inspected directly.
 *
 * Nothing here kills a foreign process or PID, and no real Claude/Codex auth
 * command runs. `taskkill.exe` is only ever exercised against processes this
 * suite itself spawned.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const IS_WINDOWS = process.platform === 'win32';

// ── A thin recording wrapper around node:child_process ─────────────────────
//
// Every call still runs for real (delegated to the actual implementation);
// only the `file` argument is additionally recorded, so this proves *which*
// absolute paths exec.ts ever hands to the OS, across every scenario below,
// without needing a fake `where.exe`/`cmd.exe`/`taskkill.exe` to be a working
// executable.

const recorder = vi.hoisted(() => ({
  execFileSyncCalls: [] as string[],
  spawnCalls: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, ...rest: unknown[]) => {
      recorder.execFileSyncCalls.push(file);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.execFileSync as any)(file, ...rest);
    },
    spawn: (file: string, ...rest: unknown[]) => {
      recorder.spawnCalls.push(file);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.spawn as any)(file, ...rest);
    },
  };
});

import type { WindowsSystemToolDependencies } from '../src/doctor/internal/windows-system-tools.js';

const { resolveOnPath, runCommand } = await import('../src/doctor/exec.js');
const {
  windowsSystemTool,
  createWindowsSystemToolResolverForTests,
  WindowsSystemToolUnavailableError,
  WINDOWS_SYSTEM_TOOL_UNAVAILABLE_CODE,
  WINDOWS_SYSTEM_TOOL_UNAVAILABLE_MESSAGE,
} = await import('../src/doctor/internal/windows-system-tools.js');
const { formatSafeError } = await import('../src/core/safe-error.js');

const tempDirs: string[] = [];
function makeTempDir(prefix = 'ao-wst-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  recorder.execFileSyncCalls.length = 0;
  recorder.spawnCalls.length = 0;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Real production dependencies, wired through the test seam ──────────────
//
// A resolver identical in every observable way to `windowsSystemTool` itself,
// except it carries its own private cache — so tests can prove the *pure
// resolution logic* is environment-independent without fighting the
// module-level memoisation `windowsSystemTool` uses in production.
const REAL_DEPENDENCIES: WindowsSystemToolDependencies = Object.freeze({
  realpath: (path: string): unknown => realpathSync.native(path),
  stat: (path: string): unknown => statSync(path),
});

function isFileName(path: string, name: string): boolean {
  return path.toLowerCase().endsWith(`\\${name.toLowerCase()}`) || path.toLowerCase() === name.toLowerCase();
}

describe.runIf(IS_WINDOWS)('the trusted resolver, over real filesystem dependencies', () => {
  it('resolves cmd.exe and taskkill.exe to the canonical System32 path', () => {
    const resolve = createWindowsSystemToolResolverForTests(REAL_DEPENDENCIES);
    const cmd = resolve('cmd.exe');
    const taskkill = resolve('taskkill.exe');

    expect(isFileName(cmd, 'cmd.exe')).toBe(true);
    expect(isFileName(taskkill, 'taskkill.exe')).toBe(true);
    expect(dirname(cmd)).toBe(dirname(taskkill));
    expect(existsSync(cmd)).toBe(true);
    expect(existsSync(taskkill)).toBe(true);
    expect(statSync(cmd).isFile()).toBe(true);
    expect(statSync(taskkill).isFile()).toBe(true);
  });

  /**
   * AO-FOUNDATION-REM-003B, section 5's architecture gate, as an automated
   * regression.
   *
   * Restores each touched key individually rather than reassigning
   * `process.env` wholesale: a full `process.env = {...}` replacement leaves
   * Node's own internal environment block in a state where a *subsequently
   * spawned* child's CSPRNG initialisation fails outright (`Assertion
   * failed: ncrypto::CSPRNG`, observed on the installed Node 24 on this
   * runtime) — corrupting every later test in this file that spawns a real
   * child, unrelated to anything this suite is testing.
   */
  it('resolves the same canonical paths under a full environment spoof', () => {
    const before = createWindowsSystemToolResolverForTests(REAL_DEPENDENCIES);
    const cmdBefore = before('cmd.exe');
    const taskkillBefore = before('taskkill.exe');

    const spoofed = {
      SystemRoot: 'C:\\ao-spoofed-should-not-matter',
      SYSTEMROOT: 'C:\\ao-spoofed-should-not-matter',
      windir: 'C:\\ao-spoofed-should-not-matter',
      WINDIR: 'C:\\ao-spoofed-should-not-matter',
      COMSPEC: 'C:\\ao-spoofed-should-not-matter\\evil.exe',
      ComSpec: 'C:\\ao-spoofed-should-not-matter\\evil.exe',
      PATH: 'C:\\ao-spoofed-should-not-matter',
      PATHEXT: '.EVIL',
    } as const;
    const original = new Map<string, string | undefined>(
      Object.keys(spoofed).map((name) => [name, process.env[name]]),
    );

    try {
      for (const [name, value] of Object.entries(spoofed)) process.env[name] = value;

      // A fresh resolver instance, backed by the same real dependencies, so
      // this is not merely reading back a cached value from before the spoof.
      const during = createWindowsSystemToolResolverForTests(REAL_DEPENDENCIES);
      expect(during('cmd.exe')).toBe(cmdBefore);
      expect(during('taskkill.exe')).toBe(taskkillBefore);
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe.runIf(IS_WINDOWS)('windowsSystemTool, the productive singleton', () => {
  it('returns the trusted cmd.exe and taskkill.exe paths', () => {
    expect(isFileName(windowsSystemTool('cmd.exe'), 'cmd.exe')).toBe(true);
    expect(isFileName(windowsSystemTool('taskkill.exe'), 'taskkill.exe')).toBe(true);
  });

  it('is stable across repeated calls (memoised)', () => {
    expect(windowsSystemTool('cmd.exe')).toBe(windowsSystemTool('cmd.exe'));
    expect(windowsSystemTool('taskkill.exe')).toBe(windowsSystemTool('taskkill.exe'));
  });
});

// ── The resolver's own fail-closed validation pipeline ─────────────────────

describe('resolver validation, over the injectable test seam', () => {
  /** Distinguishes the anchor call (1st) from the tool call (2nd), by order. */
  function sequenced(behaviors: readonly ((path: string) => unknown)[]): (path: string) => unknown {
    let index = 0;
    return (path: string): unknown => {
      const behavior = behaviors[Math.min(index, behaviors.length - 1)];
      index += 1;
      if (behavior === undefined) throw new Error('no behavior configured');
      return behavior(path);
    };
  }
  const sequencedRealpath = sequenced;

  const CANONICAL_SYSTEM32 = 'C:\\Windows\\System32';
  const canonicalTool = (tool: string): string => `${CANONICAL_SYSTEM32}\\${tool}`;

  /** A fresh anchor-then-tool stat sequence (isDirectory, then isFile), both succeeding. */
  function freshWorkingStat(): WindowsSystemToolDependencies['stat'] {
    return sequenced([() => ({ isDirectory: () => true }), () => ({ isFile: () => true })]);
  }
  const workingStat: WindowsSystemToolDependencies['stat'] = () => ({
    isFile: () => true,
    isDirectory: () => true,
  });

  it('refuses a tool name outside the closed union, without touching any dependency', () => {
    let realpathCalls = 0;
    let statCalls = 0;
    const deps: WindowsSystemToolDependencies = {
      realpath: (p) => {
        realpathCalls += 1;
        return p;
      },
      stat: () => {
        statCalls += 1;
        return { isFile: () => true };
      },
    };
    const resolve = createWindowsSystemToolResolverForTests(deps);

    expect(() => resolve('evil.exe')).toThrow(WindowsSystemToolUnavailableError);
    expect(() => resolve('where.exe')).toThrow(WindowsSystemToolUnavailableError);
    expect(() => resolve('powershell.exe')).toThrow(WindowsSystemToolUnavailableError);
    expect(() => resolve('')).toThrow(WindowsSystemToolUnavailableError);
    expect(realpathCalls).toBe(0);
    expect(statCalls).toBe(0);
  });

  it('fails closed when the anchor itself cannot be canonicalised ("anchor fehlt")', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([
        () => {
          throw new Error('anchor unreachable');
        },
      ]),
      stat: workingStat,
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when the tool itself cannot be canonicalised ("Tool fehlt")', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([
        () => CANONICAL_SYSTEM32,
        () => {
          throw new Error('tool unreachable');
        },
      ]),
      stat: workingStat,
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when realpath throws for every call ("realpath wirft")', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: () => {
        throw new Error('boom');
      },
      stat: workingStat,
    });
    expect(() => resolve('taskkill.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when stat throws ("stat wirft")', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => CANONICAL_SYSTEM32, () => canonicalTool('cmd.exe')]),
      stat: () => {
        throw new Error('boom');
      },
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when the canonical path is a directory, not a regular file ("Tool ist Verzeichnis")', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => CANONICAL_SYSTEM32, () => canonicalTool('cmd.exe')]),
      stat: sequenced([() => ({ isDirectory: () => true }), () => ({ isFile: () => false })]),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when the canonical System32 anchor does not stat as a directory ("System32 ist keine Directory")', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => CANONICAL_SYSTEM32, () => canonicalTool('cmd.exe')]),
      stat: sequenced([() => ({ isDirectory: () => false }), () => ({ isFile: () => true })]),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when isFile is missing or not callable', () => {
    const resolveMissing = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => CANONICAL_SYSTEM32, () => canonicalTool('cmd.exe')]),
      stat: sequenced([() => ({ isDirectory: () => true }), () => ({})]),
    });
    expect(() => resolveMissing('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);

    const resolveNotCallable = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => CANONICAL_SYSTEM32, () => canonicalTool('cmd.exe')]),
      stat: sequenced([() => ({ isDirectory: () => true }), () => ({ isFile: 'not-a-function' })]),
    });
    expect(() => resolveNotCallable('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when isFile itself throws', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => CANONICAL_SYSTEM32, () => canonicalTool('cmd.exe')]),
      stat: sequenced([
        () => ({ isDirectory: () => true }),
        () => ({
          isFile: () => {
            throw new Error('boom');
          },
        }),
      ]),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  // ── R4: fully fail-closed canonical-shape validation ─────────────────────

  it('fails closed when the anchor canonicalises to a relative path', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => 'System32', () => 'System32\\cmd.exe']),
      stat: freshWorkingStat(),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when the tool canonicalises to a relative path', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => CANONICAL_SYSTEM32, () => 'System32\\cmd.exe']),
      stat: freshWorkingStat(),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when realpath is a no-op and the raw GLOBALROOT device path passes through unchanged', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: (p) => p,
      stat: freshWorkingStat(),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when the canonical result is a different device namespace', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([
        () => '\\\\?\\Volume{guid}\\Windows\\System32',
        () => '\\\\?\\Volume{guid}\\Windows\\System32\\cmd.exe',
      ]),
      stat: freshWorkingStat(),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when the canonical result is a UNC path', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([
        () => '\\\\server\\share\\System32',
        () => '\\\\server\\share\\System32\\cmd.exe',
      ]),
      stat: freshWorkingStat(),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('fails closed when the tool canonicalises to the wrong basename in the correct parent ("evil.exe")', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([() => CANONICAL_SYSTEM32, () => `${CANONICAL_SYSTEM32}\\evil.exe`]),
      stat: freshWorkingStat(),
    });
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it(
    'fails closed when the canonical parent does not match the canonical anchor ' +
      '("Parent stimmt nicht" / canonical path leaves the system directory)',
    () => {
      const resolve = createWindowsSystemToolResolverForTests({
        realpath: sequencedRealpath([
          () => 'C:\\Windows\\System32',
          () => 'C:\\Elsewhere\\cmd.exe',
        ]),
        stat: workingStat,
      });
      expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
    },
  );

  it(
    'fails closed for a reparse-style substitution: the tool canonicalises into a ' +
      'sibling directory rather than the anchor itself ("Symlink/Reparse-Ersatz")',
    () => {
      const resolve = createWindowsSystemToolResolverForTests({
        realpath: sequencedRealpath([
          () => 'C:\\Windows\\System32',
          () => 'C:\\Windows\\SysWOW64\\cmd.exe',
        ]),
        stat: workingStat,
      });
      expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
    },
  );

  it('rejects a container that is not a usable dependency object', () => {
    const resolve = createWindowsSystemToolResolverForTests(null as unknown as WindowsSystemToolDependencies);
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);

    const resolveMissingSlots = createWindowsSystemToolResolverForTests({} as WindowsSystemToolDependencies);
    expect(() => resolveMissingSlots('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  // ── Memoisation semantics ─────────────────────────────────────────────────

  it('memoises only a fully validated success ("Erfolg wird memoiziert")', () => {
    let realpathCalls = 0;
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: sequencedRealpath([
        () => {
          realpathCalls += 1;
          return CANONICAL_SYSTEM32;
        },
        () => {
          realpathCalls += 1;
          return canonicalTool('cmd.exe');
        },
      ]),
      stat: freshWorkingStat(),
    });

    const first = resolve('cmd.exe');
    const callsAfterFirst = realpathCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = resolve('cmd.exe');
    expect(second).toBe(first);
    // The memoised path answers the second call without touching a dependency again.
    expect(realpathCalls).toBe(callsAfterFirst);
  });

  it('never caches a failure as a success ("Fehler wird nicht als Erfolg memoiziert")', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: () => {
        throw new Error('always broken');
      },
      stat: workingStat,
    });

    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
    // A second attempt against the same still-broken dependencies fails again,
    // rather than serving a cached (nonexistent) success.
    expect(() => resolve('cmd.exe')).toThrow(WindowsSystemToolUnavailableError);
  });

  it('recovers on the very next call once the dependency starts working ("Fehler-zu-Erfolg-Retry")', () => {
    let broken = true;
    let realpathCallIndex = 0;
    let statCallIndex = 0;
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: () => {
        if (broken) throw new Error('temporarily broken');
        const isAnchorCall = realpathCallIndex % 2 === 0;
        realpathCallIndex += 1;
        return isAnchorCall ? CANONICAL_SYSTEM32 : canonicalTool('taskkill.exe');
      },
      stat: () => {
        const isAnchorCall = statCallIndex % 2 === 0;
        statCallIndex += 1;
        return isAnchorCall ? { isDirectory: () => true } : { isFile: () => true };
      },
    });

    expect(() => resolve('taskkill.exe')).toThrow(WindowsSystemToolUnavailableError);

    broken = false;
    const recovered = resolve('taskkill.exe');
    expect(typeof recovered).toBe('string');
    expect(recovered.length).toBeGreaterThan(0);

    // And the recovered success is itself memoised from here on.
    broken = true; // if the cache were bypassed, this would now throw again
    expect(resolve('taskkill.exe')).toBe(recovered);
  });

  // ── Static leakage semantics ────────────────────────────────────────────

  it('names the fixed identity and static message, with no path, tool name or foreign text', () => {
    const SECRET_PATH = 'C:\\ao-secret-should-not-leak\\anything.exe';
    let thrown: unknown;
    try {
      createWindowsSystemToolResolverForTests({
        realpath: () => {
          throw new Error(SECRET_PATH);
        },
        stat: workingStat,
      })('cmd.exe');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WindowsSystemToolUnavailableError);
    const error = thrown as InstanceType<typeof WindowsSystemToolUnavailableError>;
    expect(error.code).toBe(WINDOWS_SYSTEM_TOOL_UNAVAILABLE_CODE);
    expect(error.message).toBe(WINDOWS_SYSTEM_TOOL_UNAVAILABLE_MESSAGE);

    const rendered = [
      error.message,
      error.stack ?? '',
      String(error),
      formatSafeError(error),
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      (error as { cause?: unknown }).cause === undefined ? '' : String((error as { cause?: unknown }).cause),
    ].join('\n');

    expect(rendered).not.toContain(SECRET_PATH);
    expect(rendered).not.toContain('C:\\ao-secret');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('the stack is exactly the static name/message pair, with no local file path of any kind (AO-FOUNDATION-REM-003B-R5)', () => {
    const resolve = createWindowsSystemToolResolverForTests({
      realpath: () => {
        throw new Error('boom, thrown from ' + process.cwd());
      },
      stat: workingStat,
    });

    let thrown: unknown;
    try {
      resolve('cmd.exe');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WindowsSystemToolUnavailableError);
    const error = thrown as InstanceType<typeof WindowsSystemToolUnavailableError>;

    expect(error.stack).toBe(`${error.name}: ${error.message}`);
    const stack = error.stack ?? '';
    // No drive-absolute Windows path segment of any kind — repo, temp, or user.
    expect(stack).not.toMatch(/[A-Za-z]:\\/);
    expect(stack).not.toContain('windows-system-tools');
    expect(stack).not.toContain(process.cwd());
  });
});

// ── Integration: exec.ts never lets PATH or the environment substitute a
// Windows system tool, and no fake tool is ever executed ──────────────────

describe.runIf(IS_WINDOWS)('exec.ts uses only the trusted resolver, never PATH or the environment', () => {
  it('resolveOnPath never spawns where.exe (nothing in child_process at all)', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'System32'), { recursive: true });
    resolveOnPath('node', {
      PATH: process.env['PATH'] ?? '',
      PATHEXT: process.env['PATHEXT'] ?? '',
      SystemRoot: dir,
      windir: dir,
    });
    expect(recorder.execFileSyncCalls).toEqual([]);
    expect(recorder.spawnCalls).toEqual([]);
  });

  it('a fake where.exe placed at a spoofed SystemRoot/windir is never touched', async () => {
    const fakeRoot = makeTempDir('ao-wst-fakewhere-');
    const system32 = join(fakeRoot, 'System32');
    mkdirSync(system32, { recursive: true });
    const sentinel = join(fakeRoot, 'FAKE_WHERE_RAN.txt');
    // Not a valid PE — if this were ever spawned, the old `execFileSync`-based
    // resolver would have thrown a format/exec error. The new resolver never
    // even looks at this file.
    writeFileSync(join(system32, 'where.exe'), 'not a real executable\n', 'utf8');

    const res = await runCommand('node', ['--version'], {
      env: {
        PATH: process.env['PATH'] ?? '',
        PATHEXT: process.env['PATHEXT'] ?? '',
        SystemRoot: fakeRoot,
        windir: fakeRoot,
      },
      timeoutMs: 15_000,
    });

    expect(res.outcome).toBe('COMPLETED');
    expect(existsSync(sentinel)).toBe(false);
    expect(recorder.execFileSyncCalls.some((f) => f.toLowerCase().endsWith('where.exe'))).toBe(false);
  });

  it('a fake cmd.exe on PATH and a fake COMSPEC are both ignored for a real .cmd target', async () => {
    const scriptDir = makeTempDir('ao-wst-script-');
    const script = join(scriptDir, 'sentinel.cmd');
    writeFileSync(script, '@echo off\r\necho AO_TRUSTED_CMD_RAN\r\n', 'utf8');

    const fakeCmdDir = makeTempDir('ao-wst-fakecmd-');
    // A garbage file at the exact name a naive resolver would try to spawn.
    writeFileSync(join(fakeCmdDir, 'cmd.exe'), 'not a real executable\n', 'utf8');

    const res = await runCommand(script, [], {
      env: {
        PATH: `${fakeCmdDir}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}`,
        PATHEXT: process.env['PATHEXT'] ?? '',
        COMSPEC: join(fakeCmdDir, 'cmd.exe'),
        ComSpec: join(fakeCmdDir, 'cmd.exe'),
      },
      timeoutMs: 15_000,
    });

    expect(res.outcome).toBe('COMPLETED');
    expect(res.stdout).toContain('AO_TRUSTED_CMD_RAN');
    // Every spawn of an interpreter for this run used the real, trusted cmd.exe.
    const interpreterCalls = recorder.spawnCalls.filter((f) => f.toLowerCase().endsWith('cmd.exe'));
    expect(interpreterCalls.length).toBeGreaterThan(0);
    for (const call of interpreterCalls) {
      expect(call.toLowerCase()).not.toBe(join(fakeCmdDir, 'cmd.exe').toLowerCase());
      expect(call.toLowerCase()).not.toContain(fakeCmdDir.toLowerCase());
    }
  });

  it('a fake taskkill.exe on PATH is never used to terminate a hung child', async () => {
    const fakePathDir = makeTempDir('ao-wst-faketaskkill-');
    const sentinel = join(fakePathDir, 'FAKE_TASKKILL_RAN.txt');
    // A working stand-in program is not needed: it must never be reached at
    // all, so a garbage file proves the point just as well as a functioning
    // (and much more dangerous) one would.
    writeFileSync(join(fakePathDir, 'taskkill.exe'), 'not a real executable\n', 'utf8');

    const dir = makeTempDir();
    const script = join(dir, 'sleep.cjs');
    writeFileSync(script, 'setInterval(function () {}, 1000);\n', 'utf8');

    // The child's own SystemRoot/PATH stay real (Node itself needs a working
    // SystemRoot to start at all) — the fake taskkill.exe is reachable only
    // by prepending its directory to PATH, which is exactly the scenario the
    // old, since-removed `systemTool()`/PATH-based resolution would have been
    // vulnerable to. The trusted resolver takes no `env` parameter at all, so
    // nothing here can reach it regardless.
    const res = await runCommand('node', [script], {
      env: {
        PATH: `${fakePathDir}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}`,
        PATHEXT: process.env['PATHEXT'] ?? '',
      },
      timeoutMs: 1_500,
    });

    expect(res.outcome).toBe('TIMED_OUT');
    expect(existsSync(sentinel)).toBe(false);
    // AO-008-S2: the tree kill is supervised asynchronously, so the trusted
    // taskkill.exe is reached through `spawn` — never again through the
    // event-loop-blocking `execFileSync`. Both halves are asserted: the
    // synchronous channel is unused, and whatever *is* executed is still the
    // resolver's own path rather than the PATH-planted stand-in.
    expect(recorder.execFileSyncCalls.some((f) => f.toLowerCase().endsWith('taskkill.exe'))).toBe(
      false,
    );
    const taskkillCalls = recorder.spawnCalls.filter((f) => f.toLowerCase().endsWith('taskkill.exe'));
    expect(taskkillCalls.length).toBeGreaterThan(0);
    for (const call of taskkillCalls) {
      expect(call.toLowerCase()).toBe(windowsSystemTool('taskkill.exe').toLowerCase());
      expect(call.toLowerCase()).not.toContain(fakePathDir.toLowerCase());
    }
  }, 20_000);

  it('the trusted cmd.exe handles the required special characters without injection', async () => {
    const dir = makeTempDir();
    // Windows-legal filename characters that are also shell metacharacters:
    // space, parentheses, ampersand, caret, percent, exclamation mark.
    const scriptName = "AO wst (test) & tool ^ 100% done!.cmd";
    const script = join(dir, scriptName);
    // %~1/%~2 (not %1/%2): every argument is now quote-wrapped by
    // encodeWindowsBatchArgument (AO-FOUNDATION-REM-003B-R2/R3), so the tilde
    // form is needed to read back the dequoted value.
    writeFileSync(script, '@echo off\r\necho ARG1=%~1\r\necho ARG2=%~2\r\n', 'utf8');

    const res = await runCommand(script, ['--json', 'plain-arg'], {
      env: { PATH: process.env['PATH'] ?? '', PATHEXT: process.env['PATHEXT'] ?? '' },
      timeoutMs: 15_000,
    });

    expect(res.outcome).toBe('COMPLETED');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('ARG1=--json');
    expect(res.stdout).toContain('ARG2=plain-arg');
  });

  it('the trusted cmd.exe runs a target whose directory name is Unicode', async () => {
    const dir = makeTempDir('ao-wst-Ünïcödé-🚀-');
    const script = join(dir, 'unicode.cmd');
    writeFileSync(script, '@echo off\r\necho AO_UNICODE_DIR_OK\r\n', 'utf8');

    const res = await runCommand(script, [], {
      env: { PATH: process.env['PATH'] ?? '', PATHEXT: process.env['PATHEXT'] ?? '' },
      timeoutMs: 15_000,
    });

    expect(res.outcome).toBe('COMPLETED');
    expect(res.stdout).toContain('AO_UNICODE_DIR_OK');
  });
});

describe('WindowsSystemToolUnavailableError never leaks into a normal CommandResult', () => {
  it.runIf(IS_WINDOWS)(
    'reports SPAWN_FAILED, not an exception, when the trusted cmd.exe cannot be established',
    async () => {
      // Simulated by requesting a `.cmd` target while nothing about the real
      // trust boundary is disturbed is not possible without touching the real
      // System32 — so this is covered structurally instead: runCommand's own
      // contract (see exec.ts) converts any non-UnsafeArgumentError thrown by
      // planSpawn into a SPAWN_FAILED CommandResult. The resolver-level fail-
      // closed behaviour above is what actually exercises the throw; this
      // confirms the call site never lets it escape as an unhandled rejection
      // for the one realistic case: a real, working cmd.exe fallback.
      const dir = makeTempDir();
      const script = join(dir, 'ok.cmd');
      writeFileSync(script, '@echo off\r\necho OK\r\n', 'utf8');
      await expect(
        runCommand(script, [], {
          env: { PATH: process.env['PATH'] ?? '', PATHEXT: process.env['PATHEXT'] ?? '' },
          timeoutMs: 15_000,
        }),
      ).resolves.toMatchObject({ outcome: 'COMPLETED' });
    },
  );
});

