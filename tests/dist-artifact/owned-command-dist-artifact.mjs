#!/usr/bin/env node
/**
 * V3 slice 2 — the owned-command adapter, measured against the shipped
 * artefact with real processes.
 *
 * ── Why this cannot be a vitest file ───────────────────────────────────────
 *
 * The adapter resolves the boundary executable from its own location, so only
 * a `dist` build has one at all: run from `src`, every case here would refuse
 * with `BOUNDARY_EXECUTABLE_MISSING` and pass while measuring nothing. Several
 * cases also kill the observer's own collaborators and then ask what is still
 * running, which a test-runner worker cannot ask about itself.
 *
 * ── The differential, and what it is for ───────────────────────────────────
 *
 * Nine of the cases below run the same fixture down two paths — `runCommand`,
 * the contract AO has today, and `runOwnedCommand`, the one this slice adds.
 * The invocations are identical except for the heartbeat directory each half
 * writes into, which has to differ so that a survivor can be attributed to the
 * path that left it —
 * and require them to agree about output, budgets, exit codes, timeouts and
 * stdin delivery. This is not an attempt to reproduce `runCommand`'s
 * `taskkill` containment, which the ADR replaces rather than imitates. It is
 * the guard against the adapter quietly inventing a *different* command
 * semantics on the way, which is the failure mode a green suite of its own
 * tests cannot see.
 *
 * The fixture is driven entirely by shell-inert `--key=value` arguments
 * precisely so both paths can run it: `runCommand` refuses an argument
 * containing a space.
 *
 * ── The instrument, and what it does not claim ─────────────────────────────
 *
 * Survivors are counted by heartbeat — a file whose number keeps growing — for
 * the reason the spike found: a terminated process whose object is still
 * referenced looks alive in a process walk.
 *
 * **Every case that starts a process starts it with a `--heartbeat=` directory,
 * and every such directory is swept at the end of the run.** The only cases
 * that register nothing are the two that start nothing: a refused foreign
 * status, and a target that does not exist.
 *
 * It is written as a property rather than an intention because six earlier
 * versions of it were wrong, each one class further down: cases that started
 * nothing, then trees in unregistered directories, then processes with no
 * heartbeat at all, then two cases running a fixture that had no heartbeat
 * support, then a restatement claiming every *call* carried a `--heartbeat=`,
 * then two `runCommand` halves of a differential that did not. The fourth of
 * those is why the argv read-back below no longer uses slice 1's echo fixture.
 *
 * The claim, exactly: no target process is started by any case in this file
 * without a `--heartbeat=` directory — on either path of a differential — and
 * every such directory reaches `heartbeatDirs`, through `watch`, through
 * `sweepOnly`, or directly from the establishment measurement.
 *
 * Cases that start one tree additionally get a per-case window, so a leak is
 * attributed to the case that caused it; cases that start many short runs are
 * swept only at the end, which is later and therefore sees more.
 *
 * What none of that claims is that the containment settings are load-bearing.
 * That claim needs a negative control — a deliberately weakened helper that
 * leaves survivors — and it belongs to slice 1, which has one
 * (`./launch-boundary-dist-artifact.mjs`). Here the survivor count is a hygiene
 * assertion about the adapter's own terminations: whatever policy ended a run,
 * nothing of that run is left executing.
 *
 * ── What is measured ───────────────────────────
 *
 *   1. exit codes — zero, nonzero, and 0xC0000005 — arrive exactly, and agree
 *      with `runCommand`;
 *   2. stdout and stderr stay separate;
 *   3. a stdout budget cuts the stream, ends the owned tree, and classifies as
 *      an output-limit failure naming stdout;
 *   4. the same for stderr;
 *   5. a timeout ends the owned tree and classifies as a timeout — never as a
 *      boundary loss;
 *   6. an explicit cancellation is `TERMINATED_BY_CALLER`, not a loss;
 *   7. a helper killed by someone else is always `BOUNDARY_LOST`;
 *   8. a launch whose evidence cannot be trusted never completes;
 *   9. a missing target is refused, and the refusal proves nothing ran;
 *  10. a payload read to end-of-file is `DELIVERED`;
 *  11. a child that exits without reading is never `DELIVERED`, and the
 *      boundary — not this process's pipe — is what reports it;
 *  12. a payload fully forwarded to a child that never reads it is `DELIVERED`
 *      too;
 *  13. a termination during a transfer in flight is `UNCONFIRMED`;
 *  14. no payload is `NOT_REQUESTED`, and the child still sees end-of-file;
 *  15. the working directory, the replaced environment, the argument vector and
 *      the placement mode the caller asked for are the ones actually used —
 *      the mode read back from the boundary's own status;
 *  16. a byte budget the caller disabled bounds nothing, and `runCommand`
 *      agrees;
 *  17. `verbatim` hands the command line over untouched, and not doing so is
 *      what quotes each argument — told apart by an argument with a space;
 *  18. a budget and a timeout each name their own outcome when clearly ordered,
 *      and produce nothing but those two when armed to fire together;
 *  19. a deadline that expires during establishment is a timeout, and it stays
 *      conservative about whether anything ran.
 *
 * The same-tick case — two policies triggering inside one turn of the loop — is
 * not measurable here, because which of them fires first is the operating
 * system's decision. It is measured deterministically against an injected
 * boundary in `tests/v3-02-owned-command.test.ts` instead.
 *
 * Contract: exit code 0 means every case held. Any nonzero exit means at least
 * one did not.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const fixture = join(scriptDir, 'fixtures', 'owned-command-fixture.mjs');

const adapterUrl = pathToFileURL(join(repoRoot, 'dist', 'boundary', 'owned-command.js')).href;
const contractUrl = pathToFileURL(join(repoRoot, 'dist', 'boundary', 'launch-boundary.js')).href;
const execUrl = pathToFileURL(join(repoRoot, 'dist', 'doctor', 'exec.js')).href;

const { runOwnedCommand } = await import(adapterUrl);
const { startOwnedProcess } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'boundary', 'start-owned-process.js')).href
);
const { decodeBoundaryStatus } = await import(contractUrl);
const { runCommand } = await import(execUrl);

const taskkill = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');

const temporaryDirs = [];
/** Every heartbeat directory any case created, for the final sweep. */
const heartbeatDirs = [];

