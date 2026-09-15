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
 * A deterministic serialization: object keys sorted, arrays left in place.
 *
 * Array order is NOT sorted here, because the orders that matter are already
 * decided upstream and are meaningful — repositories in AO's canonical-root
 * order, tasks in AO's task-id order — and re-sorting them by their serialized
 * form would replace a decided order with an accidental one. What this removes
 * is only the one thing that carries no meaning: the order a key happened to be
 * assigned in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * The change token for a public snapshot.
 *
 * Hashes the canonical form of everything the browser will be shown, with
 * `observedAt` removed — that field changes on every poll and means nothing
 * changed. `revision` itself is absent because it is what is being computed.
 *
 * The consequence worth stating: this describes the PUBLIC representation. An
 * internal-only change — a canonical root that moved, a pid that differs — does
 * not move it unless it changes something a reader is shown. That is the
 * intended behaviour of an ETag and is pinned in both directions.
 */
export function revisionOf(body: Omit<PublicSnapshot, 'observedAt' | 'revision'>): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
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
  // key would replace a meaningful order with the output of a hash.
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
