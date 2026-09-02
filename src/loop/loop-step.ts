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
 * Since the M1 verification-recovery fix that second clause is executable
 * rather than aspirational: `run --attended --task <id>
 * --remediate-verify-failure` is the decision, and `run-driver.ts` performs the
 * transition through `resumeBlockedTask`, unchanged. **This module still
 * refuses to leave the state on its own.**
 *
 * The cycle `maxReviewRounds` does not bound was bounded by that refusal.
 * `VERIFYING → BLOCKED_VERIFY → REMEDIATING → VERIFYING` never touches
 * `reviewRound`, so nothing in the state contract limits it — and this loop
 * still cannot traverse it unattended. What changed is that an operator now
 * can, once.
 *
 * What holds that "once" was measured rather than designed: a `BLOCKED` step
 * ends the `runTask` call, and `driveLifecycle` re-enters only on
 * `STEP_BUDGET_EXHAUSTED`, so a `BLOCKED_VERIFY` outcome ends the lifecycle.
 * `run-driver.ts` also refuses a second departure per invocation, and that is a
 * fail-closed floor rather than the bound — a mutant deleting it survives every
 * test today. The only cycle this module drives on its own is
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

import { runClaudeWriter, type ClaudeWriterFailed } from '../agent/claude-writer.js';
import {
  codexReviewResumePoint,
  runCodexReviewer,
  type CodexReviewResult,
} from '../agent/codex-reviewer.js';
import {
  REVIEWER_PROVIDER_GATE,
  type ReviewerProviderGate,
} from './reviewer-provider-gate.js';
import {
  interruptedResumePoint,
  type AgentBlockEvidence,
  type PermissionDenialObservation,
} from '../agent/agent-outcome.js';
import type { AgentRunner } from '../agent/agent-command.js';
import { recordAgentInterruption } from '../agent/record-interruption.js';
import { withdrawnCheckpointFor } from '../core/agent-phases.js';
import type { InterruptionCheckpoint } from '../core/interruption-checkpoint.js';
import { mintInterruptionCheckpoint } from '../core/internal/interruption-checkpoint.js';
import { absolutePathsEqual, isComparablePath } from '../core/path-identity.js';
import { RESUME_EVIDENCE_SPENT } from '../core/resume-point.js';
import type { ExecutionBriefResult } from '../plan/task-brief.js';
import type { TaskState } from '../core/task-state.js';
import type { ResumePhase, TaskStateName } from '../core/states.js';
import type { ResolvedVerificationPolicy } from '../repo/resolve-repository.js';
import { assessTaskScope, type ScopeAssessment } from '../scope/assess-scope.js';
import { leaseHolds, leasedAgent, leasedGit, leasedVerify } from './leased-spawns.js';
import { commitTaskWork, type CommitTaskWorkResult } from '../worktree/commit-task-work.js';
import { advanceTaskState, type AdvanceOptions } from '../state/advance-state.js';
import { observeRuntime } from '../state/observe-runtime.js';
import type { StateLoadSuccess, StateSaveResult } from '../state/state-store.js';
import { runGitCommand, type GitRunner } from '../worktree/git-command.js';
import { observeWorktreeCleanliness } from '../worktree/worktree-cleanliness.js';
import { runVerification, type VerificationReport } from '../verify/run-verification.js';
import { verificationProfileDigest } from '../verify/verification-profile.js';
import {
  storedDiagnosticsAsAgentDiagnostics,
  verificationAttemptFrom,
  type VerificationAttemptRecord,
} from '../verify/verification-attempt.js';
import {
  loadVerificationAttempts as loadVerificationAttemptsFromStore,
  latestVerificationAttempt,
  recordVerificationAttempt as recordVerificationAttemptInStore,
  type VerificationAttemptLoad,
  type VerificationAttemptRecordResult,
} from '../verify/verification-attempt-store.js';
import { askRuntimeIgnored, type RuntimeIgnoreVerdict } from '../state/runtime-ignored.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import {
  appendFindings,
  buildRemediationPayload,
  buildResumedRemediationBrief,
  buildVerificationRemediationPayload,
  type ResumedRemediationBrief,
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
   * What became of this step's attempt to make that report durable, present only
   * on a verify step that did not pass.
   *
   * Reported, never persisted — `TaskStateObjectSchema` is `.strict()` and has no
   * field for it. So an operator reads a store failure on the run that hit it,
   * and a later invocation reads the *record* instead, or finds none. Those are
   * different things to know and neither substitutes for the other.
   *
   * `recorded` is what the verify step gates its `BLOCKED_VERIFY` on, and it is
   * the store's answer rather than this step's inference.
   */
  readonly verificationEvidence: VerificationEvidenceOutcome | null;
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
  /**
   * What the writing agent was refused during this step, or `null` when no
   * writer ran in it.
   *
   * `null` and `{ count: 0 }` are different answers and both are honest: a
   * verify step never asked, while an implement step that asked and saw nothing
   * refused did. In memory only — like `verification` and `scope`, this is
   * reporting, and `TaskStateObjectSchema` is `.strict()` (G2).
   */
  readonly permissionDenials: PermissionDenialObservation | null;
  /**
   * What AO's own commit of this pass did, or `null` when no commit was
   * attempted (every non-writing step, and a writing step that never got past
   * its scope gate).
   *
   * Carried rather than persisted, like `scope` — it names repository paths and
   * a commit id, and it is what an operator needs in front of them when a pass
   * parks: which object exists, which paths it should not have contained, which
   * configured driver stopped it.
   */
  readonly commit: CommitTaskWorkResult | null;
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
   * The gate that keeps two repositories from calling one reviewer
   * subscription at once. Defaults to the process-wide one, which is the whole
   * point of it — see `reviewer-provider-gate.ts`.
   *
   * A seam only so that a test can hold a gate nobody else shares. A test that
   * used the production instance would be measuring what every other test in
   * its file had already done to it.
   */
  readonly reviewerProviderGate?: ReviewerProviderGate;
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
   * remediate step rebuilds a weaker one from `findingHistory`, and failing that
   * from the durable verification-attempt evidence.
   */
  readonly remediationPayload?: string;
  /**
   * Where a verification attempt is durably recorded. Defaults to the real store.
   *
   * A seam of the same class as `verify` and `git`: a caller may substitute the
   * process that writes, which is what makes an unwritable store, a full history
   * and a corrupted document testable at all. It cannot substitute the
   * *decision* — the verify step reads `recorded` and nothing else, and a
   * recorder that lies about having written produces a `BLOCKED_VERIFY` this
   * build would rather not have written, which is the property the ordering
   * exists to protect and what the counter-proof aims at.
   */
  readonly recordVerificationAttempt?: VerificationAttemptRecorder;
  /** Where durable verification evidence is read back. Defaults to the real store. */
  readonly loadVerificationAttempts?: VerificationAttemptLoader;
}

