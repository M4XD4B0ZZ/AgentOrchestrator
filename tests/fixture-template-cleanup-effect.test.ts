/**
 * M1-RELEASE-009 — the memoised Git template really is removed, measured on disk.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * `M1-DOGFOOD-002` gave three heavy fixture files a root `afterAll` that removes
 * the one real Git repository each of them memoises as a template:
 *
 *  - `tests/v4-09-post-merge-verification.test.ts` (`ao-v409-template-`),
 *  - `tests/v4-10-delivery-completion.test.ts`     (`ao-v410-template-`),
 *  - `tests/v4-11-delivery-lifecycle-driver.test.ts` (`ao-v411-template-`).
 *
 * The behaviour is correct and **nothing measured it**. Measured on 2026-08-28
 * against `1f65578`: with all three hooks deleted those files still passed and
 * `tsc --noEmit` still exited 0, while the temporary directory gained one leaked
 * repository per file. A cleanup nothing can break is a cleanup that will be
 * broken silently.
 *
 * ── Why this cannot be a source-text check ──────────────────────────────────
 *
 * Reading those files for the word `afterAll` passes while the hook is present
 * and broken, which is the failure mode most worth catching. The subject here is
 * an **effect**: after a suite has genuinely finished, the template directory it
 * built is gone from disk.
 *
 * ── Why a child process is the only honest observer ─────────────────────────
 *
 * Each memo is module-private and each hook belongs to that file's own root
 * suite. Re-importing an already-loaded ES module does not re-run its top-level
 * registrations, and a fresh import would attach the hook to *this* file's suite
 * instead — so no in-process arrangement can make "that suite finished" happen,
 * let alone observe it. Running the file to completion in its own vitest process
 * can.
 *
 * ── The five constraints this design is built from ──────────────────────────
 *
 *  1. **One selected case per file, not the whole file.** The template is built
 *     on first use and removed by the file's own root `afterAll`, so both happen
 *     for a run that executes a single case. Re-running
 *     `v4-09-post-merge-verification.test.ts` in full would put back into the
 *     parallel gate exactly the real-Git churn `package.json` excludes it to
 *     avoid — 27 real repositories, measured at 107s on the CI runner — which is
 *     the cost that has to stay unpaid.
 *  2. **A private `TEMP`/`TMP` root per child, and that root is what is read.**
 *     Never a snapshot of the shared temporary directory: `v4-10` and `v4-11`
 *     run in the parallel gate, so a sibling worker can create and remove an
 *     identically-prefixed directory at the same moment and no snapshot could
 *     attribute a name to a run. A private root also makes whatever the machine
 *     already holds irrelevant, and gives each of the three targets its own
 *     directory so a leftover is attributable to exactly one child.
 *  3. **vitest is spawned directly, with no shell**, at
 *     `node_modules/vitest/vitest.mjs`. Whether this worktree has an installed
 *     `node_modules` is not asserted here — it is checked at run time, and its
 *     absence is reported as itself rather than as a bare `ENOENT`.
 *  4. **A timeout kills the process tree**, through the trusted `taskkill.exe`
 *     accessor in `src/doctor/internal/windows-system-tools.ts`. `close` does not
 *     wait on the immediate child alone; it waits on every descendant holding the
 *     same pipes, which for a vitest run means its pool workers.
 *  5. **The children run one after another**, each with `--no-file-parallelism`,
 *     with the captured output and the wall clock both bounded, and the private
 *     root is read **after** the child has closed — not polled while it runs.
 *     Points 1-4 are already the guard, so a poller would only add a race.
 *
 * ── Vacuous success, and the instrument against it ──────────────────────────
 *
 * A child that executes zero cases builds no template, so "nothing left behind"
 * would be trivially true. The definitive guard is the mutation set this file
 * exists for: deleting the cleanup from any one of the three files, or reducing
 * it to a no-op with the hook still registered, must fail `npm run verify`.
 *
 * As a standing guard against the selector silently drifting off a case, each
 * child also writes vitest's JSON report and this file counts the assertion
 * results that **passed and carry the selected case's name**. That is
 * deliberately not `numTotalTests`: measured on 2026-08-28, `numTotalTests`
 * reported 110 for `v4-11` under a name filter, because it counts tests
 * *collected*, not tests *run*, and a previous attempt failed on exactly that.
 *
 * ── What is not claimed ─────────────────────────────────────────────────────
 *
 * The budgets below are ceilings, not measurements: nothing in this pass was
 * executed, so no runtime for these three children is stated here. The ceiling
 * is sized to fail loudly rather than to describe a normal run. The cost is
 * real and is stated plainly instead: this file adds three sequential vitest
 * start-ups plus one small real-Git fixture each to the parallel gate.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { superviseWindowsTreeKill } from '../src/doctor/internal/windows-process-tree-termination.js';
import { windowsSystemTool } from '../src/doctor/internal/windows-system-tools.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const VITEST_ENTRY = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/**
 * The ceiling for one child, and the case ceiling that must sit above it so a
 * child that overruns is reported as *this* file's clear timeout rather than as
 * vitest's generic per-test one.
 *
 * The case ceiling has to clear the whole worst path, not just the child:
 * `PROBE_TIMEOUT_MS` + `CHILD_WALL_CLOCK_MS` + the supervisor's own
 * `WINDOWS_TREE_KILL_TIMEOUT_MS` + `KILL_GRACE_MS` = 280s. Anything below that
 * hands the ending back to vitest and loses the sentence that says why.
 */
