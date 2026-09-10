/**
 * What a capability command's ending actually was — carried whole, instead of
 * collapsed into a code that asserts the wrong one of its causes.
 *
 * ── The defect this exists for ─────────────────────────────────────────────
 *
 * Two commands stand between an operator and a writing agent when a repository
 * requires an MCP capability: the operator's `prepare` command
 * (`repo/codegraph-index.ts`) and the session probe
 * (`agent/mcp-capability-preflight.ts`). Both used to read a `CommandResult` and
 * answer with one code covering every non-completion. The probe's said
 * `PROBE_DID_NOT_START`, and for a timeout that sentence is simply false: the
 * process started, ran for its whole budget and was killed.
 *
 * It was observed twice driving a real repository, on 2026-09-09 and
 * 2026-09-10, both times clearing on a retry with no configuration change.
 * Reproducing the probe by hand refuted the two obvious readings — cold and warm
 * runs both finished in about 3.5 s against a 20 s budget, and the probe emitted
 * 5189 bytes against a 1 MiB one — and then stopped, because **which** ending it
 * had is not recoverable from anything this build wrote down. That is the
 * defect: not the ending, but the loss of it.
 *
 * ── Two rules this module exists to keep ───────────────────────────────────
 *
 * **Nothing is renamed into a category.** `CommandOutcome` and
 * `CommandFailureCode` already enumerate every ending, so an observation
 * carries those values verbatim. This module invents no ending of its own, and
 * a seventh member of either union arrives here as itself rather than as
 * whichever bucket looked closest when this was written.
 *
 * **No stream text, anywhere.** An observation carries how many bytes each
 * stream produced and whether it was cut off — never a byte of what it said.
 * `doctor/capabilities.ts` and `doctor/report.ts` state the rule for this
 * repository, and the one seam that carries an excerpt
 * (`verify/verification-attempt.ts`) argues from a writing agent having no
 * shell. That argument does not hold on a path where an operator is at a
 * console, so the exemption is not borrowed. `containment` is left out for the
 * same reason it is optional there: it is an opaque artefact, and a record is
 * not its mint.
 *
 * ── Why the numbers are nullable ───────────────────────────────────────────
 *
 * Every count here is `number | null` rather than `number`. A `CommandResult`
 * this build did not itself produce — a hand-built stub, a fixture — can be
 * missing a field, and `JSON.stringify` **drops** an `undefined` value rather
 * than writing it. A record missing a key would then be indistinguishable from
 * a record whose key was never measured. An explicit `null` says "not measured"
 * out loud and survives the round trip.
 *
 * This module writes nothing, creates nothing and imports no writer. The store
 * beside it does that, and the split is what lets a reader of these types stay
 * free of a filesystem effect.
 */

import { join } from 'node:path';

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { orchestratorHome } from '../config/paths.js';
import type { CommandFailureCode, CommandOutcome, CommandResult } from '../doctor/exec.js';

/**
 * Which of the two capability commands an observation is about.
 *
 * Closed, and deliberately not a free-text label: it is written into a durable
 * record and read back by a person who was not there.
 */
export const CAPABILITY_COMMAND_SITES = ['MCP_CAPABILITY_PROBE', 'CODEGRAPH_PREPARE'] as const;

export type CapabilityCommandSite = (typeof CAPABILITY_COMMAND_SITES)[number];

/**
 * The budget a command was actually given, recorded beside what it did.
 *
 * Recorded rather than reconstructed, and that is the whole point of the field.
 * `20004 ms of 20000 ms` is readable by an operator who has never heard of
 * `DEFAULT_COMMAND_TIMEOUT_MS`; `20004 ms` alone asks them to go and find it,
 * and to trust that the constant has not moved since. The two hypotheses
 * refuted by hand on 2026-09-10 were exactly a duration against a budget and a
 * byte count against a budget.
 */
export interface CapabilityCommandBudget {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  /** Whether exceeding a stream's budget also terminated the child. */
  readonly terminateOnOutputLimit: boolean;
}

