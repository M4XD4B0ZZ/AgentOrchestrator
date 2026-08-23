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
  attestDeliveryObservation,
  concludeObservation,
  observeDelivery,
  resolveObservationSubject,
  type DeliveryObservation,
  type SubjectResolution,
} from '../deliver/observe-delivery.js';
import {
  loadDeliveryEvidence,
  recordDeliveryEvidence,
  type DeliveryEvidenceRecordCode,
  type IgnoreVerdict,
} from '../deliver/delivery-evidence-store.js';
import {
  concludeDeliveryDecision,
  revalidateSubject,
  type DeliveryDecision,
  type LocalSubject,
  type SubjectRevalidation,
} from '../deliver/delivery-decision.js';
import type { DeliveryObservationProof } from '../deliver/delivery-observation-proof.js';
import { runGitCommand, type GitRunner } from '../worktree/git-command.js';
import { askRuntimeIgnored } from '../state/runtime-ignored.js';
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
  readonly record?: boolean;
  readonly decide?: boolean;
}

/**
 * Every way `--record` can end, beside the store's own codes.
 *
 * These are the refusals decided *by the command*, before the store is reached.
 * They exist as their own vocabulary because "you did not ask for an
 * observation" and "the observation did not settle" send an operator to
 * different places, and neither is a failure of the store.
 */
export const RECORD_REFUSALS = [
  /** `--record` without `--observe`. Nothing was contacted and nothing was written. */
  'RECORD_REQUIRES_OBSERVATION',
  /** No subject could be established, so there was nothing to observe or record. */
  'RECORD_WITHOUT_SUBJECT',
  /** The observation did not settle both questions. Nothing is established to record. */
  'RECORD_WITHOUT_SETTLED_OBSERVATION',
  /** The task's durable record could not be re-read to bind the evidence to. */
  'RECORD_WITHOUT_TASK_BINDING',
] as const;

export type RecordRefusal = (typeof RECORD_REFUSALS)[number];

export const RECORD_REFUSAL_DETAIL: Readonly<Record<RecordRefusal, string>> = Object.freeze({
  RECORD_REQUIRES_OBSERVATION:
    'Recording stores an observation, so one has to be made. Pass --observe as well.',
  RECORD_WITHOUT_SUBJECT: 'There was no subject to ask about, so there is nothing to record.',
  RECORD_WITHOUT_SETTLED_OBSERVATION:
    'At least one question was not answered, so no observation was established to record.',
  RECORD_WITHOUT_TASK_BINDING:
    'The task record could not be read, so evidence could not be bound to it.',
});

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
  /**
   * The clock the record's instants come from.
   *
   * Injectable because `observedAt` is the one field a test has to be able to
   * pin, and because the assertion that matters about it — that a recent one
   * establishes nothing — is only checkable if a test can choose it.
   */
  readonly now?: () => Date;
  /** Asks Git whether one repository-relative path is ignored. */
  readonly checkIgnored?: (relativePath: string) => Promise<IgnoreVerdict>;
  /** The Git runner the default ignore probe uses. */
  readonly git?: GitRunner;
}

/**
 * The production ignore probe: the shared `check-ignore` question, bound to one
 * repository.
 *
 * `state/runtime-ignored.ts` owns what "is this path ignored" means, and this
 * is a partial application of it rather than a second implementation. A second
 * one would be a second opinion about Git's own rules, which is exactly what
 * that module's header refuses.
 */
function createRuntimeIgnoreProbe(
  repositoryRoot: string,
  git: GitRunner = runGitCommand,
): (relativePath: string) => Promise<IgnoreVerdict> {
  return (relativePath) => askRuntimeIgnored(git, repositoryRoot, relativePath);
}

/**
 * The flag's own sentence, exported so it can be pinned by literal.
 *
 * It used to end "it asks about one commit and nothing else" — the identical
 * over-claim that was withdrawn from `CONTACTED_TRAILER`, left standing on the
 * surface an operator reads *before* running the command, and pinned by
 * nothing. Two strings made the same promise and only one was corrected.
 */
export const OBSERVE_OPTION_DESCRIPTION =
  'Ask github.com about the commit named above, read-only. This is the only way this ' +
  'build contacts a forge for delivery, and it asks about no commit but that one. The ' +
  'GitHub CLI additionally makes calls of its own (telemetry, update check) that this ' +
  'build does not suppress. Without this flag nothing leaves this machine.';

