/**
 * The orchestrator's own commit of a writing pass (DOGFOOD-REM-001, G1/G11/G12).
 *
 * ── Why the orchestrator commits, and the writer does not ──────────────────
 *
 * The writing agent holds `Read Edit Write Glob Grep` and no shell, so it
 * cannot commit even if it wanted to. That is the decision, not an accident of
 * the tool list: a writer that commits is a writer that decides what the record
 * of its own work says, and this repository already refuses to let a runner be
 * its own reviewer. AO stages and commits, after the scope gate has measured
 * what the writer actually did, under the same execution lease every other
 * mutation here runs under.
 *
 * ── The order is the requirement ───────────────────────────────────────────
 *
 *   the writing pass has ended, positively classified
 *     → the scope gate measures the cumulative delta        (the caller's job)
 *     → control two: refuse a repository that would run code (here, FIRST)
 *     → stage, then commit                                   (here)
 *     → control one: the object's own path set == approved   (here, AFTER)
 *
 * Control two runs before anything is staged because a check that ran after
 * `git add --all` would be reporting a command that had already executed. A
 * post-hoc measurement cannot un-run a program or un-write a sentinel.
 *
 * ── The first line used to read "writer returns ok", and that was narrower
 *    than what this function actually requires ──────────────────────────────
 *
 * It has two callers since V3-10, and only one of them holds a completed pass.
 * The other settles a writer the CLI cut off for quota (`loop/loop-step.ts`,
 * `settleQuotaInterruption`). Nothing here reads a writer result, and nothing
 * here would behave differently if it did: the preconditions are that the
 * *tree* has stopped changing and that a scope gate has just approved the paths
 * being handed in. What makes the tree stop changing is that the writing
 * process ended under its own control, which both callers establish before they
 * arrive — one from a `COMPLETED` envelope, the other from a `429` in an
 * envelope only a self-terminated process could have printed.
 *
 * So the contract was always about a *classified ending over an approved tree*,
 * not about success, and the diagram above now says so. What this function
 * records is therefore not evidence of completion either — see the caller's
 * state, which is `VERIFYING` for one of them and `BLOCKED_USAGE_LIMIT` for the
 * other.
 *
 * ── The message says which pass, not that it finished ──────────────────────
 *
 * `AO:<taskId>:<phase>:r<round>` names the task, the writing phase and the
 * round, and asserts nothing about the outcome — deliberately, and it is worth
 * stating now that two kinds of pass produce one. Nothing in `src/` reads or
 * matches it, so no behaviour keys off it; the durable *state* is what
 * distinguishes a recorded pass from a recorded interruption, which is the
 * right place for that distinction to live. A variant spelling for the
 * interruption would be a second grammar nothing consumes, on a value that is
 * one shell-inert token by contract.
 *
 * ── Measured, not remembered (git 2.55.0.windows.3, through `runGitCommand`) ─
 *
 * Every token below was probed through the production seam — `capability:generic`,
 * so `PATH`/`PATHEXT` and nothing else — against throwaway repositories:
 *
 *  - **The ambient identity IS visible to this seam.** G11 predicted it would
 *    not be. It was wrong: `config --show-origin --get user.email` answered
 *    `file:C:/Users/<operator>/.gitconfig`, and a commit made without `-c` was
 *    authored by the operator. So the `-c` route is not merely tidy, it is the
 *    thing standing between an operator's real name and every AO commit, and
 *    the leak counter-control in the tests is load-bearing rather than
 *    decorative.
 *  - **All four commit hooks fire** on this path: `pre-commit`,
 *    `prepare-commit-msg`, `commit-msg`, `post-commit`.
 *  - **`--no-verify` does not suppress them.** Measured: `prepare-commit-msg`
 *    and `post-commit` still ran. It is refused for that reason and no other.
 *  - **`-c core.hooksPath=` (the empty value) suppresses all four**, and it is
 *    the one candidate that is *unconditionally* expressible: `SAFE_ARG_PATTERN`
 *    is `*`-quantified, so the empty string always passes, while any real
 *    directory is inert only until an operator's path contains a space. It also
 *    survives the obvious attack: a **relative** value like `.ao-no-hooks`
 *    suppresses hooks only until the writer creates that directory — measured,
 *    the planted `pre-commit` then ran — whereas the empty value names no
 *    directory the writer can create, and hooks planted at the top of the
 *    worktree did not run.
 *  - **`commit.gpgSign=true` in the target repository reaches this commit and
 *    breaks it** (exit 128, no signing key). `-c commit.gpgSign=false`
 *    neutralises it deterministically.
 *  - **`--format=%…` is not expressible through this seam at all**: `%` is not
 *    in `SAFE_ARG_PATTERN`. The new commit is read with `rev-parse HEAD`, and
 *    anything about the object itself with `cat-file`. A caller wanting a
 *    pretty format will find the seam refusing the argument, which is the
 *    correct answer rather than an obstacle.
 *
 * The neutralisation is **defence in depth, not the primary control.** Control
 * one is primary: it compares the committed path set with the approved one and
 * therefore covers path-adding mechanisms nobody has enumerated. A future
 * reader who adds a newly discovered hook to the suppression list must not
 * conclude that control one may now be relaxed.
 *
 * ── What control one proves, and what it does not ──────────────────────────
 *
 * It proves **path authority**: the object contains exactly the paths the gate
 * approved. It does not prove the approved *bytes* — a clean filter can rewrite
 * an approved file's content and leave the path set identical — and it does not
 * prove that no code ran. Those are control two's business, and the two are not
 * interchangeable.
 *
 * ── Why there is no `--allow-empty`, ever ──────────────────────────────────
 *
 * A pass that changed nothing produces no commit here. That is what keeps the
 * settlement rule elsewhere honest: an empty commit would move HEAD, and a rule
 * that asks "did HEAD change?" would then be satisfied by a writer that did
 * nothing at all.
 *
 * ── Refusals do not undo ───────────────────────────────────────────────────
 *
 * `COMMITTED_BEYOND_APPROVED_SCOPE` keeps the commit. The object is the
 * evidence an operator is being asked to look at, and rolling it back would
 * destroy the artefact while the effect that produced it — whatever wrote those
 * paths — is still on disk. The undo is an effect too.
 */

