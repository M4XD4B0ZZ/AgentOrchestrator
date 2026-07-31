import { describe, expect, it } from 'vitest';

import {
  assessEnvironment,
  createSanitizedChildEnv,
  FORBIDDEN_CHILD_ENV_VARS,
  OBSERVED_PROVIDER_ENV_VARS,
  presenceOf,
  PRESERVED_AUTH_ENV_VARS,
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

describe('createSanitizedChildEnv', () => {
  it('removes every forbidden API-key variable', () => {
    const sanitized = createSanitizedChildEnv(pollutedEnv());
    for (const name of FORBIDDEN_CHILD_ENV_VARS) {
      expect(sanitized).not.toHaveProperty(name);
      expect(sanitized[name]).toBeUndefined();
    }
  });

  it('preserves CLAUDE_CODE_OAUTH_TOKEN, which is a subscription OAuth path', () => {
    const sanitized = createSanitizedChildEnv(pollutedEnv());
    expect(sanitized['CLAUDE_CODE_OAUTH_TOKEN']).toBe(SECRET_VALUES['CLAUDE_CODE_OAUTH_TOKEN']);
    for (const name of PRESERVED_AUTH_ENV_VARS) {
      expect(sanitized[name]).toBeDefined();
    }
  });

  it('keeps every unrelated variable untouched', () => {
    const sanitized = createSanitizedChildEnv(pollutedEnv());
    expect(sanitized['PATH']).toBe('/usr/bin');
    expect(sanitized['LANG']).toBe('en_US.UTF-8');
  });

  it('does not mutate the input object', () => {
    const source = pollutedEnv();
    const snapshot = { ...source };
    createSanitizedChildEnv(source);
    expect(source).toEqual(snapshot);
    for (const name of FORBIDDEN_CHILD_ENV_VARS) {
      expect(source[name]).toBe(SECRET_VALUES[name]);
    }
  });

  it('returns a new object rather than the input', () => {
    const source = pollutedEnv();
    expect(createSanitizedChildEnv(source)).not.toBe(source);
  });

  it('does not modify the real process environment', () => {
    const before = { ...process.env };
    createSanitizedChildEnv(process.env);
    expect({ ...process.env }).toEqual(before);
  });

  it('is idempotent', () => {
    const once = createSanitizedChildEnv(pollutedEnv());
    expect(createSanitizedChildEnv(once)).toEqual(once);
  });

  it('copes with an environment that has none of the variables', () => {
    expect(createSanitizedChildEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
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

  it('observes provider flags without stripping them from the child env', () => {
    const source = { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gateway.invalid' };
    const sanitized = createSanitizedChildEnv(source);
    expect(sanitized['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
    expect(sanitized['ANTHROPIC_BASE_URL']).toBe('https://gateway.invalid');
    expect(assessEnvironment(source).blockingProviderFlags).toHaveLength(2);
  });

  it('reports every observed provider flag with a presence value', () => {
    const assessment = assessEnvironment({});
    expect(assessment.providerFlags.map((f) => f.name)).toEqual([...OBSERVED_PROVIDER_ENV_VARS]);
    expect(assessment.providerFlags.every((f) => f.presence === 'NOT_SET')).toBe(true);
  });
});
