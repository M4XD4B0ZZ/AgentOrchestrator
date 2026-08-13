/**
 * V2-07LR remediation — what the independent adversarial review found.
 *
 * The recovery slice shipped and was then reviewed by six independent lenses.
 * Every finding below was reproduced against the merged build before a line of
 * this file existed, and each test here fails on that build.
 *
 *  R1  `acquireRepositoryExecutionLease` was the one gate-then-effect entry
 *      point LF-2 did not reach. It reads `root` for `repositoryRecordIsCoherent`
 *      and again for the document it writes, so an accessor record passes the
 *      coherence gate as repository A and is recorded as repository B — and the
 *      resulting lease then verifies as `HELD` for B, which is precisely the
 *      second simultaneous authority that gate exists to prevent.
 *
 *  R2  The restore after a non-matching detach is a bare `linkSync`. On a
 *      filesystem that refuses hard links — which this module explicitly
 *      supports, and ships `claimViaExclusiveCreate` for — the restore can never
 *      succeed, so a *refusal* leaves the lease name empty and the next writer
 *      takes the repository. The review reproduced it with a real refusal rather
 *      than a stub, by saturating NTFS's 1024-name limit on the very inode being
 *      restored.
 *
 *  R3  `removeVerifiedLease` answered one code from two materially different end
 *      states — "put back, quarantine discarded" and "could not be put back,
 *      record left in quarantine" — so the operator sentence promised a
 *      `.breaking-` file that the same call had deleted.
 *
 *  R4  The restore half was pinned by nothing: `link` → `rename`, and
 *      discarding rather than keeping a record that could not be put back, both
 *      survived all 34 tests of the slice and all five rounds of its
 *      real-process harness. Those two mutants are the v1 and v3 defects that
 *      withdrew this command twice.
 *
 * The rule these share is the one the slice was supposed to be about: a decision
 * about bytes must be carried out on those bytes, and every refusal must leave
 * the world exactly as it found it.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  removeVerifiedLease,
  verifyExecutionLeaseHeld,
  verifyExecutionLeaseHeldFor,
} from '../src/lease/execution-lease.js';
import { breakInspectedLease } from '../src/lease/lease-recovery.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { removeRepoFixtures, createRepoFixture } from './helpers/repo-fixtures.js';
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

const TASK_ID = 'V2-07LR-R';

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

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Removes probe leftovers. A file or a directory: both are this test's own. */
function cleanUpPaths(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* the fixture removal takes whatever is left */
    }
  }
}

function quarantineFilesBeside(leasePath: string): string[] {
  return readdirSync(dirname(leasePath)).filter((name) => name.includes('.breaking-'));
}

/**
 * The mutant, and why it counts reads rather than watching for the gate.
 *
 * The slice's own suite uses a record that answers truthfully on the `root` read
 * immediately following a `gitCommonDir` read, because that pairing is what an
 * authority gate does. It is the wrong instrument *here*, and a mutation probe
 * proved it: `repositoryRecordIsCoherent` reads `gitCommonDir` a second time to
 * compare the derived common directory, which re-arms that helper and hands the
 * document a truthful answer. The mutant survived a test that looked like it
 * was pinning exactly this.
 *
 * On the acquire path the two reads are simply consecutive — the coherence gate
 * and then the document — so the honest instrument is a count: truthful once,
 * another genuine repository afterwards.
 */
function rootShiftsAfterTheFirstRead(
  repository: ResolvedRepository,
  first: string,
  later: string,
): ResolvedRepository {
  let reads = 0;
  return {
    ...repository,
    get root(): string {
      reads += 1;
      return reads === 1 ? first : later;
    },
  };
}

/* ─────── R1. the acquire path reads the record once, like the rest ──────── */

describe('a lease is never minted for a record the coherence gate did not see', () => {
  it('refuses, or records, one repository — never one gate and another document', async () => {
    const leased = await leasableRepository();
    const foreign = await leasableRepository();

    // Truthful for `repositoryRecordIsCoherent`, and another genuine repository
    // for the document written from the next read. Both values are real; only
    // the pairing is a lie.
    const acquired = acquireRepositoryExecutionLease(
      rootShiftsAfterTheFirstRead(leased.repository, leased.root, foreign.root),
      { runId: 'run-mixed', blockId: null },
      { now: tickingClock() },
    );

    if (!acquired.ok) {
      // The honest outcome for a record that does not describe one repository.
      expect(acquired.code).toBe('REPOSITORY_RECORD_INCOHERENT');
      return;
    }

    // If a lease *was* taken, it must be a lease for the repository whose
    // common directory holds it — and, above all, it must not prove authority
    // over the repository the gate never validated. That was the finding: the
    // document recorded B's root beside A's key, so a record pairing A's
    // `gitCommonDir` with B's `root` read back as HELD, and every writer gate
    // in the build accepts it.
    const overForeign = verifyExecutionLeaseHeldFor(
      { gitCommonDir: leased.repository.gitCommonDir, root: foreign.root, id: foreign.repository.id },
      acquired.evidence,
    );
    expect(overForeign.code).not.toBe('HELD');
    expect(verifyExecutionLeaseHeldFor(leased.repository, acquired.evidence).code).toBe('HELD');
  });

  it('still takes an ordinary lease for an honest record', async () => {
    // The control: a refusal broad enough to catch the mixed record is a
    // refusal that can quietly make every acquisition impossible.
    const fixture = await leasableRepository();

    const acquired = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-honest', blockId: null },
      { now: tickingClock() },
    );

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(verifyExecutionLeaseHeldFor(fixture.repository, acquired.evidence).code).toBe('HELD');
  });
});

