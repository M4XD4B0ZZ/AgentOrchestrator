import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  UI_ASSET_MANIFEST,
  SHELL_ROUTES,
  loadUiAssets,
  type DashboardAssetMap,
} from '../src/dashboard/ui-assets.js';
import {
  DASHBOARD_BIND_HOST,
  allowedHostsFor,
  respondToDashboardRequest,
  type DashboardRequestFacts,
} from '../src/dashboard/http-contract.js';
import { startDashboardServer } from '../src/dashboard/http-server.js';
import type { PublicSnapshot } from '../src/dashboard/public-view.js';

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

const ALLOWED = ['127.0.0.1:47113'];

function fakeAssets(): DashboardAssetMap {
  return new Map(
    UI_ASSET_MANIFEST.map((e) => [
      e.route,
      { bytes: Uint8Array.from([0x00, 0xff, 0x41]), contentType: e.contentType },
    ]),
  );
}

function snapshotStub(): PublicSnapshot {
  return {
    observedAt: '2026-09-16T00:00:00.000Z',
    revision: 'abc123',
    registry: { reading: 'UNUSABLE', code: 'X' },
    repositories: [],
    needsOperator: [],
    notes: [],
  } as unknown as PublicSnapshot;
}

function ask(overrides: Partial<DashboardRequestFacts> = {}) {
  return respondToDashboardRequest(
    {
      method: 'GET',
      target: '/',
      hostHeaders: ['127.0.0.1:47113'],
      ifNoneMatch: null,
      ...overrides,
    },
    ALLOWED,
    snapshotStub,
    fakeAssets(),
  );
}

const header = (r: { headers: Readonly<Record<string, string>> }, name: string): string | undefined =>
  Object.entries(r.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('the asset routes answer, and only the ones in the manifest', () => {
  it('serves every manifest route with its own content type and byte length', () => {
    for (const entry of UI_ASSET_MANIFEST) {
      const answer = ask({ target: entry.route });
      expect(answer.status, entry.route).toBe(200);
      expect(header(answer, 'Content-Type'), entry.route).toBe(entry.contentType);
      expect(header(answer, 'Content-Length'), entry.route).toBe('3');
      expect(answer.body, entry.route).toBeInstanceOf(Uint8Array);
    }
  });

  it('answers the API route before the asset map is consulted', () => {
    const answer = ask({ target: '/api/snapshot' });
    expect(answer.status).toBe(200);
    expect(header(answer, 'Content-Type')).toBe('application/json; charset=utf-8');
    // The API keeps the slice-3 policy. It is not a document and grants nothing.
    expect(header(answer, 'Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it('gives a successful asset the UI policy, with no unsafe-inline anywhere', () => {
    const policy = header(ask({ target: '/app.js' }), 'Content-Security-Policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("img-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('keeps no-store and nosniff on an asset, which is where they matter most', () => {
    const answer = ask({ target: '/icon-192.png' });
    expect(header(answer, 'Cache-Control')).toBe('no-store');
    expect(header(answer, 'X-Content-Type-Options')).toBe('nosniff');
    expect(header(answer, 'Access-Control-Allow-Origin')).toBeUndefined();
  });

  it('gives every REFUSAL the slice-3 policy, whatever path it was asked for', () => {
    // The UI policy attaches to a served asset, never to a refusal. This is the
    // observable half of "the API contract did not move".
    for (const target of ['/nope', '/app.css/', '/API/SNAPSHOT']) {
      const answer = ask({ target });
      expect(answer.status, target).toBe(404);
      expect(header(answer, 'Content-Security-Policy'), target).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(answer.body, target).toContain('NOT_FOUND');
    }
  });

  it('offers assets by GET only, and says so', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const answer = ask({ target: '/app.css', method });
      expect(answer.status, method).toBe(405);
      expect(header(answer, 'Allow'), method).toBe('GET');
    }
  });
});

describe('traversal has nowhere to go, and the refusal says which kind', () => {
  it('refuses a well-formed path that is not a key with 404', () => {
    for (const target of ['/api/../app.js', '//app.css', '/%2e%2e/app.css', '/ui/app.css']) {
      expect(ask({ target }).status, target).toBe(404);
    }
  });

  it('refuses anything that is not origin-form with 400, before routing', () => {
    for (const target of ['../app.css', '..%5capp.css', 'http://elsewhere/app.css', '*']) {
      expect(ask({ target }).status, target).toBe(400);
    }
  });

  it('refuses an unlisted Host before it reveals that any asset exists', () => {
    const answer = ask({ target: '/app.css', hostHeaders: ['evil.example'] });
    expect(answer.status).toBe(421);
  });
});

/** A port nothing is using right now. Bound explicitly, never by omission. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('a server carries its assets, and a missing one opens no socket', () => {
  it('serves an asset over a real socket with the right bytes', async () => {
    // The port is known BEFORE the config is built, so `allowedHosts` can be
    // the real computed set rather than the empty one a Host header could
    // never match — without it every request below would be a 421 and this
    // test would prove nothing about `config.assets`.
    const port = await freePort();
    const outcome = await startDashboardServer(
      {
        bindHost: DASHBOARD_BIND_HOST,
        port,
        allowedHosts: allowedHostsFor(DASHBOARD_BIND_HOST, port, []),
        assets: fakeAssets(),
      },
      { snapshot: snapshotStub },
    );
    expect(outcome.outcome).toBe('LISTENING');
    if (outcome.outcome !== 'LISTENING') return;
    try {
      expect(outcome.boundPort).toBe(port);

      // The wiring this test exists to prove: `config.assets` reaches a real
      // socket, not only the pure contract function `respondToDashboardRequest`
      // is already pinned against. This would fail with `config.assets` left
      // unwired — the route would 404 against the default empty map instead.
      const response = await fetch(`http://127.0.0.1:${String(port)}/app.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes]).toEqual([0x00, 0xff, 0x41]);
    } finally {
      await outcome.stop();
    }
  });
});
