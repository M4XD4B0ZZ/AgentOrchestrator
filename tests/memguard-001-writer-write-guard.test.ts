/**
 * AO-MEMGUARD-001 — a writer may not change the operator's shared Claude memory
 * folder, or anything else outside its worktree, and a violation stops the task
 * for a person without undoing anything.
 *
 * The three historical incidents are replayed here as the edits the writers
 * actually made (evidence: `D:\scratch_ao\v1gap-023\incident-memory-write-r1\`
 * and the operator's AO-runs register):
 *
 *   V1GAP-004 round 2   rewrote a rule in an existing feedback note
 *   V1GAP-005R round 1  inserted one paragraph into an existing project note
 *   V1GAP-023 fix round extended a MEMORY.md index line and added a paragraph
 *
 * The runner here is a fake that performs those writes itself, because what is
 * under test is AO's reaction to them. That the real CLI no longer *can* make
 * them is measured separately, against the real CLI, by
 * `npm run verify:writer-authority` (tests/opt-in/claude-writer-authority.mjs).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentCommandResult, AgentRunner } from '../src/agent/agent-command.js';
import { AGENT_FAILURE_DISPOSITION } from '../src/agent/agent-outcome.js';
import { runClaudeWriter, type ClaudeWriterRequest } from '../src/agent/claude-writer.js';
import {
  ACKNOWLEDGED_DIR_NAME,
  claudeProjectSlug,
  createWriterWriteGuard,
  diffSnapshots,
  mainRepositoryRoot,
  openViolationRecords,
  outsideWritesInStream,
  protectedMemoryDirectories,
  snapshotDirectory,
  violationDirectory,
  WRITER_GUARD_SETTINGS,
  WRITER_GUARD_SETTINGS_TEXT,
} from '../src/agent/writer-write-guard.js';
import { agentCommandResult, claudeResultStream } from './fixtures.js';
import { usageLimitResult } from './helpers/e2e-fixtures.js';

/* ═══════════════════════════════ fixtures ═══════════════════════════════ */

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

interface Lab {
  readonly main: string;
  readonly worktree: string;
  readonly aoHome: string;
  readonly profile: string;
  readonly memory: string;
  readonly guard: ReturnType<typeof createWriterWriteGuard>;
}

const SEED: Readonly<Record<string, string>> = {
  'MEMORY.md':
    '- [Scope rule](feedback_scope_rule.md) — a reviewer finding never widens scope\n' +
    '- [Sessions have no shell](project_ao_task_sessions_have_no_shell.md) — no Bash in task sessions\n',
  'feedback_scope_rule.md': '---\nname: feedback_scope_rule\n---\n\nA reviewer finding never widens scope.\n',
  'project_ao_task_sessions_have_no_shell.md':
    '---\nname: project_ao_task_sessions_have_no_shell\n---\n\nTask sessions have no Bash tool.\n',
};

/** A main checkout, a linked worktree of it, and a seeded memory folder under a scratch profile. */
function lab(): Lab {
  const base = tempDir('ao-memguard-');
  const main = join(base, 'repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'NOTES.md'), 'notes\n');
  git(main, 'add', 'NOTES.md');
  git(main, 'commit', '-q', '-m', 'seed');
  const worktree = join(base, 'repo.worktrees', 'T1');
  git(main, 'worktree', 'add', '-q', '-b', 'ao/task/T1', worktree);
  const aoHome = join(base, 'ao-home');
  const profile = join(base, 'profile');
  const memory = join(profile, '.claude', 'projects', claudeProjectSlug(main), 'memory');
  mkdirSync(memory, { recursive: true });
  for (const [name, text] of Object.entries(SEED)) writeFileSync(join(memory, name), text);
  const guard = createWriterWriteGuard({ orchestratorHome: aoHome, homeDirectory: profile });
  return { main, worktree, aoHome, profile, memory, guard };
}

function request(worktreePath: string, overrides: Partial<ClaudeWriterRequest> = {}): ClaudeWriterRequest {
  return { worktreePath, phase: 'REMEDIATE', round: 1, payload: 'fix the finding', mcp: null, ...overrides };
}

/** A stream carrying the given write tool calls (and results) before an ordinary success envelope. */
function streamWithWrites(
  writes: readonly { tool: string; path: string; refused?: boolean }[],
  tail: string = claudeResultStream(),
): string {
  const lines: string[] = [];
  writes.forEach((w, i) => {
    const id = `toolu_${i}`;
    const input = w.tool === 'NotebookEdit' ? { notebook_path: w.path } : { file_path: w.path };
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: w.tool, input }] } }));
    lines.push(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              is_error: w.refused === true,
              content: w.refused === true ? 'File is in a directory that is denied by your permission settings.' : 'ok',
            },
          ],
        },
      }),
    );
  });
  return lines.map((l) => `${l}\n`).join('') + tail;
}

