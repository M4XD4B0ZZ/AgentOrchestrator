/**
 * The attended block run: something that actually runs a block.
 *
 * ── What this module is, and what it deliberately is not ───────────────────
 *
 * It composes primitives that already exist and invents no orchestration truth
 * of its own. The lease makes this invocation the repository's writer;
 * `startPlannedTask` prepares a workspace; `runTask` drives one task;
 * `block-progress.ts` records each outcome against the task's own durable record
 * and refuses anything the record does not prove. This module decides *sequence*,
 * and `block-conclusion.ts` decides *meaning*. Nothing here writes the ledger
 * directly.
 *
 * ── Two exits, and why one of them writes nothing ──────────────────────────
 *
 * A run distinguishes two classes of bad news:
 *
 *   class 1  a task failed          one task's own outcome, recorded with its
 *                                   evidence; the run continues with tasks
 *                                   already known to be independent
 *   class 2  the run cannot safely  the whole block stops immediately
 *            continue
 *
 * Class 2 then splits again, by **representability**. A ledger `stopReason` is
 * itself a durable claim, so a condition whose content is *this run can no
 * longer make durable claims* must not be expressed as one:
 *
 *   recordable    OPERATOR_STOPPED, LEDGER_DIVERGED, STATE_UNUSABLE,
 *                 DEFINITION_DRIFTED, ACTIVE_TASK_UNRESOLVED
 *                 -> `stopBlockRun`, and the ledger carries the ending
 *
 *   unrecordable  LEASE_AUTHORITY_UNCERTAIN — the run may no longer be the
 *                 writer, so any further mutation is exactly the act it has
 *                 lost the authority for;
 *                 DURABLE_WRITE_FAILED — the run cannot presuppose a successful
 *                 stop write, because the failed write is the condition;
 *                 RUN_GATE_REFUSED — a repository, auth or runtime gate refused,
 *                 which is a run abort and not task progress;
 *                 RECONCILIATION_UNRESOLVED — a forced reconciliation was no
 *                 longer forced when the primitive checked it
 *                 -> the ledger is left on its last provably durable state and
 *                 the truth reaches the operator through the report
 *
 * A runner that funnelled both through `stopBlockRun` would, in exactly the
 * cases where writing is what it cannot do, either fail loudly at the worst
 * moment or emit a claim it had no authority to make.
 *
 * "Left on its last provably durable state" is the exact claim, and it is
 * weaker than "nothing was written" on purpose. Every one of the four can strike
 * after this run has already recorded settlements — those are true and they
 * stay. What is missing from the ledger is only the ending. Two of them can
 * additionally strike before any ledger exists, which is a fact about where the
 * condition arose and not about what the outcome means.
 *
 * ── Attended only, and one task at a time ──────────────────────────────────
 *
 * Unattended running needs *owned process containment* — a Job Object, a
 * supervised process group — rather than merely the lease, and automatic
 * recovery of a stale lease stays refused until the orchestrator creates that
 * containment itself. Staying attended is what keeps that surface closed, and
 * it is the single most important scope line in this slice.
 *
 * The ledger enforces one `ACTIVE` task and this runner is sequential. "Several
 * independent tasks" is about surviving a sibling's failure, never about
 * concurrency.
 *
 * ── What this module may not compute ───────────────────────────────────────
 *
 * The dependency relation. `block-dependencies.ts` projects it once, at freeze
 * time — and this module does not import that one, and must not. A runner that
 * re-derived the relation would answer "may B continue after A?" from a roadmap
 * an operator can edit while the run is in flight, which is the opposite of
 * frozen-plan authority. It reads `ledger.frozenDependencies` and asks
 * `independenceIsEstablished` a question.
 *
 * The plan, either. This module never calls `planNextTask`; it receives the
 * caller's single reading as {@link AttendedBlockRequest.planning} and both
 * filters by it and hands it to `startPlannedTask`, so there is no gate below
 * here that could consult a second reading. Forbidding the import is not enough
 * on its own — the reason `startPlannedTask` exists is that the general start
 * path planned again on its own account, which put a mid-run roadmap edit back
 * in charge of what runs while every module in `src/block/` looked innocent.
 *
 * Both names were once deliberately left out of this file, because both
 * properties were pinned by a substring grep over `src/` and a prose mention
 * would have turned a zero-match pin into a list a reader has to adjudicate.
 * That was a module made less clear to keep a count at zero, and the count was
 * measuring the wrong thing anyway: a grep sees that a file *says a word*, not
 * that it *depends on a module*.
 *
 * What backs each claim now, stated exactly rather than jointly, because the two
 * take different instruments. Both are pinned over **imports**, in
 * `tests/v2-08-attended-block-runner.test.ts`. The relation: the projection's
 * exports have one production importer, the CLI freeze site, so this module
 * reaching them fails there. The plan: no module under `src/block/` may import a
 * planner value export — neither at the planner's own module path nor laundered
 * through a re-export that keeps the name, which is why that pin is a
 * path-scoped scan and a name-scoped one rather than either alone — while the
 * type-only import of `TaskPlanningSuccess` this module legitimately needs stays
 * green. Both directions were established by mutation, the false-positive one
 * included. A re-export that *renames* on the way through walks past both: the
 * pair closes the routes measured there and is not a reachability proof, for
 * which a real one wants the compiler.
 *
 * Underneath the import pins sits the effect one layer down: `startPlannedTask`
 * has no way to take a reading of its own, so there is no gate below here that
 * could consult a second one.
 *
 * One consequence, stated rather than left to be discovered: **a mid-run edit is
 * invisible to this invocation, in both directions.** It cannot stop a member
 * that was eligible when the operator asked, and it cannot make one runnable
 * that was not. There is no drift check between tasks, and none when the run
 * opens either: the ledger is created from the plan the caller just froze, so
 * there is nothing to compare it against. That is the cost of the rule above and
 * it is recorded in the follow-up register as F-B1.
 */

