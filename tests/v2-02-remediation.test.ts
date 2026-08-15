/**
 * V2-02 remediation — the counter-examples, driven through the V2-04 gate.
 *
 * ── Why these tests are shaped like this ───────────────────────────────────
 *
 * Every defect this file pins was *latent* in V2-02: `contextComplete` was
 * computed and only a renderer read it, so a false verdict cost nothing. V2-04
 * gated execution on it — a correct fix for a review finding — and three
 * dormant inaccuracies became total blockers.
 *
 * So testing the brief reader in isolation would re-create the exact blind
 * spot. Each case here therefore runs through the thing that consumes the
 * verdict: `runContextLoadingStep` / `runImplementStep`, on a real repository,
 * with a real worktree, and proves what the *writer* was or was not handed.
 *
 * The governance rule this encodes: a slice may not turn an older slice's
 * unverified promise into a hard gate without adversarially re-verifying that
 * promise.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { readExecutionBrief, previewTaskBrief, MAX_TASK_BODY_BYTES } from '../src/plan/task-brief.js';
import { runContextLoadingStep, runWorktreeReadyStep, type LoopDependencies } from '../src/loop/loop-step.js';
import { resolveRepository } from '../src/repo/resolve-repository.js';
import { startTask } from '../src/run/start-task.js';
import { loadTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import { leaseAuthorityFor, leaseFor, releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, removeRepoFixtures, git, writeRepoFile } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } from './helpers/worktree-fixtures.js';
import { e2eProfile, tickingClock } from './helpers/e2e-fixtures.js';

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

// Real evidence from the real mint; see `helpers/auth-evidence.ts`.
const authPassed = authPreflightPasses;

/** A directory outside any fixture repository, cleaned up with the rest. */
const outsideDirs: string[] = [];
function mkdtempOutside(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ao-outside-'));
  outsideDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (outsideDirs.length > 0) {
    const dir = outsideDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function profileWithContext(sources: readonly string[]): string {
  return e2eProfile().replace(
    '  canonicalSources:\n    - README.md\n',
    `  canonicalSources:\n${sources.map((s) => `    - ${s}`).join('\n')}\n`,
  );
}

function taskFileWith(body: string): string {
  return [
    '---',
    'id: V2-02',
    'title: remediation fixture',
    'status: OPEN',
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: true',
    'dependsOn: []',
    '---',
    body,
  ].join('\n');
}

async function repoWith(
  files: Readonly<Record<string, string>>,
  profile = e2eProfile(),
): Promise<{ repository: ResolvedRepository; root: string }> {
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile,
    files: {
      '.gitignore': '.agent-orchestrator/runtime/\n',
      'tasks/V2-02.md': taskFileWith('Do the thing.'),
      ...files,
    },
  });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return { repository, root };
}

async function startedAt(repository: ResolvedRepository, root: string): Promise<StateLoadSuccess> {
  const started = await startTask(
    { repository, taskId: 'V2-02' },
    { git: runGitCommand, now: tickingClock(), authPreflight: authPassed, lease: leaseFor(repository) },
  );
  expect(started.outcome).toBe('STARTED');
  const loaded = loadTaskState(root, 'V2-02');
  if (!loaded.ok) throw new Error('did not start');
  return loaded;
}

/** Advances a started task to CONTEXT_LOADING so the gate can be exercised. */
async function atContextLoading(repository: ResolvedRepository, root: string) {
  const current = await startedAt(repository, root);
  await runWorktreeReadyStep(current, deps(current, repository));
  const loaded = loadTaskState(root, 'V2-02');
  if (!loaded.ok) throw new Error('unreadable');
  return loaded;
}

function deps(
  current: StateLoadSuccess,
  repository: ResolvedRepository,
  overrides: Partial<LoopDependencies> = {},
): LoopDependencies {
  return {
    now: '2026-08-11T10:00:00.000Z',
    authorisedWorktreePath: current.state.worktreePath,
    verification: repository.verification,
    brief: readExecutionBrief(repository, current.state.taskId, current.state.worktreePath),
    lease: leaseAuthorityFor(repository),
    ...overrides,
  };
}

