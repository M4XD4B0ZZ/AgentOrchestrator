/**
 * AO-007-R2-RR1 / AO-007-R2-RR2: the append-only run protocol.
 *
 * What this replaces, and why every probe here would have failed before:
 *
 *  - artefacts were written to a `.<name>.<uuid>.tmp` file and finalised with
 *    `linkSync`, with a `targetExists()` check followed by `renameSync` as a
 *    fallback. That fallback is a TOCTOU race — `rename` replaces an existing
 *    target on both Windows and POSIX — and success depended on a temporary
 *    file being unlinked afterwards. The "no temporary name ever exists" and
 *    "no link/rename/temp primitive in the product code" probes below both fail
 *    on that implementation;
 *  - a run had no end. A directory holding a report was indistinguishable from
 *    one whose writer had died halfway, and the report papered over it by
 *    claiming its own successful persistence. Everything below about the
 *    `COMPLETED` marker is new behaviour with no predecessor to pass it.
 *
 * The failure paths are exercised by faulting the real syscalls through a
 * `node:fs` mock, so the production code is the code under test.
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
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PACKAGE_ROOT } from '../src/config/paths.js';
import {
  completeRun,
  COMPLETION_MARKER_CONTENTS,
  COMPLETION_MARKER_FILE_NAME,
  inspectRun,
  listCompletedRuns,
  type RunCompletionResult,
  type RunInspection,
  RUN_PROTOCOL_VERSION,
} from '../src/doctor/run-completion.js';
import { createRunDirectory, newRunId } from '../src/doctor/run-directory.js';
import { writeRunArtifact } from '../src/doctor/safe-write.js';

/**
 * The fault injector. `null` means "behave normally", which is the state during
 * every setup step and every positive test.
 */
const fault = vi.hoisted(() => ({
  current: null as null | { readonly call: string; readonly code: string; readonly short?: boolean },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const faulted =
    <K extends 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync'>(name: K) =>
    (...args: Parameters<(typeof actual)[K]>): unknown => {
      if (fault.current?.call === name) {
        if (fault.current.short === true) return 0; // a short write, not a throw
        const error: NodeJS.ErrnoException = new Error(`injected ${name} failure`);
        error.code = fault.current.code;
        throw error;
      }
      return (actual[name] as (...a: unknown[]) => unknown)(...args);
    };

  return {
    ...actual,
    default: actual,
    openSync: faulted('openSync'),
    writeSync: faulted('writeSync'),
    fsyncSync: faulted('fsyncSync'),
    closeSync: faulted('closeSync'),
  };
});

const ARTEFACTS = ['cli-capabilities.txt', 'doctor-report.json'] as const;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-runproto-'));
  tempDirs.push(dir);
  return dir;
}

function makeRunsRoot(): string {
  return join(makeTempDir(), 'diagnostics', 'doctor', 'runs');
}

function freshRun(runsRoot = makeRunsRoot()): string {
  const created = createRunDirectory({ runsRoot, runId: newRunId() });
  expect(created.created).toBe(true);
  return created.path;
}

function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Writes both artefacts of a normal run. */
function writeArtefacts(runDirectory: string): void {
  for (const [index, name] of ARTEFACTS.entries()) {
    const write = writeRunArtifact({
      runDirectory,
      fileName: name,
      contents: `content ${index}\n`,
    });
    expect(write.code).toBe('WRITTEN');
  }
}

/** `completeRun` for a run directory produced by `freshRun`. */
function complete(
  runDirectory: string,
  expectedArtefacts: readonly string[] = ARTEFACTS,
): RunCompletionResult {
  return completeRun({ runDirectory, expectedArtefacts });
}

/**
 * `inspectRun` under the new `(runsRoot, runId)` contract, recovered from a
 * concrete run directory path the way `createRunDirectory` built it: as
 * `join(resolve(runsRoot), runId)`. `dirname`/`basename` invert that exactly.
 */
function inspect(runDirectory: string): RunInspection {
  return inspectRun(dirname(runDirectory), basename(runDirectory));
}

beforeEach(() => {
  fault.current = null;
});