import type { AgentRunner } from '../agent/agent-command.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import type { ExecutionLeaseEvidence } from '../core/execution-lease-evidence.js';
import { verifyExecutionLeaseHeldFor } from '../lease/execution-lease.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import type { TaskPlanningSuccess } from '../plan/plan-next-task.js';
import { runTask, type RunOutcome, type RunResult } from '../run/run-driver.js';
import { startPlannedTask } from '../run/start-task.js';
import type { ReplaceFn, TempSuffixFn } from '../state/atomic-file.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import type { GitRunner } from '../worktree/git-command.js';
import {
  conclusionForRunOutcome,
  endReasonFor,
  independenceIsEstablished,
  recordingResultFor,
  startConclusionFor,
} from './block-conclusion.js';
import type { BlockDefinition } from './block-definition.js';
import {
  entryFor,
  type BlockRunLedger,
  type BlockStopReason,
  type TaskDisposition,
} from './block-ledger.js';
import {
  abandonBlockTask,
  activateBlockTask,
  parkBlockTask,
  settleBlockTask,
  startBlockRun,
  stopBlockRun,
  type BlockProgressOptions,
  type BlockProgressResult,
} from './block-progress.js';
import { loadBlockLedger, type LedgerLoadSuccess } from './block-store.js';
import { reconcileBlockRun } from './reconcile-block.js';

/**
 * How an attended block run ended. A closed set.
 *
 * One outcome is recorded in the ledger and four are not. **"Not recorded" is
 * not "nothing was written":** every one of the four is reachable after tasks
 * have already been settled, parked or abandoned in this run, and those records
 * are true and stay. What none of the four does is add a stop claim — the ledger
 * is left at its last provably durable state, byte for byte across the
 * condition, and the ending reaches the operator through the report instead.
 */
export const BLOCK_RUN_OUTCOMES = [
  /** The ledger carries the ending. {@link AttendedBlockResult.stopReason} says which. */
  'BLOCK_RUN_ENDED',
  /**
   * This run may no longer be the repository's writer.
   *
   * Not recorded: any further mutation is precisely the act the run has lost the
   * authority for. Whatever it recorded while it *was* the writer stands.
   */
  'LEASE_AUTHORITY_UNCERTAIN',
  /**
   * A durable write was not possible.
   *
   * Not recorded, and it could not be: the failed write is the condition. The
   * ledger is whatever last landed — possibly nothing at all, if the failure
   * struck the creation.
   */
  'DURABLE_WRITE_FAILED',
  /**
   * A repository, auth or runtime gate refused.
   *
   * Not recorded, because a gate refusal is a run abort and not task progress —
   * and not a claim about the outcome of the task it refused to start, which
   * stays `PLANNED`. Reachable both before the ledger exists (the auth preflight,
   * ahead of `openRun`) and after it (a workspace, runtime or auth gate met
   * between two tasks), so it says nothing about how much this run wrote — only
   * that the refusal itself was not written down as an ending.
   */
  'RUN_GATE_REFUSED',
  /**
   * A reconciliation that was forced when it was read was not forced when it was
   * applied.
   *
   * The evidence moved between the reconciliation read and the authoritative
   * primitive's own check: the primitive refused the claim the reconciliation had
   * established. Nothing is repaired and nothing is retried — a second read and a
   * second decision is how a refusal gets laundered.
   *
   * Its own outcome rather than `DURABLE_WRITE_FAILED`, which would tell an
   * operator to go and fix a disk that is working, and rather than
   * `ACTIVE_TASK_UNRESOLVED`, which is a persisted claim about an `ACTIVE` task
   * while forced reconciliation only ever touches `PLANNED` ones. Not persisted,
   * so it needs no ledger schema change.
   */
  'RECONCILIATION_UNRESOLVED',
] as const;

export type BlockRunOutcome = (typeof BLOCK_RUN_OUTCOMES)[number];

