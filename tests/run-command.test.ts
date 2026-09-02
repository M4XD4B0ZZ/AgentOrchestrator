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

  it('offers execution only behind a named grant, and no force or overwrite option', () => {
    const run = programWithRun().commands.find((command) => command.name() === 'run');
    expect(run).toBeDefined();
    const flags = (run?.options ?? []).map((option) => option.long);

    // The full option surface, pinned whole rather than counted, so that any
    // option arriving without a deliberate change to this list fails here. (It
    // used to be counted, and the count went stale the first time the surface
    // grew.) None of them grants anything on its own:
    // `--max-invocations` and `--max-wait-ms` are bounds,
    // `--recover-stale-lease` permits an attempt whose own proof still has to
    // pass, `--automatic-resume-only` passes the run driver's gate only where
    // the canonical resume decision already answered `AUTOMATIC_ALLOWED`, and
    // `--remediate-verify-failure` is conjoined with `ATTENDED`, with the state,
    // with the resume phase and with a once-per-invocation bound before it moves
    // anything, and `--continue-human-decision` is conjoined with `ATTENDED`,
    // with its own state and with its own bound, and `--continue-usage-limit`
    // adds a third with one conjunct neither sibling has: it applies only where
    // the record names NO reset instant, so it can never start an agent before
    // a window the machine already knows the end of. The three are separate
    // flags for separate decisions: none can move another's block.
    //
    // This comment previously said there was "deliberately no flag that lets a
    // run wait out a quota reset". V3-08 added the authority that made one
    // buildable, so the sentence is replaced rather than left standing beside
    // its own contradiction.
    expect(flags).toEqual([
      '--repository',
      '--task',
      '--attended',
      '--max-steps',
      '--max-invocations',
      '--recover-stale-lease',
      '--remediate-verify-failure',
      '--continue-human-decision',
      '--continue-usage-limit',
      '--automatic-resume-only',
      '--wait-for-reset',
      '--max-wait-ms',
    ]);
    // The banned substrings, checked against the new flag too rather than only
    // against the list above: `tests/v2-07lr-lease-recovery.test.ts` scans every
    // registered option in `src/` for these, and a name is a promise to an
    // operator whatever its help text says.
    for (const banned of ['force', 'unattended', 'adopt', 'takeover', 'steal']) {
      expect(flags.some((flag) => (flag ?? '').includes(banned))).toBe(false);
    }
    // The refusals `WORKSPACE_COLLISION` and `STATE_NOT_RECORDED` are meant to
    // stand, and adoption is a later slice (V2-06A). No flag may talk an
    // invocation past them.
    expect(flags).not.toContain('--force');
    expect(flags).not.toContain('--adopt');
    expect(flags).not.toContain('--overwrite');
    // Still refused, and the distinction is the whole of V3-08: there is a flag
    // for "resume one automatically-allowed task with nobody present" and there
    // is deliberately none for "run unattended".
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

/* ═════════ V3-08: the unattended automatic-resume grant, at the CLI ════════ */

/**
 * The new grant is a *third* mode, and the risk it carries at this layer is not
 * that it does the wrong thing — the driver decides that — but that an operator
 * can reach it by accident, or combine it with something that quietly widens
 * it.
 *
 * So every case here is a refusal, and most of them are refusals that must
 * happen **before the repository is even resolved**. They are driven against a
 * path that does not exist, which is the strongest available form of "nothing
 * happened": a run that reached any effect would have had to resolve first, and
 * resolving that path fails with its own, different code.
 */
describe('the unattended automatic-resume mode refuses unusable combinations first', () => {
  /** A path no fixture created. Resolution of it fails, loudly and differently. */
  const ABSENT = join('D:', String.fromCharCode(92), 'no-such-repository-v3-08');

  const REFUSALS: readonly { readonly args: readonly string[]; readonly code: string }[] = [
    {
      args: ['--attended', '--automatic-resume-only'],
      code: 'CONTINUATION_GRANT_CONFLICT',
    },
    { args: ['--wait-for-reset', '--max-wait-ms', '1000'], code: 'WAIT_WITHOUT_AUTOMATIC_RESUME' },
    {
      args: ['--attended', '--wait-for-reset', '--max-wait-ms', '1000'],
      code: 'WAIT_WITHOUT_AUTOMATIC_RESUME',
    },
    { args: ['--automatic-resume-only', '--max-wait-ms', '1000'], code: 'MAX_WAIT_WITHOUT_WAIT' },
    { args: ['--automatic-resume-only', '--wait-for-reset'], code: 'MAX_WAIT_MS_REQUIRED' },
    {
      args: ['--automatic-resume-only', '--wait-for-reset', '--max-wait-ms', '1000', '--recover-stale-lease'],
      code: 'STALE_RECOVERY_WITH_WAIT',
    },
    {
      args: ['--automatic-resume-only', '--recover-stale-lease'],
      code: 'STALE_RECOVERY_WITHOUT_OPERATOR',
    },
    // The two operator decisions. Each needs `--attended`, and neither may be
    // reached by a run that states nobody is present -- checked here as well as
    // in the driver, because a refusal an operator meets at the CLI never
    // becomes a durable write at all.
    { args: ['--remediate-verify-failure'], code: 'VERIFY_REMEDIATION_WITHOUT_OPERATOR' },
    {
      args: ['--automatic-resume-only', '--remediate-verify-failure'],
      code: 'VERIFY_REMEDIATION_WITHOUT_OPERATOR',
    },
    { args: ['--continue-human-decision'], code: 'HUMAN_DECISION_CONTINUATION_WITHOUT_OPERATOR' },
    {
      args: ['--automatic-resume-only', '--continue-human-decision'],
      code: 'HUMAN_DECISION_CONTINUATION_WITHOUT_OPERATOR',
    },
    // The third, and the second row is the sharp one: `--automatic-resume-only`
    // is the grant that exists to wait out a reset, and this flag is for the
    // block that records none to wait for. An invocation stating nobody is
    // present may not say "try anyway".
    { args: ['--continue-usage-limit'], code: 'USAGE_LIMIT_CONTINUATION_WITHOUT_OPERATOR' },
    {
      args: ['--automatic-resume-only', '--continue-usage-limit'],
      code: 'USAGE_LIMIT_CONTINUATION_WITHOUT_OPERATOR',
    },
  ];

  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.args.join(' ')} with ${refusal.code}`, async () => {
      await invoke(['--repository', ABSENT, '--task', 'V3-08', ...refusal.args]);

      const text = stdout.join('');
      expect(text).toContain(refusal.code);
      // The repository was never resolved: its own failure code is absent.
      expect(text).not.toContain('could not be resolved');
      expect(stderr.join('')).toBe('');
      expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    });
  }

  /**
   * The other half of both operator decisions: each is about **one** task, and
   * the selector must not be allowed to choose which one gets continued.
   *
   * Driven without `--task` and against a path no fixture created, so the
   * absence of the resolver's own failure text measures the ordering directly
   * rather than assuming it.
   */
  for (const decision of [
    { flag: '--remediate-verify-failure', code: 'VERIFY_REMEDIATION_WITHOUT_TASK' },
    { flag: '--continue-human-decision', code: 'HUMAN_DECISION_CONTINUATION_WITHOUT_TASK' },
    { flag: '--continue-usage-limit', code: 'USAGE_LIMIT_CONTINUATION_WITHOUT_TASK' },
  ] as const) {
    it(`refuses ${decision.flag} without a named task`, async () => {
      await invoke(['--repository', ABSENT, '--attended', decision.flag]);

      const text = stdout.join('');
      expect(text).toContain(decision.code);
      expect(text).not.toContain('could not be resolved');
      expect(stderr.join('')).toBe('');
      expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    });
  }

  it('refuses an unusable --max-wait-ms with its own code', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V3-08.md': taskFile('V3-08') },
    });

    await invoke([
      '--repository', root,
      '--task', 'V3-08',
      '--automatic-resume-only',
      '--wait-for-reset',
      '--max-wait-ms', 'soon',
    ]);

    expect(stdout.join('')).toContain('MAX_WAIT_MS_INVALID');
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
  });

  it('requires a named task, because it may not select one to start', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V3-08.md': taskFile('V3-08') },
    });

    await invoke(['--repository', root, '--automatic-resume-only']);

    expect(stdout.join('')).toContain('TASK_REQUIRED_FOR_AUTOMATIC_RESUME');
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
  });

  it('creates no state, branch or worktree for a task that was never started', async () => {
    // The task is genuinely startable — the read-only plan above says
    // `TASK_NOT_STARTED` for exactly this fixture — so a mode that could start
    // one would start this one. Nothing may appear.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V3-08.md': taskFile('V3-08') },
    });
    const before = {
      runtimeState: existsSync(join(root, REPO_PROFILE_DIR_NAME, TASK_RUNTIME_DIR_NAME)),
      branches: git(root, ['branch', '--list', 'ao/task/*']).trim(),
      worktrees: git(root, ['worktree', 'list']).trim(),
    };

    await invoke(['--repository', root, '--task', 'V3-08', '--automatic-resume-only']);

    const after = {
      runtimeState: existsSync(join(root, REPO_PROFILE_DIR_NAME, TASK_RUNTIME_DIR_NAME)),
      branches: git(root, ['branch', '--list', 'ao/task/*']).trim(),
      worktrees: git(root, ['worktree', 'list']).trim(),
    };

    const text = stdout.join('');
    expect(text).toContain('TASK_NOT_STARTED');
    // The unattended contract sentence, and never the attended one.
    expect(text).toContain('Unattended automatic resume.');
    expect(text).not.toContain('Attended run.');
    expect(after).toEqual(before);
    expect(after.runtimeState).toBe(false);
    expect(after.branches).toBe('');
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
  });
});
