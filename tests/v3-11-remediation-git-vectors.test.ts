/**
 * V3-11 remediation: the Git argument vectors, measured rather than assumed.
 *
 * ── What went wrong, and why a suite exists for it ─────────────────────────
 *
 * V3-11 hardened three Git questions against a repository that configures the
 * answer away, and shipped each flag with the sentence "restates the Git
 * default". An independent review of the merged slice found that sentence was
 * **false for two of the three tokens**, and that neither was pinned by a case
 * that could have said so:
 *
 *  - `git diff --ignore-submodules=none` is not the diff default. The default
 *    is `untracked`, so `none` newly reports a submodule carrying nothing but
 *    build output as a modified path — a `SCOPE_VIOLATION` accusing the writer
 *    of work nobody did, and on the quota path a discarded reset instant;
 *  - `git status --untracked-files=all` is not the status default. The default
 *    is `normal`, which collapses an untracked directory to one entry, so `all`
 *    takes an unbounded output dependency on a question whose only consumer
 *    tests `stdout === ''`.
 *
 * Every case here therefore measures **both** halves: the reading the hostile
 * configuration produces, and the reading the shipped vector produces. A test
 * that only asserted the second could not tell hardening from over-reporting,
 * which is exactly how the two defects shipped.
 *
 * ── `.gitmodules`, not `.git/config` ───────────────────────────────────────
 *
 * The threat model is a repository whose own contents change what AO measures,
 * and the writer holds `Write`. `.git/config` is not reachable by it —
 * `acceptEdits` is cwd-confined and `.git` is not a working-tree path — but
 * `.gitmodules` is a **tracked file at the top of the worktree**. So the
 * submodule cases configure `ignore = all` there, which is the reachable half,
 * and is what V3-11's own cases got wrong by using `.git/config`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { observeTaskDelta } from '../src/scope/task-delta.js';
import { commitTaskWork } from '../src/worktree/commit-task-work.js';
import { runGitCommand, WORKTREE_CLEANLINESS_ARGS } from '../src/worktree/git-command.js';
import { createRepoFixture, removeRepoFixtures, git, writeRepoFile } from './helpers/repo-fixtures.js';

const NEWLINE = '\n';

afterAll(() => {
  removeRepoFixtures();
});

/** A repository with one commit and nothing else. */
function repo(): string {
  return createRepoFixture({ defaultBranch: 'main', profile: null });
}

function head(root: string): string {
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/**
 * Adds a populated submodule at `vendor`, commits it, and declares
 * `ignore = all` **in `.gitmodules`** — the tracked file a writer can reach.
 *
 * Returns the commit the submodule was added in, which is the base a delta is
 * measured against. `protocol.file.allow` is a fixture affordance: modern Git
 * refuses a file-protocol submodule by default. It is never on AO's own
 * command line.
 */
function withVendorSubmodule(root: string): string {
  const inner = createRepoFixture({
    defaultBranch: 'main',
    profile: null,
    files: { 'f.txt': `one${NEWLINE}` },
  });
  git(root, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--quiet',
    inner.split('\\').join('/'),
    'vendor',
  ]);
  // The hostile declaration, written into the tracked file at the top of the
  // worktree — the half of this threat model a writer can actually reach.
  git(root, ['config', '-f', '.gitmodules', 'submodule.vendor.ignore', 'all']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'add vendor']);
  return head(root);
}

/* ═══════════ 1. The scope gate's diff: hardened, and not over-reporting ═══ */

describe('the scope gate sees a submodule change the repository hid, and only that', () => {
  it('reports a tracked modification inside a submodule that `ignore = all` hides', async () => {
    const root = repo();
    const base = withVendorSubmodule(root);
    writeFileSync(join(root, 'vendor', 'f.txt'), `two${NEWLINE}`, 'utf8');

    // The premise, measured: Git's own answer under the repository's
    // declaration is that nothing changed.
    expect(git(root, ['diff', '--name-status', '--no-color', base, '--']).trim()).toBe('');

    const delta = await observeTaskDelta(runGitCommand, root, base);
    expect(delta.outcome).toBe('OBSERVED');
    if (delta.outcome !== 'OBSERVED') return;
    expect(delta.paths.map((entry) => entry.path)).toContain('vendor');
  });

  it('reports a moved submodule pointer that `ignore = all` hides', async () => {
    const root = repo();
    const base = withVendorSubmodule(root);
    const vendor = join(root, 'vendor');
    writeFileSync(join(vendor, 'g.txt'), `three${NEWLINE}`, 'utf8');
    git(vendor, ['add', '--all']);
    git(vendor, ['commit', '--quiet', '-m', 'moved']);

    expect(git(root, ['diff', '--name-status', '--no-color', base, '--']).trim()).toBe('');

    const delta = await observeTaskDelta(runGitCommand, root, base);
    expect(delta.outcome).toBe('OBSERVED');
    if (delta.outcome !== 'OBSERVED') return;
    expect(delta.paths.map((entry) => entry.path)).toContain('vendor');
  });

  /**
   * The case V3-11 got wrong, and the reason the value is `untracked` and not
   * `none`. A populated submodule with build output in it is an ordinary state
   * — the target repository's own verification command produces it — and it is
   * not a modification of anything. Under `none` this reports `vendor`,
   * `classifyPath` answers `OUTSIDE_ALLOWED`, and the task is parked with an
   * accusation about work no writer did.
   */
  it('does NOT report a submodule carrying only untracked build output', async () => {
    const root = repo();
    const base = withVendorSubmodule(root);
    mkdirSync(join(root, 'vendor', 'dist'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'dist', 'build.log'), `noise${NEWLINE}`, 'utf8');

    const delta = await observeTaskDelta(runGitCommand, root, base);
    expect(delta.outcome).toBe('OBSERVED');
    if (delta.outcome !== 'OBSERVED') return;
    expect(delta.paths.map((entry) => entry.path)).not.toContain('vendor');
  });

  /**
   * The control that keeps the three cases above honest: the gate still sees
   * ordinary work, so none of them passes because the gate reports nothing.
   */
  it('still reports an ordinary edit in the superproject', async () => {
    const root = repo();
    const base = withVendorSubmodule(root);
    writeRepoFile(root, 'src/work.ts', `export const work = 1;${NEWLINE}`);

    const delta = await observeTaskDelta(runGitCommand, root, base);
    expect(delta.outcome).toBe('OBSERVED');
    if (delta.outcome !== 'OBSERVED') return;
    expect(delta.paths.map((entry) => entry.path)).toContain('src/work.ts');
  });
});

