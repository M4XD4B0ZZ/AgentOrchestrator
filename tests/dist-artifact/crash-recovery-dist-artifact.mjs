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
 * ── The phases, and which of them are controls ────────────────────────────
 *
 *   A  positive — owner killed mid-writer. The tree must be gone, the shipped
 *      `agent-loop lease recover` must remove the lease, and a fresh acquisition
 *      must then succeed.
 *   B  A CONTROL — identical, except the processes the ledger records are
 *      deliberately still alive. The recovery must refuse
 *      `LAUNCH_TREE_STILL_RUNNING` and leave the lease byte-identical. Without
 *      this case every `RECOVERED` in phase A could be an instrument that cannot
 *      tell a live process from a dead one.
 *   C  the owner itself is still alive with an established launch. Must refuse
 *      `OWNER_RUNNING` — the conjunct that comes first — so the new arm cannot
 *      be reached past a living owner.
 *   D  the window this slice does NOT close: an announced launch that never
 *      reached the kernel's answer. Must refuse `LAUNCH_HISTORY_UNPROVEN`, which
 *      is the honest answer and the reason U1 is narrowed rather than closed.
 *   F  the sequence a review blocked this slice on: the writer really ends, its
 *      ending is never proved, a LATER subprocess starts and is still alive when
 *      the owner dies. The writer's own pids are gone, so the liveness re-check
 *      cannot save it; what refuses is the withdrawal of the establishment mark.
 *      Must refuse. That later process is a plain DETACHED spawn and goes
 *      through no owned boundary, which is stated rather than assumed: it is
 *      therefore in no register, and F's subject is the withdrawal.
 *   G  THE CONTROL FOR F — the identical fixture with the withdrawal switched
 *      off, which must RECOVER. That is the defect reproduced, and it is what
 *      stops F passing in a build that had simply broken the whole arm. It still
 *      recovers after M2 slice 2, for the reason F's later process is not owned.
 *   H  M2 slice 2's counterexample: the writer history is a PROOF, an owned
 *      launch is recorded through the production functions over processes that
 *      are really running, and the owner dies. Must refuse
 *      OWNED_LAUNCH_STILL_RUNNING and leave the lease byte-identical — and the
 *      SAME lease must become recoverable once those processes are killed.
 *   I  the wiring proof, and the only case here that dies if the accounting
 *      stops being emitted: a REAL owned subprocess started by
 *      runVerificationCommand with no accounting argument of any kind, whose
 *      helper and child the register on disk must name WHILE IT RUNS.
 *   J  the other half of the lifecycle: the verification is asked to stop, its
 *      ending is observed while the owner is alive, and the register must be
 *      EMPTY afterwards with the slot counter not gone back.
 *   E  runs once, after the rounds: the establishment mint and the ending mint
 *      must describe the same launch.
 *
 * Two phases arrange their survivors rather than measuring them: B for the
 * writer and H for the register. Both say so where they do it, and the reason is
 * the same measurement — a subprocess started through the real boundary cannot
 * be made to outlive its owner, because the helper holds the only handle to a
 * job carrying KILL_ON_JOB_CLOSE and is itself in node's kill-on-close job.
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
const distVerify = join(repoRoot, 'dist', 'verify', 'verify-command.js');
const distOwned = join(repoRoot, 'dist', 'boundary', 'owned-command.js');
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
 * The target the M2 slice 2 phases hand to the PRODUCTION verification seam.
 *
 * A FILE rather than `-e`, because every argument reaching `doctor/exec.ts` must
 * be shell-inert and a JS one-liner cannot be one. Every path in it is relative,
 * because that seam supplies the child `PATH`/`PATHEXT` and nothing else, so an
 * environment variable would not arrive. It stops when a `stop` file appears,
 * which is how phase J observes an ending while its owner is still alive.
 */
