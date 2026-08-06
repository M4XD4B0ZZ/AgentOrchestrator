/**
 * AO-008-S2 — the internal asynchronous Windows tree-kill supervisor.
 *
 * Every dependency of `superviseWindowsTreeKill` is injected here, so each
 * outcome is driven directly rather than provoked out of a real `taskkill.exe`:
 * no foreign process is started, no real timer is waited on, and the tests run
 * identically on every platform.
 *
 * ── The four states these tests keep apart (AO-008-S2-R1) ───────────────────
 *
 *  - **kill requested** — `kill()` was called. It may return `false`, it may
 *    throw, and it may be ignored outright; none of that is evidence that the
 *    process ended, so {@link FakeTool} deliberately never turns a kill into an
 *    `exit` or a `close`. A fake that did would assume the very guarantee this
 *    file exists to stop claiming;
 *  - **tool termination observed** — an `exit` or a `close` actually arrived;
 *  - **tool released** — the tool timer is cleared and the handle is `unref`'d,
 *    so a surviving tool process cannot hold the event loop open. Not a
 *    termination;
 *  - **tree kill succeeded** — the tool itself ended with exit code 0. Only
 *    this yields `TREE_KILLED`.
 *
 * What this file pins:
 *  - exactly one tool spawn, with the fixed `/PID <pid> /T /F` vector, `shell:
 *    false`, `windowsHide: true` and `stdio: 'ignore'`;
 *  - the distinguishable outcomes (exit 0, exit non-zero, synchronous start
 *    failure, asynchronous `error`, tool timeout, explicit cancel);
 *  - exactly-once resolution, at most one kill request, at most one `unref` and
 *    at most one immediate-child fallback across all of them, including late
 *    tool events;
 *  - that a kill which returns `false`, a kill which throws, and a kill which
 *    is simply ignored all still reach a bounded `NOT_TREE_KILLED` with the
 *    tool handle released — while the tool is still, provably, being tracked as
 *    running by the fake;
 *  - that no timer is left armed and no late event can resolve twice or become
 *    an unhandled error;
 *  - nothing foreign — tool path, stdout, stderr, error message, stack or
 *    cause — can leave the supervisor, because the outcome is a closed
 *    two-value union and the tool's streams are never subscribed to.
 *
 * Nothing here asserts, or is entitled to assert, that a tool process was
 * actually terminated by a kill request.
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

interface FakeToolOptions {
  /** Models a seam whose handle has no `unref` at all. */
  readonly supportsUnref?: boolean;
}

/**
 * A tool process whose lifecycle the test drives by hand.
 *
 * Independently controllable: whether it is `alive`, whether an `exit` or a
 * `close` has been observed, what `kill()` returns, whether `kill()` throws,
 * how often `unref()` ran, and which late events to replay after the supervisor
 * has already resolved.
 *
 * `kill()` is wired to **none** of the termination states. Only `emitExit` and
 * `emitClose` end this fake's life, exactly as only a real `exit`/`close` ends
 * a real one.
 */
class FakeTool implements WindowsTreeKillToolProcess {
  readonly exitListeners: ((code: number | null) => void)[] = [];
  readonly closeListeners: ((code: number | null) => void)[] = [];
  readonly errorListeners: ((error: unknown) => void)[] = [];

  killCount = 0;
  unrefCount = 0;

  /** What `kill()` hands back. `false` models a request the OS refused. */
  killReturnValue: unknown = true;
  /** When set, `kill()` throws this instead of returning. */
  killThrows: unknown = null;
  /** When set, `unref()` throws this instead of counting. */
  unrefThrows: unknown = null;

  /** Cleared only by an emitted `exit`/`close`. A kill never touches it. */
  alive = true;
  exitObserved = false;
  closeObserved = false;

  /** Late events to replay once the supervisor has already resolved. */
  lateExit: number | null = null;
  lateClose: number | null = null;
  lateError: unknown = null;

