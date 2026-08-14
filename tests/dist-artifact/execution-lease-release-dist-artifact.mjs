#!/usr/bin/env node
/**
 * V2-07LR — a release is an effect, measured against the shipped artefact.
 *
 * ── Why this exists, and what removing its predecessor cost ────────────────
 *
 * The sibling check here (`execution-lease-race-dist-artifact.mjs`) measures
 * the *claim*: N real processes reach for one lease and exactly one gets it.
 * Nothing measured the other half — that giving the lease back actually
 * destroys it — until a real-process break harness did, incidentally, and that
 * harness was withdrawn together with the attended break it existed for.
 *
 * What went with it was not a duplicate assertion. It was the only measurement
 * in the repository of the release **effect** against the built artefact, and
 * its absence is invisible to a green gate: every in-process test can pass
 * while `removeVerifiedLease` returns `'REMOVED'` without touching the disk.
 * That mutant is this file's acceptance criterion — replacing the body of
 * `removeVerifiedLease` with `return 'REMOVED'` **must** make this check fail.
 *
 * ── What one round establishes ─────────────────────────────────────────────
 *
 * Real processes, because the properties are about a directory that several
 * writers share, and `dist`, because the claim is about the artefact this
 * repository ships rather than about source a test runner transpiled.
 *
 *   1. **exactly one owner** — every racer attempts the claim from a common
 *      barrier, and exactly one succeeds; every loser is refused with
 *      `LEASE_HELD`, which is the refusal that proves it saw a *complete*
 *      record rather than a half-written one;
 *   2. **a successful release destroys the lease** — after the owner reports
 *      `RELEASED`, the lease name holds nothing;
 *   3. **and leaves nothing behind** — no `.breaking-…` quarantine record, no
 *      `.tmp-…` staging file: nothing in the administrative directory whose
 *      name this protocol owns;
 *   4. **the repository is genuinely free afterwards** — the same racers
 *      contend a second time and exactly one wins again, which is what
 *      distinguishes "the file is gone" from "the file is gone and the
 *      protocol still works". A second release then has to leave the
 *      directory clean once more.
 *
 * Contract: exit code 0 means every round held all four. Any nonzero exit means
 * at least one did not.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const distEntry = join(repoRoot, 'dist', 'lease', 'execution-lease.js');

/** The file name the protocol owns. Every artefact of it begins with this. */
const LEASE_FILE_NAME = 'agent-orchestrator-execution-lease.json';

/**
 * How many processes contend for one lease.
 *
 * Fewer than the race check's sixteen, deliberately: this one runs two
 * contended phases per round and its subject is the *effect* of the release,
 * which one loser establishes as well as fifteen do. The exclusivity claim is
 * the sibling's job, at the width it needs.
 */
const RACERS = 6;
/** How many independent rounds. A single round can be lucky. */
const ROUNDS = 4;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(distEntry)) {
  console.error(
    'dist/lease/execution-lease.js does not exist. Run "npm run build" before this check ' +
      '(see the "verify:dist-lease-release" npm script, which does this for you).',
  );
  process.exit(1);
}

/**
 * One racer, as source handed to `node --input-type=module -e`.
 *
 * It parks on a barrier, claims, reports, waits to be told to release, releases
 * if it is the owner, reports again, then does both once more for the second
 * phase. Every line it prints is `<tag> <value>`, so the parent reads results
 * without parsing prose.
 *
 * It stays alive until the parent releases the `finish` barrier: an owner that
 * exited the instant it had the lease would make every loser probe a dead
 * process, and the round would measure teardown instead of contention.
 */
const RACER_SOURCE = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireRepositoryExecutionLease,
  releaseRepositoryExecutionLease,
} from ${JSON.stringify(pathToFileURL(distEntry).href)};

const root = process.env.AO_RELEASE_DIR;
const ready = process.env.AO_RELEASE_READY;

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

const repository = { gitCommonDir: join(root, '.git'), root, id: 'release-fixture' };
const attempt = () =>
  acquireRepositoryExecutionLease(repository, { runId: null, blockId: null }, {
    now: () => new Date().toISOString(),
  });

// Announce readiness only once the shipped module is imported and warm, then
// wait: a racer released before it has booted leaves the gate in start order,
// which measures process startup rather than contention.
writeFileSync(ready, 'ready', 'utf8');

for (const phase of ['1', '2']) {
  waitFor(process.env['AO_RELEASE_START_' + phase], 'start ' + phase);
  const claimed = attempt();
  process.stdout.write(
    'CLAIM' + phase + ' ' + (claimed.ok ? 'ACQUIRED' : 'REFUSED ' + claimed.code) + '\\n',
  );

  waitFor(process.env['AO_RELEASE_RELEASE_' + phase], 'release ' + phase);
  if (claimed.ok) {
    const given = releaseRepositoryExecutionLease(claimed.evidence);
    process.stdout.write('RELEASE' + phase + ' ' + given.code + ' ' + String(given.detail) + '\\n');
  } else {
    process.stdout.write('RELEASE' + phase + ' NONE null\\n');
  }
}

