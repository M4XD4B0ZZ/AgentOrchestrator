#!/usr/bin/env node
/**
 * V2-07LR — an attended break never destroys a lease somebody else acquired.
 *
 * Standalone Node script, run by the `test:dist-lease-break-race` npm script and
 * transitively by `verify`. Its sibling
 * `execution-lease-race-dist-artifact.mjs` proves that concurrent *acquirers*
 * produce one winner; this one proves the other half, which is the half that
 * withdrew the command three times:
 *
 * > A break authorised for lease A, running while B legitimately acquires the
 * > same path, must never remove B.
 *
 * That is an ABA, and an ABA cannot be reproduced inside one process: the
 * interleaving that matters is between a decision and a syscall, and two
 * synchronous calls in one thread cannot interleave. The in-process suite opens
 * the window by hand through the liveness seam, which proves the check is in the
 * right place; only real processes prove it holds when nobody arranged the
 * timing.
 *
 * ── What is deliberately taken away from the breakers ──────────────────────
 *
 * Every breaker injects `processAlive: () => 'NOT_FOUND'`. A successor's owner
 * is alive, so the ordinary liveness refusal would stop every late break on its
 * own — and the harness would then pass without the identity binding existing at
 * all. Removing that refusal leaves exactly one thing between a break and a
 * legitimately acquired lease: the check on the bytes the removal has already
 * detached. This measures that, and nothing else.
 *
 * The victim lease is genuinely stale: a real child process acquires it and
 * exits, so its recorded owner is a pid that has been observed to end.
 *
 * ── What this catches, measured rather than hoped ──────────────────────────
 *
 * Against the withdrawn break's first version — decide from the inspection,
 * remove by name, no identity binding anywhere — every round reports 6
 * acquisitions, 7 removals and **0 surviving records**: each successor's lease
 * is deleted the instant it is written. Against the shipped implementation the
 * same rounds report one or two removals, one acquisition and that acquisition's
 * record still on disk.
 *
 * It is honest about which binding it exercises. The *gate* binding is hit
 * thousands of times per round; the binding inside the removal predicate is
 * reachable only in the microseconds before the first removal, because
 * afterwards the gate refuses every attempt on the owner pid. That one is pinned
 * deterministically in `tests/v2-07lr-lease-recovery.test.ts`, which opens the
 * window by hand through the liveness seam and kills its own mutant.
 *
 * ── A platform fact this harness discovered ────────────────────────────────
 *
 * Under this concurrency, `rename` on Windows can **report success without
 * having moved anything**: five racers out of six saw their rename return
 * cleanly and then found nothing at the name they had moved it to. (A plain
 * rename of a missing file throws `ENOENT` — the phantom success needs the
 * race.) `removeVerifiedLease` therefore reads the result of the detach rather
 * than trusting the call, and reports `ABSENT` where it used to report a
 * quarantined record that had never been created.
 *
 * Contract: exit code 0 means no round destroyed an acquirer's record.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const leaseEntry = join(repoRoot, 'dist', 'lease', 'execution-lease.js');
const recoveryEntry = join(repoRoot, 'dist', 'lease', 'lease-recovery.js');

/** How many processes try to break the same inspected lease at once. */
const BREAKERS = 6;
/** How many processes try to acquire the freed lease at the same moment. */
const ACQUIRERS = 6;
/** How many independent rounds. A single round can be lucky. */
const ROUNDS = 5;
/** How long each breaker keeps attempting. The window the race happens in. */
const BREAK_WINDOW_MS = 3_000;
/**
 * How long an acquirer keeps reaching before it reports that it never got in.
 *
 * Bounded just past the break window rather than generously, and the difference
 * is the whole runtime of this check. The lease can only become free while a
 * break is still attempting, so an acquirer that has not won by then never will
 * — it would spend the remaining seconds observing `LEASE_HELD` and reporting
 * exactly what it already knew. At 20 seconds the five losers of each round set
 * the pace and the harness took 103s; the signal is identical at 5.
 */
const ACQUIRE_WINDOW_MS = BREAK_WINDOW_MS + 2_000;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

for (const entry of [leaseEntry, recoveryEntry]) {
  if (!existsSync(entry)) {
    console.error(
      `${entry} does not exist. Run "npm run build" before this check (see the ` +
        '"verify:dist-lease-break-race" npm script, which does this for you).',
    );
    process.exit(1);
  }
}

const leaseHref = JSON.stringify(pathToFileURL(leaseEntry).href);
const recoveryHref = JSON.stringify(pathToFileURL(recoveryEntry).href);

