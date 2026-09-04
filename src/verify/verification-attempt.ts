/**
 * The durable verification-attempt record: what it says, and the six things it
 * does not.
 *
 * ── The sentence ───────────────────────────────────────────────────────────
 *
 * > At time T, the worktree at commit C was measured against verification
 * > profile P, and the run ended thus.
 *
 * One event, about one commit, under one named contract. It exists because the
 * V4 release gate produced five `BLOCKED_VERIFY` states across four tasks and
 * left **nothing on disk that told them apart**. The report that would have
 * explained each was computed, returned to the caller, rendered by nobody, and
 * dropped when the process exited. An operator invoking `run` the next morning
 * was told `Reasons : none`.
 *
 * That was measured, not supposed. Two of those five failures were a genuine
 * `tsc --noEmit` error the writer had introduced, reproducible today in a clean
 * read-only check; the others ran the whole gate for twelve and twenty-two
 * minutes before a test failed. The first pair needed a one-line fix, the second
 * an argument about load. Nothing AO persisted distinguished them, and the
 * durations that eventually did came from the *state file's mtime* — an accident
 * of the filesystem, not a record.
 *
 * ── The six things it does not say ─────────────────────────────────────────
 *
 * A reader will want each of these to follow from a stored `FAILED`, and none of
 * them does:
 *
 *  1. **that verification would fail now.** The subject is the commit named in
 *     the attempt. A remediating writer changes the tree, and every claim here
 *     is then about a commit that is no longer HEAD;
 *  2. **that the repository is at fault.** `UNAVAILABLE` is in this record's
 *     vocabulary precisely because "the build is broken" and "we could not run
 *     the build" are different sentences;
 *  3. **that remediation is authorised.** Authority to continue a blocked task
 *     comes from an operator, through `run --remediate-verify-failure`, and from
 *     nowhere else. This record is read *after* that decision, never as it;
 *  4. **that a retry is authorised.** `verify/run-verification.ts` runs one
 *     process per phase and never a second. Writing an attempt down does not
 *     make another one permissible;
 *  5. **that the diagnostics are true.** They are a bounded, redacted, line-safe
 *     excerpt of a foreign process's own output. See below;
 *  6. **that its absence means anything.** A task with no record *here* has not
 *     been shown to have failed: nothing adds an entry to this history for a
 *     pass, and a store that could not be written is a store that was not
 *     written. Since M8 a pass is recorded — in its own store, one document per
 *     task, `verify/verification-pass.ts` — and the two say different things:
 *     this one answers "why did AO stop", that one answers "which commit did AO
 *     measure as passing". Neither absence is evidence about the other.
 *
 * It **never mints authority and never decides a transition.** `loop/loop-step.ts`
 * decides; this is what it consults afterwards.
 *
 * ── Why it is a history, and why it is a separate file ─────────────────────
 *
 * The same argument `deliver/post-merge-verification.ts` sets out for its own
 * record, and this module deliberately follows that module rather than inventing
 * a second shape: one immutable record would let the first infrastructure
 * failure poison a task permanently, latest-wins would let a later pass silently
 * replace an earlier failure at the same commit, and attempt-files-plus-a-pointer
 * would need two files to move together — which `state/atomic-file.ts` does not
 * offer. What is left is a bounded append-only history in one file, replaced
 * atomically as a whole.
 *
 * It is not a field on `TaskState`. `TaskStateObjectSchema` is `.strict()`, and
 * two module headers — `agent/agent-outcome.ts` and `verify/run-verification.ts`
 * — currently cite that strictness as the *reason* diagnostics cannot be
 * persisted. Widening it to admit an excerpt would make both of those sentences
 * false. A separate store leaves the authority document exactly as strict as it
 * was, which is the property those sentences are about.
 *
 * ── The diagnostics, and the three guarantees they carry ───────────────────
 *
 * This record does carry a repository's own words, which its sibling refuses to.
 * The reason is measured rather than preferred: the writing agent has no shell
 * (`agent/claude-writer.ts` grants no `Bash`), so it **cannot re-run the gate**.
 * A brief naming only a phase and an exit code would send a writer to change a
 * tree it has no way to inspect the failure of. The excerpt is the only channel
 * there is.
 *
 * Three guarantees, each held by a different mechanism, and none of them is
 * "the text is safe":
 *
 *  - **bounded** — the excerpt comes from `agentDiagnostics()` unchanged, so it
 *    is already clamped after redaction with the raw cut held outside the
 *    redactor's field of view. This module bounds it a second time, *after*
 *    line-safety expands it, and stores the result as lines;
 *  - **redacted** — by `auth/redaction.ts`, whose own header is candid that it is
 *    "a safety net, never the boundary". It is repeated here rather than
 *    softened: this record may still contain a credential shape those rules do
 *    not know. It is written to a Git-ignored file under the repository root,
 *    mode 0600, and it is never transmitted anywhere;
 *  - **line-safe** — every character that could forge a line or reorder one is
 *    replaced by its code point before storage, and the excerpt is stored as an
 *    **array of lines** rather than one string with newlines in it. That is
 *    structural: there is no newline in any stored value, so no stored value can
 *    introduce a free-standing line into a report or into a writing agent's
 *    prompt. `loop/findings.ts` quotes each line again at the sink, which is
 *    defence in depth rather than the guarantee.
 *
 * There is **no `trusted` field on disk**, and its absence is the design. A
 * stored boolean saying "do not trust this" is a claim by whoever wrote the
 * file: dead weight if it can only be `false`, and a forgery lever if it can be
 * anything else. The schema is `.strict()`, so a document carrying one is
 * refused outright, and {@link storedDiagnosticsAsAgentDiagnostics} reconstitutes
 * `trusted: false` from the reader rather than from the bytes.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { type AgentDiagnostics } from '../agent/agent-outcome.js';
import type { VerificationReport } from './run-verification.js';
import { isLineSafe, lineSafe } from '../core/line-safe-text.js';

/**
 * The version of this record's contract, as this build writes and requires it.
 *
 * Deliberately not a range and deliberately not migratable, for the reason
 * `deliver/post-merge-verification.ts` gives: a build that reads a record it
 * does not understand and does its best is a build that acts on a document
 * written by rules it does not have.
 */
