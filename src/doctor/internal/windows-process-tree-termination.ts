/**
 * AO-008-S2 — the asynchronous Windows process-tree termination boundary.
 *
 * `runCommand` used to walk a timed-out child's process tree with a
 * *synchronous* `execFileSync(taskkill.exe, …)` call. That call blocks the
 * whole Node event loop for as long as `taskkill.exe` runs — up to its entire
 * internal budget when the tool hangs — so no timer, no microtask and no other
 * in-flight diagnostic could make progress while one probe was being killed.
 * This module replaces that with a supervised, non-blocking `spawn`.
 *
 * What deliberately did **not** change:
 *
 *  - the tool is still the trusted, environment-independent `taskkill.exe`
 *    resolved by `windows-system-tools.ts` — never a `PATH`, `COMSPEC`,
 *    `SystemRoot` or `windir` lookup, and never a shell string;
 *  - the argument list is still exactly `/PID <pid> /T /F`;
 *  - the root PID is still only ever the immediate child `runCommand` itself
 *    started;
 *  - no process tree is enumerated — there is no `tasklist`, WMI, WMIC or
 *    PowerShell anywhere in this path;
 *  - the two-stage budget (tool attempt, then the caller's grace window) is
 *    unchanged in length and order.
 *
 * The supervisor resolves **exactly once**, to a closed two-value outcome. It
 * never throws, and nothing foreign ever leaves it: not the tool's stdout or
 * stderr (never even piped), not its exit code, not its PID, and not the
 * message, `errno`, `syscall`, `stack` or `cause` of any error raised while
 * starting or running it. A caller therefore cannot accidentally forward tool
 * detail into a `CommandResult` or a domain error, because it is never given
 * any.
 *
 * ── What "the tool process is dealt with" does and does not mean ────────────
 *
 * This module is a pure-Node supervisor over a foreign process it does not own
 * at the kernel level. Four states are therefore kept strictly apart, in the
 * code and in the tests (AO-008-S2-R1):
 *
 *  - **kill requested** — `kill()` was called on the tool handle, exactly once.
 *    Neither a truthy return value nor the absence of a throw is evidence that
 *    the process ended: the signal may be refused by policy, the handle may
 *    already be stale, or the process may simply ignore it;
 *  - **tool termination observed** — an `exit` or a `close` event actually
 *    arrived. This, and only this, is evidence the tool process ended;
 *  - **tool released** — the supervisor no longer holds an active event-loop
 *    reference to the tool: its timer is cleared and the handle is `unref`'d,
 *    so a still-running tool cannot keep the Node process alive and cannot
 *    delay any caller. A release is *not* a termination;
 *  - **tree kill succeeded** — `taskkill` itself terminated with exit code 0.
 *    Only this produces `TREE_KILLED`, and hence `processTreeKilled: true`.
 *
 * Consequently: on timeout and on `cancel()` the supervisor requests exactly
 * one best-effort kill and then releases the handle, bounded, whether or not a
 * termination is ever observed. Under an OS or policy failure the `taskkill`
 * process **may outlive** the settlement of the result it was started for.
 * Nothing here — no comment, no test, no field — claims otherwise. Hard
 * ownership of the tool and of the target tree needs a Windows Job Object,
 * which is a separate architectural task and deliberately not in this module.
 *
 * This module is internal. It is not re-exported from the package entry point,
 * it produces no result and no report data, and its only productive consumer is
 * `src/doctor/exec.ts`.
 */

/**
 * The budget for one `taskkill.exe` run, extracted verbatim from the
 * `execFileSync({ timeout: 5_000 })` this module replaces. Stage 1 of the
 * two-stage termination deadline; stage 2 is the caller's `killGraceMs`.
 */
export const WINDOWS_TREE_KILL_TIMEOUT_MS = 5_000;

/**
 * The outcome of one tree-kill attempt. `TREE_KILLED` carries exactly the
 * narrow meaning `processTreeKilled` has always had — *the best-effort
 * process-tree mechanism reported success* — and specifically not kernel
 * ownership of the tree, a verified absence of descendants, or an enumerated
 * empty tree.
 */
export type WindowsTreeKillOutcome = 'TREE_KILLED' | 'NOT_TREE_KILLED';

/**
 * The fixed spawn options. `shell: false` and a literal argument vector mean
 * there is no command line for anything to be injected into; `stdio: 'ignore'`
 * means the tool's output is never even read, let alone buffered or carried
 * outward.
 */
export const WINDOWS_TREE_KILL_SPAWN_OPTIONS = Object.freeze({
  shell: false,
  windowsHide: true,
  stdio: 'ignore',
} as const);

export type WindowsTreeKillSpawnOptions = typeof WINDOWS_TREE_KILL_SPAWN_OPTIONS;

/** The fixed argument vector: `/PID <pid> /T /F`, and nothing else, ever. */
export function windowsTreeKillArguments(pid: number): readonly string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

/**
 * The only PIDs this module will stringify into an argument: a positive safe
 * integer. Mirrors the guard the synchronous predecessor applied.
 */
function isUsableRootPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0;
}

