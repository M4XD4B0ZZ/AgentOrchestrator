/**
 * AO-007-R1 / AO-007-R1-RR1: the productive persistent write root is fixed and
 * is not derived from any environment variable.
 *
 * Two generations of defect are covered here.
 *
 * First, `AGENT_LOOP_HOME` relocated the root that every persistent artefact is
 * written under — an environment variable that turned the diagnostics command
 * into a write-anywhere primitive, and that the tests themselves relied on,
 * which is how it survived review. It is gone.
 *
 * Second, the replacement called `os.homedir()` in this process and described
 * it as "the OS user identity". On Windows that function returns `%USERPROFILE%`
 * whenever the variable is set, so the root was still environment-controlled —
 * the read had simply moved one layer down. The child-process probes at the
 * bottom of this file are the regression tests for that: each runs a real,
 * isolated process with one home or loader variable manipulated, and every one
 * of them resolved a redirected root before the remediation.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { fixedPathProvider, OS_PATH_PROVIDER } from '../src/config/internal/path-provider.js';
import {
  HELPER_OUTPUT_PREFIX,
  trustedProfileDirectory,
} from '../src/config/internal/trusted-profile.js';
import {
  diagnosticsRoot,
  doctorDiagnosticsDir,
  doctorRunsRoot,
  homeOverrideWarningCode,
  orchestratorHome,
  ORCHESTRATOR_HOME_DIR_NAME,
  UNSUPPORTED_HOME_OVERRIDE_CODE,
} from '../src/config/paths.js';
import { isContained } from '../src/doctor/safe-write.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import { registerDoctorCommand } from '../src/cli/doctor-command.js';

const tempDirs: string[] = [];

/**
 * A source file with comment lines removed.
 *
 * These modules' doc comments deliberately name the environment variables and
 * calls they defend against, to explain why. Assertions about what the *code*
 * does must not trip over that prose, so they run against this view instead.
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-paths-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('the persistent write root comes from the OS user identity', () => {
  it('is <trusted profile>/.agent-orchestrator', () => {
    expect(orchestratorHome()).toBe(
      resolve(join(trustedProfileDirectory(), ORCHESTRATOR_HOME_DIR_NAME)),
    );
    expect(orchestratorHome(OS_PATH_PROVIDER)).toBe(orchestratorHome());
  });

  it('places diagnostics and run directories beneath it', () => {
    expect(diagnosticsRoot()).toBe(join(orchestratorHome(), 'diagnostics'));
    expect(doctorDiagnosticsDir()).toBe(join(diagnosticsRoot(), 'doctor'));
    expect(doctorRunsRoot()).toBe(join(doctorDiagnosticsDir(), 'runs'));
    expect(isContained(orchestratorHome(), doctorRunsRoot())).toBe(true);
  });

  it('never resolves under the current working directory', () => {
    expect(isContained(process.cwd(), doctorDiagnosticsDir())).toBe(false);
  });
});

describe('AGENT_LOOP_HOME has no productive effect', () => {
  it('does not move the root when the variable points at a temp directory', () => {
    const scratch = makeTempDir();
    const expected = resolve(join(trustedProfileDirectory(), ORCHESTRATOR_HOME_DIR_NAME));
    const previous = process.env['AGENT_LOOP_HOME'];
    process.env['AGENT_LOOP_HOME'] = scratch;
    try {
      expect(orchestratorHome()).toBe(expected);
      expect(orchestratorHome().startsWith(scratch)).toBe(false);
      expect(doctorRunsRoot().startsWith(scratch)).toBe(false);
      expect(isContained(scratch, doctorDiagnosticsDir())).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['AGENT_LOOP_HOME'];
      else process.env['AGENT_LOOP_HOME'] = previous;
    }
  });

  it('takes no environment argument at all any more', () => {
    // The path functions accept a PathProvider, not an environment object. A
    // provider carrying an AGENT_LOOP_HOME-shaped value is simply not a home
    // directory, so nothing can be smuggled through this parameter.
    expect(orchestratorHome.length).toBeLessThanOrEqual(1);
    expect(diagnosticsRoot.length).toBeLessThanOrEqual(1);
    expect(doctorDiagnosticsDir.length).toBeLessThanOrEqual(1);
  });

  it('reports the ignored override as a fixed code and never as a value', () => {
    const scratch = makeTempDir();
    const code = homeOverrideWarningCode({ AGENT_LOOP_HOME: scratch });
    expect(code).toBe(UNSUPPORTED_HOME_OVERRIDE_CODE);
    expect(code).not.toContain(scratch);
  });

  it('reports nothing when the variable is unset or empty', () => {
    expect(homeOverrideWarningCode({})).toBeNull();
    expect(homeOverrideWarningCode({ AGENT_LOOP_HOME: '' })).toBeNull();
  });
});

describe('the test seam is internal only', () => {
  it('redirects the root when a provider is injected', () => {
    const scratch = makeTempDir();
    const provider = fixedPathProvider(scratch);
    expect(orchestratorHome(provider)).toBe(
      resolve(join(scratch, ORCHESTRATOR_HOME_DIR_NAME)),
    );
    expect(doctorRunsRoot(provider)).toBe(
      join(scratch, ORCHESTRATOR_HOME_DIR_NAME, 'diagnostics', 'doctor', 'runs'),
    );
  });

  it('works without touching process.env', () => {
    const scratch = makeTempDir();
    const before = { ...process.env };
    orchestratorHome(fixedPathProvider(scratch));
    doctorRunsRoot(fixedPathProvider(scratch));
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
    expect(process.env['AGENT_LOOP_HOME']).toBeUndefined();
  });

  it('is not reachable through any public CLI option', () => {
    // Built here rather than through the CLI entry point, which would run the
    // program on import. The doctor command is what a user can actually reach.
    const program = new Command();
    registerDoctorCommand(program);
    const doctor = program.commands.find((c) => c.name() === 'doctor');

    expect(doctor).toBeDefined();
    expect(doctor?.options ?? []).toHaveLength(0);
    expect(doctor?.registeredArguments ?? []).toHaveLength(0);
  });

  it('is not registered as an option anywhere in the CLI layer', () => {
    for (const file of ['index.ts', 'doctor-command.ts']) {
      const source = readFileSync(join(PACKAGE_ROOT, 'src', 'cli', file), 'utf8');
      expect(source).not.toMatch(/\.option\s*\(/);
      expect(source).not.toMatch(/\.argument\s*\(/);
      expect(source).not.toContain('pathProvider');
      expect(source).not.toContain('AGENT_LOOP_HOME');
    }
  });

  it('is reachable from neither package exports nor the environment', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    for (const path of Object.keys(manifest.exports ?? {})) {
      expect(path).not.toContain('internal');
      expect(path).not.toContain('config');
    }

    const provider = readFileSync(
      join(PACKAGE_ROOT, 'src', 'config', 'internal', 'path-provider.ts'),
      'utf8',
    );
    const trusted = readFileSync(
      join(PACKAGE_ROOT, 'src', 'config', 'internal', 'trusted-profile.ts'),
      'utf8',
    );
    for (const source of [provider, trusted]) {
      expect(codeOnly(source)).not.toContain('process.env');
    }
  });
});

/**
 * AO-007-R1-RR1: the trusted profile resolver.
 *
 * `os.homedir()` is not called in this process. The profile path comes from a
 * child started with an **empty** environment map, where the OS has no variable
 * to consult and must answer from the process token / passwd database.
 */
