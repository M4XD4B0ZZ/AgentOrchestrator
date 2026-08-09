/**
 * What Git and the filesystem say *right now* about a task's workspace.
 *
 * This module answers questions and changes nothing. It is the observation half
 * of reconciliation: it produces facts, and {@link reconcileTaskState} in
 * `reconcile.ts` is the only place those facts are compared against what was
 * persisted. Keeping the two apart is what makes the comparison testable
 * without a repository, and what keeps "we could not find out" from quietly
 * becoming "we found out that it is false".
 *
 * ── Refusals to answer are recorded as refusals ────────────────────────────
 *
 * Every field that could not be established is `null`, never a plausible
 * default. A `worktreeClean` of `false` means Git listed modified files; a
 * `worktreeClean` of `null` means Git could not be asked. The first is grounds
 * to refuse a resume, the second is grounds to refuse a *decision* — and a
 * reconciler that cannot tell them apart will eventually report "your worktree
 * is dirty" about a repository it never managed to read.
 *
 * ── The seams ──────────────────────────────────────────────────────────────
 *
 * Git goes through V1-03's read/write-shared {@link GitRunner}, which forwards
 * no inherited Git environment and treats failure as data. Filesystem existence
 * goes through {@link RuntimeObservationOptions.exists}, because "Git still
 * lists a worktree whose directory a human deleted" is a state that matters a
 * great deal here and that no real repository can be asked to produce on demand.
 */

import { existsSync } from 'node:fs';

import { localBranchRef } from '../repo/branch-name.js';
import type { TaskState } from '../core/task-state.js';
import type { GitRunner } from '../worktree/git-command.js';
import { findByPath, listWorktrees } from '../worktree/worktree-registry.js';

export interface ObservedRuntime {
  /** Whether `git worktree list` could be read at all. */
  readonly registryReadable: boolean;
  /** Whether Git lists a worktree at the recorded path. `false` if unreadable. */
  readonly worktreeRegistered: boolean;
  /** The path exactly as Git printed it, or `null`. */
  readonly registeredWorktreePath: string | null;
  /** Full ref checked out there (`refs/heads/…`), or `null`. */
  readonly observedWorkBranchRef: string | null;
  /** Whether the recorded worktree directory exists on disk. */
  readonly worktreeExists: boolean;
  /** HEAD of the recorded worktree, or `null` when it could not be resolved. */
  readonly observedCurrentCommit: string | null;
  /**
   * Whether the recorded base pin still exists as a commit object.
   * `null` when the question was never asked, because it was never in doubt.
   */
  readonly basePinnedCommitPresent: boolean | null;
  /**
   * Whether the recorded base pin is still an ancestor of the work.
   * `null` when Git refused to evaluate the question.
   */
  readonly basePinnedCommitIsAncestor: boolean | null;
  /** Whether the worktree is free of uncommitted changes. `null` if unasked. */
  readonly worktreeClean: boolean | null;
}

export interface RuntimeObservationOptions {
  /** Filesystem existence seam. Defaults to the real one. */
  readonly exists?: (path: string) => boolean;
}

/**
 * What the ancestry probe established — including that it established nothing.
 *
 * The distinction is the same one `worktree/remove-workspace.ts` documents for
 * its own probe, and for the same reason: `merge-base --is-ancestor` answers
 * with its exit status, where **0** is yes, **1** is a genuine no, and anything
 * else (128 in practice) is a refusal to evaluate. Reporting a refusal as "no"
 * would tell an operator their base commit was rewritten when in truth the
 * repository could not be read.
 *
 * This slice asks about a *commit object*, not about a base branch, so it does
 * not repeat that module's extra "the base branch is gone" probe — the
 * follow-up here asks whether the pinned object still exists at all.
 */
type AncestryVerdict = 'ANCESTOR' | 'NOT_ANCESTOR' | 'INDETERMINATE';

async function classifyAncestry(
  git: GitRunner,
  worktreePath: string,
  ancestorCommit: string,
): Promise<AncestryVerdict> {
  const probe = await git(worktreePath, [
    'merge-base',
    '--is-ancestor',
    '--end-of-options',
    ancestorCommit,
    'HEAD',
  ]);
  if (probe.outcome === 'OK') return 'ANCESTOR';
  if (probe.outcome === 'NONZERO_EXIT' && probe.exitCode === 1) return 'NOT_ANCESTOR';
  return 'INDETERMINATE';
}

/** `true`/`false` when Git resolved the object, `null` when it could not say. */
async function commitObjectPresent(
  git: GitRunner,
  worktreePath: string,
  commit: string,
): Promise<boolean | null> {
  const probe = await git(worktreePath, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${commit}^{commit}`,
  ]);
  if (probe.outcome === 'OK') return true;
  if (probe.outcome === 'NONZERO_EXIT') return false;
  return null;
}

/**
 * Observes the current world for one persisted task state. Never throws, never
 * writes, and never falls back to `process.cwd()`.
 */
export async function observeRuntime(
  git: GitRunner,
  state: TaskState,
  options: RuntimeObservationOptions = {},
): Promise<ObservedRuntime> {
  const exists = options.exists ?? existsSync;

  const registry = await listWorktrees(git, state.repositoryRoot);
  const registration = registry.ok ? findByPath(registry.entries, state.worktreePath) : null;

  const worktreeExists = exists(state.worktreePath);

  // Every probe below runs *inside* the worktree. If the directory is gone,
  // Git has no cwd to run in and would fail with an errno rather than an
  // answer, so the questions are not asked at all — "unknown" here is a fact
  // about the missing worktree, which the reconciler already reports.
  let observedCurrentCommit: string | null = null;
  let worktreeClean: boolean | null = null;
  let basePinnedCommitIsAncestor: boolean | null = null;
  let basePinnedCommitPresent: boolean | null = null;

  if (worktreeExists) {
    const head = await git(state.worktreePath, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'HEAD',
    ]);
    observedCurrentCommit = head.outcome === 'OK' && head.stdout !== '' ? head.stdout : null;

    const status = await git(state.worktreePath, ['status', '--porcelain']);
    worktreeClean = status.outcome === 'OK' ? status.stdout === '' : null;

    if (state.basePinnedCommit !== null) {
      const verdict = await classifyAncestry(git, state.worktreePath, state.basePinnedCommit);
      if (verdict === 'ANCESTOR') {
        basePinnedCommitIsAncestor = true;
        // It is an ancestor, therefore it exists. No second call on the happy path.
        basePinnedCommitPresent = true;
      } else if (verdict === 'NOT_ANCESTOR') {
        basePinnedCommitIsAncestor = false;
        basePinnedCommitPresent = true;
      } else {
        // Only here is the extra probe worth its round trip: it separates "the
        // pinned commit is gone" from "this repository could not be read".
        basePinnedCommitPresent = await commitObjectPresent(
          git,
          state.worktreePath,
          state.basePinnedCommit,
        );
      }
    }
  }

  return Object.freeze({
    registryReadable: registry.ok,
    worktreeRegistered: registration !== null,
    registeredWorktreePath: registration?.path ?? null,
    observedWorkBranchRef: registration?.branchRef ?? null,
    worktreeExists,
    observedCurrentCommit,
    basePinnedCommitPresent,
    basePinnedCommitIsAncestor,
    worktreeClean,
  });
}

/** The ref the recorded work branch denotes. Exported for the reconciler. */
export function expectedWorkBranchRef(state: TaskState): string {
  return localBranchRef(state.workBranch);
}
