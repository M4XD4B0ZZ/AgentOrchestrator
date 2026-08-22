/**
 * The whole effect a task has had on its worktree, as Git reports it.
 *
 * ── Why the base is the pin and not the last checkpoint ────────────────────
 *
 * The question a scope guard has to answer is *what has this task done to this
 * repository*, and the only fixed point that means anything for a task is
 * `basePinnedCommit`: the commit its workspace was created at. Everything
 * between that commit and the current worktree is the task's doing, whether it
 * was written this pass, an earlier pass, or by a writer whose block was never
 * persisted.
 *
 * ── Why `git status` is not enough, and is the specific hole ───────────────
 *
 * Work reaches this task's branch as *commits*, so a `git status --porcelain`
 * check would report nothing at all about a change already recorded. That is
 * not an edge case: it is the normal shape of every pass after the first, and a
 * guard built on `status` would pass every task that committed its way out of
 * scope.
 *
 * Where those commits come from changed in DOGFOOD-REM-001 and this observation
 * did not have to. The writing agent used to be able to commit its own work;
 * under G1 it holds no shell and cannot, and `commitTaskWork` records the pass
 * on its behalf — after this measurement, which is what the scope gate is given
 * to judge. Either way the tree is clean afterwards and the cumulative delta,
 * not `status`, is what says what the task did.
 *
 * So the observation is cumulative:
 *
 *     basePinnedCommit
 *           ├── committed tracked changes   ┐
 *           ├── staged tracked changes      ├── git diff <base>
 *           ├── unstaged tracked changes    ┘
 *           ├── untracked, non-ignored      ─── git ls-files --others
 *           └── ignore files it introduced  ─── git ls-files --others --ignored
 *
 * `git diff <commit>` — without `--cached` — compares that commit against the
 * **working tree**, so all three tracked buckets fall out of one invocation.
 *
 * ── Three ways a writer attacks the observation rather than hiding in it ───
 *
 * Each has its own treatment below, and each was verified against real Git
 * rather than reasoned about:
 *
 *  - **`git replace`** re-points the pinned commit at a tree the writer built,
 *    so the diff is taken against the writer's own forgery. `--no-replace-objects`
 *    pins it — see {@link observeTaskDelta} and `pinned-scope.ts`.
 *  - **`update-index --assume-unchanged` / `--skip-worktree`** tell Git to stop
 *    comparing a tracked path with the worktree at all. Detected, and refused as
 *    `INDETERMINATE` — see {@link indexSuppressesComparison}.
 *  - **a writer-authored `.gitignore`** excludes the writer's own new files, and
 *    excludes itself along with them. Recovered — see {@link ignoreFilesAmong}.
 *
 * The first two are single ordinary Git commands run in the directory the loop
 * itself hands the writer; the third needs no Git command at all.
 *
 * ── Ignored files are not this slice's business ────────────────────────────
 *
 * `--exclude-standard` is what keeps build output, runtime state and editor
 * droppings from being reported as scope effects. It has to: the orchestrator
 * writes its own `.agent-orchestrator/runtime/<id>.json`, and `runtime-ignored.ts`
 * already refuses to start a task in a repository where that path is not
 * ignored. A guard that counted ignored files would therefore fail every task in
 * every correctly configured repository.
 *
 * A file that is **tracked** stays observed even when an ignore rule matches it,
 * because `git diff` reports tracked paths regardless of ignore rules. That is
 * the correct asymmetry, and the same one `runtime-ignored.ts` documents: an
 * ignore rule does not un-track a file, and editing a tracked file changes the
 * repository whatever `.gitignore` says.
 *
 * ── Renames are split rather than parsed ───────────────────────────────────
 *
 * `--no-renames` is a safety decision, not a performance one. With rename
 * detection on, moving `secret/key.ts` to `src/key.ts` is reported as a single
 * `R100` record, and a guard that read only the destination would see one
 * allowed path and wave through a deletion inside a directory the writer was
 * never granted. Turning detection off makes the same move two records — `D
 * secret/key.ts` and `A src/key.ts` — so both endpoints are classified
 * independently and the deletion cannot hide behind the addition.
 *
 * ── Parsing is positional, and refuses rather than guesses ─────────────────
 *
 * `-z` is what makes the stream parseable at all: it disables `core.quotePath`,
 * so a path with a space, a quote or a non-ASCII byte arrives verbatim instead
 * of C-quoted, and no separator can occur inside a field. `--no-color` closes
 * the matching hole from the other side — a repository-supplied `color.diff`
 * cannot decorate the status token this parser reads.
 *
 * The records alternate status, path, status, path. If a token where a status
 * belongs does not look like one, the whole observation is refused: a parser
 * that resynchronised by guessing would read a path as a status and every
 * subsequent path as belonging to the wrong entry — which is not a garbled
 * report but a wrong verdict, in a check whose entire job is to be right about
 * which paths changed.
 */

