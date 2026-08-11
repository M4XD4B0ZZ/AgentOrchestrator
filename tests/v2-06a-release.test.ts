/**
 * V2-06A — `release`: the destructive half, and what it refuses.
 *
 * The risk this suite is written against is that "release" becomes a friendly
 * name for `rm -rf`. So the releasable case is one test, and the rest establish
 * that the command deletes **exactly** what adoption would have accepted and
 * nothing else — including the cases where deleting would be most tempting and
 * most costly: a worktree with work in it.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { RELEASE_OUTCOME_SENTENCES } from '../src/cli/release-command.js';
import { exitCodeForReleaseOutcome } from '../src/cli/run-exit-codes.js';
import type { ReplaceFn } from '../src/state/atomic-file.js';
import { loadTaskState } from '../src/state/state-store.js';
import { RELEASE_OUTCOMES, releaseTaskWorkspace } from '../src/run/release-workspace.js';
import { startTask } from '../src/run/start-task.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { createRepoFixture, git, removeRepoFixtures, writeRepoFile } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } from './helpers/worktree-fixtures.js';
import { e2eProfile, tickingClock } from './helpers/e2e-fixtures.js';

afterEach(() => {
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const TASK_ID = 'V2-06A';

const crashingReplace: ReplaceFn = () => {
  throw new Error('simulated crash before the first durable write landed');
};

interface Orphan {
  readonly repository: ResolvedRepository;
  readonly root: string;
  readonly orphan: string;
}

/** A repository whose first start crashed after creating the workspace. */
async function afterCrashedStart(): Promise<Orphan> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      'src/index.ts': 'export const start = true;\n',
      [`tasks/${TASK_ID}.md`]: [
        '---',
        `id: ${TASK_ID}`,
        'title: release me',
        'status: OPEN',
        'kind: NORMAL',
        'priority: NORMAL',
        'currentFocus: true',
        'dependsOn: []',
        '---',
        'Body prose, which nothing interprets.',
      ].join('\n'),
    },
  });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);

  const crashed = await startTask(
    { repository, taskId: TASK_ID },
    {
      git: runGitCommand,
      now: tickingClock(),
      authPreflight: authPreflightPasses,
      replace: crashingReplace,
    },
  );
  expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
  const orphan = crashed.workspace?.worktreePath;
  if (orphan === undefined) throw new Error('the crashed start produced no workspace');

  return { repository, root, orphan };
}

function release(fixture: Orphan) {
  return releaseTaskWorkspace(fixture.repository, TASK_ID, { git: runGitCommand });
}

describe('releasing a pristine orphan', () => {
  it('removes the worktree and the branch, and says what it proved', async () => {
    const fixture = await afterCrashedStart();
    expect(existsSync(fixture.orphan)).toBe(true);

    const released = await release(fixture);

    expect(released.outcome).toBe('RELEASED');
    expect(released.worktreeRemoved).toBe(true);
    expect(released.branchRemoved).toBe(true);
    // The positive evidence the deletion was allowed, reported rather than
    // implied: an operator reading a log sees what was proven.
    expect(released.verdict).toBe('ADOPTABLE_PRISTINE_ORPHAN');

    expect(existsSync(fixture.orphan)).toBe(false);
    expect(git(fixture.root, ['worktree', 'list', '--porcelain'])).not.toContain(
      `ao/task/${TASK_ID}`,
    );
    expect(git(fixture.root, ['branch', '--list', `ao/task/${TASK_ID}`]).trim()).toBe('');
  });

  it('leaves the repository able to start the task cleanly afterwards', async () => {
    const fixture = await afterCrashedStart();
    await release(fixture);

    const restarted = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses },
    );

    // Not adopted — there is nothing left to adopt. An ordinary fresh start.
    expect(restarted.outcome).toBe('STARTED');
    expect(loadTaskState(fixture.root, TASK_ID).classification).toBe('STATE_VALID');
  });
});

