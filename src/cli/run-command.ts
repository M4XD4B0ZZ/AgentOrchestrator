import type { Command } from 'commander';

import type { AgentRunner } from '../agent/agent-command.js';
import { runAuthPreflight } from '../auth/auth-preflight.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import { formatSafeError } from '../core/safe-error.js';
import { runCapabilityDump } from '../doctor/capabilities.js';
import { resolveRepository, type ResolvedRepository } from '../repo/resolve-repository.js';
import { renderRunPlan, READ_ONLY_TRAILER } from '../run/render-run-plan.js';
import { planRun } from '../run/run-plan.js';
import { driveLifecycle } from '../run/lifecycle-driver.js';
import { selectRunTask } from '../run/run-driver.js';
import {
  driveUnattendedAutomaticResume,
  isUsableWaitBound,
  MAX_WAIT_MS_CEILING,
  type ResetWaitPolicy,
} from '../run/unattended-resume.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import { runGitCommand } from '../worktree/git-command.js';
import { GRANT_WITHHELD_SENTENCE } from './render-attended-run.js';
import { renderLifecycleRun, renderUnattendedResume } from './render-lifecycle.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_UNEXPECTED,
  exitCodeForLifecycleRun,
  exitCodeForPlan,
  exitCodeForUnattendedResume,
  type CliExitCode,
} from './run-exit-codes.js';

/**
 * `agent-loop run` — the front door, in three modes.
 *
 * ── The third mode, and why it is a mode rather than a flag on the second ───
 *
 * V3-08 added `--automatic-resume-only`: continue **one named task** with
 * nobody present, and only where `classifyResume` freshly answered
 * `AUTOMATIC_ALLOWED`. Today that is exactly one situation — a task parked on
 * `BLOCKED_USAGE_LIMIT` whose reported reset has passed and whose worktree,
 * commits, repository identity and login all still check out.
 *
 * It is a separate grant from `--attended`, not a variant of it, and the two are
 * refused together. `--attended` states that a human is present; this one states
 * that nobody is, and the whole point of the slice is that the second claim buys
 * strictly *less*: it cannot start a task, cannot continue ordinary in-flight
 * work, and cannot remove a stale lease. `run/invocation-grant.ts` holds the
 * vocabulary and `run/run-driver.ts` holds the gate.
 *
 * `--wait-for-reset` is a further, separate opt-in on top of it: permission to
 * sleep **once**, bounded by a mandatory `--max-wait-ms`, holding no execution
 * lease, and only while the reported reset time is the single check still
 * refusing the resume. Waiting is never implied by the block, and there is no
 * default duration.
 *
 * ── The default mode did not change, and that is a contract ─────────────────
 *
 * Without `--attended` this command *plans*, exactly as V2-01 shipped it: it
 * resolves the repository, asks the repository's own selector which task is
 * next, loads and reconciles that task's durable state, and reports what may
 * continue and on whose authority. It starts no agent, writes no state and
 * prepares no workspace.
 *
 * That is deliberate and load-bearing. `agent-loop run` is already part of the
 * published CLI contract, and operators, scripts and CI jobs may be invoking it
 * on the strength of the promise that it changes nothing. V2-05 adds execution
 * *beside* that promise instead of inside it: a bare `run` still cannot write,
 * and `tests/run-command.test.ts` proves it by driving the real command against
 * a real repository and checking that no state file, branch or worktree appeared.
 * An execution mode that arrived by quietly widening the meaning of an existing
 * verb would be indistinguishable, from the outside, from a regression.
 *
 * ── Two independent requirements, neither substituting for the other ────────
 *
 * Executing needs **both**:
 *
 *  1. `--attended` — the operator grant. It says a human is present for *this*
 *     invocation. It is a statement about the operator, and it authorises
 *     nothing about the agents' credentials.
 *  2. Auth evidence — the artefact a real preflight produces. It says the agent
 *     CLIs are logged in on an accepted subscription. It is a statement about
 *     the machine, and it says nothing about whether anyone is watching.
 *
 * They are checked separately and neither is derivable from the other. Passing
 * `--attended` on a machine that is not logged in refuses with
 * `AUTH_PREFLIGHT_FAILED`; being fully logged in without `--attended` still
 * produces a plan and writes nothing. This is the CLI-level form of the same
 * rule `RunRequest` states about `continuationGrant` and `authEvidence`, and it
 * holds identically for `--automatic-resume-only`: that grant states nobody is
 * present, never that a login is valid.
 *
 * ── The preflight runs at most once, and lazily ─────────────────────────────
 *
 * `runAuthPreflight` needs a capability dump first and then starts two real CLIs,
 * so it is expensive and it is not something to do twice. The seam handed to
 * `startTask` memoises it: `startTask` calls it at the point in its own sequence
 * where it belongs — after the cheap refusals, before any workspace exists — and
 * the drive reuses whatever that produced. On the `ALREADY_STARTED` path
 * `startTask` returns before reaching the preflight, so the command runs it
 * itself before driving. Either way exactly one preflight happens per invocation
 * that gets as far as executing, and none at all on an invocation that refuses
 * for a cheaper reason.
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

/**
 * The default bound on one attended invocation.
 *
 * Not the bound on the loop — `maxReviewRounds` is, and it is the repository's.
 * This is the bound on a single call, so that one invocation cannot run away.
 * Eight is enough for a verify/review/remediate cycle or two and small enough
 * that an operator watching it stays in the loop; `--max-steps` overrides it,
 * and `STEP_BUDGET_EXHAUSTED` exits 5, which means "call again to continue".
 */
