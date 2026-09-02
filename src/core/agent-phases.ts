/**
 * What runs in each phase, and which checkpoint claims its running invalidates.
 *
 * The single source for three questions a caller must not be trusted to answer
 * about itself: *which agent was running*, *where the task re-enters*, and
 * *whether the repository was modified*. All three are properties of the phase,
 * and the phase is persisted — so the durable state already knows, and asking
 * the caller only creates the opportunity to disagree with it (V1-05-RR-F4).
 *
 * It lives in `core/` rather than beside any one of its callers because more
 * than one durable write depends on it: an interrupted agent's block
 * (`agent/record-interruption.ts`) and a blocked task's resume
 * (`run/run-driver.ts`) both have to decide what a phase's execution costs the
 * checkpoint. A second table anywhere would be a second opinion about what
 * `REMEDIATING` means.
 *
 * States absent from this table run no agent. `VERIFYING` is the one that
 * matters: it runs the project's own commands and consumes no agent quota,
 * which is why `VERIFYING → BLOCKED_USAGE_LIMIT` is not a declared edge. They
 * are left to `advanceTaskState`, so the transition table stays the one
 * authority on which moves exist.
 */

import type { AgentId, ResumePhase, TaskStateName } from './states.js';

/** What is running in a phase, and what its running does to the worktree. */
export interface AgentPhase {
  readonly agent: AgentId;
  readonly resumePhase: ResumePhase;
}

export const AGENT_PHASES: Readonly<Partial<Record<TaskStateName, AgentPhase>>> = Object.freeze({
  IMPLEMENTING: Object.freeze({ agent: 'claude', resumePhase: 'IMPLEMENT' }),
  REMEDIATING: Object.freeze({ agent: 'claude', resumePhase: 'REMEDIATE' }),
  REVIEWING: Object.freeze({ agent: 'codex', resumePhase: 'REVIEW' }),
});

/**
 * `true` when an agent runs in `phase`. Total over the state vocabulary.
 *
 * This is the question the checkpoint rule asks, and until M2 slice 6 it asked
 * a narrower one — *does this phase edit the repository* — with `REVIEWING`
 * answering no. See {@link withdrawnCheckpointFor} for why that answer was
 * unsafe and why the field it read no longer exists.
 */
export function phaseRunsAnAgent(phase: TaskStateName): boolean {
  return AGENT_PHASES[phase] !== undefined;
}

/**
 * The checkpoint facts a writing phase's execution may invalidate, withdrawn.
 *
 * Spread **after** `...state` on a durable write whose subject is a phase that
 * mutates the repository — whether that phase has just been interrupted, or is
 * about to begin. The parameter is the phase whose *execution* is in question,
 * which is why the interruption path passes the phase it is leaving and the
 * resume path passes the phase it is entering.
 *
 * `worktreeCleanAtCheckpoint` and `currentCommit` are observations, true when
 * something last looked. Carrying them across a writer's run *re-asserts* them,
 * and a writing agent changing the worktree is not an edge case — it is the job
 * (V1-05-RR-F8).
 *
 * The consequence of re-asserting them is severe and one-directional.
 * `reconcile.ts` reads `worktreeCleanAtCheckpoint: true` as a record that a
 * dirty tree contradicts, and a recorded `currentCommit` as a HEAD that a task
 * commit contradicts — either makes the verdict `DIVERGED`, which
 * `classifyResume` turns into `STATE_DIVERGED` / `BLOCKED`. So a self-clearing
 * quota pause became `RESUME_STATE_DIVERGED`, permanently non-resumable, for a
 * condition true of *every* writer the orchestrator itself authorised.
 * Reconciliation is already built to survive the honest version: a checkpoint
 * recording `false` is "a task with work in progress, which is the normal thing
 * to find".
 *
 * Neither value is fabricated in the other direction. `false` does not claim
 * the tree is dirty — nothing here looked at it — it withdraws a claim that it
 * is clean, which is a weaker statement and a true one. `null` likewise means
 * the recorded HEAD is no longer known to be current, not that there is no
 * commit. Everything else the state holds, including `basePinnedCommit` and
 * `findingHistory`, is durable evidence and is carried through untouched.
 *
 * ── The rule is "an agent ran", not "a writer ran" (M2 slice 6) ────────────
 *
 * This used to withdraw nothing for `REVIEWING`, on the argument that the
 * reviewer could not have changed the worktree, so discarding true evidence for
 * a run that could not have invalidated it would be its own kind of lie.
 *
 * The premise is a **request**, not a fact. `--sandbox read-only` is asked of
 * the CLI, and `transitions.ts` declares `REVIEWING → SCOPE_VIOLATION`
 * precisely because the request can be refused. The argument also had no
 * subject while it stood: every producer of `REVIEWING` arrived carrying
 * `currentCommit: null` and `worktreeCleanAtCheckpoint: false`, so there was no
 * true evidence to preserve — only the two withdrawals the writing phase had
 * already made.
 *
 * M2 slice 6 gave `REVIEWING` a checkpoint of its own, and that made the gap
 * reachable: a resumed review could now *carry* `clean: true` at an exact
 * commit, and a second interruption that measured nothing would have re-asserted
 * both over a tree the reviewer may have dirtied. `reconcile.ts` reads that as
 * `WORKTREE_DIRTY` / `CURRENT_COMMIT_MOVED` → `RESUME_STATE_DIVERGED`, which
 * nothing resumes and no operator command clears — strictly worse than the
 * `HUMAN_DECISION_REQUIRED` it replaced.
 *
 * So the question is now the one that was always meant: **did an agent run
 * here.** Any agent's run invalidates a claim about the tree, because the claim
 * that it could not is a claim about a sandbox this process does not enforce.
 * States that run no agent are unaffected — `VERIFYING` runs the project's own
 * commands and is absent from the table, so nothing is withdrawn for it.
 *
 * The cost this used to buy is bought properly instead, by the same mechanism
 * the writer uses: `loop/loop-step.ts:settledReviewCheckpoint` *measures* the
 * tree either side of the reviewer and mints a checkpoint when the two agree.
 * Withdrawal is what happens when nothing was measured, for every phase alike.
 *
 * ── Withdrawal is the honest answer, and it was the only one ───────────────
 *
 * For a *mutating* phase the cost above was paid in full: an interrupted writer
 * withdrew both claims, `evaluateAutomaticResume` denied
 * `CURRENT_COMMIT_MISMATCH` and `WORKTREE_NOT_CLEAN`, and every production quota
 * block was permanently non-resumable however trustworthy its reset time (F-10).
 *
 * V3-10 does not weaken that. It adds the only other honest way out: *establish
 * the two facts again*. `loop/loop-step.ts` settles a quota-interrupted
 * writer's worktree — scope first, then AO's own commit, then an observation of
 * HEAD and cleanliness — and `agent/record-interruption.ts` records what was
 * measured in place of the withdrawal, but only against an artefact that
 * settlement path mints. Everything else, including every failure of that path,
 * still lands here.
 */
export function withdrawnCheckpointFor(
  phase: TaskStateName,
): { readonly worktreeCleanAtCheckpoint: false; readonly currentCommit: null } | Record<never, never> {
  return phaseRunsAnAgent(phase) ? { worktreeCleanAtCheckpoint: false, currentCommit: null } : {};
}
