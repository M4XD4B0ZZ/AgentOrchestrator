/**
 * Which task's delivery is next — the one piece of manual sequencing slice 11
 * left with the operator.
 *
 * ── What this answers, and what it does not ────────────────────────────────
 *
 * `driveDelivery` works out which *act* a named delivery still needs. It cannot
 * work out *which delivery*, because slice 11 took the task id from `--task`.
 * This module answers exactly that one question, for one already-resolved
 * repository, and nothing else:
 *
 *     "among the tasks this repository declares, which one is the next
 *      legitimate subject for the delivery driver?"
 *
 * It is **routing, not authority**. A selection permits nothing: no branch is
 * published, no pull request opened, no merge performed, no verification run,
 * no task state written and no forge contacted, because none of those is
 * reachable from here at all. The three one-shot grants —
 * `HeadPublicationGrant`, `PullRequestCreationGrant`, `MergeGrant` — are minted
 * where they always were, from facts read where they always were, and this
 * module mints nothing and holds nothing. There is deliberately no
 * `SelectionProof`: an opaque artefact exists in this build to force proof over
 * assertion *where an authority is granted*, and a router grants none.
 *
 * ── The input set is the plan ──────────────────────────────────────────────
 *
 * The candidates are the tasks the repository **declares**, arriving as a
 * `NormalizedTaskGraph`. Not a listing of `runtime/`: the state layer says twice
 * that it never enumerates its own directory — readers "open the target by name"
 * — and a scan there would admit tasks the repository has stopped declaring
 * while giving the result no dependency order at all. `discoverTasks` is the
 * only task enumerator this build has, it sorts its candidates by id *before*
 * opening anything, and it refuses the whole discovery rather than skipping one
 * unreadable task file. All three of those properties are inherited here by
 * taking its graph rather than building a second inventory.
 *
 * ── The order is the graph's own, and it is load-bearing ───────────────────
 *
 * `graph.topologicalOrder`: dependency-respecting, every tie broken by the
 * smallest id, and it covers **every** task whatever its `status`. Two things
 * follow.
 *
 * The first is why it is not `selectNextTask`'s ranking. That tuple ranks the
 * *eligible* tasks — `status: OPEN` with every dependency `DONE` — which is the
 * right set for "what should AO implement next" and the wrong one here: a task a
 * human marked `DONE` in the markdown so the next one could start, whose pull
 * request was never merged, is `ALREADY_DONE` to that selector and invisible to
 * its ranking for ever. That is starvation exactly where it matters. Its
 * `unlockCount` element is also a statement about releasing blocked *work*,
 * which a finished task does not do.
 *
 * The second is that dependency order is not decoration here. `F-C4` records
 * that a block produces a **stack**: `B`'s branch contains `A`'s commits, so a
 * pull request for `B` carries `A`'s work, and "merging out of order is an
 * operator decision this build does not model". Walking the topological order
 * means the selector never hands `B` to the driver while `A`'s delivery is
 * still pending. It **narrows** `F-C4` and does not close it: `--task B` does
 * what it always did, and the order read here comes from the plan *as it is
 * now*, which is not the frozen relation a block run was started against.
 *
 * ── Two documents per candidate, and the conclusion first ──────────────────
 *
 * The conclusion is read before the task state, and the ordering is the whole of
 * how "a concluded delivery stays concluded" is honoured. What
 * `loadDeliveryConclusion` has to be told about the delivery is a
 * `DeliveryConclusionSubject`, and that type is `{ taskId, repositoryRoot }` and
 * nothing else: no delivery target, no profile digest, no `currentCommit`, no
 * merge receipt, no verification history. Both of its fields are already in hand
 * here. So a task whose conclusion is on disk is answered and skipped without
 * any of the artefacts slice 10 allows to disappear being consulted. Deleting
 * the receipt or corrupting the verification history cannot make a concluded
 * task a candidate again, because nothing here looks at either.
 *
 * ── A candidate whose evidence cannot be read is surfaced, never skipped ───
 *
 * The walk stops at the first task this module **could not classify**, and
 * reports it. Precisely: it stops when the conclusion cannot be read, and when
 * the conclusion is absent and the task state cannot be read. It does *not*
 * stop on an unreadable task state under a conclusion that reads cleanly —
 * that task's delivery is over, and the state is not consulted at all. Skipping
 * on to a later task in the two cases that do stop it would convert a visible
 * evidence failure into an invisible bypass — the repository would deliver
 * *something* and never say what it stepped over. It is also the answer
 * `discoverTasks` already gives one directory up, where a single malformed task
 * file refuses the whole discovery rather than dropping that task. `--task`
 * remains the operator's way past it, which is the other half of why this
 * refusal is affordable.
 *
 * ── Deliverability is not assessed here ────────────────────────────────────
 *
 * Whether the selected task *can* be delivered — a resolvable subject, a work
 * branch this build will send — is not asked. Those are the driver's own
 * refusals, and they name the task they are about. A selector that pre-screened
 * them would have to skip the tasks that failed, which is the bypass above, or
 * duplicate the driver's ladder, which is a second opinion about what a
 * deliverable task is. So a task whose subject cannot be reconstructed is still
 * selected, and the driver answers `SUBJECT_NOT_ESTABLISHED` about it, out loud.
 *
 * One distinction is worth stating rather than leaving to be inferred, because a
 * review measured the earlier wording implying the opposite. The **delivery
 * target is a property of the repository**, not of a task: it is resolved once
 * by `resolveRepository` and every task in the run sees the same one. So an
 * undeclared or unresolvable target does not make *this* task a bad candidate
 * and a later one a good one — it makes every invocation select the same first
 * pending task and the driver refuse it, until a person fixes the profile. That
 * is the intended behaviour and it is visible; what it is not is a per-task
 * condition a selector could usefully route around.
 *
 * ── Nothing here is durable, and nothing here is fresh for long ────────────
 *
 * No record is written. Two file opens per candidate at most — the conclusion,
 * and the task state only when the conclusion is absent — and the walk stops at
 * the first candidate it either selects or cannot classify. It does **not** stop
 * at the first answer: `DELIVERY_CONCLUDED`, `NOT_ORCHESTRATED` and
 * `NOT_READY_FOR_DELIVERY` are answers, and the walk continues past every one of
 * them, so a plan whose deliveries are all concluded is read end to end.
 * The driver re-establishes the subject, the task state and
 * the conclusion for itself, from its own readings, so a selection that has gone
 * stale in those respects is caught there. What the driver does **not**
 * re-establish is the order — see `L-V4-12-1`. This module claims a snapshot, not
 * a lock, for the reason `delivery-conclusion-store.ts` gives about its own
 * read-before-write: a window that cannot be closed without a lock is narrowed
 * and stated, never described as closed.
 */

