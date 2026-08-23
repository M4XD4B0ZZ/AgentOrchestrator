/**
 * Composing a delivery observation — V4 slice 2.
 *
 * Two halves that are deliberately separate:
 *
 *  1. {@link resolveObservationSubject} decides **what would be asked about**.
 *     It is pure, local, contacts nothing, and is the whole content of the
 *     no-network mode. An operator can run it to see which repository this
 *     checkout would deliver to and which commit is the subject, before any
 *     request exists.
 *  2. {@link observeDelivery} asks the forge the two questions, and is reached
 *     only from an explicit `--observe`.
 *
 * The split is the network-egress boundary. It is not a rendering convenience:
 * a subject can be established with no client installed and no login at all,
 * and nothing in step 1 can start a process.
 *
 * ── This module answers facts. It does not grant anything ──────────────────
 *
 * Nothing here combines its two answers. There is no value that means "ready to
 * merge", no field that adds a pull request to a check state, and no caller
 * could compute one from what is returned without writing that policy itself.
 * That is the point of the slice: `PR_EXISTS` is not `MERGEABLE`, `MERGEABLE`
 * is not `CI_SUCCESS`, `CI_SUCCESS` is not "review requirements satisfied", and
 * all three together are not authority to merge. Those are later decisions, and
 * they are easier to take honestly if this layer never quietly pre-empted them.
 */

import type { TaskState } from '../core/task-state.js';
import type { StateLoadResult } from '../state/state-store.js';
import type { ResolvedDelivery } from './delivery-target.js';
import {
  createObservationSubject,
  type CheckStateObservation,
  type ObservationSubject,
  type PullRequestObservation,
} from './forge-observation.js';
import {
  observeCheckStateAtCommit,
  observePullRequestAtHead,
  type ForgeObserverDependencies,
} from './github-observer.js';

/**
 * Why no subject could be established.
 *
 * Every member is a *local* verdict — none of them involves a network — and
 * each one names a different thing for the operator to go and fix.
 */
export const SUBJECT_REFUSALS = [
  /** The profile declares no `delivery.remote`, so there is no target at all. */
  'DELIVERY_NOT_DECLARED',
  /**
   * A target is declared and slice 1 refused to resolve it — a mistyped remote
   * name, an ambiguous push URL, a URL carrying user information. The delivery
   * target's own refusal code is carried alongside so the operator reads the
   * specific reason rather than this general one.
   */
  'DELIVERY_TARGET_UNRESOLVED',
  /** No durable record for this task, or one that could not be read. */
  'TASK_STATE_UNAVAILABLE',
  /**
   * The record exists and pins no commit. A task that has not produced one has
   * nothing for a forge to be asked about; it is not an error, and it is not an
   * observation either.
   */
  'NO_CURRENT_COMMIT',
  /** The target resolved to a host this build does not contact. */
  'UNSUPPORTED_HOST',
  /** The identity or the commit object name is not one this build will request. */
  'SUBJECT_UNUSABLE',
] as const;

export type SubjectRefusal = (typeof SUBJECT_REFUSALS)[number];

/** One static sentence per refusal. Pinned by literal, never by reading the map. */
export const SUBJECT_REFUSAL_DETAIL: Readonly<Record<SubjectRefusal, string>> = Object.freeze({
  DELIVERY_NOT_DECLARED:
    'This repository declares no delivery target, so there is nothing to observe.',
  DELIVERY_TARGET_UNRESOLVED:
    'The declared delivery target did not resolve to a repository identity.',
  TASK_STATE_UNAVAILABLE: 'No durable record for this task could be read.',
  NO_CURRENT_COMMIT: 'The durable record pins no commit, so there is no subject to ask about.',
  UNSUPPORTED_HOST:
    'The delivery target is not on a host this build contacts. Nothing was requested.',
  SUBJECT_UNUSABLE:
    'The repository identity or the commit object name is not one this build will put in a request.',
});

export interface SubjectResolved {
  readonly ok: true;
  readonly subject: ObservationSubject;
  /** The state the record is in, so the operator sees what the commit belongs to. */
  readonly taskState: TaskState['state'];
  /** The remote name the profile declared, for the operator's own check. */
  readonly remoteName: string;
}

export interface SubjectRefused {
  readonly ok: false;
  readonly code: SubjectRefusal;
  /**
   * The delivery target's own refusal, when that is what went wrong.
   *
   * A closed code from slice 1's vocabulary, never a sentence and never a URL.
   */
  readonly deliveryDetail: string | null;
}

export type SubjectResolution = SubjectResolved | SubjectRefused;

function refuse(code: SubjectRefusal, deliveryDetail: string | null = null): SubjectRefused {
  return Object.freeze({ ok: false as const, code, deliveryDetail });
}

/**
 * Turns a resolved repository's delivery target and a task's durable record
 * into the subject of an observation, or refuses.
 *
 * Order matters and is deliberate: the delivery target is judged before the
 * task record, because "this repository has no delivery target" is a fact about
 * the repository that no amount of task state changes, and an operator who sees
 * it first is sent to the right file.
 */
