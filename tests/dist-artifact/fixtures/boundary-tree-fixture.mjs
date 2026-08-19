/**
 * A process tree that says, continuously, that it is alive.
 *
 * The boundary's guarantee is about processes that are *running*, so the
 * instrument that measures it must be about running too. Every member of this
 * tree rewrites `hb-<pid>.txt` with the current millisecond, forever, until it
 * is killed or its own lifetime runs out. "Survivor" therefore means "a file
 * whose number kept growing after the boundary was destroyed" — an observation
 * that needs no process table, no pid identity and no creation-time tie-break,
 * and cannot mistake a terminated process whose object is still referenced for
 * a live one.
 *
 * The lifetime bound is not decoration. One case here deliberately breaks
 * containment (the negative control that proves the guarantee is load-bearing)
 * and leaves real orphans behind; a fixture that ran forever would leave them
 * on the machine.
 *
 * usage: node boundary-tree-fixture.mjs <heartbeatDir> <generations> <fanout> <lifetimeMs> [rootLifetimeMs] [exitFlagPath]
 *
 * `rootLifetimeMs`, when given and smaller than `lifetimeMs`, makes the root
 * exit early while its descendants keep running: that is how the "orphaned
 * descendants are still job members" case gets its subject. `exitFlagPath`
 * makes that exit happen when the caller says so instead of when a clock runs
 * out — the caller can see the tree is complete, a timer cannot.
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const [heartbeatDir, generationsText, fanoutText, lifetimeText, rootLifetimeText, exitFlagPath] =
  process.argv.slice(2);

const generations = Number.parseInt(generationsText ?? '0', 10);
const fanout = Number.parseInt(fanoutText ?? '2', 10);
const lifetimeMs = Number.parseInt(lifetimeText ?? '30000', 10);
const rootLifetimeMs =
  rootLifetimeText === undefined ? lifetimeMs : Number.parseInt(rootLifetimeText, 10);

const heartbeatPath = join(heartbeatDir, `hb-${process.pid}.txt`);

function beat() {
  try {
    writeFileSync(heartbeatPath, String(Date.now()), 'utf8');
  } catch {
    /* a heartbeat that cannot be written is not worth dying for */
  }
}

beat();

if (generations > 0) {
  for (let index = 0; index < fanout; index += 1) {
    // `stdio: 'ignore'`, deliberately: a descendant holding the boundary's
    // stdout pipe would keep that pipe open after the root exits, which is a
    // property of pipes rather than of containment and would confuse the
    // cases that measure the root's exit.
    spawn(
      process.execPath,
      [
        selfPath,
        heartbeatDir,
        String(generations - 1),
        String(fanout),
        String(lifetimeMs),
        String(lifetimeMs),
      ],
      { stdio: 'ignore', windowsHide: true },
    ).unref();
  }
}

const timer = setInterval(beat, 100);

if (exitFlagPath !== undefined) {
  // The root leaves on demand rather than on a clock. The case that counts how
  // many descendants the kernel considers job members needs the tree to be
  // finished before the root exits, and a timer cannot promise that: on a
  // loaded runner one grandchild is still being spawned when the clock runs
  // out, and the count comes back one short of a tree that was never complete.
  // A flag file makes "the tree is up" the caller's observation instead of an
  // assumption.
  const watch = setInterval(() => {
    if (!existsSync(exitFlagPath)) return;
    clearInterval(watch);
    clearInterval(timer);
    process.exit(0);
  }, 50);
}

setTimeout(() => {
  clearInterval(timer);
  process.exit(0);
}, Math.max(100, rootLifetimeMs));

// Announce readiness on stdout so a caller can wait for the tree rather than
// sleep for it. The root's stdout is the boundary's stdout.
process.stdout.write(`TREE_ROOT ${process.pid}\n`);
