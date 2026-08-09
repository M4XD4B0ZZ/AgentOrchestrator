/**
 * V1-04: durable task-state persistence.
 *
 * The properties under test are the ones a restart depends on:
 *
 *  - a state file is located deterministically from *validated* identity, never
 *    from `process.cwd()` and never from unvalidated repository-authored text;
 *  - a write either lands in full or leaves the previous state byte-for-byte
 *    intact — there is no window in which the file on disk is half a state;
 *  - loading validates against the binding contract and reports every way it
 *    can fail as data;
 *  - loading **never writes**. A corrupt or stale state is reported, never
 *    repaired, never migrated, never deleted.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { isContained } from '../src/doctor/safe-write.js';
import {
  deriveTaskStateLocation,
  taskStateRoot,
  TASK_STATE_DIR_NAME,
} from '../src/state/state-location.js';
import { writeFileAtomically } from '../src/state/atomic-file.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { validCreatedState, validUsageLimitState } from './fixtures.js';

const tempDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ao-state-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

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

describe('task-state location', () => {
  it('places state under the orchestrator home, never relative to the CWD', () => {
    const home = scratch();
    const provider = fixedPathProvider(home);

    const root = taskStateRoot(provider);

    expect(isContained(home, root)).toBe(true);
    expect(root.endsWith(TASK_STATE_DIR_NAME)).toBe(true);
  });

  it('derives one deterministic file per repository and task', () => {
    const provider = fixedPathProvider(scratch());

    const first = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);
    const again = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);

    expect(first.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.path).toBe(again.path);
    expect(first.fileName).toBe('task-0001.json');
    expect(dirname(first.path)).toBe(first.directory);
  });

  it('separates the same task id in two different repositories', () => {
    const provider = fixedPathProvider(scratch());

    const alpha = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);
    const beta = deriveTaskStateLocation('repo-beta', 'task-0001', provider);

    expect(alpha.ok && beta.ok).toBe(true);
    if (!alpha.ok || !beta.ok) return;
    expect(alpha.path).not.toBe(beta.path);
  });

  it('refuses a repository id that is not a single plain path segment', () => {
    const provider = fixedPathProvider(scratch());

    const escaped = deriveTaskStateLocation('../../etc', 'task-0001', provider);

    expect(escaped.ok).toBe(false);
    if (escaped.ok) return;
    expect(escaped.code).toBe('REPOSITORY_ID_UNSUITABLE');
  });

  it('refuses a task id that is not a single plain path segment', () => {
    const provider = fixedPathProvider(scratch());

    const escaped = deriveTaskStateLocation('repo-alpha', 'a/b', provider);

    expect(escaped.ok).toBe(false);
    if (escaped.ok) return;
    expect(escaped.code).toBe('TASK_ID_UNSUITABLE');
  });
});

describe('atomic file replacement', () => {
  it('creates a file that did not exist', () => {
    const dir = scratch();

    const result = writeFileAtomically({ directory: dir, fileName: 'state.json', contents: 'one' });

    expect(result.code).toBe('WRITTEN');
    expect(result.written).toBe(true);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe('one');
  });

  it('replaces an existing file, unlike the append-only run-artifact writer', () => {
    const dir = scratch();
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
    const dir = scratch();

    writeFileAtomically({ directory: dir, fileName: 'state.json', contents: 'one' });

    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('stages the temporary file in the target directory, so the replace cannot cross devices', () => {
    const dir = scratch();
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
    const dir = scratch();
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
    const dir = scratch();
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

  it('refuses a file name that is not a single plain segment', () => {
    const dir = scratch();

    const result = writeFileAtomically({
      directory: dir,
      fileName: '../escape.json',
      contents: 'x',
    });

    expect(result.code).toBe('PATH_ESCAPES_DIRECTORY');
    expect(result.written).toBe(false);
  });

  it('refuses to write into a directory that does not exist', () => {
    const dir = join(scratch(), 'absent');

    const result = writeFileAtomically({ directory: dir, fileName: 'state.json', contents: 'x' });

    expect(result.code).toBe('DIRECTORY_UNUSABLE');
    expect(result.written).toBe(false);
  });
});

describe('saving task state', () => {
  it('persists a valid state and reads it back unchanged', () => {
    const provider = fixedPathProvider(scratch());
    const state = validUsageLimitState();

    const saved = saveTaskState(state, { provider });
    expect(saved.code).toBe('SAVED');

    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });
    expect(loaded.code).toBe('LOADED');
    if (!loaded.ok) return;
    expect(loaded.state).toEqual(state);
  });

  it('creates the state directory it needs', () => {
    const home = scratch();
    const provider = fixedPathProvider(home);

    const saved = saveTaskState(validCreatedState(), { provider });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(existsSync(saved.path)).toBe(true);
    expect(isContained(taskStateRoot(provider), saved.path)).toBe(true);
  });

  it('refuses to persist a state that violates the contract', () => {
    const provider = fixedPathProvider(scratch());
    // READY_FOR_PR with no resolved base commit is rejected by TaskStateSchema.
    const invalid = validCreatedState({ state: 'READY_FOR_PR' });

    const saved = saveTaskState(invalid, { provider });

    expect(saved.ok).toBe(false);
    expect(saved.code).toBe('STATE_CONTRACT_VIOLATION');
  });

  it('writes nothing at all when the state violates the contract', () => {
    const home = scratch();
    const provider = fixedPathProvider(home);

    saveTaskState(validCreatedState({ state: 'READY_FOR_PR' }), { provider });

    expect(treeSnapshot(home)).toEqual([]);
  });

  it('keeps two repositories that use the same task id apart', () => {
    const provider = fixedPathProvider(scratch());

    saveTaskState(validCreatedState({ repositoryId: 'repo-alpha' }), { provider });
    saveTaskState(
      validCreatedState({ repositoryId: 'repo-beta', state: 'WORKTREE_READY' }),
      { provider },
    );

    const alpha = loadTaskState('repo-alpha', 'task-0001', { provider });
    const beta = loadTaskState('repo-beta', 'task-0001', { provider });

    expect(alpha.ok && beta.ok).toBe(true);
    if (!alpha.ok || !beta.ok) return;
    expect(alpha.state.state).toBe('CREATED');
    expect(beta.state.state).toBe('WORKTREE_READY');
  });

  it('advances a checkpoint when the writer proves which revision it read', () => {
    const provider = fixedPathProvider(scratch());
    saveTaskState(validCreatedState(), { provider });
    const first = loadTaskState('repo-alpha', 'task-0001', { provider });
    if (!first.ok) throw new Error('unreachable');

    const advanced = saveTaskState(validCreatedState({ state: 'WORKTREE_READY' }), {
      provider,
      expectedRevision: first.revision,
    });

    expect(advanced.code).toBe('SAVED');
    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('WORKTREE_READY');
  });
});

/**
 * Two orchestrator processes may be pointed at the same task. Neither is
 * expected to win a race — but the loser must *know* it lost, rather than
 * silently flattening the winner's work.
 *
 * The mechanism is optimistic compare-before-replace: a writer names the
 * revision it read, and the store refuses if the file has moved on.
 */
