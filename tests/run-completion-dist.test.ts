/**
 * AO-FOUNDATION-REM-002C4 (closes AO-FOUNDATION-REM-002C3-REREVIEW-01).
 *
 * This file never imports `dist/doctor/run-completion.js` or
 * `src/doctor/run-completion.ts` itself — it only spawns a separate,
 * standalone Node process running
 * `tests/dist-artifact/run-completion-dist-artifact.mjs`, which is the one
 * that imports the built `dist/doctor/run-completion.js` via
 * an explicit `file://` URL. That separation is deliberate: nothing about
 * this test file's own module resolution (vitest, `tsx`, `nodenext`) can ever
 * redirect the artefact being checked back to source.
 *
 * `dist/doctor/run-completion.js` must already be freshly built before this
 * runs — see the `verify:dist-doctor` npm script, which does
 * `npm run build` first. This test does not rebuild; a stale or missing dist
 * makes the child process fail loudly (nonzero exit), never silently pass.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(testDir, 'dist-artifact', 'run-completion-dist-artifact.mjs');

describe('dist/doctor/run-completion.js (the built artefact, not the source module)', () => {
  it('passes every runtime check when run as its own Node process', () => {
    expect(() => {
      execFileSync(process.execPath, [CHILD_SCRIPT], { stdio: 'pipe' });
    }).not.toThrow();
  });
});
