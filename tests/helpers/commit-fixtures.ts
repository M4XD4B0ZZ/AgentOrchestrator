/**
 * Real repositories for the AO-owned commit (DOGFOOD-REM-001 Task 3).
 *
 * Everything the *product* does goes through `runGitCommand`; everything the
 * *fixture* does goes through `execFileSync`. That split is not cosmetic. Half
 * of what these cases set up — a filter command containing spaces, a
 * repository-local `user.email`, a hook file — is deliberately not expressible
 * through the production seam, and a helper that reached for the seam anyway
 * would be testing the seam's argument grammar instead of the commit path.
 *
 * No repository here is given a `user.name`/`user.email` unless a case asks for
 * one. That is the counter-control for G11: a fixture that quietly configured an
 * identity would make every identity assertion vacuous.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runGitCommand, type GitCommandResult, type GitRunner } from '../../src/worktree/git-command.js';

const created: string[] = [];

/** Removes every scratch repository this file created. */
export function removeCommitFixtures(): void {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked Git file on Windows must not fail an otherwise passing suite.
    }
  }
}

/** Setup only. Never the measured path. */
export function setupGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function writeIn(root: string, relativePath: string, contents: string, mode?: number): void {
  const target = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) });
}

export interface ScratchWorktree {
  /** The directory every measured command runs in. */
  readonly worktreePath: string;
  /** HEAD before the pass under test — the base the delta is measured from. */
  readonly head: string;
}

/**
 * A repository with one commit, `src/work.ts` tracked, and — unless asked
 * otherwise — **no identity configured at all**.
 *
 * The base commit is made with `-c` rather than by configuring the repository,
 * so "this repository has no `user.email`" stays literally true and the G11
 * counter-control has something to assert.
 */
export function scratchWorktree(options: { readonly identity?: 'none' | 'foreign' } = {}): ScratchWorktree {
  const worktreePath = mkdtempSync(join(tmpdir(), 'ao-commit-fixture-'));
  created.push(worktreePath);

  setupGit(worktreePath, ['init', '-b', 'main', '--quiet']);
  // The fixture's own bytes are its own business; no autocrlf rewriting.
  writeIn(worktreePath, '.gitattributes', '* -text\n');
  writeIn(worktreePath, 'src/work.ts', 'BASE\n');
  setupGit(worktreePath, ['add', '--all']);
  setupGit(worktreePath, [
    '-c', 'user.name=fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'base',
  ]);
  if (options.identity === 'foreign') {
    setupGit(worktreePath, ['config', 'user.name', 'SomebodyElse']);
    setupGit(worktreePath, ['config', 'user.email', 'somebody@example.com']);
  }
  return { worktreePath, head: setupGit(worktreePath, ['rev-parse', 'HEAD']).trim() };
}

/* ─────────────────────────── reading the result ─────────────────────────── */

export function headOf(worktreePath: string): string {
  return setupGit(worktreePath, ['rev-parse', 'HEAD']).trim();
}

export function porcelainOf(worktreePath: string): string {
  return setupGit(worktreePath, ['status', '--porcelain']).trim();
}

/** The commit object, verbatim. `--format=%…` is not expressible through the seam. */
function objectOf(worktreePath: string, commit: string): string {
  return setupGit(worktreePath, ['cat-file', 'commit', commit]);
}

export function subjectOf(worktreePath: string, commit: string): string {
  const body = objectOf(worktreePath, commit).split('\n\n').slice(1).join('\n\n');
  return body.trim();
}

function identityLine(worktreePath: string, commit: string, kind: 'author' | 'committer') {
  const line = objectOf(worktreePath, commit)
    .split('\n')
    .find((candidate) => candidate.startsWith(`${kind} `));
  const match = /^\w+ (.+) <(.+)> \d+ [+-]\d{4}$/.exec(line ?? '');
  return { name: match?.[1] ?? '', email: match?.[2] ?? '' };
}

export function authorOf(worktreePath: string, commit: string) {
  return identityLine(worktreePath, commit, 'author');
}

export function committerOf(worktreePath: string, commit: string) {
  return identityLine(worktreePath, commit, 'committer');
}

/** `true` when the object carries a signature header. */
export function isSigned(worktreePath: string, commit: string): boolean {
  return objectOf(worktreePath, commit).split('\n\n')[0]?.includes('gpgsig') === true;
}

/**
 * A value **this repository** defines, or `null` when it defines none.
 *
 * `--local` deliberately. The question these cases ask is "has this repository
 * been given an identity", and the ambient answer on a developer machine is
 * always yes: measured, the production seam forwards `PATH`/`PATHEXT` only and
 * Git still resolves the operator's global `~/.gitconfig` through it. Nothing
 * here clears that — the whole point of the leak control is that the commit is
 * made on a machine which does have an identity to leak, and it must still not
 * appear in the object.
 */
export function configOf(worktreePath: string, key: string): string | null {
  try {
    return setupGit(worktreePath, ['config', '--local', '--get', key]).trim();
  } catch {
    return null;
  }
}

/** The paths one commit introduced, relative to a base. */
export function pathsInCommit(worktreePath: string, base: string, commit: string): string[] {
  return setupGit(worktreePath, ['diff', '--name-only', base, commit])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

/* ───────────────────────── the injection mechanisms ─────────────────────── */

/**
 * A hook, in the shell Git for Windows runs hooks in.
 *
 * Written through the fixture rather than the seam: a hook body is a shell
 * script, which is exactly the kind of text the production argument grammar
 * exists to keep out of a command line.
 */
export function writeHook(worktreePath: string, name: string, body: string): void {
  writeIn(worktreePath, `.git/hooks/${name}`, `#!/bin/sh\n${body}\nexit 0\n`, 0o755);
}

/** A hook body that adds a file to the commit it is running for. */
export function addsFile(path: string): string {
  return `mkdir -p "$(dirname "${path}")" && echo injected > "${path}" && git add "${path}"`;
}

/** A hook body that leaves a mark outside the object. */
export function touches(path: string): string {
  return `echo ran > "${path}"`;
}

/**
 * A clean filter that proves it ran and rewrites the bytes on the way in.
 *
 * Configured through the fixture, because the command contains spaces and the
 * production seam would refuse it as an argument — which is itself the reason
 * AO can never *install* such a thing, only meet one.
 */
export function configureCleanFilter(worktreePath: string, driver = 'probe', scope: 'local' | 'worktree' = 'local'): void {
  const command = 'sh -c "echo ran > .filter-ran; sed s/BASE/MANGLED/"';
  const args = scope === 'worktree'
    ? ['config', '--worktree', `filter.${driver}.clean`, command]
    : ['config', `filter.${driver}.clean`, command];
  setupGit(worktreePath, args);
}

/* ─────────────────────────────── the seam ───────────────────────────────── */

export interface RecordingGit {
  readonly runner: GitRunner;
  readonly calls: { readonly cwd: string; readonly args: readonly string[] }[];
}

/**
 * The production runner, with every argument vector it was handed recorded.
 *
 * The argv *is* the property for `--name-only`: "the configured command never
 * enters this process" is a statement about what was asked, and no assertion on
 * a return value can make it.
 */
export function recordingGit(inner: GitRunner = runGitCommand): RecordingGit {
  const calls: { cwd: string; args: readonly string[] }[] = [];
  const runner: GitRunner = async (cwd, args): Promise<GitCommandResult> => {
    calls.push({ cwd, args: [...args] });
    return inner(cwd, args);
  };
  return { runner, calls };
}
