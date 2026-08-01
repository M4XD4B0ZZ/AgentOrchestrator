/**
 * AO-007: path-safety primitives behind every persistent artefact.
 *
 * Containment, link detection and plain-name validation are asserted here; the
 * run-directory semantics that use them live in `run-directory.test.ts`, and
 * the fixed write root in `paths.test.ts`.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isContained,
  isPlainFileName,
  pathChain,
  pathContainsLink,
  writeRunArtifact,
} from '../src/doctor/safe-write.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-safewrite-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('containment helpers', () => {
  it('accepts the root itself and anything beneath it', () => {
    const root = makeTempDir();
    expect(isContained(root, root)).toBe(true);
    expect(isContained(root, join(root, 'a', 'b.json'))).toBe(true);
  });

  it('rejects siblings and parents', () => {
    const root = makeTempDir();
    expect(isContained(root, join(root, '..', 'elsewhere'))).toBe(false);
    expect(isContained(root, `${root}-sibling`)).toBe(false);
  });

  it('walks a path down from the filesystem root', () => {
    const chain = pathChain(join('a', 'b', 'c'));
    expect(chain.length).toBeGreaterThanOrEqual(3);
    expect(chain[chain.length - 1]).toBe(resolve('a', 'b', 'c'));
    expect(chain[0]).toBe(resolve(chain[0] ?? ''));
  });
});

describe('plain file names', () => {
  it.each(['doctor-report.json', 'cli-capabilities.txt', 'a', 'a1_b.c-d'])(
    'accepts %j',
    (name) => {
      expect(isPlainFileName(name)).toBe(true);
    },
  );

  it.each(['', '.', '..', 'a/b', 'a\\b', '../x', 'C:\\x', '.hidden', 'x.', 'a..b'])(
    'refuses %j',
    (name) => {
      expect(isPlainFileName(name)).toBe(false);
    },
  );
});

describe('link detection', () => {
  it('finds a directory link anywhere in the path', () => {
    const base = makeTempDir();
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real, { recursive: true });

    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // Not permitted here; nothing to assert.
    }
    expect(pathContainsLink(join(link, 'doctor'))).toBe(true);
  });

  it('accepts a plain path with no links at all', () => {
    expect(pathContainsLink(makeTempDir())).toBe(false);
  });
});

describe('writeRunArtifact reports failures as fixed codes', () => {
  it.runIf(process.platform !== 'win32')(
    'reports a fixed code when the directory is not writable',
    () => {
      const dir = makeTempDir();
      chmodSync(dir, 0o500);
      try {
        const write = writeRunArtifact({
          runDirectory: dir,
          fileName: 'doctor-report.json',
          contents: 'x',
        });
        expect(write.code).toBe('OPEN_FAILED');
        expect(write.written).toBe(false);
        expect(write.errnoCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
        // Nothing was created, so nothing has to be cleaned up.
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('carries only an allow-listed errno code, never a message', () => {
    const base = makeTempDir();
    writeFileSync(join(base, 'blocker'), 'x', 'utf8');
    const write = writeRunArtifact({
      runDirectory: join(base, 'blocker', 'doctor'),
      fileName: 'doctor-report.json',
      contents: 'x',
    });
    expect(write.written).toBe(false);
    if (write.errnoCode !== null) {
      expect(write.errnoCode).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    }
    expect(JSON.stringify(write)).not.toMatch(/ENOTDIR:.+/);
  });
});