/* ══════ 2. The cleanliness vector: hardened, and bounded in its output ════ */

describe('the cleanliness question overrides the repository and stays bounded', () => {
  it('sees an untracked file that status.showUntrackedFiles=no hides', async () => {
    const root = repo();
    git(root, ['config', 'status.showUntrackedFiles', 'no']);
    writeRepoFile(root, 'appeared.txt', `new${NEWLINE}`);

    expect(git(root, ['status', '--porcelain']).trim()).toBe('');

    const status = await runGitCommand(root, WORKTREE_CLEANLINESS_ARGS);
    expect(status.outcome).toBe('OK');
    expect(status.stdout.trim()).not.toBe('');
  });

  it('sees a submodule modification that `ignore = all` hides', async () => {
    const root = repo();
    withVendorSubmodule(root);
    writeFileSync(join(root, 'vendor', 'f.txt'), `two${NEWLINE}`, 'utf8');

    expect(git(root, ['status', '--porcelain']).trim()).toBe('');

    const status = await runGitCommand(root, WORKTREE_CLEANLINESS_ARGS);
    expect(status.outcome).toBe('OK');
    expect(status.stdout.trim()).not.toBe('');
  });

  /**
   * The bound V3-11 gave up by shipping `--untracked-files=all`.
   *
   * `all` prints one line per file; `normal` collapses an untracked directory
   * to one entry. The only consumers of this vector test `stdout === ''`, so
   * they cannot tell the two apart — but `runGitCommand` caps output at 1 MiB
   * and reports `UNAVAILABLE` past it, at which point cleanliness becomes "not
   * established" and every step of every task in that repository stops for an
   * operator.
   *
   * Six hundred files is far below the real cliff and far above the difference:
   * it is a ~40x output ratio, which no plausible re-wording of the vector
   * produces by accident.
   */
  it('answers a worktree full of untracked files in bounded output', async () => {
    const root = repo();
    const bulk = join(root, 'bulk', 'nested');
    mkdirSync(bulk, { recursive: true });
    for (let index = 0; index < 600; index += 1) {
      writeFileSync(join(bulk, `f${index}.txt`), `x${NEWLINE}`, 'utf8');
    }

    const bounded = await runGitCommand(root, WORKTREE_CLEANLINESS_ARGS);
    expect(bounded.outcome).toBe('OK');
    // The tree is reported dirty — the hardening is intact …
    expect(bounded.stdout.trim()).not.toBe('');
    // … and it took a handful of bytes to say so.
    expect(bounded.stdout.length).toBeLessThan(200);

    // The premise: enumerating would have cost two orders of magnitude more.
    const enumerated = await runGitCommand(root, [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
    expect(enumerated.outcome).toBe('OK');
    expect(enumerated.stdout.length).toBeGreaterThan(bounded.stdout.length * 20);
  });
});

/* ═════════ 3. The commit gate asks the same question as the observers ═════ */

/**
 * V3-11 hardened the two observers of cleanliness and left `commitTaskWork`'s
 * effect gate asking the blind question. Its README even claimed the observer
 * change was "symmetry, not a fix" because `git add --all` would have committed
 * the work anyway — which is false, because `add --all` sits *behind* that gate.
 */
describe('the commit gate is not blinded by the repository it commits in', () => {
  it('commits an all-untracked writer effect that status.showUntrackedFiles=no hides', async () => {
    const root = repo();
    const base = head(root);
    git(root, ['config', 'status.showUntrackedFiles', 'no']);
    writeRepoFile(root, 'src/written.ts', `export const written = 1;${NEWLINE}`);

    // The premise: the bare question this gate used to ask answers "clean".
    expect(git(root, ['status', '--porcelain']).trim()).toBe('');

    const result = await commitTaskWork(runGitCommand, root, {
      taskId: 'V3-11R',
      phase: 'IMPLEMENT',
      round: 1,
      approvedPaths: ['src/written.ts'],
      basePinnedCommit: base,
    });

    expect(result.outcome).toBe('COMMITTED');
    expect(head(root)).not.toBe(base);
    const status = await runGitCommand(root, WORKTREE_CLEANLINESS_ARGS);
    expect(status.stdout.trim()).toBe('');
  });

  /**
   * The control. A pass that really changed nothing must still produce no
   * commit — the hardened gate must not manufacture one, because an empty
   * commit would move HEAD and satisfy the settlement's "did HEAD change"
   * question for a writer that did nothing.
   */
  it('still records nothing for a pass that changed nothing', async () => {
    const root = repo();
    const base = head(root);

    const result = await commitTaskWork(runGitCommand, root, {
      taskId: 'V3-11R',
      phase: 'IMPLEMENT',
      round: 1,
      approvedPaths: [],
      basePinnedCommit: base,
    });

    expect(result.outcome).toBe('NOTHING_TO_COMMIT');
    expect(head(root)).toBe(base);
  });
});
