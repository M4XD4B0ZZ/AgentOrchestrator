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
 *  - **Unambiguous, or nothing.** On Windows two spellings of one variable are
 *    one variable with two values, and choosing between them would be choosing
 *    by insertion order. That case is refused rather than resolved
 *    (AO-FOUNDATION-REM-003A-RR-01): see {@link ProbeEnvironmentCollisionError}.
 *  - **Read once, decide afterwards.** The source is enumerated a single time
 *    and only its own enumerable string-named properties are taken, through
 *    their descriptors. No getter in the source ever runs, so nothing the source
 *    does while being read can remove a collision or change a value
 *    (AO-FOUNDATION-REM-003A-R1-REVIEW-01/-02): see
 *    {@link ProbeEnvironmentUnreadableError}.
 *  - **A source that answers through code is not read at all.** Reading once is
 *    only worth anything if the answers are the object's own. A proxy can make
 *    the same object describe itself differently to `ownKeys` than to
 *    `getOwnPropertyDescriptor`, so a proxied source is refused before any of it
 *    is touched (AO-FOUNDATION-REM-003A-R2-REVIEW-01): see
 *    {@link requireNonProxySource}.
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
 * in particular still arrive. Closing that residual informational-leak gap
 * means not inheriting them in the orchestrator process either, which remains
 * separate follow-up work, not this module's remit.
 *
 * This is distinct from — and narrower than — the executable-*selection*
 * provenance defect AO-FOUNDATION-FULL-REV-02 tracked: whether a
 * caller-controlled `SystemRoot`/`windir`/`COMSPEC` could choose *which
 * binary* answered PATH resolution, ran a `.cmd`/`.bat` target, or terminated
 * a process tree. That is closed as of AO-FOUNDATION-REM-003B — those three
 * names are no longer part of {@link EXEC_CONTRACT_VARS} or any policy below,
 * and the tools themselves come from a fixed, environment-independent
 * boundary (`src/doctor/internal/windows-system-tools.ts`). The back-fill
 * described here plays no part in that: it only affects what a child's *own*
 * environment shows it, never what this process chooses to execute.
 */

import { types } from 'node:util';

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

/**
 * Every variable `gh help environment` documents as able to change *where a
 * request goes, who it authenticates as, where the credential is read from,
 * what appears on the client's streams, or what traffic the client sends of its
 * own accord* (V4 slice 2).
 *
 * The fifth class was added after the fourth turned out not to cover
 * `GH_TELEMETRY` and `DO_NOT_TRACK`, which change the client's own network
 * behaviour rather than its output.
 *
 * Like the lists above this is documentation and a test surface, not the
 * mechanism: `forge:github` names three variables and the allow-list excludes
 * everything else by construction, so not one of these reaches the client even
 * though none of them is filtered. Naming them makes the property assertable
 * instead of inferred, and records what was actually read rather than guessed.
 *
 * Grouped by what each one would do, from `gh` 2.97.0's own help text:
 *
 *  - credentials: `GH_TOKEN`, `GITHUB_TOKEN` take precedence over the stored
 *    login for `github.com`; `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`
 *    do the same for an Enterprise host;
 *  - destination: `GH_HOST` picks the host when one is not given, `GH_REPO`
 *    picks the repository for commands that would otherwise use the local one;
 *  - credential location: `GH_CONFIG_DIR` moves the config directory outright,
 *    and `XDG_CONFIG_HOME` takes precedence over the Windows app-data path that
 *    `APPDATA` names;
 *  - streams: `GH_DEBUG` set to `api` logs the details of HTTP traffic to
 *    standard error and `DEBUG` (deprecated) enables verbose output on the same
 *    stream; `GH_FORCE_TTY` and `CLICOLOR_FORCE` make the client emit terminal
 *    formatting into output that is being parsed;
 *  - the client's own traffic: `GH_TELEMETRY` prints telemetry to standard
 *    error or disables it outright, and `DO_NOT_TRACK` disables it. Neither is
 *    forwarded, and the consequence is stated rather than dressed up: an
 *    operator who has `DO_NOT_TRACK` set in their own environment does **not**
 *    get it honoured here, because this policy supplies names rather than
 *    passing them through. The client's own calls are therefore left to its own
 *    configuration file, which is where residual `L-V4-02-6` points. Forwarding
 *    them would mean this allow-list carrying variables whose only purpose is to
 *    change the behaviour of a program AO does not own, and the same argument
 *    that keeps `GH_HOST` out keeps these out;
 *  - other programs: `GH_PAGER`, `PAGER`, `GH_BROWSER`, `BROWSER`, `GH_EDITOR`,
 *    `GIT_EDITOR`, `VISUAL` and `EDITOR` each name a program the client may
 *    start.
 *
 * The proxy variables at the end are **not** in `gh help environment` at all.
 * They are here because they were measured to redirect the request anyway:
 * `HTTPS_PROXY=http://127.0.0.1:1 gh api …` failed with
 * `proxyconnect tcp: dial tcp 127.0.0.1:1` while the same call without it
 * answered normally, and `NO_PROXY` was measured to undo that redirection. A
 * list built only from the client's own documentation would have missed the
 * variables that decide where the request goes.
 *
 * The consequence is stated rather than worked around: this build does not
 * forward proxy configuration, so on a machine that reaches GitHub only through
 * a proxy the observation refuses instead of succeeding. That is the correct
 * direction for a variable that chooses a network destination.
 */
