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

/** `true`/`false` when Git resolved the object, `null` when it could not say. */
export async function commitObjectPresent(
  git: GitRunner,
  cwd: string,
  commit: string,
): Promise<boolean | null> {
  const probe = await git(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${commit}^{commit}`,
  ]);
  if (probe.outcome === 'OK') return true;
  if (probe.outcome === 'NONZERO_EXIT' && probe.exitCode === ANSWERED_NO_EXIT) return false;
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
 */
export async function commitIsReferenced(
  git: GitRunner,
  cwd: string,
  commit: string,
): Promise<boolean | null> {
  const probe = await git(cwd, [
    'for-each-ref',
    '--count=1',
    `--contains=${commit}`,
    '--format=%(refname)',
  ]);
  if (probe.outcome !== 'OK') return null;
  return probe.stdout.length > 0;
}
