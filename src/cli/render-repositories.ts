/**
 * The `repositories` report: what this operator enlisted, and what is next
 * across all of it (M2 slice 3).
 *
 * A pure function from the three values the command produces — the registry
 * read, the resolution and the cross-repository plan — to text. It opens no
 * file, starts no process and consults no clock, so the whole report can be
 * asserted on directly rather than inferred from a run.
 *
 * ── Both identities are always shown, and that is not decoration ───────────
 *
 * Every repository line carries its declared `repository.id` **and** its
 * canonical root. Two enlisted repositories may legitimately declare the same id
 * — two clones of one remote do — so a report that printed only the id could
 * show two identical lines for two different repositories. That is exactly the
 * indistinguishability this slice exists to remove, and it would be a poor
 * outcome to remove it from the value and reintroduce it in the text.
 *
 * The root is also the operator's route back to every other command: everything
 * that acts takes `--repository <path>`, and this report never acts, so the path
 * it prints is what the operator types next.
 *
 * ── It says what it did not print ──────────────────────────────────────────
 *
 * The merged ranking can hold one entry per eligible task in every enlisted
 * repository. The report shows its head — the selection — and each repository's
 * own first choice, and then states the total number of candidates. A report
 * that silently showed the first few would read as "this is all there is".
 *
 * ── Waiting work is named, because a count of the runnable does not explain ─
 *
 * Each repository line also carries how many of its tasks are blocked, and
 * names them with the prerequisites they wait for (M2 slice 4). Before that it
 * carried `eligible: N` and nothing else.
 *
 * The case that motivates it is `eligible: 1, blocked: 9`, not `eligible: 0`.
 * A first draft of this paragraph argued from the latter and a review measured
 * it unreachable: `eligible` is the length of that repository's own ranking, and
 * `select-task.ts` establishes that in a graph this build accepts an eligible
 * task exists whenever any task is not `DONE` — so `eligible: 0` means every
 * task is finished, and there is no waiting work to name. What an operator
 * actually meets is a repository offering one candidate while most of its plan
 * waits, and the old line said nothing about the nine.
 *
 * The value was already in hand either way: `RepositoryPlan.eligibility` carries
 * every verdict and its unsatisfied ids, and this report printed a count of the
 * eligible ones and dropped the rest.
 *
 * The single-repository plan has printed a blocked task's row since **V2-01**
 * (`run/render-run-plan.ts`; an earlier version of this sentence said V1-02,
 * which is the slice that built the selector and not the one that built that
 * report). What slice 3 added was a second report over the same planner, and
 * this diagnostic did not come with it. Nothing about *selection* changed:
 * blocked tasks were already absent from the merged ranking, and they still are.
 */

import type {
  CrossRepositoryPlan,
  CrossRepositoryPlanCode,
} from '../plan/plan-across-repositories.js';
import type { TaskEligibility } from '../plan/select-task.js';
import type {
  RegistryResolutionFailure,
  RepositoryRegistryOutcome,
} from '../registry/repository-registry.js';
import type {
  CrossRepositoryRunOutcome,
  CrossRepositoryRunResult,
} from '../run/repository-coordinator.js';

/** One sentence per plan outcome. Static; nothing is interpolated. */
export const CROSS_REPOSITORY_SENTENCES: Readonly<Record<CrossRepositoryPlanCode, string>> =
  Object.freeze({
    TASK_SELECTED: 'One task was selected across the enlisted repositories.',
    NO_REPOSITORIES_REGISTERED:
      'No repository is enlisted. This is a configuration to finish, not a finished plan.',
    ALL_TASKS_COMPLETE: 'Every task in every enlisted repository is DONE.',
    NO_ELIGIBLE_TASK:
      'Open work exists and nothing is eligible anywhere. Dependencies are unsatisfied.',
    REPOSITORY_UNPLANNABLE:
      'One enlisted repository could not be planned, so nothing was selected. A selection ' +
      'made over the repositories that happened to read cleanly would be a scheduling ' +
      'decision taken out of a configuration mistake.',
  });

const HEADING = 'agent-loop repositories';

/**
 * The trailer every rendering ends with.
 *
 * Stated on every report rather than only on the ones that selected something:
 * "this command does not act" is a property of the command, not of its answer,
 * and a reader who only ever sees the refusals should learn it too.
 */
