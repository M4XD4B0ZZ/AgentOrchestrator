/**
 * The static planning contract: what a task *is* on disk, before anything is
 * discovered, ranked or run.
 *
 * Two separate things are pinned here and they are deliberately not merged:
 * the **task-id grammar** (which also decides the filename) and the
 * **TaskDefinition** contract (the validated frontmatter). Neither knows
 * anything about `TaskState` — see `tests/task-definition-vs-task-state.test.ts`
 * for the evidence that the two domains stay apart.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_TASK_ID_LENGTH,
  isValidTaskId,
  taskFileName,
  taskIdFromFileName,
} from '../src/plan/task-id.js';
import {
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '../src/plan/internal/task-definition-object-schema.js';
import { safeParseTaskDefinition } from '../src/plan/task-definition.js';

/** A minimal definition every test can narrow from. */
function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'V1-02',
    title: 'Task source and deterministic selection',
    status: 'OPEN',
    kind: 'NORMAL',
    priority: 'HIGH',
    currentFocus: true,
    dependsOn: ['V1-01'],
    ...overrides,
  };
}

describe('task-id grammar', () => {
  it('accepts the identifier shapes this project actually uses', () => {
    for (const id of ['V1-02', 'AO-008', 'AO-008-S2-R1', 'a', '0', 'task_1', 'v1.2-rc']) {
      expect(isValidTaskId(id), id).toBe(true);
    }
  });

  it('refuses path separators', () => {
    for (const id of ['a/b', 'a\\b', '../escape', 'C:/abs']) {
      expect(isValidTaskId(id), id).toBe(false);
    }
  });

  it('refuses whitespace and control characters', () => {
    for (const id of ['a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007f', ' V1-02', 'V1-02 ']) {
      expect(isValidTaskId(id), id).toBe(false);
    }
  });

  it('refuses shell metacharacters', () => {
    for (const id of ['a&b', 'a|b', 'a;b', 'a$b', 'a`b', 'a(b)', 'a>b', 'a%b', 'a^b', "a'b", 'a"b']) {
      expect(isValidTaskId(id), id).toBe(false);
    }
  });

  it('refuses "." and ".." outright, and any leading dot', () => {
    for (const id of ['.', '..', '.hidden', '...']) {
      expect(isValidTaskId(id), id).toBe(false);
    }
  });

  it('refuses a trailing dot, which Windows silently strips from a filename', () => {
    expect(isValidTaskId('V1-02.')).toBe(false);
  });

  it('refuses a Windows reserved device name, whatever its case', () => {
    // `NUL.md` is not a file on Windows: it is the null device, and reading it
    // yields an empty document rather than ENOENT.
    for (const id of ['NUL', 'nul', 'CON', 'PRN', 'AUX', 'COM1', 'lpt9']) {
      expect(isValidTaskId(id), id).toBe(false);
    }
  });

  it('refuses the empty id and anything past the length ceiling', () => {
    expect(isValidTaskId('')).toBe(false);
    expect(isValidTaskId('a'.repeat(MAX_TASK_ID_LENGTH))).toBe(true);
    expect(isValidTaskId('a'.repeat(MAX_TASK_ID_LENGTH + 1))).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(isValidTaskId(undefined)).toBe(false);
    expect(isValidTaskId(42)).toBe(false);
  });
});

describe('task filename contract', () => {
  it('names a task file exactly <id>.md', () => {
    expect(taskFileName('AO-008-S2-R1')).toBe('AO-008-S2-R1.md');
  });

  it('recovers the id from a well-formed filename', () => {
    expect(taskIdFromFileName('V1-02.md')).toBe('V1-02');
  });

  it('is exact about the extension: no .MD, no .markdown, no bare .md', () => {
    expect(taskIdFromFileName('V1-02.MD')).toBeNull();
    expect(taskIdFromFileName('V1-02.markdown')).toBeNull();
    expect(taskIdFromFileName('V1-02')).toBeNull();
    expect(taskIdFromFileName('.md')).toBeNull();
  });

  it('refuses a filename whose stem is not a legal id', () => {
    expect(taskIdFromFileName('a b.md')).toBeNull();
    expect(taskIdFromFileName('..md')).toBeNull();
    expect(taskIdFromFileName('NUL.md')).toBeNull();
  });

  it('round-trips every legal id', () => {
    for (const id of ['V1-02', 'AO-008-S2-R1', 'a', 'v1.2-rc']) {
      expect(taskIdFromFileName(taskFileName(id))).toBe(id);
    }
  });
});

