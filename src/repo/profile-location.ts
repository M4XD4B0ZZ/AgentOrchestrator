/**
 * Where a repository profile lives. Exactly one place.
 *
 *     <canonical repository root>/.agent-orchestrator/repo-profile.yaml
 *
 * ── Why one location and no fallbacks ──────────────────────────────────────
 *
 * A discovery rule with alternatives — `.yml` as well as `.yaml`, a root-level
 * file as well as a directory, a parent-directory walk, an environment override
 * — is a rule where the answer to "which contract is in force?" depends on
 * which candidate happened to be checked first. That is a poor property for a
 * configuration file and a bad one for a *policy* file: the profile declares
 * which paths may be written and which capabilities are mandatory, so a second
 * candidate is a second way to place a policy the operator did not review.
 *
 * There is therefore no fallback name, no fallback extension, no upward search
 * and no environment variable. The path is a pure function of the canonical
 * repository root. A repository with no file at that exact path has no profile,
 * and resolution fails closed with `PROFILE_MISSING` rather than continuing
 * under a default the repository never agreed to.
 *
 * YAML is the format because the profile is written and reviewed by humans and
 * because `yaml` is already a dependency of this package. The parser is used in
 * its safe, plain-document mode; the conversion from text to data — the mapping
 * keys refused by name, and the warnings that never reach the process — belongs
 * to `profile-yaml.ts`.
 */

import { join } from 'node:path';

/** Directory holding the orchestrator's per-repository files. */
export const REPO_PROFILE_DIR_NAME = '.agent-orchestrator';

/** The one profile file name. There is no alternative spelling. */
export const REPO_PROFILE_FILE_NAME = 'repo-profile.yaml';

/** The canonical location, in repository-relative POSIX form. */
export const REPO_PROFILE_RELATIVE_PATH = `${REPO_PROFILE_DIR_NAME}/${REPO_PROFILE_FILE_NAME}`;

/**
 * The profile path for a repository root.
 *
 * `repositoryRoot` must already be canonical: this function joins, it does not
 * resolve, and it consults neither the filesystem nor `process.cwd()`.
 */
export function repoProfilePath(repositoryRoot: string): string {
  return join(repositoryRoot, REPO_PROFILE_DIR_NAME, REPO_PROFILE_FILE_NAME);
}

/** The directory the profile file must sit directly inside. */
export function repoProfileDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, REPO_PROFILE_DIR_NAME);
}