/** The barrier helper both racer kinds share, as source. */
const BARRIER_SOURCE = `
import { readFileSync, writeFileSync } from 'node:fs';
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
const record = { gitCommonDir: process.env.AO_RACE_DIR + '/.git', root: process.env.AO_RACE_DIR, id: 'race-fixture' };
`;

/**
 * One breaker: an operator confirming the break they authorised for the victim.
 *
 * Liveness is neutralised on purpose — see the header. What is left is the
 * identity binding, which is the thing under test.
 */
const BREAKER_SOURCE = `
${BARRIER_SOURCE}
import { breakInspectedLease } from ${recoveryHref};

writeFileSync(process.env.AO_RACE_READY, 'ready', 'utf8');
waitFor(process.env.AO_RACE_START, 'start');

// The break is attempted repeatedly for a bounded window, and that is not
// stress for its own sake. A single attempt per breaker resolves in
// milliseconds — long before any acquirer has taken the freed name — so the
// interleaving under test never happens: an implementation with **no identity
// binding at all** passed a version of this harness that attempted once,
// because by the time a successor existed every breaker had already finished.
// Attempting across the window is what puts a break and a live successor in the
// same instant.
const deadline = Date.now() + ${String(BREAK_WINDOW_MS)};
const tally = new Map();
for (;;) {
  const result = breakInspectedLease(
    record,
    {
      expectedRevision: process.env.AO_RACE_REVISION,
      expectedOwnerPid: Number(process.env.AO_RACE_OWNER),
    },
    { processAlive: () => 'NOT_FOUND' },
  );
  const key = result.outcome + (result.detail === null ? '' : ':' + result.detail);
  tally.set(key, (tally.get(key) ?? 0) + 1);
  if (Date.now() > deadline) break;
}
// A tally rather than a list: one breaker makes thousands of attempts in the
// window, and a failure report has to stay readable.
process.stdout.write(
  'BREAK ' + [...tally].map(([key, count]) => key + '=' + String(count)).join(',') + '\\n',
);
waitFor(process.env.AO_RACE_FINISH, 'finish');
`;

/**
 * One acquirer: an ordinary run reaching for a repository that has just been
 * recovered. It keeps retrying until the lease is free, then holds it — a
 * winner that exited would leave a lease whose owner really is gone, and the
 * question here is what happens to a *live* successor's authority.
 */
const ACQUIRER_SOURCE = `
${BARRIER_SOURCE}
import { acquireRepositoryExecutionLease, verifyExecutionLeaseHeld } from ${leaseHref};

writeFileSync(process.env.AO_RACE_READY, 'ready', 'utf8');
waitFor(process.env.AO_RACE_START, 'start');

const deadline = Date.now() + ${String(ACQUIRE_WINDOW_MS)};
let answer = 'GAVE_UP';
let evidence = null;
for (;;) {
  const result = acquireRepositoryExecutionLease(record, { runId: 'successor', blockId: null }, {
    now: () => new Date().toISOString(),
  });
  if (result.ok) {
    evidence = result.evidence;
    answer = 'ACQUIRED ' + result.revision;
    break;
  }
  if (Date.now() > deadline) {
    answer = 'GAVE_UP ' + result.code;
    break;
  }
}
process.stdout.write(answer + '\\n');
waitFor(process.env.AO_RACE_FINISH, 'finish');

// The second line, and the one that carries the guarantee. "I acquired" is a
// claim about a moment; this is the question every productive writer in the
// build asks again before each effect, and it is the only sense in which a
// process still *holds* anything.
process.stdout.write('FINAL ' + (evidence === null ? 'NONE' : verifyExecutionLeaseHeld(evidence).code) + '\\n');
`;

/** The victim: acquires for real, then exits, leaving a genuinely dead owner. */
const VICTIM_SOURCE = `
import { acquireRepositoryExecutionLease } from ${leaseHref};
const root = process.env.AO_RACE_DIR;
const result = acquireRepositoryExecutionLease(
  { gitCommonDir: root + '/.git', root, id: 'race-fixture' },
  { runId: 'crashed', blockId: null },
  { now: () => new Date().toISOString() },
);
process.stdout.write(result.ok ? 'ACQUIRED ' + result.revision : 'REFUSED ' + result.code);
`;

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Runs `source` to completion and resolves to its stdout. */
function runToCompletion(source, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) resolveRun(out.trim());
      else rejectRun(new Error(`child exited ${String(code)}: ${err.trim() || out.trim()}`));
    });
  });
}

