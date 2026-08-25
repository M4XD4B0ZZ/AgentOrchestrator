/**
 * V4 slice 4 — the delivery decision.
 *
 * This is the first slice that classifies rather than reports, so the suite
 * attacks the classification boundary rather than the arithmetic. Three
 * properties carry the slice, and a test that merely feeds green facts in and
 * reads a green word out proves none of them:
 *
 *  1. **freshness is structural** — a stored observation, however green and
 *     however recent, can never produce a positive decision. The counter-proof
 *     is a perfectly shaped forgery driven through the real argument, refused;
 *  2. **exactness survives the second layer** — a decision about commit A must
 *     never be satisfiable by an answer about commit B, and the local subject
 *     must still be the same one when the answers come back;
 *  3. **nothing was granted** — `READY_FOR_PR` is still terminal, no task state
 *     is written, no forge is mutated, and the vocabulary contains no word that
 *     could be read as permission.
 *
 * Nothing here contacts a network: every observation runs against an injected
 * runner, for the reason slices 2 and 3 give — the canonical gate must be
 * deterministic on a machine that has never run `gh auth login`, and CI has no
 * credentials at all.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DECIDE_OPTION_DESCRIPTION,
  DELIVERY_COMMAND_DESCRIPTION,
  registerDeliveryCommand,
} from '../src/cli/delivery-command.js';
import { renderDeliveryObservation } from '../src/cli/render-delivery-observation.js';
import { EXIT_RUN_OK, EXIT_RUN_REFUSED } from '../src/cli/run-exit-codes.js';
import { ALL_STATES, TERMINAL_STATES, isTerminalState } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import {
  DELIVERY_DECISIONS,
  DELIVERY_DECISION_DETAIL,
  MERGE_ELIGIBILITY_SENTENCE,
  POSITIVE_DELIVERY_DECISION,
  SUBJECT_REVALIDATIONS,
  concludeDeliveryDecision,
  decideDelivery,
  isPositiveDeliveryDecision,
  revalidateSubject,
  type DeliveryDecision,
  type LocalSubject,
} from '../src/deliver/delivery-decision.js';
import {
  RECORDABLE_CHECK_OUTCOMES,
  RECORDABLE_PULL_REQUEST_OUTCOMES,
} from '../src/deliver/delivery-evidence.js';
import {
  deliveryObservationFactsOf,
  isDeliveryObservationProof,
  type DeliveryObservationProof,
} from '../src/deliver/delivery-observation-proof.js';
import {
  CHECK_RUN_CONCLUSIONS,
  CHECK_RUN_STATUSES,
  COMMIT_STATUS_STATES,
  OBSERVATION_REFUSALS,
  createObservationSubject,
  type CheckStateObservation,
  type ObservationSubject,
  type PullRequestObservation,
} from '../src/deliver/forge-observation.js';
import type { ForgeCommandRunner } from '../src/deliver/github-observer.js';
import {
  attestDeliveryObservation,
  type DeliveryObservation,
} from '../src/deliver/observe-delivery.js';
import { LOOP_DRIVEN_STATES } from '../src/loop/loop-step.js';
import type { ResolvedDelivery } from '../src/deliver/delivery-target.js';
import type { StateLoadResult } from '../src/state/state-store.js';
import type { CommandResult } from '../src/doctor/exec.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const HEAD = '10583ee91a5747d0049f563ffaac64b0cf643aeb';
const OTHER = 'c89ef605400a15e5d3db4d256c184773c0d533f6';
const BASE = '46629f0503b0126318ead7229eba7a84d3e7504a';
const REV = 'a'.repeat(64);
const AT = '2026-08-23T14:00:00.000Z';
/** Old enough that any age-based rule would have expired it. Nothing reads it. */
const LONG_AGO = '2021-01-01T00:00:00.000Z';

interface Identity {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

const IDENTITY: Identity = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});

const ELSEWHERE: Identity = Object.freeze({
  host: 'github.com',
  owner: 'someone-else',
  name: 'AnotherRepo',
});

function subjectOf(commit = HEAD, identity = IDENTITY): ObservationSubject {
  const built = createObservationSubject(identity, commit);
  if (!built.ok) throw new Error(`fixture subject refused: ${built.refusal}`);
  return built.subject;
}

function matched(pullRequest = 57): PullRequestObservation {
  return Object.freeze({ outcome: 'MATCHED' as const, pullRequest });
}

const NO_PULL: PullRequestObservation = Object.freeze({
  outcome: 'NO_MATCHING_PULL_REQUEST' as const,
});

function ambiguous(...pullRequests: number[]): PullRequestObservation {
  return Object.freeze({ outcome: 'AMBIGUOUS' as const, pullRequests: Object.freeze(pullRequests) });
}

function checks(
  outcome: 'SUCCESS' | 'PENDING' | 'FAILED',
  over: Partial<{ succeeded: number; pending: number; failed: number }> = {},
): CheckStateObservation {
  return Object.freeze({
    outcome,
    counts: Object.freeze({
      checkRuns: 2,
      commitStatuses: 0,
      failed: over.failed ?? 0,
      pending: over.pending ?? 0,
      succeeded: over.succeeded ?? 2,
      neutralOrSkipped: 0,
    }),
  });
}

const NO_CHECKS: CheckStateObservation = Object.freeze({ outcome: 'NO_CHECKS' as const });

function observation(
  pullRequest: PullRequestObservation,
  checkState: CheckStateObservation,
): DeliveryObservation {
  return Object.freeze({ pullRequest, checks: checkState });
}

/**
 * A real, minted proof — never a hand-built object.
 *
 * Every positive path in this suite goes through the actual mint, so a change
 * that made the mint stricter would break these fixtures rather than let them
 * quietly keep asserting against a shape the product no longer produces.
 */
function proofFor(
  subject: ObservationSubject,
  obs: DeliveryObservation,
  observedAt = AT,
): DeliveryObservationProof {
  const proof = attestDeliveryObservation(subject, obs, observedAt);
  if (proof === null) throw new Error('fixture proof was refused by the mint');
  return proof;
}

const GREEN = (subject = subjectOf()): DeliveryObservationProof =>
  proofFor(subject, observation(matched(), checks('SUCCESS')));

function localSubject(commit = HEAD, taskState = 'READY_FOR_PR', identity = IDENTITY): LocalSubject {
  return { subject: subjectOf(commit, identity), taskState };
}

function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── 1. The vocabulary is closed, total and says nothing it cannot ──────────

