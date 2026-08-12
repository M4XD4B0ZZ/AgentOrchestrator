/**
 * V2-07L — the repository execution lease, proved by trying to break it.
 *
 * The invariant under test is one sentence:
 *
 * > For one repository, at most one productive orchestrator writer holds
 * > authority at a time.
 *
 * "One repository" is the **local Git administrative domain** — the normalised
 * `git-common-dir` — and not the profile's `repositoryId`. V2-07 settled that
 * and this file pins both halves of it: two worktrees of one clone are one
 * domain, and two clones declaring the same id are two.
 *
 * Almost everything here is a counter-proof, because the ways this feature goes
 * wrong are all ways of *getting past it*:
 *
 *  1. **Acquire twice.** Check-then-write is what V2-07 already lost a write to.
 *     The claim must survive a second caller, and — in the dist race harness —
 *     two real processes.
 *  2. **Write the evidence down.** A `{ leaseHeld: true }` would be exactly the
 *     `authPreflightPassed: true` mistake again, so the artefact is nominal and
 *     must not compile from a literal.
 *  3. **Cast past the type.** No type system stops `as unknown as`, so every
 *     consumption point is an `instanceof` gate and a forgery must deny.
 *  4. **Release somebody else's.** A caller holding a run id, a pid or a guess
 *     must not be able to remove a lease it does not own.
 *  5. **Walk around it.** Every productive writer path must *demand* evidence.
 *     A single path that does not is the whole guarantee.
 *  6. **Outlive it.** A lease acquired minutes ago is not a lease held now, so
 *     the driver re-proves it every iteration.
 *  7. **Take over a dead owner's.** Measured, not assumed: see the recovery
 *     section. Nothing here may take over automatically.
 *
 * ── One thing this file deliberately does not fabricate ────────────────────
 *
 * `ExecutionLeaseEvidence`. Every test that needs a held lease acquires a real
 * one, exactly as `tests/helpers/auth-evidence.ts` mints real auth evidence. A
 * cast appears only where the forgery *is* the subject.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { BREAK_ATTENDANCE_WITHHELD_SENTENCE } from '../src/cli/lease-command.js';
import {
  LEASE_ACQUIRE_SENTENCES,
  LEASE_BREAK_SENTENCES,
  LEASE_LIVENESS_SENTENCES,
  LEASE_STATE_SENTENCES,
  renderLeaseStatus,
} from '../src/cli/render-lease.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import {
  isExecutionLeaseEvidence,
  type ExecutionLeaseEvidence,
} from '../src/core/execution-lease-evidence.js';
import {
  acquireRepositoryExecutionLease,
  breakRepositoryExecutionLease,
  inspectRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  verifyExecutionLeaseHeld,
} from '../src/lease/execution-lease.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { releaseTaskWorkspace } from '../src/run/release-workspace.js';
import { runTask } from '../src/run/run-driver.js';
import { startTask } from '../src/run/start-task.js';
import { loadTaskState } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { authPreflightPasses, provenAuthEvidence } from './helpers/auth-evidence.js';
import { createRepoFixture, git, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { e2eProfile, taskFile, tickingClock } from './helpers/e2e-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } from './helpers/worktree-fixtures.js';

afterEach(() => {
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const TASK_ID = 'V2-07L';

/* ─────────────────────────────── fixtures ───────────────────────────────── */

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

/** A real lease, acquired the way production acquires one. */
function acquire(fixture: Fixture, runId: string | null = null) {
  return acquireRepositoryExecutionLease(
    fixture.repository,
    { runId, blockId: null },
    { now: tickingClock() },
  );
}

/** A real lease, or a loud failure — never a silently unleased test. */
function heldLease(fixture: Fixture, runId: string | null = null): ExecutionLeaseEvidence {
  const acquired = acquire(fixture, runId);
  if (!acquired.ok) throw new Error(`fixture could not take the lease: ${acquired.code}`);
  return acquired.evidence;
}

/**
 * A pid that is certainly not running: a real process, started and awaited.
 *
 * Invented numbers would be a guess about the host's pid space. This is an
 * observation — with the one residual the recovery section names, that the OS
 * may reuse a pid, which is exactly why liveness is never authority here.
 */
function deadPid(): number {
  const finished = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (finished.pid === undefined) throw new Error('could not observe a finished process');
  return finished.pid;
}

function revisionOfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every `.ts` file under `src/`. Same walk as `tests/internal-api.test.ts`. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
    }
  };
  walk(join(PACKAGE_ROOT, 'src'));
  return files;
}

/* ─────────────────── 1. the claim, and a second caller ──────────────────── */

describe('the lease is exclusive per local Git domain', () => {
  it('is taken by the first caller, in the repository’s own Git common directory', async () => {
    const fixture = await leasableRepository();

    const acquired = acquire(fixture, 'run-0001');

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(isExecutionLeaseEvidence(acquired.evidence)).toBe(true);
    // Inside the administrative directory, never inside a working tree: a lease
    // that lived in the checkout would dirty it and refuse the next workspace.
    expect(acquired.path.startsWith(fixture.repository.gitCommonDir)).toBe(true);
    expect(existsSync(acquired.path)).toBe(true);
  });

  it('refuses a second caller and leaves the first lease byte-for-byte alone', async () => {
    const fixture = await leasableRepository();
    const first = acquire(fixture, 'run-0001');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = revisionOfFile(first.path);

    const second = acquire(fixture, 'run-0002');

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('LEASE_HELD');
    // The refusal wrote nothing. A "refusal" that replaced the holder's record
    // would be a takeover with a polite exit code.
    expect(revisionOfFile(first.path)).toBe(before);
  });

  it('is still exclusive on a filesystem that refuses to link', async () => {
    // The fallback exists for FAT and for network mounts that will not hard
    // link, and no test can make NTFS refuse on demand — so the seam is how
    // that branch gets to run at all. Without this it would ship having never
    // executed, in the one mechanism the whole slice rests on.
    const fixture = await leasableRepository();
    const refuseToLink = () => {
      const error: NodeJS.ErrnoException = new Error('link is not supported here');
      error.code = 'EPERM';
      throw error;
    };

    const first = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-0001', blockId: null },
      { now: tickingClock(), link: refuseToLink },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The record is whole, so the claim is not merely exclusive but usable: a
    // fallback that produced an unreadable lease would be worse than failing.
    const status = inspectRepositoryExecutionLease(fixture.repository);
    expect(status.state).toBe('HELD');
    expect(status.runId).toBe('run-0001');

    const second = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-0002', blockId: null },
      { now: tickingClock(), link: refuseToLink },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('LEASE_HELD');

    // And it leaves nothing behind: a staging file per failed claim would
    // accumulate inside the administrative directory forever.
    const staging = readdirSync(fixture.repository.gitCommonDir).filter((entry) =>
      entry.startsWith('agent-orchestrator-execution-lease.json.tmp-'),
    );
    expect(staging).toEqual([]);
  });

  it('is free again once its owner releases it', async () => {
    const fixture = await leasableRepository();
    const first = heldLease(fixture);

    const released = releaseRepositoryExecutionLease(first);
    expect(released.code).toBe('RELEASED');

    const second = acquire(fixture);
    expect(second.ok).toBe(true);
  });

  it('treats two worktrees of one clone as one execution domain', async () => {
    const fixture = await leasableRepository();
    // Derived from the fixture's own unique root rather than from a fixed name
    // in the shared temp directory: a constant path collides with a leftover
    // from a previous run, which is a failure about the fixture rather than
    // about the lease.
    const linked = `${fixture.root}-linked`;
    git(fixture.root, ['worktree', 'add', '--quiet', linked, '-b', 'linked-branch']);

    const sibling = await resolveFixture(linked);
    // Same clone, so the same administrative identity — whatever the paths say.
    expect(sibling.gitCommonDir).toBe(fixture.repository.gitCommonDir);

    heldLease(fixture);
    const fromSibling = acquireRepositoryExecutionLease(
      sibling,
      { runId: null, blockId: null },
      { now: tickingClock() },
    );

    expect(fromSibling.ok).toBe(false);
    if (fromSibling.ok) return;
    expect(fromSibling.code).toBe('LEASE_HELD');

    git(fixture.root, ['worktree', 'remove', '--force', linked]);
    rmSync(linked, { recursive: true, force: true });
  });

  it('treats two clones declaring one repositoryId as two execution domains', async () => {
    // The trap V2-07 named: `repositoryId` is declared *logical* identity, so
    // two clones of one remote answer the same id and are two independent local
    // writers. A lease keyed on it would refuse a run that is not competing.
    const alpha = await leasableRepository();
    const beta = await leasableRepository();
    expect(beta.repository.id).toBe(alpha.repository.id);
    expect(beta.repository.gitCommonDir).not.toBe(alpha.repository.gitCommonDir);

    expect(acquire(alpha).ok).toBe(true);
    expect(acquire(beta).ok).toBe(true);
  });
});

