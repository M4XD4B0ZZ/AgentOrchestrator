/**
 * The durable post-merge verification record: what it says, and the four things
 * it does not.
 *
 * ── The sentence ───────────────────────────────────────────────────────────
 *
 * > At time T, commit M completed verification profile P, with result R.
 *
 * One event, about one immutable object, under one named contract. The subject
 * is a **commit**, chosen by the task's merge receipt and by nothing else. It is
 * emphatically *not* "the base branch", "main", or "the delivery".
 *
 * ── The four things it does not say ────────────────────────────────────────
 *
 * A reader will want each of these to follow from a `VERIFIED_PASS`, and none
 * of them does:
 *
 *  1. **that M is currently on the base branch.** The base moves. Pull request
 *     #61 in this repository is merged forever, its base branch answers `404`,
 *     and its merge commit is an ancestor of nothing. A record written the
 *     instant after a merge and read a month later says the same thing, because
 *     it is about the commit and not about the branch;
 *  2. **that M is currently reachable from the base.** A revert, a force push
 *     or a reset changes reachability and changes nothing here;
 *  3. **that the base branch passes now.** A later commit is a different
 *     subject and needs its own run;
 *  4. **that the task is complete.** Nothing here touches `TaskState`, the
 *     transition table or the block ledger. `READY_FOR_PR` stays terminal and
 *     `currentCommit` stays the implementation head H, which is a *different
 *     commit from M* and deliberately so.
 *
 * ── Why it is a history and not one fact ───────────────────────────────────
 *
 * The merge receipt this record depends on is a **monotonic** fact: "pull
 * request #N was merged from H producing M" was true the instant the forge said
 * so and stays true, so `merge-reconciliation-store.ts` can refuse every
 * contradictory rewrite and be right to. A verification verdict is not like
 * that. It is a **measurement of a run**, and this repository has measured the
 * same gate at the same commit producing different answers under different
 * load — which is exactly why `verify/run-verification.ts` separates
 * `UNAVAILABLE` from `FAILED` in the first place.
 *
 * So the three obvious shapes are all wrong here, each for its own reason:
 *
 *  - **one immutable record** (slice 8's shape) would let the first
 *    infrastructure failure poison the task permanently: every honest re-run
 *    afterwards would be refused as conflicting, and the operator would have a
 *    durable `VERIFICATION_NOT_ESTABLISHED` they could only clear by deleting
 *    the file by hand;
 *  - **latest wins** (slice 3's shape, and it says so) would let a later pass
 *    silently replace an earlier fail at the same commit under the same
 *    profile. That is the contradictory overwrite this slice must not do;
 *  - **attempt files plus a pointer** would need two files to move together,
 *    and `state/atomic-file.ts` replaces one file atomically and makes no
 *    claim about two. A design that needs a transaction AO does not have is a
 *    design that will be wrong on the first interruption.
 *
 * What is left is a **bounded append-only history in one file**: every attempt
 * is kept, in order, and the file is replaced atomically as a whole. Nothing is
 * ever overwritten and nothing is ever silently dropped — when the history is
 * full the next attempt is *refused*, with its own code, rather than pushing
 * the oldest evidence out of the back.
 */

import { z } from 'zod';

import { createHash } from 'node:crypto';

import { POST_MERGE_VERIFICATION_OUTCOMES } from './internal/post-merge-verification-proof.js';

/**
 * The version of this record's contract, as this build writes and requires it.
 *
 * Deliberately not a range and deliberately not migratable, for the reason
 * `merge-reconciliation.ts` gives: a build that reads a record it does not
 * understand and does its best is a build that acts on a document written by
 * rules it does not have.
 */
export const POST_MERGE_VERIFICATION_VERSION = 1;

