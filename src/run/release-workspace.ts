/**
 * Giving back a crash artefact — attended, and only one adoption would accept.
 *
 * ── Why this exists next to adoption rather than instead of it ─────────────
 *
 * `assessWorkspaceAdoption` answers "is this workspace this task's own
 * untouched leftovers?". Two different things follow from a `yes`, and which
 * one an operator wants is not something the orchestrator can decide:
 *
 *  - **continue** — `startTask` adopts it and the task carries on;
 *  - **discard** — the operator has decided this task should not run after all,
 *    and wants the branch and directory gone.
 *
 * This module is the second. It deliberately reuses the *same* proof rather
 * than writing a weaker one: a workspace may be released exactly when it could
 * have been adopted. That is what keeps "release" from drifting into a general
 * delete — there is no second, laxer notion of ownership for the destructive
 * path, which is the direction such a notion would always drift.
 *
 * ── Consequences of that choice, stated rather than discovered ─────────────
 *
 * A workspace with a commit in it, a dirty one, one whose base branch has moved
 * on, or one whose task already has durable state is **not** releasable here,
 * and the refusal names which. That is the intent: those are exactly the cases
 * where something might be lost, and an operator should look at them before
 * anything is deleted. `HUMAN_DECISION_REQUIRED` is the right place for them to
 * stay, and a later slice may add a wider, more explicit operation — but it will
 * be a decision, not an option quietly added to this one.
 *
 * **There is no `--force`.** `removeTaskWorkspace` refuses to force at the Git
 * level for its own stated reasons, and nothing here reaches past it.
 *
 * ── Attendance is the caller's to establish ────────────────────────────────
 *
 * This module performs no attendance check. The operator grant is a property of
 * an *invocation*, and the CLI is what knows whether one was made — exactly as
 * `--attended` gates execution in `run-command.ts` rather than inside the
 * driver. A library caller that reaches this function has already decided.
 */

import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import { verifyExecutionLeaseHeldFor } from '../lease/execution-lease.js';
import { planNextTask } from '../plan/plan-next-task.js';
import { isValidTaskId } from '../plan/task-id.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import {
  assessWorkspaceAdoption,
  type WorkspaceAdoptionVerdict,
} from '../worktree/adopt-workspace.js';
import type { GitRunner } from '../worktree/git-command.js';
import { removeTaskWorkspace } from '../worktree/remove-workspace.js';

/** Every way a release can end. A closed set. */
export const RELEASE_OUTCOMES = [
  /** The worktree and the task branch are both gone. */
  'RELEASED',
  /**
   * The worktree is gone and the branch is not. Reported as its own outcome
   * rather than as success, so a leftover branch is never invisible.
   */
  'RELEASED_BRANCH_KEPT',
  /** The id does not satisfy the task-id grammar. Nothing was opened. */
  'TASK_ID_INVALID',
  /** The repository's own plan could not be read. */
  'PLANNING_FAILED',
  /** The id is well-formed but names no task in the plan. */
  'TASK_UNKNOWN',
  /**
   * The workspace is not one adoption would accept, so it is not one this
   * operation will delete. `verdict` says which proof failed.
   */
  'NOT_RELEASABLE',
  /**
   * The workspace holds ignored content, so deleting it would destroy files
   * nothing else records. See {@link holdsIgnoredContent}.
   */
  'HOLDS_IGNORED_CONTENT',
  /** Git could not be asked whether the workspace holds ignored content. */
  'IGNORED_CONTENT_UNDETERMINED',
  /** Every proof held and Git still refused to remove the worktree. */
  'REMOVE_FAILED',
  /**
   * This invocation does not hold the repository's execution lease.
   *
   * A release is a destructive repository effect, and the one this module is
   * least able to detect on its own: `assessWorkspaceAdoption` proves the
   * workspace is a *pristine* crash artefact, and a workspace a concurrent run
   * has only just prepared looks exactly like one. Without the lease this
   * command could therefore delete the branch and directory of a run that is
   * about to write in them, having passed every proof it has.
   */
  'EXECUTION_LEASE_NOT_HELD',
] as const;

export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number];

export interface ReleaseResult {
  readonly outcome: ReleaseOutcome;
  readonly taskId: string;
  /**
   * The adoption verdict this release rested on, or `null` when the attempt
   * stopped before one could be formed.
   *
   * Present on success too: it is the positive evidence the deletion was
   * allowed, and an operator reading a log should see what was proven rather
   * than only that something was removed.
   */
  readonly verdict: WorkspaceAdoptionVerdict | null;
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
  /** Stable codes explaining a non-releasing outcome. Empty otherwise. */
  readonly reasonCodes: readonly string[];
}

export interface ReleaseDependencies {
  /** The Git seam. Required and never defaulted, as `startTask` requires it. */
  readonly git: GitRunner;
  /**
   * Proof that this invocation holds the repository's execution lease.
   *
   * Required for the same reason `startTask` requires one, and with the same
   * consequence for a caller that has none: it does not compile. Attendance
   * stays the *caller's* to establish — see the module header — but authority
   * over the repository is not, and a lease is not an operator grant.
   */
  readonly lease: ExecutionLeaseEvidence;
}

