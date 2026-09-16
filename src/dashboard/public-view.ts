/**
 * The public dashboard contract — what may cross to a browser.
 *
 * ── A projection, not a second read model ──────────────────────────────────
 *
 * Everything this module could be tempted to decide has already been decided in
 * `read-model.ts`: what the declaration says, what the runtime record says, what
 * the two together ask of the operator, which tasks are actionable, which are
 * waiting on a clock, which contradict each other, and what could not be read.
 * This module re-derives none of it.
 *
 * That restraint is the point. The moment a public mapper computes "is this
 * actionable" from raw states, there are two opinions about it — and the one on
 * the phone is the one an operator acts on. So the needs-you list here is a
 * *filter* over the internal classification, never a recomputation, and a test
 * pins that a task the internal model did not call `ACTIONABLE` cannot become
 * actionable by passing through here.
 *
 * ── Redaction is structural ────────────────────────────────────────────────
 *
 * The internal model holds absolute roots, worktree paths and an owner pid,
 * because composing the readers needs them. None of that may reach a browser,
 * and "we did not serialise it" is not good enough: the public types simply have
 * nowhere to put it. A field that does not exist cannot leak through a later
 * convenience edit.
 *
 * What replaces the root is {@link repositoryKeyFor} — a stable pseudonymous
 * identifier, and deliberately not a secret. It is domain-separated and derived
 * with a digest so that the same checkout always answers the same key and two
 * clones that declare one `repositoryId` stay two rows. It is not an
 * authentication mechanism and does not hide the path from anyone who can guess
 * it; keeping the dashboard private is the transport layer's job, later.
 *
 * ── One change token for the whole public value ────────────────────────────
 *
 * {@link revisionOf} hashes the canonical form of the public snapshot with
 * `observedAt` removed. It is defined here, before any HTTP exists, because the
 * obvious cheaper token is wrong: composing AO's registry digest with the task
 * revisions misses everything those bytes do not cover — lease liveness, a
 * directory that became unreadable, a declaration that changed. A writer dying
 * moves no file and must still move the token.
 *
 * It moves on a change in public *meaning*, and not on a change in public bytes.
 * Collection arrays are put into membership order before the hash is taken, so
 * two snapshots that hold the same repositories, tasks, needs-you entries and
 * notes answer one revision however those collections happened to be ordered.
 * The order the browser is served is left exactly as decided — the two questions
 * are separated on purpose, and {@link PUBLIC_ARRAY_SEMANTICS} records which
 * arrays may be treated this way and why.
 *
 * Stated carefully, because the easy version of this sentence is false:
 * `readDashboardSnapshot` ALREADY orders repositories by canonical root and
 * tasks by task id (`read-model.ts` lines 875 and 1107), so today's producer
 * cannot hand this module a shuffled collection, and the old token was already
 * invariant to that. What the normalisation buys is that the guarantee belongs
 * to the token instead of to an upstream sort nobody wrote down. `revisionOf` is
 * exported and the slice that serves HTTP will call it on bodies it composes
 * itself; a change token whose correctness rests on an unstated property of one
 * caller is the kind that fails silently, months later, in the caller that did
 * not know about it.
 */

import { createHash } from 'node:crypto';

import type {
  DashboardSnapshot,
  DeclarationReading,
  NeedsOperatorEntry,
  OperationalReading,
  ReadingNote,
  ReadingNoteCode,
  RepositorySnapshot,
  TaskSnapshot,
} from './read-model.js';
import type { AgentId, StateKind, TaskStateName } from '../core/states.js';
import type { AttentionReason } from '../core/task-attention.js';

/* ── repository identity ───────────────────────────────────────────────────── */

/**
 * Domain separator for the repository key.
 *
 * Versioned and terminated with a NUL so the hashed input cannot collide with
 * any other digest this project takes, and so changing the scheme later is a
 * visible decision rather than a silent re-keying of every stored preference.
 */
export const REPOSITORY_KEY_DOMAIN = 'ao-dashboard-repository-key:v1\u0000';

