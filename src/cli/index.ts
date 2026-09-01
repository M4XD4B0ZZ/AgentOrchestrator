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
import { registerPublicationCommand } from './publication-command.js';
import { registerReleaseCommand } from './release-command.js';
import { registerRepositoriesCommand } from './repositories-command.js';
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
  '  - the repository execution lease: read-only `lease status` to inspect it,',
  '    and `lease recover` to remove one this build can prove is dead — the owner',
  '    gone, and every subprocess it started accounted for',
  '  - the `delivery` report: which repository a finished task would be delivered',
  '    to, and which exact commit an observation would be about. Local and',
  '    read-only unless asked otherwise: `--observe` asks github.com, `--record`',
  '    stores that answer beside the task as a historical record, and',
  '    `--publish-head` with a grant creates the task’s branch on the delivery',
  '    remote at its pinned commit, create-only. Three flags can change',
  '    something outside this machine, and each needs its own flag AND a grant',
  '    that names that act: `--publish-head`, `--create-pr` and `--merge-pr`.',
  '    `--attended` is a grant for all three; `--automatic-publish-head-only`',
  '    is a second one, for the publication alone, and only where this',
  '    machine’s operator declared that repository publishable that way',
  '  - `repositories`: the read-only listing of the repositories this machine’s',
  '    operator has enlisted for orchestration, and which single task is next',
  '    across all of them. It reads one file under this OS user’s profile, takes',
  '    no `--repository`, and acts on nothing — no execution lease, no agent, no',
  '    workspace, no task state, no remote. It is the only command that reasons',
  '    over more than one repository',
  '  - `publication authorisations`: the read-only listing of what this build',
  '    recorded it was permitted to attempt with nobody present. It reads one',
  '    directory under this OS user’s profile, opens no repository and starts no',
  '    program; a record in it is evidence for a person and never an input to an',
  '    authority. `--forge-host`, `--forge-owner`, `--forge-name` and `--ref`',
  '    together show only the records naming that one branch — anything this',
  '    build could not read in full is shown either way — and it is a filter and',
  '    not an index: every entry is still read to answer it',
  '',
  'Network access, stated in full. Exactly one request is made by this process',
  'itself, and it is opt-in:',
  '  - the operator notification for a block run that needs a human: off unless',
  '    ~/.agent-orchestrator/notify.yaml exists, and never enabled by anything',
  '    inside a repository',
  '',
  'Every other request this build is answerable for is made by a program it',
  'starts. That still counts as network access here, under the same rule the',
  'delivery residual L-V4-02-6 applies to the GitHub CLI — a spawned client’s',
  'traffic is the command’s traffic:',
  '  - `delivery --observe` starts the GitHub CLI, which asks github.com two',
  '    read-only questions about one exact commit. That client also makes calls',
  '    of its own — telemetry, and a periodic update check — which this build',
  '    does not suppress',
  '  - `delivery --publish-head`, under either of its grants, contacts the',
  '    delivery remote up to',
  '    three times, and this counts only that: one Git child reads the ref, one',
  '    creates it at one commit if it was absent, and one reads it back. The last',
  '    runs whatever the push reported and is the one that decides the answer.',
  '    Every other Git child this command starts — resolving the repository,',
  '    reading the remote’s URLs, re-reading the task — is local and contacts',
  '    nothing, and they are not counted here because a total that mixed the two',
  '    would be a number nobody could check. Git authenticates with the',
  '    credential helper the machine already has; no token is read, carried or',
  '    written by this build. This is the only request any command here makes',
  '    that can change anything',
  '  - `doctor` starts the agent CLIs to read their login state',
  '  - `run --attended`, `run --automatic-resume-only` and `block --attended`',
  '    start the agent CLIs, and run whatever verification commands the',
  '    repository’s own profile declares',
  '',
  'Given none of the flags named above, the `delivery` command starts no client',
  'and contacts no forge.',
  '',
  'What those programs contact is their own affair. This build neither bounds it',
  'nor reports it.',
  '',
  'Execution requires three independent things, and none implies another: a',
  'grant on the command line — `--attended`, the operator stating they are',
  'present for this invocation, or `--automatic-resume-only`, stating that nobody',
  'is; a fresh auth preflight that passes; and this repository’s execution lease,',
  'which makes at most one invocation its writer at a time. Given neither grant,',
  '`run` only reports: it starts no agent, writes no task state and prepares no',
  'workspace.',
  '',
  'A lease whose owner is gone is never taken over automatically: a dead owner',
  'does not prove that no process it started survived it. It is removed only where',
  'that is proved, and only by an operator asking for it now — `lease recover`,',
  'or `run --recover-stale-lease` before acquiring. Both require three things: the',
  'owner process is gone; every writer launch under the lease is proved to have run',
  'inside a process job coupled to that owner; and every other subprocess the run',
  'started through that same boundary — the verification commands, the reviewer,',
  'the Git commands — is either recorded as finished or has the processes it',
  'recorded checked and found gone. Anything unproved, unreadable or written by an',
  'older build is refused, and there is no override.',
  '',
  'What is not shipped is a break — removing a lease that cannot be proved dead.',
  'It was shipped twice and withdrawn twice, because for a record left by a crash',
  'there is no fact an operator can be shown that still names the same object once',
  'the removal runs. The consequence is stated rather than enumerated, because it',
  'is a rule and not a list: a lease this build cannot prove dead stays outside',
  'this tool for good. That includes one written by an older build and one whose',
  'launch history was never published. `lease status` still reports whatever owner',
  'it can read from such a lease, and whether that process is alive, so there is',
  'someone to ask.',
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
  'Deciding that a merge is WARRANTED is not in this build. Performing one is,',
  'and only when the invocation names the act and a grant for it: `--publish-head`,',
  '`--create-pr` and `--merge-pr`, each authorised separately, and at most one',
  'attempted per invocation. `--drive` works out',
  'which of them a delivery still needs and `--select-task` works out which',
  'delivery; neither adds an act and neither grants one. Unattended running is',
  'in this build, narrowly, and it is two separate things.',
  '',
  '`run --automatic-resume-only` continues ONE named task with nobody present,',
  'and only where the resume decision answers AUTOMATIC_ALLOWED. It cannot start',
  'a task, cannot pick up in-flight work it did not itself resume, cannot recover',
  'a stale lease, and nothing schedules it.',
  '',
  '`delivery --drive --publish-head --automatic-publish-head-only` creates ONE',
  'work branch on a delivery remote with nobody present, and only where this',
  'machine’s operator has declared that repository publishable that way in',
  '<user profile>/.agent-orchestrator/delivery-automation.yaml. The declaration is',
  'outside every repository, so nothing being delivered can write it, and it',
  'permits that one act: there is no unattended pull request and no unattended',
  'merge, `--create-pr` and `--merge-pr` are refused alongside it, and nothing',
  'schedules it either.',
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
  registerPublicationCommand(program);
  registerRepositoriesCommand(program);

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