export const VERIFICATION_ATTEMPT_VERSION = 1;

/**
 * How many attempts one task's history keeps.
 *
 * A bound, not a window. When it is reached the next attempt is **refused**
 * rather than evicting the oldest, because the oldest evidence is the evidence
 * most likely to disagree with the newest — and disagreement between attempts is
 * the exact thing the release gate needed and did not have.
 *
 * Six, because the productive ceiling is lower than that: a task verifies once
 * per writing pass, and `completion.maxReviewRounds` in this repository's own
 * profile is three. A history that fills is a task that has been round the
 * verify/remediate loop more times than its review budget allows, which is an
 * operator condition in its own right.
 */
export const MAX_VERIFICATION_ATTEMPTS_KEPT = 6;

/**
 * The largest one stream's excerpt may be **after** line-safety, in characters.
 *
 * `DIAGNOSTIC_EXCERPT_LIMIT` is 4 000 characters *before* this module sees it,
 * and `lineSafe` expands: a value made entirely of control characters grows
 * eightfold, so an unbounded copy of a hostile excerpt would be 32 000
 * characters. Twice the input budget is generous for ordinary output — a test
 * runner's text expands not at all — and hard for output chosen to expand.
 *
 * The order is load-bearing and is the same one `agent/agent-outcome.ts` records
 * for redaction: the substitution runs first and the clamp runs on its result.
 * Clamping first would bound the input and not the artefact.
 */
export const MAX_STORED_EXCERPT_CHARS = 8_000;

/** The most lines one stream's excerpt may be split into. */
export const MAX_STORED_EXCERPT_LINES = 512;

