/**
 * M5 — a repository may *require* a named MCP capability, and only the operator
 * may say what that capability is.
 *
 * ── The defect this slice closes, stated as it was measured ────────────────
 *
 * Zera/HealthApp's `AGENTS.md` makes a real CodeGraph MCP call mandatory before
 * a coding task edits anything, and says **stop** if the server is unavailable —
 * with test tasks explicitly outside its documentation-only exception. The
 * writer this build starts runs with `--strict-mcp-config`, so it holds no MCP
 * tool at all. Measured against CLI 2.1.259, four arms, same shipped head:
 *
 * ```text
 * (shipped)                          mcp_servers []            call NO_TOOL
 * + --mcp-config                     codegraph connected       call DENIED
 * + --mcp-config, tool in --tools    codegraph connected       call DENIED
 * + --mcp-config, --allowedTools     codegraph connected       call OK
 * ```
 *
 * So the repository could never be orchestrated, and the third arm is why this
 * could not have been fixed by reading: naming the tool in `--tools` lists it in
 * the session's own `init.tools` and the call is still refused.
 *
 * ── What the suite has to establish, and what it cannot ────────────────────
 *
 * It cannot re-measure the CLI: that costs subscription quota and would make the
 * gate a statement about a machine. What it can do — and what the cases below
 * are — is prove the *authority* half end to end: that a repository can name a
 * capability and can supply nothing else, that an ungranted or unanswering
 * capability stops the writer before it starts, and that a grant adds exactly
 * one server and one tool to a vector that is otherwise unchanged.
 *
 * The measured half lives in the module comments it justifies
 * (`agent/claude-writer.ts`, `agent/mcp-capability-preflight.ts`), which is
 * where a reader deciding whether to change the argv will be standing.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CLAUDE_WRITER_ARGS,
  claudeWriterArgs,
  runClaudeWriter,
  type WriterMcpGrant,
} from '../src/agent/claude-writer.js';
import {
  MCP_CAPABILITY_REFUSALS,
  proveMcpCapabilities,
  readSessionAnnouncement,
  renderMcpConfig,
  requiredMcpCapabilities,
  type McpCapabilityOutcome,
} from '../src/agent/mcp-capability-preflight.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import {
  loadMcpCapabilityRegistry,
  mcpCapabilityRegistryPath,
  MCP_TOOL_NAME_PATTERN,
  type McpCapabilityGrant,
} from '../src/config/mcp-capability-registry.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import type { CommandResult } from '../src/doctor/exec.js';
import { attentionForRunCondition } from '../src/core/run-attention.js';
import { resolveRepository, type ResolvedRepository } from '../src/repo/resolve-repository.js';
import { driveLifecycle } from '../src/run/lifecycle-driver.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import {
  FIXTURE_A_PROFILE,
  FIXTURE_PROFILE_RELATIVE_PATH,
  git,
  writeRepoFile,
} from './helpers/repo-fixtures.js';

/* ═══════════════════════ fixtures ═══════════════════════════════════════ */

/** A scratch OS-profile directory, plus the registry path inside it. */
function makeHome(): { readonly provider: ReturnType<typeof fixedPathProvider>; readonly path: string } {
  const home = makeCanonicalTempDir('ao-m5-home-');
  const provider = fixedPathProvider(home);
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  return { provider, path: mcpCapabilityRegistryPath(provider) };
}

const GRANTED = [
  'schemaVersion: 1',
  'capabilities:',
  '  codegraph:',
  '    command: codegraph',
  '    args: [serve, --mcp]',
  '    tool: mcp__codegraph__codegraph_explore',
].join('\n');

function withRegistry(text: string): ReturnType<typeof makeHome> {
  const home = makeHome();
  writeFileSync(home.path, text, 'utf8');
  return home;
}

