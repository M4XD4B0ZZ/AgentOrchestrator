/**
 * Task discovery: turning a repository's declared `MARKDOWN_DIRECTORY` task
 * source into a validated set of {@link TaskDefinition}s.
 *
 * V1-01 resolved the repository and *declared* where its tasks live. It
 * deliberately proved nothing about that location: not that it exists, not that
 * it is a directory, and certainly not what is inside it. This module is where
 * those questions are finally asked, which makes it the first place a
 * repository's untrusted content is opened at all.
 *
 * ── Where the paths come from ──────────────────────────────────────────────
 *
 * From `ResolvedRepository.root`, which is canonical, and from
 * `ResolvedRepository.taskSource.path`, which the profile schema already
 * restricted to a POSIX-shaped, repository-relative string with no absolute
 * prefix, no drive letter, no backslash and no `.`/`..` segment.
 *
 * **`process.cwd()` is never consulted**, exactly as in the resolver. Which
 * tasks a repository has must not depend on where an operator happened to
 * stand, and a test in `tests/task-discovery.test.ts` runs the same discovery
 * from three different working directories and requires one answer.
 *
 * ── Containment is re-derived, not assumed ─────────────────────────────────
 *
 * The schema is a contract about strings; containment is a fact about the
 * filesystem, and a fact can change between two checks. So the task-source
 * directory *and every file discovered inside it* are classified with `lstat`
 * (so a link is seen rather than followed), canonicalised with `realpath`, and
 * re-tested against the canonical root afterwards. A junction, a symlink or a
 * reparse point that leads out of the repository is `*_PATH_UNSAFE` /
 * `TASK_FILE_UNSAFE` — never followed, never read. This mirrors what the
 * resolver does for the profile, and it follows the stricter of the two
 * possible readings: links are refused outright rather than allowed when their
 * target happens to stay inside.
 *
 * ── Discovery is flat, exact and ordered ───────────────────────────────────
 *
 * Only direct children are considered; there is no recursion, so an `archive/`
 * subdirectory is not a source of tasks. Only entries ending in a lowercase
 * `.md` are candidates, and everything else is ignored rather than reinterpreted
 * — there is no `.MD`, no `.markdown`, no `.md.bak`. Candidates are sorted by
 * id before anything is read, so the order in which files are parsed, and
 * therefore *which* malformed file is reported first, is a property of the
 * repository rather than of the filesystem.
 *
 * ── An empty directory is not a finished plan ──────────────────────────────
 *
 * A task source with no task files fails with `TASK_SOURCE_EMPTY`. This is the
 * single most important negative result in the module: the alternative reading —
 * "no open tasks, therefore all tasks complete" — would turn a mistyped path or
 * a directory that never got committed into a confident report that the work is
 * done.
 *
 * ── What a failure may say ─────────────────────────────────────────────────
 *
 * A code from a closed set, a static sentence written here, the offending
 * task's **id** where there is one, and a count of contract violations. Never a
 * path, never a filename, never frontmatter text, never a YAML or `fs`
 * exception message. An id is admissible precisely because it has passed the
 * grammar in `task-id.ts`; everything else about a task file is repository
 * content and stays inside the value it was parsed into.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { compareTaskIds, taskIdFromFileName, TASK_FILE_EXTENSION } from './task-id.js';
import { readTaskFrontmatter } from './task-frontmatter.js';
import { safeParseTaskDefinition, type TaskDefinition } from './task-definition.js';

/**
 * The largest task file that is read at all.
 *
 * Generous for a human-written document — the body may be a full design note —
 * and small enough that a repository cannot make discovery allocate without
 * bound. The frontmatter has its own, much smaller budget.
 */
export const MAX_TASK_FILE_BYTES = 262_144;