/** The store's write, as a seam. See {@link LoopDependencies.recordVerificationAttempt}. */
export type VerificationAttemptRecorder = (request: {
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly attempt: VerificationAttemptRecord;
  readonly leaseHolds: () => boolean;
  readonly checkIgnored: (relativePath: string) => Promise<RuntimeIgnoreVerdict>;
}) => Promise<VerificationAttemptRecordResult>;

/** The store's read, as a seam. See {@link LoopDependencies.loadVerificationAttempts}. */
export type VerificationAttemptLoader = (
  repositoryRoot: string,
  taskId: string,
) => VerificationAttemptLoad;

function result(from: Partial<LoopStepResult> & { readonly outcome: LoopStepOutcome }): LoopStepResult {
  return Object.freeze({
    state: null,
    save: null,
    verification: null,
    verificationEvidence: null,
    remediationPayload: null,
    scope: null,
    permissionDenials: null,
    commit: null,
    ...from,
  });
}

const NOT_APPLICABLE = result({ outcome: 'NOT_APPLICABLE' });
const EXECUTION_UNAUTHORISED = result({ outcome: 'EXECUTION_UNAUTHORISED' });

/**
 * Attaches what the writer was refused to a result the scope guard built.
 *
 * A step that blocks on scope still ran a writer, and what that writer was
 * refused is as true as what it wrote. The guard cannot say so itself — it is
 * given a tree, not an agent run — so the step that owns both facts joins them
 * here rather than letting the observation fall off the one path where an
 * operator is already being asked to look at the writer's behaviour.
 */
function withDenials(
  step: LoopStepResult,
  permissionDenials: PermissionDenialObservation,
): LoopStepResult {
  return Object.freeze({ ...step, permissionDenials });
}

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
    // `verification`, `verificationEvidence` and `scope` are deliberately kept:
    // they report what the repository's own commands, the evidence store and Git
    // said, which is true whether or not the write landed. The evidence one
    // matters most here — a refused state write after a *successful* record
    // leaves an attempt on disk with no block beside it, and an operator who is
    // not told that will not know to look.
    return result({ ...extra, remediationPayload: null, outcome: 'STATE_NOT_RECORDED', save });
  }
  return result({ outcome, state, save, ...extra });
}

/* ────────────────────────── the orchestrator's commit ───────────────────── */

/**
 * Records the pass, or refuses it — and either way the writer never decides.
 *
 * ── Why this is a step of its own, between the gate and the move ───────────
 *
 * `runClaudeWriter` returning `ok` means a process ended cleanly and printed a
 * recognised envelope. The first dogfood run proved what that is worth on its
 * own: the writer had no authority to write, the envelope said success, and the
 * task was reported as delivered. So a pass now has to leave an *object* behind,
 * and the object has to be one AO made:
 *
 *   scope gate (already run)  → what did the writer actually touch?
 *   commit                    → AO stages, AO authors, AO's identity
 *   controls one and two      → and it contains exactly what was approved
 *
 * **Nothing changed → nothing recorded → the pass is inadmissible.** That is the
 * whole of R2 in one line, and it parks rather than advancing, because a writing
 * phase that produced no effect is not a phase that can be verified.
 *
 * That rule belongs to a *completed* pass, and this function is where it lives.
 * {@link settleQuotaInterruption} calls the same `commitTaskWork` and reads
 * `NOTHING_TO_COMMIT` as a settlement instead — a writer the CLI cut off before
 * it wrote anything is an ordinary pause, not an inadmissible pass, and it does
 * not advance either. The shared mechanism is the commit and its two controls;
 * what a zero-change answer *means* is the caller's question, and the two
 * callers legitimately give different answers to it.
 *
 * ── The refusals are deliberately all one state ────────────────────────────
 *
 * Every way this can fail parks at `HUMAN_DECISION_REQUIRED` with a resume
 * point: the transition table offers no state for "AO could not record the
 * work", and inventing one is a product-contract change a runner slice may not
 * make. The *reason* is not lost — it travels on `LoopStepResult.commit`, which
 * carries the commit id, the unapproved paths or the configured driver keys,
 * whichever applies.
 *
 * Refusals never undo. A commit that contained an unapproved path stays, and so
 * do the writer's files: they are the evidence somebody is being asked to look
 * at, and the undo is an effect too.
 */
async function commitPassOrPark(
  current: StateLoadSuccess,
  approvedPaths: readonly string[],
  deps: LoopDependencies & { readonly phase: 'IMPLEMENT' | 'REMEDIATE'; readonly round: number },
): Promise<{ readonly blocked: LoopStepResult | null; readonly commit: CommitTaskWorkResult }> {
  const state = current.state;
  const { now, authorisedWorktreePath, phase, round } = deps;

  const park = (commit: CommitTaskWorkResult): LoopStepResult => {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'HUMAN_DECISION_REQUIRED',
        stateEnteredAt: now,
        resumeFrom: { phase, round },
        reportedResetAt: null,
      },
      leaseAdvanceOptions(deps),
    );
    return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED', { commit });
  };

  // A task with no base pin cannot be committed against one, and the scope gate
  // that ran before this refuses such a task already (`NO_BASE_PIN`). Asked
  // again rather than assumed, because this module is entered directly.
  if (state.basePinnedCommit === null) {
    const commit = Object.freeze({
      outcome: 'GIT_UNAVAILABLE' as const,
      step: 'READ_COMMITTED_PATHS' as const,
    });
    return { blocked: park(commit), commit };
  }

  const commit = await commitTaskWork(leasedGit(deps), authorisedWorktreePath, {
    taskId: state.taskId,
    phase,
    round,
    // Handed down from the gate that approved them. Never re-derived here: a
    // set measured at this point would be measured after any injection and
    // would therefore contain it (G12).
    approvedPaths,
    basePinnedCommit: state.basePinnedCommit,
  });

  return { blocked: commit.outcome === 'COMMITTED' ? null : park(commit), commit };
}

/* ─────────────── the quota interruption's own settlement ────────────────── */

/**
 * What the settlement leaves the step to do.
 *
 * `BLOCKED` means the settlement's own gate already made this step's one
 * durable write and the step must return that result unchanged. `RECORD` means
 * the interruption is still to be recorded, with whatever the settlement was
 * able to establish — which may be nothing.
 */
type QuotaSettlement =
  | { readonly kind: 'BLOCKED'; readonly result: LoopStepResult }
  | {
      readonly kind: 'RECORD';
      /** A settled checkpoint, or `null` — the withdrawal, as before V3-10. */
      readonly checkpoint: InterruptionCheckpoint | null;
      readonly scope: ScopeAssessment | null;
      readonly commit: CommitTaskWorkResult | null;
    };

