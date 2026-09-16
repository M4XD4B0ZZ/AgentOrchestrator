#!/usr/bin/env node
/**
 * DASHBOARD-001 slice 4 — the shipped CLI finds its own UI, with no seam.
 *
 * Standalone Node script, spawned by the `test:dist-dashboard-assets` npm
 * script. It drives `build/cli/index.js` as a real child process, with **no**
 * injected seam of any kind — no `loadAssets` override, no environment
 * tripwire, nothing — because the property under test is the CLI's own
 * DEFAULT wiring: where it looks for its assets when nobody tells it.
 *
 * ── Why this cannot be a vitest unit test ───────────────────────────────────
 *
 * `tests/dashboard-08-ui-assets.test.ts` already pins that
 * `defaultUiAssetRoot()` itself returns a path ending in `dashboard/ui`. That
 * is necessary but not sufficient: it stays green even if the CLI's action
 * handler is rewired back to `uiAssetRoot(import.meta.url)` — its OWN
 * `import.meta.url`, which is `build/cli/dashboard-command.js` once compiled,
 * naming `build/cli/ui` instead. Nothing in-process can see that regression,
 * because every in-process test supplies a `loadAssets` seam or an explicit
 * directory. Only running the BUILT artefact, unseamed, proves the wiring
 * that actually ships.
 *
 * ── Two modes, and why the choice is made before anything is written ────────
 *
 * When this script was first written, nothing emitted `build/dashboard/ui/`,
 * so it created that directory itself with one placeholder per manifest entry
 * and removed it again on every exit path. It also REFUSED to run if the
 * directory already existed, rather than guess whether it was real — because
 * deleting a directory it had not created is a mistake this repository has
 * made before.
 *
 * Task 9 made `npm run build` emit exactly that directory. Left as it was,
 * this gate would have refused to run on every developer machine and in CI
 * from that commit onward, and a gate that silently stops running is worse
 * than one that fails. So it now has two modes:
 *
 *   REAL        — `build/dashboard/ui/` exists. The shipped assets are used as
 *                 they are, nothing is written, and nothing is deleted. This
 *                 is the ordinary mode after `npm run build`.
 *   PLACEHOLDER — the directory is absent. This script creates it, fills it
 *                 with one placeholder per manifest entry, and removes it
 *                 again on every exit path, exactly as before.
 *
 * The mode is decided ONCE, before anything runs, and the cleanup is bound to
 * that same decision — so the safety property the original refusal protected
 * is kept: this script can only ever delete a directory it created itself.
 *
 * ── What this control proves ────────────────────────────────────────────────
 *
 *  1. `dashboard serve`, run from the built artefact with a complete asset
 *     directory in the place the manifest and the loader agree on, reaches
 *     "listening" — it does NOT refuse with `UI_ASSETS_UNUSABLE`;
 *  2. an asset requested over the real socket comes back with the exact bytes
 *     on disk for it, proving the path by use rather than by inspecting a
 *     return value offline;
 *  3. in REAL mode only: the service worker the built CLI actually serves
 *     names an `ao-shell-<64 hex>` cache and carries no surviving build-time
 *     placeholder. That substitution failing is invisible and permanent — a
 *     worker whose bytes never change is a worker no browser ever replaces —
 *     and this is the only place it is measured against bytes that came off a
 *     real build and out of a real socket.
 *
 * It does not prove `loadUiAssets`'s all-or-nothing behaviour, which
 * `tests/dashboard-08-ui-assets.test.ts` already covers against a real
 * temporary directory.
 *
 * Contract: exit code 0 means every check passed. Any nonzero exit code means
 * at least one did not.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const cliEntry = join(repoRoot, 'build', 'cli', 'index.js');
const uiAssetsEntry = join(repoRoot, 'build', 'dashboard', 'ui-assets.js');
const uiDir = join(repoRoot, 'build', 'dashboard', 'ui');

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(cliEntry) || !existsSync(uiAssetsEntry)) {
  console.error(
    'build/cli/index.js or build/dashboard/ui-assets.js does not exist. Run "npm run build" ' +
      'first (see "test:dist-dashboard-assets").',
  );
  process.exit(1);
}

/**
 * REAL when the shipped assets are already there, PLACEHOLDER when they are not.
 *
 * Read exactly once, here, before this script writes anything — and every
 * cleanup below is conditioned on this same constant rather than on a fresh
 * `existsSync`. That is what keeps the original safety property intact: a
 * directory this run did not create is never removed by it, whatever happens
 * in between.
 *
 * `npm run build` emits `build/dashboard/ui/` (scripts/build-ui-assets.mjs),
 * so REAL is the ordinary mode. PLACEHOLDER still exists because the property
 * under test — the built CLI finding its own assets with no seam — is about
 * the LOOKUP, and it is worth being able to measure that on a tree where the
 * emit has not run.
 */
const realAssets = existsSync(uiDir);
const mode = realAssets ? 'REAL' : 'PLACEHOLDER';

const uiAssetsModule = await import(pathToFileURL(uiAssetsEntry).href);
const manifest = uiAssetsModule.UI_ASSET_MANIFEST;

/* ── plumbing, matched to dashboard-listener-dist-artifact.mjs ───────────── */

/** Awaits `promise`, giving up after `ms`, and clears the timer either way. */
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

/** Starts the shipped CLI with NO seam of any kind — the whole point. */
function launch(args) {
  const child = spawn(process.execPath, [cliEntry, ...args], { env: { ...process.env } });

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

/** One GET, answered as status plus headers plus the raw response BYTES. */
function getBytes(port, path) {
  return new Promise((settle, fail) => {
    const call = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      /** @type {Buffer[]} */
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        settle({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }),
      );
    });
    call.on('error', fail);
    call.end();
  });
}

