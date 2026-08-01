import { describe, expect, it } from 'vitest';

import {
  assessEnvironment,
  createProbeEnv,
  FORBIDDEN_CHILD_ENV_VARS,
  LOADER_INJECTION_ENV_VARS,
  OBSERVED_PROVIDER_ENV_VARS,
  presenceOf,
  probeEnvAllowlist,
  PROBE_ENV_POLICIES,
  UnknownProbeEnvPolicyError,
  WITHHELD_AUTH_ENV_VARS,
  type ProbeEnvPolicy,
} from '../src/auth/env-guard.js';

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