afterEach(() => {
  fault.current = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('a normal run', () => {
  it('produces both artefacts and then the marker, in that order', () => {
    const runDirectory = freshRun();
    writeArtefacts(runDirectory);
    // The marker does not exist while the artefacts are being written.
    expect(existsSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME))).toBe(false);

    const completion = complete(runDirectory);

    expect(completion.code).toBe('COMPLETED');
    expect(completion.completed).toBe(true);
    expect(entries(runDirectory)).toEqual([...ARTEFACTS, COMPLETION_MARKER_FILE_NAME].sort());
    expect(inspect(runDirectory).consumable).toBe(true);
  });

  it('puts nothing but the fixed protocol version in the marker', () => {
    const runDirectory = freshRun();
    writeArtefacts(runDirectory);
    complete(runDirectory);

    const contents = readFileSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME), 'utf8');
    expect(contents).toBe(COMPLETION_MARKER_CONTENTS);
    expect(contents.trim()).toBe(RUN_PROTOCOL_VERSION);
    // No path, no host, no user, no timestamp, no status. The protocol
    // version's own fixed `/1` suffix is not a path separator, so only a
    // Windows drive letter or a backslash counts as path-shaped here.
    expect(contents).not.toMatch(/[A-Za-z]:\\/);
    expect(contents).not.toContain('\\');
    expect(contents).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(contents.length).toBeLessThan(64);
  });

  it('keeps two runs completely separate', () => {
    const runsRoot = makeRunsRoot();
    const first = freshRun(runsRoot);
    const second = freshRun(runsRoot);
    expect(first).not.toBe(second);

    for (const runDirectory of [first, second]) {
      writeArtefacts(runDirectory);
      expect(complete(runDirectory).completed).toBe(true);
    }

    expect(readdirSync(runsRoot)).toHaveLength(2);
    expect(listCompletedRuns(runsRoot)).toHaveLength(2);
    expect(readFileSync(join(first, 'doctor-report.json'), 'utf8')).toBe('content 1\n');
  });
});

describe('nothing existing is ever replaced', () => {
  it('refuses a run id whose directory already exists (parallel collision)', () => {
    const runsRoot = makeRunsRoot();
    const runId = newRunId();
    const first = createRunDirectory({ runsRoot, runId });
    writeFileSync(join(first.path, 'doctor-report.json'), 'mine\n', 'utf8');

    const second = createRunDirectory({ runsRoot, runId });
    expect(second.code).toBe('RUN_DIRECTORY_EXISTS');
    expect(second.created).toBe(false);
    expect(readFileSync(join(first.path, 'doctor-report.json'), 'utf8')).toBe('mine\n');
  });

  it.each([...ARTEFACTS])('refuses to replace an existing %s', (name) => {
    const runDirectory = freshRun();
    writeFileSync(join(runDirectory, name), 'someone else\n', 'utf8');

    const write = writeRunArtifact({ runDirectory, fileName: name, contents: 'ours\n' });

    expect(write.code).toBe('TARGET_EXISTS');
    expect(write.written).toBe(false);
    expect(write.errnoCode).toBe('EEXIST');
    expect(readFileSync(join(runDirectory, name), 'utf8')).toBe('someone else\n');
  });

  it('refuses to replace an existing COMPLETED marker', () => {
    const runDirectory = freshRun();
    writeArtefacts(runDirectory);
    writeFileSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME), 'planted\n', 'utf8');

    const completion = complete(runDirectory);

    expect(completion.code).toBe('MARKER_EXISTS');
    expect(completion.completed).toBe(false);
    expect(readFileSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME), 'utf8')).toBe('planted\n');
    // And a planted marker with the wrong content does not make the run usable.
    expect(inspect(runDirectory).code).toBe('COMPLETION_MARKER_INVALID');
  });
});