/* ── the fixture: real assets, or placeholders when there are none ───────── */

/** Distinct, deterministic bytes per file — never the file's real content. */
function placeholderBytesFor(file) {
  return Buffer.from(`placeholder-bytes-for:${file}`, 'utf8');
}

function writePlaceholderAssets() {
  mkdirSync(uiDir, { recursive: true });
  for (const entry of manifest) {
    writeFileSync(join(uiDir, entry.file), placeholderBytesFor(entry.file));
  }
}

/** Only ever called in PLACEHOLDER mode; see `realAssets` above. */
function removePlaceholderAssets() {
  rmSync(uiDir, { recursive: true, force: true });
}

/**
 * What the server ought to answer with for `file`, read from the tree it is
 * serving out of.
 *
 * In REAL mode this is the shipped file itself, so the comparison below is
 * against bytes a build produced rather than against bytes this script
 * invented. The property — "the built CLI reads the directory the manifest and
 * the loader agree on" — is the same either way.
 */
function expectedBytesFor(file) {
  return realAssets ? readFileSync(join(uiDir, file)) : placeholderBytesFor(file);
}

/* ── the measurement ──────────────────────────────────────────────────────── */

async function theBuiltCliFindsItsOwnAssetsWithNoSeam() {
  if (realAssets) {
    // A directory that exists but is incomplete would otherwise surface only as
    // "the built CLI refused to serve", which names the symptom and not the
    // cause. The loader is all-or-nothing, so one absent file is the whole UI.
    const absent = manifest
      .filter((entry) => !existsSync(join(uiDir, entry.file)))
      .map((entry) => entry.file);
    check(
      absent.length === 0,
      `${uiDir} exists but does not hold ${absent.join(', ')}. Run "npm run build", or remove ` +
        'that directory if it is a leftover from a crashed run of this script.',
    );
    if (absent.length > 0) return;
  } else {
    writePlaceholderAssets();
  }

  const port = await freePort();
  const handle = launch(['dashboard', 'serve', '--port', String(port)]);

  try {
    const line = await handle.awaitLine(/^AO Manager listening on \S+$/m, 60_000);

    check(line !== 'TIMEOUT', 'the built CLI never announced a listener within 60s');
    check(
      line !== 'EXITED',
      `the built CLI exited before listening (code ${String(handle.exited?.code)}): ` +
        `${handle.stderr.trim()}`,
    );
    // The specific regression this script exists to catch: refusing because
    // it looked in build/cli/ui instead of build/dashboard/ui, even though
    // every placeholder asset is sitting right there. This is the exact
    // sentence `registerDashboardCommand` writes for `UI_ASSETS_UNUSABLE`.
    check(
      !handle.stderr.includes('shipped user interface is incomplete'),
      `the built CLI refused to serve: ${handle.stderr.trim()}`,
    );
    if (line === 'TIMEOUT' || line === 'EXITED') return;

    check(
      line === `AO Manager listening on http://127.0.0.1:${String(port)}`,
      `the startup line was ${JSON.stringify(line)}`,
    );

    // One asset, fetched over the real socket, compared byte for byte against
    // what is on disk in build/dashboard/ui — the path is proved by use, not
    // by inspecting defaultUiAssetRoot()'s return value.
    const target = manifest.find((entry) => entry.route === '/app.js');
    check(target !== undefined, 'the manifest carries no /app.js entry to fetch');
    if (target === undefined) return;

    const answer = await getBytes(port, '/app.js');
    check(answer.status === 200, `GET /app.js answered ${String(answer.status)}, expected 200`);
    check(
      answer.headers['content-type'] === target.contentType,
      `content-type was ${String(answer.headers['content-type'])}, expected ${target.contentType}`,
    );
    check(
      answer.body.equals(expectedBytesFor(target.file)),
      `the served bytes for /app.js did not match ${join(uiDir, target.file)}`,
    );

    // REAL mode only — placeholders carry no digest, and asserting one against
    // them would be asserting against this script's own invention.
    //
    // This is the substitution measured where it ships: bytes written by
    // `npm run build`, read by the built CLI with no seam, and handed back over
    // a socket. A worker that kept its placeholder would have bytes that never
    // change again, so no installed client would ever see another deployment.
    if (realAssets) {
      const worker = await getBytes(port, '/sw.js');
      check(worker.status === 200, `GET /sw.js answered ${String(worker.status)}, expected 200`);
      const text = worker.body.toString('utf8');
      check(
        /ao-shell-[0-9a-f]{64}/.test(text),
        'the served service worker names no ao-shell-<64 hex> cache, so the build-time digest ' +
          `never reached it. If ${uiDir} was left behind by a crashed run of this script rather ` +
          'than written by "npm run build", it holds placeholders and this is what that looks ' +
          'like: remove it and build.',
      );
      check(
        !text.includes('__AO_SHELL_'),
        'a build-time placeholder survived into the served service worker',
      );
    }
  } finally {
    await killAndWait(handle);
    if (!realAssets) removePlaceholderAssets();
  }
}

/* ── the run ─────────────────────────────────────────────────────────────── */

try {
  await theBuiltCliFindsItsOwnAssetsWithNoSeam();
} finally {
  // Belt and suspenders: an assertion thrown out of the function above (as
  // opposed to a recorded `check` failure) must not leave the directory
  // behind either — but only in the mode that created it.
  if (!realAssets && existsSync(uiDir)) removePlaceholderAssets();
}

if (failures.length > 0) {
  console.error(`dashboard assets gate FAILED (${mode} assets):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `dashboard assets gate (${mode} assets): the shipped CLI finds its own UI beside itself, ` +
    'with no seam.',
);
