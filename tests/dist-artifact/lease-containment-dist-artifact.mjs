#!/usr/bin/env node
/**
 * V3 slice 4 — containment evidence, end to end, against the shipped artefact.
 *
 * Standalone Node script, deliberately not a vitest test file, and run by the
 * `test:dist-lease-containment` npm script (and transitively by `verify`). It
 * exists because the in-process suite cannot make the one claim the whole slice
 * rests on:
 *
 * > A real command, run through the productive Windows path, is created inside a
 * > job this process owns, and the lease it holds ends up carrying that fact.
 *
 * `tests/v3-04-lease-containment.test.ts` drives the substituted `start` seam,
 * because the boundary executable is resolved relative to the compiled adapter
 * and does not exist under `src`. That seam supplies the very values the mint
 * reads, so those cases prove the *gate* — which endings may attest and which
 * may not — and say nothing about whether a real launch produces one at all.
 * Delete the mint call from `runOwnedCommand` and the entire in-process suite
 * still passes on the questions it is entitled to ask; this script does not.
 *
 * It therefore runs against **dist**, reaching every module through an explicit
 * absolute `file://` URL, with no vitest resolution and no tsconfig path
 * mapping in the way.
 *
 * ── Windows only, and stated rather than skipped quietly ───────────────────
 *
 * The owned path exists on `win32` and nowhere else. On another platform this
 * script says so and exits 0: `verify` runs on windows-latest, and a check that
 * pretended to measure containment on Linux would be worse than one that does
 * not run.
 *
 * Contract: exit code 0 means every case below held. Any nonzero exit means at
 * least one did not, and the failures are printed.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (process.platform !== 'win32') {
  console.log('lease-containment: not win32 — the owned path does not exist here. Nothing measured.');
  process.exit(0);
}

const required = [
  join(repoRoot, 'dist', 'lease', 'execution-lease.js'),
  join(repoRoot, 'dist', 'doctor', 'exec.js'),
  join(repoRoot, 'dist', 'native', 'ao-launch.exe'),
];
for (const path of required) {
  if (!existsSync(path)) {
    console.error(
      `${path} does not exist. Run "npm run build" before this check ` +
        '(see the "verify:dist-lease-containment" npm script, which does this for you).',
    );
    process.exit(1);
  }
}

const lease = await import(pathToFileURL(join(repoRoot, 'dist', 'lease', 'execution-lease.js')).href);
const containment = await import(
  pathToFileURL(join(repoRoot, 'dist', 'lease', 'containment-evidence.js')).href
);
const attestation = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'containment-attestation.js')).href
);
const exec = await import(pathToFileURL(join(repoRoot, 'dist', 'doctor', 'exec.js')).href);

/* ─────────────────────────────── fixtures ───────────────────────────────── */

/** @type {string[]} */
const roots = [];

/** A directory shaped like an ordinary clone: a work tree with its own `.git`. */
function repositoryFixture(id) {
  const root = mkdtempSync(join(tmpdir(), 'ao-v3-04-dist-'));
  roots.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  return { gitCommonDir: join(root, '.git'), root, id };
}

const now = () => new Date().toISOString();

/* ───────────────── case 1: a real owned run attests ─────────────────────── */

/**
 * A short, harmless, real command: this Node binary printing its version.
 *
 * `--version` rather than `-e <script>` because `runCommand` refuses any
 * argument that is not shell-inert, and that refusal is a contract of the path
 * being measured — working around it with a different runner would measure a
 * different path. The command still starts a real process behind the real
 * boundary, which is all this case needs.
 */
const result = await exec.runCommand(
  process.execPath,
  ['--version'],
  { env: { PATH: process.env.PATH ?? '' }, cwd: repoRoot, timeoutMs: 30_000 },
);

check(result.outcome === 'COMPLETED', `expected a completed run, got ${result.outcome}`);
check(
  result.stdout.trim() === process.version,
  `expected the child's own output, got ${JSON.stringify(result.stdout)}`,
);
check(
  attestation.isContainmentAttestation(result.containment),
  'a real owned run produced no containment attestation — the productive path is not attesting',
);

const facts = attestation.containmentFactsOf(result.containment);
check(facts !== null, 'the attestation carried no readable facts');
if (facts !== null) {
  check(facts.ownerPid === process.pid, `the job was coupled to ${facts.ownerPid}, not to this process`);
  check(Number.isInteger(facts.childPid) && facts.childPid > 0, 'no contained child pid was reported');
  check(Number.isInteger(facts.helperPid) && facts.helperPid > 0, 'no helper pid was reported');
  check(/^[0-9a-f]{64}$/.test(facts.launchDigest), 'the launch digest is not a digest');
}

