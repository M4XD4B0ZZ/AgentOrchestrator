/**
 * AO-FOUNDATION-REM-003B-R3-RR — contains a synchronous `spawn()` throw.
 *
 * An independent re-review of AO-FOUNDATION-REM-003B-R2 found that
 * `runCommand` (src/doctor/exec.ts) violated its own documented contract
 * ("never throws for a failing command") when Node's `spawn()` itself throws
 * synchronously — observed as `spawn UNKNOWN` for a resolved candidate that
 * exists as a regular file but is not a valid executable for this platform.
 * The rejected promise propagated uncaught through every caller
 * (`runCapabilityDump`, `runAuthPreflight`), able to abort an entire doctor
 * run on a single broken binary.
 *
 * This file pins:
 *  - the real-runtime reproduction now resolves to a controlled `CommandResult`;
 *  - the synchronous and asynchronous spawn-failure paths share identical
 *    result semantics;
 *  - no foreign error detail (message, errno, path, syscall, stack) survives
 *    into the result;
 *  - the synchronous failure settles immediately — no leftover timer fires;
 *  - `UnsafeArgumentError` still propagates as an exception, unswallowed;
 *  - a normal successful command is unaffected;
 *  - `runCapabilityDump` completes every probe even when the first one hits a
 *    synchronous spawn failure.
 *
 * ── Two seams since V3 slice 3 ─────────────────────────────────────────────
 *
 * `runCommand` no longer spawns a Windows *target*. It hands a resolved launch
 * plan to the native boundary, and the only process node starts is the helper —
 * so the injection this file is built on intercepts a different thing on each
 * platform, and the groups below are split accordingly rather than sharing a
 * flag. A `throwFor` hook still naming the caller's target would, on Windows,
 * intercept nothing at all and leave every case in its group passing over an
 * unexercised path, which is the failure mode this note exists to prevent.
 *
 * Two result fields differ on the owned path, and both because there is no
 * libuv error object in the chain rather than because detail was dropped:
 * `errnoCode` is `null`, and there is no `ENOENT` split into `NOT_FOUND`. On
 * Windows `NOT_FOUND` is decided earlier, by PATH/PATHEXT resolution, before
 * anything is launched.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandResult } from '../src/doctor/exec.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';

const IS_WINDOWS = process.platform === 'win32';

// ── A controllable spawn(): delegates to the real implementation by default;
// a test can point `spawnControl.throwFor`/`spawnControl.asyncErrorFor` at a
// specific resolved file to force either failure mode without any product
// code seam. execFileSync (taskkill) is left completely untouched. ─────────

const spawnControl = vi.hoisted(() => ({
  throwFor: null as ((file: string) => Error | null) | null,
  asyncErrorFor: null as ((file: string) => NodeJS.ErrnoException | null) | null,
  /**
   * Every file node was asked to start, in order.
   *
   * It exists so that "no ordinary-spawn fallback" can be asserted as an
   * observation rather than inferred from a result code: a fallback would be a
   * second call naming the caller's own target, and a result alone cannot tell
   * that apart from a boundary that refused.
   */
  calls: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (file: string, ...rest: unknown[]) => {
      spawnControl.calls.push(file);
      const syncError = spawnControl.throwFor?.(file);
      if (syncError) throw syncError;

      const asyncError = spawnControl.asyncErrorFor?.(file);
      if (asyncError) {
        const fake = new EventEmitter() as EventEmitter & {
          pid?: number;
          stdout: EventEmitter | null;
          stderr: EventEmitter | null;
          kill: (signal?: string) => boolean;
        };
        fake.pid = 999_999;
        fake.stdout = new EventEmitter();
        fake.stderr = new EventEmitter();
        fake.kill = () => true;
        setImmediate(() => fake.emit('error', asyncError));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return fake as any;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.spawn as any)(file, ...rest);
    },
  };
});

const { runCommand, UnsafeArgumentError } = await import('../src/doctor/exec.js');
const { runCapabilityDump, CAPABILITY_PROBES } = await import('../src/doctor/capabilities.js');

const tempDirs: string[] = [];
/**
 * Canonical by construction, which is what the spawn injections below depend
 * on: `resolveOnPath` hands `spawn()` the `realpathSync.native` result, never
 * the caller's spelling, so a `throwFor`/`asyncErrorFor` hook comparing `file`
 * against a non-canonical target silently stops firing.
 */
