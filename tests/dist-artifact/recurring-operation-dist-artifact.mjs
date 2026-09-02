/**
 * M3 slice 2 against the shipped CLI, in real processes.
 *
 * ── Why none of this can be an in-process test ─────────────────────────────
 *
 * Three of the slice's claims are about a process rather than a function:
 *
 *  - **recurring operation.** "One AgentOrchestrator process keeps operating
 *    across several planning cycles without being re-invoked" is a sentence
 *    about a process staying alive. Calling `driveScheduler` twice in a vitest
 *    worker proves that a loop loops;
 *  - **durability.** "An operator who was not watching can find out afterwards
 *    what needs them" is a sentence about a file surviving the process that
 *    wrote it. Here the store is read by the harness, from disk, after the CLI
 *    has exited — and in phase F it is read by a *second* CLI process that knows
 *    nothing about the first;
 *  - **two schedulers.** The de-duplication is an exclusive `open`, and only two
 *    real processes can race one.
 *
 * The fourth is negative and is the reason this harness uses the egress preload
 * rather than the scheduler one: with no `notify.yaml` in front of it, a
 * scheduler that now knows how to send things must open **no socket at all**.
 * The preload makes an attempt fatal with exit 96, so that case fails loudly
 * rather than passing by inspection.
 *
 * ── Why no agent can ever start here ───────────────────────────────────────
 *
 * The same arrangement `persistent-scheduler-dist-artifact.mjs` uses, and for
 * the same reason. Every quota fixture records `worktreeCleanAtCheckpoint:
 * false` on a worktree that really exists and really holds the recorded branch,
 * so reconciliation is CONSISTENT — the run reaches the resume decision, which
 * is the point — and the resume is then denied on a fact no passage of time can
 * change. The human-decision fixture cannot resume at all, by contract.
 *
 * That is also what makes the assertions machine-independent: every path that
 * would drive a task runs the real auth preflight, which passes on a developer
 * machine and fails on CI, so no assertion here may depend on it. Everything
 * asserted below is decided before or after any preflight — the durable records,
 * the store on disk, the cycle count, and whether the process was still alive.
 *
 * **M4 broke that promise and this is how it was restored.** Giving the outbox a
 * second subject meant a *run's own ending* could raise an item, and on CI every
 * pass ends `AUTH_PREFLIGHT_FAILED` — the one fact this harness had carefully
 * arranged never to depend on. Seven checks failed on CI while all 44 passed
 * locally, which is the exact failure mode the paragraph above exists to
 * prevent, arriving from a direction it did not anticipate.
 *
 * The repair is not to suppress the new items. It is that the counts here were
 * always counts of **task** conditions — `taskId === 'HD-1'`,
 * `ESCALATED_DECISION_REQUIRED` — and they now say so, over
 * {@link outbox}'s task view. The new subject is measured by
 * {@link checkRepositoryItems}, which asserts a *property* every repository item
 * must have rather than a count that would depend on the machine again.
 *
 * ── The phases ─────────────────────────────────────────────────────────────
 *
 *  A. control — the same fixtures, the same binary, no `--idle-poll-ms`. One
 *     pass, and the duration every threshold below is derived from rather than
 *     guessed. This is the pre-slice behaviour and it must be unchanged. It also
 *     carries the load-bearing silence: a quota block whose reset is an hour away
 *     is the scheduler's, and must produce no item at all.
 *  B. recurring — one process, four cycles, a real short quota reset waited out
 *     in the middle, and no re-invocation. It must outlive the control.
 *  C. the outbox after four settles — no duplicate of the item phase A raised,
 *     and a *second* item that appeared without anything being re-invoked: phase
 *     B moved the quota reset into the past, and a reset that has passed over a
 *     withdrawn resume record stops being the machine's. The same predicate that
 *     permits `--continue-usage-limit` is what raised it, which is the slice's
 *     whole design in one fixture.
 *  D. resolution — one condition goes away, its item goes with it, and the other
 *     repository's item does not.
 *  E. two schedulers — both settle the same registry at once; exactly one record
 *     per condition survives, and each is whole.
 *  F. reconstruction — the store is deleted and a *different* process finds the
 *     same conditions and writes them again, under the same names. This is the
 *     crash window: a process that dies before recording anything costs a delay,
 *     never a notification, because the judgement is a function of a document
 *     rather than of anything the dead process observed.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', '..', 'dist');
const distEntry = join(distDir, 'cli', 'index.js');
const preload = join(here, 'notification-egress-preload.cjs');

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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Awaits `promise`, giving up after `ms`, and clears the timer either way.
 *
 * Written out rather than `Promise.race`, which is a trap the sibling harness
 * fell into: `race` settles on the winner and abandons the loser, so a guard
 * timer stays armed and keeps this process alive after the work it guarded has
 * finished.
 */
