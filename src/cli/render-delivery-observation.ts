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
 * client's `stderr`, or a check-run name. The result types in
 * `deliver/forge-observation.ts` have no field that could carry one — the
 * check answer carries counts, and slice 2's pull-request answer carries a
 * number.
 *
 * That is deliberate and it is the same discipline as `render-run-plan.ts`. A
 * check-run's name is attacker-influenceable text on a public repository, and a
 * console an operator reads and pastes is not the place to find out what it
 * contains.
 *
 * ── One string is now reachable, and is deliberately not printed ───────────
 *
 * V4 slice 6 needed to know what base branch an existing pull request targets,
 * so `PullCandidate` gained a `baseRef` and it reaches this module inside a
 * `PullRequestSituation`. **That is a branch name that came back from the
 * forge.** The paragraph above used to say no such string was representable
 * here, and structural impossibility is worth more than a rule, so the change
 * is stated rather than absorbed: for that one value the guarantee is now a
 * discipline in `describeSituation`, which prints the pull request's *number*
 * and never its base. A slice that prints it would be trading the property
 * away, and should say so here rather than discover it in a review.
 */

import {
  HEAD_PUBLICATION_DETAIL,
  type RemoteRefReading,
} from '../deliver/head-publication.js';
import type { PublicationResult } from '../deliver/publish-delivery-head.js';
import {
  PULL_REQUEST_CREATION_DETAIL,
  type PullRequestSituation,
} from '../deliver/pull-request-creation.js';
import type { CreationResult } from '../deliver/create-pull-request.js';
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

/**
 * What an observation is answerable for, with no "Read-only." in front of it.
 *
 * `CONTACTED_TRAILER` opens with that word and is the right trailer for a run
 * that only observed. A run that also changed something is not read-only, and putting
 * the two sentences next to each other made the report's closing block open
 * with a false claim about the most consequential invocation this build
 * supports — a defect introduced by the fix for the previous one, and found by
 * the next review.
 *
 * So the disclosure that had to survive — `L-V4-02-6`, the client's own
 * traffic — is carried here without the framing that belongs to a read-only
 * run, and `PUBLICATION_TRAILER` states what changed.
 */
export const OBSERVED_AND_CHANGED_TRAILER =
  'This build asked about no commit but the one named above, and about no other repository.\n' +
  'The GitHub CLI also makes calls of its own — telemetry, and a periodic update check —\n' +
  'which this build does not suppress (L-V4-02-6).';

/**
 * The trailer for an invocation that could change something, and did at most
 * the one thing it is allowed to change.
 *
 * Two of the three other trailers open "Read-only.", and one of those adds "No
 * forge was contacted". Each was true of the runs it was printed for until
 * slice 5, and both are false on a publication — the first always, the second
 * whenever the remote was read. Separate sentences are
 * the honest repair; widening the existing ones would have made them vaguer for
 * the runs they were written for.
 *
 * Which trailer is printed is derived from whether the act was **attempted**,
 * not from which flags were passed and not from whether a reading was taken. It
 * used to be the reading, and a review showed what that prints: "Not
 * read-only." over a run that answered `REF_HOLDS_ANOTHER_COMMIT` or
 * `ALREADY_PUBLISHED` — runs which looked at the remote and changed nothing.
 * A refused act is a read-only run of a flag that could have changed something,
 * and an attempted one is not read-only even when it failed.
 */
export const PUBLICATION_TRAILER =
  'Not read-only. The publication could change exactly one thing and changed at most that:\n' +
  'one branch on the delivery remote, created at one commit. Create-only — no ref was moved,\n' +
  'rewritten or deleted, no other ref was touched, and nothing was pushed to any other remote.\n' +
  'It wrote no task state, and it grants no authority to open, update or merge a pull\n' +
  'request.';

/**
 * The trailer for the other invocation that could change something.
 *
 * A second sentence rather than a clause added to the first, and the reason is
 * a defect this file has already shipped once: `PUBLICATION_TRAILER` used to
 * end "No pull request was opened, updated, reviewed or merged", which was true
 * of every run that existed when it was written and became false the moment a
 * flag was added that opens one. A sentence that enumerates what did not happen
 * has to be re-read by every slice that adds a way for it to happen, so each
 * act now speaks for itself and about nothing else.
 *
 * It says "the creation" and not "this invocation" for the same reason: one
 * invocation can publish and create, and a trailer claiming the invocation
 * changed exactly one thing would then be false while both of the things it
 * changed were permitted.
 */