function makeTempDir(prefix = 'ao-spawnfail-'): string {
  const dir = makeCanonicalTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  spawnControl.throwFor = null;
  spawnControl.asyncErrorFor = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function syntheticSpawnUnknown(): NodeJS.ErrnoException {
  const error = new Error('spawn UNKNOWN') as NodeJS.ErrnoException;
  error.code = 'UNKNOWN';
  error.errno = -4094;
  error.syscall = 'spawn';
  return error;
}

// ── The errno-leakage gate ─────────────────────────────────────────────────
//
// A raw libuv errno is a *negative integer* (`-4094` for UNKNOWN). Searching
// the whole serialised result for that shape is not a sound test of the errno
// contract: `display`, `executable` and `args` are a verbatim echo of what the
// caller passed in, and a caller path is free to contain a digit run. mkdtemp
// duly produced directories such as `ao-spawnfail-953HCn` and
// `ao-spawnfail-601hZz`, failing the gate on the caller's own characters while
// the product had sanitised the errno correctly (AO-008-S3, ~0.485 % of runs).
//
// The gate is therefore split into the two things it was conflating:
//
//  1. the errno *field* — the only place an errno can enter the contract — is
//     checked directly, and must be a static, allow-listed token;
//  2. the raw-errno *shape* is still hunted across the result, but over the
//     fields that are not a caller echo. The three that are get pinned to the
//     caller's input by identity instead, which is strictly stronger than "no
//     digit run": a value equal to what the caller passed cannot simultaneously
//     be something that escaped the thrown error object.

/** A raw libuv errno as it would look if one ever reached a result field. */
const RAW_LIBUV_ERRNO = /-\d{3,4}/;

/** What a sanitised errno code may look like: `ENOENT`, `E2BIG`, `UNKNOWN`. */
const SANITISED_ERRNO_TOKEN = /^[A-Z][A-Z0-9]*$/;

/**
 * One shared empty argv, held by reference: `runCommand` hands the caller's
 * own array straight through into the result (`base` in src/doctor/exec.ts),
 * so the gate below can pin `args` by identity rather than by shape.
 */
const NO_ARGS: readonly string[] = [];

/**
 * Drops exactly the three **top-level** caller-echo fields and serialises what
 * is left. Deliberately not a `JSON.stringify` replacer: a replacer matches by
 * key at every depth, so a nested `display`/`executable`/`args` — somewhere the
 * product never echoes the caller, and therefore somewhere a raw errno could
 * hide — would silently drop out of the scan as well (AO-008-S3-R1-F1).
 */
function serializeWithoutCallerEcho(result: CommandResult): string {
  const { display, executable, args, ...nonCallerEchoResult } = result;
  return JSON.stringify(nonCallerEchoResult);
}

/**
 * Asserts the errno contract where errno actually lives: an allow-listed,
 * screaming-snake token and never a number in any encoding.
 */
function expectSanitisedErrnoCode(result: CommandResult, expected: string | null): void {
  expect(result.errnoCode).toBe(expected);
  if (expected === null) {
    // The owned Windows path has no errno to report and says so with `null`
    // rather than with a translated guess: no `spawn` was made by this process,
    // so there is no libuv error object anywhere in the chain. Absence is the
    // strongest form of "nothing leaked", and it is asserted as absence rather
    // than waved through.
    expect(result.errnoCode).toBeNull();
    return;
  }
  expect(typeof result.errnoCode).toBe('string');
  expect(String(result.errnoCode)).toMatch(SANITISED_ERRNO_TOKEN);
  expect(String(result.errnoCode)).not.toMatch(RAW_LIBUV_ERRNO);
}

/**
 * The full leakage gate for a contained spawn failure: the errno contract, the
 * caller echo pinned by identity, and no raw errno, stack frame or module path
 * anywhere else in the result.
 */
function expectNoErrorObjectLeak(
  result: CommandResult,
  callerTarget: string,
  callerArgs: readonly string[],
  errno: string | null,
): void {
  expectSanitisedErrnoCode(result, errno);
  // All three caller-echo fields are pinned to the caller's own input *before*
  // any of them is excluded from the raw-errno scan — otherwise the exclusion
  // would be a hole rather than a refinement (AO-008-S3-R1-F1). `args` is
  // pinned by identity: the product passes the caller's array through by
  // reference and never copies it (`base`, src/doctor/exec.ts).
  expect(result.executable).toBe(callerTarget);
  expect(result.args).toBe(callerArgs);
  expect(result.display).toBe([callerTarget, ...callerArgs].join(' '));
  expect(serializeWithoutCallerEcho(result)).not.toMatch(RAW_LIBUV_ERRNO);

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('node_modules');
  expect(serialized).not.toContain('.spawn (');
  expect((result as unknown as { stack?: unknown }).stack).toBeUndefined();
  expect((result as unknown as { cause?: unknown }).cause).toBeUndefined();
}

// ── 10.1: real Windows runtime ──────────────────────────────────────────────

describe.runIf(IS_WINDOWS)('real Windows runtime: synchronous spawn() failure is contained', () => {
  it('an absolute path to an existing, non-executable .exe artifact resolves to a controlled CommandResult', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'broken.exe');
    writeFileSync(target, 'not a real executable\n', 'utf8');

    const result = await runCommand(target, NO_ARGS, { env: {}, timeoutMs: 10_000 });

    expect(result.started).toBe(false);
    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.processTreeKilled).toBe(false);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);

    // `executable`/`display` legitimately echo the caller's own `target`
    // (exactly as every other CommandResult does) — what must NOT appear is
    // anything from the *thrown error object itself*: its stack trace, or the
    // raw negative libuv errno integer, neither of which the caller supplied.
    // See the gate above for why the errno check reads the errno field rather
    // than the caller's own path characters.
    //
    // `null` rather than `UNKNOWN` since V3 slice 3, and it is a different
    // *source* rather than a lost detail: this process no longer spawns the
    // target at all. `CreateProcessW` fails inside the boundary, which reports
    // its own fixed `OWNED_CONTAINMENT_CREATE`, and no libuv error object
    // exists on this path to sanitise or to leak.
    expectNoErrorObjectLeak(result, target, NO_ARGS, null);
  });

  it('a PATH/PATHEXT-resolved candidate that is not executable resolves to a controlled CommandResult', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'broken.exe'), 'not a real executable\n', 'utf8');

    const result = await runCommand('broken', [], {
      env: { PATH: dir, PATHEXT: '.EXE' },
      timeoutMs: 10_000,
    });

    expect(result.started).toBe(false);
    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    // See above: the boundary refuses, and a refusal carries no errno.
    expect(result.errnoCode).toBeNull();
  });

  it('leaves no process behind and settles well within the timeout budget', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'broken2.exe');
    writeFileSync(target, 'not a real executable\n', 'utf8');

    const start = Date.now();
    const result = await runCommand(target, [], { env: {}, timeoutMs: 60_000 });
    const elapsed = Date.now() - start;

    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(elapsed).toBeLessThan(5_000); // nowhere near the 60s timeout: no leftover timer fired
  });
});

