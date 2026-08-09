/**
 * INTERNAL — not part of the public runtime API.
 *
 * The *plain object shape* of a task definition: field types only, no
 * cross-field invariants. It exists for exactly two consumers, mirroring the
 * task-state and repository-profile splits (AO-009, V1-01):
 *
 *  1. JSON Schema generation (`plan/json-schema.ts`), because JSON Schema
 *     cannot express the invariants layered on in `plan/task-definition.ts`;
 *  2. composition inside `plan/task-definition.ts`, which adds them and exposes
 *     the result as `TaskDefinitionSchema`.
 *
 * It must never be re-exported from a public module. `TaskDefinitionObjectSchema`
 * accepts definitions the contract rejects — a task that depends on itself, a
 * `dependsOn` list naming the same task twice — so handing it to callers as a
 * validator would quietly bypass the contract.
 *
 * ── This is the static plan, not the runtime state ─────────────────────────
 *
 * A `TaskDefinition` is what a repository *wrote down*: which work exists, what
 * it depends on, how it should be ranked. It is read-only input, it is derived
 * from a file in the repository, and it never changes while a task runs.
 *
 * `TaskState` (`src/core/task-state.ts`) is the opposite: it is what the
 * orchestrator *did*, it belongs to exactly one task, it is written by the
 * runtime, and it carries a schema version because it is persisted.
 *
 * The two contracts share no field, no version and no module, and neither
 * imports the other. In particular this shape carries no `state`, no
 * `reviewRound`, no `resumeFrom`, no worktree and no commit; and `TaskState`
 * gained no `dependsOn`, `priority`, `currentFocus` or `kind`. A definition
 * that could also be a state would let a plan claim runtime facts it has no way
 * to know.
 */

import { z } from 'zod';

import { TaskIdSchema } from '../task-id.js';

/**
 * Whether the work still has to happen.
 *
 * Two values, because two is what dependency satisfaction needs: a dependency
 * is met when it is `DONE`, and unmet otherwise. Anything finer — `IN_PROGRESS`,
 * `BLOCKED` — would be runtime knowledge, and runtime knowledge is not written
 * in the repository's plan.
 */
export const TASK_STATUSES = ['OPEN', 'DONE'] as const;

/**
 * What kind of work this is.
 *
 * `REMEDIATION` marks work that exists because something already delivered is
 * wrong. It ranks ahead of `NORMAL` — see `plan/select-task.ts` — which is the
 * only place the distinction has an effect.
 */
export const TASK_KINDS = ['NORMAL', 'REMEDIATION'] as const;

/** Declared urgency. A closed set, so ranking never compares free-form text. */
export const TASK_PRIORITIES = ['HIGH', 'NORMAL', 'LOW'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * `true` when `value` contains a C0 control, DEL, or a C1 control.
 *
 * Written as a code-point test rather than as a regular expression with escaped
 * ranges: the characters this rejects are exactly the ones an editor, a diff
 * view or a copy-paste is liable to mangle inside a character class, and a
 * silently mangled class would still compile while rejecting nothing.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
}

/**
 * A human-readable one-line summary.
 *
 * Bounded and control-character-free. The title is repository-supplied text
 * that no orchestrator decision reads — it exists so a human can recognise the
 * task — and a bounded, single-line string is what keeps it from becoming a
 * carrier for terminal escapes or an unbounded allocation.
 */
const TaskTitleSchema = z
  .string()
  .min(1, 'title must not be empty.')
  .max(200, 'title must not exceed 200 characters.')
  .refine(
    (value) => !hasControlCharacter(value),
    'title must not contain control characters.',
  );

/**
 * Plain object shape, without cross-field invariants. INTERNAL.
 *
 * Every field is required. No value is defaulted on the repository's behalf: a
 * task file that does not state its priority has not stated its priority, and
 * inventing `NORMAL` for it would put a ranking decision in this module that
 * the repository never wrote down.
 */
export const TaskDefinitionObjectSchema = z
  .object({
    id: TaskIdSchema,
    title: TaskTitleSchema,
    status: z.enum(TASK_STATUSES),
    kind: z.enum(TASK_KINDS),
    priority: z.enum(TASK_PRIORITIES),
    /**
     * A ranking signal, and nothing else. It is explicitly **not** a singleton
     * contract: any number of tasks may claim focus, and the ranking tuple
     * decides between them. A "exactly one focused task" rule would make one
     * task file's validity depend on every other one.
     */
    currentFocus: z.boolean(),
    dependsOn: z
      .array(TaskIdSchema)
      .max(64, 'dependsOn must not exceed 64 entries.'),
  })
  .strict();