describe('the decision vocabulary', () => {
  it('is a set, and every member carries exactly one sentence', () => {
    expect(new Set(DELIVERY_DECISIONS).size).toBe(DELIVERY_DECISIONS.length);
    // Derived both ways rather than listed: a member added without a sentence
    // fails, and a sentence for a member that no longer exists fails too.
    expect(Object.keys(DELIVERY_DECISION_DETAIL).sort()).toEqual([...DELIVERY_DECISIONS].sort());
    for (const decision of DELIVERY_DECISIONS) {
      expect(DELIVERY_DECISION_DETAIL[decision].length, decision).toBeGreaterThan(20);
    }
  });

  it('has exactly one positive member, and it is the named one', () => {
    const positive = DELIVERY_DECISIONS.filter(isPositiveDeliveryDecision);
    expect(positive).toEqual([POSITIVE_DELIVERY_DECISION]);
    expect([...DELIVERY_DECISIONS]).toContain(POSITIVE_DELIVERY_DECISION);
  });

  /**
   * No member may be a word that reads as permission.
   *
   * The ban is over the *derived* vocabulary rather than a list of names to
   * re-check, so a member added tomorrow is covered without anybody remembering
   * this test exists. `MERGE` is banned outright: the whole slice turns on the
   * fact that AO cannot establish merge eligibility, and a decision spelling it
   * would be the single most expensive lie the product could tell.
   */
  it('contains no word that could be read as permission', () => {
    for (const decision of DELIVERY_DECISIONS) {
      expect(decision, decision).not.toMatch(
        /MERGE|ELIGIBLE|APPROVED|AUTHORIS|AUTHORIZ|PERMIT|GRANT|READY|OK\b|GREEN/,
      );
    }
  });

  /**
   * The vocabularies cannot be confused for one another.
   *
   * A decision is not a task state, and this slice writes none. Asserting the
   * two sets are disjoint means a future member that *looked* like a state —
   * and could therefore be written into a state file by an accident of
   * stringly-typed plumbing — fails here first.
   */
  it('shares no member with the task-state vocabulary', () => {
    const states = new Set<string>(ALL_STATES);
    for (const decision of DELIVERY_DECISIONS) expect(states.has(decision), decision).toBe(false);
  });

  it('states the merge-eligibility sentence once, by literal', () => {
    expect(MERGE_ELIGIBILITY_SENTENCE).toContain('Merge eligibility is not established');
    expect(MERGE_ELIGIBILITY_SENTENCE).toContain('observe again first');
    // Not a member. A fact true of every value is a sentence, not a value —
    // the same rule slice 3 applies to remote freshness.
    expect([...DELIVERY_DECISIONS].some((d) => MERGE_ELIGIBILITY_SENTENCE.includes(d))).toBe(false);
  });

  /**
   * The partition the ladder's last arm rests on — probed against the **mint**,
   * not against a second array that happens to agree with it today.
   *
   * The first version derived from `RECORDABLE_CHECK_OUTCOMES`, a hand-written
   * array in `delivery-evidence.ts`, while the code and the ADR both claimed it
   * would fail "the moment the mint's settled set grows a fifth member". A
   * review showed the two were never tied together: the mint's set is a private
   * `Set` in `internal/delivery-observation-proof.ts`, and adding a word to it
   * left every assertion green.
   *
   * So the mint is asked directly, across the **whole declared outcome union** —
   * the recordable words plus every shared refusal, which together are the
   * entire domain of `CheckStateOutcome` and `PullRequestOutcome`. The claim is
   * now what the sentence says it is: a word the mint starts accepting, or stops
   * accepting, turns this red.
   */
  it('mints exactly the settled outcome words, and no other word in reach', () => {
    // Every candidate is tried in **both** payload shapes, and that is the
    // whole reason this assertion works.
    //
    // The first attempt tried each word bare, and it was vacuous in both
    // directions: the mint refuses anything but `NO_CHECKS` that arrives
    // without counts, so a word added to its settled set was still refused —
    // by the *counts* gate — and the probe could not tell the two refusals
    // apart. Two mutants survived it. A candidate counts as accepted if
    // *either* shape mints.
    const withCounts = (outcome: string): CheckStateObservation =>
      ({
        outcome,
        counts: {
          checkRuns: 1,
          commitStatuses: 0,
          failed: 0,
          pending: 0,
          succeeded: 1,
          neutralOrSkipped: 0,
        },
      }) as CheckStateObservation;

    const checkAccepts = (outcome: string): boolean =>
      [withCounts(outcome), { outcome } as CheckStateObservation].some(
        (state) =>
          attestDeliveryObservation(subjectOf(), observation(matched(), state), AT) !== null,
      );

    const pullAccepts = (outcome: string): boolean =>
      [
        outcome === 'MATCHED' ? matched() : ({ outcome, pullRequest: 57 } as PullRequestObservation),
        { outcome, pullRequests: [1, 2] } as unknown as PullRequestObservation,
        { outcome } as PullRequestObservation,
      ].some(
        (state) =>
          attestDeliveryObservation(subjectOf(), observation(state, checks('SUCCESS')), AT) !== null,
      );

    // The candidate space is derived from the neighbouring vocabularies rather
    // than typed out: the declared outcome union, plus every raw GitHub word
    // this build knows, upper-cased. Those are the words a future author would
    // plausibly add to the mint's private set, and `STALE` — the one a review
    // used to show the previous assertion was empty — is among them.
    const raw = [
      ...CHECK_RUN_CONCLUSIONS,
      ...CHECK_RUN_STATUSES,
      ...COMMIT_STATUS_STATES,
    ].map((word) => word.toUpperCase());

    const checkUniverse = [
      ...new Set([...RECORDABLE_CHECK_OUTCOMES, ...OBSERVATION_REFUSALS, ...raw]),
    ];
    expect(checkUniverse.length).toBeGreaterThan(RECORDABLE_CHECK_OUTCOMES.length);
    expect(checkUniverse.filter(checkAccepts).sort()).toEqual([...RECORDABLE_CHECK_OUTCOMES].sort());

    const pullUniverse = [
      ...new Set([...RECORDABLE_PULL_REQUEST_OUTCOMES, ...OBSERVATION_REFUSALS, ...raw]),
    ];
    expect(pullUniverse.filter(pullAccepts).sort()).toEqual(
      [...RECORDABLE_PULL_REQUEST_OUTCOMES].sort(),
    );

    // And the ladder's arms account for that set exactly: three check words are
    // named explicitly and the remainder — one word — is what the closed
    // success set holds. A fifth mintable word would have nowhere to land but
    // the floor, and the assertion above is what makes it visible.
    const namedChecks = ['FAILED', 'PENDING', 'NO_CHECKS'];
    expect([...RECORDABLE_CHECK_OUTCOMES].filter((o) => !namedChecks.includes(o)).sort()).toEqual([
      'SUCCESS',
    ]);
    const namedPulls = ['AMBIGUOUS', 'MATCHED'];
    expect(
      [...RECORDABLE_PULL_REQUEST_OUTCOMES].filter((o) => !namedPulls.includes(o)).sort(),
    ).toEqual(['NO_MATCHING_PULL_REQUEST']);
  });

  it('reaches every member from the product surface', () => {
    const subject = subjectOf();
    const reached = new Set<DeliveryDecision>([
      concludeDeliveryDecision({
        subjectEstablished: false,
        observed: false,
        proof: null,
        expected: null,
        revalidation: 'UNCHANGED',
      }),
      concludeDeliveryDecision({
        subjectEstablished: true,
        observed: false,
        proof: null,
        expected: subject,
        revalidation: 'UNCHANGED',
      }),
      concludeDeliveryDecision({
        subjectEstablished: true,
        observed: true,
        proof: null,
        expected: subject,
        revalidation: 'UNCHANGED',
      }),
      decideDelivery(GREEN(), subject, 'UNAVAILABLE'),
      decideDelivery(GREEN(), subject, 'CHANGED'),
      decideDelivery(
        proofFor(subject, observation(matched(), checks('FAILED', { failed: 1, succeeded: 1 }))),
        subject,
        'UNCHANGED',
      ),
      decideDelivery(
        proofFor(subject, observation(ambiguous(1, 2), checks('SUCCESS'))),
        subject,
        'UNCHANGED',
      ),
      decideDelivery(proofFor(subject, observation(NO_PULL, checks('SUCCESS'))), subject, 'UNCHANGED'),
      decideDelivery(
        proofFor(subject, observation(matched(), checks('PENDING', { pending: 1, succeeded: 1 }))),
        subject,
        'UNCHANGED',
      ),
      decideDelivery(proofFor(subject, observation(matched(), NO_CHECKS)), subject, 'UNCHANGED'),
      decideDelivery(GREEN(), subject, 'UNCHANGED'),
    ]);
    // Derived: every declared member was produced by a real call above. A
    // member added for a future slice and never reached fails here, which is
    // the "no dead enum members" rule as a test rather than a review habit.
    expect([...reached].sort()).toEqual([...DELIVERY_DECISIONS].sort());
  });
});

