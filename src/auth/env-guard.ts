/**
 * Child-environment guard.
 *
 * The orchestrator must drive both agent CLIs through their *subscription*
 * logins. The single most likely way to accidentally end up on metered API
 * billing is an API key sitting in the inherited environment. This module
 * produces a sanitised copy of an environment object.
 *
 * Hard rules:
 *  - Pure. The input object is never mutated, and the *process* environment of
 *    the machine or of this process is never modified.
 *  - Only the four variables in {@link FORBIDDEN_CHILD_ENV_VARS} are removed.
 *    Nothing else is stripped, because silently dropping unrelated variables
 *    would break project tooling in unpredictable ways.
 *  - `CLAUDE_CODE_OAUTH_TOKEN` is explicitly **kept**: it is a legitimate
 *    subscription OAuth path (`claude setup-token`), not an API key.
 */

/**
 * Variables removed from every child environment. Each of these can silently
 * switch an agent CLI from subscription auth to metered API-key billing.
 */
export const FORBIDDEN_CHILD_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
] as const;

export type ForbiddenChildEnvVar = (typeof FORBIDDEN_CHILD_ENV_VARS)[number];

/**
 * Variables that look credential-ish but must survive sanitisation.
 * Kept as an explicit list so a future "strip anything token-shaped" refactor
 * has a regression test to trip over.
 */
export const PRESERVED_AUTH_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;

/**
 * Provider / gateway switches. These are never removed (removing them could
 * mask a misconfiguration rather than fix it) but their mere presence is
 * reported, because each one can route an agent away from its subscription.
 */
export const OBSERVED_PROVIDER_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
] as const;

export type ObservedProviderEnvVar = (typeof OBSERVED_PROVIDER_ENV_VARS)[number];

/** The only thing we are ever allowed to say about a credential variable. */
export type PresenceStatus = 'SET' | 'NOT_SET';

export function presenceOf(env: NodeJS.ProcessEnv, name: string): PresenceStatus {
  const value = env[name];
  // An empty string is treated as not set: it cannot authenticate anything.
  return value !== undefined && value !== '' ? 'SET' : 'NOT_SET';
}

/**
 * Returns a **new** environment object with the forbidden variables removed.
 *
 * @param source environment to copy from; not mutated.
 */
export function createSanitizedChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...source };
  for (const name of FORBIDDEN_CHILD_ENV_VARS) {
    delete sanitized[name];
  }
  return sanitized;
}

export interface ProviderFlagObservation {
  readonly name: ObservedProviderEnvVar;
  readonly presence: PresenceStatus;
}

export interface CredentialVarObservation {
  readonly name: ForbiddenChildEnvVar;
  readonly presence: PresenceStatus;
  /** Always true for these four — they are stripped unconditionally. */
  readonly removedFromChildEnv: boolean;
}

export interface EnvironmentAssessment {
  /** SET/NOT_SET only. Never a value, length, prefix or hash. */
  readonly forbiddenVars: readonly CredentialVarObservation[];
  readonly preservedAuthVars: readonly { name: string; presence: PresenceStatus }[];
  readonly providerFlags: readonly ProviderFlagObservation[];
  /** Provider/gateway flags that are set and therefore block the doctor. */
  readonly blockingProviderFlags: readonly ObservedProviderEnvVar[];
  /** API-key style variables present in the parent env (stripped, so a warning). */
  readonly warnedCredentialVars: readonly ForbiddenChildEnvVar[];
}

/**
 * Classifies the environment.
 *
 * Severity rationale:
 *
 *  - A set `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` /
 *    `CODEX_API_KEY` is a **WARN**, not a FAIL. Every child process the
 *    orchestrator will ever start receives the sanitised environment from
 *    {@link createSanitizedChildEnv}, and that removal is unit-tested, so the
 *    variable cannot reach an agent. It is still reported because it signals
 *    that metered credentials exist on this machine.
 *
 *  - A set `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` or
 *    `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` is a **FAIL**. These route the
 *    agent to a third-party provider or a custom gateway whose billing and
 *    identity we cannot verify from here. That is precisely the "unknown
 *    provider / custom gateway without unambiguous subscription proof" case,
 *    and the orchestrator must fail closed rather than guess.
 */
export function assessEnvironment(source: NodeJS.ProcessEnv): EnvironmentAssessment {
  const forbiddenVars = FORBIDDEN_CHILD_ENV_VARS.map((name) => ({
    name,
    presence: presenceOf(source, name),
    removedFromChildEnv: true,
  }));

  const providerFlags = OBSERVED_PROVIDER_ENV_VARS.map((name) => ({
    name,
    presence: presenceOf(source, name),
  }));

  return {
    forbiddenVars,
    preservedAuthVars: PRESERVED_AUTH_ENV_VARS.map((name) => ({
      name,
      presence: presenceOf(source, name),
    })),
    providerFlags,
    blockingProviderFlags: providerFlags
      .filter((flag) => flag.presence === 'SET')
      .map((flag) => flag.name),
    warnedCredentialVars: forbiddenVars
      .filter((v) => v.presence === 'SET')
      .map((v) => v.name),
  };
}
