/**
 * V2-06A — recognising a task's own crashed start, and refusing everything else.
 *
 * The window under test is the real one, and it is produced by production code
 * rather than simulated: `startTask` creates the workspace and then writes the
 * first durable state, and the state store's `replace` seam is the last step of
 * that write. A `replace` that throws leaves exactly the world a crash leaves —
 * a registered worktree, a task branch, and no `TaskState` at all — which is why
 * every recovery test here starts from a genuine `STATE_NOT_RECORDED`.
 *
 * The suite is written against the one way this feature goes wrong: **adoption
 * becoming a friendly word for `--force`.** So the adoptable case is a single
 * test, and everything else is a counter-proof — a workspace that must not be
 * adopted, pushed at every gate in turn.
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { ReplaceFn } from '../src/state/atomic-file.js';
import { loadTaskState } from '../src/state/state-store.js';
import { startTask } from '../src/run/start-task.js';
import { assessWorkspaceAdoption } from '../src/worktree/adopt-workspace.js';
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

/** The last step of the first durable write, made to fail as a crash would. */
const crashingReplace: ReplaceFn = () => {
  throw new Error('simulated crash before the first durable write landed');
};

interface Fixture {
  readonly repository: ResolvedRepository;
  readonly root: string;
}

async function repoWithTask(): Promise<Fixture> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      'src/index.ts': 'export const start = true;\n',
      [`tasks/${TASK_ID}.md`]: [
        '---',
        `id: ${TASK_ID}`,
        'title: recover me',
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
  return { repository, root };
}

function start(fixture: Fixture, options: { readonly crash?: boolean } = {}) {
  return startTask(
    { repository: fixture.repository, taskId: TASK_ID },
    {
      git: runGitCommand,
      now: tickingClock(),
      authPreflight: authPreflightPasses,
      ...(options.crash === true ? { replace: crashingReplace } : {}),
    },
  );
}

/**
 * A repository whose first start crashed after the workspace was created.
 *
 * Returns the orphan's path, having asserted that the world really is the one
 * the crash window describes — otherwise every test below would be starting
 * from a state it only assumed.
 */
async function afterCrashedStart(): Promise<Fixture & { readonly orphan: string }> {
  const fixture = await repoWithTask();

  const crashed = await start(fixture, { crash: true });
  expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
  // The worktree is real and nothing records that it belongs to this task.
  expect(crashed.residue).toBe(true);

  const orphan = crashed.workspace?.worktreePath;
  if (orphan === undefined) throw new Error('the crashed start produced no workspace');

  // The three facts that make this the crash window, asserted rather than hoped.
  expect(existsSync(orphan)).toBe(true);
  expect(git(fixture.root, ['worktree', 'list', '--porcelain'])).toContain(`ao/task/${TASK_ID}`);
  expect(loadTaskState(fixture.root, TASK_ID).classification).toBe('STATE_MISSING');

  return { ...fixture, orphan };
}

/** How many worktrees this repository registers, the source checkout aside. */
function registeredWorktrees(root: string): number {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;
}

/* ═════════════════════════ the window, and its closure ══════════════════ */

describe('a crashed start leaves an adoptable orphan', () => {
  it('adopts it, creates nothing, and writes the ordinary first state', async () => {
    const fixture = await afterCrashedStart();
    const before = registeredWorktrees(fixture.root);

    const second = await start(fixture);

    expect(second.outcome).toBe('ADOPTED');
    // Nothing new: the same worktree, the same branch, no second registration.
    expect(second.workspace?.worktreePath).toBe(fixture.orphan);
    expect(registeredWorktrees(fixture.root)).toBe(before);
    expect(readdirSync(join(fixture.orphan, '..'))).toEqual([TASK_ID]);

    // The durable state is the ordinary one. There is no adopted flag in the
    // contract, and nothing downstream can tell this apart from a fresh start.
    const state = loadTaskState(fixture.root, TASK_ID);
    expect(state.classification).toBe('STATE_VALID');
    if (!state.ok) return;
    expect(state.state.state).toBe('WORKTREE_READY');
    expect(state.state.worktreePath).toBe(fixture.orphan);
    expect(state.state.workBranch).toBe(`ao/task/${TASK_ID}`);
    expect(state.state.basePinnedCommit).toBe(git(fixture.root, ['rev-parse', 'main']).trim());
    expect(state.state.currentCommit).toBe(state.state.basePinnedCommit);
    expect(state.state.worktreeCleanAtCheckpoint).toBe(true);
    expect(state.state.reviewRound).toBe(0);
    expect(state.state.blockedAgent).toBeNull();
    expect(state.state.resumeFrom).toBeNull();
  });

  it('is then an ordinary started task, and a third invocation starts nothing', async () => {
    const fixture = await afterCrashedStart();
    await start(fixture);

    const third = await start(fixture);

    expect(third.outcome).toBe('ALREADY_STARTED');
  });
});

