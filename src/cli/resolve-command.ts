/**
 * `agent-loop resolve` — an operator ends a task this orchestrator escalated.
 *
 * ── Why a verb of its own, and not a fourth flag on `run` ──────────────────
 *
 * `run` already carries three operator grants (`--remediate-verify-failure`,
 * `--continue-human-decision`, `--continue-usage-limit`) and a fourth would have
 * been the smaller diff. It is the wrong host, measurably: `run`'s ladder puts
 * an auth preflight, an MCP capability preflight and a full reconciliation in
 * front of every write, and each of those refuses in exactly the situation this
 * command exists for — the agent login is broken, the repository declares a
 * capability this invocation cannot prove, or the task's worktree was removed
 * once the work had been delivered by hand, which reconciles `STATE_DIVERGED`
 * and stops the run before any gate is reached.
 *
 * Those preconditions are right for a command that starts agents. This one
 * starts nothing: it reads one record, writes one record, and removes one item
 * from the operator's own outbox. It takes the repository's execution lease and
 * nothing else, which is what `block`, `delivery` and `release` already do.
 *
 * ── What it claims ────────────────────────────────────────────────────────
 *
 * That a person ended the task. Not that the work was delivered, verified,
 * reviewed or merged — see `run/resolve-task.ts` for why no commit argument is
 * asked for, and why asking for one would be a guard that refuses honest
 * closures and admits fabricated ones.
 *
 * `--attended` is required for the same reason it is required to execute: an
 * operator states they are present for *this* invocation. There is no unattended
 * resolution, and a scheduled job cannot quietly end tasks.
 */

import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
  type LeaseReleaseResult,
} from '../lease/execution-lease.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { resolveTaskByOperator, type ResolveTaskOutcome } from '../run/resolve-task.js';
import { renderLeaseRefusal, renderLeaseRelease } from './render-lease.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  exitCodeForResolveOutcome,
  exitCodeWithLeaseRelease,
} from './run-exit-codes.js';

interface ResolveOptions {
  readonly repository: string;
  readonly task: string;
  readonly attended?: boolean;
}

/** One static sentence per outcome. Closed, ASCII only, and pinned by test. */
export const RESOLVE_OUTCOME_SENTENCES: Readonly<Record<ResolveTaskOutcome, string>> =
  Object.freeze({
    RESOLVED:
      'Recorded. This task is now OPERATOR_RESOLVED: terminal, and closed on your authority.\n' +
      '  It says a person ended the task and nothing more - not that the work was verified,\n' +
      '  reviewed, delivered or merged. No pull request is opened from this state.',
    ALREADY_RESOLVED:
      'This task was already OPERATOR_RESOLVED. Nothing was written, and nothing needed to be.',
    TASK_NOT_STARTED:
      'No durable state exists for this task, so there is nothing to end. A task that was\n' +
      '  never started has nothing recorded about it.',
    STATE_UNUSABLE:
      'A record exists for this task and this build cannot read it. Nothing was written:\n' +
      '  ending a task whose record cannot be read would overwrite a document of unknown\n' +
      '  content.',
    STATE_NOT_RESOLVABLE:
      'This task is not in a state an operator may end from here. Only HUMAN_DECISION_REQUIRED\n' +
      '  and BLOCKED_VERIFY are - the two states in which this loop stopped and asked you for a\n' +
      '  decision. A scope violation or a diverged record needs to be looked at, not closed.',
    STATE_NOT_RECORDED:
      'The state was not written, so nothing changed. The refusal code above says why.',
  });

const ATTENDANCE_WITHHELD_SENTENCE =
  'This command records an operator decision, so it requires --attended: an invocation\n' +
  '  that does not claim a person is present may not end a task.';

export function registerResolveCommand(program: Command): void {
  program
    .command('resolve')
    .description(
      'Record that you have ended a task this orchestrator escalated to you. Terminal, and it ' +
        'claims nothing about the work.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .requiredOption('--task <id>', 'The task you are ending. Never selected for you.')
    .option(
      '--attended',
      'Confirm an operator is present for this invocation. Required: this records your decision.',
    )
    .action(async (options: ResolveOptions) => {
      // Declared above the `try` so the `catch` can still see it, exactly as
      // `release-command.ts` does and for the same reason.
      let leaseRelease: LeaseReleaseResult | null = null;
      let leaseReleaseAttempted = false;
      let leaseReleaseReported = false;

      const report = (lines: readonly string[]): void => {
        process.stdout.write(`${lines.join('\n')}\n`);
      };

      const reportLeaseRelease = (): void => {
        if (!leaseReleaseAttempted || leaseReleaseReported) return;
        process.stdout.write(renderLeaseRelease('Lease', leaseRelease));
        leaseReleaseReported = true;
      };

      try {
        // Checked before the repository is resolved: an invocation with no
        // operator behind it should not begin inspecting a repository in order
        // to tell the caller it was never going to do anything.
        if (options.attended !== true) {
          report([
            `Task         : ${options.task}`,
            'Resolve      : not requested',
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

        // The lease, held across the read and the write. A record read without
        // it could be moved by a live run between the read and the write, and
        // `advanceTaskState` re-proves the lease at the write in any case — this
        // is the ordinary way this build becomes a repository's writer.
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

        let resolved;
        try {
          resolved = resolveTaskByOperator(resolution.repository, options.task, {
            now: new Date().toISOString(),
            lease: Object.freeze({
              repository: resolution.repository,
              evidence: acquired.evidence,
            }),
          });
        } finally {
          try {
            leaseReleaseAttempted = true;
            leaseRelease = releaseRepositoryExecutionLease(acquired.evidence);
          } catch (releaseError: unknown) {
            try {
              process.stderr.write(
                `Lease release failed unexpectedly: ${formatSafeError(releaseError)}\n`,
              );
            } catch {
              // There is nothing left to report it to.
            }
          }
        }

        const lines = [
          `Repository   : ${resolution.repository.root}`,
          `Task         : ${options.task}`,
          `Outcome      : ${resolved.outcome}`,
          `From         : ${resolved.from ?? 'no record'}`,
        ];
        if (resolved.save !== null && !resolved.save.ok) {
          lines.push(`Refusal      : ${resolved.save.code}`);
        }
        // Reported always, including when there was nothing to remove, because
        // "the item is gone" is the half of this command an operator checks.
        if (resolved.outcome === 'RESOLVED') {
          lines.push(
            `Attention    : ${resolved.attentionRemoval ?? 'none was raised for this state'}`,
          );
        }
        lines.push('', RESOLVE_OUTCOME_SENTENCES[resolved.outcome]);
        report(lines);
        reportLeaseRelease();

        process.exitCode = exitCodeWithLeaseRelease(
          exitCodeForResolveOutcome(resolved.outcome),
          leaseRelease,
        );
      } catch (error: unknown) {
        reportLeaseRelease();
        process.stderr.write(`resolve failed unexpectedly: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