import type { NormalizedTaskGraph } from '../plan/task-graph.js';
import type { loadTaskState, StateLoadFailureCode } from '../state/state-store.js';
import { loadDeliveryConclusion } from './delivery-conclusion-store.js';
import type { DeliveryConclusionReading } from './delivery-conclusion.js';

/**
 * Where one candidate stands, as far as selection is concerned.
 *
 * Five members, and only the first is a selection. The other four are the four
 * different reasons a declared task is not the next delivery, kept apart because
 * they mean different things to an operator asking "why not this one?".
 */
export const DELIVERY_CANDIDATE_POSITIONS = [
  /** `READY_FOR_PR`, and no conclusion is on disk. The one selectable member. */
  'DELIVERY_PENDING',
  /**
   * A conclusion this build wrote for this task is on disk. Terminal, and
   * answered without reading the task state, the receipt or the verification
   * history — none of which this position depends on.
   */
  'DELIVERY_CONCLUDED',
  /**
   * There is no task state at this task's path.
   *
   * Named for the file, not for a history, and the difference is the whole
   * reason the wording is this careful. `NO_STATE` is `ENOENT`, and `ENOENT`
   * cannot tell "never written" from "written and since removed" — a wiped
   * runtime directory, a fresh clone, a cleaned volume. The ordinary cause is
   * the first, which is the condition of most of a roadmap; but a task AO ran
   * to `READY_FOR_PR` and whose record was then deleted lands here too, and is
   * passed over. That is `L-V4-12-3`.
   */
  'NOT_ORCHESTRATED',
  /** A task state exists and is not `READY_FOR_PR`. Nothing to deliver yet. */
  'NOT_READY_FOR_DELIVERY',
  /**
   * A document on this task's path could not be read as the record it should be.
   *
   * The conclusion or the task state: bytes are there and this build cannot say
   * what they claim, or they describe something else. Never skipped — see the
   * header.
   */
  'EVIDENCE_UNREADABLE',
] as const;

export type DeliveryCandidatePosition = (typeof DELIVERY_CANDIDATE_POSITIONS)[number];