// ── 2. Freshness: history can never decide ─────────────────────────────────

describe('a positive decision requires this process to have observed', () => {
  /**
   * The counter-proof the whole slice rests on.
   *
   * A forgery that satisfies every *structural* expectation — the right
   * outcome words, the right commit, a plausible instant — and is not a minted
   * proof. It must be refused, and it must be refused into the fail-closed
   * member rather than into a "changed" one, because nothing changed: the
   * observation never happened.
   */
  it('refuses a shape-perfect forgery', () => {
    const forged = {
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      commit: HEAD,
      pullRequestOutcome: 'MATCHED',
      pullRequestNumber: 57,
      pullRequestHeadSha: HEAD,
      checkOutcome: 'SUCCESS',
      checkQueriedCommit: HEAD,
      checkRuns: 2,
      commitStatuses: 0,
      checksFailed: 0,
      checksPending: 0,
      checksSucceeded: 2,
      checksNeutralOrSkipped: 0,
      observedAt: AT,
    } as unknown as DeliveryObservationProof;
    expect(decideDelivery(forged, subjectOf(), 'UNCHANGED')).toBe('OBSERVATION_UNSETTLED');
    // The positive control: the same facts through the real mint do decide.
    expect(decideDelivery(GREEN(), subjectOf(), 'UNCHANGED')).toBe(POSITIVE_DELIVERY_DECISION);
  });

  /**
   * A forgery built from a genuine proof's own prototype.
   *
   * The name and comment here used to claim this exercised the safe accessor's
   * `catch` — a value that passes the registry gate and throws on the
   * private-field read. A review measured it and that is false:
   * `Object.create` never enters the `WeakSet`, so `isDeliveryObservationProof`
   * answers `false` and the value is refused at the gate, one step earlier. The
   * test is kept for what it does prove — the prototype route documented in the
   * mint's header buys nothing — and the claim is corrected to match. The
   * accessor's `catch` remains unpinned; it needs registry capture, which is
   * slice 3's boundary and not reachable from here.
   */
  it('refuses a forgery built from a real proof prototype, at the registry gate', () => {
    const captured = Object.create(
      Object.getPrototypeOf(GREEN()) as object,
    ) as DeliveryObservationProof;
    expect(isDeliveryObservationProof(captured)).toBe(false);
    expect(decideDelivery(captured, subjectOf(), 'UNCHANGED')).toBe('OBSERVATION_UNSETTLED');
  });

  it('decides nothing when no observation was made, however green the history', () => {
    // The exact shape of the forbidden path: everything is settled and good,
    // and this invocation asked nobody. `observed: false` is the whole input.
    expect(
      concludeDeliveryDecision({
        subjectEstablished: true,
        observed: false,
        proof: GREEN(),
        expected: subjectOf(),
        revalidation: 'UNCHANGED',
      }),
    ).toBe('NOT_DECIDED');
  });

  it('reads no clock: an ancient proof and a fresh one decide identically', () => {
    const subject = subjectOf();
    const old = proofFor(subject, observation(matched(), checks('SUCCESS')), LONG_AGO);
    const now = proofFor(subject, observation(matched(), checks('SUCCESS')), AT);
    expect(decideDelivery(old, subject, 'UNCHANGED')).toBe(
      decideDelivery(now, subject, 'UNCHANGED'),
    );
    expect(decideDelivery(old, subject, 'UNCHANGED')).toBe(POSITIVE_DELIVERY_DECISION);
  });

  /**
   * The structural half of the freshness rule, checked as code rather than as
   * behaviour: there is no way in for a stored record because the module cannot
   * name one.
   */
  it('cannot reach a stored record at all', () => {
    const code = codeOnly('src/deliver/delivery-decision.ts');
    expect(code.length).toBeGreaterThan(200);
    expect(code).not.toMatch(/delivery-evidence/);
    expect(code).not.toMatch(/readDeliveryEvidence|loadDeliveryEvidence|DeliveryEvidence\b/);
    // And nothing that could make it impure or authoritative.
    expect(code).not.toMatch(/from '[^']*\/(state|lease|run|agent|loop)\//);
    expect(code).not.toMatch(/\bnode:fs\b|\bnode:child_process\b|\bDate\.now\b|\bnew Date\b/);
  });
});

// ── 3. Exactness: an answer about A never settles a question about B ───────

