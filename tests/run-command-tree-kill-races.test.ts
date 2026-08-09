/**
 * AO-008-S2 — `runCommand`'s termination lifecycle around the asynchronous
 * Windows tree-kill supervisor.
 *
 * Both the diagnostic child and `taskkill.exe` are intercepted at
 * `node:child_process.spawn` — the seam this repository already uses for
 * spawn-failure coverage (`tests/run-command-spawn-failure.test.ts`). No real
 * foreign process is started, no real `taskkill` runs, and every event is
 * emitted by hand, so each race below is driven rather than provoked. The
 * public `runCommand` API is untouched.
 *
 * These cases exercise the Windows branch of `terminate()`, so they run on
 * Windows only; the platform-independent half of the same machinery is covered
 * exhaustively in `tests/windows-process-tree-termination.test.ts`.
 *
 * What this file pins:
 *  - the first termination trigger wins, and starts exactly one tree-kill;
 *  - a `close` observed while the attempt is open is held until the outcome is
 *    known, then settles with the *original* reason — the ordering the blocking
 *    `execFileSync` predecessor produced, now preserved deliberately;
 *  - the two-stage deadline: tool budget, then `killGraceMs`, and nothing more;
 *  - exactly one settlement, exactly one fallback, no result change from any
 *    late event;
 *  - the event loop keeps running for the whole tool budget — the defect this
 *    slice exists to remove;
 *  - a tool process that refuses the kill request still leaves `runCommand`
 *    bounded: one request, one handle release, one settlement, and every late
 *    tool event inert (AO-008-S2-R1). The fake tool here models that honestly —
 *    `kill()` emits nothing and ends nothing, because on Windows it need not;
 *  - no tool path, tool output or foreign error detail reaches a CommandResult.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const IS_WINDOWS = process.platform === 'win32';

/** Distinctive enough that no unrelated program can match it. */
const TARGET_NAME = 'ao-s2-race-target.exe';

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  killCount: number;
  kill(signal?: string): boolean;
}

interface FakeTool extends EventEmitter {
  killCount: number;
  unrefCount: number;
  /** What `kill()` hands back. `false` models a request the OS refused. */
  killReturnValue: boolean;
  /** True once a kill was requested and the tool is *still* running. */
  alive: boolean;
  kill(signal?: string): boolean;
  unref(): void;
}

// Function declarations: hoisted, so the mock factory below may call them.
function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 31_337;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCount = 0;
  child.kill = () => {
    child.killCount += 1;
    return true;
  };
  return child;
}

function makeFakeTool(): FakeTool {
  const tool = new EventEmitter() as FakeTool;
  tool.killCount = 0;
  tool.unrefCount = 0;
  tool.killReturnValue = true;
  tool.alive = true;
  // A kill request is *only* a request: it emits nothing and does not clear
  // `alive`. Only an emitted `exit`/`close` ends this tool (AO-008-S2-F2).
  tool.kill = () => {
    tool.killCount += 1;
    return tool.killReturnValue;
  };
  tool.unref = () => {
    tool.unrefCount += 1;
  };
  tool.on('exit', () => {
    tool.alive = false;
  });
  tool.on('close', () => {
    tool.alive = false;
  });
  return tool;
}

const control = vi.hoisted(() => ({
  child: null as unknown,
  tools: [] as unknown[],
  toolSpawns: 0,
  childSpawns: 0,
  spawnCalls: [] as { file: string; args: readonly string[]; options: unknown }[],
  /** Fired synchronously inside the taskkill spawn — i.e. inside `terminate()`. */
  onToolSpawn: null as (() => void) | null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], options: unknown) => {
      control.spawnCalls.push({ file, args, options });

      if (/taskkill\.exe$/i.test(file)) {
        control.toolSpawns += 1;
        const tool = makeFakeTool();
        control.tools.push(tool);
        control.onToolSpawn?.();
        return tool as unknown as ReturnType<typeof actual.spawn>;
      }

      if (file.toLowerCase().endsWith(TARGET_NAME) && control.child !== null) {
        control.childSpawns += 1;
        return control.child as ReturnType<typeof actual.spawn>;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.spawn as any)(file, args, options);
    },
  };
});

const { runCommand } = await import('../src/doctor/exec.js');

let scratchDir: string;
let targetPath: string;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'ao-s2-races-'));
  // Only ever resolved, never executed: `spawn` is intercepted above.
  targetPath = join(scratchDir, TARGET_NAME);
  writeFileSync(targetPath, 'placeholder\n', 'utf8');
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

afterEach(() => {
  control.child = null;
  control.tools = [];
  control.toolSpawns = 0;
  control.childSpawns = 0;
  control.spawnCalls = [];
  control.onToolSpawn = null;
});

