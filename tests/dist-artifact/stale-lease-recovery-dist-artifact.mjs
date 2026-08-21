#!/usr/bin/env node
/**
 * V3 slice 5 — safe stale-lease recovery, against the shipped artefact, with a
 * real dead owner.
 *
 * ── Why the in-process suite cannot establish this ─────────────────────────
 *
 * This paragraph used to say that every "dead owner" in
 * `tests/v3-05-stale-lease-recovery.test.ts` was a substituted probe and that a
 * stub answering `NOT_FOUND` would pass the whole suite. Both were true when it
 * was written and neither is now: that suite's `staleLease` fixture drives the
 * **real** `osProcessLiveness`, and a stub would turn several of its cases red.
 * The justification is restated rather than left standing, because a check
 * defended by a false reason is a check nobody will keep.
 *
 * What that suite still does not do is let a second operating-system process
 * ever **hold** the lease. It starts one — `deadProcessId()` spawns a child and
 * waits for it, which is where the genuinely dead pid comes from — but the owner
 * named in every fixture is the vitest worker with the pid overwritten
 * afterwards. So the chain from a real acquisition, through the death of the
 * process that made it, to a real removal is never travelled end to end by one
 * owner. It also runs against `src`, not against what is shipped.
 *
 * (This paragraph said "never runs a second operating-system process", which the
 * very next clause contradicted: a dead pid has to come from a process that
 * genuinely started.)
 *
 * Both are what this file is for. The owner here is a **separate operating-system
 * process** that acquires the lease through the built artefact and exits still
 * holding it.
 *
 * ── The negative control, which is the load-bearing case ───────────────────
 *
 * Phase D keeps the owner **alive** and requires the recovery to refuse with
 * `OWNER_RUNNING`. Without it every `RECOVERED` above could be an instrument
 * that cannot tell a living process from a dead one, and the whole check would
 * be measuring nothing. A run in which phase D recovers the lease is a failure,
 * not a pass.
 *
 * ── What one round establishes ─────────────────────────────────────────────
 *
 *   A. **a lease with a complete, all-contained history and a genuinely dead
 *      owner is recovered** — the lease file is gone afterwards, the directory
 *      carries no quarantine or staging leftovers, and a fresh acquisition
 *      succeeds, which is what separates "the file is gone" from "the file is
 *      gone and the protocol still works";
 *   B. **a writer generation that was opened and never confirmed refuses** —
 *      the exact state a run killed mid-writer leaves behind, produced by a real
 *      process that exited between the two calls rather than by editing a file.
 *      The lease is byte-identical afterwards;
 *   C. **a lease with no history refuses** — every lease taken by a build older
 *      than this slice, and it does not become recoverable in hindsight;
 *   D. **a living owner refuses**, which is the control that gives A its meaning.
 *
 * Contract: exit code 0 means every round held all four. Any nonzero exit means
 * at least one did not.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const distLease = join(repoRoot, 'dist', 'lease', 'execution-lease.js');
const distMint = join(repoRoot, 'dist', 'core', 'internal', 'containment-attestation.js');

const LEASE_FILE_NAME = 'agent-orchestrator-execution-lease.json';
const LEDGER_FILE_NAME = 'agent-orchestrator-execution-lease.launches.json';

/** How many independent rounds. A single round can be lucky. */
const ROUNDS = 2;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

for (const artefact of [distLease, distMint]) {
  if (!existsSync(artefact)) {
    console.error(
      `${artefact} does not exist. Run "npm run build" before this check ` +
        '(see the "verify:dist-stale-recovery" npm script, which does this for you).',
    );
    process.exit(1);
  }
}

/**
 * The owner process, as source handed to `node --input-type=module -e`.
 *
 * It acquires the lease and then does whatever `AO_RECOVERY_PHASE` asks of it:
 * a full contained launch, an opened-and-abandoned one, a legacy lease with its
 * history deleted, or nothing at all. It prints `pid <n>` and `ready` and then
 * exits — except in the live phase, where it parks until it is killed, because
 * an owner that exited would make the control measure teardown instead of
 * liveness.
 *
 * Every attestation it mints is real: `mintContainmentAttestation` is the only
 * way to produce one, and a harness that fabricated the artefact would be
 * testing a hole the type exists to close.
 */
