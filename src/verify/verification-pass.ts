/**
 * The durable verification-pass record: the one positive fact this build could
 * never state, and the five things it still does not say.
 *
 * ── The sentence ───────────────────────────────────────────────────────────
 *
 * > At time T, the worktree at commit C was measured against verification
 * > profile P, and every declared phase exited 0.
 *
 * The mirror image of `verify/verification-attempt.ts`, and it exists for a
 * measured failure rather than for symmetry. On 2026-09-04 the task
 * `RESOLVER-V3-054` burned all three of its review rounds and escalated on a
 * finding — `verification.blocking-checks-not-passed` — that was **false**, and
 * that neither agent could learn was false. Verification had passed twice. The
 * only statement about verification anywhere in the tree was a handoff sentence
 * written by an earlier writer, saying `verify` had exited 1, and by then it was
 * stale prose about a commit that no longer existed. The reviewer read the tree,
 * found the prose, and reported it correctly. The writer could not contradict it
 * — it has no shell — and AO could not contradict it either, because a pass was
 * recorded nowhere: `runVerifyStep` advanced to `REVIEWING` and dropped the
 * report on the floor.
 *
 * Nor can a pass be *inferred* from the workflow. `REVIEWING` is reachable from
 * `HUMAN_DECISION_REQUIRED` and from `BLOCKED_USAGE_LIMIT` as well as from
 * `VERIFYING` (`core/transitions.ts`), and `resumeBlockedTask` clears the resume
 * point, so a resumed review is byte-indistinguishable from one a passing verify
 * step produced. "It is in `REVIEWING`, so it passed" is not derivable, and a
 * build that briefed a reviewer on that reasoning would be asserting something
 * it had not measured.
 *
 * So the rule this record enforces is the one the incident taught:
 *
 * > Verification truth is explicit evidence tied to a commit. Never prose in the
 * > tree, never an inference from a state the task happens to be in.
 *
 * ── The five things it does not say ────────────────────────────────────────
 *
 *  1. **that verification would pass now.** The subject is the commit named in
 *     the record. A writer that changes the tree makes every claim here a claim
 *     about a commit that is no longer HEAD — which is why readers compare
 *     `subjectCommit` against an observed HEAD and degrade when it differs;
 *  2. **that the work is acceptable.** Phases exited 0. Whether the tree
 *     satisfies the task is the reviewer's question and is untouched by this;
 *  3. **that nothing failed afterwards.** A later attempt against the same
 *     commit may have failed; `verification-attempt.ts` holds those, and a
 *     reader that consults this record alone can be told a stale good-news
 *     story. Both stores are read together, and the newer one speaks;
 *  4. **that the tree is clean.** Verification runs against the *working tree*,
 *     not against the commit, so a pass says the tree as it stood measured
 *     clean — not that it held nothing uncommitted. A reader that needs that
 *     asks Git, and this build does, separately;
 *  5. **that its absence means anything.** No record is written for a build that
 *     predates this one, for a task that never verified, or for a write that
 *     failed. `ABSENT` is "nobody wrote one", never "it did not pass".
 *
 * It **never mints authority and never decides a transition.** The verify step
 * decides; this is what a later step consults.
 *
 * ── Why a second file, and why latest-wins ─────────────────────────────────
 *
 * Not an entry in the attempt history, and not a field on `TaskState`.
 *
 * The attempt history is a bounded, append-only record of *failures* whose whole
 * job is to answer "why did AO stop". It keeps at most six entries and
 * **refuses** the seventh rather than evicting, and `runVerifyStep` reads that
 * refusal as a reason not to write `BLOCKED_VERIFY` at all. Spending that bound
 * on passes would let a task that passed six times become a task whose next
 * genuine failure cannot be recorded — turning a block into a weaker state
 * because of good news. A pass also carries no diagnosis whose loss would
 * matter, so latest-wins is right here and would be wrong there: the question
 * this record answers is "what is the newest commit AO measured as passing",
 * whose answer is by definition the newest.
 *
 * `TaskState` is `.strict()` and revisioned, and two module headers cite that
 * strictness as the reason process results are not persisted on it. A second
 * fact goes in a second file, which is this repository's standing rule.
 *
 * ── What is not in it, deliberately ────────────────────────────────────────
 *
 * No excerpt, no stdout, no stderr, no command tokens, no paths. On a pass
 * `runVerification` returns `NO_DIAGNOSTICS`, so there is no foreign text to
 * carry — and the reason the attempt record carries one (a writer with no shell
 * cannot re-run a gate it cannot see) is a fact about a *failure*. Every value
 * stored here is minted by AO from a closed enum, an integer, an ISO instant or
 * a hex digest, which is what lets `loop/findings.ts` print it to an agent
 * without a fence: there is nothing foreign in it to fence.
 *
 * The phase name is `z.enum(VERIFICATION_PHASES)` rather than a bounded string,
 * and that is load-bearing rather than tidy. This value is read back **off
 * disk** and printed into an agent's instruction stream; a 32-character free
 * string can hold a newline or a bidirectional override, and this schema stands
 * in front of a file somebody may have written by hand.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { VERIFICATION_PHASES } from '../repo/repo-profile.js';
import type { VerificationReport } from './run-verification.js';

/**
 * The version of this record's contract, as this build writes and requires it.
 *
 * Deliberately not a range and deliberately not migratable, for the reason the
 * sibling stores give: a build that reads a record it does not understand and
 * does its best is a build acting on a document written by rules it does not
 * have.
 */
