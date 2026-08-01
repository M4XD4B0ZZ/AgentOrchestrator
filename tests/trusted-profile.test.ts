/**
 * AO-WINPROFILE-001 / AO-WINPROFILE-001-R1: the trusted profile resolver reads
 * the operating system directly, in this process, and validates fail-closed.
 *
 * Two properties are under test here.
 *
 * The first is provenance: the profile directory comes from `os.userInfo()`,
 * which consults no environment block, so no variable a caller can set moves
 * the persistent write root. The environment probes at the bottom of this file
 * are the regression tests for that.
 *
 * The second is the safety boundary (AO-WINPROFILE-001-R1). Every value the
 * resolver takes from outside — the dependency slots themselves, the query
 * result, its `homedir` field, the canonical answer, the file-status object and
 * that object's directory predicate — may be an accessor that throws, an absent
 * member, a non-callable value or a method that throws. None of those may
 * produce a native error or carry foreign text outward: each must be reduced to
 * the one closed domain failure. The fixtures below are deliberately hostile,
 * and each carries a conspicuous marker string that must never appear in any
 * message, formatted text or stack.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTrustedProfileResolverForTests,
  resetTrustedProfileCacheForTests,
  trustedProfileDirectory,
  type TrustedProfileDependencies,
} from '../src/config/internal/trusted-profile.js';
import { TrustedProfileUnavailableError } from '../src/core/errors.js';
import { formatSafeError, safeDomainErrorId } from '../src/core/safe-error.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';

/**
 * Deliberately conspicuous values. Every one of them is fed into the resolver
 * on a failing path, and no failure is allowed to carry any of them outward.
 *
 * Each hostile fixture gets its own marker, so a leak names the exact boundary
 * that failed rather than leaving it to be guessed.
 */
const SECRET_RAW_PATH = 'Z:\\ao-secret-raw-profile-must-not-leak';
const SECRET_CANONICAL_PATH = 'Z:\\ao-secret-canonical-profile-must-not-leak';
const SECRET_EXCEPTION_TEXT = 'ao-secret-exception-message-must-not-leak';
const SECRET_USERNAME = 'ao-secret-username-must-not-leak';

// REV-01 — one marker per hostile external operation.
const SECRET_HOMEDIR_GETTER = 'ao-secret-homedir-getter-must-not-leak';
const SECRET_HOMEDIR_PROXY = 'ao-secret-homedir-proxy-trap-must-not-leak';
const SECRET_ISDIRECTORY_GETTER = 'ao-secret-isdirectory-getter-must-not-leak';
const SECRET_ISDIRECTORY_PROXY = 'ao-secret-isdirectory-proxy-trap-must-not-leak';
const SECRET_ISDIRECTORY_CALL = 'ao-secret-isdirectory-call-must-not-leak';
const SECRET_ISDIRECTORY_ABSENT = 'ao-secret-isdirectory-absent-must-not-leak';
const SECRET_ISDIRECTORY_NOT_CALLABLE = 'ao-secret-isdirectory-not-callable-must-not-leak';
const SECRET_ISDIRECTORY_TRUTHY = 'ao-secret-isdirectory-truthy-must-not-leak';

// REV-01 — one marker per malformed dependency container.
const SECRET_DEPENDENCY_ABSENT = 'ao-secret-dependency-slot-absent-must-not-leak';
const SECRET_DEPENDENCY_NOT_CALLABLE = 'ao-secret-dependency-slot-not-callable-must-not-leak';
const SECRET_DEPENDENCY_GETTER = 'ao-secret-dependency-slot-getter-must-not-leak';
const SECRET_DEPENDENCY_PRIMITIVE = 'ao-secret-dependency-primitive-container-must-not-leak';

// REV-04 — the two non-directory shapes, told apart by their own markers.
const SECRET_REGULAR_FILE = 'ao-secret-regular-file-content-must-not-leak';
const SECRET_OTHER_TYPE = 'ao-secret-other-file-type-must-not-leak';

