/**
 * V3 slice 6 against the shipped artefact, with a real owner process that dies.
 *
 * ── Why this cannot be an in-process test ──────────────────────────────────
 *
 * The new integration boundary is "a previous invocation died holding the lease,
 * and this one continues the work". Every word of that is about a process other
 * than the one making the assertion:
 *
 *  - the lease must have been taken by a **different** operating-system process,
 *    through the real exclusive create, not by rewriting a pid field afterwards;
 *  - that process must be genuinely **gone**, so the liveness probe inside
 *    `recoverStaleLease` answers about a real death rather than about a number;
 *  - the writer-launch ledger must have been written **by that process, under
 *    that lease**, because the ledger is what licenses the removal at all;
 *  - and the recovery, the acquisition that follows it and the release that ends
 *    it must all run against `dist/`, because that is what ships.
 *
 * `tests/v3-06-lifecycle-driver.test.ts` fabricates a stale lease by rewriting
 * one field of a document this process wrote. That is the right instrument for
 * the refusals — the case never gets past the ledger — and it is the wrong one
 * for the permission, because the owner it names is the vitest worker with the
 * pid overwritten. This harness travels the chain end to end with one owner.
 *
 * ── What is measured, and what is deliberately not ─────────────────────────
 *
 * The subject is the **lease phase of `driveLifecycle`**: recover a provably
 * dead lease, then acquire through the ordinary path, then give it back and say
 * so. The task the run then drives is deliberately one the repository's plan
 * does not contain, so the run stops at `TASK_START_REFUSED` without starting an
 * agent, spending quota, or needing a worktree.
 *
 * That stop is not a weakness of the measurement — it *is* the measurement.
 * `startTask` is reached only after the lease has been acquired, so a non-null
 * `start` on the result is proof that the recovery was followed by a real
 * acquisition. A run that had recovered and then failed to acquire, or had
 * treated the removal as a grant, cannot produce one.
 *
 * Not measured here, on purpose, because in-process coverage is better for it:
 * the loop across invocations and per-phase crash continuation.
 *
 * ── The load-bearing case is the third ─────────────────────────────────────
 *
 * Phase C keeps the owner **alive**, with the same proved launch history phase A
 * was permitted on, so the only difference between them is that this process is
 * running. What it establishes is that **this driver never hands a live owner's
 * lease to a recovery at all** — the first acquire refuses `LEASE_HELD` and
 * `takeLease` returns before `recoverStaleLease` is reached, which the phase
 * asserts directly (`result.recovery === null`).
 *
 * It is deliberately *not* the control for the recovery predicate's own
 * liveness discrimination. That one lives in `test:dist-stale-recovery`, whose
 * fourth phase drives `recoverStaleLease` against a live owner and requires
 * `OWNER_RUNNING`. An earlier version of this header claimed phase C was what
 * stopped every `RECOVERED` above being an instrument that cannot tell a living
 * process from a dead one; it measures the layer above that.
 *
 * Phase B is the second control: a dead owner whose launch history was left open
 * must still be refused, and the lease must come out byte-identical.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', '..', 'dist');
const distLease = join(distDir, 'lease', 'execution-lease.js');
const distMint = join(distDir, 'core', 'internal', 'containment-attestation.js');
const distLifecycle = join(distDir, 'run', 'lifecycle-driver.js');
const distRepo = join(distDir, 'repo', 'resolve-repository.js');
const distGit = join(distDir, 'worktree', 'git-command.js');

const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

if (!existsSync(distLifecycle)) {
  process.stderr.write(
    'dist/run/lifecycle-driver.js is missing. Run `npm run build` before this check.\n',
  );
  process.exit(1);
}

const { driveLifecycle } = await import(pathToFileURL(distLifecycle).href);
const { resolveRepository } = await import(pathToFileURL(distRepo).href);
const { runGitCommand } = await import(pathToFileURL(distGit).href);
const { deriveExecutionLeaseLocation } = await import(pathToFileURL(distLease).href);

/* ─────────────────────────── the owner process ──────────────────────────── */

