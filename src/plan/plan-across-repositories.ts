/**
 * Planning over more than one repository: *which task, in which repository?*
 * (M2 slice 3).
 *
 * `plan-next-task.ts` answers "which task" for one repository, and answers it
 * completely. This module answers the question that one cannot be asked, because
 * its input is one repository and its output carries none: given several
 * enlisted repositories, which single piece of work is next, and where does it
 * live.
 *
 * ── It adds no policy to the single-repository answer ──────────────────────
 *
 * Every registered repository is planned by `planNextTask`, unchanged and
 * unwrapped. Nothing here re-implements discovery, graph normalisation,
 * eligibility or the ranking tuple; the per-repository result — the whole
 * eligibility report and the whole ranking — is carried out verbatim, so the
 * reasoning an operator reads for one repository is the reasoning that module
 * produced.
 *
 * ── The ranking tuple gains exactly one element, and it goes last ──────────
 *
 * `select-task.ts` ranks eligible tasks by
 *
 *     (kind, currentFocus, priority, -unlockCount, id)
 *
 * and argues its totality from the last element: "the task id, which is unique,
 * so the order is **total**". Across two repositories that argument does not
 * hold — two repositories may each declare a task called `remediate-auth`, and
 * they are two different pieces of work. So the tuple gains a sixth element:
 *
 *     (kind, currentFocus, priority, -unlockCount, taskId, repositoryRoot)
 *
 * **Last, after the task id.** That placement is the whole design, and it is a
 * refusal as much as a choice:
 *
 *  - within one repository, the sixth element is constant, so the answer is
 *    bit-for-bit what `selectNextTask` gives today. The existing contract is
 *    preserved rather than reinterpreted;
 *  - across repositories, no task's rank relative to another changes either. The
 *    new element decides *only* the case the old contract had no answer for: two
 *    eligible tasks sharing an id, with the first four elements equal, in
 *    different repositories;
 *  - putting the repository *first* — or anywhere before the id — would be a
 *    statement that one repository's work outranks another's. That is a
 *    scheduling policy. It is not in this slice, and encoding it in a comparator
 *    would be the quiet way to ship it.
 *
 * The tie-break is on the **canonical repository root** and deliberately not on
 * `repository.id`. The id is the more readable value and was the first choice;
 * it is wrong for this job for a reason that outranks readability: the id is
 * read out of a profile inside a repository this orchestrator writes to, so
 * ranking on it would let one driven repository decide which repository gets
 * selected — including its own — by committing an edit to its own file. An
 * ordering that a subject of the ordering can rewrite is not an ordering. The
 * canonical root is established by `realpathSync.native` inside
 * `resolveRepository` and no repository content can move it.
 *
 * The consequence is stated rather than hidden: two enlisted repositories MAY
 * declare the same `repository.id` — two clones of one remote do, and that
 * configuration is supported — so the id alone does not identify a candidate.
 * That is why {@link CrossRepositoryRankingEntry} carries the root as well as
 * the id, and why a report built on it must show both.
 *
 * That the tie-break is *total* is not a property of this file. It is
 * established by `repository-registry.ts` refusing `DUPLICATE_REPOSITORY_ROOT`:
 * because no two enlisted repositories are the same canonical root, no two
 * candidates can tie on all six elements. The refusal is the totality argument,
 * not tidiness.
 *
 * ── `unlockCount` is compared across repositories, and that is deliberate ──
 *
 * The fourth element counts the not-yet-`DONE` tasks that transitively depend on
 * a candidate, and it is computed inside one repository's graph — there are no
 * cross-repository dependencies, and this slice does not introduce any. So the
 * comparison at position four is between two different graphs' metrics.
 *
 * That is the *preserving* choice rather than the clever one. Dropping the
 * element for cross-repository comparisons would mean the merged ranking
 * disagreed with the per-repository ranking every consumer already reads, and a
 * ranking that changes shape depending on how many repositories are enlisted is
 * a second contract wearing the first one's name.
 *
 * ── One unusable repository refuses the whole plan ─────────────────────────
 *
 * If any enlisted repository cannot be planned, this answers
 * `REPOSITORY_UNPLANNABLE` and selects nothing — it does not plan the rest and
 * name a winner among them. The winner of a ranking is only *the* winner if the
 * candidate set is complete; a winner computed over whichever repositories
 * happened to read cleanly would be a scheduling decision made silently out of a
 * configuration mistake. `discoverTasks` already takes this reading one level
 * down, where an empty task source is `TASK_SOURCE_EMPTY` rather than "all tasks
 * complete".
 *
 * Whether a scheduler should later be able to proceed without a broken
 * repository is a policy question with its own consequences, and it needs its
 * own decision. It is not answered here by defaulting.
 *
 * ── This module executes nothing ───────────────────────────────────────────
 *
 * It starts no process, acquires no lease, creates no workspace and writes no
 * state. It reads files through `planNextTask` and returns a value. In
 * particular it holds no lease — `boundary/owned-launch-accounting.ts` records
 * that nothing in this build holds two leases in one process, and reading
 * several repositories' plans does not change that.
 */