export const CREATION_TRAILER =
  'Not read-only. The creation could change exactly one thing and changed at most that:\n' +
  'one pull request, opened once, at the commit named above. It updated, closed, reopened,\n' +
  'marked ready or draft, commented on, labelled, assigned, reviewed and merged nothing, it\n' +
  'pushed no branch and changed no ref, and it grants no authority to do any of those. It\n' +
  'wrote no task state.';

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
  readonly publication?: HeadPublicationView | null;
  /** What `--create-pr` amounted to, or `null` when it was not asked for. */
  readonly creation?: PullRequestCreationView | null;
}

/**
 * The decision, and the second look that qualified it.
 *
 * The revalidation verdict is carried and printed even when it is `UNCHANGED`,
 * deliberately. It answers "was this still the same subject when the answers
 * came back", and a report that printed it only when it went wrong would leave
 * a reader unable to tell "it was checked and held" from "nobody checked".
 *
 * `null` is that second case, and it is a real one: no settled answer was
 * obtained — nothing was contacted, or the forge refused — so there was nothing
 * to bind to a subject and no re-read was taken. It prints as its own phrase
 * rather than as `UNCHANGED`, because claiming a check that did not happen is
 * the failure this field exists to prevent.
 */
export interface DeliveryDecisionView {
  readonly decision: DeliveryDecision;
  readonly revalidation: SubjectRevalidation | null;
}

/**
 * What a publication attempt did, and to which ref.
 *
 * `ref` and `remoteName` are carried beside the result rather than inside it
 * because the authority that named them is spent by the time the result exists
 * — deliberately, since an artefact a report could read twice is an artefact
 * that could publish twice. The caller still holds them, so it passes them.
 * Both are `null` on a refusal that never got as far as having a ref.
 */
/**
 * What a pull-request creation attempt did, and what it was for.
 *
 * The three intended values are carried beside the result for the reason the
 * publication view gives: the authority that named them is spent by the time
 * the result exists, deliberately, because an artefact a report could read
 * twice is an artefact that could create twice. All three are `null` on a
 * refusal that never got as far as having an intended pull request.
 *
 * The title and body are **not** carried. They are the two values in this slice
 * that are not identities, they are already on GitHub if anything was created,
 * and a console an operator pastes is not a second place for them to appear.
 */
export interface PullRequestCreationView {
  readonly result: CreationResult;
  readonly headRef: string | null;
  readonly baseRef: string | null;
  readonly draft: boolean | null;
}

