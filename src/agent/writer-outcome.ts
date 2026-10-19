/**
 * The durable writer-outcome record: which failure code a writing pass ended
 * with, kept beside the task record as evidence and nothing else (RM1-03A).
 *
 * ── The defect this exists for ─────────────────────────────────────────────
 *
 * `runClaudeWriter` diagnoses a failed run with one of ten closed codes, and
 * `loop-step.ts` hands `recordAgentInterruption` only the disposition and the
 * block. Eight codes share the disposition `AGENT_NEEDS_ATTENTION`, so they park
 * the task with byte-identical task records: `AGENT_ARGUMENT_REFUSED`, which is
 * deterministic and will refuse again, cannot be told from
 * `AGENT_PROCESS_UNAVAILABLE`, which is transient and may not. The code was
 * computed, returned and dropped. This record keeps it.
 *
 * ── What it is not ─────────────────────────────────────────────────────────
 *
 *  - **not a task state.** `TaskState`, its schema and the transition table are
 *    unchanged, and nothing here is consulted by a transition, a resume
 *    decision, a selection or a plan's conclusion. `run-plan.ts` reads it into
 *    one display line and nothing more;
 *  - **not the agent's words.** Every value is closed: a code, a disposition,
 *    the static sentence `AGENT_FAILURE_TEXT` holds for that code, the closed
 *    process facts and one boolean. No stdout, no stderr, no excerpt, no
 *    `AgentDiagnostics`, no path. The schema is `.strict()`, so a document
 *    carrying anything else is refused on read;
 *  - **not unbounded.** {@link MAX_WRITER_OUTCOMES_KEPT} entries per task. Unlike
 *    the verification history this is a window, not a bound that refuses: the
 *    newest code is the one a later reader needs, so a ninth entry drops the
 *    oldest and counts the loss in `droppedCount`, which keeps the loss visible.
 *
 * This module writes nothing and imports no writer. The store beside it does
 * that, as `verify/verification-attempt.ts` and its store are split.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ClaudeWriterFailed } from './claude-writer.js';
import { AGENT_FAILURE_CODES, AGENT_FAILURE_TEXT } from './agent-outcome.js';
import { isLineSafe } from '../core/line-safe-text.js';

/** The version of this record's contract, as this build writes and requires it. */
export const WRITER_OUTCOME_VERSION = 1;

/** How many entries one task's record keeps. A ninth drops the oldest. */
export const MAX_WRITER_OUTCOMES_KEPT = 8;

/**
 * The largest record this build will read or write, in **bytes** on disk.
 *
 * The arithmetic: one entry is a handful of closed fields and a static sentence
 * of at most {@link MAX_DETAIL_CHARS} characters — under 2 KiB even at three
 * bytes a character. Eight of them is 16 KiB, plus a 4 096-character repository
 * root at three bytes a character. 64 KiB leaves room.
 */
export const MAX_WRITER_OUTCOME_RECORD_BYTES = 65_536;

/** The longest static sentence a stored entry may carry. */
const MAX_DETAIL_CHARS = 512;

const HEX_64 = /^[0-9a-f]{64}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The exit-code range, both spellings of a Windows exception code. See `verification-attempt.ts`. */
const MIN_EXIT_CODE = -2_147_483_648;
const MAX_EXIT_CODE = 4_294_967_295;

/** The writing phases. A writer outcome is never about a review. */
export const WRITER_OUTCOME_PHASES = ['IMPLEMENT', 'REMEDIATE'] as const;

export type WriterOutcomePhase = (typeof WRITER_OUTCOME_PHASES)[number];

/** The dispositions a failed writer can map to. `AGENT_COMPLETED` is not a failure. */
const FAILED_DISPOSITIONS = [
  'AGENT_BLOCKED_USAGE_LIMIT',
  'AGENT_BLOCKED_AUTH',
  'AGENT_NEEDS_ATTENTION',
] as const;