/**
 * A stable pseudonymous identifier for one checkout.
 *
 * Same canonical root, same key, on every read. Two checkouts that declare the
 * same `repositoryId` get different keys, which is the property the browser
 * needs and `repositoryId` cannot provide.
 *
 * NOT a secret. It is a rename, not a lock: anyone who can guess a path can
 * confirm it against this value. The reason to use it is that the UI, its
 * routes and anything it remembers should not be shaped by the layout of the
 * operator's disk — privacy here is a consequence, not the mechanism.
 *
 * The full digest is kept. Truncating would buy a shorter URL and spend a
 * collision margin for nothing.
 */
export function repositoryKeyFor(canonicalRoot: string): string {
  return createHash('sha256').update(`${REPOSITORY_KEY_DOMAIN}${canonicalRoot}`, 'utf8').digest('hex');
}

/* ── public readings ───────────────────────────────────────────────────────── */

export type PublicRegistryReading =
  | {
      readonly reading: 'REGISTERED';
      readonly entryCount: number;
      readonly maxConcurrentRepositories: number;
    }
  | { readonly reading: 'NOT_REGISTERED' }
  | { readonly reading: 'UNUSABLE'; readonly code: string };

export type PublicProfileReading =
  | {
      readonly reading: 'DECLARED';
      readonly repositoryId: string;
      readonly defaultBranch: string;
      readonly maxReviewRounds: number;
    }
  | { readonly reading: 'UNUSABLE'; readonly code: string };

export type PublicDeclaredTaskReading =
  | { readonly reading: 'DISCOVERED'; readonly count: number }
  | { readonly reading: 'REFUSED'; readonly code: string; readonly taskId: string | null }
  | { readonly reading: 'NOT_ATTEMPTED'; readonly why: string };

export type PublicRuntimeScanReading =
  | { readonly reading: 'READ'; readonly stateFileCount: number; readonly truncated: boolean }
  | { readonly reading: 'DIRECTORY_ABSENT' }
  | { readonly reading: 'DIRECTORY_UNREADABLE' };

/**
 * The lease, as a momentary per-repository observation.
 *
 * `ownerPid` is gone — a process id is machine-local, is useless to a browser,
 * and is the kind of value that turns a status page into a thing people paste
 * into shell commands. What survives is what a reader can act on: whether
 * anything holds this repository, when it was taken, and whether the recorded
 * owner still answers.
 *
 * There is no repository-level "running" field and no snapshot-level one either.
 * AO writes no pidfile, no heartbeat and no daemon record, so the absence of a
 * lease is not evidence that nothing is running.
 */
export type PublicLeaseReading =
  | { readonly reading: 'FREE' }
  | {
      readonly reading: 'HELD';
      readonly acquiredAt: string | null;
      readonly ownerLiveness: string;
    }
  | { readonly reading: 'OTHER'; readonly state: string }
  | { readonly reading: 'NOT_OBSERVED'; readonly why: string };

/**
 * The durable record, minus anything that names this machine.
 *
 * `recordedWorktreePath` is dropped. Every remaining field keeps the name the
 * internal model gave it, including the `recorded` prefixes: a commit the last
 * checkpoint wrote is not an observation of HEAD, and the public contract must
 * not be the place that quietly promotes it into one.
 */
export type PublicRuntimeReading =
  | { readonly reading: 'NONE' }
  | { readonly reading: 'UNREADABLE'; readonly code: string }
  | {
      readonly reading: 'LOADED';
      readonly state: TaskStateName;
      readonly stateKind: StateKind;
      readonly stateEnteredAt: string;
      readonly recordedPhaseAgent: AgentId | null;
      readonly workBranch: string;
      readonly recordedCurrentCommit: string | null;
      readonly reviewRound: number;
      readonly reviewBudget: number;
      readonly blockedAgent: AgentId | null;
      readonly reportedResetAt: string | null;
    };

/**
 * Verification evidence, still stated as evidence.
 *
 * Both halves survive, and neither is called `verified`. A pass recorded for a
 * commit is exactly that; whether this worktree is still at that commit needs a
 * fresh `git rev-parse` that no poll takes.
 */
