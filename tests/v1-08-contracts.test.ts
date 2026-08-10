/**
 * V1-08 — the small contracts the integrated slice rests on.
 *
 * Three properties that are cheap to state and expensive to lose, each of which
 * an end-to-end test would only catch indirectly (or not at all):
 *
 *  1. the set of states the loop drives is the set it *advertises*, because the
 *     run driver now refuses a resume into a phase outside it;
 *  2. a remediation brief has exactly one line per durable finding, which is
 *     what makes the persisted fingerprint grammar load-bearing rather than
 *     decorative;
 *  3. the fingerprint the review parser produces really is the grammar the state
 *     contract now demands — the producer and the schema must not drift.
 */

import { describe, expect, it } from 'vitest';

import { fingerprintFinding } from '../src/agent/internal/codex-review-transcript.js';
import { ALL_STATES, type TaskStateName } from '../src/core/states.js';
import { FINDING_FINGERPRINT_PATTERN } from '../src/core/internal/task-state-object-schema.js';
import { parseTaskState } from '../src/core/task-state.js';
import {
  isLoopDrivenState,
  LOOP_DRIVEN_STATES,
  runLoopStep,
  type LoopDependencies,
} from '../src/loop/loop-step.js';
import { buildResumedRemediationBrief } from '../src/loop/findings.js';
import { fingerprint, validCreatedState } from './fixtures.js';

/* ═════════ 1. The advertised set is the dispatched set ═════════════════════ */

/**
 * `isLoopDrivenState` is now load-bearing: `run-driver.ts` consults it *before*
 * making a durable write, and refuses a resume whose target falls outside it —
 * because such a resume spends the block's evidence and lands the task in a
 * phase nothing can advance.
 *
 * If the advertised set and the dispatch drifted apart, that gate would either
 * refuse a phase the loop can drive (a task that can never continue) or permit
 * one it cannot (the one-way loss the gate exists to prevent). So the two are
 * pinned against each other over every declared state, rather than the set being
 * asserted against a hand-written copy of itself.
 */
describe('the states the loop advertises are the states it dispatches', () => {
  /** Dependencies that make any *executed* step fail loudly rather than run. */
  const unusableDeps = (): LoopDependencies => ({
    repositoryRoot: '/srv/projects/alpha',
    now: '2026-08-10T10:00:00.000Z',
    authorisedWorktreePath: '/srv/projects/alpha.worktrees/task-0001',
    verification: { phases: [] },
    taskBrief: 'brief',
    verify: () => {
      throw new Error('a non-driven state must not reach the verification seam');
    },
    agent: () => {
      throw new Error('a non-driven state must not reach an agent seam');
    },
  });

  it.each(ALL_STATES.map((state) => [state] as const))(
    'agrees about %s',
    async (state: TaskStateName) => {
      // A load result carrying this state. `runLoopStep` dispatches on the
      // durable state alone, so nothing else about it matters.
      const current = {
        ok: true as const,
        code: 'LOADED' as const,
        classification: 'STATE_VALID' as const,
        state: parseTaskState(
          validCreatedState({
            state,
            ...(state === 'READY_FOR_PR'
              ? {
                  reviewRound: 1,
                  basePinnedCommit: '0'.repeat(40),
                  currentCommit: '1'.repeat(40),
                  worktreeCleanAtCheckpoint: true,
                }
              : {}),
            ...(state === 'BLOCKED_USAGE_LIMIT'
              ? { blockedAgent: 'claude' as const, resumeFrom: { phase: 'REMEDIATE' as const, round: 1 } }
              : {}),
            ...(state === 'BLOCKED_AUTH'
              ? { blockedAgent: 'claude' as const, resumeFrom: { phase: 'REMEDIATE' as const, round: 1 } }
              : {}),
            ...(state === 'BLOCKED_VERIFY'
              ? { resumeFrom: { phase: 'REMEDIATE' as const, round: 1 } }
              : {}),
            ...(state === 'HUMAN_DECISION_REQUIRED'
              ? { resumeFrom: { phase: 'REMEDIATE' as const, round: 1 } }
              : {}),
          }),
        ),
        path: '/srv/projects/alpha/.agent-orchestrator/runtime/task-0001.json',
        revision: 'revision-0',
      };

      const driven = isLoopDrivenState(state);

      if (!driven) {
        // The observable meaning of "not driven": nothing is run and nothing is
        // written, and the outcome says so in its own vocabulary.
        const result = await runLoopStep(current, unusableDeps());
        expect(result.outcome).toBe('NOT_APPLICABLE');
        expect(result.state).toBeNull();
        expect(result.save).toBeNull();
        return;
      }

      // A driven state gets past the dispatch. It stops at the authority check
      // rather than reaching a seam, because the authorised path here does not
      // denote this state's worktree — which is enough to prove dispatch
      // happened without starting anything.
      const result = await runLoopStep(current, {
        ...unusableDeps(),
        authorisedWorktreePath: '/somewhere/else',
      });
      expect(result.outcome).toBe('EXECUTION_UNAUTHORISED');
    },
  );

  it('advertises exactly the three work-loop phases that execute something', () => {
    expect([...LOOP_DRIVEN_STATES].sort()).toEqual(['REMEDIATING', 'REVIEWING', 'VERIFYING']);
    // `BLOCKED_VERIFY` is deliberately outside it: leaving that state means
    // handing a failure to the writing agent, which is a decision.
    expect(isLoopDrivenState('BLOCKED_VERIFY')).toBe(false);
    expect(isLoopDrivenState('IMPLEMENTING')).toBe(false);
  });
});

