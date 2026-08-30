/**
 * M2 slice 1 against the shipped artefact, with a real owner that dies while a
 * real contained writer is running.
 *
 * ── Why this gate exists ───────────────────────────────────────────────────
 *
 * The property this slice adds is about processes that outlive — or fail to
 * outlive — the process making the assertion, and the in-process suite cannot
 * reach it. There, the establishment mark is written by a vitest worker against
 * pids it chose, and the "writer" is a value; here an owner really takes the
 * lease, really starts a target the kernel places in a Job Object, and is really
 * terminated mid-writer with `taskkill /F` — no `/T`, so nothing but the owner is
 * asked to die and what happens to the tree is *measured* rather than arranged.
 *
 * It also runs the recovery through the **shipped CLI**, with no attendance flag
 * and no operator input, because that is the U1 claim: a scheduler that meets a
 * crashed repository can get it running again. A recovery reached only from a
 * test's import is not that claim.
 *
 * ── The four phases, and which one is the control ─────────────────────────
 *
 *   A  positive — owner killed mid-writer. The tree must be gone, the shipped
 *      `agent-loop lease recover` must remove the lease, and a fresh acquisition
 *      must then succeed.
 *   B  THE CONTROL — identical, except the processes the ledger records are
 *      deliberately still alive. The recovery must refuse
 *      `LAUNCH_TREE_STILL_RUNNING` and leave the lease byte-identical. Without
 *      this case every `RECOVERED` in phase A could be an instrument that cannot
 *      tell a live process from a dead one.
 *   C  the owner itself is still alive with an established launch. Must refuse
 *      `OWNER_RUNNING` — the conjunct that comes first — so the new arm cannot
 *      be reached past a living owner.
 *   D  the window this slice does NOT close: killed after the announcement and
 *      before the kernel confirmed membership. Must refuse
 *      `LAUNCH_HISTORY_UNPROVEN`, which is the honest answer and the reason U1 is
 *      narrowed rather than closed.
 *
 * Survivors are identified by heartbeat rather than by a process walk, for the
 * reason `launch-boundary-dist-artifact.mjs` records: a terminated process whose
 * object is still referenced looks alive in a walk.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const distLease = join(repoRoot, 'dist', 'lease', 'execution-lease.js');
const distStart = join(repoRoot, 'dist', 'boundary', 'start-owned-process.js');
const distMint = join(repoRoot, 'dist', 'core', 'internal', 'containment-attestation.js');
const distRepo = join(repoRoot, 'dist', 'repo', 'resolve-repository.js');
const cli = join(repoRoot, 'dist', 'cli', 'index.js');

const LEASE_FILE = 'agent-orchestrator-execution-lease.json';
const LEDGER_FILE = 'agent-orchestrator-execution-lease.launches.json';

let failures = 0;
const check = (condition, message) => {
  if (condition) {
    process.stdout.write(`  ok   ${message}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL ${message}\n`);
};

if (process.platform !== 'win32') {
  process.stdout.write('crash-recovery: Windows only; the boundary this measures exists nowhere else.\n');
  process.exit(0);
}
if (!existsSync(join(repoRoot, 'dist', 'native', 'ao-launch.exe'))) {
  process.stderr.write('crash-recovery: dist/native/ao-launch.exe is missing. Run `npm run build`.\n');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The owner: a real, separate process that takes a real lease and does what
 * `AO_CRASH_PHASE` asks before parking.
 *
 * Every attestation it mints is real — `mintContainmentAttestation` is the only
 * way to produce one — and in phases A, C and D every fact fed to it comes from
 * the boundary rather than from this harness. Phase B is the exception and says
 * so where it happens.
 */
