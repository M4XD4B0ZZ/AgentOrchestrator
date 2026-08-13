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
import { tmpdir } from 'node:os';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  LEASE_ACQUIRE_SENTENCES,
  LEASE_LIVENESS_SENTENCES,
  LEASE_STATE_SENTENCES,
  renderLeaseRefusal,
  renderLeaseStatus,
} from '../src/cli/render-lease.js';
import { RELEASE_OUTCOME_SENTENCES } from '../src/cli/release-command.js';
import { START_OUTCOME_SENTENCES } from '../src/cli/render-attended-run.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import {
  isExecutionLeaseEvidence,
  type ExecutionLeaseEvidence,
} from '../src/core/execution-lease-evidence.js';
import {
  EXECUTION_LEASE_FILE_NAME,
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  verifyExecutionLeaseHeld,
  verifyExecutionLeaseHeldFor,
  type LeaseInspection,
} from '../src/lease/execution-lease.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { releaseTaskWorkspace } from '../src/run/release-workspace.js';
import { runTask } from '../src/run/run-driver.js';
import { startTask } from '../src/run/start-task.js';
import { advanceTaskState } from '../src/state/advance-state.js';
import { loadTaskState } from '../src/state/state-store.js';
import {
  exitCodeForReleaseOutcome,
  exitCodeForRunOutcome,
  exitCodeForStartOutcome,
} from '../src/cli/run-exit-codes.js';
import { runImplementStep, runLoopStep, runVerifyStep } from '../src/loop/loop-step.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';
import { prepareTaskWorkspace } from '../src/worktree/prepare-workspace.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { removeTaskWorkspace } from '../src/worktree/remove-workspace.js';
import { authPreflightPasses, provenAuthEvidence } from './helpers/auth-evidence.js';
import { createRepoFixture, git, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { e2eProfile, taskFile, tickingClock, writerSuccess } from './helpers/e2e-fixtures.js';
import { leaseAuthorityAt, releaseTestLeases } from './helpers/lease.js';
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

/**
 * Every production module that can reach `name` from the internal evidence
 * module, by any static route.
 *
 * Named imports are the obvious one and were the only route the first version of
 * these pins saw. A review demonstrated three more that walked straight past it —
 * a namespace import, an awaited dynamic import, and `export … from`. A *second*
 * review then found this comment already claiming to refuse a computed specifier
 * while the function did no such thing: `import(a + b)`, `import(parts.join('/'))`
 * and `createRequire` all reached the mint. Both halves are now true.
 *
 * Reaching the mint is total, which is why the care is warranted: the nonce is
 * written into the lease file and is not a secret, so
 * `mintExecutionLeaseEvidence(stolenNonce, victimPath)` is full authority over a
 * repository somebody else holds.
 *
 * What no importer pin can ever catch is the forgery that imports nothing at
 * all: `Object.create(Object.getPrototypeOf(realEvidence), …)`. That one is
 * closed in the artefact itself — the brand check reads a private field instead
 * of walking a prototype chain — and this pin is deliberately not asked to carry
 * it. The case below it does.
 */
function reachesInternalEvidence(name: string): string[] {
  const declaringModule = join(PACKAGE_ROOT, 'src', 'core', 'internal', 'execution-lease-evidence.ts');
  const importers: string[] = [];
  for (const file of sourceFiles()) {
    // The module that declares the class does not import it, and a pattern loose
    // enough to span an unrelated `import` line and the `export class` below it
    // would count it as its own importer — noise that hides the signal.
    if (file === declaringModule) continue;
    const text = readFileSync(file, 'utf8');
    const namesTheModule = /['"][^'"]*internal\/execution-lease-evidence\.js['"]/.test(text);
    // Tied to the specifier. Without that this branch matched any file with an
    // `import` and the name anywhere in it, so it both over- and under-matched.
    const named =
      namesTheModule &&
      new RegExp(
        String.raw`import[\s\S]{0,400}?\{[\s\S]{0,400}?${name}[\s\S]{0,400}?\}`,
      ).test(text);
    const indirect =
      namesTheModule &&
      (/import\s*\*\s*as\s+\w+/.test(text) ||
        /import\s*\(/.test(text) ||
        /export\s*(\*|\{[^}]*\})\s*from/.test(text));
    // A specifier this scan cannot resolve. `import(a + b)`,
    // `import(parts.join('/'))` and `createRequire(...)` all reach the mint at
    // runtime while naming nothing statically — a review demonstrated all three
    // walking past the previous version of this pin, whose own comment claimed
    // it refused them. Nothing can resolve these, so they are refused outright.
    const unresolvable =
      /import\s*\(\s*[^'")\s]/.test(text) || /createRequire/.test(text);
    if (named || indirect || unresolvable) importers.push(relative(PACKAGE_ROOT, file));
  }
  return importers.sort();
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
    // Every route, not just the named import: a review showed the first version
    // of this pin missing namespace imports, dynamic imports and re-exports.
    // The lease store is the only producer. The public wrapper names the class,
    // for the brand check, and never the mint — so a caller importing the public
    // module gets nothing it can construct with.
    expect(reachesInternalEvidence('mintExecutionLeaseEvidence')).toEqual([
      join('src', 'lease', 'execution-lease.ts'),
    ]);
  });

  it('has the class itself reachable from only the two modules that need it', () => {
    // The mint is not the only way to get one. A *subclass* carries the private
    // field through `super(…)`, so a module that can reach `ExecutionLeaseProof`
    // can construct evidence for any path it likes — and pinning the mint's
    // importers never sees that, because it never mentions the mint.
    //
    // Two modules may name the class, and each for a stated reason: the public
    // wrapper, which needs it for the brand check and exports only a type alias;
    // and the lease store, which reads the private fields through the statics.
    // Neither exposes a constructor.
    expect(reachesInternalEvidence('ExecutionLeaseProof')).toEqual([
      join('src', 'core', 'execution-lease-evidence.ts'),
      join('src', 'lease', 'execution-lease.ts'),
    ]);
  });

  it('cannot be forged by an object that only borrows the prototype', () => {
    // The route no reachability pin can ever catch, because it imports nothing:
    // one genuine artefact — which every writer already receives as a parameter —
    // plus `Object.create`, with own properties shadowing the prototype's
    // members. Against the previous `instanceof` gate this passed everything and
    // released a rightful owner's lease.
    //
    // It fails now because the gate reads a private field the prototype does not
    // carry, and because the artefact exposes no instance members left to shadow.
    const genuine = leaseAuthorityAt(
      mkdtempSync(join(tmpdir(), 'ao-forge-')),
    ).evidence;
    expect(isExecutionLeaseEvidence(genuine)).toBe(true);

    const borrowed = Object.create(Object.getPrototypeOf(genuine) as object, {
      leasePath: { value: 'C:/somewhere/else/agent-orchestrator-execution-lease.json' },
      matchesRecordedNonce: { value: () => true },
    }) as unknown;

    // The prototype's `constructor` is deleted, so this resolves up the chain to
    // `Object` — which is the point. An earlier version asserted
    // `borrowed instanceof proto.constructor` to show the forgery still passed a
    // prototype test; once `constructor` was removed, that line asserted only
    // that an object is an Object while still reading as a real check.
    expect((Object.getPrototypeOf(genuine) as object).constructor).toBe(Object);
    expect(isExecutionLeaseEvidence(borrowed)).toBe(false);
    expect(verifyExecutionLeaseHeld(borrowed).code).toBe('EVIDENCE_INVALID');
    expect(releaseRepositoryExecutionLease(borrowed).code).toBe('EVIDENCE_INVALID');
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

    // Captured *before* the stale release, because that is the only way the
    // comparison below means anything.
    //
    // This read the same file twice and compared the results —
    // `expect(revisionOfFile(p)).toBe(revisionOfFile(p))` — which is true of any
    // file, including one the stale release had just rewritten or deleted. A
    // review proved the cost: with `releaseRepositoryExecutionLease` mutated to
    // destroy the successor's record while still answering `NOT_OWNER`, the
    // whole suite passed. The one property this test exists for was untested.
    const before = revisionOfFile(second.path);

    const stale = releaseRepositoryExecutionLease(first);

    expect(stale.code).toBe('NOT_OWNER');
    expect(existsSync(second.path)).toBe(true);
    expect(revisionOfFile(second.path)).toBe(before);
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

  it('reads one lease file the same way every other consumer does', async () => {
    // Three readers, one answer. `lease status` and `break` refuse a document
    // whose recorded `leaseKey` names somewhere else; the driver's authority
    // gate used to call the same file `HELD`, because it compared only the
    // nonce. One file meaning two things is the shape that decides who may
    // write, so it is pinned rather than left to coincidence.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture, 'run-0001');
    const path = inspectRepositoryExecutionLease(fixture.repository).path;

    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      path,
      `${JSON.stringify({ ...document, leaseKey: join(fixture.root, 'somewhere-else') }, null, 2)}\n`,
      'utf8',
    );

    expect(inspectRepositoryExecutionLease(fixture.repository).state).toBe('UNPARSEABLE');
    expect(verifyExecutionLeaseHeldFor(fixture.repository, evidence).code).toBe('NOT_OWNER');
  });

  it('refuses a genuine, current lease that belongs to another repository', async () => {
    // Found by the adversarial review, and it is the finding that most deserved
    // to exist: nothing here was forged. A real lease over repository E
    // satisfied the gate for a mutation of repository T, because the check only
    // ever asked "is the file this artefact names still mine" and never "is that
    // this repository's file". T then got a branch, a worktree, durable writes
    // and a spawned agent while T's own lease sat free for a rightful holder to
    // take — the exact split-brain the module exists to prevent.
    //
    // Unreachable from the CLI, which acquires for the repository it then acts
    // on. That is convention carrying the guarantee, in a slice whose whole
    // argument is that evidence exists to replace convention — and V2-08, one
    // lease threaded into several per-task calls, is precisely the shape that
    // breaks it.
    const elsewhere = await leasableRepository();
    const target = await leasableRepository();
    const foreign = heldLease(elsewhere);

    // Genuine, current, and held — just not here.
    expect(verifyExecutionLeaseHeld(foreign).code).toBe('HELD');
    expect(verifyExecutionLeaseHeldFor(elsewhere.repository, foreign).code).toBe('HELD');
    expect(verifyExecutionLeaseHeldFor(target.repository, foreign).code).toBe(
      'LEASE_FOR_ANOTHER_REPOSITORY',
    );

    const started = await startTask(
      { repository: target.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: foreign,
      },
    );

    expect(started.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(started.reasonCodes).toContain('LEASE_FOR_ANOTHER_REPOSITORY');
    expect(loadTaskState(target.root, TASK_ID).classification).toBe('STATE_MISSING');
    expect(started.workspace).toBeNull();

    const released = await releaseTaskWorkspace(target.repository, TASK_ID, {
      git: runGitCommand,
      lease: foreign,
    });
    expect(released.outcome).toBe('EXECUTION_LEASE_NOT_HELD');

    const run = await runTask(
      {
        repository: target.repository,
        taskId: TASK_ID,
        taskBrief: TASK_ID,
        attendedContinuation: true,
        authEvidence: provenAuthEvidence(),
        lease: foreign,
        maxSteps: 4,
      },
      { now: tickingClock(), git: runGitCommand },
    );
    expect(run.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(run.steps).toBe(0);
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

/* ───────── 6b. authority is proved at the write, not at the step ────────── */

describe('no durable transition happens after the lease is lost', () => {
  /**
   * A task at `WORKTREE_READY`, started for real, ready to be advanced.
   *
   * The transitions under test are the ones `runLoopStep` reaches *after* a long
   * effect, so what matters is that the state and the lease are genuine: the
   * check is in `advanceTaskState`, which every one of them passes through.
   */
  async function startedTask(): Promise<{
    readonly fixture: Fixture;
    readonly evidence: ExecutionLeaseEvidence;
  }> {
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');
    return { fixture, evidence };
  }

  function advanceTo(
    fixture: Fixture,
    evidence: ExecutionLeaseEvidence,
    state: 'CONTEXT_LOADING',
  ): ReturnType<typeof advanceTaskState> {
    const load = loadTaskState(fixture.root, TASK_ID);
    if (!load.ok) throw new Error('the task did not start');
    return advanceTaskState(
      load,
      { ...load.state, state, stateEnteredAt: '2026-08-12T12:00:00.000Z' },
      {
        lease: { repository: fixture.repository, evidence },
      },
    );
  }

  it('refuses the write when the lease was removed during the step', async () => {
    const { fixture, evidence } = await startedTask();
    const before = readFileSync(join(fixture.root, '.agent-orchestrator', 'runtime', `${TASK_ID}.json`));

    // The long effect happened; the lease did not survive it.
    expect(releaseRepositoryExecutionLease(evidence).code).toBe('RELEASED');

    const advanced = advanceTo(fixture, evidence, 'CONTEXT_LOADING');

    expect(advanced.ok).toBe(false);
    if (advanced.ok) return;
    expect(advanced.code).toBe('EXECUTION_LEASE_LOST');
    expect(advanced.detail).toBe('LEASE_ABSENT');
    // Byte-identical: a refused move writes nothing at all.
    expect(readFileSync(join(fixture.root, '.agent-orchestrator', 'runtime', `${TASK_ID}.json`))).toEqual(
      before,
    );
  });

  it('refuses the write when a different valid lease replaced it', async () => {
    const { fixture, evidence } = await startedTask();
    expect(releaseRepositoryExecutionLease(evidence).code).toBe('RELEASED');
    // A successor legitimately holds the repository now. The old writer must not
    // read somebody else's authority as its own.
    const successor = acquire(fixture, 'run-successor');
    expect(successor.ok).toBe(true);

    const advanced = advanceTo(fixture, evidence, 'CONTEXT_LOADING');

    expect(advanced.ok).toBe(false);
    if (advanced.ok) return;
    expect(advanced.code).toBe('EXECUTION_LEASE_LOST');
    expect(advanced.detail).toBe('NOT_OWNER');
  });

  it('still advances normally while the lease is held', async () => {
    // The control. A gate strong enough to refuse a lost lease is a gate that
    // can quietly make the legitimate case unreachable, and a suite without this
    // case would pass just as well against one that always refuses.
    const { fixture, evidence } = await startedTask();

    const advanced = advanceTo(fixture, evidence, 'CONTEXT_LOADING');

    expect(advanced.ok).toBe(true);
    const reloaded = loadTaskState(fixture.root, TASK_ID);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.state.state).toBe('CONTEXT_LOADING');
  });

  it('is proved against the file, never from a value read earlier', async () => {
    // Two moves with one authority value: the first succeeds, the lease then
    // goes, and the second must refuse. A check cached at the start of the step
    // — or anywhere but the write — would let the second one through.
    const { fixture, evidence } = await startedTask();
    const authority = { repository: fixture.repository, evidence };

    const first = advanceTo(fixture, evidence, 'CONTEXT_LOADING');
    expect(first.ok).toBe(true);

    expect(releaseRepositoryExecutionLease(evidence).code).toBe('RELEASED');

    const load = loadTaskState(fixture.root, TASK_ID);
    if (!load.ok) throw new Error('unreadable after the first move');
    const second = advanceTaskState(
      load,
      { ...load.state, state: 'IMPLEMENTING', stateEnteredAt: '2026-08-12T12:01:00.000Z' },
      { lease: authority },
    );

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('EXECUTION_LEASE_LOST');
  });

  it('still catches a loss between iterations at the driver gate', async () => {
    // The two gates are not duplicates. This one answers "may this iteration
    // begin at all"; the one above answers "does this writer still have
    // authority after the long effect". A loss between iterations must be
    // caught before anything is reconciled or spawned.
    const { fixture, evidence } = await startedTask();
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
    expect(run.reasonCodes).toContain('LEASE_ABSENT');
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

/* ──────────── 8. there is no productive way to clear a lease ────────────── */

describe('lease status reports a stale lease without offering to clear it', () => {
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

  it('recovers the owner of a lease written by a build it cannot parse', async () => {
    // A newer `schemaVersion`, or a field this build's `.strict()` schema does
    // not know, is a perfectly well-formed lease with a possibly *running*
    // owner. Reporting `UNKNOWABLE` for it is what once walked an operator into
    // clearing a healthy run, so the owner is recovered from the bytes and its
    // liveness reported — for diagnosis only; nothing acts on it.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const path = inspectRepositoryExecutionLease(fixture.repository).path;
    releaseRepositoryExecutionLease(evidence);
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 2,
        leaseKey: fixture.repository.gitCommonDir,
        repositoryRoot: fixture.repository.root,
        repositoryId: fixture.repository.id,
        ownerPid: process.pid,
        ownerNonce: 'a'.repeat(64),
        acquiredAt: '2026-08-12T10:00:00.000Z',
        runId: 'run-from-a-newer-build',
        blockId: null,
      })}\n`,
      'utf8',
    );

    const status = inspectRepositoryExecutionLease(fixture.repository);

    expect(status.state).toBe('UNPARSEABLE');
    expect(status.ownerPid).toBe(process.pid);
    expect(status.liveness).toBe('ALIVE');
  });

  it('offers recovery only for an owner that is not running', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-0009');

    const live = renderLeaseStatus(inspectRepositoryExecutionLease(fixture.repository), false);
    const stale = renderLeaseStatus(
      inspectRepositoryExecutionLease(fixture.repository, { processAlive: () => 'NOT_FOUND' }),
      true,
    );

    // Nothing to recover from while somebody is running, and printing a break
    // command beside a healthy run is how a healthy run gets cleared.
    //
    // V2-07LR replaced the manual procedure this used to print with an attended
    // command; what did not change is *when* it is printed at all.
    expect(live).not.toContain('lease break');
    expect(stale).toContain('agent-loop lease break');
    expect(stale).toContain('--attended');
    // And still no bypass, in either report.
    expect(live).not.toContain('--force');
    expect(stale).toContain('no --force');
  });
});

describe('the owner-only release stays owner-only, whatever recovery exists beside it', () => {
  /**
   * V2-07L withdrew the attended break; V2-07LR brought it back under a contract
   * written from what defeated it, and this describe is what survives of the
   * withdrawal.
   *
   * The withdrawal's own assertions — no break subcommand, no break vocabulary,
   * no mention in the source — were pins on an *absence*, and the absence was a
   * decision this repository has since taken again, deliberately, with the
   * counter-proofs in `tests/v2-07lr-lease-recovery.test.ts` behind it. What was
   * never up for revision is below: `release` remains the owner's operation, and
   * it remains the one that cannot name a victim.
   */
  it('keeps the release owner-bound, with nothing for a caller to name', async () => {
    const lease = await import('../src/lease/execution-lease.js');

    // It takes only the evidence, so there is no path, no run id and no owner id
    // to supply. A caller holding somebody else's identifiers has nothing this
    // function accepts.
    expect(typeof lease.releaseRepositoryExecutionLease).toBe('function');
    expect(lease.releaseRepositoryExecutionLease.length).toBe(1);
    // And the lease module itself still exports no takeover of any kind: the
    // one destructive primitive it exports is `removeVerifiedLease`, whose whole
    // argument is the predicate that identifies what may be removed.
    expect(Object.keys(lease).filter((name) => /force|takeover|steal/i.test(name))).toEqual([]);
  });

  it('registers the read-only subcommand beside the attended one, and nothing else', async () => {
    const { buildProgram } = await import('../src/cli/index.js');
    const lease = buildProgram()
      .commands.find((command) => command.name() === 'lease');

    expect(lease).toBeDefined();
    expect(lease?.commands.map((command) => command.name()).sort()).toEqual(['break', 'status']);
  });

  it('names no command in the shipped source that does not exist', () => {
    // A sentence is an interface too. An operator who reads "clear it with
    // `agent-loop lease clear`" in a refusal will go looking for a command that
    // does not exist, and a maintainer will read it as a feature that regressed.
    // `lease break` is now among the commands that do exist; nothing else is.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (/agent-loop lease (clear|force|takeover)/.test(readFileSync(file, 'utf8'))) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
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
      ...Object.values(LEASE_STATE_SENTENCES),
      ...Object.values(LEASE_LIVENESS_SENTENCES),
    ].join('');

    expect([...all].filter((character) => character.codePointAt(0)! > 0x7f)).toEqual([]);
  });

  it('tells an operator what recovering a stale lease requires of them', async () => {
    const fixture = await leasableRepository();
    heldLease(fixture, 'run-0009');
    const inspection = inspectRepositoryExecutionLease(fixture.repository, {
      processAlive: () => 'NOT_FOUND',
    });

    const report = renderLeaseStatus(inspection, true);

    // The path, because they cannot act without it — and the judgement they
    // have to make, because the tool cannot make it for them. What changed in
    // V2-07LR is only the last step: the manual deletion this used to spell out
    // is now a command, and the race it used to warn about is closed by the
    // command rather than left to the operator's care.
    expect(report).toContain(inspection.path);
    expect(report).toContain('no orchestrator process and no agent process');
    // The command, complete: an operator can run this line.
    expect(report).toContain('agent-loop lease break --repository <path> --attended');
    expect(report).toContain(`--expected-revision ${inspection.revision ?? ''}`);
    expect(report).toContain(`--owner-pid ${String(inspection.ownerPid)}`);
    expect(report).toContain('no --force');
    // The ABA hazard, and what is now done about it.
    //
    // Pinned as whole sentences rather than by keyword, for the reason the
    // previous version of this test recorded: the shipped text once lost a
    // single word — "that race is exactly why this is a command", in a block
    // whose purpose was to say no command existed — and every keyword assertion
    // passed while it did. A negation is what a keyword search cannot check.
    expect(report).toContain(
      'released\n  and legitimately re-acquired in the meantime is left alone rather than destroyed',
    );
    expect(report).toContain('Nothing is removed on a revision you did not see');
  });

  it('never suggests a break for a repository nobody owns', async () => {
    const fixture = await leasableRepository();

    const report = renderLeaseStatus(inspectRepositoryExecutionLease(fixture.repository), false);

    expect(report).not.toContain('lease break');
  });
});

/* ──────────── 10. the block store stays inside a leased run scope ────────── */

describe('the ledger store gains no productive caller outside a leased run', () => {
  /** Every production module that imports any of `names` by any static route. */
  function productionImportersOf(names: readonly string[]): string[] {
    const alternation = names.join('|');
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      const reaches =
        // a named import, alone or among others, on one line or several
        new RegExp(`import[\\s\\S]{0,400}?\\{[\\s\\S]{0,400}?\\b(${alternation})\\b[\\s\\S]{0,400}?\\}`).test(text) ||
        // a namespace import of the module, which a named-import scan misses
        /import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*block-(store|progress)\.js['"]/.test(text) ||
        // a dynamic import of it, likewise
        /await\s+import\(\s*['"][^'"]*block-(store|progress)\.js['"]/.test(text) ||
        // and a re-export, which would hand the names on without importing them
        /export\s+\*\s+from\s+['"][^'"]*block-(store|progress)\.js['"]/.test(text);
      if (reaches) importers.push(relative(PACKAGE_ROOT, file));
    }
    return importers.sort();
  }

  it('has its mutating functions imported by no other production module', () => {
    // The lease guarantee is **run-scoped**: V2-08 must hold one lease across a
    // whole block run and perform its ledger writes underneath it. A per-write
    // lease parameter would misstate that, so the store keeps its signature —
    // and this is what stops a productive caller appearing without the decision
    // being made. `block-progress.ts` is the sanctioned in-layer caller; a
    // runner, a CLI command or a driver reaching the store directly breaks here.
    expect(productionImportersOf(['createBlockLedger', 'updateBlockLedger'])).toEqual([
      join('src', 'block', 'block-progress.ts'),
    ]);
  });

  it('pins the sanctioned progress layer too, which is what a runner would call', () => {
    // The store pin alone was one layer too low, and the adversarial review said
    // so. `block-progress.ts` is the API a V2-08 runner is *meant* to use — six
    // functions that each write a ledger — and nothing stopped a productive
    // module importing it from outside a leased run scope. Pinning the store
    // while leaving its own sanctioned caller open guards the door nobody was
    // going to use.
    //
    // Zero production importers today, because the block layer has no productive
    // caller at all. The point is that gaining one has to be a decision: this
    // fails the moment a runner appears, and closing it means threading the
    // lease through that runner rather than editing this list.
    expect(
      productionImportersOf([
        'startBlockRun',
        'activateBlockTask',
        'settleBlockTask',
        'parkBlockTask',
        'abandonBlockTask',
        'stopBlockRun',
      ]),
    ).toEqual([]);
  });
});

/* ─────────── 11. the gate is at the effect, not near it ─────────────────── */

describe('a mutation never happens on a lease proved somewhere earlier', () => {
  it('creates no branch and no worktree once the lease is gone', async () => {
    // `startTask` proves the lease, then spends six Git subprocesses — measured
    // at 383 ms — reaching `git worktree add`. A review released the lease inside
    // that window and watched a branch and a worktree land while a *successor*
    // legitimately held the repository. So the proof moved into
    // `prepareTaskWorkspace`, immediately before the first statement that
    // changes anything.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    const prepared = await prepareTaskWorkspace(
      fixture.repository,
      taskWithId(TASK_ID),
      {
        git: async (cwd, args) => {
          // Gone before the create, and after every question the preparation
          // asks — which is exactly the window that was open.
          releaseRepositoryExecutionLease(evidence);
          return runGitCommand(cwd, args);
        },
        lease: evidence,
      },
    );

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe('EXECUTION_LEASE_NOT_HELD');
    // Nothing was created: no branch, and no directory.
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
  });

  it('stops the run on the iteration that loses the lease', async () => {
    // ── What this does and does not prove ─────────────────────────────────
    //
    // It was called "starts no agent once the lease is gone" and asserted
    // exactly that — about a run whose first iteration parks at
    // `WORKTREE_READY`, a phase that starts nothing at all. The assertion was
    // therefore true of the fixed build and of a build with no agent fence
    // whatsoever, which a review demonstrated: deleting the guard at the agent
    // seam passed this test and the entire suite.
    //
    // The name and the spawn count are gone. What is left is the property this
    // actually measures and which is worth measuring: the driver notices the
    // loss on its own gate and ends the run as `EXECUTION_LEASE_LOST` rather
    // than continuing. The agent seam has its own counter-proof, driven to
    // `IMPLEMENTING`, in the section below.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');

    const run = await runTask(
      {
        repository: fixture.repository,
        taskId: TASK_ID,
        taskBrief: TASK_ID,
        attendedContinuation: true,
        authEvidence: provenAuthEvidence(),
        lease: evidence,
        maxSteps: 6,
      },
      {
        now: tickingClock(),
        // The lease dies during the reconciliation of the first iteration.
        git: async (cwd, args) => {
          releaseRepositoryExecutionLease(evidence);
          return runGitCommand(cwd, args);
        },
      },
    );

    expect(run.outcome).toBe('EXECUTION_LEASE_LOST');
    // Nothing durable moved: the state is still where `startTask` left it.
    const after = loadTaskState(fixture.root, TASK_ID);
    expect(after.ok && after.state.state).toBe('WORKTREE_READY');
  });

  it('does not call a release that lost the lease midway a release', async () => {
    // `removeTaskWorkspace` proves the lease before `worktree remove` and again
    // before `branch -d`. Losing it between the two spares the branch — and the
    // result used to be `RELEASED_BRANCH_KEPT` at exit 0, which is nominal and
    // invites an operator to delete the branch by hand. On disk it is identical
    // to a branch Git refused to delete; in what it asks of a human it is the
    // opposite.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const crashed = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        replace: () => {
          throw new Error('simulated crash before the first durable write landed');
        },
      },
    );
    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');

    const released = await releaseTaskWorkspace(fixture.repository, TASK_ID, {
      git: async (cwd, args) => {
        const result = await runGitCommand(cwd, args);
        // Gone the instant the worktree is removed, i.e. between the two
        // destructive commands.
        if (args[0] === 'worktree' && args[1] === 'remove') {
          releaseRepositoryExecutionLease(evidence);
        }
        return result;
      },
      lease: evidence,
    });

    expect(released.outcome).toBe('EXECUTION_LEASE_LOST');
    expect(released.worktreeRemoved).toBe(true);
    // The branch survives, and the outcome says why — which is the whole point.
    expect(released.branchRemoved).toBe(false);
    expect(released.reasonCodes).toContain('WORKSPACE_REMOVAL_LOST_LEASE');
    expect(exitCodeForReleaseOutcome(released.outcome)).toBe(3);
  });
});

/* ─────────── 12. the rollback is an effect too ──────────────────────────── */

describe('a failed preparation does not delete on a lease it no longer holds', () => {
  it('removes nothing once the lease is gone, and says so', async () => {
    // The creation gate was moved to the effect this round; the *undo* was left
    // where it was. `rollBack` runs `worktree remove` and `branch -d`, and the
    // nearest proof was the creation gate — with `git worktree add` and the six
    // probes of `verifyWorkspaceMatches` in between. That is a wider window than
    // the one judged unacceptable for creation, on the two commands
    // `remove-workspace.ts` gates individually.
    //
    // A review drove it: lose the lease after `worktree add`, let a successor
    // acquire and adopt the pristine orphan, then fail verification. Both
    // destructive commands ran and destroyed a workspace the successor owned.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    const destructive: string[] = [];
    let added = false;
    const prepared = await prepareTaskWorkspace(fixture.repository, taskWithId(TASK_ID), {
      git: async (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') destructive.push('worktree remove');
        if (args[0] === 'branch' && args[1] === '-d') destructive.push('branch -d');
        const result = await runGitCommand(cwd, args);
        if (args[0] === 'worktree' && args[1] === 'add') {
          added = true;
          // The window: the workspace now exists, and this run stops being the
          // repository's writer before anything verifies it.
          releaseRepositoryExecutionLease(evidence);
        }
        // Fail the verification that follows, which is what calls the rollback.
        if (added && args[0] === 'rev-parse') {
          return Object.freeze({
            outcome: 'OK' as const,
            exitCode: 0,
            signal: null,
            stdout: '0000000000000000000000000000000000000000',
            stderr: '',
            outputTruncated: false,
            failureCode: null,
            errnoCode: null,
            durationMs: 0,
          });
        }
        return result;
      },
      lease: evidence,
    });

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    // Nothing was deleted, because deleting is an effect and the authority for
    // it was gone.
    expect(destructive).toEqual([]);
    expect(prepared.code).toBe('WORKTREE_ROLLBACK_NOT_AUTHORISED');
    // And the leftovers are declared. A successor may legitimately own them now,
    // so the one thing this must not do is stay quiet about them.
    expect(prepared.residue).toBe(true);
  });

  it('stops between the two destructive commands, not after them', async () => {
    // Losing it *between* `worktree remove` and `branch -d` is the same argument
    // one command later, and it is why the gate is per command rather than once
    // at the top of the rollback.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    let added = false;
    const destructive: string[] = [];
    const prepared = await prepareTaskWorkspace(fixture.repository, taskWithId(TASK_ID), {
      git: async (cwd, args) => {
        if (args[0] === 'branch' && args[1] === '-d') destructive.push('branch -d');
        const result = await runGitCommand(cwd, args);
        if (args[0] === 'worktree' && args[1] === 'add') added = true;
        if (args[0] === 'worktree' && args[1] === 'remove') {
          destructive.push('worktree remove');
          releaseRepositoryExecutionLease(evidence);
        }
        if (added && args[0] === 'rev-parse') {
          return Object.freeze({
            outcome: 'OK' as const,
            exitCode: 0,
            signal: null,
            stdout: '0000000000000000000000000000000000000000',
            stderr: '',
            outputTruncated: false,
            failureCode: null,
            errnoCode: null,
            durationMs: 0,
          });
        }
        return result;
      },
      lease: evidence,
    });

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(destructive).toEqual(['worktree remove']);
    expect(prepared.code).toBe('WORKTREE_ROLLBACK_NOT_AUTHORISED');
    expect(prepared.residue).toBe(true);
  });

  it('rolls back normally while the lease is held', async () => {
    // The control. A gate that refuses everything would pass both tests above
    // and break the product, so this pins that a held lease still cleans up.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    let added = false;
    const prepared = await prepareTaskWorkspace(fixture.repository, taskWithId(TASK_ID), {
      git: async (cwd, args) => {
        const result = await runGitCommand(cwd, args);
        if (args[0] === 'worktree' && args[1] === 'add') added = true;
        if (added && args[0] === 'rev-parse') {
          return Object.freeze({
            outcome: 'OK' as const,
            exitCode: 0,
            signal: null,
            stdout: '0000000000000000000000000000000000000000',
            stderr: '',
            outputTruncated: false,
            failureCode: null,
            errnoCode: null,
            durationMs: 0,
          });
        }
        return result;
      },
      lease: evidence,
    });

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe('WORKTREE_VERIFICATION_FAILED');
    expect(prepared.residue).toBe(false);
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
  });
});

/* ─────────── 13. the spawn fence, at a phase that actually spawns ──────── */

describe('the agent seam refuses to start a process without the lease', () => {
  it('starts no writing agent in IMPLEMENTING once the lease is gone', async () => {
    // The previous counter-proof for this was vacuous and a review said so: it
    // asserted "no agent ran" about a run that stopped at `WORKTREE_READY`, a
    // phase that starts nothing. Removing the guard at the agent seam passed the
    // whole suite. This one drives the task to `IMPLEMENTING`, which starts the
    // writer, and fails with the guard removed.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');

    let current = loadTaskState(fixture.root, TASK_ID);
    if (!current.ok) throw new Error('task did not start');
    const authority = { repository: fixture.repository, evidence };
    for (const expected of ['CONTEXT_LOADING', 'IMPLEMENTING'] as const) {
      const advanced = await runLoopStep(current, {
        now: tickingClock()(),
        authorisedWorktreePath: current.state.worktreePath,
        verification: fixture.repository.verification,
        taskBrief: TASK_ID,
        brief: readExecutionBrief(fixture.repository, TASK_ID, current.state.worktreePath),
        lease: authority,
      });
      expect(advanced.state).toBe(expected);
      current = loadTaskState(fixture.root, TASK_ID);
      if (!current.ok) throw new Error('state vanished');
    }
    expect(current.state.state).toBe('IMPLEMENTING');

    // The lease goes now — after the task is parked in the phase that starts the
    // writer, and before the step that would start it.
    releaseRepositoryExecutionLease(evidence);

    let agentSpawns = 0;
    const step = await runLoopStep(current, {
      now: tickingClock()(),
      authorisedWorktreePath: current.state.worktreePath,
      verification: fixture.repository.verification,
      taskBrief: TASK_ID,
      brief: readExecutionBrief(fixture.repository, TASK_ID, current.state.worktreePath),
      lease: authority,
      agent: async () => {
        agentSpawns += 1;
        throw new Error('a writing agent must not be started without the lease');
      },
    });

    // The seam refused, so the process never started.
    expect(agentSpawns).toBe(0);
    // And nothing durable was recorded about a step that did not happen.
    expect(step.outcome).toBe('STATE_NOT_RECORDED');
    const after = loadTaskState(fixture.root, TASK_ID);
    expect(after.ok && after.state.state).toBe('IMPLEMENTING');
  });
});

/* ─────────── 15. the shapes Git actually produces are all runnable ──────── */

describe('a working tree Git resolves is one Git resolves, not one of three', () => {
  /** The repository record `resolveRepository` would build, asked of Git itself. */
  function recordFor(root: string, id: string) {
    return {
      id,
      root: git(root, ['rev-parse', '--path-format=absolute', '--show-toplevel']).trim(),
      gitCommonDir: git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
    };
  }

  function acquiresAt(root: string, id: string): string {
    const acquired = acquireRepositoryExecutionLease(
      recordFor(root, id),
      { runId: null, blockId: null },
      { now: tickingClock() },
    );
    if (acquired.ok) releaseRepositoryExecutionLease(acquired.evidence);
    return acquired.ok ? 'ACQUIRED' : acquired.code;
  }

  it('runs a submodule working tree, whose pointer Git writes relative', async () => {
    // The defect this section exists for. The first coherence check was written
    // from three layouts that all happen to carry an *absolute* `gitdir:`
    // pointer, and required one — so it refused a submodule, whose pointer Git
    // writes as `gitdir: ../.git/modules/<name>`. A review drove it through the
    // shipped CLI: `run --attended` and `release --attended` were refused
    // permanently, while `lease status` printed a derived path for the same
    // repository. A whitelist of measured shapes is an outage for every shape
    // nobody measured.
    const superproject = await leasableRepository();
    const source = await leasableRepository();
    git(superproject.root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      pathToFileURL(source.root).href,
      'product',
    ]);
    const submodule = join(superproject.root, 'product');

    // The premise, stated rather than assumed: Git really does write it relative.
    expect(readFileSync(join(submodule, '.git'), 'utf8').trim()).toMatch(/^gitdir: \.\./);

    expect(acquiresAt(submodule, 'submodule')).toBe('ACQUIRED');
  });

  it('runs a repository whose .git is a link rather than a directory', async () => {
    // The same defect from the other side: `statSync` follows the link, so the
    // marker took the directory branch and was compared *as written* against a
    // common dir `resolve-repository.ts` had already canonicalised. Two spellings
    // of one directory, refused. Only one side was ever canonicalised.
    const fixture = await leasableRepository();
    const marker = join(fixture.root, '.git');
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'ao-real-git-')), 'git');

    renameSync(marker, elsewhere);
    try {
      try {
        symlinkSync(elsewhere, marker, 'junction');
      } catch {
        // A host that will not create the link cannot be asked the question. The
        // measurement is the point, so this says so rather than passing quietly.
        expect.unreachable('this host could not create a directory link for .git');
      }

      // The premise, again stated: Git resolves this tree, and the marker really
      // is a link rather than the directory itself.
      expect(lstatSync(marker).isDirectory()).toBe(false);
      expect(git(fixture.root, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true');

      expect(acquiresAt(fixture.root, 'linked-git')).toBe('ACQUIRED');
    } finally {
      // Put the fixture back, so the shared cleanup can remove it: a junction
      // left behind is the kind of leftover that makes the *next* suite fail
      // for a reason that has nothing to do with it.
      rmSync(marker, { recursive: true, force: true });
      renameSync(elsewhere, marker);
    }
  });

  it('runs a linked worktree and an ordinary clone', async () => {
    // The two shapes that always worked, kept as controls: a check that refuses
    // everything would satisfy every test above this line.
    const fixture = await leasableRepository();
    expect(acquiresAt(fixture.root, 'ordinary')).toBe('ACQUIRED');

    const linked = join(fixture.root, '..', `ao-linked-ctrl-${TASK_ID}`);
    git(fixture.root, ['worktree', 'add', '-q', '-b', 'probe-control', linked]);
    try {
      expect(acquiresAt(linked, 'linked-worktree')).toBe('ACQUIRED');
      // And it is the *same* lease: two worktrees of one clone are deliberately
      // one execution domain, which is the whole reason the key is the common
      // dir rather than the root.
      expect(recordFor(linked, 'x').gitCommonDir).toBe(recordFor(fixture.root, 'y').gitCommonDir);
    } finally {
      git(fixture.root, ['worktree', 'remove', '--force', linked]);
    }
  });

  it('still refuses a record whose halves are two different repositories', async () => {
    // The control in the other direction, and the reason any of this exists.
    const victim = await leasableRepository();
    const other = await leasableRepository();

    const mixed = acquireRepositoryExecutionLease(
      { id: victim.repository.id, root: victim.repository.root, gitCommonDir: other.repository.gitCommonDir },
      { runId: null, blockId: null },
      { now: tickingClock() },
    );

    expect(mixed.ok).toBe(false);
    if (mixed.ok) return;
    expect(mixed.code).toBe('REPOSITORY_RECORD_INCOHERENT');
    expect(existsSync(join(other.repository.gitCommonDir, EXECUTION_LEASE_FILE_NAME))).toBe(false);
    expect(existsSync(join(victim.repository.gitCommonDir, EXECUTION_LEASE_FILE_NAME))).toBe(false);
  });

  it('describes that refusal as what it is', async () => {
    // It was folded into `LEASE_LOCATION_UNSUITABLE`, whose sentence says no
    // location could be derived — while `lease status` prints a derived path for
    // the same repository. Two commands contradicting each other about one
    // repository is worse than a long refusal, and `detail` is never rendered,
    // so the real reason reached nobody.
    const refusal = renderLeaseRefusal('REPOSITORY_RECORD_INCOHERENT');

    expect(refusal).toContain('does not describe one repository');
    expect(refusal).not.toContain('No lease location could be derived');
    // And it names the shapes that are *not* the problem, so nobody goes looking
    // for a fault in a perfectly ordinary submodule.
    expect(refusal).toContain('submodule');
  });
});

/* ─────────── 16. the fences nothing was testing ─────────────────────────── */

describe('every seam that starts a process is fenced, not just the writer', () => {
  it('starts no verification command once the lease is gone', async () => {
    // The verify seam had a live guard and no counter-proof: removing it passed
    // all 2643 tests. A review executed the exploit — a task driven to
    // `VERIFYING` with the lease absent spawned the verifier for real — which is
    // the same class of finding as the writer seam, one seam over.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');

    const authority = { repository: fixture.repository, evidence };
    let current = loadTaskState(fixture.root, TASK_ID);
    if (!current.ok) throw new Error('task did not start');

    const stepDeps = (overrides: Record<string, unknown> = {}) => ({
      now: tickingClock()(),
      authorisedWorktreePath: current.ok ? current.state.worktreePath : '',
      verification: fixture.repository.verification,
      taskBrief: TASK_ID,
      brief: readExecutionBrief(
        fixture.repository,
        TASK_ID,
        current.ok ? current.state.worktreePath : '',
      ),
      lease: authority,
      ...overrides,
    });

    // Drive to VERIFYING, which is the phase that runs the verification command.
    for (const expected of ['CONTEXT_LOADING', 'IMPLEMENTING', 'VERIFYING'] as const) {
      const advanced = await runLoopStep(current, stepDeps({ agent: async () => writerSuccess() }));
      expect(advanced.state).toBe(expected);
      current = loadTaskState(fixture.root, TASK_ID);
      if (!current.ok) throw new Error('state vanished');
    }

    releaseRepositoryExecutionLease(evidence);

    let verifierSpawns = 0;
    const step = await runLoopStep(
      current,
      stepDeps({
        verify: async () => {
          verifierSpawns += 1;
          throw new Error('a verification command must not be started without the lease');
        },
      }),
    );

    expect(verifierSpawns).toBe(0);
    expect(step.outcome).toBe('STATE_NOT_RECORDED');
  });

  it('reports an exhausted budget it can no longer vouch for as a lost lease', async () => {
    // `run-driver.ts` re-proves the lease before returning `STEP_BUDGET_EXHAUSTED`,
    // because that outcome tells a scheduler "call me again" at exit 5 - an
    // instruction this run has no standing to give once it is not the writer.
    // The gate was live and nothing tested it.
    //
    // The window it guards is one statement wide and has no seam in it, so the
    // release is triggered from `replace`, which *is* the durable write: the
    // rename happens for real, and the lease goes the instant afterwards. That
    // is precisely the state the gate exists to catch - a step that legitimately
    // landed, followed by a budget report this run may no longer make.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');

    let writes = 0;
    const run = await runTask(
      {
        repository: fixture.repository,
        taskId: TASK_ID,
        taskBrief: TASK_ID,
        attendedContinuation: true,
        authEvidence: provenAuthEvidence(),
        lease: evidence,
        // One step, which `WORKTREE_READY` satisfies without starting anything.
        maxSteps: 1,
      },
      {
        now: tickingClock(),
        git: runGitCommand,
        replace: (from, to) => {
          renameSync(from, to);
          writes += 1;
          releaseRepositoryExecutionLease(evidence);
        },
      },
    );

    // The step really did land - otherwise this would be testing a refused write.
    expect(writes).toBe(1);
    const after = loadTaskState(fixture.root, TASK_ID);
    expect(after.ok && after.state.state).toBe('CONTEXT_LOADING');

    expect(run.outcome).toBe('EXECUTION_LEASE_LOST');
    expect(run.outcome).not.toBe('STEP_BUDGET_EXHAUSTED');
    // Exit 5 is the one a scheduler reads as "continue".
    expect(exitCodeForRunOutcome(run.outcome)).not.toBe(5);
  });
});

/* ─────────── 17. the fence belongs to the seam, not to one caller ───────── */

describe('a step started directly is fenced exactly like one the loop drives', () => {
  it('starts no writer when the exported step is called on its own', async () => {
    // `runLoopStep` used to install the fence by replacing `deps.agent` before
    // dispatching. That fenced every path *through `runLoopStep`* and nothing
    // else, and every step function here is exported. A review called
    // `runImplementStep` directly with the lease released and watched it reach
    // `runClaudeWriter`.
    //
    // The absent seam was the productive half of it: `agent === undefined` made
    // the writer fall back to `runAgentCommand`, the real spawn. So a direct
    // caller with no injected seam got no fence *and* a live subprocess.
    //
    // No productive caller had done that yet, which is the reason to close it
    // rather than a reason to leave it: this slice has twice shipped a rule that
    // held only where somebody remembered to apply it.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');

    const authority = { repository: fixture.repository, evidence };
    let current = loadTaskState(fixture.root, TASK_ID);
    if (!current.ok) throw new Error('task did not start');

    const deps = (overrides: Record<string, unknown> = {}) => ({
      now: tickingClock()(),
      authorisedWorktreePath: current.ok ? current.state.worktreePath : '',
      verification: fixture.repository.verification,
      taskBrief: TASK_ID,
      brief: readExecutionBrief(
        fixture.repository,
        TASK_ID,
        current.ok ? current.state.worktreePath : '',
      ),
      lease: authority,
      ...overrides,
    });

    for (const expected of ['CONTEXT_LOADING', 'IMPLEMENTING'] as const) {
      const advanced = await runLoopStep(current, deps({ agent: async () => writerSuccess() }));
      expect(advanced.state).toBe(expected);
      current = loadTaskState(fixture.root, TASK_ID);
      if (!current.ok) throw new Error('state vanished');
    }

    releaseRepositoryExecutionLease(evidence);

    let spawns = 0;
    // The exported step, called the way a future caller would - not through the
    // one function that used to own the fence.
    const step = await runImplementStep(
      current,
      deps({
        agent: async () => {
          spawns += 1;
          throw new Error('a writing agent must not be started without the lease');
        },
      }),
    );

    expect(spawns).toBe(0);
    expect(step.outcome).toBe('STATE_NOT_RECORDED');
  });

  it('starts no verification when the exported step is called on its own', async () => {
    // The same hole, one seam over. `runVerifyStep` is exported too.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');

    const authority = { repository: fixture.repository, evidence };
    let current = loadTaskState(fixture.root, TASK_ID);
    if (!current.ok) throw new Error('task did not start');

    const deps = (overrides: Record<string, unknown> = {}) => ({
      now: tickingClock()(),
      authorisedWorktreePath: current.ok ? current.state.worktreePath : '',
      verification: fixture.repository.verification,
      taskBrief: TASK_ID,
      brief: readExecutionBrief(
        fixture.repository,
        TASK_ID,
        current.ok ? current.state.worktreePath : '',
      ),
      lease: authority,
      ...overrides,
    });

    for (const expected of ['CONTEXT_LOADING', 'IMPLEMENTING', 'VERIFYING'] as const) {
      const advanced = await runLoopStep(current, deps({ agent: async () => writerSuccess() }));
      expect(advanced.state).toBe(expected);
      current = loadTaskState(fixture.root, TASK_ID);
      if (!current.ok) throw new Error('state vanished');
    }

    releaseRepositoryExecutionLease(evidence);

    let spawns = 0;
    const step = await runVerifyStep(
      current,
      deps({
        verify: async () => {
          spawns += 1;
          throw new Error('a verification command must not be started without the lease');
        },
      }),
    );

    expect(spawns).toBe(0);
    expect(step.outcome).toBe('STATE_NOT_RECORDED');
  });
});

/* ─────────── 18. what the reader must never call free ───────────────────── */

describe('an unreadable lease is held-and-unsafe, never free', () => {
  /** Puts `bytes` at the lease path and reports what the module makes of it. */
  function inspectWith(fixture: Fixture, bytes: string): LeaseInspection {
    const location = deriveExecutionLeaseLocation(fixture.repository);
    if (!location.ok) throw new Error('fixture has no lease location');
    writeFileSync(location.path, bytes, 'utf8');
    return inspectRepositoryExecutionLease(fixture.repository);
  }

  it('classifies a half-written lease as unparseable, and says so to an operator', async () => {
    // The existing counter-proof for this asserted only what `acquire` answered,
    // and `acquire` is protected by the atomic create rather than by the
    // reader's classification. A review changed the parse-failure branch to
    // return FREE - the exact confusion `LEASE_STATES` calls the one thing this
    // must never be mistaken for - and all 2650 tests stayed green while
    // `lease status` began telling operators that an owned repository was free
    // for the taking.
    const fixture = await leasableRepository();
    const truncated = JSON.stringify({ schemaVersion: 1, leaseKey: 'x' }).slice(0, 20);

    const inspection = inspectWith(fixture, truncated);

    expect(inspection.state).toBe('UNPARSEABLE');
    expect(inspection.state).not.toBe('FREE');
    // And the operator-facing consequence, which is the part that matters: the
    // report must not invite the next invocation to take it.
    const report = renderLeaseStatus(inspection, true);
    expect(report).toContain('treated');
    expect(report).not.toContain('The next one may take the lease.');
  });

  it('classifies an oversized and a structurally wrong lease the same way', async () => {
    // The two sibling branches of the same reader. Both survived alone.
    const fixture = await leasableRepository();

    expect(inspectWith(fixture, `{"padding":"${'a'.repeat(70_000)}"}`).state).not.toBe('FREE');
    expect(inspectWith(fixture, '{"schemaVersion":1,"notALease":true}').state).not.toBe('FREE');
    expect(inspectWith(fixture, '').state).not.toBe('FREE');
  });

  it('reports a genuinely absent lease as free, so the refusal is not universal', async () => {
    // The control. A reader that answered UNPARSEABLE for everything would pass
    // every assertion above and lock every repository out permanently.
    const fixture = await leasableRepository();

    expect(inspectRepositoryExecutionLease(fixture.repository).state).toBe('FREE');
  });
});

/* ─────────── 19. the entry gate on the destructive command ──────────────── */

describe('a release refused at its entry removes nothing', () => {
  it('does not remove a workspace when the lease went before the first command', async () => {
    // `releaseTaskWorkspace` proves the lease on entry and `removeTaskWorkspace`
    // proves it again before `worktree remove`. Removing *both* left all 2650
    // tests green, while the measured effect of removing them is a successor's
    // workspace deleted off disk. The later gate before `branch -d` was the only
    // one anything tested.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const crashed = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        replace: () => {
          throw new Error('simulated crash before the first durable write landed');
        },
      },
    );
    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
    const workspace = crashed.workspace;
    if (workspace === null) throw new Error('the crashed start left no workspace');

    // Gone before anything destructive is even considered.
    releaseRepositoryExecutionLease(evidence);

    const destructive: string[] = [];
    const released = await releaseTaskWorkspace(fixture.repository, TASK_ID, {
      git: async (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') destructive.push('worktree remove');
        if (args[0] === 'branch' && args[1] === '-d') destructive.push('branch -d');
        return runGitCommand(cwd, args);
      },
      lease: evidence,
    });

    expect(released.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(destructive).toEqual([]);
    expect(released.worktreeRemoved).toBe(false);
    // The measurement that matters: it is still on disk, for a successor to own.
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).not.toBe('');
  });
});

/* ─────────── 21. the second layer of the mixed-record defence ───────────── */

describe('a lease proves the repository it was taken for, not merely a path', () => {
  it('refuses a genuine lease presented with a foreign root', async () => {
    // Two independent checks stand between a mixed record and authority: the
    // lease path derived from `gitCommonDir`, and the document's own
    // `repositoryRoot`. Acquire now refuses to *create* such a record at all,
    // which is what made the second check untestable through the front door and
    // left it unpinned — a probe deleted it and the whole suite stayed green.
    //
    // It is still load-bearing: it is what refuses a genuine lease that some
    // other caller waves at the wrong repository.
    const owner = await leasableRepository();
    const other = await leasableRepository();
    const evidence = heldLease(owner);

    // The lease is real and held. Only the record it is presented with is wrong:
    // the key half names the repository the lease is genuinely for, so the path
    // check passes, and the root half names somewhere else entirely.
    expect(verifyExecutionLeaseHeldFor(owner.repository, evidence).code).toBe('HELD');

    const verdict = verifyExecutionLeaseHeldFor(
      { id: other.repository.id, root: other.repository.root, gitCommonDir: owner.repository.gitCommonDir },
      evidence,
    );

    expect(verdict.code).toBe('LEASE_FOR_ANOTHER_REPOSITORY');
    expect(verdict.code).not.toBe('HELD');
  });
});

/* ─────────── 22. the gate nearest the removal, not the one at the door ─── */

describe('a release that loses the lease before removing anything removes nothing', () => {
  it('stops between the entry gate and the worktree removal', async () => {
    // `releaseTaskWorkspace` proves the lease on entry, again immediately before
    // removal, and `removeTaskWorkspace` proves it once more before each
    // destructive command. A probe neutralised the middle two — the entry gate
    // left intact — and all 2650 tests stayed green, while the measured effect
    // was a successor's workspace deleted off disk.
    //
    // The entry gate cannot cover this: adoption is assessed in between, which
    // is several Git subprocesses, and that is the window a successor acquires
    // in.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const crashed = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        replace: () => {
          throw new Error('simulated crash before the first durable write landed');
        },
      },
    );
    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
    const workspace = crashed.workspace;
    if (workspace === null) throw new Error('the crashed start left no workspace');

    const destructive: string[] = [];
    const released = await releaseTaskWorkspace(fixture.repository, TASK_ID, {
      git: async (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') destructive.push('worktree remove');
        if (args[0] === 'branch' && args[1] === '-d') destructive.push('branch -d');
        const result = await runGitCommand(cwd, args);
        // Held at the door, gone by the time anything is deleted: released
        // during the adoption assessment, which is what runs in between.
        if (args[0] === 'ls-files') releaseRepositoryExecutionLease(evidence);
        return result;
      },
      lease: evidence,
    });

    expect(released.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(destructive).toEqual([]);
    expect(released.worktreeRemoved).toBe(false);
    // The measurement that matters: still on disk, for whoever owns it now.
    expect(existsSync(workspace.worktreePath)).toBe(true);
  });
});

/* ─────────── 23. the removal, called the way a future caller would ─────── */

describe('the workspace removal is fenced by its own gate, not by its caller', () => {
  it('removes nothing when called directly without the lease', async () => {
    // `removeTaskWorkspace` is exported and has exactly one productive caller
    // today. Neutralising its own gate alone left the suite green, because
    // `releaseTaskWorkspace` re-proves the lease a few statements earlier and
    // answered first — real defence in depth, and also the precise shape that
    // has already bitten this slice once: `runLoopStep` installed the spawn
    // fence, every step function was exported, and a direct caller got no fence
    // at all.
    //
    // The gate's own comment is the claim under test: *"a gate in a caller is a
    // gate at whatever distance the caller happens to have"*. That is only true
    // if it holds with no caller in front of it.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const crashed = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        replace: () => {
          throw new Error('simulated crash before the first durable write landed');
        },
      },
    );
    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
    const workspace = crashed.workspace;
    if (workspace === null) throw new Error('the crashed start left no workspace');

    releaseRepositoryExecutionLease(evidence);

    const destructive: string[] = [];
    const removal = await removeTaskWorkspace(fixture.repository, taskWithId(TASK_ID), {
      git: async (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') destructive.push('worktree remove');
        if (args[0] === 'branch' && args[1] === '-d') destructive.push('branch -d');
        return runGitCommand(cwd, args);
      },
      lease: evidence,
    });

    expect(removal.ok).toBe(false);
    expect(destructive).toEqual([]);
    // Still on disk and still on the branch list, for whoever owns them now.
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).not.toBe('');
  });
});

/* ─────────── 24. the entry gate, and the window after it ───────────────── */

describe('a start without the lease opens nothing, and a start that loses it says so', () => {
  it('runs no preflight and no Git command when the lease was never held', async () => {
    // The entry gate's comment says it sits "ahead of every other gate,
    // including the cheap syntactic ones", and the test that covers this
    // refusal says "refused before anything was opened" - while asserting only
    // the outcome, the workspace and the residue, all three of which the *next*
    // gate supplies just as well. A review deleted the entry gate and every
    // suite stayed green, with one auth preflight and two Git commands now
    // running before the refusal. In production that preflight starts two real
    // subscription CLIs.
    //
    // So the claim is measured as what it says: nothing was opened.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    // Genuine evidence for a lease that is over - the shape a stale caller has.
    expect(releaseRepositoryExecutionLease(evidence).code).toBe('RELEASED');

    let preflights = 0;
    let gitCommands = 0;
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: async (cwd, args) => {
          gitCommands += 1;
          return runGitCommand(cwd, args);
        },
        now: tickingClock(),
        authPreflight: async () => {
          preflights += 1;
          return authPreflightPasses();
        },
        lease: evidence,
      },
    );

    expect(started.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(preflights).toBe(0);
    expect(gitCommands).toBe(0);
    expect(exitCodeForStartOutcome(started.outcome)).toBe(4);
  });

  it('reports a lease lost during the preflight as not held, not as a refused workspace', async () => {
    // The gate before the workspace exists for this window: `deps.authPreflight`
    // is a capability dump plus two real subscription CLIs, measured at 2552 ms
    // for the dump alone, and a review released the lease inside it and watched
    // a branch and a worktree land.
    //
    // Removing that gate lands no effect today - `prepareTaskWorkspace` refuses
    // at its own gate - but it turns exit 4 into exit 3, which is the collapse
    // `START_TASK_EXIT_CODES` exists to prevent: "nothing is wrong, retry"
    // becoming "an operator must act". Nothing pinned that.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: async () => {
          // Gone during the preflight: held at the door, absent by the time the
          // first repository mutation would happen.
          releaseRepositoryExecutionLease(evidence);
          return authPreflightPasses();
        },
        lease: evidence,
      },
    );

    expect(started.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(started.outcome).not.toBe('WORKSPACE_REFUSED');
    // Exit 4 is "this invocation may not act here"; exit 3 asks a human to
    // intervene over a repository where nothing is wrong.
    expect(exitCodeForStartOutcome(started.outcome)).toBe(4);
    expect(started.residue).toBe(false);
    // And nothing was created on the way.
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
  });
});

/* ─────────── 25. the spawn surface, pinned as structure not as spelling ── */

describe('a subprocess cannot be started from anywhere that lacks the lease', () => {
  /**
   * Every binding-introducing statement in a file: static `import`, `export …
   * from`, dynamic `import()`, or `require()`, in either quote style.
   *
   * Each of those four shapes is here because a review used it to walk past an
   * earlier version of this scanner. `export { spawnSync as runQuietly } from
   * 'node:child_process'` is the one worth naming: it introduces the binding
   * into another module without the word `import` appearing anywhere.
   */
  function importsOf(file: string): readonly { text: string; typeOnly: boolean }[] {
    const source = readFileSync(file, 'utf8');
    const statements = [
      // The trailing `;` is optional. It was required, and a review put a
      // semicolon-less `import { spawnSync } from 'node:child_process'` last in
      // the file: every pin stayed green while twelve real unfenced processes
      // ran. ASI makes that valid TypeScript, so the scanner has to accept it.
      ...source.matchAll(/^import[\s\S]*?from\s*['"][^'"]+['"];?/gm),
      ...source.matchAll(/^export[\s\S]*?from\s*['"][^'"]+['"];?/gm),
      ...source.matchAll(/\bimport\s*\(\s*['"][^'"]+['"]\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*['"][^'"]+['"]\s*\)/g),
    ].map((match) => match[0]);

    return statements.map((text) => ({
      text,
      // `import type …`, and `import { type A, type B }` where every binding is
      // a type, are erased by the compiler and cannot start anything.
      typeOnly:
        /^import\s+type\b/.test(text) ||
        (/^import\s*\{/.test(text) &&
          text
            .slice(text.indexOf('{') + 1, text.indexOf('}'))
            .split(',')
            .map((binding) => binding.trim())
            .filter((binding) => binding.length > 0)
            .every((binding) => binding.startsWith('type '))),
    }));
  }

  /**
   * Every `src/` module that really *imports* something matching `pattern`.
   *
   * Imports, not mentions, and not type-only imports.
   *
   * The pin this replaced counted occurrences of a name anywhere in a file's
   * text. A review spent one of its allowed "slots" by rewording a comment and
   * smuggled in a direct call to the raw runner. A module can only call what it
   * imports, so the import is the thing worth pinning — and prose is then free
   * to explain itself, which is why this file can discuss `runAgentCommand`
   * without becoming a violation.
   */
  function modulesImporting(pattern: RegExp, { values = true } = {}): string[] {
    return sourceFiles()
      .filter((file) =>
        importsOf(file).some(
          (statement) => pattern.test(statement.text) && (!values || !statement.typeOnly),
        ),
      )
      .map((file) => relative(PACKAGE_ROOT, file))
      .sort();
  }

  it('lets exactly one module reach the raw runners', () => {
    // The fence lives in one module and the raw runners are reachable from
    // nowhere else. `loop-step.ts` imports only the *types* from those modules,
    // which are erased and cannot spawn — so a step cannot name a raw runner
    // even by accident.
    expect(modulesImporting(/\brunAgentCommand\b|agent-command\.js/)).toEqual([
      join('src', 'loop', 'leased-spawns.ts'),
    ]);
    expect(modulesImporting(/\brunVerificationCommand\b|verify-command\.js/)).toEqual([
      join('src', 'loop', 'leased-spawns.ts'),
    ]);
  });

  it('lets exactly one module start an OS process at all', () => {
    // The route a count could never have seen: a step reaching for
    // `child_process` itself. It was already true that one module does this;
    // nothing said so, so nothing noticed when a review added a second and
    // started 57 real unfenced processes with the whole suite green.
    expect(modulesImporting(/node:child_process/, { values: false })).toEqual([
      join('src', 'doctor', 'exec.ts'),
    ]);
  });

  it('keeps every import static, which is what the reachability pins assume', () => {
    // The assumption under every reachability pin in this suite — this one, the
    // mint's, and the block store's — is that imports are static and therefore
    // greppable. A dynamic `await import('node:child_process')` walked straight
    // past the first version of the pin above for exactly that reason.
    //
    // So the assumption is enforced rather than relied upon. There are no
    // dynamic imports in `src/` today; if one is ever wanted, this failing is
    // the prompt to decide what it does to the pins, rather than discovering
    // later that they quietly stopped covering anything.
    // Comments are stripped first. TypeScript's own `import('…')` *type* syntax
    // is legitimate inside JSDoc — `doctor/run-completion.ts` uses it to link a
    // type — and a pin that cannot tell prose from code is a pin that gets
    // silenced by whoever trips it first.
    const codeOf = (file: string): string =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

    const dynamic = sourceFiles()
      .filter((file) => /\bimport\s*\(|\brequire\s*\(/.test(codeOf(file)))
      .map((file) => relative(PACKAGE_ROOT, file))
      .sort();

    expect(dynamic).toEqual([]);
  });

  it('gives the spawn helpers no runner to fall back to', () => {
    // The third route: an absent seam. `runClaudeWriter`, `runCodexReviewer`
    // and `runVerification` defaulted to the raw runner, which made the
    // *unfenced* spawn the behaviour a forgetful caller got. Their runner is a
    // required argument now, so that mistake does not compile — and this pins
    // that no default creeps back in.
    for (const file of [
      join('src', 'agent', 'claude-writer.ts'),
      join('src', 'agent', 'codex-reviewer.ts'),
      join('src', 'verify', 'run-verification.ts'),
    ]) {
      const source = readFileSync(join(PACKAGE_ROOT, file), 'utf8');
      expect(source).not.toMatch(/\?\?\s*runAgentCommand/);
      expect(source).not.toMatch(/\?\?\s*runVerificationCommand/);
      expect(source).not.toMatch(/Options\s*=\s*\{\}/);
    }
  });

  it('does not reach a process through the routes that need no import', () => {
    // ── What these pins are, stated after four rounds of being wrong ──────
    //
    // The three above were introduced as proof that *no* code in this module
    // can start an unfenced subprocess. That claim is false and cannot be
    // repaired by a better scanner. A review demonstrated it with
    // `process.binding('spawn_sync').spawn(…)`, which starts real processes,
    // names no module, and is therefore invisible to any pin that reads
    // imports — measured working on the Node this repository requires.
    //
    // So the honest statement of what this section does:
    //
    //   * the *seams* are the enforcement for the agent and verification
    //     subprocesses: every one goes through `leasedAgent` / `leasedVerify`,
    //     which prove the lease at the call. Not "every productive spawn" — the
    //     Git mutations are fenced immediately before their effect instead, by a
    //     different mechanism, and blurring the two sends a reader to the wrong
    //     gate;
    //   * a missing seam is a **compile error**, which is enforcement rather
    //     than detection;
    //   * these pins are **regression detectors for known bypass routes**. They
    //     catch a reintroduction nobody meant. They do not, and cannot, bound
    //     what a determined author can write.
    //
    // The residue is real and is named here rather than in a comment claiming
    // otherwise: `process.binding`, `node:worker_threads`, `node:vm` and
    // indirect `eval` can each reach a process without an import. This adds them
    // to the denylist because a denylist of known routes is worth having; it is
    // not a proof, and the difference is why the sentences that called it
    // structural were removed.
    // `\.binding\s*\(` rather than `process\.binding`, because the only spelling
    // a TypeScript author can actually write needs a cast first —
    // `(process as unknown as { binding: … }).binding('spawn_sync')` — and the
    // narrower pattern matched none of it. A denylist that misses the sole
    // writable form of the route is worse than none: it reads as coverage.
    //
    // Every occurrence of the word "binding" in `src/` today is prose about
    // something else, so this matches the call shape rather than the word.
    const forbidden = /\.binding\s*\(|\bnode:worker_threads\b|\bnode:vm\b|\bnew Function\s*\(/;
    const codeOf = (file: string): string =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

    const reaching = sourceFiles()
      .filter((file) => forbidden.test(codeOf(file)))
      .map((file) => relative(PACKAGE_ROOT, file))
      .sort();

    expect(reaching).toEqual([]);
  });
});


/* ─────────── 26. a start whose undo was refused says the lease went ────── */

describe('a rollback stopped by a lost lease is reported as a lost lease', () => {
  it('does not report leftovers it may not remove as a plain workspace refusal', async () => {
    // `startTask` maps `WORKTREE_ROLLBACK_NOT_AUTHORISED` to
    // `EXECUTION_LEASE_LOST`. Deleting that mapping left the whole suite green
    // while the same run reported `WORKSPACE_REFUSED`, whose operator sentence
    // is "Workspace preparation was refused. Nothing was started." - said of a
    // run that has a worktree and a branch on disk and `residue: true`.
    //
    // That is the collapse this branch exists to prevent, and it is worse here
    // than elsewhere: the leftovers may already belong to a successor, so an
    // operator told "nothing was started" is being invited to tidy up somebody
    // else's workspace.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    let added = false;
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        git: async (cwd, args) => {
          const result = await runGitCommand(cwd, args);
          if (args[0] === 'worktree' && args[1] === 'add') {
            added = true;
            // The workspace exists; this run stops being the writer before
            // anything verifies it, so the undo may not run either.
            releaseRepositoryExecutionLease(evidence);
          }
          // Fail the verification that follows, which is what calls the undo.
          if (added && args[0] === 'rev-parse') {
            return Object.freeze({
              outcome: 'OK' as const,
              exitCode: 0,
              signal: null,
              stdout: '0000000000000000000000000000000000000000',
              stderr: '',
              outputTruncated: false,
              failureCode: null,
              errnoCode: null,
              durationMs: 0,
            });
          }
          return result;
        },
      },
    );

    expect(started.outcome).toBe('EXECUTION_LEASE_LOST');
    expect(started.outcome).not.toBe('WORKSPACE_REFUSED');
    expect(started.reasonCodes).toContain('WORKTREE_ROLLBACK_NOT_AUTHORISED');
    // The leftovers are declared, because they are real and are not this run's
    // to clear.
    expect(started.residue).toBe(true);
    expect(exitCodeForStartOutcome(started.outcome)).toBe(3);
    // And they really are on disk: a successor may legitimately own them.
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).not.toBe('');
  });
});

/* ─────────── 27. an inner gate's refusal keeps its own name ────────────── */

describe('a refusal from an effect gate is reported as a refusal, not as a failure', () => {
  it('reports a start refused at the creation gate as not held, at exit 4', async () => {
    // `prepareTaskWorkspace` proves the lease immediately before it creates
    // anything, which is the whole reason that gate exists - the 383 ms window
    // between `startTask`'s own check and `git worktree add`. Its refusal was
    // landing in the generic branch as `WORKSPACE_REFUSED`.
    //
    // Nothing is created either way, so this is purely about what an operator is
    // told: exit 3 says a human must go and look at the repository, exit 4 says
    // this invocation may not act here and the next one may well succeed. The
    // repository is in perfect order, so exit 3 sends someone to inspect
    // nothing.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        git: async (cwd, args) => {
          // Gone inside the preparation, after its questions and before its
          // first effect - the window the gate was added for.
          if (args[0] === 'status') releaseRepositoryExecutionLease(evidence);
          return runGitCommand(cwd, args);
        },
      },
    );

    expect(started.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(started.outcome).not.toBe('WORKSPACE_REFUSED');
    expect(started.reasonCodes).toContain('EXECUTION_LEASE_NOT_HELD');
    expect(exitCodeForStartOutcome(started.outcome)).toBe(4);
    // Nothing was created, which is what makes exit 3 the wrong answer.
    expect(started.residue).toBe(false);
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
  });

  it('does not tell an operator Git refused a removal Git was never asked for', async () => {
    // The same shape on the release path, and worse: `REMOVE_FAILED` declares
    // itself as "every ownership proof held and Git still refused to remove the
    // worktree". When `removeTaskWorkspace` refuses at its own lease gate, no
    // Git removal is attempted at all, so that sentence is not merely
    // imprecise - it is false about what happened.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const crashed = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        replace: () => {
          throw new Error('simulated crash before the first durable write landed');
        },
      },
    );
    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');

    const destructive: string[] = [];
    const released = await releaseTaskWorkspace(fixture.repository, TASK_ID, {
      git: async (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') destructive.push('worktree remove');
        if (args[0] === 'branch' && args[1] === '-d') destructive.push('branch -d');
        const result = await runGitCommand(cwd, args);
        // Held at the door, gone inside `removeTaskWorkspace` - after
        // `releaseTaskWorkspace`'s own gate, before the removal's.
        if (args[0] === 'merge-base') releaseRepositoryExecutionLease(evidence);
        return result;
      },
      lease: evidence,
    });

    expect(released.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(released.outcome).not.toBe('REMOVE_FAILED');
    expect(exitCodeForReleaseOutcome(released.outcome)).toBe(4);
    // Git really was never asked, which is the part the old sentence got wrong.
    expect(destructive).toEqual([]);
    expect(released.worktreeRemoved).toBe(false);
    expect(released.branchRemoved).toBe(false);
  });
});

/* ─────────── 28. an outer gate earns its keep by the work it avoids ────── */

describe('a gate whose refusal the inner gate would repeat is still doing something', () => {
  it('does not prepare a workspace after the lease goes during the preflight', async () => {
    // ── Why this counts subprocesses instead of asserting an outcome ──────
    //
    // `startTask` proves the lease at its entrance, again before the workspace,
    // and `prepareTaskWorkspace` proves it once more at the effect. Once the
    // middle gate was corrected to report `EXECUTION_LEASE_NOT_HELD` at exit 4 -
    // the same outcome and exit code the inner gate produces - deleting it
    // stopped changing any assertion, and the whole suite went green without it.
    // A review noticed and was right to: the outcome no longer distinguishes
    // them.
    //
    // What still distinguishes them is what runs. The middle gate exists so that
    // a run which lost the lease during the preflight does not go on to spend
    // eight Git subprocesses discovering it cannot create anything. That is
    // measurable, so it is measured.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    let gitAfterPreflight = 0;
    let preflightDone = false;
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        now: tickingClock(),
        lease: evidence,
        authPreflight: async () => {
          // The window the middle gate is for: held at the entrance, gone by the
          // time the preflight returns.
          releaseRepositoryExecutionLease(evidence);
          preflightDone = true;
          return authPreflightPasses();
        },
        git: async (cwd, args) => {
          if (preflightDone) gitAfterPreflight += 1;
          return runGitCommand(cwd, args);
        },
      },
    );

    expect(started.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(exitCodeForStartOutcome(started.outcome)).toBe(4);
    // The point of the gate: nothing was attempted after the loss.
    expect(gitAfterPreflight).toBe(0);
    expect(started.residue).toBe(false);
  });

  it('does not assess a workspace for adoption after the lease goes', async () => {
    // The same argument on the release path. `releaseTaskWorkspace` proves the
    // lease before it inspects anything, and `removeTaskWorkspace` proves it
    // again at the destructive boundary. With both producing
    // `EXECUTION_LEASE_NOT_HELD` at exit 4, the earlier gate became invisible to
    // every assertion - but it is what stops an unauthorised invocation from
    // running a whole adoption assessment against somebody else's repository.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const crashed = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        replace: () => {
          throw new Error('simulated crash before the first durable write landed');
        },
      },
    );
    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');

    // Gone before the release is even called.
    releaseRepositoryExecutionLease(evidence);

    let gitCommands = 0;
    const released = await releaseTaskWorkspace(fixture.repository, TASK_ID, {
      git: async (cwd, args) => {
        gitCommands += 1;
        return runGitCommand(cwd, args);
      },
      lease: evidence,
    });

    expect(released.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    expect(exitCodeForReleaseOutcome(released.outcome)).toBe(4);
    // Nothing was inspected, which is what the entry gate is for.
    expect(gitCommands).toBe(0);
    expect(released.verdict).toBe(null);
  });
});

/* ─────────── 29. an outcome sentence is true of every producer ─────────── */

describe('the operator text says what happened, for each way of arriving at it', () => {
  it('does not claim Git refused a removal it was never asked to attempt', async () => {
    // `REMOVE_FAILED` is reached by seven codes and said "every ownership proof
    // held and Git still refused to remove the worktree" - true of exactly one
    // of them. A review reproduced `WORKTREE_DIRTY`, where *both* clauses are
    // false: a proof did not hold, and no removal was attempted.
    const sentence = RELEASE_OUTCOME_SENTENCES.REMOVE_FAILED;

    expect(sentence).not.toContain('Every ownership proof held');
    expect(sentence).not.toMatch(/Git still refused/);
    // It points at the reason code, which is the thing that actually varies.
    expect(sentence).toContain('the reason code says what stopped it');
  });

  it('does not tell a start that read a plan and ran a preflight that nothing was opened', () => {
    // `EXECUTION_LEASE_NOT_HELD` now has two producers: the entry gate, which
    // really has opened nothing, and the gate before the workspace, by which
    // point the plan is read, durable state is loaded, an auth preflight has run
    // - two real subscription CLIs in production - and eight Git subprocesses
    // have gone by. "Nothing was opened" was true of the first and false of the
    // second.
    const sentence = START_OUTCOME_SENTENCES.EXECUTION_LEASE_NOT_HELD;

    expect(sentence).not.toContain('Nothing was opened');
    // What is true of both producers: nothing was created and nothing written.
    expect(sentence).toContain('Nothing was created and nothing was\n  written');
  });

  it('does not invite an operator to stop a process it cannot identify', () => {
    // The `ALIVE` liveness sentence was corrected to say a matching pid is not
    // proof of ownership. The acquisition refusal beside it still said the owner
    // "is running" and offered "wait for it, or stop it" - advice to act on
    // exactly the identification the other sentence had just disclaimed. Pid
    // reuse makes them contradictory, and `osProcessLiveness` maps `EPERM` to
    // `ALIVE`, which is explicitly somebody else's process.
    const refusal = LEASE_ACQUIRE_SENTENCES.LEASE_HELD;

    expect(refusal).not.toMatch(/stop it\./);
    expect(refusal).toContain('process ids are reused');
    // And it still tells the operator the useful thing.
    expect(refusal).toContain('Wait for it.');
  });
});

/* ─────────── 30. the gates whose refusal a later gate would repeat ─────── */

describe('a gate is proved by what it stops, when the outcome no longer differs', () => {
  it('does not enter the removal after the lease goes during the assessment', async () => {
    // `releaseTaskWorkspace` proves the lease at its entrance, again immediately
    // before calling `removeTaskWorkspace`, and that function proves it twice
    // more at its destructive commands. Once every one of them reports
    // `EXECUTION_LEASE_NOT_HELD`, the middle gate stopped changing any
    // assertion: the existing test for it releases the lease early enough that
    // the *inner* gate answers, so it was a counter-proof of the wrong gate and
    // the whole suite stayed green without it.
    //
    // What the middle gate is for is not the outcome. It is that an invocation
    // which has lost the lease does not go on to run four more Git subprocesses
    // against a repository it may not act on, and that the reason an operator
    // reads stays the specific one - `LEASE_ABSENT`, `NOT_OWNER`,
    // `LEASE_UNREADABLE` - rather than coarsening to the outcome's own name.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const crashed = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        git: runGitCommand,
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        replace: () => {
          throw new Error('simulated crash before the first durable write landed');
        },
      },
    );
    expect(crashed.outcome).toBe('STATE_NOT_RECORDED');

    // The lease goes after the entry gate has passed, so only the middle gate
    // or the inner one can catch it — and which of them did is exactly what the
    // reason code records. That is the observable this asserts on, rather than a
    // subprocess count, because the count depends on how many questions the
    // assessment happens to ask and would re-break whenever that changes.
    let entered = false;
    const released = await releaseTaskWorkspace(fixture.repository, TASK_ID, {
      git: async (cwd, args) => {
        const result = await runGitCommand(cwd, args);
        if (!entered) {
          entered = true;
          releaseRepositoryExecutionLease(evidence);
        }
        return result;
      },
      lease: evidence,
    });

    expect(released.outcome).toBe('EXECUTION_LEASE_NOT_HELD');
    // The middle gate answered, so the reason is the specific verification
    // result. With that gate gone, `removeTaskWorkspace`'s own gate answers
    // instead and the reason coarsens to the outcome's own name — which tells
    // an operator nothing about *why* the lease is not held.
    expect(released.reasonCodes).toContain('LEASE_ABSENT');
    expect(released.reasonCodes).not.toContain('EXECUTION_LEASE_NOT_HELD');
    expect(released.worktreeRemoved).toBe(false);
  });

  it('reports a resume write refused for the lease as a lost lease', async () => {
    // `run-driver` splits the resume write's failure three ways, and the branch
    // for a lost lease carries a comment recording that a review once found this
    // very site folding it into `STATE_NOT_RECORDED` "because the fix was
    // applied to its sibling and not to it". The fix landed; the counter-proof
    // did not, and collapsing the branch again left the whole suite green.
    //
    // The sibling site is covered. This is the one that was not.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: evidence },
    );
    expect(started.outcome).toBe('STARTED');

    // Park the task in a state an unattended resume drives, then lose the lease
    // during the reconciliation that precedes the resume write.
    const current = loadTaskState(fixture.root, TASK_ID);
    if (!current.ok) throw new Error('task did not start');

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
      {
        now: tickingClock(),
        git: runGitCommand,
        // The write itself is where the lease has to be gone: the driver's own
        // gate runs before this, and `advanceTaskState` refuses at the write.
        replace: (from, to) => {
          releaseRepositoryExecutionLease(evidence);
          renameSync(from, to);
        },
      },
    );

    expect(run.outcome).toBe('EXECUTION_LEASE_LOST');
    expect(run.outcome).not.toBe('STATE_NOT_RECORDED');
    expect(exitCodeForRunOutcome(run.outcome)).toBe(4);
  });
});

/* ─────────── 31. the leftovers a lost lease reports are the real ones ──── */

describe('a lost lease names what is actually left behind', () => {
  it('does not promise a worktree the rollback had already removed', async () => {
    // `EXECUTION_LEASE_LOST` said "the workspace it had already created is still
    // there". Its rollback producer has two exits: before `worktree remove`,
    // where that is true, and after it succeeded but before `branch -d`, where
    // the worktree is gone and only the branch remains.
    //
    // A review drove the second and watched an operator be sent to look for a
    // worktree that was not there, while the branch that *was* - the one that
    // refuses the next start with `WORKSPACE_COLLISION` - went unnamed. Twelve
    // rounds missed it because the two halves were tested in different files:
    // one drove the sentence with the early exit, the other drove the late exit
    // but stopped before any outcome was rendered.
    const sentence = START_OUTCOME_SENTENCES.EXECUTION_LEASE_LOST;

    expect(sentence).not.toContain('The workspace it had already created is');
    // True of both exits, and it names the branch, which is the leftover most
    // easily walked past.
    expect(sentence).toContain('had not already');
    expect(sentence).toContain('branch');
  });

  it('leaves only the branch when the rollback got that far, and says so', async () => {
    // The behavioural half, in one place this time: drive the *late* rollback
    // exit through the real `startTask` and check the leftovers against what the
    // operator is told.
    const fixture = await leasableRepository();
    const evidence = heldLease(fixture);

    let added = false;
    const started = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      {
        now: tickingClock(),
        authPreflight: authPreflightPasses,
        lease: evidence,
        git: async (cwd, args) => {
          const result = await runGitCommand(cwd, args);
          if (args[0] === 'worktree' && args[1] === 'add') added = true;
          // Gone *between* the two destructive commands, which is the exit that
          // leaves only the branch.
          if (args[0] === 'worktree' && args[1] === 'remove') {
            releaseRepositoryExecutionLease(evidence);
          }
          if (added && args[0] === 'rev-parse') {
            return Object.freeze({
              outcome: 'OK' as const,
              exitCode: 0,
              signal: null,
              stdout: '0000000000000000000000000000000000000000',
              stderr: '',
              outputTruncated: false,
              failureCode: null,
              errnoCode: null,
              durationMs: 0,
            });
          }
          return result;
        },
      },
    );

    expect(started.outcome).toBe('EXECUTION_LEASE_LOST');
    expect(started.residue).toBe(true);
    // The worktree really is gone and the branch really is there, which is
    // exactly the combination the old sentence denied.
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).not.toBe('');
  });
});