const SECRETS = [
  SECRET_RAW_PATH,
  SECRET_CANONICAL_PATH,
  SECRET_EXCEPTION_TEXT,
  SECRET_USERNAME,
  SECRET_HOMEDIR_GETTER,
  SECRET_HOMEDIR_PROXY,
  SECRET_ISDIRECTORY_GETTER,
  SECRET_ISDIRECTORY_PROXY,
  SECRET_ISDIRECTORY_CALL,
  SECRET_ISDIRECTORY_ABSENT,
  SECRET_ISDIRECTORY_NOT_CALLABLE,
  SECRET_ISDIRECTORY_TRUTHY,
  SECRET_DEPENDENCY_ABSENT,
  SECRET_DEPENDENCY_NOT_CALLABLE,
  SECRET_DEPENDENCY_GETTER,
  SECRET_DEPENDENCY_PRIMITIVE,
  SECRET_REGULAR_FILE,
  SECRET_OTHER_TYPE,
];

const NUL = '\u0000';

/** Native error text that must never be what a caller sees. */
const NATIVE_ERROR_TEXT =
  /TypeError|is not a function|Cannot read propert|of undefined|of null|Reflect\.apply/i;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-trusted-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  // The productive cache must never carry state between tests.
  resetTrustedProfileCacheForTests();
});

interface DependencyCalls {
  userInfo: number;
  realpath: number;
  stat: number;
  realpathArgs: string[];
}

/**
 * Builds a closed dependency set plus a call ledger, with no global mocking.
 *
 * The override signatures return `unknown` on purpose: a fail-closed test has
 * to be able to hand the resolver a value the declaration says is impossible,
 * because the declaration is exactly what the resolver refuses to trust.
 */
function makeDependencies(overrides: {
  userInfo?: () => unknown;
  realpath?: (path: string) => unknown;
  stat?: (path: string) => unknown;
}): { dependencies: TrustedProfileDependencies; calls: DependencyCalls } {
  const calls: DependencyCalls = { userInfo: 0, realpath: 0, stat: 0, realpathArgs: [] };
  // Presence of an override is tested explicitly rather than with `??`, so an
  // override that legitimately returns `null` or `''` is not silently replaced
  // by the valid default — which would turn a fail-closed case into a pass.
  const dependencies: TrustedProfileDependencies = {
    userInfo: (): unknown => {
      calls.userInfo += 1;
      if (overrides.userInfo !== undefined) return overrides.userInfo();
      return { homedir: SECRET_RAW_PATH };
    },
    realpath: (path: string): unknown => {
      calls.realpath += 1;
      calls.realpathArgs.push(path);
      if (overrides.realpath !== undefined) return overrides.realpath(path);
      return path;
    },
    stat: (path: string): unknown => {
      calls.stat += 1;
      if (overrides.stat !== undefined) return overrides.stat(path);
      return { isDirectory: (): boolean => true };
    },
  };
  return { dependencies, calls };
}

/** Asserts the closed outer error contract and that nothing leaked. */
function expectSafeFailure(run: () => unknown): void {
  let caught: unknown;
  expect(run).toThrow(TrustedProfileUnavailableError);
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(TrustedProfileUnavailableError);
  expect(safeDomainErrorId(caught)).toBe('TRUSTED_PROFILE_UNAVAILABLE');

  const developerText = caught instanceof Error ? caught.message : String(caught);
  const safeText = formatSafeError(caught);
  const stack = caught instanceof Error ? (caught.stack ?? '') : '';

  for (const secret of SECRETS) {
    expect(developerText).not.toContain(secret);
    expect(safeText).not.toContain(secret);
    expect(stack).not.toContain(secret);
  }
  // No errno, no raw cause, no path fragment of any shape.
  expect(developerText).not.toMatch(/ENOENT|EACCES|EPERM|ENOTDIR|errno/i);
  expect(safeText).not.toMatch(/ENOENT|EACCES|EPERM|ENOTDIR|errno/i);
  expect(safeText).not.toMatch(/[A-Za-z]:\\/);
  expect(developerText).not.toMatch(/[A-Za-z]:\\/);
  // And no native error text: a `TypeError` reaching a caller would mean the
  // boundary was crossed rather than closed.
  expect(developerText).not.toMatch(NATIVE_ERROR_TEXT);
  expect(safeText).not.toMatch(NATIVE_ERROR_TEXT);
  expect(caught instanceof Error ? caught.name : '').toBe('TrustedProfileUnavailableError');
}

