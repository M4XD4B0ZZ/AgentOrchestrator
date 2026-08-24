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
 *  - ISO timestamps the state contract validated;
 *  - the delivery target, which is three values that each passed their own
 *    grammar — a host, an owner and a repository name — plus a remote name the
 *    profile contract accepted. The URL they were parsed out of is not
 *    representable here, because `DeliveryTargetResult` never carries one: a
 *    remote URL is the value most likely to hold a credential, and this is a
 *    console the operator reads and pastes.
 *
 * Task *titles*, file paths from findings, raw Git output and exception text
 * are not representable in a plan and therefore cannot be printed. The static
 * sentences below are written in this repository, in the same discipline as
 * `safe-error.ts`: nothing foreign is ever interpolated into them.
 */

import {
  DELIVERY_TARGET_DETAIL,
  type ResolvedDelivery,
} from '../deliver/delivery-target.js';
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
 * The delivery line.
 *
 * Three shapes, and the middle one is the point of the whole slice: a resolved
 * target is printed as the identity itself, so an operator can see *which*
 * repository this checkout would deliver to before anything is built that
 * delivers to it. A refusal prints its closed code and the static sentence that
 * describes it — never Git's output, and never the URL.
 *
 * The trailing clause is not decoration. **A plan** resolves the delivery
 * identity and delivers nothing — it pushes no branch, opens no pull request and
 * merges nothing — and a line that named a forge repository without saying so
 * would read as a claim that it does. The clause is about this command. What
 * `agent-loop delivery` can change on a forge is that command's own contract,
 * and it grew at V4 slices 5, 6 and 7; an earlier version of this sentence said
 * "this build" rather than "a plan", which was already false when slice 5
 * shipped a push.
 */
export function renderDeliveryLine(delivery: ResolvedDelivery): string {
  if (!delivery.declared) {
    return line('Delivery', 'not declared  (this repository declares no delivery target)');
  }
  const result = delivery.result;
  const answer =
    result.outcome === 'RESOLVED'
      ? `${result.target.host}/${result.target.owner}/${result.target.name}`
      : `${result.outcome} — ${DELIVERY_TARGET_DETAIL[result.outcome]}`;
  return line('Delivery', `${delivery.remoteName} -> ${answer}  (identity only; nothing is delivered)`);
}

/**
 * Renders one plan for the console. The trailing note is part of the contract:
 * a plan executes nothing, and the report says so every time rather than
 * assuming the operator remembers. See {@link READ_ONLY_TRAILER} for the exact
 * scope of that promise.
 */
export function renderRunPlan(
  plan: RunPlan,
  repository: { id: string; root: string; delivery: ResolvedDelivery },
): string {
  const lines: string[] = [
    '',
    line('Repository', `${repository.id}  (${repository.root})`),
    renderDeliveryLine(repository.delivery),
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
      const { body, bodyTruncated, contextPreview } = plan.brief.preview;
      // "in the source checkout" rather than "on the default branch": nothing
      // here asked Git which branch the checkout is on, and `resolveRepository`
      // does not require it to be the declared default. Naming a branch would
      // be a claim this code never established.
      const context =
        contextPreview.length === 0
          ? 'no context declared'
          : `${contextPreview.length} context source(s) in the source checkout`;
      lines.push(
        line('Brief', `readable — ${body.length} chars${bodyTruncated ? ' (truncated)' : ''}; ${context}`),
      );
      // Only the ones that are not fine are named, and only by the path the
      // profile itself declared — a value the schema already constrained.
      for (const source of contextPreview) {
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
