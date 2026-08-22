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
 * answer buys.
 *
 * ── What this probe is, and firmly is not ──────────────────────────────────
 *
 * One bounded observation, over paths Git says are gitlinks, and nothing else.
 * It does not populate, initialise, repair, clean, or recurse into arbitrary
 * directories, and it takes no view on what a submodule *should* contain. AO
 * does not own the submodule; it owns the question of whether the worktree it is
 * about to certify holds bytes nobody classified.
 *
 * The rule, in full:
 *
 *   gitlink directory missing                     ->  clean
 *   gitlink directory empty                       ->  clean
 *   gitlink directory holds a `.git`              ->  Git treats it as a real
 *                                                     checkout, and `git status`
 *                                                     has already answered for it
 *   gitlink directory holds anything else         ->  **dirty**
 *   the gitlink set cannot be established         ->  **not established** (`null`)
 *
 * ── Two sources for the gitlink set, and why there must be two ─────────────
 *
 * `git ls-files --stage` is the obvious way to find mode `160000` entries and
 * it cannot be the *primary* one: it prints one line per tracked file, so a
 * repository with more than roughly fifteen thousand of them exceeds the seam's
 * 1 MiB output cap and the probe would answer "not established" for every
 * ordinary monorepo — the same unbounded-output defect this remediation removed
 * from the cleanliness vector.
 *
 * `git submodule status` prints one line per submodule, so it is the primary.
 * The first version of this module said it "reads the **index**, not
 * `.gitmodules`", citing two measurements that are both true — an *uncommitted*
 * deletion of `.gitmodules` still lists the gitlink, and a fabricated
 * `.gitmodules` entry naming a non-gitlink path is not listed. The
 * generalisation drawn from them was **false**, and a review measured the cases
 * that matter:
 *
 *   .gitmodules deleted, uncommitted      ->  `-<sha> vendor`          exit 0
 *   the deletion committed                ->  fatal: no submodule mapping  128
 *   .gitmodules maps a different path     ->  fatal: no submodule mapping  128
 *   an embedded repo, never mapped        ->  fatal: no submodule mapping  128
 *
 * The last of those is the ordinary `git add -A` accident, not an attack, and
 * under the first design it made every step of every task in such a repository
 * stop for an operator, forever, over a tree that is genuinely clean. Two more
 * shapes did the same: a submodule path carrying a space or a non-ASCII
 * character (`doctor/exec.ts`'s `SAFE_ARG_PATTERN` refuses it as an argument),
 * and a SHA-256 repository (64 hex characters, not 40).
 *
 * So `ls-files --stage` is the **fallback**, taken whenever `submodule status`
 * cannot be used or cannot be trusted, and `null` is reserved for the case where
 * neither source can answer. That trades a certain stall in three ordinary
 * shapes for an unbounded read in those same shapes — which fails closed only
 * on a repository that is both large and unusually shaped.
 *
 * Measured: a listing that is missing *one* mapping fails the whole command
 * (exit 128) rather than silently omitting that entry, so a non-`OK` outcome is
 * a reliable signal to fall back rather than a partial answer to be trusted.
 *
 * ── What it still cannot see ───────────────────────────────────────────────
 *
 * A gitignored file the writer created, and a write outside the worktree
 * (**L-V3-10-4**), and two shapes a later review measured against this module
 * itself:
 *
 *  - a writer that fabricates a **well-formed** `.git` inside the gitlink,
 *    including a `.git/info/exclude` of `*`. Git then treats the directory as a
 *    real, clean submodule checkout, `submodule status` reports it initialised,
 *    and this probe defers to `git status` as the rule above says it should.
 *    Measured `true` over payload still on disk — and measured `true` for the
 *    same fixture *before* this module existed, so it is a carried limit rather
 *    than a regression (**L-V3-11-13**);
 *  - a gitlink nested inside a **populated** submodule. `submodule status` is
 *    not recursive, and recursion into arbitrary directories is explicitly
 *    outside this probe's remit (**L-V3-11-14**).
 *
 * Neither is closed here. Both are stated because the first version of this
 * comment claimed the fabricated-checkout case *was* closed, which was false.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { isShellInertArgument } from '../doctor/exec.js';
import { WORKTREE_CLEANLINESS_ARGS, type GitRunner } from './git-command.js';

/**
 * One `git submodule status` line, strictly.
 *
 * `<flag><hex><space><path>`, where the flag is one of the four documented
 * ones: `-` not initialised, ` ` in sync, `+` a different commit is checked
 * out, `U` merge conflicts. The hex is 40 characters under SHA-1 and 64 under
 * SHA-256; the first version of this pattern accepted only 40, which made every
 * SHA-256 repository with a submodule unobservable.
 *
 * The flag is **optional**, and that is not laxity. `runGitCommand` trims the
 * command's whole stdout, so an in-sync submodule — whose flag *is* a space —
 * arrives with no flag at all when it is the first line, and with one when it is
 * not. An absent flag can only ever have been the space, because the other
 * three are not whitespace.
 *
 * A line that does not match sends the whole probe to the index instead of
 * being guessed at, because the alternative reading — treating an unparsed line
 * as no submodule — is the blind answer this module exists to stop returning.
 */
const SUBMODULE_STATUS_LINE = /^([ +\-U]?)([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/;

/** `git ls-files --stage` prints this mode for a gitlink, and only for a gitlink. */
const GITLINK_MODE = '160000';

/** The flag `git submodule status` prints for a gitlink that is not populated. */
const NOT_INITIALISED = '-';

/**
 * How one directory is listed. Injected **only** so the "could not be read" arm
 * can be pinned.
 *
 * That arm is fail-closed on the path that mints unattended-resume authority,
 * and a filesystem cannot be asked to fail on demand portably — a
 * permission-denied directory is an `icacls` call on Windows and a `chmod`
 * elsewhere, neither reproducible in this suite. So the seam exists, and it is a
 * *combination* rather than a substitution: every other case in
 * `tests/v3-11-remediation-git-vectors.test.ts` drives this function against real
 * repositories through the real reader. Production callers pass nothing.
 */
type DirectoryReader = (directory: string) => readonly string[] | null;

/** What `.git` inside a gitlink directory means: Git owns that path, not this probe. */
const GIT_DIRECTORY_ENTRY = '.git';

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
  readEntries: DirectoryReader = readDirectoryEntries,
): Promise<boolean | null> {
  const status = await git(worktreePath, WORKTREE_CLEANLINESS_ARGS);
  if (status.outcome !== 'OK') return null;
  // Dirty by Git's own reading. The probe below would add nothing: it can only
  // turn `true` into `false`, never the other way.
  if (status.stdout !== '') return false;

  const gitlinks = await gitlinkPaths(git, worktreePath);
  if (gitlinks === null) return null;

  for (const path of gitlinks) {
    const entries = readEntries(join(worktreePath, path));
    if (entries === null) return null;
    if (entries.length === 0) continue;
    // Git owns this directory: it is a checkout, and `git status` above already
    // reported on it through `--ignore-submodules=none`. See L-V3-11-13 for what
    // that costs when the checkout was fabricated.
    if (entries.includes(GIT_DIRECTORY_ENTRY)) continue;
    return false;
  }

  return true;
}

/**
 * Every path this worktree's index records as a gitlink, or `null` when that
 * could not be established.
 *
 * `git submodule status` first because it is bounded; the index second because
 * it is correct for shapes `submodule status` refuses.
 */
async function gitlinkPaths(
  git: GitRunner,
  worktreePath: string,
): Promise<readonly string[] | null> {
  const listing = await git(worktreePath, ['submodule', 'status']);

  if (listing.outcome === 'OK') {
    // The overwhelmingly common case: a repository with no submodules has no
    // gitlink for anything to hide behind, and the probe stops here.
    //
    // It is not free. `git submodule` is a shell script on the installed build,
    // and measured against this repository it cost roughly five times the
    // `status` call it follows (~475 ms against ~111 ms, machine- and
    // load-dependent). That is per cleanliness reading, and `observeRuntime`
    // takes one per run. Worth knowing before anything adds a second probe.
    if (listing.stdout === '') return [];

    const parsed = parseSubmoduleStatus(listing.stdout);
    if (parsed !== null) {
      switch (await confirmAgainstIndex(git, worktreePath, parsed)) {
        case 'CONFIRMED':
          return parsed;
        // The index contradicting the listing about a path is a disagreement
        // this module may not resolve by picking a side, and an unreadable index
        // is a question that could not be asked. Neither is "clean".
        case 'CONTRADICTED':
        case 'UNREADABLE':
          return null;
        // A path this seam cannot carry as an argument. Nothing was
        // contradicted — the listing was read and only the confirmation is
        // unavailable — so take the source that needs no pathspec.
        case 'UNUSABLE_PATH':
          break;
      }
    }
  }

  return await gitlinksFromIndex(git, worktreePath);
}

/**
 * The paths of the **not-initialised** gitlinks in a `submodule status` listing,
 * or `null` if any line is unreadable.
 *
 * ── Why only the `-` lines, and why nothing is stripped ────────────────────
 *
 * `git submodule status` appends a ` (describe)` suffix for a *checked-out*
 * submodule and nothing for an unpopulated one. An earlier version of this
 * module took every line and stripped a trailing ` (…)` by **shape**, which is
 * a rewrite of a path Git had just told it verbatim — and a review measured what
 * that costs. Two ordinary gitlinks, added by two plain `git submodule add`
 * calls:
 *
 *     -f0cdac1… vendor
 *     -f0cdac1… vendor (old)
 *
 * Both collapsed to `vendor`. The index confirmed `vendor` twice, the directory
 * `vendor (old)` was never read, and the probe answered **clean** over a writer
 * file physically on disk — reopening, inside this module's own fix for it, the
 * data loss that fix exists to close.
 *
 * A `-` line's path is exact, so it is taken exactly. Populated gitlinks are not
 * returned at all: they are inside Git's reach, and the cleanliness vector's
 * `--ignore-submodules=none` has already reported on them. That also means no
 * describe suffix is ever parsed, so no path is ever rewritten — the shape of
 * the suffix, and whether a submodule's own path can end in `)`, stop being
 * questions this module has to get right.
 *
 * The index fallback has no flags, so it returns every gitlink; the `.git`
 * check in the caller is what distinguishes them there.
 */
function parseSubmoduleStatus(stdout: string): readonly string[] | null {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trimEnd();
    if (text.length === 0) continue;

    const parsed = SUBMODULE_STATUS_LINE.exec(text);
    const flag = parsed?.[1];
    const path = parsed?.[3];
    if (flag === undefined || path === undefined) return null;
    if (flag !== NOT_INITIALISED) continue;
    paths.push(path);
  }
  return paths;
}

/**
 * What the index says about the paths a listing named.
 *
 * Four answers, and the difference between the last two is the whole point.
 * Bounded by the pathspec, so this cannot inherit `ls-files`' unbounded output.
 *
 * `UNUSABLE_PATH` is not a failure: a submodule called `third party` or `bücher`
 * is an ordinary name that `doctor/exec.ts` will not carry as an argument, and
 * collapsing that into `UNREADABLE` made every such repository permanently
 * unobservable. `UNREADABLE` is Git failing to answer a question it was asked,
 * which is a different thing and refuses.
 */
type IndexConfirmation = 'CONFIRMED' | 'CONTRADICTED' | 'UNUSABLE_PATH' | 'UNREADABLE';

async function confirmAgainstIndex(
  git: GitRunner,
  worktreePath: string,
  paths: readonly string[],
): Promise<IndexConfirmation> {
  for (const path of paths) {
    if (!isShellInertArgument(path)) return 'UNUSABLE_PATH';

    const staged = await git(worktreePath, [
      'ls-files',
      '--stage',
      '-z',
      '--end-of-options',
      '--',
      path,
    ]);
    if (staged.outcome === 'REFUSED_UNSAFE_ARGUMENT') return 'UNUSABLE_PATH';
    if (staged.outcome !== 'OK') return 'UNREADABLE';
    // The entry must be a gitlink **at this exact path**. Matching the mode
    // alone would let a pathspec that happens to cover a *different* gitlink
    // answer for it, which is how a rewritten path went unnoticed once already.
    if (!hasGitlinkEntryAt(staged.stdout, path)) return 'CONTRADICTED';
  }
  return 'CONFIRMED';
}

/**
 * The gitlink paths in a whole-index `ls-files --stage`, or `null` when it could
 * not be read — including when its output exceeds the seam's cap, which is the
 * cost of this being a fallback rather than the primary source.
 */
async function gitlinksFromIndex(
  git: GitRunner,
  worktreePath: string,
): Promise<readonly string[] | null> {
  const staged = await git(worktreePath, ['ls-files', '--stage', '-z']);
  if (staged.outcome !== 'OK') return null;

  const paths: string[] = [];
  for (const entry of staged.stdout.split('\0')) {
    if (entry === '') continue;
    if (!entry.startsWith(`${GITLINK_MODE} `)) continue;
    // `<mode> <sha> <stage>\t<path>`. The tab is the only separator that cannot
    // occur inside a path, which is why `-z` is not enough on its own.
    const tab = entry.indexOf('\t');
    if (tab === -1) return null;
    paths.push(entry.slice(tab + 1));
  }
  return paths;
}

/**
 * Whether an `ls-files --stage` result records a gitlink at exactly `path`.
 *
 * `<mode> <sha> <stage>\t<path>`. The tab is the only separator that cannot
 * occur inside a path, which is why the comparison is made after it and not by
 * scanning the whole entry.
 */
function hasGitlinkEntryAt(stdout: string, path: string): boolean {
  for (const entry of stdout.split('\0')) {
    if (!entry.startsWith(`${GITLINK_MODE} `)) continue;
    const tab = entry.indexOf('\t');
    if (tab !== -1 && entry.slice(tab + 1) === path) return true;
  }
  return false;
}

/**
 * The entries of one directory, `[]` when it does not exist, or `null` when it
 * exists and could not be read.
 *
 * Not recursive, and never called on a path Git did not just call a gitlink.
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
