/**
 * AO-008-S2-R1 — a real-process probe of the supervisor's *release* contract.
 *
 * Every other test of `superviseWindowsTreeKill` drives a fake tool. A fake can
 * only ever confirm that the supervisor behaves as the fake was written to
 * expect, so it cannot answer the one question this slice turns on: when the
 * tool process refuses to die, does the supervisor still let this Node process
 * make progress and finish?
 *
 * So this file runs the real supervisor, in a real child Node process, over a
 * real, long-lived, test-owned Node helper that stands in for a `taskkill.exe`
 * that ignores the kill request. The tool seam is neutered on purpose — its
 * `kill()` returns `false`, throws, or lies and returns `true`, and in no case
 * does it touch the helper — so the helper is *provably still running* when the
 * supervisor resolves.
 *
 * What the probe proves:
 *
 *  - the supervisor resolves `NOT_TREE_KILLED` in bounded time even though no
 *    termination was ever observed;
 *  - the harness process then **exits on its own**, with code 0, although the
 *    helper it started is still alive — i.e. the released tool handle no longer
 *    holds the event loop open. A negative control (identical, minus `unref`)
 *    shows the harness hanging instead, so the exit above is not vacuous.
 *
 * What the probe explicitly does **not** prove, and never claims:
 *
 *  - that a kill request terminated anything. The helper survives every run
 *    here by construction, and the outer test has to clean it up itself,
 *    PID-precisely, in a `finally`. That is the honest shape of a best-effort
 *    contract: hard ownership of a foreign process tree needs a Windows Job
 *    Object, which is a separate architectural task.
 *
 * Process discipline: every PID this file creates is recorded, cleaned up
 * PID-precisely, and asserted gone at the end. Nothing is enumerated, and no
 * process this file did not start is ever signalled.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/** The three neutered kill behaviours, plus the negative control. */
type HarnessMode = 'kill-false' | 'kill-throws' | 'kill-ignored' | 'control-no-unref';
type HarnessTrigger = 'timeout' | 'cancel';

interface HarnessResult {
  readonly mode: HarnessMode;
  readonly trigger: HarnessTrigger;
  readonly helperPid: number | null;
  readonly killCount: number;
  readonly unrefCount: number;
  readonly fallbackCount: number;
  readonly outcome?: string;
  readonly helperAliveAfterOutcome?: boolean;
  readonly failure?: string;
}

const SUPERVISOR_URL = pathToFileURL(
  resolve(import.meta.dirname, '../src/doctor/internal/windows-process-tree-termination.js'),
).href;

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * The harness, run as its own Node process under `tsx`.
 *
 * It must end by simply running out of work — never `process.exit()` — because
 * "this process could still terminate" is the entire claim under test.
 */
const HARNESS_SOURCE = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { superviseWindowsTreeKill } from ${JSON.stringify(SUPERVISOR_URL)};

const resultPath = process.argv[2];
const mode = process.argv[3];
const trigger = process.argv[4];

let helperPid = null;
let killCount = 0;
let unrefCount = 0;
let fallbackCount = 0;

function record(extra) {
  writeFileSync(
    resultPath,
    JSON.stringify({ mode, trigger, helperPid, killCount, unrefCount, fallbackCount, ...extra }),
    'utf8',
  );
}

