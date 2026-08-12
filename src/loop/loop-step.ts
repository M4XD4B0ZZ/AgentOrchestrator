/**
 * The governed verify → review → remediate loop.
 *
 * ── One step, one durable write ────────────────────────────────────────────
 *
 * Every function here performs **at most one** `advanceTaskState` call, and
 * returns immediately afterwards. That is the single structural decision this
 * module rests on, and three otherwise separate problems fall out of it:
 *
 *  - **Crash safety.** There is no window in which a step has written half of
 *    its progress. Either the one write landed or it did not, and a restart
 *    reads a state that is exactly one of the two.
 *  - **Compare-and-swap.** `advanceTaskState` threads `expectedRevision` from
 *    the `StateLoadSuccess` it was handed. A step that wrote twice would have to
 *    re-derive a revision for its second write, and the obvious way to do that —
 *    re-reading the file — is precisely how a stale-writer refusal gets
 *    laundered into a successful overwrite. Never writing twice means never
 *    needing the re-read.
 *  - **Resumability.** A driver re-loads the state and calls back in. Progress
 *    lives on disk, never in a closure, so a driver that dies between steps
 *    loses nothing but the in-memory payload — and {@link runRemediateStep}
 *    says so in the prompt when that happens.
 *
 * ── Why the loop stops at a failed verification ────────────────────────────
 *
 * `VERIFYING → BLOCKED_VERIFY` is taken, and then nothing further happens
 * automatically. `BLOCKED_VERIFY` is `resumable: true` but
 * `automaticResumeEligible: false` (`core/resume-policy.ts`), with the reason
 * stated there: *"Resuming means handing the failure to the writing agent for
 * remediation, which is a decision, not an automatic retry."* So
 * `BLOCKED_VERIFY` is `NOT_APPLICABLE` to this module — a human, or a later
 * driver acting on an explicit decision, moves it on.
 *
 * That is also what bounds the one cycle `maxReviewRounds` does not.
 * `VERIFYING → BLOCKED_VERIFY → REMEDIATING → VERIFYING` never touches
 * `reviewRound`, so nothing in the state contract limits it — but this loop
 * cannot traverse it unattended, because it refuses to leave `BLOCKED_VERIFY`.
 * The only cycle this module drives on its own is
 * `VERIFYING → REVIEWING → REMEDIATING → VERIFYING`, and every traversal of it
 * passes through `REVIEWING`, which consumes exactly one review round.
 *
 * ── Where a step is allowed to execute ─────────────────────────────────────
 *
 * Every process a step starts — the verification commands, the reviewer, the
 * writer — runs in {@link LoopDependencies.authorisedWorktreePath}, which the
 * caller obtains from `observeRuntime(...).authorisedWorktreePath` and nowhere
 * else. The persisted `state.worktreePath` is compared against it as identity
 * evidence and is never used as a `cwd`: it is a claim this process did not
 * watch being written, and the absolute / shell-inert guards at the agent
 * boundaries prove a path is *usable*, never that it is *ours*. A step handed
 * no authority runs nothing and writes nothing (`EXECUTION_UNAUTHORISED`).
 *
 * ── What a mutating step is allowed to change (V2-06) ──────────────────────
 *
 * Being allowed to execute *somewhere* is not being allowed to change
 * *anything*. `IMPLEMENTING` and `REMEDIATING` are the two phases that run a
 * writing agent, and both of them are wrapped by {@link enforceScope}: once
 * before the writer starts, and again immediately before the durable move to
 * `VERIFYING`.
 *
 *     load the scope out of the pinned commit
 *              ↓
 *     PRE-SCOPE   full task delta ⊆ allowed scope?
 *              ├── no → SCOPE_VIOLATION, and the writer never starts
 *              ↓
 *     the writing agent
 *              ↓
 *     POST-SCOPE  full task delta ⊆ allowed scope?
 *              ├── no → SCOPE_VIOLATION, no verification and no reviewer
 *              ↓
 *     durable transition → VERIFYING
 *
 * The second check is the one the guarantee rests on. A scope tested only
 * before a writer runs governs what the loop *intended* to permit; the
 * repository only ever suffers what the writer actually did, and that is
 * measured from Git — the whole delta from `basePinnedCommit` to the current
 * worktree, untracked files included — rather than from anything the agent, or
 * this module's caller, says about it. `scope/` owns that derivation and
 * explains each part of it; nothing here may be handed a scope verdict.
 *
 * No new state was needed for it. `SCOPE_VIOLATION` was already in the
 * vocabulary, already declared as a successor of both mutating states, and
 * already the one block that is not resumable at all.
 *
 * ── Rounds ─────────────────────────────────────────────────────────────────
 *
 * `reviewRound` counts **completed** reviews and starts at 0. The review being
 * attempted is therefore `reviewRound + 1`, and the increment happens exactly
 * once, on the write that *leaves* `REVIEWING`. An interrupted review does not
 * increment it — `recordAgentInterruption` carries it through untouched,
 * because a round that was interrupted was not completed.
 */

