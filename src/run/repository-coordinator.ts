/**
 * Bounded, deterministic execution across several repositories (M2 slice 5).
 *
 * Three sentences, and this module is answerable for all three:
 *
 *   > Different repositories may execute concurrently.
 *   > The same repository must never receive overlapping owned task execution.
 *   > Global concurrency must be bounded and deterministic.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It is not a scheduler. There is no queue that outlives the call, no timer, no
 * poll, no persistence, no backoff and no fairness policy. It holds an active
 * set and a capacity, it asks the existing planner what is next, and it awaits
 * the existing lifecycle driver. When the last admission settles it returns.
 *
 * It also invents no priority. `plan/plan-across-repositories.ts` publishes a
 * merged ranking; this walks that ranking in the order it was published. The
 * one decision made here that the ranking does not already make is *which
 * candidates are admissible right now*, and that decision only ever **skips**.
 *
 * ── The exclusion key is the lease's own key ───────────────────────────────
 *
 * A repository is "already executing" when its canonical Git **common
 * directory** is in the active set — the same key
 * `lease/execution-lease.ts` derives a lease path from, compared with the same
 * `comparePathIdentity` the registry's own duplicate refusals use.
 *
 * Not the root, and not `repository.id`. Two worktrees of one clone share a
 * common directory and are one writer; two clones of one remote share an id and
 * are two. Keying on anything else would let the coordinator's policy and the
 * lease's authority disagree, and the lease is the authority.
 *
 * ── Which is to say: this module does not enforce the exclusion ────────────
 *
 * It avoids **wasting a slot** on work the lease would refuse anyway. If every
 * admission rule here were deleted, two tasks of one repository admitted
 * together would still not both execute: the second `acquireRepositoryExecutionLease`
 * meets the first's lease file, probes its owner — this very process, alive —
 * and refuses `LEASE_HELD`. That is measured in
 * `tests/m2-05-cross-repository-concurrency.test.ts` by removing the rule.
 *
 * Saying which layer holds a safety property matters more than restating it: a
 * reader who believes the active set is the guarantee will look for the wrong
 * gate when it changes.
 *
 * ── Every admission runs in its own execution domain ───────────────────────
 *
 * Each admitted lifecycle is wrapped in `runInOwnedLaunchDomain`, so the owned
 * subprocesses it starts are announced to its epoch's accountant and to no
 * other. Without that wrap a launch of repository A lands in repository B's
 * durable owned-launch register — measured on the pre-change build, with A's
 * helper and child pids written into B's Git directory — which makes B's
 * register a lie, lets B's disk refuse A's next subprocess, and can reach a
 * discard of B's own launch document. See
 * `boundary/owned-launch-accounting.ts` and the slice's decision record.
 *
 * The lease acquisition happens *inside* that wrap, and reads the domain for
 * itself. Nothing about the lease's call signature changes.
 *
 * ── Termination is proved rather than bounded by a guess ───────────────────
 *
 * A `(repository, task)` pair is admitted **at most once per run**. The
 * candidate set is finite, so the loop ends. That rule is also what makes a
 * completed task step aside for its repository's next one: eligibility comes
 * from a task file's own `status`, which a lifecycle run does not rewrite, so a
 * finished task stays at the head of its repository's ranking and would
 * otherwise be admitted for ever. `block/block-runner.ts` reached the same shape
 * for the same reason and calls its version a ledger.
 *
 * {@link MAX_COORDINATOR_ADMISSIONS} is a floor **under** that argument, not the
 * argument. If it is ever reached, something the argument assumed is false, and
 * the run stops and says so rather than continuing on the strength of it.
 *
 * ── A settled promise is the release, and nothing earlier is ───────────────
 *
 * A slot is freed when the admitted `driveLifecycle` promise settles — resolved
 * *or* rejected. That instant is strictly after `driveLifecycle` has given the
 * lease back (it releases through `finish`, and through a `catch` that rethrows
 * when `finish` did not run) and after `doctor/exec.ts`'s own `finally` has
 * closed every owned launch of the epoch. Freeing at launch, or on the success
 * path only, is what would let the next admission of that repository overlap the
 * previous one.
 *
 * ── One rejection may not abandon the others ───────────────────────────────
 *
 * `driveLifecycle` never throws for an expected condition, and this module does
 * not rely on that: every admission is wrapped so that a throw becomes a settled
 * record. A rejection that escaped here would leave the sibling epochs' promises
 * unawaited, and the process would exit with their leases held and their
 * subprocesses running.
 */

