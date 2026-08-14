#!/usr/bin/env node
/**
 * V2-07P. The runtime gate, measured against the SHIPPED CLI.
 *
 * Standalone Node script, plain JavaScript, spawned by `test:dist-runtime-gate`
 * (and transitively by `verify`). It spawns `dist/cli/index.js` as a real child
 * process — the gate lives at the CLI entry, terminates the process and writes
 * synchronously to fd 2, and none of those three things can be observed from
 * inside a vitest worker.
 *
 * Contract: exit 0 means every check passed. Nonzero means at least one did not.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const distEntry = join(repoRoot, 'dist', 'cli', 'index.js');
const preload = join(scriptDir, 'runtime-gate-preload.cjs');

const EXIT_RUNTIME_UNSUPPORTED = 6;
const EXIT_INSTRUMENTATION_FAILED = 97;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(distEntry)) {
  console.error(
    'dist/cli/index.js does not exist. Run "npm run build" before this check ' +
      '(see the "verify:dist-runtime-gate" npm script, which does this for you).',
  );
  process.exit(1);
}

/**
 * Run the shipped CLI. `env` entries drive the preload; when none are given the
 * preload is not loaded at all, so the process sees this real machine.
 */
function runCli(args, env = null) {
  const argv = env === null ? [distEntry, ...args] : ['--require', preload, distEntry, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}) },
    windowsHide: true,
    timeout: 60_000,
  });
  check(
    result.status !== EXIT_INSTRUMENTATION_FAILED,
    `the preload could not substitute the runtime facts, so nothing below was measured: ${result.stderr}`,
  );
  return result;
}

const UNSUPPORTED_PLATFORM = { V2_07P_FAKE_PLATFORM: 'linux' };
const UNSUPPORTED_NODE = { V2_07P_FAKE_NODE_VERSION: 'v20.11.1' };

