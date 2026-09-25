/**
 * The writer's write guard (AO-MEMGUARD-001): the shared Claude memory folder is not the writer's
 * to change, and neither is anything else outside its worktree.
 *
 * ── The defect, measured three times ──────────────────────────────────────
 *
 * Fix-round writers edited the operator's shared Claude auto-memory folder
 * (`~/.claude/projects/<main-repository-slug>/memory/`) in V1GAP-004 round 2,
 * V1GAP-005R round 1 and the V1GAP-023 fix round. Each wrote a "lesson" into a
 * folder that every later session — writer or interactive — loads as
 * instructions. The scope guard never saw it: it is a Git diff inside the
 * worktree, and the folder is not in the worktree.
 *
 * Measured on 2026-09-25 against the CLI AO launches (npm's `claude.cmd`, CLI
 * 2.1.282), with AO's exact argv and environment, in a scratch repository with
 * a worktree:
 *
 * ```text
 * variant                              "save to your memory" prompts   write to the absolute memory path
 * shipped argv                         WRITTEN (all three incidents)   WRITTEN
 * + CLAUDE_CODE_DISABLE_AUTO_MEMORY=1  not attempted                   WRITTEN
 * + --settings autoMemoryEnabled:false not attempted                   WRITTEN
 * + both                               not attempted                   WRITTEN
 * + both + deny Edit/Write(~/.claude/**) not attempted                 REFUSED ("denied by your permission settings")
 * ```
 *
 * So both switches remove the `# Memory` prompt section and the `MEMORY.md`
 * load — the trigger — but neither closes the path: `acceptEdits`, which
 * refuses every other write outside the working directory (and every other
 * path under `~/.claude` as "a sensitive file"), keeps an exemption for the
 * project's own auto-memory folder. Only the deny rule refuses it, and a deny
 * rule is only expressible through a settings file: `--disallowedTools
 * Edit(~/.claude/**)` also measured effective, but `(` is not shell-inert on the
 * `.cmd` path AO launches through.
 *
 * ── Three layers, each for a reason the others cannot cover ────────────────
 *
 * 1. Prevention: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the writer's environment
 *    (`auth/env-guard.ts`) and {@link WRITER_GUARD_SETTINGS} passed with
 *    `--settings`, rewritten and re-read byte for byte before every launch.
 * 2. Detection from the writer's own stream: every `Edit`/`Write`/`MultiEdit`/
 *    `NotebookEdit` whose target resolves outside the worktree, attempted or
 *    completed, is a violation. An attempt the deny rule refused is still an
 *    agent reaching for something that is not its own.
 * 3. Detection from the bytes: the memory folders the CLI would use for this
 *    worktree are snapshotted before the launch and compared after it,
 *    whatever the run's outcome. This is the layer that holds if a future CLI
 *    silently drops the switch, the rule, or the stream event.
 *
 * ── On a violation ────────────────────────────────────────────────────────
 *
 * The run fails closed (`AGENT_FORBIDDEN_WRITE`, which parks the task at
 * `HUMAN_DECISION_REQUIRED`), an evidence record is written, and **nothing is
 * restored**: undoing a write is itself a write to the operator's folder, and
 * whether the note should stay is a person's decision.
 *
 * The record doubles as a quarantine. `HUMAN_DECISION_REQUIRED` from a writer
 * failure is indistinguishable in durable state from a dead writer — the
 * failure code is not persisted — and the Zera supervisor's writer-restart lane
 * restarts exactly that shape. So while an open record exists for a worktree,
 * no writer is started in it at all (`AGENT_WRITE_QUARANTINED`), whoever asks.
 * A person acknowledges it by moving the record into the `acknowledged/`
 * folder beside it.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { OS_PATH_PROVIDER } from '../config/internal/path-provider.js';
import { orchestratorHome, type PathProvider } from '../config/paths.js';

/** The settings every writer launch carries. Exactly the measured variant; see the header. */
export const WRITER_GUARD_SETTINGS = Object.freeze({
  autoMemoryEnabled: false,
  permissions: Object.freeze({
    deny: Object.freeze([
      'Edit(~/.claude/**)',
      'Write(~/.claude/**)',
      'MultiEdit(~/.claude/**)',
      'NotebookEdit(~/.claude/**)',
    ]),
  }),
});

/** The exact bytes of the settings file. Written, then read back and compared, before a launch. */
export const WRITER_GUARD_SETTINGS_TEXT = `${JSON.stringify(WRITER_GUARD_SETTINGS, null, 2)}\n`;

