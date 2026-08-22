/**
 * The one question "is there anything uncommitted in this worktree", asked in
 * full — including the part `git status` does not answer.
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 *
 * V3-11 made `worktreeCleanAtCheckpoint: true` the fact an **unattended writer
 * relaunch** is authorised on. An independent review of the remediation then
 * found a shape in which every observer AO owns reports a clean tree over
 * writer output that is really there:
 *
 * A fresh `git worktree add` leaves a submodule **unpopulated** — measured, the
 * gitlink is in the index and the directory is empty — and AO never runs
 * `git submodule update`, so that is the state a task starts in. A writer
 * holding only `Read Edit Write Glob Grep` can then write files into that
 * directory with ordinary `Write`. Measured against real Git 2.55.0.windows.3,
 * with two files planted under an unpopulated `vendor`:
 *
 *   status --porcelain -unormal --ignore-submodules=none   ->  (empty)
 *   status --porcelain -uall   --ignore-submodules=none    ->  (empty)
 *   status --porcelain (bare)                              ->  (empty)
 *   diff --name-status --ignore-submodules=untracked       ->  (empty)
 *   diff --name-status --ignore-submodules=none            ->  (empty)
 *   ls-files --others --exclude-standard                   ->  (empty)
 *   ls-files --others                                      ->  (empty)
 *
 * Every eye AO has, blind. Git is not wrong — the path is a submodule boundary
 * and the superproject is not entitled to look across it — but AO cannot spend
 * that answer as *cleanliness*, because the reading is what mints a checkpoint
 * and the writer can produce the state itself. That is an inability to observe
 * being read as permission, which this repository does not do.
 *
 * The blind spot is **pre-existing**: the flag values V3-11 shipped were
 * equally blind, and so were the ones before it. What V3-11 changed is what the
 * answer buys. So this is not a regression being repaired; it is a carried
 * observation gap that stopped being affordable.
 *
 * ── What this probe is, and firmly is not ──────────────────────────────────
 *
 * One bounded observation, over paths the **index** says are gitlinks, and
 * nothing else. It does not populate, initialise, repair, clean, or recurse
 * into arbitrary directories, and it takes no view on what a submodule *should*
 * contain. AO does not own the submodule; it owns the question of whether the
 * worktree it is about to certify holds bytes nobody classified.
 *
 * The rule, in full:
 *
 *   gitlink directory missing                     ->  clean
 *   gitlink directory empty                       ->  clean
 *   gitlink populated (an active checkout)        ->  `git status` already answered
 *   gitlink not active and holding entries        ->  **dirty**
 *   anything about it cannot be established       ->  **not established** (`null`)
 *
 * ── Why `git submodule status` and not `git ls-files --stage` ──────────────
 *
 * `ls-files --stage` is the obvious way to find mode `160000` entries and it is
 * unusable here: it prints one line per tracked file, so a repository with more
 * than roughly fifteen thousand of them exceeds the seam's 1 MiB output cap and
 * the probe would report "not established" for every ordinary monorepo. That is
 * the same unbounded-output defect the remediation removed from the cleanliness
 * vector, and reintroducing it one call later would be worse than not probing.
 *
 * `git submodule status` prints one line per submodule, and — measured — it
 * reads the **index**, not `.gitmodules`: deleting `.gitmodules` outright still
 * reported `-<sha> vendor`, and a fabricated `.gitmodules` entry naming `src/`
 * as a submodule was **not** listed. So a writer can neither hide a gitlink from
 * this probe nor invent one to make its own worktree permanently dirty.
 *
 * Every path it prints is nevertheless confirmed against the index before this
 * module acts on it, with a pathspec-bounded `ls-files --stage -- <path>`. That
 * is not distrust of the measurement above; it is what turns a parse this module
 * got wrong into `null` instead of into silence, because a mis-parsed path
 * simply would not exist on disk and "does not exist" is the *clean* answer.
 *
 * ── The evasions, measured ─────────────────────────────────────────────────
 *
 * A writer that plants a `.git` file or directory inside the gitlink to pass
 * itself off as an active checkout does not reach this probe at all: Git's own
 * `status` then exits 128 (`fatal: 'vendor/.git' not recognized as a git
 * repository`), the seam reports `NONZERO_EXIT`, and cleanliness is `null`
 * before the first line of this module runs. Reproduced through
 * `runGitCommand` at the production seam.
 *
 * ── What it still cannot see ───────────────────────────────────────────────
 *
 * A gitignored file the writer created, and a write outside the worktree. Both
 * are `L-V3-10-4`, both remain carried, and neither is closed by any spelling
 * of `status` or by this probe.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { WORKTREE_CLEANLINESS_ARGS, type GitRunner } from './git-command.js';

/**
 * One `git submodule status` line, strictly.
 *
 * `<flag><40 hex><space><path>`, where the flag is one of the four documented
 * ones: `-` not initialised, ` ` in sync, `+` a different commit is checked
 * out, `U` merge conflicts. Anything that does not match this exactly makes the
 * whole probe answer "not established" rather than guessing, because the only
 * alternative reading — treating an unparsed line as no submodule — is the
 * blind answer this module exists to stop returning.
 *
 * The flag is **optional**, and that is not laxity. `runGitCommand` trims the
 * command's whole stdout, so an in-sync submodule — whose flag *is* a space —
 * arrives with no flag at all when it is the first line, and with one when it is
 * not. Measured: a clean populated `vendor` reported
 * `bc04a7e…cbb vendor (heads/main)` through the seam and
 * ` bc04a7e…cbb vendor (heads/main)` from the bare command. An absent flag can
 * only ever have been the space, because the other three are not whitespace.
 *
 * A `-` line carries no `(describe)` suffix — describing requires a checkout —
 * so the captured path is exact for the only flag this module acts on.
 */
