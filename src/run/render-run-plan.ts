/**
 * Console rendering for a run plan. Plain ASCII, no secrets, no colour deps.
 *
 * ── What may appear here ───────────────────────────────────────────────────
 *
 * Only values that have already passed a validating boundary:
 *
 *  - task ids (the id grammar is the reason an id is safe to hand onward);
 *  - closed vocabulary codes from the layers the plan composed;
 *  - the canonical repository root and repository id, both produced by
 *    `resolveRepository` and nothing else;
 *  - ISO timestamps the state contract validated.
 *
 * Task *titles*, file paths from findings, raw Git output and exception text
 * are not representable in a plan and therefore cannot be printed. The static
 * sentences below are written in this repository, in the same discipline as
 * `safe-error.ts`: nothing foreign is ever interpolated into them.
 */

import type { RunPlan, RunPlanConclusion } from './run-plan.js';

/**
 * The closing contract sentence, printed on every path that reports a plan —
 * including the CLI's resolution-failure path, which never reaches the
 * renderer. One constant rather than two literals: the sentence is a promise
 * about what the command did, and a promise spelled twice can drift.
 *
 * It says what the *orchestrator* did, and stops there. It deliberately does
 * not claim the repository is byte-identical afterwards, because that is not
 * this code's to promise: observing a worktree runs `git status`, and Git may
 * refresh that worktree's index as a side effect of being asked. No tracked
 * content, ref, branch or HEAD moves, and nothing this orchestrator owns is
 * written — which is the honest, narrower statement.
 */
export const READ_ONLY_TRAILER =
  'Read-only plan. No agent was started, no task state was written, no workspace was\n' +
  'created or modified. Observing a worktree may let Git refresh its own index.';

/** One static sentence per conclusion. Closed, and pinned by test. */
export const CONCLUSION_SENTENCES: Readonly<Record<RunPlanConclusion, string>> = Object.freeze({
  PLANNING_FAILED: 'The task source could not be read or normalised. Nothing can be planned.',
  ALL_TASKS_COMPLETE: 'Every task in the plan is DONE. There is nothing to run.',
  NO_ELIGIBLE_TASK: 'Open work exists but nothing is eligible to run.',
  TASK_ID_INVALID: 'The requested task id is not a valid task id. It was not looked up.',
  TASK_UNKNOWN: 'The requested task id names no task in this plan.',
  TASK_INELIGIBLE: 'The requested task exists but is not eligible to run.',
  TASK_NOT_STARTED:
    'No durable state exists for this task. Starting a task is not offered by this build.',
  TASK_COMPLETED: 'This task is finished (READY_FOR_PR) and is handed to a human from here.',
  TASK_ABORTED: 'This task was aborted. Nothing continues from an aborted task.',
  RECONCILED_IN_FLIGHT:
    'The durable record agrees with observed reality. A human may continue this task.',
  TASK_PARKED: 'This task is durably parked in a blocking state and needs an operator.',
  STATE_UNUSABLE:
    'The durable record is unusable here: broken, or an intact record of somewhere else.',
  STATE_DIVERGED: 'Observed reality contradicts the durable record. Nothing may continue.',
  STATE_UNOBSERVABLE: 'The repository could not be observed, so nothing may continue.',
});

function line(label: string, value: string): string {
  return `${label.padEnd(13)}: ${value}`;
}

function codes(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

/**
 * Renders one plan for the console. The trailing note is part of the contract:
 * a plan executes nothing, and the report says so every time rather than
 * assuming the operator remembers. See {@link READ_ONLY_TRAILER} for the exact
 * scope of that promise.
 */
export function renderRunPlan(plan: RunPlan, repository: { id: string; root: string }): string {
  const lines: string[] = [
    '',
    line('Repository', `${repository.id}  (${repository.root})`),
    line('Selection', plan.selection.code),
  ];

  if (plan.selection.planning.ok) {
    const { eligibility, ranking } = plan.selection.planning.selection;
    lines.push(line('Ranking', ranking.length === 0 ? 'empty' : ranking.join(' > ')));
    const ineligible = eligibility.filter((entry) => !entry.eligible);
    if (ineligible.length > 0) {
      lines.push('Ineligible   :');
      for (const entry of ineligible) {
        const waiting =
          entry.unsatisfiedDependencies.length > 0
            ? `; waiting on ${entry.unsatisfiedDependencies.join(', ')}`
            : '';
        lines.push(`  - ${entry.taskId}  [${entry.reason ?? 'UNKNOWN'}${waiting}]`);
      }
    }
  } else {
    // The planning failure's detail is a static sentence written in this
    // repository, and the offending task id — when one exists — has passed the
    // id grammar. Nothing else a discovery failure knows is printable.
    lines.push(line('Planning', `${plan.selection.planning.code} — ${plan.selection.planning.detail}`));
    if (plan.selection.planning.taskId !== null) {
      lines.push(line('Task file', plan.selection.planning.taskId));
    }
  }

  if (plan.target !== null) {
    lines.push(
      line(
        'Target',
        `${plan.target.taskId}  (${plan.target.source === 'NAMED' ? 'named by operator' : 'chosen by ranking'})`,
      ),
    );
  }

  if (plan.reconciliation !== null) {
    const state = plan.reconciliation.state;
    lines.push(
      line('State', state === null ? 'none persisted' : `${state.state}  (entered ${state.stateEnteredAt})`),
      line('Reconcile', plan.reconciliation.outcome),
    );
  }

  if (plan.brief !== null) {
    if (plan.brief.ok) {
      const { body, bodyTruncated, contextSources, contextComplete } = plan.brief.brief;
      const context =
        contextSources.length === 0
          ? 'no context declared'
          : `${contextSources.length} context source(s), ${contextComplete ? 'all present' : 'INCOMPLETE'}`;
      lines.push(
        line('Brief', `readable — ${body.length} chars${bodyTruncated ? ' (truncated)' : ''}; ${context}`),
      );
      // Only the ones that are not fine are named, and only by the path the
      // profile itself declared — a value the schema already constrained.
      for (const source of contextSources) {
        if (source.status !== 'PRESENT') {
          lines.push(`  - ${source.path}  [${source.status}]`);
        }
      }
    } else {
      lines.push(line('Brief', `${plan.brief.code} — ${plan.brief.detail}`));
    }
  }

  if (plan.resume !== null) {
    lines.push(line('Continuation', `${plan.resume.continuation}  (${plan.resume.classification})`));
  }

  lines.push(
    line('Reasons', codes(plan.reasonCodes)),
    '',
    `Conclusion   : ${plan.conclusion}`,
    `  ${CONCLUSION_SENTENCES[plan.conclusion]}`,
    '',
    READ_ONLY_TRAILER,
    '',
  );

  return lines.join('\n');
}
