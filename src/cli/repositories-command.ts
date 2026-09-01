/**
 * `agent-loop repositories` — which repositories this operator enlisted, and
 * which task is next across all of them (M2 slice 3).
 *
 * ── No `--repository`, and that is the point ───────────────────────────────
 *
 * Every other command that names a repository takes `--repository <path>`,
 * required and never defaulted. This one takes none: its subject *is* the
 * registry, and an option naming one repository would contradict the question.
 * `publication authorisations` reached the same shape for the same reason — the
 * store is outside every repository, and each record names its own.
 *
 * ── It is read-only, and the boundary is stated rather than implied ────────
 *
 * The command reads one file under this OS user's profile, resolves each
 * enlisted repository through the ordinary resolver, and plans each through the
 * ordinary planner. That is all. Specifically it does **not**:
 *
 *  - acquire an execution lease, for any repository, at any point. The invariant
 *    `boundary/owned-launch-accounting.ts` relies on — "nothing in this build
 *    holds two leases in one process" — is untouched by this command, and that
 *    matters: with several repositories in one process, an epoch that outlived
 *    its release would otherwise account another repository's subprocesses to
 *    itself;
 *  - start an agent, prepare a workspace, write task state, create a branch or
 *    touch a remote;
 *  - reach `run`. `run-command.ts` is not modified by this slice and still binds
 *    every one of its grants — `--attended`, `--recover-stale-lease`,
 *    `--remediate-verify-failure`, `--continue-human-decision` — to a repository
 *    the operator named on the command line. A selector choosing the subject of
 *    a destructive grant is the failure that rule exists to prevent, and this
 *    slice does not create a path to it.
 *
 * It does start processes, and says so plainly: `resolveRepository` runs several
 * `git` children per repository, through the one seam every subprocess in this
 * build goes through (`doctor/exec.ts` → `boundary/owned-command.ts`). With no
 * lease held there is no accountant installed, so those launches are announced
 * to nobody and permitted — which is `openOwnedLaunch`'s documented answer when
 * nothing is installed, and exactly what read-only `run` and `doctor` already do.
 *
 * ── The exit code is the plan's, and refusals are code 2 ───────────────────
 *
 * Three things can go wrong before a plan exists — the profile, the registry
 * document, and resolving what it names — and all three are "the input cannot be
 * planned", which this build's exit contract already calls 2. The three
 * refusal vocabularies map to codes in `run-exit-codes.ts` with every other
 * one, each total over its vocabulary by `satisfies Record<…>`, rather than
 * being chosen here.
 *
 * One outcome is decided here, and it is not a refusal: `NOT_REGISTERED` says
 * the operator has no registry file at all. That is an absent input rather than
 * an unusable one, so it carries no refusal code and appears in no vocabulary
 * there. It is 2 for the same reason the refusals are — there is nothing to
 * plan — and it is written at the call site because there is no total map for
 * it to belong to.
 */

import type { Command } from 'commander';

import { planAcrossRepositories } from '../plan/plan-across-repositories.js';
import {
  loadRepositoryRegistry,
  repositoryRegistryPath,
  resolveRegisteredRepositories,
} from '../registry/repository-registry.js';
import { formatSafeError } from '../core/safe-error.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_UNEXPECTED,
  exitCodeForCrossRepositoryPlan,
  exitCodeForRegistryResolution,
  exitCodeForRepositoryRegistry,
} from './run-exit-codes.js';
import {
  renderCrossRepositoryPlan,
  renderRegistryOutcome,
  renderRegistryResolutionFailure,
} from './render-repositories.js';

const DESCRIPTION = [
  'Read-only. Which repositories this machine’s operator has enlisted for orchestration, and',
  'which single task is next across all of them.',
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
  'mistake into a scheduling decision.',
  '',
  'This command acts on nothing: no execution lease, no agent, no workspace, no task state and',
  'no remote. It does start `git` children to resolve each repository, through the same seam',
  'every subprocess in this build goes through.',
].join('\n');

/** Test seam. Production registers the command with no seams at all. */
export interface RepositoriesCommandSeams {
  readonly loadRepositoryRegistry?: typeof loadRepositoryRegistry;
  readonly resolveRegisteredRepositories?: typeof resolveRegisteredRepositories;
  readonly repositoryRegistryPath?: typeof repositoryRegistryPath;
  readonly write?: (text: string) => void;
}

/**
 * The whole action, as a function of its seams.
 *
 * Separated from the Commander wiring so the report and the exit code can be
 * driven directly. It returns the exit code rather than setting it, for the same
 * reason: a value can be asserted on.
 */
export async function reportRepositories(
  seams: RepositoriesCommandSeams = {},
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

  const plan = planAcrossRepositories(resolved.repositories);
  write(`${head}\n${renderCrossRepositoryPlan(plan)}\n`);
  return exitCodeForCrossRepositoryPlan(plan.code);
}

export function registerRepositoriesCommand(
  program: Command,
  seams: RepositoriesCommandSeams = {},
): void {
  program
    .command('repositories')
    .description(DESCRIPTION)
    .action(async () => {
      try {
        process.exitCode = await reportRepositories(seams);
      } catch (error: unknown) {
        // Never `error.message`: an exception's text routinely embeds untrusted
        // file contents and full paths. Everything goes through the central safe
        // formatter (AO-002), exactly as `main()` does.
        process.stderr.write(`agent-loop: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      }
    });
}