describe('write failure paths never report success', () => {
  it('reports a failing open without creating anything', () => {
    const runDirectory = freshRun();
    fault.current = { call: 'openSync', code: 'EACCES' };

    const write = writeRunArtifact({
      runDirectory,
      fileName: 'cli-capabilities.txt',
      contents: 'x\n',
    });

    expect(write.code).toBe('OPEN_FAILED');
    expect(write.written).toBe(false);
    expect(write.errnoCode).toBe('EACCES');
    fault.current = null;
    expect(entries(runDirectory)).toEqual([]);
  });

  it.each([
    ['during the capability write', 'cli-capabilities.txt'],
    ['during the report write', 'doctor-report.json'],
  ])('reports a failing write %s and leaves the run incomplete', (_label, fileName) => {
    const runDirectory = freshRun();
    fault.current = { call: 'writeSync', code: 'ENOSPC' };

    const write = writeRunArtifact({ runDirectory, fileName, contents: 'x'.repeat(1000) });

    expect(write.code).toBe('WRITE_FAILED');
    expect(write.written).toBe(false);
    expect(write.errnoCode).toBe('ENOSPC');

    fault.current = null;
    // The partial artefact stays for diagnosis, and there is no marker.
    expect(entries(runDirectory)).toEqual([fileName]);
    const completion = complete(runDirectory);
    expect(completion.completed).toBe(false);
    expect(inspect(runDirectory).consumable).toBe(false);
  });

  it('treats a short write as a failure, not as a complete write', () => {
    const runDirectory = freshRun();
    fault.current = { call: 'writeSync', code: 'EIO', short: true };

    const write = writeRunArtifact({
      runDirectory,
      fileName: 'doctor-report.json',
      contents: 'x'.repeat(1000),
    });

    expect(write.code).toBe('WRITE_FAILED');
    expect(write.written).toBe(false);
    expect(write.bytesWritten).toBeLessThan(1000);
  });

  it('reports a failing fsync as SYNC_FAILED', () => {
    const runDirectory = freshRun();
    fault.current = { call: 'fsyncSync', code: 'EIO' };

    const write = writeRunArtifact({
      runDirectory,
      fileName: 'doctor-report.json',
      contents: 'x\n',
    });

    expect(write.code).toBe('SYNC_FAILED');
    expect(write.written).toBe(false);
    expect(write.synced).toBe(false);
    expect(write.errnoCode).toBe('EIO');
  });

  it('tolerates a filesystem that does not implement fsync, and says so', () => {
    const runDirectory = freshRun();
    fault.current = { call: 'fsyncSync', code: 'EINVAL' };

    const write = writeRunArtifact({
      runDirectory,
      fileName: 'doctor-report.json',
      contents: 'x\n',
    });

    expect(write.code).toBe('WRITTEN');
    expect(write.synced).toBe(false);
  });

  it('reports a failing close as CLOSE_FAILED', () => {
    const runDirectory = freshRun();
    fault.current = { call: 'closeSync', code: 'EIO' };

    const write = writeRunArtifact({
      runDirectory,
      fileName: 'doctor-report.json',
      contents: 'x\n',
    });

    expect(write.code).toBe('CLOSE_FAILED');
    expect(write.written).toBe(false);
    expect(write.errnoCode).toBe('EIO');
  });

  it('reports a failing marker write and does not complete the run', () => {
    const runDirectory = freshRun();
    writeArtefacts(runDirectory);
    fault.current = { call: 'openSync', code: 'EACCES' };

    const completion = complete(runDirectory);

    expect(completion.code).toBe('MARKER_WRITE_FAILED');
    expect(completion.completed).toBe(false);
    expect(completion.errnoCode).toBe('EACCES');

    fault.current = null;
    expect(existsSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME))).toBe(false);
    expect(inspect(runDirectory).code).toBe('COMPLETION_MARKER_MISSING');
  });

  it('carries an errno identifier and never an exception message', () => {
    const runDirectory = freshRun();
    fault.current = { call: 'writeSync', code: 'ENOSPC' };
    const write = writeRunArtifact({ runDirectory, fileName: 'x.txt', contents: 'y' });

    expect(JSON.stringify(write)).not.toContain('injected');
    expect(write.errnoCode).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
  });
});