export type PublicVerificationReading =
  | { readonly reading: 'NONE' }
  | { readonly reading: 'UNREADABLE'; readonly code: string }
  | {
      readonly reading: 'RECORDED';
      readonly lastAttempt: {
        readonly verdict: string;
        readonly attemptedAt: string;
        readonly forCommit: string;
        readonly stoppedAtPhase: string | null;
        readonly exitCode: number | null;
      } | null;
      readonly passRecordedForCommit: string | null;
      readonly passMeasuredAt: string | null;
    };

export type PublicDeliveryReading =
  | { readonly reading: 'NONE' }
  | { readonly reading: 'UNKNOWN'; readonly why: string }
  | {
      readonly reading: 'MERGE_RECORDED';
      readonly pullRequestNumber: number;
      readonly mergeCommit: string;
      readonly baseRef: string;
    }
  | {
      readonly reading: 'DELIVERY_CONCLUDED';
      readonly pullRequestNumber: number;
      readonly mergeCommit: string;
      readonly concludedAt: string;
    };

/**
 * One task.
 *
 * `action` is present only where the internal model classified the task
 * `ACTIONABLE`. That is not a display nicety: an operator sentence naming a
 * resume command, shown against a task the plan calls finished, is the false
 * alarm this whole layer exists to avoid.
 */
export interface PublicTask {
  readonly taskId: string;
  readonly declaration: DeclarationReading;
  readonly runtime: PublicRuntimeReading;
  readonly operational: OperationalReading;
  readonly action: { readonly reason: AttentionReason; readonly text: string } | null;
  readonly verification: PublicVerificationReading;
  readonly delivery: PublicDeliveryReading;
}

export interface PublicRepository {
  /** Stable pseudonymous identity. The canonical root does not cross. */
  readonly repositoryKey: string;
  readonly profile: PublicProfileReading;
  readonly declaredTasks: PublicDeclaredTaskReading;
  readonly runtimeScan: PublicRuntimeScanReading;
  readonly lease: PublicLeaseReading;
  readonly tasks: readonly PublicTask[];
}

export interface PublicNeedsOperatorEntry {
  readonly repositoryKey: string;
  readonly taskId: string;
  readonly reason: AttentionReason;
  readonly text: string;
}

export interface PublicReadingNote {
  readonly code: ReadingNoteCode;
  readonly repositoryKey: string | null;
  readonly taskId: string | null;
  readonly detail: string | null;
}

export interface PublicSnapshot {
  /** When this was observed. Excluded from {@link revision} by design. */
  readonly observedAt: string;
  /** Change token over everything else in this value. */
  readonly revision: string;
  readonly registry: PublicRegistryReading;
  readonly repositories: readonly PublicRepository[];
  readonly needsOperator: readonly PublicNeedsOperatorEntry[];
  readonly notes: readonly PublicReadingNote[];
}

/* ── canonical form and the change token ───────────────────────────────────── */

/**
 * A deterministic serialization: object keys sorted, array order preserved.
 *
 * It removes the one thing in a JavaScript object that carries no meaning — the
 * order a key happened to be assigned in — and it does not reorder arrays.
 *
 * It is NOT a fidelity-preserving encoding, and the difference matters to anyone
 * reasoning about collisions. Like `JSON.stringify`, it drops a key whose value
 * is `undefined`, and it writes any object by its own enumerable properties, so
 * a `Map`, a `Set` or a class instance serializes as `{}`. Neither is a problem
 * for the value it is used on — every public type here is a plain object of
 * strings, numbers, booleans, `null` and arrays — but it is a precondition, not
 * a property of the function.
 *
 * Collection order is dealt with one level up, in {@link revisionOf}, and
 * deliberately not here: the order the browser is served and the order the
 * change token is taken over are two different questions, and answering them in
 * one function would force one of them to be wrong.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/* ── array semantics, declared rather than assumed ─────────────────────────── */