/* ═══════════ H1 — the promise is about the worktree, not the root ═════════ */

describe('H1 — context is proven in the tree the agent actually opens', () => {
  it('reports MISSING when main has the file and the pinned worktree does not', async () => {
    const { repository, root } = await repoWith({}, profileWithContext(['README.md', 'docs/adr.md']));
    // Started before docs/adr.md exists: the worktree is pinned without it.
    const current = await atContextLoading(repository, root);

    // The repository moves on. The worktree does not.
    writeRepoFile(root, 'docs/adr.md', '# adr\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'add adr']);
    const reresolved = await resolveRepository({ repositoryPath: root });
    expect(reresolved.ok).toBe(true);
    if (!reresolved.ok) return;

    const brief = readExecutionBrief(reresolved.repository, 'V2-02', current.state.worktreePath);
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    // The file exists on main. It does not exist where the writer will look.
    expect(existsSync(join(root, 'docs', 'adr.md'))).toBe(true);
    expect(existsSync(join(current.state.worktreePath, 'docs', 'adr.md'))).toBe(false);
    expect(brief.brief.contextSources).toContainEqual({ path: 'docs/adr.md', status: 'MISSING' });
    expect(brief.brief.contextComplete).toBe(false);

    // And the gate refuses, so no writer is briefed on a false promise.
    const step = await runContextLoadingStep(
      current,
      deps(current, reresolved.repository, {
        brief: readExecutionBrief(reresolved.repository, 'V2-02', current.state.worktreePath),
      }),
    );
    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('stays complete when main deleted the file but the pinned worktree still has it', async () => {
    const { repository, root } = await repoWith({ 'docs/adr.md': '# adr\n' }, profileWithContext(['docs/adr.md']));
    const current = await atContextLoading(repository, root);

    // Deleted on main, after the worktree was pinned.
    rmSync(join(root, 'docs', 'adr.md'));
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'drop adr']);

    const brief = readExecutionBrief(repository, 'V2-02', current.state.worktreePath);
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    // The worktree is the tree that matters, and it still has the file.
    expect(brief.brief.contextComplete).toBe(true);

    const step = await runContextLoadingStep(current, deps(current, repository, { brief }));
    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('IMPLEMENTING');
  });

  it('keeps the plan preview non-authoritative and separately typed', async () => {
    const { repository, root } = await repoWith({}, profileWithContext(['README.md']));
    const current = await atContextLoading(repository, root);

    const preview = previewTaskBrief(repository, 'V2-02');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    // A preview carries no `contextComplete` at all: it cannot be mistaken for
    // an execution verdict, and cannot be handed to the gate.
    expect(preview.preview).not.toHaveProperty('contextComplete');
    expect(preview.preview).toHaveProperty('contextPreview');
    // @ts-expect-error a preview is not an execution brief — this is the point
    const rejected: LoopDependencies['brief'] = preview;
    void rejected;
    void current;
  });
});

/* ═══════════ H2 — no parsing ceiling on a file nobody parses ══════════════ */

describe('H2 — a large but readable context source is PRESENT', () => {
  it('accepts a context source well past the old 256 KiB cap', async () => {
    const big = `# spec\n${'x'.repeat(300_000)}\n`;
    const { repository, root } = await repoWith(
      { 'docs/openapi.md': big },
      profileWithContext(['docs/openapi.md']),
    );
    const current = await atContextLoading(repository, root);

    const brief = readExecutionBrief(repository, 'V2-02', current.state.worktreePath);
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.brief.contextSources).toEqual([{ path: 'docs/openapi.md', status: 'PRESENT' }]);
    expect(brief.brief.contextComplete).toBe(true);

    // Through the gate: the task runs.
    const step = await runContextLoadingStep(current, deps(current, repository, { brief }));
    expect(step.outcome).toBe('ADVANCED');
  });

  it('does not carry the context source contents anywhere', async () => {
    const { repository, root } = await repoWith(
      { 'docs/note.md': 'CANARY-CONTEXT-BYTES\n' },
      profileWithContext(['docs/note.md']),
    );
    const current = await atContextLoading(repository, root);
    const brief = readExecutionBrief(repository, 'V2-02', current.state.worktreePath);
    expect(JSON.stringify(brief)).not.toContain('CANARY-CONTEXT-BYTES');
  });
});

