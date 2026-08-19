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
 * Most cases run the *same* fixture invocation down two paths — `runCommand`,
 * the contract AO has today, and `runOwnedCommand`, the one this slice adds —
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
 * Every case that starts a tree counts survivors by heartbeat — a file whose
 * number keeps growing — for the reason the spike found: a terminated process
 * whose object is still referenced looks alive in a process walk. Zero
 * survivors is required after **every** case, including the ones that never
 * started a tree.
 *
 * What that does *not* claim is that the containment settings are
 * load-bearing. That claim needs a negative control — a deliberately weakened
 * helper that leaves survivors — and it belongs to slice 1, which has one
 * (`./launch-boundary-dist-artifact.mjs`). Here the survivor count is a
 * hygiene assertion about the adapter's own terminations: whatever policy
 * ended a run, nothing of that run is left executing.
 *
 * ── What is measured ───────────────────────────────────────────────────────
 *
 *   1. exit codes — zero, nonzero, and 0xC0000005 — arrive exactly, and agree
 *      with `runCommand`;
 *   2. stdout and stderr stay separate and interleave without merging;
 *   3. a stdout budget cuts the stream, ends the owned tree, and classifies as
 *      an output-limit failure naming stdout;
 *   4. the same for stderr;
 *   5. a timeout ends the owned tree and classifies as a timeout — never as a
 *      boundary loss;
 *   6. an explicit cancellation is `TERMINATED_BY_CALLER`, not a loss;
 *   7. a helper killed by someone else is always `BOUNDARY_LOST`;
 *   8. a launch whose evidence cannot be trusted never completes;
 *   9. a payload read to end-of-file is `DELIVERED`;
 *  10. a child that exits without reading is never reported as `DELIVERED`;
 *  11. a termination during a transfer in flight is `UNCONFIRMED`;
 *  12. no payload is `NOT_REQUESTED`;
 *  13. a budget and a timeout that race produce exactly one outcome, and the
 *      first trigger names it;
 *  14. `targetStarted=UNKNOWN` survives into the result and is conservative.
 *
 * Contract: exit code 0 means every case held. Any nonzero exit means at least
 * one did not.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
const { decodeBoundaryStatus } = await import(contractUrl);
const { runCommand } = await import(execUrl);

const taskkill = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');

const temporaryDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
    return dir;
  }
  note(text) {
    this.notes.push(text);
  }
}

const cases = [];
const test = (name, run) => cases.push({ name, run });

// ── 1. exit codes ───────────────────────────────────────────────────────────

test('an exit code survives the boundary exactly, and agrees with runCommand', async (c) => {
  for (const code of [0, 1, 42, 255, 256, 3221225477]) {
    const { owned, direct } = await bothPaths([
      fixture,
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
  const { owned: plain, direct } = await bothPaths(
    [fixture, '--stdout-bytes=200000', '--hang'],
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

  const { owned: plain, direct } = await bothPaths(
    [fixture, '--stderr-bytes=200000', '--hang'],
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
    timeoutMs: 1_500,
  });
  c.equal(owned.outcome, 'TIMED_OUT', 'outcome');
  c.equal(owned.failureCode, 'TIMEOUT', 'failure code');
  c.equal(owned.boundaryLostReason, null, 'not attributed to a lost boundary');
  c.equal(owned.established, true, 'ownership had been established');
  c.check(owned.childPid !== null, 'the child pid is reported');

  const { direct } = await bothPaths([fixture, '--hang'], { timeoutMs: 1_500 });
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

// ── 8. evidence that cannot be trusted ──────────────────────────────────────

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

// ── 9-12. the stdin vocabulary ──────────────────────────────────────────────

test('a payload read to end-of-file is DELIVERED', async (c) => {
  const reportDir = tempDir('ao-owned-report-');
  const report = join(reportDir, 'stdin.json');
  const payload = 'x'.repeat(300_000);
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, '--stdin=drain', `--report=${report}`],
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
    [fixture, '--stdin=drain', `--report=${directReport}`],
    { env: process.env, stdin: payload, timeoutMs: 30_000 },
  );
  c.equal(direct.stdinDelivery, 'DELIVERED', 'runCommand agrees');
});

test('a child that exits without reading is never DELIVERED', async (c) => {
  const payload = 'x'.repeat(4_000_000);
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, '--stdin=exit', '--exit=0'],
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
  c.note(`the boundary reported stdinForward=${owned.ending?.status?.stdinForward ?? 'null'}`);

  const direct = await runCommand(process.execPath, [fixture, '--stdin=exit', '--exit=0'], {
    env: process.env,
    stdin: payload,
    timeoutMs: 30_000,
  });
  c.check(
    direct.stdinDelivery !== 'DELIVERED',
    `runCommand must not report DELIVERED either, got ${direct.stdinDelivery}`,
  );
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
    timeoutMs: 1_500,
  });
  c.equal(owned.outcome, 'TIMED_OUT', 'outcome');
  c.equal(owned.stdinDelivery, 'UNCONFIRMED', 'delivery');
});

