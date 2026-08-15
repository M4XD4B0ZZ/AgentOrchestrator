/**
 * `agent-loop block` — run a block of independent tasks, attended.
 *
 * ── Two modes, and the default is still read-only ──────────────────────────
 *
 * Without `--attended` this command *freezes and reports*: it resolves the
 * repository, reads the plan, projects the dependency relation, and prints what a
 * run would be started against — including whether the members are established as
 * independent, which is the property the whole slice turns on. It starts no
 * agent, writes no ledger and prepares no workspace.
 *
 * ── Where the plan is frozen, and why it is here ───────────────────────────
 *
 * This is the one place `projectBlockDependencies` is called, and the one place
 * `planNextTask` is called for a block run. `block-runner.ts` computes neither —
 * see its module header — so freezing is the caller's job, and doing it here
 * means the roadmap is read once and everything downstream consults that
 * reading: the projection, the definition's fingerprint, the eligibility filter,
 * and each task's own start gate.
 *
 * ── The order, and why the lease comes first ───────────────────────────────
 *
 *   attended:  resolve -> **lease** -> plan -> project -> define -> run -> release
 *   default:   resolve -> plan -> project -> define -> report   (no lease, no writes)
 *
 * An earlier draft froze the plan before taking the lease, which left a window
 * in which a legitimate other writer could edit the roadmap between the reading
 * the block was frozen from and the moment this invocation became the writer —
 * a frozen plan that was never authoritative. `run-command.ts:205` already takes
 * the lease before it selects a task, for the same reason.
 *
 * The cost is that an unusable `--tasks` argument — a member the repository does
 * not declare — is now refused while the lease is held, for the few milliseconds
 * it takes to plan and project. Accepted: `finally` gives the lease back on
 * every path including a throw, and the alternative is freezing a plan on
 * authority this invocation did not yet have. Argument checks that need no
 * repository at all still happen above the lease line.
 *
 * Without `--attended` nothing is taken at all. The report is a report; a
 * command that wrote nothing and drove nothing has no claim on the repository's
 * turn as writer, and the snapshot it prints authorises nothing.
 */

import type { Command } from 'commander';

import type { AgentRunner } from '../agent/agent-command.js';
import { independenceIsEstablished } from '../block/block-conclusion.js';
import { projectBlockDependencies } from '../block/block-dependencies.js';
import { defineBlock } from '../block/block-definition.js';
import { runAttendedBlock } from '../block/block-runner.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import { formatSafeError } from '../core/safe-error.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
} from '../lease/execution-lease.js';
import { planNextTask } from '../plan/plan-next-task.js';
import { resolveRepository, type ResolvedRepository } from '../repo/resolve-repository.js';
import { READ_ONLY_TRAILER } from '../run/render-run-plan.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import { runGitCommand } from '../worktree/git-command.js';
import { renderBlockRun } from './render-block-run.js';
import { line } from './render-attended-run.js';
import { renderLeaseRefusal } from './render-lease.js';
import { DEFAULT_MAX_STEPS, onceOnlyPreflight } from './run-command.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  exitCodeForBlockRun,
  type CliExitCode,
} from './run-exit-codes.js';

interface BlockOptions {
  readonly repository: string;
  readonly block: string;
  readonly tasks: readonly string[];
  readonly run: string;
  readonly attended?: boolean;
  readonly maxSteps?: string;
}

/**
 * The execution seams of the attended path. All optional; all default to the
 * real thing.
 *
 * The same three `RunCommandSeams` exposes, and for the same reason: the real
 * ones start subscription CLIs and a real `npm run verify`, so a test that
 * wanted to drive this command end to end had no way to do it. Git, the clock,
 * the state store, the planner and the repository resolver stay hardwired — a
 * test that could substitute those could make the command agree with a
 * repository that does not exist. And no seam here grants anything:
 * {@link authPreflight} returns evidence, which only the real preflight can mint.
 */
export interface BlockCommandSeams {
  readonly authPreflight?: () => Promise<AuthPreflightEvidence | null>;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
}

/** The one report shape both modes' refusals use. */
function report(lines: readonly string[]): void {
  process.stdout.write(`\n${lines.join('\n')}\n\n`);
}

