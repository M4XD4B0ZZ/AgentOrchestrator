/**
 * Recognising a task's own crashed start — and refusing everything else.
 *
 * ── The one window this closes ─────────────────────────────────────────────
 *
 * `startTask` creates the workspace and then writes the first durable state.
 * Between those two acts there is a gap:
 *
 *     prepareTaskWorkspace succeeds
 *              ↓
 *     worktree + branch exist
 *              ↓
 *     CRASH                          ← the window
 *              ↓
 *     no TaskState was ever written
 *              ↓
 *     the next start collides with its own leftovers
 *
 * Before V2-06A the next start refused with `WORKSPACE_COLLISION` and an
 * operator cleaned up by hand. This module lets that start recognise the
 * leftovers as its own — but only when every part of that claim is *proven*.
 *
 * ── "Adoption" must not become a friendly word for `--force` ───────────────
 *
 * The verdict is not "does this look like our workspace". It is a conjunction,
 * and every term has to hold:
 *
 *  1. **No durable state exists** for the task, and the absence is positively
 *     established. An unreadable or invalid state is *not* absence — it is a
 *     record this build cannot interpret, and adopting past it would overwrite
 *     something an operator has not seen.
 *  2. **The identity is re-derived**, by the same pure function preparation
 *     uses. There is no parameter for "the workspace to adopt", so no caller
 *     can point this at a directory of its choosing.
 *  3. **Git registers that exact path**, and registers it holding *this task's*
 *     branch — judged on the branch Git reports, never on the derived name
 *     compared with itself.
 *  4. **The worktree is where, what and at which commit it should be**, read
 *     from inside it: `verifyWorkspaceMatches` answers all four.
 *  5. **`HEAD` is the commit a fresh start would pin right now.** Not "some
 *     ancestor", not "whatever it was created at" — the base branch's current
 *     tip. See below.
 *  6. **The source checkout still satisfies every start invariant**, proven by
 *     the same preflight preparation runs.
 *
 * Only then is this workspace not merely *a* worktree, but the still-unused one
 * that our own previous start attempt must have created.
 *
 * ── Why `HEAD` must equal the *current* base tip ───────────────────────────
 *
 * A fresh `prepareTaskWorkspace` pins the base branch's tip and creates the
 * worktree at that object. So an orphan that sits anywhere else — including at
 * a perfectly good earlier tip, because the base branch moved on after the
 * crash — is not the workspace a fresh start would produce. Adopting it would
 * silently start the task from a different base than the operator asked for,
 * and nothing durable records which base was intended.
 *
 * That is the refusal to reconstruct what cannot be proven, applied to the one
 * case where the wrong answer looks most reasonable. Such an orphan is reported
 * as `WORKSPACE_HEAD_MOVED` and a human decides.
 *
 * ── A commit in the orphan is not an "advanced" orphan ─────────────────────
 *
 * Without a durable state there is no record of whether an agent ran, whether
 * verification passed, or what authority was lost. A worktree with a commit in
 * it is therefore *less* adoptable, not more: it is evidence that something
 * happened which nothing accounts for. It fails the `HEAD` term and stops.
 *
 * ── Adoption introduces no second truth ────────────────────────────────────
 *
 * There is no `ADOPTED` task state and no second recovery lifeline. This module
 * produces the ordinary {@link TaskWorkspace} receipt — the same shape
 * `prepareTaskWorkspace` returns — and `startTask` writes the ordinary
 * `WORKTREE_READY` from it. After that, a task safely recovered from a crash
 * and a task freshly created are indistinguishable, and both run through the
 * same reconciliation.
 *
 * ── What this does not solve ───────────────────────────────────────────────
 *
 * Mutual exclusion. Two processes starting the same task concurrently can still
 * race each other for creation or adoption; this module detects *crash
 * artefacts*, it does not prevent *concurrent owners*. That separation is
 * deliberate and still holds: mutual exclusion is the execution lease's job
 * (V2-07L), and every path that reaches this proof — `startTask` and
 * `releaseTaskWorkspace` — now requires lease evidence before it gets here.
 *
 * Which is also why this module must not be read as the thing that makes a
 * release safe. A workspace a concurrent run has *just* prepared satisfies every
 * proof below, because it genuinely is a pristine checkout at the base commit
 * with nothing done in it. Only exclusive ownership tells that apart from a
 * crash artefact, and it is supplied above rather than approximated here.
 */

import { LOCAL_BRANCH_REF_PREFIX } from '../repo/branch-name.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { loadTaskState } from '../state/state-store.js';
import { runGitCommand, type GitRunner } from './git-command.js';
import {
  proveSourcePreflight,
  verifyWorkspaceMatches,
  type TaskWorkspace,
} from './prepare-workspace.js';
import { deriveTaskWorkspaceIdentity, isOwnedTaskBranch } from './workspace-identity.js';
import { findByPath, listWorktrees } from './worktree-registry.js';

