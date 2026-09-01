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
 * ── A dependency is repository-local, and that is a refusal ────────────────
 *
 * Every task this module returns was read out of **one** repository's task
 * source, and `normalizeTaskGraph` resolves each `dependsOn` entry inside that
 * one set. So a dependency names a task of the same repository or it names
 * nothing: there is no cross-repository lookup here, and M2 slice 3 added none
 * — `planAcrossRepositories` calls `planNextTask` once per repository and
 * merges the *answers*, never the graphs.
 *
 * That locality was already enforced, and it was enforced anonymously. A
 * qualified reference like `dependsOn: [beta:auth-1]` fails `TaskIdSchema`
 * because the id grammar admits no `:`, `/` or `\`, and an unqualified
 * reference to another repository's task fails `TASK_DEPENDENCY_UNKNOWN`
 * because that id is not in this set. Both are fail-closed and neither could
 * ever mis-resolve. What neither said is *why*: a refused cross-project
 * dependency and a mistyped field arrived as one code, so an operator could not
 * tell "this product does not offer that" from "you made a typo".
 * `TASK_DEPENDENCY_CROSS_PROJECT` is that sentence, and it is a narrowing of
 * `TASK_DEFINITION_INVALID` rather than a new admission — see
 * {@link declaresQualifiedDependency}.
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

import { readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import type { ResolvedRepository } from '../repo/resolve-repository.js';
import {
  proveContainedDirectory,
  readContainedFile,
  type DirectoryRefusal,
  type ReadRefusal,
} from '../repo/internal/contained-file.js';
import {
  compareTaskIds,
  isValidTaskId,
  taskIdFromFileName,
  TASK_FILE_EXTENSION,
} from './task-id.js';
import { readTaskFrontmatter } from './task-frontmatter.js';
import { safeParseTaskDefinition, type TaskDefinition } from './task-definition.js';

/** Discovery's own sentence for each fact the directory proof reports. */
const SOURCE_REFUSAL_CODE: Readonly<Record<DirectoryRefusal, TaskDiscoveryFailureCode>> =
  Object.freeze({
    UNSAFE: 'TASK_SOURCE_PATH_UNSAFE',
    MISSING: 'TASK_SOURCE_NOT_FOUND',
    NOT_A_DIRECTORY: 'TASK_SOURCE_NOT_DIRECTORY',
    UNREADABLE: 'TASK_SOURCE_READ_FAILED',
  });

/** Discovery's own sentence for each fact the safe-open chain reports. */
const TASK_FILE_REFUSAL_CODE: Readonly<Record<ReadRefusal, TaskDiscoveryFailureCode>> =
  Object.freeze({
    UNSAFE: 'TASK_FILE_UNSAFE',
    TOO_LARGE: 'TASK_FILE_TOO_LARGE',
    READ_FAILED: 'TASK_FILE_READ_FAILED',
  });

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
  /**
   * A dependency reference names another project, not a task of this
   * repository. A narrowing of `TASK_DEFINITION_INVALID` and never a weakening
   * of it — see {@link declaresQualifiedDependency}.
   */
  'TASK_DEPENDENCY_CROSS_PROJECT',
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
  TASK_DEPENDENCY_CROSS_PROJECT:
    'A task file declares a dependency qualified by a project or a path. Dependencies are ' +
    'repository-local: a task may depend only on a task the same repository declares.',
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

/**
 * The characters a dependency reference uses to name something that is not a
 * task of this repository: a namespace (`beta:auth-1`) or a path
 * (`beta/auth-1`, `..\beta\auth-1`).
 *
 * None of the three is in the task-id grammar, so a reference carrying one is
 * *already* refused by `TaskIdSchema`. The set exists only to decide **which
 * sentence** that refusal prints.
 */
const DEPENDENCY_QUALIFIER_PATTERN = /[:/\\]/;

/**
 * `true` when a refused frontmatter document refused *because* it named a
 * dependency in another project.
 *
 * ── This function may only narrow a refusal, never grant one ───────────────
 *
 * It is called on one branch only — after `safeParseTaskDefinition` has already
 * said no — and both of its outcomes are a refusal. That placement is the whole
 * safety argument and it is deliberate: a check that ran *before* the contract
 * could be made to answer "not cross-project" about a document the contract
 * would also have refused, and the temptation would then be to continue. Here
 * there is nothing to continue to.
 *
 * ── Why a legal id is excluded explicitly ──────────────────────────────────
 *
 * `isValidTaskId` is redundant today: no id admitted by the grammar contains
 * `:`, `/` or `\`. It is written out anyway, so that a later widening of that
 * grammar cannot make a *legal* local dependency start reporting itself as a
 * cross-project reference. The narrowing has to stay attached to references the
 * contract rejects.
 *
 * The input is the raw parsed YAML, so every field is `unknown` and is treated
 * as such. A `dependsOn` that is not an array, or whose entries are not
 * strings, is not this refusal's business — the contract has its own answer for
 * those, and it has already given it.
 */
function declaresQualifiedDependency(document: unknown): boolean {
  if (typeof document !== 'object' || document === null) return false;
  const dependsOn = (document as { readonly dependsOn?: unknown }).dependsOn;
  if (!Array.isArray(dependsOn)) return false;
  return dependsOn.some(
    (entry: unknown) =>
      typeof entry === 'string' &&
      !isValidTaskId(entry) &&
      DEPENDENCY_QUALIFIER_PATTERN.test(entry),
  );
}

/**
 * Reads and validates one task file.
 *
 * `expectedId` comes from the filename and is already known to be legal; the
 * frontmatter must agree with it exactly. There is no implicit renaming in
 * either direction — a file that disagrees with itself is refused, because
 * silently preferring one of the two would make the dependency graph depend on
 * which half of the disagreement this module happened to trust.
 *
 * The safe-open chain itself lives in `../repo/internal/contained-file.ts`,
 * which more than one caller needs; this function only translates its three
 * refusals into discovery's own vocabulary.
 */
function readTaskFile(
  root: string,
  path: string,
  expectedId: string,
): TaskDefinition | TaskDiscoveryFailure {
  const read = readContainedFile(root, path, MAX_TASK_FILE_BYTES);
  if (!read.ok) {
    return failure(TASK_FILE_REFUSAL_CODE[read.refusal], expectedId);
  }

  const frontmatter = readTaskFrontmatter(read.text);
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
    // Both arms refuse. The only thing decided here is which sentence the
    // operator reads, and "you named a task in another project" is a different
    // mistake from "you mistyped a field" — one is a policy this product does
    // not offer, the other is a typo. Reporting them alike made the policy
    // unreadable: `dependsOn: [beta:auth-1]` and `priority: URGENT` produced
    // the same code, so an operator could not tell a refused *feature* from a
    // refused *value*.
    if (declaresQualifiedDependency(frontmatter.data)) {
      return failure('TASK_DEPENDENCY_CROSS_PROJECT', expectedId, parsed.error.issues.length);
    }
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

  // The directory proof — containment, not-the-root, link refusal,
  // canonicalisation and re-containment — lives with the file proof, in the
  // module that owns the safety chain. Only the naming is discovery's own.
  const provedSource = proveContainedDirectory(root, sourcePath);
  if (!provedSource.ok) return failure(SOURCE_REFUSAL_CODE[provedSource.refusal]);
  const canonicalSource = provedSource.canonical;

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
    const outcome = readTaskFile(root, join(canonicalSource, candidate.fileName), candidate.id);
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
