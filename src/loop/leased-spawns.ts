/**
 * The only way a loop step reaches a subprocess (V2-07L).
 *
 * ── Why this is its own module ─────────────────────────────────────────────
 *
 * The fence started as something `runLoopStep` installed: it replaced
 * `deps.agent` with a wrapped version and handed the result down. That fenced
 * every path *through `runLoopStep`* and nothing else, and every step function
 * is exported — so a direct caller got no fence, and an *absent* seam fell
 * through to the raw `runAgentCommand`, which meant the dangerous case was also
 * the default one.
 *
 * Moving the fence to where the seam is read fixed that, and a static test was
 * added claiming the property held for the whole module. A review then defeated
 * that test three times over, from inside the module:
 *
 *  1. aliasing a spawn helper (`const warmUp = runClaudeWriter`) and calling it
 *     with no seam, so the helper's own default reached the raw runner;
 *  2. calling `spawnSync` directly — 57 real unfenced processes started, whole
 *     suite green;
 *  3. calling `runAgentCommand` directly, paid for by rewording one of the three
 *     prose mentions the test counted.
 *
 * The lesson is not that the count was too small. It is that a claim about
 * *every* spawn site cannot be carried by reading source text, any more than the
 * Git-layout rule earlier in this slice could be carried by the three layouts
 * somebody had measured. Three things follow, and they are deliberately not
 * stated as equals:
 *
 *  - **the seams are the enforcement.** Every agent and verification subprocess
 *    goes through {@link leasedAgent} or {@link leasedVerify}, which prove the
 *    lease at the call rather than at some caller's door. That is narrower than
 *    "every productive spawn", which is what this said: `git worktree add`,
 *    `git worktree remove` and `git branch -d` are productive spawns and go
 *    through neither. They are fenced by `verifyExecutionLeaseHeldFor`
 *    immediately before the effect — the same property, a different mechanism,
 *    and worth not blurring, because a reader who believes the seams cover the
 *    Git mutations will look for the wrong gate;
 *  - **a missing seam is a compile error.** `runClaudeWriter`,
 *    `runCodexReviewer` and `runVerification` no longer default their runner, so
 *    a forgetful call site does not build. This is enforcement;
 *  - **the import pins are regression detectors.** This module is the only
 *    importer of the raw runners, and `node:child_process` has exactly one
 *    importer; tests hold both. That catches a reintroduction nobody meant.
 *
 * ── The residue, which is real ─────────────────────────────────────────────
 *
 * The third bullet is **not** a proof, and an earlier version of this header
 * claimed it was. A review disproved that with `process.binding('spawn_sync')`,
 * which starts real processes, names no module, and is therefore invisible to
 * any pin that reads imports — verified working on the Node this package
 * requires. `node:worker_threads`, `node:vm` and indirect `eval` are the same
 * shape. They are on a denylist in `tests/v2-07l-execution-lease.test.ts`
 * because a denylist of known routes is worth having, and a denylist is not a
 * bound on what a determined author can write.
 *
 * What that means in practice: this module makes the *accidental* unfenced spawn
 * impossible and the deliberate one obvious. Bounding the deliberate one needs
 * owned process containment — the same mechanism the recovery contract already
 * waits on — and it is not claimed here.
 *
 * ── What the fence does not claim ──────────────────────────────────────────
 *
 * That an agent *already running* stops. It does not; that needs owned process
 * containment, which is measured in `lease/execution-lease.ts` and deliberately
 * a later slice. This refuses to *start* one.
 */

import { runAgentCommand, type AgentCommandResult, type AgentRunner } from '../agent/agent-command.js';
import { verifyExecutionLeaseHeldFor, type ExecutionLeaseAuthority } from '../lease/execution-lease.js';
import {
  runVerificationCommand,
  type VerificationCommandResult,
  type VerificationRunner,
} from '../verify/verify-command.js';

/** The two seams a step may be handed, and the authority they are fenced by. */
export interface SpawnAuthority {
  readonly lease: ExecutionLeaseAuthority;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
}

function leaseHolds(deps: SpawnAuthority): boolean {
  return verifyExecutionLeaseHeldFor(deps.lease.repository, deps.lease.evidence).code === 'HELD';
}

/**
 * An agent runner that refuses to start a process this run may not start.
 *
 * Always returns a runner, never `undefined`: a missing seam must not be the
 * one shape that reaches production unfenced.
 */
export function leasedAgent(deps: SpawnAuthority): AgentRunner {
  return async (id, args, cwd, payload) => {
    if (!leaseHolds(deps)) return AGENT_NOT_AUTHORISED;
    return (deps.agent ?? runAgentCommand)(id, args, cwd, payload);
  };
}

/** The same, for the verification seam. See {@link leasedAgent}. */
export function leasedVerify(deps: SpawnAuthority): VerificationRunner {
  return async (command, args, cwd) => {
    if (!leaseHolds(deps)) return VERIFICATION_NOT_AUTHORISED;
    return (deps.verify ?? runVerificationCommand)(command, args, cwd);
  };
}

/**
 * What a seam answers when this run is no longer the repository's writer.
 *
 * `UNAVAILABLE` is the vocabulary both seams already have for "the process
 * never started, and nothing it printed is evidence of anything". The step then
 * tries to record something and `advanceTaskState` refuses that too, so the run
 * stops with `EXECUTION_LEASE_LOST` and no durable trace.
 */
export const AGENT_NOT_AUTHORISED: AgentCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});

/** The verification seam's equivalent of {@link AGENT_NOT_AUTHORISED}. */
export const VERIFICATION_NOT_AUTHORISED: VerificationCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});