export const VERIFICATION_PASS_VERSION = 1;

/**
 * The largest record this build will read or write, in **bytes** on disk.
 *
 * A byte budget checked against the encoded document, not a schema `.max()`,
 * for the reason `deliver/post-merge-verification.ts` measured: a schema bounds
 * UTF-16 code units and a code unit is not a byte. The arithmetic: eight phases
 * of roughly eighty bytes, a 4 096-character repository root, a 128-character
 * task id, two digests and an instant — under 6 KiB in every spelling. 16 KiB
 * leaves room for a longer root without inviting anything to grow into it.
 */
export const MAX_VERIFICATION_PASS_RECORD_BYTES = 16_384;

const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * What one passing phase did.
 *
 * `exitCode` is `z.literal(0)` because a phase that exited anything else is not
 * part of a pass, and a record that could carry a non-zero exit code beside the
 * word `PASSED` is a record that can contradict itself. `outputTruncated` is
 * kept because it is a real property of a passing run and not decoration: a
 * gate that writes 62 MiB and passes is the M6 case this build already
 * measured, and an operator reading "PASSED, output truncated" knows why the
 * evidence is thin.
 */
export const PassedPhaseSchema = z
  .object({
    phase: z.enum(VERIFICATION_PHASES),
    exitCode: z.literal(0),
    outputTruncated: z.boolean(),
    durationMs: z.int().min(0),
  })
  .strict();

export type PassedPhase = z.infer<typeof PassedPhaseSchema>;

/**
 * One pass: one run of one profile against one commit, at one instant.
 *
 * There is no `verdict` field. The document's existence is the verdict, and a
 * stored verdict would be a field that could disagree with the schema around it
 * — the same argument that keeps a `trusted` flag off the attempt record.
 */
export const VerificationPassRecordSchema = z
  .object({
    passVersion: z.int().positive(),
    taskId: z.string().min(1).max(128),
    /** The repository the task's record lives in. Absolute, compared on read. */
    repositoryRoot: z.string().min(1).max(4096),
    /** When the verify step that produced this pass began. From the loop's clock. */
    measuredAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    /**
     * The commit the worktree was at, read from Git immediately before the
     * record was built.
     *
     * The record's subject, and the field that stops it being a floating
     * verdict. A reader that does not compare this against an observed HEAD is
     * asserting a pass over a tree it has not looked at.
     */
    subjectCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),
    /** Which contract ran — see `verify/verification-profile.ts`. */
    profileDigest: z.string().regex(HEX_64, 'Must be a profile digest.'),
    /** One entry per declared phase, in the order they ran. All of them passed. */
    phases: z.array(PassedPhaseSchema).min(1).max(8),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict();

export type VerificationPassRecord = z.infer<typeof VerificationPassRecordSchema>;

/** The payload without the digest computed over it. */
export type VerificationPassPayload = Omit<VerificationPassRecord, 'binding'>;

/** Who a record is expected to be about — the task's own identity. */
export interface VerificationPassSubject {
  readonly taskId: string;
  readonly repositoryRoot: string;
}

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/verification-pass/v1';

/**
 * The binding digest for one payload against one task.
 *
 * The inputs are listed one by one rather than serialised from the object, for
 * the reason the sibling record states: `JSON.stringify(payload)` would make the
 * digest depend on key order, and would silently start covering — or stop
 * covering — a field added without anybody deciding it should.
 */
export function verificationPassBinding(
  subject: VerificationPassSubject,
  payload: VerificationPassPayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.taskId,
        subject.repositoryRoot,
        payload.passVersion,
        payload.taskId,
        payload.repositoryRoot,
        payload.measuredAt,
        payload.subjectCommit,
        payload.profileDigest,
        payload.phases.map((phase) => [
          phase.phase,
          phase.exitCode,
          phase.outputTruncated,
          phase.durationMs,
        ]),
      ]),
    )
    .digest('hex');
}

