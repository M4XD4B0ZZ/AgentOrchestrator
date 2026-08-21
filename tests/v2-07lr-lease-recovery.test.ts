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
 *     the mechanism the whole recovery contract rests on. This header claimed no
 *     in-process seam distinguished it from a plain `unlink`; the body of this
 *     file now records why that is false — the `matches` predicate is the seam —
 *     and the two sat one file apart saying opposite things, which is the third
 *     time in this slice a correction was written without retiring the sentence
 *     it corrected.
 *
 *  3. **What is left where the attended break was.** It came back under a
 *     contract that named what had defeated it, and a sixth adversarial review
 *     broke that too — reproducing the removal of a *legitimately acquired*
 *     lease, and separately a rollback that deleted a competing acquirer's file
 *     with no identity check at all. It is withdrawn again, and this time on a
 *     finding about the contract rather than about an implementation: for the
 *     zero-byte crash artefact the digest is a shared constant, the record names
 *     no owner, and the object identity is a `(dev,ino)` pair on a module that
 *     ships fallbacks for filesystems which reuse those. There is no fact left to
 *     name the object with. See `src/lease/lease-recovery.ts`.
 *
 *     What remains here is the classification, and the pins that nothing in the
 *     build removes a lease it did not create.
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

import { PACKAGE_ROOT } from '../src/config/paths.js';
import type { ExecutionLeaseEvidence } from '../src/core/execution-lease-evidence.js';
import {
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  verifyExecutionLeaseHeld,
} from '../src/lease/execution-lease.js';
import { assessLeaseRecovery } from '../src/lease/lease-recovery.js';
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
      { git: runGitCommand, lease: evidence, base: { kind: 'DEFAULT_BRANCH_TIP' } },
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
      base: { kind: 'DEFAULT_BRANCH_TIP' },
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

  onWindows('refuses a root-relative Git common directory', () => {
    // The premise, asserted rather than asserted-about: without the extra check
    // this key passes the absolute test and a lease path is derived from it.
    //
    // "Root-relative", not "drive-relative": `\foo` is absolute within whichever
    // volume the process is standing on. The genuinely drive-relative form is
    // `C:foo`, and `isAbsolute` already refuses that one a few lines earlier —
    // so the two are caught by different guards and naming them alike sent a
    // reader to the wrong one.
    expect(isAbsolute('\\repo\\.git')).toBe(true);
    expect(isAbsolute('C:repo\\.git')).toBe(false);

    for (const key of ['\\repo\\.git', '/repo/.git', '\\', '/']) {
      const derived = deriveExecutionLeaseLocation({
        gitCommonDir: key,
        root: 'C:\\repo',
        id: 'root-relative',
      });
      expect(derived.ok).toBe(false);
      if (derived.ok) return;
      expect(derived.code).toBe('LEASE_LOCATION_UNSUITABLE');
    }
  });

  onWindows('still derives a location for the two shapes V2 supports', () => {
    // The control. A refusal broad enough to catch the root-relative case is a
    // refusal that can quietly catch every Windows path, and a suite without
    // this case would pass against one that refuses them all.
    //
    // This used to include a UNC key and assert it derived. V2-07P withdrew
    // that: UNC is network storage and is outside the support contract, so the
    // control now stands on the two drive-letter forms.
    for (const key of ['C:\\repo\\.git', '\\\\?\\C:\\repo\\.git']) {
      const derived = deriveExecutionLeaseLocation({
        gitCommonDir: key,
        root: 'C:\\repo',
        id: 'volume',
      });
      expect(derived.ok).toBe(true);
    }
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
   * puts it back — by `link`, or by an exclusive create where the filesystem has
   * no links. The rule is that the lease name is never touched by an operation
   * that can clobber; the shorter "never except through a `link`" this used to
   * copy from the source was falsified by the restore's own fallback.
   *
   * The claim that "no in-process seam distinguishes that from read-decide-unlink"
   * is dropped too, and it is the fourth untestability claim in this slice to turn
   * out wrong. The predicate *is* the seam: a successor acquired from inside it
   * reaches states — a restored stranger's record, a quarantined one, a refused
   * detach — that no name-aimed `unlink` can produce.
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

/* ──────── 3. what is left where the attended recovery used to be ────────── */

describe('classification says what is there and authorises nothing', () => {
  /**
   * `assessLeaseRecovery` survived the withdrawal, and the reason it survived is
   * the reason it was safe: it never authorised anything. What went with the
   * break is `breakable` — a field that *was* a permission, and that the renderer
   * read in order to print a ready-made destructive command.
   */
  it('classifies a stale lease as stale, and offers nothing to act on', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-stale');

    const assessed = assessLeaseRecovery(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    expect(assessed.classification).toBe('STALE_OWNER_GONE');
    // The assessment is a report, and it stays only a report. V3 slice 5 ships a
    // removal, so the sentence that used to carry this — "there is no removal to
    // take one" — is no longer the reason; the reason is now that
    // `recoverStaleLease` accepts no assessment and makes its own inside the
    // call that removes. `tests/v3-05-stale-lease-recovery.test.ts` pins that
    // directly, by changing the world between a caller's assessment and the
    // recovery and requiring the recovery to refuse.
    expect(Object.keys(assessed).sort()).toEqual([
      'classification',
      'containment',
      'inspection',
      'latestLaunchContained',
      'staleRecovery',
    ]);
    expect(assessed.containment).toBe('ABSENT');
    expect(assessed.latestLaunchContained).toBe(false);
    // And the verdict is `SAFE_TO_RECOVER`, which is worth stating here rather
    // than only in the slice-5 file — with the reason stated exactly, because the
    // convenient wording is the belief that produced a defect.
    //
    // The owner is **not** gone: it is this vitest worker, and it is running. What
    // satisfies the first conjunct is the substituted probe above, which this
    // *reporting* path lets a caller supply outright. What satisfies the second is
    // real: the fixture acquires, so the lease carries a complete launch history
    // with no launches in it, and a lease that never started a writer has nothing
    // that could have survived it.
    //
    // `recoverStaleLease` does not accept that probe. A round of this slice
    // shipped a version that did, and a review removed a living owner's lease
    // through it in one call.
    //
    // The point of this case is what did **not** move: `classification` is
    // `STALE_OWNER_GONE` either way. The description of what is at the path and
    // the decision about what may be done with it are two values, and the second
    // arriving did not change the first.
    expect(assessed.staleRecovery.verdict).toBe('SAFE_TO_RECOVER');
    expect(assessed.staleRecovery.launchHistory).toBe('ALL_LAUNCHES_CONTAINED');
  });

  it('classifies a running owner as running', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-live');

    const assessed = assessLeaseRecovery(fixture.repository, { processAlive: () => 'ALIVE' });

    expect(assessed.classification).toBe('OWNER_RUNNING');
  });

  it('classifies a free repository as having nothing to recover', async () => {
    const fixture = await leasableRepository();

    expect(assessLeaseRecovery(fixture.repository).classification).toBe('NOTHING_TO_RECOVER');
  });
});

describe('nothing in this build removes a lease it did not create', () => {
  it('offers no break, no force, no automatic and no unattended clearing', async () => {
    // The vocabulary is checked as well as the surface: a `--force` that exists
    // only in a help string is still a promise to an operator.
    const recovery = await import('../src/lease/lease-recovery.js');

    expect(
      Object.keys(recovery).filter((name) => /break|force|auto|clear|remove/i.test(name)),
    ).toEqual([]);

    // Declared options only. The words `--force` and `--unattended` appear all
    // over this build's prose, and every one of those occurrences says the thing
    // does not exist; what would be a promise is an option registered on a
    // command.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const declared = readFileSync(file, 'utf8').match(/\.option\(\s*['"][^'"]+['"]/g) ?? [];
      if (declared.some((option) => /force|unattended|adopt|takeover|steal/i.test(option))) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('registers no command that removes a lease', async () => {
    const { buildProgram } = await import('../src/cli/index.js');
    const names: string[] = [];
    const walk = (command: { name: () => string; commands: unknown[] }): void => {
      names.push(command.name());
      for (const child of command.commands) {
        walk(child as { name: () => string; commands: unknown[] });
      }
    };
    walk(buildProgram() as unknown as { name: () => string; commands: unknown[] });

    // Reached through the real program rather than by reading source, because
    // the thing an operator can run is the thing that matters. `break` is the
    // name that has now been registered and withdrawn twice.
    expect(names).not.toContain('break');
  });

  it('leaves the guarded removal reachable from nowhere outside its own module', () => {
    // This pin used to expect `lease-recovery.ts`, because that module held the
    // break. With the break withdrawn, `removeVerifiedLease` has no caller at
    // all outside its own module: the three that remain are the two acquire
    // rollbacks and `release`, all inside `execution-lease.ts`. A module
    // appearing here is a second one claiming the right to remove a lease.
    //
    // Comments are stripped before the scan, and that distinction earned itself
    // immediately: `lease-recovery.ts` still *names* the function in the
    // paragraph explaining why the break cannot be written, and a scan that
    // counted prose would report the module as a caller. What this measures is
    // reachability. Explaining a mechanism is not importing it — and a pin that
    // forbade the explanation would push the reasoning out of the file that
    // needs it most.
    const callers: string[] = [];
    for (const file of sourceFiles()) {
      if (file.endsWith(join('lease', 'execution-lease.ts'))) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[^\n]*\/\/.*$/gm, '');
      if (/\bremoveVerifiedLease\b/.test(code)) callers.push(relative(PACKAGE_ROOT, file));
    }
    expect(callers.sort()).toEqual([]);
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
