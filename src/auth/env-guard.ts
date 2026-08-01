/**
 * Child-environment guard (AO-FOUNDATION-REM-003A).
 *
 * Every process the diagnostics start receives an environment that was **built**
 * for it, not one that was inherited and then partially cleaned. The previous
 * design copied the caller's environment and deleted four API-key names from
 * it; everything else — `CLAUDE_CODE_OAUTH_TOKEN`, `NODE_OPTIONS`, `NODE_PATH`,
 * and every unknown variable — was handed to `node`, `npm`, `git`, `claude` and
 * `codex` alike, out of one single shared map.
 *
 * Two properties follow from that and are the reason for this module's shape:
 *
 *  - **Allow-list, not deny-list.** A variable reaches a child only if it is
 *    named here *and* the probe's policy asks for it. An unknown variable is
 *    dropped by construction, so no future variable — a new loader switch, a
 *    new provider credential — needs to be discovered and blacklisted first.
 *  - **Purpose-bound policies.** A capability probe (`--version` / `--help`)
 *    and a provider auth probe do not need the same access, so they do not get
 *    the same environment. Profile roots are scoped to the one probe that has a
 *    stated reason for them, and no probe gets a credential at all.
 *
 * Hard rules:
 *  - Pure. Neither `process.env`, nor the caller's map, nor a previously
 *    returned map is ever modified. Every call returns a fresh frozen object.
 *  - No value is cached, logged, serialised or copied into an error.
 *  - There is no switch — no flag, no environment variable, no test seam —
 *    that loosens a policy.
 *
 * ── What a policy does and does not control ────────────────────────────────
 *
 * A policy governs the environment block this process *supplies*. On Windows it
 * is not the last word on what the child ends up with: libuv back-fills a fixed
 * list of OS variables — `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`,
 * `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`,
 * `WINDIR` — out of *this* process's environment into every child, whatever
 * block is handed to `spawn`. Measured, not assumed (see
 * `tests/probe-env-policy.test.ts`).
 *
 * That back-fill is bounded and contains no credential and no loader switch, so
 * it does not weaken the properties this module exists for. It does mean
 * "withheld by policy" must be read as "not supplied by us" rather than
 * "unreachable by the child" for those eleven names — `TEMP` and `USERPROFILE`
 * in particular still arrive. Closing that gap means not inheriting them in the
 * orchestrator process either, which belongs to the exec-provenance work
 * (AO-FOUNDATION-FULL-REV-02 / AO-FOUNDATION-REM-003B), not here.
 */

/**
 * API-key style variables. Each of these can silently switch an agent CLI from
 * subscription auth to metered API-key billing.
 *
 * They are *not* a filter: {@link createProbeEnv} never copies an unlisted
 * name, so they are excluded by construction. The list exists because the
 * doctor reports their presence in the *parent* environment.
 */
export const FORBIDDEN_CHILD_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
] as const;

export type ForbiddenChildEnvVar = (typeof FORBIDDEN_CHILD_ENV_VARS)[number];

/**
 * Credential variables that are *not* API keys but are still withheld from
 * every diagnostic process.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` used to be forwarded deliberately, on the grounds
 * that it is a subscription OAuth path (`claude setup-token`) rather than a
 * metered API key. Being a legitimate credential is not a reason to hand it to
 * `node`, `npm`, `git` or `codex`, none of which have any use for it.
 *
 * It is withheld from the Claude auth probe as well, and that is a verdict
 * rather than an oversight:
 *
 *  - `claude auth status` is asked to prove that a subscription login **exists
 *    on this machine**. Handing it a token out of the environment would make it
 *    report the credential it was just given, so the check would be proving its
 *    own input.
 *  - No code path in this repository hands the token to an agent process, so a
 *    status obtained with it would not describe how the orchestrator will
 *    actually run Claude. The doctor must verify the stored login, because that
 *    is the one that will really be used.
 */
export const WITHHELD_AUTH_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;

/**
 * Loader / preload switches: variables that make an unrelated file execute
 * inside a diagnostic child process.
 *
 * Like {@link FORBIDDEN_CHILD_ENV_VARS} this is documentation and reporting
 * material, not the mechanism — the allow-list already excludes them. They are
 * named so the property can be asserted explicitly rather than inferred.
 *
 * `NODE_OPTIONS` and `npm_config_node_options` (npm's config spelling of the
 * same switch) can carry `--require` / `--import`; `NODE_PATH` redirects module
 * resolution. All three turn "run `node --version`" into "run someone's code".
 */