const CHILD_WALL_CLOCK_MS = 240_000;
const CASE_TIMEOUT_MS = 320_000;

/**
 * Stage two of the termination deadline. `superviseWindowsTreeKill`'s own header
 * is explicit that a process which ignores the request can outlive the
 * settlement of the result it was started for — so the supervisor settling is
 * not the child dying, and something has to bound the wait afterwards.
 */
const KILL_GRACE_MS = 5_000;

/** Bounds for the synchronous private-`TEMP` probe and for captured output. */
const PROBE_TIMEOUT_MS = 30_000;
const OUTPUT_BUDGET_CHARS = 256 * 1024;

interface Target {
  /** The private sub-directory name; short, because these paths nest. */
  readonly label: string;
  /** Relative and forward-slashed, exactly as `package.json` spells such filters. */
  readonly file: string;
  /**
   * One case that reaches the file's `repositoryTemplate()` — through
   * `realRepo()` in `v4-09` and `v4-10`, through `fixture()` in `v4-11` — and
   * does as little else as possible. Free of regular-expression metacharacters,
   * because `-t` is a pattern rather than a literal.
   */
  readonly caseName: string;
  /** The template directory's prefix, from that file's `repositoryTemplate()`. */
  readonly prefix: string;
}

const TARGETS: readonly Target[] = Object.freeze([
  Object.freeze({
    label: 'v409',
    file: 'tests/v4-09-post-merge-verification.test.ts',
    caseName: 'never asks Git about a commit that is not an object name',
    prefix: 'ao-v409-template-',
  }),
  Object.freeze({
    label: 'v410',
    file: 'tests/v4-10-delivery-completion.test.ts',
    caseName: 'concludes the same when the base advanced past the merge',
    prefix: 'ao-v410-template-',
  }),
  Object.freeze({
    label: 'v411',
    file: 'tests/v4-11-delivery-lifecycle-driver.test.ts',
    caseName: 'refuses a task that has no durable record',
    prefix: 'ao-v411-template-',
  }),
]);

/** This file's own scratch space: one private `TEMP` root and one report per target. */
const WORK_ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-m1r009-')));

afterAll(() => {
  try {
    rmSync(WORK_ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover scratch directory is not a test failure */
  }
});

/**
 * The child's environment: everything this process has, with the temporary
 * directory redirected. Any existing spelling of `TEMP`/`TMP` is dropped first —
 * Windows environment blocks are case-insensitive, and handing `spawn` two keys
 * differing only in case is not a redirection anyone should have to reason about.
 */
function childEnvironment(tempRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper === 'TEMP' || upper === 'TMP') continue;
    environment[key] = value;
  }
  environment['TEMP'] = tempRoot;
  environment['TMP'] = tempRoot;
  return environment;
}

