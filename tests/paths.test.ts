/**
 * AO-007-R1: the productive persistent write root is fixed.
 *
 * Before the remediation, `AGENT_LOOP_HOME` relocated the root that every
 * persistent artefact is written under — an environment variable that turned
 * the diagnostics command into a write-anywhere primitive, and that the tests
 * themselves relied on, which is how it survived review. It is gone.
 *
 * These probes fail on the old implementation: it resolved the override into a
 * real path, so `orchestratorHome({ AGENT_LOOP_HOME: tmp })` pointed at `tmp`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { fixedPathProvider, OS_PATH_PROVIDER } from '../src/config/internal/path-provider.js';
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
  it('is <user profile>/.agent-orchestrator by default', () => {
    expect(orchestratorHome()).toBe(resolve(join(homedir(), ORCHESTRATOR_HOME_DIR_NAME)));
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
    const previous = process.env['AGENT_LOOP_HOME'];
    process.env['AGENT_LOOP_HOME'] = scratch;
    try {
      expect(orchestratorHome()).toBe(resolve(join(homedir(), ORCHESTRATOR_HOME_DIR_NAME)));
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
});
