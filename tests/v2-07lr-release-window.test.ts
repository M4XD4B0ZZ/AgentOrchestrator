/**
 * V2-07LR — every answer a release can give, reached and pinned by value.
 *
 * ── Why these cases need their own file ────────────────────────────────────
 *
 * `releaseRepositoryExecutionLease` maps nine `VerifiedRemoval` states onto six
 * codes and five `detail` tokens. Four of those states are only reachable in
 * the window **between the read that proves the lease and the syscall that
 * removes it**, and two more only when a filesystem call fails in a specific
 * way. Before this file, the whole failure half of that map was pinned by
 * nothing: exchanging any two `detail` tokens, or collapsing them all to
 * `null`, left the suite green — and those tokens carry the difference between
 * *"a successor holds this repository"* and *"this repository has no owner and
 * there is a record sitting in quarantine"*.
 *
 * ── The instrument, which already existed ──────────────────────────────────
 *
 * `tests/v2-07lr-enoent-window.test.ts` established it: a `vi.mock('node:fs')`
 * factory whose wrapper runs a hook **after a real syscall and before the
 * caller's next one**. No sleep, no timeout, no barrier, no child process — the
 * window is opened exactly where production opens it, and the filesystem
 * produces the consequence itself. This file reuses that shape (it cannot
 * import it: a `vi.mock` factory is hoisted per test file) and adds one thing
 * the sibling did not need — a **one-shot fault**, for the branches whose entry
 * condition is a syscall refusing.
 *
 * Injection is used for exactly those branches and nowhere else, and each one
 * says which. Where a real refusal is available it is used instead: the
 * `DETACH_REFUSED` case below renames a directory Windows will not rename, and
 * injects nothing.
 *
 * ── The rule the fault-injected cases are about ────────────────────────────
 *
 * `occupancyOf` decides whether an operator is told the repository is unowned.
 * It is asked only after a restore has already failed, so a `stat` that itself
 * fails knows nothing — and the one thing it must never do is announce a free
 * repository it has not established. That is an authority statement, and an
 * authority statement that no test can fail is a comment.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The window, and the faults. Hoisted so the `vi.mock` factory can see them.
 *
 * `afterRead` entries are one-shot and matched by path, so a test can stage two
 * different windows in one call — the read that proves the lease, and the read
 * of the record the removal has just detached — without either firing on the
 * other's syscall.
 *
 * A fault returns the errno token the call should refuse with, or `null` to let
 * it through, and is disarmed the moment it fires. One injected failure per
 * test, which is what keeps a fault from also refusing the assertions
 * afterwards.
 */
const io = vi.hoisted(() => ({
  afterRead: [] as { readonly when: (path: string) => boolean; readonly run: (path: string) => void }[],
  faults: {
    read: null as null | ((path: string) => string | null),
    link: null as null | ((path: string) => string | null),
    open: null as null | ((path: string) => string | null),
    stat: null as null | ((path: string) => string | null),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  const refuse = (kind: 'read' | 'link' | 'open' | 'stat', path: string): void => {
    const fault = io.faults[kind];
    if (fault === null) return;
    const code = fault(path);
    if (code === null) return;
    io.faults[kind] = null;
    throw Object.assign(new Error(`injected ${code}`), { code });
  };

  return {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>): unknown => {
      const path = String(args[0]);
      refuse('read', path);
      const result = actual.readFileSync(...args);
      const index = io.afterRead.findIndex((hook) => hook.when(path));
      if (index !== -1) io.afterRead.splice(index, 1)[0]?.run(path);
      return result;
    },
    linkSync: (from: Parameters<typeof actual.linkSync>[0], to: Parameters<typeof actual.linkSync>[1]): void => {
      refuse('link', String(to));
      actual.linkSync(from, to);
    },
    openSync: (...args: Parameters<typeof actual.openSync>): unknown => {
      refuse('open', String(args[0]));
      return actual.openSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>): unknown => {
      refuse('stat', String(args[0]));
      return actual.statSync(...args);
    },
  };
});

const { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } =
  await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const {
  EXECUTION_LEASE_FILE_NAME,
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  verifyExecutionLeaseHeld,
} = await import('../src/lease/execution-lease.js');
const { EXECUTION_LEASE_SCHEMA_VERSION } = await import('../src/lease/lease-document.js');
type ExecutionLeaseEvidence = import('../src/core/execution-lease-evidence.js').ExecutionLeaseEvidence;

const created: string[] = [];

/**
 * Disarms everything — and first checks that everything went off.
 *
 * A window that never opened and a fault that never fired are the two ways a
 * test here can pass while asserting about a branch it never reached, and both
 * leave exactly this trace: an entry still in the queue, or a fault still
 * armed. Every hook and fault installed below is expected to be consumed by the
 * call under test, so "still armed afterwards" is a defect in the test rather
 * than an option it may take.
 */
afterEach(() => {
  const pendingWindows = io.afterRead.length;
  const unfired = Object.entries(io.faults)
    .filter(([, fault]) => fault !== null)
    .map(([kind]) => kind);

  io.afterRead.length = 0;
  io.faults.read = null;
  io.faults.link = null;
  io.faults.open = null;
  io.faults.stat = null;
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }

  expect({ pendingWindows, unfired }).toEqual({ pendingWindows: 0, unfired: [] });
});

