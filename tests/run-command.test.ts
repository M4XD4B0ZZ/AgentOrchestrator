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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import { registerRunCommand } from '../src/cli/run-command.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
} from '../src/cli/run-exit-codes.js';
import { e2eProfile, taskFile } from './helpers/e2e-fixtures.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
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

  it('offers no execution, force or overwrite option', () => {
    const run = programWithRun().commands.find((command) => command.name() === 'run');
    expect(run).toBeDefined();
    const flags = (run?.options ?? []).map((option) => option.long);
    expect(flags).toEqual(['--repository', '--task']);
  });
});