import { runClaudeWriter } from '../agent/claude-writer.js';
import { codexReviewResumePoint, runCodexReviewer } from '../agent/codex-reviewer.js';
import { interruptedResumePoint, type AgentBlockEvidence } from '../agent/agent-outcome.js';
import {
  runAgentCommand,
  type AgentCommandResult,
  type AgentRunner,
} from '../agent/agent-command.js';
import { recordAgentInterruption } from '../agent/record-interruption.js';
import { withdrawnCheckpointFor } from '../core/agent-phases.js';
import { absolutePathsEqual, isComparablePath } from '../core/path-identity.js';
import { RESUME_EVIDENCE_SPENT } from '../core/resume-point.js';
import type { ExecutionBriefResult } from '../plan/task-brief.js';
import type { TaskState } from '../core/task-state.js';
import type { ResumePhase, TaskStateName } from '../core/states.js';
import type { ResolvedVerificationPolicy } from '../repo/resolve-repository.js';
import { assessTaskScope, type ScopeAssessment } from '../scope/assess-scope.js';
import { verifyExecutionLeaseHeldFor } from '../lease/execution-lease.js';
import { advanceTaskState, type AdvanceOptions } from '../state/advance-state.js';
import { observeRuntime } from '../state/observe-runtime.js';
import type { StateLoadSuccess, StateSaveResult } from '../state/state-store.js';
import { runGitCommand, type GitRunner } from '../worktree/git-command.js';
import { runVerification, type VerificationReport } from '../verify/run-verification.js';
import {
  runVerificationCommand,
  type VerificationCommandResult,
  type VerificationRunner,
} from '../verify/verify-command.js';
import {
  appendFindings,
  buildRemediationPayload,
  buildResumedRemediationBrief,
  buildReviewPayload,
} from './findings.js';
import { buildImplementPayload } from './implement-payload.js';

/** What one loop step did. A closed vocabulary; never a message. */
export const LOOP_STEP_OUTCOMES = [
  /** A durable move was made and the task can be stepped again. */
  'ADVANCED',
  /** The task is durably parked. Only a human, or an explicit decision, continues it. */
  'BLOCKED',
  /** The task reached `READY_FOR_PR`. Terminal. */
  'COMPLETED',
  /**
   * Nothing was written. The task's durable state still says what it said
   * before, and `save` says why the write was refused. Never folded into
   * `BLOCKED`: an unrecorded block is a task whose state still claims it is
   * running, which is the opposite of parked.
   */
  'STATE_NOT_RECORDED',
  /** The task is not in a state this loop drives. Nothing was run and nothing written. */
  'NOT_APPLICABLE',
  /**
   * No authorised worktree was supplied for this state, so nothing was started
   * and nothing was written.
   *
   * Distinct from `NOT_APPLICABLE`, which is a fact about the *task's phase*,
   * and from `BLOCKED`, which is a durable fact about the *task*. This is a
   * fact about the **caller's authority**, and folding it into either would
   * turn "we were never allowed to run" into "the task has nothing to do" or
   * "the task is parked" — two sentences that send an operator somewhere the
   * problem is not.
   */
  'EXECUTION_UNAUTHORISED',
] as const;

export type LoopStepOutcome = (typeof LOOP_STEP_OUTCOMES)[number];

export interface LoopStepResult {
  readonly outcome: LoopStepOutcome;
  /** The state now durably recorded, or `null` when nothing was written. */
  readonly state: TaskStateName | null;
  /** The save attempt, or `null` when none was made. */
  readonly save: StateSaveResult | null;
  /** Present only for a verify step. Never persisted. */
  readonly verification: VerificationReport | null;
  /**
   * The remediation instructions derived from the review that just ran,
   * present only on the write that enters `REMEDIATING`.
   *
   * Handed back rather than stored because it is built from `path` and `rule`,
   * which are agent-authored text this repository does not persist. A driver
   * that carries it into the next step gets the precise prompt; one that
   * restarts gets the weaker durable version and is told as much.
   */
  readonly remediationPayload: string | null;
  /**
   * What the scope guard found, present only on the steps that run it.
   *
   * Handed back rather than persisted, for the same reason as `verification`:
   * it names repository paths, and this contract does not store paths in a task
   * state. It is reporting, never authority — nothing downstream may read it as
   * permission, because the step that produced it has already acted on it.
   *
   * Kept on a refused write too. What Git said about the worktree is true
   * whether or not the durable record of it landed.
   */
  readonly scope: ScopeAssessment | null;
}

/** What the loop must be told about the world. */
export interface CompletionCheckpoint {
  /** HEAD of the worktree, or `null` when it could not be established. */
  readonly currentCommit: string | null;
  /** Whether the worktree is free of uncommitted changes. `null` if unasked. */
  readonly worktreeClean: boolean | null;
}

/**
 * Observes what `READY_FOR_PR` requires and no reviewer can attest to.
 *
 * A seam, because the two facts it reports are the difference between a task
 * that is finished and one that merely believes it is.
 */
export type CompletionObserver = (state: TaskState) => Promise<CompletionCheckpoint>;

/** The production {@link CompletionObserver}, built on V1-04's observation half. */
export const observeCompletion: CompletionObserver = async (state) => {
  const observed = await observeRuntime(runGitCommand, state);
  return Object.freeze({
    currentCommit: observed.observedCurrentCommit,
    worktreeClean: observed.worktreeClean,
  });
};

