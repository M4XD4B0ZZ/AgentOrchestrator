/**
 * V1-04: durable task-state persistence.
 *
 * The properties under test are the ones a restart depends on:
 *
 *  - a state file is located deterministically from the *canonical repository
 *    root* and a validated task id — never from `process.cwd()`;
 *  - a write either lands in full or leaves the previous state byte-for-byte
 *    intact — there is no window in which the file on disk is half a state;
 *  - loading validates against the binding contract and reports every way it
 *    can fail as data;
 *  - loading **never writes**. A corrupt or stale state is reported, never
 *    repaired, never migrated, never deleted.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isContained } from '../src/doctor/safe-write.js';
import { isValidTaskId, MAX_TASK_ID_LENGTH } from '../src/plan/task-id.js';
import {
  deriveTaskStateLocation,
  taskRuntimeDirectory,
  TASK_RUNTIME_DIR_NAME,
} from '../src/state/state-location.js';
import { writeFileAtomically } from '../src/state/atomic-file.js';
import {
  loadTaskState,
  MAX_TASK_STATE_BYTES,
  saveTaskState,
  STATE_LOAD_FAILURE_CODES,
  type StateLoadFailureCode,
  type StateLoadResult,
} from '../src/state/state-store.js';
import { advanceTaskState } from '../src/state/advance-state.js';
import { fingerprint, validCreatedState, validUsageLimitState } from './fixtures.js';

const tempDirs: string[] = [];

/** A scratch directory standing in for a canonical repository root. */
function repoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ao-repo-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A state that belongs to `root`. */
function stateIn(root: string, overrides: Record<string, unknown> = {}) {
  return validCreatedState({ repositoryRoot: root, ...overrides });
}

/** A snapshot of every entry under a directory tree, for no-write assertions. */
function treeSnapshot(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`D ${full}`);
        walk(full);
      } else {
        out.push(`F ${full} ${readFileSync(full, 'utf8')}`);
      }
    }
  };
  walk(root);
  return out;
}

function locationIn(root: string, taskId = 'task-0001') {
  const location = deriveTaskStateLocation(root, taskId);
  if (!location.ok) throw new Error('unreachable');
  return location;
}

describe('task-state location', () => {
  it('places state inside the repository it describes', () => {
    const root = repoRoot();

    const location = locationIn(root);

    expect(isContained(root, location.path)).toBe(true);
    expect(location.directory).toBe(taskRuntimeDirectory(root));
    expect(location.directory.endsWith(TASK_RUNTIME_DIR_NAME)).toBe(true);
  });

  it('derives one deterministic file per task', () => {
    const root = repoRoot();

    const first = locationIn(root);
    const again = locationIn(root);

    expect(first.path).toBe(again.path);
    expect(first.fileName).toBe('task-0001.json');
    expect(dirname(first.path)).toBe(first.directory);
  });

  it('separates the same task id in two different repositories', () => {
    const alpha = locationIn(repoRoot());
    const beta = locationIn(repoRoot());

    expect(alpha.path).not.toBe(beta.path);
  });

  it('refuses a repository root that is not absolute, rather than resolving it', () => {
    const relative = deriveTaskStateLocation('some/relative/path', 'task-0001');

    expect(relative.ok).toBe(false);
    if (relative.ok) return;
    expect(relative.code).toBe('REPOSITORY_ROOT_UNSUITABLE');
  });

  it('refuses a task id that is not a single plain path segment', () => {
    const escaped = deriveTaskStateLocation(repoRoot(), '../../etc/passwd');

    expect(escaped.ok).toBe(false);
    if (escaped.ok) return;
    expect(escaped.code).toBe('TASK_ID_UNSUITABLE');
  });
});

/**
 * Every task id V1-02's grammar admits must have somewhere to live.
 *
 * The storage layer may refuse a *shape* — a separator, a traversal segment, an
 * absolute path — because those are not names at all. It may not refuse a
 * *length* the canonical grammar allows: a task the planner can select and the
 * worktree layer can prepare, but whose state cannot be written down, is a task
 * the orchestrator can start and never recover.
 */
