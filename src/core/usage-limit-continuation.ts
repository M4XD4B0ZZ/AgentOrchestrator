/**
 * When an operator may continue a `BLOCKED_USAGE_LIMIT` task (M3-02).
 *
 * ── One sentence, and it is the whole contract ─────────────────────────────
 *
 * `--continue-usage-limit` continues a quota block exactly when **the record
 * itself**, and not the world, is what makes an automatic resume impossible.
 *
 * Everything below is that sentence made total. A reset still ahead is refused,
 * because time will clear it and the machine already knows when. A record an
 * automatic resume could be granted from is refused, because the automatic path
 * owns that question and this decision carries no evidence about the world it
 * would be denying on. What is left — a pause with no end recorded, a pause
 * whose end cannot be read, and a pause whose resume record was withdrawn — is
 * the operator's, because nothing else in this build can move it.
 *
 * ── Why this replaced `reportedResetAt === null` ───────────────────────────
 *
 * M2 slice 6 built the escape with that single term, and it was right about the
 * case it was built for: an agent that reports an exhausted allowance without
 * saying when it returns leaves a task nothing can ever resume. It was wrong
 * about the *set*, and the difference was measured rather than argued.
 *
 * `loop/loop-step.ts` records a usage-limit block with its interruption
 * checkpoint **withdrawn** on several production paths — among them an
 * out-of-scope tree, a commit that did not complete, and a settlement Git would
 * not vouch for, on both the writing and the reviewing side. No count is given
 * here on purpose: `README.md` says four, one investigation counted five and
 * another six, and the three were counting different things. What matters is
 * the class, and the class is ordinary rather than exotic. A withdrawn
 * checkpoint is `currentCommit: null` and
 * `worktreeCleanAtCheckpoint: false`, and `evaluateAutomaticResume` denies on
 * both for ever, whatever anybody does to the repository. Such a task also
 * records a reset instant, so the M2 term refused it. Reproduced against the
 * shipped CLI on 2026-09-02 at `fdbe999`: an attended re-run, an attended re-run
 * with `--continue-usage-limit`, an `--automatic-resume-only` run and a
 * scheduler pass all stopped with `AUTOMATIC_RESUME_REFUSED` /
 * `CURRENT_COMMIT_MISMATCH, WORKTREE_NOT_CLEAN`, and the state file came out
 * byte-identical from every one of them. `README.md` carried it as L-M3-01-1.
 *
 * The replacement is **strictly wider on that shape and on nothing else**. Every
 * `reportedResetAt === null` state produces `RESET_TIME_MISSING` here and is
 * still permitted; every future reset produces `RESET_TIME_NOT_REACHED` and is
 * still refused; every past reset whose record is intact produces no refusal at
 * all and is still refused. That is asserted per shape in
 * `tests/m3-02-usage-limit-recovery.test.ts` rather than left as a claim.
 *
 * ── What the permission is not ─────────────────────────────────────────────
 *
 * It is not a quota override, and it asserts nothing about the allowance. It
 * does not skip the lease, the plan, the scope gates or any lifecycle
 * transition: `run/run-driver.ts` conjoins it with the attended grant, with a
 * resume point the loop can actually drive, and with the one-use bound, and the
 * resume it authorises is `resumeBlockedTask` unchanged — the same write the
 * automatic path makes. A tree the withdrawal was recorded for is met again by
 * PRE-SCOPE before any writer runs in it, which is `loop-step.ts`'s own stated
 * reason for withdrawing rather than escalating.
 *
 * ── Pure ──────────────────────────────────────────────────────────────────
 *
 * No clock read, no filesystem, no Git. `now` is supplied, exactly as
 * `core/automatic-resume.ts` requires of its own callers, so a scheduler
 * classifying fifty parked tasks against one instant cannot get fifty different
 * answers to "is the reset behind us".
 */

import {
  recordOnlyResumeRefusals,
  type AutomaticResumeReasonCode,
} from './automatic-resume.js';
import type { TaskState } from './task-state.js';

/**
 * The readings that refuse. Every one of them means "not yours to continue",
 * and each says why in different words because they send an operator somewhere
 * different.
 */
