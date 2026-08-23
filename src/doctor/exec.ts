/**
 * Safe, bounded child-process execution — the single execution abstraction.
 *
 * ── Two platforms, one contract (V3 slice 3) ───────────────────────────────
 *
 * On **Windows** a command is created behind the native launch boundary:
 * `runCommand` resolves and plans the launch exactly as it always did, and then
 * hands that plan to `../boundary/owned-command.js`, which starts the target
 * inside a strict `KILL_ON_JOB_CLOSE` Job Object the helper owns. Termination —
 * for a timeout, for a byte budget, for anything — is a single kill of that
 * helper, and the kernel takes the tree. There is no `taskkill` on this path,
 * no descendant walk, no list of pids anyone has to keep correct, and **no
 * ordinary-spawn fallback**: a boundary that cannot be established or retained
 * is reported as itself (`SPAWN_FAILED`, `BOUNDARY_LOST`) and nothing runs
 * unowned. That is the ADR's fail-closed requirement
 * (`docs/decisions/2026-08-19-adr-windows-launch-boundary.md`), and softening it
 * would turn a guarantee into a feature while every caller kept believing the
 * guarantee held.
 *
 * On **POSIX** the *mechanism* is unchanged and deliberately so: the ADR decides
 * Windows containment and explicitly decides nothing about POSIX. The child is
 * spawned detached, terminated through its process group, and the bounded
 * confirmation below still applies.
 *
 * One thing did change there, and it is not a containment change: the numeric
 * options are validated now (see {@link RunOptions.timeoutMs}), so `NaN`, a
 * negative, `null` and `Infinity` no longer reach `setTimeout` to be silently
 * turned into one millisecond. That is deliberate — the alternative was to keep
 * one argument meaning two opposite things depending on which platform ran it.
 *
 * What is *not* platform-dependent is the observable contract. PATH resolution,
 * the `.cmd` codec, argument validation, byte budgets, the stdin vocabulary,
 * timeouts, exit-code fidelity and the fixed failure codes are decided here,
 * once, before either path is taken — so a caller reads the same
 * {@link CommandResult} on both. The one member that exists for the owned path
 * alone is `BOUNDARY_LOST`, and that is because the fact it names cannot happen
 * on the other one.
 *
 * Guarantees:
 *  - Every argument is validated against a conservative allow-list before a
 *    process starts, and no caller-supplied command string is ever concatenated
 *    and handed to a shell. There are exactly two execution paths:
 *      · direct executables — executable and argument vector passed to `spawn`
 *        structurally, `shell: false`, with no shell or command processor in
 *        the chain and nothing re-parsed by one;
 *      · `.cmd`/`.bat` targets — deliberately run through the trusted,
 *        environment-independent `cmd.exe /d /s /c` (needed for npm's `.cmd`
 *        shims, which Node refuses to spawn directly) with
 *        `windowsVerbatimArguments`. `cmd.exe` does parse that command line;
 *        what makes it safe is that the line is built only by the strict,
 *        fail-closed codec in `./internal/windows-batch-command.ts` — one
 *        quoted, caret-escaped token per argument, read back by the batch
 *        target as `%~1`, `%~2`, … — and that a literal quote in an argument
 *        or in the target path is refused outright rather than encoded.
 *  - Every process gets a timeout **and** a hard byte budget per stream. Both
 *    are enforced while the output streams, not after the process ends, so a
 *    runaway child can neither hang the doctor nor exhaust its memory.
 *  - Terminating a child on **POSIX** attempts to terminate its whole process
 *    tree, best-effort, through the process group the detached child leads.
 *    (On Windows termination is the boundary's, and the paragraph below
 *    describes a mechanism that path does not use.)
 *    After that best-effort termination attempt, the module waits — with a
 *    bound — for the immediate child to be observably gone, and reports a
 *    distinct failure code if that is not confirmed in time. "Observably gone"
 *    means its `exit` *or* its `close` was seen, and the distinction matters:
 *    `close` additionally waits for every process still holding the inherited
 *    stdio handles, so a descendant alone can hold it back indefinitely, while
 *    `exit` is about the one process this module started. The confirmation is
 *    therefore a statement about the immediate child only; it says nothing
 *    about whether any descendant has exited. That narrowness is the POSIX
 *    contract, not a gap: verified, enumerated process-tree termination needs
 *    kernel-enforced ownership, which on Windows is now the launch boundary
 *    above and on POSIX is out of scope of the ADR that built it. A descendant
 *    that has left the process group is not demonstrably reached by the signal
 *    and is then orphaned holding the pipes, so binding the failure code to
 *    `close` alone made PROCESS_TREE_KILL_FAILED report a descendant condition
 *    this path explicitly does not verify.
 *  - Failures are *data*, never exceptions, and every failure carries a fixed
 *    status code rather than an exception message: a missing program, a spawn
 *    error, a timeout, an exceeded output limit and a failed kill are all
 *    distinguishable without any untrusted text (AO-002, AO-008).
 *
 * A timeout is a hang guard, not a retry or backoff mechanism: a timed-out
 * command is reported as timed out and the diagnostics continue. Nothing is
 * ever retried.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { delimiter as pathDelimiter, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import {
  isContainmentAttestation,
  type ContainmentAttestation,
} from '../core/containment-attestation.js';
import {
  InvalidBoundaryRequestError,
  MAX_TIMER_MS,
  runOwnedCommand,
  type OwnedCommandFailureCode,
  type OwnedCommandOutcome,
  type OwnedCommandResult,
} from '../boundary/owned-command.js';
import { safeErrnoCode } from '../core/safe-error.js';
import {
  encodeWindowsBatchArgument,
  UnsupportedWindowsBatchArgumentError,
} from './internal/windows-batch-command.js';
import { windowsSystemTool } from './internal/windows-system-tools.js';

/** Default per-command wall-clock budget. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

/**
 * Default per-stream byte budget. Diagnostic probes emit a few kilobytes at
 * most; a megabyte is generous and still bounded.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** How long to wait for the immediate child to be observably gone after a best-effort termination attempt. */
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

/**
 * `true` when `value` may be passed to {@link runCommand} as an argument.
 *
 * Exported so a caller that *derives* an argument — a worktree path built from
 * a repository root, say — can decide before spawning whether the value it
 * produced is acceptable here, and fail closed with its own typed code instead
 * of provoking the {@link UnsafeArgumentError} that this module documents as a
 * programming error. A second copy of {@link SAFE_ARG_PATTERN} in a calling
 * module would be free to drift from this one; a shared predicate cannot.
 */
