import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { renderRunPlan } from '../run/render-run-plan.js';
import { planRun } from '../run/run-plan.js';
import { runGitCommand } from '../worktree/git-command.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_UNEXPECTED,
  exitCodeForPlan,
} from './run-exit-codes.js';

/**
 * `agent-loop run` — the read-only front door.
 *
 * In this build the command only *plans*: it resolves the repository, asks the
 * repository's own selector which task is next, loads and reconciles that
 * task's durable state, and reports what may continue and on whose authority.
 * It starts no agent, writes no state and prepares no workspace. Execution is
 * a later slice, and this command will not pretend otherwise.
 *
 * ── Repository targeting ───────────────────────────────────────────────────
 *
 * `--repository` is required and must be an absolute path. There is no
 * `process.cwd()` default, deliberately: nothing in the library ever consults
 * the working directory, and a command that defaulted to it would make the
 * answer a property of the shell rather than of the input — reopening, one
 * layer up, exactly the class of ambiguity `resolveRepository` refuses. The
 * resolver also refuses a relative path, so the refusal holds even if this
 * command forgets to.
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description(
      'Read-only: report which task a run would drive and what its durable state permits. ' +
        'Resolves the repository, consults its own task plan, reconciles persisted state ' +
        'against observed reality and prints the continuation authority. ' +
        'Starts no agent, writes nothing, prepares no workspace.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .option('--task <id>', "Inspect this task instead of the selector's choice.")
    .action(async (options: { repository: string; task?: string }) => {
      try {
        const resolution = await resolveRepository({ repositoryPath: options.repository });
        if (!resolution.ok) {
          // A resolution failure is the answer, not an accident: a closed code
          // plus a static sentence, exactly as the resolver produced them.
          process.stdout.write(
            `\nRepository   : could not be resolved\n` +
              `Failure      : ${resolution.code} — ${resolution.detail}\n\n` +
              'Read-only plan. No agent was started, no state was written, no workspace was touched.\n\n',
          );
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        const repository = resolution.repository;
        const plan = await planRun(
          { repository, taskId: options.task ?? null },
          { git: runGitCommand, now: () => new Date().toISOString() },
        );

        process.stdout.write(renderRunPlan(plan, repository));
        process.exitCode = exitCodeForPlan(plan.conclusion);
      } catch (error: unknown) {
        // An unexpected failure must not print an exception message: those
        // routinely quote CLI output and filesystem paths (AO-002). Fail
        // closed through the central safe formatter.
        process.stderr.write(`agent-loop run: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
