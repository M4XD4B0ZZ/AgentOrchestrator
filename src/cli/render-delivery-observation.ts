/**
 * Console rendering for a delivery observation — V4 slice 2.
 *
 * ── What may appear here ───────────────────────────────────────────────────
 *
 * Only values that have already passed a validating boundary:
 *
 *  - the repository id and canonical root, both produced by `resolveRepository`;
 *  - the delivery target's host, owner and name, each of which passed slice 1's
 *    grammar, plus the declared remote name the profile contract accepted;
 *  - a task id, which passed the id grammar;
 *  - a task state name from the closed state vocabulary;
 *  - the subject commit, forty lowercase hex digits and nothing else;
 *  - closed vocabulary codes and integers produced by this build's own counters;
 *  - a pull-request number, which is a validated positive integer.
 *
 * What is **not** representable here, and therefore cannot be printed: the
 * remote URL, any part of it, a token, an `Authorization` header, the forge
 * client's `stderr`, a check-run name, a branch name that came back from the
 * forge, or any other string this build did not write itself. The result types
 * in `deliver/forge-observation.ts` have no field that could carry one — the
 * pull-request answer carries a number, and the check answer carries counts.
 *
 * That is deliberate and it is the same discipline as `render-run-plan.ts`. A
 * check-run's name is attacker-influenceable text on a public repository, and a
 * console an operator reads and pastes is not the place to find out what it
 * contains.
 */

import {
  OBSERVATION_REFUSAL_DETAIL,
  type CheckStateObservation,
  type ObservationRefusal,
  type PullRequestObservation,
} from '../deliver/forge-observation.js';
import {
  OBSERVATION_CONCLUSION_DETAIL,
  SUBJECT_REFUSAL_DETAIL,
  type DeliveryObservation,
  type ObservationConclusion,
  type SubjectResolution,
} from '../deliver/observe-delivery.js';

/**
 * The closing contract sentence, in the two shapes this command has.
 *
 * Two constants rather than one with a conditional clause, because they are two
 * different promises: one says nothing left this machine, and the other says
 * exactly what left it and what did not. A single sentence that tried to cover
 * both would end up true of neither.
 */
export const NOT_CONTACTED_TRAILER =
  'Read-only. No forge was contacted, no task state was written, and nothing was delivered.';

/**
 * Two corrections are baked into this sentence, and both were over-claims.
 *
 * It used to open "github.com was asked about one commit and nothing else",
 * which is false twice. The GitHub CLI makes calls of its own that this build
 * does not suppress — telemetry, and a periodic update check — so "nothing
 * else" was not true of the wire, and the residual that records this
 * (`L-V4-02-6`) was visible everywhere except in the one place an operator
 * actually reads. And the trailer is selected on whether an observation was
 * *requested*, so it also printed when every request refused before a process
 * existed. The wording below is true in both cases: it is a statement about
 * what this build asks, which is bounded, rather than about what crossed the
 * network, which is not this build's alone to promise.
 */
export const CONTACTED_TRAILER =
  'Read-only. This build asked about no commit but the one named above, and about no other\n' +
  'repository. No task state was written. No pull request was opened, updated, reviewed or\n' +
  'merged. The GitHub CLI also makes calls of its own — telemetry, and a periodic update\n' +
  'check — which this build does not suppress (L-V4-02-6).';

function line(label: string, value: string): string {
  return `${label.padEnd(13)}: ${value}`;
}

function refusalLine(code: ObservationRefusal): string {
  return `${code} — ${OBSERVATION_REFUSAL_DETAIL[code]}`;
}

/**
 * The pull-request answer as one line.
 *
 * `MATCHED` prints the number, and nothing else about the pull request. The
 * number is the identity; a title or a branch name would be foreign text, and
 * neither is evidence about a head commit.
 */
