#!/usr/bin/env node
/**
 * Builds the native launch boundary (`native/ao-launch/AoLaunch.cs`) into
 * `dist/native/ao-launch.exe`.
 *
 * ── Why the in-box compiler ────────────────────────────────────────────────
 *
 * `csc.exe` from the .NET Framework is part of Windows itself. Building with
 * it means the boundary needs no SDK, no toolchain download, no prebuild
 * matrix and no lockstep with a Node ABI — and the same is true on a
 * GitHub-hosted `windows-latest` runner, which the containment probe already
 * checks for the compiler's presence before it measures anything.
 *
 * The output is a plain `.exe` with no dependency beyond `kernel32` and the
 * framework that ships with the operating system this product already refuses
 * to run anywhere but on (`src/platform/runtime-support.ts`).
 *
 * ── Fail closed here too ───────────────────────────────────────────────────
 *
 * A missing compiler, a compile error, or a missing output file ends the build
 * with a nonzero exit and no artefact. There is deliberately no "build without
 * the boundary" mode: a `dist` that silently lacks the boundary would let a
 * later slice ship a runner whose ownership guarantee resolves to nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

export const BOUNDARY_SOURCE = join(repoRoot, 'native', 'ao-launch', 'AoLaunch.cs');
export const BOUNDARY_OUTPUT = join(repoRoot, 'dist', 'native', 'ao-launch.exe');

/** Where Windows keeps the in-box C# compiler, 64-bit first. */
export function locateCsc() {
  const windows = process.env['SystemRoot'] ?? 'C:\\Windows';
  const candidates = [
    join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class NativeBoundaryBuildError extends Error {}

/**
 * Puts a freshly compiled binary in place of the old one.
 *
 * Two Windows facts shape this, and both were measured rather than assumed:
 * the image file of a *running* process can be neither deleted nor overwritten
 * — and a boundary helper outliving the run that started it is ordinary here,
 * since an interrupted gate leaves one holding a tree it owns, exactly as
 * designed — but it *can* be renamed. A build that failed because containment
 * worked would be the wrong behaviour, so the old file is moved aside and swept
 * up on a later build.
 *
 * The compile writes to a per-process staging name and only then takes the
 * output path, rather than clearing the path first. Clearing first opens a
 * window in which `dist/` has no boundary at all for the whole compile, and a
 * second build entering that window can carry off the artefact the first one is
 * still writing — which would let a build report success over a `dist/native/`
 * that another build then failed to fill. One rename-wide window remains, and
 * only when a helper is still running: the old image has to be moved aside
 * before the new one can take its name. A failure there propagates, so the
 * build reports it rather than claiming a boundary that is not present.
 */
function stage(outFile) {
  return `${outFile}.building-${process.pid}`;
}

function publish(staged, outFile) {
  try {
    renameSync(staged, outFile);
  } catch {
    // The old binary is running, so it cannot be replaced in place. Rename it
    // out of the way — which a running image does allow — and take the name.
    renameSync(outFile, `${outFile}.superseded-${process.pid}`);
    renameSync(staged, outFile);
  }
  // Both leftovers this scheme can produce: images parked aside because they
  // were running, and staging files a build died before publishing. Neither is
  // ever `outFile` itself, so a sweep cannot remove the boundary.
  for (const name of readdirSync(dirname(outFile))) {
    const leftover =
      name.startsWith(`${basename(outFile)}.superseded-`) ||
      name.startsWith(`${basename(outFile)}.building-`);
    if (!leftover || name === basename(staged)) continue;
    try {
      rmSync(join(dirname(outFile), name), { force: true });
    } catch {
      /* still running; a later build tries again */
    }
  }
}

/**
 * Compiles the boundary.
 *
 * `defines` exists for exactly one caller: the negative control in
 * `tests/dist-artifact/launch-boundary-dist-artifact.mjs`, which builds a
 * deliberately weakened helper into a temporary directory so that the
 * survivor instrument can be shown to detect a survivor. The shipped build
 * passes no defines, and the weakening switches do not exist in it.
 */
export function compileNativeBoundary({ outFile = BOUNDARY_OUTPUT, defines = [] } = {}) {
  const csc = locateCsc();
  if (csc === null) {
    throw new NativeBoundaryBuildError(
      'The in-box .NET Framework C# compiler was not found under %SystemRoot%\\Microsoft.NET. ' +
        'The Windows launch boundary cannot be built without it, and this build does not ' +
        'continue without the boundary.',
    );
  }

  mkdirSync(dirname(outFile), { recursive: true });
  const staged = stage(outFile);
  rmSync(staged, { force: true });

  const args = [
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    // Warnings are errors here on purpose: this is the one component in the
    // repository where a silent marshalling or unreachable-code mistake is
    // load-bearing for a security property.
    '/warnaserror+',
    '/warn:4',
    `/out:${staged}`,
  ];
  for (const define of defines) args.push(`/define:${define}`);
  args.push(BOUNDARY_SOURCE);

  try {
    execFileSync(csc, args, { stdio: 'pipe', encoding: 'utf8' });
  } catch (error) {
    rmSync(staged, { force: true });
    const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim();
    throw new NativeBoundaryBuildError(`The launch boundary did not compile:\n${output}`);
  }

  // Checked on the staged file, before it is published: this is the build's own
  // artefact, and asking about `outFile` here would be asking whether *some*
  // binary is at that path.
  if (!existsSync(staged)) {
    throw new NativeBoundaryBuildError(
      `The compiler reported success but produced no ${staged}.`,
    );
  }
  publish(staged, outFile);
  return outFile;
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  if (process.platform !== 'win32') {
    console.error(
      'The launch boundary is a Windows component and V2 supports Windows only ' +
        '(src/platform/runtime-support.ts).',
    );
    process.exit(1);
  }
  try {
    const built = compileNativeBoundary();
    console.log(`native launch boundary: ${built}`);
  } catch (error) {
    console.error(error instanceof NativeBoundaryBuildError ? error.message : error);
    process.exit(1);
  }
}
