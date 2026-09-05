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
 * ── Two briefs, and why they are different types ───────────────────────────
 *
 * {@link previewTaskBrief} is for a **plan**: it inspects the source checkout,
 * which is whatever `main` currently looks like. {@link readExecutionBrief} is
 * for a **run**: it inspects the authorised task worktree, pinned at
 * `basePinnedCommit`, which is the tree the writing agent actually opens.
 *
 * They are separate functions returning separate types because V2-02 had only
 * one, proved against the source checkout, and the payload then told the agent
 * those paths were "in this worktree". Once execution gated on that verdict, a
 * file present on `main` and absent from the pinned worktree produced a writer
 * briefed on a promise nobody had checked — and a file deleted on `main` while
 * a task was in flight parked a task whose own worktree still had it.
 *
 * A preview therefore carries **no `contextComplete`** and cannot be handed to
 * the loop: the type system refuses it, so the confusion is not expressible
 * rather than merely discouraged. A preview is a courtesy to an operator, never
 * an authority over a writer.
 *
 * ── Context sources are named, not inlined ─────────────────────────────────
 *
 * The profile declares `context.canonicalSources`. This module proves each one
 * is present and safe to open, and then reports its **path** — it does not copy
 * the file's contents.
 *
 * That is a design decision, not a budget compromise. The writing agent is
 * Claude Code running *inside the task's worktree*: it can open those files
 * itself, at the moment it needs them, in whatever order its own work requires.
 *
 * Because nothing is parsed, the inspection has **no size ceiling**. It used to
 * borrow the 256 KiB *task-file parsing* ceiling and then discard the bytes,
 * which protected nothing and reported a perfectly readable architecture note
 * as unreadable — blocking every task in the repository once execution gated on
 * the verdict. `PRESENT` now means exactly: the path exists, lies safely inside
 * the tree, is a regular file, is not a link, and opens read-only. The byte
 * budget for actually *loading* context is a separate contract and belongs
 * wherever that loading is implemented.
 *
 * ── Bounded and deterministic ──────────────────────────────────────────────
 *
 * The body is clamped to {@link MAX_TASK_BODY_BYTES} **UTF-8 bytes**, never
 * mid-code-point, and the clamp is *reported*, never silent. Bytes rather than
 * JavaScript string length because the promise is about what travels: slicing
 * UTF-16 code units could keep a high surrogate and drop its low one, yielding
 * a string with no valid UTF-8 representation that reaches the agent as U+FFFD
 * while `bodyTruncated` reported only that the tail was cut.
 */

import { join } from 'node:path';

import type { ResolvedRepository } from '../repo/resolve-repository.js';
import {
  capabilitySatisfied,
  probeCodegraphCapability,
  type CapabilityAssessment,
} from '../repo/capabilities.js';
import {
  inspectContainedFile,
  proveContainedDirectory,
  readContainedFile,
  type InspectRefusal,
  type ReadRefusal,
} from '../repo/internal/contained-file.js';
import { MAX_TASK_FILE_BYTES } from './discover-tasks.js';
import { readTaskFrontmatter } from './task-frontmatter.js';
import { isValidTaskId, taskFileName } from './task-id.js';

/**
 * UTF-8 bytes of task prose a brief may carry.
 *
 * Generous for a human-written task note and far below the agent payload
 * ceiling, so a brief always leaves room for the instructions wrapped around
 * it. A body longer than this is truncated *and said to be truncated*.
 */
export const MAX_TASK_BODY_BYTES = 8_192;

