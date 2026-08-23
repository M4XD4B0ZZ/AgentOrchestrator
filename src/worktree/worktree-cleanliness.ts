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
 * The cost, measured rather than asserted, because the two previous versions of
 * this sentence were both wrong:
 *
 *   dirty by `git status`                     1 call   (the probe never runs)
 *   no submodules                             2
 *   every gitlink populated                   2        (the `-` filter empties
 *                                                       the set before `ls-files`)
 *   any unpopulated gitlink                   3
 *   more pathspec than the argument budget    3 + one per extra chunk
 *   either source unusable                    + 1 whole-index fallback
 *
 * So: **two calls for an ordinary repository, three when a gitlink is
 * unpopulated**, and a bound rather than a promise past that.
 *
 * The count is spelled out here because both previous shapes of it were wrong.
 * The first looped the confirmation, and a review measured thirty gitlinks
 * costing thirty-two subprocesses and ~3.5 seconds under a comment that already
 * called it "one bounded observation". The fix put every path on one command
 * line, and the next review measured *that* refused past ~32,700 characters —
 * whereupon the probe fell back to the whole index and answered "not
 * established" for a **clean** repository with sixteen hundred submodules, which
 * the loop had answered correctly. An unbounded loop and an unbounded argv are
 * the same defect wearing different clothes; chunking is what actually bounds it.
 *
 * It observes paths Git says are gitlinks, and nothing else. It does not
 * populate, initialise, repair, clean, or recurse into arbitrary directories,
 * and it takes no view on what a submodule *should* contain. AO does not own the
 * submodule; it owns the question of whether the worktree it is about to certify
 * holds bytes nobody classified.
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
 * large enough repository exceeds the seam's 1 MiB output cap and the probe
 * would answer "not established" for every ordinary monorepo — the same
 * unbounded-output defect this remediation removed from the cleanliness vector.
 *
 * That threshold is a byte total, not a file count, and stating it as a count
 * without its premise is the error the sibling comment in `git-command.ts` was
 * corrected for. An entry costs `51 + len(path)` bytes: measured, this
 * repository's own 296 tracked files take 24,478 bytes — 82.7 B/entry — so its
 * cap falls at about **12,700** files. A fixture whose paths are four times
 * *longer* (179.9 B/entry, a 129-character mean) reaches it at about **5,800**.
 *
 * That sentence has been wrong twice: first "shorter" for longer, then "reached
 * it at 7,003" — which is the *size* of the fixture, not its cap, put beside a
 * computed cap in the paragraph whose whole subject is that a file count without
 * its byte premise misleads. The README was corrected and this was not; a
 * correction applied to one copy of a claim is half a correction.
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
 * neither source can answer.
 *
 * That trades a certain stall in three ordinary shapes for an unbounded read in
 * those same shapes, and the trade is not free: a repository that is both large
 * and unusually shaped — measured, 7,003 tracked files plus one unmapped
 * embedded repository, a clean tree — floods the cap on the fallback and stalls
 * exactly as before. Fail-closed on authority, and a permanent stop for an
 * operator on availability. Carried as **L-V3-11-15**.
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
 *  - a writer that fabricates a **well-formed** `.git` inside the gitlink. Git
 *    then treats the directory as a real, clean checkout and reports nothing,
 *    and the probe answers `true` over payload still on disk. Measured `true`
 *    for the same fixture *before* this module existed, so it is a carried limit
 *    rather than a regression (**L-V3-11-13**). Its destructive half is closed by
 *    Git's own refusal to remove a worktree holding a populated gitlink — five
 *    fabricated shapes were driven to `git worktree remove` and every one either
 *    made `status` exit 128 or was refused at 128 with the payload intact. The
 *    authority half is not closed.
 *
 *    Two things about it were stated wrongly here before. `git init` is not
 *    needed: a hand-placed `.git` *file* containing
 *    `gitdir: …/.git/modules/<name>` — the reach of a writer holding only
 *    `Write` — produces the same reading. And which signal makes the probe defer
 *    depends on the shape, so anyone closing this by watching one of them will
 *    miss the other.
 *
 *    **Do not add a fourth version of the flag rule.** Three have now been
 *    written here and all three were false, the last two after a review measured
 *    the previous one wrong. What is measured, on five fabricated shapes: a
 *    `.git` file pointing at a gitdir that resolves gives flag `-` *and* a
 *    working `git status` — which refutes both "the flag is a space when the
 *    gitdir resolves" and "a `-` flag means `status` aborts". Isolated on one
 *    directory with no file changed, `git submodule init` flipped the flag from
 *    `-` to a space by writing only `submodule.<name>.url` and `.active` into
 *    the local config, so the flag tracks **config initialisation together with
 *    a gitdir that resolves here**, not either alone. Treat that as the last
 *    word only until someone measures it again;
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
 * The flag is **optional**, and the reason is now historical rather than
 * current. It was written when this parser read `stdout`, which `runGitCommand`
 * trims: an in-sync submodule — whose flag *is* a space — arrived with no flag
 * at all when it was the first line. The parser reads `rawStdout` now, so the
 * leading space is present and the optional arm is dead for the production
 * runner.
 *
 * It is kept for the runners that supply no `rawStdout`, where the old shape
 * still arrives, and because an absent flag can only ever have been the space —
 * the other three are not whitespace, so nothing is lost by accepting it.
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
 * How many characters of pathspec one confirmation call may carry.
 *
 * The invariant is the **command line**, not the argument characters, and saying
 * it the other way round is how this comment was first written. Measured through
 * `runGitCommand`, varying only argument size at the boundary: the command line
 * refuses at about 32,727 characters every time, while the *accepted* argument
 * total that corresponds to it ranges from 16,377 (many one-character arguments,
 * where per-argument overhead dominates) to 32,135 (few long ones). For this
 * probe's real shape — many short paths — the honest figure is nearer 16,000
 * than 32,000.
 *
 * This budget counts `len + 1` per path, which is what the command line actually
 * spends, and 8,000 of them yield a ~8,043-character command line: under even
 * the worst-shaped ceiling by a factor of two. Being under it costs an extra
 * subprocess; being over it costs a repository its observability.
 */
