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
 * A finding record carries three agent-derived strings — `fingerprint`, `path`
 * and `rule` — and each is admitted through an anchored allow-list at this
 * boundary, for one reason. A persisted state is untrusted input whoever wrote
 * it: `state-store.ts` says so, and `claude-writer.ts` names the same threat
 * model. (`fingerprint` was once the only one, and the paragraph below was
 * written when that was true; the argument did not change when the other two
 * arrived, which is why they are constrained here beside it rather than
 * anywhere else.) The durable value is
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

/**
 * The reviewer's path, restated here rather than imported.
 *
 * `agent/internal/codex-review-transcript.ts` owns the producer's copy and this
 * module deliberately does not reach into a sibling's internals — the same
 * reason it does not borrow the repository profile's patterns. What is written
 * down here is the *grammar a persisted state must pass*, which is a contract of
 * this boundary even when no producer is running.
 *
 * Repository-relative POSIX, 1 to 1024 characters, from an anchored allow-list:
 * letters, digits and exactly `.` `_` `:` `@` `=` `+` `/` `-`. Backslash, NUL,
 * space, every ASCII and C1 control, `U+2028`, `U+2029` and the bidi overrides
 * are excluded **by construction** rather than by enumeration, which is the same
 * closure property the fingerprint pattern has and the reason both are
 * allow-lists. No `m` flag, deliberately: under `m` the `$` would match before a
 * trailing newline and reopen the line-forging hole the whole class exists to
 * close. No `u` flag either — every member is ASCII.
 */
export const FINDING_PATH_PATTERN = /^[A-Za-z0-9._:@=+/-]+$/;

/** A drive-letter prefix, which a repository-relative path may never carry. */
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;

export const FindingPathSchema = z
  .string()
  .min(1, 'finding path must not be empty.')
  .max(1024, 'finding path must be at most 1024 characters.')
  .regex(
    FINDING_PATH_PATTERN,
    'finding path must be repository-relative POSIX built only from letters, digits and . _ : @ = + / -',
  )
  .refine((value) => !value.startsWith('/'), 'finding path must not start with "/".')
  .refine((value) => !DRIVE_LETTER_PREFIX.test(value), 'finding path must not carry a drive letter.')
  .refine(
    (value) => value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'finding path must have no empty, "." or ".." segment.',
  );

/**
 * The reviewer's rule slug.
 *
 * First and last character alphanumeric, inner set only `.` `_` `:` `-`, at most
 * 128 characters. Narrower than the path on purpose — `+ = @ /` are not
 * permitted in a rule — and restated exactly rather than simplified to
 * `[A-Za-z0-9._:-]+`, which would admit a leading or trailing separator the
 * producer never emits.
 */
export const FINDING_RULE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

export const FindingRuleSchema = z
  .string()
  .max(128, 'finding rule must be at most 128 characters.')
  .regex(
    FINDING_RULE_PATTERN,
    'finding rule must begin and end alphanumerically and contain only letters, digits and . _ : -',
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
    /**
     * Where the finding is, and what it is called.
     *
     * **Additive and defaulted rather than versioned**, exactly as
     * {@link scopeAuthorityCommit} and `operatorResolution` below are, and for
     * the identical reason: a record written before these fields existed means
     * `null`, and there is no migration path for a task state anywhere in this
     * build. Making them required would turn every checkpoint carrying a
     * finding — including this repository's own committed runtime states — into
     * a `CONTRACT_VIOLATION`, which `state-store.ts` classifies as
     * `STATE_INVALID`: nothing resumable and nothing repairable. The other
     * direction fails closed on its own, because an older build meets unknown
     * keys at this `.strict()` boundary and refuses the state — reporting it as
     * a broken record rather than as a newer contract, which is the cost that
     * shape has always carried.
     *
     * `null` is unambiguous here: both grammars refuse the empty string, so it
     * can only mean "this record predates the fix". That is a fact about **one
     * record**, which is why a resumed brief degrades per record rather than
     * announcing itself degraded as a whole.
     */
    path: FindingPathSchema.nullable().default(null),
    rule: FindingRuleSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Neither or both. Two independent nullables would admit a half-record no
    // review could produce, and a brief rendering `src/a.ts — null` would be
    // stating something the reviewer never said.
    if ((value.path === null) !== (value.rule === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rule'],
        message: 'a finding record carries both path and rule, or neither.',
      });
    }
  });

