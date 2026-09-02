/**
 * M3 slice 1 against the shipped CLI, with a real process stopped and a
 * different one started in its place.
 *
 * ── Why this cannot be an in-process test ──────────────────────────────────
 *
 * The slice's whole claim is about a process that is not the one making the
 * assertion: "AgentOrchestrator stops while work is waiting, and a LATER
 * AgentOrchestrator process reconstructs that wait from durable state." Calling
 * `driveScheduler` twice inside one vitest worker and calling the second call a
 * restart would prove that a function can be called twice. Here the first
 * process is really started, really put to sleep by its own scheduler, really
 * terminated with `taskkill /F` while the reset is still ahead, and a second,
 * completely separate process is started afterwards with the same arguments and
 * no knowledge of what the first one was waiting for.
 *
 * `tests/m3-01-persistent-scheduler.test.ts` measures the values — the wake
 * horizon read off disk, the arithmetic, the fail-closed ordering, the argument
 * refusals — with an injected clock and an injected sleep, because a test that
 * really waited three hours is not a test. Neither file replaces the other.
 *
 * ── What is deterministic on every machine, and what is not ────────────────
 *
 * Every path that drives a task runs the real auth preflight, which starts the
 * subscription CLIs: it passes on a developer machine and fails on CI. That is a
 * property of the machine, so no assertion here may depend on it. What every
 * assertion here depends on instead is decided before or after any preflight:
 *
 *  - the durable wake horizon, which is read from state files with no lease and
 *    no preflight, and is printed verbatim;
 *  - whether the process was still alive when a non-waiting one would have
 *    exited — measured against a **control run of the same fixture without the
 *    wait flags**, so the threshold adapts to the machine rather than being a
 *    constant somebody guessed;
 *  - the effects: task-state bytes, branches, worktrees and the lease file;
 *  - that the post-wake pass reached an ending only reachable **under the
 *    lease**. Two such endings are possible and the machine decides which:
 *    `BLOCKED_USAGE_LIMIT`, when the preflight passed and the resume was then
 *    judged, and `AUTH_PREFLIGHT_FAILED`, when it did not. Both are produced by
 *    `finish(...)`, which releases; neither is reachable without an acquisition.
 *    A lease refusal — `LIVE_OWNER_PRESENT` and friends — is not in that set,
 *    which is what makes the assertion mean something.
 *
 * ── Why no agent can ever start here ───────────────────────────────────────
 *
 * Every fixture records `worktreeCleanAtCheckpoint: false` on a worktree that
 * really exists and really holds the recorded branch. So reconciliation is
 * CONSISTENT — the run gets all the way to the resume decision, which is the
 * point — and `evaluateAutomaticResume` then denies with `WORKTREE_NOT_CLEAN`,
 * which no passage of time can change. The reset is the only *other* thing
 * outstanding, so the scheduler's wake behaviour is exercised in full while the
 * resume itself remains impossible. Measured, not assumed: without the wait
 * flags this fixture reports `BLOCKED_USAGE_LIMIT / WORKTREE_NOT_CLEAN`.
 *
 * ── The five phases ────────────────────────────────────────────────────────
 *
 *  A. control — the same fixture, the same CLI, no wait flags. It must return
 *     without waiting. This is the pre-change behaviour and the timing baseline.
 *  B. stop and restart — one process sleeps and is killed before the reset; a
 *     fresh one reconstructs the same instant from disk, waits it out, and runs
 *     a second pass under a real lease.
 *  C. a block recording NO reset is never scheduled, and says so.
 *  D. a waiting repository does not stall a second one: both are admitted in the
 *     first pass, before any sleep.
 *  E. two schedulers cannot both execute one repository. A third process holds
 *     the lease across the moment both wake; both must be refused, and the lease
 *     document must come out byte-identical.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', '..', 'dist');
const distEntry = join(distDir, 'cli', 'index.js');
const preload = join(here, 'scheduler-preload.cjs');

const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

if (!existsSync(distEntry)) {
  process.stderr.write('dist/cli/index.js is missing. Run `npm run build` before this check.\n');
  process.exit(1);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Awaits `promise`, giving up after `ms`, and **clears the timer either way**.
 *
 * Written out rather than `Promise.race([promise, sleep(ms)])`, because that
 * spelling is a trap this harness fell into: `race` settles on the winner and
 * abandons the loser, so a ten-minute guard timer stays armed and keeps the
 * process alive for ten minutes after the work it was guarding finished. The
 * first version of this file hung for exactly that reason.
 */
