#!/usr/bin/env node
/**
 * DASHBOARD-001 slice 4 — the whole chain, ending at a DEPLOYED runtime.
 *
 * Standalone Node script, spawned by the `test:dist-dashboard-ui` npm script
 * and transitively by `verify`. It deploys a runtime into a throwaway
 * directory, starts that runtime's own `cli/index.js dashboard serve` as a real
 * child process with **no seam of any kind**, and asks it for its assets over a
 * real socket.
 *
 * ── The chain, and which link each existing gate does NOT cover ─────────────
 *
 *   src/dashboard/ui → emit → build/dashboard/ui → deploy → <runtime>/dashboard/ui
 *     → the DEPLOYED CLI, unseamed → a real GET → the bytes that were deployed
 *
 * Three gates already stand on parts of it, and none of them reaches the end:
 *
 *  - `tests/dashboard-08-ui-assets.test.ts` measures the emit, in process,
 *    against temporary directories. It never runs a CLI and never opens a
 *    socket.
 *  - `tests/dist-artifact/dashboard-assets-dist-artifact.mjs` runs the BUILT
 *    CLI unseamed and fetches one asset — but out of `build/`, which nothing
 *    in production executes, and it fetches `/app.js` and `/sw.js` only.
 *  - `tests/dist-artifact/runtime-deployment-dist-artifact.mjs` deploys a
 *    runtime and reads its `dashboard/ui/` **off the disk**: the files exist,
 *    the six verbatim ones match their authored sources, the worker carries a
 *    digest. It never starts the deployed Manager, so nothing there says the
 *    deployed CLI can find, load and serve what was deployed beside it.
 *
 * This harness is the last link, and deliberately asserts as little as it can
 * get away with that those three already assert. What it adds:
 *
 *  1. the two emit call sites agree. `npm run build` writes `build/dashboard/ui`
 *     and `deployRuntime` writes `<runtime>/dashboard/ui`, by two separate
 *     invocations of `emitUiAssets`. Every one of the seven files must be
 *     identical across them — `sw.js` included, which is the interesting one,
 *     because it is the only file the emit transforms and therefore the only
 *     one a divergence could hide in;
 *  2. the REVERSE direction of that same manifest gate, over both of those
 *     artefacts: nothing sits in either `ui/` that the manifest does not name.
 *     Section A iterates the manifest and asks "is this file there?", and so
 *     does every other gate on this chain — which is green over a directory
 *     holding anything else as well, and `npm run build` never deletes, so a
 *     renamed or retired asset stays in `build/dashboard/ui` forever. Two
 *     near-misses are worth naming. `runtime-deployment` does compare a
 *     deployed `ui/` against `build/`, which catches a deployed-only extra but
 *     says nothing about a file BOTH artefacts carry and the manifest names
 *     neither of. And `dashboard-08` runs exactly this comparison — against a
 *     `mkdtemp` it filled one line earlier, a directory that by construction
 *     holds precisely the manifest and so cannot hold an orphan at all;
 *  3. the DEPLOYED CLI, unseamed, reaches "listening" — it does not refuse with
 *     `UI_ASSETS_UNUSABLE`, which is what a runtime deployed without its UI
 *     does, silently, on the one machine where nobody is watching;
 *  4. **every** manifest route answers 200 with the manifest's own content
 *     type, its declared `Content-Length`, and bytes equal to the file that was
 *     deployed. Both PNGs are included and they are the point: an icon is the
 *     one asset that is not text, so it is the one a stray encoding step
 *     corrupts without anything else noticing;
 *  5. a served asset carries the UI policy and the snapshot carries the empty
 *     one, in the same run. Slice 4 split those two policies apart; a gate that
 *     can only see one of them cannot see that the split happened;
 *  6. the served worker's digest is RECOMPUTED here, over the six shell files
 *     as they sit in the deployed artefact, and must equal the one the worker
 *     names. Every other check on that digest asks only whether it looks like
 *     64 hex characters, which a stale worker shipped beside a changed shell
 *     passes;
 *  7. the negative control, in section C — and without it the six above are a
 *     green light on a build that serves whatever it happens to find.
 *
 * ── How "no socket was opened" is measured without a seam ──────────────────
 *
 * `dashboard serve` loads its assets before it binds, and the claim in its own
 * refusal is that nothing was served and no socket was opened. The slice-3
 * harness proves that with an injected `listen` tripwire. This one has no
 * tripwire, by design, so it reads the order off the exit code instead:
 *
 *   C1  assets intact, port already held      → exit 4, stderr carries EADDRINUSE
 *   C2  one asset moved aside, same held port → exit 1, stderr carries the ROUTE
 *                                               and NOT EADDRINUSE
 *
 * C1 is what makes C2 mean something: it establishes that this port really does
 * refuse a bind, so C2's silence about `EADDRINUSE` is the bind never having
 * been attempted rather than a port that would have accepted one. A build that
 * bound first and loaded afterwards fails C2 with exit 4.
 *
 * ── What this harness does not claim ───────────────────────────────────────
 *
 * It says nothing about the conditional-request semantics of `/api/snapshot` —
 * the ETag a real server sends being the value a real client must echo to get a
 * 304 is measured against the shipped listener in
 * `dashboard-listener-dist-artifact.mjs`, and measuring it twice would not make
 * it truer.
 *
 * Nothing here reads, writes, renames or deletes this checkout's `dist/`. The
 * runtime it deploys lives under `<repo>/tmp`, which Git ignores, and is
 * removed on every exit path.
 *
 * Contract: exit 0 means every check passed. Any nonzero exit means at least
 * one did not.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const buildUiDir = join(repoRoot, 'build', 'dashboard', 'ui');

/** The CLI's own grades, mirrored. `src/cli/run-exit-codes.ts` is the authority. */
const EXIT_RUN_UNEXPECTED = 1;
const EXIT_RUN_REFUSED = 4;