interface Recorder {
  readonly runner: AgentRunner;
  readonly calls: { args: readonly string[]; cwd: string }[];
}

/** A fake writer: performs `effect` on disk, then answers with `result`. */
function writer(effect: () => void, result: AgentCommandResult): Recorder {
  const calls: Recorder['calls'] = [];
  return {
    calls,
    runner: async (_agent, args, cwd) => {
      calls.push({ args, cwd });
      effect();
      return result;
    },
  };
}

const read = (path: string) => readFileSync(path, 'utf8');

function recordOf(path: string | null | undefined): Record<string, unknown> {
  if (path === null || path === undefined) throw new Error('no evidence record');
  return JSON.parse(read(path)) as Record<string, unknown>;
}

/* ═══════════════════════ 1. the three incidents ═════════════════════════ */

describe('the three historical incidents fail closed, are recorded, and are not undone', () => {
  it('V1GAP-023 fix round: MEMORY.md index line extended and a paragraph added', async () => {
    const l = lab();
    const index = join(l.memory, 'MEMORY.md');
    const note = join(l.memory, 'project_ao_task_sessions_have_no_shell.md');
    const w = writer(
      () => {
        writeFileSync(index, read(index).replace('no Bash in task sessions', 'no Bash in task sessions (review still flags the rotation)'));
        writeFileSync(note, `${read(note)}\n**Disclosure alone does not satisfy review either.**\n`);
      },
      agentCommandResult({ stdout: streamWithWrites([{ tool: 'Edit', path: index }, { tool: 'Edit', path: note }]) }),
    );

    const outcome = await runClaudeWriter(request(l.worktree), { agent: w.runner, guard: l.guard });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('AGENT_FORBIDDEN_WRITE');
    expect(outcome.disposition).toBe('AGENT_NEEDS_ATTENTION');
    const record = recordOf(outcome.forbiddenWrite?.recordPath);
    expect(record['phase']).toBe('REMEDIATE');
    expect((record['outsideWrites'] as unknown[]).length).toBe(2);
    const changes = record['memoryChanges'] as { file: string; change: string; before: { content: string }; after: { content: string } }[];
    expect(changes.map((c) => `${c.change} ${c.file}`).sort()).toEqual([
      'MODIFIED MEMORY.md',
      'MODIFIED project_ao_task_sessions_have_no_shell.md',
    ]);
    // Both sides are kept, so a person can judge the note and restore it by hand if they choose.
    const noteChange = changes.find((c) => c.file === 'project_ao_task_sessions_have_no_shell.md');
    expect(noteChange?.before.content).toBe(SEED['project_ao_task_sessions_have_no_shell.md']);
    expect(noteChange?.after.content).toContain('Disclosure alone');
    // Nothing restored: AO never writes to the operator's folder.
    expect(read(note)).toContain('Disclosure alone');
    expect(read(index)).toContain('review still flags the rotation');
  });

  it('V1GAP-005R round 1: one paragraph inserted into an existing project note', async () => {
    const l = lab();
    const note = join(l.memory, 'project_ao_task_sessions_have_no_shell.md');
    const w = writer(
      () => writeFileSync(note, read(note).replace('Task sessions have no Bash tool.\n', 'Task sessions have no Bash tool.\n\nThe archive rotation cannot be done without a shell.\n')),
      agentCommandResult({ stdout: streamWithWrites([{ tool: 'Edit', path: note }]) }),
    );

    const outcome = await runClaudeWriter(request(l.worktree), { agent: w.runner, guard: l.guard });

    expect(outcome.ok === false && outcome.code).toBe('AGENT_FORBIDDEN_WRITE');
    expect(read(note)).toContain('cannot be done without a shell');
  });

  it('V1GAP-004 round 2: a rule rewritten inside an existing feedback note (implement phase)', async () => {
    const l = lab();
    const rule = join(l.memory, 'feedback_scope_rule.md');
    const w = writer(
      () => writeFileSync(rule, read(rule).replace('never widens scope', 'may widen scope')),
      agentCommandResult({ stdout: streamWithWrites([{ tool: 'Write', path: rule }]) }),
    );

    const outcome = await runClaudeWriter(request(l.worktree, { phase: 'IMPLEMENT', round: 2 }), {
      agent: w.runner,
      guard: l.guard,
    });

    expect(outcome.ok === false && outcome.code).toBe('AGENT_FORBIDDEN_WRITE');
    if (outcome.ok) return;
    const record = recordOf(outcome.forbiddenWrite?.recordPath);
    expect(record['phase']).toBe('IMPLEMENT');
    expect(record['round']).toBe(2);
    expect(read(rule)).toContain('may widen scope');
  });
});