describe('the decision is bound to exactly one commit', () => {
  it('accepts a proof for the subject it is asked about', () => {
    expect(decideDelivery(GREEN(), subjectOf(HEAD), 'UNCHANGED')).toBe(POSITIVE_DELIVERY_DECISION);
  });

  it('refuses a green proof for another commit', () => {
    // Old SHA A green, current subject B: B must not inherit A's green.
    expect(decideDelivery(GREEN(subjectOf(HEAD)), subjectOf(OTHER), 'UNCHANGED')).toBe(
      'SUBJECT_CHANGED',
    );
  });

  it('refuses a green proof for another repository', () => {
    expect(decideDelivery(GREEN(subjectOf(HEAD, ELSEWHERE)), subjectOf(HEAD), 'UNCHANGED')).toBe(
      'SUBJECT_CHANGED',
    );
  });

  /**
   * Renamed after a review pointed out the old title claimed coverage the body
   * does not have. There is no mintable proof whose two halves name different
   * commits — that comparison is a floor, and the pin for its premise lives in
   * "the mint derives both bound commits from the subject" below. What this
   * body actually proves is the layer beneath: an unsettled half mints nothing
   * at all, so no proof carrying a refusal can reach the decision.
   */
  it('cannot be handed a proof built from an unsettled half', () => {
    const subject = subjectOf(HEAD);
    expect(
      attestDeliveryObservation(
        subject,
        observation({ outcome: 'FORGE_CLIENT_ABSENT' }, checks('SUCCESS')),
        AT,
      ),
    ).toBeNull();
    // The positive control: the same subject with both halves settled does mint
    // and does decide, so the null above is the refusal and not a broken fixture.
    expect(
      decideDelivery(proofFor(subject, observation(matched(), checks('SUCCESS'))), subject, 'UNCHANGED'),
    ).toBe(POSITIVE_DELIVERY_DECISION);
  });

  it('refuses when the pull request no longer has this commit as its head', () => {
    // The same pull request, its head moved on. The observation layer answers
    // NO_MATCHING_PULL_REQUEST for the old commit, and the decision must be a
    // refusal rather than a match carried over by number.
    const subject = subjectOf(HEAD);
    expect(
      decideDelivery(proofFor(subject, observation(NO_PULL, checks('SUCCESS'))), subject, 'UNCHANGED'),
    ).toBe('PULL_REQUEST_REQUIRED');
  });
});

// ── 4. The grading ladder, and its precedence ──────────────────────────────

describe('the two answers are graded together', () => {
  const subject = subjectOf();
  const decide = (
    pull: PullRequestObservation,
    check: CheckStateObservation,
  ): DeliveryDecision => decideDelivery(proofFor(subject, observation(pull, check)), subject, 'UNCHANGED');

  it('is positive for one matched open pull request whose checks graded SUCCESS', () => {
    expect(decide(matched(), checks('SUCCESS'))).toBe(POSITIVE_DELIVERY_DECISION);
  });

  it('refuses a pending check', () => {
    expect(decide(matched(), checks('PENDING', { pending: 1, succeeded: 1 }))).toBe('CHECKS_PENDING');
  });

  it('refuses a failed check', () => {
    expect(decide(matched(), checks('FAILED', { failed: 1, succeeded: 1 }))).toBe('CHECKS_FAILED');
  });

  it('refuses a commit with no checks at all', () => {
    // Absent checks are not passing checks. This is the arm most likely to be
    // "simplified" into success by someone reading NO_CHECKS as "nothing wrong".
    expect(decide(matched(), NO_CHECKS)).toBe('CHECKS_ABSENT');
  });

  /**
   * The case that made the positive decision rename itself.
   *
   * A commit whose only check run was `skipped` aggregates to `SUCCESS` with
   * `succeeded: 0` — `aggregateCheckState` counts `neutral`/`skipped` as
   * non-blocking, and a path-filtered or `if:`-guarded workflow job produces
   * exactly that on ordinary repositories. The decision is reached, and the
   * member used to be called `…_CHECKS_PASSED` with a sentence saying "every
   * check on this commit had succeeded", which was false of this input while
   * the counts printed directly above it said `0 succeeded`.
   *
   * The behaviour is unchanged and deliberate; what changed is that the name
   * and the sentence now describe it. This test exists so the disclosure cannot
   * quietly drift back.
   */
  it('reaches the positive decision for a commit whose only check was skipped', () => {
    const skippedOnly = Object.freeze({
      outcome: 'SUCCESS' as const,
      counts: Object.freeze({
        checkRuns: 1,
        commitStatuses: 0,
        failed: 0,
        pending: 0,
        succeeded: 0,
        neutralOrSkipped: 1,
      }),
    });
    expect(decide(matched(), skippedOnly)).toBe(POSITIVE_DELIVERY_DECISION);
    // And the sentence the operator reads does not claim anything succeeded.
    const sentence = DELIVERY_DECISION_DETAIL[POSITIVE_DELIVERY_DECISION];
    expect(sentence).not.toContain('every check on this commit had succeeded');
    expect(sentence).toContain('graded SUCCESS');
    expect(sentence).toContain('nothing having succeeded');
  });

  it('refuses when no open pull request has this head', () => {
    expect(decide(NO_PULL, checks('SUCCESS'))).toBe('PULL_REQUEST_REQUIRED');
  });

  it('refuses when more than one open pull request claims this head', () => {
    expect(decide(ambiguous(11, 12), checks('SUCCESS'))).toBe('PULL_REQUEST_AMBIGUOUS');
  });

  /**
   * The precedence, asserted rather than left to whoever reads the ladder.
   *
   * Each row is a case where two answers are both unhappy, and the contract is
   * which one the operator is sent to first.
   */
  it('puts a failed check ahead of every pull-request answer', () => {
    const failed = checks('FAILED', { failed: 1, succeeded: 1 });
    expect(decide(NO_PULL, failed)).toBe('CHECKS_FAILED');
    expect(decide(ambiguous(11, 12), failed)).toBe('CHECKS_FAILED');
    expect(decide(matched(), failed)).toBe('CHECKS_FAILED');
  });

  it('puts a missing pull request ahead of a pending or absent check', () => {
    expect(decide(NO_PULL, checks('PENDING', { pending: 1, succeeded: 1 }))).toBe(
      'PULL_REQUEST_REQUIRED',
    );
    expect(decide(NO_PULL, NO_CHECKS)).toBe('PULL_REQUEST_REQUIRED');
  });
});

// ── 5. The local subject is re-established after the answers come back ─────

