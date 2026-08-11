/**
 * The task brief: the prose a repository wrote for a task, plus the context it
 * declared, prepared for handing to an agent.
 *
 * ── Why this is not part of discovery ──────────────────────────────────────
 *
 * `discoverTasks` answers *which tasks exist and how they relate*, and its
 * whole discipline is that a task file's prose contributes nothing to that
 * answer. This module answers a different question — *what should the writing
 * agent be told* — and prose is the only correct source for it. Keeping them
 * apart is what lets both rules hold at once: the plan still cannot be changed
 * by rewording a paragraph, and the paragraph can still reach an agent.
 *
 * `TaskDefinition` therefore gains no `body` field, and nothing here is
 * consulted by the selector, the graph or the eligibility rules.
 *
 * ── Context sources are named, not inlined ─────────────────────────────────
 *
 * The profile declares `context.canonicalSources`. This module proves each one
 * is present and safe to open, and then reports its **path** — it does not
 * copy the file's contents into the brief.
 *
 * That is a deliberate design decision, not a budget compromise. The writing
 * agent is Claude Code running *inside the task's worktree*: it can open those
 * files itself, at the moment it needs them, in whatever order its own work
 * requires. Inlining them would replace that with a fixed, truncated snapshot
 * chosen by this module, make every payload grow with the repository, and
 * bound the useful context by whatever ceiling happened to be set here. Naming
 * a file the agent can read is strictly more useful than pasting a prefix of
 * it.
 *
 * What the orchestrator owes the operator is the *guarantee that the names are
 * good*: a declared context source that does not exist, or that is a link out
 * of the repository, is reported here rather than discovered by an agent as a
 * missing file halfway through a task.
 *
 * ── Bounded and deterministic ──────────────────────────────────────────────
 *
 * The body is clamped to {@link MAX_TASK_BODY_CHARS} and the clamp is
 * *reported*, never silent — the same rule `buildRemediationPayload` follows
 * when it hands an agent a brief built from partial evidence. The same file
 * always produces the same brief, byte for byte.
 */

import { join } from 'node:path';

import type { ResolvedRepository } from '../repo/resolve-repository.js';
import { MAX_TASK_FILE_BYTES } from './discover-tasks.js';
import { readContainedFile, type ReadRefusal } from './internal/task-file-source.js';
import { readTaskFrontmatter } from './task-frontmatter.js';
import { isValidTaskId, taskFileName } from './task-id.js';

/**
 * Characters of task prose a brief may carry.
 *
 * Generous for a human-written task note and far below the agent payload
 * ceiling, so a brief always leaves room for the instructions wrapped around
 * it. A body longer than this is truncated *and said to be truncated*.
 */
export const MAX_TASK_BODY_CHARS = 8_192;

/** Every way a brief can fail to be assembled. A closed set. */
export const TASK_BRIEF_FAILURE_CODES = [
  /** The id does not satisfy the task-id grammar. Nothing was opened. */
  'TASK_ID_INVALID',
  /** The task source path is unusable, or escapes the canonical root. */
  'TASK_SOURCE_PATH_UNSAFE',
  /** The task file is a link, not a regular file, or escapes the root. */
  'TASK_FILE_UNSAFE',
  /** The task file exceeds the byte ceiling and was not read. */
  'TASK_FILE_TOO_LARGE',
  /** The task file does not exist, or could not be read. */
  'TASK_FILE_READ_FAILED',
  /** The file does not open with a frontmatter block, or it is malformed. */
  'TASK_FRONTMATTER_UNUSABLE',
  /**
   * The frontmatter is well-formed but the file carries no prose at all.
   *
   * A distinct failure rather than an empty brief: handing a writing agent a
   * task title and nothing else is not a task, and the repository is better
   * told that its file is incomplete than given an agent run that guesses.
   */
  'TASK_BODY_EMPTY',
] as const;

export type TaskBriefFailureCode = (typeof TASK_BRIEF_FAILURE_CODES)[number];

/** One static sentence per code. Nothing is interpolated. */
const FAILURE_DETAIL: Readonly<Record<TaskBriefFailureCode, string>> = Object.freeze({
  TASK_ID_INVALID: 'The task id is not a valid task id, so no file was opened.',
  TASK_SOURCE_PATH_UNSAFE:
    'The declared task source is not a usable directory inside the repository.',
  TASK_FILE_UNSAFE: 'The task file is a link, not a regular file, or lies outside the repository.',
  TASK_FILE_TOO_LARGE: 'The task file exceeds the size ceiling and was not read.',
  TASK_FILE_READ_FAILED: 'The task file does not exist or could not be read.',
  TASK_FRONTMATTER_UNUSABLE: 'The task file does not carry one well-formed frontmatter block.',
  TASK_BODY_EMPTY: 'The task file carries no prose for an agent to act on.',
});

