/**
 * AO-007: persistent diagnostics must land in the trusted global application
 * data root, contained, link-free, atomically, and without clobbering foreign
 * files or leaving temporary files behind.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { diagnosticsRoot, doctorDiagnosticsDir, orchestratorHome } from '../src/config/paths.js';
import {
  isContained,
  pathChain,
  pathContainsLink,
  writeDiagnosticFile,
} from '../src/doctor/safe-write.js';

const MARKER = 'agent-loop-doctor-report';
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

/** Files a directory holds, including our dot-prefixed temporaries. */
function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('diagnostics location', () => {
  it('is derived from the per-user home, never from the working directory', () => {
    const env = { AGENT_LOOP_HOME: 'C:\\somewhere\\.agent-orchestrator' };
    const dir = doctorDiagnosticsDir(env);
    expect(dir).toBe(join(resolve(env.AGENT_LOOP_HOME), 'diagnostics', 'doctor'));
    expect(dir).not.toContain(process.cwd());
  });

  it('defaults to the user profile, not the repository', () => {
    const dir = doctorDiagnosticsDir({});
    expect(dir).toBe(join(homedir(), '.agent-orchestrator', 'diagnostics', 'doctor'));
    expect(isContained(orchestratorHome({}), dir)).toBe(true);
    expect(isContained(diagnosticsRoot({}), dir)).toBe(true);
  });

  it('never resolves under the current working directory by default', () => {
    expect(isContained(process.cwd(), doctorDiagnosticsDir({}))).toBe(false);
  });
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

describe('writeDiagnosticFile — the normal, safe path', () => {
  it('writes the file and leaves no temporary behind', () => {
    const root = join(makeTempDir(), 'diagnostics', 'doctor');
    const write = writeDiagnosticFile({
      root,
      fileName: 'doctor-report.json',
      contents: `{"reportKind":"${MARKER}"}\n`,
      ownershipMarker: MARKER,
    });

    expect(write.code).toBe('WRITTEN');
    expect(write.written).toBe(true);
    expect(write.temporaryFileRemoved).toBe(true);
    expect(readFileSync(write.path, 'utf8')).toContain(MARKER);
    expect(entries(root)).toEqual(['doctor-report.json']);
  });

  it('creates the containment root if it does not exist yet', () => {
    const root = join(makeTempDir(), 'deep', 'diagnostics', 'doctor');
    expect(existsSync(root)).toBe(false);
    expect(
      writeDiagnosticFile({
        root,
        fileName: 'cli-capabilities.txt',
        contents: `${MARKER}\n`,
        ownershipMarker: MARKER,
      }).code,
    ).toBe('WRITTEN');
    expect(existsSync(root)).toBe(true);
  });

  it('replaces its own previous report atomically', () => {
    const root = makeTempDir();
    const request = { root, fileName: 'doctor-report.json', ownershipMarker: MARKER };

    writeDiagnosticFile({ ...request, contents: `{"reportKind":"${MARKER}","run":1}\n` });
    const second = writeDiagnosticFile({
      ...request,
      contents: `{"reportKind":"${MARKER}","run":2}\n`,
    });

    expect(second.code).toBe('WRITTEN');
    expect(readFileSync(second.path, 'utf8')).toContain('"run":2');
    expect(entries(root)).toEqual(['doctor-report.json']);
  });

  it('leaves no temporary file after many consecutive writes', () => {
    const root = makeTempDir();
    for (let i = 0; i < 5; i += 1) {
      writeDiagnosticFile({
        root,
        fileName: 'doctor-report.json',
        contents: `{"reportKind":"${MARKER}","run":${i}}\n`,
        ownershipMarker: MARKER,
      });
    }
    expect(entries(root)).toEqual(['doctor-report.json']);
    expect(entries(root).some((n) => n.endsWith('.tmp'))).toBe(false);
  });
});

describe('writeDiagnosticFile — path traversal', () => {
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
    const root = makeTempDir();
    const write = writeDiagnosticFile({
      root,
      fileName,
      contents: 'x',
      ownershipMarker: MARKER,
    });
    expect(write.code).toBe('PATH_ESCAPES_ROOT');
    expect(write.written).toBe(false);
    expect(entries(root)).toEqual([]);
  });

  it('writes nothing outside the root even when the name looks harmless', () => {
    const base = makeTempDir();
    const root = join(base, 'doctor');
    const outside = join(base, 'evil.json');
    writeDiagnosticFile({
      root,
      fileName: 'report.json',
      contents: 'x',
      ownershipMarker: MARKER,
    });
    expect(existsSync(outside)).toBe(false);
  });
});