describe('the local subject is re-checked', () => {
  it('is a closed three-member verdict', () => {
    expect(new Set(SUBJECT_REVALIDATIONS).size).toBe(SUBJECT_REVALIDATIONS.length);
    expect([...SUBJECT_REVALIDATIONS].sort()).toEqual(['CHANGED', 'UNAVAILABLE', 'UNCHANGED']);
  });

  it('holds when nothing moved', () => {
    expect(revalidateSubject(localSubject(), localSubject())).toBe('UNCHANGED');
  });

  it('sees a new pinned commit', () => {
    expect(revalidateSubject(localSubject(HEAD), localSubject(OTHER))).toBe('CHANGED');
  });

  it('sees a changed task state, even at the same commit', () => {
    // The case a commit comparison alone would miss: the task was abandoned
    // while the forge was being asked, and delivering it is no longer intended.
    expect(revalidateSubject(localSubject(HEAD, 'READY_FOR_PR'), localSubject(HEAD, 'ABORTED'))).toBe(
      'CHANGED',
    );
  });

  it('sees a repointed delivery target', () => {
    expect(
      revalidateSubject(localSubject(HEAD, 'READY_FOR_PR'), localSubject(HEAD, 'READY_FOR_PR', ELSEWHERE)),
    ).toBe('CHANGED');
  });

  it('distinguishes a subject that could not be re-read from one that changed', () => {
    expect(revalidateSubject(localSubject(), null)).toBe('UNAVAILABLE');
  });

  it('turns a green observation into a refusal when the subject moved', () => {
    expect(decideDelivery(GREEN(), subjectOf(), 'CHANGED')).toBe('SUBJECT_CHANGED');
    expect(decideDelivery(GREEN(), subjectOf(), 'UNAVAILABLE')).toBe('SUBJECT_REVALIDATION_FAILED');
  });

  /**
   * The case where both refusals are true at once, which the declared order has
   * to settle and did not.
   *
   * A review measured this against the documented precedence and found them
   * disagreeing: the list put `SUBJECT_REVALIDATION_FAILED` first while the code
   * answers `SUBJECT_CHANGED`. The code is the better answer — "these answers
   * are about something else" is a fact about the artefact in hand, and it does
   * not depend on the second look succeeding — so the list moved, and the
   * behaviour is pinned here rather than left to whoever reads the ladder.
   */
  it('answers SUBJECT_CHANGED when the proof is about another subject and the re-read also failed', () => {
    expect(decideDelivery(GREEN(subjectOf(HEAD)), subjectOf(OTHER), 'UNAVAILABLE')).toBe(
      'SUBJECT_CHANGED',
    );
  });

  /**
   * A proof and no second look at all.
   *
   * This is the branch a counter-proof created. The caller used to substitute a
   * verdict it had not obtained, and swapping that substitute from `UNAVAILABLE`
   * to `UNCHANGED` broke nothing, because a fabricated value is not reachable
   * through the public contract. It is `null` now, and `null` is refused by
   * name — which this test can reach.
   */
  it('refuses a proof that arrives with no second look taken', () => {
    expect(
      concludeDeliveryDecision({
        subjectEstablished: true,
        observed: true,
        proof: GREEN(),
        expected: subjectOf(),
        revalidation: null,
      }),
    ).toBe('SUBJECT_REVALIDATION_FAILED');
  });
});

// ── 5b. The premises the two remaining floors stand on ─────────────────────

describe('the mint derives both bound commits from the subject', () => {
  /**
   * Two comparisons in `decideDelivery` are floors rather than live gates —
   * measured, by mutants that survived: the head-equality test and the
   * queried-commit test cannot fail for any proof this build can mint, because
   * the mint writes both fields from the subject rather than from the response.
   *
   * That is exactly why the premise is pinned here instead of assumed in a
   * comment. If the mint ever starts copying either field from somewhere else,
   * this test fails first and the two floors become live gates rather than
   * quietly-wrong ones.
   */
  it('writes the matched head and the queried commit from the subject itself', () => {
    const subject = subjectOf(HEAD);
    const facts = deliveryObservationFactsOf(
      proofFor(subject, observation(matched(4242), checks('SUCCESS'))),
    );
    expect(facts).not.toBeNull();
    expect(facts?.commit).toBe(HEAD);
    expect(facts?.pullRequestHeadSha).toBe(HEAD);
    expect(facts?.checkQueriedCommit).toBe(HEAD);
    expect(facts?.pullRequestNumber).toBe(4242);

    // And an unmatched outcome carries no head at all, which is what makes the
    // `matched` conjunction in the decision meaningful rather than decorative.
    const none = deliveryObservationFactsOf(
      proofFor(subject, observation(NO_PULL, checks('SUCCESS'))),
    );
    expect(none?.pullRequestHeadSha).toBeNull();
    expect(none?.pullRequestNumber).toBeNull();
  });
});

// ── 6. The state machine is untouched ──────────────────────────────────────

