/**
 * One target program, driven entirely by shell-inert `--key=value` arguments.
 *
 * Shell-inert on purpose: the same invocation has to go through `runCommand`,
 * whose `SAFE_ARG_PATTERN` refuses spaces and quotes, so that every case in
 * `../owned-command-dist-artifact.mjs` can be run down both paths and their
 * results compared. A fixture that needed a space in an argument could only
 * ever be run down one of them, and the differential is the point.
 *
 * usage: node owned-command-fixture.mjs [--flag=value ...]
 *
 *   --stdout-bytes=N   write exactly N bytes to stdout
 *   --stderr-bytes=N   write exactly N bytes to stderr
 *   --stdout-mark=TEXT write TEXT to stdout before anything else
 *   --stderr-mark=TEXT write TEXT to stderr before anything else
 *   --stdin=MODE       drain (read to EOF), ignore (never read), exit (exit at
 *                      once without reading)
 *   --report=PATH      write a JSON report — stdin bytes read — to PATH
 *   --heartbeat=DIR    rewrite DIR/hb-<pid>.txt every 100ms, forever
 *   --children=N       spawn N detached copies that only heartbeat
 *   --hang             never exit on its own
 *   --sleep-ms=N       stay alive N ms before exiting
 *   --exit=N           exit with code N
 *   --echo             report the argv, cwd and environment that arrived, as
 *                      one JSON line on stdout
 *
 * The heartbeat is the same instrument the slice 1 harness uses, and for the
 * same reason: "still running" is a question a process table answers badly —
 * a terminated process whose object is still referenced looks alive, and pids
 * are reused — while a file whose number keeps growing answers it directly.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);

const options = new Map();
for (const argument of process.argv.slice(2)) {
  const split = argument.indexOf('=');
  if (split < 0) options.set(argument.replace(/^--/, ''), 'true');
  else options.set(argument.slice(2, split), argument.slice(split + 1));
}

const number = (key, fallback) => {
  const value = options.get(key);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
};

/** Everything holding the event loop open, so `leave` can let go of it. */
const keepAlive = [];

const heartbeatDir = options.get('heartbeat');
if (heartbeatDir !== undefined) {
  const path = join(heartbeatDir, `hb-${process.pid}.txt`);
  const beat = () => {
    try {
      writeFileSync(path, String(Date.now()), 'utf8');
    } catch {
      /* a heartbeat that cannot be written is not worth dying for */
    }
  };
  beat();
  keepAlive.push(setInterval(beat, 100));
}

const children = number('children', 0);
for (let index = 0; index < children; index += 1) {
  // `stdio: 'ignore'`, deliberately: a descendant holding this process's
  // stdout pipe would keep that pipe open after this process exits, which is a
  // property of pipes rather than of containment and would confuse every case
  // that waits for output to end.
  spawn(
    process.execPath,
    [selfPath, `--heartbeat=${heartbeatDir ?? ''}`, '--hang'],
    { stdio: 'ignore', windowsHide: true },
  ).unref();
}

if (options.has('echo')) {
  // The same read-back `boundary-echo-fixture.mjs` gives, in the fixture that
  // can also heartbeat. Slice 1's echo fixture cannot: it has no heartbeat
  // support, and adding an argument to it would change the very argv it exists
  // to report. A case that starts a process the survivor sweep cannot see is
  // exactly the gap this file's header has now overstated four times.
  process.stdout.write(
    `${JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: {
        AO_BOUNDARY_PROBE: process.env['AO_BOUNDARY_PROBE'] ?? null,
        PATH: process.env['PATH'] === undefined ? null : 'present',
      },
    })}\n`,
  );
}

const stdoutMark = options.get('stdout-mark');
if (stdoutMark !== undefined) process.stdout.write(stdoutMark);
const stderrMark = options.get('stderr-mark');
if (stderrMark !== undefined) process.stderr.write(stderrMark);

/** A repeating, self-describing pattern, so a truncation point is readable. */
function pattern(bytes) {
  const unit = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  while (text.length < bytes) text += unit;
  return text.slice(0, bytes);
}

const stdoutBytes = number('stdout-bytes', 0);
if (stdoutBytes > 0) process.stdout.write(pattern(stdoutBytes));
const stderrBytes = number('stderr-bytes', 0);
if (stderrBytes > 0) process.stderr.write(pattern(stderrBytes));

const reportPath = options.get('report');
let stdinBytes = 0;

function report() {
  if (reportPath === undefined) return;
  try {
    writeFileSync(reportPath, JSON.stringify({ stdinBytes }), 'utf8');
  } catch {
    /* the case that needs this report asserts on its absence too */
  }
}

const exitCode = number('exit', 0);

/**
 * Ends the run, and does it by letting the event loop drain rather than by
 * `process.exit`.
 *
 * Measured the hard way elsewhere in this repository: a forced exit can drop
 * writes that node has not flushed to a pipe yet, and several cases here
 * assert on the exact number of bytes that arrived. Releasing the keep-alive
 * handles and setting an exit code ends the process just as reliably and
 * flushes on the way out.
 */
function leave() {
  report();
  for (const handle of keepAlive) clearInterval(handle);
  keepAlive.length = 0;
  process.exitCode = exitCode;
}

const stdinMode = options.get('stdin') ?? 'ignore';
if (stdinMode === 'exit') {
  // Never reads a byte and goes at once: the boundary is then forwarding into
  // a pipe whose read end is gone, which is the state `BROKEN_PIPE` reports.
  leave();
} else if (stdinMode === 'drain') {
  process.stdin.on('data', (chunk) => {
    stdinBytes += chunk.length;
  });
  process.stdin.on('end', () => {
    if (options.has('hang')) return;
    leave();
  });
}

if (options.has('hang')) keepAlive.push(setInterval(() => {}, 1_000));

const sleepMs = number('sleep-ms', -1);
// Deliberately not unref'd: this timer is what keeps the process alive.
if (sleepMs >= 0) setTimeout(leave, sleepMs);
else if (!options.has('hang') && stdinMode !== 'drain') leave();