export interface HeadPublicationView {
  readonly result: PublicationResult;
  readonly ref: string | null;
  readonly remoteName: string | null;
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
          ? 'The local subject was not re-checked: no settled answer was obtained, so there was ' +
            'nothing to bind to it.'
          : `Local subject re-checked after the answers came back: ${decision.revalidation}.`
      }`,
      '',
      MERGE_ELIGIBILITY_SENTENCE,
    );
  }

  const publication = view.publication ?? null;
  if (publication !== null) {
    const r = publication.result;
    lines.push(
      '',
      `Publication  : ${r.publication}`,
      `  ${HEAD_PUBLICATION_DETAIL[r.publication]}`,
      `  Intended     : ${
        publication.ref === null || publication.remoteName === null
          ? 'no publishable ref was established'
          : `${publication.ref} on ${publication.remoteName}`
      }`,
    );
    // The two readings, and only when one was taken. Printing "before: none"
    // for a refusal that never contacted the remote would read as a reading
    // that came back empty, which is a different fact and the more alarming
    // one.
    if (r.before !== null) {
      lines.push(
        `  Remote before: ${describeReading(r.before)}`,
        `  Attempt      : ${r.attempt}`,
        `  Remote after : ${r.after === null ? 'not read' : describeReading(r.after)}`,
      );
    }
  }

  const creation = view.creation ?? null;
  if (creation !== null) {
    const c = creation.result;
    lines.push(
      '',
      // Labelled `Creation`, not `Pull request`: slice 2 already prints a
      // `Pull request` line for what it observed, and two different lines
      // under one label is how an operator reads the wrong answer.
      `Creation     : ${c.creation}`,
      `  ${PULL_REQUEST_CREATION_DETAIL[c.creation]}`,
      `  Intended     : ${
        creation.headRef === null || creation.baseRef === null
          ? 'no intended pull request was established'
          : `${creation.headRef} -> ${creation.baseRef}${
              creation.draft === null ? '' : `  (draft: ${String(creation.draft)})`
            }`
      }`,
    );
    // Each reading only when it was taken, and in the order they were taken.
    // Printing "before: none" for a refusal that never contacted the forge
    // would read as a reading that came back empty, which is a different fact
    // and the more alarming one.
    if (c.remoteHead !== null) {
      lines.push(`  Remote head  : ${describeReading(c.remoteHead)}`);
    }
    if (c.before !== null) {
      lines.push(
        `  Forge before : ${describeSituation(c.before)}`,
        `  Attempt      : ${c.attempt}`,
        `  Forge after  : ${c.after === null ? 'not read' : describeSituation(c.after)}`,
      );
    }
  }

  // Derived from what happened, not from which flags were passed — and from
  // whether the act was *attempted*, not from whether it read anything. A
  // review found the previous rule printing "Not read-only." over runs that
  // published nothing and created nothing, because they had taken a reading:
  // `HEAD_NOT_PUBLISHED`, `ALREADY_EXISTS` and every conflict refusal are
  // read-only runs of a flag that could have changed something and did not.
  //
  // The readings are still what the report shows; they are not what the closing
  // sentence is about. A run that attempted and failed is still not read-only,
  // which is why the test is on the attempt word and not on the outcome.
  const publicationAttempted =
    publication != null && publication.result.attempt !== 'NOT_ATTEMPTED';
  const creationAttempted = creation != null && creation.result.attempt !== 'NOT_ATTEMPTED';
  // Whether anything was contacted at all, which is what the egress disclosure
  // is about and is a different question from whether anything changed.
  const contactedByPublication = publication?.result.before != null;
  const contactedByCreation = creation?.result.remoteHead != null;
  // One sentence per act, and the observation disclosure once, above them.
  //
  // The first version of this printed only the publication trailer, which
  // silently dropped the `L-V4-02-6` disclosure — the GitHub CLI's own
  // telemetry and update calls — on exactly the runs that had earned it. A
  // sentence about one kind of egress does not stand in for a sentence about
  // another, and by the same argument a sentence about a publication does not
  // stand in for one about a pull request.
  const trailers: string[] = [];
  if (!publicationAttempted && !creationAttempted) {
    // Nothing was attempted, so the run was read-only whatever it looked at.
    // Which of the two read-only sentences applies is still decided by whether
    // anything was contacted, by any path.
    const contacted = view.observation !== null || contactedByPublication || contactedByCreation;
    trailers.push(contacted ? CONTACTED_TRAILER : NOT_CONTACTED_TRAILER);
  } else {
    if (view.observation !== null) trailers.push(OBSERVED_AND_CHANGED_TRAILER, '');
    if (publicationAttempted) trailers.push(PUBLICATION_TRAILER);
    if (publicationAttempted && creationAttempted) trailers.push('');
    if (creationAttempted) trailers.push(CREATION_TRAILER);
  }
  lines.push('', ...trailers, '');

  return lines.join('\n');
}

/**
 * One remote reading as one phrase.
 *
 * `AT_COMMIT` prints the object name it found, because the whole grading ladder
 * turns on whether that string equals the intended one and an operator reading
 * a refusal should be able to see the two side by side. `UNKNOWN` prints no
 * reason: the reason would be Git's stderr, which this build does not read.
 */
function describeReading(reading: RemoteRefReading): string {
  if (reading.outcome === 'AT_COMMIT') return `AT_COMMIT ${reading.commit ?? ''}`.trim();
  return reading.outcome;
}

/**
 * One forge reading as one phrase.
 *
 * The pull-request numbers are printed because "which ones" is the only
 * question the plural outcomes leave open, and the draft state because it is a
 * boolean this build's own parse validated.
 *
 * **The base branch the forge reported is deliberately not printed**, and that
 * costs something: an operator reading `WRONG_BASE_CONFLICT` is told which pull
 * request is in the way and which base was intended, and has to open the pull
 * request to see the base it actually targets. The alternative was to print a
 * branch name that came back from the forge, which is the one thing this file's
 * header promises never appears here. That promise is worth more than the line
 * it would save: a base ref is a string this build did not write, and a console
 * an operator reads and pastes is not where its contents should first be
 * discovered.
 */
function describeSituation(situation: PullRequestSituation): string {
  if (situation.outcome === 'OPEN_ONE') {
    const open = situation.open;
    if (open === null) return 'OPEN_ONE';
    return `OPEN_ONE #${String(open.number)}  (draft: ${String(open.draft)})`;
  }
  if (situation.outcome === 'OPEN_MANY' || situation.outcome === 'CLOSED_ONLY') {
    return `${situation.outcome} ${situation.numbers.map((n) => `#${String(n)}`).join(', ')}`.trim();
  }
  return situation.outcome;
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
