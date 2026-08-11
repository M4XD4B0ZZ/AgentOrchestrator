/**
 * `startTask` — the first durable `TaskState` (V2-03).
 *
 * Real repositories, real `git worktree add`, real state files. The seams that
 * stay injected are the auth preflight (the real one starts subscription CLIs)
 * and, in two cases, Git itself — to produce answers a real repository cannot
 * be asked for on demand.
 *
 * Three invariants are the point of this suite, and each has its own section:
 *
 *  1. no durable state exists before the workspace does;
 *  2. the first state carries derived identity, never supplied identity;
 *  3. a repository that would be dirtied by its own runtime file is refused
 *     *before* the first write, not discovered by the second task.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  startTask,
  START_TASK_OUTCOMES,
  type StartTaskOutcome,
  type StartTaskResult,
} from '../src/run/start-task.js';
import { checkRuntimeIgnored } from '../src/state/runtime-ignored.js';
import { loadTaskState } from '../src/state/state-store.js';
import {
  authPreflightFails,
  authPreflightPasses,
  provenAuthEvidence,
} from './helpers/auth-evidence.js';
import { deriveTaskWorkspaceIdentity } from '../src/worktree/workspace-identity.js';
import { runGitCommand, type GitRunner } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { createRepoFixture, removeRepoFixtures, git } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } from './helpers/worktree-fixtures.js';
import { e2eProfile, taskFile, tickingClock } from './helpers/e2e-fixtures.js';

afterEach(() => {
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

/**
 * An auth preflight that passed, without starting anything.
 *
 * Since V2-05 this returns the preflight's own artefact rather than `true`. It
 * is minted by the real mint from real check results — see
 * `helpers/auth-evidence.ts` — so this stub proves what a passing preflight
 * proves and nothing more. `async () => true` no longer compiles here, which was
 * the point of the change.
 */
const authPassed = authPreflightPasses;

/** Every outcome this suite actually produced. Read by the coverage check. */
const produced = new Set<StartTaskOutcome>();

async function started(
  request: Parameters<typeof startTask>[0],
  dependencies: Parameters<typeof startTask>[1],
): Promise<StartTaskResult> {
  const result = await startTask(request, dependencies);
  produced.add(result.outcome);
  return result;
}

function deps(overrides: Partial<Parameters<typeof startTask>[1]> = {}) {
  return {
    git: runGitCommand,
    now: tickingClock(),
    authPreflight: authPassed,
    ...overrides,
  };
}

/**
 * A repository whose runtime directory is ignored — the supported shape.
 *
 * The `.gitignore` is committed, so the source checkout is clean and stays
 * clean once a state file appears beneath it.
 */
async function startableRepo(
  files: Readonly<Record<string, string>> = {},
): Promise<{ repository: ResolvedRepository; root: string }> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: e2eProfile(),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      'tasks/V2-03.md': taskFile('V2-03'),
      ...files,
    },
  });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return { repository, root };
}