/* ──────────────────── 2 & 3. the evidence cannot be made ────────────────── */

describe('lease evidence is produced, never asserted', () => {
  it('refuses an object of the right shape at compile time', () => {
    // @ts-expect-error a structurally similar object is not evidence: the
    // `#private` field makes the type nominal, which is the whole mechanism.
    const forged: ExecutionLeaseEvidence = { leasePath: 'C:/x', nonce: 'a'.repeat(64) };
    expect(isExecutionLeaseEvidence(forged)).toBe(false);
  });

  it('refuses an empty object at compile time', () => {
    // @ts-expect-error worth its own case: without the nominal marker this class
    // is structurally equal to `{}`, which every object satisfies.
    const forged: ExecutionLeaseEvidence = {};
    expect(isExecutionLeaseEvidence(forged)).toBe(false);
  });

  it.each([
    ['a bare true', true],
    ['a lease-held flag', { leaseHeld: true }],
    ['an empty object', {}],
    ['a class with the same shape', new (class { leasePath = 'C:/x'; })()],
    ['undefined', undefined],
    ['null', null],
  ])('denies %s at the runtime gate', (_label, forged) => {
    expect(isExecutionLeaseEvidence(forged)).toBe(false);
  });

  it('has its mint imported by exactly one module in the product', () => {
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (/import\s*\{[^}]*mintExecutionLeaseEvidence[^}]*\}/.test(text)) {
        importers.push(relative(PACKAGE_ROOT, file));
      }
    }

    // The lease store is the only producer. A second one would make every case
    // in this file a statement about only one of them.
    expect(importers).toEqual([join('src', 'lease', 'execution-lease.ts')]);
  });

  it('is re-exported by no module at all', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (/export\s*\{[^}]*(mintExecutionLeaseEvidence|ExecutionLeaseProof)/.test(text)) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ───────────────────────── 4. releasing another's ───────────────────────── */

describe('release is owner-only', () => {
  it('refuses a forged evidence value and removes nothing', async () => {
    const fixture = await leasableRepository();
    const real = acquire(fixture);
    expect(real.ok).toBe(true);
    if (!real.ok) return;

    const forged = { leasePath: real.path, nonce: 'f'.repeat(64) } as unknown as ExecutionLeaseEvidence;
    const refused = releaseRepositoryExecutionLease(forged);

    expect(refused.code).toBe('EVIDENCE_INVALID');
    expect(existsSync(real.path)).toBe(true);
  });

  it('refuses evidence whose lease has since been replaced by another owner', async () => {
    const fixture = await leasableRepository();
    const first = heldLease(fixture, 'run-0001');
    expect(releaseRepositoryExecutionLease(first).code).toBe('RELEASED');

    // A different invocation now holds it. The first invocation's evidence is a
    // record of a lease that is over, and must not remove the successor's.
    const second = acquire(fixture, 'run-0002');
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const stale = releaseRepositoryExecutionLease(first);

    expect(stale.code).toBe('NOT_OWNER');
    expect(existsSync(second.path)).toBe(true);
    expect(revisionOfFile(second.path)).toBe(revisionOfFile(second.path));
  });

  it('reports an absent lease as absent rather than as a release', async () => {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    expect(releaseRepositoryExecutionLease(evidence).code).toBe('RELEASED');

    expect(releaseRepositoryExecutionLease(evidence).code).toBe('LEASE_ABSENT');
  });
});

/* ─────────────── 5. every productive writer path demands it ─────────────── */

describe('no productive writer path runs without the lease', () => {
  it('refuses startTask with forged evidence, and creates nothing', async () => {
    const fixture = await leasableRepository();
    const forged = { leaseHeld: true } as unknown as ExecutionLeaseEvidence;

    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: forged,
      },
    );

    expect(started.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    // Refused before anything was opened: no state, and no workspace.
    expect(loadTaskState(fixture.root, TASK_ID).classification).toBe('STATE_MISSING');
    expect(started.workspace).toBeNull();
    expect(started.residue).toBe(false);
  });

  it('refuses runTask with forged evidence', async () => {
    const fixture = await leasableRepository();
    const forged = { leaseHeld: true } as unknown as ExecutionLeaseEvidence;

    const run = await runTask(
      {
        repository: fixture.repository,
        taskId: TASK_ID,
        taskBrief: TASK_ID,
        attendedContinuation: true,
        authEvidence: provenAuthEvidence(),
        lease: forged,
        maxSteps: 4,
      },
      { now: tickingClock(), git: runGitCommand },
    );

    expect(run.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(run.steps).toBe(0);
  });

  it('refuses releaseTaskWorkspace with forged evidence, and removes nothing', async () => {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');
    const worktree = started.workspace?.worktreePath;
    if (worktree === undefined) throw new Error('no workspace was created');

    const forged = { leaseHeld: true } as unknown as ExecutionLeaseEvidence;
    const released = await releaseTaskWorkspace(fixture.repository, TASK_ID, {
      git: runGitCommand,
      lease: forged,
    });

    expect(released.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    // The directory a concurrent run might be writing in is still there.
    expect(existsSync(worktree)).toBe(true);
    expect(released.worktreeRemoved).toBe(false);
    expect(released.branchRemoved).toBe(false);
  });

  it('requires the lease as a parameter rather than defaulting it', () => {
    // The compiler is the assertion here, not the expectation below.
    //
    // Asked as "is `lease` a *required* key" rather than with an
    // `@ts-expect-error` on a partial literal, because that spelling proves less
    // than it looks: the directive suppresses whatever error the next line
    // happens to raise, so a literal that is also wrong for some other reason
    // passes while saying nothing about the lease. This asks the one question.
    type RequiredKeys<T> = {
      [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
    }[keyof T];

    const startRequiresIt: 'lease' extends RequiredKeys<Parameters<typeof startTask>[1]>
      ? true
      : { readonly ERROR: 'startTask no longer requires execution-lease evidence' } = true;
    const runRequiresIt: 'lease' extends RequiredKeys<Parameters<typeof runTask>[0]>
      ? true
      : { readonly ERROR: 'runTask no longer requires execution-lease evidence' } = true;
    const releaseRequiresIt: 'lease' extends RequiredKeys<Parameters<typeof releaseTaskWorkspace>[2]>
      ? true
      : { readonly ERROR: 'releaseTaskWorkspace no longer requires execution-lease evidence' } = true;

    expect([startRequiresIt, runRequiresIt, releaseRequiresIt]).toEqual([true, true, true]);
  });
});

/* ─────────────────────── 6. the lease is live authority ─────────────────── */

describe('a lease acquired minutes ago is not a lease held now', () => {
  it('stops the driver when the lease is removed underneath it', async () => {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');

    // Somebody else cleared it — an operator breaking a lease they believed
    // stale, a stray delete. The run has no authority any more, whatever its
    // in-memory artefact says.
    const held = verifyExecutionLeaseHeld(evidence);
    expect(held.code).toBe('HELD');
    expect(releaseRepositoryExecutionLease(evidence).code).toBe('RELEASED');

    const run = await runTask(
      {
        repository: fixture.repository,
        taskId: TASK_ID,
        taskBrief: TASK_ID,
        attendedContinuation: true,
        authEvidence: provenAuthEvidence(),
        lease: evidence,
        maxSteps: 4,
      },
      { now: tickingClock(), git: runGitCommand },
    );

    expect(run.outcome).toBe('EXECUTION_LEASE_LOST');
    expect(run.steps).toBe(0);
  });
});

/* ───────────────── 7. crash, death, and the refusal to guess ────────────── */

describe('a lease nobody released is never taken over automatically', () => {
  it('refuses a lease whose recorded owner is provably gone', async () => {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture, 'run-0001');
    const path = inspectRepositoryExecutionLease(fixture.repository).path;

    // The owner is dead. That is *not* proof that no writer survives it: the
    // measured behaviour of this build's spawn path is that descendant lifetime
    // comes from a Job Object the orchestrator does not create, and on POSIX the
    // agent is deliberately spawned `detached`. So this refuses.
    const stale = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-0002', blockId: null },
      { now: tickingClock(), processAlive: () => 'NOT_FOUND' },
    );

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('STALE_LEASE_RECOVERY_UNSAFE');
    expect(existsSync(path)).toBe(true);
    expect(isExecutionLeaseEvidence(evidence)).toBe(true);
  });

  it('refuses a lease whose liveness cannot be determined', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture);

    const undetermined = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: null, blockId: null },
      { now: tickingClock(), processAlive: () => 'UNDETERMINED' },
    );

    expect(undetermined.ok).toBe(false);
    if (undetermined.ok) return;
    expect(undetermined.code).toBe('STALE_LEASE_RECOVERY_UNSAFE');
  });

  it('never reads a half-written lease as a free one', async () => {
    // The crash window the acquire contract creates on purpose: the exclusive
    // create succeeded and the process died before the metadata was flushed.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const path = inspectRepositoryExecutionLease(fixture.repository).path;
    expect(releaseRepositoryExecutionLease(evidence).code).toBe('RELEASED');
    writeFileSync(path, '{"schemaVersion":1,"owner', 'utf8');

    const after = acquire(fixture);

    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.code).toBe('STALE_LEASE_RECOVERY_UNSAFE');
    expect(existsSync(path)).toBe(true);
  });
});