describe('release refuses whatever adoption refuses', () => {
  async function refused(interfere: (fixture: Orphan) => void) {
    const fixture = await afterCrashedStart();
    interfere(fixture);
    const result = await release(fixture);
    // Whatever the reason: the workspace is still standing.
    expect(existsSync(fixture.orphan)).toBe(true);
    return result;
  }

  it('refuses a worktree holding a commit, rather than discarding the work', async () => {
    const result = await refused(({ orphan }) => {
      writeRepoFile(orphan, 'src/work.ts', 'export const work = 1;\n');
      git(orphan, ['add', '--all']);
      git(orphan, ['commit', '--quiet', '-m', 'work somebody may want']);
    });

    expect(result.outcome).toBe('NOT_RELEASABLE');
    expect(result.verdict).toBe('WORKSPACE_HEAD_MOVED');
    expect(result.worktreeRemoved).toBe(false);
  });

  it('refuses a dirty worktree', async () => {
    const result = await refused(({ orphan }) => {
      writeRepoFile(orphan, 'src/index.ts', 'export const start = false;\n');
    });

    expect(result.outcome).toBe('NOT_RELEASABLE');
    expect(result.verdict).toBe('WORKSPACE_DIRTY');
  });

  it('refuses a worktree with an untracked file in it', async () => {
    const result = await refused(({ orphan }) => {
      writeFileSync(join(orphan, 'stray.txt'), 'left behind\n', 'utf8');
    });

    expect(result.outcome).toBe('NOT_RELEASABLE');
    expect(result.verdict).toBe('WORKSPACE_UNTRACKED_CONTENT');
  });

  it('refuses a workspace whose task has durable state', async () => {
    const fixture = await afterCrashedStart();
    // The task is adopted and now genuinely running. Its workspace is not a
    // crash artefact any more, and releasing it would delete a live task's tree.
    const adopted = await startTask(
      { repository: fixture.repository, taskId: TASK_ID },
      { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses },
    );
    expect(adopted.outcome).toBe('ADOPTED');

    const result = await release(fixture);

    expect(result.outcome).toBe('NOT_RELEASABLE');
    expect(result.verdict).toBe('STATE_ALREADY_EXISTS');
    expect(existsSync(fixture.orphan)).toBe(true);
  });

  it('refuses a task this repository does not declare', async () => {
    const fixture = await afterCrashedStart();

    const result = await releaseTaskWorkspace(fixture.repository, 'V9-99', {
      git: runGitCommand,
    });

    expect(result.outcome).toBe('TASK_UNKNOWN');
    expect(existsSync(fixture.orphan)).toBe(true);
  });

  it('refuses an id that is not a task id at all', async () => {
    const fixture = await afterCrashedStart();

    const result = await releaseTaskWorkspace(fixture.repository, 'not a task id', {
      git: runGitCommand,
    });

    expect(result.outcome).toBe('TASK_ID_INVALID');
    expect(existsSync(fixture.orphan)).toBe(true);
  });
});

describe('the release report', () => {
  it('has a sentence and an exit code for every outcome', () => {
    const declared = [...RELEASE_OUTCOMES].sort();
    expect(Object.keys(RELEASE_OUTCOME_SENTENCES).sort()).toEqual(declared);
    for (const outcome of RELEASE_OUTCOMES) {
      expect([0, 2, 3]).toContain(exitCodeForReleaseOutcome(outcome));
    }
  });

  it('exits 0 only when something was actually released', () => {
    for (const outcome of RELEASE_OUTCOMES) {
      const releasing = outcome === 'RELEASED' || outcome === 'RELEASED_BRANCH_KEPT';
      expect(exitCodeForReleaseOutcome(outcome) === 0).toBe(releasing);
    }
  });

  it('prints only ASCII, so no console or encoding can garble a refusal', () => {
    const all = Object.values(RELEASE_OUTCOME_SENTENCES).join('');
    expect([...all].filter((character) => character.codePointAt(0)! > 0x7f)).toEqual([]);
  });
});
