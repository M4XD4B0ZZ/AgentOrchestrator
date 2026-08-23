/**
 * `agent-loop delivery` — the read-only delivery-observation surface (V4 slice 2).
 *
 * ── Why a command of its own, and why the network is a flag on it ──────────
 *
 * `run` is read-only by default and executes only when `--attended` says so.
 * This command copies that shape one level down: it is **local** by default and
 * contacts a forge only when `--observe` says so. The two properties that
 * matters are structural rather than documented:
 *
 *  - `agent-loop run` gained nothing. It resolves a delivery target — that is
 *    slice 1, and it is local Git — and it has no path to this module at all.
 *    No existing command became a networking command;
 *  - without `--observe` this command builds a subject and stops. There is no
 *    branch on which a client is constructed, so "nothing was contacted" is a
 *    fact about the code rather than a promise in help text.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * It writes no task state, takes no execution lease, prepares no workspace and
 * starts no agent. It does not open, update, review or merge a pull request,
 * and there is no flag that would. `READY_FOR_PR` is still terminal, and
 * observing a task at that state changes nothing about it.
 *
 * It also does not answer "may this be merged". It reports two facts about one
 * commit and stops there, deliberately: a surface that combined them would be
 * making the merge-eligibility decision that a later slice has to take
 * explicitly.
 */

import type { Command } from 'commander';

import {
  concludeObservation,
  observeDelivery,
  resolveObservationSubject,
  type DeliveryObservation,
} from '../deliver/observe-delivery.js';
import {
  createForgeCommandRunner,
  type ForgeCommandRunner,
} from '../deliver/github-observer.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { loadTaskState } from '../state/state-store.js';
import { renderDeliveryObservation } from './render-delivery-observation.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
} from './run-exit-codes.js';

interface DeliveryOptions {
  readonly repository: string;
  readonly task: string;
  readonly observe?: boolean;
}

/**
 * Injection points, in the same shape `run` uses.
 *
 * `runner` exists so the whole surface can be exercised without a network and
 * without a GitHub login — the canonical suite must stay deterministic on a
 * machine that has never run `gh auth login`, and CI has no credentials at all.
 */
export interface DeliveryCommandSeams {
  readonly resolveRepository?: typeof resolveRepository;
  readonly loadTaskState?: typeof loadTaskState;
  readonly runner?: ForgeCommandRunner;
  readonly envSource?: NodeJS.ProcessEnv;
}

export const DELIVERY_COMMAND_DESCRIPTION =
  'Report the delivery target and the exact commit a delivery observation would be about, ' +
  'and — only with --observe — ask github.com two read-only questions about that commit: ' +
  'is there exactly one open pull request whose head is this commit, and what is the check ' +
  'state of this commit. Contacts nothing without --observe. Writes no task state, opens no ' +
  'pull request and merges nothing, ever.';

export function registerDeliveryCommand(program: Command, seams: DeliveryCommandSeams = {}): void {
  const resolve = seams.resolveRepository ?? resolveRepository;
  const load = seams.loadTaskState ?? loadTaskState;

  program
    .command('delivery')
    .description(DELIVERY_COMMAND_DESCRIPTION)
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .requiredOption(
      '--task <id>',
      'The task whose pinned commit is the subject. Required: an observation with no exact ' +
        'commit to be about is not an observation this build makes.',
    )
    .option(
      '--observe',
      'Ask github.com about the commit named above, read-only. This is the only way this ' +
        'build contacts a forge for delivery, and it asks about one commit and nothing else. ' +
        'Without it nothing leaves this machine.',
    )
    .action(async (options: DeliveryOptions) => {
      const resolution = await resolve({ repositoryPath: options.repository });
      if (!resolution.ok) {
        process.stdout.write(
          `\nRepository   : could not be resolved\n` +
            `Failure      : ${resolution.code} — ${resolution.detail}\n\n`,
        );
        process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
        return;
      }

      const repository = resolution.repository;
      const subject = resolveObservationSubject(
        repository.delivery,
        load(repository.root, options.task),
      );

      // The egress branch, and the whole of it. A subject that could not be
      // established is never observed either: there would be nothing to ask
      // about, and asking anyway would mean guessing the subject.
      let observation: DeliveryObservation | null = null;
      if (options.observe === true && subject.ok) {
        observation = await observeDelivery(subject.subject, {
          runner: seams.runner ?? createForgeCommandRunner(),
          envSource: seams.envSource ?? process.env,
        });
      }

      const conclusion = concludeObservation(subject, observation);
      process.stdout.write(
        renderDeliveryObservation({
          repositoryId: repository.id,
          repositoryRoot: repository.root,
          taskId: options.task,
          subject,
          observation,
          conclusion,
        }),
      );

      process.exitCode = exitCodeFor(conclusion);
    });
}

/**
 * Three outcomes, three codes, and the distinction a scheduler needs.
 *
 * `OBSERVED` is zero even when the answer is "no pull request has this head" or
 * "the checks failed". Those are answers, and a command that exits non-zero on
 * a successfully obtained fact teaches a caller to retry a question that has
 * already been settled.
 */
export function exitCodeFor(conclusion: ReturnType<typeof concludeObservation>): number {
  if (conclusion === 'SUBJECT_NOT_ESTABLISHED') return EXIT_RUN_INPUT_UNUSABLE;
  if (conclusion === 'OBSERVATION_INCOMPLETE') return EXIT_RUN_REFUSED;
  return EXIT_RUN_OK;
}
