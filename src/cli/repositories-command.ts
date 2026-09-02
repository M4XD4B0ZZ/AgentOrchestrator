/**
 * `agent-loop repositories` — which repositories this operator enlisted, what is
 * next across all of them (M2 slice 3), with `--attended`, driving several of
 * them at once under a bound the operator wrote down (M2 slice 5), and with
 * `--wait-for-reset`, waiting out durably recorded quota resets between passes
 * (M3 slice 1).
 *
 * ── What M3-01 added here, and what it deliberately did not ────────────────
 *
 * One loop, above the coordinator: `schedule/scheduler.ts`. Given the wait
 * grant, the command runs a coordinator pass, reads every enlisted repository's
 * durable task states through `schedule/durable-wake.ts`, and — if any of them
 * records a quota reset still ahead — sleeps until just past the soonest and
 * plans again.
 *
 * The invocation **without** `--wait-for-reset` is unchanged, and unchanged down
 * to what it opens: the scheduler refuses the wait before it scans anything, so
 * an ordinary `repositories --attended` still enumerates no runtime directory
 * and still prints the report it always printed, graded by the same codes.
 *
 * No authority was added. Every admission still runs under the ordinary attended
 * grant with all four destructive permissions `false`; the wait changes *when*
 * passes happen and nothing about what a pass may do.
 *
 * The scheduler is the only place in this build that installs a process signal
 * handler, and it does so only for an invocation that can sleep. See
 * `shutdownRequest`.
 *
 * ── What M3-02 added here ──────────────────────────────────────────────────
 *
 * Two things, and both only for an invocation that asked to wait:
 *
 *  - `--idle-poll-ms`, which makes a pass that leaves nothing recorded to wait
 *    for sleep that interval and plan again instead of ending. Optional, with no
 *    default: without it the command behaves exactly as it always has, because a
 *    default there would turn every existing scheduler invocation into a process
 *    that no longer exits;
 *  - the **operator-attention outbox**. The moment each coordinator pass ends,
 *    this file reads the same durable task states the wake scan reads and writes
 *    down each one that no machine can move and a person can — one file per
 *    condition, under the orchestrator home, named after the condition. Where a
 *    `notify.yaml` is configured, each newly written item is also sent to it
 *    once.
 *
 * "The moment each pass ends" is load-bearing rather than descriptive. The first
 * spelling settled the outbox when the *cycle* was recorded, which is after that
 * cycle's sleep — so a scope violation found at minute zero of a day-long quota
 * wait was written down and announced a day later. The seam is now a pass
 * observation and is called before anything about waiting is decided.
 *
 * The scheduler knows about neither of the outbox's halves. It hands over a
 * finished pass and the repositories that pass drove; everything about what
 * needs a person, what was already said, and who to tell is decided here. That
 * is the layering `tests/m3-01-persistent-scheduler.test.ts` pins structurally,
 * and it is the right one on its own terms: this file already owns every
 * question about the operator's own profile.
 *
 * An invocation **without** `--wait-for-reset` reads no notification
 * configuration, enumerates no runtime directory and touches no store — the same
 * promise the wake scan already keeps, kept the same way.
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
import { runGitCommand } from '../worktree/git-command.js';
import type { driveRepositories } from '../run/repository-coordinator.js';
import {
  createAttentionNotifier,
  pushAttentionItems,
  type AttentionNotifier,
} from '../notify/attention-notification.js';
import { settleAttention } from '../notify/attention-outbox.js';
import { renderAttention, type AttentionReport } from './render-attention.js';
import {
  driveScheduler,
  isUsableCycleBound,
  isUsableIdlePollBound,
  MAX_SCHEDULER_CYCLES,
  MIN_IDLE_POLL_MS,
  MAX_WAIT_MS_CEILING,
  type PassObservation,
  type SchedulerRegistryRead,
  type SchedulerWaitPolicy,
  type ShutdownSeam,
} from '../schedule/scheduler.js';
import { isUsableWaitBound } from '../run/unattended-resume.js';
import { DEFAULT_MAX_INVOCATIONS, DEFAULT_MAX_STEPS, onceOnlyPreflight } from './run-command.js';
import { renderScheduler } from './render-schedule.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_UNEXPECTED,
  exitCodeForCrossRepositoryPlan,
  exitCodeForRegistryResolution,
  exitCodeForRepositoryRegistry,
  exitCodeForScheduler,
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
  '',
  'With --wait-for-reset it keeps going across quota resets. After every pass — whatever that',
  'pass came to — it reads every enlisted repository’s durable task states, takes the soonest',
  'reported quota reset still ahead, waits until just past it and plans again. A reset that',
  'matured while the pass was running is not waited for: the pass decided that task too early, so',
  'another pass runs at once. While it waits it holds no',
  'execution lease, runs no agent, prepares no workspace and writes no task state — the wait sits',
  'entirely between passes, and nothing sleeps until every repository the pass drove has been',
  'shown to have given its lease back. An admission that threw, or that ends unable to say it',
  'released, stops the invocation rather than being slept through.',
  '',
  'The wait is not stored anywhere. It is re-read from each task’s own state file before every',
  'sleep, so stopping this process loses nothing and invoking it again reconstructs the same wait',
  'without being told which task or which instant. Nothing else is carried across a sleep either:',
  'the registry is read again, and the auth preflight is proven again.',
  '',
  'With --idle-poll-ms it also keeps going when a pass leaves NOTHING recorded to wait for,',
  'sleeping that interval and planning again. Without it such a pass ends the invocation, which',
  'is what this command has always done. That option exists because the wake horizon is a',
  'horizon of recorded quota resets and nothing else: work that becomes runnable for any other',
  'reason — a task somebody writes, a block somebody clears — is invisible to it.',
  '',
  'A waiting invocation also keeps an operator-attention outbox. After every pass it reads the',
  'same durable task states and writes down each one that no machine can move and a person',
  'can — one file per condition, under your orchestrator home, named after the condition so a',
  'repeated pass writes nothing new. Where a notify.yaml is configured, each newly written item',
  'is also sent to it once. An invocation without --wait-for-reset reads no notification',
  'configuration and touches no store.',
  '',
  'It waits for one thing only — a reset an agent CLI reported and this build recorded. A quota',
  'block that records NO reset time has no machine-understandable wake, is never waited for here,',
  'and stays the operator’s decision through `agent-loop run --repository <path> --task <id>',
  '--attended --continue-usage-limit`. Nothing here invents an interval, and there is no',
  'recurring job, no schedule anyone can author, no notification and no daemon.',
  '',
  'Both bounds are required and neither has a default: --max-wait-ms bounds one sleep, and',
  '--max-cycles bounds how many passes the invocation makes in total. A reset further away than',
  'the first ends the invocation instead of sleeping, and the wait is left on disk untouched.',
  '',
  'For the whole of a waiting invocation — including its first pass, because the handler is',
  'installed before it — one interrupt asks the scheduler not to plan another pass, and a second',
  'hands the signal back to the operating system. A pass already running is not reached by',
  'either: neither the coordinator nor the lifecycle has a shutdown notion, and what a console',
  'interrupt does to the agent processes a pass has started is the operating system’s affair',
  'and is not claimed here. Stopping is safe at any moment for a reason that is this build’s:',
  'a wait holds nothing, and a death mid-pass is the ordinary crash every lease recovery in',
  'this build already exists for.',
].join('\n');

/** Test seam. Production registers the command with no seams at all. */
export interface RepositoriesCommandSeams {
  readonly loadRepositoryRegistry?: typeof loadRepositoryRegistry;
  readonly resolveRegisteredRepositories?: typeof resolveRegisteredRepositories;
  readonly repositoryRegistryPath?: typeof repositoryRegistryPath;
  readonly write?: (text: string) => void;
  /**
   * The coordinator. Production passes nothing.
   *
   * Kept exactly as it was and forwarded into the scheduler, which drives one
   * of these per cycle. A test that substitutes it substitutes every cycle's
   * pass, which is what it has always meant.
   */
  readonly driveRepositories?: typeof driveRepositories;
  /**
   * The scheduler — the loop **above** the coordinator, added by M3-01.
   *
   * A second seam rather than a replacement for the one above: they answer
   * different questions, and a test that wants to pin what one pass does must
   * not have to reimplement waiting to get at it.
   */
  readonly driveScheduler?: typeof driveScheduler;
  /**
   * The operator-attention notifier, built from this OS user's configuration.
   *
   * A seam so a test can arm a recording transport without writing a
   * `notify.yaml`. It grants nothing: production builds it from the file, and an
   * unconfigured machine produces `NOT_CONFIGURED` whatever is passed here — so
   * "no egress without the file" is not a property of this seam's callers, and
   * it is measured against the shipped artefact where no seam exists at all.
   */
  readonly attentionNotifier?: AttentionNotifier;
  /**
   * Settling the outbox against durable state. Production passes nothing.
   *
   * Separate from the notifier for the reason the scheduler and coordinator
   * seams are separate: one is "what did we find", the other is "who was told",
   * and a test that wants to pin one must not have to reimplement the other.
   */
  readonly settleAttention?: typeof settleAttention;
  /** Forwarded to the scheduler, and only reached under `--attended`. */
  readonly authPreflight?: () => Promise<AuthPreflightEvidence | null>;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
  /**
   * A shutdown request the scheduler may observe while it waits.
   *
   * Only ever supplied by the Commander action, and only when `--wait-for-reset`
   * was given. Passing it unconditionally would install signal handlers on an
   * invocation that cannot sleep, which changes what `Ctrl-C` does to a run that
   * has always died at once — see `shutdownRequest`.
   */
  readonly shutdown?: ShutdownSeam;
}