/** The closed fields of `AgentProcessEvidence`, as they are stored. */
export const StoredWriterProcessSchema = z
  .object({
    outcome: z.enum(['RAN', 'UNAVAILABLE', 'REFUSED_UNSAFE_ARGUMENT']),
    exitCode: z.int().min(MIN_EXIT_CODE).max(MAX_EXIT_CODE).nullable(),
    signal: z.string().min(1).max(32).nullable(),
    outputTruncated: z.boolean(),
    failureCode: z.string().min(1).max(48).nullable(),
    errnoCode: z.string().min(1).max(48).nullable(),
    durationMs: z.int().min(0),
  })
  .strict();

export type StoredWriterProcess = z.infer<typeof StoredWriterProcessSchema>;

/** One failed writing pass. */
export const WriterOutcomeEntrySchema = z
  .object({
    /** The step's injected instant. */
    recordedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    phase: z.enum(WRITER_OUTCOME_PHASES),
    round: z.int().min(0),
    /** The writer's own `AgentFailureCode`, unchanged. */
    code: z.enum(AGENT_FAILURE_CODES),
    disposition: z.enum(FAILED_DISPOSITIONS),
    /** `AGENT_FAILURE_TEXT[code]`: the cause in words, written in this repository. */
    detail: z.string().min(1).max(MAX_DETAIL_CHARS).refine(isLineSafe, 'Must be line-safe.'),
    process: StoredWriterProcessSchema,
    /** Whether a forbidden-write evidence record was named. Never its path. */
    forbiddenWriteRecorded: z.boolean(),
  })
  .strict();

export type WriterOutcomeEntry = z.infer<typeof WriterOutcomeEntrySchema>;

export const WriterOutcomeHistorySchema = z
  .object({
    outcomeVersion: z.int().positive(),
    taskId: z.string().min(1).max(128),
    /** The repository the task's record lives in. Absolute, compared on read. */
    repositoryRoot: z.string().min(1).max(4096),
    /** How many entries were dropped to keep the window. A loss, made visible. */
    droppedCount: z.int().min(0),
    /** Oldest first. */
    outcomes: z.array(WriterOutcomeEntrySchema).min(1).max(MAX_WRITER_OUTCOMES_KEPT),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict();

export type WriterOutcomeHistory = z.infer<typeof WriterOutcomeHistorySchema>;

/** The payload without the digest computed over it. */
export type WriterOutcomeHistoryPayload = Omit<WriterOutcomeHistory, 'binding'>;

/** Who a record is expected to be about. */
export interface WriterOutcomeSubject {
  readonly taskId: string;
  readonly repositoryRoot: string;
}

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/writer-outcome/v1';

/**
 * The binding digest for one payload against one task.
 *
 * Every field is listed one by one, for the reason `verificationAttemptBinding`
 * gives: a serialised object would make the digest depend on key order and would
 * silently start or stop covering a field nobody decided about.
 */
export function writerOutcomeBinding(
  subject: WriterOutcomeSubject,
  payload: WriterOutcomeHistoryPayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        subject.taskId,
        subject.repositoryRoot,
        payload.outcomeVersion,
        payload.taskId,
        payload.repositoryRoot,
        payload.droppedCount,
        payload.outcomes.map((entry) => [
          entry.recordedAt,
          entry.phase,
          entry.round,
          entry.code,
          entry.disposition,
          entry.detail,
          [
            entry.process.outcome,
            entry.process.exitCode,
            entry.process.signal,
            entry.process.outputTruncated,
            entry.process.failureCode,
            entry.process.errnoCode,
            entry.process.durationMs,
          ],
          entry.forbiddenWriteRecorded,
        ]),
      ]),
    )
    .digest('hex');
}