describe('startTask — the supported start', () => {
  it('creates the workspace and writes exactly one durable state, at WORKTREE_READY', async () => {
    const { repository, root } = await startableRepo();

    const result = await started({ repository, taskId: 'V2-03' }, deps());

    expect(result.outcome).toBe('STARTED');
    expect(result.workspace).not.toBeNull();

    const loaded = loadTaskState(root, 'V2-03');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('WORKTREE_READY');
    expect(loaded.state.taskId).toBe('V2-03');
    expect(loaded.state.reviewRound).toBe(0);
    expect(loaded.state.findingHistory).toEqual([]);
    expect(loaded.state.blockedAgent).toBeNull();
    expect(loaded.state.resumeFrom).toBeNull();
    expect(loaded.state.reportedResetAt).toBeNull();
  });

  it('takes the review budget from the repository, never from a constant here', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile({ maxReviewRounds: 7 }),
      files: {
        '.gitignore': '.agent-orchestrator/runtime/\n',
        'tasks/V2-03.md': taskFile('V2-03'),
      },
    });
    const repository = await resolveFixture(root);
    trackWorkspacesOf(repository);

    await started({ repository, taskId: 'V2-03' }, deps());

    const loaded = loadTaskState(root, 'V2-03');
    expect(loaded.ok && loaded.state.maxReviewRounds).toBe(7);
  });

  it('reports an already-started task rather than starting it twice', async () => {
    const { repository, root } = await startableRepo();
    const first = await started({ repository, taskId: 'V2-03' }, deps());
    expect(first.outcome).toBe('STARTED');

    const statePath = join(root, '.agent-orchestrator', 'runtime', 'V2-03.json');
    const before = readFileSync(statePath);

    // A clock an hour later, and a preflight that records whether it ran.
    // Without the distinct clock this assertion could not fail: a rewrite
    // would reproduce the same `stateEnteredAt` and the same bytes.
    let preflightCalls = 0;
    const second = await started(
      { repository, taskId: 'V2-03' },
      deps({
        now: tickingClock(Date.parse('2026-08-10T11:00:00.000Z')),
        authPreflight: async () => {
          preflightCalls += 1;
          return provenAuthEvidence();
        },
      }),
    );

    expect(second.outcome).toBe('ALREADY_STARTED');
    expect(second.workspace).toBeNull();
    // Byte-identical: the second attempt neither rewrote nor refreshed it.
    expect(readFileSync(statePath)).toEqual(before);
    // And it stopped before spending anything: no preflight, no second branch.
    expect(preflightCalls).toBe(0);
    // `--format` rather than the default listing: Git marks a branch that is
    // checked out in a worktree with a leading `+`, which is exactly what the
    // first start created.
    expect(
      git(root, ['branch', '--list', 'ao/task/*', '--format=%(refname:short)']).trim(),
    ).toBe('ao/task/V2-03');
  });

  it('leaves the source checkout clean, so a second task can still be prepared', async () => {
    const { repository, root } = await startableRepo({
      'tasks/V2-04.md': taskFile('V2-04'),
    });

    const first = await started({ repository, taskId: 'V2-03' }, deps());
    expect(first.outcome).toBe('STARTED');

    // The defect this whole invariant exists to prevent: task one's own state
    // file making task two's workspace preparation impossible.
    expect(git(root, ['status', '--porcelain', '--untracked-files=all']).trim()).toBe('');

    const second = await started({ repository, taskId: 'V2-04' }, deps());
    expect(second.outcome).toBe('STARTED');
  });
});

describe('invariant 2 — the first state carries derived identity', () => {
  it('spells every identity field exactly as the workspace derivation does', async () => {
    const { repository, root } = await startableRepo();

    const result = await started({ repository, taskId: 'V2-03' }, deps());
    expect(result.outcome).toBe('STARTED');

    const derived = deriveTaskWorkspaceIdentity(repository, 'V2-03');
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    const loaded = loadTaskState(root, 'V2-03');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // Re-derived independently and compared: a state built from anything else
    // would reconcile as permanently diverged from the moment it was written.
    expect(loaded.state.workBranch).toBe(derived.identity.workBranch);
    expect(loaded.state.baseBranch).toBe(derived.identity.baseBranch);
    expect(loaded.state.repositoryId).toBe(derived.identity.repositoryId);
    expect(loaded.state.repositoryRoot).toBe(derived.identity.repositoryRoot);
  });

  it('records the base commit the workspace was really created at', async () => {
    const { repository, root } = await startableRepo();
    const head = git(root, ['rev-parse', 'HEAD']).trim();

    await started({ repository, taskId: 'V2-03' }, deps());

    const loaded = loadTaskState(root, 'V2-03');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.basePinnedCommit).toBe(head);
    expect(loaded.state.currentCommit).toBe(head);
    expect(loaded.state.worktreeCleanAtCheckpoint).toBe(true);
  });

  it('offers no way to name the state it creates, anywhere in the product', () => {
    // The transition table cannot defend creation — `saveTaskState` has no
    // predecessor to judge — so the only defence is that no production path
    // can name the state it creates. That is a claim about `src/`, not about
    // one file, so it is checked over `src/`.
    const sourceRoot = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(sourceRoot);

    // Exactly two modules may *reach* the writer: `advance-state.ts`, which
    // always supplies an `expectedRevision` and is therefore judged by the
    // transition table, and this creation path. `state-store.ts` is the
    // writer's own definition site, not a caller.
    const callers = files
      .filter((file) => /\bsaveTaskState\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(sourceRoot, file).split('\\').join('/'))
      .sort();
    expect(callers).toEqual([
      'run/start-task.ts',
      'state/advance-state.ts',
      'state/state-store.ts',
    ]);

    const creation = readFileSync(join(sourceRoot, 'run', 'start-task.ts'), 'utf8');
    expect(creation.match(/state: '([A-Z_]+)'/g) ?? []).toEqual(["state: 'WORKTREE_READY'"]);
  });
});