export const FORGE_CLIENT_OVERRIDE_ENV_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'GH_DEBUG',
  'DEBUG',
  'GH_TELEMETRY',
  'DO_NOT_TRACK',
  'GH_FORCE_TTY',
  'CLICOLOR_FORCE',
  'GH_PAGER',
  'PAGER',
  'GH_BROWSER',
  'BROWSER',
  'GH_EDITOR',
  'GIT_EDITOR',
  'VISUAL',
  'EDITOR',
  'GH_PATH',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'NO_PROXY',
] as const;

export type ForgeClientOverrideEnvVar = (typeof FORGE_CLIENT_OVERRIDE_ENV_VARS)[number];

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
  'agent:claude',
  'agent:codex',
  'forge:github',
] as const;

export type ProbeEnvPolicy = (typeof PROBE_ENV_POLICIES)[number];

/**
 * The variables `exec.ts` needs to locate and start a *target* program at
 * all: `PATH` and, on Windows, `PATHEXT` resolve the command via a direct
 * filesystem walk (no subprocess, no `where.exe`).
 *
 * `SystemRoot`, `windir` and `COMSPEC` used to be listed here as well, to
 * build the absolute path of the Windows system tools (`where.exe`,
 * `cmd.exe`, `taskkill.exe`) and to name the `.cmd` interpreter. That was the
 * provenance defect tracked as AO-FOUNDATION-FULL-REV-02: a caller-controlled
 * value here directly chose which binary answered PATH resolution, ran a
 * resolved `.cmd`/`.bat` target, or terminated a process tree. As of
 * AO-FOUNDATION-REM-003B those three tools are resolved from a fixed,
 * environment-independent Windows system boundary
 * (`src/doctor/internal/windows-system-tools.ts`) and are no longer part of
 * any probe's supplied environment at all.
 */