/* ═══════════ H3 — truncation never splits a code point ═══════════════════ */

describe('H3 — the body clamp is a UTF-8 byte contract', () => {
  it('never emits a lone surrogate when an astral character straddles the limit', async () => {
    // Build a body whose byte length crosses MAX_TASK_BODY_BYTES exactly in
    // the middle of a 4-byte emoji.
    const filler = 'a'.repeat(MAX_TASK_BODY_BYTES - 2);
    const body = `${filler}\u{1F600}tail`;
    const { repository } = await repoWith({ 'tasks/V2-02.md': taskFileWith(body) });

    const preview = previewTaskBrief(repository, 'V2-02');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const text = preview.preview.body;
    expect(preview.preview.bodyTruncated).toBe(true);
    // Well-formed: no unpaired surrogate survives, and the round trip through
    // UTF-8 is an identity rather than a lossy replacement.
    expect(/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false);
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
    expect(text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_TASK_BODY_BYTES);
  });

  it('leaves a body inside the budget untouched', async () => {
    const body = 'Ünicode ✅ and an emoji 😀, all well inside the budget.';
    const { repository } = await repoWith({ 'tasks/V2-02.md': taskFileWith(body) });
    const preview = previewTaskBrief(repository, 'V2-02');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.body).toBe(body);
    expect(preview.preview.bodyTruncated).toBe(false);
  });
});

/* ═══════════ M4 — a directory is refused at resolution ═══════════════════ */

describe('M4 — a directory declared as a context source is a configuration error', () => {
  it('is rejected when the repository is resolved, not when a task parks', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWithContext(['docs']),
      files: {
        '.gitignore': '.agent-orchestrator/runtime/\n',
        'tasks/V2-02.md': taskFileWith('Do the thing.'),
        'docs/note.md': '# note\n',
      },
    });

    const resolved = await resolveRepository({ repositoryPath: root });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe('CONTEXT_SOURCE_NOT_REGULAR_FILE');
    // A closed code with a static sentence, carrying no path.
    expect(resolved.detail).not.toMatch(/docs|[\\/]/);
  });

  it('refuses a source under a symlinked parent, not only a symlinked leaf', async () => {
    // The re-review's finding: the first version of this check used a bare
    // `classify`, a single `lstat`. `lstat` does not follow the final
    // component but does follow every parent, so `docs/adr.md` under a
    // symlinked `docs` was classified FILE and resolved — and execution, which
    // runs the full chain, then parked every task in the repository forever.
    // The same misconfiguration answered two ways depending on whether the
    // link was the leaf or one component up.
    const outside = mkdtempOutside();
    writeFileSync(join(outside, 'adr.md'), '# adr\n', 'utf8');

    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWithContext(['docs/adr.md']),
      files: { 'tasks/V2-02.md': taskFileWith('Do the thing.') },
    });
    let linked = true;
    try {
      symlinkSync(outside, join(root, 'docs'), 'junction');
    } catch {
      linked = false;
    }
    if (!linked) return;

    const resolved = await resolveRepository({ repositoryPath: root });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe('CONTEXT_SOURCE_NOT_REGULAR_FILE');
  });

  it('refuses a source that canonicalises outside the repository', async () => {
    const outside = mkdtempOutside();
    writeFileSync(join(outside, 'secret.md'), 'outside\n', 'utf8');

    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWithContext(['secret.md']),
      files: { 'tasks/V2-02.md': taskFileWith('Do the thing.') },
    });
    let linked = true;
    try {
      symlinkSync(join(outside, 'secret.md'), join(root, 'secret.md'), 'file');
    } catch {
      linked = false;
    }
    if (!linked) return;

    const resolved = await resolveRepository({ repositoryPath: root });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe('CONTEXT_SOURCE_NOT_REGULAR_FILE');
  });

  it('still resolves when the declared source does not exist yet', async () => {
    // Absent is not a configuration error — it is an execution-time MISSING.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileWithContext(['docs/not-yet.md']),
      files: { 'tasks/V2-02.md': taskFileWith('Do the thing.') },
    });

    const resolved = await resolveRepository({ repositoryPath: root });
    expect(resolved.ok).toBe(true);
  });
});

