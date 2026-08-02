/**
 * AO-FOUNDATION-REM-003A — the environment every diagnostic process receives.
 *
 * Before this remediation the doctor derived **one** child environment and
 * handed it to all fourteen probes. `CLAUDE_CODE_OAUTH_TOKEN` was kept in it on
 * purpose, so `node`, `npm`, `git` and `codex` each received a Claude
 * credential, and `NODE_OPTIONS`/`NODE_PATH` came along with it — which means a
 * `--require` preload in the caller's environment executed inside a probe.
 *
 * This suite pins the replacement from three sides:
 *
 *  1. the pure policy matrix — exactly which keys each policy produces;
 *  2. the real orchestration — what `runCapabilityDump` and `runAuthPreflight`
 *     actually pass to `runCommand`, per call site;
 *  3. a real `node` child, to prove the preload does not run.
 *
 * Every credential here is an obvious dummy. No real token is used, no
 * credential store is read, and no real `claude`/`codex` auth command runs:
 * the orchestration tests replace the single external boundary (`runCommand`)
 * with a recorder, exactly as `report-safety.test.ts` does.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createProbeEnv,
  probeEnvAllowlist,
  PROBE_ENV_POLICIES,
  ProbeEnvironmentCollisionError,
  type ProbeEnvPolicy,
} from '../src/auth/env-guard.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { formatSafeError } from '../src/core/safe-error.js';
import type { CommandResult, RunOptions } from '../src/doctor/exec.js';
import { renderReportSummary } from '../src/doctor/render.js';
import { runDoctor } from '../src/doctor/run-doctor.js';
import type { DoctorReport } from '../src/doctor/report.js';

// ── The recorder in place of the one external boundary ─────────────────────

const recorder = vi.hoisted(() => {
  const calls: { key: string; env: NodeJS.ProcessEnv }[] = [];
  const outputs = new Map<string, { stdout?: string; stderr?: string }>([
    ['node --version', { stdout: 'v24.18.1\n' }],
    ['npm --version', { stdout: '11.12.1\n' }],
    ['git --version', { stdout: 'git version 2.55.0.windows.3\n' }],

    ['claude --version', { stdout: '2.1.220 (Claude Code)\n' }],
    ['claude --help', { stdout: 'Commands:\n  auth\n  config\n  doctor\n  mcp\n  update\n' }],
    ['claude auth --help', { stdout: 'Commands:\n  login\n  logout\n  status\n' }],
    ['claude auth login --help', { stdout: 'Usage: claude auth login [--claudeai] [--console]\n' }],
    ['claude auth status --help', { stdout: 'Usage: claude auth status [--json]\n' }],
    [
      'claude auth status --json',
      {
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'pro',
        }),
      },
    ],

    ['codex --version', { stdout: 'codex-cli 0.146.0\n' }],
    ['codex --help', { stdout: 'Commands:\n  login\n  exec\n  mcp\n  resume\n  update\n' }],
    ['codex login --help', { stdout: 'Usage: codex login [--with-api-key]\n' }],
    [
      'codex login status --help',
      { stdout: 'Usage: codex login status [-c/--config] [--enable] [--disable]\n' },
    ],
    ['codex login status', { stderr: 'Logged in using ChatGPT\n' }],
  ]);
  return { calls, outputs };
});

vi.mock('../src/doctor/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doctor/exec.js')>();
  return {
    ...actual,
    async runCommand(
      command: string,
      args: readonly string[],
      options: RunOptions,
    ): Promise<CommandResult> {
      const key = [command, ...args].join(' ');
      const fixture = recorder.outputs.get(key);
      if (fixture === undefined) {
        // Fail closed: an unknown probe or argv is a hard error, never a
        // fallback onto a real CLI.
        throw new Error(
          `probe-env-policy.test.ts: no hermetic command fixture registered for "${key}".`,
        );
      }
      recorder.calls.push({ key, env: options.env });
      return {
        display: key,
        executable: command,
        args,
        started: true,
        outcome: 'COMPLETED',
        exitCode: 0,
        signal: null,
        stdout: fixture.stdout ?? '',
        stderr: fixture.stderr ?? '',
        startedAt: '2026-08-01T00:00:00.000Z',
        finishedAt: '2026-08-01T00:00:00.010Z',
        durationMs: 10,
        failureCode: null,
        errnoCode: null,
        stdoutTruncated: false,
        stderrTruncated: false,
        processTreeKilled: false,
      };
    },
  };
});

// ── Dummy sentinels ────────────────────────────────────────────────────────

/** Obvious, non-functional stand-ins. None of these is a real credential. */
const DUMMY = {
  CLAUDE_CODE_OAUTH_TOKEN: 'AO_SENTINEL_CLAUDE_OAUTH_TOKEN',
  ANTHROPIC_API_KEY: 'AO_SENTINEL_ANTHROPIC_API_KEY',
  ANTHROPIC_AUTH_TOKEN: 'AO_SENTINEL_ANTHROPIC_AUTH_TOKEN',
  OPENAI_API_KEY: 'AO_SENTINEL_OPENAI_API_KEY',
  CODEX_API_KEY: 'AO_SENTINEL_CODEX_API_KEY',
} as const;

