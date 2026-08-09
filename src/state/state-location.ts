/**
 * Where one task's runtime state lives, derived and then validated.
 *
 * The location is a pure function of two identities the orchestrator already
 * holds — `ResolvedRepository.id` and the selected `TaskDefinition`'s task id —
 * and of the trusted user profile. Nothing here reads `process.cwd()`, an
 * environment variable, or the filesystem.
 *
 * ── Why the identities are validated, not trusted ──────────────────────────
 *
 * Both identities are *repository-authored text*. `repositoryId` comes out of a
 * profile file in the target repository and `taskId` out of a task file in it.
 * Each has already passed its own grammar, but neither grammar was written to
 * make a value safe as a **path segment**, and this module is the first place
 * either is used as one. A `repositoryId` of `../../..` would otherwise place a
 * task's state outside the orchestrator home entirely.
 *
 * So each is put through {@link isPlainFileName} — the same single-plain-segment
 * test `doctor/safe-write.ts` applies to artefact names — and anything that
 * fails is refused with a typed code. Never slugified, never truncated, never
 * hashed into something that "works": a silent rewrite would break the one
 * property this module exists to provide, which is that the same task resolves
 * to the same file every time, on every run.
 */

import { join } from 'node:path';

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { TASK_STATE_DIR_NAME, taskStateRoot } from '../config/paths.js';
import { isPlainFileName } from '../doctor/safe-write.js';

export { TASK_STATE_DIR_NAME, taskStateRoot };

/** Extension of a persisted state file. */
export const TASK_STATE_FILE_EXTENSION = '.json';

/** Every way a state location can fail to exist. A closed set. */
export const STATE_LOCATION_FAILURE_CODES = [
  'REPOSITORY_ID_UNSUITABLE',
  'TASK_ID_UNSUITABLE',
] as const;

export type StateLocationFailureCode = (typeof STATE_LOCATION_FAILURE_CODES)[number];

export interface TaskStateLocation {
  readonly ok: true;
  /** `<orchestrator home>/state/<repositoryId>`. */
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
 * The one file that holds `taskId`'s state in `repositoryId`, or the reason
 * there cannot be one.
 *
 * Two repositories that happen to declare the same task id land in two
 * different directories without either of them being known to the other.
 */
export function deriveTaskStateLocation(
  repositoryId: string,
  taskId: string,
  provider: PathProvider = OS_PATH_PROVIDER,
): TaskStateLocationResult {
  if (!isPlainFileName(repositoryId)) return locationFailure('REPOSITORY_ID_UNSUITABLE');

  const fileName = `${taskId}${TASK_STATE_FILE_EXTENSION}`;
  // Both the bare id and the derived file name must be plain segments: the id
  // rules out separators and `..`, the file name rules out a length that only
  // becomes illegal once the extension is appended.
  if (!isPlainFileName(taskId) || !isPlainFileName(fileName)) {
    return locationFailure('TASK_ID_UNSUITABLE');
  }

  const directory = join(taskStateRoot(provider), repositoryId);
  return Object.freeze({
    ok: true as const,
    directory,
    fileName,
    path: join(directory, fileName),
  });
}
