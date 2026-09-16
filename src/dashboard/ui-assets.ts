/**
 * DASHBOARD-001 slice 4 — the closed asset manifest, and the only reader of it.
 *
 * This module is the single authority for what the UI consists of. Two other
 * lists are derived from it by `scripts/build-ui-assets.mjs`: the digest input
 * and the service worker's fetch allow-list, both substituted into `sw.js`.
 * A two-way gate keeps the mirror honest — every manifest route must be present
 * in the artefact, and every file in the artefact must be named by the manifest
 * — so a drifted mirror cannot ship.
 *
 * ── Why a list and not a directory ─────────────────────────────────────────
 *
 * The alternative is a static-file server: take the request target, decode it,
 * normalise it, join it onto a root and open whatever comes out. Every path
 * traversal defect in the history of the web lives in that sentence. Here a
 * request is a lookup in a frozen `Map` keyed by the path exactly as it
 * arrived, so `..`, `%2e%2e` and a backslash are strings that are not keys.
 * Traversal is not mitigated; it has nowhere to go.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One shipped asset: the route it answers, its file, and how to label it. */
export interface UiAssetEntry {
  readonly route: string;
  readonly file: string;
  readonly contentType: string;
}

/**
 * Every asset this build serves. Closed, literal, and ordered for reading.
 *
 * `/manifest.webmanifest` carries `application/manifest+json` rather than
 * `application/json`: a browser will parse either, but the specific type is the
 * one that says what the bytes are for.
 */
export const UI_ASSET_MANIFEST: readonly UiAssetEntry[] = Object.freeze([
  Object.freeze({ route: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' }),
  Object.freeze({ route: '/app.css', file: 'app.css', contentType: 'text/css; charset=utf-8' }),
  Object.freeze({ route: '/app.js', file: 'app.js', contentType: 'text/javascript; charset=utf-8' }),
  Object.freeze({ route: '/sw.js', file: 'sw.js', contentType: 'text/javascript; charset=utf-8' }),
  Object.freeze({
    route: '/manifest.webmanifest',
    file: 'manifest.webmanifest',
    contentType: 'application/manifest+json',
  }),
  Object.freeze({ route: '/icon-192.png', file: 'icon-192.png', contentType: 'image/png' }),
  Object.freeze({ route: '/icon-512.png', file: 'icon-512.png', contentType: 'image/png' }),
]);

/**
 * The shell: what the service worker caches, and what the digest is taken over.
 *
 * `/sw.js` is excluded, and the exclusion is load-bearing rather than tidy. The
 * worker's own bytes carry the digest of this set, so including it would define
 * the digest in terms of itself.
 */
export const SHELL_ROUTES: readonly string[] = Object.freeze(
  UI_ASSET_MANIFEST.filter((entry) => entry.route !== '/sw.js').map((entry) => entry.route),
);

/** One asset in memory. Bytes, because two of the seven are not text. */
export interface LoadedUiAsset {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * The route→asset map a running server answers from.
 *
 * Protection is type-level and conventional: the map is built once by this
 * loader and nothing in this build writes to it afterwards. There is
 * deliberately no runtime `Object.freeze` — the two ways to get one are worse:
 * a defensive copy per access would copy the whole UI on every request for a
 * property no caller needs, and a frozen null-prototype object keyed by the
 * request path itself would trade runtime immutability for the exact
 * prototype-key lookup hazard the literal-map lookup exists to avoid.
 */
export type DashboardAssetMap = ReadonlyMap<string, LoadedUiAsset>;

/** What a load attempt did. Total: every path returns one of these. */
export type UiAssetLoad =
  | { readonly outcome: 'LOADED'; readonly assets: DashboardAssetMap }
  | { readonly outcome: 'MISSING'; readonly route: string };

/**
 * Where the assets sit beside the compiled module.
 *
 * Resolved from the module's own location rather than from `process.cwd()` or
 * from the repository root, so the same code finds them under `build/` and
 * under a deployed `dist/` without being told which it is running from.
 */
export function uiAssetRoot(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), 'ui');
}

/**
 * Reads every manifest asset, or none of them.
 *
 * All-or-nothing on purpose. A build that shipped six of seven assets would
 * otherwise serve a UI missing its stylesheet — a half-broken page an operator
 * has to diagnose, in place of a refusal at startup that names the defect. The
 * failure carries the ROUTE and never a filesystem path: it reaches an operator,
 * and a path names this machine.
 */
export function loadUiAssets(rootDir: string): UiAssetLoad {
  const assets = new Map<string, LoadedUiAsset>();
  for (const entry of UI_ASSET_MANIFEST) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(rootDir, entry.file));
    } catch {
      return Object.freeze({ outcome: 'MISSING' as const, route: entry.route });
    }
    assets.set(entry.route, Object.freeze({ bytes, contentType: entry.contentType }));
  }
  return Object.freeze({ outcome: 'LOADED' as const, assets: assets as DashboardAssetMap });
}
