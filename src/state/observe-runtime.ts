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
 * ── Git's registry is the authority; the record is only a claim ────────────
 *
 * A persisted `worktreePath` is a sentence in a file. Running `git status`
 * inside it — or `rev-parse`, or anything — before Git has confirmed that
 * directory *is* this task's worktree means executing in a location nothing
 * has vouched for: a stale record, a hand-edited file or a state copied from
 * another machine would each be enough to point these probes at someone else's
 * checkout.
 *
 * So the order is fixed, and every step gates the next:
 *
 *  1. read `git worktree list` for the repository;
 *  2. the registry itself must be readable — an unreadable one authorises
 *     nothing, and nothing below runs;
 *  3. find the registration for the recorded path (a comparison, which is all
 *     the recorded path is ever used for);
 *  4. confirm that registration holds *this task's* work branch;
 *  5. only then, and only using **the path Git printed**, ask the filesystem
 *     and Git anything.
 *
 * Where any of those fails, the fields below stay `null`. `null` is "never
 * established", and the reconciler is careful never to read it as "false".
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
  /**
   * The one directory this task's work may execute in, or `null` when Git
   * authorised none.
   *
   * It is the path Git printed for a registration that both matches the
   * recorded `worktreePath` **and** holds this task's work branch. Deliberately
   * narrower than {@link registeredWorktreePath}, which is populated whenever
   * Git lists the recorded path *whatever branch is checked out there* — the
   * two answer different questions, and a caller that rebuilt this one from
   * `registeredWorktreePath` and {@link observedWorkBranchRef} would be
   * restating the rule that lives here.
   *
   * `null` is an absence of authority, never a weaker authority. Nothing may
   * be spawned, and nothing may be asked, without a non-`null` value.
   */
  readonly authorisedWorktreePath: string | null;
  /** Full ref checked out there (`refs/heads/…`), or `null`. */
  readonly observedWorkBranchRef: string | null;
  /**
   * Whether the registered worktree directory exists on disk.
   *
   * `null` when the question was never asked, because Git had not authorised a
   * path to ask it about — an unreadable registry, no registration for the
   * recorded path, or a registration holding a different branch. A `false`
   * here means Git named a directory and it is not there; `null` means nothing
   * was established either way, and the reconciler must not read it as absence.
   */
  readonly worktreeExists: boolean | null;
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

/**
 * The one exit code `rev-parse --verify --quiet` uses to *answer* "no".
 *
 * The protocol, stated because this is a place that reads an exit status:
 *
 *  - **0** — the object resolved. It exists;
 *  - **1** — `--quiet` suppressed the diagnostic and Git reports "does not
 *    resolve". A real answer, and the only non-zero one that is;
 *  - **anything else** (128 in practice) — Git could not evaluate the question:
 *    a repository it cannot read, a refusal, a bad invocation. Never an answer.
 *
 * Same discipline as the ancestry probe above, and for the same reason. An
 * indeterminate failure reported as "the commit is gone" sends an operator
 * hunting for a force-push that never happened.
 */
const OBJECT_NOT_FOUND_EXIT = 1;

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
  if (probe.outcome === 'NONZERO_EXIT' && probe.exitCode === OBJECT_NOT_FOUND_EXIT) return false;
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

  // The registry is read from the repository root, which is not a persisted
  // claim by the time this runs: `loadTaskState()` has already refused any
  // state whose recorded root is not absolute *and* identical to the root the
  // caller resolved, so the two are the same directory or there is no state.
  const registry = await listWorktrees(git, state.repositoryRoot);
  const registration = registry.ok ? findByPath(registry.entries, state.worktreePath) : null;

  // The path everything below is allowed to touch — or `null`, meaning nothing
  // may be touched at all.
  //
  // It is the path *Git printed*, and it exists only when Git both lists the
  // recorded path and reports this task's own branch checked out there. The
  // recorded `worktreePath` is used to look the registration up and is then
  // done: it is evidence to match, never a directory to execute in. Judged on
  // Git's answer rather than on a value derived here, exactly as
  // `worktree/remove-workspace.ts` proves ownership before it deletes anything.
  const authorisedPath =
    registration !== null && registration.branchRef === expectedWorkBranchRef(state)
      ? registration.path
      : null;

  // Every question below is about that authorised directory. Where there is
  // none, they are not asked — and the answer stays `null`, "not established",
  // rather than becoming a fact about a worktree nobody confirmed.
  let worktreeExists: boolean | null = null;
  let observedCurrentCommit: string | null = null;
  let worktreeClean: boolean | null = null;
  let basePinnedCommitIsAncestor: boolean | null = null;
  let basePinnedCommitPresent: boolean | null = null;

  if (authorisedPath !== null) {
    worktreeExists = exists(authorisedPath);
  }

  // If the directory is gone, Git has no cwd to run in and would fail with an
  // errno rather than an answer, so the questions are not asked at all — that
  // "unknown" is a fact about the missing worktree, which the reconciler
  // already reports as divergence in its own right.
  if (authorisedPath !== null && worktreeExists === true) {
    const head = await git(authorisedPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'HEAD',
    ]);
    observedCurrentCommit = head.outcome === 'OK' && head.stdout !== '' ? head.stdout : null;

    const status = await git(authorisedPath, ['status', '--porcelain']);
    worktreeClean = status.outcome === 'OK' ? status.stdout === '' : null;

    if (state.basePinnedCommit !== null) {
      const verdict = await classifyAncestry(git, authorisedPath, state.basePinnedCommit);
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
          authorisedPath,
          state.basePinnedCommit,
        );
      }
    }
  }

  return Object.freeze({
    registryReadable: registry.ok,
    worktreeRegistered: registration !== null,
    registeredWorktreePath: registration?.path ?? null,
    // Reported rather than recomputed by the caller: this module already had to
    // decide it in order to know which questions it was allowed to ask, and a
    // second derivation elsewhere would be a second, quieter authority.
    authorisedWorktreePath: authorisedPath,
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
