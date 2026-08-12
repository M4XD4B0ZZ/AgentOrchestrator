/**
 * Starting a task: from a resolved repository to the first durable `TaskState`.
 *
 * This is the entry point V1 deliberately did not have. `runTask` refuses to
 * create a first state (`TASK_NOT_STARTED`, and the reason is stated there),
 * so until now the only thing that ever composed a resolved repository into a
 * persisted task was a test helper.
 *
 * ── Where persistence begins, and why not earlier ──────────────────────────
 *
 * The state machine's setup chain is `CREATED → REPOSITORY_RESOLVED →
 * CONFIG_VALIDATED → AUTH_PREFLIGHT → GIT_PREFLIGHT → WORKTREE_READY`. This
 * module walks all of it, and persists **only the last one**.
 *
 * The five earlier phases are real, and they still happen — they are simply
 * *transient*: process-local steps of one start attempt rather than restartable
 * checkpoints. Persistence begins at `WORKTREE_READY` because that is the first
 * state that can be reconciled against the outside world at all. A task state
 * names a `worktreePath`, a `workBranch` and a `basePinnedCommit`; before the
 * workspace exists there is nothing for any of those to describe, and
 * `reconcile.ts` would read such a record as `WORKTREE_NOT_REGISTERED` →
 * `DIVERGED` → blocked, for every one of the five. Persisting them would
 * therefore require inventing a second reconciliation world for "the task
 * exists but its workspace does not", which nothing needs yet, and would make
 * the caller-chosen-identity residual (F-7) live by giving a non-agent phase a
 * durable state to be interrupted in.
 *
 * A persistable pre-workspace state machine is a later extension, and should
 * be built only if resuming *inside* the setup chain is ever actually needed.
 *
 * ── Three invariants ───────────────────────────────────────────────────────
 *
 * 1. **No durable state before the workspace exists.** Every refusal above —
 *    an ineligible task, an unignored runtime directory, a failed auth
 *    preflight, a refused workspace — writes no state. A failed start cannot be
 *    resumed into existence, because there is no record to resume.
 *
 *    That is a statement about *task state*, and it holds without exception.
 *    The weaker claim "a refusal leaves nothing behind at all" would be false,
 *    and is not made: `prepareTaskWorkspace` can fail with
 *    `WORKTREE_ROLLBACK_INCOMPLETE`, which means it created a worktree,
 *    rejected it, and could not remove it again. It reports that as `residue`
 *    and this module propagates the flag rather than flattening it, because an
 *    operator whose repository has a stray worktree in it needs to be told so
 *    by the thing that made it.
 *
 * 2. **The first state carries derived identity, never supplied identity.**
 *    `worktreePath`, `workBranch`, `baseBranch` and `basePinnedCommit` all come
 *    from the `TaskWorkspace` receipt that `prepareTaskWorkspace` produced and
 *    verified from inside the created worktree. `reconcile.ts` re-derives those
 *    same values and refuses a mismatch, so a state built from anything else
 *    would be permanently diverged from the moment it was written.
 *
 * 3. **The runtime directory is proven ignorable before the first write.** See
 *    `state/runtime-ignored.ts`: a state file the source checkout can see makes
 *    the *next* task's workspace preparation fail with `SOURCE_WORKTREE_DIRTY`.
 *    Checking it here turns a guaranteed second-task stall into a first-task
 *    refusal that names its own cause.
 *
 * ── The initial state is not a parameter ───────────────────────────────────
 *
 * `saveTaskState` writes a state with no predecessor, so the transition table
 * has no edge to judge and cannot defend the setup chain here: a creation call
 * that named `IMPLEMENTING`, or `READY_FOR_PR`, would simply be written.
 * `WORKTREE_READY` is therefore a literal in this module and reachable through
 * no argument at all — `tests/start-task.test.ts` pins that the only state any
 * production path can create is that one.
 */

