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
 * ── Three cohorts, and why the third exists ────────────────────────────────
 *
 * An independent review found the two-cohort version of this harness passing
 * while never once running the mechanism it is named after: with a single fixed
 * authorisation, every attempt after the first removal is refused at the *gate*
 * on the owner pid, so the detach, the restore, the EEXIST branch and the
 * quarantine never executed. Zero non-matching detaches in ~39,000 attempts. Its
 * "records still on disk" invariant was documented as separating displacement
 * from destruction while nothing was ever displaced.
 *
 *  - **fixed breakers** hold one authorisation for the stale victim. They
 *    exercise the gate, thousands of times.
 *  - **re-inspecting breakers** read the lease and break what they just read, so
 *    the gate passes and the *removal* decides. This is the cohort that reaches
 *    the detach and the restore.
 *  - **churning acquirers** acquire, hold briefly, and release, so the lease name
 *    changes hands constantly — which is what puts a detach and a stranger's
 *    record in the same instant.
 *
 * The current numbers per round: ~270 acquisitions, ~130 removals, 10-25
 * non-matching detaches, and a handful of records kept in quarantine.
 *
 * ── What this kills, and what it does not ──────────────────────────────────
 *
 * Measured by mutation, and stated in both directions because a check whose
 * reach is unstated reads as covering everything:
 *
 *  - **no identity binding at all** (the withdrawn v1 shape: decide from the
 *    inspection, remove by name) — every round reports 6 acquisitions and **0
 *    surviving records**. Dies here.
 *  - **discarding a record that could not be put back** (the v3 shape) — dies
 *    here, on the accountability check.
 *  - **restoring with `rename` instead of `link`** — **survives this harness.**
 *    On Windows a rename over an occupied name frequently fails outright and the
 *    exclusive-create fallback then refuses correctly, so the overwrite lands
 *    only in a narrower window than five rounds reliably hit. It is pinned
 *    deterministically instead, in `tests/v2-07lr-lease-recovery.test.ts` and
 *    `tests/v2-07lr-remediation.test.ts`, where the freed name is squatted from
 *    inside the removal's own predicate.
 *  - the binding inside the removal predicate is reachable here only in the
 *    moments before the first removal; it too is pinned deterministically, by
 *    opening the window through the liveness seam.
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

/** How many processes hold one fixed authorisation for the stale lease. */
const BREAKERS = 3;
/**
 * How many processes re-inspect and then break, over and over.
 *
 * This cohort is why the harness reaches the removal at all. See
 * INSPECTING_BREAKER_SOURCE: with only the fixed cohort, every attempt after the
 * first removal is refused at the gate on the owner pid, and the restore, the
 * EEXIST branch and the quarantine never execute.
 */
const INSPECTORS = 3;
/** How many processes acquire and release the lease, over and over. */
const ACQUIRERS = 4;
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
/**
 * How many times, across the whole run, a restore refused rather than succeeded.
 *
 * Its own counter because it is the one observation that distinguishes a restore
 * which *cannot* overwrite from one which does. A `link` that meets an occupied
 * name answers EEXIST and the record is kept in quarantine; a `rename` in the
 * same place silently overwrites whatever is there — the defect that withdrew
 * this command the first time — and can therefore never produce this outcome at
 * all. Counted across the run rather than per round, because it depends on a
 * real interleaving and a round can legitimately miss it.
 */
let quarantinedAcrossTheRun = 0;
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
import { readFileSync, writeFileSync, writeSync } from 'node:fs';

// Answers go to fd 1 synchronously, never through process.stdout.
//
// Belt and braces rather than a diagnosed fix, and worth saying so: every racer
// writes its answer and then spins in a synchronous barrier wait that never
// returns to the event loop, which is exactly the shape in which a buffered pipe
// write can sit unflushed until the process exits. A synchronous write to the
// descriptor removes the question. (It was my first theory for a round that
// hung, and it was wrong - the parent was watching for a cohort word that no
// cohort printed any more. No backticks in here, either: this text lives inside
// a template literal, and one of them ended the string and the module with it.)
const answer = (text) => { writeSync(1, text + String.fromCharCode(10)); };
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
answer('BREAK ' + [...tally].map(([key, count]) => key + '=' + String(count)).join(','));
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
import { acquireRepositoryExecutionLease, releaseRepositoryExecutionLease } from ${leaseHref};

