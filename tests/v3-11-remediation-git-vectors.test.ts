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
 *    took a much larger output dependency on a question none of whose three
 *    consumers does anything but test the output for emptiness.
 *
 * The hardening cases here therefore measure **both** halves: the reading the
 * hostile configuration produces, and the reading the shipped vector produces.
 * A test that only asserted the second could not tell hardening from
 * over-reporting, which is exactly how the two defects shipped. The controls and
 * bound checks do not, and say so where they sit — a control that asserted a
 * hidden reading would be asserting nothing.
 *
 * ── `.gitmodules`, not `.git/config` ───────────────────────────────────────
 *
 * The threat model is a repository whose own contents change what AO measures,
 * and the writer holds `Write`. `.gitmodules` is a **tracked file at the top of
 * the worktree**, so the submodule cases configure `ignore = all` there — the
 * reachable half, and what V3-11's own cases got wrong by using `.git/config`.
 *
 * The *reason* `.git/config` is out of reach is narrower than this comment first
 * stated. It said "`.git` is not a working-tree path", which is false: in a
 * linked worktree `<worktree>/.git` is a plain text file inside the writer's cwd,
 * and a review demonstrated a writer creating `<worktree>/vendor/.git/**` with
 * ordinary writes and changing what `git status` reports (L-V3-11-13). What is
 * true, and measured, is narrower and sufficient: `git config` issued from a
 * linked worktree writes to the shared `<main>/.git/config`, which is outside
 * every worktree.
 */

import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { observeTaskDelta } from '../src/scope/task-delta.js';
import { commitTaskWork } from '../src/worktree/commit-task-work.js';
import {
  runGitCommand,
  WORKTREE_CLEANLINESS_ARGS,
  type GitRunner,
} from '../src/worktree/git-command.js';
import { observeWorktreeCleanliness } from '../src/worktree/worktree-cleanliness.js';
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

    // The premise, measured, and the half this case originally lacked: the
    // shipped-and-wrong `none` *does* report it. Without this the case passes
    // for a fixture that produced no submodule state at all, which is the same
    // blind spot as asserting only a hardened reading — in mirror image.
    expect(
      git(root, ['diff', '--name-status', '--no-color', '--ignore-submodules=none', base, '--']),
    ).toContain('vendor');

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
   * `all` prints one line per file; `normal` collapses an untracked *directory*
   * to one entry. All three consumers of this vector test the output only for
   * emptiness, so none of them can tell the two apart — but `runGitCommand` caps
   * output at 1 MiB and reports `UNAVAILABLE` past it, at which point cleanliness
   * becomes "not established" and every step of the task that owns that worktree
   * stops for an operator.
   *
   * Six hundred files is far below the real cliff (~44,000 at these path
   * lengths) and far above the difference: measured, `all` prints 14,290 bytes
   * where `normal` prints 8 — a **~1,800x** ratio, not the "~40x" this comment
   * first claimed. The assertion below asks for 20x, which is a floor chosen so
   * a re-worded vector cannot pass by accident, not an estimate of the margin.
   *
   * Note what this case does *not* show: `normal` is a smaller constant, not a
   * bound. ~34,000 untracked entries at the top of the worktree still flood the
   * same cap under `normal` — see L-V3-11-9.
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

/* ═══════════ 4. The gitlink a writer can write into unobserved ════════════ */

/**
 * The blind spot the second review found, and the one the argument vectors
 * cannot reach at any value.
 *
 * A submodule that is not populated is a gitlink in the index and an empty
 * directory on disk — the state `git worktree add` and `git clone` both leave,
 * and AO never runs `git submodule update`. A writer holding `Write` can put
 * files there, and every eye AO owns reports nothing: measured, `git status` at
 * all three of its spellings, `git diff` at all four `--ignore-submodules`
 * values, and both `ls-files --others` vectors all answered empty over two
 * planted files.
 *
 * Git is not wrong — the path is a submodule boundary — but AO cannot spend
 * that reading as *cleanliness*, because since V3-11 the reading is what mints
 * `worktreeCleanAtCheckpoint: true` and authorises an unattended relaunch, and
 * the writer can produce the state itself. The blind spot is pre-existing and
 * was equally blind before V3-11; what changed is what the answer buys.
 *
 * Every case below measures **both halves**: what Git's own vector says, and
 * what {@link observeWorktreeCleanliness} says. A case asserting only the
 * second could not tell a closed blind spot from a probe that calls everything
 * dirty.
 */