/** Every way discovery can fail, as a closed set. */
export const TASK_DISCOVERY_FAILURE_CODES = [
  /** Nothing exists at the declared task-source path. */
  'TASK_SOURCE_NOT_FOUND',
  /** Something exists there, but it is not a directory. */
  'TASK_SOURCE_NOT_DIRECTORY',
  /** The task source is a link, or resolves outside the canonical root. */
  'TASK_SOURCE_PATH_UNSAFE',
  /** The task source exists but could not be listed. */
  'TASK_SOURCE_READ_FAILED',
  /** The task source holds no task files. Not "all tasks complete". */
  'TASK_SOURCE_EMPTY',
  /** A `.md` entry whose name is not `<legal task id>.md`. */
  'TASK_FILE_NAME_INVALID',
  /** A `.md` entry that is a link, or not a regular file, or escapes the root. */
  'TASK_FILE_UNSAFE',
  /** A task file exceeds the byte ceiling and is not read. */
  'TASK_FILE_TOO_LARGE',
  /** A task file exists but could not be read. */
  'TASK_FILE_READ_FAILED',
  /** A task file does not open with a frontmatter block. */
  'TASK_FRONTMATTER_MISSING',
  /** The frontmatter is not one well-formed, warning-free YAML 1.2 document. */
  'TASK_FRONTMATTER_MALFORMED',
  /** The frontmatter exceeds its own byte ceiling. */
  'TASK_FRONTMATTER_TOO_LARGE',
  /** The frontmatter carries a mapping key the safe-YAML boundary refuses. */
  'TASK_FRONTMATTER_FORBIDDEN_KEY',
  /** The frontmatter parses but violates the task-definition contract. */
  'TASK_DEFINITION_INVALID',
  /** The frontmatter's `id` is not the filename's id. */
  'TASK_ID_FILENAME_MISMATCH',
] as const;

export type TaskDiscoveryFailureCode = (typeof TASK_DISCOVERY_FAILURE_CODES)[number];

/**
 * One static sentence per failure code. Nothing is interpolated: not a path,
 * not a filename, not a Zod issue message, not an exception's text.
 */
const FAILURE_DETAIL: Readonly<Record<TaskDiscoveryFailureCode, string>> = Object.freeze({
  TASK_SOURCE_NOT_FOUND: 'No filesystem object exists at the declared task-source path.',
  TASK_SOURCE_NOT_DIRECTORY: 'The declared task source is not a directory.',
  TASK_SOURCE_PATH_UNSAFE:
    'The task source is a link, or resolves outside the canonical repository root.',
  TASK_SOURCE_READ_FAILED: 'The task-source directory could not be listed.',
  TASK_SOURCE_EMPTY:
    'The task source contains no task files. An empty task source is a configuration problem, ' +
    'not a completed plan.',
  TASK_FILE_NAME_INVALID:
    'A markdown entry in the task source is not named after a legal task identifier.',
  TASK_FILE_UNSAFE:
    'A task file is a link, is not a regular file, or resolves outside the canonical repository root.',
  TASK_FILE_TOO_LARGE: 'A task file exceeds the maximum accepted size.',
  TASK_FILE_READ_FAILED: 'A task file could not be read.',
  TASK_FRONTMATTER_MISSING: 'A task file does not begin with a YAML frontmatter block.',
  TASK_FRONTMATTER_MALFORMED:
    'A task file’s frontmatter is not one well-formed, warning-free YAML 1.2 document.',
  TASK_FRONTMATTER_TOO_LARGE: 'A task file’s frontmatter exceeds the maximum accepted size.',
  TASK_FRONTMATTER_FORBIDDEN_KEY:
    'A task file’s frontmatter carries a mapping key this contract refuses by name.',
  TASK_DEFINITION_INVALID: 'A task file’s frontmatter does not satisfy the task-definition contract.',
  TASK_ID_FILENAME_MISMATCH:
    'A task file’s declared identifier is not the identifier its filename states.',
});