/**
 * The largest record this build will read or write, in **bytes** on disk.
 *
 * A byte budget, checked against the encoded document, and load-bearing rather
 * than redundant with the schema for the reason `deliver/post-merge-verification.ts`
 * measures for its own: a schema `.max()` bounds UTF-16 code units, and a code
 * unit is not a byte. A schema-legal record can therefore exceed this and is
 * then refused — `RECORD_TOO_LARGE` on write, `MALFORMED` on read.
 *
 * The arithmetic, stated so a later change can check it rather than trust it:
 * two streams x {@link MAX_STORED_EXCERPT_CHARS} = 16 000 characters per
 * attempt; a BMP character is at most three bytes in UTF-8, so 48 000 bytes;
 * plus at most {@link MAX_STORED_EXCERPT_LINES} x 2 quoting overheads per stream
 * and the fixed fields, call it 52 000; times
 * {@link MAX_VERIFICATION_ATTEMPTS_KEPT} = 312 000, plus a 4 096-character
 * repository root. 384 KiB leaves room and stays well inside `MAX_TASK_STATE_BYTES`,
 * which is 1 MiB for a document written far more often than this one.
 */
export const MAX_VERIFICATION_ATTEMPT_RECORD_BYTES = 393_216;

const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The exit-code range this record accepts.
 *
 * Wide on purpose, and both ends are load-bearing, for the reason
 * `deliver/post-merge-verification.ts` measured: a Windows exception code
 * arrives through Node as an unsigned 32-bit value while the launch boundary
 * writes the same number as a signed `int32`. A bound admitting only one
 * spelling would discard the whole record — not the field — for a run that
 * really did produce that code.
 */
const MIN_EXIT_CODE = -2_147_483_648;
const MAX_EXIT_CODE = 4_294_967_295;

/**
 * One stream's excerpt, as it is stored.
 *
 * Lines, never a string with newlines in it. See the module header: the array is
 * what makes "no stored value can forge a line" structural instead of a promise.
 */
export const StoredExcerptSchema = z
  .array(z.string().max(MAX_STORED_EXCERPT_CHARS).refine(isLineSafe, 'Must be line-safe.'))
  .max(MAX_STORED_EXCERPT_LINES)
  // Readonly, so the inferred type matches what `storeExcerpt` hands back — a
  // frozen array. The build's convention is that a value handed out is frozen,
  // and a schema whose type said `string[]` would force either a cast or an
  // unfrozen array at the one place a caller could push a line onto stored
  // evidence.
  .readonly();

export type StoredExcerpt = z.infer<typeof StoredExcerptSchema>;

/**
 * What one phase did, as it is stored.
 *
 * Every field is a closed vocabulary or a number. `failureCode` and `errnoCode`
 * are here and are not decoration: they are the only things that separate a
 * timeout from an output-limit from a process that never started, and all three
 * of those arrive as the same `UNAVAILABLE` verdict.
 */
export const StoredPhaseReportSchema = z
  .object({
    phase: z.string().min(1).max(32),
    outcome: z.enum(['RAN', 'UNAVAILABLE', 'REFUSED_UNSAFE_ARGUMENT']),
    exitCode: z.int().min(MIN_EXIT_CODE).max(MAX_EXIT_CODE).nullable(),
    signal: z.string().min(1).max(32).nullable(),
    outputTruncated: z.boolean(),
    failureCode: z.string().min(1).max(48).nullable(),
    errnoCode: z.string().min(1).max(48).nullable(),
    durationMs: z.int().min(0),
  })
  .strict();

export type StoredPhaseReport = z.infer<typeof StoredPhaseReportSchema>;

/** The verdicts a stored attempt may carry. A pass is never stored — see below. */
export const STORED_ATTEMPT_VERDICTS = ['FAILED', 'UNAVAILABLE'] as const;

export type StoredAttemptVerdict = (typeof STORED_ATTEMPT_VERDICTS)[number];