async function main() {
  // The stand-in for a taskkill.exe that will not die: an idle timer, no stdio,
  // and no relationship to this process beyond the handle below.
  //
  // \`detached\` matters here. A non-detached child is torn down by the platform
  // when this harness exits, which would quietly hide the very thing the probe
  // is about — the outer test must be able to observe, and then clean up, a
  // tool process that genuinely outlived the supervisor that started it.
  const helper = spawn(process.execPath, ['-e', 'setInterval(function () {}, 3600000);'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  helperPid = helper.pid ?? null;

  const seam = {
    on: (event, listener) => helper.on(event, listener),
    kill: () => {
      killCount += 1;
      // Deliberately never signals the helper: the point is a kill request that
      // does not terminate the tool.
      if (mode === 'kill-throws') throw new Error('AO_S2_HARNESS_KILL_THROW_SENTINEL');
      if (mode === 'kill-false') return false;
      return true;
    },
  };
  if (mode !== 'control-no-unref') {
    seam.unref = () => {
      unrefCount += 1;
      helper.unref();
    };
  }

  const supervisor = superviseWindowsTreeKill(4242, {
    resolveToolPath: () => 'AO_S2_HARNESS_TOOL_PATH',
    spawnTool: () => seam,
    killImmediateChild: () => {
      fallbackCount += 1;
    },
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      handle.unref?.();
      return handle;
    },
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
    timeoutMs: 50,
  });

  if (trigger === 'cancel') supervisor.cancel();

  const outcome = await supervisor.outcome;

  record({
    outcome,
    // Still running, and this is recorded as fact, not as a failure: the tool
    // process is expected to outlive the supervisor in every mode here.
    helperAliveAfterOutcome: helper.exitCode === null && helper.signalCode === null,
  });
}

try {
  await main();
} catch (error) {
  record({ failure: String(error) });
}
`;

let scratchDir: string;
let harnessPath: string;

/** Every PID this file created, for the PID-precise inventory below. */
const ownedPids = new Set<number>();

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'ao-s2-release-'));
  // `.mts`, not `.ts`: this scratch directory has no `package.json`, so the
  // explicit ESM extension is what lets the harness use top-level `await`.
  harnessPath = join(scratchDir, 'tree-kill-release-harness.mts');
  writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function terminateOwnedPid(pid: number): Promise<boolean> {
  if (!isAlive(pid)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone between the check and the signal */
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

afterEach(async () => {
  // PID-precise, and only for PIDs this file itself started.
  for (const pid of ownedPids) {
    await terminateOwnedPid(pid);
  }
});

afterAll(async () => {
  for (const pid of ownedPids) {
    expect(await terminateOwnedPid(pid)).toBe(true);
  }
  // The inventory closes at zero: no process this file created is left running.
  const survivors = [...ownedPids].filter((pid) => isAlive(pid));
  expect(survivors).toEqual([]);
  ownedPids.clear();
  rmSync(scratchDir, { recursive: true, force: true });
});

interface HarnessRun {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stderr: string;
  readonly result: HarnessResult | null;
  readonly durationMs: number;
}

/**
 * Runs one harness process to completion, or to `watchdogMs` — whichever comes
 * first. A watchdog hit is reported, never swallowed: for the positive cases it
 * *is* the failure, and for the negative control it is the expected outcome.
 */
async function runHarness(
  mode: HarnessMode,
  trigger: HarnessTrigger,
  watchdogMs: number,
): Promise<HarnessRun> {
  const resultPath = join(scratchDir, `result-${mode}-${trigger}-${Date.now()}.json`);
  const startedAt = Date.now();

  const harness = spawn(
    process.execPath,
    ['--import', 'tsx', harnessPath, resultPath, mode, trigger],
    { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  if (harness.pid !== undefined) ownedPids.add(harness.pid);

  let stderr = '';
  harness.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>(
    (resolvePromise) => {
      const watchdog = setTimeout(() => resolvePromise(null), watchdogMs);
      watchdog.unref?.();
      harness.on('exit', (code, signal) => {
        clearTimeout(watchdog);
        resolvePromise({ code, signal });
      });
    },
  );

  let result: HarnessResult | null = null;
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf8')) as HarnessResult;
  } catch {
    result = null;
  }
  // Claimed before any assertion can throw: the helper must be cleaned up even
  // if this run is about to fail.
  if (result?.helperPid != null) ownedPids.add(result.helperPid);

  return {
    exitCode: exited?.code ?? null,
    signal: exited?.signal ?? null,
    timedOut: exited === null,
    stderr,
    result,
    durationMs: Date.now() - startedAt,
  };
}

describe('the supervisor releases a tool process it could not terminate', () => {
  it.each([
    ['kill-false', 'timeout'],
    ['kill-throws', 'cancel'],
    ['kill-ignored', 'timeout'],
  ] as const)(
    'mode %s / trigger %s: bounded NOT_TREE_KILLED, handle released, harness exits while the tool lives',
    async (mode, trigger) => {
      const run = await runHarness(mode, trigger, 20_000);

      expect(run.result).not.toBeNull();
      const result = run.result as HarnessResult;
      expect(result.failure).toBeUndefined();

      // Bounded, without any confirmation that the tool ended.
      expect(result.outcome).toBe('NOT_TREE_KILLED');
      // Exactly one kill request, exactly one release — including when the kill
      // threw, which must not skip the release.
      expect(result.killCount).toBe(1);
      expect(result.unrefCount).toBe(1);
      expect(result.fallbackCount).toBe(trigger === 'cancel' ? 0 : 1);

      // The tool process outlived the supervisor. Recorded as the expected
      // fact it is: nothing here terminated it.
      expect(result.helperAliveAfterOutcome).toBe(true);
      expect(result.helperPid).toBeTypeOf('number');
      expect(isAlive(result.helperPid as number)).toBe(true);

      // The claim: the harness ran out of work and exited by itself, although
      // the child it spawned is still running. Only the released (unref'd)
      // handle makes that possible.
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.signal).toBeNull();
      expect(run.stderr).not.toContain('AO_S2_HARNESS_KILL_THROW_SENTINEL');

      // And the helper is still there afterwards — cleaned up by `afterEach`,
      // PID-precisely, not by anything the supervisor did.
      expect(isAlive(result.helperPid as number)).toBe(true);
    },
    30_000,
  );

  it('negative control — without the release the same harness cannot exit at all', async () => {
    // Identical in every respect except that the seam offers no `unref`, so the
    // still-running tool handle keeps holding the event loop. If this run also
    // exited, the assertions above would be proving nothing.
    const run = await runHarness('control-no-unref', 'timeout', 4_000);

    expect(run.result).not.toBeNull();
    const result = run.result as HarnessResult;
    // The outcome itself is still reached, bounded: it is only the process
    // lifetime that differs.
    expect(result.outcome).toBe('NOT_TREE_KILLED');
    expect(result.killCount).toBe(1);
    expect(result.unrefCount).toBe(0);
    expect(result.helperAliveAfterOutcome).toBe(true);

    expect(run.timedOut).toBe(true);
    expect(run.exitCode).toBeNull();
    expect(isAlive(result.helperPid as number)).toBe(true);
    // Both PIDs are owned and cleaned up PID-precisely by `afterEach`.
  }, 30_000);
});
