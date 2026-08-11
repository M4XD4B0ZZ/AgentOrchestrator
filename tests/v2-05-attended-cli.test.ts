/**
 * V2-05: attended execution through the real CLI.
 *
 * `tests/run-command.test.ts` owns the *read-only* contract — that a bare
 * `agent-loop run` still writes nothing. This file owns the other half: that
 * `--attended` actually executes, that both requirements are independently
 * enforced, and that the exit code an operator sees is the one the tables in
 * `run-exit-codes.ts` promise.
 *
 * Everything here goes through `registerRunCommand` and commander, against a real
 * repository fixture with real `git worktree add` and real state files. The only
 * substitutions are the three execution seams the command exposes for exactly
 * this purpose: the auth preflight, the agent runner and the verifier. The real
 * ones start subscription CLIs and a real `npm run verify`.
 *
 * Note what is *not* substituted, because it is what makes these cases worth
 * anything: Git, the clock, the state store, the repository resolver, the
 * planner, `startTask` and `runTask` are all the production ones. And the
 * preflight seam cannot grant anything it should not — it returns evidence, and
 * evidence has one producer, so a stub still has to hand over the real artefact
 * (see `helpers/auth-evidence.ts`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import {
  ATTENDED_TRAILER,
  GRANT_WITHHELD_SENTENCE,
  START_OUTCOME_SENTENCES,
} from '../src/cli/render-attended-run.js';
import { registerRunCommand, type RunCommandSeams } from '../src/cli/run-command.js';
import {
  EXIT_RUN_CALL_AGAIN,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
} from '../src/cli/run-exit-codes.js';
import { REPO_PROFILE_DIR_NAME } from '../src/repo/profile-location.js';
import { READ_ONLY_TRAILER } from '../src/run/render-run-plan.js';
import { START_TASK_OUTCOMES } from '../src/run/start-task.js';
import { TASK_RUNTIME_DIR_NAME } from '../src/state/state-location.js';
import { loadTaskState } from '../src/state/state-store.js';
import { passingReview } from './fixtures.js';
import { authPreflightFails, authPreflightPasses } from './helpers/auth-evidence.js';
import {
  e2eProfile,
  recordedAgent,
  recordedVerify,
  reviewResult,
  taskFile,
  writerSuccess,
} from './helpers/e2e-fixtures.js';
import { createRepoFixture, git, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';

const TASK_ID = 'V2-05';

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

/** A repository with one startable task, and a runtime directory Git ignores. */
function attendableRepo(): string {
  return createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files: {
      'tasks/V2-05.md': taskFile(TASK_ID),
      '.gitignore': `${REPO_PROFILE_DIR_NAME}/${TASK_RUNTIME_DIR_NAME}/\n`,
    },
  });
}

async function invoke(args: readonly string[], seams: RunCommandSeams = {}): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program, seams);
  await program.parseAsync(['run', ...args], { from: 'user' });
}

/**
 * Seams that let a task be driven to completion.
 *
 * The two agents answer differently because they do different jobs: claude is
 * the writer and returns a writer result, codex is the read-only reviewer and
 * returns a review transcript. Handing one the other's answer is not a valid
 * scenario, and the loop is right to refuse it.
 */
function drivingSeams(overrides: Partial<RunCommandSeams> = {}): RunCommandSeams {
  return {
    authPreflight: authPreflightPasses,
    verify: recordedVerify().runner,
    agent: recordedAgent({
      claude: () => writerSuccess(),
      codex: () => reviewResult(passingReview()),
    }).runner,
    ...overrides,
  };
}

function stateFile(root: string): string {
  return join(root, REPO_PROFILE_DIR_NAME, TASK_RUNTIME_DIR_NAME, `${TASK_ID}.json`);
}