describe('every canonical task id is persistable', () => {
  /** A canonical id of exactly `length` characters. */
  const idOfLength = (length: number): string => `t${'a'.repeat(length - 1)}`;

  it.each([
    ['the longest canonical id', MAX_TASK_ID_LENGTH],
    ['one below the longest', MAX_TASK_ID_LENGTH - 1],
    ['a typical id', 10],
  ])('derives a location for %s', (_label, length) => {
    const taskId = idOfLength(length);
    expect(isValidTaskId(taskId)).toBe(true);

    const location = deriveTaskStateLocation(repoRoot(), taskId);

    expect(location.ok).toBe(true);
    if (!location.ok) return;
    expect(location.fileName).toBe(`${taskId}.json`);
  });

  it('round-trips a state whose task id is the longest the grammar allows', () => {
    const root = repoRoot();
    const taskId = idOfLength(MAX_TASK_ID_LENGTH);

    const saved = saveTaskState(stateIn(root, { taskId }), { repositoryRoot: root });

    expect(saved.code).toBe('SAVED');
    const loaded = loadTaskState(root, taskId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.taskId).toBe(taskId);
  });

  it('refuses an id one character longer than the canonical grammar allows', () => {
    const tooLong = idOfLength(MAX_TASK_ID_LENGTH + 1);
    expect(isValidTaskId(tooLong)).toBe(false);

    const location = deriveTaskStateLocation(repoRoot(), tooLong);

    expect(location.ok).toBe(false);
    if (location.ok) return;
    expect(location.code).toBe('TASK_ID_UNSUITABLE');
  });

  it.each([
    ['a POSIX separator', 'tasks/task-0001'],
    ['a Windows separator', 'tasks\\task-0001'],
    ['a traversal segment', '..'],
    ['a traversal prefix', '../task-0001'],
    ['an absolute POSIX path', '/etc/passwd'],
    ['an absolute Windows path', 'C:\\Windows\\system32'],
    ['a trailing dot Windows would strip', 'task-0001.'],
    ['a reserved device name', 'NUL'],
    ['the empty string', ''],
  ])('still refuses %s', (_label, taskId) => {
    const location = deriveTaskStateLocation(repoRoot(), taskId);

    expect(location.ok).toBe(false);
    if (location.ok) return;
    expect(location.code).toBe('TASK_ID_UNSUITABLE');
  });

  it('keeps a long id contained in the repository it belongs to', () => {
    const root = repoRoot();

    const location = deriveTaskStateLocation(root, idOfLength(MAX_TASK_ID_LENGTH));

    expect(location.ok).toBe(true);
    if (!location.ok) return;
    expect(isContained(taskRuntimeDirectory(root), location.path)).toBe(true);
  });
});

/**
 * A persisted repository root is a *claim*, and a relative claim has no
 * meaning of its own. Resolving one would answer "is this the right
 * repository?" with "whichever directory the operator's shell was standing
 * in", which is the single authority this whole slice refuses.
 */
describe('persisted repository roots must be absolute', () => {
  /** Runs `body` with the process standing in `directory`. */
  function inDirectory<T>(directory: string, body: () => T): T {
    const previous = process.cwd();
    process.chdir(directory);
    try {
      return body();
    } finally {
      process.chdir(previous);
    }
  }

  it('refuses to save a state whose root is "." even when the cwd is that root', () => {
    const root = repoRoot();

    const saved = inDirectory(root, () =>
      saveTaskState(validCreatedState({ repositoryRoot: '.' }), { repositoryRoot: root }),
    );

    expect(saved.ok).toBe(false);
    expect(saved.code).toBe('REPOSITORY_ROOT_MISMATCH');
    expect(treeSnapshot(root)).toEqual([]);
  });

  it('refuses to load a state whose root is "." even when the cwd is that root', () => {
    const root = repoRoot();
    const location = locationIn(root);
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.path, JSON.stringify(validCreatedState({ repositoryRoot: '.' })));

    const loaded = inDirectory(root, () => loadTaskState(root, 'task-0001'));

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.code).toBe('REPOSITORY_ROOT_NOT_ABSOLUTE');
    expect(loaded.classification).toBe('STATE_INVALID');
  });

  it('refuses a relative persisted root that resolves somewhere else entirely', () => {
    const root = repoRoot();

    const saved = saveTaskState(validCreatedState({ repositoryRoot: 'somewhere/else' }), {
      repositoryRoot: root,
    });

    expect(saved.ok).toBe(false);
    expect(saved.code).toBe('REPOSITORY_ROOT_MISMATCH');
    expect(treeSnapshot(root)).toEqual([]);
  });

  it('still accepts two absolute spellings of the same directory', () => {
    const root = repoRoot();
    const spelling = process.platform === 'win32' ? root.replace(/\\/g, '/') : `${root}/`;

    const saved = saveTaskState(stateIn(root), { repositoryRoot: spelling });

    expect(saved.code).toBe('SAVED');
  });
});

