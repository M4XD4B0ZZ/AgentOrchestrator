/**
 * AO-008-S1-R1: the artefact registry behind the teardown of
 * `tests/exec.test.ts`.
 *
 * This is test-support code only. Nothing under `src/` imports it, and it makes
 * no claim about the product's own process lifecycle: the product's termination
 * contract is best-effort by design and is proven elsewhere, not here. Its only
 * job is that a test run cannot leave its own helper processes or scratch
 * directories behind, and cannot aim a kill at anything it did not itself start.
 *
 * Two properties are enforced here, both of which the inline teardown lacked:
 *
 *   1. A PID is claimed only from a fully numeric PID file. `Number.parseInt`
 *      accepted a numeric *prefix*, so `"17628.5"` yielded the live, unrelated
 *      PID 17628 (AO-008-S1-REV-F1).
 *   2. Every registered artefact is attempted. A single `rmSync` failure used to
 *      abort the whole teardown hook, stranding every later directory and
 *      skipping the collection reset (AO-008-S1-REV-F2).
 *
 * The filesystem, process and timer touchpoints are injectable so the contract
 * can be proven without real foreign processes.
 */

import { readFileSync, rmSync } from 'node:fs';

/**
 * One positive decimal integer and nothing else: no sign, no radix prefix, no
 * fraction, no exponent, no trailing text. A leading `0` is excluded by the
 * first character class, which rules out `"0"` and any octal-looking form.
 *
 * `$` is end-of-input in JavaScript (it does not also match before a trailing
 * newline the way it does in some other regex dialects), so the anchors here
 * really do mean "the whole string".
 */
const POSITIVE_DECIMAL_INTEGER = /^[1-9][0-9]*$/;

/**
 * Whether a number is a PID this test run may act on at all.
 *
 * This is the whole numeric invariant, in one place: an exact positive integer.
 * It rules out the values that are not process identifiers but that the OS
 * would still happily interpret — `0` and negatives, which on POSIX address a
 * process *group* rather than a process; `NaN` and the infinities; fractions;
 * and anything past the safe-integer range, where the number no longer stands
 * for the value it was built from.
 *
 * Both entry points go through here, so neither can drift from the other:
 * {@link parseOwnedHelperPid} for text, and {@link ExecArtifactRegistry.registerPid}
 * for a number handed over directly.
 */
export function isValidOwnedPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

/**
 * Parses a PID file's contents into a PID this test run may act on.
 *
 * Surrounding whitespace from a normal PID file (a trailing newline, CRLF) is
 * stripped first; after that the *entire* remaining text must be a positive
 * decimal integer. Anything else — empty, whitespace-only, `0`, negative,
 * signed, fractional, exponential, hex/binary/octal, a numeric prefix with
 * trailing characters, out of safe-integer range, `Infinity`, `NaN` — yields
 * `undefined` and is never claimed.
 *
 * Deliberately not used: `parseInt` and `parseFloat` (both accept prefixes),
 * and any implicit numeric coercion. The lexical test comes first; `Number` is
 * only ever handed a string already known to be all digits.
 */
export function parseOwnedHelperPid(raw: string): number | undefined {
  const normalized = raw.trim();
  if (!POSITIVE_DECIMAL_INTEGER.test(normalized)) return undefined;
  const pid = Number(normalized);
  if (!isValidOwnedPid(pid)) return undefined; // e.g. 2^53 and above, Infinity
  return pid;
}

/** The `code` of an errno-style error, if it carries one. */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * A PID file that is simply not there. The helper never got far enough to
 * record a PID, which is a normal outcome and not a cleanup failure.
 */