const PENDING = Symbol('pending');

/** Resolves to the settled value, or to {@link PENDING} if it is still open. */
async function stateOf<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return await Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => {
      setTimeout(() => resolve(PENDING), 30);
    }),
  ]);
}

/** Waits for `terminate()` to have started the single tree-kill attempt. */
async function firstTool(): Promise<FakeTool> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const tool = control.tools[0];
    if (tool !== undefined) return tool as FakeTool;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('taskkill was never spawned');
}

function startRun(
  child: FakeChild,
  options: { timeoutMs?: number; killGraceMs?: number; maxStdoutBytes?: number } = {},
) {
  control.child = child;
  return runCommand(targetPath, [], {
    env: {},
    timeoutMs: options.timeoutMs ?? 15,
    killGraceMs: options.killGraceMs ?? 30_000,
    ...(options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
  });
}

describe.runIf(IS_WINDOWS)('runCommand tree-kill races', () => {
  it('Race A — a second trigger in the same tick neither re-terminates nor changes the reason', async () => {
    const child = makeFakeChild();
    // Fired synchronously inside `terminate('TIMEOUT')`, from within the tool
    // spawn itself: the stdout budget is blown at the exact moment the timeout
    // is being acted on. This is the tightest form of the race.
    control.onToolSpawn = () => {
      child.stdout.emit('data', Buffer.from('X'.repeat(64)));
      child.stdout.emit('data', Buffer.from('Y'.repeat(64)));
    };

    const promise = startRun(child, { timeoutMs: 15, maxStdoutBytes: 4 });
    const tool = await firstTool();

    expect(control.toolSpawns).toBe(1);

    tool.emit('close', 0);
    child.emit('close', null, 'SIGKILL');

    const result = await promise;
    // The first trigger won: TIMEOUT, not OUTPUT_LIMIT_STDOUT.
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('TIMEOUT');
    expect(result.processTreeKilled).toBe(true);
    // Exactly one tree-kill, and no immediate-child fallback for an exit-0 tool.
    expect(control.toolSpawns).toBe(1);
    expect(child.killCount).toBe(0);
  });

  it('Race B — a close during the open attempt is held, then settles with the original reason and no grace wait', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 30_000 });
    const tool = await firstTool();

    child.emit('close', null, 'SIGKILL');

    // The tree-kill outcome is not known yet, so `processTreeKilled` is not
    // known yet either: nothing may be reported.
    expect(await stateOf(promise)).toBe(PENDING);

    const releasedAt = Date.now();
    tool.emit('close', 0);

    const result = await promise;
    expect(Date.now() - releasedAt).toBeLessThan(1_000); // no 30s grace window was entered
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('TIMEOUT');
    expect(result.processTreeKilled).toBe(true);
    expect(child.killCount).toBe(0);
  });

  it('Race C — the grace timer is armed after the attempt, and a later close clears it', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 30_000 });
    const tool = await firstTool();

    tool.emit('close', 0);

    // Stage 2 is now armed and waiting for the child.
    expect(await stateOf(promise)).toBe(PENDING);

    const closedAt = Date.now();
    child.emit('close', null, 'SIGKILL');

    const result = await promise;
    expect(Date.now() - closedAt).toBeLessThan(1_000);
    expect(result.failureCode).toBe('TIMEOUT');
    expect(result.processTreeKilled).toBe(true);
  });

  it('Race D — no close before the grace deadline yields exactly one PROCESS_TREE_KILL_FAILED', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 60 });
    const tool = await firstTool();

    tool.emit('close', 0);

    const result = await promise;
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('PROCESS_TREE_KILL_FAILED');
    expect(result.processTreeKilled).toBe(true);
    expect(result.exitCode).toBeNull();

    // A close arriving after the settlement changes nothing.
    child.emit('close', 0, null);
    await expect(promise).resolves.toBe(result);
  });

  it('Race E — a non-zero tool exit falls back exactly once and keeps the original reason', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 30_000 });
    const tool = await firstTool();

    tool.emit('close', 1);
    expect(child.killCount).toBe(1);

    child.emit('close', null, 'SIGKILL');

    const result = await promise;
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('TIMEOUT');
    // The fallback reaches the immediate child only — never a tree-kill success.
    expect(result.processTreeKilled).toBe(false);
    expect(child.killCount).toBe(1);
    expect(control.toolSpawns).toBe(1);
  });

  it('Race F — a non-zero tool exit with a descendant holding the pipes open ends in PROCESS_TREE_KILL_FAILED', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 60 });
    const tool = await firstTool();

    // taskkill failed and the immediate-child fallback did not produce a
    // `close`: modelled exactly as a surviving descendant holding the inherited
    // stdio handles open would.
    tool.emit('close', 1);

    const result = await promise;
    expect(result.failureCode).toBe('PROCESS_TREE_KILL_FAILED');
    expect(result.processTreeKilled).toBe(false);
    expect(child.killCount).toBe(1);
    expect(control.toolSpawns).toBe(1);
  });

  it('Race K — the immediate child exits while a descendant holds the inherited pipes: the bounded confirmation settles on the child’s own exit', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 60 });
    const tool = await firstTool();

    tool.emit('close', 0);

    // `exit` and `close` are different facts. `exit` is the immediate child's
    // own end; `close` additionally waits for *every* process still holding the
    // inherited stdio handles, which on Windows includes a descendant that a
    // snapshot-based `taskkill /T` pass created too late to see and then
    // orphaned. Measured on the installed runtime: such a descendant keeps the
    // pipes open indefinitely, so `close` never arrives at all.
    //
    // The immediate child is observably gone, so the termination this module
    // actually owns succeeded, and the original reason is what must be
    // reported. Reporting PROCESS_TREE_KILL_FAILED here would be a claim about
    // descendants that this module documents it never makes.
    child.emit('exit', null, 'SIGKILL');

    const result = await promise;
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('TIMEOUT');
    expect(result.signal).toBe('SIGKILL');
    expect(result.processTreeKilled).toBe(true);
    // No `close` ever arrived, and none is needed.
    expect(child.killCount).toBe(0);
  });

  it('Race L — an exit observed only after the grace window has expired does not rewrite the settled failure', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 60 });
    const tool = await firstTool();

    tool.emit('close', 0);

    // The exhausted-failure half of Race K: nothing at all was observed inside
    // the bound, so the deterministic PROCESS_TREE_KILL_FAILED stands.
    const result = await promise;
    expect(result.failureCode).toBe('PROCESS_TREE_KILL_FAILED');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();

    // And a late exit after the settlement is inert, exactly as a late close is.
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(promise).resolves.toBe(result);
  });

  it('Race G — a child error during the open attempt cancels the supervisor and settles once', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 30_000 });
    const tool = await firstTool();

    const error = new Error('spawn UNKNOWN') as NodeJS.ErrnoException;
    error.code = 'UNKNOWN';
    child.emit('error', error);

    const result = await promise;
    // The pre-existing child-error contract, unchanged.
    expect(result.started).toBe(false);
    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    expect(result.errnoCode).toBe('UNKNOWN');
    expect(result.processTreeKilled).toBe(false);

    // The abandoned taskkill process had exactly one best-effort kill requested
    // for it and its handle released — not a proof that it ended.
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);

    // Late events after the settlement change nothing.
    tool.emit('close', 0);
    child.emit('close', 0, null);
    await expect(promise).resolves.toBe(result);
  });

  it('Race I — a cancel whose tool kill has no effect still lets runCommand finalise, bounded', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 30_000 });
    const tool = await firstTool();

    // The tool refuses the kill and keeps running: the case the supervisor may
    // not wait on, because nothing will ever confirm a termination.
    tool.killReturnValue = false;

    const error = new Error('spawn UNKNOWN') as NodeJS.ErrnoException;
    error.code = 'UNKNOWN';
    child.emit('error', error);

    const cancelledAt = Date.now();
    const result = await promise;
    // Bounded: no third wait phase was entered for a confirmation that never came.
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);

    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    expect(result.processTreeKilled).toBe(false);

    // One request, one release — and the tool is still, honestly, alive.
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    expect(tool.alive).toBe(true);

    // Every late tool event is inert, including an `error` — the supervisor's
    // listener is still attached, so this cannot become an uncaught exception.
    tool.emit('error', new Error('AO_S2_RACE_I_LATE_SENTINEL'));
    tool.emit('exit', 1);
    tool.emit('close', 1);
    child.emit('close', null, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const again = await promise;
    expect(again).toBe(result);
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    expect(JSON.stringify(again)).not.toContain('AO_S2_RACE_I_LATE_SENTINEL');
  });

  it('Race J — a timeout whose tool kill has no effect ends in a bounded PROCESS_TREE_KILL_FAILED', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 60 });
    const tool = await firstTool();

    tool.killReturnValue = false;

    // The tool never reports ending, so only its own budget can end the wait.
    // `WINDOWS_TREE_KILL_TIMEOUT_MS` is 5s and `killGraceMs` 60ms: both stages
    // together, and nothing more.
    const result = await promise;

    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('PROCESS_TREE_KILL_FAILED');
    expect(result.processTreeKilled).toBe(false);
    // The tool budget was spent once, then one kill request and one release.
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    expect(tool.alive).toBe(true);
    // Exactly one tree-kill attempt and exactly one immediate-child fallback.
    expect(control.toolSpawns).toBe(1);
    expect(child.killCount).toBe(1);
  }, 20_000);

  it('Race H — a late close after settlement neither changes the result nor settles again', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 30_000 });
    const tool = await firstTool();

    tool.emit('close', 0);
    child.emit('close', 7, null);
    const result = await promise;
    expect(result.exitCode).toBe(7);

    child.emit('close', 99, null);
    child.emit('close', null, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const again = await promise;
    expect(again).toBe(result);
    expect(again.exitCode).toBe(7);
  });
});