/**
 * The largest verification record this build will read or write.
 *
 * A **byte** budget, checked against the file's size on disk, and it is
 * **load-bearing rather than redundant with the schema** — the same property
 * `merge-reconciliation.ts` documents and pins for its own 8 KiB gate.
 *
 * The numbers, measured rather than reasoned about, because two reviewers
 * computed different ones and the difference is the whole point:
 *
 * | worst-case `repositoryRoot` (4096 chars) | record size |
 * | --- | --- |
 * | ASCII | 11,083 bytes — inside |
 * | CJK (U+4E00) | 19,275 bytes — **over** |
 * | U+0001 (escapes to ``) | 31,563 bytes — **over** |
 *
 * A schema `.max()` bounds UTF-16 code units, and a code unit is not a byte. So
 * a schema-legal record CAN exceed this budget, and is then refused —
 * `RECORD_TOO_LARGE` on write, `MALFORMED` on read. That is what the gate is
 * for; a byte budget a schema already implied would be decoration.
 *
 * The product path reaches it a slice earlier in any case. A CJK root crosses
 * this budget at 3,133 characters and crosses slice 8's receipt budget at
 * **2,243** — so `verify-merge.ts` refuses with `RECEIPT_UNREADABLE` before a
 * verification record is ever built for such a repository.
 *
 * An earlier version of this comment said the ASCII figure was the worst case
 * and that a review claiming 19,271 had been refuted. Half of that was right
 * and the half that was not is why the table is here.
 */
export const MAX_POST_MERGE_VERIFICATION_BYTES = 16_384;

/**
 * How many attempts one record keeps.
 *
 * A bound, not a window. When it is reached the next attempt is refused rather
 * than making room, because making room means deleting evidence — and the
 * evidence most likely to disagree with the newest attempt is the oldest one.
 */
export const MAX_VERIFICATION_ATTEMPTS = 16;

const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The exit-code range this record accepts.
 *
 * Wide on purpose, and both ends are load-bearing. A POSIX exit status is
 * 0..255, but this build has **measured** a Windows exception code arriving as
 * an unsigned 32-bit value through Node (`0xC0000005` = 3221225477) while the
 * launch boundary writes the same number as a signed `int32`. A bound that
 * admitted only one spelling would discard the whole record — not the field —
 * for a run that really did produce that code.
 */
const MIN_EXIT_CODE = -2_147_483_648;
const MAX_EXIT_CODE = 4_294_967_295;

/**
 * One attempt: a run of one profile against this record's commit, at one
 * instant.
 *
 * Bounded, closed, and carrying **no repository output**. There is no stdout
 * field, no stderr field, no diagnostics excerpt and no command line — a
 * repository's own test runner may print anything at all, including a secret it
 * read, and the way to keep that out of a durable file is to give it nowhere to
 * go.
 */
export const VerificationAttemptSchema = z
  .object({
    /** When this process started the attempt. */
    attemptedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    /**
     * Which contract ran — see `verify/verification-profile.ts`.
     *
     * Per attempt rather than per record, because the profile is an ordinary
     * file that can change between two runs of the same command against the
     * same commit. A digest at the top of the record would silently relabel
     * every historical attempt whenever the newest one was made under a
     * different contract.
     */
    profileDigest: z.string().regex(HEX_64, 'Must be a profile digest.'),
    outcome: z.enum(POST_MERGE_VERIFICATION_OUTCOMES),
    /** The phase that failed or could not be run, or `null` on a pass. */
    stoppedAt: z.string().min(1).max(32).nullable(),
    /** The stopping phase's exit code, or `null` when no process completed. */
    exitCode: z.int().min(MIN_EXIT_CODE).max(MAX_EXIT_CODE).nullable(),
    /** The signal that killed the stopping phase, when one did. */
    signal: z.string().min(1).max(32).nullable(),
    /**
     * How many phase reports the run produced. At most the profile's 8.
     *
     * Not "how many processes started" — a refused argv produces a report
     * without a spawn. See the mint, which is where the value comes from.
     */
    phasesRun: z.int().min(0).max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The cross-field invariant, and the whole of it. A pass that names a phase
    // it stopped at is not a pass, and a non-pass that names none cannot say
    // where it stopped. Both shapes are unreachable through the mint and are
    // refused here rather than trusted, because this schema is what stands in
    // front of a file somebody may have written by hand.
    const passed = value.outcome === 'VERIFIED_PASS';
    if (passed !== (value.stoppedAt === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['stoppedAt'],
        message: 'A pass stops nowhere, and anything else stops somewhere.',
      });
    }
  });

export type VerificationAttempt = z.infer<typeof VerificationAttemptSchema>;

