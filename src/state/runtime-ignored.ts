/**
 * Proving that the orchestrator's own runtime directory cannot dirty the
 * repository it is about to work in.
 *
 * ── The defect this exists to prevent ──────────────────────────────────────
 *
 * A task's durable state is written *inside* the target repository, at
 * `<root>/.agent-orchestrator/runtime/<taskId>.json`. `prepareTaskWorkspace`
 * refuses `SOURCE_WORKTREE_DIRTY` when the source checkout has uncommitted or
 * **untracked** changes — deliberately, because no base state can be pinned
 * against a tree that is already moving.
 *
 * Those two facts collide. If the runtime directory is not ignored by Git,
 * then starting task one leaves an untracked file behind, and preparing the
 * workspace for task two fails. The first task succeeds, every later task
 * refuses, and the cause is a file this orchestrator wrote itself. For a
 * single manual run that is a confusing afternoon; for a roadmap block that
 * runs tasks in sequence it is a guaranteed stall after the first one.
 *
 * So the rule is not documentation. It is a check, it runs **before the first
 * durable write**, and it fails closed.
 *
 * ── Why `check-ignore` and not a `.gitignore` parser ───────────────────────
 *
 * Ignore rules compose from several files with precedence, negation and
 * per-directory scope. Re-implementing that would be a second opinion about
 * what Git ignores, and the only opinion that matters is Git's own. So Git is
 * asked, with a read-only command, about the exact path that is about to be
 * written.
 *
 * A **tracked** runtime file answers `NOT_IGNORED` here, which is also the
 * right refusal: writing to a tracked path makes the tree dirty just as
 * effectively as creating an untracked one.
 *
 * ── This module reads an exit status, and says which protocol ──────────────
 *
 * `git check-ignore --quiet` answers with its exit status: **0** means the
 * path is ignored, **1** means it is not, and anything else (128 in practice)
 * means Git could not answer at all. Those are three different facts and this
 * module keeps them apart — reporting "could not evaluate" as "not ignored"
 * would refuse a correctly configured repository because Git hiccuped, and
 * reporting it as "ignored" would walk straight into the defect above.
 */

import { relative } from 'node:path';

import { deriveTaskStateLocation } from './state-location.js';
import type { GitRunner } from '../worktree/git-command.js';

/** What Git said about the path the first durable write will create. */
export const RUNTIME_IGNORE_VERDICTS = [
  /** Git ignores it. A state written there cannot dirty the source checkout. */
  'IGNORED',
  /** Git does not ignore it — writing state there would dirty the checkout. */
  'NOT_IGNORED',
  /**
   * Git could not answer: it failed to run, refused the argument, or exited
   * with a status that is neither of the two answers. Never rounded to either.
   */
  'UNDETERMINED',
] as const;

export type RuntimeIgnoreVerdict = (typeof RUNTIME_IGNORE_VERDICTS)[number];

/** The exit status `check-ignore --quiet` uses to say "no, not ignored". */
const NOT_IGNORED_EXIT_CODE = 1;

/** Repository-relative, POSIX-shaped, or `null` if it escaped the root. */
export function relativePosix(repositoryRoot: string, path: string): string | null {
  const rel = relative(repositoryRoot, path).split('\\').join('/');
  // A derived path that escaped its root would be a bug in the location
  // module, not a question for Git. Fail closed rather than ask about it.
  return rel === '' || rel.startsWith('..') ? null : rel;
}

/** One `check-ignore` question about one path. */
async function ask(
  git: GitRunner,
  repositoryRoot: string,
  relativePath: string,
): Promise<RuntimeIgnoreVerdict> {
  // The index is deliberately *not* excluded (`--no-index` is not passed):
  // Git reports a tracked path as not ignored, and that is the answer this
  // check wants. `--no-index` would report a tracked file matching an ignore
  // rule as ignored, which is precisely the case that still dirties the tree.
  const result = await git(repositoryRoot, ['check-ignore', '--quiet', '--', relativePath]);

  if (result.outcome === 'OK') return 'IGNORED';
  if (result.outcome === 'NONZERO_EXIT' && result.exitCode === NOT_IGNORED_EXIT_CODE) {
    return 'NOT_IGNORED';
  }
  return 'UNDETERMINED';
}

/**
 * The suffix used for the staging-file probe.
 *
 * `writeFileAtomically` stages at `<fileName>.tmp-<tempSuffix()>`, where the
 * suffix is a fresh pid-and-random string. The probe stands in for whatever
 * that turns out to be: ignore rules match on shape, not on a particular
 * random value, so one representative name answers for all of them.
 */
const STAGING_PROBE_SUFFIX = 'tmp-probe';

/**
 * Asks Git whether writing `taskId`'s state can dirty the source checkout.
 *
 * ── Two questions, and why both ────────────────────────────────────────────
 *
 * The state file is **not the only name the write creates**.
 * `writeFileAtomically` stages `<taskId>.json.tmp-<suffix>` beside the target
 * before renaming onto it, and a crash — or a `discard()` that could not
 * unlink — leaves that staging file behind. An ignore rule keyed on the file
 * rather than the directory (`.../runtime/*.json`, say) answers "ignored" for
 * the state file while leaving the staging file visible, which is precisely
 * the `SOURCE_WORKTREE_DIRTY` stall this check exists to prevent. So both
 * names are asked about, and both must be ignored.
 *
 * Asking about the *directory* instead would be the tidier question, and it is
 * not available: `check-ignore` matches a `dir/` rule only when it can tell
 * the path is a directory, and the runtime directory does not exist yet the
 * first time this runs. Naming the two files the writer really creates does
 * not depend on anything existing.
 *
 * Both questions also answer the tracked-file case. A state file force-added
 * to the index is *tracked*, and writing to it dirties the tree however the
 * ignore rules read; Git reports a tracked path as not ignored, so the check
 * catches it without a second mechanism.
 *
 * They are two calls rather than two pathnames in one, deliberately:
 * `check-ignore` ORs its arguments and exits 0 if *any* of them is ignored, so
 * a single call carrying both would report success whenever either passed —
 * the opposite of the conjunction this check needs.
 *
 * Paths are passed **repository-relative and POSIX-shaped** rather than
 * absolute: both are built from a validated task id, two fixed directory names
 * and a fixed probe suffix, so they are plain ASCII by construction and cannot
 * carry a drive letter, a backslash or anything else the argument grammar
 * would have to think about. `cwd` is the canonical root, which makes them
 * resolve.
 *
 * Read-only: `check-ignore` inspects rules and reports; it writes nothing, and
 * the probe name is never created.
 */
export async function checkRuntimeIgnored(
  git: GitRunner,
  repositoryRoot: string,
  taskId: string,
): Promise<RuntimeIgnoreVerdict> {
  const location = deriveTaskStateLocation(repositoryRoot, taskId);
  if (!location.ok) return 'UNDETERMINED';

  const file = relativePosix(repositoryRoot, location.path);
  if (file === null) return 'UNDETERMINED';
  const staging = `${file}.${STAGING_PROBE_SUFFIX}`;

  // The staging file first: it is the name a narrow rule misses, so asking it
  // first means the common misconfiguration is reported by its own cause.
  const stagingVerdict = await ask(git, repositoryRoot, staging);
  if (stagingVerdict !== 'IGNORED') return stagingVerdict;

  return ask(git, repositoryRoot, file);
}
