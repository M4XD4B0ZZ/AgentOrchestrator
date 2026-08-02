/**
 * Safe, bounded child-process execution for diagnostics.
 *
 * Guarantees:
 *  - Executable and arguments are always passed separately. There is no shell
 *    string concatenation anywhere in this module.
 *  - Every argument is validated against a conservative allow-list before a
 *    process starts, so even the Windows `cmd.exe` fallback (needed for npm's
 *    `.cmd` shims, which Node refuses to spawn directly) cannot be used to
 *    smuggle shell metacharacters.
 *  - Every process gets a timeout **and** a hard byte budget per stream. Both
 *    are enforced while the output streams, not after the process ends, so a
 *    runaway child can neither hang the doctor nor exhaust its memory.
 *  - Terminating a child terminates its whole process tree. On Windows a `.cmd`
 *    shim runs under `cmd.exe`, and killing only that shim leaves the real
 *    program running forever; `taskkill /T /F` with a validated numeric PID is
 *    used instead. After a kill, the module waits — with a bound — for the
 *    process to actually be gone, and reports a distinct failure code if it is
 *    not.
 *  - Failures are *data*, never exceptions, and every failure carries a fixed
 *    status code rather than an exception message: a missing program, a spawn
 *    error, a timeout, an exceeded output limit and a failed kill are all
 *    distinguishable without any untrusted text (AO-002, AO-008).
 *
 * A timeout is a hang guard, not a retry or backoff mechanism: a timed-out
 * command is reported as timed out and the diagnostics continue. Nothing is
 * ever retried.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter as pathDelimiter, extname, isAbsolute, join } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';
import { windowsSystemTool } from './internal/windows-system-tools.js';

/** Default per-command wall-clock budget. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

/**
 * Default per-stream byte budget. Diagnostic probes emit a few kilobytes at
 * most; a megabyte is generous and still bounded.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** How long to wait for a killed process tree to actually disappear. */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Arguments may only contain characters that are inert for both the Win32
 * command-line parser and `cmd.exe`. All diagnostic arguments used by this
 * tool are compile-time constants like `--version`; the check exists so that
 * stays true if someone later makes them dynamic.
 *
 * This allow-list is deliberately not widened. Spaces, quotes, `&`, `|`, `^`,
 * `%`, `<`, `>` and `(`/`)` are all excluded, which is what makes the verbatim
 * `cmd.exe /s` command line below safe to build.
 */
const SAFE_ARG_PATTERN = /^[A-Za-z0-9._:@=+\\/-]*$/;

export class UnsafeArgumentError extends Error {}

function assertSafeArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (!SAFE_ARG_PATTERN.test(arg)) {
      throw new UnsafeArgumentError(
        `Refusing to spawn a diagnostic process with argument ${JSON.stringify(arg)}: ` +
          'diagnostic arguments must be shell-inert.',
      );
    }
  }
}

export type CommandOutcome =
  | 'COMPLETED'
  | 'TIMED_OUT'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'NOT_FOUND'
  | 'SPAWN_FAILED';

/**
 * Fixed, safe failure codes. These replace the free-text `spawnError` that used
 * to carry an exception message into diagnostics artefacts.
 */
export type CommandFailureCode =
  | 'EXECUTABLE_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT_STDOUT'
  | 'OUTPUT_LIMIT_STDERR'
  | 'PROCESS_TREE_KILL_FAILED';

export interface CommandResult {
  /** The logical command, e.g. `claude auth status --help`. */
  readonly display: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** Whether the OS managed to start the process at all. */
  readonly started: boolean;
  readonly outcome: CommandOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** Fixed code for the failure, or `null` when the command completed. */
  readonly failureCode: CommandFailureCode | null;
  /** Allow-listed `errno` identifier (`ENOENT`, `EACCES`, …), never a message. */
  readonly errnoCode: string | null;
  /** Whether the stream hit its byte budget and was cut off. */
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Whether a process-tree kill was issued and confirmed to have been sent. */
  readonly processTreeKilled: boolean;
}

export interface RunOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  /** Hard byte budget for stdout. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  readonly maxStdoutBytes?: number;
  /** Hard byte budget for stderr. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  readonly maxStderrBytes?: number;
  /** How long to wait for a killed tree to disappear. */
  readonly killGraceMs?: number;
}