describe('content planted inside an unpopulated submodule is not a clean worktree', () => {
  /** Adds a populated `vendor`, with no ignore rule: this is not that threat. */
  function withPlainVendor(root: string): void {
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
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'add vendor']);
  }

  /** The state a fresh checkout is in: gitlink present, directory empty. */
  function deinitVendor(root: string): void {
    git(root, ['submodule', 'deinit', '--force', 'vendor']);
  }

  function bareReading(root: string): string {
    return git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim();
  }

  it('reports a repository with no submodule at all as clean', async () => {
    const root = repo();

    expect(bareReading(root)).toBe('');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);
  });

  it('reports an unpopulated submodule with an empty directory as clean', async () => {
    const root = repo();
    withPlainVendor(root);
    deinitVendor(root);

    expect(readdirSync(join(root, 'vendor'))).toEqual([]);
    expect(bareReading(root)).toBe('');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);
  });

  it('reports a file planted in an unpopulated submodule as dirty', async () => {
    const root = repo();
    withPlainVendor(root);
    deinitVendor(root);
    writeFileSync(join(root, 'vendor', 'planted.ts'), `payload${NEWLINE}`, 'utf8');

    // The premise, measured: Git's own cleanliness vector — the hardened one,
    // carrying both corrected tokens — sees nothing at all.
    expect(bareReading(root)).toBe('');

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  it('reports a nested directory planted in an unpopulated submodule as dirty', async () => {
    const root = repo();
    withPlainVendor(root);
    deinitVendor(root);
    mkdirSync(join(root, 'vendor', 'deep'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'deep', 'planted.ts'), `payload${NEWLINE}`, 'utf8');

    expect(bareReading(root)).toBe('');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  /**
   * The control that stops the probe from being a blanket refusal. A populated
   * submodule is full of files and is *clean*, and calling it dirty would make
   * every repository with a submodule permanently attended-only.
   */
  it('reports a populated, clean submodule as clean', async () => {
    const root = repo();
    withPlainVendor(root);

    expect(readdirSync(join(root, 'vendor')).length).toBeGreaterThan(0);
    expect(bareReading(root)).toBe('');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);
  });

  /**
   * The other control: a populated submodule that really is dirty was already
   * visible to `git status` through `--ignore-submodules=none`, and must stay
   * visible. If this fails, the probe has replaced the vector instead of
   * standing beside it.
   */
  it('reports a populated, dirty submodule as dirty, as the vector already did', async () => {
    const root = repo();
    withPlainVendor(root);
    writeFileSync(join(root, 'vendor', 'f.txt'), `two${NEWLINE}`, 'utf8');

    expect(bareReading(root)).toBe('M vendor');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  /**
   * The evasion, and where it dies.
   *
   * A writer that plants a `.git` beside its payload is trying to look like an
   * active checkout so the probe defers to `git status`. It never reaches the
   * probe: Git itself exits 128 on the malformed gitdir, the seam reports a
   * non-`OK` outcome, and cleanliness is **not established** — which is
   * `UNOBSERVABLE`, which is an operator. Fail-closed, and by a guard that was
   * already there.
   */
  it('reports cleanliness as not established when the gitlink is unreadable', async () => {
    const root = repo();
    withPlainVendor(root);
    deinitVendor(root);
    writeFileSync(join(root, 'vendor', 'planted.ts'), `payload${NEWLINE}`, 'utf8');
    mkdirSync(join(root, 'vendor', '.git'), { recursive: true });
    writeFileSync(join(root, 'vendor', '.git', 'placeholder'), `x${NEWLINE}`, 'utf8');

    const raw = await runGitCommand(root, WORKTREE_CLEANLINESS_ARGS);
    expect(raw.outcome).not.toBe('OK');

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBeNull();
  });
});

/* ═══ 4b. Repository shapes the first probe design refused to observe ══════ */

/**
 * Three ordinary shapes, and what they cost before the fallback existed.
 *
 * The first version of this probe read gitlinks only from `git submodule
 * status`, on the stated ground that it "reads the **index**, not
 * `.gitmodules`". Two cited measurements were true and the generalisation was
 * false. A review measured three shapes in which it answered **not
 * established** — which is `WORKTREE_CLEANLINESS_UNKNOWN`, which is
 * `UNOBSERVABLE`, which stops every step of every task in that repository
 * forever, over a tree that is genuinely clean:
 *
 *  - a submodule path carrying a space or a non-ASCII character. Both are
 *    ordinary names; `doctor/exec.ts`'s `SAFE_ARG_PATTERN` refuses to carry
 *    them as an argument, so the per-path index confirmation could not be made;
 *  - an **embedded repository** with no `.gitmodules` mapping — the everyday
 *    `git add -A` accident, which Git itself warns about — where
 *    `git submodule status` exits 128 rather than listing it;
 *  - a SHA-256 repository, whose object names are 64 hex characters and not 40.
 *
 * Each case asserts the ordinary tree is **clean** and that the same tree with
 * one planted file is **dirty**. The second half is what stops the fix being
 * "answer clean whenever unsure", which would close the availability hole by
 * reopening the safety one.
 */
describe('the gitlink probe answers for repository shapes its first design refused', () => {
  function innerRepo(): string {
    return createRepoFixture({
      defaultBranch: 'main',
      profile: null,
      files: { 'f.txt': `one${NEWLINE}` },
    });
  }

  /** Adds a populated submodule at `path`, then empties it. */
  function withDeinitialisedSubmoduleAt(root: string, path: string): void {
    git(root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      innerRepo().split('\\').join('/'),
      path,
    ]);
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'add submodule']);
    git(root, ['submodule', 'deinit', '--force', path]);
  }

  it.each([
    ['a space', 'third party'],
    ['a non-ASCII character', 'bücher'],
  ])('answers for a submodule path containing %s', async (_label, path) => {
    const root = repo();
    withDeinitialisedSubmoduleAt(root, path);

    expect(git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim()).toBe('');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);

    writeFileSync(join(root, path, 'planted.ts'), `payload${NEWLINE}`, 'utf8');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  it('answers for an embedded repository that `.gitmodules` never mapped', async () => {
    const root = repo();
    const inner = innerRepo();
    mkdirSync(join(root, 'tools'), { recursive: true });
    cpSync(inner, join(root, 'tools', 'embedded'), { recursive: true });
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'embed']);

    // The premise, measured: Git records the gitlink and refuses to describe it.
    expect(git(root, ['ls-files', '--stage', '--', 'tools/embedded'])).toContain('160000');
    expect(git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim()).toBe('');

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);

    git(root, ['submodule', 'deinit', '--force', '--all']);
    rmSync(join(root, 'tools', 'embedded'), { recursive: true, force: true });
    mkdirSync(join(root, 'tools', 'embedded'), { recursive: true });
    writeFileSync(join(root, 'tools', 'embedded', 'planted.ts'), `payload${NEWLINE}`, 'utf8');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  it('answers for a SHA-256 repository, whose object names are not forty characters', async () => {
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: null,
      objectFormat: 'sha256',
    });
    const inner = createRepoFixture({
      defaultBranch: 'main',
      profile: null,
      objectFormat: 'sha256',
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
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'add vendor']);

    // The premise, measured: the object name really is 64 characters.
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toHaveLength(64);
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);

    git(root, ['submodule', 'deinit', '--force', 'vendor']);
    writeFileSync(join(root, 'vendor', 'planted.ts'), `payload${NEWLINE}`, 'utf8');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });
});


