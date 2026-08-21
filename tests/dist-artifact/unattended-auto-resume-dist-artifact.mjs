/**
 * V3 slice 8's authority boundary, against the shipped CLI, in real processes.
 *
 * ── What this harness may measure, and why it stops where it does ──────────
 *
 * The slice's headline behaviour is "sleep until a quota reset, then resume".
 * That cannot be measured here, and the reason is worth stating rather than
 * working around: every path that reaches a resume runs `deps.authPreflight()`
 * first, and the real one starts the subscription CLIs. A harness that drove it
 * would either spend quota on a developer machine or stop at
 * `AUTH_PREFLIGHT_FAILED` on CI — two different outcomes for one invocation,
 * which is a gate that measures the machine rather than the build. Making it
 * uniform would mean exporting a seam production does not have.
 *
 * So the wake-and-resume cycle stays in `tests/v3-08-unattended-auto-resume.test.ts`,
 * where the clock and the sleep are injected and the lease is real, and this
 * file measures the part of the contract that is **deterministic on every
 * machine because it is decided before any preflight**:
 *
 *  1. the argument refusals, which happen before the repository is resolved;
 *  2. the task-start refusal, which happens after the lease is taken and before
 *     the preflight — the single most important negative in the slice.
 *
 * ── Why (2) is not vacuous ────────────────────────────────────────────────
 *
 * "No branch appeared" is worth nothing if the fixture could not have produced
 * one. Two things make it real.
 *
 * The **positive control is inside the same invocation**: the report must show
 * `Release      : RELEASED`, which only a run that acquired the execution lease
 * can print. So the command demonstrably got as far as `driveUnderLease` — past
 * resolution, past selection, past acquisition — and refused at the start
 * boundary specifically, rather than falling over earlier for an unrelated
 * reason and leaving the repository untouched by accident.
 *
 * And the fixture is a task the product itself says it would start: the same
 * repository, invoked read-only, reports `TASK_NOT_STARTED` as a *plan*, which
 * is the plan's way of saying "a start is what happens next".
 *
 * ── Why it runs against `dist/` ───────────────────────────────────────────
 *
 * The refusals are a property of the shipped command's argument handling and of
 * the compiled lifecycle driver, and both are things a `src`-only suite reaches
 * through a different entry point. The CLI is also where the two grants are kept
 * apart; `registerRunCommand` is exercised in-process by
 * `tests/run-command.test.ts`, and this is the same contract asked of the binary
 * an operator actually invokes.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, '..', '..', 'dist', 'cli', 'index.js');

const EXIT_INPUT_UNUSABLE = 2;

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

/* ───────────────────────────── the repository ───────────────────────────── */