export function resolveObservationSubject(
  delivery: ResolvedDelivery,
  load: StateLoadResult,
): SubjectResolution {
  if (!delivery.declared) return refuse('DELIVERY_NOT_DECLARED');
  if (delivery.result.outcome !== 'RESOLVED') {
    return refuse('DELIVERY_TARGET_UNRESOLVED', delivery.result.outcome);
  }
  if (!load.ok) return refuse('TASK_STATE_UNAVAILABLE');

  const commit = load.state.currentCommit;
  if (commit === null) return refuse('NO_CURRENT_COMMIT');

  const built = createObservationSubject(delivery.result.target, commit);
  if (!built.ok) {
    // Only two of the shared refusals are reachable from here, and both are
    // members of this vocabulary under the same name. Anything else would mean
    // the subject factory grew a code this layer has not decided about, so it
    // is refused as unusable rather than passed through unrecognised.
    return refuse(built.refusal === 'UNSUPPORTED_HOST' ? 'UNSUPPORTED_HOST' : 'SUBJECT_UNUSABLE');
  }

  return Object.freeze({
    ok: true as const,
    subject: built.subject,
    taskState: load.state.state,
    remoteName: delivery.remoteName,
  });
}

/**
 * The two independent answers, for exactly one subject.
 *
 * Independent in both directions: the check state is asked for even when no
 * matching pull request was found, because "this commit is green and nobody has
 * opened a pull request for it" is a useful and true thing to learn, and the
 * pull-request answer is not a precondition for the check answer. Sequential
 * rather than concurrent, so that a failing client produces one clear refusal
 * per question instead of two racing ones.
 */
export interface DeliveryObservation {
  readonly pullRequest: PullRequestObservation;
  readonly checks: CheckStateObservation;
}

export async function observeDelivery(
  subject: ObservationSubject,
  deps: ForgeObserverDependencies,
): Promise<DeliveryObservation> {
  const pullRequest = await observePullRequestAtHead(subject, deps);
  const checks = await observeCheckStateAtCommit(subject, deps);
  return Object.freeze({ pullRequest, checks });
}

// ── What the whole invocation amounts to ───────────────────────────────────

/**
 * The four things one invocation of the surface can amount to.
 *
 * `OBSERVED` deliberately covers "no pull request has this head" and "the
 * checks failed" and "there are no checks". Each of those is an **answer**: the
 * forge was reached, the response was accepted, and the question was settled.
 * Collapsing them into a failure would teach an operator to read a refusal and
 * an answer as the same thing, which is the habit this whole slice is built to
 * prevent.
 */
export const OBSERVATION_CONCLUSIONS = [
  /** A subject was established and nothing was contacted, because nothing asked it to. */
  'NOT_OBSERVED',
  /** No subject could be established. Nothing was contacted. */
  'SUBJECT_NOT_ESTABLISHED',
  /** Both questions were settled. */
  'OBSERVED',
  /** At least one question was not settled, so at least one fact is missing. */
  'OBSERVATION_INCOMPLETE',
] as const;

export type ObservationConclusion = (typeof OBSERVATION_CONCLUSIONS)[number];

export const OBSERVATION_CONCLUSION_DETAIL: Readonly<Record<ObservationConclusion, string>> =
  Object.freeze({
    NOT_OBSERVED:
      'The subject is established. Nothing was contacted; pass --observe to ask the forge.',
    SUBJECT_NOT_ESTABLISHED:
      'There is no subject to ask about, so no request was made.',
    OBSERVED:
      'Both questions were answered for exactly the commit named above. Nothing was delivered.',
    OBSERVATION_INCOMPLETE:
      'At least one question was not answered, so nothing about it is established.',
  });

/** The semantic outcomes — the ones that mean a question was actually settled. */
const SETTLED_PULL_REQUEST: ReadonlySet<string> = new Set([
  'MATCHED',
  'NO_MATCHING_PULL_REQUEST',
  'AMBIGUOUS',
]);
const SETTLED_CHECKS: ReadonlySet<string> = new Set(['SUCCESS', 'PENDING', 'FAILED', 'NO_CHECKS']);

/**
 * Total, and deliberately not clever: an observation counts as complete only
 * when *both* questions landed on a settled outcome. One answer and one refusal
 * is `OBSERVATION_INCOMPLETE`, because a report that showed a green check state
 * beside an unestablished pull request would read as though both were known.
 */
export function concludeObservation(
  subject: SubjectResolution,
  observation: DeliveryObservation | null,
): ObservationConclusion {
  if (!subject.ok) return 'SUBJECT_NOT_ESTABLISHED';
  if (observation === null) return 'NOT_OBSERVED';
  return SETTLED_PULL_REQUEST.has(observation.pullRequest.outcome) &&
    SETTLED_CHECKS.has(observation.checks.outcome)
    ? 'OBSERVED'
    : 'OBSERVATION_INCOMPLETE';
}