/* ══════ 5. The probe's own failure arms, which real Git will not produce ══ */

/**
 * A stubbed runner, because these are the arms where **Git itself misbehaves**
 * and real Git will not misbehave on demand.
 *
 * This is a combination, not a substitution: the sections above drive the same
 * function against real repositories and prove the commands run and mean what
 * this module thinks they mean. What a stub adds is the classification of
 * outputs that cannot be produced to order.
 *
 * The probe has **two** sources for the gitlink set, and the distinction these
 * cases exist to pin is which failures fall back and which refuse:
 *
 *  - `submodule status` unreadable, or a line in it unparsable, or a path this
 *    seam cannot carry as an argument → **fall back to the index**. Nothing was
 *    contradicted; one source is unavailable and the other needs no pathspec.
 *    This is the arm that stopped three ordinary repository shapes from
 *    stalling forever.
 *  - the index **contradicting** the listing about a path, or the index itself
 *    unreadable → **not established**. A disagreement is not something this
 *    module may resolve by picking a side, and "clean" is never the answer to a
 *    question that could not be asked.
 */
describe('the gitlink probe falls back to the index, and refuses when neither source answers', () => {
  const CLEAN = Object.freeze({ outcome: 'OK' as const, stdout: '', stderr: '', exitCode: 0 });
  const UNAVAILABLE = Object.freeze({
    outcome: 'UNAVAILABLE' as const,
    stdout: '',
    stderr: '',
    exitCode: null,
  });
  const SHA = 'bc04a7e93f5e27eaa8518f9721f5838254e14cbb';

  /**
   * Answers `status` clean, then whatever the case wants — separately for the
   * pathspec-bounded confirmation (`ls-files … -- <path>`) and the whole-index
   * fallback (`ls-files --stage -z`), because the two are different questions
   * and a stub that conflated them could not tell which arm fired.
   */
  function runner(replies: {
    readonly submodule?: Record<string, unknown>;
    readonly confirm?: Record<string, unknown>;
    readonly index?: Record<string, unknown>;
  }): GitRunner & { readonly asked: string[][] } {
    const asked: string[][] = [];
    const git = (async (_cwd, args) => {
      asked.push([...args]);
      if (args[0] === 'status') return CLEAN as never;
      if (args[0] === 'submodule') return (replies.submodule ?? CLEAN) as never;
      if (args[0] === 'ls-files') {
        return (args.includes('--') ? (replies.confirm ?? CLEAN) : (replies.index ?? CLEAN)) as never;
      }
      return CLEAN as never;
    }) as GitRunner;
    return Object.assign(git, { asked });
  }

  it('falls back to the index when a submodule-status line does not parse', async () => {
    const git = runner({
      submodule: { ...CLEAN, stdout: 'something else entirely' },
      index: { ...CLEAN, stdout: `160000 ${SHA} 0\tvendor\0` },
    });

    // The path does not exist on this synthetic root, so an answer at all
    // proves the index was consulted rather than the listing guessed at.
    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBe(true);
    expect(git.asked.some((args) => args[0] === 'ls-files' && !args.includes('--'))).toBe(true);
  });

  it('falls back to the index when the submodule listing cannot be read', async () => {
    const git = runner({
      submodule: UNAVAILABLE,
      index: { ...CLEAN, stdout: `160000 ${SHA} 0\tvendor\0` },
    });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBe(true);
    expect(git.asked.some((args) => args[0] === 'ls-files' && !args.includes('--'))).toBe(true);
  });

  it('falls back to the index for a path this seam cannot carry as an argument', async () => {
    const git = runner({
      submodule: { ...CLEAN, stdout: `-${SHA} third party` },
      index: { ...CLEAN, stdout: `160000 ${SHA} 0\tthird party\0` },
    });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBe(true);
    // And it never put the unsafe path on a command line.
    expect(git.asked.some((args) => args.includes('third party'))).toBe(false);
  });

  it('reports not established when the index contradicts the listing', async () => {
    const git = runner({
      submodule: { ...CLEAN, stdout: `-${SHA} vendor` },
      // A tracked *file*, not a gitlink: mode 100644.
      confirm: { ...CLEAN, stdout: `100644 ${SHA} 0\tvendor\0` },
    });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBeNull();
  });

  /**
   * An unreadable *confirmation* is a question that could not be put, not an
   * answer about the worktree — so it takes the index, which needs no pathspec
   * and is the authority for gitlinks anyway. Only a **contradiction** refuses.
   */
  it('falls back to the index when the confirmation cannot be read', async () => {
    const git = runner({
      submodule: { ...CLEAN, stdout: `-${SHA} vendor` },
      confirm: UNAVAILABLE,
      index: { ...CLEAN, stdout: `160000 ${SHA} 0\tvendor\0` },
    });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBe(true);
    expect(git.asked.some((args) => args[0] === 'ls-files' && !args.includes('--'))).toBe(true);
  });

  it('reports not established when the confirmation and the index both fail', async () => {
    const git = runner({
      submodule: { ...CLEAN, stdout: `-${SHA} vendor` },
      confirm: UNAVAILABLE,
      index: UNAVAILABLE,
    });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBeNull();
  });

  /**
   * The confirmation asks about **every** listed path in one call, not one call
   * per path. A first version looped: thirty unpopulated gitlinks in a clean
   * tree cost thirty-two subprocesses and ~3.5 seconds per cleanliness reading,
   * under a comment calling it "one bounded observation".
   */
  it('confirms every listed path in a single call', async () => {
    const paths = Array.from({ length: 8 }, (_, index) => `vendor${index}`);
    const git = runner({
      submodule: { ...CLEAN, stdout: paths.map((path) => `-${SHA} ${path}`).join('\n') },
      confirm: {
        ...CLEAN,
        stdout: paths.map((path) => `160000 ${SHA} 0\t${path}\0`).join(''),
      },
    });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere', () => [])).toBe(true);

    const calls = git.asked.filter((args) => args[0] === 'ls-files');
    expect(calls).toHaveLength(1);
    // And every path is *in* that call. Asserting the call count alone was not
    // enough: a mutant that sent only the first path kept the count at one and
    // the suite green, because a stub answers about paths it was never asked
    // for. The argv is the only place the batching is observable.
    const argv = calls[0] ?? [];
    for (const path of paths) expect(argv).toContain(path);
  });

  it('reports not established when neither source answers', async () => {
    const git = runner({ submodule: UNAVAILABLE, index: UNAVAILABLE });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBeNull();
  });

  it('reports not established when an index entry has no path separator', async () => {
    const git = runner({
      submodule: UNAVAILABLE,
      index: { ...CLEAN, stdout: `160000 ${SHA} 0 vendor\0` },
    });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBeNull();
  });

  /**
   * The control, and it has to be a real one: the listing carries the `-` flag,
   * so the confirmation is actually issued. An earlier version of this case used
   * an in-sync listing, which skips the confirmation entirely — its `ls-files`
   * fixture was dead, and it would have passed with the confirmation deleted.
   */
  it('reports clean when the listing parses and the index confirms it', async () => {
    const git = runner({
      submodule: { ...CLEAN, stdout: `-${SHA} vendor` },
      confirm: { ...CLEAN, stdout: `160000 ${SHA} 0\tvendor\0` },
    });

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere')).toBe(true);
    expect(git.asked.some((args) => args[0] === 'ls-files' && args.includes('--'))).toBe(true);
  });
});

