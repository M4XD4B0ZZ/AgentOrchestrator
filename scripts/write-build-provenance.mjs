#!/usr/bin/env node
/**
 * Writes the provenance record for the **build output**, `build/`.
 *
 * The deployed runtime gets its record from `scripts/deploy-runtime.mjs`. The
 * build output needs one too, and not as a formality: every dist-artefact gate
 * drives `build/cli/index.js` as a real child process, and that binary refuses
 * to run out of a tree whose provenance cannot be established
 * (`src/cli/runtime-provenance.ts`). Without this step the gates would all
 * refuse, and so would an ordinary developer running their own branch.
 *
 * The record says `BUILD`, and it names `build/` as its root. That is what
 * makes the two trees distinguishable at runtime rather than only by their
 * path: a build output copied into the deployed runtime's place carries a
 * record about `<repo>/build`, is read at `<repo>/dist`, and is refused.
 *
 * Unlike a deployment, this records the tree as it is. A dirty tree is normal
 * during development and is not an error here — it is written down
 * (`sourceTreeClean: false`) rather than refused, which is the difference
 * between a build and a deployment.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRuntimeProvenance } from './deploy-runtime.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const buildRoot = join(repoRoot, 'build');

function gitOrNull(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

if (!existsSync(buildRoot)) {
  console.error(`There is no ${buildRoot}. The compile step has to run before this one.`);
  process.exit(1);
}

const commit = gitOrNull(['rev-parse', 'HEAD']);
const status = gitOrNull(['status', '--porcelain']);

const record = writeRuntimeProvenance({
  writeInto: buildRoot,
  runtimeRoot: buildRoot,
  channel: 'BUILD',
  // A checkout with no commits, or no Git at all, still builds and still has to
  // be runnable. What it cannot do is claim a commit.
  commit: commit ?? 'UNCOMMITTED',
  branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
  authorization: 'BUILD',
  sourceTreeClean: status === '',
});

console.log(`build provenance: ${record.commit}${record.sourceTreeClean ? '' : ' (dirty tree)'}`);