interface Leasable {
  readonly repository: { readonly gitCommonDir: string; readonly root: string; readonly id: string };
  readonly leasePath: string;
}

/** The same fixture `tests/v2-07lr-release-contract.test.ts` uses, and for the same reason. */
function leasableDirectory(prefix: string): Leasable {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  const gitCommonDir = join(root, '.git');
  mkdirSync(gitCommonDir, { recursive: true });
  return {
    repository: { gitCommonDir, root, id: 'release-window' },
    leasePath: join(gitCommonDir, EXECUTION_LEASE_FILE_NAME),
  };
}

function acquire(fixture: Leasable, runId: string): ExecutionLeaseEvidence {
  const acquired = acquireRepositoryExecutionLease(
    fixture.repository,
    { runId, blockId: null },
    { now: () => new Date().toISOString() },
  );
  if (!acquired.ok) throw new Error(`the fixture could not take its own lease: ${acquired.code}`);
  return acquired.evidence;
}

/**
 * A valid lease record for this repository that is **not** the holder's.
 *
 * A successor's record rather than arbitrary bytes: the branch under test is
 * "somebody else's lease is at the name now", and a file that fails to parse
 * would also reach it — by the weaker route of an unreadable document, which is
 * a different finding for an operator.
 */
function successorRecord(fixture: Leasable, nonce: string): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: EXECUTION_LEASE_SCHEMA_VERSION,
        leaseKey: fixture.repository.gitCommonDir,
        repositoryRoot: fixture.repository.root,
        repositoryId: fixture.repository.id,
        ownerPid: process.pid,
        ownerNonce: nonce,
        acquiredAt: new Date().toISOString(),
        runId: 'run-successor',
        blockId: null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function leaseArtefactsBeside(leasePath: string): string[] {
  return readdirSync(dirname(leasePath)).filter((name) => name.startsWith(EXECUTION_LEASE_FILE_NAME));
}

/** The quarantine file a removal detached into, when it kept one. */
function quarantinedBeside(leasePath: string): string[] {
  return readdirSync(dirname(leasePath))
    .filter((name) => name.includes('.breaking-'))
    .map((name) => join(dirname(leasePath), name));
}

const isQuarantineOf = (leasePath: string) => (path: string) => path.startsWith(`${leasePath}.breaking-`);

/* ───── the window between proving the lease and removing it, uninjected ──── */