function isMissingFile(error: unknown): boolean {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The process is already gone. Exactly what teardown wanted, so not a failure. */
function isAlreadyGone(error: unknown): boolean {
  return errnoOf(error) === 'ESRCH';
}

/** The seams teardown reaches the outside world through. */
export interface ExecCleanupDeps {
  /** Reads a PID file's raw contents. Throws like `readFileSync` does. */
  readonly readPidFile: (path: string) => string;
  /** Whether a PID is still live. */
  readonly isAlive: (pid: number) => boolean;
  /** Terminates a PID this test run owns. */
  readonly kill: (pid: number) => void;
  /** Removes a scratch directory recursively. */
  readonly removeDir: (dir: string) => void;
  /** Waits for Windows to release handles before the directories are removed. */
  readonly settle: (ms: number) => Promise<void>;
  /** How long that wait is. */
  readonly settleMs: number;
}

const REAL_DEPS: ExecCleanupDeps = Object.freeze({
  readPidFile: (path: string): string => readFileSync(path, 'utf8'),
  isAlive: (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  kill: (pid: number): void => {
    process.kill(pid, 'SIGKILL');
  },
  removeDir: (dir: string): void => {
    rmSync(dir, { recursive: true, force: true });
  },
  settle: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  settleMs: 50,
});

/**
 * Registry of everything one test created, plus the exhaustive teardown over it.
 *
 * Registration happens at the moment an artefact is *named*, before the helper
 * it belongs to even starts, so teardown reaches it on paths the test body never
 * runs to: an assertion thrown earlier, a test timeout inside `runCommand`, an
 * early return.
 */
export class ExecArtifactRegistry {
  private readonly deps: ExecCleanupDeps;
  private readonly tempDirs: string[] = [];
  private readonly pidFiles: string[] = [];
  private readonly pids: number[] = [];

  constructor(overrides: Partial<ExecCleanupDeps> = {}) {
    this.deps = { ...REAL_DEPS, ...overrides };
  }

  /** Registers a scratch directory for removal and hands it straight back. */
  registerTempDir(dir: string): string {
    this.tempDirs.push(dir);
    return dir;
  }

  /** Registers a PID file for the teardown sweep and hands the path back. */
  registerPidFile(path: string): string {
    this.pidFiles.push(path);
    return path;
  }

  /**
   * Registers a PID this test run owns, once. A PID already registered — by an
   * in-body claim or by an earlier sweep of the same file — is not added again,
   * so it is only ever acted on once.
   *
   * This is the lowest point every numeric registration passes through, so the
   * {@link isValidOwnedPid} check belongs here rather than at any one caller: a
   * value that is not a PID this run could own is dropped, and so never reaches
   * the liveness check or the kill in {@link cleanUp}. No caller has to have
   * validated first, and none can bypass it by not doing so
   * (AO-008-S1-R1-REREV-F1). Dropping is silent by design — a value that was
   * never a PID means there is nothing to clean up, which is not a teardown
   * failure.
   */
  registerPid(pid: number): void {
    if (!isValidOwnedPid(pid)) return;
    if (!this.pids.includes(pid)) this.pids.push(pid);
  }

  /**
   * Reads a PID file and registers the PID it holds.
   *
   * Called from a test body, so it never throws: an unreadable or invalid file
   * is simply not a claim. The teardown sweep uses {@link claimStrictly}
   * instead, which surfaces genuinely unexpected read errors for aggregation.
   */
  claimPid(pidFile: string): number | null {
    try {
      return this.claimStrictly(pidFile);
    } catch {
      return null;
    }
  }

  /** Snapshot of the PIDs currently registered for cleanup. */
  claimedPids(): readonly number[] {
    return [...this.pids];
  }

  /**
   * Runs the full teardown. Every phase is attempted in order, and every
   * individual operation inside a phase is isolated from every other, so one
   * failure can neither skip an artefact nor skip a later phase:
   *
   *   1. evaluate every registered PID file;
   *   2. register every valid PID found;
   *   3. terminate every de-duplicated PID this run owns;
   *   4. wait out the Windows handle release;
   *   5. remove every registered scratch directory;
   *   6. empty every internal collection;
   *   7. only then report.
   *
   * Each collection is detached before its own phase runs, so it ends up empty
   * whatever the phase does. Errors are collected rather than thrown at the
   * first occurrence and rather than swallowed; if any unexpected ones remain
   * once everything has been attempted, they are reported together.
   */
  async cleanUp(): Promise<void> {
    const errors: unknown[] = [];

    // 1 + 2. Last-resort claim over every registered PID file. This is what
    // covers a test that threw before its own in-body claim. A file that is
    // missing or holds an unusable value is not an error; anything else is.
    for (const pidFile of this.pidFiles.splice(0)) {
      try {
        this.claimStrictly(pidFile);
      } catch (error) {
        errors.push(error);
      }
    }

    // 3. Terminate this run's own helpers. A process that has already exited is
    // the outcome teardown wanted, not a failure.
    for (const pid of this.pids.splice(0)) {
      try {
        if (this.deps.isAlive(pid)) this.deps.kill(pid);
      } catch (error) {
        if (!isAlreadyGone(error)) errors.push(error);
      }
    }

    // 4. Windows keeps handles on the scripts for a moment after the processes
    // die; removing the directories immediately would fail for that reason
    // alone. A failure here must not skip the removals it exists to help.
    try {
      await this.deps.settle(this.deps.settleMs);
    } catch (error) {
      errors.push(error);
    }

    // 5. Every directory is attempted, including the ones after a failure.
    for (const dir of this.tempDirs.splice(0)) {
      try {
        this.deps.removeDir(dir);
      } catch (error) {
        errors.push(error);
      }
    }

    // 6. Already done: each `splice(0)` above detached its collection before
    // its loop could throw, so all three are empty on every path out of here.

    // 7. Report only now, and report all of it.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'exec test cleanup did not complete cleanly');
    }
  }

  /**
   * The claim itself. Returns `null` when there is nothing to claim — no file,
   * or contents that are not a PID this run may act on — and rethrows a read
   * error that is neither, for the caller to aggregate.
   */
  private claimStrictly(pidFile: string): number | null {
    let raw: string;
    try {
      raw = this.deps.readPidFile(pidFile);
    } catch (error) {
      if (isMissingFile(error)) return null; // The helper never recorded a PID.
      throw error;
    }
    const pid = parseOwnedHelperPid(raw);
    if (pid === undefined) return null; // Never killed, never registered.
    this.registerPid(pid);
    return pid;
  }
}