/** What the operator asked for. Parsed and refused before anything is resolved. */
export interface RepositoriesRunGrant {
  readonly maxSteps: number;
  readonly maxInvocations: number;
  /**
   * Whether this invocation may wait between coordinator passes.
   *
   * `{ wait: false }` reproduces every earlier build exactly: one pass, no scan
   * of any runtime directory, and the same report and exit code the command has
   * always produced.
   */
  readonly wait: SchedulerWaitPolicy;
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
  //
  // Read again after every wait, through the seam below, for the reason the
  // scheduler states: a repository can be enlisted, withdrawn or moved while
  // this process is asleep, and a set resolved before a five-hour sleep would
  // have it driving a repository its operator has since taken away.
  const resolveRegistry = async (): Promise<SchedulerRegistryRead> => {
    const again = load();
    if (again.state !== 'REGISTERED') {
      return {
        ok: false,
        code: again.state === 'NOT_REGISTERED' ? 'NOT_REGISTERED' : again.code,
      };
    }
    const resolvedAgain = await resolveAll(again.entries);
    if (!resolvedAgain.ok) return { ok: false, code: resolvedAgain.code };
    return {
      ok: true,
      repositories: resolvedAgain.repositories,
      maxConcurrentRepositories: again.maxConcurrentRepositories,
    };
  };