/* ═══ 6. Two arms real Git will not produce, and one it produces rarely ════ */

describe('the gitlink probe refuses an unreadable directory and parses long object names', () => {
  const CLEAN = Object.freeze({ outcome: 'OK' as const, stdout: '', stderr: '', exitCode: 0 });
  const SHA1 = 'bc04a7e93f5e27eaa8518f9721f5838254e14cbb';
  const SHA256 = 'a'.repeat(64);

  function runner(submoduleStdout: string): GitRunner & { readonly asked: string[][] } {
    const asked: string[][] = [];
    const git = (async (_cwd, args) => {
      asked.push([...args]);
      if (args[0] === 'submodule') return { ...CLEAN, stdout: submoduleStdout } as never;
      if (args[0] === 'ls-files' && args.includes('--')) {
        return { ...CLEAN, stdout: `160000 ${SHA1} 0\tvendor\0` } as never;
      }
      return CLEAN as never;
    }) as GitRunner;
    return Object.assign(git, { asked });
  }

  /**
   * A directory that exists and cannot be listed is **not established**, never
   * clean. Absent is `[]` and is genuinely clean; unreadable is ignorance, and
   * ignorance on this path becomes `worktreeCleanAtCheckpoint`.
   *
   * Driven through the injected reader because a filesystem cannot be asked to
   * fail on demand portably. Every other case in this file uses the real one.
   */
  it('reports not established when a gitlink directory cannot be listed', async () => {
    const git = runner(`-${SHA1} vendor`);

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere', () => null)).toBeNull();
  });

  /** The control: the same shape with a readable, empty directory is clean. */
  it('reports clean when that directory is readable and empty', async () => {
    const git = runner(`-${SHA1} vendor`);

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere', () => [])).toBe(true);
  });

  /**
   * A 64-character object name is parsed by the primary source rather than
   * sending the probe to the index.
   *
   * The fallback makes the widened pattern unnecessary for *correctness* — a
   * mutation run proved that, by narrowing the pattern back to forty characters
   * and watching the SHA-256 repository still get the right answer through
   * `ls-files`. It is not unnecessary for *cost*: the fallback reads one line per
   * tracked file. So what this case pins is that the fallback is not taken.
   */
  it('parses a sixty-four character object name without falling back to the index', async () => {
    const git = runner(`-${SHA256} vendor`);

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere', () => [])).toBe(true);
    expect(git.asked.some((args) => args[0] === 'ls-files' && !args.includes('--'))).toBe(false);
  });
});

/* ═════ 7. One gitlink must never answer for another ═══════════════════════ */

/**
 * The defect this section exists for was introduced by the fix for the previous
 * one, which is why it gets its own section rather than a case.
 *
 * A first attempt at reading `git submodule status` stripped a trailing ` (…)`
 * from every path by **shape**, on the true observation that Git appends a
 * `(describe)` suffix for a checked-out submodule. Applied to an *unpopulated*
 * line, that rewrites a path Git had just given verbatim. Two ordinary gitlinks
 * — two plain `git submodule add` calls, no fabrication, no hostile
 * configuration — collapse to one:
 *
 *     -f0cdac1… vendor
 *     -f0cdac1… vendor (old)
 *
 * Both became `vendor`. The index confirmed `vendor` twice, `vendor (old)` was
 * never read, and the probe answered **clean** over a planted file — the same
 * data loss the probe had just been wired into the removal gate to prevent.
 *
 * Two guards now stand against the whole class: only `-` lines are taken from
 * the listing, and they are taken exactly; and the index confirmation must find
 * a gitlink **at that exact path**, not merely somewhere in the result.
 */