export const DEFAULT_MAX_STEPS = 8;

interface RunOptions {
  readonly repository: string;
  readonly task?: string;
  readonly attended?: boolean;
  readonly automaticResumeOnly?: boolean;
  readonly waitForReset?: boolean;
  readonly maxWaitMs?: string;
  readonly maxSteps?: string;
  readonly maxInvocations?: string;
  readonly recoverStaleLease?: boolean;
}

/**
 * One refusal of an unusable argument combination, before anything is resolved.
 *
 * A closed pair rather than free text, so the report cannot acquire a message
 * from anywhere but this file. Each has its own code for the reason the numeric
 * bounds do: an operator who supplied two mutually exclusive grants is not
 * helped by being told a third flag needs a fourth.
 */
interface ArgumentRefusal {
  readonly code: string;
  readonly sentence: string;
}

/**
 * Every way the new V3-08 flags can be combined into something this command
 * refuses, checked before the repository is even resolved.
 *
 * `null` when the combination is usable. Written as one function so the rules
 * sit together and can be pinned together: a refusal that lived beside its flag
 * would be a rule nobody could read as a set.
 */
function refuseArguments(options: RunOptions): ArgumentRefusal | null {
  const unattended = options.automaticResumeOnly === true;
  const attended = options.attended === true;

  if (attended && unattended) {
    return {
      code: 'CONTINUATION_GRANT_CONFLICT',
      sentence:
        '--attended and --automatic-resume-only are two different grants and cannot both ' +
        'be given. One states a human is present; the other states nobody is.',
    };
  }
  if (options.waitForReset === true && !unattended) {
    return {
      code: 'WAIT_WITHOUT_AUTOMATIC_RESUME',
      sentence:
        '--wait-for-reset only means something under --automatic-resume-only. Waiting for a ' +
        'quota reset is the automatic-resume path continuing itself later; there is nothing ' +
        'for an attended or read-only run to wait for.',
    };
  }
  if (options.maxWaitMs !== undefined && options.waitForReset !== true) {
    return {
      code: 'MAX_WAIT_WITHOUT_WAIT',
      sentence: '--max-wait-ms bounds --wait-for-reset, which was not given.',
    };
  }
  if (options.waitForReset === true && options.maxWaitMs === undefined) {
    return {
      code: 'MAX_WAIT_MS_REQUIRED',
      sentence:
        '--wait-for-reset requires --max-wait-ms. There is deliberately no default: a wait ' +
        'nobody bounded is a multi-hour sleep nobody asked for.',
    };
  }
  if (options.waitForReset === true && options.recoverStaleLease === true) {
    return {
      code: 'STALE_RECOVERY_WITH_WAIT',
      sentence:
        '--recover-stale-lease cannot be combined with a wait. Removing a lease is a ' +
        'destructive permission an operator gives for now, and a wait can put hours between ' +
        'now and the attempt that would use it. Recover with `agent-loop lease recover` ' +
        'first, then invoke this.',
    };
  }
  if (unattended && options.recoverStaleLease === true) {
    return {
      code: 'STALE_RECOVERY_WITHOUT_OPERATOR',
      sentence:
        '--recover-stale-lease cannot be combined with --automatic-resume-only. The ' +
        'unattended grant exists for runs nobody is watching, and removing another run\'s ' +
        'lease is not something to do unwatched. Use `agent-loop lease recover`.',
    };
  }
  return null;
}