export interface LoopDependencies extends AdvanceOptions {
  /** The instant a state is entered, ISO-8601. Injected, never read from a clock. */
  readonly now: string;
  /**
   * The one directory every process this step starts runs in.
   *
   * It is `observeRuntime(...).authorisedWorktreePath`: the path **Git printed**
   * for a registration holding this task's work branch. It is emphatically not
   * `state.worktreePath`, which is a sentence in a file — a stale record, a
   * hand-edited state or one copied from another machine would each be enough
   * to point a writing agent at somebody else's checkout, and the absolute /
   * shell-inert guards the agent boundaries apply would each wave it through.
   *
   * Required, and not nullable. A driver that has no authority cannot call this
   * loop at all, and an omitted field is a compile error rather than a quiet
   * fall back to the persisted claim.
   */
  readonly authorisedWorktreePath: string;
  /** The repository's resolved verification policy. Never the raw profile. */
  readonly verification: ResolvedVerificationPolicy;
  /** What the task is, in the reviewer's and writer's own words. */
  readonly taskBrief: string;
  /**
   * The repository's own account of the task, read by `task-brief.ts`.
   *
   * Supplied by the caller rather than read here, for the reason this module
   * supplies every other input the same way: a loop step performs at most one
   * durable write and no repository I/O of its own.
   *
   * An **execution** brief specifically: its context verdict is proven in the
   * authorised worktree, which is the tree this loop's agents open. A plan's
   * preview is a different type and cannot be passed here, because it describes
   * the source checkout — a tree no writer ever sees.
   *
   * Optional because most steps do not need it — only the setup hops and the
   * implement pass do. Where they need it and it is absent, they park the task
   * for a human rather than proceeding: a writing agent briefed with nothing
   * is the one failure mode this whole layer exists to prevent.
   */
  readonly brief?: ExecutionBriefResult;
  /** Execution seams. Default to the real ones; tests pass their own. */
  readonly verify?: VerificationRunner;
  readonly agent?: AgentRunner;
  readonly observe?: CompletionObserver;
  /**
   * The Git seam the scope guard observes through. Defaults to the real one.
   *
   * Deliberately the *lowest* seam in this dependency set, and deliberately not
   * a scope-shaped one. A caller may substitute the process that answers
   * questions about a repository — that is what makes an unreadable Git, a
   * rewritten pin and a garbled diff testable at all — but it cannot substitute
   * the verdict, the scope declaration, or the classification of a path. Those
   * are derived inside `scope/`, from whatever this seam reports, and a runner
   * that lies produces raw evidence a step still judges for itself.
   *
   * There is no `scopePassed`, no `ScopeAssessment` input and no scope override
   * anywhere in this interface, and that absence is the contract (V2-06).
   */
  readonly git?: GitRunner;
  /**
   * The remediation prompt a previous review step produced. When absent, the
   * remediate step rebuilds a weaker one from `findingHistory`.
   */
  readonly remediationPayload?: string;
}

function result(from: Partial<LoopStepResult> & { readonly outcome: LoopStepOutcome }): LoopStepResult {
  return Object.freeze({
    state: null,
    save: null,
    verification: null,
    remediationPayload: null,
    scope: null,
    ...from,
  });
}

const NOT_APPLICABLE = result({ outcome: 'NOT_APPLICABLE' });
const EXECUTION_UNAUTHORISED = result({ outcome: 'EXECUTION_UNAUTHORISED' });

/**
 * Whether `deps.authorisedWorktreePath` is authority for *this* state.
 *
 * Two questions, and both have to hold. The path must be comparable at all —
 * a blank or relative `cwd` resolves against `process.cwd()` at `spawn`, which
 * is the one directory nothing here is allowed to inherit. And it must denote
 * the directory the state records, because a caller that reconciled task A and
 * then stepped task B would otherwise run B's agents in A's worktree.
 *
 * This is not a comparison of a value with itself. The left side's provenance
 * is Git's registry; the right side's is the state file. They agree exactly
 * when the observation handed in belongs to the state handed in, and the
 * comparison is by path identity rather than by string, because Git prints
 * `D:/repo/wt` where `node:path` produces `D:\repo\wt`.
 */
function authorised(state: TaskState, authorisedWorktreePath: string): boolean {
  return (
    isComparablePath(authorisedWorktreePath) &&
    absolutePathsEqual(authorisedWorktreePath, state.worktreePath)
  );
}

/**
 * The round a resume point should name for work belonging to the current pass.
 *
 * `ResumePointSchema` requires 1, `reviewRound` starts at 0, and every round on
 * a state is additionally bounded by `maxReviewRounds` — so this clamps at both
 * ends rather than trusting arithmetic to stay inside the contract.
 */
function currentRound(state: TaskState): number {
  return Math.min(Math.max(1, state.reviewRound), state.maxReviewRounds);
}

function saved(save: StateSaveResult, state: TaskStateName, outcome: LoopStepOutcome, extra: Partial<LoopStepResult> = {}): LoopStepResult {
  if (!save.ok) {
    // A refused write entered no phase, so the remediation payload that
    // belonged to that entry describes a round the durable state never reached.
    // `LoopStepResult.remediationPayload` is documented as present *only* on the
    // write that enters `REMEDIATING`, and handing one back for a write that
    // landed nothing invites a caller to brief a writer on a pass that does not
    // exist. `run-driver.ts` happens to be safe — it carries the payload only
    // from `ADVANCED` — but a contract that holds by the caller's good manners
    // is not held here (V1-08).
    //
    // `verification` and `scope` are deliberately kept: they report what the
    // repository's own commands and Git said, which is true whether or not the
    // write landed.
    return result({ ...extra, remediationPayload: null, outcome: 'STATE_NOT_RECORDED', save });
  }
  return result({ outcome, state, save, ...extra });
}

/* ─────────────────────────── the scope guard ────────────────────────────── */

/**
 * The gate both mutating steps run — before the writer, and again before the
 * durable move to `VERIFYING`.
 *
 * `blocked` is `null` when the task's whole effect is inside the scope it was
 * pinned under, and a finished {@link LoopStepResult} when it is not. A caller
 * that gets one must return it unchanged: the single durable write for this
 * step has already been made.
 *
 * `assessment` is reported either way, so a step that passes the gate can hand
 * back what the guard actually saw rather than only the fact that it survived.
 *
 * ── Why the check runs twice ───────────────────────────────────────────────
 *
 * The **post**-writer check is the one the guarantee is about. Checking a scope
 * only before a writer runs controls the *intention* and not the *effect*, and
 * the effect is the only thing a repository actually suffers.
 *
 * The **pre**-writer check is not symmetry. A violation is durable — the
 * offending changes are deliberately left in the tree as evidence — so a tree
 * can already be out of scope when a step begins: a previous pass violated it
 * and the `SCOPE_VIOLATION` write was refused, or a human continued the task
 * without cleaning up. Without a pre-check, the next run would hand that tree to
 * a writing agent and only notice afterwards, having spent an agent invocation
 * to compound a violation somebody already had to look at.
 *
 * ── Why two different blocking states ──────────────────────────────────────
 *
 * A proven violation is `SCOPE_VIOLATION`: not resumable, no resume point
 * permitted, and it tells an operator to go and inspect what an agent wrote.
 *
 * An *indeterminate* assessment — Git unreadable, the pin gone, no profile in
 * the pinned tree — is `HUMAN_DECISION_REQUIRED`, carrying the phase the task
 * was heading for. Nothing was proven about the agent, and saying "an agent
 * wrote outside its allowed scope" because Git could not be run would send an
 * operator hunting for damage that may not exist. The same split
 * `runVerifyStep` already makes between `BLOCKED_VERIFY` and an unusable
 * verification, for the same reason. Both stop the task; only one accuses.
 *
 * Neither path reverts anything. The changes stay exactly where the writer left
 * them — see `scope/assess-scope.ts` for why undoing them would be the more
 * dangerous act.
 */