describe('TaskDefinition contract', () => {
  it('accepts a complete, well-formed definition', () => {
    const parsed = safeParseTaskDefinition(definition());
    expect(parsed.success).toBe(true);
  });

  it('closes the value sets', () => {
    expect([...TASK_STATUSES]).toEqual(['OPEN', 'DONE']);
    expect([...TASK_KINDS]).toEqual(['NORMAL', 'REMEDIATION']);
    expect([...TASK_PRIORITIES]).toEqual(['HIGH', 'NORMAL', 'LOW']);
  });

  it('refuses a value outside a closed set', () => {
    expect(safeParseTaskDefinition(definition({ status: 'CLOSED' })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ kind: 'REVIEW' })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ priority: 'URGENT' })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ status: 'open' })).success).toBe(false);
  });

  it('requires every field: nothing is defaulted on the repository\u2019s behalf', () => {
    for (const field of ['id', 'title', 'status', 'kind', 'priority', 'currentFocus', 'dependsOn']) {
      const incomplete = definition();
      delete incomplete[field];
      expect(safeParseTaskDefinition(incomplete).success, field).toBe(false);
    }
  });

  it('refuses an unknown frontmatter key', () => {
    expect(safeParseTaskDefinition(definition({ assignee: 'someone' })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ schemaVersion: 1 })).success).toBe(false);
  });

  it('refuses runtime state in the static plan', () => {
    for (const runtimeField of ['state', 'reviewRound', 'resumeFrom', 'worktreePath']) {
      expect(
        safeParseTaskDefinition(definition({ [runtimeField]: 'x' })).success,
        runtimeField,
      ).toBe(false);
    }
  });

  it('requires currentFocus to be a real boolean, not a truthy string', () => {
    expect(safeParseTaskDefinition(definition({ currentFocus: 'true' })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ currentFocus: 1 })).success).toBe(false);
  });

  it('allows several tasks to claim focus: it is a ranking signal, not a singleton', () => {
    // Two independently valid definitions may both be focused. Nothing in the
    // *contract* arbitrates between them; ranking does.
    expect(safeParseTaskDefinition(definition({ id: 'A', currentFocus: true })).success).toBe(true);
    expect(safeParseTaskDefinition(definition({ id: 'B', currentFocus: true })).success).toBe(true);
  });

  it('accepts an empty dependsOn list', () => {
    expect(safeParseTaskDefinition(definition({ dependsOn: [] })).success).toBe(true);
  });

  it('refuses a dependency that is not a legal task id', () => {
    expect(safeParseTaskDefinition(definition({ dependsOn: ['../escape'] })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ dependsOn: [''] })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ dependsOn: [42] })).success).toBe(false);
  });

  it('refuses a repeated dependency', () => {
    expect(safeParseTaskDefinition(definition({ dependsOn: ['A', 'A'] })).success).toBe(false);
  });

  it('refuses a task that depends on itself', () => {
    expect(safeParseTaskDefinition(definition({ id: 'X', dependsOn: ['X'] })).success).toBe(false);
  });

  it('refuses a title carrying control characters', () => {
    expect(safeParseTaskDefinition(definition({ title: 'a\nb' })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ title: 'a\u0000b' })).success).toBe(false);
  });

  it('refuses an empty or unbounded title', () => {
    expect(safeParseTaskDefinition(definition({ title: '' })).success).toBe(false);
    expect(safeParseTaskDefinition(definition({ title: 'x'.repeat(4096) })).success).toBe(false);
  });

  it('returns a frozen value, so a plan cannot be edited after validation', () => {
    const parsed = safeParseTaskDefinition(definition());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.isFrozen(parsed.data)).toBe(true);
    expect(Object.isFrozen(parsed.data.dependsOn)).toBe(true);
  });
});