describe('--attended executes: it starts the task and drives it', () => {
  it('creates the workspace, writes durable state and reports both halves', async () => {
    const root = attendableRepo();

    await invoke(['--repository', root, '--attended', '--task', TASK_ID], drivingSeams());

    // The start half really happened, in the repository.
    expect(existsSync(stateFile(root))).toBe(true);
    expect(git(root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).not.toBe('');

    const loaded = loadTaskState(root, TASK_ID);
    expect(loaded.ok).toBe(true);

    // And the report names both halves rather than only the outcome.
    const text = stdout.join('');
    expect(text).toContain('Start        : STARTED');
    expect(text).toContain('Run          :');
    expect(text).toContain('Attended run.');
    // The contract sentence of the read-only mode must not appear on a run that
    // wrote things.
    expect(text).not.toContain('Read-only plan.');
    expect(stderr.join('')).toBe('');
  });

  it('drives an already-started task without starting it again', async () => {
    const root = attendableRepo();

    await invoke(['--repository', root, '--attended', '--task', TASK_ID], drivingSeams());
    const firstBytes = readFileSync(stateFile(root));
    stdout = [];
    process.exitCode = undefined;

    await invoke(['--repository', root, '--attended', '--task', TASK_ID], drivingSeams());

    const text = stdout.join('');
    expect(text).toContain('Start        : ALREADY_STARTED');
    // One worktree, one branch: the second invocation did not create a second.
    expect(
      git(root, ['worktree', 'list']).split('\n').filter((l) => l.includes(TASK_ID)),
    ).toHaveLength(1);
    // The state moved on (or stayed put), but nothing was re-created.
    expect(existsSync(stateFile(root))).toBe(true);
    expect(firstBytes.length).toBeGreaterThan(0);
  });

  it('bounds one invocation with --max-steps and says to call again', async () => {
    const root = attendableRepo();

    await invoke(
      ['--repository', root, '--attended', '--task', TASK_ID, '--max-steps', '1'],
      drivingSeams(),
    );

    const text = stdout.join('');
    expect(text).toContain('Steps        : 1');
    // `STEP_BUDGET_EXHAUSTED` is the one outcome that means "call again", and
    // its code is the operator-facing half of that statement.
    expect(text).toContain('STEP_BUDGET_EXHAUSTED');
    expect(process.exitCode).toBe(EXIT_RUN_CALL_AGAIN);
  });
});

describe('the two requirements are independent', () => {
  it('refuses to execute when the preflight produced no evidence', async () => {
    const root = attendableRepo();

    await invoke(
      ['--repository', root, '--attended', '--task', TASK_ID],
      drivingSeams({ authPreflight: authPreflightFails }),
    );

    const text = stdout.join('');
    expect(text).toContain('AUTH_PREFLIGHT_FAILED');
    expect(process.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);

    // The ordering that matters: the preflight is proven before the workspace
    // exists, so a machine that is not logged in gets no branch and no state.
    expect(existsSync(stateFile(root))).toBe(false);
    expect(git(root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
  });

  it('will not execute on a passing preflight alone, without the grant', async () => {
    const root = attendableRepo();

    // Every execution seam available and a preflight that passes — and no
    // `--attended`. Auth evidence is not a grant.
    await invoke(['--repository', root, '--task', TASK_ID], drivingSeams());

    expect(existsSync(stateFile(root))).toBe(false);
    expect(git(root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
    expect(stdout.join('')).toContain('Read-only plan.');
    expect(process.exitCode).toBe(EXIT_RUN_OK);
  });

  it('never asks the preflight at all without the grant', async () => {
    const root = attendableRepo();
    let asked = 0;

    await invoke(
      ['--repository', root, '--task', TASK_ID],
      drivingSeams({
        authPreflight: async () => {
          asked += 1;
          return authPreflightPasses();
        },
      }),
    );

    // A read-only invocation must not start subscription CLIs to answer a
    // question it has no use for.
    expect(asked).toBe(0);
  });

  it('runs the real preflight at most once per attended invocation', async () => {
    const root = attendableRepo();
    let asked = 0;

    await invoke(
      ['--repository', root, '--attended', '--task', TASK_ID],
      drivingSeams({
        authPreflight: async () => {
          asked += 1;
          return authPreflightPasses();
        },
      }),
    );

    // `startTask` asks, and the drive reuses what it produced — rather than
    // paying for a second capability dump and two more CLI starts.
    expect(asked).toBe(1);
  });
});

describe('the attended report has a sentence for every outcome', () => {
  it('covers every start outcome, with no spare entries', () => {
    const declared = [...START_TASK_OUTCOMES].sort();
    expect(Object.keys(START_OUTCOME_SENTENCES).sort()).toEqual(declared);
  });

  it('says something specific for each, not a shared placeholder', () => {
    const sentences = START_TASK_OUTCOMES.map((outcome) => START_OUTCOME_SENTENCES[outcome]);
    // Distinct: a table where two outcomes share a sentence is a table that has
    // stopped distinguishing them, which is the thing the vocabulary exists for.
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });

  it('keeps the two trailers mutually exclusive claims', () => {
    // One says nothing was written, the other says something was. They must not
    // be confusable, and neither may hedge into the other.
    expect(READ_ONLY_TRAILER).toContain('no task state was written');
    expect(ATTENDED_TRAILER).toContain('permitted to start agents');
    expect(ATTENDED_TRAILER).not.toContain('Read-only');
    expect(READ_ONLY_TRAILER).not.toContain('--attended');
  });

  it('prints only ASCII, so no console or encoding can garble a refusal', () => {
    // This repository has twice had text damaged by a re-encoding pass. An
    // operator-facing refusal is the worst place for that, so the report
    // vocabulary is held to ASCII.
    const all = [
      ...Object.values(START_OUTCOME_SENTENCES),
      ATTENDED_TRAILER,
      GRANT_WITHHELD_SENTENCE,
    ].join('');
    const nonAscii = [...all].filter((c) => c.codePointAt(0)! > 0x7f);
    expect(nonAscii).toEqual([]);
  });
});

describe('a start refusal ends the invocation with its own code', () => {
  it('reports RUNTIME_NOT_IGNORED and writes nothing when state would dirty the checkout', async () => {
    // The same repository, without the `.gitignore` entry. This is the refusal
    // that exists so the *second* task does not stall on the first task's
    // untracked state file.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V2-05.md': taskFile(TASK_ID) },
    });

    await invoke(['--repository', root, '--attended', '--task', TASK_ID], drivingSeams());

    const text = stdout.join('');
    expect(text).toContain('Start        : RUNTIME_NOT_IGNORED');
    expect(text).toContain('.gitignore');
    // Refused before the workspace, so no branch was created either.
    expect(git(root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
    expect(existsSync(stateFile(root))).toBe(false);
  });

  it('reports a named task that does not exist without touching the repository', async () => {
    const root = attendableRepo();

    await invoke(['--repository', root, '--attended', '--task', 'ZZ-99'], drivingSeams());

    expect(stdout.join('')).toContain('Start        : TASK_UNKNOWN');
    expect(git(root, ['branch', '--list', 'ao/task/*']).trim()).toBe('');
  });
});
