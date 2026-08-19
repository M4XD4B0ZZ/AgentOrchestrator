#!/usr/bin/env node
/**
 * V3 slice 1 — the native launch boundary, measured against the shipped
 * artefact with real processes and real deaths.
 *
 * ── Why this cannot be a vitest file ───────────────────────────────────────
 *
 * Every property here is about processes that outlive, or fail to outlive, the
 * process making the assertion. Two of the cases kill the observer's own
 * collaborators — the helper in one, the AO stand-in in another — and the
 * question they ask is what is still *running* afterwards. A test runner
 * worker cannot ask that about itself, and `dist` is used rather than `src`
 * because the claim is about the artefact this repository ships.
 *
 * ── The instrument, and why it is a heartbeat ──────────────────────────────
 *
 * Survivor counting by pid is where the spike found two instrument defects: a
 * terminated process whose object is still referenced looks alive, and pids
 * are reused. So "alive" here means "this file's number is still growing" —
 * every member of the fixture tree rewrites `hb-<pid>.txt` ten times a second.
 * The instrument is only trustworthy if it can actually see a survivor, which
 * is why the negative control exists: it deliberately builds a *weakened*
 * helper, kills it,
 * and requires the instrument to report survivors. An instrument that reports
 * zero everywhere would pass every other case here while proving nothing.
 *
 * ── What is measured ───────────────────────────────────────────────────────
 *
 *   1. ownership is established, verified, and reported before anything runs;
 *   2. the caller's own termination is its own ending, and takes the tree;
 *   3. helper death without the caller asking for it is `BOUNDARY_LOST`, and
 *      takes the tree — the defect the ADR added a fifth outcome for;
 *   4. AO death takes helper and tree with it, with no cleanup code running;
 *   5. descendants the child orphaned are job members, and die with the job;
 *   6. the child's real exit code survives the boundary;
 *   7. every failure to establish ownership refuses, and nothing ran;
 *   8. the shipped helper refuses a request that would weaken containment;
 *   9. nothing executes before membership has been verified;
 *  10. the containment settings are load-bearing, and it takes BOTH of them
 *      being wrong to lose the tree (negative control, run as a pair);
 *  11. `SUSPENDED` placement contains the tree the way the `JOBLIST` default
 *      does;
 *  12. the argument vector the target receives is identical to the one
 *      `child_process.spawn` delivers, across quoting, backslashes, Unicode,
 *      empty and shell-metacharacter arguments — and the same holds for the
 *      verbatim `cmd.exe /d /s /c` route a `.cmd` shim is started through;
 *  13. the working directory and a replaced environment arrive exactly;
 *  14. a reused working directory cannot lend its evidence to the next launch;
 *  15. an owner that is *not* the parent is watched, and its loss exits the
 *      helper with 93 and takes the tree — the only case that reaches the
 *      owner watch at all;
 *  16. the verbatim route works for a target path containing a space, which is
 *      the one construction where the boundary deliberately differs from Node.
 *
 * Deliberately **not** measured here: byte budgets, stdin delivery vocabulary,
 * timeouts, result classification. Those are AO's, they stay in TypeScript,
 * and they belong to the adapter slices — not to this boundary.
 *
 * Contract: exit code 0 means every case held. Any nonzero exit means at least
 * one did not.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const fixtureDir = join(scriptDir, 'fixtures');
const treeFixture = join(fixtureDir, 'boundary-tree-fixture.mjs');
const aoStandIn = join(fixtureDir, 'boundary-ao-stand-in.mjs');
const echoFixture = join(fixtureDir, 'boundary-echo-fixture.mjs');

const startModuleUrl = pathToFileURL(join(repoRoot, 'dist', 'boundary', 'start-owned-process.js'))
  .href;
const contractModuleUrl = pathToFileURL(join(repoRoot, 'dist', 'boundary', 'launch-boundary.js'))
  .href;
const buildModuleUrl = pathToFileURL(join(repoRoot, 'scripts', 'build-native-boundary.mjs')).href;

const { startOwnedProcess, resolveBoundaryExecutable } = await import(startModuleUrl);
const { decodeBoundaryStatus, classifyBoundaryEnding } = await import(contractModuleUrl);
const { compileNativeBoundary, locateCsc } = await import(buildModuleUrl);

const taskkill = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');

const temporaryDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** `pid -> last heartbeat value`, read straight from the fixture's files. */
function heartbeats(dir) {
  const beats = new Map();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return beats;
  }
  for (const name of names) {
    if (!name.startsWith('hb-')) continue;
    try {
      beats.set(name, readFileSync(join(dir, name), 'utf8'));
    } catch {
      /* a file being rewritten right now is read again on the next pass */
    }
  }
  return beats;
}

/**
 * How many fixture processes are still running, decided by observation rather
 * than by asking the process table: a heartbeat that grows over the window is
 * a process that is executing.
 */
