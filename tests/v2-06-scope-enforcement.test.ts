/**
 * V2-06 — scope enforcement: the effect, not the intention.
 *
 * The guarantee under test is one sentence: **a mutating step cannot be left
 * successfully until the task's actual effect on the repository has been
 * measured against the scope it was pinned under.** Everything here is written
 * against a way that sentence could quietly be false.
 *
 *  1. **A check that only looks before the writer.** That governs what the loop
 *     intended to permit. The repository only ever suffers what the writer did.
 *  2. **A check built on `git status`.** A writer is allowed to commit, and a
 *     writer that commits leaves a *clean* tree — so the one observation an
 *     agent can most easily make invisible is the one a status check misses.
 *  3. **A rename read at one end.** Moving a file out of a forbidden directory
 *     into an allowed one is a deletion the destination hides.
 *  4. **A scope the writer can widen.** Reading the policy from the tree the
 *     agent has write access to is asking the agent how far it may go.
 *  5. **"Could not check" read as "checked and clean".** An unreadable Git is
 *     not evidence of good behaviour — nor is it evidence of bad behaviour, so
 *     it must not be reported as a scope violation either.
 *
 * Real repositories, real worktrees, real `git commit`s. The Claude boundary
 * stays injected — it is a subscription CLI — but what the injected writer does
 * to the worktree is done with real Git, because every fact this slice rests on
 * is a fact about Git.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { classifyPath } from '../src/scope/scope-policy.js';
import { observeTaskDelta } from '../src/scope/task-delta.js';
import { assessTaskScope } from '../src/scope/assess-scope.js';
import { readPinnedScope } from '../src/scope/pinned-scope.js';
import {
  runContextLoadingStep,
  runImplementStep,
  runRemediateStep,
  runReviewStep,
  runVerifyStep,
  runWorktreeReadyStep,
  type LoopDependencies,
} from '../src/loop/loop-step.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';
import { startTask } from '../src/run/start-task.js';
import { loadTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, git, removeRepoFixtures, writeRepoFile } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } from './helpers/worktree-fixtures.js';
import {
  findingsReview,
  recordedAgent,
  recordedVerify,
  reviewResult,
  tickingClock,
  writerSuccess,
} from './helpers/e2e-fixtures.js';
import { nulJoin, scriptedGit, untrackedRecords } from './helpers/scope-git.js';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const TASK_ID = 'V2-06';

/** A profile that differs from the shared one in exactly its scope block. */
function scopeProfile(scope: {
  readonly allowed: readonly string[];
  readonly protected?: readonly string[];
}): string {
  const protectedPaths = scope.protected ?? [];
  const list = (paths: readonly string[]): string =>
    paths.length === 0 ? ' []' : `\n${paths.map((path) => `    - ${path}`).join('\n')}`;

  return `schemaVersion: 1
repository:
  id: v2-06-scope
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: VERIFY
      command: [git, --version]
scope:
  allowedPaths:${list(scope.allowed)}
  protectedPaths:${list(protectedPaths)}
completion:
  maxReviewRounds: 3
remote:
  required: false
`;
}

interface Pinned {
  readonly repository: ResolvedRepository;
  readonly root: string;
  readonly current: StateLoadSuccess;
  readonly worktree: string;
}

/**
 * A real task, started by production code and driven to `IMPLEMENTING`.
 *
 * `build/` is ignored by the fixture so the "ignored files are not a scope
 * effect" case has somewhere to write; `src/` exists so the allowed cases have
 * something to modify rather than only to create.
 */