export function renderPullRequestLine(observation: PullRequestObservation): string {
  if (observation.outcome === 'MATCHED') {
    return line('Pull request', `MATCHED  (#${String(observation.pullRequest)})`);
  }
  if (observation.outcome === 'AMBIGUOUS') {
    const numbers = observation.pullRequests.map((n) => `#${String(n)}`).join(', ');
    return line(
      'Pull request',
      `AMBIGUOUS  (${numbers}) — more than one open pull request claims this exact head.`,
    );
  }
  if (observation.outcome === 'NO_MATCHING_PULL_REQUEST') {
    return line(
      'Pull request',
      'NO_MATCHING_PULL_REQUEST — no open pull request has this commit as its head.',
    );
  }
  return line('Pull request', refusalLine(observation.outcome));
}

/**
 * The check answer as one line, with its counts.
 *
 * The counts are printed for every graded outcome, including `SUCCESS`. A
 * single word is exactly what an operator should not have to trust here: the
 * two mechanism totals show that both were consulted, and the neutral/skipped
 * count shows where this build's definition of "not blocking" was applied.
 */
export function renderCheckStateLine(observation: CheckStateObservation): string {
  if (
    observation.outcome === 'SUCCESS' ||
    observation.outcome === 'PENDING' ||
    observation.outcome === 'FAILED'
  ) {
    const c = observation.counts;
    const detail =
      `${String(c.checkRuns)} check run(s), ${String(c.commitStatuses)} commit status(es): ` +
      `${String(c.succeeded)} succeeded, ${String(c.pending)} pending, ` +
      `${String(c.failed)} failed, ${String(c.neutralOrSkipped)} neutral/skipped`;
    return line('Checks', `${observation.outcome}  (${detail})`);
  }
  if (observation.outcome === 'NO_CHECKS') {
    return line(
      'Checks',
      'NO_CHECKS — neither mechanism has a record for this commit. This is not success.',
    );
  }
  return line('Checks', refusalLine(observation.outcome));
}

export interface DeliveryObservationView {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly subject: SubjectResolution;
  /** `null` when no observation was requested. */
  readonly observation: DeliveryObservation | null;
  readonly conclusion: ObservationConclusion;
}

/**
 * Renders one delivery observation.
 *
 * The subject commit is printed on its own line whenever one exists, and every
 * answer below it is about that commit. That is the report's whole shape: an
 * operator should never have to work out which commit a check state refers to,
 * because crediting one commit's evidence to another is the failure this slice
 * is built around.
 */
export function renderDeliveryObservation(view: DeliveryObservationView): string {
  const lines: string[] = [
    '',
    line('Repository', `${view.repositoryId}  (${view.repositoryRoot})`),
    line('Task', view.taskId),
  ];

  if (view.subject.ok) {
    const { subject, taskState, remoteName } = view.subject;
    lines.push(
      line(
        'Delivery',
        `${remoteName} -> ${subject.host}/${subject.owner}/${subject.name}  (identity only; nothing is delivered)`,
      ),
      line('State', taskState),
      line('Subject', subject.commit),
    );
  } else {
    const detail = SUBJECT_REFUSAL_DETAIL[view.subject.code];
    const carried =
      view.subject.deliveryDetail === null ? '' : `  [delivery target: ${view.subject.deliveryDetail}]`;
    lines.push(line('Delivery', `${view.subject.code} — ${detail}${carried}`));
  }

  if (view.observation === null) {
    if (view.subject.ok) {
      const notObserved = 'not observed  (pass --observe to ask the forge about this commit)';
      lines.push(line('Pull request', notObserved), line('Checks', notObserved));
    }
  } else {
    lines.push(
      renderPullRequestLine(view.observation.pullRequest),
      renderCheckStateLine(view.observation.checks),
    );
  }

  lines.push(
    '',
    `Conclusion   : ${view.conclusion}`,
    `  ${OBSERVATION_CONCLUSION_DETAIL[view.conclusion]}`,
    '',
    view.observation === null ? NOT_CONTACTED_TRAILER : CONTACTED_TRAILER,
    '',
  );

  return lines.join('\n');
}