async function enforceScope(
  current: StateLoadSuccess,
  options: {
    readonly now: string;
    readonly git: GitRunner;
    readonly authorisedWorktreePath: string;
    readonly phase: ResumePhase;
    readonly round: number;
    /** Whether the writing agent has already run in this pass. */
    readonly writerRan: boolean;
    readonly advance: AdvanceOptions;
  },
): Promise<{ readonly blocked: LoopStepResult | null; readonly assessment: ScopeAssessment }> {
  const state = current.state;

  // Derived here from Git, never accepted as an input. The scope declaration is
  // not passed either — `assessTaskScope` reads it out of the pinned commit.
  const assessment = await assessTaskScope({
    git: options.git,
    authorisedWorktreePath: options.authorisedWorktreePath,
    basePinnedCommit: state.basePinnedCommit,
  });

  if (assessment.verdict === 'WITHIN_SCOPE') return { blocked: null, assessment };

  if (assessment.verdict === 'VIOLATION') {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'SCOPE_VIOLATION',
        stateEnteredAt: options.now,
        // Only when a writer actually ran. A pre-writer violation is a fact
        // about the tree this step found, and naming an agent that was never
        // started would attribute it to a run that did not happen.
        blockedAgent: options.writerRan ? 'claude' : null,
        // The state cannot be continued, so it may not carry a re-entry point.
        resumeFrom: null,
        reportedResetAt: null,
        ...withdrawnCheckpointFor(state.state),
      },
      options.advance,
    );
    return { blocked: saved(save, 'SCOPE_VIOLATION', 'BLOCKED', { scope: assessment }), assessment };
  }

  const save = advanceTaskState(
    current,
    {
      ...state,
      state: 'HUMAN_DECISION_REQUIRED',
      stateEnteredAt: options.now,
      resumeFrom: { phase: options.phase, round: options.round },
      reportedResetAt: null,
      ...withdrawnCheckpointFor(state.state),
    },
    options.advance,
  );
  return {
    blocked: saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED', { scope: assessment }),
    assessment,
  };
}

/**
 * Runs the repository's verification commands and records what they said.
 *
 * A verdict is never inferred from the absence of one: only `PASSED` — every
 * declared phase having run to its own end and exited 0 — advances to
 * `REVIEWING`.
 */
export async function runVerifyStep(
  current: StateLoadSuccess,
  deps: LoopDependencies,
): Promise<LoopStepResult> {
  const state = current.state;
  if (state.state !== 'VERIFYING') return NOT_APPLICABLE;

  const {
    now,
    authorisedWorktreePath,
    verification,
    taskBrief,
    verify,
    agent,
    git,
    observe,
    remediationPayload,
    ...advance
  } = deps;
  void taskBrief;
  void agent;
  void git;
  void observe;
  void remediationPayload;

  if (!authorised(state, authorisedWorktreePath)) return EXECUTION_UNAUTHORISED;

  const report = await runVerification(
    { worktreePath: authorisedWorktreePath, verification },
    verify === undefined ? {} : { verify },
  );

  if (report.verdict === 'PASSED') {
    const save = advanceTaskState(
      current,
      { ...state, state: 'REVIEWING', stateEnteredAt: now, ...RESUME_EVIDENCE_SPENT },
      advance,
    );
    return saved(save, 'REVIEWING', 'ADVANCED', { verification: report });
  }

  // The repository answered "no". `BLOCKED_VERIFY` carries no blocked agent —
  // verification runs no agent — and its only continuation is remediation,
  // which is the one resume phase the contract permits it to name.
  if (report.verdict === 'FAILED') {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'BLOCKED_VERIFY',
        stateEnteredAt: now,
        blockedAgent: null,
        resumeFrom: { phase: 'REMEDIATE', round: currentRound(state) },
        reportedResetAt: null,
      },
      advance,
    );
    return saved(save, 'BLOCKED_VERIFY', 'BLOCKED', { verification: report });
  }

  // Nothing was learned. Distinct from a failure on purpose: "the build is
  // broken" and "we could not run the build" send an operator to different
  // places, and only one of them is about the repository.
  const save = advanceTaskState(
    current,
    {
      ...state,
      state: 'HUMAN_DECISION_REQUIRED',
      stateEnteredAt: now,
      blockedAgent: null,
      resumeFrom: { phase: 'VERIFY', round: currentRound(state) },
      reportedResetAt: null,
    },
    advance,
  );
  return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED', { verification: report });
}

/**
 * Runs the reviewer and routes on what it said.
 *
 * Three outcomes, and the boundary between the first two is the whole point:
 * a review that *ran and found nothing* may complete the task; a review that
 * did not run cannot, whatever its exit code was. `runCodexReviewer` refuses to
 * put `findings` on its failure member precisely so that this function cannot
 * read one from the other.
 */