describe('a gitlink whose path is a prefix of another is not answered for by it', () => {
  function twoGitlinks(root: string): void {
    const inner = createRepoFixture({
      defaultBranch: 'main',
      profile: null,
      files: { 'f.txt': `one${NEWLINE}` },
    });
    for (const path of ['vendor', 'vendor (old)']) {
      git(root, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--quiet',
        inner.split('\\').join('/'),
        path,
      ]);
    }
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'two submodules']);
    git(root, ['submodule', 'deinit', '--force', '--all']);
  }

  it('reports a file planted in the longer path as dirty', async () => {
    const root = repo();
    twoGitlinks(root);

    // The premise, measured twice over: Git lists both paths, and every vector
    // AO owns is blind to what is in the second one.
    expect(git(root, ['submodule', 'status'])).toContain('vendor (old)');
    mkdirSync(join(root, 'vendor (old)'), { recursive: true });
    writeFileSync(join(root, 'vendor (old)', 'planted.ts'), `payload${NEWLINE}`, 'utf8');
    expect(git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim()).toBe('');
    expect(git(root, ['ls-files', '--others', '--exclude-standard']).trim()).toBe('');

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  /**
   * The control, and it is what stops the case above passing because the probe
   * now calls every two-submodule repository dirty.
   */
  it('reports the same two gitlinks as clean when neither holds anything', async () => {
    const root = repo();
    twoGitlinks(root);

    expect(git(root, ['submodule', 'status'])).toContain('vendor (old)');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);
  });

  /**
   * And the shorter path still answers for itself: a planted file in `vendor`
   * is dirty too, so neither case above depends on which of the two was read.
   */
  it('reports a file planted in the shorter path as dirty', async () => {
    const root = repo();
    twoGitlinks(root);
    mkdirSync(join(root, 'vendor'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'planted.ts'), `payload${NEWLINE}`, 'utf8');

    expect(git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim()).toBe('');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });
});

/* ═══════ 8. What the two narrowing guards buy, since it is not the answer ══ */

/**
 * Two guards in the probe are **equivalent for correctness** and are kept
 * anyway. Mutation runs proved that: removing either leaves every case above
 * green, because the index fallback reaches the right answer by a longer route.
 * Rather than delete them or leave them unpinned, these cases assert what they
 * really buy.
 */
describe('the probe stays on its bounded route, and refuses a substituted path', () => {
  /** Records what a real run asks Git, without changing any answer. */
  function spy(): GitRunner & { readonly asked: string[][] } {
    const asked: string[][] = [];
    const git = (async (cwd, args) => {
      asked.push([...args]);
      return await runGitCommand(cwd, args);
    }) as GitRunner;
    return Object.assign(git, { asked });
  }

  /**
   * Taking only the `-` lines is what keeps an ordinary repository on the
   * bounded pathspec route.
   *
   * Without it, a populated line arrives carrying its ` (describe)` suffix,
   * which is never a path this seam will carry as an argument — so every
   * cleanliness reading in every repository with a checked-out submodule falls
   * back to `ls-files --stage` over the **whole index**, one line per tracked
   * file. The answer stays right; the 1 MiB cliff this remediation removed comes
   * back on the ordinary path.
   */
  it('reads an ordinary populated repository without enumerating the index', async () => {
    const root = repo();
    withVendorSubmodule(root);
    const git = spy();

    expect(await observeWorktreeCleanliness(git, root)).toBe(true);
    expect(git.asked.some((args) => args[0] === 'ls-files' && !args.includes('--'))).toBe(false);
  });

  /**
   * The confirmation must find a gitlink **at the path it asked about**.
   *
   * Matching the mode alone would let a result describing some *other* gitlink
   * answer for this one — which is precisely how a rewritten path went unnoticed
   * until a review built two submodules whose names share a prefix. The flag
   * fix stops the rewrite; this stops the class.
   */
  it('reports not established when the index answers about a different path', async () => {
    const CLEAN = { outcome: 'OK' as const, stdout: '', stderr: '', exitCode: 0 };
    const SHA = 'bc04a7e93f5e27eaa8518f9721f5838254e14cbb';
    const git = (async (_cwd, args) => {
      if (args[0] === 'status') return CLEAN as never;
      if (args[0] === 'submodule') return { ...CLEAN, stdout: `-${SHA} vendor` } as never;
      if (args[0] === 'ls-files' && args.includes('--')) {
        // A gitlink, and not the one that was asked about.
        return { ...CLEAN, stdout: `160000 ${SHA} 0\tsomewhere-else\0` } as never;
      }
      return CLEAN as never;
    }) as GitRunner;

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere', () => [])).toBeNull();
  });
});

/* ═══ 9. A path Git printed, and the seam shortened before this module saw it ═ */

/**
 * The fourth repetition of one defect, and the first one this module did not
 * cause itself.
 *
 * `runGitCommand` trims the whole of a command's stdout. `git submodule status`
 * prints paths verbatim, so a **final** gitlink whose path ends in whitespace Git
 * is happy to print — U+00A0, U+3000, U+2009, U+FEFF, anything in ECMAScript's
 * WhiteSpace set — arrives here already shortened. When the shortened form
 * matches a sibling gitlink, two lines become one path: the confirmation goes out
 * as `-- vendnb vendnb`, the second directory is never read, and the probe
 * answers **clean** over whatever is in it.
 *
 * Measured end to end before the fix: `observeWorktreeCleanliness` returned
 * `true` and the unforced `git worktree remove` behind it exited 0 and deleted
 * the payload.
 *
 * Two `-` lines can never legitimately name one path — an index cannot hold two
 * gitlinks in one place — so a duplicate is proof that something upstream
 * rewrote a path. The probe then takes the index, which is NUL-separated and
 * immune to the trim, and gets the right answer rather than merely refusing.
 *
 * A *lone* mangled path needs no rule: it fails its own confirmation and is
 * `CONTRADICTED` already. Only a collision is silent.
 */
describe('a gitlink path the seam shortened does not answer for its sibling', () => {
  const NBSP = '\u00A0';

  function twoGitlinksDifferingByTrailingNbsp(root: string): void {
    const inner = createRepoFixture({
      defaultBranch: 'main',
      profile: null,
      files: { 'f.txt': `one${NEWLINE}` },
    });
    for (const path of ['vendnb', `vendnb${NBSP}`]) {
      git(root, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--quiet',
        inner.split('\\').join('/'),
        path,
      ]);
    }
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'two submodules']);
    git(root, ['submodule', 'deinit', '--force', '--all']);
  }

  it('reports a file planted behind the shortened path as dirty', async () => {
    const root = repo();
    twoGitlinksDifferingByTrailingNbsp(root);

    // The premise, in two halves. Git lists both paths...
    expect(git(root, ['submodule', 'status']).split('\n').filter((line) => line !== '')).toHaveLength(
      2,
    );
    // ...and the seam hands this module two identical ones, which is the defect.
    const listing = await runGitCommand(root, ['submodule', 'status']);
    expect(listing.outcome).toBe('OK');
    expect(listing.stdout.endsWith(NBSP)).toBe(false);

    mkdirSync(join(root, `vendnb${NBSP}`), { recursive: true });
    writeFileSync(join(root, `vendnb${NBSP}`, 'planted.ts'), `payload${NEWLINE}`, 'utf8');
    expect(git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim()).toBe('');

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  it('reports the same two gitlinks as clean when neither holds anything', async () => {
    const root = repo();
    twoGitlinksDifferingByTrailingNbsp(root);

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);
  });
});