function withTimeout(promise, ms, timeoutValue) {
  let timer;
  const guard = new Promise((done) => {
    timer = setTimeout(() => done(timeoutValue), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const created = [];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', windowsHide: true });
}

function put(root, relativePath, contents) {
  const target = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function profileYaml(id) {
  return `schemaVersion: 1
repository:
  id: ${id}
  defaultBranch: main
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: .agent-orchestrator/tasks
context:
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL
verification:
  phases:
    - phase: VERIFY
      command: [node, --version]
scope:
  allowedPaths:
    - src
  protectedPaths: []
completion:
  maxReviewRounds: 1
remote:
  required: false
`;
}

function taskFile(id) {
  return `---
id: ${id}
title: task ${id}
status: OPEN
kind: NORMAL
priority: NORMAL
currentFocus: false
dependsOn: []
---
body
`;
}

function makeRepository(id, taskIds) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-m3s2-')));
  created.push(root);
  git(root, ['init', '-b', 'main', '--quiet']);
  put(root, '.gitattributes', '* -text\n');
  put(root, '.gitignore', '.agent-orchestrator/runtime/\n');
  put(root, 'README.md', `# ${id}\n`);
  put(root, '.agent-orchestrator/repo-profile.yaml', profileYaml(id));
  for (const taskId of taskIds) put(root, `.agent-orchestrator/tasks/${taskId}.md`, taskFile(taskId));
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return { root, id };
}

/** The workspace identity the product derives, reproduced for the fixture only. */
function identityOf(root, taskId) {
  const parent = dirname(root);
  const base = root.slice(parent.length + 1);
  return {
    worktreeParent: join(parent, `${base}.worktrees`),
    worktreePath: join(parent, `${base}.worktrees`, taskId),
    workBranch: `ao/task/${taskId}`,
  };
}

function statePathOf(root, taskId) {
  return join(root, '.agent-orchestrator', 'runtime', `${taskId}.json`);
}

/**
 * A real worktree on the derived branch, plus a durable blocked state naming it.
 *
 * Hand-written, because the subject of this harness is what a fresh process
 * reads back **from disk**, and producing one by driving a real agent would need
 * a real agent. It is validated on the way back in by `loadTaskState`, the same
 * gate every production reader passes, so a fixture the schema would refuse
 * cannot silently become a passing case.
 */
function parkTask(repository, taskId, blocked) {
  const identity = identityOf(repository.root, taskId);
  git(repository.root, [
    'worktree', 'add', '--quiet', '-b', identity.workBranch, identity.worktreePath, 'HEAD',
  ]);
  created.push(identity.worktreeParent);
  const head = git(repository.root, ['rev-parse', 'HEAD']).trim();
  const state = {
    schemaVersion: 1,
    taskId,
    repositoryId: repository.id,
    repositoryRoot: repository.root,
    worktreePath: realpathSync.native(identity.worktreePath),
    state: blocked.state,
    stateEnteredAt: '2026-09-01T00:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: head,
    scopeAuthorityCommit: null,
    workBranch: identity.workBranch,
    // The field that makes a resume permanently impossible, and therefore the
    // one that keeps every fixture here from ever starting an agent.
    currentCommit: head,
    reviewRound: 0,
    maxReviewRounds: 1,
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    reportedResetAt: blocked.reportedResetAt ?? null,
    worktreeCleanAtCheckpoint: false,
    findingHistory: [],
  };
  const path = statePathOf(repository.root, taskId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return path;
}

/** Rewrites one field of an already-written state. */
function rewrite(path, changes) {
  const state = { ...JSON.parse(readFileSync(path, 'utf8')), ...changes };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function operatorProfile(roots, maxConcurrentRepositories) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-m3s2-home-')));
  created.push(home);
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  const lines = ['schemaVersion: 1', 'repositories:'];
  for (const root of roots) lines.push(`  - path: ${JSON.stringify(root)}`);
  if (maxConcurrentRepositories !== undefined) {
    lines.push(`maxConcurrentRepositories: ${String(maxConcurrentRepositories)}`);
  }
  writeFileSync(join(home, '.agent-orchestrator', 'repositories.yaml'), `${lines.join('\n')}\n`, 'utf8');
  return home;
}

/* ──────────────────────────── the instruments ───────────────────────────── */

/** The outbox, read from disk exactly as an operator would find it. */
/**
 * The outbox on disk, split by what each item is *about*.
 *
 * `names`/`records` are every file, unchanged. `taskNames`/`taskRecords` are the
 * items about a task, which is what every count below was written to measure
 * when a task was the only subject there was.
 *
 * The split is not tidying. M4 gave the store a second subject — a condition
 * that belongs to the **repository**, raised when a run's own ending leaves no
 * task record to judge — and the very first CI run of this harness after that
 * change failed seven checks here while passing locally. The reason is exactly
 * the reason the subject exists: on a machine with no agent subscription login,
 * every pass ends `AUTH_PREFLIGHT_FAILED` before a task state is ever written,
 * and that now raises `REPOSITORY_RUN_REFUSED`. It is correct — an unattended
 * machine whose login is gone will never run anything and must say so — and it
 * is environment-dependent, because a developer's machine *is* logged in.
 *
 * So the counts below are taken over the subject they were always about, and the
 * new subject is measured by a property that holds in both environments rather
 * than by a count that holds in neither.
 */
function outbox(home) {
  const root = join(home, '.agent-orchestrator', 'operator-attention');
  const empty = {
    names: [],
    records: [],
    taskNames: [],
    taskRecords: [],
    repositoryRecords: [],
  };
  if (!existsSync(root)) return empty;
  const names = readdirSync(root).sort();
  const records = [];
  const taskNames = [];
  const taskRecords = [];
  const repositoryRecords = [];
  for (const name of names) {
    let record;
    try {
      record = JSON.parse(readFileSync(join(root, name), 'utf8'));
    } catch {
      record = { unreadable: name };
    }
    records.push(record);
    // Defaulted to `TASK`, not asserted, so this harness still reads a record
    // written by a build that predates the discriminant rather than counting it
    // as neither subject and silently dropping it from every check.
    if ((record.subject ?? 'TASK') === 'REPOSITORY') repositoryRecords.push(record);
    else {
      taskNames.push(name);
      taskRecords.push(record);
    }
  }
  return { names, records, taskNames, taskRecords, repositoryRecords, root };
}

/**
 * Every repository item in a store is well-formed. True in every environment.
 *
 * A count would not be: whether any repository condition arises at all depends
 * on whether this machine can log in to an agent. What does not depend on the
 * environment is that a repository item names a repository condition and **no
 * task** — which is the property `.strict()` and the discriminated schema exist
 * to guarantee, checked here against the shipped artefact's own output.
 */
function checkRepositoryItems(label, store) {
  for (const record of store.repositoryRecords) {
    check(
      typeof record.condition === 'string' && record.condition.length > 0,
      `${label}: a repository item carries no condition`,
    );
    check(
      typeof record.reason === 'string' && record.reason.startsWith('REPOSITORY_'),
      `${label}: a repository item names a task reason: ${String(record.reason)}`,
    );
    check(
      record.taskId === undefined && record.state === undefined,
      `${label}: a repository item names a task: ${String(record.taskId)}`,
    );
    check(
      typeof record.action === 'string' && record.action.length > 0,
      `${label}: a repository item has nothing for an operator to do`,
    );
  }
}

const BASE_ARGS = ['--attended', '--max-steps', '1', '--max-invocations', '1'];

function runCli(args, home, timeoutMs = 900_000) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--require', preload, distEntry, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env: {
      ...process.env,
      AGENT_LOOP_TEST_PROFILE: home,
      // No `notify.yaml` is ever written by this harness, so the shipped CLI
      // must open nothing. An attempt exits 96 and is asserted against below.
      AGENT_LOOP_TEST_EGRESS: 'FORBID',
    },
  });
  return { ...result, elapsedMs: Date.now() - startedAt };
}