/** What each conclusion reading means to selection. Total by type. */
const POSITION_FOR_CONCLUSION = Object.freeze({
  /** The one terminal reading. */
  DELIVERY_CONCLUDED: 'DELIVERY_CONCLUDED',
  /**
   * Nobody has written one. `null` means "keep going" — the task state decides.
   * It is deliberately not a position: "no conclusion" is not by itself a
   * statement that anything is pending.
   */
  ABSENT: null,
  MALFORMED: 'EVIDENCE_UNREADABLE',
  /**
   * A record a newer build wrote. Unreadable *here*, and emphatically not
   * absent: treating it as absent would make a concluded delivery a candidate
   * again on the strength of not understanding its own evidence.
   */
  UNSUPPORTED_VERSION: 'EVIDENCE_UNREADABLE',
  /** Another task's record, another repository's, or one edited in place. */
  NOT_THIS_TASK: 'EVIDENCE_UNREADABLE',
}) satisfies Record<DeliveryConclusionReading, DeliveryCandidatePosition | null>;

/**
 * What each state-load failure means to selection. Total by type.
 *
 * One member is not a problem and the rest are. `NO_STATE` is the ordinary case
 * — the store's own comment on it is "Not an error" — and every other code is a
 * record that may exist and may say `READY_FOR_PR`, which is precisely what
 * cannot be assumed away.
 */
const POSITION_FOR_STATE_FAILURE = Object.freeze({
  NO_STATE: 'NOT_ORCHESTRATED',
  LOCATION_UNSUITABLE: 'EVIDENCE_UNREADABLE',
  UNREADABLE: 'EVIDENCE_UNREADABLE',
  STATE_TOO_LARGE: 'EVIDENCE_UNREADABLE',
  REPOSITORY_ROOT_MISMATCH: 'EVIDENCE_UNREADABLE',
  REPOSITORY_ROOT_NOT_ABSOLUTE: 'EVIDENCE_UNREADABLE',
  TASK_ID_MISMATCH: 'EVIDENCE_UNREADABLE',
  MALFORMED_JSON: 'EVIDENCE_UNREADABLE',
  SCHEMA_VERSION_UNSUPPORTED: 'EVIDENCE_UNREADABLE',
  CONTRACT_VIOLATION: 'EVIDENCE_UNREADABLE',
}) satisfies Record<StateLoadFailureCode, DeliveryCandidatePosition>;

/** The state a delivery is driven from. The driver's own gate, restated once. */
const DELIVERABLE_STATE = 'READY_FOR_PR';

/** One examined candidate, in the order it was examined. */
export interface DeliveryCandidate {
  readonly taskId: string;
  readonly position: DeliveryCandidatePosition;
}

/** The outcome vocabulary of one selection. A closed set. */
export const DELIVERY_TASK_SELECTIONS = [
  /** Exactly one task was chosen; it is the first pending one in the order. */
  'DELIVERY_TASK_SELECTED',
  /**
   * Every declared task was examined and none is pending.
   *
   * A nominal answer, not a failure: a repository whose deliveries are all
   * concluded, and one whose tasks have not been run yet, both land here and
   * both are correct. It is deliberately **not** split into "all concluded" and
   * "nothing ready" — the examined list below says which, per task, and a second
   * code derived from it would be a summary that could disagree with its own
   * evidence.
   */
  'NO_DELIVERY_PENDING',
  /**
   * The walk stopped at a candidate whose records could not be read.
   *
   * {@link DeliveryTaskSelectionResult.blockedTaskId} names it. Nothing was
   * skipped past, so no later task was selected instead.
   */
  'DELIVERY_EVIDENCE_UNREADABLE',
] as const;

export type DeliveryTaskSelection = (typeof DELIVERY_TASK_SELECTIONS)[number];

export const DELIVERY_TASK_SELECTION_DETAIL: Readonly<
  Record<DeliveryTaskSelection, string>
> = Object.freeze({
  DELIVERY_TASK_SELECTED:
    'One task is the next delivery in the plan’s own dependency order. Selecting it authorises nothing.',
  NO_DELIVERY_PENDING:
    'Every declared task was examined and none is waiting for a delivery act.',
  DELIVERY_EVIDENCE_UNREADABLE:
    'A record beside the task named below could not be read, so the walk stopped there and no ' +
    'task after it was selected. Nothing was repaired and nothing was overwritten.',
});