const SUBMODULE_STATUS_LINE = /^([ +\-U]?)([0-9a-f]{40}) (.+)$/;

/** The flag `git submodule status` prints for a gitlink that is not populated. */
const NOT_INITIALISED = '-';

/** `git ls-files --stage` prints this mode for a gitlink, and only for a gitlink. */
const GITLINK_MODE = '160000';

/**
 * Whether `worktreePath` holds anything uncommitted, or `null` when that could
 * not be established.
 *
 * `null` is not a soft `true`. Every caller maps it to "cleanliness unknown",
 * which is `UNOBSERVABLE`, which is an operator — see `state/reconcile.ts`.
 */
export async function observeWorktreeCleanliness(
  git: GitRunner,
  worktreePath: string,
): Promise<boolean | null> {
  const status = await git(worktreePath, WORKTREE_CLEANLINESS_ARGS);
  if (status.outcome !== 'OK') return null;
  // Dirty by Git's own reading. The probe below would add nothing: it can only
  // turn `true` into `false`, never the other way.
  if (status.stdout !== '') return false;

  return await noPlantedSubmoduleContent(git, worktreePath);
}

/**
 * The part `git status` does not answer: is there content sitting inside a
 * gitlink Git is not looking into?
 */
async function noPlantedSubmoduleContent(
  git: GitRunner,
  worktreePath: string,
): Promise<boolean | null> {
  const listing = await git(worktreePath, ['submodule', 'status']);
  if (listing.outcome !== 'OK') return null;
  // The overwhelmingly common case, and it costs one subprocess: a repository
  // with no submodules has no gitlink for anything to hide behind.
  if (listing.stdout === '') return true;

  for (const line of listing.stdout.split('\n')) {
    const text = line.trimEnd();
    if (text.length === 0) continue;

    const parsed = SUBMODULE_STATUS_LINE.exec(text);
    if (parsed === null) return null;

    const flag = parsed[1];
    const path = parsed[3];
    if (flag === undefined || path === undefined) return null;

    // A populated gitlink is inside Git's reach, and the cleanliness vector
    // already carries `--ignore-submodules=none` so that the repository cannot
    // configure that reach away. Nothing here to add.
    if (flag !== NOT_INITIALISED) continue;

    // Not confirmed is not "no gitlink there" — it is "this module does not
    // know what it is looking at", and the clean answer is not available for a
    // path it cannot place. Fail closed.
    if ((await pathIsGitlinkInIndex(git, worktreePath, path)) !== true) return null;

    const entries = readDirectoryEntries(join(worktreePath, path));
    if (entries === null) return null;
    if (entries.length > 0) return false;
  }

  return true;
}

/**
 * Whether the index really records `path` as a gitlink.
 *
 * Bounded by the pathspec, so this cannot inherit `ls-files`' unbounded output.
 * `--error-unmatch` is deliberately **not** used: an unmatched path is an
 * answer, and this reader wants to distinguish it from Git failing.
 */
async function pathIsGitlinkInIndex(
  git: GitRunner,
  worktreePath: string,
  path: string,
): Promise<true | null> {
  const staged = await git(worktreePath, [
    'ls-files',
    '--stage',
    '-z',
    '--end-of-options',
    '--',
    path,
  ]);
  if (staged.outcome !== 'OK') return null;

  for (const entry of staged.stdout.split('\0')) {
    if (entry === '') continue;
    // `<mode> <sha> <stage>\t<path>`. Only the mode is read; the path came from
    // the pathspec, so there is nothing to learn from repeating it back.
    if (entry.startsWith(`${GITLINK_MODE} `)) return true;
  }
  return null;
}

/**
 * The entries of one directory, `[]` when it does not exist, or `null` when it
 * exists and could not be read.
 *
 * Not recursive, and never called on a path the index did not just confirm is a
 * gitlink.
 */
function readDirectoryEntries(directory: string): readonly string[] | null {
  try {
    return readdirSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Absent is an answer, and it is the clean one: a gitlink whose directory
    // was never created holds nothing.
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    return null;
  }
}