  // ── The operator-attention outbox, and why it is installed here ─────────
  //
  // Only for an invocation that asked to wait, which is the unattended mode this
  // capability exists for. A plain `repositories --attended` opens exactly what
  // it always opened: no notification configuration is read, no runtime
  // directory is enumerated and no store is touched. That promise is the same
  // one the wake scan already keeps, and it is kept the same way — by not being
  // reached.
  //
  // The notifier is built **before** the loop, so an operator with a broken
  // notify.yaml is told while they are still standing there rather than eight
  // hours later by the message that never arrives.
  //
  // It lives in this file rather than in the scheduler because the scheduler is
  // pinned against knowing about notification at all, and the pin is right: what
  // to do with a finished pass is the caller's question. The loop hands over a
  // pass and the repositories it drove — the moment that pass ends, before any
  // decision about waiting, so a condition found at minute zero of a day-long
  // wait is written down and announced now.

  const attentionReports: AttentionReport[] = [];
  const notifier = grant.wait.wait
    ? (seams.attentionNotifier ?? createAttentionNotifier())
    : null;

  const observePass = async ({ repositories: driven }: PassObservation): Promise<void> => {
    if (notifier === null) return;
    const settlement = (seams.settleAttention ?? settleAttention)(
      driven.map((entry) => ({
        repositoryId: entry.repository.id,
        repositoryRoot: entry.repository.root,
      })),
      new Date().toISOString(),
    );
    // Only what this pass newly wrote down is announced. An item already in the
    // store was already said, by this process or another one, and saying it
    // again on every cycle is the spam this design exists to avoid.
    const push = await pushAttentionItems(notifier, settlement.raised);
    attentionReports.push({ settlement, push });
  };

