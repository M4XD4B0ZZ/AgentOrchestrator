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
 *  - Each status command runs in its **own** environment, built from that
 *    provider's policy (AO-FOUNDATION-REM-003A). The two probes never share a
 *    map, neither carries a credential variable, and neither carries the other
 *    provider's variables — so no value in the parent environment can make a
 *    check pass, and the Claude probe cannot answer for Codex or vice versa.
 *  - The status command to use is not guessed: it is confirmed against the
 *    capability dump first.
 *
 * ── No raw CLI output ever leaves this module (AO-002) ─────────────────────
 *
 * A check result carries **no** stdout, no stderr, no exception text and no
 * "redacted output" blob. It carries:
 *
 *  - a fixed internal {@link AuthReasonCode} and its static description,
 *  - the constant argv of the status command,
 *  - the numeric exit code,
 *  - and, on PASS only, typed allow-list evidence whose every value comes from
 *    a closed set.
 *
 * That means an unknown marker, a new token format or a localised error
 * sentence in the CLI's output has no path into the doctor report or the
 * console. Redaction still exists as defence in depth, but it is not the
 * boundary — the boundary is that unknown text is never copied at all.
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
 *   `codex login status` exits 0 and emits **one** human-readable line and
 *   nothing else. Measured on this machine, that line is written to *stderr*
 *   and stdout is empty (0 bytes):
 *       stdout: <empty>
 *       stderr: "Logged in using ChatGPT\n"   (24 bytes, one line)
 *   The check therefore evaluates the command's *total* output — stdout and
 *   stderr together — and demands that it consist of exactly one non-empty
 *   line equal to that phrase. Which stream carries it is a formatting detail
 *   of the CLI; the security property is that the whole output is that one
 *   line and nothing more. An API-key hint, a warning, a banner or a second
 *   result line all add a line and therefore fail closed.
 *   `codex login --help` documents `--with-api-key`, confirming an API-key
 *   login path exists and must be distinguished.
 *
 * ── Known gaps (see also `todos` in the doctor report) ─────────────────────
 *
 *  - No sample of Claude's `--console` / API-key status output was captured,
 *    and none was fabricated. The allow-list is positive-only, so an unknown
 *    `authMethod` fails closed; the *negative* case is simply unverified.
 *  - `codex login status` in 0.146.0 offers no machine-readable output format
 *    (`--help` lists only `-c/--config`, `--enable`, `--disable`). Exact text
 *    matching is therefore the only locally proven option.
 */

import { createProbeEnv } from './env-guard.js';
import { runCommand, type CommandResult, type RunOptions } from '../doctor/exec.js';
import { findRecord, probeSupportsFlag, type CapabilityRecord } from '../doctor/capabilities.js';
import type { AgentId } from '../core/states.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
// The mint. This is the only module in `src/` that may import it, and
// `tests/auth-preflight-evidence.test.ts` walks the tree to keep it that way:
// running the checks and producing the artefact are one act, and separating them
// would be exactly the seam a caller could step into.
import { mintAuthPreflightEvidence } from '../core/internal/auth-preflight-evidence.js';

export type AuthStatusCode =
  /** Subscription / ChatGPT login positively confirmed. */
  | 'PASS'
  /** Login exists but is not an accepted subscription method (API key, console, unknown). */
  | 'AUTH_METHOD_REJECTED'
  /** Output could not be parsed or does not permit a subscription/API-key distinction. */
  | 'UNVERIFIABLE'
  /** No locally proven status command exists in the installed version. */
  | 'STATUS_COMMAND_UNAVAILABLE';

/**
 * The closed set of outcomes this module can report.
 *
 * Every user-visible sentence about auth is looked up from
 * {@link AUTH_REASON_TEXT} by one of these codes. Nothing is ever interpolated
 * into it from CLI output.
 */
