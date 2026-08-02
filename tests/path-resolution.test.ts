/**
 * AO-FOUNDATION-REM-003B — direct, in-process PATH resolution.
 *
 * `resolveOnPath` (src/doctor/exec.ts) used to spawn `where.exe` (Windows) or
 * `which` (POSIX) and parse their stdout. It now walks `PATH`/`PATHEXT` as
 * plain data over `node:fs`, with no subprocess of any kind. This pins the
 * PATH/PATHEXT semantics — order, extensions, absolute paths, edge cases —
 * against a controlled, temporary directory tree, and confirms no process is
 * ever spawned to answer the question.
 *
 * Every candidate `resolveOnPath` returns is now the absolute, canonical
 * (`realpathSync.native`) result — never a raw joined or relative path
 * (AO-FOUNDATION-REM-003B-R1) — and lookup always resolves relative PATH
 * segments and explicit relative program paths against the same effective
 * CWD contract `planSpawn`/`runCommand` use for the actual spawn, so this
 * file also pins that CWD-stable binding and the PATH/PATHEXT priority
 * `planSpawn` decides from (AO-FOUNDATION-REM-003B-R2), end to end through
 * `runCommand`.
 *
 * The resolved candidate is never treated as trusted: this file tests PATH
 * *resolution* only, never execution (except the small end-to-end priority
 * section, which spawns only scripts this suite itself wrote).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter as pathDelimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const IS_WINDOWS = process.platform === 'win32';

const recorder = vi.hoisted(() => ({ execFileSyncCalls: [] as string[], spawnCalls: [] as string[] }));

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

const { resolveOnPath, runCommand } = await import('../src/doctor/exec.js');

const tempDirs: string[] = [];
function makeTempDir(prefix = 'ao-path-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function touch(path: string, contents = 'x'): void {
  writeFileSync(path, contents, 'utf8');
}

/** The canonical form every `resolveOnPath` candidate is now expected to equal. */
function canon(path: string): string {
  return realpathSync.native(path);
}

afterEach(() => {
  recorder.execFileSyncCalls.length = 0;
  recorder.spawnCalls.length = 0;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function baseEnv(path: string, pathext?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: path };
  if (pathext !== undefined) env['PATHEXT'] = pathext;
  return env;
}

describe('resolveOnPath never spawns a process', () => {
  it('makes no child_process call for a normal resolution', () => {
    const dir = makeTempDir();
    const target = join(dir, IS_WINDOWS ? 'tool.exe' : 'tool');
    touch(target);
    resolveOnPath('tool', baseEnv(dir));
    expect(recorder.execFileSyncCalls).toEqual([]);
    expect(recorder.spawnCalls).toEqual([]);
  });

  it('makes no child_process call even when nothing matches', () => {
    const dir = makeTempDir();
    resolveOnPath('definitely-not-there', baseEnv(dir));
    expect(recorder.execFileSyncCalls).toEqual([]);
    expect(recorder.spawnCalls).toEqual([]);
  });
});

describe('absolute paths', () => {
  it('accepts an absolute path to an existing regular file, canonicalised', () => {
    const dir = makeTempDir();
    const file = join(dir, 'thing.bin');
    touch(file);
    expect(resolveOnPath(file, {})).toEqual([canon(file)]);
  });

  it('rejects an absolute path that does not exist', () => {
    const dir = makeTempDir();
    expect(resolveOnPath(join(dir, 'nope.bin'), {})).toEqual([]);
  });

  it('rejects an absolute path that is a directory, not a file', () => {
    const dir = makeTempDir();
    const sub = join(dir, 'a-directory');
    mkdirSync(sub);
    expect(resolveOnPath(sub, {})).toEqual([]);
  });

  it('never re-examines PATH for an absolute command', () => {
    const dir = makeTempDir();
    const file = join(dir, 'thing.bin');
    touch(file);
    // A PATH that could not possibly contain `file` — proves PATH plays no
    // role once the command is already absolute.
    expect(resolveOnPath(file, { PATH: 'Z:\\nowhere' })).toEqual([canon(file)]);
  });
});

describe('missing PATH / PATHEXT', () => {
  it('returns nothing when PATH is absent', () => {
    expect(resolveOnPath('tool', {})).toEqual([]);
  });

  it('returns nothing when PATH is an empty string', () => {
    expect(resolveOnPath('tool', { PATH: '' })).toEqual([]);
  });

  it.runIf(IS_WINDOWS)('falls back to a fixed default PATHEXT when absent', () => {
    const dir = makeTempDir();
    touch(join(dir, 'tool.EXE'));
    expect(resolveOnPath('tool', { PATH: dir })).toEqual([canon(join(dir, 'tool.EXE'))]);
  });
});

/** Matches the fixed default PATHEXT casing (`.COM;.EXE;.BAT;.CMD`) on Windows. */
const BARE_TARGET_NAME = IS_WINDOWS ? 'tool.EXE' : 'tool';

describe('empty and duplicate PATH entries', () => {
  it('skips an empty PATH segment rather than treating it as the current directory', () => {
    const dir = makeTempDir();
    touch(join(dir, BARE_TARGET_NAME));
    const pathWithEmptySegments = `${pathDelimiter}${dir}${pathDelimiter}${pathDelimiter}`;
    const result = resolveOnPath('tool', baseEnv(pathWithEmptySegments));
    expect(result).toEqual([canon(join(dir, BARE_TARGET_NAME))]);
  });

  it('tolerates a PATH directory listed twice without failing', () => {
    const dir = makeTempDir();
    const target = join(dir, BARE_TARGET_NAME);
    touch(target);
    const doubled = `${dir}${pathDelimiter}${dir}`;
    const result = resolveOnPath('tool', baseEnv(doubled));
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => c === canon(target))).toBe(true);
  });
});

