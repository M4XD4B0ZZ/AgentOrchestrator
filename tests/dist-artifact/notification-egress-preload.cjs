/**
 * Instrumentation for the notification egress gate (V2-10).
 *
 * Two substitutions, installed before the CLI's ESM entry point loads, and both
 * of them verified rather than assumed:
 *
 *  1. the OS user profile is pointed at a scratch directory, so the harness can
 *     put a notification configuration in front of the shipped binary — or
 *     deliberately not — without touching the real operator's file. The product
 *     resolves the profile through `os.userInfo()` on purpose (it consults no
 *     environment block, so nothing a caller sets can relocate it), which is
 *     exactly why a test has to reach it here rather than through a variable;
 *  2. every way this process could open a socket is either fatal or recorded.
 *
 * CommonJS, because `--require` runs it before the ESM graph is instantiated,
 * which is the only window in which either substitution is possible.
 *
 * ── Why this file dies rather than continues ───────────────────────────────
 *
 * An instrumentation that silently fails to take turns every control green: the
 * CLI would consult the *real* profile, find no configuration, send nothing, and
 * the negative case would report "no egress without opt-in" while having
 * measured nothing at all. So both substitutions are read back — the profile one
 * through the ESM binding the product actually uses, not only through the CJS
 * exports object — and a mismatch exits with a code no run can produce.
 */

'use strict';

const { writeSync } = require('node:fs');

/** Distinct from every exit code the CLI can produce (0-6). */
const EXIT_INSTRUMENTATION_FAILED = 97;
const EXIT_EGRESS_ATTEMPTED = 96;

const scratchProfile = process.env['AGENT_LOOP_TEST_PROFILE'];
/** `FORBID` — any socket is fatal. `ALLOW_LOOPBACK` — 127.0.0.1 only, recorded. */
const mode = process.env['AGENT_LOOP_TEST_EGRESS'];

function die(code, message) {
  writeSync(2, `notification-egress-preload: ${message}\n`);
  process.exit(code);
}

if (typeof scratchProfile !== 'string' || scratchProfile === '') {
  die(EXIT_INSTRUMENTATION_FAILED, 'AGENT_LOOP_TEST_PROFILE was not set');
}
if (mode !== 'FORBID' && mode !== 'ALLOW_LOOPBACK') {
  die(EXIT_INSTRUMENTATION_FAILED, 'AGENT_LOOP_TEST_EGRESS must be FORBID or ALLOW_LOOPBACK');
}

// ── 1. the profile ──────────────────────────────────────────────────────────

const os = require('node:os');
const realUserInfo = os.userInfo;
os.userInfo = function userInfo(...args) {
  const info = Reflect.apply(realUserInfo, this, args);
  return { ...info, homedir: scratchProfile };
};

if (os.userInfo().homedir !== scratchProfile) {
  die(EXIT_INSTRUMENTATION_FAILED, 'the CommonJS view of os.userInfo was not substituted');
}

// The binding that matters is the ESM one: the product does
// `import { userInfo } from 'node:os'`, and a builtin's ESM facade is a separate
// object from the CJS exports. Checked asynchronously because a CJS preload
// cannot await — and that is early enough by a wide margin, since the CLI
// resolves a profile only inside a command action, several ticks later.
import('node:os').then(
  (namespace) => {
    if (namespace.userInfo().homedir !== scratchProfile) {
      die(EXIT_INSTRUMENTATION_FAILED, 'the ESM view of os.userInfo was not substituted');
    }
  },
  () => die(EXIT_INSTRUMENTATION_FAILED, 'node:os could not be imported as ESM'),
);

// ── 2. the egress tripwire ──────────────────────────────────────────────────

const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

const fatal = (what) => () => die(EXIT_EGRESS_ATTEMPTED, `${what} was reached`);

if (mode === 'FORBID') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fatal('fetch');
  if (globalThis.fetch === originalFetch) {
    die(EXIT_INSTRUMENTATION_FAILED, 'globalThis.fetch could not be replaced');
  }

  net.Socket.prototype.connect = fatal('net.Socket.prototype.connect');
  net.connect = fatal('net.connect');
  net.createConnection = fatal('net.createConnection');
  dns.lookup = fatal('dns.lookup');
  dns.resolve = fatal('dns.resolve');
  http.request = fatal('http.request');
  https.request = fatal('https.request');

  // Read back one of them: a frozen or getter-backed builtin would leave the
  // assignment above silently ineffective.
  if (net.connect !== undefined && String(net.connect).includes('createConnection')) {
    die(EXIT_INSTRUMENTATION_FAILED, 'net.connect could not be replaced');
  }
} else {
  // The positive case needs a real socket, so the tripwire bounds it instead of
  // forbidding it: anything that is not the loopback literal is fatal, which is
  // what makes "exactly one POST, to the configured endpoint" a measurement of
  // the *only* connection the process made rather than of the one we watched.
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    const options = args[0];
    const host =
      typeof options === 'object' && options !== null
        ? String(options.host ?? '')
        : typeof args[1] === 'string'
          ? args[1]
          : '';
    if (host !== '' && host !== '127.0.0.1' && host !== '::1') {
      die(EXIT_EGRESS_ATTEMPTED, `a socket was opened to ${host}`);
    }
    return Reflect.apply(realConnect, this, args);
  };
  if (net.Socket.prototype.connect === realConnect) {
    die(EXIT_INSTRUMENTATION_FAILED, 'net.Socket.prototype.connect could not be wrapped');
  }
}