/* ═══════ 10. The confirmation's argv is bounded, not merely batched ═══════ */

/**
 * An unbounded loop and an unbounded argv are the same defect in different
 * clothes, and this probe has now shipped both.
 *
 * The first shape issued one `ls-files` per gitlink: thirty cost thirty-two
 * subprocesses. The fix put every path on one command line, and a review measured
 * that refused past ~32,700 characters — whereupon the probe fell back to reading
 * the whole index, which on a large repository floods the 1 MiB cap and answers
 * "not established" for a **clean** tree. The loop had answered it correctly.
 *
 * So the property worth pinning is not "one call" and not "few calls": it is that
 * **no single call's arguments can grow without bound**, and that a repository
 * large enough to need several still gets an answer.
 */
describe('the index confirmation chunks its pathspec instead of growing one call', () => {
  const SHA = 'b'.repeat(40);
  const CLEAN = Object.freeze({ outcome: 'OK' as const, stdout: '', stderr: '', exitCode: 0 });

  /** Refuses past the measured platform ceiling, exactly as `runCommand` does. */
  function ceilingRunner(paths: readonly string[]): GitRunner & { readonly argv: string[][] } {
    const argv: string[][] = [];
    const git = (async (_cwd, args) => {
      if (args[0] === 'status') return CLEAN as never;
      if (args[0] === 'submodule') {
        return { ...CLEAN, stdout: paths.map((path) => `-${SHA} ${path}`).join('\n') } as never;
      }
      argv.push([...args]);
      if (args.join(' ').length > 32_700) {
        return { outcome: 'UNAVAILABLE', stdout: '', stderr: '', exitCode: null } as never;
      }
      const asked = args.slice(args.indexOf('--') + 1);
      return {
        ...CLEAN,
        stdout: asked.map((path) => `160000 ${SHA} 0\t${path}\0`).join(''),
      } as never;
    }) as GitRunner;
    return Object.assign(git, { argv });
  }

  it.each([[30], [800], [1600], [5000]])(
    'answers for %i gitlinks without any call exceeding the ceiling',
    async (count) => {
      const paths = Array.from(
        { length: count },
        (_, index) => `vendor${String(index).padStart(6, '0')}aaaaaaaaaaa`,
      );
      const git = ceilingRunner(paths);

      expect(await observeWorktreeCleanliness(git, 'C:/nowhere', () => [])).toBe(true);

      // Every confirmation call fits, and none of them is the whole-index read —
      // reaching that fallback here would mean the chunking failed.
      for (const args of git.argv) {
        expect(args.join(' ').length).toBeLessThan(32_700);
        expect(args).toContain('--');
      }
    },
  );

  /**
   * The control: with the ceiling removed the answer is the same, so the cases
   * above are not passing because the stub is lenient.
   */
  it('answers the same for a count that fits in one call', async () => {
    const paths = ['vendor-a', 'vendor-b'];
    const git = ceilingRunner(paths);

    expect(await observeWorktreeCleanliness(git, 'C:/nowhere', () => [])).toBe(true);
    expect(git.argv).toHaveLength(1);
  });
});

/* ═══ 11. The two rewrites, pinned where the duplicate guard cannot mask them ═ */

/**
 * The duplicate guard is a backstop, and a backstop hides what it protects.
 *
 * Both path-rewriting defects this module has shipped — stripping a
 * ` (describe)` suffix by shape, and `trimEnd()` eating trailing Unicode
 * whitespace — produce a **collision** in the fixtures that first exposed them,
 * and a collision now falls back to the index and gets the right answer anyway.
 * So a mutation run reported both rewrites as survivors: the suite could no
 * longer tell them from the correct code.
 *
 * These two cases remove the collision. One gitlink whose path ends in `)`, and
 * one whose path ends in U+00A0 with a sibling that does **not** collide with its
 * shortened form. A rewrite then asks the index about a path that is not a
 * gitlink, which is `CONTRADICTED`, which is "not established" — so the
 * distinction the suite must be able to make is `false` versus `null`.
 */