describe('the trusted profile resolver', () => {
  it('returns an absolute, canonical, existing directory', () => {
    const profile = trustedProfileDirectory();
    expect(profile.length).toBeGreaterThan(0);
    expect(resolve(profile)).toBe(profile);
    expect(isContained(profile, join(profile, ORCHESTRATOR_HOME_DIR_NAME))).toBe(true);
  });

  it('is stable across calls', () => {
    expect(trustedProfileDirectory()).toBe(trustedProfileDirectory());
  });

  it('calls os.homedir nowhere in the productive path-resolution modules', () => {
    for (const relative of [
      join('src', 'config', 'paths.ts'),
      join('src', 'config', 'internal', 'path-provider.ts'),
    ]) {
      const source = readFileSync(join(PACKAGE_ROOT, relative), 'utf8');
      expect(codeOnly(source)).not.toContain('homedir');
    }

    // The resolver itself names it only inside the fixed child helper source,
    // which runs in a process with no environment at all.
    const trusted = readFileSync(
      join(PACKAGE_ROOT, 'src', 'config', 'internal', 'trusted-profile.ts'),
      'utf8',
    );
    expect(trusted).not.toMatch(/^\s*import\s*\{[^}]*homedir/m);
    expect(trusted).toContain('env: {}');
  });

  it('spawns the resolver with an empty environment and a fixed helper', () => {
    const trusted = readFileSync(
      join(PACKAGE_ROOT, 'src', 'config', 'internal', 'trusted-profile.ts'),
      'utf8',
    );
    expect(trusted).toContain('process.execPath');
    expect(trusted).toContain('shell: false');
    // No environment fallback of any kind on the failure paths. Comments are
    // allowed to name the variables this module defends against — the doc
    // header explains exactly why they cannot decide the answer — but no
    // code line may read one.
    const code = codeOnly(trusted);
    expect(code).not.toMatch(/USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA/);
    expect(code).not.toContain('process.env');
    expect(trusted).toContain(HELPER_OUTPUT_PREFIX);
  });
});

