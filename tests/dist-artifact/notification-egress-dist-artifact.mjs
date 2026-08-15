#!/usr/bin/env node
/**
 * V2-10 — the notification egress gate, against the shipped artefact.
 *
 * Standalone Node script, spawned by the `test:dist-notify-egress` npm script
 * (and transitively by `verify`). It drives `dist/cli/index.js` as a real
 * process, twice, with the egress tripwire from
 * `notification-egress-preload.cjs` installed ahead of the ESM entry point.
 *
 * ── What this control proves ───────────────────────────────────────────────
 *
 *  1. with no `notify.yaml` in the operator's profile, the shipped binary runs a
 *     block to its end and **opens no socket at all** — not through `fetch`, not
 *     through `net`, `http`, `https` or `dns`. The tripwire is fatal, so an
 *     opt-in check that stopped working makes this case die rather than pass;
 *  2. with one, the same binary reaches its notification hook, sends **exactly
 *     one** HTTP POST, to the configured loopback endpoint and to nothing else,
 *     carrying the bounded JSON payload — and the payload agrees with the ending
 *     the CLI printed on its own console.
 *
 * ── What it does not prove, stated because a control that overclaims is worse
 *    than one that is missing ──────────────────────────────────────────────
 *
 * It does **not** kill the `detail` sanitiser. Both endings reachable here
 * (`RUN_GATE_REFUSED`, `NO_ELIGIBLE_TASK`) carry a code-shaped detail or none,
 * and the repository root never reaches the payload builder in the first place —
 * so removing the form gate would change nothing in these bytes and this gate
 * would stay green. That mutant is killed in
 * `tests/v2-10-operator-notification.test.ts`, on the pair the gate exists for.
 *
 * The "no repository root in the body" assertion below is therefore a regression
 * fence with a named mutant — widening `notifyBlockRun`'s second argument from
 * the declared id to the resolved repository — and not evidence about
 * sanitisation.
 *
 * ── Why the block cannot start an agent ────────────────────────────────────
 *
 * The fixture's only member depends on a task outside the block, so it is never
 * runnable: the run opens, chooses nothing and stops `NO_ELIGIBLE_TASK`. On a
 * machine without the agent CLIs the auth preflight refuses first and the ending
 * is `RUN_GATE_REFUSED`. Both need an operator, both are reached without a
 * single agent process, and which one happens is a property of the machine
 * rather than of the property under test.
 *
 * Contract: exit 0 means every check passed. Any nonzero exit means at least one
 * did not.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const cliEntry = join(repoRoot, 'dist', 'cli', 'index.js');
const preload = join(scriptDir, 'notification-egress-preload.cjs');

const EXIT_EGRESS_ATTEMPTED = 96;
const EXIT_INSTRUMENTATION_FAILED = 97;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(cliEntry)) {
  console.error(
    'dist/cli/index.js does not exist. Run "npm run build" first (see "verify:dist-notify-egress").',
  );
  process.exit(1);
}

/* ── the fixture ─────────────────────────────────────────────────────────── */

const PROFILE = `schemaVersion: 1
repository:
  id: egress-fixture
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

const task = (id, dependsOn) =>
  [
    '---',
    `id: ${id}`,
    `title: task ${id}`,
    'status: OPEN',
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: true',
    dependsOn.length === 0 ? 'dependsOn: []' : `dependsOn:\n${dependsOn.map((d) => `  - ${d}`).join('\n')}`,
    '---',
    '',
    'Body prose, which nothing interprets.',
    '',
  ].join('\n');

/** @type {string[]} */
const scratch = [];

function tempDir(prefix) {
  const created = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(created);
  return created;
}

function git(cwd, args) {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${done.stderr ?? ''}`);
}

/** A real repository whose only block member can never be eligible. */
function makeRepository() {
  const root = tempDir('ao-egress-repo-');
  mkdirSync(join(root, '.agent-orchestrator'), { recursive: true });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.agent-orchestrator/runtime/\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8');
  writeFileSync(join(root, '.agent-orchestrator', 'repo-profile.yaml'), PROFILE, 'utf8');
  writeFileSync(join(root, 'tasks', 'A-001.md'), task('A-001', ['Z-999']), 'utf8');
  writeFileSync(join(root, 'tasks', 'Z-999.md'), task('Z-999', []), 'utf8');

  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--no-verify', '-m', 'fixture']);
  return root;
}

/** A profile directory, with or without a notification configuration in it. */
function makeProfile(config) {
  const home = tempDir('ao-egress-home-');
  if (config !== null) {
    mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
    writeFileSync(join(home, '.agent-orchestrator', 'notify.yaml'), config, 'utf8');
  }
  return home;
}

/**
 * Runs the shipped CLI once.
 *
 * Asynchronous, and that is not a style preference: the loopback server below
 * lives in *this* process, and a synchronous spawn would block the event loop
 * that has to accept the child's connection. The first draft of this harness did
 * exactly that and reported `NOT DELIVERED (TIMEOUT)` — a green-looking negative
 * case and a positive case that could never pass.
 */
