/**
 * `agent-loop release` — hand back a task workspace that crashed into existence.
 *
 * ── Why a separate verb, and why it needs `--attended` ─────────────────────
 *
 * This is the only command in the build whose *purpose* is to delete something.
 * `run` writes state and starts agents; `doctor` reads. Deleting a branch and a
 * directory is a different kind of act, and it gets its own name rather than a
 * flag on an existing one — the same argument `run-command.ts` makes for
 * `--attended` not becoming a new meaning for `run`.
 *
 * `--attended` is required for the reason it is required to execute: an
 * operator states they are present for *this* invocation. There is no
 * unattended release, and a scheduled job cannot quietly remove workspaces.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * It removes exactly the workspaces `assessWorkspaceAdoption` would have
 * adopted: a registered worktree at the canonical path, holding this task's
 * branch, at the commit a fresh start would pin, with nothing done in it, for a
 * task that has no durable state. Anything else is refused with the verdict that
 * refused it — a dirty tree, a commit, a moved base, an existing state — because
 * those are precisely the cases where something could be lost.
 *
 * There is no `--force`. See `release-workspace.ts` for why a laxer notion of
 * ownership is not offered on the destructive path.
 */

import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
} from '../lease/execution-lease.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { releaseTaskWorkspace, type ReleaseResult } from '../run/release-workspace.js';
import { runGitCommand } from '../worktree/git-command.js';
import { renderLeaseRefusal } from './render-lease.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  exitCodeForReleaseOutcome,
} from './run-exit-codes.js';

interface ReleaseOptions {
  readonly repository: string;
  readonly task: string;
  readonly attended?: boolean;
}

/** One static sentence per outcome. Closed, ASCII only, and pinned by test. */
export const RELEASE_OUTCOME_SENTENCES: Readonly<Record<ReleaseResult['outcome'], string>> =
  Object.freeze({
    EXECUTION_LEASE_LOST:
      'The lease was held when this release began and was lost partway through it. The\n' +
      '  worktree is gone and the branch is not - which looks exactly like a kept branch and\n' +
      '  is not one: another invocation owns this repository now, and what is left will\n' +
      '  refuse the next start. Look before you delete anything.',
    EXECUTION_LEASE_NOT_HELD:
      'This invocation does not hold this repository\'s execution lease, so it may not\n' +
      'remove anything here. Nothing was touched.',
    RELEASED: 'The worktree and the task branch were removed.',
    RELEASED_BRANCH_KEPT:
      'The worktree was removed and the task branch was not. Nothing occupies the path now;\n' +
      '  the branch is still there and can be deleted with git once you are satisfied.',
    TASK_ID_INVALID: 'The requested task id is not a valid task id. Nothing was opened.',
    PLANNING_FAILED: 'The task source could not be read or normalised. Nothing was removed.',
    TASK_UNKNOWN: 'The requested task id names no task in this plan. Nothing was removed.',
    NOT_RELEASABLE:
      'The workspace could not be proven to be this task\'s own untouched leftovers, so it\n' +
      '  was not removed. The reason code says which proof failed. A workspace holding work,\n' +
      '  or belonging to a task that has durable state, is a decision for you rather than\n' +
      '  something this command will delete.',
    HOLDS_IGNORED_CONTENT:
      'The workspace is otherwise releasable and holds files Git ignores. Nothing above looks\n' +
      '  inside ignored content, and an unforced worktree removal deletes it anyway, so this\n' +
      '  refuses rather than destroying files you were never shown. Inspect the directory and\n' +
      '  remove it with git if you are satisfied.',
    IGNORED_CONTENT_UNDETERMINED:
      'Git could not say whether the workspace holds ignored content, so nothing was removed.',
    REMOVE_FAILED:
      'Every ownership proof held and Git still refused to remove the worktree. Nothing was\n' +
      '  forced; the workspace is as it was.',
  });

const ATTENDANCE_WITHHELD_SENTENCE =
  'Releasing removes a branch and a directory, so it requires an operator to be present for\n' +
  '  this invocation. Nothing was inspected and nothing was removed. Pass --attended to\n' +
  '  release. There is no unattended release and no --force.';

function report(lines: readonly string[]): void {
  process.stdout.write(`\n${lines.join('\n')}\n\n`);
}

export function registerReleaseCommand(program: Command): void {
  program
    .command('release')
    .description(
      'Remove a task workspace that a crashed start left behind. Removes only a workspace ' +
        'proven to be this task’s own untouched leftovers — the same proof adoption uses — ' +
        'and refuses anything holding work. Requires --attended. There is no --force.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .requiredOption('--task <id>', 'The task whose workspace should be released.')
    .option(
      '--attended',
      'Confirm an operator is present for this invocation. Required: this command deletes.',
    )
    .action(async (options: ReleaseOptions) => {
      try {
        // Checked before the repository is even resolved: an invocation with no
        // operator behind it should not begin inspecting a repository in order
        // to tell the caller it was never going to do anything.
        if (options.attended !== true) {
          report([
            `Task         : ${options.task}`,
            'Release      : not requested',
            '',
            ATTENDANCE_WITHHELD_SENTENCE,
          ]);
          process.exitCode = EXIT_RUN_NEEDS_OPERATOR;
          return;
        }

        const resolution = await resolveRepository({ repositoryPath: options.repository });
        if (!resolution.ok) {
          report([
            'Repository   : could not be resolved',
            `Failure      : ${resolution.code} - ${resolution.detail}`,
          ]);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        // The lease, held across the whole removal. A release deletes a branch
        // and a directory, and `assessWorkspaceAdoption` cannot tell a crashed
        // run's leftovers from a concurrent run's freshly prepared workspace —
        // they look identical. Only exclusive ownership separates them.
        const acquired = acquireRepositoryExecutionLease(
          resolution.repository,
          { runId: null, blockId: null },
          { now: () => new Date().toISOString() },
        );
        if (!acquired.ok) {
          process.stdout.write(renderLeaseRefusal(acquired.code));
          process.exitCode = EXIT_RUN_REFUSED;
          return;
        }

        let released;
        try {
          released = await releaseTaskWorkspace(resolution.repository, options.task, {
            git: runGitCommand,
            lease: acquired.evidence,
          });
        } finally {
          releaseRepositoryExecutionLease(acquired.evidence);
        }

        report([
          `Task         : ${released.taskId}`,
          `Outcome      : ${released.outcome}`,
          `Worktree     : ${released.worktreeRemoved ? 'removed' : 'untouched'}`,
          `Branch       : ${released.branchRemoved ? 'removed' : 'untouched'}`,
          `Proof        : ${released.verdict ?? 'not established'}`,
          ...(released.reasonCodes.length > 0
            ? [`Reasons      : ${released.reasonCodes.join(', ')}`]
            : []),
          '',
          RELEASE_OUTCOME_SENTENCES[released.outcome],
        ]);
        process.exitCode = exitCodeForReleaseOutcome(released.outcome);
      } catch (error) {
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