/* ═════════ 2. One line per finding, and the grammar that keeps it so ══════ */

describe('a resumed remediation brief has one line per durable finding', () => {
  const brief = (count: number) =>
    buildResumedRemediationBrief(
      Array.from({ length: count }, (_unused, index) => ({
        round: 1,
        severity: 'high' as const,
        fingerprint: fingerprint(index),
      })),
      1,
    );

  it.each([1, 2, 8])('renders %i findings as exactly that many lines', (count) => {
    const built = brief(count);
    expect(built.kind).toBe('DURABLE_RECORD');
    if (built.kind !== 'DURABLE_RECORD') return;

    const findingLines = built.payload.split('\n').filter((line) => line.startsWith('- ['));
    expect(findingLines).toHaveLength(count);
    // The header the writer reads must agree with the list beneath it.
    expect(built.payload).toContain(`FINDINGS (${count}; high=${count})`);
  });

  /**
   * The structural property the persisted grammar protects.
   *
   * Each record contributes exactly one line, so the number of lines in the
   * brief is a function of the number of findings and nothing else. That holds
   * only because a fingerprint cannot contain a line break — which is a fact
   * about `FindingRecordSchema`, enforced at the boundary where the value is
   * admitted rather than at this sink. `tests/task-state.test.ts` pins the
   * refusal; this pins what the refusal buys.
   */
  it('grows by exactly one line per finding', () => {
    const one = brief(1);
    const two = brief(2);
    if (one.kind !== 'DURABLE_RECORD' || two.kind !== 'DURABLE_RECORD') {
      expect.unreachable();
      return;
    }
    expect(two.payload.split('\n').length).toBe(one.payload.split('\n').length + 1);
  });

  it('refuses to speak for a round the durable record says nothing about', () => {
    expect(brief(0).kind).toBe('NO_DURABLE_FINDINGS');
  });
});

/* ═════════ 3. The producer and the persisted grammar are one grammar ══════ */

describe('the fingerprint the review parser computes is the one the contract accepts', () => {
  it.each([
    ['critical', 'src/index.ts', 'rule.one'],
    ['info', 'a', 'r'],
    ['high', `${'d/'.repeat(100)}file.ts`, `${'a'.repeat(128)}`],
    ['medium', 'src/with-dash_and.dot:colon@at=eq+plus', 'a.b_c:d-e'],
  ])('accepts what the producer emits for (%s, %s, %s)', (severity, path, rule) => {
    const produced = fingerprintFinding(severity, path, rule);

    expect(produced).toMatch(FINDING_FINGERPRINT_PATTERN);
    // And the contract really admits it — the two grammars are not merely
    // similar, they accept the same strings.
    const parsed = parseTaskState(
      validCreatedState({
        findingHistory: [{ round: 1, severity: 'high', fingerprint: produced }],
      }),
    );
    expect(parsed.findingHistory[0]?.fingerprint).toBe(produced);
  });

  it('is deterministic, and separates triples that would otherwise concatenate', () => {
    expect(fingerprintFinding('high', 'a/b', 'c')).toBe(fingerprintFinding('high', 'a/b', 'c'));
    // The NUL separator is what stops ("high","a","bc") and ("high","ab","c")
    // from hashing to the same value.
    expect(fingerprintFinding('high', 'a', 'bc')).not.toBe(fingerprintFinding('high', 'ab', 'c'));
  });
});
