/**
 * V1-03: reading what Git believes about a repository's worktrees.
 *
 * The parser is small, and every case below is one where a naive version gives
 * the wrong answer — which matters because two of its answers are permissions:
 * "this path is free to create" and "this worktree is ours to remove".
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findByBranchRef,
  findByPath,
  parseWorktreeList,
  samePath,
} from '../src/worktree/worktree-registry.js';

const PORCELAIN = [
  'worktree C:/repos/alpha',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree C:/repos/alpha.worktrees/V1-03',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/ao/task/V1-03',
  '',
  'worktree C:/repos/alpha.worktrees/loose',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n');

describe('parsing the porcelain listing', () => {
  it('reads every worktree and its branch', () => {
    const entries = parseWorktreeList(PORCELAIN);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ path: 'C:/repos/alpha', branchRef: 'refs/heads/main' });
    expect(entries[1]?.branchRef).toBe('refs/heads/ao/task/V1-03');
  });

  it('reports a detached worktree as having no branch', () => {
    const entries = parseWorktreeList(PORCELAIN);
    expect(entries[2]?.branchRef).toBeNull();
  });

  it('does not merge two records when a blank line is missing', () => {
    // A `worktree` line always starts a new record. Without that rule a
    // truncated listing would attach one worktree's branch to another's path —
    // and that mistake reads as "we own this", which is the dangerous direction.
    const truncated = [
      'worktree C:/repos/alpha.worktrees/V1-03',
      'worktree C:/repos/alpha.worktrees/V1-04',
      'branch refs/heads/ao/task/V1-04',
    ].join('\n');
    const entries = parseWorktreeList(truncated);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.branchRef).toBeNull();
    expect(entries[1]?.branchRef).toBe('refs/heads/ao/task/V1-04');
  });

  it('tolerates CRLF line endings', () => {
    const entries = parseWorktreeList(PORCELAIN.split('\n').join('\r\n'));
    expect(entries).toHaveLength(3);
    expect(entries[1]?.branchRef).toBe('refs/heads/ao/task/V1-03');
  });

  it('ignores attributes it does not use rather than interpreting them', () => {
    const entries = parseWorktreeList(
      ['worktree C:/repos/alpha', 'bare', 'locked', 'prunable gitdir file is missing', ''].join(
        '\n',
      ),
    );
    expect(entries).toEqual([{ path: 'C:/repos/alpha', branchRef: null }]);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('finding an entry', () => {
  const entries = parseWorktreeList(PORCELAIN);

  it('matches a path Git spelled with forward slashes against one built with node:path', () => {
    // Git prints POSIX-shaped paths even on Windows, while the implementation
    // derives its paths with `node:path`. String equality would report "not
    // registered" for a worktree that is registered — and the caller would then
    // try to create it again.
    const derived = join('C:/repos/alpha.worktrees', 'V1-03');
    expect(findByPath(entries, derived)?.branchRef).toBe('refs/heads/ao/task/V1-03');
  });

  it('does not match a different worktree', () => {
    expect(findByPath(entries, join('C:/repos/alpha.worktrees', 'V1-99'))).toBeNull();
  });

  it('finds a worktree by the branch checked out in it', () => {
    expect(findByBranchRef(entries, 'refs/heads/ao/task/V1-03')?.path).toBe(
      'C:/repos/alpha.worktrees/V1-03',
    );
    expect(findByBranchRef(entries, 'refs/heads/ao/task/absent')).toBeNull();
  });
});

describe('path comparison', () => {
  it('treats separator spellings of one location as equal', () => {
    expect(samePath('C:/repos/alpha', join('C:/repos', 'alpha'))).toBe(true);
  });

  it('keeps different locations different', () => {
    expect(samePath('C:/repos/alpha', 'C:/repos/beta')).toBe(false);
    // A prefix is not a match: `alpha.worktrees` is not inside `alpha`.
    expect(samePath('C:/repos/alpha', 'C:/repos/alpha.worktrees')).toBe(false);
  });
});