import {
  createOwnedLaunchDomain,
  runInOwnedLaunchDomain,
} from '../boundary/owned-launch-accounting.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import { comparePathIdentity } from '../core/path-identity.js';
import {
  planAcrossRepositories as planAcrossRepositoriesProduction,
  type CrossRepositoryPlan,
  type CrossRepositoryPlanCode,
} from '../plan/plan-across-repositories.js';
import type { RegisteredRepository } from '../registry/repository-registry.js';
import { MAX_CONCURRENT_REPOSITORIES } from '../registry/repository-registry.js';
import type { ResolvedRepository } from '../repo/resolve-repository.js';
import type { AgentRunner } from '../agent/agent-command.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import type { GitRunner } from '../worktree/git-command.js';
import {
  driveLifecycle as driveLifecycleProduction,
  type LifecycleResult,
} from './lifecycle-driver.js';

/**
 * The most admissions one coordinator run will make.
 *
 * A runaway guard in the spirit of `maxSteps` and `maxInvocations`, and not the
 * termination argument — see the header. A registry may hold 256 repositories,
 * each with many tasks, so this is deliberately generous: it exists to stop a
 * loop that has stopped meaning what it was written to mean, not to bound a
 * legitimate run.
 */
export const MAX_COORDINATOR_ADMISSIONS = 4096;

/** What a whole coordinator run came to. A closed set. */
export const CROSS_REPOSITORY_RUN_OUTCOMES = [
  /**
   * At least one task was admitted, every admission settled, and nothing
   * remained admissible.
   *
   * It says nothing about whether the work *succeeded* — each admission carries
   * its own `LifecycleResult`, and the exit code is taken from the worst of
   * them. A run in which every task refused is still `RUN_COMPLETE`: the
   * coordinator did what it is for.
   */
  'RUN_COMPLETE',
  /**
   * Nothing was ever admissible, and the planner's own reason is carried in
   * {@link CrossRepositoryRunResult.planCode}.
   *
   * Deliberately one member rather than four: `NO_REPOSITORIES_REGISTERED`,
   * `ALL_TASKS_COMPLETE`, `NO_ELIGIBLE_TASK` and `REPOSITORY_UNPLANNABLE` are
   * the planner's vocabulary and are reported *as* the planner's, through
   * `planCode`, rather than copied into a second one that could drift from it.
   */
  'NOTHING_ADMITTED',
  /**
   * Planning refused **after** work had already been admitted. Everything
   * admitted was awaited; nothing further was.
   *
   * Its own member because it is not the same event as never having started: an
   * operator has runs on disk and a configuration that has since become
   * unreadable, and folding it into `NOTHING_ADMITTED` would say the opposite.
   */
  'PLANNING_REFUSED_MIDRUN',
  /**
   * The capacity is not a usable bound. Nothing was planned and nothing ran.
   *
   * Reachable only from a caller that did not take its capacity from
   * `loadRepositoryRegistry`, whose schema already refuses every value this
   * would catch. Kept because a floor that is unreachable today is the one that
   * catches tomorrow's second caller — and because a capacity of `0` reaching a
   * loop that admits "while active < capacity" is a run that silently does
   * nothing.
   */
  'CAPACITY_INVALID',
  /** {@link MAX_COORDINATOR_ADMISSIONS} was reached. Everything admitted was awaited. */
  'ADMISSION_BUDGET_EXHAUSTED',
] as const;

