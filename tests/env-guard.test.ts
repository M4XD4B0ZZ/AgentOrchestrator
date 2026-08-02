import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  assessEnvironment,
  createProbeEnv,
  FORBIDDEN_CHILD_ENV_VARS,
  LOADER_INJECTION_ENV_VARS,
  OBSERVED_PROVIDER_ENV_VARS,
  presenceOf,
  probeEnvAllowlist,
  PROBE_ENV_COLLISION_CODE,
  PROBE_ENV_COLLISION_MESSAGE,
  PROBE_ENV_POLICIES,
  PROBE_ENV_UNREADABLE_CODE,
  PROBE_ENV_UNREADABLE_MESSAGE,
  ProbeEnvironmentCollisionError,
  ProbeEnvironmentUnreadableError,
  UnknownProbeEnvPolicyError,
  WITHHELD_AUTH_ENV_VARS,
  type ProbeEnvPolicy,
} from '../src/auth/env-guard.js';
import { formatSafeError } from '../src/core/safe-error.js';

const SECRET_VALUES: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-secret-value-aaaaaaaaaaaa',
  ANTHROPIC_AUTH_TOKEN: 'auth-token-secret-bbbbbbbbbbbb',
  OPENAI_API_KEY: 'sk-openai-secret-value-cccccccccc',
  CODEX_API_KEY: 'codex-secret-value-dddddddddddd',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-subscription-token-eeeeeeee',
};

function pollutedEnv(): NodeJS.ProcessEnv {
  return { ...SECRET_VALUES, PATH: '/usr/bin', LANG: 'en_US.UTF-8' };
}

/**
 * The platform is stubbed rather than inferred from the host, so both halves of
 * every platform-dependent rule are exercised on every machine instead of one
 * half being skipped.
 */
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original);
  }
}

const onWindows = <T,>(run: () => T): T => withPlatform('win32', run);
const onPosix = <T,>(run: () => T): T => withPlatform('linux', run);

