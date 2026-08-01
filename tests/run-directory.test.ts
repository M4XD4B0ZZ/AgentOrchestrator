/**
 * AO-007-R2: immutable per-run directories, exclusive creation, no overwrites.
 *
 * The old scheme wrote two fixed file names and decided whether it was allowed
 * to replace an existing file by looking for a marker string *inside* it. That
 * marker is printed into every artefact, so it is public: a file carrying it
 * was treated as ours no matter who wrote it. The "spoofed marker" test below
 * is the direct regression probe for that, and it could not have passed before,
 * because there was no per-run directory to isolate the write.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRunDirectory,
  isValidRunId,
  newRunId,
  removeRunDirectoryIfEmpty,
  RUN_ID_PATTERN,
} from '../src/doctor/run-directory.js';
import { writeRunArtifact } from '../src/doctor/safe-write.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-runs-'));
  tempDirs.push(dir);
  return dir;
}

/** A runs root inside a fresh scratch directory. */
function makeRunsRoot(): string {
  return join(makeTempDir(), 'diagnostics', 'doctor', 'runs');
}

function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('run ids', () => {
  it('combine a UTC timestamp with a random UUID', () => {
    const id = newRunId(new Date('2026-08-01T12:34:56.789Z'));
    expect(id.startsWith('20260801T123456789Z-')).toBe(true);
    expect(RUN_ID_PATTERN.test(id)).toBe(true);
    expect(isValidRunId(id)).toBe(true);
  });

  it('are unique even within the same millisecond', () => {
    const now = new Date('2026-08-01T12:34:56.789Z');
    const ids = new Set(Array.from({ length: 200 }, () => newRunId(now)));
    expect(ids.size).toBe(200);
  });

  it.each([
    '',
    '.',
    '..',
    'run',
    '../escape',
    '..\\escape',
    'a/b',
    'a\\b',
    'C:\\evil',
    '20260801T123456789Z',
    '20260801T123456789Z-not-a-uuid',
    `20260801T123456789Z-${'f'.repeat(36)}`,
    '20260801T123456789Z-3F2A0C11-1111-2222-3333-444455556666',
  ])('rejects the run id %j', (candidate) => {
    expect(isValidRunId(candidate)).toBe(false);
  });
});

describe('creating a run directory', () => {
  it('creates a fresh directory under the runs root', () => {
    const runsRoot = makeRunsRoot();
    const created = createRunDirectory({ runsRoot, runId: newRunId() });

    expect(created.code).toBe('CREATED');
    expect(created.created).toBe(true);
    expect(existsSync(created.path)).toBe(true);
    expect(entries(created.path)).toEqual([]);
    expect(created.path.startsWith(runsRoot)).toBe(true);
  });

  it('gives two consecutive runs two different directories', () => {
    const runsRoot = makeRunsRoot();
    const first = createRunDirectory({ runsRoot, runId: newRunId() });
    const second = createRunDirectory({ runsRoot, runId: newRunId() });

    expect(first.created && second.created).toBe(true);
    expect(first.path).not.toBe(second.path);
    expect(entries(runsRoot)).toHaveLength(2);
  });

  it('never reuses an existing run directory (simulated id collision)', () => {
    const runsRoot = makeRunsRoot();
    const runId = newRunId();
    const first = createRunDirectory({ runsRoot, runId });
    expect(first.code).toBe('CREATED');

    // A parallel run that happened to pick the same id must lose, not share.
    writeFileSync(join(first.path, 'doctor-report.json'), '{"mine":true}\n', 'utf8');
    const second = createRunDirectory({ runsRoot, runId });

    expect(second.code).toBe('RUN_DIRECTORY_EXISTS');
    expect(second.created).toBe(false);
    expect(readFileSync(join(first.path, 'doctor-report.json'), 'utf8')).toBe('{"mine":true}\n');
  });

  it('refuses a directory someone else pre-created at the same name', () => {
    const runsRoot = makeRunsRoot();
    const runId = newRunId();
    mkdirSync(join(runsRoot, runId), { recursive: true });

    const result = createRunDirectory({ runsRoot, runId });
    expect(result.code).toBe('RUN_DIRECTORY_EXISTS');
    expect(result.errnoCode).toBe('EEXIST');
  });

  it.each(['..', 'a/b', 'a\\b', 'C:\\evil', 'nope'])(
    'refuses the traversal-shaped run id %j',
    (runId) => {
      const runsRoot = makeRunsRoot();
      const result = createRunDirectory({ runsRoot, runId });
      expect(result.code).toBe('INVALID_RUN_ID');
      expect(result.created).toBe(false);
      expect(entries(runsRoot)).toEqual([]);
    },
  );

  it('refuses a runs root reached through a link (symlink or Windows junction)', () => {
    const base = makeTempDir();
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real, { recursive: true });

    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // Link creation not permitted here; nothing to assert.
    }

    const result = createRunDirectory({ runsRoot: join(link, 'runs'), runId: newRunId() });
    expect(result.code).toBe('PATH_CONTAINS_LINK');
    expect(result.created).toBe(false);
    expect(existsSync(join(real, 'runs'))).toBe(false);
  });

  it('reports a failure as a fixed code plus an errno identifier', () => {
    const base = makeTempDir();
    // A *file* where the runs root must go: mkdir fails deterministically.
    writeFileSync(join(base, 'blocker'), 'not a directory\n', 'utf8');

    const result = createRunDirectory({
      runsRoot: join(base, 'blocker', 'runs'),
      runId: newRunId(),
    });
    expect(result.created).toBe(false);
    expect(['RUNS_ROOT_CREATE_FAILED', 'RUN_DIRECTORY_CREATE_FAILED']).toContain(result.code);
    expect(JSON.stringify(result)).not.toMatch(/ENOTDIR:.+/);
  });
});

