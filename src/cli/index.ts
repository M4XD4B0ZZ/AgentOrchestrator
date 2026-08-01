#!/usr/bin/env node
/**
 * `agent-loop` CLI entry point.
 *
 * This build contains the foundation only: the task-state contract and the
 * read-only `doctor` command. No orchestration loop exists yet, and no command
 * here invokes an agent.
 */

import { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { registerDoctorCommand } from './doctor-command.js';

const DESCRIPTION = [
  'Repository-agnostic orchestrator for a writing agent and a read-only reviewer.',
  '',
  'This build ships the foundation only:',
  '  - the binding single-task state contract (schemas/task-state.schema.json)',
  '  - the read-only `doctor` diagnosis',
  '',
  'The orchestration loop (task creation, worktrees, implement/verify/review',
  'rounds, resume handling) is NOT implemented yet and no command here starts',
  'an agent.',
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