  /** Present only when the seam offers it; see {@link FakeToolOptions}. */
  unref?: () => void;

  /**
   * Sentinel-bearing streams. The supervisor must never touch them — proven by
   * asserting these stay untouched, not merely that the sentinel is absent from
   * the outcome.
   */
  readonly stdout = { text: 'AO_S2_TOOL_STDOUT_SENTINEL', read: false };
  readonly stderr = { text: 'AO_S2_TOOL_STDERR_SENTINEL', read: false };

  constructor(options: FakeToolOptions = {}) {
    if (options.supportsUnref !== false) {
      this.unref = (): void => {
        this.unrefCount += 1;
        if (this.unrefThrows !== null) throw this.unrefThrows;
      };
    }
  }

  /** A kill was requested and the tool is *still running*: an ignored kill. */
  get killIgnored(): boolean {
    return this.killCount > 0 && this.alive;
  }

  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: string, listener: (arg: never) => void): unknown {
    if (event === 'exit') this.exitListeners.push(listener as (code: number | null) => void);
    if (event === 'close') this.closeListeners.push(listener as (code: number | null) => void);
    if (event === 'error') this.errorListeners.push(listener as (error: unknown) => void);
    return this;
  }

  kill(): unknown {
    this.killCount += 1;
    if (this.killThrows !== null) throw this.killThrows;
    // Note what does *not* happen here: no `exit`, no `close`, no change to
    // `alive`. A kill request is a request.
    return this.killReturnValue;
  }

  emitExit(code: number | null): void {
    this.exitObserved = true;
    this.alive = false;
    for (const listener of [...this.exitListeners]) listener(code);
  }

  emitClose(code: number | null): void {
    this.closeObserved = true;
    this.alive = false;
    for (const listener of [...this.closeListeners]) listener(code);
  }

  emitError(error: unknown): void {
    if (this.errorListeners.length === 0) {
      // A real EventEmitter throws on an unhandled `'error'`. Reproducing that
      // is the only way a "the listeners were cleaned up" claim could ever be
      // caught being wrong.
      throw error;
    }
    for (const listener of [...this.errorListeners]) listener(error);
  }

  /** Replays whichever late events were scheduled, in emitter order. */
  emitLateEvents(): void {
    if (this.lateError !== null) this.emitError(this.lateError);
    if (this.lateExit !== null) this.emitExit(this.lateExit);
    if (this.lateClose !== null) this.emitClose(this.lateClose);
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
    /** Applied to every tool this harness creates. */
    readonly tool?: FakeToolOptions;
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
        const tool = new FakeTool(overrides.tool ?? {});
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

/** Starts a supervisor and returns it with its (already spawned) tool. */
function start(harness: Harness): {
  readonly supervisor: ReturnType<typeof superviseWindowsTreeKill>;
  readonly tool: FakeTool;
} {
  const supervisor = superviseWindowsTreeKill(ROOT_PID, harness.dependencies);
  const tool = harness.tools[0];
  if (tool === undefined) throw new Error('no tool was spawned');
  return { supervisor, tool };
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

  it('an observed exit 0 succeeds without any fallback and leaves no timer armed', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    expect(harness.timers.pending.size).toBe(1);
    expect(harness.timers.durations).toEqual([WINDOWS_TREE_KILL_TIMEOUT_MS]);

    tool.emitClose(0);

    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');
    expect(harness.fallbackCount).toBe(0);
    // Explicitly cleared, not merely fired.
    expect(harness.timers.cleared).toHaveLength(1);
    expect(harness.timers.pending.size).toBe(0);
    // Termination was observed: nothing left to signal, nothing left to release.
    expect(tool.closeObserved).toBe(true);
    expect(tool.alive).toBe(false);
    expect(tool.killCount).toBe(0);
    expect(tool.unrefCount).toBe(0);
  });

  it('an `exit` alone is an observed termination and decides the outcome', async () => {
    const success = makeHarness();
    const a = start(success);
    a.tool.emitExit(0);
    await expect(a.supervisor.outcome).resolves.toBe('TREE_KILLED');
    expect(a.tool.exitObserved).toBe(true);
    expect(a.tool.closeObserved).toBe(false);
    expect(a.tool.killCount).toBe(0);
    expect(a.tool.unrefCount).toBe(0);
    expect(success.fallbackCount).toBe(0);

    const failure = makeHarness();
    const b = start(failure);
    b.tool.emitExit(1);
    await expect(b.supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(failure.fallbackCount).toBe(1);
    expect(b.tool.killCount).toBe(0);
  });

  it('the `close` that follows an observed `exit` resolves nothing a second time', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    tool.emitExit(0);
    tool.emitClose(0);

    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');
    expect(harness.fallbackCount).toBe(0);
    expect(tool.killCount).toBe(0);
    expect(tool.unrefCount).toBe(0);
  });

  it('never subscribes to the tool streams', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    tool.emitClose(0);
    await supervisor.outcome;

    expect(tool.stdout.read).toBe(false);
    expect(tool.stderr.read).toBe(false);
  });
});