export interface BlockTaskReport {
  readonly taskId: string;
  /** As persisted when the run ended. */
  readonly disposition: TaskDisposition;
  /** The driver's answer for this task, or `null` if it was never driven. */
  readonly runOutcome: RunOutcome | null;
}

export interface AttendedBlockResult {
  readonly outcome: BlockRunOutcome;
  /** The reason recorded in the ledger, or `null` when none was written. */
  readonly stopReason: BlockStopReason | null;
  /**
   * The gate, save or load code behind the outcome.
   *
   * An allow-listed code from another module's closed vocabulary. Never a
   * message, never a path.
   */
  readonly detail: string | null;
  readonly runId: string;
  readonly blockId: string;
  readonly tasks: readonly BlockTaskReport[];
  /** Durable task steps this invocation landed, across every task. */
  readonly steps: number;
}

export interface AttendedBlockRequest {
  readonly repository: ResolvedRepository;
  /**
   * The plan, **already frozen**. This module never projects one.
   *
   * Frozen by the caller from {@link planning}, under the same lease, before the
   * run opened. It is not compared against anything here: there is no resume, so
   * there is no persisted predecessor a fingerprint could differ from.
   */
  readonly definition: BlockDefinition;
  /** Identity of this run. A previous run's record is never overwritten. */
  readonly runId: string;
  /**
   * Proof that this invocation holds the repository's execution lease.
   *
   * Required and never nullable, for the reason `RunRequest.lease` states: a
   * run that is not the repository's writer must not drive a task at all, so
   * "no lease" is not a weaker mode of running. Taken by the caller and held
   * across the whole block — never per task, which would leave a window between
   * tasks that an execution lease exists to close.
   */
  readonly lease: ExecutionLeaseEvidence;
  /**
   * The bound on durable steps per **one `runTask` call**, forwarded as-is.
   *
   * Not a bound on the task and not a bound on the run. Reaching it means the
   * driver stopped after durable progress, and the runner drives the same task
   * again under the same lease — see `TASK_CONCLUSIONS`' `CONTINUE`.
   */
  readonly maxStepsPerTask: number;
  /**
   * The caller's **one** reading of the roadmap, taken under the lease.
   *
   * The whole `TaskPlanningSuccess`, not a list of eligible ids. Two things come
   * out of it and they must come out of the same object: the set this runner
   * filters candidates by, and the authority `startPlannedTask` gates each start
   * against. A list handed in beside a plan read somewhere else is two readings
   * that can disagree, and the disagreement would surface as `TASK_INELIGIBLE`
   * for a task this run had already chosen.
   *
   * Handed in rather than computed, which is what makes "the runner does not
   * re-read the plan" structural instead of disciplinary: this module imports no
   * planner, and the start path it uses cannot take a reading of its own. The
   * caller projects the frozen relation from this same result, so plan,
   * relation, eligibility and every start gate are one snapshot at one instant.
   *
   * A caller cannot widen it in any useful way either. Eligibility is read from
   * `planning.selection.eligibility` here and again inside `startPlannedTask`,
   * and the workspace is prepared from `planning.graph`'s definition — so a
   * forged snapshot is not a task started against the repository's plan, it is a
   * task started against a plan the caller wrote, which the lease and the
   * repository's own files still bound.
   */
  readonly planning: TaskPlanningSuccess;
}

export interface AttendedBlockDependencies {
  readonly now: () => string;
  readonly git: GitRunner;
  /**
   * The auth preflight, run at most once per invocation by the caller's
   * memoising seam. Returning `null` is a gate refusal for the whole run.
   */
  readonly authPreflight: () => Promise<AuthPreflightEvidence | null>;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
  /**
   * Write seams for the **ledger**, kept apart from the task-state ones below.
   *
   * Deliberately two pairs rather than one. A single pair would make a test of
   * `DURABLE_WRITE_FAILED` unable to fail the ledger write without also failing
   * every task-state write, so the case would prove that a broken disk breaks
   * everything rather than that a failed ledger write is reported honestly.
   * Neither seam can make a write *succeed* that would not have.
   */
  readonly ledgerReplace?: ReplaceFn;
  readonly ledgerTempSuffix?: TempSuffixFn;
  readonly replace?: ReplaceFn;
  readonly tempSuffix?: TempSuffixFn;
}

/* ─────────────────────────── the run ────────────────────────────────────── */