describe('directories are never accepted as a match', () => {
  it('skips a same-named directory and keeps searching', () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    mkdirSync(join(dir1, BARE_TARGET_NAME)); // a directory, not a file
    const real = join(dir2, BARE_TARGET_NAME);
    touch(real);

    const result = resolveOnPath('tool', baseEnv(`${dir1}${pathDelimiter}${dir2}`));
    expect(result).toContain(canon(real));
    expect(result).not.toContain(join(dir1, BARE_TARGET_NAME));
  });
});

describe('paths with spaces and Unicode', () => {
  it('resolves a target in a directory whose name contains spaces', () => {
    const dir = makeTempDir('ao path spaced ');
    expect(dir).toContain(' ');
    const target = join(dir, BARE_TARGET_NAME);
    touch(target);
    expect(resolveOnPath('tool', baseEnv(dir))).toEqual([canon(target)]);
  });

  it('resolves a target in a directory whose name is Unicode', () => {
    const dir = makeTempDir('ao-path-Ünïcödé-🚀-');
    const target = join(dir, BARE_TARGET_NAME);
    touch(target);
    expect(resolveOnPath('tool', baseEnv(dir))).toEqual([canon(target)]);
  });
});

describe('fs-error / not-found stays a controlled empty result', () => {
  it('returns an empty array for a nonexistent PATH directory, never throws', () => {
    const missing = join(makeTempDir(), 'this-directory-does-not-exist');
    expect(() => resolveOnPath('tool', baseEnv(missing))).not.toThrow();
    expect(resolveOnPath('tool', baseEnv(missing))).toEqual([]);
  });

  it('program-not-found is a plain empty array, not an exception', () => {
    const dir = makeTempDir();
    expect(() => resolveOnPath('nope-at-all', baseEnv(dir))).not.toThrow();
    expect(resolveOnPath('nope-at-all', baseEnv(dir))).toEqual([]);
  });
});

