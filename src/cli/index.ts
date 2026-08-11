#!/usr/bin/env node
/**
 * `agent-loop` CLI entry point.
 *
 * This build contains the orchestration runtime as a library — task selection,
 * workspace lifecycle, durable state, reconciliation, the agent runners and
 * the verify/review/remediate loop — plus two read-only commands: `doctor`
 * and the planning mode of `run`. No command here starts an agent or writes
 * task state.
 */

import { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { registerDoctorCommand } from './doctor-command.js';
import { registerRunCommand } from './run-command.js';

const DESCRIPTION = [
  'Repository-agnostic orchestrator for a writing agent and a read-only reviewer.',
  '',
  'This build ships:',
  '  - the binding single-task state contract (schemas/task-state.schema.json)',
  '  - the read-only `doctor` diagnosis',
  '  - the read-only `run` plan: which task is next, what its durable state',
  '    permits, and on whose authority anything may continue',
  '',
  'The orchestration runtime (task selection, workspace lifecycle, durable',
  'state, reconciliation, verify/review/remediation loop, run driver) exists',
  'as a library. Executing it from the CLI is not implemented yet: no command',
  'here starts an agent, writes task state or prepares a workspace.',
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
