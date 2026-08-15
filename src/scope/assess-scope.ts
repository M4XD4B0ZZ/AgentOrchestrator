/**
 * The scope verdict — derived here, from Git, and never accepted from a caller.
 *
 * ── What this module refuses to be ─────────────────────────────────────────
 *
 * There is no `scopePassed: boolean` anywhere in this slice, and no
 * `ScopeAssessment` a caller can construct and hand in. V2-05 established why
 * with `authPreflightPassed`: a boolean that three layers pass along unchanged
 * is a *caller assertion* wearing the word "evidence", and replacing it with a
 * plain object would only have been the same assertion in a longer spelling,
 * because TypeScript is structural.
 *
 * V2-05 solved that with an opaque, nominally-typed artefact plus a runtime
 * gate. This slice does not need one, and that is the stronger answer rather
 * than a weaker one: the mutating step calls {@link assessTaskScope} itself, so
 * there is no artefact in flight to forge, no boundary to smuggle one across,
 * and no `instanceof` check standing between a claim and its consumer. The
 * inputs a caller does supply — where to look and what to look back to — are
 * not a verdict:
 *
 *     authorisedWorktreePath   (the path Git printed, per V1-07)
 *   + durable basePinnedCommit (read off the persisted state)
 *   + canonical scope          (read out of the pinned commit, not passed in)
 *                │
 *                ▼
 *        internal Git observation
 *                │
 *                ▼
 *          scope assessment
 *
 * Note in particular that the scope declaration is *not* a parameter. A caller
 * that could pass one could authorise anything it liked, which would make the
 * guard a formality; `pinned-scope.ts` reads it from the commit instead, and
 * explains why that source and no other.
 *
 * ── "Could not check" is not "checked and clean" ───────────────────────────
 *
 * The verdict is a three-way union, and the third member is the point. A Git
 * that could not be run, a pin that no longer resolves, a profile missing from
 * the pinned tree — none of those are evidence that the writer stayed in scope,
 * and none of them are evidence that it did not.
 *
 * Collapsing `INDETERMINATE` into `VIOLATION` would tell an operator an agent
 * left its sandbox when the truth is that Git could not be read, and
 * `SCOPE_VIOLATION` is the one state that says *go and look at the damage*.
 * Collapsing it into `WITHIN_SCOPE` would let an unreadable repository wave a
 * task straight through the gate. So it is kept apart, exactly as
 * `observe-runtime.ts` keeps "never established" apart from "false", and the
 * caller is left to park the task under a state that says what actually
 * happened. Both refusals stop the task; only one of them accuses the agent.
 */

import type { GitRunner } from '../worktree/git-command.js';
import { readPinnedScope, type PinnedScopeRefusal } from './pinned-scope.js';
import { classifyPath, type ScopeDecision } from './scope-policy.js';
import { observeTaskDelta, type ChangeKind, type DeltaRefusal } from './task-delta.js';

/** The three answers. Only `WITHIN_SCOPE` permits a mutating step to continue. */
export const SCOPE_VERDICTS = ['WITHIN_SCOPE', 'VIOLATION', 'INDETERMINATE'] as const;
export type ScopeVerdict = (typeof SCOPE_VERDICTS)[number];

/** Why no verdict could be reached. The two sources' refusals, kept distinct. */
export type ScopeIndeterminateReason = DeltaRefusal | PinnedScopeRefusal;

/** One changed path the declared scope does not permit. */
export interface ScopeOffence {
  readonly path: string;
  readonly change: ChangeKind;
  /** Never `ALLOWED`: an allowed path is not an offence. */
  readonly decision: Exclude<ScopeDecision, 'ALLOWED'>;
}

/**
 * Offences carried on a result, at most.
 *
 * A writer that unpacked an archive into the wrong directory produces thousands
 * of them, and this value travels into a step result a driver may render. The
 * count is reported separately and the truncation is flagged, because a list
 * silently cut at its ceiling reads as the whole story — and here the whole
 * story is how far outside its sandbox an agent got.
 */