const DUMMY_VALUES = Object.values(DUMMY);

const OPERATIONAL = {
  PATH: 'C:\\ao-path',
  PATHEXT: '.COM;.EXE;.CMD',
  SystemRoot: 'C:\\ao-windows',
  windir: 'C:\\ao-windows',
  COMSPEC: 'C:\\ao-windows\\System32\\cmd.exe',
  HOME: 'C:\\ao-profile',
  USERPROFILE: 'C:\\ao-profile',
  APPDATA: 'C:\\ao-profile\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\ao-profile\\AppData\\Local',
  TEMP: 'C:\\ao-temp',
  TMP: 'C:\\ao-temp',
} as const;

const INJECTION = {
  NODE_OPTIONS: '--require=C:\\ao-evil\\preload.cjs',
  NODE_PATH: 'C:\\ao-evil\\modules',
  npm_config_node_options: '--require=C:\\ao-evil\\preload.cjs',
  NPM_CONFIG_NODE_OPTIONS: '--require=C:\\ao-evil\\preload.cjs',
} as const;

/** The full input every policy is measured against. */
function sourceEnv(): NodeJS.ProcessEnv {
  return { ...DUMMY, ...OPERATIONAL, ...INJECTION, AO_UNKNOWN_ENV: 'AO_SENTINEL_UNKNOWN' };
}

/** Case-insensitive membership, which is what Windows actually enforces. */
function keysUpper(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).map((k) => k.toUpperCase());
}

// ── 1. The pure policy matrix ──────────────────────────────────────────────

const EXPECTED_KEYS: Readonly<Record<ProbeEnvPolicy, readonly string[]>> = {
  'capability:generic': ['PATH', 'PATHEXT'],
  'capability:claude': ['PATH', 'PATHEXT'],
  'capability:codex': ['PATH', 'PATHEXT'],
  'auth:claude': ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE'],
  'auth:codex': ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE'],
};

/**
 * SystemRoot/windir/COMSPEC used to be part of the exec contract every
 * policy forwarded — the provenance defect closed by AO-FOUNDATION-REM-003B.
 * They must no longer appear in any policy's output at all.
 */
const REMOVED_SYSTEM_TOOL_VARS = ['SystemRoot', 'windir', 'COMSPEC'] as const;

/** Roots no policy has a demonstrated need for (AO-FOUNDATION-REM-003A-RR-02). */
const APP_DATA_ROOTS = ['APPDATA', 'LOCALAPPDATA'] as const;