const EXEC_CONTRACT_VARS = Object.freeze(['PATH', 'PATHEXT'] as const);

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
   * (`~/.claude`). The profile root is therefore a stated provider need for this
   * one probe, and is withheld from every capability probe.
   *
   * `APPDATA` and `LOCALAPPDATA` used to be listed here as well, on the
   * assumption that the Windows build keeps per-user login state under the
   * app-data roots (AO-FOUNDATION-REM-003A-RR-02). They are gone: the login this
   * probe has to read lives under the profile root, no observed `claude auth
   * status` run needed either variable, and an allow-list entry is only
   * justified by a demonstrated need. Two variables that name writable
   * directories are not carried on a guess.
   *
   * It receives no credential variable — see {@link WITHHELD_AUTH_ENV_VARS} —
   * and no OpenAI/Codex variable of any kind.
   */
  'auth:claude': Object.freeze([...EXEC_CONTRACT_VARS, 'HOME', 'USERPROFILE']),

  /**
   * `codex login status`. Codex keeps its login under `~/.codex`, so it needs
   * the profile root and nothing beyond it — no app-data roots, and in
   * particular no Anthropic/Claude variable.
   */
  'auth:codex': Object.freeze([...EXEC_CONTRACT_VARS, 'HOME', 'USERPROFILE']),

  /**
   * The Claude *writer* run — the agent process that actually edits a
   * worktree, not a probe that asks a question about it.
   *
   * It gets the same four variables as `auth:claude` and, deliberately, not
   * one more. The reasoning is the same reasoning: the CLI has to be
   * locatable (`PATH`/`PATHEXT`) and it has to find the subscription login
   * that `auth:claude` just proved exists, which lives under the profile
   * root. CLI-login operation is the expected mode, so no credential variable
   * appears here either — a writer that needed one would be running under an
   * authentication path the preflight never verified.
   *
   * Stated separately from `auth:claude` even though the two lists coincide
   * today, for the reason given above: these are different processes doing
   * different things, and a future need of the writer must not silently
   * widen what a read-only status probe receives.
   */
  'agent:claude': Object.freeze([...EXEC_CONTRACT_VARS, 'HOME', 'USERPROFILE']),

  /** The Codex *reviewer* run. Same reasoning, against `~/.codex`, and no Claude anything. */
  'agent:codex': Object.freeze([...EXEC_CONTRACT_VARS, 'HOME', 'USERPROFILE']),

  /**
   * `gh api …` — the read-only GitHub observation client (V4 slice 2).
   *
   * `APPDATA` is here because it was **measured** to be the one addition that
   * makes the installed client find its own stored login, and because
   * `gh help environment` names `$AppData/GitHub CLI` as the Windows config
   * directory. Measured on this build with `gh` 2.97.0, three runs each:
   *
   *     PATH + PATHEXT                -> exit 4, "please run gh auth login"
   *     PATH + PATHEXT + APPDATA      -> exit 0, an authenticated answer
   *     PATH + PATHEXT + USERPROFILE  -> exit 4
   *     PATH + PATHEXT + LOCALAPPDATA -> exit 4
   *
   * So this is the smallest set that must be *added* to reach an authenticated
   * answer, arrived at by measurement rather than by listing the variables a
   * credential *might* live under — the same standard `auth:claude` was held to
   * when `APPDATA` and `LOCALAPPDATA` were removed from it for being carried on
   * a guess.
   *
   * ── What this policy is, and what it is not ────────────────────────────
   *
   * It is the block AO *supplies*. It is **not** the environment the client
   * ends up with, and an earlier version of this comment read the four runs
   * above as though it were. See the module header: on Windows `runCommand`
   * hands the boundary `withWindowsPlatformBackfill(env)`, which merges eleven
   * OS names — `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`,
   * `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR` —
   * out of this process's own environment into every child. The forge client
   * therefore receives `SYSTEMROOT` and `USERPROFILE` whatever this list says,
   * and a claim about the child's environment that is measured with `env -i`
   * in a shell is a claim about a different environment.
   *
   * That back-fill is bounded, and this is exactly how far the bound is
   * checked. `tests/v4-02-delivery-observation.test.ts` asserts that not one of
   * the eleven appears in {@link FORGE_CLIENT_OVERRIDE_ENV_VARS} — so none of
   * them is a variable the client's own documentation says will redirect
   * authentication, host selection, the config directory, the streams or the
   * client's own traffic.
   *
   * What that assertion is **not** is a proof that no back-filled name can
   * influence the client by some route its documentation does not describe: the
   * two lists are drawn from different families, so their disjointness is close
   * to given. Two of the eleven are worth naming for that reason. `PATH` is in
   * both this policy and the back-fill and it does decide *which* `gh` runs —
   * supplied deliberately, and executable provenance is settled separately
   * (AO-FOUNDATION-REM-003B). And `HOMEDRIVE`/`HOMEPATH` compose into a home
   * directory that a config-directory fallback could in principle consult;
   * measured here only to the extent that `USERPROFILE` alone does not
   * authenticate the client, which is the case that would have mattered.
   * Carried as `L-V4-02-9` rather than described as closed.
   *
   * Measured against the shipped path rather than against a shell, same client,
   * same day: `PATH + PATHEXT + APPDATA + SYSTEMROOT` answers exit 0, the full
   * back-filled shape answers exit 0, and a real `agent-loop delivery
   * --observe` returned a graded check state for a real commit. `SYSTEMROOT` is
   * not in this list because nothing here needs to supply it, which is a
   * smaller and true statement; it is not withheld from the client, and it does
   * not decide whether the client can reach GitHub.
   *
   * No credential variable appears, and in particular none of
   * {@link FORGE_CLIENT_OVERRIDE_ENV_VARS}: the client authenticates itself
   * from the operator's own config directory, and this build never handles the
   * token. `APPDATA` is what makes that directory findable here — measured, and
   * `USERPROFILE` alone does not substitute for it, so the back-filled profile
   * root does not quietly open a second way in. Where the login is not
   * reachable the client reports that it needs an authentication and the
   * observation refuses, which is the correct closed answer.
   */
  'forge:github': Object.freeze([...EXEC_CONTRACT_VARS, 'APPDATA']),
});

