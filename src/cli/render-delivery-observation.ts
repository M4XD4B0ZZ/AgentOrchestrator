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
import {
  DELIVERY_EVIDENCE_READING_DETAIL,
  REMOTE_FRESHNESS_SENTENCE,
  type DeliveryEvidenceReading,
} from '../deliver/delivery-evidence.js';
import {
  DELIVERY_DECISION_DETAIL,
  MERGE_ELIGIBILITY_SENTENCE,
  type DeliveryDecision,
  type SubjectRevalidation,
} from '../deliver/delivery-decision.js';

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
 * existed. The first two sentences below are true in both cases, because they
 * are statements about what this build asks — which is bounded — rather than
 * about what crossed the network, which is not this build's alone to promise.
 * The closing clause is deliberately in the generic present: it describes what
 * the client does, not what it did on this run, because on the paths where no
 * process started it did nothing at all.
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

/**
 * The stored-evidence line, and the sentence that must always follow it.
 *
 * ── Why the reading is printed for every outcome, including the refusals ───
 *
 * Because "AO has never observed this" and "AO observed something and this
 * build cannot read it" are different facts, and the second is the one an
 * operator has to be told about — a `MALFORMED` record reported as silence
 * looks exactly like a task nobody has looked at.
 *
 * ── Why the word HISTORICAL is in the label ───────────────────────────────
 *
 * The line sits directly beneath a live `Checks : SUCCESS`, and the two are
 * about different moments. A label reading `Evidence` beside a stored `SUCCESS`
 * invites exactly the reading this slice exists to prevent, so the label says
 * what the value is: history.
 */
export const HISTORICAL_LABEL = 'Recorded';

/**
 * What is printed when a fresh observation and a stored record disagree.
 *
 * The disagreement is *reported*, and neither side is preferred. Silently
 * trusting the fresh one would be right in most cases and would teach an
 * operator that the record tracks reality; silently trusting the stored one
 * would be wrong in all of them. Saying both, and saying they differ, is the
 * only honest option — and the fresh answer is already printed above, so the
 * line only has to name the stored one and the fact of the difference.
 */
export const EVIDENCE_DISAGREEMENT_PREFIX = 'the observation above does not match it';

/**
 * The agreement half, and it says exactly what was compared.
 *
 * ── Both sentences have now been wrong in opposite directions ─────────────
 *
 * The first pair read "agrees" / "differs from the observation above". "Agrees"
 * claimed more than the comparison makes: only the two outcome words and the
 * pull-request number are compared, so a stored `SUCCESS (2 check runs)` beside
 * a fresh `SUCCESS (10 check runs, 8 of them new)` was called agreement. Both
 * sets of counts are printed two lines above, so the operator could see the
 * difference — but the sentence should not have said there was none.
 *
 * The correction replaced them with "reports the same outcome" / "reports a
 * different outcome", and a second review found the disagreement half was then
 * false in a case the suite deliberately exercises: a pull request closed and
 * another opened at the same head gives `MATCHED` on both sides with different
 * numbers, so the outcome *word* is identical and the sentence said it was not.
 *
 * So the two are no longer symmetrical, because the underlying comparison is
 * not. The agreement half names what was compared and claims only that; the
 * disagreement half says the two do not match, without naming which of the
 * three compared values moved — all three are printed above it.
 */
export const EVIDENCE_AGREEMENT_SUFFIX =
  'the observation above reports the same outcome and pull request';

export interface StoredEvidenceView {
  readonly reading: DeliveryEvidenceReading;
  readonly observedAt: string | null;
  readonly pullRequestOutcome: string | null;
  readonly pullRequestNumber: number | null;
  readonly checkOutcome: string | null;
}

export interface DeliveryObservationView {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly subject: SubjectResolution;
  /** `null` when no observation was requested. */
  readonly observation: DeliveryObservation | null;
  readonly conclusion: ObservationConclusion;
  /** What is already on disk for this task, or `null` when it was not looked for. */
  readonly stored?: StoredEvidenceView | null;
  /** What `--record` amounted to, or `null` when it was not asked for. */
  readonly recording?: {
    readonly outcome: string;
    readonly recorded: boolean;
    readonly detail: string | null;
  } | null;
  /** What `--decide` amounted to, or `null` when it was not asked for. */
  readonly decision?: DeliveryDecisionView | null;
}