describe('what happens in the window is what the release reports', () => {
  it('reports a lease that vanished in the window as absent, and detaches nothing', () => {
    const fixture = leasableDirectory('ao-window-absent-');
    const evidence = acquire(fixture, 'run-vanishing');

    // The window, opened where production opens it: the bytes that prove the
    // lease have been read, and the name is empty before the removal's `rename`
    // reaches it. Everything after this is the real filesystem's answer.
    io.afterRead.push({
      when: (path) => path === fixture.leasePath,
      run: () => unlinkSync(fixture.leasePath),
    });

    const released = releaseRepositoryExecutionLease(evidence);

    // `LEASE_ABSENT`, because that is what it is. Two mutants die here and
    // nowhere else in the suite: mapping `ABSENT` onto `RELEASED` — which
    // reports a removal this call did not perform — and dropping the `ENOENT`
    // discrimination in the rename catch, which reports a free repository as a
    // lease that could not be touched.
    expect(released).toEqual({ code: 'LEASE_ABSENT', detail: null });
    expect(io.afterRead).toHaveLength(0);
    // Nothing was detached, so there is no record in quarantine to send an
    // operator after.
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([]);
  });

  it('reports a record that changed in the window as not this holder\'s, and puts it back', () => {
    const fixture = leasableDirectory('ao-window-changed-');
    const evidence = acquire(fixture, 'run-displaced');
    const successor = successorRecord(fixture, 'a'.repeat(64));

    io.afterRead.push({
      when: (path) => path === fixture.leasePath,
      run: () => writeFileSync(fixture.leasePath, successor),
    });

    const released = releaseRepositoryExecutionLease(evidence);

    expect(released).toEqual({ code: 'NOT_OWNER', detail: null });
    // The successor's record is back at the name, byte for byte — detached,
    // decided about, and restored. Mapping `CHANGED` onto `RELEASED` would have
    // deleted it; a restoring `rename` would have overwritten whatever had
    // taken the name.
    expect(readFileSync(fixture.leasePath)).toEqual(successor);
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([EXECUTION_LEASE_FILE_NAME]);
  });

  it('says a record it could not put back is quarantined, and that a successor holds the name', () => {
    const fixture = leasableDirectory('ao-window-quarantined-');
    const evidence = acquire(fixture, 'run-quarantining');
    const displaced = successorRecord(fixture, 'b'.repeat(64));
    const squatter = successorRecord(fixture, 'c'.repeat(64));

    // Two windows, one call. The first swaps the record so the removal refuses
    // to delete it; the second takes the freed name in the one instant it is
    // unoccupied — after the detach, before the restore.
    io.afterRead.push({
      when: (path) => path === fixture.leasePath,
      run: () => writeFileSync(fixture.leasePath, displaced),
    });
    io.afterRead.push({
      when: isQuarantineOf(fixture.leasePath),
      run: () => writeFileSync(fixture.leasePath, squatter),
    });

    const released = releaseRepositoryExecutionLease(evidence);

    // `NOT_OWNER` is the honest headline, and the detail is the part an
    // operator would otherwise only discover by looking inside `.git`.
    expect(released).toEqual({ code: 'NOT_OWNER', detail: 'RECORD_QUARANTINED' });
    // The successor that took the name is untouched…
    expect(readFileSync(fixture.leasePath)).toEqual(squatter);
    // …and the record that could not go back is **kept**, not deleted.
    const kept = quarantinedBeside(fixture.leasePath);
    expect(kept).toHaveLength(1);
    expect(readFileSync(kept[0] ?? '')).toEqual(displaced);
  });

  it('reports a detach that moved nothing as an absence, not as a record it cannot read', () => {
    // The second `ENOENT` arm, and the one a real-process harness measured
    // rather than deduced: under contention this platform can return success
    // from a `rename` whose source has just been taken, **having moved
    // nothing** — so the detached name holds no object, and the only evidence a
    // detach really happened is the object being there afterwards.
    //
    // The concurrency that produces it is not reproducible on demand in
    // process, so the *state* it leaves is produced instead — and produced
    // rather than injected: the seam here runs **before** the read and takes
    // the object away, so the `ENOENT` that follows is the filesystem's own,
    // for the same reason it is in production. What is pinned is the reading of
    // that outcome: nothing was detached, the lease was already gone, and the
    // answer is `LEASE_ABSENT`. Dropping the arm reports it as a record
    // detached and unreadable, which sends an operator after a quarantine file
    // that was never created.
    const fixture = leasableDirectory('ao-window-phantom-');
    const evidence = acquire(fixture, 'run-phantom');
    io.faults.read = (path) => {
      if (!isQuarantineOf(fixture.leasePath)(path)) return null;
      io.faults.read = null;
      unlinkSync(path);
      return null;
    };

    const released = releaseRepositoryExecutionLease(evidence);

    expect(released).toEqual({ code: 'LEASE_ABSENT', detail: null });
    expect(quarantinedBeside(fixture.leasePath)).toEqual([]);
  });

  const onWindows = it.runIf(process.platform === 'win32');

  onWindows('reports a detach the filesystem refused as refused, not as an absence', () => {
    const fixture = leasableDirectory('ao-window-detach-');
    const evidence = acquire(fixture, 'run-refused');
    let handle: number | null = null;

    // No injection. The lease has been proved; the name then becomes a
    // directory holding an open file, which Windows genuinely refuses to
    // rename. That refusal is the branch: nothing was detached, and the thing
    // at the lease name is exactly where it was.
    io.afterRead.push({
      when: (path) => path === fixture.leasePath,
      run: () => {
        unlinkSync(fixture.leasePath);
        mkdirSync(fixture.leasePath, { recursive: true });
        const pinned = join(fixture.leasePath, 'held-open.txt');
        writeFileSync(pinned, 'keeping this directory busy\n', 'utf8');
        handle = openSync(pinned, 'r+');
      },
    });

    try {
      const released = releaseRepositoryExecutionLease(evidence);

      if (released.code === 'LEASE_ABSENT') {
        throw new Error(
          'the platform allowed the rename, so this instrument produced nothing to assert about',
        );
      }
      expect(released).toEqual({ code: 'LEASE_REMOVE_FAILED', detail: 'DETACH_REFUSED' });
      // Untouched, which is the whole difference from an absence: an operator
      // is told the lease is still there rather than that the repository is
      // free, and there is no quarantined record to go looking for.
      expect(existsSync(join(fixture.leasePath, 'held-open.txt'))).toBe(true);
      expect(quarantinedBeside(fixture.leasePath)).toEqual([]);
    } finally {
      if (handle !== null) closeSync(handle);
    }
  });

  it('still releases normally when no window is opened', () => {
    // The control. Every case above installs something; a mock that quietly
    // changed the ordinary path would make all of them meaningless.
    const fixture = leasableDirectory('ao-window-control-');
    const evidence = acquire(fixture, 'run-ordinary');

    expect(releaseRepositoryExecutionLease(evidence)).toEqual({ code: 'RELEASED', detail: null });
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([]);
  });
});

