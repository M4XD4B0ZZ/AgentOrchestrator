import { describe, expect, it } from 'vitest';

import {
  AUTH_REASON_TEXT,
  CODEX_CHATGPT_LOGIN_LINE,
  evaluateClaudeAuthStatus,
  evaluateCodexLoginStatus,
  type AuthCheckResult,
} from '../src/auth/auth-preflight.js';
import { commandResult, SENSITIVE_MARKER } from './fixtures.js';

const result = commandResult;

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

/** Every string a check result can carry, for leak assertions. */
function serialise(check: AuthCheckResult): string {
  return JSON.stringify(check);
}

describe('Claude auth whitelist', () => {
  it('passes on the observed subscription payload', () => {
    const check = evaluateClaudeAuthStatus(result({ stdout: OBSERVED_CLAUDE_PASS }));
    expect(check.status).toBe('PASS');
    expect(check.passed).toBe(true);
    expect(check.reasonCode).toBe('CLAUDE_SUBSCRIPTION_CONFIRMED');
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

  it('carries no raw output field at all — not even a redacted one', () => {
    const check = evaluateClaudeAuthStatus(result({ stdout: OBSERVED_CLAUDE_PASS }));
    expect(check).not.toHaveProperty('redactedOutput');
    expect(Object.keys(check).sort()).toEqual([
      'agent',
      'evidence',
      'exitCode',
      'passed',
      'reason',
      'reasonCode',
      'status',
      'statusCommand',
    ]);
  });

  it.each([
    ['in an unknown top-level field', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', note: SENSITIVE_MARKER })],
    ['in the account email', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: `${SENSITIVE_MARKER}@example.com` })],
    ['in the organisation name', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', orgName: SENSITIVE_MARKER })],
    ['in the subscription tier', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: SENSITIVE_MARKER })],
    ['in a rejected authMethod', JSON.stringify({ loggedIn: true, authMethod: SENSITIVE_MARKER, apiProvider: 'firstParty' })],
    ['in a rejected apiProvider', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: SENSITIVE_MARKER })],
    ['in unparseable output', `not json ${SENSITIVE_MARKER}`],
  ])('never echoes a non-token-shaped sensitive marker %s', (_label, stdout) => {
    const check = evaluateClaudeAuthStatus(result({ stdout }));
    expect(serialise(check)).not.toContain(SENSITIVE_MARKER);
  });

  it('never echoes a marker that only appears on stderr', () => {
    const check = evaluateClaudeAuthStatus(
      result({ exitCode: 1, stderr: `failed: ${SENSITIVE_MARKER}` }),
    );
    expect(serialise(check)).not.toContain(SENSITIVE_MARKER);
  });

  it('normalises an unrecognised subscription tier instead of copying it', () => {
    const check = evaluateClaudeAuthStatus(
      result({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: SENSITIVE_MARKER,
        }),
      }),
    );
    expect(check.status).toBe('PASS');
    expect(check.evidence).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'UNRECOGNIZED',
    });
  });

  it('records an absent subscription tier as ABSENT', () => {
    const check = evaluateClaudeAuthStatus(
      result({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
      }),
    );
    expect(check.evidence).toMatchObject({ subscriptionType: 'ABSENT' });
  });

  it('uses only static reason text', () => {
    const check = evaluateClaudeAuthStatus(result({ stdout: OBSERVED_CLAUDE_PASS }));
    expect(check.reason).toBe(AUTH_REASON_TEXT[check.reasonCode]);
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
    expect(check.reasonCode).toBe('CLAUDE_AUTH_METHOD_NOT_ACCEPTED');
    expect(check.passed).toBe(false);
    expect(check.evidence).toBeNull();
  });

  it.each(['bedrock', 'vertex', 'foundry', 'thirdParty', 'gateway'])(
    'rejects apiProvider %j even with an accepted authMethod',
    (apiProvider) => {
      const check = evaluateClaudeAuthStatus(
        result({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider }) }),
      );
      expect(check.status).toBe('AUTH_METHOD_REJECTED');
      expect(check.reasonCode).toBe('CLAUDE_API_PROVIDER_NOT_ACCEPTED');
    },
  );

  it('rejects a JSON object that does not report a login at all', () => {
    // Parseable, but `loggedIn` is absent — fail closed rather than assume.
    const check = evaluateClaudeAuthStatus(result({ stdout: '{"ok":true}' }));
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.reasonCode).toBe('CLAUDE_NOT_LOGGED_IN');
    expect(check.passed).toBe(false);
  });

  it('rejects a logged-out account', () => {
    const check = evaluateClaudeAuthStatus(
      result({
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
      }),
    );
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
  });

  it.each([
    ['empty output', '', 'STATUS_OUTPUT_EMPTY'],
    ['whitespace only', '   \n  ', 'STATUS_OUTPUT_EMPTY'],
    ['not JSON', 'You are logged in.', 'CLAUDE_OUTPUT_NOT_JSON'],
    ['JSON array', '[]', 'CLAUDE_OUTPUT_NOT_JSON_OBJECT'],
    ['JSON string', '"logged in"', 'CLAUDE_OUTPUT_NOT_JSON_OBJECT'],
    ['JSON null', 'null', 'CLAUDE_OUTPUT_NOT_JSON_OBJECT'],
    [
      'authMethod of the wrong type',
      '{"loggedIn":true,"authMethod":1,"apiProvider":"firstParty"}',
      'CLAUDE_AUTH_FIELDS_MISSING',
    ],
  ])('treats %s as UNVERIFIABLE', (_label, stdout, reasonCode) => {
    const check = evaluateClaudeAuthStatus(result({ stdout }));
    expect(check.status).toBe('UNVERIFIABLE');
    expect(check.reasonCode).toBe(reasonCode);
    expect(check.passed).toBe(false);
  });

  it('rejects a non-zero exit code', () => {
    const check = evaluateClaudeAuthStatus(
      result({ exitCode: 1, stderr: 'Not logged in. Run `claude auth login`.' }),
    );
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.reasonCode).toBe('STATUS_COMMAND_NONZERO_EXIT');
    expect(check.reason).not.toContain('Not logged in. Run');
  });

  it.each(['TIMED_OUT', 'NOT_FOUND', 'SPAWN_FAILED', 'OUTPUT_LIMIT_EXCEEDED'] as const)(
    'treats outcome %s as UNVERIFIABLE',
    (outcome) => {
      const check = evaluateClaudeAuthStatus(result({ outcome, exitCode: null }));
      expect(check.status).toBe('UNVERIFIABLE');
      expect(check.reasonCode).toBe('STATUS_COMMAND_NOT_COMPLETED');
    },
  );
});