describe('the closing checks gate the marker', () => {
  it('refuses to complete a run that is missing an artefact', () => {
    const runDirectory = freshRun();
    writeRunArtifact({ runDirectory, fileName: 'cli-capabilities.txt', contents: 'a\n' });

    const completion = complete(runDirectory);
    expect(completion.code).toBe('ARTEFACTS_MISSING');
    expect(existsSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME))).toBe(false);
  });

  it('refuses to complete a run holding an unexpected file', () => {
    const runDirectory = freshRun();
    writeArtefacts(runDirectory);
    // Exactly what a temporary-file scheme would leave behind.
    writeFileSync(join(runDirectory, '.doctor-report.json.abc.tmp'), 'leftover\n', 'utf8');

    const completion = complete(runDirectory);
    expect(completion.code).toBe('UNEXPECTED_DIRECTORY_CONTENTS');
    expect(existsSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME))).toBe(false);
  });

  it('refuses to complete when an artefact is empty or is a directory', () => {
    const empty = freshRun();
    writeRunArtifact({ runDirectory: empty, fileName: 'cli-capabilities.txt', contents: '' });
    writeRunArtifact({ runDirectory: empty, fileName: 'doctor-report.json', contents: 'x\n' });
    expect(complete(empty).code).toBe('ARTEFACTS_MISSING');

    const shadowed = freshRun();
    writeRunArtifact({ runDirectory: shadowed, fileName: 'cli-capabilities.txt', contents: 'a\n' });
    mkdirSync(join(shadowed, 'doctor-report.json'));
    expect(complete(shadowed).code).toBe('ARTEFACTS_MISSING');
  });

  it('refuses a run whose directory name is not a valid run id', () => {
    const runsRoot = makeRunsRoot();
    mkdirSync(runsRoot, { recursive: true });
    const notARunId = join(runsRoot, 'not-a-run-id');
    mkdirSync(notARunId);
    writeRunArtifact({ runDirectory: notARunId, fileName: 'cli-capabilities.txt', contents: 'a\n' });
    writeRunArtifact({ runDirectory: notARunId, fileName: 'doctor-report.json', contents: 'b\n' });

    expect(complete(notARunId).code).toBe('INVALID_RUN_ID');
    expect(existsSync(join(notARunId, COMPLETION_MARKER_FILE_NAME))).toBe(false);
  });

  it('refuses an unreadable run directory and an unsafe artefact name', () => {
    const runsRoot = makeTempDir();
    expect(
      completeRun({
        runDirectory: join(runsRoot, newRunId()),
        expectedArtefacts: [...ARTEFACTS],
      }).code,
    ).toBe('RUN_DIRECTORY_UNREADABLE');

    expect(
      completeRun({ runDirectory: freshRun(), expectedArtefacts: ['../escape.txt'] }).code,
    ).toBe('INVALID_ARTEFACT_NAME');
  });
});

describe('consumers ignore incomplete runs', () => {
  it('ignores a run with a partial artefact and no marker', () => {
    const runsRoot = makeRunsRoot();
    const partial = freshRun(runsRoot);
    writeRunArtifact({ runDirectory: partial, fileName: 'cli-capabilities.txt', contents: 'a\n' });

    // The missing second artefact is reported before the marker is even
    // looked at — the structure check runs in one pass over everything the
    // run is missing, not just the marker.
    expect(inspect(partial).code).toBe('REQUIRED_ARTIFACT_MISSING');
    expect(inspect(partial).consumable).toBe(false);
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });

  it('ignores a run holding both artefacts but no marker', () => {
    const runsRoot = makeRunsRoot();
    const unmarked = freshRun(runsRoot);
    writeArtefacts(unmarked);

    expect(existsSync(join(unmarked, 'doctor-report.json'))).toBe(true);
    expect(inspect(unmarked).consumable).toBe(false);
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });

  it('ignores a marker carrying a different protocol version', () => {
    const runsRoot = makeRunsRoot();
    const wrong = freshRun(runsRoot);
    writeArtefacts(wrong);
    writeFileSync(
      join(wrong, COMPLETION_MARKER_FILE_NAME),
      'agent-loop-doctor-run/999\n',
      'utf8',
    );

    expect(inspect(wrong).code).toBe('COMPLETION_MARKER_INVALID');
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });

  it.each([
    ['an empty marker', ''],
    ['a marker with extra content', `${RUN_PROTOCOL_VERSION} plus more\n`],
    ['a marker with a prefix', `banner ${RUN_PROTOCOL_VERSION}\n`],
    ['a marker naming another protocol', 'some-other-tool/1\n'],
  ])('rejects %s', (_label, contents) => {
    const runDirectory = freshRun();
    writeArtefacts(runDirectory);
    writeFileSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME), contents, 'utf8');
    expect(inspect(runDirectory).consumable).toBe(false);
  });

  it('rejects a marker that is a directory or is absurdly large', () => {
    const asDirectory = freshRun();
    writeArtefacts(asDirectory);
    mkdirSync(join(asDirectory, COMPLETION_MARKER_FILE_NAME));
    expect(inspect(asDirectory).code).toBe('COMPLETION_MARKER_NOT_REGULAR');

    const huge = freshRun();
    writeFileSync(join(huge, COMPLETION_MARKER_FILE_NAME), 'x'.repeat(4096), 'utf8');
    expect(inspect(huge).consumable).toBe(false);
  });

  it('returns only the completed runs from a mixed runs root', () => {
    const runsRoot = makeRunsRoot();
    const good = freshRun(runsRoot);
    writeArtefacts(good);
    complete(good);

    const bad = freshRun(runsRoot);
    writeArtefacts(bad);

    expect(readdirSync(runsRoot)).toHaveLength(2);
    expect(listCompletedRuns(runsRoot)).toEqual([good.split(/[\\/]/).pop()]);
  });

  it('returns nothing for a runs root that does not exist', () => {
    expect(listCompletedRuns(join(makeTempDir(), 'nope'))).toEqual([]);
  });
});