/**
 * How many times one `run --attended` may re-enter the driver.
 *
 * One, so that the default drives the task exactly as far as it did before
 * V3-06: a single invocation, stopping at the step budget and telling the
 * operator to call again. Raising it hands that decision to the lifecycle driver
 * instead of to the operator's shell.
 *
 * "Exactly as far", not "exactly the same report". Routing this command through
 * the driver changed three visible things, deliberately, and an earlier version
 * of this comment claimed it changed nothing:
 *
 *  - the step-budget stop is now spelled `INVOCATION_BUDGET_EXHAUSTED` (same
 *    exit code 5, same meaning: everything is on disk, call again);
 *  - the report comes from `renderLifecycleRun`, which adds the lease lines and
 *    the release line this slice exists to produce;
 *  - **seven** of the eight acquire refusals moved from exit 4 to exit 3. Only
 *    `LEASE_HELD` — another run is working — keeps 4, because it clears itself.
 *    An unusable lease location, an incoherent repository record and a
 *    filesystem that cannot support the claim do not, and code 4's contract says
 *    re-invoking under other conditions can differ. `STALE_LEASE_RECOVERY_UNSAFE`
 *    is the seventh and the one most schedulers will actually meet — it is what
 *    a crashed repository answers — and it lands on exit 3 through whichever of
 *    `STALE_LEASE_PRESENT`, `RECOVERY_UNSAFE`, `LEASE_CHANGED`,
 *    `LEASE_DISPLACED`, `RECOVERY_FAILED` or `LEASE_ACQUISITION_REFUSED`
 *    applies. One ending is the exception, and it is the right one: a recovery
 *    that succeeds and is then beaten to the acquisition reports
 *    `LIVE_OWNER_PRESENT`, exit 4, because that is what happened. An earlier
 *    version of this list said six and then said "only `LEASE_HELD` keeps 4",
 *    which cannot both be true of an eight-member vocabulary. This narrows
 *    `L-V2-07L-1` rather than carrying it forward;
 *  - each acquire refusal keeps its own sentence in the report. Several of them
 *    share one lifecycle outcome, so the outcome sentence can only hedge across
 *    them; `renderLifecycleRun` prints `LEASE_ACQUIRE_SENTENCES[code]` beneath
 *    it, which is what this command printed before the rewiring and briefly
 *    stopped printing after it;
 *  - task selection happens outside the lease now. See the note on
 *    `executeAttended`, and `L-V3-06-1` for what an operator sees differently.
 */
export const DEFAULT_MAX_INVOCATIONS = 1;