function startCli(args, home) {
  const child = spawn(process.execPath, ['--require', preload, distEntry, ...args], {
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_LOOP_TEST_PROFILE: home,
      AGENT_LOOP_TEST_EGRESS: 'FORBID',
    },
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    out += String(chunk);
  });
  let exited = null;
  const closed = new Promise((done) => {
    child.on('close', (code) => {
      exited = code;
      done(code);
    });
  });
  return {
    child,
    closed,
    alive: () => exited === null,
    exitCode: () => exited,
    text: () => out,
  };
}

function countCycles(text) {
  return [...text.matchAll(/── cycle (\d+) of/g)].length;
}

function endingOf(text) {
  return /^Ending\s+: (\S+)/m.exec(text)?.[1] ?? 'NONE';
}

function dispositionsOf(text) {
  return [...text.matchAll(/^Scheduler\s+: (\S+)/gm)].map((match) => match[1]);
}

function banner(text) {
  process.stdout.write(`\n── ${text} ${'─'.repeat(Math.max(0, 66 - text.length))}\n`);
}

/* ════════════════════════════ phase A — control ═════════════════════════════ */

banner('A  control: no --idle-poll-ms, and nothing changed');

const repoA = makeRepository('m3s2-needs-person', ['HD-1']);
parkTask(repoA, 'HD-1', { state: 'HUMAN_DECISION_REQUIRED' });
const repoB = makeRepository('m3s2-machine-wait', ['QUOTA-1']);
const stateB = parkTask(repoB, 'QUOTA-1', {
  state: 'BLOCKED_USAGE_LIMIT',
  reportedResetAt: new Date(Date.now() + 3_600_000).toISOString(),
});
const homeControl = operatorProfile([repoA.root, repoB.root], 2);

