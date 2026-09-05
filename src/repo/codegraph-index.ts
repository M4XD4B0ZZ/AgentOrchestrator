/**
 * Making a task worktree carry the capability its repository requires.
 *
 * ── The hole this fills ────────────────────────────────────────────────────
 *
 * `repo/capabilities.ts` answers whether a working copy carries a CodeGraph
 * index, and `plan/task-brief.ts` asks it about the tree the agents open. Asking
 * the right directory is correct and, on its own, catastrophic: a task worktree
 * is made by `git worktree add`, which populates **tracked** content, and an
 * index directory is ignored. Measured on the machine this was written on: 0 of
 * 12 existing worktrees carried one. A build that shipped the corrected probe
 * and nothing else would refuse every task in every `codegraph: REQUIRED`
 * repository, for ever — a fail-closed gate nobody can satisfy is not a gate,
 * it is an outage.
 *
 * So something must make the index exist in that tree. This module is that
 * something, and the whole of its design is **who is allowed to say what runs**.
 *
 * ── Why the operator, and nobody else ──────────────────────────────────────
 *
 *  - **not the repository.** A profile naming a program would be a repository
 *    choosing what this machine executes during workspace preparation, which is
 *    exactly what `config/mcp-capability-registry.ts` exists to refuse. The
 *    repository still supplies one word — `codegraph: REQUIRED` — and nothing
 *    else;
 *  - **not the writing agent.** `capabilitySatisfied` treats the index
 *    directory as the *evidence* for the capability. An agent that could run
 *    `codegraph init` would manufacture the proof of the capability AO fails
 *    closed on: a writer minting its own authority. It is why the writer's tool
 *    set is unchanged by this slice, and why nothing here is reachable from an
 *    agent's session;
 *  - **the operator**, in `~/.agent-orchestrator/mcp-capabilities.yaml`, beside
 *    the server command they already name there. Same trust root, same
 *    shell-inert grammar, same absence-is-a-refusal rule.
 *
 * Capability *provisioning* belongs to the orchestrator; capability *use*
 * belongs to the agent. That is the whole division.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 *  - **it never runs when the index is already there.** Idempotent by
 *    measurement rather than by a flag: probe, and stop if the answer is
 *    `INDEX_PRESENT`;
 *  - **it never runs at the repository root.** The subject is one worktree,
 *    always given, never derived;
 *  - **it never runs for a repository that did not ask.** `OPTIONAL` is a
 *    repository saying it can work without the capability, and building an
 *    index it did not ask for would be spending an operator's disk and minutes
 *    on a preference nobody expressed;
 *  - **it never lets its own artefact reach a commit.** Git is asked whether the
 *    index path is ignored *in that worktree*, before anything is created, and a
 *    `NOT_IGNORED` or unreadable answer stops the whole thing. An index is
 *    typically tens of megabytes; `commitTaskWork` stages what the scope guard
 *    approved, and an unignored index would turn a task's commit into a binary
 *    dump — or fail its scope gate and block the task;
 *  - **it never decides anything.** A failure here writes no state and blocks no
 *    task by itself. The capability simply stays unsatisfied, the brief says so,
 *    and the loop's existing gate parks the task with a resume point. One
 *    decision, in one place, made by the component that already owned it.
 */

import { runCommand, UnsafeArgumentError, type CommandResult } from '../doctor/exec.js';
import { createProbeEnv } from '../auth/env-guard.js';
import type { McpCapabilityGrant } from '../config/mcp-capability-registry.js';
import { askRuntimeIgnored } from '../state/runtime-ignored.js';
import type { GitRunner } from '../worktree/git-command.js';
import {
  capabilitySatisfied,
  CODEGRAPH_INDEX_DIR_NAME,
  probeCodegraphCapability,
  type CapabilityStatus,
} from './capabilities.js';