/**
 * What an operator's own ending of a task recorded about itself.
 *
 * `closedFrom` is restricted to the two states a task may be ended from —
 * `HUMAN_DECISION_REQUIRED` and `BLOCKED_VERIFY` — rather than to every blocking
 * state. Those two are the ones in which the loop stopped and asked the person
 * driving it for a decision. A `SCOPE_VIOLATION` says an agent left its sandbox
 * and the run is not trustworthy until somebody has looked; a
 * `RESUME_STATE_DIVERGED` says the record and the repository disagree. Ending
 * those with a flag is exactly the generic escape hatch this design refuses, and
 * narrowing the enum is what makes the refusal structural rather than a habit.
 */
const OperatorResolutionSchema = z
  .object({
    closedFrom: z.enum(['HUMAN_DECISION_REQUIRED', 'BLOCKED_VERIFY']),
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
    /**
     * The commit whose profile decides what this task is allowed to change.
     *
     * `null` — and `null` is the default — means *this task's own
     * `basePinnedCommit` governs*, which is the only answer that was ever needed
     * while every task started from the default branch.
     *
     * A chained task breaks that identity: its base pin is a commit its
     * predecessor's agent wrote, and reading a scope declaration out of that
     * commit would let one agent widen the next one's permissions. So the two
     * roles are separated here, in the durable record, rather than in whichever
     * invocation happens to be driving: a block run can end, crash or be killed,
     * and the successor's state is then an ordinary task state that any later
     * caller may continue. If the authority lived in that caller's arguments, the
     * guarantee would end with the invocation that made it.
     *
     * Additive and defaulted rather than versioned, deliberately. A state written
     * before this field existed means exactly `null`: no task before the chain had
     * a base authored by a sibling, so nothing is invented for an old document —
     * which is the test the ledger's version-1 refusal applied and failed. The
     * other direction fails closed on its own, because an older build meets an
     * unknown key at a `.strict()` boundary and refuses the state.
     */
    scopeAuthorityCommit: GitShaSchema.nullable().default(null),
    workBranch: NonBlankString('workBranch'),
    /** Head of the work branch, or `null` before the first commit exists. */
    currentCommit: GitShaSchema.nullable(),

    reviewRound: RoundSchema('reviewRound', 0),
    /**
     * What the repository declared. Written once by `run/start-task.ts` and
     * never re-derived, which is exactly why a grant does not touch it: the
     * record must keep saying what the profile said.
     */
    maxReviewRounds: RoundSchema('maxReviewRounds', 1),
    /**
     * How many review rounds operators have granted on top of the declared
     * budget, one per continuation out of an exhausted one.
     *
     * Additive and defaulted, so a state written before it existed means
     * exactly zero. It is the only field on which an operator's decision leaves
     * a durable mark — the other three continuation grants are frame-locals
     * that die with the invocation — and that is the point: without it, no
     * report can honestly answer how many rounds a task actually had, and the
     * loop reads durable state and nothing else, so an in-memory grant would
     * pay a reviewer and then be refused when the result was written.
     */
    grantedReviewRounds: RoundSchema('grantedReviewRounds', 0).default(0),

    blockedAgent: z.enum(AGENT_IDS).nullable(),
    resumeFrom: ResumePointSchema.nullable(),
    /** Quota reset time reported by an agent CLI, never invented by us. */
    reportedResetAt: IsoDateTimeSchema.nullable(),

    worktreeCleanAtCheckpoint: z.boolean(),

    /**
     * What an operator overrode when they ended this task themselves, or `null`
     * for every task no operator has ended.
     *
     * The provenance half of `OPERATOR_RESOLVED`, and `core/task-state.ts` makes
     * the two biconditional: the state cannot exist without naming what it
     * overrode, and the provenance cannot be attached to any other state as
     * decoration. That is what keeps this from being a force-complete switch —
     * a `grep` over a runtime directory counts hand-ended tasks and says which
     * refusal each one walked away from, which neither `READY_FOR_PR` nor
     * `ABORTED` could ever answer.
     *
     * `closedFrom` is written from the record the command **read**, never from
     * an argument, so an operator cannot name a softer state than the one they
     * actually overrode.
     *
     * Additive and defaulted rather than versioned, on the argument
     * `scopeAuthorityCommit` sets out above: a state written before this field
     * existed means exactly `null`, because no such task was ever
     * operator-ended, and the other direction fails closed because an older
     * build meets an unknown key — and an unknown enum member — at a `.strict()`
     * boundary and refuses the state. What that costs is stated rather than
     * hidden: the older build reports it as a broken record rather than as a
     * version boundary, which are different sentences to an operator.
     */
    operatorResolution: OperatorResolutionSchema.nullable().default(null),

    findingHistory: z.array(FindingRecordSchema),
  })
  .strict();