export type AuthReasonCode =
  // PASS
  | 'CLAUDE_SUBSCRIPTION_CONFIRMED'
  | 'CODEX_CHATGPT_CONFIRMED'
  // Shared failures
  | 'STATUS_COMMAND_NOT_COMPLETED'
  | 'STATUS_COMMAND_NONZERO_EXIT'
  | 'STATUS_OUTPUT_EMPTY'
  | 'STATUS_COMMAND_UNAVAILABLE'
  // Claude
  | 'CLAUDE_OUTPUT_NOT_JSON'
  | 'CLAUDE_OUTPUT_NOT_JSON_OBJECT'
  | 'CLAUDE_NOT_LOGGED_IN'
  | 'CLAUDE_AUTH_FIELDS_MISSING'
  | 'CLAUDE_AUTH_METHOD_NOT_ACCEPTED'
  | 'CLAUDE_API_PROVIDER_NOT_ACCEPTED'
  | 'CLAUDE_JSON_MODE_UNAVAILABLE'
  // Codex
  | 'CODEX_OUTPUT_NOT_SINGLE_LINE'
  | 'CODEX_PHRASE_NOT_RECOGNISED';

/**
 * Static descriptions. These strings are the *only* auth prose that ever
 * reaches a console or a report.
 */
export const AUTH_REASON_TEXT: Readonly<Record<AuthReasonCode, string>> = Object.freeze({
  CLAUDE_SUBSCRIPTION_CONFIRMED:
    'Claude subscription login confirmed: the status JSON reports the accepted authMethod and ' +
    'first-party api provider.',
  CODEX_CHATGPT_CONFIRMED:
    'Codex ChatGPT login confirmed: the status output is exactly the single recognised line.',

  STATUS_COMMAND_NOT_COMPLETED:
    'The status command did not complete (missing executable, spawn failure, timeout or output ' +
    'limit), so no login can be proven.',
  STATUS_COMMAND_NONZERO_EXIT:
    'The status command exited with a non-zero code. A login that cannot be reported is not a ' +
    'login we may rely on.',
  STATUS_OUTPUT_EMPTY:
    'The status command produced no output, so a subscription login cannot be proven.',
  STATUS_COMMAND_UNAVAILABLE:
    'The installed CLI does not expose the status command this check depends on.',

  CLAUDE_OUTPUT_NOT_JSON:
    'The status output is not valid JSON, so subscription and API-key auth cannot be told apart.',
  CLAUDE_OUTPUT_NOT_JSON_OBJECT: 'The status output is JSON but not an object.',
  CLAUDE_NOT_LOGGED_IN: 'Claude Code does not report a logged-in account.',
  CLAUDE_AUTH_FIELDS_MISSING:
    'The status JSON lacks the string fields authMethod/apiProvider that distinguish a ' +
    'subscription login from API-key billing.',
  CLAUDE_AUTH_METHOD_NOT_ACCEPTED:
    'The reported authMethod is not the accepted Claude subscription method. Only the locally ' +
    'observed subscription value is accepted; every other value fails closed.',
  CLAUDE_API_PROVIDER_NOT_ACCEPTED:
    'The reported apiProvider is not first-party, which indicates a third-party or gateway route.',
  CLAUDE_JSON_MODE_UNAVAILABLE:
    'The installed `claude auth status` does not advertise --json; its text format is not a proven ' +
    'basis for distinguishing subscription from API-key auth.',

  CODEX_OUTPUT_NOT_SINGLE_LINE:
    'The status output, stdout and stderr taken together, is not exactly one non-empty line. Any ' +
    'additional line — a warning, a banner or an API-key hint — means this is not the recognised ' +
    'ChatGPT login output.',
  CODEX_PHRASE_NOT_RECOGNISED:
    'The single output line is not exactly the confirmed ChatGPT login phrase. Any extra, missing ' +
    'or reworded text fails closed.',
});

/**
 * Fields we are willing to copy out of Claude's auth status JSON.
 *
 * Account email, organisation id and organisation name are deliberately absent
 * and are never copied, neither on PASS nor on FAIL.
 */
export const CLAUDE_ALLOWED_EVIDENCE_FIELDS = [
  'loggedIn',
  'authMethod',
  'apiProvider',
  'subscriptionType',
] as const;

/**
 * The only `authMethod` value accepted as a Claude subscription login.
 * Observed value on a `--claudeai` login of Claude Code 2.1.220.
 */
export const CLAUDE_ACCEPTED_AUTH_METHOD = 'claude.ai';

/** The only accepted `apiProvider`. Anything else means a third-party route. */
export const CLAUDE_ACCEPTED_API_PROVIDER = 'firstParty';