/** Everything about a command's ending that may be reported or stored. */
export interface CapabilityCommandObservation {
  /**
   * Whether the OS started the process at all.
   *
   * Carried separately from `outcome` because it answers a different question,
   * and because it is the one this build got wrong. `doctor/exec.ts` documents
   * that on the owned Windows path this is `false` only where the boundary
   * *proved* the target never ran — so `started === false` is a fact and not an
   * inference, and it is what makes "the process did not start" separately
   * identifiable at both sites.
   */
  readonly started: boolean;
  readonly outcome: CommandOutcome;
  /**
   * Strictly finer than `outcome`, and therefore not optional.
   *
   * `LAUNCH_NOT_ACCOUNTED` and `SPAWN_FAILED` both surface as outcome
   * `SPAWN_FAILED`; carrying the outcome alone is still lossy.
   */
  readonly failureCode: CommandFailureCode | null;
  /**
   * Allow-listed errno identifier, never a message.
   *
   * Always `null` on the owned Windows path — there is no errno there — so it
   * is recorded because it is free on POSIX, and never read as the answer.
   */
  readonly errnoCode: string | null;
  readonly signal: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly stdinDelivery: string | null;
  readonly stdoutBytesObserved: number | null;
  readonly stderrBytesObserved: number | null;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly budget: CapabilityCommandBudget;
}

/** A finite number, or `null` where the field was not measured. */
function measured(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A string, or `null`. Never an object stringified into one. */
function labelled(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Projects a `CommandResult` onto what may leave this boundary.
 *
 * An allow-list, not a redaction: the fields below are named one at a time, so
 * a field added to `CommandResult` later arrives here as nothing at all rather
 * than as a leak nobody reviewed. `stdout`, `stderr` and `containment` are
 * absent by construction and there is no branch that could include them.
 */
export function observeCapabilityCommand(
  result: CommandResult,
  budget: CapabilityCommandBudget,
): CapabilityCommandObservation {
  return Object.freeze({
    started: result.started === true,
    outcome: result.outcome,
    failureCode: result.failureCode ?? null,
    errnoCode: labelled(result.errnoCode),
    signal: labelled(result.signal),
    exitCode: measured(result.exitCode),
    durationMs: measured(result.durationMs),
    stdinDelivery: labelled(result.stdinDelivery),
    stdoutBytesObserved: measured(result.stdoutBytesObserved),
    stderrBytesObserved: measured(result.stderrBytesObserved),
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    budget: Object.freeze({ ...budget }),
  });
}

/** The durable record's own shape. One command ending, and where it happened. */
export interface CapabilityCommandFailureDocument {
  readonly recordVersion: 1;
  readonly site: CapabilityCommandSite;
  /** The refusal or provision code this ending produced. */
  readonly reason: string;
  readonly capability: string;
  readonly observedAt: string;
  readonly observation: CapabilityCommandObservation;
}

/**
 * Root of every capability-command failure record.
 *
 * Its own directory under the orchestrator home, and deliberately **not** a
 * name inside `diagnostics/`. `doctor/run-completion.ts` freezes the set of
 * artefact names a doctor run directory may hold and rejects any extra entry,
 * so a third file written into one would quietly make that run non-consumable.
 * Writing beside it rather than into it is the shipped move — the head
 * publication authorisation store does the same thing with the same two
 * helpers.
 *
 * **The repository is never written to on this path.** `run/lifecycle-driver.ts`
 * refuses a required-but-unproven capability *before* `startTask`, and states
 * in its own words that "refuses before it modifies anything" has to mean the
 * repository and not just the agent. A record under a repository root would
 * make that sentence false.
 */
export const CAPABILITY_COMMAND_FAILURES_DIR_NAME = 'capability-command-failures';

/** The one file inside a record directory. */
export const CAPABILITY_COMMAND_FAILURE_FILE_NAME = 'capability-command-failure.json';

/**
 * Byte ceiling for one record.
 *
 * Generous by a wide margin — a record is a few hundred bytes — and enforced
 * anyway, because a bound nobody can exceed is still the bound that stops an
 * unforeseen field from turning a diagnostic into a disk problem. Measured in
 * bytes rather than characters: `writeRunArtifact` takes a string and this is
 * what reaches the filesystem.
 */
export const MAX_CAPABILITY_COMMAND_FAILURE_BYTES = 65_536;

/** `<orchestrator home>/capability-command-failures`. */
export function capabilityCommandFailuresRoot(
  provider: PathProvider = OS_PATH_PROVIDER,
): string {
  return join(orchestratorHome(provider), CAPABILITY_COMMAND_FAILURES_DIR_NAME);
}