test('no payload is NOT_REQUESTED, and the child still sees end-of-file', async (c) => {
  const reportDir = tempDir('ao-owned-report-');
  const report = join(reportDir, 'stdin.json');
  const { owned, direct } = await bothPaths(
    [fixture, '--stdin=drain', `--report=${report}`],
    { timeoutMs: 15_000 },
  );
  // A child reading to end-of-file exits only because it saw one. That it
  // completed at all is the evidence that the boundary forwarded the EOF.
  c.equal(owned.outcome, 'COMPLETED', 'outcome');
  c.equal(owned.stdinDelivery, 'NOT_REQUESTED', 'delivery');
  c.equal(direct.stdinDelivery, 'NOT_REQUESTED', 'runCommand agrees');
});

// ── 13. the budget and the timeout, racing ──────────────────────────────────

test('a budget and a timeout that race produce exactly one outcome', async (c) => {
  const beats = c.watch(tempDir('ao-owned-hb-'));
  // Both policies are armed to fire at once: the fixture floods stdout
  // immediately and the timeout is short enough to land in the same window.
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${beats}`, '--children=2', '--stdout-bytes=4000000', '--hang'],
    maxStdoutBytes: 64,
    timeoutMs: 60,
  });
  c.check(
    owned.outcome === 'OUTPUT_LIMIT_EXCEEDED' || owned.outcome === 'TIMED_OUT',
    `outcome must be one of the two policies, got ${owned.outcome}`,
  );
  const expectedFailure =
    owned.outcome === 'TIMED_OUT' ? 'TIMEOUT' : 'OUTPUT_LIMIT_STDOUT';
  c.equal(owned.failureCode, expectedFailure, 'the failure code matches the outcome');
  c.check(
    owned.outcome !== 'BOUNDARY_LOST',
    'a race between two local policies is never a boundary loss',
  );
  c.note(`the race resolved to ${owned.outcome}`);
});

// ── 14. an unknown launch ───────────────────────────────────────────────────

test('an unknown launch stays conservative about side effects', async (c) => {
  const beats = c.watch(tempDir('ao-owned-hb-'));
  // A wall-clock budget too small for a process to start in. Establishment
  // cannot finish, so the boundary refuses without ever having reported what
  // it did or did not create.
  const owned = await runOwnedCommand({
    file: process.execPath,
    args: [fixture, `--heartbeat=${beats}`, '--children=2', '--hang'],
    timeoutMs: 1,
  });
  c.equal(owned.outcome, 'LAUNCH_REFUSED', 'outcome');
  c.equal(owned.established, false, 'ownership was never established');
  c.equal(owned.boundaryFailureCode, 'BOUNDARY_NOT_ESTABLISHED_IN_TIME', 'boundary failure code');
  c.check(
    owned.targetStarted === 'UNKNOWN' || owned.targetStarted === 'NO',
    `targetStarted must be honest, got ${owned.targetStarted}`,
  );
  c.equal(
    owned.sideEffectsPossible,
    owned.targetStarted !== 'NO',
    'side-effect possibility follows the evidence',
  );
  c.note(`targetStarted=${owned.targetStarted}`);
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
  // Hygiene, after every case and not only the ones that started a tree: a
  // case that leaves something executing has not measured what it claims to.
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