describe('a rewritten path is not merely caught by the duplicate guard', () => {
  const NBSP = '\u00A0';

  function submodulesAt(root: string, paths: readonly string[]): void {
    const inner = createRepoFixture({
      defaultBranch: 'main',
      profile: null,
      files: { 'f.txt': `one${NEWLINE}` },
    });
    for (const path of paths) {
      git(root, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--quiet',
        inner.split('\\').join('/'),
        path,
      ]);
    }
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'submodules']);
    git(root, ['submodule', 'deinit', '--force', '--all']);
  }

  /**
   * A lone submodule whose path ends in `)`. Nothing collides with `vendor`,
   * so stripping the suffix by shape produces a path the index does not hold.
   */
  it('reports a file planted in a path ending in a parenthesis as dirty', async () => {
    const root = repo();
    submodulesAt(root, ['vendor (old)']);
    mkdirSync(join(root, 'vendor (old)'), { recursive: true });
    writeFileSync(join(root, 'vendor (old)', 'planted.ts'), `payload${NEWLINE}`, 'utf8');

    expect(git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim()).toBe('');
    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  /**
   * A submodule whose path ends in U+00A0, ordered so it is **not** the last
   * line — the seam only shortens the last one — beside a sibling that does not
   * collide with its shortened form.
   */
  it('reports a file planted in a path ending in a no-break space as dirty', async () => {
    const root = repo();
    submodulesAt(root, [`vendnb${NBSP}`, 'zzz']);

    const listing = await runGitCommand(root, ['submodule', 'status']);
    expect(listing.outcome).toBe('OK');
    // The premise: this path is intact when it reaches the parser, so only the
    // parser can shorten it.
    expect(listing.stdout).toContain(`vendnb${NBSP}`);

    mkdirSync(join(root, `vendnb${NBSP}`), { recursive: true });
    writeFileSync(join(root, `vendnb${NBSP}`, 'planted.ts'), `payload${NEWLINE}`, 'utf8');
    expect(git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim()).toBe('');

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  /** The control for both: the same shapes, empty, are clean. */
  it('reports both shapes as clean when neither holds anything', async () => {
    const parens = repo();
    submodulesAt(parens, ['vendor (old)']);
    expect(await observeWorktreeCleanliness(runGitCommand, parens)).toBe(true);

    const nbsp = repo();
    submodulesAt(nbsp, [`vendnb${NBSP}`, 'zzz']);
    expect(await observeWorktreeCleanliness(runGitCommand, nbsp)).toBe(true);
  });
});

/* ═════════ 12. The call count, because the comment states one ═════════════ */

/**
 * The module's headline says "three Git calls for any ordinary repository", and
 * both previous shapes of that sentence were false — first one call per gitlink,
 * then one unbounded call. A sentence about cost that nothing checks is how both
 * shipped.
 */
describe('the probe costs what its comment says it costs', () => {
  /**
   * A **populated** submodule costs two, not three: the `-`-only filter empties
   * the path set before the confirmation is reached. The comment first said
   * "three for any ordinary repository" and this case is what measured it wrong.
   */
  it('answers a repository whose submodule is populated in two Git calls', async () => {
    const root = repo();
    withVendorSubmodule(root);
    const asked: string[][] = [];
    const git: GitRunner = async (cwd, args) => {
      asked.push([...args]);
      return await runGitCommand(cwd, args);
    };

    expect(await observeWorktreeCleanliness(git, root)).toBe(true);
    expect(asked).toHaveLength(2);
  });

  /** An **unpopulated** one costs the third call, and only then. */
  it('answers a repository whose gitlink is unpopulated in three Git calls', async () => {
    const root = repo();
    withVendorSubmodule(root);
    git(root, ['submodule', 'deinit', '--force', 'vendor']);
    const asked: string[][] = [];
    const runner: GitRunner = async (cwd, args) => {
      asked.push([...args]);
      return await runGitCommand(cwd, args);
    };

    expect(await observeWorktreeCleanliness(runner, root)).toBe(true);
    expect(asked).toHaveLength(3);
  });

  it('answers a repository with no submodule at all in two', async () => {
    const root = repo();
    const asked: string[][] = [];
    const git: GitRunner = async (cwd, args) => {
      asked.push([...args]);
      return await runGitCommand(cwd, args);
    };

    expect(await observeWorktreeCleanliness(git, root)).toBe(true);
    expect(asked).toHaveLength(2);
  });

  /**
   * And it never pays for the probe at all when `git status` already answered:
   * a dirty tree short-circuits, because the probe can only turn `true` into
   * `false` and never the other way.
   */
  it('does not probe a tree Git already called dirty', async () => {
    const root = repo();
    withVendorSubmodule(root);
    writeRepoFile(root, 'dirty.txt', `x${NEWLINE}`);
    const asked: string[][] = [];
    const git: GitRunner = async (cwd, args) => {
      asked.push([...args]);
      return await runGitCommand(cwd, args);
    };

    expect(await observeWorktreeCleanliness(git, root)).toBe(false);
    expect(asked).toHaveLength(1);
  });
});

/* ═══ 13. The trim is upstream, so the fix has to be too ═══════════════════ */

/**
 * The fifth instance of one defect, and the one that finally located its cause.
 *
 * `runGitCommand` returns `stdout.trim()`, which removes every trailing
 * whitespace character and not merely the line terminator. `git submodule
 * status` prints paths verbatim, so a **final** gitlink whose path ends in
 * U+00A0 arrives at this module already shortened.
 *
 * Round six answered that by *detecting* the collapse: two `-` lines naming one
 * path proves a rewrite, so fall back to the index. That guard runs on the list
 * **after** the `-`-only filter, and so it cannot see the case where the
 * shortened path collides with a **populated** sibling — the populated line is
 * already gone. Measured at that HEAD: `vendnb` populated, `vendnb `
 * unpopulated and holding a planted file, probe answered `true` in three calls,
 * having confirmed and skipped `vendnb` twice.
 *
 * So the parser reads `rawStdout`. The intact path then fails
 * `isShellInertArgument`, the confirmation answers `UNUSABLE_PATH`, and the
 * probe takes the NUL-separated index, which no trim can shorten. Detecting an
 * upstream rewrite four different ways was never going to be as good as not
 * having one.
 */
describe('a gitlink path is read as Git wrote it, not as the seam trimmed it', () => {
  const NBSP = '\u00A0';

  function nbspSiblingWithOnePopulated(root: string): void {
    const inner = createRepoFixture({
      defaultBranch: 'main',
      profile: null,
      files: { 'f.txt': `one${NEWLINE}` },
    });
    for (const path of ['vendnb', `vendnb${NBSP}`]) {
      git(root, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--quiet',
        inner.split('\\').join('/'),
        path,
      ]);
    }
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'two submodules']);
    // Only the shorter one is deinitialised out — the longer stays populated,
    // which is what removes it from the `-` list and blinds a duplicate guard.
    git(root, ['submodule', 'deinit', '--force', `vendnb${NBSP}`]);
  }

  it('reports a file planted behind a path that collides with a populated sibling', async () => {
    const root = repo();
    nbspSiblingWithOnePopulated(root);

    // The premise, in three measured halves.
    const listing = await runGitCommand(root, ['submodule', 'status']);
    expect(listing.outcome).toBe('OK');
    // Git wrote the path intact...
    expect(listing.rawStdout ?? '').toContain(`vendnb${NBSP}`);
    // ...and the trimmed reading this module used to parse has lost it.
    expect(listing.stdout).not.toContain(`vendnb${NBSP}`);
    // ...while Git's own cleanliness reading sees nothing at all.
    writeFileSync(join(root, `vendnb${NBSP}`, 'planted.ts'), `payload${NEWLINE}`, 'utf8');
    expect(git(root, [...WORKTREE_CLEANLINESS_ARGS]).trim()).toBe('');

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(false);
  });

  it('reports the same shape as clean when nothing is planted', async () => {
    const root = repo();
    nbspSiblingWithOnePopulated(root);

    expect(await observeWorktreeCleanliness(runGitCommand, root)).toBe(true);
  });

  /**
   * And the parser really is reading `rawStdout`: a runner whose two fields
   * disagree is answered from the untrimmed one. Without this, a runner that
   * omits `rawStdout` — every stub in this file — would be the only evidence,
   * and it exercises the fallback rather than the fix.
   */
  it('parses the untrimmed bytes when a runner supplies both', async () => {
    const SHA = 'd'.repeat(40);
    const CLEAN = { outcome: 'OK' as const, stdout: '', stderr: '', exitCode: 0 };
    const asked: string[][] = [];
    const gitRunner = (async (_cwd, args) => {
      asked.push([...args]);
      if (args[0] === 'status') return CLEAN as never;
      if (args[0] === 'submodule') {
        return {
          ...CLEAN,
          stdout: `-${SHA} vendnb`,
          rawStdout: `-${SHA} vendnb${NBSP}\n`,
        } as never;
      }
      return CLEAN as never;
    }) as GitRunner;

    // The untrimmed path is not a safe argument, so the confirmation is never
    // issued and the whole-index fallback answers instead.
    expect(await observeWorktreeCleanliness(gitRunner, 'C:/nowhere', () => [])).toBe(true);
    expect(asked.some((args) => args[0] === 'ls-files' && args.includes('--'))).toBe(false);
    expect(asked.some((args) => args[0] === 'ls-files' && !args.includes('--'))).toBe(true);
  });
});