const OWNER_SOURCE = `
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  acquireRepositoryExecutionLease,
  attestWriterLaunchEstablished,
  beginWriterLaunch,
  deriveExecutionLeaseLocation,
} from ${JSON.stringify(pathToFileURL(distLease).href)};
import { startOwnedProcess } from ${JSON.stringify(pathToFileURL(distStart).href)};
import { mintContainmentAttestation } from ${JSON.stringify(pathToFileURL(distMint).href)};
import { resolveRepository } from ${JSON.stringify(pathToFileURL(distRepo).href)};

const root = process.env.AO_CRASH_DIR;
const phase = process.env.AO_CRASH_PHASE;
const beat = process.env.AO_CRASH_BEAT;
const now = () => new Date().toISOString();
const fail = (why) => { process.stderr.write(why); process.exit(9); };

// Resolved, never hand-built. A record assembled here from the raw temp path
// and the resolver's answer for the same directory are two lease KEYS on a
// GitHub Windows runner, whose temp directory is an 8.3 short alias that the
// resolver returns in long form. This harness shipped that defect once: every
// phase passed locally and phase A failed both CI jobs, while B, C and D went
// green for the wrong reason - the CLI was looking at a path where no lease had
// ever been written. lifecycle-restart-dist-artifact.mjs records the same
// regression, and its remedy is the one applied here.
const resolved = await resolveRepository({ repositoryPath: root });
if (!resolved.ok) fail('RESOLVE ' + resolved.code + ' ' + String(resolved.detail));
const repository = resolved.repository;

const acquired = acquireRepositoryExecutionLease(repository, { runId: 'crash-run', blockId: null }, { now });
if (!acquired.ok) fail('ACQUIRE ' + acquired.code);

const opened = beginWriterLaunch(repository, acquired.evidence, { writerId: 'claude', now });
if (opened.code !== 'OPENED') fail('OPEN ' + opened.code);

// A target that beats and never ends, so its survival is measurable.
const BEATER =
  "import{writeFileSync}from'node:fs';let n=0;" +
  "setInterval(()=>{n+=1;writeFileSync(process.env.AO_CRASH_BEAT,String(n))},100);" +
  "setInterval(()=>{},1000);";

let facts = { helperPid: null, childPid: null };

if (phase === 'PENDING') {
  // Deliberately nothing. The generation stays announced-and-unconfirmed: the
  // window between the poison and the kernel's answer, which this slice narrows
  // and does not close.
} else if (phase === 'SURVIVOR') {
  // THE CONTROL. The ledger is made to name processes that are really running
  // and are NOT in any job of this owner's: started detached, so killing the
  // owner leaves them alive. The entry is otherwise a genuine minted
  // attestation, so what phase B measures is the liveness re-check and nothing
  // else.
  const one = spawn(process.execPath, ['-e', BEATER], {
    env: { ...process.env, AO_CRASH_BEAT: beat },
    detached: true,
    stdio: 'ignore',
  });
  one.unref();
  const two = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  two.unref();
  facts = { helperPid: two.pid, childPid: one.pid };
  const attestation = mintContainmentAttestation({
    ownerPid: process.pid,
    helperPid: two.pid,
    childPid: one.pid,
    mode: 'JOBLIST',
    assignedAtCreation: true,
    launchNonce: 'c0ffee00c0ffee01',
    attestedAt: now(),
    verifiedInJob: true,
  });
  if (attestation === null) fail('MINT');
  const marked = attestWriterLaunchEstablished(repository, acquired.evidence, attestation, {
    generation: opened.generation, writerId: 'claude', now,
  });
  if (marked.code !== 'ESTABLISHED') fail('ESTABLISH ' + marked.code);
} else {
  // Phases A and C: a REAL contained writer behind the real native boundary, and
  // the establishment mark written from the boundary's own facts — which is
  // exactly what \`loop/leased-spawns.ts\` does in production.
  const started = await startOwnedProcess({
    file: process.execPath,
    args: ['-e', BEATER],
    env: { ...process.env, AO_CRASH_BEAT: beat },
  });
  if (!started.established) fail('BOUNDARY ' + JSON.stringify(started.ending));
  const p = started.process;
  facts = { helperPid: p.helperPid, childPid: p.childPid };
  const attestation = mintContainmentAttestation({
    ownerPid: process.pid,
    helperPid: p.helperPid,
    childPid: p.childPid,
    mode: p.mode,
    assignedAtCreation: p.assignedAtCreation,
    launchNonce: p.launchNonce,
    attestedAt: now(),
    verifiedInJob: p.verifiedInJob,
  });
  if (attestation === null) fail('MINT');
  const marked = attestWriterLaunchEstablished(repository, acquired.evidence, attestation, {
    generation: opened.generation, writerId: 'claude', now,
  });
  if (marked.code !== 'ESTABLISHED') fail('ESTABLISH ' + marked.code);
}

// The lease path this owner will actually use, reported so the harness can
// require the two sides to name one object before it judges anything.
const location = deriveExecutionLeaseLocation(repository);
process.stdout.write(
  JSON.stringify({
    ownerPid: process.pid,
    ...facts,
    leasePath: location.ok ? location.path : null,
  }) + '\\nready\\n',
);
// Parked, holding the lease. The release in a \`finally\` is what never runs.
setInterval(() => {}, 1000);
`;