/**
 * One attempt: one run of one profile against one commit, at one instant.
 *
 * `PASSED` is deliberately not in the vocabulary. A pass advances the task to
 * `REVIEWING` and leaves nothing for an operator to diagnose, and a store that
 * also recorded passes would spend its bounded history on the outcome nobody
 * needs to read. This record answers one question — "why did AO stop?" — and a
 * pass is not an answer to it.
 */
export const VerificationAttemptRecordSchema = z
  .object({
    /** When this process started the attempt. Never when it finished. */
    attemptedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    /**
     * The commit the worktree was at, read from Git immediately before the
     * record was built.
     *
     * The record's subject, and the field that stops it being a floating verdict:
     * a remediating writer moves HEAD, and a reader comparing this against HEAD
     * now is what keeps an old failure from being read as a current one.
     */
    subjectCommit: z.string().regex(COMMIT_OBJECT_NAME, 'Must be a commit object name.'),
    /**
     * Which contract ran — see `verify/verification-profile.ts`.
     *
     * Per attempt rather than per record, for the reason the sibling store gives:
     * the profile is an ordinary file that can change between two runs against
     * the same commit, and a digest at the top of the record would silently
     * relabel every historical attempt.
     */
    profileDigest: z.string().regex(HEX_64, 'Must be a profile digest.'),
    verdict: z.enum(STORED_ATTEMPT_VERDICTS),
    /** The phase that failed or could not be run. Never `null` here. */
    stoppedAt: z.string().min(1).max(32),
    /** One entry per phase actually run, in order. */
    phases: z.array(StoredPhaseReportSchema).min(1).max(8),
    /** The stopping phase's own output, bounded, redacted and line-safe. */
    stdoutExcerpt: StoredExcerptSchema,
    stderrExcerpt: StoredExcerptSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    // The cross-field invariant, and the whole of it. The stopping phase must be
    // the last one in the list, because `runVerification` stops at the first
    // phase that does not pass and appends nothing afterwards. A record whose
    // `stoppedAt` names a phase in the middle describes a run this build cannot
    // produce, and is refused here rather than trusted — this schema stands in
    // front of a file somebody may have written by hand.
    const last = value.phases[value.phases.length - 1];
    if (last === undefined || last.phase !== value.stoppedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['stoppedAt'],
        message: 'The stopping phase must be the last phase reported.',
      });
    }
  });

export type VerificationAttemptRecord = z.infer<typeof VerificationAttemptRecordSchema>;

export const VerificationAttemptHistorySchema = z
  .object({
    attemptVersion: z.int().positive(),
    taskId: z.string().min(1).max(128),
    /** The repository the task's record lives in. Absolute, compared on read. */
    repositoryRoot: z.string().min(1).max(4096),
    /**
     * Every attempt, oldest first. Append-only: an existing entry is never
     * edited and never removed.
     */
    attempts: z
      .array(VerificationAttemptRecordSchema)
      .min(1)
      .max(MAX_VERIFICATION_ATTEMPTS_KEPT),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict();

export type VerificationAttemptHistory = z.infer<typeof VerificationAttemptHistorySchema>;

/** The payload without the digest computed over it. */
export type VerificationAttemptHistoryPayload = Omit<VerificationAttemptHistory, 'binding'>;

/**
 * Who a record is expected to be about — the task's own identity.
 *
 * Deliberately without a state revision: a revision here would tie a record
 * about a commit to mutable task-state bytes, and the two are separate on
 * purpose.
 */
export interface VerificationAttemptSubject {
  readonly taskId: string;
  readonly repositoryRoot: string;
}

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/verification-attempt/v1';

/**
 * The binding digest for one payload against one task.
 *
 * The inputs are listed one by one rather than serialised from the object, for
 * the reason `mergeReconciliationBinding` states: `JSON.stringify(payload)`
 * would make the digest depend on key order, and would silently start covering —
 * or stop covering — a field added to the payload without anybody deciding it
 * should. Every field is here, **including every field of every attempt and
 * every line of every excerpt**, so that editing a stored diagnostic is detected
 * rather than inherited.
 */
export function verificationAttemptBinding(
  subject: VerificationAttemptSubject,
  payload: VerificationAttemptHistoryPayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.taskId,
        subject.repositoryRoot,
        payload.attemptVersion,
        payload.taskId,
        payload.repositoryRoot,
        payload.attempts.map((attempt) => [
          attempt.attemptedAt,
          attempt.subjectCommit,
          attempt.profileDigest,
          attempt.verdict,
          attempt.stoppedAt,
          attempt.phases.map((phase) => [
            phase.phase,
            phase.outcome,
            phase.exitCode,
            phase.signal,
            phase.outputTruncated,
            phase.failureCode,
            phase.errnoCode,
            phase.durationMs,
          ]),
          [...attempt.stdoutExcerpt],
          [...attempt.stderrExcerpt],
        ]),
      ]),
    )
    .digest('hex');
}