/**
 * How long a preparation command may run.
 *
 * Ten minutes: indexing a large repository is not instant, and the number is
 * bounded rather than generous because this runs before a writer, on the
 * operator's clock. A command that needs longer is a command the operator should
 * run once themselves.
 */
export const CODEGRAPH_PREPARE_TIMEOUT_MS = 600_000;

/**
 * How much of the command's own output is retained.
 *
 * Small on purpose. Nothing here reads the output, and nothing carries it into
 * an agent's prompt or a durable record: the *effect* is what is measured, by
 * probing the directory afterwards. The budget exists so a chatty indexer
 * cannot fill memory, and the process is not killed for reaching it — a gate
 * that is terminated for being verbose is the M6 defect, and it is not
 * reintroduced here.
 */
export const CODEGRAPH_PREPARE_MAX_OUTPUT_BYTES = 65_536;

/** Every way provisioning can end. A closed set; three of them ran a process. */
export const CODEGRAPH_PROVISION_OUTCOMES = [
  /** The repository does not require the capability. Nothing was done. */
  'NOT_REQUIRED',
  /** The worktree already carries an index. Nothing was done. */
  'ALREADY_PRESENT',
  /** The operator's registry declares no preparation command. Nothing was done. */
  'NO_OPERATOR_COMMAND',
  /** Git does not ignore the index path in this worktree. Nothing was started. */
  'INDEX_PATH_NOT_IGNORED',
  /** Git could not say whether the index path is ignored. Nothing was started. */
  'INDEX_IGNORE_UNDETERMINED',
  /** This run is no longer the repository's writer. Nothing was started. */
  'EXECUTION_LEASE_NOT_HELD',
  /** The command ran, and the worktree now carries an index. */
  'PREPARED',
  /** The command could not be started, timed out, or exited non-zero. */
  'COMMAND_FAILED',
  /** The command exited 0 and no index appeared. */
  'STILL_ABSENT',
] as const;

export type CodegraphProvisionOutcome = (typeof CODEGRAPH_PROVISION_OUTCOMES)[number];

export interface CodegraphProvisionResult {
  readonly outcome: CodegraphProvisionOutcome;
  /** The capability status of the worktree after this call. */
  readonly status: CapabilityStatus;
  /** Whether a process was started. Never inferred from `outcome` by a caller. */
  readonly commandRan: boolean;
  /** The command's exit code, or `null` when none ran or none was produced. */
  readonly exitCode: number | null;
}

export interface CodegraphProvisionRequest {
  /** The tree the writer will open. Never the repository root. */
  readonly worktreePath: string;
  /** What the repository declared. Only `REQUIRED` reaches a command. */
  readonly requirement: 'REQUIRED' | 'OPTIONAL';
  /** The operator's grant for this capability, or `null` when there is none. */
  readonly grant: McpCapabilityGrant | null;
  /** The Git seam, used only to ask what is ignored. */
  readonly git: GitRunner;
  /**
   * Whether this run still holds the repository's execution lease.
   *
   * Asked as a function so it is answered *now*, immediately before the spawn,
   * and not taken as a value computed earlier in the invocation. This is the
   * fence every other productive spawn in this build sits behind: what it
   * protects is local — a directory inside the worktree, tens of megabytes of
   * it — and a process that has stopped being the repository's writer must not
   * be creating one.
   */
  readonly leaseHolds: () => boolean;
  /**
   * The runner, defaulting to the real one.
   *
   * A seam of the same class as the verification runner: a caller may substitute
   * the process, never the decision. The decision — did an index appear — is
   * made here by probing the filesystem, so a runner that lied about having
   * prepared one would still produce `STILL_ABSENT`.
   */
  readonly run?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<CommandResult | null>;
}

function result(
  outcome: CodegraphProvisionOutcome,
  status: CapabilityStatus,
  commandRan = false,
  exitCode: number | null = null,
): CodegraphProvisionResult {
  return Object.freeze({ outcome, status, commandRan, exitCode });
}