/** Under the orchestrator home, beside `mcp/`. */
export const WRITER_GUARD_DIR_NAME = 'writer-guard';
/** One settings file per worktree: `<prefix><key>.json`, rewritten per launch, removed after the run. */
export const WRITER_GUARD_SETTINGS_FILE_PREFIX = 'writer-settings-';
/** Evidence records, one folder per worktree, `acknowledged/` inside it. */
export const WRITER_VIOLATIONS_DIR_NAME = 'writer-violations';
export const ACKNOWLEDGED_DIR_NAME = 'acknowledged';

/** The tools that write a file, and the input field that names it. */
const WRITE_TOOL_TARGET_FIELD: Readonly<Record<string, string>> = Object.freeze({
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
});

/** A short, stable, filename-safe key for a worktree path. */
function worktreeKey(worktreePath: string): string {
  const comparable = process.platform === 'win32' ? worktreePath.toLowerCase() : worktreePath;
  return createHash('sha256').update(comparable).digest('hex').slice(0, 24);
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort: a leftover settings file is inert — every launch writes and reads its own.
  }
}

/** One file's bytes in a snapshot are kept for the evidence up to this size. */
const MAX_EVIDENCE_FILE_BYTES = 256 * 1024;

/**
 * Claude Code's project folder name for a path: every character that is not an
 * ASCII letter or digit becomes `-`. Measured against the operator's folders:
 * `D:\Workspaces_VSCode\HealthApp` → `D--Workspaces-VSCode-HealthApp`.
 */
export function claudeProjectSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The main repository a worktree belongs to. A linked worktree has a `.git`
 * *file* naming `<main>/.git/worktrees/<name>`; a main checkout has a `.git`
 * directory and is its own answer. The CLI keys auto-memory on the main
 * repository (measured: a worktree session was told to write into the main
 * checkout's folder), so this is the folder that must be guarded.
 */
export function mainRepositoryRoot(worktreePath: string): string {
  const dotGit = join(worktreePath, '.git');
  try {
    if (lstatSync(dotGit).isFile()) {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
      if (match !== null) {
        const gitDir = resolve(worktreePath, match[1] as string);
        // <main>/.git/worktrees/<name> → <main>
        const worktreesDir = dirname(gitDir);
        if (basename(worktreesDir) === 'worktrees') return dirname(dirname(worktreesDir));
      }
    }
  } catch {
    // No `.git` at all: fall through and guard the path itself.
  }
  return worktreePath;
}

/** The memory folders the CLI could use for a session started in `worktreePath`. */
export function protectedMemoryDirectories(worktreePath: string, homeDirectory: string): string[] {
  const projects = join(homeDirectory, '.claude', 'projects');
  const roots = [mainRepositoryRoot(worktreePath), worktreePath];
  const dirs = roots.map((root) => join(projects, claudeProjectSlug(root), 'memory'));
  return [...new Set(dirs)];
}

/* ─────────────────────────────── snapshots ─────────────────────────────── */

export interface FileSnapshot {
  readonly sha256: string;
  readonly bytes: number;
  /** The content, when small enough to keep as evidence; `null` otherwise. */
  readonly content: string | null;
}

/** Relative file path → snapshot, for one directory; `null` when the directory does not exist. */
export type DirectorySnapshot = ReadonlyMap<string, FileSnapshot> | null;

/** Throws when an existing directory cannot be read: an unreadable baseline is no baseline. */
export function snapshotDirectory(directory: string): DirectorySnapshot {
  if (!existsSync(directory)) return null;
  const files = new Map<string, FileSnapshot>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      const bytes = readFileSync(full);
      files.set(rel, {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        content: bytes.length <= MAX_EVIDENCE_FILE_BYTES ? bytes.toString('utf8') : null,
      });
    }
  };
  walk(directory, '');
  return files;
}

export interface MemoryChange {
  readonly directory: string;
  readonly file: string | null;
  readonly change: 'ADDED' | 'MODIFIED' | 'DELETED' | 'DIRECTORY_CREATED' | 'DIRECTORY_REMOVED';
  readonly before: FileSnapshot | null;
  readonly after: FileSnapshot | null;
}

