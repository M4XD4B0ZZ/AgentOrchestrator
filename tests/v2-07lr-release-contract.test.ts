/**
 * V2-07LR — the release contract, pinned by value and by effect.
 *
 * ── What this file exists to stop happening again ──────────────────────────
 *
 * The behaviour of `releaseRepositoryExecutionLease` was correct on the head
 * this file was written against. What was missing is the part a green suite
 * cannot show you: the release path was pinned by **outcome type** —
 * `expect(result.code).toBe('RELEASED')` — and never by the `detail` value
 * beside it, and never by the state of the directory afterwards.
 *
 * Two consequences, both reproduced by mutation before a line of this file
 * existed:
 *
 *  - every `detail` token on the failure branches could be exchanged for
 *    another, or for `null`, and the suite stayed green. Those tokens are the
 *    whole difference between "a successor holds this repository" and "this
 *    repository has no owner and there is a record in quarantine", which are
 *    opposite instructions to an operator;
 *  - the `discard` that deletes the detached record after a successful removal
 *    could be dropped entirely. The lease name is free either way, so every
 *    assertion in the suite still held — while every release left a
 *    `.breaking-…` copy of a live lease record inside the Git administrative
 *    directory, for ever.
 *
 * So the rule this file works to: **a release is an effect, not a return
 * value.** Every successful release here is followed by a reading of the
 * directory, and the directory must hold nothing this protocol put there.
 *
 * ── Where the rest of it lives ─────────────────────────────────────────────
 *
 * The cases that need the window between the read that proves the lease and
 * the syscall that removes it — `LEASE_ABSENT`, `DETACH_REFUSED`, and the four
 * quarantine outcomes — are in `tests/v2-07lr-release-window.test.ts`, which
 * needs a `node:fs` mock for its whole module graph and therefore has to be its
 * own file. The real-process half is `tests/dist-artifact/`, which measures the
 * same effect against the built artefact across several OS processes.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExecutionLeaseEvidence } from '../src/core/execution-lease-evidence.js';
import {
  EXECUTION_LEASE_FILE_NAME,
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  removeVerifiedLease,
  verifyExecutionLeaseHeld,
  type LeaseRepository,
} from '../src/lease/execution-lease.js';

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

interface Leasable {
  readonly repository: LeaseRepository;
  readonly leasePath: string;
}

/**
 * A directory shaped like an ordinary clone, as far as the lease is concerned.
 *
 * Not `createRepoFixture`: nothing on the release path consults Git, and the
 * sibling window file cannot shell out at all (it mocks `node:fs` for its whole
 * module graph). One instrument across both files is worth more than a more
 * realistic one in this half only. What acquire actually requires is a `.git`
 * **directory** beside the work tree that is its own common dir — which is what
 * `repositoryRecordIsCoherent` resolves here, through Git's own two questions,
 * with nothing stubbed.
 */
