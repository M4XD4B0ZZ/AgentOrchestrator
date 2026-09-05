/**
 * The trusted MCP capability registry — what the *operator* has approved (M5).
 *
 * ── The problem this exists for ────────────────────────────────────────────
 *
 * A real target repository can carry a binding governance rule that a coding
 * agent must use a particular MCP tool. Zera/HealthApp's `AGENTS.md` has one:
 * "CodeGraph Availability (Binding)" requires a real `codegraph_explore` call
 * before editing and says **stop** if the server is unavailable, with test
 * tasks explicitly outside its documentation-only exception.
 *
 * The writer this build starts cannot satisfy that. Measured, not reasoned:
 * `CLAUDE_WRITER_ARGS` carries `--strict-mcp-config`, and a writer started with
 * it reports `mcp_servers: []` and a five-member tool set. So a repository with
 * that rule can never be orchestrated — not because the orchestrator is unsafe,
 * but because it offers no way to say "this capability is approved here".
 *
 * ── Why the answer is not "read the repository's `.mcp.json`" ──────────────
 *
 * Because that file is repository content, and an MCP server definition is an
 * **executable**. Zera's own `.mcp.json` is tracked in Git and defines three
 * servers, two of which take credentials from the environment. Handing it to
 * the writer would let any repository choose a program for this machine to run
 * and hand it the operator's tokens. `--strict-mcp-config` and
 * `--setting-sources ''` already refuse it, and this module does not undo that:
 * the repository never supplies a command, an argument, an environment or a
 * server name. It supplies **one word** — the capability it needs — and that
 * word is checked against a closed set (`REPOSITORY_CAPABILITIES`) before it is
 * ever looked up here.
 *
 * ── One location, outside every repository ─────────────────────────────────
 *
 *     <OS user profile>/.agent-orchestrator/mcp-capabilities.yaml
 *
 * The same trust root as `notify.yaml`, `repositories.yaml` and
 * `delivery-automation.yaml`, and for the same reason `paths.ts` gives: the
 * root is derived from `os.userInfo()` through `config/internal/path-provider.ts`,
 * consults no environment block, and cannot be relocated by a caller, a parent
 * process or a repository file. A target repository cannot place this file,
 * whatever it contains.
 *
 * ── Absence is a refusal, not a default ────────────────────────────────────
 *
 * This differs from `notify.yaml` deliberately, and the difference is the whole
 * safety argument. A missing notification configuration means "off", because a
 * notifier may not decide whether work happens. A missing capability grant
 * means **not granted**, because a capability grant decides what authority a
 * writing agent holds — and the safe answer to "did the operator approve this?"
 * is never "probably".
 *
 * A repository that declares `codegraph: OPTIONAL` is unaffected either way: it
 * said it can work without the capability, so nothing is requested and nothing
 * is granted. Only `REQUIRED` reaches a grant, and only a grant reaches argv.
 *
 * ── What a refusal may say ─────────────────────────────────────────────────
 *
 * A closed code and nothing else. Never the path, never the file's bytes, never
 * a YAML parser message, never an errno text, and never any part of a command
 * or an argument — a refusal must not become the channel for the value it
 * refused.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { OS_PATH_PROVIDER, type PathProvider } from './internal/path-provider.js';
import { orchestratorHome } from './paths.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { isShellInertArgument } from '../doctor/exec.js';
import { REPOSITORY_CAPABILITIES, type RepositoryCapability } from '../repo/capabilities.js';
import { loadSafeYamlDocument } from '../yaml/safe-yaml.js';

/** The one file name. No alternative spelling and no `.yml` fallback. */
export const MCP_CAPABILITY_REGISTRY_FILE_NAME = 'mcp-capabilities.yaml';

/**
 * Largest registry this build will read.
 *
 * A ceiling rather than a guess: the document is one grant per member of a
 * closed one-member capability set, and anything approaching this is not one.
 * Refused before parsing, so an enormous file is never turned into a document.
 */
export const MAX_MCP_CAPABILITY_REGISTRY_BYTES = 65_536;

/** The only `schemaVersion` this build accepts. */
export const MCP_CAPABILITY_REGISTRY_SCHEMA_VERSION = 1;

/**
 * The grammar an MCP tool name must satisfy before it may be written into
 * `--allowedTools`.
 *
 * This is the load-bearing check in the module, and it is a grammar rather than
 * a length bound because of what the flag accepts. `--allowedTools` takes
 * *patterns*, and its own help gives `Bash(git *)` as an example — so a value
 * copied out of a blog post, a typo, or an operator who did not read this file
 * could otherwise turn a capability grant into shell authority. Only the
 * `mcp__<server>__<tool>` shape passes, so no accepted value can name a
 * built-in tool at all, `Bash` included, and none can carry a parenthesised
 * argument pattern.
 */
export const MCP_TOOL_NAME_PATTERN = /^mcp__[a-z0-9_]+__[a-z0-9_]+$/;

/**
 * Largest number of arguments a grant may carry.
 *
 * `codegraph serve --mcp` is two. The bound exists so a registry cannot become
 * a way to assemble an arbitrarily long command line.
 */
