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
  type LeaseReleaseResult,
} from '../lease/execution-lease.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { releaseTaskWorkspace, type ReleaseResult } from '../run/release-workspace.js';
import { runGitCommand } from '../worktree/git-command.js';
import { renderLeaseRefusal, renderLeaseRelease } from './render-lease.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  exitCodeForReleaseOutcome,
  exitCodeWithLeaseRelease,
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
      'The workspace was not removed, and the reason code says what stopped it: an ownership\n' +
      '  proof that did not hold, a Git command that could not be completed, or a removal Git\n' +
      '  itself refused. Nothing was forced. Only the last of those means Git was asked at\n' +
      '  all, so read the code before concluding the repository is in a strange state.',
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
      // Declared above the `try` so the `catch` can still see it, exactly as
      // `block-command.ts` does and for the same reason.
      let leaseRelease: LeaseReleaseResult | null = null;
      let leaseReleaseAttempted = false;
      let leaseReleaseReported = false;

      /**
       * Print the execution-lease release report, at most once.
       *
       * Labelled `Lease`, not `Release`. In this command "release" is the task
       * workspace - it is the command's name, its `Outcome` line and its
       * `not requested` refusal - and the execution lease is a different thing
       * being given back. The two are never collapsed into one line and never
       * into one word.
       *
       * The two flags carry the same distinction `block-command.ts` documents at
       * length: attempted-but-unanswered must print, never-attempted must not.
       */
      const reportLeaseRelease = (): void => {
        if (!leaseReleaseAttempted || leaseReleaseReported) return;
        process.stdout.write(renderLeaseRelease('Lease', leaseRelease));
        leaseReleaseReported = true;
      };

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
          // The result is now kept. Until V3-07 this call stood here as a bare
          // expression: the workspace could be removed, reported as `RELEASED`
          // and exited 0 on, while the execution lease this invocation held sat
          // quarantined or displaced in the repository with nobody told.
          //
          // Wrapped for the reason `block-command.ts` states at its own
          // `finally`: an exception thrown here would replace the one that
          // entered, and the operator would be handed the wrong failure. The
          // branch is unreached - the release refuses rather than throws - and
          // leaving `leaseRelease` null keeps the exit code non-nominal.
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
                `agent-loop release: giving the execution lease back failed. ${formatSafeError(releaseError)}\n`,
              );
            } catch {
              // Nothing can be said, and saying it is not worth the exception.
            }
          }
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
        // Both facts, in that order and both kept whole. The workspace verdict
        // above is not rewritten by a failed lease release - the worktree really
        // was removed - and the exit code below is not left nominal by a
        // successful one, because writer authority that did not provably come
        // back is an operator condition whatever the removal achieved.
        // The exit code first, for the reason `block-command.ts` gives at the
        // same point: a report that failed to write must not take it with it.
        process.exitCode = exitCodeWithLeaseRelease(
          exitCodeForReleaseOutcome(released.outcome),
          leaseRelease,
        );
        reportLeaseRelease();
      } catch (error) {
        // As in `block-command.ts`: the original failure keeps the exit code -
        // diverging from `exitCodeWithLeaseRelease`, which would answer 3 - and
        // the release report goes out after it rather than in front of it.
        process.stderr.write(`${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
        reportLeaseRelease();
      }
    });
}