waitFor(process.env.AO_RELEASE_FINISH, 'finish');
`;

/** Every entry in the administrative directory whose name the protocol owns. */
function leaseArtefactsIn(gitCommonDir) {
  return readdirSync(gitCommonDir).filter((name) => name.startsWith(LEASE_FILE_NAME));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Waits until `predicate` holds, or throws `describe()`.
 *
 * Asynchronous rather than a spin, and that is not a style choice: the racers'
 * answers arrive on `stdout` data events, so a synchronous wait would starve
 * the very handler whose result it is waiting for.
 */
async function until(predicate, describe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(describe());
    await sleep(5);
  }
}

/** Runs one round and returns what its racers reported. */
async function round(index) {
  const dir = mkdtempSync(join(tmpdir(), `ao-lease-release-${String(index)}-`));
  const gitCommonDir = join(dir, '.git');
  // Made before any racer starts: acquire proves the record describes one
  // repository, and a round in which everybody is refused for the same reason
  // measures nothing.
  mkdirSync(gitCommonDir, { recursive: true });
  const leasePath = join(gitCommonDir, LEASE_FILE_NAME);
  const barrier = (name) => join(dir, name);
  const readyOf = (racer) => join(dir, `ready-${String(racer)}`);
  const finish = barrier('finish');

  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const noise = [];

  try {
    for (let racer = 0; racer < RACERS; racer += 1) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', RACER_SOURCE], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          AO_RELEASE_DIR: dir,
          AO_RELEASE_READY: readyOf(racer),
          AO_RELEASE_START_1: barrier('start-1'),
          AO_RELEASE_START_2: barrier('start-2'),
          AO_RELEASE_RELEASE_1: barrier('release-1'),
          AO_RELEASE_RELEASE_2: barrier('release-2'),
          AO_RELEASE_FINISH: finish,
        },
      });
      children.push(child);
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
        const complete = out.split('\n');
        out = complete.pop() ?? '';
        for (const line of complete) if (line.trim() !== '') lines.push(line.trim());
      });
      child.stderr.on('data', (chunk) => noise.push(String(chunk)));
    }

    const answers = (tag) => lines.filter((line) => line.startsWith(tag));
    const reported = () => `answers so far ${JSON.stringify(lines)}${noise.length === 0 ? '' : `, stderr ${JSON.stringify(noise)}`}`;

    // Every racer parked on the barrier — not merely spawned — before any of
    // them is released.
    await until(
      () => children.every((_, racer) => existsSync(readyOf(racer))),
      () => `round ${String(index)}: not every racer reached the first barrier; ${reported()}`,
    );

    /** One contended phase: claim, verify exclusivity, release, verify the effect. */
    const phase = async (number) => {
      writeFileSync(barrier(`start-${String(number)}`), 'go', 'utf8');
      await until(
        () => answers(`CLAIM${String(number)}`).length === RACERS,
        () =>
          `round ${String(index)} phase ${String(number)}: not every racer answered the claim; ` +
          reported(),
      );

      const claims = answers(`CLAIM${String(number)}`);
      const winners = claims.filter((line) => line.endsWith('ACQUIRED'));
      const losers = claims.filter((line) => line.includes('REFUSED'));

      // 1. Exactly one owner, and the losers saw a complete record.
      check(
        winners.length === 1,
        `round ${String(index)} phase ${String(number)}: expected exactly one owner, got ` +
          `${String(winners.length)} — ${JSON.stringify(claims)}`,
      );
      check(
        winners.length + losers.length === RACERS,
        `round ${String(index)} phase ${String(number)}: ${String(RACERS)} racers produced ` +
          `${String(claims.length)} classifiable answers — ${JSON.stringify(claims)}`,
      );
      for (const loser of losers) {
        check(
          loser === `CLAIM${String(number)} REFUSED LEASE_HELD`,
          `round ${String(index)} phase ${String(number)}: a loser refused with ` +
            `${JSON.stringify(loser)} rather than LEASE_HELD, so the owner's record was ` +
            'readable before it was whole',
        );
      }
      // The lease is on disk while it is held. Without this the checks below
      // would also pass against a build that never wrote one.
      check(
        existsSync(leasePath),
        `round ${String(index)} phase ${String(number)}: the lease name holds nothing while ` +
          'it is held',
      );

      writeFileSync(barrier(`release-${String(number)}`), 'go', 'utf8');
      await until(
        () => answers(`RELEASE${String(number)}`).length === RACERS,
        () =>
          `round ${String(index)} phase ${String(number)}: not every racer answered the release; ` +
          reported(),
      );

      const released = answers(`RELEASE${String(number)}`).filter((line) => !line.endsWith('NONE null'));
      check(
        released.length === 1 && released[0] === `RELEASE${String(number)} RELEASED null`,
        `round ${String(index)} phase ${String(number)}: the owner reported ` +
          `${JSON.stringify(released)} rather than a plain RELEASED`,
      );

      // 2. A successful release destroys the lease…
      check(
        !existsSync(leasePath),
        `round ${String(index)} phase ${String(number)}: the owner reported RELEASED and the ` +
          'lease is still at its name',
      );
      // 3. …and leaves nothing of it behind. A quarantine record left here is a
      // full copy of a lease document sitting in the Git administrative
      // directory, which nothing in the build ever removes.
      const leftovers = leaseArtefactsIn(gitCommonDir);
      check(
        leftovers.length === 0,
        `round ${String(index)} phase ${String(number)}: the release left ` +
          `${JSON.stringify(leftovers)} behind`,
      );
    };

    await phase(1);
    // 4. And the repository is genuinely free: the same racers contend again.
    await phase(2);
  } finally {
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

for (let index = 0; index < ROUNDS; index += 1) {
  try {
    await round(index);
  } catch (error) {
    failures.push(`round ${String(index)} could not be run: ${String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(`execution-lease release check FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `execution-lease release check passed: ${String(ROUNDS)} rounds x 2 contended phases x ` +
    `${String(RACERS)} real processes; every release destroyed its lease and left nothing behind.`,
);