export type CrossRepositoryRunOutcome = (typeof CROSS_REPOSITORY_RUN_OUTCOMES)[number];

/** One admitted task, and what became of it. */
export interface AdmissionRecord {
  /** The declared logical id. Display and correlation; never the identity. */
  readonly repositoryId: string;
  /** The canonical root. Unambiguous where the id is not. */
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** Admission order, from 1. Deterministic given the same on-disk state. */
  readonly sequence: number;
  /**
   * How many execution **slots** this run held at the instant this one was
   * admitted, counting this one. Never greater than the capacity.
   *
   * A slot is held from admission until {@link reap} frees it, and `reap` frees
   * every execution that has settled — so this is the number of repositories
   * admitted and not yet seen to end. It is an *upper bound* on how many were
   * still running: an execution that settles between one sweep and the next is
   * still holding its slot, and the number says so rather than pretending to
   * observe the machine.
   *
   * That distinction is deliberate and was a review finding. The field is
   * evidence of overlap and it is not the only evidence: the tests that claim
   * two repositories ran at once hold both inside a barrier, so what makes them
   * simultaneous is program order rather than this counter. What this adds is
   * that the *product* says so too, without anybody inferring it from a clock.
   */
  readonly concurrencyAtAdmission: number;
  /**
   * The lifecycle's answer, or `null` when the call threw.
   *
   * `null` is not "nothing happened": the lease, the workspace and the task
   * state may all have been touched. It means this layer has no report to give,
   * which is why {@link threw} exists beside it rather than being inferred from
   * a null.
   */
  readonly lifecycle: LifecycleResult | null;
  /** Whether `driveLifecycle` threw. See {@link lifecycle}. */
  readonly threw: boolean;
}

export interface CrossRepositoryRunResult {
  readonly outcome: CrossRepositoryRunOutcome;
  /**
   * The planner's own code from the **last** plan taken, or `null` when
   * capacity refused before any planning happened.
   */
  readonly planCode: CrossRepositoryPlanCode | null;
  /** Every admission, in admission order. */
  readonly admissions: readonly AdmissionRecord[];
  /** How many planning passes were taken. One per completion, plus the first. */
  readonly passes: number;
  /**
   * The largest {@link AdmissionRecord.concurrencyAtAdmission} of the run, or 0
   * when nothing was admitted. Never greater than the capacity.
   */
  readonly maxObservedConcurrency: number;
  /** The capacity this run was bound by. Echoed so a report need not re-derive it. */
  readonly capacity: number;
  /** Stable codes explaining the outcome. Empty when there is nothing to explain. */
  readonly reasonCodes: readonly string[];
}

export interface CrossRepositoryRunRequest {
  /**
   * The enlisted repositories, already resolved, in the registry's canonical
   * order. This module resolves nothing and re-orders nothing.
   */
  readonly repositories: readonly RegisteredRepository[];
  /** How many repositories may execute at once. `1..{@link MAX_CONCURRENT_REPOSITORIES}`. */
  readonly maxConcurrentRepositories: number;
  /** The step budget handed to each lifecycle. */
  readonly maxSteps: number;
  /** The invocation budget handed to each lifecycle. */
  readonly maxInvocations: number;
}

export interface CrossRepositoryRunDependencies {
  /** The clock. Read per durable write, never frozen for the run. */
  readonly now: () => string;
  /** Git. Required and never defaulted, so a test never reaches a real repository. */
  readonly git: GitRunner;
  /**
   * The auth preflight, shared by **every** admitted repository.
   *
   * One memo for the whole run rather than one per repository, and the reason is
   * already written down in `cli/run-command.ts`: "Two memoising preflights in
   * one binary are two chances for one invocation to start the subscription CLIs
   * twice." Several repositories in one process is exactly that hazard, times
   * the capacity.
   */
  readonly authPreflight: () => Promise<AuthPreflightEvidence | null>;
  /** Execution seams, forwarded to every lifecycle. */
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
  /**
   * The planner. Production passes nothing.
   *
   * A seam because a test has to be able to change what is eligible **between
   * passes** without editing files a concurrent run is reading.
   */
  readonly planAcrossRepositories?: (
    repositories: readonly RegisteredRepository[],
  ) => CrossRepositoryPlan;
  /**
   * The lifecycle. Production passes nothing.
   *
   * A seam because forcing a real overlap window needs a barrier inside the
   * driven work, and because the alternative — proving concurrency from wall
   * clock time — proves nothing. It does **not** replace the real thing:
   * `tests/m2-05-cross-repository-concurrency.test.ts` also drives real
   * repositories through the production `driveLifecycle`, because an injected
   * runner can prove how this module *classifies* an answer and never that a
   * lease was taken.
   */
  readonly driveLifecycle?: typeof driveLifecycleProduction;
}

