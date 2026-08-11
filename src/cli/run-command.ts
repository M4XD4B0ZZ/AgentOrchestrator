import type { Command } from 'commander';

import type { AgentRunner } from '../agent/agent-command.js';
import { runAuthPreflight } from '../auth/auth-preflight.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import { formatSafeError } from '../core/safe-error.js';
import { runCapabilityDump } from '../doctor/capabilities.js';
import { resolveRepository, type ResolvedRepository } from '../repo/resolve-repository.js';
import { renderRunPlan, READ_ONLY_TRAILER } from '../run/render-run-plan.js';
import { planRun } from '../run/run-plan.js';
import { selectRunTask, runTask } from '../run/run-driver.js';
import { startTask } from '../run/start-task.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import { runGitCommand } from '../worktree/git-command.js';
import {
  GRANT_WITHHELD_SENTENCE,
  line,
  renderAttendedRun,
  START_OUTCOME_SENTENCES,
} from './render-attended-run.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_UNEXPECTED,
  exitCodeForPlan,
  exitCodeForRunOutcome,
  exitCodeForStartOutcome,
  type CliExitCode,
} from './run-exit-codes.js';

/**
 * `agent-loop run` — the front door, in two modes.
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
 * rule `RunRequest` states about `attendedContinuation` and `authEvidence`.
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
  readonly maxSteps?: string;
}

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
 */
function onceOnlyPreflight(
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
 * Start the task if it needs starting, then drive it.
 *
 * The exit code comes from whichever half stopped first, and the report names
 * that half. A start outcome that is neither `STARTED` nor `ALREADY_STARTED`
 * ends the invocation there: there is nothing to drive, and its own code says
 * why.
 */
async function executeAttended(
  repository: ResolvedRepository,
  requestedTaskId: string | null,
  maxSteps: number,
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

  const authPreflight = onceOnlyPreflight(seams.authPreflight);
  const start = await startTask(
    { repository, taskId },
    { git: runGitCommand, now: () => new Date().toISOString(), authPreflight },
  );

  if (start.outcome !== 'STARTED' && start.outcome !== 'ALREADY_STARTED') {
    process.stdout.write(renderAttendedRun(repository, taskId, start, null));
    return exitCodeForStartOutcome(start.outcome);
  }

  // On `ALREADY_STARTED` the preflight has not run yet, because `startTask`
  // returned before reaching it. Auth is a requirement of *executing*, not of
  // starting, so it is proven here on every path that is about to drive.
  const evidence = await authPreflight();
  if (evidence === null) {
    process.stdout.write(
      renderAttendedRun(repository, taskId, start, null, [
        line('Auth', 'AUTH_PREFLIGHT_FAILED'),
        `  ${START_OUTCOME_SENTENCES.AUTH_PREFLIGHT_FAILED}`,
      ]),
    );
    return exitCodeForStartOutcome('AUTH_PREFLIGHT_FAILED');
  }

  const run = await runTask(
    {
      repository,
      taskId,
      // The task id, which is all this command legitimately has: it is a value
      // the id grammar already validated, and it is not prose. The prose the
      // agents actually receive is read inside the driver, from the worktree it
      // authorised (`readExecutionBrief`) — so this command authors no prompt
      // text, which is the property `run-driver.ts` insists on for itself.
      taskBrief: taskId,
      // The grant, and only here. `true` because this function is only reached
      // when `--attended` was given.
      attendedContinuation: true,
      authEvidence: evidence,
      maxSteps,
    },
    {
      now: () => new Date().toISOString(),
      git: runGitCommand,
      ...(seams.agent !== undefined ? { agent: seams.agent } : {}),
      ...(seams.verify !== undefined ? { verify: seams.verify } : {}),
    },
  );

  process.stdout.write(renderAttendedRun(repository, taskId, start, run));
  return exitCodeForRunOutcome(run.outcome);
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
    .action(async (options: RunOptions) => {
      try {
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

        if (options.attended !== true) {
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

        process.exitCode = await executeAttended(repository, taskId, maxSteps, seams);
      } catch (error: unknown) {
        // An unexpected failure must not print an exception message: those
        // routinely quote CLI output and filesystem paths (AO-002). Fail
        // closed through the central safe formatter.
        process.stderr.write(`agent-loop run: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