/**
 * The execution seams of the attended path. All optional; all default to the
 * real thing.
 *
 * Same shape and same reasoning as `RunDependencies`' own execution seams: the
 * real ones start subscription CLIs and a real `npm run verify`, so a test that
 * wanted to drive this command end to end had no way to do it without spending
 * quota and minutes. Without this the attended path would be the one new
 * user-facing path in the slice with no test through it — the wiring would be
 * argued for rather than exercised.
 *
 * Deliberately *only* execution seams. Git, the clock, the state store and the
 * repository resolver stay hardwired, because a test that could substitute those
 * could make the command agree with a repository that does not exist. And no
 * seam here can grant anything: {@link authPreflight} returns evidence, so a
 * substitute still has to produce the real artefact and still cannot fabricate
 * one — a stub that wanted to claim a passing preflight would have to mint
 * evidence, which only the real preflight can do.
 */
export interface RunCommandSeams {
  readonly authPreflight?: () => Promise<AuthPreflightEvidence | null>;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
}

/**
 * A preflight seam that runs the real thing at most once.
 *
 * Returns the same artefact on every later call. A failed preflight is *not*
 * retried: a second attempt would start the subscription CLIs again to ask a
 * question already answered, and "it failed and then it passed" is not a state
 * this command should be able to reach inside one invocation.
 *
 * Exported for `block-command.ts`, which needs exactly this and must not write
 * its own. Two memoising preflights in one binary are two chances for one
 * invocation to start the subscription CLIs twice — and the second copy would be
 * free to differ on the one decision that matters here, which is that a failure
 * is remembered rather than retried.
 */
export function onceOnlyPreflight(
  override?: () => Promise<AuthPreflightEvidence | null>,
): () => Promise<AuthPreflightEvidence | null> {
  const run =
    override ??
    (async (): Promise<AuthPreflightEvidence | null> => {
      // `process.env` is a source to derive from, never something forwarded:
      // both of these build a fresh, policy-scoped map per probe. See
      // `capabilities.ts` and `env-guard.ts`.
      const capabilities = await runCapabilityDump({ env: process.env });
      const assessment = await runAuthPreflight(capabilities, process.env);
      return assessment.evidence;
    });

  let done = false;
  let evidence: AuthPreflightEvidence | null = null;
  return async () => {
    if (done) return evidence;
    done = true;
    evidence = await run();
    return evidence;
  };
}

/** The read-only plan. Unchanged behaviour; the default for a bare `run`. */
async function reportPlan(
  repository: ResolvedRepository,
  taskId: string | null,
  noteGrantWithheld: boolean,
): Promise<CliExitCode> {
  const plan = await planRun(
    { repository, taskId },
    { git: runGitCommand, now: () => new Date().toISOString() },
  );
  process.stdout.write(renderRunPlan(plan, repository));
  // Printed when the operator *could* have asked for execution and did not, so
  // that the read-only default is discoverable rather than surprising. Not
  // printed when `--attended` was given and there was simply nothing to run:
  // there the grant was not withheld, and saying so would be false.
  if (noteGrantWithheld) process.stdout.write(`${GRANT_WITHHELD_SENTENCE}\n\n`);
  return exitCodeForPlan(plan.conclusion);
}

/**
 * Select the task, then hand the whole lifecycle to the driver.
 *
 * Selection happens here and outside the lease deliberately: it only reads the
 * repository's own task files, and an invocation with nothing to run should not
 * take a writer lease to find that out. It is also a visible change: before the
 * rewiring the lease came first, so a held lease plus an empty selector reported
 * a lease refusal and exited 4; now it reports the read-only plan. Recorded as
 * the fifth item of `L-V3-06-1`.
 *
 * Everything after it — taking the lease,
 * recovering a provably dead one, starting the task, driving it across as many
 * invocations as the operator allowed, and giving the lease back — belongs to
 * `driveLifecycle`, which is the layer that can report what happened to the
 * lease instead of discarding it.
 */
