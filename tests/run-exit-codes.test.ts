/**
 * The exit-code contract of `agent-loop run` (V2-01, extended by V2-05).
 *
 * All three mappings are pinned as *total*: every plan conclusion, every run
 * outcome and every start outcome must have a documented exit code, so widening
 * any of those vocabularies forces a deliberate decision in
 * `run-exit-codes.ts` rather than an accidental `undefined` exit. The individual
 * assignments are pinned too — an exit code is an operator-facing contract, and
 * changing one is a visible act.
 *
 * The start-outcome section additionally proves that its own expectation table
 * is load-bearing, by mutating it and checking the mutation is caught. See the
 * comment above that section for why that check exists and what it is guarding
 * against.
 */

import { describe, expect, it } from 'vitest';

import {
  EXIT_RUN_CALL_AGAIN,
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  exitCodeForPlan,
  exitCodeForRunOutcome,
  exitCodeForStartOutcome,
} from '../src/cli/run-exit-codes.js';
import { RUN_OUTCOMES } from '../src/run/run-driver.js';
import { RUN_PLAN_CONCLUSIONS } from '../src/run/run-plan.js';
import { START_TASK_OUTCOMES } from '../src/run/start-task.js';

describe('exit codes are distinct and stable', () => {
  it('keeps the six codes distinct', () => {
    const codes = [
      EXIT_RUN_OK,
      EXIT_RUN_UNEXPECTED,
      EXIT_RUN_INPUT_UNUSABLE,
      EXIT_RUN_NEEDS_OPERATOR,
      EXIT_RUN_REFUSED,
      EXIT_RUN_CALL_AGAIN,
    ];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('every plan conclusion has an exit code', () => {
  it.each([...RUN_PLAN_CONCLUSIONS])('%s maps to a documented code', (conclusion) => {
    const code = exitCodeForPlan(conclusion);
    expect([0, 2, 3]).toContain(code);
  });

  /** The same partition shape as the run-outcome table below. */
  it('assigns every conclusion to exactly the documented group', () => {
    const grouped = new Map<number, string[]>();
    for (const conclusion of RUN_PLAN_CONCLUSIONS) {
      const code = exitCodeForPlan(conclusion);
      grouped.set(code, [...(grouped.get(code) ?? []), conclusion].sort());
    }

    expect(Object.fromEntries([...grouped.entries()].sort((a, b) => a[0] - b[0]))).toEqual({
      [EXIT_RUN_OK]: [
        'ALL_TASKS_COMPLETE',
        'RECONCILED_IN_FLIGHT',
        'TASK_COMPLETED',
        'TASK_NOT_STARTED',
      ].sort(),
      [EXIT_RUN_INPUT_UNUSABLE]: [
        'NO_ELIGIBLE_TASK',
        'PLANNING_FAILED',
        'TASK_ID_INVALID',
        'TASK_INELIGIBLE',
        'TASK_UNKNOWN',
      ].sort(),
      [EXIT_RUN_NEEDS_OPERATOR]: [
        'STATE_DIVERGED',
        'STATE_UNOBSERVABLE',
        'STATE_UNUSABLE',
        'TASK_ABORTED',
        'TASK_PARKED',
      ].sort(),
    });
  });
});

describe('every run outcome has an exit code', () => {
  it.each([...RUN_OUTCOMES])('%s maps to a documented code', (outcome) => {
    const code = exitCodeForRunOutcome(outcome);
    expect([0, 2, 3, 4, 5]).toContain(code);
  });

  /**
   * The mapping as a **partition**, not as four spot checks.
   *
   * Grouping by code and asserting the whole group makes every one of the 18
   * assignments load-bearing in both directions: moving an outcome between
   * groups fails here, and so does adding a nineteenth without placing it.
   * The earlier shape — a few `toBe` assertions plus a totality loop — left 11
   * assignments unpinned, so a mutation such as `TASK_NOT_STARTED -> 4` passed
   * the whole file (V2-01 review).
   */
  it('assigns every outcome to exactly the documented group', () => {
    const grouped = new Map<number, string[]>();
    for (const outcome of RUN_OUTCOMES) {
      const code = exitCodeForRunOutcome(outcome);
      grouped.set(code, [...(grouped.get(code) ?? []), outcome].sort());
    }

    expect(Object.fromEntries([...grouped.entries()].sort((a, b) => a[0] - b[0]))).toEqual({
      [EXIT_RUN_OK]: ['TASK_COMPLETED'],
      [EXIT_RUN_INPUT_UNUSABLE]: ['TASK_NOT_STARTED'],
      [EXIT_RUN_NEEDS_OPERATOR]: [
        'BLOCKED_AUTH',
        'BLOCKED_USAGE_LIMIT',
        'BLOCKED_VERIFY',
        'HUMAN_DECISION_REQUIRED',
        'RESUME_STATE_DIVERGED',
        'SCOPE_VIOLATION',
        'STATE_DIVERGED',
        'STATE_UNOBSERVABLE',
        'STATE_UNUSABLE',
        'TASK_ABORTED',
      ].sort(),
      [EXIT_RUN_REFUSED]: [
        'CONTINUATION_NOT_AUTHORISED',
        // Two lease outcomes, one exit code. They stay distinct outcomes
        // because "you never held it" and "you lost it" send an operator to
        // different places; they share code 4 because the shell-level answer to
        // both is the same — nothing durable is wrong, try again later.
        'EXECUTION_LEASE_LOST',
        'EXECUTION_LEASE_NOT_HELD',
        'EXECUTION_UNAUTHORISED',
        'NO_PROGRESS',
        'STATE_CONFLICT',
        'STATE_NOT_RECORDED',
      ].sort(),
      [EXIT_RUN_CALL_AGAIN]: ['STEP_BUDGET_EXHAUSTED'],
    });
  });

  it('reserves 0 for TASK_COMPLETED alone', () => {
    const ok = RUN_OUTCOMES.filter((o) => exitCodeForRunOutcome(o) === EXIT_RUN_OK);
    expect(ok).toEqual(['TASK_COMPLETED']);
  });

  it('reserves "call again" for the one outcome that means it', () => {
    const again = RUN_OUTCOMES.filter((o) => exitCodeForRunOutcome(o) === EXIT_RUN_CALL_AGAIN);
    expect(again).toEqual(['STEP_BUDGET_EXHAUSTED']);
  });
});

/* ═════════════════ V2-05: the start-outcome exit contract ══════════════════ */

/**
 * What each start outcome must exit with, written out here.
 *
 * Deliberately an independent literal rather than anything derived from
 * `START_TASK_OUTCOMES` or from `START_TASK_EXIT_CODES`. A table that generated
 * its own expectation — `for (const o of OUTCOMES) expect(code(o)).toBe(code(o))`
 * — would pass for every possible mapping, including an empty one, which is the
 * failure mode the V2-01 review found in the run-outcome section above.
 *
 * Because it is written out, this constant is also the place where the *count* is
 * asserted: fifteen. (V2-01 scoped the slice as "fourteen outcomes" and the
 * vocabulary actually had thirteen; the tests stated the real number rather than
 * the expected one. V2-06A added `ADOPTED`, which was the fourteenth, and V2-07L
 * added `EXECUTION_LEASE_NOT_HELD` — each arrived at by counting again, not by
 * an earlier estimate coming true.)
 */
const EXPECTED_START_EXIT_CODES: Readonly<Record<string, number>> = Object.freeze({
  // Nominal: something drivable exists. None of these ends the attended command.
  STARTED: 0,
  // Adoption is a nominal start: the task ends up with the state a fresh start
  // would have written, so the invocation continues exactly as it would have.
  ADOPTED: 0,
  ALREADY_STARTED: 0,
  // The input situation is unusable: the id, the plan, the task, or a repository
  // that cannot hold task state without dirtying itself.
  TASK_ID_INVALID: 2,
  PLANNING_FAILED: 2,
  TASK_UNKNOWN: 2,
  TASK_INELIGIBLE: 2,
  RUNTIME_NOT_IGNORED: 2,
  // Infrastructure could not answer; the next invocation may differ.
  RUNTIME_IGNORE_UNDETERMINED: 4,
  // Somebody else is this repository's writer, or this invocation never was.
  // Nothing was created, so it is a refusal rather than an operator condition.
  EXECUTION_LEASE_NOT_HELD: 4,
  // An operator must act before anything may run.
  AUTH_PREFLIGHT_FAILED: 3,
  WORKSPACE_COLLISION: 3,
  WORKSPACE_REFUSED: 3,
  STATE_UNUSABLE: 3,
  STATE_NOT_RECORDED: 3,
});

describe('every start outcome has an exit code', () => {
  it('classifies exactly the declared outcomes, once each', () => {
    // Both directions. Missing an outcome and inventing one are different
    // defects, and a set comparison alone would hide a duplicate key.
    const declared = [...START_TASK_OUTCOMES].sort();
    const expected = Object.keys(EXPECTED_START_EXIT_CODES).sort();

    expect(expected).toEqual(declared);
    expect(START_TASK_OUTCOMES).toHaveLength(15);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it.each([...START_TASK_OUTCOMES])('%s exits with its documented code', (outcome) => {
    expect(exitCodeForStartOutcome(outcome)).toBe(EXPECTED_START_EXIT_CODES[outcome]);
  });

  it('invents no code outside the closed set', () => {
    for (const outcome of START_TASK_OUTCOMES) {
      expect([0, 1, 2, 3, 4, 5]).toContain(exitCodeForStartOutcome(outcome));
    }
  });

  /** The same partition shape the other two mappings are pinned with. */
  it('assigns every start outcome to exactly the documented group', () => {
    const grouped = new Map<number, string[]>();
    for (const outcome of START_TASK_OUTCOMES) {
      const code = exitCodeForStartOutcome(outcome);
      grouped.set(code, [...(grouped.get(code) ?? []), outcome].sort());
    }

    expect(Object.fromEntries([...grouped.entries()].sort((a, b) => a[0] - b[0]))).toEqual({
      [EXIT_RUN_OK]: ['ADOPTED', 'ALREADY_STARTED', 'STARTED'],
      [EXIT_RUN_INPUT_UNUSABLE]: [
        'PLANNING_FAILED',
        'RUNTIME_NOT_IGNORED',
        'TASK_ID_INVALID',
        'TASK_INELIGIBLE',
        'TASK_UNKNOWN',
      ].sort(),
      [EXIT_RUN_NEEDS_OPERATOR]: [
        'AUTH_PREFLIGHT_FAILED',
        'STATE_NOT_RECORDED',
        'STATE_UNUSABLE',
        'WORKSPACE_COLLISION',
        'WORKSPACE_REFUSED',
      ].sort(),
      [EXIT_RUN_REFUSED]: ['EXECUTION_LEASE_NOT_HELD', 'RUNTIME_IGNORE_UNDETERMINED'].sort(),
    });
  });

  it('never exits 1 for an expected condition', () => {
    // Code 1 is "unexpected failure inside the tool". A start outcome is a
    // reported condition, so reaching 1 through this table would mean the
    // command called its own vocabulary a crash.
    for (const outcome of START_TASK_OUTCOMES) {
      expect(exitCodeForStartOutcome(outcome)).not.toBe(EXIT_RUN_UNEXPECTED);
    }
  });

  it('never exits "call again" — no start outcome means resume this call', () => {
    for (const outcome of START_TASK_OUTCOMES) {
      expect(exitCodeForStartOutcome(outcome)).not.toBe(EXIT_RUN_CALL_AGAIN);
    }
  });
});

/**
 * Mutation tests: proof that the expectation table above is actually checked.
 *
 * A total mapping and a per-outcome assertion still leave one hole: whether the
 * *expected* values are load-bearing, or whether the assertions would pass
 * against a different mapping. Here the table itself is mutated and the real
 * mapping is compared against the mutated copy — which must disagree. If any
 * entry were unchecked, or the comparison were vacuous, the mutated table would
 * still "match" and the case fails.
 *
 * One representative per class of outcome, as required by the V2-05 contract:
 * success, operator/policy, configuration, and infrastructure. Those four are
 * the classes an operator's automation branches on, so a silent remapping in any
 * of them is the expensive kind.
 */
describe('the start exit-code expectations are load-bearing', () => {
  /** The real mapping, as data. */
  function actual(): Record<string, number> {
    return Object.fromEntries(
      START_TASK_OUTCOMES.map((outcome) => [outcome, exitCodeForStartOutcome(outcome)]),
    );
  }

  it.each([
    ['a success outcome', 'STARTED', EXIT_RUN_NEEDS_OPERATOR],
    ['an operator/policy outcome', 'AUTH_PREFLIGHT_FAILED', EXIT_RUN_REFUSED],
    ['a configuration outcome', 'RUNTIME_NOT_IGNORED', EXIT_RUN_OK],
    ['an infrastructure outcome', 'RUNTIME_IGNORE_UNDETERMINED', EXIT_RUN_NEEDS_OPERATOR],
  ])('detects a remapping of %s', (_label, outcome, mutatedCode) => {
    const mutated = { ...EXPECTED_START_EXIT_CODES, [outcome]: mutatedCode };

    // The mutation must be a real change, or the case proves nothing.
    expect(mutated[outcome]).not.toBe(EXPECTED_START_EXIT_CODES[outcome]);
    // The real mapping matches the true table …
    expect(actual()).toEqual({ ...EXPECTED_START_EXIT_CODES });
    // … and disagrees with the mutated one. So this entry is checked.
    expect(actual()).not.toEqual(mutated);
  });
});
