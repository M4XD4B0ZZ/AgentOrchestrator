/**
 * Auth preflight — fail-closed.
 *
 * Goal: prove that Claude Code runs on a **Claude subscription / OAuth** login
 * and that Codex runs on a **ChatGPT** login. Everything else — API keys,
 * Console/API billing, unknown methods, unparseable output, no login at all —
 * is a failure.
 *
 * Design:
 *  - Positive allow-list only. A status is PASS *only* when it matches a
 *    pattern that was observed in the locally installed CLI. Every other
 *    output, including output we have never seen, is rejected.
 *  - Credential stores (`~/.codex/auth.json`, `.claude/.credentials.json`, the
 *    OS keychain, …) are **never** read. Only the CLIs' own status commands
 *    are consulted.
 *  - Status commands run in the sanitised child environment, so an API key in
 *    the parent environment cannot make a check pass.
 *  - The status command to use is not guessed: it is confirmed against the
 *    capability dump first.
 *
 * ── Evidence baseline (captured on this machine while implementing) ────────
 *
 * Claude Code 2.1.220:
 *   `claude auth status --help` documents `--json  Output as JSON (default)`.
 *   `claude auth status --json` emits an object with, among others:
 *       loggedIn, authMethod, apiProvider, subscriptionType
 *   A Claude-subscription login was observed as:
 *       loggedIn=true, authMethod="claude.ai", apiProvider="firstParty"
 *   `claude auth login --help` documents two mutually exclusive login kinds —
 *   `--claudeai` ("Use Claude subscription (default)") and `--console`
 *   ("Use Anthropic Console (API usage billing)") — which confirms that
 *   `authMethod` genuinely distinguishes subscription from API billing.
 *
 * Codex CLI 0.146.0:
 *   `codex login status` emits a single human-readable line. A ChatGPT login
 *   was observed as exactly: `Logged in using ChatGPT`.
 *   `codex login --help` documents `--with-api-key`, confirming an API-key
 *   login path exists and must be distinguished.
 *
 * ── Known gaps (see also `todos` in the doctor report) ─────────────────────
 *
 *  - No sample of Claude's `--console` / API-key status output was captured,
 *    and none was fabricated. The allow-list is positive-only, so an unknown
 *    `authMethod` fails closed; the *negative* case is simply unverified.
 *  - `codex login status` in 0.146.0 offers no machine-readable output format
 *    (`--help` lists only `-c/--config`, `--enable`, `--disable`). Text
 *    matching is therefore the only locally proven option, and it is anchored
 *    to the exact observed phrase.
 */

import { createSanitizedChildEnv } from './env-guard.js';
import { redactAndClamp } from './redaction.js';
import { runCommand, type CommandResult, type RunOptions } from '../doctor/exec.js';
import { findRecord, type CapabilityRecord } from '../doctor/capabilities.js';
import type { AgentId } from '../core/states.js';

export type AuthStatusCode =
  /** Subscription / ChatGPT login positively confirmed. */
  | 'PASS'
  /** Login exists but is not an accepted subscription method (API key, console, unknown). */
  | 'AUTH_METHOD_REJECTED'
  /** Output could not be parsed or does not permit a subscription/API-key distinction. */
  | 'UNVERIFIABLE'
  /** No locally proven status command exists in the installed version. */
  | 'STATUS_COMMAND_UNAVAILABLE';

export interface AuthCheckResult {
  readonly agent: AgentId;
  readonly status: AuthStatusCode;
  readonly passed: boolean;
  /** The command actually used, or null if none could be determined. */
  readonly statusCommand: string | null;
  readonly exitCode: number | null;
  readonly reason: string;
  /**
   * Non-sensitive facts extracted from the status output. Populated from an
   * explicit allow-list of fields — account email, organisation id and
   * organisation name are never copied here.
   */
  readonly evidence: Readonly<Record<string, string | boolean>>;
  /** Redacted, otherwise unmodified status output, for human inspection. */
  readonly redactedOutput: string;
}

/** Fields we are willing to copy out of Claude's auth status JSON. */
const CLAUDE_ALLOWED_EVIDENCE_FIELDS = [
  'loggedIn',
  'authMethod',
  'apiProvider',
  'subscriptionType',
] as const;

/**
 * The only `authMethod` value accepted as a Claude subscription login.
 * Observed value on a `--claudeai` login of Claude Code 2.1.220.
 */
const CLAUDE_ACCEPTED_AUTH_METHODS: readonly string[] = ['claude.ai'];