/* ═══════════════════ 2. each detection layer on its own ═════════════════ */

describe('each detection layer holds on its own', () => {
  it('the byte guard catches a memory change the stream never mentioned', async () => {
    const l = lab();
    const w = writer(
      () => writeFileSync(join(l.memory, 'new_note.md'), 'a note\n'),
      agentCommandResult({ stdout: claudeResultStream() }),
    );

    const outcome = await runClaudeWriter(request(l.worktree), { agent: w.runner, guard: l.guard });

    expect(outcome.ok === false && outcome.code).toBe('AGENT_FORBIDDEN_WRITE');
    if (outcome.ok) return;
    const record = recordOf(outcome.forbiddenWrite?.recordPath);
    expect(record['outsideWrites']).toEqual([]);
    expect((record['memoryChanges'] as { change: string; file: string }[]).map((c) => `${c.change} ${c.file}`)).toEqual([
      'ADDED new_note.md',
    ]);
  });

  it('the stream detector catches an outside write the deny rule refused, with the folder untouched', async () => {
    const l = lab();
    const target = join(l.memory, 'lab_note.md');
    const w = writer(() => undefined, agentCommandResult({
      stdout: streamWithWrites([{ tool: 'Write', path: target, refused: true }]),
    }));

    const outcome = await runClaudeWriter(request(l.worktree), { agent: w.runner, guard: l.guard });

    expect(outcome.ok === false && outcome.code).toBe('AGENT_FORBIDDEN_WRITE');
    if (outcome.ok) return;
    const record = recordOf(outcome.forbiddenWrite?.recordPath);
    expect(record['memoryChanges']).toEqual([]);
    expect(record['outsideWrites']).toMatchObject([{ tool: 'Write', target, refused: true }]);
    expect(existsSync(target)).toBe(false);
  });

  it('dominates a quota refusal from the same run', async () => {
    const l = lab();
    const limited = usageLimitResult();
    const w = writer(
      () => writeFileSync(join(l.memory, 'MEMORY.md'), 'overwritten\n'),
      { ...limited, stdout: streamWithWrites([{ tool: 'Write', path: join(l.memory, 'MEMORY.md') }], limited.stdout) },
    );

    const outcome = await runClaudeWriter(request(l.worktree), { agent: w.runner, guard: l.guard });

    expect(outcome.ok === false && outcome.code).toBe('AGENT_FORBIDDEN_WRITE');
  });

  it('flags a write through a junction inside the worktree that lands outside it', async () => {
    const l = lab();
    const outside = tempDir('ao-memguard-outside-');
    symlinkSync(outside, join(l.worktree, 'linked'), 'junction');
    const found = outsideWritesInStream(
      streamWithWrites([{ tool: 'Write', path: join(l.worktree, 'linked', 'escape.txt') }]),
      l.worktree,
    );
    expect(found).toHaveLength(1);
  });
});

/* ════════════════════════ 3. the clean run ══════════════════════════════ */

