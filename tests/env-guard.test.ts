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
        systemroot: 'C:\\ao-windows',
        UserProfile: SECOND,
      }),
    );
    expect(Object.keys(env)).toEqual(['PATH', 'PATHEXT', 'SystemRoot', 'USERPROFILE']);
    expect(env['PATH']).toBe(FIRST);
    expect(env['USERPROFILE']).toBe(SECOND);
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
    // PATH, PATHEXT, SystemRoot, windir and COMSPEC all resolve cleanly; the
    // collision is on USERPROFILE, the *last* name auth:claude asks for. If the
    // map under construction could escape, this is where it would.
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
  const SENTINELS = [FIRST, SECOND, THIRD, GETTER_SECRET, TRAP_SECRET, INHERITED, HIDDEN];

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

  // ── 8.4 A source that answers through traps fails closed ─────────────────

  it('fails closed when the ownKeys trap throws, without echoing it', () => {
    const source = new Proxy({} as NodeJS.ProcessEnv, {
      ownKeys(): string[] {
        throw new Error(TRAP_SECRET);
      },
    });

    const { result, error } = capture(() => onWindows(() => createProbeEnv('capability:generic', source)));

    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    expect(result).toBeUndefined();
    for (const sentinel of SENTINELS) expect(rendered(error)).not.toContain(sentinel);
  });

  it('fails closed when the descriptor trap throws, without echoing it', () => {
    const source = new Proxy({ PATH: FIRST } as NodeJS.ProcessEnv, {
      getOwnPropertyDescriptor(): PropertyDescriptor {
        throw new Error(TRAP_SECRET);
      },
    });

    const { result, error } = capture(() => onWindows(() => createProbeEnv('capability:generic', source)));

    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    expect(result).toBeUndefined();
    for (const sentinel of SENTINELS) expect(rendered(error)).not.toContain(sentinel);
  });

  it('fails closed on a source that contradicts itself about its own keys', () => {
    // Enumerated as an own key, yet it has no own descriptor.
    const source = new Proxy({} as NodeJS.ProcessEnv, {
      ownKeys: (): string[] => ['PATH'],
      getOwnPropertyDescriptor: (): PropertyDescriptor | undefined => undefined,
    });

    const { result, error } = capture(() => onPosix(() => createProbeEnv('capability:generic', source)));

    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    expect(result).toBeUndefined();
  });

  it('fails closed when a trap answers with a getter instead of a value', () => {
    const source = new Proxy({ PATH: FIRST } as NodeJS.ProcessEnv, {
      getOwnPropertyDescriptor: (): PropertyDescriptor => ({
        enumerable: true,
        configurable: true,
        get: () => SECOND,
      }),
    });

    const { error } = capture(() => onWindows(() => createProbeEnv('capability:generic', source)));
    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
  });

  // ── 8.5 Each value comes from exactly one descriptor read ────────────────

  it('enumerates once and reads each relevant descriptor exactly once', () => {
    const target: NodeJS.ProcessEnv = {
      PATH: FIRST,
      PATHEXT: '.CMD',
      Path: undefined,
      AO_UNKNOWN_ENV: SECOND,
      ANTHROPIC_API_KEY: SECRET_VALUES['ANTHROPIC_API_KEY'] ?? '',
    };
    delete target['Path'];

    let ownKeysCalls = 0;
    const descriptorReads: string[] = [];
    const getReads: string[] = [];
    const source = new Proxy(target, {
      ownKeys(t): (string | symbol)[] {
        ownKeysCalls += 1;
        return Reflect.ownKeys(t);
      },
      getOwnPropertyDescriptor(t, key): PropertyDescriptor | undefined {
        descriptorReads.push(String(key));
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      get(t, key, receiver): unknown {
        getReads.push(String(key));
        return Reflect.get(t, key, receiver);
      },
    });

    const env = onWindows(() => createProbeEnv('capability:generic', source));

    expect(env).toEqual({ PATH: FIRST, PATHEXT: '.CMD' });
    // One enumeration for the whole call, not one per allow-listed name.
    expect(ownKeysCalls).toBe(1);
    // Exactly one descriptor read per key a policy could forward, and no read at
    // all for the credential variable next to them.
    expect(descriptorReads).toEqual(['PATH', 'PATHEXT']);
    // No `source[name]`, no `Reflect.get`: nothing is resolved through the
    // prototype chain, so a selected value can only be its own property's.
    expect(getReads).toEqual([]);
  });

  it('takes a selected value from its snapshot, not from a later lookup', () => {
    // Each own property is removed the moment it has been captured, and the
    // prototype offers a different `PATHEXT` underneath. A second lookup — a
    // `source[name]` read, or `Reflect.get` — would therefore miss `PATH`
    // entirely and answer `PATHEXT` with the inherited value.
    const prototype = { PATHEXT: INHERITED };
    const target: NodeJS.ProcessEnv = Object.assign(Object.create(prototype) as NodeJS.ProcessEnv, {
      PATH: FIRST,
      PATHEXT: SECOND,
    });

    const source = new Proxy(target, {
      getOwnPropertyDescriptor(t, key): PropertyDescriptor | undefined {
        const descriptor = Reflect.getOwnPropertyDescriptor(t, key);
        delete (t as Record<string, unknown>)[key as string];
        return descriptor;
      },
    });

    const env = onWindows(() => createProbeEnv('capability:generic', source));

    expect(env).toEqual({ PATH: FIRST, PATHEXT: SECOND });
    expect(JSON.stringify(env)).not.toContain(INHERITED);
  });

  it('fails closed when a property vanishes before it has been captured', () => {
    // The mirror image: the source removes a key that was enumerated but not yet
    // read. There is then no own property to take a value from, and the
    // inherited one underneath is not an answer, so nothing is built.
    const target: NodeJS.ProcessEnv = Object.assign(
      Object.create({ PATHEXT: INHERITED }) as NodeJS.ProcessEnv,
      { PATH: FIRST, PATHEXT: SECOND },
    );

    const source = new Proxy(target, {
      getOwnPropertyDescriptor(t, key): PropertyDescriptor | undefined {
        if (key === 'PATH') delete (t as Record<string, unknown>)['PATHEXT'];
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });

    const { result, error } = capture(() => onWindows(() => createProbeEnv('capability:generic', source)));

    expect(error).toBeInstanceOf(ProbeEnvironmentUnreadableError);
    expect(result).toBeUndefined();
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