/**
 * What every array in the public snapshot means, stated once.
 *
 * - `SET`     membership is the fact; the order is a presentation choice. Two
 *             snapshots holding the same elements in a different order carry the
 *             same public information and must answer the same revision.
 * - `ORDERED` the order is itself information — a ranking, a sequence, a history
 *             — and a swap is a real change that must move the revision.
 *
 * `SET` does not mean the served order is arbitrary or free to change. AO serves
 * repositories in canonical-root order and tasks in task-id order, and those are
 * deliberate, stable presentation choices that {@link toPublicSnapshot} keeps.
 * The claim is narrower and is about content: a row's POSITION says nothing the
 * row does not already carry, so moving it changes what a reader sees the list
 * in, and not what the snapshot says.
 *
 * Today every public array is a `SET`, and that is a claim about each one rather
 * than a default: `repositories` is identified by `repositoryKey`, `tasks` by
 * `taskId`, `needsOperator` by the pair, and `notes` by their whole content.
 * None of the four is a ranking, a sequence or a history.
 *
 * The reason to write it down is the array that does not exist yet. "Upstream
 * happens to emit these in a stable order" is not a semantic, and a later field
 * inheriting that non-answer is exactly how an ETag starts lying.
 *
 * Nothing in this module READS this map, so on its own it is a comment that can
 * drift. Two pins are what make it load-bearing, and they are separate claims:
 *
 * - NAMED. A walk over public snapshots built to instantiate every variant of
 *   every public union fails if it meets an array this map does not name. It is
 *   fixture-driven, so its reach is the enumeration it asserts — a union member
 *   added to the types and not to that fixture is still invisible, which the
 *   test says out loud rather than implying otherwise.
 * - HONOURED. Each declared array is permuted in the hash input, and a `SET`
 *   must leave the revision unmoved. Declaring an array `SET` while
 *   {@link revisionOf} has never heard of it fails there.
 *
 * Together they make adding an array a decision rather than an omission. Either
 * one alone does not: the first would let a declared-but-unnormalised array pass
 * as classified, and the second would never ask about an array nobody declared.
 */
export const PUBLIC_ARRAY_SEMANTICS = {
  repositories: 'SET',
  'repositories[].tasks': 'SET',
  needsOperator: 'SET',
  notes: 'SET',
} as const satisfies Record<string, 'SET' | 'ORDERED'>;

/** Code-unit order, the same comparison `compareTaskIds` makes. Never `localeCompare`. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compares two identity tuples component by component. A shorter tuple that
 * agrees on every shared component sorts first.
 *
 * Component by component rather than by joining the parts with a separator,
 * because joining is not an injective encoding: a component containing the
 * separator collides with a different tuple that does not, and `['a|b', 'c']`
 * and `['a', 'b|c']` both join to `a|b|c`.
 *
 * Measured, and said here rather than implied: replacing this body with a joined
 * comparison passes every pin in `tests/dashboard-04-public-view.test.ts`. It
 * has to — the canonical-form tie-break below makes BOTH orders a function of
 * the membership alone, which is the whole property the revision needs. So this
 * form is kept for saying what is meant, tuples rather than strings, and not
 * because a test forces it. The surviving mutant is reported, not explained
 * away.
 */
function compareIdentities(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const ordered = compareCodeUnits(left[index] ?? '', right[index] ?? '');
    if (ordered !== 0) return ordered;
  }
  return left.length - right.length;
}

/**
 * One `SET` array, put into an order that depends on its members and nothing
 * else.
 *
 * The declared identity decides the order. The canonical form of the whole
 * element then breaks any tie, and that second key is what makes the result a
 * function of the membership rather than of the input order: an identity that is
 * not unique — two needs-you entries naming one task with different sentences —
 * would otherwise be left to the stability of `Array.prototype.sort`, which
 * preserves exactly the incidental order this is here to remove.
 *
 * Two elements that agree on both keys are byte-identical in the hashed form, so
 * which of them comes first cannot be observed.
 *
 * Returns a new array. The frozen public value it was handed is not touched.
 *
 * The tie-break key is built for every element, not only for the elements that
 * tie, so the snapshot is canonicalized about three times per revision instead
 * of once. Measured rather than argued, on this machine: 0.325 ms per revision
 * against the real snapshot (1 repository, 13 tasks) versus 0.110 ms for the
 * bare serialization, and 47.9 ms versus 16.3 ms at a synthetic 20 repositories
 * of 100 tasks. A poll runs every few seconds and spends far more than that
 * reading the files in the first place, so the lazier version buys nothing worth
 * the extra state. If the numbers ever stop looking like this, they are the
 * thing to re-measure — not this comment.
 */