describe('containment still holds under the new protocol', () => {
  it.each([
    'ohno/../../evil.json',
    '../evil.json',
    '..\\evil.json',
    'sub/dir.json',
    '/etc/passwd',
    'C:\\Windows\\System32\\evil.json',
    '..',
    '',
  ])('refuses the artefact name %j', (fileName) => {
    const runDirectory = freshRun();
    const write = writeRunArtifact({ runDirectory, fileName, contents: 'x' });

    expect(write.code).toBe('PATH_ESCAPES_RUN_DIRECTORY');
    expect(write.written).toBe(false);
    expect(entries(runDirectory)).toEqual([]);
  });

  it('refuses a run directory reached through a symlink or Windows junction', () => {
    const base = makeTempDir();
    const real = join(base, 'real-run');
    const link = join(base, 'link-run');
    mkdirSync(real, { recursive: true });

    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // Link creation not permitted here; nothing to assert.
    }

    const write = writeRunArtifact({
      runDirectory: link,
      fileName: 'doctor-report.json',
      contents: 'x',
    });
    expect(['PATH_CONTAINS_LINK', 'RUN_DIRECTORY_UNUSABLE']).toContain(write.code);
    expect(write.written).toBe(false);
    expect(existsSync(join(real, 'doctor-report.json'))).toBe(false);

    // And no marker can be planted through the link either.
    expect(completeRun({ runDirectory: link, expectedArtefacts: [...ARTEFACTS] }).completed).toBe(
      false,
    );
    expect(existsSync(join(real, COMPLETION_MARKER_FILE_NAME))).toBe(false);
  });

  it('refuses a runs root reached through a link', () => {
    const base = makeTempDir();
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real, { recursive: true });

    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const result = createRunDirectory({ runsRoot: join(link, 'runs'), runId: newRunId() });
    expect(result.code).toBe('PATH_CONTAINS_LINK');
    expect(existsSync(join(real, 'runs'))).toBe(false);
  });
});

/**
 * A source-level audit. The finalisation primitives are not merely unused —
 * they must not be reachable from the persistence path at all, so a later edit
 * cannot quietly reintroduce the race.
 */
describe('the removed primitives are gone from the product code', () => {
  const PERSISTENCE_SOURCES = [
    join('src', 'doctor', 'safe-write.ts'),
    join('src', 'doctor', 'run-directory.ts'),
    join('src', 'doctor', 'run-completion.ts'),
    join('src', 'doctor', 'run-doctor.ts'),
    join('src', 'doctor', 'write-access.ts'),
    join('src', 'config', 'paths.ts'),
  ];

  function sourceOf(relative: string): string {
    return readFileSync(join(PACKAGE_ROOT, relative), 'utf8');
  }

  /** Comments explaining what was removed are fine; calls are not. */
  function code(relative: string): string {
    return sourceOf(relative)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
  }

  it.each(PERSISTENCE_SOURCES)('calls no link or rename primitive in %s', (relative) => {
    const text = code(relative);
    for (const forbidden of ['linkSync', 'renameSync', 'link(', 'rename(', 'unlinkSync']) {
      expect(text).not.toContain(forbidden);
    }
  });

  // `write-access.ts` is a deliberately separate mechanism: a reversible
  // write-access probe that creates one uniquely named `.tmp` file and
  // deletes it immediately (see that module's own header). It was never part
  // of the temp-file-then-link/rename finalisation race this audit targets,
  // so it is excluded here and only here.
  const RUN_ARTIFACT_FINALISATION_SOURCES = PERSISTENCE_SOURCES.filter(
    (relative) => relative !== join('src', 'doctor', 'write-access.ts'),
  );

  it.each(RUN_ARTIFACT_FINALISATION_SOURCES)(
    'uses no temp-file finalisation naming in %s',
    (relative) => {
      const text = code(relative);
      expect(text).not.toMatch(/\.tmp/);
      expect(text).not.toMatch(/\btemporary\b/i);
    },
  );

  it('imports no link, rename or unlink function from node:fs anywhere in src', () => {
    const text = code(join('src', 'doctor', 'safe-write.ts'));
    const importBlock = /import\s*\{([^}]*)\}\s*from\s*'node:fs'/.exec(text)?.[1] ?? '';
    expect(importBlock).not.toMatch(/link|rename|rm|unlink/);
    // What it does import: exclusive open, write, sync, close and lstat.
    for (const expected of ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'lstatSync']) {
      expect(importBlock).toContain(expected);
    }
  });

  it('opens artefacts exclusively, with no prior existence check', () => {
    const text = code(join('src', 'doctor', 'safe-write.ts'));
    expect(text).toContain(`openSync(target, 'wx'`);
    expect(text).not.toContain('targetExists');
  });

  it('names no worktrees-root environment variable in the product code', () => {
    // Comments are allowed to name the removed variable — several of these
    // modules' headers explain why it was removed — but no code line may.
    for (const relative of PERSISTENCE_SOURCES) {
      expect(code(relative)).not.toContain('AGENT_LOOP_WORKTREES_ROOT');
      expect(code(relative)).not.toContain('worktreesRoot');
    }
  });

  it('uses no content marker as proof of ownership', () => {
    const text = code(join('src', 'doctor', 'safe-write.ts'));
    expect(text).not.toContain('reportKind');
    expect(text).not.toContain('readFileSync');
  });
});