describe('Codex login whitelist', () => {
  const codexResult = (overrides: Partial<ReturnType<typeof commandResult>> = {}) =>
    result({
      display: 'codex login status',
      executable: 'codex',
      args: ['login', 'status'],
      ...overrides,
    });

  it('passes on exactly the observed ChatGPT login line', () => {
    const check = evaluateCodexLoginStatus(codexResult({ stdout: 'Logged in using ChatGPT\n' }));
    expect(check.status).toBe('PASS');
    expect(check.passed).toBe(true);
    expect(check.reasonCode).toBe('CODEX_CHATGPT_CONFIRMED');
    expect(check.evidence).toEqual({ loginMethod: 'ChatGPT' });
  });

  it('passes on the shape the installed CLI actually produces: the line on stderr', () => {
    // Measured on Codex CLI 0.146.0: stdout is empty (0 bytes) and the single
    // result line is written to stderr. Which stream carries it is a formatting
    // detail; the rule is that the whole output is that one line.
    const check = evaluateCodexLoginStatus(
      codexResult({ stdout: '', stderr: 'Logged in using ChatGPT\n' }),
    );
    expect(check.status).toBe('PASS');
    expect(check.evidence).toEqual({ loginMethod: 'ChatGPT' });
  });

  it('normalises only surrounding whitespace and blank lines', () => {
    for (const stdout of [
      `   ${CODEX_CHATGPT_LOGIN_LINE}   `,
      `\r\n${CODEX_CHATGPT_LOGIN_LINE}\r\n`,
      `\n\n  ${CODEX_CHATGPT_LOGIN_LINE}  \n\n`,
    ]) {
      expect(evaluateCodexLoginStatus(codexResult({ stdout })).status).toBe('PASS');
      expect(evaluateCodexLoginStatus(codexResult({ stdout: '', stderr: stdout })).status).toBe(
        'PASS',
      );
    }
  });

  // ── The AO-001 negative set ──────────────────────────────────────────────
  it.each([
    ['a mixed ChatGPT + API-key message', 'Logged in using ChatGPT and API key'],
    ['a plan suffix', 'Logged in using ChatGPT (plus)'],
    ['leading extra text', 'Note: Logged in using ChatGPT'],
    ['trailing extra text', 'Logged in using ChatGPT.'],
    ['trailing extra word', 'Logged in using ChatGPT account'],
    ['API key login', 'Logged in using an API key'],
    ['API key phrasing variant', 'Logged in using API key from OPENAI_API_KEY'],
    ['not logged in', 'Not logged in'],
    ['unknown method', 'Logged in using Enterprise SSO'],
    ['unrelated output', 'codex-cli 0.146.0'],
    ['near miss', 'Logged in using ChatGPTish'],
    ['wrong verb', 'Authenticated with ChatGPT'],
    ['a localised message', 'Angemeldet mit ChatGPT'],
    ['different casing', 'logged in using chatgpt'],
    ['internal double space', 'Logged in  using ChatGPT'],
  ])('rejects %s', (_label, text) => {
    // Rejected on whichever stream the CLI might use.
    for (const result of [
      codexResult({ stdout: text }),
      codexResult({ stdout: '', stderr: text }),
    ]) {
      const check = evaluateCodexLoginStatus(result);
      expect(check.status).toBe('AUTH_METHOD_REJECTED');
      expect(check.passed).toBe(false);
      expect(check.evidence).toBeNull();
    }
  });

  it.each([
    ['a preceding banner line', `Codex CLI\n${CODEX_CHATGPT_LOGIN_LINE}`],
    ['a following hint line', `${CODEX_CHATGPT_LOGIN_LINE}\nAlso using an API key`],
    ['two recognised lines', `${CODEX_CHATGPT_LOGIN_LINE}\n${CODEX_CHATGPT_LOGIN_LINE}`],
  ])('rejects %s as not a single line', (_label, stdout) => {
    const check = evaluateCodexLoginStatus(codexResult({ stdout }));
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.reasonCode).toBe('CODEX_OUTPUT_NOT_SINGLE_LINE');
  });

  it.each([
    [
      'an API-key hint on stderr alongside a perfect stdout line',
      { stdout: CODEX_CHATGPT_LOGIN_LINE, stderr: 'warning: OPENAI_API_KEY is also set' },
    ],
    [
      'an API-key hint on stdout alongside a perfect stderr line',
      { stdout: 'warning: OPENAI_API_KEY is also set', stderr: CODEX_CHATGPT_LOGIN_LINE },
    ],
    [
      'a deprecation notice next to the recognised line',
      { stdout: CODEX_CHATGPT_LOGIN_LINE, stderr: 'note: this command will be renamed' },
    ],
  ])('rejects %s', (_label, overrides) => {
    const check = evaluateCodexLoginStatus(codexResult(overrides));
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.reasonCode).toBe('CODEX_OUTPUT_NOT_SINGLE_LINE');
    expect(check.passed).toBe(false);
  });

  it('rejects an API-key hint that is the only stderr content', () => {
    const check = evaluateCodexLoginStatus(
      codexResult({ stdout: '', stderr: 'Logged in using an API key' }),
    );
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.reasonCode).toBe('CODEX_PHRASE_NOT_RECOGNISED');
  });

  it('ignores whitespace-only content on the other stream', () => {
    expect(
      evaluateCodexLoginStatus(codexResult({ stdout: CODEX_CHATGPT_LOGIN_LINE, stderr: '  \n ' }))
        .status,
    ).toBe('PASS');
    expect(
      evaluateCodexLoginStatus(codexResult({ stdout: ' \n ', stderr: CODEX_CHATGPT_LOGIN_LINE }))
        .status,
    ).toBe('PASS');
  });

  it.each([
    ['empty output', ''],
    ['whitespace only', '  \n\n  '],
  ])('treats %s as UNVERIFIABLE rather than a pass', (_label, stdout) => {
    const check = evaluateCodexLoginStatus(codexResult({ stdout, stderr: stdout }));
    expect(check.status).toBe('UNVERIFIABLE');
    expect(check.reasonCode).toBe('STATUS_OUTPUT_EMPTY');
    expect(check.passed).toBe(false);
  });

  it('rejects a non-zero exit code even if the output looks right', () => {
    const check = evaluateCodexLoginStatus(
      codexResult({ exitCode: 1, stdout: CODEX_CHATGPT_LOGIN_LINE }),
    );
    expect(check.status).toBe('AUTH_METHOD_REJECTED');
    expect(check.reasonCode).toBe('STATUS_COMMAND_NONZERO_EXIT');
  });

  it('treats a timeout as UNVERIFIABLE', () => {
    const check = evaluateCodexLoginStatus(codexResult({ outcome: 'TIMED_OUT', exitCode: null }));
    expect(check.status).toBe('UNVERIFIABLE');
  });

  it.each([
    ['on stdout', { stdout: `Logged in using ChatGPT ${SENSITIVE_MARKER}` }],
    ['on stderr', { stdout: CODEX_CHATGPT_LOGIN_LINE, stderr: SENSITIVE_MARKER }],
    ['as the whole output', { stdout: SENSITIVE_MARKER }],
    ['as the whole stderr output', { stdout: '', stderr: SENSITIVE_MARKER }],
  ])('never echoes a sensitive marker %s', (_label, overrides) => {
    const check = evaluateCodexLoginStatus(codexResult(overrides));
    expect(check.passed).toBe(false);
    expect(serialise(check)).not.toContain(SENSITIVE_MARKER);
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
      'Logged in using ChatGPT and API key',
      'Logged in using ChatGPT (plus)',
    ];
    for (const stdout of arbitrary) {
      expect(evaluateClaudeAuthStatus(result({ stdout })).passed).toBe(false);
      expect(evaluateCodexLoginStatus(result({ stdout })).passed).toBe(false);
    }
  });

  it('states the accepted Codex phrase exactly once, as a constant', () => {
    expect(CODEX_CHATGPT_LOGIN_LINE).toBe('Logged in using ChatGPT');
  });
});
