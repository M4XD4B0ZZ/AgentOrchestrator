/**
 * What Git believes about the worktrees of a repository.
 *
 * `git worktree list --porcelain` is the only authority consulted here. A
 * directory that merely *looks* like a checkout is not a registered worktree,
 * and a registration whose directory has been deleted is still a registration —
 * the two disagree often enough in practice (someone deleted a folder by hand)
 * that guessing from the filesystem would be wrong in both directions.
 *
 * ── Comparing paths, not strings ───────────────────────────────────────────
 *
 * Git prints POSIX-shaped paths even on Windows (`D:/repo/...`), while a path
 * this codebase derived with `node:path` is backslash-shaped (`D:\repo\...`).
 * Those two spellings denote one directory, so every comparison goes through
 * `path.relative`, which applies the platform's own rules — including the
 * case-insensitive matching that makes `D:\Repo` and `D:\repo` the same place
 * on Windows. String equality here would report "not registered" for a
 * worktree that is registered, and the caller would then try to create it
 * again.
 */

import { relative } from 'node:path';

import type { GitCommandResult, GitRunner } from './git-command.js';

/** One entry of the porcelain listing. */
export interface WorktreeRegistration {
  /** Absolute path, exactly as Git printed it. */
  readonly path: string;
  /** Full ref name (`refs/heads/…`), or `null` for a detached HEAD. */
  readonly branchRef: string | null;
}

/** `true` when the two paths denote the same location on this platform. */
export function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * Records are blank-line separated; a record starts with `worktree <path>` and
 * carries at most one `branch <ref>` line. Any attribute this slice does not
 * use (`HEAD`, `bare`, `detached`, `locked`, `prunable`) is skipped rather than
 * interpreted, so a future Git that adds an attribute cannot change what this
 * function reports.
 */
export function parseWorktreeList(stdout: string): readonly WorktreeRegistration[] {
  const entries: WorktreeRegistration[] = [];
  let path: string | null = null;
  let branchRef: string | null = null;

  const flush = (): void => {
    if (path !== null) entries.push(Object.freeze({ path, branchRef }));
    path = null;
    branchRef = null;
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      // A new record begins even when the previous one had no blank line after
      // it, so a truncated listing cannot merge two worktrees into one entry.
      flush();
      path = line.slice('worktree '.length);
      continue;
    }
    if (line.startsWith('branch ')) {
      branchRef = line.slice('branch '.length);
    }
  }
  flush();

  return Object.freeze(entries);
}

export interface WorktreeListSuccess {
  readonly ok: true;
  readonly entries: readonly WorktreeRegistration[];
}

export interface WorktreeListFailure {
  readonly ok: false;
}

/** Reads the registry of `repositoryRoot`. */
export async function listWorktrees(
  git: GitRunner,
  repositoryRoot: string,
): Promise<WorktreeListSuccess | WorktreeListFailure> {
  const result: GitCommandResult = await git(repositoryRoot, ['worktree', 'list', '--porcelain']);
  if (result.outcome !== 'OK') return Object.freeze({ ok: false as const });
  return Object.freeze({ ok: true as const, entries: parseWorktreeList(result.stdout) });
}

/** The registration for `path`, or `null` when Git does not know that path. */
export function findByPath(
  entries: readonly WorktreeRegistration[],
  path: string,
): WorktreeRegistration | null {
  return entries.find((entry) => samePath(entry.path, path)) ?? null;
}

/** The registration holding `branchRef` checked out, or `null`. */
export function findByBranchRef(
  entries: readonly WorktreeRegistration[],
  branchRef: string,
): WorktreeRegistration | null {
  return entries.find((entry) => entry.branchRef === branchRef) ?? null;
}
