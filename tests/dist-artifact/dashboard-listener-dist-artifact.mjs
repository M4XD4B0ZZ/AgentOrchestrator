#!/usr/bin/env node
/**
 * DASHBOARD-001 slice 3 — the inbound socket, against the shipped artefact.
 *
 * Standalone Node script, spawned by the `test:dist-dashboard-listen` npm
 * script and transitively by `verify`. It drives `build/cli/index.js` as a real
 * process, four times, with the listen tripwire from
 * `dashboard-listen-preload.cjs` installed ahead of the ESM entry point.
 *
 * ── What this control proves ───────────────────────────────────────────────
 *
 * The property is **command-scoped capability**: this binary can open an
 * inbound socket, and it does so only when one verb asks for one.
 *
 *  1. an ordinary command — `attention`, read-only and agent-free — runs to its
 *     end with every listening surface armed fatal, and opens none;
 *  2. the same binary with the same tripwire, given `dashboard serve`, **dies**
 *     on exit 88. That is the positive control, and without it case 1 is a
 *     green light that measures nothing: a tripwire that had stopped being
 *     installed would pass case 1 exactly as it does now;
 *  3. `dashboard serve` under the bounded mode comes up on `127.0.0.1` and on
 *     nothing else — the address is read back off the listener rather than from
 *     the argument that asked for it — announces itself on stdout, answers the
 *     one route with the caching semantics the slice specified, refuses a Host
 *     nobody allowed, and opens exactly ONE listener for the whole run;
 *  4. a port already held produces a refusal carrying `EADDRINUSE`, exit 4, and
 *     **zero** listeners. No fallback port, no fallback address.
 *
 * Egress stays fatal throughout. The Manager reaches nothing, and a gate that
 * watched only the direction it is named for would let the other one past.
 *
 * ── What it does not prove, stated because a control that overclaims is worse
 *    than one that is missing ──────────────────────────────────────────────
 *
 * It does not prove that *no other* verb could ever listen — it runs one of
 * them. The tree-wide half of that claim is a source sweep, in
 * `tests/dashboard-07-serve-command.test.ts`, which pins `createServer` and
 * `.listen(` to one module. This half proves the shipped binary behaves that
 * way in a real process, which the sweep cannot see.
 *
 * It says nothing about whether AgentOrchestrator is running. Nothing can: this
 * build writes no heartbeat, and the Manager answering is evidence about the
 * Manager.
 *
 * Contract: exit 0 means every check passed. Any nonzero exit means at least
 * one did not.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const cliEntry = join(repoRoot, 'build', 'cli', 'index.js');
const preload = join(scriptDir, 'dashboard-listen-preload.cjs');

/** Mirrors of the preload's sentinels. */
const EXIT_INSTRUMENTATION_FAILED = 89;
const EXIT_LISTENED = 88;
const EXIT_NOT_LOOPBACK = 87;
const EXIT_EGRESS_ATTEMPTED = 86;