const OWNER_SOURCE = `
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireRepositoryExecutionLease,
  beginWriterLaunch,
  confirmWriterLaunch,
} from ${JSON.stringify(pathToFileURL(distLease).href)};
import { mintContainmentAttestation } from ${JSON.stringify(pathToFileURL(distMint).href)};

const root = process.env.AO_RECOVERY_DIR;
const phase = process.env.AO_RECOVERY_PHASE;
const repository = { gitCommonDir: join(root, '.git'), root, id: 'recovery-fixture' };
const now = () => new Date().toISOString();

const acquired = acquireRepositoryExecutionLease(repository, { runId: 'dist-run', blockId: null }, { now });
if (!acquired.ok) {
  process.stderr.write('owner could not take the lease: ' + acquired.code);
  process.exit(2);
}

const open = (writerId) => {
  const opened = beginWriterLaunch(repository, acquired.evidence, { writerId, now });
  if (opened.code !== 'OPENED') {
    process.stderr.write('owner could not open a generation: ' + opened.code);
    process.exit(3);
  }
  return opened.generation;
};

if (phase === 'CONTAINED') {
  // Two launches, both proved. The history the predicate must accept.
  //
  // A distinct launch nonce per launch, because that is what a real launch
  // produces and because \`confirmWriterLaunch\` refuses a digest that has already
  // proved another generation of this lease. A harness reusing one attestation
  // would be driving a replay the format rejects.
  for (const index of [0, 1]) {
    const generation = open('claude');
    const attestation = mintContainmentAttestation({
      ownerPid: process.pid,
      helperPid: 4242,
      childPid: 4343,
      mode: 'JOBLIST',
      assignedAtCreation: true,
      launchNonce: 'a1b2c3d4e5f6071' + String(index),
      attestedAt: now(),
      verifiedInJob: true,
    });
    if (attestation === null) {
      process.stderr.write('owner could not mint an attestation');
      process.exit(4);
    }
    const confirmed = confirmWriterLaunch(repository, acquired.evidence, attestation, {
      generation,
      writerId: 'claude',
      now,
    });
    if (confirmed.code !== 'CONFIRMED') {
      process.stderr.write('owner could not confirm: ' + confirmed.code);
      process.exit(5);
    }
  }
} else if (phase === 'PENDING') {
  // Opened and abandoned: this process dies between the two calls, which is the
  // state the whole poison-before-launch ordering exists to leave behind.
  open('claude');
} else if (phase === 'LEGACY') {
  // What a lease taken by an older build looks like.
  rmSync(join(root, '.git', ${JSON.stringify(LEDGER_FILE_NAME)}));
}

process.stdout.write('pid ' + process.pid + '\\n');
process.stdout.write('ready\\n');

if (phase === 'LIVE') {
  // Parked, deliberately. The control needs a process that is really running.
  writeFileSync(join(root, 'live'), 'yes', 'utf8');
  setInterval(() => {}, 1000);
}
`;

/** Runs one owner process and resolves with its pid once it says `ready`. */
function startOwner(root, phase) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', OWNER_SOURCE], {
      env: { ...process.env, AO_RECOVERY_DIR: root, AO_RECOVERY_PHASE: phase },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const match = /pid (\d+)/.exec(out);
      if (match !== null && out.includes('ready')) {
        resolvePromise({ pid: Number(match[1]), child });
      }
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('exit', (code) => {
      if (!out.includes('ready')) {
        rejectPromise(new Error(`owner (${phase}) exited ${String(code)}: ${err}`));
      }
    });
  });
}

/** Waits until the real probe says the pid is gone. Bounded, so a defect fails. */
async function waitUntilGone(processAlive, pid) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processAlive(pid) === 'NOT_FOUND') return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Quarantine and staging artefacts left in the administrative directory.
 *
 * Matched by the two shapes the protocol creates and discards — `.breaking-…`
 * and `.tmp-…` — rather than by "any sibling of the lease name that is not the
 * ledger". The exclusion form was one `recordContainmentEvidence` call away from
 * reporting the legitimate `…containment.json` companion as a leftover, which an
 * adversarial review pointed out before it could happen.
 */
function protocolLeftovers(root) {
  return readdirSync(join(root, '.git')).filter((name) =>
    /\.(?:breaking|tmp)-/.test(name.slice(LEASE_FILE_NAME.length)),
  );
}