/**
 * A temporary directory, canonicalised.
 *
 * `realpathSync.native` is not decoration here. These paths are handed to
 * `runCommand` as `--report=<path>` arguments, and its `SAFE_ARG_PATTERN`
 * admits no tilde — so on a host whose TEMP is the 8.3 alias (the documented
 * shape on `windows-latest`, which is where this gate runs) the raw path would
 * make `assertSafeArgs` throw and the case would fail for a reason that has
 * nothing to do with what it measures. It passes on a developer machine whose
 * user name is short, which is exactly how that reaches CI unnoticed.
 */
function tempDir(prefix) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** `file -> last heartbeat value`, read straight from the fixture's files. */
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
async function liveCount(dir, windowMs = 1_200) {
  const before = heartbeats(dir);
  await sleep(windowMs);
  const after = heartbeats(dir);
  let live = 0;
  for (const [name, value] of after) {
    if (before.get(name) !== value) live += 1;
  }
  return live;
}

/**
 * The same observation, over many directories at once.
 *
 * One window rather than one per directory: the per-directory form costs 1.2s
 * each, which is what made it expensive enough to leave cases unregistered —
 * and leaving cases unregistered is what made this file's survivor claim wrong
 * three times running.
 */
async function liveCountAcross(dirs, windowMs = 1_500) {
  const before = dirs.map((dir) => heartbeats(dir));
  await sleep(windowMs);
  let live = 0;
  dirs.forEach((dir, index) => {
    for (const [name, value] of heartbeats(dir)) {
      if (before[index].get(name) !== value) live += 1;
    }
  });
  return live;
}