/** The file the negative control takes away. Last in manifest order, on purpose. */
const HOSTAGE_FILE = 'icon-512.png';
const HOSTAGE_ROUTE = '/icon-512.png';

/** @type {string[]} */
const failures = [];
/**
 * How many assertions actually ran.
 *
 * Reported on success, and floored below. Every early `return` in this file is
 * a path on which later checks do not execute, so a run that went green after
 * taking one of them would be a gate quietly measuring a fraction of what it
 * claims. The floor turns that into a failure instead of a reassuring sentence.
 */
let checksRun = 0;
const check = (condition, message) => {
  checksRun += 1;
  if (!condition) failures.push(message);
};

if (!existsSync(buildUiDir)) {
  console.error(
    `${buildUiDir} does not exist. This harness compares the two emit call sites against each ` +
      'other, so it needs the build output as well as a deployment. Run "npm run build" first ' +
      '(see "verify:dist-dashboard-ui").',
  );
  process.exit(1);
}

/* ── plumbing, matched to the sibling dashboard harnesses ────────────────── */

/**
 * Awaits `promise`, giving up after `ms`, and clears the timer either way.
 *
 * Written out rather than `Promise.race([promise, sleep(ms)])`: `race` settles
 * on the winner and abandons the loser, so the guard timer stays armed and
 * holds this process alive for the whole guard after the work it guarded
 * finished.
 */
function withTimeout(promise, ms, timeoutValue) {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(timeoutValue), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        settle(value);
      },
      () => {
        clearTimeout(timer);
        settle(timeoutValue);
      },
    );
  });
}

