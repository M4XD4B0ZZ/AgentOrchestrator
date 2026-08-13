/**
 * V2-07LR — the authority snapshot, the two unpinned guards, and attended recovery.
 *
 * Three pieces of work, in the order the risk runs:
 *
 *  1. **LF-2 — the authority record is read once.** `LeaseRepository` is a bare
 *     structural interface, so a record can answer one thing when the gate asks
 *     and another when the effect asks. That is not a hypothetical: it was
 *     reproduced end to end against `advanceTaskState`, and the same shape reads
 *     against the two workspace paths. The fix is one snapshot per entry point,
 *     and what proves it is not the snapshot's existence but the effect: nothing
 *     may land in a repository whose lease was never proved.
 *
 *  2. **LF-3 — two live guards that no test pinned.** The win32 drive-relative
 *     refusal, and `removeVerifiedLease`'s detach/verify/restore. The second is
 *     the mechanism the whole recovery contract rests on, and no in-process seam
 *     distinguishes it from a plain `unlink`: only its behaviour under a
 *     successor does.
 *
 *  3. **Lease recovery / attended break.** An attended break existed here, was
 *     found broken by three consecutive adversarial reviews, and was withdrawn.
 *     It comes back under a contract that names what defeated it, and the first
 *     test written for it was the ABA counter-proof — inspect A, let A go, let B
 *     legitimately acquire, then continue the authorised break. B must be
 *     untouched.
 *
 * Nothing here fabricates `ExecutionLeaseEvidence`. Every held lease is a real
 * one, taken through the real entry point, exactly as the V2-07L suite does.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { Command } from 'commander';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEASE_BREAK_SENTENCES, registerLeaseCommand } from '../src/cli/lease-command.js';
import { exitCodeForLeaseBreakOutcome } from '../src/cli/run-exit-codes.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import type { ExecutionLeaseEvidence } from '../src/core/execution-lease-evidence.js';
import {
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  verifyExecutionLeaseHeld,
} from '../src/lease/execution-lease.js';
import {
  LEASE_BREAK_OUTCOMES,
  assessLeaseRecovery,
  breakInspectedLease,
} from '../src/lease/lease-recovery.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { startTask } from '../src/run/start-task.js';
import { advanceTaskState } from '../src/state/advance-state.js';
import { loadTaskState } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { prepareTaskWorkspace } from '../src/worktree/prepare-workspace.js';
import { removeTaskWorkspace } from '../src/worktree/remove-workspace.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { createRepoFixture, git, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { e2eProfile, taskFile, tickingClock } from './helpers/e2e-fixtures.js';
import { releaseTestLeases } from './helpers/lease.js';
import {
  removeTrackedWorkspaces,
  resolveFixture,
  taskWithId,
  trackWorkspacesOf,
} from './helpers/worktree-fixtures.js';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const TASK_ID = 'V2-07LR';

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

/** The lease path of a fixture, or a loud failure. */
function leasePathOf(fixture: Fixture): string {
  const location = deriveExecutionLeaseLocation(fixture.repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return location.path;
}

function revisionOfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Every detached-lease file left beside `leasePath`.
 *
 * A quarantine file is inert and harmless by design — nothing reads a lease by
 * that name — but one left behind after a *completed* removal means the restore
 * did not happen the way the mechanism claims it does.
 */
function quarantineFilesBeside(leasePath: string): string[] {
  return readdirSync(dirname(leasePath)).filter((name) => name.includes('.breaking-'));
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

/**
 * A pid that is certainly not running: a real process, started and awaited.
 *
 * The same observation `tests/v2-07l-execution-lease.test.ts` makes, for the
 * same reason — an invented number is a guess about the host's pid space.
 */
function deadPid(): number {
  const finished = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (finished.pid === undefined) throw new Error('could not observe a finished process');
  return finished.pid;
}

/* ───────── 1. the authority record is read once, and only once (LF-2) ────── */

/**
 * The mutant, and why it is pinned to the gate rather than to a read count.
 *
 * A record that lies has to lie *between* the gate and the effect, and a count
 * cannot say where that boundary is: every site reads the record a different
 * number of times, and one added read would silently retune the mutant.
 *
 * There is one observable that does say it. `verifyExecutionLeaseHeldFor` is
 * the only reader of `gitCommonDir` — it derives the lease location from it and
 * then reads `root` exactly once to compare — so a record that answers
 * truthfully on the `root` read immediately following a `gitCommonDir` read, and
 * names another repository on every other read, is precisely a record that
 * passes every authority gate while every effect goes somewhere else.
 *
 * Nothing about it is forged: both roots are genuine repositories, and each read
 * is answered truthfully about one of them.
 */
function rootShiftsWhenTheGateAsks(
  repository: ResolvedRepository,
  awayFromTheGate: string,
  atTheGate: string,
): ResolvedRepository {
  let gating = false;
  return {
    ...repository,
    get gitCommonDir(): string {
      gating = true;
      return repository.gitCommonDir;
    },
    get root(): string {
      const answer = gating ? atTheGate : awayFromTheGate;
      gating = false;
      return answer;
    },
  };
}

describe('an effect never lands in a repository whose lease was not proved', () => {
  /**
   * The finding this section exists for (LF-2).
   *
   * Every value in the mutant record is genuine; only the *moment* it is read
   * decides which repository it names. The gate proves the lease of A and the
   * effect writes into B, and both are told the truth — separately.
   *
   * The fix is a snapshot taken once per entry point, and the assertion is
   * deliberately not "a snapshot exists". It is that B is untouched: an
   * implementation that snapshotted the wrong field, or snapshotted after the
   * gate, would satisfy a structural check and fail these.
   */
  async function startedTask(): Promise<{
    readonly fixture: Fixture;
    readonly evidence: ExecutionLeaseEvidence;
  }> {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
      },
    );
    expect(started.outcome).toBe('STARTED');
    return { fixture, evidence };
  }

  /** The runtime state file of one task, wherever it lives. */
  function statePath(root: string): string {
    return join(root, '.agent-orchestrator', 'runtime', `${TASK_ID}.json`);
  }

  it('writes no durable transition into a repository the gate never saw', async () => {
    const leased = await startedTask();
    const foreign = await leasableRepository();

    const load = loadTaskState(leased.fixture.root, TASK_ID);
    if (!load.ok) throw new Error('the task did not start');

    // B is given a byte-identical state, and that is the whole point of it.
    //
    // `advanceTaskState` threads the revision it read into the write, so a
    // write aimed at a repository holding *nothing* is refused by the
    // compare-and-swap — which is why a first attempt at this counter-proof
    // showed only a confusing `STATE_CONFLICT` and proved nothing about where
    // the write was aimed. Give the second repository the same bytes and the
    // guard has nothing to catch: the move is legitimate, the revision matches,
    // and the only question left is which repository it lands in.
    mkdirSync(join(foreign.root, '.agent-orchestrator', 'runtime'), { recursive: true });
    const copied = readFileSync(statePath(leased.fixture.root));
    writeFileSync(statePath(foreign.root), copied);

    const advanced = advanceTaskState(
      load,
      { ...load.state, state: 'CONTEXT_LOADING', stateEnteredAt: '2026-08-13T12:00:00.000Z' },
      {
        lease: {
          repository: rootShiftsWhenTheGateAsks(
            leased.fixture.repository,
            foreign.root,
            leased.fixture.root,
          ),
          evidence: leased.evidence,
        },
      },
    );

    // Whichever repository the one reading names, the gate and the write agree
    // about it — so either the move happened in the leased repository, or it was
    // refused **for the lease**. What it must never be is what the double read
    // produced: a gate satisfied about A, a write aimed at B, and a refusal from
    // the store reporting a root mismatch in a repository nobody proved
    // anything about. That refusal is a second guard catching the first one's
    // mistake, and it is the only reason this site's damage stops at a
    // misdirected attempt rather than a misdirected write.
    if (advanced.ok) {
      const reloaded = loadTaskState(leased.fixture.root, TASK_ID);
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) return;
      expect(reloaded.state.state).toBe('CONTEXT_LOADING');
    } else {
      expect(advanced.code).toBe('EXECUTION_LEASE_LOST');
      expect(loadTaskState(leased.fixture.root, TASK_ID).classification).toBe('STATE_VALID');
    }
    // And the repository the gate never saw is byte-identical.
    expect(readFileSync(statePath(foreign.root))).toEqual(copied);
  });

  it('creates no branch and no worktree in a repository the gate never saw', async () => {
    const leased = await leasableRepository();
    const foreign = await leasableRepository();
    const evidence = heldLease(leased);

    const prepared = await prepareTaskWorkspace(
      rootShiftsWhenTheGateAsks(leased.repository, foreign.root, leased.root),
      taskWithId(TASK_ID),
      { git: runGitCommand, lease: evidence },
    );

    // Whichever repository the snapshot names, it names one — so either the
    // gate refuses (the snapshot is B, whose lease this is not) or the work
    // happens in A. What may never happen is a worktree in B on A's authority.
    expect(git(foreign.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
    expect(existsSync(join(`${foreign.root}.worktrees`, TASK_ID))).toBe(false);
    if (prepared.ok) {
      expect(prepared.workspace.repositoryRoot).toBe(leased.root);
    } else {
      expect(prepared.code).toBe('EXECUTION_LEASE_NOT_HELD');
    }
  });

  it('removes no branch and no worktree in a repository the gate never saw', async () => {
    const foreign = await leasableRepository();
    const foreignLease = heldLease(foreign);
    const prepared = await prepareTaskWorkspace(foreign.repository, taskWithId(TASK_ID), {
      git: runGitCommand,
      lease: foreignLease,
    });
    if (!prepared.ok) throw new Error(`the workspace was not prepared: ${prepared.code}`);
    expect(releaseRepositoryExecutionLease(foreignLease).code).toBe('RELEASED');

    // A different repository, legitimately held by this invocation.
    const leased = await leasableRepository();
    const evidence = heldLease(leased);

    const destructive: string[] = [];
    const removal = await removeTaskWorkspace(
      rootShiftsWhenTheGateAsks(leased.repository, foreign.root, leased.root),
      taskWithId(TASK_ID),
      {
        git: async (cwd, args) => {
          if (args[0] === 'worktree' && args[1] === 'remove') destructive.push('worktree remove');
          if (args[0] === 'branch' && args[1] === '-d') destructive.push('branch -d');
          return runGitCommand(cwd, args);
        },
        lease: evidence,
      },
    );

    // Nothing in B was touched: not by Git, and not on disk.
    expect(destructive).toEqual([]);
    expect(removal.ok).toBe(false);
    expect(existsSync(prepared.workspace.worktreePath)).toBe(true);
    expect(git(foreign.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).not.toBe('');
  });

  it('starts nothing in a repository the gate never saw', async () => {
    const leased = await leasableRepository();
    const foreign = await leasableRepository();
    const evidence = heldLease(leased);

    const started = await startTask(
      {
        repository: rootShiftsWhenTheGateAsks(leased.repository, foreign.root, leased.root),
        taskId: TASK_ID,
      },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
      },
    );

    // Three gates, three effects between them — a plan read, a worktree, a
    // first durable write — and every one of them must have been aimed at the
    // repository the gates were about.
    expect(loadTaskState(foreign.root, TASK_ID).classification).toBe('STATE_MISSING');
    expect(git(foreign.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
    expect(existsSync(join(`${foreign.root}.worktrees`, TASK_ID))).toBe(false);
    if (started.outcome !== 'STARTED') {
      expect(started.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    }
  });
});

/* ────────── 2. the two guards that were live and unpinned (LF-3) ────────── */

describe('a lease location is a place, not a string that looks absolute', () => {
  /**
   * `isAbsolute` is the wrong question on Windows, and this is the one place in
   * the codebase where that bites hardest (LF-3).
   *
   * It answers `true` for a **drive-relative** root — `\foo`, and `/foo`, which
   * normalises to the same thing — which is absolute only within whichever
   * volume the process is standing on. As a comparison operand that is the
   * documented, deliberately-carried F-4. As a *file location* it is one key
   * string denoting two places: two repositories sharing one lease, or one
   * repository holding two.
   *
   * The guard was live and no test held it, so nothing but a comment stopped a
   * later simplification collapsing it back into `isAbsolute`.
   */
  const onWindows = it.runIf(process.platform === 'win32');

  onWindows('refuses a drive-relative Git common directory', () => {
    // The premise, asserted rather than asserted-about: without the extra check
    // this key passes the absolute test and a lease path is derived from it.
    expect(isAbsolute('\\repo\\.git')).toBe(true);

    for (const key of ['\\repo\\.git', '/repo/.git', '\\', '/']) {
      const derived = deriveExecutionLeaseLocation({
        gitCommonDir: key,
        root: 'C:\\repo',
        id: 'drive-relative',
      });
      expect(derived.ok).toBe(false);
      if (derived.ok) return;
      expect(derived.code).toBe('LEASE_LOCATION_UNSUITABLE');
    }
  });

  onWindows('still derives a location for the two shapes that name a volume', () => {
    // The control. A refusal broad enough to catch the drive-relative case is a
    // refusal that can quietly catch every Windows path, and a suite without
    // this case would pass against one that refuses them all.
    const local = deriveExecutionLeaseLocation({
      gitCommonDir: 'C:\\repo\\.git',
      root: 'C:\\repo',
      id: 'local',
    });
    expect(local.ok).toBe(true);

    const unc = deriveExecutionLeaseLocation({
      gitCommonDir: '\\\\server\\share\\repo\\.git',
      root: '\\\\server\\share\\repo',
      id: 'unc',
    });
    expect(unc.ok).toBe(true);
  });

  it('refuses a relative or empty key on every platform', () => {
    for (const key of ['', '   ', 'repo/.git', './.git']) {
      const derived = deriveExecutionLeaseLocation({
        gitCommonDir: key,
        root: process.cwd(),
        id: 'relative',
      });
      expect(derived.ok).toBe(false);
    }
  });
});

describe('a removal decided about bytes is carried out on those bytes', () => {
  /**
   * The mechanism the whole recovery contract rests on, pinned by what only it
   * can do (LF-3).
   *
   * `removeVerifiedLease` detaches the lease with `rename` into a name only that
   * call knows, decides about the *detached object*, and either deletes it or
   * links it back — and the lease name is never touched again except through a
   * `link`, which cannot overwrite. No in-process seam distinguishes that from
   * "read, decide, `unlink` the path": both refuse, and both leave the same
   * result when nothing else is happening.
   *
   * What distinguishes them is a *successor*. A removal that acts on the name
   * destroys whatever has taken it; a removal that acts on the object it
   * detached puts a stranger's record back exactly as it found it.
   */
  it('leaves a successor’s lease byte-for-byte alone when an owner releases late', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    const first = heldLease(fixture, 'run-first');

    // The owner's release is refused, and this is the shape that matters: the
    // artefact is genuine and *was* the lease at this path a moment ago.
    expect(releaseRepositoryExecutionLease(first).code).toBe('RELEASED');
    const successor = acquire(fixture, 'run-successor');
    expect(successor.ok).toBe(true);
    const successorBytes = readFileSync(path);

    const late = releaseRepositoryExecutionLease(first);

    // Refused as somebody else's — which it is — and B's record is the same
    // bytes it was written as. A removal aimed at the *name* would have taken
    // them: the artefact is genuine, and it did name this path a moment ago.
    expect(late.code).toBe('NOT_OWNER');
    expect(readFileSync(path)).toEqual(successorBytes);
  });

  it('puts a record it may not remove back at the name it took it from', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    const stale = heldLease(fixture, 'run-stale');

    // Somebody else's record at our path: a valid lease with another owner's
    // nonce, which is exactly what a successor's record is. The release must
    // detach it, fail to identify it as its own, and put it back.
    const doctored = Buffer.from(
      `${JSON.stringify(
        { ...JSON.parse(readFileSync(path).toString('utf8')), ownerNonce: 'a'.repeat(64) },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(path, doctored);

    const released = releaseRepositoryExecutionLease(stale);

    expect(released.code).toBe('NOT_OWNER');
    // Restored, byte-for-byte — not deleted, and not left in quarantine.
    expect(readFileSync(path)).toEqual(doctored);
    expect(quarantineFilesBeside(path)).toEqual([]);
  });
});

/* ─────────── 3. attended recovery, under the contract that names ──────────
 *              what defeated the three withdrawn attempts               */

describe('a break removes the lease that was inspected, or nothing', () => {
  /**
   * Contract 4 — **ABA must fail closed** — and it is written first on purpose.
   *
   * Inspect A. A disappears. B legitimately acquires the same path. The operator
   * confirms the break they authorised for A. B must be untouched.
   *
   * This is the defect that killed the first withdrawn attempt: the decision was
   * about bytes and the removal was about a name, so the `unlink` destroyed
   * whatever had taken the name in between — a lease somebody had *legitimately*
   * acquired, with a living owner, past a liveness check made about a dead one.
   *
   * The liveness probe answers `NOT_FOUND` throughout, deliberately. It removes
   * the one refusal that would stop the break early, so nothing but the identity
   * binding stands between the authorisation and B's record. A test where the
   * successor's own liveness saved it would prove the wrong thing.
   */
  it('never removes a lease acquired after the inspection it was authorised for', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    const victim = heldLease(fixture, 'run-victim');

    // What the operator read, and what they will name back.
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    expect(inspected.state).toBe('HELD');
    expect(inspected.revision).not.toBeNull();

    // A goes; B legitimately acquires the same path, with its own ownership.
    expect(releaseRepositoryExecutionLease(victim).code).toBe('RELEASED');
    const successor = acquire(fixture, 'run-successor');
    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    const successorBytes = readFileSync(path);

    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: inspected.revision ?? '', expectedOwnerPid: inspected.ownerPid },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(broken.outcome).toBe('LEASE_CHANGED_SINCE_INSPECTION');
    // B still has its authority, and its record was not even rewritten.
    expect(readFileSync(path)).toEqual(successorBytes);
    expect(verifyExecutionLeaseHeld(successor.evidence).code).toBe('HELD');
    expect(quarantineFilesBeside(path)).toEqual([]);
  });

  /**
   * The same defect, closed at the *effect* rather than at the gate (contract 5).
   *
   * The test above changes the world before the break is called, so an
   * implementation that merely re-read the revision at its entry would pass it.
   * This one changes the world **inside** the break — from the liveness probe,
   * which is the one seam this module takes and which is called after the
   * classifying read and before the detach. What is left to save B is the check
   * on the bytes the detach itself produced, and nothing else.
   */
  it('never removes a lease acquired between its own gate and its own effect', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    const victim = heldLease(fixture, 'run-victim');
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    let successorBytes: Buffer | null = null;
    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: inspected.revision ?? '', expectedOwnerPid: inspected.ownerPid },
      {
        processAlive: () => {
          if (successorBytes === null) {
            // The window, opened by hand: the lease the gate has just read is
            // released and re-acquired before the removal reaches the disk.
            expect(releaseRepositoryExecutionLease(victim).code).toBe('RELEASED');
            const successor = acquire(fixture, 'run-successor');
            expect(successor.ok).toBe(true);
            successorBytes = readFileSync(path);
          }
          return 'NOT_FOUND';
        },
      },
    );

    expect(broken.outcome).toBe('LEASE_CHANGED_SINCE_INSPECTION');
    expect(successorBytes).not.toBeNull();
    expect(readFileSync(path)).toEqual(successorBytes);
    expect(quarantineFilesBeside(path)).toEqual([]);
  });

  it('removes the exact lease an operator inspected, and says so', async () => {
    // The control, and the reason the command exists: a repository whose first
    // crash would otherwise be terminal until somebody hand-deletes a file
    // inside `.git`.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    heldLease(fixture, 'run-crashed');
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: inspected.revision ?? '', expectedOwnerPid: inspected.ownerPid },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(broken.outcome).toBe('LEASE_REMOVED');
    expect(existsSync(path)).toBe(false);
    expect(quarantineFilesBeside(path)).toEqual([]);
    // And the repository is usable again, which is the whole point.
    expect(acquire(fixture, 'run-next').ok).toBe(true);
  });

  it('refuses a revision the operator never saw', async () => {
    // Contract 2: observation is not authority, and neither is a guess. The
    // revision is how the operator names *which* lease they decided about.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    heldLease(fixture, 'run-crashed');
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    const bytes = readFileSync(path);

    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: 'f'.repeat(64), expectedOwnerPid: inspected.ownerPid },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(broken.outcome).toBe('LEASE_CHANGED_SINCE_INSPECTION');
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('refuses an owner the inspected bytes do not name', async () => {
    // Contract 3: the removal must prove it is removing the lease the operator
    // inspected. The revision alone settles the bytes; the pid is what the
    // operator was *shown*, and a mismatch means they are describing a different
    // lease from the one that is there — a copied command line, most likely.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    heldLease(fixture, 'run-crashed');
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    const bytes = readFileSync(path);

    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: inspected.revision ?? '', expectedOwnerPid: deadPid() },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(broken.outcome).toBe('LEASE_NOT_BREAKABLE');
    expect(broken.detail).toBe('OWNER_PID_MISMATCH');
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('refuses a lease whose owner is observably running, whatever was authorised', async () => {
    // Contract 6: stale-or-not and may-this-be-removed are two decisions. This
    // authorisation is perfect — the right revision, the right pid — and the
    // owner is alive, so the removal is refused anyway.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    heldLease(fixture, 'run-live');
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    const bytes = readFileSync(path);

    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: inspected.revision ?? '', expectedOwnerPid: inspected.ownerPid },
      { processAlive: () => 'ALIVE' },
    );

    expect(broken.outcome).toBe('LEASE_NOT_BREAKABLE');
    expect(broken.detail).toBe('OWNER_RUNNING');
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('refuses a lease whose owner liveness cannot be established', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    heldLease(fixture, 'run-unknown');
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    const bytes = readFileSync(path);

    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: inspected.revision ?? '', expectedOwnerPid: inspected.ownerPid },
      { processAlive: () => 'UNDETERMINED' },
    );

    expect(broken.outcome).toBe('LEASE_NOT_BREAKABLE');
    expect(broken.detail).toBe('OWNER_LIVENESS_UNDETERMINED');
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('reports a lease that is already gone as gone, not as removed', async () => {
    // Contract 7: five durable answers, and this one matters most to a script.
    // "I removed it" and "it was not there" are different facts, and only one of
    // them says this invocation destroyed something.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture, 'run-gone');
    const inspected = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });
    expect(releaseRepositoryExecutionLease(evidence).code).toBe('RELEASED');

    const broken = breakInspectedLease(
      fixture.repository,
      { expectedRevision: inspected.revision ?? '', expectedOwnerPid: inspected.ownerPid },
      { processAlive: () => 'NOT_FOUND' },
    );

    expect(broken.outcome).toBe('LEASE_ALREADY_GONE');
  });

  it('breaks a crash-window lease that names no owner, by its bytes alone', async () => {
    // The artefact a crash between the exclusive create and the record write
    // leaves: something at the lease path that this build cannot parse and that
    // names no process at all. It is the case an operator most needs an exit
    // from, and it is identified by its revision, because there is nothing else.
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    writeFileSync(path, '');

    const inspected = inspectRepositoryExecutionLease(fixture.repository);
    expect(inspected.state).toBe('UNPARSEABLE');
    expect(inspected.ownerPid).toBeNull();

    const broken = breakInspectedLease(fixture.repository, {
      expectedRevision: inspected.revision ?? '',
      expectedOwnerPid: null,
    });

    expect(broken.outcome).toBe('LEASE_REMOVED');
    expect(existsSync(path)).toBe(false);
  });

  it('refuses an owner pid offered for a lease that records none', async () => {
    const fixture = await leasableRepository();
    const path = leasePathOf(fixture);
    writeFileSync(path, '');
    const inspected = inspectRepositoryExecutionLease(fixture.repository);

    const broken = breakInspectedLease(fixture.repository, {
      expectedRevision: inspected.revision ?? '',
      expectedOwnerPid: deadPid(),
    });

    expect(broken.outcome).toBe('LEASE_NOT_BREAKABLE');
    expect(broken.detail).toBe('OWNER_PID_MISMATCH');
    expect(existsSync(path)).toBe(true);
  });
});

describe('classification and removal authority are two decisions', () => {
  /**
   * Contract 6, stated as a type rather than as a habit: `assessLeaseRecovery`
   * says what is there; it never says who may remove it. A caller holding a
   * `STALE_OWNER_GONE` assessment still has to satisfy the break, and the break
   * re-establishes every fact for itself.
   */
  it('classifies a stale lease as stale without authorising anything', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-stale');

    const assessed = assessLeaseRecovery(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    expect(assessed.classification).toBe('STALE_OWNER_GONE');
    expect(assessed.breakable).toBe(true);
    // The assessment is a report. Nothing in it is an argument any removal takes.
    expect(Object.keys(assessed).sort()).toEqual(['breakable', 'classification', 'inspection']);
  });

  it('classifies a running owner as not breakable', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-live');

    const assessed = assessLeaseRecovery(fixture.repository, { processAlive: () => 'ALIVE' });

    expect(assessed.classification).toBe('OWNER_RUNNING');
    expect(assessed.breakable).toBe(false);
  });

  it('classifies a free repository as having nothing to recover', async () => {
    const fixture = await leasableRepository();

    const assessed = assessLeaseRecovery(fixture.repository);

    expect(assessed.classification).toBe('NOTHING_TO_RECOVER');
    expect(assessed.breakable).toBe(false);
  });
});

describe('there is no way to break a lease that is not this one', () => {
  it('offers no force, no automatic and no unattended break', async () => {
    // Contract 1. The vocabulary is checked as well as the surface: a `--force`
    // that exists only in a help string is still a promise to an operator.
    const recovery = await import('../src/lease/lease-recovery.js');

    expect(Object.keys(recovery).filter((name) => /force|auto|clear/i.test(name))).toEqual([]);

    // Declared options only. The words `--force` and `--unattended` appear all
    // over this build's prose, and every one of those occurrences says the
    // thing does not exist; what would be a promise is an option registered on
    // a command.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const declared = readFileSync(file, 'utf8').match(/\.option\(\s*['"][^'"]+['"]/g) ?? [];
      if (declared.some((option) => /force|unattended|adopt|takeover|steal/i.test(option))) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is reachable from exactly one command, which requires an operator', () => {
    // The destructive entry point lives in its own module so that this pin can
    // exist at all: `execution-lease.js` is imported by a dozen modules, and a
    // break exported from it would be reachable from every one of them.
    //
    // A `import type … from` is not a route: `verbatimModuleSyntax` erases it,
    // so the exit-code table can name the outcome vocabulary without being able
    // to call anything. Judged per statement rather than per file, so a type
    // import and a value import in one file are two different answers.
    const specifier = /['"][^'"]*lease-recovery\.js['"]/;
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      // Comments first, or a paragraph *about* type imports decides the answer:
      // the statement this scan reads must be code and nothing else.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[^\n]*\/\/.*$/gm, '');
      const reaches = code
        .split(';')
        .some((statement) => specifier.test(statement) && !/^\s*import\s+type\b/.test(statement));
      if (reaches) importers.push(relative(PACKAGE_ROOT, file));
    }
    expect(importers.sort()).toEqual([join('src', 'cli', 'lease-command.ts')]);
  });

  it('hands the guarded removal itself to exactly one module', () => {
    // The module pin above answers "who can reach the break". This answers the
    // sharper question the export opened: `removeVerifiedLease` takes its whole
    // authority as a predicate, so a caller passing `() => true` has written a
    // plain `unlink` with extra steps. It was private until this slice, and it
    // is exported now only because the recovery flow lives in its own module —
    // which is worth nothing unless the primitive stays as narrowly reachable
    // as the flow does.
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (file.endsWith(join('lease', 'execution-lease.ts'))) continue;
      if (/\bremoveVerifiedLease\b/.test(text)) importers.push(relative(PACKAGE_ROOT, file));
    }
    expect(importers.sort()).toEqual([join('src', 'lease', 'lease-recovery.ts')]);
  });

  it('removes a lease from nowhere but the one guarded removal', () => {
    // `unlinkSync` and `renameSync` aimed at the lease path are the two calls
    // that can destroy an authority, and they live in exactly one module — the
    // one that binds them to the bytes it detached. `state/atomic-file.ts`
    // renames too, and it is not about a lease.
    const destructive = sourceFiles().filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /unlinkSync|renameSync/.test(text) && /EXECUTION_LEASE_FILE_NAME/.test(text);
    });
    expect(destructive.map((file) => relative(PACKAGE_ROOT, file))).toEqual([
      join('src', 'lease', 'execution-lease.ts'),
    ]);
  });
});

/* ─────────── 4. the command an operator actually types, end to end ───────── */

describe('agent-loop lease break', () => {
  let stdout: string[] = [];
  let stderr: string[] = [];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function invoke(args: readonly string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerLeaseCommand(program);
    await program.parseAsync(['lease', ...args], { from: 'user' });
  }

  /**
   * A lease with a dead owner, written as a real lease document.
   *
   * Not a seam: the pid is a process this test started and waited for, and
   * everything below runs through the *real* liveness probe. It is the one
   * fixture that cannot be produced by acquiring, because acquiring records the
   * live pid of the acquiring process — which is this one.
   */
  function crashedLease(fixture: Fixture, ownerPid: number): { path: string; revision: string } {
    const path = leasePathOf(fixture);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          leaseKey: fixture.repository.gitCommonDir,
          repositoryRoot: fixture.repository.root,
          repositoryId: fixture.repository.id,
          ownerPid,
          ownerNonce: 'b'.repeat(64),
          acquiredAt: '2026-08-13T10:00:00.000Z',
          runId: 'run-crashed',
          blockId: null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return { path, revision: revisionOfFile(path) };
  }

  it('inspects nothing and removes nothing without --attended', async () => {
    // Contract 1, and the ordering matters: the refusal happens before the
    // repository is resolved and before the lease is read, so an unattended
    // invocation never begins an inspection in order to say it was never going
    // to act.
    const fixture = await leasableRepository();
    const crashed = crashedLease(fixture, deadPid());

    await invoke([
      'break',
      '--repository',
      fixture.root,
      '--expected-revision',
      crashed.revision,
    ]);

    expect(process.exitCode).toBe(3);
    expect(stdout.join('')).toContain('Pass --attended');
    expect(existsSync(crashed.path)).toBe(true);
  });

  it('removes the lease an operator names, through the real probe', async () => {
    const fixture = await leasableRepository();
    const owner = deadPid();
    const crashed = crashedLease(fixture, owner);

    await invoke([
      'break',
      '--repository',
      fixture.root,
      '--attended',
      '--expected-revision',
      crashed.revision,
      '--owner-pid',
      String(owner),
    ]);

    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain('LEASE_REMOVED');
    expect(process.exitCode).toBe(0);
    expect(existsSync(crashed.path)).toBe(false);
    // The repository is runnable again, which is the entire purpose.
    expect(acquire(fixture, 'run-after-recovery').ok).toBe(true);
  });

  it('refuses a lease whose owner is this very process', async () => {
    // The same command, the same authorisation shape, a living owner. No probe
    // is injected anywhere on this path: the pid recorded is the pid running the
    // test, so `process.kill(pid, 0)` answers for itself.
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-live');
    const path = leasePathOf(fixture);
    const bytes = readFileSync(path);

    await invoke([
      'break',
      '--repository',
      fixture.root,
      '--attended',
      '--expected-revision',
      revisionOfFile(path),
      '--owner-pid',
      String(process.pid),
    ]);

    expect(stdout.join('')).toContain('LEASE_NOT_BREAKABLE');
    expect(stdout.join('')).toContain('OWNER_RUNNING');
    expect(process.exitCode).toBe(4);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('refuses an expected revision that is not one, before touching anything', async () => {
    const fixture = await leasableRepository();
    const crashed = crashedLease(fixture, deadPid());

    await invoke([
      'break',
      '--repository',
      fixture.root,
      '--attended',
      '--expected-revision',
      'not-a-digest',
    ]);

    expect(stdout.join('')).toContain('EXPECTED_REVISION_UNUSABLE');
    expect(process.exitCode).toBe(2);
    expect(existsSync(crashed.path)).toBe(true);
  });

  it('refuses a mistyped owner pid rather than reading it as none', async () => {
    // `--owner-pid 12x` is an operator who meant to name a process. Treating it
    // as "no pid was recorded" would authorise a break for a different class of
    // lease entirely — the crash-window artefact that names no owner.
    const fixture = await leasableRepository();
    const crashed = crashedLease(fixture, deadPid());

    await invoke([
      'break',
      '--repository',
      fixture.root,
      '--attended',
      '--expected-revision',
      crashed.revision,
      '--owner-pid',
      '12x',
    ]);

    expect(stdout.join('')).toContain('OWNER_PID_UNUSABLE');
    expect(process.exitCode).toBe(2);
    expect(existsSync(crashed.path)).toBe(true);
  });

  it('prints the break command status offered, with the revision already in it', async () => {
    // The two halves of the flow have to agree: what `status` prints is what
    // `break` accepts. A report offering a command the command refuses is worse
    // than no report.
    const fixture = await leasableRepository();
    const crashed = crashedLease(fixture, deadPid());

    await invoke(['status', '--repository', fixture.root]);
    const report = stdout.join('');

    expect(report).toContain(`--expected-revision ${crashed.revision}`);
    const offered = report.match(/--owner-pid (\d+)/);
    expect(offered).not.toBeNull();

    stdout = [];
    await invoke([
      'break',
      '--repository',
      fixture.root,
      '--attended',
      '--expected-revision',
      crashed.revision,
      '--owner-pid',
      offered?.[1] ?? '',
    ]);

    expect(stdout.join('')).toContain('LEASE_REMOVED');
    expect(existsSync(crashed.path)).toBe(false);
  });

  it('prints only ASCII, whichever way the break ended', () => {
    // Same reason the acquire vocabulary is held to it: this repository has
    // twice had text damaged by a re-encoding pass, and a destructive command's
    // report is the worst place for that.
    const all = Object.values(LEASE_BREAK_SENTENCES).join('');

    expect([...all].filter((character) => character.codePointAt(0)! > 0x7f)).toEqual([]);
  });

  it('has an exit code for every outcome, and no outcome shares 0 with a refusal', () => {
    for (const outcome of LEASE_BREAK_OUTCOMES) {
      const code = exitCodeForLeaseBreakOutcome(outcome);
      expect([0, 3, 4]).toContain(code);
      // The one thing a script must be able to tell apart: an invocation that
      // ended with the lease still there never exits 0.
      if (outcome !== 'LEASE_REMOVED' && outcome !== 'LEASE_ALREADY_GONE') {
        expect(code).not.toBe(0);
      }
    }
  });
});
