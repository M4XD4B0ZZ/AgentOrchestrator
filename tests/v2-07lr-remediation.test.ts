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
 *      survived the whole slice suite *and* the real-process break harness that
 *      then existed. Those two mutants are the v1 and v3 defects that withdrew
 *      the attended break, which has since been withdrawn a third time and for
 *      good; its harness went with it.
 *
 *      Stated without the counts it used to carry ("34 tests", "five rounds",
 *      against a harness whose constant said eight). A measurement is worth
 *      recording; a measurement's *size* recorded in prose beside the code it
 *      counted goes stale on the next commit and then quietly misdescribes what
 *      was established.
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
   * written twice and pinned zero times. Each mutant survived every lease suite,
   * the whole foundation run and the real-process harness of the day — because
   * the fallback's failure branch is entered by nothing, and because the object
   * identity answered first for every case the older counter-proofs construct.
   * (Suite and test counts deliberately not restated here; they were wrong within
   * two commits last time.)
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

});

/**
 * The claim that used to stand here was false, and is deleted rather than edited.
 *
 * It said the `ENOENT` discrimination in `readObject` had "no deterministic
 * instrument for it in process", that any test for it "would be a race with a
 * timeout", and that it was therefore "pinned by the reviewer's measurement and
 * by nothing here". The commit that wrote that sentence also *built* the
 * instrument, in `tests/v2-07lr-enoent-window.test.ts` — a `vi.mock('node:fs')`
 * wrapper that runs a hook between two real syscalls, with no sleep, no timeout
 * and no injected errno — and left this paragraph standing one file away.
 *
 * Two things are worth carrying forward from that. A claim about what *cannot*
 * be tested is a claim this repository has now got wrong four times, and the
 * instrument that falsified it each time already existed. And a correction
 * written in a new file does not correct the sentence it replaces: that is how
 * the same false statement came to be shipped in two places at once.
 */
describe('a detach the filesystem refused is not an absence', () => {
  /**
   * A guard nothing in the repository pinned, found by the fourth review.
   *
   * `removeVerifiedLease`'s rename catch discriminates `ENOENT` — nothing was
   * there — from every other errno, which means the name could not be detached
   * and the record is untouched. Substituting `return 'ABSENT'` for that
   * discrimination survived **the entire suite** — every file, every test, and
   * the real-process harness on top. The reverse mutant is caught, which is what
   * made the gap look covered.
   *
   * The two answers send an operator to opposite places. `ABSENT` means nothing
   * was there and the repository is free; `DETACH_FAILED` means the lease is
   * still exactly where it was and this invocation could not touch it.
   *
   * No injection: on Windows a directory holding an open file refuses to be
   * renamed. If the platform declines to produce that refusal the test says so
   * rather than asserting a state nobody established — the mistake this file has
   * already made once.
   */
  const onWindows = it.runIf(process.platform === 'win32');

  onWindows('reports a refused detach as refused, not as nothing having been there', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    // A directory at the lease name, with a file open inside it: Windows refuses
    // to rename a directory whose contents are in use.
    mkdirSync(path, { recursive: true });
    const pinned = join(path, 'held-open.txt');
    writeFileSync(pinned, 'keeping this directory busy\n');
    const handle = openSync(pinned, 'r+');

    try {
      const removal = removeVerifiedLease(path, () => true);

      if (removal === 'ABSENT') {
        throw new Error(
          'the platform allowed the rename, so this instrument produced nothing to assert about',
        );
      }
      expect(removal).toBe('DETACH_FAILED');
      // Untouched: the thing at the lease name is still the thing that was there.
      expect(existsSync(path)).toBe(true);
      expect(quarantineFilesBeside(path)).toEqual([]);
    } finally {
      closeSync(handle);
      cleanUpPaths([path]);
    }
  });
});