export interface TaskDiscoverySuccess {
  readonly ok: true;
  readonly code: 'DISCOVERED';
  /** Every task definition, in canonical id order. At least one. */
  readonly tasks: readonly TaskDefinition[];
}

export interface TaskDiscoveryFailure {
  readonly ok: false;
  readonly code: TaskDiscoveryFailureCode;
  /** A sentence from {@link FAILURE_DETAIL}. Carries no host or input data. */
  readonly detail: string;
  /** The offending task's validated id, or `null` when there is not one. */
  readonly taskId: string | null;
  /** A count of contract violations, where one applies; `null` otherwise. */
  readonly issueCount: number | null;
}

export type TaskDiscoveryResult = TaskDiscoverySuccess | TaskDiscoveryFailure;

function failure(
  code: TaskDiscoveryFailureCode,
  taskId: string | null = null,
  issueCount: number | null = null,
): TaskDiscoveryFailure {
  return Object.freeze({
    ok: false as const,
    code,
    detail: FAILURE_DETAIL[code],
    taskId,
    issueCount,
  });
}

/** `true` when `candidate` is `root` itself or lies beneath it. */
function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** `true` when the two canonical paths denote the same location. */
function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

type Entry =
  | { readonly kind: 'DIRECTORY' }
  | { readonly kind: 'FILE'; readonly size: number }
  | { readonly kind: 'OTHER' }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'LINK' }
  | { readonly kind: 'UNREADABLE' };

/**
 * Classifies a path with `lstat`, so a link is *seen* rather than followed.
 *
 * Following first and asking afterwards is the classic escape: the answers
 * would describe the target while the path that gets used is still the link.
 */
function classify(path: string): Entry {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'ABSENT' };
    return { kind: 'UNREADABLE' };
  }
  if (stats.isSymbolicLink()) return { kind: 'LINK' };
  if (stats.isDirectory()) return { kind: 'DIRECTORY' };
  if (stats.isFile()) return { kind: 'FILE', size: stats.size };
  return { kind: 'OTHER' };
}

/**
 * Reads and validates one task file.
 *
 * `expectedId` comes from the filename and is already known to be legal; the
 * frontmatter must agree with it exactly. There is no implicit renaming in
 * either direction — a file that disagrees with itself is refused, because
 * silently preferring one of the two would make the dependency graph depend on
 * which half of the disagreement this module happened to trust.
 */
function readTaskFile(path: string, expectedId: string): TaskDefinition | TaskDiscoveryFailure {
  const entry = classify(path);
  if (entry.kind === 'LINK' || entry.kind === 'DIRECTORY' || entry.kind === 'OTHER') {
    return failure('TASK_FILE_UNSAFE', expectedId);
  }
  if (entry.kind === 'ABSENT' || entry.kind === 'UNREADABLE') {
    return failure('TASK_FILE_READ_FAILED', expectedId);
  }
  if (entry.size > MAX_TASK_FILE_BYTES) return failure('TASK_FILE_TOO_LARGE', expectedId);

  // No segment of this path is a link, so its canonical form must be itself.
  // A difference means something changed underneath us between the checks.
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return failure('TASK_FILE_READ_FAILED', expectedId);
  }
  if (!samePath(path, canonical)) return failure('TASK_FILE_UNSAFE', expectedId);

  let text: string;
  try {
    text = readFileSync(canonical, 'utf8');
  } catch {
    return failure('TASK_FILE_READ_FAILED', expectedId);
  }

  const frontmatter = readTaskFrontmatter(text);
  switch (frontmatter.outcome) {
    case 'MISSING':
      return failure('TASK_FRONTMATTER_MISSING', expectedId);
    case 'MALFORMED':
      return failure('TASK_FRONTMATTER_MALFORMED', expectedId);
    case 'TOO_LARGE':
      return failure('TASK_FRONTMATTER_TOO_LARGE', expectedId);
    case 'FORBIDDEN_KEY':
      return failure('TASK_FRONTMATTER_FORBIDDEN_KEY', expectedId, frontmatter.count);
    case 'FRONTMATTER':
      break;
  }

  const parsed = safeParseTaskDefinition(frontmatter.data);
  if (!parsed.success) {
    return failure('TASK_DEFINITION_INVALID', expectedId, parsed.error.issues.length);
  }
  if (parsed.data.id !== expectedId) {
    return failure('TASK_ID_FILENAME_MISMATCH', expectedId);
  }
  return parsed.data;
}