async function waitForTree(dir, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (heartbeats(dir).size >= expected) return true;
    await sleep(25);
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

function readStatus(dir) {
  const path = join(dir, 'status.txt');
  if (!existsSync(path)) return null;
  try {
    return decodeBoundaryStatus(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Waits for the helper to publish a pid this case can act on. */
async function waitForHelperPid(dir, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStatus(dir);
    if (status !== null && status.helperPid !== null && status.boundary === 'OK') {
      return status.helperPid;
    }
    await sleep(20);
  }
  return null;
}

/** The same invocation down both paths, with the same policy on each. */
async function bothPaths(args, policy = {}) {
  const owned = await runOwnedCommand({
    file: process.execPath,
    args,
    ...policy,
  });
  const direct = await runCommand(process.execPath, args, {
    env: process.env,
    ...(policy.timeoutMs === undefined ? {} : { timeoutMs: policy.timeoutMs }),
    ...(policy.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: policy.maxStdoutBytes }),
    ...(policy.maxStderrBytes === undefined ? {} : { maxStderrBytes: policy.maxStderrBytes }),
    ...(policy.stdin === undefined ? {} : { stdin: policy.stdin }),
  });
  return { owned, direct };
}

class Case {
  constructor(name) {
    this.name = name;
    this.failures = [];
    this.notes = [];
    /** Directories whose heartbeats must all be still after the case. */
    this.heartbeatDirs = [];
  }
  check(condition, message) {
    if (!condition) this.failures.push(message);
    return condition;
  }
  equal(actual, expected, what) {
    return this.check(
      actual === expected,
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  /** A directory this case's survivors would show up in. */
  watch(dir) {
    this.heartbeatDirs.push(dir);
    heartbeatDirs.push(dir);
    return dir;
  }
  /**
   * The same, minus the per-case window.
   *
   * For a case that starts many short runs: paying a 1.2s observation window
   * per run would dominate its wall clock, and the final sweep at the end of
   * the file covers every registered directory anyway — later, and therefore
   * with a better view of anything that outlived its own run.
   */
  sweepOnly(dir) {
    heartbeatDirs.push(dir);
    return dir;
  }
  note(text) {
    this.notes.push(text);
  }
}

const cases = [];
const test = (name, run) => cases.push({ name, run });

/**
 * What establishing ownership costs on this machine, right now.
 *
 * Measured once, through the boundary itself rather than through a whole run,
 * and taken as the worst of three samples. Several cases below have to choose a
 * budget relative to it: a fixed number that straddles establishment on a
 * developer machine can sit entirely inside it on a loaded CI runner, and the
 * case then fails for a reason that is not a defect.
 */
async function measureEstablishment() {
  let worst = 0;
  for (let sample = 0; sample < 3; sample += 1) {
    const beats = tempDir('ao-owned-hb-');
    heartbeatDirs.push(beats);
    const startedAt = Date.now();
    const launch = await startOwnedProcess({
      file: process.execPath,
      args: [fixture, `--heartbeat=${beats}`, '--hang'],
      establishTimeoutMs: 60_000,
    });
    worst = Math.max(worst, Date.now() - startedAt);
    if (!launch.established) throw new Error('the boundary could not be established at all');
    launch.process.helper.stdout.resume();
    launch.process.helper.stderr.resume();
    launch.process.helper.stdin.end();
    launch.process.terminate();
    await launch.process.ending;
    launch.process.dispose();
  }
  return worst;
}

/** Filled in before the cases run. */
let establishMs = 0;

/**
 * A budget a case can rely on outlasting establishment.
 *
 * Ten times the measured cost, or two seconds, whichever is larger.
 * `establishMs` is one measurement taken before any case ran, and a runner that
 * slows down afterwards — a virus scanner waking up, another job landing on the
 * box — would otherwise turn a case that measures a *timeout* into one that
 * fails an assertion about `established`.
 */
const settleBudgetMs = () => Math.max(2_000, establishMs * 10);

// ── 1. exit codes ───────────────────────────────────────────────────────────

test('an exit code survives the boundary exactly, and agrees with runCommand', async (c) => {
  const beats = c.sweepOnly(tempDir('ao-owned-hb-'));
  for (const code of [0, 1, 42, 255, 256, 3221225477]) {
    const { owned, direct } = await bothPaths([
      fixture,
      `--heartbeat=${beats}`,
      '--stdout-bytes=16',
      `--exit=${code}`,
    ]);
    c.equal(owned.outcome, 'COMPLETED', `owned outcome for exit ${code}`);
    c.equal(owned.exitCode, code, `owned exit code for ${code}`);
    c.equal(direct.exitCode, code, `runCommand exit code for ${code}`);
    c.equal(owned.stdout, direct.stdout, `stdout for exit ${code}`);
  }
  // 0xC0000005 is not decoration: it is what a crashed agent comes back with,
  // and it is the value that separates the helper's signed int32 from the
  // unsigned DWORD node reports.
  c.note('0xC0000005 read back as 3221225477 on both paths');
});

// ── 2. stream separation ────────────────────────────────────────────────────

test('stdout and stderr stay separate', async (c) => {
  const { owned, direct } = await bothPaths([
    fixture,
    `--heartbeat=${c.sweepOnly(tempDir('ao-owned-hb-'))}`,
    '--stdout-mark=OUT-FIRST',
    '--stderr-mark=ERR-FIRST',
    '--stdout-bytes=64',
    '--stderr-bytes=32',
  ]);
  c.check(owned.stdout.startsWith('OUT-FIRST'), 'stdout starts with its own marker');
  c.check(owned.stderr.startsWith('ERR-FIRST'), 'stderr starts with its own marker');
  c.check(!owned.stdout.includes('ERR-FIRST'), 'no stderr text leaked into stdout');
  c.check(!owned.stderr.includes('OUT-FIRST'), 'no stdout text leaked into stderr');
  c.equal(owned.stdout, direct.stdout, 'stdout matches runCommand');
  c.equal(owned.stderr, direct.stderr, 'stderr matches runCommand');
  c.equal(owned.stdoutTruncated, false, 'stdout not truncated');
  c.equal(owned.stderrTruncated, false, 'stderr not truncated');
});

// ── 3 & 4. byte budgets ─────────────────────────────────────────────────────

test('a stdout budget cuts the stream and ends the owned tree', async (c) => {
  const beats = c.watch(tempDir('ao-owned-hb-'));
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${beats}`, '--children=3', '--stdout-bytes=200000', '--hang'],
    maxStdoutBytes: 1000,
    timeoutMs: 30_000,
  });
  c.equal(owned.outcome, 'OUTPUT_LIMIT_EXCEEDED', 'outcome');
  c.equal(owned.failureCode, 'OUTPUT_LIMIT_STDOUT', 'failure code names stdout');
  c.equal(owned.stdout.length, 1000, 'stdout cut at the budget');
  c.equal(owned.stdoutTruncated, true, 'stdout reported truncated');
  c.equal(owned.stderrTruncated, false, 'stderr not reported truncated');
  c.equal(owned.boundaryLostReason, null, 'not reported as a boundary loss');

  // The differential half, without a tree: `runCommand` would take a tree down
  // with `taskkill`, and a case comparing that would be comparing containment
  // mechanisms rather than budget semantics.
  // Watched too. These run a `--hang` fixture down *both* runners, so they
  // start processes as surely as the case above does — and an earlier version
  // of this file left them out of every survivor check while its header
  // claimed otherwise.
  const differentialBeats = c.sweepOnly(tempDir('ao-owned-hb-'));
  const { owned: plain, direct } = await bothPaths(
    [fixture, `--heartbeat=${differentialBeats}`, '--stdout-bytes=200000', '--hang'],
    { maxStdoutBytes: 1000, timeoutMs: 30_000 },
  );
  c.equal(plain.stdout, direct.stdout, 'the cut output matches runCommand byte for byte');
  c.equal(direct.outcome, 'OUTPUT_LIMIT_EXCEEDED', 'runCommand agrees on the outcome');
  c.equal(direct.failureCode, 'OUTPUT_LIMIT_STDOUT', 'runCommand agrees on the failure code');
});

test('a stderr budget cuts its own stream and ends the owned tree', async (c) => {
  const beats = c.watch(tempDir('ao-owned-hb-'));
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${beats}`, '--children=3', '--stderr-bytes=200000', '--hang'],
    maxStderrBytes: 512,
    timeoutMs: 30_000,
  });
  c.equal(owned.outcome, 'OUTPUT_LIMIT_EXCEEDED', 'outcome');
  c.equal(owned.failureCode, 'OUTPUT_LIMIT_STDERR', 'failure code names stderr');
  c.equal(owned.stderr.length, 512, 'stderr cut at the budget');
  c.equal(owned.stderrTruncated, true, 'stderr reported truncated');
  c.equal(owned.stdoutTruncated, false, 'stdout not reported truncated');

  const differentialBeats = c.sweepOnly(tempDir('ao-owned-hb-'));
  const { owned: plain, direct } = await bothPaths(
    [fixture, `--heartbeat=${differentialBeats}`, '--stderr-bytes=200000', '--hang'],
    { maxStderrBytes: 512, timeoutMs: 30_000 },
  );
  c.equal(plain.stderr, direct.stderr, 'the cut output matches runCommand byte for byte');
  c.equal(direct.failureCode, 'OUTPUT_LIMIT_STDERR', 'runCommand agrees on the failure code');
});

// ── 5. timeout ──────────────────────────────────────────────────────────────

test('a timeout ends the owned tree and is a timeout, not a loss', async (c) => {
  const beats = c.watch(tempDir('ao-owned-hb-'));
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${beats}`, '--children=3', '--hang'],
    // Scaled, and generously: this budget has to outlast establishment on a
    // runner that slows down *after* the measurement, or the case fails as an
    // assertion about `established` rather than as the timeout it measures.
    timeoutMs: settleBudgetMs(),
  });
  c.equal(owned.outcome, 'TIMED_OUT', 'outcome');
  c.equal(owned.failureCode, 'TIMEOUT', 'failure code');
  c.equal(owned.boundaryLostReason, null, 'not attributed to a lost boundary');
  c.equal(owned.established, true, 'ownership had been established');
  c.check(owned.childPid !== null, 'the child pid is reported');

  const differentialBeats = c.sweepOnly(tempDir('ao-owned-hb-'));
  const { direct } = await bothPaths(
    [fixture, `--heartbeat=${differentialBeats}`, '--hang'],
    { timeoutMs: settleBudgetMs() },
  );
  c.equal(direct.outcome, 'TIMED_OUT', 'runCommand agrees on the outcome');
  c.equal(direct.failureCode, 'TIMEOUT', 'runCommand agrees on the failure code');
});

// ── 6. cancellation ─────────────────────────────────────────────────────────

test('an explicit cancellation is its own ending, and takes the tree', async (c) => {
  const beats = c.watch(tempDir('ao-owned-hb-'));
  const canceller = new AbortController();
  const run = runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${beats}`, '--children=3', '--hang'],
    timeoutMs: 30_000,
    signal: canceller.signal,
  });
  c.check(await waitForTree(beats, 4), 'the tree came up before it was cancelled');
  canceller.abort();

  const owned = await run;
  c.equal(owned.outcome, 'TERMINATED_BY_CALLER', 'outcome');
  c.equal(owned.failureCode, 'TERMINATED_BY_CALLER', 'failure code');
  c.equal(owned.boundaryLostReason, null, 'a cancellation is not a loss');
});