/**
 * A second operating-system process that takes the lease and keeps it.
 *
 * It exits still holding it in every phase but `LIVE`, which is the crash this
 * slice is about: nothing releases, and the record is left behind for the next
 * invocation to find.
 *
 * Every attestation it mints is real. `mintContainmentAttestation` is the only
 * producer, and a harness that fabricated the artefact would be measuring a hole
 * the opaque type exists to close.
 */
const OWNER_SOURCE = `
import { join } from 'node:path';
import {
  acquireRepositoryExecutionLease,
  beginWriterLaunch,
  confirmWriterLaunch,
} from ${JSON.stringify(pathToFileURL(distLease).href)};
import { mintContainmentAttestation } from ${JSON.stringify(pathToFileURL(distMint).href)};

const root = process.env.AO_LIFECYCLE_DIR;
const phase = process.env.AO_LIFECYCLE_PHASE;
const repository = { gitCommonDir: join(root, '.git'), root, id: 'lifecycle-fixture' };
const now = () => new Date().toISOString();

const acquired = acquireRepositoryExecutionLease(
  repository,
  { runId: 'dist-lifecycle', blockId: null },
  { now },
);
if (!acquired.ok) {
  process.stderr.write('owner could not take the lease: ' + acquired.code);
  process.exit(2);
}

const open = (writerId) => {
  const opened = beginWriterLaunch(repository, acquired.evidence, { writerId, now });
  if (opened.code !== 'OPENED') {
    process.stderr.write('owner could not open a generation: ' + opened.code);
    process.exit(3);
  }
  return opened.generation;
};

if (phase === 'CONTAINED' || phase === 'LIVE') {
  // One proved launch. The history the predicate must accept.
  const generation = open('claude');
  const attestation = mintContainmentAttestation({
    ownerPid: process.pid,
    helperPid: 4242,
    childPid: 4343,
    mode: 'JOBLIST',
    assignedAtCreation: true,
    launchNonce: 'c0ffee1234567890',
    attestedAt: now(),
    verifiedInJob: true,
  });
  if (attestation === null) {
    process.stderr.write('owner could not mint an attestation');
    process.exit(4);
  }
  const confirmed = confirmWriterLaunch(repository, acquired.evidence, attestation, {
    generation,
    writerId: 'claude',
    now,
  });
  if (confirmed.code !== 'CONFIRMED') {
    process.stderr.write('owner could not confirm: ' + confirmed.code);
    process.exit(5);
  }
} else if (phase === 'PENDING') {
  // Opened and abandoned: the state the poison-before-launch ordering leaves
  // when a process dies between the two calls.
  open('claude');
}

process.stdout.write('pid ' + process.pid + '\\n');
process.stdout.write('ready\\n');

if (phase === 'LIVE') {
  // Parked, deliberately. The control needs a process that is really running,
  // and one that exited would make it measure teardown instead of liveness.
  setInterval(() => {}, 1000);
}
`;

/**
 * Runs one owner process and resolves with its pid once it says `ready`.
 *
 * Bounded. A child that neither prints `ready` nor exits would otherwise hang
 * the canonical gate with no timeout above it, and `npm run verify` has no
 * per-script bound of its own.
 */
function startOwner(root, phase) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', OWNER_SOURCE], {
      env: { ...process.env, AO_LIFECYCLE_DIR: root, AO_LIFECYCLE_PHASE: phase },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`owner (${phase}) never became ready`));
    }, 60_000);
    timer.unref();
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const match = /pid (\d+)/.exec(out);
      if (match !== null && out.includes('ready')) {
        clearTimeout(timer);
        resolvePromise({ pid: Number(match[1]), child });
      }
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!out.includes('ready')) {
        rejectPromise(new Error(`owner (${phase}) exited ${String(code)}: ${err || out}`));
      }
    });
  });
}

/** Waits until the owner process has really gone. */
async function awaitDeath(pid, child) {
  await new Promise((resolvePromise) => {
    if (child.exitCode !== null) resolvePromise();
    else child.on('exit', () => resolvePromise());
  });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  // Killed before throwing. The `finally` below sweeps the repositories but has
  // no handle on a child this function was still waiting for, so giving up here
  // without killing leaves a real process behind for the rest of the gate.
  child.kill();
  throw new Error(`owner ${String(pid)} never died`);
}