/** Thrown when a caller asks for a policy that does not exist. */
export class UnknownProbeEnvPolicyError extends Error {}

/** The one text the unreadable-source error ever carries. No name, no value. */
export const PROBE_ENV_UNREADABLE_MESSAGE =
  'The source environment could not be read as a stable set of plain variables, so no probe ' +
  'environment was built. Details are withheld because they would be environment data.';

/** The one code the unreadable-source error ever carries. */
export const PROBE_ENV_UNREADABLE_CODE = 'PROBE_ENV_UNREADABLE';

/**
 * Thrown when the source environment cannot be reduced to a stable set of plain
 * variables (AO-FOUNDATION-REM-003A-R1-REVIEW-01).
 *
 * An environment is a set of names and string values. A source that only answers
 * through code — an accessor under an allow-listed name, a proxy trap that
 * throws, a key that is listed but has no descriptor — is not that, and there is
 * no safe way to turn it into one: running the code would let the source observe
 * which variables a policy asks for and change its own shape while it is being
 * read. So it is refused instead, before any of it is used.
 *
 * Like {@link ProbeEnvironmentCollisionError} this carries a static message and
 * nothing else: it is raised *while* reading an environment, so any further
 * detail — the name, the value, the text a getter or trap threw — would be
 * environment data in an error object. The foreign error is dropped entirely
 * rather than attached as a `cause`.
 */
export class ProbeEnvironmentUnreadableError extends Error {
  /** Fixed, allow-listed code. Never derived from an environment. */
  readonly code = PROBE_ENV_UNREADABLE_CODE;

  constructor() {
    super(PROBE_ENV_UNREADABLE_MESSAGE);
    this.name = 'ProbeEnvironmentUnreadableError';
  }
}

/** The one text the collision error ever carries. Contains no name, no value. */
export const PROBE_ENV_COLLISION_MESSAGE =
  'The source environment holds more than one spelling of the same variable, so the ' +
  'environment a probe would receive depends on insertion order. No probe environment ' +
  'was built. Details are withheld because they would be environment data.';

/** The one code the collision error ever carries. */
export const PROBE_ENV_COLLISION_CODE = 'PROBE_ENV_COLLISION';

/**
 * Thrown when the source environment holds more than one spelling of the same
 * Windows variable (AO-FOUNDATION-REM-003A-RR-01).
 *
 * Windows treats the environment block case-insensitively, so `Path` and `pAtH`
 * are one variable there — but a plain JavaScript object can hold both, and then
 * *which* of the two a probe is started with would be decided by insertion
 * order. An order-dependent environment is not a policy, so this is refused
 * instead of resolved: there is no first-wins, last-wins, exact-spelling-wins or
 * sorted rule to reason about, and no probe is started with a value that a
 * differently ordered map would have changed.
 *
 * The message is static and the error carries nothing else. A collision is
 * detected *by* reading the environment, so any detail beyond "it happened"
 * would be environment data in an error object.
 */
