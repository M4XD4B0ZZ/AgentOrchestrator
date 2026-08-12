#!/usr/bin/env node
/**
 * `agent-loop` CLI entry point.
 *
 * This build contains the orchestration runtime as a library — task selection,
 * workspace lifecycle, durable state, reconciliation, the agent runners and
 * the verify/review/remediate loop — plus `doctor` and `run`.
 *
 * `doctor` is read-only, and so is `run` by default. Execution exists behind one
 * explicit grant, `run --attended`, which is the only way any command here
 * starts an agent, writes task state or prepares a workspace. See
 * `run-command.ts` for why the grant is a new flag rather than a new meaning for
 * an existing verb.
 */

import { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { registerDoctorCommand } from './doctor-command.js';
import { registerLeaseCommand } from './lease-command.js';
import { registerReleaseCommand } from './release-command.js';
import { registerRunCommand } from './run-command.js';

const DESCRIPTION = [
  'Repository-agnostic orchestrator for a writing agent and a read-only reviewer.',
  '',
  'This build ships:',
  '  - the binding single-task state contract (schemas/task-state.schema.json)',
  '  - the read-only `doctor` diagnosis',
  '  - the read-only `run` plan: which task is next, what its durable state',
  '    permits, and on whose authority anything may continue',
  '  - attended execution of one task: `run --attended`',
  '  - `release --attended`: hand back a workspace a crashed start left behind,',
  '    and only one proven to be that task’s own untouched leftovers',
  '  - the repository execution lease, and `lease status` / `lease break` to',
  '    inspect it and, where an operator decides so, clear a stale one',
  '',
  'Execution requires three independent things, and none implies another:',
  '`--attended`, the operator stating they are present for this invocation; a',
  'fresh auth preflight that passes; and this repository’s execution lease, which',
  'makes at most one invocation its writer at a time. Without --attended, `run`',
  'still only reports: it starts no agent, writes no task state and prepares no',
  'workspace.',
  '',
  'A lease whose owner is gone is never taken over automatically: a dead owner',
  'does not prove that no agent process survived it. Clearing one is an operator',
  'decision, made through `lease break --attended`.',
  '',
  'Unattended running, multi-task blocks and opening pull requests are not in',
  'this build.',
].join('\n');

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('agent-loop')
    .description(DESCRIPTION)
    .version('0.1.0', '-v, --version', 'Output the version number')
    .showHelpAfterError('(run `agent-loop --help` for usage)')
    .showSuggestionAfterError(true);

  registerDoctorCommand(program);
  registerRunCommand(program);
  registerReleaseCommand(program);
  registerLeaseCommand(program);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  // Commander exits non-zero with a readable message for unknown commands.
  await program.parseAsync(process.argv);
}

// The global handler never prints `error.message`. Exception texts routinely
// embed untrusted CLI output, file contents and full paths, and a top-level
// handler is exactly the place where all of them converge. Everything goes
// through the central safe formatter instead (AO-002).
main().catch((error: unknown) => {
  process.stderr.write(`agent-loop: ${formatSafeError(error)}\n`);
  process.exitCode = 1;
});