/**
 * Nothing was settled and nothing was measured.
 *
 * The value for an interruption this build does not settle at all, and the
 * shape every settlement failure degrades to: `checkpoint: null` is what makes
 * `recordAgentInterruption` withdraw the checkpoint claims exactly as it did
 * before V3-10.
 */
const UNSETTLED: QuotaSettlement = Object.freeze({
  kind: 'RECORD' as const,
  checkpoint: null,
  scope: null,
  commit: null,
});

/**
 * HEAD and cleanliness, read **after** a settlement rather than inferred from
 * it.
 *
 * Both facts have to be measured, and neither may be taken from the commit that
 * produced them. `commitTaskWork` reads HEAD *inside* itself, before its own
 * path-set control runs, so its answer is a statement about the past; and it
 * never observes cleanliness at all — its `COMMITTED` arm does no post-commit
 * `status`, and its `NOTHING_TO_COMMIT` arm carries no commit id. Inferring
 * "the tree must be clean, we just committed" is the exact substitution
 * `evaluateAutomaticResume` exists to refuse.
 *
 * `null` on either side is "not established", never a plausible default, and
 * the mint treats it as a denial. Same vocabulary and same two commands as
 * `state/observe-runtime.ts`, deliberately: the value recorded here is compared
 * against that module's answer on every later run, and two observers that
 * phrase the question differently would eventually disagree about a repository
 * neither had changed.
 */
async function observeSettledWorktree(
  git: GitRunner,
  worktreePath: string,
): Promise<{ readonly observedCommit: string | null; readonly worktreeClean: boolean | null }> {
  const head = await git(worktreePath, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    'HEAD',
  ]);
  // The same function `state/observe-runtime.ts` calls, not a second copy of
  // the question. The comment above says these must ask it in the same words;
  // since the remediation they ask it through one caller, so they cannot drift
  // — and that now covers the gitlink probe as well as the argument vector,
  // which matters more, because a second observer that asked only `git status`
  // would certify a tree this one calls dirty.
  return Object.freeze({
    observedCommit: head.outcome === 'OK' && head.stdout !== '' ? head.stdout : null,
    worktreeClean: await observeWorktreeCleanliness(git, worktreePath),
  });
}

/**
 * Settles the repository a quota-interrupted writer left behind, so that the
 * block about to be recorded describes it exactly (V3-10, F-10).
 *
 * ── Why a block needs a checkpoint at all ──────────────────────────────────
 *
 * `BLOCKED_USAGE_LIMIT` is the one state an unattended resume may leave, and
 * `evaluateAutomaticResume` grants that only against an exact recorded
 * `currentCommit` and `worktreeCleanAtCheckpoint === true` which a *fresh*
 * observation still agrees with. A writing phase's interruption withdraws both
 * — correctly, because the writer may have moved HEAD or left work uncommitted
 * — so every production quota block was permanently non-resumable. The answer is
 * to establish the two facts honestly, not to stop requiring them.
 *
 * ── The order is the guarantee ─────────────────────────────────────────────
 *
 *   positively recognised usage limit    (the caller's job, and the only one)
 *     → POST-SCOPE on the writer's actual effect            (here, FIRST)
 *     → stage and commit under AO's own controls            (here)
 *     → observe HEAD and cleanliness                        (here, AFTER)
 *     → one durable write                                   (the caller's job)
 *
 * **Scope comes first, and nothing is committed without a positive verdict.**
 * A writer that escaped its sandbox and then ran out of quota must be recorded
 * as `SCOPE_VIOLATION`, not as a self-clearing pause — otherwise a timer would
 * eventually turn an escape into an automatic writer. It matters mechanically
 * too: `assessTaskScope` approves no paths at all on `VIOLATION` *or*
 * `INDETERMINATE`, so committing on either would create a real object and then
 * fail the path-set control for every path in it, and refusals here do not undo.
 *
 * ── Only a positively recognised usage limit ───────────────────────────────
 *
 * The caller gates this on `AGENT_BLOCKED_USAGE_LIMIT` and nothing else, and
 * `recordAgentInterruption` independently refuses a checkpoint for any other
 * disposition. `AGENT_PROCESS_UNAVAILABLE` is the one that must never be added:
 * it is the code for a run that did *not* end under its own control, and a
 * worktree whose writer may still be alive and writing is exactly what must not
 * be declared settled.
 *
 * ── Every failure degrades to the old behaviour ────────────────────────────
 *
 * A refusal from any step returns {@link UNSETTLED}, and the block is then
 * recorded with its checkpoint withdrawn — byte for byte what this build did
 * before V3-10, and a state `evaluateAutomaticResume` denies with
 * `CURRENT_COMMIT_MISMATCH` and `WORKTREE_NOT_CLEAN`. That is deliberate: when
 * Git will not answer, two things are true at once — the CLI positively reported
 * quota exhaustion, and the checkpoint is unknown — and `BLOCKED_USAGE_LIMIT`
 * with the claims withdrawn is the only durable shape that states both.
 * `HUMAN_DECISION_REQUIRED` would state the second and destroy the first: every
 * such write in this module clears `reportedResetAt`, so the record would stop
 * saying why the task stopped, for a transient Git failure.
 *
 * A **proven** scope violation is the one exception, and it is not a settlement
 * failure: it is a fact about the tree that outranks the quota block, and it
 * takes `SCOPE_VIOLATION` — a state nothing may continue.
 *
 * An *indeterminate* assessment is a settlement failure like any other and is
 * treated as one, which is where this path deliberately differs from
 * `enforceScope`'s. See the comment at that arm for why: parking it would spend
 * the quota record to buy nothing.
 */