/** `true` for a discovery failure rather than a definition. */
function isFailure(value: TaskDefinition | TaskDiscoveryFailure): value is TaskDiscoveryFailure {
  return 'ok' in value && value.ok === false;
}

/**
 * Discovers every task declared by a resolved repository.
 *
 * Never throws for an expected condition: every failure is a
 * {@link TaskDiscoveryFailure} carrying a closed code.
 */
export function discoverTasks(repository: ResolvedRepository): TaskDiscoveryResult {
  const root = repository.root;

  // --- 1. Locate the task source, from the canonical root ------------------
  const sourcePath = resolvePath(root, ...repository.taskSource.path.split('/'));
  if (!isContained(root, sourcePath) || samePath(root, sourcePath)) {
    return failure('TASK_SOURCE_PATH_UNSAFE');
  }

  const sourceEntry = classify(sourcePath);
  if (sourceEntry.kind === 'LINK') return failure('TASK_SOURCE_PATH_UNSAFE');
  if (sourceEntry.kind === 'ABSENT') return failure('TASK_SOURCE_NOT_FOUND');
  if (sourceEntry.kind === 'UNREADABLE') return failure('TASK_SOURCE_READ_FAILED');
  if (sourceEntry.kind !== 'DIRECTORY') return failure('TASK_SOURCE_NOT_DIRECTORY');

  let canonicalSource: string;
  try {
    canonicalSource = realpathSync.native(sourcePath);
  } catch {
    return failure('TASK_SOURCE_READ_FAILED');
  }
  if (!samePath(sourcePath, canonicalSource) || !isContained(root, canonicalSource)) {
    return failure('TASK_SOURCE_PATH_UNSAFE');
  }

  // --- 2. List direct children only ----------------------------------------
  let entries: readonly string[];
  try {
    entries = readdirSync(canonicalSource);
  } catch {
    return failure('TASK_SOURCE_READ_FAILED');
  }

  // --- 3. Candidates, in an order this repository decides ------------------
  // A non-`.md` entry is ignored; a `.md` entry that is not named after a legal
  // id is a failure, because it is a file that *claims* to be a task and is
  // not. Candidates are sorted before any of them is opened, so which failure
  // gets reported first does not depend on the directory's own ordering.
  const candidates: Array<{ readonly id: string | null; readonly fileName: string }> = entries
    .filter((name) => name.endsWith(TASK_FILE_EXTENSION))
    .map((fileName) => ({ id: taskIdFromFileName(fileName), fileName }))
    .sort((a, b) => compareTaskIds(a.id ?? a.fileName, b.id ?? b.fileName));

  if (candidates.length === 0) return failure('TASK_SOURCE_EMPTY');

  const tasks: TaskDefinition[] = [];
  for (const candidate of candidates) {
    if (candidate.id === null) return failure('TASK_FILE_NAME_INVALID');
    const outcome = readTaskFile(join(canonicalSource, candidate.fileName), candidate.id);
    if (isFailure(outcome)) return outcome;
    tasks.push(outcome);
  }

  // Already sorted by id, because the candidates were and each file's id is its
  // filename's id. Stated as a sort anyway: the guarantee is the contract, and
  // it should not rest on a chain of reasoning about an earlier line.
  tasks.sort((a, b) => compareTaskIds(a.id, b.id));

  return Object.freeze({
    ok: true as const,
    code: 'DISCOVERED' as const,
    tasks: Object.freeze(tasks),
  });
}