export function isShellInertArgument(value: string): boolean {
  return SAFE_ARG_PATTERN.test(value);
}

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
  /**
   * Nothing was found to run.
   *
   * Kept, deliberately, although the ADR's five-member list omits it. It is not
   * a refinement of `SPAWN_FAILED` and never was: "there is no such program on
   * this machine" is the answer a capability probe exists to get, and every
   * caller that distinguishes "not installed" from "installed and broken" reads
   * this. Merging it into `SPAWN_FAILED` to match a shorter list would delete
   * an answer, not a synonym.
   */
  | 'NOT_FOUND'
  | 'SPAWN_FAILED'
  /**
   * The ownership and supervision boundary was lost before a regular completion
   * of the managed process could be observed (Windows only).
   *
   * The work product is not trustworthy and must not be continued as a success.
   * It is deliberately **not** any of its neighbours:
   *
   *  - not `COMPLETED`, which is the defect it exists to prevent. Spike 2 killed
   *    the helper mid-run and got a run that looked exactly like a clean
   *    completion — ownership had been reported, the pipes closed, and no child
   *    exit code ever arrived;
   *  - not `SPAWN_FAILED`, which says a launch never happened. Here one did;
   *  - not `TIMED_OUT`, which says a policy here ended the run and the tree went
   *    down with it. A termination whose completion was never confirmed is the
   *    opposite claim;
   *  - not `PROCESS_TREE_KILL_FAILED` (a failure *code*, not an outcome), which
   *    is the POSIX path's statement about one immediate child.
   *
   * Unreachable on POSIX, where there is no boundary to lose.
   */
  | 'BOUNDARY_LOST';

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
  /**
   * POSIX only. The immediate child was not observably gone within the grace
   * window after a best-effort process-group termination.
   *
   * Unreachable on the owned Windows path, which has no best-effort mechanism
   * to report on: an unconfirmed termination there is a lost boundary, and is
   * reported as {@link CommandOutcome} `BOUNDARY_LOST` with `BOUNDARY_LOST`.
   */
  | 'PROCESS_TREE_KILL_FAILED'
  /** Windows only. Every way the boundary can be lost, collapsed into one code. */
  | 'BOUNDARY_LOST';

/**
 * What became of the payload on {@link RunOptions.stdin}.
 *
 * Evidence about the *channel*, deliberately separate from `outcome`, which is
 * about the process: a child can exit zero having been handed a fraction of its
 * input, and both of those are true at once.
 *
 * `DELIVERED` is a statement about this process's side of the pipe — the whole
 * payload was written and the stream closed with no error reported. It is not a
 * claim that the child read it. Nothing observable from here can make that
 * claim: a payload smaller than the OS pipe buffer is accepted in full even by
 * a child that has already exited.
 */
export type StdinDelivery =
  /** No payload was configured; the child was given the historical `'ignore'`. */
  | 'NOT_REQUESTED'
  /**
   * The whole payload was handed over, with no error.
   *
   * On POSIX: written to the child's own stdin and closed. On the owned Windows
   * path it additionally requires the boundary's own report that it forwarded
   * the whole stream and let the child see EOF — because there the pipe this
   * process writes into belongs to the *helper*, not to the child, so this
   * side's success is only half the evidence.
   */
  | 'DELIVERED'
  /**
   * Non-delivery that was actually observed.
   *
   * On POSIX: node reported a failure — `EPIPE`, `EOF`, a destroyed stream —
   * while handing the payload to the child. On the owned Windows path: the
   * boundary reported a broken pipe or a part-way read of the payload, or
   * nothing was handed over at all.
   */
  | 'FAILED'
  /**
   * A payload was configured and the run settled before its fate was known.
   *
   * Reached when the command was terminated with a write still in flight. Kept
   * distinct from `FAILED` because it is a different fact, and distinct from
   * `DELIVERED` because reporting a delivery that was never confirmed is the
   * defect this vocabulary exists to prevent.
   *
   * One case is reported here on the owned Windows path and as `FAILED` on
   * POSIX, deliberately and with no intention of reconciling it: a *local*
   * write that fails beside a child that exits cleanly. On POSIX that pipe is
   * the child's, so its breaking is evidence about the child. Behind the
   * boundary it is the helper's, so its breaking says the helper died — by this
   * side's hand or by someone else's — and says nothing about what the child
   * received, since the last byte may have gone through microseconds earlier.
   * The two words are not the same claim, and V3 slice 3 resolved this by
   * keeping the weaker one where the evidence is weaker rather than by
   * restoring a verdict nobody observed. Both are non-delivery, and every
   * consumer in this repository treats them identically
   * (`agent/agent-command.ts` folds both into `UNAVAILABLE`).
   */
  | 'UNCONFIRMED';

export interface CommandResult {
  /** The logical command, e.g. `claude auth status --help`. */
  readonly display: string;
  readonly executable: string;
  readonly args: readonly string[];
  /**
   * Whether the OS managed to start the process at all.
   *
   * On the owned Windows path this is answered conservatively, because the
   * boundary can refuse a launch whose target had already begun executing: it
   * is `false` only where the boundary proved the target never ran, and `true`
   * for `'YES'` and for `'UNKNOWN'` alike. Reading a refusal as "nothing
   * happened" is the one inference the boundary's result does not support.
   */
  readonly started: boolean;
  readonly outcome: CommandOutcome;
  readonly exitCode: number | null;
  /**
   * The signal that killed the child, when one did.
   *
   * Always `null` on the owned Windows path: Windows has no signals, the
   * boundary reports a child's own exit code, and every termination there goes
   * through the job object rather than through a signal delivered to a process
   * this module holds. It is not "no signal was seen" standing in for "we did
   * not look" — there is no such channel to look at.
   */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** Fixed code for the failure, or `null` when the command completed. */
  readonly failureCode: CommandFailureCode | null;
  /**
   * Allow-listed `errno` identifier (`ENOENT`, `EACCES`, …), never a message.
   *
   * Always `null` on the owned Windows path. There is no `errno` there to
   * report: a launch is refused by the boundary with a fixed boundary failure
   * code of its own, not by a libuv error on a `spawn` this module made. The
   * field stays `null` rather than being filled with a translated guess.
   */
  readonly errnoCode: string | null;
  /** Whether the stream hit its byte budget and was cut off. */
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /**
   * What became of the payload on {@link RunOptions.stdin}.
   *
   * `NOT_REQUESTED` for every command that configures no payload, which is
   * every diagnostic probe in this repository.
   */
  readonly stdinDelivery: StdinDelivery;
  /**
   * Whether the **best-effort** termination attempt reported success — the
   * process group on POSIX (see {@link killPosixProcessGroup}).
   *
   * Its meaning is unchanged and stays narrow: a mechanism said it worked. It
   * is not kernel ownership of the tree, and not a verified absence of every
   * descendant process.
   *
   * **Always `false` on the owned Windows path**, and that is the honest value
   * rather than a downgrade. The field asks whether a best-effort mechanism
   * reported success; behind the boundary no such mechanism runs, because the
   * kernel holds the job and takes the tree when the helper dies. Re-pointing
   * this boolean at that stronger fact would have been the lie: every caller
   * and comment that has ever read it — and every one written before V3 — reads
   * `true` as "the best-effort attempt returned 0", which is a claim about
   * `taskkill`'s exit code and specifically not a claim that the tree is empty.
   * Whether owned containment held is reported where it is actually decided:
   * on `outcome`, as `BOUNDARY_LOST`.
   */
  readonly processTreeKilled: boolean;
  /**
   * Proof that this command's process was created inside a job this process
   * owns, or absent — which is every command that cannot show it.
   *
   * Optional rather than nullable, and the difference is the point: absence is
   * the answer for the POSIX path, for every command that never reached the
   * boundary, and for every result some other module built. A caller that reads
   * this field gets `undefined` unless a real owned launch put something there,
   * and `undefined` is the conservative reading. Nothing is defaulted to a
   * reassuring value anywhere on the way up.
   *
   * The artefact is opaque and unconstructable outside its mint — see
   * `core/containment-attestation.ts` — so this field cannot be spoofed by
   * substituting the `runOwned` seam or by hand-building a `CommandResult`.
   *
   * It is **not** a permission. `lease/containment-evidence.ts` states what a
   * containment proof does and does not license.
   */
  readonly containment?: ContainmentAttestation;
}