async function atImplementing(
  options: {
    readonly profile?: string;
    readonly files?: Readonly<Record<string, string>>;
    /**
     * Paths to commit even though `.gitignore` matches them.
     *
     * `createRepoFixture` stages with `git add --all`, which skips ignored
     * paths, so a file that is *both* tracked and ignored — the case that
     * separates "ignored" from "not a scope effect" — cannot be produced any
     * other way.
     */
    readonly trackIgnored?: readonly string[];
  } = {},
): Promise<Pinned> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: options.profile ?? scopeProfile({ allowed: ['src'] }),
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\nbuild/\n',
      'src/index.ts': 'export const start = true;\n',
      'docs/notes.md': '# notes\n',
      [`tasks/${TASK_ID}.md`]: [
        '---',
        `id: ${TASK_ID}`,
        'title: stay inside the sandbox',
        'status: OPEN',
        'kind: NORMAL',
        'priority: NORMAL',
        'currentFocus: true',
        'dependsOn: []',
        '---',
        'Change only what the profile allows.',
      ].join('\n'),
      ...options.files,
    },
  });

  for (const path of options.trackIgnored ?? []) {
    git(root, ['add', '-f', '--', path]);
  }
  if ((options.trackIgnored ?? []).length > 0) {
    git(root, ['commit', '--quiet', '-m', 'track ignored fixture files']);
  }

  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);

  const started = await startTask(
    { repository, taskId: TASK_ID },
    { git: runGitCommand, now: tickingClock(), authPreflight: authPreflightPasses, lease: leaseFor(repository) },
  );
  expect(started.outcome).toBe('STARTED');

  let current = reload(root);
  const advance = async (
    step: (c: StateLoadSuccess, d: LoopDependencies) => Promise<{ outcome: string }>,
  ): Promise<void> => {
    const result = await step(current, deps(current, repository));
    expect(result.outcome).toBe('ADVANCED');
    current = reload(root);
  };

  await advance(runWorktreeReadyStep);
  await advance(runContextLoadingStep);
  expect(current.state.state).toBe('IMPLEMENTING');

  return { repository, root, current, worktree: current.state.worktreePath };
}

function reload(root: string): StateLoadSuccess {
  const loaded = loadTaskState(root, TASK_ID);
  if (!loaded.ok) throw new Error('state did not load');
  return loaded;
}

function deps(
  current: StateLoadSuccess,
  repository: ResolvedRepository,
  overrides: Partial<LoopDependencies> = {},
): LoopDependencies {
  return {
    repositoryRoot: current.state.repositoryRoot,
    now: '2026-08-11T09:00:00.000Z',
    authorisedWorktreePath: current.state.worktreePath,
    verification: repository.verification,
    taskBrief: 'unused by these steps',
    brief: readExecutionBrief(repository, TASK_ID, current.state.worktreePath),
    ...overrides,
  };
}

/** A writer that really writes `path`, and commits it. */
function writerCommitting(path: string, contents = 'touched\n') {
  return (call: { readonly cwd: string }) => {
    writeRepoFile(call.cwd, path, contents);
    git(call.cwd, ['add', '--all']);
    git(call.cwd, ['commit', '--quiet', '-m', `writer wrote ${path}`]);
    return writerSuccess();
  };
}

/** A writer that writes `path` and leaves it uncommitted. */
function writerLeaving(path: string, contents = 'touched\n') {
  return (call: { readonly cwd: string }) => {
    writeRepoFile(call.cwd, path, contents);
    return writerSuccess();
  };
}

/* ══════════════════ the guarantee: effect, not intention ═════════════════ */