// ── 8.1 The valid provider case ────────────────────────────────────────────

describe('the isolated resolver accepts a valid operating-system answer', () => {
  it('returns exactly the canonical directory', () => {
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);

    const { dependencies, calls } = makeDependencies({
      userInfo: () => ({ homedir: scratch, username: SECRET_USERNAME }),
      realpath: () => canonical,
      stat: () => ({ isDirectory: (): boolean => true }),
    });

    const resolve = createTrustedProfileResolverForTests(dependencies);
    expect(resolve()).toBe(canonical);
    expect(calls.userInfo).toBe(1);
    expect(calls.realpath).toBe(1);
    expect(calls.stat).toBe(1);
  });

  it('memoises the success and does not ask the provider again', () => {
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);
    const { dependencies, calls } = makeDependencies({
      userInfo: () => ({ homedir: scratch }),
      realpath: () => canonical,
    });

    const resolve = createTrustedProfileResolverForTests(dependencies);
    const first = resolve();
    const second = resolve();
    const third = resolve();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(calls.userInfo).toBe(1);
    expect(calls.realpath).toBe(1);
    expect(calls.stat).toBe(1);
  });

  it('uses only the homedir field and ignores every other userInfo field', () => {
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);
    const { dependencies } = makeDependencies({
      userInfo: () => ({
        homedir: scratch,
        username: SECRET_USERNAME,
        shell: SECRET_RAW_PATH,
        uid: -1,
        gid: -1,
      }),
      realpath: () => canonical,
    });

    expect(createTrustedProfileResolverForTests(dependencies)()).toBe(canonical);
  });

  it('does not reject a UNC-shaped value on its form alone', () => {
    // No real network share is involved: the injected canonical provider maps
    // the UNC-shaped raw value onto a real local directory, which is exactly
    // what a resolved redirected profile looks like from here.
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);
    const unc = '\\\\ao-test-server\\profiles\\user';

    expect(isAbsolute(unc)).toBe(true);

    const { dependencies, calls } = makeDependencies({
      userInfo: () => ({ homedir: unc }),
      realpath: () => canonical,
    });

    expect(createTrustedProfileResolverForTests(dependencies)()).toBe(canonical);
    // The UNC form reached realpath rather than being refused before it.
    expect(calls.realpathArgs).toEqual([unc]);
  });

  it('resolves the untrimmed original string, never a trimmed copy', () => {
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);
    const padded = `${scratch}  `;

    const { dependencies, calls } = makeDependencies({
      userInfo: () => ({ homedir: padded }),
      realpath: () => canonical,
    });

    expect(createTrustedProfileResolverForTests(dependencies)()).toBe(canonical);
    expect(calls.realpathArgs).toEqual([padded]);
    expect(calls.realpathArgs[0]).not.toBe(scratch);
  });

  it('accepts a homedir delivered through a getter that does not throw', () => {
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);

    const { dependencies } = makeDependencies({
      userInfo: () => ({
        get homedir(): unknown {
          return scratch;
        },
      }),
      realpath: () => canonical,
    });

    expect(createTrustedProfileResolverForTests(dependencies)()).toBe(canonical);
  });

  it('calls isDirectory with the file-status object as its receiver', () => {
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);

    // The predicate answers from `this`. Detached — the classic mistake of
    // pulling the method off and calling it bare — it would answer `false` and
    // this resolution would fail, so a pass here proves the receiver is right.
    const stats = {
      directory: true,
      isDirectory(this: unknown): boolean {
        return (this as { directory?: unknown } | undefined)?.directory === true;
      },
    };

    const { dependencies } = makeDependencies({
      userInfo: () => ({ homedir: scratch }),
      realpath: () => canonical,
      stat: () => stats,
    });

    expect(stats.isDirectory.call(undefined)).toBe(false);
    expect(createTrustedProfileResolverForTests(dependencies)()).toBe(canonical);
  });
});

// ── 8.2 Fail-closed cases ──────────────────────────────────────────────────