/** One repository executing right now. */
interface ActiveExecution {
  /** The lease's own key. The exclusion subject. */
  readonly gitCommonDir: string;
  /**
   * Settles — never rejects — when the lifecycle settles, with this same entry.
   *
   * Resolving to the entry is what lets `Promise.race` say *which* execution
   * finished without a second lookup on a value that could collide: two
   * admissions of one repository cannot both be active, but two admissions with
   * the same task id in different repositories can, and a race keyed on either
   * would pick the wrong one.
   *
   */
  readonly settled: Promise<ActiveExecution>;
  /** Whether the driver has settled. Written before {@link settled} resolves. */
  readonly isDone: () => boolean;
  readonly record: () => AdmissionRecord;
}

function result(
  from: Partial<CrossRepositoryRunResult> & { readonly outcome: CrossRepositoryRunOutcome },
): CrossRepositoryRunResult {
  return Object.freeze({
    planCode: null,
    admissions: Object.freeze([]),
    passes: 0,
    maxObservedConcurrency: 0,
    capacity: 0,
    reasonCodes: Object.freeze([]),
    ...from,
  });
}

/**
 * Whether two absolute paths name the same thing.
 *
 * Not called `samePath`, and the name is load-bearing rather than a preference:
 * `tests/v2-02-remediation.test.ts` sweeps `src/` for modules that define a
 * function of that name, because three copies of one containment chain once
 * shipped under it. This is not that chain — it is one line of delegation to
 * `core/path-identity.ts` — and taking the name would have added a module with
 * nothing to do with containment to a list whose whole job is to be short.
 *
 * `comparePathIdentity` rather than `===`, so the comparison is the one the
 * registry's own duplicate refusals and `core/path-identity.ts` make, and a
 * non-absolute operand is not silently equal to anything.
 *
 * The verdict must be `EQUAL` rather than "not `DIFFERENT`": this answers *are
 * these the same repository*, and a pair this build cannot compare is not an
 * answer of yes. The registry's sweeps take the opposite reading of the same
 * three-valued verdict, because they ask whether two entries were **told
 * apart** — an unanswerable pair fails that and must fail this. Getting it
 * backwards here would exclude a repository nothing is running, and getting it
 * backwards there would admit two spellings of one.
 */
function sameCanonicalPath(a: string, b: string): boolean {
  return comparePathIdentity(a, b) === 'EQUAL';
}

/** The task key an attempt is remembered under. Root and id, never id alone. */
function attemptKey(repositoryRoot: string, taskId: string): string {
  // A separator no path and no task id may contain. `path` accepts neither a NUL
  // (the registry refuses one) nor does `isValidTaskId`, so this cannot be made
  // to collide by naming a task after a path.
  return `${repositoryRoot}\u0000${taskId}`;
}

/**
 * Drives up to `maxConcurrentRepositories` repositories at once until nothing is
 * admissible.
 *
 * Never throws for an expected condition, including a throw out of the
 * lifecycle. Every refusal arrives as data.
 */