describe('concurrent writers', () => {
  it('hands out a revision with every loaded state', () => {
    const provider = fixedPathProvider(scratch());
    saveTaskState(validCreatedState(), { provider });

    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(typeof loaded.revision).toBe('string');
    expect(loaded.revision.length).toBeGreaterThan(0);
  });

  it('changes the revision when the state changes', () => {
    const provider = fixedPathProvider(scratch());
    saveTaskState(validCreatedState(), { provider });
    const first = loadTaskState('repo-alpha', 'task-0001', { provider });
    if (!first.ok) throw new Error('unreachable');

    saveTaskState(validCreatedState({ state: 'WORKTREE_READY' }), {
      provider,
      expectedRevision: first.revision,
    });
    const second = loadTaskState('repo-alpha', 'task-0001', { provider });

    if (!second.ok) throw new Error('unreachable');
    expect(second.revision).not.toBe(first.revision);
  });

  it('refuses a blind write over a state that already exists', () => {
    const provider = fixedPathProvider(scratch());
    saveTaskState(validCreatedState(), { provider });

    const blind = saveTaskState(validCreatedState({ state: 'WORKTREE_READY' }), { provider });

    expect(blind.ok).toBe(false);
    expect(blind.code).toBe('STATE_CONFLICT');
  });

  it('refuses a writer whose revision has been overtaken', () => {
    const provider = fixedPathProvider(scratch());
    saveTaskState(validCreatedState(), { provider });
    const stale = loadTaskState('repo-alpha', 'task-0001', { provider });
    if (!stale.ok) throw new Error('unreachable');

    // A second writer advances the state in between.
    saveTaskState(validCreatedState({ state: 'WORKTREE_READY' }), {
      provider,
      expectedRevision: stale.revision,
    });

    const overtaken = saveTaskState(validCreatedState({ state: 'CONFIG_VALIDATED' }), {
      provider,
      expectedRevision: stale.revision,
    });

    expect(overtaken.ok).toBe(false);
    expect(overtaken.code).toBe('STATE_CONFLICT');
  });

  it('leaves the winner’s state intact when a stale writer is refused', () => {
    const provider = fixedPathProvider(scratch());
    saveTaskState(validCreatedState(), { provider });
    const stale = loadTaskState('repo-alpha', 'task-0001', { provider });
    if (!stale.ok) throw new Error('unreachable');
    saveTaskState(validCreatedState({ state: 'WORKTREE_READY' }), {
      provider,
      expectedRevision: stale.revision,
    });

    saveTaskState(validCreatedState({ state: 'CONFIG_VALIDATED' }), {
      provider,
      expectedRevision: stale.revision,
    });

    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('WORKTREE_READY');
  });

  it('refuses a revision-bearing write when no state exists at all', () => {
    const provider = fixedPathProvider(scratch());

    const orphaned = saveTaskState(validCreatedState(), {
      provider,
      expectedRevision: 'a-revision-that-never-existed',
    });

    expect(orphaned.ok).toBe(false);
    expect(orphaned.code).toBe('STATE_CONFLICT');
  });
});