describe('a writer that stays inside its worktree is not disturbed', () => {
  it('completes, writes no record, and is launched with the guard settings', async () => {
    const l = lab();
    const inside = join(l.worktree, 'NOTES.md');
    const w = writer(
      () => writeFileSync(inside, 'notes\nlab task done\n'),
      agentCommandResult({
        stdout: streamWithWrites([{ tool: 'Edit', path: inside }, { tool: 'Write', path: 'src/new.ts' }]),
      }),
    );

    const outcome = await runClaudeWriter(request(l.worktree), { agent: w.runner, guard: l.guard });

    expect(outcome.ok).toBe(true);
    expect(openViolationRecords(l.aoHome, l.worktree)).toEqual([]);
    const args = w.calls[0]?.args ?? [];
    const settingsPath = args[args.indexOf('--settings') + 1] as string;
    expect(args.indexOf('--settings')).toBe(args.indexOf('--tools') - 2);
    // The CLI has read it by now; the guard removes it after the run.
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('hands the CLI exactly the measured settings', async () => {
    const l = lab();
    let seen = '';
    const w: Recorder = {
      calls: [],
      runner: async (_agent, args) => {
        seen = read(args[args.indexOf('--settings') + 1] as string);
        return agentCommandResult({ stdout: claudeResultStream() });
      },
    };
    await runClaudeWriter(request(l.worktree), { agent: w.runner, guard: l.guard });
    expect(seen).toBe(WRITER_GUARD_SETTINGS_TEXT);
    expect(JSON.parse(seen)).toEqual({
      autoMemoryEnabled: false,
      permissions: {
        deny: ['Edit(~/.claude/**)', 'Write(~/.claude/**)', 'MultiEdit(~/.claude/**)', 'NotebookEdit(~/.claude/**)'],
      },
    });
    expect(WRITER_GUARD_SETTINGS.autoMemoryEnabled).toBe(false);
  });
});

/* ════════════════ 4. quarantine: a person must look first ═══════════════ */

describe('a violation quarantines the worktree until a person acknowledges it', () => {
  it('refuses the next launch without starting anything, then allows it once acknowledged', async () => {
    const l = lab();
    const first = writer(
      () => writeFileSync(join(l.memory, 'MEMORY.md'), 'x\n'),
      agentCommandResult({ stdout: claudeResultStream() }),
    );
    const violated = await runClaudeWriter(request(l.worktree), { agent: first.runner, guard: l.guard });
    expect(violated.ok === false && violated.code).toBe('AGENT_FORBIDDEN_WRITE');

    // The retry the supervisor's writer-restart lane would make, or a routine operator re-run.
    const retry = writer(() => undefined, agentCommandResult({ stdout: claudeResultStream() }));
    const refused = await runClaudeWriter(request(l.worktree, { phase: 'IMPLEMENT' }), {
      agent: retry.runner,
      guard: l.guard,
    });
    expect(refused.ok === false && refused.code).toBe('AGENT_WRITE_QUARANTINED');
    expect(refused.ok === false && refused.disposition).toBe('AGENT_NEEDS_ATTENTION');
    expect(retry.calls).toHaveLength(0);

    // A person reviewed it and moved it aside.
    const dir = violationDirectory(l.aoHome, l.worktree);
    mkdirSync(join(dir, ACKNOWLEDGED_DIR_NAME), { recursive: true });
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      renameSync(join(dir, name), join(dir, ACKNOWLEDGED_DIR_NAME, name));
    }
    const again = await runClaudeWriter(request(l.worktree), { agent: retry.runner, guard: l.guard });
    expect(again.ok).toBe(true);
    expect(retry.calls).toHaveLength(1);
  });

  it('does not quarantine a different worktree', async () => {
    const a = lab();
    const b = lab();
    const guard = createWriterWriteGuard({ orchestratorHome: a.aoHome, homeDirectory: a.profile });
    await runClaudeWriter(request(a.worktree), {
      agent: writer(() => writeFileSync(join(a.memory, 'MEMORY.md'), 'x\n'), agentCommandResult({ stdout: claudeResultStream() })).runner,
      guard,
    });
    const other = await runClaudeWriter(request(b.worktree), {
      agent: writer(() => undefined, agentCommandResult({ stdout: claudeResultStream() })).runner,
      guard,
    });
    expect(other.ok).toBe(true);
  });
});

/* ═══════════════ 5. no guard, no writer ═════════════════════════════════ */

describe('a writer never starts without its guard', () => {
  it('refuses when the guard settings cannot be written', async () => {
    const l = lab();
    const blocked = join(tempDir('ao-memguard-blocked-'), 'home-is-a-file');
    writeFileSync(blocked, 'not a directory');
    const guard = createWriterWriteGuard({ orchestratorHome: blocked, homeDirectory: l.profile });
    const w = writer(() => undefined, agentCommandResult({ stdout: claudeResultStream() }));

    const outcome = await runClaudeWriter(request(l.worktree), { agent: w.runner, guard });

    expect(outcome.ok === false && outcome.code).toBe('AGENT_WRITE_GUARD_UNAVAILABLE');
    expect(w.calls).toHaveLength(0);
  });

  it('maps every new code to a person', () => {
    expect(AGENT_FAILURE_DISPOSITION.AGENT_FORBIDDEN_WRITE).toBe('AGENT_NEEDS_ATTENTION');
    expect(AGENT_FAILURE_DISPOSITION.AGENT_WRITE_QUARANTINED).toBe('AGENT_NEEDS_ATTENTION');
    expect(AGENT_FAILURE_DISPOSITION.AGENT_WRITE_GUARD_UNAVAILABLE).toBe('AGENT_NEEDS_ATTENTION');
  });
});

/* ═══════════════════ 6. the pieces, directly ════════════════════════════ */

describe('the guard pieces', () => {
  it('names project folders the way the CLI does', () => {
    expect(claudeProjectSlug('D:\\Workspaces_VSCode\\HealthApp')).toBe('D--Workspaces-VSCode-HealthApp');
    expect(claudeProjectSlug('D:\\Workspaces_VSCode\\HealthApp.worktrees\\V1GAP-023')).toBe(
      'D--Workspaces-VSCode-HealthApp-worktrees-V1GAP-023',
    );
  });

  it('guards the main repository folder for a linked worktree, and the worktree folder too', () => {
    const l = lab();
    expect(mainRepositoryRoot(l.worktree).toLowerCase()).toBe(l.main.toLowerCase());
    expect(mainRepositoryRoot(l.main)).toBe(l.main);
    const dirs = protectedMemoryDirectories(l.worktree, l.profile).map((d) => d.toLowerCase());
    expect(dirs).toContain(l.memory.toLowerCase());
    expect(dirs).toContain(join(l.profile, '.claude', 'projects', claudeProjectSlug(l.worktree), 'memory').toLowerCase());
  });

  it('reports every kind of change between two snapshots', () => {
    const dir = tempDir('ao-memguard-snap-');
    writeFileSync(join(dir, 'a.md'), 'a');
    writeFileSync(join(dir, 'b.md'), 'b');
    const before = snapshotDirectory(dir);
    writeFileSync(join(dir, 'a.md'), 'a2');
    rmSync(join(dir, 'b.md'));
    writeFileSync(join(dir, 'c.md'), 'c');
    expect(diffSnapshots(dir, before, snapshotDirectory(dir)).map((c) => `${c.change} ${c.file}`).sort()).toEqual([
      'ADDED c.md',
      'DELETED b.md',
      'MODIFIED a.md',
    ]);
    expect(diffSnapshots(dir, before, before)).toEqual([]);
    expect(diffSnapshots(dir, null, null)).toEqual([]);
    expect(diffSnapshots(dir, null, snapshotDirectory(dir))[0]?.change).toBe('DIRECTORY_CREATED');
    expect(diffSnapshots(dir, before, null)[0]?.change).toBe('DIRECTORY_REMOVED');
  });

  it('judges targets by where they resolve, not how they are spelled', () => {
    const l = lab();
    const stream = streamWithWrites([
      { tool: 'Edit', path: 'NOTES.md' },
      { tool: 'Edit', path: join(l.worktree, 'src', 'deep', 'x.ts') },
      { tool: 'Edit', path: l.worktree.toUpperCase() + '\\NOTES.md' },
      { tool: 'Write', path: join('..', 'escape.txt') },
      { tool: 'NotebookEdit', path: join(l.main, 'nb.ipynb') },
      { tool: 'Read', path: join(l.memory, 'MEMORY.md') },
    ]);
    const found = outsideWritesInStream(stream, l.worktree).map((w) => w.tool);
    // `..` escapes, and the main checkout is outside the worktree; a Read is not a write.
    expect(found.sort()).toEqual(['NotebookEdit', 'Write']);
  });
});