describe('writing artefacts into a run directory', () => {
  function freshRun(): string {
    const created = createRunDirectory({ runsRoot: makeRunsRoot(), runId: newRunId() });
    expect(created.created).toBe(true);
    return created.path;
  }

  it('writes the file and leaves no temporary behind', () => {
    const runDirectory = freshRun();
    const write = writeRunArtifact({
      runDirectory,
      fileName: 'doctor-report.json',
      contents: '{"run":1}\n',
    });

    expect(write.code).toBe('WRITTEN');
    expect(write.written).toBe(true);
    expect(write.temporaryFileRemoved).toBe(true);
    expect(readFileSync(write.path, 'utf8')).toBe('{"run":1}\n');
    expect(entries(runDirectory)).toEqual(['doctor-report.json']);
  });

  it('finalises atomically: the target appears complete or not at all', () => {
    const runDirectory = freshRun();
    const contents = `${'x'.repeat(200_000)}\n`;
    const write = writeRunArtifact({ runDirectory, fileName: 'big.txt', contents });

    expect(write.code).toBe('WRITTEN');
    // Exactly one entry: the temporary is gone, the target is whole.
    expect(entries(runDirectory)).toEqual(['big.txt']);
    expect(readFileSync(write.path, 'utf8')).toBe(contents);
  });

  it('never overwrites an existing file of the same name', () => {
    const runDirectory = freshRun();
    const target = join(runDirectory, 'doctor-report.json');
    writeFileSync(target, '{"someone":"else"}\n', 'utf8');

    const write = writeRunArtifact({
      runDirectory,
      fileName: 'doctor-report.json',
      contents: '{"ours":true}\n',
    });

    expect(write.code).toBe('TARGET_EXISTS');
    expect(write.written).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{"someone":"else"}\n');
    expect(entries(runDirectory)).toEqual(['doctor-report.json']);
  });

  it('grants no ownership to a file carrying the old public content marker', () => {
    const runDirectory = freshRun();
    const target = join(runDirectory, 'doctor-report.json');
    // Exactly what the previous implementation accepted as proof of ownership.
    const spoofed = '{"reportKind":"agent-loop-doctor-report","planted":true}\n';
    writeFileSync(target, spoofed, 'utf8');

    const write = writeRunArtifact({
      runDirectory,
      fileName: 'doctor-report.json',
      contents: '{"ours":true}\n',
    });

    expect(write.code).toBe('TARGET_EXISTS');
    expect(readFileSync(target, 'utf8')).toBe(spoofed);
  });

  it('refuses a target that is a directory or a link', () => {
    const runDirectory = freshRun();
    mkdirSync(join(runDirectory, 'doctor-report.json'));

    const write = writeRunArtifact({
      runDirectory,
      fileName: 'doctor-report.json',
      contents: 'x',
    });
    expect(write.code).toBe('TARGET_EXISTS');
    expect(write.written).toBe(false);
  });

  it.each([
    'ohno/../../evil.json',
    '../evil.json',
    '..\\evil.json',
    'sub/dir.json',
    'sub\\dir.json',
    '/etc/passwd',
    'C:\\Windows\\System32\\evil.json',
    '..',
    '.',
    '',
  ])('refuses the file name %j', (fileName) => {
    const runDirectory = freshRun();
    const write = writeRunArtifact({ runDirectory, fileName, contents: 'x' });

    expect(write.code).toBe('PATH_ESCAPES_RUN_DIRECTORY');
    expect(write.written).toBe(false);
    expect(entries(runDirectory)).toEqual([]);
  });

  it('refuses a run directory reached through a link', () => {
    const base = makeTempDir();
    const real = join(base, 'real-run');
    const link = join(base, 'link-run');
    mkdirSync(real, { recursive: true });

    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const write = writeRunArtifact({
      runDirectory: link,
      fileName: 'doctor-report.json',
      contents: 'x',
    });
    expect(['PATH_CONTAINS_LINK', 'RUN_DIRECTORY_UNUSABLE']).toContain(write.code);
    expect(write.written).toBe(false);
    expect(existsSync(join(real, 'doctor-report.json'))).toBe(false);
  });

  it('refuses to write into a directory that does not exist', () => {
    const write = writeRunArtifact({
      runDirectory: join(makeTempDir(), 'never-created'),
      fileName: 'doctor-report.json',
      contents: 'x',
    });
    expect(write.code).toBe('RUN_DIRECTORY_UNUSABLE');
    expect(write.written).toBe(false);
  });

  it('leaves no temporary file behind on any path', () => {
    const runDirectory = freshRun();
    writeFileSync(join(runDirectory, 'doctor-report.json'), 'foreign\n', 'utf8');

    writeRunArtifact({ runDirectory, fileName: 'doctor-report.json', contents: 'x' });
    writeRunArtifact({ runDirectory, fileName: 'cli-capabilities.txt', contents: 'y' });
    writeRunArtifact({ runDirectory, fileName: '../escape.txt', contents: 'z' });

    expect(entries(runDirectory).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(entries(runDirectory)).toEqual(['cli-capabilities.txt', 'doctor-report.json']);
  });
});

describe('failure cleanup', () => {
  it('removes an empty run directory and nothing else', () => {
    const runsRoot = makeRunsRoot();
    const empty = createRunDirectory({ runsRoot, runId: newRunId() });
    const used = createRunDirectory({ runsRoot, runId: newRunId() });
    writeRunArtifact({ runDirectory: used.path, fileName: 'kept.txt', contents: 'k' });

    expect(removeRunDirectoryIfEmpty(empty.path)).toBe(true);
    expect(existsSync(empty.path)).toBe(false);

    expect(removeRunDirectoryIfEmpty(used.path)).toBe(false);
    expect(existsSync(join(used.path, 'kept.txt'))).toBe(true);
  });

  it('does not touch a run directory that holds a foreign file', () => {
    const runsRoot = makeRunsRoot();
    const run = createRunDirectory({ runsRoot, runId: newRunId() });
    writeFileSync(join(run.path, 'someone-elses.txt'), 'keep me\n', 'utf8');

    expect(removeRunDirectoryIfEmpty(run.path)).toBe(false);
    expect(readFileSync(join(run.path, 'someone-elses.txt'), 'utf8')).toBe('keep me\n');
  });
});