export const REPOSITORIES_READ_ONLY_TRAILER =
  'This report acts on nothing. It acquires no execution lease, starts no agent, prepares no ' +
  'workspace and writes no task state. Execution needs `--attended` here, or ' +
  '`agent-loop run --repository <path> --attended` for one named repository.';

/**
 * The trailer every rendering of a cross-repository run ends with, whether or
 * not anything was admitted.
 *
 * ── Why the read-only trailer above does not say "the grant was not given" ──
 *
 * It did for one round, and it was wrong on three paths: this trailer is
 * printed by `renderRegistryOutcome` and `renderRegistryResolutionFailure` as
 * well, which are reached when the registry is missing, unusable, or names
 * something that will not resolve. An operator who typed `--attended` and hit
 * one of those was told the grant was withheld when it was given and the input
 * was the problem. The trailer says what execution *needs*, which is true
 * whether or not this invocation asked for it.
 *
 * ── What this one says, and what it deliberately does not ─────────────────
 *
 * It states that the destructive grants are not on this command and were not
 * taken. That is not decoration: an operator who has just watched a selector
 * choose what to start will reasonably wonder what else it may choose.
 *
 * It does **not** state the capacity. The `Capacity` row does, above it, from
 * the run's own value; a constant string cannot, and an earlier version of this
 * comment claimed it did.
 */
export const REPOSITORIES_RUN_TRAILER =
  'Every admission ran under the ordinary attended grant and nothing else. Recovering a stale ' +
  'lease, continuing a BLOCKED_VERIFY task and continuing a HUMAN_DECISION_REQUIRED task are ' +
  'not offered here and were not taken: those stay bound to a repository named on the command ' +
  'line with `agent-loop run --repository <path>`.';

function line(label: string, value: string): string {
  return `${label.padEnd(16)}: ${value}`;
}

/**
 * The most blocked tasks named per repository before the report summarises the
 * rest.
 *
 * A registry holds many repositories and a plan many tasks, so "print them all"
 * is a report of tens of thousands of lines for a configuration that is merely
 * large. The cap is a real bound rather than taste — and, per this module's own
 * rule about the ranking, what it drops it counts out loud.
 */
export const MAX_REPORTED_BLOCKED_TASKS = 8;

/**
 * The prerequisites named on one blocked task's row.
 *
 * Both caps are needed for the bound to be one. A review of the first draft
 * measured what capping only the rows leaves: a task may declare 64
 * dependencies of up to 128 characters, so one *row* could reach about 8 KB and
 * the report as a whole megabytes — a line count is not a size. The row cap
 * without this one is a sentence that promises a bound the code does not have.
 */
export const MAX_REPORTED_PREREQUISITES = 4;

/**
 * The waiting work of one repository, named.
 *
 * ── Only `BLOCKED_BY_DEPENDENCIES`, never `ALREADY_DONE` ───────────────────
 *
 * `select-task.ts` keeps those two reasons apart because "they mean opposite
 * things to an operator: `ALREADY_DONE` is finished work,
 * `BLOCKED_BY_DEPENDENCIES` is waiting work". A report that listed both under
 * one heading would put that distinction back together again, and every
 * finished task in a mature repository would drown the one prerequisite the
 * operator is actually looking for.
 *
 * ── Ids, and only ids ──────────────────────────────────────────────────────
 *
 * Every value printed here — the blocked task's id and each unsatisfied
 * dependency's id — has passed the grammar in `plan/task-id.ts`, which is
 * exactly the argument `task-graph.ts` makes for a failure being allowed to
 * carry one: no whitespace, no control character, no separator, no shell
 * metacharacter. No title, no path and no file content is printed, so this
 * block cannot become a channel for repository text.
 *
 * ── The row spelling is `render-run-plan.ts`'s, on purpose ────────────────
 *
 * The single-repository plan (V2-01) prints a blocked task as
 * `- <id>  [<reason>; waiting on <ids>]`, and that spelling is reused verbatim.
 * Inventing a second spelling for one fact would mean an operator reading both
 * reports had to learn the same thing twice, and the two would drift the first
 * time one was edited.
 *
 * The *report* is not that report, and the difference is deliberate rather than
 * an omission. `render-run-plan.ts` lists every ineligible task — `ALREADY_DONE`
 * included — under one heading and without a bound, because it describes one
 * repository an operator has just named. This describes every enlisted
 * repository at once, so it filters to the waiting ones and bounds what it
 * prints. Claiming to have copied that report "exactly" would contradict the
 * paragraph above, which calls listing both reasons together a defect.
 */
