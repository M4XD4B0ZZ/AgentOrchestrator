/**
 * Composition helpers for the V1-08 end-to-end suite.
 *
 * ── Why these exist ────────────────────────────────────────────────────────
 *
 * Every V1 slice is tested in isolation, and every one of those tests builds
 * the layer beneath it as a literal: `tests/run-driver.test.ts` writes its own
 * `ResolvedRepository` object and scripts a `GitRunner` that answers
 * `worktree list` from a string. That is the right shape for asking "does the
 * driver stop when the registry is unreadable?", because no real repository can
 * be asked to have an unreadable registry on demand.
 *
 * It is the wrong shape for asking whether the slices *fit together*. A scripted
 * registry cannot disagree with the path Git would really print; a literal
 * repository cannot disagree with what `resolveRepository` would really resolve;
 * and a worktree that never existed cannot be dirty in the way a writer really
 * makes one dirty. Those disagreements are exactly where an integration defect
 * lives, so this file builds the real things instead:
 *
 *  - a real `git init` repository, with a real profile and real task files;
 *  - a real `git worktree add`, through the production `prepareTaskWorkspace`;
 *  - a real state file, through the production `saveTaskState`;
 *  - the production `runGitCommand`, so `git worktree list --porcelain` is read
 *    from Git rather than from a fixture string.
 *
 * ── What stays injected, and why that is not a compromise ──────────────────
 *
 * Claude and Codex are subscription CLIs. `AgentRunner` exists precisely so
 * nothing in a test starts one, and a suite that did would be asserting facts
 * about a model rather than about this repository. The verification seam is
 * injected for the same reason in most cases — a fixture repository has no npm
 * project — but *not* always: `runRealVerification` below omits it so the
 * production `runVerificationCommand` spawns a real process, which is what
 * closes F-8.
 *
 * ── Ordering that will bite anyone who ignores it ──────────────────────────
 *
 * `prepareTaskWorkspace` refuses `SOURCE_WORKTREE_DIRTY` when the source
 * repository has untracked files, and a persisted state *is* an untracked file
 * (`<root>/.agent-orchestrator/runtime/<id>.json`). So the workspace must be
 * prepared **before** any state is seeded. {@link startTask} does them in that
 * order for exactly this reason.
 */

import { rmSync } from 'node:fs';

import { expect } from 'vitest';

import type { AgentCommandResult, AgentRunner } from '../../src/agent/agent-command.js';
import type { TaskStateInput } from '../../src/core/task-state.js';
import type { ResolvedRepository } from '../../src/repo/resolve-repository.js';
import {
  loadTaskState,
  saveTaskState,
  type StateLoadSuccess,
} from '../../src/state/state-store.js';
import type { VerificationCommandResult, VerificationRunner } from '../../src/verify/verify-command.js';
import { prepareTaskWorkspace, type TaskWorkspace } from '../../src/worktree/prepare-workspace.js';
import { createRepoFixture, writeRepoFile, git } from './repo-fixtures.js';
import { resolveFixture, taskWithId, trackWorkspacesOf } from './worktree-fixtures.js';
import { agentCommandResult, claudeSuccessEnvelope, codexTranscript } from '../fixtures.js';
import { leaseFor } from './lease.js';

/* ─────────────────────────────── profiles ───────────────────────────────── */

/**
 * A profile for a repository the loop can actually be driven over.
 *
 * `maxReviewRounds` is a parameter because the budget-exhaustion cases need a
 * small one and the remediation cycle needs room for two rounds; leaving it
 * implicit would make those tests depend on a constant three files away.
 *
 * The verification commands are never spawned in the injected-seam cases, and
 * are deliberately shell-inert so that the cases which *do* spawn (see
 * {@link realVerificationProfile}) differ in one thing only.
 */
export function e2eProfile(options: { readonly maxReviewRounds?: number } = {}): string {
  const maxReviewRounds = options.maxReviewRounds ?? 3;
  return `schemaVersion: 1
repository:
  id: e2e-alpha
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: VERIFY
      command: [git, --version]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: ${maxReviewRounds}
remote:
  required: false
`;
}

/**
 * A profile whose declared verification really is runnable.
 *
 * `git --version` is chosen because it exists wherever this suite can run at
 * all, exits 0, prints a bounded line, and is expressible under the shell-inert
 * argument grammar the profile schema enforces. `git rev-parse --verify` with a
 * bad ref gives the failing counterpart without needing a project.
 */
export function realVerificationProfile(command: readonly string[]): string {
  return e2eProfile().replace(
    '      command: [git, --version]',
    `      command: [${command.join(', ')}]`,
  );
}

/** A task file the repository's own selector will discover. */
export function taskFile(id: string, options: { readonly dependsOn?: readonly string[]; readonly status?: 'OPEN' | 'DONE' } = {}): string {
  const dependsOn = options.dependsOn ?? [];
  return [
    '---',
    `id: ${id}`,
    `title: task ${id}`,
    `status: ${options.status ?? 'OPEN'}`,
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: true',
    dependsOn.length === 0 ? 'dependsOn: []' : `dependsOn:\n${dependsOn.map((d) => `  - ${d}`).join('\n')}`,
    '---',
    '',
    'Body prose, which nothing interprets.',
    '',
  ].join('\n');
}