/* ────────────────────────── 8. the attended break ───────────────────────── */

describe('lease status reports what a break must name', () => {
  it('reports a free repository as free, with no revision to name', async () => {
    const fixture = await leasableRepository();

    const status = inspectRepositoryExecutionLease(fixture.repository);

    expect(status.state).toBe('FREE');
    expect(status.revision).toBeNull();
    expect(status.ownerPid).toBeNull();
  });

  it('reports a held lease with its owner, its run and its revision', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-0007');

    const status = inspectRepositoryExecutionLease(fixture.repository);

    expect(status.state).toBe('HELD');
    expect(status.ownerPid).toBe(process.pid);
    expect(status.runId).toBe('run-0007');
    expect(status.revision).toBe(revisionOfFile(status.path));
    expect(status.liveness).toBe('ALIVE');
  });

  it('reports a revision for an unparseable lease too, so it has an exit', async () => {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const path = inspectRepositoryExecutionLease(fixture.repository).path;
    releaseRepositoryExecutionLease(evidence);
    writeFileSync(path, 'not a lease at all', 'utf8');

    const status = inspectRepositoryExecutionLease(fixture.repository);

    expect(status.state).toBe('UNPARSEABLE');
    expect(status.revision).toBe(revisionOfFile(path));
    expect(status.ownerPid).toBeNull();
    // Nothing can be said about a process nobody recorded.
    expect(status.liveness).toBe('UNKNOWABLE');
  });
});