import {
  isAuthPreflightEvidence,
  type AuthPreflightEvidence,
} from '../core/auth-preflight-evidence.js';
import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import { verifyExecutionLeaseHeld } from '../lease/execution-lease.js';
import { TASK_STATE_SCHEMA_VERSION } from '../core/internal/task-state-object-schema.js';
import type { TaskStateInput } from '../core/task-state.js';
import { planNextTask } from '../plan/plan-next-task.js';
import { isValidTaskId } from '../plan/task-id.js';
import type { TaskDefinition } from '../plan/task-definition.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { checkRuntimeIgnored } from '../state/runtime-ignored.js';
import { loadTaskState, saveTaskState } from '../state/state-store.js';
import type { ReplaceFn, TempSuffixFn } from '../state/atomic-file.js';
import { assessWorkspaceAdoption } from '../worktree/adopt-workspace.js';
import type { GitRunner } from '../worktree/git-command.js';
import {
  prepareTaskWorkspace,
  type TaskWorkspace,
  type WorkspacePreparationFailureCode,
} from '../worktree/prepare-workspace.js';

/**
 * Every way a start attempt can end. A closed set.
 *
 * The refusals stay apart for the reason `run-driver.ts` gives about its own
 * vocabulary: "this task is already running", "this repository is not
 * configured to hold task state", "the agent is not logged in" and "a branch
 * of that name already exists" have nothing in common except that no task
 * started, and they send an operator to four different places.
 */
export const START_TASK_OUTCOMES = [
  /** The workspace exists and the first durable state was written. */
  'STARTED',
  /**
   * This invocation does not hold the repository's execution lease.
   *
   * First, and before anything is read or created. Starting a task creates a
   * branch, a worktree and a durable record, and two invocations doing that at
   * once in one repository is the split-brain the lease exists to prevent — so
   * "may I act here at all" is answered before "is this a task".
   *
   * Covers both a value that is not minted evidence and a lease that has since
   * been removed: `reasonCodes` carries which.
   */
  'EXECUTION_LEASE_NOT_HELD',
  /**
   * The same, over a workspace this task's own crashed start had left behind.
   *
   * Reported separately because an operator whose repository just healed itself
   * should be told so, and because "a worktree was already there" is otherwise
   * indistinguishable from "we made one". It is a fact about *this invocation*,
   * never about the task: the state written is the one `STARTED` writes, and
   * nothing downstream can tell the two apart (V2-06A).
   */
  'ADOPTED',
  /**
   * A durable state already exists for this task. Not an error, and not a
   * second start: continuing it is `runTask`'s job, not this module's.
   */
  'ALREADY_STARTED',
  /** The id does not satisfy the task-id grammar. Nothing was opened. */
  'TASK_ID_INVALID',
  /** The repository's task plan could not be read or normalised. */
  'PLANNING_FAILED',
  /** The id is well-formed but names no task in the plan. */
  'TASK_UNKNOWN',
  /** The task exists but may not run: it is `DONE`, or a dependency is not. */
  'TASK_INELIGIBLE',
  /**
   * The runtime directory is not ignored by Git, so writing state there would
   * dirty the source checkout and refuse the *next* task's workspace.
   */
  'RUNTIME_NOT_IGNORED',
  /** Git could not answer whether the runtime directory is ignored. */
  'RUNTIME_IGNORE_UNDETERMINED',
  /** A fresh auth preflight did not pass. No agent would be able to run. */
  'AUTH_PREFLIGHT_FAILED',
  /**
   * Something already occupies this task's branch, path or worktree registry
   * entry.
   *
   * Kept apart from every other workspace refusal because it is the one that
   * may be *this task's own* leftovers — a start that created the worktree and
   * then died before its durable write.
   *
   * Since V2-06A that possibility is *tested* rather than assumed: reaching
   * this outcome means `assessWorkspaceAdoption` looked and refused, and its
   * verdict is the second entry in `reasonCodes`. So this no longer means
   * "something is in the way"; it means "something is in the way and here is
   * the proof it is not ours".
   */
  'WORKSPACE_COLLISION',
  /** Workspace preparation refused for any other reason. */
  'WORKSPACE_REFUSED',
  /** A record exists but is unusable here: broken, or belonging elsewhere. */
  'STATE_UNUSABLE',
  /** The workspace exists but the first durable write was refused. */
  'STATE_NOT_RECORDED',
] as const;