/**
 * Subscription tiers we have positively observed. `subscriptionType` is an
 * allow-listed *reporting* field, so like every other field it is mapped onto a
 * closed set rather than copied through: an unrecognised tier is recorded as
 * `UNRECOGNIZED` instead of carrying arbitrary CLI text into the report.
 *
 * This never affects the verdict — the verdict rests on `authMethod` and
 * `apiProvider` alone.
 */
export const OBSERVED_SUBSCRIPTION_TYPES = ['pro'] as const;
export type SubscriptionTypeEvidence =
  | (typeof OBSERVED_SUBSCRIPTION_TYPES)[number]
  | 'UNRECOGNIZED'
  | 'ABSENT';

function normaliseSubscriptionType(value: unknown): SubscriptionTypeEvidence {
  if (value === undefined || value === null) return 'ABSENT';
  for (const known of OBSERVED_SUBSCRIPTION_TYPES) {
    if (value === known) return known;
  }
  return 'UNRECOGNIZED';
}

/**
 * Typed allow-list evidence for a passing Claude check.
 * Every value is from a closed set, so nothing here can carry CLI text.
 */
export interface ClaudeAuthEvidence {
  readonly loggedIn: true;
  readonly authMethod: typeof CLAUDE_ACCEPTED_AUTH_METHOD;
  readonly apiProvider: typeof CLAUDE_ACCEPTED_API_PROVIDER;
  readonly subscriptionType: SubscriptionTypeEvidence;
}

/** Typed allow-list evidence for a passing Codex check. */
export interface CodexAuthEvidence {
  readonly loginMethod: 'ChatGPT';
}

export type AuthEvidence = ClaudeAuthEvidence | CodexAuthEvidence;

export interface AuthCheckResult {
  readonly agent: AgentId;
  readonly status: AuthStatusCode;
  readonly passed: boolean;
  /** Fixed internal code; the stable machine-readable outcome. */
  readonly reasonCode: AuthReasonCode;
  /** Static description of {@link reasonCode}. Never contains CLI output. */
  readonly reason: string;
  /** The command actually used, or null if none could be determined. */
  readonly statusCommand: string | null;
  readonly exitCode: number | null;
  /**
   * Typed allow-list evidence, present only on PASS. A failing check carries no
   * evidence at all: there is nothing about a rejected login we need to keep,
   * and anything we did keep would be attacker-influenced text.
   */
  readonly evidence: AuthEvidence | null;
}

function fail(
  agent: AgentId,
  status: Exclude<AuthStatusCode, 'PASS'>,
  reasonCode: AuthReasonCode,
  statusCommand: string | null,
  exitCode: number | null,
): AuthCheckResult {
  return {
    agent,
    status,
    passed: false,
    reasonCode,
    reason: AUTH_REASON_TEXT[reasonCode],
    statusCommand,
    exitCode,
    evidence: null,
  };
}

// ── Claude ─────────────────────────────────────────────────────────────────