describe('atomic file replacement', () => {
  it('creates a file that did not exist', () => {
    const dir = repoRoot();

    const result = writeFileAtomically({ directory: dir, fileName: 'state.json', contents: 'one' });

    expect(result.code).toBe('WRITTEN');
    expect(result.written).toBe(true);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe('one');
  });

  it('replaces an existing file, unlike the append-only run-artifact writer', () => {
    const dir = repoRoot();
    writeFileSync(join(dir, 'state.json'), 'old');

    const result = writeFileAtomically({
      directory: dir,
      fileName: 'state.json',
      contents: 'new',
    });

    expect(result.code).toBe('WRITTEN');
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe('new');
  });

  it('leaves no temporary file behind on success', () => {
    const dir = repoRoot();

    writeFileAtomically({ directory: dir, fileName: 'state.json', contents: 'one' });

    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('stages the temporary file in the target directory, so the replace cannot cross devices', () => {
    const dir = repoRoot();
    const staged: string[] = [];

    writeFileAtomically({
      directory: dir,
      fileName: 'state.json',
      contents: 'one',
      replace: (from, to) => {
        staged.push(from);
        expect(readFileSync(from, 'utf8')).toBe('one');
        writeFileSync(to, readFileSync(from));
      },
    });

    expect(staged).toHaveLength(1);
    expect(dirname(staged[0] as string)).toBe(dir);
  });

  it('keeps the previous content byte-for-byte when the replace fails', () => {
    const dir = repoRoot();
    writeFileSync(join(dir, 'state.json'), 'previous');

    const result = writeFileAtomically({
      directory: dir,
      fileName: 'state.json',
      contents: 'replacement',
      replace: () => {
        const error: NodeJS.ErrnoException = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    });

    expect(result.code).toBe('REPLACE_FAILED');
    expect(result.written).toBe(false);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe('previous');
  });

  it('removes the temporary file when the replace fails, leaving no residue', () => {
    const dir = repoRoot();
    writeFileSync(join(dir, 'state.json'), 'previous');

    writeFileAtomically({
      directory: dir,
      fileName: 'state.json',
      contents: 'replacement',
      replace: () => {
        const error: NodeJS.ErrnoException = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    });

    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('deletes only the temporary file it created, never one it merely found', () => {
    const dir = repoRoot();
    writeFileSync(join(dir, 'state.json'), 'previous');
    // Another writer's staging file, mid-flight. Not ours to tidy up.
    writeFileSync(join(dir, 'state.json.tmp-someone-else'), 'their work');

    writeFileAtomically({
      directory: dir,
      fileName: 'state.json',
      contents: 'replacement',
      replace: () => {
        const error: NodeJS.ErrnoException = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    });

    expect(readFileSync(join(dir, 'state.json.tmp-someone-else'), 'utf8')).toBe('their work');
  });

  it('refuses a file name that is not a single plain segment', () => {
    const dir = repoRoot();

    const result = writeFileAtomically({
      directory: dir,
      fileName: '../escape.json',
      contents: 'x',
    });

    expect(result.code).toBe('PATH_ESCAPES_DIRECTORY');
    expect(result.written).toBe(false);
  });

  it('refuses to write into a directory that does not exist', () => {
    const dir = join(repoRoot(), 'absent');

    const result = writeFileAtomically({ directory: dir, fileName: 'state.json', contents: 'x' });

    expect(result.code).toBe('DIRECTORY_UNUSABLE');
    expect(result.written).toBe(false);
  });
});

describe('saving task state', () => {
  it('persists a valid state and reads it back unchanged', () => {
    const root = repoRoot();
    const state = validUsageLimitState({ repositoryRoot: root });

    const saved = saveTaskState(state, { repositoryRoot: root });
    expect(saved.code).toBe('SAVED');

    const loaded = loadTaskState(root, 'task-0001');
    expect(loaded.code).toBe('LOADED');
    if (!loaded.ok) return;
    expect(loaded.state).toEqual(state);
  });

  it('creates the runtime directory it needs', () => {
    const root = repoRoot();

    const saved = saveTaskState(stateIn(root), { repositoryRoot: root });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(existsSync(saved.path)).toBe(true);
    expect(isContained(taskRuntimeDirectory(root), saved.path)).toBe(true);
  });

  it('refuses to persist a state that violates the contract', () => {
    const root = repoRoot();
    // READY_FOR_PR with no resolved base commit is rejected by TaskStateSchema.
    const invalid = stateIn(root, { state: 'READY_FOR_PR' });

    const saved = saveTaskState(invalid, { repositoryRoot: root });

    expect(saved.ok).toBe(false);
    expect(saved.code).toBe('STATE_CONTRACT_VIOLATION');
  });

  it('writes nothing at all when the state violates the contract', () => {
    const root = repoRoot();

    saveTaskState(stateIn(root, { state: 'READY_FOR_PR' }), { repositoryRoot: root });

    expect(treeSnapshot(root)).toEqual([]);
  });

  it('refuses to file a state under a repository it does not describe', () => {
    const alpha = repoRoot();
    const beta = repoRoot();

    const saved = saveTaskState(stateIn(alpha), { repositoryRoot: beta });

    expect(saved.ok).toBe(false);
    expect(saved.code).toBe('REPOSITORY_ROOT_MISMATCH');
    expect(treeSnapshot(beta)).toEqual([]);
  });

  it('keeps two repositories that use the same task id apart', () => {
    const alpha = repoRoot();
    const beta = repoRoot();

    saveTaskState(stateIn(alpha), { repositoryRoot: alpha });
    saveTaskState(stateIn(beta, { state: 'WORKTREE_READY' }), { repositoryRoot: beta });

    const loadedAlpha = loadTaskState(alpha, 'task-0001');
    const loadedBeta = loadTaskState(beta, 'task-0001');

    expect(loadedAlpha.ok && loadedBeta.ok).toBe(true);
    if (!loadedAlpha.ok || !loadedBeta.ok) return;
    expect(loadedAlpha.state.state).toBe('CREATED');
    expect(loadedBeta.state.state).toBe('WORKTREE_READY');
  });

  it('advances a checkpoint when the writer proves which revision it read', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const first = loadTaskState(root, 'task-0001');
    if (!first.ok) throw new Error('unreachable');

    const advanced = saveTaskState(stateIn(root, { state: 'WORKTREE_READY' }), {
      repositoryRoot: root,
      expectedRevision: first.revision,
    });

    expect(advanced.code).toBe('SAVED');
    const loaded = loadTaskState(root, 'task-0001');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('WORKTREE_READY');
  });
});

/**
 * Two orchestrator processes may be pointed at the same task. Neither is
 * expected to win a race — but the loser must *know* it lost, rather than
 * silently flattening the winner's work.
 */
describe('concurrent writers', () => {
  it('hands out a revision with every loaded state', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });

    const loaded = loadTaskState(root, 'task-0001');

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(typeof loaded.revision).toBe('string');
    expect(loaded.revision.length).toBeGreaterThan(0);
  });

  it('changes the revision when the state changes', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const first = loadTaskState(root, 'task-0001');
    if (!first.ok) throw new Error('unreachable');

    saveTaskState(stateIn(root, { state: 'WORKTREE_READY' }), {
      repositoryRoot: root,
      expectedRevision: first.revision,
    });
    const second = loadTaskState(root, 'task-0001');

    if (!second.ok) throw new Error('unreachable');
    expect(second.revision).not.toBe(first.revision);
  });

  it('refuses a blind write over a state that already exists', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });

    const blind = saveTaskState(stateIn(root, { state: 'WORKTREE_READY' }), {
      repositoryRoot: root,
    });

    expect(blind.ok).toBe(false);
    expect(blind.code).toBe('STATE_CONFLICT');
  });

  it('refuses a writer whose revision has been overtaken', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const stale = loadTaskState(root, 'task-0001');
    if (!stale.ok) throw new Error('unreachable');

    // A second writer advances the state in between.
    saveTaskState(stateIn(root, { state: 'WORKTREE_READY' }), {
      repositoryRoot: root,
      expectedRevision: stale.revision,
    });

    const overtaken = saveTaskState(stateIn(root, { state: 'CONFIG_VALIDATED' }), {
      repositoryRoot: root,
      expectedRevision: stale.revision,
    });

    expect(overtaken.ok).toBe(false);
    expect(overtaken.code).toBe('STATE_CONFLICT');
  });

  it('leaves the winner’s state intact when a stale writer is refused', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const stale = loadTaskState(root, 'task-0001');
    if (!stale.ok) throw new Error('unreachable');
    saveTaskState(stateIn(root, { state: 'WORKTREE_READY' }), {
      repositoryRoot: root,
      expectedRevision: stale.revision,
    });

    saveTaskState(stateIn(root, { state: 'CONFIG_VALIDATED' }), {
      repositoryRoot: root,
      expectedRevision: stale.revision,
    });

    const loaded = loadTaskState(root, 'task-0001');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('WORKTREE_READY');
  });

  it('refuses a revision-bearing write when no state exists at all', () => {
    const root = repoRoot();

    const orphaned = saveTaskState(stateIn(root), {
      repositoryRoot: root,
      expectedRevision: 'a-revision-that-never-existed',
    });

    expect(orphaned.ok).toBe(false);
    expect(orphaned.code).toBe('STATE_CONFLICT');
  });
});