/** Every difference between two snapshots of the same directory. */
export function diffSnapshots(
  directory: string,
  before: DirectorySnapshot,
  after: DirectorySnapshot,
): MemoryChange[] {
  if (before === null && after === null) return [];
  if (before === null) {
    const created: MemoryChange[] = [
      { directory, file: null, change: 'DIRECTORY_CREATED', before: null, after: null },
    ];
    for (const [file, snap] of after ?? []) {
      created.push({ directory, file, change: 'ADDED', before: null, after: snap });
    }
    return created;
  }
  if (after === null) {
    return [{ directory, file: null, change: 'DIRECTORY_REMOVED', before: null, after: null }];
  }
  const changes: MemoryChange[] = [];
  for (const [file, was] of before) {
    const now = after.get(file);
    if (now === undefined) changes.push({ directory, file, change: 'DELETED', before: was, after: null });
    else if (now.sha256 !== was.sha256) {
      changes.push({ directory, file, change: 'MODIFIED', before: was, after: now });
    }
  }
  for (const [file, now] of after) {
    if (!before.has(file)) changes.push({ directory, file, change: 'ADDED', before: null, after: now });
  }
  return changes;
}

/* ─────────────────────────── the stream detector ──────────────────────── */

export interface OutsideWrite {
  readonly tool: string;
  /** Exactly as the agent named it. */
  readonly target: string;
  /** Resolved against the worktree. */
  readonly resolved: string;
  /** Whether the CLI reported the call as failed (for example, refused by the deny rule). */
  readonly refused: boolean;
}

function canonicalForComparison(path: string): string {
  // Resolve junctions and symlinks on the deepest part that exists, so a link inside the worktree
  // that points outside it is judged by where the bytes land.
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // Keep the lexical path.
  }
  const joined = rest.length === 0 ? real : join(real, ...rest);
  const normalized = resolve(joined);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Whether `target` (already absolute) lies inside `root` (or is `root`). */
export function isInside(root: string, target: string): boolean {
  const r = canonicalForComparison(root);
  const t = canonicalForComparison(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Every file-writing tool call in a `stream-json` stdout whose target resolves
 * outside `worktreePath`. Lines that are not JSON are skipped: this reads what
 * the agent asked for, and the envelope's own validity is judged elsewhere.
 */
export function outsideWritesInStream(stdout: string, worktreePath: string): OutsideWrite[] {
  const uses = new Map<string, { tool: string; target: string }>();
  const failed = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (event as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const field = WRITE_TOOL_TARGET_FIELD[block.name];
        const input = block.input as Record<string, unknown> | undefined;
        const target = field === undefined ? undefined : input?.[field];
        if (typeof target === 'string' && typeof block.id === 'string') {
          uses.set(block.id, { tool: block.name, target });
        }
      }
      if (block?.type === 'tool_result' && block.is_error === true && typeof block.tool_use_id === 'string') {
        failed.add(block.tool_use_id);
      }
    }
  }
  const outside: OutsideWrite[] = [];
  for (const [id, use] of uses) {
    const resolved = isAbsolute(use.target) ? resolve(use.target) : resolve(worktreePath, use.target);
    if (!isInside(worktreePath, resolved)) {
      outside.push({ tool: use.tool, target: use.target, resolved, refused: failed.has(id) });
    }
  }
  return outside;
}

/* ───────────────────────────── the guard itself ────────────────────────── */

export interface WriterViolation {
  readonly outsideWrites: readonly OutsideWrite[];
  readonly memoryChanges: readonly MemoryChange[];
}

export interface WriterGuardSession {
  /** The `--settings` value for this launch. */
  readonly settingsPath: string;
  /** Called once after the process ended, whatever its outcome. */
  inspect(stdout: string): WriterViolation | null;
}

export type WriterGuardStart =
  | { readonly ok: true; readonly session: WriterGuardSession }
  | { readonly ok: false; readonly code: 'AGENT_WRITE_GUARD_UNAVAILABLE' | 'AGENT_WRITE_QUARANTINED'; readonly evidence: string | null };

export interface WriterWriteGuard {
  /** Establishes the guard for one launch, or refuses the launch. */
  start(request: { readonly worktreePath: string }): WriterGuardStart;
  /** Records a violation durably. Returns the record's path, or `null` when it could not be written. */
  record(violation: WriterViolation, context: ViolationContext): string | null;
}

export interface ViolationContext {
  readonly worktreePath: string;
  readonly phase: string;
  readonly round: number;
  readonly detectedAt: string;
}

export interface WriterWriteGuardOptions {
  /** Where the settings file and the evidence live. Default: the orchestrator home. */
  readonly orchestratorHome?: string;
  /** The profile the CLI resolves `~` and its project folders against. Default: the OS user's. */
  readonly homeDirectory?: string;
}