/** A `CommandResult` carrying one `stream-json` session announcement. */
function probeResult(servers: unknown, tools: readonly string[]): CommandResult {
  const init = JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers, tools });
  return {
    display: 'claude',
    executable: 'claude',
    args: [],
    started: true,
    outcome: 'COMPLETED',
    // Measured: a server that cannot start still exits 0. The gate must not be
    // the exit status, and this fixture keeps it 0 in every arm so that a
    // implementation that read it would pass the failing cases too.
    exitCode: 0,
    signal: null,
    stdout: `${init}\n{"type":"result","result":"READY"}\n`,
    stderr: '',
    startedAt: '2026-09-03T00:00:00.000Z',
    finishedAt: '2026-09-03T00:00:01.000Z',
  } as unknown as CommandResult;
}

const CONNECTED = probeResult(
  [{ name: 'codegraph', status: 'connected' }],
  ['mcp__codegraph__codegraph_explore'],
);

const REQUIRES_CODEGRAPH = {
  codegraph: { capability: 'codegraph' as const, requirement: 'REQUIRED' as const, status: 'INDEX_PRESENT' as const, satisfied: true },
};
const OPTIONAL_CODEGRAPH = {
  codegraph: { capability: 'codegraph' as const, requirement: 'OPTIONAL' as const, status: 'UNAVAILABLE' as const, satisfied: true },
};

/* ═══════ 1. The repository names a capability and supplies nothing else ═══ */

describe('a repository may name a capability and may supply nothing else', () => {
  it('takes the server definition from the operator profile, never from a repository', () => {
    const home = withRegistry(GRANTED);
    const registry = loadMcpCapabilityRegistry(home.provider);

    expect(registry.state).toBe('CONFIGURED');
    if (registry.state !== 'CONFIGURED') return;
    const grant = registry.grants.get('codegraph');
    expect(grant?.command).toBe('codegraph');
    expect(grant?.args).toEqual(['serve', '--mcp']);
    // The path is under the OS user profile, which `config/paths.ts` derives
    // from `os.userInfo()`. No repository can place a file there.
    expect(home.path).toContain('.agent-orchestrator');
    expect(home.path.endsWith('mcp-capabilities.yaml')).toBe(true);
  });

  it('refuses a capability name outside the closed set', () => {
    // The shape a repository would need to smuggle a server in: a name AO does
    // not know, carrying a command. Refused by name rather than ignored, so it
    // cannot look like a grant that simply never applied.
    const home = withRegistry(
      [
        'schemaVersion: 1',
        'capabilities:',
        '  totally-not-codegraph:',
        '    command: curl',
        '    args: [http://example.invalid]',
        '    tool: mcp__x__y',
      ].join('\n'),
    );
    const registry = loadMcpCapabilityRegistry(home.provider);
    expect(registry).toEqual({ state: 'UNUSABLE', code: 'CAPABILITY_NAME_UNKNOWN' });
  });

  it('refuses a grant that carries an environment, so no credential can be plumbed to it', () => {
    // `.strict()` at the grant level. Zera's own tracked `.mcp.json` defines two
    // servers whose `env` carries a Supabase token and a GitHub PAT; this is the
    // check that says such a document has no shape in this contract at all.
    const home = withRegistry(
      [
        'schemaVersion: 1',
        'capabilities:',
        '  codegraph:',
        '    command: codegraph',
        '    args: [serve, --mcp]',
        '    tool: mcp__codegraph__codegraph_explore',
        '    env:',
        '      GITHUB_PERSONAL_ACCESS_TOKEN: secret',
      ].join('\n'),
    );
    expect(loadMcpCapabilityRegistry(home.provider)).toEqual({
      state: 'UNUSABLE',
      code: 'REGISTRY_CONTRACT_VIOLATION',
    });
  });

  it('refuses a command or an argument that is not shell-inert', () => {
    for (const line of ['    command: cmd /c whoami', '    command: codegraph"']) {
      const home = withRegistry(
        [
          'schemaVersion: 1',
          'capabilities:',
          '  codegraph:',
          line,
          '    args: [serve]',
          '    tool: mcp__codegraph__codegraph_explore',
        ].join('\n'),
      );
      expect(loadMcpCapabilityRegistry(home.provider)).toEqual({
        state: 'UNUSABLE',
        code: 'COMMAND_NOT_SHELL_INERT',
      });
    }
  });

  it('refuses every tool name that is not mcp__server__tool — including a Bash pattern', () => {
    // The load-bearing case. `--allowedTools` takes *patterns*, and its own help
    // gives `Bash(git *)` as the example — so without this grammar a capability
    // grant is a route to shell authority. Each of these is a value somebody
    // could plausibly paste in.
    for (const tool of [
      'Bash(git *)',
      'Bash',
      'Write',
      'Read',
      '*',
      'mcp__codegraph__*',
      'mcp__codegraph',
      'MCP__Codegraph__Explore',
      'mcp__codegraph__codegraph_explore extra',
    ]) {
      expect(MCP_TOOL_NAME_PATTERN.test(tool)).toBe(false);
      const home = withRegistry(
        [
          'schemaVersion: 1',
          'capabilities:',
          '  codegraph:',
          '    command: codegraph',
          '    args: [serve, --mcp]',
          `    tool: "${tool}"`,
        ].join('\n'),
      );
      expect(loadMcpCapabilityRegistry(home.provider)).toEqual({
        state: 'UNUSABLE',
        code: 'TOOL_NAME_REFUSED',
      });
    }
  });

  it('renders only granted servers, with no environment member', () => {
    const grant: McpCapabilityGrant = Object.freeze({
      capability: 'codegraph' as const,
      command: 'codegraph',
      args: Object.freeze(['serve', '--mcp']),
      tool: 'mcp__codegraph__codegraph_explore',
    prepare: null,
    });
    const document: unknown = JSON.parse(renderMcpConfig([grant]));
    expect(document).toEqual({
      mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } },
    });
    expect(renderMcpConfig([grant])).not.toContain('env');
  });

  it('treats an absent registry as "not granted" rather than as a default', () => {
    const home = makeHome();
    expect(loadMcpCapabilityRegistry(home.provider)).toEqual({ state: 'NOT_CONFIGURED' });
  });

  it('refuses a schemaVersion this build does not implement', () => {
    const home = withRegistry(GRANTED.replace('schemaVersion: 1', 'schemaVersion: 2'));
    expect(loadMcpCapabilityRegistry(home.provider)).toEqual({
      state: 'UNUSABLE',
      code: 'REGISTRY_UNSUPPORTED_SCHEMA_VERSION',
    });
  });
});