/* ──────────────────────────── the composed start ─────────────────────────── */

export interface StartedTask {
  readonly repository: ResolvedRepository;
  readonly root: string;
  readonly workspace: TaskWorkspace;
  readonly taskId: string;
}

/**
 * A repository, a real worktree for one task, and nothing persisted yet.
 *
 * A repository and a real worktree, with no state persisted.
 *
 * When V1-08 was written this was as far as the product composed on its own,
 * because nothing could create a first `TaskState` at all. V2-03's `startTask`
 * now can — but it creates one at `WORKTREE_READY`, and these scenarios need a
 * state at `VERIFYING`, which still requires the setup chain and the implement
 * step. So {@link seedState} remains the test's own composition, for a
 * narrower reason than before: not "the product cannot create a state", but
 * "the product cannot yet reach the state these scenarios start from".
 */
export async function startTask(options: {
  readonly taskId: string;
  readonly profile?: string;
  readonly files?: Readonly<Record<string, string>>;
}): Promise<StartedTask> {
  const taskId = options.taskId;
  const root = createRepoFixture({
    defaultBranch: 'main',
    profile: options.profile ?? e2eProfile(),
    files: { [`tasks/${taskId}.md`]: taskFile(taskId), ...options.files },
  });

  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);

  // Before any state is seeded — a persisted state is an untracked file, and
  // preparation refuses a dirty source repository.
  const prepared = await prepareTaskWorkspace(repository, taskWithId(taskId), {
    lease: leaseFor(repository),
    base: { kind: 'DEFAULT_BRANCH_TIP' },
  });
  if (!prepared.ok) throw new Error(`workspace did not prepare: ${prepared.code}`);

  return { repository, root, workspace: prepared.workspace, taskId };
}

/**
 * Persists a first state built from the **real** workspace receipt.
 *
 * Every identity field comes from `TaskWorkspace` rather than from a literal,
 * which is the point: `prepare-workspace.ts` claims "every field is one a
 * `TaskState` will carry, spelled the same way", and nothing tested that claim
 * before V1-08.
 */
export function seedState(
  started: StartedTask,
  overrides: Partial<TaskStateInput> = {},
): StateLoadSuccess {
  const { workspace, repository } = started;
  const state: TaskStateInput = {
    schemaVersion: 1,
    taskId: workspace.taskId,
    repositoryId: workspace.repositoryId,
    repositoryRoot: workspace.repositoryRoot,
    worktreePath: workspace.worktreePath,
    state: 'VERIFYING',
    stateEnteredAt: '2026-08-10T09:00:00.000Z',
    baseBranch: workspace.baseBranch,
    basePinnedCommit: workspace.basePinnedCommit,
    workBranch: workspace.workBranch,
    currentCommit: workspace.basePinnedCommit,
    reviewRound: 0,
    maxReviewRounds: repository.completion.maxReviewRounds,
    blockedAgent: null,
    resumeFrom: null,
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: true,
    findingHistory: [],
    ...overrides,
  };

  const saved = saveTaskState(state, { repositoryRoot: started.root });
  if (!saved.ok) throw new Error(`seed did not persist: ${saved.code} ${saved.detail ?? ''}`);
  return reload(started.root, workspace.taskId);
}

/** The durable state as a caller would hold it. Fails loudly rather than silently. */
export function reload(root: string, taskId: string): StateLoadSuccess {
  const loaded = loadTaskState(root, taskId);
  if (loaded.classification !== 'STATE_VALID') {
    throw new Error(`state did not load: ${loaded.ok ? 'ok' : loaded.code}`);
  }
  return loaded;
}

/** The durable state, or `null` when the load did not produce one. */
export function tryReload(root: string, taskId: string) {
  const loaded = loadTaskState(root, taskId);
  return loaded.classification === 'STATE_VALID' ? loaded : null;
}

/* ─────────────────────────────── the seams ──────────────────────────────── */

/** A clock that never repeats, so two states never claim one `stateEnteredAt`. */
export function tickingClock(start = Date.parse('2026-08-10T10:00:00.000Z')): () => string {
  let tick = 0;
  return () => new Date(start + tick++ * 1000).toISOString();
}

export interface RecordedVerify {
  readonly runner: VerificationRunner;
  readonly calls: { readonly command: string; readonly args: readonly string[]; readonly cwd: string }[];
}

/** A verification seam that records where it was asked to run, and answers from a script. */
export function recordedVerify(
  answer: (index: number) => Partial<VerificationCommandResult> = () => ({}),
): RecordedVerify {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const runner: VerificationRunner = async (command, args, cwd) => {
    const index = calls.length;
    calls.push({ command, args: [...args], cwd });
    return Object.freeze({
      outcome: 'RAN' as const,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      failureCode: null,
      errnoCode: null,
      durationMs: 1,
      ...answer(index),
    });
  };
  return { runner, calls };
}

export interface RecordedAgent {
  readonly runner: AgentRunner;
  readonly calls: { readonly agent: string; readonly cwd: string; readonly payload: string }[];
  readonly countFor: (agent: 'claude' | 'codex') => number;
}