import { isShellInertArgument } from '../doctor/exec.js';
import type { GitRunner } from './git-command.js';

/** The identity every AO commit carries. Decided once, here (G11). */
export const AO_COMMIT_IDENTITY = Object.freeze({
  name: 'AgentOrchestrator',
  /**
   * `.invalid` is reserved by RFC 2606 and can never be registered, so this
   * asserts *no real address* rather than borrowing somebody's.
   */
  email: 'agent-orchestrator@local.invalid',
});

/**
 * The `-c` overrides every AO commit is made under.
 *
 * Supplied per invocation and never written to any git-config, at any scope.
 * AO does not install an identity in a repository it was asked to work in; it
 * supplies one for the length of one command.
 */
const COMMIT_OVERRIDES: readonly string[] = Object.freeze([
  '-c', `user.name=${AO_COMMIT_IDENTITY.name}`,
  '-c', `user.email=${AO_COMMIT_IDENTITY.email}`,
  // Measured: suppresses pre-commit, prepare-commit-msg, commit-msg and
  // post-commit, and cannot be planted. See the module note.
  '-c', 'core.hooksPath=',
  // A target repository that demands signing must not decide whether AO can
  // record its own work.
  '-c', 'commit.gpgSign=false',
]);

/** A configured driver that can execute a program, named without its command. */
export interface ExecutableDriverFinding {
  /** e.g. `filter.probe.clean`. Never the configured value. */
  readonly key: string;
  /** Git's own scope label: `system`, `global`, `local`, `worktree`, `command`. */
  readonly scope: string;
}

/** Which Git call did not answer. Reported so a refusal names its own cause. */
export type CommitTaskWorkStep =
  | 'OBSERVE_WORKTREE'
  | 'READ_CONFIG'
  | 'READ_ATTRIBUTES'
  | 'STAGE'
  | 'COMMIT'
  | 'READ_HEAD'
  | 'READ_COMMITTED_PATHS';