export async function runAttendedBlock(
  request: AttendedBlockRequest,
  deps: AttendedBlockDependencies,
): Promise<AttendedBlockResult> {
  const { repository, definition, runId } = request;
  const ledgerOptions: BlockProgressOptions = {
    repositoryRoot: repository.root,
    ...(deps.ledgerReplace !== undefined ? { replace: deps.ledgerReplace } : {}),
    ...(deps.ledgerTempSuffix !== undefined ? { tempSuffix: deps.ledgerTempSuffix } : {}),
  };

  const state = new RunState(runId, definition.blockId);

  // The gates, before anything durable. Auth is a statement about the machine
  // and the lease is a statement about who may write; neither implies the other
  // and neither is a task outcome, so both refuse through the report.
  const evidence = await deps.authPreflight();
  if (evidence === null) return state.gateRefused('AUTH_PREFLIGHT_FAILED');

  const opened = openRun(request, deps.now, ledgerOptions);
  if (opened.kind !== 'OPEN') return state.from(opened);

  let current = opened.ledger;
  state.seen(current.ledger);

  // The eligibility snapshot, derived from the caller's one reading and not
  // re-read here — nor taken as a second argument that could disagree with it.
  const eligible = new Set(
    request.planning.selection.eligibility
      .filter((entry) => entry.eligible)
      .map((entry) => entry.taskId),
  );

  for (;;) {
    // The lease, re-proved every iteration rather than trusted once. A step is
    // a subprocess that took minutes, and a lease taken before it is not a
    // lease held after it.
    const held = verifyExecutionLeaseHeldFor(repository, request.lease);
    if (held.code !== 'HELD') return state.leaseUncertain(held.code);

    // The ledger against the records, every iteration. This is what stops a run
    // adding a well-proved step to a record that is already unsupported.
    const checked = checkRecords(current.ledger, repository.root);
    if (checked !== null) return state.stop(current, checked, ledgerOptions);

    // Progress the ledger has not caught up with, applied only where it is
    // forced — see `applyForcedProgress`.
    const reconciled = applyForcedProgress(current, repository.root, ledgerOptions);
    if (reconciled.kind !== 'OPEN') return state.from(reconciled);
    current = reconciled.ledger;
    state.seen(current.ledger);

    const next = chooseTask(current.ledger, eligible);
    if (next.kind === 'NONE') {
      return state.stop(current, endReasonFor(current.ledger.tasks), ledgerOptions);
    }

    const driven = await driveOneTask(next.taskId, current, request, deps, ledgerOptions, evidence);
    // Recorded before the exit is taken, so a run that ends on this task still
    // reports what the driver said about it and what it cost.
    state.record(next.taskId, driven.runOutcome, driven.steps);
    if (driven.step.kind !== 'OPEN') return state.from(driven.step);
    current = driven.step.ledger;
    state.seen(current.ledger);

    // A task-local failure ends the task, not the run — but only where the
    // frozen plan says the rest are independent. Read, never derived.
    const entry = entryFor(current.ledger, next.taskId);
    const failedLocally = entry?.disposition === 'BLOCKED' || entry?.disposition === 'ABANDONED';
    if (failedLocally && !independenceIsEstablished(current.ledger.frozenDependencies)) {
      // The V2-07 behaviour, which is proved. Not an improvised ordering.
      return state.stop(current, endReasonFor(current.ledger.tasks), ledgerOptions);
    }
  }
}

/* ────────────────────── the small vocabulary of a step ───────────────────── */

/**
 * Either the run is still open on a ledger, or it is over and this is how.
 *
 * `STOPPED` and `ENDED` are two kinds rather than one because they differ in
 * exactly the thing an operator needs: a stop landed in the ledger and carries
 * the reason it recorded, while an end happened in the report and carries the
 * code that caused it. A single kind would let a helper end a run without
 * naming why, which is the one thing this vocabulary exists to prevent.
 */
type RunStep =
  | { readonly kind: 'OPEN'; readonly ledger: LedgerLoadSuccess }
  | {
      readonly kind: 'STOPPED';
      readonly reason: BlockStopReason;
      /** The ledger as written, so the report reads dispositions from it. */
      readonly ledger: BlockRunLedger | null;
    }
  | {
      readonly kind: 'ENDED';
      readonly outcome: BlockRunOutcome;
      readonly detail: string | null;
    };

/** The two kinds that mean the run is over, however it got there. */
type FinishedStep = Extract<RunStep, { kind: 'STOPPED' } | { kind: 'ENDED' }>;

interface DrivenStep {
  readonly step: RunStep;
  /** The driver's answer, when it got as far as driving. */
  readonly runOutcome: RunOutcome | null;
  readonly steps: number;
}

type TaskChoice =
  | { readonly kind: 'TASK'; readonly taskId: string }
  | { readonly kind: 'NONE' };

const ended = (outcome: BlockRunOutcome, detail: string | null): FinishedStep =>
  Object.freeze({ kind: 'ENDED' as const, outcome, detail });

/** The store's code behind a refused progress call, or `null`. */
function saveDetail(progress: BlockProgressResult): string | null {
  if (progress.save === null || progress.save.ok) return null;
  return progress.save.detail === null ? progress.save.code : `${progress.save.code}:${progress.save.detail}`;
}

/* ────────────────────────── what the run accumulates ─────────────────────── */

/**
 * What this invocation has seen, and how it renders an ending.
 *
 * Deliberately not a place where anything is decided: it holds the last ledger
 * it was shown and the driver's answer per task, so that every exit produces the
 * same report shape. The dispositions come from the ledger rather than from
 * anything remembered here — the persisted record is the answer, and a report
 * built from a runner's memory could disagree with it.
 */