export async function driveRepositories(
  request: CrossRepositoryRunRequest,
  deps: CrossRepositoryRunDependencies,
): Promise<CrossRepositoryRunResult> {
  const capacity = request.maxConcurrentRepositories;
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_CONCURRENT_REPOSITORIES
  ) {
    return result({ outcome: 'CAPACITY_INVALID', reasonCodes: ['MAX_CONCURRENT_REPOSITORIES_INVALID'] });
  }

  const plan = deps.planAcrossRepositories ?? planAcrossRepositoriesProduction;
  const drive = deps.driveLifecycle ?? driveLifecycleProduction;

  const admissions: AdmissionRecord[] = [];
  const attempted = new Set<string>();
  const active: ActiveExecution[] = [];
  let passes = 0;
  let admitted = 0;
  let maxObservedConcurrency = 0;
  let planCode: CrossRepositoryPlanCode | null = null;
  let budgetExhausted = false;
  let refusedMidRun = false;

  /**
   * Awaits at least one settlement, then frees the slot of **every** execution
   * that has settled and keeps its record.
   *
   * Every settled one and not only the race's winner, and that is a correction
   * rather than an optimisation. Freeing one per call leaves a finished
   * execution occupying a slot until some later call happens to name it, so
   * `active.length` — which is the capacity bound *and* the number this run
   * reports as its measured concurrency — counts executions that are over. The
   * bound stayed safe either way (it can only over-count, so it under-admits),
   * and the reported number did not: a review found `concurrencyAtAdmission`
   * documented as "neither had settled" while being able to say 2 when one had.
   */
  const reap = async (): Promise<void> => {
    const finished = await Promise.race(active.map((entry) => entry.settled));
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const entry = active[index];
      if (entry === undefined) continue;
      // The race's winner is removed **unconditionally**, because its promise
      // resolving is what settlement means — asking its flag as well would make
      // this loop's progress depend on two mechanisms agreeing. They do agree,
      // and a mutation campaign showed what it costs if they ever stopped: with
      // the flag alone, an entry that had settled and did not say so was never
      // removed, `active` never emptied, and the run span forever rather than
      // failing. A loop whose exit condition is a flag needs the flag to be
      // right; this one needs only the promise it awaited.
      if (entry !== finished && !entry.isDone()) continue;
      active.splice(index, 1);
      admissions.push(entry.record());
    }
  };

  /**
   * The planner's own thrown error, kept so it can be rethrown after the drain.
   *
   * `planAcrossRepositories` documents that it never throws for an expected
   * condition, and this does not rely on that. An unexpected throw escaping the
   * loop would abandon every sibling epoch's promise unawaited — which is the
   * one thing this module's header promises cannot happen — so the throw is
   * caught, admissions stop, everything in flight is awaited, and only then is
   * it rethrown unchanged. Swallowing it would be worse than either: a defect
   * in the planner would read as a run that simply found nothing to do.
   */
  let plannerThrew: unknown = undefined;
  let plannerDidThrow = false;

  for (;;) {
    let current: CrossRepositoryPlan;
    try {
      current = plan(request.repositories);
    } catch (error: unknown) {
      plannerThrew = error;
      plannerDidThrow = true;
      break;
    }
    passes += 1;
    planCode = current.code;

    if (current.code === 'REPOSITORY_UNPLANNABLE') {
      // Nothing further is admitted. What is already running is still awaited
      // below: abandoning a live epoch to report a configuration problem would
      // leave a lease held by a process that has stopped looking at it.
      //
      // On `admitted` — what was started — rather than on `admissions.length`,
      // which is what has *settled*.
      //
      // The two are equal here today, and the claim that they differ was wrong
      // and was measured wrong: a mutation swapping them survived the whole
      // suite. The proof of equivalence is the loop's own shape — a second pass
      // is reached only through `await reap()`, and `reap` pushes **at least
      // one** record, because the entry whose `settled` won the race has had its
      // settlement flag set in an earlier continuation and so is always swept.
      // On any pass after the first, `admissions.length >= 1` exactly when
      // `admitted >= 1`; on the first pass both are 0.
      //
      // It is still written this way, because the question is *was anything
      // started* and `admitted` is the variable that answers it. A future
      // change that admits without reaping between passes would keep this line
      // meaning what it says and would silently break the other spelling.
      if (admitted > 0) refusedMidRun = true;
      break;
    }

    // Admit into every free slot this pass can fill, walking the merged ranking
    // in the order it was published. At most one candidate per repository,
    // because an admitted one joins `active` immediately and the exclusion below
    // then sees it.
    for (const entry of current.ranking) {
      if (active.length >= capacity) break;
      const key = attemptKey(entry.repositoryRoot, entry.taskId);
      if (attempted.has(key)) continue;

      // After the `attempted` skip, not before it. A candidate this run has
      // already driven consumes no budget, so a run that finished everything
      // does not report having been stopped by a ceiling it merely walked past.
      if (admitted >= MAX_COORDINATOR_ADMISSIONS) {
        budgetExhausted = true;
        break;
      }

      const repository = repositoryOf(current, entry.repositoryRoot);
      // Not reachable through `planAcrossRepositories`, whose ranking is built
      // from the same `plans` this looks in. Skipped rather than thrown on, for
      // the reason the planner gives about the same class of lookup: a run must
      // not become an exception because a lookup missed.
      if (repository === null) continue;

      // The exclusion, and it is the whole of the second sentence this module is
      // answerable for. On the Git common directory — the lease's own key —
      // never on the root and never on `repository.id`.
      if (active.some((held) => sameCanonicalPath(held.gitCommonDir, repository.gitCommonDir))) continue;

      attempted.add(key);
      admitted += 1;
      active.push(
        admit(
          repository,
          entry.taskId,
          entry.repositoryId,
          admitted,
          active.length + 1,
          request,
          deps,
          drive,
        ),
      );
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active.length);
    }

    // Nothing is running, so nothing can become admissible by finishing. Either
    // this pass admitted nothing at all, or the budget stopped it.
    if (active.length === 0) break;
    if (budgetExhausted) break;

    // Wait for at least one to finish, then plan again. Not a poll: the wake-up
    // is the completion itself, so a pass happens per completion rather than per
    // interval, and a run with nothing to do consumes no CPU waiting for it.
    // Measured: three repositories with 700 ms of work each, capacity 1 — four
    // planning passes for three admissions, and 0 ms of process CPU across 2.1
    // seconds of wall clock.
    await reap();
  }

  // Drain. Reached on the three paths that stop admitting with work still in
  // flight — a mid-run planning refusal, the admission budget, and a planner
  // that threw. Before the rethrow, deliberately.
  while (active.length > 0) await reap();

  if (plannerDidThrow) throw plannerThrew;

  // Admission order, not completion order. `admissions` is filled as work
  // settles, and that order is decided by how long each repository's work took:
  // two runs over the same state would print two different documents.
  admissions.sort((a, b) => a.sequence - b.sequence);

  const outcome: CrossRepositoryRunOutcome = budgetExhausted
    ? 'ADMISSION_BUDGET_EXHAUSTED'
    : refusedMidRun
      ? 'PLANNING_REFUSED_MIDRUN'
      : admitted === 0
        ? 'NOTHING_ADMITTED'
        : 'RUN_COMPLETE';

  return result({
    outcome,
    planCode,
    admissions: Object.freeze(admissions),
    passes,
    maxObservedConcurrency,
    capacity,
    // The planner's own code, carried as a reason rather than restated: a
    // mid-run refusal is only useful to an operator if it says which refusal.
    reasonCodes: Object.freeze(
      budgetExhausted
        ? ['MAX_COORDINATOR_ADMISSIONS_REACHED']
        : refusedMidRun && planCode !== null
          ? [planCode]
          : [],
    ),
  });
}