/**
 * Every answer the recovery assessor can give. A closed set, and deliberately
 * *not* a set of task states.
 *
 * `WORKSPACE_COLLISION` stays one outcome of `startTask`; this vocabulary says
 * *why* the thing in the way could not be adopted, so an operator is told which
 * of a dozen situations they are in without the state machine growing a dozen
 * near-synonyms.
 */
export const WORKSPACE_ADOPTION_VERDICTS = [
  /** Provably this task's own untouched workspace. The only adoptable answer. */
  'ADOPTABLE_PRISTINE_ORPHAN',
  /** A durable state already exists. Continuing it is `runTask`'s job. */
  'STATE_ALREADY_EXISTS',
  /**
   * A state exists and could not be read or validated. Never treated as
   * absence: adopting past an unreadable record would overwrite it.
   */
  'STATE_UNREADABLE',
  /** No identity can be derived for this repository and task at all. */
  'IDENTITY_UNDERIVABLE',
  /** The source checkout no longer satisfies the invariants a start requires. */
  'SOURCE_UNSUITABLE',
  /** Git registers no worktree at the derived path for this repository. */
  'WORKSPACE_NOT_REGISTERED',
  /** Git reports a different working-tree root than the derived path. */
  'WORKSPACE_PATH_MISMATCH',
  /** The registration, or the worktree itself, holds a different branch. */
  'WORKSPACE_BRANCH_MISMATCH',
  /** `HEAD` is not the commit a fresh start would pin. Includes any commit made. */
  'WORKSPACE_HEAD_MOVED',
  /**
   * The directory is a worktree of a different repository.
   *
   * Its own answers and this repository's registry are each self-consistent and
   * describe two different Gits — the one mismatch neither side can see alone.
   */
  'WORKSPACE_FOREIGN_REPOSITORY',
  /** Tracked files in the worktree have been modified. */
  'WORKSPACE_DIRTY',
  /** Untracked files are present in the worktree. */
  'WORKSPACE_UNTRACKED_CONTENT',
  /**
   * Ownership could not be established from Git and canonical derivation alone.
   *
   * Distinct from every mismatch above: those are facts about a workspace that
   * *was* inspected. This is the refusal that nothing was established, so no
   * claim about ownership may be made either way.
   */
  'OWNERSHIP_UNPROVEN',
] as const;

export type WorkspaceAdoptionVerdict = (typeof WORKSPACE_ADOPTION_VERDICTS)[number];

export interface AdoptableWorkspace {
  readonly verdict: 'ADOPTABLE_PRISTINE_ORPHAN';
  /**
   * The same receipt `prepareTaskWorkspace` produces on success.
   *
   * Deliberately the same type: the caller writes the ordinary first state from
   * it and cannot tell — and must not be able to tell — whether the workspace
   * was created a moment ago or recovered from a crash.
   */
  readonly workspace: TaskWorkspace;
}

export interface UnadoptableWorkspace {
  readonly verdict: Exclude<WorkspaceAdoptionVerdict, 'ADOPTABLE_PRISTINE_ORPHAN'>;
  /** A static sentence. Carries no host path, task text or Git output. */
  readonly detail: string;
}

export type WorkspaceAdoptionAssessment = AdoptableWorkspace | UnadoptableWorkspace;

const ADOPTION_DETAIL: Readonly<
  Record<Exclude<WorkspaceAdoptionVerdict, 'ADOPTABLE_PRISTINE_ORPHAN'>, string>
> = Object.freeze({
  STATE_ALREADY_EXISTS: 'A durable state already exists for this task.',
  STATE_UNREADABLE:
    'A state record exists and could not be read, so its absence cannot be established.',
  IDENTITY_UNDERIVABLE: 'No workspace identity can be derived for this repository and task.',
  SOURCE_UNSUITABLE:
    'The source checkout no longer satisfies the invariants a start requires of it.',
  WORKSPACE_NOT_REGISTERED: 'Git registers no worktree at the derived path for this repository.',
  WORKSPACE_PATH_MISMATCH: 'Git reports a different working-tree root than the derived path.',
  WORKSPACE_BRANCH_MISMATCH: 'The worktree does not hold the branch derived for this task.',
  WORKSPACE_FOREIGN_REPOSITORY:
    'The directory is a worktree of a different repository, whatever this one’s registry says.',
  WORKSPACE_HEAD_MOVED:
    'The worktree is not at the commit a fresh start would pin, so its history is unaccounted for.',
  WORKSPACE_DIRTY: 'Tracked files in the worktree have been modified.',
  WORKSPACE_UNTRACKED_CONTENT: 'The worktree contains untracked files.',
  OWNERSHIP_UNPROVEN: 'Ownership of the existing workspace could not be established.',
});