export const MAX_REPORTED_OFFENCES = 32;

export interface ScopeAssessment {
  readonly verdict: ScopeVerdict;
  /** Up to {@link MAX_REPORTED_OFFENCES} offences, in Git's reporting order. */
  readonly offences: readonly ScopeOffence[];
  /** How many offences there were in total, however many are listed above. */
  readonly offenceCount: number;
  /** `true` when {@link offences} lists fewer than {@link offenceCount}. */
  readonly offencesTruncated: boolean;
  /** Present only on `INDETERMINATE`. */
  readonly reason: ScopeIndeterminateReason | null;
}

export interface ScopeAssessmentInput {
  /** The Git seam. Raw evidence, never a verdict. */
  readonly git: GitRunner;
  /** The path Git printed for this task's registration. Never `state.worktreePath`. */
  readonly authorisedWorktreePath: string;
  /** The task's durable pin, read off the persisted state by the caller. */
  readonly basePinnedCommit: string | null;
  /**
   * The commit whose profile governs, or `null` when the base pin governs.
   *
   * Read off the same persisted state as {@link basePinnedCommit} and never
   * invented by a caller — it is a durable property of the task, not of the
   * invocation driving it.
   */
  readonly scopeAuthorityCommit: string | null;
}

function indeterminate(reason: ScopeIndeterminateReason): ScopeAssessment {
  return Object.freeze({
    verdict: 'INDETERMINATE' as const,
    offences: Object.freeze([]),
    offenceCount: 0,
    offencesTruncated: false,
    reason,
  });
}

/**
 * Assesses the task's whole current effect against the scope it was pinned
 * under.
 *
 * Read-only: it observes, classifies and reports, and writes nothing anywhere.
 * In particular it never reverts, resets or cleans the worktree — the changes
 * that produced a violation are the evidence a human is being asked to look at,
 * and destroying them to tidy up would hide the effect *and* risk discarding
 * legitimate work sitting in the same tree.
 *
 * Safe to call more than once for one pass, and that is how it is used: once
 * before the writer starts and once after it finishes.
 */
export async function assessTaskScope(input: ScopeAssessmentInput): Promise<ScopeAssessment> {
  const { git, authorisedWorktreePath, basePinnedCommit, scopeAuthorityCommit } = input;

  // The declaration first. A delta cannot be classified without one, and asking
  // Git for a diff we could not judge would be work done to reach the same
  // refusal one call later.
  //
  // Two commits, and the difference is the whole of E2. The *delta* is measured
  // from the base pin, because that is the tree this task's work sits on top of.
  // The *declaration* is read from the scope authority, because a predecessor
  // that hands its successor code must not thereby hand it permission. For an
  // ordinary task the two are the same commit and nothing changes; for a chained
  // one the authority is the commit the block was frozen at. This `??` is the one
  // place the fallback exists, so there is one answer to "which commit governed".
  const scope = await readPinnedScope(
    git,
    authorisedWorktreePath,
    scopeAuthorityCommit ?? basePinnedCommit,
  );
  if (scope.outcome !== 'RESOLVED') return indeterminate(scope.refusal);

  const delta = await observeTaskDelta(git, authorisedWorktreePath, basePinnedCommit);
  if (delta.outcome !== 'OBSERVED') return indeterminate(delta.refusal);

  const offences: ScopeOffence[] = [];
  let offenceCount = 0;

  for (const changed of delta.paths) {
    const decision = classifyPath(changed.path, scope.scope);
    if (decision === 'ALLOWED') continue;
    offenceCount += 1;
    if (offences.length < MAX_REPORTED_OFFENCES) {
      offences.push(Object.freeze({ path: changed.path, change: changed.change, decision }));
    }
  }

  return Object.freeze({
    verdict: offenceCount === 0 ? ('WITHIN_SCOPE' as const) : ('VIOLATION' as const),
    offences: Object.freeze([...offences]),
    offenceCount,
    offencesTruncated: offenceCount > offences.length,
    reason: null,
  });
}