export class ProbeEnvironmentCollisionError extends Error {
  /** Fixed, allow-listed code. Never derived from an environment. */
  readonly code = PROBE_ENV_COLLISION_CODE;

  constructor() {
    super(PROBE_ENV_COLLISION_MESSAGE);
    this.name = 'ProbeEnvironmentCollisionError';
  }
}

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
 * Refuses a source whose answers are not its own, before a single question is
 * asked of it (AO-FOUNDATION-REM-003A-R2-REVIEW-01).
 *
 * ── Why the snapshot alone is not enough ───────────────────────────────────
 *
 * {@link snapshotAllowlistProperties} reads the source through two separate
 * operations — one `Reflect.ownKeys`, then one descriptor read per relevant key
 * — and reasons about the result as if both described the same object. For a
 * plain object they do. A proxy breaks that: the two operations are two trap
 * calls, and the object is free to answer them differently. Two ways through
 * were demonstrated:
 *
 *  - a key that is own **and enumerable** at `ownKeys` time is described as
 *    non-enumerable when its descriptor is finally asked for. The alias is then
 *    skipped, the Windows collision that existed at enumeration silently
 *    disappears, and the canonical spelling is forwarded — the very
 *    order-dependence {@link ProbeEnvironmentCollisionError} exists to refuse;
 *  - a real accessor is described as a data property by the descriptor trap.
 *    The `'value' in descriptor` classification then reports a plain value, and
 *    the binding accessor refusal in {@link createProbeEnv} never triggers.
 *
 * Neither is fixable by reading more carefully: any check would itself be
 * another trap call, answerable differently again. The only stable property is
 * *that the source is a proxy at all*, so that is what is checked.
 *
 * ── Why `types.isProxy` and nothing else ───────────────────────────────────
 *
 * `node:util`'s `types.isProxy` asks the VM about the object's internal shape.
 * It runs no trap — verified on the installed Node before this guard was
 * written — so the source cannot observe the check, cannot answer it, and
 * cannot throw out of it; a revoked proxy is still recognised as one rather
 * than exploding. Every alternative would be worse by construction:
 * `instanceof`, `constructor`, `getPrototypeOf` and `toStringTag` are all
 * themselves trappable, and provoking a trap to see whether one exists would
 * run the very code this module refuses to run.
 *
 * The check therefore has to come **before** `Reflect.ownKeys`, before any
 * descriptor read, before any prototype or property access, and before any copy
 * (`Object.assign`, spread, `Object.entries`, `structuredClone` — each one runs
 * traps or getters). A proxy around an otherwise perfectly ordinary
 * `process.env` is refused too: the wrapper, not the target, is what would be
 * answering.
 *
 * A source that is not an object at all is refused here as well, for the same
 * reason it was refused before: there is no set of own properties to read.
 *
 * @throws ProbeEnvironmentUnreadableError — the existing static error, carrying
 * no name, no value and no foreign text. What kind of source was refused is
 * itself something the source chose, so it is not reported either.
 */
function requireNonProxySource(source: unknown): void {
  if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
    throw new ProbeEnvironmentUnreadableError();
  }
  if (types.isProxy(source)) throw new ProbeEnvironmentUnreadableError();
}

/**
 * What one own, enumerable, string-named property of the source turned out to
 * be, captured once and never looked up again.
 *
 * An accessor is recorded as *the fact that it is one*, without its value: the
 * getter is not run (see {@link snapshotAllowlistProperties}).
 */
type EnvProperty =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'accessor' };