function withTimeout(promise, ms, timeoutValue) {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(timeoutValue), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        settle(value);
      },
      () => {
        clearTimeout(timer);
        settle(timeoutValue);
      },
    );
  });
}

/* ───────────────────────────── the fixtures ─────────────────────────────── */

const created = [];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function put(root, relativePath, contents) {
  const target = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function profileYaml(id) {
  return `schemaVersion: 1
repository:
  id: ${id}
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: .agent-orchestrator/tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: VERIFY
      command: [node, --version]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: 1
remote:
  required: false
`;
}

function taskFile(id) {
  return `---
id: ${id}
title: task ${id}
status: OPEN
kind: NORMAL
priority: NORMAL
currentFocus: false
dependsOn: []
---
body
`;
}

/**
 * A real Git repository, canonicalised.
 *
 * `realpathSync.native` for the reason `lifecycle-restart-dist-artifact.mjs`
 * gives at length: a GitHub Windows runner's `tmpdir()` is the 8.3 short form,
 * and a fixture that keeps one hands a different spelling to whoever resolves
 * it. The CLI resolves the directory itself; nothing here hand-builds a
 * repository record.
 */
function makeRepository(id, taskIds) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-m3s1-')));
  created.push(root);
  git(root, ['init', '-b', 'main', '--quiet']);
  put(root, '.gitattributes', '* -text\n');
  put(root, '.gitignore', '.agent-orchestrator/runtime/\n');
  put(root, 'README.md', `# ${id}\n`);
  put(root, '.agent-orchestrator/repo-profile.yaml', profileYaml(id));
  for (const taskId of taskIds) put(root, `.agent-orchestrator/tasks/${taskId}.md`, taskFile(taskId));
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return { root, id };
}

/** The workspace identity the product derives, reproduced for the fixture only. */
function identityOf(root, taskId) {
  const parent = dirname(root);
  const base = root.slice(parent.length + 1);
  return {
    worktreeParent: join(parent, `${base}.worktrees`),
    worktreePath: join(parent, `${base}.worktrees`, taskId),
    workBranch: `ao/task/${taskId}`,
  };
}

/**
 * A real worktree on the derived branch, plus a durable `BLOCKED_USAGE_LIMIT`
 * state naming it.
 *
 * The state is hand-written because the subject of this harness is what a fresh
 * process reads back **from disk**, and producing one by driving a real agent
 * would need a real agent. It is validated on the way back in by
 * `loadTaskState`, which is the same gate every production reader passes.
 */