/** What a read of the store produced. A closed set; four of the five refuse. */
export const VERIFICATION_ATTEMPT_READINGS = [
  /** A history this build accepts, about this task. */
  'ATTEMPT_HISTORY',
  /** Nobody wrote one. The **only** reading that means that. */
  'ABSENT',
  /** Something is there and this build cannot say what it claims. */
  'MALFORMED',
  /** A record written to a contract version this build does not have. */
  'UNSUPPORTED_VERSION',
  /** An intact record about another task, another repository, or re-pointed. */
  'NOT_THIS_TASK',
] as const;

export type VerificationAttemptReading = (typeof VERIFICATION_ATTEMPT_READINGS)[number];

export interface VerificationAttemptReadResult {
  readonly reading: VerificationAttemptReading;
  /** The history, on `ATTEMPT_HISTORY` only. Nothing is handed back otherwise. */
  readonly record: VerificationAttemptHistory | null;
}

function reading(
  value: VerificationAttemptReading,
  record: VerificationAttemptHistory | null = null,
): VerificationAttemptReadResult {
  return Object.freeze({ reading: value, record });
}

/**
 * Grades one parsed document against one subject. Never throws.
 *
 * The version is checked **before** the schema, so a record written by a newer
 * build is `UNSUPPORTED_VERSION` rather than `MALFORMED`: those send an operator
 * to different places, and only one of them means somebody's file is broken.
 *
 * The identity is then checked **twice**, and the second check is not
 * redundant — `deliver/post-merge-verification.ts` records the defect it exists
 * for: a record whose payload names another task, with a binding computed for
 * *that* payload against *this* subject, matches the digest and arrives here.
 */
export function readVerificationAttempts(
  raw: unknown,
  subject: VerificationAttemptSubject,
): VerificationAttemptReadResult {
  if (typeof raw !== 'object' || raw === null) return reading('MALFORMED');
  const declared = (raw as { attemptVersion?: unknown }).attemptVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared <= 0) {
    return reading('MALFORMED');
  }
  if (declared !== VERIFICATION_ATTEMPT_VERSION) return reading('UNSUPPORTED_VERSION');

  const parsed = VerificationAttemptHistorySchema.safeParse(raw);
  if (!parsed.success) return reading('MALFORMED');
  const record = parsed.data;

  // Belt and braces: the version is re-read from the validated document, so a
  // schema that ever stopped pinning it cannot let a foreign version through.
  if (record.attemptVersion !== VERIFICATION_ATTEMPT_VERSION) {
    return reading('UNSUPPORTED_VERSION');
  }

  const { binding, ...payload } = record;
  if (verificationAttemptBinding(subject, payload) !== binding) return reading('NOT_THIS_TASK');
  if (record.taskId !== subject.taskId) return reading('NOT_THIS_TASK');
  if (record.repositoryRoot !== subject.repositoryRoot) return reading('NOT_THIS_TASK');

  return reading('ATTEMPT_HISTORY', record);
}