/**
 * The real proof: a fresh, isolated process resolves the productive
 * diagnostics root with one environment variable manipulated at a time. The
 * answer must be byte-identical in every case.
 *
 * Every one of these variables redirected the root before the remediation —
 * directly (`AGENT_LOOP_HOME`) or through `os.homedir()` (`USERPROFILE`, and
 * `HOME` on POSIX).
 */
describe('no environment variable can move the productive diagnostics root', () => {
  const TSX = join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const HELPER = join(PACKAGE_ROOT, 'tests', 'helpers', 'print-diagnostics-root.ts');
  const PREFIX = 'DIAGNOSTICS-ROOT ';

  interface Resolved {
    readonly home?: string;
    readonly runsRoot?: string;
    readonly error?: string;
  }

  /** Runs the helper in a real child process and parses its delimited line. */
  function resolveInChild(overrides: NodeJS.ProcessEnv): Resolved {
    const stdout = execFileSync(process.execPath, [TSX, HELPER], {
      env: { ...process.env, ...overrides },
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });

    const line = stdout.split(/\r?\n/).find((l) => l.startsWith(PREFIX));
    expect(line, `no ${PREFIX} line in child output`).toBeDefined();
    return JSON.parse((line ?? '').slice(PREFIX.length)) as Resolved;
  }

  /** The clean-child answer, resolved once and reused. */
  let cachedBaseline: Resolved | null = null;
  function baselineRoot(): Resolved {
    cachedBaseline ??= resolveInChild({});
    return cachedBaseline;
  }

  it('resolves a real root in a clean child process', () => {
    const baseline = baselineRoot();
    expect(baseline.error).toBeUndefined();
    expect(baseline.home).toBeDefined();
    expect(baseline.runsRoot?.startsWith(baseline.home ?? ' ')).toBe(true);
  });

  it.each([
    'USERPROFILE',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'AGENT_LOOP_HOME',
  ])('ignores a manipulated %s', (variable) => {
    const decoy = makeTempDir();
    const resolvedInChild = resolveInChild({ [variable]: decoy });

    expect(resolvedInChild.error).toBeUndefined();
    expect(resolvedInChild.home).toBe(baselineRoot().home);
    expect(resolvedInChild.runsRoot).toBe(baselineRoot().runsRoot);
    expect(resolvedInChild.home?.startsWith(decoy)).toBe(false);
  }, 120_000);

  it('ignores HOMEDRIVE and HOMEPATH manipulated together', () => {
    const resolvedInChild = resolveInChild({ HOMEDRIVE: 'Z:', HOMEPATH: '\\decoy' });
    expect(resolvedInChild.home).toBe(baselineRoot().home);
  }, 120_000);

  it('ignores every home variable manipulated at once', () => {
    const decoy = makeTempDir();
    const resolvedInChild = resolveInChild({
      USERPROFILE: decoy,
      HOME: decoy,
      HOMEDRIVE: 'Z:',
      HOMEPATH: '\\decoy',
      APPDATA: decoy,
      LOCALAPPDATA: decoy,
      AGENT_LOOP_HOME: decoy,
    });
    expect(resolvedInChild.error).toBeUndefined();
    expect(resolvedInChild.home).toBe(baselineRoot().home);
  }, 120_000);

  it('does not inherit NODE_OPTIONS into the resolver child', () => {
    // A `--require` preload that writes to stdout. If NODE_OPTIONS reached the
    // resolver child, its single-line output contract would be broken and the
    // resolution would fail closed instead of returning the same root.
    const dir = makeTempDir();
    const preload = join(dir, 'preload.cjs');
    writeFileSync(
      preload,
      'process.stdout.write("PRELOADED-IN-THIS-PROCESS\\n");\n',
      'utf8',
    );

    // NODE_OPTIONS has its own quoting rules that treat `\` as an escape
    // character, so a Windows path is passed with forward slashes — Node's
    // module resolution accepts either — rather than being corrupted by
    // NODE_OPTIONS' own parser before it ever reaches the child.
    const resolvedInChild = resolveInChild({
      NODE_OPTIONS: `--require=${preload.replace(/\\/g, '/')}`,
    });

    expect(resolvedInChild.error).toBeUndefined();
    expect(resolvedInChild.home).toBe(baselineRoot().home);
  }, 120_000);

  it('does not inherit NODE_PATH into the resolver child', () => {
    const dir = makeTempDir();
    const resolvedInChild = resolveInChild({ NODE_PATH: dir });
    expect(resolvedInChild.error).toBeUndefined();
    expect(resolvedInChild.home).toBe(baselineRoot().home);
  }, 120_000);
});
