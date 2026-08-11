/**
 * A scripted Git for the V2-06 scope guard.
 *
 * ── Why a seam at all, when the guard is about real repositories ───────────
 *
 * The scope guard's own suite drives it against **real** repositories, and it
 * has to: the facts it rests on — that a committing writer leaves a clean tree,
 * that a rename is two records under `--no-renames`, that an untracked file is
 * listed by `ls-files --others` — are claims about Git, and a fake that agreed
 * with them would prove only that it agreed.
 *
 * This exists for the two kinds of case a real repository cannot be asked to
 * produce on demand:
 *
 *  - **A Git that cannot answer.** An unreadable repository, a pin that no
 *    longer resolves, a profile absent from the pinned tree. These are the
 *    inputs that must produce `INDETERMINATE` rather than a verdict, and the
 *    difference between "could not check" and "checked and clean" is the whole
 *    reason the assessment has three members instead of two.
 *  - **A stream this parser must refuse.** A `--name-status` record whose status
 *    token is not a status is a desynchronised parse, and a desynchronised parse
 *    is a wrong verdict rather than a garbled message. No real Git emits one.
 *
 * It is also what lets the older loop suites keep their subject. They build a
 * synthetic root — a bare temp directory, a `worktree` that was never created
 * and a fabricated base SHA — because they are about the loop's *routing*, not
 * about Git. Once a mutating step reads the repository for real, every one of
 * them would fail closed on "this is not a repository": a true answer to a
 * question those tests are not asking. Supplying the world explicitly keeps each
 * test's subject its own, exactly as `settledObserver` already does there.
 */

import type { GitCommandResult, GitRunner } from '../../src/worktree/git-command.js';
import { e2eProfile } from './e2e-fixtures.js';

function ok(stdout: string): GitCommandResult {
  return Object.freeze({ outcome: 'OK' as const, stdout, exitCode: 0 });
}

const UNAVAILABLE: GitCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
  exitCode: null,
});

/** Fields as Git writes them under `-z`: NUL-separated, NUL-terminated. */
export function nulJoin(fields: readonly string[]): string {
  return fields.length === 0 ? '' : `${fields.join('\0')}\0`;
}

/**
 * `ls-files --others -t -z` records, exactly as Git writes them.
 *
 * The `? ` tag is not decoration: it is what keeps the trimmed stdout of
 * `runGitCommand` from eating the first path's leading whitespace.
 */
export function untrackedRecords(paths: readonly string[]): string {
  return nulJoin(paths.map((path) => `? ${path}`));
}

export interface GitScript {
  /**
   * What `git show <base>:<profile>` returns. `null` makes it fail, which is
   * how "the pin is gone" and "the profile was never committed" are expressed.
   * Defaults to the shared e2e profile, whose scope allows `src` only.
   */
  readonly profile?: string | null;
  /** `diff --name-status -z` stdout. `null` fails the command. Default: empty. */
  readonly diff?: string | null;
  /** `ls-files --others -t -z` stdout. `null` fails the command. Default: empty. */
  readonly untracked?: string | null;
  /** `ls-files --others --ignored -t -z` stdout. `null` fails. Default: empty. */
  readonly ignored?: string | null;
  /**
   * `ls-files -v -z` stdout — the index state.
   *
   * Default: empty, which is an index carrying no suppression bits. Supply
   * records like `h src/a.ts` (lowercase tag) or `S src/a.ts` to drive the
   * assume-unchanged / skip-worktree refusal.
   */
  readonly indexState?: string | null;
}

/** Which of the guard's questions this argument vector is asking. */
function question(args: readonly string[]): 'show' | 'diff' | 'index' | 'ignored' | 'untracked' | null {
  if (args.includes('show')) return 'show';
  if (args.includes('diff')) return 'diff';
  if (!args.includes('ls-files')) return null;
  if (args.includes('-v')) return 'index';
  return args.includes('--ignored') ? 'ignored' : 'untracked';
}

/**
 * A {@link GitRunner} answering only the questions the guard asks.
 *
 * Anything else is `UNAVAILABLE` rather than a plausible answer: a stub that
 * invented replies to commands the subject was not expected to run would hide
 * the subject running them.
 *
 * The dispatch is by *membership* rather than by `args[0]`, because the object
 * reads carry leading global flags — `git --no-replace-objects diff …` — and a
 * stub keyed on the first token would silently stop recognising them the moment
 * one was added, answering `UNAVAILABLE` and turning every scope check into an
 * indeterminate one.
 */
export function scriptedGit(script: GitScript = {}): GitRunner {
  return async (_cwd, args) => {
    const answer = (value: string | null | undefined, fallback: string): GitCommandResult => {
      const resolved = value === undefined ? fallback : value;
      return resolved === null ? UNAVAILABLE : ok(resolved);
    };

    switch (question(args)) {
      case 'show':
        return answer(script.profile, e2eProfile());
      case 'diff':
        return answer(script.diff, '');
      case 'index':
        return answer(script.indexState, '');
      case 'ignored':
        return answer(script.ignored, '');
      case 'untracked':
        return answer(script.untracked, '');
      default:
        return UNAVAILABLE;
    }
  };
}

/**
 * The Git a healthy repository would be for a task that has changed nothing.
 *
 * The scope resolves, the delta is empty, so the verdict is `WITHIN_SCOPE` and a
 * mutating step proceeds exactly as it did before V2-06.
 */
export const cleanScopeGit: GitRunner = scriptedGit();

/**
 * The three answers a task that changed nothing produces, for suites that
 * already own a scripted Git and only need the scope questions covered.
 *
 * Returns `null` for anything else, so a caller keeps its own handling —
 * including the discipline of throwing on a call it never scripted, which is
 * what makes an unexpected Git invocation visible instead of quietly answered.
 */
export function cleanScopeAnswer(args: readonly string[]): GitCommandResult | null {
  switch (question(args)) {
    case 'show':
      return ok(e2eProfile());
    case 'diff':
    case 'index':
    case 'ignored':
    case 'untracked':
      return ok('');
    default:
      return null;
  }
}