/**
 * The extensions Windows resolves a bare (no explicit extension) command
 * name against when `PATHEXT` is absent from the given environment. Only the
 * four this module's own {@link planSpawn} distinguishes: `.EXE`/`.COM`
 * (spawned directly) and `.BAT`/`.CMD` (spawned through the trusted `cmd.exe`
 * below). A wider default list would only ever fall into `planSpawn`'s
 * generic "spawn the first candidate" branch, so it would change nothing
 * observable — this keeps the default itself easy to audit.
 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `env['PATH']`, split on the platform delimiter. Never throws. */
function pathDirectories(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env['PATH'];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  // An empty segment (`"C:\\a;;C:\\b"`) is skipped rather than treated as the
  // current directory: that legacy DOS convention is a current-directory
  // hijack primitive in disguise, and nothing here relies on it — a
  // deliberate, tested hardening over a literal reproduction of `where.exe`.
  return raw.split(pathDelimiter).filter((entry) => entry.length > 0);
}

/** `env['PATHEXT']` on Windows, split and trimmed; the fixed default if absent. */
function pathextEntries(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env['PATHEXT'];
  const source = typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_PATHEXT;
  return source
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolves a command name to every matching file on PATH, most-specific
 * first — a direct, in-process replacement for spawning `where.exe`
 * (Windows) or `which` (POSIX), neither of which this module starts any
 * more (AO-FOUNDATION-REM-003B). `PATH` and, on Windows, `PATHEXT` are read
 * as plain data from the given environment; nothing here spawns a process,
 * consults a shell, or reads `SystemRoot`/`windir`/`COMSPEC`.
 *
 * The resolved candidate is the object of the capability/auth probe this
 * command *is* — it is never treated as a trusted Windows system tool. That
 * separate, higher trust tier is `./internal/windows-system-tools.js`.
 *
 * An absolute `command` is validated the same way every other candidate is
 * (existing, regular file) rather than trusted verbatim: the caller still
 * decides *which* absolute path to probe, this only confirms there is a
 * file there before a spawn attempt is made.
 */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv): readonly string[] {
  if (isAbsolute(command)) {
    return isRegularFile(command) ? [command] : [];
  }

  const directories = pathDirectories(env);
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    // A name that already carries an extension (`node.exe`, `my.tool`) is
    // resolved exactly as given, in every PATH directory, with no PATHEXT
    // looping — matching how Windows itself treats a dotted command name.
    const hasExplicitExtension = extname(command) !== '';
    const extensions = hasExplicitExtension ? [''] : pathextEntries(env);
    for (const dir of directories) {
      for (const ext of extensions) {
        const candidate = join(dir, command + ext);
        if (isRegularFile(candidate)) candidates.push(candidate);
      }
    }
  } else {
    for (const dir of directories) {
      const candidate = join(dir, command);
      if (isRegularFile(candidate)) candidates.push(candidate);
    }
  }

  return candidates;
}

/** Windows batch shims cannot be spawned directly by Node (CVE-2024-27980). */
const WINDOWS_BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  /**
   * Set for the `cmd.exe` fallback only. Node's per-argument quoting follows
   * the C runtime rules, which `cmd.exe` does not implement, so the command
   * line is handed over verbatim in exactly the form `cmd.exe /s` documents.
   */
  readonly verbatim: boolean;
}

/**
 * Picks the best resolved candidate and builds the spawn plan.
 *
 * On Windows, npm installs both an extension-less shell script and a `.cmd`
 * shim, and Node refuses to execute either directly (CVE-2024-27980). A real
 * executable is therefore preferred, and a batch shim is run through
 * `cmd.exe /d /s /c ""<target>" <args>"`.
 *
 * That doubled-quote form is the shape `/s` is specified for: cmd strips the
 * outer pair and takes the rest verbatim, so a target path containing spaces —
 * `C:\Program Files\nodejs\npm.cmd` — stays a single token. Building it is safe
 * because the target is quoted and every argument has already passed
 * {@link assertSafeArgs}, which excludes spaces, quotes and every shell
 * metacharacter. A target path containing a quote is refused outright.
 */
function planSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnPlan | null {
  const candidates = resolveOnPath(command, env);
  if (candidates.length === 0) return null;

  const executable = candidates.find((c) => ['.exe', '.com'].includes(extname(c).toLowerCase()));
  if (executable !== undefined) {
    return { file: executable, args, verbatim: false };
  }

  const batch = candidates.find((c) => WINDOWS_BATCH_EXTENSIONS.has(extname(c).toLowerCase()));
  if (batch !== undefined) {
    if (batch.includes('"')) {
      throw new UnsafeArgumentError(
        `Refusing to run ${JSON.stringify(batch)} through cmd.exe: the path contains a quote.`,
      );
    }
    // The trusted, environment-independent cmd.exe only: COMSPEC is never
    // read, so a caller-controlled COMSPEC cannot substitute the interpreter
    // (AO-FOUNDATION-REM-003B).
    const comspec = windowsSystemTool('cmd.exe');
    const inner = [`"${batch}"`, ...args].join(' ');
    return { file: comspec, args: ['/d', '/s', '/c', `"${inner}"`], verbatim: true };
  }

  const first = candidates[0];
  return first === undefined ? null : { file: first, args, verbatim: false };
}

/**
 * A stream sink with a hard byte ceiling.
 *
 * Chunks are kept as `Buffer`s and the retained total never exceeds `limit`, so
 * there is no unbounded string or buffer accumulation anywhere. Decoding to
 * UTF-8 happens once, at the end, on at most `limit` bytes.
 */
class BoundedSink {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private cutOff = false;

  constructor(private readonly limit: number) {}

  /** Appends a chunk; returns `true` the first time the limit is exceeded. */
  append(chunk: Buffer): boolean {
    if (this.cutOff) return false;

    const remaining = this.limit - this.size;
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return false;
    }

    if (remaining > 0) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.limit;
    }
    this.cutOff = true;
    return true;
  }

  get truncated(): boolean {
    return this.cutOff;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Terminates a child **and everything it started**.
 *
 * On Windows, `child.kill()` targets only the immediate process. For a `.cmd`
 * shim that is `cmd.exe`, and the actual tool keeps running — which is exactly
 * how a "timed out" diagnostic can leave a live process behind. `taskkill /T
 * /F` walks the tree instead. The PID is validated as a positive integer before
 * it is stringified, and `taskkill.exe` comes from the trusted, environment-
 * independent resolver (AO-FOUNDATION-REM-003B) — never from `PATH`,
 * `SystemRoot` or `windir` — so neither can shadow or redirect it.
 *
 * This is still the pre-AO-008 best-effort behaviour: a successful `taskkill
 * /T /F` is the tree-kill signal, and the direct `child.kill()` fallback below
 * terminates the immediate child only. Neither branch guarantees every
 * descendant is gone; a bounded process-tree guarantee is AO-008's, not this
 * module's.
 *
 * @returns whether a tree kill was successfully issued.
 */
function killProcessTree(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === 'win32') {
    try {
      const taskkillPath = windowsSystemTool('taskkill.exe');
      execFileSync(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5_000,
      });
      return true;
    } catch {
      // Either the trusted taskkill.exe boundary could not be established, or
      // it ran and failed. Either way: fall through to the direct kill below,
      // never to an environment- or PATH-supplied taskkill (AO-FOUNDATION-REM-003B).
      // The caller still bounds the wait.
    }
    try {
      return child.kill('SIGKILL');
    } catch {
      return false;
    }
  }

  // POSIX: the child is spawned detached, so it leads its own process group and
  // the negative PID reaches every descendant.
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try {
      return child.kill('SIGKILL');
    } catch {
      return false;
    }
  }
}

type Termination = 'NONE' | 'TIMEOUT' | 'LIMIT_STDOUT' | 'LIMIT_STDERR';

const TERMINATION_OUTCOME: Readonly<Record<Termination, CommandOutcome>> = Object.freeze({
  NONE: 'COMPLETED',
  TIMEOUT: 'TIMED_OUT',
  LIMIT_STDOUT: 'OUTPUT_LIMIT_EXCEEDED',
  LIMIT_STDERR: 'OUTPUT_LIMIT_EXCEEDED',
});

