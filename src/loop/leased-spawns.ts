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
 *  - **and there is now a fourth Git mutation: the commit.** DOGFOOD-REM-001
 *    moved the commit from the writing agent to the orchestrator, so AO itself
 *    writes an object into the target repository's history. That belongs here
 *    rather than beside the other three, and it gets the *seam* treatment
 *    ({@link leasedGit}) rather than a pre-check, for one reason: a commit is
 *    the last thing a writing pass does, minutes of subprocess time after the
 *    step began, which is exactly the window in which a lease is lost. A gate
 *    proved at the top of the step and a commit written at the bottom of it are
 *    not the same claim;
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
import { isContainmentAttestation } from '../core/containment-attestation.js';
import type { AgentId } from '../core/states.js';
import {
  recordContainmentEvidence,
  verifyExecutionLeaseHeldFor,
  type ContainmentRecordResult,
  type ExecutionLeaseAuthority,
} from '../lease/execution-lease.js';
import { runGitCommand, type GitCommandResult, type GitRunner } from '../worktree/git-command.js';
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
  /**
   * The clock the containment record is stamped with. A test seam of the same
   * class as the lease's own `now`, and it can only ever produce a record this
   * build refuses: the recorder parses what it built back and requires its own
   * reading of it to be reliable before writing anything.
   *
   * Not called `now`: `LoopDependencies` already carries a `now` of its own, and
   * it is a `string` rather than a function. Every step's dependency object is
   * passed here whole, so a second `now` with a different type would make those
   * call sites stop compiling — which is how this name was chosen.
   */
  readonly containmentNow?: () => string;
}

/**
 * The agent whose containment is recorded against the lease.
 *
 * One value, named rather than derived. `claude` is the productive writer — the
 * process that produces effects in the repository — and it is the only one whose
 * containment says anything about whether a dead lease owner left a writer
 * behind. The reviewer is read-only, so recording its containment as this
 * lease's *writer* evidence would be a record that is simply not true.
 */
const CONTAINED_WRITER: AgentId = 'claude';

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
    const result = await (deps.agent ?? runAgentCommand)(id, args, cwd, payload);
    recordWriterContainment(deps, id, result);
    return result;
  };
}

/**
 * Records this run's containment evidence into the lease, if there is any.
 *
 * ── Why here, and why after the run ────────────────────────────────────────
 *
 * This is the one place that holds both halves at once: the lease authority,
 * which says whose lease it is, and the writer's result, which carries the
 * attestation. Neither layer below has the other — `doctor/exec.ts` must not
 * learn about leases, and `execution-lease.ts` must not learn about agents — so
 * threading the artefact up to the seam is what keeps the two vocabularies
 * apart.
 *
 * After the run rather than before it, because the attestation does not exist
 * until the boundary has ended and been classified. That leaves a real gap and
 * it is worth stating: a lease whose owner dies *during* the writer run carries
 * no evidence for that run. Conservative, and the correct direction — a later
 * recovery reading that lease finds `ABSENT` and must refuse, which is what it
 * would have to do anyway for a run it cannot see the end of.
 *
 * ── It cannot fail the run ─────────────────────────────────────────────────
 *
 * The result is deliberately discarded. Recording is an enrichment: a lease that
 * did not take the record is a lease with no containment proof, which is exactly
 * what the reader assumes by default. Turning a failed write into a failed agent
 * run would give an enrichment the power to stop productive work, which is the
 * wrong severity — and `recordContainmentEvidence` never throws, so there is
 * nothing here to catch.
 *
 * The lease is re-proved *inside* the recorder, against the bytes it opens, so a
 * run that lost its lease during the agent process writes nothing. This function
 * does not re-check it beforehand, on purpose: a check here and an effect there
 * would be two readings of one question, which is the defect this module's
 * neighbours keep finding.
 */
function recordWriterContainment(
  deps: SpawnAuthority,
  id: AgentId,
  result: AgentCommandResult,
): ContainmentRecordResult | null {
  if (id !== CONTAINED_WRITER) return null;
  // The registry gate, not `!== undefined`. A result carrying an explicit
  // `null`, or anything else a JS consumer or a JSON round trip can produce, is
  // not an attestation — and asking the mint is the same discipline
  // `doctor/exec.ts` applies one layer down, rather than a second, weaker test
  // of the same thing.
  if (!isContainmentAttestation(result.containment)) return null;
  return recordContainmentEvidence(deps.lease.repository, deps.lease.evidence, result.containment, {
    writerId: id,
    now: deps.containmentNow ?? (() => new Date().toISOString()),
  });
}

/**
 * A Git runner that refuses to touch the repository when this run is no longer
 * its writer.
 *
 * Handed to `commitTaskWork`, so the reads that decide *whether* to commit and
 * the commit itself are fenced by one authority: a run that has lost the lease
 * must not even ask, because the answer would be used to justify a write it may
 * not make.
 *
 * `UNAVAILABLE` is the seam's existing vocabulary for "no process ran, and
 * nothing it printed is evidence of anything". Every caller in the commit path
 * already treats that as a refusal, so a lost lease stops the commit with the
 * step that failed named, rather than being mistaken for a repository that had
 * nothing to record.
 */
export function leasedGit(deps: SpawnAuthority & { readonly git?: GitRunner }): GitRunner {
  return async (cwd, args) => {
    if (!leaseHolds(deps)) return GIT_NOT_AUTHORISED;
    return (deps.git ?? runGitCommand)(cwd, args);
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

/** The Git seam's equivalent of {@link AGENT_NOT_AUTHORISED}. */
export const GIT_NOT_AUTHORISED: GitCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
  exitCode: null,
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
