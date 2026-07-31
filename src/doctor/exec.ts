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
 *  - Every process gets a timeout. This is a hang guard, not a retry or
 *    backoff mechanism: a timed-out command is reported as timed out and the
 *    diagnostics continue. Nothing is ever retried.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { extname, isAbsolute } from 'node:path';

/** Default per-command wall-clock budget. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

/**
 * Arguments may only contain characters that are inert for both the Win32
 * command-line parser and `cmd.exe`. All diagnostic arguments used by this
 * tool are compile-time constants like `--version`; the check exists so that
 * stays true if someone later makes them dynamic.
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
  | 'NOT_FOUND'
  | 'SPAWN_FAILED';

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
  /** Present only when the process could not be started. */
  readonly spawnError?: string;
}

export interface RunOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

/**
 * Resolves a command name to a concrete file on PATH.
 * Returns every candidate, most-specific first, or an empty array.
 */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv): readonly string[] {
  if (isAbsolute(command)) return [command];

  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const args = process.platform === 'win32' ? [command] : ['-a', command];
    const out = execFileSync(finder, args, {
      encoding: 'utf8',
      env,
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
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
function planSpawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv): SpawnPlan | null {
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
    const comspec = env.COMSPEC ?? 'cmd.exe';
    const inner = [`"${batch}"`, ...args].join(' ');
    return { file: comspec, args: ['/d', '/s', '/c', `"${inner}"`], verbatim: true };
  }

  const first = candidates[0];
  return first === undefined ? null : { file: first, args, verbatim: false };
}

/**
 * Runs one diagnostic command. Never throws for a failing command — a non-zero
 * exit code, a missing binary and a timeout are all *data*.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<CommandResult> {
  assertSafeArgs(args);

  const display = [command, ...args].join(' ');
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const base = {
    display,
    executable: command,
    args,
    startedAt,
  };

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

  const plan = planSpawn(command, args, options.env);
  if (plan === null) {
    return finish({
      started: false,
      outcome: 'NOT_FOUND',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      spawnError: `Executable "${command}" was not found on PATH.`,
    });
  }

  return await new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(plan.file, [...plan.args], {
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(
        finish({
          started: false,
          outcome: error.code === 'ENOENT' ? 'NOT_FOUND' : 'SPAWN_FAILED',
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          spawnError: `${error.code ?? 'ERROR'}: ${error.message}`,
        }),
      );
    });

    child.on('close', (code, signal) => {
      settle(
        finish({
          started: true,
          outcome: timedOut ? 'TIMED_OUT' : 'COMPLETED',
          exitCode: code,
          signal,
          stdout,
          stderr,
          ...(timedOut ? { spawnError: `Timed out after ${timeoutMs} ms.` } : {}),
        }),
      );
    });
  });
}