describe('the isolated resolver fails closed on every invalid answer', () => {
  const cases: ReadonlyArray<
    readonly [string, Parameters<typeof makeDependencies>[0]]
  > = [
    [
      'userInfo throws',
      {
        userInfo: () => {
          throw new Error(SECRET_EXCEPTION_TEXT);
        },
      },
    ],
    ['userInfo returns null', { userInfo: () => null }],
    ['userInfo returns a non-object', { userInfo: () => SECRET_RAW_PATH }],
    ['homedir is missing', { userInfo: () => ({ username: SECRET_USERNAME }) }],
    ['homedir is not a string', { userInfo: () => ({ homedir: 42 }) }],
    ['homedir is empty', { userInfo: () => ({ homedir: '' }) }],
    ['homedir is whitespace only', { userInfo: () => ({ homedir: '   \t  ' }) }],
    ['homedir carries an embedded NUL', { userInfo: () => ({ homedir: `C:\\ao${NUL}test` }) }],
    ['homedir is relative', { userInfo: () => ({ homedir: 'relative\\profile' }) }],
    // ── REV-01: the homedir read itself is hostile ──────────────────────────
    [
      'the homedir getter throws',
      {
        userInfo: () => ({
          get homedir(): unknown {
            throw new Error(SECRET_HOMEDIR_GETTER);
          },
        }),
      },
    ],
    [
      'the userInfo result is a proxy whose get trap throws',
      {
        userInfo: () =>
          new Proxy(
            {},
            {
              get(): never {
                throw new Error(SECRET_HOMEDIR_PROXY);
              },
            },
          ),
      },
    ],
    [
      'realpath throws',
      {
        userInfo: () => ({ homedir: SECRET_RAW_PATH }),
        realpath: () => {
          const error: NodeJS.ErrnoException = new Error(SECRET_EXCEPTION_TEXT);
          error.code = 'ENOENT';
          error.path = SECRET_RAW_PATH;
          throw error;
        },
      },
    ],
    ['realpath returns empty', { realpath: () => '' }],
    ['realpath returns a relative path', { realpath: () => 'relative\\canonical' }],
    ['realpath returns a value with NUL', { realpath: () => `C:\\ao${NUL}canonical` }],
    [
      'stat throws',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => {
          const error: NodeJS.ErrnoException = new Error(SECRET_EXCEPTION_TEXT);
          error.code = 'ENOENT';
          throw error;
        },
      },
    ],
    ['stat returns null', { realpath: () => SECRET_CANONICAL_PATH, stat: () => null }],
    // ── REV-01: the isDirectory read, and the isDirectory call, are hostile ─
    [
      'the isDirectory getter throws',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => ({
          get isDirectory(): unknown {
            throw new Error(SECRET_ISDIRECTORY_GETTER);
          },
        }),
      },
    ],
    [
      'the file-status object is a proxy whose get trap throws',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () =>
          new Proxy(
            {},
            {
              get(): never {
                throw new Error(SECRET_ISDIRECTORY_PROXY);
              },
            },
          ),
      },
    ],
    [
      'isDirectory throws when called',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => ({
          isDirectory: (): never => {
            throw new Error(SECRET_ISDIRECTORY_CALL);
          },
        }),
      },
    ],
    [
      'isDirectory is absent',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => ({ marker: SECRET_ISDIRECTORY_ABSENT }),
      },
    ],
    [
      'isDirectory is not a function',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => ({ isDirectory: SECRET_ISDIRECTORY_NOT_CALLABLE }),
      },
    ],
    [
      'isDirectory returns a truthy non-boolean',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => ({ isDirectory: (): unknown => SECRET_ISDIRECTORY_TRUTHY }),
      },
    ],
    [
      'isDirectory returns undefined',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => ({ isDirectory: (): unknown => undefined }),
      },
    ],
    [
      'isDirectory returns null',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => ({ isDirectory: (): unknown => null }),
      },
    ],
    // ── REV-04: a non-directory type that is explicitly not a regular file ──
    [
      'the canonical target is neither a directory nor a regular file',
      {
        realpath: () => SECRET_CANONICAL_PATH,
        stat: () => ({
          marker: SECRET_OTHER_TYPE,
          isDirectory: (): boolean => false,
          isFile: (): boolean => false,
          isSymbolicLink: (): boolean => false,
          isFIFO: (): boolean => false,
          isBlockDevice: (): boolean => false,
          isCharacterDevice: (): boolean => false,
        }),
      },
    ],
  ];

  it.each(cases)('rejects when %s', (_label, overrides) => {
    const { dependencies } = makeDependencies(overrides);
    const resolve = createTrustedProfileResolverForTests(dependencies);
    expectSafeFailure(() => resolve());
  });

  it('never consults the environment on any failing path', () => {
    const before = { ...process.env };
    for (const [, overrides] of cases) {
      const { dependencies } = makeDependencies(overrides);
      const resolve = createTrustedProfileResolverForTests(dependencies);
      expect(() => resolve()).toThrow(TrustedProfileUnavailableError);
    }
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
  });

  /**
   * REV-04 — the regular-file case is a *real* regular file, not a stats-like
   * literal. It has its own realpath and its own `statSync` evaluation, so it
   * shares no fixture with the "some other type" case above and can never pass
   * for the same reason.
   */
  it('rejects a canonical target that is a real regular file on disk', () => {
    const directory = makeTempDir();
    const file = join(directory, 'ao-regular-file');
    writeFileSync(file, SECRET_REGULAR_FILE, 'utf8');
    const canonicalFile = realpathSync.native(file);

    // The fixture really is a regular file, established by the OS, not claimed.
    expect(statSync(canonicalFile).isFile()).toBe(true);
    expect(statSync(canonicalFile).isDirectory()).toBe(false);

    const { dependencies, calls } = makeDependencies({
      userInfo: () => ({ homedir: file }),
      realpath: () => canonicalFile,
      // The real filesystem call, not a stand-in for it.
      stat: (path: string) => statSync(path),
    });

    expectSafeFailure(() => createTrustedProfileResolverForTests(dependencies)());
    expect(calls.stat).toBeGreaterThan(0);
  });
});

