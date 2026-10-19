/**
 * RM1-03A — a writer failure keeps its original failure code, on disk, beside
 * the task record, as evidence only.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `recordInterruption` received a `ClaudeWriterFailed` carrying `code`, and
 * handed `recordAgentInterruption` only its disposition and block. Eight codes
 * map to `AGENT_NEEDS_ATTENTION`, so `AGENT_ARGUMENT_REFUSED` (deterministic)
 * and `AGENT_PROCESS_UNAVAILABLE` (transient) left byte-identical task records.
 *
 * ── How this suite is arranged ─────────────────────────────────────────────
 *
 * The step runs for real: the real implement and remediate steps, the real
 * writer boundary, the real store on a real temporary directory. Two things are
 * injected. Git, because these roots are not repositories and the ignore
 * question is one the refusal cases must be able to withhold; and the writer's
 * guard, so the three guard failures can be produced on demand.
 *
 * `runClaudeWriter` is partially mocked for exactly one case. This build's
 * Claude boundary has no recogniser that produces `AGENT_SESSION_REJECTED`, yet
 * the code is in the writer's closed set and reaches `recordInterruption`
 * through the same `!writer.ok` branch as every other — so that case alone hands
 * the step a hand-built failed result. Every other case leaves the real writer
 * in place.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentCommandResult, AgentRunner } from '../src/agent/agent-command.js';
import {
  AGENT_FAILURE_DISPOSITION,
  AGENT_FAILURE_TEXT,
  type AgentDisposition,
  type AgentFailureCode,
} from '../src/agent/agent-outcome.js';
import type {
  ClaudeWriterFailed,
  ClaudeWriterOptions,
  ClaudeWriterRequest,
  ClaudeWriterResult,
} from '../src/agent/claude-writer.js';
import type { WriterViolation, WriterWriteGuard } from '../src/agent/writer-write-guard.js';
import {
  MAX_WRITER_OUTCOME_RECORD_BYTES,
  MAX_WRITER_OUTCOMES_KEPT,
  readWriterOutcomes,
  writerOutcomeFrom,
  type WriterOutcomeEntry,
  type WriterOutcomePhase,
} from '../src/agent/writer-outcome.js';
import {
  deriveWriterOutcomeLocation,
  latestWriterOutcome,
  loadWriterOutcomes,
  recordWriterOutcome,
  WRITER_OUTCOME_RECORD_CODES,
  type WriterOutcomeLoad,
  type WriterOutcomeWriteRequest,
} from '../src/agent/writer-outcome-store.js';
import type { TaskStateName } from '../src/core/states.js';
import type { TaskStateInput } from '../src/core/task-state.js';
import { readDashboardSnapshot } from '../src/dashboard/read-model.js';
import { releaseRepositoryExecutionLease } from '../src/lease/execution-lease.js';
import {
  runImplementStep,
  runRemediateStep,
  type LoopDependencies,
  type LoopStepResult,
} from '../src/loop/loop-step.js';
import { scanAttention } from '../src/notify/attention-outbox.js';
import type { RepositoryRegistryOutcome } from '../src/registry/repository-registry.js';
import type { ResolvedVerificationPolicy } from '../src/repo/resolve-repository.js';
import { renderRunPlan } from '../src/run/render-run-plan.js';
import { planRun, type RunPlan } from '../src/run/run-plan.js';
import { scanDurableWakes } from '../src/schedule/durable-wake.js';
import { loadTaskState, saveTaskState, type StateLoadSuccess } from '../src/state/state-store.js';
import { runGitCommand, type GitCommandResult, type GitRunner } from '../src/worktree/git-command.js';
import { agentCommandResult, FIXTURE_TASK_ID, SHA_A, validCreatedState } from './fixtures.js';
import { briefCapabilityFields } from './helpers/briefing.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { seedState, startTask, usageLimitResult, writerSuccess } from './helpers/e2e-fixtures.js';
import { leaseAuthorityAt, releaseTestLeases } from './helpers/lease.js';
import { FIXTURE_A_PROFILE, createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { writingPassAnswer } from './helpers/scope-git.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';

/* ═════════════════════ the one partial mock, and why ════════════════════ */

type WriterFn = (request: ClaudeWriterRequest, options: ClaudeWriterOptions) => Promise<ClaudeWriterResult>;

const writerOverride = vi.hoisted(() => ({ current: null as WriterFn | null }));

vi.mock('../src/agent/claude-writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/claude-writer.js')>();
  return {
    ...actual,
    runClaudeWriter: async (request: ClaudeWriterRequest, options: ClaudeWriterOptions) =>
      writerOverride.current === null
        ? actual.runClaudeWriter(request, options)
        : writerOverride.current(request, options),
  };
});

/* ═══════════════════════════════ fixtures ═══════════════════════════════ */

const NOW = '2026-10-19T09:00:00.000Z';
const TASK_ID = FIXTURE_TASK_ID;
const HEAD_COMMIT = `${'a'.repeat(39)}1`;
/** Token-shaped, and a marker for an operator's home. Neither may reach the record. */
const TOKEN = `sk-ant-api03-${'Q'.repeat(48)}`;
const HOME_MARKER = 'zzOperatorHomezz';

const tempDirs: string[] = [];