export async function runReviewStep(
  current: StateLoadSuccess,
  deps: LoopDependencies,
): Promise<LoopStepResult> {
  const state = current.state;
  if (state.state !== 'REVIEWING') return NOT_APPLICABLE;

  const { now, authorisedWorktreePath, taskBrief, agent, observe, ...rest } = deps;
  const { verification, verify, git, remediationPayload, ...advance } = rest;
  void verification;
  void verify;
  void git;
  void remediationPayload;

  if (!authorised(state, authorisedWorktreePath)) return EXECUTION_UNAUTHORISED;

  const round = state.reviewRound + 1;

  // The budget is the state's, not a constant here. A review that cannot be
  // performed within it is not performed at all: running one and then refusing
  // to record it would spend an agent's quota to learn something unusable.
  if (round > state.maxReviewRounds) {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'HUMAN_DECISION_REQUIRED',
        stateEnteredAt: now,
        resumeFrom: { phase: 'REMEDIATE', round: currentRound(state) },
        reportedResetAt: null,
      },
      advance,
    );
    return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED');
  }

  const review = await runCodexReviewer(
    { worktreePath: authorisedWorktreePath, round, payload: buildReviewPayload(taskBrief) },
    agent === undefined ? {} : { agent },
  );

  // Not a review. Every failure code lands here, and none of them may be read
  // as an empty finding list — `findings` does not exist on this member.
  if (!review.ok) {
    const record = recordAgentInterruption(
      current,
      { disposition: review.disposition, block: review.block },
      { now, fallback: codexReviewResumePoint(round), ...advance },
    );
    if (record.outcome === 'STATE_NOT_RECORDED') {
      return result({ outcome: 'STATE_NOT_RECORDED', save: record.save });
    }
    return result({ outcome: 'BLOCKED', state: record.state, save: record.save });
  }

  const history = appendFindings(state.findingHistory, review.findings, round);

  if (review.findings.length > 0) {
    // A remediation pass is only worth starting if its result could still be
    // reviewed. At the last permitted round it could not, so the task goes to a
    // human with its evidence intact rather than into a pass nothing will judge.
    if (round >= state.maxReviewRounds) {
      const save = advanceTaskState(
        current,
        {
          ...state,
          state: 'HUMAN_DECISION_REQUIRED',
          stateEnteredAt: now,
          reviewRound: round,
          findingHistory: history,
          resumeFrom: { phase: 'REMEDIATE', round },
          reportedResetAt: null,
        },
        advance,
      );
      return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED');
    }

    // Entering a writing phase withdraws the checkpoint facts a writer is about
    // to invalidate, for the reason `record-interruption.ts` gives for the
    // interruption path (V1-05-RR-F8): carrying `worktreeCleanAtCheckpoint:
    // true` into a state whose whole purpose is to modify the worktree makes
    // `reconcile.ts` read the writer's own work as divergence.
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'REMEDIATING',
        stateEnteredAt: now,
        reviewRound: round,
        findingHistory: history,
        worktreeCleanAtCheckpoint: false,
        currentCommit: null,
        ...RESUME_EVIDENCE_SPENT,
      },
      advance,
    );
    return saved(save, 'REMEDIATING', 'ADVANCED', {
      remediationPayload: buildRemediationPayload(review.findings, round),
    });
  }

  // A clean review. `READY_FOR_PR` additionally demands settled commits and a
  // clean worktree, which no reviewer can attest to, so they are observed here
  // and the state is only claimed when both were positively established.
  const checkpoint = await (observe ?? observeCompletion)(state);
  const settled =
    checkpoint.worktreeClean === true &&
    checkpoint.currentCommit !== null &&
    state.basePinnedCommit !== null;

  if (!settled) {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'HUMAN_DECISION_REQUIRED',
        stateEnteredAt: now,
        reviewRound: round,
        findingHistory: history,
        resumeFrom: { phase: 'REVIEW', round },
        reportedResetAt: null,
      },
      advance,
    );
    return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED');
  }

  const save = advanceTaskState(
    current,
    {
      ...state,
      state: 'READY_FOR_PR',
      stateEnteredAt: now,
      reviewRound: round,
      findingHistory: history,
      currentCommit: checkpoint.currentCommit,
      worktreeCleanAtCheckpoint: true,
      blockedAgent: null,
      resumeFrom: null,
      reportedResetAt: null,
    },
    advance,
  );
  return saved(save, 'READY_FOR_PR', 'COMPLETED');
}

/**
 * Runs the writer against the current round's findings.
 *
 * A completed writer means the agent finished, not that the task is fixed —
 * which is why the only success edge is back to `VERIFYING`. The transition
 * table enforces that independently: `REMEDIATING` does not list `REVIEWING`,
 * so remediation cannot reach a reviewer without re-verifying first.
 */