describe('loading task state', () => {
  it('reports a task that was never persisted, rather than inventing one', () => {
    const provider = fixedPathProvider(scratch());

    const loaded = loadTaskState('repo-alpha', 'never-written', { provider });

    expect(loaded.ok).toBe(false);
    expect(loaded.code).toBe('NO_STATE');
  });

  it('reports a state file that is not JSON', () => {
    const provider = fixedPathProvider(scratch());
    const location = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);
    if (!location.ok) throw new Error('unreachable');
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.path, '{ this is not json');

    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });

    expect(loaded.ok).toBe(false);
    expect(loaded.code).toBe('MALFORMED_JSON');
  });

  it('reports a state file that is JSON but violates the contract', () => {
    const provider = fixedPathProvider(scratch());
    const location = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);
    if (!location.ok) throw new Error('unreachable');
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.path, JSON.stringify({ ...validCreatedState(), state: 'NOT_A_STATE' }));

    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });

    expect(loaded.ok).toBe(false);
    expect(loaded.code).toBe('CONTRACT_VIOLATION');
  });

  it('reports a state written by an unsupported contract version', () => {
    const provider = fixedPathProvider(scratch());
    const location = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);
    if (!location.ok) throw new Error('unreachable');
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.path, JSON.stringify({ ...validCreatedState(), schemaVersion: 99 }));

    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });

    expect(loaded.ok).toBe(false);
    expect(loaded.code).toBe('SCHEMA_VERSION_UNSUPPORTED');
  });

  it('never repairs, migrates or deletes a corrupt state file', () => {
    const home = scratch();
    const provider = fixedPathProvider(home);
    const location = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);
    if (!location.ok) throw new Error('unreachable');
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.path, '{ this is not json');
    const before = treeSnapshot(home);

    loadTaskState('repo-alpha', 'task-0001', { provider });

    expect(treeSnapshot(home)).toEqual(before);
  });

  it('never repairs a state that fails the contract', () => {
    const home = scratch();
    const provider = fixedPathProvider(home);
    const location = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);
    if (!location.ok) throw new Error('unreachable');
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.path, JSON.stringify({ ...validCreatedState(), schemaVersion: 99 }));
    const before = treeSnapshot(home);

    loadTaskState('repo-alpha', 'task-0001', { provider });

    expect(treeSnapshot(home)).toEqual(before);
  });
});

describe('crash safety', () => {
  it('still loads the last complete checkpoint after a crash left a temporary file', () => {
    const provider = fixedPathProvider(scratch());
    saveTaskState(validCreatedState(), { provider });
    const location = deriveTaskStateLocation('repo-alpha', 'task-0001', provider);
    if (!location.ok) throw new Error('unreachable');

    // What a process killed between "write temp" and "rename" leaves behind.
    writeFileSync(join(location.directory, 'task-0001.json.tmp-dead'), '{ half a stat');

    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('CREATED');
  });

  it('keeps the last complete checkpoint when the next save fails to replace it', () => {
    const provider = fixedPathProvider(scratch());
    saveTaskState(validCreatedState(), { provider });
    const first = loadTaskState('repo-alpha', 'task-0001', { provider });
    if (!first.ok) throw new Error('unreachable');

    const failed = saveTaskState(validCreatedState({ state: 'WORKTREE_READY' }), {
      provider,
      expectedRevision: first.revision,
      replace: () => {
        const error: NodeJS.ErrnoException = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    });

    expect(failed.ok).toBe(false);
    const loaded = loadTaskState('repo-alpha', 'task-0001', { provider });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.state).toBe('CREATED');
  });
});
