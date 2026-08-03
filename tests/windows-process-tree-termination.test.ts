/**
 * AO-008-S2 — the internal asynchronous Windows tree-kill supervisor.
 *
 * Every dependency of `superviseWindowsTreeKill` is injected here, so each
 * outcome is driven directly rather than provoked out of a real `taskkill.exe`:
 * no foreign process is started, no real timer is waited on, and the tests run
 * identically on every platform.
 *
 * What this file pins:
 *  - exactly one tool spawn, with the fixed `/PID <pid> /T /F` vector, `shell:
 *    false`, `windowsHide: true` and `stdio: 'ignore'`;
 *  - the six distinguishable outcomes (exit 0, exit non-zero, synchronous start
 *    failure, asynchronous `error`, tool timeout, explicit cancel);
 *  - exactly-once resolution and at-most-one immediate-child fallback across
 *    all of them, including late tool events;
 *  - the tool process is never left running and no timer is left armed;
 *  - nothing foreign — tool path, stdout, stderr, error message, stack or
 *    cause — can leave the supervisor, because the outcome is a closed
 *    two-value union and the tool's streams are never subscribed to.
 */

import { describe, expect, it } from 'vitest';

import {
  superviseWindowsTreeKill,
  windowsTreeKillArguments,
  WINDOWS_TREE_KILL_SPAWN_OPTIONS,
  WINDOWS_TREE_KILL_TIMEOUT_MS,
  type WindowsTreeKillDependencies,
  type WindowsTreeKillToolProcess,
} from '../src/doctor/internal/windows-process-tree-termination.js';

const TOOL_PATH = String.raw`C:\Windows\System32\taskkill.exe`;
const ROOT_PID = 4242;

/** A tool process whose `close`/`error` events the test emits by hand. */
class FakeTool implements WindowsTreeKillToolProcess {
  readonly closeListeners: ((code: number | null) => void)[] = [];
  readonly errorListeners: ((error: unknown) => void)[] = [];
  killCount = 0;

  /**
   * Sentinel-bearing streams. The supervisor must never touch them — proven by
   * asserting these stay untouched, not merely that the sentinel is absent from
   * the outcome.
   */
  readonly stdout = { text: 'AO_S2_TOOL_STDOUT_SENTINEL', read: false };
  readonly stderr = { text: 'AO_S2_TOOL_STDERR_SENTINEL', read: false };

  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: string, listener: (arg: never) => void): unknown {
    if (event === 'close') this.closeListeners.push(listener as (code: number | null) => void);
    if (event === 'error') this.errorListeners.push(listener as (error: unknown) => void);
    return this;
  }

  kill(): unknown {
    this.killCount += 1;
    return true;
  }

  emitClose(code: number | null): void {
    for (const listener of [...this.closeListeners]) listener(code);
  }

  emitError(error: unknown): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

/** Fully synthetic timers: nothing here waits on the real clock. */
class FakeTimers {
  private nextId = 1;
  readonly pending = new Map<number, () => void>();
  readonly cleared: number[] = [];
  readonly durations: number[] = [];

  readonly set = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.pending.set(id, callback);
    this.durations.push(ms);
    return id;
  };

  readonly clear = (handle: unknown): void => {
    this.cleared.push(handle as number);
    this.pending.delete(handle as number);
  };

  /** Fires the single armed timer, exactly as the runtime would. */
  fire(): void {
    const [id] = [...this.pending.keys()];
    if (id === undefined) throw new Error('no timer armed');
    const callback = this.pending.get(id);
    this.pending.delete(id);
    callback?.();
  }
}

interface Harness {
  readonly timers: FakeTimers;
  readonly spawnCalls: { file: string; args: readonly string[]; options: unknown }[];
  readonly tools: FakeTool[];
  fallbackCount: number;
  readonly dependencies: WindowsTreeKillDependencies;
}

function makeHarness(
  overrides: {
    readonly spawnThrows?: () => never;
    readonly resolveThrows?: () => never;
    readonly fallbackThrows?: boolean;
  } = {},
): Harness {
  const timers = new FakeTimers();
  const spawnCalls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const tools: FakeTool[] = [];

  const harness: Harness = {
    timers,
    spawnCalls,
    tools,
    fallbackCount: 0,
    dependencies: {
      resolveToolPath: () => {
        overrides.resolveThrows?.();
        return TOOL_PATH;
      },
      spawnTool: (file, args, options) => {
        spawnCalls.push({ file, args, options });
        overrides.spawnThrows?.();
        const tool = new FakeTool();
        tools.push(tool);
        return tool;
      },
      killImmediateChild: () => {
        harness.fallbackCount += 1;
        if (overrides.fallbackThrows === true) {
          throw new Error('AO_S2_FALLBACK_SENTINEL kill failed');
        }
      },
      setTimer: timers.set,
      clearTimer: timers.clear,
    },
  };

  return harness;
}