function result(
  from: Partial<ReleaseResult> & { readonly outcome: ReleaseOutcome; readonly taskId: string },
): ReleaseResult {
  return Object.freeze({
    verdict: null,
    worktreeRemoved: false,
    branchRemoved: false,
    reasonCodes: Object.freeze([]),
    ...from,
  });
}

/**
 * `true` when the worktree holds files Git ignores, `null` when Git could not
 * say.
 *
 * ── Why adoption does not ask this and deletion must ───────────────────────
 *
 * "Nothing done in it" is proven with `git status --porcelain
 * --untracked-files=all`, and that command does not list **ignored** files. For
 * *adoption* that is the right boundary and matches the scope decision V2-06
 * made: an ignored file is not a repository effect, and continuing a task over
 * one costs nothing.
 *
 * Deletion is the asymmetric half. `git worktree remove` without `--force`
 * refuses a worktree with untracked or modified files — and **removes one whose
 * only extra content is ignored**, verified against real Git rather than
 * assumed. So the exact set of files no proof above ever looked at is the set
 * an unforced removal silently destroys: a `.env`, a local database, whatever a
 * developer left in the directory.
 *
 * A pristine crash artefact — a fresh checkout nothing has run in — has no
 * ignored content, so this refuses nothing the command is for. It refuses
 * exactly the case where "release" would have meant "delete files you never
 * showed me".
 */
async function holdsIgnoredContent(
  git: GitRunner,
  worktreePath: string,
): Promise<boolean | null> {
  const ignored = await git(worktreePath, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  ]);
  if (ignored.outcome !== 'OK') return null;
  return ignored.stdout.length > 0;
}

/**
 * Removes a task workspace that is provably an untouched crash artefact.
 *
 * Never throws for an expected condition. Every refusal leaves the workspace
 * exactly as it was found.
 */
export async function releaseTaskWorkspace(
  repository: ResolvedRepository,
  taskId: string,
  deps: ReleaseDependencies,
): Promise<ReleaseResult> {
  // Authority over the repository, before anything is inspected or removed.
  const lease = verifyExecutionLeaseHeldFor(repository, deps.lease);
  if (lease.code !== 'HELD') {
    return result({
      outcome: 'EXECUTION_LEASE_NOT_HELD',
      taskId,
      reasonCodes: Object.freeze([lease.code]),
    });
  }

  if (!isValidTaskId(taskId)) return result({ outcome: 'TASK_ID_INVALID', taskId });

  // The task must still be one this repository declares. `removeTaskWorkspace`
  // takes a definition, and reading it from the plan is what keeps this from
  // being able to delete a workspace for an id the repository never named.
  const planning = planNextTask(repository);
  if (!planning.ok) {
    return result({
      outcome: 'PLANNING_FAILED',
      taskId,
      reasonCodes: Object.freeze([planning.code]),
    });
  }
  const task = planning.graph.node(taskId)?.definition;
  if (task === undefined) return result({ outcome: 'TASK_UNKNOWN', taskId });

  // The one ownership proof, shared with adoption. A workspace may be released
  // exactly when it could have been adopted — see the module header.
  const assessment = await assessWorkspaceAdoption(repository, taskId, { git: deps.git });
  if (assessment.verdict !== 'ADOPTABLE_PRISTINE_ORPHAN') {
    return result({
      outcome: 'NOT_RELEASABLE',
      taskId,
      verdict: assessment.verdict,
      reasonCodes: Object.freeze([assessment.verdict]),
    });
  }

  // The one question adoption does not ask, and deletion must. Asked after the
  // ownership proof, so a stranger's directory is never enumerated at all.
  const ignored = await holdsIgnoredContent(deps.git, assessment.workspace.worktreePath);
  if (ignored === null) {
    return result({
      outcome: 'IGNORED_CONTENT_UNDETERMINED',
      taskId,
      verdict: assessment.verdict,
    });
  }
  if (ignored) {
    return result({ outcome: 'HOLDS_IGNORED_CONTENT', taskId, verdict: assessment.verdict });
  }

  // Proved again, immediately before the deletion. The entry gate is several Git
  // subprocesses old by this point — the plan, the adoption assessment, the
  // ignored-content query — and what follows destroys a worktree and a branch. A
  // review lost the lease to a legitimate successor inside that window and
  // watched both be deleted anyway. The gate that matters is the one nearest the
  // effect, exactly as `advanceTaskState` argues for a durable move.
  const stillHeld = verifyExecutionLeaseHeldFor(repository, deps.lease);
  if (stillHeld.code !== 'HELD') {
    return result({
      outcome: 'EXECUTION_LEASE_NOT_HELD',
      taskId,
      verdict: assessment.verdict,
      reasonCodes: Object.freeze([stillHeld.code]),
    });
  }

  const removal = await removeTaskWorkspace(repository, task, { git: deps.git });
  if (!removal.ok) {
    return result({
      outcome: 'REMOVE_FAILED',
      taskId,
      verdict: assessment.verdict,
      worktreeRemoved: removal.worktreeRemoved,
      branchRemoved: removal.branchRemoved,
      reasonCodes: Object.freeze([removal.code]),
    });
  }

  return result({
    outcome: removal.branchRemoved ? 'RELEASED' : 'RELEASED_BRANCH_KEPT',
    taskId,
    verdict: assessment.verdict,
    worktreeRemoved: removal.worktreeRemoved,
    branchRemoved: removal.branchRemoved,
  });
}
