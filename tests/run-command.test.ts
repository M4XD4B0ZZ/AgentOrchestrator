/**
 * `agent-loop run` — the CLI surface of the plan-only front door (V2-01).
 *
 * These cases drive the registered command through commander, capturing the
 * process streams, and assert the three CLI contracts on top of `planRun`:
 * stream discipline (report to stdout, safe errors to stderr), the exit-code
 * mapping, and the refusal to default the repository from the working
 * directory. The plan semantics themselves are covered in
 * `tests/run-plan.test.ts`; nothing here re-tests them beyond the seam.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import { registerRunCommand } from '../src/cli/run-command.js';
import { REPO_PROFILE_DIR_NAME } from '../src/repo/profile-location.js';
import { TASK_RUNTIME_DIR_NAME } from '../src/state/state-location.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
} from '../src/cli/run-exit-codes.js';
import { e2eProfile, taskFile } from './helpers/e2e-fixtures.js';
import { createRepoFixture, git, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';

let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  stdout = [];
  stderr = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

function programWithRun(): Command {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program);
  return program;
}

async function invoke(args: readonly string[]): Promise<void> {
  await programWithRun().parseAsync(['run', ...args], { from: 'user' });
}

describe('agent-loop run — CLI seam', () => {
  it('prints the plan to stdout and exits 0 for a fresh selected task', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V2-01.md': taskFile('V2-01') },
    });

    await invoke(['--repository', root]);

    const text = stdout.join('');
    expect(text).toContain('TASK_NOT_STARTED');
    expect(text).toContain('Read-only plan.');
    expect(stderr.join('')).toBe('');
    expect(process.exitCode).toBe(EXIT_RUN_OK);
  });

  it('renders a resolution failure as data and exits with the input code', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      // No profile: resolution fails with PROFILE_MISSING.
      profile: null,
      files: {},
    });

    await invoke(['--repository', root]);

    const text = stdout.join('');
    expect(text).toContain('PROFILE_MISSING');
    expect(text).toContain('Read-only plan.');
    expect(stderr.join('')).toBe('');
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
  });

  it('refuses a relative repository path rather than consulting the cwd', async () => {
    await invoke(['--repository', 'some/relative/path']);

    expect(stdout.join('')).toContain('REPOSITORY_PATH_INVALID');
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
  });

  it('requires --repository instead of defaulting it', async () => {
    await expect(invoke([])).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
  });

  it('is registered on the real program', () => {
    // Read as text rather than imported: `src/cli/index.ts` runs `main()` at
    // module load — it is the executable entry point, not a library — so
    // importing it here would parse vitest's own argv. The same style
    // `tests/internal-api.test.ts` uses for the same file.
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'cli', 'index.ts'),
      'utf8',
    );
    expect(source).toContain('registerRunCommand(program);');
    expect(source).toContain('registerDoctorCommand(program);');
  });

  it('offers execution only behind --attended, and no force or overwrite option', () => {
    const run = programWithRun().commands.find((command) => command.name() === 'run');
    expect(run).toBeDefined();
    const flags = (run?.options ?? []).map((option) => option.long);

    // The full option surface, pinned. V2-05 added two flags and V3-06 added
    // two more, and the list is asserted whole so that a seventh cannot appear
    // unnoticed. Neither new flag grants anything on its own: `--max-invocations`
    // is a bound, and `--recover-stale-lease` permits an attempt whose own proof
    // still has to pass. There is deliberately no flag that lets a run wait out
    // a quota reset — see `run/lifecycle-driver.ts` on why that needs an
    // authority this build does not have.
    expect(flags).toEqual([
      '--repository',
      '--task',
      '--attended',
      '--max-steps',
      '--max-invocations',
      '--recover-stale-lease',
    ]);
    expect(flags).not.toContain('--wait-for-reset');
    // The refusals `WORKSPACE_COLLISION` and `STATE_NOT_RECORDED` are meant to
    // stand, and adoption is a later slice (V2-06A). No flag may talk an
    // invocation past them.
    expect(flags).not.toContain('--force');
    expect(flags).not.toContain('--adopt');
    expect(flags).not.toContain('--overwrite');
    expect(flags).not.toContain('--unattended');
    // Operator presence and auth evidence are independent requirements, so there
    // must be no way to declare the preflight satisfied from the command line.
    expect(flags).not.toContain('--skip-preflight');
    expect(flags).not.toContain('--no-preflight');
    expect(flags).not.toContain('--auth-preflight-passed');
  });
});

/* ═══════════ V2-05: the read-only default is a contract, not a phase ════════ */

