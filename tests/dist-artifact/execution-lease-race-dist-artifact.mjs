#!/usr/bin/env node
/**
 * V2-07L — the execution lease survives real concurrent processes.
 *
 * Standalone Node script, deliberately not a vitest test file, and run by the
 * `test:dist-lease-race` npm script (and transitively by `verify`). It exists
 * because the one claim the in-process counter-proofs *cannot* make is the one
 * the whole slice rests on:
 *
 * > Two writers reaching for the lease at the same moment: exactly one gets it.
 *
 * A second `acquire` in one process proves that `open(…, 'wx')` refuses a file
 * that is already there. It does not prove the claim is **atomic**, because two
 * synchronous calls in one thread cannot interleave — the property under test is
 * exactly the one a single-threaded test cannot put under stress. V2-07 shipped
 * a store whose "only if there is none" passed every single-process test it had
 * and lost writes to a concurrent second caller; this is the check that would
 * have caught that, applied to its replacement.
 *
 * So: N real OS processes, started as close to simultaneously as this platform
 * allows, all racing for one lease, repeated over several rounds.
 *
 * It runs against **dist** for the same reason its two siblings here do — the
 * claim is about the shipped artefact, not about source a test runner
 * transpiled — and it therefore reaches the module through an explicit absolute
 * `file://` URL, with no vitest resolution and no tsconfig path mapping in the
 * way.
 *
 * Contract: exit code 0 means every round produced exactly one winner. Any
 * nonzero exit means at least one did not.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const distEntry = join(repoRoot, 'dist', 'lease', 'execution-lease.js');

/** How many processes race for one lease. */
const RACERS = 16;
/** How many independent races are run. A single round can be lucky. */
const ROUNDS = 8;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(distEntry)) {
  console.error(
    'dist/lease/execution-lease.js does not exist. Run "npm run build" before this check ' +
      '(see the "verify:dist-lease-race" npm script, which does this for you).',
  );
  process.exit(1);
}

/**
 * One racer, as source handed to `node --input-type=module -e`.
 *
 * It imports the shipped module, waits on a shared start barrier — a file the
 * parent creates once every child is up — and then makes exactly one attempt.
 * Without the barrier the children would start milliseconds apart and the
 * "race" would reliably resolve in start order, which proves nothing.
 *
 * It prints one line: `ACQUIRED <path>` or `REFUSED <code>`. Nothing else ever
 * reaches stdout, so the parent can read the result without parsing noise.
 */
const RACER_SOURCE = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireRepositoryExecutionLease } from ${JSON.stringify(pathToFileURL(distEntry).href)};

// Read from the environment rather than from argv. With \`node -e\`, argv carries
// no script path, so the usual \`slice(2)\` silently drops the first value — an
// off-by-one that produced an undefined barrier path and a child that span
// forever. The environment has no such ambiguity.
const root = process.env.AO_RACE_DIR;
const start = process.env.AO_RACE_START;
const finish = process.env.AO_RACE_FINISH;
const ready = process.env.AO_RACE_READY;

/** Waits for a barrier file, bounded so a harness defect fails rather than hangs. */
const waitFor = (path, label) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      readFileSync(path);
      return;
    } catch {
      if (Date.now() > deadline) {
        process.stderr.write(label + ' barrier never appeared');
        process.exit(2);
      }
    }
  }
};

// Announce readiness only after the module is imported and warm, then wait.
//
// The first version wrote the start barrier as soon as the spawn loop finished
// — tens of milliseconds before any child had booted Node and imported the
// shipped module. Every child found the barrier already present and the race
// resolved in process-boot order, which proves nothing. The adversarial review
// measured that; the handshake below is the fix. The parent releases only once
// every racer is parked on the barrier.
writeFileSync(ready, 'ready', 'utf8');
waitFor(start, 'start');

// The record is a repository shape, not a directory twice.
//
// This passed the same directory as both root and common dir until acquire
// began proving that a record describes one repository - and no clone has its
// common dir *at* its root. The parent makes the .git directory; every racer
// names the same pair, which is the point of a race.
const result = acquireRepositoryExecutionLease(
  { gitCommonDir: join(root, '.git'), root, id: 'race-fixture' },
  { runId: null, blockId: null },
  { now: () => new Date().toISOString() },
);
process.stdout.write(result.ok ? 'ACQUIRED ' + result.path : 'REFUSED ' + result.code);