// ── 8.2b REV-01: a malformed dependency container is refused, not thrown at ─

describe('the test factory refuses a malformed dependency container', () => {
  const workingSlots = {
    userInfo: (): unknown => ({ homedir: SECRET_RAW_PATH }),
    realpath: (path: string): unknown => path,
    stat: (): unknown => ({ isDirectory: (): boolean => true }),
  };

  /** A container missing exactly one slot, carrying a marker in its place. */
  function without(slot: 'userInfo' | 'realpath' | 'stat'): unknown {
    const container: Record<string, unknown> = { ...workingSlots, absentSlotMarker: SECRET_DEPENDENCY_ABSENT };
    delete container[slot];
    return container;
  }

  /** A container whose slot holds a marker string instead of a function. */
  function notCallable(slot: 'userInfo' | 'realpath' | 'stat'): unknown {
    return { ...workingSlots, [slot]: SECRET_DEPENDENCY_NOT_CALLABLE };
  }

  /** A container whose slot is an accessor that throws when it is read. */
  function throwingGetter(slot: 'userInfo' | 'realpath' | 'stat'): unknown {
    const container: Record<string, unknown> = { ...workingSlots };
    delete container[slot];
    Object.defineProperty(container, slot, {
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error(SECRET_DEPENDENCY_GETTER);
      },
    });
    return container;
  }

  const containers: ReadonlyArray<readonly [string, unknown]> = [
    ['the container is null', null],
    ['the container is undefined', undefined],
    ['the container is a string carrying a marker', SECRET_DEPENDENCY_PRIMITIVE],
    ['the container is a number', 42],
    ['the container is a boolean', true],
    ['userInfo is absent', without('userInfo')],
    ['realpath is absent', without('realpath')],
    ['stat is absent', without('stat')],
    ['userInfo is not a function', notCallable('userInfo')],
    ['realpath is not a function', notCallable('realpath')],
    ['stat is not a function', notCallable('stat')],
    ['the userInfo slot is a throwing getter', throwingGetter('userInfo')],
    ['the realpath slot is a throwing getter', throwingGetter('realpath')],
    ['the stat slot is a throwing getter', throwingGetter('stat')],
    [
      'the container is a proxy whose get trap throws',
      new Proxy(
        {},
        {
          get(): never {
            throw new Error(SECRET_DEPENDENCY_GETTER);
          },
        },
      ),
    ],
  ];

  it.each(containers)('fails closed when %s', (_label, container) => {
    const resolve = createTrustedProfileResolverForTests(
      container as unknown as TrustedProfileDependencies,
    );
    expectSafeFailure(() => resolve());
  });

  it('leaks nothing from a malformed container into the environment either', () => {
    const before = { ...process.env };
    for (const [, container] of containers) {
      const resolve = createTrustedProfileResolverForTests(
        container as unknown as TrustedProfileDependencies,
      );
      expect(() => resolve()).toThrow(TrustedProfileUnavailableError);
    }
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
  });
});

