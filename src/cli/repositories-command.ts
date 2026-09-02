/**
 * `agent-loop repositories` — which repositories this operator enlisted, what is
 * next across all of them (M2 slice 3), and, with `--attended`, driving several
 * of them at once under a bound the operator wrote down (M2 slice 5).
 *
 * ── No `--repository`, and that is the point ───────────────────────────────
 *
 * Every other command that names a repository takes `--repository <path>`,
 * required and never defaulted. This one takes none: its subject *is* the
 * registry, and an option naming one repository would contradict the question.
 * `publication authorisations` reached the same shape for the same reason — the
 * store is outside every repository, and each record names its own.
 *
 * ── Read-only is still the default, and it is the whole default ────────────
 *
 * Without `--attended` the command reads one file under this OS user's profile,
 * resolves each enlisted repository through the ordinary resolver, plans each
 * through the ordinary planner, and prints. It acquires no lease, starts no
 * agent, prepares no workspace, writes no task state, creates no branch and
 * touches no remote. That is unchanged from slice 3, and the grant is a *second*
 * way to ask rather than a change to the first — exactly the shape
 * `run-command.ts` uses, where a bare `run` still cannot write.
 *
 * It does start processes even then, and says so plainly: `resolveRepository`
 * runs several `git` children per repository, through the one seam every
 * subprocess in this build goes through (`doctor/exec.ts` →
 * `boundary/owned-command.ts`). With no lease held there is no accountant
 * installed, so those launches are announced to nobody and permitted — which is
 * `openOwnedLaunch`'s documented answer when nothing is installed, and exactly
 * what read-only `run` and `doctor` already do.
 *
 * ── What `--attended` changes, and the rule it does not drop ───────────────
 *
 * With the grant, the resolved repositories go to `run/repository-coordinator.ts`,
 * which admits up to `maxConcurrentRepositories` of them at once and drives each
 * through the ordinary `driveLifecycle`. So a **selector now chooses what
 * starts**, which slice 3 deliberately did not do, and the sentence this header
 * used to carry — that no path exists from a selector to execution — is retired
 * rather than quietly left standing.
 *
 * What is *not* dropped is the rule that sentence was protecting. The three
 * grants that authorise a destructive departure — `--recover-stale-lease`,
 * `--remediate-verify-failure`, `--continue-human-decision` — are not options on
 * this command and are passed as `false` on every admission. A selector may
 * choose what to start; it may still not choose the subject of a destructive
 * act, and that is the half of the old rule that was load-bearing.
 *
 * The other retired sentence is about accounting. This header used to note that
 * holding no lease keeps "nothing in this build holds two leases in one process"
 * true, and warn that otherwise "an epoch that outlived its release would
 * account another repository's subprocesses to itself". That hazard is real —
 * it was reproduced on disk before this slice, with one repository's helper and
 * child pids written into another's register — and it is closed by giving the
 * announcement a subject rather than by refusing to hold two leases. See
 * `boundary/owned-launch-accounting.ts`.
 *
 * ── The exit code is the plan's, and refusals are code 2 ───────────────────
 *
 * Three things can go wrong before a plan exists — the profile, the registry
 * document, and resolving what it names — and all three are "the input cannot be
 * planned", which this build's exit contract already calls 2. Two refusal
 * vocabularies carry them — the registry document's, which carries
 * `PROFILE_UNAVAILABLE` as well, and resolution's — and both map to codes in
 * `run-exit-codes.ts` with every other one, each total over its vocabulary by
 * `satisfies Record<…>`, rather than being chosen here. The plan's own codes map
 * there too; that one is not a refusal vocabulary, because `TASK_SELECTED` and
 * `ALL_TASKS_COMPLETE` are 0.
 *
 * Two outcomes are decided in this file, and neither is a refusal in that sense.
 * `NOT_REGISTERED` says the operator has no registry file at all: an absent
 * input rather than an unusable one, so it carries no refusal code and appears
 * in no vocabulary there. It is 2 for the same reason the refusals are — there
 * is nothing to plan — and it is written at the call site because there is no
 * total map for it to belong to. The other is `EXIT_RUN_UNEXPECTED`, written in
 * the Commander action's `catch`: the only non-2 failure this command can
 * produce, and the one an operator most needs told apart from a refusal.
 */

