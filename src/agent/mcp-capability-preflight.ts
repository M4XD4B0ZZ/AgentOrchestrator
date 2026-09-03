/**
 * The MCP capability preflight — proving, before a writer starts, that a
 * capability a repository *requires* is one the operator granted and one that
 * actually answers (M5).
 *
 * ── Two questions, and neither may be assumed ──────────────────────────────
 *
 *  1. **Did the operator grant it?** Answered by
 *     `config/mcp-capability-registry.ts`, which reads one file under the OS
 *     user profile. A repository contributes the *name* of a capability and
 *     nothing else — no command, no argument, no environment, no server
 *     definition. That is the whole safety argument and it lives there.
 *  2. **Does it answer?** Answered here, by starting the real CLI with the real
 *     flags and reading the session's own `init` message.
 *
 * `repo/capabilities.ts` already says why the second question needs its own
 * answer: its `INDEX_PRESENT` is a fact about a directory and it declines, in
 * its own words, to claim "that an MCP server is configured, or that a
 * `codegraph_explore` tool is reachable" — and it says a later slice proving
 * reachability "earns a *second* status of its own; it does not redefine this
 * one". This module is that second status. `INDEX_PRESENT` is untouched.
 *
 * ── Why the proof runs the CLI rather than the server ──────────────────────
 *
 * AO could speak MCP to the server itself and skip a model turn. It would be
 * proving the wrong thing. What has to hold is that **the writer's session**
 * exposes the tool, and that is a property of the CLI's flag handling, not of
 * the server: measured, `--mcp-config` alone connects the server and the call
 * is still *denied*, and naming the tool in `--tools` connects it, lists it in
 * `init.tools`, and still denies the call. A proof that did not go through the
 * same binary and the same flags would have passed all three of those.
 *
 * ── What the probe may do: nothing ─────────────────────────────────────────
 *
 * `--tools ""` — the built-in set is empty, so the probe holds no `Write`, no
 * `Edit` and no `Read`. Measured: an MCP tool still appears in `init.tools`
 * with an empty built-in set, so the proof loses nothing by holding nothing.
 * The probe therefore cannot modify a repository even in principle, which is
 * what lets it run *before* the workspace exists rather than after.
 *
 * ── The exit code is not the evidence ──────────────────────────────────────
 *
 * Measured: a server whose command does not exist yields
 * `mcp_servers: [{"name":"codegraph","status":"failed"}]`, `tools: []` — and
 * **exit code 0**, exactly like the healthy run. A gate on the exit status
 * would pass a capability that is not there. The evidence is the `init`
 * message, and the check is positive: the named server must be `connected`
 * *and* the granted tool must appear by name.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WriterMcpGrant } from './claude-writer.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import {
  loadMcpCapabilityRegistry,
  type McpCapabilityGrant,
  type McpCapabilityRegistryOutcome,
  type McpCapabilityRegistryRefusal,
} from '../config/mcp-capability-registry.js';
import { orchestratorHome } from '../config/paths.js';
import { createProbeEnv } from '../auth/env-guard.js';
import { isShellInertArgument, runCommand, type CommandResult } from '../doctor/exec.js';
import { REPOSITORY_CAPABILITIES, type RepositoryCapability } from '../repo/capabilities.js';
import type { ResolvedCapabilities } from '../repo/resolve-repository.js';

/** Directory this build writes the writer's MCP configuration into. AO-owned. */
export const WRITER_MCP_CONFIG_DIR_NAME = 'mcp';
/** The one file. Rewritten from the registry on every invocation, never trusted from a previous one. */
export const WRITER_MCP_CONFIG_FILE_NAME = 'writer-mcp-config.json';

/**
 * The probe's own argv, minus the configuration path and the tool names.
 *
 * It shares `--strict-mcp-config` and `--setting-sources ''` with the writer on
 * purpose: a proof taken under looser flags would be a proof about a session
 * the writer never gets.
 */
const PROBE_HEAD: readonly string[] = Object.freeze([
  '--print',
  '--output-format',
  'stream-json',
  '--verbose',
  '--setting-sources',
  '',
  '--strict-mcp-config',
]);

/** The probe holds no built-in tool at all. Always last, because `--tools` is variadic. */
const PROBE_TOOLS: readonly string[] = Object.freeze(['--tools', '']);

/** The shortest thing that still makes the CLI open a session. */
const PROBE_PROMPT = 'Reply with the single word READY and nothing else.';