function bySetIdentity<T>(items: readonly T[], identityOf: (item: T) => readonly string[]): T[] {
  return items
    .map((item) => ({ item, identity: identityOf(item), form: canonicalJson(item) }))
    .sort(
      (left, right) =>
        compareIdentities(left.identity, right.identity) || compareCodeUnits(left.form, right.form),
    )
    .map((entry) => entry.item);
}

/**
 * The public snapshot rewritten into the form the revision is taken over.
 *
 * Every `SET` array is put into its membership order, and nothing else changes.
 *
 * It SPREADS the body rather than rebuilding it from a list of field names, and
 * that is the whole difference between a normalisation and a quiet exclusion.
 * Naming the fields read better and was wrong: a later slice adding one public
 * field would have served it to the browser and left it outside the token — the
 * phone would hold a value that changed and be answered 304 forever. Worse for
 * a new ARRAY, which would be absent from the hash entirely while
 * {@link PUBLIC_ARRAY_SEMANTICS} and its test both certified it as declared.
 * Measured on a patched copy: an optional new field needed no test edit at all
 * and produced no compiler error.
 *
 * The return type is the body type for the same reason. Coverage is now the
 * compiler's to check rather than a sentence in this comment, and a field that
 * stops being carried stops compiling.
 *
 * This value is never served. The browser keeps AO's decided presentation order
 * — repositories in canonical-root order, tasks in task-id order — and that
 * separation is the point of the function: presentation order is a choice the
 * UI may change without every phone in the house re-downloading the world.
 */
function revisionInput(
  body: Omit<PublicSnapshot, 'observedAt' | 'revision'>,
): Omit<PublicSnapshot, 'observedAt' | 'revision'> {
  const repositories = bySetIdentity(
    body.repositories.map((repository) => ({
      ...repository,
      tasks: bySetIdentity(repository.tasks, (task) => [task.taskId]),
    })),
    (repository) => [repository.repositoryKey],
  );

  return {
    ...body,
    repositories,
    needsOperator: bySetIdentity(body.needsOperator, (entry) => [entry.repositoryKey, entry.taskId]),
    notes: bySetIdentity(body.notes, (note) => [
      note.code,
      note.repositoryKey ?? '',
      note.taskId ?? '',
      note.detail ?? '',
    ]),
  };
}

/**
 * The change token for a public snapshot.
 *
 * Hashes the canonical form of everything the browser will be shown, with
 * `observedAt` removed — that field changes on every poll and means nothing
 * changed. `revision` itself is absent because it is what is being computed.
 *
 * It is a hash of the public *meaning*, not of the public *bytes*. Collection
 * arrays are put into membership order first, so two bodies holding the same
 * members answer one token whatever order they were built in. Serving order is
 * untouched; see {@link PUBLIC_ARRAY_SEMANTICS} for why each array may be
 * treated this way, and the module header for why this is a property of the
 * token rather than a fix for a shuffle today's producer can emit.
 *
 * The consequence worth stating: this describes the PUBLIC representation. An
 * internal-only change — a canonical root that moved, a pid that differs — does
 * not move it unless it changes something a reader is shown. That is the
 * intended behaviour of an ETag and is pinned in both directions.
 *
 * ── A note the HTTP slice must not miss ──────────────────────────────────
 *
 * This is deliberately a WEAK validator in the sense of RFC 9110 §8.8.1: it
 * equates representations whose bytes differ. `observedAt` is excluded and
 * member order is normalised, so two responses can carry one revision and not be
 * byte-identical. An entity-tag derived from it must therefore be emitted in the
 * weak form, `W/"<revision>"`, and must not be used to validate a Range request.
 * Emitting it as a strong ETag would be a claim about bytes that this value does
 * not make.
 */
export function revisionOf(body: Omit<PublicSnapshot, 'observedAt' | 'revision'>): string {
  return createHash('sha256').update(canonicalJson(revisionInput(body)), 'utf8').digest('hex');
}

/* ── the projection ────────────────────────────────────────────────────────── */

