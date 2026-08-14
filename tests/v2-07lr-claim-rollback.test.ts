/**
 * The rollback that gives back a claim whose record could not be written.
 *
 * ── The defect this pins ───────────────────────────────────────────────────
 *
 * `claimViaExclusiveCreate` takes the lease name with `openSync(path,'wx')` and
 * writes the record through that handle afterwards. When the write fails it must
 * give the claim back, and the predicate it used to hand `removeVerifiedLease`
 * was:
 *
 *     (present) => { const nonce = nonceOfBytes(present);
 *                    return nonce === null || nonce === ourNonce; }
 *
 * `nonceOfBytes` answers `null` for anything it cannot parse — including an
 * **empty** file, because `JSON.parse('')` throws. The empty file at that name is
 * not necessarily ours: it is exactly what a *competing* acquirer leaves while it
 * sits between its own exclusive create and its own record write, which is the
 * state this very function passes through. So the rollback deleted a legitimate
 * acquirer's file.
 *
 * A sixth review reproduced it with **measurably different inodes** — no identity
 * collision, no reuse, nothing about the filesystem assumed. The victim kept its
 * descriptor, still believed it held the claim, and the lease name was left free
 * for a third writer. The `null` arm is gone: `nonceOfBytes` answering `null` is
 * the *absence* of an ownership fact, never an ownership fact of its own.
 *
 * ── What is injected, and what the operating system produces ───────────────
 *
 * INJECTED, through the module's own seam:
 *   - the `link` failure, via `ExecutionLeaseDependencies.link`. That is what
 *     selects `claimViaExclusiveCreate`, and no production caller overrides it,
 *     so it stands in for the filesystem the fallback exists for.
 *
 * INJECTED, ordering only:
 *   - a `vi.mock('node:fs')` wrapper that runs a hook before the second
 *     `writeSync`. The hook performs REAL syscalls to reach the state under test.
 *     It chooses no outcome, touches no predicate and fabricates no errno.
 *
 * PRODUCED BY THE OS:
 *   - the write failure. The hook hands back a real file opened read-only and the
 *     wrapper calls the REAL `writeSync` on it, so the kernel raises the error;
 *   - both object identities, the rename, the read-back, the nonce parse, the
 *     predicate's evaluation, and every removal or restoration.
 *
 * Its own file because the mock intercepts `node:fs` for its whole module graph.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => ({
  writeCalls: 0,
  beforeSecondWrite: null as null | ((fd: number) => number),
  failNextFsync: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    writeSync: (...args: unknown[]): unknown => {
      order.writeCalls += 1;
      const hook = order.beforeSecondWrite;
      if (hook !== null && order.writeCalls === 2) {
        order.beforeSecondWrite = null;
        // Substitutes a genuinely unwritable descriptor. The real `writeSync`
        // below is what fails, so the errno is the OS's and not this file's.
        const substitute = hook(args[0] as number);
        return (actual.writeSync as (...a: unknown[]) => unknown)(substitute, ...args.slice(1));
      }
      return (actual.writeSync as (...a: unknown[]) => unknown)(...args);
    },
    fsyncSync: (...args: unknown[]): unknown => {
      if (order.failNextFsync) {
        order.failNextFsync = false;
        // The one failure mode that leaves this call's OWN record complete and
        // legible at the lease name: the bytes are all written, the flush is
        // what fails. This is the state the removal arm exists for.
        const error = new Error('input/output error') as Error & { code: string };
        error.code = 'EIO';
        throw error;
      }
      return (actual.fsyncSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { acquireRepositoryExecutionLease } = await import('../src/lease/execution-lease.js');

const created: string[] = [];

afterEach(() => {
  order.writeCalls = 0;
  order.beforeSecondWrite = null;
  order.failNextFsync = false;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LEASE_FILE = 'agent-orchestrator-execution-lease.json';

/** A `.git` directory with no `commondir`, which makes it its own common dir. */
function leasableRepository(): {
  readonly repository: { gitCommonDir: string; root: string; id: string };
  readonly leasePath: string;
  readonly gitCommonDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'ao-claim-rollback-'));
  created.push(root);
  const gitCommonDir = join(root, '.git');
  mkdirSync(gitCommonDir, { recursive: true });
  return {
    repository: { gitCommonDir, root, id: 'claim-rollback' },
    leasePath: join(gitCommonDir, LEASE_FILE),
    gitCommonDir,
  };
}