export const PostMergeVerificationSchema = z
  .object({
    verificationVersion: z.int().positive(),

    // ── the task, and the delivery this is a verification of ──────────────
    taskId: z.string().min(1).max(128),
    /** The repository the task's record lives in. Absolute, compared on read. */
    repositoryRoot: z.string().min(1).max(4096),
    /**
     * The implementation head **H** — the merge receipt's `subjectCommit`.
     *
     * Carried so a reader can join this record to the receipt that chose its
     * subject, and so that a record cannot be silently re-pointed at a merge of
     * some other task's commit. It is **not** the thing that was verified. That
     * is {@link mergeCommit}, and the two are different objects.
     */
    subjectCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),
    /**
     * The merge commit **M** — *the subject*, and the only commit any attempt
     * in this record ran against.
     *
     * The proof artefact upstream cannot be minted unless the workspace HEAD
     * that was proved equals this value, so there is no route by which an
     * attempt here describes a run against anything else.
     */
    mergeCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),

    // ── the delivery target ───────────────────────────────────────────────
    provider: z.literal('github'),
    host: z.string().min(1).max(253),
    owner: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    /** The pull request whose merge produced {@link mergeCommit}. */
    pullRequestNumber: z.int().positive(),

    // ── the history ───────────────────────────────────────────────────────
    /**
     * Every attempt, oldest first. Append-only: an existing entry is never
     * edited and never removed.
     */
    attempts: z.array(VerificationAttemptSchema).min(1).max(MAX_VERIFICATION_ATTEMPTS),

    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict();

export type PostMergeVerification = z.infer<typeof PostMergeVerificationSchema>;

/** The payload without the digest computed over it. */
export type PostMergeVerificationPayload = Omit<PostMergeVerification, 'binding'>;

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/post-merge-verification/v1';

/**
 * Who a record is expected to be about — the task's own identity.
 *
 * Deliberately not `TaskState`, and deliberately without a state revision: a
 * revision here would tie a record about a commit to mutable task-state bytes,
 * and the whole point of this slice is that the two are separate. Same shape
 * and same reasoning as `MergeReconciliationSubject`.
 */
export interface PostMergeVerificationSubject {
  readonly taskId: string;
  readonly repositoryRoot: string;
}

/**
 * The binding digest for one payload against one task.
 *
 * The inputs are listed one by one rather than serialised from the object, for
 * the reason `mergeReconciliationBinding` states: `JSON.stringify(payload)`
 * would make the digest depend on key order, and would silently start covering
 * — or stop covering — a field added to the payload without anybody deciding it
 * should. Every field is here, **including every field of every attempt**, so
 * that editing a stored verdict is detected rather than inherited.
 */
export function postMergeVerificationBinding(
  subject: PostMergeVerificationSubject,
  payload: PostMergeVerificationPayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.taskId,
        subject.repositoryRoot,
        payload.verificationVersion,
        payload.taskId,
        payload.repositoryRoot,
        payload.subjectCommit,
        payload.mergeCommit,
        payload.provider,
        payload.host,
        payload.owner,
        payload.name,
        payload.pullRequestNumber,
        payload.attempts.map((attempt) => [
          attempt.attemptedAt,
          attempt.profileDigest,
          attempt.outcome,
          attempt.stoppedAt,
          attempt.exitCode,
          attempt.signal,
          attempt.phasesRun,
        ]),
      ]),
    )
    .digest('hex');
}

/**
 * What a stored record turned out to be. A closed set of five, of which **one**
 * means "a verification history this build wrote for this task".
 *
 * There is no member for "the task moved on since", for the reason
 * `merge-reconciliation.ts` gives about its own readings: a run that happened
 * does not stop having happened because the task did something afterwards.
 */