/**
 * That the redirection takes effect at all, measured in a real process rather
 * than assumed from the fact that the variables were set. Bounded, and the
 * assertion is that the probe was not *killed* — a `status` of 0 alone cannot
 * distinguish "answered" from "never got that far".
 */
function proveTemporaryDirectoryIsPrivate(tempRoot: string): void {
  const probe = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(require("node:os").tmpdir())'],
    {
      cwd: REPO_ROOT,
      env: childEnvironment(tempRoot),
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  expect(probe.error, 'the private-TEMP probe did not run to completion').toBeUndefined();
  expect(probe.status, 'the private-TEMP probe did not exit cleanly').toBe(0);
  expect(
    (probe.stdout ?? '').trim().toLowerCase(),
    'a child does not see the private temporary directory this measurement reads',
  ).toBe(tempRoot.toLowerCase());
}

interface ChildRun {
  /** `close` actually arrived: every pipe was closed and the tree was done. */
  readonly closed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The spawn itself failed — a message, never an object that could carry more. */
  readonly startError: string | null;
  readonly output: string;
}

/**
 * Releases an abandoned child from this process's event loop.
 *
 * `ChildProcess.unref()` is declared; `stdout`/`stderr` are `Readable | null`,
 * and `Readable` does **not** declare `unref` even though the pipe underneath is
 * a socket that has one. Two earlier attempts wrote `child.stdout?.unref?.()`
 * and died at `npm run typecheck` with `TS2339` before a single test ran, so the
 * cast is narrow and deliberate rather than `any`.
 */
function releaseChild(child: ChildProcess): void {
  try {
    child.unref();
  } catch {
    /* best effort: releasing a handle is not a termination and cannot fail this */
  }
  (child.stdout as { unref?: () => void } | null)?.unref?.();
  (child.stderr as { unref?: () => void } | null)?.unref?.();
}

/**
 * Runs one target file's one selected case in its own vitest process.
 *
 * Never rejects: every ending — a start failure, a non-zero exit, a timeout — is
 * a value the caller asserts on, so a broken child produces a sentence rather
 * than an unhandled rejection.
 */
function runTargetCase(target: Target, tempRoot: string, reportPath: string): Promise<ChildRun> {
  return new Promise<ChildRun>((settleRun) => {
    let settled = false;
    let closed = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let startError: string | null = null;
    let output = '';
    let wallClock: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    const child = spawn(
      process.execPath,
      [
        VITEST_ENTRY,
        'run',
        target.file,
        '-t',
        target.caseName,
        '--no-file-parallelism',
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: REPO_ROOT,
        env: childEnvironment(tempRoot),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      },
    );

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (wallClock !== undefined) clearTimeout(wallClock);
      if (grace !== undefined) clearTimeout(grace);
      // Settling without an observed `close` means this run is being abandoned
      // — the ceiling was reached, or the handle itself errored after a kill
      // was requested. A child that is still alive at that moment would keep
      // *this* file's process from exiting, so it is released here, at the one
      // point every abandonment passes through. A release is not a termination.
      if (!closed) releaseChild(child);
      settleRun({ closed, exitCode, timedOut, startError, output });
    };

    const absorb = (chunk: string): void => {
      if (output.length >= OUTPUT_BUDGET_CHARS) return;
      output = (output + chunk).slice(0, OUTPUT_BUDGET_CHARS);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);

    child.on('error', (error: Error) => {
      startError = error.message;
      settle();
    });

    child.on('close', (code: number | null) => {
      closed = true;
      exitCode = code;
      settle();
    });

    wallClock = setTimeout(() => {
      wallClock = undefined;
      // A close that races this timer is still reported as a timeout, on
      // purpose: at the ceiling the run is a failure either way.
      timedOut = true;

      const supervisor = superviseWindowsTreeKill(child.pid, {
        resolveToolPath: () => windowsSystemTool('taskkill.exe'),
        spawnTool: (file, args, options) => spawn(file, args, options),
        killImmediateChild: () => {
          try {
            child.kill();
          } catch {
            /* best effort; a throw is no more a failure signal than `false` is */
          }
        },
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (timer) => {
          clearTimeout(timer as NodeJS.Timeout);
        },
      });

      void supervisor.outcome.then(() => {
        if (settled) return;
        // The supervisor has settled, which is a *requested* kill and not an
        // observed death. Without this second bound an unkillable child would
        // leave this promise pending until vitest's own per-test timeout, and
        // the clear ceiling message below would be replaced by a generic one.
        grace = setTimeout(() => {
          grace = undefined;
          settle();
        }, KILL_GRACE_MS);
      });
    }, CHILD_WALL_CLOCK_MS);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function arrayAt(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) return [];
  const found = value[key];
  return Array.isArray(found) ? (found as readonly unknown[]) : [];
}

/**
 * How many assertion results in the child's JSON report both **passed** and
 * carry the selected case's name. Tests that were merely collected — everything
 * the name filter held back — are not counted, which is the whole point.
 */
function passedCasesNamed(reportPath: string, caseName: string): number {
  if (!existsSync(reportPath)) {
    throw new Error(
      `the child wrote no JSON report at ${reportPath}: the run cannot be shown to have ` +
        'executed the selected case, so its verdict about leftovers means nothing.',
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
  let passed = 0;
  for (const file of arrayAt(parsed, 'testResults')) {
    for (const assertion of arrayAt(file, 'assertionResults')) {
      if (!isRecord(assertion)) continue;
      if (assertion['status'] !== 'passed') continue;
      const fullName = assertion['fullName'];
      const title = assertion['title'];
      const named =
        (typeof fullName === 'string' && fullName.includes(caseName)) ||
        (typeof title === 'string' && title.includes(caseName));
      if (named) passed += 1;
    }
  }
  return passed;
}

function tail(output: string): string {
  const limit = 4_000;
  return output.length <= limit ? output : `...${output.slice(output.length - limit)}`;
}

describe('a memoised fixture template does not survive the suite that built it', () => {
  for (const target of TARGETS) {
    it(
      `removes ${target.prefix}* once ${target.file} has finished`,
      async () => {
        if (!existsSync(VITEST_ENTRY)) {
          throw new Error(
            `vitest is not installed at ${VITEST_ENTRY}. This measurement runs the target ` +
              'file in its own vitest process; without the installed runner it can measure ' +
              'nothing, and reporting that as a pass would be worse than failing here.',
          );
        }

        const home = join(WORK_ROOT, target.label);
        const tempRoot = join(home, 'temp');
        const reportPath = join(home, 'report.json');
        mkdirSync(tempRoot, { recursive: true });

        proveTemporaryDirectoryIsPrivate(tempRoot);

        const run = await runTargetCase(target, tempRoot, reportPath);

        expect(run.startError, `${target.file}: the vitest child could not be started`).toBeNull();
        expect(
          run.timedOut,
          `${target.file}: the vitest child did not finish within ${CHILD_WALL_CLOCK_MS}ms and ` +
            `its process tree was terminated\n${tail(run.output)}`,
        ).toBe(false);
        expect(run.closed, `${target.file}: the vitest child never closed`).toBe(true);
        expect(
          run.exitCode,
          `${target.file}: the vitest child did not pass\n${tail(run.output)}`,
        ).toBe(0);

        // The child really executed the case that builds the template, rather
        // than collecting it and running nothing.
        expect(
          passedCasesNamed(reportPath, target.caseName),
          `${target.file}: no passing case named "${target.caseName}" — the selector matched ` +
            'nothing, so "no template was left behind" would be vacuous',
        ).toBeGreaterThanOrEqual(1);

        // The effect, in the one directory only this child could write to.
        const leftovers = readdirSync(tempRoot).filter((entry) => entry.startsWith(target.prefix));
        expect(
          leftovers,
          `${target.file}: the memoised Git template survived a completed run of that suite. ` +
            `Its root \`afterAll\` is what removes ${target.prefix}*; found ` +
            `${JSON.stringify(leftovers)} under ${tempRoot}.`,
        ).toEqual([]);
      },
      CASE_TIMEOUT_MS,
    );
  }
});