/* ═══════ 2. Which capabilities a repository actually requires ═══════════ */

describe('only REQUIRED reaches a grant', () => {
  it('asks for codegraph when the profile requires it', () => {
    expect(requiredMcpCapabilities(REQUIRES_CODEGRAPH)).toEqual(['codegraph']);
  });

  it('asks for nothing when the profile says OPTIONAL', () => {
    expect(requiredMcpCapabilities(OPTIONAL_CODEGRAPH)).toEqual([]);
  });

  it('starts no probe at all when nothing is required', async () => {
    let probes = 0;
    const outcome = await proveMcpCapabilities({
      required: [],
      parentEnv: {},
      probe: async () => {
        probes += 1;
        return CONNECTED;
      },
    });
    expect(outcome).toEqual({ state: 'NOT_REQUIRED' });
    expect(probes).toBe(0);
  });
});

/* ═══════ 3. The preflight fails closed ═════════════════════════════════ */

describe('a required capability that cannot be proven refuses', () => {
  it('refuses when the operator granted nothing', async () => {
    const home = makeHome();
    const outcome = await proveMcpCapabilities({
      required: ['codegraph'],
      parentEnv: {},
      provider: home.provider,
      probe: async () => CONNECTED,
    });
    expect(outcome).toMatchObject({ state: 'REFUSED', code: 'CAPABILITY_NOT_GRANTED' });
  });

  it('carries the registry’s own code when the registry is unusable', async () => {
    const home = withRegistry('schemaVersion: 1\ncapabilities: {}\nsurprise: true');
    const outcome = await proveMcpCapabilities({
      required: ['codegraph'],
      parentEnv: {},
      provider: home.provider,
      probe: async () => CONNECTED,
    });
    expect(outcome).toMatchObject({
      state: 'REFUSED',
      code: 'REGISTRY_UNUSABLE',
      registryCode: 'REGISTRY_CONTRACT_VIOLATION',
    });
  });

  it('refuses a granted server that did not connect — although the probe exited 0', async () => {
    const home = withRegistry(GRANTED);
    const failed = probeResult([{ name: 'codegraph', status: 'failed' }], []);
    expect(failed.exitCode).toBe(0);
    const outcome = await proveMcpCapabilities({
      required: ['codegraph'],
      parentEnv: {},
      provider: home.provider,
      probe: async () => failed,
    });
    expect(outcome).toMatchObject({ state: 'REFUSED', code: 'SERVER_NOT_CONNECTED' });
  });

  it('refuses a connected server whose granted tool is absent from the session', async () => {
    const home = withRegistry(GRANTED);
    const outcome = await proveMcpCapabilities({
      required: ['codegraph'],
      parentEnv: {},
      provider: home.provider,
      // Connected, and the session exposes a different tool. This is the shape a
      // renamed or mistyped tool produces, and it must not become a grant the
      // writer holds and cannot call.
      probe: async () => probeResult([{ name: 'codegraph', status: 'connected' }], ['mcp__codegraph__other']),
    });
    expect(outcome).toMatchObject({ state: 'REFUSED', code: 'GRANTED_TOOL_ABSENT' });
  });

  it('refuses when the probe emitted no session announcement at all', async () => {
    const home = withRegistry(GRANTED);
    const silent = { ...CONNECTED, stdout: 'not json\n' } as unknown as CommandResult;
    const outcome = await proveMcpCapabilities({
      required: ['codegraph'],
      parentEnv: {},
      provider: home.provider,
      probe: async () => silent,
    });
    expect(outcome).toMatchObject({ state: 'REFUSED', code: 'PROBE_EMITTED_NO_SESSION' });
  });

  it('refuses when the probe process did not complete', async () => {
    const home = withRegistry(GRANTED);
    const dead = { ...CONNECTED, started: false, outcome: 'SPAWN_FAILED' } as unknown as CommandResult;
    const outcome = await proveMcpCapabilities({
      required: ['codegraph'],
      parentEnv: {},
      provider: home.provider,
      probe: async () => dead,
    });
    expect(outcome).toMatchObject({ state: 'REFUSED', code: 'PROBE_DID_NOT_START' });
  });

  it('proves a granted capability the session really announced', async () => {
    const home = withRegistry(GRANTED);
    const outcome = await proveMcpCapabilities({
      required: ['codegraph'],
      parentEnv: {},
      provider: home.provider,
      probe: async () => CONNECTED,
    });
    expect(outcome.state).toBe('PROVEN');
    if (outcome.state !== 'PROVEN') return;
    expect(outcome.capabilities).toEqual(['codegraph']);
    expect(outcome.grant.allowedTools).toEqual(['mcp__codegraph__codegraph_explore']);
    expect(outcome.grant.mcpConfigPath).toContain('.agent-orchestrator');
  });

  it('probes with a vector that holds no built-in tool, so it can change nothing', async () => {
    const home = withRegistry(GRANTED);
    let seen: readonly string[] = [];
    await proveMcpCapabilities({
      required: ['codegraph'],
      parentEnv: {},
      provider: home.provider,
      probe: async (args) => {
        seen = args;
        return CONNECTED;
      },
    });
    const toolsAt = seen.indexOf('--tools');
    expect(toolsAt).toBeGreaterThanOrEqual(0);
    expect(seen.slice(toolsAt)).toEqual(['--tools', '']);
    expect(seen).toContain('--strict-mcp-config');
    expect(seen).not.toContain('Read');
    expect(seen).not.toContain('Write');
    expect(seen).not.toContain('Edit');
    expect(seen).not.toContain('Bash');
  });

  it('names every refusal in a closed set', () => {
    expect(new Set(MCP_CAPABILITY_REFUSALS).size).toBe(MCP_CAPABILITY_REFUSALS.length);
  });
});