export type StartTaskOutcome = (typeof START_TASK_OUTCOMES)[number];

/** The three refusals that may describe this task's own crashed start. */
const COLLISION_CODES: ReadonlySet<WorkspacePreparationFailureCode> = new Set([
  'TASK_BRANCH_EXISTS',
  'WORKTREE_PATH_OCCUPIED',
  'WORKTREE_ALREADY_REGISTERED',
]);

export interface StartTaskRequest {
  /** The repository, already resolved. This module resolves nothing. */
  readonly repository: ResolvedRepository;
  /** The task to start. Validated against the repository's own plan. */
  readonly taskId: string;
}

export interface StartTaskDependencies {
  /** The Git seam. Required and never defaulted. */
  readonly git: GitRunner;
  /** The clock, read once for the durable write. */
  readonly now: () => string;
  /**
   * A **fresh** auth preflight, run before any workspace is created.
   *
   * Required rather than defaulted, deliberately: the real one starts the
   * Claude and Codex CLIs, and a default would mean any caller that forgot it
   * — including a test — silently spawned subscription agents. Making it an
   * argument forces every caller to state what it is proving.
   *
   * Returns the preflight's **evidence** rather than a verdict, and `null` when
   * it did not pass. Before V2-05 this returned `boolean`, which meant
   * `async () => true` satisfied it — a seam that forced a caller to *state*
   * something, not one that checked what was stated. The artefact cannot be
   * fabricated, so the only way to satisfy this now is to run a real preflight
   * or to inject a stub at a seam *above* evidence creation. Returning it also
   * lets the caller hand the same proof to `runTask` instead of paying for a
   * second preflight.
   */
  readonly authPreflight: () => Promise<AuthPreflightEvidence | null>;
  /**
   * Proof that this invocation holds the repository's execution lease.
   *
   * **Required, and deliberately not defaulted or optional.** A caller with
   * nothing to hand here cannot compile, which is the point: an execution lease
   * that some productive path simply does not ask for is not an execution lease.
   *
   * It is the same arrangement as {@link authPreflight}'s evidence and for the
   * same reason — the artefact cannot be written down, so satisfying this means
   * having really taken the lease. The two prove different things and neither
   * substitutes for the other: auth says the agents can run, the lease says this
   * process is the one allowed to run them *here*.
   */
  readonly lease: ExecutionLeaseEvidence;
  /** State-store seams, forwarded unchanged. */
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

export interface StartTaskResult {
  readonly outcome: StartTaskOutcome;
  readonly taskId: string;
  /** The receipt the first state was built from, or `null`. */
  readonly workspace: TaskWorkspace | null;
  /**
   * Whether something exists on disk that no durable state accounts for.
   *
   * `false` for almost every refusal, because almost every refusal happens
   * before anything is created. Two cases set it, and they are not the same
   * shape, which is why this is a field rather than something a caller derives
   * from {@link workspace}:
   *
   *  - `WORKSPACE_REFUSED` with `WORKTREE_ROLLBACK_INCOMPLETE` —
   *    `prepareTaskWorkspace` created a worktree, rejected it, and could not
   *    remove it again. There is no receipt, so `workspace` is `null`.
   *  - `STATE_NOT_RECORDED` — the workspace was created deliberately and the
   *    first durable write was then refused. The worktree is real, correct and
   *    orphaned: nothing records that it belongs to this task.
   *
   * Reported rather than tidied up. Removing a worktree is a destructive act
   * on a path this code has just failed to reason about, and
   * `remove-workspace.ts` makes the same argument about `--force`.
   */
  readonly residue: boolean;
  /** Stable codes explaining a non-`STARTED` outcome. Empty otherwise. */
  readonly reasonCodes: readonly string[];
}

function result(
  from: Partial<StartTaskResult> & {
    readonly outcome: StartTaskOutcome;
    readonly taskId: string;
  },
): StartTaskResult {
  return Object.freeze({
    workspace: null,
    residue: false,
    reasonCodes: Object.freeze([]),
    ...from,
  });
}

/**
 * The first durable state of a task, built entirely from the workspace receipt.
 *
 * Every identity field is one `prepareTaskWorkspace` verified from inside the
 * worktree it created. `state` is a literal: see the module header for why it
 * is not, and must not become, an argument.
 */
function firstState(
  workspace: TaskWorkspace,
  repository: ResolvedRepository,
  now: string,
): TaskStateInput {
  return {
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    taskId: workspace.taskId,
    repositoryId: workspace.repositoryId,
    repositoryRoot: workspace.repositoryRoot,
    worktreePath: workspace.worktreePath,
    state: 'WORKTREE_READY',
    stateEnteredAt: now,
    baseBranch: workspace.baseBranch,
    basePinnedCommit: workspace.basePinnedCommit,
    workBranch: workspace.workBranch,
    // A fresh worktree is at its base commit and has nothing in it to be
    // dirty; `prepareTaskWorkspace` verified both from inside it.
    currentCommit: workspace.basePinnedCommit,
    reviewRound: 0,
    // The repository's budget, never a constant of this module's choosing.
    maxReviewRounds: repository.completion.maxReviewRounds,
    blockedAgent: null,
    resumeFrom: null,
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: workspace.worktreeClean,
    findingHistory: [],
  };
}

/**
 * Starts one task, or explains why it did not start.
 *
 * Never throws for an expected condition. Every refusal arrives as data, and
 * every refusal before the durable write leaves the repository exactly as it
 * was found.
 */
export async function startTask(
  request: StartTaskRequest,
  deps: StartTaskDependencies,
): Promise<StartTaskResult> {
  const { repository, taskId } = request;
  const stop = (from: Partial<StartTaskResult> & { readonly outcome: StartTaskOutcome }) =>
    result({ taskId, ...from });

  // --- 0. May this invocation act on this repository at all? ---------------
  // Ahead of every other gate, including the cheap syntactic ones. Proven
  // against the file rather than against the artefact alone: evidence is a
  // record of a claim that was made, and a claim can have been cleared since.
  const lease = verifyExecutionLeaseHeld(deps.lease);
  if (lease.code !== 'HELD') {
    return stop({
      outcome: 'EXECUTION_LEASE_NOT_HELD',
      reasonCodes: Object.freeze([lease.code]),
    });
  }

  // --- 1. Is this a task at all, and may it run? ---------------------------
  if (!isValidTaskId(taskId)) return stop({ outcome: 'TASK_ID_INVALID' });

  const planning = planNextTask(repository);
  if (!planning.ok) {
    return stop({ outcome: 'PLANNING_FAILED', reasonCodes: Object.freeze([planning.code]) });
  }

  const eligibility = planning.selection.eligibility.find((entry) => entry.taskId === taskId);
  if (eligibility === undefined) return stop({ outcome: 'TASK_UNKNOWN' });
  if (!eligibility.eligible) {
    return stop({
      outcome: 'TASK_INELIGIBLE',
      reasonCodes: Object.freeze(
        eligibility.reason === null ? [] : [eligibility.reason],
      ),
    });
  }

  const task: TaskDefinition | undefined = planning.graph.node(taskId)?.definition;
  // Not reachable: an id with an eligibility entry is an id in the graph. A
  // fail-closed floor rather than an assertion, at the cost of one branch.
  if (task === undefined) return stop({ outcome: 'TASK_UNKNOWN' });

  // --- 2. Has it already been started? -------------------------------------
  // Read before anything is created, so a second invocation is a report rather
  // than a collision. The store would refuse the write anyway — creation is a
  // compare-and-swap against absence — but refusing here means the second
  // invocation also never touches Git.
  const existing = loadTaskState(repository.root, taskId);
  if (existing.classification === 'STATE_VALID') {
    return stop({ outcome: 'ALREADY_STARTED' });
  }
  if (existing.classification !== 'STATE_MISSING') {
    return stop({
      outcome: 'STATE_UNUSABLE',
      reasonCodes: Object.freeze(existing.ok ? [] : [existing.code]),
    });
  }

  // --- 3. Can this repository hold task state without dirtying itself? -----
  // Invariant 3, and it runs before the workspace so that a misconfigured
  // repository is told so without having a branch created in it first.
  const ignored = await checkRuntimeIgnored(deps.git, repository.root, taskId);
  if (ignored === 'NOT_IGNORED') return stop({ outcome: 'RUNTIME_NOT_IGNORED' });
  if (ignored === 'UNDETERMINED') return stop({ outcome: 'RUNTIME_IGNORE_UNDETERMINED' });

  // --- 4. Auth preflight, proven rather than assumed -----------------------
  // Verified with the same predicate the resume gate uses, so a cast fails
  // closed here too rather than only deeper in.
  const authEvidence = await deps.authPreflight();
  if (!isAuthPreflightEvidence(authEvidence)) {
    return stop({ outcome: 'AUTH_PREFLIGHT_FAILED' });
  }

  // --- 5. The workspace. The first thing that changes anything. ------------
  const prepared = await prepareTaskWorkspace(repository, task, { git: deps.git });

  // A collision may be this task's own crashed start. Only there is adoption
  // even asked about, so the ordinary path is unchanged and costs nothing
  // extra: a repository with nothing in the way never reaches this branch.
  let workspace: TaskWorkspace;
  let adopted = false;

  if (!prepared.ok) {
    if (!COLLISION_CODES.has(prepared.code)) {
      return stop({
        outcome: 'WORKSPACE_REFUSED',
        residue: prepared.residue,
        reasonCodes: Object.freeze([prepared.code]),
      });
    }

    const adoption = await assessWorkspaceAdoption(repository, taskId, { git: deps.git });
    if (adoption.verdict !== 'ADOPTABLE_PRISTINE_ORPHAN') {
      // The refusal now names *why* the thing in the way is not ours, which is
      // the difference between "delete a stale worktree" and "somebody is
      // working in there". Both codes are reported: what collided, and what the
      // recovery assessor concluded about it.
      return stop({
        outcome: 'WORKSPACE_COLLISION',
        residue: prepared.residue,
        reasonCodes: Object.freeze([prepared.code, adoption.verdict]),
      });
    }
    workspace = adoption.workspace;
    adopted = true;
  } else {
    workspace = prepared.workspace;
  }

  // --- 6. The first durable write ------------------------------------------
  // `expectedRevision` is omitted, which is the creation case: the writer read
  // nothing and expects nothing, and the save is refused if a state appeared
  // in the meantime. There is deliberately no force option to reach for.
  const saved = saveTaskState(firstState(workspace, repository, deps.now()), {
    repositoryRoot: repository.root,
    ...(deps.replace !== undefined ? { replace: deps.replace } : {}),
    ...(deps.tempSuffix !== undefined ? { tempSuffix: deps.tempSuffix } : {}),
  });

  if (!saved.ok) {
    return stop({
      outcome: 'STATE_NOT_RECORDED',
      workspace,
      // The worktree exists and nothing records that it is this task's. True of
      // an adopted workspace as well: the crash window is still open, and the
      // next attempt will find the same orphan and adopt it again.
      residue: true,
      reasonCodes: Object.freeze(saved.detail === null ? [saved.code] : [saved.code, saved.detail]),
    });
  }

  // `ADOPTED` reports how this invocation got its workspace, and nothing more.
  // The state on disk is byte-for-byte the one a fresh start writes — there is
  // no adopted flag in the contract and no second recovery lifeline — so from
  // the next step onwards the two are indistinguishable, by design.
  return stop({ outcome: adopted ? 'ADOPTED' : 'STARTED', workspace });
}
