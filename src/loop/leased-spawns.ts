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
 * *every* spawn site cannot be carried by counting names in source text, any
 * more than the Git-layout rule earlier in this slice could be carried by the
 * three layouts somebody had measured. So the property is now structural, and
 * the tests pin the structure rather than the spelling:
 *
 *  - **this module is the only place in `src/` that imports the raw runners.**
 *    `loop-step.ts` no longer can, so route 3 stops compiling as a quiet
 *    addition — it needs a new import, and the pin fails on it;
 *  - **`node:child_process` is reachable from exactly one module**
 *    (`doctor/exec.ts`), so route 2 fails the same way;
 *  - **the spawn helpers no longer default.** Their runner is a required
 *    argument, so route 1 is a compile error rather than a silent fallback.
 *
 * None of those three is a rule somebody has to remember. Each is a thing that
 * stops building, or a pin that goes red, when the shape changes.
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