/**
 * A frozen plan, printed — and kept by nobody.
 *
 * The read-only half, factored out so the two modes cannot share a planning read
 * by accident: it plans, projects, defines and prints, and the value it prints
 * never reaches `runAttendedBlock`. Two readings in one invocation would be one
 * reading too many, and the way to make that impossible is for the read-only
 * path to keep nothing.
 *
 * It takes no lease. What it prints is a description of what a run *would* be
 * started against; the run that starts takes its own reading under its own lease.
 */
function reportFrozenPlan(repository: ResolvedRepository, options: BlockOptions): CliExitCode {
  const planned = planNextTask(repository);
  if (!planned.ok) {
    report([
      line('Repository', `${repository.id}  (${repository.root})`),
      line('Failure', `${planned.code} - ${planned.detail}`),
      '',
      READ_ONLY_TRAILER,
    ]);
    return EXIT_RUN_INPUT_UNUSABLE;
  }

  const projected = projectBlockDependencies(planned.graph, options.tasks);
  if (!projected.ok) {
    report([
      line('Repository', `${repository.id}  (${repository.root})`),
      line('Failure', `${projected.code} - ${projected.taskId}`),
      '',
      READ_ONLY_TRAILER,
    ]);
    return EXIT_RUN_INPUT_UNUSABLE;
  }

  const defined = defineBlock(options.block, options.tasks, projected.dependencies);
  if (!defined.ok) {
    report([
      line('Repository', `${repository.id}  (${repository.root})`),
      line('Failure', defined.code),
      '',
      READ_ONLY_TRAILER,
    ]);
    return EXIT_RUN_INPUT_UNUSABLE;
  }

  const independent = independenceIsEstablished(defined.definition.dependencies);
  const eligible = new Set(
    planned.selection.eligibility.filter((entry) => entry.eligible).map((entry) => entry.taskId),
  );

  report([
    line('Repository', `${repository.id}  (${repository.root})`),
    line('Block', `${defined.definition.blockId}   run ${options.run}`),
    line('Mode', 'report only - --attended was not given'),
    '',
    'Members',
    ...defined.definition.dependencies.map(
      (row) =>
        `  ${row.taskId.padEnd(12)} ${(eligible.has(row.taskId) ? 'eligible' : 'not eligible').padEnd(13)} ` +
        `depends on ${row.dependsOn.length === 0 ? 'no member' : row.dependsOn.join(', ')}`,
    ),
    '',
    line('Independent', independent ? 'yes' : 'no'),
    `  ${
      independent
        ? 'The frozen plan establishes that no member depends on another, so a task that fails\n' +
          '  locally would end that task and not the run.'
        : 'A member depends on another member, so this is not supported input for an attended\n' +
          '  block run: it would stop at the first task-local failure rather than improvise an\n' +
          '  ordering. Dependent execution is V2-09.'
    }`,
    '',
    // Stated where an operator can see it, because eligibility and independence
    // are two different questions and a member with an empty row can still be
    // waiting on a task outside the block.
    'Eligibility is the repository selector\'s answer, asked live; independence is the frozen',
    'relation\'s. A member independent of every other member may still be waiting on a task',
    'this block does not hold, and a block with nothing eligible ends NO_ELIGIBLE_TASK.',
    '',
    READ_ONLY_TRAILER,
  ]);
  return EXIT_RUN_OK;
}