// ── 7. an unasked helper death ──────────────────────────────────────────────

test('a helper killed by someone else is always a boundary loss', async (c) => {
  const beats = c.watch(tempDir('ao-owned-hb-'));
  const workDir = tempDir('ao-owned-work-');
  const run = runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${beats}`, '--children=3', '--hang'],
    timeoutMs: 30_000,
    workDir,
  });
  c.check(await waitForTree(beats, 4), 'the tree came up before the helper was killed');
  const helperPid = await waitForHelperPid(workDir);
  c.check(helperPid !== null, 'the helper published a pid');
  if (helperPid !== null) killOnly(helperPid);

  const owned = await run;
  // The defect the ADR added a fifth outcome for: ownership had been reported,
  // the pipes closed cleanly, and no child exit code ever arrived.
  c.equal(owned.outcome, 'BOUNDARY_LOST', 'outcome');
  c.equal(owned.failureCode, 'BOUNDARY_LOST', 'failure code');
  c.equal(owned.boundaryLostReason, 'NO_CHILD_EXIT_OBSERVED', 'reason');
  c.equal(owned.sideEffectsPossible, true, 'side effects are possible');
});

// ── 8-9. evidence that cannot be trusted ──────────────────────────────────────

test('a launch whose evidence cannot be trusted never completes', async (c) => {
  const workDir = tempDir('ao-owned-work-');
  // A directory where the status file belongs. `startOwnedProcess` removes a
  // stale status before it starts, and cannot remove this one — so it refuses
  // rather than launching into a place it cannot publish evidence to.
  mkdirSync(join(workDir, 'status.txt'));
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, '--exit=0'],
    workDir,
    timeoutMs: 10_000,
  });
  c.equal(owned.outcome, 'LAUNCH_REFUSED', 'outcome');
  c.check(owned.outcome !== 'COMPLETED', 'never a completion');
  c.equal(owned.established, false, 'ownership was never established');
  c.equal(owned.boundaryFailureCode, 'BOUNDARY_STATUS_FOREIGN', 'boundary failure code');
  c.equal(owned.exitCode, null, 'no exit code is invented');
});

test('a missing target is refused, and nothing ran', async (c) => {
  const owned = await runOwnedCommand({
    file: join(tempDir('ao-owned-missing-'), 'no-such-program.exe'),
    args: [],
    timeoutMs: 10_000,
  });
  c.equal(owned.outcome, 'LAUNCH_REFUSED', 'outcome');
  c.equal(owned.established, false, 'ownership was never established');
  c.equal(owned.targetStarted, 'NO', 'the boundary proved nothing ran');
  c.equal(owned.sideEffectsPossible, false, 'so no side effects are possible');
});

// ── 10-14. the stdin vocabulary ──────────────────────────────────────────────

test('a payload read to end-of-file is DELIVERED', async (c) => {
  const reportDir = tempDir('ao-owned-report-');
  const report = join(reportDir, 'stdin.json');
  const payload = 'x'.repeat(300_000);
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${c.sweepOnly(tempDir('ao-owned-hb-'))}`, '--stdin=drain', `--report=${report}`],
    stdin: payload,
    timeoutMs: 30_000,
  });
  c.equal(owned.outcome, 'COMPLETED', 'outcome');
  c.equal(owned.stdinDelivery, 'DELIVERED', 'delivery');
  c.check(existsSync(report), 'the child wrote its report');
  if (existsSync(report)) {
    const read = JSON.parse(readFileSync(report, 'utf8')).stdinBytes;
    c.equal(read, payload.length, 'the child read the whole payload');
  }

  const directReport = join(reportDir, 'stdin-direct.json');
  const direct = await runCommand(
    process.execPath,
    [fixture, `--heartbeat=${c.sweepOnly(tempDir('ao-owned-hb-'))}`, '--stdin=drain', `--report=${directReport}`],
    { env: process.env, stdin: payload, timeoutMs: 30_000 },
  );
  c.equal(direct.stdinDelivery, 'DELIVERED', 'runCommand agrees');
});