/**
 * A stream's excerpt, prepared for storage.
 *
 * Three steps, in this order and no other:
 *
 *  1. **split** on line endings, so no stored value contains one;
 *  2. **line-safe** each line, which is where an escape sequence, a carriage
 *     return and a bidirectional override stop being able to forge a line;
 *  3. **bound** the result — line count first, then the running character total,
 *     both counted *after* step 2 expanded anything.
 *
 * Reversing 2 and 3 would bound the input rather than the artefact, which is the
 * defect `agent/agent-outcome.ts` records for the equivalent ordering question
 * about redaction.
 *
 * The input is already `agentDiagnostics()`'s output: clamped after redaction,
 * with the raw cut held outside the redactor's field of view. Nothing here
 * re-implements any of that, and nothing here weakens it.
 */
export function storeExcerpt(excerpt: string): StoredExcerpt {
  const lines: string[] = [];
  let total = 0;
  for (const raw of excerpt.split(/\r\n|\r|\n/u)) {
    if (lines.length >= MAX_STORED_EXCERPT_LINES) break;
    const safe = lineSafe(raw);
    const remaining = MAX_STORED_EXCERPT_CHARS - total;
    if (remaining <= 0) break;
    const bounded = safe.length > remaining ? safe.slice(0, remaining) : safe;
    total += bounded.length;
    lines.push(bounded);
  }
  // A trailing empty line is what a stream ending in a newline splits into. It
  // carries nothing and would otherwise be rendered as a blank quoted line.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return Object.freeze(lines);
}

/**
 * A stored excerpt pair, handed back in the vocabulary the rest of the build
 * already speaks.
 *
 * `trusted: false` is reconstituted **here**, by this build, from a literal —
 * never read from the document. See the module header: a stored trust flag is a
 * claim by whoever wrote the file.
 */
export function storedDiagnosticsAsAgentDiagnostics(
  attempt: VerificationAttemptRecord,
): AgentDiagnostics {
  return Object.freeze({
    stdoutExcerpt: attempt.stdoutExcerpt.join('\n'),
    stderrExcerpt: attempt.stderrExcerpt.join('\n'),
    trusted: false as const,
  });
}

/** What the caller must supply that the report itself does not carry. */
export interface VerificationAttemptIdentity {
  /** The instant the verify step began. From the loop's injected clock. */
  readonly attemptedAt: string;
  /** The worktree HEAD, read from Git for this attempt. */
  readonly subjectCommit: string;
  /** `verificationProfileDigest` of the policy that ran. */
  readonly profileDigest: string;
}

/**
 * One attempt record, built from a report that did not pass.
 *
 * `null` for a `PASSED` report, and `null` for any report with no stopping
 * phase — which is the empty-profile `UNAVAILABLE` that `runVerification`
 * produces before it runs anything. Both are refusals to build rather than
 * degraded records: a store entry naming no phase would answer "why did AO
 * stop?" with silence, and the caller must be able to tell "there is nothing to
 * record" from "the recording failed".
 *
 * Nothing here interprets. Every field is copied from the report, and the two
 * excerpts go through {@link storeExcerpt} and nothing else.
 */
export function verificationAttemptFrom(
  report: VerificationReport,
  identity: VerificationAttemptIdentity,
): VerificationAttemptRecord | null {
  if (report.verdict === 'PASSED') return null;
  if (report.stoppedAt === null) return null;
  if (report.phases.length === 0) return null;

  return Object.freeze({
    attemptedAt: identity.attemptedAt,
    subjectCommit: identity.subjectCommit,
    profileDigest: identity.profileDigest,
    verdict: report.verdict,
    stoppedAt: report.stoppedAt,
    phases: report.phases.map((phase) =>
      Object.freeze({
        phase: phase.phase,
        outcome: phase.outcome,
        exitCode: phase.exitCode,
        signal: phase.signal,
        outputTruncated: phase.outputTruncated,
        failureCode: phase.failureCode,
        errnoCode: phase.errnoCode,
        durationMs: phase.durationMs,
      }),
    ),
    stdoutExcerpt: storeExcerpt(report.diagnostics.stdoutExcerpt),
    stderrExcerpt: storeExcerpt(report.diagnostics.stderrExcerpt),
  });
}