/**
 * A persisted file is untrusted input, whoever wrote it. These are the
 * rejections that stand between a tampered, truncated or merely stale document
 * and a loop that acts on it.
 */
describe('loading is validation', () => {
  function writeRaw(root: string, contents: string): void {
    const location = locationIn(root);
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.path, contents);
  }

  it('classifies a task that was never persisted as missing', () => {
    expect(loadTaskState(repoRoot(), 'task-0001').classification).toBe('STATE_MISSING');
  });

  it('classifies a state that satisfies the contract as valid', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });

    expect(loadTaskState(root, 'task-0001').classification).toBe('STATE_VALID');
  });

  it.each([
    ['malformed JSON', () => '{ not json'],
    ['an unknown field', (root: string) => JSON.stringify({ ...stateIn(root), smuggled: 'x' })],
    [
      'an invalid state enum',
      (root: string) => JSON.stringify({ ...stateIn(root), state: 'NOT_A_STATE' }),
    ],
    [
      'an unsupported schemaVersion',
      (root: string) => JSON.stringify({ ...stateIn(root), schemaVersion: 99 }),
    ],
  ])('classifies %s as invalid', (_label, build) => {
    const root = repoRoot();
    writeRaw(root, build(root));

    const loaded = loadTaskState(root, 'task-0001');

    expect(loaded.ok).toBe(false);
    expect(loaded.classification).toBe('STATE_INVALID');
  });

  it('rejects a state document that belongs to a different repository', () => {
    const root = repoRoot();
    // Valid in itself, but it describes a different repository.
    writeRaw(root, JSON.stringify(validCreatedState({ repositoryRoot: repoRoot() })));

    const loaded = loadTaskState(root, 'task-0001');

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.code).toBe('REPOSITORY_ROOT_MISMATCH');
    // Not `STATE_INVALID`: the document is a perfectly well-formed state. What
    // is wrong is *whose* it is, and an operator needs to be told which.
    expect(loaded.classification).toBe('STATE_MISPLACED');
  });

  it('rejects a state document that belongs to a different task', () => {
    const root = repoRoot();
    writeRaw(root, JSON.stringify(validCreatedState({ repositoryRoot: root, taskId: 'task-0002' })));

    const loaded = loadTaskState(root, 'task-0001');

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.code).toBe('TASK_ID_MISMATCH');
    expect(loaded.classification).toBe('STATE_MISPLACED');
  });

  it('tells the two mismatches apart rather than collapsing them into one code', () => {
    const wrongRepository = repoRoot();
    writeRaw(
      wrongRepository,
      JSON.stringify(validCreatedState({ repositoryRoot: repoRoot() })),
    );
    const wrongTask = repoRoot();
    writeRaw(
      wrongTask,
      JSON.stringify(validCreatedState({ repositoryRoot: wrongTask, taskId: 'task-0002' })),
    );

    const byRepository = loadTaskState(wrongRepository, 'task-0001');
    const byTask = loadTaskState(wrongTask, 'task-0001');

    expect(byRepository.code).not.toBe(byTask.code);
  });

  it('produces every declared load failure code from a real document', () => {
    const produce: Readonly<Record<StateLoadFailureCode, () => StateLoadResult>> = {
      NO_STATE: () => loadTaskState(repoRoot(), 'task-0001'),
      LOCATION_UNSUITABLE: () => loadTaskState(repoRoot(), '../escape'),
      UNREADABLE: () => {
        const root = repoRoot();
        // A directory where the state file should be: it exists, and it cannot
        // be read as a document.
        mkdirSync(locationIn(root).path, { recursive: true });
        return loadTaskState(root, 'task-0001');
      },
      STATE_TOO_LARGE: () => {
        const root = repoRoot();
        writeRaw(root, 'x'.repeat(MAX_TASK_STATE_BYTES + 1));
        return loadTaskState(root, 'task-0001');
      },
      REPOSITORY_ROOT_MISMATCH: () => {
        const root = repoRoot();
        writeRaw(root, JSON.stringify(validCreatedState({ repositoryRoot: repoRoot() })));
        return loadTaskState(root, 'task-0001');
      },
      REPOSITORY_ROOT_NOT_ABSOLUTE: () => {
        const root = repoRoot();
        writeRaw(root, JSON.stringify(validCreatedState({ repositoryRoot: './somewhere' })));
        return loadTaskState(root, 'task-0001');
      },
      TASK_ID_MISMATCH: () => {
        const root = repoRoot();
        writeRaw(root, JSON.stringify(stateIn(root, { taskId: 'task-0002' })));
        return loadTaskState(root, 'task-0001');
      },
      MALFORMED_JSON: () => {
        const root = repoRoot();
        writeRaw(root, '{ not json');
        return loadTaskState(root, 'task-0001');
      },
      SCHEMA_VERSION_UNSUPPORTED: () => {
        const root = repoRoot();
        writeRaw(root, JSON.stringify({ ...stateIn(root), schemaVersion: 99 }));
        return loadTaskState(root, 'task-0001');
      },
      CONTRACT_VIOLATION: () => {
        const root = repoRoot();
        writeRaw(root, JSON.stringify({ ...stateIn(root), state: 'NOT_A_STATE' }));
        return loadTaskState(root, 'task-0001');
      },
    };

    expect(Object.keys(produce).sort()).toEqual([...STATE_LOAD_FAILURE_CODES].sort());
    for (const code of STATE_LOAD_FAILURE_CODES) {
      expect(produce[code]().code).toBe(code);
    }
  });

  it('rejects a state document that exceeds the read budget', () => {
    const root = repoRoot();
    writeRaw(root, 'x'.repeat(MAX_TASK_STATE_BYTES + 1));

    const loaded = loadTaskState(root, 'task-0001');

    expect(loaded.ok).toBe(false);
    expect(loaded.code).toBe('STATE_TOO_LARGE');
  });

  it('never surfaces parser or filesystem text in a load result', () => {
    const root = repoRoot();
    writeRaw(root, '{ "secret-marker-zz": ');

    const loaded = loadTaskState(root, 'task-0001');

    expect(JSON.stringify(loaded)).not.toContain('secret-marker-zz');
  });

  it('never repairs, migrates or deletes a corrupt state file', () => {
    const root = repoRoot();
    writeRaw(root, '{ this is not json');
    const before = treeSnapshot(root);

    loadTaskState(root, 'task-0001');

    expect(treeSnapshot(root)).toEqual(before);
  });

  it('never repairs a state that fails the contract', () => {
    const root = repoRoot();
    writeRaw(root, JSON.stringify({ ...stateIn(root), schemaVersion: 99 }));
    const before = treeSnapshot(root);

    loadTaskState(root, 'task-0001');

    expect(treeSnapshot(root)).toEqual(before);
  });
});

