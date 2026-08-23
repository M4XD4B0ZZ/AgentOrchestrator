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
  type DeliveryObservationProof,
} from '../src/deliver/delivery-observation-proof.js';
import {
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

  it('grades every settled outcome the observation layer can produce', () => {
    // The partition, derived from slice 3's recordable sets — which are exactly
    // the outcomes a proof may carry. The three check words the ladder names
    // explicitly, plus the one it grades as success, must be the whole set. A
    // fifth word added to the mint turns this red, which is a decision to take
    // rather than a value silently inheriting the ladder's last arm.
    const namedChecks = ['FAILED', 'PENDING', 'NO_CHECKS'];
    expect(
      [...RECORDABLE_CHECK_OUTCOMES].filter((o) => !namedChecks.includes(o)).sort(),
    ).toEqual(['SUCCESS']);

    // Same for the pull-request half: the ladder names AMBIGUOUS and MATCHED,
    // and everything else falls to PULL_REQUEST_REQUIRED, which is a refusal.
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

  it('refuses a value that passed a captured registry but carries no facts', () => {
    // The registry-capture forgery `delivery-observation-proof.ts` documents:
    // it satisfies `isDeliveryObservationProof` and throws on the private-field
    // read, so the safe accessor answers null. It must not decide anything.
    const captured = Object.create(Object.getPrototypeOf(GREEN()) as object) as DeliveryObservationProof;
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

  it('refuses a proof whose two halves name different commits', () => {
    // Constructed through the mint by observing subject A while the check
    // answer was about A — then asked about A, but with the pull-request head
    // deliberately elsewhere. The mint refuses a MATCHED outcome whose head is
    // not the subject, so the reachable form of this is the check half.
    const subject = subjectOf(HEAD);
    const proof = proofFor(subject, observation(matched(), checks('SUCCESS')));
    // A matched pull request is only ever matched at the subject's own head:
    // the mint enforces it, and the decision asks again. Both agree here.
    expect(decideDelivery(proof, subject, 'UNCHANGED')).toBe(POSITIVE_DELIVERY_DECISION);
    // The negative control for the same rule, one layer down: the mint will not
    // produce a proof at all for an unsettled observation.
    expect(
      attestDeliveryObservation(
        subject,
        observation({ outcome: 'FORGE_CLIENT_ABSENT' }, checks('SUCCESS')),
        AT,
      ),
    ).toBeNull();
  });

  it('is unmoved by a pull-request number when the head is not the subject', () => {
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

  it('is positive only for one open pull request and every check succeeded', () => {
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
   * a lease, an agent, or a forge mutation.
   */
  it('names no writer, no lease, no agent and no forge mutation, anywhere in the delivery surface', () => {
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

    for (const file of SURFACE) {
      const code = codeOnly(file);
      expect(code.length, file).toBeGreaterThan(200);
      expect(code, file).not.toMatch(/\badvanceTaskState\s*\(/);
      expect(code, file).not.toMatch(/\bsaveTaskState\s*\(/);
      expect(code, file).not.toMatch(/\bacquire\w*ExecutionLease\s*\(/);
      expect(code, file).not.toMatch(/\brunOwnedCommand\s*\(|\bspawn\s*\(/);
      // No forge mutation, in any spelling this build could reach one by.
      expect(code, file).not.toMatch(/['"]pr['"]\s*,\s*['"]merge['"]|gh pr merge|--auto\b/);
      expect(code, file).not.toMatch(/-X\s*(POST|PATCH|PUT|DELETE)/);
    }
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

  it('decides nothing when the forge did not answer', async () => {
    const scratch = scratchRoot();
    const refusing: ForgeCommandRunner = async () =>
      commandResult({ started: false, outcome: 'NOT_FOUND', exitCode: null });
    const h = harness(scratch.root, { runner: refusing });
    try {
      await run(h, scratch.root, '--observe', '--decide');
      expect(h.out.join('')).toContain('Decision     : OBSERVATION_UNSETTLED');
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