/**
 * The record flag's own sentence, exported so it can be pinned by literal.
 *
 * Every clause is load-bearing. "A record of one past moment" is the whole
 * semantic contract of the slice, and it is stated on the surface an operator
 * reads *before* running the command rather than only in the report afterwards.
 * "Grants nothing" is there because a durable green check state is exactly the
 * artefact somebody will later be tempted to treat as permission.
 */
export const RECORD_OPTION_DESCRIPTION =
  'Store the observation as a durable record for this task, beside its task state. Requires ' +
  '--observe, and stores nothing unless both questions were answered. What is stored is a ' +
  'record of one past moment: it does not stay true, it is never re-read as the forge\'s ' +
  'current state, and it grants nothing — no merge, no pull request, no task state change. ' +
  'Replaces any previous record for this task.';

/**
 * The decide flag's own sentence, exported so it can be pinned by literal.
 *
 * "From this invocation's own answers" is the whole freshness contract, stated
 * on the surface an operator reads before running the command. "Does not
 * establish merge eligibility" is there because a one-word verdict is exactly
 * the artefact somebody will later be tempted to read as permission — and
 * because, measured, this build cannot establish it: the branch-rule endpoints
 * answer the same way for "there are none" as for "you may not read them".
 */
export const DECIDE_OPTION_DESCRIPTION =
  'Classify this invocation\'s own answers into one delivery decision. Requires --observe: a ' +
  'stored record can never produce a decision, so once a subject exists and nothing was ' +
  'contacted the answer is NOT_DECIDED. The local subject is re-read after the answers come ' +
  'back and the decision is refused if it moved. This does not establish merge eligibility — ' +
  'draft state, mergeability, reviews and branch rules are not observed, and their absence is ' +
  'not provable from what GitHub returns. Writes nothing.';

export const DELIVERY_COMMAND_DESCRIPTION =
  'Report the delivery target and the exact commit a delivery observation would be about, ' +
  'and — only with --observe — ask github.com two read-only questions about that commit: ' +
  'is there exactly one open pull request whose head is this commit, and what is the check ' +
  'state of this commit. Contacts nothing without --observe. With --record it stores that ' +
  'observation as a historical record beside the task state; without it, nothing is written. ' +
  'With --decide it classifies this invocation\'s own answers into one delivery decision, which ' +
  'is not merge eligibility and grants nothing. It writes no task state, opens no pull request ' +
  'and merges nothing, ever.';

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
      OBSERVE_OPTION_DESCRIPTION,
    )
    .option(
      '--record',
      RECORD_OPTION_DESCRIPTION,
    )
    .option(
      '--decide',
      DECIDE_OPTION_DESCRIPTION,
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
      // Read once and keep it. The same load supplies the subject and the
      // revision the evidence is bound to, so the two cannot describe different
      // bytes — reading twice would open a window in which the task advanced
      // between them and the record claimed a revision it was not derived from.
      const taskLoad = load(repository.root, options.task);
      const subject = resolveObservationSubject(repository.delivery, taskLoad);

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

      // One mint per invocation, and only for an invocation that asked for
      // something a proof is needed for.
      //
      // Hoisted out of the recording path because two callers now want one and
      // minting twice would stamp two `observedAt` instants on one observation
      // — a record and a decision that disagree about when the forge answered.
      // Still not minted on a plain `--observe`, which is the argument
      // `observe-delivery.ts` makes at its own mint call: an artefact made for
      // nobody is an artefact somebody will find a use for.
      const proof: DeliveryObservationProof | null =
        (options.record === true || options.decide === true) &&
        subject.ok &&
        observation !== null &&
        conclusion === 'OBSERVED'
          ? attestDeliveryObservation(
              subject.subject,
              observation,
              (seams.now ?? (() => new Date()))().toISOString(),
            )
          : null;

      // The second look at the local world, taken *after* the answers came
      // back and before anything is reported against them.
      //
      // Gated on the observation having **settled**, not merely on a request
      // having been attempted. The first version used `observation !== null`,
      // and a review drove a refusing forge through it: the report then said
      // "Local subject re-checked after the answers came back: UNCHANGED" on a
      // run where no answer came back at all. It also paid a full
      // `resolveRepository` — several Git children — to learn nothing. There is
      // no window to protect when nothing was established.
      const revalidation: SubjectRevalidation | null =
        options.decide === true && subject.ok && conclusion === 'OBSERVED'
          ? await revalidateLocalSubject(options, resolve, load, {
              subject: subject.subject,
              taskState: subject.taskState,
            })
          : null;

      const decision: DeliveryDecision | null =
        options.decide === true
          ? concludeDeliveryDecision({
              subjectEstablished: subject.ok,
              observed: observation !== null,
              proof,
              expected: subject.ok ? subject.subject : null,
              // Passed as it is, including `null`. There was a `?? 'UNAVAILABLE'`
              // here and a counter-proof retired it: substituting a verdict the
              // caller had not obtained was a value no test could reach, so
              // changing it to `'UNCHANGED'` broke nothing. The refusal lives
              // where it can be reached by name instead.
              revalidation,
            })
          : null;

      // Recording happens BEFORE the record is read back, and the order is the
      // contract rather than an accident.
      //
      // The first version of this read first, and a review reproduced what that
      // prints: on a successful `--observe --record` for a task with no prior
      // record, the report said "Recorded : ABSENT — No observation has been
      // recorded for this task" on the line directly above "Record : RECORDED".
      // A sentence false at the moment it is printed, contradicting the line
      // beneath it, and it suppressed the freshness sentence as a bonus. On a
      // second run it showed the record that had just been *superseded*.
      //
      // So the read is the last thing that happens, and what it reports is the
      // state of the store as the invocation leaves it.
      const recording =
        options.record === true
          ? await performRecording({
              options,
              repositoryRoot: repository.root,
              subject,
              taskLoad,
              observation,
              conclusion,
              proof,
              seams,
            })
          : null;

      // Whatever is on disk, judged against the task as it is now. Read on every
      // invocation, including one with no `--observe`, because "what does AO
      // already know about this task" is a local question and answering it needs
      // no network. It is reported as history and never as truth.
      const stored =
        subject.ok && taskLoad.ok
          ? loadDeliveryEvidence(
              repository.root,
              options.task,
              {
                taskId: options.task,
                repositoryRoot: repository.root,
                stateRevision: taskLoad.revision,
              },
              {
                subjectCommit: subject.subject.commit,
                host: subject.subject.host,
                owner: subject.subject.owner,
                name: subject.subject.name,
                declaredRemote: subject.remoteName,
              },
            )
          : null;

      process.stdout.write(
        renderDeliveryObservation({
          repositoryId: repository.id,
          repositoryRoot: repository.root,
          taskId: options.task,
          subject,
          observation,
          conclusion,
          stored,
          recording,
          decision: decision === null ? null : { decision, revalidation },
        }),
      );

      // Unchanged by `--decide`, and that is the decision rather than an
      // omission. The exit code answers one question — was the observation
      // settled — and a caller that could read "deliver this" out of an exit
      // status would have been handed the machine-consumable merge signal this
      // slice exists to not give. The decision is in the report, where a person
      // reads the sentence that comes with it.
      process.exitCode = exitCodeFor(conclusion);
    });
}

