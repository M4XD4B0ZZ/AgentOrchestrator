/**
 * V3 slice 3 — the productive Windows runner, on the owned boundary.
 *
 * Slices 1 and 2 built the boundary and its adapter and wired them to nothing.
 * This slice makes `runCommand` reach them on Windows, which is the first time
 * anything productive obtains a contained process — so what this file pins is
 * not "the adapter classifies correctly" (that is
 * `tests/v3-02-owned-command.test.ts`, exhaustively) but the three things only
 * the integration can be wrong about:
 *
 *  1. **the dispatch**: a Windows command is created behind the boundary, and
 *     there is no second path. Not "usually" and not "when the boundary is
 *     available" — a boundary that cannot be established is reported as itself
 *     and nothing runs unowned;
 *  2. **the translation**: an `OwnedCommandResult` becomes a `CommandResult`
 *     without any of the adapter's failures being rounded to the nearest
 *     plausible success. `COMPLETED` is the only value a caller acts on as
 *     evidence, and it has exactly one source;
 *  3. **the contract**: everything `runCommand` promised before still holds —
 *     PATH resolution, `.cmd` routing, byte budgets, exit codes, the stdin
 *     vocabulary, `NOT_FOUND`, the unsafe-argument refusal.
 *
 * ── Two kinds of case, and why both are needed ─────────────────────────────
 *
 * The classification cases substitute the launch through `runCommand`'s
 * `dependencies.runOwned` seam, because the endings that matter most cannot be
 * provoked from a real command: a boundary that dies mid-run, a termination
 * that is never confirmed, an ending that contradicts itself. A seam proves the
 * classification and nothing else — it cannot show that a real command reaches
 * this path at all, and it cannot show that a real tree dies. Those are
 * measured by the real-process cases below, by `tests/exec.test.ts`, and by
 * `tests/dist-artifact/owned-command-dist-artifact.mjs` against the shipped
 * artefact.
 *
 * The real-process cases need a **built** boundary: `dist/native/ao-launch.exe`.
 * `npm run verify` builds before it tests, which is the gate these run under.
 */

import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  UnsafeArgumentError,
  runCommand,
  toCommandResultFields,
  type CommandOutcome,
  type CommandResult,
  type RunDependencies,
  type RunOptions,
} from '../src/doctor/exec.js';
import { startOwnedProcess } from '../src/boundary/start-owned-process.js';
import {
  OWNED_COMMAND_OUTCOMES,
  runOwnedCommand,
  type OwnedCommandFailureCode,
  type OwnedCommandOptions,
  type OwnedCommandOutcome,
  type OwnedCommandResult,
} from '../src/boundary/owned-command.js';
import { toAgentCommandResult } from '../src/agent/agent-command.js';
import { toVerificationCommandResult } from '../src/verify/verify-command.js';

const IS_WINDOWS = process.platform === 'win32';

const tempDirs: string[] = [];
function makeTempDir(prefix = 'ao-v303-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** The environment every case here gives a child. Nothing else is forwarded. */
const PROBE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '',
  PATHEXT: process.env['PATHEXT'] ?? '',
};

/** A newline, written the long way round so no escape survives an edit tool. */
const chr10Escape = (): string => String.fromCharCode(10);

/**
 * What `runCommand` would have built, for the two cases that call the adapter
 * directly.
 *
 * `runOwnedCommand` hands the helper exactly the block it is given and the
 * helper hands `CreateProcessW` exactly that — so `node` started with `PATH`
 * and `PATHEXT` alone does not run at all. The platform back-fill lives in
 * `runCommand`, which is where the environment contract lives; a case that
 * bypasses it has to supply the same thing itself.
 */
function fullEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...PROBE_ENV };
  for (const name of ['SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'WINDIR', 'USERPROFILE']) {
    const value = process.env[name];
    if (typeof value === 'string') env[name] = value;
  }
  return env;
}

/* ─────────────────────────── the substituted launch ─────────────────────── */

/**
 * A complete, valid `OwnedCommandResult`, overridable field by field.
 *
 * Built from a *successful* run deliberately. A factory whose default is a
 * failure would let a case that forgot to state its own outcome pass for the
 * wrong reason, and the whole point below is which inputs may become a
 * completion.
 */
function ownedResult(over: Partial<OwnedCommandResult> = {}): OwnedCommandResult {
  return Object.freeze({
    display: 'x',
    file: 'x',
    args: [],
    established: true,
    outcome: 'COMPLETED' as OwnedCommandOutcome,
    failureCode: null,
    exitCode: 0,
    boundaryFailureCode: null,
    boundaryLostReason: null,
    targetStarted: 'YES' as const,
    sideEffectsPossible: true,
    stdout: 'out',
    stderr: 'err',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdinDelivery: 'NOT_REQUESTED' as const,
    helperPid: 1,
    childPid: 2,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    durationMs: 0,
    retainedWorkDir: null,
    ending: null,
    ...over,
  });
}

interface Captured {
  readonly options: OwnedCommandOptions[];
}