function runCli({ repository, profile, egress, runId }) {
  const child = spawn(
    process.execPath,
    [
      '--require',
      preload,
      cliEntry,
      'block',
      '--repository',
      repository,
      '--block',
      'V2',
      '--tasks',
      'A-001',
      '--run',
      runId,
      '--attended',
    ],
    {
      env: {
        ...process.env,
        AGENT_LOOP_TEST_PROFILE: profile,
        AGENT_LOOP_TEST_EGRESS: egress,
      },
    },
  );

  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

/** The ending the CLI printed for itself, e.g. `BLOCK_RUN_ENDED`. */
function outcomeFrom(stdout) {
  const match = /Outcome {6}: (\S+)/.exec(stdout);
  return match === null ? null : match[1];
}

/** The stop reason or the outcome, whichever names the ending. */
function endingFrom(stdout) {
  const reason = /reason (\S+)/.exec(stdout);
  return reason === null ? outcomeFrom(stdout) : reason[1];
}

/* ── 1. no configuration, no socket ──────────────────────────────────────── */

const repository = makeRepository();

const negative = await runCli({
  repository,
  profile: makeProfile(null),
  egress: 'FORBID',
  runId: 'run-0001',
});

check(
  negative.status !== EXIT_EGRESS_ATTEMPTED,
  `the unconfigured run opened a socket: ${negative.stderr ?? ''}`,
);
check(
  negative.status !== EXIT_INSTRUMENTATION_FAILED,
  `the instrumentation did not take: ${negative.stderr ?? ''}`,
);
check(
  (negative.stdout ?? '').includes('OFF (not configured)'),
  'the unconfigured run did not report its notifier as off',
);
check(
  endingFrom(negative.stdout ?? '') !== null,
  `the unconfigured run produced no ending at all:\n${negative.stdout ?? ''}\n${negative.stderr ?? ''}`,
);

/* ── 2. configured, exactly one POST, to the loopback ────────────────────── */

/** @type {{url: string, method: string, headers: object, body: string}[]} */
const received = [];
const server = createServer((request, response) => {
  /** @type {Buffer[]} */
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    received.push({
      url: request.url ?? '',
      method: request.method ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

const positive = await runCli({
  repository,
  profile: makeProfile(
    `endpoint: http://127.0.0.1:${port}/\ntopic: egress-gate\ntoken: tk_gate_secret\n`,
  ),
  egress: 'ALLOW_LOOPBACK',
  runId: 'run-0002',
});

await new Promise((done) => server.close(done));

check(
  positive.status !== EXIT_EGRESS_ATTEMPTED,
  `the configured run opened a socket somewhere else: ${positive.stderr ?? ''}`,
);
check(
  positive.status !== EXIT_INSTRUMENTATION_FAILED,
  `the instrumentation did not take: ${positive.stderr ?? ''}`,
);
check(
  (positive.stdout ?? '').includes('Notification : ARMED'),
  'the configured run did not report an armed notifier',
);
check(
  (positive.stdout ?? '').includes('Notification : DELIVERED'),
  `the configured run did not report a delivery:\n${positive.stdout ?? ''}`,
);
check(received.length === 1, `expected exactly one request, saw ${received.length}`);

if (received.length === 1) {
  const request = received[0];
  check(request.method === 'POST', `expected POST, saw ${request.method}`);
  check(request.url === '/', `expected the configured path, saw ${request.url}`);
  check(
    request.headers['content-type'] === 'application/json',
    'the payload was not sent as JSON',
  );
  check(
    request.headers['authorization'] === 'Bearer tk_gate_secret',
    'the configured token was not presented',
  );

  let body = null;
  try {
    body = JSON.parse(request.body);
  } catch {
    check(false, `the body was not JSON: ${request.body}`);
  }

  if (body !== null) {
    check(body.topic === 'egress-gate', `expected the configured topic, saw ${String(body.topic)}`);
    check(
      typeof body.message === 'string' && body.message.length > 0,
      'the notification carried no message',
    );
    // The payload and the console agree about what happened. Not decoration:
    // the whole design rule is that a notification is derived from the run's own
    // authoritative result rather than reconstructed beside it.
    const ending = endingFrom(positive.stdout ?? '');
    check(
      ending !== null && typeof body.message === 'string' && body.message.includes(ending),
      `the payload does not name the ending the console printed (${String(ending)})`,
    );
    // The regression fence, with its mutant named in this file's header.
    check(
      !request.body.includes(repository) &&
        !request.body.toLowerCase().includes(repository.toLowerCase()),
      'the repository root reached the wire',
    );
    check(
      !request.body.includes('tk_gate_secret'),
      'the token was written into the body as well as the header',
    );
  }
}

/* ── report ──────────────────────────────────────────────────────────────── */

for (const directory of scratch) {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover scratch directory is not a failure of the property under test.
  }
}

if (failures.length > 0) {
  console.error('notification egress gate: FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('notification egress gate: every check passed');