describe('breaking a lease names exactly the lease that was inspected', () => {
  it('removes a stale lease the operator identified by revision and owner', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-0001');
    const status = inspectRepositoryExecutionLease(fixture.repository);

    const broken = breakRepositoryExecutionLease(
      fixture.repository,
      { expectedRevision: status.revision, ownerPid: status.ownerPid },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(broken.code).toBe('BROKEN');
    expect(existsSync(status.path)).toBe(false);
    expect(acquire(fixture).ok).toBe(true);
  });

  it('refuses when the lease changed between inspection and break', async () => {
    const fixture = await leasableRepository();
    const first = heldLease(fixture, 'run-0001');
    const observed = inspectRepositoryExecutionLease(fixture.repository);

    // The window `--expected-revision` exists to close: the lease the operator
    // looked at is gone, and a *different* run holds one now.
    releaseRepositoryExecutionLease(first);
    heldLease(fixture, 'run-0002');

    const refused = breakRepositoryExecutionLease(
      fixture.repository,
      { expectedRevision: observed.revision, ownerPid: observed.ownerPid },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(refused.code).toBe('LEASE_CHANGED');
    expect(existsSync(observed.path)).toBe(true);
    expect(inspectRepositoryExecutionLease(fixture.repository).runId).toBe('run-0002');
  });

  it('refuses to break a lease whose owner is observably alive', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture);
    const status = inspectRepositoryExecutionLease(fixture.repository);

    // The real probe, against this very process, which is certainly running.
    const refused = breakRepositoryExecutionLease(fixture.repository, {
      expectedRevision: status.revision,
      ownerPid: status.ownerPid,
    });

    expect(refused.code).toBe('LEASE_OWNER_ALIVE');
    expect(existsSync(status.path)).toBe(true);
  });

  it('refuses to break a lease whose owner liveness is undetermined', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture);
    const status = inspectRepositoryExecutionLease(fixture.repository);

    const refused = breakRepositoryExecutionLease(
      fixture.repository,
      { expectedRevision: status.revision, ownerPid: status.ownerPid },
      { processAlive: () => 'UNDETERMINED' },
    );

    expect(refused.code).toBe('LEASE_OWNER_LIVENESS_UNDETERMINED');
    expect(existsSync(status.path)).toBe(true);
  });

  it('refuses a break that does not name the owner of a readable lease', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture);
    const status = inspectRepositoryExecutionLease(fixture.repository);

    const refused = breakRepositoryExecutionLease(
      fixture.repository,
      { expectedRevision: status.revision, ownerPid: null },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(refused.code).toBe('OWNER_PID_REQUIRED');
    expect(existsSync(status.path)).toBe(true);
  });

  it('refuses a break that names the wrong owner', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture);
    const status = inspectRepositoryExecutionLease(fixture.repository);

    const refused = breakRepositoryExecutionLease(
      fixture.repository,
      { expectedRevision: status.revision, ownerPid: deadPid() },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(refused.code).toBe('OWNER_PID_MISMATCH');
    expect(existsSync(status.path)).toBe(true);
  });

  it('does not destroy a lease acquired after its own check (ABA)', async () => {
    // The defect this closes, reproduced before it was fixed and kept here so
    // it stays closed. Every gate of a break is about *bytes*; the removal used
    // to be about a *name*, and between the two the name can come to hold
    // something else:
    //
    //   operator inspects stale lease A  ->  A is released
    //     ->  a new legitimate run acquires B  ->  the break unlinks B
    //
    // and it reported BROKEN, having satisfied its "never break a living owner"
    // rule against A's dead owner. That is an authority defect, not a tidiness
    // one: B's run loses the lease it holds, and a third writer may then take a
    // repository B is still working in.
    //
    // The liveness probe is what makes this deterministic. It is a real syscall
    // sitting inside the real window, so driving the swap from it reproduces the
    // production race exactly rather than inventing one.
    const fixture = await leasableRepository();
    const a = acquire(fixture, 'run-A');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const observed = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    let b: ReturnType<typeof acquire> | null = null;
    const broken = breakRepositoryExecutionLease(
      fixture.repository,
      { expectedRevision: observed.revision, ownerPid: observed.ownerPid },
      {
        processAlive: () => {
          expect(releaseRepositoryExecutionLease(a.evidence).code).toBe('RELEASED');
          b = acquire(fixture, 'run-B');
          // The operator's premise is true of A, and A is what they inspected.
          return 'NOT_FOUND';
        },
      },
    );

    const successor = b as ReturnType<typeof acquire> | null;
    expect(successor?.ok).toBe(true);
    expect(broken.code).toBe('LEASE_CHANGED');
    // The new run still holds what it took.
    expect(existsSync(observed.path)).toBe(true);
    if (successor === null || !successor.ok) return;
    expect(verifyExecutionLeaseHeld(successor.evidence).code).toBe('HELD');
    expect(inspectRepositoryExecutionLease(fixture.repository).runId).toBe('run-B');
  });

  it('leaves no quarantine file behind when it puts a lease back', async () => {
    // The guarded removal detaches before it identifies, so a refusal has to
    // restore *and* clean up. A `.breaking-` file accumulating in the
    // administrative directory on every refused break would be residue nothing
    // ever collects.
    const fixture = await leasableRepository();
    const a = acquire(fixture, 'run-A');
    if (!a.ok) return;
    const observed = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    breakRepositoryExecutionLease(
      fixture.repository,
      { expectedRevision: observed.revision, ownerPid: observed.ownerPid },
      {
        processAlive: () => {
          releaseRepositoryExecutionLease(a.evidence);
          acquire(fixture, 'run-B');
          return 'NOT_FOUND';
        },
      },
    );

    const residue = readdirSync(fixture.repository.gitCommonDir).filter((entry) =>
      entry.includes('.breaking-'),
    );
    expect(residue).toEqual([]);
  });

  it('lets an operator clear an unparseable lease by its observed bytes alone', async () => {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const path = inspectRepositoryExecutionLease(fixture.repository).path;
    releaseRepositoryExecutionLease(evidence);
    writeFileSync(path, '{"schemaVersion":1,"owner', 'utf8');
    const status = inspectRepositoryExecutionLease(fixture.repository);

    const broken = breakRepositoryExecutionLease(fixture.repository, {
      expectedRevision: status.revision,
      ownerPid: null,
    });

    expect(broken.code).toBe('BROKEN');
    expect(existsSync(path)).toBe(false);
  });

  it('refuses an owner claim about a lease that records no owner', async () => {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const path = inspectRepositoryExecutionLease(fixture.repository).path;
    releaseRepositoryExecutionLease(evidence);
    writeFileSync(path, 'not a lease at all', 'utf8');
    const status = inspectRepositoryExecutionLease(fixture.repository);

    const refused = breakRepositoryExecutionLease(fixture.repository, {
      expectedRevision: status.revision,
      ownerPid: process.pid,
    });

    expect(refused.code).toBe('OWNER_PID_UNEXPECTED');
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a break that names nothing at all', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture);
    const status = inspectRepositoryExecutionLease(fixture.repository);

    const refused = breakRepositoryExecutionLease(
      fixture.repository,
      { expectedRevision: null, ownerPid: status.ownerPid },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(refused.code).toBe('LEASE_CHANGED');
    expect(existsSync(status.path)).toBe(true);
  });
});