/** Every way a required capability can fail to be proven. Closed, and value-free. */
export const MCP_CAPABILITY_REFUSALS = [
  /** The operator's registry exists and is unusable. Carries the registry's own code. */
  'REGISTRY_UNUSABLE',
  /** No registry file, or a registry that grants nothing for this capability. */
  'CAPABILITY_NOT_GRANTED',
  /** The configuration this build writes for the CLI could not be written. */
  'CONFIG_WRITE_FAILED',
  /** A grant whose command, argument or generated path could not be put in argv unchanged. */
  'GRANT_NOT_SHELL_INERT',
  /** The probe process did not start, timed out, or produced no usable output. */
  'PROBE_DID_NOT_START',
  /** The probe ran and emitted no session announcement, so nothing was measured. */
  'PROBE_EMITTED_NO_SESSION',
  /** The session announced the server and it is not connected. */
  'SERVER_NOT_CONNECTED',
  /** The server connected and the granted tool is not in the session's tool set. */
  'GRANTED_TOOL_ABSENT',
] as const;

export type McpCapabilityRefusal = (typeof MCP_CAPABILITY_REFUSALS)[number];

export type McpCapabilityOutcome =
  /**
   * The repository requires no capability, so none was requested and none was
   * granted. The writer runs on the vector this build always shipped.
   */
  | { readonly state: 'NOT_REQUIRED' }
  /** Granted by the operator and observed answering. The writer may hold it. */
  | {
      readonly state: 'PROVEN';
      readonly grant: WriterMcpGrant;
      /** Which capabilities this grant covers, for the operator-facing report. */
      readonly capabilities: readonly RepositoryCapability[];
    }
  /**
   * Required and not proven. **The writer does not start.** A repository that
   * declared it needs a capability does not get a writing agent without it —
   * that is the fail-closed half, and it is the half the whole slice is for.
   */
  | {
      readonly state: 'REFUSED';
      readonly code: McpCapabilityRefusal;
      /** The registry's own code where `code` is `REGISTRY_UNUSABLE`, else `null`. */
      readonly registryCode: McpCapabilityRegistryRefusal | null;
      /** The capability that could not be proven. */
      readonly capability: RepositoryCapability;
    };

const refused = (
  capability: RepositoryCapability,
  code: McpCapabilityRefusal,
  registryCode: McpCapabilityRegistryRefusal | null = null,
): McpCapabilityOutcome => Object.freeze({ state: 'REFUSED' as const, code, registryCode, capability });

/** What a session announced about one MCP server. */
interface AnnouncedServer {
  readonly name: string;
  readonly status: string;
}

/** What this module needs out of the CLI's session announcement, and nothing more. */
export interface SessionAnnouncement {
  readonly servers: readonly AnnouncedServer[];
  readonly tools: readonly string[];
}

/**
 * Reads the session announcement out of a `stream-json` transcript.
 *
 * Deliberately narrow and deliberately total: unknown lines, non-JSON lines and
 * every other message type are skipped, and an absent announcement is `null`
 * rather than an empty one. "Nothing was announced" and "a session with no
 * servers" are different facts and the caller refuses on both, but for
 * different reasons — so they must not be folded together here.
 */
export function readSessionAnnouncement(stdout: string): SessionAnnouncement | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof message !== 'object' || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record.type !== 'system' || record.subtype !== 'init') continue;

    const servers: AnnouncedServer[] = [];
    if (Array.isArray(record.mcp_servers)) {
      for (const entry of record.mcp_servers) {
        if (typeof entry !== 'object' || entry === null) continue;
        const server = entry as Record<string, unknown>;
        if (typeof server.name === 'string' && typeof server.status === 'string') {
          servers.push(Object.freeze({ name: server.name, status: server.status }));
        }
      }
    }

    const tools: string[] = [];
    if (Array.isArray(record.tools)) {
      for (const tool of record.tools) if (typeof tool === 'string') tools.push(tool);
    }

    return Object.freeze({ servers: Object.freeze(servers), tools: Object.freeze(tools) });
  }
  return null;
}

/**
 * How a caller obtains the capability preflight for one repository.
 *
 * A factory rather than a single memo, and the difference matters once more
 * than one repository is in play: auth is a statement about *the machine*, so
 * `authPreflight` is one memo for a whole invocation, while a required
 * capability is a statement about *a repository* — two enlisted repositories
 * can legitimately differ, and one answer would be the wrong answer for one of
 * them.
 */