/* ═══════════ M6 — one vocabulary for one repository condition ════════════ */

describe('M6 — discovery and the brief agree about an unsafe task source', () => {
  it('both report TASK_SOURCE_PATH_UNSAFE for a symlinked task source', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: e2eProfile(),
      files: { 'real-tasks/V2-02.md': taskFileWith('Do the thing.') },
    });
    let linked = true;
    try {
      symlinkSync(join(root, 'real-tasks'), join(root, 'tasks'), 'junction');
    } catch {
      linked = false;
    }
    if (!linked) return;

    const repository = await resolveFixture(root);
    const { discoverTasks } = await import('../src/plan/discover-tasks.js');
    const discovered = discoverTasks(repository);
    const brief = previewTaskBrief(repository, 'V2-02');

    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.code).toBe('TASK_SOURCE_PATH_UNSAFE');

    expect(brief.ok).toBe(false);
    if (brief.ok) return;
    // The same repository condition, spelled the same way by both readers.
    expect(brief.code).toBe('TASK_SOURCE_PATH_UNSAFE');
  });
});

/* ═══════════ M5 — one owner, proven structurally ═════════════════════════ */

describe('M5 — the safety chain has exactly one implementation', () => {
  it('is not copied into any other module', async () => {
    const { readdirSync, readFileSync: read } = await import('node:fs');
    const srcRoot = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    // The duplication that actually existed was three *definitions* copied
    // verbatim into three modules. Counting `realpathSync` call sites instead
    // would conflate that with "canonicalises a path at all", which whole
    // unrelated subsystems legitimately do — the first version of this test
    // did exactly that and listed the doctor's process plumbing as a copy of
    // the safety chain.
    const definers = files
      .filter((file) =>
        /\bfunction (isContained|samePath|classify)\s*\(/.test(read(file, 'utf8')),
      )
      .map((file) => file.slice(srcRoot.length + 1).split('\\').join('/'))
      .sort();

    // Named, not silently excluded. Three other modules define a same-named
    // helper, and none of them is a copy of *this* chain: `doctor/safe-write`
    // contains a diagnostics artefact inside the per-user run directory, and
    // the two worktree modules compare paths Git printed. They are pre-existing
    // and belong to different security postures; folding them in would be a
    // change to the doctor and worktree subsystems, not this remediation.
    // Listing them here means the next person sees them rather than trusting
    // a claim of "one owner" that was already false once.
    expect(definers).toEqual([
      'doctor/safe-write.ts',
      'repo/internal/contained-file.ts',
      'worktree/workspace-identity.ts',
      'worktree/worktree-registry.ts',
    ]);

    // What matters for this slice: nothing under `plan/` or `repo/` defines
    // its own copy any more. That is where the three copies were.
    expect(definers.filter((f) => f.startsWith('plan/') || f.startsWith('repo/'))).toEqual([
      'repo/internal/contained-file.ts',
    ]);
  });

  it('leaves each caller its own vocabulary', async () => {
    // Sharing the chain must not have flattened the codes. Discovery still
    // distinguishes four facts about a task source where the brief has one.
    const { readFileSync: read } = await import('node:fs');
    const discovery = read(join(import.meta.dirname, '..', 'src', 'plan', 'discover-tasks.ts'), 'utf8');
    for (const code of [
      'TASK_SOURCE_PATH_UNSAFE',
      'TASK_SOURCE_NOT_FOUND',
      'TASK_SOURCE_NOT_DIRECTORY',
      'TASK_SOURCE_READ_FAILED',
    ]) {
      expect(discovery).toContain(code);
    }
  });
});