/* ═══════ 4. The session announcement is read, not guessed ══════════════ */

describe('reading the session announcement', () => {
  it('is null when no announcement was emitted, which is not the same as an empty one', () => {
    expect(readSessionAnnouncement('')).toBeNull();
    expect(readSessionAnnouncement('{"type":"result","result":"x"}')).toBeNull();
    expect(readSessionAnnouncement('{"type":"system","subtype":"init"}')).toEqual({
      servers: [],
      tools: [],
    });
  });

  it('skips lines that are not JSON rather than throwing on them', () => {
    const stdout = ['not json', '', '{"type":"system","subtype":"init","mcp_servers":[],"tools":["a"]}'].join('\n');
    expect(readSessionAnnouncement(stdout)).toEqual({ servers: [], tools: ['a'] });
  });
});

/* ═══════ 5. The writer's argv ══════════════════════════════════════════ */

describe('the granted writer vector', () => {
  const grant: WriterMcpGrant = Object.freeze({
    mcpConfigPath: 'C:/Users/x/.agent-orchestrator/mcp/writer-mcp-config.json',
    allowedTools: Object.freeze(['mcp__codegraph__codegraph_explore']),
  });

  it('is the shipped vector, token for token, when nothing is granted', () => {
    expect(claudeWriterArgs(null)).toEqual([...CLAUDE_WRITER_ARGS]);
  });

  it('adds exactly one server and one tool, and changes nothing else', () => {
    const args = claudeWriterArgs(grant);
    expect(args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--mcp-config',
      grant.mcpConfigPath,
      '--allowedTools',
      'mcp__codegraph__codegraph_explore',
      '--tools',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
    ]);
  });

  it('keeps --strict-mcp-config, which is what excludes every other MCP server', () => {
    // Measured on this machine, four MCP servers are registered for the
    // operator. The granted arms of the probe announced `codegraph` alone.
    expect(claudeWriterArgs(grant)).toContain('--strict-mcp-config');
  });

  it('keeps the built-in tool list at exactly five, and last', () => {
    const args = claudeWriterArgs(grant);
    const toolsAt = args.indexOf('--tools');
    expect(args.slice(toolsAt)).toEqual(['--tools', 'Read', 'Edit', 'Write', 'Glob', 'Grep']);
  });

  it.each(['Bash', 'PowerShell', 'bypassPermissions', '--dangerously-skip-permissions', '--add-dir'])(
    'grants no authority through %s',
    (forbidden) => {
      expect(claudeWriterArgs(grant)).not.toContain(forbidden);
    },
  );

  it('is expressible as argv at all', () => {
    for (const token of claudeWriterArgs(grant)) expect(isShellInertArgument(token)).toBe(true);
  });

  it('refuses to spawn when a grant carries a token argv cannot hold', async () => {
    let spawns = 0;
    const outcome = await runClaudeWriter(
      {
        worktreePath: 'C:/tmp/worktree',
        phase: 'IMPLEMENT',
        round: 1,
        payload: 'do the work',
        // A path with a space. Real on a machine whose user name has one, and
        // the boundary must name it rather than provoke an exception.
        mcp: { mcpConfigPath: 'C:/Users/John Smith/mcp.json', allowedTools: ['mcp__a__b'] },
      },
      {
        agent: async () => {
          spawns += 1;
          throw new Error('must not spawn');
        },
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('AGENT_ARGUMENT_REFUSED');
    expect(spawns).toBe(0);
  });

  it('hands the assembled vector to the runner verbatim', async () => {
    const seen: string[][] = [];
    await runClaudeWriter(
      {
        worktreePath: 'C:/tmp/worktree',
        phase: 'IMPLEMENT',
        round: 1,
        payload: 'do the work',
        mcp: grant,
      },
      {
        agent: async (_agent, args) => {
          seen.push([...args]);
          return {
            outcome: 'COMPLETED',
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
            outputTruncated: false,
            outputBytesObserved: 0,
            failureCode: null,
            errnoCode: null,
            durationMs: 1,
            stdinDelivery: 'WRITTEN',
          } as never;
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([...claudeWriterArgs(grant)]);
  });
});

/* ═══════ 6. Fail closed: the writer never starts ═══════════════════════ */

describe('a repository that requires a capability gets no writer without it', () => {
  const created: string[] = [];

  afterAll(() => {
    while (created.length > 0) {
      const dir = created.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A real repository that *resolves* — `codegraph: REQUIRED` and a real
   * `.codegraph` directory at the root, so `probeCodegraphCapability` answers
   * `INDEX_PRESENT`.
   *
   * That is the whole point of the fixture: the repository passes the status
   * `repo/capabilities.ts` owns, and is still refused, because that status is
   * about a directory and this slice's is about a tool. The two are separate
   * answers to separate questions, exactly as that module said a later slice
   * would have to keep them.
   */
  async function requiringRepository(): Promise<ResolvedRepository> {
    const root = makeCanonicalTempDir('ao-m5-repo-');
    created.push(root);
    git(root, ['init', '-b', 'main', '--quiet']);
    writeRepoFile(root, '.gitattributes', '* -text\n');
    writeRepoFile(root, '.gitignore', '.agent-orchestrator/runtime/\n');
    writeRepoFile(root, 'README.md', '# m5\n');
    writeRepoFile(
      root,
      FIXTURE_PROFILE_RELATIVE_PATH,
      FIXTURE_A_PROFILE.replace('codegraph: OPTIONAL', 'codegraph: REQUIRED'),
    );
    writeRepoFile(
      root,
      'tasks/T1.md',
      ['---', 'id: T1', 'title: t', 'status: OPEN', 'kind: NORMAL', 'priority: NORMAL', 'currentFocus: false', 'dependsOn: []', '---', '', 'body', ''].join('\n'),
    );
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'fixture']);
    // Git-ignored in every real repository, so it is created after the commit.
    mkdirSync(join(root, '.codegraph'), { recursive: true });

    const resolution = await resolveRepository({ repositoryPath: root });
    if (!resolution.ok) throw new Error(`fixture did not resolve: ${resolution.code}`);
    return resolution.repository;
  }

  it('resolves — INDEX_PRESENT is satisfied — and still refuses, starting no agent', async () => {
    const repository = await requiringRepository();
    expect(repository.capabilities.codegraph.status).toBe('INDEX_PRESENT');
    expect(repository.capabilities.codegraph.satisfied).toBe(true);

    let agentStarts = 0;
    const result = await driveLifecycle(
      {
        repository,
        taskId: 'T1',
        continuationGrant: 'ATTENDED',
        recoverStaleLease: false,
        maxSteps: 4,
        maxInvocations: 1,
      },
      {
        now: () => new Date().toISOString(),
        git: runGitCommand,
        authPreflight: async () => provenAuthEvidence(),
        mcpPreflight: async () =>
          Object.freeze({
            state: 'REFUSED' as const,
            code: 'CAPABILITY_NOT_GRANTED' as const,
            registryCode: null,
            capability: 'codegraph' as const,
          }),
        agent: async () => {
          agentStarts += 1;
          throw new Error('no agent may start');
        },
      },
    );

    expect(result.outcome).toBe('REQUIRED_CAPABILITY_UNPROVEN');
    expect(result.reasonCodes).toContain('CAPABILITY_NOT_GRANTED');
    // The half that matters. A refusal that still started the writer would be
    // the defect wearing a different name.
    expect(agentStarts).toBe(0);
    // And the lease it took to look is given back, so the refusal costs the
    // repository nothing beyond the pass.
    expect(result.release?.code).toBe('RELEASED');

    // The other half, and the reason the gate sits BEFORE `startTask` rather
    // than only in the drive loop: `startTask` creates a worktree, creates a
    // branch and writes the first durable state. Stopping the writer while
    // leaving those behind would collect all three on every cycle of an
    // unattended invocation, for work that can never be driven.
    expect(git(repository.root, ['worktree', 'list', '--porcelain'])).not.toContain('ao/task/');
    expect(git(repository.root, ['branch', '--list', 'ao/task/T1']).trim()).toBe('');
    expect(existsSync(join(repository.root, '.agent-orchestrator', 'runtime', 'T1.json'))).toBe(
      false,
    );
  });

  it('drives normally when the same repository’s capability is proven', async () => {
    const repository = await requiringRepository();
    let preflights = 0;
    const result = await driveLifecycle(
      {
        repository,
        taskId: 'T1',
        continuationGrant: 'ATTENDED',
        recoverStaleLease: false,
        maxSteps: 1,
        maxInvocations: 1,
      },
      {
        now: () => new Date().toISOString(),
        git: runGitCommand,
        authPreflight: async () => provenAuthEvidence(),
        mcpPreflight: async () => {
          preflights += 1;
          return Object.freeze({
            state: 'PROVEN' as const,
            grant: Object.freeze({
              mcpConfigPath: 'C:/x/.agent-orchestrator/mcp/writer-mcp-config.json',
              allowedTools: Object.freeze(['mcp__codegraph__codegraph_explore']),
            }),
            capabilities: Object.freeze(['codegraph' as const]),
          });
        },
      },
    );

    // Two gates, and this counts them: once before `startTask`, so a refusal
    // creates no worktree, and once in the drive loop, which is the path an
    // `ALREADY_STARTED` task takes without passing the first. Production hands
    // in a memoised dependency, so those two calls are ONE probe process; this
    // stub is deliberately not memoised, which is what makes the count visible.
    expect(preflights).toBe(2);
    // The control that makes the case above mean something: the identical
    // fixture, differing only in the preflight's answer, is NOT refused for
    // this reason. Whatever it then comes to is the ordinary lifecycle's
    // business and is deliberately not asserted here.
    expect(result.outcome).not.toBe('REQUIRED_CAPABILITY_UNPROVEN');
  });
});

/* ═══════ 7. A refusal is an operator condition ═════════════════════════ */

describe('an unproven capability is raised to the operator', () => {
  it('needs a person, because the run left no durable task state to judge', () => {
    const attention = attentionForRunCondition('REQUIRED_CAPABILITY_UNPROVEN');
    expect(attention.attention).toBe(true);
    if (!attention.attention) return;
    expect(attention.reason).toBe('REPOSITORY_RUN_REFUSED');
  });
});

/* ═══════ 7. The memo is per requirement, and single-flight ═════════════ */

describe('the production factory', () => {
  it('runs one probe for two repositories requiring the same capability', async () => {
    const { mcpPreflightFactory } = await import('../src/agent/mcp-capability-preflight.js');
    let probes = 0;
    const proven: McpCapabilityOutcome = Object.freeze({ state: 'NOT_REQUIRED' as const });
    const factory = mcpPreflightFactory({}, async () => {
      probes += 1;
      return proven;
    });

    const first = factory(REQUIRES_CODEGRAPH);
    const second = factory(REQUIRES_CODEGRAPH);
    // Concurrently, in one turn: a memo that set a flag after awaiting would
    // start two probes here.
    await Promise.all([first(), second(), first()]);
    expect(probes).toBe(1);
  });

  it('does not share a memo between different requirements', async () => {
    const { mcpPreflightFactory } = await import('../src/agent/mcp-capability-preflight.js');
    let probes = 0;
    const factory = mcpPreflightFactory({}, async () => {
      probes += 1;
      return Object.freeze({ state: 'NOT_REQUIRED' as const });
    });
    await factory(REQUIRES_CODEGRAPH)();
    await factory(OPTIONAL_CODEGRAPH)();
    expect(probes).toBe(2);
  });
});