/** What a read of the store produced. A closed set; four of the five refuse. */
export const VERIFICATION_PASS_READINGS = [
  /** A pass record this build accepts, about this task. */
  'PASS_RECORD',
  /** Nobody wrote one. The **only** reading that means that. */
  'ABSENT',
  /** Something is there and this build cannot say what it claims. */
  'MALFORMED',
  /** A record written to a contract version this build does not have. */
  'UNSUPPORTED_VERSION',
  /** An intact record about another task, another repository, or re-pointed. */
  'NOT_THIS_TASK',
] as const;

export type VerificationPassReading = (typeof VERIFICATION_PASS_READINGS)[number];

export interface VerificationPassReadResult {
  readonly reading: VerificationPassReading;
  /** The record, on `PASS_RECORD` only. Nothing is handed back otherwise. */
  readonly record: VerificationPassRecord | null;
}

function reading(
  value: VerificationPassReading,
  record: VerificationPassRecord | null = null,
): VerificationPassReadResult {
  return Object.freeze({ reading: value, record });
}

/**
 * Grades one parsed document against one subject. Never throws.
 *
 * The version is checked **before** the schema, so a record written by a newer
 * build is `UNSUPPORTED_VERSION` rather than `MALFORMED`: those send an operator
 * to different places and only one of them means somebody's file is broken.
 *
 * The identity is then checked **twice**, and the second check is not
 * redundant — the sibling record documents the defect it exists for: a record
 * whose payload names another task, with a binding computed for *that* payload
 * against *this* subject, matches the digest and arrives here.
 */
export function readVerificationPass(
  raw: unknown,
  subject: VerificationPassSubject,
): VerificationPassReadResult {
  if (typeof raw !== 'object' || raw === null) return reading('MALFORMED');
  const declared = (raw as { passVersion?: unknown }).passVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared <= 0) {
    return reading('MALFORMED');
  }
  if (declared !== VERIFICATION_PASS_VERSION) return reading('UNSUPPORTED_VERSION');

  const parsed = VerificationPassRecordSchema.safeParse(raw);
  if (!parsed.success) return reading('MALFORMED');
  const record = parsed.data;

  // Belt and braces: the version is re-read from the validated document, so a
  // schema that ever stopped pinning it cannot let a foreign version through.
  if (record.passVersion !== VERIFICATION_PASS_VERSION) return reading('UNSUPPORTED_VERSION');

  const { binding, ...payload } = record;
  if (verificationPassBinding(subject, payload) !== binding) return reading('NOT_THIS_TASK');
  if (record.taskId !== subject.taskId) return reading('NOT_THIS_TASK');
  if (record.repositoryRoot !== subject.repositoryRoot) return reading('NOT_THIS_TASK');

  return reading('PASS_RECORD', record);
}

/** What the caller must supply that the report itself does not carry. */
export interface VerificationPassIdentity {
  /** The instant the verify step began. From the loop's injected clock. */
  readonly measuredAt: string;
  /** The worktree HEAD, read from Git for this run. */
  readonly subjectCommit: string;
  /** `verificationProfileDigest` of the policy that ran. */
  readonly profileDigest: string;
  readonly taskId: string;
  readonly repositoryRoot: string;
}

/**
 * One pass record, built from a report that passed.
 *
 * `null` for every report that is not a pass, and `null` for a `PASSED` report
 * this build would not accept as one — no phases at all, a phase that did not
 * run, or a phase whose exit code is not 0. The exact mirror of
 * `verificationAttemptFrom`, which returns `null` **for** a pass.
 *
 * The three refusals are not defensive decoration. `runVerification` produces
 * `PASSED` only after every declared phase ran and exited 0, so a report that
 * says otherwise is a report this build cannot produce — and minting a record
 * from it would put a document on disk asserting a pass that its own contents
 * contradict. Refusing to build is how the caller tells "there is nothing to
 * record" from "the recording failed".
 *
 * Nothing here interprets. Every field is copied from the report.
 */
export function verificationPassFrom(
  report: VerificationReport,
  identity: VerificationPassIdentity,
): VerificationPassRecord | null {
  if (report.verdict !== 'PASSED') return null;
  if (report.phases.length === 0) return null;
  if (report.phases.some((phase) => phase.outcome !== 'RAN' || phase.exitCode !== 0)) return null;

  const payload: VerificationPassPayload = {
    passVersion: VERIFICATION_PASS_VERSION,
    taskId: identity.taskId,
    repositoryRoot: identity.repositoryRoot,
    measuredAt: identity.measuredAt,
    subjectCommit: identity.subjectCommit,
    profileDigest: identity.profileDigest,
    phases: report.phases.map((phase) =>
      Object.freeze({
        phase: phase.phase,
        exitCode: 0 as const,
        outputTruncated: phase.outputTruncated,
        durationMs: phase.durationMs,
      }),
    ),
  };

  return Object.freeze({
    ...payload,
    binding: verificationPassBinding(
      { taskId: identity.taskId, repositoryRoot: identity.repositoryRoot },
      payload,
    ),
  });
}