export interface DeliveryTaskSelectionResult {
  readonly outcome: DeliveryTaskSelection;
  /** The chosen task id, or `null` for every other outcome. */
  readonly taskId: string | null;
  /**
   * The task the walk stopped at, on `DELIVERY_EVIDENCE_UNREADABLE`, and `null`
   * otherwise. A separate field from {@link taskId} because a blocker is not a
   * selection and a caller must not be able to read one as the other.
   */
  readonly blockedTaskId: string | null;
  /**
   * Every candidate examined, in the order they were examined.
   *
   * The reasoning is part of the answer — `select-task.ts` holds the same line
   * about its own ranking. It is a *prefix* of the topological order, not the
   * whole of it: the walk stops at the first pending task and at the first
   * unreadable one, so a caller can see exactly what was read and exactly where
   * reading ended.
   */
  readonly examined: readonly DeliveryCandidate[];
}

/**
 * The two readers this module is given rather than takes.
 *
 * `loadState` is **required and has no default**, and that is a rule rather than
 * a preference: `tests/v4-03-delivery-evidence.test.ts` pins that no module under
 * `src/deliver/` takes a value import from `state/state-store.js`, with the CLI's
 * own reader as the single admitted exception. The task's bytes are the CLI's to
 * read. `recordDeliveryConclusion` states the same argument about
 * `readStateRevision` — there is no default this module is allowed to have.
 *
 * `loadConclusion` is defaulted, because the conclusion store is a sibling in
 * this directory and no pin separates them. It is injectable so that the
 * readings a real filesystem will not produce on demand — a short read, an open
 * that fails with something other than `ENOENT` — can be driven at all.
 */
export interface DeliverySelectionSeams {
  readonly loadState: typeof loadTaskState;
  readonly loadConclusion?: typeof loadDeliveryConclusion;
}

function candidate(taskId: string, position: DeliveryCandidatePosition): DeliveryCandidate {
  return Object.freeze({ taskId, position });
}

/**
 * Classifies one candidate. Two reads at most, and the second only if the first
 * says nothing terminal.
 */
function positionOf(
  repositoryRoot: string,
  taskId: string,
  seams: DeliverySelectionSeams,
): DeliveryCandidatePosition {
  const loadConclusion = seams.loadConclusion ?? loadDeliveryConclusion;
  // The conclusion first, and only ever with the two identities it needs. A
  // concluded delivery is answered here and the task state is never opened,
  // which is what makes a deleted receipt or a corrupted verification history
  // unable to un-conclude anything.
  const conclusion = loadConclusion(repositoryRoot, taskId, { taskId, repositoryRoot });
  const concluded = POSITION_FOR_CONCLUSION[conclusion.reading];
  if (concluded !== null) return concluded;

  const state = seams.loadState(repositoryRoot, taskId);
  if (!state.ok) return POSITION_FOR_STATE_FAILURE[state.code];
  return state.state.state === DELIVERABLE_STATE
    ? 'DELIVERY_PENDING'
    : 'NOT_READY_FOR_DELIVERY';
}

/**
 * Chooses the next delivery, or explains why there is none.
 *
 * Never throws for an expected condition — both readers answer with a code
 * rather than an exception, and every code they can answer with is classified in
 * a table above that the compiler keeps total. Writes nothing, contacts nothing,
 * starts no process and takes no lease.
 *
 * `repositoryRoot` must be canonical: pass `ResolvedRepository.root`. Both
 * readers derive their own paths from it and refuse a root they cannot use.
 */
export function selectDeliveryTask(
  repositoryRoot: string,
  graph: NormalizedTaskGraph,
  seams: DeliverySelectionSeams,
): DeliveryTaskSelectionResult {
  const examined: DeliveryCandidate[] = [];

  // The graph's own order, not a copy of it and not a second sort. Every task
  // is in it — `normalizeTaskGraph` emits one entry per task or refuses the
  // whole graph as a cycle — so a `status: DONE` task whose delivery never
  // happened is examined like any other.
  for (const taskId of graph.topologicalOrder) {
    const position = positionOf(repositoryRoot, taskId, seams);
    examined.push(candidate(taskId, position));

    if (position === 'DELIVERY_PENDING') {
      return Object.freeze({
        outcome: 'DELIVERY_TASK_SELECTED' as const,
        taskId,
        blockedTaskId: null,
        examined: Object.freeze([...examined]),
      });
    }
    if (position === 'EVIDENCE_UNREADABLE') {
      return Object.freeze({
        outcome: 'DELIVERY_EVIDENCE_UNREADABLE' as const,
        taskId: null,
        blockedTaskId: taskId,
        examined: Object.freeze([...examined]),
      });
    }
  }

  return Object.freeze({
    outcome: 'NO_DELIVERY_PENDING' as const,
    taskId: null,
    blockedTaskId: null,
    examined: Object.freeze([...examined]),
  });
}
