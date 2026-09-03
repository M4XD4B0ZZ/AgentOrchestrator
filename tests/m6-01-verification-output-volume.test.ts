/**
 * M6 — a verification gate is judged by its exit code, not by how much it said.
 *
 * ── The defect, as it was measured rather than argued ──────────────────────
 *
 * Zera/HealthApp's canonical gate — `npm ci` then `npm run verify`, 260 Jest
 * files under `--runInBand` — **exits 0** and writes **62.8 MiB to stderr**,
 * 7.5x the 8 MiB verification budget and almost all of it the test suite's own
 * `console.log`. Under the coupled policy AO terminated that *passing* gate and
 * recorded:
 *
 * ```text
 * VERIFY  UNAVAILABLE  failure=OUTPUT_LIMIT_STDERR  148778 ms
 * stdout: (nothing recorded)
 * stderr: (nothing recorded)
 * ```
 *
 * Both excerpts empty, because what would have been recorded is exactly what
 * overflowed. Every retry produced the same ending, so no task in that
 * repository could ever reach `READY_FOR_PR` — and the closer a task came to
 * passing, the less classifiable it became: a task that fails early at
 * `format:check` yields a small readable refusal, a task that passes everything
 * yields an unreadable one.
 *
 * ── The two policies that were one ─────────────────────────────────────────
 *
 *   bounded observation      — how much of a stream this process holds in RAM.
 *                              Unchanged, always on, enforced by `BoundedSink`.
 *   termination on excess    — killing the child for being verbose. Right for an
 *                              ordinary command, wrong for a gate.
 *
 * They were the same switch. `terminateOnOutputLimit` separates them, defaults
 * to `true`, and exactly one caller in the build sets it `false`.
 *
 * ── What these cases are, and what they are not ────────────────────────────
 *
 * They spawn real processes with tiny budgets, because the claim is about what
 * a child is allowed to do and an injected result would only prove that a
 * function returns what it was handed. They do **not** re-measure Zera; that
 * replay is a separate, real-repository act recorded outside the suite.
 */
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isShellInertArgument, runCommand, type CommandResult } from '../src/doctor/exec.js';
import {
  runVerificationCommand,
  toVerificationCommandResult,
  VERIFICATION_COMMAND_MAX_OUTPUT_BYTES,
} from '../src/verify/verify-command.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';

/* ═══════════════════════ the noisy children ═════════════════════════════ */

/**
 * The noisy child, written to disk.
 *
 * On disk rather than behind `node -e`, and that is not a style choice:
 * `assertSafeArgs` refuses any argument outside `[A-Za-z0-9._:@=+\/-]`, so a
 * JavaScript program can never be an argument here. Its parameters come from
 * argv as inert tokens — a stream name and two integers — which is exactly the
 * shape that boundary permits. The first draft of this file used `node -e` and
 * every case failed on that refusal, which is the boundary doing its job.
 *
 * `process.exitCode` plus a natural end rather than `process.exit()`, so the
 * streams are flushed before the exit is reported. An abrupt exit would make a
 * passing case fail for a reason that has nothing to do with the gate.
 */
const NOISY_SOURCE = [
  'const [stream, chunks, code] = process.argv.slice(2);',
  "const line = 'x'.repeat(1023) + '\\n';",
  'for (let i = 0; i < Number(chunks); i += 1) process[stream].write(line);',
  'process.exitCode = Number(code);',
  '',
].join('\n');

const temporaryDirectories: string[] = [];

/**
 * Writes one child script and returns its path. Cleaned up in `afterAll`.
 *
 * `makeCanonicalTempDir` and not `mkdtempSync(tmpdir())`, and this file learned
 * that from CI rather than from reading: a GitHub Actions Windows runner reports
 * `C:\Users\RUNNER~1\AppData\Local\Temp`, an 8.3 alias, and `SAFE_ARG_PATTERN`
 * deliberately excludes `~`. The first version of this file used the raw call,
 * passed on a developer machine whose temp path has no alias, and failed nine of
 * its own cases on both CI runners with
 * `Refusing to spawn a diagnostic process with argument "...RUNNER~1..."`.
 *
 * The helper exists for exactly this and says so in its own header. The
 * assertion below keeps the lesson local, so a future edit that reaches for
 * `mkdtempSync` again fails here rather than on a runner.
 */