// ── 8.3 Success cache and failure cache ────────────────────────────────────

describe('only successful resolutions are memoised', () => {
  it('does not cache a failure as a success', () => {
    let attempt = 0;
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);

    const { dependencies, calls } = makeDependencies({
      userInfo: () => {
        attempt += 1;
        if (attempt === 1) throw new Error(SECRET_EXCEPTION_TEXT);
        return { homedir: scratch };
      },
      realpath: () => canonical,
    });

    const resolve = createTrustedProfileResolverForTests(dependencies);
    expect(() => resolve()).toThrow(TrustedProfileUnavailableError);
    // The provider is asked again, and the later valid answer is accepted.
    expect(resolve()).toBe(canonical);
    expect(calls.userInfo).toBe(2);
    // And from then on the success is memoised.
    expect(resolve()).toBe(canonical);
    expect(calls.userInfo).toBe(2);
  });

  it('keeps isolated resolvers independent of each other', () => {
    const first = makeTempDir();
    const second = makeTempDir();
    const firstCanonical = realpathSync.native(first);
    const secondCanonical = realpathSync.native(second);

    const a = createTrustedProfileResolverForTests(
      makeDependencies({ userInfo: () => ({ homedir: first }), realpath: () => firstCanonical })
        .dependencies,
    );
    const b = createTrustedProfileResolverForTests(
      makeDependencies({ userInfo: () => ({ homedir: second }), realpath: () => secondCanonical })
        .dependencies,
    );

    expect(a()).toBe(firstCanonical);
    expect(b()).toBe(secondCanonical);
    expect(a()).toBe(firstCanonical);
  });

  it('keeps an isolated resolver from disturbing the productive cache', () => {
    const productive = trustedProfileDirectory();
    const scratch = makeTempDir();
    const canonical = realpathSync.native(scratch);

    const isolated = createTrustedProfileResolverForTests(
      makeDependencies({ userInfo: () => ({ homedir: scratch }), realpath: () => canonical })
        .dependencies,
    );
    expect(isolated()).toBe(canonical);
    expect(trustedProfileDirectory()).toBe(productive);

    resetTrustedProfileCacheForTests();
    expect(trustedProfileDirectory()).toBe(productive);
  });
});

// ── The productive resolver ────────────────────────────────────────────────

describe('the productive resolver', () => {
  it('returns an absolute, canonical, existing directory', () => {
    const profile = trustedProfileDirectory();
    expect(profile.length).toBeGreaterThan(0);
    expect(isAbsolute(profile)).toBe(true);
    expect(profile).toBe(realpathSync.native(profile));
    expect(profile.includes(NUL)).toBe(false);
    expect(statSync(profile).isDirectory()).toBe(true);
  });

  it('is stable across calls and across a cache reset', () => {
    const first = trustedProfileDirectory();
    expect(trustedProfileDirectory()).toBe(first);
    resetTrustedProfileCacheForTests();
    expect(trustedProfileDirectory()).toBe(first);
  });

  it('takes no argument, so no caller can supply a profile path', () => {
    expect(trustedProfileDirectory.length).toBe(0);
  });
});

// ── 8.4 Real Windows environment spoofing ──────────────────────────────────

/**
 * The eleven variables the pre-implementation probe manipulated. Each decoy is
 * a path that does not exist, so accepting one could not silently look correct.
 */