/** What a filesystem without hard links answers. Not `EEXIST`, so the fallback runs. */
const REFUSING_LINK = (): never => {
  const error = new Error('operation not permitted') as Error & { code: string };
  error.code = 'EPERM';
  throw error;
};

function foreignRecord(gitCommonDir: string, root: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      leaseKey: gitCommonDir,
      repositoryRoot: root,
      repositoryId: 'claim-rollback',
      ownerPid: process.pid,
      ownerNonce: 'd'.repeat(64),
      acquiredAt: '2026-08-14T09:00:00.000Z',
      runId: 'p2',
      blockId: null,
    },
    null,
    2,
  )}\n`;
}

interface RollbackOutcome {
  readonly acquire: string;
  readonly p1ObjectId: string;
  readonly p2ObjectId: string;
  readonly identitiesEqual: boolean;
  readonly p2FileSurvived: boolean;
  readonly p2StillHoldsDescriptor: boolean;
  readonly bytesAtName: string | null;
}

/**
 * P1 claims through the fallback, its record write fails, and the name has
 * changed hands to P2 in between.
 *
 * `p2Writes` is what P2's file holds at the instant P1's rollback runs. `null` is
 * the empty window every fallback acquirer passes through — the reproduction.
 */
function rollbackAgainstSecondAcquirer(p2Writes: string | null): RollbackOutcome {
  const fixture = leasableRepository();
  let p1ObjectId = '';
  let p2ObjectId = '';
  let p2Fd = -1;
  let readOnlyFd = -1;

  order.beforeSecondWrite = () => {
    // P1 holds the name with a zero-byte file, exactly as its `openSync` left it.
    const p1 = statSync(fixture.leasePath, { bigint: true });
    p1ObjectId = `${String(p1.dev)}:${String(p1.ino)}`;

    // The name changes hands: P1's file goes, and P2 takes the name through its
    // own exclusive create, sitting in its own empty window.
    unlinkSync(fixture.leasePath);
    p2Fd = openSync(fixture.leasePath, 'wx', 0o600);
    if (p2Writes !== null) writeFileSync(fixture.leasePath, p2Writes, 'utf8');
    const p2 = statSync(fixture.leasePath, { bigint: true });
    p2ObjectId = `${String(p2.dev)}:${String(p2.ino)}`;

    const scratch = join(fixture.gitCommonDir, 'unwritable');
    writeFileSync(scratch, 'x');
    readOnlyFd = openSync(scratch, 'r');
    return readOnlyFd;
  };

  const acquired = acquireRepositoryExecutionLease(
    fixture.repository,
    { runId: 'p1', blockId: null },
    { now: () => new Date().toISOString(), link: REFUSING_LINK },
  );

  const p2FileSurvived = existsSync(fixture.leasePath);
  const bytesAtName = p2FileSurvived ? readFileSync(fixture.leasePath).toString('utf8') : null;

  let p2StillHoldsDescriptor = false;
  try {
    fstatSync(p2Fd);
    p2StillHoldsDescriptor = true;
  } catch {
    p2StillHoldsDescriptor = false;
  }
  for (const fd of [p2Fd, readOnlyFd]) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }

  return {
    acquire: acquired.ok ? 'ACQUIRED' : acquired.code,
    p1ObjectId,
    p2ObjectId,
    identitiesEqual: p1ObjectId === p2ObjectId,
    p2FileSurvived,
    p2StillHoldsDescriptor,
    bytesAtName,
  };
}

describe('a claim rollback may not remove a record it cannot prove is its own', () => {
  it('leaves a competing acquirer\'s empty window file exactly where it is', () => {
    const result = rollbackAgainstSecondAcquirer(null);

    // The premise of the whole test: two different files. Nothing here depends
    // on inode reuse, so no filesystem assumption is doing any work.
    expect(result.identitiesEqual).toBe(false);
    // P1's claim fails, as it must — its record could not be written.
    expect(result.acquire).toBe('LEASE_WRITE_FAILED');

    // The defect, inverted. Before the fix this was `false`: P1's rollback read
    // P2's empty file, `nonceOfBytes` answered `null`, the `null` arm accepted
    // it, and a legitimate acquirer was dispossessed.
    expect(result.p2FileSurvived).toBe(true);
    // Restored to the name rather than merely left in quarantine.
    expect(result.bytesAtName).toBe('');
    // And the victim's own handle is still the handle it thinks it holds.
    expect(result.p2StillHoldsDescriptor).toBe(true);
  });

  it('leaves a legible record belonging to another owner alone', () => {
    // The pre-existing half of the predicate, kept honest: a record it CAN read
    // and whose nonce is not ours was already refused. If this ever fails, the
    // fix above has been over-applied rather than applied.
    const result = rollbackAgainstSecondAcquirer(
      foreignRecord(join(tmpdir(), 'ao-ctl', '.git'), join(tmpdir(), 'ao-ctl')),
    );

    expect(result.identitiesEqual).toBe(false);
    expect(result.acquire).toBe('LEASE_WRITE_FAILED');
    expect(result.p2FileSurvived).toBe(true);
    expect(result.bytesAtName).toContain('"ownerNonce"');
  });

  it('still removes this claim\'s own complete record when the flush fails', () => {
    // The CONTROL, and the reason this is a fix rather than a deletion of the
    // feature. `writeInto` writes every byte and only then flushes, so a failing
    // `fsync` is the one rollback whose record is this call's own AND legible.
    // If the removal arm no longer fires here, the rollback has been disabled,
    // not corrected — and a failed acquire would leave its own lease standing.
    const fixture = leasableRepository();
    order.failNextFsync = true;

    const acquired = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'p1', blockId: null },
      { now: () => new Date().toISOString(), link: REFUSING_LINK },
    );

    expect(acquired.ok).toBe(false);
    expect(acquired.ok ? '' : acquired.code).toBe('LEASE_WRITE_FAILED');
    // Its own record, removed. The repository is free rather than locked by a
    // lease whose owner never got evidence for it.
    expect(existsSync(fixture.leasePath)).toBe(false);
  });

  it('does not leave the name free for a third writer after refusing', () => {
    // The consequence that makes the reproduction a safety defect rather than an
    // untidy one: if P2's file had been deleted, the name would be free and a
    // third process could acquire over a live claimant.
    const fixture = leasableRepository();
    let p2Fd = -1;
    let readOnlyFd = -1;

    order.beforeSecondWrite = () => {
      unlinkSync(fixture.leasePath);
      p2Fd = openSync(fixture.leasePath, 'wx', 0o600);
      const scratch = join(fixture.gitCommonDir, 'unwritable');
      writeFileSync(scratch, 'x');
      readOnlyFd = openSync(scratch, 'r');
      return readOnlyFd;
    };

    acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'p1', blockId: null },
      { now: () => new Date().toISOString(), link: REFUSING_LINK },
    );

    // A third acquirer, with no seam at all — the real `link` against the name
    // P2 still holds.
    const third = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'p3', blockId: null },
      { now: () => new Date().toISOString() },
    );

    for (const fd of [p2Fd, readOnlyFd]) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }

    expect(third.ok).toBe(false);
  });
});