/**
 * One bounded, raw-byte contract for the persisted document.
 *
 * Two properties, and they are the same property seen from either side of the
 * disk:
 *
 *  - **nothing is written that could not be read back.** A schema-valid state
 *    can serialise past the read budget, and writing one produces a file this
 *    build refuses to load — a task checkpointed into permanent
 *    unrecoverability. The budget is therefore checked against the exact bytes
 *    that would be persisted, *before* any filesystem mutation.
 *  - **a revision identifies bytes, not text.** Decoding a file and re-encoding
 *    the decoded string collapses distinct byte sequences onto one digest,
 *    because every invalid sequence decodes to the same replacement character.
 *    Two files that differ on disk must never share a revision, or the compare-
 *    and-swap that protects a concurrent writer silently stops protecting it.
 */
describe('bounded raw bytes', () => {
  /** Writes exact bytes where `task-0001`'s state belongs. */
  function writeStateBytes(root: string, bytes: Buffer): void {
    const location = locationIn(root);
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.path, bytes);
  }

  /**
   * A schema-valid state whose serialised form exceeds the read budget.
   *
   * The bulk comes from the *number* of findings rather than the size of any one
   * of them, because `fingerprint` is now fixed at 32 characters. That is the
   * honest shape of the risk anyway: `findingHistory` is the one field that
   * grows without bound, and a fixed-width fingerprint is what makes the budget
   * arithmetic rather than hopeful — it does not make the array finite.
   */
  function oversizedState(root: string) {
    return stateIn(root, {
      maxReviewRounds: 3,
      findingHistory: Array.from({ length: 20_000 }, (_unused, index) => ({
        round: 1,
        severity: 'high' as const,
        fingerprint: fingerprint(index),
      })),
    });
  }

  /**
   * Two byte sequences that decode to the *same* string.
   *
   * `C0 80` is an overlong encoding and `ED A0 80` a surrogate half; neither is
   * valid UTF-8, so both decode to replacement characters — which is exactly
   * why a digest taken over decoded text cannot tell them apart.
   */
  const OVERLONG = Buffer.from([0xc0, 0x80, 0xc0, 0x80]);
  const SURROGATE_HALF = Buffer.from([0xed, 0xa0, 0x80, 0xed]);

  /**
   * The same document, with `marker` standing in for raw bytes.
   *
   * The bytes go in `baseBranch` rather than in a fingerprint: `fingerprint` is
   * now pinned to 32 lowercase hex characters, so a value carrying invalid UTF-8
   * would decode to replacement characters and be refused by the contract before
   * the revision could be compared at all. `baseBranch` is still a plain
   * non-blank string at this layer — `reconcile.ts` is what judges it against the
   * repository — which is exactly the property this case needs: a field where
   * two byte-distinct documents can decode to one identical string.
   */
  function documentWith(root: string, raw: Buffer): Buffer {
    const text = JSON.stringify(
      stateIn(root, { maxReviewRounds: 3, baseBranch: '@@RAW@@' }),
      null,
      2,
    );
    const [before, after] = text.split('@@RAW@@');
    return Buffer.concat([
      Buffer.from(before as string, 'utf8'),
      raw,
      Buffer.from(after as string, 'utf8'),
    ]);
  }

  it('refuses to persist a schema-valid state that serialises past the budget', () => {
    const root = repoRoot();

    const saved = saveTaskState(oversizedState(root), { repositoryRoot: root });

    expect(saved.ok).toBe(false);
    expect(saved.code).toBe('STATE_TOO_LARGE');
  });

  it('writes nothing at all — not even a staging file — when the state is oversize', () => {
    const root = repoRoot();

    saveTaskState(oversizedState(root), { repositoryRoot: root });

    expect(treeSnapshot(root)).toEqual([]);
  });

  it('never writes a state this build would then refuse to load', () => {
    const root = repoRoot();

    const saved = saveTaskState(oversizedState(root), { repositoryRoot: root });

    expect(saved.ok).toBe(false);
    expect(loadTaskState(root, 'task-0001').code).toBe('NO_STATE');
  });

  it('refuses a compare-and-swap against an oversize state instead of reading it', () => {
    const root = repoRoot();
    writeStateBytes(root, Buffer.alloc(MAX_TASK_STATE_BYTES + 1, 0x20));

    const saved = saveTaskState(stateIn(root), {
      repositoryRoot: root,
      expectedRevision: 'a-revision-from-somewhere',
    });

    expect(saved.ok).toBe(false);
    expect(saved.code).toBe('STATE_CONFLICT');
    if (saved.ok) return;
    expect(saved.detail).toBe('CURRENT_STATE_TOO_LARGE');
  });

  it('leaves an oversize state exactly where it was', () => {
    const root = repoRoot();
    writeStateBytes(root, Buffer.alloc(MAX_TASK_STATE_BYTES + 1, 0x20));
    const before = treeSnapshot(root);

    saveTaskState(stateIn(root), { repositoryRoot: root, expectedRevision: 'anything' });

    expect(treeSnapshot(root)).toEqual(before);
  });

  it('gives two byte-distinct documents two distinct revisions', () => {
    const first = repoRoot();
    const second = repoRoot();
    const a = documentWith(first, OVERLONG);
    const b = documentWith(second, SURROGATE_HALF);
    // The premise: different bytes on disk, identical once decoded.
    expect(a.equals(b.subarray(0, a.length))).toBe(false);
    writeStateBytes(first, a);
    writeStateBytes(second, b);

    const loadedA = loadTaskState(first, 'task-0001');
    const loadedB = loadTaskState(second, 'task-0001');

    expect(loadedA.ok && loadedB.ok).toBe(true);
    if (!loadedA.ok || !loadedB.ok) return;
    expect(loadedA.state.baseBranch).toBe(loadedB.state.baseBranch);
    expect(loadedA.revision).not.toBe(loadedB.revision);
  });

  it('refuses a writer whose revision came from bytes another writer replaced', () => {
    const root = repoRoot();
    writeStateBytes(root, documentWith(root, OVERLONG));
    const held = loadTaskState(root, 'task-0001');
    if (!held.ok) throw new Error('unreachable');

    // A second writer lands bytes that decode to the very same state.
    const landed = documentWith(root, SURROGATE_HALF);
    writeStateBytes(root, landed);

    const overtaken = saveTaskState(stateIn(root, { state: 'REPOSITORY_RESOLVED' }), {
      repositoryRoot: root,
      expectedRevision: held.revision,
    });

    expect(overtaken.ok).toBe(false);
    expect(overtaken.code).toBe('STATE_CONFLICT');
    expect(readFileSync(locationIn(root).path).equals(landed)).toBe(true);
  });

  it('hashes the bytes on disk, not the bytes it would have written', () => {
    const root = repoRoot();
    // Byte-identical content, spelled with different whitespace: a digest taken
    // over a re-serialised value would call these the same revision.
    const compact = Buffer.from(`${JSON.stringify(stateIn(root))}\n`, 'utf8');
    writeStateBytes(root, compact);
    const loaded = loadTaskState(root, 'task-0001');
    if (!loaded.ok) throw new Error('unreachable');

    expect(loaded.revision).toBe(createHash('sha256').update(compact).digest('hex'));
  });
});

