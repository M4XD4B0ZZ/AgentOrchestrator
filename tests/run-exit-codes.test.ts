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
  exitCodeForLifecycle,
  exitCodeForLifecycleRun,
  exitCodeForPlan,
  exitCodeForRunOutcome,
  exitCodeForStartOutcome,
} from '../src/cli/run-exit-codes.js';
import { LIFECYCLE_OUTCOMES } from '../src/run/lifecycle-driver.js';
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
        // M8. A task an operator ended is a nominal answer like the four above:
        // the plan is complete, and there is nobody to summon.
        'TASK_OPERATOR_RESOLVED',
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
      [EXIT_RUN_OK]: ['TASK_COMPLETED', 'TASK_OPERATOR_RESOLVED'].sort(),
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

  it('reserves 0 for the two endings that leave nobody waiting', () => {
    // The claim was 'TASK_COMPLETED alone' until M8, and the narrowing is
    // deliberate rather than an accommodation. 0 says this invocation has
    // nothing left to hand anyone: either the loop drove the task to
    // READY_FOR_PR, or an operator had already ended it themselves. The second
    // is emphatically not the first — it claims nothing about the work, opens
    // no pull request, and carries its own outcome and its own state — but
    // exiting 3 would summon the very person who made the decision.
    const ok = RUN_OUTCOMES.filter((o) => exitCodeForRunOutcome(o) === EXIT_RUN_OK);
    expect([...ok].sort()).toEqual(['TASK_COMPLETED', 'TASK_OPERATOR_RESOLVED']);
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
 * asserted: sixteen. (V2-01 scoped the slice as "fourteen outcomes" and the
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
  // Lost after the workspace existed: a worktree and a branch are on disk that
  // no state accounts for. Residue is an operator's to clear, so 3 — the same
  // reasoning `STATE_NOT_RECORDED` carries, and the distinction a review found
  // collapsed when both lease cases shared one outcome.
  EXECUTION_LEASE_LOST: 3,
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
    expect(START_TASK_OUTCOMES).toHaveLength(16);
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
        'EXECUTION_LEASE_LOST',
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

/* ═════════════ V3-06: the lifecycle table, written out, not derived ════════ */

/**
 * The fourth exit-code table, pinned the same way as the other three.
 *
 * It was added beside them and left unpinned — no test referenced
 * `exitCodeForLifecycle`, `exitCodeForLifecycleRun` or `LIFECYCLE_EXIT_CODES` at
 * all, so thirty operator-facing assignments and the start-outcome delegation
 * were covered by nothing. Written out by hand rather than generated from the
 * vocabulary, for the reason the start-table comment above gives: a table that
 * generates its own expectation passes for every possible mapping.
 *
 * Thirty-one entries, counted rather than estimated — and the count is asserted
 * below against `LIFECYCLE_OUTCOMES` rather than written into a sentence that
 * can drift. An earlier version of this paragraph said thirty.
 */
const EXPECTED_LIFECYCLE_EXIT_CODES: Readonly<Record<string, number>> = Object.freeze({
  // The task finished.
  COMPLETED: 0,
  // M8: the task was already over because an operator ended it. Nothing to
  // drive and nobody to summon — see the run table for why 3 would be wrong.
  TASK_OPERATOR_RESOLVED: 0,

  // Durably parked, or a record an operator has to look at. Identical to the run
  // table: a task did not end differently because an outer loop was watching.
  TASK_ABORTED: 3,
  BLOCKED_USAGE_LIMIT: 3,
  BLOCKED_VERIFY: 3,
  BLOCKED_AUTH: 3,
  SCOPE_VIOLATION: 3,
  RESUME_STATE_DIVERGED: 3,
  HUMAN_DECISION_REQUIRED: 3,
  RECONCILIATION_DIVERGED: 3,
  RECONCILIATION_UNOBSERVABLE: 3,
  STATE_UNUSABLE: 3,

  // Another run is working here, and it clears itself: a refusal, not an
  // operator condition. The only lease state that keeps code 4.
  LIVE_OWNER_PRESENT: 4,

  // Every other lease condition leaves something a human has to look at: a lease
  // nothing here may remove, a refused or failed removal, a displaced record, or
  // a release that could not be proven.
  STALE_LEASE_PRESENT: 3,
  RECOVERY_UNSAFE: 3,
  LEASE_CHANGED: 3,
  LEASE_DISPLACED: 3,
  RECOVERY_FAILED: 3,
  LEASE_ACQUISITION_REFUSED: 3,
  LEASE_RELEASE_FAILED: 3,

  // Nothing to continue, or an argument that cannot be used.
  TASK_NOT_STARTED: 2,
  TASK_START_REFUSED: 2,
  INVOCATION_BUDGET_INVALID: 2,

  // This run was refused or achieved nothing; nothing durable is wrong.
  AUTH_PREFLIGHT_FAILED: 3,
  // A person has to grant or repair the capability; retrying cannot.
  REQUIRED_CAPABILITY_UNPROVEN: 3,
  STATE_CONFLICT: 4,
  STATE_NOT_RECORDED: 4,
  CONTINUATION_NOT_AUTHORISED: 4,
  EXECUTION_UNAUTHORISED: 4,
  EXECUTION_LEASE_NOT_HELD: 4,
  EXECUTION_LEASE_LOST: 4,
  NO_PROGRESS: 4,

  // The only lifecycle outcome that means "call again".
  INVOCATION_BUDGET_EXHAUSTED: 5,
});

describe('the lifecycle exit-code table', () => {
  it('maps every outcome to the code written out above, and no other', () => {
    expect(Object.keys(EXPECTED_LIFECYCLE_EXIT_CODES).sort()).toEqual(
      [...LIFECYCLE_OUTCOMES].sort(),
    );
    for (const outcome of LIFECYCLE_OUTCOMES) {
      expect(exitCodeForLifecycle(outcome)).toBe(EXPECTED_LIFECYCLE_EXIT_CODES[outcome]);
    }
  });

  it('gives exactly one outcome the "call again" code', () => {
    const callAgain = LIFECYCLE_OUTCOMES.filter(
      (outcome) => exitCodeForLifecycle(outcome) === EXIT_RUN_CALL_AGAIN,
    );
    expect(callAgain).toEqual(['INVOCATION_BUDGET_EXHAUSTED']);
  });

  it('never reports a lifecycle outcome as an internal error', () => {
    // Code 1 is for an exception nobody classified. Every member of a closed
    // vocabulary has been classified by definition, so none may carry it.
    for (const outcome of LIFECYCLE_OUTCOMES) {
      expect(exitCodeForLifecycle(outcome)).not.toBe(EXIT_RUN_UNEXPECTED);
    }
  });

  it('hands a refused start back to the start table rather than flattening it', () => {
    // The delegation, and the reason it exists: `TASK_ID_INVALID` is a typo,
    // `AUTH_PREFLIGHT_FAILED` is a login and `STATE_NOT_RECORDED` is a worktree
    // nothing accounts for. Answering all three with "your input was unusable"
    // is the collapse the vocabulary exists to prevent.
    expect(
      exitCodeForLifecycleRun({
        outcome: 'TASK_START_REFUSED',
        start: { outcome: 'AUTH_PREFLIGHT_FAILED' },
      }),
    ).toBe(EXIT_RUN_NEEDS_OPERATOR);
    expect(
      exitCodeForLifecycleRun({
        outcome: 'TASK_START_REFUSED',
        start: { outcome: 'TASK_ID_INVALID' },
      }),
    ).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(
      exitCodeForLifecycleRun({
        outcome: 'TASK_START_REFUSED',
        start: { outcome: 'STATE_NOT_RECORDED' },
      }),
    ).toBe(EXIT_RUN_NEEDS_OPERATOR);
    // Without a start result there is nothing to delegate to, and the floor in
    // the lifecycle table answers instead.
    expect(exitCodeForLifecycleRun({ outcome: 'TASK_START_REFUSED', start: null })).toBe(
      EXIT_RUN_INPUT_UNUSABLE,
    );
  });

  it('leaves every other outcome to the lifecycle table', () => {
    for (const outcome of LIFECYCLE_OUTCOMES) {
      if (outcome === 'TASK_START_REFUSED') continue;
      expect(
        exitCodeForLifecycleRun({ outcome, start: { outcome: 'AUTH_PREFLIGHT_FAILED' } }),
      ).toBe(exitCodeForLifecycle(outcome));
    }
  });
});