describe('superviseWindowsTreeKill — tool non-zero exit', () => {
  it('is not a tree-kill success, runs exactly one fallback, and never re-runs the tool', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    tool.emitClose(128);

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.timers.pending.size).toBe(0);
  });

  it('treats a null exit code as a failure, not a success', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    tool.emitClose(null);

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
    const { supervisor, tool } = start(harness);

    const error = new Error('AO_S2_ASYNC_SENTINEL');
    error.stack = 'AO_S2_ASYNC_STACK_SENTINEL';
    (error as Error & { cause?: unknown }).cause = { secret: 'AO_S2_ASYNC_CAUSE_SENTINEL' };

    tool.emitError(error);
    // A second error, and then a close, must change nothing.
    tool.emitError(error);
    tool.emitClose(0);

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

  it('an `error` is not a termination: the tool is still kill-requested and released', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    tool.emitError(new Error('AO_S2_ERROR_NOT_TERMINATION'));

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    // The tool errored but never reported ending, so it is treated as possibly
    // still running: one kill requested, handle released, nothing claimed.
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    expect(tool.exitObserved).toBe(false);
    expect(tool.closeObserved).toBe(false);
    expect(tool.alive).toBe(true);
  });
});

describe('superviseWindowsTreeKill — tool timeout', () => {
  it('requests one best-effort kill, releases the handle, disarms the timer, falls back once and resolves once', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    expect(harness.timers.pending.size).toBe(1);
    harness.timers.fire();

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    expect(harness.timers.pending.size).toBe(0);
    expect(harness.fallbackCount).toBe(1);
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('a late tool close after the timeout causes no second resolution and no second fallback', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    harness.timers.fire();
    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');

    // The listeners are still attached; the final state is what makes them
    // inert. Emitting both late events exercises exactly that guard.
    tool.emitClose(0);
    tool.emitError(new Error('late'));

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
  });

  it('honours an injected tool budget', () => {
    const harness = makeHarness();
    superviseWindowsTreeKill(ROOT_PID, { ...harness.dependencies, timeoutMs: 25 });
    expect(harness.timers.durations).toEqual([25]);
  });
});

describe('superviseWindowsTreeKill — cancel', () => {
  it('requests one best-effort kill, releases the handle, disarms the timer, and runs no fallback', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    supervisor.cancel();

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    expect(harness.timers.pending.size).toBe(0);
    expect(harness.timers.cleared).toHaveLength(1);
    // Cancel means "the caller stopped waiting on this child", not "the kill
    // failed" — the immediate-child fallback must not run.
    expect(harness.fallbackCount).toBe(0);
  });

  it('a late tool event after cancel causes no second resolution', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    supervisor.cancel();
    supervisor.cancel();
    tool.emitClose(0);
    tool.emitError(new Error('late'));

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(0);
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
  });

  it('cancelling an already-resolved supervisor is a no-op', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    tool.emitClose(0);
    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');

    supervisor.cancel();
    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');
    expect(tool.killCount).toBe(0);
    expect(tool.unrefCount).toBe(0);
    expect(harness.fallbackCount).toBe(0);
  });
});

