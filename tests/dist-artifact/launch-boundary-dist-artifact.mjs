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
 *  10. the containment settings are load-bearing (negative control);
 *  11. `JOBLIST` placement contains the same way `SUSPENDED` does.
 *
 * Deliberately **not** measured here: byte budgets, stdin delivery vocabulary,
 * timeouts, result classification. Those are AO's, they stay in TypeScript,
 * and they belong to the adapter slices — not to this boundary.
 *
 * Contract: exit code 0 means every case held. Any nonzero exit means at least
 * one did not.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const fixtureDir = join(scriptDir, 'fixtures');
const treeFixture = join(fixtureDir, 'boundary-tree-fixture.mjs');
const aoStandIn = join(fixtureDir, 'boundary-ao-stand-in.mjs');

const startModuleUrl = pathToFileURL(join(repoRoot, 'dist', 'boundary', 'start-owned-process.js'))
  .href;
const contractModuleUrl = pathToFileURL(join(repoRoot, 'dist', 'boundary', 'launch-boundary.js'))
  .href;
const buildModuleUrl = pathToFileURL(join(repoRoot, 'scripts', 'build-native-boundary.mjs')).href;

const { startOwnedProcess, resolveBoundaryExecutable } = await import(startModuleUrl);
const { decodeBoundaryStatus } = await import(contractModuleUrl);
const { compileNativeBoundary } = await import(buildModuleUrl);

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
    mode: options.mode ?? 'SUSPENDED',
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

measure('the containment settings are load-bearing (negative control)', async (c) => {
  // The whole suite's credibility rests on this case. It builds a helper that
  // keeps the job handle inheritable *and* passes no handle list — the exact
  // pair the spike measured as the one that breaks containment — kills it, and
  // requires survivors. If this reports zero, every "0 survivors" above is
  // measuring an instrument that cannot see anything.
  const control = controlExe();
  c.check(existsSync(control), 'the control helper did not build');

  const heartbeatDir = tempDir('ao-boundary-hb-');
  const requestDir = tempDir('ao-boundary-control-run-');
  const requestPath = writeRawRequest(requestDir, [
    ['mode', 'SUSPENDED'],
    ['file', process.execPath],
    ['arg', treeFixture],
    ['arg', heartbeatDir],
    ['arg', '2'],
    ['arg', '2'],
    // A bounded lifetime: these processes are *meant* to escape, so they must
    // also be guaranteed to end without anyone remembering to kill them.
    ['arg', '60000'],
    ['arg', '60000'],
    ['verbatim', 'false'],
    ['ownerPid', String(process.pid)],
    ['statusPath', join(requestDir, 'status.txt')],
    ['inheritJobHandle', 'true'],
    ['noHandleList', 'true'],
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
  c.note(`survivors of the weakened boundary: ${survivors.length}`);
  c.check(
    survivors.length > 0,
    'the weakened boundary left no survivors — the instrument cannot see one',
  );
  for (const pid of survivors) killOnly(pid);
});

measure('JOBLIST placement contains the tree the same way', async (c) => {
  const { start, heartbeatDir } = await startTree({ mode: 'JOBLIST' });
  if (!c.check(start.established, 'boundary refused in JOBLIST mode')) return;
  const owned = start.process;
  c.check(
    owned.assignedAtCreation === true,
    'JOBLIST mode did not report placement at creation',
  );
  c.check(await waitForTree(heartbeatDir, 7, 20_000), 'the 7-process tree never appeared');
  owned.terminate();
  const ending = await owned.ending;
  c.check(
    ending.ending === 'TERMINATED_BY_CALLER',
    `unexpected ending ${ending.ending}`,
  );
  const survivors = await liveCount(heartbeatDir);
  c.check(survivors === 0, `${survivors} process(es) survived in JOBLIST mode`);
  owned.dispose();
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