  const scheduled = await (seams.driveScheduler ?? driveScheduler)(
    {
      repositories: resolved.repositories,
      maxConcurrentRepositories: registry.maxConcurrentRepositories,
      maxSteps: grant.maxSteps,
      maxInvocations: grant.maxInvocations,
      wait: grant.wait,
    },
    {
      now: () => new Date().toISOString(),
      git: runGitCommand,
      // A **factory**, so each cycle gets its own memo. One preflight for every
      // repository within a cycle: `onceOnlyPreflight` memoises it, so the
      // subscription CLIs start once however many repositories follow.
      // `run-command.ts` states the rule this obeys — "Two memoising preflights
      // in one binary are two chances for one invocation to start the
      // subscription CLIs twice" — and several repositories in one pass is that
      // hazard multiplied by the capacity. What the factory adds is the other
      // half, which V3-08 established: the memo may not cross a sleep, because
      // the artefact carries no freshness and a login proven before a six-hour
      // wait must not authorise the work after it.
      authPreflight: () => onceOnlyPreflight(seams.authPreflight),
      resolveRegistry,
      ...(seams.driveRepositories !== undefined
        ? { driveRepositories: seams.driveRepositories }
        : {}),
      ...(seams.agent !== undefined ? { agent: seams.agent } : {}),
      ...(seams.verify !== undefined ? { verify: seams.verify } : {}),
      ...(seams.shutdown !== undefined ? { shutdown: seams.shutdown } : {}),
      ...(notifier === null ? {} : { observePass }),
    },
  );

  // Two reports, and the first is unchanged down to the byte. An invocation that
  // did not ask to wait made exactly one pass and has exactly one thing to say
  // about it, which is what `repositories --attended` has always printed; adding
  // a cycle header and an `Ending` row to it would be this slice rewriting a
  // report nobody asked it to touch.
  //
  // The first cycle always exists — the loop drives before it decides anything —
  // so the guard below is never the reason a scheduler report is printed. It is
  // written as a guard rather than an assertion because a report that cannot be
  // produced must not become an exception.
  const first = scheduled.cycles[0];
  if (!grant.wait.wait && first !== undefined) {
    write(`${head}\n${renderCrossRepositoryRun(first.run)}\n`);
    return exitCodeForScheduler(scheduled);
  }

  // The attention section sits after the scheduler's own report: it is the last
  // thing an operator reads, because it is the only part of the output that asks
  // them for something. `null` when there is nothing to ask — a run over
  // repositories that all needed nobody gains no section.
  const attention = renderAttention(attentionReports);
  write(`${head}\n${renderScheduler(scheduled)}${attention ?? ''}\n`);
  return exitCodeForScheduler(scheduled);
}

interface RepositoriesOptions {
  readonly attended?: boolean;
  readonly maxSteps?: string;
  readonly maxInvocations?: string;
  readonly waitForReset?: boolean;
  readonly maxWaitMs?: string;
  readonly maxCycles?: string;
  readonly idlePollMs?: string;
}