function scriptFile(name: string, source: string): string {
  const dir = makeCanonicalTempDir('ao-m6-');
  temporaryDirectories.push(dir);
  const file = join(dir, name);
  writeFileSync(file, source, 'utf8');
  expect(isShellInertArgument(file)).toBe(true);
  return file;
}

afterAll(() => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const KIB = 1024;

/** The budget every case below uses. Small, so a case costs milliseconds. */
const BUDGET = 4 * KIB;

/** How much the children write: comfortably past the budget, cheap to produce. */
const WRITTEN = 64 * KIB;

async function runNoisy(
  stream: 'stdout' | 'stderr',
  code: number,
  over: { readonly terminateOnOutputLimit?: boolean } = {},
): Promise<CommandResult> {
  return runCommand(
    'node',
    [scriptFile('noisy.cjs', NOISY_SOURCE), stream, String(WRITTEN / KIB), String(code)],
    {
      env: process.env,
      timeoutMs: 30_000,
      maxStdoutBytes: BUDGET,
      maxStderrBytes: BUDGET,
      ...over,
    },
  );
}

/* ═══ 1. A noisy PASSING gate is observed as passing ══════════════════════ */

describe('a verification gate that passes loudly is still a pass', () => {
  it.each(['stdout', 'stderr'] as const)(
    'reaches its own exit 0 on a flooded %s, and says how big the flood was',
    async (stream) => {
      const res = await runNoisy(stream, 0, { terminateOnOutputLimit: false });

      // The five things the operator asked to see proved, in one place.
      expect(res.exitCode).toBe(0);
      expect(res.outcome).toBe('COMPLETED');
      // Not terminated for being verbose. This is the assertion the whole slice
      // exists for: before M6 this was `OUTPUT_LIMIT_EXCEEDED`.
      expect(res.failureCode).toBeNull();

      const truncated = stream === 'stdout' ? res.stdoutTruncated : res.stderrTruncated;
      const observed = stream === 'stdout' ? res.stdoutBytesObserved : res.stderrBytesObserved;
      const retained = Buffer.byteLength(stream === 'stdout' ? res.stdout : res.stderr, 'utf8');

      expect(truncated).toBe(true);
      // `observed` is a fact about the stream and is NOT bounded by the budget.
      // A reading that stopped at the budget would be the number that tells an
      // operator nothing.
      expect(observed).toBeGreaterThanOrEqual(WRITTEN);
      // `retained` is a fact about memory and IS bounded. Bounded observation
      // never stopped being enforced.
      expect(retained).toBeLessThanOrEqual(BUDGET);
    },
  );

  it('is classified as a RAN verdict, which is what a task advances on', () => {
    // The mapping is where a `COMPLETED` process becomes a verdict, so an
    // assertion that stopped at `CommandResult` would leave the load-bearing
    // half untested.
    const passed = toVerificationCommandResult({
      outcome: 'COMPLETED',
      exitCode: 0,
      signal: null,
      stdout: 'x',
      stderr: 'y',
      stdoutTruncated: true,
      stderrTruncated: true,
      stdoutBytesObserved: 62_788_035,
      stderrBytesObserved: 0,
      failureCode: null,
      errnoCode: null,
      durationMs: 1,
    } as unknown as CommandResult);

    expect(passed.outcome).toBe('RAN');
    expect(passed.exitCode).toBe(0);
    expect(passed.outputTruncated).toBe(true);
    expect(passed.outputBytesObserved).toBe(62_788_035);
  });
});

/* ═══ 2. A noisy FAILING gate stays a failure ═════════════════════════════ */

describe('a verification gate that fails loudly is still a failure', () => {
  it.each(['stdout', 'stderr'] as const)(
    'reaches its own non-zero exit on a flooded %s',
    async (stream) => {
      const res = await runNoisy(stream, 2, { terminateOnOutputLimit: false });

      expect(res.outcome).toBe('COMPLETED');
      expect(res.exitCode).toBe(2);
      expect(res.failureCode).toBeNull();
      const truncated = stream === 'stdout' ? res.stdoutTruncated : res.stderrTruncated;
      expect(truncated).toBe(true);
    },
  );

  it('never becomes a pass because its output was truncated', () => {
    // The direction that matters. Truncation is a fact about the excerpt and
    // must not touch the verdict, and the verdict is the exit code.
    const failed = toVerificationCommandResult({
      outcome: 'COMPLETED',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'noise',
      stdoutTruncated: true,
      stderrTruncated: true,
      stdoutBytesObserved: 99_000_000,
      stderrBytesObserved: 99_000_000,
      failureCode: null,
      errnoCode: null,
      durationMs: 1,
    } as unknown as CommandResult);

    expect(failed.outcome).toBe('RAN');
    // Non-zero, so `runVerification` records a failure and the task reaches
    // BLOCKED_VERIFY. A build that read `outputTruncated` into the verdict would
    // have to change this line to pass.
    expect(failed.exitCode).toBe(1);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.outputTruncated).toBe(true);
  });
});