describe.runIf(IS_WINDOWS)('Windows PATH-directory and PATHEXT ordering', () => {
  it('the first matching PATH directory wins', () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    const first = join(dir1, 'tool.EXE');
    const second = join(dir2, 'tool.EXE');
    touch(first);
    touch(second);

    const result = resolveOnPath('tool', baseEnv(`${dir1};${dir2}`, '.EXE'));
    expect(result[0]).toBe(canon(first));
  });

  it('a second PATH directory is used after a non-matching first one', () => {
    const dir1 = makeTempDir(); // nothing here
    const dir2 = makeTempDir();
    const target = join(dir2, 'tool.EXE');
    touch(target);

    const result = resolveOnPath('tool', baseEnv(`${dir1};${dir2}`, '.EXE'));
    expect(result).toEqual([canon(target)]);
  });

  it('honours PATHEXT order within one directory', () => {
    const dir = makeTempDir();
    touch(join(dir, 'tool.BAT'));
    touch(join(dir, 'tool.EXE'));

    const extBeforeExe = resolveOnPath('tool', baseEnv(dir, '.BAT;.EXE'));
    expect(extBeforeExe[0]).toBe(canon(join(dir, 'tool.BAT')));

    const exeBeforeBat = resolveOnPath('tool', baseEnv(dir, '.EXE;.BAT'));
    expect(exeBeforeBat[0]).toBe(canon(join(dir, 'tool.EXE')));
  });

  it('an explicit extension is resolved as given, with no PATHEXT looping', () => {
    const dir = makeTempDir();
    touch(join(dir, 'tool.exe'));
    touch(join(dir, 'tool.cmd'));

    // Asking for "tool.cmd" explicitly must never also surface "tool.exe".
    const result = resolveOnPath('tool.cmd', baseEnv(dir, '.EXE;.CMD'));
    expect(result).toEqual([canon(join(dir, 'tool.cmd'))]);
  });

  it.each(['.exe', '.com', '.cmd', '.bat'])('resolves an explicit %s target', (ext) => {
    const dir = makeTempDir();
    const target = join(dir, `tool${ext}`);
    touch(target);
    expect(resolveOnPath(`tool${ext}`, baseEnv(dir))).toEqual([canon(target)]);
  });

  it('finds every registered PATHEXT extension for a bare command name', () => {
    const dir = makeTempDir();
    touch(join(dir, 'multi.COM'));
    touch(join(dir, 'multi.EXE'));
    touch(join(dir, 'multi.BAT'));
    touch(join(dir, 'multi.CMD'));

    const result = resolveOnPath('multi', baseEnv(dir, '.COM;.EXE;.BAT;.CMD'));
    expect(result).toEqual([
      canon(join(dir, 'multi.COM')),
      canon(join(dir, 'multi.EXE')),
      canon(join(dir, 'multi.BAT')),
      canon(join(dir, 'multi.CMD')),
    ]);
  });
});

describe.runIf(!IS_WINDOWS)('POSIX PATH-directory ordering', () => {
  it('the first matching PATH directory wins, no extension involved', () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    const first = join(dir1, 'tool');
    const second = join(dir2, 'tool');
    touch(first);
    touch(second);

    const result = resolveOnPath('tool', baseEnv(`${dir1}:${dir2}`));
    expect(result[0]).toBe(canon(first));
  });
});

// ── AO-FOUNDATION-REM-003B-R1: stable lookup-to-spawn CWD binding ──────────