function startOwner(root, phase, beat) {
  return new Promise((ok, bad) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', OWNER_SOURCE], {
      env: { ...process.env, AO_CRASH_DIR: root, AO_CRASH_PHASE: phase, AO_CRASH_BEAT: beat },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += String(c);
      if (out.includes('ready')) ok(JSON.parse(out.split('\n')[0]));
    });
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('exit', (code) => {
      if (!out.includes('ready')) bad(new Error(`owner (${phase}) exited ${code}: ${err}${out}`));
    });
  });
}

const roots = [];
/**
 * A real Git repository, because the shipped CLI resolves one.
 *
 * `git init` rather than a hand-made `.git` directory: `resolveRepository` asks
 * Git itself, so a fabricated administrative directory is refused
 * `NOT_A_GIT_REPOSITORY` and the command never reaches the recovery it is here
 * to measure. Measured, not assumed - the first version of this harness made the
 * directory by hand and failed exactly that way.
 */
function fixture() {
  // Canonicalised for the reason `tests/helpers/canonical-temp-dir.ts` gives:
  // `tmpdir()` can be an 8.3 alias, and a fixture that keeps one hands a
  // different identity to whoever resolves it. This is not what fixes the
  // identity split - resolving on both sides is - but it keeps this file's own
  // `join(root, ...)` reads and the `git` cwd on the spelling the resolver
  // returns.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-m2-01-dist-')));
  roots.push(root);
  // `-b main`, and a first commit, because the profile declares a default branch
  // and `resolveRepository` refuses `DEFAULT_BRANCH_NOT_FOUND` for a repository
  // where it does not exist — which a freshly initialised one with no commits is.
  // Identity is set locally so the harness does not depend on the machine's.
  execFileSync('git', ['init', '--quiet', '-b', 'main', root], { stdio: 'pipe' });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('config', 'user.email', 'crash-fixture@example.invalid');
  git('config', 'user.name', 'crash fixture');
  git('commit', '--quiet', '--allow-empty', '-m', 'root');
  // And a repository profile, because `resolveRepository` requires one before it
  // will answer at all.
  //
  // THIS repository's own profile, with only the id changed, rather than a
  // minimal one written out here. A hand-written profile was tried first and was
  // refused `PROFILE_SCHEMA_INVALID`; more to the point, a literal copy of the
  // schema in a test file goes stale the first time the contract gains a
  // required field, and it goes stale as a *fixture* failure that looks like the
  // subject failing. The id is substituted so the profile and the lease document
  // the owner writes agree about which repository this is.
  mkdirSync(join(root, '.agent-orchestrator'), { recursive: true });
  writeFileSync(
    join(root, '.agent-orchestrator', 'repo-profile.yaml'),
    readFileSync(join(repoRoot, '.agent-orchestrator', 'repo-profile.yaml'), 'utf8')
      .replace(/^(\s*id:\s*).*$/m, '$1crash-fixture')
      // The one declaration that is turned off rather than satisfied. A required
      // remote would make every phase depend on a second repository existing,
      // and nothing this gate measures goes near a network — the lease and its
      // ledger are local files. Turning it off is narrower than inventing an
      // `origin` that no case uses.
      .replace(/^(\s*required:\s*)true\s*$/m, '$1false'),
    'utf8',
  );
  return { root };
}