/* ─────── the branches whose entry condition is a syscall refusing ────────── */

describe('a restore that could not happen is reported as what it left behind', () => {
  it('reports an unreadable detached record as unreadable, and puts it back', () => {
    // Injected: the read of the detached record refuses with something that is
    // not `ENOENT`. There is no non-injected route to it — a record this call
    // cannot read is, on a healthy filesystem, one nothing wrote.
    const fixture = leasableDirectory('ao-window-unidentifiable-');
    const evidence = acquire(fixture, 'run-unreadable');
    const held = readFileSync(fixture.leasePath);
    io.faults.read = (path) => (isQuarantineOf(fixture.leasePath)(path) ? 'EPERM' : null);

    const released = releaseRepositoryExecutionLease(evidence);

    expect(released).toEqual({ code: 'LEASE_REMOVE_FAILED', detail: 'UNREADABLE_AFTER_DETACH' });
    // A record this call could not identify is one it may not remove: it is
    // back at the lease name, and the holder still holds the repository.
    expect(readFileSync(fixture.leasePath)).toEqual(held);
    expect(verifyExecutionLeaseHeld(evidence).code).toBe('HELD');
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([EXECUTION_LEASE_FILE_NAME]);
  });

  it('keeps an unreadable record when the freed name has been taken', () => {
    const fixture = leasableDirectory('ao-window-unidentifiable-taken-');
    const evidence = acquire(fixture, 'run-unreadable-taken');
    const held = readFileSync(fixture.leasePath);
    const squatter = successorRecord(fixture, 'd'.repeat(64));

    // The fault *is* the window here, and deliberately so: the read it refuses
    // is the only moment between the detach and the restore, so the successor
    // has to appear inside it. Everything after — the `EEXIST` that proves the
    // name is occupied — is the real filesystem's answer.
    io.faults.read = (path) => {
      if (!isQuarantineOf(fixture.leasePath)(path)) return null;
      writeFileSync(fixture.leasePath, squatter);
      return 'EPERM';
    };

    const released = releaseRepositoryExecutionLease(evidence);

    expect(released).toEqual({ code: 'LEASE_REMOVE_FAILED', detail: 'RECORD_QUARANTINED' });
    expect(readFileSync(fixture.leasePath)).toEqual(squatter);
    const kept = quarantinedBeside(fixture.leasePath);
    expect(kept).toHaveLength(1);
    expect(readFileSync(kept[0] ?? '')).toEqual(held);
  });

  it('says the repository is unowned when the name is free and the record could not go back', () => {
    const fixture = leasableDirectory('ao-window-unowned-');
    const evidence = acquire(fixture, 'run-unowned');
    const held = readFileSync(fixture.leasePath);

    // Two faults, because this end state needs both halves: the record cannot
    // be identified, and it cannot be linked back. The name is then genuinely
    // free, and `occupancyOf` establishes that with a real `stat`.
    io.faults.read = (path) => (isQuarantineOf(fixture.leasePath)(path) ? 'EPERM' : null);
    io.faults.link = (path) => (path === fixture.leasePath ? 'EPERM' : null);

    const released = releaseRepositoryExecutionLease(evidence);

    expect(released).toEqual({
      code: 'LEASE_REMOVE_FAILED',
      detail: 'RECORD_QUARANTINED_LEASE_UNOWNED',
    });
    // The two facts that detail asserts, both measured rather than trusted.
    expect(existsSync(fixture.leasePath)).toBe(false);
    const kept = quarantinedBeside(fixture.leasePath);
    expect(kept).toHaveLength(1);
    expect(readFileSync(kept[0] ?? '')).toEqual(held);
  });

  it('says a displaced record is unowned rather than quarantined-and-held', () => {
    // The same distinction on the other arm of the same pair: the detached
    // record was **readable** and simply not this holder's, so the headline is
    // `NOT_OWNER` while the detail still has to carry "and nothing holds the
    // name now". Exchanging the two tokens is a mutant that survives every
    // other test in this repository.
    const fixture = leasableDirectory('ao-window-changed-unowned-');
    const evidence = acquire(fixture, 'run-changed-unowned');
    const displaced = successorRecord(fixture, 'e'.repeat(64));

    io.afterRead.push({
      when: (path) => path === fixture.leasePath,
      run: () => writeFileSync(fixture.leasePath, displaced),
    });
    // The restore is refused twice over: `link` first, and the exclusive create
    // it falls back to. Both aim at the lease name, and neither may clobber.
    io.faults.link = (path) => (path === fixture.leasePath ? 'EPERM' : null);
    io.faults.open = (path) => (path === fixture.leasePath ? 'EPERM' : null);

    const released = releaseRepositoryExecutionLease(evidence);

    expect(released).toEqual({ code: 'NOT_OWNER', detail: 'RECORD_QUARANTINED_LEASE_UNOWNED' });
    expect(existsSync(fixture.leasePath)).toBe(false);
    const kept = quarantinedBeside(fixture.leasePath);
    expect(kept).toHaveLength(1);
    expect(readFileSync(kept[0] ?? '')).toEqual(displaced);
  });
});