/* ═══ 3. The ordinary-command regression ══════════════════════════════════ */

describe('an ordinary command is still terminated for being verbose', () => {
  it.each(['stdout', 'stderr'] as const)(
    'kills a flooded %s when the option is absent, exactly as before M6',
    async (stream) => {
      const res = await runNoisy(stream, 0);

      expect(res.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
      expect(res.failureCode).toBe(
        stream === 'stdout' ? 'OUTPUT_LIMIT_STDOUT' : 'OUTPUT_LIMIT_STDERR',
      );
      // It did NOT reach its own exit. That is the property the default keeps.
      expect(res.exitCode).not.toBe(0);
    },
  );

  it('kills it just the same when the option is an explicit true', async () => {
    // Absence and an explicit `true` must be the same thing, so the guard is
    // `!== false` rather than a truthiness test that a stray `undefined` could
    // walk through in either direction.
    const res = await runNoisy('stdout', 0, { terminateOnOutputLimit: true });
    expect(res.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
  });
});

/* ═══ 4. Bounded observation is untouched ═════════════════════════════════ */

describe('memory stays bounded whatever the child writes', () => {
  it('retains at most the budget while observing far more', async () => {
    const res = await runNoisy('stdout', 0, { terminateOnOutputLimit: false });
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(BUDGET);
    expect(res.stdoutBytesObserved).toBeGreaterThan(BUDGET * 8);
  });

  it('counts bytes and not characters', async () => {
    // A multi-byte character makes the two differ. `Buffer.byteLength` is what
    // the sink uses; `.length` on a string would under-count here, and a byte
    // budget compared against characters is a mistake this repository has made
    // before in another file.
    const file = scriptFile(
      'wide.cjs',
      "process.stdout.write('\\u00e4'.repeat(4096));\nprocess.exitCode = 0;\n",
    );
    const res = await runCommand('node', [file], {
      env: process.env,
      timeoutMs: 30_000,
      maxStdoutBytes: BUDGET,
      terminateOnOutputLimit: false,
    });
    // 4096 two-byte characters: 8192 bytes observed, not 4096.
    expect(res.stdoutBytesObserved).toBe(8192);
  });
});

/* ═══ 5. Exactly one caller decouples, and it is the gate ═════════════════ */

describe('the decoupling is asked for in exactly one place', () => {
  it('is set by verify-command.ts and by nothing else in src/', () => {
    // A structural pin, in the spirit of the writer-argv pin: the danger is not
    // this call site, it is a second one appearing later without an argument.
    // `git grep` rather than a filesystem walk, so an untracked scratch file
    // cannot make this vacuous.
    const found = spawnSync(
      'git',
      ['grep', '-l', '--', 'terminateOnOutputLimit: false', 'src/'],
      { encoding: 'utf8' },
    );
    const files = (found.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\\/g, '/'))
      .filter((line) => line !== '');

    expect(files).toEqual(['src/verify/verify-command.ts']);
  });

  it('leaves the verification budget itself unchanged', () => {
    // The budget was never the problem and is not the fix. 8 MiB, as before.
    expect(VERIFICATION_COMMAND_MAX_OUTPUT_BYTES).toBe(8_388_608);
  });

  it('exposes a runner that still refuses an argument argv cannot hold', async () => {
    // The decoupling must not have widened what a verification command may be.
    const refused = await runVerificationCommand('node', ['--eval', 'x'], 'C:/no such dir');
    expect(['REFUSED_UNSAFE_ARGUMENT', 'UNAVAILABLE']).toContain(refused.outcome);
  });
});