// ── 10.2: deterministic synchronous throw, via the controllable spawn ─────

describe.skipIf(IS_WINDOWS)('deterministic synchronous spawn() throw', () => {
  it('resolves to the canonical SPAWN_FAILED shape, with no foreign error field leaking', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'sentinel.exe');
    writeFileSync(target, 'x', 'utf8');

    const SECRET = 'AO_SECRET_SPAWN_DETAIL_should_not_leak';
    spawnControl.throwFor = (file) => {
      if (file !== target) return null;
      const err = new Error(`spawn ${SECRET}`) as NodeJS.ErrnoException;
      err.code = 'UNKNOWN';
      err.errno = -4094;
      err.syscall = 'spawn';
      err.path = SECRET;
      return err;
    };

    const result = await runCommand(target, [], { env: {}, timeoutMs: 10_000 });

    expect(result).toMatchObject({
      started: false,
      outcome: 'SPAWN_FAILED',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      failureCode: 'SPAWN_FAILED',
      errnoCode: 'UNKNOWN',
      stdoutTruncated: false,
      stderrTruncated: false,
      processTreeKilled: false,
    });
    expect((result as unknown as { cause?: unknown }).cause).toBeUndefined();

    // `target` itself is the caller's own input and legitimately appears as
    // `executable`/`display` — what must NOT appear is anything that came
    // from the thrown error object: its distinguishing message content, the
    // raw errno integer, or the syscall name.
    const serialized = JSON.stringify(result);
    for (const forbidden of [SECRET, '-4094', 'syscall']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('reports NOT_FOUND/EXECUTABLE_NOT_FOUND when the synchronous error carries ENOENT', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'sentinel-enoent.exe');
    writeFileSync(target, 'x', 'utf8');
    spawnControl.throwFor = (file) => {
      if (file !== target) return null;
      const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      return err;
    };

    const result = await runCommand(target, [], { env: {}, timeoutMs: 10_000 });

    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.failureCode).toBe('EXECUTABLE_NOT_FOUND');
    expect(result.errnoCode).toBe('ENOENT');
  });

  it('a caller path whose own name carries a raw-errno-shaped digit run is not a leak', async () => {
    // The path here is exactly the shape mkdtemp produced by chance during
    // AO-008-S3 (`ao-spawnfail-953HCn`, `ao-spawnfail-601hZz`), pinned so the
    // case is tested every run instead of ~1 run in 200. Both digit runs are
    // caller-chosen characters that `display`/`executable` must keep echoing.
    const dir = makeTempDir('ao-spawnfail-953-valid-');
    const target = join(dir, 'sentinel-601.exe');
    writeFileSync(target, 'x', 'utf8');
    expect(target).toMatch(RAW_LIBUV_ERRNO); // the caller path, not a leak
    spawnControl.throwFor = (file) => (file === target ? syntheticSpawnUnknown() : null);

    const result = await runCommand(target, NO_ARGS, { env: {}, timeoutMs: 10_000 });

    expect(result.started).toBe(false);
    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    // The thrown error carried errno -4094; the result carries the sanitised
    // token, the caller's path survives verbatim, and nothing outside that echo
    // shows a raw errno. The whole-serialisation form of this gate failed here.
    expectNoErrorObjectLeak(result, target, NO_ARGS, 'UNKNOWN');
    expect(JSON.stringify(result)).not.toContain('-4094');
    expect(JSON.stringify(result)).not.toContain('syscall');
  });

  it('a result whose args are not the caller\'s own fails the gate (AO-008-S3-R1-F1)', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'sentinel-args.exe');
    writeFileSync(target, 'x', 'utf8');
    spawnControl.throwFor = (file) => (file === target ? syntheticSpawnUnknown() : null);

    const result = await runCommand(target, NO_ARGS, { env: {}, timeoutMs: 10_000 });
    expectNoErrorObjectLeak(result, target, NO_ARGS, 'UNKNOWN'); // the honest result passes

    // The counterexample the gate used to accept: `errnoCode`, `display` and
    // `executable` all still correct, only `args` swapped for the raw libuv
    // errno. Excluding `args` from the raw-errno scan is sound *only* because
    // the gate first proves it is the caller's own array — so this must fail.
    const forgedArgs = { ...result, args: ['-4094'] } as CommandResult;
    expect(forgedArgs.errnoCode).toBe('UNKNOWN');
    expect(forgedArgs.display).toBe(target);
    expect(forgedArgs.executable).toBe(target);
    expect(() => expectNoErrorObjectLeak(forgedArgs, target, NO_ARGS, 'UNKNOWN')).toThrow();

    // And the exclusion reaches the top level only: a nested property that
    // merely shares a caller-echo name is still scanned for a raw errno.
    const nestedEcho = { ...result, args: NO_ARGS, nested: { args: ['-4094'] } } as CommandResult;
    expect(() => expectNoErrorObjectLeak(nestedEcho, target, NO_ARGS, 'UNKNOWN')).toThrow();
  });

  it('settles immediately rather than waiting for the configured timeout (no leftover timer)', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'sentinel3.exe');
    writeFileSync(target, 'x', 'utf8');
    spawnControl.throwFor = (file) => (file === target ? syntheticSpawnUnknown() : null);

    const start = Date.now();
    const result = await runCommand(target, [], { env: {}, timeoutMs: 60_000 });
    const elapsed = Date.now() - start;

    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(elapsed).toBeLessThan(5_000);
  });
});