export const MAX_MCP_CAPABILITY_ARGS = 16;

/** Every way the registry can be present and unusable. Closed, and value-free. */
export const MCP_CAPABILITY_REGISTRY_REFUSALS = [
  /** The OS could not be asked where the user profile is, so there is no place to look. */
  'PROFILE_UNAVAILABLE',
  /** The file exists and could not be read. */
  'REGISTRY_UNREADABLE',
  'REGISTRY_TOO_LARGE',
  /** Not one well-formed, warning-free YAML document. */
  'REGISTRY_MALFORMED',
  /** Well-formed, and carries a mapping key this boundary refuses by name. */
  'REGISTRY_FORBIDDEN_KEY',
  /** A document that is not this contract: missing, unknown or mistyped fields. */
  'REGISTRY_CONTRACT_VIOLATION',
  /** A `schemaVersion` this build does not implement. */
  'REGISTRY_UNSUPPORTED_SCHEMA_VERSION',
  /** A capability name outside {@link REPOSITORY_CAPABILITIES}. */
  'CAPABILITY_NAME_UNKNOWN',
  /** A command or an argument that could not be put in argv unchanged. */
  'COMMAND_NOT_SHELL_INERT',
  /** A tool name outside {@link MCP_TOOL_NAME_PATTERN}. */
  'TOOL_NAME_REFUSED',
] as const;

export type McpCapabilityRegistryRefusal = (typeof MCP_CAPABILITY_REGISTRY_REFUSALS)[number];

/**
 * One approved capability, as the operator declared it.
 *
 * There is deliberately **no `env` member**. A grant that could carry
 * environment values would be a way to hand a spawned program the operator's
 * credentials, and the one capability this build knows about needs none. Adding
 * it later is a decision with its own argument to make, not an omission.
 */
/** An operator-declared command that makes a capability true in a working copy. */
export interface McpCapabilityPrepare {
  /** The program to start. Shell-inert, and never repository-supplied. */
  readonly command: string;
  /** Its arguments, in order. Each shell-inert. */
  readonly args: readonly string[];
}

export interface McpCapabilityGrant {
  readonly capability: RepositoryCapability;
  /** The program to start. Shell-inert, and never repository-supplied. */
  readonly command: string;
  /** Its arguments, in order. Each shell-inert. */
  readonly args: readonly string[];
  /**
   * The command that makes this capability true in a fresh working copy, or
   * `null` when the operator declared none.
   *
   * ── Why the operator supplies it and not the repository ──────────────────
   *
   * A task worktree is created by `git worktree add`, which populates tracked
   * content only — and a CodeGraph index is ignored, so no worktree ever
   * inherits one. Something has to make the index exist in the tree the writer
   * opens, and there are only three candidates: the repository names a command,
   * the writing agent runs one, or the operator names one.
   *
   * The repository may not, because that is a repository choosing a program for
   * this machine to run, which is the whole reason this file exists. The writer
   * may not, because `repo/capabilities.ts` treats the index directory as the
   * *evidence* for the capability, so a writer able to create it would mint the
   * proof of the capability AO fails closed on — an agent forging its own
   * authority. What is left is the operator, in this file, in the same voice
   * that already names the server command: one program, shell-inert arguments,
   * no environment, no repository input.
   *
   * Optional, and absence is not an error. A repository whose worktrees somehow
   * carry an index needs nothing here; one that does not, and declares the
   * capability `REQUIRED`, will park its tasks with the capability unsatisfied,
   * which is the fail-closed answer rather than a silent pass.
   */
  readonly prepare: McpCapabilityPrepare | null;
  /**
   * The exact tool name the writer may call, e.g.
   * `mcp__codegraph__codegraph_explore`.
   *
   * Named by the operator rather than derived by this build. Deriving it would
   * mean guessing a server's own tool naming, and a guess that is wrong fails
   * in the one place nobody looks — a writer that holds a tool it cannot call.
   * The preflight checks the named tool actually appears, so a typo is caught
   * as a refusal instead of as a silent loss of the capability.
   */
  readonly tool: string;
}

export type McpCapabilityRegistryOutcome =
  /** No file. Nothing is granted, and that is an answer rather than an error. */
  | { readonly state: 'NOT_CONFIGURED' }
  /** A file that cannot be used. Nothing is granted, and the operator is told. */
  | { readonly state: 'UNUSABLE'; readonly code: McpCapabilityRegistryRefusal }
  | {
      readonly state: 'CONFIGURED';
      /** Frozen, keyed by capability name. A capability absent here is not granted. */
      readonly grants: ReadonlyMap<RepositoryCapability, McpCapabilityGrant>;
    };

const unusable = (code: McpCapabilityRegistryRefusal): McpCapabilityRegistryOutcome =>
  Object.freeze({ state: 'UNUSABLE' as const, code });

/** Where the registry lives. A pure function of the OS user identity. */
export function mcpCapabilityRegistryPath(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(orchestratorHome(provider), MCP_CAPABILITY_REGISTRY_FILE_NAME);
}