/**
 * The resolved repository behind a ranking entry, from the plan's own `plans`.
 *
 * Looked up in the plan rather than in `request.repositories`, so the value
 * admitted is the one the planner planned. A second lookup against the caller's
 * list would be a second read of the same question, and this build has paid for
 * that shape before: a gate that proves repository A while the effect lands in
 * repository B.
 */
function repositoryOf(plan: CrossRepositoryPlan, repositoryRoot: string): ResolvedRepository | null {
  for (const entry of plan.plans) {
    if (sameCanonicalPath(entry.repository.root, repositoryRoot)) return entry.repository;
  }
  return null;
}

/**
 * Starts one repository's lifecycle in its own execution domain.
 *
 * The record is built when the promise settles and read afterwards, so a caller
 * cannot observe a half-finished admission.
 */
function admit(
  repository: ResolvedRepository,
  taskId: string,
  repositoryId: string,
  sequence: number,
  concurrencyAtAdmission: number,
  request: CrossRepositoryRunRequest,
  deps: CrossRepositoryRunDependencies,
  drive: typeof driveLifecycleProduction,
): ActiveExecution {
  // One box rather than three closed-over `let`s, so that the settlement flag is
  // written in the *first* continuation after the driver settles — before the
  // promise the caller races on resolves. `reap` sweeps on that flag, and a flag
  // set a turn later would leave a finished execution counted as running.
  const state: { lifecycle: LifecycleResult | null; threw: boolean; done: boolean } = {
    lifecycle: null,
    threw: false,
    done: false,
  };

  // `(async () => …)()` and not a bare call, so a driver that throws
  // **synchronously** becomes a rejected promise instead of an exception out of
  // this function. `driveLifecycle` is an `async function` and cannot do it;
  // the injected seam is somebody else's code and can, and a throw here would
  // escape the admission loop and abandon every sibling epoch unawaited.
  //
  // The wrap is inside the domain, so the driver still runs inside it.
  const started = runInOwnedLaunchDomain(createOwnedLaunchDomain(), async () =>
    drive(
      {
        repository,
        taskId,
        // The grant, and only this one. `run --attended` means an operator
        // started this foreground process and can stop it, and that is exactly
        // what is true here. The three grants that authorise a *destructive*
        // departure — stale-lease recovery, verify remediation and continuing a
        // human decision — are not offered by the command that reaches this and
        // are hard-refused here, so a selector can never become the subject of
        // one.
        continuationGrant: 'ATTENDED',
        remediateVerifyFailure: false,
        continueHumanDecision: false,
        continueUsageLimit: false,
        recoverStaleLease: false,
        maxSteps: request.maxSteps,
        maxInvocations: request.maxInvocations,
      },
      {
        now: deps.now,
        git: deps.git,
        authPreflight: deps.authPreflight,
        ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
        ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
      },
    ),
  );

  // Attached **before** the entry exists, so the failure handler is on the
  // promise from the first turn of the loop. A `driveLifecycle` that rejected
  // synchronously-enough while this function was still building its record would
  // otherwise be an unhandled rejection.
  //
  // Swallowed here and reported as `threw`. A rejection escaping this function
  // would reject the `Promise.race` in the caller and leave every sibling epoch
  // unawaited — the process would exit holding their leases and their
  // subprocesses running.
  const outcome = started.then(
    (value) => {
      state.lifecycle = value;
      state.done = true;
    },
    () => {
      state.threw = true;
      state.done = true;
    },
  );

  const entry: ActiveExecution = {
    gitCommonDir: repository.gitCommonDir,
    // The promise resolves to the entry that carries it, which is what lets
    // `Promise.race` say *which* execution finished. Naming `entry` inside its
    // own initialiser is safe and not a trick: the callback is a `.then`
    // continuation, so it cannot run before this statement completes, however
    // long ago `outcome` settled. An earlier version assigned a cast placeholder
    // and overwrote it on the next line — unobservable, and a lie in the type.
    settled: outcome.then(() => entry),
    isDone: () => state.done,
    record: () =>
      Object.freeze({
        repositoryId,
        repositoryRoot: repository.root,
        taskId,
        sequence,
        concurrencyAtAdmission,
        lifecycle: state.lifecycle,
        threw: state.threw,
      }),
  };
  return entry;
}