describe('invariant 1 — nothing durable before the workspace exists', () => {
  const expectNothingStarted = (root: string, taskId: string): void => {
    expect(loadTaskState(root, taskId).classification).toBe('STATE_MISSING');
    expect(existsSync(join(root, '.agent-orchestrator', 'runtime'))).toBe(false);
  };

  it('writes nothing when the task id is not a task id', async () => {
    const { repository, root } = await startableRepo();
    const result = await started({ repository, taskId: '../escape' }, deps());

    expect(result.outcome).toBe('TASK_ID_INVALID');
    expect(existsSync(join(root, '.agent-orchestrator', 'runtime'))).toBe(false);
  });

  it('writes nothing when the task is not in the plan', async () => {
    const { repository, root } = await startableRepo();
    const result = await started({ repository, taskId: 'V2-99' }, deps());

    expect(result.outcome).toBe('TASK_UNKNOWN');
    expectNothingStarted(root, 'V2-99');
  });

  it('writes nothing, and creates no branch, when the task is ineligible', async () => {
    const { repository, root } = await startableRepo({
      'tasks/V2-05.md': taskFile('V2-05', { dependsOn: ['V2-03'] }),
    });

    const result = await started({ repository, taskId: 'V2-05' }, deps());

    expect(result.outcome).toBe('TASK_INELIGIBLE');
    expect(result.reasonCodes).toEqual(['BLOCKED_BY_DEPENDENCIES']);
    expectNothingStarted(root, 'V2-05');
    expect(git(root, ['branch', '--list', 'ao/task/V2-05']).trim()).toBe('');
  });

  it('writes nothing, and creates no branch, when the auth preflight fails', async () => {
    const { repository, root } = await startableRepo();

    const result = await started(
      { repository, taskId: 'V2-03' },
      deps({ authPreflight: authPreflightFails }),
    );

    expect(result.outcome).toBe('AUTH_PREFLIGHT_FAILED');
    expectNothingStarted(root, 'V2-03');
    // The whole point of ordering the preflight before preparation: a task
    // that cannot run must not leave a branch behind claiming it started.
    expect(git(root, ['branch', '--list', 'ao/task/V2-03']).trim()).toBe('');
  });

  it('reports a workspace collision distinctly, and still writes nothing', async () => {
    const { repository, root } = await startableRepo();
    // A branch of the derived name already exists — the shape a crashed start
    // would leave behind.
    git(root, ['branch', 'ao/task/V2-03']);

    const result = await started({ repository, taskId: 'V2-03' }, deps());

    expect(result.outcome).toBe('WORKSPACE_COLLISION');
    // Two codes since V2-06A: what collided, and what the recovery assessor
    // concluded about it. A bare branch is not a workspace — there is no
    // registered worktree to prove anything about — so nothing is adopted.
    expect(result.reasonCodes).toEqual(['TASK_BRANCH_EXISTS', 'WORKSPACE_NOT_REGISTERED']);
    expectNothingStarted(root, 'V2-03');
  });

  it('reports an occupied worktree path as a collision too', async () => {
    const { repository, root } = await startableRepo();
    const derived = deriveTaskWorkspaceIdentity(repository, 'V2-03');
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    // Something already sits at the derived path, and it is not ours.
    mkdirSync(derived.identity.worktreePath, { recursive: true });
    writeFileSync(join(derived.identity.worktreePath, 'stranger.txt'), 'not ours\n', 'utf8');

    const result = await started({ repository, taskId: 'V2-03' }, deps());

    expect(result.outcome).toBe('WORKSPACE_COLLISION');
    // A stranger's directory at the derived path is registered with nobody.
    expect(result.reasonCodes).toEqual(['WORKTREE_PATH_OCCUPIED', 'WORKSPACE_NOT_REGISTERED']);
    expect(loadTaskState(root, 'V2-03').classification).toBe('STATE_MISSING');
    // Never adopted: the stranger's file is still there, untouched.
    expect(existsSync(join(derived.identity.worktreePath, 'stranger.txt'))).toBe(true);
  });

  it('never adopts a workspace whose branch sits on a different base', async () => {
    const { repository, root } = await startableRepo();
    const derived = deriveTaskWorkspaceIdentity(repository, 'V2-03');
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    // A branch of the right name at a *different* commit than the base pin
    // would be — the shape that must never be silently adopted.
    writeFileSync(join(root, 'later.txt'), 'later\n', 'utf8');
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'second commit']);
    const otherBase = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['branch', 'ao/task/V2-03', otherBase]);
    git(root, ['reset', '--hard', '--quiet', 'HEAD~1']);

    const result = await started({ repository, taskId: 'V2-03' }, deps());

    expect(result.outcome).toBe('WORKSPACE_COLLISION');
    // The branch exists on a different base and holds no registered worktree,
    // so V2-06A refuses it for the same reason it refuses any bare branch.
    expect(result.reasonCodes).toEqual(['TASK_BRANCH_EXISTS', 'WORKSPACE_NOT_REGISTERED']);
    expect(loadTaskState(root, 'V2-03').classification).toBe('STATE_MISSING');
    // The foreign branch is left exactly where it was.
    expect(git(root, ['rev-parse', 'ao/task/V2-03']).trim()).toBe(otherBase);
  });

  it('reports any other workspace refusal as such', async () => {
    const { repository, root } = await startableRepo();
    // An untracked file the ignore rules do not cover: the source checkout is
    // dirty, so no base state can be pinned.
    writeFileSync(join(root, 'stray.txt'), 'untracked\n', 'utf8');

    const result = await started({ repository, taskId: 'V2-03' }, deps());

    expect(result.outcome).toBe('WORKSPACE_REFUSED');
    expect(result.reasonCodes).toEqual(['SOURCE_WORKTREE_DIRTY']);
    expectNothingStarted(root, 'V2-03');
  });
});