function scratch(): string {
  const dir = makeCanonicalTempDir('ao-rm1-03a-');
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  writerOverride.current = null;
  releaseTestLeases();
  removeRepoFixtures();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const VERIFICATION: ResolvedVerificationPolicy = Object.freeze({
  phases: Object.freeze([
    Object.freeze({ phase: 'VERIFY' as const, command: Object.freeze(['npm', 'run', 'verify']) }),
  ]),
});

const GIT_OK: GitCommandResult = Object.freeze({ outcome: 'OK' as const, stdout: '', exitCode: 0 });
const GIT_NOT_IGNORED: GitCommandResult = Object.freeze({
  outcome: 'NONZERO_EXIT' as const,
  stdout: '',
  exitCode: 1,
});
const GIT_UNAVAILABLE: GitCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
  exitCode: null,
});

interface GitOptions {
  /** How `check-ignore` answers. Default: ignored. */
  readonly ignore?: 'IGNORED' | 'NOT_IGNORED' | 'THROW';
  /** When true, the task's delta names a path outside the allowed scope. */
  readonly outside?: () => boolean;
}

/** A writing pass's world: in-scope delta, readable HEAD, the runtime directory ignored. */
function healthyGit(options: GitOptions = {}): GitRunner {
  return async (_cwd, args) => {
    if (args.includes('check-ignore')) {
      if (options.ignore === 'THROW') throw new Error('the ignore question broke');
      return options.ignore === 'NOT_IGNORED' ? GIT_NOT_IGNORED : GIT_OK;
    }
    const path = options.outside?.() === true ? 'README.md' : 'src/work.ts';
    return writingPassAnswer(args, { head: HEAD_COMMIT, path }) ?? GIT_UNAVAILABLE;
  };
}

/** A writer guard bound to nothing real, answering as told and counting its launches. */
function fakeGuard(
  root: string,
  behaviour: 'OK' | 'QUARANTINED' | 'UNAVAILABLE' | 'VIOLATION' = 'OK',
): WriterWriteGuard & { readonly starts: () => number } {
  let starts = 0;
  const violation: WriterViolation = { outsideWrites: [], memoryChanges: [] };
  return {
    starts: () => starts,
    start: () => {
      starts += 1;
      if (behaviour === 'QUARANTINED') {
        return { ok: false, code: 'AGENT_WRITE_QUARANTINED', evidence: join(root, HOME_MARKER, 'open.json') } as const;
      }
      if (behaviour === 'UNAVAILABLE') {
        return { ok: false, code: 'AGENT_WRITE_GUARD_UNAVAILABLE', evidence: null } as const;
      }
      return {
        ok: true,
        session: {
          settingsPath: join(root, 'guard-settings.json'),
          inspect: () => (behaviour === 'VIOLATION' ? violation : null),
        },
      } as const;
    },
    record: () => join(root, HOME_MARKER, 'violation.json'),
  };
}

function loopState(root: string, phase: WriterOutcomePhase): TaskStateInput {
  return validCreatedState({
    repositoryRoot: root,
    worktreePath: join(root, 'worktree'),
    state: phase === 'IMPLEMENT' ? 'IMPLEMENTING' : 'REMEDIATING',
    basePinnedCommit: SHA_A,
    currentCommit: null,
    reviewRound: phase === 'IMPLEMENT' ? 0 : 1,
    maxReviewRounds: 3,
    worktreeCleanAtCheckpoint: false,
  });
}

function persist(root: string, phase: WriterOutcomePhase): StateLoadSuccess {
  const saved = saveTaskState(loopState(root, phase), { repositoryRoot: root });
  expect(saved.ok).toBe(true);
  return reload(root);
}

function reload(root: string): StateLoadSuccess {
  const load = loadTaskState(root, TASK_ID);
  if (!load.ok) throw new Error(`state did not load: ${load.code}`);
  return load;
}

function deps(root: string, overrides: Partial<LoopDependencies> = {}): LoopDependencies {
  return {
    now: NOW,
    authorisedWorktreePath: join(root, 'worktree'),
    verification: VERIFICATION,
    lease: leaseAuthorityAt(root),
    writerMcp: null,
    git: healthyGit(),
    remediationPayload: 'Fix the finding.',
    brief: {
      ok: true as const,
      code: 'BRIEF' as const,
      brief: {
        taskId: TASK_ID,
        body: 'Add a widget. ACCEPTANCE: src/widget.ts exports createWidget.',
        bodyTruncated: false,
        contextSources: [],
        contextComplete: true,
        ...briefCapabilityFields(),
      },
    },
    ...overrides,
  };
}

function step(phase: WriterOutcomePhase, current: StateLoadSuccess, d: LoopDependencies): Promise<LoopStepResult> {
  return phase === 'IMPLEMENT' ? runImplementStep(current, d) : runRemediateStep(current, d);
}

const answers = (result: AgentCommandResult): AgentRunner => async () => result;

/** A failed writer result built by hand, for the store-level cases and the one mocked one. */
function failedWriter(code: AgentFailureCode, over: Partial<ClaudeWriterFailed> = {}): ClaudeWriterFailed {
  return Object.freeze({
    agent: 'claude' as const,
    phase: 'IMPLEMENT' as const,
    round: 1,
    process: Object.freeze({
      outcome: 'RAN' as const,
      exitCode: 1,
      signal: null,
      outputTruncated: false,
      failureCode: null,
      errnoCode: null,
      durationMs: 1_200,
    }),
    diagnostics: Object.freeze({ stdoutExcerpt: '', stderrExcerpt: '', trusted: false as const }),
    ok: false as const,
    code,
    disposition: AGENT_FAILURE_DISPOSITION[code] as Exclude<AgentDisposition, 'AGENT_COMPLETED'>,
    detail: AGENT_FAILURE_TEXT[code],
    block: null,
    ...over,
  });
}

