#!/usr/bin/env node
/**
 * Copies `src/dashboard/ui/` into a build output, substituting the service
 * worker's two build-time constants.
 *
 * ── Why this is a function taking a destination ────────────────────────────
 *
 * Because it has TWO callers, and forgetting the second is the defect this
 * script exists to prevent. `npm run build` writes `build/`; `npm run deploy`
 * writes `dist/`, which is the runtime the production supervisor actually
 * executes — and `deploy-runtime.mjs` RE-COMPILES with `tsc` rather than
 * copying `build/`, so it emits no `.html`, `.css`, `.js`, `.png` or
 * `.webmanifest` of its own. `tsconfig.build.json` includes TypeScript sources
 * only, and there is no copy step anywhere in `scripts/`. A deployed runtime
 * with no assets fails `loadUiAssets`'s all-or-nothing rule and refuses to
 * start the Manager — while every gate stays green, because every
 * dist-artefact harness runs against `build/`.
 *
 * `native/ao-launch.exe` is the precedent: it is the other non-`tsc` artefact,
 * and it already has exactly these two call sites.
 *
 * ── Why a failed substitution is worse than a failed build ─────────────────
 *
 * The digest lives INSIDE `sw.js`. That is what makes the worker's bytes
 * change when the shell changes, and a browser looks for an update by
 * comparing the worker's bytes. A build that quietly shipped the placeholder
 * would produce a worker whose bytes never change again, so no update would
 * ever activate — permanently, silently, on every installed client. So every
 * step of the substitution is checked in both directions: the source must
 * CONTAIN each token before, and must NOT contain it after. A build that
 * cannot prove both refuses, and writes nothing — the substitution runs above
 * the write loop precisely so that "refuses" and "writes nothing" are the same
 * event rather than two hopes.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

/** Where the assets are authored. One directory, seven files, no subtrees. */
export const UI_SOURCE_DIR = join(repoRoot, 'src', 'dashboard', 'ui');

/** Where `npm run build` puts them, beside the compiled `ui-assets.js`. */
export const UI_BUILD_DIR = join(repoRoot, 'build', 'dashboard', 'ui');

/** The file that carries the constants, and is therefore not verbatim. */
const WORKER = 'sw.js';

const DIGEST_TOKEN = '__AO_SHELL_DIGEST__';
/** With the quotes: the authored line is `var SHELL_ROUTES = '__AO_SHELL_ROUTES__';` */
const ROUTES_TOKEN = "'__AO_SHELL_ROUTES__'";

/**
 * The manifest, mirrored from `src/dashboard/ui-assets.ts` — same pairs, same
 * order.
 *
 * Mirrored rather than imported because this is a `.mjs` build script and that
 * is a `.ts` source, and the build must not depend on a compile it may be
 * about to produce. The mirror cannot drift silently:
 * `tests/dashboard-08-ui-assets.test.ts` checks the emitted set against
 * `UI_ASSET_MANIFEST` in BOTH directions, and recomputes this digest from
 * `SHELL_ROUTES` — so a changed set, a changed order or a changed route all
 * break a named assertion rather than shipping.
 */
const ASSETS = [
  { file: 'index.html', route: '/' },
  { file: 'app.css', route: '/app.css' },
  { file: 'app.js', route: '/app.js' },
  { file: WORKER, route: '/sw.js' },
  { file: 'manifest.webmanifest', route: '/manifest.webmanifest' },
  { file: 'icon-192.png', route: '/icon-192.png' },
  { file: 'icon-512.png', route: '/icon-512.png' },
];

/**
 * The shell: what the worker caches, and what the digest is taken over.
 *
 * `sw.js` is excluded, and the exclusion is load-bearing rather than tidy: the
 * worker's own bytes carry this digest, so including it would define the
 * digest in terms of itself.
 */
const SHELL = ASSETS.filter((asset) => asset.file !== WORKER);

export class UiAssetBuildError extends Error {}

/**
 * Emits the seven assets into `outDir` and returns the shell digest.
 *
 * @param {{ outDir: string }} options
 * @returns {{ digest: string, files: string[] }}
 */
export function emitUiAssets({ outDir }) {
  if (typeof outDir !== 'string' || outDir.length === 0) {
    throw new UiAssetBuildError('emitUiAssets needs an outDir; there is deliberately no default.');
  }
  mkdirSync(outDir, { recursive: true });

  // Name and bytes for each shell asset, in manifest order. The name is part
  // of the input so that swapping two files' contents is a different shell.
  const hash = createHash('sha256');
  for (const asset of SHELL) {
    hash.update(asset.file, 'utf8');
    hash.update(readFileSync(join(UI_SOURCE_DIR, asset.file)));
  }
  const digest = hash.digest('hex');

  // Substituted BEFORE anything is written, and deliberately not inside the
  // loop. Every way this emit can refuse now happens before the first byte
  // lands, so `UiAssetBuildError` means an untouched destination rather than a
  // partial one — `sw.js` is fourth in manifest order, so a refusal from inside
  // the loop left three copied files behind, which is a thing this file's own
  // declaration claimed could not happen.
  const workerBytes = substituteWorker(digest);

  /** @type {string[]} */
  const written = [];
  for (const asset of ASSETS) {
    const target = join(outDir, asset.file);
    if (asset.file === WORKER) writeFileSync(target, workerBytes, 'utf8');
    else copyFileSync(join(UI_SOURCE_DIR, asset.file), target);
    written.push(asset.file);
  }
  return { digest, files: written };
}

/**
 * The worker's source with both constants filled in.
 *
 * Checked at both ends. "No placeholder survives" alone would pass vacuously
 * if someone renamed a token in `sw.js` — the emitted worker would then carry
 * no digest at all, which is the failure this whole script exists to prevent,
 * wearing the face of a clean build.
 *
 * @param {string} digest
 * @returns {string}
 */
function substituteWorker(digest) {
  const source = readFileSync(join(UI_SOURCE_DIR, WORKER), 'utf8');
  for (const token of [DIGEST_TOKEN, ROUTES_TOKEN]) {
    if (!source.includes(token)) {
      throw new UiAssetBuildError(
        `${join(UI_SOURCE_DIR, WORKER)} does not contain ${token}. The worker would ship ` +
          'without a build digest, and no browser would ever see an update again.',
      );
    }
  }

  const routes = JSON.stringify(SHELL.map((asset) => asset.route));
  const substituted = source.split(ROUTES_TOKEN).join(routes).split(DIGEST_TOKEN).join(digest);

  if (substituted.includes(DIGEST_TOKEN) || substituted.includes('__AO_SHELL_ROUTES__')) {
    throw new UiAssetBuildError('A placeholder survived substitution in the service worker.');
  }
  if (!substituted.includes(`ao-shell-${digest}`)) {
    throw new UiAssetBuildError(
      `The emitted service worker does not name the cache ao-shell-${digest}.`,
    );
  }
  return substituted;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const { digest, files } = emitUiAssets({ outDir: UI_BUILD_DIR });
    console.log(`dashboard ui assets: ${String(files.length)} files -> ${UI_BUILD_DIR}`);
    console.log(`  shell cache : ao-shell-${digest}`);
  } catch (error) {
    console.error(error instanceof UiAssetBuildError ? error.message : error);
    process.exit(1);
  }
}