async function settleQuotaInterruption(
  current: StateLoadSuccess,
  deps: LoopDependencies & { readonly phase: 'IMPLEMENT' | 'REMEDIATE'; readonly round: number },
): Promise<QuotaSettlement> {
  const state = current.state;
  const { now, authorisedWorktreePath, git, phase, round } = deps;

  const guard = {
    now,
    git: git ?? runGitCommand,
    authorisedWorktreePath,
    writerRan: true,
    advance: leaseAdvanceOptions(deps),
  };

  // POST-SCOPE, before anything is staged, and the verdict is switched on
  // directly rather than through a `blocked` value. That is deliberate: this is
  // the one caller for which the three verdicts do **not** map onto two
  // outcomes, so a nullable result would be a value it is possible to misread as
  // permission. `WITHIN_SCOPE` is the only arm that falls through to a commit.
  const assessment = await measureScope(current, guard);

  // A proven violation outranks the quota block and takes this step's one
  // durable write. `SCOPE_VIOLATION` is not resumable and carries no re-entry
  // point, so no timer can turn an escape back into an automatic writer.
  if (assessment.verdict === 'VIOLATION') {
    return Object.freeze({
      kind: 'BLOCKED' as const,
      result: writeScopeViolation(current, guard, assessment),
    });
  }

  // An **indeterminate** assessment is where this caller parts company with the
  // completed-writer path, and the reason is the quota fact.
  //
  // `enforceScope` parks an indeterminate tree at `HUMAN_DECISION_REQUIRED`, and
  // for a completed writer that is right: nothing else holds the task, and a
  // human has to look. Here something else does hold it — the CLI positively
  // reported quota exhaustion — and every `HUMAN_DECISION_REQUIRED` write in
  // this module clears `reportedResetAt`. Taking that edge because `git diff`
  // would not answer discards a fact that *is* known in order to record one that
  // is not, and converts a self-clearing pause into an operator ticket for a
  // transient failure. A review caught this module doing exactly what the
  // paragraph above forbids.
  //
  // So it fails closed the other way: the block is recorded with its checkpoint
  // withdrawn. Nothing is committed on an assessment that approved nothing, no
  // unattended resume is possible, and the scope question is asked again — by
  // PRE-SCOPE — before any writer runs in that worktree again.
  if (assessment.verdict !== 'WITHIN_SCOPE') {
    return Object.freeze({
      kind: 'RECORD' as const,
      checkpoint: null,
      scope: assessment,
      commit: null,
    });
  }

  // Unreachable in practice — `assessTaskScope` answers `INDETERMINATE` for a
  // task with no base pin, which the arm above has already taken — and kept
  // because `commitTaskWork` requires the value to be a string, and a narrowing
  // that depends on another module's verdict is a narrowing that can rot.
  if (state.basePinnedCommit === null) {
    return Object.freeze({
      kind: 'RECORD' as const,
      checkpoint: null,
      scope: assessment,
      commit: null,
    });
  }

  const commit = await commitTaskWork(leasedGit(deps), authorisedWorktreePath, {
    taskId: state.taskId,
    phase,
    round,
    // Handed down from the gate that approved them, never re-derived here: a
    // set measured at this point would be measured after any injection and
    // would therefore contain it (G12).
    approvedPaths: assessment.approvedPaths,
    basePinnedCommit: state.basePinnedCommit,
  });

  // `NOTHING_TO_COMMIT` is a settlement, not a failure, and this is the one
  // place the two commit callers legitimately differ. A completed pass that
  // changed nothing is inadmissible — there is nothing for verification to look
  // at. A quota refusal that changed nothing is an ordinary pause: the writer
  // was cut off before it wrote, and an interruption does not need fake work to
  // become resumable. No empty commit is manufactured for it; `commitTaskWork`
  // has no `--allow-empty` by contract, and the existing HEAD is what the
  // observation below reads.
  if (commit.outcome !== 'COMMITTED' && commit.outcome !== 'NOTHING_TO_COMMIT') {
    return Object.freeze({
      kind: 'RECORD' as const,
      checkpoint: null,
      scope: assessment,
      commit,
    });
  }

  return Object.freeze({
    kind: 'RECORD' as const,
    // `null` when either fact failed to establish — a HEAD Git would not print,
    // or a tree still holding uncommitted work. Both withdraw the checkpoint.
    checkpoint: mintInterruptionCheckpoint(
      await observeSettledWorktree(leasedGit(deps), authorisedWorktreePath),
    ),
    scope: assessment,
    commit,
  });
}

/**
 * Records a writing pass that did not complete — settling the repository first
 * when, and only when, the refusal was a positively recognised usage limit.
 *
 * The one path both mutating steps take, because the two differ in the cause
 * they give a writer and in nothing else, and an interruption they handled
 * differently would be a second opinion about what an interrupted writer costs
 * the checkpoint.
 *
 * ── Why only a usage limit is settled ──────────────────────────────────────
 *
 * Every other refusal leads to a state no machine may resume — `BLOCKED_AUTH`
 * and `HUMAN_DECISION_REQUIRED` are both `automaticResumeEligible: false` — so
 * settling them would buy nothing and cost a commit. That is the cheap half of
 * the argument. The load-bearing half is `AGENT_PROCESS_UNAVAILABLE`: it is the
 * diagnosis for a run that did **not** end under its own control, and observing
 * a worktree whose writer may still be alive and writing would record a
 * checkpoint about a repository that was changing while it was measured. A
 * usage limit is the only refusal this build recognises *positively* — here,
 * from a `429` in a structured envelope that could only have been printed by a
 * process `endedUnderOwnControl` already vouched for.
 *
 * The reviewer's recogniser (M2 slice 6) reaches the same conclusion through a
 * different channel, because `codex exec --json` offers no structured category
 * to read. It sits behind the same `endedUnderOwnControl` gate, for this exact
 * reason, and `runReviewStep` settles its interruption separately — the two
 * phases withdraw different things, so they cannot share one settlement.
 *
 * Widening this set is a decision with its own evidence to gather, not a
 * generalisation to make in passing.
 */
async function recordInterruption(
  current: StateLoadSuccess,
  writer: ClaudeWriterFailed,
  deps: LoopDependencies & { readonly phase: 'IMPLEMENT' | 'REMEDIATE'; readonly round: number },
): Promise<LoopStepResult> {
  const { now, phase, round } = deps;

  const settlement =
    writer.disposition === 'AGENT_BLOCKED_USAGE_LIMIT'
      ? await settleQuotaInterruption(current, deps)
      : UNSETTLED;

  // The scope gate refused, and it has already made this step's one durable
  // write. Returned unchanged: a second write here is the invariant this whole
  // module rests on.
  if (settlement.kind === 'BLOCKED') return settlement.result;

  const fallback: AgentBlockEvidence = {
    blockedAgent: 'claude',
    resumeFrom: interruptedResumePoint(phase, round),
    reportedResetAt: null,
  };
  const record = recordAgentInterruption(
    current,
    { disposition: writer.disposition, block: writer.block },
    { now, fallback, checkpoint: settlement.checkpoint, ...leaseAdvanceOptions(deps) },
  );

  // What Git said is true whether or not the write landed, so both endings
  // carry it — the same rule `saved()` applies to a refused scope write.
  const measured = { scope: settlement.scope, commit: settlement.commit };
  if (record.outcome === 'STATE_NOT_RECORDED') {
    return result({ outcome: 'STATE_NOT_RECORDED', save: record.save, ...measured });
  }
  return result({ outcome: 'BLOCKED', state: record.state, save: record.save, ...measured });
}

/** The advance options, separated from the execution seams they travel with. */
function leaseAdvanceOptions(deps: LoopDependencies): AdvanceOptions {
  const {
    now, authorisedWorktreePath, agent, verify, observe, git, brief, verification,
    remediationPayload, reviewerProviderGate, ...advance
  } = deps;
  void now; void authorisedWorktreePath; void agent; void verify; void observe; void git;
  void brief; void verification; void remediationPayload; void reviewerProviderGate;
  return advance;
}

