/**
 * The one-syscall window between reading a lease and identifying its object.
 *
 * ── Why this file exists, and what it corrects ─────────────────────────────
 *
 * `inspectRepositoryExecutionLease` reads the lease bytes and then stats the
 * same name to learn which filesystem object they came from. A lease deleted
 * between those two calls used to be reported as "this platform cannot identify
 * the object" — the meaning `Object: none` carries everywhere else — because the
 * identity read swallowed every `stat` failure into one `null`. The fourth
 * review measured the consequence: 551 byte reads under churn produced
 * `ino === 0n` **zero** times and `ENOENT` 181 times, and 18 of 36
 * barrier-released break attempts answered `OBJECT_IDENTITY_UNVERIFIABLE` with
 * the lease name already empty, at exit 4, under a sentence that began "The
 * lease is there".
 *
 * The fix distinguishes the two and reports a vanished lease as `FREE`. I then
 * wrote, in the commit that shipped it, that no deterministic instrument for
 * that window existed in process and that any test would be "a race with a
 * timeout". **That was false, and three independent lenses said so in the same
 * round** — this repository already ships the instrument, in
 * `tests/run-persistence.test.ts`: a `vi.mock('node:fs')` factory whose wrapper
 * runs a hook *after* a real syscall and before the next one. There is no sleep
 * here, no timeout, no barrier, no child process and no injected errno: the
 * filesystem produces the `ENOENT` itself, because the file really is gone.
 *
 * Its own file because the mock intercepts every `node:fs` import in the module
 * graph of the file it appears in, which is not something to impose on a suite
 * that writes real fixtures for other reasons.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Fires after a real `readFileSync` returns, before the caller's next syscall.
 *
 * Hoisted so the `vi.mock` factory — which is lifted above the imports — can see
 * it. A test installs a function here; the wrapper clears it after one shot, so
 * the window opens exactly once and the rest of the suite reads normally.
 */
const window = vi.hoisted(() => ({ afterRead: null as null | ((path: string) => void) }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>): unknown => {
      const result = actual.readFileSync(...args);
      const hook = window.afterRead;
      if (hook !== null) {
        window.afterRead = null;
        hook(String(args[0]));
      }
      return result;
    },
  };
});

const { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } = await import(
  'node:fs'
);
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { inspectRepositoryExecutionLease, leaseObjectIdentity } = await import(
  '../src/lease/execution-lease.js'
);

const created: string[] = [];

afterEach(() => {
  window.afterRead = null;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A directory shaped like a repository, only as far as the lease needs.
 *
 * Not `createRepoFixture`: this file mocks `node:fs` for its whole module graph,
 * and a fixture that shells out to Git would be measuring something else. The
 * lease only requires a `.git` directory that is the work tree's common dir,
 * which `repositoryRecordIsCoherent` is not consulted for on the read path.
 */
function leasableDirectory(): { readonly repository: { gitCommonDir: string; root: string; id: string }; readonly leasePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'ao-enoent-window-'));
  created.push(root);
  const gitCommonDir = join(root, '.git');
  mkdirSync(gitCommonDir, { recursive: true });
  return {
    repository: { gitCommonDir, root, id: 'enoent-window' },
    leasePath: join(gitCommonDir, 'agent-orchestrator-execution-lease.json'),
  };
}

function writeLease(leasePath: string, gitCommonDir: string, root: string): void {
  writeFileSync(
    leasePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        leaseKey: gitCommonDir,
        repositoryRoot: root,
        repositoryId: 'enoent-window',
        ownerPid: process.pid,
        ownerNonce: 'c'.repeat(64),
        acquiredAt: '2026-08-14T09:00:00.000Z',
        runId: 'run-window',
        blockId: null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

describe('a lease that vanishes between the read and the stat', () => {
  it('is reported as gone, not as an object this platform cannot identify', () => {
    const fixture = leasableDirectory();
    writeLease(fixture.leasePath, fixture.repository.gitCommonDir, fixture.repository.root);

    // The window, opened exactly where it opens in production: the bytes have
    // been read, and the name is gone before the identity read reaches it.
    window.afterRead = (path) => {
      if (path === fixture.leasePath) unlinkSync(fixture.leasePath);
    };

    const inspection = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    expect(window.afterRead).toBeNull();
    expect(existsSync(fixture.leasePath)).toBe(false);
    // FREE, because that is what it is. Reverting the discrimination reports
    // HELD with `objectId: null`, which is the platform's answer for a
    // filesystem with no inode concept — a statement about the platform, made
    // about a race.
    expect(inspection.state).toBe('FREE');
    expect(inspection.objectId).toBeNull();
    expect(inspection.revision).toBeNull();
  });

  it('still identifies an object that is there, so the refusal is not universal', () => {
    // The control. A discrimination that answered "gone" for everything would
    // satisfy the test above and report every held lease as free.
    const fixture = leasableDirectory();
    writeLease(fixture.leasePath, fixture.repository.gitCommonDir, fixture.repository.root);

    const inspection = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    expect(inspection.state).toBe('HELD');
    expect(inspection.objectId).not.toBeNull();
    expect(inspection.objectId).toBe(leaseObjectIdentity(fixture.leasePath));
  });

  it('answers nothing for a path that never existed', () => {
    const fixture = leasableDirectory();

    expect(leaseObjectIdentity(fixture.leasePath)).toBeNull();
    expect(inspectRepositoryExecutionLease(fixture.repository).state).toBe('FREE');
  });
});