export type CommitTaskWorkResult =
  /** The work is recorded, the tree is clean, and the object is the approved one. */
  | { readonly outcome: 'COMMITTED'; readonly commit: string }
  /** The writer changed nothing. No commit object was created. */
  | { readonly outcome: 'NOTHING_TO_COMMIT' }
  /**
   * The commit exists and contains a path the gate never approved. **No undo**:
   * the object and the paths are the evidence.
   */
  | {
      readonly outcome: 'COMMITTED_BEYOND_APPROVED_SCOPE';
      readonly commit: string;
      readonly unapprovedPaths: readonly string[];
    }
  /**
   * The target repository has an executable content filter configured for a
   * path this commit would contain. Nothing was staged and nothing committed.
   */
  | {
      readonly outcome: 'TARGET_CONFIG_EXECUTES_CODE';
      readonly findings: readonly ExecutableDriverFinding[];
    }
  /** An argument this module derived is not expressible through the seam. */
  | { readonly outcome: 'REFUSED_UNSAFE_ARGUMENT' }
  /** Git did not answer. Never folded into any of the above. */
  | { readonly outcome: 'GIT_UNAVAILABLE'; readonly step: CommitTaskWorkStep };

export interface CommitTaskWorkRequest {
  /** The task whose work this is. Repository-authored, so it is checked, not trusted. */
  readonly taskId: string;
  /** Which writing pass produced it. */
  readonly phase: 'IMPLEMENT' | 'REMEDIATE';
  /** The review round it belongs to. */
  readonly round: number;
  /**
   * The path set the scope gate approved, passed **in** and never re-derived.
   *
   * Required even when empty. A set this module derived for itself would be
   * measured *after* whatever injection it is supposed to detect, so it would
   * contain the injection and agree with itself — which is precisely the
   * comparison G12 exists to prevent. An optional-looking parameter is an
   * invitation to build that, so it is not optional.
   */
  readonly approvedPaths: readonly string[];
  /**
   * The commit the task's work sits on top of — the same base the scope gate
   * measured its delta from.
   *
   * Control one compares *sets*, and an equality only means anything when both
   * sides are measured from one base. The gate's delta is cumulative from the
   * base pin, so the object's path set is read from the base pin too. Reading
   * it from the new commit's parent instead would make every remediation pass
   * compare this pass's paths against the whole task's approved set and refuse
   * a task that had done nothing wrong.
   */
  readonly basePinnedCommit: string;
}

/** Values `check-attr` prints that do not name a driver. */
const NON_DRIVER_ATTRIBUTE_VALUES: ReadonlySet<string> = new Set([
  'unspecified',
  'unset',
  'set',
]);

/**
 * The config keys that can name a program Git will execute for a path.
 *
 * `clean` and `process` only, and deliberately not `smudge`: a smudge filter
 * runs on checkout, not on the staging this module performs. Path-independent
 * executable configuration — `core.fsmonitor` and relatives — is **not** covered
 * here: `check-attr` cannot reach it, it already runs during today's
 * `status`/`diff` observation, and refusing on its mere presence would park
 * every commit on an ordinary machine for an exposure this slice did not
 * introduce. It is a named follow-up finding, not a silent omission.
 */
const EXECUTABLE_DRIVER_KEY = /^filter\.(.+)\.(clean|process)$/;

/**
 * Every executable driver key in Git's own `--name-only` listing, with its scope.
 *
 * The measured wire format, confirmed on git 2.55.0.windows.3:
 *
 *     git config --list --show-scope --name-only -z   →   scope\0key\0scope\0key\0…
 *
 * with a trailing NUL that survives the seam's `trim()`, because `\0` is not
 * whitespace. Exported for the parser control: system scope cannot be exercised
 * without mutating the machine this runs on, which is forbidden, so it is
 * covered here — fed Git's own bytes — and the reader keys on the *key*, never
 * on the scope label.
 */
export function executableDriverKeysIn(listing: string): ExecutableDriverFinding[] {
  const records = listing.split('\0');
  const found: ExecutableDriverFinding[] = [];
  // Pairs, in order. A trailing empty record from the final NUL is simply not a
  // pair and falls out of the loop bound.
  for (let index = 0; index + 1 < records.length; index += 2) {
    const scope = records[index] ?? '';
    const key = records[index + 1] ?? '';
    if (scope === '' || !EXECUTABLE_DRIVER_KEY.test(key)) continue;
    found.push(Object.freeze({ key, scope }));
  }
  return found;
}