function entryOf(
  code: AgentFailureCode = 'AGENT_NONZERO_EXIT',
  round = 1,
  phase: WriterOutcomePhase = 'IMPLEMENT',
  recordedAt = NOW,
): WriterOutcomeEntry {
  return writerOutcomeFrom(failedWriter(code), { recordedAt, phase, round });
}

function record(
  root: string,
  entry: WriterOutcomeEntry,
  over: Partial<WriterOutcomeWriteRequest> = {},
): ReturnType<typeof recordWriterOutcome> {
  return recordWriterOutcome({
    repositoryRoot: root,
    taskId: TASK_ID,
    entry,
    leaseHolds: () => true,
    checkIgnored: async () => 'IGNORED',
    ...over,
  });
}

function recordPath(root: string): string {
  const location = deriveWriterOutcomeLocation(root, TASK_ID);
  if (!location.ok) throw new Error('location not derivable');
  return location.path;
}

/* ═════════════ 1. every failure class keeps its exact code ══════════════ */

interface Scenario {
  readonly code: AgentFailureCode;
  readonly state: TaskStateName;
  readonly forbiddenWriteRecorded: boolean;
  /** Whether the real writer runs, and therefore whether the guard is asked. */
  readonly realWriter: boolean;
  readonly arrange: (root: string, phase: WriterOutcomePhase) => {
    readonly guard: ReturnType<typeof fakeGuard>;
    readonly agent: AgentRunner;
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    code: 'AGENT_PROCESS_UNAVAILABLE',
    state: 'HUMAN_DECISION_REQUIRED',
    forbiddenWriteRecorded: false,
    realWriter: true,
    arrange: (root) => ({
      guard: fakeGuard(root),
      agent: answers(
        agentCommandResult({ outcome: 'UNAVAILABLE', exitCode: null, failureCode: 'TIMEOUT', durationMs: 20_004 }),
      ),
    }),
  },
  {
    code: 'AGENT_NONZERO_EXIT',
    state: 'HUMAN_DECISION_REQUIRED',
    forbiddenWriteRecorded: false,
    realWriter: true,
    arrange: (root) => ({ guard: fakeGuard(root), agent: answers(agentCommandResult({ exitCode: 2 })) }),
  },
  {
    code: 'AGENT_ARGUMENT_REFUSED',
    state: 'HUMAN_DECISION_REQUIRED',
    forbiddenWriteRecorded: false,
    realWriter: true,
    arrange: (root) => ({
      guard: fakeGuard(root),
      agent: answers(agentCommandResult({ outcome: 'REFUSED_UNSAFE_ARGUMENT', exitCode: null, durationMs: 0 })),
    }),
  },
  {
    code: 'AGENT_RESULT_MALFORMED',
    state: 'HUMAN_DECISION_REQUIRED',
    forbiddenWriteRecorded: false,
    realWriter: true,
    arrange: (root) => ({
      guard: fakeGuard(root),
      agent: answers(agentCommandResult({ stdout: 'not a result stream\n' })),
    }),
  },
  {
    code: 'AGENT_FORBIDDEN_WRITE',
    state: 'HUMAN_DECISION_REQUIRED',
    forbiddenWriteRecorded: true,
    realWriter: true,
    arrange: (root) => ({ guard: fakeGuard(root, 'VIOLATION'), agent: answers(writerSuccess()) }),
  },
  {
    code: 'AGENT_WRITE_QUARANTINED',
    state: 'HUMAN_DECISION_REQUIRED',
    forbiddenWriteRecorded: true,
    realWriter: true,
    arrange: (root) => ({ guard: fakeGuard(root, 'QUARANTINED'), agent: answers(writerSuccess()) }),
  },
  {
    code: 'AGENT_WRITE_GUARD_UNAVAILABLE',
    state: 'HUMAN_DECISION_REQUIRED',
    forbiddenWriteRecorded: false,
    realWriter: true,
    arrange: (root) => ({ guard: fakeGuard(root, 'UNAVAILABLE'), agent: answers(writerSuccess()) }),
  },
  {
    code: 'AGENT_USAGE_LIMIT',
    state: 'BLOCKED_USAGE_LIMIT',
    forbiddenWriteRecorded: false,
    realWriter: true,
    arrange: (root) => ({ guard: fakeGuard(root), agent: answers(usageLimitResult()) }),
  },
  {
    code: 'AGENT_SESSION_REJECTED',
    state: 'BLOCKED_AUTH',
    forbiddenWriteRecorded: false,
    realWriter: false,
    arrange: (root) => {
      writerOverride.current = async (request) =>
        failedWriter('AGENT_SESSION_REJECTED', { phase: request.phase, round: request.round });
      return { guard: fakeGuard(root), agent: answers(writerSuccess()) };
    },
  },
];

const PHASES: readonly WriterOutcomePhase[] = ['IMPLEMENT', 'REMEDIATE'];