/* ═══ 14. The duplicate guard, now that it is the second line of defence ═══ */

/**
 * `rawStdout` is **optional** on `GitCommandResult`, so a runner that does not
 * supply it — every injected one in this suite, and any future caller's — hands
 * the parser the trimmed reading and can still collapse two paths into one.
 *
 * The duplicate guard is what catches that. With the untrimmed read in place it
 * is unreachable through the production runner, and a mutation run duly reported
 * it as a survivor: nothing exercised the arm any more. This case does, by
 * supplying the trimmed shape directly.
 *
 * Two `-` lines can never legitimately name one path — an index cannot hold two
 * gitlinks in one place — so the duplicate is proof, not a heuristic.
 */
describe('the duplicate guard still catches a collapse a runner hands it', () => {
  const CLEAN = { outcome: 'OK' as const, stdout: '', stderr: '', exitCode: 0 };
  const SHA = 'e'.repeat(40);
  const NUL = String.fromCharCode(0);
  const NBSP = '\u00A0';

  /** `<mode> <sha> <stage>\t<path>`, NUL-terminated, as `ls-files -z` prints. */
  function indexEntries(...paths: readonly string[]): string {
    return paths.map((path) => `160000 ${SHA} 0\t${path}${NUL}`).join('');
  }

  function trimmedOnlyRunner(
    listing: string,
    indexStdout: string,
  ): GitRunner & { readonly asked: string[][] } {
    const asked: string[][] = [];
    const runner = (async (_cwd, args) => {
      asked.push([...args]);
      if (args[0] === 'status') return CLEAN as never;
      // No `rawStdout`: this is the shape a runner without it produces.
      if (args[0] === 'submodule') return { ...CLEAN, stdout: listing } as never;
      if (args[0] === 'ls-files' && !args.includes('--')) {
        return { ...CLEAN, stdout: indexStdout } as never;
      }
      return CLEAN as never;
    }) as GitRunner;
    return Object.assign(runner, { asked });
  }

  it('takes the index when the listing names one path twice', async () => {
    const git = trimmedOnlyRunner(
      `-${SHA} vendnb\n-${SHA} vendnb`,
      indexEntries('vendnb', `vendnb${NBSP}`),
    );

    // Answered from the index, which carries both real paths...
    expect(await observeWorktreeCleanliness(git, 'C:/nowhere', () => [])).toBe(true);
    // ...and the pathspec-bounded confirmation was never issued, because the
    // duplicate short-circuits before it.
    expect(git.asked.some((args) => args[0] === 'ls-files' && args.includes('--'))).toBe(false);
    expect(git.asked.some((args) => args[0] === 'ls-files' && !args.includes('--'))).toBe(true);
  });

  /**
   * The control: the same runner shape with two *distinct* paths confirms
   * normally, so the case above is about the duplicate and not about the stub.
   */
  it('confirms normally when the listing names two distinct paths', async () => {
    const git = trimmedOnlyRunner(`-${SHA} alpha\n-${SHA} beta`, '');
    const seen: string[][] = [];
    const withConfirm = (async (cwd, args) => {
      seen.push([...args]);
      if (args[0] === 'ls-files' && args.includes('--')) {
        return { ...CLEAN, stdout: indexEntries('alpha', 'beta') } as never;
      }
      return await git(cwd, args);
    }) as GitRunner;

    expect(await observeWorktreeCleanliness(withConfirm, 'C:/nowhere', () => [])).toBe(true);
    // Recorded on the wrapper, not on the inner runner: the wrapper answers the
    // confirmation itself, so the inner one never sees it.
    expect(seen.some((args) => args[0] === 'ls-files' && args.includes('--'))).toBe(true);
    expect(seen.some((args) => args[0] === 'ls-files' && !args.includes('--'))).toBe(false);
  });
});