test('a child that exits without reading is never DELIVERED', async (c) => {
  const payload = 'x'.repeat(4_000_000);
  const owned = await runOwnedCommand({
    file: process.execPath,
    // `close`, not `exit`: the child closes its read end and stays alive for a
    // moment. The boundary's `BROKEN_PIPE` is recorded on a background thread
    // that nothing joins, so with a child that exits in the same instant, the
    // key reaching the status file is a race against the helper's own teardown.
    // A child that lingers takes the race out without changing what the case is
    // about — a payload nothing read.
    args: [
      fixture,
      `--heartbeat=${c.sweepOnly(tempDir('ao-owned-hb-'))}`,
      '--stdin=close',
      '--sleep-ms=400',
      '--exit=0',
    ],
    stdin: payload,
    timeoutMs: 30_000,
  });
  c.check(
    owned.stdinDelivery !== 'DELIVERED',
    `delivery must not be DELIVERED, got ${owned.stdinDelivery}`,
  );
  c.equal(owned.stdinDelivery, 'FAILED', 'delivery');
  // The process-level and channel-level facts are separate, and both are true:
  // the child exited zero having read nothing at all.
  c.equal(owned.outcome, 'COMPLETED', 'outcome');
  c.equal(owned.exitCode, 0, 'exit code');
  // Asserted rather than noted, because it is the mechanism the whole stdin
  // design rests on: the helper observed the child close its read end, said so,
  // and stayed alive to report the child's exit. The ADR describes this as
  // being observed "only because the helper exits and its own pipe breaks in
  // turn" — a run that completes with the child's own exit code *and* a
  // broken-pipe report is what shows that description is not the shipped one.
  c.equal(owned.ending?.status?.stdinForward, 'BROKEN_PIPE', 'the boundary reported the broken pipe');

  const direct = await runCommand(
    process.execPath,
    [
      fixture,
      `--heartbeat=${c.sweepOnly(tempDir('ao-owned-hb-'))}`,
      '--stdin=close',
      '--sleep-ms=400',
      '--exit=0',
    ],
    {
    env: process.env,
    stdin: payload,
    timeoutMs: 30_000,
  });
  c.check(
    direct.stdinDelivery !== 'DELIVERED',
    `runCommand must not report DELIVERED either, got ${direct.stdinDelivery}`,
  );
});

test('a payload fully forwarded to a child that never reads it is DELIVERED', async (c) => {
  const beats = c.sweepOnly(tempDir('ao-owned-hb-'));
  // The shape a review argued would be racy: the child never touches stdin and
  // exits on its own, so the payload — small enough for the pipe buffer — is
  // fully forwarded, and the helper's report of that comes from a background
  // thread rather than from the thread that writes the final status.
  //
  // What this case pins is the behaviour: DELIVERED requires both halves, and
  // both are present here. What it does **not** do is kill the mutant that
  // removes `WriteStatus()` from that branch of `AoLaunch.cs` — measured, 12
  // out of 12 still reported DELIVERED with the publish removed, because a node
  // child takes far longer to start than a pipe write takes to finish. The
  // publish stays in the helper as hardening, and this comment says so rather
  // than letting a repeated loop imply a counter-proof it does not provide.
  //
  // Repeated anyway: a delivery state that resolved the right way once has not
  // been measured.
  // The child lingers, and that is not a weakening of the case: what it
  // measures is a child that never *reads* stdin, not one that wins a race
  // against the helper's pump thread. With `--sleep-ms=0` the 38-byte forward
  // had to complete before a freshly booted node process reached its first
  // timer — losing that race turns the run into a BROKEN_PIPE and fails the
  // gate, on a loaded machine, for a reason the case is not about.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const owned = await runOwnedCommand({
      file: process.execPath,
      args: [fixture, `--heartbeat=${beats}`, '--stdin=ignore', '--sleep-ms=300', '--exit=0'],
      stdin: 'a payload that fits in one pipe buffer',
      timeoutMs: 15_000,
    });
    c.equal(owned.outcome, 'COMPLETED', `attempt ${attempt}: outcome`);
    c.equal(owned.stdinDelivery, 'DELIVERED', `attempt ${attempt}: delivery`);
  }
});