describe('writeDiagnosticFile — links in the path', () => {
  /** Junctions/symlinks to directories need no elevation for junctions. */
  function tryMakeDirLink(target: string, linkPath: string): boolean {
    try {
      symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    }
  }

  it('refuses a root that is reached through a directory link', () => {
    const base = makeTempDir();
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real, { recursive: true });

    if (!tryMakeDirLink(real, link)) {
      // Creating links is not permitted here; nothing to assert.
      return;
    }
    expect(pathContainsLink(join(link, 'doctor'))).toBe(true);

    const write = writeDiagnosticFile({
      root: join(link, 'doctor'),
      fileName: 'doctor-report.json',
      contents: 'x',
      ownershipMarker: MARKER,
    });
    expect(write.code).toBe('PATH_CONTAINS_LINK');
    expect(write.written).toBe(false);
    expect(existsSync(join(real, 'doctor', 'doctor-report.json'))).toBe(false);
  });

  it('refuses a target that is itself a link', () => {
    const root = makeTempDir();
    const decoy = join(root, 'decoy.json');
    writeFileSync(decoy, 'decoy\n', 'utf8');

    let linked = true;
    try {
      symlinkSync(decoy, join(root, 'doctor-report.json'), 'file');
    } catch {
      linked = false;
    }
    if (!linked) return; // Unprivileged Windows without developer mode.

    const write = writeDiagnosticFile({
      root,
      fileName: 'doctor-report.json',
      contents: 'x',
      ownershipMarker: MARKER,
    });
    expect(write.code).toBe('TARGET_NOT_REGULAR_FILE');
    expect(readFileSync(decoy, 'utf8')).toBe('decoy\n');
  });

  it('accepts a plain path with no links at all', () => {
    const root = makeTempDir();
    expect(pathContainsLink(root)).toBe(false);
  });
});

describe('writeDiagnosticFile — non-regular and foreign targets', () => {
  it('refuses when the target is a directory', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'doctor-report.json'));
    const write = writeDiagnosticFile({
      root,
      fileName: 'doctor-report.json',
      contents: 'x',
      ownershipMarker: MARKER,
    });
    expect(write.code).toBe('TARGET_NOT_REGULAR_FILE');
    expect(write.written).toBe(false);
  });

  it('refuses to overwrite a foreign file that happens to share the name', () => {
    const root = makeTempDir();
    const target = join(root, 'doctor-report.json');
    writeFileSync(target, '{"someone":"else"}\n', 'utf8');

    const write = writeDiagnosticFile({
      root,
      fileName: 'doctor-report.json',
      contents: `{"reportKind":"${MARKER}"}\n`,
      ownershipMarker: MARKER,
    });
    expect(write.code).toBe('TARGET_FOREIGN_FILE');
    expect(write.written).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{"someone":"else"}\n');
    expect(entries(root)).toEqual(['doctor-report.json']);
  });
});

describe('writeDiagnosticFile — failure paths clean up', () => {
  it('reports a fixed code and no exception text when the root cannot be created', () => {
    const base = makeTempDir();
    const blocker = join(base, 'blocker');
    // A *file* where a directory must go: mkdir fails deterministically.
    writeFileSync(blocker, 'not a directory\n', 'utf8');

    const write = writeDiagnosticFile({
      root: join(blocker, 'doctor'),
      fileName: 'doctor-report.json',
      contents: 'x',
      ownershipMarker: MARKER,
    });
    expect(write.written).toBe(false);
    expect(['ROOT_CREATE_FAILED', 'PATH_CONTAINS_LINK']).toContain(write.code);
    expect(JSON.stringify(write)).not.toMatch(/ENOTDIR:.+/);
  });

  it.runIf(process.platform !== 'win32')(
    'cleans up and reports when the directory is not writable',
    () => {
      const root = makeTempDir();
      chmodSync(root, 0o500);
      try {
        const write = writeDiagnosticFile({
          root,
          fileName: 'doctor-report.json',
          contents: 'x',
          ownershipMarker: MARKER,
        });
        expect(write.code).toBe('WRITE_FAILED');
        expect(write.temporaryFileRemoved).toBe(true);
        expect(write.errnoCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
      } finally {
        chmodSync(root, 0o700);
      }
    },
  );

  it('carries only an allow-listed errno code, never a message', () => {
    const base = makeTempDir();
    writeFileSync(join(base, 'blocker'), 'x', 'utf8');
    const write = writeDiagnosticFile({
      root: join(base, 'blocker', 'doctor'),
      fileName: 'doctor-report.json',
      contents: 'x',
      ownershipMarker: MARKER,
    });
    if (write.errnoCode !== null) {
      expect(write.errnoCode).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    }
  });

  it('never leaves a .tmp file behind on any path', () => {
    const root = makeTempDir();
    // A foreign file blocks the write after the temporary would be created.
    writeFileSync(join(root, 'doctor-report.json'), 'foreign\n', 'utf8');
    writeDiagnosticFile({
      root,
      fileName: 'doctor-report.json',
      contents: 'x',
      ownershipMarker: MARKER,
    });
    expect(entries(root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