/**
 * `agent-loop run` shipped as read-only in V2-01, and operators, scripts and CI
 * jobs may be invoking it on that promise. V2-05 adds execution *beside* it.
 *
 * These cases exist because a slice that adds a writing mode is exactly when the
 * old promise breaks by accident — a default flipped, a branch fallen through —
 * and from the outside that is indistinguishable from a regression. So the
 * default is proven the only way it can be: drive the real registered command
 * against a real repository with a real startable task, then look at the
 * repository afterwards.
 */
describe('a bare `run` writes nothing, on a repository where a run could succeed', () => {
  /**
   * The runtime state directory, the work branches and the worktree list.
   *
   * The *runtime* directory, not the per-repository orchestrator directory: the
   * latter holds the profile and so exists before any command runs. Both names
   * come from the product's own constants, so this check cannot drift away from
   * where state is actually written.
   */
  function runtimeDir(root: string): string {
    return join(root, REPO_PROFILE_DIR_NAME, TASK_RUNTIME_DIR_NAME);
  }

  function traces(root: string): {
    runtimeState: boolean;
    branches: string;
    worktrees: string;
  } {
    return {
      runtimeState: existsSync(runtimeDir(root)),
      branches: git(root, ['branch', '--list', 'ao/task/*']).trim(),
      worktrees: git(root, ['worktree', 'list']).trim(),
    };
  }

  it('leaves no state file, no branch and no worktree', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V2-05.md': taskFile('V2-05') },
    });

    const before = traces(root);
    await invoke(['--repository', root]);
    const after = traces(root);

    // The task really was startable, so this is not vacuous: the plan says a
    // start is what would happen next.
    expect(stdout.join('')).toContain('TASK_NOT_STARTED');
    expect(after).toEqual(before);
    expect(after.runtimeState).toBe(false);
    expect(after.branches).toBe('');
    expect(process.exitCode).toBe(EXIT_RUN_OK);
  });

  it('says so in the report, and offers the grant that would change it', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V2-05.md': taskFile('V2-05') },
    });

    await invoke(['--repository', root]);

    const text = stdout.join('');
    expect(text).toContain('Read-only plan.');
    expect(text).toContain('--attended');
    // No claim that anything ran.
    expect(text).not.toContain('Attended run.');
  });

  it('starts nothing for a named task either', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V2-05.md': taskFile('V2-05') },
    });

    await invoke(['--repository', root, '--task', 'V2-05']);

    expect(existsSync(join(root, REPO_PROFILE_DIR_NAME, TASK_RUNTIME_DIR_NAME))).toBe(false);
    expect(git(root, ['branch', '--list', 'ao/task/*']).trim()).toBe('');
  });
});

describe('--attended is the grant, and it is not auth evidence', () => {
  it('refuses a --max-steps that is not a positive whole number, before executing', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V2-05.md': taskFile('V2-05') },
    });

    for (const bad of ['0', '-1', '2.5', 'many', '']) {
      process.exitCode = undefined;
      stdout = [];
      await invoke(['--repository', root, '--attended', '--max-steps', bad]);

      expect(stdout.join('')).toContain('MAX_STEPS_INVALID');
      expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      // Refused before anything could be created.
      expect(existsSync(join(root, REPO_PROFILE_DIR_NAME, TASK_RUNTIME_DIR_NAME))).toBe(false);
      expect(git(root, ['branch', '--list', 'ao/task/*']).trim()).toBe('');
    }
  });

  it('documents the grant as operator presence rather than as a credential claim', () => {
    const run = programWithRun().commands.find((command) => command.name() === 'run');
    const attended = (run?.options ?? []).find((option) => option.long === '--attended');

    expect(attended?.description).toContain('operator is present');
    // The flag must not read as if it also satisfied the preflight.
    expect(attended?.description).toContain('auth preflight');
  });
});