test('a termination during a transfer in flight is UNCONFIRMED', async (c) => {
  const beats = c.watch(tempDir('ao-owned-hb-'));
  // The child never reads, so the pipe fills and the write is still in flight
  // when the timeout takes the tree down. Nothing observed the payload's fate,
  // and that is what the result has to say.
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${beats}`, '--stdin=ignore', '--hang'],
    stdin: 'x'.repeat(8_000_000),
    timeoutMs: settleBudgetMs(),
  });
  c.equal(owned.outcome, 'TIMED_OUT', 'outcome');
  c.equal(owned.stdinDelivery, 'UNCONFIRMED', 'delivery');
});

test('no payload is NOT_REQUESTED, and the child still sees end-of-file', async (c) => {
  const reportDir = tempDir('ao-owned-report-');
  const report = join(reportDir, 'stdin.json');
  const { owned, direct } = await bothPaths(
    [fixture, `--heartbeat=${c.sweepOnly(tempDir('ao-owned-hb-'))}`, '--stdin=drain', `--report=${report}`],
    { timeoutMs: 15_000 },
  );
  // A child reading to end-of-file exits only because it saw one. That it
  // completed at all is the evidence that the boundary forwarded the EOF.
  c.equal(owned.outcome, 'COMPLETED', 'outcome');
  c.equal(owned.stdinDelivery, 'NOT_REQUESTED', 'delivery');
  c.equal(direct.stdinDelivery, 'NOT_REQUESTED', 'runCommand agrees');
});

// ── 15-17. what the caller asked for actually reaches the target ─────────────

test('the working directory, the environment, the argv and the mode arrive', async (c) => {
  // Nothing measured this. `verbatim`, `cwd`, `env` and `mode` are forwarded to
  // `startOwnedProcess` and every one of them could be deleted with the whole
  // gate still green — including `env`, which is the channel a later slice uses
  // to scope an agent's environment, and `cwd`, which is what puts a writer in
  // its worktree rather than in AO's own directory.
  //
  // The read-back runs through this file's own fixture rather than slice 1's
  // echo fixture, because this one can also heartbeat: a case that starts a
  // process no survivor sweep can see is the gap this file's header has
  // overstated once per round.
  const home = tempDir('ao-owned-cwd-');
  const beats = c.sweepOnly(tempDir('ao-owned-hb-'));
  const payload = ['plain', 'with space', 'quote"inside', 'back\\slash', '', 'a&b|c'];
  const args = [fixture, '--echo', `--heartbeat=${beats}`, ...payload];

  for (const mode of ['JOBLIST', 'SUSPENDED']) {
    const owned = await runOwnedCommand({
      file: process.execPath,
      args,
      cwd: home,
      env: { AO_BOUNDARY_PROBE: 'forwarded', SystemRoot: process.env['SystemRoot'] ?? '' },
      mode,
      timeoutMs: 30_000,
    });
    c.equal(owned.outcome, 'COMPLETED', `${mode}: outcome`);
    // The placement mode, read back from the boundary's own status rather than
    // from the request. Without this the `mode` forwarding could be deleted and
    // both iterations would silently run JOBLIST.
    c.equal(owned.ending?.status?.mode, mode, `${mode}: the mode the boundary used`);
    let report = null;
    try {
      report = JSON.parse(owned.stdout.trim().split('\n')[0]);
    } catch {
      c.check(false, `${mode}: the target did not report: ${JSON.stringify(owned.stdout)}`);
      continue;
    }
    const expected = args.slice(1);
    c.check(
      JSON.stringify(report.argv) === JSON.stringify(expected),
      `${mode}: argv arrived as ${JSON.stringify(report.argv)}`,
    );
    c.equal(report.cwd, home, `${mode}: working directory`);
    c.equal(report.env.AO_BOUNDARY_PROBE, 'forwarded', `${mode}: the caller's variable`);
    // A replaced environment, not an inherited one: the helper's own PATH must
    // not be there, because the request named an environment that has none.
    c.equal(report.env.PATH, null, `${mode}: the environment was replaced, not merged`);
  }
});

test('verbatim hands the command line over untouched', async (c) => {
  // The other half of the forwarding surface, and the one no case exercised at
  // all: `verbatim: true` joins the arguments behind a quoted file instead of
  // quoting each of them MSVCRT-style. An argument containing a space is what
  // tells the two apart — quoted it arrives as one token, verbatim it arrives
  // as two — so this case cannot pass with the flag ignored in either
  // direction.
  const beats = c.sweepOnly(tempDir('ao-owned-hb-'));

  const quoted = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, '--echo', `--heartbeat=${beats}`, 'one two'],
    timeoutMs: 30_000,
  });
  c.equal(quoted.outcome, 'COMPLETED', 'quoted: outcome');
  const quotedArgv = JSON.parse(quoted.stdout.trim().split('\n')[0]).argv;
  c.check(
    quotedArgv.includes('one two'),
    `quoted: the space survived as one token, got ${JSON.stringify(quotedArgv)}`,
  );

  const raw = await runOwnedCommand({
    file: process.execPath,
    verbatim: true,
    // Verbatim means the caller does its own quoting, and the script path is
    // part of what it must quote.
    args: [`"${fixture}"`, '--echo', `--heartbeat=${beats}`, 'one two'],
    timeoutMs: 30_000,
  });
  c.equal(raw.outcome, 'COMPLETED', 'verbatim: outcome');
  const rawArgv = JSON.parse(raw.stdout.trim().split('\n')[0]).argv;
  c.check(
    !rawArgv.includes('one two') && rawArgv.includes('one') && rawArgv.includes('two'),
    `verbatim: the line was handed over untouched, got ${JSON.stringify(rawArgv)}`,
  );
});