export type McpPreflightFactory = (
  capabilities: ResolvedCapabilities,
) => () => Promise<McpCapabilityOutcome>;

/**
 * The production factory: at most one probe per distinct requirement, for the
 * whole invocation.
 *
 * Memoised on the required-capability list rather than on the repository,
 * because what the probe measures — did the operator grant this, and does the
 * granted server answer — is a property of the operator's registry and of this
 * machine, not of which repository asked. Two repositories that both require
 * `codegraph` therefore share one probe, and a third that requires nothing
 * starts none.
 *
 * Each entry memoises the **attempt** and not the answer, with `??=` so the
 * assignment happens in the same synchronous step as the read. Two callers in
 * one turn cannot both start a probe process — the same correction
 * `onceOnlyPreflight` carries for auth, and for the same reason: a memo that
 * sets a flag *after* awaiting hands every concurrent caller the pre-answer
 * value.
 *
 * `parentEnv` is a source to derive from, never something forwarded:
 * {@link proveMcpCapabilities} builds a fresh, policy-scoped map for the probe.
 */
export function mcpPreflightFactory(
  parentEnv: NodeJS.ProcessEnv,
  override?: (required: readonly RepositoryCapability[]) => Promise<McpCapabilityOutcome>,
): McpPreflightFactory {
  const attempts = new Map<string, Promise<McpCapabilityOutcome>>();
  return (capabilities) => {
    const required = requiredMcpCapabilities(capabilities);
    // Sorted so two repositories declaring the same set in a different order
    // share the memo rather than probing twice for one answer.
    const key = [...required].sort().join(',');
    return async () => {
      let attempt = attempts.get(key);
      if (attempt === undefined) {
        attempt = override === undefined ? proveMcpCapabilities({ required, parentEnv }) : override(required);
        attempts.set(key, attempt);
      }
      return await attempt;
    };
  };
}

/**
 * Which capabilities a resolved repository actually *requires*.
 *
 * Total over {@link REPOSITORY_CAPABILITIES} by construction: the switch has a
 * case per member and an exhaustiveness check, so adding a capability to that
 * set is a compile error here rather than a member this function silently never
 * asks about.
 *
 * `OPTIONAL` yields nothing. A repository that said it can work without the
 * capability is not asking for a grant, so none is requested, none is proven,
 * and the writer runs on the vector this build always shipped.
 */
export function requiredMcpCapabilities(
  capabilities: ResolvedCapabilities,
): readonly RepositoryCapability[] {
  const required: RepositoryCapability[] = [];
  for (const capability of REPOSITORY_CAPABILITIES) {
    switch (capability) {
      case 'codegraph':
        if (capabilities.codegraph.requirement === 'REQUIRED') required.push('codegraph');
        break;
      default: {
        const unreachable: never = capability;
        throw new Error(`Unhandled repository capability: ${String(unreachable)}`);
      }
    }
  }
  return Object.freeze(required);
}

/** The probe, as a seam. Production starts a real `claude`; tests supply their own. */
export type CapabilityProbeRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export interface McpCapabilityPreflightRequest {
  /**
   * The capabilities this repository declared `REQUIRED`.
   *
   * Supplied by the caller from the resolved repository, never read here: what
   * a repository needs is the repository resolver's answer, and a second
   * opinion about it in this module would be a second place for the two to
   * disagree.
   */
  readonly required: readonly RepositoryCapability[];
  /** A source to derive the probe's environment from. Never forwarded as-is. */
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly provider?: PathProvider;
  readonly timeoutMs?: number;
  /** Seams. Production defaults; tests pass their own. */
  readonly loadRegistry?: (provider: PathProvider) => McpCapabilityRegistryOutcome;
  readonly probe?: CapabilityProbeRunner;
}

