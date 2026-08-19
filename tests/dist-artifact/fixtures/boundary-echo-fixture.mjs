/**
 * Reports what actually arrived: the argument vector, the working directory
 * and the environment.
 *
 * The boundary builds its own Win32 command line (`CommandLine.Build` in
 * `native/ao-launch/AoLaunch.cs`) instead of letting Node do it, so "the same
 * arguments arrive" is a claim about a second, independent implementation of
 * the MSVCRT quoting rules. This fixture is the oracle for that claim, and it
 * is deliberately a *read-back* rather than a comparison of expected command
 * lines: the question is what the target received, not what someone predicted
 * it would receive.
 *
 * usage: node boundary-echo-fixture.mjs <anything...>
 * stdout: one JSON line.
 */

import { writeFileSync } from 'node:fs';

const report = JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    AO_BOUNDARY_PROBE: process.env['AO_BOUNDARY_PROBE'] ?? null,
    AO_BOUNDARY_UNICODE: process.env['AO_BOUNDARY_UNICODE'] ?? null,
    PATH: process.env['PATH'] === undefined ? null : 'present',
  },
  envCount: Object.keys(process.env).length,
});

// stdout by default; a file when asked, for the `.cmd` route, where the shim's
// own output would otherwise have to be filtered out of the stream.
const target = process.env['AO_BOUNDARY_REPORT_TO'];
if (target === undefined) process.stdout.write(`${report}\n`);
else writeFileSync(target, report, 'utf8');