class RunState {
  private readonly runOutcomes = new Map<string, RunOutcome>();
  private ledger: BlockRunLedger | null = null;
  private stepsTaken = 0;

  constructor(
    private readonly runId: string,
    private readonly blockId: string,
  ) {}

  seen(ledger: BlockRunLedger): void {
    this.ledger = ledger;
  }

  record(taskId: string, outcome: RunOutcome | null, steps: number): void {
    if (outcome !== null) this.runOutcomes.set(taskId, outcome);
    this.stepsTaken += steps;
  }

  private result(
    outcome: BlockRunOutcome,
    stopReason: BlockStopReason | null,
    detail: string | null,
  ): AttendedBlockResult {
    return Object.freeze({
      outcome,
      stopReason,
      detail,
      runId: this.runId,
      blockId: this.blockId,
      steps: this.stepsTaken,
      tasks: Object.freeze(
        (this.ledger?.tasks ?? []).map((entry) =>
          Object.freeze({
            taskId: entry.taskId,
            disposition: entry.disposition,
            runOutcome: this.runOutcomes.get(entry.taskId) ?? null,
          }),
        ),
      ),
    });
  }

  gateRefused(detail: string | null): AttendedBlockResult {
    return this.result('RUN_GATE_REFUSED', null, detail);
  }

  leaseUncertain(detail: string): AttendedBlockResult {
    return this.result('LEASE_AUTHORITY_UNCERTAIN', null, detail);
  }

  writeFailed(detail: string | null): AttendedBlockResult {
    return this.result('DURABLE_WRITE_FAILED', null, detail);
  }

  /** A finished step, rendered. Never called with an open or drifted one. */
  from(step: FinishedStep): AttendedBlockResult {
    if (step.kind === 'STOPPED') {
      if (step.ledger !== null) this.seen(step.ledger);
      return this.result('BLOCK_RUN_ENDED', step.reason, null);
    }
    return this.result(step.outcome, null, step.detail);
  }

  /**
   * Writes the ending, and grades the write.
   *
   * The only path in this module that writes a stop reason. A stop write that
   * did not land is not an ending: reporting `BLOCK_RUN_ENDED` for it would be
   * the run claiming an ending it failed to record.
   */
  stop(
    current: LedgerLoadSuccess,
    reason: BlockStopReason,
    options: BlockProgressOptions,
  ): AttendedBlockResult {
    const stopped = stopBlockRun(current, reason, options);
    if (stopped.outcome !== 'RECORDED') {
      return this.writeFailed(saveDetail(stopped) ?? stopped.outcome);
    }
    if (stopped.ledger !== null) this.seen(stopped.ledger);
    return this.result('BLOCK_RUN_ENDED', reason, null);
  }
}

/* ─────────────────────────────── opening ─────────────────────────────────── */

/**
 * Creates the ledger of this run. There is **no resume**.
 *
 * A block run's lifetime is its invocation's lifetime, because the lease
 * guarantee is stated over a whole block run: an open run that outlived the
 * process holding its lease would be a durable run with no holder, and the only
 * ways to avoid that are to leave a lease behind — the stale-lease surface this
 * slice may not reopen — or to let a later invocation adopt a run it never
 * started.
 *
 * So `startBlockRun`'s existing refusal *is* the answer: a run id that already
 * has a ledger belongs to an invocation that is over, whether it stopped
 * cleanly or was interrupted, and that record is not overwritten. An operator
 * continues by starting a new run id.
 *
 * One consequence, stated because it removes a reason from this runner's reach:
 * `DEFINITION_DRIFTED` has no producer here. Drift compares a frozen plan with a
 * current one, and inside a single invocation the ledger is created from the
 * plan the caller just froze. `reconcileBlockRun` still reports it to a caller
 * that supplies a definition.
 */
function openRun(
  request: AttendedBlockRequest,
  now: () => string,
  options: BlockProgressOptions,
): RunStep {
  const { repository, definition, runId } = request;

  const created = startBlockRun(
    {
      definition,
      repositoryId: repository.id,
      repositoryRoot: repository.root,
      runId,
      now: now(),
    },
    options,
  );
  if (!created.ok) {
    const detail = created.detail === null ? created.code : `${created.code}:${created.detail}`;
    // A write that could not be made is the condition `DURABLE_WRITE_FAILED`
    // names, and there is no ledger to record it in.
    if (created.code === 'WRITE_FAILED' || created.code === 'DIRECTORY_CREATE_FAILED') {
      return ended('DURABLE_WRITE_FAILED', detail);
    }
    // Everything else is a gate: this run id already has a record, or the
    // document does not name this checkout. Reported under the run id's own
    // token, because "that id is taken" is what the operator has to act on.
    return ended(
      'RUN_GATE_REFUSED',
      created.code === 'LEDGER_CONFLICT' ? 'RUN_ID_ALREADY_USED' : detail,
    );
  }

  const reloaded = loadBlockLedger(repository.root, runId);
  if (!reloaded.ok) return ended('RUN_GATE_REFUSED', reloaded.code);
  return Object.freeze({ kind: 'OPEN' as const, ledger: reloaded });
}

