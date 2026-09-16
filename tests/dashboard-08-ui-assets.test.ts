import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  UI_ASSET_MANIFEST,
  SHELL_ROUTES,
  defaultUiAssetRoot,
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

describe('the default root is anchored to the module that owns the assets', () => {
  it('ends with dashboard/ui, never a caller\'s own directory', () => {
    // Separator-agnostic: this repository is Windows-first, but the property
    // holds on either separator, and pinning one would make the test a
    // statement about this machine rather than about the function.
    const segments = defaultUiAssetRoot().split(/[/\\]/).filter((part) => part.length > 0);
    expect(segments.slice(-2)).toEqual(['dashboard', 'ui']);
    // The regression this exists to catch: a caller supplying ITS OWN
    // `import.meta.url` resolves beside itself instead of beside the assets —
    // `cli/dashboard-command.ts` once did exactly this and asked for
    // `cli/ui`, which the build never writes.
    expect(segments).not.toContain('cli');
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
    // `fakeAssets()` alone cannot build this case: it is keyed from
    // `UI_ASSET_MANIFEST`, which never contains `/api/snapshot`, so a naive
    // assets-first implementation would find nothing there either and this
    // test would pass without ever exercising the ordering it names. The map
    // here deliberately ALSO carries `/api/snapshot`, poisoned — wrong bytes,
    // wrong content type — so this test FAILS under an assets-first
    // implementation: it would see the poison instead of the real snapshot.
    const poison = Uint8Array.from(Buffer.from('POISON', 'utf8'));
    const poisoned: DashboardAssetMap = new Map([
      ...fakeAssets(),
      ['/api/snapshot', { bytes: poison, contentType: 'text/plain' }],
    ]);
    const answer = respondToDashboardRequest(
      {
        method: 'GET',
        target: '/api/snapshot',
        hostHeaders: ['127.0.0.1:47113'],
        ifNoneMatch: null,
      },
      ALLOWED,
      snapshotStub,
      poisoned,
    );
    expect(answer.status).toBe(200);
    expect(header(answer, 'Content-Type')).toBe('application/json; charset=utf-8');
    // The API keeps the slice-3 policy. It is not a document and grants nothing.
    expect(header(answer, 'Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    // The real snapshot answer is a JSON STRING; the poisoned asset entry
    // would have answered with its Uint8Array bytes instead.
    expect(typeof answer.body).toBe('string');
    expect(answer.body).not.toContain('POISON');
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

import { readFileSync as readSource } from 'node:fs';
import { join as joinPath } from 'node:path';

const UI_DIR = joinPath(process.cwd(), 'src', 'dashboard', 'ui');
const read = (name: string): string => readSource(joinPath(UI_DIR, name), 'utf8');

describe('the authored shell obeys the policy that serves it', () => {
  it('has no inline script, no style element and no style attribute', () => {
    // Not a nicety. The served policy carries no 'unsafe-inline', so any of
    // these would be silently dropped by the browser and the page would be
    // broken in a way no server-side test can see.
    const html = read('index.html');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('references everything root-relative, and nothing off this origin', () => {
    const html = read('index.html');
    expect(html).toContain('href="/app.css"');
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).not.toMatch(/https?:\/\//);
    // crossorigin on the manifest link changes credential behaviour for no
    // reason here, and is a common copy-paste that breaks installability.
    expect(html).not.toMatch(/rel="manifest"[^>]*crossorigin/i);
  });

  it('declares a manifest that can actually install', () => {
    const manifest = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
    expect(manifest['name']).toBe('AO Manager');
    expect(manifest['short_name']).toBe('AO');
    expect(manifest['start_url']).toBe('/');
    expect(manifest['scope']).toBe('/');
    expect(manifest['display']).toBe('standalone');
    const icons = manifest['icons'] as { src: string; sizes: string; type: string }[];
    expect(icons.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.src.startsWith('/')).toBe(true);
    }
  });

  it('ships real PNG bytes, not a placeholder', () => {
    for (const name of ['icon-192.png', 'icon-512.png']) {
      const bytes = readSource(joinPath(UI_DIR, name));
      expect(Buffer.compare(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), name).toBe(0);
      expect(bytes.byteLength, name).toBeGreaterThan(100);
    }
  });

  it('names no vendor and no hostname this build cannot know', () => {
    // Every authored text asset, including the two scripts. `app.js` is the
    // largest file in the UI and the only one that names a URL at all, so it is
    // exactly where a hostname gets hard-coded while someone is debugging
    // against a machine of their own; leaving it out of this sweep put the
    // guard everywhere except the place that needed it.
    for (const name of ['index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'sw.js']) {
      const text = read(name).toLowerCase();
      for (const forbidden of ['tailscale', 'ts.net', 'localhost', '0.0.0.0', '100.']) {
        expect(text, `${name} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('the default asset root resolves for real, against the source tree', () => {
  it('loads every manifest route from defaultUiAssetRoot() with no argument substitution', () => {
    // The production default path, exercised for real: no temp directory, no
    // stand-in root — the same call `dashboard serve` makes. This fails today
    // because src/dashboard/ui/ does not exist; it is the first time in this
    // slice that call can succeed against the source tree.
    const loaded = loadUiAssets(defaultUiAssetRoot());
    expect(loaded.outcome).toBe('LOADED');
    if (loaded.outcome !== 'LOADED') return;
    expect(loaded.assets.size).toBe(UI_ASSET_MANIFEST.length);
    for (const entry of UI_ASSET_MANIFEST) {
      expect(loaded.assets.has(entry.route), entry.route).toBe(true);
    }
  });
});

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';

import { emitUiAssets } from '../scripts/build-ui-assets.mjs';

/** A scratch destination that the suite's `afterAll` will sweep up. */
function emitInto(): string {
  const out = mkdtempSync(join(tmpdir(), 'ao-ui-emit-'));
  roots.push(out);
  return out;
}

/**
 * The digest, recomputed from the TypeScript manifest.
 *
 * Deliberately an INDEPENDENT derivation: `scripts/build-ui-assets.mjs` is a
 * `.mjs` build script and carries its own mirrored list, so a digest computed
 * from that mirror is compared here against one computed from `ui-assets.ts`,
 * which is the authority. A drifted mirror, a changed order, or a changed set
 * all break the equality.
 */
function digestOver(files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file, 'utf8');
    hash.update(readSource(joinPath(UI_DIR, file)));
  }
  return hash.digest('hex');
}

describe('the emit step produces a complete, substituted artefact', () => {
  it('emits exactly the manifest — every file, and no file it does not name', () => {
    // Bidirectional, and both directions name the offending file. A one-way
    // check would stay green while the emit quietly dropped an asset the
    // loader needs, or shipped one nothing serves.
    const out = emitInto();
    const result = emitUiAssets({ outDir: out });
    const manifestFiles = UI_ASSET_MANIFEST.map((e) => e.file).sort();

    for (const entry of UI_ASSET_MANIFEST) {
      expect(existsSync(joinPath(out, entry.file)), `the emit wrote no ${entry.file}`).toBe(true);
    }
    for (const name of readdirSync(out)) {
      expect(manifestFiles, `the emit wrote ${name}, which the manifest does not name`).toContain(
        name,
      );
    }
    expect([...result.files].sort(), 'the reported file set').toEqual(manifestFiles);
  });

  it('writes an artefact the shipped loader accepts, all-or-nothing', () => {
    const out = emitInto();
    emitUiAssets({ outDir: out });
    const loaded = loadUiAssets(out);
    expect(loaded.outcome).toBe('LOADED');
  });

  it('substitutes both tokens, leaving none behind', () => {
    const out = emitInto();
    const { digest } = emitUiAssets({ outDir: out });
    const sw = readSource(joinPath(out, 'sw.js'), 'utf8');
    // A silent substitution failure is invisible and catastrophic: it ships a
    // worker whose bytes never change, so no update ever runs, forever.
    expect(sw, 'the digest placeholder survived').not.toContain('__AO_SHELL_DIGEST__');
    expect(sw, 'the routes placeholder survived').not.toContain('__AO_SHELL_ROUTES__');
    expect(sw).toContain(`ao-shell-${digest}`);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    for (const route of SHELL_ROUTES) expect(sw, route).toContain(JSON.stringify(route));
    // The worker's allow-list is the shell, exactly — order included, because
    // the substituted value is one JSON array literal and not a set.
    expect(sw).toContain(`var SHELL_ROUTES = ${JSON.stringify([...SHELL_ROUTES])};`);
  });

  it('takes the digest over the shell only, so the worker cannot define itself', () => {
    const out = emitInto();
    const { digest } = emitUiAssets({ outDir: out });
    const shellFiles = UI_ASSET_MANIFEST.filter((e) => SHELL_ROUTES.includes(e.route)).map(
      (e) => e.file,
    );
    expect(shellFiles).not.toContain('sw.js');
    // The pin: the emitted digest IS the digest of the shell, recomputed from
    // the manifest. Comparing two emits of the same source tree to each other
    // would be vacuous — both would agree whatever set they hashed.
    //
    // This is also where "changing any shell asset changes the worker's bytes,
    // which is what makes a browser notice an update" is pinned, and it is
    // pinned by a chain rather than by a test that varies a byte: the digest is
    // the digest OF THE SHELL'S ACTUAL BYTES (here), and the worker's text
    // carries `ao-shell-<that digest>` (the test above). A different shell is
    // therefore a different worker — with no step in between that a test could
    // demonstrate without re-emitting from a scratch source tree, which
    // `emitUiAssets` deliberately cannot be pointed at.
    expect(digest, 'the digest is not the digest of the shell').toBe(digestOver(shellFiles));
    // And the set including the worker is demonstrably a different value, so
    // the exclusion is measured rather than merely stated.
    const withWorker = UI_ASSET_MANIFEST.map((e) => e.file);
    expect(digestOver(withWorker), 'hashing sw.js too would be indistinguishable').not.toBe(digest);
  });

  it('copies the shell verbatim — only sw.js differs from its source', () => {
    const out = emitInto();
    emitUiAssets({ outDir: out });
    for (const entry of UI_ASSET_MANIFEST) {
      if (entry.file === 'sw.js') continue;
      const emitted = readSource(joinPath(out, entry.file));
      const authored = readSource(joinPath(UI_DIR, entry.file));
      expect(Buffer.compare(emitted, authored), entry.file).toBe(0);
    }
    const emittedWorker = readSource(joinPath(out, 'sw.js'));
    const authoredWorker = readSource(joinPath(UI_DIR, 'sw.js'));
    expect(Buffer.compare(emittedWorker, authoredWorker), 'sw.js must NOT be verbatim').not.toBe(0);
  });
});
