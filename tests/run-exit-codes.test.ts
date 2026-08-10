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

  it('exits 0 exactly for the nominal answers', () => {
    const nominal = RUN_PLAN_CONCLUSIONS.filter((c) => exitCodeForPlan(c) === EXIT_RUN_OK);
    expect([...nominal].sort()).toEqual(
      ['ALL_TASKS_COMPLETE', 'RECONCILED_IN_FLIGHT', 'TASK_COMPLETED', 'TASK_NOT_STARTED'].sort(),
    );
  });

  it('sends the operator to the durable state for parked and broken records', () => {
    for (const conclusion of [
      'TASK_ABORTED',
      'TASK_PARKED',
      'STATE_UNUSABLE',
      'STATE_DIVERGED',
      'STATE_UNOBSERVABLE',
    ] as const) {
      expect(exitCodeForPlan(conclusion)).toBe(EXIT_RUN_NEEDS_OPERATOR);
    }
  });

  it('reports an unusable input situation as such', () => {
    for (const conclusion of [
      'PLANNING_FAILED',
      'NO_ELIGIBLE_TASK',
      'TASK_ID_INVALID',
      'TASK_UNKNOWN',
      'TASK_INELIGIBLE',
    ] as const) {
      expect(exitCodeForPlan(conclusion)).toBe(EXIT_RUN_INPUT_UNUSABLE);
    }
  });
});

describe('every run outcome has an exit code', () => {
  it.each([...RUN_OUTCOMES])('%s maps to a documented code', (outcome) => {
    const code = exitCodeForRunOutcome(outcome);
    expect([0, 2, 3, 4, 5]).toContain(code);
  });

  it('reserves 0 for TASK_COMPLETED alone', () => {
    const ok = RUN_OUTCOMES.filter((o) => exitCodeForRunOutcome(o) === EXIT_RUN_OK);
    expect(ok).toEqual(['TASK_COMPLETED']);
  });

  it('reserves "call again" for the one outcome that means it', () => {
    const again = RUN_OUTCOMES.filter((o) => exitCodeForRunOutcome(o) === EXIT_RUN_CALL_AGAIN);
    expect(again).toEqual(['STEP_BUDGET_EXHAUSTED']);
  });

  it('keeps invocation-level refusals apart from durable-state problems', () => {
    for (const outcome of [
      'STATE_CONFLICT',
      'STATE_NOT_RECORDED',
      'CONTINUATION_NOT_AUTHORISED',
      'EXECUTION_UNAUTHORISED',
      'NO_PROGRESS',
    ] as const) {
      expect(exitCodeForRunOutcome(outcome)).toBe(EXIT_RUN_REFUSED);
    }
  });
});