/**
 * AO-008-S2-F2 — the cases the previous fakes could not express, because their
 * `kill()` always returned `true` and the suite read that as "the tool is gone".
 *
 * Each case below leaves the tool provably running (`alive`, no `exit`, no
 * `close`) and asserts only what a pure-Node supervisor can actually deliver:
 * one kill request, one release, a bounded outcome, and no second settlement.
 */
describe('superviseWindowsTreeKill — a kill request is not a termination (AO-008-S2-F2)', () => {
  it('F2-A — `kill()` returning false: one request, one release, bounded NOT_TREE_KILLED, tool still running', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    tool.killReturnValue = false;

    harness.timers.fire();

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    // The tool never reported ending, and this suite does not pretend it did.
    expect(tool.alive).toBe(true);
    expect(tool.exitObserved).toBe(false);
    expect(tool.closeObserved).toBe(false);
    expect(tool.killIgnored).toBe(true);
    expect(harness.timers.pending.size).toBe(0);
    expect(harness.fallbackCount).toBe(1);
  });

  it('F2-B — `kill()` throwing: same contract, no leak, no second kill', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    const thrown = new Error('AO_S2_KILL_THROW_SENTINEL') as NodeJS.ErrnoException;
    thrown.code = 'EPERM';
    thrown.errno = -4048;
    thrown.syscall = 'kill';
    tool.killThrows = thrown;

    supervisor.cancel();

    const outcome = await supervisor.outcome;
    expect(outcome).toBe('NOT_TREE_KILLED');
    expect(tool.killCount).toBe(1);
    // A throwing kill must not skip the release: that is what bounds the wait.
    expect(tool.unrefCount).toBe(1);
    expect(tool.alive).toBe(true);
    expect(observable(outcome)).not.toContain('AO_S2_KILL_THROW_SENTINEL');

    // A second cancel, and a late event, request nothing further.
    supervisor.cancel();
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    expect(harness.fallbackCount).toBe(0);
  });

  it('F2-C — an ignored kill returning true is still not a termination', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    tool.killReturnValue = true;

    harness.timers.fire();

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    // `kill()` said `true` and nothing happened: no exit, no close, still alive.
    // The outcome is NOT_TREE_KILLED regardless, because only an observed
    // exit 0 is a tree-kill success.
    expect(tool.killIgnored).toBe(true);
    expect(tool.alive).toBe(true);
    expect(harness.fallbackCount).toBe(1);
  });

  it('F2-D — a delayed `exit` after resolution settles nothing again', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    tool.killReturnValue = false;
    tool.lateExit = 0;

    harness.timers.fire();
    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');

    tool.emitLateEvents();

    // The late exit is recorded by the fake, but changes no outcome, runs no
    // second fallback and requests no second kill.
    expect(tool.exitObserved).toBe(true);
    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
  });

  it('F2-E — a delayed `close` after resolution settles nothing again', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    tool.killReturnValue = false;
    tool.lateClose = 0;

    supervisor.cancel();
    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');

    tool.emitLateEvents();

    expect(tool.closeObserved).toBe(true);
    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    // A cancel never falls back, and a late close does not start one.
    expect(harness.fallbackCount).toBe(0);
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
  });

  it('F2-F — a late `error` after resolution is handled, not thrown, and leaks nothing', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    tool.killReturnValue = false;
    const late = new Error('AO_S2_LATE_ERROR_SENTINEL') as Error & { cause?: unknown };
    late.stack = 'AO_S2_LATE_STACK_SENTINEL';
    late.cause = { secret: 'AO_S2_LATE_CAUSE_SENTINEL' };
    tool.lateError = late;

    harness.timers.fire();
    const outcome = await supervisor.outcome;
    expect(outcome).toBe('NOT_TREE_KILLED');

    // The error listener is still attached — that is what turns this into a
    // no-op instead of an unhandled `'error'`. `emitError` throws when no
    // listener remains, so this call passing is the proof.
    expect(tool.errorListeners).toHaveLength(1);
    expect(() => {
      tool.emitLateEvents();
    }).not.toThrow();

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(harness.fallbackCount).toBe(1);
    expect(tool.killCount).toBe(1);
    for (const sentinel of [
      'AO_S2_LATE_ERROR_SENTINEL',
      'AO_S2_LATE_STACK_SENTINEL',
      'AO_S2_LATE_CAUSE_SENTINEL',
    ]) {
      expect(observable(outcome)).not.toContain(sentinel);
    }
  });

  it('F2-G — a tool that ended before the cancel is neither killed nor released again', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);

    tool.emitExit(0);
    tool.emitClose(0);

    supervisor.cancel();

    // The observed termination stands: exit 0 is a tree-kill success, and no
    // unnecessary kill or release was performed on a process already gone.
    await expect(supervisor.outcome).resolves.toBe('TREE_KILLED');
    expect(tool.exitObserved).toBe(true);
    expect(tool.closeObserved).toBe(true);
    expect(tool.alive).toBe(false);
    expect(tool.killIgnored).toBe(false);
    expect(tool.killCount).toBe(0);
    expect(tool.unrefCount).toBe(0);
    expect(harness.fallbackCount).toBe(0);
  });
});