/**
 * AO-007-R2-RR2-REVIEW-01: producer and consumer must apply the exact same
 * run-id schema, the exact same link/containment checks, and the exact same
 * three-entry structure rule — a run directory that only *looks* complete
 * because it holds the right file names must never be treated as one.
 */
describe('exact three-entry structure (AO-007-R2-RR2-REVIEW-01)', () => {
  it('rejects a run holding only the COMPLETED marker', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeFileSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');

    expect(inspect(runDirectory).consumable).toBe(false);
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });

  it('rejects a run holding the marker and only one artefact', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeFileSync(join(runDirectory, ARTEFACTS[0]), 'a\n', 'utf8');
    writeFileSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');

    expect(inspect(runDirectory).consumable).toBe(false);
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });

  it('rejects an otherwise-valid run carrying a fourth, unexpected entry', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeArtefacts(runDirectory);
    writeFileSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');
    writeFileSync(join(runDirectory, 'extra.txt'), 'x\n', 'utf8');

    const inspection = inspect(runDirectory);
    expect(inspection.code).toBe('RUN_STRUCTURE_INVALID');
    expect(inspection.consumable).toBe(false);
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });

  it('rejects a run where an artefact is a symlink to an external file', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    const target = join(makeTempDir(), 'external-artefact.txt');
    writeFileSync(target, 'external\n', 'utf8');
    writeFileSync(join(runDirectory, ARTEFACTS[0]), 'a\n', 'utf8');

    try {
      symlinkSync(target, join(runDirectory, ARTEFACTS[1]), 'file');
    } catch {
      return; // Symlink creation not permitted here; nothing to assert.
    }
    writeFileSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');

    const inspection = inspect(runDirectory);
    expect(inspection.code).toBe('REQUIRED_ARTIFACT_IS_LINK');
    expect(inspection.consumable).toBe(false);
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });

  it('rejects a run where COMPLETED itself is a symlink to a byte-exact marker', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    const target = join(makeTempDir(), 'external-marker');
    writeFileSync(target, COMPLETION_MARKER_CONTENTS, 'utf8');
    writeArtefacts(runDirectory);

    try {
      symlinkSync(target, join(runDirectory, COMPLETION_MARKER_FILE_NAME), 'file');
    } catch {
      return;
    }

    const inspection = inspect(runDirectory);
    expect(inspection.code).toBe('COMPLETION_MARKER_IS_LINK');
    expect(inspection.consumable).toBe(false);
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });

  it('never lists an invalidly named directory entry under runsRoot', () => {
    const runsRoot = makeRunsRoot();
    mkdirSync(runsRoot, { recursive: true });
    mkdirSync(join(runsRoot, 'not-a-run-id'));

    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });
});