/** A launch that never happens, recording what it was asked for. */
function stubLaunch(result: OwnedCommandResult): { deps: RunDependencies; captured: Captured } {
  const options: OwnedCommandOptions[] = [];
  return {
    captured: { options },
    deps: {
      runOwned: async (given) => {
        options.push(given);
        return result;
      },
    },
  };
}

/* ─────────────────────────── 1. the dispatch ────────────────────────────── */

describe.runIf(IS_WINDOWS)('a Windows command is created behind the boundary', () => {
  it('hands the resolved launch plan to runOwnedCommand, and resolves nothing twice', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'plan.cmd');
    writeFileSync(script, '@echo off\r\necho PLANNED\r\n', 'utf8');
    const { deps, captured } = stubLaunch(ownedResult());

    await runCommand(script, ['--json'], { env: PROBE_ENV, timeoutMs: 12_345 }, deps);

    expect(captured.options).toHaveLength(1);
    const plan = captured.options[0];
    // The `.cmd` route survives the move intact: the trusted, environment
    // independent cmd.exe, the doubled-quote `/d /s /c` form, and the verbatim
    // flag that stops the command line being re-quoted on the other side.
    expect(plan?.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(plan?.args?.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan?.args?.[3]).toContain(script);
    expect(plan?.verbatim).toBe(true);
    // And the boundary resolves nothing: the file it is given is already the
    // canonical answer, so PATH plays no part on the other side.
    expect(plan?.file).toBe(plan?.file.trim());
  });

  it('passes every budget through under the name that layer gives it', async () => {
    const { deps, captured } = stubLaunch(ownedResult());
    const dir = makeTempDir();
    const cwd = makeTempDir();

    await runCommand(
      process.execPath,
      ['--version'],
      {
        env: PROBE_ENV,
        cwd,
        timeoutMs: 4_242,
        maxStdoutBytes: 111,
        maxStderrBytes: 222,
        killGraceMs: 333,
        stdin: 'payload',
      },
      deps,
    );

    const plan = captured.options[0];
    expect(plan?.timeoutMs).toBe(4_242);
    expect(plan?.maxStdoutBytes).toBe(111);
    expect(plan?.maxStderrBytes).toBe(222);
    // The same option, renamed: `killGraceMs` and `terminationGraceMs` both
    // mean "how long termination gets before it is reported as unconfirmed".
    expect(plan?.terminationGraceMs).toBe(333);
    expect(plan?.cwd).toBe(cwd);
    expect(plan?.stdin).toBe('payload');
    expect(dir).toBeDefined();
  });

  it('applies the documented defaults, not the adapter’s own', async () => {
    const { deps, captured } = stubLaunch(ownedResult());
    await runCommand(process.execPath, ['--version'], { env: PROBE_ENV }, deps);
    const plan = captured.options[0];
    expect(plan?.timeoutMs).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(plan?.maxStdoutBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(plan?.maxStderrBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(plan?.terminationGraceMs).toBe(DEFAULT_KILL_GRACE_MS);
  });

  it('gives the child the environment libuv would have, and no more', async () => {
    // Not a widening and not a tightening: `child_process.spawn` on Windows
    // back-fills eleven OS variables into every child whatever block it is
    // given, and the helper does not. Reproducing that keeps one policy meaning
    // one thing on both paths — and without it `node` itself will not start.
    const { deps, captured } = stubLaunch(ownedResult());
    await runCommand(process.execPath, ['--version'], { env: { PATH: 'X' } }, deps);
    const env = captured.options[0]?.env ?? {};
    expect(env['PATH']).toBe('X');
    expect(env['SYSTEMROOT']).toBe(process.env['SYSTEMROOT']);
    expect(env['TEMP']).toBe(process.env['TEMP']);
    // Nothing outside the caller's own block and that fixed list.
    const allowed = new Set([
      'PATH',
      'HOMEDRIVE',
      'HOMEPATH',
      'LOGONSERVER',
      'SYSTEMDRIVE',
      'SYSTEMROOT',
      'TEMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
    ]);
    for (const name of Object.keys(env)) expect(allowed.has(name.toUpperCase())).toBe(true);
  });

  it('runs nothing at all when the launch is substituted — there is no second path', async () => {
    // The fail-closed claim as an observed absence. The command below would
    // create a file; the launch is replaced by one that refuses, and the file
    // must not exist. A fallback spawn would produce it.
    const dir = makeTempDir();
    const sentinel = join(dir, 'FALLBACK_RAN.txt');
    const script = join(dir, 'sentinel.cmd');
    writeFileSync(script, `@echo off\r\necho ran > "${sentinel}"\r\n`, 'utf8');
    const { deps } = stubLaunch(
      ownedResult({
        established: false,
        outcome: 'LAUNCH_REFUSED',
        failureCode: 'LAUNCH_REFUSED',
        exitCode: null,
        targetStarted: 'NO',
        sideEffectsPossible: false,
        stdout: '',
        stderr: '',
      }),
    );

    const result = await runCommand(script, [], { env: PROBE_ENV }, deps);

    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    expect(result.started).toBe(false);
    expect(() => readFileSync(sentinel)).toThrow();
  });

  it('decides NOT_FOUND before the boundary, and never launches for it', async () => {
    const { deps, captured } = stubLaunch(ownedResult());
    const result = await runCommand('ao-no-such-program-v303', [], { env: PROBE_ENV }, deps);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.failureCode).toBe('EXECUTABLE_NOT_FOUND');
    expect(result.started).toBe(false);
    // The ADR's five-member list omits `NOT_FOUND`; it survives because it
    // answers a different question, and because resolution stays on this side.
    expect(captured.options).toHaveLength(0);
  });

  it('refuses an unsafe argument before anything is planned or launched', async () => {
    const { deps, captured } = stubLaunch(ownedResult());
    await expect(
      runCommand(process.execPath, ['has a space'], { env: PROBE_ENV }, deps),
    ).rejects.toBeInstanceOf(UnsafeArgumentError);
    expect(captured.options).toHaveLength(0);
  });

  it('keeps UnsafeArgumentError the only exception, on this platform too', async () => {
    // `runOwnedCommand` re-throws one condition — a request the boundary's
    // transport cannot represent, such as an `=` inside an environment *name*.
    // It is a programming error exactly as an unsafe argument is, and it must
    // arrive as the same class: the three seams above catch
    // `UnsafeArgumentError` and re-throw everything else, so a second exception
    // type would escape on Windows and be a typed refusal on POSIX for the same
    // call.
    await expect(
      runCommand(process.execPath, ['--version'], {
        env: { PATH: process.env['PATH'] ?? '', 'BAD=NAME': 'x' },
      }),
    ).rejects.toBeInstanceOf(UnsafeArgumentError);
  });

  it('carries no part of the refused value in the message it throws', async () => {
    const secret = 'AO_V303_SECRET_ENV_VALUE';
    let message = '';
    try {
      await runCommand(process.execPath, ['--version'], {
        env: { PATH: process.env['PATH'] ?? '', 'BAD=NAME': secret },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);
    expect(message).not.toContain('BAD=NAME');
  });
});

describe.skipIf(IS_WINDOWS)('POSIX keeps the path it had', () => {
  it('never reaches the owned boundary', async () => {
    const { deps, captured } = stubLaunch(ownedResult());
    const result = await runCommand(process.execPath, ['--version'], { env: process.env }, deps);
    // The ADR decides Windows containment and explicitly decides nothing about
    // POSIX, so this platform still spawns here and terminates by process
    // group. A launch reaching the boundary would be an undecided change.
    expect(captured.options).toHaveLength(0);
    expect(result.outcome).toBe('COMPLETED');
  });
});

/* ────────────────────── 2. the translation, in full ─────────────────────── */

describe('an owned result becomes a CommandResult without gaining a success', () => {
  const OUTCOME: Readonly<Record<OwnedCommandOutcome, CommandOutcome>> = {
    COMPLETED: 'COMPLETED',
    TIMED_OUT: 'TIMED_OUT',
    OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
    LAUNCH_REFUSED: 'SPAWN_FAILED',
    BOUNDARY_LOST: 'BOUNDARY_LOST',
    TERMINATED_BY_CALLER: 'BOUNDARY_LOST',
  };

  it('maps every declared outcome, and the table is not a completeness claim', () => {
    // Value by value rather than by `satisfies`: a table that types correctly
    // and answers `COMPLETED` in every row would satisfy the compiler.
    for (const outcome of OWNED_COMMAND_OUTCOMES) {
      const failureCode: OwnedCommandFailureCode | null =
        outcome === 'COMPLETED'
          ? null
          : outcome === 'TIMED_OUT'
            ? 'TIMEOUT'
            : outcome === 'OUTPUT_LIMIT_EXCEEDED'
              ? 'OUTPUT_LIMIT_STDOUT'
              : outcome === 'LAUNCH_REFUSED'
                ? 'LAUNCH_REFUSED'
                : outcome === 'TERMINATED_BY_CALLER'
                  ? 'TERMINATED_BY_CALLER'
                  : 'BOUNDARY_LOST';
      const mapped = toCommandResultFields(
        ownedResult({ outcome, failureCode, exitCode: outcome === 'COMPLETED' ? 0 : null }),
      );
      expect(mapped.outcome).toBe(OUTCOME[outcome]);
    }
    // And the enumeration really covered the union rather than a subset of it.
    expect(new Set(OWNED_COMMAND_OUTCOMES)).toEqual(new Set(Object.keys(OUTCOME)));
  });

  it('collapses every way of losing the boundary into BOUNDARY_LOST, and nothing else', () => {
    const lossCodes: OwnedCommandFailureCode[] = [
      'BOUNDARY_LOST',
      'BOUNDARY_TERMINATION_UNCONFIRMED',
      'BOUNDARY_STREAMS_UNAVAILABLE',
      'ENDING_INCONSISTENT',
    ];
    for (const failureCode of lossCodes) {
      const mapped = toCommandResultFields(
        ownedResult({ outcome: 'BOUNDARY_LOST', failureCode, exitCode: null }),
      );
      expect(mapped.outcome).toBe('BOUNDARY_LOST');
      expect(mapped.failureCode).toBe('BOUNDARY_LOST');
      // Not any of its neighbours. Each of these would be a different claim.
      expect(mapped.outcome).not.toBe('COMPLETED');
      expect(mapped.outcome).not.toBe('TIMED_OUT');
      expect(mapped.outcome).not.toBe('SPAWN_FAILED');
      expect(mapped.failureCode).not.toBe('PROCESS_TREE_KILL_FAILED');
    }
  });

  it('keeps a timeout a timeout when the boundary confirmed the termination', () => {
    const mapped = toCommandResultFields(
      ownedResult({ outcome: 'TIMED_OUT', failureCode: 'TIMEOUT', exitCode: null }),
    );
    expect(mapped.outcome).toBe('TIMED_OUT');
    expect(mapped.failureCode).toBe('TIMEOUT');
  });

  it('does not let an unconfirmed termination pass as a timeout', () => {
    // The dangerous direction, and the reason the two are different words: a
    // helper still alive holds a job this process can no longer account for.
    // `TIMED_OUT` would assert a tree was taken down that demonstrably was not.
    const mapped = toCommandResultFields(
      ownedResult({
        outcome: 'BOUNDARY_LOST',
        failureCode: 'BOUNDARY_TERMINATION_UNCONFIRMED',
        exitCode: null,
      }),
    );
    expect(mapped.outcome).toBe('BOUNDARY_LOST');
    expect(mapped.outcome).not.toBe('TIMED_OUT');
  });

  it('reports each output budget under its own stream’s code', () => {
    for (const [failureCode, expected] of [
      ['OUTPUT_LIMIT_STDOUT', 'OUTPUT_LIMIT_STDOUT'],
      ['OUTPUT_LIMIT_STDERR', 'OUTPUT_LIMIT_STDERR'],
    ] as const) {
      const mapped = toCommandResultFields(
        ownedResult({ outcome: 'OUTPUT_LIMIT_EXCEEDED', failureCode, exitCode: null }),
      );
      expect(mapped.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
      expect(mapped.failureCode).toBe(expected);
    }
  });

  it('refuses a completion that the adapter itself could not have produced', () => {
    // Defence in depth, and stated here on purpose: this is where a completion
    // crosses out of the module whose enumerated tests cover it into the one
    // every agent, verification and Git seam reads.
    for (const broken of [
      { established: false },
      { exitCode: null },
      { failureCode: 'BOUNDARY_LOST' as OwnedCommandFailureCode },
    ]) {
      const mapped = toCommandResultFields(ownedResult({ outcome: 'COMPLETED', ...broken }));
      expect(mapped.outcome).toBe('BOUNDARY_LOST');
      expect(mapped.failureCode).toBe('BOUNDARY_LOST');
      expect(mapped.exitCode).toBeNull();
    }
  });

  it('fails closed on an outcome or a failure code this build does not declare', () => {
    // Reachable from anything not type checked against this build — the `.mjs`
    // dist harness, a JS consumer, a serialisation boundary. Indexing the
    // tables with it yields `undefined`, which is neither a completion nor a
    // declared failure and throws nothing: fail-*open* in the one translation
    // that must fail closed.
    const strangeOutcome = toCommandResultFields(
      ownedResult({ outcome: 'ASCENDED' as OwnedCommandOutcome }),
    );
    expect(strangeOutcome.outcome).toBe('BOUNDARY_LOST');
    const strangeCode = toCommandResultFields(
      ownedResult({ outcome: 'TIMED_OUT', failureCode: 'MYSTERY' as OwnedCommandFailureCode }),
    );
    expect(strangeCode.outcome).toBe('BOUNDARY_LOST');
  });

  it('answers "did it start?" conservatively, exactly as the ADR requires', () => {
    // A refusal is not proof that nothing ran: in JOBLIST mode the target
    // executes from its first instruction, so a loss between then and the
    // membership confirmation refuses a launch that had already started.
    const refusal = (targetStarted: 'NO' | 'YES' | 'UNKNOWN'): CommandResult['started'] =>
      toCommandResultFields(
        ownedResult({
          established: false,
          outcome: 'LAUNCH_REFUSED',
          failureCode: 'LAUNCH_REFUSED',
          exitCode: null,
          targetStarted,
        }),
      ).started;
    expect(refusal('NO')).toBe(false);
    expect(refusal('YES')).toBe(true);
    expect(refusal('UNKNOWN')).toBe(true);
  });

  it('reports no best-effort tree kill, because none was attempted', () => {
    // The legacy field keeps its legacy meaning: a best-effort mechanism
    // reported success. Behind the boundary none runs, so the honest answer is
    // `false` — and re-pointing the boolean at kernel ownership would hand
    // every existing reader a guarantee the word never carried.
    for (const outcome of OWNED_COMMAND_OUTCOMES) {
      const mapped = toCommandResultFields(
        ownedResult({ outcome, exitCode: outcome === 'COMPLETED' ? 0 : null }),
      );
      expect(mapped.processTreeKilled).toBe(false);
    }
  });

  it('carries the output and the stdin verdict across unchanged', () => {
    const mapped = toCommandResultFields(
      ownedResult({
        stdout: 'A',
        stderr: 'B',
        stdoutTruncated: true,
        stderrTruncated: true,
        stdinDelivery: 'UNCONFIRMED',
      }),
    );
    expect(mapped.stdout).toBe('A');
    expect(mapped.stderr).toBe('B');
    expect(mapped.stdoutTruncated).toBe(true);
    expect(mapped.stderrTruncated).toBe(true);
    expect(mapped.stdinDelivery).toBe('UNCONFIRMED');
    // Two fields the owned path has no channel for, reported as absent rather
    // than as a translated guess.
    expect(mapped.signal).toBeNull();
    expect(mapped.errnoCode).toBeNull();
  });
});

/* ─────────────────── 3. what the seams above make of it ─────────────────── */

describe('a lost boundary is not usable evidence downstream', () => {
  function commandResult(over: Partial<CommandResult>): CommandResult {
    return {
      display: 'x',
      executable: 'x',
      args: [],
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      durationMs: 0,
      ...toCommandResultFields(ownedResult()),
      ...over,
    };
  }

  it('never becomes RAN at the agent seam', () => {
    const agent = toAgentCommandResult(
      commandResult({
        outcome: 'BOUNDARY_LOST',
        failureCode: 'BOUNDARY_LOST',
        exitCode: null,
        stdout: 'a plausible-looking transcript',
      }),
    );
    expect(agent.outcome).toBe('UNAVAILABLE');
    expect(agent.outcome).not.toBe('RAN');
    // And the agent's own words do not survive: a run whose boundary was lost
    // said nothing this repository is entitled to read.
    expect(agent.stdout).toBe('');
  });

  it('never becomes RAN at the verification seam', () => {
    const verify = toVerificationCommandResult(
      commandResult({
        outcome: 'BOUNDARY_LOST',
        failureCode: 'BOUNDARY_LOST',
        exitCode: 0,
        stdout: 'all tests passed',
      }),
    );
    expect(verify.outcome).toBe('UNAVAILABLE');
    expect(verify.outcome).not.toBe('RAN');
    // The exit code is carried for a human, but it is not a verdict: an exit
    // code from a run whose supervision was lost is not a verdict at all.
    expect(verify.failureCode).toBe('BOUNDARY_LOST');
  });

  it('keeps a real completion usable at both seams', () => {
    const ran = commandResult({ outcome: 'COMPLETED', failureCode: null, exitCode: 0 });
    expect(toAgentCommandResult(ran).outcome).toBe('RAN');
    expect(toVerificationCommandResult(ran).outcome).toBe('RAN');
  });
});

/* ──────────────────── 4. the delay contract, both platforms ─────────────── */

describe('an over-large or unusable delay is a documented value, not a coercion', () => {
  async function planFor(options: Partial<RunOptions>): Promise<OwnedCommandOptions | undefined> {
    const { deps, captured } = stubLaunch(ownedResult());
    await runCommand(process.execPath, ['--version'], { env: PROBE_ENV, ...options }, deps);
    return captured.options[0];
  }

  it.runIf(IS_WINDOWS)('clamps Infinity to the largest expressible timer', async () => {
    // Before V3 slice 3 the two runners disagreed about this exact value:
    // measured, `runCommand` with `timeoutMs: Infinity` fired at **1 ms**,
    // because node turns an over-large delay into one and nothing clamped it,
    // while the owned adapter clamped to ~24.8 days. "Effectively never" and
    // "immediately" from one argument, decided by which mechanism ran it.
    const plan = await planFor({ timeoutMs: Number.POSITIVE_INFINITY });
    expect(plan?.timeoutMs).toBe(2_147_483_647);
    expect(plan?.timeoutMs).not.toBe(1);
  });

  it.runIf(IS_WINDOWS)('falls back to the default for a value that is not a budget', async () => {
    for (const timeoutMs of [Number.NaN, -1, '20000' as unknown as number, null as unknown as number]) {
      const plan = await planFor({ timeoutMs });
      expect(plan?.timeoutMs).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    }
  });

  it.runIf(IS_WINDOWS)('keeps zero meaning zero', async () => {
    const plan = await planFor({ timeoutMs: 0 });
    expect(plan?.timeoutMs).toBe(0);
  });

  it.runIf(IS_WINDOWS)('honours an unbounded byte budget, and never clamps one to a timer', async () => {
    const plan = await planFor({ maxStdoutBytes: Number.POSITIVE_INFINITY });
    expect(plan?.maxStdoutBytes).toBe(Number.POSITIVE_INFINITY);
  });

  it.runIf(IS_WINDOWS)('refuses an unbounded grace, which is the absence of the guarantee', async () => {
    const plan = await planFor({ killGraceMs: Number.POSITIVE_INFINITY });
    expect(plan?.terminationGraceMs).toBe(DEFAULT_KILL_GRACE_MS);
  });

  it('does not fire an Infinity timeout immediately on either platform', async () => {
    // The behaviour, not only the number handed on: this is the case the old
    // path failed, and it is cheap to state directly.
    const started = Date.now();
    const result = await runCommand(process.execPath, ['--version'], {
      env: PROBE_ENV,
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    expect(result.outcome).toBe('COMPLETED');
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

/* ───────────────────── 5. real commands, through the boundary ───────────── */

describe.runIf(IS_WINDOWS)('the real productive path, end to end', () => {
  it('preserves exit 0 and a representative set of non-zero exits', async () => {
    const dir = makeTempDir();
    for (const code of [0, 1, 3, 42, 255]) {
      // A script rather than `-e`: `SAFE_ARG_PATTERN` excludes parentheses, so
      // the expression is not expressible as an argv token here at all — which
      // is the argument allow-list doing its job, not an obstacle to route
      // around.
      const script = join(dir, `exit-${code}.cjs`);
      writeFileSync(script, `process.exit(${code});\n`, 'utf8');
      const result = await runCommand(process.execPath, [script], {
        env: PROBE_ENV,
        timeoutMs: 30_000,
      });
      expect(result.outcome).toBe('COMPLETED');
      expect(result.exitCode).toBe(code);
      expect(result.failureCode).toBeNull();
      expect(result.signal).toBeNull();
    }
  }, 60_000);

  it('keeps stdout and stderr separate', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'both.cjs');
    writeFileSync(script, "process.stdout.write('OUT');process.stderr.write('ERR');\n", 'utf8');
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      timeoutMs: 30_000,
    });
    expect(result.stdout).toBe('OUT');
    expect(result.stderr).toBe('ERR');
  }, 30_000);

  it('cuts stdout at its budget and says which stream it was', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'flood-out.cjs');
    writeFileSync(
      script,
      "const l='A'.repeat(1024)+'\\n';setInterval(function(){for(let i=0;i<64;i++)process.stdout.write(l);},5);\n",
      'utf8',
    );
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      timeoutMs: 60_000,
      maxStdoutBytes: 4_096,
    });
    expect(result.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(result.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(4_096);
  }, 60_000);

  it('cuts stderr at its own budget', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'flood-err.cjs');
    writeFileSync(
      script,
      "const l='B'.repeat(1024)+'\\n';setInterval(function(){for(let i=0;i<64;i++)process.stderr.write(l);},5);\n",
      'utf8',
    );
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      timeoutMs: 60_000,
      maxStderrBytes: 2_048,
    });
    expect(result.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(result.failureCode).toBe('OUTPUT_LIMIT_STDERR');
    expect(result.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBe(2_048);
  }, 60_000);

  it('terminates a hung command through the boundary and calls it a timeout', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'hang.cjs');
    writeFileSync(script, 'setInterval(function () {}, 1000);\n', 'utf8');
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      timeoutMs: 1_500,
    });
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('TIMEOUT');
    // Not a lost boundary: the helper was asked to die and confirmed it did.
    expect(result.outcome).not.toBe('BOUNDARY_LOST');
    expect(result.processTreeKilled).toBe(false);
  }, 30_000);

  it('runs in the cwd it was given, never in process.cwd()', async () => {
    const dir = makeTempDir();
    const elsewhere = makeTempDir('ao-v303-cwd-');
    const script = join(dir, 'cwd.cjs');
    writeFileSync(script, 'process.stdout.write(process.cwd());\n', 'utf8');
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      cwd: elsewhere,
      timeoutMs: 30_000,
    });
    expect(result.outcome).toBe('COMPLETED');
    expect(result.stdout.trim().toLowerCase()).toBe(elsewhere.toLowerCase());
  }, 30_000);

  it('gives the child exactly the variables it was told to, plus the platform’s', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'env.cjs');
    writeFileSync(script, 'process.stdout.write(JSON.stringify(Object.keys(process.env)));\n', 'utf8');
    const sentinel = 'AO_V303_SENTINEL_NOT_FORWARDED';
    process.env[sentinel] = 'x';
    let keys: string[];
    try {
      const result = await runCommand(process.execPath, [script], {
        env: PROBE_ENV,
        timeoutMs: 30_000,
      });
      expect(result.outcome).toBe('COMPLETED');
      keys = JSON.parse(result.stdout) as string[];
    } finally {
      delete process.env[sentinel];
    }
    expect(keys.map((k) => k.toUpperCase())).toContain('PATH');
    expect(keys.map((k) => k.toUpperCase())).not.toContain(sentinel);
  }, 30_000);

  it('runs a .cmd through the trusted interpreter with its argument intact', async () => {
    const dir = makeTempDir('ao v303 spaced ');
    const script = join(dir, 'echoarg.cmd');
    writeFileSync(script, '@echo off\r\necho ARG=%~1\r\n', 'utf8');
    const result = await runCommand(script, ['--json'], { env: PROBE_ENV, timeoutMs: 30_000 });
    expect(result.outcome).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
    // `%~1` is the value a real shim's own logic sees, so this is the semantic
    // argument rather than the codec's quoting.
    expect(result.stdout).toContain('ARG=--json');
  }, 30_000);

  it('reports no payload as NOT_REQUESTED, and the child still sees end-of-file', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'eof.cjs');
    writeFileSync(
      script,
      "let n=0;process.stdin.on('data',function(c){n+=c.length;});process.stdin.on('end',function(){process.stdout.write('EOF:'+n);});process.stdin.resume();\n",
      'utf8',
    );
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      timeoutMs: 30_000,
    });
    expect(result.stdinDelivery).toBe('NOT_REQUESTED');
    expect(result.stdout).toBe('EOF:0');
  }, 30_000);

  it('reports DELIVERED only for a payload the boundary proved it forwarded', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'read.cjs');
    writeFileSync(
      script,
      "let s='';process.stdin.on('data',function(c){s+=c;});process.stdin.on('end',function(){process.stdout.write('GOT:'+s.length);});process.stdin.resume();\n",
      'utf8',
    );
    const payload = 'x'.repeat(4096);
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      timeoutMs: 30_000,
      stdin: payload,
    });
    expect(result.outcome).toBe('COMPLETED');
    expect(result.stdout).toBe(`GOT:${payload.length}`);
    expect(result.stdinDelivery).toBe('DELIVERED');
  }, 30_000);

  it('never reports DELIVERED for a child that exits without reading', async () => {
    // The boundary's own report is the evidence here, and it is the only
    // evidence there is: the pipe this process writes into belongs to the
    // helper, so a child closing its read end early does not break it.
    const dir = makeTempDir();
    const script = join(dir, 'noread.cjs');
    writeFileSync(script, "process.stdout.write('DONE');process.exit(0);\n", 'utf8');
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      timeoutMs: 30_000,
      stdin: 'y'.repeat(2_000_000),
    });
    expect(result.stdinDelivery).not.toBe('DELIVERED');
    expect(['FAILED', 'UNCONFIRMED']).toContain(result.stdinDelivery);
  }, 30_000);

  it('reports a conservative stdin state for a run terminated mid-transfer', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'slow.cjs');
    writeFileSync(script, 'setInterval(function () {}, 1000);\n', 'utf8');
    const result = await runCommand(process.execPath, [script], {
      env: PROBE_ENV,
      timeoutMs: 1_500,
      stdin: 'z'.repeat(8_000_000),
    });
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.stdinDelivery).not.toBe('DELIVERED');
  }, 30_000);
});