test('a budget the caller disabled bounds nothing, on both paths', async (c) => {
  // `Infinity` is a caller saying "no cap". Folding it into the default did not
  // merely cut the stream short — it reported an output-limit failure and
  // terminated the job for a limit that had been switched off.
  const args = [
    fixture,
    `--heartbeat=${c.sweepOnly(tempDir('ao-owned-hb-'))}`,
    '--stdout-bytes=2000000',
    '--exit=0',
  ];
  const owned = await runOwnedCommand({
    file: process.execPath,
    args,
    maxStdoutBytes: Number.POSITIVE_INFINITY,
    timeoutMs: 60_000,
  });
  const direct = await runCommand(process.execPath, args, {
    env: process.env,
    maxStdoutBytes: Number.POSITIVE_INFINITY,
    timeoutMs: 60_000,
  });
  c.equal(owned.outcome, 'COMPLETED', 'outcome');
  c.equal(owned.stdoutTruncated, false, 'not truncated');
  c.equal(owned.stdout.length, 2_000_000, 'every byte kept');
  c.equal(direct.outcome, 'COMPLETED', 'runCommand agrees on the outcome');
  c.equal(owned.stdout.length, direct.stdout.length, 'and on the byte count');
});

// ── 18. the two policies, ordered and contending ────────────────────────────

test('a budget and a timeout each name their own outcome, and never a third', async (c) => {
  // Three parts, and the first review is the reason they are three.
  //
  // The original single case set `timeoutMs: 60`, which is less than a helper
  // spawn: the whole budget was consumed by establishment, so
  // `runOwnedCommand` terminated synchronously before a byte of output could
  // arrive. It resolved to `TIMED_OUT` every time, and its assertion derived
  // the expected failure code *from* the outcome it had just read — so it
  // measured neither ordering, and could not fail.

  // (a) the budget, clearly first.
  {
    const beats = c.watch(tempDir('ao-owned-hb-'));
    const owned = await runOwnedCommand({
      file: process.execPath,
      args: [fixture, `--heartbeat=${beats}`, '--stdout-bytes=4000000', '--hang'],
      maxStdoutBytes: 64,
      timeoutMs: 30_000,
    });
    c.equal(owned.outcome, 'OUTPUT_LIMIT_EXCEEDED', 'budget-first outcome');
    c.equal(owned.failureCode, 'OUTPUT_LIMIT_STDOUT', 'budget-first failure code');
  }

  // (b) the timeout, clearly first: the child produces nothing at all.
  {
    const beats = c.watch(tempDir('ao-owned-hb-'));
    const owned = await runOwnedCommand({
      file: process.execPath,
      args: [fixture, `--heartbeat=${beats}`, '--hang'],
      maxStdoutBytes: 64,
      timeoutMs: 2_000,
    });
    c.equal(owned.outcome, 'TIMED_OUT', 'timeout-first outcome');
    c.equal(owned.failureCode, 'TIMEOUT', 'timeout-first failure code');
  }

  // (c) contention. The deadline is placed *around* the moment establishment
  // finishes, which is when the flood begins — so the two policies are armed
  // to fire within milliseconds of each other. Which one wins is genuinely not
  // predictable, and is not what is asserted; what is asserted is that the
  // result is always one of the two, always carries that outcome's own code,
  // and is never a completion or a boundary loss.
  //
  // The expected codes come from a literal written here, not from the outcome
  // the run reported, so a classifier that returned the wrong pair would fail
  // this rather than agree with itself.
  // Two answers, and no third. A deadline that expires before ownership used to
  // arrive here as `LAUNCH_REFUSED`; since it is reported as the timeout it is,
  // a refusal in this window would mean something else went wrong, and this
  // case should say so rather than accept it.
  const EXPECTED = {
    TIMED_OUT: 'TIMEOUT',
    OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_STDOUT',
  };

  // Establishment measured for itself, through the boundary directly. Timing a
  // whole `runOwnedCommand` instead would fold the child's entire lifetime into
  // the number, and the window below would then be centred on the wrong moment
  // — which is how the previous version of this case ended up straddling
  // nothing.
  c.note(`establishment alone took ${establishMs}ms`);

  // The deltas reach well to both sides of establishment, deliberately. A
  // window that only straddles the moment the flood begins produces the budget
  // every time — measured, and recorded in the note below — so the negative end
  // is what puts the deadline genuinely before there is any output to bound.
  const seen = new Map();
  // Two of these are not a straddle at all, and they are here because the two
  // guards below must not be able to fail for a reason that is not a defect: a
  // 1ms budget cannot reach ownership on any machine, and a budget four times
  // measured establishment plus a second cannot fail to. The rest sweep the
  // window between them, which is where the contention actually is.
  const budgets = [
    1,
    ...[-90, -70, -50, -30, -15, -5, 0, 10, Math.round(establishMs / 2)].map((delta) =>
      Math.max(1, establishMs + delta),
    ),
    // Two of them, generous on purpose and more generous than establishment
    // alone: these runs must reach the stdout budget, which needs the *child*
    // to boot and start writing after ownership is established. Establishment
    // ends when the helper reports membership, before the target has run a
    // line, so the slack has to cover a cold node start as well.
    //
    // Two rather than one because the guard below is otherwise carried by a
    // single budget: measured here, the sweep resolves to nine timeouts and two
    // limit hits, and losing the one wide budget on a loaded runner would turn
    // the gate red for a reason that is not a defect. Neither run costs its
    // budget — a budget that fires ends the run at once.
    establishMs * 8 + 3_000,
    establishMs * 20 + 10_000,
  ];
  for (const timeoutMs of budgets) {
    const beats = c.sweepOnly(tempDir('ao-owned-hb-'));
    const owned = await runOwnedCommand({
      file: process.execPath,
      args: [fixture, `--heartbeat=${beats}`, '--stdout-bytes=4000000', '--hang'],
      maxStdoutBytes: 64,
      timeoutMs,
    });
    seen.set(owned.outcome, (seen.get(owned.outcome) ?? 0) + 1);
    const expected = EXPECTED[owned.outcome];
    c.check(
      expected !== undefined,
      `budget ${timeoutMs}ms: outcome must be one of the two policies, got ${owned.outcome}`,
    );
    if (expected !== undefined) {
      c.equal(owned.failureCode, expected, `budget ${timeoutMs}ms: failure code`);
    }
  }
  c.note(`contention resolved to ${[...seen].map(([k, n]) => `${k}×${n}`).join(', ')}`);
  // Both sides, and this is the second attempt at this assertion. The first
  // required only that *some* run reach a policy — which the round-2 change
  // that reports an expired establishment deadline as `TIMED_OUT` silently
  // satisfied, so ten runs that all expired before ownership passed a guard
  // written to catch exactly that. Requiring a stdout budget as well is what
  // makes it say something: the budget can only fire after ownership, with the
  // child already flooding.
  c.check(
    (seen.get('OUTPUT_LIMIT_EXCEEDED') ?? 0) > 0,
    'the window must reach past establishment: some run has to hit the stdout ' +
      `budget, got ${JSON.stringify(Object.fromEntries(seen))}`,
  );
  c.check(
    (seen.get('TIMED_OUT') ?? 0) > 0,
    'the window must reach before the flood: some run has to time out, ' +
      `got ${JSON.stringify(Object.fromEntries(seen))}`,
  );
});