// ── 10.2w: the same containment, at the seam Windows actually has ─────────

/**
 * The Windows half of 10.2, and the reason it is a separate group rather than
 * a platform flag inside the one above.
 *
 * Since V3 slice 3, `runCommand` does not spawn a Windows target: it hands a
 * resolved launch plan to the boundary, and the only process node starts is the
 * helper. So the seam the group above drives — a synchronous throw from
 * `spawn()` for the *target* — is unreachable on Windows, and a case that
 * pointed `throwFor` at a target file would have passed while intercepting
 * nothing. Pointing it at the helper instead keeps the property the group
 * exists for: a failure to start is contained as data, settles at once, and
 * carries no foreign detail.
 *
 * Two expectations differ from the POSIX group, and both follow from there
 * being no libuv error object on this path rather than from a weakening:
 *
 *  - `errnoCode` is `null`. There is no errno to sanitise;
 *  - there is no `ENOENT`/other split, so no `NOT_FOUND`. On Windows
 *    `NOT_FOUND` is decided earlier and better — by PATH/PATHEXT resolution,
 *    before any launch — and that is pinned in `tests/exec.test.ts` and
 *    `tests/path-resolution.test.ts`.
 */
describe.runIf(IS_WINDOWS)('a boundary helper that cannot be started is contained', () => {
  /** Matches the native helper, whatever directory the build put it in. */
  const isBoundaryHelper = (file: string): boolean => /ao-launch\.exe$/i.test(file);

  it('resolves to the canonical SPAWN_FAILED shape and leaks nothing', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'sentinel-owned.exe');
    writeFileSync(target, 'x', 'utf8');

    const SECRET = 'AO_SECRET_BOUNDARY_DETAIL_should_not_leak';
    spawnControl.throwFor = (file) => {
      if (!isBoundaryHelper(file)) return null;
      const err = new Error(`spawn ${SECRET}`) as NodeJS.ErrnoException;
      err.code = 'UNKNOWN';
      err.errno = -4094;
      err.syscall = 'spawn';
      err.path = SECRET;
      return err;
    };

    const result = await runCommand(target, NO_ARGS, { env: {}, timeoutMs: 10_000 });

    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.processTreeKilled).toBe(false);
    // `true`, and deliberately so: a throw while starting the helper is not
    // evidence that nothing was created, and this field is what a caller reads
    // to decide whether a run may have had side effects. `UNKNOWN` counts as
    // `YES` there, which is the direction the ADR requires.
    expect(result.started).toBe(true);
    expectNoErrorObjectLeak(result, target, NO_ARGS, null);
    for (const forbidden of [SECRET, '-4094', 'syscall']) {
      expect(JSON.stringify(result)).not.toContain(forbidden);
    }
  });

  it('is still SPAWN_FAILED when the helper throw carries ENOENT, never NOT_FOUND', async () => {
    // The distinction the POSIX group draws does not exist here, and inventing
    // it would be worse than losing it: `NOT_FOUND` means "there is no such
    // program", and a helper that could not start says nothing whatsoever about
    // the target the caller asked for. Reporting it would tell a capability
    // probe that a CLI is not installed because AO's own boundary is broken.
    const dir = makeTempDir();
    const target = join(dir, 'sentinel-owned-enoent.exe');
    writeFileSync(target, 'x', 'utf8');
    spawnControl.throwFor = (file) => {
      if (!isBoundaryHelper(file)) return null;
      const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      return err;
    };

    const result = await runCommand(target, [], { env: {}, timeoutMs: 10_000 });

    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    expect(result.outcome).not.toBe('NOT_FOUND');
    expect(result.errnoCode).toBeNull();
  });

  it('settles immediately rather than waiting for the configured timeout', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'sentinel-owned-fast.exe');
    writeFileSync(target, 'x', 'utf8');
    spawnControl.throwFor = (file) => (isBoundaryHelper(file) ? syntheticSpawnUnknown() : null);

    const start = Date.now();
    const result = await runCommand(target, [], { env: {}, timeoutMs: 60_000 });
    const elapsed = Date.now() - start;

    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(elapsed).toBeLessThan(5_000);
  });

  it('starts no target of its own when the boundary cannot be started', async () => {
    // The fail-closed claim, stated as an absence that is actually observed:
    // with the helper unstartable, node is asked to start exactly one process —
    // the helper — and never the target. An ordinary-spawn fallback would show
    // up here as a second call naming the caller's own file.
    const dir = makeTempDir();
    const target = join(dir, 'sentinel-owned-nofallback.exe');
    writeFileSync(target, 'x', 'utf8');
    spawnControl.throwFor = (file) => (isBoundaryHelper(file) ? syntheticSpawnUnknown() : null);
    spawnControl.calls = [];

    await runCommand(target, [], { env: {}, timeoutMs: 10_000 });

    expect(spawnControl.calls.length).toBeGreaterThan(0);
    for (const file of spawnControl.calls) expect(isBoundaryHelper(file)).toBe(true);
    expect(spawnControl.calls.map((f) => f.toLowerCase())).not.toContain(target.toLowerCase());
  });
});

