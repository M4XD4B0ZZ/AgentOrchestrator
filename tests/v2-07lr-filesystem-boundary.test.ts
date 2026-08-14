/**
 * The filesystem a lease may live on, and what happens on one it may not.
 *
 * ── Why this boundary exists ───────────────────────────────────────────────
 *
 * The lease's safety argument rests on binding a decision to a filesystem
 * **object** rather than to a name, and every non-destructive step of that
 * binding is a hard link: the claim publishes a finished record by linking a
 * staged file into place, and `removeVerifiedLease` puts back a record it may not
 * remove by linking the object it detached.
 *
 * Where `link` is unavailable this module used to fall back to an exclusive
 * create, plus a restore that writes a *copy*. Six adversarial review rounds
 * established that the fallback creates a class of lease object for which the
 * rest of the protocol has no safe complete lifecycle:
 *
 *   1. the attended break could not be authorised on it — for the zero-byte
 *      record it leaves, the digest is a shared constant, no owner is named, and
 *      the object identity is reusable. The break is withdrawn;
 *   2. the acquire rollback dispossessed a competing acquirer sitting in the
 *      fallback's own pre-write window;
 *   3. and the restore, having no link, copies the record and then discards the
 *      detached original — destroying the object of a writer still holding its
 *      descriptor, leaving a permanently empty lease name nothing can clear.
 *      `release` reaches the same code.
 *
 * Fixing the callers a fourth time would have repeated the pattern that produced
 * all three. The fallback is withdrawn instead: an acquisition on a filesystem
 * whose `link` refuses now **fails closed before a lease exists at all**.
 *
 * ── What this file pins ────────────────────────────────────────────────────
 *
 * That the refusal happens, that it happens *before* anything is created, that
 * the dangerous second mechanism is not merely unused but absent — and, as the
 * positive control, that the supported path still takes, holds and releases a
 * lease. A boundary test that only proved the refusal would pass just as well if
 * the lease stopped working entirely.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Records every exclusive create attempted at the lease name.
 *
 * The fallback's signature move was `openSync(leasePath, 'wx')`. Watching for it
 * is how this file pins the *absence* of a second claim mechanism behaviourally
 * rather than by scanning source for a function name — a reintroduction under
 * any other name is caught just the same.
 */
