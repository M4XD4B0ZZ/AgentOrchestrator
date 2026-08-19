/**
 * An AO process, reduced to the one thing the owner-coupling case needs: it
 * starts a boundary through the shipped module and then does nothing at all.
 *
 * The case kills *this* process — not the helper, not the tree — and then asks
 * whether anything the boundary owned is still running. That is the failure
 * mode a "kill the tree from the parent" mechanism cannot cover: there is no
 * parent left to run it.
 *
 * usage: node boundary-ao-stand-in.mjs <distStartModuleUrl> <heartbeatDir> <workDir> <mode>
 * stdout: one JSON line, `{ helperPid, childPid }`, then silence.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [moduleUrl, heartbeatDir, workDir, mode] = process.argv.slice(2);
const fixtureDir = dirname(fileURLToPath(import.meta.url));

const { startOwnedProcess } = await import(moduleUrl);

const start = await startOwnedProcess({
  mode: mode ?? 'SUSPENDED',
  file: process.execPath,
  args: [join(fixtureDir, 'boundary-tree-fixture.mjs'), heartbeatDir, '2', '2', '30000'],
  workDir,
});

if (!start.established) {
  process.stdout.write(`${JSON.stringify({ failed: start.ending })}\n`);
  process.exit(3);
}

// Drain, so the tree never blocks on a full pipe. This stand-in owns no
// budgets and no timeout: those are the adapter's, and the adapter does not
// exist yet.
start.process.helper.stdout?.resume();
start.process.helper.stderr?.resume();

process.stdout.write(
  `${JSON.stringify({ helperPid: start.process.helperPid, childPid: start.process.childPid })}\n`,
);

// Stay alive until killed. Nothing here cleans up on the way out — the whole
// point is that the ownership semantics do it without any code running.
setInterval(() => {}, 60_000);
