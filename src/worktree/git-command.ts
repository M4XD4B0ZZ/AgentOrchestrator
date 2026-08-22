/**
 * The Git execution seam for the worktree lifecycle — the one place in this
 * slice that is allowed to *change* a repository.
 *
 * ── Why this is not `repo/git-query.ts` ────────────────────────────────────
 *
 * That module opens with a promise: "It writes nothing." V1-01 keeps it,
 * because resolving a repository is a question, not an action. Routing
 * `worktree add` or `branch -d` through it would quietly retract that promise
 * for every existing caller, and the promise is the reason a reader can trust
 * repository resolution not to touch the repository at all. So the write path
 * gets its own module, and `git-query.ts` keeps saying exactly what it means.
 *
 * What is shared is the safety posture, deliberately and in full:
 *
 *  - **no shell.** Execution goes through `doctor/exec.ts`, which spawns an
 *    argument vector. Nothing here ever builds a command line.
 *  - **no inherited Git environment.** `createProbeEnv('capability:generic', …)`
 *    forwards `PATH` and `PATHEXT` and nothing else, so `GIT_DIR`,
 *    `GIT_WORK_TREE`, `GIT_CONFIG_*` and the operator's `~/.gitconfig` cannot
 *    decide which repository a mutation lands in. The `cwd` this module is
 *    handed is the only thing that decides that.
 *  - **bounded** wall clock and output.
 *  - **failures are data**, never exceptions.
 *
 * ── The seam ───────────────────────────────────────────────────────────────
 *
 * {@link GitRunner} is the injection point. Production passes
 * {@link runGitCommand}; a test can pass its own function to drive a case that
 * a real repository cannot be made to produce on demand — a Git that has
 * vanished mid-run, or a competitor that wins a race between a check and the
 * command that depends on it. The lifecycle modules accept a runner and never
 * reach for the real one implicitly, so nothing in this slice can bypass the
 * seam by accident.
 */

import { createProbeEnv } from '../auth/env-guard.js';
import { runCommand, UnsafeArgumentError } from '../doctor/exec.js';

/** How one Git command ended, in a closed vocabulary. Never a message. */
export type GitCommandOutcome =
  /** Git ran and exited 0. `stdout` is meaningful. */
  | 'OK'
  /** Git ran and exited non-zero. Usually an answer of "no", not a broken tool. */
  | 'NONZERO_EXIT'
  /** Git could not be started, timed out, or flooded its output budget. */
  | 'UNAVAILABLE'
  /**
   * An argument was not shell-inert, so nothing was spawned at all.
   *
   * Reported as data rather than thrown: a caller here derives arguments from a
   * repository root and a repository-authored task id, so an unacceptable
   * argument is a *runtime* condition about the target repository — a checkout
   * under a path containing a space, say — and not the programming error that
   * `UnsafeArgumentError` denotes inside `doctor/exec.ts`.
   */
  | 'REFUSED_UNSAFE_ARGUMENT';

export interface GitCommandResult {
  readonly outcome: GitCommandOutcome;
  /** Trimmed stdout on `OK`, the empty string otherwise. */
  readonly stdout: string;
  /**
   * The exit code Git returned, or `null` when no process ran to completion.
   *
   * Carried because a handful of Git commands answer a *question* with their
   * exit status, and collapsing every non-zero into one bucket turns a refusal
   * to answer into an answer. `merge-base --is-ancestor` is the case that
   * forced this: it exits 1 to say "no, not an ancestor" and 128 when it could
   * not evaluate the question at all — a missing ref, say. Those are opposite
   * meanings, and only the exit code separates them.
   *
   * This is a narrow, factual addition: the seam reports what Git said. It is
   * emphatically *not* a general licence to branch on exit codes — the
   * `outcome` vocabulary stays the primary contract, and a caller that does
   * read this must document which specific Git command's exit-status protocol
   * it is relying on.
   */
  readonly exitCode: number | null;
}

/**
 * Runs one Git command inside `cwd`.
 *
 * `cwd` must already be a canonical, existing directory: this seam does not
 * canonicalise and never falls back to `process.cwd()`.
 */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitCommandResult>;

/**
 * Wall-clock ceiling for one local Git command.
 *
 * Larger than the read-only budget in `git-query.ts` because `worktree add`
 * writes a checkout: on a cold cache, on Windows, that is measured in seconds
 * rather than milliseconds. Still bounded — an orchestrator must never wait on
 * Git forever.
 */
const GIT_COMMAND_TIMEOUT_MS = 120_000;

