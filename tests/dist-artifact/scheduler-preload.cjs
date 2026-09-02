/**
 * Points the OS user profile at a scratch directory, for the scheduler harness.
 *
 * The repository registry lives at `<user profile>/.agent-orchestrator/repositories.yaml`
 * and the product resolves that profile through `os.userInfo()` on purpose: it
 * consults no environment variable, so nothing a caller sets can relocate it.
 * That is exactly why a harness driving the *shipped* CLI has to substitute the
 * function here, in a `--require` preload, before the ESM graph is instantiated.
 *
 * CommonJS for the same reason: `--require` runs before the ESM entry point
 * loads, which is the only window in which the substitution is possible.
 *
 * ── Why this file dies rather than continues ───────────────────────────────
 *
 * An instrumentation that silently fails to take turns every case green: the
 * CLI would consult the *real* operator's registry, find whatever is in it, and
 * a harness asserting "the fixture repository waited" would be measuring a
 * machine rather than a build. So the substitution is read back through the ESM
 * binding the product actually uses — a builtin's ESM facade is a separate
 * object from its CJS exports — and a mismatch exits with a code no CLI run can
 * produce.
 *
 * Modelled on `notification-egress-preload.cjs`, which established both the
 * mechanism and the self-verification. It carries no egress tripwire: the
 * scheduler opens no socket, and a copy of that machinery here would be a second
 * thing to keep true.
 */

'use strict';

const { writeSync } = require('node:fs');

/** Distinct from every exit code the CLI can produce (0-6). */
const EXIT_INSTRUMENTATION_FAILED = 97;

const scratchProfile = process.env['AGENT_LOOP_TEST_PROFILE'];

function die(message) {
  writeSync(2, `scheduler-preload: ${message}\n`);
  process.exit(EXIT_INSTRUMENTATION_FAILED);
}

if (typeof scratchProfile !== 'string' || scratchProfile === '') {
  die('AGENT_LOOP_TEST_PROFILE was not set');
}

const os = require('node:os');
const realUserInfo = os.userInfo;
os.userInfo = function userInfo(...args) {
  const info = Reflect.apply(realUserInfo, this, args);
  return { ...info, homedir: scratchProfile };
};

if (os.userInfo().homedir !== scratchProfile) {
  die('the CommonJS view of os.userInfo was not substituted');
}

// The binding that matters is the ESM one. Checked asynchronously because a CJS
// preload cannot await, and that is early enough by a wide margin: the CLI
// resolves a profile only inside a command action, several ticks later.
import('node:os').then(
  (namespace) => {
    if (namespace.userInfo().homedir !== scratchProfile) {
      die('the ESM view of os.userInfo was not substituted');
    }
  },
  () => die('node:os could not be imported as ESM'),
);