describe('the post-writer gate measures the effect', () => {
  it('blocks a committing writer that wrote outside the allowed scope', async () => {
    const { repository, root, current, worktree } = await atImplementing();
    const agent = recordedAgent({ claude: writerCommitting('docs/leak.md') });
    const verify = recordedVerify();

    const step = await runImplementStep(
      current,
      deps(current, repository, { agent: agent.runner, verify: verify.runner }),
    );

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(reload(root).state.state).toBe('SCOPE_VIOLATION');

    // The point of this case, stated as an assertion rather than as a comment:
    // the writer committed, so the tree is *clean*. A guard built on
    // `git status --porcelain` would have seen nothing at all here.
    expect(git(worktree, ['status', '--porcelain']).trim()).toBe('');

    expect(step.scope?.verdict).toBe('VIOLATION');
    expect(step.scope?.offences).toEqual([
      { path: 'docs/leak.md', change: 'ADDED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });

  it('blocks an uncommitted out-of-scope change', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({ claude: writerLeaving('docs/notes.md', '# rewritten\n') });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(reload(root).state.state).toBe('SCOPE_VIOLATION');
    expect(step.scope?.offences).toEqual([
      { path: 'docs/notes.md', change: 'MODIFIED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });

  it('blocks an untracked out-of-scope file', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({ claude: writerLeaving('docs/scratch.md') });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(step.scope?.offences).toEqual([
      { path: 'docs/scratch.md', change: 'UNTRACKED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });

  it('lets a writer that stayed inside the allowed scope advance', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({ claude: writerCommitting('src/feature.ts', 'export const f = 1;\n') });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('VERIFYING');
    expect(reload(root).state.state).toBe('VERIFYING');
    // The passing assessment is reported too, so a driver can see the guard ran
    // rather than only that the step survived it.
    expect(step.scope?.verdict).toBe('WITHIN_SCOPE');
    expect(step.scope?.offenceCount).toBe(0);
  });

  it('does not count ignored files as a scope effect', async () => {
    const { repository, current } = await atImplementing();
    // `build/` is ignored by the fixture and is outside `src`. If ignored files
    // counted, every correctly configured repository would fail this gate — the
    // orchestrator writes its own runtime state into an ignored directory.
    const agent = recordedAgent({ claude: writerLeaving('build/output.js', 'compiled\n') });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('VERIFYING');
    expect(step.scope?.offenceCount).toBe(0);
  });

  it('counts a tracked file even when an ignore rule matches it', async () => {
    // `logs/keep.txt` is committed *and* matched by `.gitignore`. An ignore rule
    // does not un-track a file, and editing a tracked file changes the
    // repository whatever `.gitignore` says.
    const { repository, current } = await atImplementing({
      files: { '.gitignore': '.agent-orchestrator/runtime/\nlogs/\n', 'logs/keep.txt': 'kept\n' },
      trackIgnored: ['logs/keep.txt'],
    });
    const agent = recordedAgent({ claude: writerCommitting('logs/keep.txt', 'changed\n') });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(step.scope?.offences).toEqual([
      { path: 'logs/keep.txt', change: 'MODIFIED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });

  it('sees both ends of a rename, so a forbidden deletion cannot hide behind an allowed addition', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({
      claude: (call) => {
        // Into the allowed directory, out of a forbidden one. With rename
        // detection on this is one `R100` record whose destination is allowed.
        git(call.cwd, ['mv', 'docs/notes.md', 'src/notes.md']);
        git(call.cwd, ['commit', '--quiet', '-m', 'move notes into src']);
        return writerSuccess();
      },
    });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(step.scope?.offences).toEqual([
      { path: 'docs/notes.md', change: 'DELETED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });

  it('lets a protected carve-out beat the allowed subtree containing it', async () => {
    const { repository, current } = await atImplementing({
      profile: scopeProfile({ allowed: ['src'], protected: ['src/generated'] }),
      files: { 'src/generated/api.ts': 'export const generated = true;\n' },
    });
    const agent = recordedAgent({ claude: writerCommitting('src/generated/api.ts', 'export const x = 2;\n') });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(step.scope?.offences).toEqual([
      { path: 'src/generated/api.ts', change: 'MODIFIED', decision: 'PROTECTED' },
    ]);
  });
});

/* ═══════════════════════ the pre-writer gate ════════════════════════════ */

describe('the pre-writer gate', () => {
  it('refuses to start a writer on a tree that is already out of scope', async () => {
    const { repository, root, current, worktree } = await atImplementing();

    // A previous pass left the tree violated — the changes stay as evidence, so
    // this is the ordinary state of a worktree after a scope violation whose
    // durable write was refused, or one a human has not yet cleaned up.
    writeRepoFile(worktree, 'docs/left-behind.md', 'from an earlier pass\n');

    const agent = recordedAgent({ claude: () => writerSuccess() });
    const verify = recordedVerify();

    const step = await runImplementStep(
      current,
      deps(current, repository, { agent: agent.runner, verify: verify.runner }),
    );

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(reload(root).state.state).toBe('SCOPE_VIOLATION');
    // Nothing was spent: no writer invocation, no verification.
    expect(agent.calls).toEqual([]);
    expect(verify.calls).toEqual([]);
  });

  it('names no blocked agent when no agent ran', async () => {
    const { repository, root, current, worktree } = await atImplementing();
    writeRepoFile(worktree, 'docs/left-behind.md', 'from an earlier pass\n');
    const agent = recordedAgent({ claude: () => writerSuccess() });

    await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    // A pre-writer violation is a fact about the tree this step found. Naming
    // an agent that was never started would attribute it to a run that did not
    // happen.
    expect(reload(root).state.blockedAgent).toBeNull();
  });

  it('names the writer when the writer produced the violation', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({ claude: writerCommitting('docs/leak.md') });

    await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(reload(root).state.blockedAgent).toBe('claude');
  });
});

/* ═══════════════════ what the block does and does not do ════════════════ */

describe('the recorded violation', () => {
  it('carries no resume point, and is not resumable', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({ claude: writerCommitting('docs/leak.md') });

    await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    const after = reload(root).state;
    expect(after.state).toBe('SCOPE_VIOLATION');
    // `SCOPE_VIOLATION` cannot be continued, so a stored re-entry point there
    // would be misleading — and the contract refuses one outright.
    expect(after.resumeFrom).toBeNull();
    expect(after.reportedResetAt).toBeNull();
  });

  it('leaves the offending changes in place as evidence', async () => {
    const { repository, current, worktree } = await atImplementing();
    const agent = recordedAgent({ claude: writerCommitting('docs/leak.md', 'the evidence\n') });

    await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    // Never reverted. Undoing the writer's work would hide the effect a human
    // is being asked to inspect, and could destroy legitimate work sitting in
    // the same tree.
    const leaked = join(worktree, 'docs', 'leak.md');
    expect(existsSync(leaked)).toBe(true);
    expect(readFileSync(leaked, 'utf8')).toBe('the evidence\n');
  });

  it('leaves an uncommitted offending change in place too', async () => {
    const { repository, current, worktree } = await atImplementing();
    const agent = recordedAgent({ claude: writerLeaving('docs/leak.md', 'uncommitted evidence\n') });

    await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    // Stated separately from the committed case on purpose: a "tidy up before
    // parking" `git reset --hard` / `git clean` would leave a *committed*
    // violation untouched and destroy this one, so only the uncommitted case
    // can tell the two apart.
    const leaked = join(worktree, 'docs', 'leak.md');
    expect(existsSync(leaked)).toBe(true);
    expect(readFileSync(leaked, 'utf8')).toBe('uncommitted evidence\n');
    expect(git(worktree, ['status', '--porcelain']).trim()).not.toBe('');
  });

  it('runs no verification and no reviewer', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({ claude: writerCommitting('docs/leak.md') });
    const verify = recordedVerify();

    await runImplementStep(
      current,
      deps(current, repository, { agent: agent.runner, verify: verify.runner }),
    );

    expect(verify.calls).toEqual([]);
    expect(agent.countFor('codex')).toBe(0);
  });
});

/* ═════════════ the scope is the pinned one, and cannot be widened ═══════ */

describe('the governing scope comes from the pinned commit', () => {
  it('ignores a profile the writer widened inside its own worktree', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({
      claude: (call) => {
        // Self-authorisation, one file edit away: the agent grants itself the
        // whole repository and then writes outside the scope it was given.
        writeRepoFile(
          call.cwd,
          '.agent-orchestrator/repo-profile.yaml',
          scopeProfile({ allowed: ['docs', 'src'] }),
        );
        writeRepoFile(call.cwd, 'docs/leak.md', 'authorised by myself\n');
        git(call.cwd, ['add', '--all']);
        git(call.cwd, ['commit', '--quiet', '-m', 'widen my own scope']);
        return writerSuccess();
      },
    });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(reload(root).state.state).toBe('SCOPE_VIOLATION');
    // Both the leak and the self-authorising edit are offences: the profile
    // itself is not inside `src` either.
    expect(step.scope?.offences.map((offence) => offence.path).sort()).toEqual([
      '.agent-orchestrator/repo-profile.yaml',
      'docs/leak.md',
    ]);
  });

  it('ignores a profile widened on the default branch after the task was pinned', async () => {
    const { repository, root, current } = await atImplementing();

    // The operator widens the scope on `main` while the task is in flight. The
    // run was pinned before that commit, so it is governed by what it was
    // pinned under — a later edit cannot retroactively authorise work nobody
    // reviewed under the new policy.
    writeRepoFile(root, '.agent-orchestrator/repo-profile.yaml', scopeProfile({ allowed: ['src', 'docs'] }));
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'widen scope on main']);

    const agent = recordedAgent({ claude: writerCommitting('docs/leak.md') });
    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(reload(root).state.state).toBe('SCOPE_VIOLATION');
  });
});

/* ═══════════ the writer attacking the observation, not the files ════════ */

describe('a writer cannot hide its effect by attacking the observation', () => {
  it('reads the pinned commit past a refs/replace mapping the writer installed', async () => {
    const { repository, root, current, worktree } = await atImplementing();
    const agent = recordedAgent({
      claude: (call) => {
        // `git replace` does not change what a commit *contains* — it changes
        // what resolving that commit *returns*. `refs/replace` lives in the
        // common ref store, so a linked worktree can install one, and every
        // later `git show <base>:…` and `git diff <base>` then reads the
        // writer's own tree instead of the pinned one.
        //
        // The victim is a file that is **tracked** at the pin. A newly added
        // file would still be caught by `ls-files --others` whatever the diff
        // said, so it would not exercise this bypass at all — the whole point
        // is a modification only `git diff <base>` could ever have reported.
        writeRepoFile(call.cwd, 'docs/notes.md', 'PWNED\n');
        git(call.cwd, ['add', '-A']);
        const tree = git(call.cwd, ['write-tree']).trim();
        const base = current.state.basePinnedCommit ?? '';
        git(call.cwd, ['reset', '-q', base]);
        const forged = git(call.cwd, ['commit-tree', tree, '-m', 'forged']).trim();
        git(call.cwd, ['replace', '-f', base, forged]);
        return writerSuccess();
      },
    });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    // The mapping really was installed — otherwise this test proves nothing.
    expect(git(worktree, ['replace', '-l']).trim()).not.toBe('');
    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(reload(root).state.state).toBe('SCOPE_VIOLATION');
    expect(step.scope?.offences).toEqual([
      { path: 'docs/notes.md', change: 'MODIFIED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });

  it('refuses to produce a delta when the index is told to stop watching a file', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({
      claude: (call) => {
        // `--assume-unchanged` makes `git diff <base>` report nothing for the
        // path however far its content moves. No flag makes `diff` look anyway,
        // so the only honest answer is that the observation cannot be trusted.
        writeRepoFile(call.cwd, 'docs/notes.md', 'PWNED\n');
        git(call.cwd, ['update-index', '--assume-unchanged', 'docs/notes.md']);
        return writerSuccess();
      },
    });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    // INDETERMINATE, not VIOLATION: the bits prove the observation is unusable,
    // not what was hidden behind them. Either way the task does not advance.
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(step.state).not.toBe('VERIFYING');
    expect(step.scope?.verdict).toBe('INDETERMINATE');
    expect(step.scope?.reason).toBe('INDEX_SUPPRESSES_WORKTREE');
    expect(reload(root).state.state).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('reports an ignore file the writer introduced, though the rule hides it', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({
      claude: (call) => {
        // Two plain file writes, no Git command at all: the new rule matches
        // `.gitignore` itself, so both paths vanish from
        // `ls-files --others --exclude-standard`.
        writeRepoFile(call.cwd, 'config/.gitignore', '*\n');
        writeRepoFile(call.cwd, 'config/backdoor.yaml', 'backdoor\n');
        return writerSuccess();
      },
    });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(reload(root).state.state).toBe('SCOPE_VIOLATION');
    // The ignore file is recovered even though it ignores itself; the payload it
    // was hiding stays excluded, which is the ignored-files decision holding.
    expect(step.scope?.offences).toEqual([
      { path: 'config/.gitignore', change: 'UNTRACKED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });

  it('lets an ignore file inside the allowed subtree through, because it can hide nothing else', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({
      claude: (call) => {
        writeRepoFile(call.cwd, 'src/.gitignore', '*.tmp\n');
        return writerSuccess();
      },
    });

    const step = await runImplementStep(current, deps(current, repository, { agent: agent.runner }));

    // An ignore pattern cannot reach above its own directory, so a rule inside
    // `src` can only hide paths a scope allowing `src` already permitted.
    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('VERIFYING');
  });
});

/* ══════════ "could not check" is neither a pass nor an accusation ═══════ */

describe('an indeterminate assessment is not a violation', () => {
  it('parks for a human when Git cannot produce the diff', async () => {
    const { repository, root, current } = await atImplementing();
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      deps(current, repository, { agent: agent.runner, git: scriptedGit({ diff: null }) }),
    );

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(step.state).not.toBe('SCOPE_VIOLATION');
    expect(step.scope?.verdict).toBe('INDETERMINATE');
    expect(step.scope?.reason).toBe('DIFF_UNAVAILABLE');
    // Nothing was proven about the agent, so nothing is claimed about it, and
    // the task carries the phase it was heading for.
    expect(reload(root).state.resumeFrom).toEqual({ phase: 'IMPLEMENT', round: 1 });
    expect(agent.calls).toEqual([]);
  });

  it('parks for a human when the pinned tree has no profile', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      deps(current, repository, { agent: agent.runner, git: scriptedGit({ profile: null }) }),
    );

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(step.scope?.reason).toBe('PROFILE_UNAVAILABLE');
  });

  it('parks for a human when the pinned profile is not a valid profile', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      deps(current, repository, {
        agent: agent.runner,
        git: scriptedGit({ profile: 'schemaVersion: 1\nrepository: {}\n' }),
      }),
    );

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(step.scope?.reason).toBe('PROFILE_INVALID');
  });

  it('refuses a diff stream it cannot parse rather than guessing at it', async () => {
    // A desynchronised parse is not a garbled message; it reads a path as a
    // status and attributes every later path to the wrong entry, which is a
    // wrong verdict in a check whose whole job is to be right about which paths
    // changed.
    const delta = await observeTaskDelta(
      scriptedGit({ diff: nulJoin(['M', 'src/a.ts', 'not-a-status', 'src/b.ts']) }),
      'anywhere',
      'a'.repeat(40),
    );

    expect(delta.outcome).toBe('INDETERMINATE');
    if (delta.outcome !== 'INDETERMINATE') return;
    expect(delta.refusal).toBe('DIFF_UNPARSABLE');
  });

  it('parks for a human when the untracked listing cannot be produced', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      deps(current, repository, { agent: agent.runner, git: scriptedGit({ untracked: null }) }),
    );

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(step.scope?.reason).toBe('UNTRACKED_UNAVAILABLE');
    expect(agent.calls).toEqual([]);
  });

  it('parks for a human when the index state cannot be read', async () => {
    const { repository, current } = await atImplementing();
    const agent = recordedAgent({ claude: () => writerSuccess() });

    const step = await runImplementStep(
      current,
      deps(current, repository, { agent: agent.runner, git: scriptedGit({ indexState: null }) }),
    );

    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(step.scope?.reason).toBe('INDEX_STATE_UNAVAILABLE');
  });

  it('refuses an untracked stream whose records carry no tag', async () => {
    const delta = await observeTaskDelta(
      scriptedGit({ untracked: nulJoin(['src/a.ts', 'src/b.ts']) }),
      'anywhere',
      'a'.repeat(40),
    );

    expect(delta.outcome).toBe('INDETERMINATE');
    if (delta.outcome !== 'INDETERMINATE') return;
    expect(delta.refusal).toBe('UNTRACKED_UNPARSABLE');
  });

  it('reports a task with no base pin as indeterminate, never as clean', async () => {
    const assessment = await assessTaskScope({
      git: scriptedGit(),
      authorisedWorktreePath: 'anywhere',
      basePinnedCommit: null,
    });

    expect(assessment.verdict).toBe('INDETERMINATE');
    expect(assessment.reason).toBe('NO_BASE_PIN');
    expect(assessment.offenceCount).toBe(0);
  });
});

/* ════════════════════════ remediation is guarded too ════════════════════ */

describe('the remediation pass is guarded on the same terms', () => {
  it('blocks a remediating writer that wrote outside the allowed scope', async () => {
    const { repository, root, current } = await atImplementing();

    // Into REMEDIATING through the states the table declares, so the guard is
    // reached the way a real run reaches it.
    const toVerifying = await runImplementStep(
      current,
      deps(current, repository, { agent: recordedAgent({ claude: () => writerSuccess() }).runner }),
    );
    expect(toVerifying.state).toBe('VERIFYING');

    const remediating = await enterRemediating(root, repository);
    const agent = recordedAgent({ claude: writerCommitting('docs/leak.md') });

    const step = await runRemediateStep(
      remediating,
      deps(remediating, repository, {
        agent: agent.runner,
        remediationPayload: 'Address the finding in src/index.ts.',
      }),
    );

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(reload(root).state.state).toBe('SCOPE_VIOLATION');
    expect(step.scope?.offences).toEqual([
      { path: 'docs/leak.md', change: 'ADDED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });

  it('lets a remediating writer that stayed in scope advance', async () => {
    const { repository, root, current } = await atImplementing();
    await runImplementStep(
      current,
      deps(current, repository, { agent: recordedAgent({ claude: () => writerSuccess() }).runner }),
    );

    const remediating = await enterRemediating(root, repository);
    const agent = recordedAgent({ claude: writerCommitting('src/fixed.ts', 'export const fixed = 1;\n') });

    const step = await runRemediateStep(
      remediating,
      deps(remediating, repository, {
        agent: agent.runner,
        remediationPayload: 'Address the finding in src/index.ts.',
      }),
    );

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('VERIFYING');
    expect(step.scope?.verdict).toBe('WITHIN_SCOPE');
  });
});

/**
 * `VERIFYING → REVIEWING → REMEDIATING`, driven by the real steps.
 *
 * Built rather than seeded so the state the remediate guard sees is one the
 * transition table and the loop actually produce.
 */
async function enterRemediating(
  root: string,
  repository: ResolvedRepository,
): Promise<StateLoadSuccess> {
  const verifying = reload(root);
  const verified = await runVerifyStep(
    verifying,
    deps(verifying, repository, { verify: recordedVerify().runner }),
  );
  expect(verified.state).toBe('REVIEWING');

  const reviewing = reload(root);
  const reviewed = await runReviewStep(
    reviewing,
    deps(reviewing, repository, {
      agent: recordedAgent({
        codex: () => reviewResult(findingsReview('src/index.ts', 'v2-06.rule')),
      }).runner,
    }),
  );
  expect(reviewed.state).toBe('REMEDIATING');

  return reload(root);
}

/* ════════════ the seam trims, so the stream must not start with a path ══ */

describe('a leading space in an untracked path cannot be trimmed away', () => {
  it('keeps a path whose name begins with a space distinct from the one it would trim to', async () => {
    // `runGitCommand` hands back *trimmed* stdout. Without the `-t` tag the
    // untracked stream begins with a path, so a file literally named " src" at
    // the repository root arrives as `src` — and a scope allowing `src` accepts
    // it. A path outside the sandbox, classified as one inside it.
    const delta = await observeTaskDelta(
      scriptedGit({ untracked: untrackedRecords([' src', 'src/b.txt']) }),
      'anywhere',
      'a'.repeat(40),
    );

    expect(delta.outcome).toBe('OBSERVED');
    if (delta.outcome !== 'OBSERVED') return;
    expect(delta.paths.map((changed) => changed.path)).toEqual([' src', 'src/b.txt']);
  });

  it('classifies that path as outside a scope that allows only src', async () => {
    const assessment = await assessTaskScope({
      git: scriptedGit({ untracked: untrackedRecords([' src']) }),
      authorisedWorktreePath: 'anywhere',
      basePinnedCommit: 'a'.repeat(40),
    });

    expect(assessment.verdict).toBe('VIOLATION');
    expect(assessment.offences).toEqual([
      { path: ' src', change: 'UNTRACKED', decision: 'OUTSIDE_ALLOWED' },
    ]);
  });
});

/* ═════════════════════════ the pure policy layer ════════════════════════ */

describe('classifyPath', () => {
  const scope = { allowedPaths: ['src', 'tests'], protectedPaths: ['src/generated'] };

  it('admits a declared path itself and everything beneath it', () => {
    expect(classifyPath('src', scope)).toBe('ALLOWED');
    expect(classifyPath('src/a.ts', scope)).toBe('ALLOWED');
    expect(classifyPath('src/deep/nested/a.ts', scope)).toBe('ALLOWED');
    expect(classifyPath('tests/a.test.ts', scope)).toBe('ALLOWED');
  });

  it('does not admit a sibling that merely shares a prefix', () => {
    // A bare `startsWith` would hand a writer every name beginning with "src".
    expect(classifyPath('srcfoo.ts', scope)).toBe('OUTSIDE_ALLOWED');
    expect(classifyPath('src-backup/a.ts', scope)).toBe('OUTSIDE_ALLOWED');
  });

  it('lets deny win over allow wherever the two overlap', () => {
    expect(classifyPath('src/generated', scope)).toBe('PROTECTED');
    expect(classifyPath('src/generated/api.ts', scope)).toBe('PROTECTED');
  });

  it('refuses a path outside every declared subtree', () => {
    expect(classifyPath('docs/a.md', scope)).toBe('OUTSIDE_ALLOWED');
    expect(classifyPath('package.json', scope)).toBe('OUTSIDE_ALLOWED');
  });

  it('compares case exactly, which is the fail-closed direction', () => {
    // Folding case would widen a declared scope on exactly the platforms where
    // a writer can produce a spelling the profile author never wrote.
    expect(classifyPath('SRC/a.ts', scope)).toBe('OUTSIDE_ALLOWED');
  });
});

/* ══════════════════════ the pinned profile is re-validated ══════════════ */

describe('readPinnedScope', () => {
  it('reads the scope declared by the profile at the pinned commit', async () => {
    const { current } = await atImplementing({
      profile: scopeProfile({ allowed: ['src', 'tests'], protected: ['src/generated'] }),
    });

    const pinned = await readPinnedScope(
      runGitCommand,
      current.state.worktreePath,
      current.state.basePinnedCommit,
    );

    expect(pinned.outcome).toBe('RESOLVED');
    if (pinned.outcome !== 'RESOLVED') return;
    expect(pinned.scope.allowedPaths).toEqual(['src', 'tests']);
    expect(pinned.scope.protectedPaths).toEqual(['src/generated']);
  });

  it('refuses a document that is not one well-formed YAML profile', async () => {
    const pinned = await readPinnedScope(
      scriptedGit({ profile: 'schemaVersion: 1\n  broken: [oops\n' }),
      'anywhere',
      'a'.repeat(40),
    );

    expect(pinned.outcome).toBe('UNAVAILABLE');
    if (pinned.outcome !== 'UNAVAILABLE') return;
    expect(pinned.refusal).toBe('PROFILE_MALFORMED');
  });
});