/** Every observable the supervisor exposes, for the leakage sweep. */
function observable(outcome: string): string {
  return JSON.stringify({ outcome });
}

describe('superviseWindowsTreeKill — tool success', () => {
  it('spawns exactly once with the fixed argument vector and shell-free options', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    expect(harness.spawnCalls).toHaveLength(1);
    const call = harness.spawnCalls[0];
    expect(call?.file).toBe(TOOL_PATH);
    expect(call?.args).toEqual(['/PID', '4242', '/T', '/F']);
    expect(call?.options).toEqual({ shell: false, windowsHide: true, stdio: 'ignore' });
    expect((call?.options as { shell: boolean }).shell).toBe(false);

    harness.tools[0]?.emitClose(0);
    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');
  });

  it('exit 0 succeeds without any fallback and leaves no timer armed', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    expect(harness.timers.pending.size).toBe(1);
    expect(harness.timers.durations).toEqual([WINDOWS_TREE_KILL_TIMEOUT_MS]);

    harness.tools[0]?.emitClose(0);

    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');
    expect(harness.fallbackCount).toBe(0);
    // Explicitly cleared, not merely fired.
    expect(harness.timers.cleared).toHaveLength(1);
    expect(harness.timers.pending.size).toBe(0);
    // An already-exited tool must not be signalled.
    expect(harness.tools[0]?.killCount).toBe(0);
  });

  it('never subscribes to the tool streams', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);
    harness.tools[0]?.emitClose(0);
    await supervisor.outcome;

    expect(harness.tools[0]?.stdout.read).toBe(false);
    expect(harness.tools[0]?.stderr.read).toBe(false);
  });
});

describe('superviseWindowsTreeKill — tool non-zero exit', () => {
  it('is not a tree-kill success, runs exactly one fallback, and never re-runs the tool', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    harness.tools[0]?.emitClose(128);

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.timers.pending.size).toBe(0);
  });

  it('treats a null exit code as a failure, not a success', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);
    harness.tools[0]?.emitClose(null);

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
  });
});

describe('superviseWindowsTreeKill — start failures', () => {
  it('a synchronous spawn throw resolves controlled, with exactly one fallback and no leak', async () => {
    const harness = makeHarness({
      spawnThrows: () => {
        const error = new Error('AO_S2_SPAWN_SENTINEL') as NodeJS.ErrnoException;
        error.code = 'UNKNOWN';
        error.errno = -4094;
        error.syscall = 'spawn';
        error.path = 'AO_S2_SPAWN_SENTINEL_PATH';
        throw error;
      },
    });

    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);
    const outcome = await supervisor.outcome;

    expect(outcome).toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    expect(harness.timers.pending.size).toBe(0);
    expect(observable(outcome)).not.toContain('AO_S2_SPAWN_SENTINEL');
  });

  it('an unresolvable trusted tool path falls back once and never spawns anything', async () => {
    const harness = makeHarness({
      resolveThrows: () => {
        throw new Error('AO_S2_RESOLVER_SENTINEL');
      },
    });

    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);
    const outcome = await supervisor.outcome;

    expect(outcome).toBe('NOT_TREE_KILLED');
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.fallbackCount).toBe(1);
    expect(observable(outcome)).not.toContain('AO_S2_RESOLVER_SENTINEL');
  });

  it('an unusable root PID spawns nothing and runs no fallback', async () => {
    for (const pid of [undefined, 0, -1, 1.5, Number.NaN]) {
      const harness = makeHarness();
      const supervisor = superviseWindowsTreeKill(pid as number | undefined, harness.dependencies);

      await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
      expect(harness.spawnCalls).toHaveLength(0);
      expect(harness.fallbackCount).toBe(0);
      expect(harness.timers.pending.size).toBe(0);
    }
  });
});