/* ───────────────────────── the records, every iteration ──────────────────── */

/**
 * The stop reason the task records force, or `null` when they support the
 * ledger.
 *
 * `STATE_UNUSABLE` beats `LEDGER_DIVERGED` where both apply. "A record cannot be
 * read" is a more specific fact than "the ledger and the records disagree", and
 * the two send an operator to different places — which is the same
 * cause-beats-consequence rule the end reason follows.
 */
function checkRecords(ledger: BlockRunLedger, repositoryRoot: string): BlockStopReason | null {
  const reconciliation = reconcileBlockRun(ledger, { repositoryRoot });
  if (reconciliation.verdict !== 'DIVERGED') return null;
  return reconciliation.findings.some((entry) => entry.finding === 'TASK_STATE_UNUSABLE')
    ? 'STATE_UNUSABLE'
    : 'LEDGER_DIVERGED';
}

/* ──────────────────────── forced positive reconciliation ─────────────────── */

/**
 * Records progress the ledger has not caught up with — and only where it is
 * forced.
 *
 * Permitted for a **`PLANNED`** entry whose own record has reached
 * `READY_FOR_PR`, and nothing else. All six conditions hold there: the change is
 * determined by durable evidence that already exists, there is exactly one
 * admissible successor, it is monotone, it invents no evidence, the ordinary
 * primitive accepts it on its existing proofs, and applying it twice changes
 * nothing (`settleBlockTask` answers `DISPOSITION_UNCHANGED` the second time).
 *
 * An `ACTIVE` entry is deliberately excluded even when its record says
 * `READY_FOR_PR`. That task is this run's own business, and choosing between
 * "drive it" and "declare it finished" is a *choice* — the moment the six
 * conditions stop holding. It is driven instead, and the driver's answer decides.
 *
 * Applied through `settleBlockTask` rather than by writing the ledger. A repair
 * path that bypassed the primitive would be a second, weaker way to assert
 * progress: the one thing the ledger exists to prevent.
 *
 * Exported for one reason: the repair-versus-choice line is the whole of this
 * slice's answer to "which positive reconciliations may be applied alone", and
 * the runner reaches an `ACTIVE` entry only through its own activation — which
 * it then concludes in the same iteration. So the run-level path cannot hold
 * "applied because forced" and "refused because it would be a choice" apart,
 * and a decision that cannot be inspected cannot be reviewed.
 *
 * It is not part of any consumer's API. `block-command.ts` calls
 * `runAttendedBlock` and nothing else.
 */
export function applyForcedProgress(
  current: LedgerLoadSuccess,
  repositoryRoot: string,
  options: BlockProgressOptions,
): RunStep {
  let ledger = current;

  for (;;) {
    const reconciliation = reconcileBlockRun(ledger.ledger, { repositoryRoot });
    if (!reconciliation.progressAvailable) {
      return Object.freeze({ kind: 'OPEN' as const, ledger });
    }

    const forced = reconciliation.findings.find(
      (finding) =>
        finding.finding === 'TASK_AHEAD_OF_LEDGER' &&
        entryFor(ledger.ledger, finding.taskId)?.disposition === 'PLANNED',
    );
    if (forced === undefined) return Object.freeze({ kind: 'OPEN' as const, ledger });

    const settled = settleBlockTask(ledger, forced.taskId, options);
    const graded = recordingResultFor(settled.outcome);
    // Four grades, four endings. Collapsing the last three into one would report
    // a proof race as a broken disk, which is the misdescription class this
    // whole slice is organised against — an operator told DURABLE_WRITE_FAILED
    // goes to look at permissions, and there is nothing wrong with the disk.
    if (graded === 'WRITE_FAILED') return ended('DURABLE_WRITE_FAILED', saveDetail(settled));
    // A record that exists and cannot be used is a fact about the record, and
    // the ledger has a persisted reason for exactly that.
    if (graded === 'STATE_UNUSABLE') return stopStep(ledger, 'STATE_UNUSABLE', options);
    if (graded !== 'RECORDED') {
      // The reconciliation was forced when it was read and the authoritative
      // primitive did not confirm it at the commit: the evidence moved between
      // the two reads. Do not repair, and do not try again — a second read and a
      // second decision is how a refusal gets laundered.
      //
      // Reported rather than recorded, and under its own name.
      // `ACTIVE_TASK_UNRESOLVED` would be wrong twice over: this entry is
      // `PLANNED`, never `ACTIVE` — `applyForcedProgress` refuses `ACTIVE`
      // entries by construction — and it is a persisted claim, which is the one
      // thing a run whose evidence just moved under it should not be making.
      return ended('RECONCILIATION_UNRESOLVED', settled.outcome);
    }

    const reloaded = loadBlockLedger(repositoryRoot, ledger.ledger.runId);
    if (!reloaded.ok) return ended('RUN_GATE_REFUSED', reloaded.code);
    ledger = reloaded;
  }
}