const SPOOFED_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  USERPROFILE: 'Z:\\ao-spoof\\profile',
  HOME: 'Z:\\ao-spoof\\home',
  HOMEDRIVE: 'Z:',
  HOMEPATH: '\\ao-spoof\\homepath',
  APPDATA: 'Z:\\ao-spoof\\appdata',
  LOCALAPPDATA: 'Z:\\ao-spoof\\localappdata',
  SystemRoot: 'Z:\\ao-spoof\\winnt',
  windir: 'Z:\\ao-spoof\\winnt',
  ComSpec: 'Z:\\ao-spoof\\cmd',
  PATH: 'Z:\\ao-spoof\\bin',
  PATHEXT: '.AO-SPOOF',
});

/**
 * The subset that is safe to manipulate in a *spawned* process.
 *
 * `SystemRoot` and `windir` are deliberately excluded: the AO-WINPROFILE-001
 * pre-implementation probe reproducibly showed Node v24.18.1 aborting during
 * process initialisation with exit 134 (`Assertion failed: ncrypto::CSPRNG`)
 * when they point somewhere invalid — before any JavaScript runs, so the child
 * could never reach the resolver at all. The in-process case below covers those
 * two, and covers them under the threat model that actually matters: an
 * environment the running orchestrator inherited.
 */
const CHILD_SPOOFED_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  USERPROFILE: SPOOFED_ENVIRONMENT['USERPROFILE'] ?? '',
  HOME: SPOOFED_ENVIRONMENT['HOME'] ?? '',
  HOMEDRIVE: SPOOFED_ENVIRONMENT['HOMEDRIVE'] ?? '',
  HOMEPATH: SPOOFED_ENVIRONMENT['HOMEPATH'] ?? '',
  APPDATA: SPOOFED_ENVIRONMENT['APPDATA'] ?? '',
  LOCALAPPDATA: SPOOFED_ENVIRONMENT['LOCALAPPDATA'] ?? '',
  PATH: SPOOFED_ENVIRONMENT['PATH'] ?? '',
  PATHEXT: SPOOFED_ENVIRONMENT['PATHEXT'] ?? '',
});

describe('no environment variable can move the trusted profile', () => {
  it('ignores all eleven manipulated variables in this process', () => {
    resetTrustedProfileCacheForTests();
    const baseline = trustedProfileDirectory();

    const saved = new Map<string, string | undefined>();
    for (const name of Object.keys(SPOOFED_ENVIRONMENT)) saved.set(name, process.env[name]);

    try {
      for (const [name, decoy] of Object.entries(SPOOFED_ENVIRONMENT)) {
        process.env[name] = decoy;
      }
      resetTrustedProfileCacheForTests();

      const underSpoofing = trustedProfileDirectory();
      // Compared against the baseline, never printed: a failing assertion must
      // not put either the real profile or a decoy into the output.
      expect(underSpoofing === baseline).toBe(true);
    } finally {
      for (const [name, previous] of saved) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
      resetTrustedProfileCacheForTests();
    }

    // The environment is exactly what it was before.
    for (const [name, previous] of saved) {
      expect(process.env[name]).toBe(previous);
    }
    expect(trustedProfileDirectory()).toBe(baseline);
  });

  it('ignores the manipulated variables in a separate real process', () => {
    // Test infrastructure only: process.execPath names the Node binary running
    // this suite. It is never a profile source.
    const tsx = join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const helper = join(PACKAGE_ROOT, 'tests', 'helpers', 'print-trusted-profile.ts');
    const prefix = 'TRUSTED-PROFILE ';

    function resolveInChild(overrides: NodeJS.ProcessEnv): { profile?: string; error?: string } {
      const stdout = execFileSync(process.execPath, [tsx, helper], {
        env: { ...process.env, ...overrides },
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
        shell: false,
      });
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith(prefix));
      expect(line, 'no delimited line in child output').toBeDefined();
      return JSON.parse((line ?? '').slice(prefix.length)) as { profile?: string; error?: string };
    }

    const baseline = resolveInChild({});
    expect(baseline.error).toBeUndefined();
    expect(baseline.profile).toBeDefined();

    const spoofed = resolveInChild({ ...CHILD_SPOOFED_ENVIRONMENT });
    expect(spoofed.error).toBeUndefined();
    expect(spoofed.profile === baseline.profile).toBe(true);

    for (const decoy of Object.values(CHILD_SPOOFED_ENVIRONMENT)) {
      expect(spoofed.profile?.startsWith(decoy)).toBe(false);
    }
  }, 180_000);

  it('does not inherit a loader variable into the resolution', () => {
    const dir = makeTempDir();
    const preload = join(dir, 'preload.cjs');
    writeFileSync(preload, 'process.stdout.write("PRELOADED\\n");\n', 'utf8');

    const tsx = join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const helper = join(PACKAGE_ROOT, 'tests', 'helpers', 'print-trusted-profile.ts');
    const prefix = 'TRUSTED-PROFILE ';

    const stdout = execFileSync(process.execPath, [tsx, helper], {
      env: {
        ...process.env,
        ...CHILD_SPOOFED_ENVIRONMENT,
        NODE_OPTIONS: `--require=${preload.replace(/\\/g, '/')}`,
      },
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      shell: false,
    });

    const line = stdout.split(/\r?\n/).find((l) => l.startsWith(prefix));
    const parsed = JSON.parse((line ?? '').slice(prefix.length)) as { profile?: string };
    expect(parsed.profile).toBe(trustedProfileDirectory());
  }, 180_000);
});