/**
 * ── Why `lease status` runs against a throwaway fixture, not `repoRoot` ─────
 *
 * `lease status --repository <path>` only prints a report when `<path>`
 * resolves: a real Git repository whose root carries a valid
 * `.agent-orchestrator/repo-profile.yaml`. This checkout — `agent-orchestrator`
 * itself — has never been onboarded with one (nothing in this build's own
 * development loop runs it through `agent-loop`), so pointing `--repository` at
 * `repoRoot` fails closed with `PROFILE_MISSING` before the gate is even
 * reached, which would make every check below pass or fail for the wrong
 * reason.
 *
 * The other two dist-artefact harnesses that stand a repository up do not need
 * a *resolvable* one, because neither drives the CLI through
 * `resolveRepository()`: `execution-lease-release-dist-artifact.mjs` fabricates
 * an in-process `{ gitCommonDir, root, id }` record by hand and calls the lease
 * module directly, and `execution-lease-race-dist-artifact.mjs` only
 * `mkdirSync`s a bare `.git` directory — enough for the lease code, which reads
 * no profile. This harness is different: it exercises `dist/cli/index.js` end
 * to end, so `lease status` has to reach a real, fully resolvable repository —
 * an actual `git init`, a real commit, and a schema-valid profile on disk — or
 * there is nothing for it to print. Neither sibling technique transfers, so
 * this harness builds that repository itself, under the OS temp directory, so
 * what it proves about the gate does not depend on this repository's own
 * onboarding state, on this machine or on any other.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'v2-07p-runtime-gate',
  GIT_AUTHOR_EMAIL: 'v2-07p-runtime-gate@example.invalid',
  GIT_COMMITTER_NAME: 'v2-07p-runtime-gate',
  GIT_COMMITTER_EMAIL: 'v2-07p-runtime-gate@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, args) {
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const LEASE_FIXTURE_PROFILE = `schemaVersion: 1
repository:
  id: v2-07p-runtime-gate-fixture
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
  protectedPaths:
    - dist
completion:
  maxReviewRounds: 3
remote:
  required: false
`;

/** Creates a real, onboarded, throwaway Git repository and returns its canonical root. */
function createLeaseFixtureRepo() {
  const raw = mkdtempSync(join(tmpdir(), 'ao-runtime-gate-lease-'));
  const root = realpathSync.native(raw);
  git(root, ['init', '-b', 'main', '--quiet']);
  writeFileSync(join(root, 'README.md'), '# runtime-gate lease fixture\n', 'utf8');
  const profileDir = join(root, '.agent-orchestrator');
  mkdirSync(profileDir);
  writeFileSync(join(profileDir, 'repo-profile.yaml'), LEASE_FIXTURE_PROFILE, 'utf8');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

const leaseFixtureRoot = createLeaseFixtureRepo();
try {
  // ── 1. The positive control, on the configuration actually claimed ─────────
  //
  // Without the preload, so the gate sees this real Windows host. If this fails,
  // the gate is written so broadly that it refuses everything, and every
  // negative check below would pass for the wrong reason.
  {
    const positive = runCli(['lease', 'status', '--repository', leaseFixtureRoot]);
    check(positive.status === 0, `supported runtime: expected exit 0, got ${positive.status}`);
    check(
      positive.stdout.includes('Lease'),
      'supported runtime: the lease report did not reach stdout, so the action did not run',
    );
    check(
      !positive.stderr.includes('unsupported runtime'),
      'supported runtime: the gate refused on a supported machine',
    );
  }

  // ── 2. Negative: an unsupported platform, and an unsupported Node ──────────
  for (const [label, env] of [
    ['platform', UNSUPPORTED_PLATFORM],
    ['node version', UNSUPPORTED_NODE],
  ]) {
    const refused = runCli(['lease', 'status', '--repository', leaseFixtureRoot], env);

    check(
      refused.status === EXIT_RUNTIME_UNSUPPORTED,
      `unsupported ${label}: expected exit ${EXIT_RUNTIME_UNSUPPORTED}, got ${refused.status}`,
    );

    // The message survived a hard exit, in full. Both the first and the last
    // line are asserted: a truncated refusal is the failure mode
    // `writeAllSync` exists to prevent, and checking only the opening line
    // would not see it.
    check(
      refused.stderr.includes('unsupported runtime. Nothing was started.'),
      `unsupported ${label}: the refusal did not reach stderr`,
    );
    check(
      refused.stderr.includes('No other command does.'),
      `unsupported ${label}: the refusal reached stderr truncated`,
    );

    // THE EFFECT. Not "a message was printed" — that the action never ran.
    //
    // The two cases are not symmetric, and pretending otherwise would make half
    // of this proof vacuous. Spoofing `process.version` disturbs nothing else:
    // on a supported runtime this exact invocation prints the lease report, so
    // the node-version case is the one where "Lease is absent from stdout"
    // genuinely shows the gate stopped the command.
    //
    // Spoofing `process.platform` to a non-`win32` value does not leave the
    // rest of the CLI undisturbed. `resolveOnPath` in `src/doctor/exec.ts`
    // branches its PATHEXT search on `process.platform === 'win32'`, so with
    // the platform faked the CLI resolves `git` without `.exe` and
    // `resolveRepository()` fails at `GIT_UNAVAILABLE` before any report could
    // ever be written — independently of whether the gate ran at all. For that
    // case, `!refused.stdout.includes('Lease')` would hold even with the gate
    // fully disabled, so it is not load-bearing on its own.
    //
    // What *is* load-bearing for both cases: the real gate writes to fd 2 and
    // exits before Commander's action ever runs, so stdout is untouched -
    // empty, not "empty of the word Lease". A build with the gate stubbed out
    // always writes *something* to stdout for this invocation, whether that is
    // the lease report or the `could not be resolved` / `GIT_UNAVAILABLE`
    // failure text a broken git resolution produces. Asserting emptiness is
    // therefore the one check that cannot be satisfied by an unrelated failure,
    // and it is kept alongside the `Lease`-absence check because the latter is
    // still what an operator would actually have seen.
    check(
      !refused.stdout.includes('Lease'),
      `unsupported ${label}: the lease action ran anyway and wrote its report`,
    );
    check(
      refused.stdout.trim() === '',
      `unsupported ${label}: stdout was not empty, so something ran and wrote to it: ${JSON.stringify(refused.stdout)}`,
    );
  }
} finally {
  rmSync(leaseFixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

// ── 3. Nested commands are gated too ─────────────────────────────────────────
//
// This settles empirically whether Commander inherits a program-level
// `preAction` hook into subcommands. If it does not, this fails here rather
// than the gate silently covering only the top level.
{
  const nested = runCli(['release', '--help'], UNSUPPORTED_PLATFORM);
  check(
    nested.status !== EXIT_RUNTIME_UNSUPPORTED,
    'nested --help was refused by the gate; help must stay reachable',
  );
}

// ── 4. Help and version stay reachable on an unsupported runtime ─────────────
//
// §4 of the design promises this, so it is measured rather than assumed. The
// operator who most needs the help output is the one whose runtime is refused.
for (const args of [
  ['--help'],
  ['--version'],
  ['lease', '--help'],
  ['lease', 'status', '--help'],
  ['help', 'lease'],
]) {
  const label = args.join(' ');
  const result = runCli(args, UNSUPPORTED_PLATFORM);
  check(
    result.status !== EXIT_RUNTIME_UNSUPPORTED,
    `\`${label}\` on an unsupported runtime: the gate refused it (exit ${result.status})`,
  );
  check(
    result.stdout.trim().length > 0,
    `\`${label}\` on an unsupported runtime: printed nothing to stdout`,
  );
  check(
    !result.stdout.includes('Lease  '),
    `\`${label}\` on an unsupported runtime: ran an action instead of printing help`,
  );
}

if (failures.length > 0) {
  console.error(`runtime-gate dist artefact check: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('runtime-gate dist artefact check: all checks passed');