/**
 * The repository record, obtained the way the product obtains it.
 *
 * Both this harness and the owner process call `resolveRepository`, and the
 * lease path each derives is compared before any phase is judged. That
 * comparison is this file's own regression control: without it a split identity
 * makes every refusal phase pass for the wrong reason, which is exactly what
 * happened on CI while every phase passed locally.
 */
async function resolvedRepository(root) {
  const resolution = await resolveRepository({ repositoryPath: root });
  check(resolution.ok === true, `fixture resolved (${resolution.ok ? 'ok' : resolution.code})`);
  return resolution.ok ? resolution.repository : null;
}

const leaseBytes = (root) => {
  try { return readFileSync(join(root, '.git', LEASE_FILE)); } catch { return null; }
};
const beatOf = (beat) => {
  try { return Number(readFileSync(beat, 'utf8')); } catch { return null; }
};
const entriesOf = (root) =>
  JSON.parse(readFileSync(join(root, '.git', LEDGER_FILE), 'utf8')).entries;

/** Terminates one pid and waits until the real probe agrees it is gone. */
async function killAndWait(processAlive, pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'pipe' }); } catch { /* already gone */ }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processAlive(pid) === 'NOT_FOUND') return true;
    await sleep(25);
  }
  return false;
}

/** Runs the SHIPPED CLI, with no attendance flag and nothing on stdin. */
function leaseRecoverCli(root) {
  // The command answers EXIT_RUN_OK for a refusal too - "this lease cannot be
  // proved dead" is the normal answer - so a non-zero exit here is a fault in
  // the harness or the build rather than a refusal, and it is reported as one
  // instead of being read as "no recovery happened".
  try {
    return execFileSync(process.execPath, [cli, 'lease', 'recover', '--repository', root], {
      stdio: 'pipe',
      encoding: 'utf8',
      // Nothing to answer, and nothing to answer it: the point of the command is
      // that no operator is involved.
      input: '',
    });
  } catch (error) {
    failures += 1;
    process.stdout.write(
      `  FAIL the shipped CLI exited ${String(error.status)}: ${String(error.stdout)}
`,
    );
    return '';
  }
}

const {
  acquireRepositoryExecutionLease,
  assessStaleLeaseRecovery,
  attestWriterLaunchEstablished,
  beginWriterLaunch,
  confirmWriterLaunch,
  osProcessLiveness,
  releaseRepositoryExecutionLease,
} = await import(pathToFileURL(distLease).href);
const { runOwnedCommand } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'boundary', 'owned-command.js')).href
);
const { resolveRepository } = await import(pathToFileURL(distRepo).href);
const { deriveExecutionLeaseLocation } = await import(pathToFileURL(distLease).href);

const ROUNDS = Number(process.env.AO_CRASH_ROUNDS ?? '2');
const started = Date.now();