// Answer, then stay alive until every racer has answered.
//
// Without this the winner exits the instant it has the lease, and the losers
// then probe an owner that is genuinely gone — so they report
// STALE_LEASE_RECOVERY_UNSAFE, correctly, and the harness measures process
// teardown rather than contention. The question under test is what a *live*
// owner looks like to a competitor.
waitFor(finish, 'finish');
`;

/** Runs one race and resolves to the racers' answers. */
async function race(round) {
  const dir = mkdtempSync(join(tmpdir(), `ao-lease-race-${String(round)}-`));
  // The common dir the racers will name. Made here, once, before any of them
  // starts: acquire proves the record is a coherent repository, and a race in
  // which every competitor is refused for the same reason measures nothing.
  mkdirSync(join(dir, '.git'), { recursive: true });
  const start = join(dir, 'start');
  const finish = join(dir, 'finish');
  const readyOf = (index) => join(dir, `ready-${String(index)}`);

  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];

  try {
    /** @type {Promise<string>[]} */
    const answers = [];

    for (let index = 0; index < RACERS; index += 1) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', RACER_SOURCE], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          AO_RACE_DIR: dir,
          AO_RACE_START: start,
          AO_RACE_FINISH: finish,
          AO_RACE_READY: readyOf(index),
        },
      });
      children.push(child);
      answers.push(
        // Resolved on the racer's *answer*, not on its exit: every racer stays
        // alive until all of them have answered, so waiting for `close` here
        // would deadlock against the barrier this parent has not written yet.
        new Promise((resolveAnswer, rejectAnswer) => {
          let out = '';
          child.stdout.on('data', (chunk) => {
            out += String(chunk);
            if (out.includes('ACQUIRED') || out.includes('REFUSED')) resolveAnswer(out.trim());
          });
          child.on('error', rejectAnswer);
          child.on('close', () => {
            rejectAnswer(new Error(`racer exited before answering: ${out.trim()}`));
          });
        }),
      );
    }

    // Every child is *parked on the barrier* — not merely spawned — before any
    // of them is released. Writing the barrier straight after the spawn loop
    // released children that had not booted yet, so they left the gate in boot
    // order and the round measured process startup rather than contention.
    const readyDeadline = Date.now() + 60_000;
    for (;;) {
      let parked = 0;
      for (let index = 0; index < RACERS; index += 1) {
        if (existsSync(readyOf(index))) parked += 1;
      }
      if (parked === RACERS) break;
      if (Date.now() > readyDeadline) {
        throw new Error(`only ${String(parked)}/${String(RACERS)} racers reached the barrier`);
      }
    }
    writeFileSync(start, 'go', 'utf8');
    const collected = await Promise.all(answers);
    // Everybody has answered, so the owner may stand down.
    writeFileSync(finish, 'go', 'utf8');
    return collected;
  } finally {
    // Belt and braces: a racer that never saw the finish barrier must not
    // outlive the round it belongs to.
    writeFileSync(finish, 'go', 'utf8');
    for (const child of children) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

for (let round = 0; round < ROUNDS; round += 1) {
  let answers;
  try {
    answers = await race(round);
  } catch (error) {
    failures.push(`round ${String(round)} could not be run: ${String(error)}`);
    continue;
  }

  const winners = answers.filter((answer) => answer.startsWith('ACQUIRED'));
  const losers = answers.filter((answer) => answer.startsWith('REFUSED'));

  // The whole claim, in one line.
  check(
    winners.length === 1,
    `round ${String(round)}: expected exactly one winner, got ${String(winners.length)} — ` +
      JSON.stringify(answers),
  );
  check(
    winners.length + losers.length === RACERS,
    `round ${String(round)}: ${String(RACERS)} racers produced ${String(answers.length)} ` +
      `classifiable answers — ${JSON.stringify(answers)}`,
  );

  // And the losers' refusal must be the *held* one. A racer that lost to a
  // half-written lease would report STALE_LEASE_RECOVERY_UNSAFE, which is
  // correct in itself but would mean the winner's record was observable before
  // it was complete — the crash-window read, reached without a crash.
  for (const loser of losers) {
    check(
      loser === 'REFUSED LEASE_HELD',
      `round ${String(round)}: a loser refused with ${JSON.stringify(loser)} rather than ` +
        'LEASE_HELD, so the winner\'s record was readable before it was whole',
    );
  }
}

if (failures.length > 0) {
  console.error(`execution-lease race check FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `execution-lease race check passed: ${String(ROUNDS)} rounds x ${String(RACERS)} real ` +
    'processes, exactly one winner each.',
);