import type { RegisteredRepository } from '../registry/repository-registry.js';
import { compareRepositoryRoots } from '../registry/repository-registry.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { compareTaskIds } from './task-id.js';
import type { TaskDefinition } from './task-definition.js';
import {
  planNextTask as planNextTaskProduction,
  type TaskPlanningFailureCode,
} from './plan-next-task.js';
import { taskRankingKey, type TaskEligibility } from './select-task.js';
import type { NormalizedTaskGraph } from './task-graph.js';

/**
 * One repository's plan, kept whole.
 *
 * The per-repository `selection` is carried verbatim rather than summarised, so
 * an operator can read why *that* repository nominated *that* task with the same
 * detail a single-repository run would have shown them.
 */
export interface RepositoryPlan {
  /** The repository this plan is about. The execution binding, carried as a value. */
  readonly repository: ResolvedRepository;
  /** Every eligibility verdict this repository produced, in canonical id order. */
  readonly eligibility: readonly TaskEligibility[];
  /** This repository's own ranking, best first. Empty when nothing is eligible. */
  readonly ranking: readonly string[];
}

/**
 * A candidate for selection: one task, and the repository it belongs to.
 *
 * The pair is the point. A `TaskDefinition` alone cannot be acted on across
 * repositories — measured on the pre-change build, two repositories each
 * selecting a task called `shared-id` produce two `TaskDefinition` values with
 * equal fields and nothing to tell them apart. The record subject that already
 * spans repositories elsewhere in this build is `{ taskId, repositoryRoot }`,
 * and this is that pair with the whole resolved repository carried rather than
 * its root, because the resolved value is what the execution path consumes.
 */
export interface CrossRepositoryCandidate {
  /** The whole frozen resolved repository. Not a path, not an id. */
  readonly repository: ResolvedRepository;
  /** The task, exactly as its repository declared it. */
  readonly task: TaskDefinition;
  /** This task's eligibility verdict inside its own repository's graph. */
  readonly eligibility: TaskEligibility;
}

/** The outcome vocabulary of a cross-repository plan. A closed set. */
export const CROSS_REPOSITORY_PLAN_CODES = [
  /** Exactly one candidate was chosen; it is the head of the published ranking. */
  'TASK_SELECTED',
  /**
   * No repository is enlisted.
   *
   * Its own outcome, and neither a success nor "all work complete". An operator
   * who has registered nothing has a configuration to finish, not a plan that is
   * done — the same reading `discoverTasks` takes of an empty task source.
   */
  'NO_REPOSITORIES_REGISTERED',
  /** Every enlisted repository planned, and every task in every one is `DONE`. */
  'ALL_TASKS_COMPLETE',
  /**
   * Open work exists somewhere and nothing anywhere is eligible.
   *
   * A fail-closed floor rather than a reachable state, for the reason
   * `select-task.ts` gives about `NO_ELIGIBLE_TASK`: in an acyclic graph whose
   * dependencies resolve, an eligible task always exists. Kept so that a future
   * rule which broke that argument surfaces as an explicit outcome rather than
   * as a silent `ALL_TASKS_COMPLETE`.
   */
  'NO_ELIGIBLE_TASK',
  /**
   * One enlisted repository could not be planned. Nothing is selected, and the
   * failing repository's id and the planner's own closed code are named.
   */
  'REPOSITORY_UNPLANNABLE',
] as const;

export type CrossRepositoryPlanCode = (typeof CROSS_REPOSITORY_PLAN_CODES)[number];

/**
 * One entry of the merged ranking, best first.
 *
 * Carries the canonical root as well as the declared id, because the id alone
 * does not identify a candidate: two enlisted repositories may legitimately
 * declare the same `repository.id` — see the header. An entry that named only
 * the id would render two clones' identically-named tasks as two identical
 * lines, which is precisely the pre-change indistinguishability this slice
 * exists to remove.
 */