/* ═══════════════════════════ the counter-proofs ═════════════════════════ */

describe('a workspace that is not provably ours is never adopted', () => {
  /** Runs a second start over an orphan a test has just interfered with. */
  async function refusedWith(
    interfere: (fixture: Fixture & { readonly orphan: string }) => void,
  ): Promise<{ readonly outcome: string; readonly reasonCodes: readonly string[] }> {
    const fixture = await afterCrashedStart();
    interfere(fixture);
    const second = await start(fixture);
    // Whatever the reason, no state was written and nothing was reused.
    expect(loadTaskState(fixture.root, TASK_ID).classification).toBe('STATE_MISSING');
    return { outcome: second.outcome, reasonCodes: second.reasonCodes };
  }

  it('refuses an orphan that has a commit in it', async () => {
    const refused = await refusedWith(({ orphan }) => {
      writeRepoFile(orphan, 'src/work.ts', 'export const work = 1;\n');
      git(orphan, ['add', '--all']);
      git(orphan, ['commit', '--quiet', '-m', 'work nobody accounts for']);
    });

    // A commit is not an "advanced" orphan. Without durable state nothing
    // records whether an agent ran, so there is less to adopt, not more.
    expect(refused.outcome).toBe('WORKSPACE_COLLISION');
    expect(refused.reasonCodes).toContain('WORKSPACE_HEAD_MOVED');
  });

  it('refuses an orphan with a modified tracked file', async () => {
    const refused = await refusedWith(({ orphan }) => {
      writeRepoFile(orphan, 'src/index.ts', 'export const start = false;\n');
    });

    expect(refused.outcome).toBe('WORKSPACE_COLLISION');
    expect(refused.reasonCodes).toContain('WORKSPACE_DIRTY');
  });

  it('refuses an orphan with an untracked file, and says which it is', async () => {
    const refused = await refusedWith(({ orphan }) => {
      writeFileSync(join(orphan, 'stray.txt'), 'left behind\n', 'utf8');
    });

    // Kept apart from DIRTY: a stray file and an edited tracked file are
    // different facts about whose worktree this is.
    expect(refused.outcome).toBe('WORKSPACE_COLLISION');
    expect(refused.reasonCodes).toContain('WORKSPACE_UNTRACKED_CONTENT');
  });

  it('refuses an orphan whose base branch has moved on beneath it', async () => {
    const refused = await refusedWith(({ root }) => {
      // The orphan is pristine and at a perfectly good commit — just not the
      // one a fresh start would pin now. Adopting it would silently start the
      // task from a base nobody asked for.
      writeRepoFile(root, 'src/later.ts', 'export const later = true;\n');
      git(root, ['add', '--all']);
      git(root, ['commit', '--quiet', '-m', 'main moved on']);
    });

    expect(refused.outcome).toBe('WORKSPACE_COLLISION');
    expect(refused.reasonCodes).toContain('WORKSPACE_HEAD_MOVED');
  });

  it('refuses an orphan holding a different branch', async () => {
    const refused = await refusedWith(({ orphan }) => {
      git(orphan, ['checkout', '-q', '-b', 'somebody-elses-branch']);
    });

    expect(refused.outcome).toBe('WORKSPACE_COLLISION');
    expect(refused.reasonCodes).toContain('WORKSPACE_BRANCH_MISMATCH');
  });

  it('refuses a task branch with no registered worktree at all', async () => {
    const refused = await refusedWith(({ root, orphan }) => {
      // The branch survives, the worktree does not. A stale branch is not a
      // workspace, and nothing may be adopted from it.
      git(root, ['worktree', 'remove', orphan]);
    });

    expect(refused.outcome).toBe('WORKSPACE_COLLISION');
    expect(refused.reasonCodes).toContain('WORKSPACE_NOT_REGISTERED');
  });

  it('refuses before adoption is even reached when the source checkout is dirty', async () => {
    const refused = await refusedWith(({ root }) => {
      writeFileSync(join(root, 'untracked-in-source.txt'), 'dirty\n', 'utf8');
    });

    // Not a collision at all: preparation refuses at its preflight, before it
    // looks at what occupies the branch or the path, so adoption is never
    // asked about. The orphan survives untouched and no state is written —
    // which is the property this case is really about.
    expect(refused.outcome).toBe('WORKSPACE_REFUSED');
    expect(refused.reasonCodes).toContain('SOURCE_WORKTREE_DIRTY');
  });
});