function publicRuntime(task: TaskSnapshot): PublicRuntimeReading {
  const runtime = task.runtime;
  if (runtime.reading === 'NONE') return Object.freeze({ reading: 'NONE' as const });
  if (runtime.reading === 'UNREADABLE') {
    return Object.freeze({ reading: 'UNREADABLE' as const, code: runtime.code });
  }
  const facts = runtime.facts;
  return Object.freeze({
    reading: 'LOADED' as const,
    state: facts.state,
    stateKind: facts.stateKind,
    stateEnteredAt: facts.stateEnteredAt,
    recordedPhaseAgent: facts.recordedPhaseAgent,
    workBranch: facts.workBranch,
    recordedCurrentCommit: facts.recordedCurrentCommit,
    reviewRound: facts.reviewRound,
    reviewBudget: facts.reviewBudget,
    blockedAgent: facts.blockedAgent,
    reportedResetAt: facts.reportedResetAt,
  });
}

function publicVerification(task: TaskSnapshot): PublicVerificationReading {
  const verification = task.verification;
  if (verification.reading === 'NONE') return Object.freeze({ reading: 'NONE' as const });
  if (verification.reading === 'UNREADABLE') {
    return Object.freeze({ reading: 'UNREADABLE' as const, code: verification.code });
  }
  return Object.freeze({
    reading: 'RECORDED' as const,
    lastAttempt: verification.lastAttempt,
    passRecordedForCommit: verification.lastPass?.forCommit ?? null,
    passMeasuredAt: verification.lastPass?.measuredAt ?? null,
  });
}

/**
 * One task, projected.
 *
 * `operational` is copied, never recomputed. The only judgement made here is
 * which tasks may carry an operator sentence, and that judgement is a read of
 * the internal classification rather than a second opinion about it.
 */
function publicTask(task: TaskSnapshot): PublicTask {
  const action =
    task.operational === 'ACTIONABLE' && task.attention.reading === 'OPERATOR_REQUIRED'
      ? Object.freeze({ reason: task.attention.reason, text: task.attention.action })
      : null;

  return Object.freeze({
    taskId: task.taskId,
    declaration: task.declaration,
    runtime: publicRuntime(task),
    operational: task.operational,
    action,
    verification: publicVerification(task),
    delivery: task.delivery,
  });
}

function publicRepository(repository: RepositorySnapshot): PublicRepository {
  const profile: PublicProfileReading =
    repository.profile.reading === 'DECLARED'
      ? Object.freeze({
          reading: 'DECLARED' as const,
          repositoryId: repository.profile.repositoryId,
          defaultBranch: repository.profile.defaultBranch,
          maxReviewRounds: repository.profile.maxReviewRounds,
        })
      : Object.freeze({ reading: 'UNUSABLE' as const, code: repository.profile.code });

  const declaredTasks: PublicDeclaredTaskReading =
    repository.declaredTasks.reading === 'DISCOVERED'
      ? Object.freeze({ reading: 'DISCOVERED' as const, count: repository.declaredTasks.tasks.length })
      : repository.declaredTasks.reading === 'REFUSED'
        ? Object.freeze({
            reading: 'REFUSED' as const,
            code: repository.declaredTasks.code,
            taskId: repository.declaredTasks.taskId,
          })
        : Object.freeze({ reading: 'NOT_ATTEMPTED' as const, why: repository.declaredTasks.why });

  // The errno is dropped: it names a machine condition, and the distinction a
  // reader needs — absent versus could-not-look — is the reading itself.
  const runtimeScan: PublicRuntimeScanReading =
    repository.runtimeScan.reading === 'READ'
      ? Object.freeze({
          reading: 'READ' as const,
          stateFileCount: repository.runtimeScan.stateFileCount,
          truncated: repository.runtimeScan.truncated,
        })
      : repository.runtimeScan.reading === 'DIRECTORY_ABSENT'
        ? Object.freeze({ reading: 'DIRECTORY_ABSENT' as const })
        : Object.freeze({ reading: 'DIRECTORY_UNREADABLE' as const });

  const lease: PublicLeaseReading =
    repository.lease.reading === 'FREE'
      ? Object.freeze({ reading: 'FREE' as const })
      : repository.lease.reading === 'HELD'
        ? Object.freeze({
            reading: 'HELD' as const,
            acquiredAt: repository.lease.acquiredAt,
            ownerLiveness: repository.lease.ownerLiveness,
          })
        : repository.lease.reading === 'OTHER'
          ? Object.freeze({ reading: 'OTHER' as const, state: repository.lease.state })
          : Object.freeze({ reading: 'NOT_OBSERVED' as const, why: repository.lease.why });

  return Object.freeze({
    repositoryKey: repositoryKeyFor(repository.canonicalRoot),
    profile,
    declaredTasks,
    runtimeScan,
    lease,
    tasks: Object.freeze(repository.tasks.map((task) => publicTask(task))),
  });
}