/* ───────── R2/R3/R4. the restore, and what it tells the operator ───────── */

describe('a record this call may not remove survives, and is reported as it is', () => {
  /**
   * The instrument, and why it needs no seam.
   *
   * `execution-lease.ts` says of its acquire fallback that "no test can make
   * NTFS refuse on demand", which is true of a general refusal and not of this
   * one: NTFS caps a file at 1024 names, so saturating the lease file's link
   * count makes `rename` still succeed while `link` back onto the freed name is
   * refused by the real filesystem. That is the FAT / network-mount case
   * reproduced on the host this build is verified on, with no mock anywhere.
   */
  function saturateLinkCount(path: string): string[] {
    const extras: string[] = [];
    for (let index = 0; index < 1023; index += 1) {
      const name = `${path}.link-${String(index)}`;
      try {
        linkSync(path, name);
      } catch {
        break;
      }
      extras.push(name);
    }
    return extras;
  }

  function cleanUp(paths: readonly string[]): void {
    for (const path of paths) {
      try {
        unlinkSync(path);
      } catch {
        /* the test's own leftovers; the fixture removal takes the rest */
      }
    }
  }

  const onWindows = it.runIf(process.platform === 'win32');

  onWindows('never frees the lease name when the restore is refused', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    const acquired = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-holder', blockId: null },
      { now: tickingClock() },
    );
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const held = readFileSync(path);

    const extras = saturateLinkCount(path);
    try {
      // A removal that decides the detached record is not its own. On a
      // filesystem that refuses to link, the shipped code left the lease name
      // empty here and reported that nothing had been removed — so the next
      // acquirer took a repository whose owner was still running.
      const removal = removeVerifiedLease(path, () => false);

      expect(removal).not.toBe('REMOVED');
      // The record is still the repository's lease, at the repository's lease
      // path, byte for byte.
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path)).toEqual(held);
      // And the holder can still prove it holds it, which is the only sense in
      // which it holds anything.
      expect(verifyExecutionLeaseHeld(acquired.evidence).code).toBe('HELD');
    } finally {
      cleanUp(extras);
    }
  });

  onWindows('tells an operator the truth when the restore is refused', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-holder', blockId: null },
      { now: tickingClock() },
    );
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    const held = readFileSync(path);

    const extras = saturateLinkCount(path);
    try {
      // The refusal has to happen *after* the detach, or the gate answers first
      // and nothing is ever put back. The probe therefore answers as the
      // classifying read needs — gone — and then as the predicate re-check
      // finds it: alive. That is a real sequence, not a contrivance: it is a
      // pid observed as absent and then reused before the removal.
      let probes = 0;
      const broken = breakInspectedLease(
        fixture.repository,
        {
          expectedRevision: inspected.revision ?? '', expectedObjectId: inspected.objectId ?? '',
          expectedOwnerPid: inspected.ownerPid,
        },
        {
          processAlive: () => {
            probes += 1;
            return probes === 1 ? 'NOT_FOUND' : 'ALIVE';
          },
        },
      );

      expect(broken.outcome).toBe('LEASE_NOT_BREAKABLE');
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path)).toEqual(held);
    } finally {
      cleanUp(extras);
    }
  });

  it('keeps a record it could not put back, and says so rather than promising a file it deleted', async () => {
    // R3. `UNIDENTIFIABLE` and `CHANGED` were each returned from two end states
    // — record restored and quarantine discarded, or record left in quarantine
    // — so the sentence for a verification failure sent an operator to inspect
    // a `.breaking-` file that the same call had just unlinked.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    writeFileSync(path, 'not a lease this build can read\n');
    const restored = readFileSync(path);

    // Nothing squats the name: the restore succeeds and the quarantine goes.
    const putBack = removeVerifiedLease(path, () => false);

    expect(putBack).toBe('CHANGED');
    expect(readFileSync(path)).toEqual(restored);
    expect(quarantineFilesBeside(path)).toEqual([]);

    // And the other end state, reached by squatting the freed name from inside
    // the predicate — the one moment at which the lease name is unoccupied.
    const squatted = removeVerifiedLease(path, () => {
      writeFileSync(path, 'a successor took the freed name\n');
      return false;
    });

    expect(squatted).toBe('CHANGED_QUARANTINED');
    // The squatter is untouched, and the record that could not be put back is
    // kept rather than deleted.
    expect(readFileSync(path).toString('utf8')).toContain('a successor took the freed name');
    const kept = quarantineFilesBeside(path);
    expect(kept.length).toBe(1);
    expect(readFileSync(join(dirname(path), kept[0] ?? ''))).toEqual(restored);
    cleanUp(kept.map((name) => join(dirname(path), name)));
  });

  it('removes nothing, and keeps the squatter, when the name is taken mid-removal', async () => {
    // R4, the first surviving mutant: `link` → `rename` on the restore. A
    // rename overwrites, so the mutant silently destroys the record of whoever
    // took the freed name — the ABA that withdrew this command the first time.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    const first = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-first', blockId: null },
      { now: tickingClock() },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let successorBytes: Buffer | null = null;
    const removal = removeVerifiedLease(path, () => {
      // A successor acquires the freed name in the window this call opened.
      const successor = acquireRepositoryExecutionLease(
        fixture.repository,
        { runId: 'run-successor', blockId: null },
        { now: tickingClock() },
      );
      expect(successor.ok).toBe(true);
      successorBytes = readFileSync(path);
      return false;
    });

    expect(removal).toBe('CHANGED_QUARANTINED');
    expect(successorBytes).not.toBeNull();
    // The successor's record is exactly what it wrote. A restoring `rename`
    // would have overwritten it with the detached one.
    expect(readFileSync(path)).toEqual(successorBytes);
    cleanUp(quarantineFilesBeside(path).map((name) => join(dirname(path), name)));
  });

  it('reports an absence as an absence, never as a removal', async () => {
    // R4, the second surviving mutant: reporting `ABSENT` as `LEASE_REMOVED`.
    // The distinction is the one the outcome vocabulary exists for — whether
    // *this* invocation destroyed something — and it was pinned only at the
    // gate, where a free path never reaches the removal at all.
    //
    // Reached here at the effect: the lease is there when the gate reads it and
    // gone when the removal aims at it, which is what happens when a second
    // operator, or a successor's release, gets there first.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    const evidence = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-vanishing', blockId: null },
      { now: tickingClock() },
    );
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    let removedUnderneath = false;
    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: inspected.revision ?? '', expectedObjectId: inspected.objectId ?? '', expectedOwnerPid: inspected.ownerPid },
      {
        processAlive: () => {
          if (!removedUnderneath) {
            expect(releaseRepositoryExecutionLease(evidence.evidence).code).toBe('RELEASED');
            removedUnderneath = true;
          }
          return 'NOT_FOUND';
        },
      },
    );

    expect(removedUnderneath).toBe(true);
    expect(broken.outcome).toBe('LEASE_ALREADY_GONE');
    expect(broken.outcome).not.toBe('LEASE_REMOVED');
    expect(existsSync(path)).toBe(false);
    expect(digestOf(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

/* ───── R5. what the second independent review found, and how it is pinned ──── */

describe('a refusal says what it established, and only what it established', () => {
  /**
   * The second review's blocking finding, reproduced the way it reproduced it:
   * with no injection at all.
   *
   * `putBack` proved "somebody holds the lease name" from one errno, `EEXIST`.
   * Every other restore failure — including the `bytes === null` exit, which
   * attempts no restore whatsoever — returned the same two codes, and nothing
   * between the failed restore and the returned code ever looked at the name. So
   * the answers meaning "a successor took it" were also returned when the
   * repository had been left with **no owner at all**, and the operator was told
   * the name "had been taken in that instant".
   *
   * A directory at the lease path is enough to reach it: `rename` detaches it,
   * the read fails, and the restore is skipped entirely.
   */
  it('reports an unowned repository as unowned, not as a successor holding it', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    mkdirSync(path, { recursive: true });

    const removal = removeVerifiedLease(path, () => false);

    // Kept, never deleted — a sibling lens measured that discarding it hands a
    // second writer over a live repository, so the on-disk choice was right and
    // only the reporting was wrong.
    expect(removal).toBe('UNIDENTIFIABLE_AND_UNOWNED');
    const quarantined = quarantineFilesBeside(path);
    expect(quarantined.length).toBe(1);
    // And the fact the previous version asserted without ever checking it.
    expect(existsSync(path)).toBe(false);
    cleanUpPaths(quarantined.map((name) => join(dirname(path), name)));
  });
});

describe('every guard on the removal path costs a mutant its life', () => {
  /**
   * The second review's supporting finding: three destructive-path guards were
   * written twice and pinned zero times. Each mutant survived all 139 tests of
   * the four lease suites, the 2725-test foundation run and the real-process
   * harness — because the fallback's failure branch is entered by nothing, and
   * because the object identity answers first for every case the older
   * counter-proofs construct.
   */
  it('keeps a record when the restore is refused by an occupied name', async () => {
    // Kills `writeRecord(...) === null` -> `writeRecord(...); return true`. With
    // the mutant the fallback claims success, the quarantine is discarded, and a
    // record the call had just decided it may not remove is deleted.
    //
    // No injection: the link is refused by saturating NTFS's 1024-name limit,
    // and the freed name is then occupied by a directory, which
    // `openSync(…, 'wx')` refuses exactly as an occupied name should.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    writeFileSync(path, 'a record that is not ours to remove\n');
    const kept = readFileSync(path);
    const extras: string[] = [];
    for (let index = 0; index < 1023; index += 1) {
      const name = `${path}.link-${String(index)}`;
      try {
        linkSync(path, name);
      } catch {
        break;
      }
      extras.push(name);
    }

    try {
      const removal = removeVerifiedLease(path, () => {
        mkdirSync(path, { recursive: true });
        return false;
      });

      expect(removal).toBe('CHANGED_QUARANTINED');
      const quarantined = quarantineFilesBeside(path);
      expect(quarantined.length).toBe(1);
      expect(readFileSync(join(dirname(path), quarantined[0] ?? ''))).toEqual(kept);
      cleanUpPaths(quarantined.map((name) => join(dirname(path), name)));
    } finally {
      cleanUpPaths(extras);
      cleanUpPaths([path]);
    }
  });

  it('refuses a record rewritten in place, where the object is no evidence at all', async () => {
    // Kills the effect-bound revision check. A record rewritten through an open
    // handle keeps its inode, so the object identity matches and only the digest
    // can refuse. With the check gone the mutant deletes it and reports
    // LEASE_REMOVED — "still the same record, byte for byte".
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
    const before = statSync(path, { bigint: true });

    let rewritten = false;
    const broken = breakInspectedLease(
      fixture.repository,
      {
        expectedRevision: inspected.revision ?? '',
        expectedObjectId: inspected.objectId ?? '',
        expectedOwnerPid: inspected.ownerPid,
      },
      {
        processAlive: () => {
          if (!rewritten) {
            const handle = openSync(path, 'r+');
            const replacement = Buffer.from('{"schemaVersion":1}\n', 'utf8');
            writeSync(handle, replacement, 0, replacement.length, 0);
            ftruncateSync(handle, replacement.length);
            closeSync(handle);
            rewritten = true;
          }
          return 'NOT_FOUND';
        },
      },
    );

    expect(rewritten).toBe(true);
    // The same object, different bytes: the identity holds and the digest refuses.
    expect(statSync(path, { bigint: true }).ino).toBe(before.ino);
    expect(broken.outcome).toBe('LEASE_CHANGED_SINCE_INSPECTION');
    expect(broken.detail).toBe('RECORD_RESTORED');
    expect(existsSync(path)).toBe(true);
  });

  it('touches nothing when the gate can already see the authorisation is wrong', async () => {
    // Kills the gate's own pid and revision arms. Without them the refusal is
    // still a refusal — and it becomes a real detach and restore of a live
    // record, whose documented residual is a displaced writer. The reason line
    // is what separates the two, so it is what this asserts.
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

    const wrongRevision = breakInspectedLease(
      fixture.repository,
      {
        expectedRevision: 'f'.repeat(64),
        expectedObjectId: inspected.objectId ?? '',
        expectedOwnerPid: inspected.ownerPid,
      },
      { processAlive: () => 'NOT_FOUND' },
    );
    expect(wrongRevision.outcome).toBe('LEASE_CHANGED_SINCE_INSPECTION');
    expect(wrongRevision.detail).toBeNull();

    const wrongOwner = breakInspectedLease(
      fixture.repository,
      {
        expectedRevision: inspected.revision ?? '',
        expectedObjectId: inspected.objectId ?? '',
        expectedOwnerPid: (inspected.ownerPid ?? 1) + 1,
      },
      { processAlive: () => 'NOT_FOUND' },
    );
    expect(wrongOwner.outcome).toBe('LEASE_NOT_BREAKABLE');
    expect(wrongOwner.detail).toBe('OWNER_PID_MISMATCH');
    expect(quarantineFilesBeside(path)).toEqual([]);
  });
});