/** The CLI's own grade for an invocation that was refused. */
const EXIT_RUN_REFUSED = 4;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(cliEntry)) {
  console.error(
    'build/cli/index.js does not exist. Run "npm run build" first (see "verify:dist-dashboard-listen").',
  );
  process.exit(1);
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

/**
 * Awaits `promise`, giving up after `ms`, and clears the timer either way.
 *
 * Written out rather than `Promise.race([promise, sleep(ms)])`: `race` settles
 * on the winner and abandons the loser, so the guard timer stays armed and
 * holds this process alive for the whole guard after the work it guarded
 * finished. Another harness in this directory hung for exactly that reason.
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

/** Starts the shipped CLI with the tripwire armed, and follows its output. */
function launch(mode, args) {
  const child = spawn(process.execPath, ['--require', preload, cliEntry, ...args], {
    env: { ...process.env, AO_DASHBOARD_LISTEN: mode },
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
    /** Resolves with the first stdout line matching `pattern`, or `TIMEOUT`. */
    awaitLine(pattern, ms) {
      const already = pattern.exec(stdout);
      if (already !== null) return Promise.resolve(already[0]);
      waitingPattern = pattern;
      const seen = new Promise((settle) => {
        waitingFor = settle;
      });
      // A child that dies before the line arrives must not leave this pending.
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
    // Already gone, or not Windows: fall through to the wait below.
    try {
      handle.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await withTimeout(handle.done, 30_000, 'TIMEOUT');
}

/** One HTTP request to the Manager, answered as status plus headers plus body. */
function ask(port, { path = '/api/snapshot', method = 'GET', headers = {} } = {}) {
  return new Promise((settle, fail) => {
    const call = httpRequest(
      { host: '127.0.0.1', port, path, method, headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () =>
          settle({ status: response.statusCode, headers: response.headers, body }),
        );
      },
    );
    call.on('error', fail);
    call.end();
  });
}

/** Every listener the preload reported, as `{host, port}`. */
function listenersReported(stderr) {
  return [...stderr.matchAll(/^dashboard-listen-preload: listen (\S+) (\d+)$/gm)].map((match) => ({
    host: match[1],
    port: Number(match[2]),
  }));
}

/* ── 1. an ordinary command opens nothing ────────────────────────────────── */

async function ordinaryCommandOpensNoListener() {
  // `attention` is the right subject: it runs a real command action to its end,
  // reads one directory under the operator's profile, starts no program, needs
  // no repository and always exits 0. A verb that refused early would prove
  // nothing about what a command does while it works.
  const handle = launch('FORBID', ['attention']);
  const ended = await withTimeout(handle.done, 60_000, 'TIMEOUT');
  await killAndWait(handle);

  check(ended !== 'TIMEOUT', 'the ordinary command did not finish within 60s');
  if (ended === 'TIMEOUT') return;

  check(
    ended.code !== EXIT_LISTENED,
    `\`attention\` opened a listening socket (exit ${EXIT_LISTENED})`,
  );
  check(
    ended.code !== EXIT_EGRESS_ATTEMPTED,
    `\`attention\` opened an outbound socket (exit ${EXIT_EGRESS_ATTEMPTED})`,
  );
  check(
    ended.code !== EXIT_INSTRUMENTATION_FAILED,
    `the tripwire did not install: ${handle.stderr.trim()}`,
  );
  check(ended.code === 0, `\`attention\` exited ${String(ended.code)}, expected 0`);
  check(
    handle.stderr.includes('dashboard-listen-preload: armed FORBID'),
    'the tripwire never reported itself armed',
  );
  check(
    listenersReported(handle.stderr).length === 0,
    'a listener was reported for an ordinary command',
  );
}

/* ── 2. the tripwire can fail ────────────────────────────────────────────── */

async function theTripwireCatchesTheOneVerbThatListens() {
  // The positive control. Without it, case 1 is an absence assertion with no
  // subject: a preload that had stopped being installed, or a `listen`
  // substitution that no longer took, would leave case 1 green.
  const port = await freePort();
  const handle = launch('FORBID', ['dashboard', 'serve', '--port', String(port)]);
  const ended = await withTimeout(handle.done, 60_000, 'TIMEOUT');
  await killAndWait(handle);

  check(ended !== 'TIMEOUT', 'the armed serve did not die within 60s');
  if (ended === 'TIMEOUT') return;
  check(
    ended.code === EXIT_LISTENED,
    `an armed \`dashboard serve\` exited ${String(ended.code)}, expected ${EXIT_LISTENED}`,
  );
}

/* ── 3. the listener, bounded ────────────────────────────────────────────── */

async function theManagerServesOnLoopbackOnly() {
  const port = await freePort();
  const handle = launch('BOUND_LOOPBACK', [
    'dashboard',
    'serve',
    '--port',
    String(port),
    '--allow-host',
    'ao-manager.invalid',
  ]);

  try {
    const line = await handle.awaitLine(/^AO Manager listening on \S+$/m, 60_000);
    check(line !== 'TIMEOUT', 'the Manager never announced a listener within 60s');
    check(line !== 'EXITED', `the Manager exited before listening: ${handle.stderr.trim()}`);
    if (line === 'TIMEOUT' || line === 'EXITED') return;

    // The startup line is local, exact, and guesses nothing.
    check(
      line === `AO Manager listening on http://127.0.0.1:${String(port)}`,
      `the startup line was ${JSON.stringify(line)}`,
    );
    for (const guess of ['ts.net', 'tailscale', 'https://', '0.0.0.0', 'localhost', '100.']) {
      check(
        !handle.stdout.toLowerCase().includes(guess),
        `the startup output named ${guess}, which this build cannot know`,
      );
    }

    /* the one route */
    const ok = await ask(port);
    check(ok.status === 200, `GET /api/snapshot answered ${String(ok.status)}`);
    check(
      ok.headers['content-type'] === 'application/json; charset=utf-8',
      `content-type was ${String(ok.headers['content-type'])}`,
    );
    check(ok.headers['cache-control'] === 'no-store', 'Cache-Control was not no-store');
    check(ok.headers['x-content-type-options'] === 'nosniff', 'nosniff was missing');
    check(
      ok.headers['content-security-policy'] === "default-src 'none'; frame-ancestors 'none'",
      'the content security policy was not the empty one',
    );
    check(
      typeof ok.headers.etag === 'string' && ok.headers.etag.startsWith('W/"'),
      `the ETag was ${String(ok.headers.etag)} and must be weak`,
    );
    check(ok.headers['strict-transport-security'] === undefined, 'HSTS was sent');
    check(ok.headers['access-control-allow-origin'] === undefined, 'a CORS header was sent');
    check(ok.headers['set-cookie'] === undefined, 'a cookie was sent');
    check(ok.headers.location === undefined, 'a Location header was sent');

    let parsed = null;
    try {
      parsed = JSON.parse(ok.body);
    } catch {
      check(false, 'the body was not JSON');
    }
    check(
      parsed !== null && typeof parsed.revision === 'string',
      'the body carried no revision',
    );
    check(
      parsed !== null && ok.headers.etag === `W/"${parsed.revision}"`,
      'the ETag was not the snapshot revision',
    );
    // Redaction, checked against the BYTES and against the field names slice 2
    // actually removes. The first version of this check asked whether the
    // top-level object had a `repositoryRoot` key — a key the internal model
    // does not have at that level either, so it was true of every possible
    // response including one serving the raw internal value. The machine-local
    // fields live one and two levels down and are named below.
    const internalOnly = [
      'canonicalRoot',
      'declaredPath',
      'repositoryRoot',
      'recordedWorktreePath',
      'worktreePath',
      'ownerPid',
    ];
    for (const field of internalOnly) {
      check(!ok.body.includes(`"${field}"`), `the snapshot carried the internal field ${field}`);
    }
    // And no path shape at all: a drive letter, a UNC prefix, or a POSIX home.
    check(!/[A-Za-z]:\\\\/.test(ok.body), 'the snapshot carried a Windows drive-letter path');
    check(!ok.body.includes('\\\\\\\\'), 'the snapshot carried a UNC path');
    check(!/"\/(home|Users)\//.test(ok.body), 'the snapshot carried a POSIX home path');

    // Positive control for the two above: the real snapshot is not empty, so
    // these are absences over something rather than over nothing.
    check(
      parsed !== null && typeof parsed.registry === 'object' && parsed.registry !== null,
      'the snapshot carried no registry reading, so the redaction checks had no subject',
    );

    /* the caching semantics */
    const revalidated = await ask(port, { headers: { 'If-None-Match': ok.headers.etag } });
    check(revalidated.status === 304, `a matching If-None-Match answered ${String(revalidated.status)}`);
    check(revalidated.body === '', 'the 304 carried a body');
    check(revalidated.headers.etag === ok.headers.etag, 'the 304 dropped the validator');

    const stale = await ask(port, { headers: { 'If-None-Match': 'W/"not-this-one"' } });
    check(stale.status === 200, `a stale If-None-Match answered ${String(stale.status)}`);

    /* the Host allow-list */
    const misdirected = await ask(port, { headers: { Host: 'evil.example' } });
    check(misdirected.status === 421, `an unlisted Host answered ${String(misdirected.status)}`);
    const allowed = await ask(port, { headers: { Host: 'AO-Manager.invalid' } });
    check(allowed.status === 200, `an allowed opaque Host answered ${String(allowed.status)}`);

    /* the routes that are not there */
    for (const path of ['/', '/pause', '/tasks/X', '/api/snapshot/', '/health']) {
      const missing = await ask(port, { path });
      check(missing.status === 404, `${path} answered ${String(missing.status)}, expected 404`);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const refused = await ask(port, { method });
      check(refused.status === 405, `${method} answered ${String(refused.status)}, expected 405`);
      if (method !== 'HEAD') {
        check(refused.headers.allow === 'GET', `${method} did not name the allowed method`);
      }
    }

    /* exactly one listener, on the loopback literal */
    const listeners = listenersReported(handle.stderr);
    check(
      listeners.length === 1,
      `the run opened ${String(listeners.length)} listeners, expected exactly 1`,
    );
    check(
      listeners[0] !== undefined && listeners[0].host === '127.0.0.1',
      `the listener came up on ${String(listeners[0]?.host)}`,
    );
    check(
      listeners[0] !== undefined && listeners[0].port === port,
      `the listener came up on port ${String(listeners[0]?.port)}, not ${String(port)}`,
    );
    check(handle.alive(), 'the Manager died while it was being asked questions');
    check(
      !handle.stderr.includes('was reached'),
      `the Manager reached out: ${handle.stderr.trim()}`,
    );
  } finally {
    await killAndWait(handle);
  }
}

/* ── 4. a collision is a refusal, not a different port ───────────────────── */

async function aBusyPortIsReportedAndNothingElseIsTried() {
  const port = await freePort();
  const release = await occupy(port);
  const handle = launch('BOUND_LOOPBACK', ['dashboard', 'serve', '--port', String(port)]);

  try {
    const ended = await withTimeout(handle.done, 60_000, 'TIMEOUT');
    check(ended !== 'TIMEOUT', 'the refused Manager did not exit within 60s');
    if (ended === 'TIMEOUT') return;

    check(
      ended.code === EXIT_RUN_REFUSED,
      `a busy port exited ${String(ended.code)}, expected ${EXIT_RUN_REFUSED}`,
    );
    check(
      handle.stderr.includes(`could not bind 127.0.0.1:${String(port)}`),
      'the refusal did not name the address and the port',
    );
    check(handle.stderr.includes('EADDRINUSE'), 'the refusal did not carry the errno');
    check(handle.stdout === '', `a refused start still printed: ${JSON.stringify(handle.stdout)}`);
    check(
      listenersReported(handle.stderr).length === 0,
      'a refused start opened a listener somewhere else',
    );
  } finally {
    await killAndWait(handle);
    await release();
  }
}

/* ── the run ─────────────────────────────────────────────────────────────── */

await ordinaryCommandOpensNoListener();
await theTripwireCatchesTheOneVerbThatListens();
await theManagerServesOnLoopbackOnly();
await aBusyPortIsReportedAndNothingElseIsTried();

if (failures.length > 0) {
  console.error('dashboard listener gate FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('dashboard listener gate: the shipped CLI listens only for `dashboard serve`.');