for (let round = 0; round < ROUNDS; round += 1) {
  process.stdout.write(`\nround ${round}\n`);

  /* ── A. killed mid-writer: the tree dies, and the lease is recoverable ─── */
  {
    const { root } = fixture();
  const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'CONTAINED', beat);
    // Both sides resolved; both must name the SAME lease. Asserted before any
    // phase is judged, because a split identity makes the refusal phases pass
    // while measuring an empty directory.
    const derived = deriveExecutionLeaseLocation(repository);
    check(
      derived.ok === true && derived.path === facts.leasePath,
      `A${round}: the owner and this harness derive one lease path`,
    );
    await sleep(500);
    check(beatOf(beat) !== null, `A${round}: the contained writer is really running`);
    check(
      entriesOf(root).every((e) => e.state === 'ESTABLISHED'),
      `A${round}: the launch is recorded ESTABLISHED while the writer runs`,
    );

    check(await killAndWait(osProcessLiveness, facts.ownerPid), `A${round}: the owner is gone`);
    await sleep(2500);
    const first = beatOf(beat);
    await sleep(1500);
    check(beatOf(beat) === first, `A${round}: the writer stopped beating when its owner died`);
    check(
      osProcessLiveness(facts.helperPid) === 'NOT_FOUND' &&
        osProcessLiveness(facts.childPid) === 'NOT_FOUND',
      `A${round}: both recorded processes of the tree are gone`,
    );

    check(
      assessStaleLeaseRecovery(repository).verdict === 'SAFE_TO_RECOVER',
      `A${round}: the predicate accepts a dead owner whose unended tree is gone`,
    );
    const output = leaseRecoverCli(root);
    check(/RECOVERED/.test(output), `A${round}: the shipped CLI reports RECOVERED with no operator`);
    check(!existsSync(join(root, '.git', LEASE_FILE)), `A${round}: the stale lease is gone`);

    const again = acquireRepositoryExecutionLease(
      repository,
      { runId: 'after-recovery', blockId: null },
      { now: () => new Date().toISOString() },
    );
    check(again.ok === true, `A${round}: the ordinary acquisition path now succeeds`);
    check(
      readdirSync(join(root, '.git')).every((n) => !/\.(?:breaking|tmp)-/.test(n)),
      `A${round}: no protocol leftovers in the administrative directory`,
    );
  }

  /* ── B. THE CONTROL: the recorded tree is still running ───────────────── */
  {
    const { root } = fixture();
  const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'SURVIVOR', beat);
    check(await killAndWait(osProcessLiveness, facts.ownerPid), `B${round}: the owner is gone`);
    await sleep(600);
    check(
      osProcessLiveness(facts.childPid) === 'ALIVE',
      `B${round}: the recorded child really outlived the owner`,
    );

    const before = leaseBytes(root);
    const assessed = assessStaleLeaseRecovery(repository);
    check(
      assessed.refusal === 'LAUNCH_TREE_STILL_RUNNING',
      `B${round}: refused LAUNCH_TREE_STILL_RUNNING (got ${String(assessed.refusal)})`,
    );
    const output = leaseRecoverCli(root);
    check(!/RECOVERED/.test(output), `B${round}: the shipped CLI does not report a recovery`);
    check(
      Buffer.compare(before, leaseBytes(root) ?? Buffer.alloc(0)) === 0,
      `B${round}: the lease is byte-identical after the refusal`,
    );

    for (const pid of [facts.helperPid, facts.childPid]) await killAndWait(osProcessLiveness, pid);
    // And with the survivors gone, the very same lease becomes recoverable. This
    // is what makes the refusal above attributable to liveness rather than to
    // anything else about the fixture.
    check(
      assessStaleLeaseRecovery(repository).verdict === 'SAFE_TO_RECOVER',
      `B${round}: the same lease is recoverable once the tree is gone`,
    );
  }

  /* ── C. a living owner is refused before the tree is ever asked about ─── */
  {
    const { root } = fixture();
  const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'CONTAINED', beat);
    await sleep(400);
    const before = leaseBytes(root);
    const assessed = assessStaleLeaseRecovery(repository);
    check(
      assessed.refusal === 'OWNER_RUNNING',
      `C${round}: a live owner refuses OWNER_RUNNING (got ${String(assessed.refusal)})`,
    );
    check(
      assessed.launchHistory === null,
      `C${round}: the history was never read, so the new arm is unreachable past a live owner`,
    );
    check(!/RECOVERED/.test(leaseRecoverCli(root)), `C${round}: the CLI removes nothing`);
    check(
      Buffer.compare(before, leaseBytes(root) ?? Buffer.alloc(0)) === 0,
      `C${round}: the lease is byte-identical`,
    );
    await killAndWait(osProcessLiveness, facts.ownerPid);
    void repository;
  }

  /* ── D. the window this slice does not close ──────────────────────────── */
  {
    const { root } = fixture();
  const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'PENDING', beat);
    check(await killAndWait(osProcessLiveness, facts.ownerPid), `D${round}: the owner is gone`);
    const before = leaseBytes(root);
    const assessed = assessStaleLeaseRecovery(repository);
    check(
      assessed.refusal === 'LAUNCH_HISTORY_UNPROVEN',
      `D${round}: a launch killed before the kernel answered stays unprovable (got ${String(assessed.refusal)})`,
    );
    check(!/RECOVERED/.test(leaseRecoverCli(root)), `D${round}: the CLI removes nothing`);
    check(
      Buffer.compare(before, leaseBytes(root) ?? Buffer.alloc(0)) === 0,
      `D${round}: the lease is byte-identical`,
    );
  }
}