import type { Command } from 'commander';

import { planAcrossRepositories } from '../plan/plan-across-repositories.js';
import {
  loadRepositoryRegistry,
  repositoryRegistryPath,
  resolveRegisteredRepositories,
} from '../registry/repository-registry.js';
import { formatSafeError } from '../core/safe-error.js';
import type { AgentRunner } from '../agent/agent-command.js';
import type { AuthPreflightEvidence } from '../core/auth-preflight-evidence.js';
import type { VerificationRunner } from '../verify/verify-command.js';
import { driveRepositories } from '../run/repository-coordinator.js';
import { runGitCommand } from '../worktree/git-command.js';
import { DEFAULT_MAX_INVOCATIONS, DEFAULT_MAX_STEPS, onceOnlyPreflight } from './run-command.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_UNEXPECTED,
  exitCodeForCrossRepositoryPlan,
  exitCodeForCrossRepositoryRun,
  exitCodeForRegistryResolution,
  exitCodeForRepositoryRegistry,
} from './run-exit-codes.js';
import {
  renderCrossRepositoryPlan,
  renderCrossRepositoryRun,
  renderRegistryOutcome,
  renderRegistryResolutionFailure,
} from './render-repositories.js';

const DESCRIPTION = [
  'Which repositories this machine’s operator has enlisted for orchestration, and which single',
  'task is next across all of them. Read-only unless --attended is given.',
  '',
  'The list comes from one file under this OS user’s profile —',
  '<user profile>/.agent-orchestrator/repositories.yaml — and from nowhere else: not from a',
  'repository profile, not from a commit, not from an option and not from the environment. A',
  'repository cannot enlist itself, or another repository, by committing a file.',
  '',
  'There is no --repository option, deliberately: the subject of this command is the registry,',
  'and naming one repository would contradict the question. Every repository is shown with both',
  'its declared id and its canonical root, because two enlisted repositories may legitimately',
  'declare the same id — two clones of one remote do — and the root is what the acting commands',
  'take.',
  '',
  'Selection is the ordinary per-repository ranking with one element appended after the task id:',
  'the canonical repository root. Within one repository the answer is unchanged; across',
  'repositories the new element decides only the case the single-repository contract had no',
  'answer for, two eligible tasks sharing an id. No repository outranks another.',
  '',
  'If any enlisted repository cannot be planned, nothing is selected and the refusal names it. A',
  'selection made over the repositories that happened to read cleanly would turn a configuration',
  'mistake into a scheduling decision. Under --attended that holds for every admission decision',
  'the run makes: a planning refusal stops it admitting anything further. It cannot un-start what',
  'is already running, so a refusal that arrives mid-run is reported as one — the run waits for',
  'what it started, and says the configuration needs a look.',
  '',
  'Without --attended this command acts on nothing: no execution lease, no agent, no workspace,',
  'no task state and no remote. It does start `git` children to resolve each repository, through',
  'the same seam every subprocess in this build goes through.',
  '',
  'With --attended it drives them, and it keeps going until nothing is left to admit. At most',
  'one task of a repository runs at a time; over the whole invocation a repository may be driven',
  'through as many of its tasks as become admissible, one after another. What is bounded is how',
  'many repositories run at once: maxConcurrentRepositories in repositories.yaml, an integer from',
  '1 to 8, and 1 when the file does not say, which is what every earlier build did.',
  '',
  'Slots are filled from the same ranking this report prints, best first, skipping any repository',
  'that is already executing and any task this invocation has already driven. A repository whose',
  'next task ranks first therefore does not stall the others, and no repository’s own task order',
  'is reinterpreted.',
  '',
  'Only the ordinary attended grant is available here. Recovering a stale lease, continuing a',
  'BLOCKED_VERIFY task and continuing a HUMAN_DECISION_REQUIRED task each authorise a',
  'destructive departure and stay bound to a repository named on the command line with',
  '`agent-loop run --repository <path>`: a selector may choose what starts and may not choose',
  'the subject of one of those.',
].join('\n');