describe('a writer failure keeps its original code beside the task record', () => {
  for (const scenario of SCENARIOS) {
    for (const phase of PHASES) {
      it(`${scenario.code} in ${phase}: exact code, disposition and static detail`, async () => {
        const root = scratch();
        const current = persist(root, phase);
        const { guard, agent } = scenario.arrange(root, phase);

        const result = await step(phase, current, deps(root, { agent, writerGuard: guard }));

        // The step itself is what it always was.
        expect(result.outcome).toBe('BLOCKED');
        expect(result.state).toBe(scenario.state);
        expect(reload(root).state.state).toBe(scenario.state);
        // MEMGUARD: the real writer still asked its guard, exactly once.
        expect(guard.starts()).toBe(scenario.realWriter ? 1 : 0);

        // The evidence, reported and on disk.
        expect(result.writerOutcomeEvidence).toEqual({
          recorded: true,
          code: 'HISTORY_STARTED',
          path: recordPath(root),
        });
        const loaded = loadWriterOutcomes(root, TASK_ID);
        expect(loaded.reading).toBe('WRITER_OUTCOME_HISTORY');
        expect(loaded.record?.outcomes).toHaveLength(1);
        const entry = latestWriterOutcome(loaded);
        expect(entry?.code).toBe(scenario.code);
        expect(entry?.disposition).toBe(AGENT_FAILURE_DISPOSITION[scenario.code]);
        expect(entry?.detail).toBe(AGENT_FAILURE_TEXT[scenario.code]);
        expect(entry?.phase).toBe(phase);
        expect(entry?.round).toBe(1);
        expect(entry?.recordedAt).toBe(NOW);
        expect(entry?.forbiddenWriteRecorded).toBe(scenario.forbiddenWriteRecorded);
      });
    }
  }

  it('tells the deterministic refusal from the transient failure, which the task records do not', async () => {
    const refusedRoot = scratch();
    const unavailableRoot = scratch();
    const runs: readonly (readonly [string, AgentFailureCode])[] = [
      [refusedRoot, 'AGENT_ARGUMENT_REFUSED'],
      [unavailableRoot, 'AGENT_PROCESS_UNAVAILABLE'],
    ];
    for (const [root, code] of runs) {
      const scenario = SCENARIOS.find((candidate) => candidate.code === code);
      if (scenario === undefined) throw new Error(`no scenario for ${code}`);
      const { guard, agent } = scenario.arrange(root, 'IMPLEMENT');
      await runImplementStep(persist(root, 'IMPLEMENT'), deps(root, { agent, writerGuard: guard }));
    }

    // The task records agree on everything but the paths they are about.
    const strip = (root: string) => ({ ...reload(root).state, repositoryRoot: null, worktreePath: null });
    expect(strip(refusedRoot)).toEqual(strip(unavailableRoot));
    // The evidence does not.
    expect(latestWriterOutcome(loadWriterOutcomes(refusedRoot, TASK_ID))?.code).toBe('AGENT_ARGUMENT_REFUSED');
    expect(latestWriterOutcome(loadWriterOutcomes(unavailableRoot, TASK_ID))?.code).toBe(
      'AGENT_PROCESS_UNAVAILABLE',
    );
  });

  it('writes on the scope-gate path too, where the settlement made the one state write', async () => {
    const root = scratch();
    let wrote = false;
    const result = await runImplementStep(
      persist(root, 'IMPLEMENT'),
      deps(root, {
        git: healthyGit({ outside: () => wrote }),
        writerGuard: fakeGuard(root),
        agent: async () => {
          wrote = true;
          return usageLimitResult();
        },
      }),
    );

    expect(result.state).toBe('SCOPE_VIOLATION');
    expect(result.writerOutcomeEvidence?.recorded).toBe(true);
    expect(latestWriterOutcome(loadWriterOutcomes(root, TASK_ID))?.code).toBe('AGENT_USAGE_LIMIT');
  });

  it('writes when the state write itself was refused', async () => {
    const root = scratch();
    const current = persist(root, 'IMPLEMENT');
    // The durable state moves underneath the step, so its compare-and-swap refuses.
    const moved = saveTaskState(
      { ...current.state, stateEnteredAt: '2026-10-19T08:59:00.000Z' },
      { repositoryRoot: root, expectedRevision: current.revision },
    );
    expect(moved.ok).toBe(true);

    const result = await runImplementStep(
      current,
      deps(root, { writerGuard: fakeGuard(root), agent: answers(agentCommandResult({ exitCode: 2 })) }),
    );

    expect(result.outcome).toBe('STATE_NOT_RECORDED');
    expect(result.writerOutcomeEvidence?.recorded).toBe(true);
    expect(latestWriterOutcome(loadWriterOutcomes(root, TASK_ID))?.code).toBe('AGENT_NONZERO_EXIT');
  });

  it('is null on a step in which no writer failed', async () => {
    const root = scratch();
    const result = await runImplementStep(
      persist(root, 'IMPLEMENT'),
      deps(root, {
        writerGuard: fakeGuard(root),
        agent: answers(writerSuccess()),
      }),
    );
    expect(result.writerOutcomeEvidence).toBeNull();
    expect(loadWriterOutcomes(root, TASK_ID).reading).toBe('ABSENT');
  });
});

/* ═════════════ 2. the task's state file is not touched by it ════════════ */