function parkTask(repository, taskId, reportedResetAt) {
  const identity = identityOf(repository.root, taskId);
  git(repository.root, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    identity.workBranch,
    identity.worktreePath,
    'HEAD',
  ]);
  created.push(identity.worktreeParent);
  const head = git(repository.root, ['rev-parse', 'HEAD']).trim();
  const state = {
    schemaVersion: 1,
    taskId,
    repositoryId: repository.id,
    repositoryRoot: repository.root,
    worktreePath: realpathSync.native(identity.worktreePath),
    state: 'BLOCKED_USAGE_LIMIT',
    stateEnteredAt: '2026-09-01T00:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: head,
    scopeAuthorityCommit: null,
    workBranch: identity.workBranch,
    currentCommit: head,
    reviewRound: 0,
    maxReviewRounds: 1,
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    reportedResetAt,
    // The one field that makes the resume permanently impossible. See the
    // header: it keeps every fixture here from ever starting an agent, while
    // leaving the reset as the only other thing outstanding.
    worktreeCleanAtCheckpoint: false,
    findingHistory: [],
  };
  const path = join(repository.root, '.agent-orchestrator', 'runtime', `${taskId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { path, statePath: path, reportedResetAt };
}

/** Rewrites only the reset instant of an already-parked task. */
function reparkAt(statePath, reportedResetAt) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.reportedResetAt = reportedResetAt;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return reportedResetAt;
}

/** A scratch operator profile holding a registry that names `roots`. */
function operatorProfile(roots, maxConcurrentRepositories) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-m3s1-home-')));
  created.push(home);
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  const lines = ['schemaVersion: 1', 'repositories:'];
  for (const root of roots) lines.push(`  - path: ${JSON.stringify(root)}`);
  if (maxConcurrentRepositories !== undefined) {
    lines.push(`maxConcurrentRepositories: ${String(maxConcurrentRepositories)}`);
  }
  writeFileSync(join(home, '.agent-orchestrator', 'repositories.yaml'), `${lines.join('\n')}\n`, 'utf8');
  return home;
}

/* ──────────────────────────── the instruments ───────────────────────────── */

function leasePathOf(root) {
  return join(root, '.git', 'agent-orchestrator-execution-lease.json');
}

/** Every trace an execution would leave, read with real Git and real `fs`. */
function traces(root) {
  return {
    branches: git(root, ['branch', '--list', 'ao/task/*']).trim(),
    worktrees: git(root, ['worktree', 'list']).trim(),
    lease: existsSync(leasePathOf(root)),
  };
}

const CLI_ARGS = ['--attended', '--max-steps', '1', '--max-invocations', '1'];

function runCli(args, home, timeoutMs = 600_000) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--require', preload, distEntry, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env: { ...process.env, AGENT_LOOP_TEST_PROFILE: home },
  });
  return { ...result, elapsedMs: Date.now() - startedAt, finishedAt: Date.now() };
}

function startCli(args, home) {
  const child = spawn(process.execPath, ['--require', preload, distEntry, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_LOOP_TEST_PROFILE: home },
  });
  let stdout = '';
  let stderr = '';
  let exited = null;
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise((settle) => {
    child.on('close', (code) => {
      exited = code;
      settle(code);
    });
  });
  return {
    child,
    done,
    startedAt: Date.now(),
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    alive: () => exited === null,
  };
}

/** Terminates one process and waits until it is really gone. */
async function killAndWait(handle) {
  if (!handle.alive()) return;
  try {
    execFileSync('taskkill', ['/PID', String(handle.child.pid), '/F'], { stdio: 'pipe' });
  } catch {
    // Already gone, or not Windows: fall through to the wait below.
    try {
      handle.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await withTimeout(handle.done, 30_000, 'TIMEOUT');
}

/** The one `waits until` instant a scheduler report names, or `null`. */
function reportedWakeInstant(text) {
  const match = /waits until\s*:\s*(\S+)/.exec(text);
  return match === null ? null : match[1];
}

/** The admission outcomes a report names, in order. */
function admissionOutcomes(text) {
  return [...text.matchAll(/^\s*outcome\s*:\s*(\S+)\s*$/gm)].map((match) => match[1]);
}

/**
 * Endings only reachable **under the lease**.
 *
 * See the header. Both are produced by `driveUnderLease`'s `finish`, so either
 * proves the post-wake pass acquired the repository and gave it back; a lease
 * refusal is not among them, which is what makes the assertion non-vacuous.
 */
const UNDER_LEASE_OUTCOMES = new Set(['BLOCKED_USAGE_LIMIT', 'AUTH_PREFLIGHT_FAILED']);

/* ══════════════ A. the control: the same fixture, without waiting ════════ */

const phaseA = makeRepository('m3s1-control', ['SCHED-A']);
const parkedA = parkTask(phaseA, 'SCHED-A', new Date(Date.now() + 3_600_000).toISOString());
const homeA = operatorProfile([phaseA.root]);
const bytesBeforeControl = readFileSync(parkedA.statePath);

const control = runCli(['repositories', ...CLI_ARGS], homeA);

check(
  control.status === 3,
  `A: the control run should need an operator (exit 3), got ${String(control.status)}\n${control.stdout}${control.stderr}`,
);
check(
  control.elapsedMs < 600_000,
  `A: the control run did not return at all (${String(control.elapsedMs)} ms)`,
);
// The pre-change behaviour, measured: an hour-away reset and the command still
// returns at once. This is the gap the slice closes.
check(
  control.elapsedMs < 60_000,
  `A: the control run should not have waited; it took ${String(control.elapsedMs)} ms`,
);
check(
  readFileSync(parkedA.statePath).equals(bytesBeforeControl),
  'A: the control run changed the durable task state',
);
check(
  admissionOutcomes(control.stdout).every((outcome) => UNDER_LEASE_OUTCOMES.has(outcome)),
  `A: the control run did not reach an under-lease ending: ${admissionOutcomes(control.stdout).join(', ')}\n${control.stdout}`,
);
check(!traces(phaseA.root).lease, 'A: the control run left an execution lease behind');
check(
  !control.stdout.includes('Scheduler       :'),
  'A: a run without --wait-for-reset printed a scheduler report',
);

/**
 * The machine's own pace, used as the threshold below.
 *
 * A constant here would be a guess about a runner nobody has measured; this is
 * the same fixture, the same binary and the same preflight, so a slow machine
 * moves the threshold with it.
 */
const passMs = Math.max(control.elapsedMs, 1_000);
const leadMs = Math.max(30_000, passMs * 5);

/* ═════════════ B. stop while waiting, restart, and resume ════════════════ */

const resetB = reparkAt(parkedA.statePath, new Date(Date.now() + leadMs).toISOString());
const bytesBeforeWait = readFileSync(parkedA.statePath);
const tracesBeforeWait = traces(phaseA.root);

const WAIT_ARGS = [
  'repositories',
  ...CLI_ARGS,
  '--wait-for-reset',
  '--max-wait-ms',
  '600000',
  '--max-cycles',
  '3',
];

const first = startCli(WAIT_ARGS, homeA);

// Long enough for the pass to be over on this machine, and far short of the
// reset. If the build did not wait, the process would have exited by now.
await sleep(passMs * 2 + 2_000);

check(first.alive(), `B: the scheduler exited instead of waiting (code ${String(first.exited)})\n${first.stdout}${first.stderr}`);
check(
  !existsSync(leasePathOf(phaseA.root)),
  'B: the scheduler was holding an execution lease while it waited',
);
const tracesWhileWaiting = traces(phaseA.root);
check(
  tracesWhileWaiting.branches === tracesBeforeWait.branches,
  `B: a branch appeared while the scheduler waited\n${tracesWhileWaiting.branches}`,
);
check(
  tracesWhileWaiting.worktrees === tracesBeforeWait.worktrees,
  'B: a worktree appeared while the scheduler waited',
);
check(
  readFileSync(parkedA.statePath).equals(bytesBeforeWait),
  'B: the durable task state changed while the scheduler waited',
);

await killAndWait(first);

check(
  readFileSync(parkedA.statePath).equals(bytesBeforeWait),
  'B: killing the sleeping scheduler changed the durable task state',
);
check(!existsSync(leasePathOf(phaseA.root)), 'B: the killed scheduler left an execution lease');
check(Date.now() < Date.parse(resetB), 'B: the fixture reset passed before the process was killed');

// A completely fresh process, given the same arguments and told nothing about
// what the first one was waiting for.
const second = startCli(WAIT_ARGS, homeA);
const secondCode = await withTimeout(second.done, leadMs + 600_000, 'TIMEOUT');

check(secondCode !== 'TIMEOUT', 'B: the restarted scheduler never finished');
check(
  Date.now() > Date.parse(resetB),
  'B: the restarted scheduler finished BEFORE the reset it was waiting for',
);
// The load-bearing assertion of the whole slice: the instant is the one on
// disk, printed verbatim by a process that was never told it.
check(
  reportedWakeInstant(second.stdout) === resetB,
  `B: the restarted scheduler did not reconstruct the wait from disk; expected ${resetB}, report said ${String(reportedWakeInstant(second.stdout))}\n${second.stdout}`,
);
check(
  second.stdout.includes('Scheduler       : WAITED'),
  `B: the restarted scheduler did not report a wait\n${second.stdout}`,
);
check(
  second.stdout.includes('── cycle 2 of 2 ──'),
  `B: the restarted scheduler did not run a second pass\n${second.stdout}`,
);
check(
  second.stdout.includes('Ending          : NO_FUTURE_WAKE'),
  `B: the restarted scheduler did not end with the wait discharged\n${second.stdout}`,
);
const secondOutcomes = admissionOutcomes(second.stdout);
check(
  secondOutcomes.length === 2 && secondOutcomes.every((outcome) => UNDER_LEASE_OUTCOMES.has(outcome)),
  `B: the post-wake pass did not reach an ending only an acquired lease can produce: ${secondOutcomes.join(', ')}\n${second.stdout}`,
);
check(
  readFileSync(parkedA.statePath).equals(bytesBeforeWait),
  'B: the restarted scheduler changed the durable task state',
);
check(!existsSync(leasePathOf(phaseA.root)), 'B: the restarted scheduler left an execution lease');

/* ══════════ C. a block with no reset is never scheduled, and says so ══════ */

const phaseC = makeRepository('m3s1-null-reset', ['SCHED-C']);
const parkedC = parkTask(phaseC, 'SCHED-C', null);
const homeC = operatorProfile([phaseC.root]);
const bytesBeforeC = readFileSync(parkedC.statePath);

const noReset = runCli(WAIT_ARGS, homeC);

check(
  noReset.stdout.includes('Ending          : NO_FUTURE_WAKE'),
  `C: a block with no reset produced something other than NO_FUTURE_WAKE\n${noReset.stdout}`,
);
check(
  !noReset.stdout.includes('Scheduler       : WAITED'),
  `C: a block with no reset was waited for\n${noReset.stdout}`,
);
check(
  noReset.stdout.includes('--continue-usage-limit'),
  'C: the report did not name the operator escape a block with no reset needs',
);
// It did not sleep: the same work as the control, in the same order of time.
check(
  noReset.elapsedMs < passMs * 4 + 5_000,
  `C: a block with no reset appears to have waited (${String(noReset.elapsedMs)} ms against a ${String(passMs)} ms pass)`,
);
check(
  readFileSync(parkedC.statePath).equals(bytesBeforeC),
  'C: the run changed a durable state it may not schedule',
);

/* ═══════ D. a waiting repository does not stall a second one ═════════════ */

const phaseD1 = makeRepository('m3s1-waiting', ['SCHED-D1']);
const phaseD2 = makeRepository('m3s1-other', ['SCHED-D2']);
const parkedD1 = parkTask(phaseD1, 'SCHED-D1', new Date(Date.now() + 3_600_000).toISOString());
// Its reset is already behind, so this repository contributes no wake and is
// simply driven in the first pass, beside the one that does.
parkTask(phaseD2, 'SCHED-D2', new Date(Date.now() - 3_600_000).toISOString());
const homeD = operatorProfile([phaseD1.root, phaseD2.root], 2);
const bytesBeforeD1 = readFileSync(parkedD1.statePath);

const multi = runCli(
  ['repositories', ...CLI_ARGS, '--wait-for-reset', '--max-wait-ms', '60000', '--max-cycles', '4'],
  homeD,
);

check(
  multi.stdout.includes('m3s1-waiting') && multi.stdout.includes('m3s1-other'),
  `D: the first pass did not admit both repositories\n${multi.stdout}`,
);
check(
  admissionOutcomes(multi.stdout).length === 2,
  `D: expected two admissions in the single pass, got ${String(admissionOutcomes(multi.stdout).length)}\n${multi.stdout}`,
);
// The wake names the waiting repository only, and the bound then stops the
// invocation rather than sleeping an hour.
check(
  multi.stdout.includes('Ending          : BOUND_EXCEEDED'),
  `D: an hour-away reset under a one-minute bound should end BOUND_EXCEEDED\n${multi.stdout}`,
);
check(
  multi.stdout.includes('SCHED-D1') && !multi.stdout.includes('waits until     : ') === false,
  `D: the report did not name the waiting task's wake\n${multi.stdout}`,
);
check(
  multi.elapsedMs < passMs * 6 + 5_000,
  `D: the run waited when its bound said it must not (${String(multi.elapsedMs)} ms)`,
);
check(
  readFileSync(parkedD1.statePath).equals(bytesBeforeD1),
  'D: the waiting repository was touched before its reset',
);

