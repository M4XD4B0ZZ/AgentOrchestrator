/**
 * Where one task's runtime state lives. Exactly one place.
 *
 *     <canonical repository root>/.agent-orchestrator/runtime/<taskId>.json
 *
 * The same shape, and the same reasoning, as `repo/profile-location.ts`: one
 * location, no fallback name, no fallback extension, no upward search and no
 * environment override. The path is a pure function of the canonical repository
 * root and the task id, so the same task resolves to the same file on every run.
 *
 * ── Beside the profile, not under the user's home ──────────────────────────
 *
 * State belongs to the repository it describes. Keeping it under the directory
 * that already holds the orchestrator's per-repository files means a checkout
 * carries its own runtime record: copy the repository and the record comes with
 * it, delete it and the record goes, and two checkouts of the same project never
 * share one.
 *
 * Note that this module names only that *directory*, via
 * {@link REPO_PROFILE_DIR_NAME}. It deliberately does not mention the profile
 * file itself — `tests/repo-resolution.test.ts` holds the line that exactly two
 * modules may name that file, so a third can never become a second rule for
 * where a profile comes from.
 *
 * That is also why the path carries **no `repositoryId` segment**. The
 * repository root *is* the identity here. An id in the path would be a second,
 * weaker spelling of the same fact — one read out of a profile file, and one
 * that could disagree with the directory it sits in.
 *
 * `runtime/` is deliberately not `state/` next to the committed profile: the
 * profile is authored and reviewed, this is machine-written per-run data, and
 * the directory name says which is which. It is expected to be ignored by the
 * repository's VCS; nothing here creates or edits an ignore rule.
 *
 * ── Derived, then validated ────────────────────────────────────────────────
 *
 * `taskId` is repository-authored text. It has passed V1-02's grammar, but that
 * grammar was written for a filename in a task directory, and this is the first
 * place it becomes a path segment *here*. It goes through the same
 * single-plain-segment test `doctor/safe-write.ts` applies to artefact names,
 * and anything that fails is refused with a typed code — never slugified, never
 * truncated. A silent rewrite would break the one property this module exists to
 * provide.
 */

import { isAbsolute, join } from 'node:path';

import { REPO_PROFILE_DIR_NAME } from '../repo/profile-location.js';
import { isContained, isPlainFileName } from '../doctor/safe-write.js';

/**
 * Directory holding machine-written per-task runtime data, inside the
 * per-repository orchestrator directory that already holds the profile.
 */
export const TASK_RUNTIME_DIR_NAME = 'runtime';

/** Extension of a persisted state file. */
export const TASK_STATE_FILE_EXTENSION = '.json';

/** The runtime directory for a canonical repository root. */
export function taskRuntimeDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, REPO_PROFILE_DIR_NAME, TASK_RUNTIME_DIR_NAME);
}

/** Every way a state location can fail to exist. A closed set. */
export const STATE_LOCATION_FAILURE_CODES = [
  'REPOSITORY_ROOT_UNSUITABLE',
  'TASK_ID_UNSUITABLE',
] as const;

export type StateLocationFailureCode = (typeof STATE_LOCATION_FAILURE_CODES)[number];

export interface TaskStateLocation {
  readonly ok: true;
  /** `<repositoryRoot>/.agent-orchestrator/runtime`. */
  readonly directory: string;
  /** `<taskId>.json`, a single plain segment. */
  readonly fileName: string;
  /** The full path of the state file. Always inside {@link directory}. */
  readonly path: string;
}

export interface TaskStateLocationFailure {
  readonly ok: false;
  readonly code: StateLocationFailureCode;
}

export type TaskStateLocationResult = TaskStateLocation | TaskStateLocationFailure;

function locationFailure(code: StateLocationFailureCode): TaskStateLocationFailure {
  return Object.freeze({ ok: false as const, code });
}

/**
 * The one file that holds `taskId`'s state in the repository rooted at
 * `repositoryRoot`, or the reason there cannot be one.
 *
 * `repositoryRoot` must already be canonical — pass `ResolvedRepository.root`.
 * This function joins; it does not resolve, does not touch the filesystem, and
 * never falls back to `process.cwd()`.
 */
export function deriveTaskStateLocation(
  repositoryRoot: string,
  taskId: string,
): TaskStateLocationResult {
  // A relative root would be resolved against `process.cwd()` by every path
  // operation downstream, which is precisely the dependency this must not have.
  if (repositoryRoot.trim().length === 0 || !isAbsolute(repositoryRoot)) {
    return locationFailure('REPOSITORY_ROOT_UNSUITABLE');
  }

  const fileName = `${taskId}${TASK_STATE_FILE_EXTENSION}`;
  // Both the bare id and the derived file name must be plain segments: the id
  // rules out separators and `..`, the file name rules out a length that only
  // becomes illegal once the extension is appended.
  if (!isPlainFileName(taskId) || !isPlainFileName(fileName)) {
    return locationFailure('TASK_ID_UNSUITABLE');
  }

  const directory = taskRuntimeDirectory(repositoryRoot);
  const path = join(directory, fileName);

  // Belt and braces: even with a validated id, prove the result stayed inside
  // the repository it belongs to.
  if (!isContained(repositoryRoot, path)) return locationFailure('TASK_ID_UNSUITABLE');

  return Object.freeze({ ok: true as const, directory, fileName, path });
}