/**
 * A shutdown request, installed for the duration of a waiting run and removed
 * afterwards.
 *
 * ── Why the handlers are conditional ───────────────────────────────────────
 *
 * `src/` has no process-level signal handler anywhere, and that is not an
 * oversight: every command in this build dies at once on `Ctrl-C`, and every
 * durable guarantee it makes is written to survive exactly that. Installing a
 * handler changes what an interrupt *does*, so it is installed only for an
 * invocation that asked to wait — `repositories --attended` on its own keeps
 * dying at once, byte for byte the behaviour it has always had.
 *
 * ── What the first signal buys, and what the second does ───────────────────
 *
 * The first asks the scheduler to stop: it settles `cancel`, so a sleep in
 * progress returns immediately, and sets `stopped`, so the loop ends rather than
 * planning again. That flag is read at every point where this loop would
 * otherwise commit to more work — before the sleep, between its chunks, after
 * it, either side of the registry re-read, and at the top of the next cycle's
 * refusals.
 *
 * What it does **not** do is reach into a coordinator pass. `driveRepositories`
 * and `driveLifecycle` have no shutdown notion, so a signal that arrives while a
 * pass is running does not end that pass. A second signal therefore removes
 * these handlers and hands the signal back to the operating system, which is the
 * operator's escape from a run they cannot otherwise stop.
 *
 * Deliberately **not** claimed here: what a console interrupt does to the agent
 * processes a pass has already started. On Windows a console `Ctrl-C` is
 * delivered to every process attached to the console, and this build starts
 * agents through a boundary that does not create a new process group — so an
 * interrupt very likely reaches them too. That is a statement about the
 * operating system rather than about this code, it has not been measured here,
 * and an earlier version of this comment asserted the opposite ("an agent that
 * is running keeps running") on no evidence at all.
 *
 * What is safe either way, and is a property of this build: the sleep holds no
 * execution lease and has written nothing, so a death during it leaves correctly
 * parked tasks; and a death during a pass is the ordinary crash that every lease
 * recovery in this build already exists for.
 */
interface ShutdownRequest extends ShutdownSeam {
  /** Removes the handlers. Must run on every path out, including a throw. */
  readonly dispose: () => void;
}