describe('task-state semantics do not change', () => {
  it('leaves the state file byte-equal with the evidence write and without it', async () => {
    const root = scratch();
    const original = persist(root, 'IMPLEMENT');
    const originalBytes = readFileSync(original.path);
    const failing = () =>
      deps(root, { writerGuard: fakeGuard(root), agent: answers(agentCommandResult({ exitCode: 2 })) });

    // Without: the ignore question is answered "no", so the store refuses before any effect.
    const without = await runImplementStep(original, { ...failing(), git: healthyGit({ ignore: 'NOT_IGNORED' }) });
    expect(without.writerOutcomeEvidence).toMatchObject({ recorded: false, code: 'RUNTIME_PATH_NOT_IGNORED' });
    expect(existsSync(recordPath(root))).toBe(false);
    const bytesWithout = readFileSync(original.path);

    // Put the task back exactly as it was, and run the same step with the write.
    writeFileSync(original.path, originalBytes);
    const with_ = await runImplementStep(reload(root), failing());
    expect(with_.writerOutcomeEvidence?.recorded).toBe(true);
    const bytesWith = readFileSync(original.path);

    expect(bytesWith.equals(bytesWithout)).toBe(true);
    expect(with_.outcome).toBe(without.outcome);
    expect(with_.state).toBe(without.state);
  });
});

/* ═══════════════════════════ 3. bounded ═════════════════════════════════ */

describe('the record is bounded, and a loss is visible', () => {
  it('keeps the newest eight of nine, counts one dropped, and stays under its byte cap', async () => {
    const root = scratch();
    for (let round = 1; round <= MAX_WRITER_OUTCOMES_KEPT + 1; round += 1) {
      const written = await record(root, entryOf('AGENT_FORBIDDEN_WRITE', round));
      expect(written.recorded).toBe(true);
      expect(written.code).toBe(round === 1 ? 'HISTORY_STARTED' : 'OUTCOME_RECORDED');
    }

    const loaded = loadWriterOutcomes(root, TASK_ID);
    expect(MAX_WRITER_OUTCOMES_KEPT).toBe(8);
    expect(loaded.record?.outcomes.map((entry) => entry.round)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(loaded.record?.droppedCount).toBe(1);
    expect(statSync(recordPath(root)).size).toBeLessThanOrEqual(MAX_WRITER_OUTCOME_RECORD_BYTES);

    await record(root, entryOf('AGENT_NONZERO_EXIT', 10));
    const again = loadWriterOutcomes(root, TASK_ID);
    expect(again.record?.outcomes).toHaveLength(8);
    expect(again.record?.droppedCount).toBe(2);
    expect(latestWriterOutcome(again)?.round).toBe(10);
  });

  it('refuses a file over the byte cap on read', () => {
    const root = scratch();
    const path = recordPath(root);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, ' '.repeat(MAX_WRITER_OUTCOME_RECORD_BYTES + 1));
    expect(loadWriterOutcomes(root, TASK_ID).reading).toBe('MALFORMED');
  });
});

/* ═══════════════════ 4. closed values only ══════════════════════════════ */

describe('the record holds closed values only', () => {
  it('keeps no byte of the agent’s output from a real failed run', async () => {
    const root = scratch();
    await runImplementStep(
      persist(root, 'IMPLEMENT'),
      deps(root, {
        writerGuard: fakeGuard(root),
        agent: answers(
          agentCommandResult({
            exitCode: 2,
            stdout: `token ${TOKEN} under C:\\Users\\${HOME_MARKER}\\x\n`,
            stderr: `stderr ${TOKEN} ${HOME_MARKER}\n`,
          }),
        ),
      }),
    );

    const text = readFileSync(recordPath(root), 'utf8');
    expect(latestWriterOutcome(loadWriterOutcomes(root, TASK_ID))?.code).toBe('AGENT_NONZERO_EXIT');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('sk-ant');
    expect(text).not.toContain(HOME_MARKER);
    expect(text).not.toContain('stdout');
    expect(text).not.toContain('stderr');
  });

  it('keeps no diagnostics and no forbidden-write path from a result that carries both', async () => {
    const root = scratch();
    writerOverride.current = async (request) =>
      failedWriter('AGENT_FORBIDDEN_WRITE', {
        phase: request.phase,
        round: request.round,
        // Text a hand-built or future result might carry, and a detail that is not the static one.
        detail: `custom ${TOKEN}`,
        diagnostics: Object.freeze({
          stdoutExcerpt: `stdout ${TOKEN}`,
          stderrExcerpt: `C:\\Users\\${HOME_MARKER}\\.claude`,
          trusted: false as const,
        }),
        forbiddenWrite: Object.freeze({ recordPath: `C:\\Users\\${HOME_MARKER}\\violation.json` }),
      });

    await runImplementStep(persist(root, 'IMPLEMENT'), deps(root, { writerGuard: fakeGuard(root) }));

    const text = readFileSync(recordPath(root), 'utf8');
    const entry = latestWriterOutcome(loadWriterOutcomes(root, TASK_ID));
    expect(entry?.forbiddenWriteRecorded).toBe(true);
    expect(entry?.detail).toBe(AGENT_FAILURE_TEXT.AGENT_FORBIDDEN_WRITE);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(HOME_MARKER);
    expect(text).not.toContain('Excerpt');
    expect(text).not.toContain('trusted');
  });

  it('refuses a document with any field outside the contract', async () => {
    const root = scratch();
    await record(root, entryOf());
    const original = JSON.parse(readFileSync(recordPath(root), 'utf8')) as Record<string, unknown>;
    const subject = { taskId: TASK_ID, repositoryRoot: root };
    expect(readWriterOutcomes(original, subject).reading).toBe('WRITER_OUTCOME_HISTORY');

    const outcomes = original['outcomes'] as Record<string, unknown>[];
    const first = outcomes[0] as Record<string, unknown>;
    const variants: Record<string, unknown>[] = [
      { ...original, diagnostics: {} },
      { ...original, outcomes: [{ ...first, stdoutExcerpt: 'x' }] },
      { ...original, outcomes: [{ ...first, forbiddenWritePath: 'x' }] },
      { ...original, outcomes: [{ ...first, process: { ...(first['process'] as object), stderr: '' } }] },
    ];
    for (const variant of variants) {
      // The binding covers the named fields only, so it still matches: the refusal is the schema's.
      expect(readWriterOutcomes(variant, subject).reading).toBe('MALFORMED');
    }

    // And on disk: the loader refuses it, and the next write will not replace it.
    writeFileSync(recordPath(root), JSON.stringify(variants[1]));
    expect(loadWriterOutcomes(root, TASK_ID).reading).toBe('MALFORMED');
  });
});