async function liveCount(dir, windowMs = 1_500) {
  const before = heartbeats(dir);
  await sleep(windowMs);
  const after = heartbeats(dir);
  let live = 0;
  for (const [name, value] of after) {
    if (before.get(name) !== value) live += 1;
  }
  return live;
}

/** The pids of every fixture process that is still executing. */
async function livePids(dir, windowMs = 1_500) {
  const before = heartbeats(dir);
  await sleep(windowMs);
  const after = heartbeats(dir);
  const pids = [];
  for (const [name, value] of after) {
    if (before.get(name) !== value) pids.push(Number.parseInt(name.slice(3), 10));
  }
  return pids;
}

async function waitForTree(dir, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (heartbeats(dir).size >= expected) return true;
    await sleep(50);
  }
  return false;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(50);
  }
  return false;
}

/** Kills one process and nothing below it: the tree's fate is the measurement. */
function killOnly(pid) {
  try {
    execFileSync(taskkill, ['/F', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');

/**
 * Writes a request file directly, bypassing the encoder.
 *
 * Two cases need this and no production code may offer it: asking the shipped
 * helper to accept a key that would weaken containment (it must refuse), and
 * driving the test-only control build that deliberately does weaken it.
 */
function writeRawRequest(dir, entries) {
  const path = join(dir, 'request.txt');
  const lines = [];
  for (const [key, value] of entries) lines.push(`${key}=${b64(value)}`);
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

function readStatus(dir) {
  const path = join(dir, 'status.txt');
  if (!existsSync(path)) return null;
  return decodeBoundaryStatus(readFileSync(path, 'utf8'));
}

/** Runs the helper binary at `exePath` against a hand-written request. */
function spawnHelper(exePath, requestPath) {
  const helper = spawn(exePath, [requestPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  helper.stdout.resume();
  helper.stderr.resume();
  helper.stdin.end();
  return helper;
}

function helperExit(helper) {
  return new Promise((done) => {
    helper.on('close', (code, signal) => done({ code, signal }));
  });
}

/**
 * The test-only build of the boundary, compiled once.
 *
 * It is the only thing in this repository that can ask the boundary to fail at
 * a chosen point or to weaken its own containment, it is built into a
 * temporary directory, and it never reaches `dist`. Two cases need it: the one
 * that proves membership is verified *before* the target may execute, and the
 * negative control that proves the containment settings are load-bearing.
 */
let controlExePath = null;
function controlExe() {
  if (controlExePath === null) {
    const buildDir = tempDir('ao-boundary-control-');
    controlExePath = join(buildDir, 'ao-launch-control.exe');
    compileNativeBoundary({ outFile: controlExePath, defines: ['AO_BOUNDARY_TEST_CONTROLS'] });
  }
  return controlExePath;
}

// ── the cases ───────────────────────────────────────────────────────────────

const cases = [];
function measure(name, run) {
  cases.push({ name, run });
}

/** One case's assertions. Every failure is collected; none is thrown away. */
class Case {
  constructor(name) {
    this.name = name;
    this.failures = [];
    this.notes = [];
  }
  check(condition, message) {
    if (!condition) this.failures.push(message);
    return condition;
  }
  note(text) {
    this.notes.push(text);
  }
}

async function startTree(options = {}) {
  const heartbeatDir = tempDir('ao-boundary-hb-');
  const start = await startOwnedProcess({
    // No mode unless the case asks for one: the default is the module's, and
    // case 1 asserts what that default actually is.
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    file: process.execPath,
    args: [
      treeFixture,
      heartbeatDir,
      '2',
      '2',
      String(options.lifetimeMs ?? 30_000),
      String(options.rootLifetimeMs ?? options.lifetimeMs ?? 30_000),
    ],
  });
  if (start.established) {
    start.process.helper.stdout?.resume();
    start.process.helper.stderr?.resume();
  }
  return { start, heartbeatDir };
}

measure('ownership is established and verified before the tree runs', async (c) => {
  const { start, heartbeatDir } = await startTree();
  if (!c.check(start.established, `boundary refused: ${JSON.stringify(start.ending ?? null)}`)) {
    return;
  }
  const owned = start.process;
  c.check(owned.childPid > 0, 'no child pid was reported');
  c.check(owned.helperPid > 0, 'no helper pid was reported');
  c.check(owned.verifiedInJob === true, 'ownership was reported without membership evidence');
  c.check(
    owned.mode === 'JOBLIST' && owned.assignedAtCreation === true,
    `the default launch did not place the process in the job at creation (${owned.mode}/${String(owned.assignedAtCreation)})`,
  );
  c.check(
    owned.jobMembersAtStart === 1,
    `expected exactly the child in the job at start, saw ${owned.jobMembersAtStart}`,
  );
  c.check(await waitForTree(heartbeatDir, 7, 20_000), 'the 7-process tree never appeared');
  c.check((await liveCount(heartbeatDir)) === 7, 'the tree was not fully alive before termination');

  owned.terminate();
  const ending = await owned.ending;
  c.check(
    ending.ending === 'TERMINATED_BY_CALLER',
    `a termination this caller asked for was reported as ${ending.ending}`,
  );
  // One of the two settings the negative control proves is load-bearing. The
  // helper reports what it did rather than what it intended, so this reads the
  // effect rather than the source.
  c.check(
    ending.status?.jobHandleInheritable === false,
    'the shipped boundary made its job handle inheritable',
  );
  const survivors = await liveCount(heartbeatDir);
  c.check(survivors === 0, `${survivors} process(es) survived the caller's termination`);
  owned.dispose();
});

measure('helper death without the caller asking is BOUNDARY_LOST, and takes the tree', async (c) => {
  const { start, heartbeatDir } = await startTree();
  if (!c.check(start.established, 'boundary refused')) return;
  const owned = start.process;
  c.check(await waitForTree(heartbeatDir, 7, 20_000), 'the 7-process tree never appeared');

  // No `terminate()`: this caller never asked for anything. The boundary is
  // destroyed underneath it, which is precisely the case that used to look
  // like a clean completion.
  killOnly(owned.helperPid);

  const ending = await owned.ending;
  c.check(
    ending.ending === 'BOUNDARY_LOST',
    `a destroyed boundary was reported as ${ending.ending}`,
  );
  c.check(
    ending.reason === 'NO_CHILD_EXIT_OBSERVED',
    `unexpected loss reason ${String(ending.reason)}`,
  );
  const survivors = await liveCount(heartbeatDir);
  c.check(survivors === 0, `${survivors} process(es) survived the helper`);
  owned.dispose();
});

measure('AO death takes the helper and the whole tree, with no cleanup code', async (c) => {
  const heartbeatDir = tempDir('ao-boundary-hb-');
  const workDir = tempDir('ao-boundary-work-');
  const ao = spawn(
    process.execPath,
    [aoStandIn, startModuleUrl, heartbeatDir, workDir, 'SUSPENDED'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  ao.stderr.resume();

  let line = '';
  const reported = await new Promise((done) => {
    const timer = setTimeout(() => done(null), 30_000);
    ao.stdout.on('data', (chunk) => {
      line += chunk.toString('utf8');
      const end = line.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try {
        done(JSON.parse(line.slice(0, end)));
      } catch {
        done(null);
      }
    });
  });
  ao.stdout.resume();

  if (!c.check(reported?.helperPid > 0, `the AO stand-in reported no boundary: ${line}`)) {
    killOnly(ao.pid);
    return;
  }
  c.check(await waitForTree(heartbeatDir, 7, 20_000), 'the 7-process tree never appeared');

  // Kill the owner only. Nothing in the AO process runs after this line: no
  // exit handler, no taskkill, no descendant walk.
  killOnly(ao.pid);

  c.check(
    await waitForProcessGone(reported.helperPid, 20_000),
    'the helper outlived the process it was coupled to',
  );
  const survivors = await liveCount(heartbeatDir);
  c.check(survivors === 0, `${survivors} process(es) survived their owner`);

  // What the evidence left behind must NOT say. Nobody survives to classify
  // this run — the caller that would have was the process killed — so the
  // property that matters is that whoever reads the status afterwards cannot
  // read it as a completion.
  //
  // It is deliberately not asserted that the status records `OWNER_LOST`, and
  // the reason was measured rather than assumed: **node puts every child it
  // spawns into its own kill-on-close job** (libuv does this on Windows), so
  // when AO dies the helper is killed by that job immediately — usually before
  // its own owner watch can write anything. Containment therefore holds twice
  // over here, and the owner watch is what covers the case where the owner is
  // *not* the parent, which the contract tests pin instead. An assertion on
  // the flag would have been an assertion on which of two races won.
  const status = readStatus(workDir);
  c.check(status !== null, 'the boundary left no status behind');
  const ending = classifyBoundaryEnding({
    status,
    helperExitCode: null,
    helperSignal: null,
    callerRequestedTermination: false,
  });
  c.check(
    ending.ending === 'BOUNDARY_LOST',
    `a destroyed run reads as ${ending.ending}, not as a lost boundary`,
  );
});

measure('descendants the child orphaned are job members and die with the job', async (c) => {
  // The root's lifetime is the robustness knob: every descendant has to exist
  // before the root exits, or the job would be counting a tree that was never
  // finished being built. Ten seconds is far more than the fixture needs on
  // this machine and leaves room for a slow runner.
  const { start, heartbeatDir } = await startTree({ lifetimeMs: 40_000, rootLifetimeMs: 10_000 });
  if (!c.check(start.established, 'boundary refused')) return;
  const owned = start.process;
  c.check(await waitForTree(heartbeatDir, 7, 9_000), 'the 7-process tree never appeared in time');

  const ending = await owned.ending;
  c.check(
    ending.ending === 'CHILD_EXITED',
    `the root's own exit was reported as ${ending.ending}`,
  );
  const membersAtEnd = ending.status?.jobMembersAtEnd ?? -1;
  c.note(`job members when the root had exited: ${membersAtEnd}`);
  // The kernel's own answer: the orphans the root left behind were inside the
  // ownership boundary, not merely reachable from it.
  c.check(
    membersAtEnd >= 6,
    `expected the 6 orphaned descendants to be job members, job reported ${membersAtEnd}`,
  );
  const survivors = await liveCount(heartbeatDir);
  c.check(survivors === 0, `${survivors} orphan(s) outlived the job`);
  owned.dispose();
});

measure("the child's real exit code survives the boundary", async (c) => {
  for (const expected of [0, 1, 42, 255]) {
    const start = await startOwnedProcess({
      file: process.execPath,
      args: ['-e', `process.exit(${expected})`],
    });
    if (!c.check(start.established, `boundary refused for exit ${expected}`)) continue;
    start.process.helper.stdout?.resume();
    start.process.helper.stderr?.resume();
    const ending = await start.process.ending;
    c.check(
      ending.ending === 'CHILD_EXITED' && ending.childExitCode === expected,
      `expected exit ${expected}, got ${ending.ending}/${String(ending.childExitCode)}`,
    );
    start.process.dispose();
  }
});

measure('a boundary that cannot be established refuses, and nothing ran', async (c) => {
  const markerDir = tempDir('ao-boundary-marker-');
  const marker = join(markerDir, 'ran.txt');
  const writeMarker = ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`];

  const missing = await startOwnedProcess({
    file: join(markerDir, 'no-such-program.exe'),
    args: [],
  });
  c.check(!missing.established, 'a missing program was launched');
  c.check(
    missing.ending?.failureCode === 'OWNED_CONTAINMENT_CREATE',
    `unexpected failure code ${String(missing.ending?.failureCode)}`,
  );

  const badCwd = await startOwnedProcess({
    file: process.execPath,
    args: writeMarker,
    cwd: join(markerDir, 'no-such-directory'),
  });
  c.check(!badCwd.established, 'a launch into a directory that does not exist was established');
  c.check(
    badCwd.ending?.ending === 'BOUNDARY_REFUSED',
    `unexpected ending ${String(badCwd.ending?.ending)}`,
  );

  // A pid that certainly refers to nothing: this process ran, and exited.
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  const deadPid = dead.pid;
  await new Promise((done) => dead.on('close', done));
  await sleep(200);

  const noOwner = await startOwnedProcess({
    file: process.execPath,
    args: writeMarker,
    ownerPid: deadPid,
  });
  c.check(!noOwner.established, 'a boundary was established for an owner that is gone');
  c.check(
    noOwner.ending?.failureCode === 'OWNED_CONTAINMENT_OWNER_GONE',
    `unexpected failure code ${String(noOwner.ending?.failureCode)}`,
  );

  await sleep(500);
  c.check(!existsSync(marker), 'a refused boundary still ran the target');
});

measure('the shipped helper refuses any request that would weaken containment', async (c) => {
  const exe = resolveBoundaryExecutable();
  if (!c.check(exe.path !== undefined, 'the boundary executable is missing from dist')) return;

  for (const [key, value] of [
    ['noHandleList', 'true'],
    ['inheritJobHandle', 'true'],
    ['failAt', 'BEFORE_CREATE'],
    ['jobFlags', '00000000'],
  ]) {
    const dir = tempDir('ao-boundary-weaken-');
    const marker = join(dir, 'ran.txt');
    const requestPath = writeRawRequest(dir, [
      // A complete, valid request in every other respect — so the refusal
      // below is attributable to the weakening key and not to a request the
      // helper would have rejected anyway.
      ['nonce', 'weakening-refusal-case'],
      ['mode', 'SUSPENDED'],
      ['file', process.execPath],
      ['arg', '-e'],
      ['arg', `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
      ['verbatim', 'false'],
      ['ownerPid', String(process.pid)],
      ['statusPath', join(dir, 'status.txt')],
      [key, value],
    ]);
    const helper = spawnHelper(exe.path, requestPath);
    const { code } = await helperExit(helper);
    const status = readStatus(dir);
    c.check(code === 90, `${key}: expected the boundary-failure exit 90, got ${code}`);
    c.check(
      status?.failure === 'OWNED_CONTAINMENT_REQUEST_INVALID',
      `${key}: expected a request refusal, status said ${String(status?.failure)}`,
    );
    c.check(!existsSync(marker), `${key}: the target ran despite the refusal`);
  }

  // The positive control, without which every assertion above could be
  // satisfied by a helper that refuses hand-written requests as such. The same
  // request minus the weakening key has to be accepted and has to run.
  const okDir = tempDir('ao-boundary-weaken-ok-');
  const okMarker = join(okDir, 'ran.txt');
  const okRequest = writeRawRequest(okDir, [
    ['nonce', 'weakening-refusal-positive-control'],
    ['mode', 'SUSPENDED'],
    ['file', process.execPath],
    ['arg', '-e'],
    ['arg', `require("fs").writeFileSync(${JSON.stringify(okMarker)}, "ran")`],
    ['verbatim', 'false'],
    ['ownerPid', String(process.pid)],
    ['statusPath', join(okDir, 'status.txt')],
  ]);
  const okHelper = spawnHelper(exe.path, okRequest);
  const okExit = await helperExit(okHelper);
  c.check(okExit.code === 0, `the control request was refused with exit ${okExit.code}`);
  c.check(existsSync(okMarker), 'the control request did not run its target');
});

measure('nothing executes before membership has been verified', async (c) => {
  // The ADR's wording is "verifies membership before the target can execute",
  // and a passing launch cannot show that: the target runs either way. So the
  // check is made to fail *after* the membership check and *before* the
  // resume, and the question becomes whether the target left a trace. In
  // SUSPENDED mode it must not have run a single instruction.
  const dir = tempDir('ao-boundary-verify-');
  const marker = join(dir, 'ran.txt');
  const requestPath = writeRawRequest(dir, [
    ['nonce', 'verify-before-execute-case'],
    ['mode', 'SUSPENDED'],
    ['file', process.execPath],
    ['arg', '-e'],
    ['arg', `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
    ['verbatim', 'false'],
    ['ownerPid', String(process.pid)],
    ['statusPath', join(dir, 'status.txt')],
    ['failAt', 'AFTER_VERIFY'],
  ]);
  const helper = spawnHelper(controlExe(), requestPath);
  const { code } = await helperExit(helper);
  const status = readStatus(dir);

  c.check(code === 90, `expected the boundary-failure exit 90, got ${code}`);
  c.check(
    status?.failure === 'OWNED_CONTAINMENT_VERIFY',
    `expected a verification refusal, status said ${String(status?.failure)}`,
  );
  c.check(status?.raw?.childPid !== undefined, 'the case did not reach the created-child state');
  await sleep(750);
  c.check(!existsSync(marker), 'the target executed before its membership was accepted');
});

/** Runs the fixture tree through the control build with the given weakening. */
async function weakenedRun(c, weakening) {
  const control = controlExe();
  const heartbeatDir = tempDir('ao-boundary-hb-');
  const requestDir = tempDir('ao-boundary-control-run-');
  const requestPath = writeRawRequest(requestDir, [
    ['nonce', `control-${weakening.map(([key]) => key).join('-')}`],
    ['mode', 'SUSPENDED'],
    ['file', process.execPath],
    ['arg', treeFixture],
    ['arg', heartbeatDir],
    ['arg', '2'],
    ['arg', '2'],
    // A bounded lifetime: these processes are *meant* to escape in one of the
    // two runs, so they must also be guaranteed to end without anyone
    // remembering to kill them.
    ['arg', '60000'],
    ['arg', '60000'],
    ['verbatim', 'false'],
    ['ownerPid', String(process.pid)],
    ['statusPath', join(requestDir, 'status.txt')],
    ...weakening,
  ]);
  const helper = spawnHelper(control, requestPath);
  c.check(await waitForTree(heartbeatDir, 7, 20_000), 'the control tree never appeared');
  killOnly(helper.pid);

  // Measured immediately, and *not* after waiting for the helper's `close`:
  // the survivors still hold the forwarded stdout pipe, so waiting for it
  // would wait for them — and would then report the fixture's own lifetime
  // bound as containment. The first version of this case did exactly that and
  // reported zero survivors over processes that had simply timed out.
  const survivors = await livePids(heartbeatDir);
  for (const pid of survivors) killOnly(pid);
  return survivors;
}

measure('an owner that is not the parent is watched, and its loss takes the tree', async (c) => {
  // The one path in the boundary that no other case here reaches. Every other
  // launch is owned by the process that spawned the helper, and node puts its
  // children in a kill-on-close job of its own — so the helper dies from *that*
  // before its own owner watch can act, and the watch itself never runs.
  //
  // Here the owner is a third, unrelated process: this harness spawns both, the
  // harness stays alive, and only the owner is killed. That makes the watch the
  // only mechanism in play, which matters because it is the code the ownership
  // gate and the exit-inside-the-lock fix live in.
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const heartbeatDir = tempDir('ao-boundary-hb-');
  const dir = tempDir('ao-boundary-third-party-owner-');
  const requestPath = writeRawRequest(dir, [
    ['nonce', 'third-party-owner-case'],
    ['mode', 'SUSPENDED'],
    ['file', process.execPath],
    ['arg', treeFixture],
    ['arg', heartbeatDir],
    ['arg', '2'],
    ['arg', '2'],
    ['arg', '30000'],
    ['arg', '30000'],
    ['verbatim', 'false'],
    ['ownerPid', String(owner.pid)],
    ['statusPath', join(dir, 'status.txt')],
  ]);
  const helper = spawnHelper(resolveBoundaryExecutable().path, requestPath);
  const exited = helperExit(helper);
  c.check(await waitForTree(heartbeatDir, 7, 20_000), 'the 7-process tree never appeared');

  killOnly(owner.pid);

  const closed = await Promise.race([exited, sleep(20_000).then(() => null)]);
  c.check(closed !== null, 'the helper never exited after its owner was lost');
  c.check(
    closed?.code === 93,
    `expected the owner-lost exit 93, got ${String(closed?.code)}`,
  );
  const status = readStatus(dir);
  c.check(
    status?.terminatedByOwnerLoss === true,
    'the helper did not record that it took the tree down for owner loss',
  );
  const survivors = await liveCount(heartbeatDir);
  c.check(survivors === 0, `${survivors} process(es) survived their owner`);
});

measure('the verbatim route delivers the argument vector a .cmd shim sees', async (c) => {
  // The `cmd.exe /d /s /c "…"` route, which is how AO starts anything behind a
  // `.cmd` shim — the Claude CLI among them. It is a second, separate branch of
  // the boundary's command-line construction, and until this case it was
  // asserted by a comment rather than measured.
  const dir = tempDir('ao-boundary-verbatim-');
  const shim = join(dir, 'shim.cmd');
  writeFileSync(shim, `@echo off\r\nnode "${echoFixture}" %*\r\n`, 'utf8');

  const args = ['plain', 'two words', 'a&b', '日本'];
  const report = join(dir, 'through-boundary.json');
  const cmd = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const quoted = [`"${shim}"`, ...args.map((arg) => `"${arg}"`)].join(' ');

  const start = await startOwnedProcess({
    file: cmd,
    args: ['/d', '/s', '/c', `"${quoted}"`],
    verbatim: true,
    env: { ...process.env, AO_BOUNDARY_REPORT_TO: report },
  });
  if (!c.check(start.established, 'boundary refused the verbatim route')) return;
  start.process.helper.stdout.resume();
  start.process.helper.stderr.resume();
  const ending = await start.process.ending;
  c.check(ending.ending === 'CHILD_EXITED', `the shim ended as ${ending.ending}`);

  // The control: the same line through Node's own verbatim spawn, which is what
  // `runCommand` does today.
  const controlReport = join(dir, 'through-spawn.json');
  const control = spawnSync(cmd, ['/d', '/s', '/c', `"${quoted}"`], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    env: { ...process.env, AO_BOUNDARY_REPORT_TO: controlReport },
  });
  c.check(control.status === 0, `the control shim exited ${String(control.status)}`);

  let owned = null;
  let direct = null;
  try {
    owned = JSON.parse(readFileSync(report, 'utf8')).argv;
    direct = JSON.parse(readFileSync(controlReport, 'utf8')).argv;
  } catch {
    /* reported by the assertion below */
  }
  c.check(
    owned !== null && JSON.stringify(owned) === JSON.stringify(direct),
    `boundary delivered ${JSON.stringify(owned)}, spawn delivered ${JSON.stringify(direct)}`,
  );
  c.check(
    JSON.stringify(direct) === JSON.stringify(args),
    `the control itself did not deliver the arguments: ${JSON.stringify(direct)}`,
  );
  start.process.dispose();
});

measure('the verbatim route survives a target path with a space in it', async (c) => {
  // The one place the boundary deliberately does *not* reproduce Node: in
  // verbatim mode libuv passes argv[0] unquoted, so a target whose path
  // contains a space is split by the child's own C runtime and the tail of the
  // path arrives as an argument. The boundary quotes argv[0], which is the
  // correct construction — and a claim of "correct" needs a case, because the
  // route AO actually uses verbatim (`cmd.exe`, no space, and cmd ignores its
  // own argv[0]) cannot see the difference at all.
  //
  // The target is compiled here rather than borrowed: it has to report its own
  // argument vector from a path that has a space in it, which no program on
  // this machine does.
  const csc = locateCsc();
  if (!c.check(csc !== null, 'the in-box C# compiler was not found')) return;

  const dir = join(tempDir('ao-boundary-verbatim-space-'), 'a directory with spaces');
  mkdirSync(dir, { recursive: true });
  const source = join(dir, 'Echo.cs');
  const exe = join(dir, 'echo target.exe');
  writeFileSync(
    source,
    [
      'using System;',
      'using System.IO;',
      'using System.Text;',
      'internal static class Echo {',
      '  private static int Main(string[] args) {',
      // Explicit UTF-8 bytes. `Console.Out` encodes for the console code page,
      // which turns a Unicode argument into question marks on its way through a
      // pipe — indistinguishable, from the outside, from the boundary having
      // mangled it.
      '    byte[] bytes = new UTF8Encoding(false).GetBytes(string.Join("\\u0001", args));',
      '    Stream stdout = Console.OpenStandardOutput();',
      '    stdout.Write(bytes, 0, bytes.Length);',
      '    stdout.Flush();',
      '    return 0;',
      '  }',
      '}',
    ].join('\n'),
    'utf8',
  );
  execFileSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, source], { stdio: 'pipe' });

  // Verbatim means untouched: the caller does the quoting, exactly as
  // `runCommand` does today when it builds its `cmd.exe /d /s /c` line. What
  // the boundary must not leave unquoted is *argv[0]*.
  const args = ['first', '"two words"', '日本'];
  const expected = ['first', 'two words', '日本'];
  const start = await startOwnedProcess({
    file: exe,
    args,
    verbatim: true,
  });
  if (!c.check(start.established, 'boundary refused the verbatim launch')) return;
  let text = '';
  start.process.helper.stdout.on('data', (chunk) => {
    text += chunk.toString('utf8');
  });
  start.process.helper.stderr.resume();
  const ending = await start.process.ending;
  c.check(ending.ending === 'CHILD_EXITED', `ended as ${ending.ending}`);

  // Unquoted argv[0] makes the child read "a" as its program name and
  // "directory with spaces\\echo target.exe" as arguments, so the vector it
  // reports is not the one that was asked for.
  const delivered = text.length === 0 ? [] : text.split('\u0001');
  c.check(
    JSON.stringify(delivered) === JSON.stringify(expected),
    `the target received ${JSON.stringify(delivered)}`,
  );
  start.process.dispose();
});

measure('the containment settings are load-bearing (negative control)', async (c) => {
  // The whole suite's credibility rests on this case, and it is run as a pair
  // so that the claim it establishes is the one the source makes: the handle
  // list and the non-inheritable job handle are *two independent* lines of
  // defence, and it takes both being wrong to lose the tree.
  c.check(existsSync(controlExe()), 'the control helper did not build');

  const oneWrong = await weakenedRun(c, [['inheritJobHandle', 'true']]);
  c.note(`survivors with only the job handle inheritable: ${oneWrong.length}`);
  c.check(
    oneWrong.length === 0,
    `the handle list alone did not hold: ${oneWrong.length} survivor(s)`,
  );

  const bothWrong = await weakenedRun(c, [
    ['inheritJobHandle', 'true'],
    ['noHandleList', 'true'],
  ]);
  c.note(`survivors with both wrong: ${bothWrong.length}`);
  // Exactly the whole fixture tree, not merely "some": a weakened boundary
  // that leaked 1 of 7 would satisfy a `> 0` assertion while meaning something
  // quite different, and the README quotes this number.
  c.check(
    bothWrong.length === 7,
    `expected the whole 7-process tree to escape, saw ${bothWrong.length}`,
  );
});

measure('SUSPENDED placement contains the tree the same way', async (c) => {
  // The default is JOBLIST — placement at creation, no window in which a
  // created process is not yet owned. SUSPENDED is the other measured mode,
  // and it is the one that proves membership before the target's first
  // instruction, so both are exercised.
  const { start, heartbeatDir } = await startTree({ mode: 'SUSPENDED' });
  if (!c.check(start.established, 'boundary refused in SUSPENDED mode')) return;
  const owned = start.process;
  c.check(
    owned.assignedAtCreation === false,
    'SUSPENDED mode reported placement at creation',
  );
  c.check(await waitForTree(heartbeatDir, 7, 20_000), 'the 7-process tree never appeared');
  owned.terminate();
  const ending = await owned.ending;
  c.check(
    ending.ending === 'TERMINATED_BY_CALLER',
    `unexpected ending ${ending.ending}`,
  );
  const survivors = await liveCount(heartbeatDir);
  c.check(survivors === 0, `${survivors} process(es) survived in SUSPENDED mode`);
  owned.dispose();
});

measure('what the target receives is what the caller asked for', async (c) => {
  // The boundary builds its own Win32 command line rather than letting Node do
  // it, so this is a differential check against `child_process.spawn`: the
  // same arguments through both paths, and the target reports what arrived.
  // Without it, the quoting rules in `CommandLine.Build` would be asserted
  // only by a comment citing a measurement made against the spike helper —
  // a program this repository does not contain.
  const cases = [
    ['plain', 'a', 'b'],
    ['with spaces', 'two words'],
    ['with "quotes"', 'say "hi"'],
    ['backslashes', 'C:\\dir\\', 'C:\\a b\\c\\'],
    ['trailing backslash before quote', 'a\\', '"b\\"'],
    ['unicode', 'λ', '日本語'],
    ['empty', '', 'after-empty'],
    ['shell metacharacters', 'a&b|c>d<e^f%g', '(h)'],
  ];

  for (const args of cases) {
    const label = args[0];
    const start = await startOwnedProcess({
      file: process.execPath,
      args: [echoFixture, ...args],
    });
    if (!c.check(start.established, `boundary refused for ${label}`)) continue;
    const owned = start.process;
    let text = '';
    owned.helper.stdout.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    owned.helper.stderr.resume();
    const ending = await owned.ending;
    c.check(ending.ending === 'CHILD_EXITED', `${label}: ended as ${ending.ending}`);

    const control = spawnSync(process.execPath, [echoFixture, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    let owned_argv = null;
    let control_argv = null;
    try {
      owned_argv = JSON.parse(text).argv;
      control_argv = JSON.parse(control.stdout).argv;
    } catch {
      /* reported by the assertion below */
    }
    c.check(
      owned_argv !== null && JSON.stringify(owned_argv) === JSON.stringify(control_argv),
      `${label}: boundary delivered ${JSON.stringify(owned_argv)}, spawn delivered ${JSON.stringify(control_argv)}`,
    );
    owned.dispose();
  }
});

measure('the working directory and the environment arrive exactly', async (c) => {
  const cwd = join(tempDir('ao-boundary-cwd-'), 'cwd with spaces und Ümläute');
  mkdirSync(cwd, { recursive: true });

  const start = await startOwnedProcess({
    file: process.execPath,
    args: [echoFixture],
    cwd,
    // An environment supplied is an environment *replaced*, so this also
    // measures that nothing of the caller's own leaks in.
    env: {
      AO_BOUNDARY_PROBE: 'value with "quotes" and spaces',
      AO_BOUNDARY_UNICODE: 'λ 日本',
      SystemRoot: process.env['SystemRoot'],
    },
  });
  if (!c.check(start.established, 'boundary refused')) return;
  const owned = start.process;
  let text = '';
  owned.helper.stdout.on('data', (chunk) => {
    text += chunk.toString('utf8');
  });
  owned.helper.stderr.resume();
  const ending = await owned.ending;
  c.check(ending.ending === 'CHILD_EXITED', `ended as ${ending.ending}`);

  let report = null;
  try {
    report = JSON.parse(text);
  } catch {
    /* reported below */
  }
  c.check(report !== null, `the target reported nothing readable: ${text.slice(0, 200)}`);
  if (report === null) return;
  c.check(
    report.cwd.toLowerCase() === cwd.toLowerCase(),
    `cwd arrived as ${report.cwd}`,
  );
  c.check(
    report.env.AO_BOUNDARY_PROBE === 'value with "quotes" and spaces',
    `environment value arrived as ${String(report.env.AO_BOUNDARY_PROBE)}`,
  );
  c.check(report.env.AO_BOUNDARY_UNICODE === 'λ 日本', 'a Unicode environment value was lost');
  c.check(report.env.PATH === null, 'the environment was extended rather than replaced');
  c.check(report.envCount === 3, `expected exactly the 3 supplied variables, saw ${report.envCount}`);
  owned.dispose();
});

measure('a reused working directory cannot lend its evidence to the next launch', async (c) => {
  // The first read of a launch happens before the helper has written
  // anything. A previous run's status left in a reused directory would
  // therefore be read first — `boundary=OK`, `verifiedInJob=true`, and another
  // run's child pid — and the caller would be told ownership was established
  // by evidence belonging to a process that has already exited.
  const workDir = tempDir('ao-boundary-reuse-');

  const first = await startOwnedProcess({
    file: process.execPath,
    args: ['-e', 'process.exit(3)'],
    workDir,
  });
  if (!c.check(first.established, 'the first launch was refused')) return;
  first.process.helper.stdout.resume();
  first.process.helper.stderr.resume();
  const firstEnding = await first.process.ending;
  c.check(firstEnding.ending === 'CHILD_EXITED', `first launch ended as ${firstEnding.ending}`);
  const firstChild = first.process.childPid;
  c.check(existsSync(join(workDir, 'status.txt')), 'the first launch left no status to reuse');

  const second = await startOwnedProcess({
    file: process.execPath,
    args: ['-e', 'process.exit(4)'],
    workDir,
  });
  if (!c.check(second.established, 'the second launch was refused')) return;
  second.process.helper.stdout.resume();
  second.process.helper.stderr.resume();
  c.check(
    second.process.childPid !== firstChild,
    'the second launch was established on the first launch’s evidence',
  );
  const secondEnding = await second.process.ending;
  c.check(
    secondEnding.ending === 'CHILD_EXITED' && secondEnding.childExitCode === 4,
    `the second launch reported ${secondEnding.ending}/${String(secondEnding.childExitCode)}`,
  );
});

// ── run ─────────────────────────────────────────────────────────────────────

if (process.platform !== 'win32') {
  console.error('The launch boundary is a Windows component; this check only runs on Windows.');
  process.exit(1);
}

let failed = 0;
for (const { name, run } of cases) {
  const c = new Case(name);
  const startedAt = Date.now();
  try {
    await run(c);
  } catch (error) {
    c.failures.push(`threw: ${error?.stack ?? String(error)}`);
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  for (const note of c.notes) console.log(`    note: ${note}`);
  if (c.failures.length === 0) {
    console.log(`  ok   ${name} (${seconds}s)`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} (${seconds}s)`);
    for (const failure of c.failures) console.log(`         - ${failure}`);
  }
}

for (const dir of temporaryDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not a measurement result */
  }
}

if (failed > 0) {
  console.error(`\nlaunch boundary: ${failed} case(s) failed.`);
  process.exit(1);
}
console.log('\nlaunch boundary: every case held.');