/** The only accepted `apiProvider`. Anything else means a third-party route. */
const CLAUDE_ACCEPTED_API_PROVIDERS: readonly string[] = ['firstParty'];

/**
 * The only accepted `codex login status` phrasing. Anchored to the start of a
 * line and to the exact observed wording; anything else fails closed.
 */
const CODEX_CHATGPT_LOGIN_PATTERN = /^\s*Logged in using ChatGPT\b/im;

/**
 * Phrases that positively indicate a rejected method. Used only to produce a
 * *better error message* — a status never passes by failing to match these.
 */
const REJECTED_HINT_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /api[ _-]?key/i, reason: 'output mentions an API key' },
  { pattern: /console/i, reason: 'output mentions Anthropic Console / API billing' },
  { pattern: /not logged in|logged out|no credentials|please (run )?login/i, reason: 'not logged in' },
];

function describeRejection(output: string): string | null {
  for (const hint of REJECTED_HINT_PATTERNS) {
    if (hint.pattern.test(output)) return hint.reason;
  }
  return null;
}

// ── Claude ─────────────────────────────────────────────────────────────────

export function evaluateClaudeAuthStatus(result: CommandResult): AuthCheckResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const base = {
    agent: 'claude' as const,
    statusCommand: result.display,
    exitCode: result.exitCode,
    redactedOutput: redactAndClamp(combined.trim()),
  };

  if (result.outcome !== 'COMPLETED') {
    return {
      ...base,
      status: 'UNVERIFIABLE',
      passed: false,
      reason: `Status command did not complete (${result.outcome}).`,
      evidence: {},
    };
  }

  if (result.exitCode !== 0) {
    return {
      ...base,
      status: 'AUTH_METHOD_REJECTED',
      passed: false,
      reason:
        `Status command exited with code ${result.exitCode}` +
        (describeRejection(combined) !== null ? `; ${describeRejection(combined)}` : '') +
        '.',
      evidence: {},
    };
  }

  const raw = result.stdout.trim();
  if (raw.length === 0) {
    return {
      ...base,
      status: 'UNVERIFIABLE',
      passed: false,
      reason: 'Status command produced empty output; a subscription login cannot be proven.',
      evidence: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ...base,
      status: 'UNVERIFIABLE',
      passed: false,
      reason:
        'Status output is not valid JSON, so subscription and API-key auth cannot be told apart.',
      evidence: {},
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ...base,
      status: 'UNVERIFIABLE',
      passed: false,
      reason: 'Status output is JSON but not an object.',
      evidence: {},
    };
  }

  const record = parsed as Record<string, unknown>;

  // Copy only allow-listed, non-identifying fields.
  const evidence: Record<string, string | boolean> = {};
  for (const field of CLAUDE_ALLOWED_EVIDENCE_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' || typeof value === 'boolean') {
      evidence[field] = value;
    }
  }

  const loggedIn = record['loggedIn'];
  const authMethod = record['authMethod'];
  const apiProvider = record['apiProvider'];

  if (loggedIn !== true) {
    return {
      ...base,
      status: 'AUTH_METHOD_REJECTED',
      passed: false,
      reason: 'Claude Code reports that no account is logged in.',
      evidence,
    };
  }

  if (typeof authMethod !== 'string' || typeof apiProvider !== 'string') {
    return {
      ...base,
      status: 'UNVERIFIABLE',
      passed: false,
      reason:
        'Status JSON lacks the string fields authMethod/apiProvider that distinguish a ' +
        'subscription login from API-key billing.',
      evidence,
    };
  }

  if (!CLAUDE_ACCEPTED_AUTH_METHODS.includes(authMethod)) {
    return {
      ...base,
      status: 'AUTH_METHOD_REJECTED',
      passed: false,
      reason:
        `authMethod "${authMethod}" is not an accepted Claude subscription method ` +
        `(accepted: ${CLAUDE_ACCEPTED_AUTH_METHODS.join(', ')}).`,
      evidence,
    };
  }

  if (!CLAUDE_ACCEPTED_API_PROVIDERS.includes(apiProvider)) {
    return {
      ...base,
      status: 'AUTH_METHOD_REJECTED',
      passed: false,
      reason:
        `apiProvider "${apiProvider}" indicates a non-first-party route ` +
        `(accepted: ${CLAUDE_ACCEPTED_API_PROVIDERS.join(', ')}).`,
      evidence,
    };
  }

  return {
    ...base,
    status: 'PASS',
    passed: true,
    reason: `Claude subscription login confirmed (authMethod=${authMethod}, apiProvider=${apiProvider}).`,
    evidence,
  };
}