/** Test seam. Production registers the command with no seams at all. */
export interface RepositoriesCommandSeams {
  readonly loadRepositoryRegistry?: typeof loadRepositoryRegistry;
  readonly resolveRegisteredRepositories?: typeof resolveRegisteredRepositories;
  readonly repositoryRegistryPath?: typeof repositoryRegistryPath;
  readonly write?: (text: string) => void;
  /** The coordinator. Production passes nothing. */
  readonly driveRepositories?: typeof driveRepositories;
  /** Forwarded to the coordinator, and only reached under `--attended`. */
  readonly authPreflight?: () => Promise<AuthPreflightEvidence | null>;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
}

/** What the operator asked for. Parsed and refused before anything is resolved. */
export interface RepositoriesRunGrant {
  readonly maxSteps: number;
  readonly maxInvocations: number;
}

/**
 * The whole action, as a function of its seams.
 *
 * Separated from the Commander wiring so the report and the exit code can be
 * driven directly. It returns the exit code rather than setting it, for the same
 * reason: a value can be asserted on.
 *
 * `grant` is `null` for the read-only default and carries the operator's bounds
 * when `--attended` was given. Definite rather than inferred: this function does
 * not read `process.argv` and cannot decide for itself whether an operator is
 * present.
 */
export async function reportRepositories(
  seams: RepositoriesCommandSeams = {},
  grant: RepositoriesRunGrant | null = null,
): Promise<number> {
  const load = seams.loadRepositoryRegistry ?? loadRepositoryRegistry;
  const resolveAll = seams.resolveRegisteredRepositories ?? resolveRegisteredRepositories;
  const pathOf = seams.repositoryRegistryPath ?? repositoryRegistryPath;
  const write = seams.write ?? ((text: string): void => void process.stdout.write(text));

  // The path is only ever *displayed*. Deriving it can throw when the operating
  // system will not say where the profile is, and the registry read answers
  // `PROFILE_UNAVAILABLE` for that same condition — so a throw here must not
  // become a different, worse answer to the same question.
  let path: string;
  try {
    path = pathOf();
  } catch {
    path = '<unavailable>';
  }

  const registry = load();
  const head = renderRegistryOutcome(registry, path);
  if (registry.state !== 'REGISTERED') {
    write(`${head}\n`);
    return registry.state === 'NOT_REGISTERED'
      ? EXIT_RUN_INPUT_UNUSABLE
      : exitCodeForRepositoryRegistry(registry.code);
  }

  const resolved = await resolveAll(registry.entries);
  if (!resolved.ok) {
    write(`${head}\n${renderRegistryResolutionFailure(resolved)}\n`);
    return exitCodeForRegistryResolution(resolved.code);
  }

  if (grant === null) {
    const plan = planAcrossRepositories(resolved.repositories);
    write(`${head}\n${renderCrossRepositoryPlan(plan)}\n`);
    return exitCodeForCrossRepositoryPlan(plan.code);
  }

  // The registry read is the one place the capacity comes from. Not an option,
  // and deliberately: how many writer agents this machine runs at once is a
  // property of the machine its operator wrote down, not of one invocation — and
  // an option would let a scheduler raise it without anybody editing anything.
  const run = await (seams.driveRepositories ?? driveRepositories)(
    {
      repositories: resolved.repositories,
      maxConcurrentRepositories: registry.maxConcurrentRepositories,
      maxSteps: grant.maxSteps,
      maxInvocations: grant.maxInvocations,
    },
    {
      now: () => new Date().toISOString(),
      git: runGitCommand,
      // One preflight for every repository in this run: `onceOnlyPreflight`
      // memoises it, so the subscription CLIs start once however many
      // repositories follow. `run-command.ts` states the rule this obeys —
      // "Two memoising preflights in one binary are two chances for one
      // invocation to start the subscription CLIs twice" — and several
      // repositories in one process is that hazard multiplied by the capacity.
      authPreflight: onceOnlyPreflight(seams.authPreflight),
      ...(seams.agent !== undefined ? { agent: seams.agent } : {}),
      ...(seams.verify !== undefined ? { verify: seams.verify } : {}),
    },
  );

  write(`${head}\n${renderCrossRepositoryRun(run)}\n`);
  return exitCodeForCrossRepositoryRun(run);
}

