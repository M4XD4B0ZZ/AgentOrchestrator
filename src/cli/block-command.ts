/**
 * `agent-loop block` — run a block of tasks, attended, possibly chained.
 *
 * ── Two modes, and the default is still read-only ──────────────────────────
 *
 * Without `--attended` this command *freezes and reports*: it resolves the
 * repository, reads the plan, projects the dependency relation, and prints what a
 * run would be started against — whether the members are established as
 * independent, and which member each dependent one would be built on. It starts
 * no agent, writes no ledger and prepares no workspace.
 *
 * ── What is frozen here, and why all of it is here ─────────────────────────
 *
 * Three things, at one instant and under one lease: the **plan**, the
 * **relation** projected from it, and the **block base** — the commit every root
 * member is built on and every member's scope is judged against. The base is
 * read here rather than inside the runner for the same reason the plan is: read
 * per task, a default branch that moved mid-run would give two roots two
 * different bases, and "the commit this block was frozen on" would stop having
 * one answer.
 *
 * The **chain shape** is checked here too, in both modes, and it is a refusal
 * about the *input*: a member whose required predecessors are not ordered
 * relative to each other has no single commit to be built on, and the whole
 * block is unsupported rather than that member being quietly skipped.
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
import {
  mcpPreflightFactory,
  type McpCapabilityOutcome,
} from '../agent/mcp-capability-preflight.js';
import type { RepositoryCapability } from '../repo/capabilities.js';
import { independenceIsEstablished } from '../block/block-conclusion.js';
import { projectBlockDependencies } from '../block/block-dependencies.js';
import { defineBlock } from '../block/block-definition.js';
import { runAttendedBlock, type AttendedBlockResult } from '../block/block-runner.js';
import { chainShapeOf, uniqueMaximumOf } from '../block/chain-shape.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import { formatSafeError } from '../core/safe-error.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  type LeaseAcquireSuccess,
  type LeaseReleaseResult,
} from '../lease/execution-lease.js';
import {
  createOperatorNotifier,
  notifyBlockRun,
  type OperatorNotifier,
} from '../notify/notification.js';
import { planNextTask } from '../plan/plan-next-task.js';
import { localBranchRef } from '../repo/branch-name.js';
import { resolveRepository, type ResolvedRepository } from '../repo/resolve-repository.js';
import { READ_ONLY_TRAILER } from '../run/render-run-plan.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import { runGitCommand } from '../worktree/git-command.js';
import { GIT_OBJECT_NAME_PATTERN } from '../worktree/prepare-workspace.js';
import {
  BLOCK_BASE_UNRESOLVED_SENTENCE,
  CHAIN_SHAPE_SENTENCE,
  renderBlockRun,
  renderNotificationResult,
  renderNotifierState,
} from './render-block-run.js';
import { line } from './render-attended-run.js';
import { renderLeaseRefusal, renderLeaseRelease } from './render-lease.js';
import { DEFAULT_MAX_STEPS, onceOnlyPreflight } from './run-command.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  exitCodeForBlockRun,
  exitCodeWithLeaseRelease,
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
  /**
   * The MCP capability proof, as a seam (M5).
   *
   * Production passes nothing and the real preflight starts a real `claude`.
   * A test supplies its own, because the alternative is a suite that spends
   * subscription quota to find out what it already arranged.
   */
  readonly mcpPreflight?: (
    required: readonly RepositoryCapability[],
  ) => Promise<McpCapabilityOutcome>;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
  /**
   * The operator notifier, normally built from the OS user's own configuration.
   *
   * Substitutable for the same reason the three above are: the real one reads a
   * file under the real user profile and posts to a real endpoint, and a test
   * that wanted to drive this command end to end had no way to avoid either.
   *
   * It grants nothing. A notifier is `ARMED` only because a configuration file
   * says so — `createOperatorNotifier` decides that from the file, not from its
   * arguments — so a test that wants an armed one writes a configuration into a
   * scratch profile and builds the real notifier over it. And nothing this seam
   * can be handed causes real egress: the transport it carries *is* the
   * substitute. That the shipped binary opens no socket without the file is
   * therefore not measured here at all, but against `dist` in a process with no
   * seams in it.
   */
  readonly notifier?: OperatorNotifier;
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

  const shape = chainShapeOf(defined.definition.dependencies);
  if (!shape.ok) {
    report([
      line('Repository', `${repository.id}  (${repository.root})`),
      line('Failure', `${shape.code} (${shape.taskId})`),
      `  ${CHAIN_SHAPE_SENTENCE}`,
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
        : 'A member depends on another member, so a task that fails locally ends the run rather\n' +
          '  than continuing past work its successor was to be built on. The dependent members\n' +
          '  are chained: see below.'
    }`,
    '',
    // Chain shape, printed beside independence rather than folded into it: they
    // are different questions, and the answers are independent. An independent
    // block trivially has a shape, and a dependent one may or may not.
    line('Chain shape', 'every member has a base'),
    ...defined.definition.dependencies.flatMap((row) => {
      const maximum = uniqueMaximumOf(defined.definition.dependencies, row.taskId);
      if (!maximum.ok || maximum.maximum === null) return [];
      return [`  ${row.taskId.padEnd(12)} would be built on the result of ${maximum.maximum}`];
    }),
    '',
    // Stated where an operator can see it, because eligibility, independence and
    // chain shape are three different questions and a member with an empty row
    // can still be waiting on a task outside the block.
    'Eligibility is the repository selector\'s answer, asked live; independence and chain',
    'shape are the frozen relation\'s. A member independent of every other member may still',
    'be waiting on a task this block does not hold, and a block whose only path to',
    'eligibility runs outside it ends NO_ELIGIBLE_TASK.',
    '',
    READ_ONLY_TRAILER,
  ]);
  return EXIT_RUN_OK;
}

/**
 * Everything `block --attended` does while it is the repository's writer.
 *
 * Extracted from the command's `try` for one reason, and it is not tidiness: a
 * `return` inside a `try` runs the `finally` and then leaves the *function*, so
 * while the five refusals below lived there, nothing could run after the lease
 * was given back — for those five paths there was no code left to hand a release
 * result to. (The success path had somewhere to put one all along: the
 * notification block sits after the `finally`. It threw the result away anyway,
 * which is the part that was an oversight rather than a shape.) Here every path
 * ends in a value, the caller releases, and the caller still has both facts in
 * its hands.
 *
 * It reports the block run itself, including its own exit code, and does
 * nothing about the lease it is running under - it is handed the evidence and
 * passes it on, and that is all. Giving the lease back is the
 * caller's job, on every path, and a function that could both refuse and release
 * would be a second place for that to be forgotten.
 */
async function runBlockUnderLease(
  repository: ResolvedRepository,
  options: BlockOptions,
  maxSteps: number,
  lease: LeaseAcquireSuccess['evidence'],
  seams: BlockCommandSeams,
): Promise<{ readonly exitCode: CliExitCode; readonly outcome: AttendedBlockResult | null }> {
  // Everything below is under the lease, including the input refusals. A
  // plan frozen before this line could be edited by a legitimate writer
  // between the reading and the acquisition, and this invocation would
  // then run a block frozen on a roadmap it was never the writer of.
  const planned = planNextTask(repository);
  if (!planned.ok) {
    report([line('Failure', `${planned.code} - ${planned.detail}`)]);
    return { exitCode: EXIT_RUN_INPUT_UNUSABLE, outcome: null };
  }

  const projected = projectBlockDependencies(planned.graph, options.tasks);
  if (!projected.ok) {
    report([line('Failure', `${projected.code} - ${projected.taskId}`)]);
    return { exitCode: EXIT_RUN_INPUT_UNUSABLE, outcome: null };
  }

  const defined = defineBlock(options.block, options.tasks, projected.dependencies);
  if (!defined.ok) {
    report([line('Failure', defined.code)]);
    return { exitCode: EXIT_RUN_INPUT_UNUSABLE, outcome: null };
  }

  // Whether every member has a base to be built on, asked before the run
  // opens. A member with two unordered predecessors cannot be given one,
  // and refusing the *whole block* here rather than skipping that member
  // later is the difference between unsupported input and a run that
  // improvised an ordering.
  const shape = chainShapeOf(defined.definition.dependencies);
  if (!shape.ok) {
    report([line('Failure', `${shape.code} (${shape.taskId})`), `  ${CHAIN_SHAPE_SENTENCE}`]);
    return { exitCode: EXIT_RUN_INPUT_UNUSABLE, outcome: null };
  }

  // The block base, read once, under the lease, from the same instant as
  // the plan. Not re-read per task: a default branch that moves mid-run
  // would otherwise give two roots two different bases, and "the commit
  // this block was frozen on" would stop having one answer — which is
  // exactly what the chain's ancestry proof and the scope authority both
  // rest on.
  const base = await runGitCommand(repository.root, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    localBranchRef(repository.defaultBranch),
  ]);
  if (base.outcome !== 'OK' || !GIT_OBJECT_NAME_PATTERN.test(base.stdout)) {
    report([line('Failure', 'BLOCK_BASE_UNRESOLVED'), `  ${BLOCK_BASE_UNRESOLVED_SENTENCE}`]);
    return { exitCode: EXIT_RUN_REFUSED, outcome: null };
  }

  const outcome = await runAttendedBlock(
    {
      repository,
      definition: defined.definition,
      runId: options.run,
      lease,
      maxStepsPerTask: maxSteps,
      // The same `planned` the projection came from - handed on whole, so
      // the frozen relation, the eligibility filter and every task's
      // start gate are one reading of the roadmap at one instant, taken
      // under this lease.
      planning: planned,
      blockBaseCommit: base.stdout,
    },
    {
      now: () => new Date().toISOString(),
      git: runGitCommand,
      authPreflight: onceOnlyPreflight(seams.authPreflight),
      // One factory for this block run. The repository is fixed here, so the
      // factory is applied at once and the memo it returns covers every task.
      mcpPreflight: mcpPreflightFactory(process.env, seams.mcpPreflight)(repository.capabilities),
      ...(seams.agent !== undefined ? { agent: seams.agent } : {}),
      ...(seams.verify !== undefined ? { verify: seams.verify } : {}),
    },
  );
  process.stdout.write(renderBlockRun(repository, outcome));
  return { exitCode: exitCodeForBlockRun(outcome), outcome };
}

export function registerBlockCommand(program: Command, seams: BlockCommandSeams = {}): void {
  program
    .command('block')
    .description(
      'Run a block of tasks, attended and sequentially, under one execution lease. ' +
        'Freezes the dependency relation and the base commit from one reading of the roadmap ' +
        'and records each task outcome against the task\'s own durable state. A member whose ' +
        'predecessors settle in this run is built on the last of their result commits; the ' +
        'block base still decides every member\'s allowed scope. ' +
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
      // Declared above the `try` so the `catch` can still see it. A thrown
      // operation and a lease that did not come back are two separate facts, and
      // an operator handed only the safe error text would be told the first and
      // left to discover the second from the next run's refusal.
      let leaseRelease: LeaseReleaseResult | null = null;
      let leaseReleaseAttempted = false;
      let leaseReleaseReported = false;

      /**
       * Print the release report, at most once, and only once one is owed.
       *
       * Two flags rather than a null check, because `null` has two meanings here
       * and only one of them is reportable: no lease was ever taken - every
       * refusal above the lease line - versus a release that was attempted and
       * threw instead of answering. The first must print nothing, because a
       * report about an authority this invocation never held is a fiction; the
       * second must print, because it is the one case where a record is provably
       * still in the repository.
       *
       * `leaseReleaseAttempted` is set *before* the call for that reason: it
       * records the attempt, not the answer. `leaseReleaseReported` is set
       * *after* the write, so a write that failed can still be retried from the
       * `catch` rather than being marked delivered.
       */
      const reportLeaseRelease = (): void => {
        if (!leaseReleaseAttempted || leaseReleaseReported) return;
        process.stdout.write(renderLeaseRelease('Release', leaseRelease));
        leaseReleaseReported = true;
      };

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

        // Whether this machine reports its endings, decided here: above the
        // lease line, because reading the operator's own configuration file is
        // no more a reason to become the repository's writer than parsing an
        // argument is — and *before* the run, because the alternative is an
        // operator learning that their notification is misconfigured from the
        // message that never arrives. It cannot refuse the run: a notifier with
        // authority over whether work happens is the one thing this may not be.
        const notifier = seams.notifier ?? createOperatorNotifier();
        process.stdout.write(renderNotifierState(notifier));

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

        // Held outside the `try` so the notification can be sent after the lease
        // has been given back. `null` means no run happened — every refusal
        // inside `runBlockUnderLease` produces no result, and there is nothing to
        // report about a run that never opened.
        let outcome: AttendedBlockResult | null = null;

        // What the block itself came to, kept apart from what the release came
        // to. The initial value is never observed - a throw from the call below
        // skips the one statement that reads it - so it is the unexpected code for
        // the reason a floor is chosen rather than for a consequence it has: if
        // an edit ever does make it reachable, "nothing went wrong" is the wrong
        // thing for this command to volunteer about a path that never returned.
        let primary: CliExitCode = EXIT_RUN_UNEXPECTED;

        try {
          const under = await runBlockUnderLease(
            repository,
            options,
            maxSteps,
            acquired.evidence,
            seams,
          );
          outcome = under.outcome;
          primary = under.exitCode;
        } finally {
          // Released on every path out, including a throw and including the five
          // refusals inside - four about the input, one about the repository's own
          // base commit. The lease is taken once for the whole block
          // run and given back once - never per task, which would leave a window
          // between tasks that a second writer fits into perfectly.
          //
          // The result is now kept. Until V3-07 this call stood here as a bare
          // expression: the lease could come back quarantined, displaced or not
          // at all, and the command reported the block's own verdict and exited
          // on it as though the repository had been handed back cleanly.
          //
          // Wrapped, because a `finally` that throws **replaces** the exception
          // that entered it - so an exception here would hand the operator the
          // release's failure in place of the one that actually stopped the run.
          // `releaseRepositoryExecutionLease` refuses rather than throws for every
          // value that is not evidence, which
          // `tests/v3-07-lease-release-observability.test.ts` pins - and that is
          // a narrower claim than "for the value this command passes". It is not
          // unreachable, though: `tests/v3-07-lease-release-fault.test.ts` gets
          // in through the one call on that path that is neither a filesystem
          // call nor inside a `try` - the `randomBytes` naming the quarantine
          // file - and drives this arm with production unedited. Leaving
          // `leaseRelease` null keeps the outcome closed: nothing is reported as
          // released, and the exit code below cannot be nominal.
          try {
            leaseReleaseAttempted = true;
            leaseRelease = releaseRepositoryExecutionLease(acquired.evidence);
          } catch (releaseError: unknown) {
            // Guarded in turn. This whole `try` exists so that a throw here
            // cannot replace the exception that entered the `finally`, and a
            // bare write to a stream that is itself refusing would reintroduce
            // exactly that. There is nothing left to report it to.
            try {
              process.stderr.write(
                `agent-loop block: giving the execution lease back failed. ${formatSafeError(releaseError)}\n`,
              );
            } catch {
              // Nothing can be said, and saying it is not worth the exception.
            }
          }
        }

        // The exit code first, because nothing after it should be able to
        // decide it. Note what this does *not* buy: if the write below throws,
        // the `catch` overwrites this with 1 regardless - it assigns
        // unconditionally. The ordering keeps the code independent of a console
        // write on the ordinary path, and the "never nominal" invariant holds
        // either way, since 1 is not 0.
        process.exitCode = exitCodeWithLeaseRelease(primary, leaseRelease);
        reportLeaseRelease();

        // After the lease, deliberately. A notification is not a repository
        // effect and needs no authority over one, and holding the repository's
        // only writer slot open across a network round trip would make a second
        // operator wait on somebody else's push.
        //
        // Also after the report and after the exit code: the console is the
        // truth that is always available, and `notifyBlockRun` is total, so
        // nothing here can reach the `catch` below and relabel a finished run as
        // an internal failure. Only the repository's *declared id* is handed
        // over; its root stays here.
        if (outcome !== null) {
          const notified = await notifyBlockRun(notifier, repository.id, outcome);
          process.stdout.write(renderNotificationResult(notified));
        }
      } catch (error: unknown) {
        // An unexpected failure must not print an exception message: those
        // routinely quote CLI output and filesystem paths (AO-002). Fail closed
        // through the central safe formatter.
        process.stderr.write(`agent-loop block: ${formatSafeError(error)}\n`);
        // The original failure keeps the exit code, and this path **diverges**
        // from `exitCodeWithLeaseRelease` deliberately rather than agreeing with
        // it. That function would answer 3 here, because the lease did not
        // provably come back; it is not called, because a thrown operation
        // produced no primary code to combine with and because 1 is the only
        // code that says "this build failed in a way it did not plan for". The
        // stuck lease is not hidden by that choice: the release line is printed
        // below on the same console. If this hardcode is ever replaced by a call
        // to that function, the exit code changes from 1 to 3 - which is a
        // decision about what an operator is told, not a simplification.
        process.exitCode = EXIT_RUN_UNEXPECTED;
        // The release last, and after the exit code is set. On a throw under the
        // lease the release still happened, and its result is the more
        // actionable of the two facts - but nothing the primary failure needs
        // may sit behind it.
        // Guarded, like its sibling inside the `finally`. This is the retry for a
        // report whose first write failed, so the stream it writes to is the one
        // that has already refused once; an exception here would escape the
        // action, reject `parseAsync`, and hand Node the raw error to print -
        // undoing the safe-error discipline two lines above it.
        try {
          reportLeaseRelease();
        } catch {
          // The console is gone. The exit code above is the whole report now.
        }
      }
    });
}