/**
 * Re-establishes the local subject after the forge has answered.
 *
 * A second, independent pass through exactly the resolution the first one used:
 * resolve the repository again, read the task record again, build the subject
 * again. Not a cached comparison — the point is to ask the world, because what
 * may have moved is the world.
 *
 * What it protects is stated exactly, because the reassuring reading is wrong.
 * It closes the *local* window only: the task advancing to a new commit, being
 * aborted, or the profile's delivery target being repointed while the request
 * was in flight. It does **not** freeze GitHub, and `UNCHANGED` is not a claim
 * that the answers are still true — nothing can make that claim. See
 * `deliver/delivery-decision.ts`.
 */
async function revalidateLocalSubject(
  options: DeliveryOptions,
  resolve: typeof resolveRepository,
  load: typeof loadTaskState,
  before: LocalSubject,
): Promise<SubjectRevalidation> {
  const again = await resolve({ repositoryPath: options.repository });
  if (!again.ok) return 'UNAVAILABLE';
  const subject = resolveObservationSubject(
    again.repository.delivery,
    load(again.repository.root, options.task),
  );
  if (!subject.ok) return 'UNAVAILABLE';
  return revalidateSubject(before, {
    subject: subject.subject,
    taskState: subject.taskState,
  });
}

/**
 * What one `--record` amounted to.
 *
 * A union of this command's own refusals and the store's, kept as one closed
 * string so the report has one place to print and a test has one place to pin.
 */
export type RecordOutcome = RecordRefusal | DeliveryEvidenceRecordCode;

export interface RecordingResult {
  readonly outcome: RecordOutcome;
  readonly recorded: boolean;
  /** The operator sentence for a refusal this command decided, else null. */
  readonly detail: string | null;
}

