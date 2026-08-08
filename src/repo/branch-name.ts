/**
 * The Git branch-name grammar, applied to a profile-declared default branch.
 *
 * The profile schema only guarantees a non-empty, shell-inert string. That is
 * not the same as a name Git will accept, and the difference matters twice:
 *
 *  - a name that Git rejects can never identify a real branch, so accepting it
 *    would let a repository resolve against a base that cannot exist;
 *  - the name is handed to `git` as an argument, so it must be certain not to
 *    look like an option or a revision expression.
 *
 * The rules below are the `git check-ref-format --branch` rules that apply to a
 * single branch name. They are implemented here, in this repository, rather
 * than delegated to a `git check-ref-format` subprocess: a validation that has
 * to start a process cannot run *before* the value is considered safe to pass
 * to a process.
 */

/**
 * Characters allowed in a branch name, intersected with the shell-inert set the
 * profile schema already enforces. `~`, `^`, `:`, `?`, `*`, `[`, `\`, space and
 * every ASCII control character are excluded by construction rather than by a
 * later check.
 */
const BRANCH_CHARACTER_PATTERN = /^[A-Za-z0-9._+=@/-]+$/;

/** A ref path that is certain to be safe as a single `git` argument. */
export const LOCAL_BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * `true` only for a name Git itself would accept as a branch.
 *
 * Never a shape guess: every clause below is a documented `check-ref-format`
 * rule, and anything not positively allowed is rejected.
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (!BRANCH_CHARACTER_PATTERN.test(name)) return false;

  // A leading dash would be read as an option by every Git command.
  if (name.startsWith('-')) return false;
  if (name === '@') return false;
  if (name.includes('..')) return false;
  if (name.includes('@{')) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('//')) return false;
  if (name.endsWith('.')) return false;

  for (const component of name.split('/')) {
    if (component.length === 0) return false;
    if (component.startsWith('.')) return false;
    if (component.endsWith('.lock')) return false;
  }

  return true;
}

/** The local ref a validated branch name denotes. */
export function localBranchRef(name: string): string {
  return `${LOCAL_BRANCH_REF_PREFIX}${name}`;
}
