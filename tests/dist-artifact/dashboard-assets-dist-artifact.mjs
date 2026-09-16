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
 * ── Why this script writes its own placeholder assets ───────────────────────
 *
 * At this point in the plan's sequence, `src/dashboard/ui/` does not exist
 * (Task 5 creates it) and neither does `scripts/build-ui-assets.mjs` (Task 9),
 * so `build/dashboard/ui/` is never written by an ordinary build. This script
 * creates that directory itself, with one placeholder file per manifest
 * entry, stands the built CLI up against it, and deletes the directory again
 * on every exit path — it never touches a real shipped asset, because none
 * exists yet.
 *
 * ── What this control proves ────────────────────────────────────────────────
 *
 *  1. `dashboard serve`, run from the built artefact with a complete asset
 *     directory in the place the manifest and the loader agree on, reaches
 *     "listening" — it does NOT refuse with `UI_ASSETS_UNUSABLE`;
 *  2. an asset requested over the real socket comes back with the exact bytes
 *     this script wrote for it, proving the path by use rather than by
 *     inspecting a return value offline.
 *
 * It does not prove anything about the REAL shipped assets — there are none
 * yet — and it does not prove `loadUiAssets`'s all-or-nothing behaviour, which
 * `tests/dashboard-08-ui-assets.test.ts` already covers against a real
 * temporary directory.
 *
 * Contract: exit code 0 means every check passed. Any nonzero exit code means
 * at least one did not.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// A pre-existing `build/dashboard/ui` would mean either a real build step now
// writes it (Task 9 landed) or a previous run of this script crashed before
// its own cleanup. Either way, deleting it blindly would be a scratch-checkout
// mistake this repository has made before: mutate a scratch directory, never
// one that might be real.
if (existsSync(uiDir)) {
  console.error(
    `${uiDir} already exists. This script only ever creates and removes that directory itself; ` +
      'refusing to touch it rather than guess whether it is real. Remove it by hand if it is a ' +
      'leftover from a crashed run of this script.',
  );
  process.exit(1);
}

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

/* ── the fixture: placeholder bytes, one per manifest entry ──────────────── */

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

function removePlaceholderAssets() {
  rmSync(uiDir, { recursive: true, force: true });
}

/* ── the measurement ──────────────────────────────────────────────────────── */

async function theBuiltCliFindsItsOwnAssetsWithNoSeam() {
  writePlaceholderAssets();
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
    // what this script itself wrote to build/dashboard/ui — the path is
    // proved by use, not by inspecting defaultUiAssetRoot()'s return value.
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
      answer.body.equals(placeholderBytesFor(target.file)),
      `the served bytes for /app.js did not match what this script wrote for ${target.file}`,
    );
  } finally {
    await killAndWait(handle);
    removePlaceholderAssets();
  }
}

/* ── the run ─────────────────────────────────────────────────────────────── */

try {
  await theBuiltCliFindsItsOwnAssetsWithNoSeam();
} finally {
  // Belt and suspenders: an assertion thrown out of the function above (as
  // opposed to a recorded `check` failure) must not leave the directory
  // behind either.
  if (existsSync(uiDir)) removePlaceholderAssets();
}

if (failures.length > 0) {
  console.error('dashboard assets gate FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('dashboard assets gate: the shipped CLI finds its own UI beside itself, with no seam.');