/* ─────────────────────────── the scope guard ────────────────────────────── */

/** What the scope guard needs, and what both of its halves are given. */
interface ScopeGuardOptions {
  readonly now: string;
  readonly git: GitRunner;
  readonly authorisedWorktreePath: string;
  readonly phase: ResumePhase;
  readonly round: number;
  /** Whether the writing agent has already run in this pass. */
  readonly writerRan: boolean;
  readonly advance: AdvanceOptions;
}

/**
 * The measurement, on its own.
 *
 * Derived from Git, never accepted as an input. The scope declaration is not
 * passed either — `assessTaskScope` reads it out of the pinned commit.
 *
 * Separated from the writes below so that a caller which needs a *different*
 * durable outcome for one of the refusals can still get the verdict from the
 * one place that produces it. There is exactly one such caller
 * ({@link settleQuotaInterruption}) and exactly one refusal it treats
 * differently; everything about how the verdict is reached stays here.
 */
async function measureScope(
  current: StateLoadSuccess,
  options: Pick<ScopeGuardOptions, 'git' | 'authorisedWorktreePath'>,
): Promise<ScopeAssessment> {
  const state = current.state;
  return await assessTaskScope({
    git: options.git,
    authorisedWorktreePath: options.authorisedWorktreePath,
    basePinnedCommit: state.basePinnedCommit,
    // From the record, not from this invocation. A chained task's authority has
    // to outlive the block run that started it, and a value threaded through
    // `RunRequest` would protect the run and nothing after it.
    scopeAuthorityCommit: state.scopeAuthorityCommit,
  });
}

/**
 * The one durable write for a **proven** violation.
 *
 * Extracted rather than duplicated: it is taken by two callers with different
 * ideas about the *other* refusal, and two copies of an accusation's write shape
 * would be free to disagree about what a violation records.
 */
function writeScopeViolation(
  current: StateLoadSuccess,
  options: Pick<ScopeGuardOptions, 'now' | 'writerRan' | 'advance'>,
  assessment: ScopeAssessment,
): LoopStepResult {
  const state = current.state;
  const save = advanceTaskState(
    current,
    {
      ...state,
      state: 'SCOPE_VIOLATION',
      stateEnteredAt: options.now,
      // Only when a writer actually ran. A pre-writer violation is a fact about
      // the tree this step found, and naming an agent that was never started
      // would attribute it to a run that did not happen.
      blockedAgent: options.writerRan ? 'claude' : null,
      // The state cannot be continued, so it may not carry a re-entry point.
      resumeFrom: null,
      reportedResetAt: null,
      ...withdrawnCheckpointFor(state.state),
    },
    options.advance,
  );
  return saved(save, 'SCOPE_VIOLATION', 'BLOCKED', { scope: assessment });
}

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
  const assessment = await measureScope(current, options);

  if (assessment.verdict === 'WITHIN_SCOPE') return { blocked: null, assessment };
  if (assessment.verdict === 'VIOLATION') {
    return { blocked: writeScopeViolation(current, options, assessment), assessment };
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
    verify,
    agent,
    git,
    observe,
    remediationPayload,
    ...advance
  } = deps;
  void agent;
  void git;
  void observe;
  void remediationPayload;

  if (!authorised(state, authorisedWorktreePath)) return EXECUTION_UNAUTHORISED;

  const report = await runVerification(
    { worktreePath: authorisedWorktreePath, verification },
    { verify: leasedVerify(deps) },
  );

  if (report.verdict === 'PASSED') {
    const save = advanceTaskState(
      current,
      { ...state, state: 'REVIEWING', stateEnteredAt: now, ...RESUME_EVIDENCE_SPENT },
      advance,
    );
    // No attempt is recorded for a pass. The store answers one question — why
    // did AO stop — and a pass is not an answer to it. Spending a bounded
    // history on the outcome nobody needs to read would push the failures an
    // operator does need out of the back of it.
    return saved(save, 'REVIEWING', 'ADVANCED', { verification: report });
  }

  // -- The explanation becomes durable BEFORE the block does ----------------
  //
  // This ordering is the whole of what V4's verification-attempt evidence adds,
  // and the dangerous world it excludes is the one the M1 release gate actually
  // produced: five `BLOCKED_VERIFY` states, none of which carried any account of
  // itself, on a machine where every report had been computed and thrown away.
  //
  // Reversing it — state first, record second — puts a durable accusation
  // against the repository on disk with its evidence still in flight, and a
  // crash in that window leaves exactly the permanently unexplained block this
  // exists to prevent. So the record is written and read back off the disk
  // first, and only a record that came back is allowed to become a block.
  const evidence = await recordVerificationEvidence(current, report, deps);

  // The repository answered no. `BLOCKED_VERIFY` carries no blocked agent —
  // verification runs no agent — and its only continuation is remediation,
  // which is the one resume phase the contract permits it to name.
  //
  // Only where the explanation is durable. A `BLOCKED_VERIFY` whose evidence
  // never reached disk is a state whose one continuation cannot be taken:
  // `runRemediateStep` would have no cause to brief a writer with, and would
  // park the task at `HUMAN_DECISION_REQUIRED` one durable step later having
  // started nothing. Landing there directly says the same true thing, one write
  // sooner, and at the resume phase that re-runs the gate rather than the one
  // that cannot.
  if (report.verdict === 'FAILED' && evidence.recorded) {
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
    return saved(save, 'BLOCKED_VERIFY', 'BLOCKED', {
      verification: report,
      verificationEvidence: evidence,
    });
  }

  // Everything else. Two conditions arrive here and both are truthfully the
  // same landing:
  //
  //  - `UNAVAILABLE` — nothing was learned. Distinct from a failure on purpose:
  //    "the build is broken" and "we could not run the build" send an operator
  //    to different places, and only one of them is about the repository. The
  //    attempt is still recorded, because "AO tried three times and could never
  //    start the gate" is exactly the fact that is otherwise unrecoverable; but
  //    the transition does not depend on that having worked, because it is
  //    already the truthful state for "we cannot say";
  //  - a `FAILED` whose evidence did not become durable. Reported through
  //    `verificationEvidence`, whose code says which of `WRITE_FAILED`,
  //    `ATTEMPT_HISTORY_FULL`, `EXISTING_HISTORY_UNREADABLE`, `READBACK_FAILED`
  //    and the rest it was. That code is **not** persisted — `TaskState` is
  //    `.strict()` and has no field for it — so an operator reads it on the run
  //    that failed, and a later invocation finds a task at the resume phase that
  //    re-runs the gate with no attempt recorded, which is a coherent thing to
  //    find rather than a contradiction.
  //
  // No new state was invented for the second. `HUMAN_DECISION_REQUIRED` with
  // `resumeFrom VERIFY` is a declared edge from `VERIFYING`, its resume phase is
  // one this loop drives, and re-running the gate is the right continuation.
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
  return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED', {
    verification: report,
    verificationEvidence: evidence,
  });
}