const OWNED_BEATER =
  "import{existsSync,writeFileSync}from'node:fs';\n" +
  "let n=0;\n" +
  "setInterval(()=>{if(existsSync('stop'))process.exit(0);n+=1;" +
  "try{writeFileSync('beat',String(n))}catch{}},50);\n" +
  "setInterval(()=>{},1000);\n";

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
  announceOwnedLaunch,
  attestOwnedLaunchEstablished,
  attestWriterLaunchEstablished,
  beginWriterLaunch,
  confirmWriterLaunch,
  deriveExecutionLeaseLocation,
  retractWriterLaunchEstablishment,
} from ${JSON.stringify(pathToFileURL(distLease).href)};
import { runOwnedCommand } from ${JSON.stringify(pathToFileURL(distOwned).href)};
import { runVerificationCommand } from ${JSON.stringify(pathToFileURL(distVerify).href)};
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
} else if (phase === 'ENDED_THEN_LATER_WORK') {
  // THE SEQUENCE THE REVIEW BLOCKED ON. A real contained writer runs to its end,
  // its ending is never proved (the run does not confirm the generation), and
  // the run then starts a LATER subprocess - detached, and so through no owned
  // boundary - that is still alive when the
  // owner dies. That later process is not in the writer ledger and never can be.
  const first = await startOwnedProcess({
    file: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { ...process.env },
  });
  if (!first.established) fail('BOUNDARY ' + JSON.stringify(first.ending));
  const w = first.process;
  const attestation = mintContainmentAttestation({
    ownerPid: process.pid,
    helperPid: w.helperPid,
    childPid: w.childPid,
    mode: w.mode,
    assignedAtCreation: w.assignedAtCreation,
    launchNonce: w.launchNonce,
    attestedAt: now(),
    verifiedInJob: w.verifiedInJob,
  });
  if (attestation === null) fail('MINT');
  const marked = attestWriterLaunchEstablished(repository, acquired.evidence, attestation, {
    generation: opened.generation, writerId: 'claude', now,
  });
  if (marked.code !== 'ESTABLISHED') fail('ESTABLISH ' + marked.code);
  await first.process.ending;
  facts = { helperPid: w.helperPid, childPid: w.childPid };

  // The withdrawal the production seam performs. Driven explicitly here because
  // this harness drives the lease layer rather than the loop; the seam's own
  // wiring is measured in tests/v3-05-stale-lease-recovery.test.ts.
  if (process.env.AO_CRASH_WITHDRAW === 'yes') {
    const retracted = retractWriterLaunchEstablishment(repository, acquired.evidence, {
      generation: opened.generation, writerId: 'claude',
    });
    if (retracted.code !== 'RETRACTED') fail('RETRACT ' + retracted.code);
  }

  // And now the later, unrecorded subprocess, left running. Detached on purpose:
  // it is in no register, which is what keeps F about the withdrawal and G about
  // the defect the withdrawal closes.
  const later = spawn(process.execPath, ['-e', BEATER], {
    env: { ...process.env, AO_CRASH_BEAT: beat },
    detached: true,
    stdio: 'ignore',
  });
  later.unref();
  facts = { ...facts, laterPid: later.pid };
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
} else if (phase === 'OWNED_SURVIVOR' || phase === 'OWNED_LIVE_VERIFY' || phase === 'OWNED_ENDED_VERIFY') {
  // ── M2 slice 2. The writer is finished and PROVED, so the writer conjunct
  // permits and the only thing left that can refuse is the owned-launch
  // register. A history reading anything but ALL_LAUNCHES_CONTAINED would
  // refuse first and every case below would pass for the wrong reason.
  const w = await runOwnedCommand({
    file: process.execPath,
    args: ['-e', 'process.exit(0)'],
    onLaunchEstablished: (a) => {
      const m = attestWriterLaunchEstablished(repository, acquired.evidence, a, {
        generation: opened.generation, writerId: 'claude', now,
      });
      if (m.code !== 'ESTABLISHED') fail('ESTABLISH ' + m.code);
    },
  });
  if (w.outcome !== 'COMPLETED') fail('WRITER ' + w.outcome);
  const confirmed = confirmWriterLaunch(repository, acquired.evidence, w.containment, {
    generation: opened.generation, writerId: 'claude', now,
  });
  if (confirmed.code !== 'CONFIRMED') fail('CONFIRM ' + confirmed.code);

  if (phase === 'OWNED_SURVIVOR') {
    // THE NEGATIVE CONTROL, and the counterexample this slice exists for. The
    // register is made to name processes that are really running and are NOT in
    // any job of this owner's - started detached, so killing the owner leaves
    // them alive.
    //
    // The same substitution phase B makes for the writer, and for the same
    // measured reason: an owned subprocess started through the real boundary
    // CANNOT be made to outlive its owner. The helper holds the only handle to a
    // job carrying KILL_ON_JOB_CLOSE and is itself in node's kill-on-close job,
    // and three rounds of 4 ms sampling after a forced kill found the tree
    // already gone at the first sample, 44-69 ms in. What is real here is
    // everything the predicate touches: the record is minted and written by the
    // production functions, and the processes it names are real. What is
    // arranged is only that they survive.
    const one = spawn(process.execPath, ['-e', BEATER], {
      env: { ...process.env, AO_CRASH_BEAT: beat }, detached: true, stdio: 'ignore',
    });
    one.unref();
    const two = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    two.unref();
    const announced = announceOwnedLaunch(repository, acquired.evidence, { now });
    if (announced.code !== 'ANNOUNCED') fail('ANNOUNCE ' + announced.code);
    const attestation = mintContainmentAttestation({
      ownerPid: process.pid, helperPid: two.pid, childPid: one.pid, mode: 'JOBLIST',
      assignedAtCreation: true, launchNonce: 'c0ffee00c0ffee03', attestedAt: now(), verifiedInJob: true,
    });
    if (attestation === null) fail('MINT');
    const est = attestOwnedLaunchEstablished(repository, acquired.evidence, attestation, {
      slot: announced.slot, now,
    });
    if (est.code !== 'ESTABLISHED') fail('OWNED_ESTABLISH ' + est.code);
    facts = { helperPid: two.pid, childPid: one.pid };
  } else {
    // A REAL owned subprocess through the PRODUCTION verification path -
    // runVerificationCommand, then doctor/exec.ts, then the owned boundary -
    // with no accounting argument anywhere, because that seam takes none.
    // Whatever reaches the register here was put there by production code.
    const running = runVerificationCommand(process.execPath, ['beater.mjs'], root);
    running.catch(() => {});
    const deadline = Date.now() + 30000;
    let beating = false;
    const { readFileSync } = await import('node:fs');
    while (Date.now() < deadline) {
      try { if (Number(readFileSync(beat, 'utf8')) > 0) { beating = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!beating) fail('VERIFY_NEVER_BEAT');
    if (phase === 'OWNED_ENDED_VERIFY') {
      // This one is asked to stop, so its ending is observed and its slot is
      // settled while this owner is still alive. That is the only way to measure
      // the removal half of the register's lifecycle against a real subprocess.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(root, 'stop'), 'x');
      await running;
    }
  }
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

function startOwner(root, phase, beat, options = {}) {
  return new Promise((ok, bad) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', OWNER_SOURCE], {
      env: {
        ...process.env,
        AO_CRASH_DIR: root,
        AO_CRASH_PHASE: phase,
        AO_CRASH_BEAT: beat,
        // The one switch that separates F from its control G. Present so the two
        // differ in exactly the withdrawal and in nothing else about the fixture.
        AO_CRASH_WITHDRAW: options.withdraw === true ? 'yes' : 'no',
      },
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
  writeFileSync(join(root, 'beater.mjs'), OWNED_BEATER, 'utf8');
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
/** The owned-launch register on disk: the subprocesses this epoch has open. */
const openOf = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, '.git', LEDGER_FILE), 'utf8')).open ?? [];
  } catch {
    return [];
  }
};
/** The slot counter, which only ever goes up. */
const nextSlotOf = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, '.git', LEDGER_FILE), 'utf8')).nextSlot ?? 0;
  } catch {
    return 0;
  }
};

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

  /* ── F. the sequence a review blocked this slice on ────────────────────── */
  //
  //   ESTABLISHED writer -> the writer really ends -> no CONTAINED upgrade
  //   -> a LATER detached subprocess starts and stays alive -> the owner dies
  //   -> recovery MUST refuse
  //
  // The writer's own recorded pids are gone, so the liveness re-check cannot
  // save this: nothing in the ledger names the later process, and nothing ever
  // will. What refuses is the withdrawal of the establishment mark at the moment
  // the writer ended without a proof.
  {
    const { root } = fixture();
    const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'ENDED_THEN_LATER_WORK', beat, { withdraw: true });
    check(await killAndWait(osProcessLiveness, facts.ownerPid), `F${round}: the owner is gone`);
    await sleep(600);

    check(
      osProcessLiveness(facts.helperPid) === 'NOT_FOUND' &&
        osProcessLiveness(facts.childPid) === 'NOT_FOUND',
      `F${round}: the writer's own recorded processes are gone`,
    );
    check(
      osProcessLiveness(facts.laterPid) === 'ALIVE',
      `F${round}: the LATER unrecorded process outlived the owner`,
    );

    const before = leaseBytes(root);
    const assessed = assessStaleLeaseRecovery(repository);
    check(
      assessed.refusal === 'LAUNCH_HISTORY_UNPROVEN',
      `F${round}: refused (got ${String(assessed.refusal)})`,
    );
    check(!/RECOVERED/.test(leaseRecoverCli(root)), `F${round}: the shipped CLI removes nothing`);
    check(
      Buffer.compare(before, leaseBytes(root) ?? Buffer.alloc(0)) === 0,
      `F${round}: the lease is byte-identical`,
    );
    await killAndWait(osProcessLiveness, facts.laterPid);
    // Stated rather than left to be assumed: killing the later process does NOT
    // make this lease recoverable. The withdrawal is permanent, which is exactly
    // the pre-slice behaviour for a writer whose ending was never proved. The
    // control that makes the refusal attributable is G below, not this line.
    check(
      assessStaleLeaseRecovery(repository).refusal === 'LAUNCH_HISTORY_UNPROVEN',
      `F${round}: still refused once the later process is gone`,
    );
  }

  /* ── G. THE CONTROL for F: the same sequence with no withdrawal ─────────── */
  //
  // Identical fixture, identical processes, and the establishment mark left
  // standing. This must RECOVER - which is what the arm did before the
  // withdrawal existed, and is the defect F exists to keep closed. Without this
  // case, F would also pass in a build that had simply broken the whole arm.
  {
    const { root } = fixture();
    const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'ENDED_THEN_LATER_WORK', beat, { withdraw: false });
    check(await killAndWait(osProcessLiveness, facts.ownerPid), `G${round}: the owner is gone`);
    await sleep(600);
    check(
      osProcessLiveness(facts.laterPid) === 'ALIVE',
      `G${round}: the later unrecorded process is alive here too`,
    );
    check(
      assessStaleLeaseRecovery(repository).verdict === 'SAFE_TO_RECOVER',
      `G${round}: without the withdrawal the arm permits - which is the defect`,
    );
    await killAndWait(osProcessLiveness, facts.laterPid);
  }

  /* ── H. M2 slice 2: an owned subprocess of this epoch is still running ──── */
  //
  //   writer CONTAINED, so the writer conjunct PERMITS
  //   -> an owned launch recorded through the production functions
  //   -> the processes it records are really running
  //   -> the owner dies
  //   -> recovery MUST refuse, and the refusal must name the SUBPROCESS
  //
  // The counterexample that made `L-V3-05-1` dangerous. Before this slice it was
  // not reachable at all: nothing recorded a non-writer launch, so the predicate
  // had nothing to refuse on and the shipped CLI removed the lease — measured on
  // `main` at `fba4cfd` with a real verification subprocess.
  {
    const { root } = fixture();
    const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'OWNED_SURVIVOR', beat);
    check(await killAndWait(osProcessLiveness, facts.ownerPid), `H${round}: the owner is gone`);
    await sleep(600);
    check(
      osProcessLiveness(facts.childPid) === 'ALIVE' &&
        osProcessLiveness(facts.helperPid) === 'ALIVE',
      `H${round}: the recorded subprocess really outlived the owner`,
    );
    const entries = entriesOf(root);
    check(
      entries.length === 1 && entries[0]?.state === 'CONTAINED',
      `H${round}: the writer history is a proof, so only the register can refuse`,
    );

    const before = leaseBytes(root);
    const assessed = assessStaleLeaseRecovery(repository);
    check(
      assessed.launchHistory === 'ALL_LAUNCHES_CONTAINED',
      `H${round}: the writer conjunct permitted (got ${String(assessed.launchHistory)})`,
    );
    check(
      assessed.refusal === 'OWNED_LAUNCH_STILL_RUNNING',
      `H${round}: refused OWNED_LAUNCH_STILL_RUNNING (got ${String(assessed.refusal)})`,
    );
    const output = leaseRecoverCli(root);
    check(!/RECOVERED/.test(output), `H${round}: the shipped CLI does not report a recovery`);
    check(
      /OWNED_LAUNCH_STILL_RUNNING/.test(output),
      `H${round}: and it names the subprocess refusal to the operator`,
    );
    check(
      Buffer.compare(before, leaseBytes(root) ?? Buffer.alloc(0)) === 0,
      `H${round}: the lease is byte-identical after the refusal`,
    );

    for (const pid of [facts.helperPid, facts.childPid]) await killAndWait(osProcessLiveness, pid);
    // And with the recorded processes gone, the very same lease becomes
    // recoverable. That is what makes the refusal above attributable to liveness
    // rather than to anything else about the fixture.
    check(
      assessStaleLeaseRecovery(repository).verdict === 'SAFE_TO_RECOVER',
      `H${round}: the same lease is recoverable once the subprocess is gone`,
    );
  }

  /* ── I. the seam really records, through the production verification path ─ */
  //
  // The wiring proof, and the case that dies if the accounting stops being
  // emitted. A REAL owned subprocess is started by `runVerificationCommand` with
  // no accounting argument of any kind — that seam takes none — and the register
  // on disk must name its helper and child WHILE IT RUNS. Then the owner is
  // killed, the tree really dies, and the recovery permits having probed the
  // pids the seam wrote.
  {
    const { root } = fixture();
    const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'OWNED_LIVE_VERIFY', beat);
    const open = openOf(root);
    check(
      open.length === 1 && open[0]?.state === 'ESTABLISHED',
      `I${round}: the production verification seam recorded its launch (got ${JSON.stringify(open.map((e) => e.state))})`,
    );
    const recorded = open[0] ?? {};
    check(
      Number.isInteger(recorded.helperPid) &&
        Number.isInteger(recorded.childPid) &&
        osProcessLiveness(recorded.childPid) === 'ALIVE',
      `I${round}: and the child it recorded is the one that is running`,
    );
    check(beatOf(beat) !== null, `I${round}: the owned verification target is really running`);

    check(await killAndWait(osProcessLiveness, facts.ownerPid), `I${round}: the owner is gone`);
    await sleep(2500);
    const first = beatOf(beat);
    await sleep(1500);
    check(beatOf(beat) === first, `I${round}: the verification target stopped when its owner died`);
    check(
      osProcessLiveness(recorded.helperPid) === 'NOT_FOUND' &&
        osProcessLiveness(recorded.childPid) === 'NOT_FOUND',
      `I${round}: both recorded processes of the subprocess are gone`,
    );
    check(
      assessStaleLeaseRecovery(repository).verdict === 'SAFE_TO_RECOVER',
      `I${round}: the predicate permits once the recorded subprocess is gone`,
    );
    check(/RECOVERED/.test(leaseRecoverCli(root)), `I${round}: the shipped CLI recovers`);
    check(!existsSync(join(root, '.git', LEASE_FILE)), `I${round}: the stale lease is gone`);
  }

  /* ── J. a subprocess that ended takes its record with it ────────────────── */
  //
  // The other half of the lifecycle, against a real subprocess: the verification
  // is asked to stop, its ending is observed while the owner is still alive, and
  // the register must be EMPTY afterwards. A build that stopped settling would
  // leave the entry standing and fail this line — and would go on passing every
  // case above it, because a leftover entry naming dead processes still permits.
  {
    const { root } = fixture();
    const repository = await resolvedRepository(root);
    const beat = join(root, 'beat');
    const facts = await startOwner(root, 'OWNED_ENDED_VERIFY', beat);
    check(
      openOf(root).length === 0,
      `J${round}: the ended verification took its record with it (left ${JSON.stringify(openOf(root))})`,
    );
    // The counter is what does NOT go back, and it is the whole reason a settled
    // slot can never be handed out again.
    check(nextSlotOf(root) > 1, `J${round}: the slot counter did not go back`);
    check(await killAndWait(osProcessLiveness, facts.ownerPid), `J${round}: the owner is gone`);
    check(
      assessStaleLeaseRecovery(repository).verdict === 'SAFE_TO_RECOVER',
      `J${round}: an epoch whose subprocesses all ended is recoverable`,
    );
    check(/RECOVERED/.test(leaseRecoverCli(root)), `J${round}: the shipped CLI recovers`);
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
// boundary, and it is the only place the agreement is measured ON ITS OWN.
// Phases H, I and J each drive begin -> establish -> confirm through a real
// owned command as well, and fail the owner before it prints `ready` if the two
// mints disagree - but they do it as a precondition for something else, and a
// case whose subject is the agreement is what stops that becoming incidental.
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