/** Every way a brief can fail to be assembled. A closed set. */
export const TASK_BRIEF_FAILURE_CODES = [
  /** The id does not satisfy the task-id grammar. Nothing was opened. */
  'TASK_ID_INVALID',
  /**
   * The declared task source is a link, not a directory, or escapes the root.
   *
   * Spelled exactly as `discoverTasks` spells it, because it is the same fact
   * about the same repository. Two vocabularies disagreeing about one
   * condition is what this member exists to prevent — and it was unreachable
   * until the source was actually classified here.
   */
  'TASK_SOURCE_PATH_UNSAFE',
  /** The task file is a link, not a regular file, or escapes the root. */
  'TASK_FILE_UNSAFE',
  /** The task file exceeds the parsing ceiling and was not read. */
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

/** How a declared context source stood up to being inspected. */
export const CONTEXT_SOURCE_STATUSES = ['PRESENT', 'MISSING', 'UNSAFE', 'UNREADABLE'] as const;
export type ContextSourceStatus = (typeof CONTEXT_SOURCE_STATUSES)[number];

export interface ContextSourceReport {
  /** Repository-relative POSIX path, exactly as the profile declared it. */
  readonly path: string;
  readonly status: ContextSourceStatus;
}

/** What both briefs carry: the task's own words. */
interface TaskProse {
  readonly taskId: string;
  /** The task's prose, clamped. Opaque text: never parsed, never interpreted. */
  readonly body: string;
  /** `true` when {@link body} was clamped to {@link MAX_TASK_BODY_BYTES}. */
  readonly bodyTruncated: boolean;
}

/**
 * A plan's non-authoritative view.
 *
 * `contextPreview` describes the **source checkout**, which is not the tree any
 * writer will open. It exists so an operator can see whether a repository looks
 * onboarded, and for nothing else. It deliberately has no `contextComplete`:
 * there is no completeness question to answer about a tree the run will not use.
 */
export interface TaskBriefPreview extends TaskProse {
  readonly contextPreview: readonly ContextSourceReport[];
}

/**
 * The brief a run is entitled to act on.
 *
 * `contextSources` describes the **authorised task worktree**, at the commit
 * the task was pinned to — the tree `buildImplementPayload` tells the agent to
 * open, and the tree the agent's `cwd` really is.
 */
export interface ExecutionBrief extends TaskProse {
  readonly contextSources: readonly ContextSourceReport[];
  /** `true` when every declared context source is `PRESENT` in the worktree. */
  readonly contextComplete: boolean;
  /**
   * The CodeGraph capability as it stands **in the worktree the agents open**,
   * assessed against the requirement the repository declared.
   *
   * A sibling of {@link contextComplete}, and the same kind of fact: an
   * execution-time property of one working copy, discovered per task. It is here
   * rather than on the resolved repository because the resolver asks at the
   * canonical root, before any task is chosen and before any worktree exists —
   * and those two directories can disagree. They did: `.codegraph/` is ignored
   * through `.git/info/exclude`, a file in the common Git directory, so every
   * linked worktree inherits the *rule* and none inherits the directory. AO
   * judged `REQUIRED` satisfied from the root while the writer worked in a tree
   * where the tool could answer nothing.
   */
  readonly codegraph: CapabilityAssessment;
  /**
   * `true` when every capability the repository declared as `REQUIRED` is
   * satisfied in this worktree.
   *
   * One name for the conjunction, so the steps that gate on it do not each
   * spell out which capabilities exist. Today there is one.
   */
  readonly capabilitiesSatisfied: boolean;
}

export interface TaskBriefPreviewSuccess {
  readonly ok: true;
  readonly code: 'PREVIEW';
  readonly preview: TaskBriefPreview;
}

export interface ExecutionBriefSuccess {
  readonly ok: true;
  readonly code: 'BRIEF';
  readonly brief: ExecutionBrief;
}

export interface TaskBriefFailure {
  readonly ok: false;
  readonly code: TaskBriefFailureCode;
  /** A static sentence from this module. Carries no path and no file content. */
  readonly detail: string;
}

export type TaskBriefPreviewResult = TaskBriefPreviewSuccess | TaskBriefFailure;
export type ExecutionBriefResult = ExecutionBriefSuccess | TaskBriefFailure;

function failure(code: TaskBriefFailureCode): TaskBriefFailure {
  return Object.freeze({ ok: false as const, code, detail: FAILURE_DETAIL[code] });
}

/** This module's sentence for each fact the safe-open chain reports. */
const TASK_FILE_REFUSAL_CODE: Readonly<Record<ReadRefusal, TaskBriefFailureCode>> = Object.freeze({
  UNSAFE: 'TASK_FILE_UNSAFE',
  TOO_LARGE: 'TASK_FILE_TOO_LARGE',
  READ_FAILED: 'TASK_FILE_READ_FAILED',
});

const CONTEXT_REFUSAL_STATUS: Readonly<Record<InspectRefusal, ContextSourceStatus>> = Object.freeze({
  UNSAFE: 'UNSAFE',
  MISSING: 'MISSING',
  UNREADABLE: 'UNREADABLE',
});

/**
 * Clamps `text` to `maxBytes` UTF-8 bytes without splitting a code point.
 *
 * Iteration is by code point (`for…of` over a string yields whole astral
 * characters), so a surrogate pair is either wholly kept or wholly dropped. A
 * grapheme cluster may still be split — that is a different contract, and this
 * one is stated in code points because that is what "valid UTF-8" needs.
 */
function clampUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };

  let used = 0;
  let out = '';
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (used + size > maxBytes) break;
    out += codePoint;
    used += size;
  }
  return { text: out, truncated: true };
}

/**
 * Proves the declared task source is a usable directory inside the root.
 *
 * The same classification `discoverTasks` performs, so the two readers report
 * one repository condition with one code. Before this existed,
 * `TASK_SOURCE_PATH_UNSAFE` was declared, exported and unreachable, and a
 * symlinked task source was reported here as a *task-file* problem.
 */