const control = runCli(
  ['repositories', ...BASE_ARGS, '--wait-for-reset', '--max-wait-ms', '1000', '--max-cycles', '2'],
  homeControl,
);
const controlText = `${control.stdout ?? ''}${control.stderr ?? ''}`;

check(control.status !== 96, 'A: the control opened a socket with no notification configuration');
check(control.status !== 97, 'A: the control preload did not take');
check(
  endingOf(controlText) === 'BOUND_EXCEEDED',
  `A: the control should stop on its wait bound, ended ${endingOf(controlText)}`,
);
check(countCycles(controlText) === 1, 'A: the control ran more than one cycle');
const controlMs = control.elapsedMs;
process.stdout.write(`   control pass: ${String(controlMs)} ms, ending ${endingOf(controlText)}\n`);

// The outbox is written by the control too — it asked to wait — and that is the
// first proof that a durable item exists at all.
const controlOutbox = outbox(homeControl);
checkRepositoryItems('A', controlOutbox);
check(
  controlOutbox.taskNames.length === 1,
  `A: expected exactly one open task item, found ${String(controlOutbox.taskNames.length)}`,
);
check(
  controlOutbox.taskRecords[0]?.taskId === 'HD-1',
  `A: the open item names the wrong task: ${String(controlOutbox.taskRecords[0]?.taskId)}`,
);
check(
  controlOutbox.taskRecords[0]?.reason === 'ESCALATED_DECISION_REQUIRED',
  `A: the open item names the wrong reason: ${String(controlOutbox.taskRecords[0]?.reason)}`,
);
// The load-bearing silence. The quota block is a machine-known wait, so it must
// NOT be an item — and the fixture differs from the one that is only in its
// state, so the classification is what explains the difference.
check(
  controlOutbox.taskRecords.every((record) => record.taskId !== 'QUOTA-1'),
  'A: a task the scheduler can wait for was reported as needing a person',
);