/**
 * Takes the one snapshot of the source this module ever works from
 * (AO-FOUNDATION-REM-003A-R1-REVIEW-01/-02).
 *
 * ── Why a snapshot, and why exactly one ────────────────────────────────────
 *
 * The environment a probe receives must be a function of what the source *was*,
 * not of the order in which this module happened to ask about it. Reading the
 * source repeatedly — once per allow-listed name, as this used to — makes the
 * result depend on what the source does between two reads, and a source can do
 * things: an own enumerable getter under `Path` may delete `pAtH` when it is
 * read, and the case-insensitive collision that existed at the start of the call
 * is gone by the time the next name is looked at. That was observable: with the
 * getter defined first the collision disappeared and a `PATH` was forwarded;
 * with the alias defined first the same two variables were refused.
 *
 * So the source is enumerated **once**, each relevant key's descriptor is read
 * **once**, and every later decision — collisions, values — is made against the
 * captured result. Nothing the source does afterwards can reach the outcome,
 * because nothing is asked of it afterwards.
 *
 * ── What counts as a variable ──────────────────────────────────────────────
 *
 * Only the source's **own, enumerable, string-named** properties. That is
 * exactly what a real environment block is, and it is what the caller can see in
 * its own map:
 *
 *  - inherited properties are ignored — `Object.create({ PATH })` describes a
 *    prototype, not an environment, and forwarding it would hand a probe a
 *    variable the caller never set (this used to happen on POSIX, where the
 *    lookup was a plain `source[name]` read);
 *  - non-enumerable properties are ignored, for the same reason: they are not
 *    part of what the object presents as its contents;
 *  - symbol-keyed properties are ignored — an environment variable has a name.
 *
 * ── Why getters are never run ──────────────────────────────────────────────
 *
 * A property is captured through its descriptor, so a data property yields its
 * value and an accessor yields only the knowledge that it is an accessor. Its
 * getter is not called here and is not called later either: an accessor under an
 * allow-listed name is refused by {@link createProbeEnv}. Code that runs while
 * the environment is being read could delete a colliding alias, alter another
 * value, throw a secret, or make the answer depend on iteration order — and none
 * of that has to be reasoned about if it never runs.
 *
 * Anything that makes the source unreadable as a plain set of variables — a
 * throwing enumeration or descriptor read, or a key that is listed but has no
 * descriptor — fails closed as {@link ProbeEnvironmentUnreadableError}, with the
 * foreign error dropped rather than wrapped. A *proxied* source never gets this
 * far: {@link requireNonProxySource} refuses it before this function is called,
 * because a proxy can answer the enumeration and the descriptor reads below as
 * if they described two different objects.
 *
 * Only keys the policy could actually forward are captured. A credential
 * variable is not merely dropped from the output — its value is never held here
 * at all.
 *
 * @param caseInsensitive `true` on Windows, where the environment block folds
 * case and `Path` and `pAtH` are one variable; `false` on POSIX, where they are
 * two and only an exact name matches.
 * @returns canonical allow-list name → every own enumerable property of the
 * source that names it. More than one entry is the Windows collision case.
 */
function snapshotAllowlistProperties(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  caseInsensitive: boolean,
): ReadonlyMap<string, readonly EnvProperty[]> {
  const wanted = new Map<string, string>();
  for (const name of allowlist) wanted.set(caseInsensitive ? name.toUpperCase() : name, name);

  let ownKeys: readonly (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(source as object);
  } catch {
    // The thrown value is deliberately not inspected, rethrown or attached: it
    // comes from the source and may be anything, including a secret.
    throw new ProbeEnvironmentUnreadableError();
  }

  const found = new Map<string, EnvProperty[]>();
  for (const key of ownKeys) {
    // A symbol is not a variable name.
    if (typeof key !== 'string') continue;
    const canonical = wanted.get(caseInsensitive ? key.toUpperCase() : key);
    // Nothing a policy could forward, so nothing worth reading.
    if (canonical === undefined) continue;

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      throw new ProbeEnvironmentUnreadableError();
    }
    // Enumerated as own, yet has no own descriptor: the source contradicts
    // itself, so there is no stable set of variables to build from.
    if (descriptor === undefined) throw new ProbeEnvironmentUnreadableError();
    if (descriptor.enumerable !== true) continue;

    const property: EnvProperty =
      'value' in descriptor ? { kind: 'data', value: descriptor.value } : { kind: 'accessor' };
    const matches = found.get(canonical);
    if (matches === undefined) found.set(canonical, [property]);
    else matches.push(property);
  }
  return found;
}

