/**
 * Substitutes `process.platform` / `process.version` before the CLI's ESM entry
 * point loads, so the runtime gate can be driven against runtimes this machine
 * is not.
 *
 * CommonJS on purpose: `--require` runs it before the ESM entry, which is
 * exactly the window needed.
 *
 * ── This file proves its own instrumentation, and that is the point ─────────
 *
 * Both properties are `writable: false`. Their descriptors were measured
 * `configurable: true` on v24.18.1 on the development host — and NOT on the
 * Node 22 the CI runner uses. So the override is attempted, and then the value
 * is READ BACK. If the read-back does not show the substitute, this process
 * dies with a distinct code rather than continuing.
 *
 * Without that, a future runtime that made either property non-configurable
 * would turn every negative control green: the CLI would start on a supported
 * runtime, the gate would correctly not refuse, and the harness would read that
 * as "the gate refused" only if it were looking at the wrong thing. Failing
 * loudly here is the only reason this control may be trusted on a Node the
 * measurement did not cover.
 */

'use strict';

const { writeSync } = require('node:fs');

/** Distinct from any exit code the CLI itself produces (0-6). */
const EXIT_INSTRUMENTATION_FAILED = 97;

function override(name, value) {
  try {
    Object.defineProperty(process, name, {
      value,
      writable: false,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Fall through to the read-back, which reports it uniformly.
  }
  if (process[name] !== value) {
    writeSync(
      2,
      `runtime-gate-preload: could not substitute process.${name}; ` +
        `wanted ${JSON.stringify(value)}, got ${JSON.stringify(process[name])}\n`,
    );
    process.exit(EXIT_INSTRUMENTATION_FAILED);
  }
}

if (process.env.V2_07P_FAKE_PLATFORM) override('platform', process.env.V2_07P_FAKE_PLATFORM);
if (process.env.V2_07P_FAKE_NODE_VERSION) override('version', process.env.V2_07P_FAKE_NODE_VERSION);