/** `worktree list --porcelain` is the largest output here; 1 MiB is generous. */
const GIT_COMMAND_MAX_OUTPUT_BYTES = 1_048_576;

/**
 * The one way this build asks Git the *cleanliness* question — "is there
 * anything uncommitted in this worktree".
 *
 * ── Which callers, and which ones deliberately do not use it ───────────────
 *
 * Three ask this question and share this vector: `state/observe-runtime.ts`
 * (on every run, to decide whether the world still matches the record),
 * `loop/loop-step.ts` (after a quota-interrupted writer, to decide what the
 * checkpoint may claim) and `worktree/commit-task-work.ts` (its effect gate,
 * plus `-z`). The first two are compared against each other on every later
 * run, and the third decides whether the first two ever see a committed tree,
 * so all three phrasing the question differently is how they end up disagreeing
 * about a repository none of them changed.
 *
 * `worktree/prepare-workspace.ts` and `worktree/remove-workspace.ts` do **not**
 * use it, and that is deliberate rather than an oversight. They ask a different
 * question — "is this workspace pristine / is it safe to destroy" — where an
 * enumeration is the point and `--untracked-files=all` is the right answer even
 * though it costs output. Nothing here should be applied to them without
 * deciding that separately.
 *
 * ── Every token is measured, and two of them are not what they look like ───
 *
 * Measured on git 2.55.0.windows.3, against a superproject with a populated
 * submodule, with and without a hostile `.git/config`:
 *
 * `--untracked-files=normal` restates the status default. It is **not**
 * `=all`, which V3-11 shipped and which is *not* the default: `all` prints one
 * line per file instead of collapsing an untracked directory to one entry, so a
 * worktree with roughly seventeen thousand untracked non-ignored files exceeds
 * {@link GIT_COMMAND_MAX_OUTPUT_BYTES} above, the command reports
 * `UNAVAILABLE`, cleanliness becomes "not established", and every step of every
 * task in that repository stops for an operator. `normal` closes the same blind
 * spot — a worktree-local `status.showUntrackedFiles=no`, which makes a bare
 * `--porcelain` call report a tree with new untracked files as **clean** — at
 * one line of output, and both consumers only ever test `stdout === ''`, so
 * neither can tell `normal` from `all`.
 *
 * `--ignore-submodules=none` restates the *status* default, which really is
 * `none`: measured, a bare `git status --porcelain` reports ` M sub` for a
 * submodule carrying only an untracked file. It is here to override a
 * `submodule.<name>.ignore = all`, under which the bare call reports nothing at
 * all. Note that the same spelling is **wrong** for `git diff`, whose default is
 * `untracked` — see `scope/task-delta.ts`.
 *
 * ── Why it is a shared constant and not three identical literals ───────────
 *
 * Because a comment saying "these must stay the same words" cannot enforce it,
 * and one exported array can. It is also the only construction under which
 * "they agree" is not itself a claim needing a test.
 *
 * ── What this still cannot see (L-V3-10-4) ─────────────────────────────────
 *
 * A gitignored file the writer created, and a write outside the worktree.
 * Neither is closed by any spelling of `status`, and both are carried.
 */
export const WORKTREE_CLEANLINESS_ARGS: readonly string[] = Object.freeze([
  'status',
  '--porcelain',
  '--untracked-files=normal',
  '--ignore-submodules=none',
]);

const RESULT_UNAVAILABLE: GitCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
  exitCode: null,
});

const RESULT_REFUSED: GitCommandResult = Object.freeze({
  outcome: 'REFUSED_UNSAFE_ARGUMENT' as const,
  stdout: '',
  exitCode: null,
});

/** The production {@link GitRunner}. */
export const runGitCommand: GitRunner = async (cwd, args) => {
  let result;
  try {
    result = await runCommand('git', args, {
      env: createProbeEnv('capability:generic', process.env),
      cwd,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxStdoutBytes: GIT_COMMAND_MAX_OUTPUT_BYTES,
      maxStderrBytes: GIT_COMMAND_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    // The one thrown condition `runCommand` documents. Translated into this
    // module's closed vocabulary so a caller never has to catch.
    if (error instanceof UnsafeArgumentError) return RESULT_REFUSED;
    throw error;
  }

  if (result.outcome !== 'COMPLETED') return RESULT_UNAVAILABLE;
  if (result.exitCode !== 0) {
    return Object.freeze({
      outcome: 'NONZERO_EXIT' as const,
      stdout: '',
      exitCode: result.exitCode,
    });
  }
  return Object.freeze({
    outcome: 'OK' as const,
    stdout: result.stdout.trim(),
    exitCode: 0,
  });
};