export interface RunOptions {
  /**
   * The child's whole environment. Nothing beyond it is inherited, except the
   * eleven names the platform back-fills into every Windows child anyway.
   *
   * An empty object is accepted and means what it says. On Windows it does not
   * reach the boundary empty — {@link WINDOWS_PLATFORM_BACKFILL} is applied
   * first, which is what `child_process.spawn` would have done for the same
   * call — so the refusal `runOwnedCommand` carries for an environment its wire
   * format cannot express is unreachable from here. That refusal exists for a
   * caller of the adapter, and it matters because the format cannot distinguish
   * "no variables" from "no environment given": the helper answers the second
   * by letting the child inherit AO's own, which is the widening the env guard
   * exists to prevent.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Wall-clock budget. Defaults to {@link DEFAULT_COMMAND_TIMEOUT_MS}.
   *
   * Validated rather than handed to `setTimeout` raw, and identically on both
   * platforms (V3 slice 3). A value that is not a non-negative number — `NaN`,
   * a negative, `null`, a string from an untyped caller — is not a budget, so
   * the documented default is used instead of node's silent coercion of all of
   * them to one millisecond, which made an absent configuration value present
   * itself as an instant timeout.
   *
   * `Infinity` is the one over-large value a caller can plausibly mean, and it
   * means "effectively never": it clamps to the largest delay a timer can
   * express (~24.8 days). Before slice 3 the diagnostics path let node turn it
   * into **1 ms** while the owned path clamped it — the exact opposite
   * behaviours from the same argument, decided by which platform ran. The clamp
   * is now the contract on both.
   */
  readonly timeoutMs?: number;
  readonly cwd?: string;
  /**
   * Hard byte budget for stdout. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}.
   *
   * Validated like {@link timeoutMs}, and for the same reason: `NaN` used to
   * cut every stream at its first byte and report an output-limit failure over
   * empty output. `Infinity` is honoured as written — a caller disabling the
   * bound — and is *not* clamped, because a timer's ceiling has no business
   * bounding a buffer.
   */
  readonly maxStdoutBytes?: number;
  /** Hard byte budget for stderr. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  readonly maxStderrBytes?: number;
  /**
   * How long termination gets before it is reported as unconfirmed.
   *
   * POSIX: how long to wait for the immediate child to be observably gone after
   * a best-effort process-group kill. Windows: how long the boundary is given
   * to end after it has been asked to. Same option, same default, and in both
   * cases running out is reported rather than waited through.
   *
   * Unlike {@link timeoutMs}, `Infinity` falls back to the default here. An
   * unbounded grace is not a longer grace — it is the absence of the guarantee
   * the grace exists to give.
   */
  readonly killGraceMs?: number;
  /**
   * Text written to the child's standard input, which is then closed.
   *
   * Absent by default, and absence keeps the historical behaviour exactly:
   * `stdin` is `'ignore'`, so a child that reads it sees EOF immediately and
   * no diagnostic probe changes shape.
   *
   * It exists because the agent CLIs take their instructions on stdin and
   * cannot take them any other way here. `SAFE_ARG_PATTERN` excludes spaces
   * and quotes, so a prompt is not expressible as an argv token at all, and
   * both installed CLIs document stdin as the alternative — `codex exec`
   * prints "Reading additional input from stdin..." and reads it when no
   * PROMPT argument is given (codex-cli 0.146.0), and `claude -p` is
   * documented as the mode for pipes (Claude Code 2.1.226).
   *
   * This is a *payload* channel, never a command channel: the bytes are
   * handed to the child's own reader, and nothing on this path is parsed by a
   * shell or a command processor. On the `.cmd` route the payload does not
   * touch the `cmd.exe` command line either — that line is still built from
   * the encoded argument vector alone.
   *
   * A write that fails is data, not an exception: a child that exits without
   * reading its input makes the pipe emit `EPIPE`, and that is reported on
   * {@link CommandResult.stdinDelivery} rather than by a rejected promise.
   *
   * It is reported, and not merely tolerated. The earlier version of this path
   * caught the error and discarded it, on the reasoning that the child's own
   * exit code would say so. It does not (V1-05-RR-F5): a child that reads a
   * prefix of its instructions, closes its read end and exits zero with a
   * well-formed result is indistinguishable, at the process level, from one
   * that did the work.
   */
  readonly stdin?: string;
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

/**
 * Resolves `path` to its canonical, absolute form and confirms it is still a
 * regular file *after* canonicalisation — never before. Symlink/junction
 * targets and 8.3-alias paths are followed by `realpathSync.native` first, so
 * the value returned here (and only this value) is what every later
 * consumer — validation, logging, the actual spawn — sees. Returns `null` for
 * anything that does not resolve to an existing regular file: absent,
 * unreadable, or a directory (AO-FOUNDATION-REM-003B-R1).
 */
function canonicalRegularFile(path: string): string | null {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return null;
  }
  return isRegularFile(canonical) ? canonical : null;
}

/** A command containing a path separator names a file directly; PATH plays no role. */
function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