const watch = vi.hoisted(() => ({ exclusiveCreates: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    openSync: (...args: unknown[]): unknown => {
      if (args[1] === 'wx') watch.exclusiveCreates.push(String(args[0]));
      return (actual.openSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const {
  acquireRepositoryExecutionLease,
  inspectRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  verifyExecutionLeaseHeld,
} = await import('../src/lease/execution-lease.js');

const created: string[] = [];

afterEach(() => {
  watch.exclusiveCreates = [];
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LEASE_FILE = 'agent-orchestrator-execution-lease.json';

/** A `.git` directory with no `commondir`, which makes it its own common dir. */
function leasableRepository(): {
  readonly repository: { gitCommonDir: string; root: string; id: string };
  readonly leasePath: string;
  readonly gitCommonDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'ao-fs-boundary-'));
  created.push(root);
  const gitCommonDir = join(root, '.git');
  mkdirSync(gitCommonDir, { recursive: true });
  return {
    repository: { gitCommonDir, root, id: 'fs-boundary' },
    leasePath: join(gitCommonDir, LEASE_FILE),
    gitCommonDir,
  };
}

/**
 * What a filesystem without hard links answers.
 *
 * Injected through the module's own `deps.link` seam, which is the only seam
 * that selects this behaviour and which no production caller overrides. `EPERM`
 * rather than `EEXIST`: `EEXIST` means somebody holds the name, which is a
 * different answer entirely and is asserted separately below.
 */
const REFUSING_LINK = (): never => {
  const error = new Error('operation not permitted') as Error & { code: string };
  error.code = 'EPERM';
  throw error;
};

function acquire(
  fixture: ReturnType<typeof leasableRepository>,
  link?: () => never,
): ReturnType<typeof acquireRepositoryExecutionLease> {
  return acquireRepositoryExecutionLease(
    fixture.repository,
    { runId: 'run-boundary', blockId: null },
    link === undefined
      ? { now: () => new Date().toISOString() }
      : { now: () => new Date().toISOString(), link },
  );
}

describe('a filesystem that cannot link cannot carry a lease', () => {
  it('refuses the acquisition instead of falling back', () => {
    const fixture = leasableRepository();

    const acquired = acquire(fixture, REFUSING_LINK);

    expect(acquired.ok).toBe(false);
    expect(acquired.ok ? '' : acquired.code).toBe('LEASE_FILESYSTEM_UNSUPPORTED');
    // The errno the link refused with, carried through rather than swallowed.
    expect(acquired.ok ? '' : acquired.detail).toBe('EPERM');
    // Deliberately NOT `LEASE_WRITE_FAILED`: that code means a claim was made
    // and given back, and an operator who reads it will retry. This one is about
    // the platform and retrying cannot help.
    expect(acquired.ok ? '' : acquired.code).not.toBe('LEASE_WRITE_FAILED');
  });

  it('creates nothing at all — no lease, no staging file, no leftovers', () => {
    const fixture = leasableRepository();

    acquire(fixture, REFUSING_LINK);

    // The whole point of refusing *before* a lease exists. The previous design
    // left an object here whose lifecycle it could not safely complete.
    expect(existsSync(fixture.leasePath)).toBe(false);
    expect(readdirSync(fixture.gitCommonDir)).toEqual([]);
    // And the repository still reads as free, so the next invocation on a
    // supported filesystem is not blocked by this attempt.
    expect(inspectRepositoryExecutionLease(fixture.repository).state).toBe('FREE');
  });

  it('never attempts an exclusive create at the lease name', () => {
    // The behavioural pin on the withdrawn fallback. `openSync(leasePath,'wx')`
    // was its signature move, and this catches a reintroduction under any name.
    // The staging file IS created with `wx`, and must be — that is the record
    // being written before it is published — so the assertion is about the lease
    // name specifically, not about exclusive creates in general.
    const fixture = leasableRepository();

    acquire(fixture, REFUSING_LINK);

    expect(watch.exclusiveCreates).not.toContain(fixture.leasePath);
    expect(watch.exclusiveCreates.every((path) => path !== fixture.leasePath)).toBe(true);
    // The control: staging was attempted, so the claim really did run and this
    // assertion is not passing because nothing happened.
    expect(watch.exclusiveCreates.some((path) => path.startsWith(fixture.leasePath))).toBe(true);
  });

  it('still reports an occupied name as held, not as an unsupported filesystem', () => {
    // `EEXIST` is a statement about the repository; every other errno is a
    // statement about the platform. Collapsing them would tell an operator to
    // move their repository off a filesystem that is working perfectly well.
    const fixture = leasableRepository();
    const first = acquire(fixture);
    expect(first.ok).toBe(true);

    const second = acquire(fixture);

    expect(second.ok).toBe(false);
    expect(second.ok ? '' : second.code).not.toBe('LEASE_FILESYSTEM_UNSUPPORTED');
  });

  it('touches nothing that already holds the name when it refuses', () => {
    // The harm the withdrawn fallback's rollback caused, asserted as an absence
    // at the acquire boundary: a refused acquisition on an unsupported
    // filesystem must not disturb a lease that is already there.
    const fixture = leasableRepository();
    const held = acquire(fixture);
    expect(held.ok).toBe(true);

    const before = readdirSync(fixture.gitCommonDir);
    acquire(fixture, REFUSING_LINK);

    expect(readdirSync(fixture.gitCommonDir)).toEqual(before);
    expect(held.ok ? verifyExecutionLeaseHeld(held.evidence).code : '').toBe('HELD');
  });
});

describe('the supported path still works end to end', () => {
  it('takes, holds and releases a lease on a filesystem that links', () => {
    // The positive control, and it is not decoration: every assertion in the
    // describe above would also pass if acquisition had been broken outright.
    const fixture = leasableRepository();

    const acquired = acquire(fixture);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    expect(existsSync(fixture.leasePath)).toBe(true);
    expect(verifyExecutionLeaseHeld(acquired.evidence).code).toBe('HELD');
    expect(inspectRepositoryExecutionLease(fixture.repository).state).toBe('HELD');

    const released = releaseRepositoryExecutionLease(acquired.evidence);

    expect(released.code).toBe('RELEASED');
    expect(existsSync(fixture.leasePath)).toBe(false);
    // Released means released: the name is free and the next acquisition gets it.
    expect(inspectRepositoryExecutionLease(fixture.repository).state).toBe('FREE');
    expect(acquire(fixture).ok).toBe(true);
  });

  it('publishes the lease name already complete, never half-written', () => {
    // What the single mechanism buys, and the reason the fallback could not be
    // kept: with `link` the name appears carrying a finished record, so no
    // acquirer ever holds the lease name with an unwritten file. That absence is
    // what makes the copying restore in `putBack` safe — its victim class no
    // longer exists.
    const fixture = leasableRepository();

    const acquired = acquire(fixture);
    expect(acquired.ok).toBe(true);

    // The lease name was never exclusively created; only the staging name was.
    expect(watch.exclusiveCreates).not.toContain(fixture.leasePath);
    // And what is at the name parses as a lease, first time it is read.
    expect(inspectRepositoryExecutionLease(fixture.repository).state).toBe('HELD');
  });
});