/** How a declared context source stood up to being checked. */
export const CONTEXT_SOURCE_STATUSES = ['PRESENT', 'MISSING', 'UNSAFE', 'UNREADABLE'] as const;
export type ContextSourceStatus = (typeof CONTEXT_SOURCE_STATUSES)[number];

export interface ContextSourceReport {
  /** Repository-relative POSIX path, exactly as the profile declared it. */
  readonly path: string;
  readonly status: ContextSourceStatus;
}

export interface TaskBrief {
  readonly taskId: string;
  /** The task's prose, clamped. Opaque text: never parsed, never interpreted. */
  readonly body: string;
  /** `true` when {@link body} was clamped to {@link MAX_TASK_BODY_CHARS}. */
  readonly bodyTruncated: boolean;
  /** Every declared context source and whether it can actually be opened. */
  readonly contextSources: readonly ContextSourceReport[];
  /** `true` when every declared context source is `PRESENT`. */
  readonly contextComplete: boolean;
}

export interface TaskBriefSuccess {
  readonly ok: true;
  readonly code: 'BRIEF';
  readonly brief: TaskBrief;
}

export interface TaskBriefFailure {
  readonly ok: false;
  readonly code: TaskBriefFailureCode;
  /** A static sentence from this module. Carries no path and no file content. */
  readonly detail: string;
}

export type TaskBriefResult = TaskBriefSuccess | TaskBriefFailure;

function failure(code: TaskBriefFailureCode): TaskBriefFailure {
  return Object.freeze({ ok: false as const, code, detail: FAILURE_DETAIL[code] });
}

/** This module's sentence for each fact the safe-open chain reports. */
const TASK_FILE_REFUSAL_CODE: Readonly<Record<ReadRefusal, TaskBriefFailureCode>> = Object.freeze({
  UNSAFE: 'TASK_FILE_UNSAFE',
  TOO_LARGE: 'TASK_FILE_TOO_LARGE',
  READ_FAILED: 'TASK_FILE_READ_FAILED',
});

const CONTEXT_REFUSAL_STATUS: Readonly<Record<ReadRefusal, ContextSourceStatus>> = Object.freeze({
  UNSAFE: 'UNSAFE',
  TOO_LARGE: 'UNREADABLE',
  READ_FAILED: 'MISSING',
});

/**
 * Assembles the brief for one task.
 *
 * Never throws for an expected condition. Read-only: nothing is written, and
 * no path outside the canonical repository root is opened.
 *
 * A context source is checked by *reading* it rather than by `stat`-ing it,
 * deliberately: a file that exists but cannot be opened is exactly the case an
 * operator needs to know about before an agent meets it, and only a read
 * proves it. The bytes are then dropped — see the module header for why they
 * are not carried.
 */
export function readTaskBrief(
  repository: ResolvedRepository,
  taskId: string,
): TaskBriefResult {
  if (!isValidTaskId(taskId)) return failure('TASK_ID_INVALID');

  const root = repository.root;
  const sourceSegments = repository.taskSource.path.split('/');
  const filePath = join(root, ...sourceSegments, taskFileName(taskId));

  const read = readContainedFile(root, filePath, MAX_TASK_FILE_BYTES);
  if (!read.ok) return failure(TASK_FILE_REFUSAL_CODE[read.refusal]);

  const frontmatter = readTaskFrontmatter(read.text);
  if (frontmatter.outcome !== 'FRONTMATTER') return failure('TASK_FRONTMATTER_UNUSABLE');

  const body = frontmatter.body.trim();
  if (body === '') return failure('TASK_BODY_EMPTY');

  const bodyTruncated = body.length > MAX_TASK_BODY_CHARS;

  const contextSources = Object.freeze(
    repository.context.canonicalSources.map((declared) => {
      const sourcePath = join(root, ...declared.split('/'));
      const probe = readContainedFile(root, sourcePath, MAX_TASK_FILE_BYTES);
      return Object.freeze({
        path: declared,
        status: probe.ok ? ('PRESENT' as const) : CONTEXT_REFUSAL_STATUS[probe.refusal],
      });
    }),
  );

  return Object.freeze({
    ok: true as const,
    code: 'BRIEF' as const,
    brief: Object.freeze({
      taskId,
      body: bodyTruncated ? body.slice(0, MAX_TASK_BODY_CHARS) : body,
      bodyTruncated,
      contextSources,
      contextComplete: contextSources.every((source) => source.status === 'PRESENT'),
    }),
  });
}