const ARGUMENT_BUDGET_CHARS = 8_000;

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
 * repositories through the real reader.
 *
 * All three production call sites pass two arguments and take the default. Note
 * what that does *not* buy: nothing refuses a future caller that passes
 * `() => []` and silences the probe. This is a test seam on an exported
 * function, and it is worth the cost only while it stays one.
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

    // `rawStdout` when the runner supplies it, because {@link GitCommandResult}
    // `stdout` is `.trim()`ed and this is the one reader that parses **paths**
    // out of a command's output. A final gitlink path ending in U+00A0 (or
    // U+3000, U+2009, U+FEFF) arrives shortened otherwise, and a shortened path
    // that matches a real sibling gitlink makes the loop below read the wrong
    // directory entirely. Measured at the previous HEAD: a worktree with
    // `vendnb` populated and `vendnb ` holding a planted file answered
    // **clean**, in three calls, having confirmed and skipped `vendnb` twice.
    //
    // The intact path is what closes it, and not because this module handles it
    // specially: `vendnb ` is not a `SAFE_ARG_PATTERN` argument, so the
    // confirmation answers `UNUSABLE_PATH` and the probe takes the NUL-separated
    // index, which no trim can shorten.
    const parsed = parseSubmoduleStatus(listing.rawStdout ?? listing.stdout);
    // Two `-` lines can never legitimately name one path: an index cannot hold
    // two gitlinks at the same place. A duplicate therefore proves a path was
    // **rewritten between Git and here**, and it is not this module that did it —
    // `runGitCommand` trims the whole stdout, so a final path ending in
    // whitespace Git prints verbatim (U+00A0, U+3000, U+2009, U+FEFF …) arrives
    // already shortened. Measured: gitlinks `vendnb` and `vendnb ` listed as
    // two lines and arrived as two identical paths, the confirmation went out as
    // `-- vendnb vendnb`, the second directory was never read, and the probe
    // answered clean over a planted file.
    //
    // The index is immune — `-z` separates with NUL, which `trim` does not touch
    // — so a collapse takes the fallback and gets the right answer rather than
    // merely refusing. A *lone* mangled path needs no rule here: it fails the
    // confirmation and is `CONTRADICTED` already.
    //
    // **This guard is the backstop, not the fix**, and the distinction is the
    // whole lesson of the rounds that produced it. It sees a collapse only when
    // both colliding paths are `-` lines. When the shortened path lands on a
    // *populated* sibling, that sibling's line is filtered out above and no
    // duplicate ever forms — measured, and it answered clean over a planted file.
    // The reason it is nevertheless sound now is that the line above reads
    // `rawStdout`, so through the production runner no collapse happens at all.
    // What remains for this guard is a runner that supplies no `rawStdout`.
    if (parsed !== null && hasDuplicate(parsed)) return await gitlinksFromIndex(git, worktreePath);
    if (parsed !== null) {
      switch (await confirmAgainstIndex(git, worktreePath, parsed)) {
        case 'CONFIRMED':
          return parsed;
        // The index **contradicting** the listing about a path is the one answer
        // that refuses. It is a disagreement between two authorities, and this
        // module may not resolve it by picking a side.
        case 'CONTRADICTED':
          return null;
        // The other two are "this question could not be put", not "the answer is
        // no": a path this seam will not carry as an argument, or a call Git
        // could not complete. The index needs no pathspec and is the authority
        // for gitlinks anyway, so ask it instead of stalling.
        case 'UNUSABLE_PATH':
        case 'UNREADABLE':
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
    // `\r` only, and **never** `trimEnd()`. `trimEnd` strips every ECMAScript
    // WhiteSpace, which includes U+00A0, U+3000, U+2009 and U+FEFF — so it
    // rewrites a path whose last character is one of them, which is the very
    // thing the docstring above promises never happens. Measured: two ordinary
    // gitlinks `vendnb` and `vendnb ` collapsed to one, the confirmation
    // was issued as `-- vendnb vendnb`, the second directory was never read, and
    // the probe answered clean over a planted file that the removal then
    // deleted. That is the same defect `stripDescribeSuffix` caused, through a
    // different helper, two rounds later.
    //
    // `split('\n')` can leave exactly one thing behind — a `\r` — because
    // `runGitCommand` has already trimmed the whole stdout.
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
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
 * Bounded by the pathspec, so this cannot inherit `ls-files`' unbounded output.
 *
 * Only `CONTRADICTED` refuses. The other two failures — a path
 * `doctor/exec.ts` will not carry as an argument (a submodule called
 * `third party` or `bücher` is an ordinary name), and a call Git could not
 * complete — mean the question could not be *put*, which is not an answer about
 * the worktree. Both send the probe to the index, which needs no pathspec and is
 * the authority for gitlinks in any case.
 *
 * They are kept apart rather than merged because they are different facts and a
 * future reader will want to know which happened; an earlier version collapsed
 * `UNUSABLE_PATH` into `UNREADABLE` and made three ordinary repository shapes
 * permanently unobservable.
 *
 * `UNUSABLE_PATH` currently has one reachable producer, not two:
 * `isShellInertArgument` is the same predicate `runCommand` applies, so a path
 * that passes it here cannot be refused there. The second arm is defence against
 * that stopping being true, and is unreachable through every production runner.
 */
type IndexConfirmation = 'CONFIRMED' | 'CONTRADICTED' | 'UNUSABLE_PATH' | 'UNREADABLE';

async function confirmAgainstIndex(
  git: GitRunner,
  worktreePath: string,
  paths: readonly string[],
): Promise<IndexConfirmation> {
  if (paths.length === 0) return 'CONFIRMED';
  if (!paths.every((path) => isShellInertArgument(path))) return 'UNUSABLE_PATH';

  // Batched, and **chunked**. A first version issued one call per path — thirty
  // gitlinks cost thirty-two subprocesses and ~3.5 seconds — and the fix for
  // that put every path on one command line, which traded an unbounded loop for
  // an unbounded argv. Measured through the production runner: the call is
  // refused past roughly 32,700 characters of **command line** — see the budget
  // constant for why that is the invariant and the argument total is not — and the
  // probe then fell
  // back to reading the whole index, which on a large repository floods the
  // 1 MiB output cap and answers "not established" for a **clean** tree. So the
  // shape that reintroduced the stall was the fix for the loop.
  //
  // The refusal is a refusal and not a truncation — `runCommand` maps the spawn
  // error to `SPAWN_FAILED` — so nothing ever answered about a shortened list.
  // That is the only reason this was an availability defect and not a false
  // clean.
  const confirmed = new Set<string>();
  for (const chunk of chunkedByArgumentBudget(paths)) {
    const staged = await git(worktreePath, [
      'ls-files',
      '--stage',
      '-z',
      '--end-of-options',
      '--',
      ...chunk,
    ]);
    if (staged.outcome === 'REFUSED_UNSAFE_ARGUMENT') return 'UNUSABLE_PATH';
    if (staged.outcome !== 'OK') return 'UNREADABLE';

    const gitlinks = gitlinkPathsIn(staged.stdout);
    if (gitlinks === null) return 'UNREADABLE';
    for (const path of gitlinks) confirmed.add(path);
  }

  // Every path must come back as a gitlink **at that exact path**. Matching the
  // mode alone, or matching a set against a count, would let one gitlink answer
  // for another — which is how a rewritten path went unnoticed once already.
  return paths.every((path) => confirmed.has(path)) ? 'CONFIRMED' : 'CONTRADICTED';
}

/** Whether any path appears twice. See the call site for why that is a fact. */
function hasDuplicate(paths: readonly string[]): boolean {
  return new Set(paths).size !== paths.length;
}

/**
 * Splits paths into groups that fit comfortably on one command line.
 *
 * The measured ceiling on this platform is ~32,700 characters of **command
 * line**, which is the invariant; the argument total that corresponds to it
 * ranges 16,377-32,135 with argument shape, so it is not the thing to bound;
 * {@link ARGUMENT_BUDGET_CHARS} is a fraction of it, because the ceiling counts
 * the executable and the fixed tokens too and because a margin costs one extra
 * subprocess while exceeding it costs a repository its observability.
 *
 * A single path longer than the budget still gets its own chunk rather than
 * being dropped: the call may then be refused, which is `UNREADABLE`, which
 * falls back — never a silent omission.
 */
function* chunkedByArgumentBudget(paths: readonly string[]): Generator<readonly string[]> {
  let chunk: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (chunk.length > 0 && chars + path.length + 1 > ARGUMENT_BUDGET_CHARS) {
      yield chunk;
      chunk = [];
      chars = 0;
    }
    chunk.push(path);
    chars += path.length + 1;
  }
  if (chunk.length > 0) yield chunk;
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

  const paths = gitlinkPathsIn(staged.stdout);
  return paths === null ? null : [...paths];
}

/**
 * Every gitlink path in an `ls-files --stage` result, or `null` if an entry
 * could not be read.
 *
 * `<mode> <sha> <stage>\t<path>`. The tab is the only separator that cannot
 * occur inside a path, so the path is taken after it rather than by splitting on
 * spaces.
 */
function gitlinkPathsIn(stdout: string): ReadonlySet<string> | null {
  const paths = new Set<string>();
  for (const entry of stdout.split('\0')) {
    if (entry === '') continue;
    if (!entry.startsWith(`${GITLINK_MODE} `)) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) return null;
    paths.add(entry.slice(tab + 1));
  }
  return paths;
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
    //
    // `ENOTDIR` — a *file* where the gitlink's directory should be — is read the
    // same way, and that is only safe because `git status` runs first and reports
    // such a tree as modified, so this arm is never the deciding one. Named
    // because the dependency is not obvious from here.
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    return null;
  }
}