export interface CrossRepositoryRankingEntry {
  /** The declared logical id. Display and correlation; never the identity. */
  readonly repositoryId: string;
  /** The canonical root. This is what makes the entry unambiguous. */
  readonly repositoryRoot: string;
  readonly taskId: string;
}

export interface CrossRepositoryPlan {
  readonly code: CrossRepositoryPlanCode;
  /** The chosen candidate, or `null` for every non-`TASK_SELECTED` outcome. */
  readonly selected: CrossRepositoryCandidate | null;
  /**
   * Every enlisted repository's own plan, in canonical-root order.
   *
   * Empty on `REPOSITORY_UNPLANNABLE`: a partial set of plans is exactly the
   * thing this outcome exists to refuse to publish.
   */
  readonly plans: readonly RepositoryPlan[];
  /** The merged ranking across every repository, best first. */
  readonly ranking: readonly CrossRepositoryRankingEntry[];
  /**
   * On `REPOSITORY_UNPLANNABLE`, the canonical root of the repository that
   * failed. The root and not the id, for the same reason the ranking carries it:
   * the id may be shared, and an operator has to be told which directory to go
   * and look at.
   */
  readonly failedRepositoryRoot: string | null;
  /** On `REPOSITORY_UNPLANNABLE`, the planner's own closed code. */
  readonly planningCode: TaskPlanningFailureCode | null;
}

/**
 * The cross-repository ranking key: the five elements `select-task.ts` produces,
 * with the repository id appended.
 *
 * Built by *calling* `taskRankingKey` rather than by restating its five
 * elements. A copy would be a second definition of the ranking contract, and the
 * two would drift the first time one of them was edited — which is the failure
 * this build has already recorded about duplicated sentences.
 */
export type CrossRepositoryRankingKey = readonly [
  kind: number,
  focus: number,
  priority: number,
  unlock: number,
  taskId: string,
  repositoryRoot: string,
];

export function crossRepositoryRankingKey(
  eligibility: TaskEligibility,
  graph: NormalizedTaskGraph,
  repositoryRoot: string,
): CrossRepositoryRankingKey {
  const [kind, focus, priority, unlock, taskId] = taskRankingKey(eligibility, graph);
  return [kind, focus, priority, unlock, taskId, repositoryRoot];
}

/**
 * Compares two cross-repository keys, most-significant element first.
 *
 * The first four are numeric and are compared as `select-task.ts` compares them.
 * The last two are identifiers and go through their own total orders, both of
 * which are UTF-16 code-unit comparisons rather than locale collations.
 */
function compareCrossRepositoryKeys(
  a: CrossRepositoryRankingKey,
  b: CrossRepositoryRankingKey,
): number {
  for (let index = 0; index < 4; index += 1) {
    const left = a[index] as number;
    const right = b[index] as number;
    if (left !== right) return left - right;
  }
  const byTask = compareTaskIds(a[4], b[4]);
  if (byTask !== 0) return byTask;
  return compareRepositoryRoots(a[5], b[5]);
}

/** The seam. Production passes nothing and gets `planNextTask`. */
export interface CrossRepositoryPlanDependencies {
  readonly planNextTask?: typeof planNextTaskProduction;
}

function conclusion(
  code: CrossRepositoryPlanCode,
  selected: CrossRepositoryCandidate | null,
  plans: readonly RepositoryPlan[],
  ranking: readonly CrossRepositoryRankingEntry[],
  failedRepositoryRoot: string | null = null,
  planningCode: TaskPlanningFailureCode | null = null,
): CrossRepositoryPlan {
  return Object.freeze({
    code,
    selected,
    plans: Object.freeze(plans),
    ranking: Object.freeze(ranking),
    failedRepositoryRoot,
    planningCode,
  });
}

/**
 * Plans across every enlisted repository and chooses one candidate, or explains
 * why there is none.
 *
 * Never throws for an expected condition. A `TASK_SELECTED` result always
 * carries the whole resolved repository of the winning candidate, and the
 * selection is always the head of the published merged ranking — the ranking is
 * the reasoning, and a selection that disagreed with it would be an answer with
 * no shown work.
 *
 * ── Independent of the order it is given ──────────────────────────────────
 *
 * The answer does **not** depend on the order of `repositories` — not the
 * selection, not the ranking, and not `plans`, which is sorted here for the same
 * reason — for any list whose entries have distinct canonical roots. That
 * proviso is the caller's, and `resolveRegisteredRepositories` discharges it by
 * refusing `DUPLICATE_REPOSITORY_ROOT` before production ever reaches here.
 * Given it, the ordering is this function's own property rather than something
 * inherited from that module's sort, and the distinction is the whole reason the
 * sixth ranking element exists as a comparator rather than as an accident.
 *
 * `resolveRegisteredRepositories` does sort by canonical root, and candidates
 * are accumulated repository by repository, and `Array.prototype.sort` is
 * stable — so if this function were handed a root-sorted list, a comparator that
 * returned zero on the sixth element would still produce the right answer, by
 * inheriting the input order. That is exactly the accidental ordering this slice
 * is supposed to remove: it would rest on the engine's sort being stable and on
 * a guarantee made in another module.
 *
 * So the tie-break is written out, and the test that pins it hands this function
 * a list in the *wrong* order. Dropping the sixth element, or comparing the
 * declared id instead of the root, both survive a root-ordered fixture and both
 * fail that one.
 */