/**
 * The decision, and the second look that qualified it.
 *
 * The revalidation verdict is carried and printed even when it is `UNCHANGED`,
 * deliberately. It answers "was this still the same subject when the answers
 * came back", and a report that printed it only when it went wrong would leave
 * a reader unable to tell "it was checked and held" from "nobody checked".
 *
 * `null` is that second case, and it is a real one: nothing was observed, so
 * there was no window for the subject to move in and no re-read was taken. It
 * prints as its own phrase rather than as `UNCHANGED`, because claiming a check
 * that did not happen is the failure this field exists to prevent.
 */
export interface DeliveryDecisionView {
  readonly decision: DeliveryDecision;
  readonly revalidation: SubjectRevalidation | null;
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

  const stored = view.stored ?? null;
  if (stored !== null) {
    lines.push(renderStoredEvidenceLine(stored, view.observation));
  }

  const recording = view.recording ?? null;
  if (recording !== null) {
    // The code alone when it succeeded, and the code plus its sentence when it
    // did not. A refusal is the case an operator has to act on, so it is the
    // one that carries an explanation; `RECORDED — RECORDED`, which the first
    // version printed, explained nothing twice.
    lines.push(
      line(
        'Record',
        recording.recorded
          ? recording.outcome
          : `${recording.outcome}${recording.detail === null ? '' : ` — ${recording.detail}`}`,
      ),
    );
  }

  lines.push(
    '',
    `Conclusion   : ${view.conclusion}`,
    `  ${OBSERVATION_CONCLUSION_DETAIL[view.conclusion]}`,
  );

  // The freshness sentence follows any historical evidence, always. It is not
  // conditional on the outcome and it is not conditional on whether a fresh
  // observation was also made: a record that agrees with a fresh answer is
  // still not the reason that answer is true.
  if (stored !== null && stored.reading === 'HISTORICAL_VALID') {
    lines.push('', REMOTE_FRESHNESS_SENTENCE);
  }

  // The decision, after the conclusion it is derived from and after the record
  // it is deliberately not derived from. Its own sentence follows it
  // unconditionally, for the same reason the freshness sentence follows the
  // record: it is true of every decision including the good one, so it is not a
  // caveat attached to the bad ones.
  const decision = view.decision ?? null;
  if (decision !== null) {
    lines.push(
      '',
      `Decision     : ${decision.decision}`,
      `  ${DELIVERY_DECISION_DETAIL[decision.decision]}`,
      `  ${
        decision.revalidation === null
          ? 'The local subject was not re-checked: nothing was observed, so nothing could go stale.'
          : `Local subject re-checked after the answers came back: ${decision.revalidation}.`
      }`,
      '',
      MERGE_ELIGIBILITY_SENTENCE,
    );
  }

  lines.push(
    '',
    view.observation === null ? NOT_CONTACTED_TRAILER : CONTACTED_TRAILER,
    '',
  );

  return lines.join('\n');
}

/**
 * The stored record as one line, and the comparison when there is one to make.
 *
 * The stored outcomes are printed as `was MATCHED` / `was SUCCESS`, in the past
 * tense, deliberately. The same words appear two lines above in the present
 * tense for the fresh answer, and the tense is the only thing distinguishing
 * them at a glance — so it is the tense that does the work rather than a
 * footnote somebody has to reach.
 */
export function renderStoredEvidenceLine(
  stored: StoredEvidenceView,
  observation: DeliveryObservation | null,
): string {
  if (stored.reading !== 'HISTORICAL_VALID') {
    return line(
      HISTORICAL_LABEL,
      `${stored.reading} — ${DELIVERY_EVIDENCE_READING_DETAIL[stored.reading]}`,
    );
  }

  const pull =
    stored.pullRequestNumber === null
      ? String(stored.pullRequestOutcome)
      : `${String(stored.pullRequestOutcome)} (#${String(stored.pullRequestNumber)})`;
  const when = stored.observedAt === null ? 'an unrecorded time' : stored.observedAt;
  let text = `HISTORICAL — at ${when} this was ${pull}, checks ${String(stored.checkOutcome)}`;

  if (observation !== null) {
    // Compared on the settled outcome words only. A pull-request number that
    // moved is a different match and is caught by the outcome comparison below
    // only when the outcome itself changed, so the number is compared too.
    const freshPull = observation.pullRequest.outcome;
    const freshNumber =
      observation.pullRequest.outcome === 'MATCHED' ? observation.pullRequest.pullRequest : null;
    const differs =
      freshPull !== stored.pullRequestOutcome ||
      freshNumber !== stored.pullRequestNumber ||
      observation.checks.outcome !== stored.checkOutcome;
    text += `; ${differs ? EVIDENCE_DISAGREEMENT_PREFIX : EVIDENCE_AGREEMENT_SUFFIX}`;
  }

  return line(HISTORICAL_LABEL, text);
}