/* ═══════════ 5. atomic and robust, and a failure changes nothing ════════ */

describe('a failed evidence write changes nothing else', () => {
  /** The step's outcome and the durable task record, without the paths it is about. */
  async function runFailing(root: string, overrides: Partial<LoopDependencies> = {}) {
    const before = persist(root, 'IMPLEMENT');
    const bytesBefore = readFileSync(before.path);
    const result = await runImplementStep(
      before,
      deps(root, {
        writerGuard: fakeGuard(root),
        agent: answers(agentCommandResult({ exitCode: 2 })),
        ...overrides,
      }),
    );
    const after = loadTaskState(root, TASK_ID);
    return {
      result,
      bytesBefore,
      bytesAfter: after.ok ? readFileSync(after.path) : null,
      state: after.ok ? { ...after.state, repositoryRoot: null, worktreePath: null } : null,
    };
  }

  async function baseline() {
    const run = await runFailing(scratch());
    expect(run.result.writerOutcomeEvidence?.recorded).toBe(true);
    return run;
  }

  const CLOSED = new Set<string>([...WRITER_OUTCOME_RECORD_CODES, 'RECORDER_THREW']);

  it('a path Git does not ignore: refused before any effect, the step as it was', async () => {
    const reference = await baseline();
    const root = scratch();
    const run = await runFailing(root, { git: healthyGit({ ignore: 'NOT_IGNORED' }) });

    expect(run.result.writerOutcomeEvidence).toMatchObject({ recorded: false, code: 'RUNTIME_PATH_NOT_IGNORED' });
    expect(run.result.outcome).toBe(reference.result.outcome);
    expect(run.result.state).toBe(reference.result.state);
    expect(run.state).toEqual(reference.state);
    expect(existsSync(join(recordPath(root), '..'))).toBe(false);
  });

  it('a lost lease: nothing written, a closed code, and the state as it was before the step', async () => {
    const root = scratch();
    const d = deps(root);
    const run = await runFailing(root, {
      agent: async () => {
        releaseRepositoryExecutionLease(d.lease.evidence);
        return agentCommandResult({ exitCode: 2 });
      },
      lease: d.lease,
    });

    // The state write is refused by the lease, exactly as it was before this task.
    expect(run.result.outcome).toBe('STATE_NOT_RECORDED');
    expect(run.bytesAfter?.equals(run.bytesBefore)).toBe(true);
    expect(run.result.writerOutcomeEvidence?.recorded).toBe(false);
    expect(CLOSED.has(run.result.writerOutcomeEvidence?.code ?? '')).toBe(true);
    expect(existsSync(recordPath(root))).toBe(false);
  });

  it('a write error: reported with a closed code, the step as it was', async () => {
    const reference = await baseline();
    const root = scratch();
    // A file standing where the record's directory must be.
    const blocker = join(recordPath(root), '..');
    mkdirSync(join(blocker, '..'), { recursive: true });
    writeFileSync(blocker, 'in the way');

    const run = await runFailing(root);

    expect(run.result.writerOutcomeEvidence?.recorded).toBe(false);
    expect(['DIRECTORY_CREATE_FAILED', 'EXISTING_HISTORY_UNREADABLE']).toContain(
      run.result.writerOutcomeEvidence?.code,
    );
    expect(readFileSync(blocker, 'utf8')).toBe('in the way');
    expect(run.result.outcome).toBe(reference.result.outcome);
    expect(run.state).toEqual(reference.state);
  });

  it('an unreadable existing record: never overwritten, the step as it was', async () => {
    const reference = await baseline();
    const root = scratch();
    const path = recordPath(root);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'not a record at all');

    const run = await runFailing(root);

    expect(run.result.writerOutcomeEvidence).toMatchObject({
      recorded: false,
      code: 'EXISTING_HISTORY_UNREADABLE',
    });
    expect(readFileSync(path, 'utf8')).toBe('not a record at all');
    expect(run.result.outcome).toBe(reference.result.outcome);
    expect(run.state).toEqual(reference.state);
  });

  it('a store that throws: reported, never thrown, the step as it was', async () => {
    const reference = await baseline();
    const run = await runFailing(scratch(), { git: healthyGit({ ignore: 'THROW' }) });

    expect(run.result.writerOutcomeEvidence).toEqual({ recorded: false, code: 'RECORDER_THREW', path: null });
    expect(run.result.outcome).toBe(reference.result.outcome);
    expect(run.state).toEqual(reference.state);
  });

  describe('the store, step by step', () => {
    it('asks the lease last, and writes nothing without it', async () => {
      const root = scratch();
      const written = await record(root, entryOf(), { leaseHolds: () => false });
      expect(written).toMatchObject({ recorded: false, code: 'EXECUTION_LEASE_NOT_HELD' });
      expect(existsSync(recordPath(root))).toBe(false);
    });

    it('asks Git about the staging name and the record, and refuses an undetermined answer', async () => {
      const root = scratch();
      const asked: string[] = [];
      const written = await record(root, entryOf(), {
        checkIgnored: async (path) => {
          asked.push(path);
          return 'UNDETERMINED';
        },
      });
      expect(written.code).toBe('RUNTIME_IGNORE_UNDETERMINED');
      expect(asked).toEqual(['.agent-orchestrator/runtime/writer-outcomes/task-0001.json.tmp-probe']);

      const both: string[] = [];
      await record(root, entryOf(), {
        checkIgnored: async (path) => {
          both.push(path);
          return 'IGNORED';
        },
      });
      expect(both).toEqual([
        '.agent-orchestrator/runtime/writer-outcomes/task-0001.json.tmp-probe',
        '.agent-orchestrator/runtime/writer-outcomes/task-0001.json',
      ]);
    });

    it('reports a failed replace and leaves the previous record exactly as it was', async () => {
      const root = scratch();
      await record(root, entryOf('AGENT_NONZERO_EXIT', 1));
      const before = readFileSync(recordPath(root));

      const written = await record(root, entryOf('AGENT_RESULT_MALFORMED', 2), {
        replace: () => {
          const error: NodeJS.ErrnoException = new Error('busy');
          error.code = 'EPERM';
          throw error;
        },
      });

      expect(written).toMatchObject({ recorded: false, code: 'WRITE_FAILED' });
      expect(readFileSync(recordPath(root)).equals(before)).toBe(true);
    });

    it('refuses to replace a record about another task', async () => {
      const root = scratch();
      await record(root, entryOf());
      const doc = JSON.parse(readFileSync(recordPath(root), 'utf8')) as Record<string, unknown>;
      const foreign = JSON.stringify({ ...doc, binding: 'f'.repeat(64) });
      writeFileSync(recordPath(root), foreign);

      expect(loadWriterOutcomes(root, TASK_ID).reading).toBe('NOT_THIS_TASK');
      expect((await record(root, entryOf())).code).toBe('EXISTING_HISTORY_UNREADABLE');
      expect(readFileSync(recordPath(root), 'utf8')).toBe(foreign);
    });

    it('lives under the repository root, never under the worktree', () => {
      const root = scratch();
      const location = deriveWriterOutcomeLocation(root, TASK_ID);
      if (!location.ok) throw new Error('location not derivable');
      expect(location.path).toBe(join(root, '.agent-orchestrator', 'runtime', 'writer-outcomes', 'task-0001.json'));
      expect(deriveWriterOutcomeLocation(root, '../escape').ok).toBe(false);
      expect(deriveWriterOutcomeLocation('relative', TASK_ID).ok).toBe(false);
    });
  });
});