/* ──────────────── the authority statement `occupancyOf` makes ────────────── */

describe('an inspection that failed never announces a free repository', () => {
  it('reports the name as taken when the stat that would prove it free refuses', () => {
    // `occupancyOf` is asked only after a restore has already failed, so it
    // knows nothing about the name until it looks. A `stat` that itself fails
    // has established nothing — and reporting `NAME_FREE` from it tells an
    // operator this repository has no owner, which is the one thing this call
    // must never say without having measured it.
    //
    // The mutant this kills — `return 'NAME_FREE'` for every `stat` failure —
    // is invisible to every other test, because the ordinary route to
    // `occupancyOf` is a name that really is free.
    const fixture = leasableDirectory('ao-window-failclosed-');
    const evidence = acquire(fixture, 'run-failclosed');
    const displaced = successorRecord(fixture, 'f'.repeat(64));

    io.afterRead.push({
      when: (path) => path === fixture.leasePath,
      run: () => writeFileSync(fixture.leasePath, displaced),
    });
    io.faults.link = (path) => (path === fixture.leasePath ? 'EPERM' : null);
    io.faults.open = (path) => (path === fixture.leasePath ? 'EPERM' : null);
    io.faults.stat = (path) => (path === fixture.leasePath ? 'EPERM' : null);

    const released = releaseRepositoryExecutionLease(evidence);

    // Fail closed: quarantined, and **not** "the repository is unowned".
    expect(released).toEqual({ code: 'NOT_OWNER', detail: 'RECORD_QUARANTINED' });
    // And the state the refusal was made in, stated rather than implied: the
    // name really is free. The report is deliberately the more cautious of the
    // two, which is exactly why nothing may derive an action from it.
    expect(existsSync(fixture.leasePath)).toBe(false);
    expect(quarantinedBeside(fixture.leasePath)).toHaveLength(1);
  });
});
