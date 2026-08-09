/**
 * The task-definition contract: one unit of planned work, exactly as a
 * repository wrote it down.
 *
 * A definition is the validated **frontmatter** of one `<id>.md` file inside
 * the repository's `MARKDOWN_DIRECTORY` task source. It is static: it says what
 * work exists, what that work waits for, and how it should be ranked against
 * other work. It says nothing about what the orchestrator has done, because a
 * file in a repository cannot know that.
 *
 * That boundary is the whole reason this module exists next to
 * `src/core/task-state.ts` rather than inside it. `TaskState` is the runtime
 * record of a *single* task: it is written by the orchestrator, persisted, and
 * versioned (`TASK_STATE_SCHEMA_VERSION`). `TaskDefinition` is read-only input
 * describing *many* tasks. Merging them would have produced a "task register" —
 * a value that is simultaneously a plan and a state, where a repository's
 * markdown could assert a runtime fact. Nothing in this module imports the
 * state contract, and the state contract gained no planning field.
 *
 * Source of truth: this module. `schemas/task-definition.schema.json` is
 * generated from it (`npm run schema:generate`) and is never edited by hand.
 * The invariants below are *not* in that document, exactly as with the profile
 * and the state: JSON Schema cannot express them, so they live in Zod and are
 * described in prose there.
 */

import { z } from 'zod';

import {
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskDefinitionObjectSchema,
  type TaskKind,
  type TaskPriority,
  type TaskStatus,
} from './internal/task-definition-object-schema.js';

export { TASK_KINDS, TASK_PRIORITIES, TASK_STATUSES };
export type { TaskKind, TaskPriority, TaskStatus };

/** The validated frontmatter of one task file. Frozen once parsed. */
export interface TaskDefinition {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly kind: TaskKind;
  readonly priority: TaskPriority;
  /** A ranking signal. Any number of tasks may set it; see `select-task.ts`. */
  readonly currentFocus: boolean;
  /** Task ids that must be `DONE` before this task becomes eligible. */
  readonly dependsOn: readonly string[];
}

export type TaskDefinitionInput = z.input<typeof TaskDefinitionObjectSchema>;

/** Reports the first duplicate in `values`, or `null` when all are distinct. */
function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/**
 * The invariants JSON Schema cannot express, plus the freeze.
 *
 * Both are *within-object* rules — they compare a definition's fields with each
 * other and never with another task's. Rules that need the whole set (an
 * unknown dependency, a cycle, two files claiming one id) belong to
 * `plan/task-graph.ts`, which is the only layer that can see the whole set.
 */
export const TaskDefinitionSchema = TaskDefinitionObjectSchema.superRefine((value, ctx) => {
  // --- 1. A dependency list is a set --------------------------------------
  // A repeated dependency is not harmless noise: it is a sign the frontmatter
  // was assembled from two disagreeing edits, and it would silently double the
  // weight of one edge in any later count.
  const duplicate = firstDuplicate(value.dependsOn);
  if (duplicate !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['dependsOn'],
      message: `Task ${JSON.stringify(duplicate)} is listed as a dependency more than once.`,
    });
  }

  // --- 2. No task waits for itself ----------------------------------------
  // The shortest possible cycle, and the only one a single file can express.
  // It is caught here so that a task file is refused where it is read, rather
  // than surviving to become a one-node cycle in the graph. The graph layer
  // checks it again anyway — it must not depend on its input having come
  // through this schema.
  if (value.dependsOn.includes(value.id)) {
    ctx.addIssue({
      code: 'custom',
      path: ['dependsOn'],
      message: 'A task must not depend on itself.',
    });
  }
}).transform(
  (value): TaskDefinition =>
    Object.freeze({
      id: value.id,
      title: value.title,
      status: value.status,
      kind: value.kind,
      priority: value.priority,
      currentFocus: value.currentFocus,
      dependsOn: Object.freeze([...value.dependsOn]),
    }),
);

/** Throwing validator. */
export function parseTaskDefinition(value: unknown): TaskDefinition {
  return TaskDefinitionSchema.parse(value);
}

/** Non-throwing validator. */
export function safeParseTaskDefinition(
  value: unknown,
): z.ZodSafeParseResult<TaskDefinition> {
  return TaskDefinitionSchema.safeParse(value);
}
