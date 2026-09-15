/**
 * The dashboard read model — one observation of everything AO has written down.
 *
 * ── What this is, and what it may never become ─────────────────────────────
 *
 * An observer. It composes readers that already exist and adds no authority of
 * its own: it acquires no execution lease, advances no state machine, writes no
 * byte, starts no process and contacts no network. If this module is never
 * called, AO behaves exactly as it does today; if it is called every few
 * seconds, AO must still behave exactly as it does today. That second sentence
 * is the harder one, and the constraints below are what buy it.
 *
 * ── Why a poll may not start a process ─────────────────────────────────────
 *
 * `resolveRepository` runs five `git` children plus a delivery-target read, and
 * `observeRuntime` runs `git status` *inside a worktree a writer may be using*.
 * At a few-second cadence across several repositories that is not observation,
 * it is load — and the `git status` case can make Git rewrite that worktree's
 * own index. So the normal path here reads files and nothing else. Facts that
 * genuinely need Git belong to an on-request slice, and are named as recorded
 * claims here rather than quietly observed.
 *
 * ── Why a poll may not hold a file handle ──────────────────────────────────
 *
 * Measured on this project's own NTFS volume, 2000 iterations against AO's real
 * `temp -> fsync -> close -> renameSync` replacement:
 *
 *   polling reader, open-read-close   2000 renames, 0 failures, 0 torn reads
 *   reader that HOLDS its handle      50 attempts, 50 failures, all EPERM
 *
 * A reader that keeps a handle open across AO's rename makes AO's durable write
 * fail. So every read here is one bounded open-read-close, and no handle
 * survives a call. That is a statement about the measured behaviour of these
 * calls on this system, and deliberately not a general claim about Windows
 * share modes.
 *
 * ── One clock ──────────────────────────────────────────────────────────────
 *
 * Every time-sensitive derivation in one snapshot is given the same `now`. AO's
 * own attention modules take `now` as an argument for exactly this reason: two
 * tasks parked on the same quota reset must not disagree about whether it has
 * passed because one of them was judged a millisecond later.
 *
 * ── Absent, unreadable and false are three different answers ───────────────
 *
 * Every reading below keeps them apart, because AO does. A directory that could
 * not be read is not a repository with no tasks, a task whose record will not
 * parse is not a task that never started, and a lease that was not observed is
 * not proof that nothing is running. Collapsing any of those produces a calm,
 * confident, wrong dashboard — which is worse than none.
 */

import { readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { AGENT_PHASES } from '../core/agent-phases.js';
import { getStateKind, type AgentId, type StateKind, type TaskStateName } from '../core/states.js';
import { attentionForTaskState, type AttentionReason } from '../core/task-attention.js';
import { reviewBudget } from '../core/review-budget.js';
import type { TaskState } from '../core/task-state.js';
import { loadDeliveryConclusion } from '../deliver/delivery-conclusion-store.js';
import { loadMergeReconciliation } from '../deliver/merge-reconciliation-store.js';
import { discoverTasks } from '../plan/discover-tasks.js';
import { compareTaskIds, isValidTaskId } from '../plan/task-id.js';
import {
  compareRepositoryRoots,
  loadRepositoryRegistry,
  type RepositoryRegistryOutcome,
} from '../registry/repository-registry.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { readDeclaredProfile } from '../repo/declared-identity.js';
import { MAX_SCANNED_STATE_FILES_PER_REPOSITORY } from '../schedule/durable-wake.js';
import { loadTaskState } from '../state/state-store.js';
import {
  TASK_STATE_FILE_EXTENSION,
  isStateFileName,
  taskRuntimeDirectory,
} from '../state/state-location.js';
import {
  latestVerificationAttempt,
  loadVerificationAttempts,
} from '../verify/verification-attempt-store.js';
import { loadVerificationPass } from '../verify/verification-pass-store.js';
import {
  inspectRepositoryExecutionLease,
  type LeaseInspection,
} from '../lease/execution-lease.js';

/* ── reading notes ─────────────────────────────────────────────────────────── */

/**
 * The closed vocabulary of things one observation could not establish.
 *
 * A note is never decoration. Each one exists because some field below would
 * otherwise have to carry a value that looks like an answer.
 */
export const READING_NOTE_CODES = [
  /** The registry file itself could not be used. No repository was read. */
  'REGISTRY_UNUSABLE',
  /** A declared path could not be canonicalised without Git. */
  'REPOSITORY_ROOT_UNRESOLVABLE',
  /** Two declared entries canonicalised to one root; the later one was dropped. */
  'REPOSITORY_ROOT_DUPLICATE',
  /** The committed profile could not be read or did not satisfy the contract. */
  'PROFILE_UNUSABLE',
  /** Declared-task discovery refused. NOT an empty task list. */
  'TASK_DISCOVERY_REFUSED',
  /** The runtime directory exists and could not be listed. */
  'RUNTIME_DIRECTORY_UNREADABLE',
  /** More state files than one observation reads. The list is a prefix. */
  'RUNTIME_SCAN_TRUNCATED',
  /** One task's durable record would not load. The task is still listed. */
  'TASK_STATE_UNREADABLE',
  /** A delivery reader threw. That task's delivery position is unknown. */
  'DELIVERY_READER_THREW',
  /** A verification reader threw. That task's verification evidence is unknown. */
  'VERIFICATION_READER_THREW',
  /** The Git directory could not be named without Git, so no lease was sought. */
  'LEASE_LOCATION_UNDETERMINED',
  /** Inspecting the lease threw. */
  'LEASE_READER_THREW',
] as const;

export type ReadingNoteCode = (typeof READING_NOTE_CODES)[number];

export interface ReadingNote {
  readonly code: ReadingNoteCode;
  /** The repository this concerns, by canonical root, or `null` for the whole reading. */
  readonly repositoryRoot: string | null;
  /** The task this concerns, or `null`. */
  readonly taskId: string | null;
  /** A closed code from the failing reader, never an exception message. */
  readonly detail: string | null;
}

/* ── registry ──────────────────────────────────────────────────────────────── */

export type RegistryReading =
  | {
      readonly reading: 'REGISTERED';
      /** sha256 over the exact bytes. The only change token the registry offers. */
      readonly digest: string;
      readonly entryCount: number;
      readonly maxConcurrentRepositories: number;
    }
  | { readonly reading: 'NOT_REGISTERED' }
  | { readonly reading: 'UNUSABLE'; readonly code: string };

/* ── profile ───────────────────────────────────────────────────────────────── */

export type ProfileReading =
  | {
      readonly reading: 'DECLARED';
      /** The profile's declared id. A slug, and NOT a unique key. */
      readonly repositoryId: string;
      readonly defaultBranch: string;
      readonly taskSourcePath: string;
      readonly maxReviewRounds: number;
    }
  | { readonly reading: 'UNUSABLE'; readonly code: string };

/* ── declared tasks ────────────────────────────────────────────────────────── */

/**
 * Declared-task discovery is all-or-nothing, and that shapes this type.
 *
 * `discoverTasks` stops at the first unusable task file and returns no tasks, so
 * a refusal cannot be rendered as "this repository has no tasks". An empty
 * source directory is likewise its own refusal (`TASK_SOURCE_EMPTY`) rather than
 * an empty list, deliberately, so that "nothing was found" can never be read as
 * "everything is finished". Both arrive here as `REFUSED`, with the code.
 */
export type DeclaredTaskReading =
  | { readonly reading: 'DISCOVERED'; readonly taskIds: readonly string[] }
  | { readonly reading: 'REFUSED'; readonly code: string; readonly taskId: string | null }
  | { readonly reading: 'NOT_ATTEMPTED'; readonly why: 'PROFILE_UNUSABLE' };

/* ── runtime scan ──────────────────────────────────────────────────────────── */

export type RuntimeScanReading =
  | { readonly reading: 'READ'; readonly stateFileCount: number; readonly truncated: boolean }
  /** No runtime directory. Ordinary: nothing has ever run here. */
  | { readonly reading: 'DIRECTORY_ABSENT' }
  /** A directory is there and could not be listed. NOT the same as absent. */
  | { readonly reading: 'DIRECTORY_UNREADABLE'; readonly errnoCode: string | null };

/* ── one task ──────────────────────────────────────────────────────────────── */

/**
 * What AO's durable record says about a task, and nothing more.
 *
 * Every field whose name could be mistaken for a fresh observation carries
 * `recorded` in it. That is not decoration either: `recordedCurrentCommit` is
 * what the last checkpoint wrote, and whether the worktree is still at that
 * commit is a question only Git answers.
 */
export interface RuntimeTaskFacts {
  readonly state: TaskStateName;
  readonly stateKind: StateKind;
  /** The instant the record entered this state. Not a heartbeat, not a duration. */
  readonly stateEnteredAt: string;
  /** sha256 of the bytes read. A change token for the next poll. */
  readonly revision: string;
  /**
   * The agent this phase runs, derived from the state name alone.
   *
   * A RECORDED phase, never a running process: a record saying `IMPLEMENTING` is
   * byte-identical whether a writer is thinking or the orchestrator died an hour
   * ago. Liveness, so far as anything can say it, is the lease reading — and
   * that is a different field on a different object for that reason.
   */
  readonly recordedPhaseAgent: AgentId | null;
  readonly workBranch: string;
  /** A path the record claims. Not verified to exist. */
  readonly recordedWorktreePath: string;
  /** The commit the last checkpoint recorded. NOT an observation of HEAD. */
  readonly recordedCurrentCommit: string | null;
  readonly reviewRound: number;
  readonly reviewBudget: number;
  readonly blockedAgent: AgentId | null;
  /** Only meaningful on a quota block. Render verbatim, never as "in 3 hours". */
  readonly reportedResetAt: string | null;
}

/**
 * Whether a person has to do something, derived live from the durable record.
 *
 * `AUTOMATIC_WAIT` is the distinction that matters most on a phone. A task
 * parked on a quota limit whose reset the machine can still wait out needs
 * nobody, and putting it in front of an operator trains them to ignore the list.
 * The judgement is not made here: `attentionForTaskState` already asks
 * `usageLimitContinuation` and answers SILENT exactly when the machine still
 * owns the block. Re-deciding it here would be a second opinion that drifts.
 */
export type AttentionReading =
  | { readonly reading: 'NONE' }
  | { readonly reading: 'AUTOMATIC_WAIT'; readonly until: string | null }
  | {
      readonly reading: 'OPERATOR_REQUIRED';
      readonly reason: AttentionReason;
      readonly action: string;
      readonly detail: string | null;
    };

/**
 * Verification evidence, stated as what is on disk and never as a verdict about
 * the worktree now.
 *
 * `PASS_RECORDED` means a pass was written for a named commit. It does **not**
 * mean this worktree is at that commit, and the difference is the whole point:
 * proving the second needs a fresh `git rev-parse` in a tree a writer may be
 * using, which the normal poll will not do. A later on-request slice may join
 * the two; until then the dashboard says what it can prove.
 */
export interface VerificationAttemptFacts {
  readonly verdict: string;
  readonly attemptedAt: string;
  /** The commit the attempt was ABOUT, as recorded. Not an observation. */
  readonly forCommit: string;
  readonly stoppedAtPhase: string | null;
  readonly exitCode: number | null;
}

export interface VerificationPassFacts {
  /** The commit the pass was recorded FOR. Not an observation of HEAD. */
  readonly forCommit: string;
  readonly measuredAt: string;
}

/**
 * Verification evidence, stated as what is on disk and never as a verdict about
 * the worktree now.
 *
 * Both halves are carried, and that is deliberate. A task can have a recorded
 * failure AND a recorded pass — the stores are separate, a pass is never written
 * into the attempt history, and which one is *standing* depends on a precedence
 * rule (`verificationStatement`) that needs an observed HEAD this poll will not
 * take. Returning only one of them would be this module quietly deciding that
 * question with less evidence than the module that owns it.
 *
 * So neither is called "verified". `lastPass.forCommit` means a pass was
 * recorded for that commit; whether the worktree is still at it is a question
 * for an on-request slice.
 */
export type VerificationReading =
  | { readonly reading: 'NONE' }
  | { readonly reading: 'UNREADABLE'; readonly code: string }
  | {
      readonly reading: 'RECORDED';
      readonly lastAttempt: VerificationAttemptFacts | null;
      readonly lastPass: VerificationPassFacts | null;
    };

/** Delivery position, from disk alone. No forge was contacted. */
export type DeliveryReading =
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
 * Whether a task is declared — and the third answer, which is the point.
 *
 * `UNDETERMINED` exists because declared-task discovery is all-or-nothing: one
 * unusable task file refuses the whole source and returns nothing. Folding that
 * into `NOT_DECLARED` would turn "I could not read the declarations" into the
 * specific, unsupported claim "this task has no declaration" — for every task in
 * the repository at once. That is the unknown-as-false translation this model
 * exists to refuse, and it is one `?:` away at all times.
 */
export type DeclarationReading = 'DECLARED' | 'NOT_DECLARED' | 'UNDETERMINED';

export interface TaskSnapshot {
  readonly taskId: string;
  /**
   * Whether the task appears in a successful declared-task discovery.
   *
   * Independent of {@link runtime}. A task file may exist with no durable state
   * (never started), and a durable state may exist whose declaration is gone or
   * could not be joined — that task stays listed rather than vanishing.
   *
   * Note what is NOT here: `TaskDefinition.status`. That field is `OPEN`/`DONE`
   * and belongs to the dependency contract; a task file may legitimately say
   * `OPEN` while its durable state says `READY_FOR_PR`, because the file flip
   * lands in the delivery pull request. Nothing about progress is read from it.
   */
  readonly declared: DeclarationReading;
  readonly runtime: RuntimeTaskReading;
  readonly attention: AttentionReading;
  readonly verification: VerificationReading;
  readonly delivery: DeliveryReading;
}

export type RuntimeTaskReading =
  /** No durable record. For a declared task this is "never started" — not QUEUED. */
  | { readonly reading: 'NONE' }
  | {
      readonly reading: 'UNREADABLE';
      readonly code: string;
      readonly classification: string;
    }
  | { readonly reading: 'LOADED'; readonly facts: RuntimeTaskFacts };

/* ── lease ─────────────────────────────────────────────────────────────────── */

/**
 * The lease, as a diagnostic momentary reading.
 *
 * What this may never become is a claim about the orchestrator as a whole. AO
 * writes no pidfile, no heartbeat and no daemon record, so "no lease was
 * observed" cannot be turned into "AgentOrchestrator is not running" — it means
 * only that nothing owns this one repository at the instant of the read. A HELD
 * lease is equally momentary: the multi-repository paths remove a stale one
 * automatically, so a lease can disappear between two polls with no operator
 * involved.
 */
export type LeaseReading =
  | { readonly reading: 'FREE' }
  | {
      readonly reading: 'HELD';
      readonly ownerPid: number | null;
      readonly acquiredAt: string | null;
      readonly ownerLiveness: string;
      readonly runId: string | null;
    }
  | { readonly reading: 'OTHER'; readonly state: string }
  /** The Git directory could not be named without running Git. Nothing was sought. */
  | { readonly reading: 'NOT_OBSERVED'; readonly why: 'GIT_DIRECTORY_UNDETERMINED' };

/* ── repository and snapshot ───────────────────────────────────────────────── */

export interface RepositorySnapshot {
  /**
   * THE key, and never `repositoryId`.
   *
   * Two clones of one remote legitimately declare the same id and are two
   * independent execution domains; keying on the id would merge them into one
   * row and show one repository's work under the other's name.
   */
  readonly canonicalRoot: string;
  /** The path the registry declared, verbatim. For reporting, never identity. */
  readonly declaredPath: string;
  readonly profile: ProfileReading;
  readonly declaredTasks: DeclaredTaskReading;
  readonly runtimeScan: RuntimeScanReading;
  /** Declared and runtime tasks, joined by id, in canonical id order. */
  readonly tasks: readonly TaskSnapshot[];
  readonly lease: LeaseReading;
}

export interface DashboardSnapshot {
  /**
   * When this observation was taken, stamped here because AO stamps nothing.
   *
   * The same instant drives every time-sensitive derivation in the snapshot.
   */
  readonly observedAt: string;
  readonly registry: RegistryReading;
  /** In AO's own canonical-root order, never a locale collation. */
  readonly repositories: readonly RepositorySnapshot[];
  /** Everything this observation could not establish. Never silently empty. */
  readonly notes: readonly ReadingNote[];
}

/* ── seams ─────────────────────────────────────────────────────────────────── */

/**
 * Injectable dependencies. Production supplies all of them; tests replace one.
 *
 * They exist because the properties worth pinning are failure properties — an
 * unreadable directory, a record that will not parse, a reader that throws —
 * and none of those can be provoked on demand against a real filesystem.
 */
export interface ReadModelSeams {
  readonly now?: () => Date;
  readonly pathProvider?: PathProvider;
  readonly loadRegistry?: typeof loadRepositoryRegistry;
  readonly realpath?: (path: string) => string;
  readonly readDirectory?: (path: string) => readonly string[];
  readonly loadState?: typeof loadTaskState;
  readonly inspectLease?: typeof inspectRepositoryExecutionLease;
}

/* ── the observation ───────────────────────────────────────────────────────── */

function note(
  code: ReadingNoteCode,
  repositoryRoot: string | null,
  taskId: string | null,
  detail: string | null,
): ReadingNote {
  return Object.freeze({ code, repositoryRoot, taskId, detail });
}

/** An errno from a caught value, allow-listed shape only, never a message. */
function errnoOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * The Git directory, named without running Git, or `null`.
 *
 * Deliberately narrow. `<root>/.git` as a real directory is the ordinary
 * checkout, and that case is answered. A `.git` *file* is a linked worktree
 * whose real common directory is written inside it, and resolving that would be
 * this module forming a second opinion about a question `git rev-parse
 * --git-common-dir` owns. So it refuses instead, and the lease reads
 * NOT_OBSERVED — which is honest, and is not "no lease".
 */
function gitDirectoryWithoutGit(
  root: string,
  readDirectory: (path: string) => readonly string[],
): string | null {
  const candidate = resolvePath(join(root, '.git'));
  try {
    // A listing succeeds only for a directory, which is exactly the case this
    // function answers; a `.git` file throws ENOTDIR and is refused.
    readDirectory(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** One repository's lease, or an honest refusal to say. */
function readLease(
  root: string,
  repositoryId: string | null,
  seams: Required<Pick<ReadModelSeams, 'readDirectory' | 'inspectLease'>>,
  notes: ReadingNote[],
): LeaseReading {
  const gitCommonDir = gitDirectoryWithoutGit(root, seams.readDirectory);
  if (gitCommonDir === null) {
    notes.push(note('LEASE_LOCATION_UNDETERMINED', root, null, null));
    return Object.freeze({ reading: 'NOT_OBSERVED' as const, why: 'GIT_DIRECTORY_UNDETERMINED' as const });
  }

  let inspection: LeaseInspection;
  try {
    inspection = seams.inspectLease({ gitCommonDir, root, id: repositoryId ?? root });
  } catch (error) {
    notes.push(note('LEASE_READER_THREW', root, null, errnoOf(error)));
    return Object.freeze({ reading: 'NOT_OBSERVED' as const, why: 'GIT_DIRECTORY_UNDETERMINED' as const });
  }

  if (inspection.state === 'FREE') return Object.freeze({ reading: 'FREE' as const });
  if (inspection.state === 'HELD') {
    return Object.freeze({
      reading: 'HELD' as const,
      ownerPid: inspection.ownerPid,
      acquiredAt: inspection.acquiredAt,
      ownerLiveness: inspection.liveness,
      runId: inspection.runId,
    });
  }
  return Object.freeze({ reading: 'OTHER' as const, state: inspection.state });
}

/** The declared tasks, or the refusal — never an empty list standing in for one. */
function readDeclaredTasks(
  root: string,
  profile: ProfileReading,
  notes: ReadingNote[],
): DeclaredTaskReading {
  if (profile.reading !== 'DECLARED') {
    return Object.freeze({ reading: 'NOT_ATTEMPTED' as const, why: 'PROFILE_UNUSABLE' as const });
  }

  const discovered = discoverTasks({ root, taskSource: { path: profile.taskSourcePath } });
  if (!discovered.ok) {
    notes.push(note('TASK_DISCOVERY_REFUSED', root, discovered.taskId, discovered.code));
    return Object.freeze({
      reading: 'REFUSED' as const,
      code: discovered.code,
      taskId: discovered.taskId,
    });
  }
  return Object.freeze({
    reading: 'DISCOVERED' as const,
    taskIds: Object.freeze(discovered.tasks.map((task) => task.id)),
  });
}

/** Task ids with a durable record, bounded and filtered by AO's own predicate. */
function scanRuntimeTaskIds(
  root: string,
  readDirectory: (path: string) => readonly string[],
  notes: ReadingNote[],
): { readonly scan: RuntimeScanReading; readonly taskIds: readonly string[] } {
  const directory = taskRuntimeDirectory(root);

  let entries: readonly string[];
  try {
    entries = readDirectory(directory);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') {
      return { scan: Object.freeze({ reading: 'DIRECTORY_ABSENT' as const }), taskIds: [] };
    }
    notes.push(note('RUNTIME_DIRECTORY_UNREADABLE', root, null, code));
    return {
      scan: Object.freeze({ reading: 'DIRECTORY_UNREADABLE' as const, errnoCode: code }),
      taskIds: [],
    };
  }

  // AO's own predicate, not a glob. A crashed writer's `<id>.json.tmp-<suffix>`
  // staging file is excluded structurally by it — not because it is unlikely to
  // be seen, but because the name can never satisfy the grammar.
  const names = entries.filter((name) => isStateFileName(name)).sort();
  const truncated = names.length > MAX_SCANNED_STATE_FILES_PER_REPOSITORY;
  if (truncated) notes.push(note('RUNTIME_SCAN_TRUNCATED', root, null, null));
  const kept = truncated ? names.slice(0, MAX_SCANNED_STATE_FILES_PER_REPOSITORY) : names;

  return {
    scan: Object.freeze({ reading: 'READ' as const, stateFileCount: kept.length, truncated }),
    taskIds: Object.freeze(
      kept.map((name) => name.slice(0, name.length - TASK_STATE_FILE_EXTENSION.length)),
    ),
  };
}

/** The durable facts, projected. Nothing here is an observation of the world. */
function factsOf(state: TaskState, revision: string): RuntimeTaskFacts {
  const phase = AGENT_PHASES[state.state];
  return Object.freeze({
    state: state.state,
    stateKind: getStateKind(state.state),
    stateEnteredAt: state.stateEnteredAt,
    revision,
    recordedPhaseAgent: phase?.agent ?? null,
    workBranch: state.workBranch,
    recordedWorktreePath: state.worktreePath,
    recordedCurrentCommit: state.currentCommit,
    reviewRound: state.reviewRound,
    reviewBudget: reviewBudget(state),
    blockedAgent: state.blockedAgent,
    reportedResetAt: state.reportedResetAt,
  });
}

/** Whether a person is needed — AO's own judgement, not a second one. */
function attentionOf(state: TaskState, now: Date): AttentionReading {
  const judged = attentionForTaskState(state, now);
  if (judged.attention) {
    return Object.freeze({
      reading: 'OPERATOR_REQUIRED' as const,
      reason: judged.reason,
      action: judged.action,
      detail: judged.detail,
    });
  }
  // Silent. For a quota block that means the machine still owns it: a reset is
  // recorded and has not passed, so nobody needs to act. Every other silent
  // state is simply not waiting on anything.
  if (state.state === 'BLOCKED_USAGE_LIMIT') {
    return Object.freeze({ reading: 'AUTOMATIC_WAIT' as const, until: state.reportedResetAt });
  }
  return Object.freeze({ reading: 'NONE' as const });
}

/** Verification evidence on disk. Never a verdict about the worktree now. */
function verificationOf(root: string, taskId: string, notes: ReadingNote[]): VerificationReading {
  try {
    const attempts = loadVerificationAttempts(root, taskId);
    const latest = latestVerificationAttempt(attempts);
    const lastAttempt: VerificationAttemptFacts | null =
      latest === null
        ? null
        : Object.freeze({
            verdict: latest.verdict,
            attemptedAt: latest.attemptedAt,
            forCommit: latest.subjectCommit,
            stoppedAtPhase: latest.stoppedAt,
            exitCode: latest.phases[latest.phases.length - 1]?.exitCode ?? null,
          });

    const pass = loadVerificationPass(root, taskId);
    const lastPass: VerificationPassFacts | null =
      pass.reading === 'PASS_RECORD' && pass.record !== null
        ? Object.freeze({
            forCommit: pass.record.subjectCommit,
            measuredAt: pass.record.measuredAt,
          })
        : null;

    // A store that exists and cannot be read is not a store with nothing in it.
    if (lastPass === null && pass.reading !== 'ABSENT') {
      return Object.freeze({ reading: 'UNREADABLE' as const, code: pass.reading });
    }
    if (lastAttempt === null && attempts.reading !== 'ABSENT' && attempts.reading !== 'ATTEMPT_HISTORY') {
      return Object.freeze({ reading: 'UNREADABLE' as const, code: attempts.reading });
    }

    if (lastAttempt === null && lastPass === null) {
      return Object.freeze({ reading: 'NONE' as const });
    }
    return Object.freeze({ reading: 'RECORDED' as const, lastAttempt, lastPass });
  } catch (error) {
    notes.push(note('VERIFICATION_READER_THREW', root, taskId, errnoOf(error)));
    return Object.freeze({ reading: 'UNREADABLE' as const, code: 'READER_THREW' });
  }
}

/**
 * Delivery position from disk.
 *
 * `concludeDeliveryForTask` is deliberately not called: it needs the forge host,
 * owner and name, which come from a resolved delivery target and therefore from
 * `git remote get-url`. The two durable stores answer the same question for a
 * dashboard's purposes and need only a root and a task id.
 *
 * The whole body is guarded anyway. A reader that throws must cost this task its
 * delivery position and nothing else — not the repository, and not the snapshot.
 */
function deliveryOf(root: string, taskId: string, notes: ReadingNote[]): DeliveryReading {
  const subject = { taskId, repositoryRoot: root };
  try {
    const concluded = loadDeliveryConclusion(root, taskId, subject);
    if (concluded.reading === 'DELIVERY_CONCLUDED' && concluded.conclusion !== null) {
      return Object.freeze({
        reading: 'DELIVERY_CONCLUDED' as const,
        pullRequestNumber: concluded.conclusion.pullRequestNumber,
        mergeCommit: concluded.conclusion.mergeCommit,
        concludedAt: concluded.conclusion.concludedAt,
      });
    }

    const merged = loadMergeReconciliation(root, taskId, subject);
    if (merged.reading === 'HISTORICAL_MERGE' && merged.receipt !== null) {
      return Object.freeze({
        reading: 'MERGE_RECORDED' as const,
        pullRequestNumber: merged.receipt.pullRequestNumber,
        mergeCommit: merged.receipt.mergeCommit,
        baseRef: merged.receipt.baseRef,
      });
    }

    if (concluded.reading !== 'ABSENT' && concluded.reading !== 'DELIVERY_CONCLUDED') {
      return Object.freeze({ reading: 'UNKNOWN' as const, why: concluded.reading });
    }
    return Object.freeze({ reading: 'NONE' as const });
  } catch (error) {
    notes.push(note('DELIVERY_READER_THREW', root, taskId, errnoOf(error)));
    return Object.freeze({ reading: 'UNKNOWN' as const, why: 'READER_THREW' });
  }
}

/** One repository, observed. A failure here costs this repository and no other. */
function readRepository(
  declaredPath: string,
  canonicalRoot: string,
  now: Date,
  seams: Required<Pick<ReadModelSeams, 'readDirectory' | 'loadState' | 'inspectLease'>>,
  notes: ReadingNote[],
): RepositorySnapshot {
  const declared = readDeclaredProfile(canonicalRoot);
  const profile: ProfileReading = declared.ok
    ? Object.freeze({
        reading: 'DECLARED' as const,
        repositoryId: declared.profile.repository.id,
        defaultBranch: declared.profile.repository.defaultBranch,
        taskSourcePath: declared.profile.taskSource.path,
        maxReviewRounds: declared.profile.completion.maxReviewRounds,
      })
    : Object.freeze({ reading: 'UNUSABLE' as const, code: declared.code });
  if (!declared.ok) notes.push(note('PROFILE_UNUSABLE', canonicalRoot, null, declared.code));

  const declaredTasks = readDeclaredTasks(canonicalRoot, profile, notes);
  const runtime = scanRuntimeTaskIds(canonicalRoot, seams.readDirectory, notes);

  // The join. A task is listed if it is declared, if it has a durable record, or
  // both — and which of those is true is carried, never inferred from the other.
  // Only a SUCCESSFUL discovery can answer "is this declared". On a refusal the
  // question is unanswered for every task, and saying so is the whole job.
  const discovered = declaredTasks.reading === 'DISCOVERED';
  const declaredIds = discovered ? declaredTasks.taskIds : [];
  const ids = [...new Set([...declaredIds, ...runtime.taskIds])].sort(compareTaskIds);

  const tasks = ids.map((taskId): TaskSnapshot => {
    const isDeclared: DeclarationReading = !discovered
      ? 'UNDETERMINED'
      : declaredIds.includes(taskId)
        ? 'DECLARED'
        : 'NOT_DECLARED';
    const hasRecord = runtime.taskIds.includes(taskId);

    if (!hasRecord) {
      // Declared, never started. NOT "queued": AO has no such state, and naming
      // one here would put a word on the page no AO report would ever agree to.
      return Object.freeze({
        taskId,
        declared: isDeclared,
        runtime: Object.freeze({ reading: 'NONE' as const }),
        attention: Object.freeze({ reading: 'NONE' as const }),
        verification: Object.freeze({ reading: 'NONE' as const }),
        delivery: Object.freeze({ reading: 'NONE' as const }),
      });
    }

    // Guarded, not trusted. `loadTaskState` documents that it never throws, but
    // this is a seam: the read model must survive ANY reader put through it,
    // and a snapshot that dies because one task's record exploded would take
    // every other repository down with it.
    let load: ReturnType<typeof loadTaskState>;
    try {
      load = seams.loadState(canonicalRoot, taskId);
    } catch (error) {
      notes.push(note('TASK_STATE_UNREADABLE', canonicalRoot, taskId, errnoOf(error)));
      return Object.freeze({
        taskId,
        declared: isDeclared,
        runtime: Object.freeze({
          reading: 'UNREADABLE' as const,
          code: 'READER_THREW',
          classification: 'STATE_INVALID',
        }),
        attention: Object.freeze({ reading: 'NONE' as const }),
        verification: Object.freeze({ reading: 'NONE' as const }),
        delivery: Object.freeze({ reading: 'NONE' as const }),
      });
    }

    if (!load.ok) {
      notes.push(note('TASK_STATE_UNREADABLE', canonicalRoot, taskId, load.code));
      return Object.freeze({
        taskId,
        declared: isDeclared,
        runtime: Object.freeze({
          reading: 'UNREADABLE' as const,
          code: load.code,
          classification: load.classification,
        }),
        attention: Object.freeze({ reading: 'NONE' as const }),
        verification: Object.freeze({ reading: 'NONE' as const }),
        delivery: Object.freeze({ reading: 'NONE' as const }),
      });
    }

    return Object.freeze({
      taskId,
      declared: isDeclared,
      runtime: Object.freeze({ reading: 'LOADED' as const, facts: factsOf(load.state, load.revision) }),
      attention: attentionOf(load.state, now),
      verification: verificationOf(canonicalRoot, taskId, notes),
      delivery: deliveryOf(canonicalRoot, taskId, notes),
    });
  });

  const repositoryId = profile.reading === 'DECLARED' ? profile.repositoryId : null;

  return Object.freeze({
    canonicalRoot,
    declaredPath,
    profile,
    declaredTasks,
    runtimeScan: runtime.scan,
    tasks: Object.freeze(tasks),
    lease: readLease(canonicalRoot, repositoryId, seams, notes),
  });
}

/** Canonicalise a declared path without Git. `realpath` is a syscall, not a process. */
function canonicalise(
  declaredPath: string,
  realpath: (path: string) => string,
): string | null {
  if (!isAbsolute(declaredPath)) return null;
  try {
    return realpath(declaredPath);
  } catch {
    return null;
  }
}

/**
 * One observation of everything AO has written down.
 *
 * Starts no process, opens no socket, writes nothing, and holds no file handle
 * across a call. Never throws: a failure anywhere becomes a reading and a note.
 */
export function readDashboardSnapshot(seams: ReadModelSeams = {}): DashboardSnapshot {
  // One clock for the whole snapshot. Read once, here, and passed down.
  const now = (seams.now ?? (() => new Date()))();
  const observedAt = now.toISOString();

  const resolved = {
    readDirectory: seams.readDirectory ?? ((path: string) => readdirSync(path)),
    loadState: seams.loadState ?? loadTaskState,
    inspectLease: seams.inspectLease ?? inspectRepositoryExecutionLease,
  };
  const realpath = seams.realpath ?? ((path: string) => realpathSync.native(path));
  const load = seams.loadRegistry ?? loadRepositoryRegistry;
  const provider = seams.pathProvider ?? OS_PATH_PROVIDER;

  const notes: ReadingNote[] = [];

  let outcome: RepositoryRegistryOutcome;
  try {
    outcome = load(provider);
  } catch (error) {
    notes.push(note('REGISTRY_UNUSABLE', null, null, errnoOf(error)));
    return Object.freeze({
      observedAt,
      registry: Object.freeze({ reading: 'UNUSABLE' as const, code: 'PROFILE_UNAVAILABLE' }),
      repositories: Object.freeze([]),
      notes: Object.freeze(notes),
    });
  }

  if (outcome.state === 'NOT_REGISTERED') {
    return Object.freeze({
      observedAt,
      registry: Object.freeze({ reading: 'NOT_REGISTERED' as const }),
      repositories: Object.freeze([]),
      notes: Object.freeze(notes),
    });
  }

  if (outcome.state === 'UNUSABLE') {
    notes.push(note('REGISTRY_UNUSABLE', null, null, outcome.code));
    return Object.freeze({
      observedAt,
      registry: Object.freeze({ reading: 'UNUSABLE' as const, code: outcome.code }),
      repositories: Object.freeze([]),
      notes: Object.freeze(notes),
    });
  }

  const seen = new Set<string>();
  const repositories: RepositorySnapshot[] = [];
  for (const entry of outcome.entries) {
    const canonicalRoot = canonicalise(entry.path, realpath);
    if (canonicalRoot === null) {
      notes.push(note('REPOSITORY_ROOT_UNRESOLVABLE', null, null, null));
      continue;
    }
    // Two spellings of one directory are one repository. AO refuses the whole
    // registry for this; an observer reports it and carries on, because a
    // dashboard that showed nothing would be the less useful failure.
    const key = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
    if (seen.has(key)) {
      notes.push(note('REPOSITORY_ROOT_DUPLICATE', canonicalRoot, null, null));
      continue;
    }
    seen.add(key);
    repositories.push(readRepository(entry.path, canonicalRoot, now, resolved, notes));
  }

  // AO's own ordering: ascending code units on the canonical root. Never a
  // locale collation, and never the declared id — ids may repeat.
  repositories.sort((a, b) => compareRepositoryRoots(a.canonicalRoot, b.canonicalRoot));

  return Object.freeze({
    observedAt,
    registry: Object.freeze({
      reading: 'REGISTERED' as const,
      digest: outcome.registryDigest,
      entryCount: outcome.entries.length,
      maxConcurrentRepositories: outcome.maxConcurrentRepositories,
    }),
    repositories: Object.freeze(repositories),
    notes: Object.freeze(notes),
  });
}

/** Re-exported so a caller can filter task ids with the same grammar AO uses. */
export { isValidTaskId };