writeFileSync(process.env.AO_RACE_READY, 'ready', 'utf8');
waitFor(process.env.AO_RACE_START, 'start');

// Churn, rather than acquire-once-and-hold.
//
// Holding was what the first version did, and an independent review showed what
// it cost: after the single legitimate removal the lease never changed again, so
// every later break was refused at the gate on the owner pid and the *removal*
// never saw a record it was not authorised for. Zero non-matching detaches in
// ~39,000 attempts — the restore, the EEXIST branch and the quarantine, which
// are the whole mechanism this file is named after, never ran at all.
//
// Acquiring and releasing in a loop makes the lease name change hands
// constantly, which is what puts a detach and a stranger's record in the same
// instant. Every acquisition and every release is reported, so the parent can
// tell a record its own acquirer gave up from one that was taken from it.
const deadline = Date.now() + ${String(ACQUIRE_WINDOW_MS)};
const events = [];
for (;;) {
  const result = acquireRepositoryExecutionLease(record, { runId: 'successor', blockId: null }, {
    now: () => new Date().toISOString(),
  });
  if (result.ok) {
    events.push('A:' + result.revision);
    // Hold it for a moment before giving it back.
    //
    // Without this the record sits at the lease name for microseconds, and a
    // restore that overwrites instead of refusing - the defect that withdrew
    // this command the first time - has almost no chance of landing inside that
    // window. A real run holds its lease for minutes; two milliseconds is the
    // smallest thing that makes the harness sensitive to the difference.
    const until = Date.now() + 2;
    while (Date.now() < until) { /* holding, as a run does */ }
    const released = releaseRepositoryExecutionLease(result.evidence);
    // Only a release that really removed the record may be reported as one. A
    // release refused because somebody else's record is at the name has given
    // nothing up, and counting it as such would excuse a destruction.
    if (released.code === 'RELEASED') events.push('R:' + result.revision);
  }
  if (Date.now() > deadline) break;
}
answer('ACQUIRER ' + events.join(','));
waitFor(process.env.AO_RACE_FINISH, 'finish');
`;

/**
 * The second breaker cohort: an operator who re-inspects before every attempt.
 *
 * The fixed-authorisation cohort above exercises the *gate* — thousands of
 * refusals on an owner pid that no longer matches. This one exists so the
 * *removal* is reached: its authorisation always describes the lease that was
 * there a moment ago, so the gate passes and what happens next is decided on the
 * bytes the detach produces. That is the code path the withdrawn versions of
 * this command died in, and until this cohort existed no harness had run it.
 */
const INSPECTING_BREAKER_SOURCE = `
${BARRIER_SOURCE}
import { readFileSync as read } from 'node:fs';
import { createHash } from 'node:crypto';
import { breakInspectedLease } from ${recoveryHref};

writeFileSync(process.env.AO_RACE_READY, 'ready', 'utf8');
waitFor(process.env.AO_RACE_START, 'start');