export const POST_MERGE_VERIFICATION_READINGS = [
  /**
   * A history this build wrote for this task, in this repository: **commit M
   * was run against profile P at time T, with result R** — once per attempt.
   * True when written and true now. See the header for what it still does not
   * claim.
   */
  'VERIFICATION_HISTORY',
  /** Nobody has written one. Not an assertion that nothing was verified. */
  'ABSENT',
  /** Bytes are there and this build cannot read them as a record. */
  'MALFORMED',
  /** A well-formed record this build's contract version does not cover. */
  'UNSUPPORTED_VERSION',
  /**
   * A record about another task or another repository — **or one that has been
   * edited since it was written.**
   *
   * The last clause is not decoration. The binding digest covers every field of
   * every attempt, so a stored verdict changed in place fails the same
   * comparison a foreign record does, and lands here. Slice 8's sibling member
   * says so; a review found this one had dropped the clause.
   */
  'NOT_THIS_TASK',
] as const;

export type PostMergeVerificationReading = (typeof POST_MERGE_VERIFICATION_READINGS)[number];

/**
 * The sentence every report carries beside a recorded verification.
 *
 * Exported rather than written at the call site so there is one wording, and so
 * a test can pin it. It is the distinction this whole slice turns on, and the
 * one an operator is most likely to over-read: a pass is an **event about a
 * commit**, not a standing about a branch.
 */
export const VERIFICATION_EVENT_SENTENCE =
  'A verification record states one event: at that instant, this exact commit completed\n' +
  'this exact profile with this result. It is not a claim that the commit is on the base\n' +
  'branch now, that it is still reachable from it, that the merge has not been reverted,\n' +
  'or that the base branch passes today. Nothing here has asked any of those questions.';

/**
 * Whether a reading is one this build may read facts out of.
 *
 * One member, and stated as a function so a caller cannot accidentally treat
 * `ABSENT` — the most tempting one — as "nothing to worry about".
 */
export function isVerificationHistory(reading: PostMergeVerificationReading): boolean {
  return reading === 'VERIFICATION_HISTORY';
}

/**
 * Reads one stored record, given the bytes and who it should be about.
 *
 * Never throws. Every way a document can be wrong reaches a reading.
 */
export function readPostMergeVerification(
  raw: unknown,
  subject: PostMergeVerificationSubject,
): { readonly reading: PostMergeVerificationReading; readonly record: PostMergeVerification | null } {
  // The version is read before the shape, so a record written by a build with a
  // different contract is refused as such rather than as malformed. A future
  // record may legally carry fields this schema forbids.
  const declared =
    typeof raw === 'object' && raw !== null && 'verificationVersion' in raw
      ? (raw as { verificationVersion: unknown }).verificationVersion
      : undefined;
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) {
    if (declared !== POST_MERGE_VERIFICATION_VERSION) {
      return Object.freeze({ reading: 'UNSUPPORTED_VERSION' as const, record: null });
    }
  }

  const parsed = PostMergeVerificationSchema.safeParse(raw);
  if (!parsed.success) return Object.freeze({ reading: 'MALFORMED' as const, record: null });
  const record = parsed.data;

  // Belt and braces against the version check above: a record that reached here
  // with a version this build does not require would be read under rules it was
  // not written by.
  if (record.verificationVersion !== POST_MERGE_VERIFICATION_VERSION) {
    return Object.freeze({ reading: 'UNSUPPORTED_VERSION' as const, record: null });
  }

  const { binding, ...payload } = record;
  if (postMergeVerificationBinding(subject, payload) !== binding) {
    return Object.freeze({ reading: 'NOT_THIS_TASK' as const, record: null });
  }

  // Belt and braces against the binding above — and, unlike the sibling pair
  // in `merge-reconciliation.ts`, these two are **reachable**, which is stated
  // here because an earlier version of this comment copied that file's
  // "unreachable today" and a review measured it false.
  //
  // The digest takes the subject's ids alongside the payload's, so a record
  // bound for a *different* subject fails one line up. But a record whose
  // payload names another task, with a binding computed for THAT payload
  // against THIS subject, matches the digest and arrives here — and these two
  // lines are what refuse it. The test file constructs exactly that document.
  if (record.taskId !== subject.taskId) {
    return Object.freeze({ reading: 'NOT_THIS_TASK' as const, record: null });
  }
  if (record.repositoryRoot !== subject.repositoryRoot) {
    return Object.freeze({ reading: 'NOT_THIS_TASK' as const, record: null });
  }

  return Object.freeze({ reading: 'VERIFICATION_HISTORY' as const, record });
}