/** Deterministic, and by the public key so the order cannot depend on a path. */
function compareByKeyThenTask(
  left: { readonly repositoryKey: string | null; readonly taskId: string | null },
  right: { readonly repositoryKey: string | null; readonly taskId: string | null },
): number {
  const leftKey = left.repositoryKey ?? '';
  const rightKey = right.repositoryKey ?? '';
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  const leftTask = left.taskId ?? '';
  const rightTask = right.taskId ?? '';
  if (leftTask !== rightTask) return leftTask < rightTask ? -1 : 1;
  return 0;
}

function publicNote(note: ReadingNote, keyOf: (root: string) => string): PublicReadingNote {
  return Object.freeze({
    code: note.code,
    repositoryKey: note.repositoryRoot === null ? null : keyOf(note.repositoryRoot),
    taskId: note.taskId,
    detail: note.detail,
  });
}

function publicNeedsOperator(
  entry: NeedsOperatorEntry,
  keyOf: (root: string) => string,
): PublicNeedsOperatorEntry {
  return Object.freeze({
    repositoryKey: keyOf(entry.repositoryRoot),
    taskId: entry.taskId,
    reason: entry.reason,
    text: entry.action,
  });
}

/**
 * Projects an internal snapshot into the public contract.
 *
 * Pure: no I/O, no clock, no process, no network. Everything it needs is in the
 * value it was handed, which is what makes it safe to say that it adds no
 * authority — there is nothing it could consult to form an opinion with.
 */
export function toPublicSnapshot(internal: DashboardSnapshot): PublicSnapshot {
  const keyOf = (root: string): string => repositoryKeyFor(root);

  const registry: PublicRegistryReading =
    internal.registry.reading === 'REGISTERED'
      ? Object.freeze({
          reading: 'REGISTERED' as const,
          entryCount: internal.registry.entryCount,
          maxConcurrentRepositories: internal.registry.maxConcurrentRepositories,
        })
      : internal.registry.reading === 'NOT_REGISTERED'
        ? Object.freeze({ reading: 'NOT_REGISTERED' as const })
        : Object.freeze({ reading: 'UNUSABLE' as const, code: internal.registry.code });

  // Repositories keep the order the internal model decided — AO's canonical-root
  // ordering, applied while the roots still existed. Re-sorting by the public
  // key would replace a meaningful order with the output of a hash. The revision
  // does not depend on this order; see PUBLIC_ARRAY_SEMANTICS.
  const repositories = internal.repositories.map((repository) => publicRepository(repository));

  const needsOperator = internal.needsOperator
    .map((entry) => publicNeedsOperator(entry, keyOf))
    .sort(compareByKeyThenTask);

  const notes = internal.notes
    .map((note) => publicNote(note, keyOf))
    .sort((left, right) => {
      if (left.code !== right.code) return left.code < right.code ? -1 : 1;
      const bySubject = compareByKeyThenTask(left, right);
      if (bySubject !== 0) return bySubject;
      const leftDetail = left.detail ?? '';
      const rightDetail = right.detail ?? '';
      return leftDetail < rightDetail ? -1 : leftDetail > rightDetail ? 1 : 0;
    });

  const body = {
    registry,
    repositories: Object.freeze(repositories),
    needsOperator: Object.freeze(needsOperator),
    notes: Object.freeze(notes),
  };

  return Object.freeze({
    observedAt: internal.observedAt,
    revision: revisionOf(body),
    ...body,
  });
}