/* ══════════════════════ phase B — recurring operation ══════════════════════ */

banner('B  one process, several cycles, no re-invocation');

// A reset close enough to be waited out inside one run, and far enough that the
// first pass cannot have passed it. The threshold below is derived from phase
// A's own measurement rather than guessed, so a slow runner moves it too.
const resetAt = new Date(Date.now() + Math.max(4_000, controlMs)).toISOString();
rewrite(stateB, { reportedResetAt: resetAt });

const recurring = startCli(
  [
    'repositories',
    ...BASE_ARGS,
    '--wait-for-reset',
    '--max-wait-ms',
    '120000',
    '--max-cycles',
    '4',
    '--idle-poll-ms',
    '1000',
  ],
  homeControl,
);

// Still running well after a non-recurring invocation of the same fixture would
// have returned. That is the whole claim of the capability, and it is measured
// against the control rather than against a constant.
await sleep(Math.min(3_000, Math.max(1_000, Math.floor(controlMs / 2))));
check(recurring.alive(), 'B: the recurring process exited when the control would have');

const recurringCode = await withTimeout(recurring.closed, 600_000, 'TIMEOUT');
check(recurringCode !== 'TIMEOUT', 'B: the recurring process never ended');
if (recurringCode === 'TIMEOUT') {
  try {
    recurring.child.kill('SIGKILL');
  } catch {
    /* best effort */
  }
}
const recurringText = recurring.text();

check(recurringCode !== 96, 'B: the recurring process opened a socket with no configuration');
check(recurringCode !== 97, 'B: the recurring preload did not take');

const cycles = countCycles(recurringText);
const dispositions = dispositionsOf(recurringText);
process.stdout.write(
  `   cycles: ${String(cycles)}  dispositions: ${dispositions.join(', ')}  ending ${endingOf(recurringText)}\n`,
);

// Four cycles from one invocation. Nobody re-ran anything.
check(cycles === 4, `B: expected 4 cycles from one invocation, saw ${String(cycles)}`);
check(
  endingOf(recurringText) === 'CYCLE_BUDGET_SPENT',
  `B: expected the cycle budget to end it, ended ${endingOf(recurringText)}`,
);
// It really kept going for two different reasons, and both are the point: a
// recorded instant it waited for, and an interval it chose to look again on.
check(
  dispositions.includes('IDLE_POLLED'),
  'B: no cycle continued on the idle interval, so the new behaviour was never exercised',
);
check(
  dispositions.some((value) => value === 'WAITED' || value === 'MATURED_DURING_PASS'),
  'B: the recorded quota reset was never honoured',
);
// The lease was given back every time, or nothing would have slept at all.
check(
  !existsSync(join(repoA.root, '.git', 'agent-orchestrator-execution-lease.json')),
  'B: an execution lease was left behind on repository A',
);
check(
  !existsSync(join(repoB.root, '.git', 'agent-orchestrator-execution-lease.json')),
  'B: an execution lease was left behind on repository B',
);

/* ══════════════════════ phase C — the outbox after many cycles ═════════════ */

banner('C  four cycles, two conditions, no duplicates');

const afterRecurring = outbox(homeControl);
checkRepositoryItems('C', afterRecurring);
process.stdout.write(`   items: ${afterRecurring.names.join(', ') || 'none'}\n`);

// **Two** items now, and the second one is the whole slice in a fixture. The
// quota block was the machine's in phase A because its reset was an hour away;
// phase B moved that instant into the past, and the record it sits on has a
// withdrawn checkpoint — so no passage of time and no repair to the repository
// can ever let the automatic path take it. It stopped being the scheduler's and
// became the operator's, and the outbox says so without anybody deciding twice:
// the same predicate that permits `--continue-usage-limit` is what raised it.
check(
  afterRecurring.taskNames.length === 2,
  `C: expected two open task conditions, found ${String(afterRecurring.taskNames.length)}`,
);

const escalated = afterRecurring.records.find((record) => record.taskId === 'HD-1');
const quota = afterRecurring.records.find((record) => record.taskId === 'QUOTA-1');