function proveTaskSource(root: string, sourcePath: string): TaskBriefFailure | null {
  // The same proof discovery runs, from the same owner. The brief's vocabulary
  // is coarser — it has one code for "the source is not usable" where discovery
  // distinguishes four — but the *check* is not a second implementation.
  return proveContainedDirectory(root, sourcePath).ok ? null : failure('TASK_SOURCE_PATH_UNSAFE');
}

/** The task's own words, read from the repository's task source. */
function readProse(repository: ResolvedRepository, taskId: string): TaskProse | TaskBriefFailure {
  if (!isValidTaskId(taskId)) return failure('TASK_ID_INVALID');

  const root = repository.root;
  const sourceSegments = repository.taskSource.path.split('/');
  const sourcePath = join(root, ...sourceSegments);

  const unsafeSource = proveTaskSource(root, sourcePath);
  if (unsafeSource !== null) return unsafeSource;

  const read = readContainedFile(root, join(sourcePath, taskFileName(taskId)), MAX_TASK_FILE_BYTES);
  if (!read.ok) return failure(TASK_FILE_REFUSAL_CODE[read.refusal]);

  const frontmatter = readTaskFrontmatter(read.text);
  if (frontmatter.outcome !== 'FRONTMATTER') return failure('TASK_FRONTMATTER_UNUSABLE');

  const trimmed = frontmatter.body.trim();
  if (trimmed === '') return failure('TASK_BODY_EMPTY');

  const clamped = clampUtf8(trimmed, MAX_TASK_BODY_BYTES);
  return { taskId, body: clamped.text, bodyTruncated: clamped.truncated };
}

function isFailure(value: TaskProse | TaskBriefFailure): value is TaskBriefFailure {
  return 'ok' in value && value.ok === false;
}

/** Inspects each declared source inside `tree`, reading none of them. */
function inspectContext(
  repository: ResolvedRepository,
  tree: string,
): readonly ContextSourceReport[] {
  return Object.freeze(
    repository.context.canonicalSources.map((declared) => {
      const probe = inspectContainedFile(tree, join(tree, ...declared.split('/')));
      return Object.freeze({
        path: declared,
        status: probe.ok ? ('PRESENT' as const) : CONTEXT_REFUSAL_STATUS[probe.refusal],
      });
    }),
  );
}

/**
 * A plan's view of the brief. **Not authoritative for execution.**
 *
 * The prose is the repository's, and the context report describes the source
 * checkout. Nothing here may gate, authorise or block a writer — see
 * {@link readExecutionBrief}, which is what a run must use.
 *
 * Never throws for an expected condition. Read-only.
 */
export function previewTaskBrief(
  repository: ResolvedRepository,
  taskId: string,
): TaskBriefPreviewResult {
  const prose = readProse(repository, taskId);
  if (isFailure(prose)) return prose;

  return Object.freeze({
    ok: true as const,
    code: 'PREVIEW' as const,
    preview: Object.freeze({
      ...prose,
      contextPreview: inspectContext(repository, repository.root),
    }),
  });
}

/**
 * The brief a run acts on, with its context proven in `worktreePath`.
 *
 * `worktreePath` must be the **authorised** worktree — the path Git printed for
 * this task's registration, which is what the loop passes and what the agent's
 * `cwd` will be. Proving the context anywhere else is the defect this function
 * exists to make unrepeatable.
 *
 * The prose still comes from the repository's task source rather than from the
 * worktree, deliberately: a human who corrects a task file to release a parked
 * task edits it on the default branch, and a run that read its instructions
 * from the pinned worktree could never see that correction.
 *
 * Never throws for an expected condition. Read-only.
 */
export function readExecutionBrief(
  repository: ResolvedRepository,
  taskId: string,
  worktreePath: string,
): ExecutionBriefResult {
  const prose = readProse(repository, taskId);
  if (isFailure(prose)) return prose;

  const contextSources = inspectContext(repository, worktreePath);

  // The capability is probed in the SAME tree the context was proven in, and
  // named explicitly rather than looped over `REPOSITORY_CAPABILITIES`: the
  // resolver names it too (`resolve-repository.ts`), and a generic loop over a
  // capability-specific probe is a wrong answer waiting for the second
  // capability. The requirement comes from the resolved repository, which is
  // where the profile's declaration already lives; only the STATUS is measured
  // here, and only here is it measured in the right directory.
  const requirement = repository.capabilities.codegraph.requirement;
  const status = probeCodegraphCapability(worktreePath);
  const codegraph: CapabilityAssessment = Object.freeze({
    capability: 'codegraph' as const,
    requirement,
    status,
    satisfied: capabilitySatisfied(requirement, status),
  });

  return Object.freeze({
    ok: true as const,
    code: 'BRIEF' as const,
    brief: Object.freeze({
      ...prose,
      contextSources,
      contextComplete: contextSources.every((source) => source.status === 'PRESENT'),
      codegraph,
      capabilitiesSatisfied: codegraph.satisfied,
    }),
  });
}
