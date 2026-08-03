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
 */
export interface WindowsTreeKillToolProcess {
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  kill(): unknown;
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
   * Abandons the attempt: kills any running tool process and clears the tool
   * timer. Used when the caller settled on an independent path (a child
   * `error`, say) while the attempt was still open, so no tool process outlives
   * the result it was started for. Does **not** run the immediate-child
   * fallback — the caller is no longer waiting on this child at all.
   */
  cancel(): void;
}

/**
 * Starts one supervised `taskkill /PID <pid> /T /F` and returns a handle to it.
 *
 * Distinguishes, and collapses into the two-value outcome:
 *
 *  - tool exit 0                → `TREE_KILLED`, no fallback;
 *  - tool exit non-zero         → `NOT_TREE_KILLED`, one fallback;
 *  - synchronous start failure  → `NOT_TREE_KILLED`, one fallback;
 *  - asynchronous `error` event → `NOT_TREE_KILLED`, one fallback;
 *  - tool timeout               → `NOT_TREE_KILLED`, tool killed, one fallback;
 *  - {@link WindowsTreeKillSupervisor.cancel} → `NOT_TREE_KILLED`, tool killed,
 *    **no** fallback;
 *  - unusable root PID          → `NOT_TREE_KILLED`, nothing spawned, no
 *    fallback (exactly what the synchronous predecessor did).
 *
 * Exactly one tool process is started, at most one fallback is run, and every
 * event arriving after the resolution — a late tool `close`, a late tool
 * `error`, a late `cancel()` — is a no-op.
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

    if (tool !== null) {
      const running = tool;
      tool = null;
      try {
        running.kill();
      } catch {
        /* best effort; the outcome does not depend on it */
      }
    }

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
      // still kill the tool process this timeout is abandoning.
      timer = undefined;
      finish('NOT_TREE_KILLED', true);
    }, dependencies.timeoutMs ?? WINDOWS_TREE_KILL_TIMEOUT_MS);

    tool.on('error', () => {
      finish('NOT_TREE_KILLED', true);
    });

    tool.on('close', (code) => {
      // Cleared first: a process that has already exited must not be signalled
      // by `finish`, and must not be treated as still running.
      tool = null;
      finish(code === 0 ? 'TREE_KILLED' : 'NOT_TREE_KILLED', code !== 0);
    });
  } catch {
    // `spawn`, `setTimer` or `on` can throw synchronously instead of emitting
    // `'error'`. Same controlled outcome, same single fallback, and no
    // half-registered tool or timer left behind — `finish` owns both.
    finish('NOT_TREE_KILLED', true);
  }

  return supervisor;
}