/**
 * The document contract. `.strict()` at both levels, so an unknown key is a
 * refusal rather than a silently ignored intention — and in particular a
 * misspelled `tool:` does not become a grant with no callable tool.
 */
const PrepareSchema = z
  .object({
    command: z.string().min(1).max(256),
    args: z.array(z.string().min(1).max(256)).max(MAX_MCP_CAPABILITY_ARGS),
  })
  .strict();

const GrantSchema = z
  .object({
    command: z.string().min(1).max(256),
    args: z.array(z.string().min(1).max(256)).max(MAX_MCP_CAPABILITY_ARGS),
    tool: z.string().min(1).max(128),
    /**
     * Optional, and `.strict()` around it: a misspelled `prepare:` is a refusal
     * rather than a grant that silently prepares nothing.
     */
    prepare: PrepareSchema.optional(),
  })
  .strict();

const RegistrySchema = z
  .object({
    schemaVersion: z.number().int(),
    /**
     * A record rather than a list, because a capability is named once. The key
     * grammar is checked here only for shape; membership of
     * {@link REPOSITORY_CAPABILITIES} is checked below, where the refusal can
     * say which rule was broken.
     */
    capabilities: z.record(z.string().min(1).max(64), GrantSchema),
  })
  .strict();

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(REPOSITORY_CAPABILITIES);

function isRepositoryCapability(value: string): value is RepositoryCapability {
  return KNOWN_CAPABILITIES.has(value);
}

/**
 * Reads the operator's trusted capability registry, or says why there is none.
 *
 * Never throws. Every failure — including the operating system refusing to say
 * where the profile is — is a return value, because the caller has to be able
 * to distinguish "not granted" from "could not tell", and an exception makes
 * those two the same thing.
 */
export function loadMcpCapabilityRegistry(
  provider: PathProvider = OS_PATH_PROVIDER,
): McpCapabilityRegistryOutcome {
  let path: string;
  try {
    path = mcpCapabilityRegistryPath(provider);
  } catch {
    // `trustedProfileDirectory` throws rather than guessing. Its message is
    // already value-free, and it is dropped here regardless.
    return unusable('PROFILE_UNAVAILABLE');
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (safeErrnoCode(error) === 'ENOENT') {
      return Object.freeze({ state: 'NOT_CONFIGURED' as const });
    }
    return unusable('REGISTRY_UNREADABLE');
  }

  if (bytes.byteLength > MAX_MCP_CAPABILITY_REGISTRY_BYTES) return unusable('REGISTRY_TOO_LARGE');

  const parsed = loadSafeYamlDocument(bytes.toString('utf8'));
  if (parsed.outcome === 'FORBIDDEN_KEY') return unusable('REGISTRY_FORBIDDEN_KEY');
  if (parsed.outcome !== 'DOCUMENT') return unusable('REGISTRY_MALFORMED');

  const contract = RegistrySchema.safeParse(parsed.document);
  // The Zod issue is deliberately not carried: it is a message authored by a
  // dependency about a file this module refuses to quote.
  if (!contract.success) return unusable('REGISTRY_CONTRACT_VIOLATION');

  if (contract.data.schemaVersion !== MCP_CAPABILITY_REGISTRY_SCHEMA_VERSION) {
    return unusable('REGISTRY_UNSUPPORTED_SCHEMA_VERSION');
  }

  const grants = new Map<RepositoryCapability, McpCapabilityGrant>();
  for (const [name, declared] of Object.entries(contract.data.capabilities)) {
    // A name outside the closed set is refused rather than ignored. Ignoring it
    // would let a registry look like it granted something it did not, and the
    // failure would surface as an unexplained refusal much later.
    if (!isRepositoryCapability(name)) return unusable('CAPABILITY_NAME_UNKNOWN');

    if (!isShellInertArgument(declared.command)) return unusable('COMMAND_NOT_SHELL_INERT');
    for (const arg of declared.args) {
      if (!isShellInertArgument(arg)) return unusable('COMMAND_NOT_SHELL_INERT');
    }

    // The preparation command is held to the same grammar as the server
    // command, in the same pass. It goes into argv the same way and is started
    // by the same runner, so a second, weaker rule for it would be the drift
    // this module exists to prevent.
    if (declared.prepare !== undefined) {
      if (!isShellInertArgument(declared.prepare.command)) {
        return unusable('COMMAND_NOT_SHELL_INERT');
      }
      for (const arg of declared.prepare.args) {
        if (!isShellInertArgument(arg)) return unusable('COMMAND_NOT_SHELL_INERT');
      }
    }

    if (!MCP_TOOL_NAME_PATTERN.test(declared.tool)) return unusable('TOOL_NAME_REFUSED');

    grants.set(
      name,
      Object.freeze({
        capability: name,
        command: declared.command,
        args: Object.freeze([...declared.args]),
        tool: declared.tool,
        prepare:
          declared.prepare === undefined
            ? null
            : Object.freeze({
                command: declared.prepare.command,
                args: Object.freeze([...declared.prepare.args]),
              }),
      }),
    );
  }

  return Object.freeze({ state: 'CONFIGURED' as const, grants });
}