// ── 10.3: the existing async child.on('error') path stays intact, and shares
// identical result semantics with the new synchronous path ─────────────────

describe.skipIf(IS_WINDOWS)('asynchronous spawn error (child.on("error")) stays intact and matches the synchronous shape', () => {
  it('an async ENOENT error produces the same shape as the synchronous ENOENT case', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'async-enoent.exe');
    writeFileSync(target, 'x', 'utf8');
    spawnControl.asyncErrorFor = (file) => {
      if (file !== target) return null;
      const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      return err;
    };

    const result = await runCommand(target, [], { env: {}, timeoutMs: 10_000 });

    expect(result.started).toBe(false);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.failureCode).toBe('EXECUTABLE_NOT_FOUND');
    expect(result.errnoCode).toBe('ENOENT');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.processTreeKilled).toBe(false);
  });

  it('an async non-ENOENT error produces the same shape as the synchronous SPAWN_FAILED case', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'async-unknown.exe');
    writeFileSync(target, 'x', 'utf8');
    spawnControl.asyncErrorFor = (file) => (file === target ? syntheticSpawnUnknown() : null);

    const result = await runCommand(target, [], { env: {}, timeoutMs: 10_000 });

    expect(result.started).toBe(false);
    expect(result.outcome).toBe('SPAWN_FAILED');
    expect(result.failureCode).toBe('SPAWN_FAILED');
    expect(result.errnoCode).toBe('UNKNOWN');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.processTreeKilled).toBe(false);
  });
});