/**
 * The slice of a spawned tool process this supervisor uses. Deliberately
 * minimal: no `stdout`, no `stderr`, no `pid` — what is not named here cannot
 * be read, so it cannot leak.
 *
 * `exit` and `close` are subscribed separately and *both* count as an observed
 * termination: `exit` marks the process actually ending, `close` may follow it,
 * and with `stdio: 'ignore'` there is no pipe that could hold `close` back. The
 * first of the two to arrive decides the outcome; the other is inert.
 *
 * `unref` is optional because a seam may omit it; on a real `ChildProcess` it
 * is what detaches the handle from the event loop. Calling it releases the
 * handle — it does not terminate anything and is never treated as evidence
 * that it did.
 */
export interface WindowsTreeKillToolProcess {
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  kill(): unknown;
  unref?(): unknown;
}

export type WindowsTreeKillSpawn = (
  file: string,
  args: readonly string[],
  options: WindowsTreeKillSpawnOptions,
) => WindowsTreeKillToolProcess;

/** An opaque timer handle. The supervisor only ever hands it back to `clearTimer`. */
export type WindowsTreeKillTimer = unknown;

/**
 * The closed dependency set. Every seam here exists so the supervisor's
 * outcomes can be driven deterministically in a unit test, without a real
 * foreign process and without widening any public API.
 */
export interface WindowsTreeKillDependencies {
  /** The trusted, validated `taskkill.exe` path. May throw; a throw is a start failure. */
  readonly resolveToolPath: () => string;
  readonly spawnTool: WindowsTreeKillSpawn;
  /**
   * The one immediate-child fallback (`child.kill('SIGKILL')`). Invoked at most
   * once per supervisor, and only when the tool attempt did not succeed.
   */
  readonly killImmediateChild: () => void;
  readonly setTimer: (callback: () => void, ms: number) => WindowsTreeKillTimer;
  readonly clearTimer: (timer: WindowsTreeKillTimer) => void;
  /** Overrides {@link WINDOWS_TREE_KILL_TIMEOUT_MS}; tests only. */
  readonly timeoutMs?: number;
}

export interface WindowsTreeKillSupervisor {
  /** Resolves exactly once. Never rejects. */
  readonly outcome: Promise<WindowsTreeKillOutcome>;
  /**
   * Abandons the attempt: requests one best-effort kill of a tool process whose
   * termination has not been observed, clears the tool timer, and releases the
   * tool handle from the event loop. Used when the caller settled on an
   * independent path (a child `error`, say) while the attempt was still open.
   *
   * Bounded and unconditional: it never waits for a confirmation that may never
   * come. A tool process that ignores or refuses the kill can outlive this
   * call — what is guaranteed is only that the supervisor stops waiting on it
   * and stops holding the event loop open for it.
   *
   * Does **not** run the immediate-child fallback — the caller is no longer
   * waiting on this child at all.
   */
  cancel(): void;
}

/**
 * Starts one supervised `taskkill /PID <pid> /T /F` and returns a handle to it.
 *
 * Distinguishes, and collapses into the two-value outcome:
 *
 *  - tool exit 0 (observed)     → `TREE_KILLED`, no fallback;
 *  - tool exit non-zero         → `NOT_TREE_KILLED`, one fallback;
 *  - synchronous start failure  → `NOT_TREE_KILLED`, one fallback;
 *  - asynchronous `error` event → `NOT_TREE_KILLED`, one kill requested, one
 *    fallback (an `error` is not a termination — a later `exit`/`close` may
 *    still follow it);
 *  - tool timeout               → `NOT_TREE_KILLED`, one kill requested, tool
 *    handle released, one fallback;
 *  - {@link WindowsTreeKillSupervisor.cancel} → `NOT_TREE_KILLED`, one kill
 *    requested, tool handle released, **no** fallback;
 *  - unusable root PID          → `NOT_TREE_KILLED`, nothing spawned, nothing
 *    killed, no fallback (exactly what the synchronous predecessor did).
 *
 * Exactly one tool process is started, at most one kill is requested for it, at
 * most one `unref` is performed, at most one fallback is run, and every event
 * arriving after the resolution — a late tool `exit`, `close` or `error`, a
 * late `cancel()` — is a no-op that cannot resolve the outcome a second time
 * and cannot surface as an unhandled error.
 *
 * Where no termination is observed, the outcome is still reached in bounded
 * time and the tool process is left released rather than proven gone. See the
 * four-state vocabulary in this module's header comment.
 */