describe('the policy matrix is exact', () => {
  it('covers every declared policy and nothing else', () => {
    expect(Object.keys(EXPECTED_KEYS).sort()).toEqual([...PROBE_ENV_POLICIES].sort());
  });

  it.each(PROBE_ENV_POLICIES)('produces exactly the expected keys for %s', (policy) => {
    const env = createProbeEnv(policy, sourceEnv());
    expect(Object.keys(env).sort()).toEqual([...EXPECTED_KEYS[policy]].sort());
    expect(Object.keys(env)).toEqual([...probeEnvAllowlist(policy)]);
  });

  it.each(PROBE_ENV_POLICIES)('carries no credential and no unknown variable for %s', (policy) => {
    const env = createProbeEnv(policy, sourceEnv());
    for (const name of Object.keys(DUMMY)) expect(env[name]).toBeUndefined();
    expect(env['AO_UNKNOWN_ENV']).toBeUndefined();
    const serialised = JSON.stringify(env);
    for (const value of DUMMY_VALUES) expect(serialised).not.toContain(value);
    expect(serialised).not.toContain('AO_SENTINEL_UNKNOWN');
  });

  it('withholds TEMP and TMP, for which no probe has a stated need', () => {
    for (const policy of PROBE_ENV_POLICIES) {
      const env = createProbeEnv(policy, sourceEnv());
      expect(env['TEMP']).toBeUndefined();
      expect(env['TMP']).toBeUndefined();
    }
  });

  it('gives profile roots to the auth probes only', () => {
    for (const policy of ['capability:generic', 'capability:claude', 'capability:codex'] as const) {
      const env = createProbeEnv(policy, sourceEnv());
      for (const name of ['HOME', 'USERPROFILE', ...APP_DATA_ROOTS]) {
        expect(env[name]).toBeUndefined();
      }
    }

    // Each auth probe reads a login under the profile root — `~/.claude` and
    // `~/.codex` — so that is what each gets, and nothing wider.
    for (const policy of ['auth:claude', 'auth:codex'] as const) {
      const env = createProbeEnv(policy, sourceEnv());
      expect(env['HOME']).toBe(OPERATIONAL.HOME);
      expect(env['USERPROFILE']).toBe(OPERATIONAL.USERPROFILE);
    }
  });

  /** AO-FOUNDATION-REM-003A-RR-02. */
  it('withholds the app-data roots from every policy, including auth:claude', () => {
    for (const policy of PROBE_ENV_POLICIES) {
      const env = createProbeEnv(policy, sourceEnv());
      const upper = keysUpper(env);
      for (const name of APP_DATA_ROOTS) {
        expect(env[name]).toBeUndefined();
        expect(upper).not.toContain(name);
        expect(probeEnvAllowlist(policy).map((n) => n.toUpperCase())).not.toContain(name);
      }
      const serialised = JSON.stringify(env);
      expect(serialised).not.toContain(OPERATIONAL.APPDATA);
      expect(serialised).not.toContain(OPERATIONAL.LOCALAPPDATA);
    }
  });

  /** AO-FOUNDATION-REM-003B, the executable-selection provenance defect. */
  it('withholds SystemRoot, windir and COMSPEC from every policy', () => {
    for (const policy of PROBE_ENV_POLICIES) {
      const env = createProbeEnv(policy, sourceEnv());
      const upper = keysUpper(env);
      for (const name of REMOVED_SYSTEM_TOOL_VARS) {
        expect(env[name]).toBeUndefined();
        expect(upper).not.toContain(name.toUpperCase());
        expect(probeEnvAllowlist(policy).map((n) => n.toUpperCase())).not.toContain(
          name.toUpperCase(),
        );
      }
      const serialised = JSON.stringify(env);
      expect(serialised).not.toContain(OPERATIONAL.SystemRoot);
      expect(serialised).not.toContain(OPERATIONAL.COMSPEC);
    }
  });

  it('keeps the two auth policies stated separately rather than shared', () => {
    // They currently coincide. That must be two identical statements, not one
    // list two policies point at: widening one must not widen the other.
    const claude = probeEnvAllowlist('auth:claude');
    const codex = probeEnvAllowlist('auth:codex');
    expect([...claude]).toEqual([...codex]);
    expect(claude).not.toBe(codex);
    expect(createProbeEnv('auth:claude', sourceEnv())).not.toBe(
      createProbeEnv('auth:codex', sourceEnv()),
    );
  });

  it('mutates neither the input map nor a previous result', () => {
    const source = sourceEnv();
    const snapshot = { ...source };
    const first = createProbeEnv('auth:claude', source);
    const firstSnapshot = { ...first };

    for (const policy of PROBE_ENV_POLICIES) createProbeEnv(policy, source);

    expect(source).toEqual(snapshot);
    expect(first).toEqual(firstSnapshot);
  });

  it('hands out an independent map to every caller', () => {
    const source = sourceEnv();
    const maps = PROBE_ENV_POLICIES.map((policy) => createProbeEnv(policy, source));
    maps.push(createProbeEnv('capability:generic', source));

    for (const map of maps) {
      expect(map).not.toBe(source);
      expect(Object.isFrozen(map)).toBe(true);
    }
    expect(new Set(maps).size).toBe(maps.length);
  });
});

// ── Windows spellings ──────────────────────────────────────────────────────