/**
 * Builds one attempt record from a non-passing report and hands it to the store.
 *
 * Three inputs the report does not carry, and each is measured rather than
 * assumed:
 *
 *  - **the commit.** `TaskState.currentCommit` is `null` on every task that
 *    reaches verification — the writing step withdraws it, because a checkpoint
 *    claim describing the tree as it was before a writer ran is exactly the
 *    assertion `reconcile.ts` reads as divergence. So HEAD is read from Git here,
 *    through the fenced seam, and a record that cannot name its subject is not
 *    written at all. That is not fastidiousness: an attempt with no commit is a
 *    floating verdict, and the reader that compares it against HEAD later is the
 *    only thing standing between "this tree failed" and "some tree failed";
 *  - **the profile.** `verificationProfileDigest` of the policy that just ran, so
 *    a reader can tell whether a stored failure is about the gate they are
 *    looking at or an earlier, different one;
 *  - **the instant.** The loop's injected `now`, which is when the step began.
 *
 * Never throws, and never returns a `recorded: true` it did not get from the
 * store.
 */
async function recordVerificationEvidence(
  current: StateLoadSuccess,
  report: VerificationReport,
  deps: LoopDependencies,
): Promise<VerificationEvidenceOutcome> {
  const state = current.state;
  const git = leasedGit(deps);

  const head = await observeSettledWorktree(git, deps.authorisedWorktreePath);
  if (head.observedCommit === null) return EVIDENCE_SUBJECT_UNREADABLE;

  const attempt = verificationAttemptFrom(report, {
    attemptedAt: deps.now,
    subjectCommit: head.observedCommit,
    profileDigest: verificationProfileDigest(deps.verification),
  });
  // A report with no stopping phase — the empty-profile `UNAVAILABLE` — has
  // nothing to say about a phase, and a record naming none would answer the
  // store's one question with silence. Reported as its own outcome so a caller
  // can tell it from a store that refused.
  if (attempt === null) return EVIDENCE_NOT_APPLICABLE;

  const record = deps.recordVerificationAttempt ?? defaultVerificationAttemptRecorder;
  const written = await record({
    repositoryRoot: state.repositoryRoot,
    taskId: state.taskId,
    attempt,
    leaseHolds: () => leaseHolds(deps),
    checkIgnored: (relativePath) => askRuntimeIgnored(git, state.repositoryRoot, relativePath),
  });

  return Object.freeze({
    recorded: written.recorded,
    code: written.code,
    path: written.path,
    attemptedAt: attempt.attemptedAt,
    subjectCommit: attempt.subjectCommit,
  });
}

const defaultVerificationAttemptRecorder: VerificationAttemptRecorder = (request) =>
  recordVerificationAttemptInStore(request);

/** What the verify step's recording attempt did. Reported, never persisted. */
export interface VerificationEvidenceOutcome {
  readonly recorded: boolean;
  /**
   * The store's own code, or one of this module's two.
   *
   * `SUBJECT_UNREADABLE` — Git could not say what the worktree is at, so no
   * record could name its subject. `NOT_APPLICABLE` — the report named no
   * stopping phase, so there was nothing to record. Both are distinct from every
   * store code, because "we did not try" and "we tried and could not" send an
   * operator to different places.
   */
  readonly code: VerificationAttemptRecordResult['code'] | 'SUBJECT_UNREADABLE' | 'NOT_APPLICABLE';
  readonly path: string | null;
  readonly attemptedAt: string | null;
  readonly subjectCommit: string | null;
}

const EVIDENCE_SUBJECT_UNREADABLE: VerificationEvidenceOutcome = Object.freeze({
  recorded: false as const,
  code: 'SUBJECT_UNREADABLE' as const,
  path: null,
  attemptedAt: null,
  subjectCommit: null,
});

const EVIDENCE_NOT_APPLICABLE: VerificationEvidenceOutcome = Object.freeze({
  recorded: false as const,
  code: 'NOT_APPLICABLE' as const,
  path: null,
  attemptedAt: null,
  subjectCommit: null,
});

/**
 * What one pass through the provider gate produced.
 *
 * `WITHHELD` is not a reviewer result and is deliberately not shaped like one:
 * no process ran, so there is no process evidence, no transcript and no
 * disposition to read. Folding it into a synthetic `CodexReviewFailed` would
 * put fabricated process facts on the one member callers are allowed to read
 * them from.
 */
type ReviewAttempt =
  | { readonly kind: 'WITHHELD'; readonly resetAt: string }
  | { readonly kind: 'RAN'; readonly review: CodexReviewResult };

/**
 * A checkpoint for a review that was interrupted, or `null` (M2-06).
 *
 * The reviewer is contractually read-only, so a settled checkpoint here is the
 * claim *the tree is exactly as it was before the reviewer opened it*. Three
 * conditions carry that claim, and each closes a different way it could be
 * false:
 *
 *  - **the tree was clean before, and is clean now.** `null` — Git was not
 *    asked — is treated as dirty by the mint itself, so an unanswered question
 *    can never read as a clean tree;
 *  - **HEAD is the same object in both observations.** This is the conjunct the
 *    sandbox flag does not give: `--sandbox read-only` is a request to the CLI,
 *    and `REVIEWING → SCOPE_VIOLATION` exists in the transition table because
 *    the request can be refused. A reviewer that committed would leave a clean
 *    tree at a *different* HEAD, and the clean-tree test alone would settle it;
 *  - **the artefact is minted**, so the value that reaches
 *    `recordAgentInterruption` is one this function established rather than one
 *    a caller wrote down.
 *
 * Why any of it is needed: `evaluateAutomaticResume` grants an unattended
 * resume only against an exact `currentCommit` and `worktreeCleanAtCheckpoint
 * === true`. A task entering `REVIEWING` carries neither — the writing phase
 * withdrew both, and the hop into `REVIEWING` restores nothing — so a codex
 * quota block recorded without this would be a correctly *classified* pause
 * that could never actually resume. That is F-10's defect exactly, on the phase
 * F-10 left out because, at the time, no codex quota block could be produced at
 * all.
 */