function blockedRows(eligibility: readonly TaskEligibility[]): readonly string[] {
  const blocked = eligibility.filter((entry) => entry.reason === 'BLOCKED_BY_DEPENDENCIES');
  if (blocked.length === 0) return [`    ${line('blocked', '0')}`];

  const rows = [`    ${line('blocked', String(blocked.length))}`];
  for (const entry of blocked.slice(0, MAX_REPORTED_BLOCKED_TASKS)) {
    rows.push(`      - ${entry.taskId}  [BLOCKED_BY_DEPENDENCIES${waitingClause(entry)}]`);
  }
  const hidden = blocked.length - Math.min(blocked.length, MAX_REPORTED_BLOCKED_TASKS);
  if (hidden > 0) rows.push(`      (and ${hidden} more, not shown)`);
  return rows;
}

/** The `; waiting on …` half of one blocked row, bounded and counted. */
function waitingClause(entry: TaskEligibility): string {
  const waiting = entry.unsatisfiedDependencies;
  if (waiting.length === 0) return '';
  const shown = waiting.slice(0, MAX_REPORTED_PREREQUISITES).join(', ');
  const hidden = waiting.length - Math.min(waiting.length, MAX_REPORTED_PREREQUISITES);
  return `; waiting on ${shown}${hidden > 0 ? ` (+${hidden} more)` : ''}`;
}

/** The registry read, rendered. Used for both its refusals and its success. */
export function renderRegistryOutcome(outcome: RepositoryRegistryOutcome, path: string): string {
  const head = [`${HEADING}`, '', line('Registry', path)];
  switch (outcome.state) {
    case 'NOT_REGISTERED':
      return [
        ...head,
        line('Status', 'NOT_REGISTERED'),
        '',
        'There is no registry file. Nothing is enlisted, which is not the same as an empty',
        'registry and not the same as no work: this build has not been told which repositories',
        'it may orchestrate.',
        '',
        REPOSITORIES_READ_ONLY_TRAILER,
        '',
      ].join('\n');
    case 'UNUSABLE':
      return [
        ...head,
        line('Status', 'UNUSABLE'),
        line('Refusal', outcome.code),
        '',
        'The registry exists and cannot be used, so nothing is enlisted. This is reported as',
        'its own outcome rather than as an empty registry: "nothing was enlisted" and "I could',
        'not tell what was enlisted" send a person to different places.',
        '',
        REPOSITORIES_READ_ONLY_TRAILER,
        '',
      ].join('\n');
    case 'REGISTERED':
      return [
        ...head,
        line('Status', 'REGISTERED'),
        line('Entries', String(outcome.entries.length)),
        line('Digest', outcome.registryDigest),
      ].join('\n');
  }
}

/** A resolution refusal, rendered. */
export function renderRegistryResolutionFailure(failure: RegistryResolutionFailure): string {
  const rows = [
    '',
    line('Resolution', 'REFUSED'),
    line('Refusal', failure.code),
    line('Entry index', failure.entryIndex === null ? '-' : String(failure.entryIndex)),
  ];
  if (failure.resolutionCode !== null) {
    rows.push(line('Repository', failure.resolutionCode));
  }
  return [
    ...rows,
    '',
    failure.detail,
    '',
    // The index and not the path, deliberately: the refusal value carries no
    // path, because a refusal in this build is never a channel for the value it
    // refused. The operator has the file; the index names the line.
    'The entry index counts from zero, in the order the registry file lists them.',
    '',
    REPOSITORIES_READ_ONLY_TRAILER,
    '',
  ].join('\n');
}