describe('a different spelling does not evade a policy', () => {
  const disguised: NodeJS.ProcessEnv = {
    PATH: OPERATIONAL.PATH,
    claude_code_oauth_token: DUMMY.CLAUDE_CODE_OAUTH_TOKEN,
    Claude_Code_OAuth_Token: DUMMY.CLAUDE_CODE_OAUTH_TOKEN,
    anthropic_api_key: DUMMY.ANTHROPIC_API_KEY,
    Node_Options: INJECTION.NODE_OPTIONS,
    node_path: INJECTION.NODE_PATH,
    NpM_CoNfIg_NoDe_OpTiOnS: INJECTION.NODE_OPTIONS,
  };

  it.each(PROBE_ENV_POLICIES)('drops every disguised name for %s', (policy) => {
    const env = createProbeEnv(policy, disguised);
    const upper = keysUpper(env);
    for (const name of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'NODE_OPTIONS',
      'NODE_PATH',
      'NPM_CONFIG_NODE_OPTIONS',
    ]) {
      expect(upper).not.toContain(name);
    }
    const serialised = JSON.stringify(env);
    for (const value of DUMMY_VALUES) expect(serialised).not.toContain(value);
    expect(serialised).not.toContain('--require');
  });

  it.runIf(process.platform === 'win32')(
    'still recognises an allow-listed variable written differently',
    () => {
      const env = createProbeEnv('capability:generic', {
        Path: OPERATIONAL.PATH,
        PathExt: OPERATIONAL.PATHEXT,
        SYSTEMROOT: OPERATIONAL.SystemRoot,
      });
      expect(env['PATH']).toBe(OPERATIONAL.PATH);
      expect(env['PATHEXT']).toBe(OPERATIONAL.PATHEXT);
      // SystemRoot is no longer part of any policy (AO-FOUNDATION-REM-003B).
      expect(env['SystemRoot']).toBeUndefined();
    },
  );

  /**
   * AO-FOUNDATION-REM-003A-RR-01. This used to resolve to the first spelling
   * inserted, which made the environment a probe was started with a property of
   * how the caller happened to build its map. It is now refused outright; the
   * full rule, including the POSIX half, is pinned in `env-guard.test.ts`.
   */
  it.runIf(process.platform === 'win32')(
    'refuses to choose when the source holds several spellings of one variable',
    () => {
      expect(() =>
        createProbeEnv('capability:generic', {
          PATH: OPERATIONAL.PATH,
          Path: 'C:\\other',
          path: 'C:\\other-still',
        }),
      ).toThrow(ProbeEnvironmentCollisionError);

      // The other insertion order reaches the same verdict, which is the point.
      expect(() =>
        createProbeEnv('capability:generic', { Path: 'C:\\other', PATH: OPERATIONAL.PATH }),
      ).toThrow(ProbeEnvironmentCollisionError);
    },
  );
});

// ── 2. What the real orchestration passes to runCommand ────────────────────