/* ═══════════ 6. the runtime readers still see only task records ═════════ */

describe('the runtime readers never read the record as a task', () => {
  it('the dashboard scan, the attention outbox and the durable wake list name no task writer-outcomes', async () => {
    const root = realpathSync.native(
      createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE, files: {} }),
    );
    const result = await runImplementStep(
      persist(root, 'IMPLEMENT'),
      deps(root, { writerGuard: fakeGuard(root), agent: answers(agentCommandResult({ exitCode: 2 })) }),
    );
    expect(result.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(existsSync(recordPath(root))).toBe(true);

    const attention = scanAttention([{ repositoryId: 'repo-alpha', repositoryRoot: root }], NOW);
    expect(attention.statesRead).toBe(1);
    expect(attention.notes).not.toContain('STATE_UNREADABLE');
    expect(
      attention.items.map((item) => (item.record.subject === 'TASK' ? item.record.taskId : null)),
    ).toEqual([TASK_ID]);

    const wakes = scanDurableWakes([root], { now: NOW, since: NOW });
    expect(wakes.statesRead).toBe(1);
    expect(wakes.notes).not.toContain('STATE_UNREADABLE');

    const snapshot = readDashboardSnapshot({
      now: () => new Date(NOW),
      loadRegistry: () =>
        ({
          state: 'REGISTERED',
          registryDigest: 'd'.repeat(64),
          entries: [{ path: root }],
          maxConcurrentRepositories: 1,
        }) as RepositoryRegistryOutcome,
    });
    const repository = snapshot.repositories[0];
    expect(repository?.runtimeScan).toMatchObject({ reading: 'READ', stateFileCount: 1 });
    const taskIds = repository?.tasks.map((task) => task.taskId) ?? [];
    expect(taskIds).toContain(TASK_ID);
    expect(taskIds).not.toContain('writer-outcomes');
    expect(snapshot.notes.map((n) => n.taskId)).not.toContain('writer-outcomes');
  });
});