// ── 19. a deadline that expires during establishment ───────────────────────────────────────────────────

test('an unknown launch stays conservative about side effects', async (c) => {
  // A wall-clock budget too small for a process to start in. Establishment
  // cannot finish, so the boundary refuses without ever having reported what it
  // did or did not create.
  //
  const owned = await runOwnedCommand({
    file: process.execPath,
    // A heartbeat directory even here, and especially here: `targetStarted` is
    // `UNKNOWN`, which means the target *may* have been created — and if it was,
    // a heartbeat is the only thing that would show it outliving the refusal.
    args: [fixture, `--heartbeat=${c.sweepOnly(tempDir('ao-owned-hb-'))}`, '--hang'],
    timeoutMs: 1,
  });
  // A timeout, not a refused launch — this call's own wall clock ran out, and
  // `timeoutMs` is documented as the budget for the whole call. The boundary
  // can only report that ownership was not established in time, and that report
  // is kept: it is what says whether anything may have run.
  c.equal(owned.outcome, 'TIMED_OUT', 'outcome');
  c.equal(owned.failureCode, 'TIMEOUT', 'failure code');
  c.equal(owned.established, false, 'ownership was never established');
  c.equal(owned.boundaryFailureCode, 'BOUNDARY_NOT_ESTABLISHED_IN_TIME', 'boundary failure code');
  // Strict, not a disjunction. A 1ms budget expires on the first status poll,
  // long before a .NET helper has written anything, so there is no status this
  // launch could claim and UNKNOWN is the only honest answer. The earlier
  // version accepted NO as well — which is the one value that would make this
  // case worth failing, because it would mean the refusal claimed proof it does
  // not have.
  c.equal(owned.targetStarted, 'UNKNOWN', 'targetStarted');
  c.equal(owned.sideEffectsPossible, true, 'an unknown launch may have had side effects');
});

// ── run ─────────────────────────────────────────────────────────────────────

if (process.platform !== 'win32') {
  console.error('The launch boundary is a Windows component; this check only runs on Windows.');
  process.exit(1);
}

let failed = 0;
establishMs = await measureEstablishment();
console.log(`  note: establishing ownership costs ${establishMs}ms here (worst of three)`);
for (const { name, run } of cases) {
  const c = new Case(name);
  const startedAt = Date.now();
  try {
    await run(c);
  } catch (error) {
    c.failures.push(`threw: ${error?.stack ?? String(error)}`);
  }
  // Hygiene for the cases that started something: a case that leaves a process
  // executing has not measured what it claims to.
  for (const dir of c.heartbeatDirs) {
    const live = await liveCount(dir);
    if (live !== 0) c.failures.push(`${live} fixture process(es) still running afterwards`);
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

// One sweep over everything, at the end. A process that outlived its own case
// by longer than that case's window is still a survivor, and the per-case check
// is too close to the event to see it.
{
  const stragglers = await liveCountAcross(heartbeatDirs);
  if (stragglers > 0) {
    failed += 1;
    console.log(`  FAIL final sweep: ${stragglers} fixture process(es) still running`);
  } else {
    console.log('  ok   final sweep: nothing from any case is still running');
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
  console.error(`\nowned command adapter: ${failed} case(s) failed.`);
  process.exit(1);
}
console.log('\nowned command adapter: every case held.');