/**
 * An agent seam that records every invocation and answers per agent.
 *
 * `cwd` is recorded because it is the fact V1-07's execution-authority rule is
 * about: a step must run in the directory Git vouched for, and an assertion that
 * only checks the *outcome* would pass just as well if the writer had run in the
 * canonical main checkout.
 */
export function recordedAgent(handlers: {
  readonly claude?: (call: { readonly cwd: string; readonly payload: string; readonly index: number }) => AgentCommandResult | Promise<AgentCommandResult>;
  readonly codex?: (call: { readonly cwd: string; readonly payload: string; readonly index: number }) => AgentCommandResult | Promise<AgentCommandResult>;
}): RecordedAgent {
  const calls: { agent: string; cwd: string; payload: string }[] = [];
  const runner: AgentRunner = async (agent, _args, cwd, payload) => {
    const index = calls.filter((call) => call.agent === agent).length;
    calls.push({ agent, cwd, payload });
    const handler = agent === 'claude' ? handlers.claude : handlers.codex;
    if (handler === undefined) {
      throw new Error(`unexpected ${agent} invocation in this scenario`);
    }
    return handler({ cwd, payload, index });
  };
  return {
    runner,
    calls,
    countFor: (agent) => calls.filter((call) => call.agent === agent).length,
  };
}

/** A Codex run that returns a well-formed review document. */
export function reviewResult(review: unknown): AgentCommandResult {
  return agentCommandResult({ stdout: codexTranscript(review) });
}

/** A review reporting one finding against a real path in the fixture. */
export function findingsReview(path = 'src/index.ts', rule = 'e2e.rule'): Record<string, unknown> {
  return {
    reviewVersion: 1,
    verdict: 'FINDINGS',
    findings: [{ severity: 'high', path, rule }],
  };
}

/** A Claude run that positively succeeded. */
export function writerSuccess(): AgentCommandResult {
  return agentCommandResult({ stdout: claudeSuccessEnvelope() });
}

/**
 * A Claude run that positively succeeded **and really changed the worktree**.
 *
 * The whole point of the remediation cycle test: the writer commits, so the
 * next reconciliation sees a HEAD the record did not name and a tree the record
 * did not describe — the exact conditions V1-07-RR-B2's checkpoint withdrawal
 * exists to survive, produced by a real `git commit` rather than by a script.
 */
export function writerThatCommits(fileName: string, contents: string) {
  return (call: { readonly cwd: string }): AgentCommandResult => {
    writeRepoFile(call.cwd, fileName, contents);
    git(call.cwd, ['add', '--all']);
    git(call.cwd, ['commit', '--quiet', '-m', `remediation ${fileName}`]);
    return writerSuccess();
  };
}

/**
 * A Claude run that positively succeeded, **edited the worktree, and did not
 * commit** — the shape the writer actually has once its authority is the
 * measured one: `Read Edit Write Glob Grep`, no shell.
 *
 * `permissionDenials` is the whole reason this is not `writerThatCommits` with
 * the commit removed. The envelope the CLI printed for the first dogfood run
 * was a *success* that also reported denials, and a fixture that cannot produce
 * that combination cannot drive the transport case at all: the observation has
 * to survive a run which does **not** stop on the writer step.
 */
export function writerThatEdits(
  fileName: string,
  contents: string,
  options: { readonly permissionDenials?: readonly string[] } = {},
) {
  return (call: { readonly cwd: string }): AgentCommandResult => {
    writeRepoFile(call.cwd, fileName, contents);
    return writerEnvelopeWithDenials(options.permissionDenials ?? []);
  };
}

/**
 * The successful envelope, carrying denials in the CLI's own measured shape.
 *
 * The entries are objects with `tool_name`, `tool_use_id` and `tool_input`,
 * because that is what 2.1.233 prints — a fixture that carried bare strings
 * would let a reader that only understands strings pass.
 */
export function writerEnvelopeWithDenials(tools: readonly string[]): AgentCommandResult {
  return agentCommandResult({
    stdout: claudeSuccessEnvelope({
      permission_denials: tools.map((tool, index) => ({
        tool_name: tool,
        tool_use_id: `toolu_${index}`,
        tool_input: { note: 'foreign text that must never be carried' },
      })),
    }),
  });
}

/** A Claude run refused for quota, in exactly the envelope V1-05 recognises. */
export function usageLimitResult(): AgentCommandResult {
  return agentCommandResult({
    exitCode: 1,
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      api_error_status: 429,
    }),
  });
}

/** HEAD of a worktree, read with real Git. */
export function headOf(worktreePath: string): string {
  return git(worktreePath, ['rev-parse', 'HEAD']).trim();
}

/** Removes a directory tree, tolerating Windows file locks. */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // A locked Git file on Windows must not fail an otherwise passing suite.
  }
}

/** Asserts that no external work happened at all. */
export function expectNothingRan(agent: RecordedAgent, verify: RecordedVerify): void {
  expect(agent.calls).toEqual([]);
  expect(verify.calls).toEqual([]);
}
