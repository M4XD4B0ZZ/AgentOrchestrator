/**
 * Real, throwaway Git repositories for the repository-resolution tests.
 *
 * V1-01 must work against *any* repository, so nothing here is derived from the
 * orchestrator's own checkout: every fixture is a fresh `git init` under the OS
 * temp directory, with its own default branch, its own profile and its own
 * policy. Two fixtures that differ in every policy field are the evidence that
 * the resolver carries no project-specific knowledge.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The fixture's own Git environment. Explicit identity and a cleared global
 * config so a developer's `~/.gitconfig` cannot change what a fixture is.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const created: string[] = [];

/** Removes every fixture created so far. Safe to call from `afterAll`. */
export function removeRepoFixtures(): void {
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

export interface RepoFixtureOptions {
  /** Branch the fixture's first commit lands on. */
  readonly defaultBranch: string;
  /** Raw profile bytes, or `null` to create no profile file at all. */
  readonly profile: string | null;
  /** Create a `.codegraph/` index directory at the repository root. */
  readonly codegraphIndex?: boolean;
  /** Add a local file remote, so the no-remote default can be contrasted. */
  readonly remote?: boolean;
  /** Extra files, keyed by repo-relative POSIX path. */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * Object name format. Omitted means Git's default, which is `sha1` on the
   * installed build; `sha256` exists so a reader that parses object names can be
   * asked the 64-character question a SHA-1 fixture cannot pose.
   */
  readonly objectFormat?: 'sha256';
}

/** The canonical location of a repository profile. Duplicated deliberately:
 *  a test that imported the constant could not detect the constant changing. */
export const FIXTURE_PROFILE_RELATIVE_PATH = '.agent-orchestrator/repo-profile.yaml';

export function writeRepoFile(root: string, relativePath: string, contents: string): void {
  const target = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

/** Creates a real Git repository and returns its canonical absolute root. */
export function createRepoFixture(options: RepoFixtureOptions): string {
  const raw = mkdtempSync(join(tmpdir(), 'ao-repo-fixture-'));
  created.push(raw);
  const root = realpathSync.native(raw);

  git(root, [
    'init',
    '-b',
    options.defaultBranch,
    '--quiet',
    ...(options.objectFormat === undefined ? [] : [`--object-format=${options.objectFormat}`]),
  ]);

  // Line endings are the fixture's own business, not the host's.
  //
  // `GIT_ENV` above clears the global and system config so a developer's
  // settings cannot change what a fixture *is*. That covers every Git command
  // this file runs — and not the ones the **product** runs: `runGitCommand`
  // forwards `PATH` and `PATHEXT` only, so it inherits the machine's config, and
  // on a Windows box with a system-wide `core.autocrlf=true` the production
  // `git worktree add` checks out CRLF files into a tree whose blobs are LF.
  //
  // A test writer that then commits through this file's `git()` stores those
  // CRLF bytes verbatim, and every text file in the repository becomes a
  // genuine content change — attributed, correctly but uselessly, to the
  // writing agent. Whether it happens at all depends on Git's stat cache, so it
  // is flaky rather than merely wrong.
  //
  // `* -text` turns the conversion off for both sides at once, in the
  // repository itself, where neither config can override it. It is also the
  // honest declaration for a fixture: these bytes are the test's input, and
  // nothing may rewrite them on the way to disk. A caller that wants to test
  // conversion supplies its own `.gitattributes` through `files`.
  writeRepoFile(root, '.gitattributes', '* -text\n');

  writeRepoFile(root, 'README.md', `# fixture on ${options.defaultBranch}\n`);
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    writeRepoFile(root, path, contents);
  }
  if (options.profile !== null) {
    writeRepoFile(root, FIXTURE_PROFILE_RELATIVE_PATH, options.profile);
  }
  if (options.codegraphIndex === true) {
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    writeFileSync(join(root, '.codegraph', 'index.db'), 'fixture', 'utf8');
  }

  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);

  if (options.remote === true) {
    const remoteDir = mkdtempSync(join(tmpdir(), 'ao-repo-remote-'));
    created.push(remoteDir);
    git(remoteDir, ['init', '--bare', '--quiet']);
    git(root, ['remote', 'add', 'origin', realpathSync.native(remoteDir)]);
  }

  return root;
}

// ── The two reference profiles ─────────────────────────────────────────────
//
// A and B disagree on every policy the profile can express: default branch,
// task source, context sources, CodeGraph requirement, verification commands,
// allowed and protected scopes, review budget and remote expectation.

export const FIXTURE_A_PROFILE = `schemaVersion: 1
repository:
  id: fixture-alpha
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: BUILD
      command: [npm, run, build]
    - phase: VERIFY
      command: [npm, run, verify]
scope:
  allowedPaths:
    - src
    - tests
  protectedPaths:
    - dist
completion:
  maxReviewRounds: 3
remote:
  required: false
`;

export const FIXTURE_B_PROFILE = `schemaVersion: 1
repository:
  id: fixture-beta
  defaultBranch: develop
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: ops/work-items
context:
  canonicalSources:
    - docs/architecture.md
    - docs/security.md
capabilities:
  codegraph: REQUIRED
verification:
  phases:
    - phase: TEST
      command: [pnpm, run, test]
    - phase: VERIFY
      command: [pnpm, run, check]
scope:
  allowedPaths:
    - app
  protectedPaths:
    - app/generated
    - vendor
completion:
  maxReviewRounds: 5
remote:
  required: false
`;