export async function runRemediateStep(
  current: StateLoadSuccess,
  deps: LoopDependencies,
): Promise<LoopStepResult> {
  const state = current.state;
  if (state.state !== 'REMEDIATING') return NOT_APPLICABLE;

  const {
    now,
    authorisedWorktreePath,
    agent,
    git,
    remediationPayload,
    taskBrief,
    verification,
    verify,
    observe,
    ...advance
  } = deps;
  void taskBrief;
  void verification;
  void verify;
  void observe;

  if (!authorised(state, authorisedWorktreePath)) return EXECUTION_UNAUTHORISED;

  const round = currentRound(state);

  // A remediation pass needs a *cause*, and the cause has to have survived.
  //
  // The caller's payload is the live one: it exists only on the step that just
  // read a review, and the same write persisted that review's findings. Without
  // it — a restarted driver, or an entry into `REMEDIATING` that came from
  // somewhere other than `REVIEWING` — the durable history is the only evidence
  // there is, and where it holds nothing for this round there is no brief to
  // build. Composing one anyway produces a document in the reviewer's voice
  // claiming a review reported findings and then listing none of them, which is
  // a fabricated cause handed to a writing agent with a worktree to modify.
  //
  // `BLOCKED_VERIFY → REMEDIATING` is the sharp case: a failed verification is
  // a real reason to remediate, but the report is deliberately never persisted,
  // so nothing durable makes it actionable. A caller that has just run the
  // verification may supply its own brief; one that has not must not invent the
  // reviewer's.
  const brief =
    remediationPayload === undefined
      ? buildResumedRemediationBrief(state.findingHistory, round)
      : ({ kind: 'DURABLE_RECORD', payload: remediationPayload } as const);

  if (brief.kind === 'NO_DURABLE_FINDINGS') {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'HUMAN_DECISION_REQUIRED',
        stateEnteredAt: now,
        resumeFrom: { phase: 'REMEDIATE', round },
        reportedResetAt: null,
      },
      advance,
    );
    return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED');
  }

  const scopeGuard = {
    now,
    git: git ?? runGitCommand,
    authorisedWorktreePath,
    phase: 'REMEDIATE' as const,
    round,
    advance,
  };

  // PRE-SCOPE. A tree that is already out of scope does not get a writer.
  const before = await enforceScope(current, { ...scopeGuard, writerRan: false });
  if (before.blocked !== null) return before.blocked;

  const writer = await runClaudeWriter(
    { worktreePath: authorisedWorktreePath, phase: 'REMEDIATE', round, payload: brief.payload },
    agent === undefined ? {} : { agent },
  );

  if (!writer.ok) {
    const fallback: AgentBlockEvidence = {
      blockedAgent: 'claude',
      resumeFrom: interruptedResumePoint('REMEDIATE', round),
      reportedResetAt: null,
    };
    const record = recordAgentInterruption(
      current,
      { disposition: writer.disposition, block: writer.block },
      { now, fallback, ...advance },
    );
    if (record.outcome === 'STATE_NOT_RECORDED') {
      return result({ outcome: 'STATE_NOT_RECORDED', save: record.save });
    }
    return result({ outcome: 'BLOCKED', state: record.state, save: record.save });
  }

  // POST-SCOPE. Identical to the implement pass, and deliberately so: the two
  // steps differ in the cause they are given and in nothing else, so a
  // remediation that writes outside the declared scope must not reach
  // `VERIFYING` either. A guard on only the first pass would be a sandbox a
  // writer escapes on its second attempt.
  const after = await enforceScope(current, { ...scopeGuard, writerRan: true });
  if (after.blocked !== null) return after.blocked;

  // The scope guard read *which* paths the writer touched and nothing more, so
  // the checkpoint facts stay withdrawn. Verification is what looks next.
  const save = advanceTaskState(
    current,
    {
      ...state,
      state: 'VERIFYING',
      stateEnteredAt: now,
      worktreeCleanAtCheckpoint: false,
      currentCommit: null,
      ...RESUME_EVIDENCE_SPENT,
    },
    advance,
  );
  return saved(save, 'VERIFYING', 'ADVANCED', { scope: after.assessment });
}

/* ─────────────────────────── the setup hops ─────────────────────────────── */

/**
 * `WORKTREE_READY → CONTEXT_LOADING`.
 *
 * The one step in this module that starts no process and reads no repository.
 * That is not an oversight: the work it would otherwise do has already been
 * done and re-proven. `startTask` created and verified the workspace; the run
 * driver reconciled the record against Git before this step was reached, and
 * `authorised()` below re-checks that this caller's authority is for *this*
 * state. There is nothing left for the step to establish.
 *
 * It exists because the transition table declares the hop, and a durable move
 * is how the task stops being "prepared" and starts being "under way". Skipping
 * it and writing `IMPLEMENTING` straight from `WORKTREE_READY` is an illegal
 * transition that `advanceTaskState` would refuse — correctly.
 */
export async function runWorktreeReadyStep(
  current: StateLoadSuccess,
  deps: LoopDependencies,
): Promise<LoopStepResult> {
  const state = current.state;
  if (state.state !== 'WORKTREE_READY') return NOT_APPLICABLE;

  const { now, authorisedWorktreePath, agent, git, remediationPayload, taskBrief, brief, verification, verify, observe, ...advance } = deps;
  void agent;
  void git;
  void remediationPayload;
  void taskBrief;
  void brief;
  void verification;
  void verify;
  void observe;

  if (!authorised(state, authorisedWorktreePath)) return EXECUTION_UNAUTHORISED;

  const save = advanceTaskState(
    current,
    { ...state, state: 'CONTEXT_LOADING', stateEnteredAt: now },
    advance,
  );
  return saved(save, 'CONTEXT_LOADING', 'ADVANCED');
}

/**
 * `CONTEXT_LOADING → IMPLEMENTING`, or a human.
 *
 * This is where the repository's account of the task has to actually exist. A
 * task file with no prose, a declared context source that is missing, an
 * unreadable file — each of them means the writing agent would be briefed with
 * something less than the repository promised, and each is a repository
 * problem a human fixes rather than something the loop can work around.
 *
 * ── Why the checkpoint is withdrawn on the way in ──────────────────────────
 *
 * `IMPLEMENTING` is a mutating phase: from the moment it is entered, a writing
 * agent may be changing the worktree. A state that carried `currentCommit` and
 * `worktreeCleanAtCheckpoint: true` into it would be claiming a settled tree
 * for exactly the period in which the tree is expected to move, and the next
 * reconciliation would read the writer's own work as `CURRENT_COMMIT_MOVED` +
 * `WORKTREE_DIRTY` → `DIVERGED` → `RESUME_STATE_DIVERGED`, which nothing
 * resumes. `withdrawnCheckpointFor` states that once, and this is one of its
 * callers rather than a second copy of the rule.
 */