describe('every real call site uses its own policy', () => {
  let home: string;
  let report: DoctorReport;
  let summary: string;
  let reportJson: string;
  let capabilityArtefact: string;
  /** The exact object handed to `runDoctor`, kept to prove it was not touched. */
  let callerEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    recorder.calls.length = 0;
    home = mkdtempSync(join(tmpdir(), 'agent-loop-envpolicy-'));
    callerEnv = sourceEnv();
    report = await runDoctor({
      env: callerEnv,
      commandTimeoutMs: 25_000,
      pathProvider: fixedPathProvider(home),
    });
    summary = renderReportSummary(report);
    reportJson = readFileSync(join(report.runDirectory, 'doctor-report.json'), 'utf8');
    capabilityArtefact = readFileSync(join(report.runDirectory, 'cli-capabilities.txt'), 'utf8');
  }, 180_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const envOf = (key: string): NodeJS.ProcessEnv => {
    const call = recorder.calls.find((c) => c.key === key);
    if (call === undefined) throw new Error(`no recorded runCommand call for "${key}"`);
    return call.env;
  };

  it('starts exactly the fourteen known probes', () => {
    expect(recorder.calls.map((c) => c.key)).toEqual([
      'node --version',
      'npm --version',
      'git --version',
      'claude --version',
      'claude --help',
      'claude auth --help',
      'claude auth login --help',
      'claude auth status --help',
      'codex --version',
      'codex --help',
      'codex login --help',
      'codex login status --help',
      'claude auth status --json',
      'codex login status',
    ]);
  });

  /** AO-FOUNDATION-REM-003A, the defect itself. */
  it.each([
    'node --version',
    'npm --version',
    'git --version',
    'claude --version',
    'claude --help',
    'claude auth --help',
    'claude auth login --help',
    'claude auth status --help',
    'codex --version',
    'codex --help',
    'codex login --help',
    'codex login status --help',
    'claude auth status --json',
    'codex login status',
  ])('keeps CLAUDE_CODE_OAUTH_TOKEN out of `%s`', (key) => {
    const env = envOf(key);
    expect(keysUpper(env)).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(JSON.stringify(env)).not.toContain(DUMMY.CLAUDE_CODE_OAUTH_TOKEN);
  });

  it('gives no probe a credential or a loader variable of any kind', () => {
    for (const call of recorder.calls) {
      const upper = keysUpper(call.env);
      for (const name of [...Object.keys(DUMMY), ...Object.keys(INJECTION)]) {
        expect(upper).not.toContain(name.toUpperCase());
      }
      const serialised = JSON.stringify(call.env);
      for (const value of DUMMY_VALUES) expect(serialised).not.toContain(value);
      expect(serialised).not.toContain('--require');
      expect(serialised).not.toContain('AO_SENTINEL_UNKNOWN');
    }
  });

  it('matches each call site to the policy its probe declares', () => {
    const expectKeys = (key: string, policy: ProbeEnvPolicy): void => {
      expect(Object.keys(envOf(key)).sort()).toEqual([...EXPECTED_KEYS[policy]].sort());
    };

    expectKeys('node --version', 'capability:generic');
    expectKeys('npm --version', 'capability:generic');
    expectKeys('git --version', 'capability:generic');
    expectKeys('claude --version', 'capability:claude');
    expectKeys('claude auth status --help', 'capability:claude');
    expectKeys('codex --version', 'capability:codex');
    expectKeys('codex login status --help', 'capability:codex');
    expectKeys('claude auth status --json', 'auth:claude');
    expectKeys('codex login status', 'auth:codex');
  });

  it('separates the two auth probes rather than sharing one block', () => {
    const claude = envOf('claude auth status --json');
    const codex = envOf('codex login status');

    // Two environments built independently, not one map handed to both.
    expect(claude).not.toBe(codex);
    expect(Object.keys(claude).sort()).toEqual([...EXPECTED_KEYS['auth:claude']].sort());
    expect(Object.keys(codex).sort()).toEqual([...EXPECTED_KEYS['auth:codex']].sort());
  });

  /** AO-FOUNDATION-REM-003A-RR-02: no probe is started with an app-data root. */
  it('starts the Claude auth probe without APPDATA or LOCALAPPDATA', () => {
    const claude = envOf('claude auth status --json');
    for (const name of APP_DATA_ROOTS) {
      expect(claude[name]).toBeUndefined();
      expect(keysUpper(claude)).not.toContain(name);
    }
    expect(claude['USERPROFILE']).toBe(OPERATIONAL.USERPROFILE);
    expect(claude['HOME']).toBe(OPERATIONAL.HOME);

    for (const call of recorder.calls) {
      const upper = keysUpper(call.env);
      const serialised = JSON.stringify(call.env);
      for (const name of APP_DATA_ROOTS) expect(upper).not.toContain(name);
      expect(serialised).not.toContain(OPERATIONAL.APPDATA);
      expect(serialised).not.toContain(OPERATIONAL.LOCALAPPDATA);
    }
  });

  it('gives a version probe strictly less than the auth probe of the same provider', () => {
    const version = new Set(Object.keys(envOf('claude --version')));
    const auth = Object.keys(envOf('claude auth status --json'));
    expect(auth.length).toBeGreaterThan(version.size);
    for (const name of version) expect(auth).toContain(name);
  });

  it('never hands the same map to two probes', () => {
    const maps = recorder.calls.map((c) => c.env);
    expect(new Set(maps).size).toBe(maps.length);
  });

  it('leaves the caller-supplied environment untouched', () => {
    // A whole doctor run, and the map it was given still holds exactly what it
    // held before — no probe environment is a view onto it either.
    expect(callerEnv).toEqual(sourceEnv());
    for (const call of recorder.calls) expect(call.env).not.toBe(callerEnv);
  });

  // ── 3. Nothing leaks into an artefact, a report or an error ──────────────

  it('keeps every dummy credential out of the report, the artefact and the console', () => {
    for (const value of [...DUMMY_VALUES, 'AO_SENTINEL_UNKNOWN', '--require=C:\\ao-evil\\preload.cjs']) {
      expect(reportJson).not.toContain(value);
      expect(capabilityArtefact).not.toContain(value);
      expect(summary).not.toContain(value);
      expect(JSON.stringify(report)).not.toContain(value);
    }
  });

  it('names no environment value in the OAuth-token check', () => {
    const check = report.checks.find((c) => c.id === 'env:oauth-token-withheld');
    expect(check?.status).toBe('PASS');
    expect(check?.detail).toContain('SET');
    expect(check?.detail).not.toContain(DUMMY.CLAUDE_CODE_OAUTH_TOKEN);
  });

  it('puts no environment data into a safe error rendering', () => {
    let thrown: unknown;
    try {
      createProbeEnv('auth:openai' as ProbeEnvPolicy, sourceEnv());
    } catch (error) {
      thrown = error;
    }
    const rendered = [
      formatSafeError(thrown),
      thrown instanceof Error ? thrown.message : '',
      thrown instanceof Error ? (thrown.stack ?? '') : '',
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown ?? {})),
    ].join('\n');

    for (const value of DUMMY_VALUES) expect(rendered).not.toContain(value);
    expect(rendered).not.toContain('--require');
    expect(rendered).not.toContain(OPERATIONAL.USERPROFILE);
  });
});