/** What a read of the store produced. A closed set; four of the five refuse. */
export const WRITER_OUTCOME_READINGS = [
  /** A record this build accepts, about this task. */
  'WRITER_OUTCOME_HISTORY',
  /** Nobody wrote one. The **only** reading that means that. */
  'ABSENT',
  /** Something is there and this build cannot say what it claims. */
  'MALFORMED',
  /** A record written to a contract version this build does not have. */
  'UNSUPPORTED_VERSION',
  /** An intact record about another task, another repository, or re-pointed. */
  'NOT_THIS_TASK',
] as const;

export type WriterOutcomeReading = (typeof WRITER_OUTCOME_READINGS)[number];

export interface WriterOutcomeReadResult {
  readonly reading: WriterOutcomeReading;
  /** The record, on `WRITER_OUTCOME_HISTORY` only. Nothing is handed back otherwise. */
  readonly record: WriterOutcomeHistory | null;
}

function reading(
  value: WriterOutcomeReading,
  record: WriterOutcomeHistory | null = null,
): WriterOutcomeReadResult {
  return Object.freeze({ reading: value, record });
}

/**
 * Grades one parsed document against one subject. Never throws.
 *
 * The version before the schema, and the identity twice, for the reasons
 * `readVerificationAttempts` gives for its own.
 */
export function readWriterOutcomes(
  raw: unknown,
  subject: WriterOutcomeSubject,
): WriterOutcomeReadResult {
  if (typeof raw !== 'object' || raw === null) return reading('MALFORMED');
  const declared = (raw as { outcomeVersion?: unknown }).outcomeVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared <= 0) {
    return reading('MALFORMED');
  }
  if (declared !== WRITER_OUTCOME_VERSION) return reading('UNSUPPORTED_VERSION');

  const parsed = WriterOutcomeHistorySchema.safeParse(raw);
  if (!parsed.success) return reading('MALFORMED');
  const record = parsed.data;

  if (record.outcomeVersion !== WRITER_OUTCOME_VERSION) return reading('UNSUPPORTED_VERSION');

  const { binding, ...payload } = record;
  if (writerOutcomeBinding(subject, payload) !== binding) return reading('NOT_THIS_TASK');
  if (record.taskId !== subject.taskId) return reading('NOT_THIS_TASK');
  if (record.repositoryRoot !== subject.repositoryRoot) return reading('NOT_THIS_TASK');

  return reading('WRITER_OUTCOME_HISTORY', record);
}

/** What the caller must supply that the writer result does not carry. */
export interface WriterOutcomeIdentity {
  /** The step's injected instant. */
  readonly recordedAt: string;
  /** The writing phase the step ran, from the step rather than the result. */
  readonly phase: WriterOutcomePhase;
  readonly round: number;
}

/**
 * One entry, built from a failed writer result.
 *
 * An allow-list, field by field: `diagnostics` and the forbidden-write record
 * are absent by construction, and a field added to `ClaudeWriterFailed` later
 * arrives here as nothing at all. `detail` is taken from `AGENT_FAILURE_TEXT`
 * by code rather than copied from the result, so it is the static sentence even
 * if a result were built by hand.
 */
export function writerOutcomeFrom(
  writer: ClaudeWriterFailed,
  identity: WriterOutcomeIdentity,
): WriterOutcomeEntry {
  const forbiddenWrite = writer.forbiddenWrite;
  return Object.freeze({
    recordedAt: identity.recordedAt,
    phase: identity.phase,
    round: identity.round,
    code: writer.code,
    disposition: writer.disposition,
    detail: AGENT_FAILURE_TEXT[writer.code],
    process: Object.freeze({
      outcome: writer.process.outcome,
      exitCode: writer.process.exitCode,
      signal: writer.process.signal,
      outputTruncated: writer.process.outputTruncated,
      failureCode: writer.process.failureCode,
      errnoCode: writer.process.errnoCode,
      durationMs: writer.process.durationMs,
    }),
    forbiddenWriteRecorded:
      forbiddenWrite !== undefined &&
      typeof forbiddenWrite.recordPath === 'string' &&
      forbiddenWrite.recordPath.length > 0,
  });
}