// The de-duplication, measured across five settles — one in phase A and four in
// phase B. A store that grew per cycle would be the spam this design exists to
// prevent, and the identity being stable is what stops it.
check(
  afterRecurring.taskNames.includes(controlOutbox.taskNames[0]),
  'C: the phase A item was re-created under a different name, so the identity is not stable',
);
check(
  afterRecurring.taskNames.filter((name) => name === controlOutbox.taskNames[0]).length === 1,
  'C: the phase A item appears more than once',
);

check(escalated?.repositoryId === 'm3s2-needs-person', 'C: the escalation names the wrong repository');
check(escalated?.state === 'HUMAN_DECISION_REQUIRED', 'C: the escalation names the wrong state');
check(
  typeof escalated?.action === 'string' && escalated.action.includes('--continue-human-decision'),
  'C: the escalation does not name the command that resolves it',
);
check(
  typeof escalated?.attentionId === 'string' &&
    afterRecurring.taskNames.includes(`${escalated.attentionId}.json`),
  'C: a record’s own id disagrees with the file it is in',
);

check(quota?.repositoryId === 'm3s2-machine-wait', 'C: the quota item names the wrong repository');
check(
  quota?.reason === 'QUOTA_CONTINUATION_REQUIRED',
  `C: the quota item names the wrong reason: ${String(quota?.reason)}`,
);
// The reading, carried into the record, is the diagnosis an operator acts on —
// and it is the exact shape this slice made recoverable.
check(
  quota?.detail === 'RESUME_RECORD_WITHDRAWN',
  `C: the quota item carries the wrong reading: ${String(quota?.detail)}`,
);
check(
  typeof quota?.action === 'string' && quota.action.includes('--continue-usage-limit'),
  'C: the quota item does not name the command that resolves it',
);
check(
  quota?.reportedResetAt === resetAt,
  'C: the quota item does not carry the reset instant its diagnosis rests on',
);

/* ══════════════════════ phase D — resolution ═══════════════════════════════ */

banner('D  one task moves on; its item goes, and only its item');

const escalatedName = `${String(escalated?.attentionId)}.json`;
const quotaName = `${String(quota?.attentionId)}.json`;

// The escalation is continued and the task becomes an ordinary machine-known
// wait: a reset an hour away, over a record whose checkpoint is still withdrawn
// but whose instant has not arrived. That is silent by the same predicate.
rewrite(statePathOf(repoA.root, 'HD-1'), {
  state: 'BLOCKED_USAGE_LIMIT',
  reportedResetAt: new Date(Date.now() + 3_600_000).toISOString(),
  blockedAgent: 'claude',
});

const resolved = runCli(
  ['repositories', ...BASE_ARGS, '--wait-for-reset', '--max-wait-ms', '1000', '--max-cycles', '2'],
  homeControl,
);
const resolvedOutbox = outbox(homeControl);
checkRepositoryItems('D', resolvedOutbox);
process.stdout.write(`   items: ${resolvedOutbox.names.join(', ') || 'none'}\n`);

check(resolved.status !== 96, 'D: a socket was opened with no notification configuration');
// The condition is gone, so the item is gone. A stale item that stayed would
// send an operator to a task that no longer needs them.
check(
  !resolvedOutbox.taskNames.includes(escalatedName),
  'D: a resolved condition left its item behind',
);
// And **only** its item. The other repository's condition is untouched by the
// first one being settled, which is what stops a run over a changing registry
// from emptying an operator's inbox.
check(
  resolvedOutbox.taskNames.includes(quotaName),
  'D: resolving one condition removed an unrelated one',
);
check(
  resolvedOutbox.taskNames.length === 1,
  `D: expected exactly the surviving task item, found ${String(resolvedOutbox.taskNames.length)}`,
);

/* ══════════════════════ phase E — two schedulers ═══════════════════════════ */

banner('E  two processes, one record per condition');

const repoE1 = makeRepository('m3s2-race-1', ['HD-E1']);
parkTask(repoE1, 'HD-E1', { state: 'HUMAN_DECISION_REQUIRED' });
const repoE2 = makeRepository('m3s2-race-2', ['HD-E2']);
parkTask(repoE2, 'HD-E2', { state: 'HUMAN_DECISION_REQUIRED' });
const homeE = operatorProfile([repoE1.root, repoE2.root], 2);