/* ═════════════════ the assessor's own refusals, directly ════════════════ */

describe('assessWorkspaceAdoption', () => {
  it('refuses when a durable state already exists', async () => {
    const fixture = await afterCrashedStart();
    await start(fixture);

    const assessment = await assessWorkspaceAdoption(fixture.repository, TASK_ID, {
      git: runGitCommand,
    });

    expect(assessment.verdict).toBe('STATE_ALREADY_EXISTS');
  });

  it('never reads an unreadable state as an absent one', async () => {
    const fixture = await afterCrashedStart();
    // A record this build cannot interpret is not absence. Adopting past it
    // would overwrite something no operator has seen.
    writeRepoFile(
      fixture.root,
      `.agent-orchestrator/runtime/${TASK_ID}.json`,
      '{ this is not json',
    );

    const assessment = await assessWorkspaceAdoption(fixture.repository, TASK_ID, {
      git: runGitCommand,
    });

    expect(assessment.verdict).toBe('STATE_UNREADABLE');
    expect(assessment.verdict).not.toBe('ADOPTABLE_PRISTINE_ORPHAN');
  });

  it('does not adopt another repository’s workspace for the same task id', async () => {
    const mine = await afterCrashedStart();
    const theirs = await afterCrashedStart();

    // Two repositories, the same task id, two separate crash artefacts. Each
    // identity is derived from its own root, so neither can see the other's.
    const assessment = await assessWorkspaceAdoption(mine.repository, TASK_ID, {
      git: runGitCommand,
    });

    expect(assessment.verdict).toBe('ADOPTABLE_PRISTINE_ORPHAN');
    if (assessment.verdict !== 'ADOPTABLE_PRISTINE_ORPHAN') return;
    expect(assessment.workspace.worktreePath).toBe(mine.orphan);
    expect(assessment.workspace.worktreePath).not.toBe(theirs.orphan);
    expect(assessment.workspace.repositoryRoot).toBe(mine.root);
  });

  it('reports the receipt a fresh preparation would have produced', async () => {
    const fixture = await afterCrashedStart();

    const assessment = await assessWorkspaceAdoption(fixture.repository, TASK_ID, {
      git: runGitCommand,
    });

    expect(assessment.verdict).toBe('ADOPTABLE_PRISTINE_ORPHAN');
    if (assessment.verdict !== 'ADOPTABLE_PRISTINE_ORPHAN') return;
    expect(assessment.workspace).toEqual({
      repositoryId: fixture.repository.id,
      repositoryRoot: fixture.root,
      taskId: TASK_ID,
      baseBranch: 'main',
      basePinnedCommit: git(fixture.root, ['rev-parse', 'main']).trim(),
      workBranch: `ao/task/${TASK_ID}`,
      worktreePath: fixture.orphan,
      worktreeClean: true,
    });
  });

  it('refuses a source checkout that could not support a fresh start', async () => {
    const fixture = await afterCrashedStart();
    // Asked of the assessor directly, because `startTask` never gets this far:
    // preparation refuses a dirty source at its own preflight. The gate still
    // has to exist here — adoption completes a start, it does not bypass one,
    // and this module is callable on its own.
    writeFileSync(join(fixture.root, 'untracked-in-source.txt'), 'dirty\n', 'utf8');

    const assessment = await assessWorkspaceAdoption(fixture.repository, TASK_ID, {
      git: runGitCommand,
    });

    expect(assessment.verdict).toBe('SOURCE_UNSUITABLE');
  });

  it('writes nothing, whatever it concludes', async () => {
    const fixture = await afterCrashedStart();

    await assessWorkspaceAdoption(fixture.repository, TASK_ID, { git: runGitCommand });

    // Read-only: the durable write belongs to `startTask`, and an assessor that
    // persisted its own conclusion would be a second recovery lifeline.
    expect(loadTaskState(fixture.root, TASK_ID).classification).toBe('STATE_MISSING');
  });
});