// ── Codex ──────────────────────────────────────────────────────────────────

export function evaluateCodexLoginStatus(result: CommandResult): AuthCheckResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const base = {
    agent: 'codex' as const,
    statusCommand: result.display,
    exitCode: result.exitCode,
    redactedOutput: redactAndClamp(combined.trim()),
  };

  if (result.outcome !== 'COMPLETED') {
    return {
      ...base,
      status: 'UNVERIFIABLE',
      passed: false,
      reason: `Status command did not complete (${result.outcome}).`,
      evidence: {},
    };
  }

  if (combined.trim().length === 0) {
    return {
      ...base,
      status: 'UNVERIFIABLE',
      passed: false,
      reason: 'Status command produced empty output; a ChatGPT login cannot be proven.',
      evidence: {},
    };
  }

  if (result.exitCode !== 0) {
    const hint = describeRejection(combined);
    return {
      ...base,
      status: 'AUTH_METHOD_REJECTED',
      passed: false,
      reason:
        `Status command exited with code ${result.exitCode}` + (hint !== null ? `; ${hint}` : '') + '.',
      evidence: {},
    };
  }

  if (CODEX_CHATGPT_LOGIN_PATTERN.test(combined)) {
    return {
      ...base,
      status: 'PASS',
      passed: true,
      reason: 'Codex reports a ChatGPT login.',
      evidence: { loginMethod: 'ChatGPT' },
    };
  }

  const hint = describeRejection(combined);
  return {
    ...base,
    status: 'AUTH_METHOD_REJECTED',
    passed: false,
    reason:
      'Status output does not match the confirmed ChatGPT login phrasing' +
      (hint !== null ? `; ${hint}` : '') +
      '. Failing closed.',
    evidence: {},
  };
}

// ── Orchestration ──────────────────────────────────────────────────────────

export interface AuthAssessment {
  readonly checks: readonly AuthCheckResult[];
  readonly allPassed: boolean;
}

function unavailable(agent: AgentId, reason: string): AuthCheckResult {
  return {
    agent,
    status: 'STATUS_COMMAND_UNAVAILABLE',
    passed: false,
    statusCommand: null,
    exitCode: null,
    reason,
    evidence: {},
    redactedOutput: '',
  };
}

/**
 * Runs both auth status checks in the sanitised child environment.
 *
 * The status commands are only executed once the capability dump has *proven*
 * that they exist in the installed versions.
 */
export async function runAuthPreflight(
  capabilities: readonly CapabilityRecord[],
  parentEnv: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<AuthAssessment> {
  const childEnv = createSanitizedChildEnv(parentEnv);
  const options: RunOptions = {
    env: childEnv,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  const checks: AuthCheckResult[] = [];

  // --- Claude ---
  const claudeStatusHelp = findRecord(capabilities, 'claude.auth.status.help');
  if (claudeStatusHelp === undefined || claudeStatusHelp.availability !== 'AVAILABLE') {
    checks.push(
      unavailable(
        'claude',
        'The installed Claude Code does not expose a usable `claude auth status` command ' +
          `(probe: ${claudeStatusHelp?.availability ?? 'MISSING'}).`,
      ),
    );
  } else {
    // `--json` is documented as the default by the probed help text; passing it
    // explicitly makes the format independent of any future default change.
    const supportsJson = /--json/.test(claudeStatusHelp.result.stdout);
    const args = supportsJson ? ['auth', 'status', '--json'] : ['auth', 'status'];
    const result = await runCommand('claude', args, options);
    checks.push(
      supportsJson
        ? evaluateClaudeAuthStatus(result)
        : {
            ...evaluateClaudeAuthStatus(result),
            status: 'UNVERIFIABLE',
            passed: false,
            reason:
              'The installed `claude auth status` does not advertise --json; the text format ' +
              'is not a proven basis for distinguishing subscription from API-key auth.',
          },
    );
  }

  // --- Codex ---
  const codexStatusHelp = findRecord(capabilities, 'codex.login.status.help');
  if (codexStatusHelp === undefined || codexStatusHelp.availability !== 'AVAILABLE') {
    checks.push(
      unavailable(
        'codex',
        'The installed Codex CLI does not expose a usable `codex login status` command ' +
          `(probe: ${codexStatusHelp?.availability ?? 'MISSING'}).`,
      ),
    );
  } else {
    const result = await runCommand('codex', ['login', 'status'], options);
    checks.push(evaluateCodexLoginStatus(result));
  }

  return { checks, allPassed: checks.every((c) => c.passed) };
}