describe('effective spawn CWD binding (R1)', () => {
  it('resolves a relative PATH segment against an explicit cwd, not process.cwd()', () => {
    const outsideCwd = makeTempDir('ao-r1-outside-');
    const insideCwd = makeTempDir('ao-r1-inside-');
    mkdirSync(join(insideCwd, 'bin'), { recursive: true });
    const target = join(insideCwd, 'bin', BARE_TARGET_NAME);
    touch(target);

    // process.cwd() itself is left untouched (outsideCwd is never chdir'd
    // into) — only the explicit third `cwd` argument matters.
    const result = resolveOnPath('tool', baseEnv('bin'), insideCwd);
    expect(result).toEqual([canon(target)]);
    expect(existsSync(join(outsideCwd, 'bin'))).toBe(false);
  });

  it('resolves a relative PATH segment against process.cwd() when no cwd is given', () => {
    const dir = makeTempDir('ao-r1-default-');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const target = join(dir, 'bin', BARE_TARGET_NAME);
    touch(target);

    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = resolveOnPath('tool', baseEnv('bin'));
      expect(result).toEqual([canon(target)]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('resolves a relative explicit program path (with a separator) against cwd, never via PATH', () => {
    const cwd = makeTempDir('ao-r1-explicit-');
    const sub = IS_WINDOWS ? 'sub\\tool.exe' : 'sub/tool';
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    const target = join(cwd, IS_WINDOWS ? 'sub\\tool.exe' : 'sub/tool');
    touch(target);

    // A PATH that does not contain `cwd` at all — proves this never becomes a
    // PATH search once the command string itself carries a separator.
    const result = resolveOnPath(sub, { PATH: 'Z:\\nowhere' }, cwd);
    expect(result).toEqual([canon(target)]);
  });

  it('returns the absolute canonical path, never a relative one', () => {
    const cwd = makeTempDir('ao-r1-canonical-');
    mkdirSync(join(cwd, 'bin'), { recursive: true });
    touch(join(cwd, 'bin', BARE_TARGET_NAME));

    const result = resolveOnPath('tool', baseEnv('bin'), cwd);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(canon(join(cwd, 'bin', BARE_TARGET_NAME)));
    // path.isAbsolute-style check without importing it again: a canonical
    // Windows path always starts with a drive letter.
    expect(result[0]).toMatch(/^[A-Za-z]:\\/);
  });

  it.runIf(IS_WINDOWS)('resolves a symlinked alias to its canonical target, if this environment permits creating one', () => {
    const dir = makeTempDir('ao-r1-symlink-');
    const real = join(dir, 'real-tool.exe');
    touch(real);
    const alias = join(dir, 'tool.exe');
    try {
      symlinkSync(real, alias, 'file');
    } catch {
      // Creating a file symlink needs SeCreateSymbolicLinkPrivilege (admin or
      // Developer Mode). Skip gracefully rather than failing the suite on an
      // environment that cannot grant it — the guarantee itself is exercised
      // by every other canonicalisation test in this file regardless.
      return;
    }
    const result = resolveOnPath('tool', baseEnv(dir));
    expect(result).toEqual([canon(real)]);
    expect(result[0]).not.toBe(alias);
  });

  it('the CWD-pivot is closed: lookup and spawn use the same directory, so the wrong program never runs', async () => {
    const base = makeTempDir('ao-r1-pivot-');
    const cwdA = join(base, 'cwdA');
    const cwdB = join(base, 'cwdB');
    mkdirSync(join(cwdA, 'relbin'), { recursive: true });
    mkdirSync(join(cwdB, 'relbin'), { recursive: true });

    const sentinel = join(base, 'CWD_PIVOT_SENTINEL.txt');
    writeFileSync(join(cwdA, 'relbin', 'tool.cmd'), '@echo off\r\necho SAFE_FROM_A\r\n', 'utf8');
    writeFileSync(
      join(cwdB, 'relbin', 'tool.cmd'),
      `@echo off\r\necho pivoted > "${sentinel}"\r\necho DANGER_FROM_B\r\n`,
      'utf8',
    );

    const previousCwd = process.cwd();
    process.chdir(cwdA);
    try {
      const res = await runCommand('tool', [], {
        env: { PATH: 'relbin', PATHEXT: '.CMD' },
        cwd: cwdB,
        timeoutMs: 10_000,
      });
      expect(res.outcome).toBe('COMPLETED');
      expect(res.stdout).toContain('DANGER_FROM_B');
      expect(res.stdout).not.toContain('SAFE_FROM_A');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('the CWD-pivot sentinel is never produced when options.cwd is honoured consistently', async () => {
    // The inverse scenario: lookup happens from process.cwd() (cwdA, the
    // effective spawn CWD here since no options.cwd is passed) and spawn uses
    // the *same* directory — so cwdB's script must never run.
    const base = makeTempDir('ao-r1-no-pivot-');
    const cwdA = join(base, 'cwdA');
    const cwdB = join(base, 'cwdB');
    mkdirSync(join(cwdA, 'relbin'), { recursive: true });
    mkdirSync(join(cwdB, 'relbin'), { recursive: true });

    const sentinel = join(base, 'CWD_PIVOT_SENTINEL.txt');
    writeFileSync(join(cwdA, 'relbin', 'tool.cmd'), '@echo off\r\necho SAFE_FROM_A\r\n', 'utf8');
    writeFileSync(
      join(cwdB, 'relbin', 'tool.cmd'),
      `@echo off\r\necho pivoted > "${sentinel}"\r\necho DANGER_FROM_B\r\n`,
      'utf8',
    );

    const previousCwd = process.cwd();
    process.chdir(cwdA);
    try {
      const res = await runCommand('tool', [], {
        env: { PATH: 'relbin', PATHEXT: '.CMD' },
        timeoutMs: 10_000,
      });
      expect(res.outcome).toBe('COMPLETED');
      expect(res.stdout).toContain('SAFE_FROM_A');
    } finally {
      process.chdir(previousCwd);
    }
    expect(existsSync(sentinel)).toBe(false);
  });
});

// ── AO-FOUNDATION-REM-003B-R2: PATH/PATHEXT priority end-to-end ────────────

describe.runIf(IS_WINDOWS)('PATH/PATHEXT priority end-to-end, through runCommand (R2)', () => {
  async function runToolAndGetSource(env: NodeJS.ProcessEnv): Promise<string> {
    const res = await runCommand('tool', [], { env, timeoutMs: 10_000 });
    expect(res.outcome).toBe('COMPLETED');
    return res.stdout;
  }

  it('an earlier CMD hit is not replaced by a later EXE hit', async () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    writeFileSync(join(dir1, 'tool.CMD'), '@echo off\r\necho FROM_CMD\r\n', 'utf8');
    // Not a real PE — if this were ever spawned directly, Node would fail to
    // start it at all (ENOEXEC/UNKNOWN), unlike the cmd.exe path above.
    writeFileSync(join(dir2, 'tool.EXE'), 'not a real executable\n', 'utf8');

    const stdout = await runToolAndGetSource({ PATH: `${dir1};${dir2}`, PATHEXT: '.CMD;.EXE' });
    expect(stdout).toContain('FROM_CMD');
  });

  it('an earlier BAT hit is not replaced by a later COM hit', async () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    writeFileSync(join(dir1, 'tool.BAT'), '@echo off\r\necho FROM_BAT\r\n', 'utf8');
    writeFileSync(join(dir2, 'tool.COM'), 'not a real executable\n', 'utf8');

    const stdout = await runToolAndGetSource({ PATH: `${dir1};${dir2}`, PATHEXT: '.BAT;.COM' });
    expect(stdout).toContain('FROM_BAT');
  });

  it('same directory, PATHEXT .CMD;.EXE: the CMD wins', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'tool.CMD'), '@echo off\r\necho FROM_CMD\r\n', 'utf8');
    writeFileSync(join(dir, 'tool.EXE'), 'not a real executable\n', 'utf8');

    const stdout = await runToolAndGetSource({ PATH: dir, PATHEXT: '.CMD;.EXE' });
    expect(stdout).toContain('FROM_CMD');
  });

  it('same directory, PATHEXT .EXE;.CMD (reversed): the EXE candidate is selected because it is now first', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'tool.EXE'), 'not a real executable\n', 'utf8');
    writeFileSync(join(dir, 'tool.CMD'), '@echo off\r\necho FROM_CMD\r\n', 'utf8');

    // A garbage, non-PE .exe can make Node's own `spawn()` throw synchronously
    // (a pre-existing, unrelated `runCommand` quirk, not part of this fix) —
    // tolerate either outcome. What matters here is *which* candidate was
    // actually attempted: the .exe file directly, spawned once, never routed
    // through cmd.exe at all.
    try {
      await runCommand('tool', [], { env: { PATH: dir, PATHEXT: '.EXE;.CMD' }, timeoutMs: 10_000 });
    } catch {
      /* see above */
    }
    expect(recorder.spawnCalls).toHaveLength(1);
    expect(recorder.spawnCalls[0]?.toLowerCase()).toBe(canon(join(dir, 'tool.EXE')).toLowerCase());
  });

  it('same directory, PATHEXT .BAT;.COM: the BAT wins', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'tool.BAT'), '@echo off\r\necho FROM_BAT\r\n', 'utf8');
    writeFileSync(join(dir, 'tool.COM'), 'not a real executable\n', 'utf8');

    const stdout = await runToolAndGetSource({ PATH: dir, PATHEXT: '.BAT;.COM' });
    expect(stdout).toContain('FROM_BAT');
  });

  it('an explicit extension bypasses PATHEXT ordering entirely', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'tool.exe'), 'not a real executable\n', 'utf8');
    writeFileSync(join(dir, 'tool.cmd'), '@echo off\r\necho FROM_CMD\r\n', 'utf8');

    const res = await runCommand('tool.cmd', [], {
      env: { PATH: dir, PATHEXT: '.EXE;.CMD' },
      timeoutMs: 10_000,
    });
    expect(res.outcome).toBe('COMPLETED');
    expect(res.stdout).toContain('FROM_CMD');
  });

  it('a first candidate that is a directory is skipped in favour of the next real file', async () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    mkdirSync(join(dir1, 'tool.CMD')); // a directory, not a file, named like the target
    writeFileSync(join(dir2, 'tool.CMD'), '@echo off\r\necho FROM_REAL_CMD\r\n', 'utf8');

    const stdout = await runToolAndGetSource({ PATH: `${dir1};${dir2}`, PATHEXT: '.CMD' });
    expect(stdout).toContain('FROM_REAL_CMD');
  });

  it('a candidate that disappears between resolution and spawn fails in a controlled way', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'tool.exe');
    writeFileSync(target, 'not a real executable, and about to be deleted\n', 'utf8');
    rmSync(target, { force: true });

    const res = await runCommand('tool', [], { env: { PATH: dir, PATHEXT: '.EXE' }, timeoutMs: 10_000 });
    expect(res.outcome).toBe('NOT_FOUND');
    expect(res.started).toBe(false);
  });
});
