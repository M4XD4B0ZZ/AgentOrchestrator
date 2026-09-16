/**
 * The repository identity a checkout *declares*, read without resolving it.
 *
 * ── Why this is separate from `resolveRepository` ──────────────────────────
 *
 * `resolveRepository` answers "is this a repository this orchestrator may work
 * in?" — which needs Git, capability probes and a remote expectation, and is
 * therefore asynchronous and expensive. Some callers need a much narrower
 * answer, synchronously, and need it to be *authoritative* rather than passed
 * in: **which repository does this checkout say it is?**
 *
 * The block store is the reason this exists. A ledger carries `repositoryId`,
 * and a field a store only ever writes is a field nobody checks: it would be
 * carried faithfully out of another project by a copied ledger and never once
 * contradicted. So the store re-reads the identity from the profile on every
 * create and every load, and refuses a ledger that claims a different one.
 *
 * ── Not a second opinion about the profile ─────────────────────────────────
 *
 * This asks the *same* contract the resolver asks, through the same steps — the
 * shared containment-and-safety chain, `loadProfileDocument`,
 * `safeParseRepoProfile` — and stops there, without resolving anything. It
 * deliberately re-implements no validation, because a second opinion about what
 * a valid profile is would drift from the first one. For the same reason the
 * identity is a *projection* of the profile reader rather than a second chain
 * of its own.
 *
 * ── What it does not claim ─────────────────────────────────────────────────
 *
 * `repository.id` is configurable *logical* product identity, not local Git
 * identity. It is the right thing to hold a ledger to, and the wrong thing to
 * key an execution lease on: two clones of one remote declare the same id and
 * are two independent local execution domains, while two worktrees of one
 * clone are one. That distinction belongs to the lease and to the Git
 * administrative identity it is keyed on; nothing here makes a statement about
 * it.
 */

import { readContainedFile } from './internal/contained-file.js';
import { loadProfileDocument } from './profile-yaml.js';
import { repoProfilePath } from './profile-location.js';
import { safeParseRepoProfile, type RepoProfile } from './repo-profile.js';

/**
 * Largest profile this reader will parse.
 *
 * A parsing ceiling, which is why it is passed to `readContainedFile` at all —
 * see the note there about what borrowing an unrelated ceiling once cost.
 */
export const MAX_DECLARED_IDENTITY_BYTES = 65_536;

export interface DeclaredIdentity {
  readonly ok: true;
  /** `repository.id`, exactly as the profile states it. */
  readonly id: string;
}

export interface DeclaredIdentityFailure {
  readonly ok: false;
  /**
   * One code, deliberately.
   *
   * A caller here is asking a yes/no question about identity, and a checkout
   * whose profile is missing, unreadable, unsafe or invalid answers it the same
   * way: *this checkout does not declare a usable identity*. An operator who
   * needs to know which of those it was runs the resolver, which diagnoses all
   * of them apart and is the module that owns those distinctions.
   */
  readonly code: 'REPOSITORY_PROFILE_UNUSABLE';
}

export type DeclaredIdentityResult = DeclaredIdentity | DeclaredIdentityFailure;

const FAILED: DeclaredIdentityFailure = Object.freeze({
  ok: false as const,
  code: 'REPOSITORY_PROFILE_UNUSABLE' as const,
});

/** A profile this checkout declares, validated. */
export interface DeclaredProfile {
  readonly ok: true;
  /** The whole parsed profile, exactly as the contract validates it. */
  readonly profile: RepoProfile;
}

export type DeclaredProfileResult = DeclaredProfile | DeclaredIdentityFailure;

/**
 * Reads the whole profile at the one canonical location, without resolving it.
 *
 * Synchronous, read-only, and never throws: every failure is the single code
 * above. No Git, no network, no capability probe — this is a question about a
 * file, and answering it must not depend on the repository being *workable*.
 *
 * ── Why the whole profile, and not only the identity ───────────────────────
 *
 * This chain always parsed the whole document; the narrower reader below simply
 * projected one field out of it and dropped the rest. A second reader for the
 * other fields would have been the second opinion this module's header refuses,
 * so the reader was widened and the identity became a projection of it. There
 * is still exactly one git-free profile reader and exactly one parse.
 *
 * The caller that needed this is a read-only observer. `taskSource.path` is
 * enough to discover a repository's declared tasks — see `TaskSourceLocation` in
 * `plan/discover-tasks.ts` — and obtaining it through `resolveRepository` would
 * have cost five `git` children for a value that is sitting in a committed file.
 *
 * Note the ceiling: {@link MAX_DECLARED_IDENTITY_BYTES} is narrower than the
 * resolver's own profile ceiling, so a profile between the two sizes resolves
 * and is refused here. That is the existing contract of this reader and is not
 * widened by this function.
 */
export function readDeclaredProfile(repositoryRoot: string): DeclaredProfileResult {
  const read = readContainedFile(
    repositoryRoot,
    repoProfilePath(repositoryRoot),
    MAX_DECLARED_IDENTITY_BYTES,
  );
  if (!read.ok) return FAILED;

  const document = loadProfileDocument(read.text);
  if (document.outcome !== 'DOCUMENT') return FAILED;

  const parsed = safeParseRepoProfile(document.document);
  if (!parsed.success) return FAILED;

  return Object.freeze({ ok: true as const, profile: parsed.data });
}

/**
 * Reads `repository.id` from the profile at the one canonical location.
 *
 * A projection of {@link readDeclaredProfile}, rather than a second chain, so
 * the two can never grow two opinions about what a valid profile is. Its
 * contract is unchanged: synchronous, read-only, never throws, one failure code.
 */
export function readDeclaredRepositoryId(repositoryRoot: string): DeclaredIdentityResult {
  const read = readDeclaredProfile(repositoryRoot);
  if (!read.ok) return read;
  return Object.freeze({ ok: true as const, id: read.profile.repository.id });
}
