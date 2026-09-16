/**
 * Instrumentation for the inbound-socket gate (DASHBOARD-001 slice 3).
 *
 * The existing egress preload cannot answer this question. It arms `fetch`,
 * `net.Socket.prototype.connect`, `net.connect`, `net.createConnection`,
 * `dns.lookup`, `dns.resolve`, `http.request` and `https.request` — every way a
 * process *reaches out* — and touches none of the ways a process is *reached*.
 * An accepted inbound connection never calls `connect`, so that tripwire is
 * blind to a listener in both directions: it neither catches one that should
 * not exist nor bounds one that should.
 *
 * This file is the other half. It replaces `net.Server.prototype.listen`, which
 * every TCP and IPC listener in Node goes through — `http.createServer(...)`
 * returns an `http.Server`, and `http.Server` extends `net.Server` — plus
 * `dgram.createSocket`, which is the one listening surface that does not.
 *
 * ── Two modes ──────────────────────────────────────────────────────────────
 *
 *  - `FORBID` — any listener at all is fatal. This is what proves that an
 *    ordinary command opens none, and it is armed against `dashboard serve`
 *    too, so that the negative case is known to be capable of failing.
 *  - `BOUND_LOOPBACK` — a listener is allowed, and bounded. The host asked for
 *    must be the loopback literal, and the address actually bound is read back
 *    off the listener once it comes up and must be the same literal. Each one
 *    is reported on stderr so the harness can count them.
 *
 * Egress stays fatal in both modes. The Manager contacts nothing, and a gate
 * that only watched the direction it was named for would let the other one
 * through.
 *
 * ── Why this file dies rather than continues ───────────────────────────────
 *
 * An instrumentation that silently fails to take turns every control green: the
 * CLI would open whatever it liked and the negative case would report "no
 * listener" while having measured nothing. So every substitution is read back,
 * and a mismatch exits with a code no run of this CLI can produce.
 *
 * CommonJS, because `--require` runs it before the ESM graph is instantiated,
 * which is the only window in which the substitutions are possible.
 */

'use strict';

const { writeSync } = require('node:fs');

/**
 * Sentinels, chosen to collide with nothing.
 *
 * The CLI produces 0-7 (`src/cli/run-exit-codes.ts`). 96 and 97 belong to the
 * egress and runtime-gate harnesses, 90 and 93 to the launch-boundary one. The
 * 80s are unused, and each of these means one thing only.
 */
const EXIT_INSTRUMENTATION_FAILED = 89;
const EXIT_LISTENED = 88;
const EXIT_NOT_LOOPBACK = 87;
const EXIT_EGRESS_ATTEMPTED = 86;

/** The one address a listener in this product may come up on. */
const LOOPBACK = '127.0.0.1';

/** `FORBID` — any listener is fatal. `BOUND_LOOPBACK` — loopback only, counted. */
const mode = process.env['AO_DASHBOARD_LISTEN'];

function die(code, message) {
  writeSync(2, `dashboard-listen-preload: ${message}\n`);
  process.exit(code);
}

/** One machine-readable line per observation, for the harness to count. */
function report(text) {
  writeSync(2, `dashboard-listen-preload: ${text}\n`);
}

if (mode !== 'FORBID' && mode !== 'BOUND_LOOPBACK') {
  die(EXIT_INSTRUMENTATION_FAILED, 'AO_DASHBOARD_LISTEN must be FORBID or BOUND_LOOPBACK');
}

const net = require('node:net');
const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

/* ── 1. the inbound tripwire ────────────────────────────────────────────── */

/**
 * The host a `listen` call is about, whatever calling convention was used.
 *
 * `listen(options[, cb])`, `listen(port[, host][, cb])` and `listen(path[, cb])`
 * are all legal. A shape this cannot read yields `<omitted>`, and `<omitted>`
 * is refused rather than waved through: Node reads an omitted host as every
 * interface, so a bind whose host cannot be seen is exactly the bind this gate
 * exists to catch.
 */