export const USAGE_LIMIT_CONTINUATION_REFUSALS = [
  /** The task is not parked on a quota block at all. */
  'STATE_NOT_BLOCKED_ON_USAGE_LIMIT',
  /** The clock this was judged against is not a timestamp. Fail-closed. */
  'CURRENT_TIME_UNREADABLE',
  /** A reset instant is recorded and has not arrived. The machine's wait. */
  'RESET_AHEAD',
  /**
   * The record refuses for a reason this build is not willing to continue past.
   *
   * The fail-closed floor, and it is load-bearing rather than decorative. The
   * refusals below are enumerated because "the record refuses" and "an operator
   * may override *this* refusal" are two different judgements, and only the
   * first belongs to the resume policy. A record whose `repositoryRoot` is a
   * relative path is the case that produced this member: `NonBlankString` admits
   * one, `canonicalPathsEqual` refuses one, and the refusal is therefore
   * record-only — but it is not a withdrawn checkpoint, and permitting it under
   * a reading whose sentence talks about commits and worktrees would be a lie
   * told by a report.
   *
   * A later slice that adds a record-only check to the resume policy lands here
   * rather than silently widening the escape. That is the direction to fail in,
   * and the code is nameable so an operator can say which one they met.
   */
  'RECORD_REFUSAL_UNRECOGNISED',
  /**
   * The record names no phase to continue at, so there is nowhere to go.
   *
   * Unreachable through the state contract — `resumeFromRequirement` is
   * `REQUIRED` for this state and `core/task-state.ts` refuses a record without
   * one — and answered anyway, because the driver conjoins its own
   * `resumeFrom !== null` term and a disposition that said "permitted" while the
   * driver refused would be a report disagreeing with the build.
   */
  'RESUME_POINT_MISSING',
  /**
   * Nothing about the record refuses. The automatic path owns this task: it
   * will grant the resume unless the *world* denies, and this decision holds no
   * evidence about the world.
   */
  'MACHINE_MAY_STILL_RESUME',
] as const;

/** The readings that permit. Each names a different way the record is a dead end. */
export const USAGE_LIMIT_CONTINUATION_PERMISSIONS = [
  /**
   * No reset instant was recorded. The M2 slice 6 case: the agent said the
   * allowance was gone without saying when it returns.
   */
  'RESET_UNRECORDED',
  /**
   * A reset instant is recorded and is not a timestamp.
   *
   * No producer is known to reach it: `reportedResetAt` is
   * `z.iso.datetime({ offset: true })`, and every probe measured against that
   * schema on 2026-09-02 that it accepted was also `Date.parse`-able — including
   * the year bounds and an out-of-range offset. That is a measurement over
   * probes and not a proof over the language the schema accepts, so the reading
   * exists rather than being asserted away. It permits rather than refuses
   * because it is the same dead end as an absent instant: nothing can wait for
   * it, ever.
   */
  'RESET_UNREADABLE',
  /**
   * The reset has passed and the resume record was withdrawn — no commit to
   * compare against, or a tree already dirty when the block was written. The
   * shape this slice exists for.
   */
  'RESUME_RECORD_WITHDRAWN',
] as const;

export const USAGE_LIMIT_CONTINUATION_READINGS = [
  ...USAGE_LIMIT_CONTINUATION_REFUSALS,
  ...USAGE_LIMIT_CONTINUATION_PERMISSIONS,
] as const;

export type UsageLimitContinuationRefusal = (typeof USAGE_LIMIT_CONTINUATION_REFUSALS)[number];
export type UsageLimitContinuationPermission =
  (typeof USAGE_LIMIT_CONTINUATION_PERMISSIONS)[number];
export type UsageLimitContinuationReading = (typeof USAGE_LIMIT_CONTINUATION_READINGS)[number];

/**
 * One reading, with its permission bound into it.
 *
 * Discriminated on purpose, and for the reason `notify/attention.ts` gives about
 * its own table: two tables keyed by the same vocabulary can each be total while
 * disagreeing about the same member. Binding `permitted` to the reading removes
 * that by construction — there is no reading whose permission came from a
 * different row than its name.
 */
export type UsageLimitContinuation =
  | { readonly reading: UsageLimitContinuationRefusal; readonly permitted: false }
  | { readonly reading: UsageLimitContinuationPermission; readonly permitted: true };

/**
 * The record-only refusals an operator decision may continue past.
 *
 * Enumerated deliberately, and it is **not** the "second reading of another
 * module's policy" this design otherwise avoids. Two different questions are
 * being asked, and only the first is the resume policy's:
 *
 *  - *is this refusal a property of the record or of the world?* —
 *    `recordOnlyResumeRefusals` answers that, by evaluation, so it cannot drift;
 *  - *may a human override this particular record fault?* — that is this
 *    module's own judgement, and it has to be written down somewhere.
 *
 * Three shapes are here. The two reset refusals are the pause with no end
 * anybody can wait for. `CURRENT_COMMIT_MISMATCH`, `WORKTREE_NOT_CLEAN` and
 * `BASE_COMMIT_MISMATCH` are the withdrawn resume record — under favourable
 * evidence each can only mean that the *record's* own field is `null` or
 * `false`, because the observed half was stipulated to agree.
 *
 * Everything else refuses. See `RECORD_REFUSAL_UNRECOGNISED`.
 */
const CONTINUABLE_RECORD_REFUSALS: ReadonlySet<AutomaticResumeReasonCode> = new Set([
  'RESET_TIME_MISSING',
  'RESET_TIME_UNPARSEABLE',
  'CURRENT_COMMIT_MISMATCH',
  'WORKTREE_NOT_CLEAN',
  'BASE_COMMIT_MISMATCH',
]);