export function superviseWindowsTreeKill(
  rootPid: number | undefined,
  dependencies: WindowsTreeKillDependencies,
): WindowsTreeKillSupervisor {
  let resolveOutcome!: (outcome: WindowsTreeKillOutcome) => void;
  const outcome = new Promise<WindowsTreeKillOutcome>((resolvePromise) => {
    resolveOutcome = resolvePromise;
  });

  let resolved = false;
  let fallbackRun = false;
  let timer: WindowsTreeKillTimer | undefined;
  let tool: WindowsTreeKillToolProcess | null = null;
  /** Tool termination **observed**: an `exit` or a `close` actually arrived. */
  let toolTerminationObserved = false;
  /** Kill **requested**: `kill()` was called once. Not a termination. */
  let killRequested = false;
  /** Tool **released**: `unref()` was performed once. Not a termination either. */
  let toolReleased = false;

  /**
   * The one best-effort kill request, plus the handle release that makes the
   * supervisor's bound real.
   *
   * Deliberately *not* conditional on the kill working: `kill()` may return a
   * falsy value, may throw, and may be silently ignored by the target, and none
   * of those three is distinguishable from success without an `exit`/`close`
   * that may never come. So the request is made at most once, its result is
   * discarded, and the handle is then detached from the event loop so a tool
   * process that survives cannot hold this process open or delay any caller.
   *
   * A tool whose termination has already been observed is neither signalled nor
   * released: there is nothing left to signal, and nothing left to hold.
   */
  const releaseTool = (): void => {
    const running = tool;
    if (running === null || toolTerminationObserved) return;

    if (!killRequested) {
      killRequested = true;
      try {
        running.kill();
      } catch {
        /* best effort; a throw is no more a failure signal than `false` is */
      }
    }

    if (!toolReleased) {
      toolReleased = true;
      try {
        running.unref?.();
      } catch {
        /* a seam whose `unref` throws must not change the outcome */
      }
    }
  };

  /**
   * The single resolution point. Every guard the exactly-once contract needs
   * lives here, so no call site can bypass one.
   */
  const finish = (result: WindowsTreeKillOutcome, runFallback: boolean): void => {
    if (resolved) return;
    resolved = true;

    if (timer !== undefined) {
      // A foreign `clearTimer` must not be able to break the resolution.
      try {
        dependencies.clearTimer(timer);
      } catch {
        /* nothing to report: the outcome is already decided */
      }
      timer = undefined;
    }

    releaseTool();

    if (runFallback && !fallbackRun) {
      fallbackRun = true;
      try {
        dependencies.killImmediateChild();
      } catch {
        // A failing `child.kill` is not a second failure mode: it must not
        // leak, must not start another fallback, and must not change the
        // outcome. The caller's grace window still bounds the wait.
      }
    }

    resolveOutcome(result);
  };

  const supervisor: WindowsTreeKillSupervisor = {
    outcome,
    cancel: () => finish('NOT_TREE_KILLED', false),
  };

  // An unusable PID is not a tool failure: nothing is started, so nothing is
  // killed either. This is the synchronous predecessor's behaviour exactly.
  if (!isUsableRootPid(rootPid)) {
    finish('NOT_TREE_KILLED', false);
    return supervisor;
  }

  let toolPath: string;
  try {
    toolPath = dependencies.resolveToolPath();
  } catch {
    // The trusted `taskkill.exe` boundary could not be established. Never fall
    // back to an environment- or PATH-supplied taskkill — fall back to the
    // immediate child only.
    finish('NOT_TREE_KILLED', true);
    return supervisor;
  }

  try {
    tool = dependencies.spawnTool(
      toolPath,
      windowsTreeKillArguments(rootPid),
      WINDOWS_TREE_KILL_SPAWN_OPTIONS,
    );

    // Armed *before* any listener is attached. A tool process that closes or
    // errors synchronously would otherwise resolve the supervisor first and
    // leave this timer behind, unowned and unclearable.
    timer = dependencies.setTimer(() => {
      // Consumed: `finish` must not clear an already-fired timer, but it must
      // still request the one best-effort kill for, and release, the tool
      // process this timeout is abandoning.
      timer = undefined;
      finish('NOT_TREE_KILLED', true);
    }, dependencies.timeoutMs ?? WINDOWS_TREE_KILL_TIMEOUT_MS);

    // Attached for the whole lifetime of the tool handle and never removed.
    // A tool process that survives a kill request can still emit `error`,
    // `exit` or `close` long after this supervisor resolved; leaving the
    // listeners in place — inert behind the `resolved` guard — is what keeps a
    // late `error` from becoming an unhandled `'error'` event, which on a real
    // `EventEmitter` would throw. Removing them would trade a controlled no-op
    // for an uncaught exception.
    tool.on('error', () => {
      // An `error` says the tool failed, not that it ended: a process that
      // errored may still be running, and may still emit `exit`/`close` later.
      // So this deliberately does not count as an observed termination.
      finish('NOT_TREE_KILLED', true);
    });

    // `exit` marks the actual end of the process; `close` may follow it (and,
    // with `stdio: 'ignore'`, arrives with nothing buffered in between). Either
    // one is an observed termination, so it is recorded *before* resolving: a
    // tool that has already ended must not then be signalled or unref'd.
    const observeTermination = (code: number | null): void => {
      toolTerminationObserved = true;
      finish(code === 0 ? 'TREE_KILLED' : 'NOT_TREE_KILLED', code !== 0);
    };

    tool.on('exit', observeTermination);
    tool.on('close', observeTermination);
  } catch {
    // `spawn`, `setTimer` or `on` can throw synchronously instead of emitting
    // `'error'`. Same controlled outcome, same single fallback, and no
    // half-registered tool or timer left behind — `finish` owns both.
    finish('NOT_TREE_KILLED', true);
  }

  return supervisor;
}