/* ───────────────────────────── choosing a task ───────────────────────────── */

/**
 * The next task to drive, or that there is not one.
 *
 * The candidates are the `PLANNED` members, in frozen order, filtered by the
 * **snapshot** of the repository's own eligibility report that the caller took
 * before the run. Two properties, and both are deliberate:
 *
 * The filter is not answered from `frozenDependencies`. A member with no frozen
 * block-member dependency may still be waiting on a non-member, and a runner
 * reading "no frozen edge" as "eligible" would start a task the repository says
 * cannot run. The frozen relation answers independence; the planner answers
 * eligibility; folding either into the other loses one of the two.
 *
 * And it is a snapshot rather than a fresh reading. This module imports no
 * planner, and the task it picks is started through `startPlannedTask`, which
 * gates against the very same reading — so there is no moment at which an edited
 * roadmap could change which task runs next, in this function or below it. The
 * invocation acts on the plan as it was when the operator asked for it, which is
 * the same instant the relation was frozen at and the lease was taken.
 *
 * There is no `ACTIVE` arm, and there cannot be one: a task becomes `ACTIVE`
 * only when this loop activates it, and it is concluded before the next
 * iteration. An `ACTIVE` entry at the top of an iteration would mean a resumed
 * run, which this runner does not have.
 */
function chooseTask(ledger: BlockRunLedger, eligible: ReadonlySet<string>): TaskChoice {
  for (const entry of ledger.tasks) {
    if (entry.disposition !== 'PLANNED') continue;
    if (!eligible.has(entry.taskId)) continue;
    return Object.freeze({ kind: 'TASK' as const, taskId: entry.taskId });
  }

  return Object.freeze({ kind: 'NONE' as const });
}

/* ───────────────────────────── driving one task ──────────────────────────── */

/**
 * Starts the task if it needs starting, drives it, and records what its own
 * record proves.
 *
 * The order `startPlannedTask` → `activateBlockTask` → `runTask` →
 * settle/park/abandon is forced rather than chosen: activation copies the task
 * state's own base pin into the entry, so a durable state has to exist before
 * the ledger can say the run is working on it.
 *
 * Every recording attempt is graded through `recordingResultFor`, and the three
 * non-`RECORDED` grades are three different endings — a failed write is
 * reported, an unusable record and an unestablished outcome are recorded.
 */
