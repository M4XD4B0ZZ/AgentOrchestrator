/**
 * One scratch-directory constructor for the real-process test layer.
 *
 * The tests in that layer hand temporary paths to `runCommand` — as arguments,
 * or as a target a spawn injection then compares against. Both uses require the
 * *canonical* path, and `os.tmpdir()` does not always give one:
 *
 *  - a GitHub Actions Windows runner reports
 *    `C:\Users\RUNNER~1\AppData\Local\Temp`, an 8.3 alias;
 *  - `SAFE_ARG_PATTERN` (`src/doctor/exec.ts`) deliberately excludes `~`, so
 *    the product refuses such an argument closed — correctly, and before the
 *    test's own subject is ever reached;
 *  - `resolveOnPath` hands `spawn()` the `realpathSync.native` result rather
 *    than the caller's spelling, so an injection keyed on a raw temp path
 *    stops matching there too.
 *
 * Canonicalising at creation fixes the wrong assumption at the point it is
 * made. It is deliberately *not* a reason to widen the argument contract, and
 * deliberately not solved by pointing `TMP`/`TEMP` somewhere else in CI: the
 * 8.3 alias is a real thing real Windows machines produce, and a test layer
 * that only works when it is absent is the defect.
 *
 * Cleanup is left to each caller, which already owns it — `ExecArtifactRegistry`
 * in `exec.test.ts`, a local array elsewhere. The canonical path this returns is
 * the real directory, so removing it works exactly as before.
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates a temporary directory and returns its canonical absolute path. */
export function makeCanonicalTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}
