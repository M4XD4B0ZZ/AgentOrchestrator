/**
 * M8's operator resolution, against the shipped CLI, in real processes.
 *
 * ── Why this exists as a dist check at all ────────────────────────────────
 *
 * Precedent, not caution. `tests/m4-01-unattended-completion.test.ts` records a
 * mutation campaign in which reverting the one wiring line that was the whole of
 * a defect survived the entire in-process suite, because the case called the
 * underlying function instead of the registered command. A verb that is not in
 * the binary — unregistered, renamed, or wired to a different seam — is exactly
 * that class of defect, and no `src`-only test can see it.
 *
 * ── What it measures, and where it stops ──────────────────────────────────
 *
 * Only what is decided **before any preflight**, so that it is deterministic on
 * every machine:
 *
 *  1. the verb is in the shipped binary, and in its help;
 *  2. the authority conjunct is enforced before anything else happens — no
 *     `--attended`, no effect, and the refusal names itself;
 *  3. with the authority, and a repository that really resolves, the command
 *     gets as far as the durable record and refuses honestly on a task that was
 *     never started.
 *
 * (3) is the positive control for (2): it proves the refusal in (2) is the
 * *authority* refusing rather than the command falling over for an unrelated
 * reason. It also proves the command takes and gives back the execution lease,
 * which is the only authority it needs.
 *
 * It deliberately does **not** drive a real closure. That would need a durable
 * `HUMAN_DECISION_REQUIRED` state, which no dist harness may produce — a writer
 * and a reviewer would have to have run — and hand-writing one would make this a
 * harness that measures a document it wrote itself.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, '..', '..', 'dist', 'cli', 'index.js');

const EXIT_INPUT_UNUSABLE = 2;
const EXIT_NEEDS_OPERATOR = 3;

const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

if (!existsSync(distEntry)) {
  process.stderr.write('dist/cli/index.js is missing. Run `npm run build` before this check.\n');
  process.exit(1);
}

const PROFILE = `schemaVersion: 1
repository:
  id: operator-resolution-fixture
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
    - phase: VERIFY
      command: [git, --version]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: 3
remote:
  required: false
`;

const TASK_ID = 'M8-02';

const TASK_FILE = `---
id: ${TASK_ID}
title: task ${TASK_ID}
status: OPEN
kind: NORMAL
priority: NORMAL
currentFocus: false
dependsOn: []
---

# Body
`;

const created = [];

/**
 * A real Git repository with a real profile and one task that was never started.
 *
 * Canonicalised: `tmpdir()` can be an 8.3 alias, and a fixture that keeps one
 * hands a different spelling to whoever resolves it.
 */
function repositoryFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-resolve-dist-')));
  created.push(root);
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '' },
    });
  git(['init', '-b', 'main', '--quiet']);
  git(['config', 'user.name', 'AgentOrchestrator']);
  git(['config', 'user.email', 'agent-orchestrator@local.invalid']);
  mkdirSync(join(root, '.agent-orchestrator'), { recursive: true });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.agent-orchestrator/runtime/\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8');
  writeFileSync(join(root, '.agent-orchestrator', 'repo-profile.yaml'), PROFILE, 'utf8');
  writeFileSync(join(root, 'tasks', `${TASK_ID}.md`), TASK_FILE, 'utf8');
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'fixture']);
  return root;
}

function cli(args) {
  return spawnSync(process.execPath, [distEntry, ...args], { encoding: 'utf8' });
}

try {
  /* ── 1. The verb is in the artefact an operator runs ────────────────────── */

  const help = cli(['--help']);
  check(help.status === 0, 'help: the shipped CLI did not print its help');
  check(
    /\bresolve\b/.test(help.stdout),
    'help: the shipped CLI does not list a `resolve` command',
  );

  const verbHelp = cli(['resolve', '--help']);
  check(verbHelp.status === 0, 'resolve --help: the verb is not registered in the artefact');
  check(
    verbHelp.stdout.includes('--attended') && verbHelp.stdout.includes('--task'),
    'resolve --help: the two conjuncts this command requires are not both documented',
  );
  check(
    verbHelp.stdout.includes('--repository'),
    'resolve --help: the repository is not a required option of the shipped verb',
  );

  const root = repositoryFixture();

  /* ── 2. The authority is enforced before anything happens ───────────────── */

  const withheld = cli(['resolve', '--repository', root, '--task', TASK_ID]);
  check(
    withheld.status === EXIT_NEEDS_OPERATOR,
    `no --attended: expected exit ${EXIT_NEEDS_OPERATOR}, got ${String(withheld.status)}`,
  );
  check(
    withheld.stdout.includes('Resolve      : not requested'),
    'no --attended: the report does not say the resolution was not requested',
  );
  check(
    withheld.stdout.includes('requires --attended'),
    'no --attended: the refusal does not name the conjunct it is refusing on',
  );
  // Decided before the repository is even resolved: nothing about the lease is
  // printed, because nothing about the lease happened.
  check(
    !withheld.stdout.includes('Lease'),
    'no --attended: the command touched the execution lease before refusing',
  );

  /* ── 3. With the authority, it really runs — and refuses honestly ───────── */

  const attended = cli(['resolve', '--repository', root, '--task', TASK_ID, '--attended']);
  check(
    attended.status === EXIT_INPUT_UNUSABLE,
    `attended: expected exit ${EXIT_INPUT_UNUSABLE} for a task that was never started, got ${String(attended.status)}`,
  );
  check(
    attended.stdout.includes('Outcome      : TASK_NOT_STARTED'),
    'attended: the outcome for a task with no durable state is not reported',
  );
  // The positive control. Only a run that acquired the repository's execution
  // lease can print this, so the command demonstrably reached the durable record
  // rather than falling over earlier.
  check(
    attended.stdout.includes('Lease'),
    'attended: the command never reported the execution lease it must take',
  );
  // And it claims nothing about work it did not do.
  check(
    !attended.stdout.includes('OPERATOR_RESOLVED'),
    'attended: a task that was never started was reported as ended',
  );
} finally {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (failures.length > 0) {
  console.error(`operator-resolution dist artefact check: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`operator-resolution dist artefact check: all ${checks} checks passed`);