export const LOADER_INJECTION_ENV_VARS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NPM_CONFIG_NODE_OPTIONS',
] as const;

/**
 * Provider / gateway switches. These are never forwarded either, but their
 * mere presence in the parent environment is reported, because each one can
 * route an agent away from its subscription.
 */
export const OBSERVED_PROVIDER_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
] as const;

export type ObservedProviderEnvVar = (typeof OBSERVED_PROVIDER_ENV_VARS)[number];

// ── Probe environment policies ─────────────────────────────────────────────

/**
 * The closed set of environment policies — one per kind of process the
 * diagnostics start. Every call site names the one it uses; there is no
 * default.
 */
export const PROBE_ENV_POLICIES = [
  'capability:generic',
  'capability:claude',
  'capability:codex',
  'auth:claude',
  'auth:codex',
] as const;

export type ProbeEnvPolicy = (typeof PROBE_ENV_POLICIES)[number];

/**
 * The variables `exec.ts` needs to locate and start a program at all.
 *
 * `PATH`/`PATHEXT` resolve the command, `SystemRoot`/`windir` build the
 * absolute path of the Windows system tools, and `COMSPEC` names the
 * interpreter for a `.cmd` shim.
 *
 * Their **trustworthiness is not asserted here**: they still come from the
 * caller's environment, which is exactly the provenance defect tracked as
 * AO-FOUNDATION-FULL-REV-02 and remediated separately in
 * AO-FOUNDATION-REM-003B. They are listed because the current exec contract
 * cannot start a process without them, not because they are trusted.
 */
const EXEC_CONTRACT_VARS = Object.freeze([
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'COMSPEC',
] as const);

/**
 * Per-policy allow-lists. Every policy is stated separately, including where
 * two of them currently coincide: a probe's environment is a property of that
 * probe, and widening one must never widen another by accident.
 *
 * No policy contains a credential variable. Profile roots appear only where a
 * provider's *login state* is the thing being read.
 *
 * The record and every list in it are frozen: {@link probeEnvAllowlist} hands
 * these arrays out for reporting, and a caller must not be able to widen a
 * policy by pushing onto what it was given.
 */
const POLICY_ALLOWLIST: Readonly<Record<ProbeEnvPolicy, readonly string[]>> = Object.freeze({
  /**
   * `node`, `npm` and `git` version probes. They print a version string, so
   * they need to be startable and nothing else. No home directory: the profile
   * directory a Node child resolves comes from the operating system — the
   * process token on Windows, the passwd entry on POSIX — not from these
   * variables.
   */
  'capability:generic': EXEC_CONTRACT_VARS,

  /**
   * `claude --version` / `claude … --help`. Inert probes that report what the
   * installed CLI *can* do. They read no login, so they get no profile root and
   * no credential: a version number must not depend on who is logged in.
   */
  'capability:claude': EXEC_CONTRACT_VARS,

  /** `codex --version` / `codex … --help`. Same reasoning, and no Claude anything. */
  'capability:codex': EXEC_CONTRACT_VARS,

  /**
   * `claude auth status --json`. This probe's whole purpose is to read the
   * existing Claude subscription login, which lives under the per-user profile
   * (`~/.claude`, plus the app-data roots the Windows build keeps its per-user
   * state in). Those roots are therefore a stated provider need for this one
   * probe, and are withheld from every capability probe.
   *
   * It receives no credential variable — see {@link WITHHELD_AUTH_ENV_VARS} —
   * and no OpenAI/Codex variable of any kind.
   */
  'auth:claude': Object.freeze([
    ...EXEC_CONTRACT_VARS,
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ]),

  /**
   * `codex login status`. Codex keeps its login under `~/.codex`, so it needs
   * the profile root and nothing beyond it — no app-data roots, and in
   * particular no Anthropic/Claude variable.
   */
  'auth:codex': Object.freeze([...EXEC_CONTRACT_VARS, 'HOME', 'USERPROFILE']),
});

/** Thrown when a caller asks for a policy that does not exist. */
export class UnknownProbeEnvPolicyError extends Error {}

function isProbeEnvPolicy(value: unknown): value is ProbeEnvPolicy {
  return typeof value === 'string' && (PROBE_ENV_POLICIES as readonly string[]).includes(value);
}