/** A port nothing is using right now. Bound explicitly, never by omission. */
async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen({ host: '127.0.0.1', port: 0 }, done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** Holds a port, so a collision is a real one rather than a simulated one. */
async function occupy(port) {
  const squatter = createServer();
  await new Promise((done, fail) => {
    squatter.once('error', fail);
    squatter.listen({ host: '127.0.0.1', port, exclusive: true }, done);
  });
  return () => new Promise((done) => squatter.close(done));
}

/**
 * Starts a DEPLOYED runtime's own CLI. No preload, no injected seam, no
 * environment tripwire — the property under test is what this artefact does
 * when nobody tells it anything.
 */
function launch(runtimeRoot, args) {
  const child = spawn(process.execPath, [join(runtimeRoot, 'cli', 'index.js'), ...args], {
    cwd: runtimeRoot,
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  /** @type {{code: number|null, signal: string|null}|null} */
  let exited = null;
  /** @type {null | ((value: string) => void)} */
  let waitingFor = null;
  let waitingPattern = null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (waitingFor !== null) {
      const match = waitingPattern.exec(stdout);
      if (match !== null) {
        const settle = waitingFor;
        waitingFor = null;
        settle(match[0]);
      }
    }
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const done = new Promise((settle) => {
    child.on('close', (code, signal) => {
      exited = { code, signal };
      settle(exited);
    });
  });

  return {
    child,
    done,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    alive: () => exited === null,
    /** Resolves with the first stdout line matching `pattern`, or a sentinel. */
    awaitLine(pattern, ms) {
      const already = pattern.exec(stdout);
      if (already !== null) return Promise.resolve(already[0]);
      waitingPattern = pattern;
      const seen = new Promise((settle) => {
        waitingFor = settle;
      });
      return withTimeout(Promise.race([seen, done.then(() => 'EXITED')]), ms, 'TIMEOUT');
    },
  };
}

/** Terminates one process and waits until it is really gone. */
async function killAndWait(handle) {
  if (!handle.alive()) return;
  try {
    execFileSync('taskkill', ['/PID', String(handle.child.pid), '/T', '/F'], { stdio: 'pipe' });
  } catch {
    try {
      handle.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await withTimeout(handle.done, 30_000, 'TIMEOUT');
}

/** One request, answered as status plus headers plus the raw response BYTES. */
function fetchRaw(port, { path = '/', method = 'GET' } = {}) {
  return new Promise((settle, fail) => {
    const call = httpRequest({ host: '127.0.0.1', port, path, method }, (response) => {
      /** @type {Buffer[]} */
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        settle({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    call.on('error', fail);
    call.end();
  });
}

/* ── the deployment ──────────────────────────────────────────────────────── */

/**
 * A runtime this harness may execute, inside the checkout.
 *
 * A deployed runtime is not self-contained — `cli/index.js` imports
 * `commander`, which Node resolves by walking up to a `node_modules` — so one
 * placed under the OS temp root dies on its first import, before any of its own
 * behaviour is reachable. `<repo>/tmp` is ignored by Git and sits beside
 * `<repo>/node_modules`, which is why the runtime deployment harness uses it
 * too.
 */
const tmpParent = join(repoRoot, 'tmp');
mkdirSync(tmpParent, { recursive: true });
const scratchRoot = realpathSync.native(mkdtempSync(join(tmpParent, 'ao-dashboard-ui-')));
const runtimeRoot = join(scratchRoot, 'runtime');

process.on('exit', () => {
  // Swallowed deliberately. On Windows a file in a runtime whose process has
  // only just been killed can still be held open, and `force: true` does not
  // cover that — a throw here would run *after* the verdict has been decided
  // and would replace this gate's exit code with a crash, turning a passing
  // run into a failing one over a directory Git already ignores.
  try {
    rmSync(scratchRoot, { recursive: true, force: true });
  } catch {
    /* `tmp/` is ignored; a leftover costs disk and nothing else */
  }
});

const deployModule = await import(
  pathToFileURL(join(repoRoot, 'scripts', 'deploy-runtime.mjs')).href
);

// Both authorisations are passed deliberately. This harness runs wherever it is
// run — a feature branch, a dirty tree mid-development — and the policy those
// flags exist for is about the REAL runtime, which this never touches. What the
// deployment refuses without them is measured, against throwaway repositories,
// in runtime-deployment-dist-artifact.mjs; re-measuring it here would be a
// second copy of someone else's gate.
const deployment = deployModule.deployRuntime({
  repoRoot,
  target: runtimeRoot,
  allowNonCanonical: 'dashboard ui dist gate',
  allowDirty: 'dashboard ui dist gate (dirty)',
});

if (deployment.ok !== true) {
  console.error(`dashboard UI dist gate FAILED: the deployment was refused (${deployment.code}):`);
  console.error(deployment.message);
  process.exit(1);
}

const deployedUiDir = join(runtimeRoot, 'dashboard', 'ui');
const deployedManifestModule = join(runtimeRoot, 'dashboard', 'ui-assets.js');

if (!existsSync(deployedManifestModule)) {
  console.error(
    `dashboard UI dist gate FAILED: the deployed runtime has no dashboard/ui-assets.js, so there ` +
      'is no manifest to read and nothing below can be asked.',
  );
  process.exit(1);
}

// The authority is read out of the DEPLOYED artefact, never out of `src/`. A
// manifest imported from the source tree would let this harness agree with
// itself about a runtime that shipped a different one.
const { UI_ASSET_MANIFEST, SHELL_ROUTES } = await import(
  pathToFileURL(deployedManifestModule).href
);

/**
 * The REAL artefact `ui/` directories this harness holds, labelled for a reader.
 *
 * Named once, here, because two things are derived from it: what section A2
 * sweeps, and how many checks that sweep is worth in the floor at the bottom.
 * A third artefact added to this list therefore raises the floor by itself.
 *
 * Both are genuine artefacts — one is what `npm run build` emitted into this
 * checkout, the other is what `deployRuntime` just wrote into the throwaway
 * runtime. Neither was assembled by this file, which is the whole reason the
 * sweep below means anything.
 */
const ARTEFACT_UI_DIRS = Object.freeze([
  Object.freeze({ label: 'build/dashboard/ui', dir: buildUiDir }),
  Object.freeze({ label: "the deployed runtime's dashboard/ui", dir: deployedUiDir }),
]);

/** How many checks section A2 runs per artefact. See `nothingUnnamedShips`. */
const REVERSE_CHECKS_PER_ARTEFACT = 2;

/* ── A. the two emit call sites agree ────────────────────────────────────── */

function theBuildAndTheDeploymentEmitTheSameBytes() {
  for (const entry of UI_ASSET_MANIFEST) {
    const built = join(buildUiDir, entry.file);
    const deployed = join(deployedUiDir, entry.file);
    if (!existsSync(built)) {
      check(false, `build/dashboard/ui/${entry.file} is missing, so the emit call sites cannot be compared`);
      continue;
    }
    if (!existsSync(deployed)) {
      check(false, `the deployed runtime has no dashboard/ui/${entry.file}`);
      continue;
    }
    check(
      readFileSync(built).equals(readFileSync(deployed)),
      `dashboard/ui/${entry.file} differs between the build output and the deployed runtime`,
    );
  }
}

/* ── A2. nothing unnamed ships inside either artefact ────────────────────── */

/**
 * Every entry in each artefact's `ui/` is named by the manifest.
 *
 * `ui-assets.ts` states this as a guarantee — *"every file in the artefact must
 * be named by the manifest — so a drifted mirror cannot ship"* — and until this
 * section existed the only place it was checked was a directory the checking
 * test had filled itself one line earlier. Over a real artefact the property
 * has teeth: `npm run build` never deletes, so renaming an asset leaves its
 * predecessor in `build/dashboard/ui` with nothing naming it. Measured, with
 * one stray `app-old.js` in that directory: `test:dist-dashboard-assets` exits
 * 0 and `dashboard-08` passes 29/29 — and before this section existed so did
 * this gate, reporting its full 79 checks, because nothing counted the
 * directory.
 *
 * Runs BEFORE section C on purpose. C moves an asset aside to `<file>.parked`
 * and puts it back; sweeping the deployed directory afterwards would either
 * read a `.parked` file as an orphan or depend on C's restore having worked,
 * and this section is not the place to measure that.
 *
 * Reads only. It creates nothing, renames nothing and deletes nothing, in
 * either directory — one of the two is this checkout's own `build/`.
 */
function nothingUnnamedShips() {
  const named = new Set(UI_ASSET_MANIFEST.map((entry) => entry.file));

  for (const artefact of ARTEFACT_UI_DIRS) {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(artefact.dir, { withFileTypes: true });
    } catch (error) {
      // Two failures, not one, so the count below stays `REVERSE_CHECKS_PER_ARTEFACT`
      // on every path through this loop — a floor derived from a per-artefact
      // constant is only a floor if the constant is true of the error path too.
      check(false, `${artefact.label} could not be read: ${String(error)}`);
      check(false, `${artefact.label} was therefore never compared against the manifest`);
      continue;
    }

    // Asserted first, because "no entry is unnamed" is trivially true of an
    // empty directory — and a deployed artefact with an empty `ui/` is a worse
    // outcome than one with a stray file in it.
    check(
      entries.length > 0,
      `${artefact.label} holds no entries at all, so the comparison below passed over nothing`,
    );

    const unnamed = entries
      .filter((entry) => !named.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    check(
      unnamed.length === 0,
      `${artefact.label} holds ${String(unnamed.length)} entr${
        unnamed.length === 1 ? 'y' : 'ies'
      } the manifest does not name: ${unnamed.join(', ')}. The build never deletes, so a renamed ` +
        'or retired asset stays behind and ships beside the real ones.',
    );
  }
}

/* ── B. the deployed CLI serves what was deployed beside it ──────────────── */

/** The shell digest, recomputed over the artefact that actually shipped. */
function shellDigestOf(root) {
  const hash = createHash('sha256');
  for (const entry of UI_ASSET_MANIFEST) {
    if (!SHELL_ROUTES.includes(entry.route)) continue;
    hash.update(entry.file, 'utf8');
    hash.update(readFileSync(join(root, entry.file)));
  }
  return hash.digest('hex');
}

async function theDeployedCliServesItsOwnAssets() {
  const port = await freePort();
  const handle = launch(runtimeRoot, ['dashboard', 'serve', '--port', String(port)]);

  try {
    const line = await handle.awaitLine(/^AO Manager listening on \S+$/m, 60_000);
    check(line !== 'TIMEOUT', 'the deployed CLI never announced a listener within 60s');
    check(
      line !== 'EXITED',
      `the deployed CLI exited before listening (code ${String(handle.exited?.code)}): ` +
        handle.stderr.trim(),
    );
    // The exact sentence `registerDashboardCommand` writes for
    // `UI_ASSETS_UNUSABLE`. A deployment that carried no UI would land here,
    // and it is worth naming separately from "it did not start", because the
    // two send an operator to different places.
    check(
      !handle.stderr.includes('shipped user interface is incomplete'),
      `the deployed CLI refused to serve: ${handle.stderr.trim()}`,
    );
    if (line === 'TIMEOUT' || line === 'EXITED') return;

    check(
      line === `AO Manager listening on http://127.0.0.1:${String(port)}`,
      `the startup line was ${JSON.stringify(line)}`,
    );

    /* every route, its type, its length, and its bytes */
    for (const entry of UI_ASSET_MANIFEST) {
      const answer = await fetchRaw(port, { path: entry.route });
      check(
        answer.status === 200,
        `GET ${entry.route} answered ${String(answer.status)}, expected 200`,
      );
      if (answer.status !== 200) continue;
      check(
        answer.headers['content-type'] === entry.contentType,
        `${entry.route} carried content-type ${String(answer.headers['content-type'])}, ` +
          `expected ${entry.contentType}`,
      );
      // Against the DEPLOYED FILE's size, and deliberately not against
      // `answer.body.length`. Node's client reads a response body according to
      // the very `Content-Length` it is being compared with, so
      // `body.length === Number(contentLength)` is true of every response any
      // server could ever send — it is a value compared with itself, and it was
      // written that way here before this comment replaced it. The file on disk
      // is the independent quantity, and a truncated or padded body is exactly
      // what it catches.
      const onDisk = readFileSync(join(deployedUiDir, entry.file));
      check(
        answer.headers['content-length'] === String(onDisk.length),
        `${entry.route} declared Content-Length ${String(answer.headers['content-length'])} ` +
          `for a deployed file of ${String(onDisk.length)} bytes`,
      );
      // The link the whole chain is for: what came back over the socket is what
      // the deployment put on disk. `icon-192.png` and `icon-512.png` are the
      // ones that matter most — an icon is the only asset that is not text, so
      // a stray encoding step corrupts it and nothing else in this repository
      // would see it.
      check(
        answer.body.equals(onDisk),
        `the bytes served for ${entry.route} are not the bytes deployed to ` +
          `dashboard/ui/${entry.file}`,
      );
      // Slice 4 gave a served asset its own policy. Asserted per route rather
      // than once, because it is applied per response.
      check(
        answer.headers['content-security-policy'] ===
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
            "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; " +
            "form-action 'none'; frame-ancestors 'none'",
        `${entry.route} did not carry the UI content security policy: ` +
          String(answer.headers['content-security-policy']),
      );
      check(
        !String(answer.headers['content-security-policy'] ?? '').includes('unsafe-inline'),
        `${entry.route} carried a policy allowing unsafe-inline`,
      );
    }

    /* the two policies are different policies, seen in one run */
    const snapshot = await fetchRaw(port, { path: '/api/snapshot' });
    check(
      snapshot.status === 200,
      `GET /api/snapshot answered ${String(snapshot.status)}, expected 200`,
    );
    check(
      snapshot.headers['content-security-policy'] === "default-src 'none'; frame-ancestors 'none'",
      `/api/snapshot did not carry the empty policy: ` +
        String(snapshot.headers['content-security-policy']),
    );
    const anAsset = await fetchRaw(port, { path: '/app.css' });
    check(
      anAsset.headers['content-security-policy'] !== snapshot.headers['content-security-policy'],
      'a served asset and the snapshot carried the same policy, so the slice-4 split is not there',
    );

    /* the worker's digest, recomputed over the artefact that shipped */
    const worker = await fetchRaw(port, { path: '/sw.js' });
    check(worker.status === 200, `GET /sw.js answered ${String(worker.status)}, expected 200`);
    const workerText = worker.body.toString('utf8');
    check(
      !workerText.includes('__AO_SHELL_'),
      'a build-time placeholder survived into the service worker the deployed CLI serves',
    );
    const recomputed = shellDigestOf(deployedUiDir);
    check(
      /^[0-9a-f]{64}$/.test(recomputed),
      `the recomputed shell digest is not 64 hex characters: ${recomputed}`,
    );
    // Not "it looks like a digest" — that is true of a worker shipped beside a
    // shell it was never built from, which is exactly the state in which no
    // installed browser ever sees another deployment. This is the value, taken
    // over the six files as they sit in the deployed runtime.
    check(
      workerText.includes(`ao-shell-${recomputed}`),
      `the served worker does not name ao-shell-${recomputed}, the digest of the shell that was ` +
        'actually deployed beside it',
    );
    // And the shell it hashes is the six-file one, so the check above is not
    // quietly hashing all seven.
    check(
      SHELL_ROUTES.length === UI_ASSET_MANIFEST.length - 1 && !SHELL_ROUTES.includes('/sw.js'),
      `the deployed shell is ${String(SHELL_ROUTES.length)} of ` +
        `${String(UI_ASSET_MANIFEST.length)} routes and the digest input is not the shell`,
    );

    /* the map is closed, and keyed by route rather than by path */
    for (const path of ['/nope', '/index.html']) {
      const missing = await fetchRaw(port, { path });
      check(
        missing.status === 404,
        `${path} answered ${String(missing.status)}, expected 404 — the deployed runtime has its ` +
          'own compiled manifest, and a build that joined a request target onto a directory ' +
          'would answer 200 here',
      );
    }

    /* an asset is offered by GET, and the refusal says so */
    const posted = await fetchRaw(port, { path: '/app.css', method: 'POST' });
    check(
      posted.status === 405,
      `POST /app.css answered ${String(posted.status)}, expected 405`,
    );
    check(
      posted.headers.allow === 'GET',
      `POST /app.css did not name the allowed method: ${String(posted.headers.allow)}`,
    );

    check(handle.alive(), 'the deployed Manager died while it was being asked questions');
  } finally {
    await killAndWait(handle);
  }
}

/* ── C. the negative control ─────────────────────────────────────────────── */

async function anIncompleteRuntimeRefusesBeforeItBinds() {
  const port = await freePort();
  const release = await occupy(port);
  const hostage = join(deployedUiDir, HOSTAGE_FILE);
  const parked = `${hostage}.parked`;

  try {
    /* C1 — the positive control for the occupation itself */
    const intact = launch(runtimeRoot, ['dashboard', 'serve', '--port', String(port)]);
    const intactEnded = await withTimeout(intact.done, 60_000, 'TIMEOUT');
    await killAndWait(intact);
    check(intactEnded !== 'TIMEOUT', 'a complete runtime on a held port did not exit within 60s');
    check(
      intactEnded !== 'TIMEOUT' && intactEnded.code === EXIT_RUN_REFUSED,
      `a complete runtime on a held port exited ${String(
        intactEnded === 'TIMEOUT' ? 'TIMEOUT' : intactEnded.code,
      )}, expected ${String(EXIT_RUN_REFUSED)} — without this the case below proves nothing, ` +
        'because a port that accepts binds makes "no EADDRINUSE" true of every build',
    );
    check(
      intact.stderr.includes('EADDRINUSE'),
      'a complete runtime on a held port did not report EADDRINUSE, so the port is not held',
    );

    /* C2 — one asset away, and the same held port */
    //
    // Guarded rather than assumed. A runtime deployed WITHOUT its UI has no
    // hostage to take, and an unguarded `renameSync` turns that into an
    // uncaught ENOENT — which exits nonzero, so the gate still blocks, but
    // replaces every named failure this run had already recorded with a stack
    // trace. Measured: it is what removing `emitUiAssets` from `deployRuntime`
    // produced the first time that mutant was run against this file.
    check(existsSync(hostage), `the deployed runtime has no dashboard/ui/${HOSTAGE_FILE} to move`);
    if (!existsSync(hostage)) return;
    renameSync(hostage, parked);
    check(!existsSync(hostage), `dashboard/ui/${HOSTAGE_FILE} was not moved aside`);

    const crippled = launch(runtimeRoot, ['dashboard', 'serve', '--port', String(port)]);
    const crippledEnded = await withTimeout(crippled.done, 60_000, 'TIMEOUT');
    await killAndWait(crippled);

    check(crippledEnded !== 'TIMEOUT', 'an incomplete runtime did not exit within 60s');
    check(
      crippledEnded !== 'TIMEOUT' && crippledEnded.code === EXIT_RUN_UNEXPECTED,
      `an incomplete runtime exited ${String(
        crippledEnded === 'TIMEOUT' ? 'TIMEOUT' : crippledEnded.code,
      )}, expected ${String(EXIT_RUN_UNEXPECTED)}`,
    );
    check(
      crippled.stderr.includes('shipped user interface is incomplete'),
      `an incomplete runtime did not say why it refused: ${crippled.stderr.trim()}`,
    );
    check(
      crippled.stderr.includes(HOSTAGE_ROUTE),
      `the refusal did not name ${HOSTAGE_ROUTE}: ${crippled.stderr.trim()}`,
    );
    // The route and never the path: that sentence reaches an operator, and a
    // path names this machine.
    check(
      !crippled.stderr.includes(deployedUiDir),
      'the refusal printed a filesystem path, which names this machine',
    );
    // The ordering, read off the exit code. C1 established that this port
    // refuses a bind, so a run that never mentions EADDRINUSE never reached
    // one — the assets were refused first, which is what "no socket was
    // opened" means for a process with no tripwire in it.
    check(
      !crippled.stderr.includes('EADDRINUSE'),
      'an incomplete runtime tried to bind before it checked its assets',
    );
    check(
      crippled.stdout === '',
      `a refused start still printed: ${JSON.stringify(crippled.stdout)}`,
    );
    // Restored inside the `try`, where a failure to restore is still a check,
    // rather than after a `finally` that an early `return` would have skipped.
    renameSync(parked, hostage);
    check(existsSync(hostage), `dashboard/ui/${HOSTAGE_FILE} was not restored`);
  } finally {
    if (existsSync(parked) && !existsSync(hostage)) renameSync(parked, hostage);
    await release();
  }
}

/* ── the run ─────────────────────────────────────────────────────────────── */

/**
 * Runs one section, turning a thrown error into a recorded failure.
 *
 * Without this an exception anywhere replaces the whole failure list with a
 * stack trace. The run still exits nonzero, so nothing merges on it — but the
 * checks that had already failed, which are the ones naming what is actually
 * wrong, never reach the operator. Measured: removing `emitUiAssets` from
 * `deployRuntime` did exactly that to the first version of this file.
 */
async function section(name, run) {
  try {
    await run();
  } catch (error) {
    failures.push(`${name} threw: ${String(error?.stack ?? error)}`);
  }
}

await section('the emit call sites', theBuildAndTheDeploymentEmitTheSameBytes);
await section('the reverse manifest gate', nothingUnnamedShips);
await section('the deployed CLI serving its assets', theDeployedCliServesItsOwnAssets);
await section('the negative control', anIncompleteRuntimeRefusesBeforeItBinds);

/**
 * The count below which this run cannot have measured what it says it did.
 *
 * Derived from the manifest rather than written as a number, because seven of
 * the checks are per asset and the manifest is the thing that decides how many
 * assets there are — a hard-coded floor would have to be edited by whoever adds
 * an eighth one, and would silently stop being a floor if they forgot.
 *
 * The second term is derived one step further up for the same reason: section
 * A2's sweep is per ARTEFACT rather than per asset, and it runs the same
 * `REVERSE_CHECKS_PER_ARTEFACT` on every path including the unreadable one, so
 * a third artefact added to `ARTEFACT_UI_DIRS` raises this floor without
 * anyone editing it.
 */
const MINIMUM_CHECKS =
  UI_ASSET_MANIFEST.length * 7 + ARTEFACT_UI_DIRS.length * REVERSE_CHECKS_PER_ARTEFACT + 30;

if (checksRun < MINIMUM_CHECKS) {
  failures.push(
    `only ${String(checksRun)} of at least ${String(MINIMUM_CHECKS)} checks ran, so this gate ` +
      'took an early exit and measured a fraction of what it claims',
  );
}

if (failures.length > 0) {
  console.error(`dashboard UI dist gate FAILED (${String(failures.length)} issue(s)):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `dashboard UI dist gate: a deployed runtime serves all ${String(UI_ASSET_MANIFEST.length)} ` +
    'assets byte for byte over a real socket, refuses before it binds when one is missing, and ' +
    `neither of the ${String(ARTEFACT_UI_DIRS.length)} real artefacts holds a file the manifest ` +
    `does not name. ${String(checksRun)} checks ran.`,
);
