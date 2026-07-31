import { describe, expect, it } from 'vitest';

import {
  evaluateClaudeAuthStatus,
  evaluateCodexLoginStatus,
} from '../src/auth/auth-preflight.js';
import type { CommandResult } from '../src/doctor/exec.js';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    display: 'claude auth status --json',
    executable: 'claude',
    args: ['auth', 'status', '--json'],
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    startedAt: '2026-07-31T10:00:00.000Z',
    finishedAt: '2026-07-31T10:00:01.000Z',
    durationMs: 1000,
    ...overrides,
  };
}

/**
 * Exactly the payload observed from Claude Code 2.1.220 on a subscription
 * login, including the identifying fields that must never be copied out.
 */
const OBSERVED_CLAUDE_PASS = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'person@example.com',
  orgId: '78042180-604a-4d93-9696-e8a9c68e2e7c',
  orgName: "person@example.com's Organization",
  subscriptionType: 'pro',
});

describe('Claude auth whitelist', () => {
  it('passes on the observed subscription payload', () => {
    const check = evaluateClaudeAuthStatus(result({ stdout: OBSERVED_CLAUDE_PASS }));
    expect(check.status).toBe('PASS');
    expect(check.passed).toBe(true);
    expect(check.evidence).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'pro',
    });
  });

  it('never copies identifying fields into the evidence', () => {
    const check = evaluateClaudeAuthStatus(result({ stdout: OBSERVED_CLAUDE_PASS }));
    const serialized = JSON.stringify(check.evidence);
    expect(serialized).not.toContain('person@example.com');
    expect(serialized).not.toContain('78042180');
    expect(serialized).not.toContain('Organization');
    expect(check.evidence).not.toHaveProperty('email');
    expect(check.evidence).not.toHaveProperty('orgId');
    expect(check.evidence).not.toHaveProperty('orgName');
  });

  it('redacts the email and organisation id in the retained output', () => {
    const check = evaluateClaudeAuthStatus(result({ stdout: OBSERVED_CLAUDE_PASS }));
    expect(check.redactedOutput).not.toContain('person@example.com');
    expect(check.redactedOutput).not.toContain('78042180-604a-4d93-9696-e8a9c68e2e7c');
    expect(check.redactedOutput).toContain('<redacted:email>');
    expect(check.redactedOutput).toContain('<redacted:uuid>');
  });

  it.each([
    ['console', 'firstParty'],
    ['apiKey', 'firstParty'],
    ['api_key', 'firstParty'],
    ['bedrock', 'firstParty'],
    ['', 'firstParty'],
    ['unknown-future-method', 'firstParty'],
  ])('rejects authMethod %j', (authMethod, apiProvider) => {
    const check = evaluateClaudeAuthStatus(
      result({ stdout: JSON.stringify({ loggedIn: true, authMethod, apiProvider }) }),
    );
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.passed).toBe(false);
  });

  it.each(['bedrock', 'vertex', 'foundry', 'thirdParty', 'gateway'])(
    'rejects apiProvider %j even with an accepted authMethod',
    (apiProvider) => {
      const check = evaluateClaudeAuthStatus(
        result({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider }) }),
      );
      expect(check.status).toBe('AUTH_METHOD_REJECTED');
    },
  );

  it('rejects a JSON object that does not report a login at all', () => {
    // Parseable, but `loggedIn` is absent — fail closed rather than assume.
    const check = evaluateClaudeAuthStatus(result({ stdout: '{"ok":true}' }));
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.passed).toBe(false);
  });

  it('rejects a logged-out account', () => {
    const check = evaluateClaudeAuthStatus(
      result({ stdout: JSON.stringify({ loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty' }) }),
    );
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
  });

  it.each([
    ['empty output', ''],
    ['whitespace only', '   \n  '],
    ['not JSON', 'You are logged in.'],
    ['JSON array', '[]'],
    ['JSON string', '"logged in"'],
    ['JSON null', 'null'],
    ['authMethod of the wrong type', '{"loggedIn":true,"authMethod":1,"apiProvider":"firstParty"}'],
  ])('treats %s as UNVERIFIABLE', (_label, stdout) => {
    const check = evaluateClaudeAuthStatus(result({ stdout }));
    expect(check.status).toBe('UNVERIFIABLE');
    expect(check.passed).toBe(false);
  });

  it('rejects a non-zero exit code', () => {
    const check = evaluateClaudeAuthStatus(
      result({ exitCode: 1, stderr: 'Not logged in. Run `claude auth login`.' }),
    );
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.reason).toContain('not logged in');
  });

  it.each(['TIMED_OUT', 'NOT_FOUND', 'SPAWN_FAILED'] as const)(
    'treats outcome %s as UNVERIFIABLE',
    (outcome) => {
      const check = evaluateClaudeAuthStatus(result({ outcome, exitCode: null }));
      expect(check.status).toBe('UNVERIFIABLE');
    },
  );
});

describe('Codex login whitelist', () => {
  const codexResult = (overrides: Partial<CommandResult> = {}) =>
    result({ display: 'codex login status', executable: 'codex', args: ['login', 'status'], ...overrides });

  it('passes on the observed ChatGPT login line', () => {
    const check = evaluateCodexLoginStatus(codexResult({ stdout: 'Logged in using ChatGPT\n' }));
    expect(check.status).toBe('PASS');
    expect(check.passed).toBe(true);
    expect(check.evidence).toEqual({ loginMethod: 'ChatGPT' });
  });

  it('tolerates surrounding lines and leading whitespace', () => {
    const check = evaluateCodexLoginStatus(
      codexResult({ stdout: 'Codex CLI\n  Logged in using ChatGPT (plus)\n' }),
    );
    expect(check.status).toBe('PASS');
  });

  it.each([
    ['API key login', 'Logged in using an API key'],
    ['API key phrasing variant', 'Logged in using API key from OPENAI_API_KEY'],
    ['not logged in', 'Not logged in'],
    ['unknown method', 'Logged in using Enterprise SSO'],
    ['unrelated output', 'codex-cli 0.146.0'],
    ['near miss', 'Logged in using ChatGPTish'],
    ['wrong verb', 'Authenticated with ChatGPT'],
  ])('rejects %s', (_label, stdout) => {
    const check = evaluateCodexLoginStatus(codexResult({ stdout }));
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.passed).toBe(false);
  });

  it('treats empty output as UNVERIFIABLE rather than a pass', () => {
    const check = evaluateCodexLoginStatus(codexResult({ stdout: '', stderr: '' }));
    expect(check.status).toBe('UNVERIFIABLE');
    expect(check.passed).toBe(false);
  });

  it('rejects a non-zero exit code even if the output looks right', () => {
    const check = evaluateCodexLoginStatus(
      codexResult({ exitCode: 1, stdout: 'Logged in using ChatGPT' }),
    );
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
  });

  it('treats a timeout as UNVERIFIABLE', () => {
    const check = evaluateCodexLoginStatus(codexResult({ outcome: 'TIMED_OUT', exitCode: null }));
    expect(check.status).toBe('UNVERIFIABLE');
  });
});

describe('fail-closed property', () => {
  it('never passes on output that was not positively recognised', () => {
    const arbitrary = [
      'ok',
      'true',
      '{}',
      '{"loggedIn":true}',
      'Logged in',
      'Subscription active',
      'Pro plan',
      '{"authMethod":"claude.ai"}',
    ];
    for (const stdout of arbitrary) {
      expect(evaluateClaudeAuthStatus(result({ stdout })).passed).toBe(false);
      expect(evaluateCodexLoginStatus(result({ stdout })).passed).toBe(false);
    }
  });
});