function leasableDirectory(prefix: string): Leasable {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  const gitCommonDir = join(root, '.git');
  mkdirSync(gitCommonDir, { recursive: true });
  return {
    repository: { gitCommonDir, root, id: 'release-contract' },
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
 * Every entry in the administrative directory whose name this protocol owns.
 *
 * The lease itself, the `…tmp-` file a claim stages, and the `…breaking-` file
 * a removal detaches into all begin with the lease file's name, so one prefix
 * catches all three. That is the point: a successful release must leave **none**
 * of them, and asserting only on the lease name is what let the quarantine
 * artefact survive unnoticed.
 */
function leaseArtefactsBeside(leasePath: string): string[] {
  return readdirSync(dirname(leasePath)).filter((name) => name.startsWith(EXECUTION_LEASE_FILE_NAME));
}

/* ───────────── the effect, which is the half a return value hides ────────── */

describe('a release that reports success has actually destroyed the lease', () => {
  it('leaves neither the lease nor the record it detached to get there', () => {
    const fixture = leasableDirectory('ao-release-effect-');
    const evidence = acquire(fixture, 'run-effect');

    // The state before, established rather than assumed: exactly one artefact,
    // the lease. A test that only checks the "after" cannot tell a removal from
    // a directory that never held anything.
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([EXECUTION_LEASE_FILE_NAME]);

    const released = releaseRepositoryExecutionLease(evidence);

    // Pinned as a whole value. `toBe('RELEASED')` on the code alone leaves the
    // detail free to say anything, and on this branch it must say nothing.
    expect(released).toEqual({ code: 'RELEASED', detail: null });
    // The lease is gone from the name…
    expect(existsSync(fixture.leasePath)).toBe(false);
    // …and so is the record the removal detached to decide about it. This is
    // the assertion that dies with `discard(quarantine)` on the matched path:
    // without it a released lease leaves a full copy of its record behind under
    // a `.breaking-…` name, and nothing in the build ever removes it.
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([]);
    // And the holder can no longer prove anything with the artefact it kept.
    expect(verifyExecutionLeaseHeld(evidence).code).toBe('LEASE_ABSENT');
  });

  it('holds for every round, so nothing accumulates across a working day', () => {
    // One release leaving one file behind is a leak; the shape it takes is a
    // directory that grows a record per run. Three rounds in one directory is
    // what distinguishes "cleaned up" from "cleaned up once".
    const fixture = leasableDirectory('ao-release-rounds-');

    for (let round = 0; round < 3; round += 1) {
      const evidence = acquire(fixture, `run-${String(round)}`);
      expect(releaseRepositoryExecutionLease(evidence)).toEqual({ code: 'RELEASED', detail: null });
      expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([]);
    }
  });
});

/* ─────────── the two answers a missing lease may earn, both ways ─────────── */

describe('a name that holds nothing is an absence, never a refused detach', () => {
  it('answers ABSENT, and creates nothing while establishing it', () => {
    // The reverse of the mutant `tests/v2-07lr-remediation.test.ts` kills on
    // Windows. That file proves a refused `rename` is not reported as an
    // absence; this proves the genuine absence is not reported as a refusal —
    // `return 'DETACH_FAILED'` for the whole catch block survives otherwise,
    // and turns every release of an already-released lease into
    // `LEASE_REMOVE_FAILED / DETACH_REFUSED`: an operator told the lease is
    // still there and untouchable, about a repository that is free.
    const fixture = leasableDirectory('ao-release-absent-');

    const removal = removeVerifiedLease(fixture.leasePath, () => true);

    expect(removal).toBe('ABSENT');
    // A detach that never happened leaves no quarantine file to go looking for.
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([]);
  });

  it('is what a second release of one lease reports, by value', () => {
    const fixture = leasableDirectory('ao-release-twice-');
    const evidence = acquire(fixture, 'run-twice');

    expect(releaseRepositoryExecutionLease(evidence)).toEqual({ code: 'RELEASED', detail: null });
    expect(releaseRepositoryExecutionLease(evidence)).toEqual({ code: 'LEASE_ABSENT', detail: null });
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([]);
  });
});

/* ─────────────── the refusals that never reach the removal ───────────────── */

describe('a release refused before the removal leaves the repository exactly as it was', () => {
  it('refuses a successor\'s lease as not this holder\'s, by value, and does not touch it', () => {
    const fixture = leasableDirectory('ao-release-successor-');
    const first = acquire(fixture, 'run-first');
    expect(releaseRepositoryExecutionLease(first)).toEqual({ code: 'RELEASED', detail: null });

    // A different invocation holds the repository now. The first invocation's
    // artefact records a lease that is over.
    acquire(fixture, 'run-second');
    const successor = readFileSync(fixture.leasePath);

    const stale = releaseRepositoryExecutionLease(first);

    expect(stale).toEqual({ code: 'NOT_OWNER', detail: null });
    // Byte for byte, and still the only artefact in the directory: the refusal
    // neither removed the successor's record nor detached and rebuilt it.
    expect(readFileSync(fixture.leasePath)).toEqual(successor);
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([EXECUTION_LEASE_FILE_NAME]);
  });

  it('refuses a value that is not minted evidence, by value, and removes nothing', () => {
    const fixture = leasableDirectory('ao-release-forged-');
    acquire(fixture, 'run-real');
    const held = readFileSync(fixture.leasePath);

    const forged = {
      leasePath: fixture.leasePath,
      nonce: 'f'.repeat(64),
    } as unknown as ExecutionLeaseEvidence;

    expect(releaseRepositoryExecutionLease(forged)).toEqual({ code: 'EVIDENCE_INVALID', detail: null });
    expect(readFileSync(fixture.leasePath)).toEqual(held);
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([EXECUTION_LEASE_FILE_NAME]);
  });

  it('refuses a lease this build cannot read as unreadable, and detaches nothing', () => {
    // `LEASE_UNREADABLE` is the one entry-level code with no other test in the
    // suite. It is reached without injection: a **directory** at the lease name
    // is a read failure that is not `ENOENT`.
    const fixture = leasableDirectory('ao-release-unreadable-');
    const evidence = acquire(fixture, 'run-unreadable');
    rmSync(fixture.leasePath, { force: true });
    mkdirSync(fixture.leasePath, { recursive: true });
    writeFileSync(join(fixture.leasePath, 'inside.txt'), 'not a lease\n', 'utf8');

    expect(releaseRepositoryExecutionLease(evidence)).toEqual({
      code: 'LEASE_UNREADABLE',
      detail: null,
    });
    // The refusal is at the entry gate, so the removal never ran: what is at
    // the name is still there, and nothing was detached into quarantine.
    expect(existsSync(join(fixture.leasePath, 'inside.txt'))).toBe(true);
    expect(leaseArtefactsBeside(fixture.leasePath)).toEqual([EXECUTION_LEASE_FILE_NAME]);
  });
});