const raceArgs = [
  'repositories',
  ...BASE_ARGS,
  '--wait-for-reset',
  '--max-wait-ms',
  '1000',
  '--max-cycles',
  '2',
  '--idle-poll-ms',
  '1000',
];
const raceOne = startCli(raceArgs, homeE);
const raceTwo = startCli(raceArgs, homeE);
const raceCodes = await withTimeout(
  Promise.all([raceOne.closed, raceTwo.closed]),
  600_000,
  'TIMEOUT',
);
check(raceCodes !== 'TIMEOUT', 'E: a racing scheduler never ended');
if (raceCodes === 'TIMEOUT') {
  for (const handle of [raceOne, raceTwo]) {
    try {
      handle.child.kill('SIGKILL');
    } catch {
      /* best effort */
    }
  }
}

const raceOutbox = outbox(homeE);
checkRepositoryItems('E', raceOutbox);
process.stdout.write(`   items: ${raceOutbox.names.join(', ') || 'none'}\n`);

// Two conditions, two records, whatever order the two processes found them in.
// The exclusive create is the whole mechanism: two processes deriving one
// condition derive one name, and the kernel gives the file to one of them.
check(
  raceOutbox.taskNames.length === 2,
  `E: two schedulers over two conditions produced ${String(raceOutbox.taskNames.length)} task records`,
);
check(
  new Set(raceOutbox.taskRecords.map((record) => record.taskId)).size === 2,
  'E: the two records do not name two different tasks',
);
check(
  raceOutbox.records.every(
    (record) => typeof record.attentionId === 'string' && record.action.length > 0,
  ),
  'E: a record was written torn or half-formed',
);
// Neither process reported the other's egress tripwire, and neither crashed.
check(
  raceOne.exitCode() !== 96 && raceTwo.exitCode() !== 96,
  'E: a racing scheduler opened a socket with no configuration',
);
check(
  raceOne.exitCode() !== 97 && raceTwo.exitCode() !== 97,
  'E: a racing preload did not take',
);

/* ══════════════════════ phase F — reconstruction ═══════════════════════════ */

banner('F  the store is deleted, and a different process finds the same thing');

// The crash window, stood in for deterministically. A process that reaches a
// human-action state and dies before recording anything leaves exactly this: the
// condition in the task's own durable state and nothing in the store. Racing a
// real kill into that window would be a flaky gate measuring the scheduler; what
// matters is that the *next* process is not relying on anything the dead one
// held, and deleting the store proves that directly.
rmSync(join(homeE, '.agent-orchestrator', 'operator-attention'), {
  recursive: true,
  force: true,
});
check(outbox(homeE).names.length === 0, 'F: the store was not actually emptied');

const rebuilt = runCli(
  ['repositories', ...BASE_ARGS, '--wait-for-reset', '--max-wait-ms', '1000', '--max-cycles', '2'],
  homeE,
);
const rebuiltOutbox = outbox(homeE);
checkRepositoryItems('F', rebuiltOutbox);
process.stdout.write(`   items: ${rebuiltOutbox.names.join(', ') || 'none'}\n`);

check(rebuilt.status !== 96, 'F: a socket was opened with no notification configuration');
check(
  rebuiltOutbox.taskNames.length === 2,
  `F: a fresh process rebuilt ${String(rebuiltOutbox.taskNames.length)} of 2 task items`,
);
check(
  rebuiltOutbox.taskNames.join(',') === raceOutbox.taskNames.join(','),
  'F: the rebuilt items have different identities, so the identity is not a function of the record',
);

/* ═══════════════════════════════ the verdict ═══════════════════════════════ */

for (const path of created.reverse()) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // A locked Git file on Windows must not fail an otherwise passing run.
  }
}

if (failures.length > 0) {
  process.stderr.write(`\nrecurring-operation: ${String(failures.length)} failure(s)\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`\nrecurring-operation: ${String(checks)} checks passed\n`);