/** One round: a stale lease, N breakers and N acquirers released together. */
async function round(index) {
  const dir = mkdtempSync(join(tmpdir(), `ao-break-race-${String(index)}-`));
  mkdirSync(join(dir, '.git'), { recursive: true });
  const leasePath = join(dir, '.git', 'agent-orchestrator-execution-lease.json');
  const start = join(dir, 'start');
  const finish = join(dir, 'finish');
  const readyOf = (kind, i) => join(dir, `ready-${kind}-${String(i)}`);

  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];

  try {
    // The victim, taken and abandoned by a process that has since exited.
    const taken = await runToCompletion(VICTIM_SOURCE, { AO_RACE_DIR: dir });
    if (!taken.startsWith('ACQUIRED')) throw new Error(`victim did not acquire: ${taken}`);

    const victimBytes = readFileSync(leasePath);
    const victim = JSON.parse(victimBytes.toString('utf8'));
    const revision = digestOf(victimBytes);

    /** @type {Promise<string>[]} */
    const answers = [];
    /** @type {Promise<string>[]} */
    const finals = [];
    const spawnRacer = (kind, source, i) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          AO_RACE_DIR: dir,
          AO_RACE_START: start,
          AO_RACE_FINISH: finish,
          AO_RACE_READY: readyOf(kind, i),
          AO_RACE_REVISION: revision,
          AO_RACE_OWNER: String(victim.ownerPid),
        },
      });
      children.push(child);
      let out = '';
      // Two promises over one stream: the first answer, which the parent needs
      // before it may release the finish barrier, and everything the child said
      // by the time it exited, which is where an acquirer's re-proof lands.
      answers.push(
        new Promise((resolveAnswer, rejectAnswer) => {
          child.stdout.on('data', (chunk) => {
            out += String(chunk);
            if (/BREAK |ACQUIRED |GAVE_UP/.test(out)) resolveAnswer(out.split('\n')[0].trim());
          });
          child.on('error', rejectAnswer);
          child.on('close', () => {
            rejectAnswer(new Error(`${kind} exited before answering: ${out.trim()}`));
          });
        }),
      );
      finals.push(new Promise((resolveFinal) => child.on('close', () => resolveFinal(out.trim()))));
    };

    for (let i = 0; i < BREAKERS; i += 1) spawnRacer('break', BREAKER_SOURCE, i);
    for (let i = 0; i < ACQUIRERS; i += 1) spawnRacer('acquire', ACQUIRER_SOURCE, i);

    // Everybody parked on the barrier before anybody is released, for the reason
    // the sibling harness records: children released as they boot leave the gate
    // in boot order, and the round then measures process startup.
    const readyDeadline = Date.now() + 60_000;
    for (;;) {
      let parked = 0;
      for (let i = 0; i < BREAKERS; i += 1) if (existsSync(readyOf('break', i))) parked += 1;
      for (let i = 0; i < ACQUIRERS; i += 1) if (existsSync(readyOf('acquire', i))) parked += 1;
      if (parked === BREAKERS + ACQUIRERS) break;
      if (Date.now() > readyDeadline) {
        throw new Error(`only ${String(parked)} racers reached the barrier`);
      }
    }

    writeFileSync(start, 'go', 'utf8');
    const collected = await Promise.all(answers);
    const finalBytes = existsSync(leasePath) ? readFileSync(leasePath) : null;
    writeFileSync(finish, 'go', 'utf8');
    const transcripts = await Promise.all(finals);

    // Every record still on disk, wherever it ended up: at the lease name, or
    // detached into a quarantine file a break could not put back. This is what
    // separates "displaced" from "destroyed" — see the checks below.
    const surviving = new Set();
    if (finalBytes !== null) surviving.add(digestOf(finalBytes));
    for (const name of readdirSync(join(dir, '.git'))) {
      if (!name.includes('.breaking-')) continue;
      try {
        surviving.add(digestOf(readFileSync(join(dir, '.git', name))));
      } catch {
        /* a quarantine file being removed as we look is not a record */
      }
    }

    return {
      answers: collected,
      transcripts,
      surviving: [...surviving],
      finalRevision: finalBytes === null ? null : digestOf(finalBytes),
    };
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
  let outcome;
  try {
    outcome = await round(index);
  } catch (error) {
    failures.push(`round ${String(index)} could not be run: ${String(error)}`);
    continue;
  }

  const { answers, transcripts, surviving, finalRevision } = outcome;
  const breaks = answers.filter((answer) => answer.startsWith('BREAK '));
  const acquired = answers.filter((answer) => answer.startsWith('ACQUIRED '));
  const attempts = breaks.flatMap((answer) =>
    answer
      .slice('BREAK '.length)
      .split(',')
      .map((entry) => entry.split('=')[0]),
  );
  const removals = breaks.flatMap((answer) =>
    answer
      .slice('BREAK '.length)
      .split(',')
      .filter((entry) => entry.startsWith('LEASE_REMOVED='))
      .map((entry) => Number(entry.split('=')[1])),
  );
  const removalCount = removals.reduce((total, count) => total + count, 0);
  const report = JSON.stringify({ answers, transcripts, surviving, finalRevision });

  // Printed every round, not only on failure. A concurrency check that says
  // nothing when it passes is a check nobody can tell has stopped exercising
  // anything — and the first version of this harness did exactly that, passing
  // against an implementation with no identity binding at all because its
  // breakers had all finished before any successor existed.
  console.log(
    `  round ${String(index)}: ${String(attempts.length)} break attempt kinds, ` +
      `${String(removalCount)} removals, ${String(acquired.length)} acquisitions, ` +
      `${String(surviving.length)} records still on disk`,
  );

  check(
    breaks.length === BREAKERS,
    `round ${String(index)}: ${String(breaks.length)} breakers answered, expected ` +
      `${String(BREAKERS)} — ${report}`,
  );

  // The round has to have measured something: if the stale lease was never
  // removed, no acquirer could get in and the ABA window never opened.
  check(
    removalCount >= 1,
    `round ${String(index)}: no breaker removed the stale lease, so nothing raced — ${report}`,
  );

  // **The claim.** No record a successor legitimately wrote was destroyed.
  //
  // Stated as "still on disk somewhere" rather than "still at the lease name",
  // because those are two different guarantees and only the first one is made.
  // A break that detaches a stranger's record puts it back with a `link`; if the
  // freed name has been taken in that instant it cannot, and it *keeps* the
  // record in quarantine instead — inert, inspectable, and no longer authority.
  // That displacement is the residual `removeVerifiedLease` names and cannot
  // close without an atomic compare-and-delete no portable filesystem offers.
  //
  // What is never allowed is the record ceasing to exist: that is the ABA the
  // command was withdrawn for three times, and it is what this check fails on.
  // With the identity binding removed, every attempt deletes whatever it finds
  // and the acquirers' records vanish; with it, they are all still there.
  for (const answer of acquired) {
    const revision = answer.slice('ACQUIRED '.length).trim();
    check(
      surviving.includes(revision),
      `round ${String(index)}: a successor acquired the lease and its record no longer exists ` +
        'anywhere — a break destroyed a legitimately acquired authority — ' +
        report,
    );
  }

  // **The claim, and it is about authority rather than about claims.**
  //
  // "I acquired" is a statement about one moment. What the whole build rests on
  // is what `verifyExecutionLeaseHeld` answers *later*, because that is what
  // every writer asks before every effect. At most one process may still be
  // able to prove it holds the lease, and the file must be that process's.
  //
  // An acquirer that acquired and can no longer prove it has been **displaced**:
  // its record was detached between a break's gate and its rename and could not
  // be put back, because the freed name had been taken. `removeVerifiedLease`
  // names that residual and does not pretend to close it — no portable
  // filesystem offers the atomic compare-and-delete that would. It is bounded
  // exactly here: a displaced writer cannot write, because it fails this check.
  const stillHolding = transcripts.filter((transcript) => /\bFINAL HELD\b/.test(transcript));
  check(
    stillHolding.length <= 1,
    `round ${String(index)}: ${String(stillHolding.length)} processes can still prove they hold ` +
      `one lease — ${report}`,
  );

  const winner = acquired.find((answer) => {
    const revision = answer.slice('ACQUIRED '.length).trim();
    return revision === finalRevision;
  });
  if (stillHolding.length === 1) {
    check(
      winner !== undefined,
      `round ${String(index)}: a process proves it holds the lease and the file on disk is ` +
        `${finalRevision === null ? 'gone' : 'not the one it wrote'} — ${report}`,
    );
  }

  // And every attempt answered from the vocabulary. A refusal that silently did
  // something would have to say so here first.
  for (const attempt of attempts) {
    check(
      /^(LEASE_REMOVED|LEASE_CHANGED_SINCE_INSPECTION|LEASE_ALREADY_GONE|LEASE_NOT_BREAKABLE|LEASE_BREAK_VERIFICATION_FAILED)(:|$)/.test(
        attempt,
      ),
      `round ${String(index)}: a break answered ${JSON.stringify(attempt)} — ${report}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`lease-break race check FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `lease-break race check passed: ${String(ROUNDS)} rounds x ${String(BREAKERS)} breakers and ` +
    `${String(ACQUIRERS)} acquirers, no acquired lease destroyed.`,
);