function productionProbe(timeoutMs: number | undefined): CapabilityProbeRunner {
  return async (args, env) =>
    runCommand('claude', args, {
      env,
      stdin: PROBE_PROMPT,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
}

/**
 * Proves every capability the repository requires, or refuses.
 *
 * One probe covers all required capabilities at once: they are written into one
 * configuration and one session announces all of them, so a second process
 * would only be a second chance to disagree.
 *
 * Never throws. A caller has to be able to distinguish "not granted" from
 * "could not tell", and an exception makes those two the same thing.
 */
export async function proveMcpCapabilities(
  request: McpCapabilityPreflightRequest,
): Promise<McpCapabilityOutcome> {
  const required = [...new Set(request.required)];
  if (required.length === 0) return Object.freeze({ state: 'NOT_REQUIRED' as const });

  const provider = request.provider ?? OS_PATH_PROVIDER;
  const load = request.loadRegistry ?? loadMcpCapabilityRegistry;
  const registry = load(provider);

  // The first required capability is what a refusal names. With v1's
  // single-member capability set there is only ever one; the loop below still
  // reports the specific one that failed.
  const first = required[0] as RepositoryCapability;

  if (registry.state === 'UNUSABLE') return refused(first, 'REGISTRY_UNUSABLE', registry.code);
  if (registry.state === 'NOT_CONFIGURED') return refused(first, 'CAPABILITY_NOT_GRANTED');

  const grants: McpCapabilityGrant[] = [];
  for (const capability of required) {
    const grant = registry.grants.get(capability);
    if (grant === undefined) return refused(capability, 'CAPABILITY_NOT_GRANTED');
    grants.push(grant);
  }

  let configPath: string;
  try {
    const directory = join(orchestratorHome(provider), WRITER_MCP_CONFIG_DIR_NAME);
    mkdirSync(directory, { recursive: true });
    configPath = join(directory, WRITER_MCP_CONFIG_FILE_NAME);
    // Written fresh from the registry every time. A file left by an earlier
    // invocation is never read back and never trusted: the grant of record is
    // the operator's YAML, and this JSON is only its transport to one CLI.
    writeFileSync(configPath, renderMcpConfig(grants), 'utf8');
  } catch {
    return refused(first, 'CONFIG_WRITE_FAILED');
  }

  const allowedTools = grants.map((grant) => grant.tool);
  const args: readonly string[] = [
    ...PROBE_HEAD,
    '--mcp-config',
    configPath,
    '--allowedTools',
    ...allowedTools,
    ...PROBE_TOOLS,
  ];
  // Checked here rather than left to `assertSafeArgs`, which throws: a path
  // this build generated under a user profile containing a space is a real
  // condition on somebody's machine, not a programming error, and it deserves a
  // refusal that names itself.
  if (!args.every(isShellInertArgument)) return refused(first, 'GRANT_NOT_SHELL_INERT');

  const probe = request.probe ?? productionProbe(request.timeoutMs);
  // `agent:claude` and not a policy of its own: this probe starts the same
  // program, for the same account, as the writer whose session it is proving.
  // Measured — the granted server reaches `connected` under exactly that block
  // plus the Windows back-fill, so nothing is added to reach it.
  const result = await probe(args, createProbeEnv('agent:claude', request.parentEnv));

  if (!result.started || result.outcome !== 'COMPLETED') {
    return refused(first, 'PROBE_DID_NOT_START');
  }

  const announcement = readSessionAnnouncement(result.stdout);
  if (announcement === null) return refused(first, 'PROBE_EMITTED_NO_SESSION');

  for (const grant of grants) {
    const server = announcement.servers.find((candidate) => candidate.name === serverName(grant));
    if (server === undefined || server.status !== 'connected') {
      return refused(grant.capability, 'SERVER_NOT_CONNECTED');
    }
    if (!announcement.tools.includes(grant.tool)) {
      return refused(grant.capability, 'GRANTED_TOOL_ABSENT');
    }
  }

  return Object.freeze({
    state: 'PROVEN' as const,
    grant: Object.freeze({ mcpConfigPath: configPath, allowedTools: Object.freeze(allowedTools) }),
    capabilities: Object.freeze(grants.map((grant) => grant.capability)),
  });
}

/**
 * The MCP server name a capability is published under.
 *
 * The capability name itself, so `codegraph` is served by a server called
 * `codegraph` and its tool is `mcp__codegraph__…`. That coupling is what lets
 * the registry's tool-name grammar mean something: an operator cannot name a
 * server one thing and a tool another and have the pair silently accepted.
 */
function serverName(grant: McpCapabilityGrant): string {
  return grant.capability;
}

/**
 * Renders the CLI's `--mcp-config` document from the grants.
 *
 * Only granted servers appear, and each carries only `type`, `command` and
 * `args`. There is no `env` member because {@link McpCapabilityGrant} has none:
 * a document that could carry environment values would be a way to hand a
 * spawned program the operator's credentials.
 */
export function renderMcpConfig(grants: readonly McpCapabilityGrant[]): string {
  const servers: Record<string, unknown> = {};
  for (const grant of grants) {
    servers[serverName(grant)] = {
      type: 'stdio',
      command: grant.command,
      args: [...grant.args],
    };
  }
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}
