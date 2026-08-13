/**
 * V2-07LR — a break is bound to the object it inspected, not to its contents.
 *
 * ── The finding this closes ────────────────────────────────────────────────
 *
 * The independent review reproduced it: for the crash-window class the whole
 * identity of a lease was `revisionOfLeaseBytes(bytes) === expectedRevision`,
 * and the canonical member of that class is a **zero-byte file**. Its digest is
 * the constant `sha256("")`, so an authorisation minted for artefact A matched
 * *any* empty object at the lease name — including the one every acquisition
 * passes through on a filesystem that refuses hard links, where
 * `claimViaExclusiveCreate` takes the name with `openSync(path, 'wx')` and
 * writes its record through that handle afterwards.
 *
 * Content cannot identify an object whose content is nothing. Neither can time:
 * a modification stamp is a property the filesystem may round to two seconds and
 * a successor may share by accident, and this build already refuses to let time
 * carry authority anywhere else.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * The operator authorises **a filesystem object** — device and inode, as the
 * platform reports them — and that identity is re-established on the object the
 * removal has already detached, immediately before it is deleted. Where the
 * platform cannot report a usable identity, the break is refused for that case
 * rather than falling back to something weaker.
 *
 * The digest stays. Both must hold: the same object, carrying the same bytes.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
  leaseObjectIdentity,
  removeVerifiedLease,
} from '../src/lease/execution-lease.js';
import { assessLeaseRecovery, breakInspectedLease } from '../src/lease/lease-recovery.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { e2eProfile, taskFile, tickingClock } from './helpers/e2e-fixtures.js';
import { releaseTestLeases } from './helpers/lease.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const TASK_ID = 'V2-07LR-OBJ';

interface Fixture {
  readonly repository: ResolvedRepository;
  readonly root: string;
}

async function leasableRepository(): Promise<Fixture> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      'src/index.ts': 'export const start = true;\n',
      [`tasks/${TASK_ID}.md`]: taskFile(TASK_ID),
    },
  });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return { repository, root };
}

function leasePathOf(fixture: Fixture): string {
  const location = deriveExecutionLeaseLocation(fixture.repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return location.path;
}

/* ─────────────── the reproduction, and what must happen now ─────────────── */

describe('a crash-window artefact is identified by which object it is', () => {
  it('refuses to remove a different empty object at the same name', async () => {
    // The review's reproduction, deterministic. A is the artefact an operator
    // inspected; B is what a legitimate acquisition puts at the same name a
    // moment later, byte-identical because both are empty.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);

    writeFileSync(path, '');
    const inspected = inspectRepositoryExecutionLease(fixture.repository);
    expect(inspected.state).toBe('UNPARSEABLE');
    expect(inspected.ownerPid).toBeNull();
    expect(inspected.revision).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(inspected.objectId).not.toBeNull();

    // A goes; B takes the name. Nothing about the bytes has changed.
    unlinkSync(path);
    writeFileSync(path, '');
    const successor = statSync(path, { bigint: true });
    expect(readFileSync(path).byteLength).toBe(0);

    const broken = breakInspectedLease(fixture.repository, {
      expectedRevision: inspected.revision ?? '',
      expectedOwnerPid: null,
      expectedObjectId: inspected.objectId ?? '',
    });

    expect(broken.outcome).toBe('LEASE_CHANGED_SINCE_INSPECTION');
    expect(existsSync(path)).toBe(true);
    // The same object, untouched — not merely a file with the same content.
    expect(statSync(path, { bigint: true }).ino).toBe(successor.ino);
  });

  it('removes the exact object it was authorised for', async () => {
    // The control, and the reason the class is breakable at all: a crash between
    // the exclusive create and the record write leaves this, and an operator
    // must have an exit from it.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    writeFileSync(path, '');
    const inspected = inspectRepositoryExecutionLease(fixture.repository);

    const broken = breakInspectedLease(fixture.repository, {
      expectedRevision: inspected.revision ?? '',
      expectedOwnerPid: null,
      expectedObjectId: inspected.objectId ?? '',
    });

    expect(broken.outcome).toBe('LEASE_REMOVED');
    expect(existsSync(path)).toBe(false);
  });

  it('binds an ordinary stale lease to its object too', async () => {
    // Not a special case for empty files: every break names an object. A lease
    // whose bytes are unique is still a lease that can be replaced by another
    // file, and the identity that decides is the object's.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-crashed', blockId: null },
      { now: tickingClock() },
    );
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    const bytes = readFileSync(path);

    // Same bytes, different object: exactly what a restore-from-backup or a
    // copied lease produces.
    unlinkSync(path);
    writeFileSync(path, bytes);

    const broken = breakInspectedLease(
      fixture.repository,
      {
        expectedRevision: inspected.revision ?? '',
        expectedOwnerPid: inspected.ownerPid,
        expectedObjectId: inspected.objectId ?? '',
      },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(broken.outcome).toBe('LEASE_CHANGED_SINCE_INSPECTION');
    expect(existsSync(path)).toBe(true);
  });

  it('refuses an authorisation that names no object at all', async () => {
    // Fail-closed, and the direction matters: an empty identity must be a
    // refusal rather than a check that quietly does not run.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    writeFileSync(path, '');
    const inspected = inspectRepositoryExecutionLease(fixture.repository);

    const broken = breakInspectedLease(fixture.repository, {
      expectedRevision: inspected.revision ?? '',
      expectedOwnerPid: null,
      expectedObjectId: '',
    });

    expect(broken.outcome).toBe('LEASE_NOT_BREAKABLE');
    expect(broken.detail).toBe('OBJECT_IDENTITY_UNUSABLE');
    expect(existsSync(path)).toBe(true);
  });
});

