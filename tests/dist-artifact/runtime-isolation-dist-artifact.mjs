#!/usr/bin/env node
/**
 * AO-RUNTIME-ISOLATION-001 — the build must not write the deployed runtime.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * The production Zera supervisor executes `<repo>/dist/cli/index.js` every
 * thirty minutes. `npm run verify` runs `npm run build`, and `npm run build`
 * used to write into that same `<repo>/dist`. So an ordinary verification run
 * on a feature branch replaced the bytes production was about to execute.
 *
 * It is not hypothetical. On 2026-09-14/15 a feature-branch verify for PR #103
 * rebuilt `dist/` before that pull request was merged, and the next scheduled
 * supervisor pass executed the unmerged parser. The source delivery policy
 * protected `main`; the runtime moved ahead of it anyway.
 *
 * ── What this harness measures ──────────────────────────────────────────────
 *
 * That the ordinary build writes **nothing** into the directory the production
 * supervisor executes. It is measured on the real filesystem against the real
 * build, and it observes two independent things about real files — their bytes
 * and the time they were last written — rather than the text of a script. A
 * comparison of two path strings would pass over a build that still wrote
 * there through a third name; a write time cannot.
 *
 * The harness never deletes, renames or writes the deployed runtime. Its only
 * effect on this checkout is the ordinary build output it triggers, which is
 * the point: that output has to land somewhere else.
 *
 * ── Why a write-time watermark and not only a digest ────────────────────────
 *
 * `tsc` is deterministic, so a rebuild of an unchanged tree reproduces its
 * `.js` byte for byte. A digest alone would therefore report "unchanged" for a
 * build that had in fact rewritten every file in the production runtime — the
 * defect would be invisible on a clean tree and visible only on a dirty one.
 * The write time is what distinguishes "these bytes are the same" from "this
 * file was not written", and only the second is the invariant. The digest is
 * kept beside it because the write time cannot show a *changed* file that a
 * clock skew hid.
 *
 * Contract: exit 0 means every check passed. Nonzero means at least one did not.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

/**
 * What the production supervisor executes, and what this repository's own
 * tooling must never write. It is created by one explicit operation only.
 */
const DEPLOYED_RUNTIME = join(repoRoot, 'dist');

/**
 * Where the build writes. Verified, disposable, rebuilt by anyone at any time
 * on any branch, and executed by nothing outside this checkout.
 */
const BUILD_OUTPUT = join(repoRoot, 'build');

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/**
 * Every file under `root`, by repository-relative POSIX path, with its digest,
 * size and last write time. `null` when the directory does not exist at all —
 * which is a meaningful state here, and not the same as "exists and is empty".
 */
function snapshot(root) {
  if (!existsSync(root)) return null;
  /** @type {Map<string, {sha256: string, size: number, mtimeMs: number}>} */
  const files = new Map();
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(full);
      files.set(relative(root, full).split(sep).join('/'), {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mtimeMs: statSync(full).mtimeMs,
      });
    }
  };
  visit(root);
  return files;
}

/**
 * A write-time watermark taken from the filesystem rather than from
 * `Date.now()`.
 *
 * The two clocks are not required to agree, and on a machine where the
 * filesystem's is even slightly behind, a file written *after* this point would
 * carry a timestamp *before* it — and the check would pass over the very write
 * it exists to catch. Asking the filesystem to stamp a file of our own and
 * reading that stamp back removes the question: whatever clock it used is the
 * clock the build's own writes will be stamped with.
 */
function filesystemWatermark() {
  const dir = join(repoRoot, 'tmp');
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, `runtime-isolation-watermark-${process.pid}`);
  writeFileSync(marker, 'watermark\n', 'utf8');
  const stamped = statSync(marker).mtimeMs;
  rmSync(marker, { force: true });
  return stamped;
}

/** Runs the real `npm run build`, the step `npm run verify` performs. */
function runOrdinaryBuild() {
  // `npm_execpath` is npm's own entry script, set by npm for every script it
  // runs — which is how this harness is always reached. Spawning it through
  // `process.execPath` avoids `npm.cmd`, which Node refuses to `execFile`
  // without a shell on Windows.
  const npmCli = process.env['npm_execpath'];
  const [command, args] =
    npmCli === undefined || npmCli === ''
      ? ['npm', ['run', 'build']]
      : [process.execPath, [npmCli, 'run', 'build']];
  execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: command === 'npm',
    timeout: 600_000,
  });
}

// ── The measurement ─────────────────────────────────────────────────────────

const deployedBefore = snapshot(DEPLOYED_RUNTIME);
const watermark = filesystemWatermark();
runOrdinaryBuild();
const deployedAfter = snapshot(DEPLOYED_RUNTIME);
const builtAfter = snapshot(BUILD_OUTPUT);

// ── 1. The build did run, and it did write somewhere ────────────────────────
//
// Without this, every check below would pass on a build that silently did
// nothing at all.
check(builtAfter !== null, `the build produced no ${BUILD_OUTPUT}`);
check(
  builtAfter !== null && builtAfter.has('cli/index.js'),
  'the build output has no cli/index.js, so the build did not produce a runnable CLI',
);
check(
  builtAfter !== null && [...builtAfter.values()].some((file) => file.mtimeMs >= watermark),
  'no file in the build output was written by this build, so nothing below was measured',
);

// ── 2. The deployed runtime was not created by the build ────────────────────
if (deployedBefore === null) {
  check(
    deployedAfter === null,
    `the build created ${DEPLOYED_RUNTIME}, the directory the production supervisor executes`,
  );
} else {
  check(deployedAfter !== null, `the build removed ${DEPLOYED_RUNTIME}`);

  if (deployedAfter !== null) {
    // ── 3. No file in the deployed runtime was written by the build ─────────
    const written = [...deployedAfter.entries()]
      .filter(([, file]) => file.mtimeMs >= watermark)
      .map(([path]) => path);
    check(
      written.length === 0,
      `the build wrote ${written.length} file(s) into the deployed runtime, ` +
        `starting with: ${written.slice(0, 5).join(', ')}`,
    );

    // ── 4. No byte of the deployed runtime changed ──────────────────────────
    const appeared = [...deployedAfter.keys()].filter((path) => !deployedBefore.has(path));
    const vanished = [...deployedBefore.keys()].filter((path) => !deployedAfter.has(path));
    const altered = [...deployedAfter.entries()]
      .filter(([path, file]) => {
        const before = deployedBefore.get(path);
        return before !== undefined && before.sha256 !== file.sha256;
      })
      .map(([path]) => path);

    check(appeared.length === 0, `the build added to the deployed runtime: ${appeared.slice(0, 5).join(', ')}`);
    check(vanished.length === 0, `the build removed from the deployed runtime: ${vanished.slice(0, 5).join(', ')}`);
    check(altered.length === 0, `the build changed bytes in the deployed runtime: ${altered.slice(0, 5).join(', ')}`);
  }
}

// ── Result ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`runtime isolation check FAILED (${failures.length} issue(s)):`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}

console.log('runtime isolation check passed: the build wrote nothing into the deployed runtime.');
process.exit(0);