export async function runContextLoadingStep(
  current: StateLoadSuccess,
  deps: LoopDependencies,
): Promise<LoopStepResult> {
  const state = current.state;
  if (state.state !== 'CONTEXT_LOADING') return NOT_APPLICABLE;

  const { now, authorisedWorktreePath, brief, agent, git, remediationPayload, taskBrief, verification, verify, observe, ...advance } = deps;
  void agent;
  void git;
  void remediationPayload;
  void taskBrief;
  void verification;
  void verify;
  void observe;

  if (!authorised(state, authorisedWorktreePath)) return EXECUTION_UNAUTHORISED;

  const round = currentRound(state);

  // Two different failures, one response.
  //
  // `!brief.ok` is the task file itself: absent, unreadable, no frontmatter,
  // no prose. `!contextComplete` is a declared context source that could not
  // be opened — missing, unreadable, or a link out of the repository.
  //
  // The second is checked here because `readTaskBrief` reports it on a
  // *successful* brief, as a per-source status, and a step that only asked
  // `brief.ok` would advance with it. That is not a small gap: the payload
  // hands the agent those paths to open, so an unopenable one becomes an
  // instruction to read a file that is not there — and an `UNSAFE` one is a
  // path the reader already refused to follow.
  //
  // The repository declared those sources as the canonical context for its
  // work. If one of them is gone, the repository's own contract is broken, and
  // that is a thing a human fixes rather than something the loop routes around.
  const contextIncomplete = brief !== undefined && brief.ok && !brief.brief.contextComplete;

  if (brief === undefined || !brief.ok || contextIncomplete) {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'HUMAN_DECISION_REQUIRED',
        stateEnteredAt: now,
        // The phase the task was heading for. A human who fixes the task file
        // resumes into the implement pass, not back into loading.
        resumeFrom: { phase: 'IMPLEMENT', round },
        reportedResetAt: null,
      },
      advance,
    );
    return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED');
  }

  const save = advanceTaskState(
    current,
    {
      ...state,
      state: 'IMPLEMENTING',
      stateEnteredAt: now,
      ...RESUME_EVIDENCE_SPENT,
      ...withdrawnCheckpointFor('IMPLEMENTING'),
    },
    advance,
  );
  return saved(save, 'IMPLEMENTING', 'ADVANCED');
}

/* ───────────────────────────── implement ────────────────────────────────── */

/**
 * `IMPLEMENTING → VERIFYING`: the writing agent's first pass.
 *
 * The mirror of {@link runRemediateStep}, and deliberately so — the two differ
 * in the cause they are given (a task, versus a review's findings) and in
 * nothing else. Both run the same writer in the same authorised directory,
 * both record an interruption the same way, and both leave the checkpoint
 * withdrawn for verification to settle.
 *
 * ── A completed writer is not a completed task ─────────────────────────────
 *
 * `runClaudeWriter` returning `ok` means an argument-safe process ran to its
 * own end, exited 0, and printed a positively recognised `COMPLETED` envelope.
 * It carries **no evidence that any file changed**. So the only destination is
 * `VERIFYING`: the transition table offers no other forward edge, and the
 * repository's own commands are what look next. Nothing here observes the
 * worktree, and nothing here may claim the task is finished — `READY_FOR_PR`
 * is reachable only through a real `REVIEWING` pass.
 *
 * `reviewRound` is deliberately untouched. It counts *completed reviews*, and
 * an implement pass that consumed one would silently spend the repository's
 * review budget on work no reviewer had seen.
 */
export async function runImplementStep(
  current: StateLoadSuccess,
  deps: LoopDependencies,
): Promise<LoopStepResult> {
  const state = current.state;
  if (state.state !== 'IMPLEMENTING') return NOT_APPLICABLE;

  const { now, authorisedWorktreePath, agent, brief, git, remediationPayload, taskBrief, verification, verify, observe, ...advance } = deps;
  void remediationPayload;
  void taskBrief;
  void verification;
  void verify;
  void observe;

  if (!authorised(state, authorisedWorktreePath)) return EXECUTION_UNAUTHORISED;

  const round = currentRound(state);

  // Re-checked rather than assumed from the previous step: a restarted driver
  // enters here directly, and a task whose file was emptied — or whose
  // declared context vanished — in the meantime must not be handed a prompt
  // built from nothing. The same conjunction as `CONTEXT_LOADING`, for the
  // same reasons, because this is a separate entry point into the same work.
  if (brief === undefined || !brief.ok || !brief.brief.contextComplete) {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'HUMAN_DECISION_REQUIRED',
        stateEnteredAt: now,
        resumeFrom: { phase: 'IMPLEMENT', round },
        reportedResetAt: null,
      },
      advance,
    );
    return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED');
  }

  const scopeGuard = {
    now,
    git: git ?? runGitCommand,
    authorisedWorktreePath,
    phase: 'IMPLEMENT' as const,
    round,
    advance,
  };

  // PRE-SCOPE. A tree that is already out of scope does not get a writer.
  const before = await enforceScope(current, { ...scopeGuard, writerRan: false });
  if (before.blocked !== null) return before.blocked;

  const writer = await runClaudeWriter(
    {
      worktreePath: authorisedWorktreePath,
      phase: 'IMPLEMENT',
      round,
      payload: buildImplementPayload(brief.brief, round),
    },
    agent === undefined ? {} : { agent },
  );

  if (!writer.ok) {
    const fallback: AgentBlockEvidence = {
      blockedAgent: 'claude',
      resumeFrom: interruptedResumePoint('IMPLEMENT', round),
      reportedResetAt: null,
    };
    const record = recordAgentInterruption(
      current,
      { disposition: writer.disposition, block: writer.block },
      { now, fallback, ...advance },
    );
    if (record.outcome === 'STATE_NOT_RECORDED') {
      return result({ outcome: 'STATE_NOT_RECORDED', save: record.save });
    }
    return result({ outcome: 'BLOCKED', state: record.state, save: record.save });
  }

  // POST-SCOPE. The guarantee: no mutating step is left successfully until the
  // writer's *actual* effect on the repository has been measured. This runs
  // before the durable move, so a task that wrote out of scope cannot reach
  // `VERIFYING` — and therefore cannot reach a reviewer either.
  const after = await enforceScope(current, { ...scopeGuard, writerRan: true });
  if (after.blocked !== null) return after.blocked;

  // The scope guard read *which* paths the writer touched and nothing more: it
  // has no opinion on whether the work is right, and it did not re-establish
  // HEAD or a clean tree. So the checkpoint facts stay withdrawn, and
  // verification is still what looks next.
  const save = advanceTaskState(
    current,
    {
      ...state,
      state: 'VERIFYING',
      stateEnteredAt: now,
      ...withdrawnCheckpointFor('IMPLEMENTING'),
      ...RESUME_EVIDENCE_SPENT,
    },
    advance,
  );
  return saved(save, 'VERIFYING', 'ADVANCED', { scope: after.assessment });
}

