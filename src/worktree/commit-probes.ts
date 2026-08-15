/**
 * The Git exit-status protocols this build reads, in one place.
 *
 * Three questions are asked of a commit — is it an ancestor of that one, does
 * the object exist, does any ref contain it — and the first two are answered by
 * an *exit status* rather than by output. That makes them the two places in the
 * build where "no" and "I could not tell" are separated by an integer, and a
 * second implementation of either would be a second opinion about what exit 128
 * means. `state/observe-runtime.ts` had both first and documented them; this
 * module is where they now live, so the chain proof and the reconciler share one
 * reading and cannot drift apart.
 *
 * Nothing here writes, and nothing here throws: the seam already treats failure
 * as data, and each function turns that data into an answer or into an explicit
 * refusal to answer.
 */

import type { GitRunner } from './git-command.js';

/**
 * What the ancestry probe established — including that it established nothing.
 *
 * `merge-base --is-ancestor` answers with its exit status, where **0** is yes,
 * **1** is a genuine no, and anything else (128 in practice) is a refusal to
 * evaluate. Reporting a refusal as "no" would tell an operator their base commit
 * was rewritten when in truth the repository could not be read.
 */
export type AncestryVerdict = 'ANCESTOR' | 'NOT_ANCESTOR' | 'INDETERMINATE';

/**
 * The one exit code these probes use to *answer* "no".
 *
 * The protocol, stated because this is a place that reads an exit status:
 *
 *  - **0** — the question was answered yes;
 *  - **1** — the question was answered no. A real answer, and the only non-zero
 *    one that is;
 *  - **anything else** (128 in practice) — Git could not evaluate the question:
 *    a repository it cannot read, a refusal, a bad invocation. Never an answer.
 *
 * An indeterminate failure reported as "the commit is gone" sends an operator
 * hunting for a force-push that never happened.
 */
const ANSWERED_NO_EXIT = 1;

/** Whether `ancestorCommit` is an ancestor of (or equal to) `descendantCommit`. */
export async function classifyAncestry(
  git: GitRunner,
  cwd: string,
  ancestorCommit: string,
  descendantCommit: string,
): Promise<AncestryVerdict> {
  const probe = await git(cwd, [
    'merge-base',
    '--is-ancestor',
    '--end-of-options',
    ancestorCommit,
    descendantCommit,
  ]);
  if (probe.outcome === 'OK') return 'ANCESTOR';
  if (probe.outcome === 'NONZERO_EXIT' && probe.exitCode === ANSWERED_NO_EXIT) return 'NOT_ANCESTOR';
  return 'INDETERMINATE';
}

/**
 * `true`/`false` when Git resolved the object, `null` when it could not say.
 *
 * ── Why not `rev-parse --verify <sha>^{commit}` ────────────────────────────
 *
 * That is the idiomatic spelling and this build cannot use it. The Git seam
 * refuses any argument that is not shell-inert — `SAFE_ARG_PATTERN` in
 * `doctor/exec.ts` deliberately excludes `^`, `{` and `}`, because the command
 * line it builds is handed to `cmd.exe /s` verbatim and `^` is that shell's
 * escape character. So `<sha>^{commit}` never spawns: it comes back
 * `REFUSED_UNSAFE_ARGUMENT`, which is not `OK` and not exit 1, so the probe
 * answered `null` for every input it was ever given.
 *
 * That was measured, not reasoned about, and it had been true since the probe
 * was written: the existing tests drive an injected runner, so they proved the
 * *classification* of Git's answers and never that Git was asked anything. The
 * real-repository controls in `tests/v2-09-dependent-commit-chain.test.ts` exist
 * because of it — an argument-safety refusal is invisible to a seam test by
 * construction.
 *
 * Dropping the peel is not an option either: `rev-parse --verify` returns exit 0
 * for *any* full-length hex string, whether or not the repository has it.
 *
 * ── So: `cat-file`, and two questions on the unhappy path only ─────────────
 *
 * `cat-file -t` names the object's type, which answers "is this a commit"
 * exactly — a blob is present and is not something a workspace can be built on.
 * Its one weakness is that a missing object and an unreadable repository both
 * exit 128, and those must not be the same answer. `cat-file -e` separates them
 * with the clean 0/1/128 protocol, and is asked only when the first question
 * failed, so the happy path stays a single subprocess.
 */
export async function commitObjectPresent(
  git: GitRunner,
  cwd: string,
  commit: string,
): Promise<boolean | null> {
  const type = await git(cwd, ['cat-file', '-t', '--end-of-options', commit]);
  if (type.outcome === 'OK') return type.stdout === 'commit';

  const existence = await git(cwd, ['cat-file', '-e', '--end-of-options', commit]);
  if (existence.outcome === 'NONZERO_EXIT' && existence.exitCode === ANSWERED_NO_EXIT) return false;
  // Either Git could not be read, or it says the object exists while refusing to
  // name its type. Both are refusals to answer, and neither is "it is gone".
  return null;
}

/**
 * `true` when some ref contains `commit`.
 *
 * Existence and reachability are different facts and the chain needs both. An
 * object that exists but no ref contains is either about to be pruned or is the
 * discarded tip of a branch somebody deleted — chaining onto the second would
 * resurrect abandoned work into a successor's pull request, silently.
 *
 * `--count=1` because the question is existential; the ref that answers it is
 * not interesting and must not reach an operator-facing report.
 *
 * No `--format`, for the reason {@link commitObjectPresent} sets out at length:
 * `%(refname)` contains `%`, `(` and `)`, none of which the seam's shell-inert
 * allow-list admits, so the flag would refuse the whole command rather than
 * shape its output. The default format is read for its *length* alone, which is
 * all this question needs, and the bytes never leave this function.
 */
export async function commitIsReferenced(
  git: GitRunner,
  cwd: string,
  commit: string,
): Promise<boolean | null> {
  const probe = await git(cwd, ['for-each-ref', '--count=1', `--contains=${commit}`]);
  if (probe.outcome !== 'OK') return null;
  return probe.stdout.length > 0;
}