function settledReviewCheckpoint(
  before: CompletionCheckpoint,
  after: CompletionCheckpoint,
): InterruptionCheckpoint | null {
  if (before.worktreeClean !== true) return null;
  if (before.currentCommit === null || before.currentCommit !== after.currentCommit) return null;
  return mintInterruptionCheckpoint({
    observedCommit: after.currentCommit,
    worktreeClean: after.worktreeClean,
  });
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

  const { now, authorisedWorktreePath, brief, agent, observe, reviewerProviderGate, ...rest } =
    deps;
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

  // The reviewer is told what the task requires, or no reviewer runs.
  //
  // Re-checked here rather than assumed from an earlier step, exactly as
  // `runImplementStep` re-checks it: a restarted driver enters this step
  // directly, and a task whose file was emptied in the meantime must not have a
  // reviewer briefed from nothing. **Never a fallback to the task id** — that
  // silent degrade is the defect being fixed here, and it would be untestable
  // by absence, since a payload naming only an id looks exactly like a payload
  // for a task with nothing to say.
  if (brief === undefined || !brief.ok || !brief.brief.contextComplete) {
    const save = advanceTaskState(
      current,
      {
        ...state,
        state: 'HUMAN_DECISION_REQUIRED',
        stateEnteredAt: now,
        resumeFrom: { phase: 'REVIEW', round },
        reportedResetAt: null,
      },
      advance,
    );
    return saved(save, 'HUMAN_DECISION_REQUIRED', 'BLOCKED');
  }

  // Observed **before** the reviewer starts, and kept (M2-06).
  //
  // Two different jobs, and only the second is new. A quota-blocked review has
  // to record a checkpoint or it can never be resumed unattended — that is
  // F-10's finding, applied to the phase F-10 did not cover. But a checkpoint
  // observed only *after* the reviewer would settle whatever tree the reviewer
  // left behind, and `transitions.ts` makes `REVIEWING → SCOPE_VIOLATION` a
  // legal edge precisely because a reviewer that writes has broken its
  // contract. Comparing the two observations makes "the reviewer changed
  // nothing" a measurement instead of a restatement of the sandbox flag.
  const beforeReview = await (observe ?? observeCompletion)(state);

  // One reviewer call at a time, per machine, and the quota question answered
  // *inside* the exclusion. Asked outside it, two repositories both read
  // "available" before either had run, and the second would spend the call the
  // first had already proved was not there. See `reviewer-provider-gate.ts`.
  const gate = reviewerProviderGate ?? REVIEWER_PROVIDER_GATE;
  const attempt = await gate.runExclusively('codex', async (): Promise<ReviewAttempt> => {
    const availability = gate.availability('codex', now);
    if (!availability.available) {
      return Object.freeze({ kind: 'WITHHELD' as const, resetAt: availability.resetAt });
    }

    const ran = await runCodexReviewer(
      {
        worktreePath: authorisedWorktreePath,
        round,
        payload: buildReviewPayload(brief.brief, round),
        now,
      },
      { agent: leasedAgent(deps) },
    );

    // Only a positively recognised refusal teaches the gate anything. Every
    // other failure is a fact about this run, not about the subscription.
    if (!ran.ok && ran.code === 'AGENT_USAGE_LIMIT') {
      gate.noteExhausted('codex', ran.block?.reportedResetAt ?? null);
    }
    return Object.freeze({ kind: 'RAN' as const, review: ran });
  });

  // The provider was already known exhausted, so no reviewer was started and no
  // quota was spent. The task is still a quota pause and is recorded as one:
  // that is what is true of it. The checkpoint is the pre-review observation
  // unchanged — nothing ran between taking it and this write.
  if (attempt.kind === 'WITHHELD') {
    const record = recordAgentInterruption(
      current,
      {
        disposition: 'AGENT_BLOCKED_USAGE_LIMIT',
        block: {
          blockedAgent: 'codex',
          resumeFrom: interruptedResumePoint('REVIEW', round),
          reportedResetAt: attempt.resetAt,
        },
      },
      {
        now,
        fallback: codexReviewResumePoint(round),
        checkpoint: settledReviewCheckpoint(beforeReview, beforeReview),
        ...advance,
      },
    );
    if (record.outcome === 'STATE_NOT_RECORDED') {
      return result({ outcome: 'STATE_NOT_RECORDED', save: record.save });
    }
    return result({ outcome: 'BLOCKED', state: record.state, save: record.save });
  }

  const review = attempt.review;

  // Not a review. Every failure code lands here, and none of them may be read
  // as an empty finding list — `findings` does not exist on this member.
  if (!review.ok) {
    // Settled for a recognised quota refusal alone, and for the reason
    // `record-interruption.ts` gives for the writer's: it is the only failure
    // whose process is proven to have ended under its own control, so it is the
    // only one whose worktree may be declared settled. A run that may still be
    // alive must never have a checkpoint written about it.
    const checkpoint =
      review.code === 'AGENT_USAGE_LIMIT'
        ? settledReviewCheckpoint(beforeReview, await (observe ?? observeCompletion)(state))
        : null;

    const record = recordAgentInterruption(
      current,
      { disposition: review.disposition, block: review.block },
      { now, fallback: codexReviewResumePoint(round), checkpoint, ...advance },
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
  //
  // ── And that the task delivered something (DOGFOOD-REM-001 R2) ───────────
  //
  // The first dogfood run settled a task whose worktree was clean at exactly
  // the commit it started from: nothing had been written, the reviewer had
  // nothing to object to, and "clean and known" was read as "finished". A clean
  // tree at the base pin is not a delivered task; it is an untouched one.
  //
  // The comparison is **observed HEAD vs. the record's pin**, and the two
  // provenances are the point. `checkpoint.currentCommit` comes from the fresh
  // `observeCompletion` immediately above; `basePinnedCommit` is a pin, which is
  // a fact the record is entitled to state. Comparing `state.currentCommit`
  // against `state.basePinnedCommit` instead would compare two values an earlier
  // write chose — a record agreeing with itself — and would relocate the TOCTOU
  // rather than close it.
  //
  // **What this conjunct does not own, measured.** A record naming a commit the
  // worktree no longer has never reaches this line: `src/state/reconcile.ts`
  // refuses it first with `CURRENT_COMMIT_MOVED`, the run ends `STATE_DIVERGED`
  // with zero steps, and no reviewer is started. That was measured while
  // building this gate's fixture, and it is recorded here so the guarantee is
  // attributed to the component that actually holds it. What reaches *this*
  // predicate is the ordinary shape — `currentCommit` withdrawn to `null` by the
  // writing phase — which is why the control for it is seeded that way.
  //
  // No task-type discrimination. `kind` is `NORMAL | REMEDIATION`, is not in the
  // task state, and affects only ranking; there is no no-op kind to exempt. If
  // one ever exists the answer here is already right: it parks, and an operator
  // says so.
  //
  // **Residual, named rather than hidden (G2):** this is a SHA-inequality test
  // and is strictly weaker than a non-empty-diff test — `observeTaskDelta` is
  // the primitive that would close it. It is not needed today because AO commits
  // without `--allow-empty` (`commitTaskWork`), so no result commit can exist
  // without staged changes; an empty commit would move HEAD and satisfy this.
  // Closing-audit material.
  const checkpoint = await (observe ?? observeCompletion)(state);
  const settled =
    checkpoint.worktreeClean === true &&
    checkpoint.currentCommit !== null &&
    state.basePinnedCommit !== null &&
    checkpoint.currentCommit !== state.basePinnedCommit;

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
 * The cause for a remediation pass that was resumed rather than driven straight
 * through, from whatever durable evidence exists.
 *
 * Two sources, in this order, and the order is the policy:
 *
 *  1. **the review's findings for this round**, if the durable history holds
 *     any. A review that reported findings is the ordinary reason to remediate,
 *     and its record is the stronger cause: it names how many and how severe;
 *  2. **the latest verification attempt**, if one is on disk *and it is about
 *     the tree the writer is being sent to*.
 *
 * The second condition is not a formality. An attempt names the commit it
 * measured; a remediating writer moves HEAD; and a brief built from an attempt
 * about some earlier commit would tell a writer that the tree in front of it
 * failed, when what failed was a tree that no longer exists. So the record's
 * subject is compared against HEAD read *now*, and a mismatch produces no brief
 * at all rather than a plausible one. `NO_DURABLE_FINDINGS` is the honest answer
 * to "we have evidence, and it is not about this".
 *
 * Every non-`ATTEMPT_HISTORY` reading is likewise no brief. `MALFORMED` and
 * `UNSUPPORTED_VERSION` mean something is on that path and this build cannot say
 * what it claims, which is emphatically not the same as no cause existing — but
 * it is the same *decision*, because neither entitles anyone to brief a writer.
 * The difference is reported to the operator by the read path, not resolved
 * here.
 */
async function resumedBrief(
  current: StateLoadSuccess,
  deps: LoopDependencies,
  round: number,
): Promise<ResumedRemediationBrief> {
  const state = current.state;

  const fromReview = buildResumedRemediationBrief(state.findingHistory, round);
  if (fromReview.kind === 'DURABLE_RECORD') return fromReview;

  const load = (deps.loadVerificationAttempts ?? defaultVerificationAttemptLoader)(
    state.repositoryRoot,
    state.taskId,
  );
  const attempt = latestVerificationAttempt(load);
  if (attempt === null) return Object.freeze({ kind: 'NO_DURABLE_FINDINGS' as const });

  const head = await observeSettledWorktree(leasedGit(deps), deps.authorisedWorktreePath);
  if (head.observedCommit === null || head.observedCommit !== attempt.subjectCommit) {
    return Object.freeze({ kind: 'NO_DURABLE_FINDINGS' as const });
  }

  return Object.freeze({
    kind: 'DURABLE_RECORD' as const,
    payload: buildVerificationRemediationPayload(attempt, round),
  });
}

const defaultVerificationAttemptLoader: VerificationAttemptLoader = (repositoryRoot, taskId) =>
  loadVerificationAttemptsFromStore(repositoryRoot, taskId);

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
    verification,
    verify,
    observe,
    ...advance
  } = deps;
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
  // somewhere other than `REVIEWING` — the durable record is the only evidence
  // there is, and where it holds nothing there is no brief to build. Composing
  // one anyway produces a document in the reviewer's voice claiming a review
  // reported findings and then listing none of them, which is a fabricated cause
  // handed to a writing agent with a worktree to modify.
  //
  // `BLOCKED_VERIFY → REMEDIATING` used to be the sharp case, and this comment
  // used to say the report was "deliberately never persisted, so nothing durable
  // makes it actionable". That was true and it was the release blocker: the one
  // declared continuation out of `BLOCKED_VERIFY` led here, found no cause, and
  // parked the task at `HUMAN_DECISION_REQUIRED` without starting a writer.
  // V4's verification-attempt evidence closes it — the failure is now on disk,
  // in its own store, and {@link resumedBrief} reads it. The rule the old
  // sentence protected is unchanged and is what that function still enforces: a
  // caller that has not established a cause may not invent one.
  const brief =
    remediationPayload === undefined
      ? await resumedBrief(current, deps, round)
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
    { agent: leasedAgent(deps) },
  );

  if (!writer.ok) {
    return await recordInterruption(current, writer, { ...deps, phase: 'REMEDIATE', round });
  }

  // POST-SCOPE. Identical to the implement pass, and deliberately so: the two
  // steps differ in the cause they are given and in nothing else, so a
  // remediation that writes outside the declared scope must not reach
  // `VERIFYING` either. A guard on only the first pass would be a sandbox a
  // writer escapes on its second attempt.
  const after = await enforceScope(current, { ...scopeGuard, writerRan: true });
  if (after.blocked !== null) return withDenials(after.blocked, writer.permissionDenials);

  // AO records the pass. Nothing changed → nothing recorded → inadmissible.
  const recorded = await commitPassOrPark(current, after.assessment.approvedPaths, {
    ...deps,
    phase: 'REMEDIATE',
    round,
  });
  if (recorded.blocked !== null) {
    return withDenials(recorded.blocked, writer.permissionDenials);
  }

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
  return saved(save, 'VERIFYING', 'ADVANCED', {
    scope: after.assessment,
    permissionDenials: writer.permissionDenials,
    commit: recorded.commit,
  });
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

  const { now, authorisedWorktreePath, agent, git, remediationPayload, brief, verification, verify, observe, ...advance } = deps;
  void agent;
  void git;
  void remediationPayload;
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

  const { now, authorisedWorktreePath, brief, agent, git, remediationPayload, verification, verify, observe, ...advance } = deps;
  void agent;
  void git;
  void remediationPayload;
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

  const { now, authorisedWorktreePath, agent, brief, git, remediationPayload, verification, verify, observe, ...advance } = deps;
  void remediationPayload;
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
    { agent: leasedAgent(deps) },
  );

  if (!writer.ok) {
    return await recordInterruption(current, writer, { ...deps, phase: 'IMPLEMENT', round });
  }

  // POST-SCOPE. The guarantee: no mutating step is left successfully until the
  // writer's *actual* effect on the repository has been measured. This runs
  // before the durable move, so a task that wrote out of scope cannot reach
  // `VERIFYING` — and therefore cannot reach a reviewer either.
  const after = await enforceScope(current, { ...scopeGuard, writerRan: true });
  if (after.blocked !== null) return withDenials(after.blocked, writer.permissionDenials);

  // AO records the pass. A writer that completed and changed nothing does not
  // reach `VERIFYING` — it parks, because there is nothing for verification to
  // look at and "the agent finished" is not the same claim as "the work exists".
  const recorded = await commitPassOrPark(current, after.assessment.approvedPaths, {
    ...deps,
    phase: 'IMPLEMENT',
    round,
  });
  if (recorded.blocked !== null) {
    return withDenials(recorded.blocked, writer.permissionDenials);
  }

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
  return saved(save, 'VERIFYING', 'ADVANCED', {
    scope: after.assessment,
    permissionDenials: writer.permissionDenials,
    commit: recorded.commit,
  });
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
  return dispatch(current, deps);
}


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
