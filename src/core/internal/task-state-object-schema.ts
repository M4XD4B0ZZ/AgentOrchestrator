/**
 * INTERNAL — not part of the public runtime API.
 *
 * This module holds the *plain object shape* of the task state: field types
 * only, no cross-field invariants. It exists for exactly two consumers:
 *
 *  1. JSON Schema generation (`core/json-schema.ts`), because JSON Schema
 *     cannot express state-dependent invariants; and
 *  2. composition inside `core/task-state.ts`, which layers those invariants
 *     on top and exposes the result as `TaskStateSchema`.
 *
 * It must never be re-exported from a public module or a barrel file (AO-009).
 * `TaskStateObjectSchema.parse()` accepts states that the contract rejects — a
 * `READY_FOR_PR` with an unresolved base commit, a `BLOCKED_USAGE_LIMIT`
 * without a resume point, a resume point in a phase the loop cannot reach — so
 * handing it to callers as a validator would quietly bypass the contract.
 *
 * Use `TaskStateSchema`, `parseTaskState()` or `safeParseTaskState()` instead.
 * `tests/internal-api.test.ts` fails if this schema becomes publicly reachable.
 */

import { z } from 'zod';

import { AGENT_IDS, ALL_STATES, FINDING_SEVERITIES } from '../states.js';
import { ResumePointSchema, RoundSchema } from '../resume-point.js';

/**
 * Current version of the state contract. Bump on any breaking shape change.
 *
 * INTERNAL: it lives here, next to the shape it versions, and is consumed by
 * `core/task-state.ts` and the JSON-Schema generator. It is not part of the
 * public runtime surface — a consumer reads the version off a parsed state's
 * `schemaVersion` field, which the contract already validates (AO-009-R1).
 */
export const TASK_STATE_SCHEMA_VERSION = 1;

/**
 * A full Git object name. Accepts SHA-1 (40 hex) and SHA-256 (64 hex) so the
 * contract does not break on `objectFormat=sha256` repositories.
 * Abbreviated SHAs are rejected on purpose: pinning must be unambiguous.
 */
export const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const GitShaSchema = z
  .string()
  .regex(GIT_SHA_PATTERN, 'Must be a full lowercase hex Git object name (40 or 64 characters).');

/** ISO-8601 timestamp; a UTC `Z` suffix or a numeric offset are both accepted. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Non-empty, non-blank identifier. */
export const NonBlankString = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty.`)
    .refine((value) => value.trim().length > 0, `${label} must not be blank.`);

/**
 * The canonical fingerprint grammar: a lowercase hex digest of fixed width.
 *
 * This is exactly what the one producer emits — `fingerprintFinding` in
 * `agent/internal/codex-review-transcript.ts` takes a SHA-256 of the
 * allow-listed triple, renders it with `digest('hex')` (lowercase by
 * definition) and slices it to 32 characters — so the contract states the
 * producer's output rather than a superset of it.
 *
 * ── Why this is a schema rule and not a rendering rule (V1-08, RR-B1-N4) ────
 *
 * `fingerprint` is the only free-form string the durable contract accepts, and
 * a persisted state is untrusted input whoever wrote it: `state-store.ts` says
 * so, and `claude-writer.ts` names the same threat model. The durable value is
 * later rendered into a *writer's* prompt by
 * `buildResumedRemediationBrief`, one record per `'\n'`-joined line — so a
 * persisted fingerprint carrying a line break would arrive in a writing
 * agent's instructions as a free-standing line, able to forge the very
 * `FINDINGS (n; …)` header the module authors above it.
 *
 * That is precisely the reasoning `codex-review-transcript.ts` already applies
 * to a reviewer-supplied `path`, which is constrained by an allow-list rather
 * than a list of refusals *because* it is quoted into that same prompt. The
 * defence belongs in the same place for the same reason: at the boundary where
 * the value is admitted, not at the sink where it is rendered. A sink that
 * escaped the value would still have accepted a state asserting a fingerprint
 * no review could have produced.
 *
 * Anchored at both ends, so a conforming prefix cannot carry a payload after
 * it. No `u` flag is needed: every member of the class is ASCII.
 */
export const FINDING_FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;

export const FindingFingerprintSchema = z
  .string()
  .regex(
    FINDING_FINGERPRINT_PATTERN,
    'fingerprint must be a 32-character lowercase hex digest, exactly as the review parser computes it.',
  );

export const FindingRecordSchema = z
  .object({
    round: RoundSchema('Finding round', 1),
    severity: z.enum(FINDING_SEVERITIES),
    /**
     * Stable identity of a finding across review rounds, used to detect repeat
     * findings. Constrained to {@link FINDING_FINGERPRINT_PATTERN}: the
     * computation lives with the review parser that owns it, but the *grammar*
     * of what may be persisted is fixed here, because this is the boundary a
     * hand-written state file has to pass.
     */
    fingerprint: FindingFingerprintSchema,
  })
  .strict();

/** Plain object shape, without cross-field invariants. INTERNAL. */
export const TaskStateObjectSchema = z
  .object({
    schemaVersion: z.int().positive('schemaVersion must be a positive integer.'),

    taskId: NonBlankString('taskId'),
    repositoryId: NonBlankString('repositoryId'),

    /**
     * Filesystem locations. No drive letter, platform or existence assumption
     * is made here — existence is a preflight concern, not a schema concern.
     */
    repositoryRoot: NonBlankString('repositoryRoot'),
    worktreePath: NonBlankString('worktreePath'),

    state: z.enum(ALL_STATES),
    stateEnteredAt: IsoDateTimeSchema,

    baseBranch: NonBlankString('baseBranch'),
    /** Full SHA the work is pinned to, or `null` before it has been resolved. */
    basePinnedCommit: GitShaSchema.nullable(),
    workBranch: NonBlankString('workBranch'),
    /** Head of the work branch, or `null` before the first commit exists. */
    currentCommit: GitShaSchema.nullable(),

    reviewRound: RoundSchema('reviewRound', 0),
    maxReviewRounds: RoundSchema('maxReviewRounds', 1),

    blockedAgent: z.enum(AGENT_IDS).nullable(),
    resumeFrom: ResumePointSchema.nullable(),
    /** Quota reset time reported by an agent CLI, never invented by us. */
    reportedResetAt: IsoDateTimeSchema.nullable(),

    worktreeCleanAtCheckpoint: z.boolean(),

    findingHistory: z.array(FindingRecordSchema),
  })
  .strict();