describe('invariant 3 — the runtime directory must be provably ignored', () => {
  it('refuses an ignore rule that covers the state file but not the staging file', async () => {
    // The defect two review lenses found: `writeFileAtomically` stages
    // `<taskId>.json.tmp-<suffix>` beside the target, so a rule keyed on the
    // *file* leaves that name visible. A crash between staging and rename
    // then dirties the checkout — exactly the stall this check exists to
    // prevent, admitted by the check itself.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: {
        '.gitignore': '.agent-orchestrator/runtime/*.json\n',
        'tasks/V2-03.md': taskFile('V2-03'),
      },
    });
    const repository = await resolveFixture(root);
    trackWorkspacesOf(repository);

    // The state file alone would answer "ignored" — the directory does not.
    expect(await checkRuntimeIgnored(runGitCommand, root, 'V2-03')).toBe('NOT_IGNORED');

    const result = await started({ repository, taskId: 'V2-03' }, deps());
    expect(result.outcome).toBe('RUNTIME_NOT_IGNORED');
    expect(git(root, ['branch', '--list', 'ao/task/V2-03']).trim()).toBe('');
  });

  it('refuses a repository that does not ignore its runtime directory', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      // No .gitignore at all.
      profile: e2eProfile(),
      files: { 'tasks/V2-03.md': taskFile('V2-03') },
    });
    const repository = await resolveFixture(root);
    trackWorkspacesOf(repository);

    const result = await started({ repository, taskId: 'V2-03' }, deps());

    expect(result.outcome).toBe('RUNTIME_NOT_IGNORED');
    // Refused before anything was created — the branch is the evidence.
    expect(git(root, ['branch', '--list', 'ao/task/V2-03']).trim()).toBe('');
    expect(existsSync(join(root, '.agent-orchestrator', 'runtime'))).toBe(false);
  });

  it('refuses when Git cannot answer, rather than guessing either way', async () => {
    const { repository, root } = await startableRepo();
    const blindGit: GitRunner = async () =>
      Object.freeze({ outcome: 'UNAVAILABLE' as const, stdout: '', exitCode: null });

    const result = await started({ repository, taskId: 'V2-03' }, deps({ git: blindGit }));

    expect(result.outcome).toBe('RUNTIME_IGNORE_UNDETERMINED');
    expect(existsSync(join(root, '.agent-orchestrator', 'runtime'))).toBe(false);
  });

  it('answers IGNORED only when Git really ignores the state file', async () => {
    const { repository, root } = await startableRepo();
    expect(await checkRuntimeIgnored(runGitCommand, root, 'V2-03')).toBe('IGNORED');

    const bare = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V2-03.md': taskFile('V2-03') },
    });
    expect(await checkRuntimeIgnored(runGitCommand, bare, 'V2-03')).toBe('NOT_IGNORED');
    void repository;
  });

  it('treats a tracked state file as not ignored, because writing it still dirties the tree', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'tasks/V2-03.md': taskFile('V2-03') },
    });
    // Commit a state file at the exact path, and *also* ignore the directory.
    // Git reports a tracked path as not ignored, which is the answer that
    // matters: overwriting it would show up as a modification.
    mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
    writeFileSync(join(root, '.agent-orchestrator', 'runtime', 'V2-03.json'), '{}\n', 'utf8');
    writeFileSync(join(root, '.gitignore'), '.agent-orchestrator/runtime/\n', 'utf8');
    git(root, ['add', '--force', '.agent-orchestrator/runtime/V2-03.json', '.gitignore']);
    git(root, ['commit', '--quiet', '-m', 'tracked state']);

    expect(await checkRuntimeIgnored(runGitCommand, root, 'V2-03')).toBe('NOT_IGNORED');
  });

  it('answers UNDETERMINED for an id that cannot be a state file name', async () => {
    const { root } = await startableRepo();
    expect(await checkRuntimeIgnored(runGitCommand, root, '../escape')).toBe('UNDETERMINED');
  });
});