/** The folder holding violation records for one worktree. */
export function violationDirectory(orchestratorHomeDir: string, worktreePath: string): string {
  return join(orchestratorHomeDir, WRITER_VIOLATIONS_DIR_NAME, claudeProjectSlug(worktreePath));
}

/** Open (not yet acknowledged) records for a worktree. Throws when the folder exists but cannot be read. */
export function openViolationRecords(orchestratorHomeDir: string, worktreePath: string): string[] {
  const dir = violationDirectory(orchestratorHomeDir, worktreePath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && statSync(join(dir, name)).isFile())
    .map((name) => join(dir, name))
    .sort();
}

export function createWriterWriteGuard(
  options: WriterWriteGuardOptions = {},
  provider: PathProvider = OS_PATH_PROVIDER,
): WriterWriteGuard {
  const home = (): string => options.orchestratorHome ?? orchestratorHome(provider);
  const profile = (): string => options.homeDirectory ?? provider.homeDirectory;

  return Object.freeze({
    start({ worktreePath }: { readonly worktreePath: string }): WriterGuardStart {
      let open: string[];
      try {
        open = openViolationRecords(home(), worktreePath);
      } catch {
        return { ok: false, code: 'AGENT_WRITE_GUARD_UNAVAILABLE', evidence: null } as const;
      }
      if (open.length > 0) {
        return { ok: false, code: 'AGENT_WRITE_QUARANTINED', evidence: open[0] as string } as const;
      }

      let settingsPath: string;
      let directories: string[];
      let baseline: DirectorySnapshot[];
      try {
        const dir = join(home(), WRITER_GUARD_DIR_NAME);
        mkdirSync(dir, { recursive: true });
        // One file per worktree, written for this launch and read back: the file the CLI reads is the
        // one this launch wrote, never what an earlier process or another hand left. Named after the
        // worktree rather than the launch so the same request builds the same argv; two writers never
        // share a worktree at once (the execution lease), and a concurrent launch elsewhere has its
        // own file.
        settingsPath = join(dir, `${WRITER_GUARD_SETTINGS_FILE_PREFIX}${worktreeKey(worktreePath)}.json`);
        writeFileSync(settingsPath, WRITER_GUARD_SETTINGS_TEXT, 'utf8');
        if (readFileSync(settingsPath, 'utf8') !== WRITER_GUARD_SETTINGS_TEXT) {
          removeQuietly(settingsPath);
          return { ok: false, code: 'AGENT_WRITE_GUARD_UNAVAILABLE', evidence: null } as const;
        }
        directories = protectedMemoryDirectories(worktreePath, profile());
        baseline = directories.map((d) => snapshotDirectory(d));
      } catch {
        return { ok: false, code: 'AGENT_WRITE_GUARD_UNAVAILABLE', evidence: null } as const;
      }

      const session: WriterGuardSession = Object.freeze({
        settingsPath,
        inspect(stdout: string): WriterViolation | null {
          // The CLI read its settings at start-up; the file has done its job.
          removeQuietly(settingsPath);
          const outsideWrites = outsideWritesInStream(stdout, worktreePath);
          const memoryChanges: MemoryChange[] = [];
          directories.forEach((d, i) => {
            let after: DirectorySnapshot;
            try {
              after = snapshotDirectory(d);
            } catch {
              // A folder that was readable before and is not now changed in a way this cannot see:
              // that is not a clean result.
              memoryChanges.push({ directory: d, file: null, change: 'MODIFIED', before: null, after: null });
              return;
            }
            memoryChanges.push(...diffSnapshots(d, baseline[i] ?? null, after));
          });
          if (outsideWrites.length === 0 && memoryChanges.length === 0) return null;
          return Object.freeze({ outsideWrites, memoryChanges });
        },
      });
      return { ok: true, session } as const;
    },

    record(violation: WriterViolation, context: ViolationContext): string | null {
      try {
        const dir = violationDirectory(home(), context.worktreePath);
        mkdirSync(dir, { recursive: true });
        const stamp = context.detectedAt.replace(/[:.]/g, '-');
        const path = join(dir, `${stamp}-${context.phase}-r${context.round}.json`);
        const record = {
          kind: 'AO_WRITER_FORBIDDEN_WRITE',
          recordVersion: 1,
          ...context,
          acknowledge: `Review this record, then move it into ${join(dir, ACKNOWLEDGED_DIR_NAME)} to allow writers in this worktree again. AO restored nothing.`,
          outsideWrites: violation.outsideWrites,
          memoryChanges: violation.memoryChanges,
        };
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        return path;
      } catch {
        return null;
      }
    },
  });
}