describe('createProbeEnv builds, rather than cleans, an environment', () => {
  it.each(PROBE_ENV_POLICIES)('gives %s no credential variable at all', (policy) => {
    const env = createProbeEnv(policy, pollutedEnv());
    for (const name of [...FORBIDDEN_CHILD_ENV_VARS, ...WITHHELD_AUTH_ENV_VARS]) {
      expect(env).not.toHaveProperty(name);
      expect(env[name]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain('secret');
  });

  it.each(PROBE_ENV_POLICIES)('drops every unlisted variable for %s', (policy) => {
    const env = createProbeEnv(policy, { ...pollutedEnv(), LANG: 'en_US.UTF-8', AO_UNKNOWN_ENV: 'x' });
    expect(env['LANG']).toBeUndefined();
    expect(env['AO_UNKNOWN_ENV']).toBeUndefined();
    // Only names the policy itself allows survive.
    for (const name of Object.keys(env)) {
      expect(probeEnvAllowlist(policy)).toContain(name);
    }
  });

  it.each(PROBE_ENV_POLICIES)('keeps %s startable by forwarding the exec contract', (policy) => {
    const env = createProbeEnv(policy, { PATH: '/usr/bin', PATHEXT: '.CMD', COMSPEC: 'C:\\cmd.exe' });
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('does not mutate the input object', () => {
    const source = pollutedEnv();
    const snapshot = { ...source };
    for (const policy of PROBE_ENV_POLICIES) createProbeEnv(policy, source);
    expect(source).toEqual(snapshot);
    for (const name of Object.keys(SECRET_VALUES)) {
      expect(source[name]).toBe(SECRET_VALUES[name]);
    }
  });

  it('does not modify the real process environment', () => {
    const before = { ...process.env };
    for (const policy of PROBE_ENV_POLICIES) createProbeEnv(policy, process.env);
    expect({ ...process.env }).toEqual(before);
  });

  it('returns a new, independent, frozen object every time', () => {
    const source = pollutedEnv();
    const first = createProbeEnv('capability:generic', source);
    const second = createProbeEnv('capability:generic', source);

    expect(first).not.toBe(source);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('treats an empty value as absent rather than forwarding it', () => {
    expect(createProbeEnv('capability:generic', { PATH: '' })).toEqual({});
  });

  it('is idempotent: re-applying a policy to its own output changes nothing', () => {
    const once = createProbeEnv('auth:claude', pollutedEnv());
    expect(createProbeEnv('auth:claude', once)).toEqual(once);
  });

  it('fails closed on a policy name it does not know', () => {
    for (const unknown of ['', 'capability', 'auth:openai', 'CAPABILITY:GENERIC', 'default']) {
      expect(() => createProbeEnv(unknown as ProbeEnvPolicy, pollutedEnv())).toThrow(
        UnknownProbeEnvPolicyError,
      );
      expect(() => probeEnvAllowlist(unknown as ProbeEnvPolicy)).toThrow(UnknownProbeEnvPolicyError);
    }
  });

  it('puts no environment data into the fail-closed error', () => {
    let message = '';
    try {
      createProbeEnv('nope' as ProbeEnvPolicy, pollutedEnv());
    } catch (error) {
      message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    }
    expect(message).not.toBe('');
    for (const value of Object.values(SECRET_VALUES)) expect(message).not.toContain(value);
    // Not even the rejected name is echoed back.
    expect(message).not.toContain('nope');
  });

  it('offers no way to loosen a policy at runtime', () => {
    const allowlist = probeEnvAllowlist('capability:generic');
    // The returned list is the policy's own array; mutating it must not be a
    // path to a wider environment on the next call.
    expect(() => {
      (allowlist as string[]).push('CLAUDE_CODE_OAUTH_TOKEN');
    }).toThrow();
    expect(createProbeEnv('capability:generic', pollutedEnv())['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });
});

/**
 * AO-FOUNDATION-REM-003A-RR-01 — two spellings of one Windows variable.
 *
 * Windows itself cannot hold `Path` and `pAtH` at the same time; a plain object
 * can, and the previous implementation then forwarded whichever of the two was
 * inserted first. These tests pin the replacement: every ambiguous case is
 * refused, in either insertion order, for every allow-listed variable — and
 * POSIX, where the two really are different variables, is untouched by it.
 *
 * The platform is stubbed rather than inferred from the host, so both halves of
 * the rule are exercised on every machine instead of one half being skipped.
 */
describe('two spellings of one Windows variable are refused, not resolved', () => {
  const FIRST = 'AO_SENTINEL_FIRST_VALUE';
  const SECOND = 'AO_SENTINEL_SECOND_VALUE';
  const THIRD = 'AO_SENTINEL_THIRD_VALUE';
  const SENTINELS = [FIRST, SECOND, THIRD];

  it('confirms the platform stub actually reaches the guard', () => {
    // Without this, a broken stub would make every POSIX case below vacuous.
    expect(onPosix(() => createProbeEnv('capability:generic', { Path: FIRST }))).toEqual({});
    expect(onWindows(() => createProbeEnv('capability:generic', { Path: FIRST }))).toEqual({
      PATH: FIRST,
    });
  });

  // ── 1-5: every ambiguous shape, in both orders ───────────────────────────
  it.each([
    ['two non-canonical spellings', { Path: FIRST, pAtH: SECOND }],
    ['the same two, inserted the other way round', { pAtH: SECOND, Path: FIRST }],
    ['the canonical key plus one alias', { PATH: FIRST, Path: SECOND }],
    ['the same two, alias first', { Path: SECOND, PATH: FIRST }],
    ['three spellings', { PATH: FIRST, Path: SECOND, pAtH: THIRD }],
    ['three spellings, none canonical', { Path: FIRST, pAtH: SECOND, patH: THIRD }],
    ['a collision in which one value is empty', { PATH: '', Path: FIRST }],
  ])('fails closed on %s', (_label, source) => {
    expect(() => onWindows(() => createProbeEnv('capability:generic', source))).toThrow(
      ProbeEnvironmentCollisionError,
    );
  });

  it('applies the same rule to a profile variable, not just to PATH', () => {
    for (const source of [
      { USERPROFILE: FIRST, UserProfile: SECOND },
      { UserProfile: SECOND, USERPROFILE: FIRST },
      { userprofile: FIRST, UsErPrOfIlE: SECOND },
      { HOME: FIRST, Home: SECOND },
      { Home: SECOND, HOME: FIRST },
    ]) {
      expect(() => onWindows(() => createProbeEnv('auth:claude', source))).toThrow(
        ProbeEnvironmentCollisionError,
      );
    }
  });

  it('reaches the same verdict through every policy and every call order', () => {
    const collide = { PATH: FIRST, Path: SECOND };
    for (const policy of PROBE_ENV_POLICIES) {
      expect(() => onWindows(() => createProbeEnv(policy, collide))).toThrow(
        ProbeEnvironmentCollisionError,
      );
    }
    // Order-independence stated directly: neither permutation resolves.
    const permutations = [
      { PATH: FIRST, Path: SECOND },
      { Path: SECOND, PATH: FIRST },
    ];
    const thrown = permutations.map((source) => {
      try {
        onWindows(() => createProbeEnv('capability:generic', source));
        return null;
      } catch (error) {
        return error;
      }
    });
    expect(thrown.every((error) => error instanceof ProbeEnvironmentCollisionError)).toBe(true);
    expect(thrown.map((error) => (error as Error).message)).toEqual([
      PROBE_ENV_COLLISION_MESSAGE,
      PROBE_ENV_COLLISION_MESSAGE,
    ]);
    expect(thrown.map((error) => (error as ProbeEnvironmentCollisionError).code)).toEqual([
      PROBE_ENV_COLLISION_CODE,
      PROBE_ENV_COLLISION_CODE,
    ]);
  });

  it('gives no spelling precedence — not the canonical one, not sorting', () => {
    // If any precedence rule existed, at least one of these would resolve.
    for (const source of [
      { PATH: FIRST, Path: SECOND },
      { Path: FIRST, PATH: SECOND },
      { PATH: FIRST, path: SECOND },
      { path: FIRST, PATH: SECOND },
    ]) {
      expect(() => onWindows(() => createProbeEnv('capability:generic', source))).toThrow(
        ProbeEnvironmentCollisionError,
      );
    }
  });

  // ── 6: a single spelling still works ─────────────────────────────────────
  it('canonicalises a single non-canonical Windows key', () => {
    const env = onWindows(() =>
      createProbeEnv('auth:claude', {
        Path: FIRST,
        PathExt: '.CMD',
        UserProfile: SECOND,
      }),
    );
    expect(Object.keys(env)).toEqual(['PATH', 'PATHEXT', 'USERPROFILE']);
    expect(env['PATH']).toBe(FIRST);
    expect(env['USERPROFILE']).toBe(SECOND);
  });

  /** AO-FOUNDATION-REM-003B: these are no longer part of any policy at all. */
  it('never canonicalises SystemRoot, windir or COMSPEC into any policy output', () => {
    const env = onWindows(() =>
      createProbeEnv('auth:claude', {
        Path: FIRST,
        systemroot: 'C:\\ao-windows',
        WinDir: 'C:\\ao-windows',
        comspec: 'C:\\ao-windows\\System32\\cmd.exe',
        UserProfile: SECOND,
      }),
    );
    expect(Object.keys(env)).toEqual(['PATH', 'USERPROFILE']);
  });

  // ── 7: POSIX stays case-sensitive ────────────────────────────────────────
  it('keeps POSIX exact: Path and path are not PATH', () => {
    const env = onPosix(() =>
      createProbeEnv('auth:claude', {
        PATH: FIRST,
        Path: SECOND,
        path: THIRD,
        USERPROFILE: FIRST,
        UserProfile: SECOND,
      }),
    );
    expect(env['PATH']).toBe(FIRST);
    expect(env['USERPROFILE']).toBe(FIRST);
    expect(Object.keys(env)).toEqual(['PATH', 'USERPROFILE']);
  });

  it('runs no collision logic on POSIX, where the keys are different variables', () => {
    for (const source of [
      { PATH: FIRST, Path: SECOND, pAtH: THIRD },
      { Path: FIRST, pAtH: SECOND },
      { HOME: FIRST, Home: SECOND },
    ]) {
      expect(() => onPosix(() => createProbeEnv('auth:claude', source))).not.toThrow();
    }
    // A non-canonical spelling is simply not the variable, so it is dropped.
    expect(onPosix(() => createProbeEnv('capability:generic', { Path: FIRST }))).toEqual({});
  });

  // ── 8: nothing about the environment escapes in the error ────────────────
  it('puts no environment value into the error, its rendering or its JSON', () => {
    let thrown: unknown;
    try {
      onWindows(() =>
        createProbeEnv('auth:claude', {
          Path: FIRST,
          pAtH: SECOND,
          CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUES['CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProbeEnvironmentCollisionError);
    const rendered = [
      (thrown as Error).message,
      (thrown as Error).stack ?? '',
      formatSafeError(thrown),
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown ?? {})),
      String(thrown),
    ].join('\n');

    for (const value of [...SENTINELS, ...Object.values(SECRET_VALUES)]) {
      expect(rendered).not.toContain(value);
    }
    // Not even which variable collided, nor in which order it was inserted.
    expect((thrown as Error).message).toBe(PROBE_ENV_COLLISION_MESSAGE);
    expect((thrown as Error).message).not.toContain('PATH');
    expect((thrown as Error).message).not.toContain('Path');
    expect(formatSafeError(thrown)).not.toContain('PATH');
  });

  // ── 9/10: the input survives, and nothing partial comes back ─────────────
  it('leaves the input map and the real process environment untouched', () => {
    const source: NodeJS.ProcessEnv = { PATH: FIRST, Path: SECOND, PATHEXT: '.CMD' };
    const snapshot = { ...source };
    const keysBefore = Object.keys(source);
    const processEnvBefore = { ...process.env };

    expect(() => onWindows(() => createProbeEnv('capability:generic', source))).toThrow(
      ProbeEnvironmentCollisionError,
    );

    expect(source).toEqual(snapshot);
    expect(Object.keys(source)).toEqual(keysBefore);
    expect({ ...process.env }).toEqual(processEnvBefore);
  });

  it('returns nothing at all — not a partial environment — after a collision', () => {
    // PATH and PATHEXT resolve cleanly (SystemRoot/windir/COMSPEC are not part
    // of any policy as of AO-FOUNDATION-REM-003B and are simply ignored here);
    // the collision is on USERPROFILE, the *last* name auth:claude asks for. If
    // the map under construction could escape, this is where it would.
    let result: NodeJS.ProcessEnv | undefined;
    let thrown: unknown;
    try {
      result = onWindows(() =>
        createProbeEnv('auth:claude', {
          PATH: 'C:\\ao-path',
          PATHEXT: '.CMD',
          SystemRoot: 'C:\\ao-windows',
          windir: 'C:\\ao-windows',
          COMSPEC: 'C:\\ao-windows\\System32\\cmd.exe',
          HOME: 'C:\\ao-profile',
          USERPROFILE: FIRST,
          UserProfile: SECOND,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProbeEnvironmentCollisionError);
    expect(result).toBeUndefined();
  });
});

/**
 * AO-FOUNDATION-REM-003A-R1-REVIEW-01/-02 — the source is read once, and only
 * its own enumerable properties are read at all.
 *
 * Two defects are pinned here. Both were reproduced against the built artefact
 * before the fix, with these same sentinels:
 *
 *  1. an own enumerable getter under `Path` that deleted `pAtH` when read made
 *     the Windows collision check depend on definition order — getter first
 *     produced `{ PATH: … }`, alias first produced the collision error. The
 *     source could therefore choose whether the rule applied to it;
 *  2. the POSIX lookup was a plain `source[name]` read, so an inherited `PATH`
 *     (`Object.create({ PATH })`) and an own *non-enumerable* `PATH` were both
 *     forwarded to a probe although neither is part of what the caller's map
 *     presents as its contents.
 *
 * Every value below is an obvious sentinel. Nothing here reads a credential
 * store or starts a process.
 */
describe('the source environment is snapshotted once, from its own enumerable properties', () => {
  const FIRST = 'AO_SENTINEL_FIRST_VALUE';
  const SECOND = 'AO_SENTINEL_SECOND_VALUE';
  const THIRD = 'AO_SENTINEL_THIRD_VALUE';
  const GETTER_SECRET = 'AO_SENTINEL_GETTER_THREW_THIS';
  const TRAP_SECRET = 'AO_SENTINEL_TRAP_THREW_THIS';
  const INHERITED = 'AO_SENTINEL_INHERITED_VALUE';
  const HIDDEN = 'AO_SENTINEL_NON_ENUMERABLE_VALUE';
  /** The value a descriptor trap tries to pass off as a plain `PATH`. */
  const MASKED = 'AO_SENTINEL_MASKED_ACCESSOR_VALUE';
  const SENTINELS = [FIRST, SECOND, THIRD, GETTER_SECRET, TRAP_SECRET, INHERITED, HIDDEN, MASKED];

  /** Every way an error can be looked at, joined for a single leak assertion. */
  function rendered(error: unknown): string {
    return [
      error instanceof Error ? error.message : '',
      error instanceof Error ? (error.stack ?? '') : '',
      formatSafeError(error),
      JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})),
      JSON.stringify(error),
      String(error),
    ].join('\n');
  }

  function capture(run: () => NodeJS.ProcessEnv): {
    result: NodeJS.ProcessEnv | undefined;
    error: unknown;
  } {
    try {
      return { result: run(), error: undefined };
    } catch (error) {
      return { result: undefined, error };
    }
  }

  /** Counts every read of the getter it installs, and mutates while doing it. */
  function defineMutatingGetter(
    source: NodeJS.ProcessEnv,
    key: string,
    deletes: string,
    value: string,
    counter: { calls: number },
  ): void {
    Object.defineProperty(source, key, {
      enumerable: true,
      configurable: true,
      get(): string {
        counter.calls += 1;
        // The bypass: by the time the next name is looked up, the colliding
        // alias is gone.
        delete (source as Record<string, unknown>)[deletes];
        return value;
      },
    });
  }

  // ── 8.1 A mutating getter cannot remove a collision, in either order ──────

  const mutatingShapes: readonly [string, (counter: { calls: number }) => NodeJS.ProcessEnv][] = [
    [
      'the mutating getter is defined first',
      (counter) => {
        const source: NodeJS.ProcessEnv = {};
        defineMutatingGetter(source, 'Path', 'pAtH', FIRST, counter);
        source['pAtH'] = SECOND;
        return source;
      },
    ],
    [
      'the alias it deletes is defined first',
      (counter) => {
        const source: NodeJS.ProcessEnv = {};
        source['pAtH'] = SECOND;
        defineMutatingGetter(source, 'Path', 'pAtH', FIRST, counter);
        return source;
      },
    ],
    [
      'the canonical name is a plain value and the alias is a mutating getter',
      (counter) => {
        const source: NodeJS.ProcessEnv = { PATH: FIRST };
        defineMutatingGetter(source, 'Path', 'PATH', SECOND, counter);
        return source;
      },
    ],
    [
      'the canonical name is the mutating getter and the alias is a plain value',
      (counter) => {
        const source: NodeJS.ProcessEnv = {};
        defineMutatingGetter(source, 'PATH', 'Path', FIRST, counter);
        source['Path'] = SECOND;
        return source;
      },
    ],
    [
      'three spellings, one of them a mutating getter',
      (counter) => {
        const source: NodeJS.ProcessEnv = { PATH: FIRST, Path: SECOND };
        defineMutatingGetter(source, 'pAtH', 'Path', THIRD, counter);
        return source;
      },
    ],
  ];

  it.each(mutatingShapes)('refuses the collision when %s', (_label, build) => {
    const counter = { calls: 0 };
    const source = build(counter);

    const { result, error } = capture(() => onWindows(() => createProbeEnv('capability:generic', source)));

    expect(error).toBeInstanceOf(ProbeEnvironmentCollisionError);
    expect((error as ProbeEnvironmentCollisionError).code).toBe(PROBE_ENV_COLLISION_CODE);
    // The one static text, identical for every shape and every order above.
    expect((error as Error).message).toBe(PROBE_ENV_COLLISION_MESSAGE);
    // No PATH map, not even a partial one.
    expect(result).toBeUndefined();
    // The getter was never run, so it never had the chance to remove the alias.
    expect(counter.calls).toBe(0);
    for (const sentinel of SENTINELS) expect(rendered(error)).not.toContain(sentinel);
  });

  it('leaves the source untouched, because nothing in it was executed', () => {
    const counter = { calls: 0 };
    const source: NodeJS.ProcessEnv = {};
    defineMutatingGetter(source, 'Path', 'pAtH', FIRST, counter);
    source['pAtH'] = SECOND;

    expect(() => onWindows(() => createProbeEnv('capability:generic', source))).toThrow(
      ProbeEnvironmentCollisionError,
    );

    expect(Object.keys(source)).toEqual(['Path', 'pAtH']);
    expect(counter.calls).toBe(0);
  });

  // ── 8.2 Own, enumerable, string-named — on both platforms ────────────────

  const platforms: readonly [string, <T>(run: () => T) => T][] = [
    ['windows', onWindows],
    ['posix', onPosix],
  ];

  it.each(platforms)('ignores an inherited allow-listed key on %s', (_label, on) => {
    const source = Object.create({ PATH: INHERITED, USERPROFILE: INHERITED }) as NodeJS.ProcessEnv;
    expect(on(() => createProbeEnv('auth:claude', source))).toEqual({});
  });

  it.each(platforms)('ignores an own non-enumerable allow-listed key on %s', (_label, on) => {
    const source: NodeJS.ProcessEnv = {};
    Object.defineProperty(source, 'PATH', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: HIDDEN,
    });
    expect(on(() => createProbeEnv('capability:generic', source))).toEqual({});
  });

  it.each(platforms)('accepts an own enumerable data property on %s', (_label, on) => {
    expect(on(() => createProbeEnv('capability:generic', { PATH: FIRST }))).toEqual({ PATH: FIRST });
  });

  it.each(platforms)('ignores a symbol-keyed property on %s', (_label, on) => {
    const source: NodeJS.ProcessEnv = { PATH: FIRST };
    Object.defineProperty(source, Symbol('PATH'), {
      enumerable: true,
      configurable: true,
      value: SECOND,
    });
    expect(on(() => createProbeEnv('capability:generic', source))).toEqual({ PATH: FIRST });
  });

  it.each(platforms)('reads a null-prototype object on %s', (_label, on) => {
    const source = Object.assign(Object.create(null) as NodeJS.ProcessEnv, {
      PATH: FIRST,
      AO_UNKNOWN_ENV: SECOND,
    });
    expect(on(() => createProbeEnv('capability:generic', source))).toEqual({ PATH: FIRST });
  });

  it.each(platforms)('ignores own keys no policy names on %s', (_label, on) => {
    const env = on(() =>
      createProbeEnv('capability:generic', {
        PATH: FIRST,
        AO_UNKNOWN_ENV: SECOND,
        ANTHROPIC_API_KEY: SECRET_VALUES['ANTHROPIC_API_KEY'] ?? '',
      }),
    );
    expect(env).toEqual({ PATH: FIRST });
  });

  it('keeps POSIX exact even for own enumerable properties', () => {
    const source = Object.assign(Object.create({ PATH: INHERITED }) as NodeJS.ProcessEnv, {
      Path: SECOND,
      path: THIRD,
    });
    // `Path` and `path` are not `PATH` there, and the prototype is not the map.
    expect(onPosix(() => createProbeEnv('capability:generic', source))).toEqual({});
    expect(onPosix(() => createProbeEnv('capability:generic', { PATH: FIRST, Path: SECOND }))).toEqual(
      { PATH: FIRST },
    );
  });

  // ── 8.3 An accessor under an allow-listed name is refused, not run ────────

  const accessorCases: readonly [string, string, ProbeEnvPolicy][] = [
    ['PATH', 'PATH', 'capability:generic'],
    ['HOME', 'HOME', 'auth:claude'],
    ['USERPROFILE', 'USERPROFILE', 'auth:claude'],
  ];

  it.each(accessorCases)('refuses a lone %s accessor without calling it', (_label, key, policy) => {
    for (const [, on] of platforms) {
      const counter = { calls: 0 };
      const source: NodeJS.ProcessEnv = {};
      Object.defineProperty(source, key, {
        enumerable: true,
        configurable: true,
        get(): string {
          counter.calls += 1;
          return FIRST;
        },
      });

      const { result, error } = capture(() => on(() => createProbeEnv(policy, source)));

      expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
      expect((error as ProbeEnvironmentUnreadableError).code).toBe(PROBE_ENV_UNREADABLE_CODE);
      expect((error as Error).message).toBe(PROBE_ENV_UNREADABLE_MESSAGE);
      expect(result).toBeUndefined();
      expect(counter.calls).toBe(0);
    }
  });

  it('never lets a throwing getter put its own text into the failure', () => {
    const source: NodeJS.ProcessEnv = {};
    Object.defineProperty(source, 'PATH', {
      enumerable: true,
      configurable: true,
      get(): string {
        throw new Error(GETTER_SECRET);
      },
    });

    const { error } = capture(() => onWindows(() => createProbeEnv('capability:generic', source)));

    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    const text = rendered(error);
    for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    expect(text).not.toContain('PATH');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('refuses the accessor even when every other allow-listed name is fine', () => {
    const source: NodeJS.ProcessEnv = { PATH: FIRST, PATHEXT: '.CMD', HOME: SECOND };
    Object.defineProperty(source, 'USERPROFILE', {
      enumerable: true,
      configurable: true,
      get: () => THIRD,
    });

    const { result, error } = capture(() => onWindows(() => createProbeEnv('auth:claude', source)));

    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    // Nothing partial: the four names that resolved cleanly are discarded too.
    expect(result).toBeUndefined();
  });

  it('checks every collision before it rejects an accessor', () => {
    // `PATH` collides and `USERPROFILE` is an accessor. The collision verdict is
    // reached first, which is what "all collisions, then values" means.
    const source: NodeJS.ProcessEnv = { PATH: FIRST, Path: SECOND };
    Object.defineProperty(source, 'USERPROFILE', {
      enumerable: true,
      configurable: true,
      get: () => THIRD,
    });

    const { error } = capture(() => onWindows(() => createProbeEnv('auth:claude', source)));
    expect(error).toBeInstanceOf(ProbeEnvironmentCollisionError);
  });

  // ── 8.4 A source that answers through traps is refused before it is read ──

  /**
   * Every trap a source could answer through, each counted separately.
   *
   * A proxied source must be refused *before* any of these can run, so every
   * counter staying at zero is the assertion — not just that the call failed,
   * but that the source was never given a chance to speak.
   */
  interface TrapCounts {
    defineProperty: number;
    deleteProperty: number;
    get: number;
    getOwnPropertyDescriptor: number;
    getPrototypeOf: number;
    has: number;
    isExtensible: number;
    ownKeys: number;
    preventExtensions: number;
    set: number;
    setPrototypeOf: number;
  }

  function trapCounts(): TrapCounts {
    return {
      defineProperty: 0,
      deleteProperty: 0,
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      has: 0,
      isExtensible: 0,
      ownKeys: 0,
      preventExtensions: 0,
      set: 0,
      setPrototypeOf: 0,
    };
  }

  const totalTraps = (counts: TrapCounts): number =>
    Object.values(counts).reduce((sum, calls) => sum + calls, 0);

  /**
   * A handler that traps everything and otherwise behaves exactly like its
   * target, so the proxy is refused for *being* one rather than for misbehaving.
   */
  function countingHandler(
    counts: TrapCounts,
    overrides: ProxyHandler<NodeJS.ProcessEnv> = {},
  ): ProxyHandler<NodeJS.ProcessEnv> {
    const base: ProxyHandler<NodeJS.ProcessEnv> = {
      defineProperty(t, key, descriptor): boolean {
        counts.defineProperty += 1;
        return Reflect.defineProperty(t, key, descriptor);
      },
      deleteProperty(t, key): boolean {
        counts.deleteProperty += 1;
        return Reflect.deleteProperty(t, key);
      },
      get(t, key, receiver): unknown {
        counts.get += 1;
        return Reflect.get(t, key, receiver);
      },
      getOwnPropertyDescriptor(t, key): PropertyDescriptor | undefined {
        counts.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      getPrototypeOf(t): object | null {
        counts.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(t);
      },
      has(t, key): boolean {
        counts.has += 1;
        return Reflect.has(t, key);
      },
      isExtensible(t): boolean {
        counts.isExtensible += 1;
        return Reflect.isExtensible(t);
      },
      ownKeys(t): (string | symbol)[] {
        counts.ownKeys += 1;
        return Reflect.ownKeys(t);
      },
      preventExtensions(t): boolean {
        counts.preventExtensions += 1;
        return Reflect.preventExtensions(t);
      },
      set(t, key, value, receiver): boolean {
        counts.set += 1;
        return Reflect.set(t, key, value, receiver);
      },
      setPrototypeOf(t, prototype): boolean {
        counts.setPrototypeOf += 1;
        return Reflect.setPrototypeOf(t, prototype);
      },
    };
    return { ...base, ...overrides };
  }

  /** A plain data map shaped like a real environment block. */
  const envShaped = (): NodeJS.ProcessEnv => ({
    PATH: FIRST,
    PATHEXT: '.CMD',
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
  });

  /** Asserts the one verdict every proxied source gets, whatever it wraps. */
  function expectRefusedUnread(result: unknown, error: unknown): void {
    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    expect((error as ProbeEnvironmentUnreadableError).code).toBe(PROBE_ENV_UNREADABLE_CODE);
    // The one static text — identical for every proxy shape below, so it says
    // nothing about which kind of source was refused.
    expect((error as Error).message).toBe(PROBE_ENV_UNREADABLE_MESSAGE);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    // No environment at all, not even a partial one.
    expect(result).toBeUndefined();
    for (const sentinel of SENTINELS) expect(rendered(error)).not.toContain(sentinel);
  }

  const proxySources: readonly [string, (counts: TrapCounts) => NodeJS.ProcessEnv][] = [
    // A proxy with no handler of its own still cannot be trusted to describe
    // itself the same way twice, so transparency earns it nothing.
    ['a transparent proxy with no traps of its own', () => new Proxy(envShaped(), {})],
    ['a proxy that faithfully delegates every trap', (counts) => new Proxy(envShaped(), countingHandler(counts))],
    [
      'a proxy around a null-prototype object',
      (counts) =>
        new Proxy(
          Object.assign(Object.create(null) as NodeJS.ProcessEnv, { PATH: FIRST }),
          countingHandler(counts),
        ),
    ],
    [
      'a proxy around a process.env-shaped data map',
      (counts) => new Proxy(envShaped(), countingHandler(counts)),
    ],
    [
      'a proxy whose ownKeys trap throws',
      (counts) =>
        new Proxy(
          envShaped(),
          countingHandler(counts, {
            ownKeys(): never {
              counts.ownKeys += 1;
              throw new Error(TRAP_SECRET);
            },
          }),
        ),
    ],
    [
      'a proxy whose descriptor trap throws',
      (counts) =>
        new Proxy(
          envShaped(),
          countingHandler(counts, {
            getOwnPropertyDescriptor(): never {
              counts.getOwnPropertyDescriptor += 1;
              throw new Error(TRAP_SECRET);
            },
          }),
        ),
    ],
    [
      'a proxy whose getPrototypeOf trap throws',
      (counts) =>
        new Proxy(
          envShaped(),
          countingHandler(counts, {
            getPrototypeOf(): never {
              counts.getPrototypeOf += 1;
              throw new Error(TRAP_SECRET);
            },
          }),
        ),
    ],
    [
      'a proxy whose get trap throws',
      (counts) =>
        new Proxy(
          envShaped(),
          countingHandler(counts, {
            get(): never {
              counts.get += 1;
              throw new Error(TRAP_SECRET);
            },
          }),
        ),
    ],
    [
      'a proxy that contradicts itself about its own keys',
      (counts) =>
        new Proxy(
          {} as NodeJS.ProcessEnv,
          countingHandler(counts, {
            ownKeys(): string[] {
              counts.ownKeys += 1;
              return ['PATH'];
            },
            getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
              counts.getOwnPropertyDescriptor += 1;
              return undefined;
            },
          }),
        ),
    ],
    [
      'a proxy that answers with a getter instead of a value',
      (counts) =>
        new Proxy(
          envShaped(),
          countingHandler(counts, {
            getOwnPropertyDescriptor(): PropertyDescriptor {
              counts.getOwnPropertyDescriptor += 1;
              return { enumerable: true, configurable: true, get: () => TRAP_SECRET };
            },
          }),
        ),
    ],
  ];

  it.each(proxySources)('refuses %s before asking it anything', (_label, build) => {
    for (const [, on] of platforms) {
      const counts = trapCounts();
      const source = build(counts);

      const { result, error } = capture(() => on(() => createProbeEnv('capability:generic', source)));

      expectRefusedUnread(result, error);
      // The whole point: not one trap ran. The refusal is decided from the
      // object's internal shape, so the source never observed the question.
      expect(totalTraps(counts)).toBe(0);
      expect(counts).toEqual(trapCounts());
    }
  });

  it.each(PROBE_ENV_POLICIES)('refuses a proxied source under %s too', (policy) => {
    const counts = trapCounts();
    const source = new Proxy(envShaped(), countingHandler(counts));

    const { result, error } = capture(() => onWindows(() => createProbeEnv(policy, source)));

    expectRefusedUnread(result, error);
    expect(totalTraps(counts)).toBe(0);
  });

  it('refuses a revoked proxy safely, without leaking the revocation', () => {
    const counts = trapCounts();
    const { proxy, revoke } = Proxy.revocable(envShaped(), countingHandler(counts));
    revoke();

    // A revoked proxy answers every reflective operation with a TypeError, so
    // touching it at all would replace the module's own verdict with a foreign
    // error carrying foreign text.
    expect(() => Reflect.ownKeys(proxy)).toThrow(TypeError);

    const { result, error } = capture(() => onWindows(() => createProbeEnv('capability:generic', proxy)));

    expectRefusedUnread(result, error);
    expect(totalTraps(counts)).toBe(0);
    expect(rendered(error)).not.toContain('revoked');
    expect(rendered(error)).not.toContain('TypeError');
  });

  it('refuses a proxy even when it wraps the real process environment', () => {
    const counts = trapCounts();
    const source = new Proxy(process.env, countingHandler(counts));

    const { result, error } = capture(() => createProbeEnv('capability:generic', source));

    expectRefusedUnread(result, error);
    expect(totalTraps(counts)).toBe(0);
  });

  it.each(['not an object at all', null, 'PATH=/usr/bin', 42] as const)(
    'refuses a source that is %s',
    (source) => {
      const { result, error } = capture(() =>
        onWindows(() => createProbeEnv('capability:generic', source as unknown as NodeJS.ProcessEnv)),
      );
      expectRefusedUnread(result, error);
    },
  );

  // ── 8.4.1 The two confirmed review bypasses (R2-REVIEW-01) ───────────────
  //
  // Both exploit the same gap: the snapshot asks the source twice — once for
  // its own keys, once per key for a descriptor — and a proxy is free to answer
  // the two questions as if they were about two different objects. Measured
  // against the pre-fix logic, the first produced `{ PATH: FIRST }` where a
  // plain object produced a collision refusal, and the second produced
  // `{ PATH: MASKED }` where a plain object produced an accessor refusal.

  it('cannot lose a Windows collision by turning an enumerable key non-enumerable', () => {
    const counts = trapCounts();
    // Both spellings are own and enumerable when the source is enumerated.
    const target: NodeJS.ProcessEnv = { PATH: FIRST, Path: SECOND };
    const source = new Proxy(
      target,
      countingHandler(counts, {
        getOwnPropertyDescriptor(t, key): PropertyDescriptor | undefined {
          counts.getOwnPropertyDescriptor += 1;
          const descriptor = Reflect.getOwnPropertyDescriptor(t, key);
          // The bypass: the alias that made this a collision is described as
          // non-enumerable once it is actually asked about, so the collision
          // present at enumeration time disappears and `PATH` wins silently.
          if (key === 'Path' && descriptor !== undefined) return { ...descriptor, enumerable: false };
          return descriptor;
        },
      }),
    );

    const { result, error } = capture(() => onWindows(() => createProbeEnv('capability:generic', source)));

    // Refused for being a proxy, before either question was asked — so the
    // mutation never got to happen and no `PATH` was forwarded.
    expectRefusedUnread(result, error);
    expect(totalTraps(counts)).toBe(0);
    expect(result).toBeUndefined();

    // Control: the same two spellings on a plain object are still a collision.
    const { error: plainError } = capture(() =>
      onWindows(() => createProbeEnv('capability:generic', { PATH: FIRST, Path: SECOND })),
    );
    expect(plainError).toBeInstanceOf(ProbeEnvironmentCollisionError);
  });

  it('cannot pass an accessor off as a data property', () => {
    const counts = trapCounts();
    const getter = { calls: 0 };
    const target: NodeJS.ProcessEnv = {};
    Object.defineProperty(target, 'PATH', {
      enumerable: true,
      configurable: true,
      get(): string {
        getter.calls += 1;
        return FIRST;
      },
    });

    const source = new Proxy(
      target,
      countingHandler(counts, {
        getOwnPropertyDescriptor(t, key): PropertyDescriptor | undefined {
          counts.getOwnPropertyDescriptor += 1;
          // The bypass: a real accessor is described as a plain data property,
          // so the binding accessor refusal never triggers.
          if (key === 'PATH') {
            return { value: MASKED, enumerable: true, configurable: true, writable: true };
          }
          return Reflect.getOwnPropertyDescriptor(t, key);
        },
      }),
    );

    const { result, error } = capture(() => onWindows(() => createProbeEnv('capability:generic', source)));

    expectRefusedUnread(result, error);
    expect(totalTraps(counts)).toBe(0);
    // Neither the mask nor the getter behind it ever surfaced.
    expect(getter.calls).toBe(0);
    expect(JSON.stringify(result ?? {})).not.toContain(MASKED);
    expect(rendered(error)).not.toContain(MASKED);

    // Control: the same accessor on a plain object is still refused as one.
    const { error: plainError } = capture(() =>
      onWindows(() => createProbeEnv('capability:generic', target)),
    );
    expect(plainError).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    expect(getter.calls).toBe(0);
  });

  // ── 8.5 Each value comes from exactly one descriptor read ────────────────
  //
  // A proxied source is refused outright, so the reflection this module performs
  // can no longer be counted from inside the object. It is counted from the
  // operations instead: `Reflect.ownKeys` and `Object.getOwnPropertyDescriptor`
  // are wrapped for the duration of the call, and only reads of *this* source
  // are recorded. The source itself stays an ordinary plain object.

  interface ReflectionLog {
    readonly ownKeysCalls: number;
    readonly descriptorReads: readonly string[];
  }

  function watchReflection<T>(
    source: object,
    run: () => T,
    afterDescriptor?: (key: PropertyKey) => void,
  ): { result: T | undefined; error: unknown; log: ReflectionLog } {
    const originalOwnKeys = Reflect.ownKeys;
    const originalDescriptor = Object.getOwnPropertyDescriptor;
    let ownKeysCalls = 0;
    const descriptorReads: string[] = [];

    Reflect.ownKeys = function ownKeys(target: object): (string | symbol)[] {
      if (target === source) ownKeysCalls += 1;
      return originalOwnKeys(target);
    };
    Object.getOwnPropertyDescriptor = function getOwnPropertyDescriptor(
      target: object,
      key: PropertyKey,
    ): PropertyDescriptor | undefined {
      if (target !== source) return originalDescriptor(target, key);
      descriptorReads.push(String(key));
      const descriptor = originalDescriptor(target, key);
      afterDescriptor?.(key);
      return descriptor;
    } as typeof Object.getOwnPropertyDescriptor;

    try {
      const { result, error } = capture(run as () => NodeJS.ProcessEnv);
      return { result: result as T | undefined, error, log: { ownKeysCalls, descriptorReads } };
    } finally {
      Reflect.ownKeys = originalOwnKeys;
      Object.getOwnPropertyDescriptor = originalDescriptor;
    }
  }

  it('enumerates once and reads each relevant descriptor exactly once', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: FIRST,
      PATHEXT: '.CMD',
      AO_UNKNOWN_ENV: SECOND,
      ANTHROPIC_API_KEY: SECRET_VALUES['ANTHROPIC_API_KEY'] ?? '',
    };

    const { result, log } = watchReflection(source, () =>
      onWindows(() => createProbeEnv('capability:generic', source)),
    );

    expect(result).toEqual({ PATH: FIRST, PATHEXT: '.CMD' });
    // One enumeration for the whole call, not one per allow-listed name.
    expect(log.ownKeysCalls).toBe(1);
    // Exactly one descriptor read per key a policy could forward, and no read at
    // all for the credential variable next to them.
    expect(log.descriptorReads).toEqual(['PATH', 'PATHEXT']);
  });

  it('takes a selected value from its snapshot, not from a later lookup', () => {
    // Each own property is removed the moment it has been captured, and the
    // prototype offers a different `PATHEXT` underneath. A second lookup — a
    // `source[name]` read, or `Reflect.get` — would therefore miss `PATH`
    // entirely and answer `PATHEXT` with the inherited value.
    const source: NodeJS.ProcessEnv = Object.assign(
      Object.create({ PATHEXT: INHERITED }) as NodeJS.ProcessEnv,
      { PATH: FIRST, PATHEXT: SECOND },
    );

    const { result } = watchReflection(
      source,
      () => onWindows(() => createProbeEnv('capability:generic', source)),
      (key) => {
        delete (source as Record<string, unknown>)[key as string];
      },
    );

    expect(result).toEqual({ PATH: FIRST, PATHEXT: SECOND });
    expect(JSON.stringify(result)).not.toContain(INHERITED);
    // Nothing own is left: any later lookup could only have answered from the
    // prototype, and neither value above came from there.
    expect(Object.keys(source)).toEqual([]);
  });

  it('fails closed when a property vanishes before it has been captured', () => {
    // The mirror image: the source removes a key that was enumerated but not yet
    // read. There is then no own property to take a value from, and the
    // inherited one underneath is not an answer, so nothing is built.
    const source: NodeJS.ProcessEnv = Object.assign(
      Object.create({ PATHEXT: INHERITED }) as NodeJS.ProcessEnv,
      { PATH: FIRST, PATHEXT: SECOND },
    );

    const { result, error } = watchReflection(
      source,
      () => onWindows(() => createProbeEnv('capability:generic', source)),
      (key) => {
        if (key === 'PATH') delete (source as Record<string, unknown>)['PATHEXT'];
      },
    );

    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    expect(result).toBeUndefined();
  });
});

describe('the real process environment is read as itself, not through a wrapper', () => {
  it('is not a proxy, so the guard lets the ordinary snapshot run', () => {
    expect(types.isProxy(process.env)).toBe(false);
  });

  it.each(PROBE_ENV_POLICIES)('still builds a usable environment for %s', (policy) => {
    const env = createProbeEnv(policy, process.env);
    expect(Object.isFrozen(env)).toBe(true);
    for (const name of Object.keys(env)) {
      expect(probeEnvAllowlist(policy)).toContain(name);
      // Only plain data values are ever carried out of the real environment.
      expect(typeof env[name]).toBe('string');
      const descriptor = Object.getOwnPropertyDescriptor(env, name);
      expect(descriptor && 'value' in descriptor).toBe(true);
    }
  });

  it.each(PROBE_ENV_POLICIES)('carries no credential or loader variable for %s', (policy) => {
    const env = createProbeEnv(policy, process.env);
    for (const name of [
      ...FORBIDDEN_CHILD_ENV_VARS,
      ...WITHHELD_AUTH_ENV_VARS,
      ...LOADER_INJECTION_ENV_VARS,
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it('leaves the real process environment untouched', () => {
    const before = Object.keys(process.env).sort();
    const pathBefore = process.env['PATH'];

    for (const policy of PROBE_ENV_POLICIES) createProbeEnv(policy, process.env);

    expect(Object.keys(process.env).sort()).toEqual(before);
    expect(process.env['PATH']).toBe(pathBefore);
  });
});

describe('loader and injection variables', () => {
  const injected = (): NodeJS.ProcessEnv => ({
    PATH: '/usr/bin',
    NODE_OPTIONS: '--require=/tmp/evil.cjs',
    NODE_PATH: '/tmp/evil-modules',
    npm_config_node_options: '--require=/tmp/evil.cjs',
    NPM_CONFIG_NODE_OPTIONS: '--require=/tmp/evil.cjs',
  });

  it.each(PROBE_ENV_POLICIES)('reaches %s with none of them', (policy) => {
    const env = createProbeEnv(policy, injected());
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'npm_config_node_options', 'NPM_CONFIG_NODE_OPTIONS']) {
      expect(env[name]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain('--require');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('names no loader variable in any policy allow-list', () => {
    for (const policy of PROBE_ENV_POLICIES) {
      for (const allowed of probeEnvAllowlist(policy)) {
        expect(LOADER_INJECTION_ENV_VARS).not.toContain(allowed.toUpperCase());
      }
    }
  });
});

describe('presenceOf', () => {
  it('reports SET only for a non-empty value', () => {
    expect(presenceOf({ X: 'value' }, 'X')).toBe('SET');
    expect(presenceOf({ X: '' }, 'X')).toBe('NOT_SET');
    expect(presenceOf({}, 'X')).toBe('NOT_SET');
  });
});

describe('assessEnvironment', () => {
  it('reports only SET/NOT_SET and never leaks a secret', () => {
    const assessment = assessEnvironment(pollutedEnv());
    const serialized = JSON.stringify(assessment);

    for (const value of Object.values(SECRET_VALUES)) {
      expect(serialized).not.toContain(value);
      // Also reject partial disclosure via prefixes or fragments.
      expect(serialized).not.toContain(value.slice(0, 8));
    }
    // No length or hash disclosure either.
    expect(serialized).not.toMatch(/"length"\s*:/);
    expect(serialized).not.toMatch(/"hash"\s*:/);

    for (const observation of assessment.forbiddenVars) {
      expect(['SET', 'NOT_SET']).toContain(observation.presence);
      expect(observation.removedFromChildEnv).toBe(true);
    }
  });

  it('flags present API-key variables as warnings, not blockers', () => {
    const assessment = assessEnvironment(pollutedEnv());
    expect([...assessment.warnedCredentialVars].sort()).toEqual([...FORBIDDEN_CHILD_ENV_VARS].sort());
    expect(assessment.blockingProviderFlags).toHaveLength(0);
  });

  it('reports the OAuth token as observed-but-withheld, never as preserved', () => {
    const assessment = assessEnvironment(pollutedEnv());
    expect(assessment.withheldAuthVars).toEqual([
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', presence: 'SET' },
    ]);
    // Reporting its presence must not be a route to forwarding it.
    for (const policy of PROBE_ENV_POLICIES) {
      expect(createProbeEnv(policy, pollutedEnv())['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    }
  });

  it('reports a clean environment as clean', () => {
    const assessment = assessEnvironment({ PATH: '/bin' });
    expect(assessment.warnedCredentialVars).toHaveLength(0);
    expect(assessment.blockingProviderFlags).toHaveLength(0);
    expect(assessment.forbiddenVars.every((v) => v.presence === 'NOT_SET')).toBe(true);
  });

  it.each(OBSERVED_PROVIDER_ENV_VARS)('treats a set %s as a blocking finding', (name) => {
    const assessment = assessEnvironment({ [name]: '1' });
    expect(assessment.blockingProviderFlags).toContain(name);
  });

  it('observes provider flags without ever forwarding them to a probe', () => {
    const source = { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gateway.invalid' };
    expect(assessEnvironment(source).blockingProviderFlags).toHaveLength(2);
    for (const policy of PROBE_ENV_POLICIES) {
      const env = createProbeEnv(policy, source);
      expect(env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
      expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    }
  });

  it('reports every observed provider flag with a presence value', () => {
    const assessment = assessEnvironment({});
    expect(assessment.providerFlags.map((f) => f.name)).toEqual([...OBSERVED_PROVIDER_ENV_VARS]);
    expect(assessment.providerFlags.every((f) => f.presence === 'NOT_SET')).toBe(true);
  });
});
