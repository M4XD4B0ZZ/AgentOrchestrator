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
 * `taskId` is repository-authored text. It has passed V1-02's grammar, and this
 * is the first place it becomes a path segment *here*, so it is re-checked
 * against that same canonical grammar and anything that fails is refused with a
 * typed code — never slugified, never truncated. A silent rewrite would break
 * the one property this module exists to provide.
 *
 * The name is judged by {@link isStateFileName}, which is deliberately *not*
 * `doctor/safe-write.ts`'s `isPlainFileName`. Sharing that helper would have
 * imported its unrelated 64-character artefact budget into the task-id
 * contract, making canonically valid ids impossible to persist. The safety
 * properties are the same — one plain segment, no separators, no traversal, no
 * absolute path, no Windows device name — because they come from the task-id
 * grammar itself; only the length budget is the storage layer's own.
 */

import { isAbsolute, join } from 'node:path';

import { REPO_PROFILE_DIR_NAME } from '../repo/profile-location.js';
import { isContained } from '../doctor/safe-write.js';
import { isValidTaskId, MAX_TASK_ID_LENGTH } from '../plan/task-id.js';

/**
 * Directory holding machine-written per-task runtime data, inside the
 * per-repository orchestrator directory that already holds the profile.
 */
export const TASK_RUNTIME_DIR_NAME = 'runtime';

/** Extension of a persisted state file. */
export const TASK_STATE_FILE_EXTENSION = '.json';

/**
 * Longest name a state file may have: the longest canonical task id plus the
 * extension. Derived from {@link MAX_TASK_ID_LENGTH} rather than chosen, so the
 * two cannot drift.
 */
export const MAX_STATE_FILE_NAME_LENGTH = MAX_TASK_ID_LENGTH + TASK_STATE_FILE_EXTENSION.length;

/**
 * `true` when `name` is the file name of *some* canonically valid task.
 *
 * ── Why not `isPlainFileName()` ────────────────────────────────────────────
 *
 * That helper is the artefact writer's, and it carries the artefact writer's
 * 64-character budget. A task id may be up to {@link MAX_TASK_ID_LENGTH}
 * characters, so reusing it made a whole band of ids that V1-02 accepts, that
 * the planner can select and that V1-03 can build a workspace for, impossible
 * to *write down* — a task the orchestrator can start and then never recover.
 * Borrowing an unrelated length budget from another module is how the storage
 * layer would quietly redefine the task-id contract.
 *
 * What is *not* relaxed is any of the safety this shares with that helper. The
 * name must be exactly `<task id>.json`, and the id must satisfy the canonical
 * grammar, which already rules out separators, `.`/`..`, traversal, absolute
 * paths, whitespace, control characters, trailing dots and Windows device
 * names. The result is a single plain path segment, by construction.
 */
export function isStateFileName(name: string): boolean {
  if (name.length > MAX_STATE_FILE_NAME_LENGTH) return false;
  if (!name.endsWith(TASK_STATE_FILE_EXTENSION)) return false;
  return isValidTaskId(name.slice(0, name.length - TASK_STATE_FILE_EXTENSION.length));
}

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

  // The canonical grammar first — this is repository-authored text, and the
  // grammar is what makes it safe to use as a path segment at all.
  if (!isValidTaskId(taskId)) return locationFailure('TASK_ID_UNSUITABLE');

  const fileName = `${taskId}${TASK_STATE_FILE_EXTENSION}`;
  // Belt and braces: the derived name is judged in its own right, so a future
  // extension change cannot silently produce a name nothing would accept back.
  if (!isStateFileName(fileName)) return locationFailure('TASK_ID_UNSUITABLE');

  const directory = taskRuntimeDirectory(repositoryRoot);
  const path = join(directory, fileName);

  // Belt and braces: even with a validated id, prove the result stayed inside
  // the repository it belongs to.
  if (!isContained(repositoryRoot, path)) return locationFailure('TASK_ID_UNSUITABLE');

  return Object.freeze({ ok: true as const, directory, fileName, path });
}