/* ───────────────────────────── the repository ───────────────────────────── */

const PROFILE = `schemaVersion: 1
repository:
  id: lifecycle-fixture
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: VERIFY
      command: [git, --version]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: 3
remote:
  required: false
`;

const created = [];

/** A real Git repository with a real profile and an empty task directory. */
function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ao-lifecycle-dist-'));
  created.push(root);
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '' },
    });
  git(['init', '-b', 'main', '--quiet']);
  git(['config', 'user.name', 'AgentOrchestrator']);
  git(['config', 'user.email', 'agent-orchestrator@local.invalid']);
  mkdirSync(join(root, '.agent-orchestrator'), { recursive: true });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.gitattributes'), '* -text\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# lifecycle fixture\n', 'utf8');
  writeFileSync(join(root, '.gitignore'), '.agent-orchestrator/runtime/\n', 'utf8');
  writeFileSync(
    join(root, '.agent-orchestrator', 'repo-profile.yaml'),
    PROFILE,
    'utf8',
  );
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'fixture']);
  return root;
}

/**
 * The lease bytes, or `null` when there is no lease.
 *
 * Absence is an *answer* here, not an error. Every case below that compares
 * bytes is asserting the lease was left alone, and a removal is exactly the
 * failure it is looking for — reading with `readFileSync` would turn that
 * failure into an uncaught ENOENT and lose the message. Measured, not assumed:
 * the mutant that drops the stale-recovery grant check crashed this harness
 * instead of failing it.
 */
function leaseBytes(repository) {
  const path = leasePathOf(repository);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function leasePathOf(repository) {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) throw new Error(`no lease location: ${location.code}`);
  return location.path;
}

/**
 * Drives the lifecycle against the fixture.
 *
 * The task id names nothing in the plan, so `startTask` refuses and no agent is
 * ever reached. The auth preflight is a stub that produces nothing: if
 * `startTask` gets as far as asking, its refusal is still a start refusal, and
 * either way the lease phase has already happened.
 */
async function drive(repository, options) {
  return driveLifecycle(
    {
      repository,
      taskId: 'no-such-task',
      continuationGrant: true,
      recoverStaleLease: options.recoverStaleLease,
      maxSteps: 1,
      maxInvocations: 1,
    },
    {
      now: () => new Date().toISOString(),
      git: runGitCommand,
      authPreflight: async () => null,
    },
  );
}

/* ─────────────────────────────── the phases ─────────────────────────────── */

const ROUNDS = 2;

/**
 * Cleanup runs in a `finally`, not straight-line at the end.
 *
 * Every phase below can throw before reaching it — a fixture that does not
 * resolve, an owner that never says `ready`, an owner that never dies — and a
 * straight-line sweep leaks up to eight real git repositories per run into the
 * temp directory. Phase C's live owner is killed in its own `finally` already;
 * this covers the directories.
 */