describe('the removal decides about the object it detached', () => {
  it('refuses an object swapped between the gate and the effect', async () => {
    // The check that must run *immediately before the destructive effect*, and
    // the one a mutation probe found unpinned: with only the gate's comparison,
    // deleting the effect-level check left every test in this file green.
    //
    // The window is opened from the liveness probe, which the gate calls after
    // it has read the bytes and the object, and which the predicate calls again
    // on the detached record. Between those two moments the object at the name
    // is replaced by one carrying **identical bytes** — so the digest still
    // matches, the owner pid still matches, and the only thing left that can
    // refuse is the identity of the object itself.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-crashed', blockId: null },
      { now: tickingClock() },
    );
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    const bytes = readFileSync(path);

    let swapped: bigint | null = null;
    const broken = breakInspectedLease(
      fixture.repository,
      {
        expectedRevision: inspected.revision ?? '',
        expectedOwnerPid: inspected.ownerPid,
        expectedObjectId: inspected.objectId ?? '',
      },
      {
        processAlive: () => {
          if (swapped === null) {
            unlinkSync(path);
            writeFileSync(path, bytes);
            swapped = statSync(path, { bigint: true }).ino;
          }
          return 'NOT_FOUND';
        },
      },
    );

    expect(swapped).not.toBeNull();
    expect(broken.outcome).toBe('LEASE_CHANGED_SINCE_INSPECTION');
    // Detached and put back, rather than refused before anything moved: this is
    // the effect-level refusal, and the reason line distinguishes the two.
    expect(broken.detail).toBe('RECORD_RESTORED');
    expect(readFileSync(path)).toEqual(bytes);
  });


  it('hands the predicate the identity of that object, not of the name', async () => {
    // The effect-bound half. `rename` moves the object, so what the predicate is
    // shown is the identity of the thing that was at the lease name — and a
    // predicate that refuses on it leaves that thing exactly where it was.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    writeFileSync(path, 'a record this build cannot parse\n');
    // `bigint: true`, because a Windows file index is a 64-bit value and Number
    // loses its low bits: the first version of this expectation was off by one
    // against the identity the code computes, which is the whole reason
    // `leaseObjectIdentity` reads it as a BigInt.
    const before = statSync(path, { bigint: true });
    const bytes = readFileSync(path);

    let seen: string | null = null;
    const removal = removeVerifiedLease(path, (detachedBytes, objectId) => {
      seen = objectId;
      expect(detachedBytes).toEqual(bytes);
      return false;
    });

    expect(removal).toBe('CHANGED');
    expect(seen).toBe(`${String(before.dev)}:${String(before.ino)}`);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path, { bigint: true }).ino).toBe(before.ino);
  });
});

describe('an object identity this platform cannot establish is not one', () => {
  it('answers null rather than inventing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-object-identity-'));
    try {
      expect(leaseObjectIdentity(join(dir, 'nothing-here.json'))).toBeNull();
      const present = join(dir, 'present.json');
      writeFileSync(present, 'x');
      expect(leaseObjectIdentity(present)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is what makes a lease breakable, so status cannot offer what break refuses', async () => {
    // `breakable` is the report an operator acts on. A lease whose object cannot
    // be identified is one the break will refuse, so the assessment must not
    // call it recoverable.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    writeFileSync(path, '');

    const assessed = assessLeaseRecovery(fixture.repository);

    expect(assessed.classification).toBe('NO_OWNER_RECORDED');
    expect(assessed.breakable).toBe(assessed.inspection.objectId !== null);
    expect(assessed.breakable).toBe(true);
  });
});