/** Fail closed: an unrecognised policy never degrades to "some environment". */
function rejectUnknownPolicy(): never {
  // The rejected name is deliberately not echoed and no part of any environment
  // appears here: an error object must never carry environment data.
  throw new UnknownProbeEnvPolicyError(
    `Unknown probe environment policy. Known policies: ${PROBE_ENV_POLICIES.join(', ')}.`,
  );
}

/**
 * Reads one variable out of a caller-supplied environment.
 *
 * On Windows the real environment block is case-insensitive, so `Node_Options`
 * and `NODE_OPTIONS` are the same variable and a policy must not be evadable by
 * changing the spelling. A plain object — which is what a caller or a test hands
 * in — does not have that behaviour, so it is applied here. On POSIX, where
 * `path` and `PATH` genuinely are two different variables, the match stays
 * exact: matching case-insensitively there would *add* a variable the caller
 * never set.
 *
 * An empty value counts as absent, exactly as {@link presenceOf} treats it: it
 * can neither locate a program nor authenticate anything.
 */
function lookupEnvValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = source[name];
  if (direct !== undefined && direct !== '') return direct;
  if (process.platform !== 'win32') return undefined;

  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(source)) {
    if (key.toUpperCase() === wanted && value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Builds the environment for one probe.
 *
 * The result holds **only** the variables the named policy allows, under their
 * canonical spelling, and is a new frozen object on every call. The source map
 * is read for nothing else and is never modified.
 *
 * @throws UnknownProbeEnvPolicyError for a name outside
 * {@link PROBE_ENV_POLICIES}.
 */
export function createProbeEnv(
  policy: ProbeEnvPolicy,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!isProbeEnvPolicy(policy)) rejectUnknownPolicy();

  const env: NodeJS.ProcessEnv = {};
  // Driven by the allow-list rather than by the source, so the output can only
  // ever hold canonical names and two spellings of one variable cannot both
  // survive into it.
  for (const name of POLICY_ALLOWLIST[policy]) {
    const value = lookupEnvValue(source, name);
    if (value !== undefined) env[name] = value;
  }
  return Object.freeze(env);
}

/** The variables a policy may forward. For reporting and tests, not a filter. */
export function probeEnvAllowlist(policy: ProbeEnvPolicy): readonly string[] {
  if (!isProbeEnvPolicy(policy)) rejectUnknownPolicy();
  return POLICY_ALLOWLIST[policy];
}

// ── Parent-environment assessment (reporting only) ─────────────────────────

/** The only thing we are ever allowed to say about a credential variable. */
export type PresenceStatus = 'SET' | 'NOT_SET';

export function presenceOf(env: NodeJS.ProcessEnv, name: string): PresenceStatus {
  const value = env[name];
  // An empty string is treated as not set: it cannot authenticate anything.
  return value !== undefined && value !== '' ? 'SET' : 'NOT_SET';
}

export interface ProviderFlagObservation {
  readonly name: ObservedProviderEnvVar;
  readonly presence: PresenceStatus;
}

export interface CredentialVarObservation {
  readonly name: ForbiddenChildEnvVar;
  readonly presence: PresenceStatus;
  /** Always true — no policy forwards a credential variable. */
  readonly removedFromChildEnv: boolean;
}

export interface EnvironmentAssessment {
  /** SET/NOT_SET only. Never a value, length, prefix or hash. */
  readonly forbiddenVars: readonly CredentialVarObservation[];
  /** Credential variables that are not API keys and are still never forwarded. */
  readonly withheldAuthVars: readonly { name: string; presence: PresenceStatus }[];
  readonly providerFlags: readonly ProviderFlagObservation[];
  /** Provider/gateway flags that are set and therefore block the doctor. */
  readonly blockingProviderFlags: readonly ObservedProviderEnvVar[];
  /** API-key style variables present in the parent env (never forwarded, so a warning). */
  readonly warnedCredentialVars: readonly ForbiddenChildEnvVar[];
}

/**
 * Classifies the *parent* environment. Reporting only: no value read here ever
 * reaches a child process.
 *
 * Severity rationale:
 *
 *  - A set `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` /
 *    `CODEX_API_KEY` is a **WARN**, not a FAIL. No probe environment contains a
 *    credential variable at all — {@link createProbeEnv} copies only what a
 *    policy names — so the variable cannot reach an agent. It is still reported
 *    because it signals that metered credentials exist on this machine.
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
    withheldAuthVars: WITHHELD_AUTH_ENV_VARS.map((name) => ({
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