interface RepositoriesOptions {
  readonly attended?: boolean;
  readonly maxSteps?: string;
  readonly maxInvocations?: string;
}

/**
 * The bounds, parsed with this command's own vocabulary.
 *
 * Answers the grant, or the refusal sentence to print. Parsed **here** rather
 * than by Commander so a bad value is refused before the registry is read, and
 * with a separate code per flag: an operator who mistyped one is not helped by
 * being told another is wrong. The codes and the sentences are `run`'s, because
 * a second spelling of `--max-steps must be a positive whole number` is a second
 * thing to keep true.
 *
 * A bound given **without** `--attended` is refused rather than ignored. It
 * cannot be honoured — nothing is driven — so accepting it silently would let an
 * operator believe a run was bounded when no run happened at all.
 */
function grantFor(
  options: RepositoriesOptions,
): { readonly grant: RepositoriesRunGrant | null } | { readonly refusal: string } {
  const attended = options.attended === true;
  if (!attended) {
    if (options.maxSteps !== undefined || options.maxInvocations !== undefined) {
      return {
        refusal:
          'BOUND_WITHOUT_GRANT — --max-steps and --max-invocations bound a run, and without ' +
          '--attended there is no run to bound.',
      };
    }
    return { grant: null };
  }

  const maxSteps = options.maxSteps === undefined ? DEFAULT_MAX_STEPS : Number(options.maxSteps);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    return { refusal: 'MAX_STEPS_INVALID — --max-steps must be a positive whole number.' };
  }

  const maxInvocations =
    options.maxInvocations === undefined
      ? DEFAULT_MAX_INVOCATIONS
      : Number(options.maxInvocations);
  if (!Number.isSafeInteger(maxInvocations) || maxInvocations < 1) {
    return {
      refusal: 'MAX_INVOCATIONS_INVALID — --max-invocations must be a positive whole number.',
    };
  }

  return { grant: { maxSteps, maxInvocations } };
}

export function registerRepositoriesCommand(
  program: Command,
  seams: RepositoriesCommandSeams = {},
): void {
  program
    .command('repositories')
    .description(DESCRIPTION)
    .option(
      '--attended',
      'Drive the enlisted repositories instead of reporting, until nothing is left to admit. ' +
        'Several repositories may execute at once — at most one task of each at a time, and as ' +
        'many of that repository’s tasks over the invocation as become admissible — bounded by ' +
        'maxConcurrentRepositories in repositories.yaml. Without this the command writes nothing.',
    )
    .option(
      '--max-steps <n>',
      `Step budget handed to each admitted task. Default ${String(DEFAULT_MAX_STEPS)}. Needs --attended.`,
    )
    .option(
      '--max-invocations <n>',
      `How many times each admitted task may be driven. Default ${String(DEFAULT_MAX_INVOCATIONS)}. Needs --attended.`,
    )
    .action(async (options: RepositoriesOptions) => {
      try {
        // Before the registry is read and before a single `git` child: a
        // combination this command refuses is refused while nothing has
        // happened yet, and code 2 tells a scheduler that invoking again with
        // the same arguments repeats exactly.
        const asked = grantFor(options);
        if ('refusal' in asked) {
          process.stdout.write(`\nFailure      : ${asked.refusal}\n\n`);
          process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
          return;
        }
        process.exitCode = await reportRepositories(seams, asked.grant);
      } catch (error: unknown) {
        // Never `error.message`: an exception's text routinely embeds untrusted
        // file contents and full paths. Everything goes through the central safe
        // formatter (AO-002), exactly as `main()` does.
        process.stderr.write(`agent-loop: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