describe('this slice grants nothing and moves nothing', () => {
  it('leaves READY_FOR_PR terminal, with no outgoing transition', () => {
    expect([...TERMINAL_STATES]).toContain('READY_FOR_PR');
    expect(isTerminalState('READY_FOR_PR')).toBe(true);
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
  });

  it('adds no state the loop would drive', () => {
    // Derived: whatever the loop drives, none of it is new here, and no state
    // in the whole vocabulary is one this slice introduced. The decision lives
    // outside the state machine entirely — see the disjointness assertion above.
    for (const state of LOOP_DRIVEN_STATES) expect(isTerminalState(state)).toBe(false);
    expect([...LOOP_DRIVEN_STATES]).not.toContain('READY_FOR_PR');
  });

  /**
   * The whole delivery surface, derived from the tree rather than listed.
   *
   * Slice 3 arrived at this shape after three rounds of a hand-written array
   * outrunning its own title. The set is the same one, re-derived here, and the
   * criteria are this slice's: nothing decides its way into a task-state write,
   * a lease, an agent, or a forge mutation *through an API call*.
   *
   * The title used to end "and no forge mutation", and V4 slice 5 made that
   * false: the surface now contains a `git push` that creates one ref on the
   * delivery remote. Every regex below still holds — none of them was ever what
   * made that claim true — so what is narrowed here is the sentence, not the
   * guard. The claim the sentence used to carry now lives where it can actually
   * be measured: `tests/v4-05-delivery-head-publication.test.ts` derives the
   * mutating surface from the tree and proves it is one module running one
   * create-only vector.
   */
  it('names no writer, no lease, no agent and no API mutation, anywhere in the delivery surface', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
      });
    const SURFACE = [
      ...walk('src/deliver'),
      'src/cli/delivery-command.ts',
      'src/cli/render-delivery-observation.ts',
    ].sort();

    expect(SURFACE.length).toBeGreaterThanOrEqual(9);
    expect(SURFACE).toContain('src/deliver/delivery-decision.ts');
    expect(SURFACE).toContain('src/deliver/internal/delivery-observation-proof.ts');

    // One module may name a POST and one may name a PUT, each by name.
    // Everything else on the surface may name neither, and no module anywhere
    // may name PATCH or DELETE — those are the methods that replace and
    // destroy, and this build performs neither.
    //
    // PUT left the forbidden set at V4 slice 7, which merges one pull request
    // with it. It is pinned to one module rather than dropped, which is the
    // same shape slice 6 gave POST when it added one: the guarantee that
    // survives is "one module, named here", and a second module acquiring the
    // method turns this red.
    //
    // Both spellings: the token pair a real vector uses, and the single string
    // a careless one might.
    const POST_METHOD = /-X\s*POST|['\"]-X['\"]\s*,\s*['\"]POST['\"]/;
    const PUT_METHOD = /-X\s*PUT|['\"]-X['\"]\s*,\s*['\"]PUT['\"]/;
    const WRITING_METHOD =
      /-X\s*(PATCH|DELETE)|['\"]-X['\"]\s*,\s*['\"](PATCH|DELETE)['\"]/;
    const CREATOR = 'src/deliver/github-pull-request-creator.ts';
    const MERGER = 'src/deliver/github-pull-request-merger.ts';
    expect(SURFACE, 'the creator must be on the surface being swept').toContain(CREATOR);
    expect(SURFACE, 'the merger must be on the surface being swept').toContain(MERGER);

    for (const file of SURFACE) {
      const code = codeOnly(file);
      // Positive control: the stripper left real code, not just whitespace.
      // It used to be `> 200`, which was a size rule wearing a control's
      // clothing — `internal/delivery-ref-grammar.ts` is two regular
      // expressions and a lot of comment, and it turned this red without any
      // claim here becoming false. It was then `> 0`, which a review showed is
      // a tautology: `codeOnly` replaces a comment with a space and keeps every
      // newline, so an all-comment file passes it. Non-whitespace length is the
      // floor that survives the real case and still catches the empty one.
      expect(code.replace(/\s+/g, '').length, file).toBeGreaterThan(30);
      expect(code, file).not.toMatch(/\badvanceTaskState\s*\(/);
      expect(code, file).not.toMatch(/\bsaveTaskState\s*\(/);
      // The lease clause that used to sit here moved, once, when V4 slice 9
      // gave `--verify-merge` the execution lease — the first delivery act that
      // starts the repository's own build and test commands. It is not dropped:
      // the whole delivery surface still acquires a lease in exactly one file,
      // exactly once, released in a `finally`, and nowhere under `src/deliver/`.
      // That is asserted in `tests/v4-09-post-merge-verification.test.ts`, in
      // 'takes the execution lease in exactly one place'. Restating it here would
      // be five copies of one fact with nothing making them agree — the shape
      // `L-V4-08-7` already names.
      expect(code, file).not.toMatch(/\brunOwnedCommand\s*\(|\bspawn\s*\(/);
      // No merge THIS BUILD DOES NOT PERFORM, in any spelling it could reach
      // one by. V4 slice 7 merges exactly one pull request, through `gh api`
      // and the module pinned above; what stays forbidden everywhere is the
      // client's own merge command and every form of deferred or queued merge,
      // because those are merges that happen when nobody is watching.
      expect(code, file).not.toMatch(/['"]pr['"]\s*,\s*['"]merge['"]|gh pr merge|--auto\b/);
      expect(code, file).not.toMatch(/\benableAutoMerge\b|\bauto_merge\b|\bmerge_queue\b/);
      expect(code, file).not.toMatch(/merge-async/);
      expect(code, file).not.toMatch(WRITING_METHOD);
      if (file !== CREATOR) expect(code, file).not.toMatch(POST_METHOD);
      if (file !== MERGER) expect(code, file).not.toMatch(PUT_METHOD);
    }

    // And the corpus really is source, so the per-file floor above is a control
    // on stripping rather than a licence for an empty sweep.
    expect(SURFACE.map((f) => codeOnly(f)).join('').length).toBeGreaterThan(20_000);
    // False-negative guard, and it caught a real hole. The pattern here used to
    // be `/-X\s*(POST|PATCH|PUT|DELETE)/`, which reads a *string* `-X POST` and
    // sees nothing at all in `['api', '-X', 'POST', path]` — which is exactly
    // how every vector in this build is written. The sweep was blind to the one
    // spelling it would actually meet. Both forms are matched now, and the guard
    // below is what proves it, because the creator writes the split form.
    expect(codeOnly(CREATOR)).toMatch(POST_METHOD);
    expect("runner('gh', ['api', '-X', 'PATCH', p])").toMatch(WRITING_METHOD);
    expect("const a = ['api', '-X DELETE', p]").toMatch(WRITING_METHOD);
    // And the method that LEFT the forbidden set at V4 slice 7 has its own
    // control, so "PUT is confined to one module" is measured rather than a
    // pattern nobody proved matches anything.
    expect("['api', '-X', 'PUT', p]").toMatch(PUT_METHOD);
    expect("const a = ['api', '-X PUT', p]").toMatch(PUT_METHOD);
  });
});

// ── 7. The command surface ─────────────────────────────────────────────────

describe('the delivery command decides only when asked', () => {
  const DECLARED: ResolvedDelivery = Object.freeze({
    declared: true as const,
    remoteName: 'origin',
    result: Object.freeze({ outcome: 'RESOLVED' as const, target: IDENTITY }),
  });

  const ELSEWHERE_DECLARED: ResolvedDelivery = Object.freeze({
    declared: true as const,
    remoteName: 'origin',
    result: Object.freeze({ outcome: 'RESOLVED' as const, target: ELSEWHERE }),
  });

  function loadedState(root: string, commit: string | null = HEAD, state = 'READY_FOR_PR'): StateLoadResult {
    return {
      ok: true,
      code: 'LOADED',
      classification: 'STATE_VALID',
      state: { state, currentCommit: commit, basePinnedCommit: BASE } as never,
      path: join(root, 'state.json'),
      revision: REV,
    };
  }

  const UNREADABLE: StateLoadResult = {
    ok: false,
    code: 'CONTRACT_VIOLATION',
    classification: 'STATE_INVALID',
    path: null,
    detail: null,
    errnoCode: null,
  } as never;

  function commandResult(over: Partial<CommandResult>): CommandResult {
    return {
      display: 'gh api',
      executable: 'gh',
      args: [],
      started: true,
      outcome: 'COMPLETED',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:00:01.000Z',
      ...over,
    } as CommandResult;
  }

  function runnerFor(headSha: string, conclusion = 'success'): ForgeCommandRunner {
    return async (_command, args) => {
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      const key = path.split('/').pop() ?? '';
      const stdout =
        key === 'pulls'
          ? JSON.stringify([{ number: 57, state: 'open', head: { sha: headSha } }])
          : key === 'check-runs'
            ? JSON.stringify({
                total_count: 2,
                check_runs: [
                  { status: 'completed', conclusion, head_sha: HEAD },
                  { status: 'completed', conclusion, head_sha: HEAD },
                ],
              })
            : JSON.stringify({ sha: HEAD, total_count: 0, statuses: [] });
      return commandResult({ stdout, args: [...args] });
    };
  }

  function scratchRoot(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'ao-v404-'));
    mkdirSync(join(root, '.agent-orchestrator', 'runtime', 'delivery'), { recursive: true });
    return {
      root,
      cleanup: () => {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          // A scratch directory a test could not remove is not a test failure.
        }
      },
    };
  }

  interface HarnessOptions {
    readonly runner?: ForgeCommandRunner;
    /** The task record, per `loadTaskState` call. The last entry repeats. */
    readonly loads?: readonly StateLoadResult[];
    /** The delivery target, per `resolveRepository` call. The last entry repeats. */
    readonly deliveries?: readonly ResolvedDelivery[];
  }

  function harness(root: string, options: HarnessOptions = {}) {
    const out: string[] = [];
    const seen: string[][] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const loads = options.loads ?? [loadedState(root)];
    const deliveries = options.deliveries ?? [DECLARED];
    let loadCall = 0;
    let resolveCall = 0;
    const at = (list: readonly unknown[], index: number): unknown =>
      list[Math.min(index, list.length - 1)];

    const runner: ForgeCommandRunner = async (command, args, opts) => {
      seen.push([...args]);
      return (options.runner ?? runnerFor(HEAD))(command, args, opts);
    };

    const program = new Command();
    program.exitOverride();
    registerDeliveryCommand(program, {
      resolveRepository: async () => {
        const delivery = at(deliveries, resolveCall) as ResolvedDelivery;
        resolveCall += 1;
        return { ok: true, repository: { id: 'ao', root, delivery } } as never;
      },
      loadTaskState: () => {
        const load = at(loads, loadCall) as StateLoadResult;
        loadCall += 1;
        return load;
      },
      runner,
      envSource: { PATH: '/usr/bin' },
      now: () => new Date(AT),
      checkIgnored: async () => 'IGNORED',
    });
    return {
      program,
      out,
      seen,
      restore: () => spy.mockRestore(),
      calls: () => ({ loads: loadCall, resolves: resolveCall }),
    };
  }

  const run = async (h: { program: Command }, root: string, ...flags: string[]): Promise<void> => {
    await h.program.parseAsync(['delivery', '--repository', root, '--task', 'T-001', ...flags], {
      from: 'user',
    });
  };

  it('prints no decision at all without --decide', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root, '--observe');
      const text = h.out.join('');
      // The control: the observation really happened.
      expect(text).toContain('MATCHED');
      expect(text).not.toContain('Decision');
      expect(text).not.toContain(MERGE_ELIGIBILITY_SENTENCE);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('decides, and says what it is not, on a green observation', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root, '--observe', '--decide');
      const text = h.out.join('');
      expect(text).toContain(`Decision     : ${POSITIVE_DELIVERY_DECISION}`);
      expect(text).toContain(DELIVERY_DECISION_DETAIL[POSITIVE_DELIVERY_DECISION]);
      // The sentence rides with the positive decision, not only the refusals.
      expect(text).toContain(MERGE_ELIGIBILITY_SENTENCE);
      // The second look is reported even though it held.
      expect(text).toContain('Local subject re-checked after the answers came back: UNCHANGED.');
      // And nothing became durable.
      expect(readdirSync(join(scratch.root, '.agent-orchestrator', 'runtime', 'delivery'))).toEqual(
        [],
      );
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('contacts nothing for --decide alone, and answers NOT_DECIDED', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root, '--decide');
      const text = h.out.join('');
      expect(text).toContain('Decision     : NOT_DECIDED');
      expect(text).toContain(DELIVERY_DECISION_DETAIL.NOT_DECIDED);
      // Not "UNCHANGED": no re-read was taken, and claiming one would be the
      // failure the nullable verdict exists to prevent.
      expect(text).toContain('The local subject was not re-checked');
      expect(text).not.toContain('re-checked after the answers came back');
      expect(h.seen).toEqual([]);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('re-reads the local subject after observing, and refuses when it moved', async () => {
    const scratch = scratchRoot();
    // The first read pins HEAD and builds the subject; the second, taken after
    // the forge answered, finds a task that has moved on.
    const h = harness(scratch.root, {
      loads: [loadedState(scratch.root, HEAD), loadedState(scratch.root, OTHER)],
    });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      const text = h.out.join('');
      // The answers were obtained — this is a refusal about staleness, not
      // about the forge.
      expect(text).toContain('MATCHED');
      expect(text).toContain('Decision     : SUBJECT_CHANGED');
      expect(text).toContain('Local subject re-checked after the answers came back: CHANGED.');
      expect(h.calls().loads).toBeGreaterThanOrEqual(2);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses when the delivery target is repointed mid-flight', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, { deliveries: [DECLARED, ELSEWHERE_DECLARED] });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      const text = h.out.join('');
      expect(text).toContain('Decision     : SUBJECT_CHANGED');
      expect(h.calls().resolves).toBeGreaterThanOrEqual(2);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses when the task record cannot be read back', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, { loads: [loadedState(scratch.root, HEAD), UNREADABLE] });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      const text = h.out.join('');
      expect(text).toContain('Decision     : SUBJECT_REVALIDATION_FAILED');
      expect(text).toContain('Local subject re-checked after the answers came back: UNAVAILABLE.');
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses when the pull request head has moved past the subject', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, { runner: runnerFor(OTHER) });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      const text = h.out.join('');
      expect(text).toContain('NO_MATCHING_PULL_REQUEST');
      expect(text).toContain('Decision     : PULL_REQUEST_REQUIRED');
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses a failed check', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, { runner: runnerFor(HEAD, 'failure') });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      expect(h.out.join('')).toContain('Decision     : CHECKS_FAILED');
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('decides without touching the record, and records without needing a decision', async () => {
    const scratch = scratchRoot();
    const dir = join(scratch.root, '.agent-orchestrator', 'runtime', 'delivery');
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root, '--observe', '--decide');
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      h.restore();
    }
    const h2 = harness(scratch.root);
    try {
      await run(h2, scratch.root, '--observe', '--record');
      const text = h2.out.join('');
      expect(readdirSync(dir)).toEqual(['T-001.json']);
      expect(text).toContain('Record       : RECORDED');
      // Slice 3's semantics are untouched: recording alone prints no decision.
      expect(text).not.toContain('Decision');
    } finally {
      h2.restore();
      scratch.cleanup();
    }
  });

  it('binds one record and one decision to the same observed instant', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root, '--observe', '--decide', '--record');
      const text = h.out.join('');
      expect(text).toContain('Record       : RECORDED');
      expect(text).toContain(`Decision     : ${POSITIVE_DELIVERY_DECISION}`);
      // One mint, one instant: the stored record's `observedAt` is this
      // invocation's clock, and the decision was taken from the same proof.
      expect(text).toContain(`at ${AT} this was MATCHED (#57)`);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('still refuses --record without --observe while deciding nothing', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root, '--record', '--decide');
      const text = h.out.join('');
      expect(text).toContain('RECORD_REQUIRES_OBSERVATION');
      expect(text).toContain('Decision     : NOT_DECIDED');
      expect(h.seen).toEqual([]);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('makes only read-only requests, whatever the flags', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root, '--observe', '--decide', '--record');
      expect(h.seen.length).toBeGreaterThan(0);
      for (const args of h.seen) {
        expect(args.slice(0, 5)).toEqual(['api', '--hostname', 'github.com', '-X', 'GET']);
        expect(args.join(' ')).not.toMatch(/POST|PATCH|PUT|DELETE|merge|graphql/);
      }
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('decides for a task that is not READY_FOR_PR, and says which state it is in', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, {
      loads: [loadedState(scratch.root, HEAD, 'VERIFYING'), loadedState(scratch.root, HEAD, 'VERIFYING')],
    });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      const text = h.out.join('');
      // Truthful and useful: the two facts hold whatever phase the task is in,
      // and the state is printed so nobody reads the decision as a claim about
      // the task being finished.
      expect(text).toContain('State        : VERIFYING');
      expect(text).toContain(`Decision     : ${POSITIVE_DELIVERY_DECISION}`);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('decides nothing when there is no subject', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, { loads: [loadedState(scratch.root, null)] });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      const text = h.out.join('');
      expect(text).toContain('NO_CURRENT_COMMIT');
      expect(text).toContain('Decision     : SUBJECT_NOT_ESTABLISHED');
      expect(h.seen).toEqual([]);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  /**
   * A refused observation is not a re-checked subject.
   *
   * The gate used to be "a request was attempted" rather than "an answer was
   * settled", and a review drove a refusing forge through it: the report said
   * "Local subject re-checked after the answers came back: UNCHANGED" on a run
   * where no answer came back, and paid a whole `resolveRepository` — several
   * Git children — to learn nothing. Both halves are asserted, the sentence and
   * the absence of the work.
   */
  it('decides nothing when the forge did not answer, and re-reads nothing', async () => {
    const scratch = scratchRoot();
    const refusing: ForgeCommandRunner = async () =>
      commandResult({ started: false, outcome: 'NOT_FOUND', exitCode: null });
    const h = harness(scratch.root, { runner: refusing });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      const text = h.out.join('');
      expect(text).toContain('Decision     : OBSERVATION_UNSETTLED');
      expect(text).toContain('The local subject was not re-checked');
      expect(text).not.toContain('re-checked after the answers came back');
      // One resolve and one load: the second pass never ran.
      expect(h.calls()).toEqual({ loads: 1, resolves: 1 });
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  /**
   * The exit code is not the decision channel, and that is asserted rather than
   * merely intended.
   *
   * A caller that could read "deliver this" out of an exit status would have
   * been handed the machine-consumable merge signal this slice exists not to
   * give. So the code answers exactly what it answered in slices 2 and 3 —
   * "was the observation settled" — and `--decide` does not move it, whichever
   * way the decision came out.
   */
  it('leaves the exit code answering only whether the observation settled', async () => {
    const previous = process.exitCode;
    const scratch = scratchRoot();
    try {
      // A positive decision: settled, so zero.
      const green = harness(scratch.root);
      try {
        process.exitCode = undefined;
        await run(green, scratch.root, '--observe', '--decide');
        expect(green.out.join('')).toContain(`Decision     : ${POSITIVE_DELIVERY_DECISION}`);
        expect(process.exitCode).toBe(EXIT_RUN_OK);
      } finally {
        green.restore();
      }

      // A failing check is an *answer*, so it is still zero. This is the pin
      // that stops anyone turning the decision into an exit status.
      const red = harness(scratch.root, { runner: runnerFor(HEAD, 'failure') });
      try {
        process.exitCode = undefined;
        await run(red, scratch.root, '--observe', '--decide');
        expect(red.out.join('')).toContain('Decision     : CHECKS_FAILED');
        expect(process.exitCode).toBe(EXIT_RUN_OK);
      } finally {
        red.restore();
      }

      // An unsettled observation is not an answer, and that one does move it —
      // exactly as it did before this slice existed.
      const refused = harness(scratch.root, {
        runner: async () => commandResult({ started: false, outcome: 'NOT_FOUND', exitCode: null }),
      });
      try {
        process.exitCode = undefined;
        await run(refused, scratch.root, '--observe', '--decide');
        expect(process.exitCode).toBe(EXIT_RUN_REFUSED);
      } finally {
        refused.restore();
      }
    } finally {
      process.exitCode = previous;
      scratch.cleanup();
    }
  });

  it('registers --decide with the sentence that was pinned, not a copy', () => {
    // Pinning `DECIDE_OPTION_DESCRIPTION` by literal proves what the constant
    // says; it does not prove commander was ever given it. An inline copy at
    // the registration site would satisfy every other assertion in this file
    // while the operator read a different sentence. Slices 2 and 3 both pin
    // the wiring of their own flag for exactly that reason.
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      const delivery = h.program.commands.find((c) => c.name() === 'delivery');
      const help = delivery?.helpInformation() ?? '';
      const collapse = (t: string): string => t.replace(/\s+/g, ' ').trim();
      expect(help).toContain('--decide');
      expect(collapse(help)).toContain(collapse(DECIDE_OPTION_DESCRIPTION));
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });
});

// ── 8. The operator surface says what it can and cannot ────────────────────

describe('the surface states its own limits', () => {
  it('describes --decide as requiring a fresh observation and granting nothing', () => {
    expect(DECIDE_OPTION_DESCRIPTION).toContain('Requires --observe');
    expect(DECIDE_OPTION_DESCRIPTION).toContain('does not establish merge eligibility');
    expect(DECIDE_OPTION_DESCRIPTION).toContain('Writes nothing');
  });

  it('keeps the command description true of the whole surface', () => {
    // Slice 2's and slice 3's clauses must survive slice 4 rather than be
    // replaced by it — the description is one sentence about one command.
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('two read-only questions');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--record');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('historical record');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--decide');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('not merge eligibility');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('writes no task state');
  });

  it('renders no decision block when none was asked for', () => {
    const text = renderDeliveryObservation({
      repositoryId: 'ao',
      repositoryRoot: 'C:/repo',
      taskId: 'T-001',
      subject: {
        ok: true,
        subject: subjectOf(),
        taskState: 'READY_FOR_PR',
        remoteName: 'origin',
      },
      observation: observation(matched(), checks('SUCCESS')),
      conclusion: 'OBSERVED',
    });
    expect(text).toContain('MATCHED');
    expect(text).not.toContain('Decision');
    expect(text).not.toContain(MERGE_ELIGIBILITY_SENTENCE);
  });

  it('never renders a decision as a claim about now', () => {
    const text = renderDeliveryObservation({
      repositoryId: 'ao',
      repositoryRoot: 'C:/repo',
      taskId: 'T-001',
      subject: {
        ok: true,
        subject: subjectOf(),
        taskState: 'READY_FOR_PR',
        remoteName: 'origin',
      },
      observation: observation(matched(), checks('SUCCESS')),
      conclusion: 'OBSERVED',
      decision: { decision: POSITIVE_DELIVERY_DECISION, revalidation: 'UNCHANGED' },
    });
    expect(text).toContain(MERGE_ELIGIBILITY_SENTENCE);
    // The words a reader must never find beside a positive decision.
    expect(text).not.toMatch(/is mergeable|ready to merge|merge eligible|safe to merge/i);
  });
});