try {
for (let round = 0; round < ROUNDS; round += 1) {
  /* ── A. a dead owner whose launches were proved: recovered, then acquired ── */
  {
    const root = repositoryFixture();
    const resolution = await resolveRepository({ repositoryPath: root });
    if (!resolution.ok) throw new Error(`fixture did not resolve: ${resolution.code}`);
    const repository = resolution.repository;

    const owner = await startOwner(root, 'CONTAINED');
    await awaitDeath(owner.pid, owner.child);
    check(
      existsSync(leasePathOf(repository)),
      `A${round}: the dead owner should have left its lease behind`,
    );

    const result = await drive(repository, { recoverStaleLease: true });

    check(
      result.recovery !== null && result.recovery.code === 'RECOVERED',
      `A${round}: expected RECOVERED, got ${String(result.recovery && result.recovery.code)}`,
    );
    // The proof that a real acquisition followed the removal. `startTask` is
    // unreachable without one, so a non-null start cannot be produced by a run
    // that treated the removal as a grant or lost the race afterwards.
    check(
      result.start !== null,
      `A${round}: the run never reached startTask, so it never acquired`,
    );
    check(
      result.outcome === 'TASK_START_REFUSED',
      `A${round}: expected TASK_START_REFUSED, got ${result.outcome}`,
    );
    // And it gave the lease back, provably, rather than reporting a clean exit
    // over a leftover.
    check(
      result.release !== null && result.release.code === 'RELEASED',
      `A${round}: expected RELEASED, got ${String(result.release && result.release.code)}`,
    );
    check(
      !existsSync(leasePathOf(repository)),
      `A${round}: the lease file is still on disk after a reported release`,
    );
  }

  /* ── B. a dead owner with an unproven launch: refused, lease untouched ──── */
  {
    const root = repositoryFixture();
    const resolution = await resolveRepository({ repositoryPath: root });
    if (!resolution.ok) throw new Error(`fixture did not resolve: ${resolution.code}`);
    const repository = resolution.repository;

    const owner = await startOwner(root, 'PENDING');
    await awaitDeath(owner.pid, owner.child);
    const before = leaseBytes(repository);

    const result = await drive(repository, { recoverStaleLease: true });

    check(
      result.outcome === 'RECOVERY_UNSAFE',
      `B${round}: expected RECOVERY_UNSAFE, got ${result.outcome}`,
    );
    check(
      result.recovery !== null && result.recovery.refusal === 'LAUNCH_HISTORY_UNPROVEN',
      `B${round}: expected LAUNCH_HISTORY_UNPROVEN, got ${String(
        result.recovery && result.recovery.refusal,
      )}`,
    );
    check(result.start === null, `B${round}: nothing may be started on a refusal`);
    check(result.release === null, `B${round}: nothing was held, so nothing was released`);
    check(
      leaseBytes(repository) === before,
      `B${round}: the lease bytes changed under a refused recovery`,
    );
  }

  /* ── C. the control: a LIVE owner is never recovered ────────────────────── */
  {
    const root = repositoryFixture();
    const resolution = await resolveRepository({ repositoryPath: root });
    if (!resolution.ok) throw new Error(`fixture did not resolve: ${resolution.code}`);
    const repository = resolution.repository;

    const owner = await startOwner(root, 'LIVE');
    const before = leaseBytes(repository);
    try {
      // Its launch history is complete and proved — exactly the history phase A
      // was permitted on. The only difference is that this process is running,
      // and that difference alone must refuse the removal.
      const result = await drive(repository, { recoverStaleLease: true });

      check(
        result.outcome === 'LIVE_OWNER_PRESENT',
        `C${round}: expected LIVE_OWNER_PRESENT, got ${result.outcome}`,
      );
      check(
        result.acquire === 'LEASE_HELD',
        `C${round}: expected LEASE_HELD, got ${String(result.acquire)}`,
      );
      check(
        result.recovery === null,
        `C${round}: a live owner's lease must not be handed to a recovery at all`,
      );
      check(result.start === null, `C${round}: nothing may be started against a live owner`);
      check(
        leaseBytes(repository) === before,
        `C${round}: a live owner's lease bytes changed`,
      );
    } finally {
      owner.child.kill();
      await awaitDeath(owner.pid, owner.child);
    }
  }

  /* ── D. a stale lease with no grant is left exactly where it is ─────────── */
  {
    const root = repositoryFixture();
    const resolution = await resolveRepository({ repositoryPath: root });
    if (!resolution.ok) throw new Error(`fixture did not resolve: ${resolution.code}`);
    const repository = resolution.repository;

    const owner = await startOwner(root, 'CONTAINED');
    await awaitDeath(owner.pid, owner.child);
    const before = leaseBytes(repository);

    const result = await drive(repository, { recoverStaleLease: false });

    check(
      result.outcome === 'STALE_LEASE_PRESENT',
      `D${round}: expected STALE_LEASE_PRESENT, got ${result.outcome}`,
    );
    check(
      result.recovery === null,
      `D${round}: a run without the grant must not call the recovery at all`,
    );
    check(
      leaseBytes(repository) === before,
      `D${round}: a recoverable lease was touched by a run that had no grant`,
    );
  }
}

} finally {
  for (const root of created) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (failures.length > 0) {
  process.stderr.write(`\nlifecycle-restart-dist-artifact: ${failures.length} failure(s)\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `lifecycle-restart-dist-artifact: ${String(checks)} checks passed across ${String(ROUNDS)} rounds\n`,
);