const {
  acquireRepositoryExecutionLease,
  assessStaleLeaseRecovery,
  osProcessLiveness,
  recoverStaleLease,
} = await import(pathToFileURL(distLease).href);

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ao-v3-05-dist-'));
  roots.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  return { root, repository: { gitCommonDir: join(root, '.git'), root, id: 'recovery-fixture' } };
}

for (let round = 0; round < ROUNDS; round += 1) {
  /* ── A. a real dead owner with a proven history is recovered ───────────── */
  {
    const { root, repository } = fixture();
    const { pid } = await startOwner(root, 'CONTAINED');
    check(await waitUntilGone(osProcessLiveness, pid), `round ${round}: owner never went away`);

    const before = assessStaleLeaseRecovery(repository);
    check(
      before.verdict === 'SAFE_TO_RECOVER',
      `round ${round}: a proven history with a dead owner was ${before.refusal}`,
    );
    check(
      before.launchHistory === 'ALL_LAUNCHES_CONTAINED',
      `round ${round}: history read ${String(before.launchHistory)}`,
    );

    const recovered = recoverStaleLease(repository);
    check(recovered.code === 'RECOVERED', `round ${round}: recovery said ${recovered.code}`);
    check(
      !existsSync(join(root, '.git', LEASE_FILE_NAME)),
      `round ${round}: the lease file is still there after RECOVERED`,
    );
    check(
      protocolLeftovers(root).length === 0,
      `round ${round}: leftovers after recovery: ${protocolLeftovers(root).join(', ')}`,
    );

    // The protocol still works, which is the half a deletion alone does not give.
    const next = acquireRepositoryExecutionLease(
      repository,
      { runId: 'after-recovery', blockId: null },
      { now: () => new Date().toISOString() },
    );
    check(next.ok, `round ${round}: could not acquire after recovery: ${next.code}`);
  }

  /* ── B. an opened, unconfirmed generation refuses ──────────────────────── */
  {
    const { root, repository } = fixture();
    const { pid } = await startOwner(root, 'PENDING');
    check(await waitUntilGone(osProcessLiveness, pid), `round ${round}: owner never went away`);

    const leasePath = join(root, '.git', LEASE_FILE_NAME);
    const before = readFileSync(leasePath);
    const result = recoverStaleLease(repository);
    check(
      result.code === 'RECOVERY_UNSAFE' && result.refusal === 'LAUNCH_HISTORY_UNPROVEN',
      `round ${round}: a pending generation gave ${result.code}/${String(result.refusal)}`,
    );
    check(
      readFileSync(leasePath).equals(before),
      `round ${round}: the refused lease was modified`,
    );
  }

  /* ── C. a lease with no history refuses ────────────────────────────────── */
  {
    const { root, repository } = fixture();
    const { pid } = await startOwner(root, 'LEGACY');
    check(await waitUntilGone(osProcessLiveness, pid), `round ${round}: owner never went away`);

    const result = recoverStaleLease(repository);
    check(
      result.code === 'RECOVERY_UNSAFE' && result.refusal === 'LAUNCH_HISTORY_ABSENT',
      `round ${round}: a legacy lease gave ${result.code}/${String(result.refusal)}`,
    );
    check(
      existsSync(join(root, '.git', LEASE_FILE_NAME)),
      `round ${round}: the legacy lease was removed`,
    );
  }

  /* ── D. the control: a living owner refuses ────────────────────────────── */
  {
    const { root, repository } = fixture();
    const { pid, child } = await startOwner(root, 'LIVE');
    check(osProcessLiveness(pid) === 'ALIVE', `round ${round}: the live owner did not read ALIVE`);

    const result = recoverStaleLease(repository);
    check(
      result.code === 'RECOVERY_UNSAFE' && result.refusal === 'OWNER_RUNNING',
      `round ${round}: a LIVING owner gave ${result.code}/${String(result.refusal)} - ` +
        'this control is what gives every RECOVERED above its meaning',
    );
    check(
      existsSync(join(root, '.git', LEASE_FILE_NAME)),
      `round ${round}: a living owner's lease was removed`,
    );
    child.kill();
  }
}

for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A fixture we cannot remove is inert; it holds nothing open.
  }
}

if (failures.length > 0) {
  console.error(`stale-lease recovery: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `stale-lease recovery: ${ROUNDS} round(s) held all four phases, including the living-owner control.`,
);