const refuse = (reading: UsageLimitContinuationRefusal): UsageLimitContinuation =>
  Object.freeze({ reading, permitted: false as const });

const permit = (reading: UsageLimitContinuationPermission): UsageLimitContinuation =>
  Object.freeze({ reading, permitted: true as const });

/**
 * Whether an operator decision may continue this task, and what to call the
 * answer.
 *
 * Fail-closed in its ordering: every refusal is asked before any permission, so
 * a condition that is not positively established cannot produce a grant. The
 * two that could otherwise co-occur are the reason the order is written down —
 * a record that is both future-dated *and* withdrawn is `RESET_AHEAD`, because
 * the wait is real whatever else is wrong.
 */
export function usageLimitContinuation(
  state: TaskState,
  now: string | Date,
): UsageLimitContinuation {
  if (state.state !== 'BLOCKED_USAGE_LIMIT') return refuse('STATE_NOT_BLOCKED_ON_USAGE_LIMIT');

  const refusals = recordOnlyResumeRefusals(state, now);
  const denied = (code: AutomaticResumeReasonCode): boolean => refusals.includes(code);

  if (denied('CURRENT_TIME_UNPARSEABLE')) return refuse('CURRENT_TIME_UNREADABLE');
  if (denied('RESET_TIME_NOT_REACHED')) return refuse('RESET_AHEAD');
  if (denied('RESUME_POINT_MISSING')) return refuse('RESUME_POINT_MISSING');
  if (refusals.length === 0) return refuse('MACHINE_MAY_STILL_RESUME');

  // Every surviving refusal must be one this build is willing to continue past,
  // not merely one of them. A record that is both withdrawn and otherwise
  // unusable is refused: the operator would be shown a sentence describing only
  // half of what is wrong with it.
  if (!refusals.every((code) => CONTINUABLE_RECORD_REFUSALS.has(code))) {
    return refuse('RECORD_REFUSAL_UNRECOGNISED');
  }

  if (denied('RESET_TIME_MISSING')) return permit('RESET_UNRECORDED');
  if (denied('RESET_TIME_UNPARSEABLE')) return permit('RESET_UNREADABLE');
  return permit('RESUME_RECORD_WITHDRAWN');
}

/**
 * The sentence each reading gets in a report.
 *
 * Total by `satisfies`, which proves every reading was considered and nothing
 * about whether any of them is right. Correctness is measured separately, the
 * way `notify/attention.ts` measures its own: each sentence carries a token that
 * appears in no other, and the suite asserts both directions.
 */
export const USAGE_LIMIT_CONTINUATION_SENTENCES = Object.freeze({
  STATE_NOT_BLOCKED_ON_USAGE_LIMIT:
    'This task is not parked on a quota block, so there is no quota decision to make about it.',
  CURRENT_TIME_UNREADABLE:
    'The clock this was judged against is not a timestamp, so whether the reset has passed ' +
    'could not be decided. Nothing was permitted.',
  RESET_AHEAD:
    'A reset instant is recorded and has not arrived. This is the machine’s wait, not a ' +
    'decision: let the scheduler wake for it, or invoke again after that instant.',
  RESUME_POINT_MISSING:
    'The record names no phase to continue at, so there is nowhere for a continuation to go.',
  RECORD_REFUSAL_UNRECOGNISED:
    'The record cannot be resumed from, and the reason is not one this build lets an ' +
    'operator continue past. Nothing was permitted, deliberately: an escape that covered ' +
    'a fault it has no sentence for would be describing the wrong problem. The run report ' +
    'names the refusing checks.',
  MACHINE_MAY_STILL_RESUME:
    'Nothing about the record refuses a resume; the reset has passed and the recorded ' +
    'commit and clean tree are intact. This task is the automatic path’s, and if it is ' +
    'refusing it is refusing on the repository as it stands right now — a dirty worktree, a ' +
    'moved commit, a login that no longer passes. Fix that, not this.',
  RESET_UNRECORDED:
    'The block records no reset instant, so nothing can ever wait for it. Continuing is an ' +
    'operator decision.',
  RESET_UNREADABLE:
    'The block records a reset instant that is not a timestamp, so nothing can wait for it ' +
    'either. Continuing is an operator decision.',
  RESUME_RECORD_WITHDRAWN:
    'The reset has passed and the resume record cannot be resumed from — the interruption ' +
    'recorded no settled commit, or a worktree already holding uncommitted work, or no pinned ' +
    'base commit — so no passage of time and no repair to the repository can make the ' +
    'automatic resume possible. Continuing from the recorded phase is an operator decision, ' +
    'and the scope gate meets that worktree again before any writer runs in it.',
}) satisfies Record<UsageLimitContinuationReading, string>;