/**
 * The persistence primitive later runtime code calls to *move* a task.
 *
 * V1-04 implements no loop. What it owes V1-05 is a way to advance a task that
 * cannot be used to invent an edge: the transition table stays the single
 * authority on which states follow which, and this helper consults it rather
 * than restating it.
 */
describe('advancing a task through the transition contract', () => {
  it('persists a move along a declared edge', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const current = loadTaskState(root, 'task-0001');
    if (!current.ok) throw new Error('unreachable');

    const advanced = advanceTaskState(current, stateIn(root, { state: 'REPOSITORY_RESOLVED' }), {
      repositoryRoot: root,
    });

    expect(advanced.code).toBe('SAVED');
    const loaded = loadTaskState(root, 'task-0001');
    if (!loaded.ok) throw new Error('unreachable');
    expect(loaded.state.state).toBe('REPOSITORY_RESOLVED');
  });

  it('refuses an edge the transition table does not declare', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const current = loadTaskState(root, 'task-0001');
    if (!current.ok) throw new Error('unreachable');

    // CREATED does not reach IMPLEMENTING: the setup chain has to happen first.
    const jumped = advanceTaskState(current, stateIn(root, { state: 'IMPLEMENTING' }), {
      repositoryRoot: root,
    });

    expect(jumped.ok).toBe(false);
    expect(jumped.code).toBe('ILLEGAL_TRANSITION');
  });

  it('leaves the persisted state untouched when the edge is refused', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const current = loadTaskState(root, 'task-0001');
    if (!current.ok) throw new Error('unreachable');

    advanceTaskState(current, stateIn(root, { state: 'IMPLEMENTING' }), { repositoryRoot: root });

    const loaded = loadTaskState(root, 'task-0001');
    if (!loaded.ok) throw new Error('unreachable');
    expect(loaded.state.state).toBe('CREATED');
  });

  it('refuses to move out of a terminal state', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root, { state: 'ABORTED' }), { repositoryRoot: root });
    const current = loadTaskState(root, 'task-0001');
    if (!current.ok) throw new Error('unreachable');

    const revived = advanceTaskState(current, stateIn(root, { state: 'IMPLEMENTING' }), {
      repositoryRoot: root,
    });

    expect(revived.ok).toBe(false);
    expect(revived.code).toBe('ILLEGAL_TRANSITION');
  });

  it('allows re-persisting the same state, which is a checkpoint and not a move', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const current = loadTaskState(root, 'task-0001');
    if (!current.ok) throw new Error('unreachable');

    const checkpoint = advanceTaskState(
      current,
      stateIn(root, { stateEnteredAt: '2026-07-31T11:00:00.000Z' }),
      { repositoryRoot: root },
    );

    expect(checkpoint.code).toBe('SAVED');
  });

  it('still refuses a writer whose revision was overtaken', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const stale = loadTaskState(root, 'task-0001');
    if (!stale.ok) throw new Error('unreachable');
    advanceTaskState(stale, stateIn(root, { state: 'REPOSITORY_RESOLVED' }), {
      repositoryRoot: root,
    });

    const overtaken = advanceTaskState(stale, stateIn(root, { state: 'ABORTED' }), {
      repositoryRoot: root,
    });

    expect(overtaken.ok).toBe(false);
    expect(overtaken.code).toBe('STATE_CONFLICT');
  });
});

describe('crash safety', () => {
  it('still loads the last complete checkpoint after a crash left a temporary file', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const location = locationIn(root);

    // What a process killed between "write temp" and "rename" leaves behind.
    writeFileSync(join(location.directory, 'task-0001.json.tmp-dead'), '{ half a stat');

    const loaded = loadTaskState(root, 'task-0001');

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('CREATED');
  });

  it('keeps the last complete checkpoint when the next save fails to replace it', () => {
    const root = repoRoot();
    saveTaskState(stateIn(root), { repositoryRoot: root });
    const first = loadTaskState(root, 'task-0001');
    if (!first.ok) throw new Error('unreachable');

    const failed = saveTaskState(stateIn(root, { state: 'WORKTREE_READY' }), {
      repositoryRoot: root,
      expectedRevision: first.revision,
      replace: () => {
        const error: NodeJS.ErrnoException = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    });

    expect(failed.ok).toBe(false);
    const loaded = loadTaskState(root, 'task-0001');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('CREATED');
  });
});