/** `cwd`, absolutely resolved; `process.cwd()` at the moment this runs if `cwd` is absent. */
function effectiveSpawnCwd(cwd: string | undefined): string {
  if (cwd === undefined) return process.cwd();
  return isAbsolute(cwd) ? cwd : resolvePath(cwd);
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
 *
 * Every candidate this function returns is the **absolute, canonical**
 * result of {@link canonicalRegularFile} — never a raw joined or relative
 * path. Relative PATH segments and a relative explicit `command` (one
 * containing a path separator) are resolved against exactly `cwd` — the same
 * effective spawn CWD `planSpawn` uses for the actual `spawn()` call, so
 * lookup and execution can never disagree about which file was validated
 * (AO-FOUNDATION-REM-003B-R1). `cwd` defaults to `process.cwd()` at call
 * time when omitted, matching a caller that never passes `options.cwd`.
 */
export function resolveOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): readonly string[] {
  const baseCwd = effectiveSpawnCwd(cwd);

  if (isAbsolute(command)) {
    const canonical = canonicalRegularFile(command);
    return canonical === null ? [] : [canonical];
  }

  if (hasPathSeparator(command)) {
    // An explicit relative program path is resolved directly against the
    // effective spawn CWD, exactly once, and never searched on PATH — this
    // mirrors Win32 CreateProcess semantics for a name containing a
    // directory separator.
    const canonical = canonicalRegularFile(resolvePath(baseCwd, command));
    return canonical === null ? [] : [canonical];
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
      const dirAbsolute = isAbsolute(dir) ? dir : resolvePath(baseCwd, dir);
      for (const ext of extensions) {
        const canonical = canonicalRegularFile(join(dirAbsolute, command + ext));
        if (canonical !== null) candidates.push(canonical);
      }
    }
  } else {
    for (const dir of directories) {
      const dirAbsolute = isAbsolute(dir) ? dir : resolvePath(baseCwd, dir);
      const canonical = canonicalRegularFile(join(dirAbsolute, command));
      if (canonical !== null) candidates.push(canonical);
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
 * Static, safe message for a batch argument this codec cannot encode. Never
 * carries the argument's content (AO-FOUNDATION-REM-003B-R2/R3): see
 * `./internal/windows-batch-command.js` for why an embedded `"` has no
 * supported encoding through the trusted cmd.exe fallback.
 */
const UNSUPPORTED_BATCH_ARGUMENT_MESSAGE =
  'Refusing to spawn a diagnostic process: a batch argument contains a literal double quote, ' +
  'which has no round-trip-safe encoding through cmd.exe. Details are withheld.';

/**
 * Static, safe message for an explicit `.cmd`/`.bat` target path containing a
 * literal double quote. Never carries the path: an embedded `"` is outside
 * the supported input range regardless of whether the path exists.
 */
const UNSAFE_BATCH_PATH_MESSAGE =
  'Refusing to spawn a diagnostic process: an explicit .cmd/.bat target path contains a ' +
  'literal double quote, which is outside the supported input range. Details are withheld.';

/**
 * True when `command` names a `.cmd`/`.bat` target explicitly — an absolute
 * path, or one containing a path separator — as opposed to a bare name left
 * to PATH/PATHEXT resolution. Purely syntactic: no filesystem access, no
 * environment lookup, no canonicalisation. This is what lets the caller
 * reject an embedded quote in the target path *before* any resolution is
 * attempted, so the refusal never depends on whether the path exists.
 */
function isExplicitWindowsBatchPath(command: string): boolean {
  return (
    (isAbsolute(command) || hasPathSeparator(command)) &&
    WINDOWS_BATCH_EXTENSIONS.has(extname(command).toLowerCase())
  );
}

/**
 * Picks the spawn plan from exactly the **first** resolved PATH/PATHEXT
 * candidate — never a global search for a preferred extension — and builds
 * it.
 *
 * On Windows, npm installs both an extension-less shell script and a `.cmd`
 * shim, and Node refuses to execute either directly (CVE-2024-27980). The
 * first candidate decides the shape: a `.cmd`/`.bat` hit is run through
 * `cmd.exe /d /s /c ""<target>" <args>"`; anything else (`.exe`, `.com`, or
 * a bare executable) is spawned directly. A later, lower-priority candidate
 * of a different extension never overrides this (AO-FOUNDATION-REM-003B-R2)
 * — resolution order alone decides, exactly as it would for a real Windows
 * `CreateProcess` PATH search.
 *
 * That doubled-quote form is the shape `/s` is specified for: cmd strips the
 * outer pair and takes the rest verbatim, so a target path containing spaces —
 * `C:\Program Files\nodejs\npm.cmd` — stays a single token. Every batch
 * argument is encoded by {@link encodeWindowsBatchArgument}
 * (AO-FOUNDATION-REM-003B-R2/R3); a target path containing a quote is
 * refused outright.
 */
function planSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): SpawnPlan | null {
  // Checked first, before any resolution: an explicit batch path with an
  // embedded quote is fail-closed regardless of whether it exists, so
  // existence can never mask this refusal behind a NOT_FOUND result.
  if (isExplicitWindowsBatchPath(command) && command.includes('"')) {
    throw new UnsafeArgumentError(UNSAFE_BATCH_PATH_MESSAGE);
  }

  const candidates = resolveOnPath(command, env, effectiveSpawnCwd(cwd));
  const first = candidates[0];
  if (first === undefined) return null;

  if (WINDOWS_BATCH_EXTENSIONS.has(extname(first).toLowerCase())) {
    if (first.includes('"')) {
      throw new UnsafeArgumentError(
        `Refusing to run ${JSON.stringify(first)} through cmd.exe: the path contains a quote.`,
      );
    }
    let encodedArgs: string[];
    try {
      encodedArgs = args.map(encodeWindowsBatchArgument);
    } catch (error) {
      if (error instanceof UnsupportedWindowsBatchArgumentError) {
        throw new UnsafeArgumentError(UNSUPPORTED_BATCH_ARGUMENT_MESSAGE);
      }
      throw error;
    }
    // The trusted, environment-independent cmd.exe only: COMSPEC is never
    // read, so a caller-controlled COMSPEC cannot substitute the interpreter
    // (AO-FOUNDATION-REM-003B).
    const comspec = windowsSystemTool('cmd.exe');
    const inner = [`"${first}"`, ...encodedArgs].join(' ');
    return { file: comspec, args: ['/d', '/s', '/c', `"${inner}"`], verbatim: true };
  }

  return { file: first, args, verbatim: false };
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
 * The POSIX best-effort termination attempt — the only one left in this module.
 *
 * V3 slice 3 removed the Windows half. It was the supervised `taskkill /T /F`
 * in `internal/windows-process-tree-termination.ts`, and it is gone from this
 * path because it may no longer decide a Windows process's lifetime: measured
 * on 2026-08-18, it returned exit code 0 in ten of ten rounds while leaving 38
 * orphaned descendants alive. Windows lifetime is the boundary's, and the
 * supervisor is no longer wired to anything productive.
 *
 * The child is spawned detached, so it leads its own process group.
 * `process.kill(-pid, 'SIGKILL')` is a best-effort attempt to signal that
 * process group; it is not an enumeration of descendants, and a descendant
 * that has left the group (or session) is not demonstrably reached by it.
 * That limit is the contract here, not a pending refinement.
 *
 * @returns whether the termination attempt reported success — via the process
 * group or the immediate-child fallback; not a verified absence of every
 * descendant.
 */
function killPosixProcessGroup(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;

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

/* ── numeric options, validated once, for both platforms ─────────────────── */

/**
 * A caller-supplied number, or the documented default for one this module
 * cannot use.
 *
 * The type check is not redundant with the compiler, and this is not a
 * defensive flourish: `runCommand` is reached from JavaScript through the dist
 * artefact and its harnesses, and a `NaN` is what a missing configuration value
 * becomes after `parseInt`. Every branch here was a measured misbehaviour of
 * the unvalidated version — `NaN` and a negative both reaching `setTimeout` as
 * one millisecond, `NaN` reaching a byte budget and cutting every stream at
 * zero while reporting an output-limit failure over empty output.
 *
 * `Infinity` is deliberately **not** in that class. On a byte budget it is a
 * caller saying "no bound", which is a thing this module can do, and folding it
 * into the default would not merely cap the stream — it would report
 * `OUTPUT_LIMIT_EXCEEDED` for a limit the caller had explicitly disabled.
 *
 * Deliberately the same predicate as `../boundary/owned-command.js` applies to
 * the same options, so a value that survives here survives there unchanged and
 * the two paths cannot disagree about what a caller asked for.
 */
function usableNumber(value: number | undefined, fallback: number): number {
  return typeof value !== 'number' || Number.isNaN(value) || value < 0 ? fallback : value;
}

/**
 * The same, for a delay.
 *
 * Delays carry one bound budgets must not: node turns a timeout above the
 * 32-bit maximum into 1 ms, so an unbounded delay has to become the largest one
 * a timer can express, or "effectively never" arrives immediately. A byte
 * budget has no such limit.
 */
function usableDelay(value: number | undefined, fallback: number): number {
  return Math.min(usableNumber(value, fallback), MAX_TIMER_MS);
}

/**
 * And the same again for the one delay that may not be unbounded.
 *
 * The grace exists to bound a termination that did not take, so an unbounded
 * one is not a longer grace — it is the absence of the guarantee. `Infinity` on
 * a timeout is a caller saying "effectively never", which is legitimate; here
 * the same value would mean the fail-closed report never arrives at all.
 */
function usableGrace(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0
    ? fallback
    : Math.min(value, MAX_TIMER_MS);
}

/* ── the owned Windows path ──────────────────────────────────────────────── */

/**
 * The eleven variables libuv puts into every Windows child whatever block is
 * handed to `spawn`, back-filled out of *this* process's environment.
 *
 * They are copied here because the owned path does not go through libuv, and
 * `runCommand`'s environment contract is not a slice-3 decision. The helper
 * hands `CreateProcessW` exactly the block it is given, so without this a child
 * receives literally `PATH` and `PATHEXT` and nothing else — and that is not a
 * tightening, it is a different contract from the one every caller here was
 * built and measured against. Measured: `node` itself will not start, exiting
 * 134 with an empty stdout, which turns every verification command and every
 * `node`-based probe into an infrastructure failure.
 *
 * The list is `src/auth/env-guard.ts`'s, which documents it as measured
 * (`tests/probe-env-policy.test.ts`) rather than assumed, and states the
 * consequence this reproduces: "withheld by policy" means "not supplied by us"
 * rather than "unreachable by the child" for exactly these names. Reproducing
 * it keeps that sentence true; dropping it would have made the same policy mean
 * two different things on two paths of one function.
 *
 * The reproduction is of the *set*, not of libuv's whole algorithm: that also
 * sorts the block and collapses keys that differ only in case, and the helper
 * emits what it is given in order. No caller here can tell — every environment
 * on this path comes from `createProbeEnv`'s allow-list, so a `Path` beside a
 * `PATH` is not expressible — but the narrower claim is the true one.
 *
 * It is deliberately **not** an opportunity to narrow the set. Doing that is a
 * change to what an agent's environment contains, which is the env guard's
 * decision and a separate one — the ADR is explicit that a job object bounds
 * process lifetime and nothing else, and is "no argument for widening or
 * narrowing an agent's authority".
 *
 * Exported so that a downstream policy can *assert* something about this list
 * rather than restate it. V4 slice 2 needs that: it runs a client whose
 * behaviour some environment variables would redirect, and a policy comment
 * that described only what AO supplies was read — twice, by two independent
 * reviewers — as a claim about what the child receives. What that slice asserts
 * is disjointness from the client's own documented override variables, and the
 * limits of that check are stated where the claim is made, not here.
 */
export const WINDOWS_PLATFORM_BACKFILL = Object.freeze([
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const);

/**
 * `env`, plus whatever of {@link WINDOWS_PLATFORM_BACKFILL} it does not already
 * supply.
 *
 * A name the caller supplied always wins, and the comparison is
 * case-insensitive because a Windows environment block is: a caller passing
 * `Path` must not end up with a second, back-filled `PATH` beside it, which is
 * a block `CreateProcessW` accepts and whose winner is not this module's to
 * decide.
 */
function withWindowsPlatformBackfill(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const supplied = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') supplied.add(name.toUpperCase());
  }

  const merged: NodeJS.ProcessEnv = { ...env };
  for (const name of WINDOWS_PLATFORM_BACKFILL) {
    if (supplied.has(name)) continue;
    // `process.env` is case-insensitive on Windows, so this finds `SystemRoot`
    // for `SYSTEMROOT` without this module having to know the OS's spelling.
    const value = process.env[name];
    if (typeof value === 'string') merged[name] = value;
  }
  return merged;
}

/**
 * How a launch obtains an owned process. Substituted only by tests.
 *
 * The seam exists because the endings that matter most here cannot be provoked
 * from a real command: a boundary that dies mid-run, a termination that is
 * never confirmed, an ending that contradicts itself. It proves the
 * *classification* and nothing more — that a real Windows command reaches this
 * path at all, and that its tree really dies, are separate claims, measured by
 * the real-process cases and by `tests/dist-artifact/`.
 */
export interface RunDependencies {
  readonly runOwned?: typeof runOwnedCommand;
}

/**
 * The owned adapter's outcome, in `runCommand`'s vocabulary.
 *
 * Total over {@link OwnedCommandOutcome} by construction, so a sixth member
 * added to that union stops this build rather than falling through to a default.
 * Completeness is not correctness, though, and this table is exhaustively
 * asserted value-by-value in `tests/v3-03-owned-runner.test.ts` — a `satisfies`
 * clause would accept `COMPLETED` in every row.
 */
const OWNED_OUTCOME: Readonly<Record<OwnedCommandOutcome, CommandOutcome>> = Object.freeze({
  COMPLETED: 'COMPLETED',
  TIMED_OUT: 'TIMED_OUT',
  OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
  // Nothing was spawned by this process, and the boundary refused to create
  // anything owned. `SPAWN_FAILED` is what this module has always called that.
  LAUNCH_REFUSED: 'SPAWN_FAILED',
  BOUNDARY_LOST: 'BOUNDARY_LOST',
  // Unreachable: `runCommand` has no cancellation and passes no `AbortSignal`,
  // so nothing can ask the adapter to terminate on a caller's behalf. A run
  // that comes back cancelled anyway is a boundary this side cannot account
  // for, which is exactly what `BOUNDARY_LOST` means — and is emphatically not
  // a completion.
  TERMINATED_BY_CALLER: 'BOUNDARY_LOST',
});

/**
 * Which outcomes may carry containment upwards, in *this* module's vocabulary.
 *
 * A second, independent refusal. `boundary/owned-command.ts` already withholds
 * the attestation for every outcome that is not accountable, and this table
 * says the same thing again in the alphabet the rest of the build reads —
 * because {@link toCommandResultFields} is exported and total, and the value it
 * is handed need not have come from the adapter. Without it a hand-built result
 * pairing a genuine attestation with `outcome: 'BOUNDARY_LOST'` would have been
 * carried straight through: the fail-closed branch below does not catch that
 * pair, since a lost boundary carrying its declared failure code is a perfectly
 * well-formed result.
 *
 * Total over {@link CommandOutcome} by construction, and asserted row by row
 * through {@link carriesContainment} in `tests/v3-04-lease-containment.test.ts`
 * — `satisfies` would accept `true` everywhere, and a behavioural test can only
 * reach the rows some owned outcome maps onto, which is five of the six.
 */
const CONTAINMENT_CARRYING: Readonly<Record<CommandOutcome, boolean>> = Object.freeze({
  COMPLETED: true,
  TIMED_OUT: true,
  OUTPUT_LIMIT_EXCEEDED: true,
  // Not reachable through `OWNED_OUTCOME`: nothing owned maps onto it, and a
  // command that was never found never reached the boundary. Stated anyway,
  // because a table with an unstated row is a table with a default.
  NOT_FOUND: false,
  SPAWN_FAILED: false,
  BOUNDARY_LOST: false,
});

/** Whether a result with this outcome may carry a containment attestation. */
export function carriesContainment(outcome: CommandOutcome): boolean {
  return CONTAINMENT_CARRYING[outcome] === true;
}

/**
 * The owned adapter's failure code, in `runCommand`'s vocabulary.
 *
 * Four of the adapter's nine codes are ways of losing the boundary, and they
 * collapse into one here deliberately. `CommandResult` gains the minimum needed
 * to state the fact the ADR requires — that the boundary was lost — and not a
 * second alphabet describing how. The distinction is preserved where it is
 * decided, on `OwnedCommandResult`.
 */
const OWNED_FAILURE: Readonly<Record<OwnedCommandFailureCode, CommandFailureCode>> = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  OUTPUT_LIMIT_STDOUT: 'OUTPUT_LIMIT_STDOUT',
  OUTPUT_LIMIT_STDERR: 'OUTPUT_LIMIT_STDERR',
  LAUNCH_REFUSED: 'SPAWN_FAILED',
  BOUNDARY_LOST: 'BOUNDARY_LOST',
  BOUNDARY_TERMINATION_UNCONFIRMED: 'BOUNDARY_LOST',
  BOUNDARY_STREAMS_UNAVAILABLE: 'BOUNDARY_LOST',
  ENDING_INCONSISTENT: 'BOUNDARY_LOST',
  TERMINATED_BY_CALLER: 'BOUNDARY_LOST',
});

/**
 * Translates one owned run into this module's result shape.
 *
 * Exported for tests, and total: every input it cannot read as a completion
 * becomes a lost boundary rather than the nearest plausible success. That last
 * clause is the whole point of the function — `COMPLETED` is the one value a
 * caller acts on as evidence, and three independent things must hold before it
 * is stated here.
 */
export function toCommandResultFields(
  owned: OwnedCommandResult,
): Omit<CommandResult, 'display' | 'executable' | 'args' | 'startedAt' | 'finishedAt' | 'durationMs'> {
  const mappedOutcome = OWNED_OUTCOME[owned.outcome];
  const mappedFailure = owned.failureCode === null ? null : OWNED_FAILURE[owned.failureCode];

  /**
   * The last gate before a caller reads this as success.
   *
   * `runOwnedCommand` already refuses each of these, and that is the argument
   * for stating them again rather than against it: this is where a completion
   * crosses out of the module whose enumerated tests cover it and into the one
   * every agent, verification and Git seam reads. An outcome this build does
   * not declare indexes the tables above to `undefined`, which is neither a
   * completion nor a declared failure and throws nothing — fail-*open* in the
   * one translation that must fail closed.
   */
  const completed =
    mappedOutcome === 'COMPLETED' &&
    mappedFailure === null &&
    owned.established === true &&
    owned.exitCode !== null;
  const declared = mappedOutcome !== undefined && (owned.failureCode === null || mappedFailure !== undefined);
  // And the mirror of the first condition, which an earlier version left open:
  // an outcome that is *not* a completion, carrying no failure code. Nothing
  // `classifyOwnedCommand` produces looks like that — but the whole reason this
  // gate exists is that the value crossing it need not have come from there,
  // and a caller reading `failureCode === null` as "nothing went wrong" beside
  // a `TIMED_OUT` is the same confusion in the other direction.
  const unexplained = mappedOutcome !== 'COMPLETED' && mappedFailure === null;

  if (!declared || unexplained || (mappedOutcome === 'COMPLETED' && !completed)) {
    return {
      // A boundary this side cannot account for may still have run the target.
      started: true,
      outcome: 'BOUNDARY_LOST',
      exitCode: null,
      signal: null,
      stdout: owned.stdout,
      stderr: owned.stderr,
      failureCode: 'BOUNDARY_LOST',
      errnoCode: null,
      stdoutTruncated: owned.stdoutTruncated,
      stderrTruncated: owned.stderrTruncated,
      stdinDelivery: owned.stdinDelivery,
      processTreeKilled: false,
    };
  }

  return {
    /**
     * Carried only from here, and deliberately not from the fail-closed branch
     * above. That branch is reached for an outcome this build does not declare
     * or a completion it will not state, and a run this module refuses to
     * describe is not one whose containment it should be passing on — even
     * though the adapter would already have withheld the attestation for every
     * such outcome it can produce. Two independent refusals for a value that may
     * not travel; the same argument the `completed` gate above makes about
     * success.
     *
     * Two gates, and neither is redundant. The registry check is what makes
     * this safe against a fabricated `OwnedCommandResult` — the `runOwned` seam
     * is a documented substitution point, and a substitute is free to put any
     * value on this field, so only the mint's own artefact gets past. The
     * outcome check is {@link CONTAINMENT_CARRYING}, which refuses the pair
     * "genuine attestation, unaccountable outcome" that the fail-closed branch
     * above lets through as a well-formed result.
     *
     * Spread conditionally so the field is *absent* rather than `undefined`
     * when there is nothing to carry.
     */
    ...(CONTAINMENT_CARRYING[mappedOutcome] === true && isContainmentAttestation(owned.containment)
      ? { containment: owned.containment }
      : {}),
    // `established` is the strong answer and `targetStarted` the conservative
    // one. A refusal whose target had already begun executing — possible in
    // `JOBLIST` mode, where the target runs from its first instruction — is
    // still a process that started, and `'UNKNOWN'` counts as `'YES'` here
    // exactly as the ADR requires.
    started: owned.established || owned.targetStarted !== 'NO',
    outcome: mappedOutcome,
    exitCode: owned.exitCode,
    // Windows has no signals, and the boundary reports the child's own exit
    // code. There is no channel to read one from.
    signal: null,
    stdout: owned.stdout,
    stderr: owned.stderr,
    failureCode: mappedFailure,
    // No `spawn` was made by this process, so there is no libuv errno.
    errnoCode: null,
    stdoutTruncated: owned.stdoutTruncated,
    stderrTruncated: owned.stderrTruncated,
    stdinDelivery: owned.stdinDelivery,
    // No best-effort mechanism ran. See `CommandResult.processTreeKilled`.
    processTreeKilled: false,
  };
}

/**
 * Runs one diagnostic command. Never throws for a failing command — a non-zero
 * exit code, a missing binary, a timeout and an oversized output are all
 * *data*. The only thrown error is {@link UnsafeArgumentError}, which is a
 * programming error in this repository, not a runtime condition.
 *
 * On Windows the command is created behind the native launch boundary and the
 * kernel owns its tree; on POSIX it is spawned here. Resolution, planning,
 * validation and every number above are decided before that fork, so the fork
 * changes which mechanism runs the command and not what the caller is promised.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions,
  dependencies: RunDependencies = {},
): Promise<CommandResult> {
  assertSafeArgs(args);

  const display = [command, ...args].join(' ');
  const timeoutMs = usableDelay(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  const maxStdoutBytes = usableNumber(options.maxStdoutBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const maxStderrBytes = usableNumber(options.maxStderrBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const killGraceMs = usableGrace(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
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
    plan = planSpawn(command, args, options.env, options.cwd);
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
      // Nothing was spawned, so no payload was handed to anything.
      stdinDelivery: options.stdin === undefined ? 'NOT_REQUESTED' : 'FAILED',
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
      // Nothing was spawned, so no payload was handed to anything.
      stdinDelivery: options.stdin === undefined ? 'NOT_REQUESTED' : 'FAILED',
      processTreeKilled: false,
    });
  }

  if (process.platform === 'win32') {
    /**
     * The Windows target is created behind the boundary, and only there.
     *
     * There is no `else` for a boundary that is unavailable and no second
     * attempt with an ordinary `spawn`: `runOwnedCommand` reports a refusal,
     * this maps it to `SPAWN_FAILED`, and nothing runs unowned. That is the
     * ADR's fail-closed requirement and it is the reason this branch returns
     * unconditionally rather than falling through to the code below.
     *
     * Everything the plan decided is carried across verbatim — the canonical
     * executable, the argument vector, and `verbatim` for the trusted
     * `cmd.exe /d /s /c` route, whose command line the helper rebuilds with the
     * same rule node applies for `windowsVerbatimArguments`. Nothing is
     * re-resolved on the other side: `runOwnedCommand` resolves nothing, by
     * contract, so the file this validated is the file that runs.
     */
    const runOwned = dependencies.runOwned ?? runOwnedCommand;
    let owned: OwnedCommandResult;
    try {
      owned = await runOwned({
        file: plan.file,
        args: plan.args,
        verbatim: plan.verbatim,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        // The block libuv would have produced for the same call, so that moving
        // the mechanism does not move the environment. See the note above.
        env: withWindowsPlatformBackfill(options.env),
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        // The same option under the name that layer gives it. Both mean "how long
        // termination gets before it is reported as unconfirmed".
        terminationGraceMs: killGraceMs,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
    } catch (error) {
      // `runOwnedCommand` never throws for a failing *command* — but it does
      // re-throw one condition, and this function's contract has to survive
      // that. `InvalidBoundaryRequestError` is raised for a request the
      // boundary's transport cannot represent: a NUL inside a value, or an `=`
      // in an environment name. Both are programming errors in this repository,
      // exactly as an unsafe argument is, and both are refused before anything
      // is created.
      //
      // Translated into the one exception this module documents rather than let
      // out as a second type. Otherwise the same call throwing
      // `UnsafeArgumentError` on POSIX would throw something else on Windows,
      // and the three seams above — which catch `UnsafeArgumentError` and
      // re-throw everything else — would turn a bad argument into an escaping
      // exception on one platform and a typed refusal on the other. The message
      // is not carried: it may contain the offending value.
      if (error instanceof InvalidBoundaryRequestError) {
        throw new UnsafeArgumentError(
          'Refusing to spawn a diagnostic process: the launch request contains a value the ' +
            'boundary transport cannot represent. Details are withheld.',
        );
      }
      throw error;
    }
    return finish(toCommandResultFields(owned));
  }

  // POSIX only from here: the Windows branch above returns unconditionally.
  return await new Promise<CommandResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(plan.file, [...plan.args], {
        env: options.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        shell: false,
        // This starts the child as leader of its own process group;
        // killPosixProcessGroup later makes a best-effort attempt to signal that
        // group via the negative PID. This is not an enumeration of descendants, and
        // processes outside the group or session are not guaranteed to be
        // reached — that is the extent of the guarantee, by design.
        detached: true,
        // A pipe only when there is something to write. With no payload the
        // descriptor stays `'ignore'`, which is what every diagnostic probe
        // has always been given.
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      // A resolved candidate that exists as a regular file but is not a valid
      // executable for this platform/architecture can make `spawn()` throw
      // synchronously instead of emitting the `'error'` event handled below —
      // observed as `spawn UNKNOWN` on this runtime. Reported through the exact
      // same result shape as that event, so a caller never has to distinguish
      // "failed before starting" from "failed after starting", and no timer,
      // listener or process-tree resource is ever registered for a child that
      // was never created (AO-FOUNDATION-REM-003B-R3-RR).
      const errnoCode = safeErrnoCode(spawnError);
      const notFound = errnoCode === 'ENOENT';
      resolvePromise(
        finish({
          started: false,
          outcome: notFound ? 'NOT_FOUND' : 'SPAWN_FAILED',
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          failureCode: notFound ? 'EXECUTABLE_NOT_FOUND' : 'SPAWN_FAILED',
          errnoCode,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdinDelivery: options.stdin === undefined ? 'NOT_REQUESTED' : 'FAILED',
          processTreeKilled: false,
        }),
      );
      return;
    }

    const stdout = new BoundedSink(maxStdoutBytes);
    const stderr = new BoundedSink(maxStderrBytes);

    /**
     * What became of the payload, once it is known.
     *
     * `UNCONFIRMED` while a write is still in flight, so a run that settles
     * early — a timeout, a tree kill — reports honestly that it never found
     * out, rather than claiming a delivery it did not observe.
     */
    let stdinDelivery: StdinDelivery = options.stdin === undefined ? 'NOT_REQUESTED' : 'UNCONFIRMED';

    // The payload, handed over once and then closed so the child sees EOF and
    // does not wait for more.
    //
    // A failure to deliver it is data, exactly like every other failure on this
    // path — but it *is* recorded (V1-05-RR-F5). It used to be caught by an
    // empty `'error'` listener and discarded, on the reasoning that the child's
    // own exit code already said so. It does not: a child that reads a prefix
    // of its instructions, closes its read end and exits zero with a
    // well-formed result produces a completion in which every process-level
    // fact is clean and the only thing wrong is that it was answering a
    // different question.
    //
    // The `end` callback is the observation point rather than the `'error'`
    // event, because it is the more complete one: a stream destroyed underneath
    // the write reports `ERR_STREAM_DESTROYED` to the callback and emits no
    // event at all. The listener is still attached, and must stay — without it
    // an `EPIPE`/`EOF` on this stream is an uncaught exception in *this*
    // process — but its job is now only to keep the process alive.
    if (options.stdin !== undefined) {
      const input = child.stdin;
      if (input === null) {
        // No pipe was opened, so nothing can be handed over. Reported as a
        // failure rather than silently ignored: a payload was configured, and
        // it demonstrably did not reach the child.
        stdinDelivery = 'FAILED';
      } else {
        // Both observations record the same verdict, and a failure once seen is
        // never revised: `'error'` is the one that must exist at all, and the
        // `end` callback is the one that also sees a stream destroyed
        // underneath the write, which emits no event.
        input.on('error', () => {
          stdinDelivery = 'FAILED';
        });
        input.end(options.stdin, (error?: Error | null) => {
          if (stdinDelivery === 'FAILED') return;
          stdinDelivery = error === undefined || error === null ? 'DELIVERED' : 'FAILED';
        });
      }
    }

    let termination: Termination = 'NONE';
    let treeKilled = false;
    let killIssued = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    /**
     * The immediate child's own `exit`, once observed.
     *
     * `exit` and `close` are different facts, and only `exit` is about the
     * process this module started. `close` fires when the child has ended *and*
     * its stdio streams have closed — and those streams stay open for as long as
     * *any* process holds the inherited pipe write handles, which includes every
     * descendant the child passed them to. So `close` is a statement about a
     * descendant set this module explicitly does not own, while `exit` is a
     * statement about the one process it does.
     *
     * That distinction is what the bounded confirmation below turns on. It is
     * only ever read after a termination was issued; a normally completing
     * command still settles on `close`, so its output is never cut short.
     */
    let childExit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null =
      null;

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolvePromise(result);
    };

    const closeResult = (code: number | null, signal: NodeJS.Signals | null): CommandResult =>
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
        stdinDelivery,
        processTreeKilled: treeKilled,
      });

    /**
     * Stage 2 of the termination deadline, entered once the process-group kill
     * has been attempted. Total bound: that attempt plus `killGraceMs`. There
     * is no third wait, no retry and no restart of either stage.
     */
    const treeKillFinished = (reason: Exclude<Termination, 'NONE'>): void => {
      if (settled) return;

      graceTimer = setTimeout(() => {
        if (childExit !== null) {
          // The bounded confirmation succeeded on the fact it is actually
          // about: the immediate child — the one process this module started
          // and owns — is observably gone. Its streams are still open, which
          // means some process that inherited the stdio handles outlived the
          // best-effort group kill. That is a statement about descendants, and
          // this module has never claimed to verify them (see the header): a
          // descendant that left the process group is not demonstrably reached
          // by the signal, is then orphaned holding the pipes, and `close`
          // never arrives at all. Reporting a failed *tree kill* for that would
          // be asserting the very thing the contract disclaims — so the
          // original termination reason is what is reported, unchanged.
          //
          // Nothing is swallowed: whether a descendant survived is a separate
          // property, proven where it is actually asserted (the real-process
          // cases in `tests/exec.test.ts` wait for the grandchild to be gone).
          settle(closeResult(childExit.code, childExit.signal));
          return;
        }
        // Neither `exit` nor `close` was observed within the grace window: the
        // immediate child itself may still be running, so report that
        // distinctly rather than pretending the command merely timed out. This
        // does not confirm any descendant is still running: this path never
        // verifies the whole tree, by design.
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
            stdinDelivery,
            processTreeKilled: treeKilled,
          }),
        );
      }, killGraceMs);
      graceTimer.unref?.();
    };

    /**
     * Runs the best-effort termination attempt **once** and starts the bounded
     * wait for the immediate child's `close` event.
     *
     * The first trigger wins: `killIssued` freezes the reason, so a second
     * trigger (a stdout limit landing in the same tick as the timeout, say)
     * neither changes the reported reason nor starts a second attempt.
     */
    const terminate = (reason: Exclude<Termination, 'NONE'>): void => {
      if (killIssued) return;
      killIssued = true;
      termination = reason;

      treeKilled = killPosixProcessGroup(child);
      treeKillFinished(reason);
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
          stdinDelivery,
          processTreeKilled: false,
        }),
      );
    });

    // Recorded, never settled on directly: a normally completing command must
    // still wait for `close`, so that everything the child wrote is in the
    // result. This only feeds the bounded confirmation above, which is reached
    // exclusively after a termination was issued.
    child.on('exit', (code, signal) => {
      childExit = { code, signal };
    });

    child.on('close', (code, signal) => {
      settle(closeResult(code, signal));
    });
  });
}