/** The cross-repository plan, rendered. */
export function renderCrossRepositoryPlan(plan: CrossRepositoryPlan): string {
  const rows: string[] = ['', line('Plan', plan.code)];

  if (plan.code === 'REPOSITORY_UNPLANNABLE') {
    rows.push(
      line('Failed at', plan.failedRepositoryRoot ?? '-'),
      // Code and sentence together, in `render-run-plan.ts`'s spelling. The
      // sentence is the half that says what the refusal *means*, and for a
      // dependency refusal it is the policy itself — this report printed the
      // bare enum until M2 slice 4.
      line(
        'Planning',
        plan.planningDetail === null
          ? (plan.planningCode ?? '-')
          : `${plan.planningCode ?? '-'} — ${plan.planningDetail}`,
      ),
    );
  }

  if (plan.selected !== null) {
    rows.push(
      '',
      'Selected',
      `  ${line('task', plan.selected.task.id)}`,
      `  ${line('title', plan.selected.task.title)}`,
      `  ${line('repository', plan.selected.repository.id)}`,
      `  ${line('root', plan.selected.repository.root)}`,
      `  ${line('branch', plan.selected.repository.defaultBranch)}`,
    );
  }

  if (plan.plans.length > 0) {
    rows.push('', `Enlisted repositories (${plan.plans.length}), in canonical root order`);
    for (const entry of plan.plans) {
      // Each repository's own first choice, from its own ranking — the value the
      // single-repository planner would have given for it, unchanged.
      const first = entry.ranking[0] ?? '-';
      rows.push(
        `  ${entry.repository.id}`,
        `    ${line('root', entry.repository.root)}`,
        `    ${line('first choice', first)}`,
        `    ${line('eligible', String(entry.ranking.length))}`,
        ...blockedRows(entry.eligibility),
      );
    }
  }

  rows.push(
    '',
    line('Candidates', String(plan.ranking.length)),
    '',
    CROSS_REPOSITORY_SENTENCES[plan.code],
    '',
    REPOSITORIES_READ_ONLY_TRAILER,
    '',
  );
  return rows.join('\n');
}

/** One sentence per coordinator outcome. Static; nothing is interpolated. */
export const CROSS_REPOSITORY_RUN_SENTENCES: Readonly<
  Record<CrossRepositoryRunOutcome, string>
> = Object.freeze({
  RUN_COMPLETE:
    'Every admitted task was driven to an ending and nothing further was admissible. What each ' +
    'one came to is above; this line says only that the run finished.',
  NOTHING_ADMITTED:
    'Nothing was ever admissible. The planner’s own answer is on the Plan line, and it is the ' +
    'answer a read-only report would have given.',
  PLANNING_REFUSED_MIDRUN:
    'Planning refused after work had already been admitted. Everything admitted was awaited and ' +
    'nothing further was started; the configuration now needs a look.',
  CAPACITY_INVALID:
    'The concurrency bound is not a usable one. Nothing was planned and nothing ran.',
  ADMISSION_BUDGET_EXHAUSTED:
    'The admission ceiling was reached. Everything admitted was awaited; more work may remain, ' +
    'and another invocation continues.',
});

/**
 * A cross-repository run, rendered.
 *
 * Admissions in **admission** order, which is the coordinator's own ordering and
 * not the order they finished in: the report has to be the same document for the
 * same starting state, and completion order is decided by how long each
 * repository's work took.
 */
export function renderCrossRepositoryRun(result: CrossRepositoryRunResult): string {
  const rows: string[] = [
    '',
    line('Run', result.outcome),
    line('Plan', result.planCode ?? '-'),
    line('Capacity', String(result.capacity)),
    // The product's own measurement, printed rather than inferred. "2" here is
    // the coordinator saying two repositories were admitted and neither had
    // settled — which is what "concurrently" means, and is not a claim anybody
    // has to reconstruct from timings.
    line('Peak concurrency', String(result.maxObservedConcurrency)),
    line('Planning passes', String(result.passes)),
    line('Admissions', String(result.admissions.length)),
  ];

  if (result.reasonCodes.length > 0) {
    rows.push(line('Reasons', result.reasonCodes.join(', ')));
  }

  for (const admission of result.admissions) {
    rows.push(
      '',
      `  #${String(admission.sequence)} ${admission.repositoryId}`,
      `    ${line('root', admission.repositoryRoot)}`,
      `    ${line('task', admission.taskId)}`,
      `    ${line('concurrent', String(admission.concurrencyAtAdmission))}`,
      // A throw has no outcome to print, and printing one anyway — even a
      // reassuring dash under an "Outcome" label — is how an ending with no
      // report gets read as an ending with a nominal one.
      admission.threw || admission.lifecycle === null
        ? `    ${line('outcome', 'UNREPORTED — driving this task threw')}`
        : `    ${line('outcome', admission.lifecycle.outcome)}`,
    );
    if (admission.lifecycle !== null && admission.lifecycle.reasonCodes.length > 0) {
      rows.push(`    ${line('reasons', admission.lifecycle.reasonCodes.join(', '))}`);
    }
  }

  rows.push(
    '',
    CROSS_REPOSITORY_RUN_SENTENCES[result.outcome],
    '',
    REPOSITORIES_RUN_TRAILER,
    '',
  );
  return rows.join('\n');
}