export function planAcrossRepositories(
  repositories: readonly RegisteredRepository[],
  dependencies: CrossRepositoryPlanDependencies = {},
): CrossRepositoryPlan {
  const plan = dependencies.planNextTask ?? planNextTaskProduction;

  if (repositories.length === 0) {
    return conclusion('NO_REPOSITORIES_REGISTERED', null, [], []);
  }

  const plans: RepositoryPlan[] = [];
  const ranked: Array<{
    readonly candidate: CrossRepositoryCandidate;
    readonly key: CrossRepositoryRankingKey;
  }> = [];

  for (const registered of repositories) {
    const repository = registered.repository;
    const planned = plan(repository);
    if (!planned.ok) {
      // Nothing is published: not this repository's plan, not the plans of the
      // repositories that already succeeded, and no ranking. A partial set is
      // what this refusal exists to withhold.
      return conclusion('REPOSITORY_UNPLANNABLE', null, [], [], repository.root, planned.code);
    }

    const selection = planned.selection;
    plans.push(
      Object.freeze({
        repository,
        eligibility: selection.eligibility,
        ranking: selection.ranking,
      }),
    );

    for (const eligibility of selection.eligibility) {
      if (!eligibility.eligible) continue;
      const definition = planned.graph.node(eligibility.taskId)?.definition;
      // Not reachable through `planNextTask`, whose eligibility report is built
      // from the graph's own ids. Skipped rather than thrown on, for the reason
      // `taskRankingKey` gives about the same lookup: a plan must not become an
      // exception because a lookup missed.
      if (definition === undefined) continue;
      ranked.push({
        candidate: Object.freeze({ repository, task: definition, eligibility }),
        key: crossRepositoryRankingKey(eligibility, planned.graph, repository.root),
      });
    }
  }

  // `plans` is accumulated in the order this function was handed, and the
  // interface promises canonical-root order. Established here rather than
  // inherited from `resolveRegisteredRepositories`' sort, for the reason the
  // header gives about the ranking: a guarantee this function's own doc comment
  // makes, and that `render-repositories.ts` prints as a heading, may not rest
  // on the one production caller happening to pass a sorted list.
  //
  // Total on any list whose entries have distinct canonical roots. That is a
  // proviso on the input and not something this line establishes — unlike
  // `repository-registry.ts`, which sorts inside the very function that just
  // refused `DUPLICATE_REPOSITORY_ROOT`. The production caller reaches here
  // through that refusal; a caller that does not gets a tie, and a tie falls
  // back to the order it gave, here and in the ranking alike.
  plans.sort((a, b) => compareRepositoryRoots(a.repository.root, b.repository.root));

  ranked.sort((a, b) => compareCrossRepositoryKeys(a.key, b.key));

  const ranking = ranked.map((entry) =>
    Object.freeze({
      repositoryId: entry.candidate.repository.id,
      repositoryRoot: entry.candidate.repository.root,
      taskId: entry.candidate.task.id,
    }),
  );

  const best = ranked[0];
  if (best !== undefined) {
    return conclusion('TASK_SELECTED', best.candidate, plans, ranking);
  }

  // Nothing is eligible anywhere. The two ways that can happen are told apart
  // exactly as `selectNextTask` tells them apart, and over the union of every
  // repository's verdicts rather than over any one of them: `ALL_TASKS_COMPLETE`
  // is a finished plan, `NO_ELIGIBLE_TASK` is a stuck one.
  const everyTaskDone = plans.every((entry) =>
    entry.eligibility.every((verdict) => verdict.reason === 'ALREADY_DONE'),
  );
  return conclusion(everyTaskDone ? 'ALL_TASKS_COMPLETE' : 'NO_ELIGIBLE_TASK', null, plans, ranking);
}