async function driveOneTask(
  taskId: string,
  current: LedgerLoadSuccess,
  request: AttendedBlockRequest,
  deps: AttendedBlockDependencies,
  options: BlockProgressOptions,
  evidence: AuthPreflightEvidence,
): Promise<DrivenStep> {
  const { repository, lease, maxStepsPerTask } = request;
  const nothing = (step: RunStep): DrivenStep => ({ step, runOutcome: null, steps: 0 });

  // `startPlannedTask`, never the planning start path: the gates below this line
  // are answered from the reading the block was frozen against. A start that
  // planned again would refuse `TASK_INELIGIBLE` for a task this run
  // legitimately chose, and a roadmap edited mid-run would be back in charge of
  // what runs.
  const start = await startPlannedTask(
    // The base and the widening this runner has always used, now said out loud.
    // Task 7 of V2-09 replaces both — the block base for a root member, a proved
    // predecessor result and the settlements that unlocked it for a chained one;
    // until then this is V2-08's behaviour, unchanged and merely explicit.
    {
      repository,
      taskId,
      planning: request.planning,
      base: { kind: 'DEFAULT_BRANCH_TIP' },
      satisfiedDependencies: [],
      scopeAuthorityCommit: null,
    },
    { git: deps.git, now: deps.now, authPreflight: deps.authPreflight, lease },
  );
  const startConclusion = startConclusionFor(start.outcome);
  if (startConclusion === 'LEASE_UNCERTAIN') {
    return nothing(ended('LEASE_AUTHORITY_UNCERTAIN', start.outcome));
  }
  if (startConclusion === 'STATE_UNUSABLE') {
    return nothing(stopStep(current, 'STATE_UNUSABLE', options));
  }
  if (startConclusion === 'GATE_REFUSED') {
    return nothing(ended('RUN_GATE_REFUSED', start.outcome));
  }

  // Activation. The guard is a fail-closed floor rather than a branch that runs:
  // `chooseTask` only ever returns a `PLANNED` entry, and a `PLANNED` entry is
  // never the active one. There is no resume, so there is no path on which this
  // run finds its own task already `ACTIVE`.
  let ledger = current;
  if (ledger.ledger.activeTaskId !== taskId) {
    const activated = activateBlockTask(ledger, taskId, options);
    const graded = recordingResultFor(activated.outcome);
    if (graded === 'WRITE_FAILED') {
      return nothing(ended('DURABLE_WRITE_FAILED', saveDetail(activated)));
    }
    if (graded === 'STATE_UNUSABLE') return nothing(stopStep(ledger, 'STATE_UNUSABLE', options));
    if (graded !== 'RECORDED') {
      return nothing(stopStep(ledger, 'ACTIVE_TASK_UNRESOLVED', options));
    }
    const reloaded = loadBlockLedger(repository.root, ledger.ledger.runId);
    if (!reloaded.ok) return nothing(ended('RUN_GATE_REFUSED', reloaded.code));
    ledger = reloaded;
  }

  const drive = (): Promise<RunResult> =>
    runTask(
      {
        repository,
        taskId,
        // The task id, which is all this module legitimately has. The prose the
        // agents receive is read inside the driver, from the worktree it
        // authorised, so nothing here authors a prompt.
        taskBrief: taskId,
        attendedContinuation: true,
        authEvidence: evidence,
        lease,
        maxSteps: maxStepsPerTask,
      },
      {
        now: deps.now,
        git: deps.git,
        ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
        ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
        ...(deps.replace !== undefined ? { replace: deps.replace } : {}),
        ...(deps.tempSuffix !== undefined ? { tempSuffix: deps.tempSuffix } : {}),
      },
    );

  // The drive, continued under the same lease for as long as the *driver's* own
  // per-call bound is what stopped it. `maxSteps` exists so one `runTask` call
  // cannot run away; it is not a statement about the task, and the block run
  // may not end on it — a run that ended here would either misdescribe a
  // scheduling limit as a task-outcome claim or need to outlive its lease.
  let run = await drive();
  let steps = run.steps;
  let conclusion = conclusionForRunOutcome(run.outcome);

  while (conclusion === 'CONTINUE') {
    // A continuation that landed nothing would repeat itself for ever, and the
    // task's outcome is then genuinely not established. This is the floor that
    // makes the loop terminate without a counter nobody can justify: every
    // other continuation carries durable progress, and the task's own state
    // machine is bounded by the repository's `maxReviewRounds`.
    if (run.steps === 0) {
      return { step: stopStep(ledger, 'ACTIVE_TASK_UNRESOLVED', options), runOutcome: run.outcome, steps };
    }
    // The lease, between continuations too. The call that just returned was
    // minutes of subprocess, and a lease taken before it is not a lease held
    // after it.
    const stillHeld = verifyExecutionLeaseHeldFor(repository, lease);
    if (stillHeld.code !== 'HELD') {
      return { step: ended('LEASE_AUTHORITY_UNCERTAIN', stillHeld.code), runOutcome: run.outcome, steps };
    }
    run = await drive();
    steps += run.steps;
    conclusion = conclusionForRunOutcome(run.outcome);
  }

  const driven = (step: RunStep): DrivenStep => ({ step, runOutcome: run.outcome, steps });

  if (conclusion === 'LEASE_UNCERTAIN') {
    return driven(ended('LEASE_AUTHORITY_UNCERTAIN', run.outcome));
  }
  if (conclusion === 'STATE_UNUSABLE') {
    return driven(stopStep(ledger, 'STATE_UNUSABLE', options));
  }
  if (conclusion === 'UNRESOLVED') {
    return driven(stopStep(ledger, 'ACTIVE_TASK_UNRESOLVED', options));
  }

  const record =
    conclusion === 'SETTLE'
      ? settleBlockTask(ledger, taskId, options)
      : conclusion === 'PARK'
        ? parkBlockTask(ledger, taskId, options)
        : abandonBlockTask(ledger, taskId, options);

  const graded = recordingResultFor(record.outcome);
  if (graded === 'WRITE_FAILED') return driven(ended('DURABLE_WRITE_FAILED', saveDetail(record)));
  if (graded === 'STATE_UNUSABLE') return driven(stopStep(ledger, 'STATE_UNUSABLE', options));
  if (graded !== 'RECORDED') return driven(stopStep(ledger, 'ACTIVE_TASK_UNRESOLVED', options));

  const reloaded = loadBlockLedger(repository.root, ledger.ledger.runId);
  if (!reloaded.ok) return driven(ended('RUN_GATE_REFUSED', reloaded.code));
  return { step: Object.freeze({ kind: 'OPEN' as const, ledger: reloaded }), runOutcome: run.outcome, steps };
}

/**
 * A stop, expressed as a step so the helpers above can end a run.
 *
 * It writes through `stopBlockRun` and grades the write exactly as
 * `RunState.stop` does; the duplication is one line and the alternative — a
 * helper that returns "please stop with this reason" and a caller that might
 * forget to — is the shape where an ending is decided and never recorded.
 */
function stopStep(
  current: LedgerLoadSuccess,
  reason: BlockStopReason,
  options: BlockProgressOptions,
): FinishedStep {
  const stopped = stopBlockRun(current, reason, options);
  if (stopped.outcome !== 'RECORDED') {
    return ended('DURABLE_WRITE_FAILED', saveDetail(stopped) ?? stopped.outcome);
  }
  return Object.freeze({ kind: 'STOPPED' as const, reason, ledger: stopped.ledger });
}