const leasePath = record.gitCommonDir + '/agent-orchestrator-execution-lease.json';
const deadline = Date.now() + ${String(BREAK_WINDOW_MS)};
const removed = [];
const tally = new Map();
for (;;) {
  let bytes = null;
  try { bytes = read(leasePath); } catch { bytes = null; }
  if (bytes !== null) {
    const revision = createHash('sha256').update(bytes).digest('hex');
    let ownerPid = null;
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      if (typeof value.ownerPid === 'number') ownerPid = value.ownerPid;
    } catch { ownerPid = null; }
    const result = breakInspectedLease(
      record,
      { expectedRevision: revision, expectedOwnerPid: ownerPid },
      { processAlive: () => 'NOT_FOUND' },
    );
    const key = result.outcome + (result.detail === null ? '' : ':' + result.detail);
    tally.set(key, (tally.get(key) ?? 0) + 1);
    // The revision this attempt was authorised for, recorded only when it says
    // it removed something. That is what makes a deletion accountable.
    if (result.outcome === 'LEASE_REMOVED') removed.push(revision);
  }
  if (Date.now() > deadline) break;
}
answer(
  'INSPECTOR ' + [...tally].map(([key, count]) => key + '=' + String(count)).join(',') +
    ' | REMOVED ' + removed.join(','),
);
waitFor(process.env.AO_RACE_FINISH, 'finish');
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
            // One prefix per cohort, and all three of them. When this listed only
            // the previous cohorts' words the new ones never resolved, so the
            // parent never released the finish barrier, every racer sat out its
            // thirty-second timeout and the round died reporting that a child
            // "exited before answering" — with the answer printed in the error.
            if (/BREAK |INSPECTOR |ACQUIRER /.test(out)) resolveAnswer(out.split('\n')[0].trim());
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
    for (let i = 0; i < INSPECTORS; i += 1) spawnRacer('inspect', INSPECTING_BREAKER_SOURCE, i);
    for (let i = 0; i < ACQUIRERS; i += 1) spawnRacer('acquire', ACQUIRER_SOURCE, i);

    // Everybody parked on the barrier before anybody is released, for the reason
    // the sibling harness records: children released as they boot leave the gate
    // in boot order, and the round then measures process startup.
    const readyDeadline = Date.now() + 60_000;
    for (;;) {
      let parked = 0;
      for (let i = 0; i < BREAKERS; i += 1) if (existsSync(readyOf('break', i))) parked += 1;
      for (let i = 0; i < INSPECTORS; i += 1) if (existsSync(readyOf('inspect', i))) parked += 1;
      for (let i = 0; i < ACQUIRERS; i += 1) if (existsSync(readyOf('acquire', i))) parked += 1;
      if (parked === BREAKERS + INSPECTORS + ACQUIRERS) break;
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

  const { answers, surviving, finalRevision } = outcome;
  const breaks = answers.filter((answer) => answer.startsWith('BREAK '));
  const inspectors = answers.filter((answer) => answer.startsWith('INSPECTOR '));
  const acquirers = answers.filter((answer) => answer.startsWith('ACQUIRER '));

  /** Every outcome:count pair either breaker cohort reported, flattened. */
  const tallies = [
    ...breaks.map((answer) => answer.slice('BREAK '.length)),
    ...inspectors.map((answer) => answer.slice('INSPECTOR '.length).split(' | REMOVED')[0] ?? ''),
  ]
    .flatMap((text) => text.split(','))
    .filter((entry) => entry.includes('='))
    .map((entry) => ({ outcome: entry.split('=')[0] ?? '', count: Number(entry.split('=')[1] ?? '0') }));
  const countOf = (prefix) =>
    tallies
      .filter((entry) => entry.outcome.startsWith(prefix))
      .reduce((total, entry) => total + entry.count, 0);

  // What the inspecting cohort was authorised to remove, and said it removed.
  const authorisedRemovals = new Set(
    inspectors.flatMap((answer) => {
      const removed = answer.split('| REMOVED ')[1] ?? '';
      return removed.split(',').filter((revision) => revision.length === 64);
    }),
  );

  const events = acquirers.flatMap((answer) => answer.slice('ACQUIRER '.length).split(','));
  const acquired = events.filter((event) => event.startsWith('A:')).map((event) => event.slice(2));
  const released = new Set(
    events.filter((event) => event.startsWith('R:')).map((event) => event.slice(2)),
  );

  const removalCount = countOf('LEASE_REMOVED');
  const nonMatchingDetaches = countOf('LEASE_CHANGED_SINCE_INSPECTION');
  const quarantined =
    countOf('LEASE_CHANGED_SINCE_INSPECTION:RECORD_QUARANTINED') +
    countOf('LEASE_BREAK_VERIFICATION_FAILED:UNREADABLE_AND_QUARANTINED');
  quarantinedAcrossTheRun += quarantined;
  const report = JSON.stringify({ answers, surviving, finalRevision });

  // Printed every round, not only on failure. A concurrency check that says
  // nothing when it passes is a check nobody can tell has stopped exercising
  // anything — and two earlier versions of this harness did exactly that.
  console.log(
    `  round ${String(index)}: ${String(acquired.length)} acquisitions, ` +
      `${String(released.size)} self-releases, ${String(removalCount)} removals, ` +
      `${String(nonMatchingDetaches)} non-matching detaches ` +
      `(${String(quarantined)} kept in quarantine), ` +
      `${String(surviving.length)} records on disk`,
  );

  check(
    breaks.length === BREAKERS && inspectors.length === INSPECTORS && acquirers.length === ACQUIRERS,
    `round ${String(index)}: cohorts answered ${String(breaks.length)}/${String(inspectors.length)}/` +
      `${String(acquirers.length)}, expected ${String(BREAKERS)}/${String(INSPECTORS)}/` +
      `${String(ACQUIRERS)} — ${report}`,
  );

  // The round must have opened the window at all.
  check(
    removalCount >= 1 && acquired.length >= 1,
    `round ${String(index)}: nothing was removed or nothing was acquired, so nothing raced — ${report}`,
  );

  // **The round must have reached the mechanism this file is named after.**
  //
  // This check exists because an independent review found the harness passing
  // while never once executing the removal's own decision: with a single fixed
  // authorisation, every attempt after the first removal is refused at the *gate*
  // on the owner pid, so the detach, the restore and the quarantine never ran.
  // A non-matching detach is the proof that they did.
  check(
    nonMatchingDetaches >= 1,
    `round ${String(index)}: no break ever detached a record it was not authorised for, so the ` +
      `restore this harness exists to test did not run — ${report}`,
  );

  // **The claim: every deletion is accountable to an authorisation.**
  //
  // A record an acquirer wrote may legitimately be gone for exactly two reasons:
  // its own acquirer released it, or a break that had inspected *that* record
  // removed it. Anything else is a record destroyed by an authorisation that did
  // not name it — the ABA this command was withdrawn for three times.
  //
  // Displacement is not destruction and is allowed: the record is then in a
  // `.breaking-` file, which `surviving` counts. The residual is that its writer
  // has lost authority, which it discovers at its next check.
  for (const revision of acquired) {
    if (released.has(revision)) continue;
    if (surviving.includes(revision)) continue;
    if (authorisedRemovals.has(revision)) continue;
    check(
      false,
      `round ${String(index)}: a record an acquirer wrote is gone, its acquirer never released ` +
        'it, and no break was authorised for it — a break destroyed an authority it did not ' +
        `name — ${report}`,
    );
  }

  // And every attempt answered from the vocabulary. A refusal that silently did
  // something would have to say so here first.
  for (const entry of tallies) {
    check(
      /^(LEASE_REMOVED|LEASE_CHANGED_SINCE_INSPECTION|LEASE_ALREADY_GONE|LEASE_NOT_BREAKABLE|LEASE_BREAK_VERIFICATION_FAILED)(:|$)/.test(
        entry.outcome,
      ),
      `round ${String(index)}: a break answered ${JSON.stringify(entry.outcome)} — ${report}`,
    );
  }
}

// The restore must have REFUSED somewhere in this run, not merely succeeded.
//
// Every check above is satisfied by a restore that always wins the race back to
// the freed name, and a restore that overwrites instead of refusing wins it
// every time by construction. This is what tells the two apart: a `link` meeting
// an occupied name keeps the record in quarantine, and a `rename` can never
// report that outcome because it never meets an occupied name at all.
check(
  quarantinedAcrossTheRun >= 1,
  'no restore was ever refused in this run, so nothing distinguishes a restore that cannot ' +
    'overwrite from one that does — either the interleaving did not happen, in which case run ' +
    'it again, or the restore is no longer refusing',
);

if (failures.length > 0) {
  console.error(`lease-break race check FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `lease-break race check passed: ${String(ROUNDS)} rounds x ${String(BREAKERS)} fixed breakers, ` +
    `${String(INSPECTORS)} re-inspecting breakers and ${String(ACQUIRERS)} churning acquirers; ` +
    'every deletion accountable to the authorisation that named it.',
);
