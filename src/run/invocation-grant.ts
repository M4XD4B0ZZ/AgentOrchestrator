/**
 * What *this invocation* is permitted to continue (V3-08).
 *
 * ── Two authorities, and this is the second one ────────────────────────────
 *
 * `state/resume-decision.ts` answers "does the current state, compared against
 * the current world, permit a continuation, and of what kind?" — the closed
 * {@link ContinuationAuthority} vocabulary, whose `AUTOMATIC_ALLOWED` has
 * exactly one source: an `AutomaticResumeDecision` with `allowed === true`.
 * That authority is about the *task*.
 *
 * This module is about the *invocation*: whoever started this process, and what
 * they asked for. The two are conjoined, never substituted, and **no value here
 * can manufacture `AUTOMATIC_ALLOWED`** — that is the invariant, and it holds
 * without exception.
 *
 * "Can only ever narrow" is the *nearly* true statement people reach for, and it
 * is what this paragraph used to say. A review pointed out the one place it is
 * false: `continuingOwnAutomaticResume` lets an `AUTOMATIC_RESUME_ONLY`
 * invocation continue a task the task authority currently classifies
 * `ATTENDED_ONLY`. It is not a hole — the invocation reached that state only by
 * performing a resume this same authority allowed a moment earlier, inside one
 * `runTask` frame — but it is a widening, and it is documented as one on the
 * parameter below rather than denied here.
 *
 * ── Why a closed vocabulary and not a second boolean ───────────────────────
 *
 * Until V3-08 the invocation layer was one boolean, `attendedContinuation`, and
 * the run driver refused every continuation when it was false. Adding an
 * unattended mode as a *second* boolean beside it would have created four
 * combinations for three meanings, and the meaning of the fourth — attended and
 * unattended at once — would then have had to be invented somewhere. A closed
 * three-member type has no such combination to invent, and the compiler refuses
 * a caller who forgets to choose.
 *
 * ── The three members ──────────────────────────────────────────────────────
 *
 *  - `NO_CONTINUATION` — nothing productive may continue. What `false` meant.
 *  - `ATTENDED` — a human is present for this invocation of the command. What
 *    `true` meant, unchanged in every observable way, including the reason code
 *    a refusal carries.
 *  - `AUTOMATIC_RESUME_ONLY` — no human presence is claimed. It permits exactly
 *    one thing: continuing a task whose canonical resume decision *freshly*
 *    answered `AUTOMATIC_ALLOWED`.
 *
 *    **What follows that resume is the ordinary governed loop, in full.** The
 *    resume enters a work-loop phase, and the same `runTask` call then drives
 *    that phase and every phase after it — writer, verification, review,
 *    remediation — up to its step budget, exactly as an attended run would. A
 *    review found this file, `run-driver.ts` and the README all describing it as
 *    "the phase that resume entered", which is what the *first* iteration after
 *    the write does and not what the loop does; the wording is corrected here
 *    rather than the behaviour, because a resume that could only take one step
 *    would leave the task mid-phase and no better off.
 *
 *    What it is not is "run unattended": an ordinary in-flight task that **this
 *    call did not itself resume** classifies `ATTENDED_ONLY` and is refused
 *    here, so the authority is entered only through a resume the canonical
 *    decision allowed. A task with no durable state is refused a layer up, in
 *    `lifecycle-driver.ts`, because starting a task is a different authority
 *    again (see {@link mayStartTask}), and removing a lease is a third (see
 *    {@link mayRecoverStaleLease}).
 *
 * The refusal codes are stable and distinct, because "you did not ask to
 * continue" and "you asked to continue automatically and the resume decision
 * did not allow it" send an operator to different places.
 */

import type { ContinuationAuthority } from '../state/resume-decision.js';

export const INVOCATION_GRANTS = [
  'NO_CONTINUATION',
  'ATTENDED',
  'AUTOMATIC_RESUME_ONLY',
] as const;

export type InvocationGrant = (typeof INVOCATION_GRANTS)[number];

export const GRANT_REFUSAL_CODES = [
  /**
   * Kept at its pre-V3-08 spelling deliberately. `NO_CONTINUATION` is exactly
   * what `attendedContinuation: false` meant, and an operator who scripts
   * against this code should not have to learn a new one because the type
   * beside it grew a member.
   */
  'ATTENDED_CONTINUATION_NOT_GRANTED',
  /**
   * The invocation asked to continue without a human, and the canonical resume
   * decision did not answer `AUTOMATIC_ALLOWED`. Every refused automatic resume
   * and every ordinary in-flight task lands here.
   */
  'AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED',
] as const;

export type GrantRefusalCode = (typeof GRANT_REFUSAL_CODES)[number];

/**
 * Whether the grant lets this continuation proceed.
 *
 * A discriminated union rather than `{ permitted: boolean; refusal: Code | null }`
 * so that a permitted verdict has no refusal field to read and a refused one has
 * a code the compiler guarantees is present.
 */
export type GrantVerdict =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly refusal: GrantRefusalCode };