/**
 * Builds the environment for one probe.
 *
 * The result holds **only** the variables the named policy allows, under their
 * canonical spelling, and is a new frozen object on every call. The source map
 * is read for nothing else and is never modified.
 *
 * ── The two phases ─────────────────────────────────────────────────────────
 *
 * The source is snapshotted once (see {@link snapshotAllowlistProperties}), and
 * then:
 *
 *  1. **every** allow-listed name is checked for ambiguity, before a single
 *     value is used;
 *  2. only then is each unambiguous name's value taken, out of the one
 *     descriptor captured for it.
 *
 * The order matters: it is what makes a collision on the seventh name refuse the
 * whole environment rather than the first six values already having been read
 * out of a source that was watching.
 *
 * ── Why a second spelling is a hard error (AO-FOUNDATION-REM-003A-RR-01) ────
 *
 * On Windows the environment block is case-insensitive, so `Node_Options` and
 * `NODE_OPTIONS` are one variable and a policy must not be evadable by changing
 * the spelling. A plain object can hold `Path` **and** `pAtH`, which the Windows
 * block itself could never do, and picking one of them would be picking by
 * insertion order. That is not a policy decision, so every ambiguous case fails
 * closed instead:
 *
 *  - no case-insensitive match  → the variable is simply not forwarded;
 *  - exactly one                → forwarded under the canonical allow-list name;
 *  - more than one              → {@link ProbeEnvironmentCollisionError}.
 *
 * The exactly-canonical spelling gets no precedence either: `{ PATH, Path }` is
 * as ambiguous as `{ Path, pAtH }`. On POSIX `path` and `PATH` genuinely are two
 * variables, so the match is exact and the ambiguity cannot arise: matching
 * case-insensitively there would *add* a variable the caller never set.
 *
 * An empty value counts as absent, exactly as {@link presenceOf} treats it: it
 * can neither locate a program nor authenticate anything. It is still a *key*,
 * though, so `{ PATH: '', Path: 'x' }` is a collision and not a tie-break. A
 * value that is not a string is not an environment value and is likewise not
 * forwarded — while still counting as a key.
 *
 * Either the whole environment is built or none of it is. The map under
 * construction is local to this call and is only ever reachable through the
 * `return`, so a refusal discards whatever was already resolved rather than
 * handing back a partial environment.
 *
 * @throws UnknownProbeEnvPolicyError for a name outside
 * {@link PROBE_ENV_POLICIES}.
 * @throws ProbeEnvironmentCollisionError when the source holds two spellings of
 * one allow-listed variable on Windows. Nothing is returned in that case.
 * @throws ProbeEnvironmentUnreadableError when the source is a proxy (see
 * {@link requireNonProxySource}, checked before anything is read), when it
 * cannot be read as a plain set of variables, or when it answers an allow-listed
 * name with an accessor.
 */
export function createProbeEnv(
  policy: ProbeEnvPolicy,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!isProbeEnvPolicy(policy)) rejectUnknownPolicy();

  // Before anything is asked of the source: a proxy would be free to answer the
  // enumeration and the descriptor reads below inconsistently, and the snapshot
  // is only meaningful for an object that answers as itself. Neither this check
  // nor the policy check above touches the source, so nothing can have run yet.
  requireNonProxySource(source);

  const allowlist = POLICY_ALLOWLIST[policy];
  const properties = snapshotAllowlistProperties(
    source,
    allowlist,
    process.platform === 'win32',
  );

  // Phase 1. Driven by the allow-list rather than by the source, so the verdict
  // covers every name a policy could forward before any of them is used. On
  // POSIX a name has at most one exact key, so this can only ever pass there.
  for (const name of allowlist) {
    const matches = properties.get(name);
    if (matches !== undefined && matches.length > 1) throw new ProbeEnvironmentCollisionError();
  }

  // Phase 2. Every value comes out of the single descriptor captured for its
  // key; the source is not consulted again, so no prototype fallback and no
  // late mutation can change what a probe is started with.
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    const property = properties.get(name)?.[0];
    if (property === undefined) continue;
    if (property.kind !== 'data') throw new ProbeEnvironmentUnreadableError();
    const value = property.value;
    if (typeof value === 'string' && value !== '') env[name] = value;
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