async function executeAttended(
  repository: ResolvedRepository,
  requestedTaskId: string | null,
  lifecycle: {
    readonly maxSteps: number;
    readonly maxInvocations: number;
    readonly recoverStaleLease: boolean;
  },
  seams: RunCommandSeams,
): Promise<CliExitCode> {
  // Which task, decided before anything is created. `--task` wins; otherwise the
  // repository's own selector chooses, and its refusals are the plan's to
  // report — so an invocation with nothing to run falls back to the plan rather
  // than inventing a second vocabulary for "no eligible task".
  let taskId = requestedTaskId;
  if (taskId === null) {
    const selection = selectRunTask(repository);
    if (selection.code !== 'TASK_SELECTED' || selection.task === null) {
      return reportPlan(repository, null, false);
    }
    taskId = selection.task.id;
  }

  const result = await driveLifecycle(
    {
      repository,
      taskId,
      // The grant, and only here. `true` because this function is only reached
      // when `--attended` was given. With the default invocation budget of one
      // this is exactly the per-invocation grant it always was; raising
      // --max-invocations is the operator extending it across the run, which is
      // what the flag means.
      continuationGrant: 'ATTENDED',
      recoverStaleLease: lifecycle.recoverStaleLease,
      maxSteps: lifecycle.maxSteps,
      maxInvocations: lifecycle.maxInvocations,
    },
    {
      now: () => new Date().toISOString(),
      git: runGitCommand,
      // One preflight for the whole run: `onceOnlyPreflight` memoises it, so the
      // subscription CLIs start once however many invocations follow, and a
      // failure stays a failure.
      authPreflight: onceOnlyPreflight(seams.authPreflight),
      ...(seams.agent !== undefined ? { agent: seams.agent } : {}),
      ...(seams.verify !== undefined ? { verify: seams.verify } : {}),
    },
  );

  process.stdout.write(renderLifecycleRun(repository, result));
  return exitCodeForLifecycleRun(result);
}

/**
 * Continue one already-durable task with nobody present, optionally waiting out
 * a reported quota reset once (V3-08).
 *
 * Deliberately **not** routed through `executeAttended`, and deliberately not
 * given the selector. Three differences, and each is a refusal rather than an
 * omission:
 *
 *  - the task must be named. `--task` is required here, because selection reads
 *    the repository's task files to decide what to *start*, and this mode may
 *    not start anything. A selector answer would be a task nobody continued;
 *  - the grant and the stale-recovery permission are fixed inside
 *    `driveUnattendedAutomaticResume`, not passed from here, so nothing this
 *    function does or forgets can widen them;
 *  - the auth preflight is handed over as a **factory**. One once-only preflight
 *    per lifecycle epoch: attended semantics inside an epoch, and a real login
 *    check again after any wait.
 */
async function executeUnattendedAutoResume(
  repositoryPath: string,
  repository: ResolvedRepository,
  taskId: string,
  bounds: {
    readonly maxSteps: number;
    readonly maxInvocations: number;
    readonly wait: ResetWaitPolicy;
  },
  seams: RunCommandSeams,
): Promise<CliExitCode> {
  const result = await driveUnattendedAutomaticResume(
    {
      repository,
      taskId,
      maxSteps: bounds.maxSteps,
      maxInvocations: bounds.maxInvocations,
      wait: bounds.wait,
    },
    {
      now: () => new Date().toISOString(),
      git: runGitCommand,
      authPreflight: () => onceOnlyPreflight(seams.authPreflight),
      // Resolved again from the path the operator named, never from the object
      // the first attempt used. A `ResolvedRepository` is a reading taken at a
      // moment, and after a wait that moment is hours old.
      resolveRepository: async () => {
        const resolution = await resolveRepository({ repositoryPath });
        return resolution.ok ? resolution.repository : null;
      },
      ...(seams.agent !== undefined ? { agent: seams.agent } : {}),
      ...(seams.verify !== undefined ? { verify: seams.verify } : {}),
    },
  );

  process.stdout.write(renderUnattendedResume(repository, result));
  return exitCodeForUnattendedResume(result);
}