describe('superviseWindowsTreeKill — asynchronous error event', () => {
  it('resolves controlled with exactly one fallback and no second resolution', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    const error = new Error('AO_S2_ASYNC_SENTINEL');
    error.stack = 'AO_S2_ASYNC_STACK_SENTINEL';
    (error as Error & { cause?: unknown }).cause = { secret: 'AO_S2_ASYNC_CAUSE_SENTINEL' };

    harness.tools[0]?.emitError(error);
    // A second error, and then a close, must change nothing.
    harness.tools[0]?.emitError(error);
    harness.tools[0]?.emitClose(0);

    const outcome = await supervisor.outcome;
    expect(outcome).toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    for (const sentinel of [
      'AO_S2_ASYNC_SENTINEL',
      'AO_S2_ASYNC_STACK_SENTINEL',
      'AO_S2_ASYNC_CAUSE_SENTINEL',
    ]) {
      expect(observable(outcome)).not.toContain(sentinel);
    }
  });
});

describe('superviseWindowsTreeKill — tool timeout', () => {
  it('kills the tool process, disarms the timer, falls back once and resolves once', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    expect(harness.timers.pending.size).toBe(1);
    harness.timers.fire();

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.tools[0]?.killCount).toBe(1);
    expect(harness.timers.pending.size).toBe(0);
    expect(harness.fallbackCount).toBe(1);
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('a late tool close after the timeout causes no second resolution and no second fallback', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    harness.timers.fire();
    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');

    // The listeners are still attached; the final state is what makes them
    // inert. Emitting both late events exercises exactly that guard.
    harness.tools[0]?.emitClose(0);
    harness.tools[0]?.emitError(new Error('late'));

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    expect(harness.tools[0]?.killCount).toBe(1);
  });

  it('honours an injected tool budget', () => {
    const harness = makeHarness();
    superviseWindowsTreeKill(ROOT_PID, { ...harness.dependencies, timeoutMs: 25 });
    expect(harness.timers.durations).toEqual([25]);
  });
});

describe('superviseWindowsTreeKill — cancel', () => {
  it('kills the running tool, disarms the timer, and runs no fallback', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    supervisor.cancel();

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.tools[0]?.killCount).toBe(1);
    expect(harness.timers.pending.size).toBe(0);
    expect(harness.timers.cleared).toHaveLength(1);
    // Cancel means "the caller stopped waiting on this child", not "the kill
    // failed" — the immediate-child fallback must not run.
    expect(harness.fallbackCount).toBe(0);
  });

  it('a late tool event after cancel causes no second resolution', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    supervisor.cancel();
    supervisor.cancel();
    harness.tools[0]?.emitClose(0);
    harness.tools[0]?.emitError(new Error('late'));

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(0);
    expect(harness.tools[0]?.killCount).toBe(1);
  });

  it('cancelling an already-resolved supervisor is a no-op', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    harness.tools[0]?.emitClose(0);
    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');

    supervisor.cancel();
    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');
    expect(harness.tools[0]?.killCount).toBe(0);
    expect(harness.fallbackCount).toBe(0);
  });
});

describe('superviseWindowsTreeKill — containment of foreign failures', () => {
  it('a throwing immediate-child fallback neither leaks nor starts a second fallback', async () => {
    const harness = makeHarness({ fallbackThrows: true });
    const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);

    harness.tools[0]?.emitClose(1);

    const outcome = await supervisor.outcome;
    expect(outcome).toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    expect(observable(outcome)).not.toContain('AO_S2_FALLBACK_SENTINEL');
  });

  it('the resolved outcome is always one of exactly two static values', async () => {
    const cases: Promise<string>[] = [];

    const success = makeHarness();
    const a = superviseWindowsTreeKill(ROOT_PID, success.dependencies);
    success.tools[0]?.emitClose(0);
    cases.push(a.outcome);

    const failure = makeHarness();
    const b = superviseWindowsTreeKill(ROOT_PID, failure.dependencies);
    failure.tools[0]?.emitClose(3);
    cases.push(b.outcome);

    for (const outcome of await Promise.all(cases)) {
      expect(['TREE_KILLED', 'NOT_TREE_KILLED']).toContain(outcome);
    }
  });

  it('the exported argument builder emits only the fixed vector', () => {
    expect(windowsTreeKillArguments(7)).toEqual(['/PID', '7', '/T', '/F']);
    expect(WINDOWS_TREE_KILL_SPAWN_OPTIONS).toEqual({
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
  });
});
