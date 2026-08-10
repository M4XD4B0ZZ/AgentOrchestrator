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
import type { AgentRunner } from '../agent/agent-command.js';
import { recordAgentInterruption } from '../agent/record-interruption.js';
import { absolutePathsEqual, isComparablePath } from '../core/path-identity.js';
import { RESUME_EVIDENCE_SPENT } from '../core/resume-point.js';
import type { TaskState } from '../core/task-state.js';
import type { TaskStateName } from '../core/states.js';
import type { ResolvedVerificationPolicy } from '../repo/resolve-repository.js';
import { advanceTaskState, type AdvanceOptions } from '../state/advance-state.js';
import { observeRuntime } from '../state/observe-runtime.js';
import type { StateLoadSuccess, StateSaveResult } from '../state/state-store.js';
import { runGitCommand } from '../worktree/git-command.js';
import { runVerification, type VerificationReport } from '../verify/run-verification.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import {
  appendFindings,
  buildRemediationPayload,
  buildResumedRemediationBrief,
  buildReviewPayload,
} from './findings.js';

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
  /** Execution seams. Default to the real ones; tests pass their own. */
  readonly verify?: VerificationRunner;
  readonly agent?: AgentRunner;
  readonly observe?: CompletionObserver;
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
  if (!save.ok) return result({ outcome: 'STATE_NOT_RECORDED', save, ...extra });
  return result({ outcome, state, save, ...extra });
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
    observe,
    remediationPayload,
    ...advance
  } = deps;
  void taskBrief;
  void agent;
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
  const { verification, verify, remediationPayload, ...advance } = rest;
  void verification;
  void verify;
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

  // The writer changed the worktree and nothing here looked at the result, so
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
  return saved(save, 'VERIFYING', 'ADVANCED');
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
  switch (current.state.state) {
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