// ── 4. A real node child does not execute the preload ──────────────────────

describe('a NODE_OPTIONS preload does not reach a real probe', () => {
  let work: string;
  let sentinel: string;
  let loader: string;
  let reportFile: string;
  let script: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'agent-loop-loader-'));
    sentinel = join(work, 'loader-sentinel.txt');
    loader = join(work, 'preload.cjs');
    reportFile = join(work, 'child-env.json');
    script = join(work, 'probe.mjs');

    // Harmless: if it ever runs, it writes one file inside this temp dir.
    writeFileSync(
      loader,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'preload-executed');\n`,
      'utf8',
    );
    // The stand-in for a version probe: reports its own environment instead.
    writeFileSync(
      script,
      'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify(process.env));\n` +
        'process.stdout.write("v24.18.1\\n");\n',
      'utf8',
    );
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('starts, yet leaves the loader unexecuted and the variables behind', async () => {
    // The real boundary, not the recorder: this actually spawns node.
    const { runCommand } = await vi.importActual<typeof import('../src/doctor/exec.js')>(
      '../src/doctor/exec.js',
    );

    const caller: NodeJS.ProcessEnv = {
      ...INJECTION,
      NODE_OPTIONS: `--require=${loader}`,
      npm_config_node_options: `--require=${loader}`,
      ...DUMMY,
      AO_UNKNOWN_ENV: 'AO_SENTINEL_UNKNOWN',
      // Only what the exec contract needs to find `node` on PATH at all
      // (AO-FOUNDATION-REM-003B reduced this to PATH/PATHEXT — the Windows
      // system tools node itself is spawned by, `cmd.exe`/`taskkill.exe`, are
      // resolved from a fixed internal boundary, never from this map).
      PATH: process.env['PATH'] ?? '',
      PATHEXT: process.env['PATHEXT'] ?? '',
    };

    const result = await runCommand('node', [script], {
      env: createProbeEnv('capability:generic', caller),
      timeoutMs: 30_000,
    });

    // The probe itself did what a node capability probe does.
    expect(result.outcome).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('v24.18.1');

    // The preload never ran.
    expect(existsSync(sentinel)).toBe(false);

    // And the environment the child actually saw carries none of it.
    const childEnv = JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, string>;
    const upper = Object.keys(childEnv).map((k) => k.toUpperCase());
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_NODE_OPTIONS']) {
      expect(upper).not.toContain(name);
    }
    for (const name of Object.keys(DUMMY)) expect(upper).not.toContain(name);
    expect(upper).not.toContain('AO_UNKNOWN_ENV');
    expect(JSON.stringify(childEnv)).not.toContain(DUMMY.CLAUDE_CODE_OAUTH_TOKEN);

    // Nothing beyond the policy and libuv's own back-fill reaches the child.
    //
    // On Windows libuv copies a fixed list of OS variables out of *this*
    // process into every child whatever block is passed to `spawn`, so the
    // child legitimately holds a few names the policy did not supply. Pinning
    // the union keeps that bounded: a variable that is neither policy-allowed
    // nor on libuv's list would be a real leak, and this fails on it.
    const LIBUV_REQUIRED = [
      'HOMEDRIVE',
      'HOMEPATH',
      'LOGONSERVER',
      'PATH',
      'SYSTEMDRIVE',
      'SYSTEMROOT',
      'TEMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
    ];
    const permitted = new Set([
      ...probeEnvAllowlist('capability:generic').map((n) => n.toUpperCase()),
      ...(process.platform === 'win32' ? LIBUV_REQUIRED : []),
    ]);
    expect(upper.filter((name) => !permitted.has(name))).toEqual([]);
  }, 60_000);
});