describe.runIf(IS_WINDOWS)('runCommand does not block the event loop during the tree-kill attempt', () => {
  it('a parallel timer and microtask chain make progress while the attempt is open, which then resolves under control', async () => {
    const child = makeFakeChild();
    // A tool budget far longer than anything this test waits on: under the
    // synchronous predecessor the loop would have been frozen for all of it.
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 30_000 });
    const tool = await firstTool();

    // Causal, not merely "faster": the attempt is provably open right now.
    expect(control.toolSpawns).toBe(1);
    expect(await stateOf(promise)).toBe(PENDING);

    let timerRan = false;
    const timerFired = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerRan = true;
        resolve();
      }, 10);
    });

    let microtaskTicks = 0;
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
      microtaskTicks += 1;
    }

    // A second, entirely independent asynchronous path — timer-driven steps
    // interleaved with real file I/O. Every one of these stages requires the
    // event loop to turn; under the synchronous `execFileSync` predecessor the
    // loop was frozen for the whole tool budget and none of them could have
    // completed until the kill returned.
    let independentSteps = 0;
    for (let step = 0; step < 5; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await readFile(targetPath, 'utf8');
      independentSteps += 1;
    }

    await timerFired;

    expect(timerRan).toBe(true);
    expect(microtaskTicks).toBe(50);
    expect(independentSteps).toBe(5);
    // Still open: nothing above resolved it. The loop ran freely *because* the
    // attempt is asynchronous, not because it had already finished.
    expect(control.toolSpawns).toBe(1);
    expect(await stateOf(promise)).toBe(PENDING);

    tool.emit('close', 0);
    child.emit('close', null, 'SIGKILL');
    const result = await promise;
    expect(result.failureCode).toBe('TIMEOUT');
  });
});