function unadoptable(
  verdict: Exclude<WorkspaceAdoptionVerdict, 'ADOPTABLE_PRISTINE_ORPHAN'>,
): UnadoptableWorkspace {
  return Object.freeze({ verdict, detail: ADOPTION_DETAIL[verdict] });
}

export interface WorkspaceAdoptionOptions {
  /** The Git seam. Defaults to the real one. */
  readonly git?: GitRunner;
}

/**
 * Decides whether an existing workspace is this task's own crash artefact.
 *
 * Read-only: it inspects, and creates, deletes and writes nothing — including
 * on the adoptable answer, where the durable write belongs to `startTask`.
 * Never throws for an expected condition.
 */
export async function assessWorkspaceAdoption(
  repository: ResolvedRepository,
  taskId: string,
  options: WorkspaceAdoptionOptions = {},
): Promise<WorkspaceAdoptionAssessment> {
  const git = options.git ?? runGitCommand;

  // --- 1. Absence of a durable state, positively established ---------------
  // The order matters: this is asked before anything about Git, because a task
  // that already has a state is not a recovery question at all.
  const existing = loadTaskState(repository.root, taskId);
  if (existing.classification === 'STATE_VALID') return unadoptable('STATE_ALREADY_EXISTS');
  if (existing.classification !== 'STATE_MISSING') return unadoptable('STATE_UNREADABLE');

  // --- 2. Canonical identity, derived and never supplied -------------------
  const derived = deriveTaskWorkspaceIdentity(repository, taskId);
  if (!derived.ok) return unadoptable('IDENTITY_UNDERIVABLE');
  const identity = derived.identity;

  // --- 3. The source checkout still supports a start -----------------------
  // The same four proofs preparation runs, and the same pinned commit. A
  // repository that has since moved onto another branch, or been dirtied, is
  // not one a start may be completed in — whether by creation or by adoption.
  const preflight = await proveSourcePreflight(git, identity);
  if (!preflight.ok) {
    return unadoptable(preflight.code === 'GIT_UNAVAILABLE' ? 'OWNERSHIP_UNPROVEN' : 'SOURCE_UNSUITABLE');
  }

  // --- 4. Git's registry agrees the workspace is ours ----------------------
  const registry = await listWorktrees(git, identity.repositoryRoot);
  if (!registry.ok) return unadoptable('OWNERSHIP_UNPROVEN');

  const registration = findByPath(registry.entries, identity.worktreePath);
  if (registration === null) return unadoptable('WORKSPACE_NOT_REGISTERED');

  // Judged on the branch *Git reports*. A check that compared the derived name
  // with itself would always pass and prove nothing — the same argument
  // `remove-workspace.ts` makes before it deletes anything.
  const registeredBranch = registration.branchRef?.startsWith(LOCAL_BRANCH_REF_PREFIX)
    ? registration.branchRef.slice(LOCAL_BRANCH_REF_PREFIX.length)
    : null;
  if (registeredBranch === null || !isOwnedTaskBranch(identity, registeredBranch)) {
    return unadoptable('WORKSPACE_BRANCH_MISMATCH');
  }

  // --- 5. The worktree itself: where, what, which commit, and untouched ----
  const match = await verifyWorkspaceMatches(git, identity, preflight.basePinnedCommit);
  switch (match.verdict) {
    case 'MATCHES':
      break;
    case 'PATH_MISMATCH':
      return unadoptable('WORKSPACE_PATH_MISMATCH');
    case 'BRANCH_MISMATCH':
      return unadoptable('WORKSPACE_BRANCH_MISMATCH');
    case 'FOREIGN_REPOSITORY':
      return unadoptable('WORKSPACE_FOREIGN_REPOSITORY');
    case 'HEAD_MISMATCH':
      return unadoptable('WORKSPACE_HEAD_MOVED');
    case 'DIRTY':
      return unadoptable('WORKSPACE_DIRTY');
    case 'UNTRACKED_CONTENT':
      return unadoptable('WORKSPACE_UNTRACKED_CONTENT');
    case 'UNREADABLE':
      return unadoptable('OWNERSHIP_UNPROVEN');
  }

  // Not reachable — `MATCHES` carries the canonical path — but the receipt must
  // never be built from the derived spelling when the verified one is the thing
  // every later comparison will observe.
  if (match.canonicalWorktreePath === null) return unadoptable('OWNERSHIP_UNPROVEN');

  return Object.freeze({
    verdict: 'ADOPTABLE_PRISTINE_ORPHAN' as const,
    workspace: Object.freeze({
      repositoryId: identity.repositoryId,
      repositoryRoot: identity.repositoryRoot,
      taskId: identity.taskId,
      baseBranch: identity.baseBranch,
      basePinnedCommit: preflight.basePinnedCommit,
      workBranch: identity.workBranch,
      worktreePath: match.canonicalWorktreePath,
      // Proven, not assumed: `verifyWorkspaceMatches` refused every unclean
      // shape above before this line was reached.
      worktreeClean: true,
    }),
  });
}