/* ── E. the two marks describe the same launch, through a real boundary ──── */
//
// The upgrade `ESTABLISHED` -> `CONTAINED` is refused unless the confirming
// attestation carries the same launch digest as the entry already standing. The
// two are minted at different moments from different reads — the establishment
// mint takes `owned.launchNonce`, the ending mint takes the nonce echoed back in
// the status file — and nothing above this case makes them meet.
//
// If they ever disagreed, every real launch would stop at `ESTABLISHED` and
// never reach `CONTAINED`, silently, because the confirmation's result is
// discarded by design. Phases A-D would all still pass: they never confirm
// anything. So this case exists, it drives the real ordering through the real
// boundary, and it is the only place the agreement is measured.
{
  const { root } = fixture();
  const repository = await resolvedRepository(root);
  const acquired = acquireRepositoryExecutionLease(
    repository,
    { runId: 'upgrade-run', blockId: null },
    { now: () => new Date().toISOString() },
  );
  check(acquired.ok === true, 'E: the harness took the lease');
  if (acquired.ok) {
    const now = () => new Date().toISOString();
    const opened = beginWriterLaunch(repository, acquired.evidence, { writerId: 'claude', now });
    check(opened.code === 'OPENED', `E: a generation was opened (${opened.code})`);

    let stateDuring = null;
    let hookCalls = 0;
    const result = await runOwnedCommand({
      file: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      onLaunchEstablished: (attestation) => {
        hookCalls += 1;
        const marked = attestWriterLaunchEstablished(repository, acquired.evidence, attestation, {
          generation: opened.generation,
          writerId: 'claude',
          now,
        });
        check(marked.code === 'ESTABLISHED', `E: the mid-launch mark landed (${marked.code})`);
        stateDuring = entriesOf(root)[0]?.state ?? null;
      },
    });

    check(hookCalls === 1, `E: the boundary reported establishment exactly once (${hookCalls})`);
    check(stateDuring === 'ESTABLISHED', `E: the ledger said ESTABLISHED while the target ran`);
    check(result.outcome === 'COMPLETED', `E: the real owned command completed (${result.outcome})`);

    const confirmed = confirmWriterLaunch(repository, acquired.evidence, result.containment, {
      generation: opened.generation,
      writerId: 'claude',
      now,
    });
    check(
      confirmed.code === 'CONFIRMED',
      `E: the ending upgraded the same generation (${confirmed.code}/${String(confirmed.detail)})`,
    );
    check(entriesOf(root)[0]?.state === 'CONTAINED', 'E: the ledger ends at CONTAINED');
    releaseRepositoryExecutionLease(acquired.evidence);
  }
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ }
}

process.stdout.write(
  `\ncrash-recovery: ${failures === 0 ? 'PASS' : `FAIL (${failures})`} in ${Date.now() - started}ms\n`,
);
process.exit(failures === 0 ? 0 : 1);