/* ═══════ E. two schedulers cannot both execute one repository ════════════ */

/**
 * A separate process that takes the repository's real execution lease through
 * the shipped module and holds it until told to stop.
 *
 * A third process rather than a contrived one: the question is what two
 * schedulers do when the repository is already owned at the moment they wake,
 * and the only honest way to arrange that moment is to have a living owner
 * across it. It resolves the repository itself, exactly as the CLI does, so the
 * lease key both sides derive is the product's own.
 */
const HOLDER_SOURCE = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const lease = await import(process.env.AO_HOLDER_LEASE_MODULE);
const repo = await import(process.env.AO_HOLDER_RESOLVE_MODULE);
const resolution = await repo.resolveRepository({ repositoryPath: process.env.AO_HOLDER_ROOT });
if (!resolution.ok) { console.log('HOLDER_FAILED ' + resolution.code); process.exit(1); }
const acquired = lease.acquireRepositoryExecutionLease(
  resolution.repository,
  { runId: null, blockId: null },
  { now: () => new Date().toISOString() },
);
if (!acquired.ok) { console.log('HOLDER_FAILED ' + acquired.code); process.exit(1); }
console.log('HOLDER_READY');
const stopFile = process.env.AO_HOLDER_STOP;
for (;;) {
  if (existsSync(stopFile)) break;
  await new Promise((done) => setTimeout(done, 50));
}
lease.releaseRepositoryExecutionLease(acquired.evidence);
console.log('HOLDER_RELEASED');
`;

const phaseE = makeRepository('m3s1-race', ['SCHED-E']);
const parkedE = parkTask(phaseE, 'SCHED-E', new Date(Date.now() + 3_600_000).toISOString());
const homeE = operatorProfile([phaseE.root]);
const stopFile = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-m3s1-stop-'))), 'stop');
created.push(dirname(stopFile));

const holder = spawn(process.execPath, ['--input-type=module', '-e', HOLDER_SOURCE], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AO_HOLDER_LEASE_MODULE: pathToFileURL(join(distDir, 'lease', 'execution-lease.js')).href,
    AO_HOLDER_RESOLVE_MODULE: pathToFileURL(join(distDir, 'repo', 'resolve-repository.js')).href,
    AO_HOLDER_ROOT: phaseE.root,
    AO_HOLDER_STOP: stopFile,
  },
});
let holderOut = '';
holder.stdout.on('data', (chunk) => {
  holderOut += String(chunk);
});
holder.stderr.on('data', (chunk) => {
  holderOut += String(chunk);
});

const holderDeadline = Date.now() + 120_000;
while (!holderOut.includes('HOLDER_READY') && Date.now() < holderDeadline) await sleep(50);
check(holderOut.includes('HOLDER_READY'), `E: the lease holder never took the lease: ${holderOut}`);

const leaseBytesBefore = existsSync(leasePathOf(phaseE.root))
  ? readFileSync(leasePathOf(phaseE.root))
  : null;
const bytesBeforeE = readFileSync(parkedE.statePath);

// Both schedulers meet a repository whose reset is an hour away, so both read
// the same wake and both stop on the same bound — having first tried, and been
// refused, the lease the holder owns.
const raceArgs = [
  'repositories',
  ...CLI_ARGS,
  '--wait-for-reset',
  '--max-wait-ms',
  '60000',
  '--max-cycles',
  '4',
];
const racerA = startCli(raceArgs, homeE);
const racerB = startCli(raceArgs, homeE);
await Promise.all([racerA.done, racerB.done]);

for (const [name, racer] of [
  ['A', racerA],
  ['B', racerB],
]) {
  const outcomes = admissionOutcomes(racer.stdout);
  check(
    outcomes.length === 1 && outcomes[0] === 'LIVE_OWNER_PRESENT',
    `E: scheduler ${name} was not refused by the live owner: ${outcomes.join(', ')}\n${racer.stdout}`,
  );
  check(
    reportedWakeInstant(racer.stdout) === parkedE.reportedResetAt,
    `E: scheduler ${name} did not read the same durable wake\n${racer.stdout}`,
  );
}

check(
  leaseBytesBefore !== null && readFileSync(leasePathOf(phaseE.root)).equals(leaseBytesBefore),
  'E: the holder’s lease document was not byte-identical after both schedulers ran',
);
check(
  readFileSync(parkedE.statePath).equals(bytesBeforeE),
  'E: a refused scheduler still changed the durable task state',
);

writeFileSync(stopFile, 'stop', 'utf8');
await withTimeout(new Promise((done) => holder.on('close', done)), 60_000, 'TIMEOUT');
try {
  execFileSync('taskkill', ['/PID', String(holder.pid), '/F'], { stdio: 'pipe' });
} catch {
  /* already gone */
}

/* ─────────────────────────────── the verdict ────────────────────────────── */

for (const path of created) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // A locked Git file on Windows must not fail an otherwise passing check.
  }
}

if (failures.length > 0) {
  process.stderr.write(`persistent-scheduler: ${String(failures.length)} of ${String(checks)} checks failed\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`persistent-scheduler: ${String(checks)} checks passed\n`);