describe.runIf(IS_WINDOWS)('runCommand leaks nothing from the tree-kill boundary', () => {
  it('no tool path, tool output or foreign error detail reaches the CommandResult', async () => {
    const child = makeFakeChild();
    const promise = startRun(child, { timeoutMs: 15, killGraceMs: 60 });
    const tool = await firstTool();

    const toolPath = control.spawnCalls.find((call) => /taskkill\.exe$/i.test(call.file))?.file;
    expect(toolPath).toBeDefined();

    const sentinelError = new Error('AO_S2_TOOL_ERROR_SENTINEL') as Error & { cause?: unknown };
    sentinelError.stack = 'AO_S2_TOOL_STACK_SENTINEL';
    sentinelError.cause = { secret: 'AO_S2_TOOL_CAUSE_SENTINEL' };
    (sentinelError as NodeJS.ErrnoException).errno = -4094;
    (sentinelError as NodeJS.ErrnoException).syscall = 'spawn';

    tool.emit('error', sentinelError);

    const result = await promise;
    const serialized = JSON.stringify(result);

    for (const forbidden of [
      toolPath as string,
      'taskkill',
      'AO_S2_TOOL_ERROR_SENTINEL',
      'AO_S2_TOOL_STACK_SENTINEL',
      'AO_S2_TOOL_CAUSE_SENTINEL',
      '-4094',
      'syscall',
      'stack',
      'cause',
      '31337', // the child PID handed to the tool
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    // `errnoCode` is a long-standing public field, so its *name* legitimately
    // appears. What must hold is that the tool's failure put no value in it,
    // and that no raw error surface was grafted onto the result.
    expect(result.errnoCode).toBeNull();
    const keys = Object.keys(result);
    for (const forbiddenKey of ['stack', 'cause', 'errno', 'syscall', 'path']) {
      expect(keys).not.toContain(forbiddenKey);
    }

    // The taskkill argument vector was fixed and shell-free.
    const toolCall = control.spawnCalls.find((call) => /taskkill\.exe$/i.test(call.file));
    expect(toolCall?.args).toEqual(['/PID', '31337', '/T', '/F']);
    expect(toolCall?.options).toEqual({ shell: false, windowsHide: true, stdio: 'ignore' });

    expect(result.failureCode).toBe('PROCESS_TREE_KILL_FAILED');
    expect(result.processTreeKilled).toBe(false);
  });
});
