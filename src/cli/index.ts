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
import { registerBlockCommand } from './block-command.js';
import { registerDeliveryCommand } from './delivery-command.js';
import { registerDoctorCommand } from './doctor-command.js';
import { registerLeaseCommand } from './lease-command.js';
import { registerReleaseCommand } from './release-command.js';
import { registerRunCommand } from './run-command.js';
import { enforceSupportedRuntime } from './runtime-gate.js';

const DESCRIPTION = [
  'Repository-agnostic orchestrator for a writing agent and a read-only reviewer.',
  '',
  'This build ships:',
  '  - the binding single-task state contract (schemas/task-state.schema.json)',
  '  - the read-only `doctor` diagnosis',
  '  - the read-only `run` plan: which task is next, what its durable state',
  '    permits, and on whose authority anything may continue',
  '  - attended execution of one task: `run --attended`',
  '  - attended execution of a block of independent tasks: `block --attended`',
  '  - `release --attended`: hand back a workspace a crashed start left behind,',
  '    and only one proven to be that task’s own untouched leftovers',
  '  - the repository execution lease: read-only `lease status` to inspect it',
  '  - the read-only `delivery` report: which repository a finished task would',
  '    be delivered to, and which exact commit an observation would be about',
  '',
  'Two commands can reach a network, both opt-in, and nothing else can:',
  '  - the operator notification for a block run that needs a human: off unless',
  '    ~/.agent-orchestrator/notify.yaml exists, and never enabled by anything',
  '    inside a repository',
  '  - `delivery --observe`: a read-only question to github.com about one exact',
  '    commit. Without --observe the same command contacts nothing',
  '',
  'Execution requires three independent things, and none implies another:',
  '`--attended`, the operator stating they are present for this invocation; a',
  'fresh auth preflight that passes; and this repository’s execution lease, which',
  'makes at most one invocation its writer at a time. Without --attended, `run`',
  'still only reports: it starts no agent, writes no task state and prepares no',
  'workspace.',
  '',
  'A lease whose owner is gone is never taken over automatically: a dead owner',
  'does not prove that no agent process survived it. This build ships no command',
  'that removes a lease it did not create, and prints no procedure for doing it by',
  'hand: an attended break was shipped twice and withdrawn twice, because for a',
  'record left by a crash there is no fact an operator can be shown that still',
  'names the same object once the removal runs. Clearing one is a decision outside',
  'this tool.',
  '',
  'A block runs attended and sequentially: one lease for the whole run, one active',
  'task at a time, and a task that fails locally is recorded and does not end the',
  'run — provided the frozen plan establishes that the members are independent.',
  '',
  'A block may be dependent: a member whose predecessors have settled in this run',
  'is built on the last of their result commits, proved against Git at the moment',
  'it is used. The commit the block was frozen on still decides every member’s',
  'allowed scope, so a predecessor can hand its successor code and never',
  'permission. A member whose predecessors are not ordered relative to each other',
  'has no single commit to build on, and the whole block is refused.',
  '',
  'Unattended running and opening pull requests are not in this build.',
].join('\n');

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('agent-loop')
    .description(DESCRIPTION)
    .version('0.1.0', '-v, --version', 'Output the version number')
    .showHelpAfterError('(run `agent-loop --help` for usage)')
    .showSuggestionAfterError(true);

  // The V2 runtime gate. `preAction` runs after Commander has parsed, so
  // `--help` and `--version` — which Commander resolves during parse — are
  // still reachable on a machine this build refuses to run on. Refusing to
  // print help is not a safety property, and the operator who most needs the
  // help output is exactly the one whose runtime is unsupported.
  //
  // Whether this hook is inherited by nested subcommands (`lease status`) is a
  // property of Commander that is *measured* rather than assumed, by
  // tests/dist-artifact/runtime-gate-dist-artifact.mjs. If a future Commander
  // stops inheriting it, that harness fails on the nested case rather than this
  // gate quietly covering only the top level.
  program.hook('preAction', () => {
    enforceSupportedRuntime();
  });

  registerDoctorCommand(program);
  registerRunCommand(program);
  registerBlockCommand(program);
  registerReleaseCommand(program);
  registerLeaseCommand(program);
  registerDeliveryCommand(program);

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
