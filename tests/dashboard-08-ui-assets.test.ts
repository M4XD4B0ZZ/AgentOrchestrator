import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  UI_ASSET_MANIFEST,
  SHELL_ROUTES,
  loadUiAssets,
} from '../src/dashboard/ui-assets.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* a leftover scratch directory is not worth failing a suite over */
    }
  }
});

/** A directory holding every manifest file, minus the ones named. */
function assetDir(omit: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'ao-ui-assets-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const entry of UI_ASSET_MANIFEST) {
    if (omit.includes(entry.file)) continue;
    writeFileSync(join(root, entry.file), `bytes-of-${entry.file}`, 'utf8');
  }
  return root;
}

describe('the manifest is a closed list with one authority', () => {
  it('maps every route exactly once, and every file exactly once', () => {
    const routes = UI_ASSET_MANIFEST.map((e) => e.route);
    const files = UI_ASSET_MANIFEST.map((e) => e.file);
    expect(new Set(routes).size).toBe(routes.length);
    expect(new Set(files).size).toBe(files.length);
  });

  it('names the seven assets the design fixes, and no others', () => {
    expect(UI_ASSET_MANIFEST.map((e) => e.route).sort()).toEqual([
      '/',
      '/app.css',
      '/app.js',
      '/icon-192.png',
      '/icon-512.png',
      '/manifest.webmanifest',
      '/sw.js',
    ]);
  });

  it('derives the shell routes from the manifest, excluding the worker itself', () => {
    // The worker cannot be an element of the set it caches: its own bytes carry
    // the digest of that set.
    expect([...SHELL_ROUTES].sort()).toEqual([
      '/',
      '/app.css',
      '/app.js',
      '/icon-192.png',
      '/icon-512.png',
      '/manifest.webmanifest',
    ]);
    expect(SHELL_ROUTES).not.toContain('/sw.js');
  });

  it('gives every asset a content type, and no asset a charset it should not have', () => {
    const byRoute = new Map(UI_ASSET_MANIFEST.map((e) => [e.route, e.contentType]));
    expect(byRoute.get('/')).toBe('text/html; charset=utf-8');
    expect(byRoute.get('/app.css')).toBe('text/css; charset=utf-8');
    expect(byRoute.get('/app.js')).toBe('text/javascript; charset=utf-8');
    expect(byRoute.get('/sw.js')).toBe('text/javascript; charset=utf-8');
    expect(byRoute.get('/manifest.webmanifest')).toBe('application/manifest+json');
    expect(byRoute.get('/icon-192.png')).toBe('image/png');
    expect(byRoute.get('/icon-512.png')).toBe('image/png');
  });
});

describe('loading is all or nothing', () => {
  it('loads every asset as bytes, keyed by route', () => {
    const loaded = loadUiAssets(assetDir());
    expect(loaded.outcome).toBe('LOADED');
    if (loaded.outcome !== 'LOADED') return;
    expect(loaded.assets.size).toBe(UI_ASSET_MANIFEST.length);
    const html = loaded.assets.get('/');
    expect(html).toBeDefined();
    expect(Buffer.from(html!.bytes).toString('utf8')).toBe('bytes-of-index.html');
    expect(html!.contentType).toBe('text/html; charset=utf-8');
  });

  it('refuses the whole set when one asset is missing, and names the ROUTE', () => {
    // The route, never the filesystem path: a refusal reaches an operator and
    // must not carry where this machine keeps its files.
    const missing = loadUiAssets(assetDir(['icon-512.png']));
    expect(missing.outcome).toBe('MISSING');
    if (missing.outcome !== 'MISSING') return;
    expect(missing.route).toBe('/icon-512.png');
    expect(JSON.stringify(missing)).not.toContain(tmpdir());
  });

  it('refuses a directory that does not exist at all', () => {
    const absent = loadUiAssets(join(tmpdir(), 'ao-ui-assets-definitely-absent'));
    expect(absent.outcome).toBe('MISSING');
  });
});