export function evaluateClaudeAuthStatus(result: CommandResult): AuthCheckResult {
  const command = result.display;
  const failClaude = (
    status: Exclude<AuthStatusCode, 'PASS'>,
    reasonCode: AuthReasonCode,
  ): AuthCheckResult => fail('claude', status, reasonCode, command, result.exitCode);

  if (result.outcome !== 'COMPLETED') {
    return failClaude('UNVERIFIABLE', 'STATUS_COMMAND_NOT_COMPLETED');
  }
  if (result.exitCode !== 0) {
    return failClaude('AUTH_METHOD_REJECTED', 'STATUS_COMMAND_NONZERO_EXIT');
  }

  const raw = result.stdout.trim();
  if (raw.length === 0) {
    return failClaude('UNVERIFIABLE', 'STATUS_OUTPUT_EMPTY');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The exception text quotes the offending input, so it is discarded here
    // rather than carried into the result.
    return failClaude('UNVERIFIABLE', 'CLAUDE_OUTPUT_NOT_JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failClaude('UNVERIFIABLE', 'CLAUDE_OUTPUT_NOT_JSON_OBJECT');
  }

  const record = parsed as Record<string, unknown>;
  const loggedIn = record['loggedIn'];
  const authMethod = record['authMethod'];
  const apiProvider = record['apiProvider'];

  if (loggedIn !== true) {
    return failClaude('AUTH_METHOD_REJECTED', 'CLAUDE_NOT_LOGGED_IN');
  }
  if (typeof authMethod !== 'string' || typeof apiProvider !== 'string') {
    return failClaude('UNVERIFIABLE', 'CLAUDE_AUTH_FIELDS_MISSING');
  }
  if (authMethod !== CLAUDE_ACCEPTED_AUTH_METHOD) {
    return failClaude('AUTH_METHOD_REJECTED', 'CLAUDE_AUTH_METHOD_NOT_ACCEPTED');
  }
  if (apiProvider !== CLAUDE_ACCEPTED_API_PROVIDER) {
    return failClaude('AUTH_METHOD_REJECTED', 'CLAUDE_API_PROVIDER_NOT_ACCEPTED');
  }

  // Only reachable with the two accepted constants, so the evidence below is
  // literal, not copied text.
  return {
    agent: 'claude',
    status: 'PASS',
    passed: true,
    reasonCode: 'CLAUDE_SUBSCRIPTION_CONFIRMED',
    reason: AUTH_REASON_TEXT['CLAUDE_SUBSCRIPTION_CONFIRMED'],
    statusCommand: command,
    exitCode: result.exitCode,
    evidence: {
      loggedIn: true,
      authMethod: CLAUDE_ACCEPTED_AUTH_METHOD,
      apiProvider: CLAUDE_ACCEPTED_API_PROVIDER,
      subscriptionType: normaliseSubscriptionType(record['subscriptionType']),
    },
  };
}

// ── Codex ──────────────────────────────────────────────────────────────────

/**
 * The one accepted `codex login status` output, verbatim.
 *
 * This is the whole allow-list: the command's normalised output must consist of
 * exactly this one non-empty line. Not a prefix, not a substring, not a line
 * anchor — an exact single-line equality (AO-001). `Logged in using ChatGPT and
 * API key`, `Logged in using ChatGPT (plus)`, a second line, or any leading or
 * trailing sentence all fail closed, because a mixed or extended message is
 * precisely the case where we cannot tell which credential would actually be
 * used.
 */
export const CODEX_CHATGPT_LOGIN_LINE = 'Logged in using ChatGPT';

/**
 * Splits the command's whole output into non-empty, whitespace-trimmed lines.
 *
 * Both streams are considered, because the installed CLI reports its result on
 * stderr (see the module header). Leading/trailing whitespace and blank lines
 * are normalised away — that is a formatting difference, not a semantic one.
 * Everything else is preserved, so any additional word or line survives into
 * the comparison and fails it.
 */
export function normaliseCodexStatusLines(
  stdout: string,
  stderr = '',
): readonly string[] {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function evaluateCodexLoginStatus(result: CommandResult): AuthCheckResult {
  const command = result.display;
  const failCodex = (
    status: Exclude<AuthStatusCode, 'PASS'>,
    reasonCode: AuthReasonCode,
  ): AuthCheckResult => fail('codex', status, reasonCode, command, result.exitCode);

  if (result.outcome !== 'COMPLETED') {
    return failCodex('UNVERIFIABLE', 'STATUS_COMMAND_NOT_COMPLETED');
  }
  if (result.exitCode !== 0) {
    return failCodex('AUTH_METHOD_REJECTED', 'STATUS_COMMAND_NONZERO_EXIT');
  }

  // stdout and stderr together must amount to that one line and nothing else.
  // Any diagnostic — an API-key hint, a deprecation warning, a localisation
  // notice — adds a line here and is therefore rejected.
  const lines = normaliseCodexStatusLines(result.stdout, result.stderr);
  if (lines.length === 0) {
    return failCodex('UNVERIFIABLE', 'STATUS_OUTPUT_EMPTY');
  }
  if (lines.length !== 1) {
    return failCodex('AUTH_METHOD_REJECTED', 'CODEX_OUTPUT_NOT_SINGLE_LINE');
  }
  if (lines[0] !== CODEX_CHATGPT_LOGIN_LINE) {
    return failCodex('AUTH_METHOD_REJECTED', 'CODEX_PHRASE_NOT_RECOGNISED');
  }

  return {
    agent: 'codex',
    status: 'PASS',
    passed: true,
    reasonCode: 'CODEX_CHATGPT_CONFIRMED',
    reason: AUTH_REASON_TEXT['CODEX_CHATGPT_CONFIRMED'],
    statusCommand: command,
    exitCode: result.exitCode,
    evidence: { loginMethod: 'ChatGPT' },
  };
}

// ── Orchestration ──────────────────────────────────────────────────────────

export interface AuthAssessment {
  readonly checks: readonly AuthCheckResult[];
  readonly allPassed: boolean;
  /**
   * The unforgeable artefact a passing preflight produces, or `null`.
   *
   * `allPassed` answers "did it pass?" for a human reading a diagnosis.
   * {@link evidence} is what an *execution* path is given, and the difference is
   * the point of V2-05's I4: this assessment is an ordinary interface, so a
   * caller can write `{ checks: [], allPassed: true, … }` and TypeScript will
   * accept it — but it cannot fill this field, because
   * `core/internal/auth-preflight-evidence.ts` is the only producer and the type
   * is nominal. A fabricated assessment can therefore claim a pass to a reader
   * and still carry no authority to run anything.
   */
  readonly evidence: AuthPreflightEvidence | null;
}

/**
 * Runs both auth status checks, each in its own purpose-built environment.
 *
 * The status commands are only executed once the capability dump has *proven*
 * that they exist in the installed versions.
 *
 * `parentEnv` is a source to derive from, never something that is forwarded:
 * it is read only by {@link createProbeEnv}, once per provider, and neither
 * resulting map is shared, reused or mutated.
 */
export async function runAuthPreflight(
  capabilities: readonly CapabilityRecord[],
  parentEnv: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<AuthAssessment> {
  const timeout = timeoutMs === undefined ? {} : { timeoutMs };
  const checks: AuthCheckResult[] = [];

  // --- Claude ---
  const claudeStatusHelp = findRecord(capabilities, 'claude.auth.status.help');
  if (claudeStatusHelp === undefined || claudeStatusHelp.availability !== 'AVAILABLE') {
    checks.push(
      fail('claude', 'STATUS_COMMAND_UNAVAILABLE', 'STATUS_COMMAND_UNAVAILABLE', null, null),
    );
  } else {
    // `--json` is documented as the default by the probed help text; passing it
    // explicitly makes the format independent of any future default change.
    //
    // The answer comes from the capability facts, not from the probe's raw
    // output — that output no longer exists by this point (AO-002-R1). Both
    // `NO` and `UNKNOWN` fail closed: an unparseable help text is not evidence
    // that a machine-readable status format exists.
    const supportsJson = probeSupportsFlag(claudeStatusHelp, '--json');
    if (supportsJson !== 'YES') {
      checks.push(
        fail('claude', 'UNVERIFIABLE', 'CLAUDE_JSON_MODE_UNAVAILABLE', 'claude auth status', null),
      );
    } else {
      // Built here, for this one command: the Claude auth policy is the only
      // one that carries the profile roots the stored login lives under, and it
      // carries no credential and nothing belonging to Codex.
      const claudeOptions: RunOptions = { env: createProbeEnv('auth:claude', parentEnv), ...timeout };
      const result = await runCommand('claude', ['auth', 'status', '--json'], claudeOptions);
      checks.push(evaluateClaudeAuthStatus(result));
    }
  }

  // --- Codex ---
  const codexStatusHelp = findRecord(capabilities, 'codex.login.status.help');
  if (codexStatusHelp === undefined || codexStatusHelp.availability !== 'AVAILABLE') {
    checks.push(
      fail('codex', 'STATUS_COMMAND_UNAVAILABLE', 'STATUS_COMMAND_UNAVAILABLE', null, null),
    );
  } else {
    // A separate map from a separate policy: Codex reads its own login under
    // the profile root and must never see an Anthropic/Claude variable.
    const codexOptions: RunOptions = { env: createProbeEnv('auth:codex', parentEnv), ...timeout };
    const result = await runCommand('codex', ['login', 'status'], codexOptions);
    checks.push(evaluateCodexLoginStatus(result));
  }

  // The verdict is derived twice, from the same checks, by two functions that do
  // not consult each other: `allPassed` for the report, and the mint for the
  // authority. The mint additionally refuses an empty check list, so "no check
  // could even be attempted" cannot arrive at an execution path as a pass.
  return {
    checks,
    allPassed: checks.every((c) => c.passed),
    evidence: mintAuthPreflightEvidence(checks),
  };
}
