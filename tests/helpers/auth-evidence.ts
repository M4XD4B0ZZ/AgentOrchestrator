/**
 * Real auth-preflight evidence for tests, produced the way production produces
 * it (V2-05 / I4).
 *
 * ── Why this helper exists at all ──────────────────────────────────────────
 *
 * `AuthPreflightEvidence` is opaque: a test cannot write one down, and that is
 * the whole point of the type. The tempting workaround is
 * `{} as unknown as AuthPreflightEvidence`, and it is forbidden here — a suite
 * that fabricates the artefact has quietly restored exactly the hole the type
 * was introduced to close, and would keep passing after a regression that made
 * the real preflight mint nothing.
 *
 * So this helper fabricates nothing. It drives the **real** evaluators over
 * synthetic *command output*, and mints from the **real** check results with the
 * **real** mint. The injection point is the CLI output — below the preflight's
 * judgement and above the artefact — which is the seam the evidence contract
 * asks callers to use.
 *
 * The only thing invented here is the text a logged-in `claude` and `codex`
 * print. If the accepted shape of that output ever changes, these evaluators
 * stop returning `passed: true`, this helper starts returning `null`, and the
 * suites that depend on a passing preflight fail — which is the correct
 * coupling. `tests/auth-whitelist.test.ts` owns the output grammar itself.
 *
 * The one legitimate use of a cast is a test whose *subject* is the forgery —
 * proving that a cast value is refused. That belongs in
 * `tests/auth-preflight-evidence.test.ts` beside the claim it disproves, not
 * here.
 */

import {
  CLAUDE_ACCEPTED_API_PROVIDER,
  CLAUDE_ACCEPTED_AUTH_METHOD,
  CODEX_CHATGPT_LOGIN_LINE,
  evaluateClaudeAuthStatus,
  evaluateCodexLoginStatus,
  OBSERVED_SUBSCRIPTION_TYPES,
  type AuthCheckResult,
} from '../../src/auth/auth-preflight.js';
import type { AuthPreflightEvidence } from '../../src/core/auth-preflight-evidence.js';
// The mint, imported by exactly one module in `src/` — and by this helper, which
// is not in `src/`. `tests/auth-preflight-evidence.test.ts` pins that
// distinction: the product has one producer, and a test reaching the real
// producer is not a second one.
import { mintAuthPreflightEvidence } from '../../src/core/internal/auth-preflight-evidence.js';
import type { CommandResult } from '../../src/doctor/exec.js';

/**
 * A completed, successful command result. Written out in full rather than cast
 * from a partial: a cast here would let a field the evaluators consult go
 * missing without the compiler saying so.
 */
function completed(stdout: string, stderr = ''): CommandResult {
  return Object.freeze({
    display: 'stub auth status',
    executable: 'stub',
    args: Object.freeze([]),
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.001Z',
    durationMs: 1,
    failureCode: null,
    errnoCode: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytesObserved: 0,
    stderrBytesObserved: 0,
    stdinDelivery: 'NOT_REQUESTED',
    processTreeKilled: false,
  });
}

/** The two checks a fully logged-in machine produces. */
export function passingAuthChecks(): readonly AuthCheckResult[] {
  // The accepted values come from the module under test, not from literals
  // copied into this helper: if the allow-list is ever narrowed, this helper
  // follows it instead of quietly describing a login the product would reject.
  const claude = evaluateClaudeAuthStatus(
    completed(
      JSON.stringify({
        loggedIn: true,
        authMethod: CLAUDE_ACCEPTED_AUTH_METHOD,
        apiProvider: CLAUDE_ACCEPTED_API_PROVIDER,
        subscriptionType: OBSERVED_SUBSCRIPTION_TYPES[0],
      }),
    ),
  );
  const codex = evaluateCodexLoginStatus(completed(CODEX_CHATGPT_LOGIN_LINE));
  return Object.freeze([claude, codex]);
}

/**
 * Evidence from a preflight that really passed.
 *
 * Throws rather than returning `null` when the evaluators disagree: a suite that
 * silently ran without evidence would test the denial path while claiming to
 * test the allowed one.
 */
export function provenAuthEvidence(): AuthPreflightEvidence {
  const checks = passingAuthChecks();
  const evidence = mintAuthPreflightEvidence(checks);
  if (evidence === null) {
    const failed = checks.filter((check) => !check.passed).map((check) => check.reasonCode);
    throw new Error(
      `auth-evidence helper minted nothing; failing checks: ${failed.join(', ') || 'none'}`,
    );
  }
  return evidence;
}

/** A preflight seam that passed, without starting any real CLI. */
export const authPreflightPasses = async (): Promise<AuthPreflightEvidence | null> =>
  provenAuthEvidence();

/** A preflight seam that did not pass. Mints nothing, exactly like the real one. */
export const authPreflightFails = async (): Promise<AuthPreflightEvidence | null> => null;
