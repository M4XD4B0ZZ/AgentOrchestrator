/**
 * The exit-code contract of `agent-loop run` (V2-01).
 *
 * Both mappings are pinned as *total*: every plan conclusion and every run
 * outcome must have a documented exit code, so widening either vocabulary
 * forces a deliberate decision here rather than an accidental `undefined`
 * exit. The individual assignments are pinned too — an exit code is an
 * operator-facing contract, and changing one is a visible act.
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
} from '../src/cli/run-exit-codes.js';
import { RUN_OUTCOMES } from '../src/run/run-driver.js';
import { RUN_PLAN_CONCLUSIONS } from '../src/run/run-plan.js';

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