export function registerBlockCommand(program: Command, seams: BlockCommandSeams = {}): void {
  program
    .command('block')
    .description(
      'Run a block of independent tasks, attended and sequentially, under one execution ' +
        'lease. Freezes the dependency relation from one reading of the roadmap and records ' +
        'each task outcome against the task\'s own durable state. ' +
        'Read-only by default: starts no agent, writes no ledger, takes no lease. ' +
        'Pass --attended to execute instead.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .requiredOption('--block <id>', 'Identity of the block. Follows the canonical task-id grammar.')
    .requiredOption('--tasks <ids...>', 'The block members, in the order they should be attempted.')
    .requiredOption(
      '--run <id>',
      'Identity of this run, distinct from the block. Required and never generated: a run id ' +
        'the tool invented would be a run an operator cannot name back.',
    )
    .option(
      '--attended',
      'Execute: drive each member in turn, writing a ledger and task state and starting ' +
        'agents. States that an operator is present for this invocation. Not a claim about ' +
        'credentials - a fresh auth preflight must pass independently.',
    )
    .option(
      '--max-steps <n>',
      `Bound on durable steps for one task's driver call (default ${String(DEFAULT_MAX_STEPS)}).`,
    )
    .action(async (options: BlockOptions) => {
      try {
        const resolution = await resolveRepository({ repositoryPath: options.repository });
        if (!resolution.ok) {
          // A resolution failure is the answer, not an accident: a closed code
          // plus a static sentence, exactly as the resolver produced them.
          report([
            'Repository   : could not be resolved',
            line('Failure', `${resolution.code} - ${resolution.detail}`),
            '',
            READ_ONLY_TRAILER,
          ]);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        const repository = resolution.repository;

        // The read-only mode. It takes no lease, so it freezes nothing that
        // authorises anything - the plan it prints is a description of what a run
        // *would* be started against, and the run that starts takes its own
        // reading under its own lease.
        if (options.attended !== true) {
          process.exitCode = reportFrozenPlan(repository, options);
          return;
        }

        // Above the lease line, because it needs no repository: parsing an
        // argument is not a reason to become the repository's writer. Parsed
        // here rather than by commander so that a bad value is refused with this
        // command's own vocabulary rather than a parser's message.
        const maxSteps =
          options.maxSteps === undefined ? DEFAULT_MAX_STEPS : Number(options.maxSteps);
        if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
          report([
            'Failure      : MAX_STEPS_INVALID - --max-steps must be a positive whole number.',
            '',
            READ_ONLY_TRAILER,
          ]);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        const acquired = acquireRepositoryExecutionLease(
          repository,
          { runId: options.run, blockId: options.block },
          { now: () => new Date().toISOString() },
        );
        if (!acquired.ok) {
          process.stdout.write(renderLeaseRefusal(acquired.code));
          process.exitCode = EXIT_RUN_REFUSED;
          return;
        }

        try {
          // Everything below is under the lease, including the input refusals. A
          // plan frozen before this line could be edited by a legitimate writer
          // between the reading and the acquisition, and this invocation would
          // then run a block frozen on a roadmap it was never the writer of.
          const planned = planNextTask(repository);
          if (!planned.ok) {
            report([line('Failure', `${planned.code} - ${planned.detail}`)]);
            process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
            return;
          }

          const projected = projectBlockDependencies(planned.graph, options.tasks);
          if (!projected.ok) {
            report([line('Failure', `${projected.code} - ${projected.taskId}`)]);
            process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
            return;
          }

          const defined = defineBlock(options.block, options.tasks, projected.dependencies);
          if (!defined.ok) {
            report([line('Failure', defined.code)]);
            process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
            return;
          }

          const result = await runAttendedBlock(
            {
              repository,
              definition: defined.definition,
              runId: options.run,
              lease: acquired.evidence,
              maxStepsPerTask: maxSteps,
              // The same `planned` the projection came from - handed on whole, so
              // the frozen relation, the eligibility filter and every task's
              // start gate are one reading of the roadmap at one instant, taken
              // under this lease.
              planning: planned,
            },
            {
              now: () => new Date().toISOString(),
              git: runGitCommand,
              authPreflight: onceOnlyPreflight(seams.authPreflight),
              ...(seams.agent !== undefined ? { agent: seams.agent } : {}),
              ...(seams.verify !== undefined ? { verify: seams.verify } : {}),
            },
          );
          process.stdout.write(renderBlockRun(repository, result));
          process.exitCode = exitCodeForBlockRun(result);
        } finally {
          // Released on every path out, including a throw and including the
          // input refusals above. The lease is taken once for the whole block
          // run and given back once - never per task, which would leave a window
          // between tasks that a second writer fits into perfectly.
          releaseRepositoryExecutionLease(acquired.evidence);
        }
      } catch (error: unknown) {
        // An unexpected failure must not print an exception message: those
        // routinely quote CLI output and filesystem paths (AO-002). Fail closed
        // through the central safe formatter.
        process.stderr.write(`agent-loop block: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