export function registerRunCommand(program: Command, seams: RunCommandSeams = {}): void {
  program
    .command('run')
    .description(
      'Report which task a run would drive and what its durable state permits. ' +
        'Resolves the repository, consults its own task plan, reconciles persisted state ' +
        'against observed reality and prints the continuation authority. ' +
        'Read-only by default: starts no agent, writes nothing, prepares no workspace. ' +
        'Pass --attended to execute instead.',
    )
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .option('--task <id>', "Inspect this task instead of the selector's choice.")
    .option(
      '--attended',
      'Execute: start the task if needed and drive it, writing state and starting agents. ' +
        'States that an operator is present for this invocation. Not a claim about ' +
        'credentials — a fresh auth preflight must pass independently.',
    )
    .option(
      '--max-steps <n>',
      `Bound on durable steps for one attended invocation (default ${String(DEFAULT_MAX_STEPS)}).`,
    )
    .option(
      '--max-invocations <n>',
      'How many times this run may re-enter the driver after durable progress ' +
        `(default ${String(DEFAULT_MAX_INVOCATIONS)}). One reproduces the pre-V3-06 behaviour: ` +
        'the run stops at the step budget and reports "call again". Above one, the operator ' +
        'grant to continue this task covers every invocation the run makes.',
    )
    .option(
      '--recover-stale-lease',
      'Permit removing an execution lease this build can prove is dead before acquiring. ' +
        'Never removes one on a guess, has no override, and grants nothing by itself: a ' +
        'removal is followed by an ordinary acquisition that is allowed to lose.',
    )
    // ── Why this is not called `--unattended-…` ─────────────────────────────
    //
    // It was, for one round, and `tests/v2-07lr-lease-recovery.test.ts` refused
    // it: no option registered on any command in this build may carry `force`,
    // `unattended`, `adopt`, `takeover` or `steal` in its name. That guard
    // protects a different promise — "nothing in this build removes a lease it
    // did not create" — and an option whose *name* implies unattended clearing
    // is a promise to an operator whatever its help text says.
    //
    // Widening the guard to admit this flag would have been the wrong repair:
    // the guard is right, and the name was the problem. `--automatic-resume-only`
    // is also the better name on its own terms. It is the CLI spelling of the
    // grant it produces (`AUTOMATIC_RESUME_ONLY`), and the trailing `-only`
    // carries the restriction, where `--unattended-…` reads as the broad
    // capability this deliberately is not.
    .option(
      '--automatic-resume-only',
      'Continue ONE named task with nobody present, and only where the resume decision ' +
        'answers AUTOMATIC_ALLOWED -- today, a quota block whose reported reset has passed ' +
        'and whose worktree, commits, repository and login all still check out. Requires ' +
        '--task. Cannot start a task, cannot continue ordinary in-flight work, cannot ' +
        'recover a stale lease, and is mutually exclusive with --attended.',
    )
    .option(
      '--wait-for-reset',
      'Permit exactly ONE bounded wait for a reported quota reset, holding no execution ' +
        'lease while it waits. Only with --automatic-resume-only, only when the reset time ' +
        'is the single check still refusing the resume, and only with --max-wait-ms.',
    )
    .option(
      '--max-wait-ms <n>',
      'Bound on that one wait, in milliseconds. Required with --wait-for-reset -- there is ' +
        `no default -- and at most ${String(MAX_WAIT_MS_CEILING)} (24 hours).`,
    )
    .action(async (options: RunOptions) => {
      try {
        // Before the repository is resolved, before a lease, before a preflight:
        // a combination this command refuses is refused while nothing has
        // happened yet. Two grants at once and a wait nobody bounded are input
        // defects, and code 2 tells a scheduler that invoking again with the
        // same arguments repeats exactly.
        const refusal = refuseArguments(options);
        if (refusal !== null) {
          process.stdout.write(
            `\nFailure      : ${refusal.code} — ${refusal.sentence}\n\n` +
              `${READ_ONLY_TRAILER}\n\n`,
          );
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        const resolution = await resolveRepository({ repositoryPath: options.repository });
        if (!resolution.ok) {
          // A resolution failure is the answer, not an accident: a closed code
          // plus a static sentence, exactly as the resolver produced them.
          process.stdout.write(
            `\nRepository   : could not be resolved\n` +
              `Failure      : ${resolution.code} — ${resolution.detail}\n\n` +
              `${READ_ONLY_TRAILER}\n\n`,
          );
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        const repository = resolution.repository;
        const taskId = options.task ?? null;

        // The read-only default, unchanged and load-bearing: neither grant was
        // given, so this plans and changes nothing. `--automatic-resume-only`
        // is a *second* way to ask for execution, added beside the promise
        // rather than inside it — a bare `run` still cannot write.
        const unattended = options.automaticResumeOnly === true;
        if (options.attended !== true && !unattended) {
          process.exitCode = await reportPlan(repository, taskId, true);
          return;
        }

        // Parsed here rather than by commander so that a bad value is refused
        // before anything is resolved further, and with this command's own
        // vocabulary rather than a parser's message.
        const maxSteps = options.maxSteps === undefined ? DEFAULT_MAX_STEPS : Number(options.maxSteps);
        if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
          process.stdout.write(
            `\nFailure      : MAX_STEPS_INVALID — --max-steps must be a positive whole number.\n\n` +
              `${READ_ONLY_TRAILER}\n\n`,
          );
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        // Each bound parsed with this command's own vocabulary, and each
        // refused before anything is resolved further. A separate code per flag
        // rather than one shared "bad number": an operator who mistyped one is
        // not helped by being told another is wrong.
        const maxInvocations =
          options.maxInvocations === undefined
            ? DEFAULT_MAX_INVOCATIONS
            : Number(options.maxInvocations);
        if (!Number.isSafeInteger(maxInvocations) || maxInvocations < 1) {
          process.stdout.write(
            `\nFailure      : MAX_INVOCATIONS_INVALID — --max-invocations must be a positive whole number.\n\n` +
              `${READ_ONLY_TRAILER}\n\n`,
          );
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }

        if (unattended) {
          // The task must be named. Selection decides which task to *start*,
          // and this mode may not start anything, so a selector answer here
          // would be a task nobody is going to continue.
          if (taskId === null) {
            process.stdout.write(
              `\nFailure      : TASK_REQUIRED_FOR_AUTOMATIC_RESUME — --automatic-resume-only ` +
                `continues one named task and never selects one. Pass --task.\n\n` +
                `${READ_ONLY_TRAILER}\n\n`,
            );
            process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
            return;
          }

          // Its own code and its own ceiling, parsed the same way every other
          // bound in this command is. `isUsableWaitBound` is the module's, so
          // the CLI and the controller cannot disagree about what is usable.
          let wait: ResetWaitPolicy = { wait: false };
          if (options.waitForReset === true) {
            const maxWaitMs = Number(options.maxWaitMs);
            if (!isUsableWaitBound(maxWaitMs)) {
              process.stdout.write(
                `\nFailure      : MAX_WAIT_MS_INVALID — --max-wait-ms must be a whole number of ` +
                  `milliseconds between 1 and ${String(MAX_WAIT_MS_CEILING)}.\n\n` +
                  `${READ_ONLY_TRAILER}\n\n`,
              );
              process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
              return;
            }
            wait = { wait: true, maxWaitMs };
          }

          process.exitCode = await executeUnattendedAutoResume(
            options.repository,
            repository,
            taskId,
            { maxSteps, maxInvocations, wait },
            seams,
          );
          return;
        }

        process.exitCode = await executeAttended(
          repository,
          taskId,
          {
            maxSteps,
            maxInvocations,
            recoverStaleLease: options.recoverStaleLease === true,
          },
          seams,
        );
      } catch (error: unknown) {
        // An unexpected failure must not print an exception message: those
        // routinely quote CLI output and filesystem paths (AO-002). Fail
        // closed through the central safe formatter.
        process.stderr.write(`agent-loop run: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