/* ═══════════════════════ 7. evidence never decides ══════════════════════ */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function importersOf(moduleName: string): string[] {
  const src = join(PACKAGE_ROOT, 'src');
  const specifier = new RegExp(String.raw`(from|import\()\s*['"][^'"]*/${moduleName}\.js['"]`);
  return (readdirSync(src, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(src, name))
    .filter((file) => specifier.test(readFileSync(file, 'utf8')))
    .map((file) => relative(PACKAGE_ROOT, file))
    .sort();
}

/** What a plan decides. Everything but the display field. */
function decided(plan: RunPlan) {
  return {
    selection: plan.selection,
    target: plan.target,
    state: plan.state,
    conclusion: plan.conclusion,
    reasonCodes: plan.reasonCodes,
    resume: plan.resume,
  };
}

async function parkedPlanFixture() {
  const started = await startTask({ taskId: 'V2-01' });
  // The parked seed `run-plan.test.ts` measures as `TASK_PARKED`.
  seedState(started, {
    state: 'BLOCKED_USAGE_LIMIT',
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    worktreeCleanAtCheckpoint: true,
  });
  const repository = started.repository;
  const plan = (): Promise<RunPlan> =>
    planRun({ repository, taskId: 'V2-01' }, { git: runGitCommand, now: () => NOW });
  const write = (entry: WriterOutcomeEntry) =>
    recordWriterOutcome({
      repositoryRoot: repository.root,
      taskId: 'V2-01',
      entry,
      leaseHolds: () => true,
      checkIgnored: async () => 'IGNORED',
    });
  const location = deriveWriterOutcomeLocation(repository.root, 'V2-01');
  if (!location.ok) throw new Error('location not derivable');
  return { repository, plan, write, path: location.path };
}

describe('evidence never decides', () => {
  it('is imported by the step that writes it and the plan that displays it, and nothing else', () => {
    expect(importersOf('writer-outcome-store')).toEqual([
      join('src', 'loop', 'loop-step.ts'),
      join('src', 'run', 'run-plan.ts'),
    ]);
    expect(importersOf('writer-outcome')).toEqual([
      join('src', 'agent', 'writer-outcome-store.ts'),
      join('src', 'loop', 'loop-step.ts'),
    ]);
  });

  it('leaves the plan equal with the record present, absent and unreadable — only the line differs', async () => {
    const fixture = await parkedPlanFixture();

    const absent = await fixture.plan();
    expect((await fixture.write(entryOf('AGENT_ARGUMENT_REFUSED'))).recorded).toBe(true);
    const present = await fixture.plan();
    writeFileSync(fixture.path, '{ not a record');
    const unreadable = await fixture.plan();

    expect(absent.conclusion).toBe('TASK_PARKED');
    expect(decided(present)).toEqual(decided(absent));
    expect(decided(unreadable)).toEqual(decided(absent));
    expect([absent, present, unreadable].map((plan) => plan.writerOutcome?.reading)).toEqual([
      'ABSENT',
      'WRITER_OUTCOME_HISTORY',
      'MALFORMED',
    ]);

    const withoutLine = (plan: RunPlan) =>
      renderRunPlan(plan, fixture.repository)
        .split('\n')
        .filter((text) => !text.startsWith('Writer outcome'));
    expect(withoutLine(present)).toEqual(withoutLine(absent));
    expect(withoutLine(unreadable)).toEqual(withoutLine(absent));
  });
});

/* ═════════════════════════ 8. the display line ══════════════════════════ */

describe('the plan prints one writer-outcome line', () => {
  function writerLines(plan: RunPlan, repository: Parameters<typeof renderRunPlan>[1]): string[] {
    return renderRunPlan(plan, repository)
      .split('\n')
      .filter((text) => text.startsWith('Writer outcome'));
  }

  it('names the newest entry, says none with no record, and unreadable for every other reading', async () => {
    const fixture = await parkedPlanFixture();
    const absent = await fixture.plan();
    expect(writerLines(absent, fixture.repository)).toEqual(['Writer outcome: none']);

    await fixture.write(entryOf('AGENT_PROCESS_UNAVAILABLE', 1, 'IMPLEMENT', '2026-10-19T08:00:00.000Z'));
    await fixture.write(entryOf('AGENT_ARGUMENT_REFUSED', 2, 'REMEDIATE', '2026-10-19T09:30:00.000Z'));
    const present = await fixture.plan();
    expect(writerLines(present, fixture.repository)).toEqual([
      'Writer outcome: AGENT_ARGUMENT_REFUSED (REMEDIATE r2, 2026-10-19T09:30:00.000Z)',
    ]);

    const readings: WriterOutcomeLoad['reading'][] = ['MALFORMED', 'UNSUPPORTED_VERSION', 'NOT_THIS_TASK'];
    for (const reading of readings) {
      const load: WriterOutcomeLoad = Object.freeze({ reading, path: fixture.path, record: null });
      expect(writerLines({ ...absent, writerOutcome: load }, fixture.repository)).toEqual([
        'Writer outcome: unreadable',
      ]);
    }

    // Each of those readings is real, not only a value handed to the renderer.
    writeFileSync(fixture.path, JSON.stringify({ outcomeVersion: 2 }));
    expect((await fixture.plan()).writerOutcome?.reading).toBe('UNSUPPORTED_VERSION');

    // No task in hand, no line.
    expect(writerLines({ ...absent, writerOutcome: null }, fixture.repository)).toEqual([]);
  });
});