const PERMITTED: GrantVerdict = Object.freeze({ permitted: true as const });

const REFUSED: Readonly<Record<GrantRefusalCode, GrantVerdict>> = Object.freeze({
  ATTENDED_CONTINUATION_NOT_GRANTED: Object.freeze({
    permitted: false as const,
    refusal: 'ATTENDED_CONTINUATION_NOT_GRANTED' as const,
  }),
  AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED: Object.freeze({
    permitted: false as const,
    refusal: 'AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED' as const,
  }),
});

/**
 * The conjunction: task authority **and** invocation authority.
 *
 * Pure, total over both vocabularies, and deliberately shaped so that the
 * `AUTOMATIC_RESUME_ONLY` arm reads the canonical `continuation` value and
 * nothing else. It does not look at the task's state name, at a reconciliation
 * verdict, or at whether the state happens to be `BLOCKED_USAGE_LIMIT` — those
 * are all things that can be true while an automatic resume is refused, and a
 * grant that consulted them would be a second, weaker copy of the decision this
 * function exists to depend on.
 */
export function permitsContinuation(
  grant: InvocationGrant,
  continuation: ContinuationAuthority,
  /**
   * Whether **this same run** has already performed the automatic resume it is
   * now continuing.
   *
   * The one thing that is not derivable from the two vocabularies, and it has
   * to be here rather than inferred. An automatic resume is a durable write
   * that moves the task out of `BLOCKED_USAGE_LIMIT` and into the work-loop
   * phase the resume point named. From the *next* iteration onwards
   * `classifyResume` therefore answers `ATTENDED_ONLY` — correctly, because
   * that is now ordinary in-flight work — and a gate that only looked at the
   * two vocabularies would refuse the run its own resume just authorised. What
   * that produces is the exact failure `V1-07-RR-B1` exists to prevent: the
   * pause is spent, `resumeFrom` and `reportedResetAt` are gone, no work
   * happens, and no later unattended run can ever pick the task up.
   *
   * So the resume carries the continuation with it, and only within the call
   * that made it. It is a local fact — a variable in one `runTask` frame,
   * cleared by the frame ending — never a durable claim and never something a
   * caller can assert: a *fresh* invocation meeting the same in-flight task
   * passes `false` and is refused, which is what keeps "may resume a quota
   * pause" from becoming "may run unattended".
   *
   * It is **not** scoped to the one phase the resume entered. Once set it holds
   * for the rest of that call, so the loop runs the whole work cycle. That is
   * deliberate — see the vocabulary note above — and it is why the operator
   * report may not say this mode "cannot continue in-flight work" without the
   * qualifier "it did not itself resume".
   */
  continuingOwnAutomaticResume: boolean,
): GrantVerdict {
  switch (grant) {
    case 'NO_CONTINUATION':
      return REFUSED.ATTENDED_CONTINUATION_NOT_GRANTED;
    case 'ATTENDED':
      // Unchanged: the attended grant clears the invocation, and every other
      // gate in `runTask` still applies. It has never been able to move a
      // blocked task on its own — that needs `AUTOMATIC_ALLOWED`, which the
      // driver checks before this one and stops on.
      return PERMITTED;
    case 'AUTOMATIC_RESUME_ONLY':
      return continuation === 'AUTOMATIC_ALLOWED' || continuingOwnAutomaticResume
        ? PERMITTED
        : REFUSED.AUTOMATIC_RESUME_ONLY_WITHOUT_AUTOMATIC_ALLOWED;
  }
}

/**
 * Whether this invocation may bring a task into existence.
 *
 * Starting a task creates a worktree, a branch and the first durable state, and
 * none of that is a *continuation* of anything. `AUTOMATIC_RESUME_ONLY` says
 * "carry on with one task that already exists", so it answers `false` here, and
 * `lifecycle-driver.ts` refuses before `startTask` is reached rather than
 * relying on the CLI to keep the two apart.
 */
export function mayStartTask(grant: InvocationGrant): boolean {
  return grant !== 'AUTOMATIC_RESUME_ONLY';
}

/**
 * Whether this invocation may remove an execution lease it did not create.
 *
 * A third authority, kept apart from the other two because it is destructive
 * rather than merely productive: `recoverStaleLease` deletes another run's
 * object, and it is permitted only by an operator who asked for it *now*.
 * `AUTOMATIC_RESUME_ONLY` says nobody is present, so it answers `false`.
 *
 * The refusal lives at the same boundary as {@link mayStartTask}'s, and for the
 * same reason. `unattended-resume.ts` already fixes `recoverStaleLease: false`
 * and the CLI already refuses the flag combination twice over — but a review
 * pointed out the asymmetry those two leave: `driveLifecycle` could still be
 * called directly with this grant *and* a recovery permission, so the property
 * was argued from its callers rather than held by the layer that acts on it.
 * Nothing observable changes; a hole that needed a new caller to open is
 * closed before one exists.
 */
export function mayRecoverStaleLease(grant: InvocationGrant): boolean {
  return grant !== 'AUTOMATIC_RESUME_ONLY';
}