const PROFILE = `schemaVersion: 1
repository:
  id: unattended-resume-fixture
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

const TASK_ID = 'V3-08';

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
 * A real Git repository with a real profile and one startable task.
 *
 * Canonicalised for the reason `lifecycle-restart-dist-artifact.mjs` gives at
 * length: `tmpdir()` can be an 8.3 alias, and a fixture that keeps one hands a
 * different spelling to whoever resolves it. Nothing here hand-builds a
 * repository record — the CLI resolves the directory itself.
 */
function repositoryFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-unattended-dist-')));
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
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.gitattributes'), '* -text\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# unattended fixture\n', 'utf8');
  writeFileSync(join(root, '.gitignore'), '.agent-orchestrator/runtime/\n', 'utf8');
  writeFileSync(join(root, '.agent-orchestrator', 'repo-profile.yaml'), PROFILE, 'utf8');
  writeFileSync(join(root, 'tasks', `${TASK_ID}.md`), TASK_FILE, 'utf8');
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'fixture']);
  return root;
}

/** Everything a start would leave behind, read with real Git and real `fs`. */
function traces(root) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '' },
    });
  return {
    runtimeState: existsSync(join(root, '.agent-orchestrator', 'runtime')),
    branches: git(['branch', '--list', 'ao/task/*']).trim(),
    worktrees: git(['worktree', 'list']).trim(),
    lease: existsSync(join(root, '.git', 'agent-orchestrator-execution-lease.json')),
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [distEntry, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
}

/* ══════════ 1. the argument refusals, before anything is resolved ═════════ */

/**
 * Driven against a path no fixture created.
 *
 * That is the strongest available form of "nothing happened": a run that
 * reached any effect would have had to resolve the repository first, and
 * resolving this path fails with its own, different message. So the absence of
 * `could not be resolved` in the output is a direct measurement of the ordering,
 * not a guess about it.
 */
const ABSENT_REPOSITORY = join(tmpdir(), 'ao-no-such-repository-v3-08');

const REFUSALS = [
  { code: 'CONTINUATION_GRANT_CONFLICT', args: ['--attended', '--automatic-resume-only'] },
  {
    code: 'WAIT_WITHOUT_AUTOMATIC_RESUME',
    args: ['--wait-for-reset', '--max-wait-ms', '1000'],
  },
  { code: 'MAX_WAIT_WITHOUT_WAIT', args: ['--automatic-resume-only', '--max-wait-ms', '1000'] },
  { code: 'MAX_WAIT_MS_REQUIRED', args: ['--automatic-resume-only', '--wait-for-reset'] },
  {
    code: 'STALE_RECOVERY_WITH_WAIT',
    args: [
      '--automatic-resume-only',
      '--wait-for-reset',
      '--max-wait-ms',
      '1000',
      '--recover-stale-lease',
    ],
  },
  {
    code: 'STALE_RECOVERY_WITHOUT_OPERATOR',
    args: ['--automatic-resume-only', '--recover-stale-lease'],
  },
];

for (const refusal of REFUSALS) {
  const result = runCli([
    'run',
    '--repository',
    ABSENT_REPOSITORY,
    '--task',
    TASK_ID,
    ...refusal.args,
  ]);
  check(
    result.status === EXIT_INPUT_UNUSABLE,
    `${refusal.code}: expected exit ${EXIT_INPUT_UNUSABLE}, got ${result.status}`,
  );
  check(
    result.stdout.includes(refusal.code),
    `${refusal.code}: the refusal code did not reach stdout`,
  );
  check(
    !result.stdout.includes('could not be resolved'),
    `${refusal.code}: the repository was resolved, so the refusal is not before effects`,
  );
  check(result.stderr.trim() === '', `${refusal.code}: wrote to stderr`);
}

/* ══════ 2. the start refusal, after the lease and before the preflight ════ */

const root = repositoryFixture();

try {
  // The positive control, and it is the product's own statement: this task is
  // one a start would create. Read-only, so it changes nothing.
  {
    const plan = runCli(['run', '--repository', root, '--task', TASK_ID]);
    check(plan.status === 0, `read-only plan: expected exit 0, got ${plan.status}`);
    check(
      plan.stdout.includes('TASK_NOT_STARTED'),
      'read-only plan: the fixture task is not startable, so the negative below proves nothing',
    );
    check(
      plan.stdout.includes('Read-only plan.'),
      'read-only plan: the bare command did not report itself read-only',
    );
  }

  const before = traces(root);
  check(before.runtimeState === false, 'fixture already had a runtime directory');
  check(before.branches === '', 'fixture already had a task branch');
  check(before.lease === false, 'fixture already had an execution lease');

  const run = runCli([
    'run',
    '--repository',
    root,
    '--task',
    TASK_ID,
    '--automatic-resume-only',
  ]);
  const after = traces(root);

  check(
    run.status === EXIT_INPUT_UNUSABLE,
    `unattended start: expected exit ${EXIT_INPUT_UNUSABLE}, got ${run.status}`,
  );
  check(
    run.stdout.includes('TASK_NOT_STARTED'),
    'unattended start: the report did not say the task had never been started',
  );

  // THE CONTROL. Only a run that acquired the execution lease can print a
  // release result, so this is what separates "refused at the start boundary"
  // from "fell over before it got there and left the repository alone".
  check(
    run.stdout.includes('Release      : RELEASED'),
    'unattended start: no proven release, so the run never held the lease and the ' +
      'untouched repository below proves nothing about the start refusal',
  );

  // THE EFFECT. Not that a message was printed — that nothing was created.
  check(after.runtimeState === false, 'unattended start: a runtime state directory appeared');
  check(after.branches === '', `unattended start: a task branch appeared: ${after.branches}`);
  check(
    after.worktrees === before.worktrees,
    'unattended start: the worktree list changed',
  );
  check(after.lease === false, 'unattended start: the execution lease was left behind');

  // The contract sentence, and never the attended one: this invocation must not
  // be able to claim an operator was present.
  check(
    run.stdout.includes('Unattended automatic resume.'),
    'unattended start: the unattended contract sentence is missing from the report',
  );
  check(
    !run.stdout.includes('Attended run.'),
    'unattended start: the report claimed an operator was present',
  );

  // And the wait line is there, saying it did not wait — a quota block is the
  // only thing this mode ever waits for, and this was not one.
  check(
    run.stdout.includes('Wait         : NOT_A_QUOTA_BLOCK'),
    'unattended start: the wait line is missing or claims something else happened',
  );
} finally {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (failures.length > 0) {
  console.error(`unattended-auto-resume dist artefact check: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `unattended-auto-resume dist artefact check: all ${checks} checks passed`,
);