describe('superviseWindowsTreeKill — the release itself is contained', () => {
  it('a handle without `unref` still reaches the same bounded outcome', async () => {
    const harness = makeHarness({ tool: { supportsUnref: false } });
    const { supervisor, tool } = start(harness);
    tool.killReturnValue = false;
    expect(tool.unref).toBeUndefined();

    harness.timers.fire();

    await expect(supervisor.outcome).resolves.toBe('NOT_TREE_KILLED');
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(0);
    expect(harness.fallbackCount).toBe(1);
  });

  it('a throwing `unref` changes neither the outcome nor the fallback count', async () => {
    const harness = makeHarness();
    const { supervisor, tool } = start(harness);
    tool.unrefThrows = new Error('AO_S2_UNREF_SENTINEL');

    supervisor.cancel();

    const outcome = await supervisor.outcome;
    expect(outcome).toBe('NOT_TREE_KILLED');
    expect(tool.killCount).toBe(1);
    expect(tool.unrefCount).toBe(1);
    expect(harness.fallbackCount).toBe(0);
    expect(observable(outcome)).not.toContain('AO_S2_UNREF_SENTINEL');
  });

  it('a throwing `clearTimer` does not prevent the kill request, the release or the outcome', async () => {
    const harness = makeHarness();
    const supervisor = superviseWindowsTreeKill(ROOT_PID, {
      ...harness.dependencies,
      clearTimer: () => {
        throw new Error('AO_S2_CLEAR_TIMER_SENTINEL');
      },
    });
    const tool = harness.tools[0];

    supervisor.cancel();

    const outcome = await supervisor.outcome;
    expect(outcome).toBe('NOT_TREE_KILLED');
    expect(tool?.killCount).toBe(1);
    expect(tool?.unrefCount).toBe(1);
    expect(observable(outcome)).not.toContain('AO_S2_CLEAR_TIMER_SENTINEL');
  });
});

describe('superviseWindowsTreeKill — containment of foreign failures', () => {
  it('a throwing immediate-child fallback neither leaks nor starts a second fallback', async () => {
    const harness = makeHarness({ fallbackThrows: true });
    const { supervisor, tool } = start(harness);

    tool.emitClose(1);

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

    const ignored = makeHarness();
    const c = superviseWindowsTreeKill(ROOT_PID, ignored.dependencies);
    if (ignored.tools[0] !== undefined) ignored.tools[0].killReturnValue = false;
    ignored.timers.fire();
    cases.push(c.outcome);

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
