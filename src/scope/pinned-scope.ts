/**
 * The scope declaration that governs a run, read from the commit the run was
 * pinned to.
 *
 * ── Why not `repository.scope` ─────────────────────────────────────────────
 *
 * `resolveRepository` already produced a `ResolvedScopePolicy`, and using it
 * here would have been one field access instead of this module. It is the wrong
 * source for a *guard*, for the reason V2-02 established about the execution
 * brief: the value describes the **source checkout**, which is whatever the
 * default branch looks like right now, and the tree a writer actually changes is
 * the pinned worktree. A profile edited on `main` while a task is in flight
 * would silently re-scope a run already under way, in either direction — a
 * widened allow list retroactively authorising work the operator never reviewed
 * is the direction that matters.
 *
 * ── Why not the worktree's own profile either ──────────────────────────────
 *
 * The obvious repair — read the profile out of the authorised worktree — is
 * worse than the problem. That tree is the one the writing agent has write
 * access to, so a guard reading its scope from it would ask the writer how far
 * the writer is allowed to go. Self-authorisation, one file edit away.
 *
 * So the source is the pinned **commit**: `git show <basePinnedCommit>:<profile>`.
 * A writer can dirty a worktree; it cannot change what a commit that already
 * exists *contains*. If it rewrote history so thoroughly that the pin no longer
 * resolves, `git show` fails and this module refuses — which is the fail-closed
 * direction. The scope in force for a run is therefore fixed at the moment the
 * run was pinned, and is the same scope on the last pass as on the first.
 *
 * That premise is about a commit's **content**, and it is only half the story:
 * a commit's *resolution* is not immutable, and `git replace` is the command
 * that changes it. See the flag below — without it the paragraph above is a
 * comforting sentence rather than a guarantee.
 *
 * ── The profile is re-validated, not trusted ───────────────────────────────
 *
 * The bytes are parsed by the same two boundaries any profile goes through:
 * `loadProfileDocument` for the YAML rules (plain 1.2 core schema, warnings
 * refused, `__proto__` refused at any depth, one document only) and
 * `safeParseRepoProfile` for the contract. A commit is not a trustworthy
 * document merely because it is immutable — it is repository-supplied input like
 * any other, and the one at the pin may predate a schema version this build
 * understands. Reusing both boundaries is also what keeps this module from
 * becoming a second, quieter opinion about what a profile is.
 */

import { REPO_PROFILE_RELATIVE_PATH } from '../repo/profile-location.js';
import { loadProfileDocument } from '../repo/profile-yaml.js';
import { safeParseRepoProfile } from '../repo/repo-profile.js';
import type { GitRunner } from '../worktree/git-command.js';
import type { DeclaredScope } from './scope-policy.js';

/** Why the governing scope could not be established. Never a default scope. */
export const PINNED_SCOPE_REFUSALS = [
  /** The task carries no `basePinnedCommit`, so there is no tree to read. */
  'NO_BASE_PIN',
  /**
   * `git show` could not produce the profile at that commit: the pin is gone,
   * the profile was not committed, or Git could not run at all.
   */
  'PROFILE_UNAVAILABLE',
  /** The bytes at that path are not one well-formed, warning-free YAML document. */
  'PROFILE_MALFORMED',
  /** A document that is not a profile this build's contract accepts. */
  'PROFILE_INVALID',
] as const;

export type PinnedScopeRefusal = (typeof PINNED_SCOPE_REFUSALS)[number];

export type PinnedScopeResult =
  | { readonly outcome: 'RESOLVED'; readonly scope: DeclaredScope }
  | { readonly outcome: 'UNAVAILABLE'; readonly refusal: PinnedScopeRefusal };

function unavailable(refusal: PinnedScopeRefusal): PinnedScopeResult {
  return Object.freeze({ outcome: 'UNAVAILABLE' as const, refusal });
}

/**
 * Reads the scope policy out of the pinned commit's profile.
 *
 * Read-only and never throws. `worktreePath` supplies the repository Git is
 * asked in and must be the authorised worktree; the *content* comes from the
 * commit, not from that directory's working files.
 */
export async function readPinnedScope(
  git: GitRunner,
  worktreePath: string,
  basePinnedCommit: string | null,
): Promise<PinnedScopeResult> {
  if (basePinnedCommit === null) return unavailable('NO_BASE_PIN');

  // `<rev>:<path>` is the one form that reads a blob out of a commit without
  // touching the working tree. Both halves are shell-inert by construction: the
  // commit is a validated Git object name and the path is this repository's own
  // constant, so the seam's argument guard cannot refuse them for content the
  // target repository chose.
  //
  // `--no-replace-objects` is load-bearing, and the premise above needs the
  // precision it buys. A commit's *content* is immutable; its *resolution* is
  // not. `git replace -f <basePinnedCommit> <forged>` installs a mapping in
  // `refs/replace`, which lives in the common ref store — so a writer can
  // install one from inside its own linked worktree, with one ordinary Git
  // command, and every later `git show <basePinnedCommit>:…` then returns the
  // writer's bytes. Replace refs are honoured by default, and `createProbeEnv`
  // forwards `PATH`/`PATHEXT` only, so `GIT_NO_REPLACE_OBJECTS` is not set
  // either. The flag is what pins the object to the one this task was actually
  // started from.
  const shown = await git(worktreePath, [
    '--no-replace-objects',
    'show',
    '--end-of-options',
    `${basePinnedCommit}:${REPO_PROFILE_RELATIVE_PATH}`,
  ]);
  if (shown.outcome !== 'OK') return unavailable('PROFILE_UNAVAILABLE');

  const document = loadProfileDocument(shown.stdout);
  if (document.outcome !== 'DOCUMENT') return unavailable('PROFILE_MALFORMED');

  const profile = safeParseRepoProfile(document.document);
  if (!profile.success) return unavailable('PROFILE_INVALID');

  return Object.freeze({
    outcome: 'RESOLVED' as const,
    scope: Object.freeze({
      allowedPaths: Object.freeze([...profile.data.scope.allowedPaths]),
      protectedPaths: Object.freeze([...profile.data.scope.protectedPaths]),
    }),
  });
}