/* ─────────── 6. the two races the productive path exposed ───────────────── */

describe.runIf(IS_WINDOWS)('a short-lived child’s output survives a slow establishment', () => {
  it('captures everything a child wrote before the caller was told it had started', async () => {
    // A counter-proof for the second defect the productive path exposed, made
    // deterministic rather than left to chance.
    //
    // A child can finish before `startOwnedProcess` returns: the establishment
    // poll then reads a *final* status. Until V3 slice 3 the adapter attached
    // its output listeners only after that return, and node — with nothing
    // reading the pipe — had already ended and destroyed the stream, taking its
    // buffered bytes with it. The run came back `COMPLETED`, exit code 0,
    // `stdout: ''`: indistinguishable from a command that printed nothing.
    // Measured at 4 of 60 identical `.cmd` runs, and `repo/git-query.ts` reads
    // a repository's identity out of exactly such a string.
    //
    // The delay below is not a simulation of load: it makes the window that was
    // being lost to chance wider than any scheduling jitter, so a listener
    // attached after establishment cannot see the output and one attached in
    // the same tick as the spawn must.
    const dir = makeTempDir();
    const script = join(dir, 'quick.cjs');
    writeFileSync(script, "process.stdout.write('QUICK');" + chr10Escape(), 'utf8');

    const result = await runOwnedCommand(
      { file: process.execPath, args: [script], env: fullEnv(), timeoutMs: 30_000 },
      {
        start: async (request) => {
          const started = await startOwnedProcess(request);
          await new Promise((done) => setTimeout(done, 250));
          return started;
        },
      },
    );

    expect(result.outcome).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('QUICK');
  }, 60_000);

  it('honours a budget blown before there was a boundary to terminate', async () => {
    // The other half of attaching the sinks in the same tick as the spawn: they
    // can now fill — and overflow — while `startOwnedProcess` is still polling
    // for a status, which is *before* there is anything to terminate. The
    // reason is remembered and applied the moment termination becomes possible.
    //
    // Without that, the two available answers are both wrong: dropping the
    // reason leaves a stream nothing bounds, and calling a `terminate` that
    // does not exist yet throws out of the one path that must not.
    //
    // Same delayed establishment as the case above, and the same reason for it:
    // it makes a window that would otherwise be a race into a certainty.
    const dir = makeTempDir();
    const script = join(dir, 'flood-early.cjs');
    writeFileSync(
      script,
      "const l='C'.repeat(4096);for(let i=0;i<64;i++)process.stdout.write(l);setInterval(function(){},1000);" +
        chr10Escape(),
      'utf8',
    );

    const result = await runOwnedCommand(
      {
        file: process.execPath,
        args: [script],
        env: fullEnv(),
        maxStdoutBytes: 64,
        timeoutMs: 60_000,
      },
      {
        start: async (request) => {
          const started = await startOwnedProcess(request);
          await new Promise((done) => setTimeout(done, 400));
          return started;
        },
      },
    );

    expect(result.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(result.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(64);
    // And the child really was ended by it rather than left running: this
    // fixture never exits on its own.
    expect(result.outcome).not.toBe('BOUNDARY_LOST');
  }, 90_000);
});

/* ─────────── 6b. a refusal is not waited on ──────────────────────────────── */

describe('a refusal after establishment does not wait on the helper’s pipes', () => {
  it('returns at once rather than draining a stream a live helper may hold', async () => {
    // The drain added above waits for the output streams before reading the
    // sinks, and *which* endings may be waited on is a decision rather than a
    // detail. `BOUNDARY_REFUSED` after establishment has two producers, and one
    // of them — node emitting `error` on the child process when a **kill**
    // fails, not only when a spawn does — arrives with the helper possibly
    // still running and still holding these pipes.
    //
    // Waiting there is the deadlock shape this repository already has a name
    // for: the pipe you wait on is held by the survivor you are counting. The
    // run would have stalled for the whole grace window on a boundary it had
    // just declared unaccounted for — five seconds by default, and up to
    // whatever a caller passed.
    //
    // Driven against a substituted launch, because a failed kill cannot be
    // provoked from a real one. The streams below never end, so a drain that is
    // not excluded here cannot finish before its bound.
    const { PassThrough } = await import('node:stream');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.resume();

    const started = Date.now();
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', terminationGraceMs: 30_000, timeoutMs: 60_000 },
      {
        start: async () =>
          ({
            established: true,
            process: {
              helper: { stdout, stderr, stdin, unref: () => undefined, kill: () => true },
              helperPid: 1,
              childPid: 2,
              mode: 'JOBLIST',
              assignedAtCreation: true,
              verifiedInJob: true,
              jobMembersAtStart: 1,
              workDir: 'C:\\nowhere',
              terminate: () => undefined,
              // The failed-kill shape: a refusal, reported for a run whose
              // ownership had already been established.
              ending: Promise.resolve({
                ending: 'BOUNDARY_REFUSED',
                failureCode: 'BOUNDARY_HELPER_SPAWN_FAILED',
                win32: null,
                targetStarted: 'YES',
                status: null,
              }),
              dispose: () => undefined,
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
      },
    );
    const elapsed = Date.now() - started;

    // Contradictory, and classified as such — that part is slice 2's.
    expect(result.outcome).toBe('BOUNDARY_LOST');
    // What this case is about: it came back, and it came back promptly. The
    // grace above is 30s; anything near it means the drain was entered.
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);
});

/* ─────────── 7. the publish race the productive path exposed ─────────────── */

describe.runIf(IS_WINDOWS)('the boundary publishes its final status even under a reader', () => {
  it('does not lose a completed run to a caller holding the status file open', async () => {
    // A counter-proof for the defect the productive path exposed, and a
    // deterministic one rather than a statistical one.
    //
    // The helper publishes by atomic rename. The caller polls that same file to
    // learn that ownership holds — and a file node has open for reading cannot
    // be replaced, because a plain read handle carries no FILE_SHARE_DELETE.
    // The rename then failed, the staging file was deleted, and the child's
    // exit code was never published: the caller read a status frozen at
    // establishment and reported `BOUNDARY_LOST / NO_CHILD_EXIT_OBSERVED` for a
    // run that had completed normally with exit code 0. Measured at 3 of 320
    // fast commands under eight-way concurrency before the publish learned to
    // retry.
    //
    // Here the race is not raced: the status file is held open for longer than
    // one attempt and released well inside the retry budget, so a publish that
    // does not retry cannot land and a publish that does must.
    const workDir = makeTempDir('ao-v303-status-');
    const statusPath = join(workDir, 'status.txt');
    mkdirSync(workDir, { recursive: true });

    let held: number | undefined;
    const holdStatusOpen = (): void => {
      // Opened as soon as the file exists — which is the establishment write,
      // the one the caller's own poll would have been holding.
      const attempt = (): void => {
        if (held !== undefined) return;
        try {
          held = openSync(statusPath, 'r');
        } catch {
          setTimeout(attempt, 1).unref?.();
        }
      };
      attempt();
    };
    holdStatusOpen();
    // Released after 200 ms: far longer than a single failed attempt, and far
    // inside the helper's two-second retry budget. Both margins are wide on
    // purpose — the release runs on this worker's own event loop, and a
    // parallel gate can delay a timer by a great deal more than the delay it
    // was given. This case failed exactly that way once, with the budget an
    // order of magnitude smaller.
    setTimeout(() => {
      if (held !== undefined) closeSync(held);
      held = undefined;
    }, 200).unref?.();

    const script = join(workDir, 'publish.cjs');
    writeFileSync(script, "process.stdout.write('PUBLISHED');\n", 'utf8');
    // Driven through `runCommand` with a delegating seam rather than by calling
    // the adapter directly: the working directory has to be this test's, so
    // that the status file can be held open by name — and the environment has
    // to be the one the productive path builds, or `node` will not start at
    // all with `PATH` and `PATHEXT` alone.
    const result = await runCommand(
      process.execPath,
      [script],
      { env: PROBE_ENV, timeoutMs: 30_000 },
      { runOwned: async (options) => await runOwnedCommand({ ...options, workDir }) },
    );

    if (held !== undefined) closeSync(held);
    expect(result.outcome).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('PUBLISHED');
    expect(result.failureCode).toBeNull();
  }, 60_000);
});