describe('completeRun refuses a link wherever one appears (AO-007-R2-RR2-REVIEW-01)', () => {
  it('never creates a marker when an artefact is a symlink', () => {
    const runDirectory = freshRun();
    const target = join(makeTempDir(), 'external-artefact.txt');
    writeFileSync(target, 'external\n', 'utf8');
    writeFileSync(join(runDirectory, ARTEFACTS[0]), 'a\n', 'utf8');

    try {
      symlinkSync(target, join(runDirectory, ARTEFACTS[1]), 'file');
    } catch {
      return; // Symlink creation not permitted here; nothing to assert.
    }

    const completion = complete(runDirectory);
    expect(completion.completed).toBe(false);
    expect(completion.code).toBe('ARTEFACT_IS_LINK');
    expect(existsSync(join(runDirectory, COMPLETION_MARKER_FILE_NAME))).toBe(false);
  });

  it('never creates a marker when the run directory itself is a junction', () => {
    const base = makeTempDir();
    const runsRoot = join(base, 'runs');
    mkdirSync(runsRoot, { recursive: true });
    const external = join(base, 'external-run');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, ARTEFACTS[0]), 'a\n', 'utf8');
    writeFileSync(join(external, ARTEFACTS[1]), 'b\n', 'utf8');

    const runId = newRunId();
    const junctionPath = join(runsRoot, runId);
    symlinkSync(external, junctionPath, 'junction');

    const completion = completeRun({ runDirectory: junctionPath, expectedArtefacts: [...ARTEFACTS] });
    expect(completion.completed).toBe(false);
    expect(existsSync(join(external, COMPLETION_MARKER_FILE_NAME))).toBe(false);
  });
});

/**
 * The exact regression this finding closes: a validly *named* junction under
 * `runsRoot`, pointing at an external directory that holds nothing but a
 * planted, byte-exact `COMPLETED` marker, must never read as a completed run
 * — at `inspectRun`, and therefore never at `listCompletedRuns` either. This
 * must run for real on Windows, not be skipped: junction creation needs no
 * elevated privilege here, unlike a plain symbolic link.
 */
describe('the Windows junction reproduction (AO-007-R2-RR2-REVIEW-01)', () => {
  it('never treats a validly named junction to an external marker-only directory as a completed run', () => {
    const runsRoot = makeRunsRoot();
    mkdirSync(runsRoot, { recursive: true });

    // 1. An external directory, entirely outside runsRoot.
    const external = join(makeTempDir(), 'external-run-target');
    mkdirSync(external, { recursive: true });

    // 2. Only a valid COMPLETED marker inside it — nothing else.
    writeFileSync(join(external, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');

    // 3. A validly named junction under runsRoot pointing at that external directory.
    const runId = newRunId();
    const junctionPath = join(runsRoot, runId);
    symlinkSync(external, junctionPath, 'junction');

    // 4. The rejection must hold at every layer.
    const inspection = inspectRun(runsRoot, runId);
    expect(inspection.code).not.toBe('COMPLETE');
    expect(inspection.consumable).toBe(false);
    expect(listCompletedRuns(runsRoot)).toEqual([]);
  });
});

describe('listCompletedRuns across a heavily mixed runs root', () => {
  it('lists only the one genuinely valid, completed run', () => {
    const runsRoot = makeRunsRoot();
    mkdirSync(runsRoot, { recursive: true });

    const good = freshRun(runsRoot);
    writeArtefacts(good);
    expect(complete(good).completed).toBe(true);
    const goodRunId = basename(good);

    // A run holding only the marker.
    const markerOnly = freshRun(runsRoot);
    writeFileSync(join(markerOnly, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');

    // An invalidly named directory entry.
    mkdirSync(join(runsRoot, 'not-a-run-id'));

    // A validly named junction to an external directory holding only a marker.
    const external = join(makeTempDir(), 'external-mixed');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');
    symlinkSync(external, join(runsRoot, newRunId()), 'junction');

    // A run with an extra, unexpected file alongside an otherwise valid structure.
    const extra = freshRun(runsRoot);
    writeArtefacts(extra);
    writeFileSync(join(extra, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');
    writeFileSync(join(extra, 'extra.txt'), 'x\n', 'utf8');

    // A run with a byte-wrong marker.
    const wrongMarker = freshRun(runsRoot);
    writeArtefacts(wrongMarker);
    writeFileSync(join(wrongMarker, COMPLETION_MARKER_FILE_NAME), 'not-the-marker\n', 'utf8');

    expect(listCompletedRuns(runsRoot)).toEqual([goodRunId]);
  });
});
