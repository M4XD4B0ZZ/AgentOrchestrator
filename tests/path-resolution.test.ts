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
 * The resolved candidate is never treated as trusted: this file tests PATH
 * *resolution* only, never execution.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const { resolveOnPath } = await import('../src/doctor/exec.js');

const tempDirs: string[] = [];
function makeTempDir(prefix = 'ao-path-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function touch(path: string, contents = 'x'): void {
  writeFileSync(path, contents, 'utf8');
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
  it('accepts an absolute path to an existing regular file', () => {
    const dir = makeTempDir();
    const file = join(dir, 'thing.bin');
    touch(file);
    expect(resolveOnPath(file, {})).toEqual([file]);
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
    expect(resolveOnPath(file, { PATH: 'Z:\\nowhere' })).toEqual([file]);
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
    // The fixed default (`.COM;.EXE;.BAT;.CMD`) is uppercase; Windows paths are
    // case-insensitive on disk, but the candidate string this module builds
    // echoes the PATHEXT entry's own casing rather than re-reading it back off
    // the filesystem — harmless (`planSpawn` already lowercases before
    // comparing), and pinned here rather than left implicit.
    touch(join(dir, 'tool.EXE'));
    expect(resolveOnPath('tool', { PATH: dir })).toEqual([join(dir, 'tool.EXE')]);
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
    expect(result).toEqual([join(dir, BARE_TARGET_NAME)]);
  });

  it('tolerates a PATH directory listed twice without failing', () => {
    const dir = makeTempDir();
    const target = join(dir, BARE_TARGET_NAME);
    touch(target);
    const doubled = `${dir}${pathDelimiter}${dir}`;
    const result = resolveOnPath('tool', baseEnv(doubled));
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => c === target)).toBe(true);
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
    expect(result).toContain(real);
    expect(result).not.toContain(join(dir1, BARE_TARGET_NAME));
  });
});

describe('paths with spaces and Unicode', () => {
  it('resolves a target in a directory whose name contains spaces', () => {
    const dir = makeTempDir('ao path spaced ');
    expect(dir).toContain(' ');
    const target = join(dir, BARE_TARGET_NAME);
    touch(target);
    expect(resolveOnPath('tool', baseEnv(dir))).toEqual([target]);
  });

  it('resolves a target in a directory whose name is Unicode', () => {
    const dir = makeTempDir('ao-path-Ünïcödé-🚀-');
    const target = join(dir, BARE_TARGET_NAME);
    touch(target);
    expect(resolveOnPath('tool', baseEnv(dir))).toEqual([target]);
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
    expect(result[0]).toBe(first);
  });

  it('a second PATH directory is used after a non-matching first one', () => {
    const dir1 = makeTempDir(); // nothing here
    const dir2 = makeTempDir();
    const target = join(dir2, 'tool.EXE');
    touch(target);

    const result = resolveOnPath('tool', baseEnv(`${dir1};${dir2}`, '.EXE'));
    expect(result).toEqual([target]);
  });

  it('honours PATHEXT order within one directory', () => {
    const dir = makeTempDir();
    touch(join(dir, 'tool.BAT'));
    touch(join(dir, 'tool.EXE'));

    const extBeforeExe = resolveOnPath('tool', baseEnv(dir, '.BAT;.EXE'));
    expect(extBeforeExe[0]).toBe(join(dir, 'tool.BAT'));

    const exeBeforeBat = resolveOnPath('tool', baseEnv(dir, '.EXE;.BAT'));
    expect(exeBeforeBat[0]).toBe(join(dir, 'tool.EXE'));
  });

  it('an explicit extension is resolved as given, with no PATHEXT looping', () => {
    const dir = makeTempDir();
    touch(join(dir, 'tool.exe'));
    touch(join(dir, 'tool.cmd'));

    // Asking for "tool.cmd" explicitly must never also surface "tool.exe".
    const result = resolveOnPath('tool.cmd', baseEnv(dir, '.EXE;.CMD'));
    expect(result).toEqual([join(dir, 'tool.cmd')]);
  });

  it.each(['.exe', '.com', '.cmd', '.bat'])('resolves an explicit %s target', (ext) => {
    const dir = makeTempDir();
    const target = join(dir, `tool${ext}`);
    touch(target);
    expect(resolveOnPath(`tool${ext}`, baseEnv(dir))).toEqual([target]);
  });

  it('finds every registered PATHEXT extension for a bare command name', () => {
    const dir = makeTempDir();
    touch(join(dir, 'multi.COM'));
    touch(join(dir, 'multi.EXE'));
    touch(join(dir, 'multi.BAT'));
    touch(join(dir, 'multi.CMD'));

    const result = resolveOnPath('multi', baseEnv(dir, '.COM;.EXE;.BAT;.CMD'));
    expect(result).toEqual([
      join(dir, 'multi.COM'),
      join(dir, 'multi.EXE'),
      join(dir, 'multi.BAT'),
      join(dir, 'multi.CMD'),
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
    expect(result[0]).toBe(first);
  });
});