/* ───────────────── 9. the operator vocabulary stays legible ─────────────── */

describe('the lease report', () => {
  it('prints only ASCII, so no console or encoding can garble a refusal', () => {
    // This repository has twice had text damaged by a re-encoding pass, and a
    // refusal an operator has to act on is the worst place for that. The
    // comments around these tables are prose and are not held to it; the
    // printed sentences are.
    const all = [
      ...Object.values(LEASE_ACQUIRE_SENTENCES),
      ...Object.values(LEASE_BREAK_SENTENCES),
      ...Object.values(LEASE_STATE_SENTENCES),
      ...Object.values(LEASE_LIVENESS_SENTENCES),
      BREAK_ATTENDANCE_WITHHELD_SENTENCE,
    ].join('');

    expect([...all].filter((character) => character.codePointAt(0)! > 0x7f)).toEqual([]);
  });

  it('tells an operator exactly what a break would have to name', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-0009');
    const inspection = inspectRepositoryExecutionLease(fixture.repository);

    const report = renderLeaseStatus(inspection);

    // The digest is 64 characters. A report that made an operator retype it is
    // a report that trains them to skip `--expected-revision`, which is the one
    // gate standing between a break and a legitimate successor's lease.
    expect(report).toContain(`--expected-revision ${inspection.revision ?? ''}`);
    expect(report).toContain(`--owner-pid ${String(process.pid)}`);
    expect(report).toContain('--attended');
  });

  it('never suggests a break for a repository nobody owns', async () => {
    const fixture = await leasableRepository();

    const report = renderLeaseStatus(inspectRepositoryExecutionLease(fixture.repository));

    expect(report).not.toContain('lease break');
  });
});

/* ──────────── 10. the block store stays inside a leased run scope ────────── */

describe('the ledger store gains no productive caller outside a leased run', () => {
  it('has its mutating functions imported by no other production module', () => {
    // The lease guarantee is **run-scoped**: V2-08 must hold one lease across a
    // whole block run and perform its ledger writes underneath it. A per-write
    // lease parameter would misstate that, so the store keeps its signature —
    // and this is what stops a productive caller appearing without the decision
    // being made. `block-progress.ts` is the sanctioned in-layer caller; a
    // runner, a CLI command or a driver reaching the store directly breaks here.
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (/import\s*\{[^}]*(createBlockLedger|updateBlockLedger)[^}]*\}/.test(text)) {
        importers.push(relative(PACKAGE_ROOT, file));
      }
    }

    expect(importers.sort()).toEqual([join('src', 'block', 'block-progress.ts')]);
  });
});
