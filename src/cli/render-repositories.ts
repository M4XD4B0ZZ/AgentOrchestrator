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
 */

import type {
  CrossRepositoryPlan,
  CrossRepositoryPlanCode,
} from '../plan/plan-across-repositories.js';
import type {
  RegistryResolutionFailure,
  RepositoryRegistryOutcome,
} from '../registry/repository-registry.js';

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
  'workspace and writes no task state. To act on one of these repositories, name it: ' +
  '`agent-loop run --repository <path>`.';

function line(label: string, value: string): string {
  return `${label.padEnd(16)}: ${value}`;
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
      line('Planning', plan.planningCode ?? '-'),
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