import type { GitRunner } from '../worktree/git-command.js';

/** What happened to one path, in Git's own vocabulary. Reporting only. */
export const CHANGE_KINDS = [
  'ADDED',
  'MODIFIED',
  'DELETED',
  'TYPE_CHANGED',
  'UNMERGED',
  /** Present in the worktree and not in the index. Never ignored — see above. */
  'UNTRACKED',
  /** A status Git reported that this module does not name individually. */
  'OTHER',
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ChangedPath {
  /** Repository-relative, POSIX-shaped, exactly as Git printed it. */
  readonly path: string;
  readonly change: ChangeKind;
}

/** Why a delta could not be established. Never rounded to "nothing changed". */
export const DELTA_REFUSALS = [
  /** The task carries no `basePinnedCommit`, so there is no base to diff from. */
  'NO_BASE_PIN',
  /** `git diff` did not run, or refused the base commit. */
  'DIFF_UNAVAILABLE',
  /** `git diff` ran and produced a stream this module will not interpret. */
  'DIFF_UNPARSABLE',
  /** `git ls-files --others` did not run. */
  'UNTRACKED_UNAVAILABLE',
  /** `git ls-files --others` produced records this module will not interpret. */
  'UNTRACKED_UNPARSABLE',
  /** The index carries bits that suppress worktree comparison — see below. */
  'INDEX_SUPPRESSES_WORKTREE',
  /** `git ls-files -v` did not run, so the index could not be cleared of them. */
  'INDEX_STATE_UNAVAILABLE',
  /** `git ls-files -v` produced records this module will not interpret. */
  'INDEX_STATE_UNPARSABLE',
] as const;

export type DeltaRefusal = (typeof DELTA_REFUSALS)[number];

export type TaskDelta =
  | { readonly outcome: 'OBSERVED'; readonly paths: readonly ChangedPath[] }
  | { readonly outcome: 'INDETERMINATE'; readonly refusal: DeltaRefusal };

/**
 * A `--name-status` token: one letter, optionally a similarity score.
 *
 * `R` and `C` are accepted although `--no-renames` should mean neither ever
 * arrives. The alternative to accepting them is a parser that refuses a stream
 * Git is entitled to produce if that flag ever stops being honoured — and since
 * both carry *two* paths, mis-consuming one is exactly the desynchronisation
 * this grammar exists to prevent. Both of their endpoints are recorded.
 */
const STATUS_TOKEN = /^([ACDMRTUXB])[0-9]{0,3}$/;

/** Statuses this module names. Anything else is `OTHER`, never dropped. */
const STATUS_KIND: Readonly<Record<string, ChangeKind>> = Object.freeze({
  A: 'ADDED',
  M: 'MODIFIED',
  D: 'DELETED',
  T: 'TYPE_CHANGED',
  U: 'UNMERGED',
});

/** Statuses that carry a source *and* a destination path. */
const TWO_PATH_STATUSES: ReadonlySet<string> = new Set(['R', 'C']);

/** NUL-separated fields, with the trailing terminator dropped. */
function fieldsOf(stdout: string): readonly string[] {
  return stdout.split('\0').filter((field) => field !== '');
}

/**
 * Parses `--name-status -z` records, or `null` if the stream is not one.
 *
 * A token is only ever *tested* as a status at a position where a status is
 * required, so a file genuinely named `A` is consumed as the path it is.
 */
function parseNameStatus(stdout: string): readonly ChangedPath[] | null {
  const fields = fieldsOf(stdout);
  const changed: ChangedPath[] = [];

  let index = 0;
  while (index < fields.length) {
    const token = fields[index];
    const match = token === undefined ? null : STATUS_TOKEN.exec(token);
    const letter = match?.[1];
    if (letter === undefined) return null;

    const pathCount = TWO_PATH_STATUSES.has(letter) ? 2 : 1;
    if (fields.length - (index + 1) < pathCount) return null;

    for (let offset = 1; offset <= pathCount; offset += 1) {
      const path = fields[index + offset];
      if (path === undefined) return null;
      changed.push(Object.freeze({ path, change: STATUS_KIND[letter] ?? 'OTHER' }));
    }
    index += pathCount + 1;
  }

  return changed;
}

/**
 * The `-t` tag every `--others` record carries, plus its separating space.
 *
 * `ls-files -t` prefixes each path with a status tag; under `--others` that tag
 * is always `?`. The prefix is the point — see {@link parseTaggedPaths}.
 */
const UNTRACKED_TAG = '? ';

/**
 * Parses `ls-files -t -z` records, or `null` if they are not that.
 *
 * ── Why `-t`, when the path alone is all this module wants ────────────────
 *
 * Because {@link GitRunner} hands back **trimmed** stdout, and without `-t` the
 * untracked stream *begins* with a path. A file whose name starts with a space
 * is then silently renamed by the trim before it is ever classified — and a
 * file literally named `" src"` at the repository root arrives here as `src`,
 * which a scope allowing `src` accepts. That is not a cosmetic loss: it is a
 * path outside the sandbox being classified as a path inside it, which is the
 * exact failure this whole module exists to prevent.
 *
 * `-t` puts a `?` in front of every record, so the first byte of the stream is
 * never part of a path and the trim can no longer reach one. The tracked stream
 * needed no such treatment: `--name-status` already begins with a status letter,
 * and both streams end with `NUL` rather than with a path.
 *
 * A record that does not carry the expected tag is refused rather than
 * salvaged, on the same reasoning as the status parser above: a prefix this
 * module guessed at is a path it got wrong.
 */
function parseTaggedPaths(stdout: string): readonly ChangedPath[] | null {
  const paths: ChangedPath[] = [];
  for (const field of fieldsOf(stdout)) {
    if (!field.startsWith(UNTRACKED_TAG)) return null;
    const path = field.slice(UNTRACKED_TAG.length);
    if (path === '') return null;
    paths.push(Object.freeze({ path, change: 'UNTRACKED' as const }));
  }
  return paths;
}

/** The name of an ignore file, at any depth. */
const IGNORE_FILE_NAME = '.gitignore';

/** `ls-files -v` marks a skip-worktree entry with this tag. */
const SKIP_WORKTREE_TAG = 'S';

/**
 * Whether the index carries a bit that stops Git comparing a path to the
 * worktree — `true`, `false`, or `null` when the records were not parseable.
 *
 * ── The bypass this closes ─────────────────────────────────────────────────
 *
 * `git update-index --assume-unchanged <path>` and `--skip-worktree <path>` both
 * tell Git to stop looking at a tracked file's working copy. After either, `git
 * diff <base>` reports **nothing** for that path however far its content has
 * moved. One ordinary Git command, run in the directory the loop itself hands
 * the writer, and an out-of-scope modification becomes invisible to the whole
 * observation above.
 *
 * There is no flag that makes `diff` ignore the bits — `-c core.ignoreStat=false`
 * does not, which was checked rather than assumed — so the only honest answer is
 * to notice they are set and refuse to produce a delta at all. That is
 * `INDETERMINATE`, not `VIOLATION`: the bits prove the observation cannot be
 * trusted, not what was hidden behind them.
 *
 * `-v` differs from `-t` in exactly the way this needs: it **lowercases** the
 * tag of an assume-unchanged entry and uses `S` for skip-worktree.
 */
function indexSuppressesComparison(stdout: string): boolean | null {
  for (const field of fieldsOf(stdout)) {
    const tag = field[0];
    if (tag === undefined || field[1] !== ' ') return null;
    if (tag === SKIP_WORKTREE_TAG) return true;
    if (tag >= 'a' && tag <= 'z') return true;
  }
  return false;
}

/**
 * Ignore files the task itself introduced, which no exclusion may rest on.
 *
 * ── The bypass this closes, and why it needs no Git command at all ─────────
 *
 * `--exclude-standard` reads the ignore rules **in the worktree**, and the
 * worktree is the writer's. Two plain file writes — `config/.gitignore`
 * containing `*`, and `config/backdoor.yaml` — make the second file ignored, and
 * therefore invisible to `ls-files --others --exclude-standard`. The rule also
 * matches `.gitignore` itself, so the ignore file disappears with it. Nothing is
 * committed, no Git command is run, and both paths vanish from the delta.
 *
 * The repair follows from a property of the workspace rather than from a new
 * rule: a task worktree starts as a **clean checkout of `basePinnedCommit`**, so
 * every untracked file in it is the task's own doing. An untracked `.gitignore`
 * is therefore always writer-authored — and it is a change to the repository at
 * a path, so it is classified against the declared scope like any other change.
 * A writer that plants one outside its allowed subtree is caught by the ordinary
 * rule; one that plants it *inside* its allowed subtree can only hide paths that
 * were already allowed, because an ignore pattern cannot reach above its own
 * directory.
 *
 * Only ignore files are recovered here. Ignored build output stays excluded —
 * that decision is the module's, stated above, and this does not retract it.
 */
function ignoreFilesAmong(stdout: string): readonly ChangedPath[] | null {
  const paths: ChangedPath[] = [];
  for (const field of fieldsOf(stdout)) {
    if (!field.startsWith(UNTRACKED_TAG)) return null;
    const path = field.slice(UNTRACKED_TAG.length);
    if (path === '') return null;
    if (path === IGNORE_FILE_NAME || path.endsWith(`/${IGNORE_FILE_NAME}`)) {
      paths.push(Object.freeze({ path, change: 'UNTRACKED' as const }));
    }
  }
  return paths;
}

/**
 * Observes everything this task has changed since it was pinned.
 *
 * Read-only, and never throws: a Git that could not answer produces
 * `INDETERMINATE`, which is a third answer rather than a quiet "nothing
 * changed". The distinction is the whole reason this returns a union — a guard
 * that read an unreadable repository as an empty delta would report every
 * unreachable Git as a clean bill of health.
 *
 * `worktreePath` must be the **authorised** worktree: the path Git printed for
 * this task's registration. Nothing here canonicalises or falls back.
 *
 * ── A note on the output budget ────────────────────────────────────────────
 *
 * `ls-files -v` lists every tracked path, and the Git seam caps output at 1 MiB.
 * A repository large enough to exceed that produces `UNAVAILABLE` and therefore
 * `INDETERMINATE`, which parks the task rather than passing it. That is the
 * right direction to fail in, and it is stated rather than left to be
 * discovered.
 */
export async function observeTaskDelta(
  git: GitRunner,
  worktreePath: string,
  basePinnedCommit: string | null,
): Promise<TaskDelta> {
  if (basePinnedCommit === null) {
    return Object.freeze({ outcome: 'INDETERMINATE' as const, refusal: 'NO_BASE_PIN' as const });
  }

  // Asked first, because it decides whether the diff below is worth believing.
  const indexState = await git(worktreePath, ['ls-files', '-v', '-z']);
  if (indexState.outcome !== 'OK') {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'INDEX_STATE_UNAVAILABLE' as const,
    });
  }
  const suppressed = indexSuppressesComparison(indexState.stdout);
  if (suppressed === null) {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'INDEX_STATE_UNPARSABLE' as const,
    });
  }
  if (suppressed) {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'INDEX_SUPPRESSES_WORKTREE' as const,
    });
  }

  // `--no-replace-objects` for the reason `pinned-scope.ts` gives at length: a
  // `refs/replace` mapping the writer installed would otherwise silently swap
  // the commit this diff is taken against, and an out-of-scope modification
  // measured against the writer's own forgery is no modification at all.
  const diff = await git(worktreePath, [
    '--no-replace-objects',
    'diff',
    '--name-status',
    '--no-renames',
    '--no-color',
    // Restates the Git default, so it changes nothing in an ordinarily
    // configured repository. What it removes is the observed repository's
    // ability to change it: `diff.ignoreSubmodules` or a `.gitmodules`
    // `ignore = all` hides a moved submodule pointer from this diff, and a
    // modification the scope gate cannot see is one it cannot refuse. Added
    // with the matching flag on the two `status` observers in V3-11, because
    // hardening the cleanliness question alone would have been worse than
    // hardening neither: a change invisible here but visible there would be
    // committed by the settlement rather than blocked by the gate.
    '--ignore-submodules=none',
    '-z',
    '--end-of-options',
    basePinnedCommit,
    '--',
  ]);
  if (diff.outcome !== 'OK') {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'DIFF_UNAVAILABLE' as const,
    });
  }

  const tracked = parseNameStatus(diff.stdout);
  if (tracked === null) {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'DIFF_UNPARSABLE' as const,
    });
  }

  const others = await git(worktreePath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--full-name',
    '-t',
    '-z',
  ]);
  if (others.outcome !== 'OK') {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'UNTRACKED_UNAVAILABLE' as const,
    });
  }

  const untracked = parseTaggedPaths(others.stdout);
  if (untracked === null) {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'UNTRACKED_UNPARSABLE' as const,
    });
  }

  // The ignored half, consulted only for ignore files the task introduced.
  // `--directory` collapses a wholly-ignored directory into one entry, which is
  // what keeps `node_modules` from being enumerated file by file.
  const ignored = await git(worktreePath, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--full-name',
    '-t',
    '-z',
  ]);
  if (ignored.outcome !== 'OK') {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'UNTRACKED_UNAVAILABLE' as const,
    });
  }

  const introducedIgnores = ignoreFilesAmong(ignored.stdout);
  if (introducedIgnores === null) {
    return Object.freeze({
      outcome: 'INDETERMINATE' as const,
      refusal: 'UNTRACKED_UNPARSABLE' as const,
    });
  }

  return Object.freeze({
    outcome: 'OBSERVED' as const,
    paths: Object.freeze([...tracked, ...untracked, ...introducedIgnores]),
  });
}