// ── 8.5 No subprocess, no shell, no environment in the resolver ────────────

/**
 * These assertions run against the **whole** source file, comments included.
 *
 * There used to be a line-based comment filter here so that the module's
 * historical prose — which named the removed mechanism — would not trip the
 * scan. That filter was the weakness: a line filter cannot tell a comment from
 * a string, a template literal, or executable code that happens to follow a
 * closing delimiter on the same line (AO-WINPROFILE-001-R1, REV-02). The prose
 * was rewritten to describe only what the module does now, so no filter is
 * needed and none is used.
 */
describe('the resolver module starts no process and reads no environment', () => {
  const source = readFileSync(
    join(PACKAGE_ROOT, 'src', 'config', 'internal', 'trusted-profile.ts'),
    'utf8',
  );

  it('imports no process-spawning module', () => {
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('spawnSync');
    expect(source).not.toContain('execFileSync');
    expect(source).not.toContain('runCommand');
    expect(source).not.toContain('doctor/exec');
  });

  it('names no shell or interpreter', () => {
    expect(source).not.toMatch(/powershell/i);
    expect(source).not.toMatch(/pwsh/i);
    expect(source).not.toMatch(/\bcmd\b/i);
    expect(source).not.toMatch(/System32/i);
  });

  it('derives nothing from the running Node binary or from the search list', () => {
    expect(source).not.toContain('execPath');
    expect(source).not.toContain('process.env');
    expect(source).not.toMatch(/\bPATH\b/);
  });

  it('names no profile environment variable anywhere in the file', () => {
    expect(source).not.toMatch(/USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA/);
  });

  it('does not import os.homedir', () => {
    expect(source).not.toMatch(/^\s*import\s*\{[^}]*homedir/m);
    expect(source).not.toContain('homedir()');
    // The one permitted reading of the name: the field of the userInfo result.
    expect(source).toContain('userInfo');
  });

  it('carries none of the removed helper constants', () => {
    for (const removed of [
      'HELPER_OUTPUT_PREFIX',
      'HELPER_SOURCE',
      'WINDOWS_HELPER_COMMAND',
      'windowsPowerShellPath',
      'helperInvocation',
      'parseHelperOutput',
    ]) {
      expect(source).not.toContain(removed);
    }
  });
});

// ── 8.6 The productive call site is unchanged ──────────────────────────────

describe('the productive call site still goes through the path provider', () => {
  it('resolves OS_PATH_PROVIDER.homeDirectory lazily through the resolver', async () => {
    const { OS_PATH_PROVIDER } = await import('../src/config/internal/path-provider.js');
    expect(OS_PATH_PROVIDER.homeDirectory).toBe(trustedProfileDirectory());

    resetTrustedProfileCacheForTests();
    expect(OS_PATH_PROVIDER.homeDirectory).toBe(trustedProfileDirectory());
  });
});