interface RecordingInputs {
  readonly options: DeliveryOptions;
  readonly repositoryRoot: string;
  readonly subject: SubjectResolution;
  readonly taskLoad: ReturnType<typeof loadTaskState>;
  readonly observation: DeliveryObservation | null;
  readonly conclusion: ReturnType<typeof concludeObservation>;
  /**
   * The invocation's one attestation, or `null` if none could be minted.
   *
   * Handed in rather than minted here, so that a run which both records and
   * decides binds both to the same observed instant. The refusal below is
   * unchanged: `null` still means the observation did not settle after all, and
   * it is still the mint — not this module — that decided so.
   */
  readonly proof: DeliveryObservationProof | null;
  readonly seams: DeliveryCommandSeams;
}

/**
 * The recording path, and every refusal on the way in.
 *
 * The order is the contract, and each step can only reach a *worse* answer than
 * the one after it. In particular the `--observe` requirement is judged before
 * anything else: `--record` alone must not merely fail to write, it must not
 * cause the command to behave differently from a plain local run in any way an
 * observer could detect. Nothing is contacted, nothing is created, and the
 * refusal is a sentence.
 */
async function performRecording(inputs: RecordingInputs): Promise<RecordingResult> {
  const refuse = (outcome: RecordRefusal): RecordingResult =>
    Object.freeze({ outcome, recorded: false as const, detail: RECORD_REFUSAL_DETAIL[outcome] });

  if (inputs.options.observe !== true) return refuse('RECORD_REQUIRES_OBSERVATION');
  if (!inputs.subject.ok) return refuse('RECORD_WITHOUT_SUBJECT');
  if (inputs.observation === null || inputs.conclusion !== 'OBSERVED') {
    return refuse('RECORD_WITHOUT_SETTLED_OBSERVATION');
  }
  if (!inputs.taskLoad.ok) return refuse('RECORD_WITHOUT_TASK_BINDING');

  // The mint's verdict. A `null` here means the observation did not settle
  // after all — the mint re-derives that for itself and does not believe the
  // conclusion computed above — and it reaches the same refusal, because from
  // the operator's side the two are one fact.
  const proof = inputs.proof;
  if (proof === null) return refuse('RECORD_WITHOUT_SETTLED_OBSERVATION');

  const result = await recordDeliveryEvidence({
    repositoryRoot: inputs.repositoryRoot,
    taskId: inputs.options.task,
    subject: {
      taskId: inputs.options.task,
      repositoryRoot: inputs.repositoryRoot,
      stateRevision: inputs.taskLoad.revision,
    },
    taskState: inputs.taskLoad.state.state,
    basePinnedCommit: inputs.taskLoad.state.basePinnedCommit,
    declaredRemote: inputs.subject.remoteName,
    expectedSubjectCommit: inputs.subject.subject.commit,
    expectedHost: inputs.subject.subject.host,
    expectedOwner: inputs.subject.subject.owner,
    expectedName: inputs.subject.subject.name,
    proof,
    recordedAt: (inputs.seams.now ?? (() => new Date()))().toISOString(),
    checkIgnored:
      inputs.seams.checkIgnored ??
      createRuntimeIgnoreProbe(inputs.repositoryRoot, inputs.seams.git ?? runGitCommand),
  });
  // The store's own codes carry no sentence here: they are already a closed
  // vocabulary an operator can look up, and inventing a second sentence for
  // each in this module would be a second place for them to drift.
  return Object.freeze({ outcome: result.code, recorded: result.recorded, detail: null });
}

/**
 * Four conclusions, three codes, and the distinction a scheduler needs.
 *
 * Three codes because two conclusions share one: a subject that was established
 * and not observed, and one that was observed and settled, are both "nothing to
 * go and fix".
 *
 * `OBSERVED` is zero even when the answer is "no pull request has this head" or
 * "the checks failed". Those are answers, and a command that exits non-zero on
 * a successfully obtained fact teaches a caller to retry a question that has
 * already been settled.
 */
export function exitCodeFor(conclusion: ReturnType<typeof concludeObservation>): number {
  if (conclusion === 'SUBJECT_NOT_ESTABLISHED') return EXIT_RUN_INPUT_UNUSABLE;
  if (conclusion === 'OBSERVATION_INCOMPLETE') return EXIT_RUN_REFUSED;
  // Exhaustive rather than a trailing `return`. A fifth conclusion would
  // otherwise inherit the success code silently, and this is the ladder that
  // decides what a caller reads as "settled" — the place a new member must not
  // be able to arrive at by falling off the end.
  if (conclusion === 'NOT_OBSERVED' || conclusion === 'OBSERVED') return EXIT_RUN_OK;
  const unreachable: never = conclusion;
  void unreachable;
  return EXIT_RUN_REFUSED;
}