/**
 * The production runner.
 *
 * `capability:generic` — `PATH` and `PATHEXT` and nothing else — the same policy
 * `verify/verify-command.ts` runs a repository's own gate under and the same one
 * `worktree/git-command.ts` mutates a repository under. A preparation command
 * that needed a credential would be a request for this orchestrator to leak one.
 *
 * `null` for the one condition `runCommand` throws on: an argument this build
 * would not put in argv. The registry already refuses those on the way in, so
 * reaching it means the two rules disagree — which is a refusal to start, never
 * an exception through a caller that has a worktree half-prepared.
 */
const defaultRunner = async (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult | null> => {
  try {
    return await runCommand(command, [...args], {
      env: createProbeEnv('capability:generic', process.env),
      cwd,
      timeoutMs: CODEGRAPH_PREPARE_TIMEOUT_MS,
      maxStdoutBytes: CODEGRAPH_PREPARE_MAX_OUTPUT_BYTES,
      maxStderrBytes: CODEGRAPH_PREPARE_MAX_OUTPUT_BYTES,
      terminateOnOutputLimit: false,
    });
  } catch (error) {
    if (error instanceof UnsafeArgumentError) return null;
    throw error;
  }
};

/**
 * Makes one worktree carry a CodeGraph index, when the repository requires one
 * and the operator has said how.
 *
 * Never throws for an expected condition. Writes no task state, and returns what
 * happened rather than acting on it.
 */
export async function provisionCodegraphIndex(
  request: CodegraphProvisionRequest,
): Promise<CodegraphProvisionResult> {
  const before = probeCodegraphCapability(request.worktreePath);
  if (request.requirement !== 'REQUIRED') return result('NOT_REQUIRED', before);
  // Idempotent by measurement rather than by a flag. `capabilitySatisfied` is
  // the same predicate the brief's gate uses, so "no work needed" here and
  // "satisfied" there cannot drift into disagreeing.
  if (capabilitySatisfied(request.requirement, before)) return result('ALREADY_PRESENT', before);

  const prepare = request.grant?.prepare ?? null;
  if (prepare === null) return result('NO_OPERATOR_COMMAND', before);

  // Before anything is created: would this artefact become part of the task's
  // work? The question is asked in the worktree, because that is the tree whose
  // ignore rules govern what a commit there would contain — and `.codegraph/` is
  // ignored through `.git/info/exclude` in the repositories this was built for,
  // a file in the common Git directory that every linked worktree inherits.
  const ignored = await askRuntimeIgnored(
    request.git,
    request.worktreePath,
    `${CODEGRAPH_INDEX_DIR_NAME}/`,
  );
  if (ignored === 'UNDETERMINED') return result('INDEX_IGNORE_UNDETERMINED', before);
  if (ignored !== 'IGNORED') return result('INDEX_PATH_NOT_IGNORED', before);

  // Last of every gate and first of nothing, for the reason the stores give:
  // it is the answer that goes stale, and the effect is immediately after it.
  if (!request.leaseHolds()) return result('EXECUTION_LEASE_NOT_HELD', before);

  const run = request.run ?? defaultRunner;
  const ran = await run(prepare.command, prepare.args, request.worktreePath);
  if (ran === null) return result('COMMAND_FAILED', probeCodegraphCapability(request.worktreePath));

  const after = probeCodegraphCapability(request.worktreePath);
  if (ran.outcome !== 'COMPLETED' || ran.exitCode !== 0) {
    return result('COMMAND_FAILED', after, true, ran.exitCode);
  }

  // The effect is measured, not taken from the exit code. A command that exits 0
  // and leaves no index has not prepared anything, and reporting its exit code
  // as success would be the reconstructed evidence this repository refuses.
  return result(
    after === 'INDEX_PRESENT' ? 'PREPARED' : 'STILL_ABSENT',
    after,
    true,
    ran.exitCode,
  );
}