/**
 * The states this loop drives.
 *
 * Exported so a caller can ask, *before* making a durable move, whether the
 * phase it is about to enter is one anything can continue from. The run driver
 * needs that answer: a resume that lands a task in a phase nothing drives spends
 * the block's evidence and produces no work, which is a one-way durable loss
 * (V1-08).
 *
 * `tests/v1-08-contracts.test.ts` pins this set against {@link runLoopStep}'s
 * actual dispatch over every declared state, so the advertised answer and the
 * switch below cannot drift apart.
 */
export const LOOP_DRIVEN_STATES = [
  'WORKTREE_READY',
  'CONTEXT_LOADING',
  'IMPLEMENTING',
  'VERIFYING',
  'REVIEWING',
  'REMEDIATING',
] as const;

const LOOP_DRIVEN_SET: ReadonlySet<string> = new Set<string>(LOOP_DRIVEN_STATES);

/** `true` for a state {@link runLoopStep} has a step for. */
export function isLoopDrivenState(state: TaskStateName): boolean {
  return LOOP_DRIVEN_SET.has(state);
}

/**
 * Runs whichever step the task's persisted state calls for.
 *
 * The dispatch is on the **durable** state, never on anything a caller says the
 * task is doing. A state this loop does not drive — including `BLOCKED_VERIFY`,
 * which is deliberate — is `NOT_APPLICABLE`, and nothing is run or written.
 */
export async function runLoopStep(
  current: StateLoadSuccess,
  deps: LoopDependencies,
): Promise<LoopStepResult> {
  return dispatch(current, fencedSpawns(deps));
}

/**
 * The same dependencies, with every subprocess seam fenced by the lease.
 *
 * ── Why the wrapper and not a check at each spawn ──────────────────────────
 *
 * `advanceTaskState` closed the *write*: after the lease is lost, no durable
 * state transition happens. That left the other half open, and a review
 * measured it — the driver proves the lease, reconciliation spends nine Git
 * subprocesses and 585 ms, and only then is a step entered and a **writing
 * agent started**. It ran, and it landed a commit on the orchestrator-owned
 * branch, with the lease demonstrably free. The recorded state was correctly
 * refused; the effect was not.
 *
 * There are four spawn sites in this module today, and gating each one is the
 * shape that has already failed twice in this slice: a rule enforced by
 * remembering is a rule the fifth site breaks. So the *seams themselves* carry
 * the gate. A step cannot start a subprocess except through one of these, and a
 * spawn site added later inherits the check by construction.
 *
 * A refusal is reported as `UNAVAILABLE`, which is the vocabulary both seams
 * already have for "the process never started, and nothing it printed is
 * evidence of anything". The step then tries to record something, and
 * `advanceTaskState` refuses that too, so the run stops with
 * `EXECUTION_LEASE_LOST` and no durable trace — which is the honest end state.
 *
 * What this still does **not** claim: that an agent already running stops. That
 * needs owned process containment, and it is a later slice.
 */
function fencedSpawns(deps: LoopDependencies): LoopDependencies {
  const held = (): boolean =>
    verifyExecutionLeaseHeldFor(deps.lease.repository, deps.lease.evidence).code === 'HELD';

  const agent: AgentRunner = async (id, args, cwd, payload) => {
    if (!held()) return AGENT_NOT_AUTHORISED;
    return (deps.agent ?? runAgentCommand)(id, args, cwd, payload);
  };

  const verify: VerificationRunner = async (command, args, cwd) => {
    if (!held()) return VERIFICATION_NOT_AUTHORISED;
    return (deps.verify ?? runVerificationCommand)(command, args, cwd);
  };

  return { ...deps, agent, verify };
}

/** What a seam answers when this run is no longer the repository's writer. */
const AGENT_NOT_AUTHORISED: AgentCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});

const VERIFICATION_NOT_AUTHORISED: VerificationCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});

async function dispatch(
  current: StateLoadSuccess,
  deps: LoopDependencies,
): Promise<LoopStepResult> {
  switch (current.state.state) {
    case 'WORKTREE_READY':
      return runWorktreeReadyStep(current, deps);
    case 'CONTEXT_LOADING':
      return runContextLoadingStep(current, deps);
    case 'IMPLEMENTING':
      return runImplementStep(current, deps);
    case 'VERIFYING':
      return runVerifyStep(current, deps);
    case 'REVIEWING':
      return runReviewStep(current, deps);
    case 'REMEDIATING':
      return runRemediateStep(current, deps);
    default:
      return NOT_APPLICABLE;
  }
}