describe('the write that does not land', () => {
  it('reports the orphaned workspace instead of claiming nothing happened', async () => {
    const { repository, root } = await startableRepo();

    // The one seam that can refuse the durable write after the workspace was
    // created deliberately. This is the crash window in slow motion.
    const result = await started(
      { repository, taskId: 'V2-03' },
      deps({
        replace: () => {
          throw new Error('write refused');
        },
      }),
    );

    expect(result.outcome).toBe('STATE_NOT_RECORDED');
    // Both halves of the honest answer: no state, and a real worktree that
    // nothing now records as belonging to this task.
    expect(loadTaskState(root, 'V2-03').classification).toBe('STATE_MISSING');
    expect(result.workspace).not.toBeNull();
    expect(result.residue).toBe(true);
    expect(existsSync(result.workspace?.worktreePath ?? '')).toBe(true);
    // Both codes, not just the first: the save result's `detail` is appended
    // when it has one, and asserting only `[0]` left that branch unpinned —
    // which hid the fact that this path really does carry two.
    expect(result.reasonCodes).toEqual(['WRITE_FAILED', 'REPLACE_FAILED']);
  });

  it('reports that same workspace as a collision on the next attempt', async () => {
    const { repository } = await startableRepo();
    await started(
      { repository, taskId: 'V2-03' },
      deps({
        replace: () => {
          throw new Error('write refused');
        },
      }),
    );

    // Until V2-06A this was a `WORKSPACE_COLLISION` an operator cleaned up by
    // hand. The distinct code existed so that the adoption slice would have
    // something precise to attach to, and it now has: the leftovers are proven
    // to be this task's own untouched workspace and are reused.
    // `tests/v2-06a-workspace-adoption.test.ts` holds the counter-proofs.
    const retry = await started({ repository, taskId: 'V2-03' }, deps());
    expect(retry.outcome).toBe('ADOPTED');
    expect(retry.residue).toBe(false);
  });
});

describe('the remaining refusals', () => {
  it('reports a plan that cannot be read at all', async () => {
    // The profile declares `tasks/`, and there is no such directory.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { '.gitignore': '.agent-orchestrator/runtime/\n', 'README.md': '# no tasks\n' },
    });
    const repository = await resolveFixture(root);
    trackWorkspacesOf(repository);

    const result = await started({ repository, taskId: 'V2-03' }, deps());

    expect(result.outcome).toBe('PLANNING_FAILED');
    expect(result.reasonCodes).toEqual(['TASK_SOURCE_NOT_FOUND']);
    expect(existsSync(join(root, '.agent-orchestrator', 'runtime'))).toBe(false);
  });

  it('refuses an unusable record rather than overwriting it', async () => {
    const { repository, root } = await startableRepo();
    const statePath = join(root, '.agent-orchestrator', 'runtime', 'V2-03.json');
    mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
    writeFileSync(statePath, 'not a state document\n', 'utf8');
    const before = readFileSync(statePath);

    const result = await started({ repository, taskId: 'V2-03' }, deps());

    expect(result.outcome).toBe('STATE_UNUSABLE');
    // Repairs nothing, and did not reach Git either.
    expect(readFileSync(statePath)).toEqual(before);
    expect(git(root, ['branch', '--list', 'ao/task/V2-03']).trim()).toBe('');
  });
});

/**
 * Runs last, and reads what the cases above actually produced.
 *
 * The first version of this block asserted that the declared list had no
 * duplicates — which is the exact check V2-01's review had already replaced in
 * `tests/run-plan.test.ts`, reintroduced here from habit. A vocabulary test
 * that compares a list with itself measures nothing. This one measures which
 * outcomes a production path really reaches, and it must reach all of them.
 */
describe('startTask — outcome coverage', () => {
  it('exercises every declared outcome', () => {
    const uncovered = START_TASK_OUTCOMES.filter((outcome) => !produced.has(outcome));
    expect(uncovered).toEqual([]);
  });
});