const TERMINATION_FAILURE: Readonly<Record<Termination, CommandFailureCode | null>> = Object.freeze({
  NONE: null,
  TIMEOUT: 'TIMEOUT',
  LIMIT_STDOUT: 'OUTPUT_LIMIT_STDOUT',
  LIMIT_STDERR: 'OUTPUT_LIMIT_STDERR',
});

/**
 * Runs one diagnostic command. Never throws for a failing command — a non-zero
 * exit code, a missing binary, a timeout and an oversized output are all
 * *data*. The only thrown error is {@link UnsafeArgumentError}, which is a
 * programming error in this repository, not a runtime condition.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<CommandResult> {
  assertSafeArgs(args);

  const display = [command, ...args].join(' ');
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const base = { display, executable: command, args, startedAt };

  const finish = (
    extra: Omit<CommandResult, keyof typeof base | 'finishedAt' | 'durationMs'>,
  ): CommandResult => {
    const finishedAtMs = Date.now();
    return {
      ...base,
      ...extra,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
    };
  };

  let plan: SpawnPlan | null;
  try {
    plan = planSpawn(command, args, options.env);
  } catch (error) {
    // UnsafeArgumentError is a programming error and must keep propagating as
    // an exception (documented above). Anything else here can only be
    // WindowsSystemToolUnavailableError — the trusted cmd.exe boundary could
    // not be established for a resolved `.cmd`/`.bat` target — and that is a
    // runtime condition, reported as data like every other failure to start.
    if (error instanceof UnsafeArgumentError) throw error;
    return finish({
      started: false,
      outcome: 'SPAWN_FAILED',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      failureCode: 'SPAWN_FAILED',
      errnoCode: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      processTreeKilled: false,
    });
  }
  if (plan === null) {
    return finish({
      started: false,
      outcome: 'NOT_FOUND',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      failureCode: 'EXECUTABLE_NOT_FOUND',
      errnoCode: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      processTreeKilled: false,
    });
  }

  return await new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(plan.file, [...plan.args], {
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      // On POSIX this makes the child a process-group leader so the whole tree
      // can be signalled. Windows uses taskkill /T instead.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = new BoundedSink(maxStdoutBytes);
    const stderr = new BoundedSink(maxStderrBytes);

    let termination: Termination = 'NONE';
    let treeKilled = false;
    let killIssued = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolvePromise(result);
    };

    /** Terminates the tree once and starts the bounded wait for it to be gone. */
    const terminate = (reason: Exclude<Termination, 'NONE'>): void => {
      if (killIssued) return;
      killIssued = true;
      termination = reason;
      treeKilled = killProcessTree(child);

      graceTimer = setTimeout(() => {
        // The tree outlived the kill: report that distinctly rather than
        // pretending the command merely timed out.
        settle(
          finish({
            started: true,
            outcome: TERMINATION_OUTCOME[reason],
            exitCode: null,
            signal: null,
            stdout: stdout.text(),
            stderr: stderr.text(),
            failureCode: 'PROCESS_TREE_KILL_FAILED',
            errnoCode: null,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            processTreeKilled: treeKilled,
          }),
        );
      }, killGraceMs);
      graceTimer.unref?.();
    };

    const timer = setTimeout(() => terminate('TIMEOUT'), timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.append(chunk)) terminate('LIMIT_STDOUT');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.append(chunk)) terminate('LIMIT_STDERR');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      const notFound = error.code === 'ENOENT';
      settle(
        finish({
          started: false,
          outcome: notFound ? 'NOT_FOUND' : 'SPAWN_FAILED',
          exitCode: null,
          signal: null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          failureCode: notFound ? 'EXECUTABLE_NOT_FOUND' : 'SPAWN_FAILED',
          errnoCode: safeErrnoCode(error),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          processTreeKilled: false,
        }),
      );
    });

    child.on('close', (code, signal) => {
      settle(
        finish({
          started: true,
          outcome: TERMINATION_OUTCOME[termination],
          exitCode: code,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          failureCode: TERMINATION_FAILURE[termination],
          errnoCode: null,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          processTreeKilled: treeKilled,
        }),
      );
    });
  });
}
