/**
 * The task identifier, and the filename it implies.
 *
 * A task id is the only piece of repository-authored task text that travels
 * anywhere: it names a file, it is the key of the dependency graph, it appears
 * in a selection outcome, and it is the one value a planning *failure* is
 * allowed to carry. Everything else about a task file — its title, its body —
 * stays inside the value it was parsed into. So the grammar here is not a
 * convenience check; it is the reason an id is safe to hand onward at all.
 *
 * ── The grammar ────────────────────────────────────────────────────────────
 *
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, minus four carve-outs. What survives
 * carries no path separator, no whitespace, no control character and no shell
 * metacharacter, so it cannot denote a location outside its directory, cannot
 * become a second argument, and cannot re-parse inside a command line.
 *
 * The carve-outs are Windows-shaped, because this orchestrator runs there:
 *
 *  - **`.` and `..`** are refused explicitly. The leading-character class
 *    already excludes them; the refinement is kept so that loosening that class
 *    later cannot quietly re-admit the two names that mean "a directory".
 *  - **A trailing `.`** is refused. Windows strips trailing dots when opening a
 *    file, so `V1-02..md` and `V1-02.md` name the same file while carrying two
 *    different ids — an alias the filename↔id equality check could not see.
 *  - **Reserved device names** (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`COM9`,
 *    `LPT1`…`LPT9`) are refused in any case. `NUL.md` is not a file on Windows:
 *    it is the null device. Reading it succeeds and yields nothing, so a task
 *    file that does not exist would parse as an empty document rather than
 *    failing closed.
 *  - The length ceiling keeps `<id>.md` comfortably inside every path budget.
 *
 * The set is intentionally narrower than the profile's `SHELL_INERT_PATTERN`:
 * that one admits `/`, `\`, `:`, `@`, `=` and `+` because it also describes
 * paths and command tokens. An id is a *name*, and a name needs none of them.
 */

import { z } from 'zod';

/** Longest accepted id. `<id>.md` therefore stays under 132 characters. */
export const MAX_TASK_ID_LENGTH = 128;

/** The mandatory extension of a task file. Lowercase, exactly. */
export const TASK_FILE_EXTENSION = '.md';

/** Character-level grammar. Cross-cutting refusals are applied on top. */
const TASK_ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_TASK_ID_LENGTH - 1}}$`);

/**
 * Windows device names, which are reserved at *every* directory level and with
 * any extension appended.
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`),
]);

/** `true` when `value` is a legal task id under the full contract. */
export function isValidTaskId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!TASK_ID_PATTERN.test(value)) return false;
  if (value === '.' || value === '..') return false;
  if (value.endsWith('.')) return false;
  if (RESERVED_DEVICE_NAMES.has(value.toUpperCase())) return false;
  return true;
}

/**
 * The task id as a Zod contract.
 *
 * Used for a task's own `id` and for every entry of its `dependsOn`, so a
 * dependency can never name something the filesystem layer would refuse.
 */
export const TaskIdSchema = z
  .string()
  .refine(
    isValidTaskId,
    'A task id must start with a letter or digit, may then contain letters, digits, ".", "_" and ' +
      '"-", must not end with ".", must not be a Windows device name, and must not exceed ' +
      `${MAX_TASK_ID_LENGTH} characters.`,
  );

/** The one filename a task with this id may have. */
export function taskFileName(id: string): string {
  return `${id}${TASK_FILE_EXTENSION}`;
}

/**
 * The id a directory entry claims, or `null` when the entry cannot be a task
 * file at all.
 *
 * The extension test is exact and case-sensitive: `V1-02.MD` is not a task
 * file, and is left to the caller to ignore rather than reinterpret. There is
 * no implicit renaming anywhere in this module — a filename either states a
 * legal id or states nothing.
 */
export function taskIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(TASK_FILE_EXTENSION)) return null;
  const stem = fileName.slice(0, fileName.length - TASK_FILE_EXTENSION.length);
  return isValidTaskId(stem) ? stem : null;
}

/**
 * Total order on task ids, by UTF-16 code unit.
 *
 * Deliberately *not* `localeCompare`: a collation that depends on the machine's
 * locale would make the canonical order of a graph — and therefore which task
 * gets selected on a tie — a property of the operator's Windows region setting.
 */
export function compareTaskIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