/* ───────────── case 2: the lease carries it, and reads it back ──────────── */

const repository = repositoryFixture('dist-contained');
const acquired = lease.acquireRepositoryExecutionLease(
  repository,
  { runId: 'dist-run', blockId: null },
  { now },
);
check(acquired.ok === true, `could not take a lease: ${acquired.ok ? '' : acquired.code}`);

if (acquired.ok === true) {
  const location = lease.deriveExecutionLeaseLocation(repository);
  const before = readFileSync(location.path);
  check(
    JSON.parse(before.toString('utf8')).containment === undefined,
    'a freshly acquired lease already carried containment evidence',
  );
  check(
    lease.inspectRepositoryExecutionLease(repository).containment === 'ABSENT',
    'a freshly acquired lease did not read as ABSENT',
  );

  const recorded = lease.recordContainmentEvidence(repository, acquired.evidence, result.containment, {
    writerId: 'claude',
    now,
  });
  check(recorded.code === 'RECORDED', `recording refused: ${recorded.code} ${recorded.detail ?? ''}`);

  // The bytes on disk, read back with nothing from this process's memory.
  const after = JSON.parse(readFileSync(location.path, 'utf8'));
  check(after.ownerNonce === JSON.parse(before.toString('utf8')).ownerNonce, 'the owner nonce changed');
  check(after.runId === 'dist-run', 'the run id changed');
  check(after.containment?.evidenceVersion === containment.CONTAINMENT_EVIDENCE_VERSION, 'no versioned record');
  check(after.containment?.verifiedInJob === true, 'the record does not claim a verified job');
  check(after.containment?.ownerPid === process.pid, 'the record names another owner');

  const reading = lease.inspectRepositoryExecutionLease(repository).containment;
  check(reading === 'CONTAINED', `the recorded lease read back as ${reading}`);
  /* ─────── case 3: a tampered record is refused, on the same bytes ──────── */

  const tampered = { ...after, containment: { ...after.containment, childPid: after.containment.childPid + 1 } };
  writeFileSync(location.path, `${JSON.stringify(tampered, null, 2)}\n`);
  const tamperedReading = lease.inspectRepositoryExecutionLease(repository).containment;
  check(
    tamperedReading === 'NOT_THIS_LEASE',
    `a one-field edit to the shipped record read as ${tamperedReading}`,
  );
  // The lease itself is still perfectly readable: an enrichment may not lock a
  // repository.
  check(
    lease.inspectRepositoryExecutionLease(repository).state === 'HELD',
    'a tampered containment record made the lease unreadable',
  );

  /* ── case 4: a foreign holder's lease is never overwritten ───────────── */

  const successor = { ...after, ownerNonce: 'e'.repeat(64), runId: 'somebody-else' };
  const successorBytes = Buffer.from(`${JSON.stringify(successor, null, 2)}\n`, 'utf8');
  writeFileSync(location.path, successorBytes);
  const refused = lease.recordContainmentEvidence(repository, acquired.evidence, result.containment, {
    writerId: 'claude',
    now,
  });
  check(refused.code === 'NOT_OWNER', `recording over a successor's lease answered ${refused.code}`);
  check(
    readFileSync(location.path).equals(successorBytes),
    "recording modified a lease this run does not hold — the successor's bytes changed",
  );

  // Put our own record back so the release below has something of ours to give.
  writeFileSync(location.path, `${JSON.stringify(after, null, 2)}\n`);
  lease.releaseRepositoryExecutionLease(acquired.evidence);
}

/* ─────────── case 5: a refused launch attests nothing at all ────────────── */

const missing = await exec.runCommand(
  'ao-no-such-program-v3-04.exe',
  [],
  { env: { PATH: process.env.PATH ?? '' }, cwd: repoRoot, timeoutMs: 10_000 },
);
check(missing.outcome === 'NOT_FOUND', `expected NOT_FOUND, got ${missing.outcome}`);
check(missing.containment === undefined, 'a command that never ran carried a containment attestation');

/* ────────────────────────────── reporting ───────────────────────────────── */

for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A fixture we cannot remove is inert; it holds nothing open.
  }
}

if (failures.length > 0) {
  console.error('lease-containment: FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('lease-containment: a real owned run attested, the lease recorded it, and every refusal held.');