// ── 10.4: normal success is unaffected ──────────────────────────────────────

describe('normal successful command is unaffected', () => {
  it.runIf(IS_WINDOWS)('a real, working .cmd script still completes normally', async () => {
    const dir = makeTempDir();
    const script = join(dir, 'ok.cmd');
    writeFileSync(script, '@echo off\r\necho AO_OK\r\n', 'utf8');

    const result = await runCommand(script, [], {
      env: { PATH: process.env['PATH'] ?? '', PATHEXT: process.env['PATHEXT'] ?? '' },
      timeoutMs: 15_000,
    });

    expect(result.outcome).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AO_OK');
  });
});

// ── 10.5: UnsafeArgumentError is not swallowed into SPAWN_FAILED ───────────

describe('UnsafeArgumentError still propagates as an exception, unswallowed', () => {
  it('an unsafe argument still rejects with UnsafeArgumentError, not a SPAWN_FAILED result', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'unused.exe');
    writeFileSync(target, 'x', 'utf8');

    await expect(
      runCommand(target, ['has a space'], { env: {}, timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(UnsafeArgumentError);
  });
});

// ── 10.6: runCapabilityDump continues past a single synchronous failure ───

describe('runCapabilityDump continues past a single synchronous spawn failure', () => {
  it('every probe still produces a record, even when the very first one fails synchronously', async () => {
    // node.version is CAPABILITY_PROBES[0] and is guaranteed resolvable — the
    // test itself runs under Node. Failing it synchronously exercises exactly
    // the scenario the review found: the first probe in the loop breaks.
    expect(CAPABILITY_PROBES[0]?.id).toBe('node.version');
    // The process node is asked to start differs by platform since V3 slice 3:
    // on Windows it is the boundary helper and never the probe's own target,
    // so a matcher naming `node` would intercept nothing and the case would
    // pass while measuring a probe that succeeded.
    const failing = IS_WINDOWS ? /ao-launch\.exe$/i : /node(\.exe)?$/i;
    spawnControl.throwFor = (file) => (failing.test(file) ? syntheticSpawnUnknown() : null);

    const records = await runCapabilityDump({ env: process.env, timeoutMs: 10_000 });

    expect(records).toHaveLength(CAPABILITY_PROBES.length);
    const nodeRecord = records.find((r) => r.probe.id === 'node.version');
    expect(nodeRecord?.availability).toBe('PROBE_FAILED');
    expect(nodeRecord?.facts.outcome).toBe('SPAWN_FAILED');
    // Every other declared probe still produced a record (the loop was not
    // aborted after the first failure), regardless of what it individually found.
    for (const probe of CAPABILITY_PROBES) {
      expect(records.some((r) => r.probe.id === probe.id)).toBe(true);
    }
  });
});