/** The signals this build will treat as a shutdown request. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = Object.freeze([
  'SIGINT',
  'SIGTERM',
  'SIGBREAK',
]);

function shutdownRequest(): ShutdownRequest {
  let requested = false;
  let settle: () => void = () => {
    /* replaced below, before any handler can run */
  };
  const cancel = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const handlers = new Map<NodeJS.Signals, () => void>();
  const dispose = (): void => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = (): void => {
      if (requested) {
        // The second one. Restore the default and let it act: an operator who
        // asks twice is telling this process to stop being clever.
        dispose();
        // ── Why re-raising is not enough on its own ─────────────────────────
        //
        // Measured on Windows 10 with this build's Node:
        //
        //   process.kill(process.pid, 'SIGBREAK')  → throws ENOSYS, and the
        //                                            process keeps running
        //   process.kill(process.pid, 'SIGTERM')   → terminates
        //   process.kill(process.pid, 'SIGINT')    → terminates
        //
        // libuv's Windows self-kill handles `SIGTERM`, `SIGKILL` and `SIGINT`
        // and answers `ENOSYS` for the rest — so on the platform this build
        // supports, re-raising `SIGBREAK` would throw *out of a signal handler*,
        // bypassing the CLI's own `catch` and the safe error formatter with it,
        // and leave the process alive with its handlers gone. The operator's
        // second press would appear to do nothing.
        //
        // So the re-raise is attempted and the exit is guaranteed: whatever the
        // platform does with the signal, an operator who asked twice gets a
        // process that stops.
        try {
          process.kill(process.pid, signal);
        } catch {
          /* the exit below is the answer; the signal was only the polite one */
        }
        process.exit(EXIT_RUN_UNEXPECTED);
      }
      requested = true;
      settle();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return Object.freeze({
    stopped: (): boolean => requested,
    cancel,
    dispose,
  });
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
  const waiting = options.waitForReset === true;

  if (!attended) {
    if (
      options.maxSteps !== undefined ||
      options.maxInvocations !== undefined ||
      options.maxWaitMs !== undefined ||
      options.maxCycles !== undefined ||
      options.idlePollMs !== undefined
    ) {
      return {
        refusal:
          'BOUND_WITHOUT_GRANT — --max-steps, --max-invocations, --max-wait-ms, --max-cycles ' +
          'and --idle-poll-ms bound a run, and without --attended there is no run to bound.',
      };
    }
    // Its own refusal rather than a fifth item in the sentence above, because
    // the two are different mistakes: those are bounds on a run that is not
    // happening, and this is a request to wait between passes there are none of.
    if (waiting) {
      return {
        refusal:
          'WAIT_WITHOUT_GRANT — --wait-for-reset waits between execution passes, and without ' +
          '--attended there are none. Add --attended, or drop it.',
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

  // ── The wait, and its two bounds ─────────────────────────────────────────
  //
  // Both are required with `--wait-for-reset` and neither has a default, for the
  // reason `run --wait-for-reset` gives about its own: a multi-hour sleep
  // invented by a default is a multi-hour sleep nobody asked for, and a cycle
  // count invented by a default is a machine kept busy on nobody's instruction.
  //
  // The bound given without the wait is refused rather than ignored, exactly as
  // a bound without `--attended` is, and for the same reason: accepting it
  // silently would let an operator believe an invocation was bounded when it was
  // never going to wait at all.
  if (!waiting) {
    if (
      options.maxWaitMs !== undefined ||
      options.maxCycles !== undefined ||
      options.idlePollMs !== undefined
    ) {
      return {
        refusal:
          'WAIT_BOUND_WITHOUT_WAIT — --max-wait-ms, --max-cycles and --idle-poll-ms bound a ' +
          'wait, and without --wait-for-reset this invocation makes one pass and stops.',
      };
    }
    return { grant: { maxSteps, maxInvocations, wait: { wait: false } } };
  }

  if (options.maxWaitMs === undefined) {
    return {
      refusal:
        'MAX_WAIT_MS_REQUIRED — --wait-for-reset needs --max-wait-ms. There is no default: this ' +
        'build never invents how long it may sleep.',
    };
  }
  const maxWaitMs = Number(options.maxWaitMs);
  if (!isUsableWaitBound(maxWaitMs)) {
    return {
      refusal:
        `MAX_WAIT_MS_INVALID — --max-wait-ms must be a whole number of milliseconds from 1 to ` +
        `${String(MAX_WAIT_MS_CEILING)} (24 hours).`,
    };
  }

  if (options.maxCycles === undefined) {
    return {
      refusal:
        'MAX_CYCLES_REQUIRED — --wait-for-reset needs --max-cycles. There is no default: how ' +
        'many times this invocation may wake and plan again is the operator’s decision.',
    };
  }
  const maxCycles = Number(options.maxCycles);
  if (!isUsableCycleBound(maxCycles)) {
    return {
      refusal:
        `MAX_CYCLES_INVALID — --max-cycles must be a whole number from 2 to ` +
        `${String(MAX_SCHEDULER_CYCLES)}. The first cycle is the pass that meets the block, so a ` +
        `wait needs at least two.`,
    };
  }

  // ── The idle interval, which is optional where the other two are not ────
  //
  // Absent means the invocation ends when nothing is recorded to wait for, which
  // is what every invocation before M3 slice 2 did. Present means it looks again
  // on that interval instead, until `--max-cycles` is spent or it is stopped.
  //
  // Optional rather than required, and that asymmetry is deliberate. The other
  // two bound something the operator has already asked for by typing
  // `--wait-for-reset`; this one asks for a *different* behaviour, so its
  // absence has to keep meaning what it always meant. A default here would turn
  // every existing scheduler invocation into a process that no longer exits.
  let idlePollMs: number | null = null;
  if (options.idlePollMs !== undefined) {
    idlePollMs = Number(options.idlePollMs);
    if (!isUsableIdlePollBound(idlePollMs)) {
      return {
        refusal:
          `IDLE_POLL_MS_INVALID — --idle-poll-ms must be a whole number of milliseconds from ` +
          `${String(MIN_IDLE_POLL_MS)} to ${String(MAX_WAIT_MS_CEILING)} (24 hours). Below that ` +
          `floor an idle pass costs more than it can learn: every cycle re-resolves each ` +
          `enlisted repository through real git children and plans it again.`,
      };
    }
  }

  return {
    grant: { maxSteps, maxInvocations, wait: { wait: true, maxWaitMs, maxCycles, idlePollMs } },
  };
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
      `Step budget handed to each admitted task, per planning pass. Default ` +
        `${String(DEFAULT_MAX_STEPS)}. Needs --attended. With --wait-for-reset there is a pass ` +
        `per cycle, so a task re-admitted after a wait gets this budget again.`,
    )
    .option(
      '--max-invocations <n>',
      `How many times each admitted task may be driven within one planning pass. Default ` +
        `${String(DEFAULT_MAX_INVOCATIONS)}. Needs --attended. With --wait-for-reset this is ` +
        `NOT a total for the invocation: each cycle re-admits with a fresh budget, so the ` +
        `ceiling for one task is this times --max-cycles.`,
    )
    .option(
      '--wait-for-reset',
      'Between passes, wait out the soonest quota reset any enlisted repository has durably ' +
        'recorded, then plan again — holding no execution lease, running no agent and writing ' +
        'no task state while it waits. The wait is read from each task’s own state file before ' +
        'every sleep and is stored nowhere else, so stopping this process loses nothing and ' +
        'invoking it again reconstructs the same wait without being told which task or which ' +
        'instant. A quota block the machine cannot wait out is never waited for and stays the ' +
        'operator’s. This is also the mode that keeps an operator-attention outbox: after every ' +
        'pass it writes down whatever no machine can move and a person can. Needs --attended, ' +
        '--max-wait-ms and --max-cycles; --idle-poll-ms is optional and makes it keep going when ' +
        'nothing is recorded to wait for.',
    )
    .option(
      '--max-wait-ms <n>',
      `Bound on each single wait, in milliseconds. Required with --wait-for-reset — there is no ` +
        `default — and at most ${String(MAX_WAIT_MS_CEILING)} (24 hours). A reset further away ` +
        `than this ends the invocation instead of sleeping.`,
    )
    .option(
      '--max-cycles <n>',
      `How many planning passes this invocation may make in total, counting the first. Required ` +
        `with --wait-for-reset — there is no default — at least 2, and at most ` +
        `${String(MAX_SCHEDULER_CYCLES)}.`,
    )
    .option(
      '--idle-poll-ms <n>',
      `Keep going when nothing is recorded to wait for: sleep this many milliseconds, then plan ` +
        `again. Optional, and its absence is the behaviour this command has always had — a pass ` +
        `that leaves no recorded reset ahead ends the invocation. Needs --wait-for-reset. At ` +
        `least ${String(MIN_IDLE_POLL_MS)} and at most ${String(MAX_WAIT_MS_CEILING)} (24 ` +
        `hours). This is a poll interval, not a schedule: it names no task, no time of day and ` +
        `no recurrence, and --max-cycles still bounds how many passes happen. Use it when work ` +
        `arrives from outside AgentOrchestrator -- a task somebody writes, a block somebody ` +
        `clears -- because none of that is visible to the durable wake horizon.`,
    )
    .action(async (options: RepositoriesOptions) => {
      // Installed only for an invocation that can sleep, and removed on every
      // path out. See `shutdownRequest`: every other command in this build dies
      // at once on an interrupt, and this slice does not change that for any
      // invocation that did not ask to wait.
      let shutdown: ShutdownRequest | null = null;
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
        if (asked.grant?.wait.wait === true) shutdown = shutdownRequest();
        process.exitCode = await reportRepositories(
          shutdown === null ? seams : { ...seams, shutdown },
          asked.grant,
        );
      } catch (error: unknown) {
        // Never `error.message`: an exception's text routinely embeds untrusted
        // file contents and full paths. Everything goes through the central safe
        // formatter (AO-002), exactly as `main()` does.
        process.stderr.write(`agent-loop: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      } finally {
        // On every path out, including the throw above. A listener left behind
        // would keep this process from dying on the interrupt that follows, and
        // would hold a reference to a promise nothing is waiting for.
        shutdown?.dispose();
      }
    });
}