/**
 * The driver names Git says apply to these paths.
 *
 * Measured format: `path\0filter\0value\0…`, where the value is `unspecified`
 * when no driver applies. Git owns the attribute-to-driver mapping — pattern
 * precedence, nested `.gitattributes`, macros — so it is asked rather than
 * inferred from the file.
 */
function appliedDriverNames(attributes: string): ReadonlySet<string> {
  const records = attributes.split('\0');
  const names = new Set<string>();
  for (let index = 0; index + 2 < records.length; index += 3) {
    if (records[index + 1] !== 'filter') continue;
    const value = records[index + 2] ?? '';
    if (value === '' || NON_DRIVER_ATTRIBUTE_VALUES.has(value)) continue;
    names.add(value);
  }
  return names;
}

/** `filter.<name>.clean` → `<name>`. */
function driverNameOf(key: string): string {
  return EXECUTABLE_DRIVER_KEY.exec(key)?.[1] ?? '';
}

/** Git's POSIX-shaped path list, sorted and de-duplicated. */
function pathSet(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

/**
 * The message. AO-authored, deterministic, and a **single shell-inert token**,
 * because `-m` takes one argument and `SAFE_ARG_PATTERN` excludes the space.
 *
 * It interpolates no agent output. The task id is the one repository-authored
 * part, and it is checked rather than trusted — an id carrying a quote must
 * produce this module's own typed refusal, not an `UnsafeArgumentError` from
 * the seam.
 */
function commitMessageFor(request: CommitTaskWorkRequest): string {
  return `AO:${request.taskId}:${request.phase}:r${request.round}`;
}

/**
 * Stages and commits the writer's work, and proves what it committed.
 *
 * Never throws for an expected condition: a repository that refuses, a Git that
 * does not answer and a target configuration that would execute code all arrive
 * as data.
 */
export async function commitTaskWork(
  git: GitRunner,
  worktreePath: string,
  request: CommitTaskWorkRequest,
): Promise<CommitTaskWorkResult> {
  const message = commitMessageFor(request);
  if (!isShellInertArgument(message) || !isShellInertArgument(request.basePinnedCommit)) {
    return Object.freeze({ outcome: 'REFUSED_UNSAFE_ARGUMENT' as const });
  }

  // The effect gate. Asked before anything is staged, and before control two
  // spends two Git calls on a pass that produced nothing.
  const dirty = await git(worktreePath, ['status', '--porcelain', '-z']);
  if (dirty.outcome !== 'OK') {
    return Object.freeze({ outcome: 'GIT_UNAVAILABLE' as const, step: 'OBSERVE_WORKTREE' as const });
  }
  if (dirty.stdout.replace(/\0/g, '').trim() === '') {
    return Object.freeze({ outcome: 'NOTHING_TO_COMMIT' as const });
  }

  const refusal = await refuseExecutableDrivers(git, worktreePath, request.approvedPaths);
  if (refusal !== null) return refusal;

  const staged = await git(worktreePath, [...COMMIT_OVERRIDES, 'add', '--all']);
  if (staged.outcome !== 'OK') {
    return Object.freeze({ outcome: 'GIT_UNAVAILABLE' as const, step: 'STAGE' as const });
  }

  const committed = await git(worktreePath, [...COMMIT_OVERRIDES, 'commit', '-m', message]);
  if (committed.outcome === 'REFUSED_UNSAFE_ARGUMENT') {
    return Object.freeze({ outcome: 'REFUSED_UNSAFE_ARGUMENT' as const });
  }
  if (committed.outcome !== 'OK') {
    // Git says "nothing to commit" with exit 1. The effect gate above has
    // already answered that question, so reaching it here means the tree was
    // dirty with something `add --all` does not stage — an ignored file, say.
    // Reported as the honest "nothing was recorded" rather than as a failure.
    const after = await git(worktreePath, ['status', '--porcelain', '-z']);
    if (after.outcome === 'OK' && committed.exitCode === 1) {
      return Object.freeze({ outcome: 'NOTHING_TO_COMMIT' as const });
    }
    return Object.freeze({ outcome: 'GIT_UNAVAILABLE' as const, step: 'COMMIT' as const });
  }

  const head = await git(worktreePath, ['rev-parse', 'HEAD']);
  if (head.outcome !== 'OK' || head.stdout === '') {
    return Object.freeze({ outcome: 'GIT_UNAVAILABLE' as const, step: 'READ_HEAD' as const });
  }
  const commit = head.stdout;

  // Control one. `--no-replace-objects` for the reason `task-delta.ts` gives at
  // length: a `refs/replace` mapping installed in the worktree would otherwise
  // swap the commit this diff is taken against. `-z` keeps a target-controlled
  // `core.quotePath` out of the comparison.
  const names = await git(worktreePath, [
    '--no-replace-objects',
    'diff',
    '--name-only',
    '--no-renames',
    '--no-color',
    '-z',
    '--end-of-options',
    request.basePinnedCommit,
    commit,
    '--',
  ]);
  if (names.outcome !== 'OK') {
    return Object.freeze({
      outcome: 'GIT_UNAVAILABLE' as const,
      step: 'READ_COMMITTED_PATHS' as const,
    });
  }

  const committedPaths = pathSet(names.stdout.split('\0').filter((path) => path !== ''));
  const approved = new Set(request.approvedPaths);
  const unapproved = committedPaths.filter((path) => !approved.has(path));
  if (unapproved.length > 0) {
    return Object.freeze({
      outcome: 'COMMITTED_BEYOND_APPROVED_SCOPE' as const,
      commit,
      unapprovedPaths: Object.freeze(unapproved),
    });
  }

  return Object.freeze({ outcome: 'COMMITTED' as const, commit });
}

/**
 * Control two: refuse before staging when Git would run a program for a path
 * this commit would contain.
 *
 * **The predicate is a conjunction, and widening it to either half alone breaks
 * it in a measurable way.** A configured driver on its own is not enough: this
 * development machine's *system and global* scopes both define
 * `filter.lfs.clean` / `.process`, because Git for Windows ships LFS — so "any
 * driver key is configured" refuses every commit in every repository, including
 * this one. An assigned attribute on its own is not enough either: a
 * `.gitattributes` naming a driver the configuration never defines makes Git
 * run nothing at all.
 *
 * So both halves are asked, and the second is asked of **Git**, about the
 * actual paths being staged.
 */
async function refuseExecutableDrivers(
  git: GitRunner,
  worktreePath: string,
  approvedPaths: readonly string[],
): Promise<CommitTaskWorkResult | null> {
  if (approvedPaths.length === 0) return null;

  // Every path becomes an argument, so every path must be expressible. A path
  // this seam cannot name is a path control two cannot ask about, and an
  // unaskable question fails closed rather than being skipped.
  for (const path of approvedPaths) {
    if (!isShellInertArgument(path)) {
      return Object.freeze({ outcome: 'REFUSED_UNSAFE_ARGUMENT' as const });
    }
  }

  // `--name-only`, and this is the whole point of the flag: the attacker-chosen
  // command never enters this process. That is strictly stronger than receiving
  // it and declining to print it — there is no value here to leak, log or
  // accidentally interpolate. NOT `--local`: Git honours system, global, local
  // and worktree scopes and resolves `include`/`includeIf` itself (measured —
  // an included driver is reported, under the scope of the file that included
  // it), so a local-only scan is blind to a driver Git will nonetheless run.
  const listed = await git(worktreePath, ['config', '--list', '--show-scope', '--name-only', '-z']);
  if (listed.outcome !== 'OK') {
    return Object.freeze({ outcome: 'GIT_UNAVAILABLE' as const, step: 'READ_CONFIG' as const });
  }
  const configured = executableDriverKeysIn(listed.stdout);
  if (configured.length === 0) return null;

  const attributes = await git(worktreePath, [
    'check-attr',
    'filter',
    '-z',
    '--',
    ...approvedPaths,
  ]);
  if (attributes.outcome !== 'OK') {
    return Object.freeze({ outcome: 'GIT_UNAVAILABLE' as const, step: 'READ_ATTRIBUTES' as const });
  }
  const applied = appliedDriverNames(attributes.stdout);
  if (applied.size === 0) return null;

  const findings = configured.filter((finding) => applied.has(driverNameOf(finding.key)));
  if (findings.length === 0) return null;

  return Object.freeze({
    outcome: 'TARGET_CONFIG_EXECUTES_CODE' as const,
    findings: Object.freeze(findings),
  });
}