function hostAskedFor(args) {
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    return typeof first.host === 'string' ? first.host : '<omitted>';
  }
  if (typeof args[1] === 'string') return args[1];
  return '<omitted>';
}

const realListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(...args) {
  if (mode === 'FORBID') {
    die(EXIT_LISTENED, 'a listening socket was opened');
  }

  const asked = hostAskedFor(args);
  if (asked !== LOOPBACK) {
    die(EXIT_NOT_LOOPBACK, `listen asked for host ${asked}`);
  }

  // The argument is what was asked for; the address is what was got. Only the
  // second one is evidence, so it is read off the listener rather than trusted
  // from the call. A `listen` that failed never emits this, which is what makes
  // "a collision produced no listener" measurable rather than assumed.
  this.once('listening', () => {
    const address = this.address();
    const bound = address !== null && typeof address === 'object' ? address.address : '<unreadable>';
    const port = address !== null && typeof address === 'object' ? address.port : '<unreadable>';
    report(`listen ${bound} ${String(port)}`);
    if (bound !== LOOPBACK) {
      die(EXIT_NOT_LOOPBACK, `the listener came up on ${bound}`);
    }
  });

  return Reflect.apply(realListen, this, args);
};

if (net.Server.prototype.listen === realListen) {
  die(EXIT_INSTRUMENTATION_FAILED, 'net.Server.prototype.listen could not be replaced');
}

// The one listening surface that is not a `net.Server`. Nothing in this product
// speaks UDP, so it is fatal in both modes rather than bounded.
const realCreateSocket = dgram.createSocket;
dgram.createSocket = function createSocket() {
  die(EXIT_LISTENED, 'a datagram socket was created');
};
if (dgram.createSocket === realCreateSocket) {
  die(EXIT_INSTRUMENTATION_FAILED, 'dgram.createSocket could not be replaced');
}

/* ── 2. the egress tripwire, in both modes ──────────────────────────────── */

const fatalEgress = (what) => () => die(EXIT_EGRESS_ATTEMPTED, `${what} was reached`);

const originalFetch = globalThis.fetch;
globalThis.fetch = fatalEgress('fetch');
if (globalThis.fetch === originalFetch) {
  die(EXIT_INSTRUMENTATION_FAILED, 'globalThis.fetch could not be replaced');
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = fatalEgress('net.Socket.prototype.connect');
if (net.Socket.prototype.connect === realConnect) {
  die(EXIT_INSTRUMENTATION_FAILED, 'net.Socket.prototype.connect could not be wrapped');
}

net.connect = fatalEgress('net.connect');
net.createConnection = fatalEgress('net.createConnection');
http.request = fatalEgress('http.request');
https.request = fatalEgress('https.request');

/**
 * `dns.lookup`, bounded rather than forbidden — and the reason is measured.
 *
 * `net.Server.prototype.listen` resolves its `host` option through `dns.lookup`
 * **even when that host is already an IP literal**. So a tripwire that made any
 * lookup fatal killed the Manager on the very call this gate exists to watch,
 * and reported it as egress. Measured here: the first version of this file did
 * exactly that, and the listening cases died with exit 86.
 *
 * The bound is therefore on the subject, not on the call: the loopback literals
 * pass through to the real resolver, and any other name is fatal. A name
 * resolved here is a name this build decided to contact, which is the thing
 * worth catching.
 */
const realLookup = dns.lookup;
dns.lookup = function lookup(hostname, ...rest) {
  if (hostname !== LOOPBACK && hostname !== '::1') {
    die(EXIT_EGRESS_ATTEMPTED, `dns.lookup was reached for ${String(hostname)}`);
  }
  return Reflect.apply(realLookup, this, [hostname, ...rest]);
};
if (dns.lookup === realLookup) {
  die(EXIT_INSTRUMENTATION_FAILED, 'dns.lookup could not be wrapped');
}

dns.resolve = fatalEgress('dns.resolve');

report(`armed ${mode}`);
